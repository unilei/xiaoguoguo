// Cloudflare Worker 版内容接入层。
//
// 与 server/src/provider.mjs 同一套逻辑，差异只在两处平台限制：
//   1. 没有进程内存态 → 缓存放 KV（边缘节点不共享内存）
//   2. 单请求子请求上限 50 → 分类聚合不实时抓全部子分类，
//      而是把「虚拟长表」的分段信息缓存到 KV，按页只补抓缺的那几页。
//
// 分类数据量说明：源站官网 SSR 每个路由只给 800 条（24 × 34 页），
// 但每个子分类有独立配额，把 24 个子分类首尾相接可得约 1.1 万部。
import {
  SITE,
  VIDEO_UA,
  categoryPage,
  categoryData,
  rankData,
  routerData,
  itemToCard,
  appSearchCells,
  appSearchVod,
  cleanUrl,
  getText,
} from "./vendor-worker.js";

const CACHE_TTL = 180; // 秒
const SEGMENT_TTL = 3600; // 分类分段信息缓存 1 小时
const PAGE_SIZE = 24;

const CATEGORY_LABELS = {
  "real-drama": "真人剧",
  "comic-drama": "漫剧",
  "ai-drama": "AI剧",
  comic: "漫画",
};

const RANK_ROUTES = new Set([
  "hot-drama",
  "hot-real-drama",
  "hot-ai-drama",
  "hot-comic-drama",
]);

const toSeries = (row) => {
  const card = itemToCard(row);
  return {
    id: String(card.url || ""),
    title: String(card.title || ""),
    cover: card.img || "",
    description: card.content || "",
    badge: card.desc || "",
    tags: card.tname || "",
  };
};

const validSeries = (rows) =>
  rows.filter((item) => /^\d{1,30}$/.test(item.id) && item.title);

// ---------------------------------------------------------------- 缓存

/** KV 读写失败不能影响主流程：拿不到就当没有缓存。 */
async function cacheGet(env, key) {
  if (!env?.XGG_KV) return null;
  try {
    const raw = await env.XGG_KV.get(key, { type: "json" });
    if (!raw || Date.now() - (raw.at || 0) > (raw.ttl || CACHE_TTL) * 1000) return null;
    return raw.value;
  } catch {
    return null;
  }
}

async function cacheSet(env, key, value, ttl = CACHE_TTL) {
  if (!env?.XGG_KV) return;
  try {
    await env.XGG_KV.put(key, JSON.stringify({ at: Date.now(), ttl, value }));
  } catch {
    // 配额或网络问题，忽略。
  }
}

// ---------------------------------------------------------------- 首页

export async function home(env, page = 1) {
  const key = `home:${page}`;
  const cached = await cacheGet(env, key);
  if (cached) return cached;

  const data = await categoryPage("tab=1&sort_type=1", page);
  const pageData =
    data?.loaderData?.category_page ||
    data?.loaderData?.["category_$"] ||
    data?.loaderData?.category_layout;
  const rows = pageData?.recommendList || pageData?.categoryData?.recommendList;
  if (!Array.isArray(rows)) throw new Error("首页数据结构已变化");

  const value = {
    items: validSeries(rows.map(toSeries)),
    page,
    totalPages: Number(pageData?.pagination?.totalPages || 1),
  };
  await cacheSet(env, key, value);
  return value;
}

// ---------------------------------------------------------------- 分类

/** 抓一页分类数据（不缓存，供 category 与聚合共用）。 */
async function fetchCategoryPage(type, sub, page) {
  const base = sub
    ? `${SITE}/category/${type}/${encodeURIComponent(sub)}`
    : `${SITE}/category/${type}`;
  const data = await routerData(page > 1 ? `${base}?page=${page}` : base);
  const pageData = data?.loaderData?.["category_$"];
  const rows = pageData?.recommendList;
  if (!Array.isArray(rows)) throw new Error("分类数据结构已变化");

  const selector = pageData?.selectorList?.[0];
  const pagination = pageData?.pagination || {};
  return {
    label: String(pageData?.categoryRoute?.displayName || ""),
    seo: pageData?.seo || {},
    tags: Array.isArray(selector?.items)
      ? selector.items.map((item) => ({
          id: String(item.selector_item_id || ""),
          name: String(item.show_name || ""),
        }))
      : [],
    items: validSeries(rows.map(toSeries)),
    total: Number(pagination.total || 0),
    totalPages: Number(pagination.totalPages || 1),
  };
}

/**
 * 取「虚拟长表」的分段信息：各大类 + 各子分类的 total 首尾相接。
 * 这个表只依赖各子分类的 total（每个抓 1 页就能拿到），
 * 缓存 1 小时，避免每个请求都重新探测。
 */
