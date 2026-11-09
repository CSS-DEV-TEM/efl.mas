'use client';
import * as XLSX from 'xlsx';
import * as XLSXS from 'xlsx-js-style';

/**
 * v171: Inventory reconciliation — SAP stock (Plant + St Location + Material) against the Korber Inventory (Plant + item),
 * worked out in the browser (nothing goes into the database). Unic = Plant-Location-Material, like the INV workbook:
 *   SAP    C065-0042-W1000272692  → the W of a WOM material is dropped → C065-0042-1000272692
 *   Korber Plant "C065-0042" + Display Item Number 1000272692        → C065-0042-1000272692
 * PFC / KFC: Korber by Client Code (MASKTR = PFC, MASKRE = KFC); SAP by storage location (0041 and C050 / C068 OFST, OMET,
 * XLLT = PFC; everything else, 0042 / 0044 / 0200 / 0202 / 0203 / 0204 / EXRF … = KFC). SAP rows exported twice (the very same
 * row) count once — they are listed on their own sheet.
 */

export type Side = 'PFC' | 'KFC';
export type Status = 'Match' | 'Korber more' | 'SAP more' | 'SAP only' | 'Korber only';
export interface ReconRow {
  side: Side; unic: string; loc: string; material: string; desc: string; uom: string;
  sap: number; ur: number; qi: number; block: number; sapRows: number; sapMats: string;
  korber: number; rolls: number; variance: number; status: Status;
}
export interface ReconResult {
  at: string; files: { sap: string[]; korber: string[] };
  sapRows: number; sapDup: number; korberRows: number;
  rows: ReconRow[]; dups: (string | number | null)[][]; dupHead: string[];
  unknown: { korberClients: string[] };
}
export interface Parsed { sap: Row[]; sapHead: string[]; korber: Row[]; korberHead: string[]; sapFiles: string[]; korberFiles: string[] }
type Row = (string | number | null)[];

const H = (v: unknown) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const num = (v: unknown) => { const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : 0; };
const txt = (v: unknown) => String(v ?? '').trim();
export const r3 = (x: number) => Math.round(x * 1000) / 1000;
/** a SAP WOM material (W1000272692) is the same material as in Korber (1000272692) */
export const sapMat = (m: unknown) => txt(m).replace(/^W(?=\d)/i, '');
const PFC_LOCS = new Set(['0041', 'OFST', 'OMET', 'XLLT']);
export const sapSide = (sloc: unknown): Side => (PFC_LOCS.has(txt(sloc).toUpperCase()) ? 'PFC' : 'KFC');
export const korberSide = (client: unknown): Side | null => { const c = txt(client).toUpperCase(); return c === 'MASKTR' ? 'PFC' : c === 'MASKRE' ? 'KFC' : null; };

const SAP_NEED = ['plant', 'stlocation', 'material', 'totalstock'];
const KOR_NEED = ['pallet', 'actualqty', 'clientcode', 'plant'];
const isSap = (h: string[]) => SAP_NEED.every((x) => h.includes(x));
const isKorber = (h: string[]) => KOR_NEED.every((x) => h.includes(x)) && (h.includes('displayitemnumber') || h.includes('itemnumber'));

