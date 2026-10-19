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
import { createHash } from 'crypto';
import type { DeveloperAccount, DeveloperTransaction } from '../memoryDatabase';
import { computeThreeWaySplit } from '../../services/revenueSplit.js';

// ==================== 三方分成存证 + 影子对照 ====================

const SHARING_GENESIS_HASH = '0'.repeat(64);

/** 分成配置变更哈希链：hash = sha256(prevHash | canonical payload)（服务端计算，客户端不可伪造链） */
function sharingEntryHash(
  prevHash: string,
  payload: { accountId: string; gameId: string; config: unknown; source: string; proposalId: string; timestamp: number },
): string {
  return createHash('sha256').update(
    prevHash + '|' + JSON.stringify({
      accountId: payload.accountId,
      gameId: payload.gameId,
      config: payload.config,
      source: payload.source,
      proposalId: payload.proposalId || null,
      timestamp: payload.timestamp,
    }),
  ).digest('hex');
}

/** 重放校验哈希链完整性 */
function verifySharingChain(entries: any[]): { intact: boolean; length: number; brokenAt: string | null } {
  let prevHash = SHARING_GENESIS_HASH;
  for (const e of entries) {
    const expected = sharingEntryHash(prevHash, {
      accountId: e.accountId, gameId: e.gameId, config: e.config,
      source: e.source || 'default', proposalId: e.proposalId || '', timestamp: Number(e.timestamp),
    });
    if (e.hash !== expected) return { intact: false, length: entries.length, brokenAt: e.entryId };
    prevHash = e.hash;
  }
  return { intact: true, length: entries.length, brokenAt: null };
}

/**
 * 🆕 影子对照：服务端按账户分成配置独立重算三方分账，与客户端上报的 split 对比。
 * 一致/不一致都写 revenue_ledger（source='item_sale'，consistent 标记），不一致额外告警。
 * P0a（2026-10-15）：source 口径与 GSO 模板枚举统一为下划线 item_sale——
 * 此前写 'item-sale'（连字符），sumRevenue 精确匹配导致 GSO 分账基数永远为 0。
 * 台账与 GSO 口径兼容：commission 字段 = 平台份额（GSO 只按其配置的 sources 求和，不会混入）。
 */
async function shadowCheckSplit(memoryDB: any, tx: DeveloperTransaction): Promise<void> {
  try {
    const meta = (tx.metadata || {}) as Record<string, any>;
    if (tx.type !== 'purchase' || !meta.split) return;
    const account = await memoryDB.getDeveloperAccount(tx.accountId);
    if (!account) return;

    const expected = computeThreeWaySplit(Number(tx.amount) || 0, account.revenueSharing, account.revenueSharePercent);
    const reported = meta.split;
    const consistent =
      Number(reported.gameCut) === expected.gameCut &&
      Number(reported.platformCut) === expected.platformCut &&
      Number(reported.creatorCut) === expected.creatorCut;

    if (!consistent) {
      console.warn(
        `[GameDev][影子对照] ⚠️ 分账不一致 account=${tx.accountId} tx=${tx.id} ` +
        `上报(g=${reported.gameCut},p=${reported.platformCut},c=${reported.creatorCut}) vs ` +
        `服务端重算(g=${expected.gameCut},p=${expected.platformCut},c=${expected.creatorCut},mode=${expected.mode})`,
      );
    }

    const entryId = `devsplit_${tx.id || `${tx.accountId}_${tx.timestamp}`}`;
    const existing = await memoryDB.getRevenueEntry(entryId);
    if (existing) return; // 幂等：同一交易只记一条
    await memoryDB.putRevenueEntry({
      entryId,
      txId: tx.id || entryId,
      source: 'item_sale',
      gameId: tx.gameId,
      accountId: tx.accountId,
      grossAmount: Number(tx.amount) || 0,
      commission: expected.platformCut,
      currency: 'aCoins',
      split: expected,
      reportedSplit: reported,
      consistent,
      occurredAt: Number(tx.timestamp) || Date.now(),
      recordedBy: 'server-shadow',
    });
  } catch (e) {
    console.warn('[GameDev] 影子对照失败（不影响交易记录）:', e instanceof Error ? e.message : String(e));
  }
}

