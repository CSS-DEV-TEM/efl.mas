'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import Shell, { useShell } from '@/components/Shell';
import { api, userParam } from '@/lib/api';
import { useRefreshOnActivity } from '@/lib/freshness';
import { fmtDate, type Line, type WeekInfo } from '@/lib/calc';
import PickWorkspace from '@/components/PickWorkspace';

export default function Page() {
  return <Shell><Dispatch /></Shell>;
}

interface PullPlan { type?: 'week' | 'day'; day?: string | null; days?: { day: string; lines: number; done: number }[]; week: string | null; rev?: string | null; weeks: WeekInfo[]; rows: Line[] }

/** Pick & Dispatch: Ready-to-pull lines are picked from matched Korber rolls; picked QTY counts as dispatched. */
function Dispatch() {
  const { user, subscribe, toast } = useShell();
  const canEdit = user.role !== 'viewer';
  const [week, setWeek] = useState<string | null>(null);
  // week plans and day plans are picked from their own lists
  const [ptype, setPtypeS] = useState<'week' | 'day'>(() => { try { return localStorage.getItem('mas-pick-plan') === 'day' ? 'day' : 'week'; } catch { return 'week'; } });
  const ptypeRef = useRef(ptype); ptypeRef.current = ptype;
  const setPtype = (t: 'week' | 'day') => { setPtypeS(t); setWeek(null); setPlan(null); try { localStorage.setItem('mas-pick-plan', t); } catch { /* private mode */ } };
  const [plan, setPlan] = useState<PullPlan | null>(null);
  const [err, setErr] = useState('');
  const weekRef = useRef(week); weekRef.current = week;

  const load = useCallback(async () => {
    try {
      const w = weekRef.current, t = ptypeRef.current;
      const qs = t === 'day' ? `?type=day${w ? '&day=' + encodeURIComponent(w) : ''}` : w ? '?week=' + encodeURIComponent(w) : '';
      const p = await api<PullPlan>('/api/pullplan' + qs + (qs ? userParam() : userParam(true)));
      // a slower answer for a week / day no longer picked must not overwrite the current one
      if (ptypeRef.current !== t || (weekRef.current && (t === 'day' ? p.day : p.week) !== weekRef.current)) return;
      setPlan(p);
      const cur = t === 'day' ? p.day ?? null : p.week;
      if (!w && cur) setWeek((x) => x ?? cur);
      setErr('');
    } catch (e) { setErr(e instanceof Error ? e.message : 'Could not load.'); }
  }, []);
  useEffect(() => { load(); }, [load, week, ptype]);
  useEffect(() => subscribe((m) => { if (m.type === 'data') load(); }), [subscribe, load]);
  useRefreshOnActivity(load, plan ? plan.rev ?? null : undefined);

  return (
    <main className="page anim">
      <div className="page-head">
        <div>
          <h1>Pick &amp; Dispatch</h1>
          <p>Lines that become <b>Ready to pull</b> after a ZMMBE upload appear here. Pick the matched Korber rolls; what is picked counts as <b>Dispatched</b> on the plan, and the day&apos;s Packing List is built from the picks.</p>
        </div>
        <div className="week-pick" style={{ margin: 0, display: 'flex', gap: 8, alignItems: 'end', flexWrap: 'wrap' }}>
          <div className="seg" role="group" aria-label="Plan type">
            <button className={ptype === 'week' ? 'on' : ''} onClick={() => setPtype('week')}>Week plan</button>
            <button className={ptype === 'day' ? 'on' : ''} onClick={() => setPtype('day')}>Day plan</button>
          </div>
          <label htmlFor="d-week" style={{ display: 'grid', gap: 2 }}>{ptype === 'day' ? 'Day' : 'Plan week'}
            {ptype === 'day' ? (
              <select id="d-week" value={week || ''} onChange={(e) => setWeek(e.target.value)}>
                {(plan?.days || []).map((d) => <option key={d.day} value={d.day}>{fmtDate(d.day)} · {d.lines} lines{d.done >= d.lines ? ' · completed' : ''}</option>)}
              </select>
            ) : (
              <select id="d-week" value={week || ''} onChange={(e) => setWeek(e.target.value)}>
                {(plan?.weeks || []).map((w, i) => <option key={w.week} value={w.week}>Week {Number(w.week.slice(-2))} · {w.start ? `${fmtDate(w.start)} – ${fmtDate(w.end)}` : w.week}{i === 0 ? ' (latest)' : ''}{w.lines && w.done >= w.lines ? ' · completed' : ''}</option>)}
              </select>
            )}
          </label>
        </div>
      </div>
      {err && <div className="notice bad">{err}</div>}
      {plan && !(ptype === 'day' ? plan.days?.length : plan.weeks.length) && <div className="notice warn">There is no {ptype === 'day' ? 'day' : 'week'} plan yet. Upload a plan and ZMMBE first.</div>}
      {week && plan && plan.week && <PickWorkspace week={plan.week} rows={plan.rows} canEdit={canEdit} toast={toast} reload={load} />}
    </main>
  );
}
