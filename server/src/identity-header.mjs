// 无状态的设备身份传递。
//
// Vercel 的 Serverless 实例之间不共享内存，每次冷启动都会注册一台新设备。
// 而发验证码和提交验证码必须使用**同一台设备**（平台按 device_id 认会话），
// 否则登录会回 1066 / 1203「验证码已过期」。
//
// 做法：服务端把设备身份随响应交给前端，前端在后续请求里通过请求头带回来。
// 这样不依赖任何外部存储，也天然适配多实例。
export const IDENTITY_HEADER = "x-xgg-device";
export const IDENTITY_TTL = 30 * 60 * 1000;

/** 把身份编码成请求头值。 */
export function encodeIdentity(identity) {
  if (!identity) return "";
  const payload = JSON.stringify({
    d: identity.deviceId,
    i: identity.installId,
    c: identity.cookie || "",
    t: Date.now(),
  });
  return Buffer.from(payload, "utf8").toString("base64url");
}

/** 从请求头还原身份；格式不对或过期时返回 null。 */
export function decodeIdentity(value) {
  if (!value) return null;
  try {
    const raw = Buffer.from(String(value), "base64url").toString("utf8");
    const data = JSON.parse(raw);
    if (!data?.d || !data?.i) return null;
    if (typeof data.t === "number" && Date.now() - data.t > IDENTITY_TTL) return null;
    return {
      deviceId: String(data.d),
      installId: String(data.i),
      cookie: String(data.c || ""),
    };
  } catch {
    return null;
  }
}
