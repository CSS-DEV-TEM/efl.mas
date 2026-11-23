'use client';
/**
 * v214: Korber Inventory − all picks. Choose any Korber Inventory file (it is NOT saved to the system): each pallet's Actual Qty
 * comes down by the complete pick data — every saved pick of every Pick and every day (the pick history), and every
 * "Picked pallets (Korber)" upload (pallets picked outside the system). The file comes back in the same columns; sheet
 * "Picked" lists every pallet changed (before, picked, left, by which Pick / file). Nothing in the system changes.
 * (The Korber card's "⬇ After picks" stays as it was: the kept Korber of one Pick, system picks only.)
 */
import * as React from 'react';
import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import * as XLSX from 'xlsx';
import { api } from '@/lib/api';
import { fmt } from '@/lib/calc';
import { readWorkbook } from '@/lib/mapping';
import { findTable, type PickHistory } from '@/lib/pick';
import { todayLocal } from '@/lib/smart';

const hn = (v: unknown) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const up = (v: unknown) => String(v ?? '').trim().toUpperCase();
const num = (v: unknown) => { const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : 0; };
const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** one QTY taken off a pallet: a system pick, or a row of a picked-pallets upload */
interface Take { pallet: string; item: string; lot: string; qty: number; group: string; label: string }
interface Group { key: string; title: string; sub: string; n: number; qty: number; pallets: Set<string> }
type Grid = unknown[][];

