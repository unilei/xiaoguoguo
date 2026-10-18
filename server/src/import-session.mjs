// 扫码导入 Cookie：在桌面端生成一个一次性二维码，手机扫码后在手机上粘贴 Cookie 传回。
//
// 这里不伪造登录：平台没有可用的网页登录入口，红果的登录态只能从已登录的
// App / 浏览器里导出。二维码解决的是「在电视/电脑上粘贴长 Cookie 很麻烦」，
// 不是「替你登录」。
import crypto from "node:crypto";
import os from "node:os";
import { verifyAccount } from "./account.mjs";

// 由调用方注入：Node 服务传 provider 的实现，Worker 传自己的 KV 版本。
let applyCookie = () => {
  throw new Error("扫码导入模块尚未注入保存实现");
};

export function configureImportSession(next) {
  applyCookie = next.setAccountCookie;
}

const TTL = 5 * 60 * 1000;
const sessions = new Map();

function lanAddress() {
  for (const list of Object.values(os.networkInterfaces()))
    for (const nic of list || [])
      if (nic.family === "IPv4" && !nic.internal && !nic.address.startsWith("169.254."))
        return nic.address;
  return "127.0.0.1";
}

function sweep() {
  const now = Date.now();
  for (const [token, session] of sessions)
    if (now > session.expiresAt) sessions.delete(token);
}

/** 建一个导入会话，返回二维码里要放的地址与过期时间。 */
export function createImportSession(port) {
  sweep();
  const token = crypto.randomBytes(16).toString("hex");
  const session = { token, expiresAt: Date.now() + TTL, used: false };
  sessions.set(token, session);
  const host = lanAddress();
  return {
    token,
    url: `http://${host}:${port}/import/${token}`,
    expiresAt: session.expiresAt,
    sameDevice: host === "127.0.0.1",
  };
}

export function getImportSession(token) {
  const session = sessions.get(String(token || ""));
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    sessions.delete(session.token);
    return null;
  }
  return session;
}

/** 手机端提交 Cookie：校验通过才保存，并立刻让二维码失效。 */
export async function submitImport(token, cookie) {
  const session = getImportSession(token);
  if (!session) return { ok: false, reason: "二维码已过期，请在电脑上重新生成" };
  if (session.used) return { ok: false, reason: "这个二维码已经用过了" };
  const value = String(cookie || "").trim();
  if (!value) return { ok: false, reason: "没有收到 Cookie" };
  const result = await verifyAccount(value);
  if (!result.ok) return { ok: false, reason: result.reason };
  await applyCookie(value);
  session.used = true;
  sessions.delete(session.token);
  return { ok: true, profile: result.profile };
}
