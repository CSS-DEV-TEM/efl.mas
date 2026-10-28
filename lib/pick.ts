/** Picking: types, file reading for the three pick reports, and the Packing List workbook. */
import { keepFile } from './files';
import * as XLSX from 'xlsx';
import * as XLSXS from 'xlsx-js-style';
import { planTableAoa } from './export';
import type { Line } from './calc';
import { api } from './api';
import { readWorkbook, type Grid } from './mapping';

export type PickSrc = 'zinr' | 'zcoment' | 'korber' | 'zroll' | 'ztrr';
export const PICK_SRCS: { src: PickSrc; title: string; hint: string; needs: string[] }[] = [
  { src: 'zinr', title: 'ZINR', hint: 'Inspection lots: Sales Order, Line Item, Material, Batch, Insp. Lot Quantity, Vendor Invoice No', needs: ['inspection lot', 'insp lot quantity'] },
  // either layout: the detail export (Inspection lot, Report Name, Roll qty.) or the roll view (Inspection #, Vendor Roll No, Shade, Barcode Number)
  { src: 'zcoment', title: 'ZCOMENT VIEW', hint: 'One row per roll: Inspection # / Inspection lot, Vendor Batch, Vendor Roll No, Shade, Barcode Number (only "Shade Report" rows when there is a Report Name)', needs: ['vendor roll no', 'shade'] },
  { src: 'ztrr', title: 'ZMM_TRR', hint: 'Transfer requests: Transfer Request Number, To Sales Order, Sales Document Item, Material (the plan report’s TRANSFER NOTE)', needs: ['transfer request number', 'to sales order'] },
  { src: 'zroll', title: 'ZROLLMGT', hint: 'Roll management: Barcode Number and StorageBin (only rolls at EXPO-FIX can be picked)', needs: ['barcode number|barcode|barcode no|barcode no.', 'storagebin|storage bin|bin|bin location'] },
  { src: 'korber', title: 'Korber Inventory', hint: 'Only rolls of items in the plan are uploaded: Pallet, Item Number, Lot Number, Actual Qty, Supplier Hu', needs: ['pallet', 'item number', 'actual qty'] },
];

export interface Candidate {
  /** SAP fit to the SO line (manual selection) */
  sap?: SapFit | null;
  /** Korber Fifo Date (yyyy-mm-dd): rolls chosen by hand are listed oldest first */
  fifo?: string | null;
  pallet: string; item: string; lot: string | null; supplier_hu: string | null; location: string | null; uom: string | null; invoice: string | null;
  actual_qty: number; base_qty: number; picked_before: number; available: number; roll_qty: number; shade: string | null;
  /** its ZROLLMGT Available is shared with the other rolls of its batch (each has a little in SAP): together at most `avail` */
  zpool?: { batch: string; avail: number; pallets: string[] };
  insp_lots: string[]; batches: string[]; checks: Record<string, boolean | null>; warnings: string[]; needsConfirm: boolean;
  picks: PalletPick[];
  /** in ZROLLMGT under the line's ZMMBE batch (System Batch) at the bin: Barcode Number = Korber Pallet */
  zroll?: boolean;
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
  /** the rest of the roll stays with this SO Plant (ZMMBE): no need to cut */
  sameSoPlant?: { plant: string; lines: string[] };
  /** that PO / invoice / lot is shared by this many SO lines: the user ticks the rolls */
  pool?: number;
  /** of a shared lot: one of the rolls whose Actual Qty adds up to this lot's QTY (proposed; the user ticks) */
  suggested?: boolean;
  /** how much of the roll is in each batch of this line */
  parts?: { batch: string; lot: string; qty: number }[];
}
export interface LotInfo { /** what this SO line may still take from the lot (ZINSR QTY less its picks) */ need?: number; picked?: number; /** the lot's ZINSR QTY less what this line already took from it */ cap?: number; via?: string | null; noShade?: boolean; /** rolls found straight from ZINR to Korber */ direct?: number; lot: string; batch: string; qty: number; ur: number; qty_ok: boolean; invoice: string | null; vendor_batch: string | null; sloc: string | null; rolls: number; roll_sum: number }
/** A shade-report roll whose Korber pallet does not agree on Pallet, Lot, Supplier Hu, Invoice and Po: the Korber roll is chosen by hand. */
export interface ManualRoll { /** a Korber pallet added by hand for a shortage of the pick */ free?: boolean; lot: string; batch: string; material: string; vendor_batch: string | null; roll_no: string | null; barcode: string | null; roll_qty: number; shade: string | null; invoice: string | null; po?: string | null; reason: string;
  /** Korber rolls with the same item, Lot Number, Supplier Hu, Invoice and Po (another pallet). */
  suggest?: KorberRow[] }
/** how well a roll fits the SO line by its SAP data: matched / not matched fields, best first */
export interface SapFit { score: number; hits: string[]; miss: string[]; shade?: string | null }
export interface KorberRow { /** SAP fit to the SO line (manual selection) */ sap?: SapFit | null; /** Korber Fifo Date (yyyy-mm-dd) */ fifo?: string | null; /** not pickable: Korber Pick Id not 0, or rejected */ blocked?: string; pick_id?: string | null; pallet: string; item: string; lot: string | null; qty: number; uom: string | null; invoice: string | null; location: string | null; supplier_hu: string | null; status: string | null; available: number; /** ZROLLMGT Reserved part (Available Quantity is less than the roll) */ reserved?: number; picked_before: number; picks?: PalletPick[] }
/** an earlier pick of a pallet: QTY, the plan it went to (day plan round / week), SO / LI, HJ Pick No, day, who */
export interface PalletPick { day: string; by_user: string; qty: number; plan?: string; so?: string; li?: string; pick_no?: string | null; at?: string }
/** "64.46 · 20 Oct · VAANAVIL Pick 1 · E101698226 / 10 · HJ 5501 · admin" */
export const pickNote = (p: PalletPick) => [String(p.qty), p.plan || p.day, p.so ? `${p.so} / ${p.li}` : '', p.pick_no ? `HJ ${p.pick_no}` : '', p.by_user].filter(Boolean).join(' · ');
/** A Korber roll offered for a shade-report roll with no Barcode Number (same item; Lot / Supplier Hu agree). */
export interface NbOption extends KorberRow { checks: Record<string, boolean | null>; exact: boolean }
/** A shade-report roll with no Barcode Number: the user chooses its Korber roll from `options`. */
export interface NoBarcodeRoll extends Omit<ManualRoll, 'reason' | 'suggest'> { /** its Lot Number is not in Korber: the invoice's other lots are offered */ lotChoice?: boolean; /** a lot with no ZCOMENT rolls: the Korber rolls of its Invoice + Item (Po first) with another Lot Number, to tick (several) */ invChoice?: boolean; options: NbOption[]; /** its Korber roll was picked in full already */ done?: boolean; /** an inspection lot with no Shade Report in ZCOMENT: roll_qty = the lot QTY */ noShade?: boolean; /** its ZCOMENT barcode is not a Korber pallet */ zcBarcode?: string }
export interface Candidates {
  manual?: ManualRoll[];
  /** rolls without a Barcode Number, each with the Korber rolls that match its other fields */
  nobarcode?: NoBarcodeRoll[]; nbAvail?: number;
  /** Available QTY of the matched rolls, and the balance they cannot cover (only that is picked by hand). */
  matchedAvail?: number; shortfall?: number;
  /** what is still needed from each batch (its UR less what was picked), trimmed to the line balance */
  batchNeed?: { batch: string; lots: string[]; ur: number; picked: number; need: number }[];
  line: { so: string; li: string; item: string; qty: number; plant: string | null; key: string; week: string; date: string };
  /** plan QTY and the UR (Total − SO QI − SO Blocked − Assigned); need = what to pick = the smaller of the two */
  planQty?: number; ur?: number;
  /** Already sent (ZMMBE at the plant storage locations); null = not known */
  sent?: number | null;
  need: number; picked: number; stock: { batch: string; ur: number; sloc: string }[]; lots: LotInfo[]; rolls: Candidate[]; steps: string[];
  /** ZROLLMGT check: rolls of this line that cannot be picked, and why */
  blocked?: BlockedRoll[]; gate?: { on: boolean; bin: string; loaded: boolean };
}
export interface BlockedRoll { lot: string; batch: string | null; roll_no: string | null; barcode: string | null; shade: string | null; pallet: string | null; qty: number | null; why: string }
export interface PickReq { id: number; day: string; seq: number; pick_no: string | null; week: string; line: string; so: string; li: string; item: string; plant: string | null; need: number; qty: number; rolls: number; by_user: string; at: string; cancelled_at: string | null; cancelled_by: string | null; match?: string | null; kind?: string | null; closed?: number | null; short?: number | null;
  /** the Pick's ZMMBE rows of the line (batch, storage location) when the pick did not keep them */
  zstock?: { batch: string; sloc: string | null; ur: number }[] }
