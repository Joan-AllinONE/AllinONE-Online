/**
 * WalletSkill - 极简钱包 Skill（MVP v1.1）
 * 
 * 仅管理 gameCoins 余额。
 * A币已迁出本 Skill，统一走凭证系统（VoucherService + voucherPaymentService）。
 * 数据源：CloudBase collection users（余额）+ transactions（流水）
 * CloudBase 不可用时返回默认值。
 * 
 * 写入路径：通过 writeQueue 入队，保证重试 + 持久化 + 零丢失
 * 
 * @since MVP v1.0
 * @updated MVP v1.1 — 移除 aCoins
 * @updated MVP v1.2 — 写入操作接入 writeQueue
 */

import { BaseSkill } from '../BaseSkill';
import type { SkillContext } from '../types';
import { getCloudBaseApp, isCloudBaseReady } from '../../services/cloudbase';
import { writeQueue } from '../../services/writeQueue';

// ==================== 类型定义 ====================

export interface WalletBalance {
  gameCoins: number;
  instantVouchers: number;
  algorithmVouchers: number;
  lastUpdated: number;
}

export interface WalletTransaction {
  id: string;
  userId: string;
  type: 'income' | 'expense';
  amount: number;
  description: string;
  balanceAfter: WalletBalance;
  timestamp: number;
}

export interface WalletStats {
  todayIncome: number;
  todayExpense: number;
  weeklyIncome: number;
  weeklyExpense: number;
  totalTransactions: number;
  lastUpdated: number;
}

// ==================== localStorage 回退 ====================

const LOCAL_WALLETS_KEY = 'allinone_wallets';

function readLocalWallet(userId: string): WalletBalance | null {
  try {
    const raw = localStorage.getItem(LOCAL_WALLETS_KEY);
    if (!raw) return null;
    const wallets = JSON.parse(raw) as Record<string, WalletBalance>;
    return wallets[userId] || null;
  } catch {
    return null;
  }
}

function writeLocalWallet(userId: string, balance: WalletBalance): void {
  try {
    const raw = localStorage.getItem(LOCAL_WALLETS_KEY);
    const wallets = raw ? (JSON.parse(raw) as Record<string, WalletBalance>) : {};
    wallets[userId] = balance;
    localStorage.setItem(LOCAL_WALLETS_KEY, JSON.stringify(wallets));
  } catch { /* localStorage 不可用 */ }
}

// ==================== Skill 实现 ====================

export class WalletSkill extends BaseSkill {

  constructor() {
    super({
      displayName: '钱包服务',
      name: 'wallet',
      version: '3.0.0',
      description: '游戏币钱包（gameCoins only），A币走凭证系统',
      dependencies: ['auth'],
      requiredPermissions: [],
      actions: [],
    });
  }

  protected async onInitialize(): Promise<void> {
    this.registerAction('getBalance', this.getBalance.bind(this), {
      description: '获取用户游戏币余额',
      params: { type: 'object', properties: {} },
    });

    this.registerAction('recharge', this.recharge.bind(this), {
      description: '充值游戏币',
      params: {
        type: 'object',
        required: ['amount'],
        properties: {
          amount: { type: 'number' },
          description: { type: 'string' },
        },
      },
    });

    this.registerAction('spend', this.spend.bind(this), {
      description: '消费游戏币',
      params: {
        type: 'object',
        required: ['amount'],
        properties: {
          amount: { type: 'number' },
          description: { type: 'string' },
        },
      },
    });

    this.registerAction('getTransactions', this.getTransactions.bind(this), {
      description: '获取交易流水',
      params: {
        type: 'object',
        properties: { limit: { type: 'number', default: 50 } },
      },
    });

    this.registerAction('getStats', this.getStats.bind(this), {
      description: '获取钱包统计',
      params: { type: 'object', properties: {} },
    });
  }

  // ==================== Actions ====================

