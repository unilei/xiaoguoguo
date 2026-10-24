// 决定性实验：同一份 vendor 源码，仅替换 Buffer/crypto 实现，定位 helios 分歧点。
import vm from "node:vm";
import fs from "node:fs";
import crypto from "node:crypto";
import { Buffer as MyBuffer } from "../lib/buffer.js";
import { md5Digest } from "../lib/md5.js";
import { sm3 } from "../lib/sm3.js";

const src = fs.readFileSync("../xiaoguoguo/server/src/vendor/hongguo.cjs", "utf8");

// 在关键位置插桩：words[0] 类型、第一块循环后的 a/b、table[0]
const instrumented = src
  .replace(
    `for (let i = 0; i < 4; i += 1) words.push(ascii.readBigUInt64LE(i * 8)); const table = [words[0]];`,
    `for (let i = 0; i < 4; i += 1) words.push(ascii.readBigUInt64LE(i * 8));
     globalThis.__dbg = {
       w0t: typeof words[0],
       w0c: words[0]?.constructor?.name,
       w0: String(words[0]).slice(0, 26),
       asc: ascii.subarray(0, 8).toString("hex"),
     };
     const table = [words[0]];`
  )
  .replace(
    `for (let i = 0; i < 34; i += 1) { b = BigInt.asUintN(64, table[i] ^ (a + ror64(b, 8))); a = BigInt.asUintN(64, b ^ ror64(a, 61)); } const block = Buffer.alloc(16);`,
    `for (let i = 0; i < 34; i += 1) { b = BigInt.asUintN(64, table[i] ^ (a + ror64(b, 8))); a = BigInt.asUintN(64, b ^ ror64(a, 61)); }
     if (at === 0) globalThis.__dbg.first = { a: a.toString(16), b: b.toString(16), t0: table[0].toString(16) };
     const block = Buffer.alloc(16);`
  );

const shimCrypto = {
  createHash(alg) {
    const isMd5 = alg === "md5";
    if (!isMd5 && alg !== "sm3") throw new Error("shim 不支持 " + alg);
    const pending = [];
    return {
      update(d) {
        pending.push(d);
        return this;
      },
      digest(enc) {
        const data = pending.length === 1 ? pending[0] : MyBuffer.concat(pending);
        const out = isMd5 ? md5Digest(data) : sm3(data);
        return enc === "hex" ? MyBuffer.from(out).toString("hex") : out;
      },
    };
  },
};

function run(bufferImpl, cryptoImpl) {
  const ctx = {
    crypto: cryptoImpl,
    Buffer: bufferImpl,
    Math,
    console,
    require: (m) => (m === "node:crypto" ? cryptoImpl : null),
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
  Math.random = () => 0.42;
  vm.runInContext(instrumented + "\nthis.__h = helios;", ctx);
  const out = ctx.__h(1712345678);
  return { out: out.slice(0, 16), dbg: ctx.__dbg };
}

const n = run(Buffer, crypto);
const s = run(MyBuffer, shimCrypto);
console.log("native words[0]:", n.dbg.w0t, n.dbg.w0c, n.dbg.w0, "asc:", n.dbg.asc);
console.log("shim   words[0]:", s.dbg.w0t, s.dbg.w0c, s.dbg.w0, "asc:", s.dbg.asc);
console.log("native first blk:", JSON.stringify(n.dbg.first));
console.log("shim   first blk:", JSON.stringify(s.dbg.first));
console.log("native out:", n.out);
console.log("shim   out:", s.out);
