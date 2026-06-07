/**
 * AllinONE Skill 系统 - Wallet 向后兼容层
 * 保持原有的 walletService API 不变，内部使用 WalletSkill
 */

import type { WalletBalance, WalletTransaction, WalletStats, ExchangeRate, GameCoinsSummary } from '@/types/wallet';
import type { GameCoinType } from '@/types/common';

// 延迟获取 skillGateway 和 skills，避免循环依赖问题
async function getSkillGateway() {
  // 使用动态 import 避免循环依赖
  const { skillGateway } = await import('../index');
  return skillGateway;
}

async function getSkills() {
  const { walletSkill, authSkill } = await import('../index');
  return { walletSkill, authSkill };
}

// 从 localStorage 获取当前用户 ID（服务层无法使用 React Context）
function getCurrentUserId(): string {
  try {
    const raw = localStorage.getItem('allinone_user') || localStorage.getItem('currentUser');
    if (raw) {
      const user = JSON.parse(raw);
      return user?.uid || user?.id || 'anonymous';
    }
  } catch { /* ignore */ }
  return 'anonymous';
}

// 构建 SkillContext
function getSkillContext() {
  return { userId: getCurrentUserId(), sessionId: 'web' };
}

// 全局注册锁，防止重复注册
let registrationPromise: Promise<void> | null = null;

/**
 * 确保依赖的 Skills 已按正确顺序注册
 */
async function ensureSkillsRegistered(): Promise<void> {
  if (registrationPromise) {
    return registrationPromise;
  }

  registrationPromise = (async () => {
    const skillGateway = await getSkillGateway();
    const { walletSkill, authSkill } = await getSkills();
    
    // 1. 首先注册 auth Skill（wallet 依赖它）
    if (!skillGateway.getSkill('auth')) {
      try {
        await skillGateway.registerSkill(authSkill);
        console.log('[WalletCompat] authSkill 注册成功');
      } catch (error) {
        console.warn('[WalletCompat] authSkill 注册失败:', error);
      }
    }

    // 2. 然后注册 wallet Skill
    if (!skillGateway.getSkill('wallet')) {
      try {
        await skillGateway.registerSkill(walletSkill);
        console.log('[WalletCompat] walletSkill 注册成功');
      } catch (error) {
        console.warn('[WalletCompat] walletSkill 注册失败:', error);
      }
    }
  })();

  return registrationPromise;
}

/**
 * 钱包服务兼容层
 * 保留原有的所有方法，内部使用 Skill 系统
 */
class WalletServiceCompat {
  constructor() {
    // 构造函数中不阻塞，立即触发异步注册
    ensureSkillsRegistered().catch(console.error);
  }

  // ==================== 原有 API 保持完全兼容 ====================

  /**
   * 获取钱包余额
   */
  async getBalance(): Promise<WalletBalance> {
    await ensureSkillsRegistered();
    const skillGateway = await getSkillGateway();
    const response = await skillGateway.execute('wallet', 'getBalance', {}, getSkillContext());
    if (!response.success) {
      throw new Error(response.error?.message || '获取余额失败');
    }
    const raw = response.data as any;
    const data = raw?.data ?? raw;
    return {
      gameCoins: data?.gameCoins || 0,
      instantVouchers: data?.instantVouchers || 0,
      algorithmVouchers: data?.algorithmVouchers || 0,
      totalValue: (data?.gameCoins || 0) + (data?.instantVouchers || 0) + (data?.algorithmVouchers || 0),
      lastUpdated: data?.lastUpdated ? new Date(data.lastUpdated) : new Date(),
    } as WalletBalance;
  }

  /**
   * 添加交易记录
   */
  async addTransaction(transaction: Omit<WalletTransaction, 'id' | 'timestamp'>): Promise<void> {
    await ensureSkillsRegistered();
    const skillGateway = await getSkillGateway();
    const response = await skillGateway.execute('wallet', 'reward', {
      // 将交易转换为奖励格式
      description: transaction.description,
      relatedId: transaction.relatedId,
    }, getSkillContext());

    if (!response.success) {
      throw new Error(response.error?.message || '添加交易失败');
    }
  }

  /**
   * 获取交易记录
   */
  async getTransactions(limit: number = 50): Promise<WalletTransaction[]> {
    await ensureSkillsRegistered();
    const skillGateway = await getSkillGateway();
    const response = await skillGateway.execute<WalletTransaction[]>('wallet', 'getTransactions', { limit }, getSkillContext());
    if (!response.success) {
      throw new Error(response.error?.message || '获取交易记录失败');
    }
    return response.data!;
  }

  /**
   * 获取钱包统计
   */
  async getStats(): Promise<WalletStats> {
    await ensureSkillsRegistered();
    const skillGateway = await getSkillGateway();
    const response = await skillGateway.execute<WalletStats>('wallet', 'getStats', {}, getSkillContext());
    if (!response.success) {
      throw new Error(response.error?.message || '获取统计失败');
    }
    return response.data!;
  }

  /**
   * 游戏奖励
   */
  async addGameReward(computingPower: number, gameCoins: number, gameId?: string): Promise<void> {
    await ensureSkillsRegistered();
    const skillGateway = await getSkillGateway();
    const response = await skillGateway.execute('wallet', 'reward', {
      computingPower,
      gameCoins,
      gameId,
    }, getSkillContext());

    if (!response.success) {
      throw new Error(response.error?.message || '添加游戏奖励失败');
    }
  }

  /**
   * 购买消费
   */
  async makePurchase(
    amount: number,
    currency: 'cash' | 'gameCoins',
    description: string,
    relatedId?: string
  ): Promise<boolean> {
    await ensureSkillsRegistered();
    const skillGateway = await getSkillGateway();
    const response = await skillGateway.execute('wallet', 'spend', {
      amount,
      currency,
      description,
      relatedId,
    }, getSkillContext());

    if (!response.success) {
      throw new Error(response.error?.message || '消费失败');
    }
    return true;
  }

