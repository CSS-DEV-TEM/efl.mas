'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import Shell, { useShell } from '@/components/Shell';
import { Loader } from '@/components/Loader';
import DayPickBar, { useDayPick } from '@/components/DayPickBar';
import { api, isBossRole } from '@/lib/api';
import { ago, fmt, fmtDate, fmtQty } from '@/lib/calc';
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
  // the bin rule: one bin only (EXPO-FIX), or any bin except some ("any bin except FIXED")
  const anyBut = /^any bin except /i.test(bin);
  const tabs: [State, string, number | undefined][] = [
    ['all', 'All', s?.n], ['ok', 'Pickable', s?.ok], ['bin', anyBut ? `Bin ${bin.replace(/^any bin except /i, '')}` : `Bin not ${bin}`, s ? s.n - s.bin : undefined],
    ...(res?.hasStatus ? [['status', 'Status not UR', s ? s.n - s.st : undefined] as [State, string, number | undefined]] : []),
    ['nozm', 'System Batch not in ZMMBE', s ? s.n - s.zm : undefined],
    ['nozc', 'Not in ZCOMENT VIEW', s ? s.n - s.zc : undefined], ['nokorber', 'Not in Korber', s ? s.n - s.korber : undefined],
  ];
  return (
    <main className="page anim">
      <div className="page-head">
        <div>
          <h1>Data</h1>
          <p>The Pick&apos;s ZROLLMGT (roll management). A roll is picked only when its <b>Barcode Number</b> is in ZROLLMGT at {anyBut ? <>a StorageBin other than <b>{bin.replace(/^any bin except /i, '')}</b></> : <>StorageBin <b>{bin}</b></>}, is a <b>ZCOMENT VIEW Barcode Number</b> (of the line&apos;s ZMMBE batch) and is the <b>Korber Pallet</b> (Pick Id 0). A roll with no ZCOMENT barcode is matched on Invoice, Item and Lot, and its <b>Korber Pallet</b> must be in ZROLLMGT at {bin}. Every pick, manual roll and replacement is checked against it.</p>
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
            <div className="ok"><span>{anyBut ? 'In a bin to pick from' : `At ${bin}`}</span><b>{fmt(s.bin)}</b></div>
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

      <PalletHistory boss={isBossRole(user.role)} toast={toast} />
      <CutRolls rid={rid} />
    </main>
  );
}

