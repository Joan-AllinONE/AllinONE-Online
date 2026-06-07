/**
 * @file 公共类型定义（MVP v1.0 合规版）
 * @description gameCoins 为钱包货币，aCoins 为凭证系统管理（不在钱包中）
 */

/** 钱包货币类型（仅 gameCoins；aCoins 走凭证系统） */
export type Currency = 'gameCoins';

/** 定价货币类型（Marketplace/Store 场景） */
export type PricingCurrency = 'gameCoins' | 'aCoins';

/** 游戏币类型（用于下拉显示，MVP v1.0 仅 AllinONE） */
export interface GameCoinType {
  key: 'gameCoins';
  name: string;
  platform: string;
  icon: string;
  balance: number;
}