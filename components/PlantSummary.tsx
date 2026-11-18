'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import { api } from '@/lib/api';
import { fmt, type Line } from '@/lib/calc';
import type { DashKpi } from '@/components/Dashboard';
import { SOLI_PER_HOUR, fmtTime, plantSummary, timeMinutes, type Bucket, type PlantInfo, type PlantRow, type TimeSetup } from '@/lib/summary';

const q = (n: number) => (Math.abs(n) < 0.0005 ? '' : fmt(n, 2));
const c = (n: number) => (n ? fmt(n) : '');
/** dd-mm-yyyy of a time, in Sri Lanka time (UTC+05:30) */
const pickDay = (iso: string) => { const d = new Date(new Date(iso).getTime() + 330 * 60000).toISOString().slice(0, 10); return `${d.slice(8, 10)}-${d.slice(5, 7)}-${d.slice(0, 4)}`; };

/** Plant-wise summary in the layout of the daily pull summary sheet. Click a plant to see its lines. */
/**
 * `week` is the period the received times belong to: the week (2026-W47), or the day for a day plan (2026-11-17).
 * Target times are system settings (admin only); received times are typed by the users.
 */
export default function PlantSummary({ rows, plants, received = [], week, day, canTarget, canEdit, time, onPlant, onSaved, live, updatedAt, byRound = false, kpi }: {
  rows: Line[]; plants: PlantInfo[]; received?: { code: string; received: string | null; period?: string }[];
  /** a day plan: a row per plant per Pick No */
  byRound?: boolean; week: string; day?: string | null; canTarget: boolean; canEdit: boolean; time?: TimeSetup; onPlant: (code: string) => void; onSaved: (msg: string) => void;
  /** realtime connected (updates the moment someone picks / uploads) or not (updates when the page is used, and every minute) */
  live?: boolean; updatedAt?: string;
  /** v200: the Dashboard's figures of a row's lines (Plan UR, KFC / PFC UR, Alrady send, TN, Posibal pending, rolls, coverage) */
  kpi?: (ls: Line[]) => DashKpi;
}) {
  const s = useMemo(() => plantSummary(rows, plants, received, time, byRound), [rows, plants, received, time, byRound]);
  // v200: the Dashboard figures of each row (and of the Summary row), worked out the same way as the Dashboard tiles
  const kp = useMemo(() => (kpi ? new Map([...s.rows, s.total].map((r) => [r.code, kpi(r.lines)])) : null), [s, kpi]);
  const K = (r: PlantRow) => kp?.get(r.code);
  const covPct = (k?: DashKpi) => (k && k.t.lines ? Math.round((k.t.cov.Covered / k.t.lines) * 100) : null);
  // cells whose figure changed since the last update flash for a moment, so a live change is seen
  const prev = useRef<Map<string, number> | null>(null);
  const [changed, setChanged] = useState<Set<string>>(new Set());
  useEffect(() => {
    const now = new Map<string, number>();
    for (const r of [...s.rows, s.total]) {
      for (const k of ['plan', 'ur', 'qi', 'block', 'nih', 'adhoc', 'sameDay', 'picked', 'released', 'dispatched', 'pending'] as const) { now.set(`${r.code}:${k}`, Math.round(r[k].qty * 1000)); now.set(`${r.code}:${k}#`, r[k].soli); }
      now.set(`${r.code}:progress`, Math.round(r.progress * 1000)); now.set(`${r.code}:done`, r.doneSoli);
    }
    const before = prev.current; prev.current = now;
    if (!before) return;
    const diff = new Set(Array.from(now.entries()).filter(([k, v]) => before.has(k) && before.get(k) !== v).map(([k]) => k));
    if (!diff.size) return;
    setChanged(diff);
    const t = setTimeout(() => setChanged(new Set()), 2600);
    return () => clearTimeout(t);
  }, [s]);
  const saveTarget = async (code: string, v: string) => {
    const p = plants.find((x) => x.code.toUpperCase() === code) || { code, name: '', responsible: '', target: '', sort: 0 };
    await api('/api/plants', { method: 'POST', body: { plants: [{ ...p, target: v }] } });
    onSaved(`Target time for ${p.name || code} saved`);
  };
  const saveReceived = async (code: string, v: string, period?: string) => {
    await api('/api/plants/received', { method: 'POST', body: { week: period || week, code, received: v } });
    onSaved(v ? `Received time for ${code} saved` : `Received time for ${code} back to the upload time`);
  };
  const [setup, setSetup] = useState(false);
  const fl = (code: string, k: string) => (changed.has(`${code}:${k}`) ? ' flash-cell' : '');
  // v201: the columns are the Dashboard cards — each card's name over its figures, worked out the same way as the card
  type Cell = { v: number | string | null; k?: 'q' | 'n' | 'p'; cls?: string; title?: string };
  const COLS: { card: string; tip: string; subs: { h: string; get: (k: DashKpi, r: PlantRow) => Cell }[] }[] = [
    { card: 'Plan lines', tip: 'SO / LI lines of the plan', subs: [
      { h: 'Lines', get: (k) => ({ v: k.t.lines, k: 'n', cls: 'strong' }) }, { h: 'Done', get: (k) => ({ v: k.t.done, k: 'n' }) }, { h: 'Open', get: (k) => ({ v: k.t.open, k: 'n' }) }] },
    { card: 'Required QTY', tip: 'Plan QTY (variance = QTY − Assigned)', subs: [
      { h: 'QTY', get: (k) => ({ v: k.t.qty, k: 'q', cls: 'strong' }) }, { h: 'Variance', get: (k) => ({ v: k.t.variance, k: 'q' }) }] },
    { card: 'Full UR stock', tip: 'In the warehouse (not at the plant storage locations 40 / 70 / 75)', subs: [
      { h: 'UR', get: (k) => ({ v: k.t.ur, k: 'q', cls: 'strong' }) }, { h: 'QI', get: (k) => ({ v: k.t.qi, k: 'q' }) }, { h: 'Block', get: (k) => ({ v: k.t.block, k: 'q' }) }] },
    { card: 'KFC / PFC UR', tip: 'UR at the KFC and PFC storage locations', subs: [
      { h: 'KFC', get: (k) => ({ v: k.t.kfc_ur, k: 'q' }) }, { h: 'PFC', get: (k) => ({ v: k.t.pfc_ur, k: 'q' }) }] },
    // v202: Plan UR and Dispatched in one place — what the UR covers of the plan, what is dispatched of it, and what is left
    { card: 'Plan UR · Dispatched', tip: "Plan UR: each line's QTY, at most its UR (Total − QI − Block − Assigned) · Dispatched: QTY dispatched and lines complete · Balance: Plan UR − Dispatched", subs: [
      { h: 'Plan UR', get: (k) => ({ v: k.planUr.v, k: 'q', cls: 'strong' }) }, { h: 'Lines short', get: (k) => ({ v: k.planUr.short, k: 'n', cls: k.planUr.short ? 'warn-t' : '' }) },
      { h: 'Dispatched', get: (k) => ({ v: k.t.dispatched, k: 'q', cls: 'strong' }) }, { h: 'Lines', get: (k) => ({ v: k.t.dispatchedLines, k: 'n' }) },
      { h: 'Balance', get: (k) => ({ v: Math.max(0, k.planUr.v - k.t.dispatched), k: 'q' }) }] },
    { card: 'Transfer notes', tip: 'ZMM_TRR transfer requests of these SO lines', subs: [
      { h: 'TN', get: (k) => ({ v: k.rep?.tnCount ?? null, k: 'n' }) }, { h: 'SO/LI', get: (k) => ({ v: k.rep?.tnLines ?? null, k: 'n' }) },
      { h: 'QTY', get: (k) => ({ v: k.rep?.tnQty ?? null, k: 'q' }) }, { h: 'TN-UR', get: (k) => ({ v: k.rep?.tnUr ?? null, k: 'q' }) }] },
    { card: 'Alrady send', tip: 'ZMMBE at the plant storage locations (40 / 70 / 75)', subs: [
      { h: 'QTY', get: (k) => ({ v: k.rep?.sent ?? null, k: 'q' }) }, { h: 'SO/LI', get: (k) => ({ v: k.rep?.sentN ?? null, k: 'n' }) }] },
    { card: 'QI', tip: 'SO QI stock (ZMMBE, every storage location) — not picked until released', subs: [
      { h: 'QTY', get: (k) => ({ v: k.rep?.qi ?? null, k: 'q', cls: k.rep?.qiN ? 'warn-t' : '' }) }, { h: 'SO/LI', get: (k) => ({ v: k.rep?.qiN ?? null, k: 'n' }) }] },
    { card: 'Block', tip: 'SO Blocked stock (ZMMBE, every storage location) — not picked until released', subs: [
      { h: 'QTY', get: (k) => ({ v: k.rep?.block ?? null, k: 'q', cls: k.rep?.blockN ? 'bad-t' : '' }) }, { h: 'SO/LI', get: (k) => ({ v: k.rep?.blockN ?? null, k: 'n' }) }] },
    { card: 'Posibal pending', tip: 'Lines the warehouse can send now (plan report)', subs: [
      { h: 'QTY', get: (k) => ({ v: k.rep?.possible ?? null, k: 'q', cls: 'strong' }) }, { h: 'Lines', get: (k) => ({ v: k.rep?.possibleN ?? null, k: 'n' }) }] },
    { card: 'PL rolls', tip: 'Rolls on the Packing List of these lines (a pallet picked in pieces counts once)', subs: [
      { h: 'Rolls', get: (k) => ({ v: k.rolls.rolls, k: 'n' }) }, { h: 'QTY', get: (k) => ({ v: k.rolls.qty, k: 'q' }) }] },
    { card: 'Cut rolls', tip: 'Rolls picked for less than the whole roll', subs: [
      { h: 'Rolls', get: (k) => ({ v: k.rolls.cut, k: 'n', cls: k.rolls.cut ? 'warn-t' : '' }) }, { h: 'QTY', get: (k) => ({ v: k.rolls.cutQty, k: 'q' }) }] },
    { card: 'Picked', tip: 'Saved picks of these lines', subs: [
      { h: 'QTY', get: (k) => ({ v: k.picked.qty, k: 'q', cls: 'strong' }) }, { h: 'SO/LI', get: (k) => ({ v: k.picked.lines, k: 'n' }) }, { h: 'Rolls', get: (k) => ({ v: k.rolls.rolls, k: 'n' }) }] },
    { card: 'Open & short of UR', tip: 'Open lines whose QTY is more than the Full UR', subs: [
      { h: 'Lines', get: (k) => ({ v: k.t.shortLines, k: 'n', cls: k.t.shortLines ? 'bad-t' : '' }) }, { h: 'QTY', get: (k) => ({ v: k.t.short, k: 'q' }) }] },
    { card: 'Stock coverage', tip: 'Lines with UR ≥ QTY', subs: [
      { h: '%', get: (k) => ({ v: k.t.lines ? Math.round((k.t.cov.Covered / k.t.lines) * 100) : null, k: 'p' }) }] },
  ];
  const show = (x: Cell) => (x.v === null || x.v === '' ? '' : x.k === 'q' ? q(Number(x.v)) : x.k === 'p' ? `${x.v}%` : typeof x.v === 'number' ? c(x.v) : String(x.v));
  const row = (r: PlantRow, isTotal = false) => {
    const k = K(r);
    return (
      <tr key={r.code} className={isTotal ? 'total' : ''} onClick={isTotal ? undefined : () => onPlant(r.plantCode)} title={isTotal ? '' : `Show ${r.name} lines`}>
        <td>{isTotal ? '' : r.responsible}</td>
        <td className="pname">{r.name}{!isTotal && !r.name.startsWith(r.plantCode) && <small>{r.plantCode}</small>}</td>
        {COLS.map((g, gi) => g.subs.map((sub, si) => { const cl = k ? sub.get(k, r) : { v: null }; return <td key={`${gi}.${si}`} className={`n ${si === 0 ? 'g0' : ''} ${cl.cls || ''}${fl(r.code, g.card + sub.h)}`}>{show(cl)}</td>; }))}
      </tr>
    );
  };
  const exportXlsx = () => {
    const head1 = ['', '', ...COLS.flatMap((g) => g.subs.map((_, i) => (i === 0 ? g.card : '')))];
    const head2 = ['Responsible', 'PLANT', ...COLS.flatMap((g) => g.subs.map((x) => x.h))];
    const line = (r: PlantRow) => { const k = K(r); return [r.responsible, r.name, ...COLS.flatMap((g) => g.subs.map((x) => { const v = k ? x.get(k, r).v : null; return typeof v === 'number' ? Math.round(v * 1000) / 1000 : v ?? ''; }))]; };
    const ws = XLSX.utils.aoa_to_sheet([head1, head2, ...s.rows.map(line), line(s.total)]);
    let at = 2; ws['!merges'] = COLS.map((g) => { const m = { s: { r: 0, c: at }, e: { r: 0, c: at + g.subs.length - 1 } }; at += g.subs.length; return m; });
    ws['!cols'] = head2.map((h, i) => ({ wch: i < 2 ? 22 : Math.max(9, h.length + 3) }));
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Summary');
    XLSX.writeFile(wb, `Plant_Summary_${day || week}.xlsx`);
  };

  return (
    <section className="card psum-card" aria-labelledby="psum-title">
      <div className="table-head">
        <div>
          <h2 id="psum-title">Plant summary{day ? <span className="pill accent" style={{ marginLeft: 8, fontSize: 12 }}>Day plan · {day}</span> : ''}
            <span className={`psum-live ${live ? 'on' : ''}`} title={live ? 'Updates the moment someone picks, uploads or changes a line' : 'Updates when you use the page and every minute'}><i />{live ? 'Live' : 'Auto'}{updatedAt ? ` · ${fmtTime(updatedAt)}` : ''}</span></h2>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {canTarget && <button className="btn sm" onClick={() => setSetup(true)}>Plant settings</button>}
          <button className="btn sm" onClick={exportXlsx}>Export</button>
        </div>
      </div>
      <div className="psum-wrap">
        <table className="psum psum-cards">
          <thead>
            <tr className="grp"><th rowSpan={2}>Responsible</th><th rowSpan={2}>PLANT</th>
              {COLS.map((g) => <th key={g.card} colSpan={g.subs.length} className="g0" title={g.tip} data-nofilter>{g.card}</th>)}</tr>
            <tr className="sub">{COLS.flatMap((g) => g.subs.map((x, i) => <th key={g.card + x.h} className={`n ${i === 0 ? 'g0' : ''}`} data-nofilter>{x.h}</th>))}</tr>
          </thead>
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
        <div className="modal-foot"><span /><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary" aria-busy={!!busy || undefined} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button></div>
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