export interface PickRoll { id: number; req_id: number; day: string; week: string; line: string; so: string; li: string; item: string; pallet: string; qty: number; roll_qty: number; partial: number; shade: string | null; lot: string | null; insp_lot: string | null; batch: string | null; note: string | null; by_user: string; at: string; cancelled_at: string | null; korber: string | null; /** picked from the pallet before this pick */ prior?: number }
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
      if (needs.every((n) => n.split('|').some((alt) => row.includes(alt)))) {
        const rows = s.grid.slice(r + 1).filter((x) => x && x.some((v) => v !== null && v !== ''));
        return { sheet: s.name, header: s.grid[r] as unknown[], rows: rows as unknown[][] };
      }
    }
  }
  return null;
}

/** Reads a pick report file and uploads it (Korber: only the rolls of items in the plan / shade reports). */
/** Uploads a ZINR / ZCOMENT VIEW / Korber file — to a Pick (`rid`), or as the shared report (no rid). */
export async function uploadPickFile(src: PickSrc, file: File, rid?: string | null) {
  const r = await uploadPickSheets(src, readWorkbook(await file.arrayBuffer()), file.name, rid);
  // the original file is kept as it was: it can be downloaded again (Uploads → Uploaded files)
  await keepFile(file, [src], rid);
  return r;
}
/** The same, from sheets already read (one sheet of a workbook that has several reports). */
export async function uploadPickSheets(src: PickSrc, sheets: ReturnType<typeof readWorkbook>, fileName: string, rid?: string | null) {
  const file = { name: fileName };
  const t = findTable(sheets, src);
  const title = PICK_SRCS.find((x) => x.src === src)!.title;
  if (!t) throw new Error(`${file.name} does not look like ${title}: no header row with ${PICK_SRCS.find((x) => x.src === src)!.needs.map((n) => n.split('|')[0]).join(', ')}.`);
  let rows = t.rows;
  const total = rows.length;
  if (src === 'korber') {
    // a Pick's Korber keeps only the items of that Pick's plan
    const keys = new Set((await api<{ items: string[] }>('/api/pick/keys' + (rid ? '?rid=' + encodeURIComponent(rid) : ''))).items.map(itemKey));
    const hh = t.header.map(hn), ii = hh.indexOf('item number'), di = hh.indexOf('display item number');
    rows = rows.filter((r) => keys.has(korberItemKey(di >= 0 ? r[di] : null, r[ii])));
    if (!rows.length) throw new Error(rid ? 'None of the Korber rolls are for items in this Pick\'s plan. Upload the Pick\'s plan first.' : 'None of the Korber rolls are for items in the plan. Upload the plan first.');
  }
  if (src === 'zcoment') {
    const ri = t.header.map(hn).indexOf('report name');
    if (ri >= 0) rows = rows.filter((r) => hn(r[ri]) === 'shade report');
  }
  const r = await api<{ rows: number; skipped: number }>('/api/pick/upload', { method: 'POST', body: { src, header: t.header, rows, fileName: file.name, total, ...(rid ? { rid } : {}) } });
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
  cut: { font: { bold: true, color: { rgb: '9C0006' } }, fill: { patternType: 'solid', fgColor: { rgb: 'FFC7CE' } }, border: BOX },
  cutHead: { font: { bold: true, color: { rgb: 'FFFFFF' } }, fill: { patternType: 'solid', fgColor: { rgb: 'C00000' } }, border: BOX },
  key: { font: { bold: true, color: { rgb: 'FFFFFF' } }, fill: { patternType: 'solid', fgColor: { rgb: '808000' } }, border: BOX },
  match: { fill: { patternType: 'solid', fgColor: { rgb: 'C9C900' } }, border: { top: { style: 'thin', color: { rgb: 'FFFF00' } }, bottom: { style: 'thin', color: { rgb: 'FFFF00' } }, left: { style: 'thin', color: { rgb: 'FFFF00' } }, right: { style: 'thin', color: { rgb: 'FFFF00' } } } },
};
const num = (x: unknown) => { const t = String(x ?? '').trim(); return /^\d+$/.test(t) && t.length < 16 ? Number(t) : t; };

/** Packing List columns, in the order of the template. */
const PL_HEAD2 = ['Pallet', 'Location Id', 'Item Number', 'Description', 'Lot Number', 'Supplier Hu', 'Color', 'Plant', 'Asn Number', 'Po Number', 'Customer Ref Number', 'Item Id', 'Actual Qty', 'Shade', 'Pick No'];
/** Korber column (as uploaded, `hn` form) for each Packing List column; the first one present is used. */
const PL_SRC: Record<string, string[]> = {
  Pallet: ['pallet'], 'Location Id': ['location id'], 'Item Number': ['item number'], Description: ['description', 'supplier desc'], 'Lot Number': ['lot number'],
  'Pick Id': ['pick id'], 'Supplier Hu': ['supplier hu'], Color: ['color'], Plant: ['plant'], 'Asn Number': ['asn number'], 'Po Number': ['po number'], 'Customer Ref Number': ['customer ref number'], 'Item Id': ['item id'],
};
const QTY_COL = PL_HEAD2.indexOf('Actual Qty'), SHADE_COL = PL_HEAD2.indexOf('Shade'), PICKNO_COL = PL_HEAD2.indexOf('Pick No');

type Match = { zmmbe?: Record<string, unknown>[]; zinr?: Record<string, unknown>[]; alloc?: { pallet: string; batch: string; qty: number }[] };
const parseMatch = (r: PickReq): Match => { try { return r.match ? JSON.parse(r.match) : {}; } catch { return {}; } };
const canonSloc = (v: unknown) => String(v ?? '').trim().toUpperCase().replace(/^0+(?=\w)/, '');

/**
 * The QTY a picked roll took from each batch: the pick's own split (`alloc`); for an older pick, a roll in one batch gives
 * all its QTY to it, a roll in two batches fills the batch with the smaller UR first.
 */
