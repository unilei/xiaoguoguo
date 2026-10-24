// 原码 + shim Buffer/crypto 跑 xGorgon，验证是 shim 问题还是 build 转换问题
import vm from "node:vm";
import fs from "node:fs";
import crypto from "node:crypto";
import { Buffer as MyBuffer } from "../lib/buffer.js";
import { md5Digest } from "../lib/md5.js";
import { sm3 } from "../lib/sm3.js";

const src = fs.readFileSync("../xiaoguoguo/server/src/vendor/hongguo.cjs", "utf8");
const shimCrypto = {
  createHash(alg) {
    const isMd5 = alg === "md5";
    if (!isMd5 && alg !== "sm3") throw new Error("shim: " + alg);
    const pending = [];
    return {
      update(d) { pending.push(d); return this; },
      digest(enc) {
        const data = pending.length === 1 ? pending[0] : MyBuffer.concat(pending);
        const out = isMd5 ? md5Digest(data) : sm3(data);
        return enc === "hex" ? out.toString("hex") : out;
      },
    };
  },
};

function run(bufferImpl, cryptoImpl) {
  const ctx = { crypto: cryptoImpl, Buffer: bufferImpl, Math, console, require: (m) => (m === "node:crypto" ? cryptoImpl : null), module: { exports: {} }, exports: {}, process, URL, TextDecoder, TextEncoder, setTimeout, clearTimeout };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(src + "; this.__g = xGorgon;", ctx);
  return ctx.__g("a=1", null, 1712345678, 12345);
}

console.log("native :", run(Buffer, crypto));
console.log("shim   :", run(MyBuffer, shimCrypto));
