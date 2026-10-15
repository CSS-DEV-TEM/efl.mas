'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Shell, { useShell } from '@/components/Shell';
import { api } from '@/lib/api';
import { ago, fmt, type Upload } from '@/lib/calc';
import {
  FIELDS, SRC_INFO, SRC_ORDER, applyMapping, colLetter, detectMapping, guessSrc, readWorkbook, usableCount,
  type Grid, type Mapping, type Src,
} from '@/lib/mapping';

export default function Page() {
  return <Shell><Uploads /></Shell>;
}

interface SheetJob {
  id: string; file: string; sheet: string; grid: Grid;
  src: Src | ''; map: Mapping | null;
  state: 'ready' | 'sending' | 'done' | 'error'; msg?: string;
}

function Uploads() {
  const { user, subscribe, toast } = useShell();
  const [jobs, setJobs] = useState<SheetJob[]>([]);
  const [over, setOver] = useState(false);
  const [reading, setReading] = useState(false);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const input = useRef<HTMLInputElement>(null);
  const canEdit = user.role !== 'viewer';

  const loadStatus = useCallback(async () => {
    try {
      const p = await api<{ uploads: Upload[]; counts: { src: string; n: number }[] }>('/api/pullplan');
      setUploads(p.uploads);
      setCounts(Object.fromEntries(p.counts.map((c) => [c.src, c.n])));
    } catch { /* shown on dashboard */ }
  }, []);
  useEffect(() => { loadStatus(); }, [loadStatus]);
  useEffect(() => subscribe((m) => { if (m.type === 'data') loadStatus(); }), [subscribe, loadStatus]);

  async function addFiles(files: FileList | File[]) {
    setReading(true);
    const next: SheetJob[] = [];
    for (const f of Array.from(files)) {
      try {
        const sheets = readWorkbook(await f.arrayBuffer());
        for (const s of sheets) {
          if (!s.grid.length) continue;
          const src = guessSrc(s.name) ?? (sheets.length === 1 ? guessSrc(f.name) : null) ?? '';
          next.push({ id: f.name + '::' + s.name + '::' + Math.random(), file: f.name, sheet: s.name, grid: s.grid, src, map: src ? detectMapping(src, s.grid) : null, state: 'ready' });
        }
      } catch {
        toast(`Could not read ${f.name}. Save it as .xlsx and try again.`);
      }
    }
    setJobs((j) => [...j, ...next]);
    setReading(false);
  }

  const setJob = (id: string, patch: Partial<SheetJob>) => setJobs((js) => js.map((j) => (j.id === id ? { ...j, ...patch } : j)));

  async function send(j: SheetJob) {
    if (!j.src || !j.map) return;
    setJob(j.id, { state: 'sending', msg: undefined });
    try {
      const rows = applyMapping(j.src, j.grid, j.map);
      const r = await api<{ accepted: number; skipped: number }>('/api/upload', { method: 'POST', body: { src: j.src, fileName: j.file, sheetName: j.sheet, rows } });
      setJob(j.id, { state: 'done', msg: `${fmt(r.accepted)} rows saved${r.skipped ? ` · ${fmt(r.skipped)} rows without SO/LI/Material skipped` : ''}. Every open dashboard has updated.` });
    } catch (e) {
      setJob(j.id, { state: 'error', msg: e instanceof Error ? e.message : 'Upload failed.' });
    }
  }
  async function sendAll() {
    // plan first so the stock reports land on the new lines
    const order = [...jobs].filter((j) => j.src && j.state !== 'done').sort((a, b) => SRC_ORDER.indexOf(a.src as Src) - SRC_ORDER.indexOf(b.src as Src));
    for (const j of order) await send(j);
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
          <p>Drop the weekly plan and the SAP reports. Each upload replaces that report's previous data, the calculation runs again and every open dashboard updates live.</p>
        </div>
      </div>

      <section className="kpis" aria-label="Current data">
        {SRC_ORDER.map((s) => {
          const u = up.get(s);
          return (
            <div className="kpi" key={s}>
              <span className="k">{SRC_INFO[s].title}</span>
              <span className="v">{fmt(counts[s] || 0)}</span>
              <span className="s">{u ? `${u.uploaded_by} · ${ago(u.uploaded_at)}` : SRC_INFO[s].hint}</span>
              {user.role === 'admin' && (counts[s] || 0) > 0 && <button className="btn sm danger" style={{ justifySelf: 'start', marginTop: 6 }} onClick={() => clear(s)}>Clear</button>}
            </div>
          );
        })}
      </section>

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
            <strong>{reading ? 'Reading…' : 'Drop Excel files here, or click to choose'}</strong>
            <span className="muted">One workbook with all sheets (Pull Plan, ZMMBE, ZMMBE KFC, ZMMBE PFC, PLANT, TRR) or separate files. .xlsx, .xls, .csv</span>
            <input ref={input} type="file" hidden multiple accept=".xlsx,.xlsm,.xls,.csv" onChange={(e) => { if (e.target.files?.length) addFiles(e.target.files); e.target.value = ''; }} />
          </div>

          {jobs.length > 0 && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <button className="btn primary" disabled={!ready} onClick={sendAll}>Upload {ready} sheet{ready === 1 ? '' : 's'}</button>
              <button className="btn" onClick={() => setJobs([])}>Clear list</button>
              {dupSrc.length > 0 && <span className="notice bad" style={{ padding: '5px 10px' }}>More than one sheet is set as {dupSrc.map((s) => SRC_INFO[s as Src].title).join(', ')}. The last one uploaded wins.</span>}
            </div>
          )}

          {jobs.map((j) => <SheetCard key={j.id} job={j} onChange={(p) => setJob(j.id, p)} onSend={() => send(j)} onRemove={() => setJobs((js) => js.filter((x) => x.id !== j.id))} />)}
        </>
      )}
    </main>
  );
}

/** Preview formatting: Excel date serials as dates, long floats rounded. */
function show(v: unknown, id: string) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') {
    if (/date/.test(id) && v > 20000 && v < 80000) return new Date(Math.round((v - 25569) * 86400000)).toISOString().slice(0, 10);
    return Number.isInteger(v) ? String(v) : String(Math.round(v * 1000) / 1000);
  }
  return String(v);
}

function SheetCard({ job, onChange, onSend, onRemove }: { job: SheetJob; onChange: (p: Partial<SheetJob>) => void; onSend: () => void; onRemove: () => void }) {
  const fields = job.src ? FIELDS[job.src] : [];
  const width = Math.max(0, ...job.grid.slice(0, 50).map((r) => r?.length || 0));
  const header = job.map?.how === 'header' && job.map.headerRow !== undefined ? job.grid[job.map.headerRow] : null;
  const colName = (c: number) => `${colLetter(c)}${header && header[c] ? ' · ' + String(header[c]).slice(0, 18) : ''}`;
  const rows = useMemo(() => (job.src && job.map ? applyMapping(job.src, job.grid, job.map) : []), [job.src, job.map, job.grid]);
  const usable = job.src ? usableCount(job.src, rows) : 0;
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
          <button className="btn primary" disabled={!job.src || !usable || missing.length > 0 || job.state === 'sending'} onClick={onSend}>
            {job.state === 'sending' ? 'Uploading…' : job.state === 'done' ? 'Upload again' : 'Upload'}
          </button>
          <button className="btn sm" onClick={onRemove} aria-label="Remove">✕</button>
        </div>
      </div>

      {job.msg && <div className={`notice ${job.state === 'error' ? 'bad' : 'ok'}`}>{job.msg}</div>}
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
