// 小果果 · Cloudflare Worker 入口
//
// 与 server/src/index.mjs 同一套接口，但去掉了只在 Node 里成立的依赖：
//   - 静态文件交给 Workers Static Assets（见 wrangler.jsonc）
//   - 设备导出（adb）不提供：Worker 里没有子进程
//   - 账号 Cookie / 设备身份放在 KV，跨实例共享（内存态在边缘节点间不共享）
//
// 播放流仍按 Range 逐段拉取并解密后回给浏览器，不整段缓冲。
import crypto from "node:crypto";
import {
  SITE,
  VIDEO_UA,
  APP_UA,
  DEVICE,
  APP_DEVICE,
  categoryPage,
  routerData,
  itemToCard,
  appSearchCells,
  appSearchVod,
  pythonUrlEncode,
  xGorgon,
  helios,
  buildMedusa,
  be32,
  le32,
  branchOf,
  cleanUrl,
  qualityRows,
  qualityNumber,
  qualityLabel,
  deriveContentKey,
  decryptSpadeUrl,
  prepareCencHeader,
  decryptPartial,
} from "./vendor-worker.js";
import { sm3 } from "../server/src/sm3.mjs";
import { registerDevice } from "../server/src/device-register.mjs";
import { configureAccountModule, verifyAccount } from "../server/src/account.mjs";
import { configureSmsModule, loginWithCode, sendLoginCode } from "../server/src/sms-login.mjs";
import { sessionExpiry } from "../server/src/cookie-utils.mjs";
import {
  configureImportSession,
  createImportSession,
  getImportSession,
  submitImport,
} from "../server/src/import-session.mjs";
import { expiredPage, importPage } from "../server/src/import-page.mjs";

const APP_SEARCH_API = "https://api5-normal-sinfonlinea.fqnovel.com/reading/bookapi/search/tab/v";

// 账号与短信模块需要设备身份和签名；Worker 里用 KV 保存身份、用本文件的签名实现。
let injected = false;
function ensureModules(env) {
  if (injected) return;
  configureAccountModule({
    ensureIdentity: () => ensureIdentity(env),
    signedRequest,
  });
  configureSmsModule({
    ensureIdentity: () => ensureIdentity(env),
    signedRequest,
  });
  configureImportSession({
    setAccountCookie: (value) => setAccountCookie(env, value),
  });
  injected = true;
}

// ---------------------------------------------------------------- 状态（KV）

const IDENTITY_KEY = "identity";
const COOKIE_KEY = "account:cookie";

async function kvGet(env, key) {
  if (!env.XGG_KV) return null;
  return env.XGG_KV.get(key);
}

async function kvPut(env, key, value) {
  if (!env.XGG_KV) return;
  await env.XGG_KV.put(key, value);
}

async function ensureIdentity(env) {
  const cached = await kvGet(env, IDENTITY_KEY);
  if (cached) {
    try {
      return JSON.parse(cached);
    } catch {
      // 坏数据直接重新注册。
    }
  }
  const registered = await registerDevice();
  const identity = {
    deviceId: registered.deviceId,
    installId: registered.installId,
    cookie: Object.entries(registered.cookies)
      .map(([name, value]) => `${name}=${value}`)
      .join("; "),
  };
  await kvPut(env, IDENTITY_KEY, JSON.stringify(identity));
  return identity;
}

async function getAccountCookie(env) {
  return (await kvGet(env, COOKIE_KEY)) || "";
}

async function setAccountCookie(env, value) {
  const next = String(value || "").trim();
  if (!next) {
    if (env.XGG_KV) await env.XGG_KV.delete(COOKIE_KEY);
    return;
  }
  await kvPut(env, COOKIE_KEY, next);
}

// ---------------------------------------------------------------- 签名

