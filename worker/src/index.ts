/**
 * Shade Pull Plan Tracker — Cloudflare Worker API
 *
 *  - D1 holds the plan, the four stock reports, TRR, dashboard edits, users and activity.
 *  - The pull plan calculation (the Excel SUMIF/VLOOKUP logic) runs as one SQL query.
 *  - A Durable Object (LiveHub) keeps WebSocket connections and pushes a message to every
 *    open dashboard whenever data changes, so all screens update in real time.
 */

export interface Env {
  DB: D1Database;
  HUB: DurableObjectNamespace;
  JWT_SECRET: string;
  ADMIN_USER?: string;
  ADMIN_PASSWORD?: string;
  ALLOWED_ORIGINS?: string; // comma separated, e.g. "https://shade.vercel.app,http://localhost:3000"
}

type Role = 'admin' | 'editor' | 'viewer';
interface Session { u: string; role: Role; exp: number }

const STOCK_SRCS = ['zmmbe', 'kfc', 'pfc', 'plant'] as const;
const ALL_SRCS = ['plan', ...STOCK_SRCS, 'trr'] as const;
type Src = (typeof ALL_SRCS)[number];

const SRC_LABEL: Record<Src, string> = {
  plan: 'Pull plan', zmmbe: 'ZMMBE', kfc: 'ZMMBE KFC', pfc: 'ZMMBE PFC', plant: 'PLANT report', trr: 'TRR',
};

// ---------------------------------------------------------------- helpers

const enc = new TextEncoder();
const now = () => new Date().toISOString();

function b64url(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64url(s: string): Uint8Array {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function hmacKey(secret: string) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
async function signToken(env: Env, s: Session): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify(s)));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(env.JWT_SECRET), enc.encode(body));
  return body + '.' + b64url(sig);
}
async function verifyToken(env: Env, token: string | null): Promise<Session | null> {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const ok = await crypto.subtle.verify('HMAC', await hmacKey(env.JWT_SECRET), fromB64url(sig), enc.encode(body));
  if (!ok) return null;
  try {
    const s = JSON.parse(new TextDecoder().decode(fromB64url(body))) as Session;
    return s.exp > Date.now() ? s : null;
  } catch { return null; }
}

async function hashPassword(password: string, saltB64?: string) {
  const salt = saltB64 ? fromB64url(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, key, 256);
  return { hash: b64url(bits), salt: b64url(salt) };
}
function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/** SAP numbers come as 1001724370, "1001724370", "0001001724370" or 10.0 — make them one form. */
export function normId(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s = String(v).trim();
  if (/^\d+\.0+$/.test(s)) s = s.replace(/\.0+$/, '');
  if (/^\d+$/.test(s)) s = s.replace(/^0+(?=\d)/, '');
  return s;
}
export function lineKey(so: unknown, li: unknown, item: unknown) {
  return `${normId(so)}|${normId(li)}|${normId(item)}`;
}
function num(v: unknown): number {
  if (typeof v === 'number') return isFinite(v) ? v : 0;
  if (v === null || v === undefined || v === '') return 0;
  const n = Number(String(v).replace(/,/g, '').trim());
  return isFinite(n) ? n : 0;
}
function txt(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}
/** Accepts ISO dates, Excel serial numbers and dd.mm.yyyy. Returns yyyy-mm-dd or the text as given. */
function normDate(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number' && v > 20000 && v < 80000) {
    const d = new Date(Math.round((v - 25569) * 86400000));
    return d.toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return s;
}

function corsHeaders(env: Env, req: Request): Record<string, string> {
  const origin = req.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim()).filter(Boolean);
  const allow = allowed.includes('*') ? '*' : allowed.includes(origin) ? origin : allowed[0] || '';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}
class HttpError extends Error { constructor(public status: number, msg: string) { super(msg); } }
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

async function requireUser(env: Env, req: Request, min: Role = 'viewer'): Promise<Session> {
  const h = req.headers.get('Authorization') || '';
  const s = await verifyToken(env, h.startsWith('Bearer ') ? h.slice(7) : null);
  if (!s) throw new HttpError(401, 'Please sign in again.');
  const rank: Record<Role, number> = { viewer: 0, editor: 1, admin: 2 };
  if (rank[s.role] < rank[min]) throw new HttpError(403, `This needs ${min} access.`);
  return s;
}