  /**
   * 充值现金
   */
  async recharge(amount: number, method: string = '支付宝'): Promise<void> {
    await ensureSkillsRegistered();
    const skillGateway = await getSkillGateway();
    const response = await skillGateway.execute('wallet', 'recharge', {
      amount,
      method,
    }, getSkillContext());

    if (!response.success) {
      throw new Error(response.error?.message || '充值失败');
    }
  }

  /**
   * 获取汇率
   */
  async getExchangeRatesAsync(): Promise<ExchangeRate> {
    await ensureSkillsRegistered();
    const skillGateway = await getSkillGateway();
    const response = await skillGateway.execute<ExchangeRate>('wallet', 'getExchangeRates', {}, getSkillContext());
    if (!response.success) {
      throw new Error(response.error?.message || '获取汇率失败');
    }
    return response.data!;
  }

  /**
   * 货币兑换
   */
  async exchangeCurrency(
    fromCurrency: 'cash' | 'gameCoins' | 'computingPower' | 'aCoins' | 'oCoins',
    toCurrency: 'cash' | 'gameCoins' | 'computingPower' | 'aCoins' | 'oCoins',
    amount: number
  ): Promise<number> {
    await ensureSkillsRegistered();
    const skillGateway = await getSkillGateway();
    const response = await skillGateway.execute<{ received: number; rate: number }>('wallet', 'exchange', {
      fromCurrency,
      toCurrency,
      amount,
    }, getSkillContext());

    if (!response.success) {
      throw new Error(response.error?.message || '兑换失败');
    }
    return response.data!.received;
  }

  /**
   * A币发放（通过凭证系统创建凭证）
   */
  async distributeACoins(amount: number, description: string = 'A币发放奖励'): Promise<void> {
    try {
      const { voucherService } = await import('@/voucher-system/services/VoucherService');
      const { VoucherSourceType } = await import('@/voucher-system/types');
      const uid = getCurrentUserId();
      voucherService.createVoucher(
        {
          denomination: amount,
          recipientId: uid,
          recipientName: '玩家',
          metadata: { name: description, category: 'reward', sourceType: VoucherSourceType.INSTANT },
          note: description,
        },
        'SYSTEM',
        '平台系统'
      );
      console.log(`[WalletCompat] 发放 A币凭证成功: ${amount}, ${description}`);
    } catch (error) {
      throw new Error(`A币发放失败: ${error}`);
    }
  }

  /**
   * 获取A币余额（从凭证系统读取）
   */
  async getACoinBalance(): Promise<number> {
    try {
      const { voucherPaymentService } = await import('@/services/voucherPaymentService');
      const uid = getCurrentUserId();
      return voucherPaymentService.getUserVoucherBalance(uid);
    } catch {
      return 0;
    }
  }

  /**
   * 获取A币交易记录（凭证系统的交易记录）
   */
  async getACoinTransactions(limit: number = 50): Promise<WalletTransaction[]> {
    // A币交易记录现在存储在凭证系统的 transactions 中
    try {
      const { voucherService } = await import('@/voucher-system/services/VoucherService');
      const uid = getCurrentUserId();
      const voucherTxs = voucherService.getUserTransactions ? voucherService.getUserTransactions(uid) : [];
      return voucherTxs.slice(0, limit).map((tx: any) => ({
        id: tx.id,
        type: tx.toUserId === uid ? 'income' : 'expense' as any,
        category: 'trade' as any,
        amount: tx.denomination || 0,
        currency: 'gameCoins' as any,
        description: tx.note || 'A币交易',
        timestamp: new Date(tx.timestamp),
      })) as WalletTransaction[];
    } catch {
      return [];
    }
  }

  // ============ 游戏币相关方法 ============

  /**
   * 获取游戏币汇总信息
   */
  async getGameCoinsSummary(): Promise<GameCoinsSummary> {
    await ensureSkillsRegistered();
    const skillGateway = await getSkillGateway();
    const response = await skillGateway.execute<GameCoinsSummary>('wallet', 'getGameCoinsSummary', {}, getSkillContext());
    if (!response.success) {
      throw new Error(response.error?.message || '获取游戏币汇总失败');
    }
    return response.data!;
  }

  /**
   * 兑换游戏币
   */
  async exchangeGameCoins(
    fromType: 'gameCoins' | 'newDayGameCoins',
    toType: 'gameCoins' | 'newDayGameCoins',
    amount: number
  ): Promise<{ success: boolean; message: string; received: number }> {
    await ensureSkillsRegistered();
    const skillGateway = await getSkillGateway();
    const response = await skillGateway.execute('wallet', 'exchangeGameCoins', {
      fromType,
      toType,
      amount,
    }, getSkillContext());

    if (!response.success) {
      return {
        success: false,
        message: response.error?.message || '兑换失败',
        received: 0,
      };
    }

    return response.data as { success: boolean; message: string; received: number };
  }

  /**
   * 获取 New Day 游戏币余额
   */
  async getNewDayGameCoinBalance(): Promise<number> {
    const balance = await this.getBalance();
    return balance.newDayGameCoins;
  }

  /**
   * 更新 New Day 游戏币余额
   */
  async updateNewDayGameCoins(amount: number, description: string = '从 New Day 同步'): Promise<void> {
    console.log(`[WalletCompat] 更新 New Day 游戏币: ${amount}, ${description}`);
  }
}

// 导出兼容层实例（保持原有导出名称）
export const walletService = new WalletServiceCompat();
export default walletService;
