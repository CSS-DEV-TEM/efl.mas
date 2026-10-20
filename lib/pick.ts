/** Picking: types, file reading for the three pick reports, and the Packing List workbook. */
import * as XLSX from 'xlsx';
import * as XLSXS from 'xlsx-js-style';
import { api } from './api';
import { readWorkbook, type Grid } from './mapping';

export type PickSrc = 'zinr' | 'zcoment' | 'korber';
export const PICK_SRCS: { src: PickSrc; title: string; hint: string; needs: string[] }[] = [
  { src: 'zinr', title: 'ZINR', hint: 'Inspection lots: Sales Order, Line Item, Material, Batch, Insp. Lot Quantity, Vendor Invoice No', needs: ['inspection lot', 'insp lot quantity'] },
  // either layout: the detail export (Inspection lot, Report Name, Roll qty.) or the roll view (Inspection #, Vendor Roll No, Shade, Barcode Number)
  { src: 'zcoment', title: 'ZCOMENT VIEW', hint: 'One row per roll: Inspection # / Inspection lot, Vendor Batch, Vendor Roll No, Shade, Barcode Number (only "Shade Report" rows when there is a Report Name)', needs: ['vendor roll no', 'shade'] },
  { src: 'korber', title: 'Korber Inventory', hint: 'Only rolls of items in the plan are uploaded: Pallet, Item Number, Lot Number, Actual Qty, Supplier Hu', needs: ['pallet', 'item number', 'actual qty'] },
];

export interface Candidate {
  pallet: string; item: string; lot: string | null; supplier_hu: string | null; location: string | null; uom: string | null; invoice: string | null;
  actual_qty: number; base_qty: number; picked_before: number; available: number; roll_qty: number; shade: string | null;
  insp_lots: string[]; batches: string[]; checks: Record<string, boolean | null>; warnings: string[]; needsConfirm: boolean;
  picks: { day: string; by_user: string; qty: number }[];
  /** found under another pallet label than the ZCOMENT Barcode Number (e.g. COMPCP… for CP…) */
  via?: string | null; barcode?: string | null;
  qtyNote?: string | null;
  /** ZCOMENT Roll qty differs: Korber's Actual Qty is the roll's QTY */
  korberQty?: boolean;
  /** matched straight from ZINR to Korber (Item + Lot + Invoice + Po) */
  direct?: boolean;
  /** ZCOMENT barcode not a Korber pallet: found by Supplier Hu = Vendor Roll No */
  byHu?: boolean;
  /** this lot's ZCOMENT row had no barcode: taken from the same roll under another inspection lot */
  borrowed?: boolean;
  /** that PO / invoice / lot is shared by this many SO lines: the user ticks the rolls */
  pool?: number;
  /** how much of the roll is in each batch of this line */
  parts?: { batch: string; lot: string; qty: number }[];
}
export interface LotInfo { via?: string | null; noShade?: boolean; /** rolls found straight from ZINR to Korber */ direct?: number; lot: string; batch: string; qty: number; ur: number; qty_ok: boolean; invoice: string | null; vendor_batch: string | null; sloc: string | null; rolls: number; roll_sum: number }
/** A shade-report roll whose Korber pallet does not agree on Pallet, Lot, Supplier Hu, Invoice and Po: the Korber roll is chosen by hand. */
export interface ManualRoll { lot: string; batch: string; material: string; vendor_batch: string | null; roll_no: string | null; barcode: string | null; roll_qty: number; shade: string | null; invoice: string | null; po?: string | null; reason: string;
  /** Korber rolls with the same item, Lot Number, Supplier Hu, Invoice and Po (another pallet). */
  suggest?: KorberRow[] }
