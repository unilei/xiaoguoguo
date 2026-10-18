// 设备注册：平台按「服务端注册过的 device_id + install_id」放行内容接口。
// 协议与字段顺序移植自 HGTV 的 core/DeviceRegister.kt（GPL-3.0）。
// 注册本身是匿名的：不需要账号、密码或短信。
import crypto from "node:crypto";
import zlib from "node:zlib";

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

const APP_UA =
  "com.phoenix.read/72232 (Linux; U; Android 16; zh_CN; 25053RT47C; Build/BP2A.250605.031.A3)";

// ttEncrypt：MAGIC || rnd[32] || AES-128-CBC(SHA512(SHA512(rnd)+KDF_SALT), PKCS7(SHA512(data)||data))
function ttEncrypt(data) {
  const rnd = crypto.randomBytes(32);
  const derived = crypto
    .createHash("sha512")
    .update(
      Buffer.concat([crypto.createHash("sha512").update(rnd).digest(), KDF_SALT])
    )
    .digest();
  const body = Buffer.concat([crypto.createHash("sha512").update(data).digest(), data]);
  const padding = 16 - (body.length % 16);
  const padded = Buffer.concat([body, Buffer.alloc(padding, padding)]);
  const cipher = crypto.createCipheriv(
    "aes-128-cbc",
    derived.subarray(0, 16),
    derived.subarray(16, 32)
  );
  cipher.setAutoPadding(false);
  return Buffer.concat([MAGIC, rnd, cipher.update(padded), cipher.final()]);
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
      cdid: crypto.randomUUID(),
      sig_hash: "56a962410c494bbaf0b58dba20cae56f",
      openudid: crypto.randomUUID().replace(/-/g, "").slice(0, 16),
      clientudid: crypto.randomUUID(),
      ipv6_list: [],
      region: "CN",
      tz_name: "Asia/Shanghai",
      tz_offset: 28800,
      sim_region: "cn",
      sim_serial_number: [],
      oaid_may_support: false,
      req_id: crypto.randomUUID(),
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
  return ttEncrypt(zlib.gzipSync(Buffer.from(JSON.stringify(json), "utf8")));
}

function parseSetCookies(list) {
  const cookies = {};
  for (const header of list || []) {
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
 * 失败时抛错，由调用方决定是否重试；device_id=0 视为被拒。
 */
export async function registerDevice() {
  const now = Date.now();
  const body = buildPayload(now);
  const headers = {
    "User-Agent": APP_UA,
    "Content-Type": "application/octet-stream;tt-data=a",
    "log-encode-type": "gzip",
    "x-ss-dp": "8662",
    "x-ss-req-ticket": String(now),
    "x-vc-bdturing-sdk-version": "4.0.3.cn",
    lc: "101",
    "sdk-version": "2",
    "passport-sdk-version": "5051452",
    "x-neptune": "-8|50:51:59:30:40:47:49:39",
    "x-ss-stub": crypto.createHash("md5").update(body).digest("hex").toUpperCase(),
  };
  const response = await fetch(HOST + PATH + QUERY, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`设备注册失败（HTTP ${response.status}）`);
  const text = await response.text();
  const data = JSON.parse(text);
  const deviceId = String(data.device_id_str || data.device_id || "");
  const installId = String(data.install_id_str || data.install_id || "");
  if (!deviceId || !installId || deviceId === "0" || installId === "0")
    throw new Error("设备注册被服务端拒绝");
  return {
    deviceId,
    installId,
    cookies: parseSetCookies(response.headers.getSetCookie?.() ?? []),
  };
}

export const DEVICE_UA = APP_UA;
