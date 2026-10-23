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
  HUB?: DurableObjectNamespace; // optional: without it the dashboard refreshes every 20 s instead of instantly
  JWT_SECRET?: string; // optional: a random key is created and kept in D1 when not set
  ADMIN_USER?: string;
  ADMIN_PASSWORD?: string;
  ALLOWED_ORIGINS?: string; // comma separated, e.g. "https://shade.vercel.app,http://localhost:3000"
}

type Role = 'admin' | 'head' | 'editor' | 'viewer';
/** admin: everything incl. system settings · head: everything except system settings · editor (user): own plan and picks · viewer: read only */
const isBoss = (s: Session | null) => !!s && (s.role === 'admin' || s.role === 'head');
interface Session { u: string; role: Role; exp: number }

const STOCK_SRCS = ['zmmbe', 'kfc', 'pfc', 'plant'] as const;
const ALL_SRCS = ['plan', ...STOCK_SRCS, 'trr'] as const;
type Src = (typeof ALL_SRCS)[number];

const SRC_LABEL: Record<Src, string> = {
  plan: 'Day plan', zmmbe: 'ZMMBE', kfc: 'ZMMBE KFC', pfc: 'ZMMBE PFC', plant: 'PLANT report', trr: 'TRR',
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

/** Signing key: the JWT_SECRET secret if set, otherwise a random key created once and kept in D1. */
let cachedSecret: string | null = null;
async function getSecret(env: Env): Promise<string> {
  if (env.JWT_SECRET) return env.JWT_SECRET;
  if (cachedSecret) return cachedSecret;
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS config (k TEXT PRIMARY KEY, v TEXT NOT NULL)').run();
  const fresh = b64url(crypto.getRandomValues(new Uint8Array(32)));
  await env.DB.prepare("INSERT OR IGNORE INTO config (k, v) VALUES ('jwt_secret', ?)").bind(fresh).run();
  const row = await env.DB.prepare("SELECT v FROM config WHERE k = 'jwt_secret'").first<{ v: string }>();
  cachedSecret = row!.v;
  return cachedSecret;
}

async function hmacKey(secret: string) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
async function signToken(env: Env, s: Session): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify(s)));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(await getSecret(env)), enc.encode(body));
  return body + '.' + b64url(sig);
}
async function verifyToken(env: Env, token: string | null): Promise<Session | null> {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const ok = await crypto.subtle.verify('HMAC', await hmacKey(await getSecret(env)), fromB64url(sig), enc.encode(body));
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
  if (/^[a-z]{1,4}\d+$/i.test(s)) s = s.toUpperCase(); // SOs like E101697207
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

/** ISO week id of a yyyy-mm-dd date, e.g. "2026-W42". */
export function weekId(date: string | null): string | null {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const d = new Date(date + 'T00:00:00Z');
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3); // Thursday of this week decides the ISO year
  const year = d.getUTCFullYear();
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const week = 1 + Math.round(((d.getTime() - jan4.getTime()) / 86400000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}
const thisWeek = () => weekId(new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10))!; // Sri Lanka time

/**
 * Brings an older database up to date the first time a Worker instance runs:
 * adds plan.week, fills it from the dates, and moves dashboard edits to week-scoped keys ("2026-W42#SO|LI|Item").
 */
let schemaReady = false;
const SCHEMA_V = '31';
async function ensureSchema(env: Env) {
  if (schemaReady || !env.DB) return;
  try {
    if ((await env.DB.prepare("SELECT v FROM config WHERE k = 'schema_v'").first<{ v: string }>())?.v === SCHEMA_V) { schemaReady = true; return; }
  } catch { /* no config table yet */ }
  try { await env.DB.prepare('ALTER TABLE plan ADD COLUMN week TEXT').run(); } catch { /* already there */ }
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS plan_week ON plan(week, key)').run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS dispatch (
    ident TEXT PRIMARY KEY, week TEXT NOT NULL, item TEXT NOT NULL, qty REAL NOT NULL, raw_qty REAL, factor REAL,
    pallet TEXT, location TEXT, lot TEXT, order_no TEXT, uom TEXT, client_so TEXT,
    file_name TEXT, sheet_name TEXT, uploaded_by TEXT, uploaded_at TEXT)`).run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS dispatch_week_item ON dispatch(week, item)').run();
  await env.DB.batch([
    // plant code → display name, responsible person and target time for the summary
    env.DB.prepare('CREATE TABLE IF NOT EXISTS plant_info (code TEXT PRIMARY KEY, name TEXT, responsible TEXT, target TEXT, sort INTEGER DEFAULT 0)'),
    // QI / Block stock released to UR by hand (until the next ZMMBE shows it)
    env.DB.prepare('CREATE TABLE IF NOT EXISTS stock_release (week TEXT NOT NULL, key TEXT NOT NULL, qi REAL DEFAULT 0, block REAL DEFAULT 0, by_user TEXT, at TEXT, PRIMARY KEY (week, key))'),
    // dispatch QTY that did not match by item, assigned by hand to a plan line
    // received time per plant per week, typed on the dashboard (otherwise the plan upload time is used)
    env.DB.prepare('CREATE TABLE IF NOT EXISTS plant_received (week TEXT NOT NULL, code TEXT NOT NULL, received TEXT, by_user TEXT, at TEXT, PRIMARY KEY (week, code))'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS dispatch_assign (id INTEGER PRIMARY KEY AUTOINCREMENT, week TEXT NOT NULL, item TEXT NOT NULL, line TEXT NOT NULL, qty REAL NOT NULL, by_user TEXT, at TEXT)'),
  ]);
  for (const sql of ['ALTER TABLE uploads ADD COLUMN mode TEXT', 'ALTER TABLE dispatch ADD COLUMN first_at TEXT', 'ALTER TABLE plan ADD COLUMN src_user TEXT', 'ALTER TABLE plan ADD COLUMN src_at TEXT', 'ALTER TABLE users ADD COLUMN plant TEXT']) {
    try { await env.DB.prepare(sql).run(); } catch { /* already there */ }
  }
  await env.DB.prepare('UPDATE dispatch SET first_at = uploaded_at WHERE first_at IS NULL').run();
  const missing = await env.DB.prepare('SELECT DISTINCT date FROM plan WHERE week IS NULL').all<{ date: string | null }>();
  if (missing.results.length) {
    const stmts = missing.results.map((r) => r.date === null
      ? env.DB.prepare('UPDATE plan SET week = ? WHERE week IS NULL AND date IS NULL').bind(thisWeek())
      : env.DB.prepare('UPDATE plan SET week = ? WHERE week IS NULL AND date = ?').bind(weekId(r.date) || thisWeek(), r.date));
    await env.DB.batch(stmts);
  }
  await env.DB.prepare(`UPDATE line_status SET key = (SELECT p.week FROM plan p WHERE p.key = line_status.key LIMIT 1) || '#' || key
    WHERE instr(key, '#') = 0 AND EXISTS (SELECT 1 FROM plan p WHERE p.key = line_status.key)
    AND NOT EXISTS (SELECT 1 FROM line_status l2 WHERE l2.key = (SELECT p.week FROM plan p WHERE p.key = line_status.key LIMIT 1) || '#' || line_status.key)`).run();
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS config (k TEXT PRIMARY KEY, v TEXT NOT NULL)').run();
  await env.DB.batch(PICK_SCHEMA.map((q) => env.DB.prepare(q)));
  try { await env.DB.prepare('ALTER TABLE pick_req ADD COLUMN match TEXT').run(); } catch { /* already there */ }
  // PO: ZINR Purchasing Document = Korber Po Number
  for (const sql of ['ALTER TABLE zinr ADD COLUMN po TEXT', 'ALTER TABLE korber ADD COLUMN po TEXT']) { try { await env.DB.prepare(sql).run(); } catch { /* already there */ } }
  // per-user plans: owner = who uploaded / added the line (edits by others do not change it); pick type and "closed short"
  for (const sql of ['ALTER TABLE plan ADD COLUMN owner TEXT', "ALTER TABLE pick_req ADD COLUMN kind TEXT DEFAULT 'normal'", 'ALTER TABLE pick_req ADD COLUMN closed INTEGER DEFAULT 0', 'ALTER TABLE pick_req ADD COLUMN short REAL']) {
    try { await env.DB.prepare(sql).run(); } catch { /* already there */ }
  }
  await env.DB.batch([
    env.DB.prepare("UPDATE plan SET owner = COALESCE(src_user, (SELECT username FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1), 'admin') WHERE owner IS NULL"),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS plan_owner_week ON plan(owner, week)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS pick_req_user_day ON pick_req(by_user, day)'),
    // cancelled picks are deleted now: drop the ones kept before
    env.DB.prepare('DELETE FROM picks WHERE cancelled_at IS NOT NULL OR req_id IN (SELECT id FROM pick_req WHERE cancelled_at IS NOT NULL)'),
    env.DB.prepare('DELETE FROM pick_req WHERE cancelled_at IS NOT NULL'),
    env.DB.prepare("DELETE FROM config WHERE k IN ('c_counts', 'c_pick_counts', 'c_weeks') OR k LIKE 'c_weeks:%'"),
  ]);
  // week plans and day plans are separate plans (dashboards, uploads, status)
  try { await env.DB.prepare("ALTER TABLE plan ADD COLUMN plan_type TEXT DEFAULT 'week'").run(); } catch { /* already there */ }
  await env.DB.batch([
    env.DB.prepare("UPDATE plan SET plan_type = 'week' WHERE plan_type IS NULL"),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS plan_type_week ON plan(plan_type, week, owner)'),
    env.DB.prepare("DELETE FROM config WHERE k IN ('c_counts', 'c_pick_counts', 'c_weeks') OR k LIKE 'c_weeks:%'"),
  ]);
  // the Head role: the users table of older installs only allows admin / editor / viewer — rebuilt with the same rows
  const usersSql = (await env.DB.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'").first<{ sql: string }>())?.sql || '';
  if (/CHECK\s*\(\s*role\s+IN/i.test(usersSql) && !/'head'/.test(usersSql)) {
    try { await env.DB.prepare('ALTER TABLE users ADD COLUMN plant TEXT').run(); } catch { /* already there */ }
    await env.DB.batch([
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS users_v2 (username TEXT PRIMARY KEY, pass_hash TEXT NOT NULL, salt TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin','head','editor','viewer')), created_at TEXT NOT NULL, plant TEXT)`),
      env.DB.prepare('INSERT OR REPLACE INTO users_v2 (username, pass_hash, salt, role, created_at, plant) SELECT username, pass_hash, salt, role, created_at, plant FROM users'),
      env.DB.prepare('DROP TABLE users'),
      env.DB.prepare('ALTER TABLE users_v2 RENAME TO users'),
    ]);
  }
  // the number inside a pallet / barcode (CP000008089565 = COMPCP000008089565 = RCP000008089565A = CP8089565-TL06)
  try { await env.DB.prepare('ALTER TABLE korber ADD COLUMN pcore TEXT').run(); } catch { /* already there */ }
  const noCore = (await env.DB.prepare('SELECT pallet FROM korber WHERE pcore IS NULL').all<{ pallet: string }>()).results;
  const cores = noCore.map((r) => ({ p: r.pallet, c: palletCore(r.pallet) })).filter((x) => x.c);
  for (let i = 0; i < cores.length; i += 2000) {
    await env.DB.prepare(`UPDATE korber SET pcore = (SELECT json_extract(value, '$.c') FROM json_each(?1) WHERE json_extract(value, '$.p') = korber.pallet)
      WHERE pallet IN (SELECT json_extract(value, '$.p') FROM json_each(?1))`).bind(JSON.stringify(cores.slice(i, i + 2000))).run();
  }
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS korber_pcore ON korber(pcore)').run();
  // v19: a week plan line's status is per date ("<week>#key@<date>"); the old shared "<week>#key" is copied to each of its lines
  await env.DB.prepare(`INSERT OR IGNORE INTO line_status (key, status, comment, vehicle, qi_note, updated_by, updated_at)
    SELECT DISTINCT p.week || '#' || p.key || '@' || COALESCE(p.date, ''), ls.status, ls.comment, ls.vehicle, ls.qi_note, ls.updated_by, ls.updated_at
    FROM plan p JOIN line_status ls ON ls.key = p.week || '#' || p.key WHERE COALESCE(p.plan_type, 'week') = 'week'`).run();
  // v20: a day plan comes in rounds per plant — Pick 1, Pick 2 … The round is the plan's period ("week" column):
  // "<day>~<plant>~<n>". Older day plans become Pick 1 of their plant; their picks and statuses move with them.
  const RID = `p.date || '~' || COALESCE(NULLIF(upper(trim(p.plant)), ''), '-') || '~1'`;
  const OLD = "p.plan_type = 'day' AND instr(p.week, '~') = 0";
  await env.DB.batch([
    ...['picks', 'pick_req'].map((t) => env.DB.prepare(`UPDATE ${t} SET week = (SELECT ${RID} FROM plan p WHERE ${OLD} AND p.week = ${t}.week AND p.key || '|' || COALESCE(p.date, '') = ${t}.line LIMIT 1)
      WHERE EXISTS (SELECT 1 FROM plan p WHERE ${OLD} AND p.week = ${t}.week AND p.key || '|' || COALESCE(p.date, '') = ${t}.line)
        AND NOT EXISTS (SELECT 1 FROM plan w WHERE COALESCE(w.plan_type, 'week') = 'week' AND w.week = ${t}.week AND w.key || '|' || COALESCE(w.date, '') = ${t}.line)`)),
    env.DB.prepare(`INSERT OR IGNORE INTO line_status (key, status, comment, vehicle, qi_note, updated_by, updated_at)
      SELECT ${RID} || '#' || p.key, ls.status, ls.comment, ls.vehicle, ls.qi_note, ls.updated_by, ls.updated_at
      FROM plan p JOIN line_status ls ON ls.key = p.date || '#' || p.key WHERE ${OLD}`),
    env.DB.prepare(`UPDATE plan SET week = date || '~' || COALESCE(NULLIF(upper(trim(plant)), ''), '-') || '~1' WHERE plan_type = 'day' AND instr(week, '~') = 0 AND date IS NOT NULL`),
    env.DB.prepare("DELETE FROM config WHERE k IN ('c_counts', 'c_pick_counts', 'c_weeks') OR k LIKE 'c_weeks:%'"),
  ]);
  // v21: Pick Hold — a line on hold is not picked until the hold is released (reason, who, when)
  for (const c of ['hold TEXT', 'hold_by TEXT', 'hold_at TEXT']) { try { await env.DB.prepare(`ALTER TABLE line_status ADD COLUMN ${c}`).run(); } catch { /* already there */ } }
  // v22: a day is created, then its Picks; every Pick has its own reports (ZMMBE, ZINR, ZCOMENT VIEW, Korber) — rid = the Pick.
  // Rows uploaded before (rid '') are the shared reports, used by a Pick that has none of its own. The pick history stays one master.
  for (const t of ['stock', 'zinr', 'zcoment', 'korber', 'uploads']) { try { await env.DB.prepare(`ALTER TABLE ${t} ADD COLUMN rid TEXT NOT NULL DEFAULT ''`).run(); } catch { /* already there */ } }
  await env.DB.batch([
    env.DB.prepare('CREATE TABLE IF NOT EXISTS plan_day (day TEXT PRIMARY KEY, created_by TEXT, created_at TEXT)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS pick_round (rid TEXT PRIMARY KEY, day TEXT NOT NULL, plant TEXT, round INTEGER NOT NULL, created_by TEXT, created_at TEXT, note TEXT)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS pick_round_day ON pick_round(day, plant, round)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS stock_rid ON stock(rid, src, key)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS zinr_rid ON zinr(rid, so, li, material)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS zinr_rid_lot ON zinr(rid, lot)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS zcoment_rid ON zcoment(rid, lot)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS zcoment_rid_bc ON zcoment(rid, barcode)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS korber_rid ON korber(rid, pallet)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS korber_rid_item ON korber(rid, item, lot)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS korber_rid_core ON korber(rid, pcore)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS uploads_rid ON uploads(rid, src)'),
    // the days and Picks that already have a plan
    env.DB.prepare(`INSERT OR IGNORE INTO pick_round (rid, day, plant, round, created_by, created_at)
      SELECT week, MIN(date), NULLIF(substr(week, 12, instr(substr(week, 12), '~') - 1), '-'), CAST(substr(week, 12 + instr(substr(week, 12), '~')) AS INTEGER), MIN(src_user), MIN(src_at)
      FROM plan WHERE plan_type = 'day' AND instr(week, '~') > 0 GROUP BY week`),
    env.DB.prepare("INSERT OR IGNORE INTO plan_day (day, created_by, created_at) SELECT DISTINCT day, created_by, created_at FROM pick_round"),
  ]);
  // v30: SAP ZMM_TRR (transfer requests) per Pick — the plan report's TRANSFER NOTE; the plan file's own DATE of a Pick's line
  try { await env.DB.prepare('ALTER TABLE plan ADD COLUMN plan_date TEXT').run(); } catch { /* already there */ }
  // "Already sent": the ZMMBE rows at the plant storage locations, per Pick (stock's own src list cannot hold them)
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS stock_sent (src TEXT, key TEXT, plant TEXT, sloc TEXT, so_plant TEXT, so TEXT, li TEXT, material TEXT, batch TEXT, style TEXT,
      ur REAL, qi REAL, block REAL, assigned REAL, total REAL, plant_link TEXT, rid TEXT NOT NULL DEFAULT '')`),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS stock_sent_key ON stock_sent(key)'),
  ]);
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS ztrr (tn TEXT, tn_date TEXT, to_so TEXT, to_li TEXT, material TEXT, to_plant TEXT, from_so TEXT, from_li TEXT,
      batch TEXT, qty REAL, approved REAL, tqty REAL, status TEXT, raw TEXT, rid TEXT NOT NULL DEFAULT '')`),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS ztrr_key ON ztrr(to_so, to_li, material)'),
  ]);
  // v29: a pick saved by "Pick all matched" (auto = 1)
  try { await env.DB.prepare('ALTER TABLE pick_req ADD COLUMN auto INTEGER DEFAULT 0').run(); } catch { /* already there */ }
  // v28: ZROLLMGT roll number core (CP000008064260 = COMPCP000008064260 …) to find its Korber pallet; Status (UR) is checked
  try { await env.DB.prepare('ALTER TABLE zroll ADD COLUMN pcore TEXT').run(); } catch { /* already there */ }
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS zroll_pcore ON zroll(pcore)').run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS zroll_batch ON zroll(batch)').run();
  // v27: UR never holds QI stock: UR = Total − QI − Block − Assigned (the rows saved before counted QI as UR)
  await env.DB.batch([
    env.DB.prepare('UPDATE stock SET ur = MAX(0, ROUND(total - COALESCE(qi, 0) - COALESCE(block, 0) - COALESCE(assigned, 0), 3)) WHERE COALESCE(qi, 0) > 0 AND total IS NOT NULL AND ur > MAX(0, ROUND(total - COALESCE(qi, 0) - COALESCE(block, 0) - COALESCE(assigned, 0), 3))'),
    env.DB.prepare("DELETE FROM config WHERE k IN ('c_counts', 'c_pick_counts', 'c_weeks') OR k LIKE 'c_weeks:%' OR k LIKE 'c_counts:%' OR k LIKE 'c_pick_counts:%'"),
  ]);
  // v26: SAP ZROLLMGT (roll management): a roll is picked only when its Barcode Number is there at StorageBin EXPO-FIX
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS zroll (barcode TEXT NOT NULL, bin TEXT, material TEXT, batch TEXT, qty REAL, uom TEXT, sloc TEXT, plant TEXT,
      so TEXT, li TEXT, status TEXT, raw TEXT, rid TEXT NOT NULL DEFAULT '')`),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS zroll_barcode ON zroll(barcode)'),
  ]);
  // v25: balance follow-up — a line picked short is followed until its balance is picked (a line added for it: follow_of = the
  // original line, "week|key|date"); a balance closed by hand
  try { await env.DB.prepare('ALTER TABLE plan ADD COLUMN follow_of TEXT').run(); } catch { /* already there */ }
  await env.DB.batch([
    env.DB.prepare('CREATE TABLE IF NOT EXISTS follow_close (ref TEXT PRIMARY KEY, note TEXT, by_user TEXT, at TEXT)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS plan_follow ON plan(follow_of)'),
  ]);
  // v24: the ZMMBE row's plant (Settings → ZMMBE plants: Plant + SO Plant → plant)
  try { await env.DB.prepare('ALTER TABLE stock ADD COLUMN plant_link TEXT').run(); } catch { /* already there */ }
  // v23: Korber Pick Id (0 = pickable); rejected rolls (a picked roll taken back for a problem, and its replacement)
  try { await env.DB.prepare("ALTER TABLE korber ADD COLUMN pick_id TEXT NOT NULL DEFAULT '0'").run(); } catch { /* already there */ }
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS pick_reject (id INTEGER PRIMARY KEY AUTOINCREMENT, pick_id INTEGER, req_id INTEGER, day TEXT, week TEXT, line TEXT, so TEXT, li TEXT, item TEXT,
      pallet TEXT, qty REAL, roll_qty REAL, lot TEXT, insp_lot TEXT, batch TEXT, shade TEXT, reason TEXT, by_user TEXT, at TEXT, korber TEXT,
      replaced_by TEXT, replaced_qty REAL, replaced_pick INTEGER, replaced_user TEXT, replaced_at TEXT)`),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS pick_reject_pallet ON pick_reject(pallet)'),
  ]);
  await env.DB.prepare("INSERT INTO config (k, v) VALUES ('schema_v', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(SCHEMA_V).run();
  schemaReady = true;
}

/** A day plan round (Pick 1, 2 … of a plant on a day) is kept as the plan's period: "<day>~<plant>~<n>". */
/**
 * Which upload of each report a Pick reads: its own (rid = the Pick) when it has one, else the shared one (rid '', the
 * reports uploaded before Picks had their own, or for a Pick still without that report). Week plans read the shared ones.
 */
type ReportTable = 'stock' | 'zinr' | 'zcoment' | 'korber' | 'zroll' | 'ztrr' | 'stock_sent';
type Scope = Record<ReportTable, string>;
const SHARED: Scope = { stock: '', zinr: '', zcoment: '', korber: '', zroll: '', ztrr: '', stock_sent: '' };
/** a scope of its own reports: a Pick (day plan round) or a week plan (2026-W43) */
const scopeRid = (x: unknown) => (parseRound(x) || /^\d{4}-W\d{2}$/.test(String(x ?? '')) ? String(x) : '');
async function scopeOf(env: Env, rid: unknown): Promise<Scope> {
  if (!scopeRid(rid)) return SHARED;
  const own = new Set((await env.DB.prepare('SELECT DISTINCT src FROM uploads WHERE rid = ?').bind(String(rid)).all<{ src: string }>()).results.map((x) => x.src));
  const r = String(rid);
  return { stock: own.has('zmmbe') ? r : '', stock_sent: own.has('zmmbe') ? r : '', zinr: own.has('zinr') ? r : '', zcoment: own.has('zcoment') ? r : '', korber: own.has('korber') ? r : '', zroll: own.has('zroll') ? r : '', ztrr: own.has('ztrr') ? r : '' };
}
const SQL_WORDS = new Set(['WHERE', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'CROSS', 'NATURAL', 'ON', 'USING', 'ORDER', 'GROUP', 'LIMIT', 'UNION', 'HAVING', 'WINDOW', 'EXCEPT', 'INTERSECT', 'AS', 'SET', 'VALUES']);
/** A read of korber / zinr / zcoment / stock → only the rows of the scope's upload (writes are not touched). */
function scopeSql(sql: string, sc: Scope) {
  if (!/^\s*(SELECT|WITH)\b/i.test(sql)) return sql;
  return sql.replace(/\b(FROM|JOIN)\s+(korber|zinr|zcoment|zroll|ztrr|stock_sent|stock)\b(\s+(?:AS\s+)?([A-Za-z_]\w*))?/gi, (_m, kw: string, t: string, aliasPart?: string, alias?: string) => {
    const tb = t.toLowerCase() as ReportTable;
    // +rid: a filter only — the joins keep using the selective indexes (item / lot / SO / pallet). An index lookup on rid
    // (nearly every row has the same rid) makes SQLite cross whole tables: 100 s instead of 1 ms.
    const sub = `(SELECT * FROM ${tb} WHERE +rid = '${sc[tb].replace(/'/g, "''")}')`;
    if (alias && !SQL_WORDS.has(alias.toUpperCase())) return `${kw} ${sub} ${alias}`;
    return `${kw} ${sub} AS ${tb}${aliasPart ?? ''}`;
  });
}
/** The same Env, its reads of the four report tables limited to a Pick's reports. */
function scopedEnv(env: Env, sc: Scope): Env {
  const db = env.DB;
  const DB = new Proxy(db, { get(target, prop) {
    if (prop === 'prepare') return (sql: string) => target.prepare(scopeSql(sql, sc));
    const v = Reflect.get(target, prop);
    return typeof v === 'function' ? v.bind(target) : v;
  } });
  return { ...env, DB } as Env;
}
async function envFor(env: Env, rid: unknown) { return scopedEnv(env, await scopeOf(env, rid)); }

/** "W47" for a week, "2026-10-20 C064 Pick 2" for a day plan round */
const periodLabel = (w: unknown) => { const r = parseRound(w); return r ? `${r.day} ${r.plant ?? ''} Pick ${r.round}`.replace(/\s+/g, ' ') : /W\d{2}$/.test(String(w)) ? 'W' + String(w).slice(-2) : String(w ?? ''); };
const roundId = (day: string, plant: string | null | undefined, n: number) => `${day}~${(plant || '').trim().toUpperCase() || '-'}~${n}`;
function parseRound(w: unknown): { day: string; plant: string | null; round: number } | null {
  const m = /^(\d{4}-\d{2}-\d{2})~([^~]*)~(\d+)$/.exec(String(w ?? ''));
  return m ? { day: m[1], plant: m[2] === '-' ? null : m[2], round: Number(m[3]) } : null;
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
  const rank: Record<Role, number> = { viewer: 0, editor: 1, head: 2, admin: 3 };
  if (rank[s.role] < rank[min]) throw new HttpError(403, `This needs ${min} access.`);
  return s;
}

async function broadcast(env: Env, msg: Record<string, unknown>) {
  // every change bumps "rev": open dashboards ask /api/changes (one row) and reload only when it moved
  // and drops the cached results the change affects: the week list (plan lines, their status) and the row counts (uploads)
  const src = String(msg.src ?? '');
  const drop = msg.type === 'status' || src === 'pick' ? ['c_weeks'] : ['plan', 'clear', 'zmmbe', 'kfc', 'pfc', 'plant', 'trr'].includes(src) ? ['c_weeks', 'c_counts', 'c_pick_counts']
    : ['zinr', 'zcoment', 'korber', 'zroll', 'ztrr'].includes(src) ? ['c_pick_counts'] : [];
  try {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO config (k, v) VALUES ('rev', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(now()),
      ...drop.map((d) => env.DB.prepare("DELETE FROM config WHERE k = ?1 OR k LIKE ?1 || ':%'").bind(d)),
    ]);
  } catch { /* config table is created on first sign-in */ }
  if (!env.HUB) return; // realtime hub not bound: clients check /api/changes when someone uses the page
  const stub = env.HUB.get(env.HUB.idFromName('main'));
  await stub.fetch('https://hub/broadcast', { method: 'POST', body: JSON.stringify({ ...msg, at: now() }) });
}
async function logActivity(env: Env, user: string, action: string, detail: string) {
  await env.DB.prepare('INSERT INTO activity (at, username, action, detail) VALUES (?,?,?,?)').bind(now(), user, action, detail).run();
}

// ---------------------------------------------------------------- row mapping (uploads)

type Row = Record<string, unknown>;
/** Raised whenever the website needs a newer Worker. 5 = dispatch + letter SOs (E101697207). */
const API_VERSION = 59; // 10 = D1 with refresh-on-activity (/api/changes)

function mapPlan(rows: Row[], fallbackWeek: string) {
  const out: Row[] = [];
  rows.forEach((r, i) => {
    const so = normId(r.so), li = normId(r.li), item = normId(r.item);
    if (!so || !li || !item || !/^[A-Za-z]{0,4}\d/.test(so)) return;
    out.push({
      key: lineKey(so, li, item), so, li, item, date: normDate(r.date), week: weekId(normDate(r.date)) || fallbackWeek, qty: num(r.qty),
      plant: txt(r.plant), remarks: txt(r.remarks), row_no: i + 1,
      // optional columns carried from an existing pull plan sheet
      _status: txt(r.status), _comment: txt(r.comment), _qi_note: txt(r.qi_note), _vehicle: txt(r.vehicle),
    });
  });
  return out;
}
/** Identity of one stock row (one batch of one SO line in one storage location). */
const stockId = (r: Row) => [r.plant, r.sloc, r.so, r.li, r.material, r.batch].map((v) => String(v ?? '')).join('|');
function mapStock(src: string, rows: Row[]) {
  const out: Row[] = [];
  const seen = new Map<string, number>();
  for (const r of rows) {
    const so = normId(r.so), li = normId(r.li), mat = normId(r.material);
    if (!so || !li || !mat) continue; // SAP subtotal lines have no SO
    const qi = num(r.qi), block = num(r.block), assigned = num(r.assigned);
    const hasTotal = !(r.total === undefined || r.total === null || r.total === '');
    // UR = Total stock − SO QI stock − SO Blocked stock − Assigned Qty (Total = SO UR + SO QI + SO Blocked): QI and Block are
    // never UR (the SAP "Sales order UR Stock" column is not used when Total is there)
    const ur = hasTotal ? Math.max(0, Math.round((num(r.total) - qi - block - assigned) * 1000) / 1000) : num(r.ur);
    out.push({
      src, key: lineKey(so, li, mat), plant: txt(r.plant), sloc: txt(normId(r.sloc)), so_plant: txt(r.so_plant), so, li,
      material: mat, batch: txt(normId(r.batch)), style: txt(r.style), ur, qi, block, assigned,
      total: hasTotal ? num(r.total) : ur + qi + block,
    });
    // a fully identical row twice in the file (e.g. the same export pasted twice) counts once
    const o = out[out.length - 1];
    const id = [stockId(o), o.so_plant, o.style, o.ur, o.qi, o.block, o.assigned, o.total].map((v) => String(v ?? '')).join('|');
    if (seen.has(id)) out.pop(); else seen.set(id, out.length - 1);
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

/**
 * Replaces the rows of a table (within `where`) by `rows`, writing only what changed:
 * rows that are already there unchanged are kept, the rest are deleted by rowid and the new ones inserted.
 * D1 counts every written row (and index entry), and a report uploaded again is mostly the same rows.
 */
async function diffReplace(env: Env, table: string, cols: string[], rows: Row[], where: string, binds: unknown[], chunk = 400) {
  const sig = (r: Row) => cols.map((c) => { const v = r[c]; return v === null || v === undefined ? '' : String(v); }).join('\u0001');
  const have = (await env.DB.prepare(`SELECT rowid AS _rid, ${cols.join(', ')} FROM ${table} WHERE ${where}`).bind(...binds).all<Row>()).results;
  const bySig = new Map<string, number[]>();
  for (const h of have) { const k = sig(h); const l = bySig.get(k); if (l) l.push(Number(h._rid)); else bySig.set(k, [Number(h._rid)]); }
  const add: Row[] = [];
  for (const r of rows) { const l = bySig.get(sig(r)); if (l && l.length) l.pop(); else add.push(r); }
  const del = Array.from(bySig.values()).flat();
  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < del.length; i += 2000) stmts.push(env.DB.prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(del.slice(i, i + 2000))));
  stmts.push(...jsonInsert(env, table, cols, add, chunk));
  return { stmts, added: add.length, removed: del.length, unchanged: rows.length - add.length };
}

