'use client';
import { useCallback, useEffect, useState } from 'react';
import { Loader } from '@/components/Loader';
import Shell, { useShell } from '@/components/Shell';
import { ClearDatabase, UsersAdmin } from '@/components/AdminUsers';
import BackupRestore from '@/components/BackupRestore';
import { api } from '@/lib/api';
import type { PlantInfo } from '@/lib/summary';

export default function Page() {
  return <Shell admin><Settings /></Shell>;
}

export interface SystemSettings { fullRollPct: number; defaultPickKind: 'normal' | 'offsite'; allowOffsite: boolean; allowNormalShort: boolean; allowNormalFull: boolean; deriveFromZmmbe: boolean; pfcSlocs: string[]; plantSlocs: string[]; soliPerHour: number; lateGraceMin: number; defaultTarget: string; zmmbePlants?: PlantPair[]; rollGate?: boolean; pickBin?: string }
export interface PlantPair { plant: string; soPlant: string; link: string }

const TABS = [['plants', 'Plants'], ['zmmbe', 'ZMMBE plants'], ['reports', 'Locations'], ['time', 'Time setup'], ['plans', 'Plans (data change)'], ['pick', 'Pick rules'], ['users', 'Users & roles'], ['backup', 'Backup & Restore'], ['database', 'Database']] as const;
type Tab = (typeof TABS)[number][0];

/** Admin only: the system settings. Head accounts can do everything else but cannot open this page. */
function Settings() {
  const { toast } = useShell();
  const [tab, setTabS] = useState<Tab>('plants');
  useEffect(() => { const h = location.hash.slice(1); if (TABS.some(([t]) => t === h)) setTabS(h as Tab); }, []);
  const setTab = (t: Tab) => { setTabS(t); try { history.replaceState(null, '', '#' + t); } catch { /* ignore */ } };
  return (
    <main className="page anim" style={{ maxWidth: 1000 }}>
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p>System settings — only the Admin can change them. Head accounts can do everything else (all users&apos; plans and picks); User accounts work on their own plan only.</p>
        </div>
      </div>
      <div className="tabs" role="tablist" style={{ marginBottom: 14 }}>
        {TABS.map(([t, label]) => <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{label}</button>)}
      </div>
      {tab === 'pick' && <PickRules toast={toast} />}
      {tab === 'reports' && <ReportRules toast={toast} />}
      {tab === 'zmmbe' && <ZmmbePlants toast={toast} />}
      {tab === 'plants' && <PlantsSettings toast={toast} />}
      {tab === 'time' && <TimeSetup toast={toast} />}
      {tab === 'plans' && <PlansAdmin toast={toast} />}
      {tab === 'users' && <UsersAdmin />}
      {tab === 'backup' && <BackupRestore toast={toast} />}
      {tab === 'database' && <ClearDatabase toast={toast} />}
    </main>
  );
}

