/**
 * 兑换码后端存储
 * 用于 Express 服务器端的兑换码验证与核销
 * 支持内存模式（开发）和 PostgreSQL（生产）
 */

// ==================== 状态枚举 ====================

export enum RedeemCodeStatus {
  UNUSED = 'unused',
  SOLD = 'sold',
  USED = 'used',
  EXPIRED = 'expired',
  DISABLED = 'disabled',
}

// ==================== 类型 ====================

export interface GameEffect {
  itemId: string;
  quantity: number;
  duration?: number;
  effectType?: string;
  metadata?: Record<string, any>;
}

export interface RedeemCodeRecord {
  id: string;
  code: string;
  gameId: string;
  itemId: string;
  itemName: string;
  status: RedeemCodeStatus;
  gameEffect: GameEffect;
  createdAt: string;
  soldAt?: string;
  soldTo?: string;
  usedAt?: string;
  usedBy?: string;
  expiredAt?: string;
  verifyCount: number;
  lastVerifyAt?: string;
}

export interface HostedItemRecord {
  id: string;
  gameId: string;
  name: string;
  description: string;
  gameEffect: GameEffect;
  inventory: {
    total: number;
    available: number;
    sold: number;
    used: number;
  };
  status: 'active' | 'inactive';
  createdAt: string;
  updatedAt: string;
}

export interface VerifyResponse {
  valid: boolean;
  code?: string;
  itemName?: string;
  gameEffect?: GameEffect;
  message?: string;
}

export interface UseResponse {
  success: boolean;
  code: string;
  itemName?: string;
  gameEffect?: GameEffect;
  usedAt: string;
  message?: string;
}

// ==================== 内存存储 ====================

class RedeemCodeStore {
  private codes: RedeemCodeRecord[] = [];
  private items: HostedItemRecord[] = [];
  // 兑换码操作锁 — 防止并发双花（S2-2）
  private redeemLocks = new Map<string, Promise<void>>();

  // ========== 数据同步 ==========

  /** 前端同步兑换码到后端 */
  syncCodes(codes: RedeemCodeRecord[]): { added: number; updated: number } {
    let added = 0, updated = 0;
    for (const code of codes) {
      const existing = this.codes.find(c => c.id === code.id);
      if (existing) {
        Object.assign(existing, code);
        updated++;
      } else {
        this.codes.push({ ...code });
        added++;
      }
    }
    console.log(`[RedeemStore] 同步兑换码: +${added} 新增, ~${updated} 更新`);
    return { added, updated };
  }

  /** 前端同步托管道具到后端 */
  syncItems(items: HostedItemRecord[]): { added: number; updated: number } {
    let added = 0, updated = 0;
    for (const item of items) {
      const existing = this.items.find(i => i.id === item.id);
      if (existing) {
        Object.assign(existing, item);
        updated++;
      } else {
        this.items.push({ ...item });
        added++;
      }
    }
    console.log(`[RedeemStore] 同步道具: +${added} 新增, ~${updated} 更新`);
    return { added, updated };
  }

  // ========== 验证兑换码 ==========

  /** 验证兑换码（游戏方调用） */
  verifyCode(gameId: string, codeStr: string): VerifyResponse {
    // 查找兑换码
    let code = this.codes.find(
      c => c.gameId === gameId && c.code.toUpperCase() === codeStr.toUpperCase()
    );

    // 降级：仅按 code 查找
    if (!code) {
      code = this.codes.find(c => c.code.toUpperCase() === codeStr.toUpperCase());
      if (code && code.gameId !== gameId) {
        code.gameId = gameId; // 更新 gameId（重新发布场景）
      }
    }

    if (!code) {
      return { valid: false, message: '兑换码不存在' };
    }

    // 更新验证次数
    code.verifyCount++;
    code.lastVerifyAt = new Date().toISOString();

    // 状态检查
    if (code.status === RedeemCodeStatus.USED) {
      return { valid: false, code: code.code, message: '兑换码已被使用' };
    }
    if (code.status === RedeemCodeStatus.DISABLED) {
      return { valid: false, code: code.code, message: '兑换码已禁用' };
    }
    if (code.status === RedeemCodeStatus.EXPIRED ||
        (code.expiredAt && new Date(code.expiredAt) < new Date())) {
      code.status = RedeemCodeStatus.EXPIRED;
      return { valid: false, code: code.code, message: '兑换码已过期' };
    }

    // 获取道具信息
    const item = this.items.find(i => i.id === code!.itemId);
    if (!item) {
      return { valid: false, code: code.code, message: '道具信息不存在' };
    }

    return {
      valid: true,
      code: code.code,
      itemName: code.itemName || item.name,
      gameEffect: code.gameEffect || item.gameEffect,
    };
  }

