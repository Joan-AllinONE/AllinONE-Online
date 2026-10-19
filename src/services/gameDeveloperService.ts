/**
 * GameDeveloperService - 游戏开发者账户管理服务
 *
 * 存储已迁移到后端数据库（MemoryDB / PostgreSQL）。
 * 前端维护内存缓存以避免频繁 API 调用。
 */

import { voucherService } from '@/voucher-system/services/VoucherService';
import { VoucherStatus, isCurrencyVoucher } from '@/voucher-system/types';
import type { Voucher } from '@/voucher-system/types';
import {
  type GameDeveloperAccount,
  type GameItemSaleStat,
  type DeveloperRevenueTransaction,
  type GameDeveloperOverview,
  type RevenueSharingConfig,
  getGameDeveloperAccountId,
  SYSTEM_ACCOUNTS,
} from '@/types/gameDeveloper';
import { computeThreeWaySplit, hasActiveSharingConfig, validateRevenueSharingConfig } from './revenueSplit';
import { platformTreasuryService } from './platformTreasuryService';
import { getCachedToken, getToken } from './authTokenService';
import { getFeatureApiBase } from './apiBase';
import { getRuleValue } from './platformRulesService';

// ==================== 常量 ====================

const API_BASE = getFeatureApiBase('game-developers');
// 分成默认值（settlement.revenue_share_percent）与结算周期（settlement.cycle_ms）
// 均读取规则注册中心（治理门控修改）

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
  // 🆕 缓存未命中时异步补签 token（首次调用/过期/换 userId），
  // 否则请求不带 Authorization 头 → 401 "Missing or invalid authorization header"
  const token = getCachedToken() ?? await getToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as any || {}),
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const resp = await fetch(`${API_BASE}${path}`, { ...options, headers });
  // 🆕 非 JSON 响应防护：拿到 HTML（Express 默认 404 "Cannot POST"、SPA fallback index.html、
  // 静态托管 rewrite）时，resp.json() 只会报 "Unexpected token '<'"，无法定位。
  // 典型根因：server.js 进程是旧代码（新增端点未编译/未重启）。
  const raw = await resp.text();
  let json: any;
  try {
    json = JSON.parse(raw);
  } catch {
    const snippet = raw.slice(0, 120).replace(/\s+/g, ' ').trim();
    const hint = /cannot (post|get|put|delete)/i.test(snippet)
      ? '——路由不存在：server.js 可能未用最新编译产物重启'
      : '';
    throw new Error(`后端返回非 JSON（HTTP ${resp.status}）${hint}: ${snippet}`);
  }
  if (!resp.ok) throw new Error(json.error || `HTTP ${resp.status}`);
  return json.data;
}

// ==================== 凭证凑整（落袋通用） ====================

export interface VoucherPickResult {
  /** 直接转移的凭证（面额之和 >= amount 或精确组合） */
  transferred: Voucher[];
  /** 大面额凭证转移后需要由游戏商账户铸造的找零总额（转回 game-{gameId}） */
  changeTotal: number;
}

/**
 * 🆕 从持有凭证中凑出 amount：
 * 1) 优先精确组合（小到大贪心，面额之和 === amount）
 * 2) 凑不出 → 取最小的一张 denomination >= amount 的大面额凭证转移，
 *    差额 (denomination - amount) 由游戏商账户铸造找零凭证转回自己（与购买找零同模式）
 */
export function pickVouchersWithChange(
  vouchers: Voucher[],
  amount: number,
): VoucherPickResult | null {
  if (amount <= 0) return { transferred: [], changeTotal: 0 };

  // 1) 精确组合（小到大贪心，能凑满则全取）
  const sorted = [...vouchers].sort((a, b) => a.denomination - b.denomination);
  let acc = 0;
  const exact: Voucher[] = [];
  for (const v of sorted) {
    if (acc >= amount) break;
    exact.push(v);
    acc += v.denomination;
  }
  if (acc === amount) return { transferred: exact, changeTotal: 0 };

  // 2) 大面额 + 找零：选 denomination >= amount 的最小一张
  const cover = sorted.find(v => v.denomination >= amount);
  if (cover) {
    return { transferred: [cover], changeTotal: cover.denomination - amount };
  }
  return null; // 全部凭证面额之和都不足 amount
}

