/**
 * AllinONE 后端服务器
 * v1.2.0 — 安全加固 + 可观测性 (Sprint 1-3)
 * JWT 认证、CORS 白名单、速率限制、Helmet、结构化日志、Metrics、Request ID
 */

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'path';
import pg from 'pg';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { memoryDB } from './dist/server/server/memoryDatabase.js';
import { redeemCodeStore } from './dist/server/server/redeemCodeStore.js';
import { authMiddleware } from './dist/server/server/auth/jwt.js';
import { logger, requestLogger } from './dist/server/server/logger.js';
import { requestIdMiddleware } from './dist/server/server/requestId.js';
import { metricsMiddleware, metricsHandler } from './dist/server/server/metrics.js';
import { createHealthRouter } from './dist/server/server/routes/health.js';
import { createRedeemRouter } from './dist/server/server/routes/redeem.js';
import { createInventoryRouter } from './dist/server/server/routes/inventory.js';
import { createGamesPublicRouter, createGamesAuthRouter } from './dist/server/server/routes/games.js';
import { createGameReviewRouter } from './dist/server/server/routes/gameReview.js';
import { createGameDeveloperRouter } from './dist/server/server/routes/gameDeveloper.js';
import { createAnalyticsPublicRouter, createAnalyticsAuthRouter } from './dist/server/server/routes/analytics.js';
import { createActivityPublicRouter, createActivityAuthRouter } from './dist/server/server/routes/activity.js';
import { createQuestsRouter } from './dist/server/server/routes/quests.js';
import { createGameWalletRouter } from './dist/server/server/routes/gameWallet.js';
import { createContentRouter } from './dist/server/server/routes/content.js';

const { Pool } = pg;
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === 'production';

// ============================================
// 数据库模式判断
// ============================================
const USE_MEMORY_DB = process.env.USE_MEMORY_DB === 'true' || process.env.CLOUDSTUDIO === 'true';

// 数据库连接（仅非内存模式使用）
let pool = null;
if (!USE_MEMORY_DB) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME || 'allinone_db',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD,
    max: 20,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    statement_timeout: 10000,
  });

  pool.on('error', (err) => {
    logger.error({ err }, 'Unexpected pool error');
  });
}

// ============================================
// 中间件：安全头 (S1-6)
// 游戏文件路径跳过 CSP — 游戏运行在 sandbox iframe 中，
// 由 games 路由自行设置宽松 CSP，Helmet 默认 CSP 会阻止内联脚本
// ============================================
const helmetDefault = helmet();
const helmetNoCSP = helmet({ contentSecurityPolicy: false });
app.use((req, res, next) => {
  if (req.path.includes('/files/')) {
    helmetNoCSP(req, res, next);
  } else {
    helmetDefault(req, res, next);
  }
});

// ============================================
// 中间件：Request ID (S3-2)
// ============================================
app.use(requestIdMiddleware);

// ============================================
// 中间件：结构化请求日志 (S3-1)
// ============================================
app.use(requestLogger);

// ============================================
// 中间件：Metrics 记录 (S3-3)
// ============================================
app.use(metricsMiddleware);

// ============================================
// 中间件：CORS 白名单 (S1-2)
// ============================================
const ALLOWED_ORIGINS = [
  process.env.CORS_ORIGIN || '',
  'https://allinonegaming-d4gmsmrzz573264f6.ap-shanghai.app.tcloudbase.com',
  // CloudBase 静态托管前端域名（前端经 Service Worker 代理 /api 到本后端，浏览器 Origin 为此域）
  // ⚠️ 实际部署域名带 appId 后缀，必须包含否则 CORS 拒绝跨域请求
  'https://allinonegaming-d4gmsmrzz573264f6.tcloudbaseapp.com',
  'https://allinonegaming-d4gmsmrzz573264f6-1303031594.tcloudbaseapp.com',
  // CloudStudio 后端同源（后端同时托管前端时，Origin 为自身）
  'http://localhost:5173',
  'http://localhost:3000',
  'http://localhost:3001',
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    // 允许无 origin 的请求（如 Postman、server-to-server）
    if (!origin || ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}));

// ============================================
// 中间件：速率限制 (S1-3)
// ============================================
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 分钟
  max: 300,
  // 后台 /api/redeem/sync 是高频离线同步，不占用公共额度，
  // 否则会被它耗尽 100 次上限、连带拖垮 /api/redeem/verify、/api/redeem/use 导致兑换失败
  // dev 环境（USE_MEMORY_DB=true）：本地单 IP 下前端 + iframe 子资源 + 列表轮询会迅速打满
  // 300 次/15min 额度，导致 GET /api/v1/games 被 429 限流、刷新后游戏封面/简介丢失。
  // 本地 dev 无滥用风险，直接豁免限流；prod（无 USE_MEMORY_DB）不受影响。
  skip: (req) => req.path === '/redeem/sync' || process.env.USE_MEMORY_DB === 'true',
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests, please try again later' },
});

const strictLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 分钟
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests on this endpoint' },
});

// 通用 API 限流
app.use('/api/', generalLimiter);
// 兑换码端点严格限流
app.use('/api/redeem/verify', strictLimiter);
app.use('/api/redeem/use', strictLimiter);

// ============================================
// 中间件：Body 解析
// ============================================
// 游戏文件上传和兑换同步路由需要更大的 body 限制
app.use('/api/v1/games', express.json({ limit: '150mb' }));
app.use('/api/redeem', express.json({ limit: '1mb' }));
app.use('/api/v1/redeem', express.json({ limit: '1mb' }));
// 其他 API 路由使用默认限制
app.use(express.json());

// ============================================
// S4-1 + S4-2: API 路由 — 模块化 + 版本化
// ============================================

const healthRouter = createHealthRouter(USE_MEMORY_DB, pool);
const redeemRouter = createRedeemRouter(redeemCodeStore, isProduction);
const inventoryRouter = createInventoryRouter(USE_MEMORY_DB, memoryDB, pool, isProduction);
const gamesPublicRouter = createGamesPublicRouter(USE_MEMORY_DB, memoryDB, pool, isProduction);
const gamesAuthRouter = createGamesAuthRouter(USE_MEMORY_DB, memoryDB, pool, isProduction);
const gameDeveloperRouter = createGameDeveloperRouter(USE_MEMORY_DB, memoryDB, pool, isProduction);
const analyticsPublicRouter = createAnalyticsPublicRouter();
const analyticsAuthRouter = createAnalyticsAuthRouter();
const activityPublicRouter = createActivityPublicRouter(USE_MEMORY_DB, memoryDB, pool, isProduction);
const activityAuthRouter = createActivityAuthRouter(USE_MEMORY_DB, memoryDB, pool, isProduction);
const questsRouter = createQuestsRouter(USE_MEMORY_DB, memoryDB, pool, isProduction);
const gameWalletRouter = createGameWalletRouter(USE_MEMORY_DB, memoryDB, pool, isProduction);
const contentRouter = createContentRouter(USE_MEMORY_DB, memoryDB, pool, isProduction);
const gameReviewRouter = createGameReviewRouter(USE_MEMORY_DB, memoryDB, pool, isProduction);

// 🌐 公开路由：任务系统 __quests 隧道（必须在 games 路由之前，否则 __quests 被当 gameId）
app.use('/api/v1/games/__quests', questsRouter);

// 🌐 游戏内钱包 __wallet 隧道（在 gamesPublicRouter 之前，否则 __wallet 被当 gameId）
app.use('/api/v1/games/__wallet', gameWalletRouter);

// 🌐 内容工坊 __content 隧道（在 gamesPublicRouter 之前，否则 __content 被当 gameId）
app.use('/api/v1/games/__content', contentRouter);

// 🌐 游戏审核 __review 隧道（在 gamesPublicRouter 之前，否则 __review 被当 gameId）
// 审核后台独立管理员登录（REVIEW_ADMIN_USER/REVIEW_ADMIN_PASS），路由内部自行解析 JWT
app.use('/api/v1/games/__review', gameReviewRouter);

// 🌐 公开路由：游戏文件提供（无需 JWT，必须在 authMiddleware 之前挂载）
// iframe 内的 <script>/<link> 资源请求不带 Authorization header
app.use('/api/v1/games', gamesPublicRouter);

// 🌐 公开路由：埋点事件上报（无需 JWT，必须在 authMiddleware 之前挂载）
app.use('/api/v1/analytics', analyticsPublicRouter);

// 🌐 公开路由：活动中心列表/排行榜（无需 JWT，必须在 authMiddleware 之前挂载）
// 注意：createActivityPublicRouter 定义了 GET /（列表）与 /leaderboard，之前只挂载了
// activityAuthRouter（仅含 POST /:activityId/claim），导致公开列表接口永远 401/500。
app.use('/api/v1/activities', activityPublicRouter);

// ============================================
// 中间件：JWT 认证 (S1-1)
// ============================================
// 对所有 /api/ 路径启用 JWT 认证
app.use('/api/', authMiddleware);

