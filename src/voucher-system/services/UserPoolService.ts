/**
 * 用户奖池服务
 * 管理用户自主创建的奖池 - 支持去中心化奖励发放
 */

import type {
  UserRewardPool,
  PoolVoucherConfig,
  DepositToPoolResult,
  DistributeFromPoolResult,
  CreatePoolRequest,
  UserPoolOverview,
} from '../types/pool';
import { voucherService } from './VoucherService';
import { VoucherStatus, type Voucher } from '../types';
import { persistWithCloudSync, loadWithCloudSync, upsertToCloud, deleteFromCloud } from '../storage/cloudSync';

const STORAGE_KEY = 'voucher_user_reward_pools';
const CLOUD_COLLECTION = 'user_pools';

/**
 * 生成唯一ID
 */
function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

/**
 * 用户奖池服务类
 * 管理用户自主创建的奖池
 */
export class UserPoolService {
  private static instance: UserPoolService | null = null;
  private pools: Map<string, UserRewardPool> = new Map();

  private constructor() {
    this.loadFromStorage();
  }

  static getInstance(): UserPoolService {
    if (!UserPoolService.instance) {
      UserPoolService.instance = new UserPoolService();
    }
    return UserPoolService.instance;
  }

  // ==================== 存储管理 ====================

  private loadFromStorage(): void {
    try {
      const { data, cloudSync } = loadWithCloudSync<UserRewardPool>(STORAGE_KEY, CLOUD_COLLECTION);
      data.forEach(p => this.pools.set(p.id, p));
      console.log('[UserPoolService] 加载奖池:', this.pools.size);
      // 捕获初始本地 ID 集合，防止已删除的奖池从云端"复活"
      const originalIds = new Set(data.map(p => p.id));
      cloudSync.then(merged => {
        let added = false;
        for (const p of merged) {
          // 仅添加：云端独有（不在原始本地集合，防僵尸）+ 不在当前 Map（防重复）
          if (!originalIds.has(p.id) && !this.pools.has(p.id)) {
            this.pools.set(p.id, p);
            added = true;
          }
        }
        if (added) this.saveToStorage();
      }).catch(() => {});
    } catch (error) {
      console.error('[UserPoolService] 加载数据失败:', error);
    }
  }

  private saveToStorage(): void {
    try {
      const items = [...this.pools.values()];
      persistWithCloudSync(STORAGE_KEY, items, CLOUD_COLLECTION);
    } catch (error) {
      console.error('[UserPoolService] 保存数据失败:', error);
    }
  }

  // ==================== 奖池管理 ====================

  /**
   * 创建用户奖池
   * 用户可以将自己的凭证存入奖池，供其他玩家获取
   */
  createPool(
    ownerId: string,
    ownerName: string,
    request: CreatePoolRequest
  ): UserRewardPool {
    const now = Date.now();
    const pool: UserRewardPool = {
      id: generateUUID(),
      ownerId,
      ownerName,
      name: request.name,
      description: request.description,
      vouchers: [],
      status: 'active',
      stats: {
        totalDeposited: 0,
        totalDistributed: 0,
        distributionCount: 0,
      },
      createdAt: now,
      updatedAt: now,
    };

    this.pools.set(pool.id, pool);

    // 如果有初始凭证，存入奖池
    if (request.initialVoucherIds && request.initialVoucherIds.length > 0) {
      this.depositVouchersToPool(pool.id, request.initialVoucherIds, ownerId);
    }

    this.saveToStorage();

    console.log(`[UserPoolService] 用户 ${ownerName} 创建奖池: ${request.name}`);
    return pool;
  }

