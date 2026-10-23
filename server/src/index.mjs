// 本地 / 自托管用的 Node HTTP 服务。
// 业务逻辑在 api.mjs，这里只做 HTTP 适配和静态资源。
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handleApi, corsHeaders, withCors } from "./api.mjs";
import { restoreAccountCookie } from "./provider.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, "../../web/dist");

// 账号 Cookie 与设备身份默认落在服务目录下的 .data/，重启后自动恢复。
// 设备身份必须稳定：平台把发码凭证绑在 device_id 上，换了设备会让凭证立刻失效。
// 部署在无状态平台时改用环境变量 ACCOUNT_COOKIE 注入登录态。
if (!process.env.ACCOUNT_COOKIE_FILE) {
  process.env.ACCOUNT_COOKIE_FILE = path.resolve(here, "../.data/account-cookie");
}
if (!process.env.DEVICE_IDENTITY_FILE) {
  process.env.DEVICE_IDENTITY_FILE = path.resolve(here, "../.data/device.json");
}
const restored = restoreAccountCookie();

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

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error("请求体过大"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function serveStatic(res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";
  const target = path.join(webRoot, pathname);
  if (!target.startsWith(webRoot)) {
    res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "禁止访问" }));
    return true;
  }
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

const port = Number(process.env.PORT || 8788);
const host = process.env.HOST || "127.0.0.1";

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const method = req.method || "GET";
  const origin = req.headers.origin;
  if (!["GET", "HEAD", "POST", "OPTIONS"].includes(method)) {
    res.writeHead(405, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({ error: "Method not allowed" }));
  }

  // 预检：复刻站带 Range 拉流 / 带 JSON 体登录时会先发 OPTIONS。
  if (method === "OPTIONS") {
    res.writeHead(204, corsHeaders(origin));
    return res.end();
  }

  try {
    let body;
    if (method === "POST") body = await readBody(req, 64 * 1024);
    const result = await handleApi({
      method,
      pathname: url.pathname,
      searchParams: url.searchParams,
      headers: {
        range: req.headers.range,
        "x-xgg-device": req.headers["x-xgg-device"],
      },
      body,
      port,
    });

    if (result) {
      const withOrigin = withCors(result, origin);
      res.writeHead(withOrigin.status, withOrigin.headers);
      if (result.stream) {
        if (method === "HEAD") return res.end();
        for await (const chunk of result.stream) {
          if (res.destroyed) break;
          if (!res.write(chunk)) {
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
      return res.end(result.body);
    }

    if (await serveStatic(res, url)) return;
    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "前端尚未构建：请先运行 npm run build（见 README）" }));
  } catch (error) {
    const message = error instanceof Error ? error.message : "服务异常";
    console.error(JSON.stringify({ event: "request_failed", path: url.pathname, message }));
    if (res.headersSent) return res.destroy();
    res.writeHead(error?.status === 413 ? 413 : 502, {
      "Content-Type": "application/json; charset=utf-8",
    });
    res.end(
      JSON.stringify({
        error: error?.status === 413 ? "请求体过大" : message || "内容源暂不可用，请稍后重试",
      })
    );
  }
});

server.listen(port, host, () => {
  console.log(`小果果内容服务：http://${host}:${port}`);
  console.log(
    restored
      ? "已恢复上次保存的账号登录态，完整剧集可播。"
      : "当前是匿名模式：可播放完整剧集，登录只用于同步收藏/历史。"
  );
  if (host === "0.0.0.0") console.log("局域网访问已开启，请只在可信网络使用。");
  else console.log("当前仅监听本机。要用手机扫码导入 Cookie，请用 HOST=0.0.0.0 启动。");
});
