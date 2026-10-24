import vm from "node:vm";
import fs from "node:fs";
import crypto from "node:crypto";
import { Buffer as B } from "../lib/buffer.js";

const src = fs.readFileSync("../xiaoguoguo/server/src/vendor/hongguo.cjs", "utf8");
const ctx = { crypto, Math, Buffer, console, require: (m) => (m === "node:crypto" ? crypto : null), module: {}, exports: {}, process, URL, TextDecoder, TextEncoder, setTimeout, clearTimeout };
ctx.globalThis = ctx;
vm.createContext(ctx);
Math.random = () => 0.42;

const r = vm.runInContext(src + `
(function() {
  const random = Math.floor(Math.random() * 0x100000000);
  const data = Buffer.concat([le32(random), Buffer.from('8662')]);
  const digest = crypto.createHash('md5').update(data).digest();
  const ascii = Buffer.from(digest.toString('hex'), 'ascii');
  const words = [];
  for (let i = 0; i < 4; i += 1) words.push(ascii.readBigUInt64LE(i * 8));
  return { random, words: words.map(String), helios: helios(1712345678) };
})()`, ctx);
console.log("native words:", r.words);
console.log("native helios:", r.helios.slice(0, 30));

// port 版同样计算
const { helios, le32 } = await import("../lib/vendor-port.js");
const ascii2 = B.from(r.words, "unused"); // placeholder
// 重算 port 的 words
const random2 = Math.floor(0.42 * 0x100000000);
const data2 = B.concat([B.from(le32(random2)), B.from("8662")]);
const { md5Digest } = await import("../lib/md5.js");
const digest2 = md5Digest(data2);
const asciiP = B.from(B.from(digest2).toString("hex"), "ascii");
const wordsP = [];
for (let i = 0; i < 4; i += 1) wordsP.push(asciiP.readBigUInt64LE(i * 8));
console.log("port words:  ", wordsP.map(String));
console.log("words equal: ", JSON.stringify(wordsP.map(String)) === JSON.stringify(r.words));
console.log("port helios: ", helios(1712345678).slice(0, 30));
