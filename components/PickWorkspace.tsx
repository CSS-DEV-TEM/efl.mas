'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import { api } from '@/lib/api';
import { ago, avail, fmt, fmtDate, fmtQty, isDispatched, need, type Line } from '@/lib/calc';
import { action } from '@/lib/smart';
import {
  PICK_SRCS, korberWorkbook, ordinal, packingListWorkbook, uploadPickFile,
  type Candidate, type Candidates, type PickHistory, type PickSrc,
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
        <p className="sub">Upload in any order; each upload replaces the previous one. Matching: ZMMBE → ZINR (SO, LI, Material, Batch, UR = Insp. Lot Qty) → ZCOMENT VIEW Shade Report (Inspection lot) → Korber (Barcode = Pallet; Item, Lot, Supplier HU, Qty and Invoice checked).</p>
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

const Check = ({ v, label }: { v: boolean | null | undefined; label: string }) =>
  v === null || v === undefined ? <span className="chk na" title={`${label}: not available`}>–</span>
    : <span className={`chk ${v ? 'ok' : 'bad'}`} title={`${label} ${v ? 'matches' : 'does not match'}`}>{v ? '✓' : '✗'}</span>;

function PickModal({ week, line, onClose, onDone }: { week: string; line: LineP; onClose: () => void; onDone: (m: string) => void }) {
  const [c, setC] = useState<Candidates | null>(null);
  const [err, setErr] = useState('');
  const [sel, setSel] = useState<Record<string, { qty: string; confirmed: boolean }>>({});
  const [pickNo, setPickNo] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<Candidates>(`/api/pick/candidates?week=${encodeURIComponent(week)}&key=${encodeURIComponent(line.key)}&date=${encodeURIComponent(line.date ?? '')}`)
      .then(setC).catch((e) => setErr(e instanceof Error ? e.message : 'Could not load rolls.'));
  }, [week, line]);
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onClose]);

  const remaining = c ? Math.max(0, Math.round((c.need - c.picked) * 1000) / 1000) : 0;
  const total = Object.values(sel).reduce((t, x) => t + (Number(x.qty) || 0), 0);
  const toggle = (r: Candidate) => setSel((s) => {
    const n = { ...s };
    if (n[r.pallet]) delete n[r.pallet];
    else { const left = Math.max(0, remaining - Object.values(n).reduce((t, x) => t + (Number(x.qty) || 0), 0)); n[r.pallet] = { qty: String(Math.round(Math.min(r.available, left || r.available) * 1000) / 1000), confirmed: false }; }
    return n;
  });
  /** Takes available rolls in order until the balance is covered; the last one is cut to fit. */
  const autoFill = () => {
    if (!c) return;
    const n: typeof sel = {};
    let left = remaining;
    for (const r of c.rolls) {
      if (left <= 1e-9) break;
      if (r.available <= 1e-9) continue;
      const qv = Math.min(r.available, left);
      n[r.pallet] = { qty: String(Math.round(qv * 1000) / 1000), confirmed: sel[r.pallet]?.confirmed ?? false };
      left -= qv;
    }
    setSel(n);
  };
  const unconfirmed = c ? c.rolls.filter((r) => sel[r.pallet] && r.needsConfirm && !sel[r.pallet].confirmed) : [];
  const save = async () => {
    if (!c) return;
    setBusy(true); setErr('');
    try {
      const r = await api<{ label: string; qty: number; rolls: number; day: string }>('/api/pick', { method: 'POST', body: {
        week, key: line.key, date: line.date, pickNo: pickNo.trim() || null,
        rolls: Object.entries(sel).map(([pallet, x]) => ({ pallet, qty: Number(x.qty), confirmed: x.confirmed })),
      } });
      onDone(`${r.label} pick of ${r.day}: ${r.rolls} roll${r.rolls === 1 ? '' : 's'}, ${fmt(r.qty, 2)} — ${line.so} / ${line.li}`);
    } catch (e) { setErr(e instanceof Error ? e.message : 'Pick failed.'); } finally { setBusy(false); }
  };

  return (
    <div className="modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal xwide" role="dialog" aria-modal="true" aria-labelledby="pk-title">
        <div className="modal-head">
          <div>
            <h2 id="pk-title">Pick {line.so} / {line.li} / {line.item}</h2>
            <p className="sub" style={{ margin: 0 }}>{fmtDate(line.date)} · {line.plant} · plan QTY {fmtQty(line.qty)}{c ? <> · already picked <b>{fmtQty(c.picked)}</b> · to pick <b>{fmtQty(remaining)}</b></> : ''}</p>
          </div>
          <button type="button" className="btn sm" onClick={onClose} aria-label="Close">✕</button>
        </div>
        {!c && !err && <p className="muted">Matching ZMMBE → ZINR → ZCOMENT → Korber…</p>}
        {c && (
          <>
            <div className="pk-chain">
              {c.lots.map((l) => (
                <span key={l.lot} className={`pk-lot ${l.qty_ok ? '' : 'warn'}`} title={`Batch ${l.batch}${l.sloc ? ' · St Loc ' + l.sloc : ''}${l.invoice ? ' · invoice ' + l.invoice : ''}`}>
                  Lot <b>{l.lot}</b> · batch {l.batch} · {fmtQty(l.qty)} {l.qty_ok ? '= UR ✓' : `≠ UR ${fmtQty(l.ur)}`} · {l.rolls} roll{l.rolls === 1 ? '' : 's'} ({fmtQty(l.roll_sum)})
                </span>
              ))}
              {!c.lots.length && <span className="pk-lot warn">No ZINR lot matched</span>}
            </div>
            {c.steps.length > 0 && <div className="notice warn" style={{ fontSize: 12.5 }}>{c.steps.slice(0, 6).map((s, i) => <div key={i}>{s}</div>)}{c.steps.length > 6 && <div>… and {c.steps.length - 6} more</div>}</div>}
            {!c.rolls.length ? <p className="muted">No Korber roll matched this line. Check that ZINR, ZCOMENT VIEW and Korber are uploaded and current.</p> : (
              <div className="table-wrap" style={{ maxHeight: 380 }}>
                <table className="mini">
                  <thead><tr><th /><th>Pallet</th><th>Location</th><th>Supplier HU</th><th>Lot</th><th>Shade</th><th className="n">Korber qty</th><th className="n">Roll qty</th><th className="n">Available</th>
                    <th title="Item · Lot · Supplier HU · Qty · Invoice">Checks</th><th className="n">Pick qty</th><th>Confirm</th></tr></thead>
                  <tbody>{c.rolls.map((r) => {
                    const s = sel[r.pallet], gone = r.available <= 1e-9;
                    return (
                      <tr key={r.pallet} className={`${s ? 'picked' : ''} ${gone ? 'gone' : ''}`}>
                        <td><input type="checkbox" disabled={gone} checked={!!s} onChange={() => toggle(r)} aria-label={`Pick ${r.pallet}`} /></td>
                        <td className="mono">{r.pallet}</td><td>{r.location}</td><td>{r.supplier_hu}</td><td>{r.lot}</td><td><b>{r.shade}</b></td>
                        <td className="n">{fmtQty(r.actual_qty)}</td><td className="n">{fmtQty(r.roll_qty)}</td>
                        <td className="n">{gone ? <span className="pill mute" title={r.picks.map((p) => `${p.day} ${p.by_user}: ${p.qty}`).join('\n')}>picked</span> : r.picked_before ? <span title={`Picked before: ${r.picks.map((p) => `${p.day} ${p.by_user} ${p.qty}`).join(', ')}`}>{fmtQty(r.available)} <span className="pill accent">balance</span></span> : fmtQty(r.available)}</td>
                        <td className="checks"><Check v={r.checks.item} label="Item" /><Check v={r.checks.lot} label="Lot" /><Check v={r.checks.hu} label="Supplier HU" /><Check v={r.checks.qty} label="Qty" /><Check v={r.checks.invoice} label="Invoice" /></td>
                        <td className="n">{s ? <input className="as-search" type="number" step="0.001" min="0.001" max={r.available} style={{ width: 92 }} value={s.qty}
                          onChange={(e) => setSel((x) => ({ ...x, [r.pallet]: { ...x[r.pallet], qty: e.target.value } }))} aria-label="Pick qty" /> : ''}</td>
                        <td>{r.needsConfirm ? (s ? <label className="conf" title={r.warnings.join('\n')}><input type="checkbox" checked={s.confirmed} onChange={(e) => setSel((x) => ({ ...x, [r.pallet]: { ...x[r.pallet], confirmed: e.target.checked } }))} /> Confirmed</label>
                          : <span className="pill warn" title={r.warnings.join('\n')}>check</span>) : ''}</td>
                      </tr>
                    );
                  })}</tbody>
                </table>
              </div>
            )}
            {unconfirmed.length > 0 && <div className="notice warn">{unconfirmed.map((r) => <div key={r.pallet}><b>{r.pallet}</b>: {r.warnings.join('; ')} — tick Confirmed after checking the roll.</div>)}</div>}
          </>
        )}
        {err && <div className="notice bad">{err}</div>}
        <div className="modal-foot">
          {c && c.rolls.length > 0 && <button type="button" className="btn" onClick={autoFill} disabled={remaining <= 0}>Select rolls for {fmtQty(remaining)}</button>}
          <label className="pk-no">HJ Pick No <input className="as-search" value={pickNo} onChange={(e) => setPickNo(e.target.value)} placeholder="e.g. 21204655" style={{ width: 130 }} /></label>
          <span className="pk-total">Selected <b>{fmt(total, 2)}</b>{c ? <> / {fmtQty(remaining)}</> : ''}{total > remaining + 1e-6 && remaining > 0 ? <span className="pill warn" style={{ marginLeft: 6 }}>over by {fmt(total - remaining, 2)}</span> : ''}</span>
          <span style={{ flex: 1 }} />
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={busy || !Object.keys(sel).length || unconfirmed.length > 0} onClick={save}>{busy ? 'Saving…' : `Pick ${Object.keys(sel).length} roll${Object.keys(sel).length === 1 ? '' : 's'}`}</button>
        </div>
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
          <button className="btn primary" disabled={!live.length || !h} onClick={() => XLSX.writeFile(packingListWorkbook(h!), `Packing_List_${day}.xlsx`)}>Download Packing List</button>
          <button className="btn" disabled={!live.length || !h?.korberHeader} onClick={() => XLSX.writeFile(korberWorkbook(h!), `Korber_Picked_${day}.xlsx`)} title="The picked rolls in the Korber Inventory format">Korber lines</button>
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
