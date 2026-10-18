/**
 * MAS Weekly Plan Tracker — Cloudflare Worker API, data in Supabase (Postgres)
 *
 *  - Supabase Postgres holds the plan, the stock reports, dispatch, dashboard edits, users and activity.
 *    The Worker connects with the DATABASE_URL secret (Supabase → Connect → Transaction pooler).
 *  - An old Cloudflare D1 database bound as DB is copied into Supabase once, on the first sign-in.
 *  - The pull plan calculation (the Excel SUMIF/VLOOKUP logic) runs as one SQL query.
 *  - A Durable Object (LiveHub) keeps WebSocket connections and pushes a message to every
 *    open dashboard whenever data changes, so all screens update in real time.
 */

import postgres from 'postgres';
import { Buffer as NodeBuffer } from 'buffer';

/**
 * Supabase connection string. Best kept as the DATABASE_URL secret (Worker → Settings → Variables and Secrets).
 * If you cannot add secrets, paste it between the quotes instead (keep this file private then).
 */
const DATABASE_URL_FALLBACK = '';

export interface Env {
  DATABASE_URL?: string;
  /** set per request: the Postgres connection */
  PG: Db;
  /** optional: the old Cloudflare D1 database, only read to copy its data into Supabase */
  DB?: D1Database;
  HUB?: DurableObjectNamespace; // optional: without it the dashboard refreshes every 20 s instead of instantly
  JWT_SECRET?: string; // optional: a random key is created and kept in D1 when not set
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
  plan: 'Weekly plan', zmmbe: 'ZMMBE', kfc: 'ZMMBE KFC', pfc: 'ZMMBE PFC', plant: 'PLANT report', trr: 'TRR',
};

// ---------------------------------------------------------------- database (Postgres, D1-style API)

type Sql = ReturnType<typeof postgres>;
/** D1 placeholders (?, ?1) → Postgres ($1). */
function toPg(q: string) {
  if (/\?\d/.test(q)) return q.replace(/\?(\d+)/g, '$$$1');
  let i = 0;
  return q.replace(/\?/g, () => '$' + ++i);
}
class Stmt {
  constructor(private db: Db, readonly text: string, readonly params: unknown[] = []) {}
  bind(...p: unknown[]) { return new Stmt(this.db, this.text, p.map((v) => (v === undefined ? null : v))); }
  async all<T = Row>() { return { results: (await this.db.exec(this)) as T[] }; }
  async first<T = Row>() { return ((await this.db.exec(this))[0] ?? null) as T | null; }
  async run() { const r = await this.db.exec(this); return { meta: { changes: r.length } }; }
}
class Db {
  constructor(readonly sql: Sql) {}
  prepare(q: string) { return new Stmt(this, toPg(q)); }
  async exec(s: Stmt, tx?: Sql): Promise<Row[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await (tx ?? this.sql).unsafe(s.text, s.params as any[]);
    return Array.from(r as unknown as Row[]);
  }
  /** All statements in one transaction: all or nothing. */
  async batch(stmts: Stmt[]) {
    return this.sql.begin(async (tx) => {
      const out: { results: Row[] }[] = [];
      for (const st of stmts) out.push({ results: await this.exec(st, tx as unknown as Sql) });
      return out;
    }) as Promise<{ results: Row[] }[]>;
  }
}
// postgres.js reads process.env and uses Buffer; Workers without nodejs_compat have neither
const g = globalThis as unknown as { process?: { env: Record<string, string> }; Buffer?: unknown };
g.process ||= { env: {} };
g.Buffer ||= NodeBuffer;
function connect(url: string): Sql {
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  return postgres(url, {
    prepare: false, // Supabase transaction pooler
    max: 4, idle_timeout: 5, connect_timeout: 10, fetch_types: false,
    ssl: local ? false : 'require',
    types: {
      // COUNT / SUM of integers come back as int8: read them as numbers
      bigint: { to: 20, from: [20], serialize: (x: unknown) => String(x), parse: (x: string) => Number(x) },
      numeric: { to: 1700, from: [1700], serialize: (x: unknown) => String(x), parse: (x: string) => Number(x) },
    },
  });
}

