'use client';
/**
 * v206 (API 132): a Korber file of pallets picked OUTSIDE this system — only those pallets, Actual Qty = the QTY taken.
 * Saved as picks of those pallets: the system does not pick that QTY again (every Pick, every day). Each upload can be
 * removed (undo): the QTY is free again.
 * v218 (API 140): or a Packing List (one or more "… Packing List" sheets, each with its pallet rows and the SAP rows under them):
 * its pallets and Actual Qty are saved the same way. A sheet with a Pick ID of this system is that Pick's own PL (its picks are
 * counted already) and is left out; a pallet row already uploaded, or the same QTY as the pallet's system picks, is left out too.
 */
import * as React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '@/lib/api';
import { fmt } from '@/lib/calc';
import { readWorkbook } from '@/lib/mapping';
import { findTable } from '@/lib/pick';

const hn = (v: unknown) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
interface Batch { batch: string; file_name: string; by_user: string; at: string; n: number; qty: number }
type Grid = unknown[][];
const num = (v: unknown) => { const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(/,/g, '').trim()); return Number.isFinite(n) ? n : 0; };
const r3 = (x: number) => Math.round(x * 1000) / 1000;
interface PlRow { pallet: string; item: string; lot: string; qty: number }
interface PlSheet { name: string; pickId: string; hj: string; rows: PlRow[] }
type Flag = '' | 'used' | 'sys' | 'dup';
interface Plan { file: string; sheets: (PlSheet & { known: boolean; on: boolean })[]; info: Record<string, { sys: number; used: number; korber: number | null; sysQ?: number[]; usedQ?: number[] }> }

/** a Packing List workbook: every sheet's pallet rows (under each "Pallet … Actual Qty" header; the SAP rows under them have
 *  no Actual Qty and are skipped). null = not a Packing List (a Korber Inventory file). */
function readPL(sheets: { name: string; grid: Grid }[]): PlSheet[] | null {
  const out: PlSheet[] = [];
  let isPl = false;
  for (const s of sheets) {
    let pickId = '', hj = '', heads = 0;
    for (let i = 0; i < Math.min(8, s.grid.length); i++) (s.grid[i] || []).forEach((c, j) => {
      const h = hn(c);
      if (h === 'pick id') pickId = String(s.grid[i + 1]?.[j] ?? '').trim();
      if (h === 'hj pick') hj = String(s.grid[i + 1]?.[j] ?? '').trim();
      if (h === 'total qty') isPl = true;
    });
    if (/packing\s*list/i.test(s.name)) isPl = true;
    let col: { pi: number; qi: number; ii: number; di: number; li: number } | null = null;
    const rows: PlRow[] = [];
    for (const r of s.grid) {
      const h = (r || []).map(hn);
      if (h.includes('pallet') && h.includes('actual qty')) { heads++; col = { pi: h.indexOf('pallet'), qi: h.indexOf('actual qty'), ii: h.indexOf('item number'), di: h.indexOf('display item number'), li: h.indexOf('lot number') }; continue; }
      if (!col) continue;
      const pallet = String(r[col.pi] ?? '').trim().toUpperCase(), qty = num(r[col.qi]);
      const item = String((col.di >= 0 && r[col.di]) || (col.ii >= 0 ? r[col.ii] : '') || '').trim();
      if (pallet && qty > 0 && item) rows.push({ pallet, item, lot: col.li >= 0 ? String(r[col.li] ?? '').trim() : '', qty: r3(qty) });
    }
    if (heads > 1) isPl = true;
    if (rows.length) out.push({ name: s.name, pickId, hj, rows });
  }
  return isPl && out.length ? out : null;
}

