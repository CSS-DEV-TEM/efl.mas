'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import Shell, { useShell } from '@/components/Shell';
import Ledger, { STATUS_OPTIONS } from '@/components/Ledger';
import { COV_COLOR } from '@/components/Charts';
import PlantSummary from '@/components/PlantSummary';
import type { PlantInfo } from '@/lib/summary';
import { api, userParam } from '@/lib/api';
import { useRefreshOnActivity } from '@/lib/freshness';
import { COVERAGES, type DispatchSummary, ago, compact, coverage, fmt, fmtDate, isDone, totals, type Coverage, type Line, type Upload, type WeekInfo } from '@/lib/calc';
import { exportPullPlan } from '@/lib/export';
import { CountUp } from '@/components/Brand';
import InsightDrawer from '@/components/InsightDrawer';
import EditLine from '@/components/EditLine';
import { SRC_INFO, SRC_ORDER } from '@/lib/mapping';
import { ACTION_HELP, insights, matchView, todayLocal, type Action, type Insight, type View } from '@/lib/smart';

export default function Page() {
  return <Shell allowGuest><Dashboard /></Shell>;
}

interface PullPlan { week: string | null; prevWeek?: string | null; rev?: string | null; weeks: WeekInfo[]; rows: Line[]; dispatch?: DispatchSummary; plants?: PlantInfo[]; received?: { period?: string; code: string; received: string | null }[]; releases?: { key: string; qi: number; block: number; by_user: string; at: string; active: boolean }[]; uploads: Upload[]; counts: { src: string; n: number }[]; generatedAt: string }

/** "2026-W42" → "Week 42" */
const weekLabel = (w: string | null | undefined) => (w ? `Week ${Number(w.slice(-2))}` : '');
const weekRange = (w: WeekInfo | undefined) => (w?.start ? `${fmtDate(w.start)} – ${fmtDate(w.end)}` : '');

