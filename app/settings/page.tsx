'use client';
import { useCallback, useEffect, useState } from 'react';
import Shell, { useShell } from '@/components/Shell';
import { ClearDatabase, UsersAdmin } from '@/components/AdminUsers';
import { api } from '@/lib/api';
import type { PlantInfo } from '@/lib/summary';

export default function Page() {
  return <Shell admin><Settings /></Shell>;
}

export interface SystemSettings { fullRollPct: number; defaultPickKind: 'normal' | 'offsite'; allowOffsite: boolean; allowNormalShort: boolean; allowNormalFull: boolean }

const TABS = [['pick', 'Pick rules'], ['plants', 'Plants & target times'], ['users', 'Users & roles'], ['database', 'Database']] as const;
type Tab = (typeof TABS)[number][0];

/** Admin only: the system settings. Head accounts can do everything else but cannot open this page. */
function Settings() {
  const { toast } = useShell();
  const [tab, setTabS] = useState<Tab>('pick');
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
      {tab === 'plants' && <PlantsSettings toast={toast} />}
      {tab === 'users' && <UsersAdmin />}
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
  if (!s) return <section className="card">{err ? <div className="notice bad">{err}</div> : <p className="muted">Loading…</p>}</section>;
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
      </div>
      {err && <div className="notice bad">{err}</div>}
      <div style={{ marginTop: 12 }}><button className="btn primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save pick rules'}</button></div>
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
      {!list ? <p className="muted">Loading…</p> : (
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
        <button className="btn primary" disabled={busy || !list}>{busy ? 'Saving…' : 'Save plants'}</button>
      </div>
      {err && <div className="notice bad" style={{ marginTop: 10 }}>{err}</div>}
    </form>
  );
}
