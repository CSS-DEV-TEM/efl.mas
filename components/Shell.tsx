'use client';
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { APP_VERSION, ApiError, DIV_NAME, NEEDS_API, ROLE_NAME, api, clearSession, getDiv, getSession, getViewUser, onApiBusy, onApiMeter, saveSession, setDiv, setViewUser, userDivs, type ApiMeter, type Div, type User } from '@/lib/api';
import { onTasks, type Task } from '@/lib/progress';
import { useLive, type LiveMessage, type LiveState } from '@/lib/live';
import { Credit, Logo } from '@/components/Brand';
import TableFilters from '@/components/TableFilters';

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

/** Every page needs a signed-in user: without one the login screen opens straight away (`allowGuest` is no longer used). */
export default function Shell({ children, admin, allowGuest }: { children: React.ReactNode; admin?: boolean; allowGuest?: boolean }) {
  const router = useRouter();
  const path = usePathname();
  const [user, setUser] = useState<User | null>(null);
  const [guest] = useState(false);
  const [div, setDivS] = useState<Div>('active');
  const [toasts, setToasts] = useState<{ id: number; text: string }[]>([]);
  const subs = useRef(new Set<(m: LiveMessage) => void>());

  useEffect(() => {
    const s = getSession();
    if (!s) { router.replace('/login/'); return; }
    if (admin && s.user.role !== 'admin') { router.replace('/'); return; }
    // the system open on this device must be one the user has (else their own one)
    const ds = userDivs(s.user);
    if (!ds.includes(getDiv())) setDiv(ds[0]);
    setDivS(getDiv());
    setUser(s.user);
    // the access may have changed since the sign-in: read it again
    api<{ user: User }>('/api/me').then((r) => {
      const nd = userDivs(r.user);
      saveSession({ ...s, user: { ...s.user, divs: r.user.divs } }); try { sessionStorage.removeItem('mas-div-switch'); } catch { /* private mode */ }
      if (!nd.includes(getDiv())) { setDiv(nd[0]); location.reload(); }
    }).catch((e) => {
      // access to this system was taken away: open the other one (once)
      if (e instanceof ApiError && e.status === 403 && /no access/i.test(e.message)) {
        let tried = false; try { tried = sessionStorage.getItem('mas-div-switch') === '1'; sessionStorage.setItem('mas-div-switch', '1'); } catch { /* private mode */ }
        if (!tried) { setDiv(getDiv() === 'active' ? 'kreeda' : 'active'); location.reload(); }
      }
    });
  }, [router, admin, allowGuest]);

  // macOS-style close: React removes a window at once, so a copy of it is shown for a moment while it shrinks and fades
  useEffect(() => {
    if (typeof window === 'undefined' || !('MutationObserver' in window)) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const isWin = (n: Node): n is HTMLElement => n instanceof HTMLElement && (n.classList.contains('modal-back') || n.classList.contains('drawer-back')) && !n.classList.contains('mac-closing');
    const mo = new MutationObserver((recs) => {
      for (const r of recs) r.removedNodes.forEach((n) => {
        const wins: HTMLElement[] = isWin(n) ? [n] : n instanceof HTMLElement ? Array.from(n.querySelectorAll<HTMLElement>('.modal-back, .drawer-back')).filter(isWin) : [];
        for (const w of wins) {
          if (!w.firstElementChild) continue;
          const ghost = w.cloneNode(true) as HTMLElement;
          ghost.classList.add('mac-closing');
          ghost.setAttribute('aria-hidden', 'true');
          ghost.setAttribute('inert', '');
          ghost.querySelectorAll('[id]').forEach((e) => e.removeAttribute('id'));
          ghost.scrollTop = w.scrollTop;
          document.body.appendChild(ghost);
          const done = () => ghost.remove();
          ghost.addEventListener('animationend', (e) => { if (e.target === ghost) done(); });
          setTimeout(done, 400);
        }
      });
    });
    mo.observe(document.body, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, []);

  // warn when the website was updated but the Cloudflare Worker was not
  const [oldApi, setOldApi] = useState<number | null>(null);
  const [apiV, setApiV] = useState<number | null>(null);
  useEffect(() => {
    if (!user || guest) return;
    api<{ version?: number }>('/api/health').then((h) => { setApiV(h.version ?? null); setOldApi((h.version ?? 0) < NEEDS_API ? h.version ?? 0 : null); }).catch(() => {});
  }, [user, guest]);

  // admins and viewers choose whose plan / picks they look at; editors only ever see their own
  const [owners, setOwners] = useState<string[] | null>(null);
  const [viewU, setViewU] = useState('');
  useEffect(() => {
    if (!user || guest || user.role === 'editor') return;
    setViewU(getViewUser());
    api<{ owners: string[] }>('/api/owners').then((r) => setOwners(r.owners)).catch(() => {});
  }, [user, guest]);

  // a thin bar under the header while data loads (shown only if it takes more than a moment)
  const [netBusy, setNetBusy] = useState(false);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const off = onApiBusy((n) => { clearTimeout(t); if (n > 0) t = setTimeout(() => setNetBusy(true), 180); else setNetBusy(false); });
    return () => { off(); clearTimeout(t); };
  }, []);

  // v126: the live data meter (what this page asked of the server: requests running, rows read / written, data received)
  const [inflight, setInflight] = useState(0);
  const [meter, setMeter] = useState<ApiMeter | null>(null);
  useEffect(() => { const a = onApiBusy(setInflight); const b = onApiMeter(setMeter); return () => { a(); b(); }; }, []);
  // the long jobs running now (Packing List, uploads, imports …): a progress bar each
  const [tasks, setTasks] = useState<Task[]>([]);
  const [, setTick] = useState(0);
  useEffect(() => onTasks(setTasks), []);
  useEffect(() => { if (!tasks.length) return; const t = setInterval(() => setTick((x) => x + 1), 1000); return () => clearInterval(t); }, [tasks.length]);
  // v126: who is signed in now — this tab says "I am here" every minute; the answer is everyone heard from lately
  const [present, setPresent] = useState<{ username: string; tabs: number }[] | null>(null);
  // the whole system's live data today (every user): rows processed, reset at 12:00 midnight (Sri Lanka time)
  type Today = { day: string; read: number; written: number; rows: number; reqs: number };
  const [today, setToday] = useState<Today | null>(null);
  const tabId = useRef('');
  useEffect(() => {
    if (!user || guest) return;
    try { tabId.current = sessionStorage.getItem('mas-tab') || ''; if (!tabId.current) { tabId.current = Math.random().toString(36).slice(2, 12); sessionStorage.setItem('mas-tab', tabId.current); } } catch { tabId.current = Math.random().toString(36).slice(2, 12); }
    let stop = false;
    const beat = () => { if (stop || document.visibilityState === 'hidden') return; api<{ users: { username: string; tabs: number }[]; today?: Today | null }>('/api/online', { method: 'POST', body: { tab: tabId.current } }).then((r) => { if (!stop) { setPresent(r.users || []); if (r.today) setToday(r.today); } }).catch(() => {}); };
    beat();
    const t = setInterval(beat, 30000);
    const vis = () => { if (document.visibilityState === 'visible') beat(); };
    document.addEventListener('visibilitychange', vis);
    return () => { stop = true; clearInterval(t); document.removeEventListener('visibilitychange', vis); };
  }, [user, guest]);
  const signOut = async () => {
    try { if (tabId.current) await api('/api/online', { method: 'DELETE', body: { tab: tabId.current } }); } catch { /* signed out anyway */ }
    clearSession(); router.replace('/login/');
  };

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

  // the week plan is retired: the home page is the day plan (Pick 1, 2 … per plant)
  const nav = guest ? [{ href: '/', label: 'Day plan' }, { href: '/week/', label: 'Week plan' }] : [
    { href: '/', label: 'Day plan' },
    { href: '/week/', label: 'Week plan' },
    { href: '/upload/', label: 'Uploads' },
    { href: '/dispatch/', label: 'Pick & Dispatch' },
    { href: '/data/', label: 'Data' },
    ...(user.role === 'admin' ? [{ href: '/settings/', label: 'Settings' }] : []),
  ];
  const liveText = state === 'live' ? 'Live' : state === 'connecting' ? 'Connecting…' : 'Updates on activity';

  return (
    <ShellCtx.Provider value={{ user, guest, live: state, online, subscribe, toast }}>
      {netBusy && <div className="net-bar" role="progressbar" aria-label="Loading" />}
      <TableFilters />
      <header className="bar">
        <div className="bar-in">
          <Link href="/" className="brand"><Logo size={30} /><span className="tpl-badge" aria-label="3PL"><span>3PL</span></span><span className="brand-text">MAS AUTOMATE PICK SYSTEM</span></Link>
          <span className="ver-badge" title={`Website ${APP_VERSION}${apiV ? ` · Worker API ${apiV}` : ''}`}>{APP_VERSION}{apiV ? ` · API ${apiV}` : ''}</span>
          {/* the system open now: MAS Active or MAS Kreeda — a user with both switches here */}
          {userDivs(user).length > 1 ? (
            <div className={`div-switch ${div}`} role="radiogroup" aria-label="System">
              {(['active', 'kreeda'] as Div[]).map((d) => <button key={d} type="button" role="radio" aria-checked={div === d} className={div === d ? 'on' : ''} onClick={() => { if (d !== div) { setDiv(d); location.reload(); } }}>{DIV_NAME[d]}</button>)}
            </div>
          ) : <span className={`div-tag ${div}`}>{DIV_NAME[div]}</span>}
          <nav className="nav">
            {nav.map((n) => (
              <Link key={n.href} href={n.href} className={(n.href === '/' ? path === '/' : path?.startsWith(n.href.replace(/\/$/, ''))) ? 'on' : ''}>{n.label}</Link>
            ))}
          </nav>
          <div className="bar-right">
            <Credit compact />
            <span className={`live ${state === 'live' ? 'on' : state === 'offline' ? 'off' : ''}`} title={online.length ? 'Online: ' + online.join(', ') : ''}>
              <i />{liveText}
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
                <button className="btn sm" onClick={() => { void signOut(); }}>Sign out</button>
              </>
            )}
          </div>
        </div>
        {/* v126: live data and who is signed in — at the top of every page */}
        <div className="top-status" role="status" aria-live="off">
          <span className={`ts-live ${inflight > 0 ? 'on' : ''}`} title={`${today ? `Whole system today (${today.day}, every user — resets at 12:00 midnight): ${today.rows.toLocaleString()} rows processed = ${today.read.toLocaleString()} read + ${today.written.toLocaleString()} written · ${today.reqs.toLocaleString()} requests\n` : ''}${meter ? `This tab since it opened (${new Date(meter.since).toLocaleTimeString()}): ${meter.requests.toLocaleString()} requests · ${meter.queries.toLocaleString()} database queries · ${meter.read.toLocaleString()} rows read · ${meter.written.toLocaleString()} rows written · ${fmtBytes(meter.bytes)} received` : ''}`}>
            <i />Live data: {inflight > 0 ? <b>{inflight} running</b> : 'idle'}
            {today ? <> · Today <b>{fmtN(today.rows)}</b> rows processed <span className="muted">({fmtN(today.read)} read · {fmtN(today.written)} written · {fmtN(today.reqs)} requests · resets 12:00 AM)</span></>
              : meter && <> · {fmtN(meter.read)} rows read · {fmtN(meter.written)} written · {fmtN(meter.requests)} requests · {fmtBytes(meter.bytes)}</>}
          </span>
          <span className="ts-online" title={(present ?? []).length ? 'Signed in now: ' + (present ?? []).map((u) => `${u.username}${u.tabs > 1 ? ` (${u.tabs} tabs)` : ''}`).join(', ') : online.length ? 'Online: ' + online.join(', ') : ''}>
            👥 {present ? present.length : online.length} user{(present ? present.length : online.length) === 1 ? '' : 's'} signed in{present && present.length ? `: ${present.slice(0, 4).map((u) => u.username).join(', ')}${present.length > 4 ? ` +${present.length - 4}` : ''}` : ''}
          </span>
        </div>
        {tasks.length > 0 && (
          <div className="task-strip">
            {tasks.map((t) => {
              const pct = t.total > 0 ? Math.min(100, Math.round((t.done / t.total) * 100)) : null;
              const sec = Math.round((Date.now() - t.started) / 1000);
              return (
                <div key={t.id} className="task-row" role="progressbar" aria-label={t.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined}>
                  <span className="task-label"><b>{t.label}</b>{t.step ? ` · ${t.step}` : ''}{t.total > 0 ? ` · ${t.done.toLocaleString()} / ${t.total.toLocaleString()}` : ''}</span>
                  <span className={`task-bar ${pct === null ? 'ind' : ''}`}><i style={pct === null ? undefined : { width: `${pct}%` }} /></span>
                  <span className="task-pct">{pct === null ? '…' : `${pct}%`} · {sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${sec % 60}s`}</span>
                </div>
              );
            })}
          </div>
        )}
      </header>
      {oldApi !== null && (
        <div className="notice bad api-old" role="alert">
          <b>The Worker (API) on Cloudflare is out of date</b> (version {oldApi || 'old'}, this website needs {NEEDS_API}). Uploads will lose data — e.g. SOs starting with a letter (E101697207) are dropped.
          Paste the latest <b>worker.js</b> in Cloudflare → Worker → Edit code → Deploy, then reload this page.
        </div>
      )}
      {children}
      <footer className="site-foot"><Logo size={22} /><span>EFL 3PL · MAS AUTOMATE PICK SYSTEM · {APP_VERSION}{apiV ? ` · API ${apiV}` : ''}</span><Credit /></footer>
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => <div key={t.id} className="toast">{t.text}</div>)}
      </div>
    </ShellCtx.Provider>
  );
}

const fmtN = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
const fmtBytes = (b: number) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : b >= 1024 ? `${Math.round(b / 1024)} KB` : `${b} B`);
