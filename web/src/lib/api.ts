export interface Series {
  id: string;
  title: string;
  cover: string;
  description: string;
  badge: string;
  tags: string;
}

export interface Episode {
  id: string;
  number: number;
  title: string;
}

export interface Detail extends Series {
  episodes: Episode[];
}

export interface Playback {
  path: string;
  quality: string;
  kind: "public" | "account";
}

export interface Progress {
  series: Series;
  episodeId: string;
  episodeNumber: number;
  position: number;
  duration: number;
  completed: boolean;
  updatedAt: number;
}

export interface Library {
  favorites: Series[];
  progress: Record<string, Progress>;
}

export interface ListPage {
  items: Series[];
  page: number;
  hasMore?: boolean;
  totalPages?: number;
}

export interface ApiError {
  error: string;
}

// 设备身份：发验证码时服务端下发，登录时原样带回。
// Serverless 多实例之间不共享内存，靠这个头保证"同一台设备"。
const DEVICE_KEY = "xiaoguoguo.device.v1";

export function readDeviceId(): string {
  try {
    return localStorage.getItem(DEVICE_KEY) || "";
  } catch {
    return "";
  }
}

function rememberDevice(response: Response): void {
  const value = response.headers.get("x-xgg-device");
  if (!value) return;
  try {
    localStorage.setItem(DEVICE_KEY, value);
  } catch {
    // 隐私模式下写不进去，退化成每次新设备（登录可能失败，但不影响浏览）。
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const device = readDeviceId();
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(device ? { "x-xgg-device": device } : {}),
      ...(init?.headers || {}),
    },
  });
  rememberDevice(response);
  const text = await response.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new Error("服务返回了无法解析的内容");
  }
  if (!response.ok) {
    // 后端两种失败形态：{ error } 和 { ok:false, message }，都要把真实原因带出来。
    // 有些错误还带着可继续使用的字段（如短信冷却期的 mobileTicket），挂到 error 上。
    const payload = data as
      | {
          error?: string;
          message?: string;
          code?: number;
          mobileTicket?: string;
          ticketTail?: string;
          phoneTail?: string;
        }
      | null;
    const failure = new Error(
      payload?.error || payload?.message || `请求失败（${response.status}）`
    ) as Error & {
      code?: number;
      mobileTicket?: string;
      ticketTail?: string;
      phoneTail?: string;
    };
    if (payload?.code !== undefined) failure.code = payload.code;
    if (payload?.mobileTicket) failure.mobileTicket = payload.mobileTicket;
    if (payload?.ticketTail) failure.ticketTail = payload.ticketTail;
    if (payload?.phoneTail) failure.phoneTail = payload.phoneTail;
    throw failure;
  }
  return data as T;
}

export const api = {
  health: () =>
    request<{
      service: string;
      account: "configured" | "anonymous";
      runtime?: "cloudflare-worker" | string;
      kv?: boolean;
    }>("/api/health"),
  home: (page = 1) => request<ListPage>(`/api/home?page=${page}`),
  search: (query: string, page = 1) =>
    request<ListPage>(`/api/search?q=${encodeURIComponent(query)}&page=${page}`),
  detail: (id: string) => request<Detail>(`/api/series/${encodeURIComponent(id)}`),
  play: (episodeId: string) =>
    request<Playback>(`/api/episodes/${encodeURIComponent(episodeId)}/play`),
  saveAccount: (cookie: string) =>
    request<{ ok: boolean; account: boolean; profile?: AccountProfile }>("/api/account", {
      method: "POST",
      body: JSON.stringify({ cookie }),
    }),
  createQr: () =>
    request<{
      token: string;
      url: string;
      expiresAt: number;
      sameDevice: boolean;
      qr: string;
    }>("/api/account/qr", { method: "POST" }),
  qrStatus: (token: string) =>
    request<{ valid: boolean; expiresAt: number }>(`/api/account/qr/${token}`),
  devices: () =>
    request<{ ok: boolean; devices: string[]; error?: string }>("/api/account/devices"),
  sendSms: (mobile: string) =>
    request<{
      ok: boolean;
      mobile: string;
      smsCodeKey: string;
      retryAfter: number;
      message: string;
      /** 冷却期（1206）时平台仍会下发 ticket，可直接用来登录。 */
      mobileTicket?: string;
    }>("/api/account/sms/send", {
      method: "POST",
      body: JSON.stringify({ mobile }),
    }),
  loginSms: (mobile: string, code: string, smsCodeKey: string) =>
    request<{
      ok: boolean;
      profile: AccountProfile;
      expiry: SessionExpiry;
    }>("/api/account/sms/login", {
      method: "POST",
      body: JSON.stringify({ mobile, code, smsCodeKey }),
    }),
  importFromDevice: (serial: string) =>
    request<{
      ok: boolean;
      serial: string;
      fields: number;
      expiry: SessionExpiry;
      profile: AccountProfile;
    }>("/api/account/device", {
      method: "POST",
      body: JSON.stringify({ serial }),
    }),
};

export interface SessionExpiry {
  known: boolean;
  issued?: number;
  expires?: number;
  expiresText?: string;
  remainingDays?: number;
  expired?: boolean;
}

export interface AccountProfile {
  nickname: string;
  avatar: string;
  displayId: string;
}

export function streamUrl(episodeId: string): string {
  return `/api/episodes/${encodeURIComponent(episodeId)}/stream`;
}

export function resumeTarget(
  detail: Detail,
  progress?: Progress
): { index: number; position: number } {
  if (!progress) return { index: 0, position: 0 };
  const index = detail.episodes.findIndex((episode) => episode.id === progress.episodeId);
  if (index < 0) return { index: 0, position: 0 };
  if (progress.completed)
    return {
      index: Math.min(index + 1, detail.episodes.length - 1),
      position: 0,
    };
  return { index, position: Math.max(0, progress.position) };
}

export function mergePage(existing: Series[], incoming: Series[]): Series[] {
  return Array.from(
    new Map([...existing, ...incoming].map((item) => [item.id, item])).values()
  );
}

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

export function formatRelative(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return "刚刚";
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`;
  return new Date(timestamp).toLocaleDateString("zh-CN");
}
