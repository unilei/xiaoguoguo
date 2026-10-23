import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError, fetchDetail, fetchRelated, formatCount, toDetailRecord } from '../lib/api';
import type { DetailRecord, RelatedItem } from '../lib/types';
import { Breadcrumb } from '../components/Layout';
import { ReviewText } from '../components/ReviewText';
import { PageError, PageLoading } from '../components/States';

const COLLAPSED_EPISODES = 17;
const REVIEW_PAGE_SIZE = 4;

export function DetailPage() {
  const { id = '' } = useParams();
  const [detail, setDetail] = useState<DetailRecord | null>(null);
  const [related, setRelated] = useState<RelatedItem[]>([]);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [reviewPage, setReviewPage] = useState(0);

  useEffect(() => {
    let alive = true;
    setDetail(null);
    setError('');
    setExpanded(false);
    setReviewPage(0);
    fetchDetail(id)
      .then((payload) => {
        if (!alive) return;
        setDetail(toDetailRecord(payload));
        // 相关推荐单独取，失败不影响详情本身
        fetchRelated(id)
          .then((items) => {
            if (alive) setRelated(items);
          })
          .catch(() => undefined);
      })
      .catch((problem) => {
        if (alive) setError(problem instanceof ApiError ? problem.message : '详情加载失败');
      });
    return () => {
      alive = false;
    };
  }, [id]);

  useEffect(() => {
    if (detail) document.title = `${detail.title}_红果短剧官网`;
  }, [detail]);

  const episodes = useMemo(() => {
    if (!detail) return [];
    return Array.from({ length: detail.episodes }, (_, index) => index + 1);
  }, [detail]);

  if (error) return <PageError message={error} onRetry={() => window.location.reload()} />;
  if (!detail) return <PageLoading label="正在加载剧集" />;

  const shownEpisodes = expanded ? episodes : episodes.slice(0, COLLAPSED_EPISODES);
  const reviewStart = reviewPage * REVIEW_PAGE_SIZE;
  const shownReviews = detail.reviews.slice(reviewStart, reviewStart + REVIEW_PAGE_SIZE);
  const hasNextReview = reviewStart + REVIEW_PAGE_SIZE < detail.reviews.length;

  return (
    <>
      {/* 原站在 detail.html 的宿主元素上写死了 aspect-ratio:1920/1415，
          比 CSS 默认的 1920/920 高，让暗角渐变一直铺到热评区。
          只改 CSS 会波及别的页面，所以按原站做法写在行内。 */}
      <div
        className={`page-cover${detail.heroBg ? ' is-live-bg' : ''}`}
        style={{ aspectRatio: '1920 / 1415' }}
      >
        {detail.heroBg && <img className="page-cover-img" src={detail.heroBg} alt="" />}
      </div>

      <Breadcrumb items={[{ text: '首页', to: '/' }, { text: detail.title }]} />

      <div className="detail-page">
        <div className={`detail-hero${expanded ? ' is-episodes-expanded' : ''}`}>
          <div className="detail-hero-inner">
            <div className="detail-poster">
              <img src={detail.cover} alt={`${detail.title}封面`} />
            </div>
            <div className="detail-info">
              <div className="detail-title-row">
                <h1 className="detail-title">{detail.title}</h1>
                {/* .detail-heat 默认 display:none，原站由 JS 改成 inline-flex 才显示 */}
                {detail.hotText && (
                  <span className="detail-heat" style={{ display: 'inline-flex' }}>
                    {detail.hotText}
                  </span>
                )}
              </div>

              <div className="detail-meta">
                {detail.rating && <span className="detail-chip rating">评分{detail.rating}</span>}
                {detail.likeCount && (
                  <span className="detail-chip">{formatCount(detail.likeCount)}点赞</span>
                )}
                {detail.favCount && (
                  <span className="detail-chip">{formatCount(detail.favCount)}收藏</span>
                )}
                {detail.tags.map((tag) => (
                  <span className="detail-chip tag" key={tag}>
                    {tag}
                  </span>
                ))}
              </div>

              {detail.castLine && (
                <p className="detail-cast" style={{ display: 'block' }}>
                  <span className="detail-cast-label">演员：</span>
                  {detail.castLine}
                </p>
              )}

              <p className="detail-intro">
                <span className="detail-intro-label">简介：</span>
                {detail.intro}
              </p>

              <div className="detail-actions">
                <Link className="detail-btn-play" to={`/player/${detail.id}`}>
                  播放正片
                </Link>
                <button
                  className="detail-btn-download"
                  type="button"
                  onClick={() => window.dispatchEvent(new CustomEvent('hg:open-auth'))}
                >
                  下载「红果短剧」免费看全集
                </button>
              </div>
            </div>
          </div>

          <div className="detail-episodes">
            {shownEpisodes.map((n) => (
              <Link
                className="detail-ep"
                key={n}
                to={`/player/${detail.id}?ep=${n}`}
                aria-label={`播放第${n}集`}
              >
                {n}
              </Link>
            ))}
            {episodes.length > COLLAPSED_EPISODES && (
              <button
                className="detail-ep more"
                type="button"
                aria-label={expanded ? '收起剧集' : '展开全部剧集'}
                aria-expanded={expanded}
                onClick={() => setExpanded((prev) => !prev)}
              >
                {expanded ? '⌃' : '⌄'}
              </button>
            )}
          </div>
        </div>

        {detail.reviews.length > 0 && (
          <section className="detail-reviews">
            <div className="detail-section-header">
              <h2 className="detail-section-title">
                热评 · <small>{detail.reviewTotal || detail.reviews.length}</small>
              </h2>
              <button
                className="detail-section-more"
                type="button"
                onClick={() => setReviewPage((prev) => (hasNextReview ? prev + 1 : 0))}
              >
                {hasNextReview ? '查看更多 ›' : '回到最前 ›'}
              </button>
            </div>
            <div className="detail-review-body">
              {shownReviews.map((review, index) => (
                <article
                  className="detail-review-card"
                  key={`${review.user}-${reviewStart + index}`}
                >
                  <ReviewText text={review.content} />
                  <div className="detail-review-foot">
                    {review.avatar && (
                      <img
                        className="detail-review-avatar"
                        src={review.avatar}
                        alt=""
                        loading="lazy"
                      />
                    )}
                    <span>{review.user || '匿名用户'}</span>
                    <span className="detail-review-stars">{'★'.repeat(review.stars)}</span>
                    <span className="detail-review-digg">♡ {review.digg}</span>
                  </div>
                </article>
              ))}
            </div>
          </section>
        )}

        {related.length > 0 && (
          <section className="detail-related">
            <div className="detail-related-inner">
              <div className="detail-section-header">
                <h2 className="detail-section-title">相关短剧</h2>
              </div>
              <div className="detail-related-grid">
                {related.map((item) => (
                  <Link className="detail-related-card" key={item.link} to={item.link}>
                    <div className="detail-related-cover-wrap">
                      <img
                        className="detail-related-cover"
                        src={item.cover}
                        alt={item.title}
                        decoding="sync"
                      />
                    </div>
                    <p className="detail-related-title">{item.title}</p>
                  </Link>
                ))}
              </div>
            </div>
          </section>
        )}
      </div>
    </>
  );
}
