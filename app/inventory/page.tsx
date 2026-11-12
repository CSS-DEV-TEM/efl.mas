'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Shell, { useShell } from '@/components/Shell';
import { fmt, fmtQty } from '@/lib/calc';
import { downloadFile, keepFile, listFiles, type KeptFile } from '@/lib/files';
import { byLocation, readFiles, reconcile, reportBytes, reportWorkbook, STATUSES, summary, type ReconResult, type ReconRow, type Side, type Status } from '@/lib/invrecon';

export default function Page() {
  return <Shell><InventoryPage /></Shell>;
}

type Slot = 'sap' | 'pfc' | 'korber';
const SLOT: Record<Slot, { title: string; hint: string; src: string }> = {
  sap: { title: 'SAP stock', hint: 'SAP inventory (Plant, St Location, Material, Total stock). The INV workbook with its SAP and Korber sheets works too.', src: 'inv-sap' },
  pfc: { title: 'SAP stock — PFC (optional)', hint: 'A separate SAP export for PFC (0041 / OFST / OMET / XLLT), when the SAP file above has no PFC materials.', src: 'inv-pfc' },
  korber: { title: 'Korber Inventory', hint: 'Korber Inventory Report (Pallet, Plant, Client Code, Display Item Number, Actual Qty).', src: 'inv-korber' },
};
const KEEP_MAX = 30 * 1024 * 1024; // a bigger file is not kept (the total space is shared with the Pick reports)

