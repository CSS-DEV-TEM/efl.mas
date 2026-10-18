'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, getSession, saveSession, type User } from '@/lib/api';
import { Credit, Logo } from '@/components/Brand';

export default function LoginPage() {
  const router = useRouter();
  const [username, setU] = useState('');
  const [password, setP] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (getSession()) router.replace('/'); }, [router]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(''); setBusy(true);
    try {
      const r = await api<{ token: string; user: User; expires: number }>('/api/auth/login', { method: 'POST', body: { username, password } });
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
          <h1>MAS Weekly Plan Tracker</h1>
          <p>Sign in to track this week's plan lines against ZMMBE, KFC, PFC, PLANT and TRR stock.</p>
        </div>
        <div className="form">
          <label htmlFor="u">Username<input id="u" autoComplete="username" value={username} onChange={(e) => setU(e.target.value)} required /></label>
          <label htmlFor="p">Password<input id="p" type="password" autoComplete="current-password" value={password} onChange={(e) => setP(e.target.value)} required /></label>
          {err && <div className="notice bad" role="alert">{err}</div>}
          <button className="btn primary login-btn" type="submit" aria-busy={!!busy || undefined} disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        </div>
        <a className="login-guest" href="/">View the dashboard without signing in →</a>
        <div className="login-credit"><Credit /></div>
      </form>
    </main>
  );
}
