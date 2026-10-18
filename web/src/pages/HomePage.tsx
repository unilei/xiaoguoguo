import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, ListPage, Series } from "../lib/api";
import { ErrorState, Loading, PosterGrid } from "../components/Poster";
import { loadLibrary } from "../lib/storage";

export function HomePage() {
  const [items, setItems] = useState<Series[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [heroIndex, setHeroIndex] = useState(0);
  const sentinel = useRef<HTMLDivElement | null>(null);
  const alive = useRef(true);
  const loadingRef = useRef(false);
  const library = loadLibrary();

  const load = useCallback(async (nextPage: number, replace: boolean) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setBusy(true);
    setError("");
    try {
      const data: ListPage = await api.home(nextPage);
      if (!alive.current) return;
      setItems((previous) => {
        const merged = replace ? data.items : [...previous, ...data.items];
        return Array.from(new Map(merged.map((item) => [item.id, item])).values());
      });
      setPage(nextPage);
      setTotalPages(data.totalPages || nextPage);
    } catch (problem) {
      if (alive.current)
        setError(problem instanceof Error ? problem.message : "首页加载失败");
    } finally {
      loadingRef.current = false;
      if (alive.current) setBusy(false);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void load(1, true);
    return () => {
      alive.current = false;
    };
  }, [load]);

  // 首页轮播：每 7 秒换一部，鼠标悬停时暂停。
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (paused || items.length < 2) return;
    const timer = window.setInterval(
      () => setHeroIndex((index) => (index + 1) % Math.min(items.length, 6)),
      7000
    );
    return () => window.clearInterval(timer);
  }, [paused, items.length]);

  // 无限滚动：接近底部时取下一页。
  useEffect(() => {
    const target = sentinel.current;
    if (!target) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !loadingRef.current && page < totalPages)
          void load(page + 1, false);
      },
      { rootMargin: "600px 0px" }
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [load, page, totalPages]);

  if (!items.length && busy) return <Loading label="正在加载推荐" />;
  if (!items.length && error)
    return <ErrorState message={error} onRetry={() => void load(1, true)} />;
  if (!items.length)
    return <ErrorState message="暂时没有可展示的剧集，稍后再试" onRetry={() => void load(1, true)} />;

  const hero = items[Math.min(heroIndex, items.length - 1)];
  const continuing = Object.values(library.progress)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 6);

  return (
    <>
      <section
        className="hero"
        onMouseEnter={() => setPaused(true)}
        onMouseLeave={() => setPaused(false)}
      >
        <div className="hero-backdrop" aria-hidden="true">
          {hero.cover && <img src={hero.cover} alt="" referrerPolicy="no-referrer" />}
        </div>
        <div className="hero-content">
          <Link className="hero-poster" to={`/series/${hero.id}`}>
            {hero.cover ? (
              <img src={hero.cover} alt={hero.title} referrerPolicy="no-referrer" />
            ) : (
              <div className="cover-placeholder">果</div>
            )}
          </Link>
          <div className="hero-info">
            <div className="hero-kicker">今日推荐</div>
            <h1 className="hero-title">{hero.title}</h1>
            {hero.description && <p className="hero-desc">{hero.description}</p>}
            <div className="hero-tags">
              {hero.badge && <span className="tag">{hero.badge}</span>}
              {hero.tags
                .split("/")
                .filter(Boolean)
                .slice(0, 5)
                .map((tag) => (
                  <span className="tag" key={tag}>
                    {tag}
                  </span>
                ))}
            </div>
            <div className="hero-actions">
              <Link className="button primary" to={`/series/${hero.id}`}>
                ▶ 立即观看
              </Link>
              <button
                className="button ghost"
                onClick={() => setHeroIndex((index) => (index + 1) % Math.min(items.length, 6))}
              >
                换一部
              </button>
            </div>
          </div>
        </div>
      </section>

      {continuing.length > 0 && (
        <section className="section">
          <div className="section-head">
            <h2 className="section-title">继续观看</h2>
            <span className="section-sub">从上次停下的地方接着看</span>
            <Link className="section-more" to="/library">
              全部记录
            </Link>
          </div>
          <div className="grid">
            {continuing.map((entry) => (
              <Link
                className="card"
                key={entry.series.id}
                to={`/watch/${entry.series.id}/${entry.episodeId}`}
              >
                <div className="cover">
                  {entry.series.cover ? (
                    <img
                      src={entry.series.cover}
                      alt={entry.series.title}
                      loading="lazy"
                      referrerPolicy="no-referrer"
                    />
                  ) : (
                    <div className="cover-placeholder">果</div>
                  )}
                  <div className="cover-badge">第 {entry.episodeNumber} 集</div>
                </div>
                <div className="card-title">{entry.series.title}</div>
                <div className="card-meta">
                  {entry.completed
                    ? "已看完，继续下一集"
                    : `看到 ${Math.round(
                        entry.duration > 0 ? (entry.position / entry.duration) * 100 : 0
                      )}%`}
                </div>
              </Link>
            ))}
          </div>
        </section>
      )}

      <section className="section">
        <div className="section-head">
          <h2 className="section-title">热播短剧</h2>
          <span className="section-sub">
            第 {page} / {totalPages} 页
          </span>
        </div>
        <PosterGrid items={items} />
        <div ref={sentinel} />
        {busy && <Loading label="加载更多" />}
        {error && items.length > 0 && (
          <div className="state">
            <p>{error}</p>
            <button className="button" onClick={() => void load(page + 1, false)}>
              重试
            </button>
          </div>
        )}
        {!busy && page >= totalPages && <div className="empty-hint" style={{ textAlign: "center", marginTop: 28 }}>已经到底了</div>}
      </section>
    </>
  );
}
