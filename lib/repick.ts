/**
 * v203 (API 131): picking a Pick's balance again after new reports, the JOB ID of a Pick and balances completed by hand.
 * Pick all matched runs: the first run keeps each line's UR / QI / Block ("first UR"); a run after new reports is a
 * "balance pick". A pick belongs to the last run that began before it was saved (none yet: the 1st pick).
 */
import { api } from '@/lib/api';

export interface PickRun { rid: string; n: number; started_at: string; by_user: string | null }
export interface UrBase { rid: string; key: string; date: string; qty: number; ur: number; qi: number; block: number; at: string }
export type BalCat = 'block' | 'qi' | 'dispatched' | 'shortage';
export interface BalClose { rid: string; key: string; date: string; plant: string | null; cat: BalCat; qty: number; by_user: string | null; at: string }
export interface RepickData { jobs: { rid: string; job_id: string }[]; runs: PickRun[]; base: UrBase[]; close: BalClose[] }

export const EMPTY_REPICK: RepickData = { jobs: [], runs: [], base: [], close: [] };
export const BAL_CATS: { v: BalCat; label: string }[] = [
  { v: 'block', label: 'Block' }, { v: 'qi', label: 'QI' }, { v: 'dispatched', label: 'Dispatched' }, { v: 'shortage', label: 'Shortage' },
];
export const catLabel = (c: string) => BAL_CATS.find((x) => x.v === c)?.label ?? c;

export async function loadRepick(rids: string[]): Promise<RepickData> {
  const ids = Array.from(new Set(rids.filter(Boolean))).sort();
  if (!ids.length) return EMPTY_REPICK;
  try { return await api<RepickData>('/api/repick?rids=' + encodeURIComponent(ids.join(','))); } catch { return EMPTY_REPICK; }
}

/** the run a pick belongs to: the last run of its Pick that began before it was saved (1 = the 1st pick) */
export function runOf(runs: PickRun[], rid: string, at: string): number {
  let n = 1;
  for (const r of runs) if (r.rid === rid && r.started_at <= at && r.n > n) n = r.n;
  return n;
}
export const runLabel = (n: number) => (n <= 1 ? '1st pick' : `Balance pick ${n - 1}`);

/** the line key used by the re-pick tables: Pick (plan) + SO|LI|Item + date */
export const lineRef = (l: { week: string; key: string; date?: string | null }) => `${l.week}|${l.key}|${l.date ?? ''}`;