async function segments(env, type, first) {
  const key = `segments:${type}`;
  const cached = await cacheGet(env, key);
  if (cached) return cached;

  const list = [{ sub: "", count: first.total, pages: first.totalPages, offset: 0 }];
  let offset = first.total;

  // Workers 单请求最多 50 个子请求，这里探测 24 个子分类要留余量，
  // 所以分小批抓；失败就跳过该子分类（少一点数据，不影响主流程）。
  for (let i = 0; i < first.tags.length; i += 6) {
    const batch = first.tags.slice(i, i + 6);
    const results = await Promise.all(
      batch.map((tag) =>
        fetchCategoryPage(type, tag.id, 1).then(
          (r) => ({ id: tag.id, total: r.total, pages: r.totalPages }),
          () => null
        )
      )
    );
    for (const r of results) {
      if (!r || !r.total) continue;
      list.push({ sub: r.id, count: r.total, pages: r.pages, offset });
      offset += r.total;
    }
  }

  const value = { segments: list, total: offset, tags: first.tags, label: first.label, seo: first.seo };
  await cacheSet(env, key, value, SEGMENT_TTL);
  return value;
}

/** 取虚拟长表 [start, start+size) 这一段：只抓跨越的子分类页。 */
async function fetchSegment(type, seg, start, size) {
  const need = start + size;
  const jobs = [];
  for (const item of seg.segments) {
    const segEnd = item.offset + item.count;
    if (segEnd <= start) continue;
    if (item.offset >= need) break;
    const localFrom = Math.max(0, start - item.offset);
    const localTo = Math.min(item.count, need - item.offset);
    const pageFrom = Math.floor(localFrom / PAGE_SIZE) + 1;
    const pageTo = Math.ceil(localTo / PAGE_SIZE);
    for (let p = pageFrom; p <= pageTo; p += 1) jobs.push({ sub: item.sub, page: p });
  }

  // 一页最多跨 2 个子分类，请求数很小
  const fetched = new Map();
  await Promise.all(
    jobs.map(async (job) => {
      try {
        const r = await fetchCategoryPage(type, job.sub, job.page);
        fetched.set(`${job.sub}:${job.page}`, r.items);
      } catch {
        // 单页失败就跳过，前端少几张卡片但不报错。
      }
    })
  );

  const out = [];
  const seen = new Set();
  for (const item of seg.segments) {
    const segEnd = item.offset + item.count;
    if (segEnd <= start) continue;
    if (item.offset >= need) break;
    const localFrom = Math.max(0, start - item.offset);
    const localTo = Math.min(item.count, need - item.offset);
    const pageFrom = Math.floor(localFrom / PAGE_SIZE) + 1;
    const pageTo = Math.ceil(localTo / PAGE_SIZE);
    for (let p = pageFrom; p <= pageTo; p += 1) {
      const items = fetched.get(`${item.sub}:${p}`);
      if (!items) continue;
      const base = (p - 1) * PAGE_SIZE;
      for (let idx = 0; idx < items.length; idx += 1) {
        const pos = item.offset + base + idx;
        if (pos < start || pos >= need) continue;
        if (seen.has(items[idx].id)) continue;
        seen.add(items[idx].id);
        out.push(items[idx]);
      }
    }
  }
  return out.slice(0, size);
}

export async function category(env, type, sub = "", page = 1) {
  const label = CATEGORY_LABELS[type];
  if (!label) throw new Error("不支持的分类");

  const key = `category:${type}:${sub}:${page}`;
  const cached = await cacheGet(env, key);
  if (cached) return cached;

  // 子分类是独立筛选视图，直接用源站那一页
  if (sub) {
    const single = await fetchCategoryPage(type, sub, page);
    const value = {
      type,
      label: single.label || label,
      seo: single.seo,
      tags: single.tags,
      items: single.items,
      page,
      total: single.total,
      totalPages: single.totalPages,
    };
    await cacheSet(env, key, value);
    return value;
  }

  const first = await fetchCategoryPage(type, "", 1);
  const size = first.items.length || PAGE_SIZE;
  const seg = await segments(env, type, first);
  const totalPages = Math.max(1, Math.ceil(seg.total / size));

  // 源站能直接给的页：单抓一次更省
  if (page <= first.totalPages) {
    const single = page === 1 ? first : await fetchCategoryPage(type, "", page);
    const value = {
      type,
      label: single.label || label,
      seo: single.seo,
      tags: single.tags,
      items: single.items,
      page,
      total: seg.total,
      totalPages,
      aggregated: true,
      sourceTotal: first.total,
    };
    await cacheSet(env, key, value);
    return value;
  }

  // 超出源站的页：按虚拟长表定位，只抓这一段
  const items = await fetchSegment(type, seg, (page - 1) * size, size);
  const value = {
    type,
    label: seg.label || label,
    seo: seg.seo,
    tags: seg.tags,
    items,
    page,
    total: seg.total,
    totalPages,
    aggregated: true,
    sourceTotal: first.total,
  };
  await cacheSet(env, key, value);
  return value;
}

// ---------------------------------------------------------------- 榜单

