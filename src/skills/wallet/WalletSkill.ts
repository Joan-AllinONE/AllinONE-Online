/**
 * WalletSkill - 极简钱包 Skill（MVP v1.1）
 * 
 * 仅管理 gameCoins 余额。
 * A币已迁出本 Skill，统一走凭证系统（VoucherService + voucherPaymentService）。
 * 数据源：CloudBase collection users（余额）+ transactions（流水）
 * 保留 localStorage 缓存加速读取。
 * 
 * @since MVP v1.0
 * @updated MVP v1.1 — 移除 aCoins
 */

import { BaseSkill } from '../BaseSkill';
import type { SkillContext } from '../types';
import { getCloudBaseApp } from '../../services/cloudbase';

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

// ==================== Skill 实现 ====================

export class WalletSkill extends BaseSkill {
  private readonly STORAGE_KEY = 'wallet_v3';

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
    try {
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
        if (cloudBalance.gameCoins === 0) {
          const local = this.getLocalBalance(userId);
          if (local.gameCoins > 0) {
            console.log(`[WalletSkill] CloudBase 余额为 0，使用 localStorage 数据 (userId=${userId})`);
            return local;
          }
        }
        return cloudBalance;
      }
    } catch { /* fallback */ }

    const local = this.getLocalBalance(userId);
    console.log(`[WalletSkill] fallback localStorage: userId=${userId}, gameCoins=${local.gameCoins}`);
    return local;
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
      const app = getCloudBaseApp();
      const db = app.database();
      const res = await db.collection('transactions')
        .where({ userId })
        .orderBy('timestamp', 'desc')
        .limit(params.limit || 50)
        .get();
      return res.data as WalletTransaction[];
    } catch {
      return this.getLocalTransactions(userId, params.limit || 50);
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

    let balance = this.getLocalBalance(userId);
    try {
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
        const update: any = { updatedAt: Date.now(), gameCoins: balance.gameCoins + delta };
        await db.collection('users').doc(doc._id).update(update);
      }
    } catch {
      // CloudBase 不可用，使用 localStorage
    }

    balance.gameCoins += delta;
    balance.lastUpdated = Date.now();
    this.saveLocalBalance(userId, balance);

    const tx: WalletTransaction = {
      id: `tx_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      userId,
      type,
      amount,
      description,
      balanceAfter: { ...balance },
      timestamp: Date.now(),
    };
    this.saveLocalTransaction(tx);

    try {
      const app = getCloudBaseApp();
      await app.database().collection('transactions').add({ ...tx, createdAt: tx.timestamp });
    } catch { /* best effort */ }

    return balance;
  }

  private getLocalBalance(userId: string): WalletBalance {
    try {
      const data = JSON.parse(localStorage.getItem(this.STORAGE_KEY) || '{}');
      return data[userId] || { gameCoins: 0, instantVouchers: 0, algorithmVouchers: 0, lastUpdated: Date.now() };
    } catch {
      return { gameCoins: 0, instantVouchers: 0, algorithmVouchers: 0, lastUpdated: Date.now() };
    }
  }

  private saveLocalBalance(userId: string, balance: WalletBalance): void {
    try {
      const data = JSON.parse(localStorage.getItem(this.STORAGE_KEY) || '{}');
      data[userId] = balance;
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(data));
    } catch { /* ignore */ }
  }

  private getLocalTransactions(userId: string, limit: number): WalletTransaction[] {
    try {
      const all: WalletTransaction[] = JSON.parse(localStorage.getItem('wallet_tx') || '[]');
      return all.filter(t => t.userId === userId).slice(-limit).reverse();
    } catch {
      return [];
    }
  }

  private saveLocalTransaction(tx: WalletTransaction): void {
    try {
      const all: WalletTransaction[] = JSON.parse(localStorage.getItem('wallet_tx') || '[]');
      all.push(tx);
      if (all.length > 1000) all.splice(0, all.length - 1000);
      localStorage.setItem('wallet_tx', JSON.stringify(all));
    } catch { /* ignore */ }
  }
}

/** 单例导出 */
export const walletSkill = new WalletSkill();
