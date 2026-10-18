// 手机号 + 验证码登录。
//
// 参数与流程照 HGTV v1.1.5.1 APK 的实际实现还原（dex 里 /passport/mobile/send_code/v1/
// 与 /passport/mobile/sms_login/ 两处调用的常量）：
//
//   send_code: mobile="+86" + 11位, account_sdk_source=app,
//              passport_support_flow="captcha,verify", mix_mode=1,
//              auto_read=0, unbind_exist=34, type=24
//   sms_login: mobile, code, account_sdk_source=app,
//              passport_support_flow="captcha,verify", mix_mode=1,
//              sms_code_key=<上一步返回>, passport_mfa_retry_tag=1
//
// 两个接口都在 passport 域名下，带设备注册后拿到的 device_id / iid。
import { ensureIdentity, signedRequest } from "./provider.mjs";

// 实测：passport 域名对这两个路径回 404；能响应的是内容侧线路。
const PASSPORT_HOSTS = [
  "https://api5-normal-sinfonlinea.fqnovel.com",
  "https://api5-normal-sinfonlinec.fqnovel.com",
  "https://api5-normal-sinfonlineb.fqnovel.com",
  "https://api5-normal-lf.fqnovel.com",
];

async function postForm(path, values, body) {
  const identity = await ensureIdentity();
  const params = new URLSearchParams(body).toString();
  let lastError = null;
  // 单条线路失败时换下一条；空响应体在这个平台上是常态，不是业务错误。
  for (const host of PASSPORT_HOSTS) {
    try {
      const signed = signedRequest(`${host}${path}`, values, null);
      if (identity.cookie) signed.headers.Cookie = identity.cookie;
      signed.headers["Content-Type"] = "application/x-www-form-urlencoded";
      const response = await fetch(signed.url, {
        method: "POST",
        headers: signed.headers,
        body: params,
        signal: AbortSignal.timeout(25000),
      });
      const text = await response.text();
      if (!text.trim()) {
        lastError = new Error("账号服务没有响应，请稍后重试");
        continue;
      }
      try {
        return JSON.parse(text);
      } catch {
        lastError = new Error("账号服务返回格式异常");
      }
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("账号服务暂不可用");
}

function identityValues(identity) {
  return {
    aid: "8662",
    app_name: "novelread",
    device_platform: "android",
    version_code: "73932",
    device_id: identity.deviceId,
    iid: identity.installId,
  };
}

/** 发送登录验证码。返回 { ok, smsCodeKey, retryAfter, message }。 */
export async function sendLoginCode(mobile) {
  const phone = String(mobile || "").replace(/\s|-/g, "");
  if (!/^1\d{10}$/.test(phone))
    return { ok: false, message: "手机号要 11 位、以 1 开头" };

  const identity = await ensureIdentity();
  const data = await postForm(
    "/passport/mobile/send_code/v1/",
    identityValues(identity),
    {
      mobile: `+86${phone}`,
      account_sdk_source: "app",
      passport_support_flow: "captcha,verify",
      mix_mode: "1",
      auto_read: "0",
      unbind_exist: "34",
      type: "24",
    }
  );
  const payload = data.data || {};
  if (data.message !== "success") {
    return {
      ok: false,
      message: payload.description || data.message || "验证码发送失败，请稍后重试",
      code: payload.error_code,
    };
  }
  return {
    ok: true,
    mobile: phone,
    smsCodeKey: payload.sms_code_key || "",
    retryAfter: Number(payload.retry_time || 60),
    message: `验证码已发到 ${phone}`,
  };
}

/**
 * 用验证码换登录态。成功时返回 Cookie 串。
 *
 * 平台对同一验证码只认一次；失败时把平台原文带回去，避免界面只说“登录失败”。
 */
export async function loginWithCode({ mobile, code, smsCodeKey }) {
  const phone = String(mobile || "").replace(/\s|-/g, "");
  const value = String(code || "").trim();
  if (!/^1\d{10}$/.test(phone))
    return { ok: false, message: "手机号要 11 位、以 1 开头" };
  if (!/^\d{4,8}$/.test(value))
    return { ok: false, message: "验证码是 4—8 位数字" };

  const identity = await ensureIdentity();
  const data = await postForm(
    "/passport/mobile/sms_login/",
    identityValues(identity),
    {
      mobile: `+86${phone}`,
      code: value,
      account_sdk_source: "app",
      passport_support_flow: "captcha,verify",
      mix_mode: "1",
      sms_code_key: smsCodeKey || "",
      passport_mfa_retry_tag: "1",
    }
  );
  const payload = data.data || {};
  if (data.message !== "success") {
    return {
      ok: false,
      message: payload.description || data.message || "验证失败，请检查验证码或稍后重试",
      code: payload.error_code,
    };
  }
  const sessionId = payload.sessionid || payload.sid_tt || "";
  if (!sessionId) {
    return { ok: false, message: "账号服务返回的内容不完整，请稍后重试" };
  }
  // 组装成与设备导出同形的 Cookie：sessionid 是服务端要的那一项，
  // 其余字段平台不校验，有就带上。
  const parts = [
    `sessionid=${sessionId}`,
    payload.sid_tt ? `sid_tt=${payload.sid_tt}` : "",
    payload.uid_tt ? `uid_tt=${payload.uid_tt}` : "",
    payload.sessionid_ss ? `sessionid_ss=${payload.sessionid_ss}` : "",
    payload.sid_guard ? `sid_guard=${payload.sid_guard}` : "",
  ].filter(Boolean);
  return { ok: true, cookie: parts.join("; "), sessionId };
}
