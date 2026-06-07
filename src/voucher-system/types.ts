/**
 * A币电子凭证系统 - 类型定义
 * 独立模块，用于管理可追溯、可流转的电子凭证
 */

/**
 * 凭证状态
 */
export enum VoucherStatus {
  ACTIVE = 'active',       // 正常流通中
  FROZEN = 'frozen',       // 已冻结
  EXPIRED = 'expired',     // 已过期
  DESTROYED = 'destroyed', // 已销毁
  REDEEMED = 'redeemed',   // 已兑换/已使用
}

/**
 * 交易类型
 */
export enum TransactionType {
  CREATE = 'create',       // 创建
  TRANSFER = 'transfer',   // 转账/流转
  FREEZE = 'freeze',       // 冻结
  UNFREEZE = 'unfreeze',   // 解冻
  DESTROY = 'destroy',     // 销毁
  BATCH_CREATE = 'batch_create', // 批量创建
  EXCHANGE = 'exchange',   // 兑换
  RECYCLE = 'recycle',     // 回收
  REDEEM = 'redeem',       // 使用/核销道具凭证
}

/**
 * 凭证数据结构
 */
export interface Voucher {
  id: string;                    // 唯一标识符 (UUID)
  serialNumber: string;          // 凭证编号 (人类可读)
  denomination: number;          // 面额/价值 (A币数量)
  currentHolderId: string;       // 当前持有者ID
  currentHolderName: string;     // 当前持有者名称
  status: VoucherStatus;         // 凭证状态
  createdAt: number;             // 创建时间戳
  createdBy: string;             // 创建者ID
  createdByName: string;         // 创建者名称
  expiresAt?: number;            // 过期时间戳 (可选)
  metadata?: VoucherMetadata;    // 扩展元数据
  transferCount: number;         // 流转次数
  lastTransferAt?: number;       // 最后流转时间

  // === 新增：规则相关字段 ===
  rules?: VoucherRules;          // 凭证规则配置
  issueDate?: number;            // 发行日期
  quantity?: number;             // 发行数量
  
  // === 新增：双轨凭证系统字段 ===
  sourceType: VoucherSourceType; // 凭证来源类型（即时发放/计算分配）
  algorithmInfo?: AlgorithmVoucherInfo; // 算法型凭证特有信息
}

/**
 * 凭证来源类型
 * 双轨凭证系统核心区分
 */
export enum VoucherSourceType {
  INSTANT = 'instant',       // 即时发放型（活动/游戏奖励直接发放）
  ALGORITHM = 'algorithm',   // 计算分配型（基于贡献度算法计算后发放）
  ITEM = 'item',             // 游戏道具凭证（承载游戏内道具）
  VOTE = 'vote',             // 投票凭证（社区治理投票权）
}

/** A币类凭证合集（可计入余额、可支付的类型） */
export const CURRENCY_SOURCE_TYPES = [
  VoucherSourceType.INSTANT,
  VoucherSourceType.ALGORITHM,
  VoucherSourceType.VOTE,
] as const;

/** 判断是否为A币类凭证（可计入余额、可参与支付） */
export function isCurrencyVoucher(sourceType?: VoucherSourceType): boolean {
  // sourceType 为 undefined 视为旧凭证（默认 A币类型），向后兼容
  if (sourceType === undefined) return true;
  return (CURRENCY_SOURCE_TYPES as readonly string[]).includes(sourceType);
}

/** 判断是否为道具凭证（不可计入余额、可上架交易） */
export function isItemVoucher(sourceType: VoucherSourceType): boolean {
  return sourceType === VoucherSourceType.ITEM;
}

/**
 * 道具发行策略
 * 控制游戏道具凭证的总量管理方式
 */
export enum ItemSupplyPolicy {
  LIMITED = 'limited',   // 限量发行：总量锁定，受 totalSupply 硬约束，不可增发
  OPEN = 'open',         // 开放发行：无总量约束，游戏方可自由增发
}

