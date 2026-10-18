import { useState } from "react";
import { Link } from "react-router-dom";
import { formatRelative, Progress } from "../lib/api";
import { EmptyState, PosterGrid } from "../components/Poster";
import { loadLibrary, saveLibrary } from "../lib/storage";

export function LibraryPage() {
  const [library, setLibrary] = useState(loadLibrary);
  const [tab, setTab] = useState<"history" | "favorites">("history");

  const history: Progress[] = Object.values(library.progress).sort(
    (a, b) => b.updatedAt - a.updatedAt
  );

  function removeProgress(id: string) {
    const next = { ...library, progress: { ...library.progress } };
    delete next.progress[id];
    setLibrary(next);
    void saveLibrary(next);
  }

  function clearHistory() {
    const next = { ...library, progress: {} };
    setLibrary(next);
    void saveLibrary(next);
  }

  return (
    <>
      <div className="section-head" style={{ marginTop: 8 }}>
        <h1 className="section-title" style={{ fontSize: 26 }}>
          我的
        </h1>
        <span className="section-sub">观看记录与收藏只保存在本机浏览器</span>
      </div>

      <div className="tabs" role="tablist">
        <button
          className={`tab${tab === "history" ? " active" : ""}`}
          onClick={() => setTab("history")}
          role="tab"
          aria-selected={tab === "history"}
        >
          最近观看 {history.length > 0 && `(${history.length})`}
        </button>
        <button
          className={`tab${tab === "favorites" ? " active" : ""}`}
          onClick={() => setTab("favorites")}
          role="tab"
          aria-selected={tab === "favorites"}
        >
          收藏 {library.favorites.length > 0 && `(${library.favorites.length})`}
        </button>
      </div>

      {tab === "history" && (
        <>
          {history.length === 0 ? (
            <EmptyState
              title="还没有观看记录"
              hint="开始看一部剧后，这里会记住你看到哪一集、看到第几秒。"
              action={
                <Link className="button primary" to="/">
                  去发现
                </Link>
              }
            />
          ) : (
            <>
              <div className="history-list">
                {history.map((entry) => {
                  const ratio =
                    entry.duration > 0 ? Math.min(1, entry.position / entry.duration) : 0;
                  return (
                    <div className="history-row" key={entry.series.id}>
                      <Link className="history-cover" to={`/series/${entry.series.id}`}>
                        {entry.series.cover ? (
                          <img
                            src={entry.series.cover}
                            alt={entry.series.title}
                            referrerPolicy="no-referrer"
                          />
                        ) : (
                          <div className="cover-placeholder" style={{ fontSize: 18 }}>
                            果
                          </div>
                        )}
                      </Link>
                      <div className="history-info">
                        <h3>{entry.series.title}</h3>
                        <p>
                          第 {entry.episodeNumber} 集 · {formatRelative(entry.updatedAt)}
                          {entry.completed ? " · 已看完" : ""}
                        </p>
                        <div className="progress-bar">
                          <span style={{ width: `${ratio * 100}%` }} />
                        </div>
                      </div>
                      <div className="history-actions">
                        <Link
                          className="button small primary"
                          to={`/watch/${entry.series.id}/${entry.episodeId}`}
                        >
                          {entry.completed ? "看下一集" : "继续"}
                        </Link>
                        <button
                          className="button small ghost"
                          onClick={() => removeProgress(entry.series.id)}
                          aria-label={`删除 ${entry.series.title} 的记录`}
                        >
                          移除
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
              <div style={{ display: "flex", justifyContent: "center", marginTop: 24 }}>
                <button className="button small ghost" onClick={clearHistory}>
                  清空观看记录
                </button>
              </div>
            </>
          )}
        </>
      )}

      {tab === "favorites" && (
        <>
          {library.favorites.length === 0 ? (
            <EmptyState
              title="还没有收藏"
              hint="在剧集详情页点「收藏」，就会出现在这里。"
              action={
                <Link className="button primary" to="/">
                  去发现
                </Link>
              }
            />
          ) : (
            <PosterGrid items={library.favorites} />
          )}
        </>
      )}
    </>
  );
}
