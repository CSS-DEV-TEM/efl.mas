'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, getSession, isBossRole } from '@/lib/api';
import { ago, fmt, fmtDate } from '@/lib/calc';
import { uploadPickFile, type PickSrc } from '@/lib/pick';
import { todayLocal } from '@/lib/smart';

export interface DayRow { day: string; picks: number; lines: number }
export interface PickRound { id: string; plant: string | null; round: number; lines: number; qty: number; src_at?: string | null; created_by?: string; reports: string[] }
interface Report { src: string; uses: 'own' | 'shared' | 'none'; rows: number; missing?: string[]; own: { file_name: string | null; uploaded_by: string; uploaded_at: string } | null; shared: { file_name: string | null; uploaded_by: string; uploaded_at: string } | null }

const REPORT_NAME: Record<string, string> = { plan: 'Plan', zmmbe: 'ZMMBE', zinr: 'ZINSR / ZINR', zcoment: 'ZCOMENT VIEW', korber: 'Korber Inventory', zroll: 'ZROLLMGT' };
const KEY_DAY = 'mas-day', KEY_RID = 'mas-rid';
export const pickLabel = (r: { plant: string | null; round: number }, names: Record<string, string> = {}) => `${(r.plant && names[r.plant]) || r.plant || 'No plant'} · Pick ${r.round}`;

/** The chosen day and Pick, remembered on this device. */
export function useDayPick() {
  const [day, setDayS] = useState<string>(() => { try { return localStorage.getItem(KEY_DAY) || todayLocal(); } catch { return todayLocal(); } });
  const [rid, setRidS] = useState<string>(() => { try { return localStorage.getItem(KEY_RID) || ''; } catch { return ''; } });
  const setDay = (d: string) => { setDayS(d); try { localStorage.setItem(KEY_DAY, d); } catch { /* private mode */ } };
  const setRid = (r: string) => { setRidS(r); try { if (r) localStorage.setItem(KEY_RID, r); else localStorage.removeItem(KEY_RID); } catch { /* private mode */ } };
  return { day, setDay, rid: rid.startsWith(day + '~') ? rid : '', setRid };
}

/**
 * Day → Pick → reports. First a day is created, then its Picks (one plant's Pick 1, 2 …); every Pick gets its own Plan, ZMMBE,
 * ZINSR, ZCOMENT VIEW and Korber Inventory, and its matching reads only those (a report it does not have yet: the shared one).
 * Plan and ZMMBE files go through the upload list below; ZINSR, ZCOMENT VIEW and Korber are uploaded here.
 */
