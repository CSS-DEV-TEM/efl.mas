'use client';
import { useEffect } from 'react';

/**
 * Excel-like column filters on every data table of the site (no per-table code):
 * each header cell gets a small funnel at its right edge; clicking it opens a list of the column's values
 * (with a search box) to tick. Rows that do not match are hidden. The filters are re-applied whenever the
 * table's rows change (live updates, sorting, paging), and a header with a filter on shows a filled funnel.
 * A table can opt out with data-nofilter. Works only with attributes on React's elements (never adds nodes
 * inside them), so React keeps managing the tables as before.
 */
type Filter = { values: Set<string> | null; text: string };
const filters = new WeakMap<HTMLTableElement, Map<number, Filter>>();
const MAX_VALUES = 400;

const cellText = (td: Element | undefined) => {
  if (!td) return '';
  const inp = td.querySelector('input:not([type=checkbox]):not([type=radio]), select') as HTMLInputElement | HTMLSelectElement | null;
  if (inp) return inp.value.replace(/\s+/g, ' ').trim();
  // the text pieces joined by a space (a name and its code on two lines stay apart) — the same for shown and hidden rows
  const parts: string[] = [];
  const w = document.createTreeWalker(td, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) parts.push(n.nodeValue || '');
  return parts.join(' ').replace(/\s+/g, ' ').trim();
};
/** the cell of a row at a column position, counting colspans */
function cellAt(tr: HTMLTableRowElement, col: number) {
  let c = 0;
  for (const td of Array.from(tr.cells)) { const span = td.colSpan || 1; if (col >= c && col < c + span) return span > 1 ? undefined : td; c += span; }
  return undefined;
}
function colOf(th: HTMLTableCellElement) {
  const tr = th.parentElement as HTMLTableRowElement;
  let c = 0;
  for (const x of Array.from(tr.cells)) { if (x === th) return c; c += x.colSpan || 1; }
  return c;
}
const bodyRows = (t: HTMLTableElement) => Array.from(t.tBodies).flatMap((b) => Array.from(b.rows));
/** the header row the funnels go on: the last row of the thead */
const headRow = (t: HTMLTableElement) => (t.tHead && t.tHead.rows.length ? t.tHead.rows[t.tHead.rows.length - 1] : null);

function apply(t: HTMLTableElement) {
  const f = filters.get(t);
  const on = f && Array.from(f.values()).some((x) => x.values || x.text);
  for (const tr of bodyRows(t)) {
    let show = true;
    if (on) for (const [col, x] of f!) {
      if (!x.values && !x.text) continue;
      const v = cellText(cellAt(tr, col));
      if (x.values && !x.values.has(v)) { show = false; break; }
      if (x.text && !v.toLowerCase().includes(x.text.toLowerCase())) { show = false; break; }
    }
    if (show) tr.removeAttribute('data-tf-hide'); else tr.setAttribute('data-tf-hide', '');
  }
  const hr = headRow(t);
  if (hr) for (const th of Array.from(hr.cells)) {
    const x = f?.get(colOf(th));
    if (x && (x.values || x.text)) th.setAttribute('data-tf-on', ''); else th.removeAttribute('data-tf-on');
  }
  const hidden = on ? bodyRows(t).filter((r) => r.hasAttribute('data-tf-hide')).length : 0;
  if (hidden) t.setAttribute('data-tf-hidden', String(hidden)); else t.removeAttribute('data-tf-hidden');
}

function mark(root: ParentNode) {
  for (const t of Array.from(root.querySelectorAll('main table')) as HTMLTableElement[]) {
    if (t.hasAttribute('data-nofilter')) continue;
    const hr = headRow(t);
    if (!hr || bodyRows(t).length < 2) { if (hr) for (const th of Array.from(hr.cells)) th.removeAttribute('data-tf'); continue; }
    for (const th of Array.from(hr.cells)) {
      // a header that is only a checkbox ("mark all") has nothing to filter
      if (th.querySelector('input[type=checkbox]') && !(th.textContent || '').trim()) continue;
      if (!th.hasAttribute('data-tf')) th.setAttribute('data-tf', '');
    }
    if (filters.has(t)) apply(t);
  }
}

let pop: HTMLDivElement | null = null;
function closePop() { pop?.remove(); pop = null; }

