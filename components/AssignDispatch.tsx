'use client';
import { useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { avail, fmt, fmtDate, fmtQty, need, type DispatchAssign, type DispatchItem, type Line } from '@/lib/calc';

/** Dispatch QTY that did not match a plan line (item not in plan, or more than planned): assign it to a plan line by hand. */
export default function AssignDispatch({ week, leftover, assigns, rows, canEdit, onDone }: {
  week: string; leftover: DispatchItem[]; assigns: DispatchAssign[]; rows: Line[]; canEdit: boolean; onDone: (msg: string) => void;
}) {
  const [open, setOpen] = useState<DispatchItem | null>(null);
  const byLine = useMemo(() => new Map(rows.map((r) => [`${r.key}|${r.date ?? ''}`, r])), [rows]);
  const remove = async (a: DispatchAssign) => {
    if (!confirm('Remove this assignment? The plan line goes back to its balance before it.')) return;
    try { await api(`/api/dispatch/assign/${a.id}`, { method: 'DELETE' }); onDone('Assignment removed'); } catch (e) { alert(e instanceof Error ? e.message : 'Failed'); }
  };
  if (!leftover.length && !assigns.length) return null;
  return (
    <section className="card" aria-labelledby="lo-title">
      <h2 id="lo-title">Not matched to the plan {leftover.length > 0 && <span className="pill warn" style={{ marginLeft: 6 }}>{leftover.length}</span>}</h2>
      <p className="sub">Dispatch QTY that no plan line took: the item is not in the {week} plan, or more went out than planned. Assign it to a plan line — it is taken off that line&apos;s QTY and UR, and the line completes when nothing is left.</p>
      {leftover.length > 0 && (
        <div className="table-wrap" style={{ maxHeight: 'none' }}>
          <table className="mini">
            <thead><tr><th>Dispatch item</th><th>Why</th><th className="n">Dispatched</th><th className="n">Not matched</th><th className="n">Assigned</th><th /></tr></thead>
            <tbody>{leftover.map((i) => (
              <tr key={i.item}><td><b>{i.item}</b></td><td>{i.lines ? <span className="pill accent">More than planned</span> : <span className="pill warn">Not in plan</span>}</td>
                <td className="n">{fmtQty(i.dispatched)}</td><td className="n neg"><b>{fmt(i.over, 3)}</b></td><td className="n">{fmtQty(i.assigned ?? 0)}</td>
                <td>{canEdit && <button className="btn sm primary" onClick={() => setOpen(i)}>Assign →</button>}</td></tr>
            ))}</tbody>
          </table>
        </div>
      )}
      {assigns.length > 0 && (
        <>
          <h3 style={{ margin: '14px 0 6px', fontSize: 14 }}>Assigned by hand</h3>
          <div className="table-wrap" style={{ maxHeight: 'none' }}>
            <table className="mini">
              <thead><tr><th>Dispatch item</th><th>→ Plan line</th><th>Date</th><th className="n">QTY</th><th className="n">Applied</th><th>By</th><th /></tr></thead>
              <tbody>{assigns.map((a) => { const l = byLine.get(a.line); return (
                <tr key={a.id}><td>{a.item}</td><td>{l ? `${l.so} / ${l.li} / ${l.item}` : <span className="muted">line no longer in plan</span>}</td><td>{l ? fmtDate(l.date) : ''}</td>
                  <td className="n">{fmtQty(a.qty)}</td><td className={`n ${(a.applied ?? 0) + 1e-9 < a.qty ? 'neg' : ''}`} title="Less than asked when the line had less balance or the item had less left over">{fmtQty(a.applied ?? 0)}</td>
                  <td className="muted">{a.by_user}</td><td>{canEdit && <button className="btn sm" onClick={() => remove(a)}>Remove</button>}</td></tr>
              ); })}</tbody>
            </table>
          </div>
        </>
      )}
      {open && <AssignModal week={week} item={open} rows={rows} onClose={() => setOpen(null)} onDone={(m) => { setOpen(null); onDone(m); }} />}
    </section>
  );
}

function AssignModal({ week, item, rows, onClose, onDone }: { week: string; item: DispatchItem; rows: Line[]; onClose: () => void; onDone: (m: string) => void }) {
  const [q, setQ] = useState('');
  const [pick, setPick] = useState<Line | null>(null);
  const [qty, setQty] = useState('');
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const open = useMemo(() => rows.filter((r) => need(r) > 1e-9), [rows]);
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    const list = s ? open.filter((r) => [r.so, r.li, r.item, r.plant, r.remarks].join(' ').toLowerCase().includes(s)) : open;
    // same item first, then similar item numbers
    return list.slice().sort((a, b) => Number(b.item === item.item) - Number(a.item === item.item) || String(a.item).localeCompare(String(b.item))).slice(0, 200);
  }, [open, q, item.item]);
  const choose = (l: Line) => { setPick(l); setQty(String(Math.round(Math.min(item.over, need(l)) * 1000) / 1000)); };
  const save = async (e: React.FormEvent) => {
    e.preventDefault(); if (!pick) return;
    setBusy(true); setErr('');
    try {
      await api('/api/dispatch/assign', { method: 'POST', body: { week, item: item.item, key: pick.key, date: pick.date, qty: Number(qty) } });
      onDone(`Assigned ${qty} of ${item.item} to ${pick.so} / ${pick.li}${Number(qty) >= need(pick) - 1e-9 ? ' — line complete' : ''}`);
    } catch (x) { setErr(x instanceof Error ? x.message : 'Could not assign.'); } finally { setBusy(false); }
  };
  return (
    <div className="modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <form className="modal wide" role="dialog" aria-modal="true" aria-labelledby="as-title" onSubmit={save}>
        <div className="modal-head">
          <div><h2 id="as-title">Assign dispatch {item.item}</h2><p className="sub" style={{ margin: 0 }}>{fmt(item.over, 3)} not matched. Pick the plan line it went to.</p></div>
          <button type="button" className="btn sm" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <input type="search" autoFocus placeholder="Search SO, LI, item code, plant…" value={q} onChange={(e) => setQ(e.target.value)} className="as-search" aria-label="Search plan lines" />
        <div className="table-wrap" style={{ maxHeight: 320 }}>
          <table className="mini">
            <thead><tr><th /><th>SO</th><th>LI</th><th>Item</th><th>Date</th><th className="n">QTY</th><th className="n">Balance</th><th className="n">UR</th></tr></thead>
            <tbody>{shown.map((l) => (
              <tr key={l.id} className={pick?.id === l.id ? 'picked' : ''} onClick={() => choose(l)} style={{ cursor: 'pointer' }}>
                <td><input type="radio" name="pl" checked={pick?.id === l.id} onChange={() => choose(l)} aria-label={`${l.so} ${l.li}`} /></td>
                <td>{l.so}</td><td>{l.li}</td><td>{l.item}{l.item === item.item && <span className="pill ok" style={{ marginLeft: 4 }}>same item</span>}</td><td>{fmtDate(l.date)}</td>
                <td className="n">{fmtQty(l.qty)}</td><td className="n"><b>{fmtQty(need(l))}</b></td><td className="n">{fmtQty(avail(l))}</td></tr>
            ))}</tbody>
          </table>
          {!shown.length && <p className="muted" style={{ padding: 10 }}>No open plan lines match.</p>}
        </div>
        {pick && (
          <div className="rel-box">
            <span>{pick.so} / {pick.li} / {pick.item} · balance {fmtQty(need(pick))}</span>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>QTY
              <input type="number" step="0.001" min="0.001" max={Math.min(item.over, need(pick))} value={qty} onChange={(e) => setQty(e.target.value)} style={{ width: 120 }} className="as-search" required />
            </label>
          </div>
        )}
        {err && <div className="notice bad">{err}</div>}
        <div className="modal-foot"><span /><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!pick || busy || !(Number(qty) > 0)}>{busy ? 'Saving…' : 'Assign & take off plan'}</button></div>
      </form>
    </div>
  );
}
