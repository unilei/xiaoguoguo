import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, Detail, formatTime, Playback, resumeTarget, streamUrl } from "../lib/api";
import {
  loadLibrary,
  saveLibrary,
  updateProgress,
} from "../lib/storage";

export function WatchPage() {
  const { id = "", episodeId = "" } = useParams();
  const navigate = useNavigate();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [playback, setPlayback] = useState<Playback | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [library, setLibrary] = useState(loadLibrary);
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);
  const startAt = useRef(0);
  const restored = useRef(false);

  const episode = detail?.episodes.find((item) => item.id === episodeId);
  const index = detail?.episodes.findIndex((item) => item.id === episodeId) ?? -1;

  useEffect(() => {
    let alive = true;
    setDetail(null);
    setLoading(true);
    setError("");
    restored.current = false;
    api
      .detail(id)
      .then((data) => {
        if (alive) setDetail(data);
      })
      .catch((problem) => {
        if (alive) setError(problem instanceof Error ? problem.message : "剧集加载失败");
      });
    return () => {
      alive = false;
    };
  }, [id]);

  // 进入播放页时按记录恢复进度。
  useEffect(() => {
    if (!detail) return;
    const record = loadLibrary().progress[detail.id];
    const target = resumeTarget(detail, record);
    startAt.current = target.position;
    if (target.index !== index && !episodeId) navigate(`/watch/${id}/${detail.episodes[target.index].id}`, { replace: true });
  }, [detail, episodeId, id, index, navigate]);

  useEffect(() => {
    let alive = true;
    setPlayback(null);
    setError("");
    setLoading(true);
    setAutoplayBlocked(false);
    restored.current = false;
    api
      .play(episodeId)
      .then((data) => {
        if (alive) setPlayback(data);
      })
      .catch((problem) => {
        if (alive) setError(problem instanceof Error ? problem.message : "播放地址解析失败");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [episodeId]);

  const persist = useCallback(
    (position: number, total: number, force = false) => {
      if (!detail) return;
      if (!force && position < 2) return;
      const next = updateProgress(
        library,
        detail,
        episodeId,
        episode?.number || index + 1,
        position,
        total
      );
      setLibrary(next);
      void saveLibrary(next);
    },
    [detail, episodeId, episode?.number, index, library]
  );

  // 每 5 秒写一次进度；暂停、退出、切集时也写。
  useEffect(() => {
    if (!detail) return;
    const timer = window.setInterval(() => {
      const video = videoRef.current;
      if (video && !video.paused && video.duration > 0)
        persist(video.currentTime, video.duration);
    }, 5000);
    const flush = () => {
      const video = videoRef.current;
      if (video && video.duration > 0) persist(video.currentTime, video.duration, true);
    };
    window.addEventListener("pagehide", flush);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [detail, persist]);

  function nextEpisode() {
    if (!detail || index < 0) return;
    const next = detail.episodes[index + 1];
    if (next) navigate(`/watch/${detail.id}/${next.id}`);
  }

  function previousEpisode() {
    if (!detail || index <= 0) return;
    navigate(`/watch/${detail.id}/${detail.episodes[index - 1].id}`);
  }

  function togglePlay() {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      void video.play().catch(() => setAutoplayBlocked(true));
    } else {
      video.pause();
    }
  }

  function seekBy(delta: number) {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = Math.max(0, Math.min(video.duration || 0, video.currentTime + delta));
  }

  const hasNext = Boolean(detail && index >= 0 && index < detail.episodes.length - 1);

  return (
    <div className="player-page">
      <div className="player-topbar">
        <Link className="icon-button" to={detail ? `/series/${detail.id}` : "/"} aria-label="返回详情">
          ←
        </Link>
        <div className="player-title">
          <h1>{detail?.title || "正在加载"}</h1>
          <p>
            {episode ? `第 ${episode.number} 集` : ""}
            {detail && ` · 共 ${detail.episodes.length} 集`}
          </p>
        </div>
        {playback && (
          <span className="quality-chip">
            {playback.kind === "account" ? "账号" : "公开预览"} · {playback.quality}
          </span>
        )}
      </div>

      <div className="player-stage">
        {playback && (
          <video
            key={playback.path}
            ref={videoRef}
            src={streamUrl(episodeId)}
            controls={false}
            playsInline
            autoPlay
            preload="metadata"
            onClick={togglePlay}
            onLoadedMetadata={(event) => {
              const video = event.currentTarget;
              setDuration(video.duration || 0);
              if (!restored.current && startAt.current > 0) {
                video.currentTime = Math.min(startAt.current, (video.duration || 0) - 1);
                restored.current = true;
              }
            }}
            onPlay={() => {
              setPlaying(true);
              setAutoplayBlocked(false);
            }}
            onPause={() => setPlaying(false)}
            onTimeUpdate={(event) => setCurrent(event.currentTarget.currentTime)}
            onEnded={() => {
              persist(0, duration || 1, true);
              if (hasNext) nextEpisode();
            }}
            onError={() =>
              setError("视频加载失败：这一集可能需要账号 Cookie，或源站暂不可用")
            }
          />
        )}

        {loading && (
          <div className="player-overlay">
            <div className="spinner" />
            <p>正在解析播放地址…</p>
          </div>
        )}

        {!loading && error && (
          <div className="player-overlay">
            <h2>无法播放这一集</h2>
            <p>{error}</p>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "center" }}>
              <button
                className="button primary"
                onClick={() => navigate(0)}
              >
                重试
              </button>
              <Link className="button" to="/settings">
                去设置 Cookie
              </Link>
              {hasNext && (
                <button className="button" onClick={nextEpisode}>
                  看下一集
                </button>
              )}
            </div>
          </div>
        )}

        {!loading && !error && autoplayBlocked && (
          <div className="player-overlay" style={{ background: "rgba(7,6,10,0.55)" }}>
            <h2>浏览器拦截了自动播放</h2>
            <p>点击下方播放按钮开始。</p>
            <button className="button primary" onClick={togglePlay}>
              ▶ 播放
            </button>
          </div>
        )}
      </div>

      <div className="player-controls">
        <button
          className="control-button"
          onClick={previousEpisode}
          disabled={index <= 0}
          aria-label="上一集"
        >
          ⏮
        </button>
        <button className="control-button" onClick={() => seekBy(-10)} aria-label="后退 10 秒">
          ↺10
        </button>
        <button className="control-button primary" onClick={togglePlay} aria-label={playing ? "暂停" : "播放"}>
          {playing ? "❚❚" : "▶"}
        </button>
        <button className="control-button" onClick={() => seekBy(10)} aria-label="前进 10 秒">
          10↻
        </button>
        <button
          className="control-button"
          onClick={nextEpisode}
          disabled={!hasNext}
          aria-label="下一集"
        >
          ⏭
        </button>
        <span className="time-readout">
          {formatTime(current)} / {formatTime(duration)}
        </span>
        <div className="grow" />
        <Link className="button small" to={detail ? `/series/${detail.id}` : "/"}>
          选集
        </Link>
      </div>

      {detail && (
        <div className="episode-strip" aria-label="快速选集">
          {detail.episodes.map((item) => (
            <Link
              key={item.id}
              className={`episode-button${item.id === episodeId ? " active" : ""}`}
              to={`/watch/${detail.id}/${item.id}`}
              style={{ display: "grid", placeItems: "center", textDecoration: "none" }}
            >
              {item.number}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
