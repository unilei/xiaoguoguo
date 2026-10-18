import { Link } from "react-router-dom";
import { Series } from "../lib/api";

export function Poster({
  item,
  quality,
}: {
  item: Series;
  quality?: string;
}) {
  return (
    <Link className="card" to={`/series/${item.id}`} title={item.title}>
      <div className="cover">
        {item.cover ? (
          <img
            src={item.cover}
            alt={item.title}
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={(event) => {
              const image = event.currentTarget;
              image.style.display = "none";
              image.parentElement?.classList.add("broken");
            }}
          />
        ) : (
          <div className="cover-placeholder">果</div>
        )}
        {quality && <div className="cover-quality">{quality}</div>}
        {item.badge && <div className="cover-badge">{item.badge}</div>}
      </div>
      <div className="card-title">{item.title}</div>
      {item.tags && <div className="card-meta">{item.tags.split("/").slice(0, 3).join(" · ")}</div>}
    </Link>
  );
}

export function PosterGrid({ items }: { items: Series[] }) {
  return (
    <div className="grid">
      {items.map((item) => (
        <Poster key={item.id} item={item} />
      ))}
    </div>
  );
}

export function SkeletonGrid({ count = 12 }: { count?: number }) {
  return (
    <div className="skeleton-grid" aria-hidden="true">
      {Array.from({ length: count }, (_, index) => (
        <div className="skeleton" key={index} />
      ))}
    </div>
  );
}

export function Loading({ label = "加载中" }: { label?: string }) {
  return (
    <div className="state" role="status" aria-live="polite">
      <div className="spinner" />
      <p>{label}…</p>
    </div>
  );
}

export function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div className="state" role="alert">
      <h2>出了点问题</h2>
      <p>{message}</p>
      {onRetry && (
        <button className="button primary" onClick={onRetry}>
          重试
        </button>
      )}
    </div>
  );
}

export function EmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="state">
      <h2>{title}</h2>
      {hint && <p>{hint}</p>}
      {action}
    </div>
  );
}
