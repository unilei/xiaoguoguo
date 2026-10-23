import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ApiError, fetchDetail, fetchPlayback, streamUrl, toDetailRecord } from '../lib/api';
import type { DetailRecord } from '../lib/types';
import { ReviewText } from '../components/ReviewText';
import { PageError, PageLoading } from '../components/States';

const PER_GROUP = 15;
const WHEEL_THRESHOLD = 60;
const WHEEL_LOCK_MS = 520;
const TOUCH_THRESHOLD = 60;
const HIDE_CONTROLS_MS = 2600;
/** 可选倍速档位 */
const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];

type SlideDir = 'up' | 'down';

function readPref(key: string, fallback: string): string {
  try {
    return localStorage.getItem(`hg-player-${key}`) || fallback;
  } catch {
    return fallback;
  }
}

function writePref(key: string, value: string) {
  try {
    localStorage.setItem(`hg-player-${key}`, value);
  } catch {
    // 隐私模式写不进去，退化成仅本次会话有效
  }
}

function readProgress(seriesId: string, ep: number): number {
  const raw = Number.parseFloat(readPref(`progress:${seriesId}:${ep}`, '0'));
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

function saveProgress(seriesId: string, ep: number, seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 1) return;
  writePref(`progress:${seriesId}:${ep}`, String(Math.floor(seconds)));
}

function formatTime(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const minutes = Math.floor(safe / 60);
  const rest = Math.floor(safe % 60);
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}

