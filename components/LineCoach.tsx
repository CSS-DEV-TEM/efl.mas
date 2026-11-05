'use client';
import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { lineCoach, type ItemHistory } from '@/lib/coach';
import type { Candidates } from '@/lib/pick';

/** v149: Smart Coach in the pick window — the problems of this line and what to do, in English and Sinhala. */
export default function LineCoach({ c, best }: { c: Candidates; best?: { qty: number; rolls: number; left: number } | null }) {
  const [hist, setHist] = useState<ItemHistory | null>(null);
  const [open, setOpen] = useState(() => { try { return localStorage.getItem('mas-linecoach') !== '0'; } catch { return true; } });
  const [si, setSi] = useState(() => { try { return localStorage.getItem('mas-coach-si') !== '0'; } catch { return true; } });
  useEffect(() => {
    let stop = false;
    api<{ item?: ItemHistory }>('/api/advice?item=' + encodeURIComponent(c.line.item)).then((r) => { if (!stop) setHist(r.item ?? null); }).catch(() => {});
    return () => { stop = true; };
  }, [c.line.item]);
  const tips = useMemo(() => lineCoach(c, hist, best), [c, hist, best]);
  if (!tips.length) return null;
  const worst = tips.some((t) => t.tone === 'bad') ? 'bad' : tips.some((t) => t.tone === 'warn') ? 'warn' : 'ok';
  const toggle = () => { setOpen((o) => { try { localStorage.setItem('mas-linecoach', o ? '0' : '1'); } catch { /* */ } return !o; }); };
  const toggleSi = () => { setSi((v) => { try { localStorage.setItem('mas-coach-si', v ? '0' : '1'); } catch { /* */ } return !v; }); };
  return (
    <div className={`line-coach lc-${worst} ${open ? 'open' : ''}`}>
      <div className="lc-head">
        <button type="button" className="lc-toggle" onClick={toggle} aria-expanded={open}>
          <span className="orb-core xs" aria-hidden><i /><i /><i /></span>
          <b>Smart Coach</b>
          <span className="muted small">{tips.filter((t) => t.tone === 'bad' || t.tone === 'warn').length ? `${tips.filter((t) => t.tone === 'bad' || t.tone === 'warn').length} thing${tips.filter((t) => t.tone === 'bad' || t.tone === 'warn').length === 1 ? '' : 's'} to check` : 'looks good'}</span>
          <span className="lc-chev" aria-hidden>{open ? '▴' : '▾'}</span>
        </button>
        <button type="button" className={`lc-lang ${si ? 'on' : ''}`} onClick={toggleSi} title="Show the Sinhala too">සිං</button>
      </div>
      {open && (
        <div className="lc-list">
          {tips.map((t, i) => (
            <div key={t.id} className={`coach-tip tone-${t.tone}`} style={{ animationDelay: `${i * 60}ms` }}>
              <span className="ct-icon" aria-hidden>{t.icon}</span>
              <div><b>{t.title}</b><p>{t.text}</p>{si && t.si && <p className="si" lang="si">{t.si}</p>}
                {t.sap && t.sap.length > 0 && (
                  <details className="sap-steps">
                    <summary>📘 How to fix it in SAP{si ? ' · SAP එකේ හදන්නේ කොහොමද' : ''}</summary>
                    <ol>{t.sap.map((x, k) => <li key={k}>{x.en}{si && <span className="si" lang="si">{x.si}</span>}</li>)}</ol>
                  </details>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
