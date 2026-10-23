'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PageLoading } from '@/components/Loader';
import Shell, { useShell } from '@/components/Shell';
import { api, userParam } from '@/lib/api';
import { useRefreshOnActivity } from '@/lib/freshness';
import { fmtDate, type Line, type WeekInfo } from '@/lib/calc';
import { fmtTime } from '@/lib/summary';
import PickWorkspace from '@/components/PickWorkspace';
import type { RoundInfo } from '@/components/Dashboard';

export default function Page() {
  return <Shell><PickPage /></Shell>;
}

/** Day plan Picks or the week plan: the same Pick & Dispatch, the plan chosen at the top */
function PickPage() {
  const [kind, setKindS] = useState<'day' | 'week'>(() => { try { return localStorage.getItem('mas-pick-type') === 'week' ? 'week' : 'day'; } catch { return 'day'; } });
  const setKind = (k: 'day' | 'week') => { setKindS(k); try { localStorage.setItem('mas-pick-type', k); } catch { /* private mode */ } };
  const toggle = (
    <div className="seg plan-kind" role="group" aria-label="Plan">
      <button className={kind === 'day' ? 'on' : ''} onClick={() => setKind('day')}>Day plan</button>
      <button className={kind === 'week' ? 'on' : ''} onClick={() => setKind('week')}>Week plan</button>
    </div>
  );
  return kind === 'week' ? <WeekDispatch toggle={toggle} /> : <Dispatch toggle={toggle} />;
}

/**
 * Pick & Dispatch of the week plan: choose the week, then the day (and the plant). The lines of that day are picked with
 * the same matching as a Pick, from the week's own reports (Week plan tab / Pick data card) or the shared ones.
 */