function PickRules({ toast }: { toast: (m: string) => void }) {
  const [s, setS] = useState<SystemSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { api<{ settings: SystemSettings }>('/api/settings').then((r) => setS(r.settings)).catch((e) => setErr(e instanceof Error ? e.message : 'Could not load.')); }, []);
  const save = async () => {
    if (!s) return;
    setBusy(true); setErr('');
    try { const r = await api<{ settings: SystemSettings }>('/api/settings', { method: 'POST', body: s }); setS(r.settings); toast('Pick rules saved'); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Could not save.'); } finally { setBusy(false); }
  };
  if (!s) return <section className="card">{err ? <div className="notice bad">{err}</div> : <Loader />}</section>;
  const set = <K extends keyof SystemSettings>(k: K, v: SystemSettings[K]) => setS({ ...s, [k]: v });
  return (
    <section className="card set-card">
      <h2>Pick rules</h2>
      <p className="sub">How the Pick window behaves for everyone.</p>
      <div className="set-grid">
        <label className="set-row">
          <span><b>Default pick type</b><small>What a new Pick window starts with.</small></span>
          <select value={s.defaultPickKind} onChange={(e) => set('defaultPickKind', e.target.value as 'normal' | 'offsite')}>
            <option value="normal">Normal</option><option value="offsite">Offsite</option>
          </select>
        </label>
        <label className="set-row">
          <span><b>Offsite picks allowed</b><small>Offsite = exact QTY only: the last roll is always cut, never over or short.</small></span>
          <input type="checkbox" checked={s.allowOffsite} onChange={(e) => set('allowOffsite', e.target.checked)} />
        </label>
        <label className="set-row">
          <span><b>Normal: send a full roll instead of cutting</b><small>A little over the plan, with the user&apos;s confirmation.</small></span>
          <input type="checkbox" checked={s.allowNormalFull} onChange={(e) => set('allowNormalFull', e.target.checked)} />
        </label>
        <label className="set-row">
          <span><b>“Recommended” full roll within</b><small>The full roll is marked recommended when it is at most this % of the plan QTY over.</small></span>
          <span className="set-num"><input type="number" min={0} max={100} step={1} value={s.fullRollPct} onChange={(e) => set('fullRollPct', Number(e.target.value))} />%</span>
        </label>
        <label className="set-row">
          <span><b>Normal: leave the last roll (close the line short)</b><small>Send a little less without a cut; the line counts as complete.</small></span>
          <input type="checkbox" checked={s.allowNormalShort} onChange={(e) => set('allowNormalShort', e.target.checked)} />
        </label>
        <label className="set-row">
          <span><b>ZROLLMGT check</b><small>Pick only rolls whose Barcode Number is in ZROLLMGT at the StorageBin below, is a ZCOMENT VIEW Barcode Number and is the Korber Pallet. Off = the older matching (invoice / lot / supplier HU) is offered too.</small></span>
          <input type="checkbox" checked={s.rollGate !== false} onChange={(e) => set('rollGate', e.target.checked)} />
        </label>
        <label className="set-row">
          <span><b>ZROLLMGT StorageBin to pick from</b><small>Rolls in any other bin cannot be picked.</small></span>
          <input type="text" value={s.pickBin ?? 'EXPO-FIX'} onChange={(e) => set('pickBin', e.target.value.toUpperCase())} style={{ width: 130 }} />
        </label>
      </div>
      {err && <div className="notice bad">{err}</div>}
      <div style={{ marginTop: 12 }}><button className="btn primary" aria-busy={!!busy || undefined} disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save pick rules'}</button></div>
    </section>
  );
}

function PlantsSettings({ toast }: { toast: (m: string) => void }) {
  const [list, setList] = useState<PlantInfo[] | null>(null);
  const [removed, setRemoved] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const load = useCallback(() => { api<{ plants: PlantInfo[] }>('/api/plants').then((r) => setList(r.plants)).catch((e) => setErr(e instanceof Error ? e.message : 'Could not load.')); }, []);
  useEffect(() => { load(); }, [load]);
  const set = (i: number, k: keyof PlantInfo, v: string) => setList((l) => (l || []).map((p, j) => (j === i ? { ...p, [k]: k === 'sort' ? Number(v) : v } : p)));
  const save = async (e: React.FormEvent) => {
    e.preventDefault(); if (!list) return;
    setBusy(true); setErr('');
    try { await api('/api/plants', { method: 'POST', body: { plants: list.filter((p) => p.code.trim()), remove: removed } }); setRemoved([]); toast('Plants & target times saved'); load(); }
    catch (x) { setErr(x instanceof Error ? x.message : 'Could not save.'); } finally { setBusy(false); }
  };
  return (
    <form className="card set-card" onSubmit={save}>
      <h2>Plants &amp; target times</h2>
      <p className="sub">The plant code from the plan → the name in the Plant summary, who is responsible and the target time (e.g. 10:00 AM, or Weekly). A plan received after the target time shows red. Users type the received time on the dashboard.</p>
      {!list ? <Loader /> : (
        <div className="ps-grid">
          <span>Plant code</span><span>Name</span><span>Responsible</span><span>Target time</span><span>Order</span><span />
          {list.map((p, i) => (
            <div key={i} className="ps-row">
              <input aria-label="Plant code" value={p.code} onChange={(e) => set(i, 'code', e.target.value.toUpperCase())} placeholder="C064" required />
              <input aria-label="Name" value={p.name || ''} onChange={(e) => set(i, 'name', e.target.value)} placeholder="SHADELINE" />
              <input aria-label="Responsible" value={p.responsible || ''} onChange={(e) => set(i, 'responsible', e.target.value)} placeholder="Sasmitha" />
              <input aria-label="Target time" value={p.target || ''} onChange={(e) => set(i, 'target', e.target.value)} placeholder="10:00 AM" list="target-opts-s" />
              <input aria-label="Order" type="number" value={p.sort ?? ''} onChange={(e) => set(i, 'sort', e.target.value)} />
              <button type="button" className="btn sm" aria-label="Remove" onClick={() => { setRemoved((r) => [...r, p.code]); setList((l) => (l || []).filter((_, j) => j !== i)); }}>✕</button>
            </div>
          ))}
        </div>
      )}
      <datalist id="target-opts-s"><option value="9:00 AM" /><option value="10:00 AM" /><option value="1:00 PM" /><option value="Weekly" /></datalist>
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button type="button" className="btn sm" onClick={() => setList((l) => [...(l || []), { code: '', name: '', responsible: '', target: '', sort: (l?.length ?? 0) + 1 }])}>+ Add plant</button>
        <span style={{ flex: 1 }} />
        <button className="btn primary" aria-busy={!!busy || undefined} disabled={busy || !list}>{busy ? 'Saving…' : 'Save plants'}</button>
      </div>
      {err && <div className="notice bad" style={{ marginTop: 10 }}>{err}</div>}
    </form>
  );
}

