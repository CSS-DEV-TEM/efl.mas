'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader } from '@/components/Loader';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import Shell, { useShell } from '@/components/Shell';
import { isDispatchGrid } from '@/lib/handoff';
import { action } from '@/lib/smart';
import type { Line } from '@/lib/calc';
import { api, isBossRole, userParam } from '@/lib/api';
import { useRefreshOnActivity } from '@/lib/freshness';
import { ago, fmt, fmtDate, type Upload, type WeekInfo } from '@/lib/calc';
import { TEMPLATES, downloadTemplate } from '@/lib/templates';
import DayPickBar, { useDayPick } from '@/components/DayPickBar';
import { todayLocal, weekDays, weekIdOf, weekOptions } from '@/lib/smart';
import {
  FIELDS, SRC_INFO, SRC_ORDER, applyMapping, colLetter, detectMapping, guessSrc, guessSrcFromGrid, isHelpSheet, readWorkbook, usableCount,
  type Grid, type Mapping, type Src,
} from '@/lib/mapping';

export default function Page() {
  return <Shell><Uploads /></Shell>;
}

interface SheetJob {
  id: string; file: string; sheet: string; grid: Grid;
  src: Src | ''; map: Mapping | null;
  state: 'ready' | 'sending' | 'done' | 'error'; msg?: string;
  /** plan only: '' = auto from dates, or a week id like 2026-W43 */
  week?: string;
  /** plan only: how the file joins what is already there (a day plan round: replace the round, or merge into it) */
  mode?: 'merge' | 'replace-plant' | 'replace-week' | 'replace-day' | 'replace-round';
  /** plan only: the day and the Pick No (1, 2 …) of the plant on that day */
  day?: string; round?: number;
  /** plan only: plant for lines that have none (and the plant a replace-plant upload replaces) */
  plant?: string;
  /** stock reports: 'replace' the whole report (default) or 'add' this file to what is there (another part of the same report) */
  stockMode?: 'replace' | 'add';
  /** plan only: a week plan or a day plan (separate dashboards) */
  planType?: 'week' | 'day';
  /** plan only: Admin / Head upload a plan for a user ('' = own plan) */
  owner?: string;
  /** the Pick No was chosen by hand (not the suggested next one) */
  roundTouched?: boolean;
}

