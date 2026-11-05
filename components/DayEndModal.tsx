'use client';
import { useEffect, useState } from 'react';
import type * as XLSX from 'xlsx';
import { api, getSession } from '@/lib/api';
import { keepFile, downloadLatest, fmtSize } from '@/lib/files';
import { mergeWorkbooks, saveWorkbook, simpleSheet, workbookBytes, type PickHistory } from '@/lib/pick';
import { startTask } from '@/lib/progress';
import * as XLSXS from 'xlsx-js-style';

/**
 * v155 Day end: when everything that can be picked is picked — one full report of the day is made and kept in the system
 * (Packing List + Plan → Pick report + Korber ↔ SAP tally + Day summary), then the day's Pick reports are deleted
 * (ZMMBE, KFC / PFC, ZINR, ZCOMENT VIEW, Korber, ZROLLMGT, ZMM_TRR of those Picks and their kept files).
 * The plan, the picks, the pick history and the shared reports stay. Admin / Head only.
 */
type DayPick = { rid: string; rows: Record<string, number>; total: number; files: number; fileSize: number };
type DayInfo = { day: string; done: null | { by_user: string; at: string; rids: string[]; deleted: Record<string, number> }; picks: DayPick[] };
type LineLite = { week?: string; so: string; li: string | number; item: string; qty: number; picked?: number; hold?: string | null; status?: string | null };
type PLOut = { wb: XLSX.WorkBook; file: string; issues: number; picks: number; tallied: number } | null;
const q = (n: number) => (Math.round(n * 100) / 100).toLocaleString(undefined, { maximumFractionDigits: 2 });
const pickName = (w: string) => { const m = /^(\d{4}-\d{2}-\d{2})~([^~]*)~(\d+)$/.exec(w); return m ? `${m[2]} · Pick ${m[3]}` : w; };