function rollBatches(r: PickReq, m: Match, p: PickRoll): { batch: string; qty: number }[] {
  // the parts always add up to exactly what the roll gave (the SAP lines tally with the Actual Qty)
  const fit = (parts: { batch: string; qty: number }[]) => {
    const out = parts.filter((x) => x.qty > 1e-9).map((x) => ({ ...x, qty: Math.round(x.qty * 1000) / 1000 }));
    const want = Math.round(Number(p.qty) * 1000) / 1000;
    let diff = Math.round((want - out.reduce((t, x) => t + x.qty, 0)) * 1000) / 1000;
    if (!out.length) return [{ batch: String(p.batch ?? '').split(',')[0]?.trim() ?? '', qty: want }];
    // too much: take it off the last parts; too little: add it to the biggest part
    for (let i = out.length - 1; i >= 0 && diff < -1e-9; i--) { const t = Math.min(out[i].qty, -diff); out[i].qty = Math.round((out[i].qty - t) * 1000) / 1000; diff = Math.round((diff + t) * 1000) / 1000; }
    if (diff > 1e-9) { const b = out.reduce((x, y) => (y.qty > x.qty ? y : x)); b.qty = Math.round((b.qty + diff) * 1000) / 1000; }
    return out.filter((x) => x.qty > 1e-9);
  };
  return fit(rollBatches0(r, m, p));
}
function rollBatches0(r: PickReq, m: Match, p: PickRoll): { batch: string; qty: number }[] {
  const zs = [...(m.zmmbe || []), ...(r.zstock || [])] as Record<string, unknown>[];
  const zb = new Set(zs.map((z) => String(z.batch ?? '').replace(/^0+(?=\d)/, '')));
  const topB = () => String((zs.filter((z) => Number(z.ur) > 0).sort((a, b) => Number(b.ur) - Number(a.ur))[0] ?? zs[0])?.batch ?? '');
  const own = (m.alloc || []).filter((a) => a.pallet === p.pallet);
  // a batch that is not one of the line's ZMMBE batches (a roll picked by hand) goes on the line's batch
  if (own.length) return own.map((a) => ({ batch: zb.size && !zb.has(String(a.batch).replace(/^0+(?=\d)/, '')) ? topB() || a.batch : a.batch, qty: Number(a.qty) }));
  const bts = String(p.batch ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  if (!bts.length || (zb.size && !bts.some((b) => zb.has(b.replace(/^0+(?=\d)/, ''))))) {
    // a roll picked by hand with no batch / a batch that is not the line's: the line's ZMMBE batch with the most UR (its SAP line)
    const top = zs.filter((z) => Number(z.ur) > 0).sort((a, b) => Number(b.ur) - Number(a.ur))[0] ?? zs[0];
    if (!top) return [{ batch: bts[0] ?? '', qty: Number(p.qty) }];
    return [{ batch: String(top?.batch ?? ''), qty: Number(p.qty) }];
  }
  if (bts.length === 1) return [{ batch: bts[0], qty: Number(p.qty) }];
  const ur = new Map<string, number>();
  for (const z of m.zmmbe?.length ? m.zmmbe : m.zinr || []) { const bt = String(z.batch ?? '').replace(/^0+/, ''); ur.set(bt, (ur.get(bt) ?? 0) + (Number(m.zmmbe?.length ? z.ur : z.qty) || 0)); }
  let q = Number(p.qty); const out: { batch: string; qty: number }[] = [];
  for (const bt of [...bts].sort((x, y) => (ur.get(x.replace(/^0+/, '')) ?? Infinity) - (ur.get(y.replace(/^0+/, '')) ?? Infinity))) {
    if (q <= 1e-9) break;
    const t = Math.min(q, Math.max(0, ur.get(bt.replace(/^0+/, '')) ?? Infinity)); out.push({ batch: bt, qty: t }); q -= t;
  }
  if (q > 1e-9) out.push({ batch: bts[0], qty: q });
  return out;
}

/**
 * The Packing List.
 * `ids`: only these picks (the ones marked in the history); all live picks when empty.
 * `combined`: every pick on one sheet; otherwise a sheet per pick (1st, 2nd …).
 * KFC and PFC rolls go on their own sheets (PFC = the inspection lot's storage location is one of `pfcSlocs`, e.g. 41, COMF).
 * On a sheet the rolls are in one table per Asn Number + Po Number + Lot Number; under each table its SAP lines
 * (SO | LI | Qty | Material | Batch), the Qty adding up to the table's Actual Qty. Plus a Summary and the Korber Inventory rows.
 */
/** a problem found in the Packing List data before it is downloaded */
/** A plan line of the Packing List's Picks that the system did not pick in full, and why. */
export interface NotPicked { pick: string; so: string; li: string; item: string; plant: string | null; date: string | null; planQty: number; ur: number | null; picked: number; balance: number; matched: number | null; reason: string; detail: string }
/**
 * Why a line was not picked (in full) by the system, from its candidates: hold, no UR, no matched roll (and why each roll is
 * blocked), rolls that need a person (shared lot, checks, no barcode), lot QTY limits, or matched rolls that are short.
 */
export function notPickedWhy(c: Candidates | null, l: { hold?: string | null; status?: string | null }, err?: string): { reason: string; detail: string } {
  if (l.hold) return { reason: 'On hold', detail: l.hold };
  if (!c) return { reason: 'Could not check', detail: err || 'The rolls of this line could not be read.' };
  const open = r3n(c.need - c.picked);
  const ur = Number(c.ur ?? c.stock.reduce((t, x) => t + (Number(x.ur) || 0), 0));
  const avail = c.rolls.filter((r) => r.available > 1e-9);
  const why = new Map<string, number>();
  for (const b of c.blocked || []) { const k = b.why.split(' — ')[0].replace(/(Barcode|SO) [A-Z0-9]+/g, '$1').slice(0, 70); why.set(k, (why.get(k) ?? 0) + 1); }
  const blockedTxt = Array.from(why).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, n]) => `${k} (${n})`).join('; ');
  if (!(ur > 1e-9)) return { reason: 'No UR in ZMMBE', detail: c.sent ? `Already sent ${r3n(c.sent)} — nothing left in the warehouse UR` : 'ZMMBE has no Unrestricted stock for this SO / LI (QI, Block or Assigned only, or not in ZMMBE)' };
  if (!(open > 1e-9)) return { reason: 'Nothing left to pick', detail: `Need ${r3n(c.need)}, picked ${r3n(c.picked)}` };
  if (!c.lots.length) return { reason: 'No ZINSR inspection lot', detail: 'ZINSR has no lot for this SO / LI / Material and its ZMMBE batch' };
  if (!avail.length) {
    if ((c.nobarcode || []).some((m) => !m.done)) return { reason: 'Needs manual choice — no barcode', detail: `${(c.nobarcode || []).filter((m) => !m.done).length} ZCOMENT roll(s) without a Barcode Number: choose the Korber roll by hand` };
    if ((c.manual || []).length) return { reason: 'Needs manual choice — not matched', detail: `${c.manual!.length} ZCOMENT roll(s) do not match a Korber pallet (Lot / HU / Invoice / Po differ)${blockedTxt ? ' · ' + blockedTxt : ''}` };
    if (c.gate?.on && !c.gate.loaded) return { reason: 'No ZROLLMGT', detail: 'ZROLLMGT is not uploaded for this Pick' };
    if (blockedTxt) return { reason: 'Rolls blocked', detail: blockedTxt };
    return { reason: 'No matching roll', detail: 'No Korber roll matched ZINSR → ZCOMENT VIEW → Korber for this line' };
  }
  const autoAvail = r3n(avail.filter((r) => !r.pool && !r.needsConfirm).reduce((t, r) => t + r.available, 0));
  const lotRoom = r3n(c.lots.reduce((t, x) => t + Math.max(0, Number(x.cap ?? x.need ?? 0)), 0));
  if (avail.some((r) => r.pool) && autoAvail < open - 1e-9) return { reason: 'Needs manual choice — shared lot', detail: `The Lot Number is shared by ${Math.max(...avail.map((r) => r.pool || 0))} SO lines: tick this line's rolls (${avail.filter((r) => r.suggested).length} suggested)` };
  if (avail.some((r) => r.needsConfirm) && autoAvail < open - 1e-9) return { reason: 'Needs checking', detail: Array.from(new Set(avail.filter((r) => r.needsConfirm).flatMap((r) => r.warnings))).slice(0, 3).join('; ') };
  if (c.lots.some((x) => x.cap != null) && lotRoom < open - 1e-9) return { reason: 'ZINSR lot QTY used up', detail: `The ZINSR lots give ${lotRoom} more; ${open} is open` };
  const matched = r3n(c.matchedAvail ?? avail.reduce((t, r) => t + r.available, 0));
  if (matched < open - 1e-9) return { reason: 'Matched rolls short', detail: `Matched rolls have ${matched}; ${open} is open${blockedTxt ? ' · blocked: ' + blockedTxt : ''}` };
  return { reason: 'Not picked yet', detail: `${avail.length} matched roll(s) with ${matched} — pick them (Pick all matched or by hand)` };
}
const r3n = (n: number) => Math.round(n * 1000) / 1000;