function Uploads() {
  const { user, subscribe, toast } = useShell();
  // 1 day → 2 Pick → 3 reports: everything uploaded here goes to the chosen Pick
  const { day, setDay, rid, setRid } = useDayPick();
  const [barKey, setBarKey] = useState(0);
  const [jobs, setJobs] = useState<SheetJob[]>([]);
  const [over, setOver] = useState(false);
  const [reading, setReading] = useState(false);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [weeks, setWeeks] = useState<WeekInfo[]>([]);
  const [rev, setRev] = useState<string | null | undefined>(undefined);
  const [history, setHistory] = useState<{ at: string; username: string; detail: string }[]>([]);
  const [myPlant, setMyPlant] = useState<string>('');
  // Admin / Head can upload a plan for a user
  const [owners, setOwners] = useState<string[] | null>(null);
  useEffect(() => { if (isBossRole(user.role)) api<{ owners: string[] }>('/api/owners').then((r) => setOwners(r.owners)).catch(() => {}); }, [user.role]);
  const [plants, setPlants] = useState<string[]>([]);
  const [plantNames, setPlantNames] = useState<Record<string, string>>({});
  useEffect(() => { api<{ user: { plant?: string | null } }>('/api/me').then((m) => setMyPlant(m.user.plant || '')).catch(() => {}); }, []);
  const input = useRef<HTMLInputElement>(null);
  const router = useRouter();
  // after a ZMMBE upload: how many lines of the latest week are now Ready to pull (they show on the Pick page)
  const [readyNow, setReadyNow] = useState<{ week: string; n: number } | null>(null);
  const [showReady, setShowReady] = useState(false);
  const canEdit = user.role !== 'viewer';

  const loadStatus = useCallback(async () => {
    try {
      const p = await api<{ week: string | null; day?: string | null; rev?: string | null; uploads: Upload[]; counts: { src: string; n: number }[]; weeks: WeekInfo[]; rows: Line[]; plants?: { code: string; name: string | null }[] }>('/api/pullplan?type=day' + userParam());
      if (p.day) setReadyNow({ week: p.day, n: p.rows.filter((l) => action(l) === 'Ready to pull').length });
      setPlants(Array.from(new Set([...(p.plants || []).map((x) => x.code.toUpperCase()), ...p.rows.map((r) => r.plant || '')].filter(Boolean))).sort());
      setPlantNames(Object.fromEntries((p.plants || []).map((x) => [x.code.toUpperCase(), x.name || ''])));
      setUploads(p.uploads);
      setRev(p.rev ?? null);
      setWeeks(p.weeks || []);
      api<{ activity: { at: string; username: string; detail: string }[] }>('/api/activity?action=upload').then((a) => setHistory(a.activity.slice(0, 12))).catch(() => {});
      setCounts(Object.fromEntries(p.counts.map((c) => [c.src, c.n])));
    } catch { /* shown on dashboard */ }
  }, []);
  useEffect(() => { loadStatus(); }, [loadStatus]);
  useEffect(() => subscribe((m) => { if (m.type === 'data') loadStatus(); }), [subscribe, loadStatus]);
  useRefreshOnActivity(loadStatus, rev);

  async function addFiles(files: FileList | File[]) {
    setReading(true);
    const next: SheetJob[] = [];
    const disp: File[] = [];
    const skipped: string[] = [];
    for (const f of Array.from(files)) {
      try {
        const sheets = readWorkbook(await f.arrayBuffer());
        // a dispatch / pick file (Display Item Number + Actual Qty) belongs on the Dispatch page
        // dispatch files are no longer uploaded: picks count as dispatched
        if (sheets.some((s) => isDispatchGrid(s.grid)) && !sheets.some((s) => guessSrc(s.name))) { disp.push(f); continue; }
        const dataSheets = sheets.filter((s) => s.grid.length && !isHelpSheet(s.name));
        for (const s of dataSheets) {
          // KFC / PFC are built from the ZMMBE upload; TRR is not used any more
          const named = guessSrc(s.name) ?? (dataSheets.length === 1 ? guessSrc(f.name.replace(/\.\w+$/, '').replace(/\(\d+\)/g, '')) : null);
          if (named === 'kfc' || named === 'pfc' || named === 'trr') { skipped.push(`${f.name}${dataSheets.length > 1 ? ' › ' + s.name : ''}`); continue; }
          // sheet name first ("ZMMBE KFC"), then the file name ("ZMMBE_PFC.xlsx" with a "Data" sheet), then the headers
          const byName = guessSrc(s.name);
          const byFile = dataSheets.filter((x) => !guessSrc(x.name)).length === 1 ? guessSrc(f.name.replace(/\.\w+$/, '').replace(/\(\d+\)/g, '')) : null;
          const src = byName ?? byFile ?? guessSrcFromGrid(s.grid) ?? '';
          if (src === 'kfc' || src === 'pfc' || src === 'trr') { skipped.push(f.name); continue; }
          next.push({ id: f.name + '::' + s.name + '::' + Math.random(), file: f.name, sheet: s.name, grid: s.grid, src, map: src ? detectMapping(src, s.grid) : null, state: 'ready', planType: 'day', mode: 'replace-round' });
        }
      } catch {
        toast(`Could not read ${f.name}. Save it as .xlsx and try again.`);
      }
    }
    setJobs((j) => [...j, ...next]);
    setReading(false);
    if (skipped.length) toast(`Skipped ${skipped.join(', ')}: ZMMBE KFC and PFC are built from the ZMMBE upload (TRR is not used).`);
    if (disp.length) toast(`${disp.map((f) => f.name).join(', ')}: dispatch files are no longer uploaded — picked QTY on the Pick page counts as dispatched.`);
  }

  const setJob = (id: string, patch: Partial<SheetJob>) => setJobs((js) => js.map((j) => (j.id === id ? { ...j, ...patch } : j)));

  async function send(j: SheetJob) {
    if (!j.src || !j.map) return;
    setJob(j.id, { state: 'sending', msg: undefined });
    try {
      const rows = applyMapping(j.src, j.grid, j.map);
      const r = await api<PlanPreview & { accepted: number; skipped: number; weeks?: string[]; stockDups?: number; changes?: { added: number; removed: number; unchanged: number }; derived?: { kfc: number; pfc: number; plant: number | null; plantKept?: number }; notInSetup?: { plant: string; soPlant: string; rows: number; ur: number }[]; setupOut?: number }>('/api/upload', { method: 'POST', body: { src: j.src, fileName: j.file, sheetName: j.sheet, rows, ...planOpts(j, rid) } });
      const wk = r.weeks?.length ? ` to ${r.weeks.map((w) => roundName(w, plantNames)).join(', ')}` : '';
      await loadStatus(); setBarKey((k) => k + 1);
      if (j.src === 'zmmbe' || j.src === 'plan') setShowReady(true);
      const plan = j.src === 'plan' && r.added !== undefined ? `${fmt(r.added)} new, ${fmt(r.updated)} updated${r.removed ? `, ${fmt(r.removed)} removed` : ''}${r.inFileDups ? `, ${fmt(r.inFileDups)} repeated rows (last row kept${r.dupQtyCount ? `; ${fmt(r.dupQtyCount)} had a different QTY` : ''})` : ''}` : `${fmt(r.accepted)} rows saved — ${j.stockMode === 'add' ? 'added to the current report' : 'whole report replaced, no duplicates'}${r.stockDups ? ` · ${fmt(r.stockDups)} repeated rows counted once` : ''}${r.changes ? ` · ${fmt(r.changes.unchanged)} unchanged, ${fmt(r.changes.added)} new or changed, ${fmt(r.changes.removed)} removed` : ''}${r.derived ? ` · also built ZMMBE KFC (${fmt(r.derived.kfc)}) and PFC (${fmt(r.derived.pfc)})${r.derived.plant ? ` · ${fmt(r.derived.plant)} plant-location row${r.derived.plant === 1 ? '' : 's'} left out` : ''}` : ''}`;
      // Plant + SO Plant pairs not in Settings → ZMMBE plants: left out, listed so they can be added
      const notSet = r.notInSetup?.length ? ` · ${fmt(r.setupOut || 0)} row${r.setupOut === 1 ? '' : 's'} left out — Plant + SO Plant not in Settings → ZMMBE plants: ${r.notInSetup.map((m) => `${m.plant} + ${m.soPlant || '–'} (${fmt(m.rows)} rows, UR ${fmt(m.ur, 2)})`).join(', ')}` : '';
      setJob(j.id, { state: 'done', msg: `${plan}${wk}${notSet}${r.skipped > 0 ? ` · ${fmt(r.skipped)} rows without SO/LI/Material skipped` : ''}. Every open dashboard has updated.` });
    } catch (e) {
      setJob(j.id, { state: 'error', msg: e instanceof Error ? e.message : 'Upload failed.' });
    }
  }
  async function sendAll() {
    // plan first so the stock reports land on the new lines
    const order = [...jobs].filter((j) => j.src && j.state !== 'done').sort((a, b) => SRC_ORDER.indexOf(a.src as Src) - SRC_ORDER.indexOf(b.src as Src));
    // several files of the same stock report: the first replaces it, the rest are added to it
    const seen = new Set<string>();
    for (const j of order) {
      const extra = j.src !== 'plan' && seen.has(j.src);
      seen.add(j.src);
      if (extra && j.stockMode !== 'add') setJob(j.id, { stockMode: 'add' });
      await send(extra ? { ...j, stockMode: 'add' } : j);
    }
  }

  async function deleteWeek(w: string) {
    if (!window.confirm(`Delete the plan ${roundName(w, plantNames)}? Stock reports and the other Picks stay.`)) return;
    try { await api('/api/data/plan?week=' + encodeURIComponent(w), { method: 'DELETE' }); toast(`${roundName(w, plantNames)} deleted`); loadStatus(); }
    catch (e) { toast(e instanceof Error ? e.message : 'Could not delete.'); }
  }

  async function clear(src: Src) {
    if (!window.confirm(`Remove all ${SRC_INFO[src].title} rows? The dashboard will update for everyone.`)) return;
    try { await api('/api/data/' + src, { method: 'DELETE' }); toast(`${SRC_INFO[src].title} cleared`); loadStatus(); }
    catch (e) { toast(e instanceof Error ? e.message : 'Could not clear.'); }
  }

  const up = new Map(uploads.map((u) => [u.src, u]));
  const ready = jobs.filter((j) => j.src && j.state !== 'done').length;
  const dupSrc = useMemo(() => {
    const c: Record<string, number> = {};
    jobs.forEach((j) => { if (j.src && j.state !== 'done') c[j.src] = (c[j.src] || 0) + 1; });
    return Object.keys(c).filter((k) => c[k] > 1);
  }, [jobs]);

  return (
    <main className="page anim">
      <div className="page-head">
        <div>
          <h1>Upload reports</h1>
          <p>Dispatch / pick files (JAN0190…) go on the <Link href="/dispatch/">Dispatch page</Link>. First create the day and the Pick, then upload the Pick's Plan and ZMMBE (drop them below) and its ZINSR, ZCOMENT VIEW and Korber Inventory (in the Pick card). Each upload replaces that report's previous data, the calculation runs again and every open dashboard updates live.</p>
        </div>
      </div>

      <DayPickBar day={day} setDay={setDay} rid={rid} setRid={setRid} toast={toast} refreshKey={barKey} onUploaded={() => { void loadStatus(); }} />

      <section className="card" aria-labelledby="tpl-title">
        <h2 id="tpl-title">Sample formats</h2>
        <p className="sub">Download a format, paste your data under the headers and upload it here. Each file has a "How to use" sheet.</p>
        <div className="tpl-grid">
          {SRC_ORDER.map((s) => (
            <button key={s} type="button" className="tpl" onClick={() => downloadTemplate(s)}>
              <span className="tpl-ico" aria-hidden="true">XLSX</span>
              <span className="tpl-txt"><b>{TEMPLATES[s].title}</b><span>{TEMPLATES[s].file}</span></span>
              <span className="tpl-dl" aria-hidden="true">↓</span>
            </button>
          ))}
        </div>
      </section>

      {weeks.length > 0 && (
        <section className="card" aria-labelledby="wk-title">
          <h2 id="wk-title">Day plans in the system</h2>
          <p className="sub">One plan per day, plant and Pick No. Uploading a Pick again replaces only that Pick; the others stay.</p>
          <div className="wk-list">
            {weeks.slice(0, 30).map((w, i) => (
              <div key={w.week} className="wk-row">
                <b>{roundName(w.week, plantNames)}</b>{i === 0 && <span className="pill accent">Latest</span>}
                <span className="muted">{w.start ? fmtDate(w.start) : 'no date'}</span>
                <span className="num">{fmt(w.lines)} lines · {fmt(w.done)} done</span>
                {user.role === 'admin' && <button className="btn sm danger" onClick={() => deleteWeek(w.week)}>Delete</button>}
              </div>
            ))}
          </div>
        </section>
      )}

      {history.length > 0 && (
        <section className="card" aria-labelledby="hist-title">
          <h2 id="hist-title">Recent uploads</h2>
          <p className="sub">Last {history.length} uploads, newest first.</p>
          <div className="wk-list">
            {history.map((h, i) => (
              <div key={i} className="wk-row"><span>{h.detail}</span><span className="num muted">{h.username} · {ago(h.at)}</span></div>
            ))}
          </div>
        </section>
      )}

      {!canEdit ? <div className="notice info">Your account can view the dashboard. Ask an admin for editor access to upload.</div> : (
        <>
          <div
            className={`drop ${over ? 'over' : ''}`}
            role="button" tabIndex={0}
            onClick={() => input.current?.click()}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') input.current?.click(); }}
            onDragOver={(e) => { e.preventDefault(); setOver(true); }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => { e.preventDefault(); setOver(false); if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files); }}
          >
            <strong>{reading ? <Loader inline label="Reading the file…" /> : 'Drop Excel files here, or click to choose'}</strong>
            <span className="muted">One workbook with all sheets (Day plan, ZMMBE) or separate files. .xlsx, .xls, .csv</span>
            <input ref={input} type="file" hidden multiple accept=".xlsx,.xlsm,.xls,.csv" onChange={(e) => { if (e.target.files?.length) addFiles(e.target.files); e.target.value = ''; }} />
          </div>

          {showReady && readyNow && (
            <div className="notice ok" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <span>ZMMBE updated: <b>{fmt(readyNow.n)}</b> line{readyNow.n === 1 ? ' is' : 's are'} Ready to pull on {fmtDate(readyNow.week)} — they are on the Pick list now.</span>
              <Link className="btn sm primary" href="/dispatch/">Open Pick list →</Link>
            </div>
          )}
          {jobs.length > 0 && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <button className="btn primary" disabled={!ready} onClick={sendAll}>Upload {ready} sheet{ready === 1 ? '' : 's'}</button>
              <button className="btn" onClick={() => setJobs([])}>Clear list</button>
              {dupSrc.length > 0 && <span className="notice info" style={{ padding: '5px 10px' }}>{dupSrc.includes('plan') ? 'Several plan sheets: each merges into the plan without duplicates. ' : ''}{dupSrc.filter((x) => x !== 'plan').length ? `Several ${dupSrc.filter((x) => x !== 'plan').map((x) => SRC_INFO[x as Src].title).join(', ')} files: "Upload all" replaces the report with the first and adds the others to it — rows that repeat count once.` : ''}</span>}
            </div>
          )}

          {jobs.map((j) => <SheetCard key={j.id} job={j} rid={rid} ridLabel={rid ? roundName(rid, plantNames) : ''} owners={owners} me={user.username} onChange={(p) => setJob(j.id, p)} onSend={() => send(j)} onRemove={() => setJobs((js) => js.filter((x) => x.id !== j.id))} />)}
        </>
      )}
    </main>
  );
}

