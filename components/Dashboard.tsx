'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PageLoading } from '@/components/Loader';
import Link from 'next/link';
import { useShell } from '@/components/Shell';
import Ledger, { STATUS_OPTIONS } from '@/components/Ledger';
import { COV_COLOR } from '@/components/Charts';
import PlantSummary from '@/components/PlantSummary';
import PlanPicks from '@/components/PlanPicks';
import { fmtTime, type PlantInfo } from '@/lib/summary';
import { api, userParam } from '@/lib/api';
import { useRefreshOnActivity } from '@/lib/freshness';
import { COVERAGES, periodOf, type DispatchSummary, ago, compact, coverage, fmt, fmtDate, isDone, lineRef, totals, type Coverage, type Line, type Upload, type WeekInfo } from '@/lib/calc';
import { exportPullPlan } from '@/lib/export';
import { CountUp } from '@/components/Brand';
import InsightDrawer from '@/components/InsightDrawer';
import PlanReport, { type PlanReportRes, type PlanReportRow } from '@/components/PlanReport';
import EditLine from '@/components/EditLine';
import { SRC_INFO, SRC_ORDER } from '@/lib/mapping';
import { ACTION_HELP, insights, matchView, todayLocal, type Action, type Insight, type View } from '@/lib/smart';


export interface RoundInfo { id: string; plant: string | null; round: number; lines: number; qty: number; done: number; src_at: string | null; src_user: string | null }
interface PullPlan { pickRolls?: { week: string; line: string; pallet: string; qty: number; roll_qty: number | null }[]; weekPlants?: string[]; weekPlant?: string | null; type?: 'week' | 'day'; day?: string | null; days?: { day: string; week: string; lines: number; done: number; qty: number }[]; rounds?: RoundInfo[]; week: string | null; prevWeek?: string | null; rev?: string | null; weeks: WeekInfo[]; rows: Line[]; dispatch?: DispatchSummary; plants?: PlantInfo[]; received?: { period?: string; code: string; received: string | null }[]; releases?: { key: string; qi: number; block: number; by_user: string; at: string; active: boolean }[]; uploads: Upload[]; counts: { src: string; n: number }[]; generatedAt: string; time?: { soliPerHour?: number; lateGraceMin?: number; defaultTarget?: string } }

/** "2026-W42" → "Week 42" */
const weekLabel = (w: string | null | undefined) => (w ? `Week ${Number(w.slice(-2))}` : '');
const weekRange = (w: WeekInfo | undefined) => (w?.start ? `${fmtDate(w.start)} – ${fmtDate(w.end)}` : '');

/** The plan a status belongs to: the week for a week plan, the day for a day plan. */
/** the plan a line belongs to: the week, a day plan round ("<day>~<plant>~<n>"), or (older day plans) the day */
export { periodOf };
/** "2026-10-20~C064~2" → { plant: 'C064', round: 2 } */
export const roundOf = (w: string | null | undefined) => { const m = /^\d{4}-\d{2}-\d{2}~([^~]*)~(\d+)$/.exec(w || ''); return m ? { plant: m[1] === '-' ? '' : m[1], round: Number(m[2]) } : null; };
const dayLabel = (d: string) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

