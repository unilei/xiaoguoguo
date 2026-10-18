// 账号凭据校验：拿 Cookie 请求一次账号资料接口，确认它真的是一个登录用户。
//
// 平台对无效/过期的 sessionid 不报错，而是把请求当成匿名设备，按 device_id
// 现造一个账号（昵称形如「用户19058925」）。这种响应必须挡住，否则一份坏凭据
// 会被当成导入成功，界面上只是「一条记录都没有」。判定逻辑移植自 HGTV 的
// Account.kt / ContentRepository.kt（GPL-3.0）。
import { ensureIdentity, signedRequest } from "./provider.mjs";

const ACCOUNT_HOST = "https://api5-normal-sinfonlinea.fqnovel.com";

/**
 * 用 Cookie 取一次账号资料。
 * 返回 { ok: true, profile } / { ok: false, reason }
 */
export async function verifyAccount(cookie) {
  const value = String(cookie || "").trim();
  if (!value) return { ok: false, reason: "Cookie 为空" };
  const identity = await ensureIdentity();
  const values = {
    ac: "wifi",
    aid: "8662",
    app_name: "novelread",
    ssmix: "a",
    device_platform: "android",
    os: "android",
    language: "zh",
    compliance_status: "0",
    need_personal_recommend: "1",
    player_so_load: "1",
    host_abi: "arm64-v8a",
    version_code: "72232",
    version_name: "7.2.2.32",
    manifest_version_code: "72232",
    update_version_code: "72232",
    pv_player: "72232",
    device_id: identity.deviceId,
    iid: identity.installId,
  };
  const signed = signedRequest(`${ACCOUNT_HOST}/reading/user/info/v1/`, values, null);
  signed.headers.Cookie = value;
  const response = await fetch(signed.url, {
    headers: signed.headers,
    signal: AbortSignal.timeout(20000),
  });
  const text = await response.text();
  if (!text.trim()) return { ok: false, reason: "账号接口没有响应，Cookie 可能已失效" };
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, reason: "账号接口返回格式异常" };
  }
  if (Number(data.code) !== 0) return { ok: false, reason: "Cookie 无效或已过期" };
  const info = data.data || {};
  const nickname = String(info.user_name || "");
  const avatar = String(info.avatar_url || info.expand_avatar_url || "");
  if (!nickname && !avatar) return { ok: false, reason: "Cookie 无效或已过期" };
  // 匿名设备也会拿到一个现造的昵称，形如「用户19058925」。
  if (isAnonymous(info, nickname)) {
    return { ok: false, reason: "Cookie 已失效，平台把它当成了匿名设备" };
  }
  return {
    ok: true,
    profile: {
      nickname,
      avatar,
      displayId: String(info.biz_user_id || ""),
    },
  };
}

/**
 * 判定是不是匿名设备临时账号。
 *
 * 实测特征（同一 device_id 下对比）：
 * - 昵称形如「用户」+ device_id 前缀；
 * - 红果号（biz_user_id）等于 device_id 或为空；
 * - 头像为空或默认头像。
 */
function isAnonymous(info, nickname) {
  const display = String(info.biz_user_id || "");
  const userId = String(info.user_id || "");
  if (display && display === String(info.device_id || "")) return true;
  if (!display && !userId) return true;
  return /^用户\d{6,}$/.test(nickname);
}
