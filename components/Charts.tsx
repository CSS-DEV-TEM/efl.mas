'use client';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { COVERAGES, coverage, fmt, fmtDate, isDone, type Coverage, type Line } from '@/lib/calc';

export const COV_COLOR: Record<Coverage, string> = {
  Covered: 'var(--ok)', Partial: 'var(--warn)', 'QI / Block only': 'var(--info)', 'No stock': 'var(--bad)',
};

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(600);
  useLayoutEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(260, Math.floor(e.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return { ref, w };
}

interface Tip { x: number; y: number; title: string; rows: [string | null, string, string][] }
function TipBox({ tip }: { tip: Tip | null }) {
  if (!tip) return null;
  return (
    <div className="tip" style={{ left: tip.x, top: tip.y }}>
      <div className="t">{tip.title}</div>
      {tip.rows.map(([c, n, v]) => <div className="r" key={n}>{c && <i style={{ background: c }} />}{n}: <b>{v}</b></div>)}
    </div>
  );
}
function place(e: React.MouseEvent, box: HTMLDivElement | null) {
  const b = box?.getBoundingClientRect();
  if (!b) return { x: 0, y: 0 };
  let x = e.clientX - b.left + 14;
  if (x > b.width - 200) x = e.clientX - b.left - 200;
  return { x: Math.max(0, x), y: Math.max(0, e.clientY - b.top - 10) };
}

/** Required QTY per date, stacked by stock coverage. */
export function QtyByDate({ rows, onPick, picked }: { rows: Line[]; onPick: (d: string | null) => void; picked: string | null }) {
  const { ref, w } = useWidth();
  const [tip, setTip] = useState<Tip | null>(null);
  const data = useMemo(() => {
    const m = new Map<string, Record<Coverage, number> & { lines: number }>();
    for (const l of rows) {
      const d = l.date || 'No date';
      if (!m.has(d)) m.set(d, { Covered: 0, Partial: 0, 'QI / Block only': 0, 'No stock': 0, lines: 0 });
      const o = m.get(d)!;
      o[coverage(l)] += l.qty; o.lines++;
    }
    return Array.from(m.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([date, v]) => ({ date, ...v, total: COVERAGES.reduce((s, c) => s + v[c], 0) }));
  }, [rows]);

  const H = 230, mt = 8, mb = 28;
  const max = Math.max(1, ...data.map((d) => d.total));
  const step = 10 ** Math.floor(Math.log10(max)) / 2;
  const top = Math.ceil(max / step) * step;
  const ticks = [0, 1, 2, 3, 4].map((i) => (top / 4) * i);
  const ml = Math.max(...ticks.map((t) => fmt(t).length)) * 7 + 10;
  const plotW = w - ml - 6;
  const band = plotW / Math.max(1, data.length);
  const bw = Math.min(56, band * 0.62);
  const y = (v: number) => mt + (H - mt - mb) * (1 - v / top);

  return (
    <div ref={ref} className="chart">
      <div className="legend">{COVERAGES.map((c) => <span key={c}><i style={{ background: COV_COLOR[c] }} />{c}</span>)}</div>
      {data.length === 0 ? <p className="muted">No lines match the filters.</p> : (
        <svg viewBox={`0 0 ${w} ${H}`} role="img" aria-label="Required quantity by date">
          {ticks.map((t) => (
            <g key={t}>
              <line className="grid" x1={ml} x2={w - 6} y1={y(t)} y2={y(t)} />
              <text className="ax" x={ml - 8} y={y(t)} dy="0.32em" textAnchor="end">{fmt(t)}</text>
            </g>
          ))}
          {data.map((d, i) => {
            const x = ml + band * i + (band - bw) / 2;
            let base = 0;
            const dim = picked && picked !== d.date;
            return (
              <g key={d.date} className="bar-grow" opacity={dim ? 0.35 : 1} style={{ cursor: 'pointer', animationDelay: `${i * 90}ms` }}
                onClick={() => onPick(picked === d.date ? null : d.date)}
                onMouseMove={(e) => setTip({ ...place(e, ref.current), title: `${fmtDate(d.date)} · ${fmt(d.lines)} lines`, rows: [...COVERAGES.map((c) => [COV_COLOR[c], c, fmt(d[c], 1)] as [string, string, string]), [null, 'Total QTY', fmt(d.total, 1)]] })}
                onMouseLeave={() => setTip(null)}>
                {COVERAGES.map((c) => {
                  const v = d[c];
                  if (v <= 0) return null;
                  const r = <rect key={c} x={x} width={bw} y={y(base + v)} height={Math.max(0, y(base) - y(base + v))} fill={COV_COLOR[c]} stroke="var(--panel)" strokeWidth={1} />;
                  base += v;
                  return r;
                })}
                <rect x={ml + band * i} width={band} y={mt} height={H - mt - mb} fill="transparent" />
                <text className="ax" x={x + bw / 2} y={H - 9} textAnchor="middle">{fmtDate(d.date)}</text>
              </g>
            );
          })}
        </svg>
      )}
      <TipBox tip={tip} />
    </div>
  );
}

/** Done vs open lines per date, one bar each. */
export function ProgressByDate({ rows }: { rows: Line[] }) {
  const data = useMemo(() => {
    const m = new Map<string, { done: number; open: number; short: number }>();
    for (const l of rows) {
      const d = l.date || 'No date';
      if (!m.has(d)) m.set(d, { done: 0, open: 0, short: 0 });
      const o = m.get(d)!;
      if (isDone(l)) o.done++; else { o.open++; if (l.ur < l.qty) o.short++; }
    }
    return Array.from(m.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [rows]);
  if (!data.length) return <p className="muted">No lines match the filters.</p>;
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {data.map(([date, v]) => {
        const total = v.done + v.open;
        const pct = total ? v.done / total : 0;
        return (
          <div key={date} style={{ display: 'grid', gap: 4 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, gap: 8 }}>
              <b style={{ fontWeight: 600 }}>{fmtDate(date)}</b>
              <span className="num muted">{fmt(v.done)} / {fmt(total)} done · {fmt(v.short)} open short of stock</span>
            </div>
            <div className="meter" style={{ height: 10, marginTop: 0 }} title={`${Math.round(pct * 100)}% done`}>
              <span style={{ width: `${pct * 100}%`, background: 'var(--ok)' }} />
              <span style={{ width: `${total ? (v.short / total) * 100 : 0}%`, background: 'var(--bad)', opacity: 0.75 }} />
              <span style={{ width: `${total ? ((v.open - v.short) / total) * 100 : 0}%`, background: 'var(--line-strong)' }} />
            </div>
          </div>
        );
      })}
      <div className="legend" style={{ marginBottom: 0 }}>
        <span><i style={{ background: 'var(--ok)' }} />Done</span>
        <span><i style={{ background: 'var(--bad)', opacity: 0.75 }} />Open, UR below QTY</span>
        <span><i style={{ background: 'var(--line-strong)' }} />Open, stock covers QTY</span>
      </div>
    </div>
  );
}