async function broadcast(env: Env, msg: Record<string, unknown>) {
  const stub = env.HUB.get(env.HUB.idFromName('main'));
  await stub.fetch('https://hub/broadcast', { method: 'POST', body: JSON.stringify({ ...msg, at: now() }) });
}
async function logActivity(env: Env, user: string, action: string, detail: string) {
  await env.DB.prepare('INSERT INTO activity (at, username, action, detail) VALUES (?,?,?,?)').bind(now(), user, action, detail).run();
}

// ---------------------------------------------------------------- row mapping (uploads)

type Row = Record<string, unknown>;

function mapPlan(rows: Row[]) {
  const out: Row[] = [];
  rows.forEach((r, i) => {
    const so = normId(r.so), li = normId(r.li), item = normId(r.item);
    if (!so || !li || !item || !/^\d/.test(so)) return;
    out.push({
      key: lineKey(so, li, item), so, li, item, date: normDate(r.date), qty: num(r.qty),
      plant: txt(r.plant), remarks: txt(r.remarks), row_no: i + 1,
      // optional columns carried from an existing pull plan sheet
      _status: txt(r.status), _comment: txt(r.comment), _qi_note: txt(r.qi_note), _vehicle: txt(r.vehicle),
    });
  });
  return out;
}
function mapStock(src: string, rows: Row[]) {
  const out: Row[] = [];
  for (const r of rows) {
    const so = normId(r.so), li = normId(r.li), mat = normId(r.material);
    if (!so || !li || !mat) continue; // SAP subtotal lines have no SO
    const ur = num(r.ur), qi = num(r.qi), block = num(r.block);
    out.push({
      src, key: lineKey(so, li, mat), plant: txt(r.plant), sloc: txt(normId(r.sloc)), so_plant: txt(r.so_plant), so, li,
      material: mat, batch: txt(normId(r.batch)), style: txt(r.style), ur, qi, block, assigned: num(r.assigned),
      total: r.total === undefined || r.total === null || r.total === '' ? ur + qi + block : num(r.total),
    });
  }
  return out;
}
function mapTrr(rows: Row[]) {
  const out: Row[] = [];
  for (const r of rows) {
    const so = normId(r.so), li = normId(r.li), mat = normId(r.material);
    if (!so || !li || !mat) continue;
    out.push({
      key: lineKey(so, li, mat), tn: txt(normId(r.tn)), tn_date: normDate(r.tn_date), created_by: txt(r.created_by), so, li, material: mat,
      from_plant: txt(r.from_plant), from_sloc: txt(normId(r.from_sloc)), to_plant: txt(r.to_plant), to_sloc: txt(normId(r.to_sloc)),
      qty: num(r.qty), reason: txt(r.reason),
    });
  }
  return out;
}

/** Insert rows with one bound JSON parameter per chunk (D1 allows only 100 bound values per statement). */
function jsonInsert(env: Env, table: string, cols: string[], rows: Row[], chunk = 400): D1PreparedStatement[] {
  const stmts: D1PreparedStatement[] = [];
  const select = cols.map((c) => `json_extract(value, '$.${c}')`).join(', ');
  for (let i = 0; i < rows.length; i += chunk) {
    const part = rows.slice(i, i + chunk).map((r) => Object.fromEntries(cols.map((c) => [c, r[c] ?? null])));
    stmts.push(env.DB.prepare(`INSERT INTO ${table} (${cols.join(', ')}) SELECT ${select} FROM json_each(?)`).bind(JSON.stringify(part)));
  }
  return stmts;
}

