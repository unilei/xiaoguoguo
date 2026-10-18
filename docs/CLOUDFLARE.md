# 部署到 Cloudflare Workers

小果果可以跑在 Cloudflare Workers 上。前端是静态资源，后端是 Worker；
不需要服务器，按 Cloudflare 免费额度计算，每天 10 万次请求以内不收费。

## 已实测的能力

我用 miniflare / wrangler 在本地 Workers 运行时里逐项验证过：

| 能力 | 结果 |
| --- | --- |
| 首页、详情 | 正常 |
| 搜索（签名接口） | 正常 |
| 播放地址解析 | 正常 |
| 视频分段流（Range / 206） | 正常，ffprobe 确认 H.264 + AAC |
| 静态资源 + SPA 路由 | 正常 |
| 手机号登录、Cookie 校验 | 接口可用 |
| adb 从设备导入 | **不可用**（Worker 没有子进程），设置页会自动隐藏该面板 |
| 扫码传输 Cookie | 可用，但需要 KV 保存会话 |

## 关键改造

Cloudflare Workers 与 Node 有三处不兼容，都已处理：

1. **禁止运行时动态执行代码**。Workers 里 `eval` / `new Function` / `node:vm`
   都不可用，而原实现用 `vm.runInContext` 加载 vendor。
   解决：`worker/build-vendor.mjs` 把 vendor 静态转换成 ES 模块。
2. **`node:crypto` 没有 sm3**（实测报 `Digest method not supported`）。
   解决：`server/src/sm3.mjs` 是纯 JS 的 SM3 实现，已与 Node 原生结果逐字节对照通过。
3. **内存态在边缘节点间不共享**。设备身份和账号 Cookie 改为存 KV。

其余（`node:crypto` 的 md5 / sha512 / AES-CBC / AES-CTR、`node:zlib`、Buffer）
在 Workers 里都原生支持，实测通过。

## 部署步骤

```sh
# 1. 安装依赖
npm install                      # 根目录
npm install --prefix worker

# 2. 建一个 KV 命名空间（保存设备身份与登录态）
npx wrangler kv namespace create XGG_KV
# 把输出里的 id 填进 worker/wrangler.jsonc 的 kv_namespaces[0].id

# 3. 构建并部署
cd worker
npm run deploy
```

`npm run deploy` 会自动：
- 重新生成 `vendor-worker.js`
- 构建 `web/dist`
- 上传 Worker + 静态资源

首次部署后，Wrangler 会给出一个 `*.workers.dev` 域名，直接访问即可。

## 本地预览

```sh
cd worker
npm run dev        # http://127.0.0.1:8787
```

本地模式同样使用 KV 的本地模拟，不需要 Cloudflare 账号。

## 注意事项

- **免费额度**：每天 10 万次请求、每次 10ms CPU。视频流是逐段透传，
  CPU 主要花在 CENC 解密上，实测单段（512KB）远低于 10ms。
  如果流量大，升级到付费版（5 分钟 CPU）更稳。
- **出站请求数**：免费版每个请求最多 50 个子请求。当前一次播放最多
  3 次上游请求（解析 + 索引 + 分段），不会触顶。
- **Cookie 安全**：登录态存在 KV 里，请只部署到自己的账号下，
  不要公开演示站点，也不要开启公共访问。
- **adb 导入不可用**：Worker 没有子进程。用手机号登录、扫码传输或手动粘贴。
- **平台频控**：手机号验证码接口按 IP 频控，Cloudflare 出口 IP 可能已被共享，
  如果一直返回「访问太频繁」，可以改用 Cookie 方式登录。

## 为什么不建议用 Cloudflare Pages

Pages 的 Functions 与 Workers 同源，但静态资源与函数的绑定方式不同，
本项目已按 Workers + Static Assets 组织，直接用 Workers 部署更简单。
