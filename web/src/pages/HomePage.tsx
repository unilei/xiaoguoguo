import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { ApiError, fetchHome, fetchHomePage, toCards } from '../lib/api';
import type { HomeData } from '../lib/api';
import type { SeriesCard } from '../lib/types';
import { ASSETS, FOOTER_LINKS } from '../lib/site';
import { PageError, PageLoading } from '../components/States';

/**
 * 首屏散页卡片的动画常量，取自原站 bundle page.0eb8f5ae17.js：
 * M = 418（第一段行程）、EASE_IN_DUR = 548（第二段）、N = 255/186（封面高宽比）。
 * 三态坐标（initial / docked / final）是原站写死的 8 组数组。
 */
const M = 418;
const N = 255 / 186;
const EASE_IN_DUR = 548;
const INTRO_POSTERS = 8;

interface CardState {
  initial: { x: number; y: number; width: number; height: number; rotate: number; opacity: number };
  docked: { x: number; y: number; width: number; height: number; rotate: number; opacity: number };
  final: { x: number; y: number; width: number; height: number; rotate: number; opacity: number };
  zIndex: number;
}

const CARD_STATES: CardState[] = [
  { initial: { x: 210, y: 830.52, width: 215.7, height: 385.47, rotate: -25, opacity: 1 }, docked: { x: -128, y: 439, width: 186, height: 333, rotate: 0, opacity: 0 }, final: { x: -137, y: -93, width: 186, height: 333, rotate: 0, opacity: 0 }, zIndex: 1 },
  { initial: { x: 260, y: 768.07, width: 206, height: 369.29, rotate: -19, opacity: 1 }, docked: { x: 82, y: 439, width: 186, height: 333, rotate: 0, opacity: 1 }, final: { x: 81, y: -93, width: 186, height: 333, rotate: 0, opacity: 1 }, zIndex: 4 },
  { initial: { x: 350, y: 683.41, width: 233, height: 417.53, rotate: -13, opacity: 1 }, docked: { x: 292, y: 439, width: 186, height: 333, rotate: 0, opacity: 1 }, final: { x: 299, y: -93, width: 186, height: 333, rotate: 0, opacity: 1 }, zIndex: 3 },
  { initial: { x: 514, y: 685.42, width: 252, height: 451.26, rotate: -9, opacity: 1 }, docked: { x: 502, y: 439, width: 186, height: 333, rotate: 0, opacity: 1 }, final: { x: 517, y: -93, width: 186, height: 333, rotate: 0, opacity: 1 }, zIndex: 5 },
  { initial: { x: 660.79, y: 700, width: 212, height: 379.68, rotate: 0.87, opacity: 1 }, docked: { x: 712, y: 439, width: 186, height: 333, rotate: 0, opacity: 1 }, final: { x: 735, y: -93, width: 186, height: 333, rotate: 0, opacity: 1 }, zIndex: 6 },
  { initial: { x: 835.81, y: 670, width: 246, height: 439.87, rotate: 9, opacity: 1 }, docked: { x: 922, y: 439, width: 186, height: 333, rotate: 0, opacity: 1 }, final: { x: 953, y: -93, width: 186, height: 333, rotate: 0, opacity: 1 }, zIndex: 7 },
  { initial: { x: 937.51, y: 820, width: 204, height: 365.16, rotate: 15, opacity: 1 }, docked: { x: 1132, y: 439, width: 186, height: 333, rotate: 0, opacity: 1 }, final: { x: 1171, y: -93, width: 186, height: 333, rotate: 0, opacity: 1 }, zIndex: 8 },
  { initial: { x: 1000, y: 800, width: 242, height: 433.61, rotate: 23, opacity: 1 }, docked: { x: 1342, y: 439, width: 186, height: 333, rotate: 0, opacity: 0 }, final: { x: 1389, y: -93, width: 186, height: 333, rotate: 0, opacity: 0 }, zIndex: 2 },
];

