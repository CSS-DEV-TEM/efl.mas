/**
 * Plant-wise summary, laid out like the daily pull summary sheet:
 * Plan QTY → split into what UR covers, what QI / Block could cover, and what is not in house (NIH),
 * each with its SO/LI line count (SOLI).
 */
import { avail, isDone, need, type Line } from './calc';

export interface PlantInfo { code: string; name: string | null; responsible: string | null; target: string | null; sort?: number }

/** UR lines a warehouse team pulls per hour; W/H = UR SOLI ÷ this. */
export const SOLI_PER_HOUR = 12;

export interface Bucket { qty: number; soli: number }
export interface PlantRow {
  code: string; name: string; responsible: string; target: string; received: string | null;
  /** received time shown: typed on the dashboard, or the plan upload time */
  receivedText: string; receivedManual: boolean; late: boolean | null;
  plan: Bucket; ur: Bucket; wh: number; qi: Bucket; block: Bucket; nih: Bucket; adhoc: Bucket; sameDay: Bucket;
  released: Bucket; dispatched: Bucket; total: number; pending: Bucket;
  /** picked from the pick history (QTY, SOLI with a pick), rolls, the last pick time */
  picked: Bucket; rolls: number; lastPick: string | null;
  /** SOLI done (sent in full / marked Done) and the share of the plan QTY already sent */
  doneSoli: number; progress: number;
}

const b0 = (): Bucket => ({ qty: 0, soli: 0 });
const add = (b: Bucket, q: number) => { if (q > 1e-9) { b.qty += q; b.soli++; } };
export const isAdhoc = (l: Line) => /ad\s*-?\s*hoc/i.test(`${l.remarks || ''} ${l.comment || ''}`);

/** "10:00", "10:00 AM", "9.30am" → minutes after midnight; anything else (e.g. "Weekly") → null. */
export function timeMinutes(t: string | null | undefined): number | null {
  const m = String(t ?? '').trim().match(/^(\d{1,2})[:.](\d{2})\s*(am|pm|a\.m\.|p\.m\.)?$/i);
  if (!m) return null;
  let h = Number(m[1]);
  const ap = (m[3] || '').toLowerCase().replace(/\./g, '');
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  return h * 60 + Number(m[2]);
}
const colombo = (iso: string) => new Date(new Date(iso).getTime() + 330 * 60000); // UTC+05:30, no DST
export const fmtTime = (iso: string | null) => {
  if (!iso) return '';
  const d = colombo(iso); const h = d.getUTCHours(), m = d.getUTCMinutes();
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};

