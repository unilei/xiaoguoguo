// Chrome 扩展 MV3 Service Worker（background）。
//
// 职责：
//   1. 设备注册（身份存 chrome.storage.local）
//   2. 签名请求 App 播放接口，解析任意一集的播放地址
//   3. 拉取加密 MP4 → CENC 解密 → 返回给 content script 播放
//
// 所有上游请求都在这里发起（Service Worker 不受 CORS 限制，
// manifest 里声明了 host_permissions）。
import { Buffer } from "./lib/buffer.js";
import {
  APP_DEVICE,
  APP_UA,
  VIDEO_UA,
  pythonUrlEncode,
  xGorgon,
  helios,
  buildMedusa,
  be32,
  le32,
  branchOf,
} from "./lib/vendor-port.js";
import { md5Digest } from "./lib/md5.js";
import { registerDevice } from "./lib/device.js";
import {
  prepareCencHeader,
  decryptRange,
  deriveContentKeySync,
  decryptSpadeUrl,
} from "./lib/cenc.js";

const PLAYER_HOST = "https://api5-normal-lq.fqnovel.com";

const PLAYER_QUERY = {
  ac: "wifi",
  aid: "8662",
  app_name: "novelread",
  channel: "xiaomi_8662_64",
  compliance_status: "0",
  device_brand: "xiaomi",
  device_type: "23127PN0CC",
  dpi: "460",
  dragon_device_type: "phone",
  host_abi: "arm64-v8a",
  is_android_pad_screen: "0",
  language: "zh",
  manifest_version_code: "73932",
  need_personal_recommend: "1",
  os: "android",
  os_api: "34",
  os_version: "14",
  player_so_load: "1",
  pv_player: "73932",
  resolution: "1200*2670",
  ssmix: "a",
  update_version_code: "73932",
  version_code: "73932",
  version_name: "7.3.9.32",
};

const PLAYER_BIZ = {
  detail_page_version: 0,
  device_level: 4,
  disable_digg_stat: false,
  need_all_video_definition: true,
  need_mp4_align: false,
  use_os_player: false,
  use_server_dns: false,
  video_platform: 1024,
};

// ---------------------------------------------------------------- 签名

function signedRequest(base, values, bodyObject) {
  const now = Date.now();
  const ts = Math.floor(now / 1000);
  const body = bodyObject ? Buffer.from(JSON.stringify(bodyObject)) : null;
  let query = "";
  let url = "";
  let ticket = now;
  for (let offset = 0; offset < 128; offset += 1) {
    ticket = now + offset;
    query = pythonUrlEncode({ ...values, ts: String(ts), _rticket: String(ticket) });
    url = `${base}?${query}`;
    if (branchOf(url, body, ts) === 0) break;
  }
  const random = Math.floor(Math.random() * 65536);
  const headers = {
    "User-Agent": body ? VIDEO_UA : APP_UA,
    Accept: "application/json; charset=utf-8,application/x-protobuf",
    "x-ss-req-ticket": String(ticket),
    "x-tt-request-tag": "t=0;n=0",
    "sdk-version": "2",
    "passport-sdk-version": "50561",
    "x-xs-from-web": "0",
    "x-khronos": String(ts),
    "x-ladon": Buffer.from(be32(ts)).toString("base64"),
    "x-argus": Buffer.from(le32(ts)).toString("base64"),
    "x-gorgon": xGorgon(query, body, ts, random),
    "x-helios": helios(ts),
    "x-medusa": buildMedusa(url, body, ts),
    "x-tt-dt": "",
  };
  if (body) {
    headers["Content-Type"] = "application/json; charset=UTF-8";
    headers["x-vc-bdturing-sdk-version"] = "3.7.2.cn";
    headers["x-ss-stub"] = Buffer.from(md5Digest(body)).toString("hex").toUpperCase();
  }
  return { url, headers, body };
}

// ---------------------------------------------------------------- 身份

let identityPromise = null;

async function ensureIdentity() {
  const stored = await chrome.storage.local.get("identity");
  if (stored.identity?.deviceId) return stored.identity;
  if (!identityPromise) {
    identityPromise = registerDevice()
      .then(async (registered) => {
        const identity = {
          deviceId: registered.deviceId,
          installId: registered.installId,
          cookie: Object.entries(registered.cookies)
            .map(([name, value]) => `${name}=${value}`)
            .join("; "),
        };
        await chrome.storage.local.set({ identity });
        return identity;
      })
      .finally(() => {
        identityPromise = null;
      });
  }
  return identityPromise;
}

// ---------------------------------------------------------------- appStream

