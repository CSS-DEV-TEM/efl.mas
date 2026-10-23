'use client';
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Loader } from '@/components/Loader';
import { api } from '@/lib/api';
import { fmt, fmtDate, fmtQty } from '@/lib/calc';

export interface PlanReportRow {
  unic: string; so: string; li: string; item: string; date: string | null; pick_date: string | null; qty: number; avail: number; sent: number; pending: number; possible: number | null;
  qi: number; block: number; tn: string | null; tn_qty: number | null; tn_status: string | null; wh: number; wh_ur: number; picked: number; /** QTY − ALRADY SEND − picks after the ZMMBE upload */ left?: number; rolls: number; key: string; plant: string | null; remarks: string | null;
}
export interface PlanReportRes {
  rid: string; name: string; day: string; plant: string | null; week?: boolean; plants?: string[]; hasZmmbe: boolean; hasSent: boolean; hasTrr: boolean; rows: PlanReportRow[];
  totals: { lines: number; qty: number; avail: number; sent: number; pending: number; possible: number; possibleLines: number; qi: number; block: number; tnLines: number; picked: number };
}
type View = 'all' | 'pending' | 'possible' | 'tn' | 'qiblock';

/** The Pick's plan report as an Excel file — the same sheet and columns as the "ASIALLINE-23" workbook. */
export async function downloadPlanReport(r: PlanReportRes) {
  const XLSX = await import('xlsx-js-style');
  const head = ['UNIC', 'SO', 'LI', 'ITEM CODE', 'DATE', 'QTY', 'AVALABALE', 'ALRADY SEND', 'Pending', 'POSIBAL PENDING', 'QI', 'BLOCK', 'TRANSFER NOTE', 'PICKED (system)', 'BALANCE (system)'];
  const num = (v: string) => (/^\d{1,15}$/.test(v) ? Number(v) : v);
  // an Excel date serial (no time zone shift: a JS Date would land on the previous day in UTC+5:30)
  const xd = (d: string | null) => (d ? Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 86400000 + 25569 : '');
  const body = r.rows.map((x) => [x.unic, x.so, num(String(x.li)), num(String(x.item)), xd(x.date), x.qty, x.avail, x.sent, x.pending, x.possible ?? '', x.qi, x.block, x.tn ?? '#N/A', x.picked || '', x.left ?? '']);
  const ws = XLSX.utils.aoa_to_sheet([head, ...body]);
  const hs = { font: { bold: true, color: { rgb: 'FFFFFF' } }, fill: { fgColor: { rgb: '1F3A5F' } }, alignment: { horizontal: 'center', vertical: 'center', wrapText: true } };
  head.forEach((_, i) => { const a = XLSX.utils.encode_cell({ r: 0, c: i }); if (ws[a]) ws[a].s = hs; });
  // POSIBAL PENDING rows stand out (as in the workbook, the lines the warehouse can send now)
  r.rows.forEach((x, i) => {
    for (let c = 0; c < head.length; c++) {
      const a = XLSX.utils.encode_cell({ r: i + 1, c });
      if (!ws[a]) continue;
      if (c === 4 && typeof ws[a].v === 'number') { ws[a].z = 'dd/mm/yyyy'; ws[a].t = 'n'; }
      if (c >= 5 && c <= 11 && typeof ws[a].v === 'number') ws[a].z = '#,##0.000';
      if (x.possible) ws[a].s = { fill: { fgColor: { rgb: 'FFF2CC' } } };
    }
  });
  ws['!cols'] = [26, 13, 6, 12, 11, 11, 12, 12, 11, 15, 9, 9, 15, 13, 14].map((w) => ({ wch: w }));
  ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: r.rows.length, c: head.length - 1 } }) };
  ws['!freeze'] = { xSplit: 0, ySplit: 1 };
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, r.name.slice(0, 31));
  // the lines the warehouse can send now
  const pp = r.rows.filter((x) => x.possible);
  const ws2 = XLSX.utils.aoa_to_sheet([['SO', 'LI', 'ITEM CODE', 'DATE', 'QTY', 'ALRADY SEND', 'POSIBAL PENDING', 'Warehouse UR', 'PICKED (system)', 'TRANSFER NOTE'],
    ...pp.map((x) => [x.so, num(String(x.li)), num(String(x.item)), xd(x.date), x.qty, x.sent, x.possible ?? 0, x.wh, x.picked || '', x.tn ?? ''])]);
  for (let i = 0; i < 10; i++) { const a = XLSX.utils.encode_cell({ r: 0, c: i }); if (ws2[a]) ws2[a].s = hs; }
  pp.forEach((_, i) => { const a = XLSX.utils.encode_cell({ r: i + 1, c: 3 }); if (ws2[a] && typeof ws2[a].v === 'number') ws2[a].z = 'dd/mm/yyyy'; });
  ws2['!cols'] = [13, 6, 12, 11, 11, 12, 15, 13, 13, 15].map((w) => ({ wch: w }));
  XLSX.utils.book_append_sheet(wb, ws2, 'POSIBAL PENDING');
  XLSX.writeFile(wb, `${r.name}.xlsx`, { cellStyles: true });
}