function signedRequest(base, values, bodyObject) {
  const now = Date.now();
  const ts = Math.floor(now / 1000);
  const body = bodyObject ? Buffer.from(JSON.stringify(bodyObject)) : null;
  let query = "";
  let url = "";
  let ticket = now;
  for (let offset = 0; offset < 128; offset += 1) {
    ticket = now + offset;
    query = pythonUrlEncode({ ...values, ts: String(ts), _rticket: String(ticket) });
    url = `${base}?${query}`;
    if (branchOf(url, body, ts) === 0) break;
  }
  const random = Math.floor(Math.random() * 65536);
  const headers = {
    "User-Agent": body ? VIDEO_UA : APP_UA,
    Accept: "application/json; charset=utf-8,application/x-protobuf",
    "x-ss-req-ticket": String(ticket),
    "x-tt-request-tag": "t=0;n=0",
    "sdk-version": "2",
    "passport-sdk-version": "50561",
    "x-xs-from-web": "0",
    "x-khronos": String(ts),
    "x-ladon": be32(ts).toString("base64"),
    "x-argus": le32(ts).toString("base64"),
    "x-gorgon": xGorgon(query, body, ts, random),
    "x-helios": helios(ts),
    "x-medusa": buildMedusa(url, body, ts),
    "x-tt-dt": "",
  };
  if (body) {
    headers["Content-Type"] = "application/json; charset=UTF-8";
    headers["x-vc-bdturing-sdk-version"] = "3.7.2.cn";
    headers["x-ss-stub"] = crypto.createHash("md5").update(body).digest("hex").toUpperCase();
  }
  return { url, headers, body };
}

// ---------------------------------------------------------------- 内容

const CACHE_TTL = 180;

function json(status, value, extra = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extra },
  });
}

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

const validSeries = (rows) => rows.filter((item) => /^\d{1,30}$/.test(item.id) && item.title);

async function home(page) {
  const data = await categoryPage("tab=1&sort_type=1", page);
  const pageData =
    data?.loaderData?.category_page ||
    data?.loaderData?.["category_$"] ||
    data?.loaderData?.category_layout;
  const rows = pageData?.recommendList || pageData?.categoryData?.recommendList;
  if (!Array.isArray(rows)) throw new Error("首页数据结构已变化");
  return {
    items: validSeries(rows.map(toSeries)),
    page,
    totalPages: Number(pageData?.pagination?.totalPages || 34),
  };
}

