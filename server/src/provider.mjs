// 内容接入：官网 SSR 列表/详情 + App 搜索（签名）+ 播放地址解析。
// 协议实现来自 server/src/vendor/hongguo.cjs（drpys, GPL-3.0），本文件只做适配。
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { sm3 as pureSm3 } from "./sm3.mjs";

// Vercel / 打包器有时会改写 import.meta.url 或把文件挪位置，
// 这里多试几个候选路径，避免因找不到 vendor 而整站不可用。
function loadVendorSource() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, "vendor", "hongguo.cjs"),
    path.join(process.cwd(), "server", "src", "vendor", "hongguo.cjs"),
    path.join(process.cwd(), "src", "vendor", "hongguo.cjs"),
    path.join(process.cwd(), "vendor", "hongguo.cjs"),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return fs.readFileSync(candidate, "utf8");
    } catch {
      // 继续试下一个。
    }
  }
  throw new Error("找不到 vendor/hongguo.cjs，部署时需一并打包该文件");
}

const vendorSource = loadVendorSource();

// Cloudflare Workers 的 node:crypto 没有 sm3（实测 "Digest method not supported"），
// 用一个只补 sm3 的包装层顶上去，其余算法仍走原生实现。
const cryptoShim = {
  ...crypto,
  createHash(algorithm) {
    if (String(algorithm).toLowerCase() === "sm3") {
      const chunks = [];
      return {
        update(chunk) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          return this;
        },
        digest(encoding) {
          const result = pureSm3(Buffer.concat(chunks));
          return encoding === "hex" ? result.toString("hex") : result;
        },
      };
    }
    return crypto.createHash(algorithm);
  },
};

// 只暴露协议实现需要的模块；vendor 是固定版本的可信源码，不是用户脚本沙箱。
const context = vm.createContext({
  require: (name) => {
    if (name === "node:crypto") return cryptoShim;
    throw new Error(`Unsupported module: ${name}`);
  },
  Buffer,
  URL,
  URLSearchParams,
  // 该 vendor 的 axios 用法是 axios(url, opts) / axios.post(...)，用 fetch 实现即可。
  axios: makeAxios(),
});
vm.runInContext(
  vendorSource +
    "\nthis.api = { DEVICE, APP_DEVICE, VIDEO_UA, SITE, PAGE_SIZE, " +
    "categoryPage, categoryData, itemToCard, appSearchPage, appSearchCells, appSearchVod, " +
    "routerData, pythonUrlEncode, xGorgon, helios, buildMedusa, be32, le32, branchOf, " +
    "cleanUrl, str, qualityRows, qualityNumber, qualityLabel, deriveContentKey, decryptSpadeUrl, " +
    "prepareCencHeader, decryptPartial, getText };",
  context,
  { timeout: 5000 }
);
const api = context.api;

const APP_SEARCH_API =
  "https://api5-normal-sinfonlinea.fqnovel.com/reading/bookapi/search/tab/v";
const SITE = "https://hongguoduanju.com";
const PLAYER_UA = api.VIDEO_UA;
const APP_UA = "com.phoenix.read/72232 (Linux; U; Android 16; zh_CN; 25053RT47C; Build/BP2A.250605.031.A3)";

// ---------------------------------------------------------------- axios 兼容层

function makeAxios() {
  const request = async (url, options = {}) => {
    const headers = { ...(options.headers || {}) };
    let body = options.body;
    if (options.data !== undefined && body === undefined) {
      body =
        typeof options.data === "string" || Buffer.isBuffer(options.data)
          ? options.data
          : JSON.stringify(options.data);
    }
    const response = await fetch(url, {
      method: options.method || (body ? "POST" : "GET"),
      headers,
      body,
      signal: AbortSignal.timeout(options.timeout || 20000),
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    const responseHeaders = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key.toLowerCase()] = value;
    });
    const data =
      options.responseType === "arraybuffer" ? buffer : buffer.toString("utf8");
    // vendor 会检查 status；这里不抛错，保持与 axios 的 validateStatus 默认行为一致的
    // 失败语义由调用方自己判断。
    return { status: response.status, headers: responseHeaders, data };
  };
  request.post = (url, body, options = {}) =>
    request(url, { ...options, method: "POST", body });
  request.get = (url, options = {}) => request(url, { ...options, method: "GET" });
  request.create = () => request;
  return request;
}