/** A plan line is the same line when week, SO, LI, Item and date all match. */
const lineId = (r: Row) => `${r.week}|${r.key}|${r.date ?? ''}`;
const cleanPlant = (v: unknown) => { const t = txt(v); return t && !/^#/.test(t) ? t.toUpperCase() : null; };
type PlanMode = 'merge' | 'replace-plant' | 'replace-week' | 'replace-day' | 'replace-round';

async function userPlant(env: Env, u: string) {
  return (await env.DB.prepare('SELECT plant FROM users WHERE username = ?').bind(u).first<{ plant: string | null }>())?.plant || null;
}

async function handleUpload(env: Env, req: Request) {
  const s = await requireUser(env, req, 'editor');
  const body = (await req.json()) as { src: Src; fileName?: string; sheetName?: string; rows: Row[]; week?: string; forceWeek?: boolean; mode?: PlanMode | 'add'; plant?: string; dryRun?: boolean; planType?: string; owner?: string;
    /** a day plan round: the day, and Pick 1, 2 … of the plant (`plant`) on that day */
    day?: string; round?: number;
    /** the Pick (round id "<day>~<plant>~<n>") the report belongs to; none = the shared reports */
    rid?: string };
  // a Pick's upload: the plan and every report go to that Pick
  const pickRid = scopeRid(body.rid) || null;
  if (pickRid && parseRound(pickRid)) {
    const pr = parseRound(pickRid)!;
    if (body.src === 'plan') { body.planType = 'day'; body.day = pr.day; body.plant = pr.plant ?? '-'; body.round = pr.round; }
  }
  let stockDups = 0;
  let plantOut = 0;
  // ZMMBE rows whose Plant + SO Plant is not in Settings → ZMMBE plants (left out)
  let notInSetup: { plant: string; soPlant: string; rows: number; ur: number }[] = [];
  let setupOut = 0;
  let stockDiff: { added: number; removed: number; unchanged: number } | null = null;
  let derived: { kfc: number; pfc: number; plant: number | null; plantKept?: number } | null = null;
  if (!ALL_SRCS.includes(body.src)) throw new HttpError(400, 'Unknown report type.');
  if (!Array.isArray(body.rows)) throw new HttpError(400, 'No rows in the upload.');

  if ((body.src === 'kfc' || body.src === 'pfc') && (await getSettings(env)).deriveFromZmmbe) {
    throw new HttpError(400, `${SRC_LABEL[body.src]} is built from the ZMMBE upload now — upload the ZMMBE report instead.`);
  }
  const stmts: D1PreparedStatement[] = [];
  let mapped: Row[];
  let weeks: string[] = [];
  // whose plan: your own; Admin / Head can upload a plan for a user
  let owner = s.u;
  if (body.src === 'plan' && body.owner && body.owner.trim().toLowerCase() !== s.u) {
    if (!isBoss(s)) throw new HttpError(403, 'Only Admin or Head can upload a plan for another user.');
    const o = body.owner.trim().toLowerCase();
    if (!(await env.DB.prepare('SELECT 1 FROM users WHERE username = ?').bind(o).first())) throw new HttpError(400, `There is no user "${o}".`);
    owner = o;
  }
  const planType = body.planType === 'day' ? 'day' : 'week';
  let planSummary: Record<string, unknown> | null = null;
  if (body.src === 'plan') {
    const chosen = body.week && /^\d{4}-W\d{2}$/.test(body.week) ? body.week : null;
    if (body.forceWeek && !chosen) throw new HttpError(400, 'Pick a week (like 2026-W43) or use "Auto from dates".');
    mapped = mapPlan(body.rows, chosen || thisWeek());
    if (body.forceWeek && chosen) for (const r of mapped) r.week = chosen; // the person chose the week: every line goes there
    // a day plan round: every line goes to that day, that plant and that Pick No; uploading it again replaces the round
    const rDay = planType === 'day' ? normDate(body.day) : null;
    let rid: string | null = null;
    if (planType === 'day' && body.day !== undefined) {
      const n = Math.floor(Number(body.round));
      if (!rDay) throw new HttpError(400, 'Choose the day of this plan.');
      if (!(n >= 1 && n <= 50)) throw new HttpError(400, 'Choose the Pick No (1, 2, 3 …) of this plan.');
      const pl = cleanPlant(body.plant);
      if (!pl) throw new HttpError(400, 'Choose the plant of this plan.');
      rid = roundId(rDay, pl, n);
      // the file's own DATE is kept (plan_date: the plan report's DATE); the line belongs to the Pick's day
      for (const r of mapped) { r.plan_date = r.date ?? null; r.date = rDay; r.week = rid; r.plant = pl; }
      // the day and the Pick exist from now on (also when created by this upload)
      stmts.push(env.DB.prepare('INSERT OR IGNORE INTO plan_day (day, created_by, created_at) VALUES (?,?,?)').bind(rDay, s.u, now()),
        env.DB.prepare('INSERT OR IGNORE INTO pick_round (rid, day, plant, round, created_by, created_at) VALUES (?,?,?,?,?,?)').bind(rid, rDay, pl, n, s.u, now()));
    }
    const mode: PlanMode = rid ? (body.mode === 'merge' ? 'merge' : 'replace-round')
      : body.mode === 'replace-week' || body.mode === 'replace-plant' || body.mode === 'replace-day' ? body.mode : 'merge';
    // day plan: the days in the file are replaced, the other days of the week stay
    const days = Array.from(new Set(mapped.map((r) => String(r.date ?? '')).filter(Boolean)));
    if (mode === 'replace-day' && !days.length) throw new HttpError(400, 'A day plan needs a date on its lines.');
    const plant = cleanPlant(body.plant) || (mode === 'replace-plant' ? null : await userPlant(env, s.u));
    if (mode === 'replace-plant' && !plant) throw new HttpError(400, 'Choose the plant whose lines this file replaces.');
    if (planType === 'day' && mapped.some((r) => !r.date)) throw new HttpError(400, 'A day plan needs a date on every line.');
    for (const r of mapped) { r.plant = rid ? r.plant : cleanPlant(r.plant) || plant; r.src_user = s.u; r.src_at = now(); r.owner = owner; r.plan_type = planType; }
    // the same line twice in one file: keep the last one
    const byId = new Map<string, Row>();
    // repeats whose QTY differs: the last row wins — listed so the person can check
    const dupQty: { so: unknown; li: unknown; item: unknown; date: unknown; was: number; now: number }[] = [];
    for (const r of mapped) {
      const had = byId.get(lineId(r));
      if (had && Math.abs(Number(had.qty) - Number(r.qty)) > 0.0005) dupQty.push({ so: r.so, li: r.li, item: r.item, date: r.date, was: Number(had.qty), now: Number(r.qty) });
      byId.set(lineId(r), r);
    }
    const inFileDups = mapped.length - byId.size;
    mapped = Array.from(byId.values());
    weeks = Array.from(new Set(mapped.map((r) => String(r.week)))).sort();

    // what is already there for these weeks
    // a user's plan is their own: only their lines are compared, replaced or removed
    const existing = (await env.DB.prepare(`SELECT week, key, date, plant FROM plan WHERE week IN (SELECT value FROM json_each(?1)) AND owner = ?2 AND plan_type = ?3`).bind(JSON.stringify(weeks), owner, planType).all<Row>()).results;
    const existingIds = new Set(existing.map(lineId));
    const incomingIds = new Set(mapped.map(lineId));
    const updated = mapped.filter((r) => existingIds.has(lineId(r))).length;
    const added = mapped.length - updated;
    const removedRows = existing.filter((r) => !incomingIds.has(lineId(r)) && (mode === 'replace-week' || mode === 'replace-round' || (mode === 'replace-plant' && cleanPlant(r.plant) === plant) || (mode === 'replace-day' && days.includes(String(r.date ?? '')))));
    const kept = existing.length - updated - removedRows.length;
    const rinfo = rid ? parseRound(rid) : null;
    const preview = { mode, plant: rinfo?.plant ?? plant, weeks, days: rid ? [rDay] : days.sort(), owner, planType, ...(rinfo ? { round: rinfo.round, rid } : {}), added, updated, removed: removedRows.length, kept, inFileDups, dupQty: dupQty.slice(0, 30), dupQtyCount: dupQty.length, lines: mapped.length };
    if (body.dryRun) return json({ ok: true, dryRun: true, ...preview });

    const ids = JSON.stringify(mapped.map(lineId));
    if (mode === 'replace-day') stmts.push(env.DB.prepare('DELETE FROM plan WHERE week IN (SELECT value FROM json_each(?1)) AND date IN (SELECT value FROM json_each(?2)) AND owner = ?3 AND plan_type = ?4').bind(JSON.stringify(weeks), JSON.stringify(days), owner, planType));
    if (mode === 'replace-round') stmts.push(env.DB.prepare('DELETE FROM plan WHERE week = ?1 AND owner = ?2 AND plan_type = ?3').bind(rid, owner, planType));
    if (mode === 'replace-week') stmts.push(env.DB.prepare('DELETE FROM plan WHERE week IN (SELECT value FROM json_each(?1)) AND owner = ?2 AND plan_type = ?3').bind(JSON.stringify(weeks), owner, planType));
    if (mode === 'replace-plant') stmts.push(env.DB.prepare('DELETE FROM plan WHERE week IN (SELECT value FROM json_each(?1)) AND upper(COALESCE(plant, \'\')) = ?2 AND owner = ?3 AND plan_type = ?4').bind(JSON.stringify(weeks), plant, owner, planType));
    // merge (and the replace modes): a line of this user's plan that is already there is replaced, never duplicated
    stmts.push(env.DB.prepare(`DELETE FROM plan WHERE owner = ?2 AND plan_type = ?3 AND week || '|' || key || '|' || COALESCE(date, '') IN (SELECT value FROM json_each(?1))`).bind(ids, owner, planType));
    stmts.push(...jsonInsert(env, 'plan', ['key', 'so', 'li', 'item', 'date', 'week', 'qty', 'plant', 'remarks', 'row_no', 'src_user', 'src_at', 'owner', 'plan_type', 'plan_date'], mapped.map((r) => ({ ...r, plan_date: r.plan_date ?? null }))));
    planSummary = preview;
    // Status/comment columns that came with the file seed the dashboard, without overwriting edits made on it.
    const seed = mapped.filter((r) => r._status || r._comment || r._qi_note || r._vehicle)
      .map((r) => ({ key: statusKey({ plan_type: planType, week: r.week, date: r.date, key: r.key }), status: r._status, comment: r._comment, vehicle: r._vehicle, qi_note: r._qi_note, updated_by: s.u, updated_at: now() }));
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
    stockDups = body.rows.filter((r) => normId(r.so) && normId(r.li) && normId(r.material)).length - mapped.length;
    const cols = ['rid', 'src', 'key', 'plant', 'sloc', 'so_plant', 'so', 'li', 'material', 'batch', 'style', 'ur', 'qi', 'block', 'assigned', 'total', 'plant_link'];
    const srid = pickRid ?? '';
    // "add": another part of the same report replaces only the rows this file has, the rest stay; otherwise the whole report is replaced.
    // Either way only changed rows are written.
    const write = async (src: string, rows: Row[]) => {
      // a Pick's report replaces only that Pick's rows (the shared report and other Picks stay)
      const rowsIn = rows.map((r) => ({ ...r, src, rid: srid }));
      const tbl = src === 'sent' ? 'stock_sent' : 'stock';
      return body.mode === 'add'
        ? diffReplace(env, tbl, cols, rowsIn, `src = ? AND rid = ? AND COALESCE(plant,'') || '|' || COALESCE(sloc,'') || '|' || so || '|' || li || '|' || material || '|' || COALESCE(batch,'') IN (SELECT value FROM json_each(?))`, [src, srid, JSON.stringify(rows.map(stockId))])
        : diffReplace(env, tbl, cols, rowsIn, 'src = ? AND rid = ?', [src, srid]);
    };
    const rules = await getSettings(env);
    // Settings → ZMMBE plants: only the Plant + SO Plant pairs set up count (each linked to its plant); the others are left out
    // and listed so they can be added. No pairs set up: every row counts.
    if (rules.zmmbePlants.length && ['zmmbe', 'kfc', 'pfc'].includes(body.src)) {
      const plantLoc = new Set(rules.plantSlocs.map(up));
      const keep: Row[] = [];
      const miss = new Map<string, { plant: string; soPlant: string; rows: number; ur: number }>();
      for (const r of mapped) {
        const pr = pairOf(rules.zmmbePlants, r.plant, r.so_plant);
        if (pr) { r.plant_link = pr.link || null; keep.push(r); continue; }
        if (plantLoc.has(up(r.sloc))) { keep.push(r); continue; } // a plant-location row: left out by its own rule below
        const k = `${up(r.plant)}|${up(r.so_plant)}`;
        const m = miss.get(k) || { plant: up(r.plant), soPlant: up(r.so_plant), rows: 0, ur: 0 };
        m.rows++; m.ur = r3(m.ur + Number(r.ur || 0)); miss.set(k, m);
      }
      notInSetup = Array.from(miss.values()).sort((a, b) => b.ur - a.ur);
      setupOut = mapped.length - keep.length;
      mapped = keep;
      if (!mapped.length) throw new HttpError(400, `No row of this ZMMBE is a Plant + SO Plant set up in Settings → ZMMBE plants (${notInSetup.map((m) => `${m.plant} + ${m.soPlant || '–'}`).join(', ')}). Add them there first.`);
    }
    if (body.src === 'zmmbe' && rules.deriveFromZmmbe) {
      // one ZMMBE gives the other reports, like the Pull Plan workbook: PFC = the PFC storage locations (41, COMF),
      // KFC = every other ZMMBE row, PLANT = plant storage locations (40, 70, 75) if the export has them (they are not ZMMBE stock)
      const loc = (r: Row) => up(r.sloc);
      const plantSet = new Set(rules.plantSlocs.map(up)), pfcSet = new Set(rules.pfcSlocs.map(up));
      const plantRows = mapped.filter((r) => plantSet.has(loc(r)));
      const zRows = mapped.filter((r) => !plantSet.has(loc(r)));
      const pfcRows = zRows.filter((r) => pfcSet.has(loc(r)));
      const kfcRows = zRows.filter((r) => !pfcSet.has(loc(r)));
      const dz = await write('zmmbe', zRows), dk = await write('kfc', kfcRows), dp = await write('pfc', pfcRows);
      // PLANT comes from ZMMBE only while no PLANT report of its own was uploaded: a few plant-location rows in a ZMMBE
      // must never replace the full PLANT report (they are still kept out of ZMMBE / KFC / PFC)
      const lastPlant = await env.DB.prepare("SELECT file_name FROM uploads WHERE src = 'plant' ORDER BY id DESC LIMIT 1").first<{ file_name: string | null }>();
      const ownPlant = !!lastPlant && !/\(from ZMMBE\)$/.test(String(lastPlant.file_name ?? ''));
      const dpl = plantRows.length && !ownPlant ? await write('plant', plantRows) : null;
      // "Already sent": the ZMMBE rows at the plant storage locations (the stock is in the plant already) — the plan report
      const dsent = await write('sent', plantRows);
      stmts.push(...dz.stmts, ...dk.stmts, ...dp.stmts, ...(dpl ? dpl.stmts : []), ...dsent.stmts);
      stockDiff = dz;
      // plant: the plant-location rows kept out of ZMMBE / KFC / PFC (shown as "left out", not as skipped)
      derived = { kfc: kfcRows.length, pfc: pfcRows.length, plant: plantRows.length, ...(plantRows.length && !dpl ? { plantKept: plantRows.length } : {}) };
      plantOut = plantRows.length;
      const from = `${body.fileName || 'ZMMBE'} (from ZMMBE)`;
      for (const [src, n] of [['kfc', kfcRows.length], ['pfc', pfcRows.length], ...(dpl ? [['plant', plantRows.length]] : [])] as [string, number][]) {
        stmts.push(env.DB.prepare('INSERT INTO uploads (src, file_name, sheet_name, row_count, uploaded_by, uploaded_at, mode, rid) VALUES (?,?,?,?,?,?,?,?)')
          .bind(src, from, body.sheetName || null, n, s.u, now(), body.mode === 'add' ? 'add' : null, srid));
      }
      mapped = zRows.length ? zRows : mapped;
    } else {
      const d = await write(body.src, mapped);
      stmts.push(...d.stmts);
      stockDiff = d;
    }
  }
  if (mapped.length === 0) throw new HttpError(400, `No usable rows found for ${SRC_LABEL[body.src]}. Check the column mapping (SO, LI and Item/Material are required).`);

  // the upload belongs to its Pick (plan and ZMMBE of a Pick; the shared reports have rid '')
  const upRid = body.src === 'plan' ? (weeks.find((w) => parseRound(w)) ?? '') : body.src === 'trr' ? '' : (pickRid ?? '');
  stmts.push(env.DB.prepare('INSERT INTO uploads (src, file_name, sheet_name, row_count, uploaded_by, uploaded_at, mode, rid) VALUES (?,?,?,?,?,?,?,?)')
    .bind(body.src, body.fileName || null, body.sheetName || null, mapped.length, s.u, now(), body.src !== 'plan' && body.mode === 'add' ? 'add' : null, upRid));
  stmts.push(env.DB.prepare('INSERT INTO activity (at, username, action, detail) VALUES (?,?,?,?)')
    .bind(now(), s.u, 'upload', `${SRC_LABEL[body.src]}${body.mode === 'add' && body.src !== 'plan' ? ' (added to current)' : ''}${weeks.length ? ' ' + weeks.map((w) => periodLabel(w)).join(', ') : ''}${planSummary?.plant && !weeks.some((w) => parseRound(w)) ? ' · ' + planSummary.plant : ''}: ${planSummary ? `${planSummary.added} new, ${planSummary.updated} updated${planSummary.removed ? `, ${planSummary.removed} removed` : ''}` : mapped.length + ' rows'}${body.fileName ? ' from ' + body.fileName : ''}`));
  await env.DB.batch(stmts); // all or nothing

  await broadcast(env, { type: 'data', src: body.src, by: s.u, rows: mapped.length, weeks });
  return json({ ok: true, src: body.src, accepted: mapped.length, skipped: Math.max(0, body.rows.length - mapped.length - plantOut - setupOut - (Number(planSummary?.inFileDups) || 0) - stockDups), stockDups, ...(notInSetup.length ? { notInSetup, setupOut } : {}), mode: body.src === 'plan' ? undefined : body.mode === 'add' ? 'add' : 'replace', weeks, changes: stockDiff ? { added: stockDiff.added, removed: stockDiff.removed, unchanged: stockDiff.unchanged } : undefined, derived: derived ?? undefined, ...(planSummary || {}) });
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
/**
 * The line_status key of a plan line: a day plan line is "<day>#SO|LI|Item"; a week plan line is
 * "<week>#SO|LI|Item@<date>", so the same SO / LI / Item on two days of one week keeps its own status.
 */
const SK = (a: string) => `(CASE WHEN ${a}.plan_type = 'day' AND instr(${a}.week, '~') > 0 THEN ${a}.week || '#' || ${a}.key WHEN ${a}.plan_type = 'day' THEN ${a}.date || '#' || ${a}.key ELSE ${a}.week || '#' || ${a}.key || '@' || COALESCE(${a}.date, '') END)`;
const statusKey = (r: { plan_type?: unknown; week?: unknown; date?: unknown; key?: unknown }) =>
  r.plan_type === 'day' ? (parseRound(r.week) ? `${r.week}#${r.key}` : `${r.date}#${r.key}`) : `${r.week}#${r.key}@${r.date ?? ''}`;

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
    GROUP_CONCAT(DISTINCT CASE WHEN src='zmmbe' THEN plant_link END) AS stock_link,
    GROUP_CONCAT(DISTINCT CASE WHEN src='plant' THEN plant END) AS at_plant
  FROM stock WHERE key IN (SELECT key FROM plan WHERE (?1 IS NULL OR week = ?1) AND (?5 IS NULL OR date = ?5)) GROUP BY key
),
t AS (SELECT key, SUM(qty) AS tn_qty, GROUP_CONCAT(DISTINCT tn) AS tn_number FROM trr WHERE key IN (SELECT key FROM plan WHERE (?1 IS NULL OR week = ?1) AND (?5 IS NULL OR date = ?5)) GROUP BY key),
d AS (SELECT week, key, COUNT(*) AS dup FROM plan WHERE (?1 IS NULL OR week = ?1) AND (?3 IS NULL OR owner = ?3) AND plan_type = ?4 AND (?5 IS NULL OR date = ?5) GROUP BY week, key)
SELECT p.rowid AS id, p.row_no, p.key, p.week, p.owner, p.plan_type, p.src_user, p.src_at, p.so, p.li, p.item, p.date, p.qty, p.plant, p.remarks,
  COALESCE(s.ur,0) AS ur, COALESCE(s.qi,0) AS qi, COALESCE(s.block,0) AS block, COALESCE(s.assigned,0) AS assigned,
  p.qty - COALESCE(s.assigned,0) AS variance,
  COALESCE(s.kfc_ur,0) AS kfc_ur, COALESCE(s.kfc_qi,0) AS kfc_qi, COALESCE(s.kfc_block,0) AS kfc_block,
  COALESCE(s.pfc_ur,0) AS pfc_ur, COALESCE(s.pfc_qi,0) AS pfc_qi, COALESCE(s.pfc_block,0) AS pfc_block,
  COALESCE(s.plant_qty,0) AS plant_qty, s.stock_plant, s.stock_sloc, s.stock_link, s.at_plant,
  COALESCE(t.tn_qty,0) AS tn_qty, t.tn_number, d.dup,
  CASE WHEN ?2 IS NOT NULL AND EXISTS (
    SELECT 1 FROM plan pp LEFT JOIN line_status pls ON pls.key = ${SK('pp')}
    WHERE pp.week = ?2 AND pp.key = p.key AND (?3 IS NULL OR pp.owner = ?3) AND pp.plan_type = ?4 AND lower(COALESCE(pls.status, '')) NOT LIKE '%done%'
  ) THEN 1 ELSE 0 END AS carried,
  ls.status, ls.comment, ls.vehicle, ls.qi_note, ls.updated_by, ls.updated_at, ls.hold, ls.hold_by, ls.hold_at
FROM plan p
LEFT JOIN s  ON s.key = p.key
LEFT JOIN t  ON t.key = p.key
LEFT JOIN d  ON d.key = p.key AND d.week = p.week
LEFT JOIN line_status ls ON ls.key = ${SK('p')}
WHERE (?1 IS NULL OR p.week = ?1) AND (?3 IS NULL OR p.owner = ?3) AND p.plan_type = ?4 AND (?5 IS NULL OR p.date = ?5)
ORDER BY p.date, p.week, p.row_no`;

/** A plan line is done when its status is Done, or its picks cover the QTY, or a pick closed it short (as on the dashboard). */
const PK_JOIN = `LEFT JOIN (SELECT pp.week, pp.line, SUM(pp.qty) q, MAX(COALESCE(rq.closed, 0)) closed FROM picks pp LEFT JOIN pick_req rq ON rq.id = pp.req_id
  WHERE pp.cancelled_at IS NULL GROUP BY pp.week, pp.line) pk ON pk.week = p.week AND pk.line = p.key || '|' || COALESCE(p.date, '')`;
const DONE_SUM = `SUM(CASE WHEN lower(COALESCE(ls.status, '')) LIKE '%done%' OR COALESCE(pk.closed, 0) = 1 OR COALESCE(pk.q, 0) >= p.qty - 0.0005 THEN 1 ELSE 0 END)`;

const WEEKS_SQL = `
SELECT p.week, COUNT(*) AS lines, MIN(p.date) AS start, MAX(p.date) AS end, SUM(p.qty) AS qty,
  ${DONE_SUM} AS done
FROM plan p LEFT JOIN line_status ls ON ls.key = ${SK('p')} ${PK_JOIN}
WHERE (?1 IS NULL OR p.owner = ?1) AND p.plan_type = ?2
GROUP BY p.week ORDER BY p.week DESC`;

/** Day plans: one entry per day (newest first) with how many lines are done. */
const DAYS_SQL = `
SELECT p.date AS day, p.week, COUNT(*) AS lines, SUM(p.qty) AS qty,
  ${DONE_SUM} AS done
FROM plan p LEFT JOIN line_status ls ON ls.key = ${SK('p')} ${PK_JOIN}
WHERE (?1 IS NULL OR p.owner = ?1) AND p.plan_type = 'day' AND p.date IS NOT NULL
GROUP BY p.date ORDER BY p.date DESC LIMIT 90`;

/** System settings (admin): pick rules. */
interface Settings {
  fullRollPct: number; defaultPickKind: 'normal' | 'offsite'; allowOffsite: boolean; allowNormalShort: boolean; allowNormalFull: boolean;
  /** build ZMMBE KFC / PFC (and PLANT, if present) from the ZMMBE upload by storage location */
  deriveFromZmmbe: boolean; pfcSlocs: string[]; plantSlocs: string[];
  /** time setup: SO/LI lines handled per hour (W/H), minutes after the target time before a plan counts as late, default target time */
  soliPerHour: number; lateGraceMin: number; defaultTarget: string;
  /** ZMMBE Plant + SO Plant pairs that count (each linked to a plant of Settings → Plants); none = every row counts */
  zmmbePlants: { plant: string; soPlant: string; link: string }[];
  /** ZROLLMGT check: only rolls whose Barcode Number is in ZROLLMGT at this StorageBin, a ZCOMENT VIEW Barcode Number and the Korber Pallet */
  rollGate: boolean; pickBin: string;
  /** ZMMBE batch → ZROLLMGT System Batch rolls only when ZINSR has the SO + LI + Material + Batch too */
  zrollNeedsZinsr: boolean;
}
const DEFAULT_SETTINGS: Settings = { fullRollPct: 10, defaultPickKind: 'normal', allowOffsite: true, allowNormalShort: true, allowNormalFull: true,
  deriveFromZmmbe: true, pfcSlocs: ['41', 'COMF'], plantSlocs: ['40', '70', '75'], soliPerHour: 12, lateGraceMin: 0, defaultTarget: '', zmmbePlants: [], rollGate: true, pickBin: 'EXPO-FIX', zrollNeedsZinsr: true };
const slocList = (v: unknown, def: string[]) => Array.isArray(v) || typeof v === 'string'
  ? Array.from(new Set((Array.isArray(v) ? v : String(v).split(/[,\s]+/)).map((x) => normId(String(x).trim()).toUpperCase()).filter(Boolean))).slice(0, 30) : def;
/** ZMMBE Plant + SO Plant pairs: upper case, no blanks, each pair once ("*" = any SO Plant) */
function plantPairs(v: unknown): Settings['zmmbePlants'] {
  const out: Settings['zmmbePlants'] = [];
  for (const x of Array.isArray(v) ? v : []) {
    const plant = String((x as Row)?.plant ?? '').trim().toUpperCase(), soPlant = String((x as Row)?.soPlant ?? '').trim().toUpperCase() || '*';
    if (!plant || out.some((o) => o.plant === plant && o.soPlant === soPlant)) continue;
    out.push({ plant, soPlant, link: String((x as Row)?.link ?? '').trim().toUpperCase() });
  }
  return out.slice(0, 200);
}
/** the setup pair a ZMMBE row belongs to (exact SO Plant first, then "*"); null = not in the setup */
const pairOf = (pairs: Settings['zmmbePlants'], plant: unknown, soPlant: unknown) => {
  const p0 = String(plant ?? '').trim().toUpperCase(), s0 = String(soPlant ?? '').trim().toUpperCase();
  return pairs.find((x) => x.plant === p0 && x.soPlant === s0) ?? pairs.find((x) => x.plant === p0 && x.soPlant === '*') ?? null;
};
async function getSettings(env: Env): Promise<Settings> {
  try {
    const v = (await env.DB.prepare("SELECT v FROM config WHERE k = 'settings'").first<{ v: string }>())?.v;
    return { ...DEFAULT_SETTINGS, ...(v ? JSON.parse(v) : {}) };
  } catch { return DEFAULT_SETTINGS; }
}

/**
 * Whose plan / picks a request shows. Editors: always their own. Admins and viewers: everyone, or the user chosen
 * with ?user=. The public dashboard (not signed in): everyone, or ?user=.  null = everyone.
 */
async function viewScope(env: Env, req: Request): Promise<{ owner: string | null; s: Session | null }> {
  const h = req.headers.get('Authorization') || '';
  const s = await verifyToken(env, h.startsWith('Bearer ') ? h.slice(7) : null);
  const asked = (new URL(req.url).searchParams.get('user') || '').trim().toLowerCase();
  if (s && s.role === 'editor') return { owner: s.u, s };
  return { owner: asked && asked !== '*' ? asked : null, s };
}

/**
 * Results that read whole tables are kept in config and worked out again only after a change that affects them
 * (see broadcast): the week list (whole plan) and the row counts (whole stock table).
 */
async function cached<T>(env: Env, k: string, make: () => Promise<T>): Promise<T> {
  const hit = await env.DB.prepare('SELECT v FROM config WHERE k = ?').bind(k).first<{ v: string }>();
  if (hit) { try { return JSON.parse(hit.v) as T; } catch { /* rebuild */ } }
  const v = await make();
  await env.DB.prepare('INSERT INTO config (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').bind(k, JSON.stringify(v)).run();
  return v;
}

/**
 * Backup / Restore (admin). Done table by table in pages, so a big database never has to fit in one request:
 *   GET  /api/backup                         → the tables and their row counts
 *   GET  /api/backup/rows?table=&after=&limit= → { cols, rows (arrays), last } by rowid
 *   POST /api/restore/begin {tables}          → empties those tables (the backup replaces them)
 *   POST /api/restore/rows {table, cols, rows} → adds rows (columns the table no longer has are left out)
 *   POST /api/restore/end {file}              → caches cleared, every open page reloads
 * Never in a backup: the users and their passwords, the login key and the database link (config).
 */
const BACKUP_SKIP = new Set(['users', 'sqlite_sequence', '_cf_METADATA', '_cf_KV']);
const CONFIG_SECRET = "k IN ('jwt_secret', 'database_url', 'schema_v', 'rev') OR k LIKE 'c\\_%' ESCAPE '\\'";
async function backupTables(env: Env) {
  const t = (await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY name").all<{ name: string }>()).results;
  return t.map((x) => x.name).filter((n) => !BACKUP_SKIP.has(n) && /^[a-z_][a-z0-9_]*$/i.test(n));
}
async function tableCols(env: Env, table: string) {
  return (await env.DB.prepare(`SELECT name FROM pragma_table_info(?)`).bind(table).all<{ name: string }>()).results.map((c) => c.name);
}
async function handleBackup(env: Env, req: Request, p: string) {
  const s = await requireUser(env, req, 'admin');
  const url = new URL(req.url);
  const tables = await backupTables(env);
  const cfgWhere = (t: string) => (t === 'config' ? ` WHERE NOT (${CONFIG_SECRET})` : '');
  if (p === '/api/backup' && req.method === 'GET') {
    const counts: { name: string; rows: number }[] = [];
    for (const t of tables) counts.push({ name: t, rows: Number((await env.DB.prepare(`SELECT COUNT(*) n FROM ${t}${cfgWhere(t)}`).first<{ n: number }>())?.n ?? 0) });
    return json({ app: 'mas-weekly-plan-tracker', api: API_VERSION, schema: SCHEMA_V, at: now(), by: s.u, tables: counts });
  }
  if (p === '/api/backup/rows' && req.method === 'GET') {
    const t = url.searchParams.get('table') || '';
    if (!tables.includes(t)) throw new HttpError(400, 'Unknown table.');
    const after = Math.max(0, Number(url.searchParams.get('after')) || 0);
    const limit = Math.min(5000, Math.max(100, Number(url.searchParams.get('limit')) || 2000));
    const cols = await tableCols(env, t);
    const rows = (await env.DB.prepare(`SELECT rowid AS _rid, * FROM ${t} WHERE rowid > ?1${t === 'config' ? ` AND NOT (${CONFIG_SECRET})` : ''} ORDER BY rowid LIMIT ?2`).bind(after, limit).all<Row>()).results;
    return json({ table: t, cols, rows: rows.map((r) => cols.map((c) => r[c] ?? null)), last: rows.length ? Number(rows[rows.length - 1]._rid) : after, done: rows.length < limit });
  }
  if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
  const b = (await req.json()) as { tables?: string[]; table?: string; cols?: string[]; rows?: unknown[][]; file?: string };
  if (p === '/api/restore/begin') {
    const list = (b.tables || []).filter((t) => tables.includes(t));
    if (!list.length) throw new HttpError(400, 'The file has no tables of this system. Is it a MAS Weekly Plan Tracker backup?');
    await env.DB.batch(list.map((t) => env.DB.prepare(`DELETE FROM ${t}${cfgWhere(t)}`)));
    await logActivity(env, s.u, 'restore', `Restore started: ${list.length} tables emptied (${list.join(', ')})`);
    return json({ ok: true, tables: list });
  }
  if (p === '/api/restore/rows') {
    const t = String(b.table || '');
    if (!tables.includes(t)) throw new HttpError(400, `Unknown table ${t}.`);
    const have = new Set(await tableCols(env, t));
    const cols = (b.cols || []).map(String);
    const keep = cols.map((c, i) => [c, i] as const).filter(([c]) => have.has(c) && /^[a-z_][a-z0-9_]*$/i.test(c));
    if (!keep.length) throw new HttpError(400, `No columns of ${t} in the file.`);
    let rows = (b.rows || []).map((r) => Object.fromEntries(keep.map(([c, i]) => [c, (r as unknown[])[i] ?? null])) as Row);
    if (t === 'config') rows = rows.filter((r) => !/^(jwt_secret|database_url|schema_v|rev)$|^c_/.test(String(r.k ?? '')));
    // INSERT OR REPLACE: a row sent twice (a retried page) or a config key the system wrote meanwhile is not an error
    const names = keep.map(([c]) => c);
    const sel = names.map((c) => `json_extract(value, '$.${c}')`).join(', ');
    const chunk = t === 'korber' ? 150 : 400;
    const stmts: D1PreparedStatement[] = [];
    for (let i = 0; i < rows.length; i += chunk) stmts.push(env.DB.prepare(`INSERT OR REPLACE INTO ${t} (${names.join(', ')}) SELECT ${sel} FROM json_each(?)`).bind(JSON.stringify(rows.slice(i, i + chunk))));
    for (let i = 0; i < stmts.length; i += 40) await env.DB.batch(stmts.slice(i, i + 40));
    return json({ ok: true, table: t, rows: rows.length });
  }
  if (p === '/api/restore/end') {
    await env.DB.prepare("DELETE FROM config WHERE k LIKE 'c\\_%' ESCAPE '\\'").run();
    await logActivity(env, s.u, 'restore', `Restored from backup ${String(b.file || '').slice(0, 120)}`);
    await broadcast(env, { type: 'data', src: 'clear', by: s.u, rows: 0, weeks: [] });
    return json({ ok: true });
  }
  throw new HttpError(404, 'Not found.');
}

/** Every report of a Pick: its own upload, or the shared one it reads instead; rows = the rows it reads. */
async function reportStatus(env: Env, rid: string) {
  const sc = await scopeOf(env, rid);
  const last = async (src: string, r: string) => (await env.DB.prepare('SELECT src, file_name, row_count, uploaded_by, uploaded_at, rid FROM uploads WHERE src = ? AND rid = ? ORDER BY id DESC LIMIT 1').bind(src, r).first<Row>()) ?? null;
  const out: { src: string; own: Row | null; shared: Row | null; rows: number; uses: 'own' | 'shared' | 'none'; missing?: string[] }[] = [];
  for (const src of ['plan', 'zmmbe', 'zinr', 'zcoment', 'korber', 'zroll', 'ztrr']) {
    const own = rid ? await last(src, rid) : null;
    const shared = src === 'plan' ? null : await last(src, '');
    const table = src === 'zmmbe' ? 'stock' : src;
    const scope = src === 'plan' ? rid : src === 'zmmbe' ? sc.stock : sc[src as ReportTable];
    const rows = src === 'plan'
      ? Number((await env.DB.prepare('SELECT COUNT(*) n FROM plan WHERE week = ?').bind(rid).first<{ n: number }>())?.n ?? 0)
      : Number((await env.DB.prepare(`SELECT COUNT(*) n FROM ${table} WHERE rid = ?${src === 'zmmbe' ? " AND src = 'zmmbe'" : ''}`).bind(scope).first<{ n: number }>())?.n ?? 0);
    // a Pick's own Korber keeps only its plan's items: items added to the plan after it was uploaded have no rolls in it
    let missing: string[] | undefined;
    if (src === 'korber' && own && rid) {
      missing = (await env.DB.prepare(`SELECT DISTINCT p.item FROM plan p WHERE p.week = ?1 AND NOT EXISTS (SELECT 1 FROM korber k WHERE k.rid = ?1 AND k.item = p.item) LIMIT 20`).bind(rid).all<{ item: string }>()).results.map((x) => String(x.item));
    }
    out.push({ src, own, shared, rows, uses: own ? 'own' : shared && rows ? 'shared' : 'none', ...(missing?.length ? { missing } : {}) });
  }
  return out;
}

/** GET /api/rounds?day=yyyy-mm-dd[&plant=] — the day plan rounds (Pick 1, 2 …) already uploaded for that day, per plant. */
/**
 * Balance follow-up (master, every day / Pick / user): a plan line where less than its QTY was picked is followed until the
 * balance is picked. "Add to Pick" puts the balance into a Pick as a line of its own (follow_of = the original line); its picks
 * count for the original. Closed by hand (with a note) or done when the balance is 0.
 *   GET  /api/follow?state=open|closed|all
 *   POST /api/follow {action: 'add', ref, rid} · {action: 'close', ref, note} · {action: 'reopen', ref}
 */
async function handleFollow(env: Env, req: Request) {
  const sp = new URL(req.url).searchParams;
  // GET /api/follow?check=<rid>: can the open balances be picked from that Pick's reports (ZMMBE UR, ZINSR, ZCOMENT, Korber, ZROLLMGT)?
  if (req.method === 'GET' && parseRound(sp.get('check'))) {
    await requireUser(env, req);
    const rid = String(sp.get('check'));
    let items: { ref: string; bal: number }[] = [];
    try { items = (JSON.parse(sp.get('items') || '[]') as { ref: string; bal: number }[]).filter((x) => x && typeof x.ref === 'string').slice(0, 60); } catch { throw new HttpError(400, 'Bad list.'); }
    const sc = await scopeOf(env, rid);
    const senv = scopedEnv(env, sc);
    // the ZMMBE UR is as of its upload: what was picked for the SO line since then is no longer UR
    const zAt = (await env.DB.prepare("SELECT MAX(uploaded_at) at FROM uploads WHERE src = 'zmmbe' AND rid = ?").bind(sc.stock).first<{ at: string | null }>())?.at ?? '';
    const out: Row[] = [];
    for (const { ref: r0, bal: bal0 } of items) {
      const [wk, so, li, item, date] = r0.split('|');
      const orig = await env.DB.prepare('SELECT * FROM plan WHERE week = ? AND key = ? AND COALESCE(date, \'\') = ? AND follow_of IS NULL').bind(wk, `${so}|${li}|${item}`, date ?? '').first<Row>();
      if (!orig) continue;
      const bal = Number(bal0) || 0;
      try {
        // the balance as a line of that Pick (no picks of its own yet): what to pick = the balance, at most the UR
        const c = await pickCandidates(senv, rid, String(orig.key), `~follow~${r0}`, { so: orig.so, li: orig.li, item: orig.item, qty: bal > 0 ? bal : orig.qty, plant: orig.plant, date: parseRound(rid)!.day });
        const avail = r3(Number(c.matchedAvail) + Number(c.nbAvail));
        const since = zAt ? Number((await env.DB.prepare("SELECT COALESCE(SUM(qty), 0) q FROM picks WHERE cancelled_at IS NULL AND line LIKE ? || '|%' AND at > ?").bind(String(orig.key), zAt).first<{ q: number }>())?.q ?? 0) : 0;
        const urLeft = Math.max(0, r3(Number(c.ur) - since));
        c.need = r3(Math.min(bal > 0 ? bal : Number(orig.qty), urLeft));
        const rolls = c.rolls.filter((x) => x.available > 1e-9 && (!x.pool || x.suggested)).length + (c.nobarcode || []).filter((m) => !m.done).length;
        const can = r3(Math.min(Number(c.need), avail));
        const why = !c.stock.length ? 'Not in this Pick\'s ZMMBE' : urLeft <= 1e-9 ? (since > 0 ? 'No UR left (picked since the ZMMBE upload)' : 'No UR in ZMMBE') : !c.lots.length ? 'No ZINSR lot' : avail <= 1e-9 ? (c.blocked?.length ? `No roll — ${c.blocked.length} not pickable (ZROLLMGT)` : 'No Korber roll') : null;
        out.push({ ref: r0, ur: urLeft, picked_since: r3(since), need: c.need, avail, can, rolls, blocked: c.blocked?.length ?? 0, status: why ? 'none' : can >= (bal || Number(orig.qty)) - 0.0005 ? 'ok' : 'part', why });
      } catch (e) { out.push({ ref: r0, status: 'none', why: e instanceof Error ? e.message : 'Check failed' }); }
    }
    return json({ rid, check: out });
  }
  const ref = (r: Row) => `${r.week}|${r.key}|${r.date ?? ''}`;
  // picks per plan line (week + line); follow-up lines and their picks per original line
  const followData = async () => {
    const picks = (await env.DB.prepare(`SELECT week, line, SUM(qty) q, COUNT(*) n, MAX(at) last, MAX(day) day FROM picks WHERE cancelled_at IS NULL GROUP BY week, line`).all<Row>()).results;
    const pk = new Map(picks.map((x) => [`${x.week}|${x.line}`, x]));
    const kids = (await env.DB.prepare('SELECT week, key, date, qty, follow_of FROM plan WHERE follow_of IS NOT NULL').all<Row>()).results;
    return { pk, kids };
  };
  if (req.method === 'GET') {
    await requireUser(env, req);
    const state = sp.get('state') || 'open';
    const { pk, kids } = await followData();
    // the original lines that were picked (picked short); follow-up lines themselves are counted under their original
    const lines = (await env.DB.prepare(`SELECT p.week, p.key, p.date, p.so, p.li, p.item, p.qty, p.plant, p.owner, p.plan_type, ls.status
      FROM plan p LEFT JOIN line_status ls ON ls.key = ${SK('p')} WHERE p.follow_of IS NULL`).all<Row>()).results;
    const closed = new Map((await env.DB.prepare('SELECT * FROM follow_close').all<Row>()).results.map((x) => [String(x.ref), x]));
    const shortClosed = new Set((await env.DB.prepare('SELECT week, line FROM pick_req WHERE cancelled_at IS NULL AND closed = 1').all<Row>()).results.map((x) => `${x.week}|${x.line}`));
    const out: Row[] = [];
    for (const l of lines) {
      const own = pk.get(`${ref(l).split('|')[0]}|${l.key}|${l.date ?? ''}`);
      if (!own) continue; // never picked: not "sent less" yet
      const r = ref(l);
      const mine = kids.filter((k) => k.follow_of === r);
      const kidPicked = mine.reduce((t, k) => t + Number(pk.get(`${k.week}|${k.key}|${k.date ?? ''}`)?.q ?? 0), 0);
      const picked = r3(Number(own.q) + kidPicked);
      const balance = r3(Number(l.qty) - picked);
      if (balance <= 0.0005) continue;
      const cl = closed.get(r);
      const isClosed = !!cl || /\bdone\b/i.test(String(l.status ?? ''));
      if (state === 'open' && isClosed) continue;
      if (state === 'closed' && !isClosed) continue;
      const last = [own, ...mine.map((k) => pk.get(`${k.week}|${k.key}|${k.date ?? ''}`)).filter(Boolean)].map((x) => String((x as Row).last)).sort().pop();
      out.push({ ref: r, week: l.week, plan: periodLabel(l.week), date: l.date, so: l.so, li: l.li, item: l.item, plant: l.plant, owner: l.owner, qty: l.qty, picked, balance,
        first_picked: own.day, closed_short: shortClosed.has(`${l.week}|${l.key}|${l.date ?? ''}`), last_at: last, rolls: Number(own.n), in_picks: mine.map((k) => ({ plan: periodLabel(k.week), week: k.week, qty: k.qty, picked: r3(Number(pk.get(`${k.week}|${k.key}|${k.date ?? ''}`)?.q ?? 0)) })),
        closed: isClosed, closed_note: cl ? cl.note : /\bdone\b/i.test(String(l.status ?? '')) ? 'Completed by hand' : null, closed_by: cl?.by_user ?? null, closed_at: cl?.at ?? null });
    }
    out.sort((a, b) => String(b.last_at).localeCompare(String(a.last_at)));
    return json({ follow: out });
  }
  const s = await requireUser(env, req, 'editor');
  const b = (await req.json()) as { action?: string; ref?: string; rid?: string; note?: string };
  const r0 = String(b.ref || '');
  const [wk, so, li, item, date] = r0.split('|');
  const orig = await env.DB.prepare('SELECT * FROM plan WHERE week = ? AND key = ? AND COALESCE(date, \'\') = ? AND follow_of IS NULL').bind(wk, `${so}|${li}|${item}`, date ?? '').first<Row>();
  if (!orig) throw new HttpError(404, 'That plan line is no longer there.');
  if (b.action === 'close' || b.action === 'reopen') {
    await env.DB.batch([
      b.action === 'close' ? env.DB.prepare('INSERT OR REPLACE INTO follow_close (ref, note, by_user, at) VALUES (?,?,?,?)').bind(r0, txt(b.note) || 'Closed', s.u, now()) : env.DB.prepare('DELETE FROM follow_close WHERE ref = ?').bind(r0),
      env.DB.prepare('INSERT INTO activity (at, username, action, detail) VALUES (?,?,?,?)').bind(now(), s.u, 'follow', `${b.action === 'close' ? 'Closed' : 'Reopened'} the balance of ${orig.so} / ${orig.li} / ${orig.item} (${periodLabel(wk)})${b.note ? ' — ' + b.note : ''}`),
    ]);
    await broadcast(env, { type: 'data', src: 'plan', by: s.u, rows: 0 });
    return json({ ok: true });
  }
  if (b.action !== 'add') throw new HttpError(400, 'Unknown action.');
  const rnd = parseRound(b.rid);
  if (!rnd) throw new HttpError(400, 'Choose the Pick to add the balance to.');
  // the open balance now
  const { pk, kids } = await followData();
  const own = Number(pk.get(`${wk}|${orig.key}|${orig.date ?? ''}`)?.q ?? 0);
  const kidPicked = kids.filter((k) => k.follow_of === r0).reduce((t, k) => t + Number(pk.get(`${k.week}|${k.key}|${k.date ?? ''}`)?.q ?? 0), 0);
  // what is already planned for it in other Picks and not picked yet
  // (a follow-up line that was picked already does not hold any more balance: what it left is the balance again)
  const kidOpen = kids.filter((k) => k.follow_of === r0 && !pk.get(`${k.week}|${k.key}|${k.date ?? ''}`)).reduce((t, k) => t + Number(k.qty), 0);
  const bal = r3(Number(orig.qty) - own - kidPicked - kidOpen);
  if (bal <= 0.0005) throw new HttpError(409, kidOpen > 0 ? 'The balance is already in another Pick (not picked yet).' : 'There is no balance left.');
  const rid = String(b.rid);
  if (await env.DB.prepare('SELECT 1 FROM plan WHERE week = ? AND key = ?').bind(rid, orig.key).first()) throw new HttpError(409, `${orig.so} / ${orig.li} / ${orig.item} is already in ${periodLabel(rid)}.`);
  await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO plan_day (day, created_by, created_at) VALUES (?,?,?)').bind(rnd.day, s.u, now()),
    env.DB.prepare('INSERT OR IGNORE INTO pick_round (rid, day, plant, round, created_by, created_at) VALUES (?,?,?,?,?,?)').bind(rid, rnd.day, rnd.plant, rnd.round, s.u, now()),
    env.DB.prepare(`INSERT INTO plan (key, so, li, item, date, week, qty, plant, remarks, row_no, src_user, src_at, owner, plan_type, follow_of)
      VALUES (?,?,?,?,?,?,?,?,?, (SELECT COALESCE(MAX(row_no), 0) + 1 FROM plan WHERE week = ?), ?, ?, ?, 'day', ?)`)
      .bind(orig.key, orig.so, orig.li, orig.item, rnd.day, rid, bal, rnd.plant || orig.plant, `Balance of ${periodLabel(wk)} (${orig.qty} − picked ${r3(own + kidPicked)})`, rid, s.u, now(), orig.owner ?? s.u, r0),
    env.DB.prepare('INSERT INTO activity (at, username, action, detail) VALUES (?,?,?,?)').bind(now(), s.u, 'follow', `Balance ${bal} of ${orig.so} / ${orig.li} / ${orig.item} (${periodLabel(wk)}) added to ${periodLabel(rid)}`),
    env.DB.prepare("DELETE FROM config WHERE k IN ('c_counts', 'c_weeks') OR k LIKE 'c_weeks:%'"),
  ]);
  await broadcast(env, { type: 'data', src: 'plan', by: s.u, rows: 1 });
  return json({ ok: true, qty: bal, rid });
}

/**
 * GET /api/zroll?rid=&q=&state=all|ok|bin|nozc|nokorber&limit= — the Pick's ZROLLMGT (else the shared one), each roll with the
 * pick checks: StorageBin = EXPO-FIX (settings), Barcode Number in ZCOMENT VIEW, Korber Pallet (Pick Id 0), picked so far.
 */
/**
 * GET /api/plan-report?rid= — the Pick's plan report ("ASIALLINE-23"), every column worked out from its reports:
 *   AVAILABLE      = SO UR stock (Total − SO QI − SO Blocked) of the line in ZMMBE, every storage location
 *   ALRADY SEND    = the same at the plant storage locations (Settings → Locations: 40, 70, 75 — the stock is in the plant)
 *   Pending        = QTY − ALRADY SEND
 *   POSIBAL PENDING = Pending, when it is more than 0 and the warehouse has UR of it (AVAILABLE − ALRADY SEND > 0)
 *   QI / BLOCK     = SO QI / SO Blocked stock (every storage location)
 *   TRANSFER NOTE  = ZMM_TRR Transfer Request Number of To Sales Order + Item + Material
 */
async function handlePlanReport(env: Env, req: Request) {
  await requireUser(env, req);
  const sp0 = new URL(req.url).searchParams;
  const rid = String(sp0.get('rid') || '');
  // a Pick (day plan round) or a week plan (2026-W43, optionally one plant of it)
  const isWeek = /^\d{4}-W\d{2}$/.test(rid);
  const wPlant = isWeek ? String(sp0.get('plant') || '').trim().toUpperCase() : '';
  const rnd = isWeek ? null : parseRound(rid);
  if (!rnd && !isWeek) throw new HttpError(400, 'Choose a Pick or a week.');
  const senv = await envFor(env, rid);
  const lines = (await env.DB.prepare(`SELECT key, so, li, item, date, COALESCE(plan_date, date) AS plan_date, qty, row_no, plant, remarks FROM plan WHERE week = ?1
    ${isWeek ? "AND plan_type = 'week' AND (?2 = '' OR upper(COALESCE(plant, '')) = ?2)" : ''} ORDER BY ${isWeek ? 'date, ' : ''}row_no`).bind(...(isWeek ? [rid, wPlant] : [rid])).all<Row>()).results;
  const plantCode = rnd ? rnd.plant : wPlant || (new Set(lines.map((l) => up(l.plant))).size === 1 ? up(lines[0]?.plant) : '');
  const pi = plantCode ? await env.DB.prepare('SELECT name FROM plant_info WHERE upper(code) = ?').bind(plantCode.toUpperCase()).first<{ name: string | null }>() : null;
  const plantName = (pi?.name || plantCode || '').toUpperCase().replace(/\s+/g, '');
  const name = rnd ? `${plantName || 'PLAN'}-${rnd.day.slice(8, 10)}` : `${plantName ? plantName + '-' : 'WEEK-'}${rid.slice(5)}`;
  const firstDay = rnd ? rnd.day : lines.map((l) => String(l.date ?? '')).filter(Boolean).sort()[0] ?? '';
  const SO_UR = "COALESCE(total - COALESCE(qi, 0) - COALESCE(block, 0), ur)";
  const st = new Map((await senv.DB.prepare(`SELECT key, ROUND(SUM(${SO_UR}), 3) avail, ROUND(SUM(CASE WHEN src = 'sent' THEN ${SO_UR} ELSE 0 END), 3) sent,
      ROUND(SUM(COALESCE(qi, 0)), 3) qi, ROUND(SUM(COALESCE(block, 0)), 3) block, ROUND(SUM(CASE WHEN src = 'zmmbe' THEN ur ELSE 0 END), 3) wh_ur
    FROM (SELECT src, key, total, qi, block, ur FROM stock WHERE src = 'zmmbe' UNION ALL SELECT src, key, total, qi, block, ur FROM stock_sent) WHERE key IN (SELECT key FROM plan WHERE week = ?) GROUP BY key`).bind(rid).all<Row>()).results.map((x) => [String(x.key), x]));
  const tn = new Map<string, Row>();
  for (const x of (await senv.DB.prepare(`SELECT to_so, to_li, material, GROUP_CONCAT(DISTINCT tn) tn, ROUND(SUM(qty), 3) tn_qty, ROUND(SUM(tqty), 3) tn_tqty, GROUP_CONCAT(DISTINCT status) tn_status FROM ztrr GROUP BY to_so, to_li, material`).all<Row>()).results)
    tn.set(`${x.to_so}|${x.to_li}|${x.material}`, x);
  // picks after the latest ZMMBE upload are not in its ALRADY SEND yet (the same rule as the pick's "to pick")
  const zAt = (await env.DB.prepare("SELECT MAX(uploaded_at) at FROM uploads WHERE src = 'zmmbe' AND rid IN (?1, '') ORDER BY (rid = ?1) DESC").bind(rid).first<{ at: string | null }>())?.at ?? '';
  const pk = new Map((await env.DB.prepare('SELECT line, ROUND(SUM(qty), 3) q, ROUND(SUM(CASE WHEN at > ?2 THEN qty ELSE 0 END), 3) qa, COUNT(*) n FROM picks WHERE week = ?1 AND cancelled_at IS NULL GROUP BY line').bind(rid, zAt).all<Row>()).results.map((x) => [String(x.line), x]));
  const hasSent = !!(await senv.DB.prepare("SELECT 1 FROM stock_sent LIMIT 1").first());
  const zm = !!(await senv.DB.prepare("SELECT 1 FROM stock WHERE src = 'zmmbe' LIMIT 1").first());
  const rows = lines.map((l) => {
    const x = st.get(String(l.key)), t = tn.get(String(l.key)), p0 = pk.get(`${l.key}|${l.date ?? ''}`);
    const avail = Number(x?.avail ?? 0), sent = Number(x?.sent ?? 0), qty = Number(l.qty);
    const pending = r3(qty - sent);
    const possible = pending > 1e-4 && avail - sent > 1e-4 ? pending : null;
    // the balance still to send: QTY − ALRADY SEND − the picks the ZMMBE does not show yet
    const pq = p0 ? Number(p0.q) : 0, after = p0 ? Number(p0.qa) : 0, before = Math.max(0, r3(pq - after));
    const left = Math.max(0, r3(qty - Math.max(sent, before) - after));
    return { left, unic: `${l.so}${l.li}${l.item}A`, so: l.so, li: l.li, item: l.item, date: l.plan_date, pick_date: l.date, qty, avail: r3(avail), sent: r3(sent), pending, possible,
      qi: r3(Number(x?.qi ?? 0)), block: r3(Number(x?.block ?? 0)), tn: t?.tn ?? null, tn_qty: t ? Number(t.tn_qty) : null, tn_status: t?.tn_status ?? null,
      wh: r3(avail - sent), wh_ur: r3(Number(x?.wh_ur ?? 0)), picked: p0 ? Number(p0.q) : 0, rolls: p0 ? Number(p0.n) : 0, key: l.key, plant: l.plant, remarks: l.remarks };
  });
  const sum = (f: (r: typeof rows[number]) => number) => r3(rows.reduce((t0, r) => t0 + f(r), 0));
  const weekPlants = isWeek ? (await env.DB.prepare("SELECT DISTINCT upper(COALESCE(plant, '')) p FROM plan WHERE week = ? AND plan_type = 'week' ORDER BY 1").bind(rid).all<{ p: string }>()).results.map((x) => x.p).filter(Boolean) : [];
  return json({ rid, name, day: firstDay, plant: plantCode || null, week: isWeek, plants: weekPlants, hasZmmbe: zm, hasSent, hasTrr: tn.size > 0, rows,
    totals: { lines: rows.length, qty: sum((r) => r.qty), avail: sum((r) => r.avail), sent: sum((r) => r.sent), pending: sum((r) => Math.max(0, r.pending)), possible: sum((r) => r.possible ?? 0),
      possibleLines: rows.filter((r) => r.possible).length, qi: sum((r) => r.qi), block: sum((r) => r.block), tnLines: rows.filter((r) => r.tn).length, picked: sum((r) => r.picked) } });
}

async function handleZroll(env: Env, req: Request) {
  await requireUser(env, req);
  const sp = new URL(req.url).searchParams;
  const rid = scopeRid(sp.get('rid'));
  const senv = await envFor(env, rid);
  const st = await getSettings(env);
  const bin = up(st.pickBin || 'EXPO-FIX').replace(/\s+/g, '');
  const q = up(sp.get('q')).trim();
  const state = sp.get('state') || 'all';
  const limit = Math.max(1, Math.min(2000, Number(sp.get('limit')) || 500));
  const hasStatus = !!(await senv.DB.prepare("SELECT 1 FROM zroll WHERE COALESCE(status, '') <> '' LIMIT 1").first());
  const K = "(k.pallet = z.barcode OR (z.pcore IS NOT NULL AND k.pcore = z.pcore))";
  const cte = `WITH x AS (SELECT z.barcode, z.bin, z.material, z.batch, z.qty, z.uom, z.sloc, z.plant, z.so, z.li, z.status,
      replace(upper(COALESCE(z.bin, '')), ' ', '') = ?1 AS bin_at,
      (?4 = 0 OR replace(replace(upper(COALESCE(z.status, '')), ' ', ''), '-', '') IN ('UR', 'UNRESTRICTED', 'UNRESTRICTEDUSE', 'UNRESTRICTEDSTOCK', 'UNREST')) AS st_ok,
      (SELECT s.so || ' / ' || s.li FROM stock s WHERE s.src = 'zmmbe' AND s.batch = z.batch AND s.ur > 0 LIMIT 1) AS zm_line,
      (SELECT c.lot FROM zcoment c WHERE c.barcode = z.barcode LIMIT 1) AS zc_lot,
      (SELECT c.batch FROM zcoment c WHERE c.barcode = z.barcode LIMIT 1) AS zc_batch,
      (SELECT c.shade FROM zcoment c WHERE c.barcode = z.barcode LIMIT 1) AS zc_shade,
      (SELECT k.pallet FROM korber k WHERE ${K} LIMIT 1) AS k_pallet,
      (SELECT k.qty FROM korber k WHERE ${K} LIMIT 1) AS k_qty,
      (SELECT k.item FROM korber k WHERE ${K} LIMIT 1) AS k_item,
      (SELECT COALESCE(NULLIF(k.pick_id, ''), '0') FROM korber k WHERE ${K} LIMIT 1) AS k_pick,
      (SELECT ROUND(SUM(p.qty), 3) FROM picks p WHERE p.pallet = z.barcode AND p.cancelled_at IS NULL) AS picked,
      EXISTS (SELECT 1 FROM pick_reject r WHERE r.pallet = z.barcode) AS rejected
    FROM zroll z WHERE (?2 = '' OR z.barcode LIKE '%' || ?2 || '%' OR z.material LIKE '%' || ?2 || '%' OR z.batch LIKE '%' || ?2 || '%' OR upper(COALESCE(z.bin, '')) LIKE '%' || ?2 || '%' OR upper(COALESCE(z.status, '')) LIKE '%' || ?2 || '%')),
    y AS (SELECT *, (bin_at AND st_ok) AS bin_ok FROM x)`;
  const sum = await senv.DB.prepare(`${cte} SELECT COUNT(*) n, SUM(bin_at) bin, SUM(st_ok) st, SUM(zm_line IS NOT NULL) zm, SUM(zc_lot IS NOT NULL) zc, SUM(k_qty IS NOT NULL) korber,
      SUM(bin_ok AND k_qty IS NOT NULL AND k_pick = '0' AND NOT rejected) ok,
      SUM(bin_ok AND k_qty IS NOT NULL AND k_pick = '0' AND NOT rejected AND COALESCE(picked, 0) < k_qty - 0.0005) open FROM y`).bind(bin, q, 0, hasStatus ? 1 : 0).first<Row>();
  const where = state === 'ok' ? "bin_ok AND k_qty IS NOT NULL AND k_pick = '0' AND NOT rejected" : state === 'bin' ? 'NOT bin_at' : state === 'status' ? 'NOT st_ok'
    : state === 'nozm' ? 'zm_line IS NULL' : state === 'nozc' ? 'zc_lot IS NULL' : state === 'nokorber' ? 'k_qty IS NULL' : '1';
  const rows = (await senv.DB.prepare(`${cte} SELECT * FROM y WHERE ${where} ORDER BY bin_ok DESC, barcode LIMIT ?3`).bind(bin, q, limit, hasStatus ? 1 : 0).all<Row>()).results;
  const upl = await env.DB.prepare("SELECT file_name, row_count, uploaded_by, uploaded_at, rid FROM uploads WHERE src = 'zroll' AND rid IN (?1, '') ORDER BY (rid = ?1) DESC, id DESC LIMIT 1").bind(rid).first<Row>();
  return json({ rid, bin, hasStatus, gate: st.rollGate !== false, upload: upl ?? null, summary: sum, rows });
}

async function handleRounds(env: Env, req: Request) {
  const sp = new URL(req.url).searchParams;
  // POST {day, plant}: a new Pick of that plant on that day (the next Pick No)
  if (req.method === 'POST') {
    const s = await requireUser(env, req, 'editor');
    const b = (await req.json()) as { day?: string; plant?: string };
    const day = normDate(b.day);
    if (!day) throw new HttpError(400, 'Choose the day.');
    const plant = cleanPlant(b.plant);
    if (!plant) throw new HttpError(400, 'Choose the plant of the Pick.');
    const max = Number((await env.DB.prepare(`SELECT MAX(n) m FROM (SELECT round n FROM pick_round WHERE day = ?1 AND upper(COALESCE(plant, '')) = ?2
      UNION ALL SELECT CAST(substr(week, 12 + instr(substr(week, 12), '~')) AS INTEGER) FROM plan WHERE plan_type = 'day' AND date = ?1 AND upper(COALESCE(plant, '')) = ?2 AND instr(week, '~') > 0)`).bind(day, plant).first<{ m: number | null }>())?.m ?? 0);
    const n = max + 1, rid = roundId(day, plant, n);
    await env.DB.batch([
      env.DB.prepare('INSERT OR IGNORE INTO plan_day (day, created_by, created_at) VALUES (?,?,?)').bind(day, s.u, now()),
      env.DB.prepare('INSERT OR IGNORE INTO pick_round (rid, day, plant, round, created_by, created_at) VALUES (?,?,?,?,?,?)').bind(rid, day, plant, n, s.u, now()),
      env.DB.prepare('INSERT INTO activity (at, username, action, detail) VALUES (?,?,?,?)').bind(now(), s.u, 'pick-round', `Created ${periodLabel(rid)}`),
    ]);
    await broadcast(env, { type: 'data', src: 'plan', by: s.u, rows: 0 });
    return json({ ok: true, rid, day, plant, round: n });
  }
  // DELETE ?rid= (Admin / Head): a Pick with its plan and its own reports; not when picks were saved for it
  if (req.method === 'DELETE') {
    const s = await requireUser(env, req, 'editor');
    if (!isBoss(s)) throw new HttpError(403, 'Only Admin or Head can delete a Pick.');
    const rid = String(sp.get('rid') || '');
    if (!parseRound(rid)) throw new HttpError(400, 'Unknown Pick.');
    const n = Number((await env.DB.prepare('SELECT COUNT(*) n FROM pick_req WHERE week = ? AND cancelled_at IS NULL').bind(rid).first<{ n: number }>())?.n ?? 0);
    // ?history=1: the Pick's pick history goes too (its picks, packing lists, rejected rolls, balance follow-up) — Admin / Head
    const withHistory = sp.get('history') === '1';
    if (n && !withHistory) throw new HttpError(409, `${periodLabel(rid)} has ${n} saved pick${n === 1 ? '' : 's'} — cancel them in the pick history first, or delete the Pick with its history.`);
    const rolls = withHistory ? Number((await env.DB.prepare('SELECT COUNT(*) n FROM picks WHERE week = ?').bind(rid).first<{ n: number }>())?.n ?? 0) : 0;
    await env.DB.batch([
      ...(withHistory ? [
        env.DB.prepare('DELETE FROM picks WHERE week = ?').bind(rid),
        env.DB.prepare('DELETE FROM pick_req WHERE week = ?').bind(rid),
        env.DB.prepare('DELETE FROM pick_reject WHERE week = ?').bind(rid),
        env.DB.prepare("DELETE FROM follow_close WHERE ref LIKE ? || '|%'").bind(rid),
        // balance lines of this Pick's lines in other Picks: they stay as lines of their own
        env.DB.prepare("UPDATE plan SET follow_of = NULL WHERE follow_of LIKE ? || '|%'").bind(rid),
      ] : []),
      ...['stock', 'stock_sent', 'zinr', 'zcoment', 'korber', 'zroll', 'ztrr', 'uploads'].map((t) => env.DB.prepare(`DELETE FROM ${t} WHERE rid = ?`).bind(rid)),
      env.DB.prepare("DELETE FROM line_status WHERE key LIKE ? || '#%'").bind(rid),
      env.DB.prepare('DELETE FROM plan WHERE week = ?').bind(rid),
      env.DB.prepare('DELETE FROM pick_round WHERE rid = ?').bind(rid),
      env.DB.prepare('INSERT INTO activity (at, username, action, detail) VALUES (?,?,?,?)').bind(now(), s.u, 'pick-round', `Deleted ${periodLabel(rid)} with its plan and reports${withHistory ? ` and its pick history (${n} pick${n === 1 ? '' : 's'}, ${rolls} roll${rolls === 1 ? '' : 's'})` : ''}`),
      env.DB.prepare("DELETE FROM config WHERE k IN ('c_counts', 'c_pick_counts', 'c_weeks') OR k LIKE 'c_weeks:%'"),
    ]);
    await broadcast(env, { type: 'data', src: 'plan', by: s.u, rows: 0 });
    if (withHistory) await broadcast(env, { type: 'data', src: 'pick', by: s.u, rows: 0 });
    return json({ ok: true, picks: n, rolls });
  }
  // GET ?day=yyyy-mm-dd[&plant=]: the Picks of the day — created ones (no plan yet too) and the ones with a plan; which reports each has
  const { owner } = await viewScope(env, req);
  const day = normDate(sp.get('day'));
  if (!day) throw new HttpError(400, 'Choose a day.');
  const plant = cleanPlant(sp.get('plant'));
  const made = (await env.DB.prepare('SELECT rid AS id, plant, round, created_by, created_at FROM pick_round WHERE day = ?').bind(day).all<Row>()).results;
  const withPlan = (await env.DB.prepare(`SELECT week AS id, MAX(plant) AS plant, COUNT(*) AS lines, ROUND(SUM(qty), 3) AS qty, MAX(src_at) AS src_at, MAX(src_user) AS src_user
    FROM plan WHERE plan_type = 'day' AND date = ?1 AND (?2 IS NULL OR owner = ?2) AND instr(week, '~') > 0 GROUP BY week`).bind(day, owner).all<Row>()).results;
  const own = (await env.DB.prepare("SELECT rid, group_concat(DISTINCT src) srcs FROM uploads WHERE rid LIKE ? || '~%' GROUP BY rid").bind(day).all<{ rid: string; srcs: string }>()).results;
  const ownOf = new Map(own.map((o) => [o.rid, String(o.srcs || '').split(',').filter(Boolean)]));
  const byId = new Map<string, Row>();
  for (const r of made) byId.set(String(r.id), { ...r, lines: 0, qty: 0 });
  for (const r of withPlan) byId.set(String(r.id), { ...(byId.get(String(r.id)) || {}), ...r });
  const rows = Array.from(byId.values()).map((r) => ({ ...r, round: parseRound(r.id)?.round ?? 1, plant: r.plant ?? parseRound(r.id)?.plant ?? null, reports: ownOf.get(String(r.id)) ?? [] }) as Row & { round: number })
    .filter((r) => !plant || String(r.plant ?? '').toUpperCase() === plant)
    .sort((a, b) => String(a.plant ?? '').localeCompare(String(b.plant ?? '')) || a.round - b.round);
  const next = plant ? Math.max(0, ...rows.map((r) => r.round)) + 1 : 1;
  return json({ day, plant, rounds: rows, next });
}

/** GET /api/days — the days (created, or with a plan), newest first; POST {day} creates one. */
async function handleDays(env: Env, req: Request) {
  if (req.method === 'POST') {
    const s = await requireUser(env, req, 'editor');
    const b = (await req.json()) as { day?: string };
    const day = normDate(b.day);
    if (!day) throw new HttpError(400, 'Choose the day (yyyy-mm-dd).');
    await env.DB.prepare('INSERT OR IGNORE INTO plan_day (day, created_by, created_at) VALUES (?,?,?)').bind(day, s.u, now()).run();
    await broadcast(env, { type: 'data', src: 'plan', by: s.u, rows: 0 });
    return json({ ok: true, day });
  }
  const days = (await env.DB.prepare(`SELECT d.day, (SELECT COUNT(*) FROM pick_round r WHERE r.day = d.day) AS picks, (SELECT COUNT(*) FROM plan p WHERE p.plan_type = 'day' AND p.date = d.day) AS lines
    FROM (SELECT day FROM plan_day UNION SELECT DISTINCT date FROM plan WHERE plan_type = 'day' AND date IS NOT NULL) d ORDER BY d.day DESC LIMIT 120`).all<Row>()).results;
  return json({ days });
}

async function handlePullPlan(env: Env, req: Request) {
  // public: the dashboard can be viewed without signing in (uploads and edits still need a login)
  const { owner } = await viewScope(env, req);
  const sp = new URL(req.url).searchParams;
  // ?type=week (default) or ?type=day: week plans and day plans have their own dashboards
  const ptype = sp.get('type') === 'day' ? 'day' : 'week';
  const weeks = await cached(env, `c_weeks:${owner ?? '*'}:${ptype}`, async () => (await env.DB.prepare(WEEKS_SQL).bind(owner, ptype).all<{ week: string }>()).results);
  let days: Row[] = [];
  let day: string | null = null;
  let week: string | null;
  let prevWeek: string | null = null;
  let rounds: (Row & { round: number })[] = [];
  if (ptype === 'day') {
    days = await cached(env, `c_weeks:${owner ?? '*'}:days`, async () => (await env.DB.prepare(DAYS_SQL).bind(owner).all<Row>()).results);
    const askedDay = sp.get('day');
    const dRow = (askedDay && days.find((d) => d.day === askedDay)) || days.find((d) => String(d.day) <= colomboDay()) || days[days.length - 1];
    day = dRow ? String(dRow.day) : null;
    // the rounds of the day (Pick 1, 2 … per plant); ?round=<id> shows one of them, none = the whole day
    if (day) rounds = (await env.DB.prepare(`SELECT p.week AS id, MAX(p.plant) AS plant, COUNT(*) AS lines, SUM(p.qty) AS qty, MAX(p.src_at) AS src_at, MAX(p.src_user) AS src_user,
        ${DONE_SUM} AS done
      FROM plan p LEFT JOIN line_status ls ON ls.key = ${SK('p')} ${PK_JOIN} WHERE p.plan_type = 'day' AND p.date = ?1 AND (?2 IS NULL OR p.owner = ?2) GROUP BY p.week`).bind(day, owner).all<Row>()).results
      .map((r) => ({ ...r, round: parseRound(r.id)?.round ?? 1 }) as Row & { round: number }).sort((a, b) => String(a.plant ?? '').localeCompare(String(b.plant ?? '')) || a.round - b.round);
    const askedRound = sp.get('round');
    week = askedRound && rounds.some((r) => r.id === askedRound) ? askedRound : null;
  } else {
    const asked = sp.get('week');
    week = asked && weeks.some((w) => w.week === asked) ? asked : weeks[0]?.week ?? null; // default: most recent week
    prevWeek = weeks[weeks.findIndex((w) => w.week === week) + 1]?.week ?? null; // the week before it (weeks are newest first)
  }
  // a day plan: every Pick reads its own reports (ZMMBE, ZINR, ZCOMENT VIEW, Korber; else the shared ones), so the lines are
  // worked out Pick by Pick; a week plan reads the shared reports
  const periods = ptype === 'day' ? (week ? [week] : rounds.map((r) => String(r.id))) : week ? [week] : [];
  const groups: { period: string | null; sc: Scope; env: Env; zAt?: string }[] = [];
  for (const per of ptype === 'day' ? periods : [week]) {
    const sc = await scopeOf(env, per); // a Pick's or a week plan's own reports (else the shared ones)
    // stock "as of": the latest FULL ZMMBE upload of that scope (a part file added to it does not refresh the other rows)
    const zAt = (await env.DB.prepare("SELECT MAX(uploaded_at) at FROM uploads WHERE src = 'zmmbe' AND rid = ? AND COALESCE(mode, '') <> 'add'").bind(sc.stock).first<{ at: string | null }>())?.at ?? undefined;
    groups.push({ period: per, sc, env: scopedEnv(env, sc), zAt });
  }
  // the latest upload of each report this view reads: a Pick's own (else the shared one); the whole day / a week: the shared ones
  // (the whole day, all its Picks: the Pick with the latest ZMMBE — not the old shared uploads)
  const latestG = [...groups].sort((a, b) => String(b.zAt ?? '').localeCompare(String(a.zAt ?? '')))[0];
  const vsc = week ? groups[0]?.sc ?? SHARED : ptype === 'day' && latestG ? latestG.sc : SHARED;
  const uploads = await env.DB.prepare(`SELECT u.src, u.file_name, u.sheet_name, u.row_count, u.uploaded_by, u.uploaded_at, u.rid FROM uploads u
                    JOIN (SELECT src, MAX(id) id FROM uploads WHERE (src IN ('zmmbe', 'kfc', 'pfc', 'plant') AND rid = ?1) OR (src = 'zinr' AND rid = ?2) OR (src = 'zcoment' AND rid = ?3)
                      OR (src = 'korber' AND rid = ?4) OR (src = 'plan' AND rid IN (?5, '')) OR (src NOT IN ('zmmbe', 'kfc', 'pfc', 'plant', 'zinr', 'zcoment', 'korber', 'plan') AND rid = '') GROUP BY src) m ON m.id = u.id`)
    .bind(vsc.stock, vsc.zinr, vsc.zcoment, vsc.korber, ptype === 'day' && week ? week : ptype === 'day' && latestG ? String(latestG.period ?? '') : '').all();
  const counts = { results: await cached(env, 'c_counts', async () => (await env.DB.prepare(`SELECT 'plan' src, COUNT(*) n FROM plan UNION ALL SELECT src, COUNT(*) FROM stock GROUP BY src UNION ALL SELECT 'trr', COUNT(*) FROM trr`).all()).results) };
  const plan: Row[] = [];
  for (const g of groups) {
    const rs = (await g.env.DB.prepare(PULL_PLAN_SQL).bind(g.period, prevWeek, owner, ptype, ptype === 'day' ? day ?? '~none~' : day).all<Row>()).results;
    for (const r of rs) r._zat = g.zAt ?? null;
    // Korber: what is on the shelf for each line — rolls of its ZINR lots (Item + Lot Number = Vendor Batch, same invoice) or
    // its Shade Report barcodes, less what was picked from them (all Picks). "Ready to pull" needs this too (null = no Korber).
    try {
      const keys = Array.from(new Set(rs.map((r) => String(r.key))));
      if (keys.length && (await g.env.DB.prepare('SELECT 1 FROM korber LIMIT 1').first())) {
        const kr = (await g.env.DB.prepare(`WITH lk AS (SELECT DISTINCT value AS key, substr(value, 1, instr(value, '|') - 1) AS so,
            substr(substr(value, instr(value, '|') + 1), 1, instr(substr(value, instr(value, '|') + 1), '|') - 1) AS li,
            substr(substr(value, instr(value, '|') + 1), instr(substr(value, instr(value, '|') + 1), '|') + 1) AS item FROM json_each(?1)),
          zl AS (SELECT lk.key, lk.item, z.lot, upper(z.vendor_batch) vb, upper(z.invoice) inv FROM lk JOIN zinr z ON z.so = lk.so AND z.li = lk.li AND z.material = lk.item),
          kp AS (SELECT zl.key, k.pallet, k.qty FROM zl JOIN korber k ON k.item = zl.item AND upper(k.lot) = zl.vb AND (zl.inv IS NULL OR k.invoice IS NULL OR upper(k.invoice) = zl.inv)
            UNION SELECT zl.key, k.pallet, k.qty FROM zl JOIN zcoment c ON c.lot = zl.lot JOIN korber k ON k.pallet = c.barcode),
          pk AS (SELECT pallet, SUM(qty) q, MAX(roll_qty) base FROM picks WHERE cancelled_at IS NULL AND pallet IN (SELECT pallet FROM kp) GROUP BY pallet)
          SELECT kp.key, ROUND(SUM(MAX(0, COALESCE(pk.base, kp.qty) - COALESCE(pk.q, 0))), 3) AS avail,
            SUM(CASE WHEN COALESCE(pk.base, kp.qty) - COALESCE(pk.q, 0) > 0.0005 THEN 1 ELSE 0 END) AS rolls
          FROM kp LEFT JOIN pk ON pk.pallet = kp.pallet GROUP BY kp.key`).bind(JSON.stringify(keys)).all<{ key: string; avail: number; rolls: number }>()).results;
        const by = new Map(kr.map((x) => [x.key, x]));
        for (const r of rs) { const x = by.get(String(r.key)); r.korber_avail = x ? Number(x.avail) : 0; r.korber_rolls = x ? Number(x.rolls) : 0; }
      }
    } catch { /* pick tables not there yet */ }
    plan.push(...rs);
  }
  const zAt = groups.length === 1 ? groups[0].zAt : undefined;
  // QI / Block released to UR by hand: counts until a newer ZMMBE upload of the line's Pick (which then shows the stock as UR itself)
  const rels = periods.length ? (await env.DB.prepare('SELECT key, qi, block, by_user, at FROM stock_release WHERE week IN (SELECT value FROM json_each(?1))').bind(JSON.stringify(periods)).all<Row>()).results : [];
  const releases: Row[] = [];
  for (const rl of rels) {
    const zr = (plan.find((r) => r.key === rl.key)?._zat as string | null | undefined) ?? zAt;
    const active = !zr || String(rl.at) > zr;
    releases.push({ ...rl, active });
    if (!active) continue;
    for (const r of plan) if (r.key === rl.key) {
      const q = Math.min(Number(rl.qi), Number(r.qi)), b = Math.min(Number(rl.block), Number(r.block));
      r.ur = Math.round((Number(r.ur) + q + b) * 1000) / 1000; r.qi = Number(r.qi) - q; r.block = Number(r.block) - b; r.released = q + b;
      r.variance = Number(r.qty) - Number(r.assigned);
    }
  }
  const assignAll = (await env.DB.prepare('SELECT id, week, item, line, qty, by_user, at FROM dispatch_assign').all<Assign>()).results;
  const assignOf = (w: string | null) => assignAll.filter((a) => a.week === w);
  const plants = (await env.DB.prepare('SELECT code, name, responsible, target, sort FROM plant_info ORDER BY sort, code').all<Row>()).results;
  // received times typed for the week, and for each day of it (day plans)
  const received = ptype === 'day'
    ? (periods.length ? (await env.DB.prepare('SELECT week AS period, code, received FROM plant_received WHERE week IN (SELECT value FROM json_each(?1)) OR week = ?2').bind(JSON.stringify(periods), day).all<Row>()).results : [])
    : week ? (await env.DB.prepare('SELECT week AS period, code, received FROM plant_received WHERE week = ?1 OR week IN (SELECT DISTINCT date FROM plan WHERE week = ?1)').bind(week).all<Row>()).results : [];
  // dispatch, all weeks at once: [week, item] totals
  // qty_after = dispatch first uploaded after the latest ZMMBE: that stock is still in ZMMBE's UR, so it comes off UR here.
  // Dispatch before that ZMMBE is already gone from its UR and is not taken off again.
  // The dispatch file upload is retired: what is picked is what is dispatched (see applyPicks below)
  const dispAll: { week: string; item: string; qty: number; qty_after: number; n: number }[] = [];
  const dispOf = (w: string | null) => dispAll.filter((d) => d.week === w);
  void assignOf;
  const dispatch = allocateDispatch(plan, dispOf(week), [], zAt) as ReturnType<typeof allocateDispatch> & { planLines?: number; elsewhere?: Record<string, string[]> };
  dispatch.planLines = plan.length;
  // for items not in this week's plan: which other weeks have them (helps spot a wrong week or a plan that needs uploading again)
  if (dispatch.unmatched.length) {
    const found = (await env.DB.prepare('SELECT DISTINCT week, item FROM plan WHERE item IN (SELECT value FROM json_each(?1)) AND (?2 IS NULL OR owner = ?2) ORDER BY week DESC')
      .bind(JSON.stringify(dispatch.unmatched.map((i) => normId(i.item))), owner).all<{ week: string; item: string }>()).results;
    dispatch.elsewhere = {};
    for (const f of found) (dispatch.elsewhere[f.item] ||= []).push(f.week);
  }
  // picked QTY per plan line, all weeks (cancelled picks do not count). picked_after = picked after the latest full ZMMBE,
  // still inside ZMMBE's UR, so it comes off UR here; earlier picks are already out of that ZMMBE.
  // qty_after: picked after the ZMMBE the line reads (each Pick has its own) — still inside that ZMMBE's UR, so it comes off UR
  type PickAgg = { week: string; line: string; qty: number; qty_after: number; rolls: number; closed: number; last_at: string | null; reqs: number; auto_qty?: number };
  const pickBy = new Map<string, PickAgg[]>();
  const picksAt = async (z: string | null | undefined) => {
    const k = z ?? '';
    if (!pickBy.has(k)) {
      let rs: PickAgg[] = [];
      try {
        rs = (await env.DB.prepare(`SELECT p.week, p.line, SUM(p.qty) qty, SUM(CASE WHEN ?1 IS NULL OR p.at > ?1 THEN p.qty ELSE 0 END) qty_after, COUNT(*) rolls,
          MAX(COALESCE(r.closed, 0)) closed, MAX(p.at) last_at, COUNT(DISTINCT p.req_id) reqs, SUM(CASE WHEN COALESCE(r.auto, 0) = 1 THEN p.qty ELSE 0 END) auto_qty FROM picks p LEFT JOIN pick_req r ON r.id = p.req_id WHERE p.cancelled_at IS NULL GROUP BY p.week, p.line`).bind(z ?? null).all<PickAgg>()).results;
      } catch { /* pick tables not created yet */ }
      pickBy.set(k, rs);
    }
    return pickBy.get(k)!;
  };
  const pickAll = await picksAt(zAt);
  const picksOf = (w: string | null) => pickAll.filter((x) => x.week === w);
  // UR is stock of the SO / LI / Item, not of one plan line: every pick after the ZMMBE takes from it —
  // also picks of its other lines (another Pick, another day). The full picked QTY counts (a full roll over the plan is gone too).
  for (const g of ptype === 'day' ? groups : [{ period: week, zAt } as { period: string | null; zAt?: string }]) {
    const pa = await picksAt(g.zAt);
    const rs = ptype === 'day' ? plan.filter((r) => r.week === g.period) : plan;
    applyPicks(rs, pa.filter((x) => x.week === g.period));
    const takenAfter = new Map<string, number>();
    for (const x of pa) { const k = String(x.line).slice(0, String(x.line).lastIndexOf('|')); takenAfter.set(k, r3((takenAfter.get(k) ?? 0) + Number(x.qty_after))); }
    for (const r of rs) {
      const t = takenAfter.get(String(r.key)) ?? 0;
      r.ur_take_key = t;
      r.ur_left = Math.max(0, r3(Number(r.ur ?? 0) - t));
    }
  }
  for (const r of plan) delete r._zat;
  dispatch.total = r3(plan.reduce((t, x) => t + Number(x.dispatched || 0), 0));
  // other weeks with picks: work out which of their lines are complete, so the week list and "carried over" agree with the dashboard
  // (a week plan only: a day plan's Picks are listed with their own counts, and every Pick ever would make this grow each day)
  const otherWeeks = ptype === 'day' ? [] : Array.from(new Set(pickAll.map((d) => d.week))).filter((w) => w !== week && weeks.some((x) => x.week === w));
  const complete = new Map<string, Row[]>(); // week → plan rows after allocation
  complete.set(String(week), plan);
  if (otherWeeks.length) {
    const light = (await env.DB.prepare(`SELECT p.row_no, p.key, p.week, p.item, p.date, p.qty, 0 AS ur, ls.status FROM plan p
      LEFT JOIN line_status ls ON ls.key = ${SK('p')} WHERE p.week IN (SELECT value FROM json_each(?1)) AND (?2 IS NULL OR p.owner = ?2) AND p.plan_type = ?3`).bind(JSON.stringify(otherWeeks), owner, ptype).all<Row>()).results;
    for (const w of otherWeeks) { const r = light.filter((x) => x.week === w); allocateDispatch(r, [], []); applyPicks(r, picksOf(w)); complete.set(w, r); }
  }
  const isDoneRow = (r: Row) => /done/i.test(String(r.status ?? '')) || (Number(r.dispatched) > 0 && Number(r.balance) <= 1e-9);
  for (const w of weeks as Row[]) {
    const r = complete.get(String(w.week));
    if (r) { w.done = r.filter(isDoneRow).length; w.dispatched = Math.round(r.reduce((t, x) => t + Number(x.dispatched || 0), 0) * 1000) / 1000; }
  }
  // a line is only "carried over" if last week's line is still open after its dispatch too
  const prevRows = prevWeek ? complete.get(prevWeek) : undefined;
  if (prevRows) {
    const stillOpen = new Set(prevRows.filter((r) => !isDoneRow(r)).map((r) => String(r.key)));
    for (const r of plan) if (r.carried && !stillOpen.has(String(r.key))) r.carried = 0;
  }
  let rev: string | null = null;
  try { rev = (await env.DB.prepare("SELECT v FROM config WHERE k = 'rev'").first<{ v: string }>())?.v ?? null; } catch { /* none yet */ }
  const st = await getSettings(env);
  return json({ type: ptype, day, days, rounds, week, prevWeek, owner, weeks, rev, time: { soliPerHour: st.soliPerHour, lateGraceMin: st.lateGraceMin, defaultTarget: st.defaultTarget }, rows: plan, dispatch, stockAt: zAt ?? null, releases, plants, received, uploads: uploads.results, counts: counts.results, generatedAt: now() });
}

/**
 * Dispatched quantity per item is taken off that item's plan lines, earliest date first
 * (then plan order). Each line gets: dispatched, balance (QTY − dispatched) and ur_left (UR − dispatched).
 * Whatever is left after every line of the item is full is reported as over-dispatched.
 */
/** Picked QTY counts as dispatched on its plan line; picks after the latest ZMMBE also come off UR left. */
function applyPicks(plan: Row[], picks: { week?: string; line: string; qty: number; qty_after: number; rolls: number; closed?: number; last_at?: string | null; reqs?: number; auto_qty?: number }[]) {
  // a pick belongs to its plan line: the period (week / day round) and SO / LI / Item / date
  const byLine = new Map(picks.map((x) => [`${x.week ?? ''}\u0001${x.line}`, x]));
  for (const r of plan) {
    const x = byLine.get(`${r.week ?? ''}\u0001${r.key}|${r.date ?? ''}`);
    r.picked = x ? r3(Number(x.qty)) : 0;
    r.picked_rolls = x ? Number(x.rolls) : 0;
    r.last_pick_at = x?.last_at ?? null;
    r.pick_reqs = x ? Number(x.reqs ?? 0) : 0;
    // picked by "Pick all matched"
    r.auto_picked = x ? r3(Number(x.auto_qty ?? 0)) : 0;
    if (!x) continue;
    const take = Math.min(Number(x.qty), Math.max(0, Number(r.qty) - Number(r.dispatched || 0)));
    r.dispatched = r3(Number(r.dispatched || 0) + take);
    r.balance = Math.max(0, r3(Number(r.qty) - Number(r.dispatched)));
    // a Normal pick that sent a little less on purpose closes the line: the short QTY is not picked later
    if (x.closed && Number(r.balance) > 0) { r.closed_short = r.balance; r.balance = 0; }
    r.ur_take = r3(Number(r.ur_take || 0) + Math.min(take, Number(x.qty_after)));
    r.ur_left = Math.max(0, r3(Number(r.ur ?? 0) - Number(r.ur_take)));
  }
}

/** dispatch_assign.item for "UR left added to Dispatched" (no dispatch file row behind it) */
const UR_LEFT = '#UR';
interface Assign { id: number; week: string; item: string; line: string; qty: number; by_user?: string; at?: string; applied?: number }
function allocateDispatch(plan: Row[], disp: { item: string; qty: number; qty_after?: number; n: number }[], assigns: Assign[] = [], stockAt?: string) {
  const byItem = new Map<string, Row[]>();
  for (const r of plan) {
    r.dispatched = 0; r.balance = Number(r.qty); r.ur_left = Number(r.ur); r.ur_take = 0;
    const k = normId(r.item);
    if (!byItem.has(k)) byItem.set(k, []);
    byItem.get(k)!.push(r);
  }
  const items: { item: string; dispatched: number; allocated: number; over: number; assigned: number; planQty: number; lines: number; complete: number; pallets: number }[] = [];
  for (const d of disp) {
    const lines = (byItem.get(normId(d.item)) || []).slice()
      .sort((a, b) => String(a.date ?? '9999').localeCompare(String(b.date ?? '9999')) || Number(a.row_no) - Number(b.row_no));
    let left = Number(d.qty);
    // the part already out of the latest ZMMBE is used first; only the rest comes off UR
    let before = Math.max(0, Number(d.qty) - Number(d.qty_after ?? d.qty));
    for (const r of lines) {
      if (left <= 1e-9) break;
      const take = Math.min(left, Number(r.qty));
      const takeBefore = Math.min(take, before);
      before -= takeBefore;
      r.dispatched = Math.round(take * 1000) / 1000;
      r.balance = Math.max(0, Math.round((Number(r.qty) - take) * 1000) / 1000);
      r.ur_take = Math.round((take - takeBefore) * 1000) / 1000;
      r.ur_left = Math.max(0, Math.round((Number(r.ur) - Number(r.ur_take)) * 1000) / 1000);
      left -= take;
    }
    const planQty = lines.reduce((s, r) => s + Number(r.qty), 0);
    items.push({
      item: d.item, dispatched: Number(d.qty), allocated: Number(d.qty) - Math.max(0, left), over: Math.max(0, Math.round(left * 1000) / 1000), assigned: 0,
      planQty, lines: lines.length, complete: lines.filter((r) => Number(r.balance) <= 1e-9).length, pallets: d.n,
    });
  }
  // QTY left over (item not in the plan, or more than planned) can be assigned by hand to any plan line
  const byLine = new Map(plan.map((r) => [`${r.key}|${r.date ?? ''}`, r]));
  const r3 = (n: number) => Math.round(n * 1000) / 1000;
  for (const a of assigns.slice().sort((x, y) => x.id - y.id)) {
    const r = byLine.get(a.line);
    a.applied = 0;
    if (!r) continue;
    if (a.item === UR_LEFT) { // the line's UR left, marked as dispatched by hand
      const take = Math.min(Number(a.qty), Number(r.balance));
      if (take <= 1e-9) continue;
      r.dispatched = r3(Number(r.dispatched) + take);
      r.balance = Math.max(0, r3(Number(r.qty) - Number(r.dispatched)));
      if (!stockAt || String(a.at) > stockAt) r.ur_take = r3(Number(r.ur_take) + take);
      r.ur_left = Math.max(0, r3(Number(r.ur) - Number(r.ur_take)));
      r.ur_dispatched = r3(Number(r.ur_dispatched || 0) + take);
      a.applied = r3(take);
      continue;
    }
    const it = items.find((i) => normId(i.item) === normId(a.item));
    if (!it) continue;
    const take = Math.min(Number(a.qty), it.over, Number(r.balance));
    if (take <= 1e-9) continue;
    r.dispatched = r3(Number(r.dispatched) + take);
    r.balance = Math.max(0, r3(Number(r.qty) - Number(r.dispatched)));
    if (!stockAt || String(a.at) > stockAt) r.ur_take = r3(Number(r.ur_take) + take);
    r.ur_left = Math.max(0, r3(Number(r.ur) - Number(r.ur_take)));
    r.assigned_from = a.item;
    it.over = r3(it.over - take); it.assigned = r3(it.assigned + take); it.allocated = r3(it.allocated + take);
    a.applied = r3(take);
  }
  items.sort((a, b) => a.item.localeCompare(b.item));
  const total = items.reduce((s, i) => s + i.dispatched, 0);
  return { total, items, unmatched: items.filter((i) => i.lines === 0 && i.over > 1e-9), leftover: items.filter((i) => i.over > 1e-9), assigns };
}

// ---------------------------------------------------------------- plants, releases, dispatch assignment

/** POST {week, code, received} sets the received time of a plant's plan for a week ("" clears it). */
async function handleReceived(env: Env, req: Request) {
  const s = await requireUser(env, req, 'editor');
  const b = (await req.json()) as { week?: string; code?: string; received?: string | null };
  const code = String(b.code || '').trim().toUpperCase();
  // period: a week (2026-W47) or, for a day plan, the day (2026-11-17)
  if (!b.week || !code || !(/^(\d{4}-W\d{2}|\d{4}-\d{2}-\d{2})$/.test(b.week) || parseRound(b.week))) throw new HttpError(400, 'Choose the week or day and plant.');
  const v = String(b.received ?? '').trim();
  if (!v) await env.DB.prepare('DELETE FROM plant_received WHERE week = ? AND code = ?').bind(b.week, code).run();
  else await env.DB.prepare('INSERT OR REPLACE INTO plant_received (week, code, received, by_user, at) VALUES (?,?,?,?,?)').bind(b.week, code, v.slice(0, 20), s.u, now()).run();
  await broadcast(env, { type: 'data', src: 'plants', by: s.u, rows: 0, weeks: [b.week] });
  return json({ ok: true });
}

async function handlePlants(env: Env, req: Request) {
  if (req.method === 'GET') return json({ plants: (await env.DB.prepare('SELECT code, name, responsible, target, sort FROM plant_info ORDER BY sort, code').all()).results });
  // plants and their target times are system settings: admin only
  const s = await requireUser(env, req, 'admin');
  const b = (await req.json()) as { plants?: { code: string; name?: string; responsible?: string; target?: string; sort?: number }[]; remove?: string[] };
  const stmts: D1PreparedStatement[] = [];
  for (const p of b.plants || []) {
    const code = String(p.code || '').trim().toUpperCase();
    if (!code) continue;
    stmts.push(env.DB.prepare('INSERT OR REPLACE INTO plant_info (code, name, responsible, target, sort) VALUES (?,?,?,?,?)')
      .bind(code, txt(p.name), txt(p.responsible), txt(p.target), Number(p.sort) || 0));
  }
  for (const c of b.remove || []) stmts.push(env.DB.prepare('DELETE FROM plant_info WHERE code = ?').bind(String(c).toUpperCase()));
  if (!stmts.length) throw new HttpError(400, 'Nothing to save.');
  stmts.push(env.DB.prepare('INSERT INTO activity (at, username, action, detail) VALUES (?,?,?,?)').bind(now(), s.u, 'plants', `Plant settings saved (${(b.plants || []).length})`));
  await env.DB.batch(stmts);
  await broadcast(env, { type: 'data', src: 'plants', by: s.u, rows: 0 });
  return json({ ok: true });
}

/** POST {week, lines:[{key, qi, block}]} releases QI / Block to UR; DELETE ?week=&key= undoes it (no key = the whole week). */
async function handleRelease(env: Env, req: Request) {
  const s = await requireUser(env, req, 'editor');
  const url = new URL(req.url);
  if (req.method === 'DELETE') {
    const week = url.searchParams.get('week'), key = url.searchParams.get('key');
    if (!week) throw new HttpError(400, 'Choose a week.');
    await env.DB.prepare(`DELETE FROM stock_release WHERE week = ?${key ? ' AND key = ?' : ''}`).bind(...(key ? [week, key] : [week])).run();
    await broadcast(env, { type: 'data', src: 'release', by: s.u, rows: 0, weeks: [week] });
    return json({ ok: true });
  }
  if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
  const b = (await req.json()) as { week?: string; lines?: { key: string; qi?: number; block?: number }[] };
  if (!b.week || !Array.isArray(b.lines) || !b.lines.length) throw new HttpError(400, 'Choose the lines to release.');
  const at = now();
  const stmts = b.lines.filter((l) => l.key && (num(l.qi) > 0 || num(l.block) > 0)).map((l) =>
    env.DB.prepare('INSERT OR REPLACE INTO stock_release (week, key, qi, block, by_user, at) VALUES (?,?,?,?,?,?)').bind(b.week, l.key, Math.max(0, num(l.qi)), Math.max(0, num(l.block)), s.u, at));
  if (!stmts.length) throw new HttpError(400, 'Nothing to release: those lines have no QI or Block stock.');
  const qty = b.lines.reduce((t, l) => t + Math.max(0, num(l.qi)) + Math.max(0, num(l.block)), 0);
  stmts.push(env.DB.prepare('INSERT INTO activity (at, username, action, detail) VALUES (?,?,?,?)').bind(at, s.u, 'release', `Released ${Math.round(qty * 1000) / 1000} QI/Block to UR on ${stmts.length} line(s), ${b.week}`));
  await env.DB.batch(stmts);
  await broadcast(env, { type: 'data', src: 'release', by: s.u, rows: stmts.length - 1, weeks: [b.week] });
  return json({ ok: true, lines: stmts.length - 1, qty });
}

/** POST {week, item, key, date, qty} assigns left-over dispatch of an item to a plan line; DELETE /api/dispatch/assign/:id removes it. */
async function handleAssign(env: Env, req: Request, id: string) {
  const s = await requireUser(env, req, 'editor');
  if (req.method === 'DELETE') {
    const row = await env.DB.prepare('SELECT week FROM dispatch_assign WHERE id = ?').bind(Number(id)).first<{ week: string }>();
    if (!row) throw new HttpError(404, 'That assignment is already gone.');
    await env.DB.prepare('DELETE FROM dispatch_assign WHERE id = ?').bind(Number(id)).run();
    await broadcast(env, { type: 'data', src: 'dispatch', by: s.u, rows: 0, weeks: [row.week] });
    return json({ ok: true });
  }
  if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
  const b = (await req.json()) as { week?: string; item?: string; key?: string; date?: string | null; qty?: number; lines?: { key: string; date: string | null; qty: number }[] };
  if (b.item === UR_LEFT && Array.isArray(b.lines)) {
    if (!b.week || !b.lines.length) throw new HttpError(400, 'Choose the lines.');
    const list = b.lines.filter((l) => l.key && num(l.qty) > 0);
    const at = now();
    const stmts = list.map((l) => env.DB.prepare('INSERT INTO dispatch_assign (week, item, line, qty, by_user, at) VALUES (?,?,?,?,?,?)').bind(b.week, UR_LEFT, `${l.key}|${l.date ?? ''}`, num(l.qty), s.u, at));
    if (!stmts.length) throw new HttpError(400, 'Those lines have no UR left to add.');
    const qty = list.reduce((t, l) => t + num(l.qty), 0);
    stmts.push(env.DB.prepare('INSERT INTO activity (at, username, action, detail) VALUES (?,?,?,?)').bind(at, s.u, 'dispatch', `UR left added to Dispatched: ${Math.round(qty * 1000) / 1000} on ${list.length} line(s), ${b.week}`));
    for (let i = 0; i < stmts.length; i += 90) await env.DB.batch(stmts.slice(i, i + 90));
    await broadcast(env, { type: 'data', src: 'dispatch', by: s.u, rows: list.length, weeks: [b.week] });
    return json({ ok: true, lines: list.length, qty });
  }
  const qty = num(b.qty);
  if (!b.week || !b.item || !b.key || !(qty > 0)) throw new HttpError(400, 'Choose the dispatch item, a plan line and a QTY above 0.');
  const line = await env.DB.prepare('SELECT so, li, item FROM plan WHERE week = ? AND key = ? AND COALESCE(date, \'\') = ?').bind(b.week, b.key, b.date ?? '').first<Row>();
  if (!line) throw new HttpError(404, 'That plan line is not in this week.');
  await env.DB.batch([
    env.DB.prepare('INSERT INTO dispatch_assign (week, item, line, qty, by_user, at) VALUES (?,?,?,?,?,?)').bind(b.week, normId(b.item), `${b.key}|${b.date ?? ''}`, qty, s.u, now()),
    env.DB.prepare('INSERT INTO activity (at, username, action, detail) VALUES (?,?,?,?)').bind(now(), s.u, 'dispatch', `${b.item === UR_LEFT ? 'UR left added to Dispatched:' : 'Assigned'} ${qty}${b.item === UR_LEFT ? '' : ' of dispatch item ' + normId(b.item)} to ${line.so} / ${line.li} / ${line.item} (${b.week})`),
  ]);
  await broadcast(env, { type: 'data', src: 'dispatch', by: s.u, rows: 1, weeks: [b.week] });
  return json({ ok: true });
}

// ---------------------------------------------------------------- clearing the database (admin)

/** What "Clear database" can empty. Users and sign-in keys are never touched. */
const CLEAR_GROUPS: Record<string, { label: string; tables: string[] }> = {
  plan: { label: 'Day plans (days, Picks, plan lines) + dashboard edits', tables: ['plan', 'line_status', 'plant_received', 'stock_release', 'dispatch_assign', 'pick_round', 'plan_day', 'follow_close'] },
  stock: { label: 'Stock reports (ZMMBE, KFC, PFC, PLANT, TRR)', tables: ['stock', 'stock_sent', 'trr'] },
  pickdata: { label: 'Pick data (ZINR, ZCOMENT VIEW, Korber, ZROLLMGT, ZMM_TRR)', tables: ['zinr', 'zcoment', 'korber', 'zroll', 'ztrr'] },
  picks: { label: 'Pick history + packing lists', tables: ['picks', 'pick_req'] },
  dispatch: { label: 'Old dispatch uploads', tables: ['dispatch'] },
  settings: { label: 'Plant settings', tables: ['plant_info'] },
  history: { label: 'Upload history + activity log', tables: ['uploads', 'activity'] },
};
async function handleClearDb(env: Env, req: Request) {
  const s = await requireUser(env, req, 'admin');
  const b = (await req.json()) as { groups?: string[]; confirm?: string };
  const groups = (b.groups || []).filter((g) => CLEAR_GROUPS[g]);
  if (!groups.length) throw new HttpError(400, 'Choose what to clear.');
  if (String(b.confirm || '').trim().toUpperCase() !== 'CLEAR') throw new HttpError(400, 'Type CLEAR to confirm.');
  const counts: Record<string, number> = {};
  const stmts: D1PreparedStatement[] = [];
  for (const g of groups) for (const t of CLEAR_GROUPS[g].tables) {
    try { counts[t] = (await env.DB.prepare(`SELECT COUNT(*) n FROM ${t}`).first<{ n: number }>())?.n ?? 0; stmts.push(env.DB.prepare(`DELETE FROM ${t}`)); } catch { /* table not created */ }
  }
  if (groups.includes('pickdata')) stmts.push(env.DB.prepare("DELETE FROM config WHERE k = 'korber_header'"));
  stmts.push(env.DB.prepare('INSERT INTO activity (at, username, action, detail) VALUES (?,?,?,?)').bind(now(), s.u, 'clear',
    `Database cleared: ${groups.map((g) => CLEAR_GROUPS[g].label).join('; ')} (${Object.entries(counts).map(([t, n]) => `${t} ${n}`).join(', ')})`));
  await env.DB.batch(stmts);
  await broadcast(env, { type: 'data', src: 'clear', by: s.u, rows: 0 });
  return json({ ok: true, cleared: counts });
}

// ---------------------------------------------------------------- picking: ZINR, ZCOMENT VIEW, Korber inventory

const PICK_SCHEMA = [
  // SAP ZINR: inspection lots (one per batch per SO line)
  `CREATE TABLE IF NOT EXISTS zinr (lot TEXT NOT NULL, plant TEXT, sloc TEXT, batch TEXT, material TEXT, qty REAL, uom TEXT, so TEXT, li TEXT,
     vendor_batch TEXT, invoice TEXT, created TEXT, style TEXT, po TEXT)`,
  'CREATE INDEX IF NOT EXISTS zinr_key ON zinr(so, li, material, batch)',
  // SAP ZCOMENT VIEW, Shade Report rows only: one row per roll of an inspection lot
  `CREATE TABLE IF NOT EXISTS zcoment (lot TEXT NOT NULL, material TEXT, batch TEXT, vendor_batch TEXT, roll_qty REAL, roll_no TEXT, barcode TEXT,
     shade TEXT, sys_roll TEXT, accept TEXT, description TEXT)`,
  'CREATE INDEX IF NOT EXISTS zcoment_lot ON zcoment(lot)',
  'CREATE INDEX IF NOT EXISTS zcoment_barcode ON zcoment(barcode)',
  // Korber inventory (only rolls of items in the plan); raw = the full row as uploaded, for the Korber-format download
  `CREATE TABLE IF NOT EXISTS korber (pallet TEXT NOT NULL, item TEXT, lot TEXT, qty REAL, uom TEXT, invoice TEXT, location TEXT, supplier_hu TEXT,
     status TEXT, raw TEXT, po TEXT, pcore TEXT)`,
  'CREATE INDEX IF NOT EXISTS korber_pallet ON korber(pallet)',

  'CREATE INDEX IF NOT EXISTS korber_item_lot ON korber(item, lot)',
  // one pick request = one "1st / 2nd / 3rd" sheet of the day's packing list
  `CREATE TABLE IF NOT EXISTS pick_req (id INTEGER PRIMARY KEY AUTOINCREMENT, day TEXT NOT NULL, seq INTEGER NOT NULL, pick_no TEXT, week TEXT, line TEXT,
     so TEXT, li TEXT, item TEXT, plant TEXT, need REAL, qty REAL, rolls INTEGER, by_user TEXT, at TEXT, cancelled_at TEXT, cancelled_by TEXT, match TEXT)`,
  'CREATE INDEX IF NOT EXISTS pick_req_day ON pick_req(day)',
  // every roll picked; a roll is never picked twice, a partial pick leaves its balance pickable
  `CREATE TABLE IF NOT EXISTS picks (id INTEGER PRIMARY KEY AUTOINCREMENT, req_id INTEGER NOT NULL, day TEXT, week TEXT, line TEXT, so TEXT, li TEXT, item TEXT,
     pallet TEXT NOT NULL, qty REAL NOT NULL, roll_qty REAL, partial INTEGER DEFAULT 0, shade TEXT, lot TEXT, insp_lot TEXT, batch TEXT, note TEXT,
     by_user TEXT, at TEXT, cancelled_at TEXT, cancelled_by TEXT, korber TEXT)`,
  'CREATE INDEX IF NOT EXISTS picks_pallet ON picks(pallet)',
  'CREATE INDEX IF NOT EXISTS picks_week_line ON picks(week, line)',
  'CREATE INDEX IF NOT EXISTS picks_req ON picks(req_id)',
];

const hnorm = (v: unknown) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
/** Column positions by header name (first match wins: Korber repeats some names at the end). */
function headerIndex(header: unknown[], names: Record<string, string[]>) {
  const h = header.map(hnorm);
  const out: Record<string, number> = {};
  for (const [field, aliases] of Object.entries(names)) out[field] = aliases.map((a) => h.indexOf(hnorm(a))).find((i) => i >= 0) ?? -1;
  return out;
}
const PICK_COLS: Record<'zinr' | 'zcoment' | 'korber' | 'zroll' | 'ztrr', Record<string, string[]>> = {
  // SAP ZMM_TRR (transfer requests): its first "Sales Document Item" is the To SO's item
  ztrr: {
    tn: ['Transfer Request Number', 'TN Number', 'TN No', 'Transfer Note'], tn_date: ['Date in Format YYYYMMSS in 8 Characters', 'Date'], to_so: ['To Sales Order'], to_li: ['Sales Document Item'],
    material: ['Material'], to_plant: ['To Plant'], from_so: ['From Sales Order'], batch: ['Batch'], qty: ['Order Quantity'], approved: ['Inspection Approve Qty'], tqty: ['Transfer Quantity'], status: ['Status'],
  },
  // SAP ZROLLMGT (roll management): where each roll (Barcode Number) is
  zroll: {
    barcode: ['Barcode Number', 'Barcode No', 'Barcode No.', 'Barcode', 'Roll Barcode', 'Roll Barcode Number', 'HU Number', 'Handling Unit'], bin: ['StorageBin', 'Storage Bin', 'Bin', 'Bin Location', 'Storage Bin Location'],
    material: ['Material', 'Material Number', 'Item Code'], batch: ['System Batch', 'System Batch No', 'System Batch Number', 'Sys Batch', 'SAP Batch', 'SAP Batch No', 'Batch No', 'Batch Number', 'Batch'], qty: ['Available Quantity', 'Available Qty', 'Quantity', 'Qty', 'Roll Qty', 'Roll Quantity', 'Length'], uom: ['UoM', 'Unit', 'Base UoM', 'Base Unit of Measure'],
    sloc: ['Storage Location', 'Sloc', 'St Location', 'SLoc'], plant: ['Plant'], so: ['Sales Order', 'SO', 'Sales Document'], li: ['Line Item', 'LI', 'SO Item', 'Item'], status: ['Status', 'Roll Status', 'Stock Status', 'Stock Type', 'Stock Category', 'Stock Cat.'],
  },
  zinr: {
    lot: ['Inspection Lot'], plant: ['Plant'], sloc: ['Storage Location'], batch: ['Batch'], material: ['Material'], qty: ['Insp. Lot Quantity', 'Inspection Lot Quantity'],
    uom: ['Base UoM'], so: ['Sales Order'], li: ['Line Item'], vendor_batch: ['Vendor Batch'], invoice: ['Vendor Invoice No'], created: ['Lot Creation Date'], style: ['Customer Style'],
    po: ['Purchasing Document', 'Purchasing Doc.', 'Purchase Order', 'PO Number'],
  },
  zcoment: {
    // two layouts: the detail export (Inspection lot, Material, System Batch, Report Name, Roll qty.) and the roll view
    // (Inspection #, Batch, Roll No.; no Material — it comes from ZINR — and no Roll qty — Korber's Actual Qty is the QTY)
    lot: ['Inspection lot', 'Inspection #', 'Inspection No', 'Inspection Lot No'], material: ['Material', 'Material #'], batch: ['System Batch', 'Batch'], report: ['Report Name'],
    vendor_batch: ['Vendor Batch'], roll_qty: ['Roll qty.', 'Roll qty'], roll_no: ['Vendor Roll No'], barcode: ['Barcode Number'], shade: ['Shade'],
    sys_roll: ['System Roll No.', 'Roll No.'], accept: ['Accept/Reject'], description: ['Material Description'],
  },
  korber: {
    pallet: ['Pallet'], item: ['Item Number'], display: ['Display Item Number'], lot: ['Lot Number'], qty: ['Actual Qty'], uom: ['Uom'], invoice: ['Invoice Number'], location: ['Location Id'],
    supplier_hu: ['Supplier Hu'], status: ['Status'], po: ['Po Number'], pick_id: ['Pick Id'],
  },
};
const REQUIRED: Record<string, string[]> = { ztrr: ['tn', 'to_so', 'to_li', 'material'], zroll: ['barcode', 'bin'], zinr: ['lot', 'batch', 'material', 'qty', 'so', 'li'], zcoment: ['lot', 'roll_no', 'shade'], korber: ['pallet', 'item', 'lot', 'qty'] };
const PICK_LABEL: Record<string, string> = { ztrr: 'ZMM_TRR', zroll: 'ZROLLMGT', zinr: 'ZINR', zcoment: 'ZCOMENT VIEW', korber: 'Korber inventory' };
const up = (v: unknown) => String(v ?? '').trim().toUpperCase();
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const colomboDay = () => new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);

async function handlePick(env: Env, req: Request, p: string) {
  const url = new URL(req.url);
  const part = p.split('/')[3] || '';

  // items worth keeping from a Korber file: everything in the plan (all weeks) and in the shade reports
  if (part === 'keys' && req.method === 'GET') {
    await requireUser(env, req, 'editor');
    // a Pick's Korber: only the items of that Pick's plan (a Korber file per Pick stays small); no plan yet / shared: every plan item
    const krid = url.searchParams.get('rid');
    if (krid && scopeRid(krid)) {
      const own = (await env.DB.prepare('SELECT DISTINCT item FROM plan WHERE week = ?').bind(krid).all<Row>()).results;
      if (own.length) return json({ items: Array.from(new Set(own.map((r) => normId(r.item)))).filter(Boolean), rid: krid });
    }
    const [a, b] = await env.DB.batch([env.DB.prepare('SELECT DISTINCT item FROM plan'), env.DB.prepare('SELECT DISTINCT material item FROM zcoment')]);
    return json({ items: Array.from(new Set([...a.results, ...b.results].map((r) => normId((r as Row).item)))).filter(Boolean) });
  }

  // what is loaded
  // GET /api/pick/status?rid= — each report of a Pick: its own upload (rows, file, who, when) or the shared one it falls back to
  if (part === 'status' && req.method === 'GET') {
    const rid = scopeRid(url.searchParams.get('rid'));
    const reports = await reportStatus(env, rid);
    // the older shape (counts / uploads of the reports this Pick reads) for the Pick data card
    const counts = reports.filter((r) => r.src !== 'plan').map((r) => ({ src: r.src, n: r.rows }));
    const uploads = reports.map((r) => r.own ?? r.shared).filter(Boolean);
    return json({ rid, reports, counts, uploads });
  }

  // POST {src, header, rows: arrays, fileName, total}: replaces that report
  if (part === 'upload' && req.method === 'POST') {
    const s = await requireUser(env, req, 'editor');
    const b = (await req.json()) as { src: 'zinr' | 'zcoment' | 'korber' | 'zroll' | 'ztrr'; header: unknown[]; rows: unknown[][]; fileName?: string; total?: number; rid?: string };
    if (!PICK_COLS[b.src]) throw new HttpError(400, 'Unknown report.');
    // the Pick this report belongs to ('' = the shared report)
    const rid = scopeRid(b.rid);
    if (rid && parseRound(rid)) { const pr = parseRound(rid)!; await env.DB.batch([env.DB.prepare('INSERT OR IGNORE INTO plan_day (day, created_by, created_at) VALUES (?,?,?)').bind(pr.day, s.u, now()),
      env.DB.prepare('INSERT OR IGNORE INTO pick_round (rid, day, plant, round, created_by, created_at) VALUES (?,?,?,?,?,?)').bind(rid, pr.day, pr.plant, pr.round, s.u, now())]); }
    if (!Array.isArray(b.header) || !Array.isArray(b.rows)) throw new HttpError(400, 'No rows in the upload.');
    const ix = headerIndex(b.header, PICK_COLS[b.src]);
    const missing = REQUIRED[b.src].filter((f) => ix[f] < 0);
    if (missing.length) throw new HttpError(400, `${PICK_LABEL[b.src]}: these columns are missing — ${missing.map((f) => PICK_COLS[b.src][f][0]).join(', ')}.`);
    const g = (r: unknown[], f: string) => (ix[f] >= 0 ? r[ix[f]] : null);
    let rows: Row[] = [];
    let skipped = 0;
    if (b.src === 'zinr') {
      for (const r of b.rows) {
        const lot = normId(g(r, 'lot'));
        if (!lot) { skipped++; continue; }
        rows.push({ lot, plant: txt(g(r, 'plant')), sloc: txt(normId(g(r, 'sloc'))), batch: normId(g(r, 'batch')), material: normId(g(r, 'material')), qty: num(g(r, 'qty')),
          uom: txt(g(r, 'uom')), so: normId(g(r, 'so')), li: normId(g(r, 'li')), vendor_batch: txt(g(r, 'vendor_batch')), invoice: txt(up(g(r, 'invoice'))), created: normDate(g(r, 'created')), style: txt(g(r, 'style')), po: txt(up(g(r, 'po'))) });
      }
    } else if (b.src === 'ztrr') {
      // the second "Sales Document Item" (the From SO's) is next to From Sales Order
      const hn0 = b.header.map(hnorm);
      const fromLi = hn0.findIndex((h, i) => h === 'salesdocumentitem' && i > ix.from_so && ix.from_so >= 0);
      for (const r of b.rows) {
        const tn = txt(g(r, 'tn')), toSo = normId(g(r, 'to_so'));
        if (!tn || !toSo) { skipped++; continue; }
        rows.push({ tn, tn_date: normDate(g(r, 'tn_date')), to_so: toSo, to_li: normId(g(r, 'to_li')), material: korberItem(null, g(r, 'material')), to_plant: txt(g(r, 'to_plant')),
          from_so: normId(g(r, 'from_so')) || null, from_li: fromLi >= 0 ? normId(r[fromLi]) || null : null, batch: normId(g(r, 'batch')) || null,
          qty: num(g(r, 'qty')), approved: num(g(r, 'approved')), tqty: num(g(r, 'tqty')), status: txt(up(g(r, 'status'))), raw: null });
      }
    } else if (b.src === 'zroll') {
      // one row per roll (Barcode Number). SAP lists a roll moved to another plant / batch twice: the old row has Available
      // Quantity 0 — the row with the most Available Quantity (then Status UR) is the live one
      const seen = new Map<string, Row>();
      const better = (a: Row, c: Row) => (Number(c.qty ?? 0) > Number(a.qty ?? 0) + 1e-9) || (Math.abs(Number(c.qty ?? 0) - Number(a.qty ?? 0)) <= 1e-9 && up(c.status) === 'UR' && up(a.status) !== 'UR');
      for (const r of b.rows) {
        const barcode = up(g(r, 'barcode'));
        if (!barcode) { skipped++; continue; }
        const prev = seen.get(barcode);
        const cand: Row = { barcode, pcore: palletCore(barcode), bin: txt(up(g(r, 'bin'))), material: korberItem(null, g(r, 'material')) || null, batch: normId(g(r, 'batch')) || null, qty: ix.qty >= 0 ? num(g(r, 'qty')) : null,
          uom: txt(g(r, 'uom')), sloc: txt(normId(g(r, 'sloc'))), plant: txt(g(r, 'plant')), so: normId(g(r, 'so')) || null, li: normId(g(r, 'li')) || null, status: txt(g(r, 'status')),
          raw: JSON.stringify(Object.fromEntries(b.header.map((h, i) => [String(h ?? ''), r[i] ?? null]).filter(([h, v]) => h && v !== null && v !== ''))) };
        if (prev) skipped++;
        if (!prev || better(prev, cand)) seen.set(barcode, cand);
      }
      rows = Array.from(seen.values());
    } else if (b.src === 'zcoment') {
      for (const r of b.rows) {
        // only the Shade Report rows: one per roll
        if (ix.report >= 0 && hnorm(g(r, 'report')) !== 'shadereport') { skipped++; continue; }
        const lot = normId(g(r, 'lot'));
        if (!lot) { skipped++; continue; }
        rows.push({ lot, material: normId(g(r, 'material')), batch: normId(g(r, 'batch')), vendor_batch: txt(g(r, 'vendor_batch')), roll_qty: num(g(r, 'roll_qty')),
          roll_no: txt(up(g(r, 'roll_no'))), barcode: txt(up(g(r, 'barcode'))), shade: txt(g(r, 'shade')), sys_roll: txt(g(r, 'sys_roll')), accept: txt(g(r, 'accept')), description: txt(g(r, 'description')) });
      }
    } else {
      const seen = new Map<string, Row>();
      for (const r of b.rows) {
        const pallet = up(g(r, 'pallet'));
        if (!pallet) { skipped++; continue; }
        seen.set(pallet, { pallet, item: korberItem(g(r, 'display'), g(r, 'item')), lot: txt(g(r, 'lot')), qty: num(g(r, 'qty')), uom: txt(g(r, 'uom')), invoice: txt(up(g(r, 'invoice'))),
          location: txt(g(r, 'location')), supplier_hu: txt(up(g(r, 'supplier_hu'))), status: txt(g(r, 'status')), po: txt(up(g(r, 'po'))), pcore: palletCore(pallet), raw: JSON.stringify(r),
          // Korber's own Pick Id: a roll is pickable only while it is 0 (another number = already on a WMS pick)
          pick_id: ix.pick_id >= 0 ? (normId(g(r, 'pick_id')) || '0') : '0' });
      }
      rows = Array.from(seen.values());
    }
    if (!rows.length) throw new HttpError(400, `${PICK_LABEL[b.src]}: no usable rows${b.src === 'zcoment' ? ' (only "Shade Report" rows are kept)' : ''}.`);
    // the roll view has no Material: take the inspection lot's from ZINR now (unchanged rows stay unchanged on the next upload)
    if (b.src === 'zcoment' && rows.some((r) => !r.material)) {
      // the Pick's own ZINR first, then the shared one
      const mat = new Map((await env.DB.prepare("SELECT lot, material FROM zinr WHERE rid IN (?1, '') ORDER BY (rid = ?1)").bind(rid).all<{ lot: string; material: string }>()).results.map((z) => [String(z.lot), z.material]));
      for (const r of rows) if (!r.material) r.material = mat.get(String(r.lot)) ?? '';
    }
    for (const r of rows) r.rid = rid;
    const cols = Object.keys(rows[0]);
    // a Pick's report replaces only that Pick's rows; the shared report and the other Picks stay
    const d = await diffReplace(env, b.src, cols, rows, 'rid = ?', [rid], b.src === 'korber' ? 150 : 400);
    const stmts: D1PreparedStatement[] = [...d.stmts];
    if (b.src === 'korber') poIx = null;
    // ZCOMENT rows without Material (the roll view): the inspection lot's material from ZINR — after a ZINR upload too
    if (b.src === 'zcoment' || b.src === 'zinr') stmts.push(env.DB.prepare("UPDATE zcoment SET material = COALESCE((SELECT z.material FROM zinr z WHERE z.lot = zcoment.lot AND z.rid = zcoment.rid LIMIT 1), (SELECT z.material FROM zinr z WHERE z.lot = zcoment.lot AND z.rid = '' LIMIT 1)) WHERE COALESCE(material, '') = '' AND EXISTS (SELECT 1 FROM zinr z WHERE z.lot = zcoment.lot AND z.rid IN (zcoment.rid, ''))"));
    if (b.src === 'korber') stmts.push(env.DB.prepare("INSERT INTO config (k, v) VALUES ('korber_header', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(JSON.stringify(b.header)));
    stmts.push(env.DB.prepare('INSERT INTO uploads (src, file_name, sheet_name, row_count, uploaded_by, uploaded_at, rid) VALUES (?,?,?,?,?,?,?)').bind(b.src, b.fileName || null, null, rows.length, s.u, now(), rid));
    stmts.push(env.DB.prepare('INSERT INTO activity (at, username, action, detail) VALUES (?,?,?,?)').bind(now(), s.u, 'upload',
      `${PICK_LABEL[b.src]}${rid ? ' · ' + periodLabel(rid) : ''}: ${rows.length} rows${b.total && b.total > rows.length ? ` (of ${b.total} in the file)` : ''}${b.fileName ? ' from ' + b.fileName : ''}`));
    await env.DB.batch(stmts);
    await broadcast(env, { type: 'data', src: b.src, by: s.u, rows: rows.length });
    return json({ ok: true, rows: rows.length, skipped, rid });
  }

  // the rolls that can be picked for one plan line, with every check of the chain
  if (part === 'candidates' && req.method === 'GET') {
    await requireUser(env, req, 'editor');
    const week = url.searchParams.get('week') || '', key = url.searchParams.get('key') || '', date = url.searchParams.get('date') || '';
    const line = await env.DB.prepare('SELECT so, li, item, qty, plant, date FROM plan WHERE week = ? AND key = ? AND COALESCE(date, \'\') = ?').bind(week, key, date).first<Row>();
    if (!line) throw new HttpError(404, 'That plan line is not in this week.');
    // the Pick's own ZMMBE / ZINR / ZCOMENT VIEW / Korber (else the shared ones); the pick history is shared by all
    return json(await pickCandidates(await envFor(env, week), week, key, date, line));
  }

  // Korber rolls to choose by hand: same item first; search by pallet, lot or supplier HU; with what is left of each
  if (part === 'korber' && req.method === 'GET') {
    await requireUser(env, req, 'editor');
    const item = normId(url.searchParams.get('item')), qs = up(url.searchParams.get('q'));
    const kenv = await envFor(env, url.searchParams.get('rid'));
    const rows = qs
      ? (await kenv.DB.prepare('SELECT pallet, item, lot, qty, uom, invoice, location, supplier_hu, status, pick_id FROM korber WHERE pallet = ? OR (item = ? AND (upper(lot) LIKE ? OR supplier_hu LIKE ? OR pallet LIKE ? OR upper(invoice) LIKE ?)) LIMIT 80')
        .bind(qs, item, `%${qs}%`, `%${qs}%`, `%${qs}%`, `%${qs}%`).all<Row>()).results
      : (await kenv.DB.prepare('SELECT pallet, item, lot, qty, uom, invoice, location, supplier_hu, status, pick_id FROM korber WHERE item = ? ORDER BY lot, supplier_hu LIMIT 200').bind(item).all<Row>()).results;
    const rej = new Map((await env.DB.prepare('SELECT pallet, reason FROM pick_reject').all<{ pallet: string; reason: string }>()).results.map((x) => [up(x.pallet), x.reason]));
    const gate = await makeGate(kenv);
    for (const r of rows) {
      const pp = await palletPicks(env, r.pallet);
      const base = pp.base ?? Number(r.qty);
      r.picked_before = pp.before;
      // not pickable: on a WMS pick (Korber Pick Id ≠ 0) or rejected
      const wms = String(r.pick_id ?? '0') !== '0' && String(r.pick_id ?? '') !== '';
      r.available = wms || rej.has(up(r.pallet)) ? 0 : Math.max(0, r3(base - pp.before));
      if (wms) r.blocked = `Korber Pick Id ${r.pick_id}`;
      if (rej.has(up(r.pallet))) r.blocked = `Rejected: ${rej.get(up(r.pallet))}`;
      if (!r.blocked) { const why = await gate.check(String(r.pallet), null, false); if (why) { r.blocked = why; r.available = 0; } }
      r.picks = pp.picks;
    }
    // the same cap as the save: ZROLLMGT Available Quantity (a roll with a Reserved part has less)
    if (gate.on) {
      const av = await gate.availOf(rows.filter((r) => !r.blocked).map((r) => String(r.pallet)));
      for (const r of rows) {
        const a = av.get(up(r.pallet));
        if (!r.blocked && a !== undefined && a < Number(r.available) - 1e-6) { r.reserved = r3(Number(r.available) - Math.max(0, a)); r.available = Math.max(0, r3(a)); }
      }
    }
    return json({ rows });
  }

  // POST {week, key, date, pickNo, rolls:[{pallet, qty, confirmed, manual?: {roll_no, barcode, lot, shade, roll_qty}}]}
  if (part === '' && req.method === 'POST') {
    const s = await requireUser(env, req, 'editor');
    const b = (await req.json()) as { week: string; key: string; date: string | null; pickNo?: string; kind?: string; auto?: boolean; overConfirmed?: boolean; closeShort?: boolean; rolls: { pallet: string; qty: number; confirmed?: boolean; manual?: ManualFor; nobarcode?: boolean }[] };
    if (!b.week || !b.key || !Array.isArray(b.rolls) || !b.rolls.length) throw new HttpError(400, 'Choose at least one roll.');
    const kind = b.kind === 'offsite' ? 'offsite' : 'normal';
    const rules = await getSettings(env);
    if (kind === 'offsite' && !rules.allowOffsite) throw new HttpError(400, 'Offsite picks are turned off in the settings.');
    const line = await env.DB.prepare('SELECT so, li, item, qty, plant, date, owner FROM plan WHERE week = ?1 AND key = ?2 AND COALESCE(date, \'\') = ?3 ORDER BY (owner = ?4) DESC LIMIT 1').bind(b.week, b.key, b.date ?? '', s.u).first<Row>();
    if (!line) throw new HttpError(404, 'That plan line is not in this week.');
    if (!isBoss(s) && line.owner && line.owner !== s.u) throw new HttpError(403, `That line is in ${line.owner}'s plan.`);
    // Pick Hold: a held line is not picked until the hold is released
    {
      const sk = statusKey({ plan_type: parseRound(b.week) || /^\d{4}-\d{2}-\d{2}$/.test(b.week) ? 'day' : 'week', week: b.week, date: b.date ?? '', key: b.key });
      const h = await env.DB.prepare('SELECT hold, hold_by, hold_at FROM line_status WHERE key = ? AND hold IS NOT NULL').bind(sk).first<Row>();
      if (h) throw new HttpError(409, `This line is on hold (${h.hold}${h.hold_by ? ` — ${h.hold_by}` : ''}). Release the hold first.`);
    }
    const senv = await envFor(env, b.week); // this Pick's reports
    const cand = await pickCandidates(senv, b.week, b.key, b.date ?? '', line);
    const gate = await makeGate(senv);
    const byPallet = new Map(cand.rolls.map((r) => [r.pallet, r]));
    const lineId = `${b.key}|${b.date ?? ''}`;
    const day = colomboDay(), at = now();
    const picks: Row[] = [];
    // a roll chosen for a shade-report roll with no Barcode Number is one of its offered Korber rolls (not a manual pick)
    // the shade-report roll (or lot without Shade Report) it was chosen for: the same Korber roll can be offered for several
    const nbOption = (pallet: string, mf?: ManualFor) => {
      const all = (cand.nobarcode || []) as Row[];
      const mine = mf ? all.filter((m) => String(m.lot) === String(mf.lot ?? '') && String(m.roll_no ?? '') === String(mf.roll_no ?? '')) : [];
      for (const m of [...mine, ...all]) { const o = (m.options as Row[]).find((x) => up(x.pallet) === up(pallet)); if (o) return { m, o }; }
      return null;
    };
    const isManual = (x: { pallet: string; manual?: ManualFor; nobarcode?: boolean }) => !!x.manual && !byPallet.has(up(x.pallet)) && !(x.nobarcode && nbOption(x.pallet, x.manual));
    const manualQty = r3(b.rolls.filter(isManual).reduce((t, x) => t + num(x.qty), 0));
    // a pallet added by hand fills only the shortage of this pick: what the line still needs after the other rolls chosen
    const otherQty = r3(b.rolls.filter((x) => !isManual(x)).reduce((t, x) => t + num(x.qty), 0));
    const room = Math.max(0, r3(Number(cand.need) - Number(cand.picked) - otherQty));
    if (manualQty > 0 && room <= 1e-9) throw new HttpError(400, 'Manual pallet is only for a shortage: the other rolls of this pick already cover the line.');
    if (manualQty > room + 1e-6) throw new HttpError(400, `Manual pallets can fill only the shortage of ${room} (the line still needs ${r3(Number(cand.need) - Number(cand.picked))}, the other rolls give ${otherQty}).`);
    for (const x of b.rolls) {
      let r = byPallet.get(up(x.pallet));
      const nb = !r && x.nobarcode ? nbOption(x.pallet, x.manual) : null;
      if (!r && x.nobarcode && !nb) throw new HttpError(400, `Roll ${x.pallet} is not one of the Korber rolls offered for a roll with no barcode (refresh and try again).`);
      if (!r && x.manual?.free && !nb) {
        // a manual pallet: its batch = the ZROLLMGT System Batch, else its ZCOMENT roll's batch, else the line's ZMMBE batch with the most UR
        const zb = await gate.batchOf(x.pallet);
        const zc = await senv.DB.prepare('SELECT lot, batch, shade FROM zcoment WHERE barcode = ? LIMIT 1').bind(up(x.pallet)).first<Row>();
        const own = [zb, zc?.batch].map((v) => normId(v)).find((v) => v && cand.stock.some((z) => normId(z.batch) === v && Number(z.ur) > 0));
        x.manual = { free: true, lot: (zc?.lot as string) ?? null, batch: own || null, shade: (zc?.shade as string) ?? null };
        if (!(await senv.DB.prepare('SELECT 1 FROM korber WHERE pallet = ?').bind(up(x.pallet)).first())) throw new HttpError(400, `Pallet ${x.pallet} is not in this Pick's Korber Inventory.`);
      }
      if (!r && (x.manual || nb)) {
        r = await manualCandidate(senv, x.pallet, nb ? { ...nb.m, ...(x.manual || {}), barcode: null } as ManualFor : x.manual!, String(line.item));
        // the SAP lines of a roll picked by hand: the line's ZMMBE batches — its own batch when it is one of them, else the
        // batches that still need QTY (most first), so the packing list has SO | LI | Qty | Material | Batch for it
        const lineB = cand.stock.filter((z) => Number(z.ur) > 0).map((z) => normId(z.batch));
        if (r && lineB.length && !(r.batches.length && r.batches.every((bt) => lineB.includes(normId(bt))))) {
          const needB = (cand.batchNeed || []).filter((z) => Number(z.need) > 1e-9).sort((a, c) => Number(c.need) - Number(a.need)).map((z) => normId(z.batch));
          const top = [...cand.stock].filter((z) => Number(z.ur) > 0).sort((a, c) => Number(c.ur) - Number(a.ur)).map((z) => normId(z.batch));
          r.batches = needB.length ? needB : top.slice(0, 1);
        }
      }
      if (r && nb) {
        // chosen by the user from the matching rolls: confirmation is needed only when a field did not match
        const ck = nb.o.checks as Record<string, boolean | null>;
        const miss = [ck.lot === false ? 'Lot' : '', ck.hu === false ? 'Supplier Hu' : '', ck.qty === false && nb.m.noShade ? 'Qty' : ''].filter(Boolean);
        r.warnings = [`${nb.m.noShade ? `Inspection lot ${nb.m.lot} has no Shade Report — Korber roll` : `No Barcode Number in ZCOMENT — roll ${nb.m.roll_no ?? "?"}`} chosen by ${s.u} (matched on ${['lot', 'hu', 'invoice', 'po'].filter((f) => ck[f]).map((f) => ({ lot: 'Lot', hu: 'Supplier Hu', invoice: 'Invoice', po: 'Po' } as Record<string, string>)[f]).join(', ')})`, ...(miss.length ? [`${miss.join(', ')} not the same`] : [])];
        r.needsConfirm = miss.length > 0;
      }
      if (!r) throw new HttpError(400, `Roll ${x.pallet} is not a candidate for this line (refresh and try again).`);
      // a roll chosen by hand: at most its ZROLLMGT Available Quantity too (a Reserved part in SAP is not picked)
      if (!byPallet.has(up(x.pallet)) && gate.on) { const a = (await gate.availOf([r.pallet])).get(up(r.pallet)); if (a !== undefined && a < r.available - 1e-6) r.available = Math.max(0, r3(a)); }
      // Korber Pick Id must be 0 (another number: the roll is already on a WMS pick); a rejected roll is not picked again
      const kp = await senv.DB.prepare('SELECT pick_id FROM korber WHERE pallet = ?').bind(up(r.pallet)).first<{ pick_id: string | null }>();
      if (kp && String(kp.pick_id ?? '0') !== '0' && String(kp.pick_id ?? '') !== '') throw new HttpError(409, `Pallet ${r.pallet} is on Korber Pick Id ${kp.pick_id} — only rolls with Pick Id 0 can be picked.`);
      { const bc = (r as Candidate & { barcode?: string | null }).barcode ?? null; const why = await gate.check(r.pallet, bc, !!bc && !nb && !x.manual && !r.zroll); if (why) throw new HttpError(409, `Pallet ${r.pallet} cannot be picked — ${why}.`); }
      const rj = await env.DB.prepare('SELECT reason, by_user, day FROM pick_reject WHERE pallet = ? ORDER BY id DESC LIMIT 1').bind(up(r.pallet)).first<Row>();
      if (rj) throw new HttpError(409, `Pallet ${r.pallet} was rejected (${rj.reason ?? '–'} · ${rj.day} · ${rj.by_user}) — it is not picked again.`);
      const q = r3(num(x.qty));
      if (!(q > 0)) throw new HttpError(400, `Enter a QTY for roll ${x.pallet}.`);
      // the same pallet twice in one pick counts together: a pallet's full Actual Qty is never picked twice
      const inThis = r3(picks.filter((p0) => p0.pallet === r!.pallet).reduce((t, p0) => t + Number(p0.qty), 0));
      const left = r3(r.available - inThis);
      if (left <= 1e-9) throw new HttpError(409, `Pallet ${x.pallet} is already picked in full${r.picks.length ? ` — ${r.picks.map(pickText).join('; ')}` : inThis ? ' in this pick' : ''}.`);
      if (q > left + 1e-6) throw new HttpError(409, `Pallet ${x.pallet}: only ${left} left to pick (cut roll balance${r.picks.length ? ` after ${r.picks.map(pickText).join('; ')}` : ''}).`);
      if (r.needsConfirm && !x.confirmed) throw new HttpError(400, `Roll ${x.pallet}: ${r.warnings.join('; ')} — tick "Confirmed" for it.`);
      picks.push({ day, week: b.week, line: lineId, so: line.so, li: line.li, item: line.item, pallet: r.pallet, qty: q, roll_qty: r.base_qty,
        partial: q < left - 1e-6 || r.picked_before > 0 || inThis > 0 || r3(inThis + q) < Number(r.base_qty) - 1e-6 ? 1 : 0, shade: r.shade || (await zcomentShade(senv, { pallet: r.pallet, item: r.item, lot: r.lot, supplier_hu: r.supplier_hu }, r.insp_lots)), lot: r.lot, insp_lot: r.insp_lots.join(','), batch: r.batches.join(','),
        note: [nb ? '' : x.manual?.free ? `Manual pallet for a shortage — added by ${s.u}` : x.manual ? `Manual pick for roll ${x.manual.roll_no || '?'}${x.manual.barcode ? ' (barcode ' + x.manual.barcode + ')' : ''}` : '', r.warnings.length ? `${nb && !r.needsConfirm ? '' : 'Confirmed: '}${r.warnings.join('; ')}` : ''].filter(Boolean).join(' · ') || null,
        by_user: s.u, at, korber: r.raw });
    }
    // each user's picks are numbered 1st, 2nd … per day (their own packing list)
    const seq = ((await env.DB.prepare('SELECT MAX(seq) n FROM pick_req WHERE day = ? AND by_user = ?').bind(day, s.u).first<{ n: number | null }>())?.n ?? 0) + 1;
    const total = r3(picks.reduce((t, x) => t + Number(x.qty), 0));
    // Normal: a full roll instead of a cut (a little over), or a little less without a cut (the line is closed short) — confirmed by the user.
    // Offsite: neither — never more than the balance, and a short pick leaves the line open.
    const left = Math.max(0, r3(Number(cand.need) - Number(cand.picked)));
    const lastP = picks[picks.length - 1];
    let closed = 0, short: number | null = null;
    if (total > left + 0.0005) {
      if (kind === 'offsite') throw new HttpError(400, `Offsite pick: ${r3(total - left)} over the plan balance of ${left}. Cut the last roll to the exact QTY.`);
      if (!rules.allowNormalFull) throw new HttpError(400, `Sending a full roll over the plan is turned off in the settings: cut the last roll (${r3(total - left)} over).`);
      if (!b.overConfirmed) throw new HttpError(400, `This pick is ${r3(total - left)} over the plan balance of ${left}. Confirm sending the full roll(s), or cut the last roll.`);
      lastP.note = [lastP.note, `Over plan by ${r3(total - left)} (full roll sent, confirmed by ${s.u})`].filter(Boolean).join(' · ');
    } else if (b.closeShort && total < left - 0.0005) {
      if (kind === 'offsite') throw new HttpError(400, 'Offsite pick: a line cannot be closed short. Pick the exact QTY (the line stays open for the rest).');
      if (!rules.allowNormalShort) throw new HttpError(400, 'Closing a line short is turned off in the settings.');
      closed = 1; short = r3(left - total);
      lastP.note = [lastP.note, `Closed ${short} short of the plan (no cut, confirmed by ${s.u})`].filter(Boolean).join(' · ');
    }
    // the ZMMBE rows and ZINR lots behind the rolls, kept for the packing list
    const usedLots = new Set(picks.flatMap((x) => String(x.insp_lot).split(',')));
    const zinrUsed = (await env.DB.prepare('SELECT * FROM zinr WHERE so = ? AND li = ? AND material = ?').bind(line.so, line.li, line.item).all<Row>()).results.filter((z) => usedLots.has(String(z.lot)));
    // what this pick took from each batch (for the packing list): a roll in two batches gives first to the batch
    // that still needs QTY (the smallest part first), then to its other parts
    const need = new Map((cand.batchNeed || []).map((x) => [String(x.batch), Number(x.need)]));
    const alloc: { pallet: string; batch: string; qty: number }[] = [];
    for (const x of picks) {
      const r = byPallet.get(String(x.pallet));
      const parts = (r?.parts?.length ? r.parts : String(x.batch || '').split(',').filter(Boolean).map((bt) => ({ batch: bt, lot: '', qty: Infinity })))
        .map((pt) => ({ ...pt, left: Number(pt.qty) })).sort((p1, p2) => p1.left - p2.left);
      let q = Number(x.qty);
      const give = (pt: { batch: string; left: number }, t: number) => {
        if (t <= 1e-9) return;
        const had = alloc.find((y) => y.pallet === x.pallet && y.batch === pt.batch);
        if (had) had.qty = r3(had.qty + t); else alloc.push({ pallet: String(x.pallet), batch: pt.batch, qty: r3(t) });
        pt.left -= t; q = r3(q - t); need.set(pt.batch, r3((need.get(pt.batch) ?? 0) - t));
      };
      for (const pt of parts) give(pt, Math.min(q, pt.left, Math.max(0, need.get(pt.batch) ?? 0)));
      for (const pt of parts) give(pt, Math.min(q, pt.left));
      if (q > 1e-9 && parts.length) give({ ...parts[0], left: Infinity }, q);
    }
    // every ZMMBE row of the line (its storage location decides KFC / PFC on the packing list, not the inspection lot's)
    const match = JSON.stringify({ zmmbe: cand.stock, zinr: zinrUsed, lots: cand.lots.filter((l) => usedLots.has(String(l.lot))), alloc });
    // the last check, right before saving: what is picked of each pallet now (another user may have picked it meanwhile)
    const over = async (exceptReq?: number) => {
      const out: string[] = [];
      for (const pl of Array.from(new Set(picks.map((x) => String(x.pallet))))) {
        const mine = r3(picks.filter((x) => x.pallet === pl).reduce((t, x) => t + Number(x.qty), 0));
        const pp = await palletPicks(env, pl);
        // after saving: only the picks saved before this one count (of two at the same moment the earlier one stays)
        const others = exceptReq ? (await env.DB.prepare('SELECT COALESCE(SUM(qty), 0) q FROM picks WHERE pallet = ? AND cancelled_at IS NULL AND req_id < ?').bind(pl, exceptReq).first<{ q: number }>())!.q : pp.before;
        const base = pp.base ?? Number(picks.find((x) => x.pallet === pl)!.roll_qty);
        if (r3(Number(others) + mine) > base + 1e-6) out.push(`Pallet ${pl}: ${r3(Math.max(0, base - Number(others)))} left, ${mine} asked${pp.picks.some((k) => !exceptReq || k.req < exceptReq) ? ` — picked ${pp.picks.filter((k) => !exceptReq || k.req < exceptReq).map(pickText).join('; ')}` : ''}`);
      }
      return out;
    };
    const pre = await over();
    if (pre.length) throw new HttpError(409, `Picked meanwhile — ${pre.join(' · ')}. Refresh and pick again.`);
    const reqRow = await env.DB.prepare(`INSERT INTO pick_req (day, seq, pick_no, week, line, so, li, item, plant, need, qty, rolls, by_user, at, match, kind, closed, short, auto) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`)
      .bind(day, seq, txt(b.pickNo), b.week, lineId, line.so, line.li, line.item, line.plant ?? null, cand.need, total, picks.length, s.u, at, match, kind, closed, short, b.auto ? 1 : 0).first<{ id: number }>();
    const reqId = Number(reqRow!.id);
    for (const x of picks) x.req_id = reqId;
    await env.DB.batch([
      ...jsonInsert(env, 'picks', ['req_id', 'day', 'week', 'line', 'so', 'li', 'item', 'pallet', 'qty', 'roll_qty', 'partial', 'shade', 'lot', 'insp_lot', 'batch', 'note', 'by_user', 'at', 'korber'], picks, 100),
      // two picks saved at the same moment: the later one is taken back (below), so a pallet is never picked twice
      env.DB.prepare('INSERT INTO activity (at, username, action, detail) VALUES (?,?,?,?)').bind(at, s.u, 'pick',
        `${kind === 'offsite' ? 'Offsite' : 'Normal'} pick ${ordinal(seq)} ${day}: ${line.so} / ${line.li} / ${line.item} — ${picks.length} roll(s), ${total}${short ? ` (closed ${short} short)` : ''}${b.pickNo ? ' · pick no ' + b.pickNo : ''}`),
    ]);
    const post = await over(reqId);
    if (post.length) {
      await env.DB.batch([env.DB.prepare('DELETE FROM picks WHERE req_id = ?').bind(reqId), env.DB.prepare('DELETE FROM pick_req WHERE id = ?').bind(reqId)]);
      throw new HttpError(409, `Picked by someone else at the same moment — ${post.join(' · ')}. Nothing was saved; refresh and pick again.`);
    }
    await broadcast(env, { type: 'data', src: 'pick', by: s.u, rows: picks.length, weeks: [b.week] });
    return json({ ok: true, id: reqId, seq, label: ordinal(seq), day, qty: total, rolls: picks.length });
  }

  // GET /api/pick/history?day=yyyy-mm-dd (one day, for the packing list) or ?week= (all picks of a week)
  if (part === 'history' && req.method === 'GET') {
    await requireUser(env, req);
    // the pick history is everyone's: all users by default, ?user= for one user
    const owner = (url.searchParams.get('user') || '').trim().toLowerCase() || null;
    const day = url.searchParams.get('day'), week = url.searchParams.get('week');
    const where = (day ? 'day = ?1' : week ? 'week = ?1' : 'day = ?1') + ' AND (?2 IS NULL OR by_user = ?2)';
    const arg = day || week || colomboDay();
    const [reqs, rolls, days, hdr] = await env.DB.batch([
      env.DB.prepare(`SELECT * FROM pick_req WHERE ${where} ORDER BY day, by_user, seq`).bind(arg, owner),
      env.DB.prepare(`SELECT * FROM picks WHERE ${where} ORDER BY req_id, id`).bind(arg, owner),
      env.DB.prepare('SELECT day, COUNT(*) n, COUNT(*) open FROM pick_req WHERE ?1 IS NULL OR by_user = ?1 GROUP BY day ORDER BY day DESC LIMIT 60').bind(owner),
      env.DB.prepare("SELECT v FROM config WHERE k = 'korber_header'"),
    ]);
    const header = (hdr.results[0] as Row | undefined)?.v;
    // KFC / PFC on the packing list = the ZMMBE storage location of the batch: picks saved before every ZMMBE row of the line
    // was kept with the pick get the Pick's ZMMBE rows now
    const envs = new Map<string, Env>();
    const zs = new Map<string, Row[]>();
    for (const r of reqs.results as Row[]) {
      let m: { zmmbe?: Row[] } = {};
      try { m = r.match ? JSON.parse(String(r.match)) : {}; } catch { /* old */ }
      const have = new Set((m.zmmbe || []).map((z) => normId(z.batch)));
      const need = String(((rolls.results as Row[]).filter((x) => x.req_id === r.id).map((x) => x.batch)).join(',')).split(',').map((b) => normId(b)).filter(Boolean);
      if (need.every((b) => have.has(b))) continue;
      const wk = String(r.week ?? ''), key = String(r.line ?? '').split('|').slice(0, 3).join('|');
      const zk = `${wk}#${key}`;
      if (!zs.has(zk)) {
        if (!envs.has(wk)) envs.set(wk, await envFor(env, wk));
        zs.set(zk, (await envs.get(wk)!.DB.prepare("SELECT batch, sloc, ur, plant FROM stock WHERE src = 'zmmbe' AND key = ?").bind(key).all<Row>()).results);
      }
      r.zstock = zs.get(zk);
    }
    // a pick saved without a shade (a roll matched straight from ZINR to Korber): the ZCOMENT Shade, for the Packing List
    for (const x of rolls.results as Row[]) {
      if (x.shade) continue;
      const wk = String(x.week ?? '');
      if (!envs.has(wk)) envs.set(wk, await envFor(env, wk));
      const env2 = envs.get(wk)!;
      let kk: { pallet: unknown; item: unknown; lot: unknown; supplier_hu: unknown } = { pallet: x.pallet, item: x.item, lot: x.lot, supplier_hu: null };
      const kr = await env2.DB.prepare('SELECT item, lot, supplier_hu FROM korber WHERE pallet = ?').bind(x.pallet).first<Row>();
      if (kr) kk = { pallet: x.pallet, item: kr.item, lot: kr.lot, supplier_hu: kr.supplier_hu };
      x.shade = await zcomentShade(env2, kk, String(x.insp_lot ?? '').split(','));
    }
    return json({ day, week, owner, requests: reqs.results, picks: rolls.results, days: days.results, korberHeader: header ? JSON.parse(String(header)) : null });
  }

  // DELETE /api/pick/req/:id cancels a whole request; DELETE /api/pick/roll/:id one roll — the rolls become pickable again
  // Reject a picked roll (a problem with it): it leaves the pick and goes to the rejected rolls; the pallet is not picked again.
  // POST /api/pick/reject {pickId, reason} · GET /api/pick/rejects?all=1 · POST /api/pick/replace {rejectId, pallet, qty}
  if (part === 'reject' && req.method === 'POST') {
    const s = await requireUser(env, req, 'editor');
    const b = (await req.json()) as { pickId?: number; reason?: string };
    const reason = txt(b.reason);
    if (!reason) throw new HttpError(400, 'Give the reason the roll is rejected.');
    const r = await env.DB.prepare('SELECT p.*, q.seq, q.by_user AS req_user FROM picks p JOIN pick_req q ON q.id = p.req_id WHERE p.id = ? AND p.cancelled_at IS NULL').bind(Number(b.pickId)).first<Row>();
    if (!r) throw new HttpError(404, 'That roll pick is gone. Refresh.');
    if (!isBoss(s) && r.req_user !== s.u) throw new HttpError(403, `That pick was made by ${r.req_user}.`);
    const at = now();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO pick_reject (pick_id, req_id, day, week, line, so, li, item, pallet, qty, roll_qty, lot, insp_lot, batch, shade, reason, by_user, at, korber)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(r.id, r.req_id, colomboDay(), r.week, r.line, r.so, r.li, r.item, r.pallet, r.qty, r.roll_qty, r.lot, r.insp_lot, r.batch, r.shade, reason, s.u, at, r.korber),
      env.DB.prepare('DELETE FROM picks WHERE id = ?').bind(r.id),
      env.DB.prepare('UPDATE pick_req SET qty = (SELECT COALESCE(SUM(qty), 0) FROM picks WHERE req_id = ?1), rolls = (SELECT COUNT(*) FROM picks WHERE req_id = ?1) WHERE id = ?1').bind(r.req_id),
      env.DB.prepare('INSERT INTO activity (at, username, action, detail) VALUES (?,?,?,?)').bind(at, s.u, 'pick', `Rejected roll ${r.pallet} (${r.qty}) of ${r.so} / ${r.li} / ${r.item} — ${reason}`),
    ]);
    await broadcast(env, { type: 'data', src: 'pick', by: s.u, rows: 1, weeks: [r.week] });
    return json({ ok: true });
  }
  if (part === 'rejects' && req.method === 'GET') {
    await requireUser(env, req);
    const all = url.searchParams.get('all') === '1';
    const rows = (await env.DB.prepare(`SELECT * FROM pick_reject ${all ? '' : 'WHERE replaced_by IS NULL'} ORDER BY id DESC LIMIT 300`).all<Row>()).results;
    for (const x of rows) x.plan = periodLabel(x.week);
    return json({ rejects: rows });
  }
  if (part === 'replace' && req.method === 'POST') {
    const s = await requireUser(env, req, 'editor');
    const b = (await req.json()) as { rejectId?: number; pallet?: string; qty?: number };
    const rj = await env.DB.prepare('SELECT * FROM pick_reject WHERE id = ?').bind(Number(b.rejectId)).first<Row>();
    if (!rj) throw new HttpError(404, 'That rejected roll is gone. Refresh.');
    if (rj.replaced_by) throw new HttpError(409, `Already replaced by ${rj.replaced_by}.`);
    const reqRow = await env.DB.prepare('SELECT * FROM pick_req WHERE id = ?').bind(rj.req_id).first<Row>();
    if (!reqRow) throw new HttpError(404, 'The pick of that roll was cancelled.');
    // a Korber roll of the same Material (Item Number), Pick Id 0, not rejected, not picked in full (master history)
    const senv = await envFor(env, rj.week);
    const pallet = up(b.pallet);
    const k = await senv.DB.prepare('SELECT * FROM korber WHERE pallet = ?').bind(pallet).first<Row>();
    if (!k) throw new HttpError(404, `Pallet ${pallet} is not in this Pick's Korber Inventory.`);
    if (normId(k.item) !== normId(rj.item)) throw new HttpError(400, `Pallet ${pallet} is item ${k.item}, not ${rj.item}.`);
    if (String(k.pick_id ?? '0') !== '0' && String(k.pick_id ?? '') !== '') throw new HttpError(409, `Pallet ${pallet} is on Korber Pick Id ${k.pick_id}.`);
    if (await env.DB.prepare('SELECT 1 FROM pick_reject WHERE pallet = ?').bind(pallet).first()) throw new HttpError(409, `Pallet ${pallet} was rejected itself.`);
    { const why = await (await makeGate(senv)).check(pallet, null, false); if (why) throw new HttpError(409, `Pallet ${pallet} cannot be picked — ${why}.`); }
    const pp = await palletPicks(env, pallet);
    const base = pp.base ?? Number(k.qty);
    const avail = Math.max(0, r3(base - pp.before));
    if (avail <= 1e-9) throw new HttpError(409, `Pallet ${pallet} is already picked in full — ${pp.picks.map(pickText).join('; ')}.`);
    const q = r3(Math.min(Number(b.qty) > 0 ? Number(b.qty) : Number(rj.qty), avail));
    const at = now();
    const shade = await zcomentShade(senv, { pallet, item: k.item, lot: k.lot, supplier_hu: k.supplier_hu }, String(rj.insp_lot ?? '').split(','));
    const row = { req_id: rj.req_id, day: colomboDay(), week: rj.week, line: rj.line, so: rj.so, li: rj.li, item: rj.item, pallet, qty: q, roll_qty: base,
      partial: q < avail - 1e-6 || pp.before > 0 ? 1 : 0, shade, lot: k.lot, insp_lot: rj.insp_lot, batch: rj.batch,
      note: `Replacement for rejected ${rj.pallet} (${rj.reason}) — assigned by ${s.u}`, by_user: s.u, at, korber: k.raw };
    await env.DB.batch([
      ...jsonInsert(env, 'picks', Object.keys(row), [row as Row]),
      env.DB.prepare('UPDATE pick_req SET qty = (SELECT COALESCE(SUM(qty), 0) FROM picks WHERE req_id = ?1), rolls = (SELECT COUNT(*) FROM picks WHERE req_id = ?1) WHERE id = ?1').bind(rj.req_id),
      env.DB.prepare('UPDATE pick_reject SET replaced_by = ?, replaced_qty = ?, replaced_user = ?, replaced_at = ? WHERE id = ?').bind(pallet, q, s.u, at, rj.id),
      env.DB.prepare('INSERT INTO activity (at, username, action, detail) VALUES (?,?,?,?)').bind(at, s.u, 'pick', `Replaced rejected ${rj.pallet} with ${pallet} (${q}) on ${rj.so} / ${rj.li}`),
    ]);
    // the same last check as a pick: two at the same moment
    const after = await palletPicks(env, pallet);
    if (after.before > (after.base ?? base) + 1e-6) {
      await env.DB.batch([env.DB.prepare('DELETE FROM picks WHERE req_id = ? AND pallet = ? AND at = ?').bind(rj.req_id, pallet, at),
        env.DB.prepare('UPDATE pick_reject SET replaced_by = NULL, replaced_qty = NULL, replaced_user = NULL, replaced_at = NULL WHERE id = ?').bind(rj.id),
        env.DB.prepare('UPDATE pick_req SET qty = (SELECT COALESCE(SUM(qty), 0) FROM picks WHERE req_id = ?1), rolls = (SELECT COUNT(*) FROM picks WHERE req_id = ?1) WHERE id = ?1').bind(rj.req_id)]);
      throw new HttpError(409, `Pallet ${pallet} was picked by someone else at the same moment. Choose another.`);
    }
    await broadcast(env, { type: 'data', src: 'pick', by: s.u, rows: 1, weeks: [rj.week] });
    return json({ ok: true, qty: q });
  }

  // GET /api/pick/search?q= — the whole pick history (all days, all users): any value (pallet, SO, item, lot, batch, pick no, shade, user, plan…)
  if (part === 'search' && req.method === 'GET') {
    await requireUser(env, req);
    const q = (url.searchParams.get('q') || '').trim();
    if (q.length < 2) return json({ rows: [] });
    const like = `%${q.toUpperCase()}%`;
    const rows = (await env.DB.prepare(`SELECT p.id, p.day, p.week, p.so, p.li, p.item, p.pallet, p.qty, p.roll_qty, p.partial, p.shade, p.lot, p.insp_lot, p.batch, p.note, p.by_user, p.at,
        r.seq, r.pick_no, r.kind, json_extract(p.korber, '$') AS k
      FROM picks p JOIN pick_req r ON r.id = p.req_id
      WHERE p.cancelled_at IS NULL AND (upper(p.pallet) LIKE ?1 OR upper(p.so) LIKE ?1 OR upper(p.item) LIKE ?1 OR upper(COALESCE(p.lot, '')) LIKE ?1 OR upper(COALESCE(p.batch, '')) LIKE ?1
        OR upper(COALESCE(p.insp_lot, '')) LIKE ?1 OR upper(COALESCE(r.pick_no, '')) LIKE ?1 OR upper(COALESCE(p.shade, '')) LIKE ?1 OR upper(p.by_user) LIKE ?1 OR upper(p.week) LIKE ?1
        OR p.day LIKE ?1 OR upper(COALESCE(p.note, '')) LIKE ?1 OR upper(COALESCE(p.korber, '')) LIKE ?1)
      ORDER BY p.id DESC LIMIT 300`).bind(like).all<Row>()).results;
    const rejects = (await env.DB.prepare(`SELECT * FROM pick_reject WHERE upper(pallet) LIKE ?1 OR upper(so) LIKE ?1 OR upper(item) LIKE ?1 OR upper(COALESCE(reason, '')) LIKE ?1 OR upper(COALESCE(replaced_by, '')) LIKE ?1 ORDER BY id DESC LIMIT 100`).bind(like).all<Row>()).results;
    for (const x of rows) { x.plan = periodLabel(x.week); delete x.k; }
    for (const x of rejects) x.plan = periodLabel(x.week);
    return json({ rows, rejects });
  }

  // GET /api/pick/cutrolls?rid= — the cut rolls on the shelf: pallets picked in part (master history), their balance, and
  // whether the Pick's Korber still has them
  if (part === 'cutrolls' && req.method === 'GET') {
    await requireUser(env, req);
    const rid = scopeRid(url.searchParams.get('rid'));
    const kenv = await envFor(env, rid);
    const rows = (await env.DB.prepare(`SELECT pallet, MAX(item) item, MAX(roll_qty) base, ROUND(SUM(qty), 3) picked, COUNT(*) picks, MAX(at) last_at, MAX(day) last_day,
        GROUP_CONCAT(DISTINCT so || '/' || li) lines FROM picks WHERE cancelled_at IS NULL GROUP BY pallet HAVING SUM(qty) < MAX(roll_qty) - 0.0005 ORDER BY MAX(at) DESC LIMIT 1000`).all<Row>()).results;
    const out: Row[] = [];
    for (const r of rows) {
      const k = await kenv.DB.prepare('SELECT location, lot, qty, pick_id FROM korber WHERE pallet = ?').bind(r.pallet).first<Row>();
      out.push({ ...r, balance: r3(Number(r.base) - Number(r.picked)), location: k?.location ?? null, lot: k?.lot ?? null, in_korber: !!k, pick_id: k?.pick_id ?? null });
    }
    return json({ rid, rows: out, total: r3(out.reduce((t, x) => t + Number(x.balance), 0)) });
  }

  // A Korber pallet's own history (every pick of it, every day / Pick / user, and its rejects):
  // GET /api/pick/pallet?p=PALLET · DELETE /api/pick/pallet?p=PALLET (Admin / Head) — the pallet is pickable in full again
  if (part === 'pallet') {
    const pal = up(url.searchParams.get('p'));
    if (!pal) throw new HttpError(400, 'Scan or type a Korber pallet.');
    if (req.method === 'GET') {
      await requireUser(env, req);
      const [pk, rj, kb] = await env.DB.batch([
        env.DB.prepare(`SELECT p.id, p.req_id, p.day, p.week, p.so, p.li, p.item, p.qty, p.roll_qty, p.partial, p.shade, p.batch, p.note, p.by_user, p.at, q.seq, q.pick_no, q.kind, q.auto
          FROM picks p LEFT JOIN pick_req q ON q.id = p.req_id WHERE p.pallet = ? AND p.cancelled_at IS NULL ORDER BY p.at`).bind(pal),
        env.DB.prepare('SELECT id, day, week, so, li, qty, reason, by_user, at, replaced_by FROM pick_reject WHERE pallet = ? ORDER BY id').bind(pal),
        env.DB.prepare('SELECT pallet, item, lot, qty, location, rid FROM korber WHERE pallet = ? ORDER BY rid DESC LIMIT 1').bind(pal),
      ]);
      const rows: Row[] = (pk.results as Row[]).map((x) => ({ ...x, plan: periodLabel(x.week) }));
      const k = (kb.results as Row[])[0] ?? null;
      const picked = r3(rows.reduce((t, x) => t + Number(x.qty), 0));
      const base = rows.length ? Number(rows[0].roll_qty ?? k?.qty ?? 0) : Number(k?.qty ?? 0);
      return json({ pallet: pal, korber: k, picks: rows, rejects: (rj.results as Row[]).map((x) => ({ ...x, plan: periodLabel(x.week) })), picked, base, left: Math.max(0, r3(base - picked)) });
    }
    if (req.method === 'DELETE') {
      const s = await requireUser(env, req, 'editor');
      if (!isBoss(s)) throw new HttpError(403, 'Only Admin or Head can delete a pallet\'s history.');
      const pk = (await env.DB.prepare('SELECT id, req_id, day, by_user, week, qty FROM picks WHERE pallet = ?').bind(pal).all<Row>()).results;
      const nr = Number((await env.DB.prepare('SELECT COUNT(*) n FROM pick_reject WHERE pallet = ?').bind(pal).first<{ n: number }>())?.n ?? 0);
      if (!pk.length && !nr) throw new HttpError(404, `Pallet ${pal} has no pick history.`);
      const reqs = Array.from(new Set(pk.map((x) => Number(x.req_id))));
      const who = Array.from(new Map(pk.map((x) => [`${x.day}|${x.by_user}`, x])).values());
      await env.DB.batch([
        env.DB.prepare('DELETE FROM picks WHERE pallet = ?').bind(pal),
        env.DB.prepare('DELETE FROM pick_reject WHERE pallet = ?').bind(pal),
        // its picks: their QTY / rolls again; a pick with no roll left goes
        ...reqs.map((id) => env.DB.prepare('UPDATE pick_req SET qty = (SELECT COALESCE(SUM(qty), 0) FROM picks WHERE req_id = ?1), rolls = (SELECT COUNT(*) FROM picks WHERE req_id = ?1) WHERE id = ?1').bind(id)),
        ...reqs.map((id) => env.DB.prepare('DELETE FROM pick_req WHERE id = ? AND NOT EXISTS (SELECT 1 FROM picks WHERE req_id = pick_req.id)').bind(id)),
        ...who.map((x) => env.DB.prepare(`UPDATE pick_req SET seq = (SELECT COUNT(*) FROM pick_req y WHERE y.day = pick_req.day AND y.by_user = pick_req.by_user AND y.id <= pick_req.id) WHERE day = ?1 AND by_user = ?2`).bind(x.day, x.by_user)),
        env.DB.prepare('INSERT INTO activity (at, username, action, detail) VALUES (?,?,?,?)').bind(now(), s.u, 'pick', `Deleted the history of pallet ${pal}: ${pk.length} pick${pk.length === 1 ? '' : 's'} (${r3(pk.reduce((t, x) => t + Number(x.qty), 0))})${nr ? `, ${nr} reject${nr === 1 ? '' : 's'}` : ''}`),
      ]);
      await broadcast(env, { type: 'data', src: 'pick', by: s.u, rows: 0, weeks: Array.from(new Set(pk.map((x) => String(x.week)))) });
      return json({ ok: true, picks: pk.length, rejects: nr });
    }
  }

  if ((part === 'req' || part === 'roll') && req.method === 'DELETE') {
    const s = await requireUser(env, req, 'editor');
    const id = Number(p.split('/')[4]);
    if (!Number.isInteger(id)) throw new HttpError(400, 'Unknown pick.');
    const at = now();
    // cancelling removes the pick from the history (the rolls become pickable again); the day's 1st, 2nd … are numbered again
    const renumber = (d: unknown, u: unknown) => env.DB.prepare(`UPDATE pick_req SET seq = (SELECT COUNT(*) FROM pick_req x WHERE x.day = pick_req.day AND x.by_user = pick_req.by_user AND x.id <= pick_req.id)
      WHERE day = ?1 AND by_user = ?2`).bind(d, u);
    const mine = (owner: unknown) => { if (!isBoss(s) && owner !== s.u) throw new HttpError(403, `That pick was made by ${owner}.`); };
    if (part === 'req') {
      const r = await env.DB.prepare('SELECT * FROM pick_req WHERE id = ?').bind(id).first<Row>();
      if (!r) throw new HttpError(404, 'That pick is gone.');
      mine(r.by_user);
      await env.DB.batch([
        env.DB.prepare('DELETE FROM picks WHERE req_id = ?').bind(id),
        env.DB.prepare('DELETE FROM pick_req WHERE id = ?').bind(id),
        renumber(r.day, r.by_user),
        env.DB.prepare('INSERT INTO activity (at, username, action, detail) VALUES (?,?,?,?)').bind(at, s.u, 'pick', `Deleted pick ${ordinal(Number(r.seq))} ${r.day} of ${r.by_user}: ${r.so} / ${r.li} — ${r.rolls} roll(s), ${r.qty}`),
      ]);
      await broadcast(env, { type: 'data', src: 'pick', by: s.u, rows: 0, weeks: [r.week] });
    } else {
      const r = await env.DB.prepare('SELECT p.*, q.day AS req_day FROM picks p JOIN pick_req q ON q.id = p.req_id WHERE p.id = ?').bind(id).first<Row>();
      if (!r) throw new HttpError(404, 'That roll pick is gone.');
      mine(r.by_user);
      await env.DB.batch([
        env.DB.prepare('DELETE FROM picks WHERE id = ?').bind(id),
        env.DB.prepare(`UPDATE pick_req SET qty = (SELECT COALESCE(SUM(qty), 0) FROM picks WHERE req_id = ?1), rolls = (SELECT COUNT(*) FROM picks WHERE req_id = ?1) WHERE id = ?1`).bind(r.req_id),
        // the last roll gone: the whole pick goes
        env.DB.prepare('DELETE FROM pick_req WHERE id = ? AND NOT EXISTS (SELECT 1 FROM picks WHERE req_id = pick_req.id)').bind(r.req_id),
        renumber(r.req_day, r.by_user),
        env.DB.prepare('INSERT INTO activity (at, username, action, detail) VALUES (?,?,?,?)').bind(at, s.u, 'pick', `Removed roll ${r.pallet} (${r.qty}) from a pick of ${r.by_user} (${r.so} / ${r.li})`),
      ]);
      await broadcast(env, { type: 'data', src: 'pick', by: s.u, rows: 0, weeks: [r.week] });
    }
    return json({ ok: true });
  }
  throw new HttpError(404, 'Not found.');
}