async function handleUpload(env: Env, req: Request) {
  const s = await requireUser(env, req, 'editor');
  const body = (await req.json()) as { src: Src; fileName?: string; sheetName?: string; rows: Row[] };
  if (!ALL_SRCS.includes(body.src)) throw new HttpError(400, 'Unknown report type.');
  if (!Array.isArray(body.rows)) throw new HttpError(400, 'No rows in the upload.');

  const stmts: D1PreparedStatement[] = [];
  let mapped: Row[];
  if (body.src === 'plan') {
    mapped = mapPlan(body.rows);
    stmts.push(env.DB.prepare('DELETE FROM plan'));
    stmts.push(...jsonInsert(env, 'plan', ['key', 'so', 'li', 'item', 'date', 'qty', 'plant', 'remarks', 'row_no'], mapped));
    // Status/comment columns that came with the file seed the dashboard, without overwriting edits made on it.
    const seed = mapped.filter((r) => r._status || r._comment || r._qi_note || r._vehicle)
      .map((r) => ({ key: r.key, status: r._status, comment: r._comment, vehicle: r._vehicle, qi_note: r._qi_note, updated_by: s.u, updated_at: now() }));
    for (let i = 0; i < seed.length; i += 400) {
      stmts.push(env.DB.prepare(
        `INSERT OR IGNORE INTO line_status (key, status, comment, vehicle, qi_note, updated_by, updated_at)
         SELECT json_extract(value,'$.key'), json_extract(value,'$.status'), json_extract(value,'$.comment'), json_extract(value,'$.vehicle'),
                json_extract(value,'$.qi_note'), json_extract(value,'$.updated_by'), json_extract(value,'$.updated_at') FROM json_each(?)`,
      ).bind(JSON.stringify(seed.slice(i, i + 400))));
    }
  } else if (body.src === 'trr') {
    mapped = mapTrr(body.rows);
    stmts.push(env.DB.prepare('DELETE FROM trr'));
    stmts.push(...jsonInsert(env, 'trr', ['key', 'tn', 'tn_date', 'created_by', 'so', 'li', 'material', 'from_plant', 'from_sloc', 'to_plant', 'to_sloc', 'qty', 'reason'], mapped));
  } else {
    mapped = mapStock(body.src, body.rows);
    stmts.push(env.DB.prepare('DELETE FROM stock WHERE src = ?').bind(body.src));
    stmts.push(...jsonInsert(env, 'stock', ['src', 'key', 'plant', 'sloc', 'so_plant', 'so', 'li', 'material', 'batch', 'style', 'ur', 'qi', 'block', 'assigned', 'total'], mapped));
  }
  if (mapped.length === 0) throw new HttpError(400, `No usable rows found for ${SRC_LABEL[body.src]}. Check the column mapping (SO, LI and Item/Material are required).`);

  stmts.push(env.DB.prepare('INSERT INTO uploads (src, file_name, sheet_name, row_count, uploaded_by, uploaded_at) VALUES (?,?,?,?,?,?)')
    .bind(body.src, body.fileName || null, body.sheetName || null, mapped.length, s.u, now()));
  stmts.push(env.DB.prepare('INSERT INTO activity (at, username, action, detail) VALUES (?,?,?,?)')
    .bind(now(), s.u, 'upload', `${SRC_LABEL[body.src]}: ${mapped.length} rows${body.fileName ? ' from ' + body.fileName : ''}`));
  await env.DB.batch(stmts); // all or nothing

  await broadcast(env, { type: 'data', src: body.src, by: s.u, rows: mapped.length });
  return json({ ok: true, src: body.src, accepted: mapped.length, skipped: body.rows.length - mapped.length });
}

// ---------------------------------------------------------------- the pull plan calculation

/**
 * Mirrors the Excel Pull Plan sheet:
 *   UR/QI/Block/Assigned  = SUMIF(ZMMBE)       Variance = QTY − Assigned
 *   KFC UR/QI/Block       = SUMIF(ZMMBE KFC)   PFC UR/QI/Block = SUMIF(ZMMBE PFC)
 *   Plant                 = SUMIF(PLANT, Total)
 *   Plant / St Location   = from ZMMBE (all distinct values, not only the first)
 *   TN QTY / TN number    = SUMIF / lookup on TRR
 */