// ---------------------------------------------------------------- 设备身份

// 设备身份必须跨重启保持稳定。平台把发码凭证（sms_code_key）绑定在 device_id 上，
// 每次重启都重新注册一台新设备会让用户手里的凭证立刻失效，表现为
// 「短信刚收到却提示验证码过期」。所以本地部署时把身份落到数据目录，
// 重启后复用同一台设备；Serverless 无共享磁盘，仍靠 x-xgg-device 头在请求间传递。
let identity = null;
let identityPromise = null;

function identityFile() {
  return String(process.env.DEVICE_IDENTITY_FILE || "").trim();
}

function loadStoredIdentity() {
  const file = identityFile();
  if (!file) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!data?.deviceId || !data?.installId) return null;
    return {
      deviceId: String(data.deviceId),
      installId: String(data.installId),
      cookie: String(data.cookie || ""),
    };
  } catch {
    return null;
  }
}

function storeIdentity(value) {
  const file = identityFile();
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(temp, file);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "identity_persist_failed",
        message: error instanceof Error ? error.message : String(error),
      })
    );
  }
}

// 请求级身份：由 api.mjs 从请求头读入后设置，优先于进程内缓存。
// 这样无状态的 Serverless 多实例也能保证同一用户使用同一台设备。
let requestIdentity = null;

export function setRequestIdentity(value) {
  requestIdentity = value;
}

export async function ensureIdentity() {
  if (requestIdentity) return requestIdentity;
  if (identity) return identity;
  if (!identityPromise) {
    identityPromise = (async () => {
      // 先看磁盘上有没有上次注册的设备；有就复用，避免作废用户手里的凭证。
      const stored = loadStoredIdentity();
      if (stored) {
        identity = stored;
        return identity;
      }
      const { registerDevice } = await import("./device-register.mjs");
      const registered = await registerDevice();
      identity = {
        deviceId: registered.deviceId,
        installId: registered.installId,
        cookie: Object.entries(registered.cookies)
          .map(([name, value]) => `${name}=${value}`)
          .join("; "),
      };
      storeIdentity(identity);
      return identity;
    })().finally(() => {
      identityPromise = null;
    });
  }
  return identityPromise;
}

// 账号 Cookie（可选）：用户从浏览器/客户端导出后填进设置，用于解锁非公开集。
// 播放接口对 x-tt-token 的长度敏感，因此只发 Cookie 头，不发 x-tt-token。
//
// 持久化：本地部署时写进数据目录（权限 0600），重启后自动恢复，不用每次重填。
// Serverless 多实例没有共享磁盘，这时用环境变量 ACCOUNT_COOKIE 注入。
// 无论哪种方式都不通过接口回传完整 Cookie。
let accountCookie = "";

// 惰性读取：入口文件会先 import 本模块再设置 ACCOUNT_COOKIE_FILE，因此不能在
// 模块顶层求值。
function cookieFile() {
  return String(process.env.ACCOUNT_COOKIE_FILE || "").trim();
}

function cookieEnv() {
  return String(process.env.ACCOUNT_COOKIE || "").trim();
}

function readCookieFile() {
  const file = cookieFile();
  if (!file) return "";
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

function writeCookieFile(value) {
  const file = cookieFile();
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!value) {
      fs.rmSync(file, { force: true });
      return;
    }
    // 先写临时文件再改名，避免进程中断留下半截凭据。
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, value, { mode: 0o600 });
    fs.renameSync(temp, file);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "cookie_persist_failed",
        message: error instanceof Error ? error.message : String(error),
      })
    );
  }
}

/** 进程启动时恢复登录态：环境变量优先，其次磁盘。 */
export function restoreAccountCookie() {
  accountCookie = cookieEnv() || readCookieFile();
  return Boolean(accountCookie);
}

export function setAccountCookie(value) {
  accountCookie = String(value || "").trim();
  // 环境变量注入的凭据视为部署配置，运行时改它没有意义，也不该覆盖。
  if (!cookieEnv()) writeCookieFile(accountCookie);
  playbackCache.clear();
}

export function hasAccountCookie() {
  return Boolean(accountCookie);
}

