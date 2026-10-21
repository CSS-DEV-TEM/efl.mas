import * as XLSX from 'xlsx';
import { avail, coverage, isDone, need, shortBy, type Line } from './calc';
import { ACTIONS, action, due, priority, todayLocal } from './smart';

/** Downloads the calculated weekly plan as an .xlsx, with the smart columns first. */
export function exportPullPlan(rows: Line[], name = 'MAS_Weekly_Plan') {
  const today = todayLocal();
  const data = rows.map((l) => ({
    Week: l.week, User: (l as Line & { owner?: string }).owner ?? '', Plan: (l as Line & { plan_type?: string }).plan_type === 'day' ? 'Day plan' : 'Week plan', Picked: (l as Line & { picked?: number }).picked ?? 0, Priority: priority(l, today), 'Next action': action(l), Due: due(l, today), 'Carried over': l.carried ? 'Yes' : '',
    SO: Number(l.so) || l.so, LI: Number(l.li) || l.li, 'Item Code': Number(l.item) || l.item, Date: l.date, QTY: l.qty, Dispatched: l.dispatched ?? 0, Balance: need(l),
    Plant: l.plant, Remarks: l.remarks, Comment: l.comment, 'QI note': l.qi_note, Status: l.status, Vehicle: l.vehicle,
    'UR (Full)': l.ur, 'UR left': avail(l), 'QI (Full)': l.qi, 'Block (Full)': l.block, Assigned: l.assigned, Variance: l.variance,
    'KFC UR': l.kfc_ur, 'KFC QI': l.kfc_qi, 'KFC Block': l.kfc_block, 'PFC UR': l.pfc_ur, 'PFC QI': l.pfc_qi, 'PFC Block': l.pfc_block,
    'Stock plant': l.stock_plant, 'St Location': l.stock_sloc,
    'TN QTY': l.tn_qty, 'TN number': l.tn_number, Coverage: coverage(l), 'Short (Balance − UR left)': shortBy(l), Done: isDone(l) ? 'Yes' : 'No',
    'Updated by': l.updated_by, 'Updated at': l.updated_at,
  }));
  const ws = XLSX.utils.json_to_sheet(data);
  ws['!cols'] = Object.keys(data[0] || { SO: 1 }).map((k) => ({ wch: Math.max(8, Math.min(22, k.length + 2)) }));
  ws['!autofilter'] = { ref: ws['!ref'] || 'A1' };
  // Summary sheet: totals, by next action, by date
  const n = (f: (l: Line) => boolean) => rows.filter(f).length;
  const q = (f: (l: Line) => boolean) => Math.round(rows.filter(f).reduce((s, l) => s + l.qty, 0) * 1000) / 1000;
  const dates = Array.from(new Set(rows.map((l) => l.date || ''))).sort();
  const summary: (string | number)[][] = [
    ['MAS Weekly Plan Tracker — summary'], ['Week', rows[0]?.week || ''], ['Exported', new Date().toLocaleString('en-GB', { timeZone: 'Asia/Colombo' })], ['Lines in this export', rows.length], [],
    ['Next action', 'Lines', 'QTY'], ...ACTIONS.map((a) => [a, n((l) => action(l) === a), q((l) => action(l) === a)]), [],
    ['Date', 'Lines', 'Done', 'Open', 'QTY', 'Short vs UR'],
    ...dates.map((d) => [d || 'No date', n((l) => (l.date || '') === d), n((l) => (l.date || '') === d && isDone(l)), n((l) => (l.date || '') === d && !isDone(l)), q((l) => (l.date || '') === d),
      Math.round(rows.filter((l) => (l.date || '') === d && !isDone(l)).reduce((s, l) => s + shortBy(l), 0) * 1000) / 1000]),
    [], ['Carried over from last week (open)', n((l) => !!l.carried && !isDone(l))],
    [], ['User', 'Lines', 'Done', 'Open', 'QTY', 'Picked'],
    ...Array.from(new Set(rows.map((l) => (l as Line & { owner?: string }).owner || ''))).sort().map((u) => {
      const ur = rows.filter((l) => ((l as Line & { owner?: string }).owner || '') === u);
      return [u || '–', ur.length, ur.filter(isDone).length, ur.filter((l) => !isDone(l)).length, Math.round(ur.reduce((t, l) => t + l.qty, 0) * 1000) / 1000, Math.round(ur.reduce((t, l) => t + Number((l as Line & { picked?: number }).picked ?? 0), 0) * 1000) / 1000];
    }),
  ];
  const sum = XLSX.utils.aoa_to_sheet(summary);
  sum['!cols'] = [{ wch: 34 }, { wch: 14 }, { wch: 10 }, { wch: 10 }, { wch: 14 }, { wch: 14 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sum, 'Summary');
  XLSX.utils.book_append_sheet(wb, ws, 'Weekly Plan');
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  XLSX.writeFile(wb, `${name}_${stamp}.xlsx`);
}


/** The dashboard's plan table (Plan details) of a Pick as rows: header, one row per plan line, a total row — for the Packing List. */
export function planTableAoa(rows: Line[]): (string | number | null)[][] {
  const pickOf = (w: string) => { const m = /~([^~]*)~(\d+)$/.exec(w || ''); return m ? `${m[1] === '-' ? '' : m[1]} Pick ${m[2]}`.trim() : w; };
  const n = (v: number | null | undefined) => (v == null ? null : Math.round(v * 1000) / 1000);
  const head = ['Pick', 'SO', 'LI', 'Item Code', 'Date', 'Plant', 'QTY', 'Picked', 'Balance', 'UR', 'UR left', 'Korber qty', 'Korber rolls', 'QI', 'Block', 'Next action', 'Status', 'On hold', 'Comment', 'Remarks'];
  const body = rows.map((l) => [pickOf(l.week), Number(l.so) || l.so, Number(l.li) || l.li, Number(l.item) || l.item, l.date, l.plant, n(l.qty), n(l.picked ?? 0), n(need(l)), n(l.ur), n(avail(l)),
    n(l.korber_avail), l.korber_rolls ?? null, n(l.qi), n(l.block), action(l), l.status, l.hold ?? null, l.comment, l.remarks]);
  const total = ['', '', '', '', '', 'Total', n(rows.reduce((t, l) => t + l.qty, 0)), n(rows.reduce((t, l) => t + (l.picked ?? 0), 0)), n(rows.reduce((t, l) => t + need(l), 0))];
  return [head, ...body, total] as (string | number | null)[][];
}
