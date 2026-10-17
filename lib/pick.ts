/** Picking: types, file reading for the three pick reports, and the Packing List workbook. */
import * as XLSX from 'xlsx';
import * as XLSXS from 'xlsx-js-style';
import { api } from './api';
import { readWorkbook, type Grid } from './mapping';

export type PickSrc = 'zinr' | 'zcoment' | 'korber';
export const PICK_SRCS: { src: PickSrc; title: string; hint: string; needs: string[] }[] = [
  { src: 'zinr', title: 'ZINR', hint: 'Inspection lots: Sales Order, Line Item, Material, Batch, Insp. Lot Quantity, Vendor Invoice No', needs: ['inspection lot', 'insp lot quantity'] },
  { src: 'zcoment', title: 'ZCOMENT VIEW', hint: 'Only the "Shade Report" rows are kept: one per roll (Roll qty, Vendor Roll No, Barcode, Shade)', needs: ['inspection lot', 'roll qty'] },
  { src: 'korber', title: 'Korber Inventory', hint: 'Only rolls of items in the plan are uploaded: Pallet, Item Number, Lot Number, Actual Qty, Supplier Hu', needs: ['pallet', 'item number', 'actual qty'] },
];

export interface Candidate {
  pallet: string; item: string; lot: string | null; supplier_hu: string | null; location: string | null; uom: string | null; invoice: string | null;
  actual_qty: number; base_qty: number; picked_before: number; available: number; roll_qty: number; shade: string | null;
  insp_lots: string[]; batches: string[]; checks: Record<string, boolean | null>; warnings: string[]; needsConfirm: boolean;
  picks: { day: string; by_user: string; qty: number }[];
}
export interface LotInfo { lot: string; batch: string; qty: number; ur: number; qty_ok: boolean; invoice: string | null; vendor_batch: string | null; sloc: string | null; rolls: number; roll_sum: number }
/** A shade-report roll whose Barcode Number is not a Korber Pallet: the Korber roll is chosen by hand. */
export interface ManualRoll { lot: string; batch: string; material: string; vendor_batch: string | null; roll_no: string | null; barcode: string | null; roll_qty: number; shade: string | null; invoice: string | null; reason: string }
export interface KorberRow { pallet: string; item: string; lot: string | null; qty: number; uom: string | null; invoice: string | null; location: string | null; supplier_hu: string | null; status: string | null; available: number; picked_before: number }
export interface Candidates {
  manual?: ManualRoll[];
  /** Available QTY of the Barcode = Pallet rolls, and the balance they cannot cover (only that is picked by hand). */
  matchedAvail?: number; shortfall?: number;
  line: { so: string; li: string; item: string; qty: number; plant: string | null; key: string; week: string; date: string };
  need: number; picked: number; stock: { batch: string; ur: number; sloc: string }[]; lots: LotInfo[]; rolls: Candidate[]; steps: string[];
}
export interface PickReq { id: number; day: string; seq: number; pick_no: string | null; week: string; line: string; so: string; li: string; item: string; plant: string | null; need: number; qty: number; rolls: number; by_user: string; at: string; cancelled_at: string | null; cancelled_by: string | null; match?: string | null }
export interface PickRoll { id: number; req_id: number; day: string; week: string; line: string; so: string; li: string; item: string; pallet: string; qty: number; roll_qty: number; partial: number; shade: string | null; lot: string | null; insp_lot: string | null; batch: string | null; note: string | null; by_user: string; at: string; cancelled_at: string | null; korber: string | null }
export interface PickHistory { day: string | null; requests: PickReq[]; picks: PickRoll[]; days: { day: string; n: number; open: number }[]; korberHeader: unknown[] | null }

export const ordinal = (n: number) => { const v = n % 100, s = ['th', 'st', 'nd', 'rd']; return n + (s[(v - 20) % 10] || s[v] || s[0]); };
const hn = (v: unknown) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const itemKey = (v: unknown) => { let s = String(v ?? '').trim(); if (/^\d+\.0+$/.test(s)) s = s.replace(/\.0+$/, ''); if (/^\d+$/.test(s)) s = s.replace(/^0+(?=\d)/, ''); return s.toUpperCase(); };

/** Finds the sheet and header row holding the report's columns. */
export function findTable(sheets: { name: string; grid: Grid }[], src: PickSrc) {
  const needs = PICK_SRCS.find((x) => x.src === src)!.needs;
  for (const s of sheets) {
    for (let r = 0; r < Math.min(15, s.grid.length); r++) {
      const row = (s.grid[r] || []).map(hn);
      if (needs.every((n) => row.includes(n))) {
        const rows = s.grid.slice(r + 1).filter((x) => x && x.some((v) => v !== null && v !== ''));
        return { sheet: s.name, header: s.grid[r] as unknown[], rows: rows as unknown[][] };
      }
    }
  }
  return null;
}

