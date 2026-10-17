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

interface PullPlan { week: string | null; rev?: string | null; weeks: WeekInfo[]; rows: Line[] }

/** Pick & Dispatch: Ready-to-pull lines are picked from matched Korber rolls; picked QTY counts as dispatched. */
function Dispatch() {
  const { user, subscribe, toast } = useShell();
  const canEdit = user.role !== 'viewer';
  const [week, setWeek] = useState<string | null>(null);
  const [plan, setPlan] = useState<PullPlan | null>(null);
  const [err, setErr] = useState('');
  const weekRef = useRef(week); weekRef.current = week;

  const load = useCallback(async () => {
    try {
      const w = weekRef.current;
      const p = await api<PullPlan>('/api/pullplan' + (w ? '?week=' + encodeURIComponent(w) + userParam() : userParam(true)));
      // a slower answer for a week no longer picked must not overwrite the current one
      if (weekRef.current && p.week !== weekRef.current) return;
      setPlan(p);
      if (!w && p.week) setWeek((cur) => cur ?? p.week);
      setErr('');
    } catch (e) { setErr(e instanceof Error ? e.message : 'Could not load.'); }
  }, []);
  useEffect(() => { load(); }, [load, week]);
  useEffect(() => subscribe((m) => { if (m.type === 'data') load(); }), [subscribe, load]);
  useRefreshOnActivity(load, plan ? plan.rev ?? null : undefined);

  return (
    <main className="page anim">
      <div className="page-head">
        <div>
          <h1>Pick &amp; Dispatch</h1>
          <p>Lines that become <b>Ready to pull</b> after a ZMMBE upload appear here. Pick the matched Korber rolls; what is picked counts as <b>Dispatched</b> on the plan, and the day&apos;s Packing List is built from the picks.</p>
        </div>
        <div className="week-pick" style={{ margin: 0 }}>
          <label htmlFor="d-week">Plan week</label>
          <select id="d-week" value={week || ''} onChange={(e) => setWeek(e.target.value)}>
            {(plan?.weeks || []).map((w, i) => <option key={w.week} value={w.week}>Week {Number(w.week.slice(-2))} · {w.start ? `${fmtDate(w.start)} – ${fmtDate(w.end)}` : w.week}{i === 0 ? ' (latest)' : ''}</option>)}
          </select>
        </div>
      </div>
      {err && <div className="notice bad">{err}</div>}
      {plan && !plan.weeks.length && <div className="notice warn">There is no weekly plan yet. Upload a plan and ZMMBE first.</div>}
      {week && plan && <PickWorkspace week={week} rows={plan.rows} canEdit={canEdit} toast={toast} reload={load} />}
    </main>
  );
}
