'use client';
import * as XLSX from 'xlsx';
import * as XLSXS from 'xlsx-js-style';
import { api } from './api';

/**
 * v179: Plan_Format check. A Plan_Format file (SO, LI, Item Code, Date, QTY, …) is checked against every pick the system has
 * sent for the same SO / LI / Item: each line is marked Sent / Partly sent / Not sent with the QTY sent and the balance, and a
 * report lists every roll that was sent (Pick, Korber roll, SAP batch and Vendor Batch). Worked out in the browser.
 */
export interface SentPick {
  so: string; li: string; item: string; day: string | null; pick_no: string | null; seq: number | null; plan: string | null; plant: string | null;
  kind: string; auto: number; pallet: string; qty: number; roll_qty: number | null; cut: number; lot: string | null; hu: unknown; location: unknown; po: unknown; asn: unknown;
  shade: string | null; batch: string; insp_lot: string; vendor_batch: string | null; tn: string | null; closed: number | null; by: string; at: string; note: string | null;
}
export type CheckStatus = 'Sent' | 'Partly sent' | 'Not sent';
/** v180: a roll SAP inspected for the SO line (ZINSR lot → ZCMNTVIEW Barcode Number → Korber Pallet) and whether that pallet was picked */
export type RollStatus = 'Picked' | 'Picked for another SO' | 'Not picked' | 'Not in Korber' | 'No barcode';
export interface ZRoll {
  key: string; so: string; li: string; item: string; lot: string; batch: string; vendor_batch: string | null; roll_no: string | null; barcode: string | null; roll_qty: number | null; shade: string | null;
  pallet: string | null; korber_qty: number | null; korber_lot: string | null; location: string | null; picked: number; other: number;
  picks: { so: string; li: string; qty: number; day: string | null; pick: string | null; kind: string }[]; status: RollStatus;
}
export const ROLL_STATUSES: RollStatus[] = ['Picked', 'Picked for another SO', 'Not picked', 'Not in Korber', 'No barcode'];
export interface CheckLine {
  row: number; values: unknown[]; so: string; li: string; item: string; key: string; date: string; qty: number;
  sent: number; balance: number; status: CheckStatus; rolls: number; picks: number; days: string; last: string | null; keySent: number; repeat: boolean;
  /** v180: the line's ZCMNTVIEW rolls: how many, picked for it, picked for another SO line, not picked */
  zRolls: number; zPicked: number; zOther: number; zNot: number; rollStatus: string;
}
export interface CheckResult { file: string; sheet: string; header: string[]; dateCol: number; lines: CheckLine[]; picks: SentPick[]; rolls: ZRoll[]; at: string; by: string }

/** the same as the Worker's normId: trimmed, "123.0" → "123", leading zeros of a number off, short letter prefixes upper case */
export function normId(v: unknown): string {
  let s = String(v ?? '').trim();
  if (/^\d+\.0+$/.test(s)) s = s.replace(/\.0+$/, '');
  if (/^\d+$/.test(s)) s = s.replace(/^0+(?=\d)/, '');
  if (/^[a-z]{1,4}\d+$/i.test(s)) s = s.toUpperCase();
  return s;
}
const hn = (v: unknown) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const COLS = { so: ['so', 'salesorder', 'salesdocument', 'sodocument'], li: ['li', 'lineitem', 'salesdocumentitem', 'item no', 'itemno'], item: ['itemcode', 'item', 'material', 'materialcode'], qty: ['qty', 'quantity', 'planqty', 'requiredqty'], date: ['date', 'plandate'] };
const findCol = (h: string[], names: string[]) => h.findIndex((x) => names.map(hn).includes(hn(x)));
const dateText = (v: unknown) => {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'number' && v > 20000 && v < 80000) { const d = XLSX.SSF.parse_date_code(v); return d ? `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}` : String(v); }
  return String(v ?? '').trim();
};