/**
 * 道具凭证模板（游戏方定义的道具类型）
 * 替代原 HostedItem 概念，将道具信息映射到凭证系统
 */
export interface ItemVoucherTemplate {
  id: string;                        // 模板ID
  gameId: string;                    // 所属游戏ID
  gameName?: string;                 // 游戏名称
  name: string;                      // 道具名称
  description: string;               // 道具描述
  itemType: string;                  // 道具类型 (consumable/permanent/currency/buff/package)
  icon?: string;                     // 图标标识

  // 发行策略
  supplyPolicy: ItemSupplyPolicy;    // 发行策略
  totalSupply?: number;              // 总量（仅 LIMITED 类型需要）
  mintedCount: number;               // 已铸造数量

  // 定价
  pricing: {
    price: number;                   // 价格
    currency: string;                // 货币类型 (ACOIN/GameCoin等)
    acceptVoucher?: boolean;         // 是否接受凭证支付
    voucherPrice?: number;           // 凭证价格
  };

  // 游戏内效果
  gameEffect: {
    itemId: string;                  // 游戏内道具ID
    quantity: number;                // 兑换数量
    effectType?: string;             // 效果类型 (e.g., 'difficulty_reducer', 'custom')
    metadata?: Record<string, any>;  // 额外元数据（包含效果参数）
  };

  // 元数据
  attributes?: Record<string, any>;  // 道具属性（攻击力、防御力等）
  rarity?: string;                   // 稀有度 (common/uncommon/rare/legendary)
  imageUrl?: string;                 // 道具图片
  consumable?: boolean;              // 是否消耗品（使用后销毁凭证）
  stackable?: boolean;               // 是否可堆叠

  // 时间
  hostedItemId?: string;             // 映射到旧兑换码系统的 HostedItem ID

  createdAt: number;                 // 创建时间
  updatedAt: number;                 // 更新时间
  createdBy: string;                 // 创建者
  isActive: boolean;                 // 是否启用
}

/**
 * 算法型凭证特有信息
 * 记录算法分配相关的详细数据
 */
export interface AlgorithmVoucherInfo {
  templateId: string;              // 所属算法模板ID
  templateName?: string;           // 模板名称
  settlementCycleId: string;       // 结算周期ID
  cycleNumber: number;             // 周期序号
  settlementDate: string;          // 结算日期 YYYY-MM-DD
  
  // 贡献度计算信息
  contributionScore: number;       // 个人贡献分数
  contributionRatio: number;       // 贡献比例（占总分的百分比）
  
  // 计算结果
  calculatedAmount: number;        // 计算应得金额（未取整）
  actualAmount: number;            // 实际发放金额（取整后）
  
  // 原始数据快照
  personalDataSnapshot: {
    gameCoins: number;
    computingPower: number;
    transactionVolume: number;
  };
  
  // 全网数据快照
  networkSnapshot?: {
    totalGameCoins: number;
    totalComputingPower: number;
    totalTransactionVolume: number;
    totalContributionScore: number;
    distributionPool: number;
  };
}

/**
 * 凭证元数据
 */
export interface VoucherMetadata {
  name?: string;                 // 凭证名称
  description?: string;          // 凭证描述
  category?: string;             // 分类
  tags?: string[];               // 标签
  issuer?: string;               // 发行方
  customData?: Record<string, any>; // 自定义数据

  // === 新增：凭证来源类型（传递给 VoucherService）===
  sourceType?: VoucherSourceType; // 凭证来源类型标记

  // === 新增：A币专属字段 ===
  totalSupply?: number;          // 总供应量
  circulatingSupply?: number;    // 流通供应量
  symbol?: string;               // 代币符号 (如: ACOIN)
  version?: string;              // 版本号
}

/**
 * 凭证规则配置
 */
export interface VoucherRules {
  // 分发规则
  distribution?: DistributionRule[];
  // 回收规则
  recycle?: RecycleRule[];
  // 权限配置
  permissions?: PermissionConfig;
  // 调度配置
  schedule?: ScheduleConfig;
}

