/**
 * Smart roll suggestion for manual selection: which rolls to take for the QTY still open, chosen like an experienced
 * picker would — and checked more carefully than one can by eye. Every possible set is scored on:
 *   1. covers the QTY (never short when a full cover exists), inside each ZINSR lot's QTY and each batch's need
 *   2. no cut, or one cut only — an already-cut roll first, and no tiny stub left on the shelf
 *   3. one shade (rolls of one shade go together), then one Lot Number, then few locations
 *   4. SAP fit (Item, Batch, ZINSR lot, Vendor Batch, Invoice, Po, HU, SO / LI, bin), FIFO (oldest first)
 *   5. this line's share of a shared lot, not another line's; fewer rolls
 * Up to 14 rolls every combination is scored (the best set is certain). With more rolls, start sets (each shade, each lot,
 * the oldest, the best fit, exact no-cut sets) are improved by swapping rolls in and out until no change makes the set better. Nothing is picked automatically: the user sees the set, the reasons and the
 * alternatives, and takes it with one click.
 */
import type { SapFit } from './pick';

export interface SRoll {
  pallet: string; available: number; blocked?: string | null;
  sap?: SapFit | null; fifo?: string | null; shade?: string | null; lot?: string | null; location?: string | null;
  picked_before?: number; suggested?: boolean; pool?: number; needsConfirm?: boolean;
  /** the ZINSR inspection lots (and batch) the roll's QTY counts for */
  parts?: { batch: string; lot: string; qty: number }[]; insp_lots?: string[]; batches?: string[];
  /** the rest of the roll stays with the same SO plant: a cut is not needed */
  sameSoPlant?: unknown;
}
export interface SuggestOpts {
  need: number;
  /** what each ZINSR lot still gives this SO line */
  lotCaps?: Map<string, number>;
  /** what each ZMMBE batch still needs */
  batchNeed?: Map<string, number>;
  /** pallets already chosen by the user (not offered again) */
  exclude?: Set<string>;
}
export interface SuggestPick { pallet: string; qty: number; cut: boolean; left: number }
export interface Suggestion {
  picks: SuggestPick[]; total: number; need: number; short: number; cuts: number; shades: string[]; lots: string[]; locations: string[];
  cost: number; reasons: string[]; warnings: string[];
}
export interface SuggestResult { best: Suggestion | null; alts: Suggestion[]; considered: number; left: { pallet: string; why: string }[] }

const EPS = 0.0005;
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const day = (s?: string | null) => (s && /^\d{4}-\d{2}-\d{2}/.test(s) ? Date.parse(s.slice(0, 10)) / 86400000 : null);
const nshade = (s?: string | null) => String(s ?? '').trim().toUpperCase();
const lotsOf = (r: SRoll) => Array.from(new Set((r.parts?.length ? r.parts.map((p) => p.lot) : r.insp_lots || []).map(String).filter(Boolean)));
const hardMiss = (r: SRoll) => (r.sap?.miss || []).find((m) => /^(Item|Batch)\b/.test(m));
const fq = (n: number) => r3(n).toLocaleString(undefined, { maximumFractionDigits: 3 });