export async function rank(env, route = "hot-drama", page = 1) {
  if (!RANK_ROUTES.has(route)) throw new Error("不支持的榜单");
  const key = `rank:${route}:${page}`;
  const cached = await cacheGet(env, key);
  if (cached) return cached;

  const suffix = page > 1 ? `?page=${page}` : "";
  const html = await getText(`${SITE}/rank/${route}${suffix}`);

  let payload = null;
  try {
    payload = rankData(html);
  } catch {
    // AI 剧榜是客户端二次取数，SSR 只有空壳，下面用分类兜底。
  }

  if (!payload) {
    const fallback = await category(env, "ai-drama", "", page);
    const items = fallback.items.map((item, index) => ({
      id: item.id,
      rank: (page - 1) * 24 + index + 1,
      title: item.title,
      cover: item.cover,
      heat: "",
      rating: "",
      fav: "",
      like: "",
      isNew: false,
      tags: String(item.tags || "").split("/").filter(Boolean).slice(0, 4),
      intro: item.description,
      episodes: 0,
    }));
    const value = {
      key: route,
      route,
      items,
      page,
      totalPages: fallback.totalPages,
      updated: "",
      fallback: "category",
    };
    await cacheSet(env, key, value);
    return value;
  }

  const pagination = payload.pagination || {};
  const items = payload.rankList.map((item) => ({
    id: String(item.seriesId || item.series_id || item.id || ""),
    rank: Number(item.rank || 0),
    title: String(item.title || ""),
    cover: cleanUrl(item.cover) || "",
    heat: String(item.heatText || ""),
    rating: String(item.scoreText || "").replace(/^评分/, ""),
    fav: String(item.favoriteText || ""),
    like: String(item.likeText || ""),
    isNew: (item.statusTags || []).includes("新剧"),
    tags: Array.isArray(item.tags) ? item.tags.slice(0, 4) : [],
    intro: String(item.description || ""),
    episodes: Number(item.episodeCount || 0) ||
      (Array.isArray(item.episodeVids) ? item.episodeVids.length : 0),
    openEpisodes: Number(item.openEpisodeCount || 0) ||
      (Array.isArray(item.episodeVids) ? item.episodeVids.length : 0),
  }));

  const updatedMatch = /"updatedText"\s*:\s*"([^"]*)"/.exec(html);
  const value = {
    key: route,
    route,
    items: items.filter((item) => /^\d{1,30}$/.test(item.id) && item.title),
    page,
    totalPages: Number(pagination.totalPages || 1),
    updated: updatedMatch ? updatedMatch[1].replace(/\\u002F/g, "/") : "",
  };
  await cacheSet(env, key, value);
  return value;
}

// ---------------------------------------------------------------- 详情

export async function detail(env, id) {
  if (!/^\d{1,30}$/.test(String(id))) throw new Error("剧集 ID 无效");
  const key = `detail:${id}`;
  const cached = await cacheGet(env, key);
  if (cached) return cached;

  const data = await routerData(`${SITE}/detail?series_id=${id}`);
  const page = data?.loaderData?.detail_page;
  const series = page?.seriesDetail;
  if (!series || !Array.isArray(series.vid_list) || !series.vid_list.length)
    throw new Error("剧集不存在或分集暂不可用");

  // 评分 / 点赞 / 评论在 seriesSocialInfo 里；榜单标签也在这里。
  const social = page?.seriesSocialInfo || {};
  const reviews = Array.isArray(social.reviews?.reviews) ? social.reviews.reviews : [];
  const celebrities = Array.isArray(series.celebrities)
    ? series.celebrities.map((item) => ({
        name: String(item?.nickname || ""),
        avatar: cleanUrl(item?.avatar) || "",
        role: String(item?.sub_title || ""),
      }))
    : [];

  const episodes = Array.from(series.vid_list, (vid, index) => ({
    id: String(vid),
    title: `第 ${index + 1} 集`,
    number: index + 1,
  }));

  const value = {
    ...toSeries({ series_id: series.series_id || id, ...series, series_name: series.series_name }),
    id: String(id),
    episodes,
    episodeCount: Number(series.episode_cnt || series.vid_list.length),
    accessibleEpisodes: Number(series.accessible_episode_cnt || 0),
    celebrities,
    social: {
      rating: Number(social.rating || 0) || null,
      likeCount: String(social.series_like_count || ""),
      favoriteCount: String(social.series_favorite_count || ""),
      ratingCount: String(social.rating_count || ""),
      rankLabel: String(social.rank_label || ""),
      hotText: String(social.hot_score_data?.text || ""),
      reviewTotal: Number(social.reviews?.total_count || reviews.length) || 0,
      reviews: reviews.slice(0, 20).map((item) => ({
        content: String(item?.content || ""),
        user: String(item?.user_name || ""),
        avatar: cleanUrl(item?.user_avatar) || "",
        // 平台是 10 分制，前端按 5 星展示。
        stars: Math.max(0, Math.min(5, Math.round(Number(item?.rating || 0) / 2))),
        digg: Number(item?.digg_count || 0),
      })),
    },
  };
  await cacheSet(env, key, value);
  return value;
}
