'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, getSession, isBossRole } from '@/lib/api';
import { fmt, type Line } from '@/lib/calc';
import { fmtTime } from '@/lib/summary';
import { korberWorkbook, ordinal, packingListWorkbook, saveWorkbook, type PickHistory, type PickReq } from '@/lib/pick';

const q = (n: number) => fmt(Math.round(n * 1000) / 1000, 2);
const dmy = (d: string) => (d ? `${d.slice(8, 10)}-${d.slice(5, 7)}-${d.slice(0, 4)}` : '');

/**
 * The completed (saved) picks of the plan on screen: every pick of its lines, newest first, with the time it was saved.
 * Mark picks (none marked = all shown) and download their Packing List or Korber Inventory rows.
 * `reloadKey` changes whenever the dashboard reloads (a new pick, upload…), so the list follows live.
 */
export default function PlanPicks({ rows, label, reloadKey, plantName }: { rows: Line[]; label: string; reloadKey?: string | null; plantName?: (code: string) => string }) {
  const weeks = useMemo(() => Array.from(new Set(rows.map((r) => r.week).filter(Boolean))).sort(), [rows]);
  const lineIds = useMemo(() => new Set(rows.map((r) => `${r.key}|${r.date ?? ''}`)), [rows]);
  const planOf = useMemo(() => new Map(rows.map((r) => [`${r.key}|${r.date ?? ''}`, r])), [rows]);
  const [h, setH] = useState<PickHistory | null>(null);
  const [err, setErr] = useState('');
  const load = useCallback(async () => {
    try {
      const hs = await Promise.all(weeks.map((w) => api<PickHistory>('/api/pick/history?week=' + encodeURIComponent(w))));
      const reqs = hs.flatMap((x) => x.requests).filter((r) => !r.cancelled_at && lineIds.has(r.line));
      const ids = new Set(reqs.map((r) => r.id));
      setH({ day: null, requests: reqs, picks: hs.flatMap((x) => x.picks).filter((p) => ids.has(p.req_id)), days: [], korberHeader: hs.find((x) => x.korberHeader)?.korberHeader ?? null });
      setErr('');
    } catch (e) { setErr(e instanceof Error ? e.message : 'Could not load the picks.'); }
  }, [weeks, lineIds]);
  useEffect(() => { void load(); }, [load, reloadKey]);

  const [pfcSlocs, setPfcSlocs] = useState<string[]>(['41', 'COMF']);
  useEffect(() => { api<{ settings: { pfcSlocs?: string[] } }>('/api/settings').then((r) => { if (r.settings.pfcSlocs?.length) setPfcSlocs(r.settings.pfcSlocs); }).catch(() => {}); }, []);

  // filters
  const [day, setDay] = useState('');
  const [plant, setPlant] = useState('');
  const [who, setWho] = useState('');
  const [search, setSearch] = useState('');
  const all = useMemo(() => [...(h?.requests || [])].sort((a, b) => String(b.at).localeCompare(String(a.at))), [h]);
  const days = useMemo(() => Array.from(new Set(all.map((r) => r.day))).sort().reverse(), [all]);
  const plants = useMemo(() => Array.from(new Set(all.map((r) => r.plant || ''))).filter(Boolean).sort(), [all]);
  const users = useMemo(() => Array.from(new Set(all.map((r) => r.by_user))).sort(), [all]);
  const shown = useMemo(() => {
    const s = search.trim().toLowerCase();
    return all.filter((r) => (!day || r.day === day) && (!plant || r.plant === plant) && (!who || r.by_user === who)
      && (!s || [r.so, r.li, r.item, r.pick_no, r.by_user].join(' ').toLowerCase().includes(s)));
  }, [all, day, plant, who, search]);

  const [sel, setSel] = useState<Set<number>>(new Set());
  useEffect(() => { setSel(new Set()); }, [day, plant, who, search, label]);
  const flip = (id: number) => setSel((x) => { const n = new Set(x); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const marked = shown.filter((r) => sel.has(r.id));
  const allOn = shown.length > 0 && marked.length === shown.length;
  const target = marked.length ? marked : shown; // none marked = every pick shown
  const [oneSheet, setOneSheet] = useState(() => { try { return localStorage.getItem('pl_one_sheet') !== '0'; } catch { return true; } });
  const setOne = (v: boolean) => { setOneSheet(v); try { localStorage.setItem('pl_one_sheet', v ? '1' : '0'); } catch { /* private mode */ } };
  const tag = `${label.replace(/[^\w-]+/g, '_')}${marked.length ? `_${marked.length}picks` : ''}`;
  const ids = new Set(target.map((r) => r.id));
  // the Packing List also gets the plan (dashboard table) of the Picks in it
  // plant names (Settings → Plants) for the Packing List header
  const [plantNames, setPlantNames] = useState<Record<string, string>>({});
  useEffect(() => { api<{ plants: { code: string; name: string | null }[] }>('/api/plants').then((r) => setPlantNames(Object.fromEntries(r.plants.map((x) => [x.code.toUpperCase(), x.name || x.code])))).catch(() => {}); }, []);
  const downloadPL = () => {
    if (!h) return;
    const weeks = new Set(target.map((r) => r.week));
    saveWorkbook(packingListWorkbook(h, { ids, combined: oneSheet, pfcSlocs, plan: rows.filter((l) => weeks.has(l.week)), planTitle: `Plan · ${label}`, plantNames }), `Packing_List_${tag}.xlsx`);
  };
  const downloadKorber = () => h && saveWorkbook(korberWorkbook(h, ids), `Korber_Picked_${tag}.xlsx`);
  // cancel the marked picks together (own picks; Admin / Head: anyone's) — they leave the history, their rolls are free again
  const me = getSession()?.user.username || '';
  const boss = isBossRole(getSession()?.user.role);
  const canEdit = getSession()?.user.role !== 'viewer';
  const cancelable = marked.filter((r) => boss || r.by_user === me);
  const [busy, setBusy] = useState('');
  const cancelMarked = async () => {
    if (!cancelable.length || !confirm(`Cancel ${cancelable.length} marked pick${cancelable.length === 1 ? '' : 's'} (${q(cancelable.reduce((t, r) => t + Number(r.qty), 0))} QTY)? They are deleted from the pick history and their rolls become pickable again.${marked.length > cancelable.length ? `\n${marked.length - cancelable.length} marked pick(s) of another user stay.` : ''}`)) return;
    let ok = 0, bad = 0;
    for (const r of cancelable) { setBusy(`Cancelling ${ok + bad + 1} / ${cancelable.length}…`); try { await api(`/api/pick/req/${r.id}`, { method: 'DELETE' }); ok++; } catch { bad++; } }
    setBusy(''); setSel(new Set()); setMsg(`${ok} pick${ok === 1 ? '' : 's'} cancelled${bad ? ` · ${bad} could not be cancelled` : ''}`); void load();
  };
  const [msg, setMsg] = useState('');

  const tot = (list: PickReq[]) => ({ qty: list.reduce((t, r) => t + Number(r.qty), 0), rolls: list.reduce((t, r) => t + Number(r.rolls), 0), lines: new Set(list.map((r) => r.line)).size });
  const T = tot(shown);
  const cutOf = (id: number) => (h?.picks || []).filter((p) => p.req_id === id && p.partial).length;
  const last = all[0];

  return (
    <section className="card" aria-labelledby="pp-title">
      <div className="table-head">
        <div>
          <h2 id="pp-title">Completed picks <span className="pill accent" style={{ marginLeft: 8, fontSize: 12 }}>{label}</span></h2>
          <p className="sub" style={{ margin: 0 }}>Every saved pick of this plan&apos;s lines, newest first, with the time it was saved. Mark picks (none marked = all shown) and download the Packing List or the Korber rows.</p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <label className="pp-opt"><input type="radio" checked={oneSheet} onChange={() => setOne(true)} /> One sheet</label>
          <label className="pp-opt"><input type="radio" checked={!oneSheet} onChange={() => setOne(false)} /> Sheet per pick</label>
          <button className="btn sm primary" disabled={!target.length || !h} onClick={downloadPL}>Packing List{marked.length ? ` (${marked.length})` : ''}</button>
          <button className="btn sm" disabled={!target.length || !h} onClick={downloadKorber}>Korber Inventory</button>
          {canEdit && marked.length > 0 && <button className="btn sm danger" disabled={!cancelable.length || !!busy} onClick={cancelMarked} title={cancelable.length ? 'Cancel the marked picks' : 'You can cancel only your own picks'}>{busy || `Cancel marked (${cancelable.length})`}</button>}
        </div>
      </div>

      <div className="pp-kpis">
        <div><span>Picks</span><b>{fmt(shown.length)}</b></div>
        <div><span>SO/LI lines</span><b>{fmt(T.lines)}<small> / {fmt(lineIds.size)}</small></b></div>
        <div><span>Picked QTY</span><b>{q(T.qty)}</b></div>
        <div><span>Rolls</span><b>{fmt(T.rolls)}</b></div>
        <div><span>Last pick</span><b>{last ? `${fmtTime(last.at)}` : '–'}{last && <small> {dmy(last.day)} · {last.by_user}</small>}</b></div>
      </div>

      <div className="filters" role="group" aria-label="Pick filters">
        <select aria-label="Pick day" value={day} onChange={(e) => setDay(e.target.value)}><option value="">All pick days</option>{days.map((d) => <option key={d} value={d}>{dmy(d)}</option>)}</select>
        {plants.length > 1 && <select aria-label="Plant" value={plant} onChange={(e) => setPlant(e.target.value)}><option value="">All plants</option>{plants.map((p) => <option key={p} value={p}>{plantName ? plantName(p) : p}</option>)}</select>}
        {users.length > 1 && <select aria-label="Picked by" value={who} onChange={(e) => setWho(e.target.value)}><option value="">Everyone</option>{users.map((u) => <option key={u} value={u}>{u}</option>)}</select>}
        <input type="search" placeholder="Search SO, item, pick no…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search picks" />
      </div>

      {err && <div className="notice bad">{err}</div>}
      {msg && <div className="notice ok">{msg}</div>}
      {!h && !err && <p className="sub">Loading picks…</p>}
      {h && !shown.length && <div className="empty" style={{ padding: 24 }}><strong>No picks yet</strong><span>Picks saved for this plan&apos;s lines show here the moment they are saved.</span></div>}
      {h && shown.length > 0 && (
        <div className="psum-wrap">
          <table className="psum pp-table">
            <thead><tr>
              <th><input type="checkbox" aria-label="Mark all" checked={allOn} onChange={() => setSel(allOn ? new Set() : new Set(shown.map((r) => r.id)))} /></th>
              <th>Time</th><th>Pick day</th><th>Pick</th><th>Pick No</th><th>Plant</th><th>SO</th><th>LI</th><th>Item</th><th>Plan date</th>
              <th className="n">Plan QTY</th><th className="n">Picked</th><th className="n">Rolls</th><th className="n">Cut</th><th>Type</th><th>Status</th><th>By</th>
            </tr></thead>
            <tbody>{shown.map((r) => {
              const pl = planOf.get(r.line);
              const need = Number(r.need) || 0, got = Number(r.qty) || 0;
              const status = r.closed ? `Closed · ${q(Number(r.short) || 0)} short` : got >= need - 1e-6 ? (got > need + 1e-6 ? `Full · +${q(got - need)}` : 'Full') : `Part · ${q(need - got)} left`;
              const cut = cutOf(r.id);
              return (
                <tr key={r.id} className={sel.has(r.id) ? 'on' : ''} onClick={() => flip(r.id)}>
                  <td onClick={(e) => e.stopPropagation()}><input type="checkbox" aria-label={`Mark pick ${r.so} ${r.li}`} checked={sel.has(r.id)} onChange={() => flip(r.id)} /></td>
                  <td className="strong">{fmtTime(r.at)}</td><td>{dmy(r.day)}</td><td>{ordinal(r.seq)}</td><td>{r.pick_no || ''}</td>
                  <td>{r.plant ? (plantName ? plantName(r.plant) : r.plant) : ''}</td><td>{r.so}</td><td>{r.li}</td><td>{r.item}</td><td>{pl?.date ? dmy(pl.date) : ''}</td>
                  <td className="n">{q(need)}</td><td className="n strong">{q(got)}</td><td className="n">{fmt(r.rolls)}</td><td className="n">{cut || ''}</td>
                  <td>{r.kind === 'offsite' ? 'Offsite' : 'Normal'}</td>
                  <td><span className={`pp-st ${r.closed ? 'closed' : got >= need - 1e-6 ? 'full' : 'part'}`}>{status}</span></td>
                  <td>{r.by_user}</td>
                </tr>
              );
            })}</tbody>
            <tfoot><tr>
              <td /><td colSpan={9} className="pname" style={{ textAlign: 'left' }}>{marked.length ? `${marked.length} marked of ${shown.length}` : `${shown.length} picks`}</td>
              <td className="n">{q(shown.reduce((t, r) => t + Number(r.need), 0))}</td><td className="n strong">{q(T.qty)}</td><td className="n">{fmt(T.rolls)}</td><td colSpan={4} />
            </tr></tfoot>
          </table>
        </div>
      )}
    </section>
  );
}