async function search(env, keyword, page) {
  const query = String(keyword || "").trim();
  if (!query) throw new Error("请输入关键词");
  const accountCookie = await getAccountCookie(env);
  let result = null;
  try {
    const identity = await ensureIdentity(env);
    const values = {
      ...APP_DEVICE,
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
    if (accountCookie) signed.headers.Cookie = accountCookie;
    else if (identity.cookie) signed.headers.Cookie = identity.cookie;
    const response = await fetch(signed.url, { headers: signed.headers });
    const text = await response.text();
    if (text.trim()) {
      const data = JSON.parse(text);
      if (Number(data.code) === 0) {
        const tabs = data.search_tabs || data.data?.search_tabs || [];
        const tab = tabs.find((item) => Number(item.tab_type) === 11) || {};
        const rows = [];
        const seen = new Set();
        for (const cell of tab.data || [])
          for (const item of appSearchCells(cell)) {
            const vod = appSearchVod(item);
            if (vod && !seen.has(vod.url)) {
              seen.add(vod.url);
              rows.push(vod);
            }
          }
        result = {
          items: validSeries(
            rows.map((row) => ({
              id: String(row.url),
              title: String(row.title || ""),
              cover: row.img || "",
              description: row.content || "",
              badge: row.desc || "",
              tags: row.tname || "",
            }))
          ),
          page,
          hasMore: Boolean(tab.has_more),
        };
      }
    }
  } catch {
    // 退回官网搜索。
  }
  if (!result) {
    const data = await routerData(`${SITE}/search/${encodeURIComponent(query)}?page=${page}`);
    const pageData =
      data?.loaderData?.["search_(keyword)/page"] || data?.loaderData?.search_page;
    const rows = pageData?.searchList;
    if (!Array.isArray(rows)) throw new Error("搜索数据不可用");
    result = { items: validSeries(rows.map(toSeries)), page, hasMore: false };
  }
  return result;
}

async function detail(id) {
  if (!/^\d{1,30}$/.test(String(id))) throw new Error("剧集 ID 无效");
  const data = await routerData(`${SITE}/detail?series_id=${id}`);
  const series = data?.loaderData?.detail_page?.seriesDetail;
  if (!series || !Array.isArray(series.vid_list) || !series.vid_list.length)
    throw new Error("剧集不存在或分集暂不可用");
  const episodes = Array.from(series.vid_list, (vid, index) => ({
    id: String(vid),
    title: `第 ${index + 1} 集`,
    number: index + 1,
  }));
  return {
    ...toSeries({ ...series, series_id: series.series_id || id }),
    id: String(id),
    episodes,
  };
}

// ---------------------------------------------------------------- 播放

async function publicPreview(id) {
  const url = `${SITE}/video/public/${id}/360p.mp4`;
  try {
    const response = await fetch(url, {
      method: "HEAD",
      headers: { "User-Agent": VIDEO_UA, "Accept-Encoding": "identity" },
    });
    if (!response.ok) return null;
    if (!(response.headers.get("content-type") || "").startsWith("video/")) return null;
    return { url, quality: "360P", kind: "public" };
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

async function accountStream(env, id) {
  const cookie = await getAccountCookie(env);
  if (!cookie) return null;
  const identity = await ensureIdentity(env);
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
    ["/novel/player/multi_video_model/preload/v1/", { biz_param: biz, mixed_video_id_map: { "1004": [id] } }],
    ["/novel/player/multi_video_model/default/v1/", { biz_param: biz, mixed_video_id_map: { "1004": [id] } }],
    ["/novel/player/multi_video_model/v1/", { biz_param: biz, mixed_video_id_map: { "1004": [id] } }],
  ];
  let lastError = null;
  for (const [path, body] of candidates) {
    try {
      const signed = signedRequest(host + path, { ...DEVICE, device_id: identity.deviceId, iid: identity.installId }, body);
      signed.headers.Cookie = cookie;
      let text = "";
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const response = await fetch(signed.url, { method: "POST", headers: signed.headers, body: signed.body });
        text = await response.text();
        if (text.trim()) break;
      }
      if (!text.trim()) throw new Error("播放接口空响应");
      const data = JSON.parse(text);
      if (Number(data.Code ?? data.code ?? 0) !== 0) throw new Error("播放接口暂不可用");
      const model = findVideoModel(data);
      if (!model) throw new Error("没有播放模型");
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
      const infoResponse = await fetch(fallback, { headers: { "User-Agent": VIDEO_UA, "Accept-Language": "zh-CN,zh;q=0.9" } });
      const info = (await infoResponse.json())?.video_info?.data;
      const rows = qualityRows(info?.video_list).filter(
        (row) => String(row.item?.codec_type || "").toLowerCase() !== "bytevc2"
      );
      if (!rows.length) throw new Error("没有可用清晰度");
      const selected = rows.find((row) => qualityNumber(row.quality) <= 1080) || rows[0];
      let url = cleanUrl(selected.item.main_url);
      if (info?.key_seed) url = decryptSpadeUrl(url, Buffer.from(info.key_seed, "base64"));
      if (!/^https?:\/\//.test(url)) throw new Error("播放地址无效");
      const key = selected.item.spade_a ? deriveContentKey(selected.item.spade_a) : null;
      return { url, key, quality: qualityLabel(selected.quality || selected.key), kind: "account" };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("播放地址解析失败");
}

async function resolvePlayback(env, id) {
  const cookie = await getAccountCookie(env);
  if (cookie) {
    try {
      const source = await accountStream(env, id);
      if (source) return source;
    } catch {
      // 回退到公开预览。
    }
  }
  const preview = await publicPreview(id);
  if (!preview) throw new Error("这一集没有可播放的地址");
  return preview;
}

// ---------------------------------------------------------------- 流代理

async function streamResponse(env, request, id) {
  const source = await resolvePlayback(env, id);
  const headers = {
    "User-Agent": VIDEO_UA,
    Referer: "https://novel.snssdk.com/",
    "Accept-Encoding": "identity",
  };
  const remoteRange = async (start, end) => {
    const response = await fetch(source.url, { headers: { ...headers, Range: `bytes=${start}-${end}` } });
    const data = Buffer.from(await response.arrayBuffer());
    let total = Number(String(response.headers.get("content-range") || "").match(/\/(\d+)$/)?.[1] || 0);
    if (response.status === 200) {
      total ||= Number(response.headers.get("content-length") || data.length);
      return { data: data.subarray(start, end + 1), total };
    }
    if (response.status !== 206) throw new Error(`媒体分段失败（HTTP ${response.status}）`);
    return { data, total };
  };

  const first = await remoteRange(0, 256 * 1024 - 1);
  let head = first.data;
  const total = first.total || head.length;
  if (head.length < 16) throw new Error("MP4 头过短");
  const ftypSize = head.readUInt32BE(0);
  if (head.toString("ascii", 4, 8) !== "ftyp" || head.toString("ascii", ftypSize + 4, ftypSize + 8) !== "moov")
    throw new Error("MP4 索引不在文件开头");
  const moovEnd = ftypSize + head.readUInt32BE(ftypSize);
  if (moovEnd > total || moovEnd > 8 * 1024 * 1024) throw new Error("MP4 索引大小异常");
  if (moovEnd > head.length) head = Buffer.concat([head, (await remoteRange(head.length, moovEnd - 1)).data]);
  head = head.subarray(0, moovEnd);
  const prepared = source.key ? prepareCencHeader(head, source.key) : { header: head, samples: [] };

  const rangeHeader = request.headers.get("Range");
  let start = 0;
  let end = total - 1;
  if (rangeHeader) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
    if (!match || (!match[1] && !match[2]))
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${total}` } });
    start = match[1] ? Number(match[1]) : Math.max(0, total - Number(match[2]));
    end = match[1] && match[2] ? Math.min(Number(match[2]), total - 1) : total - 1;
    if (start > end || start >= total)
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${total}` } });
  }

  // 逐段拉取并解密后写入流，避免把整集读进内存。
  const CHUNK = 512 * 1024;
  let offset = start;
  const stream = new ReadableStream({
    async pull(controller) {
      if (offset > end) {
        controller.close();
        return;
      }
      try {
        const stop = Math.min(offset + CHUNK - 1, end);
        const raw = await remoteRange(offset, stop);
        const output = decryptPartial(raw.data, offset, source.key, prepared);
        offset = stop + 1;
        controller.enqueue(new Uint8Array(output));
      } catch (error) {
        controller.error(error);
      }
    },
  });

  const responseHeaders = {
    "Content-Type": "video/mp4",
    "Accept-Ranges": "bytes",
    "Content-Length": String(end - start + 1),
    "Cache-Control": "no-store",
  };
  if (rangeHeader) responseHeaders["Content-Range"] = `bytes ${start}-${end}/${total}`;
  return new Response(stream, { status: rangeHeader ? 206 : 200, headers: responseHeaders });
}