/**
 * 分发规则类型
 */
export type DistributionType =
  | 'game_reward'               // 游戏奖励
  | 'daily_checkin'             // 每日签到
  | 'referral_bonus'            // 邀请奖励
  | 'task_completion'           // 任务完成
  | 'achievement_unlock'        // 成就解锁
  | 'event_reward'              // 活动奖励
  | 'manual_issuance'           // 手动发放
  | 'platform_bonus';           // 平台奖励

/**
 * 分发规则
 */
export interface DistributionRule {
  id: string;                    // 规则ID
  name: string;                  // 规则名称
  type: DistributionType;        // 分发类型
  enabled: boolean;              // 是否启用
  priority: number;              // 优先级 (越小越优先)

  // 触发条件
  trigger: {
    type: 'event' | 'schedule' | 'manual' | 'condition';
    event?: string;              // 事件类型
    schedule?: string;           // 定时表达式
    condition?: string;          // 条件表达式
  };

  // 分配逻辑
  allocation: {
    mode: 'fixed' | 'ratio' | 'tiered' | 'formula';
    fixedAmount?: number;        // 固定金额
    ratio?: number;              // 比例 (0-1)
    tieredAmounts?: TieredAmount[]; // 分档金额
    formula?: string;            // 公式
  };

  // 限制条件
  limits: {
    maxPerUser?: number;         // 每用户上限
    maxTotal?: number;           // 全局上限
    dailyCap?: number;           // 每日上限
    weeklyCap?: number;          // 每周上限
    cooldownMinutes?: number;    // 冷却时间
  };

  // 凭证来源（新增）
  source?: {
    mode: 'create_new' | 'transfer_from_pool';  // 创建新凭证 或 从奖池转移
    poolHolderId?: string;                      // 奖池持有者ID（如平台账户）
    poolTag?: string;                           // 奖池标签筛选
    requireExplicitPool?: boolean;              // 是否需要明确标记为奖池凭证
  };
}

/**
 * 分档金额
 */
export interface TieredAmount {
  minThreshold: number;
  maxThreshold: number;
  amount: number;
}

/**
 * 回收规则类型
 */
export type RecycleType =
  | 'daily_settlement'          // 每日结算
  | 'transaction_fee'           // 交易手续费
  | 'exchange_conversion'       // 兑换消耗
  | 'penalty_deduction'         // 惩罚扣除
  | 'expiration_burn'           // 过期销毁
  | 'buyback'                   // 平台回购
  | 'platform_tax';             // 平台税费

/**
 * 回收规则
 */
export interface RecycleRule {
  id: string;                    // 规则ID
  name: string;                  // 规则名称
  type: RecycleType;             // 回收类型
  enabled: boolean;              // 是否启用
  priority: number;              // 优先级

  // 触发条件
  trigger: {
    type: 'event' | 'schedule' | 'manual' | 'condition';
    event?: string;
    schedule?: string;
    condition?: string;
  };

  // 回收逻辑
  recycleLogic: {
    mode: 'fixed' | 'percentage' | 'sliding' | 'formula';
    fixedAmount?: number;
    percentage?: number;         // 百分比 (0-100)
    slidingScale?: SlidingScale; // 滑动比例
    formula?: string;
    destination: 'burn' | 'treasury' | 'pool' | 'platform'; // 去向
  };

  // 限制条件
  limits: {
    maxPerUser?: number;
    maxTotal?: number;
    dailyCap?: number;
  };
}

/**
 * 滑动比例
 */
export interface SlidingScale {
  threshold: number;
  belowRate: number;
  aboveRate: number;
}

/**
 * 权限配置
 */
export interface PermissionConfig {
  // 转账权限
  transfer: TransferPermission;
  // 兑换权限
  exchange: ExchangePermission;
  // 冻结权限
  freeze: FreezePermission;
  // 销毁权限
  destroy: DestroyPermission;
}