export interface PLIssue { level: 'error' | 'warn'; pallet: string; so: string; li: string; item: string; what: string }
export function packingListWorkbook(h: PickHistory, opts: { korberSheet?: boolean; ids?: Set<number> | number[]; combined?: boolean; pfcSlocs?: string[]; /** the Pick's plan lines (dashboard table) → a "Plan" sheet */ plan?: Line[]; planTitle?: string; /** filled with the problems found (SAP and Korber data checked) */ issues?: PLIssue[]; /** plan lines the system did not pick, and why → a "Not Picked" sheet */ notPicked?: NotPicked[]; /** plant code → name (Settings → Plants) */ plantNames?: Record<string, string> } = {}) {
  const only = opts.ids ? new Set(opts.ids) : null;
  const reqs = h.requests.filter((r) => !r.cancelled_at && (!only || !only.size || only.has(r.id)));
  const header = (h.korberHeader || []).map(hn);
  const col = (names: string[]) => names.map((n) => header.indexOf(n)).find((i) => i >= 0) ?? -1;
  const pfc = new Set((opts.pfcSlocs?.length ? opts.pfcSlocs : ['41', 'COMF']).map(canonSloc));
  const U = XLSXS.utils;
  const wb = U.book_new();
  const multi = new Set(reqs.map((r) => r.by_user)).size > 1;
  // picks of several days (a whole plan): the day goes in front, the 1st of each day is its own
  const multiDay = new Set(reqs.map((r) => r.day)).size > 1;
  const reqName = (r: PickReq) => `${multiDay ? r.day.slice(8, 10) + '-' + r.day.slice(5, 7) + ' ' : ''}${multi ? `${r.by_user} ` : ''}${ordinal(r.seq)}`;
  const pickNoOf = (r: PickReq) => (r.pick_no && /^\d+$/.test(r.pick_no) ? Number(r.pick_no) : (r.pick_no ?? ''));
  const rollsOf = (r: PickReq) => h.picks.filter((p) => p.req_id === r.id && !p.cancelled_at);
  const korberPicks: PickRoll[] = [];

  interface Entry { r: PickReq; p: PickRoll; raw: unknown[]; kind: 'KFC' | 'PFC'; sapKind: 'KFC' | 'PFC'; client: string | null; clientKind: 'KFC' | 'PFC' | null; group: string; row: (string | number | null)[]; batches: { batch: string; qty: number }[] }
  const entries: Entry[] = [];
  const bkey = (v: unknown) => String(v ?? '').trim().replace(/^0+(?=\d)/, '');
  for (const r of reqs) {
    const m = parseMatch(r);
    const slocOf = new Map((m.zinr || []).map((z) => [String(z.lot ?? '').replace(/^0+/, ''), canonSloc(z.sloc)]));
    // KFC / PFC = the ZMMBE storage location of the roll's batch (SO + LI + Material + Batch): PFC locations (41, COMF) → PFC.
    // A batch in both: its KFC UR first, then PFC. No ZMMBE row of the batch: the inspection lot's storage location.
    const zrows = [...(m.zmmbe || []), ...(r.zstock || [])] as Record<string, unknown>[];
    const left = new Map<string, { KFC: number; PFC: number }>();
    const kindsOf = new Map<string, Set<'KFC' | 'PFC'>>();
    for (const z of zrows) {
      const b = bkey(z.batch); const k = pfc.has(canonSloc(z.sloc)) ? 'PFC' : 'KFC';
      if (!kindsOf.has(b)) kindsOf.set(b, new Set()); kindsOf.get(b)!.add(k);
      const x = left.get(b) ?? { KFC: 0, PFC: 0 }; if (!left.has(b)) left.set(b, x);
      // the same row twice (kept with the pick and read again): counted once
      if (!zrows.slice(0, zrows.indexOf(z)).some((y) => bkey(y.batch) === b && canonSloc(y.sloc) === canonSloc(z.sloc) && Number(y.ur) === Number(z.ur))) x[k] += Math.max(0, Number(z.ur) || 0);
    }
    for (const p of rollsOf(r)) {
      const raw = (p.korber ? JSON.parse(p.korber) : []) as unknown[];
      korberPicks.push(p);
      const lots = String(p.insp_lot ?? '').split(',').map((x) => x.trim().replace(/^0+/, '')).filter(Boolean);
      const lotKind: 'KFC' | 'PFC' = pfc.has(lots.map((l) => slocOf.get(l)).find(Boolean) ?? '') ? 'PFC' : 'KFC';
      const got = { KFC: 0, PFC: 0 };
      for (const bt of rollBatches(r, m, p)) {
        const ks = kindsOf.get(bkey(bt.batch));
        if (!ks?.size) { got[lotKind] += bt.qty; continue; }
        if (ks.size === 1) { got[Array.from(ks)[0]] += bt.qty; continue; }
        // the batch is in a KFC and a PFC location: its KFC UR first, then PFC
        const x = left.get(bkey(bt.batch))!;
        const k = x.KFC >= bt.qty - 1e-9 || x.KFC >= x.PFC ? 'KFC' : 'PFC';
        got[k] += bt.qty; x[k] = Math.max(0, x[k] - bt.qty);
      }
      // SAP: where most of the roll's QTY is (ZMMBE storage location of its batch)
      const sapKind: 'KFC' | 'PFC' = got.PFC > got.KFC ? 'PFC' : 'KFC';
      const v = (c: string) => { const i = col(PL_SRC[c] ?? []); return i >= 0 ? raw[i] : null; };
      // Korber: the roll's Client Code — MASK = PFC, MASKRE = KFC (else the client prefix of its Item Number, MASK-… / MASKRE-…)
      const ccRaw = String((() => { const i = col(['client code']); return i >= 0 ? raw[i] : ''; })() ?? '').trim().toUpperCase();
      const client = ccRaw || (/^([A-Z]{2,10})-/.exec(String(v('Item Number') ?? '').trim().toUpperCase())?.[1] ?? null);
      const clientKind: 'KFC' | 'PFC' | null = client === 'MASK' ? 'PFC' : client === 'MASKRE' ? 'KFC' : null;
      // the sheet = the Korber client (where the roll physically is); SAP location when Korber has no client
      const kind: 'KFC' | 'PFC' = clientKind ?? sapKind;
      const row = PL_HEAD2.map((c) => (c === 'Actual Qty' ? Math.round(p.qty * 1000) / 1000 : c === 'Shade' ? p.shade ?? '' : c === 'Pick No' ? null : ((v(c) ?? '') as string | number)));
      const group = ['Asn Number', 'Po Number', 'Lot Number'].map((c) => String(v(c) ?? '').trim()).join('\u0001');
      entries.push({ r, p, raw, kind, sapKind, client, clientKind, group, row, batches: rollBatches(r, m, p) });
    }
  }

  // one pallet can be picked in pieces (several picks / batches): its pieces are one row, and it is a cut roll only when
  // the pieces together are less than the roll (Korber Actual Qty); pieces adding up to the whole roll are not a cut
  const aq = header.indexOf('actual qty');
  // the roll as it was when this pick took from it: a cut roll's balance picked later is the whole of what was left (not a cut)
  const fullOf = (e: Entry) => Math.max(0, (Number(e.p.roll_qty) || Number(aq >= 0 ? e.raw[aq] : 0) || 0) - (Number(e.p.prior) || 0));
  const palTotal = new Map<string, number>(), palFull = new Map<string, number>();
  for (const e of entries) {
    palTotal.set(e.p.pallet, (palTotal.get(e.p.pallet) ?? 0) + Number(e.p.qty));
    palFull.set(e.p.pallet, Math.max(palFull.get(e.p.pallet) ?? 0, fullOf(e)));
  }
  const isCut = (pallet: string) => { const full = palFull.get(pallet) ?? 0; return full > 0 ? (palTotal.get(pallet) ?? 0) < full - 0.0005 : false; };

  // check every roll before the file is made: the Korber row and the SAP lines must be right
  const issues: PLIssue[] = opts.issues ?? [];
  {
    const r3q = (x: number) => Math.round(x * 1000) / 1000;
    const nItem = (v: unknown) => String(v ?? '').trim().toUpperCase().replace(/^[A-Z]{2,10}-(?=[A-Z0-9])/, '').replace(/^0+(?=\d)/, '');
    const add = (e: Entry, level: PLIssue['level'], what: string) => issues.push({ level, pallet: e.p.pallet, so: String(e.r.so), li: String(e.r.li), item: String(e.r.item), what });
    for (const e of entries) {
      const v = (c: string) => { const i = col(PL_SRC[c] ?? []); return i >= 0 ? e.raw[i] : null; };
      // Korber: the row saved with the pick
      if (!e.raw.length) { add(e, 'error', 'No Korber Inventory row saved with this pick (Pallet, Lot, Asn, Po are empty)'); continue; }
      if (String(v('Pallet') ?? '').trim().toUpperCase() !== String(e.p.pallet).trim().toUpperCase()) add(e, 'error', `Korber row is pallet ${v('Pallet') ?? '–'}, not ${e.p.pallet}`);
      const ki = nItem(v('Item Number'));
      if (ki && ki !== nItem(e.r.item)) add(e, 'error', `Korber Item Number ${v('Item Number')} ≠ plan item ${e.r.item}`);
      for (const c of ['Lot Number', 'Asn Number', 'Po Number', 'Location Id']) if (!String(v(c) ?? '').trim()) add(e, 'warn', `Korber ${c} is empty`);
      // SAP: the roll's batches must be the SO line's ZMMBE batches and add up to the picked QTY
      const m = parseMatch(e.r);
      const lineB = new Set([...(m.zmmbe || []), ...(e.r.zstock || [])].map((z) => bkey((z as Record<string, unknown>).batch)).filter(Boolean));
      const bs = e.batches.filter((b) => b.qty > 1e-9);
      if (!bs.length || bs.some((b) => !String(b.batch ?? '').trim())) add(e, 'error', 'No SAP batch for this roll');
      else if (lineB.size && bs.some((b) => !lineB.has(bkey(b.batch)))) add(e, 'error', `SAP batch ${bs.filter((b) => !lineB.has(bkey(b.batch))).map((b) => b.batch).join(', ')} is not a ZMMBE batch of ${e.r.so} / ${e.r.li} (${Array.from(lineB).join(', ')})`);
      // the batch saved with the roll (the pick / its SAP allocation): the file puts a wrong one on the line's batch, so it is shown here
      const saved = [...String(e.p.batch ?? '').split(','), ...(m.alloc || []).filter((a) => a.pallet === e.p.pallet).map((a) => String(a.batch))].map((x) => x.trim()).filter(Boolean);
      const wrong = Array.from(new Set(saved.filter((b) => !lineB.has(bkey(b)))));
      if (lineB.size && saved.length && wrong.length) add(e, 'error', `Roll batch ${wrong.join(', ')} (saved with the pick) is not a ZMMBE batch of ${e.r.so} / ${e.r.li} — the file shows ${bs.map((b) => b.batch).join(', ')}`);
      const sq = r3q(bs.reduce((t, b) => t + b.qty, 0));
      if (Math.abs(sq - Number(e.p.qty)) > 0.0005) add(e, 'error', `SAP lines ${sq} ≠ picked QTY ${e.p.qty}`);
      if (!String(e.p.insp_lot ?? '').trim()) add(e, 'warn', 'No ZINSR inspection lot saved with this roll');
      if (!String(e.p.shade ?? '').trim()) add(e, 'warn', 'No shade (ZCOMENT VIEW) for this roll');
      if (e.clientKind && e.clientKind !== e.sapKind) add(e, 'warn', `Korber client ${e.client} (${e.clientKind}) but the SAP location of its batch is ${e.sapKind}`);
    }
    // a pallet picked for more than the roll
    for (const [pal, q] of palTotal) { const full = palFull.get(pal) ?? 0; if (full > 0 && q > full + 0.0005) { const e = entries.find((x) => x.p.pallet === pal)!; add(e, 'error', `Picked ${r3q(q)} — more than the roll (${full})`); } }
  }
  interface Merged { e: Entry; parts: Entry[]; qty: number }
  const mergeByPallet = (list: Entry[]) => {
    const by = new Map<string, Merged>();
    for (const e of list) { const m = by.get(e.p.pallet); if (m) { m.parts.push(e); m.qty += Number(e.p.qty); } else by.set(e.p.pallet, { e, parts: [e], qty: Number(e.p.qty) }); }
    return Array.from(by.values());
  };

  /** One sheet: the totals block, then a table per Asn + Po + Lot with its SAP lines under it. */
  const plSheet = (list0: Entry[]) => {
    const list = mergeByPallet(list0);
    const aoa: (string | number | null)[][] = [
      ['TOTAL QTY', 'TOTAL ROLLS', 'HJ PICK', null, null, 'TOTAL PICK', 'CUT ROLLS'],
      [null, null, null, null, null, null, null],
      [],
      [null, null],
      [],
    ];
    const qtyRanges: string[] = []; const headRows: number[] = []; const rollRows: number[] = []; const sapRows: number[] = []; const cutRows: number[] = []; const badRows: number[] = [];
    const groups = new Map<string, Merged[]>();
    for (const m of list) { const g = groups.get(m.e.group); if (g) g.push(m); else groups.set(m.e.group, [m]); }
    for (const g of groups.values()) {
      headRows.push(aoa.length); aoa.push([...PL_HEAD2]);
      const first = aoa.length;
      const seen = new Set<number>();
      for (const m of g) {
        const row = [...m.e.row];
        row[QTY_COL] = Math.round(m.qty * 1000) / 1000; // the pieces of the pallet together
        // the Pick No on each pick's first roll of the table
        const nos = m.parts.filter((x) => !seen.has(x.r.id)).map((x) => { seen.add(x.r.id); return pickNoOf(x.r); }).filter((x) => x !== '');
        row[PICKNO_COL] = nos.length ? (nos.length === 1 ? nos[0] : Array.from(new Set(nos)).join(', ')) : null;
        if (isCut(m.e.p.pallet)) cutRows.push(aoa.length);
        rollRows.push(aoa.length); aoa.push(row);
      }
      qtyRanges.push(`${U.encode_col(QTY_COL)}${first + 1}:${U.encode_col(QTY_COL)}${aoa.length}`);
      // the SAP lines of this table: SO | LI | Qty | Material | Batch, adding up to its Actual Qty
      const sap = new Map<string, (string | number)[]>();
      for (const e of g.flatMap((m) => m.parts)) for (const b of e.batches) {
        if (!(b.qty > 1e-9)) continue;
        const k = [e.r.so, e.r.li, e.r.item, String(b.batch).replace(/^0+(?=\d)/, '')].join('|');
        const had = sap.get(k);
        if (had) had[2] = Math.round(((had[2] as number) + b.qty) * 1000) / 1000;
        else sap.set(k, [String(e.r.so), num(e.r.li), Math.round(b.qty * 1000) / 1000, num(e.r.item), num(String(b.batch).replace(/^0+(?=\d)/, ''))]);
      }
      aoa.push([]);
      for (const row of sap.values()) { sapRows.push(aoa.length); aoa.push(row); }
      // the SAP lines must add up to the table's Actual Qty
      const tq = Math.round(g.reduce((t, m) => t + m.qty, 0) * 1000) / 1000;
      const sq = Math.round(Array.from(sap.values()).reduce((t, row) => t + Number(row[2]), 0) * 1000) / 1000;
      if (Math.abs(tq - sq) > 0.0005) { badRows.push(aoa.length); aoa.push([`CHECK: SAP lines ${sq} ≠ Actual Qty ${tq}`]); }
      for (const m of g) if (m.e.clientKind && m.e.clientKind !== m.e.sapKind) { badRows.push(aoa.length); aoa.push([`CHECK: ${m.e.p.pallet} — Korber client ${m.e.client} (${m.e.clientKind}) but SAP location of its batch is ${m.e.sapKind}`]); }
      aoa.push([]);
    }
    const qty = Math.round(list.reduce((t, m) => t + m.qty, 0) * 1000) / 1000;
    const picks = Array.from(new Set(list0.map((e) => e.r.id)));
    const pickNos = picks.map((id) => pickNoOf(reqs.find((r) => r.id === id)!)).filter((x) => x !== '');
    const cut = list.filter((m) => isCut(m.e.p.pallet)).length;
    const cust = String(list0.map((e) => { const i = col(['customer ref number']); return i >= 0 ? e.raw[i] : ''; }).find(Boolean) ?? '').split('-')[0];
    const days = Array.from(new Set(list0.map((e) => e.p.day))).sort();
    aoa[1] = [qty, list.length, pickNos.length === 1 ? pickNos[0] : pickNos.join(', '), null, null, pickNos.length, cut];
    // the plant: the one chosen in the system for the Pick (its Pick Id), with its name from Settings → Plants;
    // else the plan line's plant; the Korber customer ref only when the Pick has no plant
    const plants = Array.from(new Set(list0.map((e) => {
      const m = /^\d{4}-\d{2}-\d{2}~([^~]+)~\d+$/.exec(String(e.r.week || ''));
      const code = m && m[1] !== '-' ? m[1] : String(e.r.plant || '').trim();
      return code ? (opts.plantNames?.[code.toUpperCase()] || code) : '';
    }).filter(Boolean)));
    aoa[3] = [plants.join(', ') || cust || null, days.map((d) => d.split('-').reverse().join('-')).join(', ') || null];
    const ws = U.aoa_to_sheet(aoa);
    // totals as formulas over the tables' Actual Qty / Pallet cells
    if (qtyRanges.length) ws.A2 = { t: 'n', v: qty, f: `SUM(${qtyRanges.join(',')})` };
    const style = (ref: string, st: unknown) => { ws[ref] = ws[ref] || { t: 's', v: '' }; (ws[ref] as { s?: unknown }).s = st; };
    for (const c of ['A', 'B', 'C', 'F', 'G']) { style(c + '1', ST.top); style(c + '2', ST.top); }
    style('D1', ST.dark);
    style('A4', ST.top); style('B4', ST.top);
    for (const r0 of headRows) PL_HEAD2.forEach((_, i) => style(U.encode_col(i) + (r0 + 1), i === 4 || i === 8 || i === 9 ? ST.key : ST.head));
    for (const r0 of rollRows) PL_HEAD2.forEach((_, i) => style(U.encode_col(i) + (r0 + 1), ST.cell));
    // a cut roll: its Pallet and Actual Qty (the cut QTY) in red, so it is seen on the floor
    for (const r0 of cutRows) for (const i of [0, QTY_COL]) style(U.encode_col(i) + (r0 + 1), ST.cut);
    for (const r0 of sapRows) for (let i = 0; i < 5; i++) style(U.encode_col(i) + (r0 + 1), ST.match);
    for (const r0 of badRows) style('A' + (r0 + 1), ST.cut);
    ws['!cols'] = [17.5, 14, 19, 26, 12, 9, 12, 12, 24, 22, 22, 11, 10, 7, 12].map((w) => ({ wch: w }));
    return ws;
  };
  const usedNames = new Set<string>();
  const sheetName = (t: string) => {
    const base = t.replace(/[\\/?*[\]:]/g, '').slice(0, 31); let n = base, i = 2;
    while (usedNames.has(n.toLowerCase())) n = `${base.slice(0, 27)} (${i++})`;
    usedNames.add(n.toLowerCase()); return n;
  };
  const kinds: ('KFC' | 'PFC')[] = ['KFC', 'PFC'];
  if (opts.combined) {
    for (const k of kinds) { const list = entries.filter((e) => e.kind === k); if (list.length) U.book_append_sheet(wb, plSheet(list), `${k} Packing List`); }
  } else {
    for (const r of reqs) for (const k of kinds) {
      const list = entries.filter((e) => e.r.id === r.id && e.kind === k);
      if (list.length) U.book_append_sheet(wb, plSheet(list), sheetName(`${reqName(r)} ${k}`));
    }
  }
  // Cut Roll: every roll that is cut (its pieces add up to less than the roll), KFC and PFC on their own sheets — in the
  // Cut_Roll format (Korber Inventory columns, Actual Qty = the roll in Korber), then the cut QTY and what stays on the shelf
  const cutAll = mergeByPallet(entries).filter((m) => isCut(m.e.p.pallet));
  for (const k of kinds) {
    const list = cutAll.filter((m) => m.e.kind === k);
    if (list.length) U.book_append_sheet(wb, cutSheet(list.map((m) => {
      const v = (c: string) => { const i = col(PL_SRC[c] ?? []); return i >= 0 ? m.e.raw[i] : null; };
      const full = palFull.get(m.e.p.pallet) ?? 0;
      const nos = Array.from(new Set(m.parts.map((x) => pickNoOf(x.r)).filter((x) => x !== '')));
      return { v, full, cut: m.qty, lines: Array.from(new Set(m.parts.map((x) => `${x.r.so} / ${x.r.li} / ${x.r.item}`))).join(', '), pickNo: nos.join(', '), day: Array.from(new Set(m.parts.map((x) => x.p.day))).join(', ') };
    })), sheetName(`${k} Cut Roll`));
  }
  // Cut Roll Balance: each cut roll — what was cut for its own SO lines, where its balance was tallied (another SO line of
  // the same Material and LI, a ZINSR lot with the roll's Vendor Batch) with the SAP details of each, and what stays on the shelf
  {
    const isTally = (e: Entry) => String(e.p.note ?? '').startsWith('Cut roll balance tallied');
    const pals = Array.from(new Set(entries.filter((e) => isCut(e.p.pallet) || isTally(e)).map((e) => e.p.pallet)));
    if (pals.length) {
      const head = ['Pallet', 'Location Id', 'Item Number', 'Description', 'Lot Number (Vendor Batch)', 'Roll Qty', 'Piece', 'SO', 'LI', 'Material', 'Qty', 'SAP Batch', 'St Loc', 'SAP Plant', 'ZINSR Lot', 'Sheet', 'Pick No', 'Picked on', 'Balance after', 'Note'];
      const aoa: (string | number | null)[][] = [];
      const top: (string | number | null)[][] = [['CUT ROLL BALANCE', null, `${pals.length} roll${pals.length === 1 ? '' : 's'}`], []];
      const tq2 = (x: number) => Math.round(x * 1000) / 1000;
      const styleRows: { r: number; st: 'roll' | 'tally' | 'left' }[] = [];
      let tallied = 0, onShelf = 0;
      for (const pal of pals) {
        const es = entries.filter((e) => e.p.pallet === pal).sort((x, y) => Number(isTally(x)) - Number(isTally(y)) || String(x.p.at ?? '').localeCompare(String(y.p.at ?? '')));
        const e0 = es[0];
        const v = (c: string) => { const i = col(PL_SRC[c] ?? []); return i >= 0 ? e0.raw[i] : null; };
        const full = palFull.get(pal) ?? 0;
        let left = full;
        es.forEach((e, i) => {
          const m = parseMatch(e.r);
          const zrows = [...(m.zmmbe || []), ...(e.r.zstock || [])] as Record<string, unknown>[];
          const bs = e.batches.length ? e.batches : [{ batch: String(e.p.batch ?? '').split(',')[0], qty: Number(e.p.qty) }];
          left = tq2(left - Number(e.p.qty));
          if (isTally(e)) tallied = tq2(tallied + Number(e.p.qty));
          bs.forEach((bt, j) => {
            const z = zrows.find((x) => bkey(x.batch) === bkey(bt.batch));
            const last = j === bs.length - 1;
            styleRows.push({ r: aoa.length, st: isTally(e) ? 'tally' : 'roll' });
            aoa.push([i === 0 && j === 0 ? pal : null, i === 0 && j === 0 ? (v('Location Id') as string) ?? '' : null, i === 0 && j === 0 ? (v('Item Number') as string) ?? '' : null, i === 0 && j === 0 ? (v('Description') as string) ?? '' : null,
              i === 0 && j === 0 ? (v('Lot Number') as string) ?? e.p.lot ?? '' : null, i === 0 && j === 0 ? full : null,
              isTally(e) ? 'Balance tallied' : 'Cut for', String(e.r.so), num(e.r.li), num(e.r.item), tq2(bt.qty),
              bkey(bt.batch) || '', z ? String(z.sloc ?? '') : '', z ? String(z.so_plant ?? z.plant ?? '') : '', String(e.p.insp_lot ?? ''), e.kind,
              pickNoOf(e.r), e.p.day ? e.p.day.split('-').reverse().join('-') : '', last ? left : null,
              isTally(e) ? (/roll \S+ cut for ([^;]+);/.exec(String(e.p.note))?.[1] ? `From the cut for ${/roll \S+ cut for ([^;]+);/.exec(String(e.p.note))![1]}` : 'Tallied') : '']);
          });
        });
        styleRows.push({ r: aoa.length, st: 'left' });
        aoa.push([null, null, null, null, null, null, 'On the shelf', null, null, null, Math.max(0, left), null, null, null, null, null, null, null, Math.max(0, left), left > 0.0005 ? 'Stays in Korber (not tallied)' : 'Whole roll used']);
        onShelf = tq2(onShelf + Math.max(0, left));
        aoa.push([]);
      }
      top[0].push(null, null, 'Tallied', tallied, null, 'On the shelf', onShelf);
      const ws = U.aoa_to_sheet([...top, head, ...aoa]);
      const hr = top.length;
      for (let i = 0; i < head.length; i++) { const ref = U.encode_cell({ r: hr, c: i }); (ws[ref] as { s?: unknown }).s = ST.head; }
      for (let i = 0; i < 10; i++) { const ref = U.encode_cell({ r: 0, c: i }); if (ws[ref]) (ws[ref] as { s?: unknown }).s = ST.top; }
      for (const x of styleRows) for (let c = 0; c < head.length; c++) {
        const ref = U.encode_cell({ r: hr + 1 + x.r, c });
        if (!ws[ref]) ws[ref] = { t: 's', v: '' };
        (ws[ref] as { s?: unknown }).s = x.st === 'tally' ? ST.match : x.st === 'left' ? ST.cut : ST.cell;
      }
      ws['!cols'] = [17, 14, 20, 30, 16, 9, 15, 12, 5, 12, 10, 12, 8, 10, 24, 6, 9, 11, 12, 36].map((w) => ({ wch: w }));
      U.book_append_sheet(wb, ws, 'Cut Roll Balance');
    }
  }
  // Summary: one line per pick, its KFC and PFC QTY
  const summary: (string | number | null)[][] = [['Req', 'Total Qty', 'KFC Qty', 'PFC Qty', 'Total Rolls', 'Pick No', 'Type', 'Remarks']];
  for (const r of reqs) {
    const es = entries.filter((e) => e.r.id === r.id);
    const q = (f: (e: Entry) => boolean) => Math.round(es.filter(f).reduce((t, e) => t + e.p.qty, 0) * 1000) / 1000;
    const pals = Array.from(new Set(es.map((e) => e.p.pallet)));
    const cut = pals.filter(isCut).length;
    summary.push([reqName(r), q(() => true), q((e) => e.kind === 'KFC'), q((e) => e.kind === 'PFC'), pals.length, pickNoOf(r), r.kind === 'offsite' ? 'Offsite' : 'Normal',
      `${r.so} / ${r.li} / ${r.item}${cut ? ` · ${cut} cut roll${cut > 1 ? 's' : ''}` : ''}${r.closed ? ` · closed ${r.short ?? ''} short` : ''}${multi ? ` · ${r.by_user}` : ''}`]);
  }
  const n = summary.length;
  summary.push(['Total', null, null, null, null]);
  const sws = U.aoa_to_sheet(summary);
  for (const c of ['B', 'C', 'D']) sws[`${c}${n + 1}`] = { t: 'n', v: summary.slice(1, n).reduce((t, row) => t + Number(row['BCD'.indexOf(c) + 1] || 0), 0), f: `SUM(${c}2:${c}${n})` };
  // rolls: a pallet picked in pieces by several picks counts once
  sws[`E${n + 1}`] = { t: 'n', v: new Set(entries.map((e) => e.p.pallet)).size };
  sws['!cols'] = [{ wch: multi ? 16 : 8 }, { wch: 11 }, { wch: 10 }, { wch: 10 }, { wch: 11 }, { wch: 14 }, { wch: 9 }, { wch: 52 }];
  U.book_append_sheet(wb, sws, 'Summary');
  // Tally: each pick (one SO / LI / Item) — picked QTY = KFC + PFC sheets = its SAP lines (batch by batch)
  const tally: (string | number | null)[][] = [['Req', 'SO', 'LI', 'Item', 'Picked Qty', 'Rolls', 'KFC Qty', 'PFC Qty', 'SAP lines Qty', 'Batches (SAP lines)', 'Korber client / SAP location', 'Check']];
  const tq = (x: number) => Math.round(x * 1000) / 1000;
  for (const r of reqs) {
    const es = entries.filter((e) => e.r.id === r.id);
    const picked = tq(es.reduce((t, e) => t + Number(e.p.qty), 0));
    const k = tq(es.filter((e) => e.kind === 'KFC').reduce((t, e) => t + Number(e.p.qty), 0)), pf = tq(es.filter((e) => e.kind === 'PFC').reduce((t, e) => t + Number(e.p.qty), 0));
    const byB = new Map<string, number>();
    for (const e of es) for (const b of e.batches) { const bb = String(b.batch).replace(/^0+(?=\d)/, '') || '–'; byB.set(bb, tq((byB.get(bb) ?? 0) + b.qty)); }
    const sapQ = tq(Array.from(byB.values()).reduce((t, x) => t + x, 0));
    const clash = es.filter((e) => e.clientKind && e.clientKind !== e.sapKind);
    const where = Array.from(new Set(es.map((e) => `${e.client ?? '–'} → ${e.kind}${e.clientKind && e.clientKind !== e.sapKind ? ` (SAP ${e.sapKind})` : ''}`))).join(' · ');
    const ok = Math.abs(picked - (k + pf)) <= 0.0005 && Math.abs(picked - sapQ) <= 0.0005 && !clash.length;
    tally.push([reqName(r), String(r.so), num(r.li), num(r.item), picked, new Set(es.map((e) => e.p.pallet)).size, k, pf, sapQ,
      Array.from(byB).map(([b, q0]) => `${b}: ${q0}`).join(' · '), where,
      ok ? '✓' : Math.abs(picked - sapQ) > 0.0005 ? `✗ ${tq(picked - sapQ)}` : `✗ ${clash.length} roll${clash.length === 1 ? '' : 's'}: Korber client ≠ SAP location`]);
  }
  const tn = tally.length;
  tally.push(['Total', null, null, null, ...[4, 5, 6, 7, 8].map((i) => tq(tally.slice(1).reduce((t, row) => t + Number(row[i] || 0), 0))), null, null, tally.slice(1).every((row) => row[11] === '✓') ? '✓' : '✗']);
  const tws = U.aoa_to_sheet(tally);
  for (let i = 0; i < 12; i++) { const ref = U.encode_cell({ r: 0, c: i }); (tws[ref] as { s?: unknown }).s = ST.head; const t = U.encode_cell({ r: tn, c: i }); if (tws[t]) (tws[t] as { s?: unknown }).s = ST.top; }
  for (let r = 1; r < tn; r++) { const ref = U.encode_cell({ r, c: 11 }); if (tws[ref] && tally[r][11] !== '✓') (tws[ref] as { s?: unknown }).s = ST.cut; }
  tws['!cols'] = [10, 13, 5, 12, 11, 7, 10, 10, 13, 36, 26, 14].map((w) => ({ wch: w }));
  U.book_append_sheet(wb, tws, 'Tally');
  // the plan lines the system could not pick (in full), and why
  if (opts.notPicked) {
    const np = opts.notPicked;
    const head = ['Pick', 'SO', 'LI', 'Item', 'Plant', 'Plan date', 'Plan QTY', 'UR', 'Picked', 'Balance', 'Matched rolls QTY', 'Why not picked', 'Detail'];
    const rows = np.map((x) => [x.pick, x.so, num(x.li), num(x.item), x.plant ?? '', x.date ? x.date.split('-').reverse().join('-') : '', x.planQty, x.ur, x.picked, x.balance, x.matched, x.reason, x.detail]);
    // a count per reason on top
    const byWhy = new Map<string, { n: number; q: number }>();
    for (const x of np) { const v = byWhy.get(x.reason) ?? { n: 0, q: 0 }; v.n++; v.q = tq(v.q + x.balance); byWhy.set(x.reason, v); }
    const top: (string | number | null)[][] = [['NOT PICKED BY THE SYSTEM', null, `${np.length} line${np.length === 1 ? '' : 's'}`, null, null, null, null, null, null, tq(np.reduce((t, x) => t + x.balance, 0))],
      ...Array.from(byWhy).sort((a, b) => b[1].n - a[1].n).map(([k, v]) => [k, null, `${v.n} line${v.n === 1 ? '' : 's'}`, null, null, null, null, null, null, v.q]), []];
    const nws = U.aoa_to_sheet(np.length ? [...top, head, ...rows] : [['Every plan line of these Picks was picked in full by the system.']]);
    if (np.length) {
      const hr = top.length;
      for (let i = 0; i < head.length; i++) { const ref = U.encode_cell({ r: hr, c: i }); (nws[ref] as { s?: unknown }).s = ST.head; }
      const t0 = U.encode_cell({ r: 0, c: 0 }); (nws[t0] as { s?: unknown }).s = ST.top;
      rows.forEach((_, i) => { const ref = U.encode_cell({ r: hr + 1 + i, c: 11 }); if (nws[ref]) (nws[ref] as { s?: unknown }).s = ST.cut; });
    }
    nws['!cols'] = [24, 13, 5, 12, 12, 11, 10, 10, 10, 10, 12, 30, 90].map((w) => ({ wch: w }));
    U.book_append_sheet(wb, nws, 'Not Picked');
  }
  // the checks of the SAP and Korber data (only when something was found)
  if (issues.length) {
    const cws = U.aoa_to_sheet([['Level', 'Pallet', 'SO', 'LI', 'Item', 'Check'], ...issues.map((x) => [x.level === 'error' ? 'ERROR' : 'CHECK', x.pallet, x.so, num(x.li), num(x.item), x.what])]);
    for (let i = 0; i < 6; i++) { const ref = U.encode_cell({ r: 0, c: i }); (cws[ref] as { s?: unknown }).s = ST.head; }
    issues.forEach((x, i) => { const ref = U.encode_cell({ r: i + 1, c: 0 }); (cws[ref] as { s?: unknown }).s = x.level === 'error' ? ST.cut : ST.key; });
    cws['!cols'] = [8, 18, 13, 5, 12, 80].map((w) => ({ wch: w }));
    U.book_append_sheet(wb, cws, 'Checks');
  }
  // the dashboard's plan table of the Pick(s): what was planned, picked, still open, UR / Korber on the shelf
  if (opts.plan?.length) {
    const aoa = planTableAoa(opts.plan);
    const pws = U.aoa_to_sheet([[opts.planTitle || 'Plan'], [], ...aoa]);
    const hr = 2, last = hr + aoa.length - 1;
    aoa[0].forEach((_, i) => { const ref = U.encode_cell({ r: hr, c: i }); (pws[ref] as { s?: unknown }).s = ST.head; });
    for (let r = hr + 1; r <= last; r++) aoa[0].forEach((_, i) => { const ref = U.encode_cell({ r, c: i }); pws[ref] = pws[ref] || { t: 's', v: '' }; (pws[ref] as { s?: unknown }).s = r === last ? ST.top : ST.cell; });
    (pws.A1 as { s?: unknown }).s = { font: { bold: true, sz: 13 } };
    pws['!cols'] = [12, 12, 5, 12, 11, 12, 10, 10, 10, 10, 10, 11, 8, 8, 8, 16, 12, 16, 24, 20].map((w) => ({ wch: w }));
    pws['!autofilter'] = { ref: `A${hr + 1}:${U.encode_col(aoa[0].length - 1)}${last}` };
    U.book_append_sheet(wb, pws, 'Plan');
  }
  if (opts.korberSheet !== false && h.korberHeader) {
    U.book_append_sheet(wb, korberSheet(h.korberHeader, korberPicks), 'Korber Inventory');
  }
  return wb;
}

