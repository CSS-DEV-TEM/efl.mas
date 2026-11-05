import type { Candidates } from './pick';
import { SAP_FIX, type SapStep } from './sapkb';

/** v149: a coach tip — English first, then the same in Sinhala (what the problem is, and what to do). */
export type CoachTip = { id: string; icon: string; tone: 'ok' | 'warn' | 'bad' | 'info' | 'accent'; title: string; text: string; si?: string; sap?: SapStep[] };
export type ItemHistory = { lines: number; short: number; rejects: number; reason: string | null };

const q = (n: number) => (Math.round(n * 100) / 100).toLocaleString(undefined, { maximumFractionDigits: 2 });

/** What the pick window shows for one plan line: read from the line's matching result (no extra database reads) and its Material's history. */
export function lineCoach(c: Candidates & { trim?: boolean }, hist?: ItemHistory | null, best?: { qty: number; rolls: number; left: number } | null): CoachTip[] {
  return withSap(lineCoach0(c, hist, best));
}
const SAP_OF: Record<string, string> = { noUr: 'noUr', urUsed: 'ur', ur: 'ur', nolot: 'nolot', zroll: 'bin', lotfull: 'lotfull', blocked: 'bin', confirm: 'confirm', none: 'none' };
function withSap(t: CoachTip[]): CoachTip[] { return t.map((x) => (SAP_OF[x.id] && SAP_FIX[SAP_OF[x.id]] ? { ...x, sap: SAP_FIX[SAP_OF[x.id]] } : x)); }
function lineCoach0(c: Candidates & { trim?: boolean }, hist?: ItemHistory | null, best?: { qty: number; rolls: number; left: number } | null): CoachTip[] {
  const t: CoachTip[] = [];
  const left = Math.max(0, c.need - c.picked);
  const avail = c.rolls.filter((r) => r.available > 1e-9);
  if (c.trim) t.push({ id: 'trim', icon: '🧵', tone: 'info', title: 'INTERLINING / FUSIBLE item',
    text: 'ZINR, ZCOMENT VIEW and ZROLLMGT are not checked for this Material — its Korber rolls are matched straight (Pick Id 0, not rejected, location allowed), oldest FIFO first.',
    si: 'මේ INTERLINING / FUSIBLE item එකක්. ZINR, ZCOMENT VIEW, ZROLLMGT check කරන්නේ නැහැ — Korber rolls කෙලින්ම ගන්නවා (Pick Id 0, reject නොවුණ, FIFO පරණ ඒවා මුලින්).' });
  const plan = Number(c.planQty ?? c.line.qty) || 0;
  const ur = Number(c.ur ?? 0) || 0;
  if (left <= 1e-9) {
    if (c.picked + 1e-6 >= plan) t.push({ id: 'done', icon: '✅', tone: 'ok', title: 'Picked in full', text: `${q(c.picked)} of ${q(plan)} is picked. No action needed.`,
      si: `Plan එකේ ${q(plan)}න් ${q(c.picked)}ක් pick කරලා ඉවරයි. කරන්න දෙයක් නැහැ.` });
    else if (ur <= 1e-9 && c.picked <= 1e-9) t.push({ id: 'noUr', icon: '📭', tone: 'bad', title: 'No UR in ZMMBE for this SO line',
      text: `ZMMBE has no UR (Total − QI − Block − Assigned) for ${c.line.so} / ${c.line.li} / ${c.line.item}, so nothing can be picked. Upload the latest ZMMBE of this Pick, or tell the planner the stock is not there.`,
      si: `ගැටලුව: ZMMBE එකේ ${c.line.so} / ${c.line.li} / ${c.line.item} ට UR එකක් නැහැ (Total − QI − Block − Assigned) — ඒ නිසා pick කරන්න බැහැ. කරන්න ඕනේ: මේ Pick එකේ අලුත්ම ZMMBE එක upload කරන්න, නැත්නම් stock නැහැ කියලා planner ට කියන්න.` });
    else t.push({ id: 'urUsed', icon: '📦', tone: 'warn', title: 'UR is used up', text: `${q(c.picked)} is picked — all the UR there is — but the plan is ${q(plan)}. The rest (${q(plan - c.picked)}) needs more stock in ZMMBE.`,
      si: `ගැටලුව: තිබ්බ UR එක සම්පූර්ණයෙන් (${q(c.picked)}) pick කරලා ඉවරයි, ඒත් plan එක ${q(plan)}. කරන්න ඕනේ: ඉතුරු ${q(plan - c.picked)} ට ZMMBE එකේ stock එනකම් ඉන්න, නැත්නම් planner ට කියන්න.` });
    if (!c.lots.length && !c.trim && c.picked + 1e-6 < plan) t.push({ id: 'nolot', icon: '🔗', tone: 'warn', title: 'No ZINR lot for this SO line',
      text: `ZINSR has no lot of ${c.line.so} / ${c.line.li} / ${c.line.item}. When the stock comes, upload this Pick's ZINR too.`,
      si: `ZINSR එකේ ${c.line.so} / ${c.line.li} / ${c.line.item} ට lot එකක් නැහැ. Stock ආවම මේ Pick එකේ ZINR එකත් upload කරන්න.` });
    return t;
  }
  if (c.ur !== undefined && c.planQty !== undefined && c.ur + 0.0005 < c.planQty) t.push({ id: 'ur', icon: '📦', tone: 'warn', title: 'UR is less than the plan',
    text: `ZMMBE UR is ${q(c.ur)} but the plan needs ${q(c.planQty)} — only the UR can be picked. Check QI / Block stock, or upload a newer ZMMBE.`,
    si: `ගැටලුව: ZMMBE UR එක ${q(c.ur)}යි, plan එකට ${q(c.planQty)}ක් ඕනේ — pick කරන්න පුළුවන් UR එක විතරයි. කරන්න ඕනේ: QI / Block stock බලන්න, නැත්නම් අලුත් ZMMBE එකක් upload කරන්න.` });
  if (c.gate?.on && !c.gate.loaded) t.push({ id: 'zroll', icon: '🗂️', tone: 'bad', title: 'No ZROLLMGT for this Pick',
    text: `Upload ZROLLMGT on the Pick card — only rolls at StorageBin ${c.gate.bin} can be picked.`,
    si: `ගැටලුව: මේ Pick එකට ZROLLMGT upload කරලා නැහැ. කරන්න ඕනේ: Pick card එකෙන් ZROLLMGT upload කරන්න (StorageBin ${c.gate.bin} rolls විතරයි pick වෙන්නේ).` });
  if (!c.lots.length && !c.trim) t.push({ id: 'nolot', icon: '🔗', tone: 'bad', title: 'No ZINR lot for this SO line',
    text: `ZINSR has no lot of ${c.line.so} / ${c.line.li} / ${c.line.item} with UR. Upload this Pick's ZINR, or check the SO / LI of the plan line.`,
    si: `ගැටලුව: ZINSR එකේ ${c.line.so} / ${c.line.li} / ${c.line.item} ට UR තියෙන lot එකක් නැහැ. කරන්න ඕනේ: මේ Pick එකේ ZINR upload කරන්න, නැත්නම් plan line එකේ SO / LI හරිද බලන්න.` });
  // a lot of this SO line used up while another still gives
  const full = c.lots.filter((l) => Number(l.qty) > 0 && (l.cap ?? 1) <= 1e-9);
  const open = c.lots.filter((l) => (l.cap ?? 0) > 1e-9);
  if (full.length && open.length) t.push({ id: 'lotfull', icon: '🧮', tone: 'warn', title: `Lot ${full[0].lot} is used up`,
    text: `Its ZINSR QTY for this SO line is already picked. Pick rolls of ${open.slice(0, 2).map((l) => `batch ${l.batch} (lot ${l.lot}, ${q(Number(l.cap))} left)`).join(' or ')}.`,
    si: `ගැටලුව: Lot ${full[0].lot} (batch ${full[0].batch}) එකේ මේ SO line එකට තියෙන QTY එක pick කරලා ඉවරයි. කරන්න ඕනේ: ${open.slice(0, 2).map((l) => `batch ${l.batch} (lot ${l.lot}, ඉතුරු ${q(Number(l.cap))})`).join(' හෝ ')} එකේ rolls pick කරන්න.` });
  // rolls that fail a check, by the most common reason
  if (c.blocked?.length) {
    const by: Record<string, number> = {};
    for (const b of c.blocked) { const k = String(b.why || '').replace(/\d[\d.,]*/g, '#').slice(0, 70); by[k] = (by[k] ?? 0) + 1; }
    const [why] = Object.entries(by).sort((a, b) => b[1] - a[1])[0];
    const ex = c.blocked.find((b) => String(b.why || '').replace(/\d[\d.,]*/g, '#').slice(0, 70) === why)?.why ?? why;
    t.push({ id: 'blocked', icon: '⛔', tone: 'warn', title: `${c.blocked.length} roll${c.blocked.length === 1 ? '' : 's'} not pickable`,
      text: `Most: “${ex}”. Open “Not pickable” to see each roll; fix the report (ZROLLMGT bin / status, Korber Pick Id) or pick another roll.`,
      si: `ගැටලුව: rolls ${c.blocked.length}ක් pick කරන්න බැහැ — වැඩියෙන්ම “${ex}” නිසා. කරන්න ඕනේ: “Not pickable” open කරලා එක එක roll එක බලන්න; report එක (ZROLLMGT bin / status, Korber Pick Id) හදන්න, නැත්නම් වෙන roll එකක් ගන්න.` });
  }
  const conf = avail.filter((r) => r.needsConfirm);
  if (conf.length) t.push({ id: 'confirm', icon: '🧭', tone: 'warn', title: `${conf.length} roll${conf.length === 1 ? ' needs' : 's need'} a check`,
    text: 'A field is not the same as SAP (Lot / Supplier Hu / Qty / Invoice). Check the roll label, then tick “I checked”.',
    si: `ගැටලුව: rolls ${conf.length}ක SAP එකට සමාන නොවන field එකක් තියෙනවා (Lot / Supplier Hu / Qty / Invoice). කරන්න ඕනේ: roll එකේ label එක බලලා හරි නම් “I checked” tick කරන්න.` });
  const sf = Number(c.shortfall ?? 0);
  if (sf > 1e-9 && ((c.manual?.length ?? 0) > 0 || (c.nobarcode?.length ?? 0) > 0)) t.push({ id: 'manual', icon: '✋', tone: 'info', title: `${q(sf)} to pick by hand`,
    text: 'The matched rolls do not cover the line. Pick only this balance from the Manual / No Barcode list — search or scan the pallet, lot or supplier HU.',
    si: `Matched rolls වලින් line එක සම්පූර්ණ වෙන්නේ නැහැ — ඉතුරු ${q(sf)} අතින් pick කරන්න ඕනේ. කරන්න ඕනේ: Manual / No Barcode list එකෙන් pallet, lot, supplier HU search හෝ scan කරලා ඒ balance එක විතරක් ගන්න.` });
  if (!c.rolls.length && !(c.manual?.length) && !(c.nobarcode?.length) && !c.blocked?.length) t.push({ id: 'none', icon: '🔎', tone: 'bad', title: 'No Korber roll found',
    text: `No roll of Material ${c.line.item} matched. Check that this Pick's Korber Inventory has the Material, or add a Manual pallet.`,
    si: `ගැටලුව: Material ${c.line.item} ට match වෙන roll එකක් නැහැ. කරන්න ඕනේ: මේ Pick එකේ Korber Inventory එකේ ඒ Material එක තියෙනවද බලන්න, නැත්නම් Manual pallet එකක් add කරන්න.` });
  if (hist && hist.short >= 2) t.push({ id: 'hshort', icon: '📉', tone: 'info', title: 'Often short before',
    text: `This Material was short in ${hist.short} of ${hist.lines} picks (last 30 days). Tell the planner early if it is short again.`,
    si: `මේ Material එක පහුගිය දවස් 30 picks ${hist.lines}න් ${hist.short}ක short උනා. ආයෙත් short නම් planner ට ඉක්මනින් කියන්න.` });
  if (hist && hist.rejects >= 2 && hist.reason) t.push({ id: 'hrej', icon: '🔍', tone: 'info', title: 'Rolls of this Material get rejected',
    text: `${hist.rejects} rejected (last 30 days), mostly for “${hist.reason}”. Check that on each roll before you save.`,
    si: `මේ Material එකේ rolls ${hist.rejects}ක් reject උනා (දවස් 30), වැඩියෙන්ම “${hist.reason}” නිසා. Save කරන්න කලින් හැම roll එකකම ඒක check කරන්න.` });
  if (best && best.rolls > 0) {
    const diff = best.qty - best.left;
    const exact = Math.abs(diff) <= 0.0005;
    t.push({ id: 'best', icon: '🎯', tone: 'accent', title: exact ? `Best pick: ${best.rolls} roll${best.rolls === 1 ? '' : 's'} = ${q(best.qty)} (exact)` : `Best pick: ${best.rolls} roll${best.rolls === 1 ? '' : 's'} = ${q(best.qty)}`,
      text: `Matched with SAP (ZMMBE batch, ZINSR lot, ZROLLMGT) and Korber, oldest FIFO first${exact ? '' : diff < 0 ? ` — ${q(-diff)} still to pick by hand` : ` — the last roll is cut`}. Press “Auto select” to tick them.`,
      si: `SAP (ZMMBE batch, ZINSR lot, ZROLLMGT) සහ Korber එක්ක match කරපු හොඳම rolls ${best.rolls} = ${q(best.qty)}${exact ? ' (හරියටම)' : diff < 0 ? ` — ඉතුරු ${q(-diff)} අතින් pick කරන්න` : ' — අන්තිම roll එක cut වෙනවා'}. “Auto select” එබුවාම ඒවා tick වෙනවා.` });
  }
  const auto = avail.filter((r) => !r.needsConfirm && !r.pool).reduce((n, r) => n + r.available, 0);
  if (!t.some((x) => x.tone === 'bad' || x.tone === 'warn') && auto + 1e-9 >= left) t.push({ id: 'good', icon: '✨', tone: 'ok', title: 'All matched',
    text: `The matched rolls cover the ${q(left)} to pick. Tick them (or use ⚡ Pick all matched) and save.`,
    si: `Matched rolls වලින් pick කරන්න ඕන ${q(left)} සම්පූර්ණ වෙනවා. ඒ rolls tick කරලා (නැත්නම් ⚡ Pick all matched) save කරන්න.` });
  return t;
}
