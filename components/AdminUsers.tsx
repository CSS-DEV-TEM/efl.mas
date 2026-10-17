'use client';
import { useCallback, useEffect, useState } from 'react';
import { useShell } from '@/components/Shell';
import { ROLE_NAME, api, type Role } from '@/lib/api';
import { ago } from '@/lib/calc';


interface U { username: string; role: Role; plant?: string | null; created_at: string }
const ROLE_HELP: Record<Role, string> = {
  admin: 'Everything, including the system settings on this page (users, plants & target times, pick rules, clearing data)',
  head: 'Everything except system settings: sees and changes every user\'s plan and picks',
  editor: 'A planner: uploads and works on their own plan and picks only',
  viewer: 'View and export only (all users\' data)',
};

export function UsersAdmin() {
  const { user, toast } = useShell();
  const [list, setList] = useState<U[]>([]);
  const [form, setForm] = useState({ username: '', password: '', role: 'editor' as Role, plant: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setList((await api<{ users: U[] }>('/api/users')).users); } catch (e) { setErr(e instanceof Error ? e.message : 'Could not load users.'); }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setErr(''); setBusy(true);
    try {
      await api('/api/users', { method: 'POST', body: form });
      toast(`Saved ${form.username}`);
      setForm({ username: '', password: '', role: 'editor', plant: '' });
      load();
    } catch (e) { setErr(e instanceof Error ? e.message : 'Could not save.'); } finally { setBusy(false); }
  }
  async function remove(u: string) {
    if (!window.confirm(`Remove ${u}? They will be signed out when their session ends.`)) return;
    try { await api('/api/users/' + encodeURIComponent(u), { method: 'DELETE' }); load(); } catch (e) { toast(e instanceof Error ? e.message : 'Could not remove.'); }
  }
  async function setRole(u: string, role: Role, plant?: string | null) {
    try { await api('/api/users', { method: 'POST', body: { username: u, role, ...(plant !== undefined ? { plant } : {}) } }); load(); } catch (e) { toast(e instanceof Error ? e.message : 'Could not change role.'); }
  }

  return (
    <>
      <section className="card" id="users">
        <h2>Users &amp; roles</h2>
        <p className="sub">Add people who can sign in. Entering an existing username with a new password resets that password. Passwords are stored hashed (PBKDF2).</p>
        <form className="form" onSubmit={save} style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', alignItems: 'end' }}>
          <label htmlFor="nu">Username<input id="nu" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} required /></label>
          <label htmlFor="np">Password<input id="np" type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="min 6 characters" /></label>
          <label htmlFor="nr">Role
            <select id="nr" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
              <option value="editor">User (own plan)</option><option value="head">Head</option><option value="viewer">Viewer</option><option value="admin">Admin</option>
            </select>
          </label>
          <button className="btn primary" type="submit" disabled={busy}>Save user</button>
        </form>
        <p className="sub" style={{ marginTop: 10 }}>{ROLE_HELP[form.role]}.</p>
        {err && <div className="notice bad">{err}</div>}
      </section>

      <section className="card table-card">
        <div className="table-wrap" style={{ maxHeight: 'none' }}>
          <table className="ledger">
            <thead><tr><th><button tabIndex={-1}>Username</button></th><th><button tabIndex={-1}>Role</button></th><th><button tabIndex={-1}>Added</button></th><th /></tr></thead>
            <tbody>
              {list.map((u) => (
                <tr key={u.username}>
                  <td className="mono">{u.username}{u.username === user.username ? ' (you)' : ''}</td>
                  <td>
                    <select value={u.role} disabled={u.username === user.username} onChange={(e) => setRole(u.username, e.target.value as Role)}
                      style={{ border: '1px solid var(--line-strong)', borderRadius: 5, padding: '3px 6px', background: 'var(--panel)' }}>
                      {(['admin', 'head', 'editor', 'viewer'] as Role[]).map((r) => <option key={r} value={r}>{ROLE_NAME[r]}</option>)}
                    </select>
                  </td>
                  <td className="muted">{ago(u.created_at)}</td>
                  <td style={{ textAlign: 'right' }}>{u.username !== user.username && <button className="btn sm danger" onClick={() => remove(u.username)}>Remove</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

const GROUPS: { id: string; label: string; hint: string }[] = [
  { id: 'plan', label: 'Weekly plans', hint: 'all weeks, with Status / Comment edits, received times, releases' },
  { id: 'stock', label: 'Stock reports', hint: 'ZMMBE, ZMMBE KFC, ZMMBE PFC, PLANT, TRR' },
  { id: 'pickdata', label: 'Pick data', hint: 'ZINR, ZCOMENT VIEW, Korber Inventory' },
  { id: 'picks', label: 'Pick history', hint: 'all picks and packing lists (rolls become pickable again)' },
  { id: 'dispatch', label: 'Old dispatch uploads', hint: 'dispatch files uploaded before picking' },
  { id: 'settings', label: 'Plant settings', hint: 'plant names, responsible, target times' },
  { id: 'history', label: 'Upload history & activity log', hint: 'the "Recent uploads" lists' },
];

/** Admin: empty chosen parts of the database. Users and passwords are never removed. */
export function ClearDatabase({ toast }: { toast: (m: string) => void }) {
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const all = sel.size === GROUPS.length;
  const run = async () => {
    setBusy(true); setErr('');
    try {
      const r = await api<{ cleared: Record<string, number> }>('/api/admin/clear', { method: 'POST', body: { groups: Array.from(sel), confirm } });
      const n = Object.values(r.cleared).reduce((t, x) => t + x, 0);
      toast(`Database cleared: ${n.toLocaleString()} rows removed`);
      setSel(new Set()); setConfirm('');
    } catch (e) { setErr(e instanceof Error ? e.message : 'Could not clear.'); } finally { setBusy(false); }
  };
  return (
    <section className="card danger-zone" aria-labelledby="db-title">
      <h2 id="db-title">Clear database</h2>
      <p className="sub">Removes the chosen data for everyone, permanently. Users and passwords stay. Download anything you need first (Export, Packing Lists).</p>
      <label className="db-all"><input type="checkbox" checked={all} onChange={() => setSel(all ? new Set() : new Set(GROUPS.map((g) => g.id)))} /> <b>Everything</b> (except users)</label>
      <div className="db-groups">
        {GROUPS.map((g) => (
          <label key={g.id}><input type="checkbox" checked={sel.has(g.id)} onChange={() => setSel((s) => { const n = new Set(s); if (n.has(g.id)) n.delete(g.id); else n.add(g.id); return n; })} />
            <span><b>{g.label}</b><small>{g.hint}</small></span></label>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 12 }}>
        <label style={{ fontSize: 13 }}>Type <b>CLEAR</b> to confirm <input value={confirm} onChange={(e) => setConfirm(e.target.value)} className="db-confirm" aria-label="Type CLEAR" /></label>
        <button className="btn danger" disabled={busy || !sel.size || confirm.trim().toUpperCase() !== 'CLEAR'} onClick={run}>{busy ? 'Clearing…' : `Clear ${sel.size || ''} selected`}</button>
      </div>
      {err && <div className="notice bad" style={{ marginTop: 10 }}>{err}</div>}
    </section>
  );
}
