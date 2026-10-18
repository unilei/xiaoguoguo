import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, Detail, resumeTarget } from "../lib/api";
import { ErrorState, Loading } from "../components/Poster";
import {
  isFavorite,
  loadLibrary,
  saveLibrary,
  toggleFavorite,
} from "../lib/storage";

const GROUP_SIZE = 20;

export function DetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  const [group, setGroup] = useState(0);
  const [library, setLibrary] = useState(loadLibrary);

  useEffect(() => {
    let alive = true;
    setDetail(null);
    setError("");
    setGroup(0);
    api
      .detail(id)
      .then((data) => {
        if (alive) setDetail(data);
      })
      .catch((problem) => {
        if (alive) setError(problem instanceof Error ? problem.message : "详情加载失败");
      });
    return () => {
      alive = false;
    };
  }, [id]);

  const progress = detail ? library.progress[detail.id] : undefined;
  const favorite = detail ? isFavorite(library, detail.id) : false;
  const groups = useMemo(() => {
    if (!detail) return [];
    const chunks: { label: string; episodes: Detail["episodes"] }[] = [];
    for (let index = 0; index < detail.episodes.length; index += GROUP_SIZE) {
      const start = index + 1;
      const end = Math.min(index + GROUP_SIZE, detail.episodes.length);
      chunks.push({
        label: `${start}–${end} 集`,
        episodes: detail.episodes.slice(index, index + GROUP_SIZE),
      });
    }
    return chunks;
  }, [detail]);

  // 有进度时直接定位到对应分组。
  useEffect(() => {
    if (!detail) return;
    const target = resumeTarget(detail, progress);
    setGroup(Math.floor(target.index / GROUP_SIZE));
  }, [detail, progress]);

  if (error) return <ErrorState message={error} onRetry={() => navigate(0)} />;
  if (!detail) return <Loading label="正在加载剧集" />;

  const target = resumeTarget(detail, progress);
  const currentEpisode = detail.episodes[target.index];

  function toggle() {
    if (!detail) return;
    const next = toggleFavorite(library, detail);
    setLibrary(next);
    void saveLibrary(next);
  }

  return (
    <>
      <div className="detail-head">
        <div className="detail-poster">
          {detail.cover ? (
            <img src={detail.cover} alt={detail.title} referrerPolicy="no-referrer" />
          ) : (
            <div className="cover-placeholder">果</div>
          )}
        </div>
        <div className="detail-info">
          <h1 className="detail-title">{detail.title}</h1>
          <div className="detail-meta">
            {detail.badge && <span>{detail.badge}</span>}
            {detail.badge && <span className="dot" />}
            <span>{detail.episodes.length} 集</span>
            {detail.tags && <span className="dot" />}
            {detail.tags && <span>{detail.tags.split("/").filter(Boolean).join(" · ")}</span>}
          </div>
          {detail.description && <p className="detail-desc">{detail.description}</p>}
          <div className="detail-actions">
            <Link
              className="button primary"
              to={`/watch/${detail.id}/${currentEpisode.id}`}
            >
              {progress && !progress.completed
                ? `▶ 继续第 ${progress.episodeNumber} 集`
                : progress?.completed
                  ? "▶ 看下一集"
                  : "▶ 从第 1 集开始"}
            </Link>
            {progress && progress.position > 0 && !progress.completed && (
              <Link
                className="button"
                to={`/watch/${detail.id}/${progress.episodeId}`}
              >
                重看当前集
              </Link>
            )}
            <button className="button ghost" onClick={toggle}>
              {favorite ? "★ 已收藏" : "☆ 收藏"}
            </button>
          </div>
          <div className="banner">
            <span>
              <strong>播放说明：</strong>
              公开预览通常只覆盖每部剧的前几集（360P）。其余剧集需要在
              <Link to="/settings" style={{ color: "var(--accent)" }}>
                {" "}
                设置{" "}
              </Link>
              中填入你自己的账号 Cookie 后解锁。
            </span>
          </div>
        </div>
      </div>

      <section className="episode-section">
        <div className="section-head">
          <h2 className="section-title">选集</h2>
          <span className="section-sub">共 {detail.episodes.length} 集</span>
        </div>
        {groups.length > 1 && (
          <div className="episode-groups">
            {groups.map((chunk, index) => (
              <button
                key={chunk.label}
                className={`group-chip${index === group ? " active" : ""}`}
                onClick={() => setGroup(index)}
              >
                {chunk.label}
              </button>
            ))}
          </div>
        )}
        <div className="episode-grid">
          {(groups[group]?.episodes || detail.episodes).map((episode) => {
            const ratio =
              progress && progress.episodeId === episode.id && progress.duration > 0
                ? Math.min(1, progress.position / progress.duration)
                : 0;
            return (
              <Link
                key={episode.id}
                className={`episode-button${
                  progress?.episodeId === episode.id ? " active" : ""
                }`}
                to={`/watch/${detail.id}/${episode.id}`}
                style={{ display: "grid", placeItems: "center", textDecoration: "none" }}
              >
                {episode.number}
                {ratio > 0 && (
                  <span className="ep-progress">
                    <span style={{ width: `${ratio * 100}%` }} />
                  </span>
                )}
              </Link>
            );
          })}
        </div>
      </section>
    </>
  );
}
