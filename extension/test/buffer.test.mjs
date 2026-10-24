// Buffer polyfill 字节级对照测试：同一输入下，与 Node 原生 Buffer 输出必须完全一致。
import nodeBuffer from "node:buffer";
import { Buffer } from "../lib/buffer.js";

const Native = nodeBuffer.Buffer;
let pass = 0;
let fail = 0;

function check(name, actual, expected) {
  const a = typeof actual === "string" ? actual : String(actual);
  const e = typeof expected === "string" ? expected : String(expected);
  if (a === e) {
    pass += 1;
  } else {
    fail += 1;
    console.error(`✗ ${name}\n  polyfill: ${a.slice(0, 120)}\n  native:   ${e.slice(0, 120)}`);
  }
}

// ---- from + toString 往返 ----
const utf8Sample = "你好abc123ẖ🎉";
check("from+toString utf8", Buffer.from(utf8Sample).toString(), Native.from(utf8Sample).toString());
check("from+toString ascii", Buffer.from("hello world", "ascii").toString("ascii"), Native.from("hello world", "ascii").toString("ascii"));
{
  // hex / base64 用合法字符串测往返
  const hexStr = "00ff10a3bcdeadbeef42";
  check("from+toString hex", Buffer.from(hexStr, "hex").toString("hex"), Native.from(hexStr, "hex").toString("hex"));
  const b64Str = "SGVsbG8g5L2g5aW9IPCBlA==";
  check("from+toString base64", Buffer.from(b64Str, "base64").toString("base64"), Native.from(b64Str, "base64").toString("base64"));
}
check("from(array)", Buffer.from([1, 2, 255, 0]).toString("hex"), Native.from([1, 2, 255, 0]).toString("hex"));

// ---- 随机字节往返 ----
for (let round = 0; round < 20; round += 1) {
  const len = Math.floor(Math.random() * 300) + 1;
  const raw = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) raw[i] = Math.floor(Math.random() * 256);
  const mine = Buffer.from(raw);
  const native = Native.from(raw);
  check(`random hex r${round}`, mine.toString("hex"), native.toString("hex"));
  check(`random b64 r${round}`, mine.toString("base64"), native.toString("base64"));
  // from base64 回环
  const b64 = native.toString("base64");
  check(`b64 roundtrip r${round}`, Buffer.from(b64, "base64").toString("hex"), Native.from(b64, "base64").toString("hex"));
}

// ---- 整数读写 ----
{
  const mine = Buffer.alloc(32);
  const native = Native.alloc(32);
  mine.writeUInt32BE(0xdeadbeef, 0);
  native.writeUInt32BE(0xdeadbeef, 0);
  mine.writeUInt32LE(0xcafebabe, 4);
  native.writeUInt32LE(0xcafebabe, 4);
  mine.writeBigUInt64BE(0x0102030405060708n, 8);
  native.writeBigUInt64BE(0x0102030405060708n, 8);
  check("int write", mine.toString("hex"), native.toString("hex"));
  check("readUInt32BE", mine.readUInt32BE(0), native.readUInt32BE(0));
  check("readUInt32LE", mine.readUInt32LE(4), native.readUInt32LE(4));
  check("readBigUInt64BE", mine.readBigUInt64BE(8), native.readBigUInt64BE(8));
  check("readUInt16BE", mine.readUInt16BE(0), native.readUInt16BE(0));
}

// ---- concat / subarray / fill / copy / indexOf / reverse ----
{
  const a = Buffer.from("00112233", "hex");
  const b = Buffer.from("aabb", "hex");
  const na = Native.from("00112233", "hex");
  const nb = Native.from("aabb", "hex");
  check("concat", Buffer.concat([a, b]).toString("hex"), Native.concat([na, nb]).toString("hex"));
  check("subarray", a.subarray(1, 3).toString("hex"), na.subarray(1, 3).toString("hex"));
  // subarray 后再写回原 buffer（共享内存语义）
  const shared = Buffer.from("00000000", "hex");
  const nshared = Native.from("00000000", "hex");
  shared.subarray(1, 3).fill(0xff);
  nshared.subarray(1, 3).fill(0xff);
  check("subarray shares memory", shared.toString("hex"), nshared.toString("hex"));

  const c = Buffer.alloc(8, 0x41);
  const nc = Native.alloc(8, 0x41);
  check("alloc fill", c.toString("hex"), nc.toString("hex"));

  const dst = Buffer.alloc(4);
  const ndst = Native.alloc(4);
  a.copy(dst, 0, 0, 4);
  na.copy(ndst, 0, 0, 4);
  check("copy", dst.toString("hex"), ndst.toString("hex"));

  check("indexOf", c.indexOf(Buffer.from([0x41])), nc.indexOf(Native.from([0x41])));

  const r = Buffer.from("010203", "hex");
  const nr = Native.from("010203", "hex");
  check("reverse", r.reverse().toString("hex"), nr.reverse().toString("hex"));

  // write ascii
  const w = Buffer.alloc(12);
  const nw = Native.alloc(12);
  w.write("hello", 0, "ascii");
  nw.write("hello", 0, "ascii");
  check("write ascii", w.toString("hex"), nw.toString("hex"));
}

// ---- byteLength ----
check("byteLength utf8", Buffer.byteLength("你好"), Native.byteLength("你好"));

console.log(`\nBuffer polyfill: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
