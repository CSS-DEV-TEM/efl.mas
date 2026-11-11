'use client';
import * as XLSXS from 'xlsx-js-style';
import { api } from './api';

/**
 * v181: Pick diagnosis — for each line of a Plan_Format, why "Pick all matched" can (or can't) pick it, worked out by the Worker
 * with the same roll matching as Pick & Dispatch (the reports already uploaded), explained here in Sinhala and English.
 */
export interface DiagStock { sloc: string; batch: string; ur: number; qi: number; block: number }
export interface DiagLine {
  key: string; so: string; li: string; item: string; qty: number; error?: string;
  found?: { week: string; plan: string; date: string | null } | null;
  need: number; picked: number; planQty: number; ur: number; sent: number; auto: number; pool: number; confirmN: number; confirmQty: number; confirmWhy: string[];
  rolls: number; manualN: number; nobarcodeN: number; trim: boolean;
  blocked: { why: string; n: number; qty: number }[]; lots: { lot: string; batch: string; vendor_batch: string | null; qty: number; sloc: string }[];
  stock: DiagStock[]; plantLocs: string[]; tn: { tn: string; qty: number; picked: number; ok: number; why: string | null }[]; steps: string[];
}
export type DiagStatus = 'ok' | 'part' | 'none' | 'done';
export interface Explained { status: DiagStatus; label: string; si: string[]; en: string[] }

const q3 = (x: number) => (Math.round(x * 1000) / 1000).toLocaleString('en-US', { maximumFractionDigits: 3 });
/** a St Location as SAP shows it (0060, not 60) */
export const loc = (v: unknown) => { const t = String(v ?? '').trim(); return /^\d{1,3}$/.test(t) ? t.padStart(4, '0') : t; };
const up = (v: unknown) => String(v ?? '').trim().toUpperCase().replace(/^0+(?=\w)/, '');

/** asks the Worker, a few lines a call */
export async function diagnose(lines: { so: string; li: string; item: string; qty: number }[], step: (done: number) => void): Promise<DiagLine[]> {
  const out: DiagLine[] = [];
  for (let i = 0; i < lines.length; i += 6) {
    out.push(...(await api<{ lines: DiagLine[] }>('/api/plan-diagnose', { method: 'POST', body: { lines: lines.slice(i, i + 6) } })).lines);
    step(Math.min(lines.length, i + 6));
  }
  return out;
}

const BL: Record<string, (n: number, q: number) => [string, string]> = {
  'Barcode not in Korber Inventory': (n) => [`ZCMNTVIEW barcodes ${n}ක් Korber Inventory එකේ නෑ — ඒ rolls Korber එකට receive වෙලාද, අලුත් pallet එකකට relabel වෙලාද කියලා බලලා අලුත්ම Korber Inventory එක upload කරන්න.`, `${n} ZCMNTVIEW barcodes are not in Korber Inventory — check the rolls were received / relabelled and upload the latest Korber Inventory.`],
  'Not in ZROLLMGT': (n) => [`Rolls ${n}ක් ZROLLMGT එකේ නෑ — මේ batch එකත් ඇතුළත් වෙන්න ZROLLMGT එක SAP එකෙන් අලුතෙන් export කරලා upload කරන්න.`, `${n} rolls are not in ZROLLMGT — export ZROLLMGT again with this batch and upload it.`],
  'ZROLLMGT Status not UR': (n) => [`Rolls ${n}ක ZROLLMGT Status එක UR නෙමෙයි (උදා. BL – blocked) — SAP එකේ release කරනකම් pick කරන්න බැහැ.`, `${n} rolls have a ZROLLMGT Status other than UR (e.g. BL) — not pickable until released in SAP.`],
  'ZROLLMGT StorageBin not allowed': (n) => [`Rolls ${n}ක ZROLLMGT StorageBin එක pick කරන්න පුළුවන් bin එකක් නෙමෙයි (EXPO-FIX) — bin එක move කරන්න ඕනේ.`, `${n} rolls are in a ZROLLMGT StorageBin that is not allowed (EXPO-FIX) — move them.`],
  'ZINSR has no SO / LI / batch': (n) => [`Rolls ${n}ක batch එකට මේ SO / LI එකේ ZINSR lot එකක් නෑ — ZINSR එක upload කරන්න.`, `${n} rolls: ZINSR has no lot of this SO / LI for their batch — upload ZINSR.`],
  'Korber Pick Id not 0 (WMS pick)': (n) => [`Rolls ${n}ක් Korber එකේ වෙන WMS pick එකක තියෙනවා (Pick Id 0 නෙමෙයි).`, `${n} rolls are on a Korber WMS pick (Pick Id not 0).`],
  'rejected roll': (n) => [`Rolls ${n}ක් කලින් reject කරලා — ආයෙත් pick වෙන්නේ නෑ.`, `${n} rolls were rejected before.`],
};

