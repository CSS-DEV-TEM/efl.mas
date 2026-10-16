'use client';
import { useEffect, useMemo, useState } from 'react';
import { fmt, fmtDate, fmtQty, isDone, shortBy, type Line } from '@/lib/calc';
import { ACTION_PILL, DUE_PILL, action, due, priority, todayLocal, type Insight } from '@/lib/smart';
import { exportPullPlan } from '@/lib/export';
import { canRelease, releaseFor, releaseLines } from '@/lib/release';

/** Opens from a Smart Insights card: the full finding, its totals and the lines behind it. */
export default function InsightDrawer({ insight, rows, week, canEdit, onEdit, onShowInTable, onClose, onReleased }: {
  insight: Insight; rows: Line[]; week: string; canEdit: boolean;
  onEdit: (l: Line) => void; onShowInTable: () => void; onClose: () => void; onReleased?: (msg: string) => void;
}) {
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const releasable = useMemo(() => rows.filter(canRelease), [rows]);
  const relQty = releasable.reduce((t, l) => { const r = releaseFor(l); return t + r.qi + r.block; }, 0);
  const release = async () => {
    setBusy(true); setErr('');
    try { const r = await releaseLines(week, releasable); onReleased?.(`Released ${fmt(r.qty, 2)} QI / Block to UR on ${fmt(r.lines)} line${r.lines === 1 ? '' : 's'} — they are now Ready to pull`); onClose(); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Release failed.'); } finally { setBusy(false); }
  };
  const today = todayLocal();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = ''; };
  }, [onClose]);

  const sorted = useMemo(() => [...rows].sort((a, b) => priority(b, today) - priority(a, today) || a.row_no - b.row_no), [rows, today]);
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? sorted.filter((l) => [l.so, l.li, l.item, l.remarks, l.plant, l.status, l.comment].join(' ').toLowerCase().includes(s)) : sorted;
  }, [sorted, q]);
  const qty = rows.reduce((s, l) => s + l.qty, 0);
  const short = rows.filter((l) => !isDone(l)).reduce((s, l) => s + shortBy(l), 0);
  const ur = rows.reduce((s, l) => s + l.ur, 0);
  const dates = Array.from(new Set(rows.map((l) => l.date || ''))).sort();

  return (
    <div className="drawer-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside className={`drawer tone-${insight.tone}`} role="dialog" aria-modal="true" aria-labelledby="drawer-title">
        <div className="drawer-head">
          <div className="drawer-count">{insight.count}</div>
          <div style={{ minWidth: 0 }}>
            <h2 id="drawer-title">{insight.title}</h2>
            <p>{insight.detail}</p>
          </div>
          <button type="button" className="btn sm" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="drawer-stats">
          <div><span>Lines</span><b>{fmt(rows.length)}</b></div>
          <div><span>QTY</span><b>{fmt(qty, 0)}</b></div>
          <div><span>Full UR</span><b>{fmt(ur, 0)}</b></div>
          <div><span>Short vs UR</span><b className={short > 0 ? 'neg' : ''}>{fmt(short, 0)}</b></div>
          <div><span>Dates</span><b>{dates.length ? `${fmtDate(dates[0] || null)}${dates.length > 1 ? ' – ' + fmtDate(dates[dates.length - 1] || null) : ''}` : '–'}</b></div>
        </div>

        <div className="drawer-tools">
          <input type="search" placeholder="Search these lines…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search these lines" />
          {canEdit && releasable.length > 0 && (
            <button type="button" className="btn ok-btn" disabled={busy} onClick={release} title="QI first, then Block, only what each line is short of">
              {busy ? 'Releasing…' : `Release to UR · ${fmt(releasable.length)} line${releasable.length === 1 ? '' : 's'} · ${fmt(relQty, 2)}`}
            </button>
          )}
          <button type="button" className="btn" onClick={onShowInTable}>Show in main table</button>
          <button type="button" className="btn primary" disabled={!rows.length} onClick={() => exportPullPlan(sorted, `MAS_${insight.id}_${week.replace('-', '_')}`)}>Export</button>
        </div>

        {err && <div className="notice bad" style={{ margin: '0 16px' }}>{err}</div>}
        <div className="drawer-table">
          <table className="ledger">
            <thead>
              <tr>
                <th className="n"><button type="button" tabIndex={-1}>Priority</button></th>
                <th><button type="button" tabIndex={-1}>SO</button></th>
                <th className="n"><button type="button" tabIndex={-1}>LI</button></th>
                <th><button type="button" tabIndex={-1}>Item</button></th>
                <th><button type="button" tabIndex={-1}>Date</button></th>
                <th className="n"><button type="button" tabIndex={-1}>QTY</button></th>
                <th className="n"><button type="button" tabIndex={-1}>UR</button></th>
                <th className="n"><button type="button" tabIndex={-1}>QI + Block</button></th>
                <th className="n"><button type="button" tabIndex={-1}>Short</button></th>
                <th><button type="button" tabIndex={-1}>Next action</button></th>
                <th><button type="button" tabIndex={-1}>Plant</button></th>
                <th><button type="button" tabIndex={-1}>Status</button></th>
                {canEdit && <th />}
              </tr>
            </thead>
            <tbody>
              {shown.map((l) => {
                const a = action(l), d = due(l, today);
                return (
                  <tr key={l.id} className={canEdit ? 'clickable' : ''} onClick={canEdit ? () => onEdit(l) : undefined}>
                    <td className="n"><b>{priority(l, today)}</b></td>
                    <td className="mono">{l.so}{l.carried ? <span className="carry">↻</span> : null}</td>
                    <td className="n">{l.li}</td>
                    <td className="mono">{l.item}</td>
                    <td><span className={`pill ${isDone(l) ? 'mute' : DUE_PILL[d]}`}>{fmtDate(l.date)}</span></td>
                    <td className="n">{fmtQty(l.qty)}</td>
                    <td className="n">{fmtQty(l.ur)}</td>
                    <td className="n">{fmtQty(l.qi + l.block)}</td>
                    <td className={`n ${shortBy(l) > 0 && !isDone(l) ? 'neg' : ''}`}>{fmtQty(shortBy(l))}</td>
                    <td><span className={`pill ${ACTION_PILL[a]}`}>{a}</span></td>
                    <td>{l.plant || ''}</td>
                    <td>{l.status || ''}</td>
                    {canEdit && <td><button type="button" className="btn sm" onClick={(e) => { e.stopPropagation(); onEdit(l); }}>Edit</button></td>}
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!shown.length && <div className="empty">No lines match.</div>}
        </div>
      </aside>
    </div>
  );
}