/** 只供服务端内部读取（用于算有效期），不通过任何接口回传完整 Cookie。 */
export function accountCookieSnapshot() {
  return accountCookie;
}

// ---------------------------------------------------------------- 请求签名

export function signedRequest(base, values, bodyObject) {
  const now = Date.now();
  const ts = Math.floor(now / 1000);
  const body = bodyObject ? Buffer.from(JSON.stringify(bodyObject)) : null;
  let query = "";
  let url = "";
  let ticket = now;
  // 只有 branch 0 的请求会被接受：把 _rticket 从 now 起逐个 +1 试。
  for (let offset = 0; offset < 128; offset += 1) {
    ticket = now + offset;
    query = api.pythonUrlEncode({
      ...values,
      ts: String(ts),
      _rticket: String(ticket),
    });
    url = `${base}?${query}`;
    if (api.branchOf(url, body, ts) === 0) break;
  }
  const random = Math.floor(Math.random() * 65536);
  const headers = {
    "User-Agent": body ? PLAYER_UA : APP_UA,
    Accept: "application/json; charset=utf-8,application/x-protobuf",
    "x-ss-req-ticket": String(ticket),
    "x-tt-request-tag": "t=0;n=0",
    "sdk-version": "2",
    "passport-sdk-version": "50561",
    "x-xs-from-web": "0",
    "x-khronos": String(ts),
    "x-ladon": api.be32(ts).toString("base64"),
    "x-argus": api.le32(ts).toString("base64"),
    "x-gorgon": api.xGorgon(query, body, ts, random),
    "x-helios": api.helios(ts),
    "x-medusa": api.buildMedusa(url, body, ts),
    "x-tt-dt": "",
  };
  if (body) {
    headers["Content-Type"] = "application/json; charset=UTF-8";
    headers["x-vc-bdturing-sdk-version"] = "3.7.2.cn";
    headers["x-ss-stub"] = crypto
      .createHash("md5")
      .update(body)
      .digest("hex")
      .toUpperCase();
  }
  return { url, headers, body };
}

// ---------------------------------------------------------------- 列表与详情

const homeCache = new Map();
const CACHE_TTL = 3 * 60 * 1000;

function cacheGet(cache, key) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.time < CACHE_TTL) return hit.value;
  if (hit) cache.delete(key);
  return null;
}

function cacheSet(cache, key, value) {
  cache.set(key, { time: Date.now(), value });
  while (cache.size > 60) cache.delete(cache.keys().next().value);
}

function toSeries(row) {
  const card = api.itemToCard(row);
  return {
    id: String(card.url || ""),
    title: String(card.title || ""),
    cover: card.img || "",
    description: card.content || "",
    badge: card.desc || "",
    tags: card.tname || "",
  };
}

const validSeries = (rows) =>
  rows.filter((item) => /^\d{1,30}$/.test(item.id) && item.title);

export async function home(page = 1) {
  const key = `home:${page}`;
  const cached = cacheGet(homeCache, key);
  if (cached) return cached;
  const data = await api.categoryPage("tab=1&sort_type=1", page);
  const pageData =
    data?.loaderData?.category_page ||
    data?.loaderData?.["category_$"] ||
    data?.loaderData?.category_layout;
  const rows = pageData?.recommendList || pageData?.categoryData?.recommendList;
  if (!Array.isArray(rows)) throw new Error("首页数据结构已变化");
  const totalPages = Number(pageData?.pagination?.totalPages || 34);
  const value = {
    items: validSeries(rows.map(toSeries)),
    page,
    totalPages,
  };
  cacheSet(homeCache, key, value);
  return value;
}