/** The Cut_Roll format: Pick Id … Actual Qty (Korber), then Cut Qty | Balance Qty | SO / LI / Item | HJ Pick No | Picked on. */
const CUT_HEAD = ['Pick Id', 'Pallet', 'Location Id', 'Item Number', 'Description', 'Lot Number', 'Supplier Hu', 'Color', 'Plant', 'Asn Number', 'Po Number', 'Customer Ref Number', 'Item Id', 'Actual Qty'];
const CUT_EXTRA = ['Cut Qty', 'Balance Qty', 'SO / LI / Item', 'HJ Pick No', 'Picked on'];
function cutSheet(rows: { v: (c: string) => unknown; full: number; cut: number; lines: string; pickNo: string; day: string }[]) {
  const U = XLSXS.utils;
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  const aoa: (string | number | null)[][] = [[...CUT_HEAD, ...CUT_EXTRA]];
  for (const x of rows) {
    aoa.push([
      ...CUT_HEAD.map((c) => (c === 'Actual Qty' ? r3(x.full) : c === 'Pick Id' ? ((x.v('Pick Id') ?? 0) as string | number) : ((x.v(c) ?? '') as string | number))),
      r3(x.cut), r3(Math.max(0, x.full - x.cut)), x.lines, num(x.pickNo), x.day.split(', ').map((d) => d.split('-').reverse().join('-')).join(', '),
    ]);
  }
  const ws = U.aoa_to_sheet(aoa);
  const head = { font: { bold: true, color: { rgb: 'FFFFFF' }, name: 'Calibri', sz: 11 }, fill: { patternType: 'solid', fgColor: { rgb: '000000' } }, alignment: { horizontal: 'center', vertical: 'center' }, border: BOX };
  for (let c = 0; c < CUT_HEAD.length + CUT_EXTRA.length; c++) {
    const ref = U.encode_cell({ r: 0, c }); (ws[ref] as { s?: unknown }).s = c < CUT_HEAD.length ? head : ST.cutHead;
    for (let r = 1; r < aoa.length; r++) { const rf = U.encode_cell({ r, c }); ws[rf] = ws[rf] || { t: 's', v: '' }; (ws[rf] as { s?: unknown }).s = c === CUT_HEAD.length ? ST.cut : ST.cell; }
  }
  ws['!cols'] = [9, 17, 14, 15, 15, 14, 13, 11, 9, 13, 13, 21, 12, 11, 10, 11, 30, 12, 11].map((w) => ({ wch: w }));
  ws['!autofilter'] = { ref: `A1:${U.encode_col(CUT_HEAD.length + CUT_EXTRA.length - 1)}${aoa.length}` };
  return ws;
}

