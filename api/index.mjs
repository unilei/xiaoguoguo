// Vercel Serverless Function 入口。
//
// 使用 Vercel 的 Node.js 运行时（完整 Node，含 node:crypto 的 sm3、node:vm 等），
// 因此可以直接复用 server/src 下的实现，不需要像 Workers 那样改造。
import { handleApi } from "../server/src/api.mjs";
import { restoreAccountCookie } from "../server/src/provider.mjs";

// 函数实例没有共享磁盘，登录态只能靠环境变量 ACCOUNT_COOKIE 注入。
// 未设置时是无副作用的空操作，所以无条件下调用一次即可。
restoreAccountCookie();

export const config = {
  // 视频流按 1MB 分块产出，60s 足够走完；Vercel 对匿名/临时部署的上限也是 60s。
  maxDuration: 60,
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 64 * 1024) {
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

export default async function handler(req, res) {
  const url = new URL(req.url || "/", `https://${req.headers.host || "localhost"}`);
  const method = (req.method || "GET").toUpperCase();

  if (!["GET", "HEAD", "POST"].includes(method)) {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const body = method === "POST" ? await readBody(req) : undefined;
    const result = await handleApi({
      method,
      pathname: url.pathname,
      searchParams: url.searchParams,
      headers: {
        range: req.headers.range,
        "x-xgg-device": req.headers["x-xgg-device"],
      },
      body,
      port: url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80,
    });

    if (!result) {
      res.status(404).json({ error: "接口不存在" });
      return;
    }

    res.status(result.status);
    for (const [name, value] of Object.entries(result.headers || {}))
      res.setHeader(name, value);

    if (result.stream) {
      if (method === "HEAD") {
        res.end();
        return;
      }
      for await (const chunk of result.stream) {
        if (res.writableEnded) break;
        if (!res.write(chunk)) {
          await new Promise((resolve) => res.once("drain", resolve));
        }
      }
      res.end();
      return;
    }

    res.end(result.body);
  } catch (error) {
    const message = error instanceof Error ? error.message : "服务异常";
    console.error(
      JSON.stringify({ event: "request_failed", path: url.pathname, message })
    );
    if (res.headersSent) {
      res.end();
      return;
    }
    const status = error?.status === 413 ? 413 : 502;
    res.status(status).json({
      error: status === 413 ? "请求体过大" : message || "内容源暂不可用，请稍后重试",
    });
  }
}