export async function search(keyword, page = 1) {
  const query = String(keyword || "").trim();
  if (!query) throw new Error("请输入关键词");
  const key = `search:${query}:${page}`;
  const cached = cacheGet(homeCache, key);
  if (cached) return cached;

  // App 搜索需要已注册设备；失败时退回官网搜索（无分页）。
  let result = null;
  try {
    const identity = await ensureIdentity();
    const values = {
      ...api.APP_DEVICE,
      device_id: identity.deviceId,
      iid: identity.installId,
      query,
      count: "20",
      offset: String((page - 1) * 20),
      tab_type: "11",
      bookshelf_search_plan: "4",
      use_correct: "true",
      user_is_login: accountCookie ? "1" : "0",
    };
    const signed = signedRequest(APP_SEARCH_API, values, null);
    if (identity.cookie) signed.headers.Cookie = identity.cookie;
    if (accountCookie) signed.headers.Cookie = accountCookie;
    const response = await fetch(signed.url, {
      headers: signed.headers,
      signal: AbortSignal.timeout(30000),
    });
    const text = await response.text();
    if (text.trim()) {
      const data = JSON.parse(text);
      if (Number(data.code) === 0) {
        const tabs = data.search_tabs || data.data?.search_tabs || [];
        const tab = tabs.find((item) => Number(item.tab_type) === 11) || {};
        const rows = [];
        const seen = new Set();
        for (const cell of tab.data || []) {
          for (const item of api.appSearchCells(cell)) {
            const vod = api.appSearchVod(item);
            if (vod && !seen.has(vod.url)) {
              seen.add(vod.url);
              rows.push(vod);
            }
          }
        }
        // App 搜索给的封面是带签名的 HEIC，浏览器不能显示；用官网详情页的 JPEG 封面替换。
        const items = await Promise.all(
          rows.map(async (row) => {
            const base = {
              id: String(row.url),
              title: String(row.title || ""),
              cover: row.img || "",
              description: row.content || "",
              badge: row.desc || "",
              tags: row.tname || "",
            };
            if (!/\.heic(\?|$)/i.test(base.cover)) return base;
            try {
              const page = await api.routerData(`${SITE}/detail?series_id=${row.url}`);
              const series = page?.loaderData?.detail_page?.seriesDetail;
              if (series?.series_cover) base.cover = api.cleanUrl(series.series_cover);
            } catch {
              // 拿不到官网封面时保留原值，前端会退化成占位图。
            }
            return base;
          })
        );
        result = {
          items: validSeries(items),
          page,
          hasMore: Boolean(tab.has_more),
        };
      }
    }
  } catch {
    // 回退到官网搜索。
  }

  if (!result) {
    const data = await api.routerData(
      `${SITE}/search/${encodeURIComponent(query)}?page=${page}`
    );
    const pageData =
      data?.loaderData?.["search_(keyword)/page"] || data?.loaderData?.search_page;
    const rows = pageData?.searchList;
    if (!Array.isArray(rows)) throw new Error("搜索数据不可用");
    result = {
      items: validSeries(rows.map(toSeries)),
      page,
      hasMore: false,
    };
  }
  cacheSet(homeCache, key, result);
  return result;
}

function toEpisodes(vidList) {
  const episodes = Array.from(vidList || [], (vid, index) => ({
    id: String(vid),
    title: `第 ${index + 1} 集`,
    number: index + 1,
  }));
  if (
    episodes.some((episode) => !/^\d+$/.test(episode.id)) ||
    new Set(episodes.map((episode) => episode.id)).size !== episodes.length
  )
    throw new Error("分集数据异常");
  return episodes;
}

export async function detail(id) {
  if (!/^\d{1,30}$/.test(String(id))) throw new Error("剧集 ID 无效");
  const data = await api.routerData(`${SITE}/detail?series_id=${id}`);
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
        avatar: api.cleanUrl(item?.avatar) || "",
        role: String(item?.sub_title || ""),
      }))
    : [];

  return {
    ...toSeries({ series_id: series.series_id || id, ...series, series_name: series.series_name }),
    id: String(id),
    episodes: toEpisodes(series.vid_list),
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
        avatar: api.cleanUrl(item?.user_avatar) || "",
        // 平台是 10 分制，前端按 5 星展示。
        stars: Math.max(0, Math.min(5, Math.round(Number(item?.rating || 0) / 2))),
        digg: Number(item?.digg_count || 0),
      })),
    },
  };
}

// ---------------------------------------------------------------- 分类与榜单

// 分类路由直接对应官网路径：/category/<type>[/<sub>]。官网只认 page 参数，
// 带上 tab / sort_type 反而会 404。
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