/** ZMMBE KFC / PFC / PLANT built from the ZMMBE upload by storage location, like the Pull Plan workbook. */
function ReportRules({ toast }: { toast: (m: string) => void }) {
  const [s, setS] = useState<SystemSettings | null>(null);
  const [pfc, setPfc] = useState(''); const [plant, setPlant] = useState('');
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  useEffect(() => { api<{ settings: SystemSettings }>('/api/settings').then((r) => { setS(r.settings); setPfc(r.settings.pfcSlocs.join(', ')); setPlant(r.settings.plantSlocs.join(', ')); }).catch((e) => setErr(e instanceof Error ? e.message : 'Could not load.')); }, []);
  const save = async () => {
    if (!s) return;
    setBusy(true); setErr('');
    try {
      const r = await api<{ settings: SystemSettings }>('/api/settings', { method: 'POST', body: { deriveFromZmmbe: s.deriveFromZmmbe, pfcSlocs: pfc, plantSlocs: plant } });
      setS(r.settings); setPfc(r.settings.pfcSlocs.join(', ')); setPlant(r.settings.plantSlocs.join(', ')); toast('Report rules saved — they apply from the next ZMMBE upload');
    } catch (e) { setErr(e instanceof Error ? e.message : 'Could not save.'); } finally { setBusy(false); }
  };
  if (!s) return <section className="card">{err ? <div className="notice bad">{err}</div> : <Loader />}</section>;
  return (
    <section className="card set-card">
      <h2>Locations: reports from ZMMBE</h2>
      <p className="sub">Like the Pull Plan workbook: one ZMMBE upload also fills ZMMBE KFC and ZMMBE PFC, split by storage location. A KFC / PFC / PLANT file uploaded on its own still replaces that report until the next ZMMBE upload.</p>
      <div className="set-grid">
        <label className="set-row">
          <span><b>Build KFC, PFC (and PLANT) from ZMMBE</b><small>Turn off to upload the four reports separately as before.</small></span>
          <input type="checkbox" checked={s.deriveFromZmmbe} onChange={(e) => setS({ ...s, deriveFromZmmbe: e.target.checked })} />
        </label>
        <label className="set-row">
          <span><b>ZMMBE PFC = storage locations</b><small>ZMMBE rows in these St Locations (Week 40 workbook: 41; earlier files also COMF).</small></span>
          <input className="set-text" value={pfc} onChange={(e) => setPfc(e.target.value)} placeholder="41, COMF" />
        </label>
        <div className="set-row">
          <span><b>ZMMBE KFC = every other ZMMBE row</b><small>All ZMMBE stock that is not PFC (42, 44, 203 …). KFC + PFC = ZMMBE, as in the workbook.</small></span>
        </div>
        <label className="set-row">
          <span><b>Plant storage locations</b><small>Stock already at the plants (40, 70, 75). If a ZMMBE file has rows in these St Locations, they are left out of ZMMBE, KFC and PFC.</small></span>
          <input className="set-text" value={plant} onChange={(e) => setPlant(e.target.value)} placeholder="40, 70, 75" />
        </label>
      </div>
      {err && <div className="notice bad">{err}</div>}
      <div style={{ marginTop: 12 }}><button className="btn primary" aria-busy={!!busy || undefined} disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save report rules'}</button></div>
    </section>
  );
}