/** 1 → 1st, 2 → 2nd, 11 → 11th, 23 → 23rd */
const ordinal = (n: number) => { const v = n % 100, sfx = ['th', 'st', 'nd', 'rd']; return n + (sfx[(v - 20) % 10] || sfx[v] || sfx[0]); };

/**
 * The roll number inside a pallet or barcode, so the same roll is found under another pallet name:
 * CP000008089565, COMPCP000008089565, RCP000008089565A, ACP000008089565, CP8089565-TL06 → "8089565".
 */
function palletCore(v: unknown): string | null {
  const s = up(v).replace(/\s+/g, '');
  const m = s.match(/[CH]P(\d{6,})/);
  if (m) return m[1].replace(/^0+/, '') || null;
  const d = s.replace(/\.\d+$/, '').replace(/\D/g, '').replace(/^0+/, '');
  return d.length >= 6 ? d : null;
}
/**
 * The Korber roll for a shade-report Barcode Number, trying as hard as possible:
 * 1. the Pallet itself; 2. a pallet with the same roll number (re-labelled: COMP…, R…, A…, …-TL06), same item.
 * When several pallets carry that number, the one agreeing on Lot, Supplier Hu, Invoice and Po (and still available) wins;
 * a tie between different pallets is not guessed.
 */
async function korberForBarcode(env: Env, sh: Row, lot: Row): Promise<{ k: Row | null; via: string | null; ambiguous: string[]; byHu?: boolean }> {
  const bc = up(sh.barcode);
  const exact = await env.DB.prepare('SELECT * FROM korber WHERE pallet = ?').bind(bc).first<Row>();
  const core = palletCore(bc);
  const same = core ? (await env.DB.prepare('SELECT * FROM korber WHERE pcore = ? LIMIT 12').bind(core).all<Row>()).results : [];
  const list = [...(exact ? [exact] : []), ...same.filter((x) => !exact || x.pallet !== exact.pallet)];
  // not under the barcode (another label, e.g. C000004250668 → HP000001361442): the one Korber roll of the item with
  // Supplier Hu = Vendor Roll No and Lot Number = Vendor Batch (Invoice / Po not different)
  const byHu = async () => {
    if (!sh.roll_no || !sh.vendor_batch) return null;
    const hs = (await env.DB.prepare('SELECT * FROM korber WHERE item = ? AND supplier_hu = ? AND upper(lot) = ? LIMIT 5').bind(normId(sh.material), up(sh.roll_no), up(sh.vendor_batch)).all<Row>()).results;
    const ok: Row[] = [];
    for (const h of hs) {
      if (lot.invoice && h.invoice && up(h.invoice) !== up(lot.invoice)) continue;
      // Item + Lot + Supplier Hu + the same Invoice is the roll even when Korber's Po differs (a pallet labelled with another PO of the invoice)
      if (lot.po) { const kp = await korberPo(env, h); if (kp && !poMatch(kp, lot) && !(lot.invoice && h.invoice && up(h.invoice) === up(lot.invoice))) continue; }
      // a pallet that is the barcode of another shade-report roll belongs to that roll
      if (await env.DB.prepare("SELECT 1 FROM zcoment WHERE barcode = ?1 AND upper(COALESCE(roll_no, '')) <> ?2 LIMIT 1").bind(up(h.pallet), up(sh.roll_no)).first()) continue;
      ok.push(h);
    }
    return ok.length === 1 ? ok[0] : null;
  };
  if (!list.length) { const h = await byHu(); return h ? { k: h, via: String(h.pallet), ambiguous: [], byHu: true } : { k: null, via: null, ambiguous: [] }; }
  const scored: { k: Row; score: number }[] = [];
  for (const k of list) {
    if (normId(k.item) !== normId(sh.material) && k !== exact) continue; // another item with the same number: not this roll
    const ph = (await env.DB.prepare('SELECT COALESCE(SUM(qty), 0) q, MIN(roll_qty) base FROM picks WHERE pallet = ? AND cancelled_at IS NULL').bind(k.pallet).first<{ q: number; base: number | null }>())!;
    const left = Number(ph.base ?? k.qty) - Number(ph.q);
    let score = 0;
    if (k === exact) score += 1;
    if (sh.vendor_batch && up(k.lot) === up(sh.vendor_batch)) score += 20;
    if (sh.roll_no && up(k.supplier_hu) === up(sh.roll_no)) score += 20;
    if (lot.invoice && up(k.invoice) === up(lot.invoice)) score += 10;
    if (lot.po && poMatch(await korberPo(env, k), lot)) score += 10;
    if (left > 1e-9) score += 5;
    if (/avail/i.test(String(k.status ?? ''))) score += 2;
    scored.push({ k, score });
  }
  if (!scored.length) return { k: exact, via: null, ambiguous: [] };
  scored.sort((a, b) => b.score - a.score);
  if (scored.length > 1 && scored[0].score === scored[1].score && scored[0].k !== exact) {
    const h = await byHu();
    if (h) return { k: h, via: String(h.pallet), ambiguous: [], byHu: true };
    return { k: null, via: null, ambiguous: scored.filter((x) => x.score === scored[0].score).map((x) => String(x.k.pallet)) };
  }
  const k = scored[0].k;
  return { k, via: up(k.pallet) === bc ? null : String(k.pallet), ambiguous: [] };
}

