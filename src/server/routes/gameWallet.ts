/**
 * gameWallet - 游戏内钱包隧道（__wallet）
 *
 * 与云函数 gamesApi 的 wallet handler 对齐，dev 本地实现：
 *  - GET /balance?gameId=xxx      → { balance, transactions, userId }
 *  - GET /my-rewards              → 当前用户所有游戏钱包汇总（任务报酬可见）
 *
 * 挂在 /api/v1/games/__wallet（在 gamesPublicRouter 之前，避免 __wallet 被当 gameId）。
 * 注意：此路由在 authMiddleware 之前挂载，故内部自行解析 Authorization Bearer（verifyToken）。
 */
import { Router, Request, Response } from 'express';
import { verifyToken } from '../auth/jwt.js';

const EMPTY_BALANCE: Record<string, number> = { computingPower: 0, gameCoins: 0, diamonds: 0 };

export function createGameWalletRouter(
  USE_MEMORY_DB: boolean,
  memoryDB: any,
  _pool: any,
  _isProduction: boolean,
): Router {
  const router = Router();
  const isMemory = USE_MEMORY_DB || !!memoryDB;

  function resolveUserId(req: Request): string {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      try {
        const payload = verifyToken(authHeader.slice(7));
        if (payload && payload.userId) return payload.userId;
      } catch {
        // token 无效 → 回退
      }
    }
    const body: any = req.body || {};
    return (body.userId || 'anonymous') as string;
  }

  function normalizeBalance(wallet: any): any {
    return Object.assign({}, EMPTY_BALANCE, (wallet && wallet.balance) || {});
  }

  /** GET /balance?gameId=xxx → 单游戏钱包余额（附交易，供展示） */
  router.get('/balance', async (req: Request, res: Response) => {
    const userId = resolveUserId(req);
    const gameId = String(req.query.gameId || '').trim();
    if (!gameId) return res.status(400).json({ success: false, error: 'missing gameId' });
    const wallet = isMemory ? await memoryDB.getGameWallet(`${gameId}::${userId}`) : null;
    return res.json({
      success: true,
      data: {
        balance: normalizeBalance(wallet),
        transactions: Array.isArray(wallet && wallet.transactions) ? wallet.transactions : [],
        userId,
      },
    });
  });

  /** GET /my-rewards → 当前用户所有游戏钱包汇总（任务报酬可见） */
  router.get('/my-rewards', async (req: Request, res: Response) => {
    const userId = resolveUserId(req);
    const wallets = isMemory ? await memoryDB.listGameWalletsByUser(userId) : [];
    const total = Object.assign({}, EMPTY_BALANCE);
    const rows = wallets.map((w: any) => {
      const balance = normalizeBalance(w);
      for (const k of Object.keys(EMPTY_BALANCE)) total[k] = (total[k] || 0) + (balance[k] || 0);
      return {
        gameId: (w && (w.gameId || String(w._id || w.id || '').split('::')[0])) || '',
        userId,
        balance,
        transactions: Array.isArray(w && w.transactions) ? w.transactions : [],
      };
    });
    return res.json({ success: true, data: { userId, total, wallets: rows } });
  });

  // ============ 平台钱包（users.gameCoins）跨浏览器写通道（对齐云函数 __wallet/platform） ============
  /** GET /platform/balance → 跨浏览器读平台余额 */
  router.get('/platform/balance', async (req: Request, res: Response) => {
    const userId = resolveUserId(req);
    const u = isMemory ? await memoryDB.getUser(userId) : null;
    return res.json({
      success: true,
      data: {
        balance: {
          gameCoins: u ? Number(u.gameCoins) || 0 : 0,
          instantVouchers: u ? Number(u.instantVouchers) || 0 : 0,
          algorithmVouchers: u ? Number(u.algorithmVouchers) || 0 : 0,
          lastUpdated: u ? u.updatedAt || Date.now() : Date.now(),
        },
      },
    });
  });

  /** GET /platform/transactions → 跨浏览器读平台流水 */
  router.get('/platform/transactions', async (req: Request, res: Response) => {
    const userId = resolveUserId(req);
    const u = isMemory ? await memoryDB.getUser(userId) : null;
    const history = u && Array.isArray(u._walletHistory) ? u._walletHistory : [];
    const limit = Math.min(100, parseInt(String(req.query.limit || '50'), 10) || 50);
    return res.json({ success: true, data: { transactions: history.slice(0, limit) } });
  });

  /** POST /platform/adjust → delta 正=充值，负=消费；txId 幂等防重（对齐云函数 __wallet/platform/adjust） */
  router.post('/platform/adjust', async (req: Request, res: Response) => {
    const userId = resolveUserId(req);
    const body: any = req.body || {};
    const delta = Number(body.delta) || 0;
    const txId = String(body.txId || '').trim();
    if (delta === 0) return res.status(400).json({ success: false, error: 'invalid delta' });
    if (!txId) return res.status(400).json({ success: false, error: 'missing txId' });
    if (!isMemory) return res.status(400).json({ success: false, error: 'dev platform balance requires memory db' });
    try {
      const result = await memoryDB.adjustPlatformBalance(userId, delta, body.description || '', txId);
      if (!result) return res.status(400).json({ success: false, error: 'insufficient balance' });
      return res.json({ success: true, data: { balance: result.balance, transaction: result.transaction } });
    } catch (e: any) {
      return res.status(500).json({ success: false, error: (e && e.message) || 'write failed' });
    }
  });

  return router;
}
