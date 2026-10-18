'use client';
import { useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import { api } from '@/lib/api';
import { fmt, type Line } from '@/lib/calc';
import { SOLI_PER_HOUR, plantSummary, timeMinutes, type Bucket, type PlantInfo, type PlantRow, type TimeSetup } from '@/lib/summary';

const q = (n: number) => (Math.abs(n) < 0.0005 ? '' : fmt(n, 2));
const c = (n: number) => (n ? fmt(n) : '');

/** Plant-wise summary in the layout of the daily pull summary sheet. Click a plant to see its lines. */
/**
 * `week` is the period the received times belong to: the week (2026-W47), or the day for a day plan (2026-11-17).
 * Target times are system settings (admin only); received times are typed by the users.
 */
export default function PlantSummary({ rows, plants, received = [], week, day, canTarget, canEdit, time, onPlant, onSaved }: {
  rows: Line[]; plants: PlantInfo[]; received?: { code: string; received: string | null }[]; week: string; day?: string | null; canTarget: boolean; canEdit: boolean; time?: TimeSetup; onPlant: (code: string) => void; onSaved: (msg: string) => void;
}) {
  const s = useMemo(() => plantSummary(rows, plants, received, time), [rows, plants, received, time]);
  const saveTarget = async (code: string, v: string) => {
    const p = plants.find((x) => x.code.toUpperCase() === code) || { code, name: '', responsible: '', target: '', sort: 0 };
    await api('/api/plants', { method: 'POST', body: { plants: [{ ...p, target: v }] } });
    onSaved(`Target time for ${p.name || code} saved`);
  };
  const saveReceived = async (code: string, v: string) => {
    await api('/api/plants/received', { method: 'POST', body: { week, code, received: v } });
    onSaved(v ? `Received time for ${code} saved` : `Received time for ${code} back to the upload time`);
  };
  const [setup, setSetup] = useState(false);
  const pair = (b: Bucket, strong = false) => (<><td className={`n ${strong ? 'strong' : ''}`}>{q(b.qty)}</td><td className="n soli">{c(b.soli)}</td></>);
  const row = (r: PlantRow, isTotal = false) => (
    <tr key={r.code} className={isTotal ? 'total' : ''} onClick={isTotal ? undefined : () => onPlant(r.code)} title={isTotal ? '' : `Show ${r.name} lines`}>
      <td>{isTotal ? '' : r.responsible}</td>
      <td className="pname">{r.name}{!isTotal && r.name !== r.code && <small>{r.code}</small>}</td>
      <td onClick={(e) => e.stopPropagation()}>{isTotal ? '' : <TimeCell value={r.target} canEdit={canTarget} placeholder="10:00 AM" title="Target time (admin setting) — click to change" onSave={(v) => saveTarget(r.code, v)} weekly />}</td>
      <td onClick={(e) => e.stopPropagation()} className={r.late === true ? 'late' : r.late === false ? 'ontime' : ''}>{isTotal ? '' : <TimeCell value={r.receivedText} canEdit={canEdit} placeholder="9:48 AM" manual={r.receivedManual}
        title={r.receivedManual ? 'Typed on the dashboard — click to change, clear it to use the upload time' : r.received ? 'Plan upload time — click to type the real received time' : 'Click to type the received time'} onSave={(v) => saveReceived(r.code, v)} />}</td>
      {pair(r.plan)}{pair(r.ur, true)}
      <td className="n">{r.wh ? fmt(r.wh, 2) : isTotal ? '' : '–'}</td>
      {pair(r.qi)}{pair(r.block)}{pair(r.nih)}{pair(r.adhoc)}{pair(r.sameDay)}{pair(r.released)}{pair(r.dispatched)}
      <td className="n strong">{q(r.total) || (isTotal ? '' : '–')}</td>
      {pair(r.pending)}
    </tr>
  );
  const exportXlsx = () => {
    const head = ['Responsible', 'PLANT', 'Target time', 'Received time', 'Plan Qty', 'SOLI', 'UR', 'SOLI', 'W/H', 'QI', 'SOLI', 'BLOCK', 'SOLI', 'NIH', 'SOLI', 'Adhoc', 'SOLI', 'Same day', 'SOLI', 'Released to UR', 'SOLI', 'Dispatched', 'SOLI', 'Total qty', 'Pending', 'SOLI'];
    const line = (r: PlantRow) => [r.responsible, r.name, r.target, r.receivedText, r.plan.qty, r.plan.soli, r.ur.qty, r.ur.soli, Math.round(r.wh * 100) / 100, r.qi.qty, r.qi.soli, r.block.qty, r.block.soli, r.nih.qty, r.nih.soli, r.adhoc.qty, r.adhoc.soli, r.sameDay.qty, r.sameDay.soli, r.released.qty, r.released.soli, r.dispatched.qty, r.dispatched.soli, r.total, r.pending.qty, r.pending.soli]
      .map((v) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : v));
    const ws = XLSX.utils.aoa_to_sheet([head, ...s.rows.map(line), line(s.total)]);
    ws['!cols'] = head.map((h, i) => ({ wch: i < 4 ? 14 : Math.max(7, h.length + 2) }));
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Summary');
    XLSX.writeFile(wb, `Plant_Summary_${day || week}.xlsx`);
  };

  return (
    <section className="card psum-card" aria-labelledby="psum-title">
      <div className="table-head">
        <div>
          <h2 id="psum-title">Plant summary{day ? <span className="pill accent" style={{ marginLeft: 8, fontSize: 12 }}>Day plan · {day}</span> : ''}</h2>
          <p className="sub" style={{ margin: 0 }}>QTY still to send split by what covers it: UR → QI → Block → NIH (not in house). SOLI = SO/LI lines. W/H = UR SOLI ÷ {time?.soliPerHour || SOLI_PER_HOUR} per hour. Total = UR + Adhoc. Click a plant to see its lines.</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {canTarget && <button className="btn sm" onClick={() => setSetup(true)}>Plant settings</button>}
          <button className="btn sm" onClick={exportXlsx}>Export</button>
        </div>
      </div>
      <div className="psum-wrap">
        <table className="psum">
          <thead><tr>
            <th>Responsible</th><th>PLANT</th><th>Target time</th><th>Received time</th>
            <th className="n">Plan Qty</th><th className="n">SOLI</th><th className="n">UR</th><th className="n">SOLI</th><th className="n" title={`UR SOLI ÷ ${SOLI_PER_HOUR}`}>W/H</th>
            <th className="n">QI</th><th className="n">SOLI</th><th className="n">BLOCK</th><th className="n">SOLI</th><th className="n" title="Not in house: no UR, QI or Block stock for it">NIH</th><th className="n">SOLI</th>
            <th className="n" title='Lines with "adhoc" in Remarks or Comment'>Adhoc</th><th className="n">SOLI</th><th className="n" title="Lines dated the same day the plan was received">Same day</th><th className="n">SOLI</th>
            <th className="n rel" title="QI / Block released to UR">Released</th><th className="n rel">SOLI</th><th className="n disp">Dispatched</th><th className="n disp">SOLI</th>
            <th className="n">Total qty</th><th className="n pend">Pending</th><th className="n pend">SOLI</th>
          </tr></thead>
          <tbody>{s.rows.map((r) => row(r))}</tbody>
          <tfoot>{row(s.total, true)}</tfoot>
        </table>
      </div>
      <datalist id="target-opts"><option value="9:00 AM" /><option value="10:00 AM" /><option value="1:00 PM" /><option value="Weekly" /></datalist>
      {setup && <PlantSetup rows={rows} plants={plants} onClose={() => setSetup(false)} onSaved={(m) => { setSetup(false); onSaved(m); }} />}
    </section>
  );
}

