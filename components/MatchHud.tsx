'use client';
/**
 * v198: the Match HUD — "Pick all matched" shown as it happens. Each open line goes round the dial, one stage at a time:
 * SO line (ZMMBE UR) → ZINSR lot → ZROLLMGT (Mat. Doc / bin / status) → Korber pallet → rules & cut → saved.
 * It only SHOWS the run: the picking goes on as before, and the events it gets are what the run really did (the rolls the
 * system chose, what was saved, why a line was left). When lines queue up the animation runs faster to keep up.
 */
import * as React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';

export type HudLot = { lot: string; vb: string; qty: number };
export type HudRoll = { pallet: string; lot: string; qty: number; cut: boolean; loc: string; tn: boolean };
export type HudEv =
  | { t: 'start'; kind: 'normal' | 'offsite'; label: string; lines: { so: string; li: string; item: string }[] }
  | { t: 'line'; i: number; so: string; li: string; item: string; need: number; left: number; ur: number | null }
  | { t: 'cands'; i: number; rolls: number; pool: number; blocked: number; lots: HudLot[] }
  | { t: 'sel'; i: number; rolls: HudRoll[] }
  | { t: 'done'; i: number; ok: 'picked' | 'skip' | 'error'; text: string; got: number }
  | { t: 'tally'; text: string }
  | { t: 'end'; stopped: boolean };

type Group = { i: number; line?: Extract<HudEv, { t: 'line' }>; cands?: Extract<HudEv, { t: 'cands' }>; sel?: Extract<HudEv, { t: 'sel' }>; done?: Extract<HudEv, { t: 'done' }> };

const STAGES = [
  { k: 'SO LINE', s: 'ZMMBE UR', icon: <path d="M4 6h16M4 12h10M4 18h7" /> },
  { k: 'ZINSR', s: 'inspection lot', icon: <><rect x="5" y="4" width="14" height="17" rx="2" /><path d="M9 9h6M9 13h6M9 17h3" /></> },
  { k: 'ZROLLMGT', s: 'Mat. Doc · bin', icon: <><circle cx="12" cy="12" r="7" /><circle cx="12" cy="12" r="2.5" /></> },
  { k: 'KORBER', s: 'pallet · lot', icon: <><path d="M3 8l9-4 9 4-9 4z" /><path d="M3 8v8l9 4 9-4V8" /></> },
  { k: 'RULES', s: 'lot QTY · cut', icon: <><path d="M6 4v16M18 4v16" /><path d="M6 9h12M6 15h12" /></> },
  { k: 'SAVE', s: 'pick saved', icon: <path d="m5 12 4.5 4.5L19 7" /> },
];
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const fq = (x: number) => (Math.round(x * 1000) / 1000).toLocaleString(undefined, { maximumFractionDigits: 3 });

/** an arc segment of the dial (degrees, 0 = top, clockwise) */
function arc(cx: number, cy: number, r0: number, r1: number, a0: number, a1: number) {
  const p = (r: number, a: number) => [cx + r * Math.sin((a * Math.PI) / 180), cy - r * Math.cos((a * Math.PI) / 180)];
  const [x0, y0] = p(r1, a0), [x1, y1] = p(r1, a1), [x2, y2] = p(r0, a1), [x3, y3] = p(r0, a0);
  const lg = a1 - a0 > 180 ? 1 : 0;
  return `M${x0},${y0} A${r1},${r1} 0 ${lg} 1 ${x1},${y1} L${x2},${y2} A${r0},${r0} 0 ${lg} 0 ${x3},${y3} Z`;
}