/**
 * 转账权限
 */
export interface TransferPermission {
  enabled: boolean;
  minAmount?: number;            // 最小转账金额
  maxAmount?: number;            // 单次最大转账金额
  dailyLimit?: number;           // 每日限额
  whitelist?: string[];          // 白名单地址
  blacklist?: string[];          // 黑名单地址
  requireVerification?: boolean; // 是否需要验证
}

/**
 * 兑换权限
 */
export interface ExchangePermission {
  enabled: boolean;
  exchangeRates: ExchangeRate[]; // 兑换汇率表
  minExchangeAmount?: number;
  dailyLimit?: number;
  cooldownMinutes?: number;
}

/**
 * 兑换汇率
 */
export interface ExchangeRate {
  targetCurrency: string;        // 目标货币 (如: GameCoin_GTA)
  targetSymbol?: string;         // 目标货币符号
  rate: number;                  // 兑换率 (1 A币 = X 目标币)
  fee?: number;                  // 手续费 (%)
  direction: 'both' | 'to_only' | 'from_only';
}

/**
 * 冻结权限
 */
export interface FreezePermission {
  enabled: boolean;
  roles?: string[];              // 可执行冻结的角色
  conditions?: string[];         // 冻结条件
  maxFreezeDuration?: number;    // 最大冻结时长 (小时)
}

/**
 * 销毁权限
 */
export interface DestroyPermission {
  enabled: boolean;
  roles?: string[];              // 可执行销毁的角色
  requireConfirmation?: boolean; // 是否需要确认
}

/**
 * 调度配置
 */
export interface ScheduleConfig {
  // 发行调度
  issuance?: {
    type: 'immediate' | 'scheduled' | 'phased';
    startDate?: number;          // 开始日期
    endDate?: number;            // 结束日期
    phases?: IssuancePhase[];    // 分阶段发行
  };
  // 自动执行调度
  autoExecution?: {
    enabled: boolean;
    cronExpression?: string;     // Cron 表达式
    intervalMinutes?: number;    // 执行间隔
  };
}

/**
 * 发行阶段
 */
export interface IssuancePhase {
  phase: number;                 // 阶段序号
  name: string;                  // 阶段名称
  amount: number;                // 发行量
  startDate: number;             // 开始时间
  endDate?: number;              // 结束时间
  conditions?: string;           // 发行条件
}

/**
 * 交易/流转记录
 */
export interface Transaction {
  id: string;                    // 交易ID
  voucherId: string;             // 关联凭证ID
  type: TransactionType;         // 交易类型
  fromUserId?: string;           // 转出方ID (创建时为空)
  fromUserName?: string;         // 转出方名称
  toUserId: string;              // 接收方ID
  toUserName: string;            // 接收方名称
  amount?: number;               // 涉及金额 (转账时)
  timestamp: number;             // 交易时间戳
  txHash?: string;               // 交易哈希 (可防篡改验证)
  note?: string;                 // 备注/说明
  relatedTxId?: string;          // 关联交易ID (如冻结对应解冻)

  // === 新增：规则相关 ===
  ruleId?: string;               // 触发的规则ID
  ruleType?: string;             // 规则类型
}

/**
 * 用户凭证持有统计
 */
export interface UserVoucherStats {
  userId: string;                // 用户ID
  totalCount: number;            // 持有凭证总数
  totalValue: number;            // 持有总价值
  activeCount: number;           // 正常状态数量
  frozenCount: number;           // 冻结状态数量
  receivedCount: number;         // 累计接收数量
  sentCount: number;             // 累计转出数量
}

/**
 * 系统统计
 */
export interface VoucherSystemStats {
  totalVouchers: number;         // 凭证总数量
  totalValue: number;            // 凭证总价值
  activeVouchers: number;        // 流通中凭证数
  totalTransactions: number;     // 交易总数
  totalTransfers: number;        // 流转次数
  uniqueHolders: number;         // 持有者数量
  systemCapacity: number;        // 系统容量上限 (10亿)
  utilizationRate: number;       // 使用率