/** Korber item: the Display Item Number (1000240167), else the Item Number without the client code (MASKRE-1000240167). */
function korberItem(display: unknown, item: unknown): string {
  const d = normId(display);
  if (d) return d;
  return normId(up(item).replace(/^[A-Z]{2,10}-(?=[A-Z0-9])/, ''));
}

/**
 * The ZCOMENT Shade of a Korber roll: the Shade Report roll whose Barcode Number is the pallet, else the one of the same item
 * with Vendor Batch = Lot Number and Vendor Roll No = Supplier Hu (preferring this line's inspection lots).
 */
async function zcomentShade(env: Env, k: { pallet: unknown; item: unknown; lot: unknown; supplier_hu: unknown }, lots: string[] = []): Promise<string | null> {
  const byBc = await env.DB.prepare("SELECT shade FROM zcoment WHERE barcode = ? AND COALESCE(shade, '') <> '' LIMIT 1").bind(up(k.pallet)).first<{ shade: string }>();
  if (byBc) return byBc.shade;
  if (!k.supplier_hu || !k.lot) return null;
  const rows = (await env.DB.prepare("SELECT lot, shade FROM zcoment WHERE material = ?1 AND upper(vendor_batch) = ?2 AND upper(roll_no) = ?3 AND COALESCE(shade, '') <> ''")
    .bind(normId(k.item), up(k.lot), up(k.supplier_hu)).all<{ lot: string; shade: string }>()).results;
  if (!rows.length) return null;
  const mine = rows.find((r) => lots.includes(String(r.lot)));
  if (mine) return mine.shade;
  return new Set(rows.map((r) => r.shade)).size === 1 ? rows[0].shade : null; // one answer only
}

