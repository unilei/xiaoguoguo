# 部署到 Vercel

小果果在 Vercel 上用「静态前端 + 一个 Serverless Function」部署。
Vercel 跑的是完整 Node.js 运行时，所以不需要像 Cloudflare Workers 那样改造：
`node:crypto`（含 sm3）、`node:vm`、`node:zlib`、`node:child_process` 都可用。

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

## 本地用 CLI 部署（备选）

```sh
npm install -g vercel
vercel login          # 浏览器授权
vercel                # 部署到预览环境
vercel --prod         # 部署到生产环境
```

## 配置说明

`vercel.json` 里做了三件事：

| 配置 | 作用 |
| --- | --- |
| `rewrites` | `/api/*` 和 `/import/*` 交给 Serverless Function，其余路径回退到 `index.html`（SPA 路由） |
| `functions.maxDuration: 60` | 视频流可能持续较久，给足执行时间 |
| `functions.includeFiles` | 把 `server/src/vendor/**` 一起打包，否则函数里找不到协议实现 |

## 与 Cloudflare Workers 的差异

| 项目 | Vercel | Cloudflare Workers |
| --- | --- | --- |
| 运行时 | 完整 Node.js | 受限，`node:crypto` 无 `createHash` |
| vendor 加载 | 直接 `vm` 加载 | 必须静态转换 |
| sm3 | 原生支持 | 需自带纯 JS 实现 |
| adb 导入 | **可用**（有子进程） | 不可用 |
| 状态存储 | 函数实例内存 | 需要 KV |

**结论：Vercel 明显更合适。** 这也是为什么 Cloudflare 那版在设置页点「获取验证码」会报
`crypto.createHash is not a function` —— 那是 Workers 运行时缺少该 API，Vercel 不会有这个问题。

## 需要注意

- **函数实例不共享内存**：登录态存在单个函数实例的内存里，Vercel 可能会把请求
  分配到不同实例，导致登录态偶发丢失。如果要稳定保存，建议接一个外部存储
  （如 Upstash Redis / Vercel KV），当前实现没有做。
- **免费额度**：Hobby 计划每月 100 GB 流量、100 万次函数调用。
  视频是逐段透传，不计入 Vercel 的带宽之外还有 Cloudflare 前置缓存，
  日常使用足够。
- **公开访问**：默认域名是公开的。如果要登录自己的账号，建议在
  Vercel 项目设置里开启 Password Protection 或 Deployment Protection。