/** Time setup: targets and how the Plant summary counts time. */
function TimeSetup({ toast }: { toast: (m: string) => void }) {
  const [s, setS] = useState<SystemSettings | null>(null);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  useEffect(() => { api<{ settings: SystemSettings }>('/api/settings').then((r) => setS(r.settings)).catch((e) => setErr(e instanceof Error ? e.message : 'Could not load.')); }, []);
  const save = async () => {
    if (!s) return;
    setBusy(true); setErr('');
    try { const r = await api<{ settings: SystemSettings }>('/api/settings', { method: 'POST', body: { soliPerHour: s.soliPerHour, lateGraceMin: s.lateGraceMin, defaultTarget: s.defaultTarget } }); setS(r.settings); toast('Time setup saved'); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Could not save.'); } finally { setBusy(false); }
  };
  if (!s) return <section className="card">{err ? <div className="notice bad">{err}</div> : <Loader />}</section>;
  return (
    <section className="card set-card">
      <h2>Time setup</h2>
      <p className="sub">Each plant&apos;s own target time is set under Plants. These apply to every plant.</p>
      <div className="set-grid">
        <label className="set-row">
          <span><b>Default target time</b><small>Used for a plant without its own target time (e.g. 10:00 AM). Empty = none.</small></span>
          <input className="set-text" value={s.defaultTarget} onChange={(e) => setS({ ...s, defaultTarget: e.target.value })} placeholder="10:00 AM" />
        </label>
        <label className="set-row">
          <span><b>Late after the target by</b><small>Minutes of grace before a received plan shows red.</small></span>
          <span className="set-num"><input type="number" min={0} max={600} value={s.lateGraceMin} onChange={(e) => setS({ ...s, lateGraceMin: Number(e.target.value) })} />min</span>
        </label>
        <label className="set-row">
          <span><b>SO/LI lines per hour (W/H)</b><small>Plant summary W/H = UR SOLI ÷ this number.</small></span>
          <span className="set-num"><input type="number" min={1} max={1000} value={s.soliPerHour} onChange={(e) => setS({ ...s, soliPerHour: Number(e.target.value) })} /></span>
        </label>
      </div>
      {err && <div className="notice bad">{err}</div>}
      <div style={{ marginTop: 12 }}><button className="btn primary" aria-busy={!!busy || undefined} disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save time setup'}</button></div>
    </section>
  );
}

interface PlanRow { owner: string; type: 'week' | 'day'; week: string; day: string | null; lines: number; qty: number; start: string | null; end: string | null; uploaded: string | null; done: number }
/** Data change: every uploaded plan (user × week plan / day plan) — move it to another user or delete it. */
function PlansAdmin({ toast }: { toast: (m: string) => void }) {
  const [plans, setPlans] = useState<PlanRow[] | null>(null);
  const [users, setUsers] = useState<string[]>([]);
  const [busy, setBusy] = useState('');
  const [q, setQ] = useState('');
  const load = useCallback(() => {
    api<{ plans: PlanRow[] }>('/api/admin/plans').then((r) => setPlans(r.plans)).catch((e) => toast(e instanceof Error ? e.message : 'Could not load plans.'));
    api<{ users: { username: string }[] }>('/api/users').then((r) => setUsers(r.users.map((u) => u.username))).catch(() => {});
  }, [toast]);
  useEffect(() => { load(); }, [load]);
  const act = async (p: PlanRow, action: 'reassign' | 'delete', to?: string) => {
    const label = `${p.type === 'day' ? 'day plan ' + planPeriod(p) : 'week plan ' + p.week} of ${p.owner}`;
    if (action === 'delete' && !confirm(`Delete the ${label} (${p.lines} lines)? Picks already made stay in the pick history.`)) return;
    setBusy(`${p.owner}${p.type}${p.week}${p.day}`);
    try { const r = await api<{ lines: number }>('/api/admin/plans', { method: 'POST', body: { action, owner: p.owner, type: p.type, week: p.week, day: p.day, to } }); toast(`${action === 'delete' ? 'Deleted' : 'Moved'} ${label}: ${r.lines} lines`); load(); }
    catch (e) { toast(e instanceof Error ? e.message : 'Failed.'); } finally { setBusy(''); }
  };
  const list = (plans || []).filter((p) => !q || `${p.owner} ${p.week} ${p.day ?? ''} ${p.type}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <section className="card set-card">
      <div className="sheet-top">
        <div><h2>Plans (data change)</h2><p className="sub" style={{ margin: 0 }}>Every uploaded plan by user. Move a plan to another user (e.g. uploaded under the wrong account) or delete it.</p></div>
        <input type="search" className="as-search" placeholder="Search user, week, day…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search plans" />
      </div>
      {!plans ? <Loader /> : !list.length ? <p className="muted">No plans.</p> : (
        <div className="table-wrap" style={{ maxHeight: 520 }}>
          <table className="mini">
            <thead><tr><th>User</th><th>Plan</th><th>Week / day</th><th>Dates</th><th className="n">Lines</th><th className="n">QTY</th><th>Done</th><th>Uploaded</th><th>Move to</th><th /></tr></thead>
            <tbody>{list.map((p) => {
              const id = `${p.owner}${p.type}${p.week}${p.day}`;
              return (
                <tr key={id}>
                  <td className="mono">{p.owner}</td>
                  <td><span className={`pill ${p.type === 'day' ? 'accent' : 'mute'}`}>{p.type === 'day' ? 'Day plan' : 'Week plan'}</span></td>
                  <td>{p.type === 'day' ? planPeriod(p) : `Week ${Number(p.week.slice(-2))}`}</td>
                  <td className="muted small">{p.start}{p.end && p.end !== p.start ? ` – ${p.end}` : ''}</td>
                  <td className="n">{p.lines}</td><td className="n">{Number(p.qty).toLocaleString()}</td>
                  <td>{p.done >= p.lines ? <span className="pill ok">Completed</span> : `${p.done} / ${p.lines}`}</td>
                  <td className="muted small">{p.uploaded ? p.uploaded.slice(0, 16).replace('T', ' ') : ''}</td>
                  <td><select disabled={busy === id} value="" onChange={(e) => e.target.value && act(p, 'reassign', e.target.value)} aria-label="Move to user">
                    <option value="">Move…</option>{users.filter((u) => u !== p.owner).map((u) => <option key={u} value={u}>{u}</option>)}
                  </select></td>
                  <td><button className="btn sm danger" disabled={busy === id} onClick={() => act(p, 'delete')}>Delete</button></td>
                </tr>
              );
            })}</tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** a day plan round "2026-10-20~C064~2" → "2026-10-20 · C064 · Pick 2" */
function planPeriod(p: { week: string; day?: string | null }) {
  const m = /^(\d{4}-\d{2}-\d{2})~([^~]*)~(\d+)$/.exec(p.week);
  return m ? `${m[1]} · ${m[2] === '-' ? 'no plant' : m[2]} · Pick ${m[3]}` : p.day || p.week;
}

/**
 * Settings → ZMMBE plants: the Plant + SO Plant pairs of ZMMBE that count, each linked to a plant (Settings → Plants).
 * Only rows of these pairs go into UR; the others are left out and listed at the upload. No pairs: every row counts.
 */
function ZmmbePlants({ toast }: { toast: (m: string) => void }) {
  const [rows, setRows] = useState<PlantPair[] | null>(null);
  const [plants, setPlants] = useState<PlantInfo[]>([]);
  const [seen, setSeen] = useState<{ plant: string; soPlant: string; n: number; ur: number }[]>([]);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  useEffect(() => {
    api<{ settings: SystemSettings }>('/api/settings').then((r) => setRows(r.settings.zmmbePlants || [])).catch((e) => setErr(e instanceof Error ? e.message : 'Could not load.'));
    api<{ plants: PlantInfo[] }>('/api/plants').then((r) => setPlants(r.plants)).catch(() => {});
    api<{ pairs: { plant: string; soPlant: string; n: number; ur: number }[] }>('/api/zmmbe-pairs').then((r) => setSeen(r.pairs)).catch(() => {});
  }, []);
  const set = (i: number, k: keyof PlantPair, v: string) => setRows((l) => (l || []).map((x, j) => (j === i ? { ...x, [k]: v.toUpperCase() } : x)));
  // covered: the exact pair, or that Plant with SO Plant * (any)
  const has = (p: string, sp: string) => (rows || []).some((x) => x.plant === p && (x.soPlant === (sp || '*') || x.soPlant === '*'));
  const save = async () => {
    setBusy(true); setErr('');
    try {
      const clean = (rows || []).filter((x) => x.plant.trim());
      const r = await api<{ settings: SystemSettings }>('/api/settings', { method: 'POST', body: { zmmbePlants: clean } });
      setRows(r.settings.zmmbePlants || []); toast(`ZMMBE plants saved (${(r.settings.zmmbePlants || []).length}) — they apply from the next ZMMBE upload`);
    } catch (e) { setErr(e instanceof Error ? e.message : 'Could not save.'); } finally { setBusy(false); }
  };
  if (!rows) return <section className="card">{err ? <div className="notice bad">{err}</div> : <Loader />}</section>;
  return (
    <section className="card set-card">
      <h2>ZMMBE plants</h2>
      <p className="sub">The ZMMBE <b>Plant</b> + <b>SO Plant</b> pairs that count, each linked to its plant. Only rows of these pairs go into UR (and KFC / PFC); a pair not set up here is left out and listed when the ZMMBE is uploaded. <b>SO Plant *</b> = any SO Plant of that Plant. With no pair set up, every ZMMBE row counts (as before).</p>
      <div className="table-wrap" style={{ maxHeight: 'none' }}>
        <table className="mini" data-nofilter>
          <thead><tr><th>ZMMBE Plant</th><th>SO Plant</th><th>Linked plant</th><th /></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td><input className="set-text" style={{ width: 110 }} value={r.plant} onChange={(e) => set(i, 'plant', e.target.value)} placeholder="C065" aria-label="ZMMBE Plant" /></td>
                <td><input className="set-text" style={{ width: 110 }} value={r.soPlant} onChange={(e) => set(i, 'soPlant', e.target.value)} placeholder="C064 or *" aria-label="SO Plant" /></td>
                <td><select value={r.link} onChange={(e) => set(i, 'link', e.target.value)} aria-label="Linked plant">
                  <option value="">— none —</option>
                  {plants.map((p) => <option key={p.code} value={p.code.toUpperCase()}>{p.name ? `${p.name} (${p.code})` : p.code}</option>)}
                </select></td>
                <td><button type="button" className="btn sm" aria-label="Remove" onClick={() => setRows((l) => (l || []).filter((_, j) => j !== i))}>✕</button></td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={4} className="muted">No pair yet — every ZMMBE row counts. Add the pairs below.</td></tr>}
          </tbody>
        </table>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '10px 0' }}>
        <button type="button" className="btn sm" onClick={() => setRows((l) => [...(l || []), { plant: '', soPlant: '', link: '' }])}>+ Add pair</button>
      </div>
      {seen.length > 0 && (
        <div className="notice" style={{ display: 'grid', gap: 6 }}>
          <b>Pairs in the ZMMBE uploaded</b>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {seen.map((x) => (
              <button key={`${x.plant}|${x.soPlant}`} type="button" className={`btn sm ${has(x.plant, x.soPlant) ? '' : 'primary'}`} disabled={has(x.plant, x.soPlant)}
                title={`${x.n} rows · UR ${x.ur}`} onClick={() => setRows((l) => [...(l || []), { plant: x.plant, soPlant: x.soPlant || '*', link: plants.some((p) => p.code.toUpperCase() === (x.soPlant || x.plant)) ? (x.soPlant || x.plant) : '' }])}>
                {has(x.plant, x.soPlant) ? '✓ ' : '+ '}{x.plant} + {x.soPlant || '–'} <span className="muted">· {x.n} rows</span>
              </button>
            ))}
          </div>
        </div>
      )}
      {err && <div className="notice bad">{err}</div>}
      <div style={{ marginTop: 12 }}><button className="btn primary" aria-busy={!!busy || undefined} disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save ZMMBE plants'}</button></div>
    </section>
  );
}
