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
import { loadFromBackend } from '../../services/backendSync';
import { getApiBase } from '../../services/apiBase';
import { getToken } from '../../services/authTokenService';

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
const LOCAL_TRANSACTIONS_KEY = 'allinone_wallet_transactions';

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

function readLocalTransactions(userId: string): WalletTransaction[] {
  try {
    const raw = localStorage.getItem(LOCAL_TRANSACTIONS_KEY);
    if (!raw) return [];
    const all = JSON.parse(raw) as Record<string, WalletTransaction[]>;
    return all[userId] || [];
  } catch {
    return [];
  }
}

function writeLocalTransaction(userId: string, tx: WalletTransaction): void {
  try {
    const raw = localStorage.getItem(LOCAL_TRANSACTIONS_KEY);
    const all = raw ? (JSON.parse(raw) as Record<string, WalletTransaction[]>) : {};
    const list = all[userId] || [];
    list.unshift(tx); // 新交易在前
    // 最多保留 200 条，防止 localStorage 溢出
    if (list.length > 200) list.splice(200);
    all[userId] = list;
    localStorage.setItem(LOCAL_TRANSACTIONS_KEY, JSON.stringify(all));
  } catch { /* localStorage 不可用 */ }
}

// ==================== 后端只读同步（跨浏览器） ====================
// users / transactions 为只读同步集合：仅读取走后端云函数，
// 写入维持现状（writeQueue / CloudBase 直写），避免公开无鉴权写端点被篡改。

async function readBalanceFromBackend(userId: string): Promise<WalletBalance | null> {
  try {
    const rows = await loadFromBackend<any>('users');
    // 兼容历史重复文档（旧版任务奖励发放曾按 _id=userId 误建副本）：取 updatedAt 最新的为准
    const candidates = rows.filter(r => r && (r._openid === userId || r.id === userId));
    const doc = candidates
      .slice()
      .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))[0];
    if (!doc) return null;
    return {
      gameCoins: doc.gameCoins || 0,
      instantVouchers: doc.instantVouchers || 0,
      algorithmVouchers: doc.algorithmVouchers || 0,
      lastUpdated: doc.updatedAt || Date.now(),
    };
  } catch {
    return null;
  }
}