/** Korber Po Number (older uploads have it only in the raw row). */
let poIx: number | null = null;
async function korberPo(env: Env, k: Row): Promise<string | null> {
  if (k.po) return String(k.po);
  if (poIx === null) {
    const h = (await env.DB.prepare("SELECT v FROM config WHERE k = 'korber_header'").first<{ v: string }>())?.v;
    poIx = h ? (JSON.parse(h) as unknown[]).map(hnorm).indexOf('ponumber') : -1;
  }
  if (poIx < 0 || !k.raw) return null;
  try { const v = (JSON.parse(String(k.raw)) as unknown[])[poIx]; return v === null || v === undefined || v === '' ? null : up(v); } catch { return null; }
}
/** ZINR Purchasing Document (E452921028) = Korber Po Number, which carries the client code in front (MASKRE-E452921028). */
/**
 * One PO in one form: without the client code (MASKRE-), without a split suffix (-A / -B), and SAP's 450xxxxxxx written as
 * E45xxxxxxx (ZINR E452870424 = Korber MASKRE-4502870424).
 */
function poCanon(v: unknown): string {
  let t = up(v).replace(/^[A-Z]{2,10}-(?=[A-Z0-9])/, '').replace(/-[A-Z]$/, '');
  const m = t.match(/^450(\d{7})$/);
  if (m) t = 'E45' + m[1];
  return normId(t);
}
function poMatch(kpo: string | null, lot: Row): boolean {
  const z = up(lot.po);
  if (!z || !kpo) return false;
  const k = up(kpo);
  return k === z || k.endsWith('-' + z) || normId(k) === normId(z) || poCanon(k) === poCanon(z);
}
/** For a roll that is not matched: Korber rolls of the same item with the same Lot Number, Supplier Hu, Invoice and Po (any pallet). */
async function suggestKorber(env: Env, sh: Row, lot: Row) {
  if (!sh.roll_no || !sh.vendor_batch) return [];
  const ks = (await env.DB.prepare('SELECT * FROM korber WHERE item = ? AND supplier_hu = ? LIMIT 20').bind(normId(sh.material), up(sh.roll_no)).all<Row>()).results;
  const out: Row[] = [];
  for (const k of ks) {
    if (up(k.lot) !== up(sh.vendor_batch)) continue;
    if (lot.invoice && up(k.invoice) !== up(lot.invoice)) continue;
    if (lot.po && !poMatch(await korberPo(env, k), lot)) continue;
    const pp = await palletPicks(env, k.pallet);
    const base = pp.base ?? Number(k.qty), before = pp.before;
    out.push({ pallet: k.pallet, item: k.item, lot: k.lot, qty: k.qty, uom: k.uom, invoice: k.invoice, location: k.location, supplier_hu: k.supplier_hu, status: k.status,
      picked_before: before, available: Math.max(0, r3(base - before)), picks: pp.picks });
  }
  return out.slice(0, 5);
}