export default function MatchHud({ feed, finished, onClose, onStop }: { feed: React.MutableRefObject<HudEv[]>; finished: boolean; onClose: () => void; onStop: () => void }) {
  const [, setFrame] = useState(0);
  // playback position: which line is on the dial, its stage (0–6) and how many of its rolls are shown
  // opened again part way (Live view): it goes on from the last line already done, not from the first
  const seen = (() => { const d = new Set<number>(); for (const e of feed.current) if (e.t === 'done') d.add(e.i); return Array.from(d).sort((a, b) => a - b); })();
  const play = useRef({ g: seen.length ? seen[seen.length - 1] : -1, stage: seen.length ? 6 : 0, rolls: 99, at: 0, dwell: 0 });
  const [shownDone, setShownDone] = useState<number[]>(seen);
  const reduce = useMemo(() => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches, []);

  // the events, grouped by line
  const read = () => {
    const ev = feed.current;
    const start = ev.find((e) => e.t === 'start') as Extract<HudEv, { t: 'start' }> | undefined;
    const groups: Group[] = [];
    let tally = '', end: Extract<HudEv, { t: 'end' }> | undefined;
    for (const e of ev) {
      if (e.t === 'line' || e.t === 'cands' || e.t === 'sel' || e.t === 'done') {
        const g = groups[e.i] ?? (groups[e.i] = { i: e.i });
        if (e.t === 'line') g.line = e; else if (e.t === 'cands') g.cands = e; else if (e.t === 'sel') g.sel = e; else g.done = e;
      } else if (e.t === 'tally') tally = e.text; else if (e.t === 'end') end = e;
    }
    return { start, groups, tally, end };
  };

  useEffect(() => {
    const id = setInterval(() => {
      const { groups } = read();
      const p = play.current, now = Date.now();
      const backlog = groups.filter((g) => g.done).length - (p.g + 1);
      const D = reduce ? 0 : backlog > 6 ? 40 : backlog > 2 ? 110 : 300;
      if (now - p.at < D) return;
      const g = groups[p.g];
      const next = () => { if (groups[p.g + 1]?.line) { p.g += 1; p.stage = 1; p.rolls = 0; p.at = now; } };
      if (!g) { next(); setFrame((x) => x + 1); return; }
      const nRolls = g.sel?.rolls.length ?? 0;
      if (p.stage === 1 && (g.cands || g.done)) p.stage = 2;
      else if (p.stage === 2 && (g.cands || g.done)) p.stage = 3;
      else if (p.stage === 3 && (g.sel || g.done)) p.stage = 4;
      else if (p.stage === 4 && p.rolls < nRolls) p.rolls += 1;
      else if (p.stage === 4 && (g.sel || g.done)) p.stage = 5;
      else if (p.stage === 5 && g.done) { p.stage = 6; setShownDone((d) => [...d, g.i]); }
      else if (p.stage === 6) { if (now - p.at > D * 2.2) next(); else return; }
      else return;
      p.at = now;
      setFrame((x) => x + 1);
    }, 30);
    return () => clearInterval(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Esc closes (the run goes on)
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);

  const { start, groups, tally, end } = read();
  const p = play.current;
  const cur = groups[p.g];
  const shown = groups.filter((g) => g && shownDone.includes(g.i));
  const total = start?.lines.length ?? 0;
  const picked = shown.filter((g) => g.done?.ok === 'picked');
  const rollsN = picked.reduce((t, g) => t + (g.sel?.rolls.length ?? 0), 0);
  const qty = r3(picked.reduce((t, g) => t + (g.done?.got ?? 0), 0));
  const manual = shown.filter((g) => g.done?.ok !== 'picked').length;
  const caughtUp = finished && shown.length >= groups.filter(Boolean).length;
  const stage = caughtUp ? 6 : p.stage;
  const listRef = useRef<HTMLOListElement>(null);
  useEffect(() => { listRef.current?.querySelector('.on')?.scrollIntoView({ block: 'nearest', behavior: reduce ? 'auto' : 'smooth' }); }, [p.g, reduce]);

  const seg = 360 / STAGES.length;
  return (
    <div className="hud-back" role="dialog" aria-modal="true" aria-label="Pick all matched — live">
      <div className="hud">
        <header className="hud-top">
          <div className="hud-id">
            <span className="hud-logo" aria-hidden><svg viewBox="0 0 24 24" width="26" height="26"><g stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">{Array.from({ length: 8 }, (_, i) => <line key={i} x1="12" y1="12" x2={12 + 9 * Math.cos((i * Math.PI) / 4)} y2={12 + 9 * Math.sin((i * Math.PI) / 4)} />)}</g></svg></span>
            <div><b>Auto Match</b><small>{start?.label || 'Pick all matched'}</small></div>
          </div>
          <span className={`hud-mode ${caughtUp ? 'fin' : ''}`}><i />{caughtUp ? (end?.stopped ? 'STOPPED' : 'FINISHED') : `AUTOPILOT · ${(start?.kind || 'normal').toUpperCase()}`}</span>
          <div className="hud-tiles">
            <div><small>LINES</small><b>{shown.length}<em>/{total}</em></b></div>
            <div><small>PICKED</small><b>{picked.length}</b></div>
            <div><small>ROLLS</small><b>{rollsN}</b></div>
            <div><small>QTY</small><b>{fq(qty)}</b></div>
            <div className={manual ? 'warn' : ''}><small>MANUAL</small><b>{manual}</b></div>
            <div className="hot"><small>STEP</small><b>{stage}<em>/6</em></b></div>
          </div>
          <div className="hud-acts">
            {!finished && <button type="button" className="hud-btn" onClick={onStop}>Stop</button>}
            <button type="button" className="hud-btn" onClick={onClose} title="Esc">{finished ? 'Close' : 'Hide'}</button>
          </div>
        </header>

        <div className="hud-grid">
          {/* left: the SO line on the dial and its ZINSR lots */}
          <section className="hud-card hud-line">
            <div className="hud-tag"><i />SO LINE</div>
            {cur?.line ? (
              <>
                <h3>{cur.line.so} <span>/ {cur.line.li}</span></h3>
                <p className="mono">{cur.line.item}</p>
                <div className="hud-kv"><span>TO PICK</span><b>{fq(cur.line.left)}</b></div>
                <div className="hud-kv"><span>PLAN QTY</span><b>{fq(cur.line.need)}</b></div>
                {cur.line.ur !== null && <div className="hud-kv"><span>UR</span><b>{fq(cur.line.ur)}</b></div>}
                <div className="hud-meter"><i style={{ width: `${cur.done && cur.line.left > 0 ? Math.min(100, (cur.done.got / cur.line.left) * 100) : 0}%` }} /></div>
              </>
            ) : <p className="hud-wait">Reading the first line…</p>}
          </section>
          <section className="hud-card hud-lots">
            <div className="hud-tag"><i />ZINSR LOTS<span>{cur?.cands ? cur.cands.lots.length : '–'}</span></div>
            <ul>{(p.stage >= 2 && cur?.cands ? cur.cands.lots : []).slice(0, 6).map((l, k) => (
              <li key={l.lot} style={{ animationDelay: `${k * 50}ms` }}><span className="mono">{l.lot}</span><em>{l.vb || '—'}</em><b>{fq(l.qty)}</b></li>
            ))}</ul>
            {p.stage >= 3 && cur?.cands && (
              <div className="hud-chips">
                <span className="ok">{cur.cands.rolls} roll{cur.cands.rolls === 1 ? '' : 's'} matched</span>
                {cur.cands.pool > 0 && <span className="warn">{cur.cands.pool} shared</span>}
                {cur.cands.blocked > 0 && <span className="bad">{cur.cands.blocked} blocked</span>}
              </div>
            )}
          </section>

          {/* the dial */}
          <section className="hud-dial" aria-label={`Stage ${stage} of 6: ${STAGES[Math.max(0, stage - 1)]?.k ?? ''}`}>
            <svg viewBox="0 0 300 300">
              <defs>
                <linearGradient id="hudHot" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#ffa53a" /><stop offset="1" stopColor="#f2384a" /></linearGradient>
                <radialGradient id="hudCore"><stop offset="0" stopColor="#2c2d35" /><stop offset="1" stopColor="#17181d" /></radialGradient>
              </defs>
              {/* the outer ring: lines done of all */}
              <circle cx="150" cy="150" r="142" className="hud-ring" />
              <circle cx="150" cy="150" r="142" className="hud-ring-on" strokeDasharray={`${total ? (shown.length / total) * 892 : 0} 892`} transform="rotate(-90 150 150)" />
              {Array.from({ length: 60 }, (_, k) => { const a = (k * 6 * Math.PI) / 180; return <line key={k} className="hud-tick" x1={150 + 128 * Math.sin(a)} y1={150 - 128 * Math.cos(a)} x2={150 + (k % 5 ? 124 : 120) * Math.sin(a)} y2={150 - (k % 5 ? 124 : 120) * Math.cos(a)} />; })}
              {STAGES.map((s, k) => {
                const a0 = k * seg + 2, a1 = (k + 1) * seg - 2, mid = (a0 + a1) / 2;
                const st = k + 1 < stage ? 'past' : k + 1 === stage ? 'hot' : 'idle';
                const ix = 150 + 88 * Math.sin((mid * Math.PI) / 180), iy = 150 - 88 * Math.cos((mid * Math.PI) / 180);
                return (
                  <g key={s.k} className={`hud-seg ${st}`}>
                    <path d={arc(150, 150, 62, 114, a0, a1)} />
                    <g transform={`translate(${ix - 9} ${iy - 13}) scale(.75)`} className="hud-seg-ic"><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{s.icon}</svg></g>
                    <text x={ix} y={iy + 17} textAnchor="middle">{s.k}</text>
                  </g>
                );
              })}
              <circle cx="150" cy="150" r="54" fill="url(#hudCore)" className="hud-core" />
              <g className={`hud-spark ${caughtUp ? '' : 'spin'}`}>{Array.from({ length: 10 }, (_, k) => <line key={k} x1="150" y1="150" x2={150 + 22 * Math.cos((k * Math.PI) / 5)} y2={150 + 22 * Math.sin((k * Math.PI) / 5)} />)}</g>
            </svg>
            <div className="hud-dial-cap"><b>{STAGES[Math.max(0, stage - 1)]?.k ?? 'READY'}</b><small>{STAGES[Math.max(0, stage - 1)]?.s ?? ''}</small></div>
          </section>

          {/* right: the queue of lines and the rolls of this line */}
          <section className="hud-card hud-stages">
            <div className="hud-tag"><i />LINES<span>{shown.length}/{total}</span></div>
            <ol ref={listRef}>{(start?.lines ?? []).map((l, k) => {
              const g = groups[k]; const done = shownDone.includes(k);
              const st = done ? (g?.done?.ok === 'picked' ? 'ok' : g?.done?.ok === 'error' ? 'bad' : 'warn') : k === p.g ? 'on' : '';
              return (
                <li key={k} className={st}>
                  <span className="hud-n">{k + 1}</span>
                  <div><b>{l.so} / {l.li}</b><small className="mono">{l.item}</small></div>
                  <em>{done ? (g?.done?.ok === 'picked' ? fq(g.done.got) : g?.done?.ok === 'error' ? 'error' : 'manual') : k === p.g ? '…' : ''}</em>
                </li>
              );
            })}</ol>
          </section>
          <section className="hud-card hud-rolls">
            <div className="hud-tag"><i />KORBER ROLLS<span>{cur?.sel ? `${Math.min(p.rolls, cur.sel.rolls.length)}/${cur.sel.rolls.length}` : '–'}</span></div>
            <ul>{(cur?.sel?.rolls ?? []).slice(0, Math.max(0, p.rolls)).slice(-7).map((r) => (
              <li key={r.pallet}>
                <span className="mono">{r.pallet}</span>
                <em>{r.lot}</em>
                <b>{fq(r.qty)}</b>
                {r.cut && <i className="cut">CUT</i>}{r.tn && <i className="tn">TN</i>}
              </li>
            ))}</ul>
            {p.stage >= 5 && cur?.done && <p className={`hud-res ${cur.done.ok}`}>{cur.done.ok === 'picked' ? '✓ ' : cur.done.ok === 'error' ? '✕ ' : '! '}{cur.done.text}</p>}
          </section>
        </div>

        <footer className="hud-foot">
          <div className="hud-bar"><i style={{ width: `${total ? (shown.length / total) * 100 : 0}%` }} /></div>
          <span>{caughtUp ? `${picked.length} line${picked.length === 1 ? '' : 's'} picked · ${manual} left for manual${tally ? ` · ${tally}` : ''}` : finished ? 'Saved — showing the last lines…' : 'Picking — the lines are saved as they go; Hide keeps it running'}</span>
        </footer>
      </div>
    </div>
  );
}
