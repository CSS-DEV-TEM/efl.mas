'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, getSession, isBossRole, userParam } from '@/lib/api';
import { fmt, fmtDate, fmtQty, type WeekInfo } from '@/lib/calc';
import { applyMapping, detectMapping, isHelpSheet, readWorkbook } from '@/lib/mapping';
import { todayLocal, weekDays, weekIdOf, weekOptions } from '@/lib/smart';

type Sheet = { name: string; grid: unknown[][] };
type Mode = 'replace-week' | 'merge' | 'replace-plant';
interface Preview { weeks?: string[]; added: number; updated: number; removed: number; kept: number; inFileDups: number; lines: number; plant: string | null; mode: string }

const MODES: [Mode, string, string][] = [
  ['replace-week', 'Replace the week', 'The week(s) in the file are replaced by the file (lines not in the file are removed)'],
  ['merge', 'Add / update', 'New lines are added, lines in the file are updated, the other lines of the week stay'],
  ['replace-plant', 'Replace one plant', 'Only the lines of the plant below are replaced in the week(s); other plants stay'],
];
const weekLabel = (w: string) => { try { const [a, b] = weekDays(w); return `${w} · ${fmtDate(a)} – ${fmtDate(b)}`; } catch { return w; } };

/** Week plan: upload a weekly plan (its own tab, apart from the day plans and Picks), see the weeks and delete one. */
export default function WeekPlanManager({ toast, onChanged }: { toast: (m: string) => void; onChanged: () => void }) {
  const role = getSession()?.user.role;
  const canEdit = !!role && role !== 'viewer';
  const boss = isBossRole(role);
  const [weeks, setWeeks] = useState<WeekInfo[] | null>(null);
  const load = useCallback(() => { api<{ weeks: WeekInfo[] }>('/api/pullplan' + userParam(true)).then((r) => setWeeks(r.weeks || [])).catch(() => setWeeks([])); }, []);
  useEffect(() => { load(); }, [load]);

  const fileRef = useRef<HTMLInputElement | null>(null);
  const [file, setFile] = useState<string>('');
  const [sheets, setSheets] = useState<Sheet[]>([]);
  const [sheet, setSheet] = useState('');
  const [auto, setAuto] = useState(true);
  const [week, setWeek] = useState(() => weekIdOf(todayLocal()));
  const [mode, setMode] = useState<Mode>('replace-week');
  const [plant, setPlant] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');

  const pickFile = async (f: File) => {
    setErr(''); setPreview(null);
    try {
      const all = (readWorkbook(await f.arrayBuffer()) as Sheet[]).filter((s) => s.grid.length && !isHelpSheet(s.name));
      const plans = all.filter((s) => detectMapping('plan', s.grid as never).how === 'header');
      if (!plans.length) { setErr(`No plan sheet in ${f.name}: a plan sheet needs SO, LI, Item Code and QTY columns.`); setSheets([]); return; }
      setFile(f.name); setSheets(plans); setSheet(plans[0].name);
    } catch { setErr('Could not read that file.'); }
  };
  const body = (dryRun: boolean) => {
    const s = sheets.find((x) => x.name === sheet)!;
    const map = detectMapping('plan', s.grid as never);
    for (const k of ['qi_note', 'status', 'comment']) if ((map.cols as Record<string, number>)[k] !== undefined) (map.cols as Record<string, number>)[k] = -1;
    return { src: 'plan', planType: 'week', fileName: file, sheetName: s.name, rows: applyMapping('plan', s.grid as never, map), mode, dryRun,
      ...(auto ? {} : { week, forceWeek: true }), ...(mode === 'replace-plant' ? { plant: plant.trim().toUpperCase() } : {}) };
  };
  const check = async () => {
    if (mode === 'replace-plant' && !plant.trim()) { setErr('Type the plant to replace.'); return; }
    setBusy('check'); setErr('');
    try { setPreview(await api<Preview>('/api/upload', { method: 'POST', body: body(true) })); } catch (e) { setErr(e instanceof Error ? e.message : 'Could not check the file.'); }
    finally { setBusy(''); }
  };
  const upload = async () => {
    setBusy('up'); setErr('');
    try {
      const r = await api<Preview>('/api/upload', { method: 'POST', body: body(false) });
      toast(`Week plan: ${fmt(r.added)} new, ${fmt(r.updated)} updated${r.removed ? `, ${fmt(r.removed)} removed` : ''} → ${(r.weeks || []).join(', ')}`);
      setPreview(null); setSheets([]); setFile(''); load(); onChanged();
    } catch (e) { setErr(e instanceof Error ? e.message : 'Upload failed.'); }
    finally { setBusy(''); }
  };
  const del = async (w: string) => {
    if (!confirm(`Delete the week plan ${w}? Its lines are deleted (the day plans and Picks are not touched).`)) return;
    try { await api(`/api/data/plan?week=${encodeURIComponent(w)}`, { method: 'DELETE' }); toast(`Week plan ${w} deleted`); load(); onChanged(); } catch (e) { toast(e instanceof Error ? e.message : 'Could not delete.'); }
  };

  return (
    <section className="card week-mgr" aria-labelledby="wk-title">
      <div className="sheet-top">
        <div>
          <h2 id="wk-title">Week plans</h2>
          <p className="sub" style={{ margin: 0 }}>The weekly plan is kept apart from the day plans and Picks: upload it here, the dashboard below tracks it against the same ZMMBE / KFC / PFC / PLANT / TRR reports.</p>
        </div>
        {canEdit && <>
          <button className="btn primary" onClick={() => fileRef.current?.click()}>⤒ Upload week plan</button>
          <input ref={fileRef} type="file" hidden accept=".xlsx,.xls,.xlsm,.csv" onChange={(e) => { const f = e.target.files?.[0]; if (f) void pickFile(f); e.target.value = ''; }} />
        </>}
      </div>

      {sheets.length > 0 && (
        <div className="wk-up">
          <div className="wk-row">
            <label>File<b className="mono small">{file}</b></label>
            <label>Sheet<select value={sheet} onChange={(e) => { setSheet(e.target.value); setPreview(null); }}>{sheets.map((s) => <option key={s.name}>{s.name}</option>)}</select></label>
            <label>Week
              <span className="wk-week">
                <select value={auto ? 'auto' : week} onChange={(e) => { setPreview(null); if (e.target.value === 'auto') setAuto(true); else { setAuto(false); setWeek(e.target.value); } }}>
                  <option value="auto">Auto from the dates</option>
                  {weekOptions(weekIdOf(todayLocal())).map((w) => <option key={w} value={w}>{weekLabel(w)}</option>)}
                </select>
              </span>
            </label>
          </div>
          <div className="seg" role="group" aria-label="How">
            {MODES.map(([k, t, tip]) => <button key={k} className={mode === k ? 'on' : ''} title={tip} onClick={() => { setMode(k); setPreview(null); }}>{t}</button>)}
          </div>
          {mode === 'replace-plant' && <input className="as-search" style={{ marginLeft: 8, width: 140 }} placeholder="Plant (e.g. C064)" value={plant} onChange={(e) => { setPlant(e.target.value); setPreview(null); }} />}
          <p className="muted small" style={{ margin: '6px 0' }}>{MODES.find((m) => m[0] === mode)![2]}.</p>
          {preview && <div className="notice info small">Check: <b>{fmt(preview.lines)}</b> lines → {(preview.weeks || []).join(', ')} · {fmt(preview.added)} new · {fmt(preview.updated)} updated · {fmt(preview.removed)} removed · {fmt(preview.kept)} unchanged{preview.inFileDups ? ` · ${fmt(preview.inFileDups)} repeated rows (last kept)` : ''}</div>}
          <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
            <button className="btn" aria-busy={busy === 'check' || undefined} disabled={!!busy} onClick={check}>Check</button>
            <button className="btn primary" aria-busy={busy === 'up' || undefined} disabled={!!busy || !preview} title={preview ? '' : 'Check the file first'} onClick={upload}>Upload</button>
            <button className="btn" disabled={!!busy} onClick={() => { setSheets([]); setPreview(null); setFile(''); }}>Cancel</button>
          </div>
        </div>
      )}
      {err && <div className="notice bad">{err}</div>}

      {weeks === null ? <p className="muted">Loading…</p> : !weeks.length ? <p className="muted">No week plan yet.</p> : (
        <div className="table-wrap" style={{ maxHeight: 280, marginTop: 8 }}>
          <table className="mini" data-noexport>
            <thead><tr><th>Week</th><th>Days</th><th className="n">Lines</th><th className="n">QTY</th><th className="n">Done</th><th className="n">Progress</th><th /></tr></thead>
            <tbody>{weeks.map((w) => {
              const pct = w.lines ? Math.round((w.done / w.lines) * 100) : 0;
              return (
                <tr key={w.week}>
                  <td><b>{w.week}</b></td><td className="small">{w.start ? `${fmtDate(w.start)} – ${fmtDate(w.end)}` : '–'}</td>
                  <td className="n">{fmt(w.lines)}</td><td className="n">{fmtQty(w.qty)}</td><td className="n">{fmt(w.done)}</td>
                  <td className="n"><span className="wk-bar"><i style={{ width: `${pct}%` }} /></span> {pct}%</td>
                  <td>{boss && <button className="btn sm" onClick={() => del(w.week)}>Delete</button>}</td>
                </tr>
              );
            })}</tbody>
          </table>
        </div>
      )}
    </section>
  );
}
