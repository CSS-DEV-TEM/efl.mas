'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader, Skeleton } from '@/components/Loader';
import { api, getSession, isBossRole } from '@/lib/api';
import CompleteLine from '@/components/CompleteLine';
import { ago, avail, fmt, fmtDate, fmtQty, isDispatched, isDone, need, periodOf, type Line } from '@/lib/calc';
import { action } from '@/lib/smart';
import {
  PICK_SRCS, korberWorkbook, ordinal, packingListWorkbook, saveWorkbook, uploadPickFile,
  type Candidate, type Candidates, type KorberRow, type ManualRoll, type NbOption, type NoBarcodeRoll, type PickHistory, type PickSrc,
} from '@/lib/pick';

type LineP = Line & { picked?: number; picked_rolls?: number };
const today = () => new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);

/** Why a plan line is still pending, in the order the work is done. */
const PENDING_ORDER = ['On hold', 'Part picked', 'Ready to pull', 'Not in Korber', 'Partial pull', 'Release QI / Block', 'Follow up TN', 'No stock'];
const PENDING_TONE: Record<string, string> = { 'On hold': 'bad', 'Part picked': 'accent', 'Ready to pull': 'ok', 'Not in Korber': 'warn', 'Partial pull': 'info', 'Release QI / Block': 'warn', 'Follow up TN': 'warn', 'No stock': 'bad' };
function pendingWhy(l: LineP): string {
  if (l.hold) return 'On hold';
  if ((l.picked ?? 0) > 0) return 'Part picked';
  const a = action(l);
  return PENDING_ORDER.includes(a) ? a : 'No stock';
}

