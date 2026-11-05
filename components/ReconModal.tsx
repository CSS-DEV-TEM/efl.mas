'use client';
import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { SAP_FIX } from '@/lib/sapkb';

/** v152: Korber ↔ SAP tally of a Pick — each Material: SAP UR (ZMMBE), the rolls in ZROLLMGT and on the shelf (Korber), what differs and how to fix it. */
type RRoll = { pallet: string; batch: string | null; korber: number | null; sap: number | null; bin: string | null; location: string | null; kind: string; why: string };
type RItem = { item: string; trim: boolean; lines: number; plan: number; picked?: number; ur: number; need: number; korber: number; state: 'ok' | 'okCheck' | 'short' | 'none' | 'noUr';
  batches: { batch: string; ur: number; zroll: number | null; korber: number; rolls: number }[]; rolls: RRoll[]; more: number };
type Recon = { rid: string; zroll: boolean; bin: string; items: RItem[]; totals: Record<string, number> };
const q = (n: number | null | undefined) => (n === null || n === undefined ? '–' : (Math.round(n * 100) / 100).toLocaleString(undefined, { maximumFractionDigits: 2 }));
const STATE: Record<RItem['state'], [string, string, string, string]> = {
  ok: ['ok', '✓ Ready', 'Korber rolls match SAP and cover the QTY — pick it.', 'Korber rolls SAP එක්ක match වෙනවා, QTY එකත් සම්පූර්ණයි — pick කරන්න.'],
  okCheck: ['info', '✓ Ready · check', 'The QTY is covered, but some rolls differ between Korber and SAP — see below.', 'QTY එක සම්පූර්ණයි, ඒත් සමහර rolls Korber සහ SAP අතර වෙනස් — පහළ බලන්න.'],
  short: ['warn', '◐ Short', 'Korber has fewer pickable rolls than the QTY still to pick (at most the SAP UR).', 'Pick කරන්න ඉතුරු QTY එකට (SAP UR එක දක්වා) වඩා pick කරන්න පුළුවන් Korber rolls අඩුයි.'],
  none: ['bad', '✕ No roll', 'SAP has UR but no Korber roll can be picked for it.', 'SAP එකේ UR තියෙනවා, ඒත් pick කරන්න පුළුවන් Korber roll එකක් නැහැ.'],
  noUr: ['bad', '✕ No UR', 'The plan\'s SO lines have no UR in ZMMBE — nothing can be picked.', 'Plan එකේ SO lines වලට ZMMBE එකේ UR නැහැ — pick කරන්න බැහැ.'],
};
const KIND: Record<string, [string, string]> = {
  notInSap: ['In Korber, not in ZROLLMGT', 'Korber එකේ තියෙනවා, ZROLLMGT එකේ නැහැ'],
  notInKorber: ['In ZROLLMGT, not in Korber', 'ZROLLMGT එකේ තියෙනවා, Korber එකේ නැහැ'],
  qtyDiff: ['QTY differs', 'QTY වෙනස්'],
  bin: ['StorageBin / Status', 'StorageBin / Status'],
  otherBatch: ['Another SAP batch', 'වෙන SAP batch එකක්'],
  wms: ['On a Korber pick', 'Korber pick එකක'],
  rejected: ['Rejected', 'Reject කරලා'],
  location: ['Location blocked', 'Location block'],
  noZroll: ['No ZROLLMGT', 'ZROLLMGT නැහැ'],
};