/** reads the Plan_Format: the first sheet with SO, LI and Item Code columns (the header can be in the first 15 rows) */
export async function readPlan(file: File): Promise<{ sheet: string; header: string[]; rows: { row: number; values: unknown[] }[]; ix: Record<keyof typeof COLS, number> }> {
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' }); // dates stay Excel serial numbers (no time-zone shift)
  for (const name of wb.SheetNames) {
    const grid = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], { header: 1, raw: true, defval: null });
    for (let h = 0; h < Math.min(15, grid.length); h++) {
      const header = (grid[h] || []).map((x) => String(x ?? '').trim());
      const ix = { so: findCol(header, COLS.so), li: findCol(header, COLS.li), item: findCol(header, COLS.item), qty: findCol(header, COLS.qty), date: findCol(header, COLS.date) };
      if (ix.so < 0 || ix.li < 0 || ix.item < 0) continue;
      const rows = grid.slice(h + 1).map((values, i) => ({ row: h + 2 + i, values: values || [] })).filter((r) => normId(r.values[ix.so]) && normId(r.values[ix.item]));
      return { sheet: name, header, rows, ix };
    }
  }
  throw new Error('No sheet with the columns SO, LI and Item Code was found in this file.');
}

/** checks the plan against the system's picks */
export async function checkPlan(file: File, by: string, step: (s: string) => void): Promise<CheckResult> {
  step('Reading the Plan_Format…');
  const p = await readPlan(file);
  if (!p.rows.length) throw new Error(`Sheet “${p.sheet}” has no SO / LI / Item Code lines.`);
  const keyOf = (v: unknown[]) => `${normId(v[p.ix.so])}|${normId(v[p.ix.li])}|${normId(v[p.ix.item])}`;
  const keys = Array.from(new Set(p.rows.map((r) => keyOf(r.values))));
  step(`Looking up the picks of ${keys.length} SO / LI / Item…`);
  const picks: SentPick[] = [];
  const zrolls: ZRoll[] = [];
  for (let i = 0; i < keys.length; i += 1000) { const r = await api<{ picks: SentPick[]; rolls?: ZRoll[] }>('/api/plan-check', { method: 'POST', body: { keys: keys.slice(i, i + 1000) } }); picks.push(...r.picks); zrolls.push(...(r.rolls || [])); }
  const zBy = new Map<string, ZRoll[]>(); for (const z of zrolls) zBy.set(z.key, [...(zBy.get(z.key) ?? []), z]);
  const byKey = new Map<string, SentPick[]>();
  for (const x of picks) { const k = `${normId(x.so)}|${normId(x.li)}|${normId(x.item)}`; byKey.set(k, [...(byKey.get(k) ?? []), x]); }
  // the same SO / LI / Item more than once in the file: what was sent is given to its lines in order (each up to its QTY; the last takes the rest)
  const left = new Map(Array.from(byKey).map(([k, xs]) => [k, r3(xs.reduce((t, x) => t + x.qty, 0))]));
  const count = new Map<string, number>(); for (const r of p.rows) count.set(keyOf(r.values), (count.get(keyOf(r.values)) ?? 0) + 1);
  const seen = new Map<string, number>();
  const lines: CheckLine[] = p.rows.map((r) => {
    const key = keyOf(r.values);
    const xs = byKey.get(key) ?? [];
    const qty = p.ix.qty >= 0 ? Number(r.values[p.ix.qty]) || 0 : 0;
    const n = (seen.get(key) ?? 0) + 1; seen.set(key, n);
    const last = n === count.get(key);
    const have = left.get(key) ?? 0;
    const sent = r3(last ? have : Math.min(have, qty > 0 ? qty : have));
    left.set(key, r3(have - sent));
    const balance = r3(Math.max(0, qty - sent));
    const status: CheckStatus = sent <= 1e-9 ? 'Not sent' : qty > 0 && sent < qty - 0.0005 ? 'Partly sent' : 'Sent';
    const days = Array.from(new Set(xs.map((x) => x.day).filter(Boolean))).sort() as string[];
    return { row: r.row, values: r.values, so: normId(r.values[p.ix.so]), li: normId(r.values[p.ix.li]), item: normId(r.values[p.ix.item]), key, date: p.ix.date >= 0 ? dd(dateText(r.values[p.ix.date])) : '', qty,
      sent, balance, status, rolls: new Set(xs.map((x) => x.pallet)).size, picks: new Set(xs.map((x) => `${x.day}|${x.seq}|${x.plan}`)).size, days: days.map(dd).join(', '), last: days.length ? dd(days[days.length - 1]) : null,
      keySent: r3(xs.reduce((t, x) => t + x.qty, 0)), repeat: (count.get(key) ?? 1) > 1, ...rollsOf(zBy.get(key) ?? []) };
  });
  return { file: file.name, sheet: p.sheet, header: p.header, dateCol: p.ix.date, lines, picks, rolls: zrolls, at: new Date().toISOString(), by };
}
function rollsOf(zs: ZRoll[]) {
  const zPicked = zs.filter((z) => z.status === 'Picked').length, zOther = zs.filter((z) => z.status === 'Picked for another SO').length;
  const zNot = zs.length - zPicked - zOther;
  const rollStatus = !zs.length ? 'No ZCMNTVIEW rolls' : zPicked === zs.length ? 'All rolls picked' : zPicked ? 'Some rolls picked' : 'No roll picked';
  return { zRolls: zs.length, zPicked, zOther, zNot, rollStatus };
}
const dd = (d: string | null | undefined) => (d && /^\d{4}-\d{2}-\d{2}/.test(d) ? `${d.slice(8, 10)}-${d.slice(5, 7)}-${d.slice(0, 4)}` : String(d ?? ''));

