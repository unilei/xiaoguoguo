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

**匿名就能播完整剧集。** 服务端走 App 的移动端播放接口，不需要账号：

| 场景 | 是否需要账号 | 覆盖范围 |
| --- | --- | --- |
| 浏览 / 搜索 / 详情 | 不需要 | 全部剧集 |
| 播放（App 接口） | 不需要 | **整部剧**，360P–720P |
| 播放（官网公开预览） | 不需要 | 每部剧前 3 集，360P（仅作兜底） |

早期版本只用了官网的 `/video/public/<vid>/360p.mp4`，那条路确实只开放前几集。
现在改走 `/novel/player/multi_video_model/v1/`，返回的 `video_model.video_list`
带全部分集的 CDN 地址，匿名可用。参数照桌面端抓包还原，几个必须对齐的点：

- host 用 `api5-normal-lq.fqnovel.com`（`sinfonline` 线路回 `110001`）
- `biz_param.device_level` 必须是 **4**（传 3 回 `110001`）
- query 要带齐 `channel=xiaomi_8662_64`、`dragon_device_type=phone`、
  `compliance_status=0`、`version_code=73932` 等移动端字段
- `mixed_video_id_map` 按 content_type 分组，短剧是 `"1004"`
- 返回的 `main_url` 是 **base64**，要先解码；`spade_a` + `key_seed` 同时存在时
  还要解一层 SPADE

App 接口拿不到时才退回官网公开预览。账号 Cookie 仍然有用：某些剧集可能需要
登录态才下发地址，这时在「设置 → 账号 Cookie」填入自己的 Cookie 即可。

Cookie 不写入仓库、日志或前端存储。**本地 / 自托管部署时**它会以 0600 权限保存在
`server/.data/account-cookie`，重启后自动恢复，不用每次重填；`.data/` 已在 `.gitignore` 里。
想换位置就设 `ACCOUNT_COOKIE_FILE`。

匿名设备身份也保存在 `server/.data/device.json`（同样 0600），可用
`DEVICE_IDENTITY_FILE` 改位置。这一项不能省：平台把发码凭证绑在 `device_id` 上，
每次重启换新设备会让用户手里的验证码凭证立刻失效。

**Serverless（Vercel 等）没有共享磁盘**，请用环境变量 `ACCOUNT_COOKIE` 注入登录态；
匿名设备身份则依赖前端回传的 `x-xgg-device` 请求头在发码与登录之间保持一致。
进程内保存的登录态会在冷启动后丢失。设置页顶部会显示当前是「已登录」还是「匿名模式」。

请只使用你自己的账号，不要分享或提交到代码仓库。

### 怎么登录

有三种方式，按推荐顺序：

#### 方式一：手机号 + 验证码（设置页直接登录）

红果账号的手机号收验证码即可登录，未注册的手机号会自动创建账号。
参数与流程照 HGTV v1.1.5.1 APK 与红果桌面端（Wails/Go）的实际调用还原：

| 步骤 | 接口 | 关键参数 |
| --- | --- | --- |
| 发验证码 | `POST /passport/mobile/send_code/v1/` | `mobile="+86…"`、`account_sdk_source=app`、`passport_support_flow="captcha,verify"`、`mix_mode=1`、`auto_read=0`、`type=101` |
| 换登录态（主） | `POST /passport/mobile/sms_login/` | `mobile`、`code`、`sms_code_key`（上一步返回）、`passport_mfa_retry_tag=1` |
| 换登录态（备） | `POST /passport/upsms/verify/` | `mobile`、`code`、`verify_way=sms`、`verify_scene=login`、**`verify_ticket`** |

这些接口都在 `api5-normal-*.fqnovel.com` 线路下（`passport.snssdk.com` 对这些路径回 404），
并带上匿名设备注册得到的 `device_id` / `iid`。发码响应里下发的 `passport_csrf_token`
会按手机号记住，登录时一并带上，让两次请求落在同一个会话上下文里。

**登录走双路径**，这是照 App 的 `flow.(*Login)` 实现的：`SMSLogin` 没能直接换到
session 时（返回 1066），再用同一条凭证换字段名走 `UpsmsVerify`。两个接口的凭证
字段名不同，这是最容易踩的坑：

| 接口 | 凭证字段 | 传错字段的后果 |
| --- | --- | --- |
| `sms_login` | `sms_code_key` | 传 `mobile_ticket` → `1203`「错误次数过多或验证码过期」，看起来像验证码错了 |
| `upsms/verify` | `verify_ticket` | 传 `sms_code_key` → `3`「缺少参数」 |

两个接口的错误码含义也不一样，可以据此判断问题出在哪：

- `1045`「认证失败」= 凭证被接受，**验证码不对**
- `1066`「长时间未操作，验证已过期」= 凭证本身失效，要重新发码
- `1203` = 凭证字段名不对或没带
- `3`「缺少参数」= 请求参数结构不对

