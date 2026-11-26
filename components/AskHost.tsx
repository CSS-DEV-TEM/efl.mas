'use client';
/** v221: the page's own OK / Cancel (and type-in) box — see lib/ask.ts */
import * as React from 'react';
import { useEffect, useRef, useState } from 'react';
import { setAskHost, type AskReq } from '@/lib/ask';

export default function AskHost() {
  const [q, setQ] = useState<AskReq[]>([]);
  const [val, setVal] = useState('');
  const okRef = useRef<HTMLButtonElement>(null);
  const inRef = useRef<HTMLInputElement>(null);
  useEffect(() => { setAskHost((r) => setQ((x) => [...x, r])); return () => setAskHost(null); }, []);
  const cur = q[0];
  useEffect(() => {
    if (!cur) return;
    setVal(cur.def ?? '');
    const t = setTimeout(() => (cur.kind === 'prompt' ? inRef.current?.focus() : okRef.current?.focus()), 30);
    return () => clearTimeout(t);
  }, [cur]);
  if (!cur) return null;
  const done = (ok: boolean) => {
    cur.resolve(cur.kind === 'confirm' ? ok : cur.kind === 'prompt' ? (ok ? val : null) : undefined);
    setQ((x) => x.slice(1));
  };
  return (
    <div className="ask-back" role="presentation" onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); done(false); } }}>
      <div className="ask-dlg" role={cur.kind === 'alert' ? 'alertdialog' : 'dialog'} aria-modal="true" aria-labelledby="ask-msg">
        <p id="ask-msg" className="ask-msg">{cur.msg}</p>
        {cur.kind === 'prompt' && <input ref={inRef} className="ask-in" value={val} onChange={(e) => setVal(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); done(true); } }} aria-label="Answer" />}
        <div className="ask-acts">
          {cur.kind !== 'alert' && <button type="button" className="btn" onClick={() => done(false)}>Cancel</button>}
          <button ref={okRef} type="button" className="btn primary" onClick={() => done(true)}>OK</button>
        </div>
      </div>
    </div>
  );
}