/** the explanation of one line (Sinhala and English) */
export function explain(d: DiagLine): Explained {
  const si: string[] = [], en: string[] = [];
  const add = (s: string, e: string) => { si.push(s); en.push(e); };
  if (d.error) return { status: 'none', label: 'Could not check', si: [`Check කරන්න බැරි උනා: ${d.error}`], en: [d.error] };
  const plantL = new Set((d.plantLocs || []).map(up));
  const wh = d.stock.filter((x) => !plantL.has(up(x.sloc)));
  const ur = wh.reduce((t, x) => t + x.ur, 0), qi = wh.reduce((t, x) => t + x.qi, 0), block = wh.reduce((t, x) => t + x.block, 0);
  let status: DiagStatus;
  if (!d.found) add('මේ SO / LI / Item එක system එකේ plan එකක නෑ — shared reports වලින් check කළා (Pick එකේ reports නෙමෙයි).', 'Not in a plan of the system — checked with the shared reports.');
  if (d.need <= 1e-9) {
    status = 'done';
    if (d.picked > 1e-9 && d.picked >= d.planQty - 0.0005) add(`දැනටමත් ${q3(d.picked)} pick කරලා ඉවරයි.`, `Already picked: ${q3(d.picked)}.`);
    else if (ur <= 1e-9 && block > 1e-9) add(`ZMMBE එකේ UR නෑ — ${q3(block)} SO Blocked${qi > 1e-9 ? `, ${q3(qi)} QI` : ''}. SAP එකේ release කරනකම් pick කරන්න බැහැ.`, `No UR in ZMMBE — ${q3(block)} is SO Blocked${qi > 1e-9 ? `, ${q3(qi)} in QI` : ''}. Release it in SAP first.`);
    else if (ur <= 1e-9 && qi > 1e-9) add(`ZMMBE එකේ UR නෑ — ${q3(qi)} QI එකේ (inspection ඉවර වෙලා නෑ).`, `No UR in ZMMBE — ${q3(qi)} is in QI (inspection not finished).`);
    else if (ur <= 1e-9 && d.sent > 1e-9) add(`Plant locations වලට ${q3(d.sent)} දැනටමත් යවලා (Already sent) — warehouse UR නෑ.`, `${q3(d.sent)} already sent (plant locations) — no warehouse UR.`);
    else if (ur <= 1e-9) add('ZMMBE එකේ මේ SO / LI / Item එකට stock නෑ — ZMMBE upload කරලාද බලන්න.', 'No stock in ZMMBE for this SO / LI / Item — check ZMMBE is uploaded.');
    else add('Pick කරන්න QTY එකක් ඉතුරු නෑ.', 'Nothing left to pick.');
    return { status, label: 'Nothing to pick', si, en };
  }
  status = d.auto >= d.need - 0.0005 ? 'ok' : d.auto > 1e-9 ? 'part' : 'none';
  if (status === 'ok') add(`"Pick all matched" එකෙන් ${q3(d.need)} ම pick වෙනවා.`, `"Pick all matched" picks all ${q3(d.need)}.`);
  else if (status === 'part') add(`Pick කරන්න ඕනේ ${q3(d.need)} න් ${q3(d.auto)} ක් විතරයි auto pick වෙන්නේ — ඉතුරු ${q3(d.need - d.auto)} ට හේතු පහළින්.`, `Only ${q3(d.auto)} of ${q3(d.need)} can be picked automatically — the reasons for the rest are below.`);
  else add(`Pick කරන්න ඕනේ ${q3(d.need)} — auto pick වෙන roll එකක්වත් නෑ. හේතු පහළින්.`, `${q3(d.need)} to pick — no roll can be picked automatically. Reasons below.`);
  if (status !== 'ok') {
    if (ur < d.need - 0.0005 && block + qi > 1e-9) add(`ZMMBE UR ${q3(ur)} විතරයි — ${block > 1e-9 ? `${q3(block)} Blocked ` : ''}${qi > 1e-9 ? `${q3(qi)} QI ` : ''}(SAP එකේ release කරන්න ඕනේ).`, `ZMMBE UR is only ${q3(ur)} — ${block > 1e-9 ? `${q3(block)} Blocked ` : ''}${qi > 1e-9 ? `${q3(qi)} QI` : ''}.`);
    if (!d.lots.length && !d.trim) add('ZINSR එකේ මේ SO / LI / Item එකට inspection lot එකක් නෑ — ZINSR upload කරන්න.', 'ZINSR has no inspection lot for this SO / LI / Item — upload ZINSR.');
    // the UR at a St Location where the ZINSR lots are not (its rolls are often not in Korber)
    const lotL = new Set(d.lots.map((l) => up(l.sloc)).filter(Boolean));
    const away = wh.filter((x) => x.ur > 1e-9 && lotL.size && !lotL.has(up(x.sloc)));
    if (away.length) {
      const t = away.map((x) => `${loc(x.sloc)} (${q3(x.ur)}, batch ${x.batch})`).join(', ');
      const all = away.reduce((t0, x) => t0 + x.ur, 0) >= ur - 0.0005;
      add(`${all ? 'UR එක ඔක්කොම' : 'UR එකෙන් කොටසක්'} තියෙන්නේ St Location ${t} එකේ — ZINSR lots තියෙන්නේ ${Array.from(lotL).map(loc).join(', ')} එකේ. ඒ location එකේ rolls Korber warehouse එකේ නැති වෙන්න පුළුවන්. ඒක warehouse stock නෙමෙයි නම් Settings → plant storage locations එකට දාන්න.`,
        `${all ? 'All of the UR' : 'Part of the UR'} is at St Location ${t} — the ZINSR lots are at ${Array.from(lotL).map(loc).join(', ')}. Its rolls may not be in Korber; if it is not warehouse stock, add it to Settings → plant storage locations.`);
    }
    for (const b of d.blocked) {
      const f = BL[b.why] ?? ((n: number) => [`Rolls ${n}ක් pick කරන්න බැහැ: ${b.why}`, `${n} rolls not pickable: ${b.why}`] as [string, string]);
      const [s, e] = f(b.n, b.qty); add(s, e);
    }
    if (d.pool > 1e-9) add(`Rolls කීපයක lot එක SO lines කීපයකට පොදුයි (${q3(d.pool)}) — Pick screen එකේ suggest කරපු rolls tick කරන්න.`, `Shared-lot rolls (${q3(d.pool)}): tick the suggested rolls on the Pick screen.`);
    if (d.confirmN) add(`Rolls ${d.confirmN}ක් (${q3(d.confirmQty)}) "Confirmed" tick කරලා විතරයි pick කරන්න පුළුවන්${d.confirmWhy.length ? ` — ${d.confirmWhy.join('; ')}` : ''}.`, `${d.confirmN} rolls (${q3(d.confirmQty)}) need "Confirmed"${d.confirmWhy.length ? ` — ${d.confirmWhy.join('; ')}` : ''}.`);
    if (d.manualN || d.nobarcodeN) add(`Barcode නැති / Lot එක Korber එකේ නැති rolls ${d.manualN + d.nobarcodeN}ක් — Pick screen එකේ "No Barcode / Manual" එකෙන් roll එක තෝරන්න.`, `${d.manualN + d.nobarcodeN} rolls with no barcode / lot not in Korber — choose them under "No Barcode / Manual".`);
    for (const t of d.tn) if (!t.ok && t.qty - t.picked > 1e-9 && t.why) add(`Transfer Note ${t.tn}: ${t.why}`, `Transfer Note ${t.tn}: ${t.why}`);
    if (si.length === 1) add('Match වෙන roll එකක් හම්බුනේ නෑ — English steps බලන්න.', 'No matched roll — see the steps.');
  }
  return { status, label: status === 'ok' ? 'Can pick' : status === 'part' ? 'Part only' : 'Cannot pick', si, en };
}

