'use client';
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '@/lib/api';
import { fmt, fmtQty, isDone, type Line } from '@/lib/calc';

type L = Line & { picked?: number; plan_type?: string };
/** The plan a status belongs to: the week for a week plan, the day for a day plan. */
const periodOf = (l: L) => (l.plan_type === 'day' && l.date ? l.date : l.week);

/**
 * "Complete": the user tells the system a plan line is finished, even when less or more than the plan QTY went
 * (the line counts as done everywhere). "Reopen" undoes it.
 */
export default function CompleteLine({ line, onDone, small = true }: { line: L; onDone: (msg: string) => void; small?: boolean }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const done = isDone(line);
  const sent = Number(line.picked ?? line.dispatched ?? 0);
  const diff = Math.round((sent - Number(line.qty)) * 1000) / 1000;
  const set = async (complete: boolean) => {
    setBusy(true); setErr('');
    try {
      const note = complete ? `Completed by hand: ${fmt(sent, 2)} of ${fmt(Number(line.qty), 2)}${Math.abs(diff) > 0.0005 ? ` (${diff > 0 ? '+' : ''}${fmt(diff, 2)})` : ''}` : null;
      await api('/api/status', { method: 'PATCH', body: { key: line.key, week: periodOf(line), date: line.date ?? null, status: complete ? 'Done' : null, ...(note ? { comment: [line.comment, note].filter(Boolean).join(' · ') } : {}) } });
      setOpen(false);
      onDone(complete ? `${line.so} / ${line.li} marked complete` : `${line.so} / ${line.li} reopened`);
    } catch (e) { setErr(e instanceof Error ? e.message : 'Could not save.'); } finally { setBusy(false); }
  };
  if (done && !/\bdone\b/i.test(line.status || '')) return null; // fully dispatched: complete already
  return (
    <>
      <button type="button" className={`btn ${small ? 'sm' : ''} ${done ? '' : 'complete-btn'}`} onClick={(e) => { e.stopPropagation(); if (done) set(false); else setOpen(true); }} disabled={busy}
        title={done ? 'Open the line again' : 'Tell the system this line is finished (also with less or more than the plan QTY)'}>
        {done ? 'Reopen' : 'Complete'}
      </button>
      {open && createPortal(
        <div className="modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="cl-title" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <div><h2 id="cl-title">Complete {line.so} / {line.li}</h2><p className="sub" style={{ margin: 0 }}>Item {line.item} · {line.plant || '–'}</p></div>
              <button type="button" className="btn sm" onClick={() => setOpen(false)} aria-label="Close">✕</button>
            </div>
            <div className="pk-stats">
              <div><span>Plan QTY</span><b>{fmtQty(line.qty)}</b></div>
              <div><span>Picked / dispatched</span><b>{fmtQty(sent)}</b></div>
              <div className={Math.abs(diff) <= 0.0005 ? 'ok' : diff > 0 ? 'warn' : 'short'}><span>{Math.abs(diff) <= 0.0005 ? 'Exact' : diff > 0 ? 'Over plan' : 'Short of plan'}</span><b>{Math.abs(diff) <= 0.0005 ? '✓' : fmt(Math.abs(diff), 2)}</b></div>
            </div>
            <p className="sub" style={{ margin: 0 }}>The line counts as complete on the dashboards and leaves the pending lists. A note is added to its Comment. You can reopen it later.</p>
            {err && <div className="notice bad">{err}</div>}
            <div className="modal-foot"><span style={{ flex: 1 }} /><button type="button" className="btn" onClick={() => setOpen(false)}>Cancel</button>
              <button type="button" className="btn primary" aria-busy={!!busy || undefined} disabled={busy} onClick={() => set(true)}>{busy ? 'Saving…' : 'Mark complete'}</button></div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