/**
 * A Shade Report roll with no Barcode Number: the Korber rolls of the same item that agree on its other fields —
 * Vendor Batch = Lot Number, Vendor Roll No = Supplier Hu (ZCOMENT), Vendor Invoice No = Invoice Number,
 * Purchasing Document = Po Number (ZINR) — best first. The user chooses the roll; nothing is guessed.
 * Supplier Hu is the roll's own number: when ZCOMENT has a Vendor Roll No it must be the same (Lot only when there is none;
 * a Vendor Batch like "*1-1" is shared by many rolls). Invoice / Po must not differ. A Korber pallet that is the Barcode Number
 * of another ZCOMENT roll belongs to that roll and is never offered. Lot and Qty differences are shown and need a confirm.
 */
async function noBarcodeOptions(env: Env, sh: Row, lot: Row, skip: Set<string>) {
  const vb = up(sh.vendor_batch), hu = up(sh.roll_no);
  if (!vb && !hu) return [];
  // rolls whose Actual Qty is the roll / lot QTY first (a common Lot like "*1-1" has many rolls)
  const ks = (await env.DB.prepare('SELECT * FROM korber WHERE item = ?1 AND ((?2 <> \'\' AND supplier_hu = ?2) OR (?3 <> \'\' AND upper(lot) = ?3)) ORDER BY ABS(qty - ?4) < 0.0005 DESC, ABS(qty - ?4) LIMIT 80')
    .bind(normId(sh.material), hu, vb, Number(sh.roll_qty) || 0).all<Row>()).results;
  const out: Row[] = [];
  for (const k of ks) {
    if (skip.has(String(k.pallet))) continue; // already the matched roll of another shade-report roll
    const kpo = await korberPo(env, k);
    const checks: Record<string, boolean | null> = {
      lot: vb ? up(k.lot) === vb : null,
      hu: hu ? up(k.supplier_hu) === hu : null,
      invoice: lot.invoice && k.invoice ? up(k.invoice) === up(lot.invoice) : null,
      po: lot.po && kpo ? poMatch(kpo, lot) : null,
      qty: Number(sh.roll_qty) > 0 ? Math.abs(Number(k.qty) - Number(sh.roll_qty)) < 0.0005 : null,
    };
    // the roll number decides; without one, the Lot must agree. Invoice / Po never contradict.
    if (hu ? !checks.hu : !checks.lot) continue;
    if (checks.invoice === false) continue;
    // a different Po is allowed only when the roll number, Lot and Invoice all agree (pallet labelled with another PO of the invoice)
    if (checks.po === false && !(checks.hu && checks.lot !== false && checks.invoice === true)) continue;
    // a lot with no Purchasing Document (a transfer lot): a roll whose Po Number is another SO line's PO in ZINR is that line's roll
    if (!lot.po && kpo && !checks.hu) {
      const zpo = up(kpo).replace(/^[A-Z]{2,10}-(?=[A-Z0-9])/, '');
      if (await env.DB.prepare('SELECT 1 FROM zinr WHERE upper(po) IN (?1, ?4) AND NOT (so = ?2 AND li = ?3) LIMIT 1').bind(zpo, lot.so, lot.li, poCanon(zpo)).first()) continue;
    }
    // another shade-report roll has this pallet as its barcode: not this roll
    const core = palletCore(k.pallet);
    if (await env.DB.prepare('SELECT 1 FROM zcoment WHERE (barcode = ?1 OR (?2 IS NOT NULL AND barcode LIKE \'%\' || ?2 || \'%\')) AND NOT (upper(COALESCE(roll_no, \'\')) = ?3 AND ?3 <> \'\') LIMIT 1').bind(up(k.pallet), core, hu).first()) continue;
    const pp = await palletPicks(env, k.pallet);
    const base = pp.base ?? Number(k.qty);
    const before = pp.before;
    // with a roll number: Supplier Hu (and Lot) decide; without one (no Shade Report): Lot and the lot's QTY
    const exact = hu ? !!checks.hu && checks.lot !== false : !!checks.lot && !!checks.qty;
    const score = (checks.lot ? 20 : 0) + (checks.hu ? 20 : 0) + (checks.invoice ? 10 : 0) + (checks.po ? 10 : 0) + (checks.qty ? (hu ? 5 : 30) : 0) + (base - before > 1e-9 ? 3 : 0);
    out.push({ pallet: k.pallet, item: k.item, lot: k.lot, supplier_hu: k.supplier_hu, qty: k.qty, uom: k.uom, location: k.location, status: k.status, invoice: k.invoice,
      picked_before: before, available: Math.max(0, r3(base - before)), checks, exact, score, picks: pp.picks });
  }
  // once one of them was picked for this roll, that pallet is the roll: only it stays (its balance, if it was cut)
  const used = out.filter((o) => Number(o.picked_before) > 0);
  return (used.length ? used : out).sort((a, b) => Number(b.score) - Number(a.score)).slice(0, 12);
}

interface ManualFor { /** a Korber pallet added by hand for a shortage of the pick (not for a ZCOMENT roll) */ free?: boolean; roll_no?: string | null; barcode?: string | null; lot?: string | null; batch?: string | null; vendor_batch?: string | null; shade?: string | null; roll_qty?: number | null; invoice?: string | null; po?: string | null }

/**
 * A pallet's earlier picks (not cancelled): QTY, the roll's QTY when first picked, and the plan each went to
 * (day plan round / week, SO / LI, HJ Pick No, day, who) — a cut roll keeps only its balance, a roll picked in full is gone.
 */
interface PalletPick { day: string; by_user: string; qty: number; plan: string; so: string; li: string; pick_no: string | null; at: string; req: number }
async function palletPicks(env: Env, pallet: unknown) {
  const ph = (await env.DB.prepare(`SELECT p.day, p.by_user, p.qty, p.roll_qty, p.week, p.so, p.li, p.at, p.req_id, r.pick_no FROM picks p LEFT JOIN pick_req r ON r.id = p.req_id
    WHERE p.pallet = ? AND p.cancelled_at IS NULL ORDER BY p.id`).bind(String(pallet ?? '')).all<Row>()).results;
  const picks: PalletPick[] = ph.map((x) => ({ day: String(x.day), by_user: String(x.by_user), qty: Number(x.qty), plan: periodLabel(x.week), so: String(x.so ?? ''), li: String(x.li ?? ''), pick_no: (x.pick_no as string | null) ?? null, at: String(x.at ?? ''), req: Number(x.req_id) }));
  return { picks, base: ph.length ? Number(ph[0].roll_qty) : null, before: r3(picks.reduce((t, x) => t + x.qty, 0)) };
}
/** "64.46 on 2026-10-20 · 2026-10-20 C051 Pick 1 · E101698226 / 10 · HJ 5501 · admin" */
const pickText = (k: PalletPick) => `${k.qty} on ${k.day} · ${k.plan} · ${k.so} / ${k.li}${k.pick_no ? ` · HJ ${k.pick_no}` : ''} · ${k.by_user}`;

/** A Korber roll chosen by hand for a shade-report roll that had no matching pallet: same checks, always needs "Confirmed". */
async function manualCandidate(env: Env, pallet: string, m: ManualFor, lineItem: string): Promise<Candidate | undefined> {
  const k = await env.DB.prepare('SELECT * FROM korber WHERE pallet = ?').bind(up(pallet)).first<Row>();
  if (!k) return undefined;
  const checks: Record<string, boolean | null> = {
    item: normId(k.item) === normId(lineItem),
    lot: m.vendor_batch ? up(k.lot) === up(m.vendor_batch) : null,
    hu: m.roll_no ? up(k.supplier_hu) === up(m.roll_no) : null,
    qty: m.roll_qty ? Math.abs(Number(k.qty) - Number(m.roll_qty)) < 0.0005 : null,
    invoice: m.invoice ? up(k.invoice) === up(m.invoice) : null,
    po: m.po ? poMatch(await korberPo(env, k), { po: m.po }) : null,
    barcode: m.barcode ? up(k.pallet) === up(m.barcode) || (!!palletCore(m.barcode) && palletCore(k.pallet) === palletCore(m.barcode)) : false,
  };
  const warnings = [`Chosen by hand${m.barcode ? ` (ZCOMENT barcode ${m.barcode})` : ''}`];
  if (!checks.item) warnings.push(`Item ${k.item} ≠ ${lineItem}`);
  if (checks.lot === false) warnings.push(`Lot ${k.lot} ≠ vendor batch ${m.vendor_batch}`);
  if (checks.hu === false) warnings.push(`Supplier HU ${k.supplier_hu} ≠ roll ${m.roll_no}`);
  // QTY: Korber's Actual Qty is used; a different ZCOMENT Roll qty is not a warning
  if (checks.invoice === false) warnings.push(`Invoice ${k.invoice} ≠ ZINR ${m.invoice}`);
  if (checks.po === false) warnings.push(`Po Number ${(await korberPo(env, k)) ?? '–'} ≠ ZINR ${m.po}`);
  const pp = await palletPicks(env, k.pallet);
  const base = pp.base ?? Number(k.qty);
  const before = pp.before;
  return {
    pallet: String(k.pallet), item: String(k.item), lot: k.lot as string | null, supplier_hu: k.supplier_hu as string | null, location: k.location as string | null, uom: k.uom as string | null,
    invoice: k.invoice as string | null, actual_qty: Number(k.qty), base_qty: base, picked_before: before, available: Math.max(0, r3(base - before)), roll_qty: Number(m.roll_qty ?? k.qty),
    shade: m.shade ?? null, insp_lots: m.lot ? [String(m.lot)] : [], batches: m.batch ? [String(m.batch)] : [], checks, warnings, needsConfirm: true, raw: k.raw as string | null,
    picks: pp.picks,
  };
}

interface Candidate {
  pallet: string; item: string; lot: string | null; supplier_hu: string | null; location: string | null; uom: string | null; invoice: string | null;
  actual_qty: number; base_qty: number; picked_before: number; available: number; roll_qty: number; shade: string | null;
  insp_lots: string[]; batches: string[]; checks: Record<string, boolean | null>; warnings: string[]; needsConfirm: boolean; raw: string | null;
  picks: PalletPick[];
  /** matched straight from ZINR to Korber: Item + Lot Number = Vendor Batch + Invoice + Po (no ZCOMENT barcode) */
  direct?: boolean;
  /** in ZROLLMGT under the line's ZMMBE batch (System Batch) at the bin: Barcode Number = Korber Pallet */
  zroll?: boolean;
  /** ZROLLMGT Available Quantity when less than Korber's (reserved in SAP) */
  zrollAvail?: number;
  /** the ZCOMENT barcode is not a Korber pallet: found by Supplier Hu = Vendor Roll No (+ Lot, Invoice, Po) */
  byHu?: boolean;
  /** this lot's ZCOMENT row had no barcode: taken from the same roll's row under another inspection lot */
  borrowed?: boolean;
  /** the rest of the roll stays with this SO Plant (other SO lines on the roll have the same SO Plant, or none): no need to cut */
  sameSoPlant?: { plant: string; lines: string[] };
  /** that PO / invoice / lot is shared by several SO lines: the user ticks the rolls (the system does not) */
  pool?: number;
  /** of a shared lot: one of the rolls whose Actual Qty adds up to the lot's QTY (proposed, the user ticks) */
  suggested?: boolean;
  /** the barcode was found under another pallet label (e.g. COMPCP… for CP…) */
  via?: string | null; barcode?: string | null;
  /** the roll's QTY is split over batches in ZCOMENT and adds up to Korber's Actual Qty — or ZCOMENT differs and Korber's is used */
  qtyNote?: string | null; korberQty?: boolean;
  /** how much of the roll is in each batch of this line (ZCOMENT roll qty per inspection lot) */
  parts?: { batch: string; lot: string; qty: number }[];
}

/** "H26698956-P10_B" and "H26698956-P10" are the same invoice (a suffix after "_" is a part of it); a client prefix is left out */
const invRoot = (v: unknown) => up(v).replace(/^[A-Z]{2,10}-(?=[A-Z0-9]{3,}-)/, '').replace(/(_[A-Z0-9]+)+$/, '');
/** the Korber rolls that can be picked: Pick Id 0 (another Pick Id = already on a WMS pick) */
const PICKABLE = "COALESCE(pick_id, '0') IN ('0', '')";

/**
 * The ZROLLMGT check (Settings → Pick rules, on by default): a roll is picked only when its Barcode Number
 *   – is in ZROLLMGT at StorageBin EXPO-FIX (the bin in the settings),
 *   – is a ZCOMENT VIEW Barcode Number, and
 *   – is the Korber Pallet.
 * `env` is the Pick's scoped env (its own ZROLLMGT / ZCOMENT, else the shared ones). check() → null = pickable, else why not.
 */
async function makeGate(env: Env) {
  const st = await getSettings(env);
  const bin = up(st.pickBin || 'EXPO-FIX').replace(/\s+/g, '');
  const on = st.rollGate !== false;
  const loaded = on ? !!(await env.DB.prepare('SELECT 1 FROM zroll LIMIT 1').first()) : true;
  // ZROLLMGT Status: when the report has it, a roll is picked only at Status UR (unrestricted)
  const hasStatus = on && loaded ? !!(await env.DB.prepare("SELECT 1 FROM zroll WHERE COALESCE(status, '') <> '' LIMIT 1").first()) : false;
  const statusOk = (v: unknown) => ['UR', 'UNRESTRICTED', 'UNRESTRICTEDUSE', 'UNRESTRICTEDSTOCK', 'UNREST'].includes(up(v).replace(/[^A-Z]/g, ''));
  /** why one ZROLLMGT row is not pickable (null = it is): StorageBin, Status */
  const rowWhy = (z: Row): string | null => {
    if (up(z.bin).replace(/\s+/g, '') !== bin) return `ZROLLMGT StorageBin ${z.bin || '–'} — must be ${bin}`;
    if (hasStatus && !statusOk(z.status)) return `ZROLLMGT Status ${z.status || '–'} — must be UR`;
    if (z.qty !== null && z.qty !== undefined && Number(z.qty) <= 1e-9) return 'ZROLLMGT Available Quantity 0';
    return null;
  };
  /** the ZROLLMGT rows of a roll: its Barcode Number, else the same roll number (CP… / COMPCP…) */
  const rowsOf = async (ids: string[]) => {
    const zr = (await env.DB.prepare('SELECT barcode, bin, batch, status, material, qty FROM zroll WHERE barcode IN (SELECT value FROM json_each(?))').bind(JSON.stringify(ids)).all<Row>()).results;
    if (zr.length) return zr;
    const cores = Array.from(new Set(ids.map(palletCore).filter(Boolean)));
    return cores.length ? (await env.DB.prepare('SELECT barcode, bin, batch, status, material, qty FROM zroll WHERE pcore IN (SELECT value FROM json_each(?))').bind(JSON.stringify(cores)).all<Row>()).results : [];
  };
  // zc = the roll came by its ZCOMENT VIEW Barcode Number (that barcode must be a ZCOMENT one); a roll with no ZCOMENT barcode
  // (matched on invoice / lot / supplier HU) needs only its Korber Pallet in ZROLLMGT at the bin
  const check = async (pallet: string, barcode?: string | null, zc = true): Promise<string | null> => {
    if (!on) return null;
    if (!loaded) return 'No ZROLLMGT uploaded for this Pick';
    const idl = Array.from(new Set([up(barcode), up(pallet)].filter(Boolean)));
    const ids = JSON.stringify(idl);
    const zr = await rowsOf(idl);
    if (!zr.length) return 'Not in ZROLLMGT';
    if (!zr.some((z) => !rowWhy(z))) return Array.from(new Set(zr.map(rowWhy))).join(' · ');
    if (zc && !(await env.DB.prepare('SELECT 1 FROM zcoment WHERE barcode IN (SELECT value FROM json_each(?)) LIMIT 1').bind(ids).first())) return 'Not a ZCOMENT VIEW Barcode Number';
    return null;
  };
  /** of these Korber pallets, the ones in ZROLLMGT at the bin (all of them when the check is off) */
  const atBin = async (pallets: string[], batches?: Set<string>): Promise<Set<string>> => {
    const ps = Array.from(new Set(pallets.map(up).filter(Boolean)));
    if (!on) return new Set(ps);
    if (!loaded || !ps.length) return new Set();
    const out = new Set<string>();
    // and, when ZROLLMGT has the roll's System Batch, it must be one of the line's ZMMBE batches
    const fine = (z: Row) => !rowWhy(z) && (!batches?.size || !z.batch || batches.has(normId(z.batch)));
    const zr = (await env.DB.prepare('SELECT barcode, bin, batch, status, qty FROM zroll WHERE barcode IN (SELECT value FROM json_each(?))').bind(JSON.stringify(ps)).all<Row>()).results;
    for (const z of zr) if (fine(z)) out.add(up(z.barcode));
    // a Korber pallet whose ZROLLMGT barcode is written another way (same roll number)
    const rest = ps.filter((x) => !zr.some((z) => up(z.barcode) === x));
    const cores = new Map(rest.map((x) => [palletCore(x), x]).filter(([c0]) => !!c0) as [string, string][]);
    if (cores.size) for (const z of (await env.DB.prepare('SELECT barcode, bin, batch, status, pcore, qty FROM zroll WHERE pcore IN (SELECT value FROM json_each(?))').bind(JSON.stringify(Array.from(cores.keys()))).all<Row>()).results) if (fine(z)) out.add(cores.get(String(z.pcore))!);
    return out;
  };
  /** the roll's ZROLLMGT System Batch (null: not there / no batch) */
  /** ZROLLMGT Available Quantity of each pallet (only where ZROLLMGT has a quantity): a roll with a Reserved part has less */
  const availOf = async (pallets: string[]) => {
    const out = new Map<string, number>();
    if (!loaded || !pallets.length) return out;
    for (const z of (await env.DB.prepare('SELECT barcode, qty FROM zroll WHERE barcode IN (SELECT value FROM json_each(?)) AND qty IS NOT NULL').bind(JSON.stringify(Array.from(new Set(pallets.map(up))))).all<Row>()).results) out.set(up(z.barcode), Number(z.qty));
    return out;
  };
  const batchOf = async (pallet: string) => loaded ? ((await rowsOf([up(pallet)])).map((z) => z.batch as string | null).find(Boolean) ?? null) : null;
  const rowOk = (z: Row) => !on || !rowWhy(z);
  return { on, bin, loaded, hasStatus, check, atBin, rowOk, rowWhy, batchOf, availOf };
}

/**
 * The match chain for one plan line (the rules agreed with the warehouse):
 *  1. ZMMBE — SO + Material (= Plan Item Code) + LI: UR = Total stock − SO QI stock − SO Blocked stock − Assigned Qty, per batch.
 *     What to pick = the plan QTY, but never more than the UR (QTY > UR → the UR; QTY < UR → the QTY).
 *  2. ZINSR — Sales Order + Material + Line Item + Batch (the ZMMBE batches): the inspection lots and how much of each.
 *  3. ZCOMENT VIEW — Inspection # = the lot: its rolls (Vendor Batch, Vendor Roll No, Barcode Number).
 *  4. Korber (Pick Id 0 only; the master pick history: a pallet is never picked twice, only a cut roll's balance):
 *     a. Barcode Number = Pallet → selected by the system.
 *     b. No barcode (or not in Korber): Invoice Number = Vendor Invoice No (…_B is the same invoice) and Item Number = Material
 *        must agree; Lot Number = Vendor Batch must agree too — when no roll has it, the rolls of the invoice's other lots are
 *        offered ("pick by Lot Number"). Po Number = Purchasing Document and Supplier Hu = Vendor Roll No: when both agree
 *        (one roll) it is selected; otherwise the matching rolls are suggested, best first.
 *     c. A lot with no rolls in ZCOMENT: the rolls of its invoice + item + Lot Number (+ Po); when other SO lines share that
 *        Lot Number the system suggests the rolls whose Actual Qty adds up to the lot's QTY (the user ticks them).
 */
