/**
 * GameDeveloperService - 游戏开发者账户管理服务
 *
 * 存储已迁移到后端数据库（MemoryDB / PostgreSQL）。
 * 前端维护内存缓存以避免频繁 API 调用。
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
import { getCachedToken } from './authTokenService';

// ==================== 常量 ====================

const API_BASE = '/api/v1/game-developers';
const DEFAULT_REVENUE_SHARE = 10;
const DAY_MS = 86400000;

// ==================== 内存缓存 ====================

const accountCache = new Map<string, GameDeveloperAccount>();
let txCache: DeveloperRevenueTransaction[] = [];
let allAccountsLoaded = false;

// ==================== API 工具 ====================

/**
 * 检查后端 API 是否可用（有有效 token）
 * 无 token 时跳过 API 调用，仅使用内存缓存，避免 401 错误洪流
 */
function isApiAvailable(): boolean {
  return getCachedToken() !== null;
}

async function apiFetch(path: string, options: RequestInit = {}): Promise<any> {
  const token = getCachedToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as any || {}),
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const resp = await fetch(`${API_BASE}${path}`, { ...options, headers });
  const json = await resp.json();
  if (!resp.ok) throw new Error(json.error || `HTTP ${resp.status}`);
  return json.data;
}

// ==================== 服务类 ====================

class GameDeveloperService {
  // ============ 账户管理 ============

  async ensureAccount(params: {
    gameId: string;
    gameName: string;
    publisherId: string;
    publisherName: string;
    revenueSharePercent?: number;
  }): Promise<GameDeveloperAccount> {
    const accountId = getGameDeveloperAccountId(params.gameId);
    const existing = accountCache.get(accountId);

    if (existing) {
      existing.gameName = params.gameName;
      existing.publisherName = params.publisherName;
      existing.updatedAt = Date.now();
      await this.saveAccount(existing);
      return existing;
    }

    // 尝试从后端获取（仅在有 token 时）
    if (isApiAvailable()) {
      try {
        const remote = await apiFetch(`/${accountId}`) as GameDeveloperAccount | null;
        if (remote) {
          accountCache.set(accountId, remote);
          remote.gameName = params.gameName;
          remote.publisherName = params.publisherName;
          remote.updatedAt = Date.now();
          await this.saveAccount(remote);
          return remote;
        }
      } catch { /* 404 = 不存在，继续创建 */ }
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
      stats: { totalSoldItems: 0, totalSoldVouchers: 0, itemSales: {} },
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };

    accountCache.set(accountId, newAccount);
    await this.saveAccount(newAccount);
    console.log(`[GameDev] 创建开发者账户: ${accountId} (${params.gameName}), 分成: ${newAccount.revenueSharePercent}%`);
    return newAccount;
  }

  async getAccount(gameId: string): Promise<GameDeveloperAccount | undefined> {
    const accountId = getGameDeveloperAccountId(gameId);
    if (accountCache.has(accountId)) return accountCache.get(accountId);
    if (isApiAvailable()) {
      try {
        const remote = await apiFetch(`/${accountId}`) as GameDeveloperAccount;
        if (remote) { accountCache.set(accountId, remote); return remote; }
      } catch { /* 404 */ }
    }
    return undefined;
  }

  async getAllAccounts(activeOnly = true): Promise<GameDeveloperAccount[]> {
    if (!allAccountsLoaded && isApiAvailable()) {
      try {
        const accounts = await apiFetch('') as GameDeveloperAccount[];
        for (const a of accounts) accountCache.set(a.accountId, a);
        allAccountsLoaded = true;
      } catch (e) {
        console.warn('[GameDev] 加载账户列表失败:', e);
      }
    }
    const all = Array.from(accountCache.values());
    return activeOnly ? all.filter(a => a.status === 'active') : all;
  }

  async updateAccount(gameId: string, updates: Partial<GameDeveloperAccount>): Promise<GameDeveloperAccount | undefined> {
    const accountId = getGameDeveloperAccountId(gameId);
    const account = accountCache.get(accountId);
    if (!account) return undefined;
    Object.assign(account, updates, { updatedAt: Date.now() });
    await this.saveAccount(account);
    return account;
  }

  private async saveAccount(account: GameDeveloperAccount): Promise<void> {
    accountCache.set(account.accountId, account);
    if (!isApiAvailable()) return; // 无 token 时跳过 API 调用
    try {
      await apiFetch('', { method: 'POST', body: JSON.stringify(account) });
    } catch (e) {
      console.warn('[GameDev] API 保存失败（仅内存）:', e);
    }
  }