/**
 * 官网榜单页有两种 SSR 形态，同一个路由会随请求切换：
 *   1. <script data-fn-name="r" data-fn-args='["rank_xx/page","content",{...}]'>
 *   2. <script data-fn-name="mergeLoaderData" data-fn-args="[&quot;rank_xx/page&quot;,[{…routerDataFnArgs:[&quot;{…}&quot;]}]]">
 * 第二种把 payload 再包了一层字符串，所以统一从这里捞 rankList。
 */
function decodeEntities(value) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&#x2F;|&#47;/gi, "/")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function findRankList(node, depth = 0) {
  if (!node || depth > 6) return null;
  if (typeof node === "string") {
    // routerDataFnArgs 里装的是被转义成字符串的 JSON。
    if (!node.includes("rankList")) return null;
    try {
      return findRankList(JSON.parse(node), depth + 1);
    } catch {
      return null;
    }
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findRankList(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof node !== "object") return null;
  if (node.isSuccess && Array.isArray(node.rankList)) return node;
  for (const value of Object.values(node)) {
    const found = findRankList(value, depth + 1);
    if (found) return found;
  }
  return null;
}

function parseRankPayload(html) {
  const patterns = [
    /data-fn-name="r"[^>]*data-fn-args='([^']+)'/,
    /data-fn-name="mergeLoaderData"[^>]*data-fn-args="([^"]+)"/,
    /data-fn-name="r"[^>]*data-fn-args="([^"]+)"/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(html);
    if (!match) continue;
    let args;
    try {
      args = JSON.parse(decodeEntities(match[1]));
    } catch {
      continue;
    }
    const payload = findRankList(args);
    if (payload) return payload;
  }
  throw new Error("榜单页面没有数据");
}

export async function rank(route = "hot-drama", page = 1) {
  if (!RANK_ROUTES.has(route)) throw new Error("不支持的榜单");
  const key = `rank:${route}:${page}`;
  const cached = cacheGet(homeCache, key);
  if (cached) return cached;

  const suffix = page > 1 ? `?page=${page}` : "";
  const html = await api.getText(`${SITE}/rank/${route}${suffix}`);

  let payload = null;
  try {
    payload = parseRankPayload(html);
  } catch {
    // AI 剧榜在官网是客户端二次取数，SSR 只给空壳。用 AI 剧分类兜底，
    // 保持「榜单」这个入口可用，并在返回里标明数据来源。
  }
  if (!payload) {
    const fallback = await category("ai-drama", "", page);
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
    cacheSet(homeCache, key, value);
    return value;
  }

  const pagination = payload.pagination || {};
  const items = payload.rankList.map((item) => ({
    id: String(item.seriesId || item.series_id || item.id || ""),
    rank: Number(item.rank || 0),
    title: String(item.title || ""),
    cover: api.cleanUrl(item.cover) || "",
    heat: String(item.heatText || ""),
    rating: String(item.scoreText || "").replace(/^评分/, ""),
    fav: String(item.favoriteText || ""),
    like: String(item.likeText || ""),
    isNew: (item.statusTags || []).includes("新剧"),
    tags: Array.isArray(item.tags) ? item.tags.slice(0, 4) : [],
    intro: String(item.description || ""),
    // 匿名请求下 episodeVids 只给公开预览的几集（通常 3），
    // 真实总集数在 episodeCount 里。只有它缺失时才退回数组长度。
    episodes: Number(item.episodeCount || 0) ||
      (Array.isArray(item.episodeVids) ? item.episodeVids.length : 0),
    openEpisodes: Number(item.openEpisodeCount || 0) ||
      (Array.isArray(item.episodeVids) ? item.episodeVids.length : 0),
  }));

  // 榜单页头部文案（"10月22日已更新 · …"）没有单独字段，从 HTML 里捞。
  const updatedMatch = /"updatedText"\s*:\s*"([^"]*)"/.exec(html);
  const value = {
    key: route,
    route,
    items: items.filter((item) => /^\d{1,30}$/.test(item.id) && item.title),
    page,
    totalPages: Number(pagination.totalPages || 1),
    updated: updatedMatch ? updatedMatch[1].replace(/\\u002F/g, "/") : "",
  };
  cacheSet(homeCache, key, value);
  return value;
}

