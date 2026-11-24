# 部署到自有服务器（Docker + GitHub Actions）

生产环境：**http://198.44.125.49:8788**

推 `main` 自动部署。这台机器上另有一套同模式的 `aipanme` 在跑，运维习惯保持一致。

```
git push main
   │
   ├─ Actions / build：docker buildx → ghcr.io/unilei/xiaoguoguo:sha-<commit> (+ latest)
   │
   └─ Actions / deploy：SSH 到服务器
        cd /opt/xiaoguoguo
        echo IMAGE_VERSION=sha-<commit> > .env
        docker compose pull && up -d
        等 health 通过 → 清旧镜像
```

## 为什么不在服务器上 build

服务器 3.8G 内存常驻占用 2.2G（aipanme + mongo），`vite build` 峰值接近 1G，
和现有服务抢内存容易 OOM。CI 构建还能复用 layer cache，第二次部署实测 24 秒。

---

## 1. 前置条件

| 项 | 要求 |
|---|---|
| 服务器 | Ubuntu 22.04 / 24.04，Docker 24+，Compose v2+ |
| 仓库权限 | 能推 `main`、能配 repo secrets |
| 仓库可见性 | public 最省事（GHCR 匿名拉取）；private 见 §6.2 |
| 部署密钥 | 一对专用 ed25519，公钥已加进服务器 `~/.ssh/authorized_keys` |

本机部署用的私钥是 `~/.ssh/aipan_actions_198`（与 aipanme 共用）。**不要用日常登录
私钥**——CI 只该拿到一把能登录、可随时吊销的专用钥匙。

---

## 2. 首次初始化（只做一次）

### 2.1 服务器：建目录

```bash
ssh -i ~/.ssh/aipan_actions_198 root@198.44.125.49 \
  'mkdir -p /opt/xiaoguoguo/data && chmod 700 /opt/xiaoguoguo/data'
```

`data/` 权限必须是 700：里面会落 `account-cookie`（0600），目录本身不该给别人读。

### 2.2 服务器：放 compose

仓库里的 `docker-compose.server.yml` 是**版本源**，需要手动推一份到服务器：

```bash
cd ~/MyAIProjects/xiaoguoguo/xiaoguoguo
scp -i ~/.ssh/aipan_actions_198 docker-compose.server.yml \
    root@198.44.125.49:/opt/xiaoguoguo/docker-compose.yml
```

> CI 只跑 SSH 命令，不会传这个文件。改了仓库里那份，记得回来同步，否则会漂移。

### 2.3 仓库：配 3 个 secret

```bash
gh secret set DEPLOY_HOST   --body "198.44.125.49"      -R unilei/xiaoguoguo
gh secret set DEPLOY_USER   --body "root"               -R unilei/xiaoguoguo
gh secret set DEPLOY_SSH_KEY < ~/.ssh/aipan_actions_198 -R unilei/xiaoguoguo

gh secret list -R unilei/xiaoguoguo   # 确认三条都在
```

### 2.4 触发首次部署

```bash
git push origin main
# 或在 Actions 页面点 Run workflow（workflow_dispatch）
```

### 2.5 确认 GHCR 包可匿名拉取

服务器 `~/.docker/config.json` 里 `auths` 是空的也能拉，说明包是 public。
若拉取报 `denied`，见 §6.2。

```bash
ssh -i ~/.ssh/aipan_actions_198 root@198.44.125.49 \
  'cat ~/.docker/config.json; docker image ls ghcr.io/unilei/xiaoguoguo'
```

---

## 3. 日常部署

只做一件事：

```bash
git push origin main
```

CI 里 deploy job 实际执行（对应 `.github/workflows/deploy.yml`）：

```bash
cd /opt/xiaoguoguo
TAG="sha-<commit>"
echo "IMAGE_VERSION=$TAG" > .env      # compose 读这个
echo "$TAG" > .image-tag              # 人可读，回滚时直接改
docker compose pull
docker compose up -d --remove-orphans
# 轮询容器 health，最多 60 秒；unhealthy 就直接失败并打日志
docker image prune -f
```

部署成功的判据是**容器变成 healthy**，不是 `up -d` 返回 0。CI 里这段轮询就是
为了挡住「CI 绿了但容器起不来」的情况。

手动触发（不改代码、只重跑）：

```bash
gh workflow run deploy.yml -R unilei/xiaoguoguo
gh run watch -R unilei/xiaoguoguo
```

---

## 4. 部署后验证清单

