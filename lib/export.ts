import * as XLSX from 'xlsx';
import { coverage, isDone, shortBy, type Line } from './calc';
import { action, due, priority, todayLocal } from './smart';

/** Downloads the calculated weekly plan as an .xlsx, with the smart columns first. */
export function exportPullPlan(rows: Line[], name = 'MAS_Weekly_Plan') {
  const today = todayLocal();
  const data = rows.map((l) => ({
    Priority: priority(l, today), 'Next action': action(l), Due: due(l, today),
    SO: Number(l.so) || l.so, LI: Number(l.li) || l.li, 'Item Code': Number(l.item) || l.item, Date: l.date, QTY: l.qty,
    Plant: l.plant, Remarks: l.remarks, Comment: l.comment, 'QI note': l.qi_note, Status: l.status, Vehicle: l.vehicle,
    'UR (Full)': l.ur, 'QI (Full)': l.qi, 'Block (Full)': l.block, Assigned: l.assigned, Variance: l.variance,
    'KFC UR': l.kfc_ur, 'KFC QI': l.kfc_qi, 'KFC Block': l.kfc_block, 'PFC UR': l.pfc_ur, 'PFC QI': l.pfc_qi, 'PFC Block': l.pfc_block,
    'At plant (PLANT)': l.plant_qty, 'Stock plant': l.stock_plant, 'St Location': l.stock_sloc,
    'TN QTY': l.tn_qty, 'TN number': l.tn_number, Coverage: coverage(l), 'Short vs UR': shortBy(l), Done: isDone(l) ? 'Yes' : 'No',
    'Updated by': l.updated_by, 'Updated at': l.updated_at,
  }));
  const ws = XLSX.utils.json_to_sheet(data);
  ws['!cols'] = Object.keys(data[0] || { SO: 1 }).map((k) => ({ wch: Math.max(8, Math.min(22, k.length + 2)) }));
  ws['!autofilter'] = { ref: ws['!ref'] || 'A1' };
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Weekly Plan');
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  XLSX.writeFile(wb, `${name}_${stamp}.xlsx`);
}
