'use client';
/**
 * v212: a plant's (or all plants') plan as it flowed through the system — opened from a Plant summary card.
 *  · Timeline: the 1st Pick all matched, the SAP / Korber reports uploaded after it, each balance pick, balances completed by hand
 *  · UR flow: Plan QTY → UR / QI / Block / no stock; Plan UR → dispatched / picked not yet dispatched / pending; what was released since the 1st pick
 *  · Runs + PL: each run's picks with its own Packing List, and one of all runs
 *  · Lines pending: every line with a balance and why it is still open
 * Read only: nothing here changes a line or a pick.
 */
import * as React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { fmt, isDone, type Line } from '@/lib/calc';
import { packingListWorkbook, saveWorkbook, type PickHistory, type PickReq } from '@/lib/pick';
import { catLabel, lineRef, runLabel, runOf, type RepickData } from '@/lib/repick';

const q2 = (x: number) => (Math.abs(x) > 0.0005 ? fmt(x, 2) : '0');
const when = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? iso : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); };
const SRC: Record<string, string> = { zmmbe: 'ZMMBE (SAP UR / QI / Block)', korber: 'Korber Inventory', zrollmgt: 'ZROLLMGT', zroll: 'ZROLLMGT', zinsr: 'ZINSR', zinr: 'ZINSR', zcoment: 'ZCOMMENT', ztrr: 'ZTRR', dispatch: 'Dispatch', plan: 'Plan', tn: 'Transfer notes' };
const isTally = (p: { note?: string | null }) => String(p.note ?? '').startsWith('Cut roll balance tallied');

type Ev = { at: string; kind: 'run' | 'up' | 'close' | 'rel'; title: string; sub: string };

