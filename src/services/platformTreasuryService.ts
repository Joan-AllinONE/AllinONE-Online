/**
 * PlatformTreasuryService - 平台金库管理服务 (MVP v1.2)
 *
 * 管理平台虚拟账户 'system-platform'：
 * - P2P 交易佣金流入（gameCoins 走 walletSkill，aCoins 走凭证系统）
 * - 提案押金没收 → 流入金库
 * - 凭证规则引擎回收 → 转入金库
 * - 提供查询：余额、收入明细、交易历史、凭证资产、按来源分类
 *
 * 凭证资产集成：
 * - 平台在两个凭证账户持有资产：system-platform（回收/罚没）+ platform_pool（支付流转池）
 * - getPlatformVoucherHoldings() 从 voucherService 实时查询两个账户的凭证持有情况
 * - getReport() 的 aCoins 余额优先从凭证系统实时计算（ACTIVE 凭证面额之和）
 */

import { walletSkill } from '@/skills/wallet/WalletSkill';
import { voucherService } from '@/voucher-system/services/VoucherService';
import { VoucherStatus } from '@/voucher-system/types';
import type { Voucher } from '@/voucher-system/types';
import { loadTreasury as loadTreasuryFromMarket } from '@/types/marketplace';
import type { PlatformTreasury } from '@/types/marketplace';
import { PLATFORM_POOL_ID } from '@/services/voucherPaymentService';
import { writeQueue } from '@/services/writeQueue';

// ==================== 常量 ====================

export const PLATFORM_ACCOUNT_ID = 'system-platform';
const PLATFORM_ACCOUNT_NAME = '平台金库';
const TREASURY_TX_KEY = 'platform_treasury_tx';

// ==================== 类型 ====================

export type TreasurySource =
  | 'p2p_commission'      // P2P 交易佣金
  | 'proposal_forfeit'    // 提案押金没收
  | 'voucher_recycle'     // 凭证规则回收
  | 'voucher_expire'      // 凭证过期回收
  | 'platform_collect'    // 平台手续费

export interface TreasuryTransaction {
  id: string;
  currency: 'gameCoins' | 'aCoins';
  amount: number;
  source: TreasurySource;
  description: string;
  metadata: Record<string, any>;
  timestamp: number;
}

export interface RevenueBreakdown {
  p2pCommission: number;
  proposalForfeit: number;
  voucherRecycle: number;
  platformCollect: number;
}

export interface TreasuryReport {
  balance: { gameCoins: number; aCoins: number };
  cumulative: RevenueBreakdown;
  todayIncome: { gameCoins: number; aCoins: number };
  monthlyIncome: { gameCoins: number; aCoins: number };
  totalTransactions: number;
  /** 凭证资产（从凭证系统实时查询） */
  vouchers: PlatformVoucherHolding | null;
  lastUpdated: number;
}

/** 平台凭证持有情况（聚合 system-platform + platform_pool） */
export interface PlatformVoucherHolding {
  /** 两个账户合计：所有 ACTIVE 状态凭证面额之和 = 真实 aCoins 余额 */
  totalFaceValue: number;
  /** 持有凭证总数 */
  totalCount: number;
  /** 按账户拆分 */
  accounts: {
    treasury: VoucherAccountSnapshot;  // system-platform
    pool: VoucherAccountSnapshot;      // platform_pool
  };
  /** 按状态分布 */
  byStatus: Record<string, { count: number; faceValue: number }>;
  /** 按面额分布 */
  byDenomination: Record<number, { count: number; faceValue: number }>;
  /** 查询时间 */
  queriedAt: number;
}

export interface VoucherAccountSnapshot {
  accountId: string;
  accountName: string;
  description: string;
  totalFaceValue: number;
  voucherCount: number;
  activeCount: number;
  frozenCount: number;
}

// ==================== Service ====================

class PlatformTreasuryService {
  /**
   * 💰 存入佣金/收入到平台金库
   *
   * gameCoins：通过 walletSkill.recharge 真实入账到 system-platform
   * aCoins：记录到 localStorage（aCoins 佣金自然留存于凭证系统 platform_pool）
   */
  async depositCommission(
    currency: 'gameCoins' | 'aCoins',
    amount: number,
    source: TreasurySource,
    description: string,
    metadata: Record<string, any> = {}
  ): Promise<void> {
    // 1. 保留原有市场金库计数（向后兼容）
    const { depositTreasury } = await import('@/types/marketplace');
    depositTreasury(currency, amount);

    // 2. gameCoins 真实入账到平台账户（通过 recharge action）
    if (currency === 'gameCoins' && amount > 0) {
      try {
        await walletSkill.recharge(
          { amount, description: `[${source}] ${description}` },
          { userId: PLATFORM_ACCOUNT_ID, sessionId: 'system' } as any
        );
      } catch (e) {
        console.warn(`[PlatformTreasury] walletSkill recharge failed:`, e);
      }
    }

    // 3. 记录流水
    this.recordTransaction({
      currency,
      amount,
      source,
      description,
      metadata,
    });

    console.log(
      `[PlatformTreasury] 💰 +${amount} ${currency} | ${source} | ${description}`
    );
  }

