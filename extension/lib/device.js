// 设备注册的浏览器版（对应 server/src/device-register.mjs）。
//
// 平台按「注册过的 device_id + install_id」放行内容接口；注册本身匿名。
// node:crypto 的 randomBytes/createCipheriv/gzipSync 换成
// getRandomValues / WebCrypto AES-CBC / CompressionStream。
import { Buffer } from "./buffer.js";
import { md5Hex } from "./md5.js";

const HOST = "https://log5-applog-lf.fqnovel.com";
const PATH = "/service/2/device_register/";
const QUERY =
  "?tt_data=a&cronet_version=8d40f833_2026-03-03&ttnet_version=4.2.243.31-douyin&use_store_region_cookie=1";
const MAGIC = Buffer.from([0x74, 0x63, 0x05, 0x10, 0x00, 0x00]);
const KDF_SALT = Buffer.from(
  "4dd4c2e6b83162090e52b3c7a6733ba41cb2462b829ab58a196b39db57177524" +
    "f49baf7f08e8d68d26a72e37c1a95a2f1f05a51892aef2949732b62a38aadd58",
  "hex"
);

export const DEVICE_UA =
  "com.phoenix.read/72232 (Linux; U; Android 16; zh_CN; 25053RT47C; Build/BP2A.250605.031.A3)";

const subtle = globalThis.crypto?.subtle;

function randomBytes(length) {
  const out = new Uint8Array(length);
  globalThis.crypto.getRandomValues(out);
  return Buffer.from(out);
}

function randomUUID() {
  return globalThis.crypto.randomUUID();
}

async function sha512(data) {
  return Buffer.from(await subtle.digest("SHA-512", new Uint8Array(data)));
}

async function aesCbcEncrypt(keyBytes, iv, data) {
  // WebCrypto 的 AES-CBC 只支持 PKCS#7 填充；本协议要求手动 PKCS#7
  //（与 Node 版 setAutoPadding(false) + 手动填充一致），所以直接喂已填充的数据。
  const key = await subtle.importKey("raw", new Uint8Array(keyBytes), "AES-CBC", false, ["encrypt"]);
  const out = await subtle.encrypt(
    { name: "AES-CBC", iv: new Uint8Array(iv) },
    key,
    new Uint8Array(data)
  );
  return Buffer.from(out);
}

async function gzip(data) {
  const stream = new Blob([new Uint8Array(data)])
    .stream()
    .pipeThrough(new CompressionStream("gzip"));
  return Buffer.from(new Uint8Array(await new Response(stream).arrayBuffer()));
}

// ttEncrypt：MAGIC || rnd[32] || AES-128-CBC(SHA512(SHA512(rnd)+KDF_SALT), PKCS7(SHA512(data)||data))
async function ttEncrypt(data) {
  const rnd = randomBytes(32);
  const rndHash = await sha512(rnd);
  const derived = await sha512(Buffer.concat([rndHash, KDF_SALT]));
  const body = Buffer.concat([await sha512(data), data]);
  // WebCrypto 的 AES-CBC 自带 PKCS#7，语义与 Node 版
  // setAutoPadding(false) + 手动补齐完全一致，不要再手动补一遍
  //（否则会多出一整个填充块，服务端解出的 JSON 尾部带垃圾字节）。
  const encrypted = await aesCbcEncrypt(derived.subarray(0, 16), derived.subarray(16, 32), body);
  return Buffer.concat([MAGIC, rnd, encrypted]);
}

function buildPayload(now = Date.now()) {
  const json = {
    magic_tag: "ss_app_log",
    header: {
      display_name: "红果免费短剧",
      update_version_code: 73932,
      manifest_version_code: 73932,
      app_version_minor: "7.3.9.32",
      aid: 8662,
      channel: "69310258a",
      package: "com.phoenix.read",
      app_version: "7.3.9.32",
      version_code: 73932,
      sdk_version: "3.7.0-rc.34-fanqie-xiaoshuo",
      sdk_target_version: 29,
      git_hash: "3a88f4e",
      os: "Android",
      // os_version 必须是字符串：写成数字服务端会回 device_id=0。
      os_version: "12",
      os_api: 32,
      device_model: "AOSP on Intel Platform",
      device_brand: "SAMSUNG",
      device_manufacturer: "Intel",
      cpu_abi: "arm64-v8a",
      release_build: "b5e187f",
      density_dpi: 360,
      display_density: "mdpi",
      resolution: "1440x2560",
      language: "zh",
      timezone: 8,
      access: "wifi",
      not_request_sender: 0,
      carrier: "CHINA MOBILE",
      mcc_mnc: "46000",
      rom: "eng.root.20231116.160340",
      rom_version: "W528JS release-keys",
      cdid: randomUUID(),
      sig_hash: "56a962410c494bbaf0b58dba20cae56f",
      openudid: randomUUID().replace(/-/g, "").slice(0, 16),
      clientudid: randomUUID(),
      ipv6_list: [],
      region: "CN",
      tz_name: "Asia/Shanghai",
      tz_offset: 28800,
      sim_region: "cn",
      sim_serial_number: [],
      oaid_may_support: false,
      req_id: randomUUID(),
      device_platform: "android",
      custom: {
        account_region_src: "fallback",
        host_bit: 64,
        account_region: "cn",
        dragon_device_type: "pad",
      },
      pre_installed_channel: "",
      apk_first_install_time: now,
      is_system_app: 0,
      sdk_flavor: "china",
      guest_mode: 0,
    },
    _gen_time: now,
  };
  return gzip(Buffer.from(JSON.stringify(json), "utf8"));
}

function parseSetCookies(headerString) {
  const cookies = {};
  // fetch 的 response.headers.getSetCookie() 在 SW 里可用；没有就走 getSetCookie
  const list = headerString || [];
  for (const header of list) {
    const first = String(header).split(";")[0];
    const at = first.indexOf("=");
    if (at <= 0) continue;
    const name = first.slice(0, at).trim();
    const value = first.slice(at + 1).trim();
    if (name && value) cookies[name] = value;
  }
  return cookies;
}

/**
 * 匿名注册一台设备，返回 { deviceId, installId, cookies }。
 * device_id=0 视为被拒。Cookies 在扩展里由调用方存 chrome.storage。
 */
export async function registerDevice() {
  const now = Date.now();
  const gzipped = await buildPayload(now);
  const body = await ttEncrypt(gzipped);
  const headers = {
    "User-Agent": DEVICE_UA,
    "Content-Type": "application/octet-stream;tt-data=a",
    "log-encode-type": "gzip",
    "x-ss-dp": "8662",
    "x-ss-req-ticket": String(now),
    "x-vc-bdturing-sdk-version": "4.0.3.cn",
    lc: "101",
    "sdk-version": "2",
    "passport-sdk-version": "5051452",
    "x-neptune": "-8|50:51:59:30:40:47:49:39",
    "x-ss-stub": md5Hex(body).toUpperCase(),
  };
  const response = await fetch(HOST + PATH + QUERY, {
    method: "POST",
    headers,
    body: new Uint8Array(body),
  });
  if (!response.ok) throw new Error(`设备注册失败（HTTP ${response.status}）`);
  const text = await response.text();
  const data = JSON.parse(text);
  const deviceId = String(data.device_id_str || data.device_id || "");
  const installId = String(data.install_id_str || data.install_id || "");
  if (!deviceId || !installId || deviceId === "0" || installId === "0")
    throw new Error("设备注册被服务端拒绝");
  const setCookies =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [];
  return {
    deviceId,
    installId,
    cookies: parseSetCookies(setCookies),
  };
}
