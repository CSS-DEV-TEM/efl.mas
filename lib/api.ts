'use client';

export const API_URL = (process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '');

/** The Worker version this website needs (see API_VERSION in worker/src/index.ts). */
export const NEEDS_API = 12;

export type Role = 'admin' | 'editor' | 'viewer';
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

export class ApiError extends Error { constructor(public status: number, msg: string) { super(msg); } }

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
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
