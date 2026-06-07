/**
 * GameDeveloperService - 游戏开发者账户管理服务
 *
 * 管理 game-{gameId} 账户体系：
 * - 发布游戏时自动创建开发者账户
 * - 玩家购买道具的凭证收入转入 game-{gameId}
 * - 每日自动结算：按分成比例将平台分成转入 platform_treasury
 * - 提供查询：收入明细、销售统计、提现申请
 */

import { voucherService } from '@/voucher-system/services/VoucherService';
import { VoucherStatus } from '@/voucher-system/types';
import type { Voucher } from '@/voucher-system/types';
import {
  type GameDeveloperAccount,
  type GameItemSaleStat,
  type DeveloperRevenueTransaction,
  type GameDeveloperOverview,
  getGameDeveloperAccountId,
  SYSTEM_ACCOUNTS,
} from '@/types/gameDeveloper';
import { platformTreasuryService } from './platformTreasuryService';

// ==================== 常量 ====================

const DEVELOPER_ACCOUNTS_KEY = 'game_developer_accounts';
const DEVELOPER_TX_KEY = 'game_developer_transactions';
const DEFAULT_REVENUE_SHARE = 10; // 默认平台分成 10%
const DAY_MS = 86400000;

// ==================== 存储工具 ====================

function loadAccounts(): GameDeveloperAccount[] {
  try {
    const raw = localStorage.getItem(DEVELOPER_ACCOUNTS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveAccounts(accounts: GameDeveloperAccount[]): void {
  localStorage.setItem(DEVELOPER_ACCOUNTS_KEY, JSON.stringify(accounts));
  syncAccountsToCloud(accounts);
}

function syncAccountsToCloud(accounts: GameDeveloperAccount[]): void {
  import('./cloudbase').then(({ isCloudBaseReady, getCloudBaseApp }) => {
    if (!isCloudBaseReady()) return;
    const db = getCloudBaseApp().database();
    for (const a of accounts) {
      db.collection('game_developers').where({ accountId: a.accountId }).get().then(res => {
        if (res.data.length > 0) {
          db.collection('game_developers').doc(res.data[0]._id).update(a as any).catch(() => {});
        } else {
          db.collection('game_developers').add(a as any).catch(() => {});
        }
      }).catch(() => {});
    }
  }).catch(() => {});
}

function loadTx(): DeveloperRevenueTransaction[] {
  try {
    const raw = localStorage.getItem(DEVELOPER_TX_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveTx(txs: DeveloperRevenueTransaction[]): void {
  if (txs.length > 500) txs.splice(0, txs.length - 500);
  localStorage.setItem(DEVELOPER_TX_KEY, JSON.stringify(txs));
  syncTxToCloud(txs);
}

function syncTxToCloud(txs: DeveloperRevenueTransaction[]): void {
  import('./cloudbase').then(({ isCloudBaseReady, getCloudBaseApp }) => {
    if (!isCloudBaseReady()) return;
    const db = getCloudBaseApp().database();
    for (const tx of txs.slice(-10)) {
      db.collection('game_developers').where({ accountId: tx.accountId }).get().then(res => {
        if (res.data.length > 0) {
          db.collection('game_developers').doc(res.data[0]._id).update({
            revenueTransactions: db.command.push([tx]),
            _updatedAt: Date.now(),
          } as any).catch(() => {});
        }
      }).catch(() => {});
    }
  }).catch(() => {});
}

// ==================== 服务类 ====================

class GameDeveloperService {
  // ============ 账户管理 ============

  /**
   * 确保开发者账户存在（发布游戏时调用）
   * 已存在则更新游戏名称等信息，不存在则创建
   */
  ensureAccount(params: {
    gameId: string;
    gameName: string;
    publisherId: string;
    publisherName: string;
    revenueSharePercent?: number;
  }): GameDeveloperAccount {
    const accounts = loadAccounts();
    const accountId = getGameDeveloperAccountId(params.gameId);
    const existing = accounts.find(a => a.accountId === accountId);

    if (existing) {
      // 更新信息
      existing.gameName = params.gameName;
      existing.publisherName = params.publisherName;
      existing.updatedAt = Date.now();
      saveAccounts(accounts);
      console.log(`[GameDev] 更新开发者账户: ${accountId}`);
      return existing;
    }

    const now = Date.now();
    const newAccount: GameDeveloperAccount = {
      accountId,
      gameId: params.gameId,
      gameName: params.gameName,
      publisherId: params.publisherId,
      publisherName: params.publisherName,
      revenueSharePercent: params.revenueSharePercent ?? DEFAULT_REVENUE_SHARE,
      totalRevenue: 0,
      totalWithdrawn: 0,
      availableBalance: 0,
      platformOwed: 0,
      platformSettled: 0,
      lastDailySettlement: now,
      stats: {
        totalSoldItems: 0,
        totalSoldVouchers: 0,
        itemSales: {},
      },
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };

    accounts.push(newAccount);
    saveAccounts(accounts);
    console.log(`[GameDev] 创建开发者账户: ${accountId} (${params.gameName}), 分成: ${newAccount.revenueSharePercent}%`);
    return newAccount;
  }

  /**
   * 获取单个开发者账户
   */
  getAccount(gameId: string): GameDeveloperAccount | undefined {
    const accountId = getGameDeveloperAccountId(gameId);
    return loadAccounts().find(a => a.accountId === accountId);
  }

  /**
   * 获取所有开发者账户
   */
  getAllAccounts(activeOnly = true): GameDeveloperAccount[] {
    const accounts = loadAccounts();
    return activeOnly ? accounts.filter(a => a.status === 'active') : accounts;
  }

  /**
   * 更新开发者账户
   */
  updateAccount(gameId: string, updates: Partial<GameDeveloperAccount>): GameDeveloperAccount | undefined {
    const accounts = loadAccounts();
    const idx = accounts.findIndex(a => a.accountId === getGameDeveloperAccountId(gameId));
    if (idx === -1) return undefined;
    accounts[idx] = { ...accounts[idx], ...updates, updatedAt: Date.now() };
    saveAccounts(accounts);
    return accounts[idx];
  }

  // ============ 收入记录 ============

  /**
   * 💰 记录道具销售收入（购买时调用）
   * 
   * 计算平台分成并更新账户余额。
   * 分成采用"配对记账"方式：玩家付款全转游戏商，同时记录 platformOwed。
   * 每日结算时将 platformOwed 转移到 platform_treasury。
   */
  recordPurchaseRevenue(params: {
    gameId: string;
    gameName?: string;
    amount: number;
    itemName: string;
    templateId?: string;
    buyerId: string;
    buyerName: string;
  }): void {
    const account = this.getAccount(params.gameId);
    if (!account) {
      console.warn(`[GameDev] 游戏 ${params.gameId} 无开发者账户，无法记录收入`);
      return;
    }

    // 计算平台分成
    const sharePercent = account.revenueSharePercent;
    const platformCut = Math.floor(params.amount * sharePercent / 100);

    // 更新账户余额
    account.totalRevenue += params.amount;
    account.availableBalance += params.amount;
    account.platformOwed += platformCut;
    account.stats.totalSoldItems += 1;
    account.stats.totalSoldVouchers += 1;

    // 更新道具销售统计
    if (params.templateId) {
      if (!account.stats.itemSales[params.templateId]) {
        account.stats.itemSales[params.templateId] = {
          templateId: params.templateId,
          name: params.itemName,
          count: 0,
          totalRevenue: 0,
        };
      }
      account.stats.itemSales[params.templateId].count += 1;
      account.stats.itemSales[params.templateId].totalRevenue += params.amount;
    }

    account.updatedAt = Date.now();
    const accounts = loadAccounts();
    const idx = accounts.findIndex(a => a.accountId === account.accountId);
    if (idx >= 0) accounts[idx] = account;
    saveAccounts(accounts);

    // 记录交易日志
    this.recordTransaction({
      gameId: params.gameId,
      accountId: account.accountId,
      type: 'purchase',
      amount: params.amount,
      currency: 'aCoins',
      description: `玩家 ${params.buyerName} 购买 ${params.itemName}，平台分成 ${platformCut} A币 (${sharePercent}%)`,
      fromUserId: params.buyerId,
      fromUserName: params.buyerName,
      metadata: { templateId: params.templateId, platformCut },
    });

    console.log(
      `[GameDev] 💰 ${account.gameName} 收入 +${params.amount} A币 (${params.itemName}), 待结算分成: ${platformCut} A币`
    );
  }

  /**
   * 🔄 每日结算：将 game-{gameId} 的 platformOwed 转入 platform_treasury
   * 
   * 应在每日 00:00 或应用启动时调用。
   * 从游戏商账户转移 platformOwed 面额的凭证到平台金库。
   */
  executeDailySettlement(gameId?: string): {
    success: boolean;
    settledAccounts: number;
    totalSettled: number;
    message: string;
  } {
    const accounts = gameId
      ? loadAccounts().filter(a => a.accountId === getGameDeveloperAccountId(gameId) && a.status === 'active')
      : loadAccounts().filter(a => a.status === 'active');

    const now = Date.now();
    let settledCount = 0;
    let totalSettled = 0;

    const batchId = `settlement_${Date.now()}`;

    for (const account of accounts) {
      // 🔒 S2-4 修复：检查幂等性 — 同一天不重复结算
      const shouldSettle = account.platformOwed > 0 &&
        (now - account.lastDailySettlement >= DAY_MS);

      if (!shouldSettle) continue;

      const settleAmount = account.platformOwed;

      try {
        // 从游戏商账户转移凭证到平台金库
        const devVouchers = voucherService.getUserVouchers(account.accountId)
          .filter(v => v.status === VoucherStatus.ACTIVE)
          .sort((a, b) => a.denomination - b.denomination);

        let remainingToSettle = settleAmount;
        let settledFromVouchers: Voucher[] = [];

        // 尝试用现有凭证拆分（优先选面额最小的组合）
        for (const v of devVouchers) {
          if (remainingToSettle <= 0) break;
          if (v.denomination <= remainingToSettle) {
            settledFromVouchers.push(v);
            remainingToSettle -= v.denomination;
          }
        }

        // 转移选中的凭证到 platform_treasury
        for (const v of settledFromVouchers) {
          try {
            voucherService.transferVoucher(
              {
                voucherId: v.id,
                toUserId: SYSTEM_ACCOUNTS.PLATFORM_TREASURY,
                toUserName: '平台金库',
                note: `每日结算: ${account.gameName} 分成 ${v.denomination} A币`,
              },
              account.accountId,
              account.gameName
            );
          } catch (e) {
            console.warn(`[GameDev] 凭证 ${v.id} 转移失败:`, e);
            remainingToSettle += v.denomination;
          }
        }

        const actuallySettled = settleAmount - Math.max(0, remainingToSettle);

        if (actuallySettled > 0) {
          // 记录到平台金库
          platformTreasuryService.depositCommission(
            'aCoins',
            actuallySettled,
            'platform_collect',
            `每日结算: ${account.gameName} (${account.revenueSharePercent}% 分成)`,
            { gameId: account.gameId, accountId: account.accountId, batchId }
          );

          // 更新开发者账户
          account.platformOwed = Math.max(0, account.platformOwed - actuallySettled);
          account.platformSettled += actuallySettled;
          account.lastDailySettlement = now;
          account.updatedAt = now;

          // 记录结算交易
          this.recordTransaction({
            gameId: account.gameId,
            accountId: account.accountId,
            type: 'settlement',
            amount: actuallySettled,
            currency: 'aCoins',
            description: `每日结算: ${account.gameName} → platform_treasury, ${account.revenueSharePercent}% = ${actuallySettled} A币`,
            metadata: { settleAmount, actuallySettled, remainingToSettle, batchId },
          });

          // 🔒 S2-4 修复：立即持久化该账户（不等待其他账户）
          const allAccounts = loadAccounts();
          const idx = allAccounts.findIndex(ac => ac.accountId === account.accountId);
          if (idx >= 0) {
            allAccounts[idx] = account;
            saveAccounts(allAccounts);
          }

          settledCount++;
          totalSettled += actuallySettled;
          console.log(`[GameDev] ✅ 每日结算: ${account.gameName} → platform_treasury ${actuallySettled} A币 (batch: ${batchId})`);
        }

      } catch (e) {
        console.error(`[GameDev] 结算 ${account.gameName} 失败:`, e);
        // 🔒 S2-4 修复：单个账户失败不影响其他账户，下次 checkAndSettle 重试
      }
    }

    return {
      success: true,
      settledAccounts: settledCount,
      totalSettled,
      message: settledCount > 0
        ? `已结算 ${settledCount} 个游戏商账户，共转入平台金库 ${totalSettled} A币`
        : '无待结算账户',
    };
  }

  /**
   * 检查并自动执行每日结算（应在应用启动时调用）
   */
  checkAndSettle(): void {
    console.log('[GameDev] 🔍 检查每日结算...');
    const result = this.executeDailySettlement();
    if (result.settledAccounts > 0) {
      console.log(`[GameDev] 📊 ${result.message}`);
    }
  }

  // ============ 提现管理 ============

  /**
   * 发起提现申请（开发者从游戏账户提现到个人钱包）
   * 
   * 注意：实际提现应走投票治理流程，此处为直接提现（MVP 阶段简化）
   */
  withdrawRevenue(params: {
    gameId: string;
    amount: number;
    toUserId: string;
    toUserName: string;
  }): { success: boolean; message: string } {
    const account = this.getAccount(params.gameId);
    if (!account) {
      return { success: false, message: '开发者账户不存在' };
    }

    if (account.status !== 'active') {
      return { success: false, message: '账户已被冻结或关闭' };
    }

    const availableForWithdraw = account.availableBalance - account.platformOwed;
    if (params.amount > availableForWithdraw) {
      return {
        success: false,
        message: `余额不足，可提现金额 ${availableForWithdraw} A币（总余额 ${account.availableBalance} - 待结算 ${account.platformOwed}）`,
      };
    }

    // 从游戏商账户转移凭证到用户
    const devVouchers = voucherService.getUserVouchers(account.accountId)
      .filter(v => v.status === VoucherStatus.ACTIVE)
      .sort((a, b) => a.denomination - b.denomination);

    let remaining = params.amount;
    const transferredVouchers: Voucher[] = [];

    for (const v of devVouchers) {
      if (remaining <= 0) break;
      if (v.denomination <= remaining) {
        transferredVouchers.push(v);
        remaining -= v.denomination;
      }
    }

    if (remaining > 0) {
      return { success: false, message: `无法拆分凭证完成 ${params.amount} A币提现，剩余 ${remaining} A币` };
    }

    // 执行转移
    for (const v of transferredVouchers) {
      try {
        voucherService.transferVoucher(
          {
            voucherId: v.id,
            toUserId: params.toUserId,
            toUserName: params.toUserName,
            note: `提现: ${account.gameName} 收入 ${v.denomination} A币`,
          },
          account.accountId,
          account.gameName
        );
      } catch (e) {
        return { success: false, message: `凭证转移失败: ${e instanceof Error ? e.message : String(e)}` };
      }
    }

    // 更新账户
    account.totalWithdrawn += params.amount;
    account.availableBalance -= params.amount;
    account.updatedAt = Date.now();

    const accounts = loadAccounts();
    const idx = accounts.findIndex(a => a.accountId === account.accountId);
    if (idx >= 0) accounts[idx] = account;
    saveAccounts(accounts);

    // 记录交易
    this.recordTransaction({
      gameId: params.gameId,
      accountId: account.accountId,
      type: 'withdrawal',
      amount: params.amount,
      currency: 'aCoins',
      description: `${account.publisherName} 提现 ${params.amount} A币`,
      fromUserId: params.toUserId,
      fromUserName: params.toUserName,
    });

    console.log(`[GameDev] 💸 提现: ${account.gameName} → ${params.toUserName} ${params.amount} A币`);
    return { success: true, message: `成功提现 ${params.amount} A币` };
  }

  // ============ 查询方法 ============

  /**
   * 获取游戏开发者概览列表（平台管理端用）
   */
  getDeveloperOverview(): GameDeveloperOverview[] {
    return this.getAllAccounts(true).map(a => ({
      accountId: a.accountId,
      gameId: a.gameId,
      gameName: a.gameName,
      publisherId: a.publisherId,
      publisherName: a.publisherName,
      revenueSharePercent: a.revenueSharePercent,
      totalRevenue: a.totalRevenue,
      availableBalance: a.availableBalance,
      platformOwed: a.platformOwed,
      platformSettled: a.platformSettled,
      totalWithdrawn: a.totalWithdrawn,
      totalSoldItems: a.stats.totalSoldItems,
      status: a.status,
      lastDailySettlement: a.lastDailySettlement,
    }));
  }

  /**
   * 获取游戏收入交易记录
   */
  getTransactions(gameId?: string, limit?: number): DeveloperRevenueTransaction[] {
    const all = loadTx();
    const filtered = gameId ? all.filter(t => t.gameId === gameId) : all;
    const sorted = filtered.sort((a, b) => b.timestamp - a.timestamp);
    return limit ? sorted.slice(0, limit) : sorted;
  }

  /**
   * 获取游戏道具销售统计
   */
  getItemSalesStats(gameId: string): GameItemSaleStat[] {
    const account = this.getAccount(gameId);
    if (!account) return [];
    return Object.values(account.stats.itemSales)
      .sort((a, b) => b.totalRevenue - a.totalRevenue);
  }

  /**
   * 获取开发者账户的凭证持有情况
   */
  getDeveloperVoucherHoldings(gameId: string): {
    totalFaceValue: number;
    voucherCount: number;
    activeCount: number;
    vouchers: Voucher[];
  } {
    const accountId = getGameDeveloperAccountId(gameId);
    const vouchers = voucherService.getUserVouchers(accountId);
    const active = vouchers.filter(v => v.status === VoucherStatus.ACTIVE);
    return {
      totalFaceValue: active.reduce((s, v) => s + v.denomination, 0),
      voucherCount: vouchers.length,
      activeCount: active.length,
      vouchers,
    };
  }

  // ============ 私有方法 ============

  private recordTransaction(tx: Omit<DeveloperRevenueTransaction, 'id' | 'timestamp'>): void {
    const full: DeveloperRevenueTransaction = {
      id: `devtx_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
      ...tx,
    };

    const txs = loadTx();
    txs.push(full);
    saveTx(txs);
  }
}

// 导出单例
export const gameDeveloperService = new GameDeveloperService();
export default gameDeveloperService;