/** The plan report of a Pick ("ASIALLINE-23"), every column from the Pick's reports — on screen and as Excel. */
export default function PlanReport({ rid, onClose }: { rid: string; onClose: () => void }) {
  const [r, setR] = useState<PlanReportRes | null>(null);
  const [err, setErr] = useState('');
  const [view, setView] = useState<View>('all');
  const [q, setQ] = useState('');
  // a week plan: all its plants, or one (the workbook is one plant: ASIALLINE-W43)
  const [plant, setPlant] = useState('');
  useEffect(() => { setR(null); api<PlanReportRes>('/api/plan-report?rid=' + encodeURIComponent(rid) + (plant ? '&plant=' + encodeURIComponent(plant) : '')).then(setR).catch((e) => setErr(e instanceof Error ? e.message : 'Could not load.')); }, [rid, plant]);
  const [plants, setPlants] = useState<string[]>([]);
  useEffect(() => { if (r?.plants?.length) setPlants(r.plants); }, [r]);
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onClose]);
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (r?.rows || []).filter((x) => (view === 'pending' ? x.pending > 1e-4 : view === 'possible' ? !!x.possible : view === 'tn' ? !!x.tn : view === 'qiblock' ? x.qi + x.block > 1e-9 : true)
      && (!s || [x.so, x.li, x.item, x.tn].join(' ').toLowerCase().includes(s)));
  }, [r, view, q]);
  const t = r?.totals;
  return createPortal(
    <div className="modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal plan-report" role="dialog" aria-modal="true" aria-labelledby="prr-title">
        <div className="modal-head">
          <div>
            <h2 id="prr-title">{r ? r.name : 'Plan report'} {r && <span className="muted small" style={{ fontWeight: 400 }}>· {fmtDate(r.day)}</span>}</h2>
            <p className="sub" style={{ margin: 0 }}>From this Pick&apos;s reports: AVALABALE = SO UR stock in ZMMBE (every storage location) · ALRADY SEND = the same at the plant storage locations · Pending = QTY − ALRADY SEND · POSIBAL PENDING = Pending the warehouse has UR for · QI / BLOCK = SO QI / SO Blocked · TRANSFER NOTE = ZMM_TRR.</p>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn primary" disabled={!r} onClick={() => r && void downloadPlanReport(r)}>⤓ Excel</button>
            <button className="btn" onClick={onClose} aria-label="Close">✕</button>
          </div>
        </div>
        {plants.length > 1 && (
          <div className="seg" role="group" aria-label="Plant" style={{ marginBottom: 6, flexWrap: 'wrap' }}>
            <button className={!plant ? 'on' : ''} onClick={() => setPlant('')}>All plants</button>
            {plants.map((p) => <button key={p} className={plant === p ? 'on' : ''} onClick={() => setPlant(p)}>{p}</button>)}
          </div>
        )}
        {err && <div className="notice bad">{err}</div>}
        {!r && !err && <Loader label="Building the plan report…" />}
        {r && t && (
          <>
            {(!r.hasZmmbe || !r.hasSent || !r.hasTrr) && <div className="notice warn small">{[!r.hasZmmbe && 'No ZMMBE for this Pick — AVALABALE, QI and BLOCK are 0.', r.hasZmmbe && !r.hasSent && 'This ZMMBE has no plant storage location rows (or was uploaded before this version) — ALRADY SEND is 0: upload the ZMMBE again.', !r.hasTrr && 'No ZMM_TRR for this Pick — TRANSFER NOTE is empty.'].filter(Boolean).join(' ')}</div>}
            <div className="pk-stats" style={{ margin: '8px 0' }}>
              <div><span>Lines</span><b>{fmt(t.lines)}</b><small>QTY {fmtQty(t.qty)}</small></div>
              <div><span>Avalabale</span><b>{fmtQty(t.avail)}</b></div>
              <div><span>Alrady send</span><b>{fmtQty(t.sent)}</b></div>
              <div><span>Pending</span><b>{fmtQty(t.pending)}</b></div>
              <div className="em"><span>Posibal pending</span><b>{fmtQty(t.possible)}</b><small>{fmt(t.possibleLines)} lines can be sent now</small></div>
              <div><span>QI / Block</span><b>{fmtQty(t.qi)}</b><small>Block {fmtQty(t.block)}</small></div>
              <div><span>Transfer notes</span><b>{fmt(t.tnLines)}</b><small>lines</small></div>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 6 }}>
              <div className="seg" role="group" aria-label="Show">
                {([['all', 'All', t.lines], ['pending', 'Pending', r.rows.filter((x) => x.pending > 1e-4).length], ['possible', 'Posibal pending', t.possibleLines], ['tn', 'With TN', t.tnLines], ['qiblock', 'QI / Block', r.rows.filter((x) => x.qi + x.block > 1e-9).length]] as [View, string, number][])
                  .map(([k, label, n]) => <button key={k} className={view === k ? 'on' : ''} onClick={() => setView(k)}>{label} ({fmt(n)})</button>)}
              </div>
              <input type="search" className="as-search" placeholder="SO, item, TN…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search the report" />
            </div>
            <div className="table-wrap" style={{ maxHeight: '60vh' }}>
              <table className="mini plan-report-table" data-noexport>
                <thead><tr><th>UNIC</th><th>SO</th><th>LI</th><th>ITEM CODE</th><th>DATE</th><th className="n">QTY</th><th className="n">AVALABALE</th><th className="n">ALRADY SEND</th><th className="n">Pending</th><th className="n">POSIBAL PENDING</th><th className="n">QI</th><th className="n">BLOCK</th><th>TRANSFER NOTE</th><th className="n">Picked</th><th className="n" title="QTY − ALRADY SEND − the picks the ZMMBE does not show yet">Balance</th></tr></thead>
                <tbody>{list.map((x) => (
                  <tr key={x.unic + x.date} className={x.possible ? 'pr-possible' : ''}>
                    <td className="mono small">{x.unic}</td><td>{x.so}</td><td>{x.li}</td><td>{x.item}</td><td>{fmtDate(x.date)}</td>
                    <td className="n">{fmtQty(x.qty)}</td><td className="n">{fmtQty(x.avail)}</td><td className="n">{fmtQty(x.sent)}</td>
                    <td className={`n ${x.pending < -1e-4 ? 'muted' : ''}`}>{fmtQty(x.pending)}</td>
                    <td className="n">{x.possible ? <b>{fmtQty(x.possible)}</b> : ''}</td>
                    <td className="n">{x.qi ? fmtQty(x.qi) : '0'}</td><td className="n">{x.block ? fmtQty(x.block) : '0'}</td>
                    <td>{x.tn ? <span title={`${x.tn_qty ?? ''} · status ${x.tn_status ?? ''}`}>{x.tn}</span> : <span className="muted">#N/A</span>}</td>
                    <td className="n">{x.picked ? fmtQty(x.picked) : ''}</td><td className="n">{x.left != null ? fmtQty(x.left) : ''}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
