'use client';
import { memo, useEffect, useMemo, useState } from 'react';
import { avail, coverage, fmtDate, fmtQty, isDispatched, isDone, lineRef, need, shortBy, type Line } from '@/lib/calc';
import { ACTION_HELP, ACTION_PILL, DUE_PILL, action, due, priority, todayLocal } from '@/lib/smart';

const TODAY = todayLocal();

const COV_PILL: Record<string, string> = { Covered: 'ok', Partial: 'warn', 'QI / Block only': 'info', 'No stock': 'bad' };
export const STATUS_OPTIONS = ['Done', 'Pending', 'Loaded', 'Shortage', 'Roll issue', 'In QI', 'Hold'];

type Col = { id: string; label: string; grp?: string; n?: boolean; full?: boolean; get: (l: Line) => string | number; render?: (l: Line) => React.ReactNode };
const q = (v: number) => fmtQty(v);

const COLS: Col[] = [
  { id: 'so', label: 'SO', get: (l) => l.so, render: (l) => <>{l.so}{l.carried ? <span className="carry" title="Also in last week's plan and not Done there">↻ carried</span> : null}</> },
  { id: 'li', label: 'LI', n: true, get: (l) => Number(l.li) || 0 },
  { id: 'item', label: 'Item code', get: (l) => l.item },
  { id: 'date', label: 'Date', get: (l) => l.date || '', render: (l) => fmtDate(l.date) },
  { id: 'due', label: 'Due', grp: 'Smart', get: (l) => ['Overdue', 'Today', 'Tomorrow', 'This week', 'Later', 'No date'].indexOf(due(l, TODAY)), render: (l) => { const d = due(l, TODAY); return isDone(l) ? <span className="pill mute">{d}</span> : <span className={`pill ${DUE_PILL[d]}`}>{d}</span>; } },
  { id: 'action', label: 'Next action', grp: 'Smart', get: (l) => action(l), render: (l) => { const a = action(l); return <span className={`pill ${ACTION_PILL[a]}`} title={ACTION_HELP[a]}>{a}</span>; } },
  { id: 'priority', label: 'Priority', grp: 'Smart', n: true, get: (l) => priority(l, TODAY), render: (l) => { const p = priority(l, TODAY); return <span className="prio" title={`Priority ${p} / 100`}><span className="trk"><i style={{ width: `${p}%`, background: p >= 70 ? 'var(--bad)' : p >= 45 ? 'var(--warn)' : 'var(--ok)' }} /></span><b>{p}</b></span>; } },
  { id: 'qty', label: 'QTY', n: true, get: (l) => l.qty, render: (l) => q(l.qty) },
  { id: 'dispatched', label: 'Dispatched', grp: 'Dispatch', n: true, get: (l) => l.dispatched ?? 0, render: (l) => (l.dispatched ? <span className="disp-q">{q(l.dispatched)}{isDispatched(l) && <span className="tick" title="Fully dispatched — complete">✓</span>}</span> : '–') },
  { id: 'balance', label: 'Balance', grp: 'Dispatch', n: true, get: (l) => need(l), render: (l) => (l.dispatched ? <b className={need(l) > 0 ? '' : 'pos'}>{need(l) > 0 ? q(need(l)) : '0'}</b> : q(need(l))) },
  { id: 'ur', label: 'UR', grp: 'Full', n: true, get: (l) => l.ur, render: (l) => (l.released ? <span title={`Includes ${q(l.released)} QI / Block released to UR`}>{q(l.ur)}<span className="rel-tag">+rel</span></span> : q(l.ur)) },
  { id: 'ur_left', label: 'UR left', grp: 'Full', n: true, full: true, get: (l) => avail(l), render: (l) => <span title={(l.ur_take_key ?? l.ur_take ?? 0) > 0 ? `UR − ${q(l.ur_take_key ?? l.ur_take ?? 0)} picked after the latest ZMMBE (every line of this SO / LI / Item; picks before that ZMMBE are already out of its UR)` : ''}>{q(avail(l))}</span> },
  { id: 'korber', label: 'Korber', grp: 'Shelf', n: true, get: (l) => l.korber_avail ?? -1, render: (l) => (l.korber_avail == null ? '' : <span className={l.korber_avail < need(l) - 1e-6 ? 'kb-short' : ''} title={`${l.korber_rolls ?? 0} roll${l.korber_rolls === 1 ? '' : 's'} of this SO / LI / Item's lots on the Korber shelf (less picks)`}>{q(l.korber_avail)}</span>) },
  { id: 'qi', label: 'QI', grp: 'Full', n: true, get: (l) => l.qi, render: (l) => q(l.qi) },
  { id: 'block', label: 'Block', grp: 'Full', n: true, get: (l) => l.block, render: (l) => q(l.block) },
  { id: 'assigned', label: 'Assigned', n: true, full: true, get: (l) => l.assigned, render: (l) => q(l.assigned) },
  { id: 'variance', label: 'Variance', n: true, full: true, get: (l) => l.variance, render: (l) => q(l.variance) },
  { id: 'kfc_ur', label: 'UR', grp: 'KFC', n: true, get: (l) => l.kfc_ur, render: (l) => q(l.kfc_ur) },
  { id: 'kfc_qi', label: 'QI', grp: 'KFC', n: true, full: true, get: (l) => l.kfc_qi, render: (l) => q(l.kfc_qi) },
  { id: 'kfc_block', label: 'Block', grp: 'KFC', n: true, full: true, get: (l) => l.kfc_block, render: (l) => q(l.kfc_block) },
  { id: 'pfc_ur', label: 'UR', grp: 'PFC', n: true, get: (l) => l.pfc_ur, render: (l) => q(l.pfc_ur) },
  { id: 'pfc_qi', label: 'QI', grp: 'PFC', n: true, full: true, get: (l) => l.pfc_qi, render: (l) => q(l.pfc_qi) },
  { id: 'pfc_block', label: 'Block', grp: 'PFC', n: true, full: true, get: (l) => l.pfc_block, render: (l) => q(l.pfc_block) },
  { id: 'short', label: 'Short', grp: 'Balance − UR', n: true, get: (l) => shortBy(l), render: (l) => q(shortBy(l)) },
  { id: 'coverage', label: 'Coverage', full: true, get: (l) => coverage(l), render: (l) => <span className={`pill ${COV_PILL[coverage(l)]}`}>{coverage(l)}</span> },
  { id: 'stock_plant', label: 'Plant', grp: 'Stock at', full: true, get: (l) => l.stock_plant || '' },
  { id: 'stock_sloc', label: 'St Loc', grp: 'Stock at', full: true, get: (l) => l.stock_sloc || '' },
  { id: 'stock_link', label: 'For plant', grp: 'Stock at', full: true, get: (l) => l.stock_link || '' },
  { id: 'tn_qty', label: 'TN QTY', grp: 'TRR', n: true, get: (l) => l.tn_qty, render: (l) => q(l.tn_qty) },
  { id: 'tn_number', label: 'TN #', grp: 'TRR', get: (l) => l.tn_number || '' },
  { id: 'remarks', label: 'Remarks', get: (l) => l.remarks || '' },
  { id: 'plant', label: 'Plant', grp: 'Plan', full: true, get: (l) => l.plant || '' },
];

