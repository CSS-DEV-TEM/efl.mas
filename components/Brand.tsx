'use client';
import { useEffect, useRef, useState } from 'react';
import { LOGO_SRC } from '@/lib/logo';

/** EFL logo. Falls back to an "EFL" wordmark until a logo image is set in lib/logo.ts. */
export function Logo({ size = 32 }: { size?: number }) {
  if (LOGO_SRC) return <img className="logo-img" src={LOGO_SRC} alt="EFL" style={{ height: size }} />;
  return <span className="logo-mark" style={{ height: size, fontSize: size * 0.42 }} aria-label="EFL">EFL</span>;
}

/** "Developed by Ishanka_M" credit with an animated highlight. */
export function Credit({ compact = false }: { compact?: boolean }) {
  return (
    <span className={`credit ${compact ? 'compact' : ''}`}>
      <span className="credit-by">Developed by</span>
      <span className="credit-name">Ishanka_M</span>
    </span>
  );
}

/** Counts a number up from its previous value; plays once per change, skipped for reduced motion. */
export function CountUp({ value, format }: { value: number; format: (n: number) => string }) {
  const [shown, setShown] = useState(0);
  const from = useRef(0);
  useEffect(() => {
    const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduce || !Number.isFinite(value)) { setShown(value); from.current = value; return; }
    const start = performance.now(), a = from.current, dur = 900;
    let raf = 0;
    const step = (t: number) => {
      const p = Math.min(1, (t - start) / dur);
      const e = 1 - Math.pow(1 - p, 3);
      setShown(a + (value - a) * e);
      if (p < 1) raf = requestAnimationFrame(step); else from.current = value;
    };
    raf = requestAnimationFrame(step);
    return () => { cancelAnimationFrame(raf); from.current = value; };
  }, [value]);
  return <>{format(shown)}</>;
}