/** Excel serial / ISO / dd.mm.yyyy → yyyy-mm-dd (or null). */
function toIsoDate(v: unknown): string | null {
  if (typeof v === 'number' && v > 20000 && v < 80000) return new Date(Math.round((v - 25569) * 86400000)).toISOString().slice(0, 10);
  const s = String(v ?? '').trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null;
}
/** The weeks a plan sheet covers, with line counts and date range. */
function planWeeks(rows: Record<string, unknown>[]) {
  const m = new Map<string, { n: number; min: string; max: string }>();
  for (const r of rows) {
    const d = toIsoDate(r.date);
    if (!d) continue;
    const w = weekIdOf(d);
    const o = m.get(w) || { n: 0, min: d, max: d };
    o.n++; if (d < o.min) o.min = d; if (d > o.max) o.max = d;
    m.set(w, o);
  }
  return Array.from(m.entries()).sort(([a], [b]) => a.localeCompare(b));
}

/** Problems worth knowing before a plan goes in. */
function planChecks(rows: Record<string, unknown>[], fixedWeek: string, dayPlan = false) {
  const out: string[] = [];
  const usable = rows.filter((r) => /^[A-Za-z]{0,4}\d/.test(String(r.so ?? '').trim()) && String(r.li ?? '').trim() && String(r.item ?? '').trim());
  const noDate = usable.filter((r) => !toIsoDate(r.date)).length;
  const badQty = usable.filter((r) => !(Number(String(r.qty ?? '').replace(/,/g, '')) > 0)).length;
  const seen = new Map<string, number>();
  for (const r of usable) { const k = `${r.so}|${r.li}|${r.item}`; seen.set(k, (seen.get(k) || 0) + 1); }
  const dups = Array.from(seen.values()).filter((n) => n > 1).length;
  if (badQty) out.push(`${fmt(badQty)} line${badQty > 1 ? 's have' : ' has'} QTY 0 or blank`);
  if (noDate && !dayPlan) out.push(`${fmt(noDate)} line${noDate > 1 ? 's have' : ' has'} no readable date${fixedWeek ? '' : ' (they go to the current week)'}`);
  if (dups) out.push(`${fmt(dups)} SO / LI / Item combination${dups > 1 ? 's appear' : ' appears'} more than once`);
  if (fixedWeek) {
    const [mon, sun] = weekDays(fixedWeek);
    const outside = usable.filter((r) => { const d = toIsoDate(r.date); return d && (d < mon || d > sun); }).length;
    if (outside) out.push(`${fmt(outside)} line${outside > 1 ? 's are' : ' is'} dated outside ${fixedWeek} (${fmtDate(mon)} – ${fmtDate(sun)}) but will be saved to it`);
  }
  return out;
}
const wkLabel = (id: string) => { const [m, su] = weekDays(id); return `Week ${Number(id.slice(-2))} · ${fmtDate(m)} – ${fmtDate(su)}${id.slice(0, 4) !== todayLocal().slice(0, 4) ? ' ' + id.slice(0, 4) : ''}`; };

