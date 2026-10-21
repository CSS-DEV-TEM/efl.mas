'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { PageLoading } from '@/components/Loader';
import Shell, { useShell } from '@/components/Shell';
import { api, userParam } from '@/lib/api';
import { useRefreshOnActivity } from '@/lib/freshness';
import { fmtDate, type Line } from '@/lib/calc';
import { fmtTime } from '@/lib/summary';
import PickWorkspace from '@/components/PickWorkspace';
import type { RoundInfo } from '@/components/Dashboard';

export default function Page() {
  return <Shell><Dispatch /></Shell>;
}

interface PullPlan { type?: 'week' | 'day'; day?: string | null; days?: { day: string; lines: number; done: number }[]; rounds?: RoundInfo[]; week: string | null; rev?: string | null; rows: Line[]; plants?: { code: string; name: string | null }[] }

/**
 * Pick & Dispatch: choose the day and the Pick (Pick No of a plant). Only that plan's lines are shown;
 * Ready-to-pull lines are picked from matched Korber rolls, and picked QTY counts as dispatched.
 */
function Dispatch() {
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
