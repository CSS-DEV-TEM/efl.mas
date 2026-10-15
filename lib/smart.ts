/**
 * Smart layer: turns each plan line into a next action, a due status and a priority score,
 * and works out the insights shown at the top of the dashboard.
 */
import { isDone, shortBy, type Line, type Upload } from './calc';

export type Action = 'Done' | 'Ready to pull' | 'Release QI / Block' | 'Partial pull' | 'Follow up TN' | 'No stock';
export const ACTIONS: Action[] = ['Ready to pull', 'Release QI / Block', 'Partial pull', 'Follow up TN', 'No stock', 'Done'];
export const ACTION_PILL: Record<Action, string> = {
  'Ready to pull': 'ok', 'Release QI / Block': 'info', 'Partial pull': 'warn', 'Follow up TN': 'accent', 'No stock': 'bad', Done: 'mute',
};
export const ACTION_HELP: Record<Action, string> = {
  'Ready to pull': 'Full UR stock covers the QTY',
  'Release QI / Block': 'UR alone is short, but UR + QI + Block covers the QTY',
  'Partial pull': 'Some UR stock, not enough for the QTY',
  'Follow up TN': 'No stock in ZMMBE, but a transfer note exists',
  'No stock': 'Nothing in ZMMBE and no TN',
  Done: 'Marked Done',
};

/** The next thing to do for a line. */
export function action(l: Line): Action {
  if (isDone(l)) return 'Done';
  if (l.qty > 0 && l.ur >= l.qty - 1e-9) return 'Ready to pull';
  if (l.qi + l.block > 0 && l.ur + l.qi + l.block >= l.qty - 1e-9) return 'Release QI / Block';
  if (l.ur > 0) return 'Partial pull';
  if (l.tn_qty > 0 || l.tn_number) return 'Follow up TN';
  return 'No stock';
}

export type Due = 'Overdue' | 'Today' | 'Tomorrow' | 'This week' | 'Later' | 'No date';
export const DUE_PILL: Record<Due, string> = { Overdue: 'bad', Today: 'warn', Tomorrow: 'accent', 'This week': 'info', Later: 'mute', 'No date': 'mute' };

