'use client';
import { useEffect, useState } from 'react';

/** v148: Light / Auto (device) / Dark — remembered on this device; the change opens as a circle from the button. */
type Mode = 'light' | 'auto' | 'dark';
const KEY = 'mas-theme';
const read = (): Mode => { try { const v = localStorage.getItem(KEY); return v === 'light' || v === 'dark' ? v : 'auto'; } catch { return 'auto'; } };
function apply(m: Mode) {
  const el = document.documentElement;
  if (m === 'auto') el.removeAttribute('data-theme'); else el.setAttribute('data-theme', m);
}

export default function ThemeToggle() {
  const [mode, setMode] = useState<Mode>('auto');
  useEffect(() => { setMode(read()); }, []);
  const pick = (m: Mode, e: React.MouseEvent) => {
    if (m === mode) return;
    try { localStorage.setItem(KEY, m); } catch { /* private mode */ }
    const doc = document as Document & { startViewTransition?: (cb: () => void) => { ready: Promise<void> } };
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!doc.startViewTransition || reduce) { apply(m); setMode(m); return; }
    const x = e.clientX, y = e.clientY;
    const r = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
    const t = doc.startViewTransition(() => { apply(m); setMode(m); });
    t.ready.then(() => {
      document.documentElement.animate({ clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${r}px at ${x}px ${y}px)`] },
        { duration: 520, easing: 'cubic-bezier(.2,.8,.2,1)', pseudoElement: '::view-transition-new(root)' });
    }).catch(() => {});
  };
  // v157: the same-size line icons (text glyphs render at different sizes on each device)
  const I = (d: React.ReactNode) => <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{d}</svg>;
  const opts: { m: Mode; icon: React.ReactNode; label: string }[] = [
    { m: 'light', icon: I(<><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>), label: 'Light' },
    { m: 'auto', icon: I(<><circle cx="12" cy="12" r="8.5" /><path d="M12 3.5v17a8.5 8.5 0 0 0 0-17z" fill="currentColor" stroke="none" /></>), label: 'Auto (this device)' },
    { m: 'dark', icon: I(<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />), label: 'Dark' },
  ];
  return (
    <div className="theme-toggle" role="radiogroup" aria-label="Theme">
      <span className="tt-thumb" style={{ transform: `translateX(${opts.findIndex((o) => o.m === mode) * 32}px)` }} aria-hidden />
      {opts.map((o) => (
        <button key={o.m} type="button" role="radio" aria-checked={mode === o.m} title={o.label} aria-label={o.label} className={mode === o.m ? 'on' : ''} onClick={(e) => pick(o.m, e)}>{o.icon}</button>
      ))}
    </div>
  );
}
