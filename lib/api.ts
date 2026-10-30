'use client';

export const API_URL = (process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '');

/** The Worker version this website needs (see API_VERSION in worker/src/index.ts). */
export const NEEDS_API = 74;
/** This website's release (shown in the header and footer; the Worker's API version is shown next to it). */
export const APP_VERSION = 'v126';

export type Role = 'admin' | 'head' | 'editor' | 'viewer';
/** How each role is called on screen (the "editor" role is a planner's user account). */
export const ROLE_NAME: Record<Role, string> = { admin: 'Admin', head: 'Head', editor: 'User', viewer: 'Viewer' };
/** Admin and Head see and change everyone's plan and picks; only the Admin changes system settings. */
export const isBossRole = (r?: Role | null) => r === 'admin' || r === 'head';
export interface User { username: string; role: Role; /** the systems the user can open (Admin / Head: both) */ divs?: Div[] }
/** Two systems in one: MAS Active and MAS Kreeda — each with its own plans, reports, picks and settings. */
export type Div = 'active' | 'kreeda';
export const DIV_NAME: Record<Div, string> = { active: 'MAS Active', kreeda: 'MAS Kreeda' };
const DIV_KEY = 'mas-div';
export function getDiv(): Div { try { return localStorage.getItem(DIV_KEY) === 'kreeda' ? 'kreeda' : 'active'; } catch { return 'active'; } }
export function setDiv(d: Div) { try { localStorage.setItem(DIV_KEY, d); } catch { /* private mode */ } }
/** the systems of the signed-in user (older sessions: MAS Active) */
export const userDivs = (u?: User | null): Div[] => (u?.role === 'admin' || u?.role === 'head' ? ['active', 'kreeda'] : u?.divs?.length ? u.divs : ['active']);
interface Stored { token: string; user: User; expires: number }

const KEY = 'shade-tracker-session';

export function getSession(): Stored | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Stored;
    if (s.expires < Date.now()) { localStorage.removeItem(KEY); return null; }
    return s;
  } catch { return null; }
}
export function saveSession(s: Stored) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* private mode */ } }
export function clearSession() { try { localStorage.removeItem(KEY); } catch { /* ignore */ } }

/** Admins and viewers can look at one user's plan / picks ('' = everyone). Editors always see their own. */
const VIEW_KEY = 'mas-view-user';
export function getViewUser(): string { try { return localStorage.getItem(VIEW_KEY) || ''; } catch { return ''; } }
export function setViewUser(u: string) { try { if (u) localStorage.setItem(VIEW_KEY, u); else localStorage.removeItem(VIEW_KEY); } catch { /* private mode */ } }
/** "&user=…" for the plan and pick-history requests (the Worker ignores it for editors). */
export function userParam(first = false): string { const u = getViewUser(); return u ? (first ? '?' : '&') + 'user=' + encodeURIComponent(u) : ''; }

export class ApiError extends Error { constructor(public status: number, msg: string) { super(msg); } }

/** How many requests are in flight: the header shows a thin loading bar while any is (see useApiBusy). */
let inflight = 0;
const busyListeners = new Set<(n: number) => void>();
const setInflight = (d: number) => { inflight = Math.max(0, inflight + d); busyListeners.forEach((f) => f(inflight)); };
export function onApiBusy(f: (n: number) => void) { busyListeners.add(f); return () => { busyListeners.delete(f); }; }

/**
 * v126: the live data meter — what this browser has asked of the server since the page opened: requests, D1 rows read and
 * written, queries (the Worker's x-d1-* answer headers) and the data received. Shown at the top of every page.
 */
export interface ApiMeter { requests: number; read: number; written: number; queries: number; bytes: number; since: number }
const meter: ApiMeter = { requests: 0, read: 0, written: 0, queries: 0, bytes: 0, since: Date.now() };
const meterListeners = new Set<(m: ApiMeter) => void>();
let meterTimer: ReturnType<typeof setTimeout> | null = null;
const meterEmit = () => { if (meterTimer) return; meterTimer = setTimeout(() => { meterTimer = null; const m = { ...meter }; meterListeners.forEach((f) => f(m)); }, 250); };
export function onApiMeter(f: (m: ApiMeter) => void) { meterListeners.add(f); f({ ...meter }); return () => { meterListeners.delete(f); }; }
function countMeter(res: Response, bytes: number) {
  const n = (h: string) => Number(res.headers.get(h) || 0) || 0;
  meter.requests++; meter.read += n('x-d1-rows-read'); meter.written += n('x-d1-rows-written'); meter.queries += n('x-d1-queries'); meter.bytes += bytes;
  meterEmit();
}

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  // the cheap "anything changed?" check runs quietly
  const quiet = path.startsWith('/api/changes') || path.startsWith('/api/online');
  if (!quiet) setInflight(1);
  try { return await apiCall<T>(path, opts); } finally { if (!quiet) setInflight(-1); }
}

async function apiCall<T>(path: string, opts: { method?: string; body?: unknown }): Promise<T> {
  const s = getSession();
  let res: Response;
  // a read that fails on the network (a busy server, a dropped connection) is tried again twice
  const get = !opts.method || opts.method === 'GET';
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch(API_URL + path, {
        method: opts.method || 'GET',
        headers: { 'Content-Type': 'application/json', 'X-Div': getDiv(), ...(s ? { Authorization: 'Bearer ' + s.token } : {}) },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      });
      if (get && res.status === 503 && attempt < 2) { await new Promise((r) => setTimeout(r, 700 * (attempt + 1))); continue; }
      break;
    } catch {
      if (get && attempt < 2) { await new Promise((r) => setTimeout(r, 700 * (attempt + 1))); continue; }
      throw new ApiError(0, 'Cannot reach the server. Check your connection, or that NEXT_PUBLIC_API_URL points at the Worker.');
    }
  }
  const text = await res.text().catch(() => '');
  countMeter(res, text.length);
  let data: unknown = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
  if (res.status === 401 && path !== '/api/auth/login') {
    clearSession();
    if (typeof window !== 'undefined' && !location.pathname.startsWith('/login')) location.href = '/login/';
  }
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error || `Request failed (${res.status}).`);
  return data as T;
}

export function liveUrl(): string {
  const s = getSession();
  return API_URL.replace(/^http/, 'ws') + '/api/live?div=' + getDiv() + (s ? '&token=' + encodeURIComponent(s.token) : '');
}
