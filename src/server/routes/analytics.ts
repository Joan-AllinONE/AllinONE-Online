/**
 * 平台数据中心 API 路由
 *
 * 公开路由（无 JWT，客户端埋点批量上报）：
 *   POST /api/v1/analytics/events   — 批量写入埋点事件
 *
 * 认证路由（需 JWT，管理端查询）：
 *   GET /api/v1/analytics/overview  — 概览 KPI（DAU/MAU/次数/时长/营收）
 *   GET /api/v1/analytics/trends    — 趋势（近 N 天）
 *   GET /api/v1/analytics/by-game   — 按游戏统计排行
 *   GET /api/v1/analytics/players   — 玩家分布
 */
import express, { Router, Request, Response } from 'express';
import { logger } from '../logger.js';
import { analyticsStore, AnalyticsEvent } from '../analytics/analyticsStore.js';

/**
 * 公开路由：埋点事件上报
 * 无需 JWT — 客户端（含匿名用户）批量上报，必须在 authMiddleware 之前挂载
 */
export function createAnalyticsPublicRouter(): Router {
  const router = Router();

  // 事件上报可能较大，放宽 body 限制
  const eventsBodyLimit = express.json({ limit: '2mb' });

  // ----- POST /events — 批量写入埋点事件 -----
  router.post('/events', eventsBodyLimit, (req: Request, res: Response) => {
    try {
      const body = req.body;
      const events: AnalyticsEvent[] = Array.isArray(body)
        ? body
        : Array.isArray(body?.events)
          ? body.events
          : [];

      if (events.length === 0) {
        return res.json({ success: true, added: 0, ignored: 0 });
      }

      const { added, ignored } = analyticsStore.addEvents(events);
      return res.json({ success: true, added, ignored });
    } catch (err) {
      logger.error({ err }, '[analytics] 事件写入失败');
      return res.status(500).json({ success: false, error: '事件写入失败' });
    }
  });

  return router;
}

/**
 * 认证路由：管理端查询
 * 需 JWT（在 server.js 中于 authMiddleware 之后挂载）
 */
export function createAnalyticsAuthRouter(): Router {
  const router = Router();

  // ----- GET /overview — 概览 KPI -----
  router.get('/overview', (_req: Request, res: Response) => {
    try {
      return res.json({ success: true, data: analyticsStore.getOverview() });
    } catch (err) {
      logger.error({ err }, '[analytics] 概览查询失败');
      return res.status(500).json({ success: false, error: '概览查询失败' });
    }
  });

  // ----- GET /trends?metric=dau&days=30 — 趋势 -----
  router.get('/trends', (req: Request, res: Response) => {
    try {
      const metric = String(req.query.metric || 'dau');
      const days = Math.min(Math.max(parseInt(String(req.query.days || '30'), 10) || 30, 1), 90);
      return res.json({ success: true, data: analyticsStore.getTrends(metric, days) });
    } catch (err) {
      logger.error({ err }, '[analytics] 趋势查询失败');
      return res.status(500).json({ success: false, error: '趋势查询失败' });
    }
  });

  // ----- GET /by-game — 按游戏统计 -----
  router.get('/by-game', (_req: Request, res: Response) => {
    try {
      return res.json({ success: true, data: analyticsStore.getByGame() });
    } catch (err) {
      logger.error({ err }, '[analytics] 按游戏查询失败');
      return res.status(500).json({ success: false, error: '按游戏查询失败' });
    }
  });

  // ----- GET /players — 玩家分布 -----
  router.get('/players', (_req: Request, res: Response) => {
    try {
      return res.json({ success: true, data: analyticsStore.getPlayers() });
    } catch (err) {
      logger.error({ err }, '[analytics] 玩家分布查询失败');
      return res.status(500).json({ success: false, error: '玩家分布查询失败' });
    }
  });

  return router;
}
