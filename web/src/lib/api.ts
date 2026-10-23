/**
 * 内容服务客户端。
 *
 * 所有内容数据都走 /api/*（Vite dev 代理到 127.0.0.1:8788，
 * 生产环境由同一个 Node 服务提供），不读任何本地数据文件。
 *
 * 服务端协议实现见 server/src/provider.mjs —— 签名、设备注册、
 * 播放地址解析都在那边完成，前端只消费 JSON。
 */

import type {
  ApiListPage,
  ApiPlayback,
  ApiRankPage,
  CategoryRecord,
  DetailRecord,
  HealthPayload,
  RankRecord,
  SeriesCard,
} from './types';

const TIMEOUT = 10000;

export class ApiError extends Error {
  status?: number;
  reason?: string;
  constructor(message: string, status?: number, reason?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.reason = reason;
  }
}

async function get<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T> {
  const qs = new URLSearchParams();
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    qs.set(key, String(value));
  });
  const url = `/api${path}${qs.toString() ? `?${qs}` : ''}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  try {
    const response = await fetch(url, { signal: controller.signal, cache: 'no-store' });
    const text = await response.text();
    let payload: unknown = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      throw new ApiError('服务返回了无法解析的内容', response.status);
    }
    if (!response.ok) {
      const body = payload as { error?: string; message?: string; reason?: string } | null;
      throw new ApiError(
        body?.error || body?.message || `请求失败（${response.status}）`,
        response.status,
        body?.reason
      );
    }
    return payload as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new ApiError('内容服务响应超时');
    }
    throw new ApiError(error instanceof Error ? error.message : '网络请求失败');
  } finally {
    clearTimeout(timer);
  }
}

let healthPromise: Promise<HealthPayload> | null = null;

/** 探测内容服务；失败清缓存，下次重试。 */
export function probeService(): Promise<HealthPayload> {
  if (healthPromise) return healthPromise;
  healthPromise = get<HealthPayload>('/health')
    .then((data) => {
      if (!data || data.service !== 'xiaoguoguo') throw new ApiError('不是内容服务');
      return data;
    })
    .catch((error) => {
      healthPromise = null;
      throw error;
    });
  return healthPromise;
}

/**
 * 实时接口的 tags 字段可能是数组、斜杠分隔串，也可能是整段简介
 * （搜索接口就是这样）。按长度过滤掉明显是正文的值。
 */
export function splitTags(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value.filter(Boolean);
  const text = String(value || '').trim();
  if (!text || text.length > 30) return [];
  return text
    .split('/')
    .map((item) => item.trim())
    .filter(Boolean);
}

function episodeCountOf(item: { episodes?: number; badge?: string }): number {
  const n = Number(item.episodes || 0);
  if (n) return n;
  const match = /(\d+)/.exec(String(item.badge || ''));
  return match ? Number(match[1]) : 0;
}

export function toCard(item: {
  id?: string;
  title?: string;
  cover?: string;
  description?: string;
  badge?: string;
  tags?: string | string[];
  episodes?: number;
}): SeriesCard {
  const count = episodeCountOf(item);
  return {
    id: String(item.id || ''),
    title: String(item.title || ''),
    cover: String(item.cover || ''),
    intro: String(item.description || ''),
    tags: splitTags(item.tags).slice(0, 3),
    episodes: count,
    episodeText: String(item.badge || (count ? `全${count}集` : '')),
  };
}

export function toCards(items: ApiListPage['items'] | undefined): SeriesCard[] {
  return (items || []).map(toCard).filter((item) => item.id && item.title);
}

/**
 * 大数字转「万 / 亿」：接口给的是原始数值（4373000），
 * 原站展示成「437.3万」。详情页的点赞/收藏要用这个。
 */
export function formatCount(value: string | number): string {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return String(value || '');
  if (n >= 100000000) return `${(n / 100000000).toFixed(1).replace(/\.0$/, '')}亿`;
  if (n >= 10000) return `${(n / 10000).toFixed(1).replace(/\.0$/, '')}万`;
  return String(n);
}

export function toDetailRecord(data: Record<string, unknown>): DetailRecord {
  const social = (data.social || {}) as Record<string, unknown>;
  const episodes = Array.isArray(data.episodes) ? (data.episodes as { id: string }[]) : [];
  const count = Number(data.episodeCount || episodes.length || 0);
  const celebs = Array.isArray(data.celebrities)
    ? (data.celebrities as { name?: string; avatar?: string; role?: string }[]).map((c) => ({
        name: String(c.name || ''),
        avatar: String(c.avatar || ''),
        role: String(c.role || ''),
      }))
    : [];
  const castLine = celebs
    .filter((c) => c.name)
    .slice(0, 6)
    .map((c) => (c.role ? `${c.name} ${c.role}` : c.name))
    .join('、');

  const reviews = Array.isArray(social.reviews)
    ? (social.reviews as Record<string, unknown>[]).map((r) => ({
        content: String(r.content || ''),
        user: String(r.user || ''),
        avatar: String(r.avatar || ''),
        stars: Number(r.stars || 0),
        digg: Number(r.digg || 0),
      }))
    : [];

  return {
    id: String(data.id || ''),
    title: String(data.title || ''),
    cover: String(data.cover || ''),
    intro: String(data.description || ''),
    tags: splitTags(data.tags as string | string[] | undefined),
    episodes: count,
    episodeText: String(data.badge || (count ? `全${count}集` : '')),
    accessible: Number(data.previewEpisodes || 0) || count,
    celebrities: celebs,
    vidList: episodes.map((ep) => String(ep.id)),
    rating: social.rating ? String(social.rating) : '',
    likeCount: String(social.likeCount || ''),
    favCount: String(social.favoriteCount || ''),
    ratingCount: String(social.ratingCount || ''),
    reviewTotal: Number(social.reviewTotal || 0),
    reviews,
    related: [],
    heroBg: String(data.cover || ''),
    hotText: String(social.hotText || ''),
    rankLabel: String(social.rankLabel || ''),
    castLine,
  };
}

export function toCategoryRecord(payload: ApiListPage, path: string): CategoryRecord {
  const videos = toCards(payload.items);
  return {
    path,
    contentType: payload.type || '',
    label: String(payload.label || ''),
    seo: payload.seo || {},
    tags: payload.tags || [],
    videos,
    pagination: {
      total: Number(payload.total || 0),
      pageNum: Number(payload.page || 1),
      pageSize: videos.length || 24,
      totalPages: Number(payload.totalPages || 1),
    },
  };
}

export function toRankRecord(payload: ApiRankPage, path: string): RankRecord {
  const items = (payload.items || []).map((item) => {
    const playHref = `/player/${item.id}`;
    const count = Number(item.episodes || 0);
    const epLinks = Array.from({ length: Math.min(count, 500) }, (_, index) => ({
      text: String(index + 1),
      href: `${playHref}?ep=${index + 1}`,
    }));
    return {
      rank: String(item.rank || ''),
      title: String(item.title || ''),
      cover: String(item.cover || ''),
      link: `/detail/${item.id}`,
      playHref,
      heat: String(item.heat || ''),
      rating: String(item.rating || ''),
      fav: String(item.fav || ''),
      like: String(item.like || ''),
      isNew: Boolean(item.isNew),
      tags: (item.tags || []).slice(0, 4),
      intro: String(item.intro || ''),
      episodes: count,
      epLinks,
    };
  });
  return {
    path,
    label: String(payload.label || ''),
    updated: String(payload.updated || ''),
    items,
    pagination: {
      pageNum: Number(payload.page || 1),
      totalPages: Number(payload.totalPages || 1),
    },
  };
}

// ---------------------------------------------------------------- 首页

export interface HomeData {
  sections: { key: string; name: string; videos: SeriesCard[] }[];
  banners: { id: string; name: string; link: string; bg: string; cover: string; intro: string; tags: string[] }[];
  mobileBanners: { id: string; name: string; link: string; bg: string; intro: string; tags: string[] }[];
}

/** 首页四个板块：热播 + 真人 + 漫剧 + AI。 */
export async function fetchHome(): Promise<HomeData> {
  const [home, human, comic, ai] = await Promise.all([
    get<ApiListPage>('/home', { page: 1 }),
    get<ApiListPage>('/category', { type: 'real-drama', page: 1 }),
    get<ApiListPage>('/category', { type: 'comic-drama', page: 1 }),
    get<ApiListPage>('/category', { type: 'ai-drama', page: 1 }),
  ]);

  const top = toCards(home.items);
  const sections = [
    { key: 'all', name: '热播短剧', videos: top.slice(0, 9) },
    { key: 'human', name: '热播真人剧', videos: toCards(human.items).slice(0, 9) },
    { key: 'comic', name: '热播漫剧', videos: toCards(comic.items).slice(0, 9) },
    { key: 'ai', name: '热播AI剧', videos: toCards(ai.items).slice(0, 9) },
  ].filter((section) => section.videos.length);

  if (!sections.length) throw new ApiError('首页没有内容');

  const toBanner = (item: SeriesCard) => ({
    id: item.id,
    name: item.title,
    link: `/detail/${item.id}`,
    bg: item.cover,
    cover: item.cover,
    intro: item.intro,
    tags: item.tags,
  });

  return {
    sections,
    banners: top.slice(0, 4).map(toBanner),
    mobileBanners: top.slice(0, 3).map(toBanner),
  };
}

// ---------------------------------------------------------------- 列表

export async function fetchCategory(type: string, sub: string, page: number) {
  return get<ApiListPage>('/category', { type, sub, page });
}

export async function fetchRank(key: string, page: number) {
  return get<ApiRankPage>('/rank', { key, page });
}

export async function fetchSearch(query: string, page: number) {
  return get<ApiListPage>('/search', { q: query, page });
}

export async function fetchHomePage(page: number) {
  return get<ApiListPage>('/home', { page });
}

// ---------------------------------------------------------------- 详情

export async function fetchDetail(id: string) {
  return get<Record<string, unknown>>(`/series/${id}`);
}

/** 详情页相关推荐：服务端详情不带 related，用首页条目补齐。 */
export async function fetchRelated(excludeId: string) {
  const home = await get<ApiListPage>('/home', { page: 1 });
  return toCards(home.items)
    .filter((item) => item.id !== excludeId)
    .slice(0, 6)
    .map((item) => ({ title: item.title, cover: item.cover, link: `/detail/${item.id}` }));
}

// ---------------------------------------------------------------- 播放

export async function fetchPlayback(episodeId: string) {
  return get<ApiPlayback>(`/episodes/${episodeId}/play`);
}

export function streamUrl(episodeId: string): string {
  return `/api/episodes/${episodeId}/stream`;
}
