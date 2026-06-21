/**
 * 兑换码系统类型定义
 * 
 * 平台作为兑换中心，游戏方托管道具，玩家购买兑换码后在游戏内兑换
 */

// ==================== 核心类型 ====================

/** 道具/兑换码状态 */
export enum RedeemCodeStatus {
  UNUSED = 'unused',       // 未使用
  SOLD = 'sold',           // 已售出
  USED = 'used',           // 已使用
  EXPIRED = 'expired',     // 已过期
  DISABLED = 'disabled',   // 已禁用
}

/** 道具类型 */
export enum ItemType {
  CONSUMABLE = 'consumable',     // 消耗品（如生命药水）
  PERMANENT = 'permanent',       // 永久道具（如皮肤）
  CURRENCY = 'currency',         // 货币（如金币）
  BUFF = 'buff',                 // 增益效果
  PACKAGE = 'package',           // 礼包（包含多个物品）
}

/** 游戏方托管道具定义 */
export interface HostedItem {
  id: string;                   // 道具唯一ID
  gameId: string;               // 所属游戏ID
  name: string;                 // 道具名称
  description: string;          // 道具描述
  icon?: string;                // 道具图标URL
  type: ItemType;               // 道具类型
  rarity?: 'common' | 'rare' | 'epic' | 'legendary';  // 稀有度
  
  // 兑换码配置
  codeConfig: {
    prefix?: string;            // 兑换码前缀（如 HP-）
    length: number;             // 兑换码长度（不含前缀）
    charset: 'alphanumeric' | 'numeric' | 'alphabetic';  // 字符集
    caseSensitive: boolean;     // 是否区分大小写
    expireDays?: number;        // 兑换码过期天数（0表示永不过期）
    singleUse: boolean;         // 是否一次性使用
  };
  
  // 库存管理
  inventory: {
    total: number;              // 总库存数量
    available: number;          // 可用库存
    sold: number;               // 已售出
    used: number;               // 已兑换使用
  };
  
  // 定价
  pricing: {
    price: number;              // 单价（ACoin）
    currency: string;           // 货币类型
    discount?: number;          // 折扣（0-1）
    bulkDiscount?: {            // 批量购买折扣
      minQuantity: number;
      discount: number;
    }[];
  };
  
  // 游戏内效果（游戏方配置，平台只存储不解析）
  gameEffect: {
    itemId: string;             // 游戏内道具ID
    quantity: number;           // 数量
    duration?: number;          // 持续时间（秒，0表示永久）
    effectType?: string;        // 效果类型 (e.g., 'difficulty_reducer', 'score_boost', 'custom')
    metadata?: Record<string, any>;  // 额外元数据（包含效果参数）
    /** Schema 名称（UGC 道具专用，如 'match3-powerup'） */
    schemaName?: string;
    /** Schema 结构化数据（UGC 道具专用，含 effect/params 等） */
    itemData?: Record<string, any>;
  };
  
  // 状态和时间
  status: 'active' | 'inactive' | 'sold_out';
  createdAt: string;
  updatedAt: string;
}

/** 兑换码实例 */
export interface RedeemCode {
  id: string;                   // 兑换码唯一ID（数据库ID）
  code: string;                 // 兑换码字符串（如 HP-A3F9K2M7）
  gameId: string;               // 所属游戏ID
  itemId: string;               // 对应道具ID
  
  // 生命周期
  status: RedeemCodeStatus;
  createdAt: string;
  soldAt?: string;              // 售出时间
  soldTo?: string;              // 购买用户ID
  usedAt?: string;              // 使用时间
  usedBy?: string;              // 使用用户ID
  expiredAt?: string;           // 过期时间
  
  // 验证相关
  verifyCount: number;          // 验证次数
  lastVerifyAt?: string;        // 最后验证时间
}

/** 购买记录 */
export interface RedeemCodePurchase {
  id: string;
  userId: string;               // 购买用户
  gameId: string;               // 游戏ID
  itemId: string;               // 道具ID
  codeIds: string[];            // 购买的兑换码ID列表
  codes: string[];              // 兑换码字符串列表（展示用）
  
  // 交易信息
  quantity: number;             // 购买数量
  unitPrice: number;            // 单价
  totalPrice: number;           // 总价
  currency: string;             // 货币
  discount: number;             // 折扣金额
  finalPrice: number;           // 实付金额
  
  // 状态
  status: 'pending' | 'completed' | 'refunded';
  paidAt: string;
  completedAt?: string;
}

// ==================== API 请求/响应类型 ====================

/** 创建托管道具请求 */
export interface CreateHostedItemRequest {
  gameId: string;
  name: string;
  description: string;
  type: ItemType;
  codeConfig: HostedItem['codeConfig'];
  initialInventory: number;
  pricing: Omit<HostedItem['pricing'], 'currency'> & { currency?: string };
  gameEffect: HostedItem['gameEffect'];
}

/** 生成兑换码请求 */
export interface GenerateCodesRequest {
  itemId: string;
  gameId: string;
  quantity: number;             // 生成数量
}

/** 生成兑换码响应 */
export interface GenerateCodesResponse {
  success: boolean;
  codes: RedeemCode[];
  generatedCount: number;
  failedCount: number;
}

/** 购买兑换码请求 */
export interface PurchaseCodesRequest {
  itemId: string;
  gameId: string;
  quantity: number;
  userId: string;
}

/** 验证兑换码请求（游戏方调用） */
export interface VerifyCodeRequest {
  code: string;                 // 兑换码
  gameId: string;               // 游戏ID
  userId: string;               // 游戏内用户ID
}

/** 验证兑换码响应 */
export interface VerifyCodeResponse {
  valid: boolean;
  code?: RedeemCode;
  item?: HostedItem;
  message?: string;             // 验证失败原因
  gameEffect?: HostedItem['gameEffect'];  // 游戏内效果
}

/** 使用兑换码请求（游戏方调用） */
export interface UseCodeRequest {
  code: string;
  gameId: string;
  userId: string;               // 游戏内用户ID
  characterId?: string;         // 角色ID（可选）
}

/** 使用兑换码响应 */
export interface UseCodeResponse {
  success: boolean;
  code: string;
  item?: HostedItem;
  gameEffect?: HostedItem['gameEffect'];
  usedAt: string;
  message?: string;
}

// ==================== 游戏方 SDK 集成类型 ====================

/** 兑换码 SDK 配置 */
export interface RedeemCodeSDKConfig {
  gameId: string;
  apiKey: string;
  endpoint: string;
  timeout?: number;
  retryCount?: number;
}

/** SDK 验证结果回调 */
export interface RedeemCodeVerifyCallback {
  onSuccess: (code: string, item: HostedItem, effect: HostedItem['gameEffect']) => void;
  onError: (code: string, error: string) => void;
  onDuplicate: (code: string) => void;
}

// ==================== 统计类型 ====================

/** 道具统计 */
export interface ItemStatistics {
  itemId: string;
  totalCodes: number;
  availableCodes: number;
  soldCodes: number;
  usedCodes: number;
  expiredCodes: number;
  revenue: number;
  salesTrend: { date: string; sold: number; revenue: number }[];
}

/** 游戏方兑换码总览 */
export interface GameRedeemCodeOverview {
  gameId: string;
  totalItems: number;
  totalCodes: number;
  totalAvailable: number;
  totalSold: number;
  totalUsed: number;
  totalRevenue: number;
  recentSales: RedeemCodePurchase[];
  topItems: { itemId: string; name: string; sales: number; revenue: number }[];
}