export function createGameDeveloperRouter(
  useMemoryDB: boolean,
  memoryDB: any,
  pool: any,
  _isProduction: boolean
): Router {
  const router = Router();

  // ── PG 模式 schema 自迁移（幂等；内存模式跳过）──
  if (pool && !useMemoryDB) {
    (async () => {
      try {
        await pool.query(
          `ALTER TABLE game_developer_accounts
             ADD COLUMN IF NOT EXISTS revenue_sharing jsonb,
             ADD COLUMN IF NOT EXISTS creator_owed numeric DEFAULT 0,
             ADD COLUMN IF NOT EXISTS creator_settled numeric DEFAULT 0`,
        );
        await pool.query(
          `CREATE TABLE IF NOT EXISTS game_revenue_sharing_history (
             id serial PRIMARY KEY,
             account_id text NOT NULL,
             game_id text,
             config jsonb,
             source text,
             proposal_id text,
             prev_hash text,
             hash text,
             timestamp bigint,
             created_at timestamptz DEFAULT now())`,
        );
        await pool.query(
          `CREATE INDEX IF NOT EXISTS idx_rsh_account ON game_revenue_sharing_history (account_id)`,
        );
      } catch (e: any) {
        console.warn('[GameDev] PG schema 迁移失败:', e?.message || e);
      }
    })();
  }

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
            revenue_sharing, creator_owed, creator_settled,
            status, created_at, updated_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
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
            revenue_sharing = EXCLUDED.revenue_sharing,
            creator_owed = EXCLUDED.creator_owed,
            creator_settled = EXCLUDED.creator_settled,
            status = EXCLUDED.status,
            updated_at = EXCLUDED.updated_at`,
          [
            account.accountId, account.gameId, account.gameName,
            account.publisherId, account.publisherName,
            account.revenueSharePercent, account.totalRevenue,
            account.totalWithdrawn, account.availableBalance,
            account.platformOwed, account.platformSettled,
            account.lastDailySettlement, JSON.stringify(account.stats),
            account.revenueSharing ? JSON.stringify(account.revenueSharing) : null,
            account.creatorOwed ?? 0, account.creatorSettled ?? 0,
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
        // 🆕 三方分成影子对照 + revenue_ledger 明细（PG 模式暂只告警不落台账）
        await shadowCheckSplit(memoryDB, tx);
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

  // ── POST /:accountId/revenue-sharing-history — 分成配置变更存证（append-only 哈希链）──
  router.post('/:accountId/revenue-sharing-history', async (req: Request, res: Response) => {
    try {
      const accountId = String(req.params.accountId || '');
      const body: any = req.body || {};
      const { config, source, proposalId } = body;
      const gameId: string = typeof body.gameId === 'string' ? body.gameId : '';
      if (!gameId || !config) {
        return res.status(400).json({ success: false, error: 'gameId 与 config 必填' });
      }
      const timestamp = Date.now();

      if (useMemoryDB) {
        const history = await memoryDB.getRevenueSharingHistory(accountId);
        const prevHash = history.length ? history[history.length - 1].hash : SHARING_GENESIS_HASH;
        const entryId = `rsh_${accountId}_${timestamp}_${Math.random().toString(36).slice(2, 8)}`;
        const entry = {
          entryId, accountId, gameId, config, source: source || 'default',
          proposalId: proposalId || '', prevHash, timestamp,
          hash: sharingEntryHash(prevHash, { accountId, gameId, config, source: source || 'default', proposalId: proposalId || '', timestamp }),
        };
        await memoryDB.addRevenueSharingEntry(entry);
        return res.json({ success: true, data: entry });
      }

      if (pool) {
        const prevRes = await pool.query(
          'SELECT hash FROM game_revenue_sharing_history WHERE account_id = $1 ORDER BY id DESC LIMIT 1',
          [accountId],
        );
        const prevHash = prevRes.rows.length ? prevRes.rows[0].hash : SHARING_GENESIS_HASH;
        const hash = sharingEntryHash(prevHash, { accountId, gameId, config, source: source || 'default', proposalId: proposalId || '', timestamp });
        const ins = await pool.query(
          `INSERT INTO game_revenue_sharing_history
             (account_id, game_id, config, source, proposal_id, prev_hash, hash, timestamp)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, hash`,
          [accountId, gameId, JSON.stringify(config), source || 'default', proposalId || null, prevHash, hash, timestamp],
        );
        return res.json({ success: true, data: { entryId: `rsh_${ins.rows[0].id}`, accountId, gameId, config, source: source || 'default', proposalId: proposalId || '', prevHash, timestamp, hash: ins.rows[0].hash } });
      }

      res.status(500).json({ success: false, error: 'No database available' });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ── GET /:accountId/revenue-sharing-history — 分成配置变更历史 ──
  router.get('/:accountId/revenue-sharing-history', async (req: Request, res: Response) => {
    try {
      const { accountId } = req.params;
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;

      if (useMemoryDB) {
        const entries = await memoryDB.getRevenueSharingHistory(accountId, limit);
        return res.json({ success: true, data: entries });
      }

      if (pool) {
        const sql = `SELECT * FROM game_revenue_sharing_history WHERE account_id = $1 ORDER BY id ASC ${limit ? 'LIMIT $2' : ''}`;
        const params = limit ? [accountId, limit] : [accountId];
        const result = await pool.query(sql, params);
        return res.json({
          success: true,
          data: result.rows.map((r: any) => ({
            entryId: `rsh_${r.id}`, accountId: r.account_id, gameId: r.game_id,
            config: typeof r.config === 'string' ? JSON.parse(r.config) : r.config,
            source: r.source, proposalId: r.proposal_id || '', prevHash: r.prev_hash,
            hash: r.hash, timestamp: Number(r.timestamp),
          })),
        });
      }

      res.json({ success: true, data: [] });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ── GET /:accountId/revenue-sharing-verify — 校验分成配置哈希链完整性 ──
  router.get('/:accountId/revenue-sharing-verify', async (req: Request, res: Response) => {
    try {
      const { accountId } = req.params;
      let entries: any[] = [];

      if (useMemoryDB) {
        entries = await memoryDB.getRevenueSharingHistory(accountId);
      } else if (pool) {
        const result = await pool.query(
          'SELECT * FROM game_revenue_sharing_history WHERE account_id = $1 ORDER BY id ASC',
          [accountId],
        );
        entries = result.rows.map((r: any) => ({
          entryId: `rsh_${r.id}`, accountId: r.account_id, gameId: r.game_id,
          config: typeof r.config === 'string' ? JSON.parse(r.config) : r.config,
          source: r.source, proposalId: r.proposal_id || '', hash: r.hash, timestamp: Number(r.timestamp),
        }));
      }

      return res.json({ success: true, data: { accountId, ...verifySharingChain(entries) } });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ── GET /:accountId/split-ledger — 三方分账影子对照台账（审计可见） ──
  router.get('/:accountId/split-ledger', async (req: Request, res: Response) => {
    try {
      const { accountId } = req.params;
      if (useMemoryDB) {
        const entries = await memoryDB.listRevenueEntriesByAccount(accountId);
        return res.json({ success: true, data: entries });
      }
      // PG 模式暂无 revenue_ledger 表（影子对照仅告警）
      return res.json({ success: true, data: [] });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ── POST /:accountId/gamecoins-split — 游戏币支付的三方即时分账 ──
  // 语义（2026-10-08 用户澄清）：gameCoins 是平台通用货币且为主要结算货币，三方分成基数包括游戏币收入。
  // gameCoins 是余额制（users.gameCoins），与 A币凭证的「实物进 game-{id} + 留置权 + 批量落袋」不同：
  // 玩家 spend 后调本端点，服务端按账户分成配置独立重算并【即时】credit 三方钱包（无留置权、无批量落袋）。
  const PLATFORM_TREASURY_ID = 'platform_treasury';
  router.post('/:accountId/gamecoins-split', async (req: Request, res: Response) => {
    try {
      const accountId = String(req.params.accountId || '');
      const body: any = req.body || {};
      const gameId: string = typeof body.gameId === 'string' ? body.gameId : '';
      const amount = Math.floor(Number(body.amount) || 0);
      const buyerId: string = typeof body.buyerId === 'string' ? body.buyerId : '';
      const buyerName: string = typeof body.buyerName === 'string' ? body.buyerName : buyerId;
      const itemName: string = typeof body.itemName === 'string' ? body.itemName : '';
      const templateId: string | undefined = typeof body.templateId === 'string' ? body.templateId : undefined;
      if (!gameId || amount <= 0 || !buyerId) {
        return res.status(400).json({ success: false, error: 'gameId/amount/buyerId 必填' });
      }

      let account = await memoryDB.getDeveloperAccount(accountId);
      if (!account) {
        // 🆕 自愈：内存库重启后开发者账户可能丢失（旧进程未落盘 / 冒烟 none 模式 / 首次购买）。
        // 从游戏档案（publishedGames 已持久化）重建默认账户，收入归属方 = 游戏档案的发布者；
        // 不带 revenueSharing → 走 legacy 抽成比例（之后提案执行会覆盖为三方配置）。
        const game = await memoryDB.getPublishedGame(gameId);
        if (!game || !game.publisherId) {
          return res.status(404).json({
            success: false,
            error: `developer account not found，且服务端缺少游戏档案（${gameId}）——请重新发布该游戏后重试`,
          });
        }
        const now = Date.now();
        account = {
          accountId,
          gameId,
          gameName: game.name || game.gameName || game.title || gameId,
          publisherId: game.publisherId,
          publisherName: game.publisherName || game.publisherId,
          revenueSharePercent: typeof game.revenueSharePercent === 'number' ? game.revenueSharePercent : 10,
          totalRevenue: 0, totalWithdrawn: 0, availableBalance: 0,
          platformOwed: 0, platformSettled: 0,
          lastDailySettlement: now,
          creatorOwed: 0, creatorSettled: 0, gameCoinsRevenue: 0,
          stats: { totalSoldItems: 0, totalSoldVouchers: 0, itemSales: {} },
          status: 'active', createdAt: now, updatedAt: now,
        };
        await memoryDB.upsertDeveloperAccount(account);
        console.log(`[GameDev] ♻️ 账户缺失自愈：已从游戏档案重建 ${accountId}（publisher=${game.publisherId}，legacy 抽成 ${account.revenueSharePercent}%）`);
      }

      // 服务端独立重算三方份额（不信任客户端上报，与 A币影子对照同一函数）
      const expected = computeThreeWaySplit(amount, account.revenueSharing, account.revenueSharePercent);

      // 防御：三方配置要求创作者但缺 creatorId → 拒绝（配置写入时已校验，此处兜底）
      if (expected.creatorCut > 0 && !account.revenueSharing?.creatorId) {
        return res.status(400).json({ success: false, error: '三方配置要求创作者份额但缺少 creatorId' });
      }

      // 幂等键：同一买家+游戏+金额+分钟窗内重放直接挡（防双击；跨窗伪造属 dev 灰度已知风险）
      const minuteWindow = Math.floor(Date.now() / 60000);
      const settleTxId = `gcsplit_${buyerId}_${gameId}_${amount}_${minuteWindow}`;

      // 三方 credit（顺序执行；任一步失败回滚已入账部分——补偿事务）
      const done: { userId: string; delta: number; tag: string }[] = [];
      const rollback = async () => {
        for (const c of done.reverse()) {
          try {
            await memoryDB.adjustPlatformBalance(c.userId, -c.delta, `[回滚] 分账失败补偿 ${c.tag}`, `${settleTxId}_${c.tag}_rb`, true);
          } catch { /* 回滚失败仅日志（内存 DB 场景几乎不发生） */ }
        }
      };

      try {
        if (expected.gameCut > 0) {
          const r = await memoryDB.adjustPlatformBalance(
            account.publisherId, expected.gameCut,
            `游戏币收入分成(游戏方): ${account.gameName} ${itemName}`, `${settleTxId}_game`, false,
          );
          if (!r) throw new Error('游戏方钱包入账失败');
          done.push({ userId: account.publisherId, delta: expected.gameCut, tag: 'game' });
        }
        if (expected.platformCut > 0) {
          const r = await memoryDB.adjustPlatformBalance(
            PLATFORM_TREASURY_ID, expected.platformCut,
            `游戏币收入分成(平台): ${account.gameName} ${itemName}`, `${settleTxId}_platform`, true,
          );
          if (!r) throw new Error('平台金库入账失败');
          done.push({ userId: PLATFORM_TREASURY_ID, delta: expected.platformCut, tag: 'platform' });
        }
        if (expected.creatorCut > 0) {
          const r = await memoryDB.adjustPlatformBalance(
            account.revenueSharing!.creatorId!, expected.creatorCut,
            `游戏币收入分成(创作者): ${account.gameName} ${itemName}`, `${settleTxId}_creator`, false,
          );
          if (!r) throw new Error('创作者钱包入账失败');
          done.push({ userId: account.revenueSharing!.creatorId!, delta: expected.creatorCut, tag: 'creator' });
        }
      } catch (splitErr: any) {
        await rollback();
        return res.status(500).json({ success: false, error: splitErr?.message || '分账失败' });
      }

      // 簿记：gameCoinsRevenue 累计 + stats + 交易记录（币种 gameCoins，含 split 明细）
      account.gameCoinsRevenue = (account.gameCoinsRevenue || 0) + amount;
      account.stats.totalSoldItems += 1;
      account.updatedAt = Date.now();
      await memoryDB.upsertDeveloperAccount(account);

      const credits = done.map(c => ({ role: c.tag, userId: c.userId, amount: c.delta }));
      const tx: any = {
        id: `devtx_${settleTxId}`, accountId, gameId: account.gameId,
        type: 'purchase', amount, currency: 'gameCoins',
        description: `玩家 ${buyerName} 购买 ${itemName}（游戏币三方分账 游戏${expected.gameCut}/平台${expected.platformCut}/创作者${expected.creatorCut}）`,
        fromUserId: buyerId, fromUserName: buyerName,
        metadata: { templateId, split: expected, credits, currency: 'gameCoins' },
        timestamp: Date.now(),
      };
      await memoryDB.addDeveloperTransaction(tx);

      console.log(
        `[GameDev] 🎮 ${account.gameName} 游戏币三方分账: 玩家 -${amount} → ` +
        `游戏方 ${expected.gameCut}(${account.publisherId}) / 平台 ${expected.platformCut} / 创作者 ${expected.creatorCut} (${expected.mode})`,
      );

      return res.json({ success: true, data: { split: expected, credits, gameCoinsRevenue: account.gameCoinsRevenue, txId: settleTxId } });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ── POST /:accountId/gso-revenue — GSO 可观测收益记账点（store_sale / content_consume）──
  // 语义（2026-10-15）：只写 revenue_ledger（GSO tick 分账的唯一基数来源），不做钱包即时 credit
  // ——钱包侧结算由既有链路负责（gamecoins-split 即时分账 / item_sale 走 recordPurchaseRevenue 影子），
  // 本端点补的是台账事实源，让 GSO 的 revenueSources 里有真实数据可分。
  // 幂等：content_consume 客户端传 cc_<voucherId>（一张凭证只消费一次，天然幂等）；
  // store_sale 客户端传分钟窗键，缺省时服务端按 buyer+game+amount+分钟窗兜底。
  router.post('/:accountId/gso-revenue', async (req: Request, res: Response) => {
    try {
      const accountId = String(req.params.accountId || '');
      const body: any = req.body || {};
      const source = String(body.source || '');
      const gameId = String(body.gameId || '');
      const amount = Math.floor(Number(body.amount) || 0);
      const buyerId = String(body.buyerId || '');
      if (!['store_sale', 'content_consume'].includes(source) || !gameId || amount <= 0 || !buyerId) {
        return res.status(400).json({ success: false, error: 'source(store_sale|content_consume)/gameId/amount/buyerId 必填' });
      }
      const minuteWindow = Math.floor(Date.now() / 60000);
      const idem = String(body.idempotencyKey || '') || `${buyerId}_${gameId}_${amount}_${minuteWindow}`;
      const entryId = `srvr_${source}_${idem}`;

      const existing = await memoryDB.getRevenueEntry(entryId);
      if (existing) {
        return res.json({ success: true, data: { duplicate: true, entryId } });
      }

      // 账户缺失自愈（与 gamecoins-split 同模式）：从游戏档案重建默认账户
      let account = await memoryDB.getDeveloperAccount(accountId);
      if (!account) {
        const game = await memoryDB.getPublishedGame(gameId);
        if (!game || !game.publisherId) {
          return res.status(404).json({ success: false, error: `developer account not found，且服务端缺少游戏档案（${gameId}）` });
        }
        const now = Date.now();
        account = {
          accountId,
          gameId,
          gameName: game.name || game.gameName || game.title || gameId,
          publisherId: game.publisherId,
          publisherName: game.publisherName || game.publisherId,
          revenueSharePercent: typeof game.revenueSharePercent === 'number' ? game.revenueSharePercent : 10,
          totalRevenue: 0, totalWithdrawn: 0, availableBalance: 0,
          platformOwed: 0, platformSettled: 0,
          lastDailySettlement: now,
          creatorOwed: 0, creatorSettled: 0, gameCoinsRevenue: 0,
          stats: { totalSoldItems: 0, totalSoldVouchers: 0, itemSales: {} },
          status: 'active', createdAt: now, updatedAt: now,
        };
        await memoryDB.upsertDeveloperAccount(account);
        console.log(`[GameDev] ♻️ 账户缺失自愈（gso-revenue）：已从游戏档案重建 ${accountId}`);
      }

      // 服务端独立重算三方份额（commission 字段 = 平台份额，与 GSO tick sumRevenue 的求和口径一致）
      const expected = computeThreeWaySplit(amount, account.revenueSharing, account.revenueSharePercent);
      await memoryDB.putRevenueEntry({
        entryId,
        txId: entryId,
        source,
        gameId,
        accountId,
        grossAmount: amount,
        commission: expected.platformCut,
        currency: 'aCoins',
        split: expected,
        occurredAt: Date.now(),
        recordedBy: 'server',
      });
      console.log(
        `[GameDev] 📒 GSO 收益记账 ${source}: ${account.gameName} +${amount} ` +
        `(平台份额 ${expected.platformCut} / 三方 g=${expected.gameCut},p=${expected.platformCut},c=${expected.creatorCut}) entry=${entryId}`,
      );
      return res.json({ success: true, data: { duplicate: false, entryId, split: expected } });
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
    revenueSharing: row.revenue_sharing
      ? (typeof row.revenue_sharing === 'string' ? JSON.parse(row.revenue_sharing) : row.revenue_sharing)
      : undefined,
    creatorOwed: row.creator_owed != null ? Number(row.creator_owed) : 0,
    creatorSettled: row.creator_settled != null ? Number(row.creator_settled) : 0,
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
