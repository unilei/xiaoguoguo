import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  home,
  search,
  detail,
  resolvePlayback,
  createStreamReader,
  setAccountCookie,
  hasAccountCookie,
} from "./provider.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, "../../web/dist");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function sendJson(res, status, value) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(value));
}

function readBody(req, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function parseRange(value, total) {
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

async function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";
  const target = path.join(webRoot, pathname);
  if (!target.startsWith(webRoot)) return sendJson(res, 403, { error: "禁止访问" });
  try {
    const stat = await fs.promises.stat(target);
    if (!stat.isFile()) throw new Error("not a file");
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(target)] || "application/octet-stream",
      "Content-Length": stat.size,
      "Cache-Control": pathname.startsWith("/assets/")
        ? "public, max-age=31536000, immutable"
        : "no-cache",
    });
    fs.createReadStream(target).pipe(res);
    return true;
  } catch {
    // SPA 回退：未知路径交给前端路由。
    try {
      const index = path.join(webRoot, "index.html");
      const body = await fs.promises.readFile(index);
      res.writeHead(200, {
        "Content-Type": MIME[".html"],
        "Content-Length": body.length,
        "Cache-Control": "no-cache",
      });
      res.end(body);
      return true;
    } catch {
      return false;
    }
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  const method = req.method || "GET";
  if (!["GET", "HEAD", "POST"].includes(method))
    return sendJson(res, 405, { error: "Method not allowed" });

  try {
    if (url.pathname === "/api/health") {
      return sendJson(res, 200, {
        service: "xiaoguoguo",
        version: "0.1.0",
        apiVersion: 1,
        account: hasAccountCookie() ? "configured" : "anonymous",
      });
    }

    if (url.pathname === "/api/account" && method === "POST") {
      const body = await readBody(req);
      let cookie = "";
      try {
        cookie = JSON.parse(body).cookie || "";
      } catch {
        cookie = body;
      }
      setAccountCookie(cookie);
      return sendJson(res, 200, { ok: true, account: hasAccountCookie() });
    }

    if (url.pathname === "/api/home") {
      const page = Number(url.searchParams.get("page") || 1);
      if (!Number.isInteger(page) || page < 1 || page > 100)
        return sendJson(res, 400, { error: "分页参数无效" });
      return sendJson(res, 200, await home(page));
    }

    if (url.pathname === "/api/search") {
      const keyword = (url.searchParams.get("q") || "").trim();
      const page = Number(url.searchParams.get("page") || 1);
      if (!keyword || keyword.length > 80)
        return sendJson(res, 400, { error: "请输入 1–80 字的关键词" });
      if (!Number.isInteger(page) || page < 1 || page > 100)
        return sendJson(res, 400, { error: "分页参数无效" });
      return sendJson(res, 200, await search(keyword, page));
    }

    const detailMatch = /^\/api\/series\/(\d{1,30})$/.exec(url.pathname);
    if (detailMatch) return sendJson(res, 200, await detail(detailMatch[1]));

    const playMatch = /^\/api\/episodes\/(\d{1,30})\/play$/.exec(url.pathname);
    if (playMatch) {
      const source = await resolvePlayback(playMatch[1]);
      return sendJson(res, 200, {
        path: `/api/episodes/${playMatch[1]}/stream`,
        quality: source.quality,
        kind: source.kind,
      });
    }

    const streamMatch = /^\/api\/episodes\/(\d{1,30})\/stream$/.exec(url.pathname);
    if (streamMatch) {
      const source = await resolvePlayback(streamMatch[1]);
      const reader = createStreamReader(source);
      const prepared = await reader.prepare();
      const total = prepared.total;
      const range = parseRange(req.headers.range, total);
      if (!range) {
        res.writeHead(416, { "Content-Range": `bytes */${total}` });
        return res.end();
      }
      const [start, end] = range;
      const headers = {
        "Content-Type": "video/mp4",
        "Accept-Ranges": "bytes",
        "Content-Length": end - start + 1,
        "Cache-Control": "no-store",
      };
      if (req.headers.range) headers["Content-Range"] = `bytes ${start}-${end}/${total}`;
      res.writeHead(req.headers.range ? 206 : 200, headers);
      if (method === "HEAD") return res.end();
      const chunkSize = 1024 * 1024;
      for (let offset = start; offset <= end && !res.destroyed; offset += chunkSize) {
        const { data } = await reader.read(offset, Math.min(chunkSize, end - offset + 1));
        if (res.destroyed) break;
        if (!res.write(data)) {
          await new Promise((resolve) => {
            const done = () => {
              res.off("drain", done);
              res.off("close", done);
              resolve();
            };
            res.once("drain", done);
            res.once("close", done);
          });
        }
      }
      return res.end();
    }

    if (url.pathname.startsWith("/api/")) return sendJson(res, 404, { error: "接口不存在" });

    if (await serveStatic(req, res, url)) return;
    return sendJson(res, 404, {
      error: "前端尚未构建：请先运行 npm run build（见 README）",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "服务异常";
    // 不把上游地址或签名材料回显给客户端。
    console.error(JSON.stringify({ event: "request_failed", path: url.pathname, message }));
    if (res.headersSent) res.destroy();
    else sendJson(res, 502, { error: message || "内容源暂不可用，请稍后重试" });
  }
});

const port = Number(process.env.PORT || 8788);
const host = process.env.HOST || "127.0.0.1";
server.listen(port, host, () => {
  console.log(`小果果内容服务：http://${host}:${port}`);
  if (host === "0.0.0.0") console.log("局域网访问已开启，请只在可信网络使用。");
});
