/** Passes a file dropped on the Uploads page over to the Dispatch page (same tab, client-side navigation). */
import type { Grid } from './mapping';

let pending: File | null = null;
export const setPendingDispatch = (f: File) => { pending = f; };
export const takePendingDispatch = () => { const f = pending; pending = null; return f; };

const norm = (v: unknown) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
/** A dispatch / pick sheet: a header row with "Display Item Number" (or Item Number + Pick Id / Pallet) and "Actual Qty". */
export function isDispatchGrid(grid: Grid): boolean {
  for (let r = 0; r < Math.min(15, grid.length); r++) {
    const row = (grid[r] || []).map(norm);
    if (!row.includes('actual qty')) continue;
    if (row.includes('display item number')) return true;
    if (row.includes('item number') && (row.includes('pick id') || row.includes('pallet'))) return true;
  }
  return false;
}
