/**
 * Shown the moment a console link is clicked, while the server renders the
 * page. Without it, the old page stayed on screen with no sign the click had
 * registered until every query finished.
 */
export default function Loading() {
  return (
    <div className="loading" role="status" aria-live="polite">
      <span className="sr-only">Loading…</span>
      <div className="skeleton skeleton-title" />
      <div className="panel">
        <div className="skeleton skeleton-line" />
        <div className="skeleton skeleton-line" />
        <div className="skeleton skeleton-line short" />
      </div>
      <div className="panel">
        <div className="skeleton skeleton-line" />
        <div className="skeleton skeleton-line short" />
      </div>
    </div>
  );
}
