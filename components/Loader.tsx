'use client';

/** A spinner with an optional label, for anything that is loading. */
export function Loader({ label = 'Loading…', inline = false }: { label?: string; inline?: boolean }) {
  return (
    <div className={`loader ${inline ? 'inline' : ''}`} role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true"><i /><i /><i /></span>
      {label && <span className="loader-label">{label}</span>}
    </div>
  );
}

/** Grey shimmering blocks in the shape of what is coming (KPI tiles and table rows). */
export function Skeleton({ tiles = 0, rows = 5, title = true }: { tiles?: number; rows?: number; title?: boolean }) {
  return (
    <div className="skel-box" aria-hidden="true">
      {title && <div className="skel-line w40 tall" />}
      {tiles > 0 && <div className="skel-tiles">{Array.from({ length: tiles }, (_, i) => <div key={i} className="skel-tile" />)}</div>}
      {Array.from({ length: rows }, (_, i) => <div key={i} className={`skel-line ${i % 3 === 0 ? 'w90' : i % 3 === 1 ? 'w75' : 'w60'}`} />)}
    </div>
  );
}

/** The whole page is loading: skeleton plus a spinner with what is happening. */
export function PageLoading({ label = 'Loading…', tiles = 4, rows = 6 }: { label?: string; tiles?: number; rows?: number }) {
  return (
    <section className="card page-loading">
      <Loader label={label} />
      <Skeleton tiles={tiles} rows={rows} title={false} />
    </section>
  );
}