/** reads SAP and Korber sheets from any of the files (one workbook with both sheets, or a file each) */
export async function readFiles(files: File[], onStep?: (s: string) => void): Promise<Parsed> {
  const out: Parsed = { sap: [], sapHead: [], korber: [], korberHead: [], sapFiles: [], korberFiles: [] };
  for (const f of files) {
    onStep?.(`Reading ${f.name}…`);
    const wb = XLSX.read(await f.arrayBuffer(), { type: 'array', cellFormula: false, cellHTML: false, cellText: false, dense: true });
    for (const name of wb.SheetNames) {
      const rows = XLSX.utils.sheet_to_json<Row>(wb.Sheets[name], { header: 1, raw: true, defval: null, blankrows: false });
      // the header row: the first of the top 10 that names the report's columns
      let hi = -1; let kind: 'sap' | 'korber' | null = null;
      for (let i = 0; i < Math.min(10, rows.length); i++) { const h = (rows[i] || []).map(H); if (isSap(h)) { hi = i; kind = 'sap'; break; } if (isKorber(h)) { hi = i; kind = 'korber'; break; } }
      if (!kind) continue;
      const head = (rows[hi] || []).map((x) => txt(x));
      const body = rows.slice(hi + 1).filter((r) => r && r.some((v) => v !== null && v !== ''));
      if (kind === 'sap') {
        if (out.sapHead.length && out.sapHead.join('|') !== head.join('|')) body.forEach((r, i) => { body[i] = alignTo(head, out.sapHead, r); });
        else if (!out.sapHead.length) out.sapHead = head;
        out.sap.push(...body); out.sapFiles.push(`${f.name} · ${name}`);
      } else {
        if (out.korberHead.length && out.korberHead.join('|') !== head.join('|')) body.forEach((r, i) => { body[i] = alignTo(head, out.korberHead, r); });
        else if (!out.korberHead.length) out.korberHead = head;
        out.korber.push(...body); out.korberFiles.push(`${f.name} · ${name}`);
      }
    }
  }
  return out;
}
/** a row of a file with other column order, in the first file's columns */
function alignTo(from: string[], to: string[], r: Row): Row { const ix = to.map((h) => from.findIndex((x) => H(x) === H(h))); return ix.map((i) => (i >= 0 ? r[i] ?? null : null)); }

export function reconcile(p: Parsed): ReconResult {
  const sh = p.sapHead.map(H), kh = p.korberHead.map(H);
  const si = (n: string) => sh.indexOf(n), ki = (n: string) => kh.indexOf(n);
  const S = { plant: si('plant'), sloc: si('stlocation'), mat: si('material'), desc: si('materialdescription'), uom: si('uom'), total: si('totalstock'),
    ur: si('salesorderurstock'), urb: si('urstockbatch'), qi: si('soqistock'), qib: si('qistock'), bl: si('soblockedstockstock'), blb: si('blockedstockbatch'), unic: si('unic') };
  const K = { plant: ki('plant'), item: ki('displayitemnumber'), itemNo: ki('itemnumber'), desc: ki('description'), qty: ki('actualqty'), client: ki('clientcode'), uom: ki('uom'), pallet: ki('pallet'), unic: ki('unic') };
  const g = (r: Row, i: number) => (i >= 0 ? r[i] : null);
  // SAP: the very same row twice = one row (the Unic column is a formula — not part of the row)
  const seen = new Set<string>(); const dups: Row[] = [];
  const sapKeep: Row[] = [];
  for (const r of p.sap) {
    const k = JSON.stringify(r.filter((_, i) => i !== S.unic));
    if (seen.has(k)) { dups.push(r); continue; }
    seen.add(k); sapKeep.push(r);
  }
  const map = new Map<string, ReconRow>();
  const at = (side: Side, unic: string, loc: string, material: string) => {
    const key = `${side}|${unic}`;
    let x = map.get(key);
    if (!x) { x = { side, unic, loc, material, desc: '', uom: '', sap: 0, ur: 0, qi: 0, block: 0, sapRows: 0, sapMats: '', korber: 0, rolls: 0, variance: 0, status: 'Match' }; map.set(key, x); }
    return x;
  };
  const sapMatsOf = new Map<string, Set<string>>();
  for (const r of sapKeep) {
    const plant = txt(g(r, S.plant)).toUpperCase(), sloc = txt(g(r, S.sloc)).toUpperCase(), raw = txt(g(r, S.mat)), m = sapMat(raw);
    if (!plant && !m) continue;
    const loc = `${plant}-${sloc}`, unic = `${loc}-${m}`;
    const x = at(sapSide(sloc), unic, loc, m);
    x.sap += num(g(r, S.total)); x.ur += num(g(r, S.ur)) + num(g(r, S.urb)); x.qi += num(g(r, S.qi)) + num(g(r, S.qib)); x.block += num(g(r, S.bl)) + num(g(r, S.blb)); x.sapRows++;
    if (!x.desc) x.desc = txt(g(r, S.desc)); if (!x.uom) x.uom = txt(g(r, S.uom));
    const ms = sapMatsOf.get(x.side + '|' + unic) ?? new Set<string>(); ms.add(raw); sapMatsOf.set(x.side + '|' + unic, ms);
  }
  const unknownClients = new Set<string>();
  for (const r of p.korber) {
    let side = korberSide(g(r, K.client));
    const loc = txt(g(r, K.plant)).toUpperCase();
    if (!side) { unknownClients.add(txt(g(r, K.client)) || '(blank)'); side = /-(0041|OFST|OMET|XLLT)$/.test(loc) ? 'PFC' : 'KFC'; }
    let m = txt(g(r, K.item));
    if (!m) m = txt(g(r, K.itemNo)).replace(/^[A-Z]+-/i, '');
    if (!loc && !m) continue;
    const unic = `${loc}-${m}`;
    const x = at(side, unic, loc, m);
    x.korber += num(g(r, K.qty)); x.rolls++;
    if (!x.desc) x.desc = txt(g(r, K.desc)); if (!x.uom) x.uom = txt(g(r, K.uom));
  }
  const rows = Array.from(map.values()).map((x) => {
    x.sap = r3(x.sap); x.ur = r3(x.ur); x.qi = r3(x.qi); x.block = r3(x.block); x.korber = r3(x.korber);
    x.variance = r3(x.korber - x.sap);
    x.sapMats = Array.from(sapMatsOf.get(x.side + '|' + x.unic) ?? []).filter((m) => m !== x.material).join(', ');
    x.status = !x.sapRows ? 'Korber only' : !x.rolls ? 'SAP only' : Math.abs(x.variance) < 0.0005 ? 'Match' : x.variance > 0 ? 'Korber more' : 'SAP more';
    return x;
  }).sort((a, b) => a.side.localeCompare(b.side) || a.loc.localeCompare(b.loc) || Math.abs(b.variance) - Math.abs(a.variance) || a.unic.localeCompare(b.unic));
  return { at: new Date().toISOString(), files: { sap: p.sapFiles, korber: p.korberFiles }, sapRows: p.sap.length, sapDup: dups.length, korberRows: p.korber.length,
    rows, dups, dupHead: p.sapHead, unknown: { korberClients: Array.from(unknownClients) } };
}

