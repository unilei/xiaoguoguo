# 小果果

红果短剧的非官方 **Web 客户端**。浏览、搜索、选集、播放、收藏与续播都在浏览器里完成，
手机和电脑都能用；界面是深色暖调，适配桌面与移动端。

> 与红果官方无关联。内容接口为非官方实现，平台改版可能导致功能失效。

## 能做什么

- **发现**：官网首页推荐、轮播推荐位、无限滚动分页（每页 24 部）。
- **搜索**：关键词搜索，带搜索历史与分页加载。
- **详情**：剧集信息、标签、完整分集列表（每 20 集分组）。
- **播放**：自建播放器，支持播放/暂停、前后 10 秒、上下集、自动连播、断点续播。
- **我的**：本机收藏、最近观看、进度条，数据只存在浏览器 localStorage。
- **设置**：可选填自己的账号 Cookie，解锁公开预览之外的剧集。

## 快速开始

需要 Node.js 22 或更新版本。

```sh
npm install
npm run build          # 构建前端
npm start              # 启动服务（默认 http://127.0.0.1:8788）
```

开发模式（前端热更新，Vite 代理 `/api` 到 8788）：

```sh
npm start              # 终端 1：内容服务
npm run dev            # 终端 2：前端 http://127.0.0.1:5178
```

想让同一局域网内的手机访问：

```sh
HOST=0.0.0.0 PORT=8788 npm start
```

## 播放能力说明

平台从 2026-10-15 起不再向**匿名请求**下发完整播放地址。因此：

| 场景 | 是否需要账号 | 覆盖范围 |
| --- | --- | --- |
| 浏览 / 搜索 / 详情 | 不需要 | 全部剧集 |
| 播放（公开预览） | 不需要 | 每部剧前几集，360P |
| 播放（完整剧集） | 需要自己的 Cookie | 该账号可见的清晰度 |

在「设置 → 账号 Cookie」粘贴你在红果 App / 网页端的整段 Cookie 即可解锁完整播放。
Cookie 只保存在服务进程内存里，不写入仓库、日志或前端存储，服务重启后需重新填写。
请只使用你自己的账号，不要分享或提交到代码仓库。

### 怎么拿到 Cookie

**先说清楚：红果没有网页登录。** 官网 `hongguoduanju.com` 首页与详情页都没有登录入口，
`passport.snssdk.com` 只返回 401 认证中心壳页，番茄小说站也没有登录入口。
登录态只存在于**红果 App** 里，平台也没有开放可用的网页 OAuth。
所以小果果**不提供账号密码登录**，也没有"扫一扫就自动登录"的能力——
任何声称能扫码直接登录红果的，都需要你交出账号密码或验证码，不建议使用。

可行的方式只有一种：从**已登录的红果 App** 里把登录态导出来。

**方式一：手机抓包（唯一能拿到完整登录态的方式）**

1. 手机上安装 mitmproxy / Charles / Stream 之类的抓包工具并信任其证书；
2. 打开红果 App，随便浏览一下（触发一次带登录态的请求）；
3. 在抓包记录里找到 `api5-normal-*.fqnovel.com` 的请求，
   复制请求头里的整段 `Cookie`（包含 `sessionid`、`sid_tt`、`uid_tt`、`sid_guard` 等）。

这一步偏技术，如果你只是想看剧，用公开预览就够了，不需要折腾。

**方式二：导出 App 的 cookie 文件（需要 root 或模拟器）**

红果 App 把登录态写在 `shared_prefs/cookieStore.xml`。有 root 的手机或 Android 模拟器
可以直接取出这个文件，小果果能识别其中 `snssdk.com` 那组 Cookie。
这也是上游 HGTV 客户端推荐的导入方式。

拿到 Cookie 后有两种填入方式：

- **扫码传输（推荐）**：设置页点「生成二维码」，手机扫码打开导入页，在手机上粘贴 Cookie，
  电脑端自动接收并校验。二维码 5 分钟内有效、只能用一次。**注意：这是把 Cookie 从手机传到电脑，不是登录。**
- **直接粘贴**：在设置页的文本框里粘贴，点「验证并保存」。

扫码传输需要手机能访问电脑，因此启动时要监听局域网：

```sh
HOST=0.0.0.0 PORT=8788 npm start
```

只在本机使用时保持默认的 `127.0.0.1` 即可，此时设置页会提示二维码无法用手机访问。
导入时会请求一次账号资料接口校验 Cookie；无效或过期的 Cookie 会被明确拒绝，
不会出现"看起来导入成功、其实什么都没解锁"的情况。

> Cookie 等同于账号凭据，请不要发给别人、不要提交到仓库，也不要在公共电脑上使用。
> 平台修改接口后该方式可能失效。

## 架构

```
web/      React 19 + Vite + TypeScript 单页应用
server/   Node HTTP 服务：官网 SSR 解析、设备注册、请求签名、播放代理
          └─ src/vendor/hongguo.cjs  固定版本的上游协议实现（GPL-3.0）
```

服务端负责三件事：

1. **内容**：官网 `_ROUTER_DATA` 解析首页/详情，App 签名接口做搜索。
2. **身份**：匿名设备注册（`device_register`），拿到平台认可的 `device_id` / `install_id`。
3. **播放**：公开预览直链透传；账号模式下解析 `video_model`、解密 spade 地址，
   按 Range 拉取并用 CENC 索引逐样本解密后回给浏览器（支持 206 分段）。

浏览器只和本服务通信，不直接接触上游签名材料。

## 接口

| 请求 | 返回 |
| --- | --- |
| `GET /api/health` | 服务状态与账号模式 |
| `GET /api/home?page=1` | `{ items, page, totalPages }` |
| `GET /api/search?q=关键词&page=1` | `{ items, page, hasMore }` |
| `GET /api/series/:id` | 剧集详情 + `episodes` |
| `GET /api/episodes/:id/play` | `{ path, quality, kind }` |
| `GET /api/episodes/:id/stream` | MP4 流，支持 Range |
| `POST /api/account` | `{ cookie }` 校验并设置/清除账号 Cookie |
| `POST /api/account/qr` | 生成一次性扫码导入会话（含二维码 Data URL） |
| `GET /api/account/qr/:token` | 查询扫码会话是否仍有效 |
| `GET /import/:token` | 手机端 Cookie 导入页 |
| `POST /import/:token` | 手机端提交 Cookie（校验通过才保存） |

## 来源与许可证

本项目按 **GPL-3.0** 发布，派生自：

- [N3urda/hongguoTV](https://github.com/N3urda/hongguoTV)（GPL-3.0）：
  官网 SSR 解析、Node 内容服务与协议适配思路；
- [pan8664716/HGTV](https://github.com/pan8664716/HGTV)（GPL-3.0，上游 fork）：
  设备注册、签名分支、播放接口路由与 CENC 处理的实现依据。

`server/src/vendor/hongguo.cjs` 是 [woshishiq1/drpys](https://github.com/woshishiq1/drpys)
固定提交的原始文件，未做修改，见同目录 `NOTICE.md` 与 `LICENSE.drpys`。

本项目不提供下载、不绕过付费或登录限制，仅用于个人学习与自用。