export default function DayEndModal({ day, rows, autoLeft, openLines, buildPL, buildReport, onClose, toast }: {
  day: string; rows: LineLite[]; autoLeft: number; openLines: number;
  buildPL: () => Promise<PLOut>; buildReport: () => Promise<XLSX.WorkBook | null>; onClose: (changed: boolean) => void; toast: (m: string) => void;
}) {
  const [info, setInfo] = useState<DayInfo | null>(null);
  const [err, setErr] = useState('');
  const [pick, setPick] = useState<Set<string>>(new Set());
  const [ok1, setOk1] = useState(false);
  const [word, setWord] = useState('');
  const [busy, setBusy] = useState('');
  const [result, setResult] = useState<null | { deleted: Record<string, number>; file: string }>(null);
  useEffect(() => {
    api<DayInfo>('/api/pick/dayend?day=' + day).then((r) => { setInfo(r); setPick(new Set(r.picks.map((x) => x.rid))); }).catch((e) => setErr(e instanceof Error ? e.message : 'Could not load.'));
  }, [day]);
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(!!result); }; addEventListener('keydown', k); return () => removeEventListener('keydown', k); }, [busy, onClose, result]);
  const chosen = (info?.picks || []).filter((x) => pick.has(x.rid));
  const delRows = chosen.reduce((t, x) => t + x.total, 0);
  const ready = ok1 && word.trim().toUpperCase() === 'END' && chosen.length > 0 && !busy;

  const run = async () => {
    const task = startTask('Day end', 'Packing List', 5);
    setErr('');
    try {
      setBusy('Packing List (cut roll balances tallied)…'); task.set(0, 5, 'Packing List');
      const pl = await buildPL();
      setBusy('Plan → Pick report…'); task.set(1, 5, 'Plan → Pick report');
      const rep = await buildReport();
      setBusy('Korber ↔ SAP tally…'); task.set(2, 5, 'Korber ↔ SAP tally');
      const tl: (string | number | null)[][] = [], tr: (string | number | null)[][] = [];
      for (const x of chosen) {
        try {
          const r = await api<{ items: { item: string; state: string; plan: number; picked?: number; need: number; ur: number; korber: number; rolls: { pallet: string; batch: string | null; korber: number | null; sap: number | null; bin: string | null; location: string | null; kind: string; why: string }[] }[] }>('/api/pick/recon?rid=' + encodeURIComponent(x.rid));
          for (const it of r.items) {
            tl.push([pickName(x.rid), it.item, it.state, it.plan, it.picked ?? 0, it.need, it.ur, it.korber]);
            for (const rr of it.rolls) tr.push([pickName(x.rid), it.item, rr.pallet, rr.batch, rr.korber, rr.sap, [rr.bin, rr.location].filter(Boolean).join(' · '), rr.kind, rr.why]);
          }
        } catch { tl.push([pickName(x.rid), '–', 'could not be read', null, null, null, null, null]); }
      }
      setBusy('Day summary…'); task.set(3, 5, 'Day summary');
      const hist = await api<PickHistory>('/api/pick/history?day=' + day).catch(() => null);
      const reqs = (hist?.requests || []).filter((r) => !r.cancelled_at);
      const byU = new Map<string, { lines: number; qty: number; rolls: number }>();
      for (const r of reqs) { const e = byU.get(r.by_user) ?? { lines: 0, qty: 0, rolls: 0 }; e.lines++; e.qty += Number(r.qty) || 0; e.rolls += Number(r.rolls) || 0; byU.set(r.by_user, e); }
      const plan = rows.reduce((t, l) => t + (Number(l.qty) || 0), 0), picked = rows.reduce((t, l) => t + (Number(l.picked) || 0), 0);
      const me = getSession()?.user.username ?? '';
      const sumRows: (string | number | null)[][] = [
        ['Day', day], ['Ended by', me], ['Ended at', new Date().toLocaleString()], ['Picks', chosen.map((x) => pickName(x.rid)).join(', ')],
        ['Plan lines', rows.length], ['Lines still open', openLines], ['Lines Pick all matched could still pick', autoLeft], ['Lines on hold', rows.filter((l) => !!l.hold).length],
        ['Plan QTY', Math.round(plan * 1000) / 1000], ['Picked QTY', Math.round(picked * 1000) / 1000], ['Picked %', plan ? Math.round((picked / plan) * 1000) / 10 : 0],
        ['Pick requests (this day)', reqs.length], ['Rolls picked', reqs.reduce((t, r) => t + (Number(r.rolls) || 0), 0)],
        ['Packing List checks', pl ? `${pl.issues} warning(s)` : 'no picks'], ['Cut roll balances tallied', pl ? pl.tallied : 0],
        ['Report rows deleted after this report', delRows], [], ['User', 'Lines', 'QTY', 'Rolls'],
        ...Array.from(byU.entries()).sort((a, b) => b[1].qty - a[1].qty).map(([u, e]) => [u, e.lines, Math.round(e.qty * 1000) / 1000, e.rolls]),
      ];
      const summary = XLSXS.utils.book_new();
      XLSXS.utils.book_append_sheet(summary, simpleSheet(`DAY END · ${day}`, ['Item', 'Value'], sumRows, [36, 60]), 'Day Summary');
      const tally = XLSXS.utils.book_new();
      XLSXS.utils.book_append_sheet(tally, simpleSheet(`KORBER ↔ SAP TALLY · ${day}`, ['Pick', 'Material', 'State', 'Plan', 'Picked', 'To pick', 'SAP UR left', 'Korber pickable'], tl, [22, 14, 12, 10, 10, 10, 12, 14]), 'Korber-SAP Tally');
      XLSXS.utils.book_append_sheet(tally, simpleSheet(`KORBER ↔ SAP — ROLLS THAT DIFFER · ${day}`, ['Pick', 'Material', 'Pallet / Roll', 'SAP batch', 'Korber', 'ZROLLMGT', 'Bin / Location', 'What differs', 'Why'], tr, [22, 14, 18, 12, 10, 10, 22, 14, 50]), 'Korber-SAP Rolls');
      const wb = mergeWorkbooks([{ wb: summary, prefix: 'Day' }, ...(pl ? [{ wb: pl.wb, prefix: 'PL' }] : []), ...(rep ? [{ wb: rep, prefix: 'Report' }] : []), { wb: tally, prefix: 'Tally' }]);
      const file = `Day_End_Report_${day}.xlsx`;
      setBusy('Saving the report in the system…'); task.set(4, 5, 'saving the report');
      const bytes = workbookBytes(wb);
      const kept = await keepFile(new File([bytes as BlobPart], file, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), ['dayend'], day);
      if (!kept) throw new Error('The Day end report could not be saved in the system — nothing was deleted. Try again.');
      saveWorkbook(wb, file);
      setBusy('Deleting the day\'s Pick reports…'); task.set(5, 5, 'deleting the Pick reports');
      const r = await api<{ deleted: Record<string, number> }>('/api/pick/dayend', { method: 'POST', body: { day, rids: chosen.map((x) => x.rid), summary: { plan, picked, lines: rows.length, open: openLines, autoLeft, requests: reqs.length } } });
      setResult({ deleted: r.deleted, file });
      toast(`Day end ${day}: report saved, ${Object.values(r.deleted).reduce((a, b) => a + b, 0).toLocaleString()} report rows deleted`);
    } catch (e) { setErr(e instanceof Error ? e.message : 'Day end failed.'); }
    finally { setBusy(''); task.end(); }
  };

  const LBL: Record<string, string> = { stock: 'ZMMBE / KFC / PFC', stock_sent: 'Already sent', zinr: 'ZINR', zcoment: 'ZCOMENT VIEW', korber: 'Korber', zroll: 'ZROLLMGT', ztrr: 'ZMM_TRR', files: 'kept files' };
  return (
    <div className="modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(!!result); }}>
      <div className="modal dayend" role="dialog" aria-labelledby="de-t" style={{ width: 'min(760px, 100%)' }}>
        <div className="modal-head">
          <div><h2 id="de-t">🌙 Day end · {day}</h2>
            <p className="muted small">Makes the day&apos;s full report and keeps it in the system, then deletes the day&apos;s Pick reports. The plan, the picks and the history stay.</p>
            <p className="muted small si-line" lang="si"><span className="si">දවසේ full report එක හදලා system එකේ තියාගන්නවා, ඊට පස්සේ දවසේ Pick reports delete කරනවා. Plan, picks, history එහෙමම තියෙනවා.</span></p></div>
          <button className="btn sm" disabled={!!busy} onClick={() => onClose(!!result)} aria-label="Close">✕</button>
        </div>
        {err && <div className="notice bad">{err}</div>}
        {!info && !err && <div className="skel" style={{ height: 140 }} />}
        {info?.done && !result && (
          <div className="notice info">This day was ended by <b>{info.done.by_user}</b> at {new Date(info.done.at).toLocaleString()} ({info.done.rids.length} Pick{info.done.rids.length === 1 ? '' : 's'}).
            <button className="btn sm" style={{ marginLeft: 8 }} onClick={() => void downloadLatest('dayend', day).catch((e) => toast(e instanceof Error ? e.message : 'Not found'))}>⬇ Day end report</button></div>
        )}
        {result ? (
          <div className="de-done">
            <div className="de-moon" aria-hidden>🌙</div>
            <h3>Day ended ✓ <span className="si" lang="si">දවස ඉවරයි ✓</span></h3>
            <p>The report <b>{result.file}</b> is saved in the system (Uploads → Uploaded files, and here) and downloaded.</p>
            <ul className="de-del">{Object.entries(result.deleted).filter(([, v]) => v > 0).map(([k, v]) => <li key={k}><span>{LBL[k] ?? k}</span><b>{v.toLocaleString()}</b></li>)}</ul>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn" onClick={() => void downloadLatest('dayend', day)}>⬇ Download again</button>
              <button className="btn primary" onClick={() => onClose(true)}>Close</button>
            </div>
          </div>
        ) : info && (
          <>
            <div className={`notice ${autoLeft > 0 ? 'warn' : openLines > 0 ? 'info' : 'ok'}`}>
              {autoLeft > 0 ? <><b>{autoLeft} line{autoLeft === 1 ? '' : 's'} can still be picked</b> by ⚡ Pick all matched — pick them first.<span className="si si-line" lang="si">තව lines {autoLeft}ක් ⚡ Pick all matched එකෙන් pick කරන්න පුළුවන් — මුලින් ඒවා pick කරන්න.</span></>
                : openLines > 0 ? <>{openLines} line{openLines === 1 ? ' is' : 's are'} still open (needs manual / no stock).<span className="si si-line" lang="si">Lines {openLines}ක් තාම open (manual / stock නැහැ).</span></>
                : <>Everything that can be picked is picked ✓<span className="si si-line" lang="si">Pick කරන්න පුළුවන් සේරම pick කරලා ඉවරයි ✓</span></>}
            </div>
            <h3 className="dm-h">The day&apos;s Picks — their reports are deleted</h3>
            {!info.picks.length ? <p className="muted">No Pick of this day has its own reports.</p> : (
              <div className="table-wrap de-tbl"><table className="mini" data-nofilter="" data-noexport="">
                <thead><tr><th /><th>Pick</th><th className="n">Report rows</th><th className="n">Kept files</th></tr></thead>
                <tbody>{info.picks.map((x) => (
                  <tr key={x.rid}><td><input type="checkbox" checked={pick.has(x.rid)} onChange={(e) => setPick((s) => { const n = new Set(s); if (e.target.checked) n.add(x.rid); else n.delete(x.rid); return n; })} aria-label={`Include ${pickName(x.rid)}`} /></td>
                    <td><b>{pickName(x.rid)}</b><div className="muted small">{Object.entries(x.rows).filter(([, v]) => v > 0).map(([k, v]) => `${LBL[k] ?? k} ${v.toLocaleString()}`).join(' · ') || 'no report rows'}</div></td>
                    <td className="n">{x.total.toLocaleString()}</td><td className="n">{x.files}{x.fileSize ? ` · ${fmtSize(x.fileSize)}` : ''}</td></tr>
                ))}</tbody>
              </table></div>
            )}
            <p className="small">The report has: <b>Day Summary</b>, the <b>Packing List</b> (all picks of {day}, cut roll balances tallied), the <b>Plan → Pick report</b> and the <b>Korber ↔ SAP tally</b>.</p>
            <label className="de-ok"><input type="checkbox" checked={ok1} onChange={(e) => setOk1(e.target.checked)} />
              <span>I understand: the reports of the {chosen.length} chosen Pick{chosen.length === 1 ? '' : 's'} ({delRows.toLocaleString()} rows) are deleted and cannot be brought back. The Day end report keeps the final state.<br />
                <span className="si" lang="si">තෝරපු Picks වල reports delete වෙනවා, ආයෙත් ගන්න බැහැ. Final state එක Day end report එකේ තියෙනවා.</span></span></label>
            <label className="de-word">Type <b>END</b> to confirm <input className="as-search" value={word} onChange={(e) => setWord(e.target.value)} style={{ width: 90 }} aria-label="Type END" /></label>
            {busy && <div className="notice info">⏳ {busy}</div>}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn" disabled={!!busy} onClick={() => onClose(false)}>Cancel</button>
              <button className="btn primary" disabled={!ready} onClick={() => void run()}>{busy ? 'Working…' : '🌙 End the day'}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
