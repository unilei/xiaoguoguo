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

/**
 * passport 会话 cookie。
 *
 * App 的 flow.(*Login).captureSessionCookies 会保存发码响应下发的
 * passport_csrf_token，并在后续请求里带回去。实测平台对没有 csrf 的登录请求
 * 也接受，但带上能稳定复用同一次会话（发码与登录落到同一台设备上下文），
 * 减少「凭证有效却换不到登录态」的情况。这里按 phone 记住最近一次发码的 cookie。
 */
const passportCookies = new Map();

function rememberCookies(phone, response) {
  const list = response.headers.getSetCookie?.() ?? [];
  if (!list.length) return;
  const jar = passportCookies.get(phone) || {};
  for (const line of list) {
    const [pair] = line.split(";");
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (value) jar[name] = value;
  }
  passportCookies.set(phone, jar);
  // 只保留最近 20 个号码，避免长期运行后无限增长。
  while (passportCookies.size > 20) {
    passportCookies.delete(passportCookies.keys().next().value);
  }
}

function cookieHeaderFor(phone) {
  const jar = passportCookies.get(phone);
  if (!jar) return "";
  return Object.entries(jar)
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

async function postForm(path, values, body, phone = "") {
  const identity = await deps.ensureIdentity();
  const params = new URLSearchParams(body).toString();
  let lastError = null;
  // 单条线路失败时换下一条；空响应体在这个平台上是常态，不是业务错误。
  for (const host of PASSPORT_HOSTS) {
    try {
      const signed = deps.signedRequest(`${host}${path}`, values, null);
      // 先带发码阶段拿到的 csrf 会话，再拼设备身份 cookie。
      const session = cookieHeaderFor(phone);
      const parts = [session, identity.cookie].filter(Boolean);
      if (parts.length) signed.headers.Cookie = parts.join("; ");
      signed.headers["Content-Type"] = "application/x-www-form-urlencoded";
      const response = await fetch(signed.url, {
        method: "POST",
        headers: signed.headers,
        body: params,
        signal: AbortSignal.timeout(25000),
      });
      if (phone) rememberCookies(phone, response);
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
    },
    phone
  );
  const payload = data.data || {};
  if (data.message !== "success") {
    const code = Number(payload.error_code || 0);
    const platformText = String(payload.description || "").trim();
    // 1003 的实际语义是「手机号错误，请重新填写」，不是频控。平台把号码格式、
    // 号段、以及部分风控判定都归到这个码，所以直接透传平台原文比猜更准。
    const message =
      code === 1003
        ? platformText || "这个手机号平台没有接受，请核对后重试。"
        : code === 1206
          ? "这个号码刚发过验证码，平台要求等一会儿再发（通常是 60 秒到几分钟）。收到过就直接填验证码，没收到就稍后再点一次。"
          : code === 1204
            ? "平台要求先通过人机验证才肯发短信。请稍后重试，或改用设置页粘贴 Cookie 的方式登录。"
            : code === 7
              ? "请求太频繁，请等几分钟再试。"
              : code === 1057
                ? "这个手机号已绑定到另一个红果账号，请先在官方 App 里处理绑定关系。"
                : code === 1001
                  ? "这个手机号已绑定其他账号，请换一个或先在官方 App 里处理。"
                  : platformText || data.message || "验证码发送失败，请稍后重试";
    // 平台在 1206 / 1003 时仍会下发 ticket。带回去让用户收到短信就能直接登录，
    // 但 1003 表示号码本身有问题，这时候的 ticket 通常也用不了，所以不标成可用凭证。
    const usable = code === 1206 || code === 0;
    return {
      ok: false,
      message,
      code,
      mobileTicket: usable ? payload.mobile_ticket || "" : "",
      smsCodeKey: usable ? payload.sms_code_key || payload.mobile_ticket || "" : "",
    };
  }
  return {
    ok: true,
    mobile: phone,
    // 登录接口要的是 sms_code_key；发码响应里这个键常缺失，用 mobile_ticket 顶替。
    smsCodeKey: payload.sms_code_key || payload.mobile_ticket || "",
    retryAfter: Number(payload.retry_time || 60),
    message: `验证码已发到 ${phone}`,
  };
}

/**
 * 把平台返回的 session 字段组装成 Cookie。
 * sessionid 是业务接口要的那一项；sid_guard 决定有效期展示，
 * sessionid_ss / sid_tt / uid_tt 一起带上更接近真实客户端。
 */
function cookieFromSession(payload) {
  const sessionId = payload.sessionid || payload.sid_tt || "";
  if (!sessionId) return null;
  const parts = [
    `sessionid=${sessionId}`,
    payload.sid_tt ? `sid_tt=${payload.sid_tt}` : "",
    payload.uid_tt ? `uid_tt=${payload.uid_tt}` : "",
    payload.sessionid_ss ? `sessionid_ss=${payload.sessionid_ss}` : "",
    payload.sid_guard ? `sid_guard=${payload.sid_guard}` : "",
  ].filter(Boolean);
  return { cookie: parts.join("; "), sessionId };
}

/** 从响应里取出平台给的错误信息。 */
function failureOf(data) {
  const payload = data?.data || {};
  return {
    code: Number(payload.error_code || 0),
    text: String(payload.description || "").trim(),
    ticket: String(payload.mobile_ticket || ""),
    raw: payload,
  };
}

/**
 * 路径一：/passport/mobile/sms_login/，凭证字段是 sms_code_key。
 * 这是 App 的 flow.(*Login).SMSLogin。
 */
async function trySmsLogin(phone, value, ticket) {
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
      // 凭证字段名必须是 sms_code_key。发码响应里返回的键叫 mobile_ticket，
      // 但登录接口只认 sms_code_key —— 传 mobile_ticket 会被当成没带凭证，
      // 平台回 1203「错误次数过多或验证码过期」，看起来像验证码错了，
      // 实际是字段名不匹配。实测对照（2026-10-22）：
      //   sms_code_key=<ticket> → 1066（凭证被识别）
      //   mobile_ticket=<ticket> → 1203（凭证被忽略）
      sms_code_key: ticket,
      passport_mfa_retry_tag: "1",
    },
    phone
  );
  return data;
}

