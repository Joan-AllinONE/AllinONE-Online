/**
 * 钱包相关类型定义（MVP v1.0 合规版）
 * 
 * A币已迁出钱包，统一走凭证系统（VoucherService / voucherPaymentService）。
 * 钱包仅管理 gameCoins 余额。
 */
import type { Currency, GameCoinType } from './common';

export interface WalletBalance {
  gameCoins: number;          // AllinONE 游戏币
  instantVouchers: number;    // 即时发放型凭证价值
  algorithmVouchers: number;  // 计算分配型凭证价值
  totalValue: number;         // 总价值
  lastUpdated: Date;
}

/** 游戏币汇总信息 */
export interface GameCoinsSummary {
  total: number;
  types: GameCoinType[];
}

export interface WalletTransaction {
  id: string;
  type: 'income' | 'expense';
  category: 'game_reward' | 'purchase' | 'trade' | 'recharge' | 'mint';
  amount: number;
  currency: Currency;
  description: string;
  timestamp: Date;
  relatedId?: string;
}

export interface WalletStats {
  todayIncome: number;
  weeklyIncome: number;
  todayExpense: number;
  weeklyExpense: number;
  totalIncome: number;
  totalExpense: number;
  totalTransactions: number;
  lastTransactionTime: Date;
}
