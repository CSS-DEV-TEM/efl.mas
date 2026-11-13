'use client';
/**
 * v197: the sign-in button on a tether. While the username or password is empty the button will not be caught — it slips
 * away from the pointer, held to its socket by a line. When both are filled it springs back into the socket, lights up and
 * signs in. Keyboard and screen-reader use is the same as a plain submit button (Enter in a field always submits; a tap on
 * the empty button only shakes it and says what is missing). Reduced motion: no dodging, just the lit / unlit button.
 */
import { useEffect, useRef, useState } from 'react';

export default function TetherButton({ ready, busy, label, busyLabel, hint }: { ready: boolean; busy: boolean; label: string; busyLabel: string; hint: string }) {
  const box = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const line = useRef<SVGPathElement>(null);
  const pos = useRef({ x: 0, y: 0, vx: 0, vy: 0, tx: 0, ty: 0 });
  const readyRef = useRef(ready);
  const [shake, setShake] = useState(0);
  const [nudge, setNudge] = useState(false);
  readyRef.current = ready;

  useEffect(() => {
    if (ready) { pos.current.tx = 0; pos.current.ty = 0; setNudge(false); }
  }, [ready]);

  useEffect(() => {
    const reduce = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    let raf = 0;
    const p = pos.current;
    const draw = () => {
      const b = box.current, el = btn.current, ln = line.current;
      if (!b || !el || !ln) return;
      el.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px) rotate(${(p.vx * 0.6).toFixed(2)}deg)`;
      const w = b.clientWidth, h = b.clientHeight, cx = w / 2, cy = h / 2;
      const ex = cx + p.x, ey = cy + p.y, len = Math.hypot(p.x, p.y);
      const sag = Math.max(0, 26 - len * 0.18);
      ln.setAttribute('d', `M${cx},${cy} Q${(cx + ex) / 2},${(cy + ey) / 2 + sag} ${ex},${ey}`);
      ln.style.opacity = len > 4 ? '1' : '0';
    };
    const tick = () => {
      // a spring toward the target, damped
      p.vx = (p.vx + (p.tx - p.x) * 0.14) * 0.74;
      p.vy = (p.vy + (p.ty - p.y) * 0.14) * 0.74;
      p.x += p.vx; p.y += p.vy;
      draw();
      raf = requestAnimationFrame(tick);
    };
    const flee = (px: number, py: number) => {
      const b = box.current, el = btn.current;
      if (!b || !el || readyRef.current || reduce) return;
      const r = el.getBoundingClientRect();
      const bx = r.left + r.width / 2, by = r.top + r.height / 2;
      const dx = bx - px, dy = by - py, d = Math.hypot(dx, dy);
      if (d > 95) return;
      const w = b.clientWidth, maxX = Math.max(0, w / 2 - r.width / 2 - 4), maxY = 34;
      let ux = d ? dx / d : 1, uy = d ? dy / d : 0;
      let nx = p.tx + ux * (120 - d), ny = p.ty + uy * (60 - d * 0.4);
      // cornered at a side: jump over to the other side
      if (Math.abs(nx) > maxX) { nx = -Math.sign(nx) * maxX * 0.85; ux = -ux; }
      p.tx = Math.max(-maxX, Math.min(maxX, nx));
      p.ty = Math.max(-maxY, Math.min(maxY, ny));
      setNudge(true);
    };
    const move = (e: PointerEvent) => { if (e.pointerType === 'mouse' || e.pointerType === 'pen') flee(e.clientX, e.clientY); };
    window.addEventListener('pointermove', move);
    raf = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(raf); window.removeEventListener('pointermove', move); };
  }, []);

  return (
    <div className={`tether${ready ? ' ready' : ''}${busy ? ' busy' : ''}`} ref={box}>
      <span className="tether-socket" aria-hidden />
      <svg className="tether-line" aria-hidden><path ref={line} /><circle className="tether-anchor" r="4" cx="50%" cy="50%" /></svg>
      <button
        ref={btn}
        type="submit"
        className={`tether-btn${shake ? ' shake' : ''}`}
        key={shake}
        aria-busy={busy || undefined}
        disabled={busy}
        aria-describedby={!ready ? 'tether-hint' : undefined}
        onClick={(e) => {
          // nothing to sign in with yet: a shake (and the hint), no submit
          if (!readyRef.current) { e.preventDefault(); setShake((n) => n + 1); setNudge(true); }
        }}
      >
        <span className="tether-label">{busy ? busyLabel : label}</span>
        <span className="tether-spin" aria-hidden />
      </button>
      <span id="tether-hint" className={`tether-hint${nudge && !ready ? ' on' : ''}`} role="status">{!ready ? hint : ''}</span>
    </div>
  );
}
