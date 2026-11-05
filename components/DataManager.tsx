'use client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { setBudget } from '@/lib/budget';

/** v151 Settings → Data manager: the month's D1 rows read against the plan, the pace, the level and what uses the most. */
type Usage = {
  month: string; limit: number; mode: 'auto' | 'normal' | 'saver' | 'strict'; level: 'normal' | 'saver' | 'strict'; auto: string;
  used: number; written: number; projected: number; pct: number; daysIn: number; elapsed: number; dailyLeft: number;
  days: { day: string; r: number; w: number; q: number }[]; eps: { ep: string; r: number; w: number; q: number }[]; since7: string;
};
const B = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n)));
const FEATURE: [RegExp, string, string][] = [
  [/^GET \/api\/pullplan/, 'Day / Week plan dashboard', 'Day / Week plan dashboard එක'],
  [/^GET \/api\/pick\/candidates/, 'Pick window — matching rolls', 'Pick window එකේ rolls match කිරීම'],
  [/^GET \/api\/pick\/tally/, 'Cut roll tally (Packing List)', 'Cut roll tally (Packing List)'],
  [/^GET \/api\/pick\/history/, 'Pick history', 'Pick history'],
  [/^GET \/api\/pick\/status/, 'Pick data card', 'Pick data card එක'],
  [/^GET \/api\/pick\/korber/, 'Korber roll search', 'Korber roll search'],
  [/^GET \/api\/pick\/alt/, 'Batch complete panel', 'Batch complete panel'],
  [/^GET \/api\/plan-report/, 'Plan → Pick report', 'Plan → Pick report'],
  [/^POST \/api\/pick\/upload|^POST \/api\/upload/, 'Uploads', 'Uploads'],
  [/^POST \/api\/pick(\/auto)?$/, 'Saving picks', 'Picks save කිරීම'],
  [/^POST \/api\/pick\/tally/, 'Saving tallies', 'Tally save කිරීම'],
  [/\/api\/online/, 'Signed-in check', 'Sign in check එක'],
  [/\/api\/advice/, 'Smart Coach', 'Smart Coach'],
  [/\/api\/changes/, 'Change check', 'වෙනස් වීම් check එක'],
];
const featureOf = (ep: string) => FEATURE.find(([re]) => re.test(ep)) ?? null;

