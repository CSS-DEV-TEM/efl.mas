/** Releasing QI / Block stock to UR: how much each line needs, QI first, then Block. */
import { api } from './api';
import { avail, need, type Line } from './calc';

export function releaseFor(l: Line) {
  const short = Math.max(0, need(l) - avail(l));
  const qi = Math.min(short, l.qi);
  const block = Math.min(short - qi, l.block);
  return { key: l.key, qi: Math.round(qi * 1000) / 1000, block: Math.round(block * 1000) / 1000 };
}
export const canRelease = (l: Line) => { const r = releaseFor(l); return r.qi + r.block > 1e-9; };

/** One release per SO|LI|Item (stock is per key); returns the QTY released. */
export async function releaseLines(week: string, lines: Line[]) {
  const by = new Map<string, { key: string; qi: number; block: number }>();
  for (const l of lines) { const r = releaseFor(l); if (r.qi + r.block <= 1e-9) continue; const o = by.get(l.key); if (!o || o.qi + o.block < r.qi + r.block) by.set(l.key, r); }
  const list = Array.from(by.values());
  if (!list.length) throw new Error('Nothing to release: no QI or Block stock is needed on these lines.');
  await api('/api/release', { method: 'POST', body: { week, lines: list } });
  return { lines: list.length, qty: list.reduce((t, r) => t + r.qi + r.block, 0) };
}
export const undoRelease = (week: string, key: string) => api('/api/release?week=' + encodeURIComponent(week) + '&key=' + encodeURIComponent(key), { method: 'DELETE' });
