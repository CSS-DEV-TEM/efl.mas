'use client';
import { useEffect, useState } from 'react';

/** v149: a welcome note after signing in — the user's name, a greeting for the time of day (English and Sinhala). */
export default function Welcome({ name }: { name: string }) {
  const [show, setShow] = useState(false);
  const [out, setOut] = useState(false);
  useEffect(() => {
    // the sign-in time: shown for 6 s after it (a page that mounts twice still shows it once, to the end)
    let at = 0;
    try { at = Number(localStorage.getItem('mas-welcome') || 0); } catch { /* */ }
    const left = at ? at + 6000 - Date.now() : 0;
    if (!(left > 400)) { try { localStorage.removeItem('mas-welcome'); } catch { /* */ } return; }
    setShow(true);
    const a = setTimeout(() => setOut(true), left - 600), b = setTimeout(() => { setShow(false); try { localStorage.removeItem('mas-welcome'); } catch { /* */ } }, left);
    return () => { clearTimeout(a); clearTimeout(b); };
  }, []);
  if (!show) return null;
  const h = new Date(Date.now() + 5.5 * 3600e3).getUTCHours(); // Sri Lanka time
  const [en, si, icon] = h < 12 ? ['Good morning', 'සුභ උදෑසනක්', '🌅'] : h < 17 ? ['Good afternoon', 'සුභ දහවලක්', '☀️'] : ['Good evening', 'සුභ සන්ධ්‍යාවක්', '🌙'];
  const nice = name.replace(/[_.]+/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
  const close = () => { setOut(true); try { localStorage.removeItem('mas-welcome'); } catch { /* */ } setTimeout(() => setShow(false), 500); };
  return (
    <div className={`welcome ${out ? 'out' : ''}`} role="status" onClick={close}>
      <div className="welcome-card">
        <div className="welcome-glow" aria-hidden />
        <span className="welcome-icon" aria-hidden>{icon}</span>
        <div>
          <h2>{en}, <span className="welcome-name">{nice}</span>!</h2>
          <p className="si" lang="si">{si}, {nice}! ඔබව සාදරයෙන් පිළිගන්නවා.</p>
          <p className="muted">Welcome to MAS AUTOMATE PICK SYSTEM — your Smart Coach has today&apos;s tips at the bottom left.</p>
        </div>
      </div>
    </div>
  );
}