const SCHEMA_VERSION = '1';
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS config (k text PRIMARY KEY, v text NOT NULL);
CREATE TABLE IF NOT EXISTS users (username text PRIMARY KEY, pass_hash text NOT NULL, salt text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin','editor','viewer')), plant text, created_at text NOT NULL);
CREATE TABLE IF NOT EXISTS plan (id bigserial PRIMARY KEY, key text NOT NULL, so text NOT NULL, li text NOT NULL, item text NOT NULL,
  date text, qty double precision NOT NULL DEFAULT 0, plant text, remarks text, row_no integer NOT NULL DEFAULT 0, week text, src_user text, src_at text);
CREATE INDEX IF NOT EXISTS plan_week_key ON plan(week, key);
CREATE INDEX IF NOT EXISTS plan_key ON plan(key);
CREATE INDEX IF NOT EXISTS plan_item ON plan(item);
CREATE TABLE IF NOT EXISTS stock (id bigserial PRIMARY KEY, src text NOT NULL, key text NOT NULL, plant text, sloc text, so_plant text, so text, li text,
  material text, batch text, style text, ur double precision DEFAULT 0, qi double precision DEFAULT 0, block double precision DEFAULT 0,
  assigned double precision DEFAULT 0, total double precision DEFAULT 0);
CREATE INDEX IF NOT EXISTS stock_key ON stock(key);
CREATE INDEX IF NOT EXISTS stock_src ON stock(src);
CREATE TABLE IF NOT EXISTS trr (id bigserial PRIMARY KEY, key text NOT NULL, tn text, tn_date text, created_by text, so text, li text, material text,
  from_plant text, from_sloc text, to_plant text, to_sloc text, qty double precision DEFAULT 0, reason text);
CREATE INDEX IF NOT EXISTS trr_key ON trr(key);
CREATE TABLE IF NOT EXISTS line_status (key text PRIMARY KEY, status text, comment text, vehicle text, qi_note text, updated_by text, updated_at text);
CREATE TABLE IF NOT EXISTS uploads (id bigserial PRIMARY KEY, src text NOT NULL, file_name text, sheet_name text, row_count integer NOT NULL DEFAULT 0,
  uploaded_by text NOT NULL, uploaded_at text NOT NULL, mode text);
CREATE TABLE IF NOT EXISTS activity (id bigserial PRIMARY KEY, at text NOT NULL, username text NOT NULL, action text NOT NULL, detail text);
CREATE INDEX IF NOT EXISTS activity_action ON activity(action, id);
CREATE TABLE IF NOT EXISTS dispatch (ident text PRIMARY KEY, week text NOT NULL, item text NOT NULL, qty double precision NOT NULL, raw_qty double precision,
  factor double precision, pallet text, location text, lot text, order_no text, uom text, client_so text, file_name text, sheet_name text,
  uploaded_by text, uploaded_at text, first_at text);
CREATE INDEX IF NOT EXISTS dispatch_week_item ON dispatch(week, item);
CREATE TABLE IF NOT EXISTS plant_info (code text PRIMARY KEY, name text, responsible text, target text, sort integer DEFAULT 0);
CREATE TABLE IF NOT EXISTS stock_release (week text NOT NULL, key text NOT NULL, qi double precision DEFAULT 0, block double precision DEFAULT 0,
  by_user text, at text, PRIMARY KEY (week, key));
CREATE TABLE IF NOT EXISTS plant_received (week text NOT NULL, code text NOT NULL, received text, by_user text, at text, PRIMARY KEY (week, code));
CREATE TABLE IF NOT EXISTS dispatch_assign (id bigserial PRIMARY KEY, week text NOT NULL, item text NOT NULL, line text NOT NULL,
  qty double precision NOT NULL, by_user text, at text);
-- Only the Worker (database owner) reads and writes these tables. Row level security with no policies keeps
-- Supabase's public REST API (anon / authenticated keys) out of them.
ALTER TABLE config ENABLE ROW LEVEL SECURITY; ALTER TABLE users ENABLE ROW LEVEL SECURITY; ALTER TABLE plan ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock ENABLE ROW LEVEL SECURITY; ALTER TABLE trr ENABLE ROW LEVEL SECURITY; ALTER TABLE line_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE uploads ENABLE ROW LEVEL SECURITY; ALTER TABLE activity ENABLE ROW LEVEL SECURITY; ALTER TABLE dispatch ENABLE ROW LEVEL SECURITY;
ALTER TABLE plant_info ENABLE ROW LEVEL SECURITY; ALTER TABLE stock_release ENABLE ROW LEVEL SECURITY; ALTER TABLE plant_received ENABLE ROW LEVEL SECURITY;
ALTER TABLE dispatch_assign ENABLE ROW LEVEL SECURITY;
INSERT INTO config (k, v) VALUES ('schema_version', '${SCHEMA_VERSION}') ON CONFLICT (k) DO UPDATE SET v = excluded.v;
`;

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

/** Signing key: the JWT_SECRET secret if set, otherwise a random key created once and kept in the database. */
let cachedSecret: string | null = null;
async function getSecret(env: Env): Promise<string> {
  if (env.JWT_SECRET) return env.JWT_SECRET;
  if (cachedSecret) return cachedSecret;
  const fresh = b64url(crypto.getRandomValues(new Uint8Array(32)));
  await env.PG.prepare("INSERT INTO config (k, v) VALUES ('jwt_secret', ?) ON CONFLICT (k) DO NOTHING").bind(fresh).run();
  const row = await env.PG.prepare("SELECT v FROM config WHERE k = 'jwt_secret'").first<{ v: string }>();
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

/** Creates the tables the first time (and after an update that adds some). Cheap afterwards: one lookup per Worker instance. */
let schemaReady = false;
async function ensureSchema(env: Env) {
  if (schemaReady) return;
  let v: string | null = null;
  try { v = (await env.PG.prepare("SELECT v FROM config WHERE k = 'schema_version'").first<{ v: string }>())?.v ?? null; } catch { /* no tables yet */ }
  if (v !== SCHEMA_VERSION) await env.PG.sql.unsafe(SCHEMA_SQL).simple();
  schemaReady = true;
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
  if (!env.HUB) return; // realtime hub not bound: clients fall back to polling
  const stub = env.HUB.get(env.HUB.idFromName('main'));
  await stub.fetch('https://hub/broadcast', { method: 'POST', body: JSON.stringify({ ...msg, at: now() }) });
}
async function logActivity(env: Env, user: string, action: string, detail: string) {
  await env.PG.prepare('INSERT INTO activity (at, username, action, detail) VALUES (?,?,?,?)').bind(now(), user, action, detail).run();
}

// ---------------------------------------------------------------- row mapping (uploads)

type Row = Record<string, unknown>;
/** Raised whenever the website needs a newer Worker. 5 = dispatch + letter SOs (E101697207). */
const API_VERSION = 9; // 9 = Supabase

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
    const ur = num(r.ur), qi = num(r.qi), block = num(r.block);
    out.push({
      src, key: lineKey(so, li, mat), plant: txt(r.plant), sloc: txt(normId(r.sloc)), so_plant: txt(r.so_plant), so, li,
      material: mat, batch: txt(normId(r.batch)), style: txt(r.style), ur, qi, block, assigned: num(r.assigned),
      total: r.total === undefined || r.total === null || r.total === '' ? ur + qi + block : num(r.total),
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

/** Insert many rows with one JSON parameter per chunk; the table's own column types are used. */
function jsonInsert(env: Env, table: string, cols: string[], rows: Row[], chunk = 1000, tail = ''): Stmt[] {
  const stmts: Stmt[] = [];
  for (let i = 0; i < rows.length; i += chunk) {
    const part = rows.slice(i, i + chunk).map((r) => Object.fromEntries(cols.map((c) => [c, r[c] ?? null])));
    stmts.push(env.PG.prepare(`INSERT INTO ${table} (${cols.join(', ')}) SELECT ${cols.join(', ')} FROM jsonb_populate_recordset(NULL::${table}, (?::text)::jsonb)${tail}`).bind(JSON.stringify(part)));
  }
  return stmts;
}

/** A plan line is the same line when week, SO, LI, Item and date all match. */
const lineId = (r: Row) => `${r.week}|${r.key}|${r.date ?? ''}`;
const cleanPlant = (v: unknown) => { const t = txt(v); return t && !/^#/.test(t) ? t.toUpperCase() : null; };
type PlanMode = 'merge' | 'replace-plant' | 'replace-week';

async function userPlant(env: Env, u: string) {
  return (await env.PG.prepare('SELECT plant FROM users WHERE username = ?').bind(u).first<{ plant: string | null }>())?.plant || null;
}

async function handleUpload(env: Env, req: Request) {
  const s = await requireUser(env, req, 'editor');
  const body = (await req.json()) as { src: Src; fileName?: string; sheetName?: string; rows: Row[]; week?: string; forceWeek?: boolean; mode?: PlanMode | 'add'; plant?: string; dryRun?: boolean };
  let stockDups = 0;
  if (!ALL_SRCS.includes(body.src)) throw new HttpError(400, 'Unknown report type.');
  if (!Array.isArray(body.rows)) throw new HttpError(400, 'No rows in the upload.');

  const stmts: Stmt[] = [];
  let mapped: Row[];
  let weeks: string[] = [];
  let planSummary: Record<string, unknown> | null = null;
  if (body.src === 'plan') {
    const chosen = body.week && /^\d{4}-W\d{2}$/.test(body.week) ? body.week : null;
    if (body.forceWeek && !chosen) throw new HttpError(400, 'Pick a week (like 2026-W43) or use "Auto from dates".');
    mapped = mapPlan(body.rows, chosen || thisWeek());
    if (body.forceWeek && chosen) for (const r of mapped) r.week = chosen; // the person chose the week: every line goes there
    const mode: PlanMode = body.mode === 'replace-week' || body.mode === 'replace-plant' ? body.mode : 'merge';
    const plant = cleanPlant(body.plant) || (mode === 'replace-plant' ? null : await userPlant(env, s.u));
    if (mode === 'replace-plant' && !plant) throw new HttpError(400, 'Choose the plant whose lines this file replaces.');
    for (const r of mapped) { r.plant = cleanPlant(r.plant) || plant; r.src_user = s.u; r.src_at = now(); }
    // the same line twice in one file: keep the last one
    const byId = new Map<string, Row>();
    for (const r of mapped) byId.set(lineId(r), r);
    const inFileDups = mapped.length - byId.size;
    mapped = Array.from(byId.values());
    weeks = Array.from(new Set(mapped.map((r) => String(r.week)))).sort();

    // what is already there for these weeks
    const existing = (await env.PG.prepare(`SELECT week, key, date, plant FROM plan WHERE week IN (SELECT jsonb_array_elements_text((?::text)::jsonb))`).bind(JSON.stringify(weeks)).all<Row>()).results;
    const existingIds = new Set(existing.map(lineId));
    const incomingIds = new Set(mapped.map(lineId));
    const updated = mapped.filter((r) => existingIds.has(lineId(r))).length;
    const added = mapped.length - updated;
    const removedRows = existing.filter((r) => !incomingIds.has(lineId(r)) && (mode === 'replace-week' || (mode === 'replace-plant' && cleanPlant(r.plant) === plant)));
    const kept = existing.length - updated - removedRows.length;
    const preview = { mode, plant, weeks, added, updated, removed: removedRows.length, kept, inFileDups, lines: mapped.length };
    if (body.dryRun) return json({ ok: true, dryRun: true, ...preview });

    const ids = JSON.stringify(mapped.map(lineId));
    if (mode === 'replace-week') stmts.push(env.PG.prepare('DELETE FROM plan WHERE week IN (SELECT jsonb_array_elements_text((?::text)::jsonb))').bind(JSON.stringify(weeks)));
    if (mode === 'replace-plant') stmts.push(env.PG.prepare('DELETE FROM plan WHERE week IN (SELECT jsonb_array_elements_text((?1::text)::jsonb)) AND upper(COALESCE(plant, \'\')) = ?2').bind(JSON.stringify(weeks), plant));
    // merge (and the replace modes): a line that is already there is replaced, never duplicated
    stmts.push(env.PG.prepare(`DELETE FROM plan WHERE week || '|' || key || '|' || COALESCE(date, '') IN (SELECT jsonb_array_elements_text((?::text)::jsonb))`).bind(ids));
    stmts.push(...jsonInsert(env, 'plan', ['key', 'so', 'li', 'item', 'date', 'week', 'qty', 'plant', 'remarks', 'row_no', 'src_user', 'src_at'], mapped));
    planSummary = preview;
    // Status/comment columns that came with the file seed the dashboard, without overwriting edits made on it.
    const seed = mapped.filter((r) => r._status || r._comment || r._qi_note || r._vehicle)
      .map((r) => ({ key: `${r.week}#${r.key}`, status: r._status, comment: r._comment, vehicle: r._vehicle, qi_note: r._qi_note, updated_by: s.u, updated_at: now() }));
    stmts.push(...jsonInsert(env, 'line_status', ['key', 'status', 'comment', 'vehicle', 'qi_note', 'updated_by', 'updated_at'], seed, 1000, ' ON CONFLICT (key) DO NOTHING'));
  } else if (body.src === 'trr') {
    mapped = mapTrr(body.rows);
    stmts.push(env.PG.prepare('DELETE FROM trr'));
    stmts.push(...jsonInsert(env, 'trr', ['key', 'tn', 'tn_date', 'created_by', 'so', 'li', 'material', 'from_plant', 'from_sloc', 'to_plant', 'to_sloc', 'qty', 'reason'], mapped));
  } else {
    mapped = mapStock(body.src, body.rows);
    stockDups = body.rows.filter((r) => normId(r.so) && normId(r.li) && normId(r.material)).length - mapped.length;
    if (body.mode === 'add') {
      // another part of the same report: replace only the rows this file has, keep the rest
      stmts.push(env.PG.prepare(`DELETE FROM stock WHERE src = ? AND COALESCE(plant,'') || '|' || COALESCE(sloc,'') || '|' || so || '|' || li || '|' || material || '|' || COALESCE(batch,'') IN (SELECT jsonb_array_elements_text((?::text)::jsonb))`)
        .bind(body.src, JSON.stringify(mapped.map(stockId))));
    } else stmts.push(env.PG.prepare('DELETE FROM stock WHERE src = ?').bind(body.src));
    stmts.push(...jsonInsert(env, 'stock', ['src', 'key', 'plant', 'sloc', 'so_plant', 'so', 'li', 'material', 'batch', 'style', 'ur', 'qi', 'block', 'assigned', 'total'], mapped));
  }
  if (mapped.length === 0) throw new HttpError(400, `No usable rows found for ${SRC_LABEL[body.src]}. Check the column mapping (SO, LI and Item/Material are required).`);

  stmts.push(env.PG.prepare('INSERT INTO uploads (src, file_name, sheet_name, row_count, uploaded_by, uploaded_at, mode) VALUES (?,?,?,?,?,?,?)')
    .bind(body.src, body.fileName || null, body.sheetName || null, mapped.length, s.u, now(), body.src !== 'plan' && body.mode === 'add' ? 'add' : null));
  stmts.push(env.PG.prepare('INSERT INTO activity (at, username, action, detail) VALUES (?,?,?,?)')
    .bind(now(), s.u, 'upload', `${SRC_LABEL[body.src]}${body.mode === 'add' && body.src !== 'plan' ? ' (added to current)' : ''}${weeks.length ? ' ' + weeks.map((w) => 'W' + w.slice(-2)).join(', ') : ''}${planSummary?.plant ? ' · ' + planSummary.plant : ''}: ${planSummary ? `${planSummary.added} new, ${planSummary.updated} updated${planSummary.removed ? `, ${planSummary.removed} removed` : ''}` : mapped.length + ' rows'}${body.fileName ? ' from ' + body.fileName : ''}`));
  await env.PG.batch(stmts); // all or nothing

  await broadcast(env, { type: 'data', src: body.src, by: s.u, rows: mapped.length, weeks });
  return json({ ok: true, src: body.src, accepted: mapped.length, skipped: body.rows.length - mapped.length - (Number(planSummary?.inFileDups) || 0) - stockDups, stockDups, mode: body.src === 'plan' ? undefined : body.mode === 'add' ? 'add' : 'replace', weeks, ...(planSummary || {}) });
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
    string_agg(DISTINCT CASE WHEN src='zmmbe' THEN plant END, ',') AS stock_plant,
    string_agg(DISTINCT CASE WHEN src='zmmbe' THEN sloc END, ',')  AS stock_sloc,
    string_agg(DISTINCT CASE WHEN src='plant' THEN plant END, ',') AS at_plant
  FROM stock GROUP BY key
),
t AS (SELECT key, SUM(qty) AS tn_qty, string_agg(DISTINCT tn, ',') AS tn_number FROM trr GROUP BY key),
d AS (SELECT key, COUNT(*)::int AS dup FROM plan WHERE week = ?1::text GROUP BY key)
SELECT p.id, p.row_no, p.key, p.week, p.src_user, p.src_at, p.so, p.li, p.item, p.date, p.qty, p.plant, p.remarks,
  COALESCE(s.ur,0) AS ur, COALESCE(s.qi,0) AS qi, COALESCE(s.block,0) AS block, COALESCE(s.assigned,0) AS assigned,
  p.qty - COALESCE(s.assigned,0) AS variance,
  COALESCE(s.kfc_ur,0) AS kfc_ur, COALESCE(s.kfc_qi,0) AS kfc_qi, COALESCE(s.kfc_block,0) AS kfc_block,
  COALESCE(s.pfc_ur,0) AS pfc_ur, COALESCE(s.pfc_qi,0) AS pfc_qi, COALESCE(s.pfc_block,0) AS pfc_block,
  COALESCE(s.plant_qty,0) AS plant_qty, s.stock_plant, s.stock_sloc, s.at_plant,
  COALESCE(t.tn_qty,0) AS tn_qty, t.tn_number, d.dup,
  CASE WHEN ?2::text IS NOT NULL AND EXISTS (
    SELECT 1 FROM plan pp LEFT JOIN line_status pls ON pls.key = pp.week || '#' || pp.key
    WHERE pp.week = ?2::text AND pp.key = p.key AND lower(COALESCE(pls.status, '')) NOT LIKE '%done%'
  ) THEN 1 ELSE 0 END AS carried,
  ls.status, ls.comment, ls.vehicle, ls.qi_note, ls.updated_by, ls.updated_at
