'use client';
/**
 * v206 (API 132): a Korber file of pallets picked OUTSIDE this system — only those pallets, Actual Qty = the QTY taken.
 * Saved as picks of those pallets: the system does not pick that QTY again (every Pick, every day). Each upload can be
 * removed (undo): the QTY is free again.
 */
import * as React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { fmt } from '@/lib/calc';
import { readWorkbook } from '@/lib/mapping';
import { findTable } from '@/lib/pick';

const hn = (v: unknown) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
interface Batch { batch: string; file_name: string; by_user: string; at: string; n: number; qty: number }

export default function UsedPallets({ canEdit, toast, onChanged }: { canEdit: boolean; toast: (m: string) => void; onChanged?: () => void }) {
  const [list, setList] = useState<Batch[] | null>(null);
  const [busy, setBusy] = useState(false);
  const inp = useRef<HTMLInputElement>(null);
  const load = useCallback(() => api<{ batches: Batch[] }>('/api/used').then((r) => setList(r.batches)).catch(() => setList([])), []);
  useEffect(() => { void load(); }, [load]);

  const upload = async (f: File) => {
    setBusy(true);
    try {
      const t = findTable(readWorkbook(await f.arrayBuffer()), 'korber');
      if (!t) throw new Error(`${f.name} does not look like a Korber Inventory: no header row with Pallet, Item Number, Actual Qty.`);
      const h = t.header.map(hn);
      const pi = h.indexOf('pallet'), qi = h.indexOf('actual qty'), ii = h.indexOf('item number'), di = h.indexOf('display item number'), li = h.indexOf('lot number');
      const rows = t.rows.map((r) => ({ pallet: r[pi], item: (di >= 0 && r[di]) || r[ii], lot: li >= 0 ? r[li] : null, qty: r[qi] }));
      const n = new Set(rows.map((r) => String(r.pallet ?? '').trim()).filter(Boolean)).size;
      if (!window.confirm(`${f.name}: save ${fmt(n)} pallet${n === 1 ? '' : 's'} as PICKED (outside the system)?\n\nTheir Actual Qty comes off those pallets for every Pick — the system will not pick that QTY again. You can remove the upload later.`)) return;
      const r = await api<{ pallets: number; qty: number; over: number; unknown: number }>('/api/used', { method: 'POST', body: { fileName: f.name, rows } });
      toast(`${f.name}: ${fmt(r.pallets)} pallet${r.pallets === 1 ? '' : 's'} · ${fmt(r.qty, 2)} QTY saved as picked — not picked again${r.over ? ` · ${r.over} over what the pallet had` : ''}${r.unknown ? ` · ${r.unknown} not in the Korber Inventory` : ''}`);
      await load(); onChanged?.();
    } catch (e) { toast(e instanceof Error ? e.message : 'Could not upload.'); }
    finally { setBusy(false); }
  };
  const remove = async (b: Batch) => {
    if (!window.confirm(`Remove ${b.file_name} (${fmt(b.n)} pallet rows, ${fmt(b.qty, 2)} QTY)? That QTY can be picked again.`)) return;
    try { await api('/api/used?batch=' + encodeURIComponent(b.batch), { method: 'DELETE' }); toast(`${b.file_name} removed — ${fmt(b.qty, 2)} QTY free again`); await load(); onChanged?.(); }
    catch (e) { toast(e instanceof Error ? e.message : 'Could not remove.'); }
  };

  return (
    <section className="card used-card" aria-labelledby="used-title">
      <div className="table-head">
        <div>
          <h2 id="used-title">Picked pallets (Korber)</h2>
          <p className="muted small" style={{ margin: 0 }}>A Korber Inventory file of pallets already picked outside this system — only those pallets, <b>Actual Qty = QTY taken</b>. Saved as picked: the system does not pick that pallet QTY again (every Pick). Remove an upload to free it.</p>
        </div>
        {canEdit && <>
          <button className="btn primary" disabled={busy} aria-busy={busy || undefined} onClick={() => inp.current?.click()}>{busy ? 'Saving…' : 'Upload picked pallets'}</button>
          <input ref={inp} type="file" hidden accept=".xlsx,.xls,.xlsm,.csv" onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ''; }} />
        </>}
      </div>
      {list === null ? <p className="muted small">Loading…</p> : !list.length ? <p className="muted small">No picked-pallets file uploaded.</p> : (
        <div className="table-wrap"><table className="tbl used-tbl">
          <thead><tr><th>File</th><th className="n">Pallets</th><th className="n">QTY</th><th>By</th><th>Uploaded</th>{canEdit && <th />}</tr></thead>
          <tbody>{list.map((b) => (
            <tr key={b.batch}><td>{b.file_name}</td><td className="n">{fmt(b.n)}</td><td className="n">{fmt(b.qty, 2)}</td><td>{b.by_user}</td><td>{new Date(b.at).toLocaleString()}</td>
              {canEdit && <td><button className="btn sm danger" onClick={() => void remove(b)}>Remove</button></td>}</tr>
          ))}</tbody>
        </table></div>
      )}
    </section>
  );
}