  /**
   * 📊 获取金库报告（余额 + 收入分类 + 凭证资产 + 历史统计）
   */
  async getReport(): Promise<TreasuryReport> {
    const txs = this.getTransactions();

    // 从 localStorage 读取累积
    const treasury = loadTreasuryFromMarket();

    // 从 walletSkill 读取实时 gameCoins 余额（更准确）
    let walletGC = 0;
    try {
      const bal = await walletSkill.getBalance({} as never, { userId: PLATFORM_ACCOUNT_ID } as any);
      walletGC = bal.gameCoins;
    } catch {
      walletGC = treasury.gameCoins;
    }

    // 从凭证系统读取真实 aCoins 余额（ACTIVE 凭证面额之和）
    let voucherAC = treasury.aCoins; // fallback
    let voucherHoldings: PlatformVoucherHolding | null = null;
    try {
      voucherHoldings = this.getPlatformVoucherHoldings();
      voucherAC = voucherHoldings.totalFaceValue;
    } catch (e) {
      console.warn('[PlatformTreasury] Failed to query voucher holdings, using localStorage fallback:', e);
    }

    // 时间窗口
    const now = Date.now();
    const DAY = 86400000;
    const MONTH = 30 * DAY;

    const todayGC = txs
      .filter(t => t.currency === 'gameCoins' && t.timestamp > now - DAY)
      .reduce((s, t) => s + t.amount, 0);
    const todayAC = txs
      .filter(t => t.currency === 'aCoins' && t.timestamp > now - DAY)
      .reduce((s, t) => s + t.amount, 0);
    const monthGC = txs
      .filter(t => t.currency === 'gameCoins' && t.timestamp > now - MONTH)
      .reduce((s, t) => s + t.amount, 0);
    const monthAC = txs
      .filter(t => t.currency === 'aCoins' && t.timestamp > now - MONTH)
      .reduce((s, t) => s + t.amount, 0);

    // 按来源分类（所有历史）
    const breakdown: RevenueBreakdown = {
      p2pCommission: 0,
      proposalForfeit: 0,
      voucherRecycle: 0,
      platformCollect: 0,
    };
    for (const t of txs) {
      switch (t.source) {
        case 'p2p_commission': breakdown.p2pCommission += t.amount; break;
        case 'proposal_forfeit': breakdown.proposalForfeit += t.amount; break;
        case 'voucher_recycle':
        case 'voucher_expire':
          breakdown.voucherRecycle += t.amount; break;
        case 'platform_collect': breakdown.platformCollect += t.amount; break;
      }
    }

    return {
      balance: {
        gameCoins: walletGC,
        aCoins: voucherAC,
      },
      cumulative: breakdown,
      todayIncome: { gameCoins: todayGC, aCoins: todayAC },
      monthlyIncome: { gameCoins: monthGC, aCoins: monthAC },
      totalTransactions: txs.length,
      vouchers: voucherHoldings,
      lastUpdated: now,
    };
  }

