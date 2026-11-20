'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import { api } from '@/lib/api';
import { fmt, type Line } from '@/lib/calc';
import type { DashKpi } from '@/components/Dashboard';
import { BAL_CATS, catLabel, type BalCat, type RepickData } from '@/lib/repick';
import PlanFlow from '@/components/PlanFlow';
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
export default function PlantSummary({ rows, plants, received = [], week, day, canTarget, canEdit, time, onPlant, onSaved, live, updatedAt, byRound = false, kpi, onRepick, repick, toast }: {
  rows: Line[]; plants: PlantInfo[]; received?: { code: string; received: string | null; period?: string }[];
  /** a day plan: a row per plant per Pick No */
  byRound?: boolean; week: string; day?: string | null; canTarget: boolean; canEdit: boolean; time?: TimeSetup; onPlant: (code: string) => void; onSaved: (msg: string) => void;
  /** realtime connected (updates the moment someone picks / uploads) or not (updates when the page is used, and every minute) */
  live?: boolean; updatedAt?: string;
  /** v200: the Dashboard's figures of a row's lines (Plan UR, KFC / PFC UR, Alrady send, TN, Posibal pending, rolls, coverage) */
  kpi?: (ls: Line[]) => DashKpi;
  /** v203: a balance was completed / reopened (the re-pick data is read again) */
  onRepick?: () => void;
  /** v212: the re-pick data (runs, uploads, Pick IDs) — a card click opens the plan flow */
  repick?: RepickData; toast?: (m: string) => void;
}) {
  const [flowRow, setFlowRow] = useState<PlantRow | null>(null);
  const uidsOf = (ls: Line[]) => (repick ? Array.from(new Set(ls.map((l) => l.week))).map((w) => repick.uids.find((u) => u.rid === w)?.uid).filter(Boolean) as string[] : []);
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
  // v211: Simple (cards with the few figures that matter) or All columns (the full table) — remembered on this device
  const [view, setView] = useState<'simple' | 'full'>('simple');
  useEffect(() => { try { const v = localStorage.getItem('psum-view'); if (v === 'full' || v === 'simple') setView(v); } catch { /* default */ } }, []);
  const pickView = (v: 'simple' | 'full') => { setView(v); try { localStorage.setItem('psum-view', v); } catch { /* only a convenience */ } };
  // v203: complete the balance of a row by hand — Block / QI / Dispatched / Shortage (the balance goes to that category, the row's balance becomes 0)
  const [done, setDone] = useState<{ r: PlantRow; k: DashKpi } | null>(null);
  const [doneCat, setDoneCat] = useState<BalCat | ''>('');
  const [doneBusy, setDoneBusy] = useState(false);
  const byRid = <T extends { l: Line }>(xs: T[]) => { const m = new Map<string, T[]>(); for (const x of xs) m.set(x.l.week, [...(m.get(x.l.week) || []), x]); return m; };
  const complete = async () => {
    if (!done || !doneCat) return;
    setDoneBusy(true);
    try {
      const groups = byRid(done.k.rp.open);
      for (const [rid, xs] of Array.from(groups.entries())) await api('/api/repick', { method: 'POST', body: { action: 'close', rid, cat: doneCat, lines: xs.map((x) => ({ key: x.l.key, date: x.l.date ?? '', qty: Math.round(x.bal * 1000) / 1000, plant: x.l.plant ?? null })) } });
      onSaved(`${done.r.name}: balance ${fmt(done.k.rp.balance, 2)} of ${done.k.rp.open.length} line${done.k.rp.open.length === 1 ? '' : 's'} completed as ${catLabel(doneCat)}`);
      setDone(null); setDoneCat(''); onRepick?.();
    } catch (e) { onSaved(e instanceof Error ? e.message : 'Could not complete the balance.'); }
    finally { setDoneBusy(false); }
  };
  const reopen = async (r: PlantRow, k: DashKpi) => {
    if (!window.confirm(`${r.name}: open the completed balance of ${k.rp.closedN} line${k.rp.closedN === 1 ? '' : 's'} again (${fmt(k.rp.closedQty, 2)})?`)) return;
    try {
      const groups = byRid(k.rp.closedLines.map((l) => ({ l })));
      for (const [rid, xs] of Array.from(groups.entries())) await api('/api/repick', { method: 'POST', body: { action: 'reopen', rid, lines: xs.map((x) => ({ key: x.l.key, date: x.l.date ?? '' })) } });
      onSaved(`${r.name}: completed balance opened again`); onRepick?.();
    } catch (e) { onSaved(e instanceof Error ? e.message : 'Could not undo.'); }
  };
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
    { card: 'Plan UR · Dispatched', tip: "Plan UR: each line's QTY, at most what its UR covers — picked / dispatched + UR left (a pick does not lower it) · Dispatched: QTY dispatched and lines complete · Plan UR balance: Plan UR − Dispatched · Balance: Plan QTY − Dispatched", subs: [
      { h: 'Plan UR', get: (k) => ({ v: k.planUr.v, k: 'q', cls: 'strong' }) }, { h: 'Lines short', get: (k) => ({ v: k.planUr.short, k: 'n', cls: k.planUr.short ? 'warn-t' : '' }) },
      { h: 'Dispatched', get: (k) => ({ v: k.t.dispatched + k.rp.closed.dispatched, k: 'q', cls: 'strong', title: k.rp.closed.dispatched ? `incl. ${fmt(k.rp.closed.dispatched, 2)} completed by hand` : undefined }) }, { h: 'Lines', get: (k) => ({ v: k.t.dispatchedLines, k: 'n' }) },
      // v203: the balance of each open line (plan QTY − dispatched); a line completed by hand is 0 (its balance is in the category chosen)
      // v209: what the Plan UR still has to send — each line's Plan UR − dispatched (a line completed by hand is 0)
      { h: 'Plan UR balance', get: (k) => ({ v: k.rp.urBalance, k: 'q', cls: 'strong', title: `Plan UR − Dispatched, line by line · ${k.rp.urBalLines} line${k.rp.urBalLines === 1 ? '' : 's'} with a balance` }) },
      { h: 'Balance', get: (k) => ({ v: k.rp.balance, k: 'q', cls: 'strong', title: 'Plan QTY − Dispatched (the balance Complete closes)' }) },
      { h: 'Completed', get: (k) => ({ v: k.rp.closedQty || null, k: 'q', cls: k.rp.closedN ? 'done-t' : '', title: k.rp.closedN ? `${k.rp.closedN} line${k.rp.closedN === 1 ? '' : 's'} completed by hand — ${BAL_CATS.filter((x) => k.rp.closed[x.v] > 1e-9).map((x) => `${x.label} ${fmt(k.rp.closed[x.v], 2)}`).join(' · ')}` : undefined }) }] },
    // v203: the first Pick all matched kept each line's UR / QI / Block; what the reports uploaded since then add, and what can be picked again
    { card: 'First UR · Re-pick', tip: 'First UR / QI / Block: as at the first Pick all matched of the Pick · New UR: UR uploaded since then · QI / Block released: since then · Re-pick: open balance, at most the UR left · Runs: Pick all matched runs (2+ = balance picks)', subs: [
      { h: 'First UR', get: (k) => ({ v: k.rp.based ? k.rp.firstUr : null, k: 'q', cls: 'strong' }) },
      { h: 'First QI', get: (k) => ({ v: k.rp.based ? k.rp.firstQi : null, k: 'q' }) },
      { h: 'First Block', get: (k) => ({ v: k.rp.based ? k.rp.firstBlock : null, k: 'q' }) },
      { h: 'New UR', get: (k) => ({ v: k.rp.based ? k.rp.newUr : null, k: 'q', cls: k.rp.newUr > 1e-9 ? 'ok-t' : '' }) },
      { h: 'QI released', get: (k) => ({ v: k.rp.based ? k.rp.qiRel : null, k: 'q' }) },
      { h: 'Block released', get: (k) => ({ v: k.rp.based ? k.rp.blockRel : null, k: 'q' }) },
      { h: 'Re-pick lines', get: (k) => ({ v: k.rp.based ? k.rp.reLines : null, k: 'n', cls: k.rp.reLines ? 'ok-t' : '' }) },
      { h: 'Re-pick QTY', get: (k) => ({ v: k.rp.based ? k.rp.reQty : null, k: 'q', cls: k.rp.reQty > 1e-9 ? 'ok-t strong' : '' }) },
      { h: 'Runs', get: (k) => ({ v: k.rp.runs || null, k: 'n', title: k.rp.runs > 1 ? `1st pick + ${k.rp.runs - 1} balance pick${k.rp.runs === 2 ? '' : 's'}` : undefined }) }] },
    { card: 'Transfer notes', tip: 'ZMM_TRR transfer requests of these SO lines', subs: [
      { h: 'TN', get: (k) => ({ v: k.rep?.tnCount ?? null, k: 'n' }) }, { h: 'SO/LI', get: (k) => ({ v: k.rep?.tnLines ?? null, k: 'n' }) },
      { h: 'QTY', get: (k) => ({ v: k.rep?.tnQty ?? null, k: 'q' }) }, { h: 'TN-UR', get: (k) => ({ v: k.rep?.tnUr ?? null, k: 'q' }) }] },
    { card: 'Alrady send', tip: 'ZMMBE at the plant storage locations (40 / 70 / 75)', subs: [
      { h: 'QTY', get: (k) => ({ v: k.rep?.sent ?? null, k: 'q' }) }, { h: 'SO/LI', get: (k) => ({ v: k.rep?.sentN ?? null, k: 'n' }) }] },
    { card: 'QI', tip: 'SO QI stock (ZMMBE, every storage location) — not picked until released', subs: [
      { h: 'QTY', get: (k) => ({ v: k.rep || k.rp.closed.qi ? (k.rep?.qi ?? 0) + k.rp.closed.qi : null, k: 'q', cls: k.rep?.qiN || k.rp.closed.qi ? 'warn-t' : '', title: k.rp.closed.qi ? `incl. ${fmt(k.rp.closed.qi, 2)} completed by hand` : undefined }) }, { h: 'SO/LI', get: (k) => ({ v: k.rep?.qiN ?? null, k: 'n' }) }] },
    { card: 'Block', tip: 'SO Blocked stock (ZMMBE, every storage location) — not picked until released', subs: [
      { h: 'QTY', get: (k) => ({ v: k.rep || k.rp.closed.block ? (k.rep?.block ?? 0) + k.rp.closed.block : null, k: 'q', cls: k.rep?.blockN || k.rp.closed.block ? 'bad-t' : '', title: k.rp.closed.block ? `incl. ${fmt(k.rp.closed.block, 2)} completed by hand` : undefined }) }, { h: 'SO/LI', get: (k) => ({ v: k.rep?.blockN ?? null, k: 'n' }) }] },
    { card: 'Posibal pending', tip: 'Lines the warehouse can send now (plan report)', subs: [
      { h: 'QTY', get: (k) => ({ v: k.rep?.possible ?? null, k: 'q', cls: 'strong' }) }, { h: 'Lines', get: (k) => ({ v: k.rep?.possibleN ?? null, k: 'n' }) }] },
    { card: 'PL rolls', tip: 'Rolls on the Packing List of these lines (a pallet picked in pieces counts once)', subs: [
      { h: 'Rolls', get: (k) => ({ v: k.rolls.rolls, k: 'n' }) }, { h: 'QTY', get: (k) => ({ v: k.rolls.qty, k: 'q' }) }] },
    { card: 'Cut rolls', tip: 'Rolls picked for less than the whole roll', subs: [
      { h: 'Rolls', get: (k) => ({ v: k.rolls.cut, k: 'n', cls: k.rolls.cut ? 'warn-t' : '' }) }, { h: 'QTY', get: (k) => ({ v: k.rolls.cutQty, k: 'q' }) }] },
    { card: 'Picked', tip: 'Saved picks of these lines', subs: [
      { h: 'QTY', get: (k) => ({ v: k.picked.qty, k: 'q', cls: 'strong' }) }, { h: 'SO/LI', get: (k) => ({ v: k.picked.lines, k: 'n' }) }, { h: 'Rolls', get: (k) => ({ v: k.rolls.rolls, k: 'n' }) }] },
    { card: 'Open & short of UR', tip: 'Open lines whose QTY is more than the Full UR', subs: [
      { h: 'Lines', get: (k) => ({ v: k.t.shortLines, k: 'n', cls: k.t.shortLines ? 'bad-t' : '' }) }, { h: 'QTY', get: (k) => ({ v: k.t.short + k.rp.closed.shortage, k: 'q', title: k.rp.closed.shortage ? `incl. ${fmt(k.rp.closed.shortage, 2)} completed by hand (Shortage)` : undefined }) }] },
    { card: 'Stock coverage', tip: 'Lines with UR ≥ QTY', subs: [
      { h: '%', get: (k) => ({ v: k.t.lines ? Math.round((k.t.cov.Covered / k.t.lines) * 100) : null, k: 'p' }) }] },
  ];
  const show = (x: Cell) => (x.v === null || x.v === '' ? '' : x.k === 'q' ? q(Number(x.v)) : x.k === 'p' ? `${x.v}%` : typeof x.v === 'number' ? c(x.v) : String(x.v));
  const row = (r: PlantRow, isTotal = false) => {
    const k = K(r);
    return (
      <tr key={r.code} className={isTotal ? 'total' : ''} onClick={isTotal ? undefined : () => onPlant(r.plantCode)} title={isTotal ? '' : `Show ${r.name} lines`}>
        <td className="fz1">{isTotal ? '' : r.responsible}</td>
        <td className="pname fz2">{r.name}{!isTotal && !r.name.startsWith(r.plantCode) && <small>{r.plantCode}</small>}{!isTotal && k && k.rp.jobs.length > 0 && <small className="psum-job">JOB {k.rp.jobs.join(', ')}</small>}</td>
        {COLS.map((g, gi) => g.subs.map((sub, si) => { const cl = k ? sub.get(k, r) : { v: null }; return <td key={`${gi}.${si}`} className={`n ${si === 0 ? 'g0' : ''} ${cl.cls || ''}${fl(r.code, g.card + sub.h)}`} title={cl.title}>{show(cl)}</td>; }))}
        {kpi && <td className="g0 psum-act">{!isTotal && k && canEdit && <>
          {k.rp.open.length > 0 && <button type="button" className="btn sm" onClick={(e) => { e.stopPropagation(); setDone({ r, k }); }} title="Complete the balance of this row by hand: Block, QI, Dispatched or Shortage">✓ Complete</button>}
          {k.rp.closedN > 0 && <button type="button" className="btn sm" onClick={(e) => { e.stopPropagation(); void reopen(r, k); }} title="Undo: the completed balance of this row is open again">↶ Undo</button>}
        </>}</td>}
      </tr>
    );
  };

  // v211: the Simple view — one card per plant / Pick: what the plan needs, what UR has, what is picked and dispatched, what is left
  const simpleCard = (r: PlantRow, isTotal = false) => {
    const k = K(r);
    // (zeros show as 0 here — the table leaves them blank)
    const q = (x: number) => (Math.abs(x) > 0.0005 ? fmt(x, 2) : '0'), c = (x: number) => fmt(x || 0);
    const ln = (n: number, w = 'line') => `${fmt(n || 0)} ${w}${n === 1 ? '' : 's'}`;
    if (!k) return null;
    const plan = k.t.qty, ur = k.planUr.v, picked = k.picked.qty, disp = k.t.dispatched + k.rp.closed.dispatched;
    const base = Math.max(plan, 1e-9);
    const pc = (x: number) => `${Math.max(0, Math.min(100, (x / base) * 100))}%`;
    const dOk = Math.min(disp, plan), pOnly = Math.max(0, Math.min(picked, plan) - dOk), urLeft = Math.max(0, Math.min(ur, plan) - dOk - pOnly), noUr = Math.max(0, plan - Math.max(ur, dOk + pOnly));
    const toSend = k.rp.urBalance, hold = (k.rep?.qi ?? 0) + (k.rep?.block ?? 0), short = k.t.short + k.rp.closed.shortage, re = k.rp.reQty;
    const pct = ur > 1e-9 ? Math.round((Math.min(disp, ur) / ur) * 100) : 0;
    const chips: { t: string; c: string; tip: string }[] = [];
    if (ur > 1e-9 && toSend <= 0.0005) chips.push({ t: 'Done', c: 'ok', tip: 'All the Plan UR is dispatched' });
    else if (picked > 1e-9) chips.push({ t: 'In progress', c: 'run', tip: 'Picking / dispatching' });
    else chips.push({ t: 'Not started', c: 'idle', tip: 'Nothing picked yet' });
    if (k.t.shortLines) chips.push({ t: `UR short · ${k.t.shortLines} line${k.t.shortLines === 1 ? '' : 's'}`, c: 'bad', tip: 'Lines whose QTY is more than the UR in the warehouse' });
    if (hold > 1e-9) chips.push({ t: 'QI / Block hold', c: 'warn', tip: 'SO stock in QI or Block — picked when released' });
    if (re > 1e-9 && k.rp.newUr > 1e-9) chips.push({ t: 'Can re-pick', c: 'info', tip: `New UR since the first pick (${fmt(k.rp.newUr, 2)}): Pick all matched again` });
    if (k.rp.closedN) chips.push({ t: `Completed · ${k.rp.closedN}`, c: 'done', tip: 'Balance completed by hand' });
    return (
      <article key={r.code} className={`ps-card${isTotal ? ' total' : ''}${repick ? ' click' : ''}`} onClick={repick ? () => setFlowRow(r) : isTotal ? undefined : () => onPlant(r.plantCode)} title={repick ? `${isTotal ? 'All plants' : r.name}: how the plan flowed — runs, QI / Block released, dispatch, lines pending` : isTotal ? 'All plants' : `Show ${r.name} lines`}>
        <header>
          <div className="ps-name"><b>{isTotal ? 'All plants' : r.name}</b>{(() => { const u = uidsOf(r.lines); const t = [isTotal ? '' : r.responsible, u.length ? `Pick ID ${u.join(', ')}` : '', !isTotal && k.rp.jobs.length ? `JOB ${k.rp.jobs.join(', ')}` : ''].filter(Boolean).join(' · '); return t ? <small>{t}</small> : null; })()}</div>
          <div className="ps-pct" title="Dispatched of the Plan UR"><b>{pct}%</b><small>sent</small></div>
        </header>
        <div className="ps-chips">{chips.map((x) => <span key={x.t} className={`ps-chip ${x.c}`} title={x.tip}>{x.t}</span>)}</div>
        <div className="ps-bar" role="img" aria-label={`Plan ${fmt(plan, 2)}: dispatched ${fmt(dOk, 2)}, picked not yet dispatched ${fmt(pOnly, 2)}, UR ready ${fmt(urLeft, 2)}, no UR ${fmt(noUr, 2)}`}>
          <i className="d" style={{ width: pc(dOk) }} /><i className="p" style={{ width: pc(pOnly) }} /><i className="u" style={{ width: pc(urLeft) }} /><i className="n" style={{ width: pc(noUr) }} />
        </div>
        <div className="ps-figs">
          <div><small>Plan QTY</small><b>{q(plan)}</b><em>{ln(k.t.lines)}</em></div>
          <div><small>UR ready</small><b>{q(ur)}</b><em>Plan UR</em></div>
          <div><small>Picked</small><b>{q(picked)}</b><em>{ln(k.rolls.rolls, 'roll')}</em></div>
          <div><small>Dispatched</small><b>{q(disp)}</b><em>{ln(k.t.dispatchedLines)} done</em></div>
        </div>
        <div className="ps-todo">
          <div className={toSend > 1e-9 ? 'hot' : ''}><small>To send</small><b>{q(toSend)}</b><em>{ln(k.rp.urBalLines)}</em></div>
          <div className={short > 1e-9 ? 'bad' : ''}><small>No UR</small><b>{q(short)}</b><em>{ln(k.t.shortLines)}</em></div>
          <div className={hold > 1e-9 ? 'warn' : ''} title={`QI ${fmt(k.rep?.qi ?? 0, 2)} · Block ${fmt(k.rep?.block ?? 0, 2)}`}><small>On hold</small><b>{q(hold)}</b><em>QI {q(k.rep?.qi ?? 0)} · Block {q(k.rep?.block ?? 0)}</em></div>
          <div className={re > 1e-9 ? 'info' : ''} title="Open balance the UR left still covers (picked when rolls match)"><small>Can re-pick</small><b>{q(re)}</b><em>{ln(k.rp.reLines)}</em></div>
        </div>
        {!isTotal && canEdit && (k.rp.open.length > 0 || k.rp.closedN > 0) && (
          <footer onClick={(e) => e.stopPropagation()}>
            {k.rp.open.length > 0 && <button type="button" className="btn sm" onClick={() => setDone({ r, k })} title="Complete the balance by hand: Block, QI, Dispatched or Shortage">✓ Complete balance</button>}
            {k.rp.closedN > 0 && <button type="button" className="btn sm" onClick={() => void reopen(r, k)}>↶ Undo</button>}
          </footer>
        )}
      </article>
    );
  };
  const exportXlsx = () => {
    const head1 = ['', '', ...COLS.flatMap((g) => g.subs.map((_, i) => (i === 0 ? g.card : '')))];
    const head2 = ['Responsible', 'PLANT', ...COLS.flatMap((g) => g.subs.map((x) => x.h))];
    const line = (r: PlantRow) => { const k = K(r); return [r.responsible, r.name + (k && k.rp.jobs.length && r !== s.total ? ` (JOB ${k.rp.jobs.join(', ')})` : ''), ...COLS.flatMap((g) => g.subs.map((x) => { const v = k ? x.get(k, r).v : null; return typeof v === 'number' ? Math.round(v * 1000) / 1000 : v ?? ''; }))]; };
    const ws = XLSX.utils.aoa_to_sheet([head1, head2, ...s.rows.map(line), line(s.total)]);
    let at = 2; ws['!merges'] = COLS.map((g) => { const m = { s: { r: 0, c: at }, e: { r: 0, c: at + g.subs.length - 1 } }; at += g.subs.length; return m; });
    ws['!cols'] = head2.map((h, i) => ({ wch: i < 2 ? 22 : Math.max(9, h.length + 3) }));
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Summary');
    XLSX.writeFile(wb, `Plant_Summary_${day || week}.xlsx`);
  };

  return (
    <section className="card psum-card" aria-labelledby="psum-title">
      {flowRow && repick && <PlanFlow title={flowRow === s.total ? 'All plants' : flowRow.name} lines={flowRow.lines} repick={repick} toast={toast || onSaved} onClose={() => setFlowRow(null)}
        onLines={flowRow === s.total ? undefined : () => { const c = flowRow.plantCode; setFlowRow(null); onPlant(c); }} />}
      <div className="table-head">
        <div>
          <h2 id="psum-title">Plant summary{day ? <span className="pill accent" style={{ marginLeft: 8, fontSize: 12 }}>Day plan · {day}</span> : ''}
            <span className={`psum-live ${live ? 'on' : ''}`} title={live ? 'Updates the moment someone picks, uploads or changes a line' : 'Updates when you use the page and every minute'}><i />{live ? 'Live' : 'Auto'}{updatedAt ? ` · ${fmtTime(updatedAt)}` : ''}</span></h2>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {kpi && <div className="ps-seg" role="tablist" aria-label="View">
            <button type="button" role="tab" aria-selected={view === 'simple'} className={view === 'simple' ? 'on' : ''} onClick={() => pickView('simple')}>Simple</button>
            <button type="button" role="tab" aria-selected={view === 'full'} className={view === 'full' ? 'on' : ''} onClick={() => pickView('full')}>All columns</button>
          </div>}
          {canTarget && <button className="btn sm" onClick={() => setSetup(true)}>Plant settings</button>}
          <button className="btn sm" onClick={exportXlsx}>Export</button>
        </div>
      </div>
      {kpi && view === 'simple' && (
        <>
          <div className="ps-legend" aria-hidden><span><i className="d" />Dispatched</span><span><i className="p" />Picked, not yet dispatched</span><span><i className="u" />UR ready to pick</span><span><i className="n" />No UR</span></div>
          <div className="ps-grid">
            {s.rows.length > 1 && simpleCard(s.total, true)}
            {s.rows.map((r) => simpleCard(r))}
          </div>
        </>
      )}
      <div className="psum-wrap" hidden={!!kpi && view === 'simple'}>
        <table className="psum psum-cards">
          <thead>
            <tr className="grp"><th rowSpan={2} className="fz1">Responsible</th><th rowSpan={2} className="fz2">PLANT</th>
              {COLS.map((g) => <th key={g.card} colSpan={g.subs.length} className="g0" title={g.tip} data-nofilter>{g.card}</th>)}
              {kpi && <th rowSpan={2} className="g0" data-nofilter title="Complete the balance by hand (Block / QI / Dispatched / Shortage) — or undo it">Balance</th>}</tr>
            <tr className="sub">{COLS.flatMap((g) => g.subs.map((x, i) => <th key={g.card + x.h} className={`n ${i === 0 ? 'g0' : ''}`} data-nofilter>{x.h}</th>))}</tr>
          </thead>
          <tbody>{s.rows.map((r) => row(r))}</tbody>
          <tfoot>{row(s.total, true)}</tfoot>
        </table>
        {done && (
          <div className="bal-back" role="dialog" aria-modal="true" aria-labelledby="bal-title" onClick={() => !doneBusy && setDone(null)}>
            <div className="bal-dlg card" onClick={(e) => e.stopPropagation()}>
              <h3 id="bal-title">Complete balance · {done.r.name}</h3>
              <p className="muted small">Balance <b>{fmt(done.k.rp.balance, 2)}</b> of {done.k.rp.open.length} open line{done.k.rp.open.length === 1 ? '' : 's'} (plan QTY − dispatched). It is added to the category you choose and the balance becomes 0. Undo opens it again.</p>
              <div className="bal-cats" role="radiogroup" aria-label="Category">
                {BAL_CATS.map((c) => <label key={c.v} className={doneCat === c.v ? 'on' : ''}><input type="radio" name="balcat" value={c.v} checked={doneCat === c.v} onChange={() => setDoneCat(c.v)} />{c.label}</label>)}
              </div>
              <div className="bal-lines">{done.k.rp.open.slice(0, 40).map((x) => <div key={`${x.l.week}|${x.l.key}|${x.l.date ?? ''}`}><span className="mono">{x.l.so} / {x.l.li}</span><span className="mono muted">{x.l.item}</span><b>{fmt(x.bal, 2)}</b></div>)}
                {done.k.rp.open.length > 40 && <div className="muted small">… and {done.k.rp.open.length - 40} more</div>}</div>
              <div className="bal-acts">
                <button type="button" className="btn" onClick={() => setDone(null)} disabled={doneBusy}>Cancel</button>
                <button type="button" className="btn primary" onClick={() => void complete()} disabled={!doneCat || doneBusy}>{doneBusy ? 'Saving…' : `Complete as ${doneCat ? catLabel(doneCat) : '…'}`}</button>
              </div>
            </div>
          </div>
        )}
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
