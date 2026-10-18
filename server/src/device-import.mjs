// 从已登录的 Android 设备 / 模拟器导出登录态。
//
// 这是上游（HGTV tools/login-lab）实测唯一可行的登录路径：手机号验证码与平台扫码
// 都走不通（详见该目录 README 的实测表），官方 App 的登录态只存在于设备上的
// shared_prefs/cookieStore.xml 里。这里用 adb 把它读出来，解析成可直接用的 Cookie。
//
// cookieStore.xml 里是 Java 序列化的 SerializableHttpCookie：字段按
// TC_STRING(0x74) + u2 长度 + UTF-8 排列，形如 [name, value, domain, path]。
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { COOKIE_KEYS, sessionExpiry } from "./cookie-utils.mjs";

export { sessionExpiry };

const run = promisify(execFile);

const PACKAGE = "com.phoenix.read";

async function adb(serial, args, timeout = 20000) {
  const command = ["adb", ...(serial ? ["-s", serial] : []), ...args];
  try {
    const { stdout } = await run(command[0], command.slice(1), {
      timeout,
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const message = String(error.stderr || error.message || "").trim().slice(0, 200);
    throw new Error(`adb ${args.join(" ")} 失败：${message}`);
  }
}

/** 列出 adb 可见的设备；没有设备时抛错并给出可操作的提示。 */
export async function listDevices() {
  const output = await adb(null, ["devices"]);
  return output
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line.endsWith("\tdevice") || line.endsWith(" device"))
    .map((line) => line.split(/\s+/)[0]);
}

/** 按 Java 序列化 TC_STRING(0x74) + u2 长度取字符串。 */
function tcStrings(blob) {
  const out = [];
  let index = 0;
  while (index < blob.length - 2) {
    if (blob[index] === 0x74) {
      const length = (blob[index + 1] << 8) | blob[index + 2];
      if (length > 0 && length <= 2048 && index + 3 + length <= blob.length) {
        const chunk = blob.subarray(index + 3, index + 3 + length);
        if (chunk.every((byte) => byte >= 0x20 && byte < 0x7f)) {
          out.push(chunk.toString("ascii"));
          index += 3 + length;
          continue;
        }
      }
    }
    index += 1;
  }
  return out;
}

/** 把 cookieStore.xml 解析成 host|name -> value。 */
export function parseCookieStore(xml) {
  const cookies = {};
  const pattern = /<string name="([^"]+)">([^<]*)<\/string>/g;
  let match;
  while ((match = pattern.exec(xml))) {
    const key = match[1];
    const raw = match[2];
    const [hostPart, name] = key.split("|");
    if (!hostPart || !name) continue;
    const host = hostPart.replace(/^https?:\/\//, "").replace(/\/+$/, "");
    let value = null;
    try {
      const fields = tcStrings(Buffer.from(raw, "hex"));
      const at = fields.indexOf(name);
      if (at >= 0 && at + 1 < fields.length) value = fields[at + 1];
    } catch {
      // 不是十六进制序列化流就跳过，避免一条坏记录拖垮整个导入。
    }
    cookies[`${host}|${name}`] = value;
  }
  return cookies;
}

/** 从解析结果拼出可直接当 Cookie 头用的整段串（取 snssdk.com 域）。 */
export function cookieHeader(cookies, host = "snssdk.com") {
  return COOKIE_KEYS.filter((name) => cookies[`${host}|${name}`])
    .map((name) => `${name}=${cookies[`${host}|${name}`]}`)
    .join("; ");
}

/**
 * 从设备导出登录态。
 * 返回 { serial, cookie, fields, expiry, profile }；读不到登录态时抛错。
 */
export async function importFromDevice(serial) {
  const devices = serial ? [serial] : await listDevices();
  if (!devices.length)
    throw new Error("没有可用的 Android 设备：请启动模拟器，或先用 adb connect <ip:端口> 连接手机");

  const target = devices[0];
  let xml;
  try {
    xml = await adb(target, ["shell", `cat /data/data/${PACKAGE}/shared_prefs/cookieStore.xml`]);
  } catch (error) {
    throw new Error(
      `读取 cookieStore.xml 失败（${target}）：需要 root 或模拟器。` +
        `原始错误：${error.message}`
    );
  }
  if (!xml.trim()) throw new Error("cookieStore.xml 为空：设备上的红果 App 可能还没登录");

  const cookies = parseCookieStore(xml);
  const cookie = cookieHeader(cookies);
  if (!cookie) throw new Error("没有解析到 snssdk.com 域的登录 Cookie：请先在 App 里完成登录");

  // 设备档案只作记录：实测用模拟器的 device_id / 机型反而会被平台限流，
  // 签名仍用内置档案，与上游的结论一致。
  let profile = {};
  try {
    const applog = await adb(target, [
      "shell",
      `cat /data/data/${PACKAGE}/shared_prefs/applog_stats.xml`,
    ]);
    const pick = (source, name) =>
      new RegExp(`name="${name}"[^>]*value="([^"]*)"`).exec(source)?.[1] ||
      new RegExp(`name="${name}">([^<]*)<`).exec(source)?.[1] ||
      "";
    profile = {
      deviceId: pick(applog, "device_id"),
      installId: pick(applog, "install_id"),
    };
  } catch {
    // 档案读不到不影响登录态本身。
  }

  return {
    serial: target,
    cookie,
    fields: cookie.split("; ").length,
    expiry: sessionExpiry(cookie),
    profile,
  };
}
