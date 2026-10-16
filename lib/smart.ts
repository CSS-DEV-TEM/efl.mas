/**
 * Smart layer: turns each plan line into a next action, a due status and a priority score,
 * and works out the insights shown at the top of the dashboard.
 */
import { avail, isDispatched, isDone, need, shortBy, type DispatchSummary, type Line, type Upload } from './calc';

export type Action = 'Dispatched' | 'Done' | 'Ready to pull' | 'Release QI / Block' | 'Partial pull' | 'Follow up TN' | 'No stock';
export const ACTIONS: Action[] = ['Ready to pull', 'Release QI / Block', 'Partial pull', 'Follow up TN', 'No stock', 'Dispatched', 'Done'];
export const ACTION_PILL: Record<Action, string> = {
  'Ready to pull': 'ok', 'Release QI / Block': 'info', 'Partial pull': 'warn', 'Follow up TN': 'accent', 'No stock': 'bad', Dispatched: 'ok', Done: 'mute',
};
export const ACTION_HELP: Record<Action, string> = {
  'Ready to pull': 'Full UR stock covers the QTY',
  'Release QI / Block': 'UR alone is short, but UR + QI + Block covers the QTY',
  'Partial pull': 'Some UR stock, not enough for the QTY',
  'Follow up TN': 'No stock in ZMMBE, but a transfer note exists',
  'No stock': 'Nothing in ZMMBE and no TN',
  Dispatched: 'The whole QTY went out on a dispatch — complete',
  Done: 'Marked Done',
};

