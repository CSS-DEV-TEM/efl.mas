'use client';
import { useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { avail, fmt, fmtDate, fmtQty, need, type DispatchItem, type Line } from '@/lib/calc';

/**
 * Items dispatched more than their plan lines need ("Over plan" in Dispatch vs plan).
 * Only that extra QTY is offered: pick the open plan line it went to (best guesses first) and add it to that line's Dispatched.
 */
export default function OverPlan({ week, items, rows, canEdit, onDone }: { week: string; items: DispatchItem[]; rows: Line[]; canEdit: boolean; onDone: (m: string) => void }) {
  const over = items.filter((i) => i.lines > 0 && i.over > 1e-9);
  const open = useMemo(() => rows.filter((l) => need(l) > 1e-9), [rows]);
  // best target lines for an item: same SO as its own plan lines, then lines with UR left, then earliest date
  const candidates = useMemo(() => {
    const m = new Map<string, Line[]>();
    for (const i of over) {
      const sos = new Set(rows.filter((l) => l.item === i.item).map((l) => l.so));
      const score = (l: Line) => (sos.has(l.so) ? 2 : 0) + (avail(l) > 1e-9 ? 1 : 0);
      m.set(i.item, open.filter((l) => l.item !== i.item).sort((a, b) => score(b) - score(a) || String(a.date ?? '').localeCompare(String(b.date ?? '')) || a.row_no - b.row_no).slice(0, 40));
    }
    return m;
  }, [over, open, rows]);
  const [pick, setPick] = useState<Record<string, number>>({});
  const [qty, setQty] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const target = (i: DispatchItem) => { const c = candidates.get(i.item) || []; return c.find((l) => l.id === pick[i.item]) || c[0]; };
  const amount = (i: DispatchItem) => { const t = target(i); const d = t ? Math.round(Math.min(i.over, need(t)) * 1000) / 1000 : 0; return qty[i.item] !== undefined ? Number(qty[i.item]) : d; };
  const add = async (list: DispatchItem[]) => {
    setBusy(true);
    let n = 0, total = 0;
    try {
      for (const i of list) {
        const t = target(i), q = amount(i);
        if (!t || !(q > 0)) continue;
        await api('/api/dispatch/assign', { method: 'POST', body: { week, item: i.item, key: t.key, date: t.date, qty: q } });
        n++; total += q;
      }
      setPick({}); setQty({});
      onDone(n ? `Over-plan QTY added to Dispatched: ${fmt(total, 2)} on ${n} line${n === 1 ? '' : 's'}` : 'Nothing to add');
    } catch (e) { alert(e instanceof Error ? e.message : 'Could not add.'); onDone('Partly added'); } finally { setBusy(false); }
  };
  if (!over.length) return null;
  return (
    <section className="card" aria-labelledby="op-title">
      <div className="sheet-top">
        <div>
          <h2 id="op-title">Over plan → Dispatch <span className="pill accent" style={{ marginLeft: 6 }}>{over.length}</span></h2>
          <p className="sub" style={{ margin: 0 }}>Only the QTY dispatched above each item&apos;s plan (the &quot;Over plan&quot; column). Pick the plan line it belongs to — same SO first, then lines with UR left — and add it to that line&apos;s Dispatched. Undo it under &quot;Assigned by hand&quot;.</p>
        </div>
        {canEdit && <button className="btn primary" aria-busy={!!busy || undefined} disabled={busy} onClick={() => add(over)}>{busy ? 'Adding…' : `Add all (${fmt(over.reduce((t, i) => t + amount(i), 0), 2)})`}</button>}
      </div>
      <div className="table-wrap" style={{ maxHeight: 'none', marginTop: 10 }}>
        <table className="mini">
          <thead><tr><th>Item</th><th className="n">Dispatched</th><th className="n">Plan QTY</th><th className="n">Over plan</th><th>Add to plan line</th><th className="n">QTY</th>{canEdit && <th />}</tr></thead>
          <tbody>{over.map((i) => {
            const c = candidates.get(i.item) || [], t = target(i);
            return (
              <tr key={i.item}>
                <td><b>{i.item}</b></td><td className="n">{fmtQty(i.dispatched)}</td><td className="n">{fmtQty(i.planQty)}</td><td className="n neg"><b>{fmtQty(i.over)}</b></td>
                <td>{c.length ? (
                  <select className="as-search" style={{ maxWidth: 420 }} value={t?.id} disabled={!canEdit} onChange={(e) => { setPick((p) => ({ ...p, [i.item]: Number(e.target.value) })); setQty((q) => { const n = { ...q }; delete n[i.item]; return n; }); }} aria-label={`Plan line for ${i.item}`}>
                    {c.map((l) => <option key={l.id} value={l.id}>{l.so} / {l.li} / {l.item} · {fmtDate(l.date)} · balance {fmtQty(need(l))} · UR left {fmtQty(avail(l))}</option>)}
                  </select>) : <span className="muted">No open plan line</span>}</td>
                <td className="n">{canEdit && t ? <input className="as-search" type="number" step="0.01" min="0.01" max={Math.min(i.over, need(t))} style={{ width: 100 }} value={qty[i.item] ?? amount(i)} onChange={(e) => setQty((q) => ({ ...q, [i.item]: e.target.value }))} aria-label="QTY" /> : fmtQty(amount(i))}</td>
                {canEdit && <td><button className="btn sm primary" aria-busy={!!busy || undefined} disabled={busy || !t || !(amount(i) > 0)} onClick={() => add([i])}>+ Add</button></td>}
              </tr>
            );
          })}</tbody>
        </table>
      </div>
    </section>
  );
}
