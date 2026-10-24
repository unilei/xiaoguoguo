# 部署到 Vercel

小果果在 Vercel 上用「静态前端 + 一个 Serverless Function」部署。
Vercel 跑的是完整 Node.js 运行时，`node:crypto`（含 sm3）、`node:vm`、
`node:zlib`、`node:child_process` 都可用，服务端代码可以直接复用。

## 用 GitHub 自动部署（推荐）

1. 打开 <https://vercel.com/new>
2. 用 GitHub 登录，授权 Vercel 访问你的仓库
3. 选择 `unilei/xiaoguoguo`，点 **Import**
4. 保持默认配置（仓库里的 `vercel.json` 已经写好）：
   - Framework Preset：**Other**
   - Build Command：`npm run build`
   - Output Directory：`web/dist`
   - Install Command：`npm install`
5. 点 **Deploy**

首次部署约 1–2 分钟。完成后会得到一个 `*.vercel.app` 域名。
之后每次 `git push` 到 `main`，Vercel 都会自动重新部署。

## 本地用 CLI 部署

不用登录也能先验证整条链路：

```sh
npx vercel deploy --temporary
```

会在本地构建、上传，返回一个 `*.tmp.now` 地址，1 小时后自动过期。
适合改完之后确认接口和播放都正常。

要长期保留就先登录：

```sh
npx vercel login      # 浏览器授权
npx vercel deploy     # 部署到预览环境
npx vercel deploy --prod   # 部署到生产环境
```

## 当前部署

生产环境：<https://xiaoguoguo.vercel.app>（Vercel 项目 `xiaoguoguo`，账号 `unilei-github`）。
改动后用 `npx vercel deploy --prod` 重新发布。

## 配置说明

`vercel.json` 里做了五件事：

| 配置 | 作用 |
| --- | --- |
| `regions: ["hkg1"]` | 函数跑在香港。默认的 `iad1`（华盛顿）离视频源站太远，每个 Range 请求要多花 400–600ms |
| `rewrites` | `/api/*` 和 `/import/*` 交给 Serverless Function，其余路径回退到 `index.html`（SPA 路由） |
| `functions.maxDuration: 60` | 视频按 1MB 分块产出，60s 足够；这也是 Vercel 允许的上限 |
| `functions.includeFiles` | 把 `server/src/vendor/**` 一起打包，否则函数里找不到协议实现 |
| `headers` | 暴露 `x-xgg-device`，让前端在请求间传递设备身份 |

## 性能相关的两个实现细节

**首页分类走 preview 模式。** `/api/category` 默认会把 24 个子分类首尾相接聚合成
一个虚拟长表（真人剧 1 万多部），代价是要先探测每个子分类的总量，二十多次上游
请求、实测 20 秒以上。首页只需要每类前 9 张卡片，所以前端带 `preview=1`，服务端
直接回源站第一页，900ms 出结果。分类页仍然走完整聚合。

**CENC 索引跨请求缓存。** 播放器一个视频会发几十个 Range 请求，每个都是独立的
HTTP 请求。索引（moov + sample 表 + 文件头）按媒体地址缓存在函数实例内存里，
带 5 分钟 TTL 和 LRU 淘汰，并发的同源请求共用一次构建。不缓存的话每个请求都
要重拉 256KB 文件头并重解析，实测 228ms。

## 需要注意

- **函数实例不共享内存**：登录态存在单个函数实例的内存里，Vercel 可能会把请求
  分配到不同实例，导致登录态偶发丢失。用环境变量 `ACCOUNT_COOKIE` 注入可以
  绕开这个问题（`api/index.mjs` 启动时会读取）。匿名状态本来就能播完整剧集，
  所以不配也能用。
- **免费额度**：Hobby 计划每月 100 GB 流量、100 万次函数调用、4 小时 CPU。
  一集约 6MB，大约 1.6 万次播放会打满流量。
- **Hobby 仅限非商业用途**：条款明确禁止广告、付费等商业化用法。
- **公开访问**：默认域名是公开的。如果要登录自己的账号，建议在
  Vercel 项目设置里开启 Password Protection 或 Deployment Protection。
- **本项目的定位**：仅用于本地学习研究，不应公开重新部署（见 README 的说明）。
  临时部署用 `npx vercel deploy --temporary`，1 小时内自动过期，适合验证。