/** v171: SAP ↔ Korber inventory reconciliation — worked out in the browser, PFC and KFC reports, kept in the system */
function InventoryPage() {
  const { user, toast } = useShell();
  const canRun = user.role !== 'viewer';
  const [files, setFiles] = useState<Record<Slot, File | null>>({ sap: null, pfc: null, korber: null });
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [res, setRes] = useState<ReconResult | null>(null);
  const [side, setSide] = useState<Side>('KFC');
  const [st, setSt] = useState<Status | 'all' | 'diff'>('diff');
  const [q, setQ] = useState('');
  const [hist, setHist] = useState<KeptFile[] | null>(null);
  const lastBytes = useRef<{ bytes: Uint8Array; name: string } | null>(null);

  const loadHist = useCallback(() => { listFiles({ src: 'inv-recon' }).then((r) => setHist(r.files)).catch(() => setHist([])); }, []);
  useEffect(() => { loadHist(); }, [loadHist]);

  async function run() {
    const fs = [files.sap, files.pfc, files.korber].filter((f): f is File => !!f);
    if (!fs.length) { setErr('Add the SAP and Korber files first.'); return; }
    setErr(''); setRes(null);
    try {
      setBusy('Reading the files…');
      const p = await readFiles(fs, setBusy);
      if (!p.sap.length) throw new Error('No SAP sheet found — it needs the columns Plant, St Location, Material and Total stock.');
      if (!p.korber.length) throw new Error('No Korber sheet found — it needs the columns Pallet, Plant, Client Code, Actual Qty and Display Item Number.');
      setBusy('Tallying SAP and Korber…');
      await new Promise((r) => setTimeout(r, 30));
      const r = reconcile(p);
      setRes(r);
      setBusy('Making the report…');
      await new Promise((r2) => setTimeout(r2, 30));
      const day = new Date(); const d2 = (n: number) => String(n).padStart(2, '0');
      const name = `Inventory Reconciliation ${d2(day.getDate())}-${d2(day.getMonth() + 1)}-${day.getFullYear()} ${d2(day.getHours())}${d2(day.getMinutes())}.xlsx`;
      const bytes = reportBytes(reportWorkbook(r, user.username));
      lastBytes.current = { bytes, name };
      if (canRun) {
        setBusy('Saving the report in the system…');
        const kept = await keepFile(new File([bytes as BlobPart], name, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), ['inv-recon'], 'INV');
        // the uploaded files too (the latest of each is kept), when they are not too big
        const skipped: string[] = [];
        for (const k of ['sap', 'pfc', 'korber'] as Slot[]) { const f = files[k]; if (!f) continue; if (f.size > KEEP_MAX) { skipped.push(f.name); continue; } await keepFile(f, [SLOT[k].src], 'INV'); }
        loadHist();
        toast(kept ? `Report saved${skipped.length ? ` · not kept (over 30 MB): ${skipped.join(', ')}` : ''}` : 'The report could not be saved — download it now.');
      }
    } catch (e) { setErr(e instanceof Error ? e.message : 'The files could not be read.'); }
    finally { setBusy(''); }
  }
  function download() {
    const b = lastBytes.current; if (!b) return;
    const blob = new Blob([b.bytes as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = b.name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  const sums = useMemo(() => (res ? { KFC: summary(res.rows.filter((r) => r.side === 'KFC')), PFC: summary(res.rows.filter((r) => r.side === 'PFC')) } : null), [res]);
  const locs = useMemo(() => (res ? byLocation(res.rows).filter((x) => x.side === side) : []), [res, side]);
  const shown = useMemo(() => {
    if (!res) return [];
    const qq = q.trim().toUpperCase();
    return res.rows.filter((r) => r.side === side && (st === 'all' || (st === 'diff' ? r.status !== 'Match' : r.status === st)) && (!qq || r.unic.includes(qq) || r.desc.toUpperCase().includes(qq)));
  }, [res, side, st, q]);

  return (
    <div className="inv-page">
      <section className="card">
        <h1 style={{ marginTop: 0 }}>Inventory reconciliation</h1>
        <div className="inv-slots">
          {(['sap', 'pfc', 'korber'] as Slot[]).map((k) => (
            <label key={k} className={`inv-slot${files[k] ? ' has' : ''}`} htmlFor={`inv-${k}`}>
              <b>{SLOT[k].title}</b>
              <small>{SLOT[k].hint}</small>
              <span className="inv-file">{files[k] ? `${files[k]!.name} · ${(files[k]!.size / 1024 / 1024).toFixed(1)} MB` : 'Choose an Excel file'}</span>
              <input id={`inv-${k}`} type="file" accept=".xlsx,.xls,.xlsb,.csv" disabled={!!busy} onChange={(e) => { const f = e.target.files?.[0] ?? null; setFiles((x) => ({ ...x, [k]: f })); e.target.value = ''; }} />
            </label>
          ))}
        </div>
        <div className="row" style={{ marginTop: 12, gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <button className="btn primary" disabled={!!busy || !canRun || (!files.sap && !files.korber)} onClick={() => void run()}>{busy ? 'Working…' : '⚖ Tally SAP ↔ Korber'}</button>
          {res && lastBytes.current && <button className="btn" onClick={download}>⤓ Download report (Excel)</button>}
          {busy && <span className="muted">{busy}</span>}
          {(files.sap || files.pfc || files.korber) && !busy && <button className="btn sm" onClick={() => { setFiles({ sap: null, pfc: null, korber: null }); setRes(null); }}>Clear</button>}
        </div>
        {err && <div className="notice bad" style={{ marginTop: 12 }}>{err}</div>}
      </section>

      {res && sums && (
        <section className="card">
          <div className="inv-head">
            <h2 style={{ margin: 0 }}>Result</h2>
            <span className="muted small">SAP {fmt(res.sapRows)} rows{res.sapDup ? ` (${fmt(res.sapDup)} duplicate rows counted once)` : ''} · Korber {fmt(res.korberRows)} rolls</span>
          </div>
          <div className="inv-sides">
            {(['KFC', 'PFC'] as Side[]).map((s) => (
              <button key={s} type="button" className={`inv-side${side === s ? ' on' : ''}`} onClick={() => setSide(s)}>
                <span className="k">{s} reconciliation</span>
                <span className="v">{fmt(sums[s].unic)} <small>Unic</small></span>
                <span className="s">SAP {fmtQty(sums[s].sap)} · Korber {fmtQty(sums[s].korber)} · Variance {fmtQty(sums[s].variance)}</span>
                <span className="inv-bar">{STATUSES.map((x) => sums[s].byStatus[x] ? <i key={x} className={`st-${x.replace(/\s/g, '')}`} style={{ flex: sums[s].byStatus[x] }} title={`${x}: ${sums[s].byStatus[x]}`} /> : null)}</span>
              </button>
            ))}
          </div>
          {side === 'PFC' && sums.PFC.byStatus.Match === 0 && sums.PFC.unic > 0 && <div className="notice warn" style={{ marginTop: 10 }}>No PFC material is in both SAP and Korber — the SAP file probably has no PFC materials. Add the PFC SAP export in “SAP stock — PFC” and tally again.</div>}
          <div className="seg inv-filter" role="tablist" aria-label="Status">
            {(['diff', 'all', ...STATUSES] as const).map((x) => (
              <button key={x} type="button" className={st === x ? 'on' : ''} onClick={() => setSt(x)}>
                {x === 'diff' ? 'Not matching' : x === 'all' ? 'All' : x} <small>{fmt(x === 'all' ? sums[side].unic : x === 'diff' ? sums[side].unic - sums[side].byStatus.Match : sums[side].byStatus[x])}</small>
              </button>
            ))}
          </div>
          <input className="inv-search" type="search" id="inv-q" placeholder="Search Unic, material or description…" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="table-wrap inv-table">
            <table className="mini">
              <thead><tr><th>Unic</th><th>Description</th><th className="n">SAP</th><th className="n">Korber</th><th className="n">Variance</th><th>Status</th><th className="n">Rolls</th></tr></thead>
              <tbody>
                {shown.slice(0, 300).map((r: ReconRow) => (
                  <tr key={r.side + r.unic}>
                    <td className="mono">{r.unic}{r.sapMats && <div className="small muted">SAP {r.sapMats}</div>}</td>
                    <td className="small">{r.desc}</td>
                    <td className="n">{fmtQty(r.sap)}</td><td className="n">{fmtQty(r.korber)}</td>
                    <td className={`n ${r.variance > 0.0005 ? 'inv-pos' : r.variance < -0.0005 ? 'inv-neg' : ''}`}>{r.variance > 0 ? '+' : ''}{fmtQty(r.variance)}</td>
                    <td><span className={`pill inv-st st-${r.status.replace(/\s/g, '')}`}>{r.status}</span></td>
                    <td className="n">{r.rolls || ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted small">{shown.length > 300 ? `Showing 300 of ${fmt(shown.length)} — the Excel report has them all.` : `${fmt(shown.length)} Unic`}</p>
          <details className="inv-locs">
            <summary>By location — {side}</summary>
            <div className="table-wrap">
              <table className="mini">
                <thead><tr><th>Plant-Location</th><th className="n">Unic</th><th className="n">SAP</th><th className="n">Korber</th><th className="n">Variance</th><th className="n">Match</th><th className="n">SAP only</th><th className="n">Korber only</th></tr></thead>
                <tbody>{locs.map((x) => <tr key={x.loc}><td className="mono">{x.loc}</td><td className="n">{fmt(x.unic)}</td><td className="n">{fmtQty(x.sap)}</td><td className="n">{fmtQty(x.korber)}</td><td className="n">{fmtQty(x.variance)}</td><td className="n">{fmt(x.byStatus.Match)}</td><td className="n">{fmt(x.byStatus['SAP only'])}</td><td className="n">{fmt(x.byStatus['Korber only'])}</td></tr>)}</tbody>
              </table>
            </div>
          </details>
        </section>
      )}

      <section className="card">
        <h2 style={{ marginTop: 0 }}>Saved reports</h2>
        {!hist ? <p className="muted">Loading…</p> : !hist.length ? <p className="muted">No reconciliation yet.</p> : (
          <div className="table-wrap">
            <table className="mini">
              <thead><tr><th>Report</th><th>By</th><th>When</th><th className="n">Size</th><th /></tr></thead>
              <tbody>{hist.map((f) => (
                <tr key={f.id}><td>{f.name}</td><td>{f.uploaded_by}</td><td>{new Date(f.uploaded_at).toLocaleString()}</td><td className="n">{(f.size / 1024 / 1024).toFixed(1)} MB</td>
                  <td><button className="btn sm" onClick={() => void downloadFile(f).catch((e) => toast(e instanceof Error ? e.message : 'Download failed.'))}>⤓ Download</button></td></tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