// ---------------------------------------------------------------- 路由

async function readJson(request) {
  const text = await request.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

async function handle(request, env) {
  ensureModules(env);
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (path === "/api/health")
    return json(200, {
      service: "xiaoguoguo",
      version: "0.1.0",
      apiVersion: 1,
      runtime: "cloudflare-worker",
      account: (await getAccountCookie(env)) ? "configured" : "anonymous",
      expiry: sessionExpiry(await getAccountCookie(env)),
      kv: Boolean(env.XGG_KV),
    });

  if (path === "/api/home") {
    const page = Number(url.searchParams.get("page") || 1);
    if (!Number.isInteger(page) || page < 1 || page > 100) return json(400, { error: "分页参数无效" });
    return json(200, await home(page));
  }

  if (path === "/api/search") {
    const keyword = (url.searchParams.get("q") || "").trim();
    const page = Number(url.searchParams.get("page") || 1);
    if (!keyword || keyword.length > 80) return json(400, { error: "请输入 1–80 字的关键词" });
    if (!Number.isInteger(page) || page < 1 || page > 100) return json(400, { error: "分页参数无效" });
    return json(200, await search(env, keyword, page));
  }

  const detailMatch = /^\/api\/series\/(\d{1,30})$/.exec(path);
  if (detailMatch) return json(200, await detail(detailMatch[1]));

  if (path === "/api/account" && method === "POST") {
    const body = await readJson(request);
    const cookie = String(body.cookie || "").trim();
    if (!cookie) {
      await setAccountCookie(env, "");
      return json(200, { ok: true, account: false });
    }
    const result = await verifyAccount(cookie);
    if (!result.ok) return json(400, { error: result.reason });
    await setAccountCookie(env, cookie);
    return json(200, { ok: true, account: true, profile: result.profile });
  }

  if (path === "/api/account/sms/send" && method === "POST") {
    const body = await readJson(request);
    const result = await sendLoginCode(body.mobile || "");
    return json(result.ok ? 200 : 400, result);
  }

  if (path === "/api/account/sms/login" && method === "POST") {
    const body = await readJson(request);
    const result = await loginWithCode(body);
    if (!result.ok) return json(400, result);
    const verified = await verifyAccount(result.cookie);
    if (!verified.ok) return json(400, { error: `登录成功但凭据校验失败：${verified.reason}` });
    await setAccountCookie(env, result.cookie);
    return json(200, { ok: true, profile: verified.profile, expiry: sessionExpiry(result.cookie) });
  }

  if (path === "/api/account/devices")
    return json(200, {
      ok: false,
      devices: [],
      error: "Worker 里没有 adb，无法从设备导出；请用手机号登录或粘贴 Cookie。",
    });

  if (path === "/api/account/qr" && method === "POST") {
    const session = createImportSession(url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80);
    const { default: QRCode } = await import("qrcode");
    const qr = await QRCode.toDataURL(session.url, {
      margin: 1,
      width: 320,
      color: { dark: "#0d0b10", light: "#ffffff" },
    });
    return json(200, { ...session, qr });
  }

  if (path.startsWith("/api/account/qr/") && method === "GET") {
    const token = path.split("/").pop();
    const session = getImportSession(token);
    return json(200, { valid: Boolean(session), expiresAt: session?.expiresAt ?? 0 });
  }

  const importMatch = /^\/import\/([a-f0-9]{32})$/.exec(path);
  if (path.startsWith("/import/") && !importMatch)
    return new Response(expiredPage(), { status: 404, headers: { "Content-Type": "text/html; charset=utf-8" } });
  if (importMatch) {
    const token = importMatch[1];
    if (!getImportSession(token))
      return new Response(expiredPage(), { status: 410, headers: { "Content-Type": "text/html; charset=utf-8" } });
    if (method === "GET")
      return new Response(importPage(token), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
    const body = await readJson(request);
    const result = await submitImport(token, body.cookie || "");
    return json(result.ok ? 200 : 400, result);
  }

  const playMatch = /^\/api\/episodes\/(\d{1,30})\/play$/.exec(path);
  if (playMatch) {
    const source = await resolvePlayback(env, playMatch[1]);
    return json(200, { path: `/api/episodes/${playMatch[1]}/stream`, quality: source.quality, kind: source.kind });
  }

  const streamMatch = /^\/api\/episodes\/(\d{1,30})\/stream$/.exec(path);
  if (streamMatch) return streamResponse(env, request, streamMatch[1]);

  if (path.startsWith("/api/")) return json(404, { error: "接口不存在" });

  return env.ASSETS ? env.ASSETS.fetch(request) : json(404, { error: "前端资源未绑定" });
}

export default {
  async fetch(request, env) {
    try {
      return await handle(request, env);
    } catch (error) {
      const message = error instanceof Error ? error.message : "服务异常";
      return json(502, { error: message || "内容源暂不可用，请稍后重试" });
    }
  },
};