/**
 * 路径二：/passport/upsms/verify/，凭证字段是 verify_ticket。
 * 这是 App 的 flow.(*Login).UpsmsVerify —— 当 SMSLogin 没能直接换到登录态
 * （返回 1066，即平台要求再走一次验证）时，App 用这条路径完成校验。
 *
 * 两个接口的凭证字段名不同：sms_login 认 sms_code_key，upsms 认 verify_ticket。
 * 传错字段 upsms 会回 3「缺少参数」，传对但验证码不对则回 1045「认证失败」。
 */
async function tryUpsmsVerify(phone, value, ticket) {
  const identity = await deps.ensureIdentity();
  const data = await postForm(
    "/passport/upsms/verify/",
    identityValues(identity),
    {
      mobile: `+86${phone}`,
      code: value,
      verify_way: "sms",
      verify_scene: "login",
      verify_ticket: ticket,
    },
    phone
  );
  return data;
}

/**
 * 用验证码换登录态。
 *
 * 先走 sms_login；如果平台要求二次验证（1066）或没给 session，就用同一条
 * 凭证换字段名再走 upsms/verify。两条路径都能出 sessionid 时以先成功的为准。
 * 平台对同一验证码只认一次，所以两条路径要背靠背发，中间不要插入发码请求。
 */
export async function loginWithCode({ mobile, code, smsCodeKey, mobileTicket }) {
  const phone = String(mobile || "").replace(/\s|-/g, "");
  const value = String(code || "").trim();
  if (!/^1\d{10}$/.test(phone))
    return { ok: false, message: "手机号要 11 位、以 1 开头" };
  if (!/^\d{4,8}$/.test(value))
    return { ok: false, message: "验证码是 4—8 位数字" };
  const ticket = String(smsCodeKey || mobileTicket || "").trim();
  if (!ticket)
    return {
      ok: false,
      message: "没有发码凭证，请先点「获取验证码」，收到短信后再填。",
      code: 0,
      expired: true,
    };

  let firstFailure = null;
  let retryTicket = ticket;

  // ---- 路径一 ----
  try {
    const data = await trySmsLogin(phone, value, ticket);
    const session = cookieFromSession(data?.data || {});
    if (data?.message === "success" && session) {
      return { ok: true, cookie: session.cookie, sessionId: session.sessionId };
    }
    firstFailure = failureOf(data);
    // 平台在失败响应里也可能下发新 ticket，upsms 用得上。
    if (firstFailure.ticket) retryTicket = firstFailure.ticket;
  } catch (error) {
    firstFailure = { code: 0, text: error instanceof Error ? error.message : "", ticket: "" };
  }

  // ---- 路径二 ----
  let secondFailure = null;
  try {
    const data = await tryUpsmsVerify(phone, value, retryTicket);
    const session = cookieFromSession(data?.data || {});
    if (data?.message === "success" && session) {
      return { ok: true, cookie: session.cookie, sessionId: session.sessionId };
    }
    secondFailure = failureOf(data);
  } catch (error) {
    secondFailure = { code: 0, text: error instanceof Error ? error.message : "", ticket: "" };
  }

  // 两条都失败：优先用更能说明问题的那个错误码。
  // 1045（upsms 认证失败）说明凭证被接受、验证码不对；
  // 1066（sms_login 凭证失效）说明凭证本身要重新拿。
  const failCode =
    secondFailure?.code === 1045 ? 1045 : firstFailure?.code || secondFailure?.code || 0;
  const platformText = firstFailure?.text || secondFailure?.text || "";
  const message =
    failCode === 1045
      ? "验证码不对。请核对短信里的数字，注意别把上一条已失效的验证码填进来。"
      : failCode === 1066
        ? "这条验证码凭证已失效。平台每次重新发码都会作废旧凭证，请点「获取验证码」拿一条新短信，再用新收到的数字登录。"
        : failCode === 1203
          ? "平台没有接受这次登录凭证，请重新点「获取验证码」后再登录。"
          : failCode === 3
            ? "登录请求缺少平台要求的参数，请更新到最新版本后重试。"
            : failCode === 1204 || failCode === 1206
              ? "验证码不正确或已失效，请检查后重试。"
              : failCode === 7
                ? "请求太频繁，请等几分钟再试。"
                : platformText || "登录失败，请检查验证码或稍后重试";
  return {
    ok: false,
    message,
    code: failCode,
    // 只有 1066 / 1203 表示「凭证本身要重拿」；1045 是验证码错了，凭证还能继续用。
    expired: failCode === 1066 || failCode === 1203,
    ticketTail: retryTicket.slice(-8),
    phoneTail: phone.slice(-4),
  };
}
