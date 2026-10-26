'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, clearSession, DIV_NAME, getDiv, getSession, saveSession, setDiv, userDivs, type Div, type User } from '@/lib/api';
import { Credit, Logo } from '@/components/Brand';

export default function LoginPage() {
  const router = useRouter();
  const [username, setU] = useState('');
  const [password, setP] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  // the system to open: MAS Active or MAS Kreeda (remembered on this device)
  const [div, setD] = useState<Div>('active');
  useEffect(() => { setD(getDiv()); }, []);

  useEffect(() => { if (getSession()) router.replace('/'); }, [router]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(''); setBusy(true);
    try {
      const r = await api<{ token: string; user: User; expires: number }>('/api/auth/login', { method: 'POST', body: { username, password } });
      const ds = userDivs(r.user);
      if (!ds.includes(div)) {
        // no access to the chosen system: the user's own system opens, or the sign-in stops when there is a choice to make
        if (ds.length === 1) { setDiv(ds[0]); saveSession(r); router.replace('/'); return; }
        clearSession(); throw new Error(`${r.user.username} has no access to ${DIV_NAME[div]}.`);
      }
      setDiv(div);
      saveSession(r);
      router.replace('/');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Sign in failed.');
    } finally { setBusy(false); }
  }

  return (
    <main className="login-wrap">
      <div className="login-bg" aria-hidden="true"><i /><i /><i /><span className="threads" /></div>
      <form className="login card" onSubmit={submit}>
        <div className="login-logo"><Logo size={56} /></div>
        <div>
          <h1>MAS AUTOMATE PICK SYSTEM</h1>
          <p>Sign in to plan, pick and dispatch against ZMMBE, ZINSR, ZCOMENT and Korber stock.</p>
        </div>
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
          {err && <div className="notice bad" role="alert">{err}</div>}
          <button className="btn primary login-btn" type="submit" aria-busy={!!busy || undefined} disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        </div>
        <div className="login-credit"><Credit /></div>
      </form>
    </main>
  );
}