export default function DataManager({ toast }: { toast: (m: string) => void }) {
  const [u, setU] = useState<Usage | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [limitB, setLimitB] = useState('25');
  const [mode, setMode] = useState<Usage['mode']>('auto');
  const load = useCallback(() => api<Usage>('/api/usage').then((r) => { setU(r); setLimitB(String(r.limit / 1e9)); setMode(r.mode); setBudget(r.level, r.pct); }).catch((e) => setErr(e instanceof Error ? e.message : 'Could not load.')), []);
  useEffect(() => { void load(); }, [load]);
  const save = async () => {
    setBusy(true); setErr('');
    try { const r = await api<Usage>('/api/usage', { method: 'POST', body: { limit: Number(limitB) * 1e9, mode } }); setU(r); setBudget(r.level, r.pct); toast('Data plan saved'); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Could not save.'); } finally { setBusy(false); }
  };
  if (!u) return <section className="card">{err ? <div className="notice bad">{err}</div> : <div className="skel" style={{ height: 160 }} />}</section>;
  const usedPct = Math.min(100, (u.used / u.limit) * 100), projPct = Math.min(130, u.pct * 100);
  const tone = u.pct > 1.15 ? 'bad' : u.pct > 0.9 ? 'warn' : 'ok';
  const daily = u.limit / u.daysIn;
  const maxDay = Math.max(daily * 1.2, ...u.days.map((d) => Number(d.r)));
  const totEp = u.eps.reduce((t, e) => t + Number(e.r), 0) || 1;
  const LV = { normal: 'Normal', saver: 'Saver', strict: 'Strict' } as const;
  return (
    <section className="card set-card dm">
      <h2>Data manager</h2>
      <p className="sub">Keeps the month&apos;s Cloudflare D1 <b>rows read</b> inside the plan. When the month is heading over it, pages reload less often (Saver / Strict). Pick rules, checks and saves never change — a pick is always checked against the database when it is saved.</p>
      <p className="sub si" lang="si">මාසයේ D1 rows read ගණන plan එක ඇතුලේ තියාගන්නවා. මාසය plan එකට වඩා යන වේගයක් නම් pages reload වෙන වාර අඩු කරනවා (Saver / Strict). Pick rules, checks, save කිරීම කවදාවත් වෙනස් වෙන්නේ නැහැ.</p>

      <div className={`dm-gauge tone-${tone}`}>
        <div className="dm-num"><span>This month ({u.month})</span><b>{B(u.used)}</b><small>of {B(u.limit)} · day {u.elapsed} of {u.daysIn}</small></div>
        <div className="dm-num"><span>Month end at this pace</span><b>{B(u.projected)}</b><small>{Math.round(u.pct * 100)}% of the plan</small></div>
        <div className="dm-num"><span>Per day left</span><b>{B(u.dailyLeft)}</b><small>to stay inside the plan</small></div>
        <div className="dm-num"><span>Level now</span><b className={`lv lv-${u.level}`}>{LV[u.level]}</b><small>{u.mode === 'auto' ? 'Auto' : 'Set by hand'}</small></div>
        <div className="dm-bar" role="img" aria-label={`Used ${Math.round(usedPct)}%, heading for ${Math.round(u.pct * 100)}%`}>
          <i className="proj" style={{ width: `${Math.min(100, projPct / 1.3)}%` }} />
          <i className="used" style={{ width: `${usedPct / 1.3}%` }} />
          <span className="mark" style={{ left: `${100 / 1.3}%` }} title="The plan (100%)" />
        </div>
      </div>

      <h3 className="dm-h">Rows read per day (last 30 days)</h3>
      <div className="dm-days">
        {u.days.map((d) => (
          <div key={d.day} className={`dm-day ${Number(d.r) > daily ? 'over' : ''}`} title={`${d.day}: ${B(Number(d.r))} read · ${B(Number(d.w))} written · ${Number(d.q).toLocaleString()} requests`}>
            <i style={{ height: `${Math.max(2, (Number(d.r) / maxDay) * 100)}%` }} />
          </div>
        ))}
        <span className="dm-line" style={{ bottom: `${(daily / maxDay) * 100}%` }}><em>plan per day {B(daily)}</em></span>
      </div>

      <h3 className="dm-h">What reads the most (since {u.since7})</h3>
      {!u.eps.length ? <p className="muted small">Counting starts with this version — come back in a little while.</p> : (
        <div className="table-wrap" style={{ maxHeight: 360 }}>
          <table className="mini">
            <thead><tr><th>Feature</th><th className="n">Rows read</th><th className="n">Share</th><th className="n">Requests</th><th className="n">Per request</th></tr></thead>
            <tbody>{u.eps.map((e) => {
              const f = featureOf(e.ep);
              return (
                <tr key={e.ep}>
                  <td><b>{f ? f[1] : e.ep}</b>{f && <span className="muted small si" lang="si"> · {f[2]}</span>}<div className="muted small mono">{e.ep}</div></td>
                  <td className="n">{B(Number(e.r))}</td>
                  <td className="n"><span className="dm-share"><i style={{ width: `${(Number(e.r) / totEp) * 100}%` }} /></span>{Math.round((Number(e.r) / totEp) * 100)}%</td>
                  <td className="n">{Number(e.q).toLocaleString()}</td>
                  <td className="n">{B(Number(e.r) / Math.max(1, Number(e.q)))}</td>
                </tr>
              );
            })}</tbody>
          </table>
        </div>
      )}

      <h3 className="dm-h">Plan and level</h3>
      <div className="set-grid">
        <label className="set-row">
          <span><b>Rows read in the plan (billion / month)</b><small>Workers Paid includes 25 billion a month; more costs $0.001 per million.</small></span>
          <input type="number" min={0.1} step={0.5} value={limitB} onChange={(e) => setLimitB(e.target.value)} style={{ width: 110 }} />
        </label>
        <label className="set-row">
          <span><b>Level</b><small>Auto: Normal under 90% of the plan, Saver at 90–115%, Strict over 115% (or the plan used up). Saver: a burst of changes reloads once after 20 s, kept results 45 min, signed-in check 90 s. Strict: 60 s, 90 min, 3 min.</small></span>
          <select value={mode} onChange={(e) => setMode(e.target.value as Usage['mode'])}>
            <option value="auto">Auto (recommended)</option><option value="normal">Normal</option><option value="saver">Saver</option><option value="strict">Strict</option>
          </select>
        </label>
      </div>
      <div className="notice info" style={{ fontSize: 12.5 }}>
        Always on: a tab that is not open in front keeps its changes and reloads once when you come back to it.
        <span className="si" lang="si"> පිටුපස තියෙන (open නැති) tabs reload වෙන්නේ නැහැ — ආයෙත් open කලාම එක පාරක් reload වෙනවා.</span>
      </div>
      {err && <div className="notice bad">{err}</div>}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button className="btn" onClick={() => void load()}>↻ Refresh</button>
        <button className="btn primary" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
    </section>
  );
}