function Dashboard() {
  const { user, guest, subscribe, toast, live } = useShell();
  const [data, setData] = useState<PullPlan | null>(null);
  const [err, setErr] = useState('');
  const [flash, setFlash] = useState<Set<string>>(new Set());
  const [, tick] = useState(0);
  // null = follow the most recent week; a value = the week someone picked
  const [pickedWeek, setPickedWeek] = useState<string | null>(null);
  const weekRef = useRef<string | null>(null);
  weekRef.current = pickedWeek;

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
  const [tab, setTabState] = useState<'summary' | 'details'>('summary');
  useEffect(() => { if (location.hash === '#details') setTabState('details'); }, []);
  const setTab = useCallback((t: 'summary' | 'details') => { setTabState(t); try { history.replaceState(null, '', t === 'details' ? '#details' : location.pathname); } catch { /* ignore */ } }, []);
  const searchRef = useRef<HTMLInputElement>(null);
  const tableRef = useRef<HTMLElement>(null);
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
      const w = weekRef.current;
      const p = await api<PullPlan>('/api/pullplan' + (w ? '?week=' + encodeURIComponent(w) + userParam() : userParam(true)));
      if (w && p.week !== w) setPickedWeek(null); // that week was deleted: back to the latest
      setData(p); setErr('');
    } catch (e) { setErr(e instanceof Error ? e.message : 'Could not load data.'); }
  }, []);
  useEffect(() => { load(); }, [load, pickedWeek]);
  // no timer: when someone uses the page, check if anything changed and reload only then
  useRefreshOnActivity(load, data ? data.rev ?? null : undefined, live !== 'live');
  const [refreshing, setRefreshing] = useState(false);
  const refreshNow = async () => { setRefreshing(true); try { await load(); } finally { setRefreshing(false); } };
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 30000); return () => clearInterval(t); }, []);

  // realtime: a new upload reloads everything; a status edit patches the one line in place
  // several reports uploaded together arrive as a burst of messages: reload once, shortly after the last
  const reloadTimer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => subscribe((m) => {
    if (m.type === 'data') { clearTimeout(reloadTimer.current); reloadTimer.current = setTimeout(load, 400); }
    if (m.type === 'status') {
      const line = m.line as Partial<Line> & { key: string };
      setData((d) => d && { ...d, rows: d.rows.map((r) => (r.key === line.key && (!line.week || r.week === line.week) ? { ...r, ...line } : r)) });
      setFlash((f) => new Set(f).add(line.key));
      setTimeout(() => setFlash((f) => { const n = new Set(f); n.delete(line.key); return n; }), 2300);
    }
  }), [subscribe, load]);

  const rows = data?.rows || [];
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
  const tips = useMemo(() => insights(scoped, data?.uploads || [], today, data?.dispatch), [scoped, data?.uploads, today, data?.dispatch]);
  const viewCounts = useMemo(() => {
    const c: Record<string, number> = {};
    const views: [string, View][] = [['partdisp', { kind: 'partdisp' }], ['Dispatched', { kind: 'action', value: 'Dispatched' }], ['urgent', { kind: 'urgent' }], ['priority', { kind: 'priority' }], ['carried', { kind: 'carried' }],
      ...(['Ready to pull', 'Release QI / Block', 'Partial pull', 'Follow up TN', 'No stock'] as Action[]).map((a) => [a, { kind: 'action', value: a }] as [string, View])];
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

  const save = useCallback(async (key: string, field: 'status' | 'comment' | 'vehicle', value: string) => {
    setData((d) => d && { ...d, rows: d.rows.map((r) => (r.key === key ? { ...r, [field]: value || null, updated_by: user.username } : r)) });
    try { await api('/api/status', { method: 'PATCH', body: { key, week: data?.week, [field]: value || null } }); }
    catch (e) { toast(e instanceof Error ? e.message : 'Save failed.'); load(); throw e; }
  }, [user.username, toast, load, data?.week]);

  const up = new Map((data?.uploads || []).map((u) => [u.src, u]));
  const canEdit = !guest && user.role !== 'viewer';
  const filtersOn = !!(date || plant || remark || cov || search);

  if (err && !data) return <main className="page"><div className="notice bad">{err}</div></main>;

  return (
    <main className="page anim">
      <div className="page-head">
        <div>
          <h1>{data?.week ? <>{weekLabel(data.week)} <span className="h1-sub">plan tracking</span></> : 'Weekly plan tracking'}</h1>
          <p>
            {data ? <>Calculated {ago(data.generatedAt)} from the latest uploads. {t.open > 0 ? <><b>{fmt(t.shortLines)}</b> open lines need <b>{fmt(t.short, 2)}</b> more than the Full UR stock holds.</> : 'All lines in view are done.'}</> : 'Loading…'}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn" onClick={refreshNow} disabled={refreshing} title="Load the latest data now">{refreshing ? 'Refreshing…' : '↻ Refresh'}</button>
          {canEdit && <Link className="btn" href="/upload/">Upload reports</Link>}
          <button className="btn primary" disabled={!tableRows.length} onClick={() => exportPullPlan(tableRows, `MAS_Weekly_Plan_${(data?.week || '').replace('-', '_')}`)}>Export Excel ({fmt(tableRows.length)})</button>
        </div>
      </div>

      {data && data.weeks.length > 0 && (
        <nav className="weeks" aria-label="Weeks">
          <span className="weeks-label">Week</span>
          {data.weeks.map((w, i) => {
            const on = w.week === data.week;
            const pct = w.lines ? w.done / w.lines : 0;
            return (
              <button key={w.week} type="button" className={`week-chip ${on ? 'on' : ''}`} aria-pressed={on}
                onClick={() => { setPickedWeek(i === 0 ? null : w.week); setView({ kind: 'all' }); setDate(null); }}
                title={`${w.week} · ${weekRange(w)} · ${fmt(w.lines)} lines · ${fmt(w.done)} done${w.dispatched ? ` · ${fmt(w.dispatched, 2)} dispatched` : ""}`}>
                <b>{weekLabel(w.week)}</b>{i === 0 && <span className="latest">Latest</span>}
                <span className="wr">{weekRange(w)}</span>
                <span className="wbar"><i style={{ width: `${pct * 100}%` }} /></span>
                <span className="wn">{Math.round(pct * 100)}% done</span>
              </button>
            );
          })}
          {pickedWeek && <button type="button" className="btn sm" onClick={() => setPickedWeek(null)}>Back to latest week</button>}
        </nav>
      )}

      {data && dates.length > 0 && (
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

      {data && rows.length > 0 && <section className="kpis compact" aria-label="Key figures">
        <div className="kpi"><span className="k">Plan lines</span><span className={`v ${!data ? 'skel' : ''}`}><CountUp value={t.lines} format={(n) => fmt(n)} /></span>
          <span className="s">{fmt(t.done)} done · {fmt(t.open)} open</span>
          {unfiltered && prevW && thisW && <span className="s">vs {weekLabel(prevW.week)}: {fmt(prevW.lines)} {delta(thisW.lines, prevW.lines)}</span>}
          <div className="meter"><span style={{ width: `${t.lines ? (t.done / t.lines) * 100 : 0}%`, background: 'var(--ok)' }} /></div></div>
        <div className="kpi"><span className="k">Required QTY</span><span className="v"><CountUp value={t.qty} format={compact} /></span><span className="s" title="QTY − Assigned">Variance {compact(t.variance)}</span>{unfiltered && prevW && thisW && <span className="s">vs {weekLabel(prevW.week)}: {compact(prevW.qty)} {delta(thisW.qty, prevW.qty, false, true)}</span>}</div>
        <div className="kpi"><span className="k">Full UR stock</span><span className="v"><CountUp value={t.ur} format={compact} /></span><span className="s">QI {compact(t.qi)} · Block {compact(t.block)}</span></div>
        <div className="kpi"><span className="k">KFC / PFC UR</span><span className="v"><CountUp value={t.kfc_ur} format={compact} /></span><span className="s">PFC {compact(t.pfc_ur)}</span></div>
        <div className="kpi"><span className="k">At plant (PLANT)</span><span className="v"><CountUp value={t.plant_qty} format={compact} /></span><span className="s">TN QTY {compact(t.tn_qty)}</span></div>
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
          {!guest && <Link href="/dispatch/" className="tabs-link" style={{ marginLeft: 'auto', alignSelf: 'center', fontSize: 13 }}>Dispatch →</Link>}
        </div>
      )}

      {tab === 'summary' && <div className="fresh" aria-label="Report freshness">
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

      {tab === 'summary' && data?.week && rows.length > 0 && (
        <PlantSummary rows={date ? rows.filter((r) => r.date === date) : rows} plants={data.plants || []}
          received={(data.received || []).filter((r) => (r.period ?? data.week) === (date || data.week))} week={date || data.week} day={date}
          canTarget={!guest && user.role === 'admin'} canEdit={canEdit}
          onPlant={(c) => { setPlant(rows.some((r) => (r.plant || '').toUpperCase() === c) ? (rows.find((r) => (r.plant || '').toUpperCase() === c)!.plant || '') : ''); setView({ kind: 'all' }); setTab('details'); }}
          onSaved={(m) => { toast(m); load(); }} />
      )}


      {data && rows.length === 0 ? (
        <div className="card empty">
          <strong>No weekly plan yet</strong>
          <span>Upload the weekly plan and the ZMMBE, KFC, PFC and PLANT reports to start tracking.</span>
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
                {canEdit && data?.week && <button type="button" className="btn" onClick={() => setEditing('new')}>+ Add line</button>}
                <div className="seg" role="group" aria-label="Columns">
                  <button className={!full ? 'on' : ''} onClick={() => setFull(false)}>Key columns</button>
                  <button className={full ? 'on' : ''} onClick={() => setFull(true)}>All columns</button>
                </div>
              </div>
              <div className="views" role="group" aria-label="Smart views">
                {([['all', 'All lines', { kind: 'all' }], ['urgent', 'Urgent', { kind: 'urgent' }], ['priority', 'Priority', { kind: 'priority' }], ['carried', 'Carried over', { kind: 'carried' }],
                  ['Ready to pull', 'Ready to pull', { kind: 'action', value: 'Ready to pull' }], ['Release QI / Block', 'Release QI / Block', { kind: 'action', value: 'Release QI / Block' }],
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
      {openInsight?.view && data?.week && (
        <InsightDrawer insight={openInsight} week={data.week} canEdit={canEdit}
          rows={scoped.filter((r) => matchView(r, openInsight.view!, today))}
          onEdit={(l) => setEditing(l)}
          onShowInTable={() => { const v = openInsight.view!; setOpenInsight(null); openView(v); }}
          onReleased={(m) => { toast(m); load(); }}
          onClose={() => setOpenInsight(null)} />
      )}
      {editing && data?.week && (
        <EditLine line={editing === 'new' ? null : editing} week={data.week}
          onClose={() => setEditing(null)}
          onSaved={(msg) => { toast(msg); load(); }} />
      )}
    </main>
  );
}
