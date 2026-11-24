# syntax=docker/dockerfile:1.7
#
# 两阶段：前端用 Vite 构建，运行时只带 server 的依赖 + 静态产物。
# 生产镜像里没有 vite / typescript / react 依赖，体积比单阶段小一半左右。

# ---------- 1. 前端构建 ----------
FROM node:22-alpine AS web-build
WORKDIR /app

# 先只拷依赖清单：源码改动不会让 npm ci 这层失效
COPY package.json package-lock.json ./
COPY web/package.json ./web/
COPY server/package.json ./server/
RUN npm ci

COPY web ./web
RUN npm run build --workspace web

# ---------- 2. 运行时 ----------
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8788

# 只装 server 的运行时依赖（当前只有 qrcode）。
# web 产物是纯静态文件，运行时不需要它的 node_modules。
COPY package.json package-lock.json ./
COPY web/package.json ./web/
COPY server/package.json ./server/
RUN npm ci --omit=dev --workspace server --include-workspace-root \
 && npm cache clean --force

COPY server/src ./server/src
COPY --from=web-build /app/web/dist ./web/dist

# device.json / account-cookie 落在这里，运行时必须挂卷，
# 否则每次部署容器重建 = 换一台新设备（平台按 device_id 做线路级限流）。
RUN mkdir -p /app/server/.data

EXPOSE 8788

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8788)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/src/index.mjs"]
