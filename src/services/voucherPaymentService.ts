/**
 * A币凭证支付服务
 * 
 * 基于"平台总账户"模型：
 * - 所有凭证来源于平台预创建库存（platform_pool）
 * - 用户支付 = 用户 transfer 凭证到平台
 * - 找零 = 平台 transfer 库存凭证到用户
 * - 全程零 create、零 destroy，仅 transfer
 */
import { voucherService } from '@/voucher-system/services/VoucherService';
import { Voucher, Transaction, VoucherStatus, VoucherSourceType, isCurrencyVoucher } from '@/voucher-system/types';

// ==================== 平台账户常量 ====================

export const PLATFORM_POOL_ID = 'platform_pool';
export const PLATFORM_POOL_NAME = '平台总账户';
export const OFFICIAL_STORE_ID = 'official_store';
export const OFFICIAL_STORE_NAME = '官方商店';

/**
 * 标准化凭证面额配置
 * 平台预创建的标准面额凭证库存
 */
const STANDARD_DENOMINATIONS = [1, 5, 10, 20, 50, 100];
const POOL_SIZE_PER_DENOMINATION = 100; // 每种面额预创建数量

class VoucherPaymentService {
  private initialized = false;
  // 🔒 S2-3 修复：用户级支付锁，防止并发超额消费
  private paymentLocks = new Map<string, Promise<void>>();

  /**
   * 初始化平台凭证库存
   * 在系统启动时调用，确保平台有足够的标准化凭证用于流转
   */
  initializePlatformPool(): void {
    if (this.initialized) {
      console.log('[VoucherPayment] 平台凭证库存已初始化，跳过');
      return;
    }

    // 检查是否已有库存
    const poolVouchers = voucherService.getUserVouchers(PLATFORM_POOL_ID);
    if (poolVouchers.length > 0) {
      console.log(`[VoucherPayment] 平台库存已有 ${poolVouchers.length} 张凭证，跳过初始化`);
      this.initialized = true;
      return;
    }

    console.log('[VoucherPayment] 初始化平台凭证库存...');
    const totalVouchers: Voucher[] = [];

    for (const denom of STANDARD_DENOMINATIONS) {
      const vouchers = voucherService.batchCreateVouchers(
        {
          count: POOL_SIZE_PER_DENOMINATION,
          denomination: denom,
          recipientId: PLATFORM_POOL_ID,
          recipientName: PLATFORM_POOL_NAME,
          note: `平台标准化库存 - 面额 ${denom}`,
        },
        'SYSTEM',
        '系统初始化'
      );
      totalVouchers.push(...vouchers);
    }

    this.initialized = true;
    console.log(`[VoucherPayment] 平台凭证库存初始化完成，共 ${totalVouchers.length} 张凭证`);
    console.log(`[VoucherPayment] 库存总价值: ${totalVouchers.reduce((s, v) => s + v.denomination, 0)} testA币`);
  }

  /**
   * 使用凭证A币（testA币）支付
   * 🔒 S2-3 修复：用户级锁，同一用户并发支付串行化，防止超额消费
   * 
   * 流程：
   * 1. 获取用户活跃凭证，按面额从大到小排序
   * 2. 贪婪匹配：大面额优先，凑够支付金额
   * 3. 将选中的凭证 transfer 到平台账户
   * 4. 如有超额支付（找零），从平台库存 transfer 合适凭证给用户
   * 
   * @param userId 用户ID
   * @param userName 用户名称
   * @param amount 支付金额
   * @param description 支付说明（如"官方商店购买: 传说宝箱"）
   * @returns 支付详情
   */
  payWithVoucher(
    userId: string,
    userName: string,
    amount: number,
    description: string
  ): {
    success: boolean;
    consumedVouchers: Voucher[];
    changeVouchers: Voucher[];
    transactions: Transaction[];
    message: string;
  } {
    // 🔒 用户级支付锁：同一用户并发支付串行化
    while (this.paymentLocks.has(userId)) {
      // 等待前一个支付完成
    }

    let resolveLock: () => void;
    const lock = new Promise<void>(r => { resolveLock = r; });
    this.paymentLocks.set(userId, lock);

    try {
      return this._payWithVoucherInternal(userId, userName, amount, description);
    } finally {
      this.paymentLocks.delete(userId);
      resolveLock!();
    }
  }