export default function PlanFlow({ title, lines, repick, onClose, onLines, toast }: {
  title: string; lines: Line[]; repick: RepickData; onClose: () => void; /** show the plant's lines in Details (null = all plants) */ onLines?: () => void; toast: (m: string) => void;
}) {
  const rids = useMemo(() => Array.from(new Set(lines.map((l) => l.week))).sort(), [lines]);
  const refs = useMemo(() => new Set(lines.map(lineRef)), [lines]);
  const [h, setH] = useState<PickHistory | null>(null);
  const [err, setErr] = useState('');
  const [tab, setTab] = useState<'time' | 'ur' | 'runs' | 'pending'>('time');

  // every pick of these Picks (all days), kept to this plant's lines
  useEffect(() => {
    let on = true;
    (async () => {
      try {
        const hs = await Promise.all(rids.map((w) => api<PickHistory>('/api/pick/history?week=' + encodeURIComponent(w))));
        const requests: PickReq[] = [], seenR = new Set<number>(), seenP = new Set<number>();
        const picks: PickHistory['picks'] = [];
        for (const x of hs) {
          for (const r of x.requests) if (!seenR.has(r.id) && refs.has(`${r.week}|${r.line}`)) { seenR.add(r.id); requests.push(r); }
          for (const p of x.picks) if (!seenP.has(p.id) && seenR.has(p.req_id)) { seenP.add(p.id); picks.push(p); }
        }
        if (on) setH({ day: null, requests, picks, days: [], korberHeader: hs.find((x) => x.korberHeader)?.korberHeader ?? null });
      } catch (e) { if (on) setErr(e instanceof Error ? e.message : 'Could not read the picks.'); }
    })();
    return () => { on = false; };
  }, [rids, refs]);

  const runs = useMemo(() => repick.runs.filter((r) => rids.includes(r.rid)), [repick.runs, rids]);
  const uidOf = (rid: string) => repick.uids.find((u) => u.rid === rid)?.uid ?? '';
  const jobOf = (rid: string) => repick.jobs.find((j) => j.rid === rid)?.job_id ?? '';
  const pickTitle = (rid: string) => [uidOf(rid) || rid, jobOf(rid) ? `JOB ${jobOf(rid)}` : ''].filter(Boolean).join(' · ');

  // each pick's run (a cut roll's tallied balance goes with the run of the pick that cut the roll)
  const reqRun = useMemo(() => {
    const m = new Map<number, number>();
    if (!h) return m;
    const reqById = new Map(h.requests.map((r) => [r.id, r]));
    const ps = h.picks.filter((p) => !p.cancelled_at);
    for (const r of h.requests) m.set(r.id, runOf(runs, r.week, r.at));
    for (const p of ps) {
      if (!isTally(p)) continue;
      const src = ps.filter((x) => x.pallet === p.pallet && !isTally(x) && x.at <= p.at).sort((a, b) => a.at.localeCompare(b.at))[0];
      const sr = src && reqById.get(src.req_id);
      if (sr) m.set(p.req_id, runOf(runs, sr.week, sr.at));
    }
    return m;
  }, [h, runs]);

  const runRows = useMemo(() => {
    if (!h) return [];
    const live = h.requests.filter((r) => !r.cancelled_at);
    const byN = new Map<number, { n: number; ids: number[]; lines: Set<string>; qty: number; rolls: number; from: string; users: Set<string> }>();
    const pk = new Map<number, { q: number; n: number }>();
    for (const p of h.picks) if (!p.cancelled_at) { const x = pk.get(p.req_id) || { q: 0, n: 0 }; x.q += Number(p.qty) || 0; x.n++; pk.set(p.req_id, x); }
    for (const r of live) {
      const n = reqRun.get(r.id) ?? 1;
      const g = byN.get(n) || { n, ids: [], lines: new Set<string>(), qty: 0, rolls: 0, from: r.at, users: new Set<string>() };
      g.ids.push(r.id); g.lines.add(`${r.week}|${r.line}`); g.qty += pk.get(r.id)?.q ?? 0; g.rolls += pk.get(r.id)?.n ?? 0; if (r.at < g.from) g.from = r.at; g.users.add(r.by_user);
      byN.set(n, g);
    }
    return Array.from(byN.values()).sort((a, b) => a.n - b.n);
  }, [h, reqRun]);

  // what came in since the 1st pick: new UR, QI / Block released
  const flow = useMemo(() => {
    const base = new Map(repick.base.map((b) => [`${b.rid}|${b.key}|${b.date}`, b]));
    let plan = 0, ur = 0, qiH = 0, blH = 0, none = 0, disp = 0, pickedNd = 0, pend = 0, firstUr = 0, newUr = 0, qiRel = 0, blRel = 0, based = 0;
    for (const l of lines) {
      const q = Number(l.qty) || 0, u = Math.max(0, Number(l.ur) || 0), qi = Math.max(0, Number(l.qi) || 0), bl = Math.max(0, Number(l.block) || 0);
      const pu = Math.min(q, u), rest0 = q - pu, qh = Math.min(rest0, qi), bh = Math.min(rest0 - qh, bl);
      plan += q; ur += pu; qiH += qh; blH += bh; none += Math.max(0, rest0 - qh - bh);
      const d = Math.min(pu, Number(l.dispatched) || 0), pnd = Math.max(0, Math.min(pu, Number(l.picked) || 0) - d);
      disp += d; pickedNd += pnd; pend += Math.max(0, pu - d - pnd);
      const b = base.get(lineRef(l));
      if (b) { based++; firstUr += Math.min(q, Math.max(0, b.ur)); newUr += Math.max(0, u - b.ur); qiRel += Math.max(0, b.qi - qi); blRel += Math.max(0, b.block - bl); }
    }
    return { plan, ur, qiH, blH, none, disp, pickedNd, pend, firstUr, newUr, qiRel, blRel, based };
  }, [lines, repick.base]);

  const events = useMemo(() => {
    const ev: Ev[] = [];
    const first = runs.filter((r) => r.n === 1).map((r) => r.started_at).sort()[0] ?? h?.requests.map((r) => r.at).sort()[0] ?? '';
    for (const r of runs) {
      const g = runRows.find((x) => x.n === r.n);
      ev.push({ at: r.started_at, kind: 'run', title: `${runLabel(r.n)}${rids.length > 1 ? ` · ${pickTitle(r.rid)}` : ''}`, sub: `${r.by_user ? `by ${r.by_user}` : ''}${g ? ` · ${fmt(g.lines.size)} line${g.lines.size === 1 ? '' : 's'} · ${fmt(g.rolls)} roll${g.rolls === 1 ? '' : 's'} · ${q2(g.qty)} QTY` : ' · nothing picked for this plant'}` });
    }
    // reports: this Pick's own, and the shared ones uploaded from the day before the 1st pick
    const from = first ? new Date(new Date(first).getTime() - 86400000).toISOString() : '';
    for (const u of repick.uploads) {
      if (u.rid && !rids.includes(u.rid)) continue;
      if (u.src === 'kfc' || u.src === 'pfc' || u.src === 'plant') continue; // the ZMMBE's own parts (one upload)
      if (!u.rid && from && u.uploaded_at < from) continue;
      ev.push({ at: u.uploaded_at, kind: 'up', title: `${SRC[u.src] ?? u.src} uploaded`, sub: `${u.file_name ?? ''}${u.row_count ? ` · ${fmt(u.row_count)} rows` : ''} · by ${u.uploaded_by}${u.rid ? '' : ' · shared'}` });
    }
    for (const c of repick.close) if (refs.has(`${c.rid}|${c.key}|${c.date}`)) ev.push({ at: c.at, kind: 'close', title: `Balance completed · ${catLabel(c.cat)}`, sub: `${c.key.replace(/\|/g, ' / ')} · ${q2(c.qty)}${c.by_user ? ` · by ${c.by_user}` : ''}` });
    ev.sort((a, b) => a.at.localeCompare(b.at));
    if (flow.based && (flow.newUr > 1e-9 || flow.qiRel > 1e-9 || flow.blRel > 1e-9)) {
      ev.push({ at: new Date().toISOString(), kind: 'rel', title: 'Since the 1st pick (now)', sub: `New UR ${q2(flow.newUr)} · QI released ${q2(flow.qiRel)} · Block released ${q2(flow.blRel)}` });
    }
    return ev;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runs, runRows, repick.uploads, repick.close, refs, rids, flow, h]);

  const pending = useMemo(() => {
    const close = new Map(repick.close.map((c) => [`${c.rid}|${c.key}|${c.date}`, c]));
    const out: { l: Line; bal: number; why: string; c: string }[] = [];
    for (const l of lines) {
      const q = Number(l.qty) || 0, d = Number(l.dispatched) || 0, bal = Math.max(0, q - d);
      if (bal <= 1e-9 || isDone(l)) continue;
      const c = close.get(lineRef(l));
      const u = Math.max(0, Number(l.ur) || 0), qi = Number(l.qi) || 0, bl = Number(l.block) || 0, pk = Number(l.picked) || 0;
      let why = '', cl = '';
      if (c) { why = `Completed by hand · ${catLabel(c.cat)}`; cl = 'done'; }
      else if (l.hold) { why = `On hold · ${l.hold}`; cl = 'warn'; }
      else if (pk >= q - 1e-9) { why = 'Picked — waiting for dispatch'; cl = 'run'; }
      else if (u <= 1e-9 && qi > 1e-9) { why = `In QI (${q2(qi)}) — picked when released`; cl = 'warn'; }
      else if (u <= 1e-9 && bl > 1e-9) { why = `In Block (${q2(bl)}) — picked when released`; cl = 'warn'; }
      else if (u <= 1e-9) { why = 'No UR stock'; cl = 'bad'; }
      else if (pk >= Math.min(q, u) - 1e-9) { why = `UR picked (${q2(pk)}) — rest has no UR${qi > 1e-9 ? ` · QI ${q2(qi)}` : ''}${bl > 1e-9 ? ` · Block ${q2(bl)}` : ''}`; cl = 'bad'; }
      else { why = 'UR there — no matching roll picked yet (Pick → Needs manual)'; cl = 'info'; }
      out.push({ l, bal, why, c: cl });
    }
    return out.sort((a, b) => a.c.localeCompare(b.c) || b.bal - a.bal);
  }, [lines, repick.close]);

  const downloadPL = (n: number | null) => {
    if (!h) return;
    const ids = runRows.filter((g) => n === null || g.n === n).flatMap((g) => g.ids);
    if (!ids.length) { toast('No pick in this run.'); return; }
    const jobs = Object.fromEntries(repick.jobs.map((j) => [j.rid, j.job_id])), uids = Object.fromEntries(repick.uids.map((u) => [u.rid, u.uid]));
    const wb = packingListWorkbook(h, { ids: new Set(ids), combined: true, jobs, uids });
    const tag = (rids.length === 1 && uidOf(rids[0])) || rids[0] || 'plan';
    const file = `Packing_List_${tag}_${title.replace(/[^\w]+/g, '_')}_${n === null ? 'All_runs' : runLabel(n).replace(/[^\w]+/g, '_')}.xlsx`;
    saveWorkbook(wb, file);
    toast(`${file} — ${fmt(ids.length)} pick${ids.length === 1 ? '' : 's'}`);
  };

  const bar = (parts: { v: number; c: string; t: string }[], tot: number) => (
    <div className="pf-bar" role="img" aria-label={parts.map((p) => `${p.t} ${q2(p.v)}`).join(', ')}>
      {parts.map((p) => <i key={p.t} className={p.c} style={{ width: `${tot > 1e-9 ? Math.max(0, Math.min(100, (p.v / tot) * 100)) : 0}%` }} title={`${p.t}: ${q2(p.v)}`} />)}
    </div>
  );

  return (
    <div className="bal-back" role="dialog" aria-modal="true" aria-labelledby="pf-title" onClick={onClose}>
      <div className="bal-dlg card pf-dlg" onClick={(e) => e.stopPropagation()}>
        <header className="pf-head">
          <div>
            <h3 id="pf-title">{title} — plan flow</h3>
            <p className="muted small">{rids.map(pickTitle).join(' · ') || '—'} · {fmt(lines.length)} line{lines.length === 1 ? '' : 's'} · Plan {q2(flow.plan)}</p>
          </div>
          <div className="pf-acts">
            {onLines && <button type="button" className="btn sm" onClick={onLines}>Show lines</button>}
            <button type="button" className="btn sm" onClick={onClose} aria-label="Close">✕</button>
          </div>
        </header>
        <div className="ps-seg pf-tabs" role="tablist" aria-label="Plan flow">
          {([['time', 'Timeline'], ['ur', 'UR flow'], ['runs', `Runs + PL${runRows.length ? ` · ${runRows.length}` : ''}`], ['pending', `Lines pending · ${pending.length}`]] as const).map(([k, t]) => (
            <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{t}</button>
          ))}
        </div>
        {err && <div className="notice warn">{err}</div>}

        {tab === 'time' && (!h ? <p className="muted">Reading the picks…</p> : !events.length ? <p className="muted">Nothing picked yet — no run of Pick all matched for this plan.</p> : (
          <ol className="pf-time">
            {events.map((e, i) => <li key={i} className={e.kind}><time>{e.kind === 'rel' ? 'now' : when(e.at)}</time><b>{e.title}</b><small>{e.sub}</small></li>)}
          </ol>
        ))}

        {tab === 'ur' && (
          <div className="pf-ur">
            <h4>Plan QTY {q2(flow.plan)} → stock</h4>
            {bar([{ v: flow.ur, c: 'u', t: 'Plan UR' }, { v: flow.qiH, c: 'q', t: 'QI held' }, { v: flow.blH, c: 'b', t: 'Block held' }, { v: flow.none, c: 'n', t: 'No stock' }], flow.plan)}
            <div className="pf-figs"><span><i className="u" />Plan UR <b>{q2(flow.ur)}</b></span><span><i className="q" />QI held <b>{q2(flow.qiH)}</b></span><span><i className="b" />Block held <b>{q2(flow.blH)}</b></span><span><i className="n" />No stock <b>{q2(flow.none)}</b></span></div>
            <h4>Plan UR {q2(flow.ur)} → dispatch</h4>
            {bar([{ v: flow.disp, c: 'd', t: 'Dispatched' }, { v: flow.pickedNd, c: 'p', t: 'Picked, not dispatched' }, { v: flow.pend, c: 'w', t: 'UR pending' }], flow.ur)}
            <div className="pf-figs"><span><i className="d" />Dispatched <b>{q2(flow.disp)}</b></span><span><i className="p" />Picked, not dispatched <b>{q2(flow.pickedNd)}</b></span><span><i className="w" />UR pending <b>{q2(flow.pend)}</b></span></div>
            <h4>Since the 1st pick</h4>
            {flow.based ? (
              <div className="pf-figs pf-since"><span>First UR <b>{q2(flow.firstUr)}</b></span><span>New UR <b>{q2(flow.newUr)}</b></span><span>QI released <b>{q2(flow.qiRel)}</b></span><span>Block released <b>{q2(flow.blRel)}</b></span><span>Runs <b>{runRows.length}</b></span></div>
            ) : <p className="muted small">No 1st pick yet — the first UR is kept when Pick all matched runs.</p>}
          </div>
        )}

        {tab === 'runs' && (!h ? <p className="muted">Reading the picks…</p> : (
          <>
            {!runRows.length ? <p className="muted">No pick saved for this plan.</p> : (
              <table className="pf-tbl">
                <thead><tr><th>Run</th><th>Started</th><th>Lines</th><th>Rolls</th><th>QTY</th><th>By</th><th /></tr></thead>
                <tbody>
                  {runRows.map((g) => {
                    const r = runs.find((x) => x.n === g.n);
                    return <tr key={g.n}><td><b>{runLabel(g.n)}</b></td><td>{when(r?.started_at || g.from)}</td><td>{fmt(g.lines.size)}</td><td>{fmt(g.rolls)}</td><td>{q2(g.qty)}</td><td>{Array.from(g.users).join(', ')}</td>
                      <td><button type="button" className="btn sm" onClick={() => downloadPL(g.n)}>⬇ PL</button></td></tr>;
                  })}
                </tbody>
              </table>
            )}
            {runRows.length > 0 && <div className="bal-acts"><button type="button" className="btn primary" onClick={() => downloadPL(null)}>⬇ All runs PL</button></div>}
          </>
        ))}

        {tab === 'pending' && (!pending.length ? <p className="muted">No line pending — the plan is complete.</p> : (
          <div className="pf-scroll">
            <table className="pf-tbl">
              <thead><tr><th>SO / LI</th><th>Item</th><th>Date</th><th>QTY</th><th>UR</th><th>Picked</th><th>Disp.</th><th>Balance</th><th>Why</th></tr></thead>
              <tbody>
                {pending.map(({ l, bal, why, c }) => (
                  <tr key={lineRef(l)}><td>{l.so}/{l.li}</td><td>{l.item}</td><td>{l.date ?? ''}</td><td>{q2(Number(l.qty) || 0)}</td><td>{q2(Number(l.ur) || 0)}</td><td>{q2(Number(l.picked) || 0)}</td><td>{q2(Number(l.dispatched) || 0)}</td><td><b>{q2(bal)}</b></td><td><span className={`ps-chip ${c}`}>{why}</span></td></tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </div>
  );
}
