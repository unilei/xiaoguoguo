// 把 server/src/vendor/hongguo.cjs 转成浏览器（扩展）可用的 ES 模块。
//
// 与 worker/build-vendor.mjs 同思路，但注入的是浏览器 shim：
//   - Buffer → extension/lib/buffer.js
//   - md5 → 纯 JS（签名链需要同步）
//   - sm3 → 纯 JS
//   - 其余 node:crypto 用法（AES/SHA512）只在解密路径，不在本模块——
//     扩展用自己的 cenc.js（WebCrypto 异步版），所以这里直接去掉。
import fs from "node:fs";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname);
const vendorPath = path.resolve(here, "../xiaoguoguo/server/src/vendor/hongguo.cjs");
const outPath = path.resolve(here, "lib/vendor-port.js");

const source = fs.readFileSync(vendorPath, "utf8");

const body = source
  // 去掉 node:crypto（md5/sm3 用注入的纯 JS 版本顶上）
  .replace(/^const crypto = require\('node:crypto'\);$/m, "")
  .replace(
    /function sm3\(value\) \{ return crypto\.createHash\('sm3'\)\.update\(value\)\.digest\(\); \}/,
    "function sm3(value) { return pureSm3(value); }"
  )
  // md5 全部走纯 JS（createHash('md5') 在本模块只出现在 md5()/签名链里）
  .replace(/function md5\(value\) \{ return crypto\.createHash\('md5'\)\.update\(value\)\.digest\('hex'\)\.toUpperCase\(\); \}/,
    "function md5(value) { return pureMd5(value).toUpperCase(); }")
  // deviceProto 等处直接用 crypto.createHash('md5') 的内联调用 → 走 digestBytes
  .replace(/crypto\.createHash\('md5'\)\.update\(([^)]+)\)\.digest\(\)/g, "pureMd5Digest($1)")
  .replace(/crypto\.createHash\('md5'\)\.update\(([^)]+)\)\.digest\('hex'\)/g, "pureMd5($1)");

const header = `// 由 extension/build-vendor.mjs 生成，请勿手改。
// 原文件：woshishiq1/drpys（GPL-3.0），见 server/src/vendor/NOTICE.md。
import { Buffer } from "./buffer.js";
import { sm3 as pureSm3 } from "./sm3.js";
import { md5Hex as pureMd5, md5Digest as pureMd5Digest } from "./md5.js";

const crypto = {
  // 只补签名链用到的部分；AES/SHA512 不在本模块（见 cenc.js）
  createHash: () => { throw new Error("vendor-port: 本模块不应使用 createHash（改用注入的纯 JS 实现）"); },
};
`;

const footer = `
// 只导出签名与常量；解密相关（prepareCencHeader/decryptPartial/deriveContentKey/
// decryptSpadeUrl）不在浏览器版里——扩展的 cenc.js 用 WebCrypto 异步重写了它们。
export {
  SITE, APP_SEARCH_API, VIDEO_UA, APP_UA, DEVICE, APP_DEVICE,
  categoryPage, routerData, pythonUrlEncode, ror64,
  xGorgon, helios, buildMedusa, be32, le32, branchOf,
  cleanUrl, str, getText,
};
`;

fs.writeFileSync(outPath, header + body + footer, "utf8");
console.log(`wrote ${path.relative(process.cwd(), outPath)}`);