export default function DayPickBar({ day, setDay, rid, setRid, toast, refreshKey, onUploaded }: {
  day: string; setDay: (d: string) => void; rid: string; setRid: (r: string) => void; toast: (m: string) => void; refreshKey?: unknown; onUploaded?: () => void;
}) {
  const role = getSession()?.user.role;
  const canEdit = role !== 'viewer', boss = isBossRole(role), admin = role === 'admin';
  const [days, setDays] = useState<DayRow[]>([]);
  const [rounds, setRounds] = useState<PickRound[]>([]);
  const [plants, setPlants] = useState<{ code: string; name: string | null }[]>([]);
  const [reports, setReports] = useState<Report[] | null>(null);
  const [newDay, setNewDay] = useState('');
  const [newPlant, setNewPlant] = useState('');
  const [busy, setBusy] = useState('');
  const names = Object.fromEntries(plants.map((p) => [p.code.toUpperCase(), p.name || p.code]));

  const loadDays = useCallback(() => api<{ days: DayRow[] }>('/api/days').then((r) => setDays(r.days)).catch(() => {}), []);
  const loadRounds = useCallback(() => (day ? api<{ rounds: PickRound[] }>(`/api/rounds?day=${day}`).then((r) => setRounds(r.rounds)).catch(() => setRounds([])) : Promise.resolve()), [day]);
  const loadReports = useCallback(() => (rid ? api<{ reports: Report[] }>(`/api/pick/status?rid=${encodeURIComponent(rid)}`).then((r) => setReports(r.reports)).catch(() => setReports(null)) : (setReports(null), Promise.resolve())), [rid]);
  useEffect(() => { void loadDays(); api<{ plants: { code: string; name: string | null }[] }>('/api/plants').then((r) => setPlants(r.plants)).catch(() => {}); }, [loadDays, refreshKey]);
  useEffect(() => { void loadRounds(); }, [loadRounds, refreshKey]);
  useEffect(() => { void loadReports(); }, [loadReports, refreshKey]);
  // the only Pick of the day is chosen by itself
  useEffect(() => { if (!rid && rounds.length === 1) setRid(rounds[0].id); }, [rounds, rid, setRid]);

  const createDay = async () => {
    const d = newDay || todayLocal();
    try { await api('/api/days', { method: 'POST', body: { day: d } }); setDay(d); setRid(''); setNewDay(''); toast(`Day ${fmtDate(d)} created — now create its first Pick`); void loadDays(); }
    catch (e) { toast(e instanceof Error ? e.message : 'Could not create the day.'); }
  };
  const createPick = async () => {
    if (!newPlant) { toast('Choose the plant of the Pick'); return; }
    try {
      const r = await api<{ rid: string; round: number }>('/api/rounds', { method: 'POST', body: { day, plant: newPlant } });
      setRid(r.rid); toast(`${pickLabel({ plant: newPlant, round: r.round }, names)} created for ${fmtDate(day)} — upload its Plan, ZMMBE, ZINSR, ZCOMENT VIEW and Korber`);
      await loadRounds(); void loadDays();
    } catch (e) { toast(e instanceof Error ? e.message : 'Could not create the Pick.'); }
  };
  const deletePick = async () => {
    const r = rounds.find((x) => x.id === rid);
    if (!r || !confirm(`Delete ${pickLabel(r, names)} of ${fmtDate(day)} with its plan and its own reports? (Not possible once picks were saved for it.)`)) return;
    try { await api(`/api/rounds?rid=${encodeURIComponent(rid)}`, { method: 'DELETE' }); setRid(''); toast('Pick deleted'); await loadRounds(); onUploaded?.(); }
    catch (e) { toast(e instanceof Error ? e.message : 'Could not delete.'); }
  };
  const inputs = useRef<Record<string, HTMLInputElement | null>>({});
  const upload = async (src: PickSrc, f: File) => {
    setBusy(src);
    try {
      const r = await uploadPickFile(src, f, rid);
      toast(`${REPORT_NAME[src]} → ${pickLabel(rounds.find((x) => x.id === rid) || { plant: null, round: 0 }, names)}: ${fmt(r.rows)} rows${r.total > r.rows ? ` (of ${fmt(r.total)} in the file${src === 'korber' ? ' — only this Pick\'s plan items kept' : src === 'zcoment' ? ' — Shade Report only' : ''})` : ''}`);
      await loadReports(); onUploaded?.();
    } catch (e) { toast(e instanceof Error ? e.message : 'Upload failed.'); } finally { setBusy(''); }
  };
  const clearOwn = async (src: string) => {
    if (!confirm(`Remove this Pick's own ${REPORT_NAME[src]}? The Pick then reads the shared ${REPORT_NAME[src]} (if any).`)) return;
    try { await api(`/api/data/${src}?rid=${encodeURIComponent(rid)}`, { method: 'DELETE' }); toast(`${REPORT_NAME[src]} of this Pick removed`); await loadReports(); onUploaded?.(); }
    catch (e) { toast(e instanceof Error ? e.message : 'Could not remove.'); }
  };
  const cur = rounds.find((x) => x.id === rid);
  const dayList = Array.from(new Set([day, ...days.map((d) => d.day)])).filter(Boolean).sort().reverse();

  return (
    <section className="card dpb" aria-labelledby="dpb-title">
      <h2 id="dpb-title">1 · Day &nbsp;→&nbsp; 2 · Pick &nbsp;→&nbsp; 3 · Reports</h2>
      <p className="sub">Create the day, then a Pick (a plant&apos;s Pick 1, 2 …). Every Pick has its own Plan, ZMMBE, ZINSR, ZCOMENT VIEW and Korber Inventory, and its matching uses only those. The pick history is one for all Picks: a pallet is never picked twice, only a cut roll&apos;s balance.</p>
      <div className="dpb-row">
        <label>Day
          <select value={day} onChange={(e) => { setDay(e.target.value); setRid(''); }}>
            {dayList.map((d) => { const x = days.find((y) => y.day === d); return <option key={d} value={d}>{fmtDate(d)}{d === todayLocal() ? ' (today)' : ''}{x ? ` · ${x.picks} pick${x.picks === 1 ? '' : 's'}` : ' · new'}</option>; })}
          </select>
        </label>
        {canEdit && <span className="dpb-new"><input type="date" value={newDay} onChange={(e) => setNewDay(e.target.value)} aria-label="New day" /><button className="btn sm" onClick={createDay}>+ Create day</button></span>}
        <label>Pick
          <select value={rid} onChange={(e) => setRid(e.target.value)}>
            <option value="">{rounds.length ? 'Choose the Pick…' : 'No Pick yet — create one'}</option>
            {rounds.map((r) => <option key={r.id} value={r.id}>{pickLabel(r, names)} · {fmt(r.lines)} lines{r.reports.length ? ` · ${r.reports.length} report${r.reports.length === 1 ? '' : 's'}` : ''}</option>)}
          </select>
        </label>
        {canEdit && <span className="dpb-new">
          <select value={newPlant} onChange={(e) => setNewPlant(e.target.value)} aria-label="Plant of the new Pick">
            <option value="">Plant…</option>
            {plants.map((p) => <option key={p.code} value={p.code.toUpperCase()}>{p.name ? `${p.name} (${p.code})` : p.code}</option>)}
          </select>
          <button className="btn sm primary" onClick={createPick} disabled={!day}>+ Create Pick</button>
        </span>}
        {boss && cur && <button className="btn sm danger" onClick={deletePick} title="Delete this Pick with its plan and its own reports">Delete Pick</button>}
      </div>
      {!rid ? <div className="notice warn" style={{ marginTop: 10 }}>Choose or create a Pick — the plan and the reports are uploaded to a Pick.</div> : (
        <div className="dpb-reports">
          {(reports || []).map((r) => {
            const u = r.own ?? r.shared;
            const pickSrc = ['zinr', 'zcoment', 'korber', 'zroll'].includes(r.src);
            return (
              <div key={r.src} className={`dpb-rep ${r.uses}`}>
                <div className="dpb-h"><b>{REPORT_NAME[r.src]}</b><span className={`pill ${r.uses === 'own' ? 'ok' : r.uses === 'shared' ? 'warn' : 'bad'}`}>{r.uses === 'own' ? 'this Pick' : r.uses === 'shared' ? 'shared' : 'missing'}</span></div>
                <div className="dpb-n">{fmt(r.rows)} <span className="muted">{r.src === 'plan' ? 'lines' : 'rows'}</span></div>
                <div className="muted small">{u ? `${u.file_name || ''} · ${u.uploaded_by} · ${ago(u.uploaded_at)}` : r.src === 'plan' || r.src === 'zmmbe' ? 'Drop the file in the upload list below' : 'Not uploaded yet'}</div>
                {r.uses === 'shared' && <div className="muted small">Uses the shared report until this Pick gets its own.</div>}
                {r.missing?.length ? <div className="notice warn small" style={{ margin: '4px 0 0', padding: '4px 8px' }}>{r.missing.length} plan item{r.missing.length === 1 ? ' has' : 's have'} no rolls in this Pick&apos;s Korber ({r.missing.slice(0, 3).join(', ')}{r.missing.length > 3 ? '…' : ''}). If they were added to the plan after the Korber upload, upload the Korber again.</div> : null}
                <div className="dpb-act">
                  {pickSrc && canEdit && <>
                    <button className="btn sm primary" disabled={!!busy} aria-busy={busy === r.src || undefined} onClick={() => inputs.current[r.src]?.click()}>{busy === r.src ? 'Uploading…' : r.own ? 'Upload again' : 'Upload'}</button>
                    <input ref={(el) => { inputs.current[r.src] = el; }} type="file" hidden accept=".xlsx,.xls,.xlsm,.csv" onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(r.src as PickSrc, f); e.target.value = ''; }} />
                  </>}
                  {admin && r.own && r.src !== 'plan' && <button className="btn sm danger" onClick={() => clearOwn(r.src)}>Remove</button>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