> **1066「长时间未操作，验证已过期」的真实原因**：
>
> 1. **`sms_login` 只走了第一步**。App 的登录是两步：`SMSLogin` 拿不到 session 时
>    还要用同一条凭证走 `UpsmsVerify`。只做第一步就只会看到 1066，
>    实际凭证是好的——代码现在会自动走第二步，看到 `1045` 就说明凭证没问题。
> 2. **拿的是旧凭证**。平台每次重新发码都会作废旧凭证，即使号码没变。
>    所以「短信刚收到」不等于「手里的 ticket 还是新的」。
> 3. **设备身份变了**。凭证按 `device_id` 绑定；服务重启后如果重新注册设备，
>    旧凭证立刻失效。本地部署已把设备身份存进 `server/.data/device.json`，重启复用同一台。
> 4. **号码本身被平台拒绝**。此时发码返回 `1003`，`description` 是
>    「手机号错误，请重新填写」——`1003` 是号码问题，不是频控。
>
> 只有 1066 / 1203 时接口才带 `expired: true`，前端据此清掉本地凭证并清空验证码框。
> `1045` 表示验证码填错了，凭证仍可继续用，不清空。

> **实测注意**：同一 IP / 同一设备短时间内多次调用会返回 `error_code=7 访问太频繁`
> 或 `1206`（发码冷却）。冷却期间平台仍下发新 ticket，收到过短信就可以直接填验证码登录。

#### 方式二：从模拟器 / 手机导入

设备上已有官方 App 的登录态时，小果果可以用 adb 直接把
`shared_prefs/cookieStore.xml` 读出来，不用手动拼 Cookie。
适合模拟器或已 root 的手机：确认 `adb devices` 能看到设备，点「从设备导入」。

#### 方式三：手动粘贴 / 扫码传输

已经用抓包工具拿到 Cookie 的话，可以直接粘贴；或点「生成二维码」，
手机扫码后把 Cookie 粘贴到手机页面上传回电脑（这**只是传输**，不是登录）。

#### 关于官网

`hongguoduanju.com` 本身没有登录入口——它只做浏览和播放，登录走的是 App 的 passport 通道。
因此网页端无法「在官网登录后取 Cookie」，必须用上面三种方式之一。

#### 有效期

`sid_guard` 的四段是 `sessionid | 签发时间戳 | max-age | 人类可读时间`，
**过期 = 签发 + max-age**（实测约 60 天），第三段不是过期时间戳。
平台不会自动续期：业务接口不返回 `Set-Cookie`，refresh 端点要么空壳要么无权限。
到期后需要重新登录或重新导入。设置页会显示剩余天数。

> Cookie 等同于账号凭据，请不要发给别人、不要提交到仓库，也不要在公共电脑上使用。
> 平台修改接口后该方式可能失效。

## 部署

> **状态：已于 2026-11-25 下线。** 服务器上的容器、镜像、`/opt/xiaoguoguo` 目录
> 以及仓库的 deploy workflow、3 个部署 secret 全部删除。下面保留完整记录，
> 需要重新上线时照着做即可（`Dockerfile`、`docker-compose.server.yml` 仍在仓库里）。

### Docker + GitHub Actions（曾用于生产，现已下线）

原生产地址：`http://198.44.125.49:8788`

推 `main` 自动部署：

```
git push main
  → Actions 构建镜像，推 ghcr.io/unilei/xiaoguoguo:sha-<commit>（同时打 latest）
  → SSH 到服务器：写 .image-tag / .env → docker compose pull → up -d → 等 health 通过
```

服务器侧（`/opt/xiaoguoguo/`）：

```
docker-compose.yml     与仓库的 docker-compose.server.yml 同源
.env                   IMAGE_VERSION=<sha>，CI 每次覆盖
.image-tag             同上，人可读
data/                  挂到容器 /app/server/.data
```

**`data/` 别删。** 里面是 `device.json` 和 `account-cookie`；容器重建若换掉
device.json，平台会当成一台新设备，而 device_id 是会被按线路限流的（见
`server/src/provider.mjs` 里线路池那段注释）。

回滚到任意 commit（镜像 tag 就是 commit sha）：

```bash
ssh root@198.44.125.49 'cd /opt/xiaoguoguo \
  && sed -i "s|^IMAGE_VERSION=.*|IMAGE_VERSION=sha-<完整commit>|" .env \
  && docker compose up -d'
```

需要 3 个仓库 secret：`DEPLOY_HOST` / `DEPLOY_USER` / `DEPLOY_SSH_KEY`。
改了 `docker-compose.server.yml` 要手动同步到服务器——CI 只跑 SSH 命令，不传文件。

### Vercel

Vercel 跑完整 Node.js，服务端可直接复用：

1. 打开 <https://vercel.com/new>，用 GitHub 授权并导入 `unilei/xiaoguoguo`
2. 保持默认配置（`vercel.json` 已写好），点 Deploy
3. 之后每次 `git push` 都会自动部署

详见 [Vercel 部署说明](docs/VERCEL.md)。

> Vercel 没有共享磁盘，`device.json` 会随冷启动丢失，设备身份靠前端回传的
> `x-xgg-device` 维持。自托管（Docker）没有这个问题，所以现在以 Docker 为主。

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
| `GET /api/series/:id` | 剧集详情 + `episodes` + `previewEpisodes`（匿名可播集数，null 表示未探测） |
| `GET /api/episodes/:id/play` | `{ path, quality, kind }`；匿名且超出预览范围时返回 402 `{ reason: "login_required" }` |
| `GET /api/episodes/:id/stream` | MP4 流，支持 Range |
| `POST /api/account` | `{ cookie }` 校验并设置/清除账号 Cookie |
| `POST /api/account/sms/send` | `{ mobile }` 发送登录验证码 |
| `POST /api/account/sms/login` | `{ mobile, code, smsCodeKey }` 换登录态 |
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