async function pickCandidates(env: Env, week: string, key: string, date: string, line: Row) {
  const steps: string[] = [];
  const lineId = `${key}|${date}`;
  const stock = (await env.DB.prepare("SELECT plant, sloc, so_plant, so, li, material, batch, style, ur, qi, block, assigned, total FROM stock WHERE src = 'zmmbe' AND key = ? ORDER BY batch").bind(key).all<Row>()).results;
  const pickedLine = Number((await env.DB.prepare('SELECT COALESCE(SUM(qty), 0) q FROM picks WHERE week = ? AND line = ? AND cancelled_at IS NULL').bind(week, lineId).first<{ q: number }>())?.q ?? 0);
  const urTotal = r3(stock.reduce((t, x) => t + Math.max(0, Number(x.ur) || 0), 0));
  const planQty = r3(Number(line.qty));
  // 1. what to pick: the plan QTY, at most the UR
  let need = r3(Math.min(planQty, urTotal));
  // the plan report's "Already sent" (ZMMBE at the plant storage locations): only the Pending (QTY − already sent) is picked.
  // Picks saved before the ZMMBE upload are in it once SAP moved them (the larger of the two counts); picks after it are not.
  let sentQ: number | null = null;
  if (await env.DB.prepare("SELECT 1 FROM stock_sent LIMIT 1").first()) {
    sentQ = r3(Number((await env.DB.prepare("SELECT SUM(COALESCE(total - COALESCE(qi, 0) - COALESCE(block, 0), ur)) q FROM stock_sent WHERE key = ?").bind(key).first<{ q: number | null }>())?.q ?? 0));
    const zAt = (await env.DB.prepare("SELECT MAX(uploaded_at) at FROM uploads WHERE src = 'zmmbe' AND rid IN (?1, '') ORDER BY (rid = ?1) DESC").bind(week).first<{ at: string | null }>())?.at ?? null;
    const after = zAt ? Number((await env.DB.prepare('SELECT COALESCE(SUM(qty), 0) q FROM picks WHERE week = ? AND line = ? AND cancelled_at IS NULL AND at > ?').bind(week, lineId, zAt).first<{ q: number }>())?.q ?? 0) : pickedLine;
    const before = Math.max(0, r3(pickedLine - after));
    const left2 = Math.max(0, r3(Math.min(planQty - Math.max(sentQ, before) - after, urTotal - after)));
    need = r3(pickedLine + left2);
    if (sentQ > 1e-9) steps.push(`Already sent ${sentQ} (ZMMBE at the plant storage locations): Pending = QTY ${planQty} − ${sentQ} = ${r3(planQty - sentQ)}${r3(planQty - sentQ) > urTotal + 1e-9 ? ` — the warehouse UR is ${urTotal}` : ''}.`);
  }
  if (!stock.length) steps.push('ZMMBE has no row for this SO / Material / LI — nothing can be picked.');
  else if (planQty > urTotal + 1e-9 && sentQ === null) steps.push(`Plan QTY ${planQty} is more than the UR ${urTotal} (Total − SO QI − SO Blocked − Assigned): the UR ${urTotal} is picked.`);
  // the plan QTY taken batch by batch (UR order: the bigger batch first), then lot by lot (2. ZINSR)
  const rejected = new Set((await env.DB.prepare('SELECT DISTINCT pallet FROM pick_reject').all<{ pallet: string }>()).results.map((x) => up(x.pallet)));
  const gate = await makeGate(env);
  const needZinsr = (await getSettings(env)).zrollNeedsZinsr !== false;
  if (gate.on && !gate.loaded) steps.push(`No ZROLLMGT uploaded for this Pick — upload it (Data tab or the Pick card): only rolls at StorageBin ${gate.bin} can be picked.`);
  // the ZMMBE batches of this line that have UR: a ZCOMENT VIEW roll of another batch is not picked
  const urBatches = new Set(stock.filter((x) => Number(x.ur) > 0).map((x) => normId(x.batch)));
  const blocked: Row[] = [];
  let batchSkip = 0;
  const lots: Row[] = [];
  let left = Math.max(0, r3(need - pickedLine));
  const lotsByBatch: { st: Row; z: Row[] }[] = [];
  for (const st of [...stock].sort((a, b) => Number(b.ur) - Number(a.ur))) {
    if (!(Number(st.ur) > 0)) continue;
    const z = (await env.DB.prepare('SELECT * FROM zinr WHERE so = ? AND li = ? AND material = ? AND batch = ? ORDER BY lot').bind(st.so, st.li, st.material, st.batch).all<Row>()).results;
    if (!z.length) steps.push(`Batch ${st.batch}: not in ZINSR for this SO / LI / Material.`);
    lotsByBatch.push({ st, z });
  }
  // what ZINSR has for this Sales Order: its Line Items (only this one is taken) and this Line Item's batches and lots
  {
    const all = (await env.DB.prepare('SELECT li, batch, lot FROM zinr WHERE so = ? AND material = ?').bind(normId(line.so), normId(line.item)).all<Row>()).results;
    const lis = Array.from(new Set(all.map((x) => String(x.li)))).sort((a, b) => Number(a) - Number(b));
    const mine = all.filter((x) => normId(x.li) === normId(line.li));
    const ub = new Set(stock.filter((x) => Number(x.ur) > 0).map((x) => normId(x.batch)));
    const byB = new Map<string, string[]>(); for (const x of mine) byB.set(String(x.batch), [...(byB.get(String(x.batch)) || []), String(x.lot)]);
    if (all.length) steps.push(`ZINSR — SO ${line.so}: Line Item${lis.length === 1 ? '' : 's'} ${lis.join(', ')}; LI ${line.li} only: ${Array.from(byB).map(([b0, ls]) => `batch ${b0}${ub.has(normId(b0)) ? '' : ' (no UR in ZMMBE — not taken)'} → lot${ls.length === 1 ? '' : 's'} ${ls.join(', ')}`).join(' · ') || 'no lot'}.`);
  }
  // every ZINSR lot of this SO + Line Item + Material (its batches with UR)
  const lineLots = new Set(lotsByBatch.flatMap((x) => x.z.map((l) => String(l.lot))));
  for (const { st, z } of lotsByBatch) {
    let batchLeft = Math.min(left, Number(st.ur));
    for (const x of z) {
      if (lots.some((l) => l.lot === x.lot)) continue;
      const take = r3(Math.max(0, Math.min(batchLeft, Number(x.qty) || 0)));
      lots.push({ ...x, zmmbe_ur: st.ur, zmmbe_sloc: st.sloc, lot_need: take, qty_ok: true });
      batchLeft = r3(batchLeft - take); left = r3(left - take);
    }
  }
  const rolls = new Map<string, Candidate>();
  const lotInfo: Row[] = [];
  const manual: Row[] = [];
  const nobarcode: Row[] = [];
  const korberBase = async (k: Row, lot: Row, extra: Partial<Candidate>): Promise<Candidate> => ({
    pallet: String(k.pallet), item: String(k.item), lot: k.lot as string | null, supplier_hu: k.supplier_hu as string | null, location: k.location as string | null, uom: k.uom as string | null,
    invoice: k.invoice as string | null, actual_qty: Number(k.qty), base_qty: Number(k.qty), picked_before: 0, available: Number(k.qty), roll_qty: Number(k.qty),
    shade: null, insp_lots: [String(lot.lot)], batches: [String(lot.batch)], checks: {}, warnings: [], needsConfirm: false, raw: k.raw as string | null, picks: [],
    parts: [{ batch: String(lot.batch), lot: String(lot.lot), qty: Number(k.qty) }], ...extra,
  });
  const addRoll = (c: Candidate, lot: Row) => {
    const prev = rolls.get(c.pallet);
    if (prev) { if (!prev.insp_lots.includes(String(lot.lot))) prev.insp_lots.push(String(lot.lot)); if (!prev.batches.includes(String(lot.batch))) prev.batches.push(String(lot.batch)); return; }
    rolls.set(c.pallet, c);
  };
  // pallets that are the Barcode Number of a ZCOMENT roll belong to that roll
  const ownedBy = async (pallet: string) => (await env.DB.prepare('SELECT lot, roll_no FROM zcoment WHERE barcode = ? LIMIT 1').bind(up(pallet)).first<Row>()) ?? null;
  let notPickable = 0, rejectedSkip = 0;
  for (const lot of lots) {
    const rows0 = (await env.DB.prepare('SELECT * FROM zcoment WHERE lot = ? ORDER BY sys_roll, roll_no').bind(lot.lot).all<Row>()).results;
    lotInfo.push({ lot: lot.lot, batch: lot.batch, qty: lot.qty, need: lot.lot_need, ur: lot.zmmbe_ur, qty_ok: true, invoice: lot.invoice, po: lot.po, vendor_batch: lot.vendor_batch, sloc: lot.sloc, rolls: rows0.length, roll_sum: 0, noShade: !rows0.length });
    // the Korber rolls of this lot's invoice + item (must), Pick Id 0
    const base0 = (await env.DB.prepare(`SELECT * FROM korber WHERE item = ? AND ${PICKABLE}`).bind(normId(lot.material)).all<Row>()).results.filter((k) => !lot.invoice || invRoot(k.invoice) === invRoot(lot.invoice));
    // ZROLLMGT check: a roll without a ZCOMENT barcode is picked only when its Korber Pallet is in ZROLLMGT at the bin
    const okBin = await gate.atBin(base0.map((k) => String(k.pallet)), urBatches);
    const base = base0.filter((k) => okBin.has(up(k.pallet)));
    const offBin = base0.length - base.length;
    const usable = (k: Row) => { if (rejected.has(up(k.pallet))) { rejectedSkip++; return false; } return true; };
    if (!rows0.length) {
      // 4c. no rolls in ZCOMENT: the rolls of the invoice + item + Lot Number (= Vendor Batch), Po preferred
      const vb = up(lot.vendor_batch);
      const byLot = base.filter((k) => up(k.lot) === vb && usable(k));
      const owned: Row[] = [];
      for (const k of byLot) if (await ownedBy(String(k.pallet))) owned.push(k);
      const free = byLot.filter((k) => !owned.includes(k));
      // the separate category: Korber rolls of the same Invoice + Item (Po first) with another Lot Number — not the barcode of a
      // ZCOMENT roll — that the user may tick for this lot (several), each confirmed ("I checked") as its Lot Number differs
      {
        const inv: Row[] = [];
        const zcOf = new Map<string, string>();
        for (const k of base) {
          if (up(k.lot) === vb || !usable(k)) continue;
          // the barcode of a ZCOMENT roll: only when that roll is in a ZINSR lot of this same SO + Line Item (another lot of it);
          // a roll of another SO / Line Item's lot is that line's roll, even with the same batch
          const own = (await env.DB.prepare('SELECT lot, batch FROM zcoment WHERE barcode = ?').bind(up(k.pallet)).all<Row>()).results;
          if (own.length && !own.some((o) => lineLots.has(String(o.lot)) && urBatches.has(normId(o.batch)))) continue;
          if (own.length) zcOf.set(up(k.pallet), own.map((o) => o.lot).join(', '));
          inv.push(k);
        }
        if (inv.length) {
          const opts = await nbOptions(env, inv, lot, null, 80);
          for (const o of opts) if (zcOf.has(up(o.pallet))) o.zcLots = zcOf.get(up(o.pallet));
          nobarcode.push({ lot: lot.lot, batch: lot.batch, material: lot.material, vendor_batch: lot.vendor_batch, roll_no: null, barcode: null, roll_qty: lot.lot_need, shade: null, invoice: lot.invoice, po: lot.po, noShade: true, invChoice: true,
            options: opts });
          steps.push(`Inspection lot ${lot.lot}: ${inv.length} Korber roll${inv.length === 1 ? '' : 's'} of invoice ${lot.invoice ?? '–'} + item${lot.po ? ' (Po first)' : ''} with another Lot Number — under “Invoice + Item match”: tick the ones to pick.`);
        }
      }
      if (!free.length) {
        // Lot Number not found: offered by Lot Number (the invoice's other lots of the item)
        const other = base.filter((k) => up(k.lot) !== vb && usable(k));
        steps.push(`Inspection lot ${lot.lot}: no Korber roll with Lot Number ${lot.vendor_batch ?? '–'} on invoice ${lot.invoice ?? '–'}${gate.on && offBin ? ` in ZROLLMGT at ${gate.bin} (${offBin} roll${offBin === 1 ? '' : 's'} of the invoice + item are not)` : ''}${other.length ? ' — choose the rolls under “Invoice + Item match”' : ''}.`);
        if (!other.length) manual.push({ lot: lot.lot, batch: lot.batch, material: lot.material, vendor_batch: lot.vendor_batch, roll_no: null, barcode: null, roll_qty: lot.lot_need, shade: null, invoice: lot.invoice, po: lot.po,
          reason: `No Korber roll of item ${lot.material} on invoice ${lot.invoice ?? '–'} (Pick Id 0${gate.on ? `, in ZROLLMGT at ${gate.bin}` : ''})`, suggest: [] });
        continue;
      }
      // other SO lines whose inspection lots have the same Lot Number on the same invoice: the rolls are shared — suggested, not selected
      const sharers = (await env.DB.prepare('SELECT DISTINCT so, li FROM zinr WHERE material = ?1 AND upper(vendor_batch) = ?2 AND NOT (so = ?3 AND li = ?4)').bind(normId(lot.material), vb, normId(line.so), normId(line.li)).all<Row>()).results
        .filter(() => true);
      const cands: Candidate[] = [];
      for (const k of free) {
        const po = lot.po ? poMatch(await korberPo(env, k), lot) : null;
        cands.push(await korberBase(k, lot, { direct: true, checks: { item: true, invoice: lot.invoice ? true : null, lot: true, po, hu: null },
          ...(sharers.length ? { pool: sharers.length + 1 } : {}),
          warnings: po === false ? [`Po Number ${(await korberPo(env, k)) ?? '–'} ≠ ZINSR ${lot.po}`] : [], needsConfirm: po === false,
          qtyNote: `ZINSR → Korber: invoice ${lot.invoice ?? '–'} · item · Lot ${lot.vendor_batch}${po ? ' · Po' : ''} (no rolls in ZCOMENT VIEW)` }));
      }
      // Po first, then the rolls whose Actual Qty adds up to this lot's QTY
      cands.sort((a, b) => Number(b.checks.po === true) - Number(a.checks.po === true));
      if (sharers.length) {
        // the shared Lot Number's rolls are split over all its inspection lots (lot by lot, each the rolls adding up to its QTY),
        // so every SO line gets its own suggestion and two lines are not offered the same rolls
        // (only the lots of SO lines that still have UR in ZMMBE: a line already issued needs no rolls)
        const lotsOfVb = (await env.DB.prepare(`SELECT z.lot, z.qty, z.so, z.li FROM zinr z WHERE z.material = ?1 AND upper(z.vendor_batch) = ?2
          AND EXISTS (SELECT 1 FROM stock s WHERE s.src = 'zmmbe' AND s.so = z.so AND s.li = z.li AND s.material = z.material AND s.batch = z.batch AND s.ur > 0) ORDER BY z.lot`).bind(normId(lot.material), vb).all<Row>()).results;
        const avail = new Map<string, number>();
        for (const c of cands) { const pp = await palletPicks(env, c.pallet); avail.set(c.pallet, Math.max(0, r3((pp.base ?? c.actual_qty) - pp.before))); }
        let pool0 = cands.filter((c) => c.checks.po !== false && (avail.get(c.pallet) ?? 0) > 1e-9).map((c) => ({ id: c.pallet, q: avail.get(c.pallet)! }));
        let pickSet = new Set<string>();
        for (const l0 of lotsOfVb) {
          const isMine = String(l0.lot) === String(lot.lot);
          // every line splits the same way: each lot by its own Insp. Lot Quantity
          const set = subsetToQty(pool0, Number(l0.qty));
          if (isMine) { pickSet = set; break; }
          pool0 = pool0.filter((x) => !set.has(x.id));
        }
        for (const c of cands) if (pickSet.has(c.pallet)) c.suggested = true;
        steps.push(`Inspection lot ${lot.lot}: Lot Number ${lot.vendor_batch} is shared with ${sharers.length} other SO line${sharers.length === 1 ? '' : 's'} (${sharers.slice(0, 4).map((x) => `${x.so}/${x.li}`).join(', ')}) and ZCOMENT VIEW has no rolls for it — ${pickSet.size} roll${pickSet.size === 1 ? '' : 's'} adding up to ${lot.lot_need} are suggested: tick them (or others).`);
      }
      for (const c of cands) addRoll(c, lot);
      continue;
    }
    for (const sh of rows0) {
      if (!sh.material) sh.material = lot.material;
      const shade = sh.shade as string | null;
      // ZMMBE batch rule: only the rolls of the line's ZMMBE batches (with UR)
      if (sh.batch && urBatches.size && !urBatches.has(normId(sh.batch))) { batchSkip++; continue; }
      const block = (why: string, k?: Row | null) => blocked.push({ lot: lot.lot, batch: sh.batch || lot.batch, roll_no: sh.roll_no ?? null, barcode: sh.barcode ?? null, shade,
        pallet: k ? k.pallet : null, qty: k ? Number(k.qty) : (Number(sh.roll_qty) || null), why });
      // 4a. Barcode Number = Pallet: selected
      let k: Row | null = null;
      if (sh.barcode) {
        k = (await env.DB.prepare('SELECT * FROM korber WHERE pallet = ?').bind(up(sh.barcode)).first<Row>())
          ?? (palletCore(sh.barcode) ? (await env.DB.prepare('SELECT * FROM korber WHERE pcore = ? AND item = ? LIMIT 1').bind(palletCore(sh.barcode), normId(lot.material)).first<Row>()) : null);
        if (k && usable(k)) {
          if (String(k.pick_id ?? '0') !== '0' && String(k.pick_id ?? '') !== '') { notPickable++; continue; }
          const why = await gate.check(String(k.pallet), sh.barcode as string);
          if (why) { block(why, k); continue; }
          // the roll's ZROLLMGT System Batch must be a ZMMBE batch of the line
          const zb = await gate.batchOf(String(k.pallet));
          if (zb && urBatches.size && !urBatches.has(normId(zb))) { block(`ZROLLMGT System Batch ${zb} is not this line's ZMMBE batch (${Array.from(urBatches).join(', ')})`, k); continue; }
          const itemOk = normId(k.item) === normId(lot.material);
          addRoll(await korberBase(k, lot, { shade, barcode: sh.barcode as string, via: up(k.pallet) === up(sh.barcode) ? null : String(k.pallet),
            checks: { item: itemOk, lot: up(k.lot) === up(sh.vendor_batch || lot.vendor_batch), hu: sh.roll_no ? up(k.supplier_hu) === up(sh.roll_no) : null, invoice: lot.invoice && k.invoice ? invRoot(k.invoice) === invRoot(lot.invoice) : null },
            warnings: itemOk ? [] : [`Item ${k.item} ≠ ${lot.material}`], needsConfirm: !itemOk }), lot);
          continue;
        }
      }
      // ZROLLMGT check: a ZCOMENT barcode must be the Korber Pallet; a roll with no barcode is matched below (its Korber roll must be in ZROLLMGT at the bin)
      if (gate.on && sh.barcode) { if (!k) block(`Barcode ${sh.barcode} is not in Korber Inventory`); continue; }
      // 4b. no barcode / not in Korber: invoice + item (must), Lot Number (must, else by Lot Number), Po and Supplier Hu (preferred)
      const vb = up(sh.vendor_batch || lot.vendor_batch), hu = up(sh.roll_no);
      const others: Row[] = [];
      for (const k of base) {
        if (!usable(k) || rolls.has(String(k.pallet))) continue;
        const o = await ownedBy(String(k.pallet));
        if (o && !(String(o.lot) === String(sh.lot) && up(o.roll_no) === hu)) continue; // another roll's barcode
        others.push(k);
      }
      const byLot = others.filter((k) => up(k.lot) === vb);
      const pool = byLot.length ? byLot : others;
      const opts = await nbOptions(env, pool, lot, sh);
      const ck = (o: Row) => o.checks as Record<string, boolean | null>;
      const perfect = opts.filter((o) => ck(o).lot && ck(o).hu && ck(o).po !== false && Number(o.available) > 1e-9);
      if (perfect.length === 1) {
        const k = pool.find((x) => up(x.pallet) === up(perfect[0].pallet))!;
        addRoll(await korberBase(k, lot, { shade, byHu: true, barcode: (sh.barcode as string) || null, checks: perfect[0].checks as Record<string, boolean | null>,
          qtyNote: `${sh.barcode ? `Barcode ${sh.barcode} is not in Korber — ` : 'No Barcode Number — '}matched on Invoice, Item, Lot ${k.lot}, Supplier Hu ${k.supplier_hu}${ck(perfect[0]).po ? ', Po' : ''}` }), lot);
        continue;
      }
      if (opts.length) nobarcode.push({ lot: lot.lot, batch: lot.batch, material: lot.material, vendor_batch: sh.vendor_batch, roll_no: sh.roll_no, barcode: null, roll_qty: sh.roll_qty, shade, invoice: lot.invoice, po: lot.po,
        ...(sh.barcode ? { zcBarcode: sh.barcode } : {}), ...(byLot.length ? {} : { lotChoice: true }), options: opts, done: opts.every((o) => Number(o.picked_before) > 0 && Number(o.available) <= 1e-9) });
      else manual.push({ lot: lot.lot, batch: lot.batch, material: lot.material, vendor_batch: sh.vendor_batch, roll_no: sh.roll_no, barcode: sh.barcode ?? null, roll_qty: sh.roll_qty, shade, invoice: lot.invoice, po: lot.po,
        reason: `No Korber roll of item ${lot.material} on invoice ${lot.invoice ?? '–'}${sh.barcode ? ` (barcode ${sh.barcode} is not in Korber)` : ''}${gate.on ? ` in ZROLLMGT at ${gate.bin}` : ''}`, suggest: [] });
    }
  }
  // 4z. ZMMBE batch → ZROLLMGT System Batch (same Material, StorageBin at the bin, Status UR) → its Barcode Number = Korber Pallet
  // (Pick Id 0): the rolls of the batch straight from SAP's roll management (also a batch with no ZINSR lot / no ZCOMENT barcode)
  if (gate.loaded) {
    const seenBlock = new Set(blocked.map((b0) => up(b0.barcode || b0.pallet)));
    const mat = normId(line.item);
    for (const st of stock.filter((x) => Number(x.ur) > 0)) {
      const bt = normId(st.batch);
      const zr0 = (await env.DB.prepare('SELECT barcode, bin, batch, status, material, qty, pcore, so, li FROM zroll WHERE batch = ?').bind(bt).all<Row>()).results;
      // the same Material (a ZROLLMGT row without Material counts; the Korber item is checked below)
      const zr = zr0.filter((z) => !z.material || normId(z.material) === mat || normId(z.material) === normId(st.material));
      if (!zr.length) { steps.push(`Batch ${st.batch}: ZROLLMGT has no roll with System Batch ${bt}${zr0.length ? ` of material ${mat} (${zr0.length} of another material)` : ''}.`); continue; }
      // ZINSR must agree too: Sales Order + Line Item + Material + Batch = the plan line's SO / LI / Item and this batch
      const zi = lotsByBatch.find((x) => normId(x.st.batch) === bt)?.z ?? [];
      if (!zi.length && !needZinsr) {
        // Settings → Pick rules: ZINSR not required for this path — the batch's rolls are this line's when no other SO line has the batch
        zi.push({ lot: '', batch: bt, material: st.material, so: line.so, li: line.li } as Row);
      }
      if (!zi.length) {
        steps.push(`Batch ${st.batch}: ZINSR has no Sales Order ${line.so} + Line Item ${line.li} + Material ${mat} + Batch ${bt} — its ${zr.length} ZROLLMGT roll${zr.length === 1 ? ' is' : 's are'} not taken.`);
        for (const z of zr) {
          const pal = up(z.barcode);
          if (rolls.has(pal) || seenBlock.has(pal)) continue;
          seenBlock.add(pal);
          blocked.push({ lot: '–', batch: st.batch, roll_no: null, barcode: pal, shade: null, pallet: pal, qty: Number(z.qty) || null, why: `ZINSR has no SO ${line.so} / LI ${line.li} / Material ${mat} / Batch ${bt}` });
        }
        continue;
      }
      const lot0: Row = lots.find((l) => normId(l.batch) === bt) ?? { ...zi[0], lot_need: 0 };
      // exactly this SO + LI: the ZINSR lots of this Sales Order + Line Item + Material + Batch (one SO has several Line Items,
      // one Line Item several batches, one batch several lots — and the same batch can be in other SO lines too)
      const myLots = new Set(zi.map((l) => String(l.lot)).filter(Boolean));
      // other SO lines with this batch: in ZINSR, or with UR of it in ZMMBE
      const sharers = (await env.DB.prepare(`SELECT so, li FROM zinr WHERE material = ?1 AND batch = ?2 AND NOT (so = ?3 AND li = ?4)
        UNION SELECT so, li FROM stock WHERE src = 'zmmbe' AND material = ?1 AND batch = ?2 AND ur > 0 AND NOT (so = ?3 AND li = ?4)`).bind(mat, bt, normId(line.so), normId(line.li)).all<Row>()).results;
      let added = 0, known = 0, off = 0, noK = 0, other = 0, otherLine = 0, shared = 0;
      for (const z of zr) {
        const pal = up(z.barcode);
        // ZROLLMGT with its own Sales Order / Line Item: must be this line's
        if ((z.so && normId(z.so) !== normId(line.so)) || (z.li && normId(z.li) !== normId(line.li))) { otherLine++; continue; }
        // its Korber pallet: the Barcode Number, else the same roll number (CP… / COMPCP…) of the same item
        let k = await env.DB.prepare('SELECT * FROM korber WHERE pallet = ?').bind(pal).first<Row>();
        if (!k && z.pcore) k = await env.DB.prepare('SELECT * FROM korber WHERE pcore = ? AND item = ? LIMIT 1').bind(z.pcore, mat).first<Row>();
        const kp = k ? up(k.pallet) : pal;
        if (rolls.has(kp)) { rolls.get(kp)!.zroll = true; known++; continue; }
        const why = gate.on ? gate.rowWhy(z) : null;
        if (why) {
          off++;
          if (!seenBlock.has(kp)) { seenBlock.add(kp); blocked.push({ lot: lot0.lot || '–', batch: st.batch, roll_no: null, barcode: pal, shade: null, pallet: k ? kp : null, qty: k ? Number(k.qty) : Number(z.qty) || null, why }); }
          continue;
        }
        if (!k) { noK++; continue; }
        if (normId(k.item) !== mat) { other++; continue; }
        if (rejected.has(kp)) { rejectedSkip++; continue; }
        if (String(k.pick_id ?? '0') !== '0' && String(k.pick_id ?? '') !== '') { notPickable++; continue; }
        // the roll's ZCOMENT lots: when it has some, one must be a ZINSR lot of this SO + LI + batch (else it is another line's roll)
        const zcl = (await env.DB.prepare('SELECT shade, lot FROM zcoment WHERE barcode IN (?, ?)').bind(pal, kp).all<Row>()).results;
        const mine = zcl.find((x) => myLots.has(String(x.lot)));
        if (zcl.length && !mine) { otherLine++; continue; }
        const sh = mine ?? zcl[0] ?? null;
        const l1 = sh?.lot ? { ...lot0, lot: sh.lot } : lot0;
        // no ZCOMENT lot to tell which SO line the roll is for, and the batch is in other SO lines too: offered, not selected
        const pool = !mine && sharers.length ? sharers.length + 1 : undefined;
        if (pool) shared++;
        addRoll(await korberBase(k, l1, { shade: (sh?.shade as string) ?? null, zroll: true, via: kp !== pal ? kp : null, ...(pool ? { pool } : {}),
          checks: { item: true, batch: true, bin: true, lot: null, hu: null, invoice: lot0.invoice && k.invoice ? invRoot(k.invoice) === invRoot(lot0.invoice) : null },
          qtyNote: `ZMMBE batch ${st.batch}${myLots.size ? ` = ZINSR SO ${line.so} / LI ${line.li} / Material / Batch (ZINSR lot ${Array.from(myLots).join(', ')})` : ' (ZINSR not required — Settings)'} = ZROLLMGT System Batch → Barcode ${pal}${kp !== pal ? ` (Korber pallet ${kp})` : ''} = Korber Pallet${gate.on ? ` · StorageBin ${gate.bin}${gate.hasStatus ? ' · Status UR' : ''}` : ''}` }), l1);
        added++;
      }
      steps.push(`Batch ${st.batch}: ZROLLMGT has ${zr.length} roll${zr.length === 1 ? '' : 's'} with this System Batch${added ? ` — ${added} matched straight to Korber` : ''}${known ? `, ${known} already matched` : ''}${otherLine ? `, ${otherLine} belong to another SO / Line Item (ZCOMENT lot / ZROLLMGT SO)` : ''}${off ? `, ${off} not pickable (bin / status)` : ''}${noK ? `, ${noK} not in this Pick's Korber` : ''}${other ? `, ${other} another item in Korber` : ''}.${shared ? ` ${shared} roll${shared === 1 ? ' has' : 's have'} no ZCOMENT lot and batch ${bt} is in ${sharers.length} other SO line${sharers.length === 1 ? '' : 's'} (${sharers.slice(0, 4).map((x) => `${x.so}/${x.li}`).join(', ')}) — tick them yourself.` : ''}`);
    }
  } else if (gate.on) steps.push('ZMMBE batch → ZROLLMGT System Batch: no ZROLLMGT uploaded for this Pick.');
  // the Invoice + Item category offers only rolls not matched already (a matched roll is ticked in Matched rolls)
  for (let i = nobarcode.length - 1; i >= 0; i--) {
    const m = nobarcode[i];
    if (!m.invChoice) continue;
    m.options = (m.options as Row[]).filter((o) => !rolls.has(up(o.pallet)));
    if (!(m.options as Row[]).length) nobarcode.splice(i, 1);
  }
  if (batchSkip) steps.push(`${batchSkip} ZCOMENT VIEW roll${batchSkip === 1 ? '' : 's'} of a batch that is not this line's ZMMBE batch with UR (${Array.from(urBatches).join(', ')}) — left out.`);
  if (blocked.length) {
    const why = new Map<string, number>();
    for (const b0 of blocked) { const w = String(b0.why).replace(/^Barcode \S+ is not in Korber Inventory$/, 'Barcode not in Korber Inventory').replace(/^ZROLLMGT StorageBin .*/, `ZROLLMGT StorageBin not ${gate.bin}`).replace(/^ZROLLMGT System Batch .*/, 'ZROLLMGT System Batch not the ZMMBE batch').replace(/^ZROLLMGT Status .*/, 'ZROLLMGT Status not UR').replace(/^ZINSR has no SO .*/, 'ZINSR SO / LI / Material / Batch not matched'); why.set(w, (why.get(w) || 0) + 1); }
    steps.push(`${blocked.length} roll${blocked.length === 1 ? '' : 's'} not pickable (ZROLLMGT check): ${Array.from(why).map(([w, n]) => `${n} × ${w}`).join(' · ')}.`);
  }
  if (notPickable) steps.push(`${notPickable} roll${notPickable === 1 ? ' is' : 's are'} already on a Korber (WMS) pick — Pick Id not 0 — and left out.`);
  if (rejectedSkip) steps.push(`${rejectedSkip} rejected roll${rejectedSkip === 1 ? ' is' : 's are'} left out.`);
  const nLot = nobarcode.filter((m) => m.lotChoice).length, nNb = nobarcode.filter((m) => !m.invChoice).length - nLot;
  if (nNb) steps.push(`${nNb} roll${nNb === 1 ? '' : 's'} without a Korber barcode: choose the Korber roll under “No Barcode — choose the roll” (Invoice, Item and Lot agree; Po / Supplier Hu matches first).`);
  if (nLot) steps.push(`${nLot} roll${nLot === 1 ? '' : 's'} / lot${nLot === 1 ? '' : 's'} whose Lot Number is not in Korber: choose a roll of the invoice's other lots (Pick by Lot Number).`);
  // the master pick history: a pallet picked in full is gone, a cut roll keeps its balance
  for (const r of rolls.values()) {
    const pp = await palletPicks(env, r.pallet);
    if (!pp.picks.length) continue;
    r.base_qty = pp.base ?? r.actual_qty;
    r.picked_before = pp.before;
    r.available = Math.max(0, r3(r.base_qty - r.picked_before));
    r.picks = pp.picks;
  }
  // The same physical roll in the inspection lots of several SO lines (SAP lists a shared batch's rolls in each SO line's
  // lot): it is not this line's alone. Such rolls are offered, not selected — and split over the SO lines the same way for
  // every line (SO / LI order, each SO line its lots' QTY), so two lines are not given the same rolls.
  for (const bt of urBatches) {
    const lotsAll = (await env.DB.prepare(`SELECT z.lot, z.qty, z.so, z.li FROM zinr z WHERE z.material = ?1 AND z.batch = ?2
      AND EXISTS (SELECT 1 FROM stock s WHERE s.src = 'zmmbe' AND s.so = z.so AND s.li = z.li AND s.material = z.material AND s.batch = z.batch AND s.ur > 0) ORDER BY z.so, z.li, z.lot`).bind(normId(line.item), bt).all<Row>()).results;
    const sol = (x: Row) => `${normId(x.so)}/${normId(x.li)}`;
    const me = `${normId(line.so)}/${normId(line.li)}`;
    if (new Set(lotsAll.map(sol)).size < 2) continue;
    // each barcode → the SO lines whose lots have it
    const owners = new Map<string, Set<string>>();
    for (const l0 of lotsAll) for (const z of (await env.DB.prepare('SELECT barcode FROM zcoment WHERE lot = ? AND barcode IS NOT NULL').bind(l0.lot).all<Row>()).results) {
      const b0 = up(z.barcode); if (!owners.has(b0)) owners.set(b0, new Set()); owners.get(b0)!.add(sol(l0));
    }
    const mineShared = Array.from(rolls.values()).filter((r) => r.batches.some((x) => normId(x) === bt) && ((owners.get(up(r.pallet))?.size ?? 0) > 1 || (owners.get(up(r.barcode ?? ''))?.size ?? 0) > 1));
    if (!mineShared.length) continue;
    // the pool: every shared roll of the batch that can be picked now (the same list for every SO line)
    const sharedBc = Array.from(owners).filter(([, o]) => o.size > 1).map(([b0]) => b0).sort();
    const pool: { id: string; q: number }[] = [];
    for (const b0 of sharedBc) {
      const k = await env.DB.prepare(`SELECT pallet, qty FROM korber WHERE pallet = ? AND ${PICKABLE}`).bind(b0).first<Row>();
      if (!k || rejected.has(up(k.pallet)) || (await gate.check(String(k.pallet), b0))) continue;
      const pp = await palletPicks(env, String(k.pallet));
      const a = Math.max(0, r3((pp.base ?? Number(k.qty)) - pp.before));
      if (a > 1e-9) pool.push({ id: up(k.pallet), q: a });
    }
    // SO line by SO line: its lots' QTY from the rolls still free
    const perLine = new Map<string, number>(); for (const l0 of lotsAll) perLine.set(sol(l0), r3((perLine.get(sol(l0)) ?? 0) + Number(l0.qty || 0)));
    let free = pool, mineSet = new Set<string>();
    for (const [sl, q0] of perLine) {
      const set = subsetToQty(free, q0);
      if (sl === me) { mineSet = set; break; }
      free = free.filter((x) => !set.has(x.id));
    }
    const nLines = perLine.size;
    for (const r of mineShared) {
      r.pool = nLines; r.suggested = mineSet.has(up(r.pallet));
      r.qtyNote = [r.qtyNote, `This roll is in the inspection lots of ${nLines} SO lines (batch ${bt}) — ${r.suggested ? 'suggested for this line' : 'suggested for another line'}`].filter(Boolean).join(' · ');
    }
    steps.push(`Batch ${bt}: ${mineShared.length} roll${mineShared.length === 1 ? ' is' : 's are'} in the inspection lots of ${nLines} SO lines (${Array.from(perLine.keys()).slice(0, 4).join(', ')}${nLines > 4 ? '…' : ''}) — ${mineSet.size} suggested for this line (lot QTY ${perLine.get(me) ?? 0}): tick them with “Select suggested rolls”.`);
  }
  // ZROLLMGT Available Quantity: a roll with a Reserved part in SAP is picked only up to what SAP has available
  if (gate.on) {
    const av = await gate.availOf(Array.from(rolls.keys()));
    for (const r of rolls.values()) {
      const a = av.get(up(r.pallet));
      if (a !== undefined && a < r.available - 1e-6) { r.available = Math.max(0, r3(a)); r.zrollAvail = r3(a); r.qtyNote = [r.qtyNote, `ZROLLMGT Available Quantity ${r3(a)} (less than Korber ${r.actual_qty} — reserved in SAP)`].filter(Boolean).join(' · '); }
    }
  }
  const list = Array.from(rolls.values()).sort((a, b) => Number(b.available > 0) - Number(a.available > 0) || Number(!!b.suggested) - Number(!!a.suggested) || String(a.lot).localeCompare(String(b.lot)) || String(a.supplier_hu).localeCompare(String(b.supplier_hu), undefined, { numeric: true }));
  const matchedAvail = r3(list.filter((r) => !r.pool || r.suggested).reduce((t, r) => t + r.available, 0));
  const nbAvail = r3(nobarcode.filter((m) => !m.done && !m.invChoice).reduce((t, m) => {
    const best = Math.max(0, ...(m.options as Row[]).map((o) => Number(o.available)));
    return t + (Number(m.roll_qty) > 0 ? Math.min(best, Number(m.roll_qty)) : best);
  }, 0));
  const shortfall = Math.max(0, r3(need - pickedLine - matchedAvail - nbAvail));
  if (manual.length && shortfall > 0) steps.push(`The matched rolls leave ${shortfall}: pick it by hand under "Manual pick".`);
  // what is still needed from each batch (for splitting the picked QTY over the batches)
  const byBatch = new Map<string, { batch: string; lots: string[]; ur: number; picked: number; need: number }>();
  for (const l of lotInfo) {
    const b = byBatch.get(String(l.batch)) || { batch: String(l.batch), lots: [], ur: 0, picked: 0, need: 0 };
    b.lots.push(String(l.lot)); b.ur = r3(b.ur + Number(l.need ?? l.qty)); byBatch.set(b.batch, b);
  }
  const done = (await env.DB.prepare('SELECT pallet, qty, batch FROM picks WHERE week = ? AND line = ? AND cancelled_at IS NULL').bind(week, lineId).all<{ pallet: string; qty: number; batch: string | null }>()).results;
  for (const d of done) {
    let q = Number(d.qty);
    for (const b0 of String(d.batch ?? '').split(',').filter(Boolean)) { const b = byBatch.get(b0); if (!b || q <= 0) continue; b.picked = r3(b.picked + q); q = 0; }
    if (q > 1e-9) { const b = [...byBatch.values()].sort((a, c) => c.ur - a.ur)[0]; if (b) b.picked = r3(b.picked + q); }
  }
  // batch need = its share of the line's pick QTY (taken lot by lot above, already less this line's earlier picks)
  const batchNeed = [...byBatch.values()].map((b) => ({ ...b, need: Math.max(0, b.ur) }));
  return { line: { ...line, key, week, date }, need, planQty, sent: sentQ, ur: urTotal, picked: r3(pickedLine), stock, lots: lotInfo, rolls: list, manual, nobarcode, matchedAvail, nbAvail, shortfall, batchNeed, steps, blocked, gate: { on: gate.on, bin: gate.bin, loaded: gate.loaded } };
}

/** Korber rolls offered for one roll / lot (best first): checks against the lot (Invoice, Lot, Po) and the roll (Supplier Hu = Vendor Roll No). */
async function nbOptions(env: Env, ks: Row[], lot: Row, sh: Row | null, limit = 30) {
  const vb = up(sh?.vendor_batch || lot.vendor_batch), hu = up(sh?.roll_no);
  const out: Row[] = [];
  for (const k of ks) {
    const kpo = await korberPo(env, k);
    const checks: Record<string, boolean | null> = {
      invoice: lot.invoice ? invRoot(k.invoice) === invRoot(lot.invoice) : null, item: true,
      lot: vb ? up(k.lot) === vb : null, po: lot.po && kpo ? poMatch(kpo, lot) : null, hu: hu ? up(k.supplier_hu) === hu : null,
      qty: Number(sh?.roll_qty) > 0 ? Math.abs(Number(k.qty) - Number(sh!.roll_qty)) < 0.0005 : null,
    };
    const pp = await palletPicks(env, k.pallet);
    const base = pp.base ?? Number(k.qty), before = pp.before;
    const score = (checks.lot ? 40 : 0) + (checks.hu ? 30 : 0) + (checks.po ? 20 : 0) + (checks.qty ? 5 : 0) + (base - before > 1e-9 ? 3 : 0);
    out.push({ pallet: k.pallet, item: k.item, lot: k.lot, supplier_hu: k.supplier_hu, qty: k.qty, uom: k.uom, invoice: k.invoice, location: k.location, status: k.status,
      picked_before: before, available: Math.max(0, r3(base - before)), checks, exact: !!(checks.lot && checks.hu), score, picks: pp.picks });
  }
  const used = out.filter((o) => Number(o.picked_before) > 0 && Number(o.available) > 1e-9);
  return (used.length && sh ? used : out).sort((a, b) => Number(b.score) - Number(a.score) || Number(b.available) - Number(a.available)).slice(0, limit);
}

/** The rolls whose QTY adds up closest to `target` without going far over (rolls in the order given: Po first). */
function subsetToQty(items: { id: string; q: number }[], target: number): Set<string> {
  const pick = new Set<string>();
  if (!(target > 0) || !items.length) return pick;
  // small sets: the exact best (closest at or just above the target); larger: biggest first, then the one that fills the gap
  if (items.length <= 12) {
    let best: { m: number; d: number } = { m: 0, d: Infinity };
    for (let m = 1; m < 1 << items.length; m++) {
      let q = 0; for (let i = 0; i < items.length; i++) if (m & (1 << i)) q += items[i].q;
      const d = q >= target - 1e-6 ? q - target : (target - q) * 3; // short counts more than over
      if (d < best.d - 1e-9) best = { m, d };
    }
    items.forEach((x, i) => { if (best.m & (1 << i)) pick.add(x.id); });
    return pick;
  }
  let q = 0;
  for (const x of [...items].sort((a, b) => b.q - a.q)) { if (q >= target - 1e-6) break; if (q + x.q <= target + 1e-6 || q + x.q - target < target - q) { pick.add(x.id); q += x.q; } }
  return pick;
}

// ---------------------------------------------------------------- dispatch uploads

async function handleDispatch(env: Env, req: Request) {
  const url = new URL(req.url);
  if (req.method === 'GET') {
    const week = url.searchParams.get('week');
    if (!week) throw new HttpError(400, 'Choose a week.');
    const [rows, ups] = await env.DB.batch([
      env.DB.prepare('SELECT item, qty, raw_qty, factor, pallet, location, lot, order_no, uom, file_name, uploaded_by, uploaded_at FROM dispatch WHERE week = ? ORDER BY item, order_no, pallet').bind(week),
      env.DB.prepare("SELECT at, username, detail FROM activity WHERE action = 'dispatch' ORDER BY id DESC LIMIT 15"),
    ]);
    return json({ week, rows: rows.results, history: ups.results });
  }
  const s = await requireUser(env, req, 'editor');
  if (req.method === 'DELETE') {
    const week = url.searchParams.get('week');
    if (!week || !/^\d{4}-W\d{2}$/.test(week)) throw new HttpError(400, 'Week must look like 2026-W42.');
    await env.DB.batch([
      env.DB.prepare('DELETE FROM dispatch WHERE week = ?').bind(week),
      env.DB.prepare('INSERT INTO activity (at, username, action, detail) VALUES (?,?,?,?)').bind(now(), s.u, 'dispatch', `Cleared dispatch for ${week}`),
    ]);
    await broadcast(env, { type: 'data', src: 'dispatch', by: s.u, rows: 0, weeks: [week] });
    return json({ ok: true });
  }
  if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
  const b = (await req.json()) as { week?: string; rows: Row[]; divide?: number; toYards?: boolean; mode?: 'merge' | 'replace-week'; fileName?: string; sheetName?: string; dryRun?: boolean };
  if (!b.week || !/^\d{4}-W\d{2}$/.test(b.week)) throw new HttpError(400, 'Choose the week this dispatch belongs to.');
  if (!Array.isArray(b.rows)) throw new HttpError(400, 'No rows in the upload.');
  const divide = b.divide === 1000 ? 1000 : 1;
  const factor = (1 / divide) * (b.toYards ? 1 / 0.9144 : 1); // metres → yards
  const mapped = new Map<string, Row>();
  let skipped = 0;
  b.rows.forEach((r, i) => {
    const item = normId(r.item);
    const raw = num(r.qty);
    if (!item || !/^[A-Za-z]{0,4}\d/.test(item) || !(raw > 0)) { skipped++; return; }
    const pallet = txt(r.pallet), order = txt(r.order_no), loc = txt(r.location), lot = txt(r.lot);
    // the same pallet of the same item on the same order is one dispatch line, however often it is uploaded
    const ident = `${b.week}|${item}|${pallet ?? ''}|${order ?? ''}|${loc ?? ''}|${lot ?? ''}` + (pallet || order || loc ? '' : `|row${i}`);
    mapped.set(ident, {
      ident, week: b.week, item, raw_qty: raw, factor, qty: Math.round(raw * factor * 1000) / 1000, pallet, location: loc, lot, order_no: order,
      uom: txt(r.uom), client_so: txt(r.so), file_name: b.fileName || null, sheet_name: b.sheetName || null, uploaded_by: s.u, uploaded_at: now(),
    });
  });
  const list = Array.from(mapped.values());
  if (!list.length) throw new HttpError(400, 'No usable rows: each row needs an item number and an Actual Qty above 0.');
  const firstSeen = new Map((await env.DB.prepare('SELECT ident, COALESCE(first_at, uploaded_at) first_at FROM dispatch WHERE week = ?').bind(b.week).all<{ ident: string; first_at: string }>()).results.map((r) => [r.ident, r.first_at]));
  const existing = new Set(firstSeen.keys());
  // when a pallet was first uploaded decides whether a later ZMMBE already shows it gone, so re-uploads keep that time
  for (const r of list) r.first_at = firstSeen.get(String(r.ident)) || r.uploaded_at;
  const updated = list.filter((r) => existing.has(String(r.ident))).length;
  const removed = b.mode === 'replace-week' ? Array.from(existing).filter((x) => !mapped.has(x)).length : 0;
  // which items have plan lines in that week
  const planItems = new Set((await env.DB.prepare('SELECT DISTINCT item FROM plan WHERE week = ?').bind(b.week).all<{ item: string }>()).results.map((r) => normId(r.item)));
  const items = Array.from(new Set(list.map((r) => String(r.item))));
  const preview = {
    week: b.week, lines: list.length, added: list.length - updated, updated, removed, skipped, inFileDups: b.rows.length - skipped - list.length,
    totalQty: Math.round(list.reduce((t, r) => t + Number(r.qty), 0) * 1000) / 1000, items: items.length,
    matched: items.filter((i) => planItems.has(i)).length, unmatched: items.filter((i) => !planItems.has(i)),
  };
  if (b.dryRun) return json({ ok: true, dryRun: true, ...preview });
  const stmts: D1PreparedStatement[] = [];
  if (b.mode === 'replace-week') stmts.push(env.DB.prepare('DELETE FROM dispatch WHERE week = ?').bind(b.week));
  const cols = ['ident', 'week', 'item', 'qty', 'raw_qty', 'factor', 'pallet', 'location', 'lot', 'order_no', 'uom', 'client_so', 'file_name', 'sheet_name', 'uploaded_by', 'uploaded_at', 'first_at'];
  const sel = cols.map((c) => `json_extract(value, '$.${c}')`).join(', ');
  for (let i = 0; i < list.length; i += 300) {
    stmts.push(env.DB.prepare(`INSERT OR REPLACE INTO dispatch (${cols.join(', ')}) SELECT ${sel} FROM json_each(?)`).bind(JSON.stringify(list.slice(i, i + 300))));
  }
  stmts.push(env.DB.prepare('INSERT INTO activity (at, username, action, detail) VALUES (?,?,?,?)').bind(now(), s.u, 'dispatch',
    `Dispatch W${b.week.slice(-2)}: ${preview.added} new, ${preview.updated} updated${removed ? `, ${removed} removed` : ''} · ${preview.totalQty} QTY${divide === 1000 ? ' (÷1000)' : ''}${b.toYards ? ' m→yd' : ''}${b.fileName ? ' from ' + b.fileName : ''}`));
  await env.DB.batch(stmts);
  await broadcast(env, { type: 'data', src: 'dispatch', by: s.u, rows: list.length, weeks: [b.week] });
  return json({ ok: true, ...preview });
}

async function handleStatus(env: Env, req: Request) {
  const s = await requireUser(env, req, 'editor');
  const b = (await req.json()) as { key: string; week?: string; date?: string | null; status?: string | null; comment?: string | null; vehicle?: string | null; qi_note?: string | null; hold?: string | null };
  if (!b.key) throw new HttpError(400, 'Missing line key.');
  // the plan the status belongs to: a week (2026-W47) or, for a day plan, the day (2026-11-17)
  const week = b.week && (/^(\d{4}-W\d{2}|\d{4}-\d{2}-\d{2})$/.test(b.week) || parseRound(b.week)) ? b.week
    : (await env.DB.prepare('SELECT MAX(week) w FROM plan WHERE key = ?').bind(b.key).first<{ w: string | null }>())?.w || thisWeek();
  const rnd = parseRound(week);
  const isDay = /^\d{4}-\d{2}-\d{2}$/.test(week) || !!rnd;
  // a week plan line is one date of the week ("date" in the body); without it (an older page) every line of that SO / LI / Item in the week
  let sKeys = [`${week}#${b.key}`];
  if (!isDay) {
    sKeys = 'date' in b ? [`${week}#${b.key}@${normDate(b.date) ?? ''}`]
      : (await env.DB.prepare("SELECT DISTINCT COALESCE(date, '') d FROM plan WHERE week = ? AND key = ? AND COALESCE(plan_type, 'week') = 'week'").bind(week, b.key).all<{ d: string }>()).results.map((r) => `${week}#${b.key}@${r.d}`);
    if (!sKeys.length) sKeys = [`${week}#${b.key}@`];
  }
  const fields = (['status', 'comment', 'vehicle', 'qi_note', 'hold'] as const).filter((f) => f in b);
  // Pick Hold: the reason (blank / null = released); who and when are kept with it
  if ('hold' in b && b.hold !== null && b.hold !== undefined && !String(b.hold).trim()) b.hold = 'On hold';
  if (!fields.length) throw new HttpError(400, 'Nothing to change.');
  const cur = await env.DB.prepare('SELECT status, comment, vehicle, qi_note, hold, hold_by, hold_at FROM line_status WHERE key = ?').bind(sKeys[0]).first<Row>();
  const next: Row = { status: null, comment: null, vehicle: null, qi_note: null, hold: null, hold_by: null, hold_at: null, ...(cur || {}) };
  for (const f of fields) next[f] = txt(b[f]);
  if ('hold' in b) { next.hold_by = next.hold ? s.u : null; next.hold_at = next.hold ? now() : null; }
  const date = rnd ? rnd.day : isDay ? week : 'date' in b ? normDate(b.date) : undefined;
  await env.DB.batch([
    ...sKeys.map((k) => env.DB.prepare(`INSERT INTO line_status (key, status, comment, vehicle, qi_note, updated_by, updated_at, hold, hold_by, hold_at) VALUES (?,?,?,?,?,?,?,?,?,?)
                    ON CONFLICT(key) DO UPDATE SET status=excluded.status, comment=excluded.comment, vehicle=excluded.vehicle,
                    qi_note=excluded.qi_note, updated_by=excluded.updated_by, updated_at=excluded.updated_at, hold=excluded.hold, hold_by=excluded.hold_by, hold_at=excluded.hold_at`)
      .bind(k, next.status, next.comment, next.vehicle, next.qi_note, s.u, now(), next.hold, next.hold_by, next.hold_at)),
    env.DB.prepare('INSERT INTO activity (at, username, action, detail) VALUES (?,?,?,?)')
      .bind(now(), s.u, 'edit', `${rnd ? `${rnd.day} ${rnd.plant ?? ''} Pick ${rnd.round}` : week.includes('W') ? 'W' + week.slice(-2) : week} ${b.key.replace(/\|/g, ' / ')}${!isDay && date ? ' ' + date : ''}: ${fields.map((f) => `${f} → ${next[f] ?? '(blank)'}`).join(', ')}`),
  ]);
  // period = the week or the day; date = the line's date (undefined: every line of the key in that week)
  const line = { key: b.key, period: week, ...(date !== undefined ? { date } : {}), status: next.status, comment: next.comment, vehicle: next.vehicle, qi_note: next.qi_note, hold: next.hold, hold_by: next.hold_by, hold_at: next.hold_at, updated_by: s.u, updated_at: now() };
  await broadcast(env, { type: 'status', line, by: s.u });
  return json({ ok: true, line });
}

/** Edit, add or delete one plan line (editors). */
async function handlePlanLine(env: Env, req: Request, idPart: string) {
  const s = await requireUser(env, req, 'editor');
  if (req.method === 'POST') {
    const b = (await req.json()) as Row;
    const so = normId(b.so), li = normId(b.li), item = normId(b.item);
    let date = normDate(b.date);
    { const r0 = b.planType === 'day' ? parseRound(b.week) : null; if (r0) date = r0.day; } // a round's lines are on its day
    if (!/^[A-Za-z]{0,4}\d/.test(so) || !li || !item) throw new HttpError(400, 'SO (e.g. 1001234567 or E101697207), LI and Item Code are required.');
    if (!(num(b.qty) > 0)) throw new HttpError(400, 'QTY must be more than 0.');
    const planType = b.planType === 'day' ? 'day' : 'week';
    // a day plan line goes to a round (Pick No of a plant): the round on screen, or Pick 1 of its plant on its day
    const rnd = planType === 'day' ? parseRound(b.week) : null;
    const week = rnd ? String(b.week) : planType === 'day' && date ? roundId(date, cleanPlant(b.plant) || (await userPlant(env, s.u)), 1)
      : typeof b.week === 'string' && /^\d{4}-W\d{2}$/.test(b.week) ? b.week : weekId(date) || thisWeek();
    const key = lineKey(so, li, item);
    if (planType === 'day' && !date) throw new HttpError(400, 'A day plan line needs a date.');
    const dupe = await env.DB.prepare('SELECT rowid FROM plan WHERE week = ? AND key = ? AND COALESCE(date, \'\') = ? AND owner = ? AND plan_type = ?').bind(week, key, date ?? '', s.u, planType).first();
    if (dupe) throw new HttpError(409, 'That line (same SO, LI, Item and date) is already in this week. Edit it instead.');
    const r = await env.DB.prepare(`INSERT INTO plan (key, so, li, item, date, week, qty, plant, remarks, row_no, src_user, src_at, owner, plan_type)
      VALUES (?,?,?,?,?,?,?,?,?, (SELECT COALESCE(MAX(row_no), 0) + 1 FROM plan WHERE week = ?), ?, ?, ?, ?)`)
      .bind(key, so, li, item, date, week, num(b.qty), cleanPlant(b.plant) || (await userPlant(env, s.u)), txt(b.remarks), week, s.u, now(), s.u, planType).run();
    await logActivity(env, s.u, 'line', `Added ${periodLabel(week)} ${so} / ${li} / ${item}: ${num(b.qty)}`);
    await broadcast(env, { type: 'data', src: 'plan', by: s.u, rows: 1, weeks: [week] });
    return json({ ok: true, id: r.meta.last_row_id, week });
  }
  const id = Number(idPart);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Unknown line.');
  const cur = await env.DB.prepare('SELECT rowid AS id, * FROM plan WHERE rowid = ?').bind(id).first<Row>();
  if (!cur) throw new HttpError(404, 'That line is no longer in the plan. Refresh the page.');
  if (!isBoss(s) && cur.owner && cur.owner !== s.u) throw new HttpError(403, `That line is in ${cur.owner}'s plan.`);
  const label = `${periodLabel(cur.week)} ${cur.so} / ${cur.li} / ${cur.item}`;
  if (req.method === 'DELETE') {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM plan WHERE rowid = ?').bind(id),
      env.DB.prepare('INSERT INTO activity (at, username, action, detail) VALUES (?,?,?,?)').bind(now(), s.u, 'line', `Deleted ${label}`),
    ]);
    await broadcast(env, { type: 'data', src: 'plan', by: s.u, rows: 1, weeks: [cur.week] });
    return json({ ok: true });
  }
  if (req.method === 'PATCH') {
    const b = (await req.json()) as Row;
    const next = {
      qty: 'qty' in b ? num(b.qty) : Number(cur.qty),
      date: 'date' in b ? normDate(b.date) : (cur.date as string | null),
      plant: 'plant' in b ? cleanPlant(b.plant) : (cur.plant as string | null),
      remarks: 'remarks' in b ? txt(b.remarks) : (cur.remarks as string | null),
    };
    if (!(next.qty > 0)) throw new HttpError(400, 'QTY must be more than 0.');
    if ((next.date ?? '') !== (cur.date ?? '')) {
      const clash = await env.DB.prepare('SELECT rowid FROM plan WHERE week = ? AND key = ? AND COALESCE(date, \'\') = ? AND rowid <> ? AND owner IS ?').bind(cur.week, cur.key, next.date ?? '', id, cur.owner ?? null).first();
      if (clash) throw new HttpError(409, 'Another line with the same SO, LI, Item and that date already exists in this week.');
    }
    const changes = (['qty', 'date', 'plant', 'remarks'] as const).filter((f) => String(next[f] ?? '') !== String(cur[f] ?? '')).map((f) => `${f} ${cur[f] ?? '–'} → ${next[f] ?? '–'}`);
    if (!changes.length) return json({ ok: true, unchanged: true });
    // a new date: the line's status and its picks move with it (they are kept per date)
    const moved: D1PreparedStatement[] = [];
    if ((next.date ?? '') !== (cur.date ?? '')) {
      const oldK = statusKey(cur), newK = statusKey({ ...cur, date: next.date });
      moved.push(
        env.DB.prepare('INSERT OR REPLACE INTO line_status (key, status, comment, vehicle, qi_note, updated_by, updated_at) SELECT ?2, status, comment, vehicle, qi_note, updated_by, updated_at FROM line_status WHERE key = ?1').bind(oldK, newK),
        env.DB.prepare('DELETE FROM line_status WHERE key = ?').bind(oldK),
        env.DB.prepare('UPDATE picks SET line = ?3 WHERE week = ?1 AND line = ?2').bind(cur.week, `${cur.key}|${cur.date ?? ''}`, `${cur.key}|${next.date ?? ''}`),
        env.DB.prepare('UPDATE pick_req SET line = ?3 WHERE week = ?1 AND line = ?2').bind(cur.week, `${cur.key}|${cur.date ?? ''}`, `${cur.key}|${next.date ?? ''}`),
      );
    }
    await env.DB.batch([
      env.DB.prepare('UPDATE plan SET qty = ?, date = ?, plant = ?, remarks = ?, src_user = ?, src_at = ? WHERE rowid = ?').bind(next.qty, next.date, next.plant, next.remarks, s.u, now(), id),
      ...moved,
      env.DB.prepare('INSERT INTO activity (at, username, action, detail) VALUES (?,?,?,?)').bind(now(), s.u, 'line', `Edited ${label}: ${changes.join(', ')}`),
    ]);
    await broadcast(env, { type: 'data', src: 'plan', by: s.u, rows: 1, weeks: [cur.week] });
    return json({ ok: true });
  }
  throw new HttpError(405, 'Method not allowed.');
}

