// 与运行时无关的 API 处理核心。
//
// 本地 Node 服务（server/src/index.mjs）和 Vercel Function（api/index.mjs）
// 都调用这里的 handleApi，只是把请求 / 响应适配成各自的形式。
// 这样两边的业务逻辑不会分叉。
import QRCode from "qrcode";
import {
  home,
  search,
  detail,
  resolvePlayback,
  createStreamReader,
  setAccountCookie,
  hasAccountCookie,
  accountCookieSnapshot,
  ensureIdentity,
  signedRequest,
  setRequestIdentity,
} from "./provider.mjs";
import { configureAccountModule, verifyAccount } from "./account.mjs";
import { importFromDevice, listDevices, sessionExpiry } from "./device-import.mjs";
import { configureSmsModule, loginWithCode, sendLoginCode } from "./sms-login.mjs";
import {
  configureImportSession,
  createImportSession,
  getImportSession,
  submitImport,
} from "./import-session.mjs";
import { expiredPage, importPage } from "./import-page.mjs";
import {
  IDENTITY_HEADER,
  decodeIdentity,
  encodeIdentity,
} from "./identity-header.mjs";

configureAccountModule({ ensureIdentity, signedRequest });
configureSmsModule({ ensureIdentity, signedRequest });
configureImportSession({ setAccountCookie });

export const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
};

export const HTML_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
};

export function jsonResponse(status, value) {
  return {
    status,
    headers: JSON_HEADERS,
    body: Buffer.from(JSON.stringify(value), "utf8"),
  };
}

export function htmlResponse(status, html) {
  return { status, headers: HTML_HEADERS, body: Buffer.from(html, "utf8") };
}

/** 解析 Range 头，返回 [start, end] 或 null（非法）。 */
export function parseRange(value, total) {
  if (!value) return [0, total - 1];
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) return null;
  const start = match[1] ? Number(match[1]) : Math.max(0, total - Number(match[2]));
  const end = match[1]
    ? match[2]
      ? Math.min(Number(match[2]), total - 1)
      : total - 1
    : total - 1;
  return Number.isSafeInteger(start) &&
    Number.isSafeInteger(end) &&
    start >= 0 &&
    start <= end &&
    start < total
    ? [start, end]
    : null;
}

function readBodyOf(body, limit = 16 * 1024) {
  if (!body) return "";
  if (Buffer.isBuffer(body)) return body.toString("utf8");
  if (typeof body === "string") return body;
  return JSON.stringify(body);
}