async function readTransactionsFromBackend(userId: string): Promise<WalletTransaction[]> {
  try {
    const rows = await loadFromBackend<any>('transactions');
    return rows
      .filter(r => r && r.userId === userId)
      .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0)) as WalletTransaction[];
  } catch {
    return [];
  }
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

    this.registerAction('recordTransaction', this.recordTransaction.bind(this), {
      description: '只记录交易流水，不修改 gameCoins 余额（用于 A币凭证支付等非钱包账本的消费，保证钱包交易记录完整可见）',
      params: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['income', 'expense'] },
          amount: { type: 'number' },
          description: { type: 'string' },
        },
        required: ['type', 'amount', 'description'],
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

    // 🔑 先读 localStorage 缓存（仅作服务端不可达时的回退展示）
    const cachedBalance = readLocalWallet(userId);

    // ============ 主路径：服务端平台钱包隧道（唯一可信账本，与合约托管同源） ============
    // 修复双账本：此前读路径直读 CloudBase/本地兜底造 1000 币，与合约扣款的
    // users.gameCoins 服务端账本割裂 → 钱包显示有钱、合约托管报「余额不足」。
    try {
      const token = await getToken();
      if (token) {
        const resp = await fetch(`${getApiBase()}/__wallet/platform/balance`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (resp.ok) {
          const json = await resp.json();
          const b = json?.data?.balance;
          if (b && json?.data?.exists === true) {
            const balance: WalletBalance = {
              gameCoins: Number(b.gameCoins) || 0,
              instantVouchers: Number(b.instantVouchers) || 0,
              algorithmVouchers: Number(b.algorithmVouchers) || 0,
              lastUpdated: b.lastUpdated || Date.now(),
            };
            writeLocalWallet(userId, balance);
            return balance;
          }
          if (b && json?.data?.exists === false) {
            // 服务端无钱包文档 → 通过服务端通道发注册礼（幂等 txId），保持单账本
            try {
              const adj = await fetch(`${getApiBase()}/__wallet/platform/adjust`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({ delta: 1000, txId: `signup_${userId}`, description: '新钱包注册礼' }),
              });
              if (adj.ok) {
                const ab = (await adj.json())?.data?.balance;
                if (ab) {
                  const balance: WalletBalance = {
                    gameCoins: Number(ab.gameCoins) || 0,
                    instantVouchers: Number(ab.instantVouchers) || 0,
                    algorithmVouchers: Number(ab.algorithmVouchers) || 0,
                    lastUpdated: ab.lastUpdated || Date.now(),
                  };
                  writeLocalWallet(userId, balance);
                  console.log(`[WalletSkill] 服务端发放注册礼 1000 (userId=${userId})`);
                  return balance;
                }
              }
            } catch { /* 发放失败按 0 处理 */ }
            return { gameCoins: 0, instantVouchers: 0, algorithmVouchers: 0, lastUpdated: Date.now() };
          }
        }
      }
    } catch (e) {
      console.warn('[WalletSkill] 服务端钱包隧道不可用，回退 CloudBase/本地:', (e && e.message) || e);
    }

    try {
      if (!isCloudBaseReady()) {
        throw new Error('CloudBase not ready');
      }
      const app = getCloudBaseApp();
      const db = app.database();
      const res = await db.collection('users').where({ _openid: userId }).limit(10).get();
      if (res.data.length > 0) {
        // 兼容历史重复文档（旧版任务奖励发放曾按 _id=userId 误建副本）：取 updatedAt 最新的为准
        const doc = res.data
          .slice()
          .sort((a: any, b: any) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))[0];
        const cloudBalance: WalletBalance = {
          gameCoins: doc.gameCoins || 0,
          instantVouchers: doc.instantVouchers || 0,
          algorithmVouchers: doc.algorithmVouchers || 0,
          lastUpdated: doc.updatedAt || Date.now(),
        };
        // 服务端隧道不可用时的兼容路径：缓存更新（刚扣款未同步）优先
        if (cachedBalance && cachedBalance.lastUpdated > cloudBalance.lastUpdated) {
          console.log(`[WalletSkill] 使用更新的 localStorage 缓存 (cached=${cachedBalance.gameCoins}, cloud=${cloudBalance.gameCoins})`);
          return cachedBalance;
        }
        // 同步更新 localStorage 缓存
        writeLocalWallet(userId, cloudBalance);
        return cloudBalance;
      }
      // CloudBase 也无文档：不再客户端凭空造 1000 币（假余额根源），回退缓存或 0
      if (cachedBalance) {
        return cachedBalance;
      }
      return { gameCoins: 0, instantVouchers: 0, algorithmVouchers: 0, lastUpdated: Date.now() };
    } catch {
      // CloudBase SDK 不可用 → 先尝试后端只读同步（跨浏览器），再回退 localStorage
      console.log(`[WalletSkill] CloudBase 不可用，尝试后端只读同步 (userId=${userId})`);
      const remote = await readBalanceFromBackend(userId);
      if (remote && (!cachedBalance || remote.lastUpdated >= cachedBalance.lastUpdated)) {
        writeLocalWallet(userId, remote);
        return remote;
      }
      if (cachedBalance) {
        return cachedBalance;
      }
      // 无任何数据：返回 0（服务端为准，不再造本地假余额）
      return { gameCoins: 0, instantVouchers: 0, algorithmVouchers: 0, lastUpdated: Date.now() };
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
    // ============ 主路径：服务端平台钱包隧道（与余额同源，跨浏览器一致） ============
    try {
      const token = await getToken();
      if (token) {
        const resp = await fetch(`${getApiBase()}/__wallet/platform/transactions?limit=${params.limit || 50}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (resp.ok) {
          const rows = (await resp.json())?.data?.transactions;
          if (Array.isArray(rows) && rows.length > 0) {
            // 服务端流水 balanceAfter 是数字，前端展示层兼容补齐
            return rows.map((r: any) => ({
              ...r,
              id: r.id || r.txId,
              balanceAfter: typeof r.balanceAfter === 'number'
                ? { gameCoins: r.balanceAfter, instantVouchers: 0, algorithmVouchers: 0, lastUpdated: r.timestamp }
                : r.balanceAfter,
            })) as WalletTransaction[];
          }
        }
      }
    } catch { /* 回退既有链路 */ }
    try {
      if (!isCloudBaseReady()) {
        // CloudBase SDK 不可用 → 先尝试后端只读同步（跨浏览器），失败再回退本地
        const remoteTxs = await readTransactionsFromBackend(userId);
        if (remoteTxs.length > 0) return remoteTxs.slice(0, params.limit || 50);
        const localTxs = readLocalTransactions(userId);
        return localTxs.slice(0, params.limit || 50);
      }
      const app = getCloudBaseApp();
      const db = app.database();
      const res = await db.collection('transactions')
        .where({ userId })
        .orderBy('timestamp', 'desc')
        .limit(params.limit || 50)
        .get();
      const cloudTxs = res.data as WalletTransaction[];
      if (cloudTxs.length > 0) return cloudTxs;
      // 云端无数据 → 回退到本地
      return readLocalTransactions(userId).slice(0, params.limit || 50);
    } catch {
      // 任何错误 → 回退到本地
      return readLocalTransactions(userId).slice(0, params.limit || 50);
    }
  }

  /**
   * 只记录交易流水，不修改 gameCoins 余额。
   *
   * 背景：A币凭证支付走 voucherService.transferVoucher（凭证系统自己的账本），
   * 此前钱包交易记录完全看不到这笔支出。凭证购买道具时由 voucherItemService
   * 调用本 action，把「净支出/找零」同步写入钱包流水，保证钱包页交易记录完整。
   */
  async recordTransaction(
    params: { type: 'income' | 'expense'; amount: number; description: string },
    context: SkillContext
  ): Promise<{ success: boolean }> {
    const userId = context.userId;
    if (!userId || !(Number(params.amount) > 0)) {
      return { success: false };
    }
    const cached = readLocalWallet(userId);
    const balanceAfter: WalletBalance = cached || {
      gameCoins: 0,
      instantVouchers: 0,
      algorithmVouchers: 0,
      lastUpdated: Date.now(),
    };
    const tx: WalletTransaction = {
      id: `tx_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      userId,
      type: params.type,
      amount: params.amount,
      description: params.description,
      balanceAfter,
      timestamp: Date.now(),
    };
    writeLocalTransaction(userId, tx);
    // 云端落库与其他钱包流水一致（走写入队列；CloudBase 不可用时由队列重试，不影响本地展示）
    writeQueue.enqueue({ collection: 'transactions', operation: 'upsert', data: { ...tx, createdAt: tx.timestamp } });
    console.log(`[WalletSkill] recordTransaction(${params.type}, ${params.amount}): ${params.description}`);
    return { success: true };
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

    // ============ 主路径：后端平台钱包隧道（跨浏览器落库） ============
    // users 为 READ_ONLY 集合，公开 backendSync 端点会拦截；故走 __wallet/platform/adjust
    // （云函数 handler 内直写 users + transactions，仅信任 token 解析的 userId）。
    const txId = `tx_${userId}_${type}_${amount}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    try {
      const token = await getToken();
      if (token) {
        const resp = await fetch(`${getApiBase()}/__wallet/platform/adjust`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ delta, description, txId }),
        });
        if (resp.ok) {
          const json = await resp.json();
          const b = json?.data?.balance;
          if (b) {
            balance = {
              gameCoins: Number(b.gameCoins) || 0,
              instantVouchers: Number(b.instantVouchers) || 0,
              algorithmVouchers: Number(b.algorithmVouchers) || 0,
              lastUpdated: b.lastUpdated || Date.now(),
            };
            writeLocalWallet(userId, balance);
            writeLocalTransaction(userId, {
              id: `tx_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
              userId,
              type,
              amount,
              description,
              balanceAfter: { ...balance },
              timestamp: Date.now(),
            });
            // 通知钱包 UI 刷新（与其他模块的 wallet-updated 事件约定一致）
            try { window.dispatchEvent(new CustomEvent('wallet-updated', { detail: { userId } })); } catch { /* SSR/测试环境 */ }
            return balance;
          }
        }
      }
    } catch (e) {
      console.warn('[WalletSkill] 后端平台钱包隧道不可用，回退本地:', (e && e.message) || e);
    }

    // ============ 回退：CloudBase SDK / localStorage ============
    // CloudBase JS SDK 浏览器端 auth 已损坏（auth.call is not a function），仅作兼容回退。
    try {
      if (!isCloudBaseReady()) {
        throw new Error('CloudBase not ready');
      }
      const app = getCloudBaseApp();
      const db = app.database();
      const res = await db.collection('users').where({ _openid: userId }).limit(10).get();
      if (res.data.length > 0) {
        // 兼容历史重复文档：扣款必须落在 updatedAt 最新的那份钱包上
        const doc = res.data
          .slice()
          .sort((a: any, b: any) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))[0];
        balance = {
          gameCoins: doc.gameCoins || 0,
          instantVouchers: doc.instantVouchers || 0,
          algorithmVouchers: doc.algorithmVouchers || 0,
          lastUpdated: doc.updatedAt || Date.now(),
        };
        const newGameCoins = balance.gameCoins + delta;
        const updateData = { updatedAt: Date.now(), gameCoins: newGameCoins };
        try {
          await db.collection('users').doc(doc._id).update(updateData);
        } catch (writeErr) {
          console.warn('[WalletSkill] CloudBase 直接写入失败，降级到 writeQueue:', writeErr);
          writeQueue.enqueue({ collection: 'users', operation: 'update', docId: doc._id, data: updateData });
        }
        balance.gameCoins = newGameCoins;
        balance.lastUpdated = Date.now();
      } else {
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
        try {
          await db.collection('users').add(newDocData);
        } catch (writeErr) {
          console.warn('[WalletSkill] CloudBase 创建用户文档失败，降级到 writeQueue:', writeErr);
          writeQueue.enqueue({ collection: 'users', operation: 'upsert', where: { _openid: userId }, data: newDocData });
        }
        balance.gameCoins = newGameCoins;
        balance.lastUpdated = now;
        console.log(`[WalletSkill] 用户 ${userId} 文档不存在，已创建并扣款: ${newGameCoins} gameCoins`);
      }
    } catch {
      const localBalance = readLocalWallet(userId) || { gameCoins: 1000, instantVouchers: 0, algorithmVouchers: 0, lastUpdated: Date.now() };
      localBalance.gameCoins += delta;
      localBalance.lastUpdated = Date.now();
      balance = localBalance;
      writeLocalWallet(userId, localBalance);
    }

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
    writeLocalTransaction(userId, tx);
    writeQueue.enqueue({ collection: 'transactions', operation: 'upsert', data: { ...tx, createdAt: tx.timestamp } });

    // 通知钱包 UI 刷新（回退路径同样触发）
    try { window.dispatchEvent(new CustomEvent('wallet-updated', { detail: { userId } })); } catch { /* SSR/测试环境 */ }

    return balance;
  }
}

/** 单例导出 */
export const walletSkill = new WalletSkill();
