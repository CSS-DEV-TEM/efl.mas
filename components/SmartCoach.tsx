'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';

/**
 * v148: Smart Coach — tips the system learned from its own history (last 30 days of picks, rejects and uploads).
 * A glowing orb at the bottom left; the first tip comes up once per session as a bubble, the panel lists them all.
 */
type Tip = { id: string; icon: string; tone: 'ok' | 'warn' | 'bad' | 'info' | 'accent'; title: string; text: string };
type Advice = { tips: Tip[]; learned: { since: string; picks: number; users: number } };

function useTyped(text: string, on: boolean) {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!on) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { setN(text.length); return; }
    setN(0);
    let i = 0; const t = setInterval(() => { i += 2; setN(i); if (i >= text.length) clearInterval(t); }, 16);
    return () => clearInterval(t);
  }, [text, on]);
  return text.slice(0, n);
}

export default function SmartCoach() {
  const [adv, setAdv] = useState<Advice | null>(null);
  const [open, setOpen] = useState(false);
  const [bubble, setBubble] = useState(false);
  const [ix, setIx] = useState(0);
  const panel = useRef<HTMLDivElement>(null);
  const load = useCallback(() => api<Advice>('/api/advice').then(setAdv).catch(() => {}), []);
  useEffect(() => {
    const t0 = setTimeout(() => { void load(); }, 2500);
    const t1 = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 20 * 60e3);
    return () => { clearTimeout(t0); clearInterval(t1); };
  }, [load]);
  // the first tip once per session, as a bubble beside the orb
  useEffect(() => {
    if (!adv?.tips.length) return;
    let seen = false; try { seen = sessionStorage.getItem('mas-coach-seen') === '1'; } catch { /* */ }
    if (seen) return;
    const t = setTimeout(() => setBubble(true), 1200);
    const h = setTimeout(() => setBubble(false), 14000);
    try { sessionStorage.setItem('mas-coach-seen', '1'); } catch { /* */ }
    return () => { clearTimeout(t); clearTimeout(h); };
  }, [adv]);
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    const c = (e: MouseEvent) => { if (panel.current && !panel.current.contains(e.target as Node) && !(e.target as HTMLElement).closest('.coach-orb')) setOpen(false); };
    addEventListener('keydown', k); addEventListener('mousedown', c);
    return () => { removeEventListener('keydown', k); removeEventListener('mousedown', c); };
  }, [open]);
  const tips = adv?.tips ?? [];
  const cur = tips[ix % Math.max(1, tips.length)];
  const typed = useTyped(cur?.text ?? '', bubble && !open);
  return (
    <>
      <button type="button" className={`coach-orb ${tips.length ? 'has' : ''} ${open ? 'open' : ''}`} aria-label={`Smart Coach${tips.length ? ` — ${tips.length} tips` : ''}`} aria-expanded={open}
        onClick={() => { setOpen((o) => !o); setBubble(false); if (!adv) void load(); }}>
        <span className="orb-core" aria-hidden><i /><i /><i /></span>
        {tips.length > 0 && <span className="orb-count">{tips.length}</span>}
      </button>
      {bubble && !open && cur && (
        <div className={`coach-bubble tone-${cur.tone}`} role="status" onClick={() => { setOpen(true); setBubble(false); }}>
          <b><span aria-hidden>{cur.icon}</span> {cur.title}</b>
          <p>{typed}<span className="caret" aria-hidden /></p>
        </div>
      )}
      {open && (
        <div className="coach-panel" ref={panel} role="dialog" aria-label="Smart Coach">
          <div className="coach-head">
            <span className="orb-core sm" aria-hidden><i /><i /><i /></span>
            <div>
              <h3>Smart Coach</h3>
              <p>{adv ? `Learned from ${adv.learned.picks.toLocaleString()} picks by ${adv.learned.users} user${adv.learned.users === 1 ? '' : 's'} since ${adv.learned.since}` : 'Learning…'}</p>
            </div>
            <button type="button" className="btn sm" onClick={() => void load()} title="Look again">↻</button>
          </div>
          <div className="coach-list">
            {!adv && [0, 1, 2].map((i) => <div key={i} className="coach-tip skel-tip" />)}
            {tips.map((t, i) => (
              <div key={t.id} className={`coach-tip tone-${t.tone}`} style={{ animationDelay: `${i * 70}ms` }}>
                <span className="ct-icon" aria-hidden>{t.icon}</span>
                <div><b>{t.title}</b><p>{t.text}</p></div>
              </div>
            ))}
          </div>
          {tips.length > 1 && <div className="coach-foot"><span className="muted">Counts only — the pick rules are not changed.</span><button type="button" className="btn sm" onClick={() => { setIx((x) => x + 1); setBubble(true); setOpen(false); }}>Show next tip</button></div>}
        </div>
      )}
    </>
  );
}