/** Preview formatting: Excel date serials as dates, long floats rounded. */
function show(v: unknown, id: string) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') {
    if (/date/.test(id) && v > 20000 && v < 80000) return new Date(Math.round((v - 25569) * 86400000)).toISOString().slice(0, 10);
    return Number.isInteger(v) ? String(v) : String(Math.round(v * 1000) / 1000);
  }
  return String(v);
}

interface PlanPreview { owner?: string; planType?: string; days?: string[]; round?: number; added: number; updated: number; removed: number; kept: number; inFileDups: number; dupQty?: { so: string; li: string; item: string; date: string | null; was: number; now: number }[]; dupQtyCount?: number; lines: number; plant: string | null; mode: string }
/** A Pick's upload: the plan and ZMMBE go to the chosen Pick (rid). */
function planOpts(j: SheetJob, rid: string) {
  if (j.src !== 'plan') return { ...(j.stockMode === 'add' ? { mode: 'add' } : {}), ...(rid ? { rid } : {}) };
  return { rid, mode: j.mode === 'merge' ? 'merge' : 'replace-round', ...(j.owner ? { owner: j.owner } : {}) };
}
interface RoundInfo { id: string; plant: string | null; round: number; lines: number; qty: number; src_at: string | null; src_user: string | null }

function SheetCard({ job, rid, ridLabel, owners, me, onChange, onSend, onRemove }: { job: SheetJob; rid: string; ridLabel: string; owners: string[] | null; me: string; onChange: (p: Partial<SheetJob>) => void; onSend: () => void; onRemove: () => void }) {
  const fields = job.src ? FIELDS[job.src] : [];
  const width = Math.max(0, ...job.grid.slice(0, 50).map((r) => r?.length || 0));
  const header = job.map?.how === 'header' && job.map.headerRow !== undefined ? job.grid[job.map.headerRow] : null;
  const colName = (c: number) => `${colLetter(c)}${header && header[c] ? ' · ' + String(header[c]).slice(0, 18) : ''}`;
  const rows = useMemo(() => (job.src && job.map ? applyMapping(job.src, job.grid, job.map) : []), [job.src, job.map, job.grid]);
  const usable = job.src ? usableCount(job.src, rows) : 0;
  const checks = useMemo(() => (job.src === 'plan' ? planChecks(rows, '', true) : []), [job.src, rows]);
  // ask the server what this upload would do (new / updated / removed) before it is sent
  const [preview, setPreview] = useState<PlanPreview | null>(null);
  const [previewErr, setPreviewErr] = useState('');
  useEffect(() => {
    if (job.src !== 'plan' || job.state === 'done' || !usable || !rid) { setPreview(null); return; }
    let stop = false;
    const t = setTimeout(async () => {
      try {
        const r = await api<PlanPreview>('/api/upload', { method: 'POST', body: { src: 'plan', rows, dryRun: true, ...planOpts(job, rid) } });
        if (!stop) { setPreview(r); setPreviewErr(''); }
      } catch (e) { if (!stop) { setPreview(null); setPreviewErr(e instanceof Error ? e.message : ''); } }
    }, 350);
    return () => { stop = true; clearTimeout(t); };
  }, [job.src, job.state, job.mode, job.owner, rows, usable, rid]); // eslint-disable-line react-hooks/exhaustive-deps
  const missing = fields.filter((f) => f.required && (job.map?.cols[f.id] ?? -1) < 0);
  const how = job.map?.how === 'header' ? `header row ${(job.map.headerRow ?? 0) + 1}` : job.map?.how === 'keyed' ? 'your workbook layout (key in column A)' : 'SAP layout without key column';

  return (
    <section className="card sheet">
      <div className="sheet-top">
        <div>
          <h2>{job.sheet} <span className="muted" style={{ fontWeight: 400 }}>· {job.file}</span></h2>
          <p className="sub" style={{ margin: 0 }}>{job.src ? <>Columns found by {how}. {fmt(usable)} usable rows of {fmt(rows.length)}.</> : 'Choose what this sheet is, or skip it.'}</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <select aria-label="Report type" value={job.src} onChange={(e) => { const src = e.target.value as Src | ''; onChange({ src, map: src ? detectMapping(src, job.grid) : null, state: 'ready', msg: undefined }); }}
            style={{ border: '1px solid var(--line-strong)', borderRadius: 6, padding: '6px 8px', background: 'var(--panel)' }}>
            <option value="">Skip this sheet</option>
            {SRC_ORDER.map((s) => <option key={s} value={s}>{SRC_INFO[s].title}</option>)}
          </select>
          <button className="btn primary" aria-busy={job.state === 'sending' || undefined} disabled={!job.src || !usable || missing.length > 0 || job.state === 'sending' || !rid} title={rid ? `Upload to ${ridLabel}` : 'Choose or create a Pick first'} onClick={onSend}>
            {job.state === 'sending' ? 'Uploading…' : job.state === 'done' ? 'Upload again' : 'Upload'}
          </button>
          <button className="btn sm" onClick={onRemove} aria-label="Remove">✕</button>
        </div>
      </div>

      {job.msg && <div className={`notice ${job.state === 'error' ? 'bad' : 'ok'}`}>{job.msg}</div>}
      {job.src && job.src !== 'plan' && job.state !== 'done' && (
        <div className="mode-pick" role="radiogroup" aria-label="How this report is saved">
          <label><input type="radio" checked={job.stockMode !== 'add'} onChange={() => onChange({ stockMode: 'replace' })} /> <b>Replace whole report</b> <span className="muted">— a fresh {SRC_INFO[job.src].title} export. Old rows are removed, nothing is counted twice.</span></label>
          <label><input type="radio" checked={job.stockMode === 'add'} onChange={() => onChange({ stockMode: 'add' })} /> <b>Add to current</b> <span className="muted">— another part of the same report (e.g. split by plant). Rows already there are updated, not duplicated.</span></label>
        </div>
      )}
      {job.src === 'plan' && job.state !== 'done' && (
        <div className="plan-opts">
          <div className="round-pick">
            <span>{rid ? <>All {fmt(usable)} lines go to <b>{ridLabel}</b>. The day, the plant and the Pick No come from the Pick chosen above.</> : <b>Choose or create a Pick above — the plan goes to that Pick.</b>}</span>
          </div>
          {owners && (
            <label className="plant-pick">Plan of
              <select value={job.owner || ''} onChange={(e) => onChange({ owner: e.target.value, state: 'ready', msg: undefined })}>
                <option value="">Me ({me})</option>
                {owners.filter((o) => o !== me).map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
              <span className="muted">Admin / Head: upload this plan for a user. It becomes that user&apos;s plan.</span>
            </label>
          )}
          {rid && (
            <div className="mode-pick" role="radiogroup" aria-label="How to add this file">
              {([['replace-round', 'Replace the Pick\'s plan', 'The lines of this Pick are removed, then the file is added. Other Picks stay.'],
                ['merge', 'Add to the Pick\'s plan', 'Add new lines and update matching ones in this Pick. Nothing else is touched.']] as const).map(([v, label, help]) => {
                const cur = job.mode === 'merge' ? 'merge' : 'replace-round';
                return (
                  <label key={v} className={`mode ${cur === v ? 'on' : ''}`}>
                    <input type="radio" name={`mode-${job.id}`} value={v} checked={cur === v} onChange={() => onChange({ mode: v, state: 'ready', msg: undefined })} />
                    <b>{label}</b><span>{help}</span>
                  </label>
                );
              })}
            </div>
          )}
          <div className={`preview-counts ${previewErr ? 'bad' : ''}`} aria-live="polite">
            {previewErr ? previewErr : preview ? (
              <>
                <span className="pc new"><b>{fmt(preview.added)}</b> new</span>
                <span className="pc upd"><b>{fmt(preview.updated)}</b> updated</span>
                <span className="pc del"><b>{fmt(preview.removed)}</b> removed</span>
                <span className="pc keep"><b>{fmt(preview.kept)}</b> other lines kept</span>
                {preview.inFileDups > 0 && <span className="pc">{fmt(preview.inFileDups)} line{preview.inFileDups === 1 ? ' is' : 's are'} in the file twice — the last row is kept</span>}
                {preview.days?.length ? <span className="pc">Day plan {preview.days.map((d) => fmtDate(d)).join(', ')}{preview.round ? ` · Pick ${preview.round}` : ''}</span> : null}
                {preview.owner && preview.owner !== me ? <span className="pc">Plan of <b>{preview.owner}</b></span> : null}
                <span className="muted">No line is ever added twice: a line with the same SO, LI and Item in this Pick is updated.</span>
                {!!preview.dupQtyCount && (
                  <div className="notice warn dup-qty" style={{ width: '100%' }}>
                    <b>{preview.dupQtyCount} repeated line{preview.dupQtyCount === 1 ? '' : 's'} with a different QTY</b> — the last row&apos;s QTY is used. Check these in the file:
                    <ul>{(preview.dupQty || []).map((d, i) => <li key={i}>{d.so} / {d.li} / {d.item} · {fmtDate(d.date)}: {fmt(d.was, 3)} → <b>{fmt(d.now, 3)}</b></li>)}</ul>
                    {preview.dupQtyCount > (preview.dupQty?.length || 0) && <span className="muted">… and {preview.dupQtyCount - (preview.dupQty?.length || 0)} more</span>}
                  </div>
                )}
              </>
            ) : <Loader inline label="Checking what this upload will change…" />}
          </div>
        </div>
      )}
      {job.src === 'plan' && job.state !== 'done' && checks.length > 0 && (
        <div className="notice warn"><b>Check before uploading:</b> {checks.join(' · ')}.</div>
      )}
      {missing.length > 0 && <div className="notice bad">Pick a column for {missing.map((f) => f.label).join(', ')}.</div>}

      {job.src && job.map && (
        <details open={job.state !== 'done'}>
          <summary className="muted" style={{ cursor: 'pointer', marginBottom: 8 }}>Column mapping and preview</summary>
          <div className="maprow">
            {fields.map((f) => (
              <label key={f.id} className={f.required ? 'req' : ''}>
                <span>{f.label}</span>
                <select value={job.map!.cols[f.id] ?? -1} onChange={(e) => onChange({ map: { ...job.map!, cols: { ...job.map!.cols, [f.id]: Number(e.target.value) } }, state: 'ready' })}>
                  <option value={-1}>— none —</option>
                  {Array.from({ length: width }, (_, c) => <option key={c} value={c}>{colName(c)}</option>)}
                </select>
              </label>
            ))}
            <label>
              <span>First data row</span>
              <select value={job.map.start} onChange={(e) => onChange({ map: { ...job.map!, start: Number(e.target.value) }, state: 'ready' })}>
                {Array.from({ length: Math.min(20, job.grid.length) }, (_, r) => <option key={r} value={r}>Row {r + 1}</option>)}
              </select>
            </label>
          </div>
          <div className="preview" style={{ marginTop: 10 }}>
            <table>
              <thead><tr>{fields.filter((f) => (job.map!.cols[f.id] ?? -1) >= 0).map((f) => <th key={f.id}>{f.label}</th>)}</tr></thead>
              <tbody>
                {rows.slice(0, 8).map((r, i) => (
                  <tr key={i}>{fields.filter((f) => (job.map!.cols[f.id] ?? -1) >= 0).map((f) => <td key={f.id}>{show(r[f.id], f.id)}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </section>
  );
}

/** "2026-10-20~C064~2" → "20 Oct · SHADELINE · Pick 2" (a week id stays "Week 43") */
function roundName(w: string, names: Record<string, string>) {
  const m = /^(\d{4}-\d{2}-\d{2})~([^~]*)~(\d+)$/.exec(w);
  if (!m) return /W\d{2}$/.test(w) ? `Week ${Number(w.slice(-2))}` : w;
  const pl = m[2] === '-' ? 'No plant' : names[m[2]] || m[2];
  return `${fmtDate(m[1])} · ${pl} · Pick ${m[3]}`;
}