function WeekDispatch({ toggle }: { toggle: React.ReactNode }) {
  const { user, subscribe, toast } = useShell();
  const canEdit = user.role !== 'viewer';
  const ls = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
  const sv = (k: string, v: string | null) => { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch { /* private mode */ } };
  const [week, setWeekS] = useState<string | null>(() => ls('mas-pick-week'));
  const [day, setDayS] = useState<string>(() => ls('mas-pick-wday') || '');
  const [plant, setPlantS] = useState<string>(() => ls('mas-pick-wplant') || '');
  const setWeek = (w: string | null) => { setWeekS(w); sv('mas-pick-week', w); };
  const setDay = (d: string) => { setDayS(d); sv('mas-pick-wday', d); };
  const setPlant = (p: string) => { setPlantS(p); sv('mas-pick-wplant', p); };
  const [plan, setPlan] = useState<PullPlan | null>(null);
  const [err, setErr] = useState('');
  const seq = useRef(0);
  const weekRef = useRef(week); weekRef.current = week;
  const load = useCallback(async () => {
    try {
      const w = weekRef.current, my = ++seq.current;
      const p = await api<PullPlan>(`/api/pullplan${w ? '?week=' + encodeURIComponent(w) : ''}` + userParam(!w));
      if (my !== seq.current) return;
      setPlan(p); setErr('');
      if (p.week && p.week !== w) setWeek(p.week);
    } catch (e) { setErr(e instanceof Error ? e.message : 'Could not load.'); }
  }, []);
  useEffect(() => { load(); }, [load, week]);
  useEffect(() => subscribe((m) => { if (m.type === 'data') load(); }), [subscribe, load]);
  useRefreshOnActivity(load, plan ? plan.rev ?? null : undefined);
  const all = useMemo(() => (plan?.rows || []).filter((l) => !plan?.week || l.week === plan.week), [plan]);
  const days = useMemo(() => {
    const m = new Map<string, { n: number; done: number }>();
    for (const l of all) { const d = l.date || ''; const x = m.get(d) || { n: 0, done: 0 }; x.n++; if (/done/i.test(l.status || '')) x.done++; m.set(d, x); }
    return Array.from(m.entries()).filter(([d]) => d).sort((a, b) => a[0].localeCompare(b[0]));
  }, [all]);
  const plants = useMemo(() => Array.from(new Set(all.map((l) => (l.plant || '').toUpperCase()).filter(Boolean))).sort(), [all]);
  // a remembered day / plant that is not in this week: every day / every plant
  useEffect(() => { if (plan && day && !days.some(([d]) => d === day)) setDay(''); if (plan && plant && !plants.includes(plant)) setPlant(''); }, [plan, days, plants]); // eslint-disable-line react-hooks/exhaustive-deps
  const rows = all.filter((l) => (!day || l.date === day) && (!plant || (l.plant || '').toUpperCase() === plant));
  const plantName = (c: string) => (plan?.plants || []).find((p) => p.code.toUpperCase() === c)?.name || c;
  const label = `Week plan ${plan?.week || ''}${day ? ` · ${fmtDate(day)}` : ' · whole week'}${plant ? ` · ${plantName(plant)}` : ''}`;
  return (
    <main className="page anim">
      <div className="page-head">
        <div>
          <h1>Pick &amp; Dispatch</h1>
          <p>Week plan: choose the <b>week</b>, the <b>day</b> and the <b>plant</b> — that day&apos;s lines are picked with the same matching as a Pick, from the week&apos;s own reports (Week plan tab or the Pick data card below), else the shared ones.</p>
          {toggle}
        </div>
        <div className="week-pick" style={{ margin: 0, display: 'flex', gap: 8, alignItems: 'end', flexWrap: 'wrap' }}>
          <label htmlFor="w-week" style={{ display: 'grid', gap: 2 }}>Week
            <select id="w-week" value={plan?.week || week || ''} onChange={(e) => { setWeek(e.target.value); setDay(''); }}>
              {(plan?.weeks || []).map((w) => <option key={w.week} value={w.week}>{w.week} · {w.lines} lines{w.start ? ` · ${fmtDate(w.start)} – ${fmtDate(w.end)}` : ''}</option>)}
            </select>
          </label>
          <label htmlFor="w-day" style={{ display: 'grid', gap: 2 }}>Day
            <select id="w-day" value={day} onChange={(e) => setDay(e.target.value)}>
              <option value="">Whole week ({all.length} lines)</option>
              {days.map(([d, x]) => <option key={d} value={d}>{fmtDate(d)} · {x.n} lines{x.done >= x.n ? ' · completed' : ''}</option>)}
            </select>
          </label>
          <label htmlFor="w-plant" style={{ display: 'grid', gap: 2 }}>Plant
            <select id="w-plant" value={plant} onChange={(e) => setPlant(e.target.value)}>
              <option value="">All plants</option>
              {plants.map((p) => <option key={p} value={p}>{plantName(p)}</option>)}
            </select>
          </label>
        </div>
      </div>
      {err && <div className="notice bad">{err}</div>}
      {!plan && !err && <PageLoading label="Loading the week plan…" tiles={3} rows={6} />}
      {plan && !plan.weeks?.length && <div className="notice warn">There is no week plan yet. Upload one in the Week plan tab.</div>}
      {plan && plan.week && <PickWorkspace key={plan.week} week={plan.week} rows={rows} canEdit={canEdit} toast={toast} reload={load} label={label} plant={plant || undefined} />}
    </main>
  );
}

interface PullPlan { type?: 'week' | 'day'; weeks?: WeekInfo[]; day?: string | null; days?: { day: string; lines: number; done: number }[]; rounds?: RoundInfo[]; week: string | null; rev?: string | null; rows: Line[]; plants?: { code: string; name: string | null }[] }

/**
 * Pick & Dispatch: choose the day and the Pick (Pick No of a plant). Only that plan's lines are shown;
 * Ready-to-pull lines are picked from matched Korber rolls, and picked QTY counts as dispatched.
 */