const thin = { style: 'thin', color: { rgb: 'BFBFBF' } };
const BOX = { top: thin, bottom: thin, left: thin, right: thin };
const F = { name: 'Arial', sz: 10 };
const SI = { name: 'Iskoola Pota', sz: 11 };
const STY = {
  head: { font: { ...F, bold: true }, fill: { patternType: 'solid', fgColor: { rgb: 'D9D9D9' } }, border: BOX, alignment: { vertical: 'center', wrapText: true } },
  cell: { font: F, border: BOX, alignment: { vertical: 'top', wrapText: true } },
  si: { font: SI, border: BOX, alignment: { vertical: 'top', wrapText: true } },
  ok: { font: { ...F, bold: true, color: { rgb: '006100' } }, fill: { patternType: 'solid', fgColor: { rgb: 'C6EFCE' } }, border: BOX, alignment: { vertical: 'top' } },
  part: { font: { ...F, bold: true, color: { rgb: '7F6000' } }, fill: { patternType: 'solid', fgColor: { rgb: 'FFEB9C' } }, border: BOX, alignment: { vertical: 'top' } },
  none: { font: { ...F, bold: true, color: { rgb: '9C0006' } }, fill: { patternType: 'solid', fgColor: { rgb: 'FFC7CE' } }, border: BOX, alignment: { vertical: 'top' } },
  done: { font: { ...F, bold: true, color: { rgb: '595959' } }, fill: { patternType: 'solid', fgColor: { rgb: 'EDEDED' } }, border: BOX, alignment: { vertical: 'top' } },
};
/** the diagnosis as an Excel sheet (Sinhala and English) */
export function diagWorkbook(file: string, ds: DiagLine[], by: string) {
  const U = XLSXS.utils;
  const wb = U.book_new();
  const head = ['SO', 'LI', 'Item Code', 'Plan QTY', 'Picked', 'QTY to pick', 'ZMMBE UR', 'Auto pick QTY', 'Status', 'හේතුව / කරන්න ඕනේ දේ (සිංහල)', 'Reason / what to do (English)', 'ZMMBE by St Location · Batch (UR · QI · Block)', 'ZINSR lots (lot · batch · Vendor Batch · QTY · St Loc)', 'Not pickable rolls', 'Plan in the system', 'Steps (system)'];
  const aoa: (string | number | null)[][] = [[`PICK DIAGNOSIS — ${file}`], [`Why each line can or cannot be picked — the system's roll matching with the reports uploaded · ${new Date().toLocaleString()} · ${by}`], [], head];
  const sts: DiagStatus[] = [];
  for (const d of ds) {
    const x = explain(d); sts.push(x.status);
    aoa.push([d.so, Number(d.li) || d.li, Number(d.item) || d.item, d.planQty || d.qty, d.picked || null, d.need, d.ur, d.auto, x.label, x.si.map((s) => `• ${s}`).join('\n'), x.en.map((s) => `• ${s}`).join('\n'),
      (d.stock || []).map((s) => `${loc(s.sloc)} / ${s.batch}: ${q3(s.ur)} · ${q3(s.qi)} · ${q3(s.block)}`).join('\n') || null,
      (d.lots || []).map((l) => `${l.lot} · ${l.batch} · ${l.vendor_batch ?? '–'} · ${q3(l.qty)} · ${loc(l.sloc)}`).join('\n') || null,
      (d.blocked || []).map((b) => `${b.n} × ${b.why}`).join('\n') || null, d.found ? `${d.found.plan}${d.found.date ? ` · ${d.found.date}` : ''}` : 'not in a plan — shared reports', (d.steps || []).join('\n')]);
  }
  const ws = U.aoa_to_sheet(aoa);
  for (let r = 3; r < aoa.length; r++) for (let c = 0; c < head.length; c++) {
    const ref = U.encode_cell({ r, c }); if (!ws[ref]) ws[ref] = { t: 's', v: '' };
    (ws[ref] as { s?: unknown }).s = r === 3 ? STY.head : c === 8 ? STY[sts[r - 4]] : c === 9 ? STY.si : STY.cell;
  }
  (ws.A1 as { s?: unknown }).s = { font: { ...F, bold: true, sz: 12 } };
  ws['!cols'] = [13, 5, 12, 10, 10, 10, 10, 11, 12, 70, 60, 34, 46, 34, 26, 80].map((w) => ({ wch: w }));
  ws['!freeze'] = { xSplit: 3, ySplit: 4 };
  U.book_append_sheet(wb, ws, 'Pick Diagnosis');
  return new Uint8Array(XLSXS.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer);
}