/** Time setup (Admin → Settings): SO/LI lines per hour for W/H, grace minutes before "late", target when a plant has none. */
export interface TimeSetup { soliPerHour?: number; lateGraceMin?: number; defaultTarget?: string }
export function plantSummary(rows: Line[], plants: PlantInfo[], received: { code: string; received: string | null }[] = [], time: TimeSetup = {}): { rows: PlantRow[]; total: PlantRow } {
  const perHour = time.soliPerHour && time.soliPerHour > 0 ? time.soliPerHour : SOLI_PER_HOUR;
  const rec = new Map(received.map((r) => [r.code.toUpperCase(), r.received || '']));
  const info = new Map(plants.map((p) => [p.code.toUpperCase(), p]));
  const by = new Map<string, Line[]>();
  for (const l of rows) {
    const c = (l.plant || '—').toUpperCase();
    if (!by.has(c)) by.set(c, []);
    by.get(c)!.push(l);
  }
  // plants set up in settings show even with no lines this week, like the sheet
  for (const p of plants) if (!by.has(p.code.toUpperCase())) by.set(p.code.toUpperCase(), []);

  // UR / QI / Block are stock of the SO / LI / Item: lines of the same one (other dates) share it, earliest date first
  const stockLeft = new Map<string, { ur: number; qi: number; block: number }>();
  const stockOf = (l: Line) => { let x = stockLeft.get(l.key); if (!x) { x = { ur: avail(l), qi: l.qi, block: l.block }; stockLeft.set(l.key, x); } return x; };
  const byDate = (a: Line, b: Line) => String(a.date ?? '9999').localeCompare(String(b.date ?? '9999')) || (a.row_no ?? 0) - (b.row_no ?? 0);
  const make = (code: string, ls: Line[]): PlantRow => {
    const p = info.get(code);
    const r: PlantRow = {
      code, name: p?.name || code, responsible: p?.responsible || '', target: p?.target || time.defaultTarget || '', received: null, receivedText: '', receivedManual: false, late: null,
      plan: b0(), ur: b0(), wh: 0, qi: b0(), block: b0(), nih: b0(), adhoc: b0(), sameDay: b0(), released: b0(), dispatched: b0(), total: 0, pending: b0(), picked: b0(), rolls: 0, lastPick: null, doneSoli: 0, progress: 0,
    };
    const relKeys = new Set<string>();
    for (const l of [...ls].sort(byDate)) {
      add(r.plan, l.qty);
      if (l.src_at && (!r.received || l.src_at > r.received)) r.received = l.src_at;
      add(r.dispatched, l.dispatched ?? 0);
      if ((l.released ?? 0) > 0 && !relKeys.has(l.key)) { relKeys.add(l.key); add(r.released, l.released ?? 0); }
      if (l.src_at && l.date && colombo(l.src_at).toISOString().slice(0, 10) === l.date) add(r.sameDay, need(l));
      let left = need(l);
      if (isAdhoc(l)) { add(r.adhoc, left); left = 0; }
      const st = stockOf(l);
      const u = Math.min(left, st.ur); add(r.ur, u); left -= u; st.ur -= u;
      const q = Math.min(left, st.qi); add(r.qi, q); left -= q; st.qi -= q;
      const k = Math.min(left, st.block); add(r.block, k); left -= k; st.block -= k;
      add(r.nih, left);
      if (!isDone(l)) add(r.pending, need(l)); else if (l.qty > 0) r.doneSoli++;
      add(r.picked, l.picked ?? 0); r.rolls += l.picked_rolls ?? 0;
      if (l.last_pick_at && (!r.lastPick || l.last_pick_at > r.lastPick)) r.lastPick = l.last_pick_at;
    }
    r.progress = r.plan.qty > 0 ? Math.min(1, Math.max(0, 1 - r.pending.qty / r.plan.qty)) : 0;
    r.wh = r.ur.soli / perHour;
    r.total = r.ur.qty + r.adhoc.qty;
    const typed = rec.get(code);
    r.receivedManual = !!typed;
    r.receivedText = typed || fmtTime(r.received);
    const tm = timeMinutes(r.target), rm = timeMinutes(r.receivedText);
    if (tm !== null && rm !== null) r.late = rm > tm + (time.lateGraceMin || 0);
    return r;
  };
  const out = Array.from(by.entries()).map(([c, ls]) => make(c, ls))
    .sort((a, b) => (info.get(a.code)?.sort ?? 999) - (info.get(b.code)?.sort ?? 999) || b.plan.qty - a.plan.qty);
  const total = make('Summary', []);
  total.name = 'Summary';
  for (const r of out) {
    for (const k of ['plan', 'ur', 'qi', 'block', 'nih', 'adhoc', 'sameDay', 'released', 'dispatched', 'pending', 'picked'] as const) { total[k].qty += r[k].qty; total[k].soli += r[k].soli; }
    total.wh += r.wh; total.total += r.total; total.rolls += r.rolls; total.doneSoli += r.doneSoli;
    if (r.lastPick && (!total.lastPick || r.lastPick > total.lastPick)) total.lastPick = r.lastPick;
  }
  total.progress = total.plan.qty > 0 ? Math.min(1, Math.max(0, 1 - total.pending.qty / total.plan.qty)) : 0;
  return { rows: out, total };
}