  /**
   * 将凭证存入奖池
   * 这是核心功能 - 用户主动选择哪些凭证进入奖池
   */
  depositVouchersToPool(
    poolId: string,
    voucherIds: string[],
    ownerId: string
  ): DepositToPoolResult {
    const pool = this.pools.get(poolId);
    if (!pool) {
      return { success: false, deposited: [], totalAmount: 0, error: '奖池不存在' };
    }

    if (pool.ownerId !== ownerId) {
      return { success: false, deposited: [], totalAmount: 0, error: '无权操作此奖池' };
    }

    const deposited: PoolVoucherConfig[] = [];
    let totalAmount = 0;

    for (const voucherId of voucherIds) {
      const voucher = voucherService.getVoucherById(voucherId);
      if (!voucher) {
        console.warn(`[UserPoolService] 凭证不存在: ${voucherId}`);
        continue;
      }
      if (voucher.currentHolderId !== ownerId) {
        console.warn(`[UserPoolService] 凭证不属于用户: ${voucherId}`);
        continue;
      }
      if (voucher.status !== VoucherStatus.ACTIVE) {
        console.warn(`[UserPoolService] 凭证状态不正确: ${voucherId}`);
        continue;
      }

      // 检查凭证是否已在奖池中
      if (pool.vouchers.some(v => v.voucherId === voucherId)) {
        console.warn(`[UserPoolService] 凭证已在奖池中: ${voucherId}`);
        continue;
      }

      // 转移凭证到奖池（特殊holderId标记）
      const poolHolderId = `POOL:${poolId}`;
      try {
        voucherService.transferVoucher(
          {
            voucherId,
            toUserId: poolHolderId,
            toUserName: `奖池:${pool.name}`,
            note: `存入奖池 ${pool.name}`,
          },
          ownerId,
          pool.ownerName
        );

        const config: PoolVoucherConfig = {
          voucherId,
          denomination: voucher.denomination,
          initialQuantity: 1,
          remainingQuantity: 1,
          depositedAt: Date.now(),
        };

        pool.vouchers.push(config);
        deposited.push(config);
        totalAmount += voucher.denomination;

        console.log(`[UserPoolService] 凭证 ${voucherId} 存入奖池 ${pool.name}`);
      } catch (error) {
        console.error(`[UserPoolService] 存入凭证失败: ${voucherId}`, error);
      }
    }

    if (deposited.length > 0) {
      pool.stats.totalDeposited += totalAmount;
      pool.updatedAt = Date.now();
      this.saveToStorage();
    }

    return {
      success: deposited.length > 0,
      deposited,
      totalAmount,
      error: deposited.length === 0 ? '没有凭证被存入' : undefined,
    };
  }

  /**
   * 从奖池发放奖励
   * 被 PlatformBindingService 调用
   */
  distributeFromPool(
    poolId: string,
    recipientId: string,
    recipientName: string,
    targetAmount: number
  ): DistributeFromPoolResult {
    const pool = this.pools.get(poolId);
    if (!pool) {
      return { success: false, error: '奖池不存在' };
    }

    if (pool.status !== 'active') {
      return { success: false, error: `奖池状态: ${pool.status}` };
    }

    // 查找最适合的凭证（面额最接近目标金额），排除凭证已不存在的情况
    const availableVouchers = pool.vouchers.filter(v => {
      if (v.remainingQuantity <= 0) return false;
      // 验证凭证是否真的存在于 VoucherService 中（防止因数据重置产生的悬挂引用）
      const exists = voucherService.getVoucherById(v.voucherId) !== null;
      if (!exists) {
        console.warn(`[UserPoolService] 清理悬挂凭证引用: ${v.voucherId}，凭证已不存在`);
      }
      return exists;
    });

    if (availableVouchers.length === 0) {
      // 奖池已耗尽（或所有凭证引用均已失效），更新状态
      pool.status = 'depleted';
      this.saveToStorage();
      return { success: false, error: '奖池已耗尽' };
    }

    // 贪心算法：尽可能用多张凭证凑出精确金额，避免大额凭证一次性转出
    const sortedVouchers = [...availableVouchers].sort((a, b) => b.denomination - a.denomination);
    const selectedVouchers: typeof availableVouchers = [];
    let remaining = targetAmount;

    for (const v of sortedVouchers) {
      if (remaining <= 0) break;
      if (v.denomination <= remaining) {
        selectedVouchers.push(v);
        remaining -= v.denomination;
      }
    }

    const poolHolderId = `POOL:${poolId}`;
    let totalDistributed = 0;
    let resultVoucherId: string | undefined;

    try {
      if (remaining === 0) {
        // 精确匹配成功：转移凑出的所有凭证
        for (const sel of selectedVouchers) {
          voucherService.transferVoucher(
            { voucherId: sel.voucherId, toUserId: recipientId, toUserName: recipientName, note: `从奖池 ${pool.name} 获得奖励` },
            poolHolderId,
            pool.ownerName
          );
          sel.remainingQuantity--;
          totalDistributed += sel.denomination;
        }
        resultVoucherId = selectedVouchers[0]?.voucherId;
      } else {
        // 精确匹配失败：找一张 >= 剩余金额的凭证
        const overflowVoucher = sortedVouchers.find(v => v.denomination >= remaining && !selectedVouchers.includes(v));
        if (overflowVoucher) {
          voucherService.transferVoucher(
            { voucherId: overflowVoucher.voucherId, toUserId: recipientId, toUserName: recipientName, note: `从奖池 ${pool.name} 获得奖励` },
            poolHolderId,
            pool.ownerName
          );
          overflowVoucher.remainingQuantity--;
          totalDistributed += overflowVoucher.denomination;
          resultVoucherId = overflowVoucher.voucherId;
        } else {
          return { success: false, error: '奖池中没有合适面额的凭证' };
        }
      }

      // 更新奖池状态
      pool.stats.totalDistributed += totalDistributed;
      pool.stats.distributionCount++;
      pool.stats.lastDistributionAt = Date.now();

      // 检查是否耗尽
      if (pool.vouchers.every(v => v.remainingQuantity === 0 || !voucherService.getVoucherById(v.voucherId))) {
        pool.status = 'depleted';
      }

      pool.updatedAt = Date.now();
      this.saveToStorage();

      console.log(`[UserPoolService] 从奖池 ${pool.name} 发放 ${totalDistributed} A币给 ${recipientName}`);

      return {
        success: true,
        voucherId: resultVoucherId,
        denomination: totalDistributed,
      };
    } catch (error) {
      console.error('[UserPoolService] 发放奖励失败:', error);
      return { success: false, error: String(error) };
    }
  }