function parseJsonish(value) {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * 解析一集的播放地址（匿名可用，覆盖整部剧）。
 * 返回 { url, key, quality }。
 */
async function appStream(vid) {
  const identity = await ensureIdentity();
  const values = {
    ...PLAYER_QUERY,
    device_id: identity.deviceId,
    iid: identity.installId,
  };
  const body = {
    biz_param: PLAYER_BIZ,
    mixed_video_id_map: { "1004": [String(vid)] },
  };
  const signed = signedRequest(`${PLAYER_HOST}/novel/player/multi_video_model/v1/`, values, body);
  if (identity.cookie) signed.headers.Cookie = identity.cookie;

  const response = await fetch(signed.url, {
    method: "POST",
    headers: signed.headers,
    body: new Uint8Array(signed.body),
  });
  if (!response.ok) throw new Error(`播放接口 HTTP ${response.status}`);
  const data = await response.json();
  const code = Number(data?.code ?? data?.Code ?? 0);
  if (code !== 0) throw new Error(`播放接口暂不可用（${code}）`);

  const entry = data?.data?.[String(vid)];
  if (!entry) throw new Error("播放接口没有返回这一集");
  const model = parseJsonish(entry.video_model);
  if (!model) throw new Error("播放接口没有返回播放模型");

  const list = model.video_list;
  const items = Array.isArray(list) ? list : Object.values(list || {});
  const rows = items
    .map((item) => {
      const meta = item.video_meta || item;
      const definition = String(item.definition || meta.definition || "");
      const encoded = String(item.main_url || "");
      let url = "";
      try {
        url = Buffer.from(encoded, "base64").toString("utf8");
      } catch {
        url = encoded;
      }
      return {
        url,
        quality: definition || "360p",
        number: Number(definition.replace(/[^\d]/g, "")) || 0,
        spadeA: item.spade_a || meta.spade_a || "",
        keySeed: model.key_seed || "",
      };
    })
    .filter((row) => /^https?:\/\//.test(row.url));

  if (!rows.length) throw new Error("没有可用清晰度");
  const usable = rows.filter((row) => row.number && row.number <= 720);
  const selected = (usable.length ? usable : rows).sort((a, b) => b.number - a.number)[0];

  let url = selected.url;
  if (selected.spadeA && selected.keySeed) {
    try {
      url = await decryptSpadeUrl(url, Buffer.from(selected.keySeed, "base64"));
    } catch {
      // 解不出来就用原地址
    }
  }
  if (!/^https?:\/\//.test(url)) throw new Error("播放地址无效");

  const key = selected.spadeA ? deriveContentKeySync(selected.spadeA) : null;
  return { url, key, quality: selected.quality.toUpperCase() };
}

// ---------------------------------------------------------------- 视频解密

const streamCache = new Map(); // vid → { appUrl, key, prepared, total }

async function getStreamContext(vid) {
  const cached = streamCache.get(vid);
  if (cached) return cached;

  const source = await appStream(vid);
  const headRes = await fetch(source.url, {
    headers: { Range: "bytes=0-1048575", "User-Agent": VIDEO_UA, "Accept-Encoding": "identity" },
  });
  let head = Buffer.from(await headRes.arrayBuffer());
  let total = Number(String(headRes.headers.get("content-range") || "").match(/\/(\d+)$/)?.[1] || 0);
  if (headRes.status === 200) total ||= headRes.length;
  if (head.length < 16) throw new Error("MP4 头过短");
  const ftypSize = head.readUInt32BE(0);
  if (head.toString("ascii", 4, 8) !== "ftyp" || head.toString("ascii", ftypSize + 4, ftypSize + 8) !== "moov")
    throw new Error("MP4 索引不在文件开头");
  const moovEnd = ftypSize + head.readUInt32BE(ftypSize);
  if (moovEnd > total || moovEnd > 8 * 1024 * 1024) throw new Error("MP4 索引大小异常");
  if (moovEnd > head.length) {
    const more = await fetch(source.url, {
      headers: { Range: `bytes=${head.length}-${moovEnd - 1}`, "User-Agent": VIDEO_UA },
    });
    head = Buffer.concat([head, Buffer.from(await more.arrayBuffer())]);
  }
  head = head.subarray(0, moovEnd);
  const prepared = prepareCencHeader(head, Boolean(source.key));

  const ctx = { appUrl: source.url, key: source.key, prepared, total, quality: source.quality };
  streamCache.set(vid, ctx);
  if (streamCache.size > 8) streamCache.delete(streamCache.keys().next().value);
  return ctx;
}

// ---------------------------------------------------------------- 消息

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
  return true; // 异步 sendResponse
});

async function handleMessage(message) {
  switch (message?.type) {
    case "play": {
      // 解析一集：返回 { vid, total, quality }，content script 用 range 拉数据
      const source = await getStreamContext(message.vid);
      return { vid: message.vid, total: source.total, quality: source.quality };
    }
    case "range": {
      // 拉取并解密一段：{ vid, start, end } → ArrayBuffer
      const ctx = await getStreamContext(message.vid);
      const start = Math.max(0, Math.floor(message.start));
      const end = Math.min(ctx.total - 1, Math.floor(message.end));
      if (start > end) return { data: new ArrayBuffer(0) };
      const res = await fetch(ctx.appUrl, {
        headers: { Range: `bytes=${start}-${end}`, "User-Agent": VIDEO_UA, "Accept-Encoding": "identity" },
      });
      if (!res.ok && res.status !== 206) throw new Error(`分段失败（HTTP ${res.status}）`);
      const raw = Buffer.from(await res.arrayBuffer());
      const out = await decryptRange(raw, start, ctx.key, ctx.prepared);
      return { data: out.buffer.slice(out.byteOffset, out.byteOffset + out.length) };
    }
    default:
      throw new Error("未知消息类型");
  }
}
