/** Types and the tracking figures worked out on top of the API's pull plan rows. */

export interface Line {
  id: number; row_no: number; key: string; week: string; src_user?: string | null; src_at?: string | null; so: string; li: string; item: string; date: string | null; qty: number;
  plant: string | null; remarks: string | null;
  ur: number; qi: number; block: number; assigned: number; variance: number;
  kfc_ur: number; kfc_qi: number; kfc_block: number; pfc_ur: number; pfc_qi: number; pfc_block: number;
  plant_qty: number; stock_plant: string | null; stock_sloc: string | null; at_plant: string | null;
  tn_qty: number; tn_number: string | null; dup: number;
  /** 1 when the same SO / LI / Item was in the previous week's plan and not marked Done there */
  carried?: number;
  status: string | null; comment: string | null; vehicle: string | null; qi_note: string | null;
  updated_by: string | null; updated_at: string | null;
  /** from the dispatch upload: QTY dispatched against this line, plan QTY left, UR left after the dispatch */
  dispatched?: number; balance?: number; ur_left?: number;
  /** part of the dispatch that comes off UR: what was uploaded after the latest ZMMBE */
  ur_take?: number;
  /** QI / Block released to UR by hand (until the next ZMMBE) */
  released?: number;
  /** dispatch item whose left-over QTY was assigned to this line */
  assigned_from?: string;
}

export interface DispatchItem { item: string; dispatched: number; allocated: number; over: number; assigned?: number; planQty: number; lines: number; complete: number; pallets: number }
export interface DispatchAssign { id: number; week: string; item: string; line: string; qty: number; by_user?: string; at?: string; applied?: number }
export interface DispatchSummary { total: number; items: DispatchItem[]; unmatched: DispatchItem[]; leftover?: DispatchItem[]; assigns?: DispatchAssign[]; planLines?: number; elsewhere?: Record<string, string[]> }

/** QTY still to send (plan QTY − dispatched). */
export const need = (l: Line) => (l.balance ?? l.qty);
/** UR stock still available after the dispatch (UR − dispatched). */
export const avail = (l: Line) => (l.ur_left ?? l.ur);
/** Every QTY of the line has gone out on a dispatch. */
export const isDispatched = (l: Line) => (l.dispatched ?? 0) > 0 && need(l) <= 1e-9;

export interface WeekInfo { week: string; lines: number; start: string | null; end: string | null; qty: number; done: number; dispatched?: number }

export interface Upload { src: string; file_name: string | null; sheet_name: string | null; row_count: number; uploaded_by: string; uploaded_at: string }

export type Coverage = 'Covered' | 'Partial' | 'QI / Block only' | 'No stock';
export const COVERAGES: Coverage[] = ['Covered', 'Partial', 'QI / Block only', 'No stock'];

/** Covered: Full UR ≥ QTY. Partial: some UR. QI / Block only: no UR but QI or blocked stock. No stock: nothing in ZMMBE. */
export function coverage(l: Line): Coverage {
  if (isDispatched(l) || (avail(l) >= need(l) - 1e-9 && l.qty > 0)) return 'Covered';
  if (avail(l) > 0) return 'Partial';
  if (l.qi + l.block > 0) return 'QI / Block only';
  return 'No stock';
}
export const isDone = (l: Line) => /\bdone\b/i.test(l.status || '') || isDispatched(l);
/** QTY still to send that the UR left does not cover. */
export const shortBy = (l: Line) => Math.max(0, need(l) - avail(l));

export interface Totals {
  lines: number; done: number; open: number; qty: number; ur: number; qi: number; block: number; assigned: number;
  variance: number; dispatched: number; balance: number; dispatchedLines: number; kfc_ur: number; pfc_ur: number; plant_qty: number; tn_qty: number; short: number; shortLines: number;
  cov: Record<Coverage, number>; covQty: Record<Coverage, number>;
}

export function totals(rows: Line[]): Totals {
  const t: Totals = {
    lines: rows.length, done: 0, open: 0, qty: 0, dispatched: 0, balance: 0, dispatchedLines: 0, ur: 0, qi: 0, block: 0, assigned: 0, variance: 0, kfc_ur: 0, pfc_ur: 0,
    plant_qty: 0, tn_qty: 0, short: 0, shortLines: 0,
    cov: { Covered: 0, Partial: 0, 'QI / Block only': 0, 'No stock': 0 },
    covQty: { Covered: 0, Partial: 0, 'QI / Block only': 0, 'No stock': 0 },
  };
  // stock is per SO|LI|Item, so a key that appears twice in the plan is counted once
  const seen = new Set<string>();
  for (const l of rows) {
    const d = isDone(l);
    if (d) t.done++; else t.open++;
    t.qty += l.qty; t.variance += l.variance;
    t.dispatched += l.dispatched ?? 0; t.balance += need(l); if (isDispatched(l)) t.dispatchedLines++;
    const c = coverage(l);
    t.cov[c]++; t.covQty[c] += l.qty;
    if (!d && shortBy(l) > 0) { t.short += shortBy(l); t.shortLines++; }
    if (seen.has(l.key)) continue;
    seen.add(l.key);
    t.ur += l.ur; t.qi += l.qi; t.block += l.block; t.assigned += l.assigned;
    t.kfc_ur += l.kfc_ur; t.pfc_ur += l.pfc_ur; t.plant_qty += l.plant_qty; t.tn_qty += l.tn_qty;
  }
  return t;
}

export const fmt = (n: number, d = 0) => (Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : '–');
/** QTY always with 2 decimals. */
export const fmtQty = (n: number) => (Math.abs(n) < 0.0005 ? '–' : fmt(n, 2));
/** KPI figures: full number with 2 decimals. */
export const compact = (n: number) => fmt(n, 2);
export function fmtDate(d: string | null) {
  if (!d) return '–';
  const m = d.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return d;
  const dt = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return dt.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}
export function ago(iso: string | null | undefined) {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
