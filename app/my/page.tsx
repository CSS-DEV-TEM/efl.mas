'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { PageLoading } from '@/components/Loader';
import Link from 'next/link';
import Shell, { useShell } from '@/components/Shell';
import CompleteLine from '@/components/CompleteLine';
import { PickModal } from '@/components/PickWorkspace';
import { api, userParam } from '@/lib/api';
import { useRefreshOnActivity } from '@/lib/freshness';
import { avail, fmt, fmtDate, fmtQty, isDone, need, type Line } from '@/lib/calc';
import { action, due, todayLocal, type Due } from '@/lib/smart';

export default function Page() {
  return <Shell><MyWork /></Shell>;
}

type L = Line & { picked?: number; picked_rolls?: number; plan_type?: string; owner?: string };
interface PP { week: string | null; day?: string | null; rev?: string | null; rows: L[] }

const isPrio = (l: L) => /1\s*st|priority|urgent|last\s*pallet/i.test(`${l.remarks || ''} ${l.comment || ''}`);
/** What to do with the line now, best first. */
function nextStep(l: L): { step: string; tone: string; rank: number } {
  const a = action(l);
  if ((l.picked ?? 0) > 0 && avail(l) > 0) return { step: 'Finish picking', tone: 'accent', rank: 0 };
  if (a === 'Ready to pull') return { step: 'Pick now', tone: 'ok', rank: 1 };
  if (a === 'Partial pull') return { step: 'Pick what is there', tone: 'info', rank: 2 };
  if ((l.picked ?? 0) > 0) return { step: 'Picked — complete it?', tone: 'accent', rank: 3 };
  if (a === 'Release QI / Block') return { step: 'Release QI / Block', tone: 'warn', rank: 4 };
  if (a === 'Follow up TN') return { step: 'Follow up TN', tone: 'warn', rank: 5 };
  return { step: 'No stock — follow up', tone: 'bad', rank: 6 };
}
const DUE_ORDER: Due[] = ['Overdue', 'Today', 'Tomorrow', 'This week', 'Later', 'No date'];

