'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { ago, avail, fmt, fmtDate, fmtQty, isDispatched, need, type Line } from '@/lib/calc';
import { action } from '@/lib/smart';
import {
  PICK_SRCS, korberWorkbook, ordinal, packingListWorkbook, saveWorkbook, uploadPickFile,
  type Candidate, type Candidates, type KorberRow, type ManualRoll, type PickHistory, type PickSrc,
} from '@/lib/pick';

type LineP = Line & { picked?: number; picked_rolls?: number };
const today = () => new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);

/** Pick tab of the Dispatch page: the three pick reports, Ready-to-pull lines with Pick, and the pick history / Packing List. */
export default function PickWorkspace({ week, rows, canEdit, toast, reload }: { week: string; rows: LineP[]; canEdit: boolean; toast: (m: string) => void; reload: () => void }) {
  const [status, setStatus] = useState<{ counts: { src: string; n: number }[]; uploads: { src: string; file_name: string | null; row_count: number; uploaded_by: string; uploaded_at: string }[] } | null>(null);
  const [busy, setBusy] = useState<PickSrc | null>(null);
  const [scope, setScope] = useState<'ready' | 'open' | 'picked'>('ready');
  const [q, setQ] = useState('');
  const [picking, setPicking] = useState<LineP | null>(null);
  const [histKey, setHistKey] = useState(0);
  const inputs = useRef<Record<string, HTMLInputElement | null>>({});

  const loadStatus = useCallback(() => { api<NonNullable<typeof status>>('/api/pick/status').then(setStatus).catch(() => {}); }, []);
  useEffect(() => { loadStatus(); }, [loadStatus]);

  const upload = async (src: PickSrc, f: File) => {
    setBusy(src);
    try {
      const r = await uploadPickFile(src, f);
      toast(`${PICK_SRCS.find((x) => x.src === src)!.title}: ${fmt(r.rows)} rows saved${r.total > r.rows ? ` (of ${fmt(r.total)} in the file${src === 'korber' ? ' — only plan items kept' : src === 'zcoment' ? ' — Shade Report only' : ''})` : ''}`);
      loadStatus();
    } catch (e) { toast(e instanceof Error ? e.message : 'Upload failed.'); }
    finally { setBusy(null); }
  };

  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return rows.filter((l) => (scope === 'picked' ? (l.picked ?? 0) > 0 : need(l) > 1e-9 && (scope === 'open' ? avail(l) > 0 : action(l) === 'Ready to pull')))
      .filter((l) => !s || [l.so, l.li, l.item, l.plant].join(' ').toLowerCase().includes(s))
      .sort((a, b) => String(a.date ?? '').localeCompare(String(b.date ?? '')) || a.row_no - b.row_no);
  }, [rows, scope, q]);
  const cnt = (src: string) => status?.counts.find((c) => c.src === src)?.n ?? 0;

  return (
    <>
      <section className="card" aria-labelledby="pd-title">
        <h2 id="pd-title">Pick data</h2>
        <p className="sub">Upload in any order; each upload replaces the previous one. Matching: ZMMBE → ZINR (SO, LI, Material, Batch, UR = Insp. Lot Qty) → ZCOMENT VIEW Shade Report (Inspection lot) → Korber — a roll is matched only when all agree: Barcode Number = Pallet, Vendor Batch = Lot Number, Vendor Roll No = Supplier Hu (ZCOMENT), Vendor Invoice No = Invoice Number and Purchasing Document = Po Number (ZINR). Qty differences need “Confirmed”.</p>
        <div className="pick-ups">
          {PICK_SRCS.map((p) => {
            const u = status?.uploads.find((x) => x.src === p.src);
            return (
              <div key={p.src} className="pick-up">
                <div><b>{p.title}</b> <span className="pill mute">{fmt(cnt(p.src))} rows</span></div>
                <span className="muted small">{u ? `${u.file_name || ''} · ${u.uploaded_by} · ${ago(u.uploaded_at)}` : p.hint}</span>
                {canEdit && <>
                  <button className="btn sm primary" disabled={!!busy} onClick={() => inputs.current[p.src]?.click()}>{busy === p.src ? 'Uploading…' : `Upload ${p.title}`}</button>
                  <input ref={(el) => { inputs.current[p.src] = el; }} type="file" hidden accept=".xlsx,.xls,.xlsm,.csv" onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(p.src, f); e.target.value = ''; }} />
                </>}
              </div>
            );
          })}
        </div>
      </section>

      <section className="card" aria-labelledby="rp-title">
        <div className="sheet-top">
          <div>
            <h2 id="rp-title">Ready to pull → Pick <span className="pill ok" style={{ marginLeft: 6 }}>{fmt(list.length)}</span></h2>
            <p className="sub" style={{ margin: 0 }}>Plan lines whose UR covers the balance — they appear here as soon as a ZMMBE upload makes them ready. Picked QTY counts as Dispatched; fully picked lines move to “Picked”.</p>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <input type="search" className="as-search" placeholder="Search SO, item…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search lines" />
            <div className="seg" role="group">
              <button className={scope === 'ready' ? 'on' : ''} onClick={() => setScope('ready')}>Ready to pull</button>
              <button className={scope === 'open' ? 'on' : ''} onClick={() => setScope('open')}>All with UR</button>
              <button className={scope === 'picked' ? 'on' : ''} onClick={() => setScope('picked')}>Picked</button>
            </div>
          </div>
        </div>
        {!list.length ? <p className="muted">No lines {scope === 'ready' ? 'are ready to pull' : scope === 'picked' ? 'picked yet' : 'with UR stock'} in {week}.</p> : (
          <div className="table-wrap" style={{ maxHeight: 460 }}>
            <table className="mini">
              <thead><tr><th>SO</th><th>LI</th><th>Item</th><th>Date</th><th>Plant</th><th className="n">QTY</th><th className="n">Picked = Dispatched</th><th className="n">Balance</th><th className="n">UR left</th><th>State</th><th /></tr></thead>
              <tbody>{list.map((l) => {
                const pk = l.picked ?? 0, done = isDispatched(l);
                return (
                  <tr key={l.id}>
                    <td>{l.so}</td><td>{l.li}</td><td>{l.item}</td><td>{fmtDate(l.date)}</td><td>{l.plant}</td>
                    <td className="n">{fmtQty(l.qty)}</td>
                    <td className="n">{pk ? <>{fmtQty(pk)} <span className="muted">({l.picked_rolls} roll{l.picked_rolls === 1 ? '' : 's'})</span></> : '–'}</td>
                    <td className="n"><b>{fmtQty(need(l))}</b></td><td className="n">{fmtQty(avail(l))}</td>
                    <td>{done ? <span className="pill ok">Picked ✓ · Dispatched</span> : pk ? <span className="pill accent">Part picked</span> : <span className="pill mute">To pick</span>}</td>
                    <td>{canEdit && !done && <button className="btn sm primary" onClick={() => setPicking(l)}>{pk ? 'Pick more' : 'Pick'}</button>}</td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
        )}
      </section>

      <PickHistoryCard key={histKey} canEdit={canEdit} toast={toast} onChanged={() => { reload(); setHistKey((k) => k + 1); }} />

      {picking && <PickModal week={week} line={picking} onClose={() => setPicking(null)}
        onDone={(m) => { setPicking(null); toast(m); reload(); setHistKey((k) => k + 1); }} />}
    </>
  );
}

const CHECK_LABELS: [string, string][] = [['barcode', 'Barcode = Pallet'], ['lot', 'Vendor Batch = Lot Number'], ['hu', 'Vendor Roll No = Supplier Hu'], ['invoice', 'Invoice'], ['po', 'Purchasing Document = Po Number'], ['item', 'Item'], ['qty', 'Roll qty = Actual Qty']];
const checkText = (c: Record<string, boolean | null>) => CHECK_LABELS.map(([k, l]) => `${c[k] === true ? '✓' : c[k] === false ? '✗' : '–'} ${l}`).join('\n');
const r3 = (n: number) => Math.round(n * 1000) / 1000;

type SelV = { qty: string; manual?: ManualRoll; korber?: KorberRow };
type Sel = Record<string, SelV>;
interface LastRoll { pallet: string; hu: string | null; full: number; cut: number }

/**
 * The system's choice: full rolls (Supplier HU order) while they fit in the balance, then for the rest
 * the roll that fits it best (the smallest one that covers it) — cut to the balance, or sent in full if the user confirms.
 */
function autoPlan(c: Candidates): { sel: Sel; last: LastRoll | null } {
  let left = r3(c.need - c.picked);
  const sel: Sel = {};
  const avail = c.rolls.filter((r) => r.available > 1e-9);
  for (const r of avail) {
    if (left <= 1e-9) break;
    if (r.available <= left + 1e-9) { sel[r.pallet] = { qty: String(r3(r.available)) }; left = r3(left - r.available); }
  }
  let last: LastRoll | null = null;
  if (left > 1e-9) {
    const fit = avail.filter((r) => !sel[r.pallet] && r.available >= left).sort((a, b) => a.available - b.available)[0];
    if (fit) { sel[fit.pallet] = { qty: String(left) }; last = { pallet: fit.pallet, hu: fit.supplier_hu, full: r3(fit.available), cut: left }; }
  }
  return { sel, last };
}

function PickModal({ week, line, onClose, onDone }: { week: string; line: LineP; onClose: () => void; onDone: (m: string) => void }) {
  const [c, setC] = useState<Candidates | null>(null);
  const [err, setErr] = useState('');
  const [sel, setSel] = useState<Sel>({});
  const [last, setLast] = useState<LastRoll | null>(null);
  const [lastMode, setLastMode] = useState<'cut' | 'full'>('cut');
  const [checkedOk, setCheckedOk] = useState(false);
  const [overOk, setOverOk] = useState(false);
  const [choosing, setChoosing] = useState<ManualRoll | null>(null);
  const [pickNo, setPickNo] = useState('');
  const [busy, setBusy] = useState(false);
  const [showNotes, setShowNotes] = useState(false);

  const applyAuto = useCallback((x: Candidates, keepManual: Sel = {}) => {
    const a = autoPlan(x);
    setSel({ ...a.sel, ...keepManual }); setLast(a.last); setLastMode('cut'); setOverOk(false);
  }, []);
  useEffect(() => {
    api<Candidates>(`/api/pick/candidates?week=${encodeURIComponent(week)}&key=${encodeURIComponent(line.key)}&date=${encodeURIComponent(line.date ?? '')}`)
      .then((x) => { setC(x); applyAuto(x); }).catch((e) => setErr(e instanceof Error ? e.message : 'Could not load rolls.'));
  }, [week, line, applyAuto]);
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onClose]);

  const remaining = c ? Math.max(0, r3(c.need - c.picked)) : 0;
  const total = r3(Object.values(sel).reduce((t, x) => t + (Number(x.qty) || 0), 0));
  const nSel = Object.keys(sel).length;
  const diff = r3(total - remaining);
  const lastOn = !!(last && sel[last.pallet]);
  const lastSmall = !!last && (last.full - last.cut) <= Math.max(0.1 * Number(line.qty || remaining), 1e-9);
  const setLastTo = (m: 'cut' | 'full') => {
    if (!last) return;
    setLastMode(m);
    setSel((s) => (s[last.pallet] ? { ...s, [last.pallet]: { ...s[last.pallet], qty: String(m === 'full' ? last.full : last.cut) } } : s));
  };
  const toggle = (r: Candidate) => setSel((s) => {
    const n = { ...s };
    if (n[r.pallet]) delete n[r.pallet];
    else { const left = r3(remaining - Object.values(n).reduce((t, x) => t + (Number(x.qty) || 0), 0)); n[r.pallet] = { qty: String(r3(left > 1e-9 ? Math.min(r.available, left) : r.available)) }; }
    return n;
  });
  // manual pick is only for the balance the matched rolls cannot cover
  const shortfall = c ? (c.shortfall ?? remaining) : 0;
  const manualTotal = Object.values(sel).filter((x) => x.manual).reduce((t, x) => t + (Number(x.qty) || 0), 0);
  const manualLeft = Math.max(0, r3(shortfall - manualTotal));
  const manualSel = Object.entries(sel).filter(([, x]) => x.manual);
  const useKorber = (m: ManualRoll, k: KorberRow) => {
    setChoosing(null);
    if (c?.rolls.some((r) => r.pallet === k.pallet)) { if (!sel[k.pallet]) toggle(c.rolls.find((r) => r.pallet === k.pallet)!); return; }
    if (manualLeft <= 1e-9) return;
    setSel((x) => ({ ...x, [k.pallet]: { qty: String(r3(Math.min(k.available, manualLeft))), manual: m, korber: k } }));
  };
  // rolls the user has to look at before picking: a check that did not pass, or chosen by hand
  const flagged = c ? [
    ...c.rolls.filter((r) => sel[r.pallet] && r.needsConfirm).map((r) => ({ pallet: r.pallet, why: `${r.supplier_hu ?? ''} ${r.warnings.join('; ')}`.trim() })),
    ...manualSel.map(([pallet, x]) => ({ pallet, why: `chosen by hand for roll ${x.manual!.roll_no || '?'}` })),
  ] : [];
  const overByFullRoll = lastOn && lastMode === 'full';
  const needOverOk = diff > 0.0005 && remaining > 0 && !overByFullRoll;
  const blocked = !nSel || (flagged.length > 0 && !checkedOk) || (needOverOk && !overOk) || Object.values(sel).some((x) => !(Number(x.qty) > 0));

  const save = async () => {
    if (!c) return;
    setBusy(true); setErr('');
    try {
      const r = await api<{ label: string; qty: number; rolls: number; day: string }>('/api/pick', { method: 'POST', body: {
        week, key: line.key, date: line.date, pickNo: pickNo.trim() || null, overConfirmed: diff > 0.0005 ? (overByFullRoll || overOk) : false,
        rolls: Object.entries(sel).map(([pallet, x]) => ({ pallet, qty: Number(x.qty), confirmed: checkedOk, ...(x.manual ? { manual: x.manual } : {}) })),
      } });
      onDone(`${r.label} pick of ${r.day}: ${r.rolls} roll${r.rolls === 1 ? '' : 's'}, ${fmt(r.qty, 2)} — ${line.so} / ${line.li}`);
    } catch (e) { setErr(e instanceof Error ? e.message : 'Pick failed.'); } finally { setBusy(false); }
  };

  const open = c ? c.rolls.filter((r) => r.available > 1e-9) : [];
  const gone = c ? c.rolls.filter((r) => r.available <= 1e-9) : [];
  return (
    <div className="modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal xwide pkm" role="dialog" aria-modal="true" aria-labelledby="pk-title">
        <div className="modal-head">
          <div>
            <h2 id="pk-title">Pick {line.so} / {line.li}</h2>
            <p className="sub" style={{ margin: 0 }}>Item {line.item} · {fmtDate(line.date)} · {line.plant || '–'}</p>
          </div>
          <button type="button" className="btn sm" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="pk-stats">
          <div><span>Plan QTY</span><b>{fmtQty(line.qty)}</b></div>
          <div><span>Already picked</span><b>{c ? fmtQty(c.picked) : '…'}</b></div>
          <div className="em"><span>To pick</span><b>{c ? fmtQty(remaining) : '…'}</b></div>
          <div><span>Selected</span><b>{fmt(total, 2)}</b><small>{nSel} roll{nSel === 1 ? '' : 's'}</small></div>
          <div className={!c ? '' : Math.abs(diff) <= 0.0005 ? 'ok' : diff > 0 ? 'warn' : 'short'}>
            <span>{!c ? 'Status' : Math.abs(diff) <= 0.0005 ? 'Status' : diff > 0 ? 'Over plan' : 'Still to pick'}</span>
            <b>{!c ? '…' : Math.abs(diff) <= 0.0005 ? 'Exact ✓' : fmt(Math.abs(diff), 2)}</b>
          </div>
        </div>

        {!c && !err && <p className="muted">Matching ZMMBE → ZINR → ZCOMENT → Korber…</p>}
        {c && (
          <>
            <div className="pk-chain">
              {c.lots.map((l) => (
                <span key={l.lot} className={`pk-lot ${l.qty_ok ? '' : 'warn'}`} title={`Batch ${l.batch}${l.sloc ? ' · St Loc ' + l.sloc : ''}${l.invoice ? ' · invoice ' + l.invoice : ''}`}>
                  Lot <b>{l.lot}</b> · batch {l.batch} · {fmtQty(l.qty)} {l.qty_ok ? '= UR ✓' : `≠ UR ${fmtQty(l.ur)}`} · {l.rolls} roll{l.rolls === 1 ? '' : 's'}
                </span>
              ))}
              {!c.lots.length && <span className="pk-lot warn">No ZINR lot matched</span>}
              {c.steps.length > 0 && <button type="button" className="linkish" onClick={() => setShowNotes((v) => !v)}>{showNotes ? 'Hide' : 'Show'} {c.steps.length} note{c.steps.length === 1 ? '' : 's'}</button>}
            </div>
            {showNotes && <div className="notice warn" style={{ fontSize: 12.5 }}>{c.steps.map((s, i) => <div key={i}>{s}</div>)}</div>}

            <div className="pk-sec">
              <div className="pk-sec-head">
                <h3>Matched rolls <span className="pill ok">{open.length}</span>{gone.length > 0 && <span className="muted small"> · {gone.length} already picked</span>}</h3>
                <span className="muted small">Barcode, Lot, Supplier Hu, Invoice and Po all match. The system selects them for the plan QTY.</span>
                <span style={{ flex: 1 }} />
                {open.length > 0 && <button type="button" className="btn sm" onClick={() => applyAuto(c, Object.fromEntries(manualSel))}>Auto select</button>}
                {nSel > 0 && <button type="button" className="btn sm" onClick={() => { setSel({}); setLast(null); }}>Clear</button>}
              </div>
              {!c.rolls.length ? <p className="muted">No Korber roll matched for this line.{c.manual?.length ? ' See “Not matched” below.' : ' Check that ZINR, ZCOMENT VIEW and Korber are uploaded and current.'}</p> : (
                <div className="table-wrap" style={{ maxHeight: 360 }}>
                  <table className="mini pk-table">
                    <thead><tr><th /><th>Supplier HU</th><th>Pallet</th><th>Location</th><th>Shade</th><th className="n">Available</th><th className="n">Pick qty</th><th>Match</th></tr></thead>
                    <tbody>{[...open, ...gone].map((r) => {
                      const s = sel[r.pallet], isGone = r.available <= 1e-9, isLast = lastOn && last!.pallet === r.pallet;
                      return (
                        <tr key={r.pallet} className={`${s ? 'picked' : ''} ${isGone ? 'gone' : ''}`} onClick={(e) => { if (!isGone && (e.target as HTMLElement).tagName !== 'INPUT') toggle(r); }}>
                          <td><input type="checkbox" disabled={isGone} checked={!!s} onChange={() => toggle(r)} aria-label={`Pick ${r.pallet}`} /></td>
                          <td><b>{r.supplier_hu}</b></td>
                          <td className="mono">{r.pallet}</td><td>{r.location}</td><td><b>{r.shade}</b></td>
                          <td className="n">{isGone ? <span className="pill mute" title={r.picks.map((p) => `${p.day} ${p.by_user}: ${p.qty}`).join('\n')}>picked</span>
                            : <>{fmtQty(r.available)}{r.picked_before > 0 && <span className="pill accent" style={{ marginLeft: 4 }} title={`Picked before: ${r.picks.map((p) => `${p.day} ${p.by_user} ${p.qty}`).join(', ')}`}>balance</span>}</>}</td>
                          <td className="n">{s ? <span className="pk-qty">
                            {isLast && <span className={`pill ${lastMode === 'full' ? 'warn' : 'accent'}`}>{lastMode === 'full' ? 'full roll' : 'cut'}</span>}
                            <input className="as-search" type="number" step="0.001" min="0.001" max={r.available} value={s.qty} onClick={(e) => e.stopPropagation()}
                              onChange={(e) => setSel((x) => ({ ...x, [r.pallet]: { ...x[r.pallet], qty: e.target.value } }))} aria-label="Pick qty" />
                          </span> : ''}</td>
                          <td>{r.needsConfirm ? <span className="pill warn" title={`${r.warnings.join('\n')}\n\n${checkText(r.checks)}`}>Check: {r.warnings[0]}</span>
                            : <span className="pill ok" title={checkText(r.checks)}>All match ✓</span>}</td>
                        </tr>
                      );
                    })}</tbody>
                  </table>
                </div>
              )}
            </div>

            {lastOn && last && (
              <div className={`pk-last ${lastSmall ? 'small-over' : ''}`}>
                <div>
                  <b>Last roll {last.hu || ''}</b> <span className="mono">{last.pallet}</span>
                  <div className="muted small">The plan needs {fmtQty(last.cut)} more; this roll has {fmtQty(last.full)}.{lastSmall ? ` Sending it in full is only ${fmt(last.full - last.cut, 2)} over the plan — no cut roll.` : ''}</div>
                </div>
                <div className="pk-choice" role="radiogroup" aria-label="Last roll">
                  <button type="button" role="radio" aria-checked={lastMode === 'cut'} className={lastMode === 'cut' ? 'on' : ''} onClick={() => setLastTo('cut')}>
                    <b>Cut the roll</b><span>Pick {fmtQty(last.cut)} · exact plan QTY</span>
                  </button>
                  <button type="button" role="radio" aria-checked={lastMode === 'full'} className={lastMode === 'full' ? 'on' : ''} onClick={() => setLastTo('full')}>
                    <b>Send full roll{lastSmall ? ' (recommended)' : ''}</b><span>Pick {fmtQty(last.full)} · +{fmt(last.full - last.cut, 2)} over plan — I confirm</span>
                  </button>
                </div>
              </div>
            )}

            {(c.manual?.length ?? 0) > 0 && shortfall > 1e-9 && (
              <div className="manual-pick">
                <h3>Not matched — pick by hand <span className="pill warn">{c.manual!.length}</span></h3>
                <p className="sub" style={{ margin: '0 0 6px' }}>The matched rolls leave <b>{fmtQty(shortfall)}</b>{manualTotal > 0 && manualLeft > 1e-9 ? <> (<b>{fmtQty(manualLeft)}</b> still open)</> : ''}. Only this balance can be picked by hand: choose a Korber roll (search or scan pallet, lot or supplier HU).</p>
                <table className="mini">
                  <thead><tr><th>Roll</th><th>ZCOMENT barcode</th><th>Shade</th><th className="n">Roll qty</th><th>Why it did not match</th><th>Korber roll</th><th className="n">Pick qty</th></tr></thead>
                  <tbody>{c.manual!.map((m, i) => {
                    const chosen = manualSel.find(([, x]) => x.manual === m);
                    return (
                      <tr key={i} className={chosen ? 'picked' : ''}>
                        <td><b>{m.roll_no || '–'}</b></td><td className="mono">{m.barcode || <span className="muted">none</span>}</td><td><b>{m.shade}</b></td><td className="n">{fmtQty(m.roll_qty)}</td>
                        <td className="muted small">{m.reason}</td>
                        <td>{chosen ? <span className="mono">{chosen[0]} <button className="btn sm" onClick={() => setSel((x) => { const n = { ...x }; delete n[chosen[0]]; return n; })} aria-label="Remove">✕</button></span>
                          : <button className="btn sm" disabled={manualLeft <= 1e-9} title={manualLeft <= 1e-9 ? 'The balance is already covered' : undefined} onClick={() => setChoosing(m)}>Choose Korber roll…</button>}</td>
                        <td className="n">{chosen ? <input className="as-search" type="number" step="0.001" min="0.001" max={Math.min(chosen[1].korber?.available ?? Infinity, r3(shortfall - manualTotal + (Number(chosen[1].qty) || 0)))} style={{ width: 92 }} value={chosen[1].qty}
                          onChange={(e) => setSel((x) => ({ ...x, [chosen[0]]: { ...x[chosen[0]], qty: e.target.value } }))} aria-label="Pick qty" /> : ''}</td>
                      </tr>
                    );
                  })}</tbody>
                </table>
              </div>
            )}
            {(c.manual?.length ?? 0) > 0 && shortfall <= 1e-9 && (
              <p className="muted small" style={{ margin: 0 }}>{c.manual!.length} shade-report roll{c.manual!.length === 1 ? ' does' : 's do'} not match a Korber roll, but the matched rolls cover the line — nothing to pick by hand.</p>
            )}
            {choosing && <KorberChooser item={line.item} roll={choosing} taken={Object.keys(sel)} onUse={(k) => useKorber(choosing, k)} onClose={() => setChoosing(null)} />}

            {(flagged.length > 0 || needOverOk) && (
              <div className="pk-confirm">
                {flagged.length > 0 && (
                  <label><input type="checkbox" checked={checkedOk} onChange={(e) => setCheckedOk(e.target.checked)} />
                    <span><b>I checked {flagged.length === 1 ? 'this roll' : `these ${flagged.length} rolls`}</b>{flagged.map((f) => <small key={f.pallet}><span className="mono">{f.pallet}</span> — {f.why}</small>)}</span>
                  </label>
                )}
                {needOverOk && (
                  <label><input type="checkbox" checked={overOk} onChange={(e) => setOverOk(e.target.checked)} />
                    <span><b>Send {fmt(diff, 2)} over the plan balance</b><small>The selected QTY is more than the {fmtQty(remaining)} still to pick.</small></span>
                  </label>
                )}
              </div>
            )}
          </>
        )}
        {err && <div className="notice bad">{err}</div>}
        <div className="modal-foot">
          <label className="pk-no">HJ Pick No <input className="as-search" value={pickNo} onChange={(e) => setPickNo(e.target.value)} placeholder="e.g. 21204655" style={{ width: 130 }} /></label>
          <span style={{ flex: 1 }} />
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={busy || blocked} onClick={save}
            title={blocked && nSel ? (flagged.length && !checkedOk ? 'Tick “I checked” first' : needOverOk && !overOk ? 'Confirm the over-plan QTY first' : '') : undefined}>
            {busy ? 'Saving…' : `Pick ${nSel} roll${nSel === 1 ? '' : 's'} · ${fmt(total, 2)}`}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Search the uploaded Korber rolls of the line's item (or scan a pallet) and pick one for a manual roll. */
function KorberChooser({ item, roll, taken, onUse, onClose }: { item: string; roll: ManualRoll; taken: string[]; onUse: (k: KorberRow) => void; onClose: () => void }) {
  const [q, setQ] = useState(roll.vendor_batch || '');
  const [rows, setRows] = useState<KorberRow[] | null>(null);
  useEffect(() => {
    const t = setTimeout(() => {
      api<{ rows: KorberRow[] }>(`/api/pick/korber?item=${encodeURIComponent(item)}&q=${encodeURIComponent(q.trim())}`).then((r) => setRows(r.rows)).catch(() => setRows([]));
    }, 250);
    return () => clearTimeout(t);
  }, [item, q]);
  return (
    <div className="kchooser">
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <b>Korber roll for {roll.roll_no || 'roll'}</b><span className="muted small">item {item} · vendor batch {roll.vendor_batch} · roll qty {fmtQty(roll.roll_qty)}</span>
        <input autoFocus className="as-search" placeholder="Scan / type pallet, lot or supplier HU" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: '1 1 240px' }} aria-label="Search Korber" />
        <button className="btn sm" onClick={onClose}>Close</button>
      </div>
      <div className="table-wrap" style={{ maxHeight: 220, marginTop: 6 }}>
        {rows === null ? <p className="muted">Searching…</p> : !rows.length ? <p className="muted">No Korber roll found{q ? ` for “${q}”` : ''}.</p> : (
          <table className="mini">
            <thead><tr><th>Pallet</th><th>Item</th><th>Location</th><th>Lot</th><th>Supplier HU</th><th className="n">Actual qty</th><th className="n">Available</th><th /></tr></thead>
            <tbody>{rows.map((k) => {
              const used = taken.includes(k.pallet), gone = k.available <= 1e-9;
              return (
                <tr key={k.pallet} className={gone ? 'gone' : ''}>
                  <td className="mono">{k.pallet}</td><td>{k.item}</td><td>{k.location}</td><td>{k.lot}</td><td>{k.supplier_hu}</td><td className="n">{fmtQty(k.qty)}</td>
                  <td className="n">{gone ? <span className="pill mute">picked</span> : fmtQty(k.available)}</td>
                  <td><button className="btn sm primary" disabled={gone || used} onClick={() => onUse(k)}>{used ? 'Selected' : 'Use'}</button></td>
                </tr>
              );
            })}</tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function PickHistoryCard({ canEdit, toast, onChanged }: { canEdit: boolean; toast: (m: string) => void; onChanged: () => void }) {
  const [day, setDay] = useState(today());
  const [h, setH] = useState<PickHistory | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const load = useCallback(() => { api<PickHistory>('/api/pick/history?day=' + day).then(setH).catch(() => {}); }, [day]);
  useEffect(() => { load(); }, [load]);
  const live = (h?.requests || []).filter((r) => !r.cancelled_at);
  const cancel = async (path: string, what: string) => {
    if (!confirm(`Cancel ${what}? The roll${path.includes('/req/') ? 's become' : ' becomes'} pickable again.`)) return;
    try { await api(path, { method: 'DELETE' }); toast(`${what} cancelled`); load(); onChanged(); } catch (e) { toast(e instanceof Error ? e.message : 'Failed.'); }
  };
  const days = Array.from(new Set([today(), ...(h?.days || []).map((d) => d.day)])).sort().reverse();
  return (
    <section className="card" aria-labelledby="ph-title">
      <div className="sheet-top">
        <div>
          <h2 id="ph-title">Pick history &amp; Packing List</h2>
          <p className="sub" style={{ margin: 0 }}>Shared by everyone. A picked roll can't be picked again; a part-picked roll keeps only its balance. Cancel to free the rolls.</p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <select className="as-search" value={day} onChange={(e) => setDay(e.target.value)} aria-label="Day">
            {days.map((d) => { const x = h?.days.find((y) => y.day === d); return <option key={d} value={d}>{fmtDate(d)}{d === today() ? ' (today)' : ''}{x ? ` · ${x.open} pick${x.open === 1 ? '' : 's'}` : ''}</option>; })}
          </select>
          <button className="btn primary" disabled={!live.length || !h} onClick={() => saveWorkbook(packingListWorkbook(h!), `Packing_List_${day}.xlsx`)}>Download Packing List</button>
          <button className="btn" disabled={!live.length || !h?.korberHeader} onClick={() => saveWorkbook(korberWorkbook(h!), `Korber_Picked_${day}.xlsx`)} title="The picked rolls in the Korber Inventory format">Korber lines</button>
        </div>
      </div>
      {!h?.requests.length ? <p className="muted">No picks on {fmtDate(day)}.</p> : (
        <div className="table-wrap" style={{ maxHeight: 'none' }}>
          <table className="mini">
            <thead><tr><th>Req</th><th>SO / LI / Item</th><th>Plant</th><th className="n">Plan QTY</th><th className="n">Picked</th><th className="n">Rolls</th><th>HJ Pick No</th><th>By</th><th /></tr></thead>
            <tbody>{h.requests.map((r) => {
              const rolls = h.picks.filter((p) => p.req_id === r.id);
              return [
                <tr key={r.id} className={r.cancelled_at ? 'gone' : ''} onClick={() => setOpen(open === r.id ? null : r.id)} style={{ cursor: 'pointer' }}>
                  <td><b>{ordinal(r.seq)}</b>{r.cancelled_at && <span className="pill mute" style={{ marginLeft: 4 }}>cancelled</span>}</td>
                  <td>{r.so} / {r.li} / {r.item}</td><td>{r.plant}</td><td className="n">{fmtQty(r.need)}</td><td className="n"><b>{fmtQty(r.qty)}</b></td><td className="n">{r.rolls}</td>
                  <td>{r.pick_no}</td><td className="muted">{r.by_user} · {ago(r.at)}</td>
                  <td>{canEdit && !r.cancelled_at && <button className="btn sm" onClick={(e) => { e.stopPropagation(); cancel(`/api/pick/req/${r.id}`, `${ordinal(r.seq)} pick`); }}>Cancel</button>}</td>
                </tr>,
                open === r.id && (
                  <tr key={r.id + 'd'}><td colSpan={9} style={{ background: 'var(--panel-2)' }}>
                    <table className="mini">
                      <thead><tr><th>Pallet</th><th>Lot</th><th>Shade</th><th className="n">Roll qty</th><th className="n">Picked</th><th>Insp. lot</th><th>Note</th><th /></tr></thead>
                      <tbody>{rolls.map((p) => (
                        <tr key={p.id} className={p.cancelled_at ? 'gone' : ''}>
                          <td className="mono">{p.pallet}</td><td>{p.lot}</td><td>{p.shade}</td><td className="n">{fmtQty(p.roll_qty)}</td>
                          <td className="n">{fmtQty(p.qty)}{p.partial ? <span className="pill accent" style={{ marginLeft: 4 }}>cut</span> : ''}</td><td>{p.insp_lot}</td><td className="muted">{p.note}</td>
                          <td>{canEdit && !p.cancelled_at && !r.cancelled_at && <button className="btn sm" onClick={() => cancel(`/api/pick/roll/${p.id}`, `roll ${p.pallet}`)}>Remove</button>}</td>
                        </tr>
                      ))}</tbody>
                    </table>
                  </td></tr>
                ),
              ];
            })}</tbody>
          </table>
        </div>
      )}
    </section>
  );
}
