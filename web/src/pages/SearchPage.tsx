import { FormEvent, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, mergePage, Series } from "../lib/api";
import { EmptyState, ErrorState, Loading, PosterGrid, SkeletonGrid } from "../components/Poster";
import { clearSearches, loadSearches, pushSearch } from "../lib/storage";

export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const query = (params.get("q") || "").trim();
  const [input, setInput] = useState(query);
  const [items, setItems] = useState<Series[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [history, setHistory] = useState<string[]>(loadSearches());
  const alive = useRef(true);
  const loadingRef = useRef(false);

  useEffect(() => {
    setInput(query);
  }, [query]);

  useEffect(() => {
    alive.current = true;
    if (!query) {
      setItems([]);
      setPage(1);
      setHasMore(false);
      setError("");
      return () => {
        alive.current = false;
      };
    }
    setItems([]);
    setPage(1);
    setHasMore(false);
    setBusy(true);
    setError("");
    setHistory(pushSearch(query));
    api
      .search(query, 1)
      .then((data) => {
        if (!alive.current) return;
        setItems(data.items);
        setPage(1);
        setHasMore(Boolean(data.hasMore));
      })
      .catch((problem) => {
        if (alive.current)
          setError(problem instanceof Error ? problem.message : "搜索失败");
      })
      .finally(() => {
        if (alive.current) setBusy(false);
      });
    return () => {
      alive.current = false;
    };
  }, [query]);

  async function loadMore() {
    if (loadingRef.current || !hasMore || !query) return;
    loadingRef.current = true;
    setBusy(true);
    try {
      const data = await api.search(query, page + 1);
      if (!alive.current) return;
      setItems((previous) => mergePage(previous, data.items));
      setPage(page + 1);
      setHasMore(Boolean(data.hasMore));
    } catch (problem) {
      if (alive.current)
        setError(problem instanceof Error ? problem.message : "加载更多失败");
    } finally {
      loadingRef.current = false;
      if (alive.current) setBusy(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const keyword = input.trim();
    if (!keyword) return;
    setParams({ q: keyword });
  }

  return (
    <>
      <div className="search-head">
        <form className="search-form" onSubmit={submit} style={{ width: "min(520px, 100%)" }}>
          <input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") submit(event);
            }}
            placeholder="输入剧名、题材或关键词"
            aria-label="搜索关键词"
            autoFocus
          />
          <button className="search-submit" type="submit">
            搜索
          </button>
        </form>
        {history.length > 0 && (
          <button
            className="button small ghost"
            onClick={() => {
              clearSearches();
              setHistory([]);
            }}
          >
            清空历史
          </button>
        )}
      </div>

      {history.length > 0 && (
        <div className="chips">
          {history.map((keyword) => (
            <Link
              className="chip"
              key={keyword}
              to={`/search?q=${encodeURIComponent(keyword)}`}
            >
              {keyword}
            </Link>
          ))}
        </div>
      )}

      {!query && (
        <EmptyState
          title="搜一部想看的短剧"
          hint="支持剧名与题材关键词。搜索结果来自红果内容源，登录信息不会被上传。"
        />
      )}

      {query && (
        <>
          <div className="search-head" style={{ marginTop: 8 }}>
            <div className="search-query">
              “<span>{query}</span>” 的结果
            </div>
            {!busy && items.length > 0 && (
              <span className="section-sub">已显示 {items.length} 部</span>
            )}
          </div>

          {busy && items.length === 0 && <SkeletonGrid />}
          {!busy && error && items.length === 0 && (
            <ErrorState message={error} onRetry={() => setParams({ q: query })} />
          )}
          {!busy && !error && items.length === 0 && (
            <EmptyState title="没有找到相关短剧" hint="换个关键词试试，或检查网络后重试。" />
          )}

          {items.length > 0 && (
            <>
              <PosterGrid items={items} />
              {busy && <Loading label="加载更多" />}
              {error && <div className="banner" style={{ marginTop: 18 }}>{error}</div>}
              {!busy && hasMore && (
                <div style={{ display: "flex", justifyContent: "center", marginTop: 28 }}>
                  <button className="button" onClick={() => void loadMore()}>
                    加载更多
                  </button>
                </div>
              )}
              {!busy && !hasMore && (
                <div className="empty-hint" style={{ textAlign: "center", marginTop: 28 }}>
                  已显示全部结果
                </div>
              )}
            </>
          )}
        </>
      )}
    </>
  );
}
