'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, getSession, isBossRole, userParam } from '@/lib/api';
import { ago, fmt, fmtDate, fmtQty, type WeekInfo } from '@/lib/calc';
import { applyMapping, detectMapping, guessSrc, isHelpSheet, readWorkbook, type Grid } from '@/lib/mapping';
import { PICK_SRCS, PLAN_SHEET, pickSrcOf, squash, uploadPickSheets, type PickSrc } from '@/lib/pick';
import { todayLocal, weekDays, weekIdOf, weekOptions } from '@/lib/smart';
import PlanReport from '@/components/PlanReport';
import { useShell } from '@/components/Shell';

type Mode = 'add' | 'update' | 'replace';
interface Preview { weeks?: string[]; added: number; updated: number; same?: number; removed: number; kept: number; inFileDups: number; lines: number; plant: string | null; mode: string }
/** a sheet of the chosen file: the week plan, ZMMBE (stock) or a pick report — or left out */
interface Job { name: string; grid: Grid; kind: 'plan' | 'zmmbe' | 'pick' | 'skip'; pick?: PickSrc; why?: string; state?: 'wait' | 'busy' | 'ok' | 'err'; msg?: string }
interface RepStatus { src: string; uses: 'own' | 'shared' | 'none'; rows: number; own: { file_name: string | null; uploaded_by: string; uploaded_at: string } | null }

/** Add = a new plan of the plant · Update = only what is new or changed is written, the rest stays · Replace = the plant's plan out, the file in */
const MODES: [Mode, string, string][] = [
  ['add', 'Add', 'A new plan for this plant in the week (refused when the plant already has one — use Update or Replace)'],
  ['update', 'Update', 'The plant\'s plan is checked against the file: new lines are added and changed lines (QTY …) updated — only those; the other lines stay'],
  ['replace', 'Replace', 'The plant\'s plan in the week is removed and the file is uploaded in its place'],
];
const SERVER_MODE: Record<Mode, string> = { add: 'merge', update: 'merge', replace: 'replace-plant' };
const REP_NAME: Record<string, string> = { plan: 'Plan', zmmbe: 'ZMMBE', zinr: 'ZINSR', zcoment: 'SHADE (ZCOMENT)', zroll: 'ZROLLMGT', korber: 'KORBER', ztrr: 'ZMM_TRR' };
const weekLabel = (w: string) => { try { const [a, b] = weekDays(w); return `${w} · ${fmtDate(a)} – ${fmtDate(b)}`; } catch { return w; } };

/**
 * Week plan: its own tab, apart from the day plans and Picks. A file like ASIA_LINE_PENDING (the "ASIALLINE-23" plan sheet
 * + ZMMBE, ZMM_TRR, ZINSR, SHADE, ZROLLMGT, KORBER) is read sheet by sheet: the plan goes to the week of its dates, the
 * reports to that week only. Reports uploaded later (another file, without the plan) replace the week's reports and the
 * week plan is refreshed from them; the plan report (AVALABALE … TRANSFER NOTE) is worked out the same way as a Pick's.
 */
