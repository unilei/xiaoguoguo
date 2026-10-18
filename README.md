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

### 怎么登录（照上游的实测结论）

先说结论：**红果没有网页登录，手机号验证码和平台扫码都走不通。**
这不是我猜的，是上游 [HGTV `tools/login-lab`](https://github.com/pan8664716/HGTV/tree/main/tools/login-lab)
逐条实测并写进 README 的：

| 路径 | 实测结果 |
| --- | --- |
| 官网 `hongguoduanju.com` | 首页、详情页均无登录入口 |
| `passport.snssdk.com` | 返回 401「认证中心」，是业务网关不是登录页 |
| 手机号 + 验证码（`send_code`） | 短信**能发出**，但 `validate_code` 换登录态一律回 `会话过期`，`login/v1` 回 `该应用无权限` |
| 官方扫码接口 | 全部 `error_code=16 该应用无权限` |
| `sso.douyin.com` | 真浏览器能出扫码页，但对非浏览器请求 403（指纹层） |

所以小果果和上游一样，只提供**唯一真正可行**的方式：
**在已登录的设备上，把 App 的登录态读出来。**

#### 方式一：从模拟器 / 手机导入（推荐，设置页一键完成）

1. 在 Android 模拟器（需 root，如 MuMu）或已 root 的手机上安装红果 App 并登录；
2. 确认电脑上 `adb devices` 能看到设备；
3. 打开小果果「设置 → 从手机 / 模拟器导入」，点「从设备导入」。

小果果会通过 adb 读取 App 的 `shared_prefs/cookieStore.xml`，按
`TC_STRING(0x74) + u2 长度` 解析出 Cookie，再请求一次账号资料接口验证。
这一步与上游 `dump_device.py` 的逻辑一致。

#### 方式二：手动粘贴 / 扫码传输

如果你已经用抓包工具拿到了 Cookie，可以直接粘贴到设置页；或者点「生成二维码」，
手机扫码后把 Cookie 粘贴到手机页面上传回电脑（这**只是传输**，不是登录）。

> 设备档案（`device_id` / 机型）只作记录：上游实测用模拟器那套反而会被平台限流，
> 因此签名仍使用内置档案，与上游结论一致。

#### 有效期

`sid_guard` 的四段是 `sessionid | 签发时间戳 | max-age | 人类可读时间`，
**过期 = 签发 + max-age**（实测约 60 天），第三段不是过期时间戳。
平台不会自动续期：业务接口不返回 `Set-Cookie`，refresh 端点要么空壳要么无权限。
到期后需要在设备上重新登录一次，再导入一次。设置页会显示剩余天数。

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
| `GET /api/account/devices` | 列出 adb 可见设备 |
| `POST /api/account/device` | `{ serial }` 从设备导出登录态并验证 |
| `POST /api/account/qr` | 生成一次性扫码传输会话（含二维码 Data URL） |
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