function openPop(th: HTMLTableCellElement) {
  closePop();
  const t = th.closest('table') as HTMLTableElement;
  const col = colOf(th);
  const f = filters.get(t) ?? new Map<number, Filter>();
  filters.set(t, f);
  const cur = f.get(col) ?? { values: null, text: '' };
  // the values of this column among the rows the OTHER filters leave
  const others = new Map(f); others.delete(col);
  const rows = bodyRows(t).filter((tr) => Array.from(others).every(([c, x]) => { const v = cellText(cellAt(tr, c)); return (!x.values || x.values.has(v)) && (!x.text || v.toLowerCase().includes(x.text.toLowerCase())); }));
  const counts = new Map<string, number>();
  for (const tr of rows) { const v = cellText(cellAt(tr, col)); counts.set(v, (counts.get(v) ?? 0) + 1); }
  const num = (s: string) => { const n = Number(s.replace(/,/g, '')); return s !== '' && Number.isFinite(n) ? n : null; };
  const vals = Array.from(counts.keys()).sort((a, b) => { const x = num(a), y = num(b); return x !== null && y !== null ? x - y : a.localeCompare(b, undefined, { numeric: true }); });
  const chosen = new Set(cur.values ?? vals);

  const el = document.createElement('div');
  el.className = 'tf-pop'; el.setAttribute('role', 'dialog');
  const title = (th.textContent || 'Column').trim();
  el.innerHTML = `<div class="tf-h"><b></b><button type="button" class="tf-x" aria-label="Close">✕</button></div>
    <input class="tf-q" type="search" placeholder="Search in this column…" />
    <label class="tf-all"><input type="checkbox" /> <span>Select all</span></label>
    <div class="tf-list"></div>
    <div class="tf-f"><button type="button" class="btn sm tf-clear">Clear</button><button type="button" class="btn sm primary tf-ok">OK</button></div>`;
  (el.querySelector('.tf-h b') as HTMLElement).textContent = `Filter · ${title}`;
  const q = el.querySelector('.tf-q') as HTMLInputElement;
  q.value = cur.text;
  const list = el.querySelector('.tf-list') as HTMLDivElement;
  const all = el.querySelector('.tf-all input') as HTMLInputElement;
  const draw = () => {
    const s = q.value.trim().toLowerCase();
    const shown = vals.filter((v) => !s || v.toLowerCase().includes(s));
    list.innerHTML = '';
    for (const v of shown.slice(0, MAX_VALUES)) {
      const lab = document.createElement('label');
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = chosen.has(v);
      cb.onchange = () => { if (cb.checked) chosen.add(v); else chosen.delete(v); syncAll(); };
      const sp = document.createElement('span'); sp.textContent = v === '' ? '(blank)' : v;
      const n = document.createElement('small'); n.textContent = String(counts.get(v) ?? 0);
      lab.append(cb, sp, n); list.append(lab);
    }
    if (shown.length > MAX_VALUES) { const m = document.createElement('div'); m.className = 'tf-more'; m.textContent = `${shown.length - MAX_VALUES} more — type to narrow`; list.append(m); }
    if (!shown.length) { const m = document.createElement('div'); m.className = 'tf-more'; m.textContent = 'No values'; list.append(m); }
    syncAll();
  };
  const syncAll = () => {
    const s = q.value.trim().toLowerCase();
    const shown = vals.filter((v) => !s || v.toLowerCase().includes(s));
    all.checked = shown.length > 0 && shown.every((v) => chosen.has(v));
    all.indeterminate = !all.checked && shown.some((v) => chosen.has(v));
  };
  all.onchange = () => { const s = q.value.trim().toLowerCase(); for (const v of vals.filter((x) => !s || x.toLowerCase().includes(s))) { if (all.checked) chosen.add(v); else chosen.delete(v); } draw(); };
  q.oninput = draw;
  const ok = () => {
    const s = q.value.trim();
    // ticked values: a filter only when some are left out; typed text with every value ticked: a "contains" filter
    const values = vals.every((v) => chosen.has(v)) ? null : new Set(chosen);
    const text = values ? '' : s;
    if (!values && !text) f.delete(col); else f.set(col, { values, text });
    apply(t); closePop();
  };
  (el.querySelector('.tf-ok') as HTMLButtonElement).onclick = ok;
  (el.querySelector('.tf-clear') as HTMLButtonElement).onclick = () => { f.delete(col); apply(t); closePop(); };
  (el.querySelector('.tf-x') as HTMLButtonElement).onclick = closePop;
  el.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); closePop(); } if (e.key === 'Enter') { e.preventDefault(); ok(); } });
  el.addEventListener('pointerdown', (e) => e.stopPropagation());
  document.body.append(el);
  pop = el;
  draw();
  const r = th.getBoundingClientRect();
  const w = Math.min(300, window.innerWidth - 16);
  el.style.width = `${w}px`;
  el.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w))}px`;
  const below = r.bottom + 4, h = Math.min(420, window.innerHeight - 16);
  el.style.top = `${below + h > window.innerHeight ? Math.max(8, r.top - h - 4) : below}px`;
  el.style.maxHeight = `${h}px`;
  q.focus();
}

export default function TableFilters() {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = () => { clearTimeout(timer); timer = setTimeout(() => mark(document), 120); };
    const mo = new MutationObserver((ms) => { if (ms.some((m) => !(m.target instanceof Element && m.target.closest('.tf-pop')))) run(); });
    mo.observe(document.body, { childList: true, subtree: true, characterData: true });
    run();
    // the funnel: the right edge of a header cell (capture: before the table's own click, e.g. sorting)
    const onClick = (e: MouseEvent) => {
      const th = (e.target as Element | null)?.closest?.('th[data-tf]') as HTMLTableCellElement | null;
      if (!th) return;
      const r = th.getBoundingClientRect();
      if (e.clientX < r.right - 22) return;
      e.preventDefault(); e.stopPropagation();
      openPop(th);
    };
    const onDown = (e: PointerEvent) => { if (pop && !(e.target as Element).closest('.tf-pop')) closePop(); };
    document.addEventListener('click', onClick, true);
    document.addEventListener('pointerdown', onDown);
    window.addEventListener('resize', closePop);
    return () => { mo.disconnect(); clearTimeout(timer); document.removeEventListener('click', onClick, true); document.removeEventListener('pointerdown', onDown); window.removeEventListener('resize', closePop); closePop(); };
  }, []);
  return null;
}