  async getBalance(_params: any, context: SkillContext): Promise<WalletBalance> {
    const userId = context.userId || 'anonymous';
    console.log(`[WalletSkill] getBalance(userId=${userId})`);

    // 🔑 先读 localStorage 缓存（adjustBalance 每次都会同步写入）
    const cachedBalance = readLocalWallet(userId);

    try {
      if (!isCloudBaseReady()) {
        throw new Error('CloudBase not ready');
      }
      const app = getCloudBaseApp();
      const db = app.database();
      const res = await db.collection('users').where({ _openid: userId }).limit(1).get();
      if (res.data.length > 0) {
        const doc = res.data[0];
        const cloudBalance: WalletBalance = {
          gameCoins: doc.gameCoins || 0,
          instantVouchers: doc.instantVouchers || 0,
          algorithmVouchers: doc.algorithmVouchers || 0,
          lastUpdated: doc.updatedAt || Date.now(),
        };
        // 如果 localStorage 缓存更新（adjustBalance 刚扣款但 writeQueue 未处理），优先使用缓存
        if (cachedBalance && cachedBalance.lastUpdated > cloudBalance.lastUpdated) {
          console.log(`[WalletSkill] 使用更新的 localStorage 缓存 (cached=${cachedBalance.gameCoins}, cloud=${cloudBalance.gameCoins})`);
          return cachedBalance;
        }
        // 同步更新 localStorage 缓存
        writeLocalWallet(userId, cloudBalance);
        return cloudBalance;
      }
      // 用户文档不存在，创建初始文档（通过写入队列）
      const defaultBalance: WalletBalance = {
        gameCoins: 1000,
        instantVouchers: 0,
        algorithmVouchers: 0,
        lastUpdated: Date.now(),
      };
      writeQueue.enqueue({
        collection: 'users',
        operation: 'upsert',
        where: { _openid: userId },
        data: {
          _openid: userId,
          gameCoins: defaultBalance.gameCoins,
          instantVouchers: 0,
          algorithmVouchers: 0,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      });
      // 如果缓存中有数据（说明 adjustBalance 已经创建过文档并扣款），优先使用缓存
      if (cachedBalance) {
        return cachedBalance;
      }
      writeLocalWallet(userId, defaultBalance);
      return defaultBalance;
    } catch {
      // CloudBase 不可用，从 localStorage 回退读取
      console.log(`[WalletSkill] CloudBase 不可用，尝试 localStorage 回退 (userId=${userId})`);
      if (cachedBalance) {
        return cachedBalance;
      }
      // 无任何数据，返回默认余额
      const defaultBalance: WalletBalance = { gameCoins: 1000, instantVouchers: 0, algorithmVouchers: 0, lastUpdated: Date.now() };
      writeLocalWallet(userId, defaultBalance);
      return defaultBalance;
    }
  }

  async recharge(
    params: { amount: number; description?: string },
    context: SkillContext
  ): Promise<WalletBalance> {
    return this.adjustBalance(context.userId, 'income', params.amount, params.description || '充值');
  }

  async spend(
    params: { amount: number; description?: string },
    context: SkillContext
  ): Promise<WalletBalance> {
    const userId = context.userId;
    const bal = await this.getBalance({} as never, context);
    if (bal.gameCoins < params.amount) {
      throw new Error(`游戏币余额不足（需要 ${params.amount}，当前 ${bal.gameCoins}）`);
    }
    return this.adjustBalance(userId, 'expense', params.amount, params.description || '消费');
  }

  async getTransactions(
    params: { limit?: number },
    context: SkillContext
  ): Promise<WalletTransaction[]> {
    const userId = context.userId;
    try {
      if (!isCloudBaseReady()) return [];
      const app = getCloudBaseApp();
      const db = app.database();
      const res = await db.collection('transactions')
        .where({ userId })
        .orderBy('timestamp', 'desc')
        .limit(params.limit || 50)
        .get();
      return res.data as WalletTransaction[];
    } catch {
      return [];
    }
  }

  async getStats(_params: any, context: SkillContext): Promise<WalletStats> {
    const userId = context.userId;
    const txs = await this.getTransactions({ limit: 500 }, context);
    const now = Date.now();
    const DAY = 86400000;
    const WEEK = 7 * DAY;

    const stats: WalletStats = {
      todayIncome: 0,
      todayExpense: 0,
      weeklyIncome: 0,
      weeklyExpense: 0,
      totalTransactions: 0,
      lastUpdated: now,
    };

    for (const tx of txs) {
      const age = now - tx.timestamp;
      if (tx.type === 'income') {
        if (age < DAY) stats.todayIncome += tx.amount;
        if (age < WEEK) stats.weeklyIncome += tx.amount;
      } else {
        if (age < DAY) stats.todayExpense += tx.amount;
        if (age < WEEK) stats.weeklyExpense += tx.amount;
      }
      stats.totalTransactions++;
    }

    return stats;
  }

  // ==================== 私有方法 ====================

  private async adjustBalance(
    userId: string,
    type: 'income' | 'expense',
    amount: number,
    description: string
  ): Promise<WalletBalance> {
    const delta = type === 'income' ? amount : -amount;
    let balance: WalletBalance = { gameCoins: 0, instantVouchers: 0, algorithmVouchers: 0, lastUpdated: Date.now() };

    try {
      if (!isCloudBaseReady()) {
        throw new Error('CloudBase not ready');
      }
      const app = getCloudBaseApp();
      const db = app.database();
      const res = await db.collection('users').where({ _openid: userId }).limit(1).get();
      if (res.data.length > 0) {
        const doc = res.data[0];
        balance = {
          gameCoins: doc.gameCoins || 0,
          instantVouchers: doc.instantVouchers || 0,
          algorithmVouchers: doc.algorithmVouchers || 0,
          lastUpdated: doc.updatedAt || Date.now(),
        };
        const newGameCoins = balance.gameCoins + delta;
        const updateData = {
          updatedAt: Date.now(),
          gameCoins: newGameCoins,
        };
        // 🔑 方案C：关键余额直接写 CloudBase，失败时降级到 writeQueue 重试
        try {
          await db.collection('users').doc(doc._id).update(updateData);
        } catch (writeErr) {
          console.warn('[WalletSkill] CloudBase 直接写入失败，降级到 writeQueue:', writeErr);
          writeQueue.enqueue({
            collection: 'users',
            operation: 'update',
            docId: doc._id,
            data: updateData,
          });
        }
        balance.gameCoins = newGameCoins;
        balance.lastUpdated = Date.now();
      } else {
        // 用户文档不存在：以默认余额（1000 gameCoins）为基准执行扣款，创建文档
        const defaultCoins = 1000;
        const newGameCoins = defaultCoins + delta;
        const now = Date.now();
        const newDocData = {
          _openid: userId,
          gameCoins: newGameCoins,
          instantVouchers: 0,
          algorithmVouchers: 0,
          createdAt: now,
          updatedAt: now,
        };
        // 🔑 方案C：直接创建用户文档，失败时降级到 writeQueue
        try {
          await db.collection('users').add(newDocData);
        } catch (writeErr) {
          console.warn('[WalletSkill] CloudBase 创建用户文档失败，降级到 writeQueue:', writeErr);
          writeQueue.enqueue({
            collection: 'users',
            operation: 'upsert',
            where: { _openid: userId },
            data: newDocData,
          });
        }
        balance.gameCoins = newGameCoins;
        balance.lastUpdated = now;
        console.log(`[WalletSkill] 用户 ${userId} 文档不存在，已创建并扣款: ${newGameCoins} gameCoins`);
      }
    } catch {
      // CloudBase 不可用，从 localStorage 读写
      const localBalance = readLocalWallet(userId) || { gameCoins: 1000, instantVouchers: 0, algorithmVouchers: 0, lastUpdated: Date.now() };
      localBalance.gameCoins += delta;
      localBalance.lastUpdated = Date.now();
      balance = localBalance;
      writeLocalWallet(userId, localBalance);
    }

    // 🔑 关键修复：无论走 CloudBase 还是 localStorage 路径，都同步更新 localStorage 缓存
    // 这样 getBalance 的 localStorage 回退路径始终能读到最新余额
    try {
      writeLocalWallet(userId, { ...balance });
    } catch { /* localStorage 不可用，忽略 */ }

    const tx: WalletTransaction = {
      id: `tx_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      userId,
      type,
      amount,
      description,
      balanceAfter: { ...balance },
      timestamp: Date.now(),
    };

    // 通过写入队列入队交易记录（upsert，保证重试 + 零丢失 + 不重复）
    writeQueue.enqueue({
      collection: 'transactions',
      operation: 'upsert',
      data: { ...tx, createdAt: tx.timestamp },
    });

    return balance;
  }
}

/** 单例导出 */
export const walletSkill = new WalletSkill();
