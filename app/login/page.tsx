'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { APP_VERSION, api, ApiError, clearSession, DIV_NAME, getDiv, getSession, saveSession, setDiv, userDivs, type Div, type MaintInfo, type User } from '@/lib/api';
import { Credit, Logo } from '@/components/Brand';
import TetherButton from '@/components/TetherButton';

export default function LoginPage() {
  const router = useRouter();
  const [username, setU] = useState('');
  const [password, setP] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  // the system to open: MAS Active or MAS Kreeda (remembered on this device)
  const [div, setD] = useState<Div>('active');
  useEffect(() => { setD(getDiv()); }, []);
  // v167: down for maintenance — the notice, and the maintenance password (the Admin signs in without it)
  const [maint, setMaint] = useState<MaintInfo | null>(null);
  const [mpw, setMpw] = useState('');
  useEffect(() => { api<MaintInfo>('/api/maint').then((m) => setMaint(m.on ? m : null)).catch(() => { /* not known */ }); }, []);

  useEffect(() => { if (getSession()) router.replace('/'); }, [router]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(''); setBusy(true);
    try {
      const r = await api<{ token: string; user: User; expires: number }>('/api/auth/login', { method: 'POST', body: { username, password, ...(maint && mpw ? { maint_pw: mpw } : {}) } });
      const ds = userDivs(r.user);
      if (!ds.includes(div)) {
        // no access to the chosen system: the user's own system opens, or the sign-in stops when there is a choice to make
        if (ds.length === 1) { setDiv(ds[0]); saveSession(r); try { localStorage.setItem('mas-welcome', String(Date.now())); } catch { /* */ } router.replace('/'); return; }
        clearSession(); throw new Error(`${r.user.username} has no access to ${DIV_NAME[div]}.`);
      }
      setDiv(div);
      saveSession(r); try { localStorage.setItem('mas-welcome', String(Date.now())); } catch { /* */ }
      router.replace('/');
    } catch (e) {
      if (e instanceof ApiError && e.status === 423) { const m = (e.data as { maintenance?: MaintInfo })?.maintenance; if (m?.on) setMaint(m); }
      setErr(e instanceof Error ? e.message : 'Sign in failed.');
    } finally { setBusy(false); }
  }

  return (
    <main className="login-wrap">
      <div className="login-bg" aria-hidden="true"><i /><i /><i /><span className="threads" /></div>
      <form className="login card" onSubmit={submit}>
        <div className="login-logo"><Logo size={56} /></div>
        <div className="login-head">
          <h1>Welcome back</h1>
          <p>MAS Automate Pick System · <span className="mono">{APP_VERSION}</span></p>
        </div>
        {maint && (
          <div className="maint-note" role="status">
            <b>🛠 System down for maintenance</b>
            <span>{maint.msg}</span>
            {maint.until && <small>Back: {maint.until}</small>}
            <small>Only the Admin, or a sign-in with the maintenance password, can open the system now.</small>
          </div>
        )}
        <div className="login-div" role="radiogroup" aria-label="System">
          {(['active', 'kreeda'] as Div[]).map((d) => (
            <button key={d} type="button" role="radio" aria-checked={div === d} className={div === d ? 'on' : ''} onClick={() => setD(d)}>
              <b>{DIV_NAME[d]}</b><small>{d === 'active' ? 'Active plans & picks' : 'Kreeda plans & picks'}</small>
            </button>
          ))}
        </div>
        <div className="form">
          <label htmlFor="u">Username<input id="u" autoComplete="username" value={username} onChange={(e) => setU(e.target.value)} required /></label>
          <label htmlFor="p">Password<input id="p" type="password" autoComplete="current-password" value={password} onChange={(e) => setP(e.target.value)} required /></label>
          {maint && <label htmlFor="mp">Maintenance password<input id="mp" type="password" autoComplete="off" value={mpw} onChange={(e) => setMpw(e.target.value)} placeholder="Admin: leave empty" /></label>}
          {err && <div className="notice bad" role="alert">{err}</div>}
          <TetherButton ready={!!username.trim() && !!password} busy={busy} label="Sign in" busyLabel="Signing in…" hint="Fill in your username and password first" />
        </div>
        <div className="login-credit"><Credit /></div>
      </form>
    </main>
  );
}
