'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { getSession, isBossRole } from '@/lib/api';
import { ago } from '@/lib/calc';
import { downloadFile, fmtSize, listFiles, type KeptFile } from '@/lib/files';

const SRC_NAME: Record<string, string> = {
  plan: 'Plan', zmmbe: 'ZMMBE', kfc: 'ZMMBE KFC', pfc: 'ZMMBE PFC', plant: 'PLANT', trr: 'TRR',
  zinr: 'ZINR', zcoment: 'ZCOMENT VIEW', korber: 'Korber Inventory', zroll: 'ZROLLMGT', ztrr: 'ZMM_TRR',
};
/** "2026-10-23~C064~1" → "23-10 · C064 · Pick 1", "2026-W44@ASIALLINE" → "W44 · ASIALLINE" */
export function scopeName(rid: string | null) {
  if (!rid) return 'Shared';
  const d = /^(\d{4})-(\d{2})-(\d{2})~([^~]*)~(\d+)$/.exec(rid);
  if (d) return `${d[3]}-${d[2]} · ${d[4] === '-' ? 'No plant' : d[4]} · Pick ${d[5]}`;
  const w = /^\d{4}-(W\d{2})(?:@(.+))?$/.exec(rid);
  if (w) return w[2] ? `${w[1]} · ${w[2]}` : `Week ${w[1]}`;
  return rid;
}

/**
 * Every uploaded Excel file, kept exactly as it was uploaded (same bytes, same name): download it again any time.
 * The newest 15 files of each report and scope are kept.
 */
export default function UploadedFiles({ toast, rid, title = 'Uploaded files' }: { toast: (m: string) => void; rid?: string | null; title?: string }) {
  const [res, setRes] = useState<Awaited<ReturnType<typeof listFiles>> | null>(null);
  const [src, setSrc] = useState('');
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState<number | null>(null);
  const me = getSession()?.user;
  const load = useCallback(() => { listFiles(rid === undefined ? {} : { rid }).then(setRes).catch(() => setRes({ files: [], total: { n: 0, size: 0 }, keep: 15, max: 0 })); }, [rid]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { const f = () => load(); window.addEventListener('mas-files-changed', f); return () => window.removeEventListener('mas-files-changed', f); }, [load]);
  const files = res?.files || [];
  const srcs = useMemo(() => Array.from(new Set(files.flatMap((f) => f.srcs.split(',')).filter(Boolean))).sort(), [files]);
  const shown = files.filter((f) => (!src || f.srcs.split(',').includes(src)) && (!q.trim() || `${f.name} ${scopeName(f.rid)} ${f.uploaded_by}`.toLowerCase().includes(q.trim().toLowerCase())));
  const get = async (f: KeptFile) => {
    setBusy(f.id);
    try { await downloadFile(f); } catch (e) { toast(e instanceof Error ? e.message : 'Could not download.'); } finally { setBusy(null); }
  };
  const del = async (f: KeptFile) => {
    if (!confirm(`Delete the kept file ${f.name}? The data it uploaded stays in the system.`)) return;
    try { const { api } = await import('@/lib/api'); await api('/api/files?id=' + f.id, { method: 'DELETE' }); toast(`${f.name} deleted`); load(); } catch (e) { toast(e instanceof Error ? e.message : 'Could not delete.'); }
  };
  return (
    <section className="card" aria-labelledby="uf-title">
      <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <h2 id="uf-title" style={{ margin: 0 }}>{title}</h2>
        {res && <span className="muted small">{res.total.n} file{res.total.n === 1 ? '' : 's'} · {fmtSize(Number(res.total.size) || 0)} kept</span>}
      </div>
      <p className="sub">Every Excel file uploaded is kept exactly as it was — the same file downloads again (same sheets, columns and name). The newest {res?.keep ?? 15} of each report and Pick / week are kept. Internal data: share only inside the team.</p>
      {files.length > 0 && (
        <div className="uf-bar">
          <div className="chips">
            <button className={`chip ${!src ? 'on' : ''}`} onClick={() => setSrc('')}>All ({files.length})</button>
            {srcs.map((s) => <button key={s} className={`chip ${src === s ? 'on' : ''}`} onClick={() => setSrc(s)}>{SRC_NAME[s] || s.toUpperCase()} ({files.filter((f) => f.srcs.split(',').includes(s)).length})</button>)}
          </div>
          <input className="as-search" placeholder="Search file, Pick, user" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search files" />
        </div>
      )}
      {!res ? <p className="muted">Loading…</p> : !files.length ? <p className="muted">No files kept yet — files uploaded from now on appear here.</p> : (
        <div className="table-wrap" style={{ maxHeight: 420 }}>
          <table className="mini">
            <thead><tr><th>File</th><th>Report</th><th>Pick / week</th><th>By</th><th>Uploaded</th><th className="n">Size</th><th /></tr></thead>
            <tbody>{shown.map((f) => (
              <tr key={f.id}>
                <td className="mono small" style={{ wordBreak: 'break-all' }}>{f.name}</td>
                <td>{f.srcs.split(',').filter(Boolean).map((s) => <span key={s} className="pill info" style={{ marginRight: 4 }}>{SRC_NAME[s] || s.toUpperCase()}</span>)}</td>
                <td>{scopeName(f.rid)}</td>
                <td>{f.uploaded_by}</td>
                <td className="small" title={new Date(f.uploaded_at).toLocaleString()}>{ago(f.uploaded_at)}</td>
                <td className="n">{fmtSize(f.size)}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <button className="btn sm primary" disabled={busy === f.id} aria-busy={busy === f.id || undefined} onClick={() => get(f)}>{busy === f.id ? 'Downloading…' : 'Download'}</button>
                  {(isBossRole(me?.role) || me?.username === f.uploaded_by) && me?.role !== 'viewer' && <button className="btn sm" style={{ marginLeft: 4 }} onClick={() => del(f)} aria-label={`Delete ${f.name}`}>✕</button>}
                </td>
              </tr>
            ))}</tbody>
          </table>
          {!shown.length && <p className="muted">No file matches.</p>}
        </div>
      )}
    </section>
  );
}
