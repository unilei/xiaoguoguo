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
// 与 account.mjs 一样，依赖由调用方注入（Node 服务 / Worker 各传自己的实现）。
let deps = {
  ensureIdentity: async () => {
    throw new Error("短信登录模块尚未注入设备身份实现");
  },
  signedRequest: () => {
    throw new Error("短信登录模块尚未注入签名实现");
  },
};

export function configureSmsModule(next) {
  deps = { ...deps, ...next };
}

// 实测：passport 域名对这两个路径回 404；能响应的是内容侧线路。
const PASSPORT_HOSTS = [
  "https://api5-normal-sinfonlinea.fqnovel.com",
  "https://api5-normal-sinfonlinec.fqnovel.com",
  "https://api5-normal-sinfonlineb.fqnovel.com",
  "https://api5-normal-lf.fqnovel.com",
];

async function postForm(path, values, body) {
  const identity = await deps.ensureIdentity();
  const params = new URLSearchParams(body).toString();
  let lastError = null;
  // 单条线路失败时换下一条；空响应体在这个平台上是常态，不是业务错误。
  for (const host of PASSPORT_HOSTS) {
    try {
      const signed = deps.signedRequest(`${host}${path}`, values, null);
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

// 版本号必须与 APK 实际使用的一致。实测 73932 / 7.3.9.32 会被平台按异常客户端
// 处理，直接回「访问太频繁」；换成 APK 里的 73532 / 7.3.5.32 后才会进入正常业务分支。
const APP_VERSION = {
  version_code: "73532",
  version_name: "7.3.5.32",
  manifest_version_code: "73532",
  update_version_code: "73532",
};

function identityValues(identity) {
  return {
    aid: "8662",
    app_name: "novelread",
    device_platform: "android",
    ...APP_VERSION,
    // 与 APK 抓包一致的设备参数，缺了会被当成旧版本或异常客户端。
    ac: "wifi",
    channel: "update_64",
    device_brand: "Redmi",
    device_type: "25053RT47C",
    dpi: "520",
    os: "android",
    os_api: "36",
    os_version: "16",
    resolution: "1280*2772",
    ssmix: "a",
    language: "zh",
    device_id: identity.deviceId,
    iid: identity.installId,
  };
}

/** 发送登录验证码。返回 { ok, smsCodeKey, retryAfter, message }。 */
export async function sendLoginCode(mobile) {
  const phone = String(mobile || "").replace(/\s|-/g, "");
  if (!/^1\d{10}$/.test(phone))
    return { ok: false, message: "手机号要 11 位、以 1 开头" };

  const identity = await deps.ensureIdentity();
  // type 决定短信用途。实测（2026-10-19）：
  //   24 / 19 → 1204 需要人机验证，发不出来；
  //   8       → 换绑手机号流程，会提示「已绑定到某账号」；
  //   101     → 登录验证码，能真正下发（冷却期内回 1206）。
  const data = await postForm(
    "/passport/mobile/send_code/v1/",
    identityValues(identity),
    {
      mobile: `+86${phone}`,
      account_sdk_source: "app",
      passport_support_flow: "captcha,verify",
      mix_mode: "1",
      auto_read: "0",
      type: "101",
    }
  );
  const payload = data.data || {};
  if (data.message !== "success") {
    const code = Number(payload.error_code || 0);
    // 把平台错误码翻译成用户能理解、能照做的提示。
    const message =
      code === 1206
        ? "这个号码刚发过验证码，平台要求等一会儿再发（通常是 60 秒到几分钟）。收到过就直接填验证码，没收到就稍后再点一次。"
        : code === 1204
          ? "平台要求先通过人机验证才肯发短信。请改用「从手机/模拟器导入」或在设置页粘贴 Cookie 登录。"
          : code === 7
            ? "请求太频繁，请等几分钟再试。"
            : code === 1057
              ? "这个手机号已绑定到另一个红果账号，请先在官方 App 里处理绑定关系。"
              : code === 1001
                ? "这个手机号已绑定其他账号，请换一个或先在官方 App 里处理。"
                : payload.description || data.message || "验证码发送失败，请稍后重试";
    return { ok: false, message, code, mobileTicket: payload.mobile_ticket || "" };
  }
  return {
    ok: true,
    mobile: phone,
    smsCodeKey: payload.sms_code_key || payload.mobile_ticket || "",
    retryAfter: Number(payload.retry_time || 60),
    message: `验证码已发到 ${phone}`,
  };
}

/**
 * 用验证码换登录态。成功时返回 Cookie 串。
 *
 * 平台对同一验证码只认一次；失败时把平台原文带回去，避免界面只说“登录失败”。
 */
export async function loginWithCode({ mobile, code, smsCodeKey, mobileTicket }) {
  const phone = String(mobile || "").replace(/\s|-/g, "");
  const value = String(code || "").trim();
  if (!/^1\d{10}$/.test(phone))
    return { ok: false, message: "手机号要 11 位、以 1 开头" };
  if (!/^\d{4,8}$/.test(value))
    return { ok: false, message: "验证码是 4—8 位数字" };

  const identity = await deps.ensureIdentity();
  const data = await postForm(
    "/passport/mobile/sms_login/",
    identityValues(identity),
    {
      mobile: `+86${phone}`,
      code: value,
      account_sdk_source: "app",
      passport_support_flow: "captcha,verify",
      mix_mode: "1",
      // 平台发码返回的是 mobile_ticket，登录时要按这个字段名回传。
      // 之前误用 sms_code_key，平台回 1066「验证已过期」，看起来像验证码失效。
      mobile_ticket: mobileTicket || smsCodeKey || "",
      passport_mfa_retry_tag: "1",
    }
  );
  const payload = data.data || {};
  if (data.message !== "success") {
    const code = Number(payload.error_code || 0);
    const message =
      code === 1066
        ? "验证码已过期或还没收到。请重新点「获取验证码」，并在 10 分钟内输入。"
        : code === 1204 || code === 1206
          ? "验证码不正确或已失效，请检查后重试。"
          : payload.description || data.message || "登录失败，请检查验证码或稍后重试";
    return {
      ok: false,
      message,
      code,
      // 便于排查：告诉前端这次用的是哪个 ticket（只给尾部，不泄露完整凭证）。
      ticketTail: (mobileTicket || smsCodeKey || "").slice(-8),
      phoneTail: phone.slice(-4),
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
