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
  /** the rest of the roll stays with this SO Plant (ZMMBE): no need to cut */
  sameSoPlant?: { plant: string; lines: string[] };
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
export interface NoBarcodeRoll extends Omit<ManualRoll, 'reason' | 'suggest'> { options: NbOption[]; /** its Korber roll was picked in full already */ done?: boolean; /** an inspection lot with no Shade Report in ZCOMENT: roll_qty = the lot QTY */ noShade?: boolean; /** its ZCOMENT barcode is not a Korber pallet */ zcBarcode?: string }
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
  'Supplier Hu': ['supplier hu'], Color: ['color'], Plant: ['plant'], 'Asn Number': ['asn number'], 'Po Number': ['po number'], 'Customer Ref Number': ['customer ref number'], 'Item Id': ['item id'],
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
  const own = (m.alloc || []).filter((a) => a.pallet === p.pallet);
  if (own.length) return own.map((a) => ({ batch: a.batch, qty: Number(a.qty) }));
  const bts = String(p.batch ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  if (bts.length <= 1) return [{ batch: bts[0] ?? '', qty: Number(p.qty) }];
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
export function packingListWorkbook(h: PickHistory, opts: { korberSheet?: boolean; ids?: Set<number> | number[]; combined?: boolean; pfcSlocs?: string[] } = {}) {
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

  interface Entry { r: PickReq; p: PickRoll; raw: unknown[]; kind: 'KFC' | 'PFC'; group: string; row: (string | number | null)[]; batches: { batch: string; qty: number }[] }
  const entries: Entry[] = [];
  for (const r of reqs) {
    const m = parseMatch(r);
    const slocOf = new Map((m.zinr || []).map((z) => [String(z.lot ?? '').replace(/^0+/, ''), canonSloc(z.sloc)]));
    for (const p of rollsOf(r)) {
      const raw = (p.korber ? JSON.parse(p.korber) : []) as unknown[];
      korberPicks.push(p);
      const lots = String(p.insp_lot ?? '').split(',').map((x) => x.trim().replace(/^0+/, '')).filter(Boolean);
      const sloc = lots.map((l) => slocOf.get(l)).find(Boolean) ?? canonSloc((m.zmmbe || [])[0]?.sloc);
      const kind: 'KFC' | 'PFC' = pfc.has(sloc ?? '') ? 'PFC' : 'KFC';
      const v = (c: string) => { const i = col(PL_SRC[c] ?? []); return i >= 0 ? raw[i] : null; };
      const row = PL_HEAD2.map((c) => (c === 'Actual Qty' ? Math.round(p.qty * 1000) / 1000 : c === 'Shade' ? p.shade ?? '' : c === 'Pick No' ? null : ((v(c) ?? '') as string | number)));
      const group = ['Asn Number', 'Po Number', 'Lot Number'].map((c) => String(v(c) ?? '').trim()).join('\u0001');
      entries.push({ r, p, raw, kind, group, row, batches: rollBatches(r, m, p) });
    }
  }

  // one pallet can be picked in pieces (several picks / batches): its pieces are one row, and it is a cut roll only when
  // the pieces together are less than the roll (Korber Actual Qty); pieces adding up to the whole roll are not a cut
  const aq = header.indexOf('actual qty');
  const fullOf = (e: Entry) => Number(e.p.roll_qty) || Number(aq >= 0 ? e.raw[aq] : 0) || 0;
  const palTotal = new Map<string, number>(), palFull = new Map<string, number>();
  for (const e of entries) {
    palTotal.set(e.p.pallet, (palTotal.get(e.p.pallet) ?? 0) + Number(e.p.qty));
    palFull.set(e.p.pallet, Math.max(palFull.get(e.p.pallet) ?? 0, fullOf(e)));
  }
  const isCut = (pallet: string) => { const full = palFull.get(pallet) ?? 0; return full > 0 ? (palTotal.get(pallet) ?? 0) < full - 0.0005 : false; };
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
    const qtyRanges: string[] = []; const headRows: number[] = []; const rollRows: number[] = []; const sapRows: number[] = []; const cutRows: number[] = [];
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
      aoa.push([]);
    }
    const qty = Math.round(list.reduce((t, m) => t + m.qty, 0) * 1000) / 1000;
    const picks = Array.from(new Set(list0.map((e) => e.r.id)));
    const pickNos = picks.map((id) => pickNoOf(reqs.find((r) => r.id === id)!)).filter((x) => x !== '');
    const cut = list.filter((m) => isCut(m.e.p.pallet)).length;
    const cust = String(list0.map((e) => { const i = col(['customer ref number']); return i >= 0 ? e.raw[i] : ''; }).find(Boolean) ?? '').split('-')[0];
    const days = Array.from(new Set(list0.map((e) => e.p.day))).sort();
    aoa[1] = [qty, list.length, pickNos.length === 1 ? pickNos[0] : pickNos.join(', '), null, null, pickNos.length, cut];
    aoa[3] = [cust || null, days.map((d) => d.split('-').reverse().join('-')).join(', ') || null];
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
  if (opts.korberSheet !== false && h.korberHeader) {
    U.book_append_sheet(wb, korberSheet(h.korberHeader, korberPicks), 'Korber Inventory');
  }
  return wb;
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
    const full = Number(p.roll_qty) || Number(qi >= 0 ? raw[qi] : 0) || 0;
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
