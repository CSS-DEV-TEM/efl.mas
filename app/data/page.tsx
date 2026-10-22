'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import Shell, { useShell } from '@/components/Shell';
import { Loader } from '@/components/Loader';
import DayPickBar, { useDayPick } from '@/components/DayPickBar';
import { api } from '@/lib/api';
import { ago, fmt, fmtQty } from '@/lib/calc';
import { uploadPickFile } from '@/lib/pick';

export default function Page() {
  return <Shell><DataPage /></Shell>;
}

interface ZRow {
  barcode: string; bin: string | null; material: string | null; batch: string | null; qty: number | null; uom: string | null; sloc: string | null; plant: string | null;
  so: string | null; li: string | null; status: string | null; bin_ok: number; zc_lot: string | null; zc_batch: string | null; zc_shade: string | null;
  k_qty: number | null; k_item: string | null; k_pick: string | null; picked: number | null; rejected: number;
  bin_at: number; st_ok: number; zm_line: string | null; k_pallet: string | null;
}
interface ZRes {
  rid: string; bin: string; hasStatus?: boolean; gate: boolean; upload: { file_name: string | null; row_count: number; uploaded_by: string; uploaded_at: string; rid: string } | null;
  summary: { n: number; bin: number; st: number; zm: number; zc: number; korber: number; ok: number; open: number } | null; rows: ZRow[];
}
type State = 'all' | 'ok' | 'bin' | 'status' | 'nozm' | 'nozc' | 'nokorber';

