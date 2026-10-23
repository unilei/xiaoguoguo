import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ApiError, fetchRank, toRankRecord } from '../lib/api';
import type { RankItem, RankRecord } from '../lib/types';
import { RANK_LABELS, RANK_TABS } from '../lib/site';
import { Breadcrumb } from '../components/Layout';
import { PageError, PageLoading } from '../components/States';
import { Pagination } from './CategoryPage';

/** 前三名用金/银/铜渐变，其余深灰。 */
function badgeSvg(rank: number) {
  const grads: Record<number, [string, string]> = {
    1: ['#FFD25F', '#F3970B'],
    2: ['#E8E8E8', '#A8A8A8'],
    3: ['#F0B27A', '#C0703A'],
  };
  const [from, to] = grads[rank] || ['#4A4A4A', '#333333'];
  const id = `badge-g-${rank}`;
  return (
    <svg viewBox="0 0 28 28" aria-hidden="true">
      <path fill={`url(#${id})`} d="M0 8a8 8 0 0 1 8-8h20l-1.8 17.2A8 8 0 0 1 18.2 24H0z" />
      <defs>
        <linearGradient id={id} x1="14" x2="11" y1="0" y2="24" gradientUnits="userSpaceOnUse">
          <stop stopColor={from} />
          <stop offset="1" stopColor={to} />
        </linearGradient>
      </defs>
    </svg>
  );
}

/** 一条榜单的选集行：播放正片 + 前 24 集（或全部）+ 展开。 */
function EpisodeRow({
  item,
  expanded,
  onToggle,
}: {
  item: RankItem;
  expanded: boolean;
  onToggle: () => void;
}) {
  const shown = expanded ? item.epLinks : item.epLinks.slice(0, 24);
  const hasMore = item.epLinks.length > 24;
  return (
    <div className="rank-eps">
      <Link className="rank-ep play" to={item.playHref}>
        播放正片
      </Link>
      {shown.map((ep) => (
        <Link className="rank-ep" key={ep.href} to={ep.href}>
          {ep.text}
        </Link>
      ))}
      {hasMore && (
        <button
          className="rank-ep more"
          type="button"
          aria-label={expanded ? '收起剧集' : '展开全部剧集'}
          aria-expanded={expanded}
          onClick={onToggle}
        >
          {expanded ? '⌃' : '⌄'}
        </button>
      )}
    </div>
  );
}

export function RankPage() {
  const { key = 'hot-drama' } = useParams();
  const [params] = useSearchParams();
  const page = Math.max(1, Number(params.get('page') || 1) || 1);

  const [record, setRecord] = useState<RankRecord | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    setExpanded({});
    fetchRank(key, page)
      .then((payload) => {
        if (!alive) return;
        const next = toRankRecord({ ...payload, label: RANK_LABELS[key] || payload.label }, `/rank/${key}`);
        setRecord(next);
      })
      .catch((problem) => {
        if (alive) setError(problem instanceof ApiError ? problem.message : '榜单加载失败');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [key, page]);

  const label = record?.label || RANK_LABELS[key] || '热播榜';

  useEffect(() => {
    document.title = `${label}_红果短剧官网`;
  }, [label]);

  if (loading) return <PageLoading />;
  if (error) return <PageError message={error} />;
  if (!record) return null;

  return (
    <>
      <section className="rank-hero">
        {/* 榜单 hero 背景是纯色渐变，原站图需要单独下载；
            用 CSS 背景而不是空 <img>，避免出现破图请求。 */}
        <div className="rank-hero-img" aria-hidden="true" />
        <div className="rank-hero-content">
          <div className="rank-hero-title">
            <svg viewBox="0 0 14 31" fill="none" aria-hidden="true">
              <path
                d="M11 3c-4 6-6 12-6 12.5S7 22 11 28"
                stroke="#fff"
                strokeWidth="2.4"
                strokeLinecap="round"
              />
            </svg>
            <h1>{label}</h1>
            <svg className="right" viewBox="0 0 14 31" fill="none" aria-hidden="true">
              <path
                d="M11 3c-4 6-6 12-6 12.5S7 22 11 28"
                stroke="#fff"
                strokeWidth="2.4"
                strokeLinecap="round"
              />
            </svg>
          </div>
          <p className="rank-hero-desc">{record.updated}</p>
        </div>
      </section>

      <Breadcrumb items={[{ text: '首页', to: '/' }, { text: label }]} />

      <main className="rank-main">
        <nav className="rank-tabs">
          {RANK_TABS.map((tab) => (
            <Link
              key={tab.key}
              className={`rank-tab${tab.key === key ? ' active' : ''}`}
              to={`/rank/${tab.key}`}
            >
              {tab.label}
            </Link>
          ))}
        </nav>

        <ol className="rank-list">
          {record.items.map((item, index) => {
            const rankNo = Number.parseInt(item.rank, 10) || 0;
            return (
              <li className="rank-item" key={item.playHref}>
                <Link className="rank-cover-link" to={item.link} aria-label={`查看${item.title}`}>
                  <img
                    className="rank-cover"
                    src={item.cover}
                    alt={`${item.title}封面`}
                    loading="lazy"
                    decoding="async"
                  />
                  <span className="rank-badge">
                    {badgeSvg(rankNo)}
                    <span>{item.rank}</span>
                  </span>
                </Link>
                <div className="rank-content">
                  <div className="rank-title-row">
                    <h2 className="rank-title">{item.title}</h2>
                    {item.heat && <span className="rank-heat">{item.heat}</span>}
                  </div>
                  <div className="rank-meta">
                    {item.isNew && <span className="rank-chip new">新剧</span>}
                    {item.rating && <span className="rank-chip rating">评分{item.rating}</span>}
                    {item.fav && <span className="rank-chip">{item.fav}</span>}
                    {item.like && <span className="rank-chip">{item.like}</span>}
                  </div>
                  {item.tags.length > 0 && (
                    <div className="rank-tags">
                      {item.tags.slice(0, 4).map((tag) => (
                        <span className="rank-tag" key={tag}>
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                  {item.intro && <p className="rank-intro">{item.intro}</p>}
                  <EpisodeRow
                    item={item}
                    expanded={Boolean(expanded[index])}
                    onToggle={() =>
                      setExpanded((prev) => ({ ...prev, [index]: !prev[index] }))
                    }
                  />
                </div>
              </li>
            );
          })}
        </ol>

        <Pagination
          basePath={`/rank/${key}`}
          current={record.pagination.pageNum}
          totalPages={record.pagination.totalPages}
        />
      </main>
    </>
  );
}
