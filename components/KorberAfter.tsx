'use client';
/**
 * v204: the Korber Inventory as it is after the system's picks. The Korber file kept at its upload is read again, and each
 * pallet's Actual Qty is reduced by what the chosen Picks picked from it — v205: the total pick data (every saved pick of
 * every day in the pick history, not only the picks after the upload). The file comes back in the same columns; a "Picked" sheet lists every pallet reduced (before, picked, left,
 * which Pick / Pick No). Nothing is saved: the database and the uploaded file stay as they are.
 */
import * as React from 'react';
import { useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import { api } from '@/lib/api';
import { fmt, fmtDate } from '@/lib/calc';
import { fetchFileBytes, listFiles, type KeptFile } from '@/lib/files';
import { readWorkbook } from '@/lib/mapping';
import { findTable, type PickHistory, type PickReq, type PickRoll } from '@/lib/pick';
import { todayLocal } from '@/lib/smart';

const hn = (v: unknown) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const up = (v: unknown) => String(v ?? '').trim().toUpperCase();
const num = (v: unknown) => { const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : 0; };
const r3 = (x: number) => Math.round(x * 1000) / 1000;
/** yyyy-mm-dd of a time, on this device's clock */
const localDay = (iso: string) => { const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

type Pk = { p: PickRoll; r: PickReq };

export default function KorberAfter({ scopeRid, pickName, onClose, toast }: { /** the Pick whose own Korber it is ('' = the shared Korber) */ scopeRid: string; pickName: (rid: string) => string; onClose: () => void; toast: (m: string) => void }) {
  const [file, setFile] = useState<KeptFile | null>(null);
  const [picks, setPicks] = useState<Pk[] | null>(null);
  const [err, setErr] = useState('');
  const [on, setOn] = useState<Set<string>>(new Set());
  const [dropEmpty, setDropEmpty] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const f = (await listFiles({ rid: scopeRid, src: 'korber' })).files[0];
        if (!f) throw new Error('This Korber Inventory was uploaded before files were kept — upload it again to keep it.');
        // v205: the total pick data — every saved pick (every user, every Pick) of every day in the pick history
        const out: Pk[] = [];
        const seen = new Set<number>();
        const first = await api<PickHistory>('/api/pick/history?day=' + todayLocal());
        const days = Array.from(new Set([todayLocal(), ...first.days.map((d) => d.day)]));
        for (const d of days) {
          const h = d === todayLocal() ? first : await api<PickHistory>('/api/pick/history?day=' + d);
          const reqs = new Map(h.requests.filter((r) => !r.cancelled_at).map((r) => [r.id, r]));
          for (const p of h.picks) { const r = reqs.get(p.req_id); if (r && !p.cancelled_at && !seen.has(p.id)) { seen.add(p.id); out.push({ p, r }); } }
        }
        if (!live) return;
        setFile(f); setPicks(out); setOn(new Set(out.map((x) => x.r.week)));
      } catch (e) { if (live) setErr(e instanceof Error ? e.message : 'Could not read the Korber Inventory.'); }
    })();
    return () => { live = false; };
  }, [scopeRid]);

  // the Picks with picks after the upload
  const byPick = useMemo(() => {
    const m = new Map<string, { rid: string; n: number; qty: number; pallets: Set<string> }>();
    for (const x of picks || []) {
      const g = m.get(x.r.week) || { rid: x.r.week, n: 0, qty: 0, pallets: new Set<string>() };
      g.n++; g.qty += Number(x.p.qty) || 0; g.pallets.add(up(x.p.pallet)); m.set(x.r.week, g);
    }
    return Array.from(m.values()).sort((a, b) => a.rid.localeCompare(b.rid));
  }, [picks]);
  const chosen = (picks || []).filter((x) => on.has(x.r.week));

  const build = async () => {
    if (!file) return;
    setBusy(true);
    try {
      const sheets = readWorkbook((await fetchFileBytes(file)).buffer as ArrayBuffer);
      const t = findTable(sheets, 'korber');
      if (!t) throw new Error(`${file.name}: no Korber header row (Pallet, Item Number, Actual Qty).`);
      const hh = t.header.map(hn);
      const pi = hh.indexOf('pallet'), qi = hh.indexOf('actual qty'), ii = hh.indexOf('item number'), di = hh.indexOf('display item number'), li = hh.indexOf('lot number');
      // what was picked from each pallet, and by which Pick
      const ded = new Map<string, { q: number; left: number; parts: Pk[] }>();
      for (const x of chosen) { const k = up(x.p.pallet); const d = ded.get(k) || { q: 0, left: 0, parts: [] }; d.q = r3(d.q + (Number(x.p.qty) || 0)); d.parts.push(x); ded.set(k, d); }
      for (const d of Array.from(ded.values())) d.left = d.q;
      const rows: unknown[][] = [], log: (string | number | null)[][] = [];
      let removed = 0, reduced = 0;
      for (const r0 of t.rows) {
        const row = [...r0];
        const k = up(row[pi]);
        const d = ded.get(k);
        if (!d || d.left <= 1e-9) { rows.push(row); continue; }
        const before = num(row[qi]);
        const take = Math.min(before, d.left); // a pallet listed twice: what is left of its picks comes off the next row
        d.left = r3(d.left - take);
        const left = r3(before - take);
        const out = left <= 0.0005;
        log.push([String(row[pi] ?? ''), String((di >= 0 && row[di]) || row[ii] || ''), li >= 0 ? String(row[li] ?? '') : '', before, r3(take), out ? 0 : left, out ? (dropEmpty ? 'Picked in full — removed' : 'Picked in full') : 'Reduced',
          d.parts.map((x) => `${pickName(x.r.week)}${x.r.pick_no ? ` #${x.r.pick_no}` : ''} · ${x.r.so}/${x.r.li} · ${r3(Number(x.p.qty))}`).join(' | ')]);
        if (out) { removed++; if (dropEmpty) continue; row[qi] = 0; } else { reduced++; row[qi] = left; }
        rows.push(row);
      }
      // picks of pallets this Korber does not have (already gone in the WMS, or another client's file)
      for (const [k, d] of Array.from(ded.entries())) if (d.left > 1e-9 && d.left === d.q) log.push([k, d.parts[0].p.item, d.parts[0].p.lot ?? '', null, r3(d.q), null, 'Not in this Korber file', d.parts.map((x) => `${pickName(x.r.week)}${x.r.pick_no ? ` #${x.r.pick_no}` : ''} · ${x.r.so}/${x.r.li} · ${r3(Number(x.p.qty))}`).join(' | ')]);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([t.header, ...rows]), (t.sheet || 'Korber').slice(0, 31));
      const lh = ['Pallet', 'Item', 'Lot', 'Actual Qty (file)', 'Picked (total)', 'Actual Qty now', 'What', 'Picks (Pick · Pick No · SO/LI · QTY)'];
      const ls = XLSX.utils.aoa_to_sheet([[`Korber Inventory after picks — file ${file.name}, uploaded ${new Date(file.uploaded_at).toLocaleString()} by ${file.uploaded_by}. All saved picks (total pick data) of: ${byPick.filter((g) => on.has(g.rid)).map((g) => pickName(g.rid)).join(', ') || '—'}`], [], lh, ...log]);
      ls['!cols'] = lh.map((h, i) => ({ wch: i === 7 ? 80 : Math.max(12, h.length + 2) }));
      XLSX.utils.book_append_sheet(wb, ls, 'Picked');
      const name = file.name.replace(/\.(xlsx|xlsm|xls|csv)$/i, '') + `_after_picks_${todayLocal()}.xlsx`;
      XLSX.writeFile(wb, name);
      toast(`${name}: ${fmt(reduced)} pallet${reduced === 1 ? '' : 's'} reduced, ${fmt(removed)} picked in full${dropEmpty ? ' (removed)' : ''} — sheet “Picked” lists them`);
      onClose();
    } catch (e) { toast(e instanceof Error ? e.message : 'Could not build the file.'); }
    finally { setBusy(false); }
  };

  return (
    <div className="bal-back" role="dialog" aria-modal="true" aria-labelledby="ka-title" onClick={() => !busy && onClose()}>
      <div className="bal-dlg card ka-dlg" onClick={(e) => e.stopPropagation()}>
        <h3 id="ka-title">Korber Inventory after picks</h3>
        {err ? <div className="notice warn">{err}</div> : !file || !picks ? <p className="muted">Reading the Korber file and the picks…</p> : <>
          <p className="muted small"><b>{file.name}</b> · uploaded {fmtDate(localDay(file.uploaded_at))} {new Date(file.uploaded_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} by {file.uploaded_by}. Each pallet&apos;s Actual Qty is reduced by <b>all the picks</b> (total pick data) of the Picks you tick. Same columns as the file; sheet “Picked” lists every change.</p>
          {!byPick.length ? <div className="notice">No pick saved in the system — the file would be the same.</div> : (
            <div className="ka-picks" role="group" aria-label="Picks to take off">
              {byPick.map((g) => (
                <label key={g.rid} className={on.has(g.rid) ? 'on' : ''}>
                  <input type="checkbox" checked={on.has(g.rid)} onChange={() => setOn((s) => { const n = new Set(s); if (n.has(g.rid)) n.delete(g.rid); else n.add(g.rid); return n; })} />
                  <span><b>{pickName(g.rid)}</b><small>{fmt(g.n)} pick{g.n === 1 ? '' : 's'} · {fmt(g.pallets.size)} pallet{g.pallets.size === 1 ? '' : 's'} · {fmt(g.qty, 2)} QTY</small></span>
                </label>
              ))}
            </div>
          )}
          <label className="ka-opt"><input type="checkbox" checked={dropEmpty} onChange={(e) => setDropEmpty(e.target.checked)} /> Remove pallets picked in full (else they stay with Actual Qty 0)</label>
        </>}
        <div className="bal-acts">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn primary" onClick={() => void build()} disabled={busy || !file || !picks || !!err}>{busy ? 'Building…' : `⬇ Download${chosen.length ? ` (${fmt(chosen.length)} picks off)` : ''}`}</button>
        </div>
      </div>
    </div>
  );
}