```bash
BASE=http://198.44.125.49:8788

# 1) 服务活着
curl -s $BASE/api/health

# 2) 自动取一部剧和它的第一集，省得手抄 id
SID=$(curl -s "$BASE/api/home" | python3 -c 'import sys,json;print(json.load(sys.stdin)["items"][0]["id"])')
EID=$(curl -s "$BASE/api/series/$SID" | python3 -c 'import sys,json;print(json.load(sys.stdin)["episodes"][0]["id"])')
echo "series=$SID episode=$EID"

# 3) 详情：可播集数应等于总集数（说明走的是 App 接口，不是官网预览）
curl -s "$BASE/api/series/$SID" | python3 -c \
  'import sys,json;d=json.load(sys.stdin);print("总集数",len(d["episodes"]),"可播",d["previewEpisodes"])'

# 4) 播放地址：720P 才算正常；360P + kind:public 是退到官网预览了
curl -s "$BASE/api/episodes/$EID/play"

# 5) 视频流：应返回 206 且首字节是 ftyp
curl -s -r 0-63 "$BASE/api/episodes/$EID/stream" | xxd | head -2
```

服务器侧：

```bash
ssh -i ~/.ssh/aipan_actions_198 root@198.44.125.49 \
  'cat /opt/xiaoguoguo/.image-tag; docker ps --filter name=xiaoguoguo; ls -l /opt/xiaoguoguo/data'
```

**关键检查：`data/device.json` 必须一直在。** 它是设备身份，容器重建后如果没了，
平台会当成一台新设备。而 device_id 是会被按线路限流的（`lq`/`sinfonline` 组回
200 空体），换设备不一定更好。

---

## 5. 回滚

镜像 tag 就是 commit sha，改 `.env` 再拉起即可：

```bash
ssh -i ~/.ssh/aipan_actions_198 root@198.44.125.49 \
  'cd /opt/xiaoguoguo \
   && sed -i "s|^IMAGE_VERSION=.*|IMAGE_VERSION=sha-<完整commit>|" .env \
   && docker compose up -d'
```

查看可用历史版本：

```bash
ssh -i ~/.ssh/aipan_actions_198 root@198.44.125.49 \
  'docker image ls ghcr.io/unilei/xiaoguoguo --format "{{.Tag}}\t{{.CreatedAt}}"'
```

注意 `docker image prune -f` 只清 dangling 镜像，带 tag 的历史版本会保留，
回滚时可离线使用。

回滚后要**顺手把 `.image-tag` 也改回去**，否则下次看文件会误判线上版本。

---

## 6. 常见问题

### 6.1 容器起不来

```bash
ssh -i ~/.ssh/aipan_actions_198 root@198.44.125.49 \
  'cd /opt/xiaoguoguo && docker compose logs --tail=80'
```

最常见是 `data/` 目录权限不对（容器内以 root 跑，宿主目录属主异常会写入失败）。

### 6.2 拉镜像 401 / denied

GHCR 包默认 private。两条路：

**A. 把包设成 public（推荐，仓库本身就是 public）**

GitHub → 个人头像 → Your packages → `xiaoguoguo` → Package settings →
Danger Zone → Change visibility → Public。

**B. 服务器登录 GHCR（仓库 private 时必须）**

```bash
echo "<PAT，需 read:packages>" | docker login ghcr.io -u unilei --password-stdin
```

注意 B 会在服务器留长期凭证，优先 A。

### 6.3 外网访问不通，服务器上 curl 却正常

先确认容器端口映射：

```bash
docker ps --filter name=xiaoguoguo --format '{{.Ports}}'   # 0.0.0.0:8788->8788/tcp
```

再查防火墙：

```bash
ufw status | grep 8788
# 没放行就：ufw allow 8788/tcp
```

云厂商的安全组（RackNerd 一般没有）也要看一眼。

### 6.4 页面能开，但只能播前 3 集 / 只有 360P

这不是部署问题，是**设备被线路级限流**了：`lq` 与 `sinfonline` 两组线路对该
device_id 回 `HTTP 200 + 0 字节`，代码回退到官网公开预览，表现就是
`play` 返回 `360P` + `kind:"public"`。

打开线路日志看实际打到哪：

```bash
ssh -i ~/.ssh/aipan_actions_198 root@198.44.125.49 \
  'cd /opt/xiaoguoguo && echo "XGG_DEBUG=1" >> .env && docker compose up -d'

curl -s "http://198.44.125.49:8788/api/episodes/<episode_id>/play"

ssh -i ~/.ssh/aipan_actions_198 root@198.44.125.49 \
  'docker logs --tail 30 xiaoguoguo-web | grep app_stream'
```

