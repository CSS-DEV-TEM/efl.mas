'use client';
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { NEEDS_API, ROLE_NAME, api, clearSession, getSession, getViewUser, setViewUser, type User } from '@/lib/api';
import { useLive, type LiveMessage, type LiveState } from '@/lib/live';
import { Credit, Logo } from '@/components/Brand';

interface Ctx {
  user: User;
  guest: boolean;
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

const SRC_NAME: Record<string, string> = { plan: 'Weekly plan', zmmbe: 'ZMMBE', kfc: 'ZMMBE KFC', pfc: 'ZMMBE PFC', plant: 'PLANT report', trr: 'TRR', dispatch: 'a dispatch' };

/** `allowGuest`: the page can be viewed without signing in (read-only). */
export default function Shell({ children, admin, allowGuest }: { children: React.ReactNode; admin?: boolean; allowGuest?: boolean }) {
  const router = useRouter();
  const path = usePathname();
  const [user, setUser] = useState<User | null>(null);
  const [guest, setGuest] = useState(false);
  const [toasts, setToasts] = useState<{ id: number; text: string }[]>([]);
  const subs = useRef(new Set<(m: LiveMessage) => void>());

  useEffect(() => {
    const s = getSession();
    if (!s && allowGuest) { setGuest(true); setUser({ username: 'Guest', role: 'viewer' }); return; }
    if (!s) { router.replace('/login/'); return; }
    if (admin && s.user.role !== 'admin') { router.replace('/'); return; }
    setUser(s.user);
  }, [router, admin, allowGuest]);

  // warn when the website was updated but the Cloudflare Worker was not
  const [oldApi, setOldApi] = useState<number | null>(null);
  useEffect(() => {
    if (!user || guest) return;
    api<{ version?: number }>('/api/health').then((h) => setOldApi((h.version ?? 0) < NEEDS_API ? h.version ?? 0 : null)).catch(() => {});
  }, [user, guest]);

  // admins and viewers choose whose plan / picks they look at; editors only ever see their own
  const [owners, setOwners] = useState<string[] | null>(null);
  const [viewU, setViewU] = useState('');
  useEffect(() => {
    if (!user || guest || user.role === 'editor') return;
    setViewU(getViewUser());
    api<{ owners: string[] }>('/api/owners').then((r) => setOwners(r.owners)).catch(() => {});
  }, [user, guest]);

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

  const nav = guest ? [{ href: '/', label: 'Week plan' }, { href: '/day/', label: 'Day plan' }] : [
    { href: '/', label: 'Week plan' },
    { href: '/day/', label: 'Day plan' },
    ...(user.role !== 'viewer' ? [{ href: '/my/', label: 'My work' }] : []),
    { href: '/upload/', label: 'Uploads' },
    { href: '/dispatch/', label: 'Pick & Dispatch' },
    ...(user.role === 'admin' ? [{ href: '/settings/', label: 'Settings' }] : []),
  ];
  const liveText = state === 'live' ? 'Live' : state === 'connecting' ? 'Connecting…' : 'Updates on activity';

  return (
    <ShellCtx.Provider value={{ user, guest, live: state, online, subscribe, toast }}>
      <header className="bar">
        <div className="bar-in">
          <Link href="/" className="brand"><Logo size={30} /><span className="brand-text">MAS Weekly Plan <small>Tracker</small></span></Link>
          <nav className="nav">
            {nav.map((n) => (
              <Link key={n.href} href={n.href} className={(n.href === '/' ? path === '/' : path?.startsWith(n.href.replace(/\/$/, ''))) ? 'on' : ''}>{n.label}</Link>
            ))}
          </nav>
          <div className="bar-right">
            <Credit compact />
            <span className={`live ${state === 'live' ? 'on' : state === 'offline' ? 'off' : ''}`} title={online.length ? 'Online: ' + online.join(', ') : ''}>
              <i />{liveText}{state === 'live' && online.length > 0 ? ` · ${online.length} online` : ''}
            </span>
            {guest ? (
              <Link className="btn sm primary" href="/login/">Sign in to upload / edit</Link>
            ) : (
              <>
                {owners && (
                  <label className="view-user" title="Whose plan and picks to show">
                    <span>Data of</span>
                    <select value={viewU} onChange={(e) => { setViewUser(e.target.value); location.reload(); }} aria-label="Data of">
                      <option value="">All users</option>
                      {owners.map((o) => <option key={o} value={o}>{o === user.username ? `${o} (me)` : o}</option>)}
                    </select>
                  </label>
                )}
                <span className="who">{user.username}<span className="role">{ROLE_NAME[user.role] || user.role}</span></span>
                <button className="btn sm" onClick={() => { clearSession(); setGuest(true); setUser({ username: 'Guest', role: 'viewer' }); if (!allowGuest) router.replace('/'); }}>Sign out</button>
              </>
            )}
          </div>
        </div>
      </header>
      {oldApi !== null && (
        <div className="notice bad api-old" role="alert">
          <b>The Worker (API) on Cloudflare is out of date</b> (version {oldApi || 'old'}, this website needs {NEEDS_API}). Uploads will lose data — e.g. SOs starting with a letter (E101697207) are dropped.
          Paste the latest <b>worker.js</b> in Cloudflare → Worker → Edit code → Deploy, then reload this page.
        </div>
      )}
      {children}
      <footer className="site-foot"><Logo size={22} /><span>EFL · MAS Weekly Plan Tracker</span><Credit /></footer>
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => <div key={t.id} className="toast">{t.text}</div>)}
      </div>
    </ShellCtx.Provider>
  );
}
