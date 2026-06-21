/**
 * 游戏开发者账户路由
 *
 * GET    /api/v1/game-developers             — 获取所有账户
 * GET    /api/v1/game-developers/:accountId  — 获取单个账户
 * POST   /api/v1/game-developers             — 创建/更新账户 (upsert)
 * POST   /api/v1/game-developers/:accountId/transaction — 记录交易
 * GET    /api/v1/game-developers/:accountId/transactions — 获取交易记录
 * GET    /api/v1/game-developers/transactions — 获取全部交易记录
 */
import { Router, Request, Response } from 'express';
import type { DeveloperAccount, DeveloperTransaction } from '../memoryDatabase';

export function createGameDeveloperRouter(
  useMemoryDB: boolean,
  memoryDB: any,
  pool: any,
  _isProduction: boolean
): Router {
  const router = Router();

  // ── GET / — 获取所有开发者账户 ──
  router.get('/', async (_req: Request, res: Response) => {
    try {
      if (useMemoryDB) {
        const accounts = await memoryDB.getAllDeveloperAccounts();
        return res.json({ success: true, data: accounts });
      }

      // PostgreSQL 模式
      if (pool) {
        const result = await pool.query(
          'SELECT * FROM game_developer_accounts ORDER BY created_at DESC'
        );
        const accounts = result.rows.map(rowToAccount);
        return res.json({ success: true, data: accounts });
      }

      res.json({ success: true, data: [] });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ── GET /transactions — 获取全部交易记录（放在 :accountId 之前避免冲突）──
  router.get('/transactions', async (req: Request, res: Response) => {
    try {
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;

      if (useMemoryDB) {
        const txs = await memoryDB.getDeveloperTransactions(undefined, limit);
        return res.json({ success: true, data: txs });
      }

      if (pool) {
        const sql = limit
          ? 'SELECT * FROM game_developer_transactions ORDER BY timestamp DESC LIMIT $1'
          : 'SELECT * FROM game_developer_transactions ORDER BY timestamp DESC';
        const result = limit
          ? await pool.query(sql, [limit])
          : await pool.query(sql);
        return res.json({ success: true, data: result.rows.map(rowToTx) });
      }

      res.json({ success: true, data: [] });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ── GET /:accountId — 获取单个账户 ──
  router.get('/:accountId', async (req: Request, res: Response) => {
    try {
      const { accountId } = req.params;

      if (useMemoryDB) {
        const account = await memoryDB.getDeveloperAccount(accountId);
        if (!account) {
          return res.status(404).json({ success: false, error: 'Account not found' });
        }
        return res.json({ success: true, data: account });
      }

      if (pool) {
        const result = await pool.query(
          'SELECT * FROM game_developer_accounts WHERE account_id = $1',
          [accountId]
        );
        if (result.rows.length === 0) {
          return res.status(404).json({ success: false, error: 'Account not found' });
        }
        return res.json({ success: true, data: rowToAccount(result.rows[0]) });
      }

      res.status(404).json({ success: false, error: 'No database available' });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ── POST / — 创建或更新账户 (upsert) ──
  router.post('/', async (req: Request, res: Response) => {
    try {
      const account: DeveloperAccount = req.body;

      if (!account.accountId) {
        return res.status(400).json({ success: false, error: 'Missing accountId' });
      }

      if (useMemoryDB) {
        await memoryDB.upsertDeveloperAccount(account);
        return res.json({ success: true, data: account });
      }

      if (pool) {
        await pool.query(
          `INSERT INTO game_developer_accounts (
            account_id, game_id, game_name, publisher_id, publisher_name,
            revenue_share_percent, total_revenue, total_withdrawn, available_balance,
            platform_owed, platform_settled, last_daily_settlement, stats,
            status, created_at, updated_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
          ON CONFLICT (account_id) DO UPDATE SET
            game_name = EXCLUDED.game_name,
            publisher_name = EXCLUDED.publisher_name,
            revenue_share_percent = EXCLUDED.revenue_share_percent,
            total_revenue = EXCLUDED.total_revenue,
            total_withdrawn = EXCLUDED.total_withdrawn,
            available_balance = EXCLUDED.available_balance,
            platform_owed = EXCLUDED.platform_owed,
            platform_settled = EXCLUDED.platform_settled,
            last_daily_settlement = EXCLUDED.last_daily_settlement,
            stats = EXCLUDED.stats,
            status = EXCLUDED.status,
            updated_at = EXCLUDED.updated_at`,
          [
            account.accountId, account.gameId, account.gameName,
            account.publisherId, account.publisherName,
            account.revenueSharePercent, account.totalRevenue,
            account.totalWithdrawn, account.availableBalance,
            account.platformOwed, account.platformSettled,
            account.lastDailySettlement, JSON.stringify(account.stats),
            account.status, new Date(account.createdAt), new Date(account.updatedAt),
          ]
        );
        return res.json({ success: true, data: account });
      }

      res.status(500).json({ success: false, error: 'No database available' });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ── POST /:accountId/transaction — 记录交易 ──
  router.post('/:accountId/transaction', async (req: Request, res: Response) => {
    try {
      const { accountId } = req.params;
      const tx: DeveloperTransaction = { ...req.body, accountId };

      if (useMemoryDB) {
        await memoryDB.addDeveloperTransaction(tx);
        return res.json({ success: true });
      }

      if (pool) {
        await pool.query(
          `INSERT INTO game_developer_transactions (
            id, game_id, account_id, type, amount, currency,
            description, from_user_id, from_user_name, metadata, timestamp
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            tx.id, tx.gameId, tx.accountId, tx.type, tx.amount, tx.currency,
            tx.description, tx.fromUserId || null, tx.fromUserName || null,
            JSON.stringify(tx.metadata || {}), new Date(tx.timestamp),
          ]
        );
        return res.json({ success: true });
      }

      res.status(500).json({ success: false, error: 'No database available' });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ── GET /:accountId/transactions — 获取账户交易记录 ──
  router.get('/:accountId/transactions', async (req: Request, res: Response) => {
    try {
      const { accountId } = req.params;
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;

      if (useMemoryDB) {
        const txs = await memoryDB.getDeveloperTransactions(accountId, limit);
        return res.json({ success: true, data: txs });
      }

      if (pool) {
        const sql = limit
          ? 'SELECT * FROM game_developer_transactions WHERE account_id = $1 ORDER BY timestamp DESC LIMIT $2'
          : 'SELECT * FROM game_developer_transactions WHERE account_id = $1 ORDER BY timestamp DESC';
        const params = limit ? [accountId, limit] : [accountId];
        const result = await pool.query(sql, params);
        return res.json({ success: true, data: result.rows.map(rowToTx) });
      }

      res.json({ success: true, data: [] });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  return router;
}

// ==================== PG 行映射 ====================

function rowToAccount(row: any): DeveloperAccount {
  return {
    accountId: row.account_id,
    gameId: row.game_id,
    gameName: row.game_name,
    publisherId: row.publisher_id,
    publisherName: row.publisher_name,
    revenueSharePercent: Number(row.revenue_share_percent),
    totalRevenue: Number(row.total_revenue),
    totalWithdrawn: Number(row.total_withdrawn),
    availableBalance: Number(row.available_balance),
    platformOwed: Number(row.platform_owed),
    platformSettled: Number(row.platform_settled),
    lastDailySettlement: Number(row.last_daily_settlement),
    stats: typeof row.stats === 'string' ? JSON.parse(row.stats) : (row.stats || {
      totalSoldItems: 0, totalSoldVouchers: 0, itemSales: {},
    }),
    status: row.status || 'active',
    createdAt: row.created_at instanceof Date ? row.created_at.getTime() : Number(row.created_at),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.getTime() : Number(row.updated_at),
  };
}

function rowToTx(row: any): DeveloperTransaction {
  return {
    id: row.id,
    gameId: row.game_id,
    accountId: row.account_id,
    type: row.type,
    amount: Number(row.amount),
    currency: row.currency,
    description: row.description,
    fromUserId: row.from_user_id || undefined,
    fromUserName: row.from_user_name || undefined,
    metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata || undefined,
    timestamp: row.timestamp instanceof Date ? row.timestamp.getTime() : Number(row.timestamp),
  };
}