/** The next thing to do for a line. */
export function action(l: Line): Action {
  if (isDispatched(l)) return 'Dispatched';
  if (isDone(l)) return 'Done';
  const n = need(l), u = avail(l);
  if (n > 0 && u >= n - 1e-9) return 'Ready to pull';
  if (l.qi + l.block > 0 && u + l.qi + l.block >= n - 1e-9) return 'Release QI / Block';
  if (u > 0) return 'Partial pull';
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
  if (a === 'Done' || a === 'Dispatched') return 0;
  const dueScore: Record<Due, number> = { Overdue: 45, Today: 38, Tomorrow: 26, 'This week': 14, Later: 6, 'No date': 10 };
  const actScore: Record<Action, number> = { Dispatched: 0, 'No stock': 30, 'Follow up TN': 22, 'Partial pull': 20, 'Release QI / Block': 18, 'Ready to pull': 12, Done: 0 };
  let s = dueScore[due(l, today)] + actScore[a];
  if (isPriority(l)) s += 15;
  if (l.carried) s += 10; // already slipped once
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

/** ISO week id of a yyyy-mm-dd date, e.g. "2026-W43" (same rule as the server). */
export function weekIdOf(date: string): string {
  const d = new Date(date + 'T00:00:00Z');
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  return `${d.getUTCFullYear()}-W${String(isoWeek(date)).padStart(2, '0')}`;
}
/** Monday and Sunday (yyyy-mm-dd) of an ISO week id. */
export function weekDays(id: string): [string, string] {
  const [y, w] = [Number(id.slice(0, 4)), Number(id.slice(-2))];
  const jan4 = new Date(Date.UTC(y, 0, 4));
  const mon = new Date(jan4.getTime() - ((jan4.getUTCDay() + 6) % 7) * 86400000 + (w - 1) * 7 * 86400000);
  const sun = new Date(mon.getTime() + 6 * 86400000);
  return [mon.toISOString().slice(0, 10), sun.toISOString().slice(0, 10)];
}
/** Week ids around a centre week, for pickers. */
export function weekOptions(centre: string, before = 6, after = 8): string[] {
  const [mon] = weekDays(centre);
  const out: string[] = [];
  for (let i = -before; i <= after; i++) out.push(weekIdOf(new Date(Date.parse(mon + 'T00:00:00Z') + i * 7 * 86400000).toISOString().slice(0, 10)));
  return out;
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
  | { kind: 'priority' }
  | { kind: 'carried' }
  | { kind: 'dup' }
  | { kind: 'partdisp' };

export function matchView(l: Line, v: View, today: string): boolean {
  switch (v.kind) {
    case 'all': return true;
    case 'action': return action(l) === v.value;
    case 'due': return due(l, today) === v.value && action(l) !== 'Done';
    case 'urgent': { const d = due(l, today); return action(l) !== 'Done' && action(l) !== 'Ready to pull' && (d === 'Overdue' || d === 'Today'); }
    case 'priority': return action(l) !== 'Done' && isPriority(l);
    case 'carried': return action(l) !== 'Done' && !!l.carried;
    case 'dup': return l.dup > 1;
    case 'partdisp': return (l.dispatched ?? 0) > 0 && !isDispatched(l);
  }
}

export interface Insight {
  id: string;
  tone: 'bad' | 'warn' | 'ok' | 'info' | 'accent';
  /** big number on the compact card */
  count: number | string;
  /** short label on the compact card */
  label: string;
  /** full sentence, shown when the card is opened */
  title: string;
  detail: string;
  view?: View;
}

const n0 = (x: number) => x.toLocaleString('en-US', { maximumFractionDigits: 0 });
const L = (n: number) => `${n0(n)} line${n === 1 ? '' : 's'}`;
const are = (n: number) => (n === 1 ? 'is' : 'are');

/** Plain-language findings, most urgent first. Each can open the matching lines. */
export function insights(rows: Line[], uploads: Upload[], today = todayLocal(), dispatch?: DispatchSummary | null): Insight[] {
  const out: Insight[] = [];
  if (dispatch && dispatch.items.length) {
    const full = rows.filter(isDispatched);
    if (full.length) out.push({ id: 'disp', tone: 'ok', count: full.length, label: 'Dispatched — complete', title: `${L(full.length)} fully dispatched`, detail: `${n0(full.reduce((s, l) => s + l.qty, 0))} QTY went out. These lines count as complete.`, view: { kind: 'action', value: 'Dispatched' } });
    const part = rows.filter((l) => (l.dispatched ?? 0) > 0 && !isDispatched(l));
    if (part.length) out.push({ id: 'partdisp', tone: 'accent', count: part.length, label: 'Part dispatched', title: `${L(part.length)} part dispatched`, detail: `${n0(part.reduce((s, l) => s + need(l), 0))} QTY balance still to send.`, view: { kind: 'partdisp' } });
    if (dispatch.unmatched.length) out.push({ id: 'dispnomatch', tone: 'warn', count: dispatch.unmatched.length, label: 'Dispatch not in plan', title: `${dispatch.unmatched.length} dispatched item${dispatch.unmatched.length === 1 ? ' is' : 's are'} not in this week's plan`, detail: `${dispatch.unmatched.slice(0, 6).map((i) => i.item).join(', ')}${dispatch.unmatched.length > 6 ? '…' : ''} — ${n0(dispatch.unmatched.reduce((s, i) => s + i.dispatched, 0))} QTY. Check the Item Code or the week.` });
    const over = dispatch.items.filter((i) => i.lines > 0 && i.over > 0);
    if (over.length) out.push({ id: 'dispover', tone: 'warn', count: over.length, label: 'Dispatched over plan', title: `${over.length} item${over.length === 1 ? '' : 's'} dispatched more than planned`, detail: over.slice(0, 5).map((i) => `${i.item} +${i.over.toLocaleString('en-US', { maximumFractionDigits: 3 })}`).join(', ') });
  }
  const open = rows.filter((l) => !isDone(l));
  const urgent = open.filter((l) => { const d = due(l, today); return (d === 'Overdue' || d === 'Today') && action(l) !== 'Ready to pull'; });
  if (urgent.length) out.push({ id: 'urgent', tone: 'bad', count: urgent.length, label: 'Due / overdue & short', title: `${L(urgent.length)} due today or overdue ${are(urgent.length)} short of stock`, detail: `${n0(urgent.reduce((s, l) => s + shortBy(l), 0))} QTY still to find. Start here.`, view: { kind: 'urgent' } });

  const ready = open.filter((l) => action(l) === 'Ready to pull');
  if (ready.length) out.push({ id: 'ready', tone: 'ok', count: ready.length, label: 'Ready to pull', title: `${L(ready.length)} ${are(ready.length)} ready to pull`, detail: `Full UR stock covers ${n0(ready.reduce((s, l) => s + l.qty, 0))} QTY. Mark them Done when loaded.`, view: { kind: 'action', value: 'Ready to pull' } });

  const qi = open.filter((l) => action(l) === 'Release QI / Block');
  if (qi.length) out.push({ id: 'qi', tone: 'info', count: qi.length, label: 'Release QI / Block', title: `${L(qi.length)} can be covered by releasing QI / Block`, detail: `${n0(qi.reduce((s, l) => s + Math.min(l.qi + l.block, shortBy(l)), 0))} QTY waiting in QI or blocked stock.`, view: { kind: 'action', value: 'Release QI / Block' } });

  const carried = open.filter((l) => l.carried);
  if (carried.length) out.push({ id: 'carried', tone: 'warn', count: carried.length, label: 'Carried over', title: `${L(carried.length)} carried over from last week`, detail: `They were in the previous week's plan and not marked Done. ${n0(carried.reduce((s, l) => s + shortBy(l), 0))} QTY still short.`, view: { kind: 'carried' } });

  const pr = open.filter((l) => isPriority(l) && action(l) !== 'Ready to pull');
  if (pr.length) out.push({ id: 'prio', tone: 'warn', count: pr.length, label: 'Priority still short', title: `${n0(pr.length)} priority line${pr.length === 1 ? '' : 's'} (1st priority / last pallet) still short`, detail: 'Flagged in the plan Remarks.', view: { kind: 'priority' } });

  const none = open.filter((l) => action(l) === 'No stock');
  if (none.length) out.push({ id: 'none', tone: 'bad', count: none.length, label: 'No stock, no TN', title: `${n0(none.length)} open line${none.length === 1 ? ' has' : 's have'} no stock and no TN`, detail: `${n0(none.reduce((s, l) => s + l.qty, 0))} QTY. Escalate or raise a TN.`, view: { kind: 'action', value: 'No stock' } });

  const tn = open.filter((l) => action(l) === 'Follow up TN');
  if (tn.length) out.push({ id: 'tn', tone: 'accent', count: tn.length, label: 'Waiting on TN', title: `${L(tn.length)} ${are(tn.length)} waiting on a transfer note`, detail: 'No stock in ZMMBE yet, but a TN exists in TRR.', view: { kind: 'action', value: 'Follow up TN' } });

  // data health
  const up = new Map(uploads.map((u) => [u.src, u]));
  const missing = ['zmmbe', 'kfc', 'pfc', 'plant'].filter((s) => !up.has(s));
  if (rows.length && missing.length) out.push({ id: 'missing', tone: 'warn', count: missing.length, label: 'Reports missing', title: `${missing.length} report${missing.length > 1 ? 's' : ''} not uploaded yet`, detail: `Missing: ${missing.map((s) => ({ zmmbe: 'ZMMBE', kfc: 'ZMMBE KFC', pfc: 'ZMMBE PFC', plant: 'PLANT', trr: 'TRR' } as Record<string, string>)[s]).join(', ')}. Figures that use them show 0.` });
  const z = up.get('zmmbe');
  if (z && Date.now() - Date.parse(z.uploaded_at) > 12 * 3600 * 1000) out.push({ id: 'stale', tone: 'warn', count: `${Math.round((Date.now() - Date.parse(z.uploaded_at)) / 3600000)}h`, label: 'Stock data age', title: 'Stock data is more than 12 hours old', detail: `ZMMBE was uploaded ${Math.round((Date.now() - Date.parse(z.uploaded_at)) / 3600000)} h ago. Upload a fresh export for today's picture.` });
  const p = up.get('plan');
  if (z && p && Date.parse(z.uploaded_at) < Date.parse(p.uploaded_at) - 6 * 3600 * 1000) out.push({ id: 'order', tone: 'warn', count: '!', label: 'Stock older than plan', title: 'Stock is older than the plan', detail: 'The plan was uploaded well after the last ZMMBE. Upload ZMMBE again so stock matches the new lines.' });
  const dups = new Set(rows.filter((l) => l.dup > 1).map((l) => l.key)).size;
  if (dups) out.push({ id: 'dup', tone: 'info', count: dups, label: 'Repeated SO / LI / Item', view: { kind: 'dup' }, title: `${n0(dups)} SO / LI / Item keys appear more than once in the plan`, detail: 'Their stock is shown on each line; totals count it once.' });

  if (!out.length && rows.length) out.push({ id: 'clear', tone: 'ok', count: '✓', label: 'All covered', title: 'Nothing needs attention', detail: 'Every open line is covered by UR stock.' });
  return out;
}