/** 执行「转移凭证 + 游戏商账户铸找零回自己」 */
async function transferWithChange(
  pick: VoucherPickResult,
  toUserId: string,
  toUserName: string,
  noteBase: string,
  gameAccountId: string,
  gameAccountName: string,
): Promise<void> {
  for (const v of pick.transferred) {
    voucherService.transferVoucher(
      { voucherId: v.id, toUserId, toUserName, note: `${noteBase}: ${v.denomination} A币` },
      gameAccountId, gameAccountName,
    );
  }
  if (pick.changeTotal > 0) {
    voucherService.createVoucher(
      {
        denomination: pick.changeTotal,
        recipientId: gameAccountId,
        recipientName: gameAccountName,
        metadata: { name: '结算找零', description: `${noteBase} 大面额拆分找零`, category: 'change' },
        note: `${noteBase} 找零`,
      },
      gameAccountId, gameAccountName,
    );
  }
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
      revenueSharePercent: params.revenueSharePercent ?? getRuleValue('settlement.revenue_share_percent'),
      totalRevenue: 0,
      totalWithdrawn: 0,
      availableBalance: 0,
      platformOwed: 0,
      platformSettled: 0,
      lastDailySettlement: now,
      creatorOwed: 0,
      creatorSettled: 0,
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

  async getAllAccounts(activeOnly = true, forceRefresh = false): Promise<GameDeveloperAccount[]> {
    // forceRefresh=true 时绕过一次性加载标记（监控台每次 reload 需要最新配置）
    if ((forceRefresh || !allAccountsLoaded) && isApiAvailable()) {
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

    // ═══ A币（凭证）收入：三方分账 ═══
    // 账户带 revenueSharing 走三方比例；否则 legacy 单极（平台抽 revenueSharePercent%）
    // 尾差归游戏方（computeThreeWaySplit 保证三方之和 === amount）
    const split = computeThreeWaySplit(params.amount, account.revenueSharing, account.revenueSharePercent);

    account.totalRevenue += params.amount;
    account.availableBalance += params.amount;
    account.platformOwed += split.platformCut;
    if (split.creatorCut > 0) {
      account.creatorOwed = (account.creatorOwed || 0) + split.creatorCut;
    }
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
      description:
        split.mode === 'three-way'
          ? `玩家 ${params.buyerName} 购买 ${params.itemName}，三方分账 游戏${split.gameCut}/平台${split.platformCut}/创作者${split.creatorCut}`
          : `玩家 ${params.buyerName} 购买 ${params.itemName}，平台分成 ${split.platformCut} A币 (${account.revenueSharePercent}%)`,
      fromUserId: params.buyerId,
      fromUserName: params.buyerName,
      metadata: {
        templateId: params.templateId,
        platformCut: split.platformCut,
        // 🆕 三方分账明细（服务端影子对照的数据源）
        split: {
          gameCut: split.gameCut,
          platformCut: split.platformCut,
          creatorCut: split.creatorCut,
          mode: split.mode,
        },
      },
    });

    console.log(
      `[GameDev] 💰 ${account.gameName} 收入 +${params.amount} A币 (${params.itemName}), ` +
      `三方分账: 游戏 ${split.gameCut} / 平台 ${split.platformCut} / 创作者 ${split.creatorCut} (${split.mode})`
    );
  }

  async executeDailySettlement(gameId?: string, opts?: { force?: boolean }): Promise<{
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
      // force=true（面板「立即结算」按钮）跳过日结周期门槛，platformOwed > 0 即结算
      const shouldSettle = account.platformOwed > 0 &&
        (opts?.force === true || now - account.lastDailySettlement >= getRuleValue('settlement.cycle_ms'));
      if (!shouldSettle) continue;

      const settleAmount = account.platformOwed;
      try {
        const devVouchers = voucherService.getUserVouchers(account.accountId)
          .filter(v => v.status === VoucherStatus.ACTIVE && isCurrencyVoucher((v as any).sourceType))
          .sort((a, b) => a.denomination - b.denomination);

        const pick = pickVouchersWithChange(devVouchers, settleAmount);
        if (!pick || pick.transferred.length === 0) {
          console.warn(`[GameDev] 结算 ${account.gameName} 跳过：账户无可用于凑整的凭证（持有凭证不足以覆盖 ${settleAmount} A币）`);
          continue;
        }

        try {
          await transferWithChange(
            pick, SYSTEM_ACCOUNTS.PLATFORM_TREASURY, '平台金库',
            `每日结算: ${account.gameName} 分成`, account.accountId, `${account.gameName} 开发者`,
          );
        } catch (transferErr) {
          console.error(`[GameDev] 结算 ${account.gameName} 凭证转移失败:`, transferErr);
          continue;
        }

        const actuallySettled = settleAmount;
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
          metadata: { settleAmount, actuallySettled, force: opts?.force === true, changeTotal: pick.changeTotal, batchId },
        });

        settledCount++;
        totalSettled += actuallySettled;
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

    // 可提现 = 总余额 - 平台待结算 - 创作者待结算（creatorOwed 是账户余额上的留置权）
    const availableForWithdraw = account.availableBalance - account.platformOwed - (account.creatorOwed || 0);
    if (params.amount > availableForWithdraw) {
      return { success: false, message: `余额不足，可提现金额 ${availableForWithdraw} A币` };
    }

    const devVouchers = voucherService.getUserVouchers(account.accountId)
      .filter(v => v.status === VoucherStatus.ACTIVE && isCurrencyVoucher((v as any).sourceType))
      .sort((a, b) => a.denomination - b.denomination);

    // 🆕 凑整 + 找零：精确组合凑不出时用大面额凭证转移，差额由游戏商账户铸找零转回自己
    const pick = pickVouchersWithChange(devVouchers, params.amount);
    if (!pick || pick.transferred.length === 0) {
      return {
        success: false,
        message: `游戏商账户（${account.accountId}）持有凭证总额不足 ${params.amount} A币（游戏币支付的收入不产生 A币凭证，无法用于凭证提现）`,
      };
    }

    try {
      await transferWithChange(
        pick, params.toUserId, params.toUserName,
        `提现: ${account.gameName} 收入`, account.accountId, `${account.gameName} 开发者`,
      );
    } catch (e) {
      return { success: false, message: `凭证转移失败: ${e instanceof Error ? e.message : String(e)}` };
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
      metadata: { changeTotal: pick.changeTotal },
    });

    console.log(`[GameDev] 💸 提现: ${account.gameName} → ${params.toUserName} ${params.amount} A币`);
    return { success: true, message: `成功提现 ${params.amount} A币` };
  }

  /**
   * 🆕 创作者提现：从游戏商账户持有的凭证中，把创作者待结算份额转移给创作者
   * 资金来源是该游戏道具销售中按 creatorShare 累积的 creatorOwed
   */
  async withdrawCreatorRevenue(params: {
    gameId: string;
    amount: number;
    creatorId: string;
    creatorName: string;
  }): Promise<{ success: boolean; message: string }> {
    const account = await this.getAccount(params.gameId);
    if (!account) return { success: false, message: '开发者账户不存在' };
    if (account.status !== 'active') return { success: false, message: '账户已被冻结或关闭' };

    // 身份校验：只有配置中登记的创作者本人可提取
    const sharing = account.revenueSharing;
    if (!sharing || !sharing.creatorId) {
      return { success: false, message: '该游戏未配置创作者分成' };
    }
    if (sharing.creatorId !== params.creatorId) {
      return { success: false, message: '只有分成配置中登记的创作者可以提取该份额' };
    }

    const owed = account.creatorOwed || 0;
    if (params.amount > owed) {
      return { success: false, message: `创作者待结算余额不足，当前 ${owed} A币` };
    }

    const devVouchers = voucherService.getUserVouchers(account.accountId)
      .filter(v => v.status === VoucherStatus.ACTIVE && isCurrencyVoucher((v as any).sourceType))
      .sort((a, b) => a.denomination - b.denomination);

    // 🆕 凑整 + 找零：精确组合凑不出时用大面额凭证转移，差额由游戏商账户铸找零转回自己
    const pick = pickVouchersWithChange(devVouchers, params.amount);
    if (!pick || pick.transferred.length === 0) {
      return {
        success: false,
        message: `游戏商账户（${account.accountId}）持有凭证总额不足 ${params.amount} A币（游戏币支付的收入不产生 A币凭证，无法用于创作者分成发放）`,
      };
    }

    try {
      await transferWithChange(
        pick, params.creatorId, params.creatorName,
        `创作者分成提现: ${account.gameName}`, account.accountId, `${account.gameName} 开发者`,
      );
    } catch (e) {
      return { success: false, message: `凭证转移失败: ${e instanceof Error ? e.message : String(e)}` };
    }

    account.creatorOwed = owed - params.amount;
    account.creatorSettled = (account.creatorSettled || 0) + params.amount;
    account.updatedAt = Date.now();
    await this.saveAccount(account);

    await this.recordTransaction({
      gameId: params.gameId, accountId: account.accountId,
      type: 'withdrawal', amount: params.amount, currency: 'aCoins',
      description: `创作者 ${params.creatorName} 提现分成 ${params.amount} A币`,
      fromUserId: params.creatorId, fromUserName: params.creatorName,
      metadata: { creatorWithdrawal: true, creatorId: params.creatorId, source: sharing.source, changeTotal: pick.changeTotal },
    });

    console.log(`[GameDev] 💸 创作者提现: ${account.gameName} → ${params.creatorName} ${params.amount} A币`);
    return { success: true, message: `成功提现创作者分成 ${params.amount} A币` };
  }

  // ============ 三方分成配置 ============

  /**
   * 🆕 游戏币支付的三方即时分账（2026-10-08 语义澄清：gameCoins 是平台通用货币且为主要结算货币）
   *
   * 玩家 wallet.spend 扣款后调用本方法 → 服务端按账户分成配置独立重算并【即时】credit 三方钱包：
   *   游戏方份额 → publisherId 个人钱包；平台份额 → platform_treasury；创作者份额 → creatorId。
   * gameCoins 是余额制，无留置权/批量落袋环节，三方钱包立即变化。
   */
  async settleGameCoinsSplit(params: {
    gameId: string;
    amount: number;
    buyerId: string;
    buyerName: string;
    itemName: string;
    templateId?: string;
  }): Promise<{
    success: boolean;
    message: string;
    split?: { gameCut: number; platformCut: number; creatorCut: number; mode: string };
  }> {
    const accountId = getGameDeveloperAccountId(params.gameId);
    try {
      const data = await apiFetch(`/${accountId}/gamecoins-split`, {
        method: 'POST',
        body: JSON.stringify({
          gameId: params.gameId,
          amount: params.amount,
          buyerId: params.buyerId,
          buyerName: params.buyerName,
          itemName: params.itemName,
          templateId: params.templateId,
        }),
      });
      const split = data?.split;
      // 本地簿记同步（服务端为权威；cache 增量便于面板展示，saveAccount 全量回写时一致）
      const account = await this.getAccount(params.gameId);
      if (account) {
        account.gameCoinsRevenue = (account.gameCoinsRevenue || 0) + params.amount;
        account.updatedAt = Date.now();
        // 只更新 cache，不触发 saveAccount 全量覆盖（服务端已持久化）
      }
      return {
        success: true,
        message: `游戏币三方分账完成：游戏 ${split?.gameCut ?? 0} / 平台 ${split?.platformCut ?? 0} / 创作者 ${split?.creatorCut ?? 0}`,
        split,
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error('[GameDev] ❌ 游戏币三方分账失败:', message);
      return { success: false, message: `游戏币三方分账失败: ${message}` };
    }
  }

  /**
   * 🆕 GSO 可观测收益记账点（2026-10-15）：store_sale / content_consume → 服务端 revenue_ledger
   * 只补台账事实源（GSO tick 分账基数），不做钱包 credit；失败静默（不影响购买/核销主流程）。
   * 幂等：content_consume 传 cc_<voucherId>；store_sale 传分钟窗键。
   */
  async reportGsoRevenue(params: {
    gameId: string;
    source: 'store_sale' | 'content_consume';
    amount: number;
    buyerId: string;
    buyerName?: string;
    itemName?: string;
    idempotencyKey?: string;
  }): Promise<{ success: boolean; duplicate?: boolean; message?: string }> {
    const accountId = getGameDeveloperAccountId(params.gameId);
    if (!getCachedToken()) return { success: false, message: '无登录凭证，跳过收益记账' };
    try {
      const data = await apiFetch(`/${accountId}/gso-revenue`, {
        method: 'POST',
        body: JSON.stringify({
          source: params.source,
          gameId: params.gameId,
          amount: Math.floor(Number(params.amount) || 0),
          buyerId: params.buyerId,
          buyerName: params.buyerName,
          itemName: params.itemName,
          idempotencyKey: params.idempotencyKey,
        }),
      });
      return { success: true, duplicate: !!data?.duplicate };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.warn(`[GameDev] GSO 收益记账失败（${params.source}）:`, message);
      return { success: false, message };
    }
  }

  /**
   * 🆕 应用提案通过的三方分成配置（写入 gameDeveloperAccount，source 可追溯）
   * 服务端校验：三方和 = 1、creatorShare > 0 时 creatorId 必填
   */
  async applyRevenueSharingConfig(params: {
    gameId: string;
    gameName: string;
    config: { gameShare: number; platformShare: number; creatorShare: number; creatorId?: string; creatorName?: string };
    proposalId: string;
  }): Promise<{ success: boolean; message: string }> {
    // 🆕 确保 token 可用（提案自动执行时机可能早于其他后端调用签发 token；
    // 无 token 时 saveAccount 会静默降级为仅内存，导致配置从未落库）
    try {
      const token = await getToken();
      if (!token) console.warn('[GameDev] ⚠️ 应用分成配置时无法获取 token，本次配置可能仅存内存');
    } catch { /* getToken 内部已兜底 */ }

    const check = validateRevenueSharingConfig(params.config);
    if (!check.ok) return { success: false, message: check.message };

    let account = await this.getAccount(params.gameId);
    if (!account) {
      // 账户不存在（理论上发布时已建）→ 兜底创建
      account = await this.ensureAccount({
        gameId: params.gameId,
        gameName: params.gameName,
        publisherId: 'unknown',
        publisherName: '未知发布者',
      });
    }

    const now = Date.now();
    const config: RevenueSharingConfig = {
      gameShare: Number(params.config.gameShare) || 0,
      platformShare: Number(params.config.platformShare) || 0,
      creatorShare: Number(params.config.creatorShare) || 0,
      creatorId: params.config.creatorId,
      creatorName: params.config.creatorName,
      source: `proposal:${params.proposalId}`,
      effectiveAt: now,
    };

    account.revenueSharing = config;
    if (account.creatorOwed === undefined) account.creatorOwed = 0;
    if (account.creatorSettled === undefined) account.creatorSettled = 0;
    account.updatedAt = now;
    await this.saveAccount(account);

    console.log(
      `[GameDev] 🔧 三方分成配置生效: ${account.gameName} ` +
      `游戏 ${Math.round(config.gameShare * 100)}% / 平台 ${Math.round(config.platformShare * 100)}% / 创作者 ${Math.round(config.creatorShare * 100)}% ` +
      `(来源: ${config.source})`
    );
    return { success: true, message: `三方分成配置已生效（来源 ${config.source}）` };
  }

  /** 查询游戏当前生效的三方分成配置 */
  async getRevenueSharingConfig(gameId: string): Promise<RevenueSharingConfig | undefined> {
    const account = await this.getAccount(gameId);
    return account?.revenueSharing;
  }

  /**
   * 🆕 校验游戏分成配置变更哈希链完整性（监控台展示用）
   * 返回 null = 账户不存在或校验端点不可用
   */
  async verifyRevenueSharingChain(gameId: string): Promise<{
    intact: boolean;
    length: number;
    brokenAt: string | null;
  } | null> {
    const account = await this.getAccount(gameId);
    if (!account) return null;
    try {
      return await apiFetch(`/${account.accountId}/revenue-sharing-verify`);
    } catch {
      return null;
    }
  }

  /** 当前分成是否为三方模式 */
  async isThreeWaySharing(gameId: string): Promise<boolean> {
    const account = await this.getAccount(gameId);
    return hasActiveSharingConfig(account?.revenueSharing);
  }

  // ============ 查询方法 ============

  async getDeveloperOverview(forceRefresh = false): Promise<GameDeveloperOverview[]> {
    const accounts = await this.getAllAccounts(true, forceRefresh);
    return accounts.map(a => ({
      accountId: a.accountId, gameId: a.gameId, gameName: a.gameName,
      publisherId: a.publisherId, publisherName: a.publisherName,
      revenueSharePercent: a.revenueSharePercent,
      totalRevenue: a.totalRevenue, availableBalance: a.availableBalance,
      platformOwed: a.platformOwed, platformSettled: a.platformSettled,
      totalWithdrawn: a.totalWithdrawn, totalSoldItems: a.stats.totalSoldItems,
      status: a.status, lastDailySettlement: a.lastDailySettlement,
      revenueSharing: a.revenueSharing,
      creatorOwed: a.creatorOwed || 0,
      creatorSettled: a.creatorSettled || 0,
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
      await apiFetch(`/${full.accountId}/transactions`, { method: 'POST', body: JSON.stringify(full) });
    } catch (e) {
      console.warn('[GameDev] 交易记录 API 保存失败（仅内存）:', e);
    }
  }
}

// 导出单例
export const gameDeveloperService = new GameDeveloperService();
export default gameDeveloperService;
