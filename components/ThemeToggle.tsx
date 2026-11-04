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
  const opts: { m: Mode; icon: string; label: string }[] = [
    { m: 'light', icon: '☀', label: 'Light' },
    { m: 'auto', icon: '◐', label: 'Auto (this device)' },
    { m: 'dark', icon: '☾', label: 'Dark' },
  ];
  return (
    <div className="theme-toggle" role="radiogroup" aria-label="Theme">
      <span className="tt-thumb" style={{ transform: `translateX(${opts.findIndex((o) => o.m === mode) * 100}%)` }} aria-hidden />
      {opts.map((o) => (
        <button key={o.m} type="button" role="radio" aria-checked={mode === o.m} title={o.label} aria-label={o.label} className={mode === o.m ? 'on' : ''} onClick={(e) => pick(o.m, e)}>{o.icon}</button>
      ))}
    </div>
  );
}
