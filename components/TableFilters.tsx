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

// ---------------------------------------------------------------- Excel export of any table
/**
 * Every data table gets an "Excel" button (top-right corner, shown when the pointer is over the table): the rows as they are
 * shown (column filters applied) go to an .xlsx named after the card's title. The button lives on <body>, not in the table.
 */
let xbtn: HTMLButtonElement | null = null;
let xTable: HTMLTableElement | null = null;
const TABLES = 'main table, .modal table';
const wrapOf = (t: HTMLTableElement) => (t.closest('.table-wrap') as HTMLElement | null) ?? t;
/** a cell's text as it reads on screen: inline pieces run together, block pieces (a second line) get a space; buttons are left out */
function exportText(td: Element | undefined | null): string {
  if (!td) return '';
  const inp = td.querySelector('input:not([type=checkbox]):not([type=radio]), select') as HTMLInputElement | HTMLSelectElement | null;
  if (inp) return inp.value.replace(/\s+/g, ' ').trim();
  const blockOf = (n: Node) => { let e = n.parentElement; while (e && e !== td && (getComputedStyle(e).display || 'inline').startsWith('inline')) e = e.parentElement; return e; };
  let out = '', prev: Element | null | undefined;
  const w = document.createTreeWalker(td, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    if (n.parentElement?.closest('button, .tx-skip, svg')) continue;
    const t = n.nodeValue || '';
    if (!t.trim()) { if (t && out && !out.endsWith(' ')) out += ' '; continue; }
    const b = blockOf(n);
    if (prev !== undefined && b !== prev && out && !out.endsWith(' ')) out += ' ';
    out += t; prev = b;
  }
  return out.replace(/\s+/g, ' ').trim();
}
function titleOf(t: HTMLTableElement) {
  const box = t.closest('details, section, .modal, .card');
  const h0 = box?.querySelector('h2, h3, summary h3, .modal-head h2');
  // the heading without its badges (counts, totals)
  const h = h0 ? (() => { const c = h0.cloneNode(true) as Element; c.querySelectorAll('.pill, .muted, button').forEach((x) => x.remove()); return c; })() : null;
  return ((h?.textContent || document.title || 'Table').replace(/\s+/g, ' ').trim().replace(/[\\/:*?"<>|[\]]+/g, ' ').slice(0, 60).trim()) || 'Table';
}
const asNum = (v: string) => {
  const t = v.replace(/,/g, '');
  return /^-?\d+(\.\d+)?$/.test(t) && !/^0\d/.test(t) && t.replace(/[-.]/g, '').length <= 15 ? Number(t) : null;
};
async function exportTable(t: HTMLTableElement) {
  const XLSX = await import('xlsx-js-style');
  const head = Array.from(t.tHead?.rows ?? []);
  const rows = bodyRows(t).filter((r) => !r.hasAttribute('data-tf-hide'));
  // columns: the header cells (colspans spread), skipping a column that is only a checkbox
  const hr = head[head.length - 1];
  const width = Math.max(hr ? Array.from(hr.cells).reduce((n, c) => n + (c.colSpan || 1), 0) : 0, ...rows.map((r) => Array.from(r.cells).reduce((n, c) => n + (c.colSpan || 1), 0)));
  const cols = Array.from({ length: width }, (_, i) => i);
  const hdr = cols.map((c) => (hr ? exportText(cellAt(hr, c)) : ''));
  const keep = cols.filter((c) => hdr[c] !== '' || rows.some((r) => exportText(cellAt(r, c)) !== ''));
  const aoa: (string | number)[][] = [keep.map((c) => hdr[c] || `Column ${c + 1}`)];
  for (const r of rows) {
    if (r.cells.length === 1 && (r.cells[0].colSpan || 1) > 1) { aoa.push([exportText(r.cells[0])]); continue; } // a group row
    aoa.push(keep.map((c) => { const v = exportText(cellAt(r, c)); const n = asNum(v); return n ?? v; }));
  }
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = keep.map((_, i) => ({ wch: Math.min(50, Math.max(8, ...aoa.slice(0, 300).map((r) => String(r[i] ?? '').length + 1))) }));
  ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(0, aoa.length - 1), c: keep.length - 1 } }) };
  ws['!freeze'] = { xSplit: 0, ySplit: 1 };
  for (let i = 0; i < keep.length; i++) {
    const a = XLSX.utils.encode_cell({ r: 0, c: i });
    if (ws[a]) ws[a].s = { font: { bold: true, color: { rgb: 'FFFFFF' } }, fill: { fgColor: { rgb: '1F3A5F' } }, alignment: { vertical: 'center', wrapText: true } };
  }
  const wb = XLSX.utils.book_new();
  const title = titleOf(t);
  XLSX.utils.book_append_sheet(wb, ws, title.slice(0, 31) || 'Table');
  const stamp = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 16).replace('T', '_').replace(':', '');
  XLSX.writeFile(wb, `${title.replace(/→/g, '-').replace(/\s+/g, '_')}_${stamp}.xlsx`, { cellStyles: true });
}
function placeBtn(t: HTMLTableElement | null) {
  if (!xbtn) return;
  if (!t || !t.isConnected || !bodyRows(t).length) { xbtn.style.display = 'none'; xTable = null; return; }
  xTable = t;
  const r = wrapOf(t).getBoundingClientRect();
  if (r.bottom < 0 || r.top > window.innerHeight) { xbtn.style.display = 'none'; return; }
  xbtn.style.display = 'block';
  const navH = (document.querySelector('.bar') as HTMLElement | null)?.getBoundingClientRect().bottom ?? 0;
  xbtn.style.top = `${Math.min(r.bottom - 26, Math.max(navH + 4, r.top + 4))}px`;
  // left of the last column's filter funnel (its right edge)
  xbtn.style.left = `${Math.max(4, Math.min(window.innerWidth - xbtn.offsetWidth - 30, r.right - xbtn.offsetWidth - 30))}px`;
}

export default function TableFilters() {
  useEffect(() => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'tx-btn'; b.textContent = '⤓ Excel'; b.title = 'Download this table as an Excel report (the rows shown, with the filters)';
    b.style.display = 'none';
    b.onclick = (e) => { e.stopPropagation(); const t = xTable; if (t) void exportTable(t).catch(() => alert('Could not make the Excel file.')); };
    document.body.append(b); xbtn = b;
    const over = (e: MouseEvent) => {
      const el = e.target as Element | null;
      if (!el || el === b) return;
      const t = el.closest?.(TABLES) as HTMLTableElement | null ?? (el.closest?.('.table-wrap')?.querySelector('table') as HTMLTableElement | null);
      if (t && !t.hasAttribute('data-noexport')) placeBtn(t);
      else if (!el.closest?.('.tx-btn')) { if (xTable && !wrapOf(xTable).contains(el)) placeBtn(null); }
    };
    const reflow = () => { if (xTable) placeBtn(xTable); };
    document.addEventListener('mouseover', over);
    window.addEventListener('scroll', reflow, true);
    window.addEventListener('resize', reflow);
    return () => { document.removeEventListener('mouseover', over); window.removeEventListener('scroll', reflow, true); window.removeEventListener('resize', reflow); b.remove(); xbtn = null; };
  }, []);
  return <TableFiltersCore />;
}

function TableFiltersCore() {
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