// ============================================
// 中间件：全局请求超时
// ============================================
app.use((_req, res, next) => {
  res.setTimeout(30000, () => {
    if (!res.headersSent) {
      res.status(504).json({ success: false, error: 'Request timeout' });
    }
  });
  next();
});

// 主版本路径 /api/v1/*
app.use('/api/v1/health', healthRouter);
app.use('/api/v1/redeem', redeemRouter);
app.use('/api/v1/inventory', inventoryRouter);
app.use('/api/v1/games', gamesAuthRouter);
app.use('/api/v1/game-developers', gameDeveloperRouter);
app.use('/api/v1/analytics', analyticsAuthRouter);
app.use('/api/v1/activities', activityAuthRouter);

// 旧路径兼容（90 天过渡期，返回弃用警告头）
app.use('/api/health', (_req, res, next) => {
  res.set('Deprecation', 'true');
  res.set('Sunset', 'Mon, 01 Sep 2026 00:00:00 GMT');
  next();
}, healthRouter);
app.use('/api/redeem', (_req, res, next) => {
  res.set('Deprecation', 'true');
  res.set('Sunset', 'Mon, 01 Sep 2026 00:00:00 GMT');
  next();
}, redeemRouter);
app.use('/api/inventory', (_req, res, next) => {
  res.set('Deprecation', 'true');
  res.set('Sunset', 'Mon, 01 Sep 2026 00:00:00 GMT');
  next();
}, inventoryRouter);

// ============================================
// ============================================
app.use((err, _req, res, _next) => {
  logger.error({ err }, 'Unhandled server error');
  res.status(500).json({
    success: false,
    error: isProduction ? 'Internal server error' : err.message,
    ...(isProduction ? {} : { stack: err.stack }),
  });
});

// ============================================
// Prometheus Metrics 端点 (S3-3)
// ============================================
app.get('/api/metrics', metricsHandler);

// ============================================
// 静态文件服务 + SPA fallback
// ============================================
app.use(express.static(path.join(__dirname, 'dist/static')));

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'dist/static', 'index.html'));
});

// ============================================
// 启动服务器
// ============================================
const server = app.listen(PORT, () => {
  const dbMode = USE_MEMORY_DB ? '内存数据库' : 'PostgreSQL';
  const redeemStats = redeemCodeStore.getStats();

  logger.info({
    port: PORT,
    dbMode,
    redeemCodeCount: redeemStats.codeCount,
    redeemUsedCount: redeemStats.usedCount,
  }, 'AllinONE 服务器已启动');

  // PostgreSQL 连接验证
  if (!USE_MEMORY_DB && pool) {
    pool.query('SELECT NOW()', (err) => {
      if (err) {
        logger.error({ err }, '数据库连接失败');
        process.exit(1);
      } else {
        logger.info('数据库连接成功');
      }
    });
  } else {
    logger.warn('使用内存数据库（数据将在重启后丢失）');
  }
});

// ============================================
// 进程级异常处理 (S1-7)
// ============================================

let shuttingDown = false;

process.on('uncaughtException', async (err) => {
  logger.error({ err }, 'Uncaught exception — initiating graceful shutdown');
  if (!shuttingDown) {
    shuttingDown = true;
    try {
      server.close();
      if (pool) await pool.end();
    } catch {
      // 尽力清理
    }
    process.exit(1);
  }
});

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'Unhandled rejection');
  // 记录但不立即退出，配合进程管理器自动重启策略
});

// 优雅关闭 (S1-7)
const GRACEFUL_TIMEOUT = 10000; // 10s

const gracefulShutdown = async (signal) => {
  logger.info({ signal }, '收到信号，正在优雅关闭');
  if (shuttingDown) return;
  shuttingDown = true;

  // 1. 停止接受新请求
  server.close();

  // 2. 强制退出计时器
  const forceExit = setTimeout(() => {
    logger.error('优雅关闭超时，强制退出');
    process.exit(1);
  }, GRACEFUL_TIMEOUT);

  // 3. 内存 DB 落盘（dev 持久化：确保游戏文件/元数据写入 .data/memory-db.json）
  try {
    if (USE_MEMORY_DB && memoryDB) {
      memoryDB.flush();
      logger.info('内存 DB 已落盘');
    }
  } catch (err) {
    logger.error({ err }, '内存 DB 落盘失败');
  }

  // 4. 关闭数据库连接
  try {
    if (pool) await pool.end();
    logger.info('数据库连接池已关闭');
  } catch (err) {
    logger.error({ err }, '关闭连接池失败');
  }

  clearTimeout(forceExit);
  process.exit(0);
};

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