/** A user's own workspace: their open lines (week plans and day plans), what to do first, by day. */
function MyWork() {
  const { user, toast } = useShell();
  const [week, setWeek] = useState<PP | null>(null);
  const [day, setDay] = useState<PP | null>(null);
  const [picking, setPicking] = useState<L | null>(null);
  const [err, setErr] = useState('');
  const today = todayLocal();
  const load = useCallback(async () => {
    try {
      // the week plan is retired: only the day plan (every Pick of the day)
      const d = await api<PP>('/api/pullplan?type=day' + userParam());
      const w: PP = { week: null, rev: d.rev, rows: [] };
      setWeek(w); setDay(d); setErr('');
    } catch (e) { setErr(e instanceof Error ? e.message : 'Could not load.'); }
  }, []);
  useEffect(() => { load(); }, [load]);
  useRefreshOnActivity(load, week ? week.rev ?? null : undefined);

  const rows = useMemo(() => [...(day?.rows || []).map((r) => ({ ...r, plan_type: 'day' })), ...(week?.rows || []).map((r) => ({ ...r, plan_type: r.plan_type || 'week' }))] as L[], [week, day]);
  const open = useMemo(() => rows.filter((l) => !isDone(l) && need(l) > 1e-9), [rows]);
  const doneToday = rows.filter((l) => isDone(l)).length;
  const groups = useMemo(() => {
    const m = new Map<Due, L[]>();
    for (const l of open) { const d = due(l, today); m.set(d, [...(m.get(d) || []), l]); }
    for (const [, ls] of m) ls.sort((a, b) => nextStep(a).rank - nextStep(b).rank || Number(isPrio(b)) - Number(isPrio(a)) || String(a.date ?? '').localeCompare(String(b.date ?? '')) || need(b) - need(a));
    return DUE_ORDER.filter((d) => m.has(d)).map((d) => ({ due: d, lines: m.get(d)! }));
  }, [open, today]);
  const first = useMemo(() => groups.flatMap((g) => g.lines.map((l) => ({ l, due: g.due }))).filter((x) => nextStep(x.l).rank <= 2).slice(0, 5), [groups]);
  const readyQty = open.filter((l) => nextStep(l).rank <= 1).reduce((t, l) => t + need(l), 0);
  const canEdit = user.role !== 'viewer';

  return (
    <main className="page anim">
      <div className="page-head">
        <div>
          <h1>My work <span className="h1-sub">{user.username}</span></h1>
          <p>Your open day plan lines — every Pick of the day — with what to do first. Lines that can be picked now come first.</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link className="btn" href="/dispatch/">Pick &amp; Dispatch</Link>
        </div>
      </div>
      {err && <div className="notice bad">{err}</div>}
      {!week && !err && <PageLoading label="Loading your plans and what to do first…" />}
      {week && (
        <>
          <section className="kpis compact" aria-label="My figures">
            <div className="kpi"><span className="k">Open lines</span><span className="v">{fmt(open.length)}</span><span className="s">{fmtQty(open.reduce((t, l) => t + need(l), 0))} QTY to send</span></div>
            <div className="kpi"><span className="k">Pick now</span><span className="v">{fmt(open.filter((l) => nextStep(l).rank <= 1).length)}</span><span className="s">{fmtQty(readyQty)} QTY with UR ready</span></div>
            <div className="kpi"><span className="k">Due today / overdue</span><span className="v">{fmt(open.filter((l) => ['Overdue', 'Today'].includes(due(l, today))).length)}</span><span className="s">lines</span></div>
            <div className="kpi"><span className="k">Completed</span><span className="v">{fmt(doneToday)}</span><span className="s">of {fmt(rows.length)} lines in the current plans</span></div>
          </section>

          {first.length > 0 && (
            <section className="card do-first" aria-labelledby="df-title">
              <h2 id="df-title">Do first</h2>
              <ol className="df-list">
                {first.map(({ l, due: d }) => {
                  const n = nextStep(l);
                  return (
                    <li key={`${l.plan_type}-${l.id}`}>
                      <span className={`pill ${n.tone}`}>{n.step}</span>
                      <b>{l.so} / {l.li}</b><span className="muted">{l.item} · {l.plant || '–'} · {l.plan_type === 'day' ? (/~(\d+)$/.exec(l.week || '') ? `Pick ${/~(\d+)$/.exec(l.week || '')![1]}` : 'day plan') : 'week plan'}</span>
                      <span className={`pill ${d === 'Overdue' ? 'bad' : d === 'Today' ? 'warn' : 'mute'}`}>{d}{l.date ? ` · ${fmtDate(l.date)}` : ''}</span>
                      <span className="n"><b>{fmtQty(need(l))}</b> to send · UR {fmtQty(avail(l))}</span>
                      {canEdit && <button className="btn sm primary" onClick={() => setPicking(l)}>Pick</button>}
                    </li>
                  );
                })}
              </ol>
            </section>
          )}

          {!open.length ? <div className="card empty"><strong>Nothing open</strong><span>All lines of your current week and day plans are complete.</span></div> : groups.map((g) => (
            <section key={g.due} className="card" aria-label={g.due}>
              <h2 style={{ display: 'flex', gap: 8, alignItems: 'center' }}>{g.due} <span className={`pill ${g.due === 'Overdue' ? 'bad' : g.due === 'Today' ? 'warn' : 'mute'}`}>{g.lines.length}</span></h2>
              <div className="table-wrap" style={{ maxHeight: 'none' }}>
                <table className="mini">
                  <thead><tr><th>Next step</th><th>SO</th><th>LI</th><th>Item</th><th>Plan</th><th>Date</th><th>Plant</th><th className="n">QTY</th><th className="n">Picked</th><th className="n">To send</th><th className="n">UR left</th><th /></tr></thead>
                  <tbody>{g.lines.map((l) => {
                    const n = nextStep(l);
                    return (
                      <tr key={`${l.plan_type}-${l.id}`}>
                        <td><span className={`pill ${n.tone}`}>{n.step}</span>{isPrio(l) && <span className="pill warn" style={{ marginLeft: 4 }}>priority</span>}</td>
                        <td>{l.so}</td><td>{l.li}</td><td>{l.item}</td><td>{l.plan_type === 'day' ? 'Day' : 'Week'}</td><td>{fmtDate(l.date)}</td><td>{l.plant}</td>
                        <td className="n">{fmtQty(l.qty)}</td><td className="n">{l.picked ? fmtQty(l.picked) : '–'}</td><td className="n"><b>{fmtQty(need(l))}</b></td><td className="n">{fmtQty(avail(l))}</td>
                        <td style={{ whiteSpace: 'nowrap' }}>{canEdit && n.rank <= 2 && <button className="btn sm primary" onClick={() => setPicking(l)}>Pick</button>}
                          {canEdit && <> <CompleteLine line={l} onDone={(m) => { toast(m); load(); }} /></>}</td>
                      </tr>
                    );
                  })}</tbody>
                </table>
              </div>
            </section>
          ))}
        </>
      )}
      {picking && <PickModal week={picking.week} line={picking} onClose={() => setPicking(null)} onDone={(m) => { setPicking(null); toast(m); load(); }} />}
    </main>
  );
}