  /**
   * 从用户的所有活跃奖池中随机选择一个进行发放
   */
  distributeFromUserPools(
    ownerId: string,
    recipientId: string,
    recipientName: string,
    targetAmount: number
  ): DistributeFromPoolResult & { poolId?: string; poolName?: string } {
    const userPools = this.getUserPools(ownerId).filter(p => p.status === 'active');

    if (userPools.length === 0) {
      return { success: false, error: '用户没有活跃奖池' };
    }

    // 过滤有足够余额的奖池
    const eligiblePools = userPools.filter(p =>
      p.vouchers.some(v => v.remainingQuantity > 0)
    );

    if (eligiblePools.length === 0) {
      return { success: false, error: '用户奖池均已耗尽' };
    }

    // 随机选择一个奖池
    const selectedPool = eligiblePools[Math.floor(Math.random() * eligiblePools.length)];

    const result = this.distributeFromPool(
      selectedPool.id,
      recipientId,
      recipientName,
      targetAmount
    );

    return {
      ...result,
      poolId: selectedPool.id,
      poolName: selectedPool.name,
    };
  }

  // ==================== 查询方法 ====================

  /**
   * 获取奖池详情
   */
  getPool(poolId: string): UserRewardPool | undefined {
    return this.pools.get(poolId);
  }