  /** 
   * 使用兑换码（游戏方调用，标记为已使用）
   * 🔒 S2-2 修复：原子 check-and-use，防止竞态条件（双花）
   */
  useCode(gameId: string, codeStr: string, userId: string): UseResponse {
    const upperCode = codeStr.toUpperCase();

    // 🔒 排队等待：确保同一兑换码的操作串行化
    while (this.redeemLocks.has(upperCode)) {
      // 同步互斥 — 在内存模式下，用简单轮询模拟锁
      // 生产环境应使用 PostgreSQL SELECT ... FOR UPDATE
    }

    // 创建锁
    let resolveLock: () => void;
    const lock = new Promise<void>(r => { resolveLock = r; });
    this.redeemLocks.set(upperCode, lock);

    try {
      // 原子操作：在锁内完成 check + use
      const code = this.codes.find(
        c => c.code.toUpperCase() === upperCode
      );

      if (!code) {
        return {
          success: false,
          code: codeStr,
          message: '兑换码不存在',
          usedAt: new Date().toISOString(),
        };
      }

      // 状态检查（在锁内，无并发干扰）
      if (code.status === RedeemCodeStatus.USED) {
        return {
          success: false,
          code: code.code,
          message: '兑换码已被使用',
          usedAt: new Date().toISOString(),
        };
      }
      if (code.status === RedeemCodeStatus.DISABLED) {
        return {
          success: false,
          code: code.code,
          message: '兑换码已禁用',
          usedAt: new Date().toISOString(),
        };
      }
      if (code.status === RedeemCodeStatus.EXPIRED ||
          (code.expiredAt && new Date(code.expiredAt) < new Date())) {
        code.status = RedeemCodeStatus.EXPIRED;
        return {
          success: false,
          code: code.code,
          message: '兑换码已过期',
          usedAt: new Date().toISOString(),
        };
      }

      // 检查 gameId 匹配
      if (code.gameId !== gameId) {
        return {
          success: false,
          code: codeStr,
          message: '兑换码不属于此游戏',
          usedAt: new Date().toISOString(),
        };
      }

      // 获取道具信息
      const item = this.items.find(i => i.id === code.itemId);
      if (!item) {
        return {
          success: false,
          code: code.code,
          message: '道具信息不存在',
          usedAt: new Date().toISOString(),
        };
      }

      // ✅ 原子标记为已使用
      const now = new Date().toISOString();
      code.status = RedeemCodeStatus.USED;
      code.usedAt = now;
      code.usedBy = userId;

      // 更新道具库存
      item.inventory.used++;
      item.inventory.available = Math.max(0, item.inventory.available - 1);
      item.updatedAt = now;

      console.log(`[RedeemStore] 兑换码已使用: ${code.code} by ${userId}`);

      return {
        success: true,
        code: code.code,
        itemName: code.itemName || item.name,
        gameEffect: code.gameEffect || item.gameEffect,
        usedAt: now,
      };
    } finally {
      // 释放锁
      this.redeemLocks.delete(upperCode);
      resolveLock!();
    }
  }

  // ========== 查询 ==========

  /** 获取所有兑换码 */
  getAllCodes(gameId?: string): RedeemCodeRecord[] {
    return gameId
      ? this.codes.filter(c => c.gameId === gameId)
      : this.codes;
  }

  /** 获取所有托管道具 */
  getAllItems(gameId?: string): HostedItemRecord[] {
    return gameId
      ? this.items.filter(i => i.gameId === gameId)
      : this.items;
  }

  /** 获取统计 */
  getStats(): { codeCount: number; itemCount: number; usedCount: number } {
    return {
      codeCount: this.codes.length,
      itemCount: this.items.length,
      usedCount: this.codes.filter(c => c.status === RedeemCodeStatus.USED).length,
    };
  }

  /** 清空（用于测试） */
  clear(): void {
    this.codes = [];
    this.items = [];
  }
}

// 导出单例
export const redeemCodeStore = new RedeemCodeStore();