export interface KorberRow { pallet: string; item: string; lot: string | null; qty: number; uom: string | null; invoice: string | null; location: string | null; supplier_hu: string | null; status: string | null; available: number; picked_before: number }
/** A Korber roll offered for a shade-report roll with no Barcode Number (same item; Lot / Supplier Hu agree). */
export interface NbOption extends KorberRow { checks: Record<string, boolean | null>; exact: boolean }
/** A shade-report roll with no Barcode Number: the user chooses its Korber roll from `options`. */
export interface NoBarcodeRoll extends Omit<ManualRoll, 'reason' | 'suggest'> { options: NbOption[]; /** its Korber roll was picked in full already */ done?: boolean; /** an inspection lot with no Shade Report in ZCOMENT: roll_qty = the lot QTY */ noShade?: boolean }
export interface Candidates {
  manual?: ManualRoll[];
  /** rolls without a Barcode Number, each with the Korber rolls that match its other fields */
  nobarcode?: NoBarcodeRoll[]; nbAvail?: number;
  /** Available QTY of the matched rolls, and the balance they cannot cover (only that is picked by hand). */
  matchedAvail?: number; shortfall?: number;
  /** what is still needed from each batch (its UR less what was picked), trimmed to the line balance */
  batchNeed?: { batch: string; lots: string[]; ur: number; picked: number; need: number }[];
  line: { so: string; li: string; item: string; qty: number; plant: string | null; key: string; week: string; date: string };
  need: number; picked: number; stock: { batch: string; ur: number; sloc: string }[]; lots: LotInfo[]; rolls: Candidate[]; steps: string[];
}
export interface PickReq { id: number; day: string; seq: number; pick_no: string | null; week: string; line: string; so: string; li: string; item: string; plant: string | null; need: number; qty: number; rolls: number; by_user: string; at: string; cancelled_at: string | null; cancelled_by: string | null; match?: string | null; kind?: string | null; closed?: number | null; short?: number | null }
export interface PickRoll { id: number; req_id: number; day: string; week: string; line: string; so: string; li: string; item: string; pallet: string; qty: number; roll_qty: number; partial: number; shade: string | null; lot: string | null; insp_lot: string | null; batch: string | null; note: string | null; by_user: string; at: string; cancelled_at: string | null; korber: string | null }
export interface PickHistory { day: string | null; requests: PickReq[]; picks: PickRoll[]; days: { day: string; n: number; open: number }[]; korberHeader: unknown[] | null }

export const ordinal = (n: number) => { const v = n % 100, s = ['th', 'st', 'nd', 'rd']; return n + (s[(v - 20) % 10] || s[v] || s[0]); };
const hn = (v: unknown) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
/** Korber item: Display Item Number, else the Item Number without the client code (MASKRE-1000240167 → 1000240167). */
const korberItemKey = (display: unknown, item: unknown) => itemKey(display) || itemKey(String(item ?? '').trim().toUpperCase().replace(/^[A-Z]{2,10}-(?=[A-Z0-9])/, ''));
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
    const hh = t.header.map(hn), ii = hh.indexOf('item number'), di = hh.indexOf('display item number');
    rows = rows.filter((r) => keys.has(korberItemKey(di >= 0 ? r[di] : null, r[ii])));
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

/**
 * The Packing List.
 * `ids`: only these picks (the ones marked in the history); all live picks when empty.
 * `combined`: every pick in ONE "Packing List" sheet (one table, the Pick No on each pick's first roll);
 * otherwise one sheet per pick (1st, 2nd …). Plus a Summary and the picked rolls in Korber format.
 */
