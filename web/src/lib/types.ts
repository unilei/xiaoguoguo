/**
 * 复刻站的数据契约。
 *
 * 页面只认这些形态；「内容」全部来自内容服务 API，
 * 品牌素材（logo / slogan / 页脚备案）是站点资源，来自本地常量。
 */

export interface SeriesCard {
  id: string;
  title: string;
  cover: string;
  intro: string;
  tags: string[];
  episodes: number;
  episodeText: string;
}

export interface CategoryTag {
  id: string;
  name: string;
  ids?: string[];
}

export interface Pagination {
  total?: number;
  pageNum: number;
  pageSize?: number;
  totalPages: number;
}

export interface CategoryRecord {
  path: string;
  contentType: string;
  label: string;
  seo: { title?: string; description?: string; h1?: string };
  tags: CategoryTag[];
  videos: SeriesCard[];
  pagination: Pagination;
}

export interface RankEpLink {
  text: string;
  href: string;
}

export interface RankItem {
  rank: string;
  title: string;
  cover: string;
  link: string;
  playHref: string;
  heat: string;
  rating: string;
  fav: string;
  like: string;
  isNew: boolean;
  tags: string[];
  intro: string;
  episodes: number;
  epLinks: RankEpLink[];
}

export interface RankRecord {
  path: string;
  label: string;
  updated: string;
  items: RankItem[];
  pagination: Pagination;
}

export interface Celebrity {
  name: string;
  avatar: string;
  role: string;
}

export interface Review {
  content: string;
  user: string;
  avatar: string;
  stars: number;
  digg: number;
}

export interface RelatedItem {
  title: string;
  cover: string;
  link: string;
}

export interface DetailRecord {
  id: string;
  title: string;
  cover: string;
  intro: string;
  tags: string[];
  episodes: number;
  episodeText: string;
  accessible: number;
  celebrities: Celebrity[];
  vidList: string[];
  rating: string;
  likeCount: string;
  favCount: string;
  ratingCount: string;
  reviewTotal: number;
  reviews: Review[];
  related: RelatedItem[];
  heroBg: string;
  hotText: string;
  rankLabel?: string;
  castLine: string;
}

export interface HomeSection {
  key: string;
  name: string;
  videos: SeriesCard[];
}

/** 内容服务 /api/home、/api/category、/api/search 的条目 */
export interface ApiSeries {
  id: string;
  title: string;
  cover: string;
  description?: string;
  badge?: string;
  tags?: string | string[];
  episodes?: number;
}

export interface ApiListPage {
  items: ApiSeries[];
  page: number;
  total?: number;
  totalPages?: number;
  hasMore?: boolean;
  label?: string;
  type?: string;
  seo?: CategoryRecord['seo'];
  tags?: CategoryTag[];
}

export interface ApiRankItem {
  id: string;
  rank: number | string;
  title: string;
  cover: string;
  heat: string;
  rating: string;
  fav: string;
  like: string;
  isNew: boolean;
  tags: string[];
  intro: string;
  episodes: number;
  openEpisodes?: number;
}

export interface ApiRankPage {
  key: string;
  label?: string;
  items: ApiRankItem[];
  page: number;
  totalPages: number;
  updated?: string;
}

export interface ApiPlayback {
  path: string;
  quality: string;
  kind: 'public' | 'account';
}

export interface HealthPayload {
  service: string;
  account: 'configured' | 'anonymous';
  runtime?: string;
  expiry?: { known: boolean; expiresText?: string; remainingDays?: number };
}