export default function ReconModal({ rid, label, onClose }: { rid: string; label: string; onClose: () => void }) {
  const [r, setR] = useState<Recon | null>(null);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'issues'>('issues');
  useEffect(() => { api<Recon>('/api/pick/recon?rid=' + encodeURIComponent(rid)).then(setR).catch((e) => setErr(e instanceof Error ? e.message : 'Could not load.')); }, [rid]);
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; addEventListener('keydown', k); return () => removeEventListener('keydown', k); }, [onClose]);
  const items = useMemo(() => (r?.items || []).filter((x) => filter === 'all' || x.state !== 'ok'), [r, filter]);
  const n = (k: string) => r?.totals[k] ?? 0;
  return (
    <div className="modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal recon" role="dialog" aria-labelledby="recon-t" style={{ width: 'min(1100px, 100%)' }}>
        <div className="modal-head">
          <div>
            <h2 id="recon-t">🔄 Korber ↔ SAP tally · {label}</h2>
            <p className="muted small">Each Material of this Pick: SAP UR (ZMMBE), the rolls SAP has (ZROLLMGT{r ? ` at ${r.bin}` : ''}) and the rolls on the shelf (Korber), matched roll by roll.<span className="si si-line" lang="si">මේ Pick එකේ හැම Material එකකටම SAP UR, SAP rolls (ZROLLMGT) සහ shelf එකේ rolls (Korber) roll එකින් එක match කරලා.</span></p>
          </div>
          <button className="btn sm" onClick={onClose} aria-label="Close">✕</button>
        </div>
        {err && <div className="notice bad">{err}</div>}
        {!r && !err && <div className="skel" style={{ height: 180 }} />}
        {r && (
          <>
            <div className="recon-sum">
              <span className="pill ok">{n('state_ok') + n('state_okCheck')} ready</span>
              <span className="pill warn">{n('state_short')} short</span>
              <span className="pill bad">{n('state_none') + n('state_noUr')} cannot pick</span>
              <span className="muted small">Rolls: {n('ok')} match · {n('qtyDiff')} QTY differs · {n('notInSap')} not in ZROLLMGT · {n('notInKorber')} not in Korber · {n('bin')} StorageBin · {n('otherBatch')} other batch</span>
              <span className="seg sm" role="radiogroup" style={{ marginLeft: 'auto' }}>
                <button type="button" className={filter === 'issues' ? 'on' : ''} aria-checked={filter === 'issues'} role="radio" onClick={() => setFilter('issues')}>Needs attention</button>
                <button type="button" className={filter === 'all' ? 'on' : ''} aria-checked={filter === 'all'} role="radio" onClick={() => setFilter('all')}>All</button>
              </span>
            </div>
            {!r.zroll && <div className="notice warn">No ZROLLMGT for this Pick — upload it to tally the rolls with SAP.<span className="si si-line" lang="si">මේ Pick එකට ZROLLMGT upload කරලා නැහැ — SAP එක්ක tally කරන්න ඒක upload කරන්න.</span></div>}
            {!items.length && <div className="empty">Everything matches ✓ <span className="si" lang="si">සේරම match වෙනවා ✓</span></div>}
            <div className="recon-list">
              {items.map((it, i) => {
                const used = it.state === 'noUr' && (it.picked ?? 0) > 0;
                const [tone, title, en, si] = used ? ['warn', '◑ UR used up', `${q(it.picked)} of ${q(it.plan)} is picked — the rest has no UR in ZMMBE yet.`, `${q(it.plan)}න් ${q(it.picked)}ක් pick කරලා — ඉතුරුවට තාම ZMMBE එකේ UR නැහැ.`] as const : STATE[it.state];
                const on = open === it.item;
                const kinds = Array.from(new Set(it.rolls.map((x) => x.kind)));
                return (
                  <div key={it.item} className={`recon-item tone-${tone}`} style={{ animationDelay: `${Math.min(i, 12) * 40}ms` }}>
                    <button type="button" className="recon-head" onClick={() => setOpen(on ? null : it.item)} aria-expanded={on}>
                      <b className="mono">{it.item}</b>{it.trim && <span className="pill info">INTERLINING / FUSIBLE</span>}
                      <span className={`pill ${tone}`}>{title}</span>
                      <span>Plan <b>{q(it.plan)}</b></span>{(it.picked ?? 0) > 0 && <span>Picked <b>{q(it.picked)}</b></span>}<span>To pick <b>{q(it.need)}</b></span><span>SAP UR left <b>{q(it.ur)}</b></span><span>Korber pickable <b>{q(it.korber)}</b></span>
                      <span className="muted small">{it.lines} line{it.lines === 1 ? '' : 's'}</span>
                      <span className="so-arrow">{on ? '▾' : '▸'}</span>
                    </button>
                    {on && (
                      <div className="recon-body">
                        <p className="small">{en} <span className="si" lang="si">{si}</span></p>
                        <table className="mini">
                          <thead><tr><th>SAP batch</th><th className="n" title="ZMMBE UR less the picks saved after the ZMMBE upload">SAP UR left (ZMMBE)</th><th className="n">ZROLLMGT</th><th className="n">Korber pickable</th><th className="n">Rolls</th><th>Tally</th></tr></thead>
                          <tbody>{it.batches.map((b) => {
                            const d = b.korber - b.ur;
                            return <tr key={b.batch}><td className="mono">{b.batch}</td><td className="n">{q(b.ur)}</td><td className="n">{q(b.zroll)}</td><td className="n">{q(b.korber)}</td><td className="n">{b.rolls}</td>
                              <td>{b.ur <= 1e-9 ? <span className="pill mute">no UR</span> : Math.abs(d) <= 0.01 ? <span className="pill ok">= UR</span> : d < 0 ? <span className="pill warn">{q(-d)} less on the shelf</span> : <span className="pill info">{q(d)} more on the shelf</span>}</td></tr>;
                          })}</tbody>
                        </table>
                        {it.rolls.length > 0 && (
                          <>
                            <table className="mini" style={{ marginTop: 8 }}>
                              <thead><tr><th>Roll / Pallet</th><th>Batch</th><th className="n">Korber</th><th className="n">ZROLLMGT</th><th>Bin / Location</th><th>What differs</th></tr></thead>
                              <tbody>{it.rolls.map((x) => (
                                <tr key={x.pallet + x.kind}><td className="mono">{x.pallet}</td><td className="mono">{x.batch ?? '–'}</td><td className="n">{q(x.korber)}</td><td className="n">{q(x.sap)}</td><td>{[x.bin, x.location].filter(Boolean).join(' · ') || '–'}</td>
                                  <td><b>{KIND[x.kind]?.[0] ?? x.kind}</b><div className="muted small">{x.why}</div></td></tr>
                              ))}</tbody>
                            </table>
                            {it.more > 0 && <p className="muted small">+ {it.more} more rolls</p>}
                            <div className="recon-fix">
                              {kinds.filter((k) => SAP_FIX[k]).map((k) => (
                                <div key={k} className="coach-tip tone-info"><span className="ct-icon" aria-hidden>📘</span>
                                  <div><b>{KIND[k]?.[0]} — how to fix</b>{SAP_FIX[k].map((s0, j) => <p key={j}>{s0.en}<br /><span className="si" lang="si">{s0.si}</span></p>)}</div></div>
                              ))}
                            </div>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <p className="muted small">Counts only — nothing is changed. The pick itself always checks SAP and Korber again when it is saved.</p>
          </>
        )}
      </div>
    </div>
  );
}