export interface SideSum { unic: number; sap: number; korber: number; variance: number; abs: number; byStatus: Record<Status, number> }
export const STATUSES: Status[] = ['Match', 'Korber more', 'SAP more', 'SAP only', 'Korber only'];
export function summary(rows: ReconRow[]): SideSum {
  const s: SideSum = { unic: rows.length, sap: 0, korber: 0, variance: 0, abs: 0, byStatus: { Match: 0, 'Korber more': 0, 'SAP more': 0, 'SAP only': 0, 'Korber only': 0 } };
  for (const r of rows) { s.sap += r.sap; s.korber += r.korber; s.variance += r.variance; s.abs += Math.abs(r.variance); s.byStatus[r.status]++; }
  s.sap = r3(s.sap); s.korber = r3(s.korber); s.variance = r3(s.variance); s.abs = r3(s.abs);
  return s;
}
export function byLocation(rows: ReconRow[]) {
  const m = new Map<string, { side: Side; loc: string; rows: ReconRow[] }>();
  for (const r of rows) { const k = `${r.side}|${r.loc}`; const x = m.get(k) ?? { side: r.side, loc: r.loc, rows: [] }; x.rows.push(r); m.set(k, x); }
  return Array.from(m.values()).map((x) => ({ side: x.side, loc: x.loc, ...summary(x.rows) })).sort((a, b) => a.side.localeCompare(b.side) || a.loc.localeCompare(b.loc));
}

// ---------------------------------------------------------------- the Excel report
const C = { head: '1F2937', headTx: 'FFFFFF', top: 'C2410C', match: 'E7F5EC', more: 'FFF4D6', less: 'FDE4E1', only: 'EEF2F7', line: 'D9DEE5' };
const border = { top: { style: 'thin', color: { rgb: C.line } }, bottom: { style: 'thin', color: { rgb: C.line } }, left: { style: 'thin', color: { rgb: C.line } }, right: { style: 'thin', color: { rgb: C.line } } };
const ST = {
  title: { font: { bold: true, sz: 14, color: { rgb: C.top } } },
  sub: { font: { italic: true, sz: 9, color: { rgb: '6B7280' } } },
  head: { font: { bold: true, color: { rgb: C.headTx } }, fill: { fgColor: { rgb: C.head } }, alignment: { vertical: 'center', wrapText: true }, border },
  cell: { border },
  num: { border, numFmt: '#,##0.000' },
  bold: { font: { bold: true }, border, numFmt: '#,##0.000' },
};
const fillOf = (s: Status) => (s === 'Match' ? C.match : s === 'Korber more' ? C.more : s === 'SAP more' ? C.less : C.only);
type Cell = string | number | null;

