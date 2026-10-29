'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader, Skeleton } from '@/components/Loader';
import { ApiError, api, getSession, isBossRole } from '@/lib/api';
import CompleteLine from '@/components/CompleteLine';
import PlanReport, { type PlanReportRes } from '@/components/PlanReport';
import { ago, avail, fmt, fmtDate, fmtQty, isDispatched, isDone, need, periodOf, type Line } from '@/lib/calc';
import { action } from '@/lib/smart';
import { downloadLatest } from '@/lib/files';
import { smartBest, smartSuggest, type Suggestion } from '@/lib/rollSuggest';
import {
  PICK_SRCS, type PLIssue, type NotPicked, notPickedWhy, korberWorkbook, ordinal, packingListWorkbook, saveWorkbook, uploadPickFile,
  pickNote, parsePackingListFile, type PLPiece, type Candidate, type Candidates, type KorberRow, type SapFit, type ManualRoll, type NbOption, type NoBarcodeRoll, type PickHistory, type PickSrc,
} from '@/lib/pick';

type LineP = Line & { picked?: number; picked_rolls?: number };
/** an item number without the client code and leading zeros (MASKRE-0001000256730 → 1000256730) */
/** Packing List: plan lines checked at the same time (the Not Picked sheet) */
const PL_PAR = 8;
const normItem = (v: unknown) => String(v ?? '').trim().toUpperCase().replace(/^[A-Z]{2,10}-(?=[A-Z0-9])/, '').replace(/^0+(?=\d)/, '');
const today = () => new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);

/** Why a plan line is still pending, in the order the work is done. */
const PENDING_ORDER = ['On hold', 'Part picked', 'Ready to pull', 'Not in Korber', 'Partial pull', 'Release QI / Block', 'Follow up TN', 'No stock'];
const PENDING_TONE: Record<string, string> = { 'On hold': 'bad', 'Part picked': 'accent', 'Ready to pull': 'ok', 'Not in Korber': 'warn', 'Partial pull': 'info', 'Release QI / Block': 'warn', 'Follow up TN': 'warn', 'No stock': 'bad' };
function pendingWhy(l: LineP): string {
  if (l.hold) return 'On hold';
  if ((l.picked ?? 0) > 0) return 'Part picked';
  const a = action(l);
  return PENDING_ORDER.includes(a) ? a : 'No stock';
}