function Dispatch({ toggle }: { toggle: React.ReactNode }) {
  const { user, subscribe, toast } = useShell();
  const canEdit = user.role !== 'viewer';
  // the day and the Pick are shared with the Upload page (chosen once, the same on both pages)
  const ls = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
  const [day, setDayS] = useState<string | null>(() => ls('mas-day'));
  const [round, setRoundS] = useState<string | null>(() => { const r = ls('mas-rid') || ls('mas-pick-round'); const d = ls('mas-day'); return r && (!d || r.startsWith(d + '~')) ? r : null; });
  const setDay = (d: string | null) => { setDayS(d); try { if (d) localStorage.setItem('mas-day', d); } catch { /* private mode */ } };
  const setRound = (r: string | null) => { setRoundS(r); try { if (r) { localStorage.setItem('mas-rid', r); localStorage.setItem('mas-pick-round', r); } else { localStorage.removeItem('mas-rid'); localStorage.removeItem('mas-pick-round'); } } catch { /* private mode */ } };
  const seq = useRef(0);
  const [plan, setPlan] = useState<PullPlan | null>(null);
  const [err, setErr] = useState('');
  const dayRef = useRef(day); dayRef.current = day;
  const roundRef = useRef(round); roundRef.current = round;

  const load = useCallback(async () => {
    try {
      const d = dayRef.current, rd = roundRef.current, my = ++seq.current;
      const p = await api<PullPlan>(`/api/pullplan?type=day${d ? '&day=' + encodeURIComponent(d) : ''}${rd ? '&round=' + encodeURIComponent(rd) : ''}` + userParam());
      // a slower answer to an older request must not overwrite the current one
      if (my !== seq.current) return;
      setPlan(p);
      // no day chosen yet, or the chosen day has no plan yet (a day created without lines): the day the answer is for
      if (p.day && p.day !== d) setDay(p.day);
      // a remembered Pick of another day: back to the whole day
      if (rd && !(p.rounds || []).some((r) => r.id === rd)) setRound(null);
      setErr('');
    } catch (e) { setErr(e instanceof Error ? e.message : 'Could not load.'); }
  }, []);
  useEffect(() => { load(); }, [load, day, round]);
  useEffect(() => subscribe((m) => { if (m.type === 'data') load(); }), [subscribe, load]);
  useRefreshOnActivity(load, plan ? plan.rev ?? null : undefined);

  const plantName = (c: string | null | undefined) => { const k = (c || '').toUpperCase(); return (plan?.plants || []).find((p) => p.code.toUpperCase() === k)?.name || k || 'No plant'; };
  const rounds = plan?.rounds || [];
  const cur = rounds.find((r) => r.id === round);
  const label = `${fmtDate(plan?.day || '')}${cur ? ` · ${plantName(cur.plant)} Pick ${cur.round}` : ' · all picks'}`;

  return (
    <main className="page anim">
      <div className="page-head">
        <div>
          <h1>Pick &amp; Dispatch</h1>
          <p>Choose the <b>day</b> and the <b>Pick</b> (Pick No of a plant): only that plan&apos;s lines show. Pick the matched Korber rolls; what is picked counts as <b>Dispatched</b>, and the Packing List is built from the picks.</p>
          {toggle}
        </div>
        <div className="week-pick" style={{ margin: 0, display: 'flex', gap: 8, alignItems: 'end', flexWrap: 'wrap' }}>
          <label htmlFor="d-day" style={{ display: 'grid', gap: 2 }}>Day
            <select id="d-day" value={day || ''} onChange={(e) => { setDay(e.target.value); setRound(null); }}>
              {(plan?.days || []).map((d) => <option key={d.day} value={d.day}>{fmtDate(d.day)} · {d.lines} lines{d.done >= d.lines ? ' · completed' : ''}</option>)}
            </select>
          </label>
          <label htmlFor="d-round" style={{ display: 'grid', gap: 2 }}>Pick
            <select id="d-round" value={round || ''} onChange={(e) => setRound(e.target.value || null)}>
              <option value="">All picks of the day ({rounds.reduce((t, r) => t + r.lines, 0)} lines)</option>
              {rounds.map((r) => <option key={r.id} value={r.id}>{plantName(r.plant)} · Pick {r.round} · {r.lines} lines{r.src_at ? ` · ${fmtTime(r.src_at)}` : ''}{r.lines && r.done >= r.lines ? ' · completed' : ''}</option>)}
            </select>
          </label>
        </div>
      </div>
      {err && <div className="notice bad">{err}</div>}
      {!plan && !err && <PageLoading label="Loading the plan lines to pick…" tiles={3} rows={6} />}
      {plan && !plan.days?.length && <div className="notice warn">There is no day plan yet. Upload a plan (day, plant and Pick No) and ZMMBE first.</div>}
      {plan && plan.day && <PickWorkspace week={plan.week || plan.day} rows={plan.rows} canEdit={canEdit} toast={toast} reload={load} label={label} />}
    </main>
  );
}
