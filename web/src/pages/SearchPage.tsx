import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ApiError, fetchSearch, toCards } from '../lib/api';
import type { SeriesCard } from '../lib/types';
import { ASSETS } from '../lib/site';
import { Breadcrumb } from '../components/Layout';
import { PageError, PageLoading } from '../components/States';

export function SearchPage() {
  const [params] = useSearchParams();
  const query = (params.get('q') || '').trim();

  const [items, setItems] = useState<SeriesCard[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!query) {
      setItems([]);
      setError('');
      return;
    }
    let alive = true;
    setLoading(true);
    setError('');
    fetchSearch(query, 1)
      .then((payload) => {
        // 服务端已按关键词检索（能命中简介与演员），不再本地二次过滤，
        // 否则会把标题里没有关键词但语义相关的结果全删掉。
        if (alive) setItems(toCards(payload.items));
      })
      .catch((problem) => {
        if (alive) setError(problem instanceof ApiError ? problem.message : '搜索失败');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [query]);

  useEffect(() => {
    document.title = query ? `${query} - 搜索_红果短剧官网` : '搜索_红果短剧官网';
  }, [query]);

  return (
    <>
      <div className="page-cover">
        <div className="page-cover-img" />
      </div>

      <Breadcrumb items={[{ text: '首页', to: '/' }, { text: '搜索' }]} />

      <div className="search-page">
        <h1 className="search-heading">搜索 {query && <span>“{query}”</span>}</h1>
        <p className="search-sub">
          {!query
            ? '输入关键词开始搜索'
            : loading
              ? '正在搜索…'
              : `找到 ${items.length} 部相关短剧`}
        </p>

        <div className="cat-page" style={{ marginTop: 8 }}>
          {!query && (
            <div className="search-empty">
              <img className="search-empty-icon" src={ASSETS.emptyPlay} alt="" />
              <p>试试搜索「逆袭」「穿越」「都市」</p>
            </div>
          )}

          {query && loading && <PageLoading label="正在搜索" />}

          {query && !loading && error && (
            <PageError message={error} onRetry={() => window.location.reload()} />
          )}

          {query && !loading && !error && items.length === 0 && (
            <div className="search-empty">
              <img className="search-empty-icon" src={ASSETS.emptyPlay} alt="" />
              <p>没有找到与「{query}」相关的短剧</p>
            </div>
          )}

          {query && !loading && items.length > 0 && (
            <div className="cat-grid">
              {items.map((item) => (
                <Link className="cat-card" key={item.id} to={`/detail/${item.id}`}>
                  <div className="cat-card-cover-wrap">
                    <img
                      className="cat-card-cover"
                      src={item.cover}
                      alt={item.title}
                      loading="lazy"
                      decoding="async"
                    />
                    {item.episodeText && (
                      <span className="cat-card-episode">{item.episodeText}</span>
                    )}
                  </div>
                  <p className="cat-card-title">{item.title}</p>
                  {item.tags.length > 0 && (
                    <div className="cat-card-tags">
                      {item.tags.slice(0, 3).map((tag) => (
                        <span className="cat-card-tag" key={tag}>
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
