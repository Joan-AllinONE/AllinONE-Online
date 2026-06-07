/**
 * 平台游戏商店 — 类型定义
 *
 * 平台游戏商店专门服务于"未在 AllinONE 发布的外部游戏"的道具/商品交易。
 * 这些外部的游戏方将道具以兑换码+凭证的形式存储在平台，玩家购买后获得可识别的兑换码。
 */
import type { ItemVoucherTemplate } from '@/voucher-system/types';

// ==================== 外部游戏注册信息 ====================

/** 外部游戏在平台的注册信息 */
export interface ExternalGameStore {
  /** storeId */
  id: string;
  /** 游戏唯一标识：'ext-{slug}-{timestamp}' */
  gameId: string;
  /** 游戏名称 */
  gameName: string;
  /** 游戏图标（emoji 或 URL） */
  gameIcon: string;
  /** 开发商 */
  developer: string;
  /** 游戏简介 */
  description: string;
  /** 主题色 */
  theme: {
    primaryColor: string;
    secondaryColor: string;
  };
  /** 是否启用 */
  isActive: boolean;
  /** 注册时间 */
  createdAt: number;
  /** 最后更新时间 */
  updatedAt: number;
}

// ==================== 平台商店道具（视图层） ====================

/** 平台商店展示的道具（已有模板的视图包装） */
export interface PlatformStoreItem {
  /** 模板 ID */
  templateId: string;
  /** 所属游戏 */
  gameId: string;
  gameName: string;
  gameIcon: string;
  /** 道具基础信息 */
  name: string;
  description: string;
  itemType: string;
  icon: string;
  rarity: string;
  /** 价格 */
  price: number;
  currency: string;
  /** 库存状态 */
  totalSupply: number;
  mintedCount: number;
  availableCount: number;
  /** 兑换码数量 */
  redeemCodeCount: number;
  /** 原始模板引用 */
  template: ItemVoucherTemplate;
}

// ==================== 商店搜索/筛选 ====================

export type StoreSortBy = 'price-asc' | 'price-desc' | 'newest' | 'popular';
export type StoreFilterCategory = 'all' | 'weapon' | 'consumable' | 'currency' | 'buff' | 'package' | 'permanent';

export interface PlatformStoreQuery {
  gameId?: string;
  category?: StoreFilterCategory;
  sortBy?: StoreSortBy;
  search?: string;
}

// ==================== 兑换码展示 ====================

export interface PlatformPurchaseResult {
  success: boolean;
  itemName: string;
  redeemCode?: string;
  voucherId?: string;
  message: string;
}

// ==================== localStorage key ====================

export const PLATFORM_GAME_STORES_KEY = 'platform_game_stores';