export function PlantSetup({ rows, plants, onClose, onSaved }: { rows: Line[]; plants: PlantInfo[]; onClose: () => void; onSaved: (m: string) => void }) {
  const codes = Array.from(new Set([...plants.map((p) => p.code.toUpperCase()), ...rows.map((r) => (r.plant || '').toUpperCase()).filter(Boolean)]));
  const [list, setList] = useState<PlantInfo[]>(codes.map((code, i) => plants.find((p) => p.code.toUpperCase() === code) || { code, name: '', responsible: '', target: '', sort: i + 1 }));
  const [removed, setRemoved] = useState<string[]>([]);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const set = (i: number, k: keyof PlantInfo, v: string) => setList((l) => l.map((p, j) => (j === i ? { ...p, [k]: k === 'sort' ? Number(v) : v } : p)));
  const save = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('');
    try { await api('/api/plants', { method: 'POST', body: { plants: list.filter((p) => p.code.trim()), remove: removed } }); onSaved('Plant settings saved'); }
    catch (x) { setErr(x instanceof Error ? x.message : 'Could not save.'); } finally { setBusy(false); }
  };
  return (
    <div className="modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <form className="modal wide" role="dialog" aria-modal="true" aria-labelledby="ps-title" onSubmit={save}>
        <div className="modal-head">
          <div><h2 id="ps-title">Plant settings</h2><p className="sub" style={{ margin: 0 }}>Plant code from the plan → the name shown in the summary, who is responsible and the target time (e.g. 10:00 AM, or Weekly). A plan received after the target time shows red.</p></div>
          <button type="button" className="btn sm" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="ps-grid">
          <span>Plant code</span><span>Name</span><span>Responsible</span><span>Target time</span><span>Order</span><span />
          {list.map((p, i) => (
            <div key={i} className="ps-row">
              <input aria-label="Plant code" value={p.code} onChange={(e) => set(i, 'code', e.target.value.toUpperCase())} placeholder="C064" required />
              <input aria-label="Name" value={p.name || ''} onChange={(e) => set(i, 'name', e.target.value)} placeholder="SHADELINE" />
              <input aria-label="Responsible" value={p.responsible || ''} onChange={(e) => set(i, 'responsible', e.target.value)} placeholder="Sasmitha" />
              <input aria-label="Target time" value={p.target || ''} onChange={(e) => set(i, 'target', e.target.value)} placeholder="10:00 AM" list="target-opts" />
              <input aria-label="Order" type="number" value={p.sort ?? ''} onChange={(e) => set(i, 'sort', e.target.value)} />
              <button type="button" className="btn sm" aria-label="Remove" onClick={() => { setRemoved((r) => [...r, p.code]); setList((l) => l.filter((_, j) => j !== i)); }}>✕</button>
            </div>
          ))}
        </div>
        <button type="button" className="btn sm" style={{ justifySelf: 'start' }} onClick={() => setList((l) => [...l, { code: '', name: '', responsible: '', target: '', sort: l.length + 1 }])}>+ Add plant</button>
        {err && <div className="notice bad">{err}</div>}
        <div className="modal-foot"><span /><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button></div>
      </form>
    </div>
  );
}

