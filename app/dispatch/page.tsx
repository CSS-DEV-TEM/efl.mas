'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import Shell, { useShell } from '@/components/Shell';
import { api } from '@/lib/api';
import { ago, fmt, fmtDate, fmtQty, isDispatched, need, avail, type DispatchSummary, type Line, type WeekInfo } from '@/lib/calc';
import { colLetter, readWorkbook, type Grid } from '@/lib/mapping';
import { takePendingDispatch } from '@/lib/handoff';
import AssignDispatch from '@/components/AssignDispatch';
import OverPlan from '@/components/OverPlan';

export default function Page() {
  return <Shell><Dispatch /></Shell>;
}

/** Columns read from the dispatch sheet. Item and Actual Qty are required. */
const DFIELDS: { id: string; label: string; required?: boolean; aliases: string[] }[] = [
  { id: 'item', label: 'Item (= plan Item Code)', required: true, aliases: ['display item number', 'item number', 'item code', 'material', 'material number', 'item'] },
  { id: 'qty', label: 'Actual Qty', required: true, aliases: ['actual qty', 'actual quantity', 'dispatch qty', 'qty', 'quantity'] },
  { id: 'pallet', label: 'Pallet', aliases: ['pallet', 'pallet id', 'hu', 'supplier hu'] },
  { id: 'location', label: 'Location', aliases: ['location id', 'location'] },
  { id: 'lot', label: 'Lot', aliases: ['lot number', 'lot', 'batch'] },
  { id: 'order_no', label: 'Order / Pick', aliases: ['order number', 'pick id', 'load id', 'order'] },
  { id: 'uom', label: 'UOM', aliases: ['uom', 'unit'] },
  { id: 'so', label: 'Client SO', aliases: ['client so', 'so', 'sales order'] },
];

const norm = (v: unknown) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const num = (v: unknown) => { const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(/,/g, '').trim()); return Number.isFinite(n) ? n : NaN; };

interface Map_ { header: number; cols: Record<string, number> }

/** Header row = the row in the first 15 with the most alias hits; each field takes its first matching column. */
function detect(grid: Grid): Map_ {
  let best: Map_ = { header: -1, cols: {} }, bestHits = 0;
  for (let r = 0; r < Math.min(15, grid.length); r++) {
    const row = (grid[r] || []).map(norm);
    const cols: Record<string, number> = {};
    let hits = 0;
    for (const f of DFIELDS) {
      let at = -1;
      for (const a of f.aliases) { at = row.indexOf(a); if (at >= 0) break; }
      cols[f.id] = at;
      if (at >= 0) hits += f.required ? 3 : 1;
    }
    if (hits > bestHits) { bestHits = hits; best = { header: r, cols }; }
  }
  return best;
}
function sheetScore(grid: Grid) { const m = detect(grid); return (m.cols.item >= 0 ? 2 : 0) + (m.cols.qty >= 0 ? 2 : 0) + (norm(grid[m.header]?.[m.cols.item]) === 'display item number' ? 1 : 0); }

function extract(grid: Grid, m: Map_) {
  if (m.header < 0) return [];
  const out: Record<string, unknown>[] = [];
  for (let r = m.header + 1; r < grid.length; r++) {
    const row = grid[r] || [];
    const o: Record<string, unknown> = {};
    for (const f of DFIELDS) { const c = m.cols[f.id]; o[f.id] = c >= 0 ? row[c] ?? null : null; }
    if (o.item === null && o.qty === null) continue;
    out.push(o);
  }
  return out;
}
const usable = (rows: Record<string, unknown>[]) => rows.filter((r) => /^[A-Za-z]{0,4}\d/.test(String(r.item ?? '').trim()) && num(r.qty) > 0);