const PULL_PLAN_SQL = `
WITH s AS (
  SELECT key,
    SUM(CASE WHEN src='zmmbe' THEN ur END)       AS ur,
    SUM(CASE WHEN src='zmmbe' THEN qi END)       AS qi,
    SUM(CASE WHEN src='zmmbe' THEN block END)    AS block,
    SUM(CASE WHEN src='zmmbe' THEN assigned END) AS assigned,
    SUM(CASE WHEN src='kfc' THEN ur END)    AS kfc_ur,
    SUM(CASE WHEN src='kfc' THEN qi END)    AS kfc_qi,
    SUM(CASE WHEN src='kfc' THEN block END) AS kfc_block,
    SUM(CASE WHEN src='pfc' THEN ur END)    AS pfc_ur,
    SUM(CASE WHEN src='pfc' THEN qi END)    AS pfc_qi,
    SUM(CASE WHEN src='pfc' THEN block END) AS pfc_block,
    SUM(CASE WHEN src='plant' THEN total END) AS plant_qty,
    GROUP_CONCAT(DISTINCT CASE WHEN src='zmmbe' THEN plant END) AS stock_plant,
    GROUP_CONCAT(DISTINCT CASE WHEN src='zmmbe' THEN sloc END)  AS stock_sloc,
    GROUP_CONCAT(DISTINCT CASE WHEN src='plant' THEN plant END) AS at_plant
  FROM stock GROUP BY key
),
t AS (SELECT key, SUM(qty) AS tn_qty, GROUP_CONCAT(DISTINCT tn) AS tn_number FROM trr GROUP BY key),
d AS (SELECT key, COUNT(*) AS dup FROM plan GROUP BY key)
SELECT p.row_no, p.key, p.so, p.li, p.item, p.date, p.qty, p.plant, p.remarks,
  COALESCE(s.ur,0) AS ur, COALESCE(s.qi,0) AS qi, COALESCE(s.block,0) AS block, COALESCE(s.assigned,0) AS assigned,
  p.qty - COALESCE(s.assigned,0) AS variance,
  COALESCE(s.kfc_ur,0) AS kfc_ur, COALESCE(s.kfc_qi,0) AS kfc_qi, COALESCE(s.kfc_block,0) AS kfc_block,
  COALESCE(s.pfc_ur,0) AS pfc_ur, COALESCE(s.pfc_qi,0) AS pfc_qi, COALESCE(s.pfc_block,0) AS pfc_block,
  COALESCE(s.plant_qty,0) AS plant_qty, s.stock_plant, s.stock_sloc, s.at_plant,
  COALESCE(t.tn_qty,0) AS tn_qty, t.tn_number, d.dup,
  ls.status, ls.comment, ls.vehicle, ls.qi_note, ls.updated_by, ls.updated_at
FROM plan p
LEFT JOIN s  ON s.key = p.key
LEFT JOIN t  ON t.key = p.key
LEFT JOIN d  ON d.key = p.key
LEFT JOIN line_status ls ON ls.key = p.key
ORDER BY p.row_no`;

async function handlePullPlan(env: Env, req: Request) {
  await requireUser(env, req);
  const [rows, uploads, counts] = await env.DB.batch([
    env.DB.prepare(PULL_PLAN_SQL),
    env.DB.prepare(`SELECT u.src, u.file_name, u.sheet_name, u.row_count, u.uploaded_by, u.uploaded_at FROM uploads u
                    JOIN (SELECT src, MAX(id) id FROM uploads GROUP BY src) m ON m.id = u.id`),
    env.DB.prepare(`SELECT 'plan' src, COUNT(*) n FROM plan UNION ALL SELECT src, COUNT(*) FROM stock GROUP BY src UNION ALL SELECT 'trr', COUNT(*) FROM trr`),
  ]);
  return json({ rows: rows.results, uploads: uploads.results, counts: counts.results, generatedAt: now() });
}

