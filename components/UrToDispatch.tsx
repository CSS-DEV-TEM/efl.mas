'use client';
import { useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { avail, fmt, fmtDate, fmtQty, need, type Line } from '@/lib/calc';

export const UR_LEFT = '#UR';

/** Plan lines that still have a balance and UR left: add that UR (up to the balance) to Dispatched, one line or many at once. */
export default function UrToDispatch({ week, rows, canEdit, onDone }: { week: string; rows: Line[]; canEdit: boolean; onDone: (msg: string) => void }) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const take = (l: Line) => Math.round(Math.min(avail(l), need(l)) * 1000) / 1000;
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return rows.filter((l) => take(l) > 1e-9 && (!s || [l.so, l.li, l.item, l.plant].join(' ').toLowerCase().includes(s)))
      .sort((a, b) => String(a.date ?? '').localeCompare(String(b.date ?? '')) || a.row_no - b.row_no);
  }, [rows, q]);
  const picked = list.filter((l) => sel.has(l.id));
  const add = async (ls: Line[]) => {
    if (!ls.length) return;
    setBusy(true);
    try {
      const r = await api<{ lines: number; qty: number }>('/api/dispatch/assign', { method: 'POST', body: { week, item: UR_LEFT, lines: ls.map((l) => ({ key: l.key, date: l.date, qty: take(l) })) } });
      setSel(new Set());
      onDone(`UR left added to Dispatched: ${fmt(r.qty, 2)} on ${fmt(r.lines)} line${r.lines === 1 ? '' : 's'}`);
    } catch (e) { alert(e instanceof Error ? e.message : 'Could not add.'); } finally { setBusy(false); }
  };
  const all = list.length > 0 && picked.length === list.length;
  return (
    <section className="card" aria-labelledby="ur-title">
      <div className="sheet-top">
        <div>
          <h2 id="ur-title">UR left → Dispatched <span className="pill ok" style={{ marginLeft: 6 }}>{fmt(list.length)}</span></h2>
          <p className="sub" style={{ margin: 0 }}>Lines with a balance and UR stock left. Adding marks that UR as dispatched (up to the balance); a line with nothing left becomes complete. Undo it under &quot;Assigned by hand&quot;.</p>
        </div>
        {canEdit && list.length > 0 && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn primary" disabled={busy || !picked.length} onClick={() => add(picked)}>Add selected ({fmt(picked.length)} · {fmt(picked.reduce((t, l) => t + take(l), 0), 2)})</button>
            <button className="btn" disabled={busy} onClick={() => { if (confirm(`Add UR left to Dispatched on all ${list.length} lines (${fmt(list.reduce((t, l) => t + take(l), 0), 2)})?`)) add(list); }}>Add all</button>
          </div>
        )}
      </div>
      {list.length === 0 && !q ? <p className="muted">No open line has UR left.</p> : (
        <>
          <input type="search" className="as-search" placeholder="Search SO, LI, item, plant…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search lines" style={{ margin: '10px 0', width: 280 }} />
          <div className="table-wrap" style={{ maxHeight: 420 }}>
            <table className="mini">
              <thead><tr>{canEdit && <th><input type="checkbox" aria-label="Select all" checked={all} onChange={() => setSel(all ? new Set() : new Set(list.map((l) => l.id)))} /></th>}
                <th>SO</th><th>LI</th><th>Item</th><th>Date</th><th className="n">QTY</th><th className="n">Dispatched</th><th className="n">Balance</th><th className="n">UR left</th><th className="n">Will add</th>{canEdit && <th />}</tr></thead>
              <tbody>{list.map((l) => (
                <tr key={l.id} className={sel.has(l.id) ? 'picked' : ''}>
                  {canEdit && <td><input type="checkbox" aria-label={`Select ${l.so} ${l.li}`} checked={sel.has(l.id)} onChange={() => setSel((s) => { const n = new Set(s); if (n.has(l.id)) n.delete(l.id); else n.add(l.id); return n; })} /></td>}
                  <td>{l.so}</td><td>{l.li}</td><td>{l.item}</td><td>{fmtDate(l.date)}</td><td className="n">{fmtQty(l.qty)}</td><td className="n">{fmtQty(l.dispatched ?? 0)}</td>
                  <td className="n"><b>{fmtQty(need(l))}</b></td><td className="n">{fmtQty(avail(l))}</td><td className="n pos-c"><b>{fmtQty(take(l))}</b>{take(l) >= need(l) - 1e-9 && <span className="tick" title="Line completes"> ✓</span>}</td>
                  {canEdit && <td><button className="btn sm" disabled={busy} onClick={() => add([l])}>+ Add</button></td>}
                </tr>
              ))}</tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
