/**
 * Reads the uploaded Excel sheets and maps their columns to the fields the API needs.
 *
 * Each report is found three ways, in this order:
 *  1. A header row (SO, LI, Material, Unrestricted …) in the first 12 rows.
 *  2. Your current workbook layout, where column A holds the SO&LI&Material&"A" key formula.
 *  3. The same layout straight from SAP, without that key column (everything one column left).
 * The upload screen shows the result and lets you change any column before sending.
 */
import * as XLSX from 'xlsx';

export type Src = 'plan' | 'zmmbe' | 'kfc' | 'pfc' | 'plant' | 'trr';
/** Reports offered on the Uploads page (TRR is no longer uploaded). */
/** What is uploaded: the plan, ZMMBE (KFC and PFC are built from it) and PLANT. */
export const SRC_ORDER: Src[] = ['plan', 'zmmbe', 'plant'];

export interface FieldDef {
  id: string;
  label: string;
  required?: boolean;
  numeric?: boolean;
  /** header names that identify this column (case and spaces ignored) */
  aliases: string[];
  /** column letter in your workbook layout (column A = key formula) */
  keyed?: string;
}

const STOCK_FIELDS: FieldDef[] = [
  { id: 'plant', label: 'Plant', aliases: ['plant'], keyed: 'B' },
  { id: 'sloc', label: 'St Location', aliases: ['st location', 'storage location', 'sloc', 'stor loc', 'stor. loc.', 'st loc'], keyed: 'C' },
  { id: 'so_plant', label: 'SO Plant', aliases: ['so plant'], keyed: 'D' },
  { id: 'so', label: 'SO', required: true, aliases: ['so', 'sales order', 'sales document', 'sales doc', 'sd document'], keyed: 'E' },
  { id: 'li', label: 'LI', required: true, aliases: ['li', 'line item', 'so item', 'sales order item', 'sales document item', 'item'], keyed: 'F' },
  { id: 'ur', label: 'UR', numeric: true, aliases: ['ur', 'unrestricted', 'unrestricted stock', 'sales order ur stock', 'unrestr', 'unrestricted use'], keyed: 'G' },
  { id: 'material', label: 'Material', required: true, aliases: ['material', 'item code', 'material number', 'fabric code'], keyed: 'H' },
  { id: 'batch', label: 'Batch', aliases: ['batch'], keyed: 'I' },
  { id: 'style', label: 'Style', aliases: ['style'], keyed: 'J' },
  { id: 'qi', label: 'QI', numeric: true, aliases: ['qi', 'quality inspection', 'so qi stock', 'in quality insp', 'qi stock'], keyed: 'L' },
  { id: 'block', label: 'Block', numeric: true, aliases: ['block', 'blocked', 'blocked stock', 'so blocked stock stock', 'so blocked stock'], keyed: 'M' },
  { id: 'assigned', label: 'Assigned', numeric: true, aliases: ['assigned', 'assigned qty', 'assigned quantity'], keyed: 'N' },
  { id: 'total', label: 'Total', numeric: true, aliases: ['total', 'total stock', 'total qty'], keyed: 'O' },
];