function sheet(title: string, sub: string, head: string[], body: Cell[][], numCols: number[], widths: number[], statusCol = -1, totals?: Cell[]) {
  const aoa: Cell[][] = [[title], [sub], [], head, ...body, ...(totals ? [totals] : [])];
  const ws = XLSXS.utils.aoa_to_sheet(aoa);
  const set = (r: number, c: number, s: object) => { const a = XLSXS.utils.encode_cell({ r, c }); if (!ws[a]) ws[a] = { t: 's', v: '' }; (ws[a] as { s?: object }).s = s; };
  set(0, 0, ST.title); set(1, 0, ST.sub);
  head.forEach((_, c) => set(3, c, ST.head));
  for (let r = 0; r < body.length; r++) {
    const st = statusCol >= 0 ? (body[r][statusCol] as Status) : null;
    head.forEach((_, c) => {
      const base = numCols.includes(c) ? ST.num : ST.cell;
      set(4 + r, c, st && c === statusCol ? { ...base, fill: { fgColor: { rgb: fillOf(st) } }, font: { bold: true } } : base);
    });
  }
  if (totals) head.forEach((_, c) => set(4 + body.length, c, { ...ST.bold, fill: { fgColor: { rgb: 'F3F4F6' } } }));
  ws['!cols'] = widths.map((w) => ({ wch: w }));
  ws['!freeze'] = { xSplit: 0, ySplit: 4 } as never;
  (ws as { '!views'?: unknown })['!views'] = [{ state: 'frozen', ySplit: 4 }];
  if (body.length) ws['!autofilter'] = { ref: XLSXS.utils.encode_range({ s: { r: 3, c: 0 }, e: { r: 3 + body.length, c: head.length - 1 } }) };
  return ws;
}

const RECON_HEAD = ['Unic', 'Plant-Location', 'Material', 'Description', 'UOM', 'SAP Total stock', 'SAP UR', 'SAP QI', 'SAP Block', 'Korber Actual Qty', 'Korber Rolls', 'Variance (Korber − SAP)', 'Status', 'SAP rows', 'SAP Material (as in SAP)'];
const reconBody = (rows: ReconRow[]): Cell[][] => rows.map((r) => [r.unic, r.loc, r.material, r.desc, r.uom, r.sap, r.ur, r.qi, r.block, r.korber, r.rolls, r.variance, r.status, r.sapRows, r.sapMats || null]);