async function handleStatus(env: Env, req: Request) {
  const s = await requireUser(env, req, 'editor');
  const b = (await req.json()) as { key: string; status?: string | null; comment?: string | null; vehicle?: string | null; qi_note?: string | null };
  if (!b.key) throw new HttpError(400, 'Missing line key.');
  const fields = (['status', 'comment', 'vehicle', 'qi_note'] as const).filter((f) => f in b);
  if (!fields.length) throw new HttpError(400, 'Nothing to change.');
  const cur = await env.DB.prepare('SELECT * FROM line_status WHERE key = ?').bind(b.key).first<Row>();
  const next: Row = { status: null, comment: null, vehicle: null, qi_note: null, ...(cur || {}) };
  for (const f of fields) next[f] = txt(b[f]);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO line_status (key, status, comment, vehicle, qi_note, updated_by, updated_at) VALUES (?,?,?,?,?,?,?)
                    ON CONFLICT(key) DO UPDATE SET status=excluded.status, comment=excluded.comment, vehicle=excluded.vehicle,
                    qi_note=excluded.qi_note, updated_by=excluded.updated_by, updated_at=excluded.updated_at`)
      .bind(b.key, next.status, next.comment, next.vehicle, next.qi_note, s.u, now()),
    env.DB.prepare('INSERT INTO activity (at, username, action, detail) VALUES (?,?,?,?)')
      .bind(now(), s.u, 'edit', `${b.key.replace(/\|/g, ' / ')}: ${fields.map((f) => `${f} → ${next[f] ?? '(blank)'}`).join(', ')}`),
  ]);
  const line = { key: b.key, status: next.status, comment: next.comment, vehicle: next.vehicle, qi_note: next.qi_note, updated_by: s.u, updated_at: now() };
  await broadcast(env, { type: 'status', line, by: s.u });
  return json({ ok: true, line });
}

// ---------------------------------------------------------------- auth & users

async function handleLogin(env: Env, req: Request) {
  const { username, password } = (await req.json()) as { username?: string; password?: string };
  const u = (username || '').trim().toLowerCase();
  if (!u || !password) throw new HttpError(400, 'Enter a username and password.');
  let user = await env.DB.prepare('SELECT * FROM users WHERE username = ?').bind(u).first<{ username: string; pass_hash: string; salt: string; role: Role }>();

  // First run: no users yet → the ADMIN_USER / ADMIN_PASSWORD secrets create the first admin.
  if (!user) {
    const anyUser = await env.DB.prepare('SELECT COUNT(*) n FROM users').first<{ n: number }>();
    if ((anyUser?.n ?? 0) === 0 && env.ADMIN_USER && env.ADMIN_PASSWORD && u === env.ADMIN_USER.toLowerCase() && password === env.ADMIN_PASSWORD) {
      const h = await hashPassword(password);
      await env.DB.prepare('INSERT INTO users (username, pass_hash, salt, role, created_at) VALUES (?,?,?,?,?)').bind(u, h.hash, h.salt, 'admin', now()).run();
      user = { username: u, pass_hash: h.hash, salt: h.salt, role: 'admin' };
    } else throw new HttpError(401, 'Wrong username or password.');
  } else {
    const h = await hashPassword(password, user.salt);
    if (!safeEqual(h.hash, user.pass_hash)) throw new HttpError(401, 'Wrong username or password.');
  }
  const session: Session = { u: user.username, role: user.role, exp: Date.now() + 12 * 3600 * 1000 };
  return json({ token: await signToken(env, session), user: { username: user.username, role: user.role }, expires: session.exp });
}

async function handleUsers(env: Env, req: Request, path: string) {
  const s = await requireUser(env, req, 'admin');
  if (req.method === 'GET') {
    const r = await env.DB.prepare('SELECT username, role, created_at FROM users ORDER BY username').all();
    return json({ users: r.results });
  }
  if (req.method === 'POST') {
    const b = (await req.json()) as { username?: string; password?: string; role?: Role };
    const u = (b.username || '').trim().toLowerCase();
    if (!/^[a-z0-9._-]{2,32}$/.test(u)) throw new HttpError(400, 'Username: 2–32 letters, numbers, dot, dash or underscore.');
    if (!b.role || !['admin', 'editor', 'viewer'].includes(b.role)) throw new HttpError(400, 'Choose a role.');
    const existing = await env.DB.prepare('SELECT username FROM users WHERE username = ?').bind(u).first();
    if (!existing && (!b.password || b.password.length < 6)) throw new HttpError(400, 'Password must be at least 6 characters.');
    if (b.password) {
      if (b.password.length < 6) throw new HttpError(400, 'Password must be at least 6 characters.');
      const h = await hashPassword(b.password);
      await env.DB.prepare(`INSERT INTO users (username, pass_hash, salt, role, created_at) VALUES (?,?,?,?,?)
        ON CONFLICT(username) DO UPDATE SET pass_hash=excluded.pass_hash, salt=excluded.salt, role=excluded.role`)
        .bind(u, h.hash, h.salt, b.role, now()).run();
    } else {
      await env.DB.prepare('UPDATE users SET role = ? WHERE username = ?').bind(b.role, u).run();
    }
    await logActivity(env, s.u, 'user', `${existing ? 'Updated' : 'Added'} ${u} (${b.role})`);
    return json({ ok: true });
  }
  if (req.method === 'DELETE') {
    const u = decodeURIComponent(path.split('/').pop() || '');
    if (u === s.u) throw new HttpError(400, 'You cannot remove your own account.');
    await env.DB.prepare('DELETE FROM users WHERE username = ?').bind(u).run();
    await logActivity(env, s.u, 'user', `Removed ${u}`);
    return json({ ok: true });
  }
  throw new HttpError(405, 'Method not allowed.');
}

async function handleClear(env: Env, req: Request, src: string) {
  const s = await requireUser(env, req, 'admin');
  if (!ALL_SRCS.includes(src as Src)) throw new HttpError(400, 'Unknown report type.');
  const stmt = src === 'plan' ? 'DELETE FROM plan' : src === 'trr' ? 'DELETE FROM trr' : 'DELETE FROM stock WHERE src = ?';
  await env.DB.batch([
    src === 'plan' || src === 'trr' ? env.DB.prepare(stmt) : env.DB.prepare(stmt).bind(src),
    env.DB.prepare('INSERT INTO activity (at, username, action, detail) VALUES (?,?,?,?)').bind(now(), s.u, 'clear', `Cleared ${SRC_LABEL[src as Src]}`),
  ]);
  await broadcast(env, { type: 'data', src, by: s.u, rows: 0 });
  return json({ ok: true });
}

// ---------------------------------------------------------------- router

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const cors = corsHeaders(env, req);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    try {
      if (!env.JWT_SECRET) throw new HttpError(500, 'JWT_SECRET is not set on the Worker.');
      const p = url.pathname.replace(/\/+$/, '');

      // WebSocket for live updates (token in the query string, browsers can't set headers on WebSockets)
      if (p === '/api/live') {
        const s = await verifyToken(env, url.searchParams.get('token'));
        if (!s) return new Response('Unauthorized', { status: 401 });
        if (req.headers.get('Upgrade') !== 'websocket') return new Response('Expected WebSocket', { status: 426 });
        const stub = env.HUB.get(env.HUB.idFromName('main'));
        return stub.fetch(`https://hub/connect?u=${encodeURIComponent(s.u)}`, req);
      }

      let res: Response;
      if (p === '/api/health') res = json({ ok: true, at: now() });
      else if (p === '/api/auth/login' && req.method === 'POST') res = await handleLogin(env, req);
      else if (p === '/api/me') { const s = await requireUser(env, req); res = json({ user: { username: s.u, role: s.role } }); }
      else if (p === '/api/pullplan' && req.method === 'GET') res = await handlePullPlan(env, req);
      else if (p === '/api/upload' && req.method === 'POST') res = await handleUpload(env, req);
      else if (p === '/api/status' && req.method === 'PATCH') res = await handleStatus(env, req);
      else if (p === '/api/activity') {
        await requireUser(env, req);
        const r = await env.DB.prepare('SELECT at, username, action, detail FROM activity ORDER BY id DESC LIMIT 60').all();
        res = json({ activity: r.results });
      } else if (p.startsWith('/api/users')) res = await handleUsers(env, req, p);
      else if (p.startsWith('/api/data/') && req.method === 'DELETE') res = await handleClear(env, req, p.split('/').pop() || '');
      else if (p === '/api/online') {
        await requireUser(env, req);
        res = await env.HUB.get(env.HUB.idFromName('main')).fetch('https://hub/online');
      } else throw new HttpError(404, 'Not found.');

      const h = new Headers(res.headers);
      Object.entries(cors).forEach(([k, v]) => h.set(k, v));
      return new Response(res.body, { status: res.status, headers: h });
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      const message = e instanceof Error ? e.message : 'Unexpected error.';
      if (status === 500) console.error(e);
      return new Response(JSON.stringify({ error: message }), { status, headers: { 'Content-Type': 'application/json', ...cors } });
    }
  },
};

