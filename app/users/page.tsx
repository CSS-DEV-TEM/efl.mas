'use client';
import { useCallback, useEffect, useState } from 'react';
import Shell, { useShell } from '@/components/Shell';
import { api, type Role } from '@/lib/api';
import { ago } from '@/lib/calc';

export default function Page() {
  return <Shell admin><Users /></Shell>;
}

interface U { username: string; role: Role; plant?: string | null; created_at: string }
const ROLE_HELP: Record<Role, string> = {
  admin: 'Everything, plus users and clearing data',
  editor: 'Upload reports and edit Status / Comment / Vehicle',
  viewer: 'View and export only',
};

function Users() {
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
    <main className="page anim" style={{ maxWidth: 900 }}>
      <div className="page-head">
        <div>
          <h1>Users</h1>
          <p>Add people who can sign in. Give plant users their plant: their plan uploads are tagged with it and "Replace my plant" only touches their lines. Entering an existing username with a new password resets that password.</p>
        </div>
      </div>

      <section className="card">
        <h2>Add or update a user</h2>
        <p className="sub">Passwords are stored hashed (PBKDF2) in Cloudflare D1.</p>
        <form className="form" onSubmit={save} style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', alignItems: 'end' }}>
          <label htmlFor="nu">Username<input id="nu" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} required /></label>
          <label htmlFor="np">Password<input id="np" type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="min 6 characters" /></label>
          <label htmlFor="nr">Role
            <select id="nr" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
              <option value="editor">Editor</option><option value="viewer">Viewer</option><option value="admin">Admin</option>
            </select>
          </label>
          <label htmlFor="npl">Plant (optional)<input id="npl" value={form.plant} onChange={(e) => setForm({ ...form, plant: e.target.value.toUpperCase() })} placeholder="e.g. C051" /></label>
          <button className="btn primary" type="submit" disabled={busy}>Save user</button>
        </form>
        <p className="sub" style={{ marginTop: 10 }}>{ROLE_HELP[form.role]}.</p>
        {err && <div className="notice bad">{err}</div>}
      </section>

      <section className="card table-card">
        <div className="table-wrap" style={{ maxHeight: 'none' }}>
          <table className="ledger">
            <thead><tr><th><button tabIndex={-1}>Username</button></th><th><button tabIndex={-1}>Role</button></th><th><button tabIndex={-1}>Plant</button></th><th><button tabIndex={-1}>Added</button></th><th /></tr></thead>
            <tbody>
              {list.map((u) => (
                <tr key={u.username}>
                  <td className="mono">{u.username}{u.username === user.username ? ' (you)' : ''}</td>
                  <td>
                    <select value={u.role} disabled={u.username === user.username} onChange={(e) => setRole(u.username, e.target.value as Role)}
                      style={{ border: '1px solid var(--line-strong)', borderRadius: 5, padding: '3px 6px', background: 'var(--panel)' }}>
                      <option value="admin">admin</option><option value="editor">editor</option><option value="viewer">viewer</option>
                    </select>
                  </td>
                  <td><input className="edit" defaultValue={u.plant || ''} placeholder="—" aria-label={`Plant for ${u.username}`}
                    onBlur={(e) => { const v = e.target.value.trim().toUpperCase(); if (v !== (u.plant || '')) setRole(u.username, u.role, v || null); }} /></td>
                  <td className="muted">{ago(u.created_at)}</td>
                  <td style={{ textAlign: 'right' }}>{u.username !== user.username && <button className="btn sm danger" onClick={() => remove(u.username)}>Remove</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
