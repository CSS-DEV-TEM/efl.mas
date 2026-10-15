'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import Shell, { useShell } from '@/components/Shell';
import Ledger, { STATUS_OPTIONS } from '@/components/Ledger';
import { ProgressByDate, QtyByDate, COV_COLOR } from '@/components/Charts';
import { api } from '@/lib/api';
import { COVERAGES, ago, compact, coverage, fmt, fmtDate, isDone, totals, type Coverage, type Line, type Upload } from '@/lib/calc';
import { exportPullPlan } from '@/lib/export';
import { SRC_INFO, SRC_ORDER } from '@/lib/mapping';

export default function Page() {
  return <Shell><Dashboard /></Shell>;
}

interface PullPlan { rows: Line[]; uploads: Upload[]; counts: { src: string; n: number }[]; generatedAt: string }
interface Activity { at: string; username: string; action: string; detail: string }

function Dashboard() {
  const { user, subscribe, online, toast } = useShell();
  const [data, setData] = useState<PullPlan | null>(null);
  const [err, setErr] = useState('');
  const [activity, setActivity] = useState<Activity[]>([]);
  const [flash, setFlash] = useState<Set<string>>(new Set());
  const [, tick] = useState(0);

  // filters
  const [date, setDate] = useState<string | null>(null);
  const [plant, setPlant] = useState('');
  const [state, setState] = useState<'all' | 'open' | 'done'>('open');
  const [cov, setCov] = useState<Coverage | ''>('');
  const [remark, setRemark] = useState('');
  const [search, setSearch] = useState('');
  const [full, setFull] = useState(false);

  const load = useCallback(async () => {
    try {
      const [p, a] = await Promise.all([api<PullPlan>('/api/pullplan'), api<{ activity: Activity[] }>('/api/activity')]);
      setData(p); setActivity(a.activity); setErr('');
    } catch (e) { setErr(e instanceof Error ? e.message : 'Could not load data.'); }
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 30000); return () => clearInterval(t); }, []);

  // realtime: a new upload reloads everything; a status edit patches the one line in place
  // several reports uploaded together arrive as a burst of messages: reload once, shortly after the last
  const reloadTimer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => subscribe((m) => {
    if (m.type === 'data') { clearTimeout(reloadTimer.current); reloadTimer.current = setTimeout(load, 400); }
    if (m.type === 'status') {
      const line = m.line as Partial<Line> & { key: string };
      setData((d) => d && { ...d, rows: d.rows.map((r) => (r.key === line.key ? { ...r, ...line } : r)) });
      setActivity((a) => [{ at: String(m.at), username: String(m.by), action: 'edit', detail: `${line.key.replace(/\|/g, ' / ')}: ${line.status ?? ''} ${line.comment ?? ''}`.trim() }, ...a].slice(0, 60));
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
      (state === 'all' || (state === 'done' ? isDone(r) : !isDone(r))) &&
      (!cov || coverage(r) === cov) &&
      (!s || [r.so, r.li, r.item, r.status, r.comment, r.vehicle, r.remarks, r.tn_number, r.stock_plant].join(' ').toLowerCase().includes(s)));
  }, [scoped, state, cov, search]);
  const t = useMemo(() => totals(scoped), [scoped]);

  const save = useCallback(async (key: string, field: 'status' | 'comment' | 'vehicle', value: string) => {
    setData((d) => d && { ...d, rows: d.rows.map((r) => (r.key === key ? { ...r, [field]: value || null, updated_by: user.username } : r)) });
    try { await api('/api/status', { method: 'PATCH', body: { key, [field]: value || null } }); }
    catch (e) { toast(e instanceof Error ? e.message : 'Save failed.'); load(); throw e; }
  }, [user.username, toast, load]);

  const up = new Map((data?.uploads || []).map((u) => [u.src, u]));
  const canEdit = user.role !== 'viewer';
  const filtersOn = !!(date || plant || remark || cov || search);

  if (err && !data) return <main className="page"><div className="notice bad">{err}</div></main>;

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1>Pull plan tracking</h1>
          <p>
            {data ? <>Calculated {ago(data.generatedAt)} from the latest uploads. {t.open > 0 ? <><b>{fmt(t.shortLines)}</b> open lines need <b>{fmt(t.short, 0)}</b> more than the Full UR stock holds.</> : 'All lines in view are done.'}</> : 'Loading…'}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {canEdit && <Link className="btn" href="/upload/">Upload reports</Link>}
          <button className="btn primary" disabled={!tableRows.length} onClick={() => exportPullPlan(tableRows)}>Export Excel ({fmt(tableRows.length)})</button>
        </div>
      </div>

      <div className="fresh" aria-label="Report freshness">
        {SRC_ORDER.map((s) => {
          const u = up.get(s);
          const stale = u && Date.now() - new Date(u.uploaded_at).getTime() > 12 * 3600 * 1000;
          return (
            <span key={s} className={`chip ${!u ? 'none' : stale ? 'stale' : ''}`} title={u ? `${u.file_name || ''} ${u.sheet_name ? '· ' + u.sheet_name : ''} · by ${u.uploaded_by}` : 'Not uploaded yet'}>
              <i /><b>{SRC_INFO[s].title}</b>{u ? `${fmt(u.row_count)} rows · ${ago(u.uploaded_at)}` : 'not uploaded'}
            </span>
          );
        })}
      </div>

      {data && rows.length === 0 ? (
        <div className="card empty">
          <strong>No pull plan yet</strong>
          <span>Upload the pull plan and the ZMMBE, KFC, PFC, PLANT and TRR reports to start tracking.</span>
          {canEdit && <Link className="btn primary" href="/upload/">Go to uploads</Link>}
        </div>
      ) : (
        <>
          <section className="kpis" aria-label="Key figures">
            <div className="kpi"><span className="k">Plan lines</span><span className={`v ${!data ? 'skel' : ''}`}>{fmt(t.lines)}</span>
              <span className="s">{fmt(t.done)} done · {fmt(t.open)} open</span>
              <div className="meter"><span style={{ width: `${t.lines ? (t.done / t.lines) * 100 : 0}%`, background: 'var(--ok)' }} /></div></div>
            <div className="kpi"><span className="k">Required QTY</span><span className="v">{compact(t.qty)}</span><span className="s">Variance (QTY − Assigned) {compact(t.variance)}</span></div>
            <div className="kpi"><span className="k">Full UR stock</span><span className="v">{compact(t.ur)}</span><span className="s">QI {compact(t.qi)} · Block {compact(t.block)}</span></div>
            <div className="kpi"><span className="k">KFC / PFC UR</span><span className="v">{compact(t.kfc_ur)}</span><span className="s">PFC {compact(t.pfc_ur)}</span></div>
            <div className="kpi"><span className="k">At plant (PLANT)</span><span className="v">{compact(t.plant_qty)}</span><span className="s">TN QTY {compact(t.tn_qty)}</span></div>
            <div className={`kpi ${t.shortLines ? 'bad' : 'ok'}`}><span className="k">Open & short of UR</span><span className="v">{fmt(t.shortLines)}</span><span className="s">{compact(t.short)} QTY not covered</span></div>
            <div className="kpi"><span className="k">Stock coverage</span><span className="v">{t.lines ? Math.round((t.cov.Covered / t.lines) * 100) : 0}%</span>
              <span className="s">lines with UR ≥ QTY</span>
              <div className="meter">{COVERAGES.map((c) => <span key={c} title={`${c}: ${t.cov[c]}`} style={{ width: `${t.lines ? (t.cov[c] / t.lines) * 100 : 0}%`, background: COV_COLOR[c] }} />)}</div></div>
          </section>

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
            <input type="search" placeholder="Search SO, item, TN, vehicle, comment…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search" />
            {filtersOn && <button className="btn sm" onClick={() => { setDate(null); setPlant(''); setRemark(''); setCov(''); setSearch(''); }}>Clear filters</button>}
          </div>

          <div className="grid2">
            <section className="card">
              <h2>Required QTY by date</h2>
              <p className="sub">Split by Full UR coverage. Click a date to filter.</p>
              <QtyByDate rows={scoped} picked={date} onPick={setDate} />
            </section>
            <section className="card">
              <h2>Progress by date</h2>
              <p className="sub">Lines marked Done in the Status column.</p>
              <ProgressByDate rows={scoped} />
            </section>
          </div>

          <div className="main-split">
            <section className="card table-card">
              <div className="table-head">
                <div>
                  <h2>Pull plan lines</h2>
                  <p className="sub" style={{ margin: 0 }}>{fmt(tableRows.length)} lines{canEdit ? ' · click Status, Comment or Vehicle to edit — everyone sees it instantly' : ''}</p>
                </div>
                <div className="seg" role="group" aria-label="Columns">
                  <button className={!full ? 'on' : ''} onClick={() => setFull(false)}>Key columns</button>
                  <button className={full ? 'on' : ''} onClick={() => setFull(true)}>All columns</button>
                </div>
              </div>
              <Ledger rows={tableRows} canEdit={canEdit} full={full} flash={flash} onSave={save} />
              <datalist id="status-options">{STATUS_OPTIONS.map((s) => <option key={s} value={s} />)}</datalist>
              <datalist id="vehicle-options">{vehicles.map((s) => <option key={s} value={s} />)}</datalist>
            </section>

            <aside className="card">
              <h2>Live activity</h2>
              <p className="sub">Who is online and what changed.</p>
              <div className="online">{online.length ? online.map((u) => <span key={u}>{u}</span>) : <span className="muted" style={{ background: 'none' }}>Connecting…</span>}</div>
              <div className="feed">
                {activity.length === 0 && <div className="muted">Nothing yet.</div>}
                {activity.map((a, i) => (
                  <div key={i}>
                    <div>{a.detail}</div>
                    <div className="meta">{a.username} · {ago(a.at)}</div>
                  </div>
                ))}
              </div>
            </aside>
          </div>
        </>
      )}
    </main>
  );
}