/** Data: the Pick's ZROLLMGT (roll management) — upload it here, and see which rolls pass the pick check. */
function DataPage() {
  const { user, toast, subscribe } = useShell();
  const { day, setDay, rid, setRid } = useDayPick();
  const [barKey, setBarKey] = useState(0);
  const [res, setRes] = useState<ZRes | null>(null);
  const [state, setState] = useState<State>('all');
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const canEdit = user.role !== 'viewer';

  const load = useCallback(() => {
    const t = setTimeout(() => {
      api<ZRes>(`/api/zroll?rid=${encodeURIComponent(rid)}&state=${state}&q=${encodeURIComponent(q.trim())}`).then(setRes).catch(() => setRes(null));
    }, q ? 300 : 0);
    return () => clearTimeout(t);
  }, [rid, state, q]);
  useEffect(() => load(), [load]);
  useEffect(() => subscribe((m) => { if (m.type === 'data') load(); }), [subscribe, load]);

  const upload = async (f: File) => {
    if (!rid) { toast('Choose the Pick first.'); return; }
    setBusy(true);
    try {
      const r = await uploadPickFile('zroll', f, rid);
      toast(`ZROLLMGT: ${fmt(r.rows)} rolls saved to this Pick`);
      setBarKey((k) => k + 1); load();
    } catch (e) { toast(e instanceof Error ? e.message : 'Upload failed.'); } finally { setBusy(false); }
  };

  const s = res?.summary;
  const bin = res?.bin || 'EXPO-FIX';
  const tabs: [State, string, number | undefined][] = [
    ['all', 'All', s?.n], ['ok', 'Pickable', s?.ok], ['bin', `Bin not ${bin}`, s ? s.n - s.bin : undefined],
    ...(res?.hasStatus ? [['status', 'Status not UR', s ? s.n - s.st : undefined] as [State, string, number | undefined]] : []),
    ['nozm', 'System Batch not in ZMMBE', s ? s.n - s.zm : undefined],
    ['nozc', 'Not in ZCOMENT VIEW', s ? s.n - s.zc : undefined], ['nokorber', 'Not in Korber', s ? s.n - s.korber : undefined],
  ];
  return (
    <main className="page anim">
      <div className="page-head">
        <div>
          <h1>Data</h1>
          <p>The Pick&apos;s ZROLLMGT (roll management). A roll is picked only when its <b>Barcode Number</b> is in ZROLLMGT at StorageBin <b>{bin}</b>, is a <b>ZCOMENT VIEW Barcode Number</b> (of the line&apos;s ZMMBE batch) and is the <b>Korber Pallet</b> (Pick Id 0). A roll with no ZCOMENT barcode is matched on Invoice, Item and Lot, and its <b>Korber Pallet</b> must be in ZROLLMGT at {bin}. Every pick, manual roll and replacement is checked against it.</p>
        </div>
      </div>

      <DayPickBar day={day} setDay={setDay} rid={rid} setRid={setRid} toast={toast} refreshKey={barKey} onUploaded={load} />

      <section className="card" aria-labelledby="zr-title">
        <div className="sheet-top">
          <div>
            <h2 id="zr-title">ZROLLMGT {res && !res.gate && <span className="pill warn" style={{ marginLeft: 6 }}>check turned off in Settings</span>}</h2>
            <p className="sub" style={{ margin: 0 }}>
              {res?.upload ? <>{res.upload.rid ? 'This Pick' : 'Shared report'} · {res.upload.file_name || 'file'} · {fmt(res.upload.row_count)} rolls · {res.upload.uploaded_by} · {ago(res.upload.uploaded_at)}</>
                : rid ? 'No ZROLLMGT uploaded for this Pick yet — nothing can be picked until it is.' : 'Choose the day and the Pick above.'}
              {user.role === 'admin' && <> · <Link href="/settings/#pick">Settings → Pick rules</Link></>}
            </p>
          </div>
          {canEdit && <div>
            <button className="btn primary" disabled={!rid || busy} aria-busy={busy || undefined} onClick={() => input.current?.click()}>{busy ? 'Uploading…' : res?.upload?.rid ? 'Upload ZROLLMGT again' : 'Upload ZROLLMGT'}</button>
            <input ref={input} type="file" hidden accept=".xlsx,.xls,.xlsm,.csv" onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ''; }} />
          </div>}
        </div>

        {s && s.n > 0 && (
          <div className="pk-stats" style={{ marginTop: 10 }}>
            <div><span>Rolls</span><b>{fmt(s.n)}</b></div>
            <div className="ok"><span>At {bin}</span><b>{fmt(s.bin)}</b></div>
            <div><span>In ZCOMENT VIEW</span><b>{fmt(s.zc)}</b></div>
            <div><span>In Korber</span><b>{fmt(s.korber)}</b></div>
            <div className="em"><span>Pickable</span><b>{fmt(s.ok)}</b><small>{fmt(s.open)} not picked in full</small></div>
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', margin: '12px 0 8px' }}>
          <div className="seg" role="group" aria-label="Show">
            {tabs.map(([k, label, n]) => <button key={k} className={state === k ? 'on' : ''} onClick={() => setState(k)}>{label}{n !== undefined ? ` (${fmt(n)})` : ''}</button>)}
          </div>
          <input type="search" placeholder="Barcode, Material, Batch, Bin…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search ZROLLMGT" style={{ width: 220 }} />
        </div>

        {!res ? <Loader label="Loading ZROLLMGT…" /> : !res.rows.length ? <p className="muted">{s?.n ? 'No roll in this view.' : 'No rolls.'}</p> : (
          <div className="table-wrap" style={{ maxHeight: 560 }}>
            <table className="mini">
              <thead><tr><th>Barcode Number</th><th>StorageBin</th><th>Status</th><th>Material</th><th>System Batch</th><th>ZMMBE line (batch, UR)</th><th className="n">QTY</th><th>ZCOMENT VIEW</th><th>Korber</th><th className="n">Picked</th><th>Pick check</th></tr></thead>
              <tbody>{res.rows.map((r) => {
                const why = !r.bin_at ? `Bin ${r.bin || '–'}` : !r.st_ok ? `Status ${r.status || '–'} (not UR)` : r.k_qty == null ? 'Not in Korber' : r.k_pick !== '0' ? `Korber Pick Id ${r.k_pick}` : r.rejected ? 'Rejected' : null;
                const full = r.k_qty != null && Number(r.picked || 0) >= Number(r.k_qty) - 0.0005;
                return (
                  <tr key={r.barcode}>
                    <td className="mono">{r.barcode}</td>
                    <td><span className={`pill ${r.bin_at ? 'ok' : 'bad'}`}>{r.bin || '–'}</span></td>
                    <td>{r.status ? <span className={`pill ${r.st_ok ? 'ok' : 'bad'}`}>{r.status}</span> : '–'}</td>
                    <td>{r.material || r.k_item || '–'}</td><td>{r.batch || '–'}</td>
                    <td className="small">{r.zm_line ? r.zm_line : <span className="muted">{r.batch ? 'no ZMMBE line' : '–'}</span>}</td>
                    <td className="n">{r.qty != null ? `${fmtQty(r.qty)}${r.uom ? ' ' + r.uom : ''}` : '–'}</td>
                    <td className="small">{r.zc_lot ? <>Lot {r.zc_lot} · {r.zc_batch}{r.zc_shade ? ` · shade ${r.zc_shade}` : ''}</> : <span className="muted">–</span>}</td>
                    <td className="small">{r.k_qty != null ? <>{fmtQty(r.k_qty)}{r.k_pick !== '0' ? ` · Pick Id ${r.k_pick}` : ''}{r.k_pallet && r.k_pallet !== r.barcode ? ` · ${r.k_pallet}` : ''}</> : <span className="muted">–</span>}</td>
                    <td className="n">{r.picked ? fmtQty(r.picked) : '–'}</td>
                    <td>{why ? <span className="pill bad">{why}</span> : full ? <span className="pill mute">Picked in full</span> : <span className="pill ok" title={r.zc_lot ? 'ZCOMENT Barcode = Korber Pallet = ZROLLMGT Barcode' : 'No ZCOMENT barcode: matched on Invoice, Item and Lot'}>Pickable ✓{r.zc_lot ? '' : ' · no ZCOMENT barcode'}</span>}</td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
        )}
        {res && res.rows.length >= 500 && <p className="muted small">The first 500 rolls are shown — search to narrow down.</p>}
      </section>
    </main>
  );
}