// ---------------------------------------------------------------- realtime hub

/** One instance ("main") holds every dashboard's WebSocket and fans messages out to all of them. */
export class LiveHub {
  constructor(private state: DurableObjectState) {}

  private online() {
    const users = this.state.getWebSockets().map((ws) => (ws.deserializeAttachment() as { u: string } | null)?.u).filter(Boolean) as string[];
    return Array.from(new Set(users)).sort();
  }
  private send(msg: Record<string, unknown>) {
    const data = JSON.stringify(msg);
    for (const ws of this.state.getWebSockets()) { try { ws.send(data); } catch { /* closed */ } }
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/connect') {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.serializeAttachment({ u: url.searchParams.get('u') || '?' });
      this.state.acceptWebSocket(server); // hibernation API: idle sockets cost nothing
      server.send(JSON.stringify({ type: 'hello', online: this.online(), at: new Date().toISOString() }));
      this.send({ type: 'presence', online: this.online() });
      return new Response(null, { status: 101, webSocket: client });
    }
    if (url.pathname === '/broadcast') {
      this.send((await req.json()) as Record<string, unknown>);
      return new Response('ok');
    }
    if (url.pathname === '/online') return json({ online: this.online() });
    return new Response('Not found', { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (message === 'ping') ws.send('pong');
  }
  async webSocketClose(ws: WebSocket) {
    try { ws.close(); } catch { /* already closed */ }
    this.send({ type: 'presence', online: this.online() });
  }
}