  /**
   * 内部支付实现（在锁内执行，无并发干扰）
   */
  private _payWithVoucherInternal(
    userId: string,
    userName: string,
    amount: number,
    description: string
  ): {
    success: boolean;
    consumedVouchers: Voucher[];
    changeVouchers: Voucher[];
    transactions: Transaction[];
    message: string;
  } {
    // 1. 获取用户活跃凭证（仅A币类凭证，排除道具/物品类）
    const userVouchers = voucherService.getUserVouchers(userId)
      .filter(v => v.status === VoucherStatus.ACTIVE && isCurrencyVoucher(v.sourceType));

    const totalValue = userVouchers.reduce((s, v) => s + v.denomination, 0);

    if (totalValue < amount) {
      return {
        success: false,
        consumedVouchers: [],
        changeVouchers: [],
        transactions: [],
        message: `testA币余额不足！需要 ${amount} testA币，当前持有 ${totalValue} testA币`,
      };
    }

    // 2. 贪婪匹配：大面额优先
    const sorted = [...userVouchers].sort((a, b) => b.denomination - a.denomination);
    let remaining = amount;
    const consumed: Voucher[] = [];
    const transactions: Transaction[] = [];

    for (const v of sorted) {
      if (remaining <= 0) break;
      // 转移该凭证到平台账户
      const tx = voucherService.transferVoucher(
        {
          voucherId: v.id,
          toUserId: PLATFORM_POOL_ID,
          toUserName: PLATFORM_POOL_NAME,
          note: description,
        },
        userId,       // operator = 用户本人（仅持有者可转出）
        userName
      );
      consumed.push(v);
      transactions.push(tx);
      remaining -= v.denomination;
    }

    // 3. 找零：超额部分从平台库存转移对应面额的凭证给用户
    const changeVouchers: Voucher[] = [];
    if (remaining < 0) {
      const changeAmount = Math.abs(remaining);
      const changeResult = this.giveChange(userId, userName, changeAmount, `${description} 找零`);
      changeVouchers.push(...changeResult.vouchers);
      transactions.push(...changeResult.transactions);
    }

    return {
      success: true,
      consumedVouchers: consumed,
      changeVouchers,
      transactions,
      message: `支付成功！消耗 ${consumed.length} 张凭证，找回 ${changeVouchers.length} 张凭证`,
    };
  }

  /**
   * 给用户找零
   * 从平台库存中选择合适面额的凭证转移给用户
   */
  private giveChange(
    userId: string,
    userName: string,
    amount: number,
    note: string
  ): { vouchers: Voucher[]; transactions: Transaction[] } {
    // 获取平台库存中活跃的凭证
    const poolVouchers = voucherService.getUserVouchers(PLATFORM_POOL_ID)
      .filter(v => v.status === VoucherStatus.ACTIVE);

    // 按面额从小到大排序，便于找零
    const sorted = [...poolVouchers].sort((a, b) => a.denomination - b.denomination);
    const selected: Voucher[] = [];
    const transactions: Transaction[] = [];
    let remaining = amount;

    // 尽量用最少张数的凭证找零：先尝试大面额
    const descendingSorted = [...sorted].sort((a, b) => b.denomination - a.denomination);
    for (const v of descendingSorted) {
      if (remaining <= 0) break;
      if (v.denomination <= remaining) {
        const tx = voucherService.transferVoucher(
          {
            voucherId: v.id,
            toUserId: userId,
            toUserName: userName,
            note,
          },
          PLATFORM_POOL_ID,  // operator = 平台（平台持有者转出）
          PLATFORM_POOL_NAME
        );
        selected.push(v);
        transactions.push(tx);
        remaining -= v.denomination;
      }
    }

    // 如果最小的面额也大于剩余金额，说明需要一张比剩余大的凭证
    // 例如找零15，只有20面额，就转移20给用户（多给了）
    if (remaining > 0) {
      // 找最小的能覆盖的凭证
      const smallestValid = descendingSorted.find(v => !selected.includes(v) && v.denomination >= remaining);
      if (smallestValid) {
        const tx = voucherService.transferVoucher(
          {
            voucherId: smallestValid.id,
            toUserId: userId,
            toUserName: userName,
            note,
          },
          PLATFORM_POOL_ID,
          PLATFORM_POOL_NAME
        );
        selected.push(smallestValid);
        transactions.push(tx);
        remaining -= smallestValid.denomination;
      }
    }

    if (remaining > 0) {
      console.warn(`[VoucherPayment] 找零不足，还差 ${remaining} testA币（平台库存可能不够）`);
    }

    return { vouchers: selected, transactions };
  }

  /**
   * 获取用户的凭证余额（所有活跃凭证）
   */
  getUserVoucherBalance(userId: string): number {
    const vouchers = voucherService.getUserVouchers(userId)
      .filter(v => v.status === VoucherStatus.ACTIVE && isCurrencyVoucher(v.sourceType));
    return vouchers.reduce((s, v) => s + v.denomination, 0);
  }

  /**
   * 获取用户的所有凭证（用于展示）
   */
  getUserVouchers(userId: string): Voucher[] {
    return voucherService.getUserVouchers(userId)
      .filter(v => v.status === VoucherStatus.ACTIVE && isCurrencyVoucher(v.sourceType));
  }

  /**
   * 获取平台库存统计
   */
  getPlatformPoolStats(): { totalVouchers: number; totalValue: number; byDenomination: Record<number, number> } {
    const vouchers = voucherService.getUserVouchers(PLATFORM_POOL_ID)
      .filter(v => v.status === VoucherStatus.ACTIVE);
    
    const byDenomination: Record<number, number> = {};
    for (const v of vouchers) {
      byDenomination[v.denomination] = (byDenomination[v.denomination] || 0) + 1;
    }

    return {
      totalVouchers: vouchers.length,
      totalValue: vouchers.reduce((s, v) => s + v.denomination, 0),
      byDenomination,
    };
  }
}

export const voucherPaymentService = new VoucherPaymentService();