export const FIELDS: Record<Src, FieldDef[]> = {
  plan: [
    { id: 'so', label: 'SO', required: true, aliases: ['so', 'sales order', 'sales document', 'sales doc'], keyed: 'B' },
    { id: 'li', label: 'LI', required: true, aliases: ['li', 'line item', 'so item', 'item'], keyed: 'C' },
    { id: 'item', label: 'Item Code', required: true, aliases: ['item code', 'material', 'fabric code', 'material code', 'fabric'], keyed: 'D' },
    { id: 'date', label: 'Date', aliases: ['date', 'delivery date', 'req date', 'pull date', 'pcd'], keyed: 'E' },
    { id: 'qty', label: 'QTY', required: true, numeric: true, aliases: ['qty', 'quantity', 'req qty', 'pull qty', 'required qty'], keyed: 'F' },
    { id: 'plant', label: 'Plant', aliases: ['plant', 'to plant', 'factory'] },
    { id: 'remarks', label: 'Remarks', aliases: ['remarks', 'remark', 'priority'], keyed: 'G' },
    { id: 'comment', label: 'Comment', aliases: ['comment', 'comments'], keyed: 'H' },
    { id: 'qi_note', label: 'QI note', aliases: ['qi'], keyed: 'I' },
    { id: 'status', label: 'Status', aliases: ['status'], keyed: 'J' },
    { id: 'vehicle', label: 'Vehicle', aliases: ['vehicle'] },
  ],
  zmmbe: STOCK_FIELDS,
  kfc: STOCK_FIELDS,
  pfc: STOCK_FIELDS,
  plant: STOCK_FIELDS,
  trr: [
    { id: 'tn', label: 'TN number', aliases: ['tn', 'tn number', 'tn no', 'transfer note'], keyed: 'B' },
    { id: 'tn_date', label: 'TN date', aliases: ['tn date', 'created on', 'date'], keyed: 'C' },
    { id: 'created_by', label: 'Created by', aliases: ['created by', 'user'], keyed: 'D' },
    { id: 'so', label: 'SO', required: true, aliases: ['so', 'sales order'], keyed: 'E' },
    { id: 'li', label: 'LI', required: true, aliases: ['li', 'item', 'so item'], keyed: 'F' },
    { id: 'from_plant', label: 'Plant (1)', aliases: ['from plant', 'supplying plant'], keyed: 'H' },
    { id: 'from_sloc', label: 'St Loc (1)', aliases: ['from sloc', 'from storage location'], keyed: 'I' },
    { id: 'material', label: 'Material', required: true, aliases: ['material', 'item code'], keyed: 'J' },
    { id: 'to_plant', label: 'Plant (2)', aliases: ['to plant', 'receiving plant'], keyed: 'N' },
    { id: 'to_sloc', label: 'St Loc (2)', aliases: ['to sloc', 'to storage location'], keyed: 'O' },
    { id: 'qty', label: 'TN QTY', required: true, numeric: true, aliases: ['qty', 'quantity', 'tn qty'], keyed: 'Q' },
    { id: 'reason', label: 'Reason', aliases: ['reason', 'remarks', 'comment'], keyed: 'AC' },
  ],
};

export const SRC_INFO: Record<Src, { title: string; hint: string }> = {
  plan: { title: 'Weekly plan', hint: 'SO / LI / Item Code / Date / QTY / Plant' },
  zmmbe: { title: 'ZMMBE', hint: 'Full stock: UR, QI, Block, Assigned — KFC and PFC are built from it' },
  kfc: { title: 'ZMMBE KFC', hint: 'KFC stock: UR, QI, Block' },
  pfc: { title: 'ZMMBE PFC', hint: 'PFC stock: UR, QI, Block' },
  plant: { title: 'PLANT report', hint: 'Stock at plant (Total column)' },
  trr: { title: 'TRR', hint: 'TN number and TN QTY' },
};

/** Guess the report type from a sheet name. */
export function guessSrc(sheetName: string): Src | null {
  const s = sheetName.toLowerCase().replace(/[^a-z]/g, '');
  if (s.includes('kfc')) return 'kfc';
  if (s.includes('pfc')) return 'pfc';
  if (s.includes('zmmbe') || s === 'mmbe') return 'zmmbe';
  if (s.includes('plant')) return 'plant';
  if (s.includes('pullplan') || s.includes('plan')) return 'plan';
  return null;
}

export type Grid = unknown[][];

/** Instruction sheets in the sample formats ("How to use") are never data. */
export const isHelpSheet = (name: string) => /how\s*to\s*use|instruction|read\s*me|notes?$/i.test(name.trim());

/** Last resort when neither the sheet nor the file name says what it is: look at the header row. */
export function guessSrcFromGrid(grid: Grid): Src | null {
  for (let r = 0; r < Math.min(12, grid.length); r++) {
    const row = (grid[r] || []).map((v) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim());
    const has = (...a: string[]) => a.some((x) => row.includes(x));
    if (has('tn', 'tn number', 'tn no', 'transfer note') && has('so', 'sales order')) return 'trr';
    if (has('item code') && has('qty', 'quantity') && has('so', 'sales order')) return 'plan';
    if (has('unrestricted', 'ur', 'unrestricted stock') && has('material')) return 'zmmbe';
  }
  return null;
}

export function colLetter(i: number): string {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}
export function colIndex(letter: string): number {
  let n = 0;
  for (const ch of letter.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export function readWorkbook(buf: ArrayBuffer) {
  const wb = XLSX.read(buf, { type: 'array', cellDates: false, cellFormula: false, cellHTML: false });
  return wb.SheetNames.map((name) => {
    const ws = wb.Sheets[name];
    const ref = ws['!ref'];
    if (!ref) return { name, grid: [] as Grid };
    const r = XLSX.utils.decode_range(ref);
    // always start at A1 so column letters match Excel
    const grid = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: false, range: { s: { r: 0, c: 0 }, e: r.e } }) as Grid;
    return { name, grid };
  });
}