export default function KorberLess({ toast, pickName }: { toast: (m: string) => void; pickName: (rid: string) => string }) {
  const inp = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<{ name: string; sheets: { name: string; grid: Grid }[] } | null>(null);
  const [takes, setTakes] = useState<Take[] | null>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [on, setOn] = useState<Set<string>>(new Set());
  const [dropEmpty, setDropEmpty] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const close = () => { if (!busy) { setFile(null); setTakes(null); setErr(''); } };

  const choose = async (f: File) => {
    setErr(''); setTakes(null); setGroups([]);
    try {
      const sheets = readWorkbook(await f.arrayBuffer());
      if (!findTable(sheets, 'korber')) throw new Error(`${f.name} does not look like a Korber Inventory: no header row with Pallet, Item Number, Actual Qty.`);
      setFile({ name: f.name, sheets });
    } catch (e) { toast(e instanceof Error ? e.message : 'Could not read the file.'); return; }
    try {
      // the complete pick data: every saved pick (every user, every Pick) of every day in the pick history …
      const out: Take[] = [];
      const seen = new Set<number>();
      const first = await api<PickHistory>('/api/pick/history?day=' + todayLocal());
      const days = Array.from(new Set([todayLocal(), ...first.days.map((d) => d.day)]));
      for (const d of days) {
        const h = d === todayLocal() ? first : await api<PickHistory>('/api/pick/history?day=' + d);
        const reqs = new Map(h.requests.filter((r) => !r.cancelled_at).map((r) => [r.id, r]));
        for (const p of h.picks) {
          const r = reqs.get(p.req_id);
          if (!r || p.cancelled_at || seen.has(p.id)) continue;
          seen.add(p.id);
          out.push({ pallet: up(p.pallet), item: p.item, lot: p.lot ?? '', qty: Number(p.qty) || 0, group: 'p:' + r.week, label: `${pickName(r.week)}${r.pick_no ? ` #${r.pick_no}` : ''} · ${r.so}/${r.li}` });
        }
      }
      // … and every picked-pallets upload (picked outside the system)
      const bs = (await api<{ batches: { batch: string; file_name: string; at: string; by_user: string }[] }>('/api/used')).batches;
      for (const b of bs) {
        const rows = (await api<{ rows: { pallet: string; item: string | null; lot: string | null; qty: number }[] }>('/api/used?batch=' + encodeURIComponent(b.batch))).rows;
        for (const x of rows) out.push({ pallet: up(x.pallet), item: x.item ?? '', lot: x.lot ?? '', qty: Number(x.qty) || 0, group: 'u:' + b.batch, label: `Picked outside · ${b.file_name}` });
      }
      const gm = new Map<string, Group>();
      for (const t of out) {
        let g = gm.get(t.group);
        if (!g) {
          const b = bs.find((x) => 'u:' + x.batch === t.group);
          g = { key: t.group, title: b ? `Picked outside · ${b.file_name}` : pickName(t.group.slice(2)), sub: b ? `uploaded ${new Date(b.at).toLocaleDateString()} by ${b.by_user}` : 'system picks', n: 0, qty: 0, pallets: new Set() };
          gm.set(t.group, g);
        }
        g.n++; g.qty += t.qty; g.pallets.add(t.pallet);
      }
      const gs = Array.from(gm.values()).sort((a, b) => (a.key[0] === b.key[0] ? a.key.localeCompare(b.key) : a.key[0] === 'p' ? -1 : 1));
      setTakes(out); setGroups(gs); setOn(new Set(gs.map((g) => g.key)));
    } catch (e) { setErr(e instanceof Error ? e.message : 'Could not read the picks.'); }
  };

  const chosen = (takes || []).filter((t) => on.has(t.group));

  const build = async () => {
    if (!file) return;
    setBusy(true);
    try {
      const t = findTable(file.sheets, 'korber')!;
      const hh = t.header.map(hn);
      const pi = hh.indexOf('pallet'), qi = hh.indexOf('actual qty'), ii = hh.indexOf('item number'), di = hh.indexOf('display item number'), li = hh.indexOf('lot number');
      const ded = new Map<string, { q: number; left: number; parts: Take[] }>();
      for (const x of chosen) { const d = ded.get(x.pallet) || { q: 0, left: 0, parts: [] }; d.q = r3(d.q + x.qty); d.parts.push(x); ded.set(x.pallet, d); }
      for (const d of Array.from(ded.values())) d.left = d.q;
      const partsTxt = (ps: Take[]) => ps.map((x) => `${x.label} · ${r3(x.qty)}`).join(' | ');
      const rows: unknown[][] = [], log: (string | number | null)[][] = [];
      let removed = 0, reduced = 0;
      for (const r0 of t.rows) {
        const row = [...r0];
        const d = ded.get(up(row[pi]));
        if (!d || d.left <= 1e-9) { rows.push(row); continue; }
        const before = num(row[qi]);
        const take = Math.min(before, d.left); // a pallet listed twice: what is left of its picks comes off the next row
        d.left = r3(d.left - take);
        const left = r3(before - take);
        const out = left <= 0.0005;
        log.push([String(row[pi] ?? ''), String((di >= 0 && row[di]) || row[ii] || ''), li >= 0 ? String(row[li] ?? '') : '', before, r3(take), out ? 0 : left,
          out ? (dropEmpty ? 'Picked in full — removed' : 'Picked in full') : 'Reduced', partsTxt(d.parts)]);
        if (out) { removed++; if (dropEmpty) continue; row[qi] = 0; } else { reduced++; row[qi] = left; }
        rows.push(row);
      }
      // more picked than the file has, and pallets this file does not have
      for (const [k, d] of Array.from(ded.entries())) {
        if (d.left <= 1e-9) continue;
        if (d.left === d.q) log.push([k, d.parts[0].item, d.parts[0].lot, null, r3(d.q), null, 'Not in this Korber file', partsTxt(d.parts)]);
        else log.push([k, d.parts[0].item, d.parts[0].lot, null, r3(d.left), null, 'Picked more than the file has (rest not taken off)', partsTxt(d.parts)]);
      }
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([t.header, ...rows]), (t.sheet || 'Korber').slice(0, 31));
      const lh = ['Pallet', 'Item', 'Lot', 'Actual Qty (file)', 'Picked (total)', 'Actual Qty now', 'What', 'Picks (Pick · Pick No · SO/LI · QTY / Picked outside file)'];
      const ls = XLSX.utils.aoa_to_sheet([[`Korber Inventory − all picks — file ${file.name}, made ${new Date().toLocaleString()}. Taken off: ${groups.filter((g) => on.has(g.key)).map((g) => g.title).join(', ') || '—'}`], [], lh, ...log]);
      ls['!cols'] = lh.map((h, i) => ({ wch: i === 7 ? 90 : Math.max(12, h.length + 2) }));
      XLSX.utils.book_append_sheet(wb, ls, 'Picked');
      const name = file.name.replace(/\.(xlsx|xlsm|xls|csv)$/i, '') + `_less_all_picks_${todayLocal()}.xlsx`;
      XLSX.writeFile(wb, name);
      toast(`${name}: ${fmt(reduced)} pallet${reduced === 1 ? '' : 's'} reduced, ${fmt(removed)} picked in full${dropEmpty ? ' (removed)' : ''} — sheet “Picked” lists them`);
      setFile(null); setTakes(null);
    } catch (e) { toast(e instanceof Error ? e.message : 'Could not build the file.'); }
    finally { setBusy(false); }
  };

  return (
    <section className="card used-card" aria-labelledby="kl-title">
      <div className="table-head">
        <div>
          <h2 id="kl-title">Korber Inventory − all picks</h2>
          <p className="muted small" style={{ margin: 0 }}>Choose a Korber Inventory file: each pallet&apos;s Actual Qty comes down by <b>the complete pick data</b> — every pick saved in the system (all Picks, all days) and every “Picked pallets (Korber)” upload. You get the file back (same columns) with a “Picked” sheet. The file is <b>not saved</b> and nothing in the system changes.</p>
        </div>
        <button className="btn primary" onClick={() => inp.current?.click()}>⬇ Korber − all picks</button>
        <input ref={inp} type="file" hidden accept=".xlsx,.xls,.xlsm,.csv" onChange={(e) => { const f = e.target.files?.[0]; if (f) void choose(f); e.target.value = ''; }} />
      </div>
      {file && typeof document !== 'undefined' && createPortal(
        <div className="bal-back" role="dialog" aria-modal="true" aria-labelledby="kl-dlg" onClick={close}>
          <div className="bal-dlg card ka-dlg kl-dlg" onClick={(e) => e.stopPropagation()}>
            <h3 id="kl-dlg">Korber Inventory − all picks</h3>
            {err ? <div className="notice warn">{err}</div> : !takes ? <p className="muted">Reading the complete pick data…</p> : <>
              <p className="muted small"><b>{file.name}</b> · each pallet&apos;s Actual Qty is reduced by everything ticked below (all ticked = the complete pick data). Same columns as the file; sheet “Picked” lists every change.</p>
              {!groups.length ? <div className="notice">No pick saved in the system and no picked-pallets upload — the file would be the same.</div> : (
                <div className="ka-picks" role="group" aria-label="Picks to take off">
                  {groups.map((g) => (
                    <label key={g.key} className={on.has(g.key) ? 'on' : ''}>
                      <input type="checkbox" checked={on.has(g.key)} onChange={() => setOn((s) => { const n = new Set(s); if (n.has(g.key)) n.delete(g.key); else n.add(g.key); return n; })} />
                      <span><b>{g.title}</b><small>{g.sub} · {fmt(g.n)} row{g.n === 1 ? '' : 's'} · {fmt(g.pallets.size)} pallet{g.pallets.size === 1 ? '' : 's'} · {fmt(g.qty, 2)} QTY</small></span>
                    </label>
                  ))}
                </div>
              )}
              <label className="ka-opt"><input type="checkbox" checked={dropEmpty} onChange={(e) => setDropEmpty(e.target.checked)} /> Remove pallets picked in full (else they stay with Actual Qty 0)</label>
            </>}
            <div className="bal-acts">
              <button type="button" className="btn" onClick={close} disabled={busy}>Cancel</button>
              <button type="button" className="btn primary" onClick={() => void build()} disabled={busy || !takes || !!err}>{busy ? 'Building…' : `⬇ Download${chosen.length ? ` (${fmt(chosen.length)} picks off)` : ''}`}</button>
            </div>
          </div>
        </div>, document.body)}
    </section>
  );
}
