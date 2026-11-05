/**
 * v151 Data Manager: the system's data level, sent by the Worker with the signed-in check.
 *   normal — as before · saver — reloads wait a little (one reload for a burst of changes) · strict — at most once a minute.
 * Only how often pages reload changes; the data and the pick checks do not.
 */
export type Level = 'normal' | 'saver' | 'strict';
let level: Level = 'normal';
let pct: number | null = null;
const subs = new Set<() => void>();
export const getLevel = () => level;
export const getPct = () => pct;
export function setBudget(l: unknown, p: unknown) {
  const nl: Level = l === 'saver' || l === 'strict' ? l : 'normal';
  const np = typeof p === 'number' && Number.isFinite(p) ? p : null;
  if (nl === level && np === pct) return;
  level = nl; pct = np; subs.forEach((f) => f());
}
export function onBudget(f: () => void) { subs.add(f); return () => { subs.delete(f); }; }
/** a wait (ms) stretched for the level: ×1 normal, ×3 saver, ×6 strict */
export const stretch = (ms: number) => ms * (level === 'strict' ? 6 : level === 'saver' ? 3 : 1);
/** how long a burst of change messages is gathered into one reload */
export const gatherMs = () => (level === 'strict' ? 60000 : level === 'saver' ? 20000 : 0);