/** Today's date in Sri Lanka as yyyy-mm-dd (the plan dates are local dates). */
export function todayLocal(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Colombo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
const dayDiff = (a: string, b: string) => Math.round((Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 86400000);

export function due(l: Line, today = todayLocal()): Due {
  if (!l.date || !/^\d{4}-\d{2}-\d{2}$/.test(l.date)) return 'No date';
  const d = dayDiff(l.date, today);
  if (d < 0) return 'Overdue';
  if (d === 0) return 'Today';
  if (d === 1) return 'Tomorrow';
  if (d <= 6) return 'This week';
  return 'Later';
}

const isPriority = (l: Line) => /1\s*st|priority|urgent|last\s*pallet/i.test(l.remarks || '');

/** 0–100. Higher = needs attention first. Done lines score 0. */
export function priority(l: Line, today = todayLocal()): number {
  const a = action(l);
  if (a === 'Done') return 0;
  const dueScore: Record<Due, number> = { Overdue: 45, Today: 38, Tomorrow: 26, 'This week': 14, Later: 6, 'No date': 10 };
  const actScore: Record<Action, number> = { 'No stock': 30, 'Follow up TN': 22, 'Partial pull': 20, 'Release QI / Block': 18, 'Ready to pull': 12, Done: 0 };
  let s = dueScore[due(l, today)] + actScore[a];
  if (isPriority(l)) s += 15;
  if (l.qty >= 500) s += 6; else if (l.qty >= 100) s += 3;
  return Math.min(100, s);
}

/** ISO week number of a yyyy-mm-dd date. */
export function isoWeek(date: string): number {
  const d = new Date(date + 'T00:00:00Z');
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const firstThu = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  return 1 + Math.round(((d.getTime() - firstThu.getTime()) / 86400000 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
}

/** The plan's week: the ISO week most of its lines fall in. */
export function planWeek(rows: Line[]): number | null {
  const c = new Map<number, number>();
  for (const r of rows) if (r.date && /^\d{4}-\d{2}-\d{2}$/.test(r.date)) { const w = isoWeek(r.date); c.set(w, (c.get(w) || 0) + 1); }
  let best: number | null = null, n = 0;
  c.forEach((v, k) => { if (v > n) { n = v; best = k; } });
  return best;
}

export type View =
  | { kind: 'all' }
  | { kind: 'action'; value: Action }
  | { kind: 'due'; value: Due }
  | { kind: 'urgent' }
  | { kind: 'priority' };

export function matchView(l: Line, v: View, today: string): boolean {
  switch (v.kind) {
    case 'all': return true;
    case 'action': return action(l) === v.value;
    case 'due': return due(l, today) === v.value && action(l) !== 'Done';
    case 'urgent': { const d = due(l, today); return action(l) !== 'Done' && action(l) !== 'Ready to pull' && (d === 'Overdue' || d === 'Today'); }
    case 'priority': return action(l) !== 'Done' && isPriority(l);
  }
}

export interface Insight {
  id: string;
  tone: 'bad' | 'warn' | 'ok' | 'info' | 'accent';
  title: string;
  detail: string;
  view?: View;
}

const n0 = (x: number) => x.toLocaleString('en-US', { maximumFractionDigits: 0 });

/** Plain-language findings, most urgent first. Each can open the matching lines. */
export function insights(rows: Line[], uploads: Upload[], today = todayLocal()): Insight[] {
  const out: Insight[] = [];
  const open = rows.filter((l) => !isDone(l));
  const urgent = open.filter((l) => { const d = due(l, today); return (d === 'Overdue' || d === 'Today') && action(l) !== 'Ready to pull'; });
  if (urgent.length) out.push({ id: 'urgent', tone: 'bad', title: `${n0(urgent.length)} lines due today or overdue are short of stock`, detail: `${n0(urgent.reduce((s, l) => s + shortBy(l), 0))} QTY still to find. Start here.`, view: { kind: 'urgent' } });

  const ready = open.filter((l) => action(l) === 'Ready to pull');
  if (ready.length) out.push({ id: 'ready', tone: 'ok', title: `${n0(ready.length)} lines are ready to pull`, detail: `Full UR stock covers ${n0(ready.reduce((s, l) => s + l.qty, 0))} QTY. Mark them Done when loaded.`, view: { kind: 'action', value: 'Ready to pull' } });

  const qi = open.filter((l) => action(l) === 'Release QI / Block');
  if (qi.length) out.push({ id: 'qi', tone: 'info', title: `${n0(qi.length)} lines can be covered by releasing QI / Block`, detail: `${n0(qi.reduce((s, l) => s + Math.min(l.qi + l.block, shortBy(l)), 0))} QTY waiting in QI or blocked stock.`, view: { kind: 'action', value: 'Release QI / Block' } });

  const pr = open.filter((l) => isPriority(l) && action(l) !== 'Ready to pull');
  if (pr.length) out.push({ id: 'prio', tone: 'warn', title: `${n0(pr.length)} priority lines (1st priority / last pallet) still short`, detail: 'Flagged in the plan Remarks.', view: { kind: 'priority' } });

  const none = open.filter((l) => action(l) === 'No stock');
  if (none.length) out.push({ id: 'none', tone: 'bad', title: `${n0(none.length)} open lines have no stock and no TN`, detail: `${n0(none.reduce((s, l) => s + l.qty, 0))} QTY. Escalate or raise a TN.`, view: { kind: 'action', value: 'No stock' } });

  const tn = open.filter((l) => action(l) === 'Follow up TN');
  if (tn.length) out.push({ id: 'tn', tone: 'accent', title: `${n0(tn.length)} lines are waiting on a transfer note`, detail: 'No stock in ZMMBE yet, but a TN exists in TRR.', view: { kind: 'action', value: 'Follow up TN' } });

  // data health
  const up = new Map(uploads.map((u) => [u.src, u]));
  const missing = ['zmmbe', 'kfc', 'pfc', 'plant', 'trr'].filter((s) => !up.has(s));
  if (rows.length && missing.length) out.push({ id: 'missing', tone: 'warn', title: `${missing.length} report${missing.length > 1 ? 's' : ''} not uploaded yet`, detail: `Missing: ${missing.map((s) => ({ zmmbe: 'ZMMBE', kfc: 'ZMMBE KFC', pfc: 'ZMMBE PFC', plant: 'PLANT', trr: 'TRR' } as Record<string, string>)[s]).join(', ')}. Figures that use them show 0.` });
  const z = up.get('zmmbe');
  if (z && Date.now() - Date.parse(z.uploaded_at) > 12 * 3600 * 1000) out.push({ id: 'stale', tone: 'warn', title: 'Stock data is more than 12 hours old', detail: `ZMMBE was uploaded ${Math.round((Date.now() - Date.parse(z.uploaded_at)) / 3600000)} h ago. Upload a fresh export for today's picture.` });
  const p = up.get('plan');
  if (z && p && Date.parse(z.uploaded_at) < Date.parse(p.uploaded_at) - 6 * 3600 * 1000) out.push({ id: 'order', tone: 'warn', title: 'Stock is older than the plan', detail: 'The plan was uploaded well after the last ZMMBE. Upload ZMMBE again so stock matches the new lines.' });
  const dups = new Set(rows.filter((l) => l.dup > 1).map((l) => l.key)).size;
  if (dups) out.push({ id: 'dup', tone: 'info', title: `${n0(dups)} SO / LI / Item keys appear more than once in the plan`, detail: 'Their stock is shown on each line; totals count it once.' });

  if (!out.length && rows.length) out.push({ id: 'clear', tone: 'ok', title: 'Nothing needs attention', detail: 'Every open line is covered by UR stock.' });
  return out;
}