const norm = (v: unknown) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const isNum = (v: unknown) => typeof v === 'number' || (typeof v === 'string' && /^-?[\d,]*\.?\d+$/.test(v.trim()));

export interface Mapping {
  /** field id → column index (or -1 for none) */
  cols: Record<string, number>;
  /** index of the first data row */
  start: number;
  how: 'header' | 'keyed' | 'raw';
  headerRow?: number;
}

export function detectMapping(src: Src, grid: Grid): Mapping {
  const fields = FIELDS[src];
  // 1. header row
  let best = { row: -1, hits: 0, cols: {} as Record<string, number> };
  for (let r = 0; r < Math.min(12, grid.length); r++) {
    const row = grid[r] || [];
    const used = new Set<number>();
    const cols: Record<string, number> = {};
    let hits = 0;
    for (const f of fields) {
      const al = f.aliases.map(norm);
      const cands: number[] = [];
      row.forEach((v, c) => { if (!used.has(c) && al.includes(norm(v))) cands.push(c); });
      if (!cands.length) continue;
      // prefer a column whose data matches the type (numbers vs text) in the rows below
      const pick = cands.find((c) => typeMatches(grid, r + 1, c, f)) ?? cands[0];
      cols[f.id] = pick; used.add(pick); hits++;
    }
    const req = fields.filter((f) => f.required).every((f) => f.id in cols);
    if (req && hits > best.hits) best = { row: r, hits, cols };
  }
  if (best.row >= 0) {
    const cols: Record<string, number> = {};
    for (const f of fields) cols[f.id] = best.cols[f.id] ?? -1;
    return { cols, start: best.row + 1, how: 'header', headerRow: best.row };
  }
  // 2/3. positional layout
  const sample = grid.slice(0, 60).map((r) => r?.[0]).filter((v) => v !== null && v !== undefined && v !== '');
  const keyLike = sample.filter((v) => /A$/.test(String(v))).length;
  const keyed = sample.length > 0 && keyLike / sample.length > 0.6;
  const shift = keyed ? 0 : -1;
  const cols: Record<string, number> = {};
  for (const f of fields) cols[f.id] = f.keyed ? colIndex(f.keyed) + shift : -1;
  // skip leading rows that have no SO number
  const soCol = cols.so;
  let start = 0;
  while (start < grid.length && start < 15 && !/^\d{6,}$/.test(String(grid[start]?.[soCol] ?? '').trim())) start++;
  return { cols, start, how: keyed ? 'keyed' : 'raw' };
}

function typeMatches(grid: Grid, from: number, c: number, f: FieldDef) {
  const vals = grid.slice(from, from + 30).map((r) => r?.[c]).filter((v) => v !== null && v !== undefined && v !== '');
  if (!vals.length) return true;
  const share = vals.filter(isNum).length / vals.length;
  return f.numeric ? share > 0.7 : f.id === 'plant' || f.id === 'remarks' || f.id === 'comment' ? share < 0.5 : true;
}

export function applyMapping(src: Src, grid: Grid, m: Mapping) {
  const fields = FIELDS[src];
  const rows: Record<string, unknown>[] = [];
  for (let r = m.start; r < grid.length; r++) {
    const g = grid[r] || [];
    const o: Record<string, unknown> = {};
    let any = false;
    for (const f of fields) {
      const c = m.cols[f.id];
      if (c === undefined || c < 0) continue;
      const v = g[c];
      if (v === null || v === undefined || v === '') continue;
      if (typeof v === 'string' && /^#(N\/A|VALUE!|REF!|DIV\/0!|NAME\?|NUM!|NULL!)$/.test(v.trim())) continue; // Excel errors
      o[f.id] = v; any = true;
    }
    if (any) rows.push(o);
  }
  return rows;
}

/** Rows the server will accept (has SO, LI and item/material). */
export function usableCount(src: Src, rows: Record<string, unknown>[]) {
  const itemField = src === 'plan' ? 'item' : 'material';
  return rows.filter((r) => /^[A-Za-z]{0,4}\d/.test(String(r.so ?? '').trim()) && String(r.li ?? '').trim() !== '' && String(r[itemField] ?? '').trim() !== '').length;
}
