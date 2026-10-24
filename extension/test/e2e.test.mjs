// 端到端管线测试：模拟 chrome API，走完 play → range → 解密，
// 产出文件用 ffprobe 验证是可播放的 MP4。
import { execSync } from "node:child_process";
import fs from "node:fs";

// ---- chrome API 桩 ----
const store = new Map();
globalThis.chrome = {
  storage: {
    local: {
      async get(key) {
        return key in Object.fromEntries(store) ? { [key]: store.get(key) } : {};
      },
      async set(obj) {
        for (const [k, v] of Object.entries(obj)) store.set(k, v);
      },
    },
  },
  runtime: {
    onMessage: { addListener() {} },
    lastError: null,
  },
};

const { default: bg } = await import("../background.js");
void bg;

// 从 background.js 里拿不到内部函数（未导出），
// 直接用消息处理器：重新 import 前先捕获 listener
let handler = null;
globalThis.chrome.runtime.onMessage.addListener = (fn) => {
  handler = fn;
};
// 重新加载让 listener 注册进桩
delete globalThis.__xgg_bg;
const bgUrl = new URL("../background.js", import.meta.url);
// ESM 缓存无法直接失效；改用动态查询参数强制重载
const bg2 = await import(bgUrl.href + "?reload=1");
void bg2;

if (!handler) throw new Error("没有捕获到消息处理器");

function send(message) {
  return new Promise((resolve, reject) => {
    handler(message, {}, (response) => {
      if (!response?.ok) reject(new Error(response?.error || "后台失败"));
      else resolve(response);
    });
  });
}

const VID = process.argv[2] || "7697838648548396094"; // 枝头春意闹 第2集
console.log("解析 vid:", VID);

const meta = await send({ type: "play", vid: VID });
console.log("quality:", meta.quality, "total:", meta.total, `(${(meta.total / 1024 / 1024).toFixed(1)}MB)`);

// 全量拉取解密
const CHUNK = 1024 * 1024;
const parts = [];
for (let start = 0; start < meta.total; start += CHUNK) {
  const end = Math.min(start + CHUNK, meta.total) - 1;
  const res = await send({ type: "range", vid: VID, start, end });
  parts.push(Buffer.from(res.data));
  process.stdout.write(`\r拉取 ${Math.round((end / meta.total) * 100)}%`);
}
console.log("");

const out = Buffer.concat(parts);
const outPath = "/tmp/xgg-ext-test.mp4";
fs.writeFileSync(outPath, out);
console.log("写出:", outPath, out.length, "bytes");

// ffprobe 验证
try {
  const probe = execSync(
    `ffprobe -v error -show_entries format=duration,size,format_name -show_entries stream=codec_name,codec_type,width,height -of json ${outPath}`,
    { encoding: "utf8" }
  );
  console.log("ffprobe:", probe.trim());
  console.log("\n✅ 端到端管线通过：解密产出是有效 MP4");
} catch (e) {
  console.error("❌ ffprobe 失败:", e.stderr?.slice(0, 200));
  process.exit(1);
}
