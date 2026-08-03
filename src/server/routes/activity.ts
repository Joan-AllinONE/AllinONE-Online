/**
 * 活动中心 API 路由
 *
 * 公开路由（无 JWT）：
 *   GET  /api/v1/activities/           — 活动列表（前端离线可回退）
 *   GET  /api/v1/activities/leaderboard— 奖励排行榜
 *
 * 认证路由（需 JWT）：
 *   POST /api/v1/activities/:activityId/claim — 上报领奖事件（用于排行榜）
 *
 * 活动定义存于 memoryDatabase（USE_MEMORY_DB=true 时），与前端种子数据保持一致。
 */
import { Router, Request, Response } from 'express';
import { logger } from '../logger.js';

// ==================== 公开路由工厂 ====================

export function createActivityPublicRouter(
  useMemoryDB: boolean,
  memoryDB: any,
  pool: any,
  isProduction: boolean
): Router {
  void pool; // 预留 PostgreSQL 连接池参数（当前仅内存库模式，保持与 server.js 调用签名一致）
  const router = Router();

  // ----- GET /  （活动列表） -----
  router.get('/', async (_req: Request, res: Response) => {
    try {
      let activities: any[] = [];
      if (useMemoryDB && memoryDB?.getActivities) {
        activities = await memoryDB.getActivities();
      }
      res.json({ success: true, activities });
    } catch (error: any) {
      logger.error({ err: error }, '[activity] list error');
      res.status(500).json({ success: false, error: isProduction ? 'Internal server error' : error.message });
    }
  });

  // ----- GET /leaderboard -----
  router.get('/leaderboard', async (_req: Request, res: Response) => {
    try {
      let entries: any[] = [];
      if (useMemoryDB && memoryDB?.getLeaderboard) {
        entries = await memoryDB.getLeaderboard(20);
      }
      res.json({ success: true, leaderboard: entries });
    } catch (error: any) {
      logger.error({ err: error }, '[activity] leaderboard error');
      res.status(500).json({ success: false, error: isProduction ? 'Internal server error' : error.message });
    }
  });

  return router;
}

// ==================== 认证路由工厂 ====================

export function createActivityAuthRouter(
  useMemoryDB: boolean,
  memoryDB: any,
  pool: any,
  isProduction: boolean
): Router {
  void pool; // 预留 PostgreSQL 连接池参数（当前仅内存库模式，保持与 server.js 调用签名一致）
  const router = Router();

  // ----- POST /:activityId/claim  （上报领奖，用于排行榜） -----
  router.post('/:activityId/claim', async (req: Request, res: Response) => {
    try {
      const userId = (req as any).userId;
      const { activityId } = req.params;
      const { userName, amount, at } = req.body as {
        userName?: string;
        amount?: number;
        at?: number;
      };
      if (!userId || !activityId) {
        return res.status(400).json({ success: false, error: 'Missing userId or activityId' });
      }
      if (useMemoryDB && memoryDB?.addClaim) {
        await memoryDB.addClaim({
          id: `${activityId}_${userId}_${Date.now()}`,
          activityId,
          userId,
          userName: userName || '玩家',
          amount: Number(amount) || 0,
          at: Number(at) || Date.now(),
        });
      }
      res.json({ success: true, data: { activityId, userId } });
    } catch (error: any) {
      logger.error({ err: error }, '[activity] claim error');
      res.status(500).json({ success: false, error: isProduction ? 'Internal server error' : error.message });
    }
  });

  return router;
}