/** SAP-style exports often give metres × 1000 as whole numbers: suggest ÷1000 when most values are big round numbers. */
function suggestDivide(rows: Record<string, unknown>[]): 1000 | 1 {
  const q = usable(rows).map((r) => num(r.qty));
  if (!q.length) return 1;
  const big = q.filter((n) => n >= 1000 && Number.isInteger(n)).length;
  return big / q.length >= 0.6 ? 1000 : 1;
}

interface PullPlan { week: string | null; weeks: WeekInfo[]; rows: Line[]; dispatch?: DispatchSummary; stockAt?: string | null }
interface Preview { lines: number; added: number; updated: number; removed: number; skipped: number; inFileDups: number; totalQty: number; items: number; matched: number; unmatched: string[] }
interface DispRow { item: string; qty: number; raw_qty: number; pallet: string | null; location: string | null; lot: string | null; order_no: string | null; uom: string | null; file_name: string | null; uploaded_by: string; uploaded_at: string }

function Dispatch() {
  const { user, subscribe, toast } = useShell();
  const canEdit = user.role !== 'viewer';
  const [week, setWeek] = useState<string | null>(null);
  const [plan, setPlan] = useState<PullPlan | null>(null);
  const [saved, setSaved] = useState<DispRow[]>([]);
  const [history, setHistory] = useState<{ at: string; username: string; detail: string }[]>([]);
  const [err, setErr] = useState('');

  // file + options
  const [file, setFile] = useState<{ name: string; sheets: { name: string; grid: Grid }[] } | null>(null);
  const [sheet, setSheet] = useState('');
  const [map, setMap] = useState<Map_ | null>(null);
  const [divide, setDivide] = useState<1000 | 1>(1000);
  const [toYards, setToYards] = useState(false);
  const [mode, setMode] = useState<'merge' | 'replace-week'>('merge');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewErr, setPreviewErr] = useState('');
  const [sending, setSending] = useState(false);
  const [over, setOver] = useState(false);
  const [show, setShow] = useState<'items' | 'lines' | 'pallets'>('items');
  const input = useRef<HTMLInputElement>(null);
  const weekRef = useRef(week); weekRef.current = week;

  const load = useCallback(async () => {
    try {
      const w = weekRef.current;
      const p = await api<PullPlan>('/api/pullplan' + (w ? '?week=' + encodeURIComponent(w) : ''));
      // a slower answer for a week no longer picked must not overwrite the current one
      if (weekRef.current && p.week !== weekRef.current) return;
      setPlan(p);
      if (!w && p.week) setWeek((cur) => cur ?? p.week);
      if (p.week) {
        const d = await api<{ rows: DispRow[]; history: { at: string; username: string; detail: string }[] }>('/api/dispatch?week=' + encodeURIComponent(p.week));
        if (weekRef.current && weekRef.current !== p.week) return;
        setSaved(d.rows); setHistory(d.history);
      }
      setErr('');
    } catch (e) { setErr(e instanceof Error ? e.message : 'Could not load.'); }
  }, []);
  useEffect(() => { load(); }, [load, week]);
  useEffect(() => subscribe((m) => { if (m.type === 'data') load(); }), [subscribe, load]);

  // a file handed over from the Uploads page
  useEffect(() => { const f = takePendingDispatch(); if (f) addFile(f); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const grid = useMemo(() => file?.sheets.find((s) => s.name === sheet)?.grid || [], [file, sheet]);
  const rows = useMemo(() => (map ? extract(grid, map) : []), [grid, map]);
  const good = useMemo(() => usable(rows), [rows]);
  const uoms = useMemo(() => Array.from(new Set(good.map((r) => String(r.uom ?? '').trim().toUpperCase()).filter(Boolean))), [good]);
  const factor = (1 / divide) * (toYards ? 1 / 0.9144 : 1);

  const pickSheet = (name: string, sheets = file?.sheets || []) => {
    setSheet(name);
    const g = sheets.find((s) => s.name === name)?.grid || [];
    const m = detect(g);
    setMap(m);
    setDivide(suggestDivide(extract(g, m)));
  };
  const addFile = async (f: File) => {
    try {
      const sheets = readWorkbook(await f.arrayBuffer());
      setFile({ name: f.name, sheets });
      const best = sheets.map((s) => ({ s, sc: sheetScore(s.grid) })).sort((a, b) => b.sc - a.sc)[0];
      pickSheet(best?.s.name || sheets[0]?.name || '', sheets);
    } catch { toast('Could not read that file. Save it as .xlsx and try again.'); }
  };

  const body = useCallback((dryRun: boolean) => ({
    week, divide, toYards, mode, fileName: file?.name, sheetName: sheet, dryRun,
    rows: good.map((r) => ({ item: String(r.item).trim(), qty: num(r.qty), pallet: r.pallet, location: r.location, lot: r.lot, order_no: r.order_no, uom: r.uom, so: r.so })),
  }), [week, divide, toYards, mode, file?.name, sheet, good]);

  // ask the server what the upload would do before sending it
  useEffect(() => {
    if (!week || !good.length || !canEdit) { setPreview(null); return; }
    let stop = false;
    const t = setTimeout(async () => {
      try { const r = await api<Preview>('/api/dispatch', { method: 'POST', body: body(true) }); if (!stop) { setPreview(r); setPreviewErr(''); } }
      catch (e) { if (!stop) { setPreview(null); setPreviewErr(e instanceof Error ? e.message : ''); } }
    }, 300);
    return () => { stop = true; clearTimeout(t); };
  }, [body, week, good.length, canEdit]);

  const send = async () => {
    setSending(true);
    try {
      const r = await api<Preview>('/api/dispatch', { method: 'POST', body: body(false) });
      toast(`Dispatch saved: ${fmt(r.added)} new, ${fmt(r.updated)} updated${r.removed ? `, ${fmt(r.removed)} removed` : ''} · ${fmt(r.totalQty, 2)} QTY`);
      setFile(null); setSheet(''); setMap(null); setPreview(null);
      await load();
    } catch (e) { toast(e instanceof Error ? e.message : 'Upload failed.'); }
    finally { setSending(false); }
  };
  const clearWeek = async () => {
    if (!week || !confirm(`Remove all dispatch data for ${week}? Plan lines go back to their full QTY.`)) return;
    try { await api('/api/dispatch?week=' + encodeURIComponent(week), { method: 'DELETE' }); toast('Dispatch cleared.'); load(); }
    catch (e) { toast(e instanceof Error ? e.message : 'Failed.'); }
  };

  const d = plan?.dispatch;
  const lines = useMemo(() => {
    const items = new Set((d?.items || []).map((i) => i.item));
    return (plan?.rows || []).filter((l) => items.has(String(l.item)) || (l.dispatched ?? 0) > 0).sort((a, b) => String(a.item).localeCompare(String(b.item)) || String(a.date ?? '').localeCompare(String(b.date ?? '')) || a.row_no - b.row_no);
  }, [plan?.rows, d]);
  const header = map && map.header >= 0 ? grid[map.header] || [] : [];
  const width = Math.max(0, ...grid.slice(0, 40).map((r) => r?.length || 0));
  const missing = DFIELDS.filter((f) => f.required && (map?.cols[f.id] ?? -1) < 0);
  const totalPlan = (plan?.rows || []).reduce((s, l) => s + l.qty, 0);
  const fullLines = (plan?.rows || []).filter(isDispatched).length;

  return (
    <main className="page anim">
      <div className="page-head">
        <div>
          <h1>Dispatch</h1>
          <p>Upload the dispatch / pick file. Each <b>Display Item Number</b> is matched to the plan <b>Item Code</b>, and its <b>Actual Qty</b> is taken off that item&apos;s plan lines (earliest date first) and off UR. Lines with nothing left are marked complete.</p>
        </div>
        <div className="week-pick" style={{ margin: 0 }}>
          <label htmlFor="d-week">Plan week</label>
          <select id="d-week" value={week || ''} onChange={(e) => setWeek(e.target.value)}>
            {(plan?.weeks || []).map((w, i) => <option key={w.week} value={w.week}>Week {Number(w.week.slice(-2))} · {w.start ? `${fmtDate(w.start)} – ${fmtDate(w.end)}` : w.week}{i === 0 ? ' (latest)' : ''}</option>)}
          </select>
        </div>
      </div>
      {err && <div className="notice bad">{err}</div>}
      {plan && !plan.weeks.length && <div className="notice warn">There is no weekly plan yet. Upload a plan first, then its dispatch.</div>}

      <section className="kpis" aria-label="Dispatch figures">
        <div className="kpi"><span className="k">Dispatched QTY</span><span className="v">{fmt(d?.total || 0, 2)}</span><span className="s">{fmt(saved.length)} pallet line{saved.length === 1 ? '' : 's'} · {fmt(d?.items.length || 0)} items</span></div>
        <div className="kpi ok"><span className="k">Plan lines complete</span><span className="v">{fmt(fullLines)}</span><span className="s">of {fmt(plan?.rows.length || 0)} in this week</span>
          <div className="meter"><span style={{ width: `${plan?.rows.length ? (fullLines / plan.rows.length) * 100 : 0}%`, background: 'var(--ok)' }} /></div></div>
        <div className="kpi"><span className="k">Plan balance</span><span className="v">{fmt((plan?.rows || []).reduce((s, l) => s + need(l), 0), 2)}</span><span className="s">of {fmt(totalPlan, 2)} plan QTY</span></div>
        <div className={`kpi ${d?.unmatched.length ? 'bad' : ''}`}><span className="k">Items not in plan</span><span className="v">{fmt(d?.unmatched.length || 0)}</span><span className="s">{d?.unmatched.length ? fmt(d.unmatched.reduce((s, i) => s + i.dispatched, 0), 2) + ' QTY unmatched' : 'every dispatched item matched'}</span></div>
      </section>

      {canEdit && (
        <section className="card" aria-labelledby="up-title">
          <h2 id="up-title">Upload dispatch file</h2>
          <div className={`drop ${over ? 'over' : ''}`} role="button" tabIndex={0}
            onClick={() => input.current?.click()}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') input.current?.click(); }}
            onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
            onDrop={(e) => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files[0]; if (f) addFile(f); }}>
            <strong>{file ? file.name : 'Drop the dispatch Excel here, or click to choose'}</strong>
            <span className="muted">.xlsx, .xls, .csv — e.g. the JAN0190-CUT pick file</span>
            <input ref={input} type="file" hidden accept=".xlsx,.xlsm,.xls,.csv" onChange={(e) => { const f = e.target.files?.[0]; if (f) addFile(f); e.target.value = ''; }} />
          </div>

          {file && (
            <>
              <div className="disp-opts">
                <label>Sheet
                  <select value={sheet} onChange={(e) => pickSheet(e.target.value)}>
                    {file.sheets.map((s) => <option key={s.name} value={s.name}>{s.name} ({fmt(Math.max(0, s.grid.length - 1))} rows)</option>)}
                  </select>
                </label>
                <label>Actual Qty
                  <select value={divide} onChange={(e) => setDivide(Number(e.target.value) === 1000 ? 1000 : 1)}>
                    <option value={1000}>Divide by 1000 (93000 → 93)</option>
                    <option value={1}>Use as it is</option>
                  </select>
                </label>
                <label className="chk"><input type="checkbox" checked={toYards} onChange={(e) => setToYards(e.target.checked)} /> Convert metres → yards (× 1.0936)</label>
                <label>When this week already has dispatch
                  <select value={mode} onChange={(e) => setMode(e.target.value as 'merge' | 'replace-week')}>
                    <option value="merge">Add / update (same pallet is not counted twice)</option>
                    <option value="replace-week">Replace this week&apos;s dispatch</option>
                  </select>
                </label>
              </div>
              {uoms.length > 0 && <p className="sub" style={{ margin: '4px 0 0' }}>UOM in file: <b>{uoms.join(', ')}</b>{uoms.includes('MTS') && !toYards ? ' — the plan and ZMMBE may be in yards; tick the conversion if so.' : ''}</p>}

              {map && (
                <div className="maprow" style={{ marginTop: 10 }}>
                  {DFIELDS.map((f) => (
                    <label key={f.id}>{f.label}{f.required && ' *'}
                      <select value={map.cols[f.id] ?? -1} onChange={(e) => setMap({ ...map, cols: { ...map.cols, [f.id]: Number(e.target.value) } })}>
                        <option value={-1}>— none —</option>
                        {Array.from({ length: width }, (_, c) => <option key={c} value={c}>{colLetter(c)}{header[c] ? ' · ' + String(header[c]).slice(0, 22) : ''}</option>)}
                      </select>
                    </label>
                  ))}
                </div>
              )}
              {map && map.header < 0 && <div className="notice warn">No header row found on this sheet. Choose another sheet, or pick the columns above.</div>}
              {missing.length > 0 && <div className="notice bad">Choose the column for {missing.map((f) => f.label).join(' and ')}.</div>}

              {good.length > 0 && (
                <div className="preview" style={{ marginTop: 10 }}>
                  <table className="mini">
                    <thead><tr><th>Item</th><th className="n">Actual Qty (file)</th><th className="n">QTY used</th><th>Pallet</th><th>Order</th><th>UOM</th></tr></thead>
                    <tbody>{good.slice(0, 6).map((r, i) => (
                      <tr key={i}><td>{String(r.item)}</td><td className="n">{fmt(num(r.qty), 3)}</td><td className="n"><b>{fmt(Math.round(num(r.qty) * factor * 1000) / 1000, 3)}</b></td><td>{String(r.pallet ?? '')}</td><td>{String(r.order_no ?? '')}</td><td>{String(r.uom ?? '')}</td></tr>
                    ))}</tbody>
                  </table>
                  <p className="sub" style={{ margin: '6px 0 0' }}>{fmt(good.length)} usable rows of {fmt(rows.length)}{good.length > 6 ? ' · first 6 shown' : ''}.</p>
                </div>
              )}

              {preview && (
                <div className="disp-pre">
                  <span className="pc new"><b>{fmt(preview.added)}</b> new</span>
                  <span className="pc upd"><b>{fmt(preview.updated)}</b> already there (updated)</span>
                  {preview.removed > 0 && <span className="pc del"><b>{fmt(preview.removed)}</b> removed</span>}
                  {preview.inFileDups > 0 && <span className="pc keep"><b>{fmt(preview.inFileDups)}</b> repeated in file (counted once)</span>}
                  <span className="pc keep"><b>{fmt(preview.totalQty, 2)}</b> QTY · {fmt(preview.matched)} of {fmt(preview.items)} items in plan</span>
                </div>
              )}
              {preview && preview.unmatched.length > 0 && <div className="notice warn">Not in the {week} plan: {preview.unmatched.join(', ')}. Their QTY is saved but takes nothing off the plan.</div>}
              {previewErr && <div className="notice bad">{previewErr}</div>}
              <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                <button className="btn primary" disabled={!week || !good.length || missing.length > 0 || sending} onClick={send}>{sending ? 'Uploading…' : `Upload dispatch to Week ${week ? Number(week.slice(-2)) : ''}`}</button>
                <button className="btn" onClick={() => { setFile(null); setSheet(''); setMap(null); }}>Cancel</button>
              </div>
            </>
          )}
        </section>
      )}

      <section className="card" aria-labelledby="sum-title">
        <div className="sheet-top">
          <div><h2 id="sum-title">Dispatch vs plan · {week ? `Week ${Number(week.slice(-2))}` : ''}</h2>
            <p className="sub" style={{ margin: 0 }}>Balance = plan QTY − dispatched. UR left = UR − dispatch uploaded after the latest ZMMBE{plan?.stockAt ? ` (${new Date(plan.stockAt).toLocaleString('en-GB', { timeZone: 'Asia/Colombo', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })})` : ''} — dispatch before it is already out of that ZMMBE, so it is not taken off twice.</p></div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <div className="seg" role="group">
              <button className={show === 'items' ? 'on' : ''} onClick={() => setShow('items')}>By item</button>
              <button className={show === 'lines' ? 'on' : ''} onClick={() => setShow('lines')}>Plan lines</button>
              <button className={show === 'pallets' ? 'on' : ''} onClick={() => setShow('pallets')}>Pallets</button>
            </div>
            {saved.length > 0 && <button className="btn sm" onClick={() => exportDispatch(lines, saved, week || '')}>Export</button>}
            {canEdit && saved.length > 0 && <button className="btn sm danger" onClick={clearWeek}>Clear week</button>}
          </div>
        </div>
        {!!d?.items.length && d.unmatched.length > 0 && (
          <div className="notice warn">
            {d.unmatched.length === d.items.length ? <b>None of the dispatched items are in the {week} plan.</b> : <b>{d.unmatched.length} dispatched item{d.unmatched.length === 1 ? ' is' : 's are'} not in the {week} plan.</b>}{' '}
            The {week} plan has {fmt(d.planLines ?? plan?.rows.length ?? 0)} line{(d.planLines ?? 0) === 1 ? '' : 's'}.
            {d.unmatched.some((i) => d.elsewhere?.[i.item]?.length)
              ? ' Some are in another week\'s plan — use the button next to the item if the dispatch belongs to that week.'
              : ''}
            {' If those items are on lines whose SO starts with a letter (E101690468…), upload the plan again on the Uploads page — an older Worker skipped those lines. The dispatch stays saved and is taken off as soon as the lines are there.'}
          </div>
        )}
        {!d?.items.length ? <p className="muted">No dispatch uploaded for this week yet.</p> : (
          <div className="table-wrap">
            {show === 'items' && (
              <table className="mini">
                <thead><tr><th>Item</th><th className="n">Pallets</th><th className="n">Dispatched</th><th className="n">Plan QTY</th><th className="n">Balance</th><th className="n">Over plan</th><th className="n">Lines complete</th><th>State</th></tr></thead>
                <tbody>{d.items.map((i) => {
                  const ils = (plan?.rows || []).filter((l) => String(l.item) === i.item);
                  const bal = ils.reduce((t, l) => t + need(l), 0); const done = ils.filter(isDispatched).length;
                  return (
                    <tr key={i.item}><td><b>{i.item}</b></td><td className="n">{fmt(i.pallets)}</td><td className="n">{fmtQty(i.dispatched)}</td><td className="n">{i.lines ? fmtQty(i.planQty) : '–'}</td>
                      <td className="n">{i.lines ? fmtQty(bal) : '–'}</td><td className={`n ${i.over > 0 && i.lines ? 'neg' : ''}`}>{i.lines ? fmtQty(i.over) : '–'}</td><td className="n">{i.lines ? `${done} / ${i.lines}` : '–'}</td>
                      <td>{!i.lines && i.over <= 1e-9 ? <span className="pill ok">Assigned by hand</span> : !i.lines ? (d.elsewhere?.[i.item]?.length
                        ? <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}><span className="pill warn">In {d.elsewhere[i.item].map((w) => `Week ${Number(w.slice(-2))}`).join(', ')} plan</span><button className="btn sm" onClick={() => setWeek(d.elsewhere![i.item][0])}>Go to Week {Number(d.elsewhere[i.item][0].slice(-2))}</button></span>
                        : <span className="pill warn">Not in any plan</span>) : bal <= 1e-9 ? <span className="pill ok">Complete</span> : <span className="pill accent">Part dispatched</span>}</td></tr>
                  );
                })}</tbody>
              </table>
            )}
            {show === 'lines' && (
              <table className="mini">
                <thead><tr><th>SO</th><th>LI</th><th>Item</th><th>Date</th><th className="n">QTY</th><th className="n">Dispatched</th><th className="n">Balance</th><th className="n">UR</th><th className="n">UR left</th><th>State</th></tr></thead>
                <tbody>{lines.map((l) => (
                  <tr key={l.id}><td>{l.so}</td><td>{l.li}</td><td>{l.item}</td><td>{fmtDate(l.date)}</td><td className="n">{fmtQty(l.qty)}</td><td className="n">{fmtQty(l.dispatched ?? 0)}</td><td className="n"><b>{fmtQty(need(l))}</b></td><td className="n">{fmtQty(l.ur)}</td><td className="n">{fmtQty(avail(l))}</td>
                    <td>{isDispatched(l) ? <span className="pill ok">Complete</span> : (l.dispatched ?? 0) > 0 ? <span className="pill accent">Part</span> : <span className="pill mute">Waiting</span>}</td></tr>
                ))}</tbody>
              </table>
            )}
            {show === 'pallets' && (
              <table className="mini">
                <thead><tr><th>Item</th><th>Pallet</th><th>Location</th><th>Lot</th><th>Order</th><th className="n">File qty</th><th className="n">QTY</th><th>By</th></tr></thead>
                <tbody>{saved.map((r, i) => (
                  <tr key={i}><td>{r.item}</td><td>{r.pallet}</td><td>{r.location}</td><td>{r.lot}</td><td>{r.order_no}</td><td className="n">{fmt(r.raw_qty, 0)}</td><td className="n">{fmtQty(r.qty)}</td><td className="muted">{r.uploaded_by} · {ago(r.uploaded_at)}</td></tr>
                ))}</tbody>
              </table>
            )}
          </div>
        )}
      </section>

      {week && plan && d && <OverPlan week={week} items={d.items} rows={plan.rows} canEdit={canEdit} onDone={(m) => { toast(m); load(); }} />}

      {week && d && <AssignDispatch week={week} leftover={(d.leftover || []).filter((i) => !i.lines)} assigns={d.assigns || []} rows={plan?.rows || []} canEdit={canEdit} onDone={(m) => { toast(m); load(); }} />}

      {history.length > 0 && (
        <section className="card">
          <h2>Recent dispatch uploads</h2>
          <div className="wk-list">{history.map((h, i) => <div key={i} className="wk-row"><span>{h.detail}</span><span className="num muted">{h.username} · {ago(h.at)}</span></div>)}</div>
        </section>
      )}
    </main>
  );
}

function exportDispatch(lines: Line[], pallets: DispRow[], week: string) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(lines.map((l) => ({
    Week: l.week, SO: l.so, LI: l.li, 'Item Code': l.item, Date: l.date, QTY: l.qty, Dispatched: l.dispatched ?? 0, Balance: need(l), UR: l.ur, 'UR left': avail(l), Complete: isDispatched(l) ? 'Yes' : 'No',
  }))), 'Plan vs dispatch');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(pallets.map((r) => ({
    Item: r.item, Pallet: r.pallet, Location: r.location, Lot: r.lot, Order: r.order_no, UOM: r.uom, 'Actual Qty (file)': r.raw_qty, QTY: r.qty, File: r.file_name, 'Uploaded by': r.uploaded_by, 'Uploaded at': r.uploaded_at,
  }))), 'Dispatch pallets');
  XLSX.writeFile(wb, `Dispatch_${week}.xlsx`);
}
