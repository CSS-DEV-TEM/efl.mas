'use client';
import { api } from './api';

/**
 * The uploaded Excel files are kept exactly as they were (same bytes, same name) so anyone can download them again:
 * Uploads → Uploaded files, and the "Original" link next to each report. The file goes up in parts of 750 KB.
 */
export interface KeptFile { id: number; name: string; mime: string | null; size: number; srcs: string; rid: string | null; uploaded_by: string; uploaded_at: string; parts: number }

const PART = 750 * 1024;

function b64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
async function sha256(buf: ArrayBuffer): Promise<string | null> {
  try { const h = await crypto.subtle.digest('SHA-256', buf); return Array.from(new Uint8Array(h)).map((b) => b.toString(16).padStart(2, '0')).join(''); } catch { return null; }
}

/** Keeps the original file after its upload worked. Never throws: the upload itself is already saved. */
export async function keepFile(file: File | null | undefined, srcs: string[], rid?: string | null): Promise<boolean> {
  if (!file || !file.size) return false;
  try {
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    const parts = Math.max(1, Math.ceil(bytes.length / PART));
    const st = await api<{ id: number; dup?: boolean }>('/api/files/start', { method: 'POST', body: { name: file.name, size: bytes.length, mime: file.type || null, sha: await sha256(buf), srcs, rid: rid || null, parts } });
    if (st.dup) return true;
    for (let n = 0; n < parts; n++) await api('/api/files/part', { method: 'POST', body: { id: st.id, n, data: b64(bytes.subarray(n * PART, (n + 1) * PART)) } });
    await api('/api/files/done', { method: 'POST', body: { id: st.id } });
    window.dispatchEvent(new CustomEvent('mas-files-changed'));
    return true;
  } catch (e) {
    console.warn('The original file was not kept:', e);
    return false;
  }
}

export function listFiles(q: { rid?: string | null; src?: string } = {}) {
  const p = new URLSearchParams();
  if (q.rid !== undefined) p.set('rid', q.rid || '');
  if (q.src) p.set('src', q.src);
  return api<{ files: KeptFile[]; total: { n: number; size: number }; keep: number; max: number }>('/api/files' + (p.toString() ? '?' + p : ''));
}

/** Downloads a kept file: the same bytes and name as the file that was uploaded. */
export async function downloadFile(f: Pick<KeptFile, 'id' | 'name' | 'mime' | 'parts'>) {
  const chunks: Uint8Array[] = [];
  for (let n = 0; n < f.parts; n++) {
    const { data } = await api<{ data: string }>(`/api/files/part?id=${f.id}&n=${n}`);
    const bin = atob(data); const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    chunks.push(u);
  }
  const blob = new Blob(chunks as BlobPart[], { type: f.mime || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = f.name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

export const fmtSize = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** The newest kept file of a report for a Pick / week (+ plant) — '' rid = the shared report. */
export async function downloadLatest(src: string, rid: string | null): Promise<string> {
  const r = await listFiles({ rid: rid || '', src });
  const f = r.files[0];
  if (!f) throw new Error('This file was uploaded before files were kept — upload it again to keep it.');
  await downloadFile(f);
  return f.name;
}
