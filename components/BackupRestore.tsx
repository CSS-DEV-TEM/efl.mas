'use client';
import { useRef, useState } from 'react';
import { api } from '@/lib/api';
import { fmt } from '@/lib/calc';

interface Meta { app: string; api: number; schema: string; at: string; by: string; tables: { name: string; rows: number }[] }
interface BackupFile extends Meta { tables: { name: string; rows: number }[]; data: Record<string, { cols: string[]; rows: unknown[][] }> }

const stamp = (iso: string) => iso.replace(/[-:]/g, '').replace('T', '_').slice(0, 15);

/**
 * Backup: every data table (plans, picks, statuses, reports, plants, settings…) into one .json file, page by page.
 * Restore: the file replaces those tables. Users / passwords and the system keys are never in a backup and never touched.
 */
export default function BackupRestore({ toast }: { toast: (m: string) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [pct, setPct] = useState(0);
  const [err, setErr] = useState('');
  const [file, setFile] = useState<{ name: string; b: BackupFile } | null>(null);
  const [confirm, setConfirm] = useState('');
  const input = useRef<HTMLInputElement>(null);

  const backup = async () => {
    setBusy('Making the backup…'); setErr(''); setPct(0);
    try {
      const meta = await api<Meta>('/api/backup');
      const total = meta.tables.reduce((t, x) => t + x.rows, 0) || 1;
      let done = 0;
      const data: BackupFile['data'] = {};
      for (const t of meta.tables) {
        const d: { cols: string[]; rows: unknown[][] } = { cols: [], rows: [] };
        let after = 0;
        for (;;) {
          const r = await api<{ cols: string[]; rows: unknown[][]; last: number; done: boolean }>(`/api/backup/rows?table=${encodeURIComponent(t.name)}&after=${after}&limit=${t.name === 'korber' ? 1500 : 4000}`);
          d.cols = r.cols; d.rows.push(...r.rows); after = r.last; done += r.rows.length;
          setPct(Math.min(99, Math.round((done / total) * 100))); setBusy(`Backing up ${t.name}… ${fmt(d.rows.length)} / ${fmt(t.rows)}`);
          if (r.done || !r.rows.length) break;
        }
        data[t.name] = d;
      }
      const out: BackupFile = { ...meta, tables: meta.tables.map((t) => ({ name: t.name, rows: data[t.name]?.rows.length ?? 0 })), data };
      const blob = new Blob([JSON.stringify(out)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = `MAS_Tracker_Backup_${stamp(meta.at)}.json`; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      setPct(100); toast(`Backup saved: ${fmt(done)} rows in ${meta.tables.length} tables`);
    } catch (e) { setErr(e instanceof Error ? e.message : 'Could not make the backup.'); } finally { setBusy(null); }
  };

  const pick = async (f: File) => {
    setErr(''); setFile(null); setConfirm('');
    try {
      const b = JSON.parse(await f.text()) as BackupFile;
      if (b.app !== 'mas-weekly-plan-tracker' || !b.data) throw new Error('This is not a MAS AUTOMATE PICK SYSTEM backup file.');
      setFile({ name: f.name, b });
    } catch (e) { setErr(e instanceof Error ? e.message : 'Could not read the file.'); }
  };

  const restore = async () => {
    if (!file) return;
    const { b, name } = file;
    setBusy('Restoring…'); setErr(''); setPct(0);
    try {
      const tables = Object.keys(b.data);
      const begin = await api<{ tables: string[] }>('/api/restore/begin', { method: 'POST', body: { tables } });
      const total = begin.tables.reduce((t, n) => t + (b.data[n]?.rows.length || 0), 0) || 1;
      let done = 0;
      for (const t of begin.tables) {
        const d = b.data[t]; const step = t === 'korber' ? 800 : 2500;
        for (let i = 0; i < d.rows.length; i += step) {
          await api('/api/restore/rows', { method: 'POST', body: { table: t, cols: d.cols, rows: d.rows.slice(i, i + step) } });
          done += Math.min(step, d.rows.length - i);
          setPct(Math.min(99, Math.round((done / total) * 100))); setBusy(`Restoring ${t}… ${fmt(Math.min(i + step, d.rows.length))} / ${fmt(d.rows.length)}`);
        }
      }
      await api('/api/restore/end', { method: 'POST', body: { file: name } });
      setPct(100); setFile(null); setConfirm('');
      toast(`Restored ${fmt(done)} rows from ${name}`);
    } catch (e) { setErr(`${e instanceof Error ? e.message : 'Restore stopped.'} — the restore did not finish. Run it again with the same file.`); } finally { setBusy(null); }
  };

  return (
    <section className="card" aria-labelledby="bk-title">
      <h2 id="bk-title">Backup &amp; Restore</h2>
      <p className="sub">A backup is one .json file with every plan (all Picks), the pick history and Packing List data, statuses, the reports (ZMMBE, ZINR, ZCOMENT, Korber…), plants and settings. <b>Users and passwords are never in it</b> and a restore never changes them. Keep backups internal — they hold real SO data.</p>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', margin: '12px 0' }}>
        <button className="btn primary" disabled={!!busy} onClick={backup}>Download backup</button>
        <button className="btn" disabled={!!busy} onClick={() => input.current?.click()}>Restore from a backup…</button>
        <input ref={input} type="file" accept=".json,application/json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void pick(f); e.target.value = ''; }} />
      </div>
      {busy && <div className="bk-progress"><span>{busy}</span><div className="prog"><i style={{ width: `${pct}%` }} /><b>{pct}%</b></div></div>}
      {err && <div className="notice bad">{err}</div>}
      {file && !busy && (
        <div className="notice warn" style={{ display: 'grid', gap: 8 }}>
          <div><b>{file.name}</b> — made {new Date(file.b.at).toLocaleString()} by {file.b.by} · {fmt(file.b.tables.reduce((t, x) => t + x.rows, 0))} rows in {file.b.tables.length} tables.</div>
          <div className="muted small">{file.b.tables.filter((t) => t.rows).map((t) => `${t.name} ${fmt(t.rows)}`).join(' · ')}</div>
          <div><b>The data now in the system (plans, picks, reports, settings) is replaced by this file.</b> Download a backup of the current data first if you may need it. Type <b>RESTORE</b> to go on.</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <input value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="RESTORE" aria-label="Type RESTORE to confirm" style={{ padding: '6px 8px', border: '1px solid var(--line-strong)', borderRadius: 6, background: 'var(--panel)', color: 'var(--ink)' }} />
            <button className="btn primary" disabled={confirm.trim().toUpperCase() !== 'RESTORE'} onClick={restore}>Restore now</button>
            <button className="btn" onClick={() => { setFile(null); setConfirm(''); }}>Cancel</button>
          </div>
        </div>
      )}
    </section>
  );
}