export default function WeekPlanManager({ toast, onChanged }: { toast: (m: string) => void; onChanged: () => void }) {
  const role = getSession()?.user.role;
  const canEdit = !!role && role !== 'viewer';
  const boss = isBossRole(role);
  const [weeks, setWeeks] = useState<WeekInfo[] | null>(null);
  const [sel, setSel] = useState('');
  const load = useCallback(() => {
    api<{ weeks: WeekInfo[] }>('/api/pullplan' + userParam(true)).then((r) => { setWeeks(r.weeks || []); setSel((s) => s || r.weeks?.[0]?.week || weekIdOf(todayLocal())); }).catch(() => setWeeks([]));
  }, []);
  useEffect(() => { load(); }, [load]);
  // the plants of the chosen week: each has its own reports (week + plant)
  const [wPlants, setWPlants] = useState<{ plant: string; lines: number; rid: string }[]>([]);
  const [selPlant, setSelPlant] = useState('');
  const selRef = useRef(sel); selRef.current = sel;
  const loadPlants = useCallback(() => {
    if (!sel) return;
    api<{ plants: { plant: string; lines: number; rid: string }[] }>('/api/week-plants?week=' + encodeURIComponent(sel)).then((r) => {
      if (selRef.current !== sel) return; // an answer for a week no longer chosen
      setWPlants(r.plants); setSelPlant((p) => (r.plants.some((x) => x.plant === p) ? p : r.plants.find((x) => x.plant)?.plant ?? ''));
    }).catch(() => setWPlants([]));
  }, [sel]);
  useEffect(() => { loadPlants(); }, [loadPlants]);
  const repRid = sel && selPlant ? `${sel}@${selPlant}` : '';
  // the reports of the chosen week + plant: its own upload, else the shared one
  const [reps, setReps] = useState<RepStatus[] | null>(null);
  const loadReps = useCallback(() => { if (repRid) api<{ reports: RepStatus[] }>('/api/pick/status?rid=' + encodeURIComponent(repRid)).then((r) => setReps(r.reports || [])).catch(() => setReps(null)); else setReps(null); }, [repRid]);
  useEffect(() => { loadReps(); }, [loadReps]);
  // someone uploaded a plan / report (this page or another): the weeks, plants and report status refresh by themselves
  const { subscribe } = useShell();
  useEffect(() => subscribe((m) => { if (m.type === 'data') { load(); loadPlants(); loadReps(); } }), [subscribe, load, loadPlants, loadReps]);
  const [plants, setPlants] = useState<{ code: string; name: string | null }[]>([]);
  useEffect(() => { api<{ plants: { code: string; name: string | null }[] }>('/api/plants').then((r) => setPlants(r.plants)).catch(() => {}); }, []);
  const [report, setReport] = useState<string | null>(null);

  const fileRef = useRef<HTMLInputElement | null>(null);
  const [file, setFile] = useState<{ name: string; sheets: ReturnType<typeof readWorkbook> } | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [auto, setAuto] = useState(true);
  const [week, setWeek] = useState(() => weekIdOf(todayLocal()));
  const [mode, setMode] = useState<Mode>('update');
  const [plant, setPlant] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const planJob = jobs.find((j) => j.kind === 'plan');
  const repJobs = jobs.filter((j) => j.kind === 'zmmbe' || j.kind === 'pick');

  const plantOf = (sheet: string) => {
    const m = PLAN_SHEET.exec(sheet);
    if (!m || m[1].toUpperCase().startsWith('SHEET')) return '';
    const want = squash(m[1]);
    const hit = plants.find((p) => squash(p.code) === want || (p.name && squash(p.name) === want));
    return (hit?.code || m[1].replace(/\s+/g, '')).toUpperCase();
  };
  const pickFile = async (f: File) => {
    setErr(''); setPreview(null);
    try {
      const sheets = readWorkbook(await f.arrayBuffer());
      const js: Job[] = [];
      for (const s of sheets) {
        if (!s.grid.length || isHelpSheet(s.name)) continue;
        if (/^al+re?a?dy\s*sen[dt]/i.test(s.name.trim())) { js.push({ name: s.name, grid: s.grid, kind: 'skip', why: 'made from ZMMBE' }); continue; }
        const ps = pickSrcOf(s.name);
        if (ps) { js.push({ name: s.name, grid: s.grid, kind: 'pick', pick: ps }); continue; }
        const g = guessSrc(s.name);
        if (g === 'zmmbe') { js.push({ name: s.name, grid: s.grid, kind: 'zmmbe' }); continue; }
        if (g === 'kfc' || g === 'pfc' || g === 'trr' || g === 'plant') { js.push({ name: s.name, grid: s.grid, kind: 'skip', why: 'built from ZMMBE' }); continue; }
        if (!js.some((j) => j.kind === 'plan') && detectMapping('plan', s.grid).how === 'header') { js.push({ name: s.name, grid: s.grid, kind: 'plan' }); continue; }
        js.push({ name: s.name, grid: s.grid, kind: 'skip', why: 'not a plan or a report' });
      }
      if (!js.some((j) => j.kind !== 'skip')) { setErr(`Nothing to upload in ${f.name}: no plan sheet (SO, LI, Item Code, QTY) and no ZMMBE / ZMM_TRR / ZINSR / SHADE / ZROLLMGT / KORBER sheet.`); return; }
      const pj = js.find((j) => j.kind === 'plan');
      // the plant: from the sheet name (ASIALLINE-23), else the plan's Plant column when it has one plant only
      let pc = pj ? plantOf(pj.name) : '';
      if (pj && !pc) {
        try {
          const ps = new Set(applyMapping('plan', pj.grid, detectMapping('plan', pj.grid)).map((r) => String((r as Record<string, unknown>).plant ?? '').trim().toUpperCase().replace(/\s+/g, '')).filter(Boolean));
          if (ps.size === 1) { const v = Array.from(ps)[0]; const hit = plants.find((p) => squash(p.code) === squash(v) || (p.name && squash(p.name) === squash(v))); pc = (hit?.code || v).toUpperCase(); }
        } catch { /* no plant column */ }
      }
      setPlant(pc); setAuto(true);
      setFile({ name: f.name, sheets }); setJobs(js);
    } catch { setErr('Could not read that file. Save it as .xlsx and try again.'); }
  };
  const setJob = (name: string, p: Partial<Job>) => setJobs((js) => js.map((j) => (j.name === name ? { ...j, ...p } : j)));
  const planBody = (dryRun: boolean) => {
    const map = detectMapping('plan', planJob!.grid);
    // the report columns of such a sheet (AVALABALE, ALRADY SEND …) are worked out by the system: not plan fields
    for (const k of ['qi_note', 'status', 'comment']) if ((map.cols as Record<string, number>)[k] !== undefined) (map.cols as Record<string, number>)[k] = -1;
    // every line goes to the chosen plant (Settings → Plants), whatever the file's Plant column says
    const pc = plant.trim().toUpperCase().replace(/\s+/g, '');
    const rows = applyMapping('plan', planJob!.grid, map).map((r) => (pc ? { ...(r as Record<string, unknown>), plant: pc } : r));
    return { src: 'plan', planType: 'week', fileName: file!.name, sheetName: planJob!.name, rows, mode: SERVER_MODE[mode], dryRun,
      ...(auto ? {} : { week, forceWeek: true }), ...(plant.trim() ? { plant: plant.trim().toUpperCase() } : {}) };
  };
  const check = async () => {
    if (!plant.trim()) { setErr('Choose the plant.'); return; }
    setBusy('check'); setErr(''); setPreview(null);
    try {
      const pv = await api<Preview>('/api/upload', { method: 'POST', body: planBody(true) });
      const pc = plant.trim().toUpperCase().replace(/\s+/g, '');
      // what the plant already has in the week(s) of the file
      const have: Record<string, number> = {};
      for (const w of pv.weeks || []) { try { const r = await api<{ plants: { plant: string; lines: number }[] }>('/api/week-plants?week=' + encodeURIComponent(w)); const x = r.plants.find((p) => p.plant === pc); if (x) have[w] = x.lines; } catch { /* none */ } }
      const had = Object.entries(have);
      if (mode === 'add' && had.length) { setErr(`${pc} already has a plan in ${had.map(([w, n]) => `${w} (${n} lines)`).join(', ')} — use Update (only new / changed lines) or Replace.`); return; }
      if (mode === 'update' && !had.length) { setErr(`${pc} has no plan in ${(pv.weeks || []).join(', ')} yet — use Add.`); return; }
      setPreview(pv);
    } catch (e) { setErr(e instanceof Error ? e.message : 'Could not check the file.'); }
    finally { setBusy(''); }
  };
  // the plan first (its week), then ZMMBE, then the pick reports (Korber keeps the week plan's items)
  const upload = async () => {
    const pnorm = (v: string) => v.trim().toUpperCase().replace(/\s+/g, '');
    if (planJob && repJobs.length && !pnorm(plant)) { setErr('Type the plant: the reports are linked to the week + plant.'); return; }
    if (!planJob && !repRid) { setErr('Choose the week and the plant the reports are for.'); return; }
    setBusy('up'); setErr('');
    // the reports go to the week + plant only (2026-W43@ASIALLINE)
    let target = planJob ? '' : repRid;
    try {
      if (planJob) {
        setJob(planJob.name, { state: 'busy' });
        const r = await api<Preview>('/api/upload', { method: 'POST', body: planBody(false) });
        const ws = r.weeks || [];
        setJob(planJob.name, { state: 'ok', msg: `${fmt(r.added)} new, ${fmt(r.updated)} updated${r.removed ? `, ${fmt(r.removed)} removed` : ''}${r.inFileDups ? `, ${fmt(r.inFileDups)} repeated rows (last kept)` : ''} → ${ws.join(', ')}` });
        if (ws.length === 1) target = `${ws[0]}@${pnorm(plant)}`;
        else if (repJobs.length) throw new Error(`The plan has lines in ${ws.join(', ')}: the reports need one week — choose the week above and upload again.`);
      }
      const order = [...repJobs].sort((a, b) => (a.kind === 'zmmbe' ? 0 : a.pick === 'korber' ? 2 : 1) - (b.kind === 'zmmbe' ? 0 : b.pick === 'korber' ? 2 : 1));
      for (const j of order) {
        setJob(j.name, { state: 'busy' });
        try {
          if (j.kind === 'zmmbe') {
            const map = detectMapping('zmmbe', j.grid);
            const r = await api<{ accepted: number; derived?: { kfc: number; pfc: number; plant: number | null } }>('/api/upload', { method: 'POST', body: { src: 'zmmbe', fileName: file!.name, sheetName: j.name, rows: applyMapping('zmmbe', j.grid, map), rid: target } });
            setJob(j.name, { state: 'ok', msg: `${fmt(r.accepted)} rows${r.derived?.plant ? ` · ${fmt(r.derived.plant)} plant-location rows → ALRADY SEND` : ''}` });
          } else {
            const sh = file!.sheets.filter((s) => s.name === j.name);
            const r = await uploadPickSheets(j.pick!, sh, file!.name, target);
            setJob(j.name, { state: 'ok', msg: `${fmt(r.rows)} rows${r.total > r.rows ? ` (of ${fmt(r.total)} — only the week plan's items)` : ''}` });
          }
        } catch (e) { setJob(j.name, { state: 'err', msg: e instanceof Error ? e.message : 'failed' }); }
      }
      toast(`Week plan ${target.replace('@', ' · ')}: ${planJob ? 'plan' : ''}${planJob && repJobs.length ? ' + ' : ''}${repJobs.length ? `${repJobs.length} report${repJobs.length === 1 ? '' : 's'}` : ''} uploaded`);
      setPreview(null);
      const [tw, tp] = target.split('@');
      if (tw) setSel(tw); if (tp) setSelPlant(tp);
      load(); loadPlants(); loadReps(); onChanged();
    } catch (e) { setErr(e instanceof Error ? e.message : 'Upload failed.'); }
    finally { setBusy(''); }
  };
  const del = async (w: string) => {
    if (!confirm(`Delete the week plan ${w}? Its lines are deleted (the day plans and Picks are not touched).`)) return;
    try { await api(`/api/data/plan?week=${encodeURIComponent(w)}`, { method: 'DELETE' }); toast(`Week plan ${w} deleted`); load(); onChanged(); } catch (e) { toast(e instanceof Error ? e.message : 'Could not delete.'); }
  };
  const done = jobs.length > 0 && jobs.every((j) => j.kind === 'skip' || j.state === 'ok' || j.state === 'err');

  return (
    <section className="card week-mgr" aria-labelledby="wk-title">
      <div className="sheet-top">
        <div>
          <h2 id="wk-title">Week plans</h2>
          <p className="sub" style={{ margin: 0 }}>Kept apart from the day plans and Picks. Upload the week plan file (e.g. ASIA LINE PENDING: the plan sheet + ZMMBE, ZMM_TRR, ZINSR, SHADE, ZROLLMGT, KORBER) — or the reports alone later: they replace the chosen week&apos;s reports and the week plan is refreshed from them.</p>
        </div>
        {canEdit && <>
          <button className="btn primary" onClick={() => fileRef.current?.click()}>⤒ Upload week plan / reports</button>
          <input ref={fileRef} type="file" hidden accept=".xlsx,.xls,.xlsm,.csv" onChange={(e) => { const f = e.target.files?.[0]; if (f) void pickFile(f); e.target.value = ''; }} />
        </>}
      </div>

      {file && jobs.length > 0 && (
        <div className="wk-up">
          <div className="wk-row">
            <label>File<b className="mono small">{file.name}</b></label>
            {planJob ? <label>Week of the plan
              <select value={auto ? 'auto' : week} onChange={(e) => { setPreview(null); if (e.target.value === 'auto') setAuto(true); else { setAuto(false); setWeek(e.target.value); } }}>
                <option value="auto">Auto from the dates</option>
                {weekOptions(weekIdOf(todayLocal())).map((w) => <option key={w} value={w}>{weekLabel(w)}</option>)}
              </select>
            </label> : <label>Reports go to week
              <select value={sel} onChange={(e) => setSel(e.target.value)}>
                {Array.from(new Set([...(weeks || []).map((w) => w.week), sel])).filter(Boolean).map((w) => <option key={w} value={w}>{weekLabel(w)}</option>)}
              </select>
            </label>}
            {!planJob && <label>Plant
              <select value={selPlant} onChange={(e) => setSelPlant(e.target.value)}>
                {wPlants.filter((x) => x.plant).map((x) => <option key={x.plant} value={x.plant}>{x.plant} · {x.lines} lines</option>)}
              </select>
            </label>}
            {planJob && <label>Plant (Settings)
              <select value={plant} onChange={(e) => { setPlant(e.target.value); setPreview(null); setErr(''); }}>
                <option value="">— choose the plant —</option>
                {plants.map((p) => <option key={p.code} value={p.code.toUpperCase()}>{p.code}{p.name && p.name !== p.code ? ` · ${p.name}` : ''}</option>)}
                {plant && !plants.some((p) => p.code.toUpperCase() === plant) && <option value={plant}>{plant} (from the file — not in Settings)</option>}
              </select>
            </label>}
          </div>
          <table className="mini wk-jobs" data-noexport>
            <thead><tr><th>Sheet</th><th>Goes to</th><th>Result</th></tr></thead>
            <tbody>{jobs.map((j) => (
              <tr key={j.name} className={j.kind === 'skip' ? 'muted' : ''}>
                <td><b>{j.name}</b></td>
                <td>{j.kind === 'plan' ? <span className="pill accent">Week plan{plant ? ` · ${plant}` : ''}</span> : j.kind === 'skip' ? <span className="pill mute">left out — {j.why}</span> : <span className="pill ok">{j.kind === 'zmmbe' ? 'ZMMBE' : REP_NAME[j.pick!] || PICK_SRCS.find((x) => x.src === j.pick)?.title} · week report</span>}</td>
                <td className="small">{j.state === 'busy' ? <span className="muted">Uploading…</span> : j.state === 'ok' ? <span className="ok-text">✓ {j.msg}</span> : j.state === 'err' ? <span className="bad-text">✗ {j.msg}</span> : ''}</td>
              </tr>
            ))}</tbody>
          </table>
          {planJob && <>
            <div className="seg" role="group" aria-label="How" style={{ marginTop: 8 }}>
              {MODES.map(([k, t, tip]) => <button key={k} className={mode === k ? 'on' : ''} title={tip} onClick={() => { setMode(k); setPreview(null); setErr(''); }}>{t}</button>)}
            </div>
            <p className="muted small" style={{ margin: '6px 0' }}>{MODES.find((m) => m[0] === mode)![2]}.</p>
          </>}
          {preview && <div className="notice info small">Check: <b>{fmt(preview.lines)}</b> lines → {(preview.weeks || []).join(', ')} · {fmt(preview.added)} new · {fmt(preview.updated)} changed · {fmt(preview.same ?? 0)} the same{mode === 'replace' ? ` · ${fmt(preview.removed)} removed` : ''}{mode === 'update' ? ` — only the ${fmt(preview.added + preview.updated)} new / changed lines are written` : ''}{preview.inFileDups ? ` · ${fmt(preview.inFileDups)} repeated rows (last kept)` : ''}{repJobs.length ? ` · then ${repJobs.length} report${repJobs.length === 1 ? '' : 's'} to ${(preview.weeks || [])[0] || 'that week'}` : ''}</div>}
          <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
            {planJob && <button className="btn" aria-busy={busy === 'check' || undefined} disabled={!!busy || done} onClick={check}>Check</button>}
            <button className="btn primary" aria-busy={busy === 'up' || undefined} disabled={!!busy || done || (!!planJob && !preview)} title={planJob && !preview ? 'Check the plan first' : ''} onClick={upload}>
              {planJob ? `Upload plan${repJobs.length ? ` + ${repJobs.length} report${repJobs.length === 1 ? '' : 's'}` : ''}` : `Upload ${repJobs.length} report${repJobs.length === 1 ? '' : 's'} to ${sel} · ${selPlant || '?'}`}
            </button>
            <button className="btn" disabled={!!busy} onClick={() => { setJobs([]); setFile(null); setPreview(null); }}>{done ? 'Close' : 'Cancel'}</button>
          </div>
        </div>
      )}
      {err && <div className="notice bad">{err}</div>}

      {weeks === null ? <p className="muted">Loading…</p> : !weeks.length ? <p className="muted">No week plan yet.</p> : (
        <div className="table-wrap" style={{ maxHeight: 280, marginTop: 8 }}>
          <table className="mini wk-list" data-noexport>
            <thead><tr><th>Week</th><th>Days</th><th className="n">Lines</th><th className="n">QTY</th><th className="n">Done</th><th className="n">Progress</th><th /></tr></thead>
            <tbody>{weeks.map((w) => {
              const pct = w.lines ? Math.round((w.done / w.lines) * 100) : 0;
              return (
                <tr key={w.week} className={sel === w.week ? 'on' : ''} onClick={() => setSel(w.week)} style={{ cursor: 'pointer' }}>
                  <td><b>{w.week}</b></td><td className="small">{w.start ? `${fmtDate(w.start)} – ${fmtDate(w.end)}` : '–'}</td>
                  <td className="n">{fmt(w.lines)}</td><td className="n">{fmtQty(w.qty)}</td><td className="n">{fmt(w.done)}</td>
                  <td className="n"><span className="wk-bar"><i style={{ width: `${pct}%` }} /></span> {pct}%</td>
                  <td style={{ whiteSpace: 'nowrap' }} onClick={(e) => e.stopPropagation()}>
                    <button className="btn sm" onClick={() => setReport(w.week)} title="AVALABALE, ALRADY SEND, Pending, POSIBAL PENDING, QI, BLOCK, TRANSFER NOTE — on screen and as Excel">📋 Report</button>{' '}
                    {boss && <button className="btn sm" onClick={() => del(w.week)}>Delete</button>}
                  </td>
                </tr>
              );
            })}</tbody>
          </table>
        </div>
      )}
      {sel && wPlants.length > 0 && (
        <div className="wk-reps" aria-label={`Plants of ${sel}`}>
          <span className="pick-tab-label">Plants of {sel}</span>
          <div className="seg" role="group">
            {wPlants.filter((x) => x.plant).map((x) => <button key={x.plant} className={selPlant === x.plant ? 'on' : ''} onClick={() => setSelPlant(x.plant)}>{x.plant} <span className="tab-n">{fmt(x.lines)}</span></button>)}
          </div>
        </div>
      )}
      {repRid && reps && (
        <div className="wk-reps" aria-label={`Reports of ${repRid}`}>
          <span className="pick-tab-label">Reports of {sel} · {selPlant}</span>
          {reps.filter((r) => r.src !== 'plan').map((r) => (
            <span key={r.src} className={`pill ${r.uses === 'own' ? 'ok' : r.uses === 'shared' ? 'warn' : 'bad'}`} title={r.own ? `${r.own.file_name || ''} · ${r.own.uploaded_by} · ${ago(r.own.uploaded_at)}` : r.uses === 'shared' ? 'No upload for this week: the shared report is used' : 'Not uploaded'}>
              {REP_NAME[r.src] || r.src} · {r.uses === 'own' ? `${fmt(r.rows)} rows · ${r.own ? ago(r.own.uploaded_at) : ''}` : r.uses === 'shared' ? 'shared' : 'missing'}
            </span>
          ))}
        </div>
      )}
      {report && <PlanReport rid={report} onClose={() => setReport(null)} />}
    </section>
  );
}