export async function category(type, sub = "", page = 1) {
  const label = CATEGORY_LABELS[type];
  if (!label) throw new Error("不支持的分类");
  const key = `category:${type}:${sub}:${page}`;
  const cached = cacheGet(homeCache, key);
  if (cached) return cached;

  // 子分类走 /category/<type>/<slug>；官网只给真人剧铺了子分类路由。
  const base = sub
    ? `${SITE}/category/${type}/${encodeURIComponent(sub)}`
    : `${SITE}/category/${type}`;
  const data = await api.routerData(page > 1 ? `${base}?page=${page}` : base);
  const pageData = data?.loaderData?.["category_$"];
  const rows = pageData?.recommendList;
  if (!Array.isArray(rows)) throw new Error("分类数据结构已变化");

  const selector = pageData?.selectorList?.[0];
  const pagination = pageData?.pagination || {};
  const value = {
    type,
    label: String(pageData?.categoryRoute?.displayName || label),
    seo: pageData?.seo || {},
    tags: Array.isArray(selector?.items)
      ? selector.items.map((item) => ({
          id: String(item.selector_item_id || ""),
          name: String(item.show_name || ""),
        }))
      : [],
    items: validSeries(rows.map(toSeries)),
    page,
    total: Number(pagination.total || 0),
    totalPages: Number(pagination.totalPages || 1),
  };
  cacheSet(homeCache, key, value);
  return value;
}

// ---------------------------------------------------------------- 播放地址

const playbackCache = new Map();

/**
 * 公开预览：官网对每部剧的前几集提供 /video/public/<vid>/360p.mp4 直链，
 * 匿名可播、支持 Range。直接 HEAD 探测比抓播放页可靠（页面按剧集 ID 路由）。
 */
