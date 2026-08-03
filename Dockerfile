# AllinONE Gaming Platform - CloudBase Deployment
# v2.0 — 多阶段构建 + 安全加固 (Sprint 1)

# ============================================
# Stage 1: 构建前端
# ============================================
FROM node:20-slim AS builder
WORKDIR /app

# 安装 pnpm
RUN npm install -g pnpm

# 复制依赖文件
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# 复制源代码
COPY . .

# 构建前端 (输出到 dist/static)
RUN pnpm build:client

# 清理 devDependencies
RUN pnpm prune --prod

# ============================================
# Stage 2: 生产运行
# ============================================
FROM node:20-slim
WORKDIR /app

# 创建非 root 用户
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nodejs

# 构建后端
RUN pnpm build:server

# 从 builder 阶段复制产物
COPY --from=builder /app/dist/static ./dist/static
COPY --from=builder /app/dist/server ./dist/server
COPY --from=builder /app/server.js ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/cloudfunctions ./cloudfunctions

# 切换到非 root 用户
USER nodejs

# 设置环境变量
ENV NODE_ENV=production
ENV PORT=5000

# 暴露端口
EXPOSE 5000

# 健康检查
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD node -e "const http = require('http'); http.get('http://localhost:5000/api/health', r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>{ const j=JSON.parse(d); process.exit(j.status==='ok'?0:1); }); })"

# 启动命令
CMD ["node", "server.js"]
