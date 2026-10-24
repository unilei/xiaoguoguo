# Web 版实现方案

**结论先说**：你的 `xiaoguoguo` 已经就是 Web 版，而且核心链路（浏览 / 搜索 / 详情 / 播放 / 收藏 / 续播 / 登录）我已经实测跑通。不需要重做，需要的是**补齐能力缺口 + 打通三个项目的资产**。

---

## 一、三个项目的真实关系

| 项目 | 上游 | 形态 | 在 Web 方案中的角色 |
|---|---|---|---|
| `HGTV-ref` | `pan8664716/HGTV` | Android TV，Kotlin + ExoPlayer，单 APK | **协议事实来源**。签名、设备注册、播放路由、CENC 处理的最完整实现，有 20+ 单元测试（`SignerTest`、`MediaCryptoTest`、`LiveSigningProbeTest`） |
| `hongguoTV` | fork 自 `N3urda/hongguoTV` | React Native TV + 独立 Node 服务（`server/`） | **服务端架构参考**。Node 内容服务 + Docker 部署，`server/provider.mjs` 是可复用的桥接层 |
| `xiaoguoguo` | 你自己的 | React 19 + Vite + Node/Vercel/Workers | **Web 主体**。已经跑通，是继续开发的基线 |

关键点：`xiaoguoguo/server/src/vendor/hongguo.cjs` 是从 `woshishiq1/drpys` 固定的上游协议实现（GPL-3.0，未修改），它已经把 `xGorgon`、`helios`、`buildMedusa`、`deriveContentKey`、`decryptSpadeUrl`、`prepareCencHeader`、`decryptPartial` 全部导出。**所以签名和 DRM 这层你不用再写，三个项目的这部分是同源的。**

---

## 二、当前实测状态（我刚跑过）

```
npm install && npm run build && npm start     ✅
GET  /api/health                              ✅ {"account":"anonymous"}
GET  /api/home?page=1                         ✅ 真实数据，34 页
GET  /api/series/7694653385668037657          ✅ 详情 + 86 集
GET  /api/episodes/.../play                   ✅ {"quality":"360P","kind":"public"}
GET  /api/episodes/.../stream                 ✅ 10MB MP4，支持 Range
浏览器打开 /                                   ✅ 首页渲染完整
浏览器打开 /watch/.../:episodeId               ✅ video 实际播放
                                                currentTime=4.1s duration=79.5s
                                                readyState=4 无 error
设置页 /settings                               ✅ 三种登录方式 UI 完整
```

播放确实在跑：`videoWidth=360 videoHeight=640`，与 `quality:"360P"` 一致。

---

## 三、缺口清单（按优先级）

### P0 — 影响可用性

**1. 完整播放需要 Cookie，而 Cookie 获取路径偏重**

现在匿名只能看每部剧前几集 360P。要解锁完整剧集必须走三条路之一：手机号验证码、adb 从模拟器导出、扫码传输。对纯 Web 用户来说，这三条都不轻。

- 手机号登录：受平台频控（`error_code=7 访问太频繁`），且需要服务端保持内存态（Vercel 多实例会丢）
- adb 导入：要求本机有 Android 设备/模拟器
- 扫码传输：仍需要先在别处拿到 Cookie

**这是平台限制，不是代码缺陷**，但 Web 版应该把「公开预览能看几集」这件事在 UI 上说清楚，并且在 Cookie 失效时给出明确降级提示，而不是播放失败。

**2. Serverless 上账号态会丢**

`server/src/account.mjs` 把 Cookie 存在进程内存。部署到 Vercel 后每次冷启动都要重新填。README 已经承认这点，但没有给出多实例方案。

建议：给账号态加一个可选的持久化后端（Vercel KV / Upstash Redis），用 `x-xgg-device` 头做 key。`api.ts` 里已经有这个 header 的机制，只是服务端没用来存账号。

### P1 — 功能对齐

对比 `HGTV-ref` 的 14 项功能，Web 版缺：

| HGTV-ref 能力 | xiaoguoguo 现状 | 补法 |
|---|---|---|
| **榜单 / 热播榜（多榜单）** | ❌ 无 | `provider.mjs` 已导入 `api.rank*` 相关能力（vendor 里有 `rankCursor`），但没写 `rank()` 导出。加一个 `export async function rank()` + `/api/rank` |
| **分类页（大类/小类）** | ❌ 无 | vendor 已导出 `categoryData`，`home()` 只用了 `categoryPage` 的 recommendList。加 `/api/category?tab=&sub=` |
| **弹幕** | ❌ 无 | 服务端需加 `danmaku` 解析（HGTV-ref 有完整实现可对照），前端加 `<canvas>` 或 DOM 层 |
| **倍速播放 0.75–2×** | ❌ 无 | 纯前端：`video.playbackRate`，WatchPage 加一个 select |
| **清晰度切换** | ⚠️ 固定 ≤1080P | `resolvePlayback` 已经拿到 `qualityRows` 全部行，只是 `selected` 固定取第一条 ≤1080。改成返回列表 + 前端切换 |
| **自动连播** | ✅ 有 | — |
| **断点续播** | ✅ 有 | — |
| **收藏 / 历史** | ✅ 有（localStorage） | — |
| **搜索历史** | ✅ 有 | — |
| **追更 / 预约** | ❌ 无 | 需要账号态；`/reading/user/subscribe/*` |
| **点赞 / 评论** | ❌ 无 | `/novel/commentapi/*` |
| **定时停止** | ❌ 无 | 纯前端 |
| **播完推荐下一部** | ❌ 无 | `/novel/player/video_detail` 的 related |