export function WatchPage() {
  const { id = '' } = useParams();
  const [params] = useSearchParams();
  const initialEp = Math.max(1, Number(params.get('ep') || 1) || 1);

  const [detail, setDetail] = useState<DetailRecord | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  /**
   * currentEp 是唯一的状态源。所有切集都先改它，
   * 再由下面「加载当前集」的 effect 负责换源——不在事件处理器里
   * 手动拼「先 pause、再 removeAttribute、再异步 play」的时序，
   * 那样一旦中间 await 被 StrictMode 二次执行或动画回调打断，
   * 就会留下一个 src 被清空、readyState 为 0 的黑屏视频。
   */
  const [currentEp, setCurrentEp] = useState(initialEp);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(() => readPref('muted', '0') === '1');
  const [autoNext, setAutoNext] = useState(() => readPref('autonext', '1') === '1');
  const [timeText, setTimeText] = useState('0:00 / 0:00');
  const [playedPct, setPlayedPct] = useState(0);
  const [bufferPct, setBufferPct] = useState(0);
  const [notice, setNotice] = useState('');
  const [controlsHidden, setControlsHidden] = useState(false);
  const [slide, setSlide] = useState<'' | 'in-up' | 'in-down' | 'out-up' | 'out-down'>('');
  const [hint, setHint] = useState<{ text: string; dir: SlideDir; edge?: string } | null>(null);
  const [group, setGroup] = useState(() => Math.floor((initialEp - 1) / PER_GROUP));
  /** 右栏标签页：视频信息 / 评论 */
  const [tab, setTab] = useState<'video' | 'comments'>('video');
  /** 播放倍速，从上次的选择恢复 */
  const [rate, setRate] = useState(() => {
    const saved = Number.parseFloat(readPref('rate', '1'));
    return PLAYBACK_RATES.includes(saved) ? saved : 1;
  });


  const videoRef = useRef<HTMLVideoElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const leftRef = useRef<HTMLDivElement | null>(null);
  const rightRef = useRef<HTMLElement | null>(null);
  const pendingSeek = useRef(0);
  /** 上一次真正写进 <video> 的集号，避免 effect 重复触发时重复换源 */
  const loadedEp = useRef(0);
  const hideTimer = useRef<number | null>(null);
  const hintTimer = useRef<number | null>(null);
  const noticeTimer = useRef<number | null>(null);
  const wheelAccum = useRef(0);
  const wheelLock = useRef(false);
  const touch = useRef({ active: false, startY: 0, startX: 0 });
  const autoNextRef = useRef(autoNext);
  const currentEpRef = useRef(currentEp);
  /** 换源回调里要用最新倍速，但闭包里拿不到，所以同步一份到 ref */
  const rateRef = useRef(rate);

  autoNextRef.current = autoNext;
  currentEpRef.current = currentEp;
  rateRef.current = rate;

  const total = detail?.episodes || 0;
  const groups = useMemo(() => (total ? Math.ceil(total / PER_GROUP) : 0), [total]);
  const hasNext = currentEp < total;
  const hasPrev = currentEp > 1;

  const clampEp = useCallback(
    (n: number) => Math.min(Math.max(1, n), Math.max(1, total)),
    [total]
  );

  const showNotice = useCallback((text: string) => {
    setNotice(text);
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(''), 2200);
  }, []);

  const showControls = useCallback((force = false) => {
    setControlsHidden(false);
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    if (force) return;
    hideTimer.current = window.setTimeout(() => {
      const video = videoRef.current;
      if (video && !video.paused) setControlsHidden(true);
    }, HIDE_CONTROLS_MS);
  }, []);

  // ---------------------------------------------------------------- 拉详情
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    fetchDetail(id)
      .then((payload) => {
        if (alive) setDetail(toDetailRecord(payload));
      })
      .catch((problem) => {
        if (alive) setError(problem instanceof ApiError ? problem.message : '剧集加载失败');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [id]);

  useEffect(() => {
    if (detail) document.title = `${detail.title} 第${currentEp}集_红果短剧官网`;
  }, [detail, currentEp]);

  // ---------------------------------------------------------------- 加载当前集
  /**
   * 唯一的换源入口。依赖 [detail, currentEp]：
   * 只要集号变了（不管是按钮、滚轮、键盘还是自动连播），
   * 都由这里统一解析地址、写入 src、恢复进度、起播。
   */
  useEffect(() => {
    if (!detail) return;
    const vid = detail.vidList[currentEp - 1];
    if (!vid) {
      showNotice('这一集没有可用的播放地址。');
      return;
    }
    if (loadedEp.current === currentEp) return;
    loadedEp.current = currentEp;

    let alive = true;
    setTimeText('0:00 / 0:00');
    setPlayedPct(0);
    setBufferPct(0);
    setNotice('');

    fetchPlayback(vid)
      .then(() => {
        if (!alive) return;
        const video = videoRef.current;
        if (!video) return;
        pendingSeek.current = readProgress(detail.id, currentEp);
        video.src = streamUrl(vid);
        video.load();
        // load() 会把 playbackRate 重置成 1，所以必须放在 load 之后。
        // 只设一次还不够：元数据就绪时浏览器会再复位一次，
        // onLoadedMetadata 里会补第二次。
        video.playbackRate = rateRef.current;
        const played = video.play();
        if (played && typeof played.catch === 'function') {
          // 自动播放被拦截是正常现象，等用户点大播放按钮
          played.catch(() => setPlaying(false));
        }
      })
      .catch((problem) => {
        if (!alive) return;
        const apiError = problem instanceof ApiError ? problem : null;
        if (apiError?.status === 402) showNotice('这一集需要登录后才能播放。');
        else showNotice(apiError?.message || '取播放地址失败');
        setPlaying(false);
      });

    return () => {
      alive = false;
    };
  }, [detail, currentEp, showNotice]);

  // ---------------------------------------------------------------- 切集
  const goToEp = useCallback(
    (next: number, dir: SlideDir) => {
      if (!detail) return;
      const target = clampEp(next);

      // 越界：给边界提示，不改集号
      if (target === currentEp) {
        if (dir === 'up' && currentEp >= total) {
          setHint({ text: '已经是最后一集', dir, edge: 'at-last' });
        } else if (dir === 'down' && currentEp <= 1) {
          setHint({ text: '已经是第一集', dir, edge: 'at-first' });
        } else {
          return;
        }
        if (hintTimer.current) window.clearTimeout(hintTimer.current);
        hintTimer.current = window.setTimeout(() => setHint(null), 1200);
        return;
      }

      // 先把当前进度落盘，再换集
      const video = videoRef.current;
      if (video?.duration) saveProgress(detail.id, currentEp, video.currentTime);

      setSlide(dir === 'up' ? 'out-up' : 'out-down');
      setCurrentEp(target);
      setGroup(Math.floor((target - 1) / PER_GROUP));

      // URL 同步但不堆历史：浏览器后退仍回详情页
      window.history.replaceState(null, '', `/player/${detail.id}?ep=${target}`);

      window.setTimeout(() => {
        setSlide(dir === 'up' ? 'in-up' : 'in-down');
        window.setTimeout(() => setSlide(''), 360);
      }, 150);
    },
    [clampEp, currentEp, detail, total]
  );

  // 当前集滚动到选集区可视范围。
  // 只在选集格被裁切时才滚，且滚动量取最小必要值——
  // 头部（标签/剧名/封面）是固定的，不参与滚动。
  // 用 rAF 等一帧再算：effect 执行时分组条刚换成新内容，
  // 直接量 rect 会拿到切换前的布局。
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const pane = rightRef.current?.querySelector<HTMLElement>('.player-right-scroll');
      if (!pane) return;
      const active = pane.querySelector<HTMLElement>('.player-ep.active');
      if (!active) return;
      const paneRect = pane.getBoundingClientRect();
      const epRect = active.getBoundingClientRect();
      if (epRect.bottom > paneRect.bottom) {
        pane.scrollTop += epRect.bottom - paneRect.bottom + 12;
      } else if (epRect.top < paneRect.top) {
        pane.scrollTop -= paneRect.top - epRect.top + 12;
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [currentEp, group]);

  // ---------------------------------------------------------------- 舞台尺寸
  /**
   * 舞台宽高按视频真实比例 + 可用空间算。
   * 真人剧 9:16 贴合高度，AI 剧 16:9 贴合宽度。
   *
   * 可用空间由「视口 − 页头 − 右栏」推算，不读左栏尺寸：
   * 左栏宽高会被舞台尺寸反向撑开，读它必然形成循环，
   * 结果是比例随窗口尺寸漂移（1280 下算成 1.33，1920 下算成 1.54）。
   */
  const [stageSize, setStageSize] = useState<{ width: number; height: number } | null>(null);

  const fitStage = useCallback(() => {
    const video = videoRef.current;
    if (!video || !video.videoWidth || !video.videoHeight) return;
    const ratio = video.videoWidth / video.videoHeight;
    const headerH = 64;
    // 右栏宽度：1280 及以下按 300，以上按 360（与 CSS 媒体查询一致）
    const rightW = window.innerWidth <= 1280 ? 300 : 360;
    // 播放页内容区与首页同宽（1240，宽屏 1720），不是整个视口
    const pageW =
      window.innerWidth >= 1880
        ? Math.min(1720, window.innerWidth - 640)
        : Math.min(1240, window.innerWidth);
    const availH = Math.max(320, window.innerHeight - headerH);
    const availW = Math.max(320, pageW - rightW);
    let width = availH * ratio;
    let height = availH;
    if (width > availW) {
      width = availW;
      height = availW / ratio;
    }
    const next = { width: Math.floor(width), height: Math.floor(height) };
    setStageSize((prev) =>
      prev && prev.width === next.width && prev.height === next.height ? prev : next
    );
    // 窄舞台用紧凑控件条：7 个按钮 + 时间会把进度条挤到没法拖
    stageRef.current?.classList.toggle('is-narrow', next.width < 620);
  }, []);

  useEffect(() => {
    window.addEventListener('resize', fitStage);
    // 首次进入与切集后也重算：视频尺寸或视口变化都可能发生在
    // loadedmetadata 之后（比如浏览器恢复窗口尺寸）。
    const frame = requestAnimationFrame(fitStage);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', fitStage);
    };
  }, [fitStage, detail, currentEp]);

  // 倍速：直接写进 video 元素。换源时由上面的换集逻辑重新补一次。
  useEffect(() => {
    const video = videoRef.current;
    if (video) video.playbackRate = rate;
  }, [rate, currentEp]);

  // ---------------------------------------------------------------- 视频事件
  const onLoadedMetadata = () => {
    const video = videoRef.current;
    if (!video) return;
    // 换源后浏览器会在这个时机把 playbackRate 复位成 1，补一次。
    video.playbackRate = rateRef.current;
    // videoWidth 在 loadedmetadata 时可能仍是 0（尤其只 preload=metadata）。
    // 轮询到拿到尺寸为止，再算舞台；最多等 1.5 秒。
    if (video.videoWidth) {
      fitStage();
    } else {
      const startedAt = Date.now();
      const poll = () => {
        const current = videoRef.current;
        if (!current) return;
        if (current.videoWidth) {
          fitStage();
          return;
        }
        if (Date.now() - startedAt < 1500) requestAnimationFrame(poll);
      };
      requestAnimationFrame(poll);
    }
    if (pendingSeek.current > 0) {
      video.currentTime = Math.min(pendingSeek.current, Math.max(0, video.duration - 1));
      pendingSeek.current = 0;
    }
    setTimeText(`${formatTime(video.currentTime)} / ${formatTime(video.duration)}`);
  };

  const onTimeUpdate = () => {
    const video = videoRef.current;
    if (!video || !detail) return;
    const duration = video.duration || 0;
    const current = video.currentTime || 0;
    setTimeText(`${formatTime(current)} / ${formatTime(duration)}`);
    setPlayedPct(duration > 0 ? (current / duration) * 100 : 0);
    saveProgress(detail.id, currentEpRef.current, current);
  };

  const onProgress = () => {
    const video = videoRef.current;
    if (!video?.buffered.length || !video.duration) return;
    const end = video.buffered.end(video.buffered.length - 1);
    setBufferPct(Math.min(100, (end / video.duration) * 100));
  };

  const onEnded = () => {
    setPlaying(false);
    if (!detail) return;
    saveProgress(detail.id, currentEpRef.current, 0);
    if (!autoNextRef.current) {
      showNotice('本集播完。可向下滑动或点「连播」继续。');
      return;
    }
    if (currentEpRef.current < total) goToEp(currentEpRef.current + 1, 'up');
    else showNotice('已经是最后一集了。');
  };

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video || !video.src) return;
    if (video.paused) {
      void video
        .play()
        .then(() => setPlaying(true))
        .catch(() => setPlaying(false));
    } else {
      video.pause();
      setPlaying(false);
    }
  };

  // ---------------------------------------------------------------- 输入
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;

    const onWheel = (event: WheelEvent) => {
      if (wheelLock.current || Math.abs(event.deltaY) < 1) return;
      wheelAccum.current += event.deltaY;
      if (Math.abs(wheelAccum.current) < WHEEL_THRESHOLD) return;
      const dir: SlideDir = wheelAccum.current > 0 ? 'up' : 'down';
      wheelAccum.current = 0;
      wheelLock.current = true;
      window.setTimeout(() => {
        wheelLock.current = false;
      }, WHEEL_LOCK_MS);
      goToEp(dir === 'up' ? currentEpRef.current + 1 : currentEpRef.current - 1, dir);
    };

    const onTouchStart = (event: TouchEvent) => {
      if (!event.touches.length) return;
      touch.current = {
        active: true,
        startY: event.touches[0].clientY,
        startX: event.touches[0].clientX,
      };
      showControls();
    };

    const onTouchMove = (event: TouchEvent) => {
      if (!touch.current.active || !event.touches.length) return;
      const dy = event.touches[0].clientY - touch.current.startY;
      const dx = event.touches[0].clientX - touch.current.startX;
      if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 12) {
        if (event.cancelable) event.preventDefault();
        const offset = Math.max(-40, Math.min(40, dy * 0.18));
        stage.style.setProperty('--drag-y', `${offset}px`);
      }
    };

    const onTouchEnd = (event: TouchEvent) => {
      if (!touch.current.active) return;
      touch.current.active = false;
      stage.style.setProperty('--drag-y', '0px');
      const point = event.changedTouches[0];
      if (!point) return;
      const dy = point.clientY - touch.current.startY;
      const dx = point.clientX - touch.current.startX;
      if (Math.abs(dy) < TOUCH_THRESHOLD || Math.abs(dy) < Math.abs(dx)) return;
      goToEp(dy < 0 ? currentEpRef.current + 1 : currentEpRef.current - 1, dy < 0 ? 'up' : 'down');
    };

    stage.addEventListener('wheel', onWheel, { passive: true });
    stage.addEventListener('touchstart', onTouchStart, { passive: true });
    stage.addEventListener('touchmove', onTouchMove, { passive: false });
    stage.addEventListener('touchend', onTouchEnd, { passive: true });
    return () => {
      stage.removeEventListener('wheel', onWheel);
      stage.removeEventListener('touchstart', onTouchStart);
      stage.removeEventListener('touchmove', onTouchMove);
      stage.removeEventListener('touchend', onTouchEnd);
    };
  }, [goToEp, showControls]);

  // 键盘：↑↓ 切集、空格播放、←→ 快进退
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const tag = (event.target as HTMLElement | null)?.tagName || '';
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag)) return;
      const video = videoRef.current;
      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          goToEp(currentEpRef.current + 1, 'up');
          break;
        case 'ArrowUp':
          event.preventDefault();
          goToEp(currentEpRef.current - 1, 'down');
          break;
        case ' ':
        case 'Spacebar':
          event.preventDefault();
          togglePlay();
          break;
        case 'ArrowRight':
          event.preventDefault();
          if (video) video.currentTime = Math.min(video.duration || 0, video.currentTime + 5);
          break;
        case 'ArrowLeft':
          event.preventDefault();
          if (video) video.currentTime = Math.max(0, video.currentTime - 5);
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goToEp]);

  // 卸载时落盘进度
  useEffect(
    () => () => {
      const video = videoRef.current;
      if (video?.duration && detail) saveProgress(detail.id, currentEpRef.current, video.currentTime);
      if (hideTimer.current) window.clearTimeout(hideTimer.current);
      if (hintTimer.current) window.clearTimeout(hintTimer.current);
      if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    },
    [detail]
  );

  // ---------------------------------------------------------------- 进度条
  const seekTo = (clientX: number) => {
    const video = videoRef.current;
    const bar = document.getElementById('pcProgress');
    if (!video || !bar || !video.duration) return;
    const rect = bar.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    video.currentTime = ratio * video.duration;
    setPlayedPct(ratio * 100);
    setTimeText(`${formatTime(video.currentTime)} / ${formatTime(video.duration)}`);
  };

  if (error) return <PageError message={error} onRetry={() => window.location.reload()} />;
  if (loading || !detail) return <PageLoading label="正在加载播放页" />;

  const groupStart = group * PER_GROUP + 1;
  const groupEnd = Math.min((group + 1) * PER_GROUP, total);
  const groupEps = Array.from({ length: groupEnd - groupStart + 1 }, (_, i) => groupStart + i);

  return (
    <div className="player-page">
      {/* 外层铺满整屏黑底；内层把「舞台 + 右栏」限制在 1240，
          与首页 .main-page / .header-inner 同宽同位置。 */}
      <div className="player-body-wrap">
        <div
          className={`player-left${controlsHidden ? ' controls-hidden' : ''}`}
          ref={leftRef}
          onMouseMove={() => showControls()}
          onMouseLeave={() => {
            const video = videoRef.current;
            if (video && !video.paused) setControlsHidden(true);
          }}
        >
        <div
          className="player-stage"
          ref={stageRef}
          style={stageSize ? { width: stageSize.width, height: stageSize.height } : undefined}
        >
          {/* 面包屑挂在舞台内而不是左栏：左栏在横屏剧上下会留大片黑边，
              挂左栏就会浮在空白里。放舞台内永远贴着画面左上角。
              不跟随控件条淡出——导航入口不该在鼠标静止时消失。 */}
          <div className="player-breadcrumb">
            <Link to="/">首页</Link> / <Link to={`/detail/${detail.id}`}>{detail.title}</Link> / 第
            {currentEp}集
          </div>

          <div className={`player-frame${slide ? ` slide-${slide}` : ''}`}>
            {!playing && <img className="player-poster" src={detail.cover} alt={detail.title} />}
            <video
              ref={videoRef}
              className="player-video"
              playsInline
              preload="metadata"
              muted={muted}
              onLoadedMetadata={onLoadedMetadata}
              onTimeUpdate={onTimeUpdate}
              onProgress={onProgress}
              // playing 只在真正开始播放后触发，比 play 可靠：
              // play() 被策略拦截时不会误报「正在播放」。
              onPlaying={() => {
                setPlaying(true);
                showControls();
              }}
              onPause={() => {
                setPlaying(false);
                showControls(true);
              }}
              onEnded={onEnded}
              onClick={() => showControls()}
            />
            {!playing && (
              <div className="player-overlay">
                <button
                  className="player-play-btn"
                  type="button"
                  aria-label="播放"
                  onClick={togglePlay}
                />
              </div>
            )}
          </div>

          {hint && (
            <div
              className={`player-swipe-hint show${hint.edge ? ` ${hint.edge}` : ''}`}
              data-dir={hint.dir}
            >
              <span className="player-swipe-arrow" />
              <span className="player-swipe-text">{hint.text}</span>
            </div>
          )}

          <div className="player-controls">
            <button
              className="pc-ctrl pc-ctrl-prev"
              type="button"
              aria-label="上一集"
              title="上一集"
              disabled={!hasPrev}
              onClick={() => goToEp(currentEp - 1, 'down')}
            >
              ⏮
            </button>
            <button
              className="pc-ctrl pc-ctrl-toggle"
              type="button"
              aria-label={playing ? '暂停' : '播放'}
              onClick={togglePlay}
            >
              {playing ? '❚❚' : '▶'}
            </button>
            <button
              className="pc-ctrl pc-ctrl-next"
              type="button"
              aria-label="下一集"
              title="下一集"
              disabled={!hasNext}
              onClick={() => goToEp(currentEp + 1, 'up')}
            >
              ⏭
            </button>
            <span className="pc-time">{timeText}</span>
            <div
              className="pc-progress"
              id="pcProgress"
              role="slider"
              aria-label="播放进度"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(playedPct)}
              onPointerDown={(event) => {
                event.currentTarget.setPointerCapture(event.pointerId);
                seekTo(event.clientX);
              }}
              onPointerMove={(event) => {
                if (event.buttons === 1) seekTo(event.clientX);
              }}
            >
              <div className="pc-progress-buffer" style={{ width: `${bufferPct}%` }} />
              <div className="pc-progress-played" style={{ width: `${playedPct}%` }}>
                <span className="pc-progress-knob" />
              </div>
            </div>
            <button
              className="pc-ctrl pc-ctrl-mute"
              type="button"
              aria-label={muted ? '取消静音' : '静音'}
              onClick={() => {
                const next = !muted;
                setMuted(next);
                writePref('muted', next ? '1' : '0');
                if (videoRef.current) videoRef.current.muted = next;
              }}
            >
              {muted ? '🔇' : '🔊'}
            </button>
            {/* 倍速：点一下切到下一档，走一圈回到 0.5。窄舞台里用菜单会盖住画面，
                循环切换更省空间，也少一次交互。 */}
            <button
              className={`pc-ctrl pc-ctrl-rate${rate !== 1 ? ' active' : ''}`}
              type="button"
              aria-label={`倍速：${rate}x`}
              title="切换倍速"
              onClick={() => {
                const index = PLAYBACK_RATES.indexOf(rate);
                const next = PLAYBACK_RATES[(index + 1) % PLAYBACK_RATES.length];
                setRate(next);
                writePref('rate', String(next));
              }}
            >
              {rate}x
            </button>
            <button
              className={`pc-ctrl pc-ctrl-autonext${autoNext ? ' active' : ''}`}
              type="button"
              aria-label="自动连播"
              title={`自动连播：${autoNext ? '开' : '关'}`}
              onClick={() => {
                const next = !autoNext;
                setAutoNext(next);
                writePref('autonext', next ? '1' : '0');
              }}
            >
              连播
            </button>
            <button
              className="pc-ctrl pc-ctrl-full"
              type="button"
              aria-label="全屏"
              title="全屏"
              onClick={() => {
                if (document.fullscreenElement) void document.exitFullscreen();
                else void leftRef.current?.requestFullscreen?.();
              }}
            >
              ⛶
            </button>
          </div>

          {notice && <p className="player-notice">{notice}</p>}
        </div>
      </div>

      <aside className="player-right" ref={rightRef}>
        {/* 头部固定：标签 + 剧名始终可见，不随下方内容滚动 */}
        <div className="player-tabs">
          <button
            className={`player-tab${tab === 'video' ? ' active' : ''}`}
            type="button"
            onClick={() => setTab('video')}
          >
            视频
          </button>
          <button
            className={`player-tab${tab === 'comments' ? ' active' : ''}`}
            type="button"
            onClick={() => setTab('comments')}
          >
            评论
          </button>
        </div>

        <div className="player-series" hidden={tab !== 'video'}>
          <div className="player-series-cover">
            <img src={detail.cover} alt={detail.title} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h1 className="player-series-title">{detail.title}</h1>
            <div className="player-series-tags">
              {detail.tags.map((tag) => (
                <span className="player-series-tag" key={tag}>
                  {tag}
                </span>
              ))}
            </div>
          </div>
        </div>

        <div className="player-right-scroll" hidden={tab !== 'video'}>
          <h2 className="player-section-title">简介</h2>
          <p className="player-intro">{detail.intro}</p>

          {detail.celebrities.length > 0 && (
            <>
              <h2 className="player-section-title">演职人员</h2>
              <div className="player-celebs">
                {detail.celebrities.slice(0, 8).map((person) => (
                  <div className="player-celeb" key={person.name}>
                    {person.avatar && (
                      <img
                        className="player-celeb-avatar"
                        src={person.avatar}
                        alt={person.name}
                        loading="lazy"
                      />
                    )}
                    <p className="player-celeb-name">{person.name}</p>
                    {person.role && <p className="player-celeb-role">{person.role}</p>}
                  </div>
                ))}
              </div>
            </>
          )}

          <h2 className="player-section-title">选集</h2>
        <div className="player-ep-groups">
          {Array.from({ length: groups }, (_, index) => {
            const start = index * PER_GROUP + 1;
            const end = Math.min((index + 1) * PER_GROUP, total);
            return (
              <button
                key={start}
                className={`player-ep-group${index === group ? ' active' : ''}`}
                type="button"
                onClick={() => setGroup(index)}
              >
                {start}-{end}
              </button>
            );
          })}
        </div>
        <div className="player-ep-grid">
          {groupEps.map((n) => (
            <button
              key={n}
              className={`player-ep${n === currentEp ? ' active' : ''}`}
              type="button"
              onClick={() => goToEp(n, n > currentEp ? 'up' : 'down')}
            >
              {n}
            </button>
          ))}
        </div>
        </div>

        {tab === 'comments' && (
          <div className="player-right-scroll player-comments">
            {detail.reviews.length > 0 ? (
              detail.reviews.map((review, index) => (
                <article className="detail-review-card" key={`${review.user}-${index}`}>
                  <ReviewText text={review.content} />
                  <div className="detail-review-foot">
                    {review.avatar && (
                      <img className="detail-review-avatar" src={review.avatar} alt="" loading="lazy" />
                    )}
                    <span>{review.user || '匿名用户'}</span>
                    <span className="detail-review-digg">♡ {review.digg}</span>
                  </div>
                </article>
              ))
            ) : (
              <p className="player-comments-empty">暂无评论</p>
            )}
          </div>
        )}
      </aside>
      </div>
    </div>
  );
}
