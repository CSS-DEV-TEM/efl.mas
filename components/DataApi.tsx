'use client';
/**
 * v206 (API 132): the data API — read-only keys for outside systems (Power BI, Excel, scripts). A key is shown ONCE when
 * made (only its hash is kept) and can be revoked any time. Users, passwords and keys are never in the API.
 */
import * as React from 'react';
import { useCallback, useEffect, useState } from 'react';
import { API_URL, api } from '@/lib/api';
import { askConfirm } from '@/lib/ask';

interface Key { id: number; name: string; prefix: string; created_by: string; created_at: string; last_used_at: string | null; uses: number; revoked_at: string | null }

export default function DataApi({ toast }: { toast: (m: string) => void }) {
  const [keys, setKeys] = useState<Key[] | null>(null);
  const [name, setName] = useState('');
  const [made, setMade] = useState<{ name: string; key: string } | null>(null);
  const load = useCallback(() => api<{ keys: Key[] }>('/api/apikeys').then((r) => setKeys(r.keys)).catch((e) => { toast(e instanceof Error ? e.message : 'Could not load.'); setKeys([]); }), [toast]);
  useEffect(() => { void load(); }, [load]);
  const make = async () => {
    try { const r = await api<{ name: string; key: string }>('/api/apikeys', { method: 'POST', body: { name } }); setMade(r); setName(''); await load(); }
    catch (e) { toast(e instanceof Error ? e.message : 'Could not make the key.'); }
  };
  const revoke = async (k: Key) => {
    if (!await askConfirm(`Revoke "${k.name}" (mas_${k.prefix}_…)? Anything using it stops getting data.`)) return;
    try { await api('/api/apikeys?id=' + k.id, { method: 'DELETE' }); toast(`"${k.name}" revoked`); await load(); }
    catch (e) { toast(e instanceof Error ? e.message : 'Could not revoke.'); }
  };
  const base = `${API_URL}/api/ext/v1`;
  const ex = [
    ['Plan lines of a day (JSON)', `${base}/plan?type=day&day=2026-11-18`],
    ['One Pick of the day', `${base}/plan?type=day&day=2026-11-18&round=2026-11-18~C063~1`],
    ['Week plan (CSV)', `${base}/plan?type=week&week=2026-W47&format=csv`],
    ['Picked rolls of a day (CSV)', `${base}/picks?day=2026-11-18&format=csv`],
    ['Picked rolls, a range of days', `${base}/picks?from=2026-11-01&to=2026-11-18`],
    ['MAS Kreeda', `${base}/picks?day=2026-11-18&div=kreeda`],
  ];
  return (
    <section className="card set-card">
      <h2>Data API</h2>
      <p className="muted small">Read-only access to the plan lines (with status, picked, dispatched, JOB ID) and the picked rolls (Packing List rows) for outside systems. Send the key in the header <code>X-API-Key</code>. Company data: share keys only with systems IT / management have approved.</p>
      <div className="api-make">
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="Key name — who / what uses it (e.g. Power BI planning)" aria-label="Key name" />
        <button className="btn primary" disabled={!name.trim()} onClick={() => void make()}>Make key</button>
      </div>
      {made && (
        <div className="notice ok api-made" role="status">
          <b>{made.name}</b> — copy the key now: it is not shown again.
          <div className="api-key"><code>{made.key}</code><button className="btn sm" onClick={() => { void navigator.clipboard?.writeText(made.key); toast('Key copied'); }}>Copy</button><button className="btn sm" onClick={() => setMade(null)}>Done</button></div>
        </div>
      )}
      {keys === null ? <p className="muted small">Loading…</p> : keys.length ? (
        <div className="table-wrap"><table className="tbl">
          <thead><tr><th>Name</th><th>Key</th><th>Made</th><th>Last used</th><th className="n">Calls</th><th /></tr></thead>
          <tbody>{keys.map((k) => (
            <tr key={k.id} className={k.revoked_at ? 'muted' : ''}><td>{k.name}</td><td><code>mas_{k.prefix}_…</code></td><td>{k.created_by} · {new Date(k.created_at).toLocaleDateString()}</td>
              <td>{k.last_used_at ? new Date(k.last_used_at).toLocaleString() : '—'}</td><td className="n">{k.uses ?? 0}</td>
              <td>{k.revoked_at ? <span className="pill bad">revoked</span> : <button className="btn sm danger" onClick={() => void revoke(k)}>Revoke</button>}</td></tr>
          ))}</tbody>
        </table></div>
      ) : <p className="muted small">No key yet.</p>}
      <h3 style={{ marginTop: 16 }}>How to call it</h3>
      <div className="table-wrap"><table className="tbl api-ex">
        <tbody>{ex.map(([t, u]) => <tr key={u}><td>{t}</td><td><code>GET {u}</code></td></tr>)}</tbody>
      </table></div>
      <p className="muted small">Header: <code>X-API-Key: mas_…</code> (or <code>Authorization: Bearer mas_…</code>). Picks: <code>day</code> or <code>from</code>/<code>to</code> are pick days (62 days at most), <code>pick=</code> one Pick, <code>cancelled=1</code> adds cancelled picks. <code>format=csv</code> for CSV; JSON gives <code>fields</code> and <code>rows</code>. <code>GET {base}</code> lists everything.</p>
    </section>
  );
}
