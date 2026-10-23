// 模拟器远程控制服务。
//
// 「在网页里运行 APK」不是真的在浏览器里执行 Android 字节码，而是：
//   本机模拟器跑真实 App → 截图推流到网页 → 网页点击换算成 adb 触摸事件。
// 这和小果果的内容服务分开跑：它只在你本机运行，负责完成手机号登录这一步。
//
// 安全边界：
//   - 只监听 127.0.0.1，不对外网开放；
//   - 所有接口都要带一次性令牌（启动时打印到终端）；
//   - 只允许固定的几条 adb 命令，不接受任意命令拼接。
import http from "node:http";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseCookieStore, cookieHeader, sessionExpiry } from "../server/src/device-import.mjs";

const run = promisify(execFile);

const PORT = Number(process.env.EMU_PORT || 8790);
const TOKEN = process.env.EMU_TOKEN || crypto.randomBytes(12).toString("hex");
const PACKAGE = "com.phoenix.read";
const ANDROID_HOME =
  process.env.ANDROID_HOME || `${process.env.HOME}/Library/Android/sdk`;
const ADB = `${ANDROID_HOME}/platform-tools/adb`;
const EMULATOR = `${ANDROID_HOME}/emulator/emulator`;

async function adb(args, timeout = 20000) {
  try {
    const { stdout } = await run(ADB, args, { timeout, maxBuffer: 32 * 1024 * 1024 });
    return stdout;
  } catch (error) {
    throw new Error(`adb ${args[0]} 失败：${String(error.stderr || error.message).slice(0, 200)}`);
  }
}

async function device() {
  const out = await adb(["devices"]);
  const line = out
    .split("\n")
    .slice(1)
    .find((row) => row.trim().endsWith("device"));
  if (!line) return null;
  return line.split(/\s+/)[0];
}

// 最近一帧缓存：截图很贵（每次 ~200-500ms），多个客户端/高频轮询时复用。
let lastFrame = { at: 0, png: null, serial: "" };
const FRAME_TTL = 250;

/** 截图：exec-out 拿 PNG 原始字节，比 shell screencap + pull 快很多。 */
function screencap(serial) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      ADB,
      ["-s", serial, "exec-out", "screencap", "-p"],
      { encoding: "buffer", maxBuffer: 32 * 1024 * 1024, timeout: 15000 },
      (error, stdout) => {
        if (error) return reject(error);
        resolve(stdout);
      }
    );
    child.stdin?.end();
  });
}

const json = (res, status, value) => {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(value));
};

function authorized(req, url) {
  const header = req.headers.authorization || "";
  const query = url.searchParams.get("token") || "";
  return header === `Bearer ${TOKEN}` || query === TOKEN;
}

function readJson(req, limit = 8 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch {
        resolve({});
      }
    });
    req.on("error", reject);
  });
}