export interface LedgerProps {
  rows: Line[];
  canEdit: boolean;
  full: boolean;
  flash: Set<string>;
  /** `key` = lineRef(line): SO|LI|Item@date */
  onSave: (key: string, field: 'status' | 'comment' | 'vehicle', value: string) => Promise<void>;
  onEdit?: (l: Line) => void;
}

export default function Ledger({ rows, canEdit, full, flash, onSave, onEdit }: LedgerProps) {
  const [sort, setSort] = useState<{ id: string; dir: 1 | -1 }>({ id: 'priority', dir: -1 });
  const [limit, setLimit] = useState(250);
  useEffect(() => setLimit(250), [rows.length]);

  const cols = useMemo(() => COLS.filter((c) => full || !c.full), [full]);
  const sorted = useMemo(() => {
    const extra: Record<string, (l: Line) => string | number> = { status: (l) => l.status || '', comment: (l) => l.comment || '', vehicle: (l) => l.vehicle || '' };
    const c = COLS.find((x) => x.id === sort.id);
    const get = c?.get || extra[sort.id] || ((l: Line) => l.row_no);
    return [...rows].sort((a, b) => {
      const x = get(a), y = get(b);
      const r = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true });
      return r * sort.dir || a.row_no - b.row_no;
    });
  }, [rows, sort]);

  const head = (id: string, label: string, n?: boolean, grp?: string, cls = '') => (
    <th key={id} className={`${n ? 'n' : ''} ${cls}`} aria-sort={sort.id === id ? (sort.dir > 0 ? 'ascending' : 'descending') : 'none'}>
      <button type="button" onClick={() => setSort((s) => ({ id, dir: s.id === id ? (-s.dir as 1 | -1) : n ? -1 : 1 }))}>
        <span className="grp">{grp || ' '}</span>{label}{sort.id === id ? (sort.dir > 0 ? ' ↑' : ' ↓') : ''}
      </button>
    </th>
  );

  return (
    <>
      <div className="table-wrap">
        <table className="ledger">
          <thead>
            <tr>
              {head('status', 'Status', false, 'Tracking', 'first')}
              {cols.map((c) => head(c.id, c.label, c.n, c.grp))}
              {head('comment', 'Comment', false, 'Tracking')}
              {head('vehicle', 'Vehicle', false, 'Tracking')}
              <th><button type="button" tabIndex={-1}><span className="grp">&nbsp;</span>Updated</button></th>
              {canEdit && onEdit && <th><button type="button" tabIndex={-1}><span className="grp">&nbsp;</span>Edit</button></th>}
            </tr>
          </thead>
          <tbody>
            {sorted.slice(0, limit).map((l) => (
              <Row key={l.id ?? l.key + ':' + l.row_no} l={l} cols={cols} canEdit={canEdit} flash={flash.has(l.key)} onSave={onSave} onEdit={onEdit} />
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <div className="empty">No lines match these filters.</div>}
      </div>
      {sorted.length > limit && (
        <div className="more">
          Showing {limit.toLocaleString()} of {sorted.length.toLocaleString()} lines
          <button className="btn sm" onClick={() => setLimit(sorted.length)}>Show all</button>
        </div>
      )}
    </>
  );
}

const Row = memo(function Row({ l, cols, canEdit, flash, onSave, onEdit }: { l: Line; cols: Col[]; canEdit: boolean; flash: boolean; onSave: LedgerProps['onSave']; onEdit?: (l: Line) => void }) {
  const done = isDone(l);
  return (
    <tr className={`${done ? 'done' : ''} ${flash ? 'flash' : ''}`}>
      <td className="first">{isDispatched(l) && !l.status ? <span className="pill ok" title={`Dispatched ${fmtQty(l.dispatched ?? 0)} — complete from the dispatch upload`}>Dispatched ✓</span> : <EditCell value={l.status} field="status" k={lineRef(l)} canEdit={canEdit} onSave={onSave} list="status-options" />}</td>
      {cols.map((c) => {
        const v = c.get(l);
        const zero = c.n && typeof v === 'number' && Math.abs(v) < 0.0005;
        const neg = c.id === 'short' && typeof v === 'number' && v > 0.0005 && !done;
        return <td key={c.id} className={`${c.n ? 'n' : ''} ${zero ? 'z' : ''} ${neg ? 'neg' : ''} ${c.id === 'so' ? 'so mono' : c.id === 'item' ? 'mono' : ''}`}>{c.render ? c.render(l) : v}</td>;
      })}
      <td><EditCell value={l.comment} field="comment" k={lineRef(l)} canEdit={canEdit} onSave={onSave} /></td>
      <td><EditCell value={l.vehicle} field="vehicle" k={lineRef(l)} canEdit={canEdit} onSave={onSave} list="vehicle-options" /></td>
      <td className="muted" title={l.updated_at || ''}>{l.updated_by || ''}</td>
      {canEdit && onEdit && <td><button type="button" className="btn sm" onClick={() => onEdit(l)} aria-label={`Edit ${l.so} / ${l.li}`}>✎ Edit</button></td>}
    </tr>
  );
});

function EditCell({ value, field, k, canEdit, onSave, list }: { value: string | null; field: 'status' | 'comment' | 'vehicle'; k: string; canEdit: boolean; onSave: LedgerProps['onSave']; list?: string }) {
  const [v, setV] = useState(value || '');
  const [saving, setSaving] = useState(false);
  useEffect(() => setV(value || ''), [value]);
  const commit = async () => {
    if ((value || '') === v.trim()) return;
    setSaving(true);
    try { await onSave(k, field, v.trim()); } catch { setV(value || ''); } finally { setSaving(false); }
  };
  return (
    <input
      className={`edit ${saving ? 'saving' : ''}`}
      value={v}
      readOnly={!canEdit}
      list={list}
      aria-label={field}
      placeholder={canEdit ? '—' : ''}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { setV(value || ''); (e.target as HTMLInputElement).blur(); } }}
    />
  );
}
