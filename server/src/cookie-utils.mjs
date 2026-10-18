// Cookie 相关的小工具：无 Node 专属依赖，Node 服务与 Worker 共用。

/** 组装 Cookie 头时要带的字段，顺序固定便于比对（与上游一致）。 */
export const COOKIE_KEYS = [
  "sessionid",
  "sessionid_ss",
  "sid_tt",
  "uid_tt",
  "uid_tt_ss",
  "d_ticket",
  "sid_guard",
  "session_tlb_tag",
  "store-region",
  "store-region-src",
  "install_id",
  "n_mh",
  "odin_tt",
  "ttreq",
];

/**
 * 从 sid_guard 算会话有效期。
 * 形如 `sessionid|签发时间戳|max-age|人类可读时间`，过期 = 签发 + max-age；
 * 第三段不是过期时间戳，业务接口也不会回 Set-Cookie，因此不会自动续期。
 */
export function sessionExpiry(cookie) {
  const match = /sid_guard=([^;]+)/.exec(String(cookie || ""));
  if (!match) return { known: false };
  const parts = decodeURIComponent(match[1]).split("|");
  if (parts.length < 3) return { known: false };
  const issued = Number(parts[1]);
  const maxAge = Number(parts[2]);
  if (!Number.isFinite(issued) || !Number.isFinite(maxAge)) return { known: false };
  const expires = issued + maxAge;
  const now = Date.now() / 1000;
  return {
    known: true,
    issued,
    expires,
    expiresText: new Date(expires * 1000).toLocaleString("zh-CN"),
    remainingDays: Math.round(((expires - now) / 86400) * 10) / 10,
    expired: now >= expires,
  };
}
