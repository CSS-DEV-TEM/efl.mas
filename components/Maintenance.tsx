'use client';
import { useCallback, useEffect, useState } from 'react';
import { api, type MaintInfo } from '@/lib/api';

/**
 * v167: Settings → Maintenance (Admin only). Shut the system down for maintenance: MAS Active and MAS Kreeda stop for everyone
 * except the Admin; others sign in with the maintenance password set here. Bring it back online with one click.
 */
export default function Maintenance({ toast }: { toast: (m: string, kind?: 'ok' | 'bad') => void }) {
  const [m, setM] = useState<MaintInfo | null>(null);
  const [msg, setMsg] = useState('Back soon — a system update is in progress.');
  const [until, setUntil] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => { api<MaintInfo>('/api/maint').then(setM).catch(() => setM({ on: false })); }, []);
  useEffect(() => { load(); }, [load]);

  async function shutDown() {
    if (pw.length < 4) { toast('Set a maintenance password (4 or more characters).', 'bad'); return; }
    if (pw !== pw2) { toast('The two maintenance passwords are not the same.', 'bad'); return; }
    if (!confirm('Shut the system down for maintenance?\n\nMAS Active and MAS Kreeda stop for every user (they are signed out). Only the Admin, and a sign-in with the maintenance password, can open the system until you bring it back online.')) return;
    setBusy(true);
    try { setM(await api<MaintInfo>('/api/maint', { method: 'POST', body: { on: true, msg, password: pw, until: until || null } })); setPw(''); setPw2(''); window.dispatchEvent(new Event('mas-maint')); toast('System is down for maintenance.'); }
    catch (e) { toast(e instanceof Error ? e.message : 'Could not shut down.', 'bad'); }
    finally { setBusy(false); }
  }
  async function bringUp() {
    if (!confirm('Bring the system back online for everyone?')) return;
    setBusy(true);
    try { setM(await api<MaintInfo>('/api/maint', { method: 'POST', body: { on: false } })); window.dispatchEvent(new Event('mas-maint')); toast('System is back online.'); }
    catch (e) { toast(e instanceof Error ? e.message : 'Could not bring it online.', 'bad'); }
    finally { setBusy(false); }
  }

  if (!m) return <section className="card"><p className="muted">Loading…</p></section>;
  return (
    <section className="card maint-card">
      <h2 style={{ marginTop: 0 }}>Maintenance</h2>
      {m.on ? (
        <>
          <div className="notice bad" role="status">
            <b>🛠 The system is DOWN for maintenance</b> — since {m.at ? new Date(m.at).toLocaleString() : '–'} by {m.by ?? '–'}.
            <div style={{ marginTop: 6 }}>{m.msg}{m.until ? ` · Back: ${m.until}` : ''}</div>
            <div className="small" style={{ marginTop: 6 }}>Users see this on the sign-in page. They can sign in only with the maintenance password; you (Admin) can work as usual.</div>
          </div>
          <div className="row" style={{ marginTop: 14 }}>
            <button className="btn primary" disabled={busy} onClick={() => void bringUp()}>{busy ? 'Working…' : '▶ Bring system back online'}</button>
          </div>
        </>
      ) : (
        <>
          <p className="muted" style={{ marginTop: 0 }}>
            The system is <b>online</b>. Shut it down while you update the Worker, restore a backup or fix data: every user is signed out and
            sees your message. Only the Admin, and whoever signs in with the maintenance password below, can open it until you bring it back.
          </p>
          <div className="form maint-form">
            <label>Message for users<textarea rows={2} maxLength={300} value={msg} onChange={(e) => setMsg(e.target.value)} /></label>
            <label>Back at (optional)<input value={until} maxLength={40} onChange={(e) => setUntil(e.target.value)} placeholder="e.g. 10:30 AM" /></label>
            <label>Maintenance password<input type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="4 or more characters" /></label>
            <label>Maintenance password again<input type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} /></label>
          </div>
          <div className="row" style={{ marginTop: 14 }}>
            <button className="btn danger" disabled={busy} onClick={() => void shutDown()}>{busy ? 'Working…' : '⏻ Shut down system'}</button>
          </div>
        </>
      )}
    </section>
  );
}

/** the Admin's reminder on every page while the system is down */
export function MaintBar() {
  const [m, setM] = useState<MaintInfo | null>(null);
  useEffect(() => {
    let live = true;
    const f = () => api<MaintInfo>('/api/maint').then((x) => { if (live) setM(x.on ? x : null); }).catch(() => { /* not known */ });
    f(); const t = setInterval(f, 60e3);
    window.addEventListener('mas-maint', f);
    return () => { live = false; clearInterval(t); window.removeEventListener('mas-maint', f); };
  }, []);
  if (!m) return null;
  return (
    <div className="notice bad maint-bar" role="status">
      <b>🛠 Down for maintenance</b> — users cannot use the system · {m.msg} <a href="/settings/#maint">Bring it back online</a>
    </div>
  );
}
