'use client';
import { useEffect, useRef, useState } from 'react';
import { liveUrl } from './api';
import { fetchChanges } from './freshness';

export type LiveState = 'connecting' | 'live' | 'offline';
export interface LiveMessage { type: string; [k: string]: unknown }

/**
 * Realtime update engine (client side).
 * Keeps one WebSocket to the Worker's LiveHub, reconnects with back-off,
 * sends a ping every 25 s so proxies keep it open, and hands every message to `onMessage`.
 */
export function useLive(onMessage: (m: LiveMessage) => void) {
  const [state, setState] = useState<LiveState>('connecting');
  const [online, setOnline] = useState<string[]>([]);
  const handler = useRef(onMessage);
  handler.current = onMessage;

  useEffect(() => {
    let ws: WebSocket | null = null;
    let retry = 0;
    let stop = false;
    let ping: ReturnType<typeof setInterval> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      const url = liveUrl();
      if (!url || stop) return;
      setState('connecting');
      ws = new WebSocket(url);
      ws.onopen = () => {
        retry = 0;
        setState('live');
        ping = setInterval(() => { try { ws?.send('ping'); } catch { /* closed */ } }, 25000);
      };
      ws.onmessage = (ev) => {
        if (ev.data === 'pong') return;
        try {
          const m = JSON.parse(String(ev.data)) as LiveMessage;
          if (Array.isArray(m.online)) setOnline(m.online as string[]);
          handler.current(m);
        } catch { /* ignore bad frames */ }
      };
      ws.onclose = () => {
        clearInterval(ping);
        if (stop) return;
        setState('offline');
        const wait = Math.min(30000, 1000 * 2 ** retry++);
        timer = setTimeout(connect, wait);
      };
      ws.onerror = () => { try { ws?.close(); } catch { /* ignore */ } };
    };
    // only open a WebSocket when the Worker has the realtime hub; otherwise stay quiet (no retry loop)
    let noHub = false;
    fetchChanges().then((c) => { if (c && !c.realtime) { noHub = true; setState('offline'); } else connect(); });

    // reconnect straight away when the tab comes back or the network returns
    const wake = () => { if (!noHub && document.visibilityState === 'visible' && (!ws || ws.readyState > 1)) { clearTimeout(timer); retry = 0; connect(); } };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('online', wake);
    return () => {
      stop = true;
      clearInterval(ping); clearTimeout(timer);
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('online', wake);
      try { ws?.close(); } catch { /* ignore */ }
    };
  }, []);

  return { state, online };
}
