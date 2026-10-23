import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ApiError, fetchCategory, toCategoryRecord } from '../lib/api';
import type { CategoryRecord } from '../lib/types';
import { CATEGORY_LABELS, CATEGORY_TYPES } from '../lib/site';
import { Breadcrumb } from '../components/Layout';
import { PageError, PageLoading } from '../components/States';

export function CategoryPage() {
  const { type = 'real-drama', sub = '' } = useParams();
  const [params] = useSearchParams();
  const page = Math.max(1, Number(params.get('page') || 1) || 1);

  const [record, setRecord] = useState<CategoryRecord | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    const path = sub ? `/category/${type}/${sub}` : `/category/${type}`;
    fetchCategory(type, sub, page)
      .then((payload) => {
        if (alive) setRecord(toCategoryRecord(payload, path));
      })
      .catch((problem) => {
        if (alive) setError(problem instanceof ApiError ? problem.message : '分类加载失败');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [type, sub, page]);

  // 子分类页用标签名做标题
  const subName = record && sub ? (record.tags.find((tag) => tag.id === sub)?.name ?? sub) : '';
  const label = record?.label || CATEGORY_LABELS[type] || '';

  useEffect(() => {
    if (!record) return;
    document.title = subName
      ? `${subName}短剧_${label}分类 - 红果短剧官网`
      : record.seo.title || `${label}_红果短剧官网`;
  }, [record, subName, label]);

  if (loading) return <PageLoading />;
  if (error) return <PageError message={error} />;
  if (!record) return null;

  const { pagination } = record;

  return (
    <>
      <div className="page-cover">
        <div className="page-cover-img" />
      </div>

      <Breadcrumb
        items={
          sub
            ? [
                { text: '首页', to: '/' },
                { text: CATEGORY_LABELS[type] || label, to: `/category/${type}` },
                { text: subName || label },
              ]
            : [{ text: '首页', to: '/' }, { text: label }]
        }
      />

      <nav className="cat-nav">
        <div className="cat-types">
          {CATEGORY_TYPES.map((item) => (
            <Link
              key={item.type}
              className={`cat-type${item.type === type ? ' active' : ''}`}
              to={`/category/${item.type}`}
            >
              {item.label}
            </Link>
          ))}
        </div>
        <div className="cat-tags">
          <Link className={`cat-tag${sub ? '' : ' active'}`} to={`/category/${type}`}>
            全部
          </Link>
          {record.tags.map((tag) => (
            <Link
              key={tag.id}
              className={`cat-tag${sub === tag.id ? ' active' : ''}`}
              to={`/category/${type}/${tag.id}`}
            >
              {tag.name}
            </Link>
          ))}
        </div>
      </nav>

      <section className="cat-list-section">
        <div className="cat-page">
          <div className="cat-grid">
            {record.videos.map((video) => (
              <Link className="cat-card" key={video.id} to={`/detail/${video.id}`}>
                <div className="cat-card-cover-wrap">
                  <img
                    className="cat-card-cover"
                    src={video.cover}
                    alt={video.title}
                    loading="lazy"
                    decoding="async"
                  />
                  {video.episodeText && (
                    <span className="cat-card-episode">{video.episodeText}</span>
                  )}
                </div>
                <p className="cat-card-title">{video.title}</p>
                {video.tags.length > 0 && (
                  <div className="cat-card-tags">
                    {video.tags.slice(0, 3).map((tag) => (
                      <span className="cat-card-tag" key={tag}>
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
              </Link>
            ))}
          </div>
        </div>

        <Pagination
          basePath={sub ? `/category/${type}/${sub}` : `/category/${type}`}
          current={pagination.pageNum}
          totalPages={pagination.totalPages}
        />

        <p className="cat-count">共 {pagination.total || 0} 部</p>
      </section>
    </>
  );
}

/** 窗口式分页：首尾常显 + 当前页 ±2，折叠处可点。 */
export function Pagination({
  basePath,
  current,
  totalPages,
}: {
  basePath: string;
  current: number;
  totalPages: number;
}) {
  if (totalPages <= 1) return null;

  const href = (n: number) => (n > 1 ? `${basePath}?page=${n}` : basePath);
  const shown = new Set<number>();
  [1, totalPages, current - 2, current - 1, current, current + 1, current + 2].forEach((n) => {
    if (n >= 1 && n <= totalPages) shown.add(n);
  });
  const ordered = [...shown].sort((a, b) => a - b);

  return (
    <nav className="pagination" aria-label="分页">
      {current > 1 ? (
        <Link to={href(current - 1)}>上一页</Link>
      ) : (
        <span className="disabled">上一页</span>
      )}
      {ordered.map((n, index) => {
        const prev = ordered[index - 1];
        const gap = prev !== undefined && n - prev > 1;
        return (
          <span key={n} style={{ display: 'contents' }}>
            {gap && (
              <Link to={href(Math.min(totalPages, prev + 1))} aria-label={`第 ${prev + 1} 页`}>
                …
              </Link>
            )}
            {n === current ? (
              <span className="current">{n}</span>
            ) : (
              <Link to={href(n)}>{n}</Link>
            )}
          </span>
        );
      })}
      {current < totalPages ? (
        <Link to={href(current + 1)}>下一页</Link>
      ) : (
        <span className="disabled">下一页</span>
      )}
    </nav>
  );
}
