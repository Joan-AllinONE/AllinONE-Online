/**
 * 玩家交易市场类型定义（MVP v1.1）
 * 
 * 道具以上架的凭证（Voucher）为中心，托管于市场：
 * 上架 → freezeVoucher → MarketListing
 * 成交 → walletSkill.spend / voucherPaymentService.payWithVoucher
 *      → unfreezeVoucher → transferVoucher(卖家→买家)
 * 下架 → unfreezeVoucher → MarketListing.status='cancelled'
 */
import type { PricingCurrency } from './common';

/** 市场挂牌状态 */
export type ListingStatus = 'active' | 'sold' | 'cancelled';

/** 市场挂牌 */
export interface MarketListing {
  id: string;                        // listing_xxxx
  voucherId: string;                 // 关联的凭证ID（ITEM 类型）
  voucherSerial: string;             // 凭证编号（展示用）

  // 道具信息（从凭证 metadata 读取）
  itemName: string;
  itemDescription: string;
  itemType: string;                  // consumable | permanent | currency | buff | package
  rarity?: string;                   // legendary | epic | rare | uncommon | common
  gameId: string;                    // 来源游戏ID
  gameName?: string;                 // 来源游戏名称

  // 定价（卖家自选货币与价格）
  price: number;
  currency: PricingCurrency;         // 'gameCoins' | 'aCoins'
  denomination: number;              // 凭证原始面值（参考，可脱离标价）

  // 卖家信息
  sellerId: string;
  sellerName: string;

  // 状态
  status: ListingStatus;
  listedAt: number;                  // 上架时间戳
  soldAt?: number;
  cancelledAt?: number;
  buyerId?: string;
  buyerName?: string;

  // 关联交易
  freezeTxId?: string;               // 冻结交易ID
  paymentTxIds?: string[];           // 支付相关交易ID列表

  // 统计
  views: number;
}

/** 市场统计 */
export interface MarketStats {
  totalListings: number;             // 在售总数
  dailyTransactions: number;         // 今日成交
  totalVolume: number;               // 总成交额
  averagePrice: number;              // 均价
}

/** 购买结果 */
export interface PurchaseResult {
  success: boolean;
  listingId: string;
  message: string;
  paymentTxIds?: string[];
  sellerReceived?: number;           // 卖家实际到账（扣佣金后）
  commission?: number;               // 平台佣金
}

/** 上架结果 */
export interface ListItemResult {
  success: boolean;
  listing?: MarketListing;
  message: string;
}

/** 佣金配置 */
export const MARKET_COMMISSION_RATE = 0.05; // 5% P2P 交易佣金

/** 平台金库 */
export interface PlatformTreasury {
  gameCoins: number;      // 累计 gameCoins 佣金
  aCoins: number;         // 累计 A币 佣金
  totalTransactions: number;
  lastUpdated: number;
}

const TREASURY_KEY = 'platform_treasury';

export function loadTreasury(): PlatformTreasury {
  try {
    return JSON.parse(localStorage.getItem(TREASURY_KEY) || 'null') || {
      gameCoins: 0, aCoins: 0, totalTransactions: 0, lastUpdated: Date.now(),
    };
  } catch {
    return { gameCoins: 0, aCoins: 0, totalTransactions: 0, lastUpdated: Date.now() };
  }
}

export function depositTreasury(currency: 'gameCoins' | 'aCoins', amount: number): PlatformTreasury {
  const t = loadTreasury();
  if (currency === 'gameCoins') t.gameCoins += amount;
  else t.aCoins += amount;
  t.totalTransactions++;
  t.lastUpdated = Date.now();
  localStorage.setItem(TREASURY_KEY, JSON.stringify(t));
  return t;
}
