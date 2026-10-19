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

// 注册结果按进程保存；重启后重新注册。设备注册是匿名且一次请求即可，
// 不落盘可以避免把身份信息写进仓库或日志。
let identity = null;
let identityPromise = null;

export async function ensureIdentity() {
  if (identity) return identity;
  if (!identityPromise) {
    identityPromise = (async () => {
      const { registerDevice } = await import("./device-register.mjs");
      const registered = await registerDevice();
      identity = {
        deviceId: registered.deviceId,
        installId: registered.installId,
        cookie: Object.entries(registered.cookies)
          .map(([name, value]) => `${name}=${value}`)
          .join("; "),
      };
      return identity;
    })().finally(() => {
      identityPromise = null;
    });
  }
  return identityPromise;
}

// 账号 Cookie（可选）：用户从浏览器/客户端导出后填进设置，用于解锁非公开集。
// 播放接口对 x-tt-token 的长度敏感，因此只发 Cookie 头，不发 x-tt-token。
let accountCookie = "";

export function setAccountCookie(value) {
  accountCookie = String(value || "").trim();
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

export async function detail(id) {
  if (!/^\d{1,30}$/.test(String(id))) throw new Error("剧集 ID 无效");
  const data = await api.routerData(`${SITE}/detail?series_id=${id}`);
  const series = data?.loaderData?.detail_page?.seriesDetail;
  if (!series || !Array.isArray(series.vid_list) || !series.vid_list.length)
    throw new Error("剧集不存在或分集暂不可用");
  const episodes = Array.from(series.vid_list, (vid, index) => ({
    id: String(vid),
    title: `第 ${index + 1} 集`,
    number: index + 1,
  }));
  if (
    episodes.some((episode) => !/^\d+$/.test(episode.id)) ||
    new Set(episodes.map((episode) => episode.id)).size !== episodes.length
  )
    throw new Error("分集数据异常");
  return {
    ...toSeries({ series_id: series.series_id || id, ...series, series_name: series.series_name }),
    id: String(id),
    episodes,
  };
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
 * 账号解析：带 Cookie 请求 App 播放接口，取 spade 解密后的 CDN 地址与 CENC 密钥。
 * 平台 2026-10-15 起匿名请求返回空响应，所以这条路只在用户填了 Cookie 时尝试。
 */
async function accountStream(id) {
  if (!accountCookie) return null;
  const identity = await ensureIdentity();
  const host = "https://api5-normal-sinfonlineb.fqnovel.com";
  const biz = {
    detail_page_version: 0,
    device_level: 3,
    disable_digg_stat: false,
    need_all_video_definition: true,
    need_mp4_align: false,
    use_os_player: false,
    use_server_dns: false,
    video_platform: 1024,
  };
  const candidates = [
    ["/novel/player/video_model/v1/", { video_id: id, biz_param: biz }],
    [
      "/novel/player/multi_video_model/preload/v1/",
      { biz_param: biz, mixed_video_id_map: { "1004": [id] } },
    ],
    [
      "/novel/player/multi_video_model/default/v1/",
      { biz_param: biz, mixed_video_id_map: { "1004": [id] } },
    ],
    [
      "/novel/player/multi_video_model/detail/v1/",
      { biz_param: biz, mixed_video_id_map: { "1004": [id] } },
    ],
    [
      "/novel/player/multi_video_model/v1/",
      { biz_param: biz, mixed_video_id_map: { "1004": [id] } },
    ],
  ];
  let lastError = null;
  for (const [path, body] of candidates) {
    try {
      const values = {
        ...api.DEVICE,
        device_id: identity.deviceId,
        iid: identity.installId,
      };
      const signed = signedRequest(host + path, values, body);
      signed.headers.Cookie = accountCookie;
      let text = "";
      // 网关偶发 200 + 空 body，原地重发几次再换路径。
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const response = await fetch(signed.url, {
          method: "POST",
          headers: signed.headers,
          body: signed.body,
          signal: AbortSignal.timeout(30000),
        });
        text = await response.text();
        if (text.trim()) break;
        await new Promise((resolve) => setTimeout(resolve, 200 + attempt * 200));
      }
      if (!text.trim()) throw new Error("播放接口空响应");
      const data = JSON.parse(text);
      const code = Number(data.Code ?? data.code ?? 0);
      if (code !== 0) throw new Error(`播放接口暂不可用（${code}）`);
      const model = findVideoModel(data);
      if (!model) throw new Error("播放接口没有返回播放模型");
      const fallbackRaw = model.fallback_api;
      const fallback =
        typeof fallbackRaw === "object"
          ? fallbackRaw.fallback_api || fallbackRaw[0]
          : (() => {
              try {
                return JSON.parse(fallbackRaw).fallback_api;
              } catch {
                return fallbackRaw;
              }
            })();
      if (!String(fallback).startsWith("https://"))
        throw new Error("播放地址格式异常");
      const infoResponse = await fetch(fallback, {
        headers: {
          "User-Agent": PLAYER_UA,
          "Accept-Language": "zh-CN,zh;q=0.9",
        },
        signal: AbortSignal.timeout(30000),
      });
      const info = (await infoResponse.json())?.video_info?.data;
      const rows = api
        .qualityRows(info?.video_list)
        .filter((row) => String(row.item?.codec_type || "").toLowerCase() !== "bytevc2");
      if (!rows.length) throw new Error("没有可用清晰度");
      const selected = rows.find((row) => api.qualityNumber(row.quality) <= 1080) || rows[0];
      let url = api.cleanUrl(selected.item.main_url);
      const seed = String(info?.key_seed || "");
      if (seed && url) url = api.decryptSpadeUrl(url, Buffer.from(seed, "base64"));
      if (!/^https?:\/\//.test(url)) throw new Error("播放地址无效");
      const key = selected.item.spade_a
        ? api.deriveContentKey(selected.item.spade_a)
        : null;
      return {
        url,
        key,
        quality: api.qualityLabel(selected.quality || selected.key),
        kind: "account",
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("播放地址解析失败");
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

/** 解析一集的播放来源：优先账号链路，失败/未配置时退回公开预览。 */
export async function resolvePlayback(id) {
  const key = String(id);
  const cached = cacheGet(playbackCache, key);
  if (cached) return cached;
  let source = null;
  if (accountCookie) {
    try {
      source = await accountStream(key);
    } catch {
      source = null;
    }
  }
  if (!source) source = await publicPreview(key);
  if (!source) throw new Error("这一集没有可播放的地址");
  cacheSet(playbackCache, key, source);
  return source;
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