FROM plan p
LEFT JOIN s  ON s.key = p.key
LEFT JOIN t  ON t.key = p.key
LEFT JOIN d  ON d.key = p.key
LEFT JOIN line_status ls ON ls.key = p.week || '#' || p.key
WHERE p.week = ?1::text
ORDER BY p.row_no, p.id`;

const WEEKS_SQL = `
SELECT p.week, COUNT(*)::int AS lines, MIN(p.date) AS start, MAX(p.date) AS "end", SUM(p.qty) AS qty,
  SUM(CASE WHEN lower(COALESCE(ls.status, '')) LIKE '%done%' THEN 1 ELSE 0 END)::int AS done
FROM plan p LEFT JOIN line_status ls ON ls.key = p.week || '#' || p.key
GROUP BY p.week ORDER BY p.week DESC`;

async function handlePullPlan(env: Env, req: Request) {
  // public: the dashboard can be viewed without signing in (uploads and edits still need a login)
  const weeksRes = await env.PG.prepare(WEEKS_SQL).all<{ week: string }>();
  const weeks = weeksRes.results;
  const asked = new URL(req.url).searchParams.get('week');
  const week = asked && weeks.some((w) => w.week === asked) ? asked : weeks[0]?.week ?? null; // default: most recent week
  const prevWeek = weeks[weeks.findIndex((w) => w.week === week) + 1]?.week ?? null; // the week before it (weeks are newest first)
  const [rows, uploads, counts] = await env.PG.batch([
    env.PG.prepare(PULL_PLAN_SQL).bind(week, prevWeek),
    env.PG.prepare(`SELECT u.src, u.file_name, u.sheet_name, u.row_count, u.uploaded_by, u.uploaded_at FROM uploads u
                    JOIN (SELECT src, MAX(id) id FROM uploads GROUP BY src) m ON m.id = u.id`),
    env.PG.prepare(`SELECT 'plan' src, COUNT(*)::int n FROM plan UNION ALL SELECT src, COUNT(*)::int FROM stock GROUP BY src UNION ALL SELECT 'trr', COUNT(*)::int FROM trr`),
  ]);
  const plan = rows.results as Row[];
  // QI / Block released to UR by hand: counts until a newer ZMMBE upload (which then shows the stock as UR itself)
  // stock "as of": the latest FULL ZMMBE upload (a part file added to it does not refresh the other rows)
  const zAt = (await env.PG.prepare("SELECT MAX(uploaded_at) at FROM uploads WHERE src = 'zmmbe' AND COALESCE(mode, '') <> 'add'").first<{ at: string | null }>())?.at ?? undefined;
  const rels = week ? (await env.PG.prepare('SELECT key, qi, block, by_user, at FROM stock_release WHERE week = ? ORDER BY at, key').bind(week).all<Row>()).results : [];
  const releases: Row[] = [];
  for (const rl of rels) {
    const active = !zAt || String(rl.at) > zAt;
    releases.push({ ...rl, active });
    if (!active) continue;
    for (const r of plan) if (r.key === rl.key) {
      const q = Math.min(Number(rl.qi), Number(r.qi)), b = Math.min(Number(rl.block), Number(r.block));
      r.ur = Math.round((Number(r.ur) + q + b) * 1000) / 1000; r.qi = Number(r.qi) - q; r.block = Number(r.block) - b; r.released = q + b;
      r.variance = Number(r.qty) - Number(r.assigned);
    }
  }
  const assignAll = (await env.PG.prepare('SELECT id, week, item, line, qty, by_user, at FROM dispatch_assign').all<Assign>()).results;
  const assignOf = (w: string | null) => assignAll.filter((a) => a.week === w);
  const plants = (await env.PG.prepare('SELECT code, name, responsible, target, sort FROM plant_info ORDER BY sort, code').all<Row>()).results;
  const received = week ? (await env.PG.prepare('SELECT code, received FROM plant_received WHERE week = ?').bind(week).all<Row>()).results : [];
  // dispatch, all weeks at once: [week, item] totals
  // qty_after = dispatch first uploaded after the latest ZMMBE: that stock is still in ZMMBE's UR, so it comes off UR here.
  // Dispatch before that ZMMBE is already gone from its UR and is not taken off again.
  const dispAll = (await env.PG.prepare(`SELECT week, item, SUM(qty) qty, SUM(CASE WHEN ?1::text IS NULL OR COALESCE(first_at, uploaded_at) > ?1::text THEN qty ELSE 0 END) qty_after, COUNT(*)::int n
    FROM dispatch GROUP BY week, item`).bind(zAt ?? null).all<{ week: string; item: string; qty: number; qty_after: number; n: number }>()).results;
  const dispOf = (w: string | null) => dispAll.filter((d) => d.week === w);
  const dispatch = allocateDispatch(plan, dispOf(week), assignOf(week), zAt) as ReturnType<typeof allocateDispatch> & { planLines?: number; elsewhere?: Record<string, string[]> };
  dispatch.planLines = plan.length;
  // for items not in this week's plan: which other weeks have them (helps spot a wrong week or a plan that needs uploading again)
  if (dispatch.unmatched.length) {
    const found = (await env.PG.prepare('SELECT DISTINCT week, item FROM plan WHERE item IN (SELECT jsonb_array_elements_text((?::text)::jsonb)) ORDER BY week DESC')
      .bind(JSON.stringify(dispatch.unmatched.map((i) => normId(i.item)))).all<{ week: string; item: string }>()).results;
    dispatch.elsewhere = {};
    for (const f of found) (dispatch.elsewhere[f.item] ||= []).push(f.week);
  }
  // other weeks that have dispatch: work out which of their lines are complete, so the week list and "carried over" agree with the dashboard
  const otherWeeks = Array.from(new Set(dispAll.map((d) => d.week))).filter((w) => w !== week && weeks.some((x) => x.week === w));
  const complete = new Map<string, Row[]>(); // week → plan rows after allocation
  complete.set(String(week), plan);
  if (otherWeeks.length) {
    const light = (await env.PG.prepare(`SELECT p.row_no, p.key, p.week, p.item, p.date, p.qty, 0 AS ur, ls.status FROM plan p
      LEFT JOIN line_status ls ON ls.key = p.week || '#' || p.key WHERE p.week IN (SELECT jsonb_array_elements_text((?::text)::jsonb))`).bind(JSON.stringify(otherWeeks)).all<Row>()).results;
    for (const w of otherWeeks) { const r = light.filter((x) => x.week === w); r.forEach((x) => { x.balance = x.qty; }); allocateDispatch(r, dispOf(w), assignOf(w)); complete.set(w, r); }
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
  return json({ week, prevWeek, weeks, rows: plan, dispatch, stockAt: zAt ?? null, releases, plants, received, uploads: uploads.results, counts: counts.results, generatedAt: now() });
}

/**
 * Dispatched quantity per item is taken off that item's plan lines, earliest date first
 * (then plan order). Each line gets: dispatched, balance (QTY − dispatched) and ur_left (UR − dispatched).
 * Whatever is left after every line of the item is full is reported as over-dispatched.
 */
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
  if (!b.week || !code) throw new HttpError(400, 'Choose the week and plant.');
  const v = String(b.received ?? '').trim();
  if (!v) await env.PG.prepare('DELETE FROM plant_received WHERE week = ? AND code = ?').bind(b.week, code).run();
  else await env.PG.prepare('INSERT INTO plant_received (week, code, received, by_user, at) VALUES (?,?,?,?,?) ON CONFLICT (week, code) DO UPDATE SET received = excluded.received, by_user = excluded.by_user, at = excluded.at').bind(b.week, code, v.slice(0, 20), s.u, now()).run();
  await broadcast(env, { type: 'data', src: 'plants', by: s.u, rows: 0, weeks: [b.week] });
  return json({ ok: true });
}

async function handlePlants(env: Env, req: Request) {
  if (req.method === 'GET') return json({ plants: (await env.PG.prepare('SELECT code, name, responsible, target, sort FROM plant_info ORDER BY sort, code').all()).results });
  const s = await requireUser(env, req, 'editor');
  const b = (await req.json()) as { plants?: { code: string; name?: string; responsible?: string; target?: string; sort?: number }[]; remove?: string[] };
  const stmts: Stmt[] = [];
  for (const p of b.plants || []) {
    const code = String(p.code || '').trim().toUpperCase();
    if (!code) continue;
    stmts.push(env.PG.prepare('INSERT INTO plant_info (code, name, responsible, target, sort) VALUES (?,?,?,?,?) ON CONFLICT (code) DO UPDATE SET name = excluded.name, responsible = excluded.responsible, target = excluded.target, sort = excluded.sort')
      .bind(code, txt(p.name), txt(p.responsible), txt(p.target), Number(p.sort) || 0));
  }
  for (const c of b.remove || []) stmts.push(env.PG.prepare('DELETE FROM plant_info WHERE code = ?').bind(String(c).toUpperCase()));
  if (!stmts.length) throw new HttpError(400, 'Nothing to save.');
  stmts.push(env.PG.prepare('INSERT INTO activity (at, username, action, detail) VALUES (?,?,?,?)').bind(now(), s.u, 'plants', `Plant settings saved (${(b.plants || []).length})`));
  await env.PG.batch(stmts);
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
    await env.PG.prepare(`DELETE FROM stock_release WHERE week = ?${key ? ' AND key = ?' : ''}`).bind(...(key ? [week, key] : [week])).run();
    await broadcast(env, { type: 'data', src: 'release', by: s.u, rows: 0, weeks: [week] });
    return json({ ok: true });
  }
  if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
  const b = (await req.json()) as { week?: string; lines?: { key: string; qi?: number; block?: number }[] };
  if (!b.week || !Array.isArray(b.lines) || !b.lines.length) throw new HttpError(400, 'Choose the lines to release.');
  const at = now();
  const stmts = b.lines.filter((l) => l.key && (num(l.qi) > 0 || num(l.block) > 0)).map((l) =>
    env.PG.prepare('INSERT INTO stock_release (week, key, qi, block, by_user, at) VALUES (?,?,?,?,?,?) ON CONFLICT (week, key) DO UPDATE SET qi = excluded.qi, block = excluded.block, by_user = excluded.by_user, at = excluded.at').bind(b.week, l.key, Math.max(0, num(l.qi)), Math.max(0, num(l.block)), s.u, at));
  if (!stmts.length) throw new HttpError(400, 'Nothing to release: those lines have no QI or Block stock.');
  const qty = b.lines.reduce((t, l) => t + Math.max(0, num(l.qi)) + Math.max(0, num(l.block)), 0);
  stmts.push(env.PG.prepare('INSERT INTO activity (at, username, action, detail) VALUES (?,?,?,?)').bind(at, s.u, 'release', `Released ${Math.round(qty * 1000) / 1000} QI/Block to UR on ${stmts.length} line(s), ${b.week}`));
  await env.PG.batch(stmts);
  await broadcast(env, { type: 'data', src: 'release', by: s.u, rows: stmts.length - 1, weeks: [b.week] });
  return json({ ok: true, lines: stmts.length - 1, qty });
}

/** POST {week, item, key, date, qty} assigns left-over dispatch of an item to a plan line; DELETE /api/dispatch/assign/:id removes it. */
async function handleAssign(env: Env, req: Request, id: string) {
  const s = await requireUser(env, req, 'editor');
  if (req.method === 'DELETE') {
    const row = await env.PG.prepare('SELECT week FROM dispatch_assign WHERE id = ?').bind(Number(id)).first<{ week: string }>();
    if (!row) throw new HttpError(404, 'That assignment is already gone.');
    await env.PG.prepare('DELETE FROM dispatch_assign WHERE id = ?').bind(Number(id)).run();
    await broadcast(env, { type: 'data', src: 'dispatch', by: s.u, rows: 0, weeks: [row.week] });
    return json({ ok: true });
  }
  if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
  const b = (await req.json()) as { week?: string; item?: string; key?: string; date?: string | null; qty?: number; lines?: { key: string; date: string | null; qty: number }[] };
  if (b.item === UR_LEFT && Array.isArray(b.lines)) {
    if (!b.week || !b.lines.length) throw new HttpError(400, 'Choose the lines.');
    const list = b.lines.filter((l) => l.key && num(l.qty) > 0);
    const at = now();
    const stmts = list.map((l) => env.PG.prepare('INSERT INTO dispatch_assign (week, item, line, qty, by_user, at) VALUES (?,?,?,?,?,?)').bind(b.week, UR_LEFT, `${l.key}|${l.date ?? ''}`, num(l.qty), s.u, at));
    if (!stmts.length) throw new HttpError(400, 'Those lines have no UR left to add.');
    const qty = list.reduce((t, l) => t + num(l.qty), 0);
    stmts.push(env.PG.prepare('INSERT INTO activity (at, username, action, detail) VALUES (?,?,?,?)').bind(at, s.u, 'dispatch', `UR left added to Dispatched: ${Math.round(qty * 1000) / 1000} on ${list.length} line(s), ${b.week}`));
    for (let i = 0; i < stmts.length; i += 90) await env.PG.batch(stmts.slice(i, i + 90));
    await broadcast(env, { type: 'data', src: 'dispatch', by: s.u, rows: list.length, weeks: [b.week] });
    return json({ ok: true, lines: list.length, qty });
  }
  const qty = num(b.qty);
  if (!b.week || !b.item || !b.key || !(qty > 0)) throw new HttpError(400, 'Choose the dispatch item, a plan line and a QTY above 0.');
  const line = await env.PG.prepare('SELECT so, li, item FROM plan WHERE week = ? AND key = ? AND COALESCE(date, \'\') = ?').bind(b.week, b.key, b.date ?? '').first<Row>();
  if (!line) throw new HttpError(404, 'That plan line is not in this week.');
  await env.PG.batch([
    env.PG.prepare('INSERT INTO dispatch_assign (week, item, line, qty, by_user, at) VALUES (?,?,?,?,?,?)').bind(b.week, normId(b.item), `${b.key}|${b.date ?? ''}`, qty, s.u, now()),
    env.PG.prepare('INSERT INTO activity (at, username, action, detail) VALUES (?,?,?,?)').bind(now(), s.u, 'dispatch', `${b.item === UR_LEFT ? 'UR left added to Dispatched:' : 'Assigned'} ${qty}${b.item === UR_LEFT ? '' : ' of dispatch item ' + normId(b.item)} to ${line.so} / ${line.li} / ${line.item} (${b.week})`),
  ]);
  await broadcast(env, { type: 'data', src: 'dispatch', by: s.u, rows: 1, weeks: [b.week] });
  return json({ ok: true });
}

// ---------------------------------------------------------------- dispatch uploads

async function handleDispatch(env: Env, req: Request) {
  const url = new URL(req.url);
  if (req.method === 'GET') {
    const week = url.searchParams.get('week');
    if (!week) throw new HttpError(400, 'Choose a week.');
    const [rows, ups] = await env.PG.batch([
      env.PG.prepare('SELECT item, qty, raw_qty, factor, pallet, location, lot, order_no, uom, file_name, uploaded_by, uploaded_at FROM dispatch WHERE week = ? ORDER BY item, order_no, pallet').bind(week),
      env.PG.prepare("SELECT at, username, detail FROM activity WHERE action = 'dispatch' ORDER BY id DESC LIMIT 15"),
    ]);
    return json({ week, rows: rows.results, history: ups.results });
  }
  const s = await requireUser(env, req, 'editor');
  if (req.method === 'DELETE') {
    const week = url.searchParams.get('week');
    if (!week || !/^\d{4}-W\d{2}$/.test(week)) throw new HttpError(400, 'Week must look like 2026-W42.');
    await env.PG.batch([
      env.PG.prepare('DELETE FROM dispatch WHERE week = ?').bind(week),
      env.PG.prepare('INSERT INTO activity (at, username, action, detail) VALUES (?,?,?,?)').bind(now(), s.u, 'dispatch', `Cleared dispatch for ${week}`),
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
  const firstSeen = new Map((await env.PG.prepare('SELECT ident, COALESCE(first_at, uploaded_at) first_at FROM dispatch WHERE week = ?').bind(b.week).all<{ ident: string; first_at: string }>()).results.map((r) => [r.ident, r.first_at]));
  const existing = new Set(firstSeen.keys());
  // when a pallet was first uploaded decides whether a later ZMMBE already shows it gone, so re-uploads keep that time
  for (const r of list) r.first_at = firstSeen.get(String(r.ident)) || r.uploaded_at;
  const updated = list.filter((r) => existing.has(String(r.ident))).length;
  const removed = b.mode === 'replace-week' ? Array.from(existing).filter((x) => !mapped.has(x)).length : 0;
  // which items have plan lines in that week
  const planItems = new Set((await env.PG.prepare('SELECT DISTINCT item FROM plan WHERE week = ?').bind(b.week).all<{ item: string }>()).results.map((r) => normId(r.item)));
  const items = Array.from(new Set(list.map((r) => String(r.item))));
  const preview = {
    week: b.week, lines: list.length, added: list.length - updated, updated, removed, skipped, inFileDups: b.rows.length - skipped - list.length,
    totalQty: Math.round(list.reduce((t, r) => t + Number(r.qty), 0) * 1000) / 1000, items: items.length,
    matched: items.filter((i) => planItems.has(i)).length, unmatched: items.filter((i) => !planItems.has(i)),
  };
  if (b.dryRun) return json({ ok: true, dryRun: true, ...preview });
  const stmts: Stmt[] = [];
  if (b.mode === 'replace-week') stmts.push(env.PG.prepare('DELETE FROM dispatch WHERE week = ?').bind(b.week));
  const cols = ['ident', 'week', 'item', 'qty', 'raw_qty', 'factor', 'pallet', 'location', 'lot', 'order_no', 'uom', 'client_so', 'file_name', 'sheet_name', 'uploaded_by', 'uploaded_at', 'first_at'];
  stmts.push(...jsonInsert(env, 'dispatch', cols, list, 1000, ` ON CONFLICT (ident) DO UPDATE SET ${cols.filter((c) => c !== 'ident').map((c) => `${c} = excluded.${c}`).join(', ')}`));
  stmts.push(env.PG.prepare('INSERT INTO activity (at, username, action, detail) VALUES (?,?,?,?)').bind(now(), s.u, 'dispatch',
    `Dispatch W${b.week.slice(-2)}: ${preview.added} new, ${preview.updated} updated${removed ? `, ${removed} removed` : ''} · ${preview.totalQty} QTY${divide === 1000 ? ' (÷1000)' : ''}${b.toYards ? ' m→yd' : ''}${b.fileName ? ' from ' + b.fileName : ''}`));
  await env.PG.batch(stmts);
  await broadcast(env, { type: 'data', src: 'dispatch', by: s.u, rows: list.length, weeks: [b.week] });
  return json({ ok: true, ...preview });
}

async function handleStatus(env: Env, req: Request) {
  const s = await requireUser(env, req, 'editor');
  const b = (await req.json()) as { key: string; week?: string; status?: string | null; comment?: string | null; vehicle?: string | null; qi_note?: string | null };
  if (!b.key) throw new HttpError(400, 'Missing line key.');
  const week = b.week && /^\d{4}-W\d{2}$/.test(b.week) ? b.week
    : (await env.PG.prepare('SELECT MAX(week) w FROM plan WHERE key = ?').bind(b.key).first<{ w: string | null }>())?.w || thisWeek();
  const sKey = `${week}#${b.key}`;
  const fields = (['status', 'comment', 'vehicle', 'qi_note'] as const).filter((f) => f in b);
  if (!fields.length) throw new HttpError(400, 'Nothing to change.');
  const cur = await env.PG.prepare('SELECT status, comment, vehicle, qi_note FROM line_status WHERE key = ?').bind(sKey).first<Row>();
  const next: Row = { status: null, comment: null, vehicle: null, qi_note: null, ...(cur || {}) };
  for (const f of fields) next[f] = txt(b[f]);
  await env.PG.batch([
    env.PG.prepare(`INSERT INTO line_status (key, status, comment, vehicle, qi_note, updated_by, updated_at) VALUES (?,?,?,?,?,?,?)
                    ON CONFLICT(key) DO UPDATE SET status=excluded.status, comment=excluded.comment, vehicle=excluded.vehicle,
                    qi_note=excluded.qi_note, updated_by=excluded.updated_by, updated_at=excluded.updated_at`)
      .bind(sKey, next.status, next.comment, next.vehicle, next.qi_note, s.u, now()),
    env.PG.prepare('INSERT INTO activity (at, username, action, detail) VALUES (?,?,?,?)')
      .bind(now(), s.u, 'edit', `W${week.slice(-2)} ${b.key.replace(/\|/g, ' / ')}: ${fields.map((f) => `${f} → ${next[f] ?? '(blank)'}`).join(', ')}`),
  ]);
  const line = { key: b.key, week, status: next.status, comment: next.comment, vehicle: next.vehicle, qi_note: next.qi_note, updated_by: s.u, updated_at: now() };
  await broadcast(env, { type: 'status', line, by: s.u });
  return json({ ok: true, line });
}

