'use client';
/**
 * v187: the dashboard-style frame — a left sidebar (icons + names, collapses to icons) whose lime pill slides to the open
 * page, and a command search in the top bar (Ctrl / ⌘ K). Only how the pages are reached: nothing a page does is changed.
 */
import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

export interface NavItem { href: string; label: string; hint?: string }

const P: Record<string, React.ReactNode> = {
  '/': <path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z" />,
  '/week/': <><rect x="3" y="4.5" width="18" height="16" rx="2.5" /><path d="M8 2.5v4M16 2.5v4M3 9.5h18" /></>,
  '/upload/': <><path d="M12 15V3M7 8l5-5 5 5" /><path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" /></>,
  '/dispatch/': <><path d="M2.5 6.5h11v9.5h-11z" /><path d="M13.5 9.5h4.2l3 3.2V16h-7.2" /><circle cx="6.5" cy="18" r="2" /><circle cx="17" cy="18" r="2" /></>,
  '/data/': <><ellipse cx="12" cy="5.5" rx="8" ry="3" /><path d="M4 5.5v13c0 1.7 3.6 3 8 3s8-1.3 8-3v-13" /><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" /></>,
  '/inventory/': <><path d="M3 7.2 12 3l9 4.2-9 4.2z" /><path d="M3 7.2v9.6L12 21l9-4.2V7.2" /><path d="M12 11.4V21" /></>,
  '/plan-check/': <><rect x="5" y="4" width="14" height="17" rx="2.5" /><path d="M9 2.5h6v3H9z" /><path d="m9 13.5 2 2 4-4" /></>,
  '/readme/': <><path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v17H6.5A2.5 2.5 0 0 0 4 21.5z" /><path d="M4 21.5V4.5M8 7h8M8 11h6" /></>,
  '/settings/': <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></>,
};
export const Icon = ({ d, size = 18 }: { d: React.ReactNode; size?: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{d}</svg>
);
export const ICON = {
  collapse: <><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M9.5 4v16" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  out: <><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" /><path d="m10 16 4-4-4-4M14 12H4" /></>,
  chev: <path d="m9 6 6 6-6 6" />,
};
export const iconOf = (href: string) => P[href] ?? P['/'];

export const isOn = (href: string, path: string | null) => (href === '/' ? path === '/' : !!path?.startsWith(href.replace(/\/$/, '')));

/** the sidebar list with the sliding pill: it stretches toward the new page first, then its back end follows (power3.out) */
export function SideNav({ items, path, onGo }: { items: NavItem[]; path: string | null; onGo?: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [pill, setPill] = useState<{ top: number; h: number; down: boolean } | null>(null);
  const last = useRef<number | null>(null);
  useLayoutEffect(() => {
    const place = () => {
      const a = box.current?.querySelector<HTMLAnchorElement>('a.on');
      if (!a) { setPill(null); return; }
      const top = a.offsetTop, h = a.offsetHeight;
      setPill({ top, h, down: last.current === null || top >= last.current });
      last.current = top;
    };
    place();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(place) : null;
    if (ro && box.current) ro.observe(box.current);
    return () => ro?.disconnect();
  }, [path, items.length]);
  const fast = '.26s cubic-bezier(.215,.61,.355,1)', slow = '.55s cubic-bezier(.215,.61,.355,1)';
  return (
    <div className="side-nav" ref={box}>
      {pill && (
        <span className="side-pill" aria-hidden style={{
          top: pill.top, bottom: `calc(100% - ${pill.top + pill.h}px)`,
          transition: pill.down ? `bottom ${fast}, top ${slow}` : `top ${fast}, bottom ${slow}`,
        }} />
      )}
      {items.map((n) => (
        <Link key={n.href} href={n.href} className={isOn(n.href, path) ? 'on' : ''} title={n.label} onClick={onGo} aria-current={isOn(n.href, path) ? 'page' : undefined}>
          <Icon d={iconOf(n.href)} />
          <span className="side-label">{n.label}</span>
        </Link>
      ))}
    </div>
  );
}

/** the top-bar search: type a page name (or what it is for) and press Enter — Ctrl / ⌘ K opens it from anywhere */
export function CommandSearch({ items }: { items: NavItem[] }) {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const inp = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); inp.current?.focus(); setOpen(true); } };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  const list = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t ? items.filter((n) => `${n.label} ${n.hint ?? ''}`.toLowerCase().includes(t)) : items;
  }, [q, items]);
  useEffect(() => { setHi(0); }, [q]);
  const go = (n?: NavItem) => { if (!n) return; setOpen(false); setQ(''); inp.current?.blur(); router.push(n.href); };
  const [mac, setMac] = useState(false);
  useEffect(() => { setMac(/mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent)); }, []);
  return (
    <div className="cmd" onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOpen(false); }}>
      <Icon d={ICON.search} size={16} />
      <input ref={inp} value={q} placeholder="Search pages — Day plan, Pick, Plan Check…" aria-label="Search pages"
        onFocus={() => setOpen(true)} onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(list.length - 1, h + 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(0, h - 1)); }
          else if (e.key === 'Enter') { e.preventDefault(); go(list[hi]); }
          else if (e.key === 'Escape') { setOpen(false); inp.current?.blur(); }
        }} />
      <kbd>{mac ? '⌘' : 'Ctrl'} K</kbd>
      {open && list.length > 0 && (
        <div className="cmd-list" role="listbox">
          {list.map((n, i) => (
            <button key={n.href} type="button" role="option" aria-selected={i === hi} className={i === hi ? 'hi' : ''} onMouseEnter={() => setHi(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => go(n)}>
              <Icon d={iconOf(n.href)} size={16} /><b>{n.label}</b>{n.hint && <small>{n.hint}</small>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