日志里每条线路一行 `{"event":"app_stream_response","host":...,"length":...}`：

- `length: 0` → 这条线路对该设备限流，代码会自动冷却 2 分钟并换下一条
- 有 `length` 且 `code=0` → 正常

若**所有线路都 0 字节**，说明设备被全面降级，代码会触发设备自愈（重新注册，
10 分钟冷却）。想立刻换设备就删掉身份文件重启：

```bash
ssh -i ~/.ssh/aipan_actions_198 root@198.44.125.49 \
  'mv /opt/xiaoguoguo/data/device.json /opt/xiaoguoguo/data/device.json.bak && \
   cd /opt/xiaoguoguo && docker compose restart'
```

排障完记得把 `.env` 里的 `XGG_DEBUG=1` 删掉再 `up -d`，否则日志会一直刷。
本地诊断可以用 `scripts/hg-host-matrix.mjs` 跑 13 条线路矩阵，比翻日志直观。

### 6.5 所有线路都空，换设备也没用

如果日志里六条线路**全部** `length: 0`，而且自动换设备（`identity_rotated`）后仍然全空，
那就不是设备被限流，是**平台整体收紧了播放接口**。

判断方法：用一台全新设备跑一遍线路矩阵，全空即确认。

```bash
# 不带 DEVICE_IDENTITY_FILE 时脚本会临时注册新设备
node scripts/hg-host-matrix.mjs
```

```text
device=806355799944362
api5-normal-lq.fqnovel.com      200  0  -   ← 13 条全是 0 字节
api5-normal-hl.fqnovel.com      200  0  -
...
```

此时无论换 IP、换设备、换路径（`/v1/`、`/player/v1`、`/default/v1` 都试过）
都拿不到数据，只能等上游放开或等客户端更新后重新逆向。

**这种状态下服务仍然可用**：会自动退到官网公开预览（每部剧前 3 集、360P），
`play` 返回 `360P` + `kind:"public"`，`stream` 依然 206。

> 2026-11-24 19:00 前后出现过一次：16:47 部署完成时还是 720P，两小时后
> 本地与服务器、老设备与新设备、新旧路径全部退化为 360P 预览。内容接口
> （`/api/home`、`/api/series`）不受影响。属上游策略变更，与部署无关。

### 6.6 改了 compose 不生效

CI 不传文件。改完仓库那份要手动同步：

```bash
scp -i ~/.ssh/aipan_actions_198 docker-compose.server.yml \
    root@198.44.125.49:/opt/xiaoguoguo/docker-compose.yml
ssh -i ~/.ssh/aipan_actions_198 root@198.44.125.49 'cd /opt/xiaoguoguo && docker compose up -d'
```

### 6.7 Actions 报 `Node.js 20 is deprecated`

只是警告。`actions/checkout@v4`、`docker/*-action@v3/v6` 还没升到 v5，
等官方发版后再跟。不影响功能。

---

## 7. 运维备忘

```bash
# 实时日志
ssh -i ~/.ssh/aipan_actions_198 root@198.44.125.49 \
  'docker logs -f --tail 100 xiaoguoguo-web'

# 磁盘占用（镜像 + 日志）
ssh -i ~/.ssh/aipan_actions_198 root@198.44.125.49 \
  'docker system df; du -sh /opt/xiaoguoguo'

# 备份设备身份（换机器 / 重装时用）
scp -i ~/.ssh/aipan_actions_198 \
  root@198.44.125.49:/opt/xiaoguoguo/data/device.json ./device.json.bak
```

日志轮转已经在 compose 里限死（单文件 20MB × 3 份），不会把磁盘写满。

---

## 8. 与 Vercel 部署的差异

| | Docker（当前生产） | Vercel |
|---|---|---|
| 设备身份 | `data/device.json` 持久化，重启不变 | 无共享磁盘，靠前端回传 `x-xgg-device` |
| 出口 IP | 固定，独占 | 共享，容易触发源站限流 |
| Cookie 持久化 | 写 `data/account-cookie` | 只能用 `ACCOUNT_COOKIE` 环境变量 |
| 冷启动 | 无 | 有，进程内缓存全丢 |

自托管在这三点上都更稳，所以现在以 Docker 为主，Vercel 保留作备选（见 `VERCEL.md`）。