/** Edit, add or delete one plan line (editors). */
async function handlePlanLine(env: Env, req: Request, idPart: string) {
  const s = await requireUser(env, req, 'editor');
  if (req.method === 'POST') {
    const b = (await req.json()) as Row;
    const so = normId(b.so), li = normId(b.li), item = normId(b.item), date = normDate(b.date);
    if (!/^[A-Za-z]{0,4}\d/.test(so) || !li || !item) throw new HttpError(400, 'SO (e.g. 1001234567 or E101697207), LI and Item Code are required.');
    if (!(num(b.qty) > 0)) throw new HttpError(400, 'QTY must be more than 0.');
    const week = typeof b.week === 'string' && /^\d{4}-W\d{2}$/.test(b.week) ? b.week : weekId(date) || thisWeek();
    const key = lineKey(so, li, item);
    const dupe = await env.PG.prepare('SELECT id FROM plan WHERE week = ? AND key = ? AND COALESCE(date, \'\') = ?').bind(week, key, date ?? '').first();
    if (dupe) throw new HttpError(409, 'That line (same SO, LI, Item and date) is already in this week. Edit it instead.');
    const r = await env.PG.prepare(`INSERT INTO plan (key, so, li, item, date, week, qty, plant, remarks, row_no, src_user, src_at)
      VALUES (?,?,?,?,?,?,?,?,?, (SELECT COALESCE(MAX(row_no), 0) + 1 FROM plan WHERE week = ?), ?, ?) RETURNING id`)
      .bind(key, so, li, item, date, week, num(b.qty), cleanPlant(b.plant) || (await userPlant(env, s.u)), txt(b.remarks), week, s.u, now()).first<{ id: number }>();
    await logActivity(env, s.u, 'line', `Added W${week.slice(-2)} ${so} / ${li} / ${item}: ${num(b.qty)}`);
    await broadcast(env, { type: 'data', src: 'plan', by: s.u, rows: 1, weeks: [week] });
    return json({ ok: true, id: Number(r?.id) });
  }
  const id = Number(idPart);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Unknown line.');
  const cur = await env.PG.prepare('SELECT * FROM plan WHERE id = ?').bind(id).first<Row>();
  if (!cur) throw new HttpError(404, 'That line is no longer in the plan. Refresh the page.');
  const label = `W${String(cur.week).slice(-2)} ${cur.so} / ${cur.li} / ${cur.item}`;
  if (req.method === 'DELETE') {
    await env.PG.batch([
      env.PG.prepare('DELETE FROM plan WHERE id = ?').bind(id),
      env.PG.prepare('INSERT INTO activity (at, username, action, detail) VALUES (?,?,?,?)').bind(now(), s.u, 'line', `Deleted ${label}`),
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
      const clash = await env.PG.prepare('SELECT id FROM plan WHERE week = ? AND key = ? AND COALESCE(date, \'\') = ? AND id <> ?').bind(cur.week, cur.key, next.date ?? '', id).first();
      if (clash) throw new HttpError(409, 'Another line with the same SO, LI, Item and that date already exists in this week.');
    }
    const changes = (['qty', 'date', 'plant', 'remarks'] as const).filter((f) => String(next[f] ?? '') !== String(cur[f] ?? '')).map((f) => `${f} ${cur[f] ?? '–'} → ${next[f] ?? '–'}`);
    if (!changes.length) return json({ ok: true, unchanged: true });
    await env.PG.batch([
      env.PG.prepare('UPDATE plan SET qty = ?, date = ?, plant = ?, remarks = ?, src_user = ?, src_at = ? WHERE id = ?').bind(next.qty, next.date, next.plant, next.remarks, s.u, now(), id),
      env.PG.prepare('INSERT INTO activity (at, username, action, detail) VALUES (?,?,?,?)').bind(now(), s.u, 'line', `Edited ${label}: ${changes.join(', ')}`),
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
  let user = await env.PG.prepare('SELECT * FROM users WHERE username = ?').bind(u).first<{ username: string; pass_hash: string; salt: string; role: Role }>();

  // First run: no users yet → this sign-in creates the first admin.
  // If ADMIN_USER / ADMIN_PASSWORD secrets are set, only those details are accepted; otherwise any username/password (6+ chars).
  if (!user) {
    const anyUser = await env.PG.prepare('SELECT COUNT(*)::int n FROM users').first<{ n: number }>();
    const noUsers = (anyUser?.n ?? 0) === 0;
    // Supabase still empty and the old D1 database is bound: an admin of the old system signing in copies everything over
    if (noUsers && env.DB && (await d1Users(env))) {
      const old = await env.DB.prepare('SELECT * FROM users WHERE username = ?').bind(u).first<{ username: string; pass_hash: string; salt: string; role: Role }>();
      if (old && old.role === 'admin' && safeEqual((await hashPassword(password, old.salt)).hash, old.pass_hash)) {
        await copyFromD1(env, u, true);
        user = old;
      }
    }
  }
  if (!user) {
    const anyUser = await env.PG.prepare('SELECT COUNT(*)::int n FROM users').first<{ n: number }>();
    const noUsers = (anyUser?.n ?? 0) === 0;
    const fromSecrets = !!(env.ADMIN_USER && env.ADMIN_PASSWORD);
    if (noUsers && !fromSecrets && password.length < 6) throw new HttpError(400, 'First sign-in creates the admin account: use a password of at least 6 characters.');
    if (noUsers && !fromSecrets && !/^[a-z0-9._-]{2,32}$/.test(u)) throw new HttpError(400, 'Username: 2–32 letters, numbers, dot, dash or underscore.');
    if (noUsers && (fromSecrets ? u === env.ADMIN_USER!.toLowerCase() && password === env.ADMIN_PASSWORD : true)) {
      const h = await hashPassword(password);
      await env.PG.prepare('INSERT INTO users (username, pass_hash, salt, role, created_at) VALUES (?,?,?,?,?)').bind(u, h.hash, h.salt, 'admin', now()).run();
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
    const r = await env.PG.prepare('SELECT username, role, plant, created_at FROM users ORDER BY username').all();
    return json({ users: r.results });
  }
  if (req.method === 'POST') {
    const b = (await req.json()) as { username?: string; password?: string; role?: Role; plant?: string | null };
    const u = (b.username || '').trim().toLowerCase();
    if (!/^[a-z0-9._-]{2,32}$/.test(u)) throw new HttpError(400, 'Username: 2–32 letters, numbers, dot, dash or underscore.');
    if (!b.role || !['admin', 'editor', 'viewer'].includes(b.role)) throw new HttpError(400, 'Choose a role.');
    const existing = await env.PG.prepare('SELECT username FROM users WHERE username = ?').bind(u).first();
    if (!existing && (!b.password || b.password.length < 6)) throw new HttpError(400, 'Password must be at least 6 characters.');
    if (b.password) {
      if (b.password.length < 6) throw new HttpError(400, 'Password must be at least 6 characters.');
      const h = await hashPassword(b.password);
      await env.PG.prepare(`INSERT INTO users (username, pass_hash, salt, role, created_at) VALUES (?,?,?,?,?)
        ON CONFLICT(username) DO UPDATE SET pass_hash=excluded.pass_hash, salt=excluded.salt, role=excluded.role`)
        .bind(u, h.hash, h.salt, b.role, now()).run();
    } else {
      await env.PG.prepare('UPDATE users SET role = ? WHERE username = ?').bind(b.role, u).run();
    }
    if ('plant' in b) await env.PG.prepare('UPDATE users SET plant = ? WHERE username = ?').bind(cleanPlant(b.plant), u).run();
    await logActivity(env, s.u, 'user', `${existing ? 'Updated' : 'Added'} ${u} (${b.role}${cleanPlant(b.plant) ? ', ' + cleanPlant(b.plant) : ''})`);
    return json({ ok: true });
  }
  if (req.method === 'DELETE') {
    const u = decodeURIComponent(path.split('/').pop() || '');
    if (u === s.u) throw new HttpError(400, 'You cannot remove your own account.');
    await env.PG.prepare('DELETE FROM users WHERE username = ?').bind(u).run();
    await logActivity(env, s.u, 'user', `Removed ${u}`);
    return json({ ok: true });
  }
  throw new HttpError(405, 'Method not allowed.');
}

async function handleClear(env: Env, req: Request, src: string) {
  const s = await requireUser(env, req, 'admin');
  if (!ALL_SRCS.includes(src as Src)) throw new HttpError(400, 'Unknown report type.');
  const wk = new URL(req.url).searchParams.get('week');
  if (src === 'plan' && wk) {
    if (!/^\d{4}-W\d{2}$/.test(wk)) throw new HttpError(400, 'Week must look like 2026-W42.');
    await env.PG.batch([
      env.PG.prepare('DELETE FROM plan WHERE week = ?').bind(wk),
      env.PG.prepare('INSERT INTO activity (at, username, action, detail) VALUES (?,?,?,?)').bind(now(), s.u, 'clear', `Deleted weekly plan ${wk}`),
    ]);
    await broadcast(env, { type: 'data', src, by: s.u, rows: 0, weeks: [wk] });
    return json({ ok: true });
  }
  const stmt = src === 'plan' ? 'DELETE FROM plan' : src === 'trr' ? 'DELETE FROM trr' : 'DELETE FROM stock WHERE src = ?';
  await env.PG.batch([
    src === 'plan' || src === 'trr' ? env.PG.prepare(stmt) : env.PG.prepare(stmt).bind(src),
    env.PG.prepare('INSERT INTO activity (at, username, action, detail) VALUES (?,?,?,?)').bind(now(), s.u, 'clear', `Cleared ${SRC_LABEL[src as Src]}`),
  ]);
  await broadcast(env, { type: 'data', src, by: s.u, rows: 0 });
  return json({ ok: true });
}

// ---------------------------------------------------------------- router

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const cors = corsHeaders(env, req);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    let sql: Sql | null = null;
    try {
      const p = url.pathname.replace(/\/+$/, '');
      // the setup page and its form work before Supabase is connected
      if (p === '/setup') return new Response(SETUP_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      if (p === '/api/setup' && req.method === 'POST') { const r = await handleSetup(env, req, ctx); return new Response(r.body, { status: r.status, headers: { ...Object.fromEntries(r.headers), ...cors } }); }
      const dbUrl = await databaseUrl(env);
      if (!dbUrl) {
        if (p === '/api/health') return new Response(JSON.stringify({ ok: false, db: 'not connected', setup: `open ${url.origin}/setup to connect Supabase`, version: API_VERSION }), { headers: { 'Content-Type': 'application/json', ...cors } });
        throw new HttpError(503, `Supabase is not connected yet. Open ${url.origin}/setup to connect it.`);
      }
      sql = connect(dbUrl);
      // a fresh env object per request: requests running at the same time must not share one connection
      env = { ...env, PG: new Db(sql) };
      if (p !== '/api/live') await ensureSchema(env);

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
        const users = (await env.PG.prepare('SELECT COUNT(*)::int n FROM users').first<{ n: number }>())?.n ?? 0;
        const plan = (await env.PG.prepare('SELECT COUNT(*)::int n FROM plan').first<{ n: number }>())?.n ?? 0;
        let d1 = 'not bound';
        if (env.DB) { try { const n = (await env.DB.prepare('SELECT COUNT(*) n FROM users').first<{ n: number }>())?.n ?? 0; d1 = `bound, ${n} users`; } catch (e) { d1 = isD1Limit(e) ? 'bound, daily read limit reached (resets 5:30 AM Sri Lanka time)' : 'bound, empty'; } }
        res = json({
          ok: true, db: 'supabase', users, planLines: plan, d1,
          setup: users === 0 ? (env.DB ? 'ready: sign in with your old admin account to copy everything from D1, or with a new name/password to start empty' : 'ready: the first sign-in creates the admin account') : 'done',
          realtime: env.HUB ? 'on' : 'off (polling)', version: API_VERSION, at: now(),
        });
      }
      else if (p === '/api/admin/copy-d1' && req.method === 'POST') { const s = await requireUser(env, req, 'admin'); res = json(await copyFromD1(env, s.u, true)); }
      else if (p === '/api/auth/login' && req.method === 'POST') res = await handleLogin(env, req);
      else if (p === '/api/me') { const s = await requireUser(env, req); res = json({ user: { username: s.u, role: s.role, plant: await userPlant(env, s.u) } }); }
      else if (p === '/api/plan' || p.startsWith('/api/plan/')) res = await handlePlanLine(env, req, p.split('/')[3] || '');
      else if (p === '/api/dispatch') res = await handleDispatch(env, req);
      else if (p.startsWith('/api/dispatch/assign')) res = await handleAssign(env, req, p.split('/')[4] || '');
      else if (p === '/api/release') res = await handleRelease(env, req);
      else if (p === '/api/plants') res = await handlePlants(env, req);
      else if (p === '/api/plants/received') res = await handleReceived(env, req);
      else if (p === '/api/pullplan' && req.method === 'GET') res = await handlePullPlan(env, req);
      else if (p === '/api/upload' && req.method === 'POST') res = await handleUpload(env, req);
      else if (p === '/api/status' && req.method === 'PATCH') res = await handleStatus(env, req);
      else if (p === '/api/activity') {
        await requireUser(env, req);
        const only = url.searchParams.get('action');
        const r = only
          ? await env.PG.prepare('SELECT at, username, action, detail FROM activity WHERE action = ? ORDER BY id DESC LIMIT 30').bind(only).all()
          : await env.PG.prepare('SELECT at, username, action, detail FROM activity ORDER BY id DESC LIMIT 60').all();
        res = json({ activity: r.results });
      } else if (p.startsWith('/api/users')) res = await handleUsers(env, req, p);
      else if (p.startsWith('/api/data/') && req.method === 'DELETE') res = await handleClear(env, req, p.split('/').pop() || '');
      else if (p === '/api/online') {
        await requireUser(env, req);
        res = env.HUB ? await env.HUB.get(env.HUB.idFromName('main')).fetch('https://hub/online') : json({ online: [] });
      } else throw new HttpError(404, 'Not found.');

      const h = new Headers(res.headers);
      Object.entries(cors).forEach(([k, v]) => h.set(k, v));
      return new Response(res.body, { status: res.status, headers: h });
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      let message = e instanceof Error ? e.message : 'Unexpected error.';
      if (status === 500) {
        console.error(e);
        if (/password authentication|ENOTFOUND|ECONNREFUSED|getaddrinfo|connect|Tenant or user not found|timeout/i.test(message)) message = `Cannot connect to Supabase: ${message}. Check the DATABASE_URL secret (use the Transaction pooler string, with your database password).`;
      }
      return new Response(JSON.stringify({ error: message }), { status, headers: { 'Content-Type': 'application/json', ...cors } });
    } finally {
      if (sql) ctx.waitUntil(sql.end({ timeout: 3 }).catch(() => {}));
    }
  },
};

// ---------------------------------------------------------------- connecting Supabase without Worker secrets

/** Where the Supabase connection string comes from: the DATABASE_URL secret, the constant at the top, or the setup page (kept in D1). */
let cachedUrl: string | null = null;
async function databaseUrl(env: Env): Promise<string> {
  const direct = (env.DATABASE_URL || DATABASE_URL_FALLBACK).trim();
  if (direct) return direct;
  if (cachedUrl) return cachedUrl;
  if (!env.DB) return '';
  try { cachedUrl = (await env.DB.prepare("SELECT v FROM config WHERE k = 'database_url'").first<{ v: string }>())?.v || null; } catch { cachedUrl = null; }
  return cachedUrl || '';
}

/**
 * POST {username, password, databaseUrl}: an admin of the current system connects (or changes) the Supabase database.
 * The string is tested, saved in D1 (never in the code), the tables are created and — if Supabase is still empty — all D1 data is copied.
 */
async function handleSetup(env: Env, req: Request, ctx: ExecutionContext): Promise<Response> {
  const b = (await req.json().catch(() => ({}))) as { username?: string; password?: string; databaseUrl?: string; recopy?: boolean | string };
  const recopy = b.recopy === true || b.recopy === 'on';
  const u = String(b.username || '').trim().toLowerCase(), pw = String(b.password || '');
  const target = String(b.databaseUrl || '').trim();
  const fail = (status: number, error: string) => json({ error }, status);
  if (!env.DB) return fail(400, 'This Worker has no D1 database bound as DB, so the setup page cannot save the connection. Paste the string into DATABASE_URL_FALLBACK at the top of worker.js instead.');
  if (!/^postgres(ql)?:\/\/[^\s]+@[^\s]+$/.test(target)) return fail(400, 'Paste the full connection string, e.g. postgresql://postgres.abcd:YOUR-PASSWORD@aws-0-ap-south-1.pooler.supabase.com:6543/postgres');
  if (/\[YOUR-PASSWORD\]/i.test(target)) return fail(400, 'Replace [YOUR-PASSWORD] in the string with your Supabase database password.');
  // who may do this: an admin of the system as it is now (the Supabase in use, otherwise D1)
  const current = await databaseUrl(env);
  let admin = false;
  const check = async (row: { pass_hash: string; salt: string; role: string } | null) => !!row && row.role === 'admin' && safeEqual((await hashPassword(pw, row.salt)).hash, row.pass_hash);
  if (current) {
    const cur = connect(current);
    try { admin = await check((await new Db(cur).prepare('SELECT * FROM users WHERE username = ?').bind(u).first()) as never); } catch { /* old database unreachable: fall back to D1 */ }
    finally { ctx.waitUntil(cur.end({ timeout: 2 }).catch(() => {})); }
  }
  let d1Locked = false;
  if (!admin) { try { admin = await check(await env.DB.prepare('SELECT * FROM users WHERE username = ?').bind(u).first()); } catch (e) { d1Locked = isD1Limit(e); } }
  if (!admin) {
    if (d1Locked && !current) return fail(503, 'Cloudflare D1 has reached its free daily read limit, so your admin account cannot be checked until 5:30 AM Sri Lanka time. To start on Supabase now: in Cloudflare → Edit code, search DATABASE_URL_FALLBACK and paste the connection string between the quotes, then Deploy.');
    const anyD1 = await d1Users(env);
    if (anyD1 || current) return fail(401, 'Sign in with an admin username and password of this system.');
  }
  // test the new connection and create the tables
  const sql = connect(target);
  try {
    const e: Env = { ...env, PG: new Db(sql) };
    await sql`select 1`;
    schemaReady = false;
    await ensureSchema(e);
    if (target !== (env.DATABASE_URL || DATABASE_URL_FALLBACK).trim()) {
      await env.DB.prepare('CREATE TABLE IF NOT EXISTS config (k TEXT PRIMARY KEY, v TEXT NOT NULL)').run();
      await env.DB.prepare("INSERT INTO config (k, v) VALUES ('database_url', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(target).run();
    }
    cachedUrl = target;
    const pgUsers = (await e.PG.prepare('SELECT COUNT(*)::int n FROM users').first<{ n: number }>())?.n ?? 0;
    // copy the old D1 data: automatically into an empty Supabase, or on request ("Copy the old data again" replaces Supabase's data)
    const copied = recopy || (pgUsers === 0 && (await d1Users(env))) ? (await copyFromD1(e, u || 'setup', true)).copied : null;
    const lines = (await e.PG.prepare('SELECT COUNT(*)::int n FROM plan').first<{ n: number }>())?.n ?? 0;
    return json({ ok: true, copied, planLines: lines, users: (await e.PG.prepare('SELECT COUNT(*)::int n FROM users').first<{ n: number }>())?.n ?? 0 });
  } catch (x) {
    if (x instanceof HttpError) return fail(x.status, x.message);
    const m = x instanceof Error ? x.message : String(x);
    if (isD1Limit(x)) return fail(503, D1_LIMIT_MSG);
    return fail(400, `Could not connect to Supabase: ${m}. Use the "Transaction pooler" string from Supabase → Connect, with your database password.`);
  } finally { ctx.waitUntil(sql.end({ timeout: 3 }).catch(() => {})); }
}

const SETUP_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect Supabase · MAS Weekly Plan Tracker</title>
<style>
:root{--bg:#f6f5f2;--panel:#fff;--ink:#1c1b19;--ink2:#5c5a55;--line:#e3e0da;--acc:#e8590c;--ok:#15803d;--bad:#b91c1c}
@media (prefers-color-scheme:dark){:root{--bg:#121417;--panel:#1b1e23;--ink:#eceae6;--ink2:#a5a29c;--line:#2c3037;--acc:#ff7a2e;--ok:#4ade80;--bad:#f87171}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;display:grid;place-items:start center;padding:40px 16px}
main{width:min(560px,100%);background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:24px}
h1{font-size:20px;margin:0 0 4px}p{color:var(--ink2);margin:0 0 16px}label{display:grid;gap:4px;font-weight:600;font-size:13px;margin-bottom:12px}
input{font:inherit;padding:9px 11px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink);width:100%}
button{font:inherit;font-weight:600;background:var(--acc);color:#fff;border:0;border-radius:8px;padding:10px 16px;cursor:pointer;width:100%}
button:disabled{opacity:.6;cursor:wait}.msg{margin-top:14px;padding:10px 12px;border-radius:8px;font-size:14px;white-space:pre-wrap}
.ok{background:color-mix(in srgb,var(--ok) 14%,transparent);color:var(--ok)}.bad{background:color-mix(in srgb,var(--bad) 14%,transparent);color:var(--bad)}
ol{color:var(--ink2);font-size:13.5px;padding-left:18px;margin:0 0 16px}code{font-size:12.5px}
</style></head><body><main>
<h1>Connect Supabase</h1>
<p>Moves MAS Weekly Plan Tracker's data to Supabase. The first time, everything in the current database is copied over.</p>
<ol><li>Supabase → your project → <b>Connect</b> → <b>Transaction pooler</b> → copy the string.</li>
<li>Put your database password in place of <code>[YOUR-PASSWORD]</code>.</li>
<li>Sign in below with your current admin account.</li></ol>
<form id="f">
<label>Admin username<input name="username" autocomplete="username" required></label>
<label>Password<input name="password" type="password" autocomplete="current-password" required></label>
<label>Supabase connection string<input name="databaseUrl" placeholder="postgresql://postgres.xxxx:password@aws-0-ap-south-1.pooler.supabase.com:6543/postgres" required spellcheck="false"></label>
<label style="display:flex;gap:8px;align-items:center;font-weight:500"><input type="checkbox" name="recopy" style="width:auto"> Copy the old data again (replaces what Supabase has now with the old D1 data)</label>
<button id="b">Connect and copy data</button>
</form>
<div id="m" class="msg" hidden></div>
</main>
<script>
const f=document.getElementById('f'),b=document.getElementById('b'),m=document.getElementById('m');
f.onsubmit=async(e)=>{e.preventDefault();b.disabled=true;b.textContent='Connecting… (copying can take a minute)';m.hidden=true;
try{const r=await fetch('/api/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.fromEntries(new FormData(f)))});const d=await r.json();
m.hidden=false;if(!r.ok){m.className='msg bad';m.textContent=d.error||('Failed ('+r.status+')');}
else{m.className='msg ok';const c=d.copied?Object.entries(d.copied).filter(([,n])=>n).map(([t,n])=>t+' '+n).join(', '):'nothing (Supabase already had data)';
m.textContent='Connected. Copied: '+c+'. Supabase now has '+d.planLines+' plan lines and '+d.users+' users. Open the dashboard and press Ctrl+F5.';}}
catch(x){m.hidden=false;m.className='msg bad';m.textContent=String(x);}finally{b.disabled=false;b.textContent='Connect and copy data';}};
</script></body></html>`;

// ---------------------------------------------------------------- one-time copy from Cloudflare D1

const D1_LIMIT_MSG = 'Cloudflare D1 has reached its free daily read limit, so the old data cannot be read until it resets at midnight UTC (5:30 AM Sri Lanka time). The system already works on Supabase; open /setup again after 5:30 AM and tick "Copy the old data again" to bring the old data over.';
const isD1Limit = (e: unknown) => /exceeded D1|row read limit|daily/i.test(e instanceof Error ? e.message : String(e));
async function d1Users(env: Env): Promise<number | null> {
  try { const n = (await env.DB!.prepare('SELECT COUNT(*) n FROM users').first<{ n: number }>())?.n ?? 0; return n || null; } catch { return null; }
}

/** Tables copied from D1, with the columns Supabase has (missing ones become empty). */
const COPY_TABLES: Record<string, string[]> = {
  config: ['k', 'v'],
  users: ['username', 'pass_hash', 'salt', 'role', 'plant', 'created_at'],
  plan: ['key', 'so', 'li', 'item', 'date', 'qty', 'plant', 'remarks', 'row_no', 'week', 'src_user', 'src_at'],
  stock: ['src', 'key', 'plant', 'sloc', 'so_plant', 'so', 'li', 'material', 'batch', 'style', 'ur', 'qi', 'block', 'assigned', 'total'],
  trr: ['key', 'tn', 'tn_date', 'created_by', 'so', 'li', 'material', 'from_plant', 'from_sloc', 'to_plant', 'to_sloc', 'qty', 'reason'],
  line_status: ['key', 'status', 'comment', 'vehicle', 'qi_note', 'updated_by', 'updated_at'],
  uploads: ['src', 'file_name', 'sheet_name', 'row_count', 'uploaded_by', 'uploaded_at', 'mode'],
  activity: ['at', 'username', 'action', 'detail'],
  dispatch: ['ident', 'week', 'item', 'qty', 'raw_qty', 'factor', 'pallet', 'location', 'lot', 'order_no', 'uom', 'client_so', 'file_name', 'sheet_name', 'uploaded_by', 'uploaded_at', 'first_at'],
  plant_info: ['code', 'name', 'responsible', 'target', 'sort'],
  stock_release: ['week', 'key', 'qi', 'block', 'by_user', 'at'],
  plant_received: ['week', 'code', 'received', 'by_user', 'at'],
  dispatch_assign: ['week', 'item', 'line', 'qty', 'by_user', 'at'],
};

/**
 * Copies every table from the old D1 database into Supabase (replacing what Supabase has), in one transaction.
 * Rows keep their order (by D1 rowid), so uploads and activity stay newest-last.
 */
async function copyFromD1(env: Env, by: string, replace: boolean) {
  if (!env.DB) throw new HttpError(400, 'No D1 database is bound to this Worker (binding name DB), so there is nothing to copy.');
  const counts: Record<string, number> = {};
  const stmts: Stmt[] = [];
  for (const [t, cols] of Object.entries(COPY_TABLES)) {
    let rows: Row[] = [];
    try { rows = (await env.DB.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all<Row>()).results; }
    catch (e) { if (isD1Limit(e)) throw new HttpError(503, D1_LIMIT_MSG); rows = []; } // otherwise: table not in D1 yet
    if (t === 'config') rows = rows.filter((r) => r.k === 'jwt_secret'); // keep sign-in tokens valid; schema_version is Supabase's own
    counts[t] = rows.length;
    if (replace) stmts.push(env.PG.prepare(t === 'config' ? "DELETE FROM config WHERE k = 'jwt_secret'" : `TRUNCATE ${t} RESTART IDENTITY`));
    if (rows.length) stmts.push(...jsonInsert(env, t, cols, rows, 1000, t === 'config' ? ' ON CONFLICT (k) DO UPDATE SET v = excluded.v' : ''));
  }
  stmts.push(env.PG.prepare('INSERT INTO activity (at, username, action, detail) VALUES (?,?,?,?)').bind(now(), by, 'copy',
    `Copied from Cloudflare D1: ${Object.entries(counts).filter(([, n]) => n).map(([t, n]) => `${t} ${n}`).join(', ')}`));
  await env.PG.batch(stmts);
  cachedSecret = null;
  return { ok: true, copied: counts };
}

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