const thin = { style: 'thin', color: { rgb: 'BFBFBF' } };
const BOX = { top: thin, bottom: thin, left: thin, right: thin };
const FONT = { name: 'Arial', sz: 10 };
const ST = {
  head: { font: { ...FONT, bold: true }, fill: { patternType: 'solid', fgColor: { rgb: 'D9D9D9' } }, border: BOX, alignment: { vertical: 'center', wrapText: true } },
  added: { font: { ...FONT, bold: true, color: { rgb: 'FFFFFF' } }, fill: { patternType: 'solid', fgColor: { rgb: 'C55A11' } }, border: BOX, alignment: { vertical: 'center', wrapText: true } },
  cell: { font: FONT, border: BOX },
  top: { font: { ...FONT, bold: true, sz: 12 } },
  note: { font: { ...FONT, italic: true, color: { rgb: '595959' } } },
  Sent: { font: { ...FONT, bold: true, color: { rgb: '006100' } }, fill: { patternType: 'solid', fgColor: { rgb: 'C6EFCE' } }, border: BOX },
  'Partly sent': { font: { ...FONT, bold: true, color: { rgb: '7F6000' } }, fill: { patternType: 'solid', fgColor: { rgb: 'FFEB9C' } }, border: BOX },
  'Not sent': { font: { ...FONT, bold: true, color: { rgb: '9C0006' } }, fill: { patternType: 'solid', fgColor: { rgb: 'FFC7CE' } }, border: BOX },
};
type AOA = (string | number | null)[][];
const cellV = (v: unknown): string | number | null => (v instanceof Date ? dd(v.toISOString().slice(0, 10)) : typeof v === 'number' || typeof v === 'string' ? v : v === null || v === undefined ? null : String(v));

function sheetOf(aoa: AOA, headRow: number, widths: number[], style?: (r: number, c: number) => unknown, addedFrom = Infinity) {
  const U = XLSXS.utils;
  const ws = U.aoa_to_sheet(aoa);
  const ncol = Math.max(...aoa.map((r) => r.length));
  for (let r = headRow; r < aoa.length; r++) for (let c = 0; c < ncol; c++) {
    const ref = U.encode_cell({ r, c });
    if (!ws[ref]) ws[ref] = { t: 's', v: '' };
    (ws[ref] as { s?: unknown }).s = r === headRow ? (c >= addedFrom ? ST.added : ST.head) : style?.(r, c) ?? ST.cell;
  }
  for (let r = 0; r < headRow; r++) { const ref = U.encode_cell({ r, c: 0 }); if (ws[ref]) (ws[ref] as { s?: unknown }).s = r === 0 ? ST.top : ST.note; }
  ws['!cols'] = widths.map((w) => ({ wch: w }));
  ws['!autofilter'] = { ref: U.encode_range({ r: headRow, c: 0 }, { r: Math.max(headRow, aoa.length - 1), c: ncol - 1 }) };
  return ws;
}

