/**
 * Wallet API - 钱包系统
 */

import type { AllinONEGame } from '../index';
import { getCachedToken } from './tokenManager';

export interface Currency {
  type: string;
  amount: number;
}

export interface Transaction {
  id: string;
  type: 'income' | 'expense';
  currency: string;
  amount: number;
  description: string;
  timestamp: string;
  gameId?: string;
}

export interface WalletBalance {
  computingPower: number;
  gameCoins: number;
  diamonds?: number;
}

export interface RewardParams {
  computingPower?: number;
  gameCoins?: number;
  diamonds?: number;
  reason?: string;
}

export class WalletAPI {
  private game: AllinONEGame;
  private balance: WalletBalance = { computingPower: 0, gameCoins: 0 };
  private initialized: boolean = false;

  constructor(game: AllinONEGame) {
    this.game = game;
  }

  async initialize(): Promise<void> {
    // 加载本地缓存的余额
    const saved = localStorage.getItem('allinone_wallet');
    if (saved) {
      try {
        this.balance = JSON.parse(saved);
      } catch {
        // 忽略解析错误
      }
    }

    // 从服务器获取最新余额
    await this.refreshBalance();
    this.initialized = true;
  }

  /**
   * 获取余额
   */
  async getBalance(): Promise<WalletBalance> {
    await this.refreshBalance();
    return { ...this.balance };
  }

  /**
   * 发放奖励
   */
  async reward(params: RewardParams): Promise<void> {
    try {
      const response = await fetch('/api/wallet/reward', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.getToken()}`,
        },
        body: JSON.stringify({
          ...params,
          gameId: (this.game as any).getConfig().gameId,
        }),
      });

      const result = await response.json();

      if (result.success) {
        // 更新本地余额
        if (params.computingPower) this.balance.computingPower += params.computingPower;
        if (params.gameCoins) this.balance.gameCoins += params.gameCoins;
        if (params.diamonds) this.balance.diamonds = (this.balance.diamonds || 0) + params.diamonds;
        
        this.saveBalance();
        
        // 触发事件
        (this.game as any).emit('wallet:update', { balance: this.balance });
      }
    } catch (error) {
      console.error('Reward failed:', error);
      throw error;
    }
  }

  /**
   * 消费
   */
  async spend(currency: string, amount: number, reason?: string): Promise<boolean> {
    try {
      const response = await fetch('/api/wallet/spend', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.getToken()}`,
        },
        body: JSON.stringify({
          currency,
          amount,
          reason,
          gameId: (this.game as any).getConfig().gameId,
        }),
      });

      const result = await response.json();

      if (result.success) {
        await this.refreshBalance();
        (this.game as any).emit('wallet:update', { balance: this.balance });
      }

      return result.success;
    } catch (error) {
      console.error('Spend failed:', error);
      return false;
    }
  }

  /**
   * 货币兑换
   */
  async exchange(fromCurrency: string, toCurrency: string, amount: number): Promise<boolean> {
    try {
      const response = await fetch('/api/wallet/exchange', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.getToken()}`,
        },
        body: JSON.stringify({ fromCurrency, toCurrency, amount }),
      });

      const result = await response.json();

      if (result.success) {
        await this.refreshBalance();
        (this.game as any).emit('wallet:update', { balance: this.balance });
      }

      return result.success;
    } catch (error) {
      console.error('Exchange failed:', error);
      return false;
    }
  }

  /**
   * 获取交易记录
   */
  async getTransactions(limit: number = 20): Promise<Transaction[]> {
    try {
      const response = await fetch(`/api/wallet/transactions?limit=${limit}`, {
        headers: {
          'Authorization': `Bearer ${this.getToken()}`,
        },
      });

      const result = await response.json();
      return result.transactions || [];
    } catch (error) {
      console.error('Get transactions failed:', error);
      return [];
    }
  }

  // ==================== 私有方法 ====================

  private async refreshBalance(): Promise<void> {
    try {
      const token = this.getToken();
      if (!token) return;

      const response = await fetch('/api/wallet/balance', {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });

      const result = await response.json();

      if (result.success && result.balance) {
        this.balance = result.balance;
        this.saveBalance();
      }
    } catch (error) {
      // 如果网络请求失败，使用本地缓存
      console.warn('Failed to refresh balance, using cached value');
    }
  }

  private saveBalance(): void {
    localStorage.setItem('allinone_wallet', JSON.stringify(this.balance));
  }

  private getToken(): string | null {
    return getCachedToken();
  }
}