/** Pick tab of the Dispatch page: the three pick reports, Ready-to-pull lines with Pick, and the pick history / Packing List. */
export default function PickWorkspace({ week, rows, canEdit, toast, reload, label }: { week: string; rows: LineP[]; canEdit: boolean; toast: (m: string) => void; reload: () => void; /** what is on screen, e.g. "20 Oct · ASIALINE Pick 2" */ label?: string }) {
  const [status, setStatus] = useState<{ counts: { src: string; n: number }[]; uploads: { src: string; file_name: string | null; row_count: number; uploaded_by: string; uploaded_at: string }[] } | null>(null);
  const [busy, setBusy] = useState<PickSrc | null>(null);
  const [scope, setScope] = useState<'pending' | 'ready' | 'open' | 'picked' | 'done' | 'hold'>('pending');
  const [why, setWhy] = useState('');
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
    return rows.filter((l) => (scope === 'picked' ? (l.picked ?? 0) > 0
      : scope === 'done' ? isDone(l)
      : scope === 'hold' ? !!l.hold && !isDone(l)
      : scope === 'pending' ? !isDone(l) && need(l) > 1e-9 && (!why || pendingWhy(l) === why)
      : !isDone(l) && need(l) > 1e-9 && (scope === 'open' ? avail(l) > 0 : action(l) === 'Ready to pull')))
      .filter((l) => !s || [l.so, l.li, l.item, l.plant].join(' ').toLowerCase().includes(s))
      .sort((a, b) => String(a.date ?? '').localeCompare(String(b.date ?? '')) || a.row_no - b.row_no);
  }, [rows, scope, q, why]);
  // everything of the plan not dispatched yet, by what it is waiting for
  const pending = useMemo(() => {
    const m = new Map<string, { n: number; qty: number }>();
    for (const l of rows) {
      if (isDone(l) || need(l) <= 1e-9) continue;
      const k = pendingWhy(l); const x = m.get(k) || { n: 0, qty: 0 };
      x.n++; x.qty += need(l); m.set(k, x);
    }
    return PENDING_ORDER.filter((k) => m.has(k)).map((k) => ({ why: k, ...m.get(k)! }));
  }, [rows]);
  const cnt = (src: string) => status?.counts.find((c) => c.src === src)?.n ?? 0;
  const holdN = useMemo(() => rows.filter((l) => l.hold && !isDone(l)).length, [rows]);
  // Pick Hold: put a line on hold (a reason) or release it; a held line cannot be picked
  const [holding, setHolding] = useState<LineP | null>(null);
  const setHold = async (l: LineP, reason: string | null) => {
    try {
      const period = periodOf(l as LineP & { plan_type?: string });
      await api('/api/status', { method: 'PATCH', body: { key: l.key, week: period, date: l.date ?? null, hold: reason } });
      toast(reason ? `${l.so} / ${l.li} is on hold — ${reason}` : `Hold released: ${l.so} / ${l.li} can be picked`);
      reload();
    } catch (e) { toast(e instanceof Error ? e.message : 'Could not change the hold.'); }
  };

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
                  <button className="btn sm primary" aria-busy={busy === p.src || undefined} disabled={!!busy} onClick={() => inputs.current[p.src]?.click()}>{busy === p.src ? 'Uploading…' : `Upload ${p.title}`}</button>
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
            <h2 id="rp-title">Plan → Pick <span className="pill ok" style={{ marginLeft: 6 }}>{fmt(list.length)}</span></h2>
            <p className="sub" style={{ margin: 0 }}>Pending = every plan line not dispatched yet, by what it is waiting for. Ready to pull = UR covers the balance (they appear as soon as a ZMMBE upload makes them ready). Picked QTY counts as Dispatched.</p>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <input type="search" className="as-search" placeholder="Search SO, item…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search lines" />
            <div className="seg" role="group">
              <button className={scope === 'pending' ? 'on' : ''} onClick={() => { setScope('pending'); setWhy(''); }}>Pending</button>
              <button className={scope === 'ready' ? 'on' : ''} onClick={() => setScope('ready')}>Ready to pull</button>
              <button className={scope === 'open' ? 'on' : ''} onClick={() => setScope('open')}>All with UR</button>
              <button className={scope === 'picked' ? 'on' : ''} onClick={() => setScope('picked')}>Picked</button>
              <button className={scope === 'hold' ? 'on' : ''} onClick={() => setScope('hold')}>On hold{holdN ? ` (${holdN})` : ''}</button>
              <button className={scope === 'done' ? 'on' : ''} onClick={() => setScope('done')}>Completed</button>
            </div>
          </div>
        </div>
        {pending.length > 0 && (
          <div className="pend-bar" role="group" aria-label="Pending by reason">
            <span className="weeks-label">Pending</span>
            <button type="button" className={`pend-chip ${scope === 'pending' && !why ? 'on' : ''}`} onClick={() => { setScope('pending'); setWhy(''); }}>
              <b>{fmt(pending.reduce((t, p) => t + p.n, 0))}</b><span>All · {fmtQty(pending.reduce((t, p) => t + p.qty, 0))}</span>
            </button>
            {pending.map((p) => (
              <button key={p.why} type="button" className={`pend-chip ${PENDING_TONE[p.why] || ''} ${scope === 'pending' && why === p.why ? 'on' : ''}`} onClick={() => { setScope('pending'); setWhy(p.why); }}>
                <b>{fmt(p.n)}</b><span>{p.why} · {fmtQty(p.qty)}</span>
              </button>
            ))}
          </div>
        )}
        {!list.length ? <p className="muted">No lines {scope === 'ready' ? 'are ready to pull' : scope === 'picked' ? 'picked yet' : scope === 'hold' ? 'on hold' : scope === 'pending' ? 'pending' : 'with UR stock'} in {label || week}.</p> : (
          <div className="table-wrap" style={{ maxHeight: 460 }}>
            <table className="mini">
              <thead><tr><th>SO</th><th>LI</th><th>Item</th><th>Date</th><th>Plant</th><th className="n">QTY</th><th className="n">Picked = Dispatched</th><th className="n">Balance</th><th className="n">UR left</th><th>State</th><th /></tr></thead>
              <tbody>{list.map((l) => {
                const pk = l.picked ?? 0, done = isDispatched(l);
                return (
                  <tr key={l.id} className={l.hold && !isDone(l) ? 'on-hold' : ''}>
                    <td>{l.so}</td><td>{l.li}</td><td>{l.item}</td><td>{fmtDate(l.date)}</td><td>{l.plant}</td>
                    <td className="n">{fmtQty(l.qty)}</td>
                    <td className="n">{pk ? <>{fmtQty(pk)} <span className="muted">({l.picked_rolls} roll{l.picked_rolls === 1 ? '' : 's'})</span></> : '–'}</td>
                    <td className="n"><b>{fmtQty(need(l))}</b></td><td className="n">{fmtQty(avail(l))}</td>
                    <td>{l.hold && !isDone(l) ? <span className="pill bad" title={`On hold${l.hold_by ? ` by ${l.hold_by}` : ''}${l.hold_at ? ` · ${new Date(l.hold_at).toLocaleString()}` : ''}`}>On hold · {l.hold}</span> : isDone(l) && !done ? <span className="pill ok" title={l.comment || ''}>Completed ✓</span> : scope === 'pending' && !done ? <span className={`pill ${PENDING_TONE[pendingWhy(l)] || 'mute'}`}>{pendingWhy(l)}</span> : done && Number((l as LineP & { closed_short?: number }).closed_short) > 0 ? <span className="pill ok" title="Closed short by a Normal pick">Picked ✓ · {fmtQty(Number((l as LineP & { closed_short?: number }).closed_short))} short</span> : done ? <span className="pill ok">Picked ✓ · Dispatched</span> : pk ? <span className="pill accent">Part picked</span> : <span className="pill mute">To pick</span>}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{canEdit && !isDone(l) && (l.hold
                        ? <button className="btn sm" onClick={() => setHold(l, null)} title="Release the hold — the line can be picked again">Release hold</button>
                        : <><button className="btn sm primary" onClick={() => setPicking(l)}>{pk ? 'Pick more' : 'Pick'}</button> <button className="btn sm" onClick={() => setHolding(l)} title="Put this line on Pick Hold — nobody can pick it until it is released">Hold</button></>)}
                      {canEdit && <> <CompleteLine line={l} onDone={(m) => { toast(m); reload(); }} /></>}</td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
        )}
      </section>

      {holding && <HoldDialog line={holding} onClose={() => setHolding(null)} onSave={(r) => { const l = holding; setHolding(null); void setHold(l, r); }} />}

      <PickHistoryCard key={histKey} canEdit={canEdit} toast={toast} onChanged={() => { reload(); setHistKey((k) => k + 1); }} />

      {picking && <PickModal week={picking.week || week} line={picking} onClose={() => setPicking(null)}
        onDone={(m) => { setPicking(null); toast(m); reload(); setHistKey((k) => k + 1); }} />}
    </>
  );
}

const CHECK_LABELS: [string, string][] = [['barcode', 'Barcode = Pallet'], ['lot', 'Vendor Batch = Lot Number'], ['hu', 'Vendor Roll No = Supplier Hu'], ['invoice', 'Invoice'], ['po', 'Purchasing Document = Po Number'], ['item', 'Item'], ['qty', 'ZCOMENT Roll qty = Korber Actual Qty (Korber is used)']];
const checkText = (c: Record<string, boolean | null>) => CHECK_LABELS.map(([k, l]) => `${c[k] === true ? '✓' : c[k] === false ? '✗' : '–'} ${l}`).join('\n');
const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** nb = chosen for a shade-report roll with no Barcode Number (one of its offered Korber rolls) */
type SelV = { qty: string; manual?: ManualRoll | NoBarcodeRoll; korber?: KorberRow; nb?: NoBarcodeRoll };
type Sel = Record<string, SelV>;
interface LastRoll { pallet: string; hu: string | null; full: number; cut: number }

/** How much of a roll counts for each batch: its ZCOMENT parts, limited to what is still available (smallest part first). */
function rollParts(r: Candidate): { batch: string; qty: number }[] {
  const parts = r.parts?.length ? [...r.parts].sort((a, b) => a.qty - b.qty) : [{ batch: r.batches[0] ?? '', qty: r.available }];
  let left = r.available;
  const out = parts.map((p) => { const q = Math.min(p.qty, left); left = r3(left - q); return { batch: p.batch, qty: q }; });
  if (left > 1e-9 && out.length) out[out.length - 1].qty = r3(out[out.length - 1].qty + left); // Korber has a little more than ZCOMENT
  return out;
}

/**
 * The system's choice, batch by batch (each batch's UR comes from its own rolls in ZCOMENT):
 * the smallest need first, full rolls while they fit, then the roll of that batch that fits the rest best — cut,
 * or sent in full if the user confirms. A roll split over two batches (86 + 1 = 87) counts for both.
 */
function autoPlan(c: Candidates, withPool = false): { sel: Sel; last: LastRoll | null } {
  let left = r3(c.need - c.picked);
  const sel: Sel = {};
  // rolls of a PO shared by several SO lines are ticked by the user, never by the system
  const avail = c.rolls.filter((r) => r.available > 1e-9 && (withPool || !r.pool));
  let last: LastRoll | null = null;
  const take = (r: Candidate, q: number, need: Map<string, number> | null) => {
    sel[r.pallet] = { qty: String(r3(q)) };
    left = r3(left - q);
    if (need) {
      let rest = q;
      for (const p of rollParts(r)) { if (rest <= 1e-9) break; const t = Math.min(p.qty, rest); need.set(p.batch, Math.max(0, r3((need.get(p.batch) ?? 0) - t))); rest = r3(rest - t); }
    }
  };
  const need = c.batchNeed?.length ? new Map(c.batchNeed.map((b) => [b.batch, b.need])) : null;
  if (need) {
    const order = Array.from(need.entries()).filter(([, n]) => n > 1e-9).sort((a, b) => a[1] - b[1]).map(([b]) => b);
    for (const batch of order) {
      const partOf = (r: Candidate) => rollParts(r).find((p) => p.batch === batch)?.qty ?? 0;
      const rs = () => avail.filter((r) => !sel[r.pallet] && partOf(r) > 1e-9);
      for (const r of rs()) {
        const nb = need.get(batch) ?? 0;
        if (nb <= 1e-9 || left <= 1e-9) break;
        if (partOf(r) <= nb + 1e-9 && r.available <= left + 1e-9) take(r, r.available, need);
      }
      const nb = Math.min(need.get(batch) ?? 0, left);
      if (nb > 1e-9) {
        const fit = rs().filter((r) => partOf(r) >= nb - 1e-9).sort((a, b) => partOf(a) - partOf(b) || a.available - b.available)[0];
        if (fit) { last = { pallet: fit.pallet, hu: fit.supplier_hu, full: r3(fit.available), cut: r3(nb) }; take(fit, nb, need); }
      }
    }
  }
  // whatever the batches do not explain: any matched roll, full rolls first, then the best fit
  for (const r of avail) {
    if (left <= 1e-9) break;
    if (!sel[r.pallet] && r.available <= left + 1e-9) take(r, r.available, null);
  }
  if (left > 1e-9) {
    const fit = avail.filter((r) => !sel[r.pallet] && r.available >= left).sort((a, b) => a.available - b.available)[0];
    if (fit) { last = { pallet: fit.pallet, hu: fit.supplier_hu, full: r3(fit.available), cut: left }; take(fit, left, null); }
  }
  return { sel, last };
}

const HOLD_REASONS = ['Customer asked to hold', 'Shade issue', 'Quality check', 'Plant not ready', 'Wrong roll / label', 'Waiting for approval'];
/** Asks the reason for a Pick Hold (a list of usual reasons, or typed). */
function HoldDialog({ line, onClose, onSave }: { line: LineP; onClose: () => void; onSave: (reason: string) => void }) {
  const [r, setR] = useState('');
  return (
    <div className="modal-back">
      <form className="modal" role="dialog" aria-modal="true" aria-labelledby="hold-title" onSubmit={(e) => { e.preventDefault(); onSave(r.trim() || 'On hold'); }}>
        <div className="modal-head">
          <div><h2 id="hold-title">Pick Hold · {line.so} / {line.li}</h2><p className="sub" style={{ margin: 0 }}>{line.item} · balance {fmtQty(need(line))}. Nobody can pick this line until the hold is released; it shows as <b>On hold</b> everywhere.</p></div>
          <button type="button" className="btn sm" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <label style={{ display: 'grid', gap: 6 }}>Reason
          <input autoFocus list="hold-reasons" value={r} onChange={(e) => setR(e.target.value)} placeholder="e.g. Customer asked to hold" maxLength={120}
            style={{ padding: '8px 10px', border: '1px solid var(--line-strong)', borderRadius: 6, background: 'var(--panel)', color: 'var(--ink)' }} />
          <datalist id="hold-reasons">{HOLD_REASONS.map((x) => <option key={x} value={x} />)}</datalist>
        </label>
        <div className="hold-quick">{HOLD_REASONS.map((x) => <button key={x} type="button" className={`btn sm ${r === x ? 'primary' : ''}`} onClick={() => setR(x)}>{x}</button>)}</div>
        <div className="modal-foot"><span /><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary">Put on hold</button></div>
      </form>
    </div>
  );
}

export function PickModal({ week, line, onClose, onDone }: { week: string; line: LineP; onClose: () => void; onDone: (m: string) => void }) {
  const [c, setC] = useState<Candidates | null>(null);
  const [err, setErr] = useState('');
  const [sel, setSel] = useState<Sel>({});
  const [last, setLast] = useState<LastRoll | null>(null);
  const [lastMode, setLastMode] = useState<'cut' | 'full' | 'leave'>('cut');
  const [kind, setKindS] = useState<'normal' | 'offsite'>(() => { try { return localStorage.getItem('mas-pick-kind') === 'offsite' ? 'offsite' : 'normal'; } catch { return 'normal'; } });
  const [closeShort, setCloseShort] = useState(false);
  // the admin's pick rules (Settings → Pick rules)
  const [rules, setRules] = useState({ fullRollPct: 10, defaultPickKind: 'normal' as 'normal' | 'offsite', allowOffsite: true, allowNormalShort: true, allowNormalFull: true });
  useEffect(() => {
    api<{ settings: typeof rules }>('/api/settings').then((r) => {
      setRules(r.settings);
      let saved: string | null = null; try { saved = localStorage.getItem('mas-pick-kind'); } catch { /* private mode */ }
      const k = r.settings.allowOffsite ? ((saved as 'normal' | 'offsite' | null) || r.settings.defaultPickKind) : 'normal';
      setKindS(k);
    }).catch(() => {});
  }, []);
  const [checkedOk, setCheckedOk] = useState(false);
  const [overOk, setOverOk] = useState(false);
  const [choosing, setChoosing] = useState<ManualRoll | null>(null);
  const [pickNo, setPickNo] = useState('');
  const [busy, setBusy] = useState(false);
  const [showNotes, setShowNotes] = useState(false);

  const applyAuto = useCallback((x: Candidates, keepManual: Sel = {}, withPool = false, fullIfSamePlant = true) => {
    const a = autoPlan(x, withPool);
    // the rest of the last roll stays with the same SO Plant: no need to cut — the full roll is proposed (Normal pick)
    const lr = a.last ? x.rolls.find((r) => r.pallet === a.last!.pallet) : undefined;
    const full = !!(fullIfSamePlant && a.last && lr?.sameSoPlant && a.last.full > a.last.cut);
    if (full) a.sel[a.last!.pallet] = { qty: String(a.last!.full) };
    setSel({ ...a.sel, ...keepManual }); setLast(a.last); setLastMode(full ? 'full' : 'cut'); setOverOk(false); setCloseShort(false);
  }, []);
  useEffect(() => {
    api<Candidates>(`/api/pick/candidates?week=${encodeURIComponent(week)}&key=${encodeURIComponent(line.key)}&date=${encodeURIComponent(line.date ?? '')}`)
      .then((x) => { setC(x); applyAuto(x); }).catch((e) => setErr(e instanceof Error ? e.message : 'Could not load rolls.'));
  }, [week, line, applyAuto]);
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && !(e.target instanceof HTMLElement && e.target.closest('input, select, textarea'))) onClose(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onClose]);

  const remaining = c ? Math.max(0, r3(c.need - c.picked)) : 0;
  const total = r3(Object.values(sel).reduce((t, x) => t + (Number(x.qty) || 0), 0));
  const nSel = Object.keys(sel).length;
  const diff = r3(total - remaining);
  const lastOn = !!(last && (sel[last.pallet] || lastMode === 'leave'));
  const lastSmall = !!last && (last.full - last.cut) <= Math.max((rules.fullRollPct / 100) * Number(line.qty || remaining), 1e-9);
  const setLastTo = (m: 'cut' | 'full' | 'leave') => {
    if (!last) return;
    setLastMode(m);
    setCloseShort(m === 'leave');
    setSel((s) => {
      const n = { ...s };
      if (m === 'leave') delete n[last.pallet];
      else n[last.pallet] = { ...(n[last.pallet] || {}), qty: String(m === 'full' ? last.full : last.cut) };
      return n;
    });
  };
  // Offsite: exact QTY only — the last roll is always cut, nothing over, no closing short
  const setKind = (k: 'normal' | 'offsite') => {
    setKindS(k); try { localStorage.setItem('mas-pick-kind', k); } catch { /* private mode */ }
    if (k === 'offsite') { if (lastMode !== 'cut') setLastTo('cut'); setCloseShort(false); setOverOk(false); }
  };
  const toggle = (r: Candidate) => setSel((s) => {
    const n = { ...s };
    if (n[r.pallet]) delete n[r.pallet];
    else { const left = r3(remaining - Object.values(n).reduce((t, x) => t + (Number(x.qty) || 0), 0)); n[r.pallet] = { qty: String(r3(left > 1e-9 ? Math.min(r.available, left) : r.available)) }; }
    return n;
  });
  // manual pick is only for the balance the matched rolls cannot cover
  const shortfall = c ? (c.shortfall ?? remaining) : 0;
  const manualTotal = Object.values(sel).filter((x) => x.manual && !x.nb).reduce((t, x) => t + (Number(x.qty) || 0), 0);
  const manualLeft = Math.max(0, r3(shortfall - manualTotal));
  const manualSel = Object.entries(sel).filter(([, x]) => x.manual && !x.nb);
  const nbSel = Object.entries(sel).filter(([, x]) => x.nb);
  // a roll with no barcode: the user picks its Korber roll from the matching ones ('' = none)
  const chooseNb = (m: NoBarcodeRoll, pallet: string) => setSel((s) => {
    const n = { ...s };
    for (const [p, x] of Object.entries(n)) if (x.nb === m) delete n[p];
    const o = m.options.find((x) => x.pallet === pallet);
    if (!o) return n;
    const left = r3(remaining - Object.values(n).reduce((t, x) => t + (Number(x.qty) || 0), 0));
    const want = Number(m.roll_qty) > 0 ? Math.min(o.available, Number(m.roll_qty)) : o.available;
    n[o.pallet] = { qty: String(r3(left > 1e-9 ? Math.min(want, left) : want)), manual: m, korber: o, nb: m };
    return n;
  });
  // Qty only counts for a lot without Shade Report (otherwise Korber's Actual Qty is simply the roll's QTY)
  const nbMiss = (o: NbOption, m?: NoBarcodeRoll) => (['lot', 'hu', 'qty'] as const).filter((k) => o.checks[k] === false && (k !== 'qty' || !!m?.noShade));
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
    ...nbSel.filter(([, x]) => x.korber && nbMiss(x.korber as NbOption, x.nb).length).map(([pallet, x]) => ({ pallet, why: `no barcode, roll ${x.nb!.roll_no || '?'}: ${nbMiss(x.korber as NbOption, x.nb).map((k) => ({ lot: 'Lot', hu: 'Supplier Hu', qty: 'Qty' })[k]).join(', ')} not the same` })),
  ] : [];
  const overByFullRoll = lastOn && lastMode === 'full';
  const offsiteOver = kind === 'offsite' && diff > 0.0005;
  const needOverOk = kind === 'normal' && diff > 0.0005 && remaining > 0 && !overByFullRoll;
  const isShort = diff < -0.0005 && nSel > 0;
  const blocked = !nSel || offsiteOver || (flagged.length > 0 && !checkedOk) || (needOverOk && !overOk) || Object.values(sel).some((x) => !(Number(x.qty) > 0));

  const save = async () => {
    if (!c) return;
    setBusy(true); setErr('');
    try {
      const r = await api<{ label: string; qty: number; rolls: number; day: string }>('/api/pick', { method: 'POST', body: {
        week, key: line.key, date: line.date, pickNo: pickNo.trim() || null, kind,
        overConfirmed: kind === 'normal' && diff > 0.0005 ? (overByFullRoll || overOk) : false,
        closeShort: kind === 'normal' && isShort && closeShort,
        rolls: Object.entries(sel).map(([pallet, x]) => ({ pallet, qty: Number(x.qty), confirmed: checkedOk, ...(x.manual ? { manual: x.manual } : {}), ...(x.nb ? { nobarcode: true } : {}) })),
      } });
      onDone(`${kind === 'offsite' ? 'Offsite' : 'Normal'} ${r.label} pick of ${r.day}: ${r.rolls} roll${r.rolls === 1 ? '' : 's'}, ${fmt(r.qty, 2)} — ${line.so} / ${line.li}`);
    } catch (e) { setErr(e instanceof Error ? e.message : 'Pick failed.'); } finally { setBusy(false); }
  };

  const open = c ? c.rolls.filter((r) => r.available > 1e-9) : [];
  const gone = c ? c.rolls.filter((r) => r.available <= 1e-9) : [];
  return (
    <div className="modal-back">{/* the pick window closes only with ✕ / Cancel — a click outside it does not lose the selection */}
      <div className="modal xwide pkm" role="dialog" aria-modal="true" aria-labelledby="pk-title">
        <div className="modal-head">
          <div>
            <h2 id="pk-title">Pick {line.so} / {line.li}</h2>
            <p className="sub" style={{ margin: 0 }}>Item {line.item} · {fmtDate(line.date)} · {line.plant || '–'}</p>
            {line.hold && <div className="notice bad" style={{ marginTop: 6 }}><b>On hold</b> — {line.hold}{line.hold_by ? ` (${line.hold_by})` : ''}. Release the hold on Pick &amp; Dispatch before picking.</div>}
          </div>
          <div className="pk-kind" role="radiogroup" aria-label="Pick type">
            <button type="button" role="radio" aria-checked={kind === 'normal'} className={kind === 'normal' ? 'on' : ''} onClick={() => setKind('normal')}>
              <b>Normal</b><span>Full roll or a little less allowed</span>
            </button>
            {rules.allowOffsite && <button type="button" role="radio" aria-checked={kind === 'offsite'} className={kind === 'offsite' ? 'on' : ''} onClick={() => setKind('offsite')}>
              <b>Offsite</b><span>Exact QTY only</span>
            </button>}
          </div>
          <button type="button" className="btn sm" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="pk-stats">
          <div><span>Plan QTY</span><b>{fmtQty(line.qty)}</b></div>
          <div><span>Already picked</span><b>{c ? fmtQty(c.picked) : '…'}</b></div>
          <div className="em"><span>To pick</span><b>{c ? fmtQty(remaining) : '…'}</b></div>
          <div><span>Selected</span><b>{fmt(total, 2)}</b><small>{nSel} roll{nSel === 1 ? '' : 's'}</small></div>
          <div className={!c ? '' : Math.abs(diff) <= 0.0005 ? 'ok' : diff > 0 ? 'warn' : 'short'}>
            <span>{!c ? 'Status' : Math.abs(diff) <= 0.0005 ? 'Status' : diff > 0 ? 'Over plan' : closeShort && kind === 'normal' ? 'Short (line closed)' : 'Still to pick'}</span>
            <b>{!c ? '…' : Math.abs(diff) <= 0.0005 ? 'Exact ✓' : fmt(Math.abs(diff), 2)}</b>
          </div>
        </div>

        {!c && !err && <><Loader label="Matching ZMMBE → ZINR → ZCOMENT → Korber…" /><Skeleton rows={6} title={false} /></>}
        {c && (
          <>
            <div className="pk-chain">
              {c.lots.map((l) => (
                <span key={l.lot} className={`pk-lot ${l.qty_ok ? '' : 'warn'}`} title={`Batch ${l.batch}${l.sloc ? ' · St Loc ' + l.sloc : ''}${l.invoice ? ' · invoice ' + l.invoice : ''}`}>
                  Lot <b>{l.lot}</b> · batch {l.batch} · {fmtQty(l.qty)} {l.qty_ok ? '= UR ✓' : `≠ UR ${fmtQty(l.ur)}`} · {l.direct ? `${l.direct} Korber roll${l.direct === 1 ? '' : 's'} (ZINR → Korber)` : l.noShade ? 'no Shade Report' : `${l.rolls} roll${l.rolls === 1 ? '' : 's'}${l.via ? ' (by batch)' : ''}`}
                </span>
              ))}
              {!c.lots.length && <span className="pk-lot warn">No ZINR lot matched</span>}
              {c.steps.length > 0 && <button type="button" className="linkish" onClick={() => setShowNotes((v) => !v)}>{showNotes ? 'Hide' : 'Show'} {c.steps.length} note{c.steps.length === 1 ? '' : 's'}</button>}
            </div>
            {showNotes && <div className="notice warn" style={{ fontSize: 12.5 }}>{c.steps.map((s, i) => <div key={i}>{s}</div>)}</div>}

            <div className="pk-sec">
              <div className="pk-sec-head">
                <h3>Matched rolls <span className="pill ok">{open.length}</span>{gone.length > 0 && <span className="muted small"> · {gone.length} already picked</span>}</h3>
                <span className="muted small">Barcode = Pallet (or Supplier Hu = Vendor Roll No) with Lot, Invoice and Po (ZCOMENT), or straight from ZINR: Item, Lot Number, Invoice and Po — a Supplier Hu that is this lot's Vendor Roll No makes it this line's roll. QTY = Korber Actual Qty. The system selects them for the plan QTY — rolls of a PO shared by several SO lines you tick yourself.</span>
                <span style={{ flex: 1 }} />
                {open.length > 0 && <button type="button" className="btn sm" onClick={() => applyAuto(c, Object.fromEntries([...manualSel, ...nbSel]))}>Auto select</button>}
                {open.some((r) => r.pool) && <button type="button" className="btn sm" title="Rolls of a PO shared by several SO lines: select them for this line's plan QTY (you decide)" onClick={() => applyAuto(c, Object.fromEntries([...manualSel, ...nbSel]), true)}>Select shared-PO rolls too</button>}
                {nSel > 0 && <button type="button" className="btn sm" onClick={() => { setSel({}); setLast(null); }}>Clear</button>}
              </div>
              {!c.rolls.length ? <p className="muted">No Korber roll matched on Barcode for this line.{c.nobarcode?.length ? ' Rolls without a barcode: choose them under “No Barcode” below.' : c.manual?.length ? ' See “Not matched” below.' : ' Check that ZINR, ZCOMENT VIEW and Korber are uploaded and current.'}</p> : (
                <div className="table-wrap" style={{ maxHeight: 360 }}>
                  <table className="mini pk-table">
                    <thead><tr><th /><th>Supplier HU</th><th>Pallet</th><th>Location</th><th>Shade</th><th className="n">Available</th><th className="n">Pick qty</th><th>Match</th></tr></thead>
                    <tbody>{[...open, ...gone].map((r) => {
                      const s = sel[r.pallet], isGone = r.available <= 1e-9, isLast = lastOn && last!.pallet === r.pallet;
                      return (
                        <tr key={r.pallet} className={`${s ? 'picked' : ''} ${isGone ? 'gone' : ''}`} onClick={(e) => { if (!isGone && (e.target as HTMLElement).tagName !== 'INPUT') toggle(r); }}>
                          <td><input type="checkbox" disabled={isGone} checked={!!s} onChange={() => toggle(r)} aria-label={`Pick ${r.pallet}`} /></td>
                          <td><b>{r.supplier_hu}</b></td>
                          <td className="mono">{r.pallet}{r.borrowed && <span className="pill info" style={{ marginLeft: 4 }} title={r.qtyNote || ''}>barcode from same roll</span>}{r.via && <span className="pill accent" style={{ marginLeft: 4 }} title={r.byHu ? `ZCOMENT Barcode Number ${r.barcode} is not a Korber pallet — found by Supplier Hu ${r.supplier_hu} = Vendor Roll No, with the same Lot, Invoice and Po` : `ZCOMENT Barcode Number ${r.barcode} — the same roll number in Korber under pallet ${r.via}`}>{r.byHu ? `roll no ${r.supplier_hu} · barcode ${r.barcode}` : `barcode ${r.barcode}`}</span>}</td><td>{r.location}</td><td><b>{r.shade}</b></td>
                          <td className="n">{isGone ? <span className="pill mute" title={r.picks.map((p) => `${p.day} ${p.by_user}: ${p.qty}`).join('\n')}>picked</span>
                            : <>{fmtQty(r.available)}{r.picked_before > 0 && <span className="pill accent" style={{ marginLeft: 4 }} title={`Picked before: ${r.picks.map((p) => `${p.day} ${p.by_user} ${p.qty}`).join(', ')}`}>balance</span>}</>}</td>
                          <td className="n">{s ? <span className="pk-qty">
                            {isLast && <span className={`pill ${lastMode === 'full' ? 'warn' : 'accent'}`}>{lastMode === 'full' ? 'full roll' : 'cut'}</span>}
                            <input className="as-search" type="number" step="0.001" min="0.001" max={r.available} value={s.qty} onClick={(e) => e.stopPropagation()}
                              onChange={(e) => setSel((x) => ({ ...x, [r.pallet]: { ...x[r.pallet], qty: e.target.value } }))} aria-label="Pick qty" />
                          </span> : ''}</td>
                          <td>{r.needsConfirm ? <span className="pill warn" title={`${r.warnings.join('\n')}\n\n${checkText(r.checks)}`}>Check: {r.warnings[0]}</span>
                            : r.pool ? <span className="pill info" title={r.qtyNote || ''}>ZINR → Korber · PO shared by {r.pool} SO lines — tick</span>
                            : r.direct ? <span className="pill ok" title={r.qtyNote || ''}>ZINR → Korber ✓ (Item, Lot, Invoice, Po{r.checks.hu ? ', Roll no' : ''})</span>
                            : <span className="pill ok" title={`${checkText(r.checks)}${r.qtyNote ? `\n\n${r.qtyNote}` : ''}`}>All match ✓{r.korberQty ? ' · Korber qty' : r.qtyNote ? ' · split roll' : ''}</span>}</td>
                        </tr>
                      );
                    })}</tbody>
                  </table>
                </div>
              )}
            </div>

            {lastOn && last && (() => { const sp = c.rolls.find((r) => r.pallet === last.pallet)?.sameSoPlant; return sp ? (
              <div className="notice ok so-plant">
                <b>SO Plant same ({sp.plant})</b> — {sp.lines.length ? <>the rest of this roll is for {sp.lines.join(', ')}, with the same SO Plant</> : <>the rest of this roll stays on this SO line</>}: no need to cut it.{kind === 'normal' ? ' The full roll is proposed.' : ' (Offsite pick: exact QTY only.)'}
              </div>) : null; })()}
            {lastOn && last && (kind === 'offsite' ? (
              <div className="pk-last">
                <div>
                  <b>Last roll {last.hu || ''}</b> <span className="mono">{last.pallet}</span>
                  <div className="muted small">Offsite pick: the roll is cut to {fmtQty(last.cut)} of {fmtQty(last.full)} so the QTY is exactly the plan. A full roll or a short pick is not allowed.</div>
                </div>
                <span className="pill accent">Cut to {fmtQty(last.cut)}</span>
              </div>
            ) : (
              <div className={`pk-last ${lastSmall ? 'small-over' : ''}`}>
                <div>
                  <b>Last roll {last.hu || ''}</b> <span className="mono">{last.pallet}</span>
                  <div className="muted small">The plan needs {fmtQty(last.cut)} more; this roll has {fmtQty(last.full)}. Choose how to send it.</div>
                </div>
                <div className="pk-choice" role="radiogroup" aria-label="Last roll">
                  <button type="button" role="radio" aria-checked={lastMode === 'cut'} className={lastMode === 'cut' ? 'on' : ''} onClick={() => setLastTo('cut')}>
                    <b>Cut the roll</b><span>Pick {fmtQty(last.cut)} · exact plan QTY</span>
                  </button>
                  {rules.allowNormalFull && <button type="button" role="radio" aria-checked={lastMode === 'full'} className={lastMode === 'full' ? 'on' : ''} onClick={() => setLastTo('full')}>
                    <b>Send full roll{lastSmall || c.rolls.find((r) => r.pallet === last.pallet)?.sameSoPlant ? ' (recommended)' : ''}</b><span>Pick {fmtQty(last.full)} · +{fmt(last.full - last.cut, 2)} over plan — I confirm</span>
                  </button>}
                  {rules.allowNormalShort && <button type="button" role="radio" aria-checked={lastMode === 'leave'} className={lastMode === 'leave' ? 'on' : ''} onClick={() => setLastTo('leave')}>
                    <b>Leave this roll</b><span>Send {fmt(last.cut, 2)} less · line closed short — I confirm</span>
                  </button>}
                </div>
              </div>
            ))}

            {(c.nobarcode?.length ?? 0) > 0 && (
              <div className="nb-pick">
                <h3>No Barcode — choose the roll <span className="pill info">{c.nobarcode!.length}</span>{nbSel.length > 0 && <span className="muted small"> · {nbSel.length} chosen</span>}</h3>
                <p className="sub" style={{ margin: '0 0 6px' }}>These Shade Report rolls have no Barcode Number in ZCOMENT. Listed: Korber rolls of the same item with <b>Supplier Hu = Vendor Roll No</b> (only <b>Lot Number = Vendor Batch</b> when there is no roll no), Invoice and Po not different, and not the barcode of another roll. Choose the right one — a roll whose Lot or Qty differs needs “I checked”. An inspection lot with <b>no Shade Report</b> in ZCOMENT is listed here too: its Korber rolls with the same Lot Number, the one whose Actual Qty is the lot QTY first.</p>
                <div className="table-wrap pk-tbl"><table className="mini">
                  <thead><tr><th>Vendor Roll No</th><th>Vendor Batch</th><th>Batch</th><th>Shade</th><th className="n">Roll / lot qty</th><th>Korber roll</th><th className="n">Pick qty</th></tr></thead>
                  <tbody>{c.nobarcode!.map((m, i) => {
                    const chosen = nbSel.find(([, x]) => x.nb === m);
                    const co = chosen?.[1].korber as NbOption | undefined;
                    const takenElsewhere = (p: string) => !!sel[p] && sel[p].nb !== m;
                    return (
                      <tr key={i} className={chosen ? 'picked' : ''}>
                        <td>{m.zcBarcode ? <><b>{m.roll_no || '–'}</b> <span className="pill warn" title={`ZCOMENT Barcode Number ${m.zcBarcode} is not a Korber pallet — rolls with the same Supplier Hu = Vendor Roll No and Lot are listed`}>barcode {m.zcBarcode} not in Korber</span></> : m.noShade ? <span className="pill warn" title={`Inspection lot ${m.lot} has no Shade Report rolls in ZCOMENT VIEW. Rolls with Lot Number = ${m.vendor_batch ?? '–'} and Actual Qty = the lot QTY come first.`}>no Shade Report · lot {m.lot}</span> : <b>{m.roll_no || '–'}</b>}</td><td>{m.vendor_batch || '–'}</td><td className="mono">{m.batch}</td><td><b>{m.shade}</b></td><td className="n">{fmtQty(m.roll_qty)}</td>
                        <td>{m.done ? <span className="pill mute">picked · {m.options[0]?.pallet}</span> : <>
                          <select className="as-search nb-select" value={chosen?.[0] ?? ''} onChange={(e) => chooseNb(m, e.target.value)} aria-label={`Korber roll for ${m.roll_no || 'roll'}`}>
                            <option value="">— choose a Korber roll ({m.options.length} match{m.options.length === 1 ? '' : 'es'}) —</option>
                            {m.options.map((o) => {
                              const miss = nbMiss(o, m);
                              const ok = (['lot', 'hu', 'invoice', 'po', 'qty'] as const).filter((k) => o.checks[k]).map((k) => ({ lot: 'Lot', hu: 'HU', invoice: 'Inv', po: 'Po', qty: 'Qty' })[k]);
                              return <option key={o.pallet} value={o.pallet} disabled={o.available <= 1e-9 || takenElsewhere(o.pallet)}>
                                {o.pallet} · Lot {o.lot ?? '–'} · HU {o.supplier_hu ?? '–'} · {fmtQty(o.available)}{o.picked_before > 0 ? ' left' : ''} · {o.location ?? ''} · {o.available <= 1e-9 ? 'picked' : takenElsewhere(o.pallet) ? 'chosen for another roll' : `✓ ${ok.join(' ')}${miss.length ? ` · ✗ ${miss.map((k) => ({ lot: 'Lot', hu: 'HU', qty: 'Qty' })[k]).join(' ')}` : ''}`}
                              </option>;
                            })}
                          </select>
                          {m.options.some((o) => o.picked_before > 0) && <div className="muted small">Part picked before as {m.options[0].pallet} — its balance only</div>}
                          {co && <div className="nb-checks">{(['lot', 'hu', 'invoice', 'po', 'qty'] as const).map((k) => co.checks[k] === null ? null : <span key={k} className={`pill ${co.checks[k] ? 'ok' : 'warn'}`}>{co.checks[k] ? '✓' : '✗'} {({ lot: 'Lot', hu: 'Supplier Hu', invoice: 'Invoice', po: 'Po', qty: `Qty ${fmtQty(co.qty)}` })[k]}</span>)}</div>}
                        </>}</td>
                        <td className="n">{chosen ? <input className="as-search" type="number" step="0.001" min="0.001" max={co?.available} style={{ width: 92 }} value={chosen[1].qty}
                          onChange={(e) => setSel((x) => ({ ...x, [chosen[0]]: { ...x[chosen[0]], qty: e.target.value } }))} aria-label="Pick qty" /> : ''}</td>
                      </tr>
                    );
                  })}</tbody>
                </table></div>
              </div>
            )}

            {(c.manual?.length ?? 0) > 0 && shortfall > 1e-9 && (
              <div className="manual-pick">
                <h3>Not matched — pick by hand <span className="pill warn">{c.manual!.length}</span></h3>
                <p className="sub" style={{ margin: '0 0 6px' }}>The matched rolls leave <b>{fmtQty(shortfall)}</b>{manualTotal > 0 && manualLeft > 1e-9 ? <> (<b>{fmtQty(manualLeft)}</b> still open)</> : ''}. Only this balance can be picked by hand: choose a Korber roll (search or scan pallet, lot or supplier HU).</p>
                <div className="table-wrap pk-tbl"><table className="mini">
                  <thead><tr><th>Roll</th><th>ZCOMENT barcode</th><th>Shade</th><th className="n">Roll qty</th><th>Why it did not match</th><th>Korber roll</th><th className="n">Pick qty</th></tr></thead>
                  <tbody>{c.manual!.map((m, i) => {
                    const chosen = manualSel.find(([, x]) => x.manual === m);
                    return (
                      <tr key={i} className={chosen ? 'picked' : ''}>
                        <td><b>{m.roll_no || '–'}</b></td><td className="mono">{m.barcode || <span className="muted">none</span>}</td><td><b>{m.shade}</b></td><td className="n">{fmtQty(m.roll_qty)}</td>
                        <td className="muted small why" title={m.reason}><span>{m.reason}</span></td>
                        <td>{chosen ? <span className="mono">{chosen[0]} <button className="btn sm" onClick={() => setSel((x) => { const n = { ...x }; delete n[chosen[0]]; return n; })} aria-label="Remove">✕</button></span>
                          : <button className="btn sm" disabled={manualLeft <= 1e-9} title={manualLeft <= 1e-9 ? 'The balance is already covered' : undefined} onClick={() => setChoosing(m)}>Choose Korber roll…</button>}</td>
                        <td className="n">{chosen ? <input className="as-search" type="number" step="0.001" min="0.001" max={Math.min(chosen[1].korber?.available ?? Infinity, r3(shortfall - manualTotal + (Number(chosen[1].qty) || 0)))} style={{ width: 92 }} value={chosen[1].qty}
                          onChange={(e) => setSel((x) => ({ ...x, [chosen[0]]: { ...x[chosen[0]], qty: e.target.value } }))} aria-label="Pick qty" /> : ''}</td>
                      </tr>
                    );
                  })}</tbody>
                </table></div>
              </div>
            )}
            {(c.manual?.length ?? 0) > 0 && shortfall <= 1e-9 && (
              <p className="muted small" style={{ margin: 0 }}>{c.manual!.length} shade-report roll{c.manual!.length === 1 ? ' does' : 's do'} not match a Korber roll, but the matched rolls cover the line — nothing to pick by hand.</p>
            )}
            {choosing && <KorberChooser item={line.item} roll={choosing} taken={Object.keys(sel)} onUse={(k) => useKorber(choosing, k)} onClose={() => setChoosing(null)} />}

            {offsiteOver && <div className="notice bad">Offsite pick: the selected QTY is {fmt(diff, 2)} over the plan balance. Cut the last roll to the exact QTY or untick a roll.</div>}
            {kind === 'normal' && rules.allowNormalShort && isShort && !(lastOn && lastMode === 'leave') && (
              <div className="pk-confirm soft">
                <label><input type="checkbox" checked={closeShort} onChange={(e) => setCloseShort(e.target.checked)} />
                  <span><b>Close the line {fmt(-diff, 2)} short</b><small>Tick to treat the line as complete with this pick (no cut, nothing more to pick). Leave unticked to pick the rest later.</small></span>
                </label>
              </div>
            )}
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
          <button type="button" className="btn primary" aria-busy={!!busy || undefined} disabled={busy || blocked} onClick={save}
            title={blocked && nSel ? (flagged.length && !checkedOk ? 'Tick “I checked” first' : needOverOk && !overOk ? 'Confirm the over-plan QTY first' : '') : undefined}>
            {busy ? 'Saving…' : `${kind === 'offsite' ? 'Offsite' : 'Normal'} pick · ${nSel} roll${nSel === 1 ? '' : 's'} · ${fmt(total, 2)}`}
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
        {rows === null ? <Loader label="Searching Korber…" /> : !rows.length ? <p className="muted">No Korber roll found{q ? ` for “${q}”` : ''}.</p> : (
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
  // the history is everyone's: who picked what, so nobody picks a roll twice. "Mine" narrows it.
  const me = getSession()?.user.username || '';
  const boss = isBossRole(getSession()?.user.role);
  const [mine, setMine] = useState(false);
  const load = useCallback(() => { api<PickHistory>('/api/pick/history?day=' + day + (mine && me ? '&user=' + encodeURIComponent(me) : '')).then(setH).catch(() => {}); }, [day, mine, me]);
  useEffect(() => { load(); }, [load]);
  const live = (h?.requests || []).filter((r) => !r.cancelled_at);
  // the picks marked for the download (none marked = all of the day)
  const [sel, setSel] = useState<Set<number>>(new Set());
  useEffect(() => { setSel(new Set()); }, [day, mine]);
  const marked = live.filter((r) => sel.has(r.id));
  const allOn = live.length > 0 && marked.length === live.length;
  const flip = (id: number) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const [oneSheet, setOneSheet] = useState(() => { try { return localStorage.getItem('pl_one_sheet') !== '0'; } catch { return true; } });
  const setOne = (v: boolean) => { setOneSheet(v); try { localStorage.setItem('pl_one_sheet', v ? '1' : '0'); } catch { /* */ } };
  const tag = marked.length ? `_${marked.length}picks` : '';
  // PFC storage locations (Settings) — those rolls go on the PFC sheet, the rest on KFC
  const [pfcSlocs, setPfcSlocs] = useState<string[]>(['41', 'COMF']);
  useEffect(() => { api<{ settings: { pfcSlocs?: string[] } }>('/api/settings').then((r) => { if (r.settings.pfcSlocs?.length) setPfcSlocs(r.settings.pfcSlocs); }).catch(() => {}); }, []);
  const downloadPL = () => saveWorkbook(packingListWorkbook(h!, { ids: sel, combined: oneSheet, pfcSlocs }), `Packing_List_${day}${tag}.xlsx`);
  const downloadKorber = () => saveWorkbook(korberWorkbook(h!, sel), `Korber_Picked_${day}${tag}.xlsx`);
  const markedQty = marked.reduce((t, r) => t + r.qty, 0);
  const cancel = async (path: string, what: string) => {
    if (!confirm(`Cancel ${what}? It is deleted from the pick history and the roll${path.includes('/req/') ? 's become' : ' becomes'} pickable again.`)) return;
    try { await api(path, { method: 'DELETE' }); toast(`${what} cancelled and deleted from the history`); load(); onChanged(); } catch (e) { toast(e instanceof Error ? e.message : 'Failed.'); }
  };
  // the marked picks this user may cancel (their own; Admin / Head: anyone's), cancelled together
  const cancelable = marked.filter((r) => boss || r.by_user === me);
  const [bulkBusy, setBulkBusy] = useState('');
  const cancelMarked = async () => {
    if (!cancelable.length) return;
    const others = marked.length - cancelable.length;
    if (!confirm(`Cancel ${cancelable.length} marked pick${cancelable.length === 1 ? '' : 's'} (${fmtQty(cancelable.reduce((t, r) => t + r.qty, 0))} QTY, ${cancelable.reduce((t, r) => t + r.rolls, 0)} rolls)?\n\nThey are deleted from the pick history and their rolls become pickable again.${others ? `\n${others} marked pick${others === 1 ? ' is' : 's are'} another user's and stay.` : ''}`)) return;
    let ok = 0; const fail: string[] = [];
    for (const r of cancelable) {
      setBulkBusy(`Cancelling ${ok + fail.length + 1} / ${cancelable.length}…`);
      try { await api(`/api/pick/req/${r.id}`, { method: 'DELETE' }); ok++; } catch (e) { fail.push(`${ordinal(r.seq)} ${r.so}/${r.li}: ${e instanceof Error ? e.message : 'failed'}`); }
    }
    setBulkBusy(''); setSel(new Set());
    toast(`${ok} pick${ok === 1 ? '' : 's'} cancelled${fail.length ? ` · ${fail.length} could not be cancelled — ${fail.slice(0, 2).join('; ')}` : ''}`);
    load(); onChanged();
  };
  const days = Array.from(new Set([today(), ...(h?.days || []).map((d) => d.day)])).sort().reverse();
  return (
    <section className="card" aria-labelledby="ph-title">
      <div className="sheet-top">
        <div>
          <h2 id="ph-title">Pick history &amp; Packing List</h2>
          <p className="sub" style={{ margin: 0 }}>Everyone&apos;s picks of the day. A fully picked roll can&apos;t be picked again by anyone; a part-picked roll keeps only its balance for the next pick. Cancel deletes a pick and frees its rolls — mark several picks to cancel them together.</p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <div className="seg" role="group" aria-label="Whose picks">
            <button className={!mine ? 'on' : ''} onClick={() => setMine(false)}>Everyone</button>
            <button className={mine ? 'on' : ''} onClick={() => setMine(true)}>Mine</button>
          </div>
          <select className="as-search" value={day} onChange={(e) => setDay(e.target.value)} aria-label="Day">
            {days.map((d) => { const x = h?.days.find((y) => y.day === d); return <option key={d} value={d}>{fmtDate(d)}{d === today() ? ' (today)' : ''}{x ? ` · ${x.open} pick${x.open === 1 ? '' : 's'}` : ''}</option>; })}
          </select>
        </div>
      </div>
      {h && live.length > 0 && (
        <div className="pl-bar" role="group" aria-label="Packing List download">
          <span className="pl-what">{marked.length
            ? <><b>{marked.length}</b> of {live.length} picks marked · {fmtQty(markedQty)} QTY · {marked.reduce((t, r) => t + r.rolls, 0)} rolls</>
            : <>No picks marked — the download has <b>all {live.length}</b> picks of the day. Tick picks below to choose.</>}</span>
          <div className="seg" role="group" aria-label="Packing List format" title="How the picks go into the Packing List">
            <button className={oneSheet ? 'on' : ''} onClick={() => setOne(true)}>One sheet</button>
            <button className={!oneSheet ? 'on' : ''} onClick={() => setOne(false)}>Sheet per pick</button>
          </div>
          <button className="btn primary" onClick={downloadPL}>Download Packing List{marked.length ? ` (${marked.length})` : ''}</button>
          <button className="btn" disabled={!h.korberHeader} onClick={downloadKorber} title="The picked rolls in the Korber Inventory format (cut rolls with the cut QTY)">Korber Inventory{marked.length ? ` (${marked.length})` : ''}</button>
          {canEdit && marked.length > 0 && <button className="btn danger" disabled={!cancelable.length || !!bulkBusy} aria-busy={!!bulkBusy || undefined} onClick={cancelMarked}
            title={cancelable.length ? 'Cancel the marked picks: deleted from the history, their rolls become pickable again' : 'You can cancel only your own picks'}>{bulkBusy || `Cancel marked (${cancelable.length})`}</button>}
          {marked.length > 0 && <button className="btn sm" onClick={() => setSel(new Set())}>Clear marks</button>}
        </div>
      )}
      {!h ? <Loader label="Loading the pick history…" /> : !h.requests.length ? <p className="muted">No picks on {fmtDate(day)}.</p> : (
        <div className="table-wrap" style={{ maxHeight: 'none' }}>
          <table className="mini">
            <thead><tr><th className="ck"><input type="checkbox" checked={allOn} ref={(el) => { if (el) el.indeterminate = marked.length > 0 && !allOn; }} onChange={() => setSel(allOn ? new Set() : new Set(live.map((r) => r.id)))} aria-label="Mark all picks" /></th><th>Req</th><th>Type</th><th>SO / LI / Item</th><th>Plant</th><th className="n">Plan QTY</th><th className="n">Picked</th><th className="n">Rolls</th><th>HJ Pick No</th><th>By</th><th /></tr></thead>
            <tbody>{h.requests.map((r) => {
              const rolls = h.picks.filter((p) => p.req_id === r.id);
              return [
                <tr key={r.id} className={`${r.cancelled_at ? 'gone' : ''} ${sel.has(r.id) ? 'marked' : ''}`} onClick={() => setOpen(open === r.id ? null : r.id)} style={{ cursor: 'pointer' }}>
                  <td className="ck" onClick={(e) => e.stopPropagation()}>{!r.cancelled_at && <input type="checkbox" checked={sel.has(r.id)} onChange={() => flip(r.id)} aria-label={`Mark ${ordinal(r.seq)} pick for the Packing List`} />}</td>
                  <td><b>{ordinal(r.seq)}</b></td>
                  <td><span className={`pill ${r.kind === 'offsite' ? 'accent' : 'mute'}`}>{r.kind === 'offsite' ? 'Offsite' : 'Normal'}</span></td>
                  <td>{r.so} / {r.li} / {r.item}</td><td>{r.plant}</td><td className="n">{fmtQty(r.need)}</td>
                  <td className="n"><b>{fmtQty(r.qty)}</b>{r.closed ? <span className="pill warn" style={{ marginLeft: 4 }} title="Line closed short">−{fmtQty(r.short ?? 0)}</span> : ''}</td><td className="n">{r.rolls}</td>
                  <td>{r.pick_no}</td><td className="muted">{r.by_user} · {ago(r.at)}</td>
                  <td>{canEdit && (boss || r.by_user === me) && <button className="btn sm" onClick={(e) => { e.stopPropagation(); cancel(`/api/pick/req/${r.id}`, `${ordinal(r.seq)} pick`); }}>Cancel</button>}</td>
                </tr>,
                open === r.id && (
                  <tr key={r.id + 'd'}><td colSpan={11} style={{ background: 'var(--panel-2)' }}>
                    <table className="mini">
                      <thead><tr><th>Pallet</th><th>Lot</th><th>Shade</th><th className="n">Roll qty</th><th className="n">Picked</th><th>Insp. lot</th><th>Note</th><th /></tr></thead>
                      <tbody>{rolls.map((p) => (
                        <tr key={p.id} className={p.cancelled_at ? 'gone' : ''}>
                          <td className="mono">{p.pallet}</td><td>{p.lot}</td><td>{p.shade}</td><td className="n">{fmtQty(p.roll_qty)}</td>
                          <td className="n">{fmtQty(p.qty)}{p.partial ? <span className="pill accent" style={{ marginLeft: 4 }}>cut</span> : ''}</td><td>{p.insp_lot}</td><td className="muted">{p.note}</td>
                          <td>{canEdit && (boss || r.by_user === me) && <button className="btn sm" onClick={() => cancel(`/api/pick/roll/${p.id}`, `roll ${p.pallet}`)}>Remove</button>}</td>
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