/** the workbook: the Plan_Format with its check columns, the rolls sent, a summary */
export function checkWorkbook(res: CheckResult) {
  const U = XLSXS.utils;
  const wb = U.book_new();
  // 1. the Plan_Format as uploaded, with the check on the right
  const add = ['Sent Status', 'Sent QTY', 'Balance to send', 'Rolls sent', 'Picks', 'Sent on (days)', 'Last sent', 'ZCMNTVIEW rolls', 'Rolls picked', 'Picked for another SO', 'Rolls not picked', 'Roll Status'];
  const n0 = res.header.length;
  const plan: AOA = [[...res.header.map((h) => h || null), ...add]];
  for (const l of res.lines) {
    const base = Array.from({ length: n0 }, (_, i) => (i === res.dateCol && l.values[i] !== null && l.values[i] !== '' ? dd(dateText(l.values[i])) : cellV(l.values[i])));
    plan.push([...base, l.status, l.sent, l.balance, l.rolls || null, l.picks || null, l.days || null, l.last, l.zRolls || null, l.zRolls ? l.zPicked : null, l.zOther || null, l.zRolls ? l.zNot : null, l.rollStatus]);
  }
  const stCol = n0;
  const rsCol = n0 + add.length - 1;
  const RS: Record<string, unknown> = { 'All rolls picked': ST.Sent, 'Some rolls picked': ST['Partly sent'], 'No roll picked': ST['Not sent'] };
  U.book_append_sheet(wb, sheetOf(plan, 0, [...res.header.map((h) => Math.max(10, Math.min(28, String(h).length + 4))), 12, 11, 13, 10, 7, 30, 11, 11, 10, 12, 11, 18],
    (r, c) => (c === stCol ? ST[plan[r][stCol] as CheckStatus] ?? ST.cell : c === rsCol ? RS[String(plan[r][rsCol])] ?? ST.cell : ST.cell), n0), res.sheet.slice(0, 31) || 'Plan');
  // 2. every roll that was sent
  const qtyOf = new Map<string, number>(); for (const l of res.lines) qtyOf.set(l.key, (qtyOf.get(l.key) ?? 0) + l.qty);
  const dh = ['SO', 'LI', 'Item Code', 'Plan QTY (file)', 'Pick date', 'Pick No', 'Pick (plan)', 'Plant', 'Type', 'Pallet', 'Korber Lot Number', 'Supplier Hu', 'Location Id', 'Po Number', 'Asn Number',
    'Qty sent', 'Roll Qty', 'Cut roll', 'Shade', 'SAP Batch', 'ZINSR Lot', 'Vendor Batch', 'Transfer Note', 'Closed short', 'Picked by', 'Picked at', 'Note'];
  const det: AOA = [[`SENT DETAILS — ${res.file}`], [`Every roll the system sent for the SO / LI / Item Codes of the Plan_Format (cancelled picks left out) · ${new Date(res.at).toLocaleString()} · ${res.by}`], [], dh];
  const ord = [...res.picks].sort((a, b) => a.so.localeCompare(b.so) || Number(a.li) - Number(b.li) || a.item.localeCompare(b.item) || String(a.day).localeCompare(String(b.day)));
  for (const x of ord) {
    const k = `${normId(x.so)}|${normId(x.li)}|${normId(x.item)}`;
    det.push([x.so, Number(x.li) || x.li, Number(x.item) || x.item, r3(qtyOf.get(k) ?? 0), dd(x.day), x.pick_no || (x.seq ? `#${x.seq}` : null), x.plan, x.plant,
      `${x.kind === 'offsite' ? 'Offsite' : 'Normal'}${x.auto ? ' · auto' : ''}`, x.pallet, x.lot, cellV(x.hu), cellV(x.location), cellV(x.po), cellV(x.asn),
      r3(x.qty), x.roll_qty, x.cut ? 'Yes' : null, x.shade, x.batch || null, x.insp_lot || null, x.vendor_batch, x.tn ? `TN ${x.tn}` : null, x.closed ? r3(x.closed) : null, x.by,
      x.at ? new Date(x.at).toLocaleString() : null, x.note]);
  }
  if (ord.length) det.push(['Total', null, null, null, null, null, null, null, null, `${new Set(ord.map((x) => x.pallet)).size} rolls`, null, null, null, null, null, r3(ord.reduce((t, x) => t + x.qty, 0))]);
  U.book_append_sheet(wb, sheetOf(det, 3, [13, 5, 12, 12, 11, 9, 24, 12, 13, 18, 18, 11, 14, 16, 18, 10, 9, 8, 7, 18, 14, 18, 13, 10, 10, 19, 40]), 'Sent Details');
  // v180: 2b. every roll SAP inspected for the SO lines (ZINSR lot → ZCMNTVIEW Barcode Number → Korber Pallet): picked or not
  const rh = ['SO', 'LI', 'Item Code', 'ZINSR Lot', 'SAP Batch', 'Vendor Batch', 'Roll No', 'Barcode Number (ZCMNTVIEW)', 'Roll Qty', 'Shade', 'Korber Pallet', 'Korber Lot Number', 'Korber Qty', 'Location Id',
    'Roll Status', 'Picked for this SO', 'Picked for another SO', 'Picks (day · SO / LI · Qty · Pick)'];
  const ra: AOA = [[`ROLL CHECK — ${res.file}`], ['Each SO line’s ZINSR lots → their ZCMNTVIEW rolls → Barcode Number = Korber Pallet: was that pallet picked? (cancelled picks left out)'], [], rh];
  const RST: Record<RollStatus, unknown> = { Picked: ST.Sent, 'Picked for another SO': ST['Partly sent'], 'Not picked': ST['Not sent'], 'Not in Korber': ST['Not sent'], 'No barcode': ST.cell };
  const zs = [...res.rolls].sort((a, b) => a.so.localeCompare(b.so) || Number(a.li) - Number(b.li) || a.item.localeCompare(b.item) || a.lot.localeCompare(b.lot) || String(a.roll_no).localeCompare(String(b.roll_no), undefined, { numeric: true }));
  for (const z of zs) ra.push([z.so, Number(z.li) || z.li, Number(z.item) || z.item, z.lot, z.batch, z.vendor_batch, z.roll_no, z.barcode, z.roll_qty || null, z.shade, z.pallet, z.korber_lot, z.korber_qty, z.location,
    z.status, z.picked || null, z.other || null, z.picks.map((x) => `${dd(x.day)} · ${x.so} / ${x.li} · ${r3(x.qty)}${x.pick ? ` · ${x.pick}` : ''}${x.kind === 'offsite' ? ' · Offsite' : ''}`).join('\n') || null]);
  if (zs.length) U.book_append_sheet(wb, sheetOf(ra, 3, [13, 5, 12, 13, 12, 18, 8, 20, 9, 7, 20, 18, 10, 14, 20, 10, 12, 60], (r, c) => (c === 14 ? RST[ra[r][14] as RollStatus] ?? ST.cell : ST.cell)), 'Roll Check');
  // 3. summary
  const by = (s: CheckStatus) => res.lines.filter((l) => l.status === s);
  const sum: AOA = [[`PLAN_FORMAT CHECK — ${res.file}`], [`Sheet “${res.sheet}” · ${res.lines.length} lines · checked ${new Date(res.at).toLocaleString()} by ${res.by}`], [], ['Status', 'Lines', 'Plan QTY', 'Sent QTY', 'Balance to send']];
  for (const s of ['Sent', 'Partly sent', 'Not sent'] as CheckStatus[]) { const ls = by(s); sum.push([s, ls.length, r3(ls.reduce((t, l) => t + l.qty, 0)), r3(ls.reduce((t, l) => t + l.sent, 0)), r3(ls.reduce((t, l) => t + l.balance, 0))]); }
  sum.push(['Total', res.lines.length, r3(res.lines.reduce((t, l) => t + l.qty, 0)), r3(res.lines.reduce((t, l) => t + l.sent, 0)), r3(res.lines.reduce((t, l) => t + l.balance, 0))]);
  if (res.rolls.length) {
    sum.push([], ['Roll check (ZCMNTVIEW Barcode → Korber Pallet)', 'Rolls', 'Korber Qty']);
    for (const s0 of ROLL_STATUSES) { const zz = res.rolls.filter((z) => z.status === s0); if (zz.length) sum.push([s0, zz.length, r3(zz.reduce((t, z) => t + (z.korber_qty || 0), 0))]); }
  }
  const rep = res.lines.filter((l) => l.repeat).length;
  if (rep) sum.push([], [`${rep} lines have the same SO / LI / Item Code as another line of the file: what was sent is given to them in file order, each up to its QTY.`]);
  U.book_append_sheet(wb, sheetOf(sum, 3, [16, 9, 12, 12, 15], (r, c) => (c === 0 && r > 3 && r < 7 ? ST[sum[r][0] as CheckStatus] ?? ST.cell : ST.cell)), 'Summary');
  return wb;
}
export const checkBytes = (wb: ReturnType<typeof checkWorkbook>) => new Uint8Array(XLSXS.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer);