export function smartSuggest(rows: SRoll[], o: SuggestOpts): SuggestResult {
  const need = r3(o.need);
  const left: { pallet: string; why: string }[] = [];
  if (!(need > EPS)) return { best: null, alts: [], considered: 0, left };
  // 1. who may take part
  const pool: SRoll[] = [];
  for (const r of rows) {
    if (o.exclude?.has(r.pallet)) continue;
    if (!(r.available > EPS)) continue;
    if (r.blocked) { left.push({ pallet: r.pallet, why: r.blocked }); continue; }
    const hm = hardMiss(r);
    if (hm) { left.push({ pallet: r.pallet, why: `SAP: ${hm}` }); continue; }
    pool.push(r);
  }
  if (!pool.length) return { best: null, alts: [], considered: 0, left };

  // 2. each roll on its own: SAP fit, FIFO age, confirmations, another line's share
  const maxSap = Math.max(0, ...pool.map((r) => r.sap?.score ?? 0));
  const days = pool.map((r) => day(r.fifo)).filter((x): x is number => x !== null);
  const oldest = days.length ? Math.min(...days) : null;
  const anySug = pool.some((r) => r.suggested);
  const own = new Map<string, number>();
  for (const r of pool) {
    let c = 0;
    c += r.sap ? Math.max(0, maxSap - r.sap.score) / 4 + r.sap.miss.length * 4 : 3;
    const d = day(r.fifo);
    c += d === null || oldest === null ? 6 : Math.min(24, ((d - oldest) / 30) * 3);
    if (r.needsConfirm) c += 14;
    if (r.pool && !r.suggested && anySug) c += 45; // another SO line's share of a shared lot (when this line has its own share)
    if (r.suggested) c -= 4;
    if ((r.picked_before ?? 0) > EPS) c -= 5; // finish a roll that is already open
    own.set(r.pallet, c);
  }
  // the best rolls (by their own score) are searched: at least 32, and enough to cover the QTY 1.5 times (up to 120)
  const ranked = [...pool].sort((a, b) => own.get(a.pallet)! - own.get(b.pallet)!);
  let cut = 0, acc = 0;
  for (const r of ranked) { if (cut >= 120 || (cut >= 32 && acc >= need * 1.5)) break; acc += r.available; cut++; }
  const P = ranked.slice(0, cut);
  const idx = new Map(P.map((r, i) => [r.pallet, i]));

  // 3. a set's QTY per roll (lot caps and batch needs), its cuts, and its cost
  const plan = (set: number[]) => {
    // the roll to cut goes last: an already-cut roll, else the one that leaves the most usable rest
    const order = [...set].sort((a, b) => own.get(P[a].pallet)! - own.get(P[b].pallet)!);
    const tryOrder = (ord: number[]) => {
      // each order starts from the full lot QTY and batch need
      const caps = new Map(o.lotCaps || []);
      const bneed = new Map(o.batchNeed || []);
      let rest = need; const picks: SuggestPick[] = []; let capHit = 0, batchOver = 0;
      for (const i of ord) {
        const r = P[i];
        let q = Math.min(r.available, rest);
        const ls = lotsOf(r).filter((l) => caps.has(l));
        if (ls.length) { const room = ls.reduce((t, l) => t + (caps.get(l) ?? 0), 0); if (room < q - EPS) { q = Math.max(0, room); capHit++; } }
        q = r3(q);
        if (q > EPS) {
          let t = q; for (const l of ls) { if (t <= EPS) break; const g = Math.min(caps.get(l) ?? 0, t); caps.set(l, r3((caps.get(l) ?? 0) - g)); t = r3(t - g); }
          if (bneed.size) {
            let t2 = q;
            const parts = r.parts?.length ? r.parts : (r.batches || []).slice(0, 1).map((b) => ({ batch: b, lot: '', qty: q }));
            for (const p of parts) { if (t2 <= EPS) break; if (!bneed.has(p.batch)) continue; const g = Math.min(p.qty, t2); const nb = r3((bneed.get(p.batch) ?? 0) - g); if (nb < -EPS) batchOver += -nb; bneed.set(p.batch, Math.max(0, nb)); t2 = r3(t2 - g); }
          }
        }
        picks.push({ pallet: r.pallet, qty: q, cut: q < r.available - EPS && q > EPS, left: r3(r.available - q) });
        rest = r3(rest - q);
      }
      return { picks, rest, capHit, batchOver };
    };
    let best: ReturnType<typeof tryOrder> & { cost: number } | null = null;
    // which roll is cut matters: try each roll of the set as the last one (small sets) and keep the cheapest
    const lasts = order.length <= 8 ? order : order.slice(-3);
    for (const last of lasts) {
      const ord = [...order.filter((i) => i !== last), last];
      const x = tryOrder(ord);
      const cost = costOf(x.picks, x.rest, x.capHit, x.batchOver);
      if (!best || cost < best.cost) best = { ...x, cost };
    }
    return best!;
  };
  const costOf = (picks: SuggestPick[], rest: number, capHit: number, batchOver: number) => {
    let c = 0;
    const used = picks.filter((p) => p.qty > EPS);
    if (rest > EPS) c += 400 + (2500 * rest) / need; // short: every missing unit counts more than a cut or an extra roll
    c += (picks.length - used.length) * 60; // a roll that gives nothing
    c += capHit * 6 + batchOver * 4;
    for (const p of used) {
      const r = P[idx.get(p.pallet)!];
      c += own.get(p.pallet)! + 3; // each roll: its own cost + one more roll to move
      if (p.cut) {
        c += (r.picked_before ?? 0) > EPS ? 7 : r.sameSoPlant ? 9 : 18;
        // a tiny stub left on the shelf is the worst cut
        if (p.left < Math.max(1, 0.05 * r.available)) c += 28;
      }
    }
    const sh = new Set(used.map((p) => nshade(P[idx.get(p.pallet)!].shade)).filter(Boolean));
    const noShade = used.filter((p) => !nshade(P[idx.get(p.pallet)!].shade)).length;
    c += Math.max(0, sh.size - 1) * 26 + noShade * 2;
    const lt = new Set(used.map((p) => String(P[idx.get(p.pallet)!].lot ?? '').trim().toUpperCase()).filter(Boolean));
    c += Math.max(0, lt.size - 1) * 7;
    const loc = new Set(used.map((p) => String(P[idx.get(p.pallet)!].location ?? '').trim().toUpperCase()).filter(Boolean));
    c += Math.max(0, loc.size - 1) * 2;
    return c;
  };
  // the same set is scored once; the whole search stays under ~300 ms
  const memo = new Map<string, number>();
  const t0 = Date.now(), late = () => Date.now() - t0 > 300;
  const evalSet = (set: number[]) => {
    if (!set.length) return Infinity;
    const k = [...set].sort((a, b) => a - b).join(',');
    let c = memo.get(k);
    if (c === undefined) { c = plan(set).cost; memo.set(k, c); }
    return c;
  };

  // 4. start sets: greedy cover in several orders, inside each shade / lot, and exact (no-cut) sets
  const greedy = (order: number[]) => { const s: number[] = []; let q = 0; for (const i of order) { if (q >= need - EPS) break; s.push(i); q += P[i].available; } return s; };
  const all = P.map((_, i) => i);
  const byOwn = [...all];
  const byFifo = [...all].sort((a, b) => (day(P[a].fifo) ?? 1e9) - (day(P[b].fifo) ?? 1e9));
  const byBig = [...all].sort((a, b) => P[b].available - P[a].available);
  const bySap = [...all].sort((a, b) => (P[b].sap?.score ?? 0) - (P[a].sap?.score ?? 0));
  const starts: number[][] = [greedy(byOwn), greedy(byFifo), greedy(byBig), greedy(bySap)];
  const groupBy = (key: (r: SRoll) => string) => {
    const g = new Map<string, number[]>();
    for (const i of all) { const k = key(P[i]); if (!k) continue; if (!g.has(k)) g.set(k, []); g.get(k)!.push(i); }
    return Array.from(g.values());
  };
  for (const grp of [...groupBy((r) => nshade(r.shade)), ...groupBy((r) => String(r.lot ?? '').trim().toUpperCase())]) {
    starts.push(greedy(grp), greedy([...grp].sort((a, b) => P[b].available - P[a].available)));
    const ex = exactCover(grp.map((i) => ({ i, q: P[i].available })), need);
    if (ex) starts.push(ex);
  }
  { const ex = exactCover(all.map((i) => ({ i, q: P[i].available })), need); if (ex) starts.push(ex); }

  // 5. improve each start: drop / add / swap one for one / one for two, while the cost goes down
  const climb = (s0: number[]) => {
    let s = [...s0], cur = evalSet(s);
    for (let round = 0; round < 40 && !late(); round++) {
      let bestS: number[] | null = null, bestC = cur;
      const out = all.filter((i) => !s.includes(i));
      const consider = (t: number[]) => { const c = evalSet(t); if (c < bestC - 1e-9) { bestC = c; bestS = t; } };
      for (const i of s) consider(s.filter((x) => x !== i));
      for (const j of out) consider([...s, j]);
      for (const i of s) for (const j of out) consider([...s.filter((x) => x !== i), j]);
      if (P.length <= 24 && s.length <= 12) for (const i of s) for (let a = 0; a < out.length; a++) for (let b = a + 1; b < out.length; b++) consider([...s.filter((x) => x !== i), out[a], out[b]]);
      if (s.length <= 16) for (let a = 0; a < s.length; a++) for (let b = a + 1; b < s.length; b++) for (const j of out) consider([...s.filter((x) => x !== s[a] && x !== s[b]), j]);
      if (!bestS) break;
      s = bestS; cur = bestC;
    }
    return s;
  };
  const seen = new Map<string, { set: number[]; cost: number }>();
  // up to 14 rolls: every combination is scored — the best set is certain, not a guess
  const free = !o.lotCaps?.size && !o.batchNeed?.size, poolSum = P.reduce((t, r) => t + r.available, 0);
  if (P.length <= 14) {
    const top: { set: number[]; cost: number }[] = [];
    for (let mask = 1; mask < 1 << P.length; mask++) {
      const st: number[] = []; let sum = 0; for (let i = 0; i < P.length; i++) if (mask & (1 << i)) { st.push(i); sum += P[i].available; }
      // without lot / batch limits a set that does not cover the QTY can never beat one that does
      if (free && poolSum >= need - EPS && sum < need - EPS) continue;
      const c = plan(st).cost;
      if (top.length < 3 || c < top[top.length - 1].cost) { top.push({ set: st, cost: c }); top.sort((x, y) => x.cost - y.cost); if (top.length > 3) top.pop(); }
    }
    for (const x of top) seen.set(x.set.join(','), x);
    starts.length = 0;
  }
  for (const st of starts) {
    if (!st.length) continue;
    const s = climb(st);
    const k = [...s].sort((a, b) => a - b).join(',');
    if (!seen.has(k)) seen.set(k, { set: s, cost: evalSet(s) });
  }
  const sets = Array.from(seen.values()).sort((a, b) => a.cost - b.cost);
  const toSug = (x: { set: number[]; cost: number }): Suggestion => describe(x.set, x.cost);
  const describe = (set: number[], cost: number): Suggestion => {
    const p = plan(set);
    const picks = p.picks.filter((x) => x.qty > EPS);
    const rs = picks.map((x) => P[idx.get(x.pallet)!]);
    const total = r3(picks.reduce((t, x) => t + x.qty, 0));
    const shades = Array.from(new Set(rs.map((r) => nshade(r.shade)).filter(Boolean)));
    const lots = Array.from(new Set(rs.map((r) => String(r.lot ?? '').trim()).filter(Boolean)));
    const locations = Array.from(new Set(rs.map((r) => String(r.location ?? '').trim()).filter(Boolean)));
    const cuts = picks.filter((x) => x.cut);
    const reasons: string[] = [], warnings: string[] = [];
    reasons.push(p.rest > EPS ? `${picks.length} roll${picks.length === 1 ? '' : 's'} give ${fq(total)} of ${fq(need)}` : !cuts.length ? `${picks.length} full roll${picks.length === 1 ? '' : 's'} = ${fq(total)} — exactly the QTY, no cut` : `${picks.length} roll${picks.length === 1 ? '' : 's'} = ${fq(need)}, ${cuts.length === 1 ? 'one cut' : `${cuts.length} cuts (a ZINSR lot limits a roll)`}`);
    for (const c of cuts) {
      const r = P[idx.get(c.pallet)!];
      reasons.push(`Cut ${c.pallet}: take ${fq(c.qty)}, ${fq(c.left)} stays${(r.picked_before ?? 0) > EPS ? ' (already a cut roll — no new cut on the shelf)' : r.sameSoPlant ? ' (the rest stays with the same SO plant)' : ''}`);
      if (c.left < Math.max(1, 0.05 * r.available)) warnings.push(`${c.pallet} leaves only ${fq(c.left)} — consider sending it in full`);
    }
    if (shades.length === 1) reasons.push(`One shade: ${shades[0]}${rs.length > 1 ? ` (all ${rs.length} rolls)` : ''}`);
    else if (shades.length > 1) { const per = shades.map((s) => `${s} ×${rs.filter((r) => nshade(r.shade) === s).length}`); reasons.push(`${shades.length} shades (${per.join(', ')}) — no single shade covers the QTY`); warnings.push(`Mixed shades: ${shades.join(', ')}`); }
    if (lots.length === 1 && rs.length > 1) reasons.push(`One Lot Number: ${lots[0]}`);
    else if (lots.length > 1) reasons.push(`${lots.length} Lot Numbers`);
    const sapOk = rs.filter((r) => r.sap && !r.sap.miss.length).length;
    if (rs.some((r) => r.sap)) reasons.push(sapOk === rs.length ? 'SAP: every roll matches (Item, Batch, ZINSR lot…)' : `SAP: ${sapOk} of ${rs.length} rolls match every field`);
    const ds = rs.map((r) => day(r.fifo)).filter((x): x is number => x !== null);
    if (ds.length) { const mn = Math.min(...ds), mx = Math.max(...ds); const f = (d: number) => new Date(d * 86400000).toISOString().slice(0, 10).split('-').reverse().join('-'); reasons.push(`FIFO ${f(mn)}${mx > mn ? ` → ${f(mx)}` : ''}${oldest !== null && mn <= oldest + 0.5 ? ' (the oldest roll first)' : ''}`); }
    const opened = rs.filter((r) => (r.picked_before ?? 0) > EPS).length;
    if (opened) reasons.push(`Finishes ${opened} roll${opened === 1 ? '' : 's'} already cut before`);
    if (locations.length) reasons.push(`${locations.length} location${locations.length === 1 ? '' : 's'}: ${locations.slice(0, 4).join(', ')}${locations.length > 4 ? '…' : ''}`);
    if (o.lotCaps?.size) reasons.push(p.capHit ? 'Kept inside each ZINSR lot QTY (a lot limits a roll)' : 'Inside each ZINSR lot QTY');
    if (rs.some((r) => r.pool && !r.suggested)) warnings.push('Uses a roll suggested for another SO line of the shared lot');
    if (rs.some((r) => r.needsConfirm)) warnings.push('A roll needs “I checked” (see its Check)');
    if (p.rest > EPS) warnings.push(`Short ${fq(p.rest)}: the rolls here do not cover the QTY`);
    return { picks, total, need, short: r3(Math.max(0, p.rest)), cuts: cuts.length, shades, lots, locations, cost, reasons, warnings };
  };
  const best = sets[0] ? toSug(sets[0]) : null;
  const alts = sets.slice(1).filter((x) => x.cost < Infinity).slice(0, 2).map(toSug);
  return { best, alts, considered: P.length, left };
}

