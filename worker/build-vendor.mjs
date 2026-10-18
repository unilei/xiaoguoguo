// 把 server/src/vendor/hongguo.cjs 转成 Workers 可打包的 ES 模块。
//
// Workers 禁止运行时 eval / new Function / node:vm，而 vendor 原本靠 vm 加载，
// 所以这里做静态转换：去掉 require('node:crypto')，改用注入的 crypto，
// 并把内部对 sm3 的调用换成纯 JS 实现（Workers 的 node:crypto 没有 sm3）。
import fs from "node:fs";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname);
const vendorPath = path.resolve(here, "../server/src/vendor/hongguo.cjs");
const outPath = path.resolve(here, "vendor-worker.js");

const source = fs.readFileSync(vendorPath, "utf8");

const body = source
  // 去掉对 node:crypto 的 require；Worker 入口会提供同名 crypto 变量。
  .replace(/^const crypto = require\('node:crypto'\);$/m, "")
  // Workers 的 node:crypto 不支持 sm3，换成随包携带的纯 JS 实现。
  .replace(
    /function sm3\(value\) \{ return crypto\.createHash\('sm3'\)\.update\(value\)\.digest\(\); \}/,
    "function sm3(value) { return pureSm3(value); }"
  );

const header = `// 由 build-vendor.mjs 从 server/src/vendor/hongguo.cjs 生成，请勿手改。
// 原文件：woshishiq1/drpys（GPL-3.0），见 server/src/vendor/NOTICE.md。
import { sm3 as pureSm3 } from "../server/src/sm3.mjs";

// vendor 原先把 axios 当作沙箱注入的全局；Workers 里用 fetch 实现同样的调用形态。
const axios = async (url, options = {}) => {
  const method = options.method || (options.data || options.body ? "POST" : "GET");
  let body = options.body;
  if (body === undefined && options.data !== undefined) {
    body =
      typeof options.data === "string" || ArrayBuffer.isView(options.data)
        ? options.data
        : JSON.stringify(options.data);
  }
  const response = await fetch(url, {
    method,
    headers: options.headers || {},
    body,
    signal: AbortSignal.timeout(options.timeout || 20000),
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  const headers = {};
  response.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  const data =
    options.responseType === "arraybuffer" ? buffer : buffer.toString("utf8");
  return { status: response.status, headers, data };
};
axios.post = (url, body, options = {}) =>
  axios(url, { ...options, method: "POST", body });
axios.get = (url, options = {}) => axios(url, { ...options, method: "GET" });
axios.create = () => axios;

`;

const footer = `
export {
  SITE, VIDEO_API, APP_SEARCH_API, VIDEO_UA, APP_UA, DEVICE, APP_DEVICE,
  categoryPage, categoryData, itemToCard, appSearchPage, appSearchCells, appSearchVod,
  routerData, pythonUrlEncode, xGorgon, helios, buildMedusa, be32, le32, branchOf,
  cleanUrl, str, qualityRows, qualityNumber, qualityLabel, deriveContentKey,
  decryptSpadeUrl, prepareCencHeader, decryptPartial, getText,
};
`;

fs.writeFileSync(outPath, header + body + footer, "utf8");
console.log(`wrote ${path.relative(process.cwd(), outPath)}`);