export function reportWorkbook(res: ReconResult, label: string) {
  const wb = XLSXS.utils.book_new();
  const when = new Date(res.at).toLocaleString();
  const pfc = res.rows.filter((r) => r.side === 'PFC'), kfc = res.rows.filter((r) => r.side === 'KFC');
  const sums = { PFC: summary(pfc), KFC: summary(kfc) };
  // Summary
  const sHead = ['', 'Unic', 'SAP Total stock', 'Korber Actual Qty', 'Variance (Korber − SAP)', '|Variance|', ...STATUSES];
  const sBody: Cell[][] = (['KFC', 'PFC'] as Side[]).map((s) => [s, sums[s].unic, sums[s].sap, sums[s].korber, sums[s].variance, sums[s].abs, ...STATUSES.map((x) => sums[s].byStatus[x])]);
  const all = summary(res.rows);
  const sTot: Cell[] = ['Total', all.unic, all.sap, all.korber, all.variance, all.abs, ...STATUSES.map((x) => all.byStatus[x])];
  const sub = `${label} · ${when} · SAP ${res.sapRows.toLocaleString()} rows (${res.sapDup.toLocaleString()} duplicate rows counted once) · Korber ${res.korberRows.toLocaleString()} rolls`;
  const ws0 = sheet('INVENTORY RECONCILIATION — SAP vs KORBER', sub, sHead, sBody, [2, 3, 4, 5], [10, 9, 16, 16, 18, 14, 9, 12, 10, 10, 12], -1, sTot);
  // per location under it
  const loc = byLocation(res.rows);
  const start = 4 + sBody.length + 3;
  const lHead = ['PFC / KFC', 'Plant-Location', 'Unic', 'SAP Total stock', 'Korber Actual Qty', 'Variance (Korber − SAP)', ...STATUSES];
  XLSXS.utils.sheet_add_aoa(ws0, [['By location'], lHead, ...loc.map((x) => [x.side, x.loc, x.unic, x.sap, x.korber, x.variance, ...STATUSES.map((st) => x.byStatus[st])])], { origin: { r: start, c: 0 } });
  const set0 = (r: number, c: number, s: object) => { const a = XLSXS.utils.encode_cell({ r, c }); if (ws0[a]) (ws0[a] as { s?: object }).s = s; };
  set0(start, 0, { font: { bold: true, sz: 12 } });
  lHead.forEach((_, c) => set0(start + 1, c, ST.head));
  loc.forEach((_, i) => lHead.forEach((__, c) => set0(start + 2 + i, c, [3, 4, 5].includes(c) ? ST.num : ST.cell)));
  XLSXS.utils.book_append_sheet(wb, ws0, 'Summary');
  const tot = (rows: ReconRow[]): Cell[] => { const s = summary(rows); return ['Total', null, null, null, null, s.sap, r3(rows.reduce((t, r) => t + r.ur, 0)), r3(rows.reduce((t, r) => t + r.qi, 0)), r3(rows.reduce((t, r) => t + r.block, 0)), s.korber, rows.reduce((t, r) => t + r.rolls, 0), s.variance, `${s.byStatus.Match} match`, rows.reduce((t, r) => t + r.sapRows, 0), null]; };
  const widths = [26, 14, 13, 40, 6, 15, 12, 10, 10, 15, 8, 17, 12, 8, 18];
  XLSXS.utils.book_append_sheet(wb, sheet('KFC RECONCILIATION', `${sub} · KFC: Korber client MASKRE · SAP 0042 / 0044 / 0200 / 0202 / 0203 / 0204 / EXRF`, RECON_HEAD, reconBody(kfc), [5, 6, 7, 8, 9, 11], widths, 12, tot(kfc)), 'KFC Reconciliation');
  XLSXS.utils.book_append_sheet(wb, sheet('PFC RECONCILIATION', `${sub} · PFC: Korber client MASKTR · SAP 0041 / OFST / OMET / XLLT`, RECON_HEAD, reconBody(pfc), [5, 6, 7, 8, 9, 11], widths, 12, tot(pfc)), 'PFC Reconciliation');
  // Variation — the INV workbook's own sheet: Unic, SAP, HJ, V
  XLSXS.utils.book_append_sheet(wb, sheet('VARIATION', sub, ['Unic', 'PFC / KFC', 'SAP', 'HJ', 'V'], res.rows.map((r) => [r.unic, r.side, r.sap, r.korber, r.variance]), [2, 3, 4], [26, 9, 15, 15, 15]), 'Variation');
  if (res.dups.length) {
    // the key columns only (the whole SAP row would make the file several times bigger)
    const keep = ['Plant', 'St Location', 'Material', 'SO', 'LI', 'Batch', 'Material Description', 'UOM', 'Total stock'].map((h) => res.dupHead.findIndex((x) => H(x) === H(h)));
    const head = keep.map((i) => (i >= 0 ? res.dupHead[i] : ''));
    XLSXS.utils.book_append_sheet(wb, sheet(`SAP ROWS EXPORTED TWICE — COUNTED ONCE`, `${res.dups.length.toLocaleString()} rows: the very same SAP row a second time`, head,
      res.dups.map((r) => keep.map((i) => (i >= 0 ? (r[i] as Cell) ?? null : null))), [8], [8, 10, 13, 12, 6, 12, 40, 6, 14]), 'SAP duplicates');
  }
  return wb;
}
export function reportBytes(wb: XLSX.WorkBook): Uint8Array { return new Uint8Array(XLSXS.write(wb, { type: 'array', bookType: 'xlsx', compression: true }) as ArrayBuffer); }