export function packingListWorkbook(h: PickHistory, opts: { korberSheet?: boolean; ids?: Set<number> | number[]; combined?: boolean } = {}) {
  const only = opts.ids ? new Set(opts.ids) : null;
  const reqs = h.requests.filter((r) => !r.cancelled_at && (!only || !only.size || only.has(r.id)));
  const header = (h.korberHeader || []).map(hn);
  const col = (name: string) => header.indexOf(name);
  const U = XLSXS.utils;
  const wb = U.book_new();
  const summary: (string | number | null)[][] = [['Req', 'Total Qty', 'Total Rolls', 'Pick No', 'Type', 'Remarks']];
  // the admin's "All users" view: every user has a 1st, 2nd … so the names carry the user
  const multi = new Set(reqs.map((r) => r.by_user)).size > 1;
  const reqName = (r: PickReq) => (multi ? `${r.by_user} ${ordinal(r.seq)}` : ordinal(r.seq)).replace(/[\\/?*[\]:]/g, '').slice(0, 31);
  const korberRows: unknown[][] = [];
  const pickNoOf = (r: PickReq) => (r.pick_no && /^\d+$/.test(r.pick_no) ? Number(r.pick_no) : (r.pick_no ?? ''));
  const rollsOf = (r: PickReq) => h.picks.filter((p) => p.req_id === r.id && !p.cancelled_at);

  /** One PL sheet for these picks: the totals block, the roll table, then the matched SO|LI|Qty|Material|Batch lines. */
  const plSheet = (group: PickReq[]) => {
    const lines: (string | number | null)[][] = [];
    let qty = 0, nRolls = 0, cut = 0;
    const pickNos: (string | number)[] = [];
    for (const r of group) {
      const rolls = rollsOf(r);
      const pickNo = pickNoOf(r);
      if (pickNo !== '') pickNos.push(pickNo);
      rolls.forEach((p, i) => {
        const raw = (p.korber ? JSON.parse(p.korber) : []) as unknown[];
        korberRows.push(pickedRow(raw, header, p.qty));
        lines.push(PL_HEAD.map((c) => {
          if (c === 'Actual Qty') return p.qty;
          if (c === 'Pick No') return i === 0 ? pickNo : null;
          if (c === 'Shade') return p.shade ?? '';
          const k = col(PL_FROM[c]);
          let v = k >= 0 ? raw[k] : null;
          if (c === 'Item Number') { const d = col('display item number'); v = korberItemKey(d >= 0 ? raw[d] : null, v) || v; }
          return (c === 'Item Number' ? num(v) : (v ?? '')) as string | number;
        }));
        qty += p.qty; nRolls++; if (p.partial) cut++;
      });
    }
    qty = Math.round(qty * 1000) / 1000;
    const last = 6 + lines.length;
    const matched = matchRows(group, rollsOf);
    const hj: string | number = pickNos.length === 1 ? pickNos[0] : pickNos.join(', ');
    const aoa: (string | number | null)[][] = [
      ['TOTAL QTY', 'TOTAL ROLLS', 'HJ PICK', null, null, 'TOTAL PICK', 'CUT ROLLS'],
      [qty, nRolls, hj, null, null, pickNos.length, cut],
      [], [null, null], [],
      PL_HEAD, ...lines,
      ...(matched.length ? [[], ...matched] : []),
    ];
    const ws = U.aoa_to_sheet(aoa);
    if (lines.length) {
      ws.A2 = { t: 'n', v: qty, f: `SUM(M7:M${last})` };
      ws.B2 = { t: 'n', v: nRolls, f: `COUNTA(A7:A${last})` };
      ws.F2 = { t: 'n', v: pickNos.length, f: `COUNTA(N7:N${last})` };
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
    return ws;
  };

  if (opts.combined) U.book_append_sheet(wb, plSheet(reqs), 'Packing List');
  for (const r of reqs) {
    if (!opts.combined) U.book_append_sheet(wb, plSheet([r]), reqName(r));
    const rolls = rollsOf(r);
    const cut = rolls.filter((p) => p.partial).length;
    summary.push([reqName(r), Math.round(rolls.reduce((t, p) => t + p.qty, 0) * 1000) / 1000, rolls.length, pickNoOf(r), r.kind === 'offsite' ? 'Offsite' : 'Normal',
      `${r.so} / ${r.li} / ${r.item}${cut ? ` · ${cut} cut roll${cut > 1 ? 's' : ''}` : ''}${r.closed ? ` · closed ${r.short ?? ''} short` : ''}${multi ? ` · ${r.by_user}` : ''}`]);
  }
  const n = summary.length;
  summary.push(['Total', null, null]);
  const sws = U.aoa_to_sheet(summary);
  sws[`B${n + 1}`] = { t: 'n', v: reqs.reduce((t, r) => t + r.qty, 0), f: `SUM(B2:B${n})` };
  sws[`C${n + 1}`] = { t: 'n', v: reqs.reduce((t, r) => t + r.rolls, 0), f: `SUM(C2:C${n})` };
  sws['!cols'] = [{ wch: multi ? 16 : 8 }, { wch: 12 }, { wch: 12 }, { wch: 14 }, { wch: 9 }, { wch: 52 }];
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
 * Under the rolls, like the template: one line per batch the picks took QTY from —
 * SO | Line Item | Qty (the QTY picked from that batch) | Material | Batch.
 * A new pick carries its split per batch (`alloc`). For an older pick it is worked out here: a roll in one batch
 * gives all its QTY to that batch; a roll in two batches fills the batch with the smaller UR first.
 */
function matchRows(reqs: PickReq[], rollsOf: (r: PickReq) => PickRoll[]): (string | number)[][] {
  const by = new Map<string, (string | number)[]>();
  const add = (so: unknown, li: unknown, material: unknown, batch: unknown, qty: number) => {
    if (!(qty > 1e-9)) return;
    const row = [String(so ?? ''), num(li), Math.round(qty * 1000) / 1000, num(material), num(String(batch ?? '').replace(/^0+(?=\d)/, ''))];
    const k = row.filter((_, i) => i !== 2).join('|');
    const had = by.get(k);
    if (had) had[2] = Math.round(((had[2] as number) + qty) * 1000) / 1000; else by.set(k, row);
  };
  for (const r of reqs) {
    let m: { zmmbe?: Record<string, unknown>[]; zinr?: Record<string, unknown>[]; alloc?: { pallet: string; batch: string; qty: number }[] } = {};
    try { if (r.match) m = JSON.parse(r.match); } catch { /* */ }
    const rolls = rollsOf(r);
    const live = new Set(rolls.map((p) => p.pallet));
    if (m.alloc?.length) { for (const a of m.alloc) if (live.has(a.pallet)) add(r.so, r.li, r.item, a.batch, Number(a.qty)); continue; }
    // older pick: each batch's UR (ZMMBE, else the ZINR lots) caps what it can give
    const ur = new Map<string, number>();
    for (const z of m.zmmbe?.length ? m.zmmbe : m.zinr || []) { const bt = String(z.batch ?? ''); ur.set(bt, (ur.get(bt) ?? 0) + (Number(m.zmmbe?.length ? z.ur : z.qty) || 0)); }
    const key = (bt: string) => [...ur.keys()].find((k) => k.replace(/^0+/, '') === bt.replace(/^0+/, '')) ?? bt;
    for (const p of rolls) {
      const bts = String(p.batch ?? '').split(',').map((x) => x.trim()).filter(Boolean).map(key);
      if (!bts.length) continue;
      let q = Number(p.qty);
      for (const bt of [...bts].sort((x, y) => (ur.get(x) ?? Infinity) - (ur.get(y) ?? Infinity))) {
        const t = bts.length === 1 ? q : Math.min(q, Math.max(0, ur.get(bt) ?? Infinity));
        add(r.so, r.li, r.item, bt, t); ur.set(bt, (ur.get(bt) ?? 0) - t); q -= t;
        if (q <= 1e-9) break;
      }
      if (q > 1e-9) add(r.so, r.li, r.item, bts[0], q);
    }
  }
  return Array.from(by.values());
}

/**
 * The Korber row as picked: a cut roll's Actual Qty becomes the QTY taken from it (a full roll keeps its own).
 * `header` = the Korber header in `hn` form.
 */
function pickedRow(raw: unknown[], header: string[], qty: number): unknown[] {
  const row = [...raw];
  const i = header.indexOf('actual qty');
  if (i >= 0) row[i] = Math.round(qty * 1000) / 1000;
  return row;
}

/** The picked rolls only (the marked picks, or all), in the Korber Inventory format (same columns as the uploaded file). */
export function korberWorkbook(h: PickHistory, ids?: Set<number> | number[]) {
  const only = ids ? new Set(ids) : null;
  const header = (h.korberHeader || []).map(hn);
  const rows = h.picks.filter((p) => !p.cancelled_at && (!only || !only.size || only.has(p.req_id)) && h.requests.some((r) => r.id === p.req_id && !r.cancelled_at)).map((p) => pickedRow((p.korber ? JSON.parse(p.korber) : []) as unknown[], header, p.qty) as (string | number)[]);
  const ws = XLSX.utils.aoa_to_sheet([(h.korberHeader || []) as (string | number)[], ...rows]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  return wb;
}