export default function UsedPallets({ canEdit, toast, onChanged }: { canEdit: boolean; toast: (m: string) => void; onChanged?: () => void }) {
  const [list, setList] = useState<Batch[] | null>(null);
  const [busy, setBusy] = useState(false);
  const inp = useRef<HTMLInputElement>(null);
  const [plan, setPlan] = useState<Plan | null>(null);

  const load = useCallback(() => api<{ batches: Batch[] }>('/api/used').then((r) => setList(r.batches)).catch(() => setList([])), []);
  useEffect(() => { void load(); }, [load]);

  const upload = async (f: File) => {
    setBusy(true);
    try {
      const sheets = readWorkbook(await f.arrayBuffer());
      // v218: a Packing List — checked against the system first, then saved from the dialog
      const pl = readPL(sheets);
      if (pl) {
        const all = pl.flatMap((x) => x.rows);
        const ck = await api<{ pallets: Plan['info']; picks: { uid: string }[] }>('/api/used', { method: 'POST', body: { check: true, rows: all.map((r) => ({ pallet: r.pallet })), pickIds: pl.map((x) => x.pickId).filter(Boolean) } });
        const known = new Set(ck.picks.map((x) => x.uid.toUpperCase()));
        setPlan({ file: f.name, info: ck.pallets, sheets: pl.map((x) => ({ ...x, known: !!x.pickId && known.has(x.pickId.toUpperCase()), on: !(x.pickId && known.has(x.pickId.toUpperCase())) })) });
        return;
      }
      const t = findTable(sheets, 'korber');
      if (!t) throw new Error(`${f.name} does not look like a Korber Inventory or a Packing List: no header row with Pallet, Item Number, Actual Qty.`);
      const h = t.header.map(hn);
      const pi = h.indexOf('pallet'), qi = h.indexOf('actual qty'), ii = h.indexOf('item number'), di = h.indexOf('display item number'), li = h.indexOf('lot number');
      const rows = t.rows.map((r) => ({ pallet: r[pi], item: (di >= 0 && r[di]) || r[ii], lot: li >= 0 ? r[li] : null, qty: r[qi] }));
      const n = new Set(rows.map((r) => String(r.pallet ?? '').trim()).filter(Boolean)).size;
      if (!window.confirm(`${f.name}: save ${fmt(n)} pallet${n === 1 ? '' : 's'} as PICKED (outside the system)?\n\nTheir Actual Qty comes off those pallets for every Pick — the system will not pick that QTY again. You can remove the upload later.`)) return;
      const r = await api<{ pallets: number; qty: number; over: number; unknown: number; dup?: number }>('/api/used', { method: 'POST', body: { fileName: f.name, rows } });
      toast(`${f.name}: ${fmt(r.pallets)} pallet${r.pallets === 1 ? '' : 's'} · ${fmt(r.qty, 2)} QTY saved as picked — not picked again${r.dup ? ` · ${r.dup} already in the system, not saved again` : ''}${r.over ? ` · ${r.over} over what the pallet had` : ''}${r.unknown ? ` · ${r.unknown} not in the Korber Inventory` : ''}`);
      await load(); onChanged?.();
    } catch (e) { toast(e instanceof Error ? e.message : 'Could not upload.'); }
    finally { setBusy(false); }
  };
  // v219: never a duplicate — a row whose pallet and QTY the system has already (an earlier upload, a system pick, all the
  // pallet's system picks together) or that is the same as an earlier row of the ticked sheets is always left out
  const flagsOf = (p: Plan) => {
    const out = new Map<PlRow, Flag>();
    const same = (a: number, b: number) => Math.abs(a - b) <= 0.0005;
    const seen = new Map<string, number[]>();
    for (const x of p.sheets) for (const r of x.rows) {
      const inf = p.info[r.pallet];
      let f: Flag = '';
      if (inf?.usedQ?.some((q) => same(q, r.qty))) f = 'used';
      else if (inf && (inf.sysQ?.some((q) => same(q, r.qty)) || (inf.sys > 1e-9 && same(inf.sys, r.qty)))) f = 'sys';
      else if (x.on && (seen.get(r.pallet) ?? []).some((q) => same(q, r.qty))) f = 'dup';
      if (x.on && !f) seen.set(r.pallet, [...(seen.get(r.pallet) ?? []), r.qty]);
      out.set(r, f);
    }
    return out;
  };
  const chosenRows = (p: Plan) => { const fl = flagsOf(p); return p.sheets.filter((x) => x.on).flatMap((x) => x.rows.filter((r) => !fl.get(r))); };
  const savePl = async () => {
    if (!plan) return;
    const rows = chosenRows(plan);
    if (!rows.length) { toast('Nothing to save — every row is left out.'); return; }
    setBusy(true);
    try {
      const r = await api<{ pallets: number; qty: number; over: number; unknown: number; dup?: number }>('/api/used', { method: 'POST', body: { fileName: plan.file, rows } });
      toast(`${plan.file}: ${fmt(r.pallets)} pallet${r.pallets === 1 ? '' : 's'} · ${fmt(r.qty, 2)} QTY saved as picked — not picked again${r.dup ? ` · ${r.dup} already in the system, not saved again` : ''}${r.over ? ` · ${r.over} over what the pallet had` : ''}${r.unknown ? ` · ${r.unknown} not in the Korber Inventory` : ''}`);
      setPlan(null); await load(); onChanged?.();
    } catch (e) { toast(e instanceof Error ? e.message : 'Could not save.'); }
    finally { setBusy(false); }
  };
  const remove = async (b: Batch) => {
    if (!window.confirm(`Remove ${b.file_name} (${fmt(b.n)} pallet rows, ${fmt(b.qty, 2)} QTY)? That QTY can be picked again.`)) return;
    try { await api('/api/used?batch=' + encodeURIComponent(b.batch), { method: 'DELETE' }); toast(`${b.file_name} removed — ${fmt(b.qty, 2)} QTY free again`); await load(); onChanged?.(); }
    catch (e) { toast(e instanceof Error ? e.message : 'Could not remove.'); }
  };

  return (
    <section className="card used-card" aria-labelledby="used-title">
      <div className="table-head">
        <div>
          <h2 id="used-title">Picked pallets (Korber / Packing List)</h2>
          <p className="muted small" style={{ margin: 0 }}>A Korber Inventory file of pallets already picked outside this system — only those pallets, <b>Actual Qty = QTY taken</b> — or a <b>Packing List</b> (its pallet rows). Saved as picked: the system does not pick that pallet QTY again (every Pick). Remove an upload to free it.</p>
        </div>
        {canEdit && <>
          <button className="btn primary" disabled={busy} aria-busy={busy || undefined} onClick={() => inp.current?.click()}>{busy ? 'Saving…' : 'Upload picked pallets / PL'}</button>
          <input ref={inp} type="file" hidden accept=".xlsx,.xls,.xlsm,.csv" onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ''; }} />
        </>}
      </div>
      {list === null ? <p className="muted small">Loading…</p> : !list.length ? <p className="muted small">No picked-pallets file uploaded.</p> : (
        <div className="table-wrap"><table className="tbl used-tbl">
          <thead><tr><th>File</th><th className="n">Pallets</th><th className="n">QTY</th><th>By</th><th>Uploaded</th>{canEdit && <th />}</tr></thead>
          <tbody>{list.map((b) => (
            <tr key={b.batch}><td>{b.file_name}</td><td className="n">{fmt(b.n)}</td><td className="n">{fmt(b.qty, 2)}</td><td>{b.by_user}</td><td>{new Date(b.at).toLocaleString()}</td>
              {canEdit && <td><button className="btn sm danger" onClick={() => void remove(b)}>Remove</button></td>}</tr>
          ))}</tbody>
        </table></div>
      )}
      {plan && (() => {
        const all = plan.sheets.flatMap((x) => x.rows);
        const fm = flagsOf(plan);
        const fl = all.map((r) => fm.get(r) ?? '');
        const nUsed = fl.filter((x) => x === 'used').length, nSys = fl.filter((x) => x === 'sys').length, nDup = fl.filter((x) => x === 'dup').length;
        const rows = chosenRows(plan);
        const pal = new Set(rows.map((r) => r.pallet)).size, qty = r3(rows.reduce((t, r) => t + r.qty, 0));
        return createPortal(
          <div className="bal-back" role="dialog" aria-modal="true" aria-labelledby="plu-title" onClick={() => !busy && setPlan(null)}>
            <div className="bal-dlg card ka-dlg kl-dlg" onClick={(e) => e.stopPropagation()}>
              <h3 id="plu-title">Packing List → picked pallets</h3>
              <p className="muted small"><b>{plan.file}</b> · tick the sheets to save. Their pallets&apos; Actual Qty is saved as picked — the system does not pick it again.</p>
              <div className="table-wrap"><table className="tbl plu-tbl">
                <thead><tr><th /><th>Sheet</th><th>HJ pick</th><th>Pick ID</th><th className="n">Pallets</th><th className="n">QTY</th><th>Already in the system</th></tr></thead>
                <tbody>{plan.sheets.map((x, i) => {
                  const f = x.rows.map((r) => fm.get(r)).filter(Boolean).length;
                  return (
                    <tr key={x.name} className={x.on ? '' : 'off'}>
                      <td><input type="checkbox" aria-label={`Save ${x.name}`} checked={x.on} onChange={() => setPlan((p) => p && { ...p, sheets: p.sheets.map((y, j) => (j === i ? { ...y, on: !y.on } : y)) })} /></td>
                      <td>{x.name}</td><td>{x.hj || '—'}</td>
                      <td>{x.pickId ? <>{x.pickId}{x.known && <span className="pill warn" style={{ marginLeft: 6 }}>this system&apos;s Pick — counted already</span>}</> : '—'}</td>
                      <td className="n">{fmt(new Set(x.rows.map((r) => r.pallet)).size)}</td><td className="n">{fmt(x.rows.reduce((t, r) => t + r.qty, 0), 2)}</td>
                      <td>{f ? `${f} row${f === 1 ? '' : 's'}` : '—'}</td>
                    </tr>
                  );
                })}</tbody>
              </table></div>
              {(nUsed > 0 || nSys > 0 || nDup > 0) && <div className="notice small">Left out — already in the system (same pallet and QTY), never saved twice: {[nUsed ? `${nUsed} uploaded before` : '', nSys ? `${nSys} picked in the system` : '', nDup ? `${nDup} a second same row in this file` : ''].filter(Boolean).join(', ')}.</div>}
              <p className="small"><b>To save:</b> {fmt(rows.length)} row{rows.length === 1 ? '' : 's'} · {fmt(pal)} pallet{pal === 1 ? '' : 's'} · {fmt(qty, 2)} QTY</p>
              <div className="bal-acts">
                <button type="button" className="btn" onClick={() => setPlan(null)} disabled={busy}>Cancel</button>
                <button type="button" className="btn primary" onClick={() => void savePl()} disabled={busy || !rows.length} aria-busy={busy || undefined}>{busy ? 'Saving…' : `Save ${fmt(pal)} pallet${pal === 1 ? '' : 's'} as picked`}</button>
              </div>
            </div>
          </div>, document.body);
      })()}
    </section>
  );
}