/** Week plan dashboard (planType "week") and Day plan dashboard (planType "day"): the same tracking, separate plans. */
export default function Dashboard({ planType = 'week' }: { planType?: 'week' | 'day' }) {
  const isDay = planType === 'day';
  const { user, guest, subscribe, toast, live } = useShell();
  const [data, setData] = useState<PullPlan | null>(null);
  const [err, setErr] = useState('');
  const [flash, setFlash] = useState<Set<string>>(new Set());
  const [, tick] = useState(0);
  // null = follow the most recent week; a value = the week someone picked
  const [pickedWeek, setPickedWeek] = useState<string | null>(null);
  // day plan: one round (Pick No of a plant) or the whole day (null)
  const [round, setRound] = useState<string | null>(null);
  // v136: the day cards — a date range (From / To), kept in this browser
  const [range, setRange0] = useState<{ from: string; to: string }>(() => { try { const v = JSON.parse(localStorage.getItem('mas-day-range') || '{}'); return { from: String(v.from || ''), to: String(v.to || '') }; } catch { return { from: '', to: '' }; } });
  const setRange = (r: { from: string; to: string }) => { setRange0(r); try { localStorage.setItem('mas-day-range', JSON.stringify(r)); } catch { /* private mode */ } };
  // the chosen card scrolled into view in its row
  const chipRow = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = chipRow.current?.querySelector('.week-chip.on') as HTMLElement | null;
    const row = el?.closest('.scroll') as HTMLElement | null;
    if (el && row) row.scrollTo({ left: Math.max(0, el.offsetLeft - row.offsetLeft - 40), behavior: 'smooth' });
  // only when the chosen day or the dates change (not on every refresh — the user's scroll stays)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.day, range.from, range.to]);
  const roundRef = useRef(round); roundRef.current = round;
  useEffect(() => { setRound(null); }, [pickedWeek]);
  const weekRef = useRef<string | null>(null);
  weekRef.current = pickedWeek;
  // week plan: one plant (its own reports) or every plant ('')
  const [wPlant, setWPlant] = useState('');
  const wPlantRef = useRef(wPlant); wPlantRef.current = wPlant;
  useEffect(() => { setWPlant(''); }, [pickedWeek]);

  // filters
  const [date, setDate] = useState<string | null>(null);
  const [plant, setPlant] = useState('');
  const [state, setState] = useState<'all' | 'open' | 'done'>('open');
  const [cov, setCov] = useState<Coverage | ''>('');
  const [remark, setRemark] = useState('');
  const [search, setSearch] = useState('');
  const [full, setFull] = useState(false);
  const [view, setView] = useState<View>({ kind: 'all' });
  const [openInsight, setOpenInsight] = useState<Insight | null>(null);
  const [editing, setEditing] = useState<Line | 'new' | null>(null);
  // Summary (plant summary + insights) or Plan details (the line table); remembered in the URL hash
  const [tab, setTabState] = useState<'summary' | 'details' | 'picks'>('summary');
  useEffect(() => { if (location.hash === '#details') setTabState('details'); if (location.hash === '#picks') setTabState('picks'); }, []);
  const setTab = useCallback((t: 'summary' | 'details' | 'picks') => { setTabState(t); try { history.replaceState(null, '', t === 'summary' ? location.pathname : '#' + t); } catch { /* ignore */ } }, []);
  const searchRef = useRef<HTMLInputElement>(null);
  const tableRef = useRef<HTMLElement>(null);
  const [reportRid, setReportRid] = useState<string | null>(null);
  const today = todayLocal();

  // "/" jumps to search, Esc clears the smart view
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(t.tagName)) { e.preventDefault(); searchRef.current?.focus(); }
      if (e.key === 'Escape' && !/INPUT|TEXTAREA|SELECT/.test(t.tagName)) setView({ kind: 'all' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const load = useCallback(async () => {
    try {
      const w = weekRef.current, rd = roundRef.current;
      const wp = wPlantRef.current;
      const qs = isDay ? `?type=day${w ? '&day=' + encodeURIComponent(w) : ''}${rd ? '&round=' + encodeURIComponent(rd) : ''}` : w || wp ? `?${w ? 'week=' + encodeURIComponent(w) : ''}${wp ? `${w ? '&' : ''}plant=${encodeURIComponent(wp)}` : ''}` : '';
      const p = await api<PullPlan>('/api/pullplan' + qs + (qs ? userParam() : userParam(true)));
      if (w && (isDay ? p.day : p.week) !== w) setPickedWeek(null); // that plan was deleted: back to the latest
      setData(p); setErr('');
    } catch (e) { setErr(e instanceof Error ? e.message : 'Could not load data.'); }
  }, [isDay]);
  useEffect(() => { load(); }, [load, pickedWeek, round, wPlant]);
  // no timer: when someone uses the page, check if anything changed and reload only then
  // without realtime: on activity, and once a minute while the summary / picks are open (a reload only when something changed)
  useRefreshOnActivity(load, data ? data.rev ?? null : undefined, live !== 'live', tab === 'details' ? 0 : 60000);
  const [refreshing, setRefreshing] = useState(false);
  const refreshNow = async () => { setRefreshing(true); try { await load(); } finally { setRefreshing(false); } };
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 30000); return () => clearInterval(t); }, []);

  // realtime: a new upload reloads everything; a status edit patches the one line in place
  // several reports uploaded together arrive as a burst of messages: reload once, shortly after the last
  const reloadTimer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => subscribe((m) => {
    if (m.type === 'data') { clearTimeout(reloadTimer.current); reloadTimer.current = setTimeout(load, 400); }
    if (m.type === 'status') {
      // period = the week (or the day of a day plan); date = the one line (none: every line of that SO / LI / Item in the week)
      const { period, ...line } = m.line as Partial<Line> & { key: string; period?: string; week?: string };
      const per = period ?? line.week;
      setData((d) => d && { ...d, rows: d.rows.map((r) => (r.key === line.key && (!per || periodOf(r) === per) && (!('date' in line) || (r.date ?? null) === (line.date ?? null))
        ? { ...r, status: line.status ?? null, comment: line.comment ?? null, vehicle: line.vehicle ?? null, qi_note: line.qi_note ?? null, updated_by: line.updated_by ?? null, updated_at: line.updated_at ?? null,
            ...('hold' in line ? { hold: line.hold ?? null, hold_by: line.hold_by ?? null, hold_at: line.hold_at ?? null } : {}) } : r)) });
      setFlash((f) => new Set(f).add(line.key));
      setTimeout(() => setFlash((f) => { const n = new Set(f); n.delete(line.key); return n; }), 2300);
    }
  }), [subscribe, load]);

  const rows = data?.rows || [];
  // picks saved for this plan's lines (one per pick request)
  const pickCount = useMemo(() => rows.reduce((t, r) => t + (r.pick_reqs ?? 0), 0), [rows]);
  const dates = useMemo(() => Array.from(new Set(rows.map((r) => r.date || ''))).filter(Boolean).sort(), [rows]);
  const plants = useMemo(() => Array.from(new Set(rows.map((r) => r.plant || ''))).filter(Boolean).sort(), [rows]);
  const remarks = useMemo(() => Array.from(new Set(rows.map((r) => r.remarks || ''))).filter(Boolean).sort(), [rows]);
  const vehicles = useMemo(() => Array.from(new Set(rows.map((r) => r.vehicle || ''))).filter(Boolean).sort(), [rows]);

  // everything except the state filter feeds the KPIs and charts; the table also applies state and coverage
  const scoped = useMemo(() => rows.filter((r) =>
    (!date || r.date === date) && (!plant || r.plant === plant) && (!remark || r.remarks === remark)), [rows, date, plant, remark]);
  const tableRows = useMemo(() => {
    const s = search.trim().toLowerCase();
    return scoped.filter((r) =>
      (view.kind !== 'all' ? matchView(r, view, today) : state === 'all' || (state === 'done' ? isDone(r) : !isDone(r))) &&
      (!cov || coverage(r) === cov) &&
      (!s || [r.so, r.li, r.item, r.status, r.comment, r.vehicle, r.remarks, r.tn_number, r.stock_plant].join(' ').toLowerCase().includes(s)));
  }, [scoped, state, cov, search, view, today]);
  const t = useMemo(() => totals(scoped), [scoped]);
  const pickedQty = useMemo(() => scoped.reduce((x, r) => x + (r.picked ?? 0), 0), [scoped]);
  const pickedLines = useMemo(() => scoped.filter((r) => (r.picked ?? 0) > 0).length, [scoped]);
  const pickedRolls = useMemo(() => scoped.reduce((x, r) => x + (r.picked_rolls ?? 0), 0), [scoped]);
  // the Packing List of the lines on screen: its rolls (a pallet picked in pieces counts once) and the cut ones (pieces < the roll)
  const plRolls = useMemo(() => {
    const ids = new Set(scoped.map((l) => `${l.week}|${l.key}|${l.date ?? ''}`));
    const by = new Map<string, { q: number; full: number }>();
    for (const p of data?.pickRolls || []) {
      if (!ids.has(`${p.week}|${p.line}`)) continue;
      const x = by.get(p.pallet) || { q: 0, full: 0 };
      x.q += Number(p.qty) || 0; x.full = Math.max(x.full, Number(p.roll_qty) || 0); by.set(p.pallet, x);
    }
    const all = Array.from(by.values());
    const cut = all.filter((x) => x.full > 0 && x.q < x.full - 0.0005);
    return { rolls: all.length, cut: cut.length, cutQty: cut.reduce((t0, x) => t0 + x.q, 0), qty: all.reduce((t0, x) => t0 + x.q, 0) };
  }, [data, scoped]);
  // Plan UR: what the UR covers of the plan — each line's QTY, at most its UR (QTY 100 / UR 1000 → 100; QTY 100 / UR 50 → 50)
  const planUr = useMemo(() => {
    let v = 0, short = 0;
    for (const l of scoped) { const q = Number(l.qty) || 0, u0 = Math.max(0, Number(l.ur) || 0); v += Math.min(q, u0); if (u0 < q - 1e-9) short++; }
    return { v, short };
  }, [scoped]);
  // the plan report of what is on screen (each Pick of the day, or the week / its plant): ALRADY SEND, QI, BLOCK, POSIBAL PENDING
  const repIds = useMemo(() => (!data ? [] : isDay ? (round ? [round] : (data.rounds || []).map((r) => String(r.id))) : data.week ? [data.week] : []), [data, isDay, round]);
  const [repMap, setRepMap] = useState<Map<string, PlanReportRow> | null>(null);
  useEffect(() => {
    let stop = false;
    if (!repIds.length) { setRepMap(null); return; }
    Promise.all(repIds.map((id) => api<PlanReportRes>(`/api/plan-report?rid=${encodeURIComponent(id)}${!isDay && wPlant ? '&plant=' + encodeURIComponent(wPlant) : ''}`)
      .then((r) => r.rows.map((x) => [`${id}|${x.key}|${x.pick_date ?? ''}`, x] as [string, PlanReportRow])).catch(() => [] as [string, PlanReportRow][])))
      .then((all) => { if (!stop) setRepMap(new Map(all.flat())); });
    return () => { stop = true; };
  }, [repIds.join(','), wPlant, data?.generatedAt]); // eslint-disable-line react-hooks/exhaustive-deps
  const rep = useMemo(() => {
    if (!repMap) return null;
    const xs = scoped.map((l) => repMap.get(`${l.week}|${l.key}|${l.date ?? ''}`)).filter(Boolean) as PlanReportRow[];
    if (!xs.length) return null;
    // ALRADY SEND, QI and BLOCK are per SO / LI / Item (the same one on two days counts once); POSIBAL PENDING per line
    const byKey = new Map(xs.map((x) => [`${x.plant}|${x.key}`, x]));
    const u = Array.from(byKey.values());
    const sumU = (f: (x: PlanReportRow) => number) => u.reduce((t0, x) => t0 + (f(x) || 0), 0);
    const pp = xs.filter((x) => x.possible);
    // ZMM_TRR transfer notes of these lines (one TN can cover several lines)
    const tns = new Set(u.flatMap((x) => String(x.tn ?? '').split(',').map((t) => t.trim()).filter(Boolean)));
    return { sent: sumU((x) => x.sent), sentN: u.filter((x) => x.sent > 1e-9).length, qi: sumU((x) => x.qi), qiN: u.filter((x) => x.qi > 1e-9).length,
      block: sumU((x) => x.block), blockN: u.filter((x) => x.block > 1e-9).length, possible: pp.reduce((t0, x) => t0 + Number(x.possible), 0), possibleN: pp.length,
      tnCount: tns.size, tnLines: u.filter((x) => x.tn).length, tnQty: u.reduce((t0, x) => t0 + (Number(x.tn_qty) || 0), 0) };
  }, [repMap, scoped]);
  const tips = useMemo(() => insights(scoped, data?.uploads || [], today, data?.dispatch), [scoped, data?.uploads, today, data?.dispatch]);
  const viewCounts = useMemo(() => {
    const c: Record<string, number> = {};
    const views: [string, View][] = [['partdisp', { kind: 'partdisp' }], ['Dispatched', { kind: 'action', value: 'Dispatched' }], ['urgent', { kind: 'urgent' }], ['priority', { kind: 'priority' }], ['carried', { kind: 'carried' }],
      ...(['Ready to pull', 'Not in Korber', 'On hold', 'Release QI / Block', 'Partial pull', 'Follow up TN', 'No stock'] as Action[]).map((a) => [a, { kind: 'action', value: a }] as [string, View])];
    for (const [k, v] of views) c[k] = scoped.filter((r) => matchView(r, v, today)).length;
    return c;
  }, [scoped, today]);
  const openView = (v: View) => { setView(v); setTab('details'); setTimeout(() => tableRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80); };
  const viewKey = view.kind === 'action' ? view.value : view.kind;
  // week-over-week: compare this week with the previous one (only when no filter narrows the view)
  const thisW = data?.weeks.find((w) => w.week === data.week);
  const prevW = data?.weeks.find((w) => w.week === data?.prevWeek);
  const unfiltered = !date && !plant && !remark;
  const delta = (now: number, before: number, goodUp = false, pct = false) => {
    const d = pct ? (before ? (now - before) / before : 0) : now - before;
    const cls = Math.abs(d) < 1e-9 ? 'flat' : d > 0 ? 'up' : 'down';
    const txt = pct ? `${d > 0 ? '+' : ''}${Math.round(d * 100)}%` : `${d > 0 ? '+' : ''}${fmt(d)}`;
    return <span className={`delta ${goodUp ? 'good-up' : ''} ${cls}`}>{cls === 'flat' ? '=' : txt}</span>;
  };

  // ref = lineRef(line): the status belongs to that one line (the same SO / LI / Item on another date keeps its own)
  const save = useCallback(async (ref: string, field: 'status' | 'comment' | 'vehicle', value: string) => {
    setData((d) => d && { ...d, rows: d.rows.map((r) => (lineRef(r) === ref ? { ...r, [field]: value || null, updated_by: user.username } : r)) });
    const line = data?.rows.find((r) => lineRef(r) === ref);
    if (!line) return;
    try { await api('/api/status', { method: 'PATCH', body: { key: line.key, week: periodOf(line), date: line.date ?? null, [field]: value || null } }); }
    catch (e) { toast(e instanceof Error ? e.message : 'Save failed.'); load(); throw e; }
  }, [user.username, toast, load, data?.week, data?.rows]);

  const up = new Map((data?.uploads || []).map((u) => [u.src, u]));
  const canEdit = !guest && user.role !== 'viewer';
  // what is on screen: the week, the round, or (null week) the whole day of a day plan
  const period = isDay ? (data?.week || data?.day || null) : data?.week || null;
  const plantLabel = (code: string | null | undefined) => { const c = (code || '').toUpperCase(); const p = (data?.plants || []).find((x) => x.code.toUpperCase() === c); return p?.name || c || 'No plant'; };
  const roundLabel = (w: string | null | undefined) => { const r = roundOf(w); return r ? `${plantLabel(r.plant)} · Pick ${r.round}` : ''; };
  const filtersOn = !!(date || plant || remark || cov || search);

  if (err && !data) return <main className="page"><div className="notice bad">{err}</div></main>;

  return (
    <main className="page anim">
      <div className="page-head">
        <div>
          <h1>{isDay ? (data?.day ? <>Day plan · {dayLabel(data.day)} <span className="h1-sub">{data.week ? roundLabel(data.week) : 'all picks'}</span></> : 'Day plan tracking')
            : data?.week ? <>{weekLabel(data.week)} <span className="h1-sub">week plan</span></> : 'Week plan tracking'}</h1>
          <p>
            {data ? <>Calculated {ago(data.generatedAt)} from the latest uploads. {t.open > 0 ? <><b>{fmt(t.shortLines)}</b> open lines need <b>{fmt(t.short, 2)}</b> more than the Full UR stock holds.</> : 'All lines in view are done.'}</> : 'Loading…'}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn" onClick={refreshNow} disabled={refreshing} title="Load the latest data now">{refreshing ? 'Refreshing…' : '↻ Refresh'}</button>
          {canEdit && <Link className="btn" href="/upload/">Upload reports</Link>}
          <button className="btn primary" disabled={!tableRows.length} onClick={() => exportPullPlan(tableRows, isDay ? `MAS_Day_Plan_${data?.day || ''}${data?.week ? '_' + roundLabel(data.week).replace(/[^\w]+/g, '_') : ''}` : `MAS_Weekly_Plan_${(data?.week || '').replace('-', '_')}`)}>Export Excel ({fmt(tableRows.length)})</button>
        </div>
      </div>

      {!isDay && data && data.weeks.length > 0 && (() => {
        const chip = (w: WeekInfo) => {
          const on = w.week === data.week, i = data.weeks.indexOf(w);
          const pct = w.lines ? w.done / w.lines : 0;
          return (
            <button key={w.week} type="button" className={`week-chip ${on ? 'on' : ''}`} aria-pressed={on}
              onClick={() => { setPickedWeek(i === 0 ? null : w.week); setView({ kind: 'all' }); setDate(null); }}
              title={`${w.week} · ${weekRange(w)} · ${fmt(w.lines)} lines · ${fmt(w.done)} done${w.dispatched ? ` · ${fmt(w.dispatched, 2)} dispatched` : ''}`}>
              <b>{weekLabel(w.week)}</b>{i === 0 && <span className="latest">Latest</span>}
              <span className="wr">{weekRange(w)}</span>
              <span className="wbar"><i style={{ width: `${pct * 100}%` }} /></span>
              <span className="wn">{Math.round(pct * 100)}% done</span>
            </button>
          );
        };
        const ongoing = data.weeks.filter((w) => !w.lines || w.done < w.lines), complete = data.weeks.filter((w) => w.lines && w.done >= w.lines);
        return (
          <div className="plan-groups">
            <nav className="weeks" aria-label="Ongoing week plans"><span className="weeks-label">Ongoing</span>{ongoing.length ? ongoing.map(chip) : <span className="muted small">none</span>}</nav>
            {complete.length > 0 && <nav className="weeks done-group" aria-label="Completed week plans"><span className="weeks-label">Completed</span>{complete.map(chip)}</nav>}
            {pickedWeek && <button type="button" className="btn sm" onClick={() => setPickedWeek(null)}>Back to latest week</button>}
            {(data.weekPlants || []).length > 0 && (
              <nav className="weeks plant-chips" aria-label="Plant">
                <span className="weeks-label">Plant</span>
                <button type="button" className={`day-chip ${!wPlant ? 'on' : ''}`} aria-pressed={!wPlant} onClick={() => { setWPlant(''); setView({ kind: 'all' }); }}><b>All plants</b><span>{(data.weekPlants || []).length} plants</span></button>
                {(data.weekPlants || []).map((p) => (
                  <button key={p || '-'} type="button" className={`day-chip ${wPlant === p ? 'on' : ''}`} aria-pressed={wPlant === p} onClick={() => { setWPlant(p); setView({ kind: 'all' }); }}
                    title={`${plantLabel(p) || 'No plant'} — this plant's lines with the reports uploaded for ${data.week} + this plant`}><b>{plantLabel(p) || p || 'No plant'}</b><span>{p && plantLabel(p) !== p ? p : 'own reports'}</span></button>
                ))}
              </nav>
            )}
          </div>
        );
      })()}

      {isDay && data && (data.days || []).length > 0 && (() => {
        const chip = (d: { day: string; lines: number; done: number }) => {
          const on = d.day === data.day, pct = d.lines ? d.done / d.lines : 0;
          return (
            <button key={d.day} type="button" className={`week-chip ${on ? 'on' : ''}`} aria-pressed={on}
              onClick={() => { setPickedWeek(d.day); setView({ kind: 'all' }); setDate(null); }} title={`Day plan ${d.day} · ${fmt(d.lines)} lines · ${fmt(d.done)} done`}>
              <b>{dayLabel(d.day)}</b>{d.day === today && <span className="latest">Today</span>}
              <span className="wr">{fmt(d.lines)} lines</span>
              <span className="wbar"><i style={{ width: `${pct * 100}%` }} /></span>
              <span className="wn">{Math.round(pct * 100)}% done</span>
            </button>
          );
        };
        const all = data.days || [];
        // the date range (From / To): with none, the latest 30 days with a plan
        const days = all.filter((d) => (!range.from || d.day >= range.from) && (!range.to || d.day <= range.to)).slice(0, range.from || range.to ? 400 : 30);
        const ongoing = days.filter((d) => d.done < d.lines), complete = days.filter((d) => d.lines && d.done >= d.lines);
        const quick = (n: number) => { const t = new Date(Date.parse(today + 'T00:00:00Z') - n * 86400000).toISOString().slice(0, 10); setRange({ from: t, to: '' }); };
        return (
          <div className="plan-groups" ref={chipRow}>
            <div className="day-range" role="group" aria-label="Date range of the day plans">
              <span className="weeks-label">Dates</span>
              <label>From <input type="date" value={range.from} max={range.to || undefined} onChange={(e) => setRange({ ...range, from: e.target.value })} /></label>
              <label>To <input type="date" value={range.to} min={range.from || undefined} onChange={(e) => setRange({ ...range, to: e.target.value })} /></label>
              <button type="button" className="btn sm" onClick={() => quick(6)}>Last 7 days</button>
              <button type="button" className="btn sm" onClick={() => quick(29)}>Last 30 days</button>
              {(range.from || range.to) && <button type="button" className="btn sm" onClick={() => setRange({ from: '', to: '' })}>Clear</button>}
              <span className="muted small">{fmt(days.length)} of {fmt(all.length)} day{all.length === 1 ? '' : 's'}{!range.from && !range.to && all.length > 30 ? ' (latest 30)' : ''}</span>
            </div>
            <div className="chip-row"><span className="weeks-label">Ongoing</span>
              <nav className="weeks scroll" aria-label="Ongoing day plans">{ongoing.length ? ongoing.map(chip) : <span className="muted small">none in these dates</span>}</nav></div>
            {complete.length > 0 && <div className="chip-row"><span className="weeks-label">Completed</span>
              <nav className="weeks scroll done-group" aria-label="Completed day plans">{complete.map(chip)}</nav></div>}
          </div>
        );
      })()}

      {isDay && data && (data.rounds || []).length > 0 && (
        <div className="chip-row rounds-row"><span className="weeks-label">Pick</span>
        <nav className="days rounds scroll" aria-label="Picks of the day">
          <button type="button" className={`day-chip ${!round ? 'on' : ''}`} aria-pressed={!round} onClick={() => { setRound(null); setView({ kind: 'all' }); }}>
            <b>All picks</b><span>{fmt((data.rounds || []).reduce((t, r) => t + r.lines, 0))} lines</span></button>
          {(data.rounds || []).map((r) => (
            <button key={r.id} type="button" className={`day-chip ${round === r.id ? 'on' : ''} ${r.lines && r.done >= r.lines ? 'done' : ''}`} aria-pressed={round === r.id}
              onClick={() => { setRound(round === r.id ? null : r.id); setView({ kind: 'all' }); }} title={`${plantLabel(r.plant)} Pick ${r.round} · ${fmt(r.lines)} lines · ${fmt(r.done)} done · uploaded ${r.src_at ? fmtTime(r.src_at) : ''} by ${r.src_user || ''}`}>
              <b>{plantLabel(r.plant)} · Pick {r.round}</b><span>{fmt(r.lines)} lines{r.src_at ? ` · ${fmtTime(r.src_at)}` : ''}</span></button>
          ))}
          {(round ? (data.rounds || []).filter((r) => r.id === round) : (data.rounds || [])).map((r) => (
            <button key={'rep' + r.id} type="button" className="btn sm" onClick={() => setReportRid(r.id)} title="The plan report of this Pick — on screen and as Excel">📋 {(plantLabel(r.plant) || '').replace(/\s+/g, '').toUpperCase()}-{(data.day || '').slice(8, 10)}{(data.rounds || []).length > 1 ? ` · Pick ${r.round}` : ''}</button>
          ))}
        </nav></div>
      )}

      {!isDay && data && dates.length > 1 && (
        <nav className="days" aria-label="Day plan">
          <span className="weeks-label">Plan for</span>
          <button type="button" className={`day-chip ${!date ? 'on' : ''}`} aria-pressed={!date} onClick={() => setDate(null)}><b>Whole week</b><span>{fmt(rows.length)} lines</span></button>
          {dates.map((d) => {
            const n = rows.filter((r) => r.date === d);
            const open = n.filter((r) => !isDone(r)).length;
            return (
              <button key={d} type="button" className={`day-chip ${date === d ? 'on' : ''} ${d === today ? 'today' : ''}`} aria-pressed={date === d} onClick={() => setDate(date === d ? null : d)}
                title={`Day plan ${fmtDate(d)}: ${n.length} lines, ${open} open`}>
                <b>{new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })}{d === today ? ' · today' : ''}</b>
                <span>{fmt(n.length)} lines{open ? ` · ${fmt(open)} open` : ' · done'}</span>
              </button>
            );
          })}
        </nav>
      )}

      {data && rows.length > 0 && (() => {
        // At a glance: how far the plan is, and what to do next (each opens the lines or the page that does it)
        const pct = t.qty ? Math.min(100, (t.dispatched / t.qty) * 100) : 0;
        const linePct = t.lines ? (t.done / t.lines) * 100 : 0;
        const ready = viewCounts['Ready to pull'] ?? 0, notK = viewCounts['Not in Korber'] ?? 0, noStock = viewCounts['No stock'] ?? 0, hold = viewCounts['On hold'] ?? 0;
        const zAt = up.get('zmmbe')?.uploaded_at;
        const ageH = zAt ? Math.floor((Date.now() - new Date(zAt).getTime()) / 3600000) : null;
        const R = 34, C = 2 * Math.PI * R;
        return (
          <section className="glance" aria-label="At a glance">
            <div className="gl-ring" title={`${fmt(t.dispatched, 2)} of ${fmt(t.qty, 2)} picked`}>
              <svg viewBox="0 0 80 80" width="92" height="92" aria-hidden="true">
                <circle cx="40" cy="40" r={R} className="gl-track" />
                <circle cx="40" cy="40" r={R} className="gl-fill" strokeDasharray={`${(pct / 100) * C} ${C}`} transform="rotate(-90 40 40)" />
              </svg>
              <div className="gl-pct"><b>{Math.round(pct)}%</b><span>picked</span></div>
            </div>
            <div className="gl-text">
              <b>{t.open > 0 ? `${fmt(t.open)} line${t.open === 1 ? '' : 's'} still open` : 'All lines are done 🎉'}</b>
              <span>{compact(t.dispatched)} of {compact(t.qty)} QTY picked · {fmt(t.done)} of {fmt(t.lines)} lines done</span>
              <div className="gl-bar"><i style={{ width: `${linePct}%` }} /></div>
            </div>
            <div className="gl-actions">
              {canEdit && ready > 0 && <Link className="gl-act ok" href="/dispatch/"><b>{fmt(ready)}</b><span>Ready to pull — pick now</span></Link>}
              {notK > 0 && <button type="button" className="gl-act warn" onClick={() => openView({ kind: 'action', value: 'Not in Korber' })}><b>{fmt(notK)}</b><span>Not in Korber — check</span></button>}
              {noStock > 0 && <button type="button" className="gl-act bad" onClick={() => openView({ kind: 'action', value: 'No stock' })}><b>{fmt(noStock)}</b><span>No stock — follow up</span></button>}
              {hold > 0 && <button type="button" className="gl-act bad" onClick={() => openView({ kind: 'action', value: 'On hold' })}><b>{fmt(hold)}</b><span>On hold</span></button>}
              {canEdit && ageH !== null && ageH >= 24 && <Link className="gl-act warn" href="/upload/"><b>{ageH}h</b><span>ZMMBE is old — upload a new one</span></Link>}
              {!(ready || notK || noStock || hold) && <span className="gl-act ok"><b>✓</b><span>Nothing waiting</span></span>}
            </div>
          </section>
        );
      })()}

      {data && rows.length > 0 && <section className="kpis compact" aria-label="Key figures">
        <div className="kpi"><span className="k">Plan lines</span><span className={`v ${!data ? 'skel' : ''}`}><CountUp value={t.lines} format={(n) => fmt(n)} /></span>
          <span className="s">{fmt(t.done)} done · {fmt(t.open)} open</span>
          {unfiltered && prevW && thisW && <span className="s">vs {weekLabel(prevW.week)}: {fmt(prevW.lines)} {delta(thisW.lines, prevW.lines)}</span>}
          <div className="meter"><span style={{ width: `${t.lines ? (t.done / t.lines) * 100 : 0}%`, background: 'var(--ok)' }} /></div></div>
        <div className="kpi"><span className="k">Required QTY</span><span className="v"><CountUp value={t.qty} format={compact} /></span><span className="s" title="QTY − Assigned">Variance {compact(t.variance)}</span>{unfiltered && prevW && thisW && <span className="s">vs {weekLabel(prevW.week)}: {compact(prevW.qty)} {delta(thisW.qty, prevW.qty, false, true)}</span>}</div>
        <div className="kpi"><span className="k">Full UR stock</span><span className="v"><CountUp value={t.ur} format={compact} /></span><span className="s">QI {compact(t.qi)} · Block {compact(t.block)}</span></div>
        <div className="kpi"><span className="k">KFC / PFC UR</span><span className="v"><CountUp value={t.kfc_ur} format={compact} /></span><span className="s">PFC {compact(t.pfc_ur)}</span></div>
        <div className="kpi"><span className="k">Plan UR</span><span className="v"><CountUp value={planUr.v} format={compact} /></span><span className="s" title="Each line's QTY, at most its UR (Total − QI − Block − Assigned)">of QTY {compact(t.qty)} · {fmt(planUr.short)} lines short</span>
          <div className="meter"><span style={{ width: `${t.qty ? Math.min(100, (planUr.v / t.qty) * 100) : 0}%`, background: 'var(--ok)' }} /></div></div>
        {rep && <>
          <div className="kpi"><span className="k">Transfer notes</span><span className="v"><CountUp value={rep.tnCount} format={(n) => fmt(n)} /></span><span className="s" title="ZMM_TRR transfer requests of these SO lines">{fmt(rep.tnLines)} SO/LI lines · {compact(rep.tnQty)} QTY</span></div>
          <div className="kpi"><span className="k">Alrady send</span><span className="v"><CountUp value={rep.sent} format={compact} /></span><span className="s" title="ZMMBE at the plant storage locations (40 / 70 / 75)">{fmt(rep.sentN)} SO/LI lines · at the plant</span></div>
          <div className={`kpi ${rep.qiN ? 'warn' : ''}`}><span className="k">QI</span><span className="v"><CountUp value={rep.qi} format={compact} /></span><span className="s" title="SO QI stock (ZMMBE) — not picked until released">{fmt(rep.qiN)} SO/LI lines</span></div>
          <div className={`kpi ${rep.blockN ? 'bad' : ''}`}><span className="k">Block</span><span className="v"><CountUp value={rep.block} format={compact} /></span><span className="s" title="SO Blocked stock (ZMMBE) — not picked until released">{fmt(rep.blockN)} SO/LI lines</span></div>
          <button type="button" className="kpi kpi-btn em" disabled={repIds.length !== 1} onClick={() => repIds.length === 1 && setReportRid(repIds[0])}
            title={repIds.length === 1 ? 'Open the plan report — the lines the warehouse can send now' : 'Choose one Pick to open its plan report'}>
            <span className="k">Posibal pending</span><span className="v"><CountUp value={rep.possible} format={compact} /></span><span className="s">{fmt(rep.possibleN)} line{rep.possibleN === 1 ? '' : 's'} can be sent now</span></button>
        </>}
        <div className="kpi"><span className="k">PL rolls</span><span className="v"><CountUp value={plRolls.rolls} format={(n) => fmt(n)} /></span><span className="s" title="Rolls on the Packing List of these lines (a pallet picked in pieces counts once)">{compact(plRolls.qty)} QTY on the Packing List</span></div>
        <div className={`kpi ${plRolls.cut ? 'warn' : ''}`}><span className="k">Cut rolls</span><span className="v"><CountUp value={plRolls.cut} format={(n) => fmt(n)} /></span><span className="s" title="Rolls picked for less than the whole roll (they go on the KFC / PFC Cut Roll sheets)">{plRolls.rolls ? `${Math.round((plRolls.cut / plRolls.rolls) * 100)}% of the rolls · ${compact(plRolls.cutQty)} QTY` : 'no rolls picked'}</span></div>
        <div className="kpi"><span className="k">Picked</span><span className="v"><CountUp value={pickedQty} format={compact} /></span><span className="s">{fmt(pickedLines)} SO/LI lines · {fmt(pickedRolls)} rolls</span></div>
        {(
          <div className="kpi ok"><span className="k">Dispatched</span><span className="v"><CountUp value={t.dispatched} format={compact} /></span>
            <span className="s" title={`Balance ${compact(t.balance)}`}>{fmt(t.dispatchedLines)} line{t.dispatchedLines === 1 ? '' : 's'} complete</span>
            <div className="meter"><span style={{ width: `${t.qty ? Math.min(100, (t.dispatched / t.qty) * 100) : 0}%`, background: 'var(--ok)' }} /></div></div>
        )}
        <div className={`kpi ${t.shortLines ? 'bad' : 'ok'}`}><span className="k">Open & short of UR</span><span className="v"><CountUp value={t.shortLines} format={(n) => fmt(n)} /></span><span className="s">{compact(t.short)} QTY not covered</span></div>
        <div className="kpi"><span className="k">Stock coverage</span><span className="v"><CountUp value={t.lines ? (t.cov.Covered / t.lines) * 100 : 0} format={(n) => Math.round(n) + '%'} /></span>
          <span className="s">lines with UR ≥ QTY</span>
          <div className="meter">{COVERAGES.map((c) => <span key={c} title={`${c}: ${t.cov[c]}`} style={{ width: `${t.lines ? (t.cov[c] / t.lines) * 100 : 0}%`, background: COV_COLOR[c] }} />)}</div></div>
      </section>}

      {data && rows.length > 0 && (
        <section className="ins-wrap" aria-labelledby="ins-title">
          <div className="ins-head">
            <span className="ins-spark" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="22" height="22"><path d="M12 2l2.2 6.3L20.5 10l-6.3 2.2L12 18.5l-2.2-6.3L3.5 10l6.3-1.7z" fill="currentColor" /><path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z" fill="currentColor" opacity=".7" /></svg>
            </span>
            <div className="ins-titles">
              <h2 id="ins-title">Smart Insights <span className="ins-badge">Auto-generated</span></h2>
              <p>Analysed {fmt(scoped.length)} plan lines against {(data?.uploads || []).filter((u) => u.src !== 'plan').length} stock reports · {tips.length} finding{tips.length === 1 ? '' : 's'} · updated {ago(data?.generatedAt)}</p>
            </div>
            <span className={`ins-status ${live === 'live' ? 'on' : ''}`}><i />{live === 'live' ? 'Live analysis' : 'Updates when you use the page'}</span>
            <span className="ins-scan" aria-hidden="true" />
          </div>
          <div className="insights">
          {tips.map((i, n) => (
            <button key={i.id} type="button" className={`insight mini ${i.tone}`} style={{ animationDelay: `${n * 50}ms` }} disabled={!i.view}
              onClick={() => i.view && setOpenInsight(i)} title={`${i.title}. ${i.detail}`}>
              <span className="ic">{typeof i.count === 'number' ? fmt(i.count) : i.count}</span>
              <span className="il">{i.label}</span>
              {i.view && <span className="go" aria-hidden="true">→</span>}
            </button>
          ))}
          </div>
        </section>
      )}

      {data && rows.length > 0 && (
        <div className="tabs" role="tablist" aria-label="Dashboard view">
          <button role="tab" aria-selected={tab === 'summary'} className={tab === 'summary' ? 'on' : ''} onClick={() => setTab('summary')}>Summary</button>
          <button role="tab" aria-selected={tab === 'details'} className={tab === 'details' ? 'on' : ''} onClick={() => setTab('details')}>Plan details <span className="n">{fmt(tableRows.length)}</span></button>
          {!guest && <button role="tab" aria-selected={tab === 'picks'} className={tab === 'picks' ? 'on' : ''} onClick={() => setTab('picks')}>Completed picks{pickCount ? <span className="n">{fmt(pickCount)}</span> : null}</button>}
          {!guest && <Link href="/dispatch/" className="tabs-link" style={{ marginLeft: 'auto', alignSelf: 'center', fontSize: 13 }}>Dispatch →</Link>}
        </div>
      )}

      {tab === 'summary' && data && <div className="fresh" aria-label="Report freshness">
        {SRC_ORDER.map((s) => {
          const u = up.get(s);
          const stale = u && Date.now() - new Date(u.uploaded_at).getTime() > 12 * 3600 * 1000;
          return (
            <span key={s} className={`chip ${!u ? 'none' : stale ? 'stale' : ''}`} title={u ? `${u.file_name || ''} ${u.sheet_name ? '· ' + u.sheet_name : ''} · by ${u.uploaded_by}` : 'Not uploaded yet'}>
              <i /><b>{SRC_INFO[s].title}</b>{u ? `${fmt(u.row_count)} rows · ${ago(u.uploaded_at)}` : 'not uploaded'}
            </span>
          );
        })}
      </div>}

      {tab === 'summary' && period && rows.length > 0 && (
        <PlantSummary rows={date ? rows.filter((r) => r.date === date) : rows} plants={data!.plants || []} byRound={isDay}
          received={isDay ? (data!.received || []) : (data!.received || []).filter((r) => (r.period ?? data!.week) === (date || data!.week))} week={isDay ? period : date || data!.week!} day={isDay ? data!.day : date}
          canTarget={!guest && user.role === 'admin'} canEdit={canEdit} time={data!.time} live={live === 'live'} updatedAt={data!.generatedAt}
          onPlant={(c) => { setPlant(rows.some((r) => (r.plant || '').toUpperCase() === c) ? (rows.find((r) => (r.plant || '').toUpperCase() === c)!.plant || '') : ''); setView({ kind: 'all' }); setTab('details'); }}
          onSaved={(m) => { toast(m); load(); }} />
      )}


      {tab === 'picks' && !guest && period && rows.length > 0 && (
        <PlanPicks rows={date ? rows.filter((r) => r.date === date) : rows} label={isDay ? `${data!.day}${data!.week ? ' ' + roundLabel(data!.week) : ''}` : date || data!.week!} reloadKey={data!.generatedAt}
          plantName={(c) => plantLabel(c)} />
      )}

      {!data && !err && <PageLoading label={isDay ? 'Loading the day plan…' : 'Calculating the week plan from the latest uploads…'} tiles={8} rows={8} />}
      {data && rows.length === 0 ? (
        <div className="card empty">
          <strong>No weekly plan yet</strong>
          <span>Upload the weekly plan and the ZMMBE report to start tracking.</span>
          {canEdit && <Link className="btn primary" href="/upload/">Go to uploads</Link>}
        </div>
      ) : (
        <>


          {tab === 'details' && <>
          <div className="filters" role="group" aria-label="Filters">
            <select aria-label="Date" value={date || ''} onChange={(e) => setDate(e.target.value || null)}>
              <option value="">All dates</option>
              {dates.map((d) => <option key={d} value={d}>{fmtDate(d)}</option>)}
            </select>
            {plants.length > 0 && (
              <select aria-label="Plant" value={plant} onChange={(e) => setPlant(e.target.value)}>
                <option value="">All plants</option>{plants.map((p) => <option key={p}>{p}</option>)}
              </select>
            )}
            {remarks.length > 0 && (
              <select aria-label="Remarks" value={remark} onChange={(e) => setRemark(e.target.value)}>
                <option value="">All remarks</option>{remarks.map((p) => <option key={p}>{p}</option>)}
              </select>
            )}
            <select aria-label="Coverage" value={cov} onChange={(e) => setCov(e.target.value as Coverage | '')}>
              <option value="">Any coverage</option>{COVERAGES.map((c) => <option key={c}>{c}</option>)}
            </select>
            <div className="seg" role="group" aria-label="Done filter">
              {(['open', 'done', 'all'] as const).map((s) => <button key={s} className={state === s ? 'on' : ''} onClick={() => setState(s)}>{s === 'open' ? 'Open' : s === 'done' ? 'Done' : 'All'}</button>)}
            </div>
            <input ref={searchRef} type="search" placeholder="Search SO, item, TN, vehicle…  ( / )" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search" />
            {filtersOn && <button className="btn sm" onClick={() => { setDate(null); setPlant(''); setRemark(''); setCov(''); setSearch(''); }}>Clear filters</button>}
          </div>

          <div className="main-full">
            <section className="card table-card" ref={tableRef}>
              <div className="table-head">
                <div>
                  <h2>Plan lines</h2>
                  <p className="sub" style={{ margin: 0 }}>{fmt(tableRows.length)} lines{canEdit ? ' · click Status, Comment or Vehicle to edit — everyone sees it instantly' : guest ? ' · view only — sign in to edit' : ''}</p>
                </div>
                {canEdit && period && <button type="button" className="btn" onClick={() => setEditing('new')}>+ Add line</button>}
                <div className="seg" role="group" aria-label="Columns">
                  <button className={!full ? 'on' : ''} onClick={() => setFull(false)}>Key columns</button>
                  <button className={full ? 'on' : ''} onClick={() => setFull(true)}>All columns</button>
                </div>
              </div>
              <div className="views" role="group" aria-label="Smart views">
                {([['all', 'All lines', { kind: 'all' }], ['urgent', 'Urgent', { kind: 'urgent' }], ['priority', 'Priority', { kind: 'priority' }], ['carried', 'Carried over', { kind: 'carried' }],
                  ['Ready to pull', 'Ready to pull', { kind: 'action', value: 'Ready to pull' }], ['Not in Korber', 'Not in Korber', { kind: 'action', value: 'Not in Korber' }], ['On hold', 'On hold', { kind: 'action', value: 'On hold' }], ['Release QI / Block', 'Release QI / Block', { kind: 'action', value: 'Release QI / Block' }],
                  ['Partial pull', 'Partial pull', { kind: 'action', value: 'Partial pull' }], ['Follow up TN', 'Follow up TN', { kind: 'action', value: 'Follow up TN' }],
                  ['No stock', 'No stock', { kind: 'action', value: 'No stock' }],
                  ...((data?.dispatch?.items.length ? [['partdisp', 'Part dispatched', { kind: 'partdisp' }], ['Dispatched', 'Dispatched ✓', { kind: 'action', value: 'Dispatched' }]] : []) as [string, string, View][])] as [string, string, View][]).map(([k, label, v]) => (
                  <button key={k} type="button" className={`view-chip ${viewKey === k ? 'on' : ''} v-${k.replace(/[^a-z]/gi, '').toLowerCase()}`} onClick={() => setView(v)}
                    title={k in ACTION_HELP ? ACTION_HELP[k as Action] : k === 'urgent' ? 'Due today or overdue and not covered by UR' : k === 'priority' ? '1st priority / last pallet lines still open' : k === 'carried' ? 'In last week\'s plan too and not Done there' : k === 'partdisp' ? 'Some QTY dispatched, balance still to send' : 'Uses the Open / Done filter'}>
                    {label}{k !== 'all' && <span className="n">{fmt(viewCounts[k] ?? 0)}</span>}
                  </button>
                ))}
              </div>
              <Ledger rows={tableRows} canEdit={canEdit} full={full} flash={flash} onSave={save} onEdit={(l) => setEditing(l)} />
              <datalist id="status-options">{STATUS_OPTIONS.map((s) => <option key={s} value={s} />)}</datalist>
              <datalist id="vehicle-options">{vehicles.map((s) => <option key={s} value={s} />)}</datalist>
            </section>

          </div>
          </>}
        </>
      )}
      {reportRid && <PlanReport rid={reportRid} onClose={() => setReportRid(null)} />}
      {openInsight?.view && period && (
        <InsightDrawer insight={openInsight} week={period} canEdit={canEdit}
          rows={scoped.filter((r) => matchView(r, openInsight.view!, today))}
          onEdit={(l) => setEditing(l)}
          onShowInTable={() => { const v = openInsight.view!; setOpenInsight(null); openView(v); }}
          onReleased={(m) => { toast(m); load(); }}
          onClose={() => setOpenInsight(null)} />
      )}
      {editing && period && (
        <EditLine line={editing === 'new' ? null : editing} week={editing !== 'new' && isDay ? editing.week : isDay ? data?.week || '' : period} planType={planType} day={isDay ? data?.day || '' : undefined}
          onClose={() => setEditing(null)}
          onSaved={(msg) => { toast(msg); load(); }} />
      )}
    </main>
  );
}