/** A time cell in the summary: click to type (e.g. 9:48 AM), Enter or leaving the box saves, Esc cancels. */
function TimeCell({ value, canEdit, placeholder, title, onSave, weekly, manual }: { value: string; canEdit: boolean; placeholder: string; title: string; onSave: (v: string) => Promise<void>; weekly?: boolean; manual?: boolean }) {
  const [edit, setEdit] = useState(false);
  const [v, setV] = useState(value);
  const [busy, setBusy] = useState(false);
  const [bad, setBad] = useState(false);
  if (!canEdit) return <>{value}</>;
  if (!edit) return <button type="button" className={`tcell ${manual ? 'manual' : ''}`} title={title} onClick={() => { setV(value); setBad(false); setEdit(true); }}>{value || <span className="ph">+ add</span>}</button>;
  const done = async () => {
    const t = v.trim();
    if (t === value) { setEdit(false); return; }
    if (t && timeMinutes(t) === null && !(weekly && /^weekly$/i.test(t))) { setBad(true); return; }
    setBusy(true);
    try { await onSave(normTime(t)); setEdit(false); } catch { setBad(true); } finally { setBusy(false); }
  };
  return <input className={`tcell-in ${bad ? 'bad' : ''}`} autoFocus value={v} disabled={busy} placeholder={placeholder} list={weekly ? 'target-opts' : undefined}
    title={bad ? 'Use a time like 9:48 AM or 13:00' + (weekly ? ', or Weekly' : '') : ''}
    onChange={(e) => { setV(e.target.value); setBad(false); }} onBlur={done}
    onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setEdit(false); }} />;
}
/** "948am" style is not accepted; "9:48 am", "09.48", "21:30" → "9:48 AM" / "9:30 PM". */
function normTime(t: string) {
  const m = timeMinutes(t);
  if (m === null) return t.replace(/^weekly$/i, 'Weekly');
  const h = Math.floor(m / 60), mi = m % 60;
  return `${((h + 11) % 12) + 1}:${String(mi).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}
