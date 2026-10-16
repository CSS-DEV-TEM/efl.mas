'use client';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { fmtQty, type Line } from '@/lib/calc';
import { ACTION_HELP, action } from '@/lib/smart';

/**
 * Edit one plan line (QTY, date, plant, remarks + tracking fields), add a new one, or delete it.
 * Pass `line` to edit, or `week` only to add.
 */
export default function EditLine({ line, week, onClose, onSaved }: {
  line?: Line | null; week: string; onClose: () => void; onSaved: (msg: string) => void;
}) {
  const adding = !line;
  const [f, setF] = useState({
    so: line?.so ?? '', li: line?.li ?? '', item: line?.item ?? '', date: line?.date ?? '', qty: line ? String(Math.round(line.qty * 1000) / 1000) : '',
    plant: line?.plant ?? '', remarks: line?.remarks ?? '', status: line?.status ?? '', comment: line?.comment ?? '', vehicle: line?.vehicle ?? '',
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [confirmDel, setConfirmDel] = useState(false);
  const first = useRef<HTMLInputElement>(null);

  useEffect(() => {
    first.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setErr(''); setBusy(true);
    try {
      if (adding) {
        await api('/api/plan', { method: 'POST', body: { week, so: f.so, li: f.li, item: f.item, date: f.date || null, qty: f.qty, plant: f.plant, remarks: f.remarks } });
        if (f.status || f.comment || f.vehicle) {
          await api('/api/status', { method: 'PATCH', body: { key: `${f.so.trim().replace(/^0+/, '')}|${f.li.trim().replace(/^0+(?=\d)/, '')}|${f.item.trim().replace(/^0+/, '')}`, week, status: f.status || null, comment: f.comment || null, vehicle: f.vehicle || null } });
        }
        onSaved(`Added ${f.so} / ${f.li}`);
      } else {
        const planChanged = Math.abs(Number(f.qty) - line.qty) > 0.0005 || (f.date || null) !== (line.date || null) || (f.plant || '') !== (line.plant || '') || (f.remarks || '') !== (line.remarks || '');
        if (planChanged) await api(`/api/plan/${line.id}`, { method: 'PATCH', body: { qty: f.qty, date: f.date || null, plant: f.plant, remarks: f.remarks } });
        const st: Record<string, string | null> = {};
        if ((f.status || '') !== (line.status || '')) st.status = f.status || null;
        if ((f.comment || '') !== (line.comment || '')) st.comment = f.comment || null;
        if ((f.vehicle || '') !== (line.vehicle || '')) st.vehicle = f.vehicle || null;
        if (Object.keys(st).length) await api('/api/status', { method: 'PATCH', body: { key: line.key, week: line.week, ...st } });
        onSaved(planChanged || Object.keys(st).length ? `Saved ${line.so} / ${line.li}` : 'No changes');
      }
      onClose();
    } catch (e) { setErr(e instanceof Error ? e.message : 'Could not save.'); } finally { setBusy(false); }
  }

  async function del() {
    if (!line) return;
    setBusy(true); setErr('');
    try { await api(`/api/plan/${line.id}`, { method: 'DELETE' }); onSaved(`Deleted ${line.so} / ${line.li}`); onClose(); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Could not delete.'); } finally { setBusy(false); }
  }

  return (
    <div className="modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <form className="modal" role="dialog" aria-modal="true" aria-labelledby="edit-title" onSubmit={save}>
        <div className="modal-head">
          <div>
            <h2 id="edit-title">{adding ? `Add a line to Week ${Number(week.slice(-2))}` : `Edit ${line.so} / ${line.li}`}</h2>
            {!adding && <p className="sub" style={{ margin: 0 }}>Item {line.item} · {action(line)} — {ACTION_HELP[action(line)]} · UR {fmtQty(line.ur)}</p>}
          </div>
          <button type="button" className="btn sm" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <fieldset className="mgrid">
          <legend>Plan line</legend>
          <label>SO<input ref={adding ? first : undefined} value={f.so} onChange={set('so')} readOnly={!adding} required inputMode="numeric" /></label>
          <label>LI<input value={f.li} onChange={set('li')} readOnly={!adding} required inputMode="numeric" /></label>
          <label>Item code<input value={f.item} onChange={set('item')} readOnly={!adding} required inputMode="numeric" /></label>
          <label>Date<input type="date" value={f.date} onChange={set('date')} /></label>
          <label>QTY<input ref={adding ? undefined : first} type="number" step="any" min="0" value={f.qty} onChange={set('qty')} required /></label>
          <label>Plant<input value={f.plant} onChange={set('plant')} placeholder="e.g. C051" /></label>
          <label className="span2">Remarks<input value={f.remarks} onChange={set('remarks')} placeholder="e.g. 1st priority Last pallet" /></label>
        </fieldset>

        <fieldset className="mgrid">
          <legend>Tracking</legend>
          <label>Status<input list="status-options" value={f.status} onChange={set('status')} placeholder="Done, Pending…" /></label>
          <label>Vehicle<input value={f.vehicle} onChange={set('vehicle')} /></label>
          <label className="span2">Comment<input value={f.comment} onChange={set('comment')} /></label>
        </fieldset>

        {err && <div className="notice bad" role="alert">{err}</div>}
        {!adding && line.src_user && <p className="sub" style={{ margin: 0 }}>Last changed by {line.src_user}{line.updated_by ? ` · tracking by ${line.updated_by}` : ''}</p>}

        <div className="modal-foot">
          {!adding && (confirmDel
            ? <span className="del-confirm">Delete this line? <button type="button" className="btn sm danger" onClick={del} disabled={busy}>Yes, delete</button> <button type="button" className="btn sm" onClick={() => setConfirmDel(false)}>No</button></span>
            : <button type="button" className="btn danger" onClick={() => setConfirmDel(true)}>Delete line</button>)}
          <span style={{ flex: 1 }} />
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary" disabled={busy}>{busy ? 'Saving…' : adding ? 'Add line' : 'Save changes'}</button>
        </div>
      </form>
    </div>
  );
}