  /**
   * 获取用户的所有奖池
   */
  getUserPools(userId: string): UserRewardPool[] {
    return [...this.pools.values()]
      .filter(p => p.ownerId === userId)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * 获取奖池概览（用于列表展示）
   */
  getUserPoolOverviews(userId: string): UserPoolOverview[] {
    return this.getUserPools(userId).map(pool => ({
      id: pool.id,
      name: pool.name,
      ownerId: pool.ownerId,
      ownerName: pool.ownerName,
      status: pool.status,
      totalBalance: pool.vouchers.reduce((sum, v) => sum + v.denomination * v.remainingQuantity, 0),
      voucherCount: pool.vouchers.filter(v => v.remainingQuantity > 0).length,
      distributionCount: pool.stats.distributionCount,
      lastActivityAt: pool.stats.lastDistributionAt || pool.updatedAt,
    }));
  }

  /**
   * 获取所有活跃的公共奖池
   */
  getActivePools(): UserRewardPool[] {
    return [...this.pools.values()]
      .filter(p => p.status === 'active')
      .sort((a, b) => b.stats.distributionCount - a.stats.distributionCount);
  }

  /**
   * 获取所有有奖池的用户列表
   */
  getUsersWithPools(): { userId: string; userName: string; poolCount: number }[] {
    const userMap = new Map<string, { userId: string; userName: string; poolCount: number }>();

    for (const pool of this.pools.values()) {
      if (userMap.has(pool.ownerId)) {
        userMap.get(pool.ownerId)!.poolCount++;
      } else {
        userMap.set(pool.ownerId, {
          userId: pool.ownerId,
          userName: pool.ownerName,
          poolCount: 1,
        });
      }
    }

    return [...userMap.values()].sort((a, b) => b.poolCount - a.poolCount);
  }

  /**
   * 获取所有奖池
   */
  getAllPools(): UserRewardPool[] {
    return [...this.pools.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  // ==================== 状态管理 ====================

  /**
   * 暂停奖池
   */
  pausePool(poolId: string, ownerId: string): boolean {
    const pool = this.pools.get(poolId);
    if (!pool || pool.ownerId !== ownerId) return false;

    pool.status = 'paused';
    pool.updatedAt = Date.now();
    this.saveToStorage();
    return true;
  }

  /**
   * 恢复奖池
   */
  resumePool(poolId: string, ownerId: string): boolean {
    const pool = this.pools.get(poolId);
    if (!pool || pool.ownerId !== ownerId) return false;

    // 检查是否还有凭证
    const hasVouchers = pool.vouchers.some(v => v.remainingQuantity > 0);
    pool.status = hasVouchers ? 'active' : 'depleted';
    pool.updatedAt = Date.now();
    this.saveToStorage();
    return true;
  }

  /**
   * 删除奖池
   */
  deletePool(poolId: string, ownerId: string): boolean {
    const pool = this.pools.get(poolId);
    if (!pool || pool.ownerId !== ownerId) return false;

    // 将奖池中剩余的凭证退还给所有者
    const poolHolderId = `POOL:${poolId}`;
    for (const voucherConfig of pool.vouchers) {
      if (voucherConfig.remainingQuantity > 0) {
        try {
          voucherService.transferVoucher(
            {
              voucherId: voucherConfig.voucherId,
              toUserId: ownerId,
              toUserName: pool.ownerName,
              note: `奖池 ${pool.name} 删除，退还凭证`,
            },
            poolHolderId,
            '系统'
          );
        } catch (error) {
          console.error(`[UserPoolService] 退还凭证失败: ${voucherConfig.voucherId}`, error);
        }
      }
    }

    this.pools.delete(poolId);
    this.saveToStorage();
    deleteFromCloud(CLOUD_COLLECTION, poolId).catch(() => {});
    console.log(`[UserPoolService] 删除奖池: ${pool.name}`);
    return true;
  }

  // ==================== 统计 ====================

  /**
   * 计算奖池剩余总额
   */
  getPoolBalance(poolId: string): number {
    const pool = this.pools.get(poolId);
    if (!pool) return 0;

    return pool.vouchers.reduce((sum, v) => sum + v.denomination * v.remainingQuantity, 0);
  }

  /**
   * 计算奖池剩余凭证数
   */
  getPoolVoucherCount(poolId: string): number {
    const pool = this.pools.get(poolId);
    if (!pool) return 0;

    return pool.vouchers.filter(v => v.remainingQuantity > 0).length;
  }

  /**
   * 获取全局统计
   */
  getGlobalStats(): {
    totalPools: number;
    activePools: number;
    depletedPools: number;
    totalDeposited: number;
    totalDistributed: number;
  } {
    const pools = [...this.pools.values()];

    return {
      totalPools: pools.length,
      activePools: pools.filter(p => p.status === 'active').length,
      depletedPools: pools.filter(p => p.status === 'depleted').length,
      totalDeposited: pools.reduce((sum, p) => sum + p.stats.totalDeposited, 0),
      totalDistributed: pools.reduce((sum, p) => sum + p.stats.totalDistributed, 0),
    };
  }
}

// 导出单例
export const userPoolService = UserPoolService.getInstance();
