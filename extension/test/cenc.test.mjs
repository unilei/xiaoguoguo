// CENC 解密链对照测试：
//   1. prepareCencHeader / deriveContentKey（同步部分）与 vendor 逐字节对比
//   2. decryptRange（WebCrypto 异步）与 vendor 的 decryptPartial 逐字节对比
// 用真实加密视频（Node 服务解析出的那一集）做测试数据。
import vm from "node:vm";
import fs from "node:fs";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { Buffer as B } from "../lib/buffer.js";
import {
  prepareCencHeader,
  deriveContentKeySync,
  decryptRange,
} from "../lib/cenc.js";

let pass = 0;
let fail = 0;
function check(name, a, b) {
  if (a === b) pass += 1;
  else {
    fail += 1;
    console.error(`✗ ${name}\n  mine:   ${String(a).slice(0, 90)}\n  vendor: ${String(b).slice(0, 90)}`);
  }
}

// 加载 vendor（原生 node:crypto）
const src = fs.readFileSync(
  new URL("../../xiaoguoguo/server/src/vendor/hongguo.cjs", import.meta.url),
  "utf8"
);
const ctx = {
  crypto,
  Buffer,
  console,
  require: (m) => (m === "node:crypto" ? crypto : null),
  module: { exports: {} },
  exports: {},
  process,
  URL,
  TextDecoder,
  TextEncoder,
  setTimeout,
  clearTimeout,
};
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(
  src + "\nthis.v = { prepareCencHeader, decryptPartial, deriveContentKey, decryptSpadeUrl };",
  ctx
);
const v = ctx.v;

// ---- 测试数据：从 Node 服务拿真实加密视频 ----
const play = await fetch("http://127.0.0.1:8788/api/episodes/7697838648548396094/play").then(
  (r) => r.json()
);
if (play.error) throw new Error("Node 服务未运行或播放解析失败：" + play.error);
console.log("测试集 quality:", play.quality, "kind:", play.kind);

// 拿播放源真实 URL + key（provider 内部逻辑：从 appStream）
const provider = await import("../../xiaoguoguo/server/src/provider.mjs");
const detail = await provider.resolvePlayback("7697838648548396094");
console.log("源 URL host:", new URL(detail.url).host, "key:", detail.key ? "有" : "无");

// 拉视频头（moov 通常在前面 1MB 内）
const headRes = await fetch(detail.url, {
  headers: { Range: "bytes=0-1048575", "User-Agent": "Mozilla/5.0" },
});
const headRaw = Buffer.from(await headRes.arrayBuffer());
console.log("头部样本:", headRaw.length, "bytes");

// ftyp+moov 裁剪
const ftypSize = headRaw.readUInt32BE(0);
const moovSize = headRaw.readUInt32BE(ftypSize);
const moovEnd = ftypSize + moovSize;
console.log("moov 结束:", moovEnd, "（在样本内:", moovEnd <= headRaw.length, "）");
const moovData = headRaw.subarray(0, moovEnd);

// ---- 1. deriveContentKey 对照 ----
// provider 的 key 就是 deriveContentKey(spade_a) 的结果，直接和我的同步版比
const spadeA = detail.__spadeA || null;
if (spadeA) {
  const mineKey = deriveContentKeySync(spadeA).toString("hex");
  const vendorKey = v.deriveContentKey(spadeA).toString("hex");
  check("deriveContentKey", mineKey, vendorKey);
} else {
  // 没拿到 spade_a 就从 key 反推不了；用假数据测算法一致性
  const fake = Buffer.alloc(64, 7).toString("base64");
  check(
    "deriveContentKey(fake)",
    deriveContentKeySync(fake).toString("hex"),
    v.deriveContentKey(fake).toString("hex")
  );
}

// ---- 2. prepareCencHeader 对照 ----
const vendorPrepared = v.prepareCencHeader(Buffer.from(moovData), detail.key);
const myPrepared = prepareCencHeader(B.from(moovData), Boolean(detail.key));
check("header 长度", myPrepared.header.length, vendorPrepared.header.length);
check("header hex", myPrepared.header.toString("hex"), vendorPrepared.header.toString("hex"));
check("samples 数量", myPrepared.samples.length, vendorPrepared.samples.length);
if (myPrepared.samples.length === vendorPrepared.samples.length && myPrepared.samples.length) {
  let allSame = true;
  for (let i = 0; i < myPrepared.samples.length; i += 1) {
    const a = myPrepared.samples[i];
    const b2 = vendorPrepared.samples[i];
    if (a.start !== b2.start || a.end !== b2.end) { allSame = false; console.error(`  sample[${i}] 边界不一致`); break; }
    if (Buffer.from(a.iv).toString("hex") !== b2.iv.toString("hex")) { allSame = false; console.error(`  sample[${i}] iv 不一致`); break; }
  }
  check("samples 边界+IV 全量", allSame, true);
}

// ---- 3. decryptRange 对照（首段含 header 覆盖 + CENC 解密）----
if (detail.key) {
  const rangeSize = 262144; // 256KB
  const segRes = await fetch(detail.url, {
    headers: { Range: `bytes=0-${rangeSize - 1}`, "User-Agent": "Mozilla/5.0" },
  });
  const segRaw = Buffer.from(await segRes.arrayBuffer());

  const vendorOut = v.decryptPartial(Buffer.from(segRaw), 0, detail.key, vendorPrepared);
  const myOut = await decryptRange(B.from(segRaw), 0, detail.key, myPrepared);
  check("decryptRange(0..256K) 长度", myOut.length, vendorOut.length);
  check("decryptRange(0..256K) hex", myOut.toString("hex"), vendorOut.toString("hex"));

  // 中段（不含 header，纯 CENC）
  const midStart = 2 * 1024 * 1024;
  const midRes = await fetch(detail.url, {
    headers: { Range: `${midStart}-${midStart + rangeSize - 1}`, "User-Agent": "Mozilla/5.0" },
  });
  const midRaw = Buffer.from(await midRes.arrayBuffer());
  const vendorMid = v.decryptPartial(Buffer.from(midRaw), midStart, detail.key, vendorPrepared);
  const myMid = await decryptRange(B.from(midRaw), midStart, detail.key, myPrepared);
  check(`decryptRange(${midStart}..+256K)`, myMid.toString("hex"), vendorMid.toString("hex"));
}

console.log(`\nCENC 对照: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