  /**
   * 🎫 获取平台凭证持有情况（聚合 system-platform + platform_pool）
   *
   * 这是平台金库的"凭证账户"：实时查询凭证系统，汇总两个平台账户持有的所有凭证。
   * - system-platform：规则回收、提案罚没等进入的凭证
   * - platform_pool：支付流转池中留存的佣金凭证
   */
  getPlatformVoucherHoldings(): PlatformVoucherHolding {
    const treasuryVouchers = this.queryAccountVouchers(PLATFORM_ACCOUNT_ID, '平台金库', '规则回收/罚没/手续费');
    const poolVouchers = this.queryAccountVouchers(PLATFORM_POOL_ID, '平台总账户', '支付流转池/佣金留存');

    const allVouchers = [...treasuryVouchers.raw, ...poolVouchers.raw];

    // 按状态分布
    const byStatus: Record<string, { count: number; faceValue: number }> = {};
    for (const v of allVouchers) {
      const st = v.status;
      if (!byStatus[st]) byStatus[st] = { count: 0, faceValue: 0 };
      byStatus[st].count++;
      byStatus[st].faceValue += v.denomination;
    }

    // 按面额分布
    const byDenomination: Record<number, { count: number; faceValue: number }> = {};
    for (const v of allVouchers) {
      const d = v.denomination;
      if (!byDenomination[d]) byDenomination[d] = { count: 0, faceValue: 0 };
      byDenomination[d].count++;
      byDenomination[d].faceValue += v.denomination;
    }

    // 总面额 = ACTIVE 凭证面额之和（这才是真实的 aCoins 余额）
    const activeVouchers = allVouchers.filter(v => v.status === VoucherStatus.ACTIVE);
    const totalFaceValue = activeVouchers.reduce((s, v) => s + v.denomination, 0);

    return {
      totalFaceValue,
      totalCount: allVouchers.length,
      accounts: {
        treasury: {
          accountId: PLATFORM_ACCOUNT_ID,
          accountName: '平台金库',
          description: '规则回收/罚没/手续费',
          totalFaceValue: treasuryVouchers.raw
            .filter(v => v.status === VoucherStatus.ACTIVE)
            .reduce((s, v) => s + v.denomination, 0),
          voucherCount: treasuryVouchers.raw.length,
          activeCount: treasuryVouchers.activeCount,
          frozenCount: treasuryVouchers.frozenCount,
        },
        pool: {
          accountId: PLATFORM_POOL_ID,
          accountName: '平台总账户',
          description: '支付流转池/佣金留存',
          totalFaceValue: poolVouchers.raw
            .filter(v => v.status === VoucherStatus.ACTIVE)
            .reduce((s, v) => s + v.denomination, 0),
          voucherCount: poolVouchers.raw.length,
          activeCount: poolVouchers.activeCount,
          frozenCount: poolVouchers.frozenCount,
        },
      },
      byStatus,
      byDenomination,
      queriedAt: Date.now(),
    };
  }

  /**
   * 📋 获取交易流水
   */
  getTransactions(limit?: number): TreasuryTransaction[] {
    try {
      const all: TreasuryTransaction[] = JSON.parse(
        localStorage.getItem(TREASURY_TX_KEY) || '[]'
      );
      const sorted = all.sort((a, b) => b.timestamp - a.timestamp);
      return limit ? sorted.slice(0, limit) : sorted;
    } catch {
      return [];
    }
  }

  /**
   * 🏦 获取平台账户钱包余额（实时）
   */
  async getWalletBalance(): Promise<{ gameCoins: number }> {
    try {
      return await walletSkill.getBalance({} as never, { userId: PLATFORM_ACCOUNT_ID } as any);
    } catch {
      return { gameCoins: 0 };
    }
  }

  // ==================== 私有 ====================

  /**
   * 查询指定账户的凭证持有情况
   */
  private queryAccountVouchers(accountId: string, accountName: string, description: string): {
    raw: Voucher[];
    activeCount: number;
    frozenCount: number;
  } {
    try {
      const vouchers = voucherService.getUserVouchers(accountId);
      let activeCount = 0;
      let frozenCount = 0;
      for (const v of vouchers) {
        if (v.status === VoucherStatus.ACTIVE) activeCount++;
        else if (v.status === VoucherStatus.FROZEN) frozenCount++;
      }
      return { raw: vouchers, activeCount, frozenCount };
    } catch (e) {
      console.warn(`[PlatformTreasury] Failed to query vouchers for ${accountId}:`, e);
      return { raw: [], activeCount: 0, frozenCount: 0 };
    }
  }

  private recordTransaction(tx: Omit<TreasuryTransaction, 'id' | 'timestamp'>): void {
    const full: TreasuryTransaction = {
      id: `ptr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
      ...tx,
    };

    try {
      const all: TreasuryTransaction[] = JSON.parse(
        localStorage.getItem(TREASURY_TX_KEY) || '[]'
      );
      all.push(full);
      if (all.length > 500) all.splice(0, all.length - 500);
      localStorage.setItem(TREASURY_TX_KEY, JSON.stringify(all));
      // CloudBase 双写（通过写入队列，upsert 避免重复）
      writeQueue.enqueue({
        collection: 'platform_treasury',
        operation: 'upsert',
        data: full as any,
      });
    } catch { /* ignore */ }
  }
}

export const platformTreasuryService = new PlatformTreasuryService();