async function publicPreview(id) {
  const url = `${SITE}/video/public/${id}/360p.mp4`;
  try {
    const response = await fetch(url, {
      method: "HEAD",
      headers: { "User-Agent": PLAYER_UA, "Accept-Encoding": "identity" },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return null;
    const type = response.headers.get("content-type") || "";
    if (!type.startsWith("video/")) return null;
    return { url, quality: "360P", kind: "public" };
  } catch {
    return null;
  }
}

/**
 * App 播放接口的请求参数。照抓包（2026-10-22，红果桌面端 v1.2.10）还原：
 *
 * - host 必须是 api5-normal-lq（sinfonline 线路会回 110001）
 * - biz_param.device_level 必须是 4（传 3 会回 110001）
 * - query 要带齐 channel / dragon_device_type / compliance_status 等移动端字段
 * - mixed_video_id_map 按 content_type 分组，短剧是 "1004"
 *
 * 返回的 data[vid].video_model 是 JSON 字符串，里面的 video_list 是
 * { video_1: {definition:"360p", main_url:"<base64>", spade_a}, ... }。
 */
const PLAYER_HOST = "https://api5-normal-lq.fqnovel.com";

const PLAYER_QUERY = {
  ac: "wifi",
  aid: "8662",
  app_name: "novelread",
  channel: "xiaomi_8662_64",
  compliance_status: "0",
  device_brand: "xiaomi",
  device_type: "23127PN0CC",
  dpi: "460",
  dragon_device_type: "phone",
  host_abi: "arm64-v8a",
  is_android_pad_screen: "0",
  language: "zh",
  manifest_version_code: "73932",
  need_personal_recommend: "1",
  os: "android",
  os_api: "34",
  os_version: "14",
  player_so_load: "1",
  pv_player: "73932",
  resolution: "1200*2670",
  ssmix: "a",
  update_version_code: "73932",
  version_code: "73932",
  version_name: "7.3.9.32",
};

const PLAYER_BIZ = {
  detail_page_version: 0,
  device_level: 4,
  disable_digg_stat: false,
  need_all_video_definition: true,
  need_mp4_align: false,
  use_os_player: false,
  use_server_dns: false,
  video_platform: 1024,
};

/**
 * 匿名解析一集的播放地址。
 *
 * 这条路不需要登录：平台对移动端下发的 video_list 本身就带完整地址，
 * 只有官网的 /video/public/ 路径才限制前几集。抓包确认桌面端在未登录
 * 状态下就是这么播完整剧集的（本地 progress 表有播放记录、account 表为空）。
 */
async function appStream(id) {
  const identity = await ensureIdentity();
  const values = {
    ...PLAYER_QUERY,
    device_id: identity.deviceId,
    iid: identity.installId,
  };
  const body = {
    biz_param: PLAYER_BIZ,
    mixed_video_id_map: { "1004": [String(id)] },
  };
  const signed = signedRequest(
    `${PLAYER_HOST}/novel/player/multi_video_model/v1/`,
    values,
    body
  );
  if (accountCookie) signed.headers.Cookie = accountCookie;

  const response = await fetch(signed.url, {
    method: "POST",
    headers: signed.headers,
    body: signed.body,
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`播放接口 HTTP ${response.status}`);
  const data = await response.json();
  const code = Number(data?.code ?? data?.Code ?? 0);
  if (code !== 0) throw new Error(`播放接口暂不可用（${code}）`);

  const entry = data?.data?.[String(id)];
  if (!entry) throw new Error("播放接口没有返回这一集");
  const model = parseJsonish(entry.video_model);
  if (!model) throw new Error("播放接口没有返回播放模型");

  const list = model.video_list;
  const items = Array.isArray(list) ? list : Object.values(list || {});
  const rows = items
    .map((item) => {
      const meta = item.video_meta || item;
      const definition = String(item.definition || meta.definition || "");
      const encoded = String(item.main_url || "");
      let url = "";
      try {
        url = Buffer.from(encoded, "base64").toString("utf8");
      } catch {
        url = encoded;
      }
      return {
        url,
        quality: definition || "360p",
        number: Number(definition.replace(/[^\d]/g, "")) || 0,
        spadeA: item.spade_a || meta.spade_a || "",
        keySeed: model.key_seed || "",
      };
    })
    .filter((row) => /^https?:\/\//.test(row.url));

  if (!rows.length) throw new Error("没有可用清晰度");

  // 默认取不超过 720P 的最高档：再高对短剧没意义，还更容易被限速。
  const usable = rows.filter((row) => row.number && row.number <= 720);
  const selected = (usable.length ? usable : rows).sort(
    (a, b) => b.number - a.number
  )[0];

  // spade_a 存在时地址是被 SPADE 包过的，要先解出真实地址。
  let url = selected.url;
  if (selected.spadeA && selected.keySeed) {
    try {
      url = api.decryptSpadeUrl(url, Buffer.from(selected.keySeed, "base64"));
    } catch {
      // 解不出来就用原地址；多数短剧并不加密。
    }
  }
  if (!/^https?:\/\//.test(url)) throw new Error("播放地址无效");

  const key = selected.spadeA ? api.deriveContentKey(selected.spadeA) : null;
  return {
    url,
    key,
    quality: selected.quality.toUpperCase().replace("P", "P"),
    kind: accountCookie ? "account" : "public",
  };
}

/** 把可能是字符串的 JSON 字段解析成对象。 */
function parseJsonish(value) {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * 账号解析：带 Cookie 走同一个接口，多取一次 fallback_api 拿 CENC 密钥。
 * 现在匿名也能拿到播放地址，这条路径只用于需要登录才能看的剧集。
 */
async function accountStream(id) {
  if (!accountCookie) return null;
  try {
    return await appStream(id);
  } catch {
    return null;
  }
}

function findVideoModel(data) {
  const root = data?.data;
  if (!root) return null;
  const parse = (value) => {
    if (value && typeof value === "object") return value;
    if (typeof value === "string") {
      try {
        return JSON.parse(value);
      } catch {
        return null;
      }
    }
    return null;
  };
  const direct = parse(root.video_model);
  if (direct) return direct;
  for (const value of Object.values(root)) {
    if (value && typeof value === "object") {
      const nested = parse(value.video_model);
      if (nested) return nested;
    }
  }
  return null;
}

/**
 * 解析一集的播放来源。
 *
 * 顺序：App 播放接口（匿名可用，覆盖整部剧）→ 官网公开预览（兜底）。
 * App 接口能拿到全部分集，所以正常情况不会走到第二步。
 */
export async function resolvePlayback(id) {
  const key = String(id);
  const cached = cacheGet(playbackCache, key);
  if (cached) return cached;
  let source = null;
  try {
    source = await appStream(key);
  } catch {
    source = null;
  }
  if (!source) source = await publicPreview(key);
  if (!source) throw new Error("这一集没有可播放的地址");
  cacheSet(playbackCache, key, source);
  return source;
}

/**
 * 这一部剧能播到第几集。
 *
 * App 播放接口对整部剧都下发地址，所以匿名也能播完整剧集。这里只抽查第一集的
 * 最后一个分集：能解析出地址就认为整部可播，避免对 86 集逐集打请求。
 * 解析失败时退回官网公开预览的逐集探测（只有前几集）。
 */
const coverageCache = new Map();

export async function previewCoverage(episodeIds) {
  const list = Array.isArray(episodeIds) ? episodeIds : [];
  if (!list.length) return 0;
  const key = String(list[0]);
  const cached = cacheGet(coverageCache, key);
  if (cached !== null) return cached;

  // 先看 App 接口能不能解析最后一集——能就整部可播。
  try {
    const last = String(list[list.length - 1]);
    const probe = await appStream(last);
    if (probe) {
      cacheSet(coverageCache, key, list.length);
      return list.length;
    }
  } catch {
    // 落到公开预览探测。
  }

  let count = 0;
  const limit = Math.min(list.length, 40);
  for (let index = 0; index < limit; index += 1) {
    const playable = await publicPreview(String(list[index]));
    if (!playable) break;
    count += 1;
  }
  cacheSet(coverageCache, key, count);
  return count;
}


/** 供流代理使用：建 CENC 索引、按区间解密。 */
export function createStreamReader(source) {
  const state = { prepared: null, prefix: Buffer.alloc(0) };
  const headers = {
    "User-Agent": PLAYER_UA,
    Referer: "https://novel.snssdk.com/",
    "Accept-Encoding": "identity",
  };
  async function remoteRange(start, end) {
    const response = await fetch(source.url, {
      headers: { ...headers, Range: `bytes=${start}-${end}` },
      signal: AbortSignal.timeout(60000),
    });
    const data = Buffer.from(await response.arrayBuffer());
    let total = Number(
      String(response.headers.get("content-range") || "").match(/\/(\d+)$/)?.[1] || 0
    );
    if (response.status === 200) {
      total ||= Number(response.headers.get("content-length") || data.length);
      return { data: data.subarray(start, end + 1), total };
    }
    if (response.status !== 206) throw new Error(`媒体分段失败（HTTP ${response.status}）`);
    return { data, total };
  }
  async function prepare() {
    if (state.prepared) return state.prepared;
    const first = await remoteRange(0, 256 * 1024 - 1);
    let head = first.data;
    const total = first.total || head.length;
    if (head.length < 16) throw new Error("MP4 头过短");
    const ftypSize = head.readUInt32BE(0);
    if (
      head.toString("ascii", 4, 8) !== "ftyp" ||
      head.toString("ascii", ftypSize + 4, ftypSize + 8) !== "moov"
    )
      throw new Error("MP4 索引不在文件开头");
    const moovSize = head.readUInt32BE(ftypSize);
    const moovEnd = ftypSize + moovSize;
    if (moovSize < 8 || moovEnd > total || moovEnd > 8 * 1024 * 1024)
      throw new Error("MP4 索引大小异常");
    if (moovEnd > head.length) {
      head = Buffer.concat([head, (await remoteRange(head.length, moovEnd - 1)).data]);
    }
    head = head.subarray(0, moovEnd);
    const prepared = source.key
      ? api.prepareCencHeader(head, source.key)
      : { header: head, samples: [] };
    state.prepared = { total, header: prepared.header, samples: prepared.samples };
    state.prefix = head;
    return state.prepared;
  }
  async function read(start, length) {
    const prepared = await prepare();
    const end = Math.min(prepared.total, start + length);
    if (start >= prepared.total) return { data: Buffer.alloc(0), total: prepared.total };
    const available = Math.max(0, Math.min(end, state.prefix.length) - start);
    const cached = state.prefix.subarray(start, start + available);
    const raw =
      start + available < end
        ? Buffer.concat([cached, (await remoteRange(start + available, end - 1)).data])
        : Buffer.from(cached);
    const data = api.decryptPartial(raw, start, source.key, prepared);
    return { data, total: prepared.total };
  }
  return { read, prepare };
}