  // ============ 收入记录 ============

  async recordPurchaseRevenue(params: {
    gameId: string;
    gameName?: string;
    amount: number;
    itemName: string;
    templateId?: string;
    buyerId: string;
    buyerName: string;
  }): Promise<void> {
    const account = await this.getAccount(params.gameId);
    if (!account) {
      console.warn(`[GameDev] 游戏 ${params.gameId} 无开发者账户，无法记录收入`);
      return;
    }

    const sharePercent = account.revenueSharePercent;
    const platformCut = Math.floor(params.amount * sharePercent / 100);

    account.totalRevenue += params.amount;
    account.availableBalance += params.amount;
    account.platformOwed += platformCut;
    account.stats.totalSoldItems += 1;
    account.stats.totalSoldVouchers += 1;

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
    await this.saveAccount(account);

    await this.recordTransaction({
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

  async executeDailySettlement(gameId?: string): Promise<{
    success: boolean;
    settledAccounts: number;
    totalSettled: number;
    message: string;
  }> {
    const accounts = await this.getAllAccounts(true);
    const targets = gameId
      ? accounts.filter(a => a.accountId === getGameDeveloperAccountId(gameId))
      : accounts;

    const now = Date.now();
    let settledCount = 0;
    let totalSettled = 0;
    const batchId = `settlement_${Date.now()}`;

    for (const account of targets) {
      const shouldSettle = account.platformOwed > 0 &&
        (now - account.lastDailySettlement >= DAY_MS);
      if (!shouldSettle) continue;

      const settleAmount = account.platformOwed;
      try {
        const devVouchers = voucherService.getUserVouchers(account.accountId)
          .filter(v => v.status === VoucherStatus.ACTIVE)
          .sort((a, b) => a.denomination - b.denomination);

        let remainingToSettle = settleAmount;
        const settledFromVouchers: Voucher[] = [];

        for (const v of devVouchers) {
          if (remainingToSettle <= 0) break;
          if (v.denomination <= remainingToSettle) {
            settledFromVouchers.push(v);
            remainingToSettle -= v.denomination;
          }
        }

        for (const v of settledFromVouchers) {
          try {
            voucherService.transferVoucher(
              { voucherId: v.id, toUserId: SYSTEM_ACCOUNTS.PLATFORM_TREASURY, toUserName: '平台金库', note: `每日结算: ${account.gameName} 分成 ${v.denomination} A币` },
              account.accountId, account.gameName
            );
          } catch {
            remainingToSettle += v.denomination;
          }
        }

        const actuallySettled = settleAmount - Math.max(0, remainingToSettle);
        if (actuallySettled > 0) {
          platformTreasuryService.depositCommission('aCoins', actuallySettled, 'platform_collect',
            `每日结算: ${account.gameName} (${account.revenueSharePercent}% 分成)`,
            { gameId: account.gameId, accountId: account.accountId, batchId });

          account.platformOwed = Math.max(0, account.platformOwed - actuallySettled);
          account.platformSettled += actuallySettled;
          account.lastDailySettlement = now;
          account.updatedAt = now;
          await this.saveAccount(account);

          await this.recordTransaction({
            gameId: account.gameId, accountId: account.accountId,
            type: 'settlement', amount: actuallySettled, currency: 'aCoins',
            description: `每日结算: ${account.gameName} → platform_treasury, ${account.revenueSharePercent}% = ${actuallySettled} A币`,
            metadata: { settleAmount, actuallySettled, remainingToSettle, batchId },
          });

          settledCount++;
          totalSettled += actuallySettled;
        }
      } catch (e) {
        console.error(`[GameDev] 结算 ${account.gameName} 失败:`, e);
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

  async checkAndSettle(): Promise<void> {
    console.log('[GameDev] 🔍 检查每日结算...');
    const result = await this.executeDailySettlement();
    if (result.settledAccounts > 0) {
      console.log(`[GameDev] 📊 ${result.message}`);
    }
  }

  // ============ 提现管理 ============

  async withdrawRevenue(params: {
    gameId: string;
    amount: number;
    toUserId: string;
    toUserName: string;
  }): Promise<{ success: boolean; message: string }> {
    const account = await this.getAccount(params.gameId);
    if (!account) return { success: false, message: '开发者账户不存在' };
    if (account.status !== 'active') return { success: false, message: '账户已被冻结或关闭' };

    const availableForWithdraw = account.availableBalance - account.platformOwed;
    if (params.amount > availableForWithdraw) {
      return { success: false, message: `余额不足，可提现金额 ${availableForWithdraw} A币` };
    }

    const devVouchers = voucherService.getUserVouchers(account.accountId)
      .filter(v => v.status === VoucherStatus.ACTIVE)
      .sort((a, b) => a.denomination - b.denomination);

    let remaining = params.amount;
    const transferred: Voucher[] = [];
    for (const v of devVouchers) {
      if (remaining <= 0) break;
      if (v.denomination <= remaining) { transferred.push(v); remaining -= v.denomination; }
    }
    if (remaining > 0) return { success: false, message: `无法拆分凭证完成 ${params.amount} A币提现` };

    for (const v of transferred) {
      try {
        voucherService.transferVoucher(
          { voucherId: v.id, toUserId: params.toUserId, toUserName: params.toUserName, note: `提现: ${account.gameName} 收入 ${v.denomination} A币` },
          account.accountId, account.gameName
        );
      } catch (e) {
        return { success: false, message: `凭证转移失败: ${e instanceof Error ? e.message : String(e)}` };
      }
    }

    account.totalWithdrawn += params.amount;
    account.availableBalance -= params.amount;
    account.updatedAt = Date.now();
    await this.saveAccount(account);

    await this.recordTransaction({
      gameId: params.gameId, accountId: account.accountId,
      type: 'withdrawal', amount: params.amount, currency: 'aCoins',
      description: `${account.publisherName} 提现 ${params.amount} A币`,
      fromUserId: params.toUserId, fromUserName: params.toUserName,
    });

    console.log(`[GameDev] 💸 提现: ${account.gameName} → ${params.toUserName} ${params.amount} A币`);
    return { success: true, message: `成功提现 ${params.amount} A币` };
  }

  // ============ 查询方法 ============

  async getDeveloperOverview(): Promise<GameDeveloperOverview[]> {
    const accounts = await this.getAllAccounts(true);
    return accounts.map(a => ({
      accountId: a.accountId, gameId: a.gameId, gameName: a.gameName,
      publisherId: a.publisherId, publisherName: a.publisherName,
      revenueSharePercent: a.revenueSharePercent,
      totalRevenue: a.totalRevenue, availableBalance: a.availableBalance,
      platformOwed: a.platformOwed, platformSettled: a.platformSettled,
      totalWithdrawn: a.totalWithdrawn, totalSoldItems: a.stats.totalSoldItems,
      status: a.status, lastDailySettlement: a.lastDailySettlement,
    }));
  }

  async getTransactions(gameId?: string, limit?: number): Promise<DeveloperRevenueTransaction[]> {
    if (isApiAvailable()) {
      try {
        if (gameId) {
          const accountId = getGameDeveloperAccountId(gameId);
          return await apiFetch(`/${accountId}/transactions?limit=${limit || 50}`);
        }
        return await apiFetch(`/transactions?limit=${limit || 50}`);
      } catch (e) {
        console.warn('[GameDev] 获取交易记录失败:', e);
      }
    }
    const filtered = gameId ? txCache.filter(t => t.gameId === gameId) : txCache;
    return filtered.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit || 50);
  }

  async getItemSalesStats(gameId: string): Promise<GameItemSaleStat[]> {
    const account = await this.getAccount(gameId);
    if (!account) return [];
    return Object.values(account.stats.itemSales).sort((a, b) => b.totalRevenue - a.totalRevenue);
  }

  async getDeveloperVoucherHoldings(gameId: string): Promise<{
    totalFaceValue: number; voucherCount: number; activeCount: number; vouchers: Voucher[];
  }> {
    const accountId = getGameDeveloperAccountId(gameId);
    const vouchers = voucherService.getUserVouchers(accountId);
    const active = vouchers.filter(v => v.status === VoucherStatus.ACTIVE);
    return {
      totalFaceValue: active.reduce((s, v) => s + v.denomination, 0),
      voucherCount: vouchers.length, activeCount: active.length, vouchers,
    };
  }

  // ============ 私有方法 ============

  private async recordTransaction(tx: Omit<DeveloperRevenueTransaction, 'id' | 'timestamp'>): Promise<void> {
    const full: DeveloperRevenueTransaction = {
      id: `devtx_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
      ...tx,
    };
    txCache.push(full);
    if (!isApiAvailable()) return;
    try {
      await apiFetch(`/${full.accountId}/transaction`, { method: 'POST', body: JSON.stringify(full) });
    } catch (e) {
      console.warn('[GameDev] 交易记录 API 保存失败（仅内存）:', e);
    }
  }
}

// 导出单例
export const gameDeveloperService = new GameDeveloperService();
export default gameDeveloperService;
