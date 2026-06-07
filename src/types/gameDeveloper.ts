/**
 * 游戏开发者类型定义
 * 
 * 游戏商账户体系：每个已发布游戏自动创建 game-{gameId} 账户。
 * 玩家购买道具的凭证收入转入该账户，平台按比例抽成。
 * 每日结算：每日 00:00 自动将平台分成从游戏商账户转入 platform_treasury。
 */

/** 游戏开发者账户 */
export interface GameDeveloperAccount {
  /** 账户ID, 格式: "game-{gameId}" */
  accountId: string;
  /** 关联的游戏ID */
  gameId: string;
  /** 游戏名称 */
  gameName: string;
  /** 发布者用户ID */
  publisherId: string;
  /** 发布者名称 */
  publisherName: string;
  /** 平台分成比例 (0-100)，默认 10 */
  revenueSharePercent: number;
  
  /** 累计收入（凭证面额合计） */
  totalRevenue: number;
  /** 已提现金额 */
  totalWithdrawn: number;
  /** 当前可用余额（凭证面额合计） */
  availableBalance: number;
  /** 待结算的平台分成（尚未转移到 platform_treasury） */
  platformOwed: number;
  /** 已结算的平台分成了计 */  
  platformSettled: number;
  
  /** 上次每日结算时间戳 */
  lastDailySettlement: number;
  
  /** 销售统计 */
  stats: {
    /** 总售出道具数 */
    totalSoldItems: number;
    /** 总售出凭证数 */
    totalSoldVouchers: number;
    /** 道具销售明细 {templateId: {name, count, revenue}} */
    itemSales: Record<string, GameItemSaleStat>;
  };
  
  /** 账户状态 */
  status: 'active' | 'frozen' | 'closed';
  /** 创建时间 */
  createdAt: number;
  /** 更新时间 */
  updatedAt: number;
}

/** 道具销售统计 */
export interface GameItemSaleStat {
  templateId: string;
  name: string;
  count: number;
  totalRevenue: number;
}

/** 游戏商收入交易记录 */
export interface DeveloperRevenueTransaction {
  id: string;
  gameId: string;
  accountId: string;
  type: 'purchase' | 'settlement' | 'withdrawal' | 'refund' | 'reinvest';
  amount: number;
  currency: 'aCoins' | 'gameCoins';
  description: string;
  fromUserId?: string;
  fromUserName?: string;
  metadata?: Record<string, any>;
  timestamp: number;
}

/** 游戏商概览（平台管理端用） */
export interface GameDeveloperOverview {
  accountId: string;
  gameId: string;
  gameName: string;
  publisherId: string;
  publisherName: string;
  revenueSharePercent: number;
  totalRevenue: number;
  availableBalance: number;
  platformOwed: number;
  platformSettled: number;
  totalWithdrawn: number;
  totalSoldItems: number;
  status: string;
  lastDailySettlement: number;
}

/** 平台系统账户 ID 常量 */
export const SYSTEM_ACCOUNTS = {
  PLATFORM_POOL: 'platform_pool',
  PLATFORM_TREASURY: 'platform_treasury',
  SYSTEM: 'SYSTEM',
} as const;

/** 获取游戏开发者账户ID */
export function getGameDeveloperAccountId(gameId: string): string {
  return `game-${gameId}`;
}
