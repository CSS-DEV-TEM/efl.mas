'use client';
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { clearSession, getSession, type User } from '@/lib/api';
import { useLive, type LiveMessage, type LiveState } from '@/lib/live';

interface Ctx {
  user: User;
  live: LiveState;
  online: string[];
  subscribe: (fn: (m: LiveMessage) => void) => () => void;
  toast: (text: string) => void;
}
const ShellCtx = createContext<Ctx | null>(null);
export const useShell = () => {
  const c = useContext(ShellCtx);
  if (!c) throw new Error('useShell outside Shell');
  return c;
};

const SRC_NAME: Record<string, string> = { plan: 'Pull plan', zmmbe: 'ZMMBE', kfc: 'ZMMBE KFC', pfc: 'ZMMBE PFC', plant: 'PLANT report', trr: 'TRR' };

export default function Shell({ children, admin }: { children: React.ReactNode; admin?: boolean }) {
  const router = useRouter();
  const path = usePathname();
  const [user, setUser] = useState<User | null>(null);
  const [toasts, setToasts] = useState<{ id: number; text: string }[]>([]);
  const subs = useRef(new Set<(m: LiveMessage) => void>());

  useEffect(() => {
    const s = getSession();
    if (!s) { router.replace('/login/'); return; }
    if (admin && s.user.role !== 'admin') { router.replace('/'); return; }
    setUser(s.user);
  }, [router, admin]);

  const toast = useCallback((text: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  }, []);

  const { state, online } = useLive((m) => {
    subs.current.forEach((fn) => fn(m));
    const me = getSession()?.user.username;
    if (m.by && m.by !== me) {
      if (m.type === 'data') toast(`${m.by} uploaded ${SRC_NAME[String(m.src)] || m.src} — dashboard updated`);
      if (m.type === 'status') {
        const l = m.line as { key: string; status?: string };
        toast(`${m.by} updated ${l.key.split('|').slice(0, 2).join(' / ')}${l.status ? ' → ' + l.status : ''}`);
      }
    }
  });

  const subscribe = useCallback((fn: (m: LiveMessage) => void) => {
    subs.current.add(fn);
    return () => { subs.current.delete(fn); };
  }, []);

  if (!user) return null;

  const nav = [
    { href: '/', label: 'Dashboard' },
    { href: '/upload/', label: 'Uploads' },
    ...(user.role === 'admin' ? [{ href: '/users/', label: 'Users' }] : []),
  ];
  const liveText = state === 'live' ? 'Live' : state === 'connecting' ? 'Connecting…' : 'Offline · retrying';

  return (
    <ShellCtx.Provider value={{ user, live: state, online, subscribe, toast }}>
      <header className="bar">
        <div className="bar-in">
          <div className="brand">Shade Pull Plan <small>Tracker</small></div>
          <nav className="nav">
            {nav.map((n) => (
              <Link key={n.href} href={n.href} className={(n.href === '/' ? path === '/' : path?.startsWith(n.href.replace(/\/$/, ''))) ? 'on' : ''}>{n.label}</Link>
            ))}
          </nav>
          <div className="bar-right">
            <span className={`live ${state === 'live' ? 'on' : state === 'offline' ? 'off' : ''}`} title={online.length ? 'Online: ' + online.join(', ') : ''}>
              <i />{liveText}{state === 'live' && online.length > 0 ? ` · ${online.length} online` : ''}
            </span>
            <span className="who">{user.username}<span className="role">{user.role}</span></span>
            <button className="btn sm" onClick={() => { clearSession(); router.replace('/login/'); }}>Sign out</button>
          </div>
        </div>
      </header>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => <div key={t.id} className="toast">{t.text}</div>)}
      </div>
    </ShellCtx.Provider>
  );
}