/** Reads a pick report file and uploads it (Korber: only the rolls of items in the plan / shade reports). */
export async function uploadPickFile(src: PickSrc, file: File) {
  const sheets = readWorkbook(await file.arrayBuffer());
  const t = findTable(sheets, src);
  const title = PICK_SRCS.find((x) => x.src === src)!.title;
  if (!t) throw new Error(`${file.name} does not look like ${title}: no header row with ${PICK_SRCS.find((x) => x.src === src)!.needs.join(', ')}.`);
  let rows = t.rows;
  const total = rows.length;
  if (src === 'korber') {
    const keys = new Set((await api<{ items: string[] }>('/api/pick/keys')).items.map(itemKey));
    const ii = t.header.map(hn).indexOf('item number');
    rows = rows.filter((r) => keys.has(itemKey(r[ii])));
    if (!rows.length) throw new Error('None of the Korber rolls are for items in the plan. Upload the weekly plan first.');
  }
  if (src === 'zcoment') {
    const ri = t.header.map(hn).indexOf('report name');
    if (ri >= 0) rows = rows.filter((r) => hn(r[ri]) === 'shade report');
  }
  const r = await api<{ rows: number; skipped: number }>('/api/pick/upload', { method: 'POST', body: { src, header: t.header, rows, fileName: file.name, total } });
  return { ...r, total, sheet: t.sheet };
}

const PL_HEAD = ['Pallet', 'Location Id', 'Item Number', 'Supplier Desc', 'Lot Number', 'Supplier Hu', 'Color', 'Plant', 'Asn Number', 'Po Number', 'Customer Ref Number', 'Cus Dec Number', 'Actual Qty', 'Pick No', 'Shade'];
/** Korber column (as uploaded) for each Packing List column. */
const PL_FROM: Record<string, string> = {
  Pallet: 'pallet', 'Location Id': 'location id', 'Item Number': 'item number', 'Supplier Desc': 'supplier desc', 'Lot Number': 'lot number', 'Supplier Hu': 'supplier hu',
  Color: 'color', Plant: 'plant', 'Asn Number': 'asn number', 'Po Number': 'po number', 'Customer Ref Number': 'customer ref number', 'Cus Dec Number': 'item id',
};

/** Cell styles of the Packing List template. */
const thin = { style: 'thin', color: { rgb: '000000' } };
const BOX = { top: thin, bottom: thin, left: thin, right: thin };
const ST = {
  top: { font: { bold: true, sz: 10 }, fill: { patternType: 'solid', fgColor: { rgb: 'E1B5F5' } }, alignment: { horizontal: 'center', vertical: 'center' } },
  dark: { fill: { patternType: 'solid', fgColor: { rgb: '595959' } } },
  head: { font: { bold: true }, fill: { patternType: 'solid', fgColor: { rgb: 'D9D9D9' } }, border: BOX },
  cell: { border: BOX },
  match: { fill: { patternType: 'solid', fgColor: { rgb: 'C9C900' } }, border: { top: { style: 'thin', color: { rgb: 'FFFF00' } }, bottom: { style: 'thin', color: { rgb: 'FFFF00' } }, left: { style: 'thin', color: { rgb: 'FFFF00' } }, right: { style: 'thin', color: { rgb: 'FFFF00' } } } },
};
const num = (x: unknown) => { const t = String(x ?? '').trim(); return /^\d+$/.test(t) && t.length < 16 ? Number(t) : t; };