function parseJsonBody(raw) {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * 处理一次 API 请求。
 *
 * 返回：
 *   { status, headers, body }                    普通响应
 *   { status, headers, stream: AsyncIterable }   流式响应（视频）
 *   null                                         不是 API 路径，交给静态资源处理
 *
 * @param {{method:string, pathname:string, searchParams:URLSearchParams,
 *          headers:Record<string,string|undefined>, body?:Buffer|string,
 *          port?:number}} request
 */
export async function handleApi(request) {
  const { method, pathname, searchParams, headers } = request;
  const port = request.port || Number(process.env.PORT || 8788);
  const rawBody = readBodyOf(request.body);
  const bodyLimit = 64 * 1024;

  // 前端会把上一次拿到的设备身份带回来，保证发码 / 登录用同一台设备。
  setRequestIdentity(decodeIdentity(headers[IDENTITY_HEADER]));

  if (pathname === "/api/health") {
    return jsonResponse(200, {
      service: "xiaoguoguo",
      version: "0.1.0",
      apiVersion: 1,
      // Vercel 会注入 VERCEL=1，但不同版本/本地 vercel dev 可能缺失，
      // 因此再看几个只在该平台存在的环境变量。
      runtime:
        process.env.VERCEL ||
        process.env.VERCEL_ENV ||
        process.env.VERCEL_URL ||
        process.env.NOW_REGION
          ? "vercel"
          : "node",
      account: hasAccountCookie() ? "configured" : "anonymous",
      expiry: sessionExpiry(accountCookieSnapshot()),
    });
  }

  // 从已登录的 Android 设备 / 模拟器导出登录态。
  if (pathname === "/api/account/devices" && method === "GET") {
    try {
      return jsonResponse(200, { ok: true, devices: await listDevices() });
    } catch (error) {
      return jsonResponse(200, {
        ok: false,
        devices: [],
        error: error instanceof Error ? error.message : "adb 不可用",
      });
    }
  }

  if (pathname === "/api/account/device" && method === "POST") {
    if (rawBody.length > bodyLimit) return jsonResponse(413, { error: "请求体过大" });
    const serial = parseJsonBody(rawBody).serial || "";
    const imported = await importFromDevice(serial || undefined);
    const result = await verifyAccount(imported.cookie);
    if (!result.ok)
      return jsonResponse(400, {
        error: `导出成功但登录态无效：${result.reason}`,
        expiry: imported.expiry,
      });
    setAccountCookie(imported.cookie);
    return jsonResponse(200, {
      ok: true,
      serial: imported.serial,
      fields: imported.fields,
      expiry: imported.expiry,
      profile: result.profile,
    });
  }

  // 手机号 + 验证码登录。
  if (pathname === "/api/account/sms/send" && method === "POST") {
    const mobile = parseJsonBody(rawBody).mobile || "";
    const result = await sendLoginCode(mobile);
    // 把本次使用的设备身份交给前端保管，登录时原样带回。
    const response = jsonResponse(result.ok ? 200 : 400, result);
    const used = await ensureIdentity();
    response.headers = {
      ...response.headers,
      [IDENTITY_HEADER]: encodeIdentity(used),
    };
    return response;
  }

  if (pathname === "/api/account/sms/login" && method === "POST") {
    const payload = parseJsonBody(rawBody);
    const result = await loginWithCode(payload);
    if (!result.ok) return jsonResponse(400, result);
    const verified = await verifyAccount(result.cookie);
    if (!verified.ok)
      return jsonResponse(400, { error: `登录成功但凭据校验失败：${verified.reason}` });
    setAccountCookie(result.cookie);
    const response = jsonResponse(200, {
      ok: true,
      profile: verified.profile,
      expiry: sessionExpiry(result.cookie),
    });
    response.headers = {
      ...response.headers,
      [IDENTITY_HEADER]: encodeIdentity(await ensureIdentity()),
    };
    return response;
  }

  if (pathname === "/api/account" && method === "POST") {
    const parsed = parseJsonBody(rawBody);
    const cookie = String(parsed.cookie ?? rawBody).trim();
    if (!cookie) {
      setAccountCookie("");
      return jsonResponse(200, { ok: true, account: false });
    }
    const result = await verifyAccount(cookie);
    if (!result.ok) return jsonResponse(400, { error: result.reason });
    setAccountCookie(cookie);
    return jsonResponse(200, { ok: true, account: true, profile: result.profile });
  }

  // 扫码传输：生成一次性二维码。
  if (pathname === "/api/account/qr" && method === "POST") {
    const session = createImportSession(port);
    const qr = await QRCode.toDataURL(session.url, {
      margin: 1,
      width: 320,
      color: { dark: "#0d0b10", light: "#ffffff" },
    });
    return jsonResponse(200, { ...session, qr });
  }

  if (pathname.startsWith("/api/account/qr/") && method === "GET") {
    const token = pathname.split("/").pop();
    const session = getImportSession(token);
    return jsonResponse(200, { valid: Boolean(session), expiresAt: session?.expiresAt ?? 0 });
  }

  const importMatch = /^\/import\/([a-f0-9]{32})$/.exec(pathname);
  if (pathname.startsWith("/import/") && !importMatch) return htmlResponse(404, expiredPage());
  if (importMatch) {
    const token = importMatch[1];
    if (!getImportSession(token)) return htmlResponse(410, expiredPage());
    if (method === "GET") return htmlResponse(200, importPage(token));
    if (rawBody.length > bodyLimit) return jsonResponse(413, { error: "请求体过大" });
    const cookie = String(parseJsonBody(rawBody).cookie ?? rawBody);
    const result = await submitImport(token, cookie);
    return jsonResponse(result.ok ? 200 : 400, result);
  }

  if (pathname === "/api/home") {
    const page = Number(searchParams.get("page") || 1);
    if (!Number.isInteger(page) || page < 1 || page > 100)
      return jsonResponse(400, { error: "分页参数无效" });
    return jsonResponse(200, await home(page));
  }

  if (pathname === "/api/search") {
    const keyword = (searchParams.get("q") || "").trim();
    const page = Number(searchParams.get("page") || 1);
    if (!keyword || keyword.length > 80)
      return jsonResponse(400, { error: "请输入 1–80 字的关键词" });
    if (!Number.isInteger(page) || page < 1 || page > 100)
      return jsonResponse(400, { error: "分页参数无效" });
    return jsonResponse(200, await search(keyword, page));
  }

  const detailMatch = /^\/api\/series\/(\d{1,30})$/.exec(pathname);
  if (detailMatch) return jsonResponse(200, await detail(detailMatch[1]));

  const playMatch = /^\/api\/episodes\/(\d{1,30})\/play$/.exec(pathname);
  if (playMatch) {
    const source = await resolvePlayback(playMatch[1]);
    return jsonResponse(200, {
      path: `/api/episodes/${playMatch[1]}/stream`,
      quality: source.quality,
      kind: source.kind,
    });
  }

  const streamMatch = /^\/api\/episodes\/(\d{1,30})\/stream$/.exec(pathname);
  if (streamMatch) return streamPayload(streamMatch[1], headers.range, method === "HEAD");

  if (pathname.startsWith("/api/")) return jsonResponse(404, { error: "接口不存在" });

  return null;
}

/** 视频流：先建 CENC 索引，再按 Range 逐块产出。 */
export async function streamPayload(id, rangeHeader, headOnly = false) {
  const source = await resolvePlayback(id);
  const reader = createStreamReader(source);
  const prepared = await reader.prepare();
  const total = prepared.total;
  const range = parseRange(rangeHeader, total);
  if (!range)
    return {
      status: 416,
      headers: { "Content-Range": `bytes */${total}` },
      body: Buffer.alloc(0),
    };
  const [start, end] = range;
  const responseHeaders = {
    "Content-Type": "video/mp4",
    "Accept-Ranges": "bytes",
    "Content-Length": String(end - start + 1),
    "Cache-Control": "no-store",
  };
  if (rangeHeader) responseHeaders["Content-Range"] = `bytes ${start}-${end}/${total}`;
  if (headOnly) return { status: 200, headers: responseHeaders, body: Buffer.alloc(0) };

  const CHUNK = 1024 * 1024;
  async function* chunks() {
    for (let offset = start; offset <= end; offset += CHUNK) {
      const { data } = await reader.read(offset, Math.min(CHUNK, end - offset + 1));
      yield data;
    }
  }
  return {
    status: rangeHeader ? 206 : 200,
    headers: responseHeaders,
    stream: chunks(),
  };
}