/** Writes a workbook with its cell styles (fills, borders) kept. */
export function saveWorkbook(wb: XLSX.WorkBook, file: string) {
  XLSXS.writeFile(wb, file, { cellStyles: true });
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

/**
 * The picked rolls in the Korber Inventory format (the uploaded file's columns, Actual Qty = the picked QTY), and after them
 * Cut Roll | Korber Qty | Balance Qty. A cut roll's row is red: "CUT", the roll's Korber QTY and what stays on the shelf.
 */
function korberSheet(korberHeader: unknown[], picks: PickRoll[]) {
  const U = XLSXS.utils;
  const header = korberHeader.map(hn);
  const qi = header.indexOf('actual qty');
  const n = korberHeader.length;
  const aoa: (string | number | null)[][] = [[...(korberHeader as (string | number)[]), 'Cut Roll', 'Korber Qty', 'Balance Qty']];
  const cut: number[] = [];
  // the pieces of one pallet (picked in parts) are one row; it is "CUT" only when they add up to less than the roll
  const by = new Map<string, { p: PickRoll; raw: unknown[]; qty: number; full: number }>();
  for (const p of picks) {
    const raw = (p.korber ? JSON.parse(p.korber) : []) as unknown[];
    const full = Math.max(0, (Number(p.roll_qty) || Number(qi >= 0 ? raw[qi] : 0) || 0) - (Number(p.prior) || 0));
    const had = by.get(p.pallet);
    if (had) { had.qty += Number(p.qty); had.full = Math.max(had.full, full); } else by.set(p.pallet, { p, raw, qty: Number(p.qty), full });
  }
  for (const x of by.values()) {
    const row = pickedRow(x.raw, header, x.qty) as (string | number | null)[];
    while (row.length < n) row.push(null);
    const full = Math.round(x.full * 1000) / 1000;
    if (x.full > 0 && x.qty < x.full - 0.0005) { cut.push(aoa.length); row.push('CUT', full, Math.round(Math.max(0, x.full - x.qty) * 1000) / 1000); }
    else row.push(null, full || null, null);
    aoa.push(row);
  }
  const ws = U.aoa_to_sheet(aoa);
  const st = (r: number, c: number, s: unknown) => { const ref = U.encode_cell({ r, c }); ws[ref] = ws[ref] || { t: 's', v: '' }; (ws[ref] as { s?: unknown }).s = s; };
  for (let c = n; c < n + 3; c++) st(0, c, ST.cutHead);
  for (const r of cut) for (let c = 0; c < n + 3; c++) st(r, c, ST.cut);
  ws['!cols'] = [...Array.from({ length: n }, () => ({ wch: 14 })), { wch: 9 }, { wch: 11 }, { wch: 12 }];
  return ws;
}

/** The picked rolls only (the marked picks, or all), in the Korber Inventory format; cut rolls marked (see korberSheet). */
export function korberWorkbook(h: PickHistory, ids?: Set<number> | number[]) {
  const only = ids ? new Set(ids) : null;
  const picks = h.picks.filter((p) => !p.cancelled_at && (!only || !only.size || only.has(p.req_id)) && h.requests.some((r) => r.id === p.req_id && !r.cancelled_at));
  const wb = XLSXS.utils.book_new();
  XLSXS.utils.book_append_sheet(wb, korberSheet(h.korberHeader || [], picks), 'Sheet1');
  return wb;
}

/** a "PLANT-DD" plan sheet (ASIALLINE-23) */
export const PLAN_SHEET = /^\s*([A-Za-z][A-Za-z .&]*?)\s*[-_ ]\s*(\d{1,2})\s*$/;
export const squash = (v: string) => v.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/(.)\1+/g, '$1');
/** the other sheets of such a workbook → the pick report they are */
/** A pick report found by its columns (a sheet called "Sheet1"): ZINSR, ZCOMENT VIEW, ZMM_TRR, ZROLLMGT or Korber Inventory. */
export function pickSrcOfGrid(grid: Grid): PickSrc | null {
  for (const src of ['zinr', 'zcoment', 'ztrr', 'zroll', 'korber'] as PickSrc[]) if (findTable([{ name: '', grid }], src)) return src;
  return null;
}
/** By the sheet name, else (one data sheet) the file name, else the columns. */
export function pickSrcOfSheet(sheet: string, grid: Grid, fileName?: string, onlySheet = false): PickSrc | null {
  return pickSrcOf(sheet) ?? (onlySheet && fileName ? pickSrcOf(fileName.replace(/\.\w+$/, '').replace(/^[0-9a-f]{6,}[-_ ]/i, '')) : null) ?? pickSrcOfGrid(grid);
}
export function pickSrcOf(name: string): PickSrc | null {
  const n = name.toUpperCase().replace(/[^A-Z]/g, '');
  if (/^ZINSR|^ZINR/.test(n)) return 'zinr';
  if (/^SHADE|^ZCOMENT/.test(n)) return 'zcoment';
  if (/^ZROLLMGT/.test(n)) return 'zroll';
  if (/^KORBER|^INVENTORY/.test(n)) return 'korber';
  if (/^ZMMTRR|^TRR/.test(n)) return 'ztrr';
  return null;
}