/** 解析 cookieStore.xml 并返回可用的 Cookie 串。 */
async function exportCookie(serial) {
  const xml = await adb(["shell", `cat /data/data/${PACKAGE}/shared_prefs/cookieStore.xml`]);
  if (!xml.trim()) throw new Error("cookieStore.xml 为空：模拟器里的红果 App 可能还没登录");
  const cookies = parseCookieStore(xml);
  const cookie = cookieHeader(cookies);
  if (!cookie) throw new Error("没有解析到 snssdk.com 域的登录 Cookie");
  return { cookie, fields: cookie.split("; ").length, expiry: sessionExpiry(cookie) };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const path = url.pathname;

  // 控制页本身需要令牌，否则同机其他程序可以随意操作模拟器。
  if (path === "/" || path === "/index.html") {
    if (!authorized(req, url)) {
      res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
      return res.end("<h1>需要令牌</h1><p>请使用启动时打印的完整地址打开。</p>");
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(CONTROL_PAGE.replace("__TOKEN__", TOKEN));
  }

  if (!authorized(req, url)) return json(res, 401, { error: "令牌不正确" });

  try {
    if (path === "/api/status") {
      const serial = await device();
      if (!serial) return json(res, 200, { ok: false, error: "没有可用的模拟器设备" });
      const boot = (await adb(["-s", serial, "shell", "getprop", "sys.boot_completed"])).trim();
      const size = (await adb(["-s", serial, "shell", "wm", "size"])).trim();
      const focus = await adb(["-s", serial, "shell", "dumpsys", "window"]).catch(() => "");
      const current = /mCurrentFocus=([^\n}]*)/.exec(focus)?.[1]?.trim() || "";
      const installed = await adb(["-s", serial, "shell", "pm", "list", "packages", PACKAGE]).catch(() => "");
      return json(res, 200, {
        ok: true,
        serial,
        booted: boot === "1",
        size,
        current,
        installed: installed.includes(PACKAGE),
        token: TOKEN,
      });
    }

    // 截图流：前端按帧拉取，简单可靠，不依赖 WebSocket。
    if (path === "/api/screen") {
      const serial = await device();
      if (!serial) return json(res, 503, { error: "没有可用的模拟器设备" });
      const now = Date.now();
      let png;
      if (lastFrame.png && lastFrame.serial === serial && now - lastFrame.at < FRAME_TTL) {
        png = lastFrame.png;
      } else {
        png = await screencap(serial);
        lastFrame = { at: now, png, serial };
      }
      res.writeHead(200, {
        "Content-Type": "image/png",
        "Content-Length": png.length,
        "Cache-Control": "no-store",
      });
      return res.end(png);
    }

    if (path === "/api/tap" && req.method === "POST") {
      const { x, y } = await readJson(req);
      const serial = await device();
      if (!serial) return json(res, 503, { error: "没有可用的模拟器设备" });
      await adb(["-s", serial, "shell", "input", "tap", String(Math.round(x)), String(Math.round(y))]);
      return json(res, 200, { ok: true });
    }

    if (path === "/api/swipe" && req.method === "POST") {
      const { x1, y1, x2, y2, duration = 300 } = await readJson(req);
      const serial = await device();
      if (!serial) return json(res, 503, { error: "没有可用的模拟器设备" });
      await adb([
        "-s", serial, "shell", "input", "swipe",
        String(Math.round(x1)), String(Math.round(y1)),
        String(Math.round(x2)), String(Math.round(y2)),
        String(Math.round(duration)),
      ]);
      return json(res, 200, { ok: true });
    }

    if (path === "/api/text" && req.method === "POST") {
      const { text } = await readJson(req);
      const serial = await device();
      if (!serial) return json(res, 503, { error: "没有可用的模拟器设备" });
      // adb input text 不支持空格与部分符号，转义处理。
      const safe = String(text).replace(/([\\'"`$&|;<>()*?~])/g, "\\$1").replace(/ /g, "%s");
      await adb(["-s", serial, "shell", "input", "text", safe]);
      return json(res, 200, { ok: true });
    }

    if (path === "/api/key" && req.method === "POST") {
      const { key } = await readJson(req);
      const allowed = new Set([
        "KEYCODE_BACK", "KEYCODE_HOME", "KEYCODE_ENTER", "KEYCODE_DEL",
        "KEYCODE_APP_SWITCH", "KEYCODE_TAB",
      ]);
      if (!allowed.has(key)) return json(res, 400, { error: "不支持这个按键" });
      const serial = await device();
      if (!serial) return json(res, 503, { error: "没有可用的模拟器设备" });
      await adb(["-s", serial, "shell", "input", "keyevent", key]);
      return json(res, 200, { ok: true });
    }

    // 启动红果 App；未安装时给出明确指引。
    if (path === "/api/launch" && req.method === "POST") {
      const serial = await device();
      if (!serial) return json(res, 503, { error: "没有可用的模拟器设备" });
      const installed = await adb(["-s", serial, "shell", "pm", "list", "packages", PACKAGE]).catch(() => "");
      if (!installed.includes(PACKAGE))
        return json(res, 400, {
          error: "模拟器里还没有安装红果 App。请先在模拟器里打开 Google Play 搜索「红果短剧」安装，或用 adb install 装入 APK。",
        });
      await adb(["-s", serial, "shell", "monkey", "-p", PACKAGE, "-c", "android.intent.category.LAUNCHER", "1"]);
      return json(res, 200, { ok: true });
    }

    // 打开 Google Play 的红果详情页，方便直接安装。
    if (path === "/api/open-play" && req.method === "POST") {
      const serial = await device();
      if (!serial) return json(res, 503, { error: "没有可用的模拟器设备" });
      await adb([
        "-s", serial, "shell", "am", "start",
        "-a", "android.intent.action.VIEW",
        "-d", `market://details?id=${PACKAGE}`,
      ]);
      return json(res, 200, { ok: true });
    }

    // 登录完成后导出 Cookie。
    if (path === "/api/export") {
      const serial = await device();
      if (!serial) return json(res, 503, { error: "没有可用的模拟器设备" });
      const result = await exportCookie(serial);
      return json(res, 200, { ok: true, ...result });
    }

    return json(res, 404, { error: "接口不存在" });
  } catch (error) {
    return json(res, 500, { error: error instanceof Error ? error.message : "操作失败" });
  }
});

const CONTROL_PAGE = String.raw`<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>小果果 · 模拟器远程登录</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:#0d0b10;color:#f7f3ef;font:14px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}
.wrap{display:flex;gap:18px;padding:18px;min-height:100vh}
.left{flex:1;min-width:0;display:flex;flex-direction:column;gap:12px}
.right{width:320px;flex:none;display:flex;flex-direction:column;gap:12px}
h1{font-size:17px;margin:0}
.screen-box{position:relative;background:#000;border-radius:14px;overflow:hidden;border:1px solid #2e2836;display:flex;align-items:center;justify-content:center;min-height:300px}
.screen-box img{display:block;max-width:100%;max-height:calc(100vh - 190px);width:auto;height:auto;cursor:crosshair;user-select:none}
.bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
button{background:#1c1821;border:1px solid #2e2836;color:#f7f3ef;border-radius:10px;padding:9px 14px;font:inherit;cursor:pointer}
button:hover{background:#241f2b}
button.primary{background:linear-gradient(140deg,#ff7a59,#ff5c35);border:0;color:#2a1208;font-weight:700}
button:disabled{opacity:.4;cursor:not-allowed}
.panel{background:#16131a;border:1px solid #2e2836;border-radius:14px;padding:14px}
.panel h2{font-size:14px;margin:0 0 10px}
.hint{color:#a29aab;font-size:12px;line-height:1.7}
.status{font-size:12px;color:#a29aab;white-space:pre-wrap;word-break:break-all}
.ok{color:#57d9a3}
.err{color:#ff8f8f}
input[type=text]{width:100%;padding:10px;border-radius:9px;background:#1c1821;border:1px solid #2e2836;color:#f7f3ef;font:inherit;outline:none}
input[type=text]:focus{border-color:#ff7a59}
.row{display:flex;gap:8px;margin-top:8px}
.row input{flex:1}
pre{white-space:pre-wrap;word-break:break-all;font-size:11px;color:#a29aab;margin:8px 0 0;max-height:160px;overflow:auto}
</style></head><body>
<div class="wrap">
  <div class="left">
    <div class="bar">
      <h1>模拟器远程控制</h1>
      <span id="state" class="status">正在连接…</span>
    </div>
    <div class="screen-box"><img id="screen" alt="模拟器画面"></div>
    <div class="bar">
      <button onclick="launch()">启动红果 App</button>
      <button onclick="openPlay()">打开应用商店</button>
      <button onclick="key('KEYCODE_BACK')">返回</button>
      <button onclick="key('KEYCODE_HOME')">主页</button>
      <button onclick="key('KEYCODE_ENTER')">确定</button>
      <button onclick="key('KEYCODE_DEL')">删除</button>
      <button id="playBtn" onclick="toggleStream()">暂停画面</button>
      <span class="hint">直接点画面即可操作；输入文字用右侧输入框。</span>
    </div>
  </div>
  <div class="right">
    <div class="panel">
      <h2>输入文字</h2>
      <input type="text" id="txt" placeholder="例如手机号、验证码">
      <div class="row">
        <button class="primary" onclick="sendText()">发送到模拟器</button>
        <button onclick="sendEnter()">回车</button>
      </div>
      <p class="hint">点画面上的输入框后再发送。模拟器输入法可能不弹键盘，直接用这里输入即可。</p>
    </div>
    <div class="panel">
      <h2>登录后导出</h2>
      <p class="hint">在模拟器里完成红果登录后，点下面的按钮读取登录态。</p>
      <button class="primary" onclick="exportCookie()" style="width:100%">读取并显示 Cookie</button>
      <pre id="cookie"></pre>
    </div>
    <div class="panel">
      <h2>状态</h2>
      <div class="status" id="detail"></div>
    </div>
  </div>
</div>
<script>
const TOKEN = "__TOKEN__";
const api = (path, init) => fetch(path + (path.includes("?") ? "&" : "?") + "token=" + TOKEN, init);
let streaming = true, timer = null, inflight = false, img = document.getElementById("screen");

async function refresh() {
  if (!streaming || inflight) return;
  inflight = true;
  try {
    const r = await api("/api/screen");
    if (r.ok) {
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const old = img.src;
      img.onload = () => { if (old.startsWith("blob:")) URL.revokeObjectURL(old); };
      img.src = url;
    }
  } catch {}
  inflight = false;
  if (streaming) timer = setTimeout(refresh, 700);
}
function toggleStream() {
  streaming = !streaming;
  document.getElementById("playBtn").textContent = streaming ? "暂停画面" : "继续画面";
  if (streaming) refresh();
  else if (timer) clearTimeout(timer);
}
img.addEventListener("click", async (e) => {
  const rect = img.getBoundingClientRect();
  const x = Math.round((e.clientX - rect.left) / rect.width * img.naturalWidth);
  const y = Math.round((e.clientY - rect.top) / rect.height * img.naturalHeight);
  await api("/api/tap", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({x,y}) });
});
async function launch(){ const r = await api("/api/launch",{method:"POST"}); const j = await r.json(); if(!j.ok) alert(j.error); }
async function openPlay(){ await api("/api/open-play",{method:"POST"}); }
async function key(k){ await api("/api/key",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({key:k})}); }
async function sendText(){ const v=document.getElementById("txt").value; if(!v) return; await api("/api/text",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({text:v})}); }
async function sendEnter(){ await key("KEYCODE_ENTER"); }
async function exportCookie(){
  const r = await api("/api/export");
  const j = await r.json();
  document.getElementById("cookie").textContent = j.ok ? ("字段数 " + j.fields + "\n" + j.cookie) : ("失败：" + j.error);
}
async function status(){
  try {
    const r = await api("/api/status"); const j = await r.json();
    document.getElementById("state").textContent = j.ok ? (j.installed ? "已安装红果" : "未安装红果") : "未连接";
    document.getElementById("state").className = "status " + (j.ok && j.installed ? "ok" : "err");
    document.getElementById("detail").textContent = JSON.stringify(j, null, 1);
  } catch (e) { document.getElementById("state").textContent = "服务未响应"; }
  setTimeout(status, 3000);
}
refresh(); status();
</script>
</body></html>`;

server.listen(PORT, "127.0.0.1", () => {
  console.log(`模拟器控制服务已启动`);
  console.log(`打开这个地址：http://127.0.0.1:${PORT}/?token=${TOKEN}`);
  console.log(`令牌：${TOKEN}`);
  console.log(`只监听本机；关闭这个进程即停止控制。`);
});
