// vendor-port（浏览器 shim）与原生 vendor（node:crypto）的签名输出对照。
//
// 签名是确定性函数（给定 url/body/时间戳），两边必须逐字节一致。
import vm from "node:vm";
import fs from "node:fs";
import crypto from "node:crypto";
import {
  xGorgon,
  helios,
  buildMedusa,
  branchOf,
  be32,
  le32,
  pythonUrlEncode,
  cleanUrl,
  str,
  DEVICE,
  APP_DEVICE,
} from "../lib/vendor-port.js";

// 用 node 环境加载原生 vendor
const src = fs.readFileSync(
  new URL("../../xiaoguoguo/server/src/vendor/hongguo.cjs", import.meta.url),
  "utf8"
);
const ctx = {
  crypto,
  Math,
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
  src +
    "\nthis.native = { xGorgon, helios, buildMedusa, branchOf, be32, le32, pythonUrlEncode, cleanUrl, str, DEVICE, APP_DEVICE };",
  ctx
);
const native = ctx.native;
// helios / buildMedusa 内部用 Math.random()，先固定住才能对照
Math.random = () => 0.42;

let pass = 0;
let fail = 0;
function check(name, a, b) {
  if (a === b) pass += 1;
  else {
    fail += 1;
    console.error(`✗ ${name}\n  port:   ${String(a).slice(0, 100)}\n  native: ${String(b).slice(0, 100)}`);
  }
}

const { Buffer: B } = await import("../lib/buffer.js");

// 固定输入跑签名链
const samples = [
  "device_id=123&iid=456&query=%E4%BD%A0%E5%A5%BD&ts=1712345678&_rticket=1712345678123",
  "ac=wifi&aid=8662&app_name=novelread&count=20&offset=0&tab_type=11&ts=1712345678&_rticket=1712345678999",
  "a=1",
  "",
];

for (let i = 0; i < samples.length; i += 1) {
  const q = samples[i];
  const body = i % 2 === 0 ? B.from(`{"vid":"${1000 + i}"}`) : null;
  const bodyNative = i % 2 === 0 ? Buffer.from(`{"vid":"${1000 + i}"}`) : null;
  const ts = 1712345678 + i * 7;
  const random = 12345 + i;

  // 注意：null 必须原样传。Buffer.from(null ?? "") 会变成空 Buffer（truthy），
  // 让 native 走 md5("") 分支而 port 走 null 分支，对比就失真了。
  check(
    `xGorgon s${i}`,
    xGorgon(q, body, ts, random),
    native.xGorgon(q, bodyNative, ts, random)
  );
  check(`helios s${i}`, helios(ts), native.helios(ts));

  const url = `https://api.example.com/v1?${q}`;
  check(
    `buildMedusa s${i}`,
    buildMedusa(url, body, ts),
    native.buildMedusa(url, bodyNative, ts)
  );
  check(`branchOf s${i}`, branchOf(url, body, ts), native.branchOf(url, bodyNative, ts));
}

// be32/le32
for (const ts of [0, 1, 1712345678, 4294967295]) {
  check(`be32 ${ts}`, B.from(be32(ts)).toString("base64"), Buffer.from(native.be32(ts)).toString("base64"));
  check(`le32 ${ts}`, B.from(le32(ts)).toString("base64"), Buffer.from(native.le32(ts)).toString("base64"));
}

// pythonUrlEncode
const encodes = [{ a: "1", b: "你好", c: "x%y" }, { ts: "1712345678", _rticket: "123", q: "" }, {}];
for (let i = 0; i < encodes.length; i += 1) {
  check(`pythonUrlEncode s${i}`, pythonUrlEncode(encodes[i]), native.pythonUrlEncode(encodes[i]));
}

// cleanUrl / str
check("cleanUrl", cleanUrl("a\\/b\\u0026c&amp;d"), native.cleanUrl("a\\/b\\u0026c&amp;d"));

// 常量
check("DEVICE.device_id", DEVICE.device_id, native.DEVICE.device_id);
check("APP_DEVICE.aid", APP_DEVICE.aid, native.APP_DEVICE.aid);

console.log(`\nvendor-port 签名对照: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