  // === 新增：规则统计 ===
  totalDistributed: number;      // 总发行量
  totalRecycled: number;         // 总回收量
  activeRules: number;           // 活跃规则数
}

/**
 * 创建凭证请求 (基础)
 */
export interface CreateVoucherRequest {
  denomination: number;          // 面额
  recipientId: string;           // 接收者ID
  recipientName: string;         // 接收者名称
  expiresAt?: number;            // 过期时间
  metadata?: VoucherMetadata;    // 元数据
  note?: string;                 // 创建备注
}

/**
 * 增强的创建凭证请求
 */
export interface EnhancedCreateVoucherRequest extends CreateVoucherRequest {
  quantity?: number;             // 发行数量
  issueDate?: number;            // 发行日期
  rules?: VoucherRules;          // 规则配置
  templateId?: string;           // 使用的模板ID
}

/**
 * 转账请求
 */
export interface TransferRequest {
  voucherId: string;             // 凭证ID
  toUserId: string;              // 接收者ID
  toUserName: string;            // 接收者名称
  note?: string;                 // 转账备注
}

/**
 * 批量创建请求
 */
export interface BatchCreateRequest {
  count: number;                 // 创建数量
  denomination: number;          // 每个凭证的面额
  recipientId: string;           // 接收者ID
  recipientName: string;         // 接收者名称
  note?: string;                 // 备注
  rules?: VoucherRules;          // 规则配置
}

/**
 * 筛选条件
 */
export interface VoucherFilter {
  status?: VoucherStatus;        // 状态筛选
  holderId?: string;             // 持有者筛选
  minDenomination?: number;      // 最小面额
  maxDenomination?: number;      // 最大面额
  startDate?: number;            // 开始日期
  endDate?: number;              // 结束日期
  keyword?: string;              // 关键词搜索
  hasRules?: boolean;            // 是否有规则
  category?: string;             // 分类筛选
}

/**
 * 分页结果
 */
export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

/**
 * 凭证历史记录（包含凭证和交易记录）
 */
export interface VoucherHistory {
  voucher: Voucher;
  transactions: Transaction[];
  currentHolderDuration: number; // 当前持有者持有时间
  totalHolders: number;          // 历史持有者数量
}

/**
 * 凭证流转图节点
 */
export interface TransferNode {
  userId: string;
  userName: string;
  timestamp: number;
  index: number;
}

/**
 * 凭证流转图
 */
export interface TransferGraph {
  voucherId: string;
  nodes: TransferNode[];
  edges: { from: number; to: number; timestamp: number }[];
}

/**
 * 凭证模板
 */
export interface VoucherTemplate {
  id: string;                    // 模板ID
  name: string;                  // 模板名称
  description?: string;          // 模板描述
  category: string;              // 分类
  icon?: string;                 // 图标
  isDefault: boolean;            // 是否默认模板
  isSystem: boolean;             // 是否系统模板

  // 默认配置
  defaultDenomination: number;   // 默认面额
  defaultQuantity: number;       // 默认数量
  defaultExpiresDays?: number;   // 默认过期天数

  // 预设规则
  presetRules?: VoucherRules;

  // 元数据
  tags: string[];
  createdAt: number;
  updatedAt: number;
  createdBy: string;
  usageCount: number;            // 使用次数
}

/**
 * 预设模板ID
 */
export enum PresetTemplateId {
  PLATFORM_CURRENCY = 'platform_currency',    // 平台通用币
  GAME_REWARD = 'game_reward',                // 游戏奖励币
  STABLE_VALUE = 'stable_value',              // 稳定价值币
  DEFLATIONARY = 'deflationary',              // 通缩型代币
  POINTS_SYSTEM = 'points_system',            // 积分系统
  EVENT_TICKET = 'event_ticket',              // 活动门票
  MEMBERSHIP = 'membership',                  // 会员凭证
  CUSTOM = 'custom',                          // 自定义
}