/** Pick tab of the Dispatch page: the three pick reports, Ready-to-pull lines with Pick, and the pick history / Packing List. */
export default function PickWorkspace({ week, rows, canEdit, toast, reload, label, plant }: { week: string; rows: LineP[]; canEdit: boolean; toast: (m: string) => void; reload: () => void; /** what is on screen, e.g. "20 Oct · ASIALINE Pick 2" */ label?: string; /** a week plan: one plant of it */ plant?: string }) {
  const [status, setStatus] = useState<{ counts: { src: string; n: number }[]; uploads: { src: string; file_name: string | null; row_count: number; uploaded_by: string; uploaded_at: string }[]; reports?: { src: string; uses: 'own' | 'shared' | 'none' }[] } | null>(null);
  const [busy, setBusy] = useState<PickSrc | null>(null);
  const [scope, setScope] = useState<'pending' | 'ready' | 'open' | 'picked' | 'done' | 'hold' | 'manual' | 'possible'>('pending');
  // the plan by SO (open an SO to see its items) or as one list of lines
  const [byView, setByViewS] = useState<'so' | 'lines'>(() => { try { return localStorage.getItem('mas-pick-view') === 'lines' ? 'lines' : 'so'; } catch { return 'so'; } });
  const setByView = (v: 'so' | 'lines') => { setByViewS(v); try { localStorage.setItem('mas-pick-view', v); } catch { /* private mode */ } };
  const [openSo, setOpenSo] = useState<string | null>(null);
  const [why, setWhy] = useState('');
  const [q, setQ] = useState('');
  const [picking, setPicking] = useState<LineP | null>(null);
  const [histKey, setHistKey] = useState(0);
  const [importOpen, setImportOpen] = useState(false);
  const inputs = useRef<Record<string, HTMLInputElement | null>>({});

  // the reports of the Pick on screen (a day plan round); the whole day / a week: the shared reports
  // a Pick (day plan round) or a week plan (2026-W43): their own reports
  // a week plan's reports belong to one plant of it (2026-W43@ASIALLINE): choose the plant to upload / see them
  const isWk = /^\d{4}-W\d{2}$/.test(week);
  const rid = /^\d{4}-\d{2}-\d{2}~[^~]*~\d+$/.test(week) ? week : isWk && plant ? `${week}@${plant.trim().toUpperCase().replace(/\s+/g, '')}` : '';
  // the plan report: the Pick, or the week (one plant of it)
  const repRid = isWk ? week : rid;
  const loadStatus = useCallback(() => { api<NonNullable<typeof status>>('/api/pick/status' + (rid ? '?rid=' + encodeURIComponent(rid) : '')).then(setStatus).catch(() => {}); }, [rid]);
  useEffect(() => { loadStatus(); }, [loadStatus]);

  const upload = async (src: PickSrc, f: File) => {
    setBusy(src);
    try {
      const r = await uploadPickFile(src, f, rid || null);
      toast(`${PICK_SRCS.find((x) => x.src === src)!.title}: ${fmt(r.rows)} rows saved${r.total > r.rows ? ` (of ${fmt(r.total)} in the file${src === 'korber' ? ' — only plan items kept' : src === 'zcoment' ? ' — Shade Report only' : ''})` : ''}`);
      loadStatus();
    } catch (e) { toast(e instanceof Error ? e.message : 'Upload failed.'); }
    finally { setBusy(null); }
  };

  // the Pick's plan report: POSIBAL PENDING = the lines the warehouse can send now (Pending, and UR in the warehouse ZMMBE)
  const [report, setReport] = useState<PlanReportRes | null>(null);
  const [showReport, setShowReport] = useState(false);
  useEffect(() => { if (!repRid) { setReport(null); return; } api<PlanReportRes>('/api/plan-report?rid=' + encodeURIComponent(repRid) + (plant ? '&plant=' + encodeURIComponent(plant) : '')).then(setReport).catch(() => setReport(null)); }, [repRid, rows, plant]);
  const possible = useMemo(() => new Map((report?.rows || []).filter((x) => x.possible).map((x) => [`${x.key}|${x.pick_date ?? ''}`, x])), [report]);
  // the plan report's balance: QTY − picked (ALRADY SEND is shown for information only)
  const repRow = useMemo(() => new Map((report?.hasSent ? report.rows : []).map((x) => [`${x.key}|${x.pick_date ?? ''}`, x])), [report]);
  const sentOf = useCallback((l: LineP) => repRow.get(`${l.key}|${l.date ?? ''}`), [repRow]);
  const bal = useCallback((l: LineP) => { const x = sentOf(l); return x ? (x.left ?? Math.max(0, r3(Number(l.qty) - (l.picked ?? 0)))) : need(l); }, [sentOf]);
  /** what can be picked now: the balance, at most the UR left */
  const todo = useCallback((l: LineP) => (isDone(l) ? 0 : Math.max(0, r3(Math.min(bal(l), Math.max(0, avail(l)))))), [bal]);
  // "Needs manual": the open lines with UR are checked against their matched rolls (as "Pick all matched" would pick them)
  type ScanR = { auto: number; left: number; why: string; kq?: number; kn?: number };
  const [scan, setScan] = useState<Record<number, ScanR>>({});
  // "Pick all matched" running: the Needs manual check waits (both ask the server line by line — one at a time is faster)
  const [runActive, setRunActive] = useState(false);
  const [scanning, setScanning] = useState(false);
  // a line is checked again only when its QTY to pick or the Pick's reports changed (not the whole Pick after every pick)
  const repVer = useMemo(() => (status?.uploads || []).map((u) => `${u.src}@${u.uploaded_at}`).join(','), [status]);
  const scanCache = useRef(new Map<string, ScanR | null>());
  const ck = (l: LineP) => `${week}|${l.id}|${todo(l)}|${l.picked ?? 0}|${repVer}`;
  const scanKey = useMemo(() => rows.filter((l) => !l.hold && todo(l) > 1e-9).map(ck).join(','),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [rows, todo, repVer, week]);
  useEffect(() => {
    const all = rows.filter((l) => !l.hold && todo(l) > 1e-9).slice(0, 300);
    const cache = scanCache.current;
    const fromCache = () => { const o: Record<number, ScanR> = {}; for (const l of all) { const v = cache.get(ck(l)); if (v) o[l.id] = v; } return o; };
    if (runActive) return;
    const ls = all.filter((l) => !cache.has(ck(l)));
    if (!ls.length) { setScan(fromCache()); setScanning(false); return; }
    let stop = false; setScanning(true);
    const out: Record<number, ScanR> = {};
    const one = async (l: LineP) => {
      const key = ck(l);
      await scanOne(l);
      cache.set(key, out[l.id] ?? null);
    };
    const scanOne = async (l: LineP) => {
      try {
        const wk = (l as LineP & { week?: string }).week || week;
        const c = await api<Candidates>(`/api/pick/candidates?week=${encodeURIComponent(wk)}&key=${encodeURIComponent(l.key)}&date=${encodeURIComponent(l.date ?? '')}`);
        const left = r3(c.need - c.picked);
        // nothing left to pick (the UR is used up): kept too, so the State says so
        if (left <= 1e-9) { out[l.id] = { auto: 0, left: 0, why: '' }; return; }
        const plan = autoPlan(autoRolls(c));
        const auto = r3(Object.values(plan.sel).reduce((t, x) => t + (Number(x.qty) || 0), 0));
        const short = r3(left - auto);
        const why = short <= 1e-9 ? '' : c.rolls.some((x) => x.available > 1e-9 && x.needsConfirm) ? 'Rolls need a check (“I checked”)'
          : c.rolls.some((x) => x.available > 1e-9 && x.pool) ? 'Shared-lot rolls — this line\'s lot QTY is used up, or the rolls are taken'
          : c.nobarcode?.some((m) => m.invChoice) ? 'Invoice + Item match — choose the rolls'
          : c.nobarcode?.length ? 'No Barcode — choose the Korber roll'
          : c.manual?.length ? 'Not matched — choose a Korber roll by hand'
          : (c.blocked?.length ?? 0) > 0 ? 'Rolls fail ZROLLMGT (StorageBin / Status) — see “Not pickable”, or add a Manual pallet'
          : 'No matched roll — add a Manual pallet';
        // the Korber rolls this line can take now (matched to it, what is left of each)
        const usable = c.rolls.filter((x) => x.available > 1e-9 && (!x.pool || x.suggested));
        out[l.id] = { auto, left, why: auto > 1e-9 && short > 1e-9 ? `${fmtQty(auto)} matched, ${fmtQty(short)} short · ${why}` : why, kq: r3(usable.reduce((t, x) => t + x.available, 0)), kn: usable.length };
      } catch { /* the line is not in a Pick */ }
    };
    void (async () => {
      for (let i = 0; i < ls.length && !stop; i += 6) await Promise.all(ls.slice(i, i + 6).map(one));
      if (!stop) { setScan(fromCache()); setScanning(false); }
    })();
    return () => { stop = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanKey, week, runActive]);
  const needsManual = useCallback((l: LineP) => !l.hold && todo(l) > 1e-9 && !!scan[l.id]?.why, [scan, todo]);
  // Auto match: the matched rolls cover all or part of the QTY (a part also shows under Needs manual for the rest)
  const autoReady = useCallback((l: LineP) => !l.hold && todo(l) > 1e-9 && (scan[l.id]?.auto ?? 0) > 1e-9, [scan, todo]);
  /**
   * The State of a line, from what can be done with it now: picked (all / part), and for the rest — the matched rolls
   * (auto), the rolls to choose by hand (manual), or why nothing can be picked (no UR left, no stock, on hold …).
   */
  const stateOf = (l: LineP) => {
    const pk = l.picked ?? 0, done = isDispatched(l), autoP = Number(l.auto_picked) > 0, cs = Number((l as LineP & { closed_short?: number }).closed_short) || 0;
    if (l.hold && !isDone(l)) return <span className="pill bad" title={`On hold${l.hold_by ? ` by ${l.hold_by}` : ''}${l.hold_at ? ` · ${new Date(l.hold_at).toLocaleString()}` : ''}`}>On hold · {l.hold}</span>;
    if (isDone(l) && !done) return <span className="pill ok" title={l.comment || ''}>Completed ✓</span>;
    if (done) return cs > 0 ? <span className="pill ok" title="Closed short by a Normal pick">Picked ✓ · {fmtQty(cs)} short</span> : <span className="pill ok">{autoP ? 'Auto Picked ✓' : 'Picked ✓ · Dispatched'}</span>;
    if (pk && sentOf(l) && bal(l) <= 1e-9) return <span className="pill ok" title="The picks and ALRADY SEND cover the QTY">Picked ✓ · rest sent</span>;
    const part = pk > 1e-9 ? `${autoP ? 'Auto picked' : 'Picked'} ${fmtQty(pk)} · ` : '';
    const t = todo(l);
    if (t <= 1e-9) {
      // nothing can be picked now: the UR is used up (the rest of the balance has no stock), or no stock at all
      if (pk > 1e-9) return <span className="pill warn" title={`Balance ${fmtQty(bal(l))} — no UR left in ZMMBE for it`}>{part}no UR for the rest</span>;
      return <span className={`pill ${PENDING_TONE[pendingWhy(l)] || 'mute'}`}>{pendingWhy(l)}</span>;
    }
    const sc = scan[l.id];
    if (!sc) return <span className="pill mute" title="Checking the matched Korber rolls">{part}{scanning || runActive ? 'Checking…' : 'To pick'} {fmtQty(t)}</span>;
    // what is left to pick as the server works it out (the plan balance, at most the UR free) — the same as Pick all matched
    const lt = r3(Math.min(t, sc.left));
    if (lt <= 1e-9) return <span className="pill warn" title="No UR left to pick for this line">{part}no UR for the rest</span>;
    if (!sc.why || sc.auto >= lt - 1e-6) return <span className="pill ok" title="The matched rolls cover the QTY — Pick all matched picks them">{part}Auto match {fmtQty(sc.auto)}</span>;
    if (sc.auto > 1e-9) return <span className="pill accent" title={sc.why}>{part}Auto {fmtQty(sc.auto)} · manual {fmtQty(r3(lt - sc.auto))}</span>;
    return <span className="pill warn" title={sc.why}>{part}Needs manual {fmtQty(lt)}</span>;
  };
  /** Korber qty: the rolls this line can take now when checked (matched to it), else the rolls of its lots on the shelf */
  const korberOf = (l: LineP) => {
    const sc = scan[l.id];
    if (sc && sc.kq !== undefined && todo(l) > 1e-9) return <span className={sc.kq < todo(l) - 1e-6 ? 'kb-short' : ''} title={`${sc.kn} Korber roll${sc.kn === 1 ? '' : 's'} matched to this SO line, what is left of each${sc.kq < todo(l) - 1e-6 ? ` — ${fmtQty(r3(todo(l) - sc.kq))} less than the QTY to pick` : ''}`}>{fmtQty(sc.kq)} <span className="muted">({sc.kn})</span></span>;
    if (l.korber_avail == null) return <span className="muted" title="No Korber Inventory uploaded">–</span>;
    // not checked (nothing to pick now): the rolls of its lots on the shelf, for information (they may belong to other SO lines)
    return <span className="muted" title={`${l.korber_rolls ?? 0} roll${l.korber_rolls === 1 ? '' : 's'} of this line's ZINR lots on the Korber shelf (shared lots: also other SO lines' rolls)`}>{fmtQty(l.korber_avail)} ({l.korber_rolls ?? 0})</span>;
  };
  type Scope = typeof scope;
  const inScope = useCallback((sc: Scope, l: LineP, w = '') => (sc === 'possible' ? possible.has(`${l.key}|${l.date ?? ''}`) && !isDone(l) && bal(l) > 1e-9
    : sc === 'manual' ? !isDone(l) && needsManual(l)
    : sc === 'picked' ? (l.picked ?? 0) > 0
    : sc === 'done' ? isDone(l)
    : sc === 'hold' ? !!l.hold && !isDone(l)
    : sc === 'pending' ? !isDone(l) && bal(l) > 1e-9 && (!w || pendingWhy(l) === w)
    : sc === 'open' ? !isDone(l) && todo(l) > 1e-9
    : !isDone(l) && !l.hold && autoReady(l)), [possible, needsManual, autoReady, bal, todo]);
  const scopeN = useMemo(() => Object.fromEntries((['pending', 'ready', 'open', 'possible', 'manual', 'picked', 'done', 'hold'] as Scope[]).map((k) => [k, rows.filter((l) => inScope(k, l)).length])) as Record<Scope, number>, [rows, inScope]);
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return rows.filter((l) => inScope(scope, l, why))
      .filter((l) => !s || [l.so, l.li, l.item, l.plant].join(' ').toLowerCase().includes(s))
      .sort((a, b) => String(a.date ?? '').localeCompare(String(b.date ?? '')) || a.row_no - b.row_no);
  }, [rows, scope, q, why, inScope]);
  // everything of the plan not dispatched yet, by what it is waiting for
  const pending = useMemo(() => {
    const m = new Map<string, { n: number; qty: number }>();
    for (const l of rows) {
      if (isDone(l) || bal(l) <= 1e-9) continue;
      const k = pendingWhy(l); const x = m.get(k) || { n: 0, qty: 0 };
      x.n++; x.qty += bal(l); m.set(k, x);
    }
    return PENDING_ORDER.filter((k) => m.has(k)).map((k) => ({ why: k, ...m.get(k)! }));
  }, [rows, bal]);
  const cnt = (src: string) => status?.counts.find((c) => c.src === src)?.n ?? 0;

  // "Pick all matched": every open line of the Pick, one by one — the rolls where everything matches (no check needed,
  // not a shared-lot roll) are picked as the system selects them; what is left shows under "Needs manual"
  type RunRes = { id: number; so: string; li: string; item: string; ok: 'picked' | 'skip' | 'error'; text: string };
  const [run, setRun] = useState<{ total: number; done: number; cur: string; res: RunRes[]; finished: boolean; offline?: boolean } | null>(null);
  const [runWhy, setRunWhy] = useState<Record<number, string>>({});
  const stopRef = useRef(false);
  const runAll = async () => {
    const targets = rows.filter((l) => !isDone(l) && todo(l) > 1e-9 && !l.hold);
    if (!targets.length) { toast('No open line with UR to pick in this Pick.'); return; }
    if (!window.confirm(`Pick every All-match roll for ${targets.length} open line${targets.length === 1 ? '' : 's'} of ${label || week}?\n\nOnly rolls where everything matches are picked (as the system selects them, the last roll cut to the QTY) — also a roll SAP lists in the lots of several SO lines, up to each line's ZINSR lot QTY (a cut roll's balance first). Lines that need a check or a manual roll are left for you under “Needs manual” — the Smart suggestion shows there, you choose.\n\nKeep this tab open while it runs. If the network drops it waits and goes on by itself.`)) return;
    stopRef.current = false;
    setRunActive(true);
    // closing / reloading the tab while it runs: the browser asks first (the lines already picked stay picked)
    const onLeave = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; return ''; };
    window.addEventListener('beforeunload', onLeave);
    // the network is gone: wait until the server answers again (checked every 3 s), unless Stop is pressed
    const waitOnline = async (what: string) => {
      for (let n = 1; !stopRef.current; n++) {
        setRun((r) => r && { ...r, cur: `Network lost — waiting to go on (${what}) · ${n * 3} s`, offline: true });
        await new Promise((r) => setTimeout(r, 3000));
        if (typeof navigator !== 'undefined' && navigator.onLine === false) continue;
        try { await api('/api/health'); setRun((r) => r && { ...r, offline: false }); return; } catch { /* still offline */ }
      }
    };
    const res: RunRes[] = []; const why: Record<number, string> = {};
    setRun({ total: targets.length, done: 0, cur: '', res: [], finished: false });
    try {
      for (let i = 0; i < targets.length; i++) {
        if (stopRef.current) break;
        const l = targets[i];
        setRun((r) => r && { ...r, cur: `${l.so} / ${l.li} · ${l.item}` });
        const base = { id: l.id, so: l.so, li: String(l.li), item: l.item };
        // a line is tried again after the network comes back: its rolls are read again, so a pick that reached the
        // server before the network dropped is not picked twice (it shows as picked)
        let firstPicked: number | null = null, sent = 0;
        for (;;) {
          try {
            const wk = (l as LineP & { week?: string }).week || week;
            const c = await api<Candidates>(`/api/pick/candidates?week=${encodeURIComponent(wk)}&key=${encodeURIComponent(l.key)}&date=${encodeURIComponent(l.date ?? '')}`);
            if (firstPicked === null) firstPicked = c.picked;
            const left = r3(c.need - c.picked);
            if (sent > 1e-9 && c.picked - firstPicked > 1e-9) {
              res.push({ ...base, ok: 'picked', text: `${fmtQty(r3(c.picked - firstPicked))} (saved before the network dropped)${left > 1e-9 ? ` · ${fmtQty(left)} still to pick` : ''}` });
              break;
            }
            // only the All-match rolls (as the system selects them); the Smart suggestion is never taken by itself
            const plan = autoPlan(autoRolls(c));
            const rolls = Object.entries(plan.sel).map(([pallet, x]) => ({ pallet, qty: r3(Number(x.qty)) })).filter((x) => x.qty > 1e-9);
            if (left <= 1e-9) { res.push({ ...base, ok: 'skip', text: 'nothing left to pick (UR / balance)' }); why[l.id] = 'Nothing to pick — UR or balance is 0'; }
            else if (!rolls.length) {
              const t = c.rolls.some((x) => x.available > 1e-9 && x.needsConfirm) ? 'rolls need a check (“Confirmed”)' : c.rolls.some((x) => x.available > 1e-9 && x.pool) ? 'shared-lot rolls — tick them' : c.nobarcode?.length ? 'no-barcode / Invoice + Item rolls — choose them' : 'no matched roll';
              res.push({ ...base, ok: 'skip', text: t }); why[l.id] = t;
            } else {
              const tot = r3(rolls.reduce((t, x) => t + x.qty, 0));
              sent = tot;
              await api('/api/pick', { method: 'POST', body: { week: wk, key: l.key, date: l.date, kind: 'normal', auto: true, rolls } });
              const short = r3(left - tot);
              res.push({ ...base, ok: 'picked', text: `${rolls.length} roll${rolls.length === 1 ? '' : 's'} · ${fmtQty(tot)}${short > 1e-9 ? ` · ${fmtQty(short)} still short` : ''}` });
              if (short > 1e-9) why[l.id] = `${fmtQty(short)} still short — no more All-match rolls (see the Smart suggestion in the pick window)`;
            }
            break;
          } catch (e) {
            // no answer from the server (network): wait, then the same line again
            if (e instanceof ApiError && e.status === 0 && !stopRef.current) { await waitOnline(`${l.so} / ${l.li}`); if (!stopRef.current) continue; }
            const t = e instanceof Error ? e.message : 'failed'; res.push({ ...base, ok: 'error', text: t }); why[l.id] = t;
            break;
          }
        }
        setRun((r) => r && { ...r, done: i + 1, res: [...res] });
      }
    } finally {
      window.removeEventListener('beforeunload', onLeave);
    }
    setRun((r) => r && { ...r, cur: '', finished: true, offline: false });
    setRunActive(false);
    setRunWhy(why);
    const n = res.filter((x) => x.ok === 'picked').length;
    toast(`Pick all matched: ${n} line${n === 1 ? '' : 's'} picked, ${res.length - n} left for manual${stopRef.current ? ' — stopped; press Pick all matched again to go on' : ''}`);
    reload(); setHistKey((k) => k + 1);
    setScope('manual'); setByView('lines');
  };
  // Pick Hold: put a line on hold (a reason) or release it; a held line cannot be picked
  const [holding, setHolding] = useState<LineP | null>(null);
  const setHold = async (l: LineP, reason: string | null) => {
    try {
      const period = periodOf(l as LineP & { plan_type?: string });
      await api('/api/status', { method: 'PATCH', body: { key: l.key, week: period, date: l.date ?? null, hold: reason } });
      toast(reason ? `${l.so} / ${l.li} is on hold — ${reason}` : `Hold released: ${l.so} / ${l.li} can be picked`);
      reload();
    } catch (e) { toast(e instanceof Error ? e.message : 'Could not change the hold.'); }
  };

  return (
    <>
      <HistorySearch />

      <section className="card" aria-labelledby="pd-title">
        <h2 id="pd-title">Pick data {rid ? <span className="pill accent" style={{ marginLeft: 6 }}>{label || rid}</span> : null}</h2>
        {!rid && isWk && <div className="notice warn" style={{ margin: '6px 0' }}>Week plan: choose the <b>Plant</b> at the top — each plant of a week has its own reports (ZMMBE, ZINSR, SHADE, ZROLLMGT, KORBER, ZMM_TRR). Every plant&apos;s lines are still picked from that plant&apos;s reports.</div>}
        {!rid && !isWk && <div className="notice warn" style={{ margin: '6px 0' }}>Choose a Pick at the top: every Pick has its own ZINSR, ZCOMENT VIEW and Korber Inventory. (All picks of the day: the reports shown are the shared ones.)</div>}
        <p className="sub">Upload in any order; each upload replaces that Pick&apos;s previous one. Matching: ZMMBE → ZINR (SO, LI, Material, Batch, UR = Insp. Lot Qty) → ZCOMENT VIEW Shade Report (Inspection lot) → Korber — a roll is matched only when all agree: Barcode Number = Pallet, Vendor Batch = Lot Number, Vendor Roll No = Supplier Hu (ZCOMENT), Vendor Invoice No = Invoice Number and Purchasing Document = Po Number (ZINR). Qty differences need “Confirmed”.</p>
        <div className="pick-ups">
          {PICK_SRCS.map((p) => {
            const u = status?.uploads.find((x) => x.src === p.src);
            return (
              <div key={p.src} className="pick-up">
                <div><b>{p.title}</b> <span className="pill mute">{fmt(cnt(p.src))} rows</span>{' '}
                  {(() => { const u0 = status?.reports?.find((x) => x.src === p.src)?.uses; return rid && u0 ? <span className={`pill ${u0 === 'own' ? 'ok' : u0 === 'shared' ? 'warn' : 'bad'}`}>{u0 === 'own' ? 'this Pick' : u0 === 'shared' ? 'shared' : 'missing'}</span> : null; })()}</div>
                <span className="muted small">{u ? `${u.file_name || ''} · ${u.uploaded_by} · ${ago(u.uploaded_at)}` : p.hint}</span>
                {u && <button className="btn sm" title="Download the Excel file as it was uploaded" onClick={() => downloadLatest(p.src, rid || '').then((n) => toast(`${n} downloaded`)).catch((e) => toast(e instanceof Error ? e.message : 'Could not download.'))}>⬇ Original</button>}
                {canEdit && <>
                  <button className="btn sm primary" aria-busy={busy === p.src || undefined} disabled={!!busy || !rid} title={rid ? `Upload to ${label || rid}` : isWk ? 'Choose the plant first: a week plan\'s reports belong to one plant' : 'Choose a Pick first'} onClick={() => inputs.current[p.src]?.click()}>{busy === p.src ? 'Uploading…' : `Upload ${p.title}`}</button>
                  <input ref={(el) => { inputs.current[p.src] = el; }} type="file" hidden accept=".xlsx,.xls,.xlsm,.csv" onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(p.src, f); e.target.value = ''; }} />
                </>}
              </div>
            );
          })}
        </div>
      </section>

      <section className="card" aria-labelledby="rp-title">
        <div className="sheet-top">
          <div>
            <h2 id="rp-title">Plan → Pick <span className="pill ok" style={{ marginLeft: 6 }}>{fmt(list.length)}</span></h2>
            <p className="sub" style={{ margin: 0 }}>To pick now: Auto match = the matched rolls cover the QTY (⚡ Pick all matched picks them) · Needs manual = pick by hand, with the reason. Balance = QTY − picked. Picked QTY counts as Dispatched.</p>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <input type="search" className="as-search" placeholder="Search SO, item…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search lines" />
            {repRid && <button className="btn" onClick={() => setShowReport(true)} title="The plan report of this Pick — on screen and as Excel">📋 {report?.name || 'Plan report'}</button>}
            {showReport && repRid && <PlanReport rid={repRid} onClose={() => setShowReport(false)} />}
            {canEdit && <button className="btn primary run-all" disabled={!!run && !run.finished} onClick={runAll} title="Pick every roll where everything matches, line by line">⚡ Pick all matched</button>}
            {canEdit && <button className="btn" onClick={() => setImportOpen(true)} title="A Packing List file (this system's format) into this Pick: its rolls are saved as picks of the Pick's SO lines">⬆ Import Packing List</button>}
            {importOpen && <ImportPLDialog week={week} label={label || week} toast={toast} onClose={(changed) => { setImportOpen(false); if (changed) { reload(); setHistKey((k) => k + 1); } }} />}
          </div>
        </div>
        <div className="pick-tabs" role="tablist" aria-label="Plan → Pick views">
          {([
            ['To pick now', [
              ['ready', 'Auto match', 'Lines with All-match rolls — “Pick all matched” picks them (a line they only part cover also shows under Needs manual for the rest)'],
              ['manual', 'Needs manual', 'Lines with UR the matched rolls do not cover: rolls to check, shared lots, no barcode, not matched or Manual pallet — with the reason'],
              ['open', 'All with UR', 'Every open line with UR to pick'],
            ]],
            ['Follow up', [
              ['pending', 'Pending', 'Every plan line not dispatched yet, by what it is waiting for'],
              ['hold', 'On hold', 'Lines on Pick Hold'],
            ]],
            ['Done', [
              ['picked', 'Picked', 'Lines with a pick'],
              ['done', 'Completed', 'Lines picked in full, closed short or completed'],
            ]],
          ] as [string, [Scope, string, string][]][]).map(([g, tabs]) => (
            <div key={g} className="pick-tab-group">
              <span className="pick-tab-label">{g}</span>
              <div className="seg" role="group" aria-label={g}>
                {tabs.map(([k, t, tip]) => (
                  <button key={k} role="tab" aria-selected={scope === k} className={scope === k ? 'on' : ''} title={tip}
                    onClick={() => { setScope(k); if (k === 'pending') setWhy(''); if (k === 'manual' || k === 'possible' || k === 'ready') setByView('lines'); }}>
                    {t} <span className={`tab-n ${k === 'manual' && scopeN.manual ? 'warn' : k === 'possible' && scopeN.possible ? 'hot' : ''}`}>{(k === 'manual' || k === 'ready') && scanning ? '…' : fmt(scopeN[k])}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
        {run && (
          <div className={`run-panel ${run.finished ? 'done' : 'going'} ${run.offline ? 'offline' : ''}`} role="status" aria-live="polite">
            <div className="run-top">
              {!run.finished ? <span className="run-dot" aria-hidden="true" /> : <span className="run-ok" aria-hidden="true">✓</span>}
              <b>{run.finished ? 'Pick all matched — finished' : run.offline ? 'Network lost — paused, goes on by itself' : 'Picking all matched rolls… keep this tab open'}</b>
              <span className="muted small">{run.done} / {run.total} lines{run.cur ? ` · ${run.cur}` : ''}</span>
              <span style={{ flex: 1 }} />
              {!run.finished ? <button className="btn sm" onClick={() => { stopRef.current = true; }}>Stop</button> : <button className="btn sm" onClick={() => setRun(null)}>Close</button>}
            </div>
            <div className="run-bar"><i style={{ width: `${run.total ? Math.round((run.done / run.total) * 100) : 0}%` }} /></div>
            <div className="run-sum">
              <span className="pill ok">{run.res.filter((x) => x.ok === 'picked').length} picked</span>
              <span className="pill warn">{run.res.filter((x) => x.ok === 'skip').length} need manual</span>
              {run.res.some((x) => x.ok === 'error') && <span className="pill bad">{run.res.filter((x) => x.ok === 'error').length} error</span>}
            </div>
            <ol className="run-list">{[...run.res].reverse().slice(0, 60).map((x) => (
              <li key={x.id} className={`run-${x.ok}`}><span className={`pill ${x.ok === 'picked' ? 'ok' : x.ok === 'skip' ? 'warn' : 'bad'}`}>{x.ok === 'picked' ? '✓ picked' : x.ok === 'skip' ? 'manual' : 'error'}</span> <b>{x.so} / {x.li}</b> <span className="muted">{x.item}</span> — {x.text}</li>
            ))}</ol>
          </div>
        )}
        {scope === 'pending' && pending.length > 0 && (
          <div className="pend-bar" role="group" aria-label="Pending by reason">
            <span className="weeks-label">Pending</span>
            <button type="button" className={`pend-chip ${scope === 'pending' && !why ? 'on' : ''}`} onClick={() => { setScope('pending'); setWhy(''); }}>
              <b>{fmt(pending.reduce((t, p) => t + p.n, 0))}</b><span>All · {fmtQty(pending.reduce((t, p) => t + p.qty, 0))}</span>
            </button>
            {pending.map((p) => (
              <button key={p.why} type="button" className={`pend-chip ${PENDING_TONE[p.why] || ''} ${scope === 'pending' && why === p.why ? 'on' : ''}`} onClick={() => { setScope('pending'); setWhy(p.why); }}>
                <b>{fmt(p.n)}</b><span>{p.why} · {fmtQty(p.qty)}</span>
              </button>
            ))}
          </div>
        )}
        <div className="seg" role="group" aria-label="View" style={{ margin: '4px 0 8px' }}>
          <button className={byView === 'so' ? 'on' : ''} onClick={() => setByView('so')}>By SO</button>
          <button className={byView === 'lines' ? 'on' : ''} onClick={() => setByView('lines')}>All lines</button>
        </div>
        {byView === 'so' && list.length > 0 && (() => {
          // what to pick = the plan QTY, at most the UR (Total − SO QI − SO Blocked − Assigned)
          const pickQty = (l: LineP) => Math.max(0, Math.min(Number(l.qty), Number(l.ur) || 0));
          const sos = Array.from(new Set(list.map((l) => l.so)));
          return (
            <div className="so-list">
              {sos.map((so) => {
                const ls = list.filter((l) => l.so === so);
                const plan = ls.reduce((t, l) => t + Number(l.qty), 0), pq = ls.reduce((t, l) => t + pickQty(l), 0), picked = ls.reduce((t, l) => t + (l.picked ?? 0), 0);
                const doneN = ls.filter((l) => isDone(l)).length, holdN0 = ls.filter((l) => l.hold && !isDone(l)).length;
                const on = openSo === so;
                return (
                  <div key={so} className={`so-card ${on ? 'on' : ''}`}>
                    <button type="button" className="so-head" onClick={() => setOpenSo(on ? null : so)} aria-expanded={on}>
                      <b className="mono">{so}</b>
                      <span>{ls.length} item{ls.length === 1 ? '' : 's'}</span>
                      <span>Plan <b>{fmtQty(plan)}</b></span>
                      <span title="The plan QTY, at most the UR">Pick <b>{fmtQty(pq)}</b></span>
                      <span>Picked <b>{fmtQty(picked)}</b></span>
                      {doneN > 0 && <span className="pill ok">{doneN} done</span>}{holdN0 > 0 && <span className="pill bad">{holdN0} on hold</span>}
                      <span className="so-arrow">{on ? '▾' : '▸'}</span>
                    </button>
                    {on && (
                      <div className="table-wrap" style={{ maxHeight: 'none' }}>
                        <table className="mini">
                          <thead><tr><th>LI</th><th>Item Code</th><th>Plant</th><th className="n">QTY</th><th className="n" title="Total stock − SO Blocked stock − Assigned Qty (ZMMBE)">UR</th><th className="n" title="QTY, at most the UR">Pick QTY</th><th className="n">Picked</th><th className="n">Balance</th><th className="n">Korber qty</th><th>State</th><th /></tr></thead>
                          <tbody>{ls.map((l) => {
                            const pk = l.picked ?? 0;
                            return (
                              <tr key={l.id} className={l.hold && !isDone(l) ? 'on-hold' : ''}>
                                <td>{l.li}</td><td>{l.item}</td><td>{l.plant}</td><td className="n">{fmtQty(l.qty)}</td><td className="n">{fmtQty(Number(l.ur) || 0)}</td>
                                <td className="n"><b>{fmtQty(pickQty(l))}</b>{Number(l.qty) > (Number(l.ur) || 0) + 1e-9 && <span className="muted small" title="QTY is more than the UR: the UR is picked"> (UR)</span>}</td>
                                <td className="n">{pk ? fmtQty(pk) : '–'}</td><td className="n">{fmtQty(bal(l))}</td>
                                <td className="n">{korberOf(l)}</td>
                                <td>{stateOf(l)}</td>
                                <td style={{ whiteSpace: 'nowrap' }}>{canEdit && !isDone(l) && !l.hold && <button className="btn sm primary" onClick={() => setPicking(l)}>{pk ? 'Pick more' : 'Pick'}</button>}</td>
                              </tr>
                            );
                          })}</tbody>
                        </table>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })()}
        {byView === 'lines' && (!list.length ? <p className="muted">No lines {scope === 'possible' ? 'in POSIBAL PENDING' : scope === 'manual' ? (scanning ? 'yet — checking the matched rolls…' : 'left to pick by hand') : scope === 'ready' ? (scanning ? 'yet — checking the matched rolls…' : 'where the matched rolls cover the QTY') : scope === 'picked' ? 'picked yet' : scope === 'hold' ? 'on hold' : scope === 'pending' ? 'pending' : 'with UR stock'} in {label || week}.</p> : (
          <div className="table-wrap" style={{ maxHeight: 460 }}>
            <table className="mini">
              <thead><tr><th>SO</th><th>LI</th><th>Item</th><th>Date</th><th>Plant</th><th className="n">QTY</th><th className="n">Picked = Dispatched</th><th className="n">Balance</th><th className="n">UR left</th><th className="n" title="Korber Inventory: Actual Qty of this SO / LI / Item's rolls still on the shelf (its ZINR lots; picks taken off)">Korber qty</th><th>State</th><th /></tr></thead>
              <tbody>{list.map((l) => {
                const pk = l.picked ?? 0, done = isDispatched(l);
                return (
                  <tr key={l.id} className={l.hold && !isDone(l) ? 'on-hold' : ''}>
                    <td>{l.so}</td><td>{l.li}</td><td>{l.item}</td><td>{fmtDate(l.date)}</td><td>{l.plant}</td>
                    <td className="n">{fmtQty(l.qty)}</td>
                    <td className="n">{pk ? <>{fmtQty(pk)} <span className="muted">({l.picked_rolls} roll{l.picked_rolls === 1 ? '' : 's'})</span></> : '–'}</td>
                    <td className="n"><b>{fmtQty(bal(l))}</b>{sentOf(l) && sentOf(l)!.sent > 1e-9 && <div className="muted small" title="ALRADY SEND (ZMMBE at the plant storage locations) is taken off the balance">sent {fmtQty(sentOf(l)!.sent)}</div>}</td><td className="n">{fmtQty(avail(l))}</td>
                    <td className="n">{korberOf(l)}</td>
                    <td>{stateOf(l)}
                      {scope === 'manual' && (scan[l.id]?.why || runWhy[l.id]) && <div className="small run-why"><span className="pill warn">Manual</span> <span className="muted">{scan[l.id]?.why || runWhy[l.id]}</span></div>}
                      {scope === 'ready' && scan[l.id] && <div className="small run-why"><span className="pill ok">All match {fmtQty(scan[l.id].auto)}</span>{scan[l.id].why && <span className="muted"> · {fmtQty(r3(scan[l.id].left - scan[l.id].auto))} more by hand</span>}</div>}
                      {scope === 'possible' && (() => { const x = possible.get(`${l.key}|${l.date ?? ''}`); return x ? <div className="small run-why"><span className="pill warn">Posibal pending {fmtQty(Number(x.possible))}</span> <span className="muted">sent {fmtQty(x.sent)} · warehouse {fmtQty(x.wh)}{x.tn ? ` · TN ${x.tn}` : ''}</span></div> : null; })()}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{canEdit && !isDone(l) && (l.hold
                        ? <button className="btn sm" onClick={() => setHold(l, null)} title="Release the hold — the line can be picked again">Release hold</button>
                        : <><button className="btn sm primary" onClick={() => setPicking(l)}>{pk ? 'Pick more' : 'Pick'}</button> <button className="btn sm" onClick={() => setHolding(l)} title="Put this line on Pick Hold — nobody can pick it until it is released">Hold</button></>)}
                      {canEdit && <> <CompleteLine line={l} onDone={(m) => { toast(m); reload(); }} /></>}</td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
        ))}
        {byView === 'so' && !list.length && <p className="muted">No lines in this view in {label || week}.</p>}
      </section>

      {holding && <HoldDialog line={holding} onClose={() => setHolding(null)} onSave={(r) => { const l = holding; setHolding(null); void setHold(l, r); }} />}


      <PickHistoryCard key={histKey} canEdit={canEdit} toast={toast} onChanged={() => { reload(); setHistKey((k) => k + 1); }} />

      <RejectedRolls key={`rj${histKey}`} canEdit={canEdit} toast={toast} onChanged={() => { reload(); setHistKey((k) => k + 1); }} />


      {picking && <PickModal week={picking.week || week} line={picking} onClose={() => setPicking(null)}
        onDone={(m) => { setPicking(null); toast(m); reload(); setHistKey((k) => k + 1); }} />}
    </>
  );
}

const CHECK_LABELS: [string, string][] = [['barcode', 'Barcode = Pallet'], ['lot', 'Vendor Batch = Lot Number'], ['hu', 'Vendor Roll No = Supplier Hu'], ['invoice', 'Invoice'], ['po', 'Purchasing Document = Po Number'], ['item', 'Item'], ['qty', 'ZCOMENT Roll qty = Korber Actual Qty (Korber is used)']];
const checkText = (c: Record<string, boolean | null>) => CHECK_LABELS.map(([k, l]) => `${c[k] === true ? '✓' : c[k] === false ? '✗' : '–'} ${l}`).join('\n');
const r3 = (n: number) => Math.round(n * 1000) / 1000;
/** FIFO: rolls chosen by hand are listed oldest Korber Fifo Date first (no date last); a pickable roll before a used-up one */
const fifoKey = (x: { fifo?: string | null }) => x.fifo || '9999-12-31';
const byFifo = <T extends { fifo?: string | null; available: number; blocked?: string }>(a: T, b: T) =>
  Number(b.available > 1e-9 && !b.blocked) - Number(a.available > 1e-9 && !a.blocked) || fifoKey(a).localeCompare(fifoKey(b));
const fifoText = (d?: string | null) => (d ? d.split('-').reverse().join('-') : '–');
/** manual selection: pickable first, then the best SAP fit to the SO line, then FIFO (oldest first) */
const byFit = <T extends { fifo?: string | null; available: number; blocked?: string; sap?: SapFit | null }>(a: T, b: T) =>
  Number(b.available > 1e-9 && !b.blocked) - Number(a.available > 1e-9 && !a.blocked) || (b.sap?.score ?? 0) - (a.sap?.score ?? 0) || fifoKey(a).localeCompare(fifoKey(b));
/** the SAP fields a roll matches (✓) and does not (✗), small under the roll */
function SapFitLine({ f, best }: { f?: SapFit | null; best?: boolean }) {
  if (!f) return null;
  return (
    <div className="sap-fit">
      {best && <span className="sap-best">★ Best</span>}
      {f.hits.map((h) => <span key={'h' + h} className="sap-ok">✓ {h}</span>)}
      {f.miss.map((h) => <span key={'m' + h} className="sap-no">✗ {h}</span>)}
      {f.shade && <span className="sap-info">Shade {f.shade}</span>}
    </div>
  );
}
/**
 * The smart suggestion: the best set of rolls for the QTY (shade, lot, cut, FIFO, SAP fit, lot QTY — see lib/rollSuggest),
 * why it is the best, two other good sets, and how the rolls ticked now compare. Nothing is ticked until "Use".
 */
function SmartPanel({ smart, rolls, sel, lotCaps, onUse }: { smart: ReturnType<typeof smartSuggest>; rolls: Candidate[]; sel: Sel; lotCaps: Map<string, number>; onUse: (x: Suggestion) => void }) {
  const [more, setMore] = useState(false);
  const b = smart.best!;
  const mine = rolls.filter((r) => sel[r.pallet] && !sel[r.pallet].manual && !sel[r.pallet].nb);
  const same = mine.length === b.picks.length && b.picks.every((p) => Math.abs((Number(sel[p.pallet]?.qty) || 0) - p.qty) < 0.0005);
  const shadesOf = (rs: Candidate[]) => new Set(rs.map((r) => String(r.shade ?? '').trim().toUpperCase()).filter(Boolean)).size;
  const cutsMine = mine.filter((r) => (Number(sel[r.pallet].qty) || 0) < r.available - 0.0005).length;
  // the ticked rolls against each ZINSR lot's QTY
  const use = new Map<string, number>();
  for (const r of mine) { const ls = Array.from(new Set((r.parts?.length ? r.parts.map((p) => p.lot) : r.insp_lots).map(String))).filter((l) => lotCaps.has(l)); if (ls.length) use.set(ls.join(','), (use.get(ls.join(',')) ?? 0) + (Number(sel[r.pallet].qty) || 0)); }
  const overLot = Array.from(use).filter(([k, q]) => q > k.split(',').reduce((t, l) => t + (lotCaps.get(l) ?? 0), 0) + 0.0005).length;
  const totMine = r3(mine.reduce((t, r) => t + (Number(sel[r.pallet].qty) || 0), 0));
  const line = (x: Suggestion) => `${x.picks.length} roll${x.picks.length === 1 ? '' : 's'} · ${fmtQty(x.total)} · ${x.cuts ? `${x.cuts} cut` : 'no cut'} · ${x.shades.length ? `shade ${x.shades.join('+')}` : 'no shade'}${x.short > 0 ? ` · ${fmtQty(x.short)} short` : ''}`;
  return (
    <div className={`smart-box ${same ? 'same' : ''}`} role="region" aria-label="Smart roll suggestion">
      <div className="smart-head">
        <span className="smart-badge">★ Smart suggestion</span>
        <b>{line(b)}</b>
        <span className="muted small">{smart.considered} rolls checked{smart.considered <= 14 ? ' · every combination scored' : ''}</span>
        <span style={{ flex: 1 }} />
        {same ? <span className="pill ok">Your selection is the smart suggestion ✓</span>
          : <button type="button" className="btn sm primary" onClick={() => onUse(b)}>Use smart suggestion</button>}
      </div>
      <div className="smart-rolls">{b.picks.map((p) => <span key={p.pallet} className={`smart-roll ${p.cut ? 'cut' : ''}`} title={p.cut ? `Cut: take ${p.qty}, ${p.left} stays` : 'Full roll'}><span className="mono">{p.pallet}</span> {fmtQty(p.qty)}{p.cut ? ' ✂' : ''}</span>)}</div>
      <ul className="smart-why">{b.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
      {b.warnings.length > 0 && <div className="smart-warn">{b.warnings.map((w, i) => <div key={i}>⚠ {w}</div>)}</div>}
      {!same && mine.length > 0 && (
        <div className="smart-vs">Your ticks now: {mine.length} roll{mine.length === 1 ? '' : 's'} · {fmtQty(totMine)} · {cutsMine ? `${cutsMine} cut` : 'no cut'} · {shadesOf(mine) || 'no'} shade{shadesOf(mine) === 1 ? '' : 's'}{overLot ? <b className="bad-t"> · over a ZINSR lot QTY</b> : ''}
          {shadesOf(mine) > b.shades.length && <b className="bad-t"> · more shades than needed</b>}{cutsMine > b.cuts && <b className="bad-t"> · more cuts than needed</b>}</div>
      )}
      {smart.alts.length > 0 && <button type="button" className="linkish" onClick={() => setMore((v) => !v)}>{more ? 'Hide' : 'Show'} {smart.alts.length} other good set{smart.alts.length === 1 ? '' : 's'}</button>}
      {more && smart.alts.map((a, i) => (
        <div key={i} className="smart-alt"><span>{line(a)} — {a.picks.map((p) => p.pallet.slice(-6)).join(', ')}</span><button type="button" className="btn sm" onClick={() => onUse(a)}>Use</button></div>
      ))}
    </div>
  );
}

/** the reports a line reads: a week plan line → its week + plant; a Pick → the Pick */
const lineScope = (week: string, plant: string | null | undefined) => (/^\d{4}-W\d{2}$/.test(week) && (plant || '').trim() ? `${week}@${(plant || '').trim().toUpperCase().replace(/\s+/g, '')}` : week);

/** nb = chosen for a shade-report roll with no Barcode Number (one of its offered Korber rolls) */
type SelV = { qty: string; manual?: ManualRoll | NoBarcodeRoll; korber?: KorberRow; nb?: NoBarcodeRoll };
type Sel = Record<string, SelV>;
interface LastRoll { pallet: string; hu: string | null; full: number; cut: number }

/** How much of a roll counts for each batch: its ZCOMENT parts, limited to what is still available (smallest part first). */
function rollParts(r: Candidate): { batch: string; qty: number }[] {
  const parts = r.parts?.length ? [...r.parts].sort((a, b) => a.qty - b.qty) : [{ batch: r.batches[0] ?? '', qty: r.available }];
  let left = r.available;
  const out = parts.map((p) => { const q = Math.min(p.qty, left); left = r3(left - q); return { batch: p.batch, qty: q }; });
  if (left > 1e-9 && out.length) out[out.length - 1].qty = r3(out[out.length - 1].qty + left); // Korber has a little more than ZCOMENT
  return out;
}

/**
 * The system's choice, batch by batch (each batch's UR comes from its own rolls in ZCOMENT):
 * the smallest need first, full rolls while they fit, then the roll of that batch that fits the rest best — cut,
 * or sent in full if the user confirms. A roll split over two batches (86 + 1 = 87) counts for both.
 */
/** Rolls whose QTY adds up to exactly `target` (within 0.0005), fewest rolls; null when there is none (up to 18 rolls). */
function exactSubset(items: { id: string; q: number }[], target: number): Set<string> | null {
  if (!(target > 1e-9) || !items.length) return null;
  const xs = items.slice(0, 18);
  let best: number | null = null, bestN = Infinity;
  const n = xs.length;
  for (let m = 1; m < 1 << n; m++) {
    let q = 0, c = 0;
    for (let i = 0; i < n; i++) if (m & (1 << i)) { q += xs[i].q; c++; if (q > target + 0.0005) break; }
    if (Math.abs(q - target) <= 0.0005 && c < bestN) { best = m; bestN = c; }
  }
  if (best === null) return null;
  return new Set(xs.filter((_, i) => best! & (1 << i)).map((x) => x.id));
}

/**
 * The rolls "Pick all matched" may take: every roll where everything matches (no "I checked" needed). A shared-lot roll
 * (SAP lists the same roll in the inspection lots of several SO lines) is in this line's own lot too, so it is taken like
 * any matched roll — within this line's ZINSR lot QTY, a cut roll's balance first (the next SO line takes the rest of it).
 */
export function autoRolls(c: Candidates): Candidates {
  return { ...c, rolls: c.rolls.filter((x) => !x.needsConfirm).map((x) => (x.pool ? { ...x, pool: undefined, suggested: undefined } : x)) };
}

export function autoPlan(c: Candidates, withPool = false): { sel: Sel; last: LastRoll | null } {
  let left = r3(c.need - c.picked);
  const sel: Sel = {};
  // rolls of a lot shared by several SO lines are ticked by the user, never by the system; "select suggested" takes the
  // suggested ones (the rolls whose Actual Qty adds up to this line's lot QTY), or all shared ones when none is suggested
  const anySuggested = c.rolls.some((r) => r.suggested);
  // rolls sharing their batch's ZROLLMGT Available (a little on each roll in SAP): taken together at most that — the QTY is
  // cut from as few rolls as possible (copies: what one roll takes leaves less for the others)
  const pooled = c.rolls.some((r) => r.zpool);
  const avail = c.rolls.filter((r) => r.available > 1e-9 && (!r.pool || (withPool && (!anySuggested || r.suggested)))).map((r) => (r.zpool ? { ...r } : r));
  const poolLeft = new Map(pooled ? avail.filter((r) => r.zpool).map((r) => [r.zpool!.batch, r.zpool!.avail] as [string, number]) : []);
  const orig = new Map(c.rolls.map((r) => [r.pallet, r.available]));
  let last: LastRoll | null = null;
  // a ZINSR lot (Vendor Batch) gives this SO line at most its own QTY (less what it already gave): never more from one lot
  const lotLeft = new Map((c.lots || []).filter((l) => (l.cap ?? l.need) != null).map((l) => [String(l.lot), Number(l.cap ?? l.need)]));
  const lotsOf = (r: Candidate) => Array.from(new Set((r.parts?.length ? r.parts.map((p) => p.lot) : r.insp_lots).map(String))).filter((l) => lotLeft.has(l));
  const room = (r: Candidate) => { const ls = lotsOf(r); return ls.length ? r3(ls.reduce((t, l) => t + (lotLeft.get(l) ?? 0), 0)) : Infinity; };
  // an exact (no cut) set must fit every ZINSR lot's QTY together, not only roll by roll
  const fitsLots = (rs: Candidate[]) => {
    const left0 = new Map(lotLeft);
    for (const r of rs) {
      let q = r.available; const ls = lotsOf(r);
      if (!ls.length) continue;
      for (const l of ls) { if (q <= 1e-9) break; const t = Math.min(left0.get(l) ?? 0, q); left0.set(l, r3((left0.get(l) ?? 0) - t)); q = r3(q - t); }
      if (q > 1e-9) return false;
    }
    return true;
  };
  const take = (r: Candidate, q: number, need: Map<string, number> | null) => {
    if (pooled && !(q > 1e-9)) return;
    sel[r.pallet] = { qty: String(r3(q)) };
    left = r3(left - q);
    if (r.zpool) {
      const pl = Math.max(0, r3((poolLeft.get(r.zpool.batch) ?? 0) - q)); poolLeft.set(r.zpool.batch, pl);
      for (const o of avail) if (o.zpool?.batch === r.zpool.batch && !sel[o.pallet]) o.available = Math.min(orig.get(o.pallet) ?? 0, pl);
    }
    { let rest = q; for (const l of lotsOf(r)) { if (rest <= 1e-9) break; const t = Math.min(lotLeft.get(l) ?? 0, rest); lotLeft.set(l, r3((lotLeft.get(l) ?? 0) - t)); rest = r3(rest - t); } }
    if (need) {
      let rest = q;
      for (const p of rollParts(r)) { if (rest <= 1e-9) break; const t = Math.min(p.qty, rest); need.set(p.batch, Math.max(0, r3((need.get(p.batch) ?? 0) - t))); rest = r3(rest - t); }
    }
  };
  const need = c.batchNeed?.length ? new Map(c.batchNeed.map((b) => [b.batch, b.need])) : null;
  if (need) {
    const order = Array.from(need.entries()).filter(([, n]) => n > 1e-9).sort((a, b) => a[1] - b[1]).map(([b]) => b);
    for (const batch of order) {
      const partOf = (r: Candidate) => rollParts(r).find((p) => p.batch === batch)?.qty ?? 0;
      // fewer cuts: a cut roll's balance first (it leaves the shelf), then the others in their order
      const rs = () => avail.filter((r) => !sel[r.pallet] && r.available > 1e-9 && partOf(r) > 1e-9).sort((a, b) => Number(b.picked_before > 0) - Number(a.picked_before > 0));
      // rolls whose QTY adds up to exactly what the batch needs: no cut at all
      {
        const nb0 = Math.min(need.get(batch) ?? 0, left);
        const whole = rs().filter((r) => partOf(r) >= r.available - 1e-9 && r.available <= nb0 + 1e-9 && r.available <= room(r) + 1e-9);
        const exact = exactSubset(whole.map((r) => ({ id: r.pallet, q: r.available })), nb0);
        if (exact && fitsLots(whole.filter((r) => exact.has(r.pallet)))) { for (const r of whole) if (exact.has(r.pallet)) take(r, r.available, need); continue; }
      }
      for (const r of rs()) {
        const nb = need.get(batch) ?? 0;
        if (nb <= 1e-9 || left <= 1e-9) break;
        if (partOf(r) <= nb + 1e-9 && r.available <= left + 1e-9 && r.available <= room(r) + 1e-9) take(r, r.available, need);
      }
      const nb = Math.min(need.get(batch) ?? 0, left);
      if (nb > 1e-9) {
        // the roll to cut: one already cut (no new cut roll on the shelf), else the smallest that covers the rest
        const fit = rs().filter((r) => partOf(r) >= nb - 1e-9 && room(r) >= nb - 1e-9).sort((a, b) => Number(b.picked_before > 0) - Number(a.picked_before > 0) || partOf(a) - partOf(b) || a.available - b.available)[0];
        if (fit) { last = { pallet: fit.pallet, hu: fit.supplier_hu, full: r3(fit.available), cut: r3(nb) }; take(fit, nb, need); }
      }
    }
  }
  // whatever the batches do not explain: any matched roll, full rolls first (an exact set first: no cut), then the best fit
  if (left > 1e-9) {
    const rest = avail.filter((r) => !sel[r.pallet] && r.available > 1e-9 && r.available <= left + 1e-9 && r.available <= room(r) + 1e-9);
    const exact = exactSubset(rest.map((r) => ({ id: r.pallet, q: r.available })), left);
    if (exact && fitsLots(rest.filter((r) => exact.has(r.pallet)))) for (const r of rest) if (exact.has(r.pallet)) take(r, r.available, null);
  }
  for (const r of [...avail].sort((a, b) => Number(b.picked_before > 0) - Number(a.picked_before > 0))) {
    if (left <= 1e-9) break;
    if (!sel[r.pallet] && r.available > 1e-9 && r.available <= left + 1e-9 && r.available <= room(r) + 1e-9) take(r, r.available, null);
  }
  if (left > 1e-9) {
    const fit = avail.filter((r) => !sel[r.pallet] && r.available >= left && room(r) >= left - 1e-9).sort((a, b) => Number(b.picked_before > 0) - Number(a.picked_before > 0) || a.available - b.available)[0];
    if (fit) { last = { pallet: fit.pallet, hu: fit.supplier_hu, full: r3(fit.available), cut: left }; take(fit, left, null); }
    else {
      // no roll covers the rest inside its lot: cut the one with the most room in its lot (only what that lot still gives)
      const f2 = avail.filter((r) => !sel[r.pallet] && r.available > 1e-9 && room(r) > 1e-9).sort((a, b) => room(b) - room(a))[0];
      if (f2) { const q = r3(Math.min(left, room(f2), f2.available)); if (q > 1e-9) { if (q < f2.available - 1e-9) last = { pallet: f2.pallet, hu: f2.supplier_hu, full: r3(f2.available), cut: q }; take(f2, q, null); } }
    }
  }
  return { sel, last };
}

const HOLD_REASONS = ['Customer asked to hold', 'Shade issue', 'Quality check', 'Plant not ready', 'Wrong roll / label', 'Waiting for approval'];
/** Asks the reason for a Pick Hold (a list of usual reasons, or typed). */
export function HoldDialog({ line, onClose, onSave }: { line: LineP; onClose: () => void; onSave: (reason: string) => void }) {
  const [r, setR] = useState('');
  return (
    <div className="modal-back">
      <form className="modal" role="dialog" aria-modal="true" aria-labelledby="hold-title" onSubmit={(e) => { e.preventDefault(); onSave(r.trim() || 'On hold'); }}>
        <div className="modal-head">
          <div><h2 id="hold-title">Pick Hold · {line.so} / {line.li}</h2><p className="sub" style={{ margin: 0 }}>{line.item} · balance {fmtQty(need(line))}. Nobody can pick this line until the hold is released; it shows as <b>On hold</b> everywhere.</p></div>
          <button type="button" className="btn sm" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <label style={{ display: 'grid', gap: 6 }}>Reason
          <input autoFocus list="hold-reasons" value={r} onChange={(e) => setR(e.target.value)} placeholder="e.g. Customer asked to hold" maxLength={120}
            style={{ padding: '8px 10px', border: '1px solid var(--line-strong)', borderRadius: 6, background: 'var(--panel)', color: 'var(--ink)' }} />
          <datalist id="hold-reasons">{HOLD_REASONS.map((x) => <option key={x} value={x} />)}</datalist>
        </label>
        <div className="hold-quick">{HOLD_REASONS.map((x) => <button key={x} type="button" className={`btn sm ${r === x ? 'primary' : ''}`} onClick={() => setR(x)}>{x}</button>)}</div>
        <div className="modal-foot"><span /><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary">Put on hold</button></div>
      </form>
    </div>
  );
}

export function PickModal({ week, line, onClose, onDone }: { week: string; line: LineP; onClose: () => void; onDone: (m: string) => void }) {
  const [c, setC] = useState<Candidates | null>(null);
  const [err, setErr] = useState('');
  const [sel, setSel] = useState<Sel>({});
  const [last, setLast] = useState<LastRoll | null>(null);
  const [lastMode, setLastMode] = useState<'cut' | 'full' | 'leave'>('cut');
  const [kind, setKindS] = useState<'normal' | 'offsite'>(() => { try { return localStorage.getItem('mas-pick-kind') === 'offsite' ? 'offsite' : 'normal'; } catch { return 'normal'; } });
  const [closeShort, setCloseShort] = useState(false);
  // the admin's pick rules (Settings → Pick rules)
  const [rules, setRules] = useState({ fullRollPct: 10, defaultPickKind: 'normal' as 'normal' | 'offsite', allowOffsite: true, allowNormalShort: true, allowNormalFull: true });
  useEffect(() => {
    api<{ settings: typeof rules }>('/api/settings').then((r) => {
      setRules(r.settings);
      let saved: string | null = null; try { saved = localStorage.getItem('mas-pick-kind'); } catch { /* private mode */ }
      const k = r.settings.allowOffsite ? ((saved as 'normal' | 'offsite' | null) || r.settings.defaultPickKind) : 'normal';
      setKindS(k);
    }).catch(() => {});
  }, []);
  const [checkedOk, setCheckedOk] = useState(false);
  const [overOk, setOverOk] = useState(false);
  const [choosing, setChoosing] = useState<ManualRoll | null>(null);
  const [pickNo, setPickNo] = useState('');
  const [busy, setBusy] = useState(false);
  const [showNotes, setShowNotes] = useState(false);

  const applyAuto = useCallback((x: Candidates, keepManual: Sel = {}, withPool = false, fullIfSamePlant = true) => {
    // the same as "Pick all matched" (a shared-lot roll of this line's own lot included); "Select suggested rolls" keeps its own list
    const a = withPool ? autoPlan(x, true) : autoPlan(autoRolls(x));
    // the rest of the last roll stays with the same SO Plant: no need to cut — the full roll is proposed (Normal pick)
    const lr = a.last ? x.rolls.find((r) => r.pallet === a.last!.pallet) : undefined;
    const full = !!(fullIfSamePlant && a.last && lr?.sameSoPlant && a.last.full > a.last.cut);
    if (full) a.sel[a.last!.pallet] = { qty: String(a.last!.full) };
    setSel({ ...a.sel, ...keepManual }); setLast(a.last); setLastMode(full ? 'full' : 'cut'); setOverOk(false); setCloseShort(false);
  }, []);
  useEffect(() => {
    api<Candidates>(`/api/pick/candidates?week=${encodeURIComponent(week)}&key=${encodeURIComponent(line.key)}&date=${encodeURIComponent(line.date ?? '')}`)
      .then((x) => { setC(x); applyAuto(x); }).catch((e) => setErr(e instanceof Error ? e.message : 'Could not load rolls.'));
  }, [week, line, applyAuto]);
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && !(e.target instanceof HTMLElement && e.target.closest('input, select, textarea'))) onClose(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onClose]);

  const remaining = c ? Math.max(0, r3(c.need - c.picked)) : 0;
  const total = r3(Object.values(sel).reduce((t, x) => t + (Number(x.qty) || 0), 0));
  const nSel = Object.keys(sel).length;
  const diff = r3(total - remaining);
  const lastOn = !!(last && (sel[last.pallet] || lastMode === 'leave'));
  const lastSmall = !!last && (last.full - last.cut) <= Math.max((rules.fullRollPct / 100) * Number(line.qty || remaining), 1e-9);
  const setLastTo = (m: 'cut' | 'full' | 'leave') => {
    if (!last) return;
    setLastMode(m);
    setCloseShort(m === 'leave');
    setSel((s) => {
      const n = { ...s };
      if (m === 'leave') delete n[last.pallet];
      else n[last.pallet] = { ...(n[last.pallet] || {}), qty: String(m === 'full' ? last.full : last.cut) };
      return n;
    });
  };
  // Offsite: exact QTY only — the last roll is always cut, nothing over, no closing short
  const setKind = (k: 'normal' | 'offsite') => {
    setKindS(k); try { localStorage.setItem('mas-pick-kind', k); } catch { /* private mode */ }
    if (k === 'offsite') { if (lastMode !== 'cut') setLastTo('cut'); setCloseShort(false); setOverOk(false); }
  };
  // what a ZINSR lot (Vendor Batch) still gives this SO line, less the rolls of that lot already ticked
  const lotRoom = (r: Candidate, n: Sel) => {
    const caps = new Map((c?.lots || []).filter((l) => (l.cap ?? l.need) != null).map((l) => [String(l.lot), Number(l.cap ?? l.need)]));
    const ls = Array.from(new Set((r.parts?.length ? r.parts.map((p) => p.lot) : r.insp_lots).map(String))).filter((l) => caps.has(l));
    if (!ls.length) return Infinity;
    let room = ls.reduce((t, l) => t + (caps.get(l) ?? 0), 0);
    for (const [p, x] of Object.entries(n)) {
      const o = c?.rolls.find((y) => y.pallet === p);
      if (o && Array.from(new Set((o.parts?.length ? o.parts.map((q) => q.lot) : o.insp_lots).map(String))).some((l) => ls.includes(l))) room -= Number(x.qty) || 0;
    }
    return Math.max(0, r3(room));
  };
  const toggle = (r: Candidate) => setSel((s) => {
    const n = { ...s };
    if (n[r.pallet]) delete n[r.pallet];
    else {
      const left = r3(remaining - Object.values(n).reduce((t, x) => t + (Number(x.qty) || 0), 0));
      const want = r3(left > 1e-9 ? Math.min(r.available, left) : r.available);
      // never more than the roll's lot still gives this SO line
      n[r.pallet] = { qty: String(r3(Math.min(want, lotRoom(r, n)))) };
      if (!(Number(n[r.pallet].qty) > 0)) delete n[r.pallet];
    }
    return n;
  });
  // manual pick is only for the balance the matched rolls cannot cover
  const shortfall = c ? (c.shortfall ?? remaining) : 0;
  const manualTotal = Object.values(sel).filter((x) => x.manual && !x.nb).reduce((t, x) => t + (Number(x.qty) || 0), 0);
  const manualLeft = Math.max(0, r3(shortfall - manualTotal));
  const manualSel = Object.entries(sel).filter(([, x]) => x.manual && !x.nb);
  const nbSel = Object.entries(sel).filter(([, x]) => x.nb);
  // a roll with no barcode: the user picks its Korber roll from the matching ones ('' = none)
  const chooseNb = (m: NoBarcodeRoll, pallet: string) => setSel((s) => {
    const n = { ...s };
    for (const [p, x] of Object.entries(n)) if (x.nb === m) delete n[p];
    const o = m.options.find((x) => x.pallet === pallet);
    if (!o) return n;
    const left = r3(remaining - Object.values(n).reduce((t, x) => t + (Number(x.qty) || 0), 0));
    const want = Number(m.roll_qty) > 0 ? Math.min(o.available, Number(m.roll_qty)) : o.available;
    n[o.pallet] = { qty: String(r3(left > 1e-9 ? Math.min(want, left) : want)), manual: m, korber: o, nb: m };
    return n;
  });
  // Manual: a Korber pallet added by hand for a shortage of this pick (scan / type the pallet)
  const FREE = useMemo<ManualRoll>(() => ({ free: true, lot: '', batch: '', material: line.item, vendor_batch: null, roll_no: null, barcode: null, roll_qty: 0, shade: null, invoice: null, reason: 'Manual pallet', suggest: [] }), [line.item]);
  const [freeOpen, setFreeOpen] = useState(false);
  const freeSel = Object.entries(sel).filter(([, x]) => x.manual === FREE);
  const short = c ? Math.max(0, r3(remaining - total)) : 0;
  const useFree = (k: KorberRow) => setSel((s) => {
    const n = { ...s };
    if (n[k.pallet]?.manual === FREE) { delete n[k.pallet]; return n; }
    if (n[k.pallet]) return n;
    const left = Math.max(0, r3(remaining - Object.values(n).reduce((t, x) => t + (Number(x.qty) || 0), 0)));
    const q = r3(Math.min(k.available, left));
    if (q <= 1e-9) return n;
    n[k.pallet] = { qty: String(q), manual: FREE, korber: k };
    return n;
  });
  // Invoice + Item match (a lot with no ZCOMENT rolls): tick several Korber rolls of the invoice + item for the lot
  const toggleInv = (m: NoBarcodeRoll, o: NbOption) => setSel((s) => {
    const n = { ...s };
    if (n[o.pallet]?.nb === m) { delete n[o.pallet]; return n; }
    if (n[o.pallet] || o.available <= 1e-9) return n;
    const left = r3(remaining - Object.values(n).reduce((t, x) => t + (Number(x.qty) || 0), 0));
    n[o.pallet] = { qty: String(r3(left > 1e-9 ? Math.min(o.available, left) : o.available)), manual: m, korber: o, nb: m };
    return n;
  });
  // Qty only counts for a lot without Shade Report (otherwise Korber's Actual Qty is simply the roll's QTY)
  const nbMiss = (o: NbOption, m?: NoBarcodeRoll) => (['lot', 'hu', 'qty'] as const).filter((k) => o.checks[k] === false && (k !== 'qty' || !!m?.noShade));
  // what is already chosen by hand for one shade-report roll (several Korber rolls can make up one roll / lot QTY)
  const chosenFor = (m: ManualRoll) => manualSel.filter(([, x]) => x.manual === m);
  const rollLeft = (m: ManualRoll) => (Number(m.roll_qty) > 0 ? Math.max(0, r3(Number(m.roll_qty) - chosenFor(m).reduce((t, [, x]) => t + (Number(x.qty) || 0), 0))) : Infinity);
  // Use adds the Korber roll (the chooser stays open for more); Use on a chosen one takes it out again
  const useKorber = (m: ManualRoll, k: KorberRow) => {
    if (c?.rolls.some((r) => r.pallet === k.pallet)) { if (!sel[k.pallet]) toggle(c.rolls.find((r) => r.pallet === k.pallet)!); return; }
    if (sel[k.pallet]?.manual === m) { setSel((x) => { const n = { ...x }; delete n[k.pallet]; return n; }); return; }
    const q = r3(Math.min(k.available, manualLeft, rollLeft(m)));
    if (q <= 1e-9) return;
    setSel((x) => ({ ...x, [k.pallet]: { qty: String(q), manual: m, korber: k } }));
  };
  // rolls the user has to look at before picking: a check that did not pass, or chosen by hand
  const flagged = c ? [
    ...c.rolls.filter((r) => sel[r.pallet] && r.needsConfirm).map((r) => ({ pallet: r.pallet, why: `${r.supplier_hu ?? ''} ${r.warnings.join('; ')}`.trim() })),
    ...manualSel.map(([pallet, x]) => ({ pallet, why: x.manual!.free ? `manual pallet for the shortage${x.korber && normItem(x.korber.item) !== normItem(line.item) ? ` — item ${x.korber.item} ≠ ${line.item}` : ''}` : `chosen by hand for roll ${x.manual!.roll_no || '?'}` })),
    ...nbSel.filter(([, x]) => x.nb?.invChoice).map(([pallet, x]) => ({ pallet, why: `Invoice + Item match for lot ${x.nb!.lot}: Lot Number ${(x.korber as NbOption).lot ?? '–'} ≠ ${x.nb!.vendor_batch ?? '–'}${(x.korber as NbOption).checks.po === false ? ', Po not the same' : ''}` })),
    ...nbSel.filter(([, x]) => !x.nb?.invChoice && x.korber && nbMiss(x.korber as NbOption, x.nb).length).map(([pallet, x]) => ({ pallet, why: `no barcode, roll ${x.nb!.roll_no || '?'}: ${nbMiss(x.korber as NbOption, x.nb).map((k) => ({ lot: 'Lot', hu: 'Supplier Hu', qty: 'Qty' })[k]).join(', ')} not the same` })),
  ] : [];
  const overByFullRoll = lastOn && lastMode === 'full';
  const offsiteOver = kind === 'offsite' && diff > 0.0005;
  const needOverOk = kind === 'normal' && diff > 0.0005 && remaining > 0 && !overByFullRoll;
  const isShort = diff < -0.0005 && nSel > 0;
  const blocked = !nSel || offsiteOver || (flagged.length > 0 && !checkedOk) || (needOverOk && !overOk) || Object.values(sel).some((x) => !(Number(x.qty) > 0));

  // a roll whose Korber Lot Number is not one of this SO line's ZINSR lots: a warning — picked once the user confirms
  const [lotWarn, setLotWarn] = useState('');
  const [lotOk, setLotOk] = useState(false);
  useEffect(() => { setLotWarn(''); setLotOk(false); }, [sel]);
  const save = async () => {
    if (!c) return;
    setBusy(true); setErr('');
    try {
      const r = await api<{ label: string; qty: number; rolls: number; day: string }>('/api/pick', { method: 'POST', body: {
        week, key: line.key, date: line.date, pickNo: pickNo.trim() || null, kind,
        overConfirmed: kind === 'normal' && diff > 0.0005 ? (overByFullRoll || overOk) : false,
        closeShort: kind === 'normal' && isShort && closeShort,
        rolls: Object.entries(sel).map(([pallet, x]) => ({ pallet, qty: Number(x.qty), confirmed: checkedOk, ...(x.manual ? { manual: { ...x.manual, options: undefined, suggest: undefined } } : {}), ...(x.nb ? { nobarcode: true } : {}) })),
        ...(lotOk ? { lotConfirmed: true } : {}),
      } });
      onDone(`${kind === 'offsite' ? 'Offsite' : 'Normal'} ${r.label} pick of ${r.day}: ${r.rolls} roll${r.rolls === 1 ? '' : 's'}, ${fmt(r.qty, 2)} — ${line.so} / ${line.li}`);
    } catch (e) {
      const m = e instanceof Error ? e.message : 'Pick failed.';
      // a ZINSR lot difference (Korber Lot ≠ the line's lots, or more than a lot gives): a warning the user can confirm
      if ((/is not a ZINSR lot \/ Vendor Batch/.test(m) || /more than the lot/.test(m)) && /pick anyway/.test(m) && !lotOk) { setLotWarn(m.replace(/ — tick .*$/, '.').replace(/ Tick “I checked — pick anyway” to pick it\.$/, '')); setErr(''); }
      else setErr(m);
    } finally { setBusy(false); }
  };

  const open = c ? c.rolls.filter((r) => r.available > 1e-9) : [];
  const gone = c ? c.rolls.filter((r) => r.available <= 1e-9) : [];
  // the smart suggestion for the QTY to pick: searched once when the rolls load (not on every click)
  const lotCaps = useMemo(() => new Map((c?.lots || []).filter((l) => (l.cap ?? l.need) != null).map((l) => [String(l.lot), Number(l.cap ?? l.need)])), [c]);
  const smart = useMemo(() => (c ? smartSuggest(c.rolls, { need: Math.max(0, r3(c.need - c.picked)), lotCaps, batchNeed: c.batchNeed?.length ? new Map(c.batchNeed.map((b) => [b.batch, b.need])) : undefined }) : null), [c, lotCaps]);
  const useSmart = (x: Suggestion) => {
    const keep = Object.fromEntries([...manualSel, ...nbSel]);
    const n: Sel = { ...keep };
    for (const p of x.picks) n[p.pallet] = { qty: String(p.qty) };
    const cut = x.picks.find((p) => p.cut);
    const cr = cut ? c?.rolls.find((r) => r.pallet === cut.pallet) : undefined;
    setSel(n); setLast(cut && cr ? { pallet: cut.pallet, hu: cr.supplier_hu, full: r3(cr.available), cut: cut.qty } : null); setLastMode('cut'); setOverOk(false); setCloseShort(false);
  };
  return (
    <div className="modal-back">{/* the pick window closes only with ✕ / Cancel — a click outside it does not lose the selection */}
      <div className="modal xwide pkm" role="dialog" aria-modal="true" aria-labelledby="pk-title">
        <div className="modal-head">
          <div>
            <h2 id="pk-title">Pick {line.so} / {line.li}</h2>
            <p className="sub" style={{ margin: 0 }}>Item {line.item} · {fmtDate(line.date)} · {line.plant || '–'}</p>
            {line.hold && <div className="notice bad" style={{ marginTop: 6 }}><b>On hold</b> — {line.hold}{line.hold_by ? ` (${line.hold_by})` : ''}. Release the hold on Pick &amp; Dispatch before picking.</div>}
          </div>
          <div className="pk-kind" role="radiogroup" aria-label="Pick type">
            <button type="button" role="radio" aria-checked={kind === 'normal'} className={kind === 'normal' ? 'on' : ''} onClick={() => setKind('normal')}>
              <b>Normal</b><span>Full roll or a little less allowed</span>
            </button>
            {rules.allowOffsite && <button type="button" role="radio" aria-checked={kind === 'offsite'} className={kind === 'offsite' ? 'on' : ''} onClick={() => setKind('offsite')}>
              <b>Offsite</b><span>Exact QTY only</span>
            </button>}
          </div>
          <button type="button" className="btn sm" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="pk-stats">
          <div><span>Plan QTY</span><b>{fmtQty(line.qty)}</b>{c?.ur !== undefined && <small title="UR = Total stock − SO QI − SO Blocked stock − Assigned Qty (ZMMBE)">UR {fmtQty(c.ur)}{c.sent != null && c.sent > 1e-9 ? ` · sent ${fmtQty(c.sent)}` : c.planQty !== undefined && c.planQty > c.ur + 1e-9 ? ' → UR is picked' : ''}</small>}</div>
          <div><span>Already picked</span><b>{c ? fmtQty(c.picked) : '…'}</b></div>
          <div className="em"><span>To pick</span><b>{c ? fmtQty(remaining) : '…'}</b></div>
          <div><span>Selected</span><b>{fmt(total, 2)}</b><small>{nSel} roll{nSel === 1 ? '' : 's'}</small></div>
          <div className={!c ? '' : Math.abs(diff) <= 0.0005 ? 'ok' : diff > 0 ? 'warn' : 'short'}>
            <span>{!c ? 'Status' : Math.abs(diff) <= 0.0005 ? 'Status' : diff > 0 ? 'Over plan' : closeShort && kind === 'normal' ? 'Short (line closed)' : 'Still to pick'}</span>
            <b>{!c ? '…' : Math.abs(diff) <= 0.0005 ? 'Exact ✓' : fmt(Math.abs(diff), 2)}</b>
          </div>
        </div>

        {!c && !err && <><Loader label="Matching ZMMBE → ZINR → ZCOMENT → Korber…" /><Skeleton rows={6} title={false} /></>}
        {c && (
          <>
            <div className="pk-chain">
              {c.lots.map((l) => (
                <span key={l.lot} className={`pk-lot ${l.qty_ok ? '' : 'warn'}`} title={`Batch ${l.batch}${l.sloc ? ' · St Loc ' + l.sloc : ''}${l.invoice ? ' · invoice ' + l.invoice : ''}`}>
                  Lot <b>{l.lot}</b>{l.vendor_batch ? <> ({l.vendor_batch})</> : null} · batch {l.batch} · {fmtQty(l.qty)} {l.qty_ok ? '= UR ✓' : `≠ UR ${fmtQty(l.ur)}`}{Number(l.picked) > 0 ? <> · <span title="ZINSR QTY of this SO line less what it already took from this lot">{fmtQty(Number(l.picked))} picked, {fmtQty(Number(l.cap ?? 0))} left</span></> : null} · {l.direct ? `${l.direct} Korber roll${l.direct === 1 ? '' : 's'} (ZINR → Korber)` : l.noShade ? 'no Shade Report' : `${l.rolls} roll${l.rolls === 1 ? '' : 's'}${l.via ? ' (by batch)' : ''}`}
                </span>
              ))}
              {!c.lots.length && <span className="pk-lot warn">No ZINR lot matched</span>}
              {c.steps.length > 0 && <button type="button" className="linkish" onClick={() => setShowNotes((v) => !v)}>{showNotes ? 'Hide' : 'Show'} {c.steps.length} note{c.steps.length === 1 ? '' : 's'}</button>}
            </div>
            {showNotes && <div className="notice warn" style={{ fontSize: 12.5 }}>{c.steps.map((s, i) => <div key={i}>{s}</div>)}</div>}
            {c.gate?.on && !c.gate.loaded && <div className="notice bad">No ZROLLMGT uploaded for this Pick — upload it on the Data tab (or the Pick card). Only rolls at StorageBin {c.gate.bin} can be picked.</div>}

            <div className="pk-sec">
              <div className="pk-sec-head">
                <h3>Matched rolls <span className="pill ok">{open.length}</span>{gone.length > 0 && <span className="muted small"> · {gone.length} already picked</span>}</h3>
                {c.gate?.on ? <span className="muted small">Only rolls in ZROLLMGT at StorageBin <b>{c.gate.bin}</b> whose System Batch is this line&apos;s ZMMBE batch: ZMMBE batch + ZINSR (Sales Order, Line Item, Material, Batch = this line) → ZROLLMGT System Batch → Barcode Number = Korber Pallet, or the ZCOMENT VIEW Barcode Number (of this line&apos;s ZMMBE batch) = Korber Pallet = ZROLLMGT Barcode Number. A roll with no ZCOMENT barcode is matched on Invoice, Item, Lot (Po, Supplier Hu) and its Korber Pallet must be in ZROLLMGT at {c.gate.bin}. QTY = Korber Actual Qty.</span> :
                <span className="muted small">Barcode = Pallet (or Supplier Hu = Vendor Roll No) with Lot, Invoice and Po (ZCOMENT), or straight from ZINR: Item, Lot Number, Invoice and Po — a Supplier Hu that is this lot's Vendor Roll No makes it this line's roll. QTY = Korber Actual Qty. The system selects them for the plan QTY — rolls of a PO shared by several SO lines you tick yourself.</span>}
                <span style={{ flex: 1 }} />
                {open.length > 0 && <button type="button" className="btn sm" onClick={() => applyAuto(c, Object.fromEntries([...manualSel, ...nbSel]))}>Auto select</button>}
                {open.some((r) => r.pool) && <button type="button" className="btn sm primary" title="The Lot Number is shared by several SO lines: select the suggested rolls (their Actual Qty adds up to this line's lot QTY) — check them" onClick={() => applyAuto(c, Object.fromEntries([...manualSel, ...nbSel]), true)}>{open.some((r) => r.suggested) ? `Select suggested rolls (${open.filter((r) => r.suggested && r.available > 1e-9).length})` : 'Select shared-lot rolls too'}</button>}
                {nSel > 0 && <button type="button" className="btn sm" onClick={() => { setSel({}); setLast(null); }}>Clear</button>}
                <button type="button" className="btn sm" disabled={short <= 1e-9} onClick={() => setFreeOpen(true)} title={short <= 1e-9 ? 'No shortage: the selected rolls cover the QTY to pick' : `Add a Korber pallet by hand for the shortage of ${fmtQty(short)}`}>+ Manual pallet{short > 1e-9 ? ` (${fmtQty(short)} short)` : ''}</button>
              </div>
              {smart?.best && open.length > 1 && <SmartPanel smart={smart} rolls={c.rolls} sel={sel} lotCaps={lotCaps} onUse={useSmart} />}
              {!c.rolls.length ? <p className="muted">No Korber roll matched on Barcode for this line.{c.nobarcode?.some((m) => m.invChoice) ? ' Choose rolls under “Invoice + Item match” below.' : c.nobarcode?.length ? ' Rolls without a barcode: choose them under “No Barcode” below.' : c.manual?.length ? ' See “Not matched” below.' : ' Check that ZINR, ZCOMENT VIEW and Korber are uploaded and current.'}</p> : (
                <div className="table-wrap" style={{ maxHeight: 360 }}>
                  <table className="mini pk-table">
                    <thead><tr><th /><th>Supplier HU</th><th>Pallet</th><th>Location</th><th title="Korber Fifo Date — oldest first">FIFO</th><th>Shade</th><th className="n">Available</th><th className="n">Pick qty</th><th>Match</th></tr></thead>
                    <tbody>{(() => { const best = new Set((smart?.best?.picks || []).map((p) => p.pallet).filter((p) => !sel[p])); return [...[...open].sort((a, b) => Number(!!b.suggested) - Number(!!a.suggested) || byFit(a, b)), ...gone].map((r) => {
                      const s = sel[r.pallet], isGone = r.available <= 1e-9, isLast = lastOn && last!.pallet === r.pallet;
                      return (
                        <tr key={r.pallet} className={`${s ? 'picked' : ''} ${isGone ? 'gone' : ''}`} onClick={(e) => { if (!isGone && (e.target as HTMLElement).tagName !== 'INPUT') toggle(r); }}>
                          <td><input type="checkbox" disabled={isGone} checked={!!s} onChange={() => toggle(r)} aria-label={`Pick ${r.pallet}`} /></td>
                          <td><b>{r.supplier_hu}</b></td>
                          <td className="mono">{r.pallet}{r.borrowed && <span className="pill info" style={{ marginLeft: 4 }} title={r.qtyNote || ''}>barcode from same roll</span>}{r.via && <span className="pill accent" style={{ marginLeft: 4 }} title={r.byHu ? `ZCOMENT Barcode Number ${r.barcode} is not a Korber pallet — found by Supplier Hu ${r.supplier_hu} = Vendor Roll No, with the same Lot, Invoice and Po` : `ZCOMENT Barcode Number ${r.barcode} — the same roll number in Korber under pallet ${r.via}`}>{r.byHu ? `roll no ${r.supplier_hu} · barcode ${r.barcode}` : `barcode ${r.barcode}`}</span>}
                            {r.picks.length > 0 && <div className="pk-prev">{isGone ? 'Picked in full' : `Cut roll · ${fmtQty(r.available)} left of ${fmtQty(r.base_qty)}`} — {r.picks.map(pickNote).join(' | ')}</div>}<SapFitLine f={r.sap} best={best.has(r.pallet)} /></td><td>{r.location}</td><td className="small">{fifoText(r.fifo)}</td><td><b>{r.shade}</b></td>
                          <td className="n">{isGone ? <span className="pill mute" title={r.picks.map(pickNote).join('\n')}>picked</span>
                            : <>{fmtQty(r.available)}{r.picked_before > 0 && <span className="pill accent" style={{ marginLeft: 4 }} title={`Cut before: ${r.picks.map(pickNote).join(' | ')}`}>balance</span>}</>}</td>
                          <td className="n">{s ? <span className="pk-qty">
                            {isLast && <span className={`pill ${lastMode === 'full' ? 'warn' : 'accent'}`}>{lastMode === 'full' ? 'full roll' : 'cut'}</span>}
                            <input className="as-search" type="number" step="0.001" min="0.001" max={r.available} value={s.qty} onClick={(e) => e.stopPropagation()}
                              onChange={(e) => setSel((x) => ({ ...x, [r.pallet]: { ...x[r.pallet], qty: e.target.value } }))} aria-label="Pick qty" />
                          </span> : ''}</td>
                          <td>{r.needsConfirm ? <span className="pill warn" title={`${r.warnings.join('\n')}\n\n${checkText(r.checks)}`}>Check: {r.warnings[0]}</span>
                            : r.pool ? <span className={`pill ${r.suggested ? 'ok' : 'info'}`} title={r.qtyNote || ''}>{r.suggested ? 'Suggested · ' : ''}Lot shared by {r.pool} SO lines — tick</span>
                            : r.zroll && !r.barcode ? <span className="pill ok" title={r.qtyNote || ''}>ZROLLMGT batch ✓ (ZMMBE + ZINSR SO / LI / Batch = System Batch)</span>
                            : r.direct ? <span className="pill ok" title={r.qtyNote || ''}>ZINR → Korber ✓ (Item, Lot, Invoice, Po{r.checks.hu ? ', Roll no' : ''})</span>
                            : <span className="pill ok" title={`${checkText(r.checks)}${r.qtyNote ? `\n\n${r.qtyNote}` : ''}`}>All match ✓{r.korberQty ? ' · Korber qty' : r.qtyNote ? ' · split roll' : ''}</span>}</td>
                        </tr>
                      );
                    }); })()}</tbody>
                  </table>
                </div>
              )}
            </div>

            {!!c.blocked?.length && (
              <details className="pk-sec pk-blocked">
                <summary><h3 style={{ display: 'inline' }}>Not pickable <span className="pill bad">{c.blocked.length}</span></h3> <span className="muted small">rolls of this line that fail the ZROLLMGT check — click to see why</span></summary>
                <div className="table-wrap" style={{ maxHeight: 260 }}>
                  <table className="mini">
                    <thead><tr><th>Lot</th><th>Batch</th><th>Roll</th><th>Barcode</th><th>Pallet</th><th>Shade</th><th className="n">QTY</th><th>Why</th></tr></thead>
                    <tbody>{c.blocked.map((b, i) => (
                      <tr key={i}><td>{b.lot}</td><td>{b.batch}</td><td>{b.roll_no || '–'}</td><td className="mono">{b.barcode || '–'}</td><td className="mono">{b.pallet || '–'}</td><td>{b.shade || '–'}</td>
                        <td className="n">{b.qty != null ? fmtQty(b.qty) : '–'}</td><td><span className="pill bad">{b.why}</span></td></tr>
                    ))}</tbody>
                  </table>
                </div>
              </details>
            )}

            {lastOn && last && (() => { const sp = c.rolls.find((r) => r.pallet === last.pallet)?.sameSoPlant; return sp ? (
              <div className="notice ok so-plant">
                <b>SO Plant same ({sp.plant})</b> — {sp.lines.length ? <>the rest of this roll is for {sp.lines.join(', ')}, with the same SO Plant</> : <>the rest of this roll stays on this SO line</>}: no need to cut it.{kind === 'normal' ? ' The full roll is proposed.' : ' (Offsite pick: exact QTY only.)'}
              </div>) : null; })()}
            {lastOn && last && (kind === 'offsite' ? (
              <div className="pk-last">
                <div>
                  <b>Last roll {last.hu || ''}</b> <span className="mono">{last.pallet}</span>
                  <div className="muted small">Offsite pick: the roll is cut to {fmtQty(last.cut)} of {fmtQty(last.full)} so the QTY is exactly the plan. A full roll or a short pick is not allowed.</div>
                </div>
                <span className="pill accent">Cut to {fmtQty(last.cut)}</span>
              </div>
            ) : (
              <div className={`pk-last ${lastSmall ? 'small-over' : ''}`}>
                <div>
                  <b>Last roll {last.hu || ''}</b> <span className="mono">{last.pallet}</span>
                  <div className="muted small">The plan needs {fmtQty(last.cut)} more; this roll has {fmtQty(last.full)}. Choose how to send it.</div>
                </div>
                <div className="pk-choice" role="radiogroup" aria-label="Last roll">
                  <button type="button" role="radio" aria-checked={lastMode === 'cut'} className={lastMode === 'cut' ? 'on' : ''} onClick={() => setLastTo('cut')}>
                    <b>Cut the roll</b><span>Pick {fmtQty(last.cut)} · exact plan QTY</span>
                  </button>
                  {rules.allowNormalFull && <button type="button" role="radio" aria-checked={lastMode === 'full'} className={lastMode === 'full' ? 'on' : ''} onClick={() => setLastTo('full')}>
                    <b>Send full roll{lastSmall || c.rolls.find((r) => r.pallet === last.pallet)?.sameSoPlant ? ' (recommended)' : ''}</b><span>Pick {fmtQty(last.full)} · +{fmt(last.full - last.cut, 2)} over plan — I confirm</span>
                  </button>}
                  {rules.allowNormalShort && <button type="button" role="radio" aria-checked={lastMode === 'leave'} className={lastMode === 'leave' ? 'on' : ''} onClick={() => setLastTo('leave')}>
                    <b>Leave this roll</b><span>Send {fmt(last.cut, 2)} less · line closed short — I confirm</span>
                  </button>}
                </div>
              </div>
            ))}

            {(c.nobarcode || []).filter((m) => m.invChoice).map((m, gi) => {
              const mine = nbSel.filter(([, x]) => x.nb === m);
              const tot = r3(mine.reduce((t, [, x]) => t + (Number(x.qty) || 0), 0));
              return (
                <div key={`inv${gi}`} className="nb-pick inv-pick">
                  <h3>Invoice + Item match <span className="pill info">{m.options.length}</span> <span className="muted small">lot {m.lot} · batch {m.batch} · Lot Number {m.vendor_batch || '–'} · invoice {m.invoice || '–'}{m.po ? ` · Po ${m.po}` : ''} · lot QTY {fmtQty(m.roll_qty)}{mine.length ? ` · ${mine.length} ticked = ${fmtQty(tot)}` : ''}</span></h3>
                  <p className="sub" style={{ margin: '0 0 6px' }}>This inspection lot has no rolls in ZCOMENT VIEW. Korber rolls of the <b>same Invoice + Item</b> with <b>another Lot Number</b>{m.po ? <> — <b>Po</b> matches first</> : ''}{''} (in ZROLLMGT at the bin, not another roll&apos;s barcode). Tick the rolls to pick for this lot; each needs “I checked” because its Lot Number differs.</p>
                  <div className="table-wrap pk-tbl" style={{ maxHeight: 280 }}><table className="mini">
                    <thead><tr><th /><th>Pallet</th><th>Korber Lot Number</th><th>Supplier HU</th><th>Location</th><th title="Korber Fifo Date — oldest first">FIFO</th><th>Po</th><th className="n">Available</th><th className="n">Pick qty</th></tr></thead>
                    <tbody>{(() => { const best = smartBest(m.options.filter((o) => !sel[o.pallet]).map((o) => ({ ...o, shade: o.sap?.shade ?? null })), Math.max(0, r3(Number(m.roll_qty) - mine.reduce((t, [, x]) => t + (Number(x.qty) || 0), 0)))); return [...m.options].sort(byFit).map((o) => {
                      const s0 = sel[o.pallet], mineSel = s0?.nb === m, other = !!s0 && !mineSel, gone = o.available <= 1e-9;
                      return (
                        <tr key={o.pallet} className={`${mineSel ? 'picked' : ''} ${gone ? 'gone' : ''}`} onClick={(e) => { if (!gone && !other && (e.target as HTMLElement).tagName !== 'INPUT') toggleInv(m, o); }}>
                          <td><input type="checkbox" checked={mineSel} disabled={gone || other} onChange={() => toggleInv(m, o)} aria-label={`Pick ${o.pallet}`} /></td>
                          <td className="mono">{o.pallet}{o.picked_before > 0 && <div className="pk-prev">{gone ? 'Picked in full' : `Cut roll · ${fmtQty(o.available)} left`} — {(o.picks || []).map(pickNote).join(' | ')}</div>}<SapFitLine f={o.sap} best={best.has(o.pallet)} /></td>
                          <td>{o.lot ?? '–'}</td><td>{o.supplier_hu ?? '–'}</td><td>{o.location ?? ''}</td><td className="small">{fifoText(o.fifo)}</td>
                          <td>{o.checks.po === null ? '–' : <span className={`pill ${o.checks.po ? 'ok' : 'warn'}`}>{o.checks.po ? '✓ Po' : '✗ Po'}</span>}</td>
                          <td className="n">{gone ? <span className="pill mute">picked</span> : other ? <span className="pill mute">chosen elsewhere</span> : fmtQty(o.available)}</td>
                          <td className="n">{mineSel ? <input className="as-search" type="number" step="0.001" min="0.001" max={o.available} style={{ width: 92 }} value={s0.qty} onClick={(e) => e.stopPropagation()}
                            onChange={(e) => setSel((x) => ({ ...x, [o.pallet]: { ...x[o.pallet], qty: e.target.value } }))} aria-label="Pick qty" /> : ''}</td>
                        </tr>
                      );
                    }); })()}</tbody>
                  </table></div>
                </div>
              );
            })}

            {(c.nobarcode || []).some((m) => !m.invChoice) && (
              <div className="nb-pick">
                <h3>No Barcode — choose the roll <span className="pill info">{c.nobarcode!.filter((m) => !m.invChoice).length}</span>{nbSel.length > 0 && <span className="muted small"> · {nbSel.length} chosen</span>}</h3>
                <p className="sub" style={{ margin: '0 0 6px' }}>These Shade Report rolls have no Barcode Number in ZCOMENT. Listed: Korber rolls of the same item with <b>Supplier Hu = Vendor Roll No</b> (only <b>Lot Number = Vendor Batch</b> when there is no roll no), Invoice and Po not different, and not the barcode of another roll. Choose the right one — a roll whose Lot or Qty differs needs “I checked”. An inspection lot with <b>no Shade Report</b> in ZCOMENT is listed here too: its Korber rolls with the same Lot Number, the one whose Actual Qty is the lot QTY first.</p>
                <div className="table-wrap pk-tbl"><table className="mini">
                  <thead><tr><th>Vendor Roll No</th><th>Vendor Batch</th><th>Batch</th><th>Shade</th><th className="n">Roll / lot qty</th><th>Korber roll</th><th className="n">Pick qty</th></tr></thead>
                  <tbody>{c.nobarcode!.filter((m) => !m.invChoice).map((m, i) => {
                    const chosen = nbSel.find(([, x]) => x.nb === m);
                    const co = chosen?.[1].korber as NbOption | undefined;
                    const takenElsewhere = (p: string) => !!sel[p] && sel[p].nb !== m;
                    return (
                      <tr key={i} className={chosen ? 'picked' : ''}>
                        <td>{m.zcBarcode ? <><b>{m.roll_no || '–'}</b> <span className="pill warn" title={`ZCOMENT Barcode Number ${m.zcBarcode} is not a Korber pallet — rolls with the same Supplier Hu = Vendor Roll No and Lot are listed`}>barcode {m.zcBarcode} not in Korber</span></> : m.lotChoice ? <span className="pill warn" title={`No Korber roll has Lot Number ${m.vendor_batch ?? '–'} on this invoice: choose a roll of the invoice's other lots (Pick by Lot Number)`}>Pick by Lot Number · lot {m.lot}</span> : m.noShade ? <span className="pill warn" title={`Inspection lot ${m.lot} has no Shade Report rolls in ZCOMENT VIEW. Rolls with Lot Number = ${m.vendor_batch ?? '–'} and Actual Qty = the lot QTY come first.`}>no Shade Report · lot {m.lot}</span> : <b>{m.roll_no || '–'}</b>}</td><td>{m.vendor_batch || '–'}</td><td className="mono">{m.batch}</td><td><b>{m.shade}</b></td><td className="n">{fmtQty(m.roll_qty)}</td>
                        <td>{m.done ? <span className="pill mute">picked · {m.options[0]?.pallet}</span> : <>
                          <select className="as-search nb-select" value={chosen?.[0] ?? ''} onChange={(e) => chooseNb(m, e.target.value)} aria-label={`Korber roll for ${m.roll_no || 'roll'}`}>
                            <option value="">— choose a Korber roll ({m.options.length} match{m.options.length === 1 ? '' : 'es'}) —</option>
                            {[...m.options].sort(byFit).map((o) => {
                              const miss = nbMiss(o, m);
                              const ok = (['lot', 'hu', 'invoice', 'po', 'qty'] as const).filter((k) => o.checks[k]).map((k) => ({ lot: 'Lot', hu: 'HU', invoice: 'Inv', po: 'Po', qty: 'Qty' })[k]);
                              return <option key={o.pallet} value={o.pallet} disabled={o.available <= 1e-9 || takenElsewhere(o.pallet)}>
                                {o.sap ? `${o.sap.miss.length ? '' : '★ '}✓${o.sap.hits.length}${o.sap.miss.length ? ` ✗${o.sap.miss.length}` : ''} · ` : ''}{o.pallet} · FIFO {fifoText(o.fifo)} · Lot {o.lot ?? '–'} · HU {o.supplier_hu ?? '–'} · {fmtQty(o.available)}{o.picked_before > 0 ? ` left (picked ${(o.picks || []).map((p) => `${p.qty} · ${p.plan || p.day}`).join(', ')})` : ''} · {o.location ?? ''} · {o.available <= 1e-9 ? 'picked' : takenElsewhere(o.pallet) ? 'chosen for another roll' : `✓ ${ok.join(' ')}${miss.length ? ` · ✗ ${miss.map((k) => ({ lot: 'Lot', hu: 'HU', qty: 'Qty' })[k]).join(' ')}` : ''}`}
                              </option>;
                            })}
                          </select>
                          {m.options.some((o) => o.picked_before > 0) && <div className="pk-prev">Part picked before as {m.options[0].pallet} — its balance only: {(m.options[0].picks || []).map(pickNote).join(' | ')}</div>}
                          {co && <SapFitLine f={co.sap} />}
                          {co && <div className="nb-checks">{(['lot', 'hu', 'invoice', 'po', 'qty'] as const).map((k) => co.checks[k] === null ? null : <span key={k} className={`pill ${co.checks[k] ? 'ok' : 'warn'}`}>{co.checks[k] ? '✓' : '✗'} {({ lot: 'Lot', hu: 'Supplier Hu', invoice: 'Invoice', po: 'Po', qty: `Qty ${fmtQty(co.qty)}` })[k]}</span>)}</div>}
                        </>}</td>
                        <td className="n">{chosen ? <input className="as-search" type="number" step="0.001" min="0.001" max={co?.available} style={{ width: 92 }} value={chosen[1].qty}
                          onChange={(e) => setSel((x) => ({ ...x, [chosen[0]]: { ...x[chosen[0]], qty: e.target.value } }))} aria-label="Pick qty" /> : ''}</td>
                      </tr>
                    );
                  })}</tbody>
                </table></div>
              </div>
            )}

            {(c.manual?.length ?? 0) > 0 && shortfall > 1e-9 && (
              <div className="manual-pick">
                <h3>Not matched — pick by hand <span className="pill warn">{c.manual!.length}</span></h3>
                <p className="sub" style={{ margin: '0 0 6px' }}>The matched rolls leave <b>{fmtQty(shortfall)}</b>{manualTotal > 0 && manualLeft > 1e-9 ? <> (<b>{fmtQty(manualLeft)}</b> still open)</> : ''}. Only this balance can be picked by hand: choose a Korber roll (search or scan pallet, lot or supplier HU).</p>
                <div className="table-wrap pk-tbl"><table className="mini">
                  <thead><tr><th>Roll</th><th>ZCOMENT barcode</th><th>Shade</th><th className="n">Roll qty</th><th>Why it did not match</th><th>Korber roll</th><th className="n">Pick qty</th></tr></thead>
                  <tbody>{c.manual!.map((m, i) => {
                    const chosenAll = chosenFor(m), chosen = chosenAll[0];
                    return (
                      <tr key={i} className={chosen ? 'picked' : ''}>
                        <td><b>{m.roll_no || '–'}</b></td><td className="mono">{m.barcode || <span className="muted">none</span>}</td><td><b>{m.shade}</b></td><td className="n">{fmtQty(m.roll_qty)}</td>
                        <td className="muted small why" title={m.reason}><span>{m.reason}</span></td>
                        <td>
                          {chosenAll.map(([pal]) => <div key={pal} className="mono man-chosen">{pal} <button className="btn sm" onClick={() => setSel((x) => { const n = { ...x }; delete n[pal]; return n; })} aria-label={`Remove ${pal}`}>✕</button></div>)}
                          {(!chosen || (manualLeft > 1e-9 && rollLeft(m) > 1e-9)) && <button className="btn sm" disabled={manualLeft <= 1e-9} title={manualLeft <= 1e-9 ? 'The balance is already covered' : undefined} onClick={() => setChoosing(m)}>{chosen ? '+ Add Korber roll…' : 'Choose Korber roll…'}</button>}
                          {chosenAll.length > 1 && <div className="muted small">{chosenAll.length} rolls · {fmtQty(chosenAll.reduce((t, [, x]) => t + (Number(x.qty) || 0), 0))}</div>}
                        </td>
                        <td className="n">{chosenAll.map(([pal, x]) => <div key={pal} className="man-chosen"><input className="as-search" type="number" step="0.001" min="0.001" max={Math.min(x.korber?.available ?? Infinity, r3(shortfall - manualTotal + (Number(x.qty) || 0)))} style={{ width: 92 }} value={x.qty}
                          onChange={(e) => setSel((y) => ({ ...y, [pal]: { ...y[pal], qty: e.target.value } }))} aria-label={`Pick qty ${pal}`} /></div>)}</td>
                      </tr>
                    );
                  })}</tbody>
                </table></div>
              </div>
            )}
            {(c.manual?.length ?? 0) > 0 && shortfall <= 1e-9 && (
              <p className="muted small" style={{ margin: 0 }}>{c.manual!.length} shade-report roll{c.manual!.length === 1 ? ' does' : 's do'} not match a Korber roll, but the matched rolls cover the line — nothing to pick by hand.</p>
            )}
            {choosing && <KorberChooser item={line.item} rid={lineScope(week, line.plant)} batches={(c?.stock || []).filter((z) => Number(z.ur) > 0).map((z) => String(z.batch))} lineKey={line.key} roll={choosing} taken={Object.keys(sel).filter((p) => sel[p].manual !== choosing)} mine={chosenFor(choosing).map(([p]) => p)}
              chosenQty={chosenFor(choosing).reduce((t, [, x]) => t + (Number(x.qty) || 0), 0)} open={manualLeft} rollOpen={rollLeft(choosing)} onUse={(k) => useKorber(choosing, k)} onClose={() => setChoosing(null)} />}

            {(freeOpen || freeSel.length > 0) && (
              <div className="manual-pick free-pick">
                <h3>Manual pallets <span className="pill warn">{freeSel.length}</span> <span className="muted small">{short > 1e-9 ? `${fmtQty(short)} still short` : 'shortage covered'}</span></h3>
                <p className="sub" style={{ margin: '0 0 6px' }}>For a <b>shortage</b> of this pick: scan or type a Korber pallet and add it. Only up to the QTY still short; the pallet must be in this Pick&apos;s Korber Inventory (Pick Id 0, not picked in full, in ZROLLMGT at the bin). Each manual pallet needs “I checked”.</p>
                {freeSel.length > 0 && <div className="table-wrap pk-tbl"><table className="mini">
                  <thead><tr><th>Pallet</th><th>Item</th><th>Lot</th><th>Supplier HU</th><th>Location</th><th className="n">Available</th><th className="n">Pick qty</th><th /></tr></thead>
                  <tbody>{freeSel.map(([pal, x]) => (
                    <tr key={pal} className="picked">
                      <td className="mono">{pal}</td><td>{x.korber?.item}{x.korber && normItem(x.korber.item) !== normItem(line.item) && <span className="pill warn" style={{ marginLeft: 4 }}>other item</span>}</td><td>{x.korber?.lot}</td><td>{x.korber?.supplier_hu}</td><td>{x.korber?.location}</td>
                      <td className="n">{fmtQty(x.korber?.available ?? 0)}</td>
                      <td className="n"><input className="as-search" type="number" step="0.001" min="0.001" max={Math.min(x.korber?.available ?? Infinity, r3(short + (Number(x.qty) || 0)))} style={{ width: 92 }} value={x.qty}
                        onChange={(e) => setSel((y) => ({ ...y, [pal]: { ...y[pal], qty: e.target.value } }))} aria-label={`Pick qty ${pal}`} /></td>
                      <td><button className="btn sm" onClick={() => setSel((y) => { const n = { ...y }; delete n[pal]; return n; })} aria-label={`Remove ${pal}`}>✕</button></td>
                    </tr>
                  ))}</tbody>
                </table></div>}
                {freeOpen ? <KorberChooser item={line.item} rid={lineScope(week, line.plant)} batches={(c?.stock || []).filter((z) => Number(z.ur) > 0).map((z) => String(z.batch))} lineKey={line.key} roll={FREE} title="Manual pallet for the shortage" taken={Object.keys(sel).filter((p) => sel[p].manual !== FREE)} mine={freeSel.map(([p]) => p)}
                  chosenQty={freeSel.reduce((t, [, x]) => t + (Number(x.qty) || 0), 0)} open={short} onUse={useFree} onClose={() => setFreeOpen(false)} />
                  : short > 1e-9 && <button className="btn sm" onClick={() => setFreeOpen(true)}>+ Add another pallet</button>}
              </div>
            )}

            {offsiteOver && <div className="notice bad">Offsite pick: the selected QTY is {fmt(diff, 2)} over the plan balance. Cut the last roll to the exact QTY or untick a roll.</div>}
            {kind === 'normal' && rules.allowNormalShort && isShort && !(lastOn && lastMode === 'leave') && (
              <div className="pk-confirm soft">
                <label><input type="checkbox" checked={closeShort} onChange={(e) => setCloseShort(e.target.checked)} />
                  <span><b>Close the line {fmt(-diff, 2)} short</b><small>Tick to treat the line as complete with this pick (no cut, nothing more to pick). Leave unticked to pick the rest later.</small></span>
                </label>
              </div>
            )}
            {(flagged.length > 0 || needOverOk) && (
              <div className="pk-confirm">
                {flagged.length > 0 && (
                  <label><input type="checkbox" checked={checkedOk} onChange={(e) => setCheckedOk(e.target.checked)} />
                    <span><b>I checked {flagged.length === 1 ? 'this roll' : `these ${flagged.length} rolls`}</b>{flagged.map((f) => <small key={f.pallet}><span className="mono">{f.pallet}</span> — {f.why}</small>)}</span>
                  </label>
                )}
                {needOverOk && (
                  <label><input type="checkbox" checked={overOk} onChange={(e) => setOverOk(e.target.checked)} />
                    <span><b>Send {fmt(diff, 2)} over the plan balance</b><small>The selected QTY is more than the {fmtQty(remaining)} still to pick.</small></span>
                  </label>
                )}
              </div>
            )}
          </>
        )}
        {err && <div className="notice bad">{err}</div>}
        {lotWarn && (
          <div className="notice warn" role="alert">
            <b>Check:</b> {lotWarn}
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 }}>
              <input type="checkbox" checked={lotOk} onChange={(e) => setLotOk(e.target.checked)} />
              <span><b>I checked — pick anyway.</b> The roll&apos;s batch is still this line&apos;s ZMMBE batch; the ZINSR lot difference is saved on the pick.</span>
            </label>
          </div>
        )}
        <div className="modal-foot">
          <label className="pk-no">HJ Pick No <input className="as-search" value={pickNo} onChange={(e) => setPickNo(e.target.value)} placeholder="e.g. 21204655" style={{ width: 130 }} /></label>
          <span style={{ flex: 1 }} />
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" aria-busy={!!busy || undefined} disabled={busy || blocked} onClick={save}
            title={blocked && nSel ? (flagged.length && !checkedOk ? 'Tick “I checked” first' : needOverOk && !overOk ? 'Confirm the over-plan QTY first' : '') : undefined}>
            {busy ? 'Saving…' : `${kind === 'offsite' ? 'Offsite' : 'Normal'} pick · ${nSel} roll${nSel === 1 ? '' : 's'} · ${fmt(total, 2)}`}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Search the uploaded Korber rolls of the line's item (or scan a pallet) and pick one for a manual roll. */
/**
 * Korber rolls for a shade-report roll that was not matched. Several can be used (one roll / lot QTY made up of
 * several pallets): Use adds one and the list stays open; a used one shows Remove.
 */
function KorberChooser({ item, rid, batches, lineKey, roll, title, taken, mine = [], chosenQty = 0, open = Infinity, rollOpen = Infinity, onUse, onClose }: { item: string; rid?: string; /** the SO line's ZMMBE batches with UR: a roll of another batch is not offered */ batches?: string[]; /** the SO line (SO|LI|Item): each roll's SAP fit */ lineKey?: string; roll: ManualRoll; title?: string; taken: string[]; mine?: string[]; chosenQty?: number; open?: number; rollOpen?: number; onUse: (k: KorberRow) => void; onClose: () => void }) {
  const full = open <= 1e-9 || rollOpen <= 1e-9;
  const first = roll.vendor_batch || '';
  const [q, setQ] = useState(first);
  const [rows, setRows] = useState<KorberRow[] | null>(null);
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => {
      const get = (qq: string) => api<{ rows: KorberRow[] }>(`/api/pick/korber?item=${encodeURIComponent(item)}&q=${encodeURIComponent(qq)}${rid ? '&rid=' + encodeURIComponent(rid) : ''}${batches?.length ? '&batches=' + encodeURIComponent(batches.join(',')) : ''}${lineKey ? '&key=' + encodeURIComponent(lineKey) : ''}`).then((r) => r.rows);
      const ok = (k: KorberRow) => !k.blocked && k.available > 1e-9;
      // usable rolls first; the roll's own vendor batch has none → every roll of the item
      // pickable first, then FIFO: the oldest Korber Fifo Date on top, the newest at the bottom
      const sort = (rs: KorberRow[]) => [...rs].sort((a, b) => Number(ok(b)) - Number(ok(a)) || (b.sap?.score ?? 0) - (a.sap?.score ?? 0) || fifoKey(a).localeCompare(fifoKey(b)));
      void (async () => {
        try {
          let rs = await get(q.trim());
          let w = false;
          if (q.trim() && q === first && !rs.some(ok)) { const all = await get(''); if (all.some(ok)) { rs = all; w = true; } }
          setWide(w); setRows(sort(rs));
        } catch { setRows([]); }
      })();
    }, 250);
    return () => clearTimeout(t);
  }, [item, q, rid, first, batches?.join(','), lineKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // the rolls to suggest for what is still open (best SAP fit first, then FIFO)
  const bestC = useMemo(() => smartBest((rows || []).filter((k) => !mine.includes(k.pallet) && !taken.includes(k.pallet)).map((k) => ({ ...k, shade: k.sap?.shade ?? null })), Math.min(open, rollOpen)), [rows, mine, taken, open, rollOpen]);
  return (
    <div className="kchooser">
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <b>{title || `Korber rolls for ${roll.roll_no || 'roll'}`}</b><span className="muted small">item {item}{roll.free ? ' · scan or type any pallet' : ` · vendor batch ${roll.vendor_batch} · roll qty ${fmtQty(roll.roll_qty)}`}</span>
        <span className={`pill ${full ? 'ok' : 'accent'}`}>{mine.length} chosen · {fmtQty(chosenQty)}{Number(roll.roll_qty) > 0 ? ` of ${fmtQty(roll.roll_qty)}` : ''}{full ? ' · covered' : Number.isFinite(Math.min(open, rollOpen)) ? ` · ${fmtQty(Math.min(open, rollOpen))} open` : ''}</span>
        <input autoFocus className="as-search" placeholder="Scan / type pallet, lot or supplier HU" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: '1 1 240px' }} aria-label="Search Korber" />
        <button className="btn sm primary" onClick={onClose}>{mine.length ? 'Done' : 'Close'}</button>
      </div>
      {wide && rows && <div className="notice warn small" style={{ marginTop: 6 }}>No pickable Korber roll on vendor batch {first} — showing every roll of item {item} ({rows.filter((k) => !k.blocked && k.available > 1e-9).length} pickable). Check the lot / shade before you use one.</div>}
      <div className="table-wrap" style={{ maxHeight: 300, marginTop: 6 }}>
        {rows === null ? <Loader label="Searching Korber…" /> : !rows.length ? <p className="muted">No Korber roll found{q ? ` for “${q}”` : ''}.</p> : (
          <table className="mini">
            <thead><tr><th>Pallet</th><th>Item</th><th>Location</th><th title="Korber Fifo Date — oldest first">FIFO</th><th>Lot</th><th>Supplier HU</th><th>Invoice</th><th>Pick Id</th><th className="n">Actual qty</th><th className="n">Available</th><th /></tr></thead>
            <tbody>{rows.map((k) => {
              const used = taken.includes(k.pallet), gone = k.available <= 1e-9, isMine = mine.includes(k.pallet);
              return (
                <tr key={k.pallet} className={`${gone ? 'gone' : ''} ${isMine ? 'picked' : ''}`}>
                  <td className="mono">{k.pallet}<SapFitLine f={k.sap} best={bestC.has(k.pallet)} /></td><td>{k.item}</td><td>{k.location}</td><td className="small">{fifoText(k.fifo)}</td><td>{k.lot}</td><td>{k.supplier_hu}</td><td className="mono small">{k.invoice}</td><td className={String(k.pick_id ?? '0') !== '0' ? 'kb-short' : 'muted'}>{k.pick_id ?? '0'}</td><td className="n">{fmtQty(k.qty)}</td>
                  <td className="n">{k.blocked ? <span className="pill bad" title={k.blocked}>{k.blocked.startsWith('Rejected') ? 'rejected' : k.blocked.startsWith('Korber Pick Id') ? 'WMS pick' : k.blocked}</span> : gone ? <span className="pill mute">picked</span> : fmtQty(k.available)}
                    {!k.blocked && Number(k.reserved) > 0 && <div className="muted small" title="ZROLLMGT Reserved Quantity: only the Available Quantity can be picked">{fmtQty(Number(k.reserved))} reserved</div>}
                    {(k.picks?.length ?? 0) > 0 && <div className="pk-prev">{gone ? 'Picked in full' : 'Cut roll — balance only'}: {k.picks!.map(pickNote).join(' | ')}</div>}</td>
                  <td>{isMine ? <button className="btn sm" onClick={() => onUse(k)}>Remove</button>
                    : <button className="btn sm primary" disabled={gone || used || full || !!k.blocked} title={used ? 'Already chosen for another roll' : full ? 'The QTY is covered — remove one to choose another' : ''} onClick={() => onUse(k)}>{used ? 'Selected' : 'Use'}</button>}</td>
                </tr>
              );
            })}</tbody>
          </table>
        )}
      </div>
    </div>
  );
}

/** The day chosen in the pick history: kept when the card reloads after a change (cancel, tally, …). */
let histDay = '';
function PickHistoryCard({ canEdit, toast, onChanged }: { canEdit: boolean; toast: (m: string) => void; onChanged: () => void }) {
  const [day, setDay0] = useState(histDay || today());
  const setDay = (d: string) => { histDay = d; setDay0(d); };
  const [h, setH] = useState<PickHistory | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  // the history is everyone's: who picked what, so nobody picks a roll twice. "Mine" narrows it.
  const me = getSession()?.user.username || '';
  const boss = isBossRole(getSession()?.user.role);
  const [mine, setMine] = useState(false);
  const load = useCallback(() => { api<PickHistory>('/api/pick/history?day=' + day + (mine && me ? '&user=' + encodeURIComponent(me) : '')).then(setH).catch(() => {}); }, [day, mine, me]);
  useEffect(() => { load(); }, [load]);
  // the Picks of the day (day plan rounds): the history and the Packing List of one Pick
  const [pickId, setPickId] = useState('');
  useEffect(() => { setPickId(''); }, [day]);
  const pickIds = Array.from(new Set((h?.requests || []).map((r) => r.week).filter((w) => /~\d+$|^\d{4}-W\d{2}$/.test(w || ''))));
  // plant names (Settings → Plants) for the Pick No list
  const [plantNames, setPlantNames] = useState<Record<string, string>>({});
  useEffect(() => { api<{ plants: { code: string; name: string | null }[] }>('/api/plants').then((r) => setPlantNames(Object.fromEntries(r.plants.map((x) => [x.code.toUpperCase(), x.name || x.code])))).catch(() => {}); }, []);
  const pickName = (w: string) => { const m = /^\d{4}-\d{2}-\d{2}~([^~]*)~(\d+)$/.exec(w); return m ? `${w.slice(8, 10)}-${w.slice(5, 7)} · ${m[1] === '-' ? 'No plant' : plantNames[m[1]] || m[1]} · Pick ${m[2]}` : /^\d{4}-W\d{2}$/.test(w) ? `Week plan ${w}` : w; };
  const shownReqs = (h?.requests || []).filter((r) => !pickId || r.week === pickId);
  const live = shownReqs.filter((r) => !r.cancelled_at);
  // the picks marked for the download (none marked = all of the day)
  const [sel, setSel] = useState<Set<number>>(new Set());
  useEffect(() => { setSel(new Set()); }, [day, mine, pickId]);
  const marked = live.filter((r) => sel.has(r.id));
  const allOn = live.length > 0 && marked.length === live.length;
  const flip = (id: number) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const [oneSheet, setOneSheet] = useState(() => { try { return localStorage.getItem('pl_one_sheet') !== '0'; } catch { return true; } });
  const setOne = (v: boolean) => { setOneSheet(v); try { localStorage.setItem('pl_one_sheet', v ? '1' : '0'); } catch { /* */ } };
  const tag = marked.length ? `_${marked.length}picks` : '';
  // PFC storage locations (Settings) — those rolls go on the PFC sheet, the rest on KFC
  const [pfcSlocs, setPfcSlocs] = useState<string[]>(['41', 'COMF']);
  useEffect(() => { api<{ settings: { pfcSlocs?: string[] } }>('/api/settings').then((r) => { if (r.settings.pfcSlocs?.length) setPfcSlocs(r.settings.pfcSlocs); }).catch(() => {}); }, []);
  // none marked = every pick shown (the chosen Pick, or the whole day)
  const target = marked.length ? marked : live;
  const target0 = target;
  // the Packing List tallies the cut roll balances first (can be turned off)
  const [autoTally, setAutoTally0] = useState(() => { try { return localStorage.getItem('pl_auto_tally') !== '0'; } catch { return true; } });
  const setAutoTally = (v: boolean) => { setAutoTally0(v); try { localStorage.setItem('pl_auto_tally', v ? '1' : '0'); } catch { /* */ } };
  const ptag = pickId ? '_' + pickName(pickId).replace(/[^\w]+/g, '_') : '';
  const [plBusy, setPlBusy] = useState(false);
  const downloadPL = async () => {
    setPlBusy(true);
    try {
      // cut roll balances first: each one goes to another SO line it can go to (same Material and LI, UR in ZMMBE, a ZINSR
      // lot with the roll's Vendor Batch) as a pick of that line — then the Packing List is made with them
      let hh = h!, target = target0, tallied = 0, tallyQty = 0;
      const tallyFail: string[] = [];
      if (canEdit && autoTally && target.length) {
        setPlProg('tallying cut rolls');
        try {
          const t = await api<{ rolls: { pallet: string; from: number; targets: { so: string; li: string; item: string; take: number }[] }[] }>('/api/pick/tally?ids=' + target.map((r) => r.id).join(','));
          const newIds: number[] = [];
          for (const x of t.rolls) for (const y of x.targets) {
            if (!(y.take > 0)) continue;
            try { const r = await api<{ id: number }>('/api/pick/tally', { method: 'POST', body: { pallet: x.pallet, so: y.so, li: y.li, item: y.item, qty: y.take, from: x.from } }); newIds.push(r.id); tallied++; tallyQty = r3(tallyQty + y.take); }
            catch (e) { tallyFail.push(`${x.pallet} → ${y.so} / ${y.li}: ${e instanceof Error ? e.message : 'failed'}`); }
          }
          if (newIds.length) {
            hh = await api<PickHistory>('/api/pick/history?day=' + day + (mine && me ? '&user=' + encodeURIComponent(me) : ''));
            setH(hh);
            const want = new Set([...target.map((r) => r.id), ...newIds]);
            target = hh.requests.filter((r) => !r.cancelled_at && want.has(r.id));
            if (marked.length) setSel(new Set(target.map((r) => r.id)));
          }
        } catch (e) { tallyFail.push(e instanceof Error ? e.message : 'Could not read the cut rolls.'); }
        setPlProg('');
      }
      // the plan (dashboard table) of the Picks in the download
      const weeks = Array.from(new Set(target.map((r) => r.week).filter(Boolean)));
      const days = Array.from(new Set(weeks.map((w) => /^(\d{4}-\d{2}-\d{2})~/.exec(w)?.[1]).filter(Boolean))) as string[];
      let plan: LineP[] = [];
      // each plan read once, all at the same time (the same plan is used for the Plan sheet and for the Not Picked lines)
      const planCache = new Map<string, Promise<LineP[] | null>>();
      const readPlan = (u: string) => { let p = planCache.get(u); if (!p) { p = api<{ rows: LineP[] }>(u).then((r) => r.rows).catch(() => null); planCache.set(u, p); } return p; };
      for (const u of [...days.map((d) => `/api/pullplan?type=day&day=${d}`), ...weeks.filter((x) => /^\d{4}-W\d{2}$/.test(x)).map((w) => `/api/pullplan?week=${encodeURIComponent(w)}`)]) void readPlan(u);
      for (const d of days) { const rows = await readPlan(`/api/pullplan?type=day&day=${d}`); if (rows) plan.push(...rows); }
      plan = plan.filter((l) => weeks.includes(l.week));
      // a week plan: its lines that were picked (the line = SO / LI / Item key + its day)
      const lineIds = new Set(target.map((r) => r.line));
      for (const w of weeks.filter((x) => /^\d{4}-W\d{2}$/.test(x))) {
        const rows = await readPlan(`/api/pullplan?week=${encodeURIComponent(w)}`); if (rows) plan.push(...rows.filter((l) => lineIds.has(`${l.key}|${l.date ?? ''}`)));
      }
      // the lines the system did not pick (in full), and why: the day Picks' plan lines, and for a week plan its lines of
      // the same plants and plan dates as the picked lines
      const scope: LineP[] = plan.filter((l) => !/^\d{4}-W\d{2}$/.test(l.week));
      for (const w of weeks.filter((x) => /^\d{4}-W\d{2}$/.test(x))) {
        const picked = target.filter((r) => r.week === w);
        const dates = new Set(picked.map((r) => r.line.split('|')[3] || ''));
        const plants = new Set(picked.map((r) => String(r.plant || '').toUpperCase().replace(/\s+/g, '')));
        const rows = await readPlan(`/api/pullplan?week=${encodeURIComponent(w)}`); if (rows) scope.push(...rows.filter((l) => dates.has(l.date ?? '') && (!plants.size || plants.has(String(l.plant || '').toUpperCase().replace(/\s+/g, '')))));
      }
      const open = scope.filter((l) => !isDone(l) && !isDispatched(l) && need(l) > 1e-9);
      const notPicked: NotPicked[] = [];
      const seen = new Set<string>();
      let done = 0;
      const one = async (l: LineP) => {
        // no UR on the dashboard: nothing the system could pick — no need to read the rolls
        if (!l.hold && !(Number(l.ur) > 1e-9)) {
          const parts = [Number(l.qi) > 0 ? `QI ${r3(Number(l.qi))}` : '', Number(l.block) > 0 ? `Block ${r3(Number(l.block))}` : '', Number(l.assigned) > 0 ? `Assigned ${r3(Number(l.assigned))}` : ''].filter(Boolean);
          seen.add(`${l.key}|${l.date ?? ''}`); notPicked.push({ pick: pickName(l.week), so: l.so, li: l.li, item: l.item, plant: l.plant, date: l.date, planQty: Number(l.qty) || 0, ur: 0, picked: Number(l.picked ?? 0), balance: r3(need(l)), matched: null,
            reason: 'No UR in ZMMBE', detail: parts.length ? `ZMMBE has no Unrestricted stock: ${parts.join(' · ')}` : 'Not in ZMMBE (no stock for this SO / LI / Item)' });
          return;
        }
        let c: Candidates | null = null, err = '';
        try { c = await api<Candidates>(`/api/pick/candidates?week=${encodeURIComponent(l.week)}&key=${encodeURIComponent(l.key)}&date=${encodeURIComponent(l.date ?? '')}`); } catch (e) { err = e instanceof Error ? e.message : ''; }
        const left = c ? r3(c.need - c.picked) : need(l);
        // what the plan still wants (plan QTY less what was picked): more than the UR lets the system pick
        const planLeft = c ? r3(Number(c.planQty ?? l.qty) - c.picked) : need(l);
        let w = notPickedWhy(c, l, err), bal = left;
        if (c && !(left > 1e-9) && !l.hold) {
          if (!(planLeft > 1e-9)) return;
          const ur0 = Number(c.ur ?? 0);
          w = ur0 > 1e-9 ? { reason: 'Plan QTY more than UR', detail: `UR ${r3(ur0)} is picked; the plan wants ${r3(planLeft)} more — no stock left in ZMMBE UR` } : { reason: 'No UR in ZMMBE', detail: c.sent ? `Already sent ${r3(Number(c.sent))}; ZMMBE has no Unrestricted stock left in the warehouse` : 'ZMMBE has no Unrestricted stock for this SO / LI (QI, Block, Assigned or not in ZMMBE)' };
          bal = planLeft;
        }
        seen.add(`${l.key}|${l.date ?? ''}`); notPicked.push({ pick: pickName(l.week), so: l.so, li: l.li, item: l.item, plant: l.plant, date: l.date, planQty: Number(l.qty) || 0, ur: c ? Number(c.ur ?? 0) : null,
          picked: c ? r3(c.picked) : Number(l.picked ?? 0), balance: r3(Math.max(0, bal)), matched: c ? r3(c.matchedAvail ?? c.rolls.reduce((t, r) => t + Math.max(0, r.available), 0)) : null, reason: w.reason, detail: w.detail });
      };
      // a few lines at a time
      const queue = [...open];
      await Promise.all(Array.from({ length: Math.min(PL_PAR, queue.length) }, async () => { for (let l = queue.shift(); l; l = queue.shift()) { await one(l); done++; setPlProg(`${done} / ${open.length}`); } }));
      setPlProg('');
      // short picks: lines picked with less than their plan QTY (a pick closed short included) that are not listed yet
      for (const l of scope) {
        const id = `${l.key}|${l.date ?? ''}`;
        if (seen.has(id) || l.hold) continue;
        const planQty = Number(l.qty) || 0, picked = r3(Number(l.picked ?? 0));
        const short = r3(planQty - picked);
        if (!(picked > 1e-9) || !(short > 0.0005)) continue;
        // closed short: the plan line says so (any day), and the day's pick history says who
        const reqs = (hh.requests || []).filter((r) => r.line === id && !r.cancelled_at);
        const cs = Number((l as LineP & { closed_short?: number }).closed_short ?? 0);
        const closedReq = reqs.find((r) => Number(r.closed) > 0 || Number(r.short) > 0);
        const closed = cs > 1e-9 || closedReq ? { by_user: closedReq?.by_user ?? '', short: cs || Number(closedReq?.short ?? 0) } : null;
        seen.add(id);
        notPicked.push({ pick: pickName(l.week), so: l.so, li: l.li, item: l.item, plant: l.plant, date: l.date, planQty, ur: Number.isFinite(Number(l.ur)) ? Number(l.ur) : null,
          picked, balance: short, matched: null,
          reason: closed ? 'Picked short — closed' : 'Picked short',
          detail: `Picked ${fmtQty(picked)} of ${fmtQty(planQty)} — ${fmtQty(short)} short${closed ? ` · closed short${closed.by_user ? ` by ${closed.by_user}` : ''} (the rest is not picked later)` : ''}${Number(l.ur) > 0 && Number(l.ur) < planQty - 1e-9 ? ` · UR ${fmtQty(Number(l.ur))}` : ''}` });
      }
      notPicked.sort((a, b) => a.pick.localeCompare(b.pick) || a.reason.localeCompare(b.reason) || a.so.localeCompare(b.so) || Number(a.li) - Number(b.li) || String(a.item).localeCompare(String(b.item)) || String(a.date ?? '').localeCompare(String(b.date ?? '')));
      // the SAP and Korber data of every roll is checked first: problems are shown before the file is saved
      const issues: PLIssue[] = [];
      const wb = packingListWorkbook(hh, { ids: new Set(target.map((r) => r.id)), combined: oneSheet, pfcSlocs, plan, planTitle: `Plan · ${weeks.map(pickName).join(', ')}`, issues, notPicked, plantNames });
      const file = `Packing_List_${day}${ptag}${tag}.xlsx`;
      const tallyMsg = tallied ? ` · ${tallied} cut roll balance${tallied === 1 ? '' : 's'} tallied (${fmtQty(tallyQty)})` : '';
      if (tallyFail.length) toast(`Cut roll tally: ${tallyFail.length} not saved — ${tallyFail[0]}`);
      if (issues.length) { setPlCheck({ wb, file, issues }); if (tallied) toast(`${tallied} cut roll balance${tallied === 1 ? '' : 's'} tallied (${fmtQty(tallyQty)}) — on this Packing List`); }
      else { saveWorkbook(wb, file); toast(`Packing List checked ✓${tallyMsg} — ${target.length} pick${target.length === 1 ? '' : 's'}: SAP lines and Korber rows are right${notPicked.length ? ` · ${notPicked.length} line${notPicked.length === 1 ? '' : 's'} not picked (sheet “Not Picked”)` : ''}`); }
    } finally { setPlBusy(false); setPlProg(''); }
  };
  const [plProg, setPlProg] = useState('');
  const [tallyOpen, setTallyOpen] = useState(false);
  const [plCheck, setPlCheck] = useState<{ wb: ReturnType<typeof packingListWorkbook>; file: string; issues: PLIssue[] } | null>(null);
  const downloadKorber = () => saveWorkbook(korberWorkbook(h!, new Set(target.map((r) => r.id))), `Korber_Picked_${day}${ptag}${tag}.xlsx`);
  const markedQty = marked.reduce((t, r) => t + r.qty, 0);
  const cancel = async (path: string, what: string) => {
    if (!confirm(`Cancel ${what}? It is deleted from the pick history and the roll${path.includes('/req/') ? 's become' : ' becomes'} pickable again.`)) return;
    try { await api(path, { method: 'DELETE' }); toast(`${what} cancelled and deleted from the history`); load(); onChanged(); } catch (e) { toast(e instanceof Error ? e.message : 'Failed.'); }
  };
  // the marked picks this user may cancel (their own; Admin / Head: anyone's), cancelled together
  const cancelable = marked.filter((r) => boss || r.by_user === me);
  const [bulkBusy, setBulkBusy] = useState('');
  const cancelMarked = async () => {
    if (!cancelable.length) return;
    const others = marked.length - cancelable.length;
    if (!confirm(`Cancel ${cancelable.length} marked pick${cancelable.length === 1 ? '' : 's'} (${fmtQty(cancelable.reduce((t, r) => t + r.qty, 0))} QTY, ${cancelable.reduce((t, r) => t + r.rolls, 0)} rolls)?\n\nThey are deleted from the pick history and their rolls become pickable again.${others ? `\n${others} marked pick${others === 1 ? ' is' : 's are'} another user's and stay.` : ''}`)) return;
    let ok = 0; const fail: string[] = [];
    for (const r of cancelable) {
      setBulkBusy(`Cancelling ${ok + fail.length + 1} / ${cancelable.length}…`);
      try { await api(`/api/pick/req/${r.id}`, { method: 'DELETE' }); ok++; } catch (e) { fail.push(`${ordinal(r.seq)} ${r.so}/${r.li}: ${e instanceof Error ? e.message : 'failed'}`); }
    }
    setBulkBusy(''); setSel(new Set());
    toast(`${ok} pick${ok === 1 ? '' : 's'} cancelled${fail.length ? ` · ${fail.length} could not be cancelled — ${fail.slice(0, 2).join('; ')}` : ''}`);
    load(); onChanged();
  };
  // Reject: a problem with a picked roll — it goes to the rejected rolls (not picked again) and a replacement is assigned there
  const rejectRoll = async (id: number, pallet: string) => {
    const reason = window.prompt(`Reject roll ${pallet}: what is the problem? (e.g. Damaged, Wrong shade, Short length, Wrong item)`, '');
    if (reason === null) return;
    if (!reason.trim()) { toast('Give the reason to reject the roll.'); return; }
    try { await api('/api/pick/reject', { method: 'POST', body: { pickId: id, reason: reason.trim() } }); toast(`Roll ${pallet} rejected — assign a replacement under Rejected rolls`); load(); onChanged(); }
    catch (e) { toast(e instanceof Error ? e.message : 'Could not reject.'); }
  };
  const days = Array.from(new Set([today(), ...(h?.days || []).map((d) => d.day)])).sort().reverse();
  return (
    <section className="card" aria-labelledby="ph-title">
      <div className="sheet-top">
        <div>
          <h2 id="ph-title">Pick history &amp; Packing List</h2>
          <p className="sub" style={{ margin: 0 }}>Everyone&apos;s picks of the day. A fully picked roll can&apos;t be picked again by anyone; a part-picked roll keeps only its balance for the next pick. Cancel deletes a pick and frees its rolls — mark several picks to cancel them together.</p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <div className="seg" role="group" aria-label="Whose picks">
            <button className={!mine ? 'on' : ''} onClick={() => setMine(false)}>Everyone</button>
            <button className={mine ? 'on' : ''} onClick={() => setMine(true)}>Mine</button>
          </div>
          <select className="as-search" value={day} onChange={(e) => setDay(e.target.value)} aria-label="Day">
            {days.map((d) => { const x = h?.days.find((y) => y.day === d); return <option key={d} value={d}>{fmtDate(d)}{d === today() ? ' (today)' : ''}{x ? ` · ${x.open} pick${x.open === 1 ? '' : 's'}` : ''}</option>; })}
          </select>
          <select className="as-search" value={pickId} onChange={(e) => setPickId(e.target.value)} aria-label="Pick No">
            <option value="">All Picks{pickIds.length ? ` (${pickIds.length})` : ''}</option>
            {pickIds.map((w) => <option key={w} value={w}>{pickName(w)} · {(h?.requests || []).filter((r) => r.week === w && !r.cancelled_at).length} picks</option>)}
          </select>
        </div>
      </div>
      {h && live.length > 0 && (
        <div className="pl-bar" role="group" aria-label="Packing List download">
          <span className="pl-what">{marked.length
            ? <><b>{marked.length}</b> of {live.length} picks marked · {fmtQty(markedQty)} QTY · {marked.reduce((t, r) => t + r.rolls, 0)} rolls</>
            : <>No picks marked — the download has <b>all {live.length}</b> picks {pickId ? `of ${pickName(pickId)}` : 'of the day'}, with the Pick&apos;s plan. Tick picks below to choose.</>}</span>
          <div className="seg" role="group" aria-label="Packing List format" title="How the picks go into the Packing List">
            <button className={oneSheet ? 'on' : ''} onClick={() => setOne(true)}>One sheet</button>
            <button className={!oneSheet ? 'on' : ''} onClick={() => setOne(false)}>Sheet per pick</button>
          </div>
          {canEdit && <label className="small" style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }} title="When the Packing List is made, each cut roll's balance is first tallied to another SO line that can take it (same Material and LI, UR in ZMMBE, a ZINSR lot with the roll's Vendor Batch) and goes on the Packing List with that line's SAP details">
            <input type="checkbox" checked={autoTally} onChange={(e) => setAutoTally(e.target.checked)} /> Tally cut roll balances</label>}
          <button className="btn primary" disabled={plBusy} aria-busy={plBusy || undefined} onClick={downloadPL}>{plBusy ? `Preparing…${plProg ? (/^\d/.test(plProg) ? ` checking lines ${plProg}` : ` ${plProg}`) : ''}` : `Download Packing List${marked.length ? ` (${marked.length})` : ''}`}</button>
          <button className="btn" disabled={!h.korberHeader} onClick={downloadKorber} title="The picked rolls in the Korber Inventory format (cut rolls with the cut QTY)">Korber Inventory{marked.length ? ` (${marked.length})` : ''}</button>
          {canEdit && <button className="btn" onClick={() => setTallyOpen(true)} title="A cut roll's balance to another SO line of the same Material and LI (ZMMBE UR, ZINSR lot with the roll's Vendor Batch) — saved as a pick of that SO line, on the Packing List with its SAP details">✂ Tally cut rolls{marked.length ? ` (${marked.length})` : ''}</button>}
          {canEdit && marked.length > 0 && <button className="btn danger" disabled={!cancelable.length || !!bulkBusy} aria-busy={!!bulkBusy || undefined} onClick={cancelMarked}
            title={cancelable.length ? 'Cancel the marked picks: deleted from the history, their rolls become pickable again' : 'You can cancel only your own picks'}>{bulkBusy || `Cancel marked (${cancelable.length})`}</button>}
          {marked.length > 0 && <button className="btn sm" onClick={() => setSel(new Set())}>Clear marks</button>}
        </div>
      )}
      {tallyOpen && <TallyDialog ids={target.map((r) => r.id)} toast={toast} onClose={(changed) => { setTallyOpen(false); if (changed) { load(); onChanged(); } }} />}
      {plCheck && (() => {
        const errs = plCheck.issues.filter((i) => i.level === 'error'), warns = plCheck.issues.filter((i) => i.level === 'warn');
        const list = (xs: PLIssue[]) => (
          <div className="table-wrap plc-list" style={{ maxHeight: 260 }}><table className="mini">
            <thead><tr><th>Pallet</th><th>SO / LI</th><th>Item</th><th>Check</th></tr></thead>
            <tbody>{xs.slice(0, 200).map((i, k) => <tr key={k}><td className="mono">{i.pallet || '—'}</td><td>{i.so}{i.li ? ` / ${i.li}` : ''}</td><td>{i.item}</td><td>{i.what}</td></tr>)}</tbody>
          </table></div>);
        return (
          <div className="modal-back">
            <div className="modal wide" role="dialog" aria-modal="true" aria-labelledby="plc-title">
              <div className="modal-head"><h2 id="plc-title">Packing List check — {errs.length ? `${errs.length} error${errs.length === 1 ? '' : 's'}` : 'warnings only'}</h2>
                <button className="btn sm" aria-label="Close" onClick={() => setPlCheck(null)}>✕</button></div>
              <p className="muted" style={{ margin: 0 }}>Every roll was checked against its Korber row (pallet, item, lot, ASN, PO, location) and its SAP lines (ZMMBE batch, picked QTY, inspection lot, shade). The file also gets a <b>Checks</b> sheet with this list.</p>
              {errs.length > 0 && <><h3 className="plc-h err">Errors — wrong or missing data ({errs.length})</h3>{list(errs)}</>}
              {warns.length > 0 && <><h3 className="plc-h warn">Checks — empty fields to look at ({warns.length})</h3>{list(warns)}</>}
              <div className="modal-foot"><span style={{ flex: 1 }} />
                <button className="btn" onClick={() => setPlCheck(null)}>Cancel</button>
                <button className={`btn ${errs.length ? 'danger' : 'primary'}`} onClick={() => { saveWorkbook(plCheck.wb, plCheck.file); setPlCheck(null); }}>Download anyway</button></div>
            </div>
          </div>);
      })()}
      {!h ? <Loader label="Loading the pick history…" /> : !h.requests.length ? <p className="muted">No picks on {fmtDate(day)}.</p> : (
        <div className="table-wrap" style={{ maxHeight: 'none' }}>
          <table className="mini">
            <thead><tr><th className="ck"><input type="checkbox" checked={allOn} ref={(el) => { if (el) el.indeterminate = marked.length > 0 && !allOn; }} onChange={() => setSel(allOn ? new Set() : new Set(live.map((r) => r.id)))} aria-label="Mark all picks" /></th><th>Req</th><th>Type</th><th>SO / LI / Item</th><th>Plant</th><th className="n">Plan QTY</th><th className="n">Picked</th><th className="n">Rolls</th><th>HJ Pick No</th><th>By</th><th /></tr></thead>
            <tbody>{shownReqs.map((r) => {
              const rolls = h.picks.filter((p) => p.req_id === r.id);
              return [
                <tr key={r.id} className={`${r.cancelled_at ? 'gone' : ''} ${sel.has(r.id) ? 'marked' : ''}`} onClick={() => setOpen(open === r.id ? null : r.id)} style={{ cursor: 'pointer' }}>
                  <td className="ck" onClick={(e) => e.stopPropagation()}>{!r.cancelled_at && <input type="checkbox" checked={sel.has(r.id)} onChange={() => flip(r.id)} aria-label={`Mark ${ordinal(r.seq)} pick for the Packing List`} />}</td>
                  <td><b>{ordinal(r.seq)}</b></td>
                  <td><span className={`pill ${r.kind === 'offsite' ? 'accent' : 'mute'}`}>{r.kind === 'offsite' ? 'Offsite' : 'Normal'}</span></td>
                  <td>{r.so} / {r.li} / {r.item}</td><td>{r.plant}</td><td className="n">{fmtQty(r.need)}</td>
                  <td className="n"><b>{fmtQty(r.qty)}</b>{r.closed ? <span className="pill warn" style={{ marginLeft: 4 }} title="Line closed short">−{fmtQty(r.short ?? 0)}</span> : ''}</td><td className="n">{r.rolls}</td>
                  <td>{r.pick_no}</td><td className="muted">{r.by_user} · {ago(r.at)}</td>
                  <td>{canEdit && (boss || r.by_user === me) && <button className="btn sm" onClick={(e) => { e.stopPropagation(); cancel(`/api/pick/req/${r.id}`, `${ordinal(r.seq)} pick`); }}>Cancel</button>}</td>
                </tr>,
                open === r.id && (
                  <tr key={r.id + 'd'}><td colSpan={11} style={{ background: 'var(--panel-2)' }}>
                    <table className="mini">
                      <thead><tr><th>Pallet</th><th>Lot</th><th>Shade</th><th className="n">Roll qty</th><th className="n">Picked</th><th>Insp. lot</th><th>Note</th><th /></tr></thead>
                      <tbody>{rolls.map((p) => (
                        <tr key={p.id} className={p.cancelled_at ? 'gone' : ''}>
                          <td className="mono">{p.pallet}</td><td>{p.lot}</td><td>{p.shade}</td><td className="n">{fmtQty(p.roll_qty)}</td>
                          <td className="n">{fmtQty(p.qty)}{p.partial ? <span className="pill accent" style={{ marginLeft: 4 }}>cut</span> : ''}</td><td>{p.insp_lot}</td><td className="muted">{p.note}</td>
                          <td style={{ whiteSpace: 'nowrap' }}>{canEdit && (boss || r.by_user === me) && <>
                            <button className="btn sm danger" title="A problem with this roll: take it off the pick into Rejected rolls (it is not picked again) and assign another Korber roll" onClick={() => rejectRoll(p.id, p.pallet)}>Reject</button>{' '}
                            <button className="btn sm" onClick={() => cancel(`/api/pick/roll/${p.id}`, `roll ${p.pallet}`)}>Remove</button></>}</td>
                        </tr>
                      ))}</tbody>
                    </table>
                  </td></tr>
                ),
              ];
            })}</tbody>
          </table>
        </div>
      )}
    </section>
  );
}

interface Reject { id: number; day: string; week: string; plan: string; so: string; li: string; item: string; pallet: string; qty: number; lot: string | null; insp_lot: string | null; batch: string | null; shade: string | null; reason: string; by_user: string; at: string; replaced_by: string | null; replaced_qty: number | null; replaced_user: string | null; replaced_at: string | null }
/** Rolls rejected from a pick (a problem with them): assign a Korber roll of the same Material as the replacement, picked into the same pick. */
function RejectedRolls({ canEdit, toast, onChanged }: { canEdit: boolean; toast: (m: string) => void; onChanged: () => void }) {
  const [all, setAll] = useState(false);
  const [rows, setRows] = useState<Reject[] | null>(null);
  const [assign, setAssign] = useState<Reject | null>(null);
  const load = useCallback(() => { api<{ rejects: Reject[] }>('/api/pick/rejects' + (all ? '?all=1' : '')).then((r) => setRows(r.rejects)).catch(() => setRows([])); }, [all]);
  useEffect(() => { load(); }, [load]);
  const use = async (rj: Reject, k: KorberRow) => {
    try {
      const r = await api<{ qty: number }>('/api/pick/replace', { method: 'POST', body: { rejectId: rj.id, pallet: k.pallet, qty: Math.min(k.available, rj.qty) } });
      toast(`${k.pallet} (${fmtQty(r.qty)}) picked for ${rj.so} / ${rj.li} in place of ${rj.pallet}`); setAssign(null); load(); onChanged();
    } catch (e) { toast(e instanceof Error ? e.message : 'Could not assign.'); }
  };
  const open = (rows || []).filter((r) => !r.replaced_by).length;
  return (
    <section className="card" aria-labelledby="rj-title">
      <div className="sheet-top">
        <div>
          <h2 id="rj-title">Rejected rolls {open > 0 && <span className="pill bad" style={{ marginLeft: 6 }}>{open} to replace</span>}</h2>
          <p className="sub" style={{ margin: 0 }}>Rolls taken off a pick for a problem (Reject in the pick history). A rejected pallet is never picked again. Assign a Korber roll of the same Material: it is picked into the same pick (Pick Id 0, not picked before — only a cut roll&apos;s balance).</p>
        </div>
        <div className="seg" role="group"><button className={!all ? 'on' : ''} onClick={() => setAll(false)}>To replace</button><button className={all ? 'on' : ''} onClick={() => setAll(true)}>All</button></div>
      </div>
      {!rows ? <Loader label="Loading rejected rolls…" /> : !rows.length ? <p className="muted">{all ? 'No rolls were rejected.' : 'No rejected roll is waiting for a replacement.'}</p> : (
        <div className="table-wrap" style={{ maxHeight: 360 }}>
          <table className="mini">
            <thead><tr><th>Day</th><th>Plan</th><th>SO / LI</th><th>Material</th><th>Rejected pallet</th><th className="n">QTY</th><th>Lot</th><th>Reason</th><th>By</th><th>Replacement</th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.id}>
                <td>{fmtDate(r.day)}</td><td className="small">{r.plan}</td><td>{r.so} / {r.li}</td><td>{r.item}</td><td className="mono">{r.pallet}</td><td className="n">{fmtQty(r.qty)}</td><td>{r.lot}</td>
                <td><span className="pill bad">{r.reason}</span></td><td>{r.by_user}</td>
                <td>{r.replaced_by ? <span className="pill ok" title={`${r.replaced_user} · ${r.replaced_at ? new Date(r.replaced_at).toLocaleString() : ''}`}>{r.replaced_by} · {fmtQty(Number(r.replaced_qty))}</span>
                  : canEdit ? <button className="btn sm primary" onClick={() => setAssign(r)}>Assign Korber roll…</button> : '–'}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      {assign && <KorberChooser item={assign.item} rid={assign.week} roll={{ lot: assign.insp_lot || '', batch: assign.batch || '', material: assign.item, vendor_batch: assign.lot, roll_no: null, barcode: null, roll_qty: assign.qty, shade: assign.shade, invoice: null, reason: '', suggest: [] } as ManualRoll}
        taken={[]} onUse={(k) => use(assign, k)} onClose={() => setAssign(null)} />}
    </section>
  );
}

interface FoundPick { id: number; day: string; plan: string; so: string; li: string; item: string; pallet: string; qty: number; roll_qty: number; partial: number; shade: string | null; lot: string | null; insp_lot: string | null; batch: string | null; note: string | null; by_user: string; at: string; seq: number; pick_no: string | null; kind: string | null }
/**
 * A Packing List file back into the system: its rolls (and how much of each, for which SO line and SAP batch) are saved
 * as picks of this Pick. First a check — each SO line in the Pick's plan? each roll in Korber, already picked? — then Save.
 * A roll already saved for the same SO line with the same QTY is skipped, so the same file twice adds nothing.
 */
interface ImportItem extends PLPiece { skip: string | null; warn: string[]; move?: { plan: string; so: string; li: string; qty: number; by: string }[] }
interface ImportLine { key: string; so: string; li: string; item: string; qty: number; rolls: number; ok: boolean; why: string | null; extra?: boolean; planQty: number | null; items: ImportItem[] }
function ImportPLDialog({ week, label, toast, onClose }: { week: string; label: string; toast: (m: string) => void; onClose: (changed: boolean) => void }) {
  // where it goes: a new Pick of its own (default: the day and plant of the Pick on screen) or this Pick
  const cur = /^(\d{4}-\d{2}-\d{2})~([^~]*)~\d+$/.exec(week);
  const [mode, setMode] = useState<'new' | 'this'>('new');
  const [nDay, setNDay] = useState(cur?.[1] ?? new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10));
  const [nPlant, setNPlant] = useState(cur && cur[2] !== '-' ? cur[2] : '');
  const [plantList, setPlantList] = useState<{ code: string; name: string | null }[]>([]);
  useEffect(() => { api<{ plants: { code: string; name: string | null }[] }>('/api/plants').then((r) => setPlantList(r.plants)).catch(() => {}); }, []);
  const target = () => (mode === 'new' ? { newPick: { day: nDay, plant: nPlant } } : { week });
  const [file, setFile] = useState<File | null>(null);
  const [parsed, setParsed] = useState<{ pieces: PLPiece[]; tables: number; warnings: string[] } | null>(null);
  const [check, setCheck] = useState<ImportLine[] | null>(null);
  const [busy, setBusy] = useState(''); const [err, setErr] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const read = async (f: File) => {
    setFile(f); setParsed(null); setCheck(null); setErr(''); setBusy('Reading the file…');
    try {
      const p = parsePackingListFile(await f.arrayBuffer());
      setParsed(p);
      if (!p.pieces.length) { setErr('No Packing List table (Pallet … Actual Qty with its SAP lines SO | LI | Qty | Material | Batch) was found in this file.'); return; }
      setBusy('Checking against the system…');
      const r = await api<{ lines: ImportLine[] }>('/api/pick/import', { method: 'POST', body: { ...target(), fileName: f.name, dry: true, pieces: p.pieces } });
      setCheck(r.lines);
    } catch (e) { setErr(e instanceof Error ? e.message : 'Could not read the file.'); } finally { setBusy(''); }
  };
  const toSave = (check || []).filter((l) => l.ok).flatMap((l) => l.items.filter((x) => !x.skip));
  const save = async () => {
    if (!parsed || !file) return;
    setBusy('Saving…'); setErr('');
    try {
      // a few SO lines per request (a big Packing List in one go can be too much for one server call); the first one makes
      // the new Pick, the next ones go into it
      const keyOf = (x: PLPiece) => `${x.so}|${x.li}|${x.item}`;
      const keys = Array.from(new Set(parsed.pieces.map(keyOf)));
      const CH = 8;
      let tgt: Record<string, unknown> = target();
      const r = { picks: 0, rolls: 0, week: '', label: '' };
      for (let i = 0; i < keys.length; i += CH) {
        const part = new Set(keys.slice(i, i + CH));
        setBusy(`Saving… ${Math.min(i + CH, keys.length)} / ${keys.length} SO lines`);
        const x = await api<{ picks: number; rolls: number; week: string; label: string }>('/api/pick/import', { method: 'POST', body: { ...tgt, fileName: file.name, pieces: parsed.pieces.filter((p) => part.has(keyOf(p))) } });
        r.picks += x.picks; r.rolls += x.rolls; r.week = x.week; r.label = x.label;
        tgt = mode === 'new' ? { week: x.week, addPlan: true } : { week: x.week };
      }
      toast(`Packing List imported${mode === 'new' ? ` as a new Pick — ${r.label}` : ` into ${label}`}: ${r.picks} pick${r.picks === 1 ? '' : 's'}, ${r.rolls} roll${r.rolls === 1 ? '' : 's'}`);
      if (mode === 'new' && r.week) {
        // open the new Pick
        try { localStorage.setItem('mas-pick-type', 'day'); localStorage.setItem('mas-day', r.week.slice(0, 10)); localStorage.setItem('mas-rid', r.week); } catch { /* private mode */ }
        setTimeout(() => window.location.reload(), 900);
      }
      onClose(true);
    } catch (e) { const m = e instanceof Error ? e.message : 'Could not save.'; setErr(m); toast(`Packing List not saved: ${m}`); setBusy(''); }
  };
  const lines = check || [];
  const moveN = lines.reduce((t, l) => t + l.items.filter((x) => !x.skip && x.move?.length).length, 0);
  const bad = lines.filter((l) => !l.ok);
  const warnN = lines.reduce((t, l) => t + l.items.filter((x) => !x.skip && x.warn.length).length, 0);
  const skipN = lines.reduce((t, l) => t + l.items.filter((x) => x.skip).length, 0);
  return (
    <div className="modal-back">
      <div className="modal xwide" role="dialog" aria-modal="true" aria-labelledby="imp-title">
        <div className="modal-head">
          <div><h2 id="imp-title">Import Packing List</h2>
            <p className="sub" style={{ margin: 0 }}>A Packing List in this system&apos;s format (KFC / PFC Packing List sheets: the rolls of each table and its SAP lines <b>SO | LI | Qty | Material | Batch</b>). Each roll is saved as a pick of that SO line in this Pick, with that SAP batch; a cut roll&apos;s pieces come from the <b>Cut Roll Balance</b> sheet when the file has one. Rolls already saved the same way are skipped.</p></div>
          <button className="btn sm" aria-label="Close" onClick={() => onClose(false)}>✕</button>
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', margin: '4px 0 8px' }}>
          <div className="seg" role="group" aria-label="Import into">
            <button type="button" className={mode === 'new' ? 'on' : ''} onClick={() => { setMode('new'); setCheck(null); setParsed(null); setFile(null); }}>New Pick</button>
            <button type="button" className={mode === 'this' ? 'on' : ''} onClick={() => { setMode('this'); setCheck(null); setParsed(null); setFile(null); }}>Into {label}</button>
          </div>
          {mode === 'new' && <>
            <label className="small">Day <input type="date" className="as-search" value={nDay} onChange={(e) => { setNDay(e.target.value); setCheck(null); setParsed(null); setFile(null); }} /></label>
            <label className="small">Plant <select className="as-search" value={nPlant} onChange={(e) => { setNPlant(e.target.value); setCheck(null); setParsed(null); setFile(null); }}>
              <option value="">— choose —</option>
              {Array.from(new Set([...(nPlant ? [nPlant] : []), ...plantList.map((p) => p.code.toUpperCase())])).map((c) => { const p = plantList.find((x) => x.code.toUpperCase() === c); return <option key={c} value={c}>{p?.name ? `${p.name} (${c})` : c}</option>; })}
            </select></label>
            <span className="muted small">→ the next Pick No of that plant on that day; its plan = the file&apos;s SO lines</span>
          </>}
        </div>
        <label className={`btn ${mode === 'new' && (!nDay || !nPlant) ? 'disabled' : ''}`} style={{ alignSelf: 'flex-start', pointerEvents: mode === 'new' && (!nDay || !nPlant) ? 'none' : undefined, opacity: mode === 'new' && (!nDay || !nPlant) ? 0.5 : 1 }}>📂 {file ? file.name : 'Choose the Packing List file (.xlsx)'}
          <input type="file" accept=".xlsx,.xls" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files?.[0]; if (f) void read(f); e.target.value = ''; }} />
        </label>
        {busy && <Loader label={busy} />}
        {parsed && <p className="muted small">{parsed.tables} table{parsed.tables === 1 ? '' : 's'} · {parsed.pieces.length} roll piece{parsed.pieces.length === 1 ? '' : 's'} · {fmtQty(r3(parsed.pieces.reduce((t, x) => t + x.qty, 0)))}</p>}
        {parsed?.warnings.length ? <div className="notice warn"><b>In the file:</b> {parsed.warnings.slice(0, 6).join(' · ')}{parsed.warnings.length > 6 ? ` · +${parsed.warnings.length - 6} more` : ''}</div> : null}
        {check && (
          <>
            <div className="chips" style={{ margin: '6px 0' }}>
              <span className="pill ok">{toSave.length} roll{toSave.length === 1 ? '' : 's'} to save · {fmtQty(r3(toSave.reduce((t, x) => t + x.qty, 0)))}</span>
              {skipN > 0 && <span className="pill mute">{skipN} skipped</span>}
              {moveN > 0 && <span className="pill info" title="These rolls are picked in another Pick: on Save they are taken off there and saved here">{moveN} roll{moveN === 1 ? '' : 's'} move here from other Picks</span>}
              {warnN > 0 && <span className="pill warn">{warnN} with a check</span>}
              {bad.length > 0 && <span className="pill bad">{bad.length} SO line{bad.length === 1 ? '' : 's'} left out</span>}
              {lines.some((l) => l.extra) && <span className="pill warn" title="Not in this Pick's plan (e.g. a cut roll balance tallied to another SO) — saved as extra lines">{lines.filter((l) => l.extra).length} SO line{lines.filter((l) => l.extra).length === 1 ? '' : 's'} not in the plan (saved as extra)</span>}
            </div>
            <div className="table-wrap" style={{ maxHeight: 460 }}>
              <table className="mini">
                <thead><tr><th>SO / LI / Item</th><th className="n">Rolls</th><th className="n">QTY</th><th className="n">Plan QTY</th><th>Check</th></tr></thead>
                <tbody>{lines.map((l) => {
                  const sk = l.items.filter((x) => x.skip).length, wn = l.items.filter((x) => !x.skip && x.warn.length);
                  return [
                    <tr key={l.key} className={l.ok ? '' : 'gone'} style={{ cursor: 'pointer' }} onClick={() => setOpen(open === l.key ? null : l.key)}>
                      <td><b>{l.so} / {l.li}</b> · {l.item}</td><td className="n">{l.rolls}</td><td className="n">{fmtQty(l.qty)}</td><td className="n">{l.planQty == null ? '–' : fmtQty(l.planQty)}</td>
                      <td>{!l.ok ? <span className="pill bad">{l.why}</span> : <>{sk === l.items.length ? <span className="pill mute">all in the system</span> : <span className="pill ok">{l.items.length - sk} to save</span>}{sk > 0 && sk < l.items.length && <span className="pill mute" style={{ marginLeft: 4 }}>{sk} skipped</span>}{wn.length > 0 && <span className="pill warn" style={{ marginLeft: 4 }}>{wn.length} check</span>}{l.items.some((x) => !x.skip && x.move?.length) && <span className="pill info" style={{ marginLeft: 4 }}>{l.items.filter((x) => !x.skip && x.move?.length).length} move</span>}{l.extra && <span className="pill warn" style={{ marginLeft: 4 }} title={l.why ?? ''}>not in the plan</span>}</>} <span className="muted small">{open === l.key ? '▾' : '▸'}</span></td>
                    </tr>,
                    open === l.key && <tr key={l.key + '#'}><td colSpan={5}>
                      <table className="mini"><thead><tr><th>Pallet</th><th className="n">QTY</th><th>Batch</th><th>Shade</th><th /></tr></thead>
                        <tbody>{l.items.map((x, i) => <tr key={i}><td className="mono">{x.pallet}</td><td className="n">{fmtQty(x.qty)}</td><td>{x.batch}</td><td>{x.shade ?? ''}</td>
                          <td className="small">{x.skip ? <span className="muted">{x.skip}</span> : [...(x.move?.length ? [`moves here from ${Array.from(new Set(x.move.map((o) => `${o.plan} (${o.so} / ${o.li}, ${o.qty})`))).join(', ')}`] : []), ...x.warn].join(' · ')}</td></tr>)}</tbody></table>
                    </td></tr>,
                  ];
                })}</tbody>
              </table>
            </div>
          </>
        )}
        {err && <div className="notice bad">{err}</div>}
        <div className="modal-foot"><span style={{ flex: 1 }} />
          <button className="btn" onClick={() => onClose(false)}>Close</button>
          <button className="btn primary" disabled={!!busy || !toSave.length} aria-busy={busy.startsWith('Saving') || undefined} onClick={save}>{busy.startsWith('Saving') ? busy : `Save ${toSave.length} roll${toSave.length === 1 ? '' : 's'} as picks${moveN ? ` (${moveN} moved)` : ''}`}</button>
        </div>
      </div>
    </div>
  );
}

/**
 * Cut roll balance tally: each cut roll of the picks on screen, its balance, and the SO lines it can go to — another SO with
 * the same Material and LI number in ZMMBE (UR in the warehouse) whose ZINSR lot has the roll's Vendor Batch (the batch may
 * differ). The suggested QTYs fill the balance (the roll's own batch first); each saved one is a pick of that SO line, so it
 * is on the Packing List with that SO line's SAP details.
 */
interface TallyTarget { key: string; so: string; li: string; item: string; same?: boolean; plant: string | null; batch: string; sloc: string; sameBatch: boolean; ur: number; ur_free: number; lot_room: number; can: number; take: number; lots: { lot: string; batch: string; vendor_batch: string; qty: number }[] }
interface TallyRoll { pallet: string; from: number; so: string; li: string; item: string; so_plant?: string | null; plant_missing?: string | null; roll_qty: number; balance: number; lot: string | null; location: string | null; targets: TallyTarget[] }
function TallyDialog({ ids, toast, onClose }: { ids: number[]; toast: (m: string) => void; onClose: (changed: boolean) => void }) {
  const [rolls, setRolls] = useState<TallyRoll[] | null>(null);
  const [err, setErr] = useState('');
  const [qty, setQty] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(0);
  const load = useCallback(() => {
    setRolls(null);
    api<{ rolls: TallyRoll[] }>('/api/pick/tally?ids=' + ids.join(',')).then((r) => {
      setRolls([...r.rolls].sort((x, y) => Number(!x.targets.length) - Number(!y.targets.length)));
      const q: Record<string, string> = {};
      for (const x of r.rolls) for (const t of x.targets) if (t.take > 0) q[`${x.pallet}|${t.key}`] = String(t.take);
      setQty(q);
    }).catch((e) => setErr(e instanceof Error ? e.message : 'Could not read the cut rolls.'));
  }, [ids.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);
  const chosen = (rolls || []).flatMap((x) => x.targets.filter((t) => Number(qty[`${x.pallet}|${t.key}`]) > 0).map((t) => ({ x, t, q: r3(Number(qty[`${x.pallet}|${t.key}`])) })));
  const over = (rolls || []).filter((x) => r3(x.targets.reduce((s0, t) => s0 + (Number(qty[`${x.pallet}|${t.key}`]) || 0), 0)) > x.balance + 0.0005).map((x) => x.pallet);
  const save = async () => {
    setBusy(true); setErr('');
    let n = 0; const fails: string[] = [];
    for (const { x, t, q } of chosen) {
      try { await api('/api/pick/tally', { method: 'POST', body: { pallet: x.pallet, so: t.so, li: t.li, item: t.item, qty: q, from: x.from } }); n++; }
      catch (e) { fails.push(`${x.pallet} → ${t.so} / ${t.li}: ${e instanceof Error ? e.message : 'failed'}`); }
    }
    setBusy(false); setSaved((v) => v + n);
    if (n) toast(`${n} cut roll balance${n === 1 ? '' : 's'} tallied — on the Packing List with their SAP details`);
    if (fails.length) setErr(fails.join(' · ')); else onClose(true);
    if (fails.length) load();
  };
  return (
    <div className="modal-back">
      <div className="modal xwide" role="dialog" aria-modal="true" aria-labelledby="tally-title">
        <div className="modal-head">
          <div><h2 id="tally-title">Tally cut roll balances</h2>
            <p className="sub" style={{ margin: 0 }}>A cut roll&apos;s balance goes first to the <b>SO line it was cut for</b> when that line still has UR (the whole roll for that SO), else to another SO line whose <b>SO Plant</b> is the Pick plant&apos;s code (Settings → Plants &amp; target times): same <b>Material</b> and <b>LI</b> number, UR in <b>ZMMBE</b>, and a <b>ZINSR</b> lot whose <b>Vendor Batch</b> is the roll&apos;s Korber Lot Number (always the same — never another Vendor Batch). Only the SAP batch may differ. Each one is saved as a pick of that SO line and goes on the Packing List with its SAP details.</p></div>
          <button className="btn sm" aria-label="Close" onClick={() => onClose(saved > 0)}>✕</button>
        </div>
        {!rolls && !err && <Loader label="Finding the cut rolls and the SO lines they can go to…" />}
        {rolls && !rolls.length && <p className="muted">No cut roll with a balance in these picks.</p>}
        {rolls && rolls.length > 0 && (
          <div className="table-wrap" style={{ maxHeight: 520 }}>
            <table className="mini">
              <thead><tr><th>Cut roll</th><th>Cut for</th><th className="n">Balance</th><th>Can go to (SO / LI)</th><th>SAP batch · St Loc</th><th>ZINSR lot (Vendor Batch = roll lot)</th><th className="n">UR free</th><th className="n">Lot room</th><th className="n">Tally QTY</th></tr></thead>
              <tbody>{rolls.map((x) => (x.targets.length ? x.targets : [null]).map((t, i) => (
                <tr key={x.pallet + (t?.key ?? '')} className={over.includes(x.pallet) ? 'gone' : ''}>
                  {i === 0 && <><td rowSpan={Math.max(1, x.targets.length)} className="mono">{x.pallet}<div className="muted small">Lot {x.lot ?? '–'}{x.location ? ` · ${x.location}` : ''}</div></td>
                    <td rowSpan={Math.max(1, x.targets.length)}>{x.so} / {x.li}<div className="muted small">{x.item}{x.so_plant ? ` · SO Plant ${x.so_plant}` : ''}</div></td>
                    <td rowSpan={Math.max(1, x.targets.length)} className="n"><b>{fmtQty(x.balance)}</b><div className="muted small">of {fmtQty(x.roll_qty)}</div></td></>}
                  {t ? <>
                    <td><b>{t.so} / {t.li}</b>{t.plant ? <span className="muted small"> · {t.plant}</span> : null}{t.same && <span className="pill ok" style={{ marginLeft: 4 }} title="The SO line the roll was cut for: its own UR takes the balance first">same SO line</span>}</td>
                    <td>{t.batch} · {t.sloc}{!t.sameBatch && <span className="pill warn" style={{ marginLeft: 4 }} title="Only the SAP batch (ZMMBE) differs from the ZINSR lot's batch — the Vendor Batch is the same as the roll's Korber Lot Number">other SAP batch</span>}</td>
                    <td className="small">{t.lots.map((l) => `${l.lot} (${l.vendor_batch})`).join(', ')}</td>
                    <td className="n">{fmtQty(t.ur_free)}</td><td className="n">{fmtQty(t.lot_room)}</td>
                    <td className="n"><input className="as-search" type="number" min="0" step="0.001" max={Math.min(x.balance, t.can)} style={{ width: 100 }} value={qty[`${x.pallet}|${t.key}`] ?? ''} placeholder="0"
                      onChange={(e) => setQty((v) => ({ ...v, [`${x.pallet}|${t.key}`]: e.target.value }))} aria-label={`Tally QTY to ${t.so} / ${t.li}`} /></td>
                  </> : <td colSpan={6} className="muted">{x.plant_missing ? `The Pick's plant ${x.plant_missing} has no Plant code in Settings → Plants & target times — add it there (the SO Plant a balance goes to)` : `No SO line can take it (SO Plant ${x.so_plant ?? '–'}, same Material and LI, UR in ZMMBE, a ZINSR lot with Vendor Batch ${x.lot ?? '–'})`}</td>}
                </tr>
              )))}</tbody>
            </table>
          </div>
        )}
        {over.length > 0 && <div className="notice bad">More than the balance for {over.join(', ')} — lower the QTY.</div>}
        {err && <div className="notice bad">{err}</div>}
        <div className="modal-foot"><span className="muted small">{chosen.length} tall{chosen.length === 1 ? 'y' : 'ies'} · {fmtQty(r3(chosen.reduce((t, c) => t + c.q, 0)))}</span><span style={{ flex: 1 }} />
          <button className="btn" onClick={() => onClose(saved > 0)}>Close</button>
          <button className="btn primary" disabled={busy || !chosen.length || over.length > 0} aria-busy={busy || undefined} onClick={save}>{busy ? 'Saving…' : `Save ${chosen.length} tall${chosen.length === 1 ? 'y' : 'ies'}`}</button>
        </div>
      </div>
    </div>
  );
}

/** The whole pick history (every day, every user): search by any value. */
function HistorySearch() {
  const [q, setQ] = useState('');
  const [res, setRes] = useState<{ rows: FoundPick[]; rejects: Reject[] } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (q.trim().length < 2) { setRes(null); return; }
    const t = setTimeout(() => { setBusy(true); api<{ rows: FoundPick[]; rejects: Reject[] }>('/api/pick/search?q=' + encodeURIComponent(q.trim())).then(setRes).catch(() => setRes({ rows: [], rejects: [] })).finally(() => setBusy(false)); }, 350);
    return () => clearTimeout(t);
  }, [q]);
  return (
    <section className="card" aria-labelledby="hs-title">
      <h2 id="hs-title">Search the pick history</h2>
      <p className="sub">Every pick of every day and user. Type any value: pallet, SO, material, lot, batch, inspection lot, HJ Pick No, shade, user, plan (e.g. 2026-10-24, C064), invoice or any Korber field.</p>
      <input type="search" className="as-search" style={{ width: '100%', maxWidth: 520 }} placeholder="Search pallet, SO, item, lot, pick no, user…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search pick history" />
      {busy && <Loader inline label="Searching…" />}
      {res && !busy && (
        <>
          <p className="muted small" style={{ margin: '8px 0' }}>{res.rows.length} roll pick{res.rows.length === 1 ? '' : 's'}{res.rows.length >= 300 ? ' (first 300)' : ''}{res.rejects.length ? ` · ${res.rejects.length} rejected` : ''}</p>
          {res.rows.length > 0 && (
            <div className="table-wrap" style={{ maxHeight: 420 }}>
              <table className="mini">
                <thead><tr><th>Day</th><th>Plan</th><th>Pick</th><th>HJ Pick No</th><th>SO / LI</th><th>Item</th><th>Pallet</th><th className="n">QTY</th><th>Cut</th><th>Lot</th><th>Batch</th><th>Shade</th><th>By</th><th>Note</th></tr></thead>
                <tbody>{res.rows.map((r) => (
                  <tr key={r.id}><td>{fmtDate(r.day)}</td><td className="small">{r.plan}</td><td>{ordinal(r.seq)}</td><td>{r.pick_no || ''}</td><td>{r.so} / {r.li}</td><td>{r.item}</td><td className="mono">{r.pallet}</td>
                    <td className="n">{fmtQty(r.qty)}</td><td>{r.partial ? 'cut' : ''}</td><td>{r.lot}</td><td className="mono small">{r.batch}</td><td>{r.shade}</td><td>{r.by_user}</td><td className="muted small">{r.note}</td></tr>
                ))}</tbody>
              </table>
            </div>
          )}
          {res.rejects.length > 0 && (
            <div className="table-wrap" style={{ maxHeight: 240, marginTop: 8 }}>
              <table className="mini">
                <thead><tr><th>Rejected</th><th>Plan</th><th>SO / LI</th><th>Pallet</th><th className="n">QTY</th><th>Reason</th><th>Replaced by</th></tr></thead>
                <tbody>{res.rejects.map((r) => <tr key={r.id}><td>{fmtDate(r.day)}</td><td className="small">{r.plan}</td><td>{r.so} / {r.li}</td><td className="mono">{r.pallet}</td><td className="n">{fmtQty(r.qty)}</td><td>{r.reason}</td><td>{r.replaced_by || '–'}</td></tr>)}</tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}