interface PalletPick { id: number; day: string; plan: string; so: string; li: string; item: string; qty: number; roll_qty: number; partial: number; shade: string | null; batch: string | null; note: string | null; by_user: string; at: string; seq: number | null; pick_no: string | null; kind: string | null; auto: number | null }
interface PalletRes { pallet: string; korber: { item: string; lot: string | null; qty: number; location: string | null } | null; picks: PalletPick[]; rejects: { id: number; day: string; plan: string; so: string; li: string; qty: number; reason: string; by_user: string; replaced_by: string | null }[]; picked: number; base: number; left: number }
/** A Korber pallet's history (every pick of it, all days / Picks / users) — and, for Admin / Head, delete it. */
function PalletHistory({ boss, toast }: { boss: boolean; toast: (m: string) => void }) {
  const [q, setQ] = useState('');
  const [res, setRes] = useState<PalletRes | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const find = async (p = q) => {
    if (!p.trim()) return;
    setBusy(true); setErr('');
    try { setRes(await api<PalletRes>('/api/pick/pallet?p=' + encodeURIComponent(p.trim()))); } catch (e) { setRes(null); setErr(e instanceof Error ? e.message : 'Not found.'); } finally { setBusy(false); }
  };
  const del = async () => {
    if (!res) return;
    const t = prompt(`Delete the whole pick history of pallet ${res.pallet}?\n\n${res.picks.length} pick${res.picks.length === 1 ? '' : 's'} (${fmtQty(res.picked)})${res.rejects.length ? ` and ${res.rejects.length} reject${res.rejects.length === 1 ? '' : 's'}` : ''} are deleted: the plan lines lose that picked QTY and the pallet can be picked in full again. This cannot be undone.\n\nType DELETE to confirm.`);
    if (t === null) return;
    if (t.trim().toUpperCase() !== 'DELETE') { toast('Not deleted — type DELETE to confirm.'); return; }
    try { const r = await api<{ picks: number; rejects: number }>('/api/pick/pallet?p=' + encodeURIComponent(res.pallet), { method: 'DELETE' }); toast(`History of ${res.pallet} deleted (${r.picks} pick${r.picks === 1 ? '' : 's'}${r.rejects ? `, ${r.rejects} reject${r.rejects === 1 ? '' : 's'}` : ''})`); void find(res.pallet); }
    catch (e) { toast(e instanceof Error ? e.message : 'Could not delete.'); }
  };
  return (
    <section className="card" aria-labelledby="ph2-title">
      <div className="sheet-top">
        <div>
          <h2 id="ph2-title">Pallet history</h2>
          <p className="sub" style={{ margin: 0 }}>Scan or type a Korber pallet: every pick of it (all days, Picks and users) and its rejects.{boss ? ' Admin / Head can delete its history — the pallet is then pickable in full again.' : ''}</p>
        </div>
        <form style={{ display: 'flex', gap: 8 }} onSubmit={(e) => { e.preventDefault(); void find(); }}>
          <input className="as-search" autoComplete="off" placeholder="Pallet, e.g. CP000008064260" value={q} onChange={(e) => setQ(e.target.value.toUpperCase())} aria-label="Korber pallet" style={{ width: 230 }} />
          <button className="btn primary" disabled={busy || !q.trim()}>{busy ? 'Looking…' : 'Show history'}</button>
        </form>
      </div>
      {err && <div className="notice bad">{err}</div>}
      {res && (
        <>
          <div className="pk-stats" style={{ marginTop: 10 }}>
            <div><span>Pallet</span><b className="mono" style={{ fontSize: 15 }}>{res.pallet}</b><small>{res.korber ? `${res.korber.item} · lot ${res.korber.lot ?? '–'} · ${res.korber.location ?? ''}` : 'not in a Korber upload'}</small></div>
            <div><span>Roll QTY</span><b>{fmtQty(res.base)}</b></div>
            <div><span>Picked</span><b>{fmtQty(res.picked)}</b><small>{res.picks.length} pick{res.picks.length === 1 ? '' : 's'}</small></div>
            <div className={res.left > 1e-9 && res.picked > 0 ? 'em' : ''}><span>{res.picked > 0 ? (res.left > 1e-9 ? 'Cut roll — balance' : 'Picked in full') : 'Not picked'}</span><b>{fmtQty(res.left)}</b></div>
          </div>
          {!res.picks.length && !res.rejects.length ? <p className="muted">This pallet has no pick history.</p> : (
            <div className="table-wrap" style={{ maxHeight: 340, marginTop: 8 }}>
              <table className="mini">
                <thead><tr><th>Day</th><th>Plan</th><th>SO / LI</th><th>Item</th><th className="n">QTY</th><th>Batch</th><th>Shade</th><th>Pick</th><th>By</th><th>Note</th></tr></thead>
                <tbody>
                  {res.picks.map((x) => (
                    <tr key={`p${x.id}`}><td>{fmtDate(x.day)}</td><td className="small">{x.plan}</td><td>{x.so} / {x.li}</td><td>{x.item}</td><td className="n">{fmtQty(x.qty)}{x.partial ? <span className="pill accent" style={{ marginLeft: 4 }}>cut</span> : null}</td><td>{x.batch || '–'}</td><td>{x.shade || '–'}</td>
                      <td className="small">{x.seq ? `#${x.seq}` : ''}{x.pick_no ? ` · ${x.pick_no}` : ''}{x.auto ? ' · auto' : ''}</td><td>{x.by_user}</td><td className="small muted">{x.note || ''}</td></tr>
                  ))}
                  {res.rejects.map((x) => (
                    <tr key={`r${x.id}`}><td>{fmtDate(x.day)}</td><td className="small">{x.plan}</td><td>{x.so} / {x.li}</td><td /><td className="n">{fmtQty(x.qty)}</td><td colSpan={2}><span className="pill bad">Rejected · {x.reason}</span></td><td /><td>{x.by_user}</td><td className="small muted">{x.replaced_by ? `replaced by ${x.replaced_by}` : ''}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {boss && (res.picks.length > 0 || res.rejects.length > 0) && <div style={{ marginTop: 8 }}><button className="btn danger" onClick={del}>Delete this pallet&apos;s history</button></div>}
        </>
      )}
    </section>
  );
}

interface CutRoll { pallet: string; item: string; base: number; picked: number; balance: number; picks: number; last_at: string; last_day: string; lines: string; location: string | null; lot: string | null; in_korber: boolean; pick_id: string | null }
/** Cut rolls on the shelf: rolls picked in part — their balance is offered first when the same item is picked again. */
function CutRolls({ rid }: { rid: string }) {
  const [res, setRes] = useState<{ rows: CutRoll[]; total: number } | null>(null);
  useEffect(() => { api<{ rows: CutRoll[]; total: number }>('/api/pick/cutrolls' + (rid ? '?rid=' + encodeURIComponent(rid) : '')).then(setRes).catch(() => setRes({ rows: [], total: 0 })); }, [rid]);
  return (
    <section className="card" aria-labelledby="cr-title">
      <h2 id="cr-title">Cut rolls on the shelf {res && <span className="pill accent" style={{ marginLeft: 6 }}>{res.rows.length} · {fmtQty(res.total)}</span>}</h2>
      <p className="sub">Rolls picked in part (all days, Picks and users) and what is left of each. The pick window uses a cut roll&apos;s balance first and, when a roll has to be cut, cuts one that is already cut — so fewer rolls are cut.</p>
      {!res ? <Loader label="Loading cut rolls…" /> : !res.rows.length ? <p className="muted">No cut roll on the shelf.</p> : (
        <div className="table-wrap" style={{ maxHeight: 360 }}>
          <table className="mini">
            <thead><tr><th>Pallet</th><th>Item</th><th>Lot</th><th>Location</th><th className="n">Roll QTY</th><th className="n">Picked</th><th className="n">Balance</th><th>Picks</th><th>Last pick</th><th>In this Pick&apos;s Korber</th></tr></thead>
            <tbody>{res.rows.map((r) => (
              <tr key={r.pallet}><td className="mono">{r.pallet}</td><td>{r.item}</td><td>{r.lot || '–'}</td><td>{r.location || '–'}</td><td className="n">{fmtQty(r.base)}</td><td className="n">{fmtQty(r.picked)}</td><td className="n"><b>{fmtQty(r.balance)}</b></td>
                <td className="small" title={r.lines}>{r.picks} · {r.lines.split(',').slice(0, 2).join(', ')}{r.lines.split(',').length > 2 ? '…' : ''}</td><td className="small">{fmtDate(r.last_day)} · {ago(r.last_at)}</td>
                <td>{r.in_korber ? (r.pick_id && r.pick_id !== '0' ? <span className="pill warn">Pick Id {r.pick_id}</span> : <span className="pill ok">yes</span>) : <span className="muted">no</span>}</td></tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </section>
  );
}
