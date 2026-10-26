'use client';
import { useCallback, useEffect, useRef } from 'react';
import { API_URL, getDiv } from './api';

/** Asks the Worker "has anything changed?" — one tiny read. null = this Worker has no /api/changes. */
export async function fetchChanges(): Promise<{ rev: string | null; realtime: boolean } | null> {
  try {
    const r = await fetch(API_URL + '/api/changes?div=' + getDiv(), { cache: 'no-store' });
    return r.ok ? ((await r.json()) as { rev: string | null; realtime: boolean }) : null;
  } catch { return null; }
}

/**
 * No timer. When someone uses the page (click, typing, coming back to the tab) — at most every 15 s —
 * check whether anything changed since the data on screen (`shownRev`), and reload only then.
 * Your own uploads and edits already reload the page themselves.
 */
export function useRefreshOnActivity(load: () => unknown, shownRev: string | null | undefined, enabled = true, everyMs = 0) {
  const shown = useRef(shownRev);
  shown.current = shownRev;
  const last = useRef(0);
  const busy = useRef(false);

  const check = useCallback(async () => {
    if (busy.current || Date.now() - last.current < 15000 || document.visibilityState !== 'visible') return;
    last.current = Date.now();
    busy.current = true;
    try {
      const c = await fetchChanges();
      if (!c) { await load(); return; } // older Worker without /api/changes: just reload
      if (shown.current !== undefined && c.rev !== shown.current) await load();
    } finally { busy.current = false; }
  }, [load]);

  useEffect(() => {
    if (!enabled) return;
    const on = () => { void check(); };
    window.addEventListener('pointerdown', on, { passive: true });
    window.addEventListener('keydown', on);
    window.addEventListener('focus', on);
    document.addEventListener('visibilitychange', on);
    // also every so often while the page is open and visible (one small /api/changes call; a reload only when something changed)
    const timer = everyMs > 0 ? setInterval(on, everyMs) : undefined;
    return () => {
      if (timer) clearInterval(timer);
      window.removeEventListener('pointerdown', on);
      window.removeEventListener('keydown', on);
      window.removeEventListener('focus', on);
      document.removeEventListener('visibilitychange', on);
    };
  }, [check, enabled, everyMs]);
}
