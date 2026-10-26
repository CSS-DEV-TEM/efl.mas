'use client';

export const API_URL = (process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '');

/** The Worker version this website needs (see API_VERSION in worker/src/index.ts). */
export const NEEDS_API = 63;

export type Role = 'admin' | 'head' | 'editor' | 'viewer';
/** How each role is called on screen (the "editor" role is a planner's user account). */
export const ROLE_NAME: Record<Role, string> = { admin: 'Admin', head: 'Head', editor: 'User', viewer: 'Viewer' };
/** Admin and Head see and change everyone's plan and picks; only the Admin changes system settings. */
export const isBossRole = (r?: Role | null) => r === 'admin' || r === 'head';
export interface User { username: string; role: Role }
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

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  // the cheap "anything changed?" check runs quietly
  const quiet = path.startsWith('/api/changes');
  if (!quiet) setInflight(1);
  try { return await apiCall<T>(path, opts); } finally { if (!quiet) setInflight(-1); }
}

async function apiCall<T>(path: string, opts: { method?: string; body?: unknown }): Promise<T> {
  const s = getSession();
  let res: Response;
  try {
    res = await fetch(API_URL + path, {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json', ...(s ? { Authorization: 'Bearer ' + s.token } : {}) },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  } catch {
    throw new ApiError(0, 'Cannot reach the server. Check your connection, or that NEXT_PUBLIC_API_URL points at the Worker.');
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/auth/login') {
    clearSession();
    if (typeof window !== 'undefined' && location.pathname !== '/' && !location.pathname.startsWith('/login')) location.href = '/login/';
  }
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error || `Request failed (${res.status}).`);
  return data as T;
}

export function liveUrl(): string {
  const s = getSession();
  return API_URL.replace(/^http/, 'ws') + '/api/live' + (s ? '?token=' + encodeURIComponent(s.token) : '');
}
