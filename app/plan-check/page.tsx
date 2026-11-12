'use client';
import { useMemo, useRef, useState } from 'react';
import Shell, { useShell } from '@/components/Shell';
import { fmt, fmtQty } from '@/lib/calc';
import { keepFile } from '@/lib/files';
import { checkBytes, checkPlan, checkWorkbook, normId, readPlan, type CheckResult, type CheckStatus, type RollStatus } from '@/lib/plancheck';
import { diagnose, diagWorkbook, explain, loc, type DiagLine, type DiagStatus } from '@/lib/plandiag';

export default function Page() {
  return <Shell><PlanCheckPage /></Shell>;
}

const STATUSES: CheckStatus[] = ['Sent', 'Partly sent', 'Not sent'];
const CLS: Record<CheckStatus, string> = { Sent: 'ok', 'Partly sent': 'warn', 'Not sent': 'bad' };
const ROLL_CLS: Record<RollStatus, string> = { Picked: 'ok', 'Picked for another SO': 'warn', 'Not picked': 'bad', 'Not in Korber': 'bad', 'No barcode': 'mute' };

/** v179: Plan_Format check — which SO / LI / Item Codes of a plan were already sent (picked) by the system, and the rolls */
function PlanCheckPage() {
  const { user, toast } = useShell();
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [res, setRes] = useState<CheckResult | null>(null);
  const [st, setSt] = useState<CheckStatus | 'all'>('all');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  // v181: pick diagnosis — why each line can / cannot be picked (Sinhala and English)
  const [diag, setDiag] = useState<DiagLine[] | null>(null);
  const [dBusy, setDBusy] = useState('');
  const [dOpen, setDOpen] = useState<string | null>(null);
  const [dSt, setDSt] = useState<DiagStatus | 'all'>('all');
  const [lang, setLang] = useState<'si' | 'en'>('si');
  async function runDiag() {
    if (!file) { setErr('Choose the Plan_Format file first.'); return; }
    setErr(''); setDiag(null); setDOpen(null);
    try {
      setDBusy('Reading the Plan_Format…');
      const p = await readPlan(file);
      const seen = new Set<string>();
      const ls = p.rows.map((r) => ({ so: normId(r.values[p.ix.so]), li: normId(r.values[p.ix.li]), item: normId(r.values[p.ix.item]), qty: p.ix.qty >= 0 ? Number(r.values[p.ix.qty]) || 0 : 0 }))
        .filter((l) => { const k = `${l.so}|${l.li}|${l.item}`; if (seen.has(k)) return false; seen.add(k); return true; });
      setDiag(await diagnose(ls, (n) => setDBusy(`Checking the lines… ${n} / ${ls.length}`)));
    } catch (e) { setErr(e instanceof Error ? e.message : 'The diagnosis failed.'); }
    finally { setDBusy(''); }
  }
  function downloadDiag() {
    if (!diag || !file) return;
    const bytes = diagWorkbook(file.name, diag, user.username);
    const blob = new Blob([bytes as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `${file.name.replace(/\.[^.]+$/, '')}_Pick_Diagnosis.xlsx`; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  const dx = useMemo(() => (diag || []).map((d) => ({ d, x: explain(d) })), [diag]);
  const last = useRef<{ bytes: Uint8Array; name: string } | null>(null);

  async function run(f = file) {
    if (!f) { setErr('Choose the Plan_Format file first.'); return; }
    setErr(''); setRes(null); setOpen(null);
    try {
      const r = await checkPlan(f, user.username, setBusy);
      setRes(r);
      setBusy('Making the report…');
      const name = `${f.name.replace(/\.[^.]+$/, '')}_Sent_Check.xlsx`;
      last.current = { bytes: checkBytes(checkWorkbook(r)), name };
      if (user.role !== 'viewer') {
        const kept = await keepFile(new File([last.current.bytes as BlobPart], name, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), ['plan-check'], 'PLANCHECK');
        if (!kept) toast('The report could not be kept in the system — download it now.');
      }
    } catch (e) { setErr(e instanceof Error ? e.message : 'The file could not be checked.'); }
    finally { setBusy(''); }
  }
  function download() {
    const b = last.current; if (!b) return;
    const blob = new Blob([b.bytes as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = b.name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  const sums = useMemo(() => {
    if (!res) return null;
    const of = (s: CheckStatus | 'all') => { const ls = s === 'all' ? res.lines : res.lines.filter((l) => l.status === s); return { n: ls.length, qty: ls.reduce((t, l) => t + l.qty, 0), sent: ls.reduce((t, l) => t + l.sent, 0), bal: ls.reduce((t, l) => t + l.balance, 0) }; };
    return { all: of('all'), Sent: of('Sent'), 'Partly sent': of('Partly sent'), 'Not sent': of('Not sent') };
  }, [res]);
  const shown = useMemo(() => {
    if (!res) return [];
    const qq = q.trim().toUpperCase();
    return res.lines.filter((l) => (st === 'all' || l.status === st) && (!qq || `${l.so} ${l.li} ${l.item}`.toUpperCase().includes(qq)));
  }, [res, st, q]);

  return (
    <div className="pc-page">
      <section className="card">
        <h1 style={{ marginTop: 0 }}>Plan_Format check</h1>
        <label className={`inv-slot${file ? ' has' : ''}`} htmlFor="pc-file" style={{ maxWidth: 520 }}>
          <b>Plan_Format</b>
          <small>The first sheet with SO, LI and Item Code columns is read.</small>
          <span className="inv-file">{file ? `${file.name} · ${(file.size / 1024).toFixed(0)} KB` : 'Choose an Excel file'}</span>
          <input id="pc-file" type="file" accept=".xlsx,.xls,.xlsb,.csv" disabled={!!busy} onChange={(e) => { const f = e.target.files?.[0] ?? null; setFile(f); e.target.value = ''; if (f) void run(f); }} />
        </label>
        <div className="row" style={{ marginTop: 12, gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <button className="btn primary" disabled={!!busy || !file} onClick={() => void run()}>{busy ? 'Working…' : '🔎 Check the plan'}</button>
          {res && last.current && <button className="btn" onClick={download}>⤓ Download report (Excel)</button>}
          {busy && <span className="muted">{busy}</span>}
        </div>
        {err && <div className="notice bad" style={{ marginTop: 12 }}>{err}</div>}
      </section>

      <section className="card">
        <h2 style={{ marginTop: 0 }}>🩺 Pick diagnosis — pick නොවෙන්නේ ඇයි?</h2>
        <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <button className="btn primary" disabled={!!dBusy || !!busy || !file} onClick={() => void runDiag()}>{dBusy ? 'Checking…' : '🩺 Check why (සිංහලෙන්)'}</button>
          {diag && <button className="btn" onClick={downloadDiag}>⤓ Download diagnosis (Excel)</button>}
          {diag && <div className="seg" role="group" aria-label="Language"><button className={lang === 'si' ? 'on' : ''} onClick={() => setLang('si')}>සිංහල</button><button className={lang === 'en' ? 'on' : ''} onClick={() => setLang('en')}>English</button></div>}
          {dBusy && <span className="muted">{dBusy}</span>}
          {!file && <span className="muted small">මුලින් Plan_Format file එක තෝරන්න.</span>}
        </div>
        {diag && (() => {
          const cnt = (s: DiagStatus) => dx.filter((y) => y.x.status === s).length;
          const LBL: Record<DiagStatus, [string, string]> = { ok: ['Pick වෙනවා', 'ok'], part: ['කොටසක් විතරයි', 'warn'], none: ['Pick වෙන්නේ නෑ', 'bad'], done: ['Pick කරන්න දෙයක් නෑ', 'mute'] };
          const shownD = dx.filter((y) => dSt === 'all' || y.x.status === dSt);
          return (
            <>
              <div className="pc-tiles">
                <button type="button" className={`pc-tile${dSt === 'all' ? ' on' : ''}`} onClick={() => setDSt('all')}><span className="k">All lines</span><span className="v">{fmt(dx.length)}</span><span className="s">QTY to pick {fmtQty(dx.reduce((t, y) => t + (y.d.need || 0), 0))}</span></button>
                {(['ok', 'part', 'none', 'done'] as DiagStatus[]).map((s0) => (
                  <button key={s0} type="button" className={`pc-tile ${LBL[s0][1]}${dSt === s0 ? ' on' : ''}`} onClick={() => setDSt(s0)}>
                    <span className="k">{LBL[s0][0]}</span><span className="v">{fmt(cnt(s0))}</span>
                    <span className="s">auto pick {fmtQty(dx.filter((y) => y.x.status === s0).reduce((t, y) => t + (y.d.auto || 0), 0))}</span>
                  </button>
                ))}
              </div>
              <div className="table-wrap">
                <table className="mini pd-table">
                  <thead><tr><th>SO</th><th>LI</th><th>Item Code</th><th className="n">To pick</th><th className="n">UR</th><th className="n">Auto pick</th><th>Status</th><th>{lang === 'si' ? 'හේතුව / කරන්න ඕනේ දේ' : 'Reason / what to do'}</th></tr></thead>
                  <tbody>
                    {shownD.map(({ d, x }) => [
                      <tr key={d.key} className="pc-click" onClick={() => setDOpen(dOpen === d.key ? null : d.key)} title="Details">
                        <td className="mono">{d.so}</td><td>{d.li}</td><td className="mono">{d.item}</td>
                        <td className="n">{fmtQty(d.need || 0)}</td><td className="n">{fmtQty(d.ur || 0)}</td><td className="n">{d.auto ? fmtQty(d.auto) : ''}</td>
                        <td><span className={`pill ${LBL[x.status][1]}`}>{x.label}</span></td>
                        <td className={lang === 'si' ? 'pd-si' : 'small'}><ul className="pd-why">{(lang === 'si' ? x.si : x.en).map((t, i) => <li key={i}>{t}</li>)}</ul></td>
                      </tr>,
                      dOpen === d.key && (
                        <tr key={d.key + 'd'} className="pc-detail"><td colSpan={8}>
                          <div className="pd-grid">
                            <div><b className="small">ZMMBE (St Location / Batch: UR · QI · Block)</b><ul className="small">{(d.stock || []).map((s0, i) => <li key={i}>{loc(s0.sloc)} / {s0.batch}: {fmtQty(s0.ur)} · {fmtQty(s0.qi)} · {fmtQty(s0.block)}{(d.plantLocs || []).map((p0) => p0.replace(/^0+/, '')).includes(s0.sloc.replace(/^0+/, '')) ? ' (plant — already sent)' : ''}</li>)}{!d.stock?.length && <li>none</li>}</ul></div>
                            <div><b className="small">ZINSR lots</b><ul className="small">{(d.lots || []).map((l, i) => <li key={i}>{l.lot} · batch {l.batch} · {l.vendor_batch ?? '–'} · {fmtQty(l.qty)} · {loc(l.sloc)}</li>)}{!d.lots?.length && <li>none</li>}</ul></div>
                            <div><b className="small">Not pickable rolls</b><ul className="small">{(d.blocked || []).map((b, i) => <li key={i}>{b.n} × {b.why}</li>)}{!d.blocked?.length && <li>none</li>}</ul></div>
                          </div>
                          <div className="small muted" style={{ marginTop: 6 }}>{d.found ? `Plan: ${d.found.plan}${d.found.date ? ` · ${d.found.date}` : ''}` : 'Not in a plan of the system — shared reports'}</div>
                          <details style={{ marginTop: 6 }}><summary className="small">System steps (English)</summary><ul className="small">{(d.steps || []).map((t, i) => <li key={i}>{t}</li>)}</ul></details>
                        </td></tr>
                      ),
                    ])}
                  </tbody>
                </table>
              </div>
              <p className="muted small">Line එක click කරලා ZMMBE, ZINSR lots සහ pick නොවෙන rolls බලන්න.</p>
            </>
          );
        })()}
      </section>

      {res && sums && (
        <section className="card">
          <div className="inv-head">
            <h2 style={{ margin: 0 }}>{res.file}</h2>
            <span className="muted small">Sheet “{res.sheet}” · {fmt(res.lines.length)} lines · {fmt(new Set(res.picks.map((x) => x.pallet)).size)} rolls sent</span>
          </div>
          <div className="pc-tiles">
            {(['all', ...STATUSES] as const).map((s) => (
              <button key={s} type="button" className={`pc-tile ${s === 'all' ? '' : CLS[s]}${st === s ? ' on' : ''}`} onClick={() => setSt(s)}>
                <span className="k">{s === 'all' ? 'All lines' : s}</span>
                <span className="v">{fmt(sums[s].n)}</span>
                <span className="s">QTY {fmtQty(sums[s].qty)} · sent {fmtQty(sums[s].sent)}{sums[s].bal > 0.0005 ? ` · balance ${fmtQty(sums[s].bal)}` : ''}</span>
              </button>
            ))}
          </div>
          <input className="inv-search" type="search" id="pc-q" placeholder="Search SO, LI or Item Code…" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="table-wrap">
            <table className="mini">
              <thead><tr><th>SO</th><th>LI</th><th>Item Code</th><th>Date</th><th className="n">QTY</th><th>Status</th><th className="n">Sent</th><th className="n">Balance</th><th className="n">Rolls</th><th>Sent on</th><th title="ZINSR lot → ZCMNTVIEW Barcode Number → Korber Pallet picked">ZCMNTVIEW rolls picked</th></tr></thead>
              <tbody>
                {shown.slice(0, 500).map((l) => {
                  const k = `${l.row}`;
                  const xs = open === k ? res.picks.filter((x) => `${x.so}|${x.li}|${x.item}` === l.key) : [];
                  const zs = open === k ? res.rolls.filter((z) => z.key === l.key) : [];
                  const can = l.rolls > 0 || l.zRolls > 0;
                  return [
                    <tr key={k} className={can ? 'pc-click' : ''} onClick={() => can && setOpen(open === k ? null : k)} title={can ? 'Show the rolls' : ''}>
                      <td className="mono">{l.so}</td><td>{l.li}</td><td className="mono">{l.item}</td><td>{l.date}</td>
                      <td className="n">{fmtQty(l.qty)}</td><td><span className={`pill ${CLS[l.status]}`}>{l.status}</span>{l.repeat && <span className="small muted" title="The same SO / LI / Item Code is on another line of the file too"> ×2+</span>}</td>
                      <td className="n">{l.sent ? fmtQty(l.sent) : ''}</td><td className="n">{l.balance ? fmtQty(l.balance) : ''}</td><td className="n">{l.rolls || ''}</td><td className="small">{l.days}</td>
                      <td>{l.zRolls ? <span className={`pill ${l.zPicked === l.zRolls ? 'ok' : l.zPicked ? 'warn' : 'bad'}`}>{l.zPicked} / {l.zRolls}</span> : <span className="small muted">no rolls</span>}{l.zOther ? <span className="small muted"> · {l.zOther} for another SO</span> : ''}</td>
                    </tr>,
                    open === k && (
                      <tr key={k + 'd'} className="pc-detail"><td colSpan={11}>
                        {!!zs.length && <>
                          <b className="small">ZCMNTVIEW rolls of this SO line (Barcode Number → Korber Pallet)</b>
                          <table className="mini" style={{ marginBottom: 10 }}>
                            <thead><tr><th>ZINSR Lot</th><th>Vendor Batch</th><th>Roll No</th><th>Barcode</th><th className="n">Roll Qty</th><th>Korber Pallet</th><th>Location</th><th>Status</th><th>Picks</th></tr></thead>
                            <tbody>{zs.map((z, i) => (
                              <tr key={i}><td>{z.lot}</td><td>{z.vendor_batch}</td><td>{z.roll_no}</td><td className="mono">{z.barcode ?? '–'}</td><td className="n">{z.roll_qty ? fmtQty(z.roll_qty) : z.korber_qty ? fmtQty(z.korber_qty) : ''}</td><td className="mono">{z.pallet ?? ''}</td><td>{z.location ?? ''}</td>
                                <td><span className={`pill ${ROLL_CLS[z.status]}`}>{z.status}</span></td>
                                <td className="small">{z.picks.map((x) => `${x.day ? x.day.split('-').reverse().join('-') : ''} · ${x.so}/${x.li} · ${fmtQty(x.qty)}`).join('; ')}</td></tr>
                            ))}</tbody>
                          </table>
                        </>}
                        {!!xs.length && <b className="small">Rolls sent (picks of this SO / LI / Item)</b>}
                        {!!xs.length && <table className="mini">
                          <thead><tr><th>Pick date</th><th>Pick</th><th>Type</th><th>Pallet</th><th>Korber Lot</th><th className="n">Qty</th><th>SAP Batch</th><th>Vendor Batch</th><th>By</th></tr></thead>
                          <tbody>{xs.map((x, i) => (
                            <tr key={i}><td>{x.day ? x.day.split('-').reverse().join('-') : ''}</td><td>{x.pick_no || x.plan || ''}</td><td>{x.kind === 'offsite' ? 'Offsite' : 'Normal'}{x.tn ? ` · TN ${x.tn}` : ''}</td><td className="mono">{x.pallet}</td><td>{x.lot}</td>
                              <td className="n">{fmtQty(x.qty)}{x.cut ? ' ✂' : ''}</td><td>{x.batch}</td><td>{x.vendor_batch}</td><td>{x.by}</td></tr>
                          ))}</tbody>
                        </table>}
                      </td></tr>
                    ),
                  ];
                })}
              </tbody>
            </table>
          </div>
          <p className="muted small">{shown.length > 500 ? `Showing 500 of ${fmt(shown.length)} — the Excel report has them all.` : `${fmt(shown.length)} lines · click a line for its rolls`}</p>
        </section>
      )}
    </div>
  );
}