/** The fewest rolls whose QTY is exactly `target` (no cut); searched over up to 20 rolls. */
function exactCover(items: { i: number; q: number }[], target: number): number[] | null {
  const xs = items.filter((x) => x.q <= target + EPS).sort((a, b) => b.q - a.q).slice(0, 20);
  let best: number[] | null = null, nodes = 0;
  const go = (k: number, sum: number, cur: number[]) => {
    if (++nodes > 150000) return;
    if (Math.abs(sum - target) <= EPS) { if (!best || cur.length < best.length) best = [...cur]; return; }
    if (k >= xs.length || sum > target + EPS || (best && cur.length + 1 >= best.length)) return;
    let restSum = 0; for (let j = k; j < xs.length; j++) restSum += xs[j].q;
    if (sum + restSum < target - EPS) return;
    cur.push(xs[k].i); go(k + 1, sum + xs[k].q, cur); cur.pop();
    go(k + 1, sum, cur);
  };
  go(0, 0, []);
  return best;
}

/** The pallets of the best set (★ Best), remembered for the same rolls and QTY so a click does not search again. */
const cache = new Map<string, Set<string>>();
export function smartBest(rows: SRoll[], need: number, o: Omit<SuggestOpts, 'need'> = {}): Set<string> {
  if (!(need > EPS) || !Number.isFinite(need)) return new Set();
  const key = `${r3(need)}|${rows.map((r) => `${r.pallet}:${r3(r.available)}:${r.blocked ? 1 : 0}`).join(',')}|${Array.from(o.lotCaps || []).join(';')}|${Array.from(o.exclude || []).join(',')}`;
  let s = cache.get(key);
  if (!s) {
    s = new Set((smartSuggest(rows, { ...o, need }).best?.picks || []).map((p) => p.pallet));
    if (cache.size > 200) cache.clear();
    cache.set(key, s);
  }
  return s;
}