/** The day's Packing List: one sheet per pick (1st, 2nd …) in the PL format, a Summary, and the picked rolls in Korber format. */
export function packingListWorkbook(h: PickHistory, opts: { korberSheet?: boolean } = {}) {
  const reqs = h.requests.filter((r) => !r.cancelled_at);
  const header = (h.korberHeader || []).map(hn);
  const col = (name: string) => header.indexOf(name);
  const U = XLSXS.utils;
  const wb = U.book_new();
  const summary: (string | number | null)[][] = [['Req', 'Total Qty', 'Total Rolls', 'Pick No', 'Remarks']];
  const korberRows: unknown[][] = [];
  for (const r of reqs) {
    const rolls = h.picks.filter((p) => p.req_id === r.id && !p.cancelled_at);
    const pickNo = r.pick_no && /^\d+$/.test(r.pick_no) ? Number(r.pick_no) : (r.pick_no ?? '');
    const lines = rolls.map((p, i) => {
      const raw = (p.korber ? JSON.parse(p.korber) : []) as unknown[];
      korberRows.push(raw);
      return PL_HEAD.map((c) => {
        if (c === 'Actual Qty') return p.qty;
        if (c === 'Pick No') return i === 0 ? pickNo : null;
        if (c === 'Shade') return p.shade ?? '';
        const k = col(PL_FROM[c]);
        const v = k >= 0 ? raw[k] : null;
        return (c === 'Item Number' ? num(v) : (v ?? '')) as string | number;
      });
    });
    const qty = Math.round(rolls.reduce((t, p) => t + p.qty, 0) * 1000) / 1000;
    const cut = rolls.filter((p) => p.partial).length;
    const last = 6 + lines.length;
    const matched = matchRows(r.match);
    const aoa: (string | number | null)[][] = [
      ['TOTAL QTY', 'TOTAL ROLLS', 'HJ PICK', null, null, 'TOTAL PICK', 'CUT ROLLS'],
      [qty, rolls.length, pickNo, null, null, pickNo === '' ? 0 : 1, cut],
      [], [null, null], [],
      PL_HEAD, ...lines,
      ...(matched.length ? [[], ...matched] : []),
    ];
    const ws = U.aoa_to_sheet(aoa);
    if (lines.length) {
      ws.A2 = { t: 'n', v: qty, f: `SUM(M7:M${last})` };
      ws.B2 = { t: 'n', v: rolls.length, f: `COUNTA(A7:A${last})` };
      ws.F2 = { t: 'n', v: pickNo === '' ? 0 : 1, f: `COUNT(N7:N${last})` };
    }
    const style = (ref: string, s: unknown) => { ws[ref] = ws[ref] || { t: 's', v: '' }; (ws[ref] as { s?: unknown }).s = s; };
    for (const c of ['A', 'B', 'C', 'F', 'G']) { style(c + '1', ST.top); style(c + '2', ST.top); }
    style('D1', ST.dark);
    style('A4', ST.top); style('B4', ST.top);
    PL_HEAD.forEach((_, i) => {
      const c = U.encode_col(i);
      style(c + '6', ST.head);
      for (let rr = 7; rr <= last; rr++) style(c + rr, ST.cell);
    });
    matched.forEach((row, i) => row.forEach((_, j) => style(U.encode_col(j) + (last + 2 + i), ST.match)));
    ws['!cols'] = [20.5, 16.3, 16.7, 23, 18.5, 10.8, 11.7, 15.8, 27.7, 19.8, 20, 21.3, 9.5, 14.7, 14.8].map((w) => ({ wch: w }));
    ws['!autofilter'] = { ref: `A6:O${Math.max(6, last)}` };
    U.book_append_sheet(wb, ws, ordinal(r.seq));
    summary.push([ordinal(r.seq), qty, rolls.length, pickNo, `${r.so} / ${r.li} / ${r.item}${cut ? ` · ${cut} cut roll${cut > 1 ? 's' : ''}` : ''}`]);
  }
  const n = summary.length;
  summary.push(['Total', null, null]);
  const sws = U.aoa_to_sheet(summary);
  sws[`B${n + 1}`] = { t: 'n', v: reqs.reduce((t, r) => t + r.qty, 0), f: `SUM(B2:B${n})` };
  sws[`C${n + 1}`] = { t: 'n', v: reqs.reduce((t, r) => t + r.rolls, 0), f: `SUM(C2:C${n})` };
  sws['!cols'] = [{ wch: 8 }, { wch: 12 }, { wch: 12 }, { wch: 14 }, { wch: 46 }];
  U.book_append_sheet(wb, sws, 'Summary');
  if (opts.korberSheet !== false && h.korberHeader) {
    const kws = U.aoa_to_sheet([h.korberHeader as (string | number)[], ...(korberRows as (string | number)[][])]);
    U.book_append_sheet(wb, kws, 'Korber Inventory');
  }
  return wb;
}

/** Writes a workbook with its cell styles (fills, borders) kept. */
export function saveWorkbook(wb: XLSX.WorkBook, file: string) {
  XLSXS.writeFile(wb, file, { cellStyles: true });
}

/**
 * Under the rolls, like the template: one line per matched stock row —
 * SO | Line Item | Qty (ZMMBE UR = ZINR Insp. Lot Quantity) | Material | Batch.
 * ZMMBE rows are used; when the pick has none (an older pick), the ZINR lots.
 */
function matchRows(match: string | null | undefined): (string | number)[][] {
  if (!match) return [];
  let m: { zmmbe?: Record<string, unknown>[]; zinr?: Record<string, unknown>[] };
  try { m = JSON.parse(match); } catch { return []; }
  const src = m.zmmbe?.length ? m.zmmbe.map((z) => ({ so: z.so, li: z.li, qty: z.ur, material: z.material, batch: z.batch }))
    : (m.zinr || []).map((z) => ({ so: z.so, li: z.li, qty: z.qty, material: z.material, batch: z.batch }));
  const by = new Map<string, (string | number)[]>();
  for (const z of src) {
    const row = [String(z.so ?? ''), num(z.li), Number(z.qty) || 0, num(z.material), num(String(z.batch ?? '').replace(/^0+(?=\d)/, ''))];
    const k = row.filter((_, i) => i !== 2).join('|');
    const had = by.get(k);
    if (had) had[2] = Math.round(((had[2] as number) + (row[2] as number)) * 1000) / 1000; else by.set(k, row);
  }
  return Array.from(by.values());
}

/** The picked rolls only, in the Korber Inventory format (same columns as the uploaded file). */
export function korberWorkbook(h: PickHistory) {
  const rows = h.picks.filter((p) => !p.cancelled_at && h.requests.some((r) => r.id === p.req_id && !r.cancelled_at)).map((p) => (p.korber ? JSON.parse(p.korber) : []) as (string | number)[]);
  const ws = XLSX.utils.aoa_to_sheet([(h.korberHeader || []) as (string | number)[], ...rows]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  return wb;
}
