/**
 * 兑换码 API 路由 (S4-1)
 * POST /api/v1/redeem/sync|verify|use
 * GET  /api/v1/redeem/stats
 */
import { Router } from 'express';
import { redeemCodeStore as RedeemCodeStoreType } from '../redeemCodeStore.js';
type RedeemCodeStore = typeof RedeemCodeStoreType;

export function createRedeemRouter(
  redeemCodeStore: RedeemCodeStore,
  isProduction: boolean
): Router {
  const router = Router();

  router.post('/sync', (req, res) => {
    try {
      const { codes, items } = req.body;
      const result = {
        codes: { added: 0, updated: 0 },
        items: { added: 0, updated: 0 },
      };
      if (Array.isArray(codes)) result.codes = redeemCodeStore.syncCodes(codes);
      if (Array.isArray(items)) result.items = redeemCodeStore.syncItems(items);
      res.json({ success: true, data: result, message: '同步成功' });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        error: isProduction ? 'Internal server error' : '同步失败',
      });
    }
  });

  router.post('/verify', (req, res) => {
    try {
      const { code, gameId } = req.body;
      if (!code || !gameId) {
        return res.status(400).json({ success: false, error: '缺少必要参数: code, gameId' });
      }
      const result = redeemCodeStore.verifyCode(gameId, code);
      res.json({ success: true, data: result });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        error: isProduction ? 'Internal server error' : '验证失败',
      });
    }
  });

  router.post('/use', (req, res) => {
    try {
      const { code, gameId, userId } = req.body;
      if (!code || !gameId || !userId) {
        return res.status(400).json({ success: false, error: '缺少必要参数: code, gameId, userId' });
      }
      const result = redeemCodeStore.useCode(gameId, code, userId);
      res.json({ success: true, data: result });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        error: isProduction ? 'Internal server error' : '核销失败',
      });
    }
  });

  router.get('/stats', (_req, res) => {
    const stats = redeemCodeStore.getStats();
    res.json({ success: true, data: stats });
  });

  return router;
}
