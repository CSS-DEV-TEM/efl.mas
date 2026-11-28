'use client';
/**
 * v223 (API 142): the Remark report — choose a date range (plan date) and a plan Remark: the day plan lines with that remark,
 * what was picked for each (Pick all matched = auto, the rest = manual: Needs manual, Import Packing List), the picked rolls,
 * and the pallets picked outside the system (picked-pallets / Packing List uploads) of those items in that range.
 * Read only. Download: one Excel with sheets Summary, Lines, Picks, Picked outside.
 */
import * as React from 'react';
import { useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import { api } from '@/lib/api';
import { fmt, fmtDate } from '@/lib/calc';
import { todayLocal } from '@/lib/smart';

interface RLine { pick: string; pick_uid: string | null; date: string; plant: string | null; remarks: string | null; so: string; li: string; item: string; key: string; qty: number; auto: number; manual: number; picked: number; rolls: number; balance: number }
interface RPick { week: string; pick_uid: string | null; line: string; so: string; li: string; item: string; pallet: string; qty: number; roll_qty: number | null; batch: string | null; lot: string | null; insp_lot: string | null; by_user: string; at: string; auto: number; pick_no: string | null }
interface RUsed { pallet: string; item: string | null; lot: string | null; qty: number; file_name: string; by_user: string; at: string }
interface Res { from: string; to: string; remark: string | null; remarks: { remark: string; lines: number; qty: number }[]; lines: RLine[]; picks: RPick[]; used: RUsed[] }

const addDays = (d: string, n: number) => { const t = new Date(d + 'T00:00:00'); t.setDate(t.getDate() + n); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`; };
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const pickName = (w: string) => { const m = /^(\d{4})-(\d{2})-(\d{2})~([^~]*)~(\d+)$/.exec(w); return m ? `${m[3]}-${m[2]} · ${m[4] === '-' ? 'No plant' : m[4]} · Pick ${m[5]}` : w; };

export default function RemarkReport({ toast }: { toast: (m: string) => void }) {
  const [from, setFrom] = useState(() => addDays(todayLocal(), -6));
  const [to, setTo] = useState(() => todayLocal());
  const [remark, setRemark] = useState('');
  const [res, setRes] = useState<Res | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const run = async (rm = remark) => {
    setBusy(true); setErr('');
    try { setRes(await api<Res>(`/api/remark-report?from=${from}&to=${to}${rm ? '&remark=' + encodeURIComponent(rm) : ''}`)); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Could not load the report.'); setRes(null); }
    finally { setBusy(false); }
  };
  // the remarks of the range are read with the dates
  useEffect(() => { const t = setTimeout(() => { void run(''); setRemark(''); }, 300); return () => clearTimeout(t); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to]);

  const tot = useMemo(() => {
    const ls = res?.lines || [];
    const t = { lines: ls.length, qty: 0, auto: 0, manual: 0, picked: 0, balance: 0, rolls: 0, done: 0 };
    for (const l of ls) { t.qty += l.qty; t.auto += l.auto; t.manual += l.manual; t.picked += l.picked; t.balance += l.balance; t.rolls += l.rolls; if (l.balance <= 1e-9) t.done++; }
    return t;
  }, [res]);
  // by remark (when all remarks are shown) — else by plant
  const groups = useMemo(() => {
    const m = new Map<string, { k: string; lines: number; qty: number; auto: number; manual: number; picked: number; balance: number }>();
    for (const l of res?.lines || []) {
      const k = remark ? (l.plant || 'No plant') : (l.remarks || '(no remark)');
      const g = m.get(k) || { k, lines: 0, qty: 0, auto: 0, manual: 0, picked: 0, balance: 0 };
      g.lines++; g.qty += l.qty; g.auto += l.auto; g.manual += l.manual; g.picked += l.picked; g.balance += l.balance; m.set(k, g);
    }
    return Array.from(m.values()).sort((a, b) => b.qty - a.qty);
  }, [res, remark]);
  const usedQty = r3((res?.used || []).reduce((t, u) => t + Number(u.qty), 0));

  const download = () => {
    if (!res) return;
    const wb = XLSX.utils.book_new();
    const head = [`Remark report · ${fmtDate(res.from)} – ${fmtDate(res.to)} · Remark: ${res.remark ? (res.remark === '-' ? '(no remark)' : res.remark) : 'all'}`];
    const sum = [head, [], [remark ? 'Plant' : 'Remark', 'Lines', 'Plan QTY', 'Picked (auto)', 'Picked (manual)', 'Picked', 'Balance'],
      ...groups.map((g) => [g.k, g.lines, r3(g.qty), r3(g.auto), r3(g.manual), r3(g.picked), r3(g.balance)]),
      ['Total', tot.lines, r3(tot.qty), r3(tot.auto), r3(tot.manual), r3(tot.picked), r3(tot.balance)], [],
      ['Picked outside the system (picked-pallets / Packing List uploads of these items in the range)', '', usedQty]];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sum), 'Summary');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Plan date', 'Pick', 'Pick ID', 'Plant', 'Remark', 'SO', 'LI', 'Item', 'Plan QTY', 'Picked (auto)', 'Picked (manual)', 'Picked', 'Rolls', 'Balance'],
      ...res.lines.map((l) => [l.date, pickName(l.pick), l.pick_uid ?? '', l.plant ?? '', l.remarks ?? '', l.so, l.li, l.item, l.qty, l.auto, l.manual, l.picked, l.rolls, l.balance])]), 'Lines');
    const ln = new Map(res.lines.map((l) => [`${l.pick}|${l.key}|${l.date ?? ''}`, l]));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Picked at', 'Pick', 'Pick ID', 'Remark', 'SO', 'LI', 'Item', 'Pallet', 'QTY', 'Roll QTY', 'Batch', 'Lot', 'Insp. lot', 'How', 'By'],
      ...res.picks.map((k) => [new Date(k.at).toLocaleString(), pickName(k.week), k.pick_uid ?? '', ln.get(`${k.week}|${k.line}`)?.remarks ?? '', k.so, k.li, k.item, k.pallet, k.qty, k.roll_qty ?? '', k.batch ?? '', k.lot ?? '', k.insp_lot ?? '', k.auto ? 'Auto (Pick all matched)' : 'Manual', k.by_user])]), 'Picks');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Uploaded', 'File', 'Pallet', 'Item', 'Lot', 'QTY', 'By'],
      ...res.used.map((u) => [new Date(u.at).toLocaleString(), u.file_name, u.pallet, u.item ?? '', u.lot ?? '', u.qty, u.by_user])]), 'Picked outside');
    const name = `Remark_report_${res.remark ? res.remark.replace(/[^\w-]+/g, '_') : 'all'}_${res.from}_${res.to}.xlsx`;
    XLSX.writeFile(wb, name);
    toast(`${name} — ${fmt(tot.lines)} lines`);
  };

  return (
    <section className="card" aria-labelledby="rr-title">
      <div className="table-head">
        <div>
          <h2 id="rr-title">Remark report</h2>
          <p className="muted small" style={{ margin: 0 }}>The day plan lines of a date range with a plan <b>Remark</b>: plan QTY, picked by <b>Pick all matched (auto)</b> and <b>manual</b> (Needs manual, Import Packing List), rolls, balance — and the pallets picked outside the system of those items.</p>
        </div>
      </div>
      <div className="rr-bar">
        <label>From<input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></label>
        <label>To<input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></label>
        <label className="rr-rm">Remark
          <select value={remark} onChange={(e) => { setRemark(e.target.value); void run(e.target.value); }}>
            <option value="">All remarks</option>
            {(res?.remarks || []).map((r) => <option key={r.remark} value={r.remark}>{r.remark === '-' ? '(no remark)' : r.remark} · {fmt(r.lines)} lines · {fmt(r.qty, 2)}</option>)}
          </select>
        </label>
        <button className="btn" onClick={() => void run()} disabled={busy} aria-busy={busy || undefined}>{busy ? 'Loading…' : 'Refresh'}</button>
        <button className="btn primary" onClick={download} disabled={!res?.lines.length}>⬇ Excel</button>
      </div>
      {err && <div className="notice warn">{err}</div>}
      {res && (!res.lines.length ? <p className="muted">No day plan line in this range{remark ? ' with this remark' : ''}.</p> : <>
        <div className="rr-kpis">
          <div><small>Lines</small><b>{fmt(tot.lines)}</b><small>{fmt(tot.done)} fully picked</small></div>
          <div><small>Plan QTY</small><b>{fmt(tot.qty, 2)}</b></div>
          <div><small>Picked · auto</small><b>{fmt(tot.auto, 2)}</b></div>
          <div><small>Picked · manual</small><b>{fmt(tot.manual, 2)}</b></div>
          <div><small>Balance</small><b>{fmt(tot.balance, 2)}</b></div>
          <div><small>Picked outside (same items)</small><b>{fmt(usedQty, 2)}</b><small>{fmt(res.used.length)} pallet rows</small></div>
        </div>
        <div className="table-wrap"><table className="tbl">
          <thead><tr><th>{remark ? 'Plant' : 'Remark'}</th><th className="n">Lines</th><th className="n">Plan QTY</th><th className="n">Auto</th><th className="n">Manual</th><th className="n">Picked</th><th className="n">Balance</th></tr></thead>
          <tbody>{groups.map((g) => <tr key={g.k}><td>{g.k}</td><td className="n">{fmt(g.lines)}</td><td className="n">{fmt(g.qty, 2)}</td><td className="n">{fmt(g.auto, 2)}</td><td className="n">{fmt(g.manual, 2)}</td><td className="n">{fmt(g.picked, 2)}</td><td className="n">{fmt(g.balance, 2)}</td></tr>)}</tbody>
        </table></div>
      </>)}
    </section>
  );
}