const clamp = (v: number, min = 0, max = 1) => Math.min(max, Math.max(min, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function lerpState(a: CardState['initial'], b: CardState['initial'], t: number) {
  return {
    x: lerp(a.x, b.x, t),
    y: lerp(a.y, b.y, t),
    width: lerp(a.width, b.width, t),
    height: lerp(a.height, b.height, t),
    rotate: lerp(a.rotate, b.rotate, t),
    opacity: lerp(a.opacity, b.opacity, t),
  };
}

/** 卡片数不等于 8 时，按比例在 8 态之间插值（原站同样逻辑）。 */
function buildStates(count: number): CardState[] {
  if (count === CARD_STATES.length) return CARD_STATES;
  const last = CARD_STATES.length - 1;
  const span = Math.max(1, count - 1);
  return Array.from({ length: count }, (_, i) => {
    const a = (i * last) / span;
    const lo = Math.floor(a);
    const hi = Math.min(last, Math.ceil(a));
    const f = a - lo;
    return {
      initial: lerpState(CARD_STATES[lo].initial, CARD_STATES[hi].initial, f),
      docked: lerpState(CARD_STATES[lo].docked, CARD_STATES[hi].docked, f),
      final: lerpState(CARD_STATES[lo].final, CARD_STATES[hi].final, f),
      zIndex: CARD_STATES[Math.round(a)].zIndex,
    };
  });
}

/** 一个剧集轨道（横向滚动 + 右箭头翻页）。只渲染轨道本身，标题由调用方给。 */
function Rail({ section }: { section: { key: string; name: string; videos: SeriesCard[] } }) {
  const railRef = useRef<HTMLDivElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // 卡片尺寸自适应（原站 I() 逻辑）
  useEffect(() => {
    const rail = railRef.current;
    const wrap = wrapRef.current;
    if (!rail || !wrap) return;
    const width = rail.clientWidth;
    const perView = width >= 1712 ? 8 : width >= 1494 ? 7 : 6;
    const cardW = Math.min(186, Math.max(176, (width - 24 * (perView - 1)) / perView));
    const coverH = (255 * cardW) / 186;
    wrap.style.setProperty('--pc-card-width', `${cardW}px`);
    wrap.style.setProperty('--pc-cover-height', `${coverH}px`);
    wrap.style.setProperty('--pc-view-all-width', `${(136 * coverH) / 255}px`);
    wrap.style.setProperty('--pc-card-height', `${coverH + 78}px`);
    wrap.style.setProperty('--pc-arrow-top', `${coverH / 2}px`);
  }, [section.videos.length]);

  return (
    <div className="rail-wrap" ref={wrapRef}>
      <div className="rail-mask rail-mask-right" />
      <button
        className="rail-arrow rail-arrow-right"
        type="button"
        aria-label="下一组"
        onClick={() => {
          const rail = railRef.current;
          if (!rail) return;
          const step = Math.max(320, Math.floor(rail.clientWidth * 0.86));
          const maxLeft = Math.max(0, rail.scrollWidth - rail.clientWidth);
          // 先判断「已在末尾」再夹取，否则单步超过剩余距离会被误判为到底而回到 0
          const next = rail.scrollLeft >= maxLeft - 4 ? 0 : Math.min(maxLeft, rail.scrollLeft + step);
          rail.scrollTo({ left: next, behavior: 'instant' });
        }}
      >
        <svg className="rail-arrow-icon" viewBox="0 0 56 72" fill="none" aria-hidden="true">
          <path d="M30 24.25L38 36L30 47.75" stroke="white" strokeWidth="2" />
        </svg>
      </button>

      <div className="card-rail" ref={railRef}>
        {section.videos.map((video) => (
          <Link className="card" key={video.id} to={`/detail/${video.id}`}>
            <div className="cover-wrap">
              <img className="cover" src={video.cover} alt={video.title} loading="lazy" />
              {video.episodeText && <span className="episode">{video.episodeText}</span>}
            </div>
            <p className="card-title">{video.title}</p>
            {video.tags.length > 0 && (
              <div className="card-tags">
                {video.tags.slice(0, 3).map((tag) => (
                  <span className="card-tag" key={tag}>
                    {tag}
                  </span>
                ))}
              </div>
            )}
          </Link>
        ))}
      </div>
    </div>
  );
}

/** 轨道标题（带右箭头）。 */
function SectionHead({ name, to }: { name: string; to: string }) {
  return (
    <div className="section-header">
      <Link className="section-title-link" to={to}>
        <h2 className="section-title">{name}</h2>
        <svg className="title-arrow" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path
            d="M4.33801 8.87409C4.09573 9.11769 4.09573 9.51124 4.33801 9.75485C4.58217 10.0003 4.97943 10.0003 5.22171 9.75485L9.30047 5.63264C9.78578 5.14233 9.78578 4.34661 9.30047 3.85629L5.22171 -0.265923C4.97943 -0.511466 4.58217 -0.511466 4.33801 -0.265923C4.09573 -0.0223157 4.09573 0.371236 4.33801 0.614843L8.13124 4.44844L4.33801 8.28203C4.09573 8.52564 4.09573 8.91919 4.33801 9.1628Z"
            transform="translate(0.5 1.5)"
            stroke="currentColor"
            strokeWidth="1.2"
            fill="none"
          />
        </svg>
      </Link>
    </div>
  );
}

export function HomePage() {
  const [home, setHome] = useState<HomeData | null>(null);
  const [extra, setExtra] = useState<SeriesCard[]>([]);
  const [error, setError] = useState('');
  const [mobileIndex, setMobileIndex] = useState(0);

  const bannerRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<HTMLDivElement | null>(null);
  const cardsRef = useRef<HTMLAnchorElement[]>([]);
  const revealed = useRef(false);

  // ---------------------------------------------------------------- 数据
  useEffect(() => {
    let alive = true;
    fetchHome()
      .then((data) => {
        if (alive) setHome(data);
      })
      .catch((problem) => {
        if (alive) setError(problem instanceof ApiError ? problem.message : '首页加载失败');
      });
    return () => {
      alive = false;
    };
  }, []);

  // 无限滚动：拿第 2 页起的数据追加到首个板块之后
  useEffect(() => {
    if (!home) return;
    let alive = true;
    fetchHomePage(2)
      .then((payload) => {
        if (alive) setExtra(toCards(payload.items));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [home]);

  useEffect(() => {
    document.title = '红果短剧_免费短剧全集无广告_好看的短剧尽在红果短剧官网';
  }, []);

  // ---------------------------------------------------------------- 入场动画
  useEffect(() => {
    if (!home) return;
    const reveal = () => {
      if (revealed.current) return;
      revealed.current = true;
      bannerRef.current?.classList.add('intro-ready');
      // 动画可能被节流停住，到时长后强制给终态
      window.setTimeout(() => bannerRef.current?.classList.add('intro-done'), 1400);
    };
    const raf = requestAnimationFrame(() => requestAnimationFrame(reveal));
    const timer = window.setTimeout(reveal, 300);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(timer);
    };
  }, [home]);

  // ---------------------------------------------------------------- 滚动插值
  useEffect(() => {
    if (!home) return;
    const banner = bannerRef.current;
    if (!banner) return;

    const update = () => {
      const w = window.pageYOffset || document.documentElement.scrollTop || 0;
      const G = clamp(w, 0, 966);
      const V = G <= M;
      const X = 1 - Math.pow(1 - clamp(G / M), 3);
      const J = clamp((G - M) / EASE_IN_DUR);

      const titleY = V ? lerp(187, 103, X) : lerp(103, -316, J);
      const scale = V ? lerp(0.79, 0.52, X) : lerp(0.52, 0.41, J);
      const titleOpacity = V ? 1 : lerp(1, 0.12, clamp(1.35 * J));
      const moreOpacity = V ? lerp(1, 0, clamp(1.4 * (X - 0.18))) : 0;
      const logoOpacity = V ? 1 - clamp(2.7 * X) : 0;
      const buttonY = V ? lerp(0, -24, X) : lerp(-24, -29.5, J);
      const bgOpacity = V ? lerp(0.08, 0.03, X) : 0.03;
      const maskOpacity = V ? 1 - clamp((G / M - 0.55) / (1 - 0.55)) : 0;
      // 下载按钮和标题一起淡出：它是绝对定位、top 跟着 --pc-title-y 走，
      // 滚动后 top 变成负值会把按钮顶到页头位置，遮住导航。
      const buttonOpacity = V ? 1 : lerp(1, 0, clamp(1.6 * J));

      banner.style.setProperty('--pc-title-y', `${titleY}px`);
      banner.style.setProperty('--pc-headline-scale', String(scale));
      banner.style.setProperty('--pc-title-opacity', String(titleOpacity));
      banner.style.setProperty('--pc-hero-logo-opacity', String(logoOpacity));
      banner.style.setProperty('--pc-button-follow-y', `${buttonY}px`);
      banner.style.setProperty('--pc-button-opacity', String(buttonOpacity));
      banner.style.setProperty('--pc-scroll-more-y', `${titleY + 190 + buttonY + 80}px`);
      banner.style.setProperty('--pc-more-opacity', String(moreOpacity));
      banner.style.setProperty('--pc-bg-motion-y', `${1.45 * (titleY - 187)}px`);
      banner.style.setProperty('--pc-hero-bg-opacity', String(bgOpacity));
      banner.style.setProperty('--pc-hero-mask-opacity', String(maskOpacity));
      banner.classList.toggle('background-motion-active', w < 966);

      const copyOpacity = V ? X : 1;
      const K = Math.max(0, w - 966);
      const states = buildStates(cardsRef.current.length);
      cardsRef.current.forEach((node, index) => {
        const st = states[index];
        if (!st) return;
        const from = V ? st.initial : st.docked;
        const to = V ? st.docked : st.final;
        const t = V ? X : J;
        const cur = lerpState(from, to, t);
        const fromY = V ? st.initial.y - 31 : st.docked.y;
        const toY = V ? st.docked.y : st.final.y;
        node.style.left = `${cur.x}px`;
        node.style.top = `${lerp(fromY, toY, t) - K}px`;
        node.style.width = `${cur.width}px`;
        node.style.height = `${cur.height}px`;
        node.style.opacity = String(cur.opacity);
        node.style.transform = Math.abs(cur.rotate) < 0.1 ? 'none' : `rotate(${cur.rotate}deg)`;
        const visible = w < M;
        node.style.visibility = visible ? 'visible' : 'hidden';
        node.style.pointerEvents = visible && cur.opacity > 0.08 ? 'auto' : 'none';
        node.style.setProperty('--pc-scatter-cover-height', `${cur.width * N}px`);
        node.style.setProperty('--pc-scatter-copy-opacity', String(copyOpacity));
      });

      const featured = document.querySelector<HTMLElement>('.featured-section');
      if (featured) {
        const on = w >= M;
        featured.style.opacity = on ? '1' : '0';
        featured.style.visibility = on ? 'visible' : 'hidden';
        featured.style.pointerEvents = on ? 'auto' : 'none';
      }
    };

    update();
    window.addEventListener('scroll', update, { passive: true });
    return () => window.removeEventListener('scroll', update);
  }, [home]);

  // ---------------------------------------------------------------- 移动端轮播
  const mobileBanners = home?.mobileBanners || [];
  useEffect(() => {
    if (mobileBanners.length < 2) return;
    const timer = window.setInterval(() => {
      setMobileIndex((index) => (index + 1) % mobileBanners.length);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [mobileBanners.length]);

  if (error) return <PageError message={error} onRetry={() => window.location.reload()} />;
  if (!home) return <PageLoading label="正在加载首页" />;

  const scatterVideos = home.sections[0].videos.slice(0, INTRO_POSTERS);
  const pool = home.sections.flatMap((section) => section.videos.map((video) => video.cover));
  const uniquePool = [...new Set(pool)].slice(0, 9);

  return (
    <>
      <div className="hero-banner" ref={bannerRef}>
        <div className="hero-container">
          <div className="hero-background" aria-hidden="true">
            {[1, 2, 3].map((row) => (
              <div className={`bg-strip bg-strip-${row}`} key={row}>
                <div className="bg-strip-inner">
                  {uniquePool.concat(uniquePool).map((src, index) => (
                    <img className="bg-tile" src={src} alt="" loading="lazy" key={`${row}-${index}`} />
                  ))}
                </div>
              </div>
            ))}
          </div>
          <img className="hero-gradient-mask" src={ASSETS.gradientMask} alt="" aria-hidden="true" />
          <img className="hero-shape-mask" src={ASSETS.shapeMask} alt="" aria-hidden="true" />

          <div className="hero-content">
            <img className="hero-logo" src={ASSETS.heroLogo} alt="红果短剧" />
            <img className="hero-slogan" src={ASSETS.heroSlogan} alt="海量短剧免费看全集" />
            <button className="hero-download" type="button">
              下载红果短剧App
            </button>
          </div>

          <div className="hero-scroll">
            <span className="hero-scroll-text">滑动查看更多短剧</span>
            <img className="hero-scroll-image" src={ASSETS.chevron} alt="" />
          </div>

          <div className="scatter-scene" ref={sceneRef}>
            {scatterVideos.map((video, index) => {
              const states = buildStates(scatterVideos.length);
              const st = states[index];
              if (!st) return null;
              return (
                <Link
                  className="scatter-card"
                  key={video.id}
                  to={`/detail/${video.id}`}
                  aria-label={`查看${video.title}`}
                  ref={(node) => {
                    if (node) cardsRef.current[index] = node;
                  }}
                  style={{
                    zIndex: st.zIndex,
                    left: st.initial.x,
                    top: st.initial.y,
                    width: st.initial.width,
                    height: st.initial.height,
                    ['--pc-scatter-cover-height' as string]: `${st.initial.width * N}px`,
                    ['--pc-scatter-copy-opacity' as string]: '0',
                    animationDelay: `${index * 40}ms`,
                  }}
                >
                  <div className="scatter-cover-wrap">
                    <picture className="scatter-cover">
                      <img src={video.cover} alt={video.title} loading={index === 0 ? 'eager' : 'lazy'} />
                    </picture>
                    {video.episodeText && <span className="scatter-episode">{video.episodeText}</span>}
                  </div>
                  <p className="scatter-card-title">{video.title}</p>
                  {video.tags.length > 0 && (
                    <div className="scatter-tags">
                      {video.tags.slice(0, 3).map((tag) => (
                        <span className="scatter-tag" key={tag}>
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                </Link>
              );
            })}
          </div>
        </div>
      </div>

      <div className="main-page">
        {home.sections.map((section, index) => {
          const moreLink =
            section.key === 'all'
              ? '/rank/hot-drama'
              : section.key === 'human'
                ? '/category/real-drama'
                : section.key === 'comic'
                  ? '/category/comic-drama'
                  : '/category/ai-drama';
          return (
            <section
              className={`section ${index === 0 ? 'featured-section' : 'following-section'}`}
              key={section.key}
            >
              <SectionHead name={section.name} to={moreLink} />
              <Rail section={section} />
            </section>
          );
        })}

        {extra.length > 0 && (
          <section className="section following-section" key="extra">
            <SectionHead name="更多推荐" to="/rank/hot-drama" />
            <Rail section={{ key: 'more', name: '更多推荐', videos: extra.slice(0, 9) }} />
          </section>
        )}
      </div>

      {/*
        移动端布局用 portal 挂到 body，和复刻站的结构一致：
        html.is-mobile 下 .pc-shell 是 display:none，如果把 mobile-shell
        嵌在 .pc-shell 里，父级 none 会让它的宽度算成 0（整屏空白）。
      */}
      {createPortal(
        <div className="mobile-shell">
          <header className="m-header-bar">
            <div className="m-header-inner">
            <Link className="m-brand" to="/">
              <img src={ASSETS.brandLogo} alt="红果短剧" />
            </Link>
            <div className="m-nav-links">
              <Link className="m-link m-link-active" to="/">
                首页
              </Link>
              <Link className="m-link" to="/category/real-drama">
                分类
              </Link>
              <Link className="m-link" to="/rank/hot-drama">
                榜单
              </Link>
            </div>
            <Link className="m-search-entry" to="/search" aria-label="搜索">
              <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <circle cx="7" cy="7" r="5.2" stroke="currentColor" strokeWidth="1.4" />
                <path d="M11 11l3.2 3.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
              </svg>
            </Link>
          </div>
        </header>

        <div className="m-banner">
          <div className="m-viewport">
            <div
              className="m-track"
              style={{ transform: `translate3d(${-mobileIndex * 100}%,0,0)` }}
            >
              {mobileBanners.map((banner, index) => (
                <Link className="m-card" to={banner.link} key={banner.id}>
                  <img
                    className="m-card-bg"
                    src={banner.bg}
                    alt={banner.name}
                    loading={index === 0 ? 'eager' : 'lazy'}
                  />
                  <div className="m-card-shade" />
                  <div className="m-card-copy">
                    {banner.tags.length > 0 && (
                      <div className="m-card-tags">
                        {banner.tags.slice(0, 3).map((tag) => (
                          <span className="m-card-tag" key={tag}>
                            <span className="m-card-tag-text">{tag}</span>
                          </span>
                        ))}
                      </div>
                    )}
                    <h2 className="m-card-title">{banner.name}</h2>
                    {banner.intro && <p className="m-card-intro">{banner.intro}</p>}
                  </div>
                </Link>
              ))}
            </div>
          </div>
          <div className="m-indicator-container">
            {mobileBanners.map((banner, index) => (
              <button
                key={banner.id}
                className={`m-indicator${index === mobileIndex ? ' m-indicator-active' : ''}`}
                type="button"
                aria-label={`第 ${index + 1} 张`}
                onClick={() => setMobileIndex(index)}
              >
                <span className="m-indicator-icon" />
              </button>
            ))}
          </div>
        </div>

        <div className="m-sections">
          {home.sections.map((section) => (
            <section className="m-section" key={section.key}>
              <div className="m-section-header">
                <Link className="m-title-link" to="/rank/hot-drama">
                  <h2 className="m-title">{section.name}</h2>
                  <svg className="m-title-arrow" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                    <path
                      d="M4.5 3l3 3-3 3"
                      stroke="currentColor"
                      strokeWidth="1.3"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </Link>
              </div>
              <div className="m-card-rail">
                {section.videos.map((video) => (
                  <Link className="m-rail-card" to={`/detail/${video.id}`} key={video.id}>
                    <div className="m-cover-wrap">
                      <img className="m-cover" src={video.cover} alt={video.title} loading="lazy" />
                      {video.episodeText && <span className="m-episode">{video.episodeText}</span>}
                    </div>
                    <p className="m-rail-card-title">{video.title}</p>
                    {video.tags.length > 0 && (
                      <div className="m-rail-card-tags">
                        {video.tags.slice(0, 3).map((tag) => (
                          <span className="m-rail-card-tag" key={tag}>
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}
                  </Link>
                ))}
              </div>
            </section>
          ))}
        </div>

        <div className="m-safe-info m-safe-info-home">
          <div className="m-safe-info-home-line">
            <span>红果免费短剧</span>
            <span className="m-safe-info-home-separator" />
            <span>{FOOTER_LINKS.companyName}</span>
            <span className="m-safe-info-home-separator" />
            <span>7.4.1.32</span>
            <span className="m-safe-info-home-separator" />
            <a href={FOOTER_LINKS.icpRecord.link} target="_blank" rel="noopener noreferrer">
              {FOOTER_LINKS.icpRecord.text}
            </a>
          </div>
        </div>

        <div className="m-guide">
          <button className="m-guide-btn" type="button">
            <svg className="m-guide-play" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <circle cx="8" cy="8" r="7.2" fill="#fff" />
              <path d="M6.4 5.2l4.2 2.8-4.2 2.8V5.2z" fill="#ff8a1f" />
            </svg>
            <span className="m-guide-text">前往「红果短剧」免费看全集</span>
          </button>
        </div>
      </div>,
        document.body
      )}
    </>
  );
}