### P2 — 工程与部署

- `server/src/provider.mjs` 644 行，`api.mjs` 320 行，路由用 if 链匹配。加到 20 个接口后会很难维护，建议引入轻量路由表。
- 没有测试。`HGTV-ref` 有 20+ 个 Kotlin 单测覆盖签名和 CENC，Web 版至少应该给 `provider.mjs` 的解析函数补几个快照测试。

---

## 四、推荐路线

### 路线 A（推荐）：在 xiaoguoguo 上增量补

不动架构，按 P1 顺序补功能。每补一个能力大约是：

1. `server/src/provider.mjs` 加一个 `export async function xxx()`，内部调 vendor 已有的 `api.*`
2. `server/src/api.mjs` 加一条路由
3. `web/src/lib/api.ts` 加类型 + 请求函数
4. `web/src/pages/*` 加 UI

榜单和分类是最容易的（vendor 里已有能力，只是没接线），建议先做这两个，能立刻让首页从「只有推荐流」变成「有内容分层」。

### 路线 B：把 hongguoTV/server 的桥接层搬过来

`hongguoTV/server/provider.mjs` 是另一套独立实现。可以对比两边的接口覆盖度，把 xiaoguoguo 缺的（尤其是弹幕、榜单）从那边移植。注意两边都是 GPL-3.0，许可证兼容。

### 路线 C：TV 端复用同一个 server

`HGTV-ref` 是 Android TV 原生，`hongguoTV` 是 RN TV。如果最终目标是「一份服务端，多端复用」，那么 xiaoguoguo 的 `server/` 应该成为唯一后端，TV 端只做 UI + 播放器，所有内容/签名/解密都请求它。这是三个项目最合理的合并方向，也是 `hongguoTV` README 里「独立 Node 服务负责内容接入与媒体分段处理，便于后续其他平台复用」的原意。

---

## 五、从 App 逆向里能补什么

前面逆向 `红果短剧.app` 得到的东西，对 Web 版的直接价值：

| 逆向发现 | 对 Web 版的用处 |
|---|---|
| `pkg/hgapi` 的 30+ 接口路径 | 补齐 `provider.mjs` 缺失的榜单/分类/评论/弹幕接口。路径已整理在 `hongguo-reverse/REPORT.md` 第 4.2 节 |
| `pkg/media/cenc` 的 `hideVideoTrak` / `hideVideoCodec` | 如果想做「纯音频模式」，这是唯一线索 |
| SQLite schema 的 local-first + `synced` 设计 | Web 版现在是纯 localStorage，多设备同步需要服务端有对应的 pending 队列，可以照这个模型设计 |
| `pkg/hgapi.rankCursor` / `categoryCursor` 的游标编码 | 榜单/分类的分页游标格式，比猜参数可靠 |
| `pkg/device` 的机型模板 | 设备注册的随机化策略，`device-register.mjs` 可以对照加强 |

**不能直接用**的：`X-Argus` / `X-Ladon` 的算法细节只还原到函数名，没有实现；`pkg/crypto` 的 TTEncryptV5 也没有伪代码。但这些 xiaoguoguo 的 vendor 里已经有了（`xGorgon`/`helios`/`buildMedusa`），所以不影响。

---

## 六、如果现在就要跑起来

```bash
cd /Users/lei/xiaoguoguo/xiaoguoguo

npm install
npm run build

# 本机
npm start                        # http://127.0.0.1:8788

# 局域网（手机访问 / 扫码导入 Cookie）
HOST=0.0.0.0 PORT=8788 npm start
```

开发模式（前端热更新）：

```bash
npm start                        # 终端 1
npm run dev                      # 终端 2 → http://127.0.0.1:5178
```

部署 Vercel：推到 GitHub，`vercel.json` 已配好，导入即部署。

服务我已经在 `127.0.0.1:8788` 起着了，可以直接打开看。

---

## 七、我需要你确认的两件事

1. **Web 版的定位**：是「自己/家人用」，还是要公网部署给别人用？前者不需要解决账号持久化，后者必须解决（否则每个访客都要自己填 Cookie，且共享同一份内存态会串号）。

2. **优先补哪个**：榜单 / 分类 / 弹幕 / 倍速，我建议按「榜单 → 分类 → 倍速 → 弹幕」的顺序，前两个是服务端已有能力只差接线，倍速是纯前端十分钟的事，弹幕最重。

你定了我就直接开工。