// ---------------------------------------------------------------- auth & users

async function handleLogin(env: Env, req: Request) {
  const { username, password } = (await req.json()) as { username?: string; password?: string };
  const u = (username || '').trim().toLowerCase();
  if (!u || !password) throw new HttpError(400, 'Enter a username and password.');
  let user = await env.DB.prepare('SELECT * FROM users WHERE username = ?').bind(u).first<{ username: string; pass_hash: string; salt: string; role: Role }>();

  // First run: no users yet → this sign-in creates the first admin.
  // If ADMIN_USER / ADMIN_PASSWORD secrets are set, only those details are accepted; otherwise any username/password (6+ chars).
  if (!user) {
    const anyUser = await env.DB.prepare('SELECT COUNT(*) n FROM users').first<{ n: number }>();
    const noUsers = (anyUser?.n ?? 0) === 0;
    const fromSecrets = !!(env.ADMIN_USER && env.ADMIN_PASSWORD);
    if (noUsers && !fromSecrets && password.length < 6) throw new HttpError(400, 'First sign-in creates the admin account: use a password of at least 6 characters.');
    if (noUsers && !fromSecrets && !/^[a-z0-9._-]{2,32}$/.test(u)) throw new HttpError(400, 'Username: 2–32 letters, numbers, dot, dash or underscore.');
    if (noUsers && (fromSecrets ? u === env.ADMIN_USER!.toLowerCase() && password === env.ADMIN_PASSWORD : true)) {
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
    const r = await env.DB.prepare('SELECT username, role, plant, created_at FROM users ORDER BY username').all();
    return json({ users: r.results });
  }
  if (req.method === 'POST') {
    const b = (await req.json()) as { username?: string; password?: string; role?: Role; plant?: string | null };
    const u = (b.username || '').trim().toLowerCase();
    if (!/^[a-z0-9._-]{2,32}$/.test(u)) throw new HttpError(400, 'Username: 2–32 letters, numbers, dot, dash or underscore.');
    if (!b.role || !['admin', 'head', 'editor', 'viewer'].includes(b.role)) throw new HttpError(400, 'Choose a role.');
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
    if ('plant' in b) await env.DB.prepare('UPDATE users SET plant = ? WHERE username = ?').bind(cleanPlant(b.plant), u).run();
    await logActivity(env, s.u, 'user', `${existing ? 'Updated' : 'Added'} ${u} (${b.role}${cleanPlant(b.plant) ? ', ' + cleanPlant(b.plant) : ''})`);
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
  // ?rid=<Pick>: only that Pick's own upload of the report is removed (the Pick then reads the shared report again)
  const crid = new URL(req.url).searchParams.get('rid');
  if (crid && scopeRid(crid) && ['zmmbe', 'zinr', 'zcoment', 'korber', 'zroll', 'ztrr'].includes(src)) {
    const t = src === 'zmmbe' ? 'stock' : src;
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM ${t} WHERE rid = ?`).bind(crid),
      ...(src === 'zmmbe' ? [env.DB.prepare('DELETE FROM stock_sent WHERE rid = ?').bind(crid)] : []),
      env.DB.prepare(`DELETE FROM uploads WHERE rid = ? AND src IN (${src === 'zmmbe' ? "'zmmbe', 'kfc', 'pfc', 'plant'" : `'${src}'`})`).bind(crid),
      env.DB.prepare('INSERT INTO activity (at, username, action, detail) VALUES (?,?,?,?)').bind(now(), s.u, 'clear', `Cleared ${src.toUpperCase()} of ${periodLabel(crid)}`),
      env.DB.prepare("DELETE FROM config WHERE k IN ('c_counts', 'c_pick_counts')"),
    ]);
    await broadcast(env, { type: 'data', src, by: s.u, rows: 0 });
    return json({ ok: true });
  }
  if (!ALL_SRCS.includes(src as Src)) throw new HttpError(400, 'Unknown report type.');
  const wk = new URL(req.url).searchParams.get('week');
  if (src === 'plan' && wk) {
    // a week (2026-W42) or a day plan round (2026-10-20~C064~2)
    if (!/^\d{4}-W\d{2}$/.test(wk) && !parseRound(wk)) throw new HttpError(400, 'Week must look like 2026-W42.');
    await env.DB.batch([
      env.DB.prepare('DELETE FROM plan WHERE week = ?').bind(wk),
      env.DB.prepare('INSERT INTO activity (at, username, action, detail) VALUES (?,?,?,?)').bind(now(), s.u, 'clear', `Deleted ${parseRound(wk) ? 'day plan ' + periodLabel(wk) : 'weekly plan ' + wk}`),
    ]);
    await broadcast(env, { type: 'data', src, by: s.u, rows: 0, weeks: [wk] });
    return json({ ok: true });
  }
  const stmt = src === 'plan' ? 'DELETE FROM plan' : src === 'trr' ? 'DELETE FROM trr' : "DELETE FROM stock WHERE src = ? AND rid = ''";
  // ZMMBE KFC / PFC (and PLANT, when it came from ZMMBE) are built from ZMMBE: they go with it
  const alsoClear: D1PreparedStatement[] = [];
  if (src === 'zmmbe' && (await getSettings(env)).deriveFromZmmbe) {
    alsoClear.push(env.DB.prepare("DELETE FROM stock WHERE src IN ('kfc', 'pfc') AND rid = ''"));
    alsoClear.push(env.DB.prepare("DELETE FROM stock_sent WHERE rid = ''"));
    const lastPlant = await env.DB.prepare("SELECT file_name FROM uploads WHERE src = 'plant' ORDER BY id DESC LIMIT 1").first<{ file_name: string | null }>();
    if (lastPlant && /\(from ZMMBE\)$/.test(String(lastPlant.file_name ?? ''))) alsoClear.push(env.DB.prepare("DELETE FROM stock WHERE src = 'plant' AND rid = ''"));
  }
  await env.DB.batch([
    ...alsoClear,
    src === 'plan' || src === 'trr' ? env.DB.prepare(stmt) : env.DB.prepare(stmt).bind(src),
    env.DB.prepare('INSERT INTO activity (at, username, action, detail) VALUES (?,?,?,?)').bind(now(), s.u, 'clear', `Cleared ${SRC_LABEL[src as Src]}`),
  ]);
  await broadcast(env, { type: 'data', src, by: s.u, rows: 0 });
  return json({ ok: true });
}

// ---------------------------------------------------------------- admin: the uploaded plans (data change)

/**
 * GET: every plan (user × week plan / day) with lines and done; POST {action: 'reassign' | 'delete', owner, type, week, day?, to?}.
 * Admin only (system settings).
 */
async function handleAdminPlans(env: Env, req: Request) {
  const s = await requireUser(env, req, 'admin');
  if (req.method === 'GET') {
    const r = await env.DB.prepare(`SELECT p.owner, p.plan_type AS type, p.week, CASE WHEN p.plan_type = 'day' THEN p.date END AS day,
        COUNT(*) lines, ROUND(SUM(p.qty), 3) qty, MIN(p.date) start, MAX(p.date) end, MAX(p.src_at) uploaded,
        SUM(CASE WHEN lower(COALESCE(ls.status, '')) LIKE '%done%' THEN 1 ELSE 0 END) done
      FROM plan p LEFT JOIN line_status ls ON ls.key = ${SK('p')}
      GROUP BY p.owner, p.plan_type, p.week, CASE WHEN p.plan_type = 'day' THEN p.date END
      ORDER BY p.week DESC, day DESC, p.owner LIMIT 400`).all();
    return json({ plans: r.results });
  }
  if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
  const b = (await req.json()) as { action?: string; owner?: string; type?: string; week?: string; day?: string | null; to?: string };
  const type = b.type === 'day' ? 'day' : 'week';
  if (!b.owner || !b.week) throw new HttpError(400, 'Choose the plan.');
  const where = `owner = ?1 AND plan_type = ?2 AND week = ?3${type === 'day' && b.day ? ' AND date = ?4' : ''}`;
  const binds = [b.owner, type, b.week, ...(type === 'day' && b.day ? [b.day] : [])];
  const label = `${type === 'day' ? (parseRound(b.week) ? 'day plan ' + periodLabel(b.week) : 'day plan ' + (b.day || b.week)) : 'week plan ' + b.week} of ${b.owner}`;
  if (b.action === 'reassign') {
    const to = String(b.to || '').trim().toLowerCase();
    if (!(await env.DB.prepare('SELECT 1 FROM users WHERE username = ?').bind(to).first())) throw new HttpError(400, `There is no user "${to}".`);
    const n = (await env.DB.prepare(`UPDATE plan SET owner = ?${binds.length + 1} WHERE ${where}`).bind(...binds, to).run()).meta.changes;
    await logActivity(env, s.u, 'plan', `Moved ${label} to ${to} (${n} lines)`);
    await broadcast(env, { type: 'data', src: 'plan', by: s.u, rows: n });
    return json({ ok: true, lines: n });
  }
  if (b.action === 'delete') {
    const n = (await env.DB.prepare(`DELETE FROM plan WHERE ${where}`).bind(...binds).run()).meta.changes;
    await logActivity(env, s.u, 'plan', `Deleted ${label} (${n} lines)`);
    await broadcast(env, { type: 'data', src: 'plan', by: s.u, rows: n });
    return json({ ok: true, lines: n });
  }
  throw new HttpError(400, 'Unknown action.');
}

// ---------------------------------------------------------------- D1 meter
/** Counts the rows D1 reads and writes for one request (sent back as x-d1-rows-read / x-d1-rows-written). */
interface Meter { read: number; written: number; queries: number }
type Meta = { rows_read?: number; rows_written?: number } | undefined;
function meterDb(db: D1Database, m: Meter): D1Database {
  const note = (meta: Meta) => { m.queries++; m.read += meta?.rows_read ?? 0; m.written += meta?.rows_written ?? 0; };
  const wrapStmt = (st: D1PreparedStatement): D1PreparedStatement => new Proxy(st, {
    get(t, k) {
      if (k === '__t') return t;
      if (k === 'bind') return (...a: unknown[]) => wrapStmt(t.bind(...a));
      if (k === 'all') return async () => { const r = await t.all(); note(r.meta as Meta); return r; };
      if (k === 'run') return async () => { const r = await t.run(); note(r.meta as Meta); return r; };
      if (k === 'first') return async (col?: string) => { const r = await t.all(); note(r.meta as Meta); const row = (r.results[0] ?? null) as Record<string, unknown> | null; return col ? (row ? row[col] ?? null : null) : row; };
      if (k === 'raw') return async (o?: { columnNames?: boolean }) => { m.queries++; return o?.columnNames ? t.raw({ columnNames: true }) : t.raw(); };
      const v = Reflect.get(t, k); return typeof v === 'function' ? v.bind(t) : v;
    },
  });
  return new Proxy(db, {
    get(t, k) {
      if (k === 'prepare') return (q: string) => wrapStmt(t.prepare(q));
      // statements given to batch are proxies: unwrap by re-preparing is not possible, so pass them through (Proxy targets are real statements)
      if (k === 'batch') return async (sts: D1PreparedStatement[]) => { const r = await t.batch(sts.map((x) => (x as unknown as { __t?: D1PreparedStatement }).__t ?? x)); r.forEach((x) => note(x.meta as Meta)); return r; };
      const v = Reflect.get(t, k); return typeof v === 'function' ? v.bind(t) : v;
    },
  });
}

// ---------------------------------------------------------------- router

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const meter: Meter = { read: 0, written: 0, queries: 0 };
    if (env.DB) env = { ...env, DB: meterDb(env.DB, meter) };
    const cors = corsHeaders(env, req);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    try {
      const p = url.pathname.replace(/\/+$/, '');
      if (p !== '/api/health' && !env.DB) throw new HttpError(500, 'The D1 database is not bound to the Worker as DB (Settings → Bindings).');
      // "has anything changed?" — one row, answered before anything else so it stays cheap
      if (p === '/api/changes') {
        let rev: string | null = null;
        try { rev = (await env.DB.prepare("SELECT v FROM config WHERE k = 'rev'").first<{ v: string }>())?.v ?? null; } catch { /* no config yet */ }
        return new Response(JSON.stringify({ rev, realtime: !!env.HUB }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors } });
      }
      if (p !== '/api/health' && p !== '/api/live') await ensureSchema(env);

      // WebSocket for live updates (token in the query string, browsers can't set headers on WebSockets)
      if (p === '/api/live') {
        const s = (await verifyToken(env, url.searchParams.get('token'))) || { u: 'guest', role: 'viewer' as Role, exp: 0 };
        if (req.headers.get('Upgrade') !== 'websocket') return new Response('Expected WebSocket', { status: 426 });
        if (!env.HUB) return new Response('Realtime hub not configured', { status: 503 });
        const stub = env.HUB.get(env.HUB.idFromName('main'));
        return stub.fetch(`https://hub/connect?u=${encodeURIComponent(s.u)}`, req);
      }

      let res: Response;
      if (p === '/api/health') {
        let db = 'missing';
        let users = 0;
        if (env.DB) { try { users = (await env.DB.prepare('SELECT COUNT(*) n FROM users').first<{ n: number }>())?.n ?? 0; db = 'ok'; } catch { db = 'no tables (run schema.sql)'; } }
        res = json({ ok: db === 'ok', db, users, setup: db !== 'ok' ? 'fix db first' : users === 0 ? 'ready: the first sign-in creates the admin account' : 'done', realtime: env.HUB ? 'on' : 'off (polling)', version: API_VERSION, at: now() });
      }
      else if (p === '/api/auth/login' && req.method === 'POST') res = await handleLogin(env, req);
      else if (p === '/api/me') { const s = await requireUser(env, req); res = json({ user: { username: s.u, role: s.role, plant: await userPlant(env, s.u) } }); }
      else if (p === '/api/plan' || p.startsWith('/api/plan/')) res = await handlePlanLine(env, req, p.split('/')[3] || '');
      else if (p === '/api/dispatch') res = await handleDispatch(env, req);
      else if (p.startsWith('/api/pick')) res = await handlePick(env, req, p);
      else if (p === '/api/admin/clear' && req.method === 'POST') res = await handleClearDb(env, req);
      else if (p.startsWith('/api/dispatch/assign')) res = await handleAssign(env, req, p.split('/')[4] || '');
      else if (p === '/api/release') res = await handleRelease(env, req);
      else if (p === '/api/plants') res = await handlePlants(env, req);
      else if (p === '/api/settings') {
        // system settings: everyone signed in reads them, only the admin changes them
        if (req.method === 'GET') { await requireUser(env, req); res = json({ settings: await getSettings(env) }); }
        else {
          const s = await requireUser(env, req, 'admin');
          const b = (await req.json()) as Partial<Settings>;
          const cur = await getSettings(env);
          const next: Settings = {
            fullRollPct: Math.max(0, Math.min(100, Number(b.fullRollPct ?? cur.fullRollPct) || 0)),
            defaultPickKind: b.defaultPickKind === 'offsite' ? 'offsite' : b.defaultPickKind === 'normal' ? 'normal' : cur.defaultPickKind,
            allowOffsite: b.allowOffsite === undefined ? cur.allowOffsite : !!b.allowOffsite,
            allowNormalShort: b.allowNormalShort === undefined ? cur.allowNormalShort : !!b.allowNormalShort,
            allowNormalFull: b.allowNormalFull === undefined ? cur.allowNormalFull : !!b.allowNormalFull,
            deriveFromZmmbe: b.deriveFromZmmbe === undefined ? cur.deriveFromZmmbe : !!b.deriveFromZmmbe,
            pfcSlocs: b.pfcSlocs === undefined ? cur.pfcSlocs : slocList(b.pfcSlocs, cur.pfcSlocs),
            plantSlocs: b.plantSlocs === undefined ? cur.plantSlocs : slocList(b.plantSlocs, cur.plantSlocs),
            soliPerHour: b.soliPerHour === undefined ? cur.soliPerHour : Math.max(1, Math.min(1000, Number(b.soliPerHour) || cur.soliPerHour)),
            lateGraceMin: b.lateGraceMin === undefined ? cur.lateGraceMin : Math.max(0, Math.min(600, Number(b.lateGraceMin) || 0)),
            defaultTarget: b.defaultTarget === undefined ? cur.defaultTarget : String(b.defaultTarget).trim().slice(0, 20),
            zmmbePlants: b.zmmbePlants === undefined ? cur.zmmbePlants : plantPairs(b.zmmbePlants),
            rollGate: b.rollGate === undefined ? cur.rollGate : !!b.rollGate,
            pickBin: b.pickBin === undefined ? cur.pickBin : (String(b.pickBin).trim().toUpperCase().slice(0, 30) || 'EXPO-FIX'),
            zrollNeedsZinsr: b.zrollNeedsZinsr === undefined ? cur.zrollNeedsZinsr !== false : !!b.zrollNeedsZinsr,
          };
          await env.DB.batch([
            env.DB.prepare("INSERT INTO config (k, v) VALUES ('settings', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(JSON.stringify(next)),
            env.DB.prepare('INSERT INTO activity (at, username, action, detail) VALUES (?,?,?,?)').bind(now(), s.u, 'settings', `System settings: ${JSON.stringify(next)}`),
          ]);
          await broadcast(env, { type: 'data', src: 'settings', by: s.u, rows: 0 });
          res = json({ ok: true, settings: next });
        }
      }
      else if (p === '/api/admin/plans') res = await handleAdminPlans(env, req);
      else if (p === '/api/owners') {
        // who has a plan or picks: for the admin's / viewer's "Data of" choice
        const s = await requireUser(env, req);
        if (s.role === 'editor') res = json({ owners: [s.u] });
        else {
          const r = await env.DB.prepare('SELECT owner u FROM plan WHERE owner IS NOT NULL UNION SELECT by_user FROM pick_req UNION SELECT username FROM users WHERE role <> \'viewer\' ORDER BY 1').all<{ u: string }>();
          res = json({ owners: r.results.map((x) => x.u).filter(Boolean) });
        }
      }
      else if (p === '/api/plants/received') res = await handleReceived(env, req);
      else if (p === '/api/pullplan' && req.method === 'GET') res = await handlePullPlan(env, req);
      else if (p === '/api/rounds') res = await handleRounds(env, req);
      // the Plant + SO Plant pairs in the ZMMBE uploads (for Settings → ZMMBE plants)
      else if (p === '/api/follow') res = await handleFollow(env, req);
      else if (p === '/api/zroll' && req.method === 'GET') res = await handleZroll(env, req);
      else if (p === '/api/plan-report' && req.method === 'GET') res = await handlePlanReport(env, req);
      else if (p === '/api/zmmbe-pairs' && req.method === 'GET') {
        await requireUser(env, req, 'admin');
        res = json({ pairs: (await env.DB.prepare("SELECT upper(COALESCE(plant, '')) plant, upper(COALESCE(so_plant, '')) soPlant, COUNT(*) n, ROUND(SUM(ur), 3) ur FROM stock WHERE src = 'zmmbe' GROUP BY 1, 2 ORDER BY ur DESC").all()).results });
      }
      else if (p === '/api/days') res = await handleDays(env, req);
      else if (p === '/api/backup' || p.startsWith('/api/backup/') || p.startsWith('/api/restore/')) res = await handleBackup(env, req, p);
      else if (p === '/api/upload' && req.method === 'POST') res = await handleUpload(env, req);
      else if (p === '/api/status' && req.method === 'PATCH') res = await handleStatus(env, req);
      else if (p === '/api/activity') {
        await requireUser(env, req);
        const only = url.searchParams.get('action');
        const r = only
          ? await env.DB.prepare('SELECT at, username, action, detail FROM activity WHERE action = ? ORDER BY id DESC LIMIT 30').bind(only).all()
          : await env.DB.prepare('SELECT at, username, action, detail FROM activity ORDER BY id DESC LIMIT 60').all();
        res = json({ activity: r.results });
      } else if (p.startsWith('/api/users')) res = await handleUsers(env, req, p);
      else if (p.startsWith('/api/data/') && req.method === 'DELETE') res = await handleClear(env, req, p.split('/').pop() || '');
      else if (p === '/api/online') {
        await requireUser(env, req);
        res = env.HUB ? await env.HUB.get(env.HUB.idFromName('main')).fetch('https://hub/online') : json({ online: [] });
      } else throw new HttpError(404, 'Not found.');

      const h = new Headers(res.headers);
      Object.entries(cors).forEach(([k, v]) => h.set(k, v));
      h.set('x-d1-rows-read', String(meter.read)); h.set('x-d1-rows-written', String(meter.written)); h.set('x-d1-queries', String(meter.queries));
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
