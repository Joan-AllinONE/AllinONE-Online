/**
 * 平台集成相关类型定义
 * 用于凭证系统与游戏平台的集成
 */

import type { DistributionRule } from '../types';

/**
 * 游戏类型
 */
export enum GameType {
  NATIVE = 'native',         // 平台自有游戏（如消消乐）
  EXTERNAL = 'external',     // 外部链接游戏（如New Day）
  PUBLISHED = 'published',   // 平台发布的iframe游戏（如ming）
}

/**
 * 触发模式
 */
export enum TriggerMode {
  ON_GAME_COMPLETE = 'on_game_complete',   // 游戏完成时
  ON_CLICK = 'on_click',                    // 点击时（外部游戏）
  ON_ACHIEVEMENT = 'on_achievement',        // 成就解锁时
  MANUAL = 'manual',                        // 手动触发
}

/**
 * 平台绑定配置
 * 将规则绑定到具体游戏的配置
 */
export interface PlatformBindingConfig {
  id: string;                    // 绑定配置ID
  gameId: string;                // 游戏ID
  gameName: string;              // 游戏名称
  gameType: GameType;            // 游戏类型
  ruleId: string;                // 绑定的规则ID
  ruleName: string;              // 规则名称（缓存）
  
  // 触发方式
  triggerMode: TriggerMode;
  
  // 参数覆盖（可选，覆盖规则默认值）
  paramsOverride?: {
    baseReward?: number;
    difficultyMultiplier?: Record<string, number>;
    scoreThreshold?: number;
  };
  
  // 限制条件
  limits: {
    cooldownMinutes: number;     // 冷却时间（分钟）
    maxDaily: number;            // 每日最大次数
    maxPerUser: number;          // 每用户总上限
    minPlayTime?: number;        // 最小游戏时长（秒）
  };
  
  // 状态
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  createdBy: string;
  createdByName: string;
}

/**
 * 游戏定义
 * 平台支持的游戏列表
 */
export interface GameDefinition {
  id: string;
  name: string;
  type: GameType;
  description?: string;
  icon?: string;
  url?: string;                  // 外部游戏URL
  externalUrl?: string;          // 外部链接
  isPublished?: boolean;         // 是否是发布的游戏
  status?: 'available' | 'coming-soon' | 'maintenance'; // 游戏状态
  supportsAchievements?: boolean; // 是否支持成就系统
  supportsScore?: boolean;       // 是否支持分数
}

/**
 * 奖励发放记录
 */
export interface RewardDistributionRecord {
  id: string;
  bindingId: string;             // 绑定配置ID
  gameId: string;                // 游戏ID
  userId: string;                // 用户ID
  userName: string;              // 用户名称
  ruleId: string;                // 触发的规则ID
  voucherId: string;             // 发放的凭证ID
  amount: number;                // 发放金额
  timestamp: number;             // 发放时间
  triggerData: {                 // 触发时的数据
    event: string;
    score?: number;
    difficulty?: string;
    level?: number;
    duration?: number;
    [key: string]: any;
  };
  source: 'pool_transfer' | 'new_created' | 'user_pool_transfer'; // 凭证来源
  // 奖池相关信息
  poolSource?: 'platform' | 'user';  // 奖池来源
  poolOwnerId?: string;              // 奖池所有者ID
  poolId?: string;                   // 奖池ID
  poolName?: string;                 // 奖池名称
}

/**
 * 奖池来源类型
 */
export type PoolSource = 'platform' | 'user';

/**
 * 创建绑定配置请求（扩展版）
 */
export interface CreateBindingRequestExtended {
  gameId: string;
  gameName: string;
  gameType: GameType;
  ruleId: string;
  ruleName: string;
  triggerMode: TriggerMode;
  paramsOverride?: PlatformBindingConfig['paramsOverride'];
  limits: PlatformBindingConfig['limits'];
  // 奖池相关
  poolSource?: PoolSource;        // 奖池来源
  poolOwnerId?: string;           // 用户奖池所有者ID
  poolId?: string;                // 具体奖池ID
}

/**
 * 用户奖励领取限制
 */
export interface UserRewardLimit {
  userId: string;
  bindingId: string;
  lastReceivedAt: number;        // 上次领取时间
  dailyCount: number;            // 今日领取次数
  dailyCountResetAt: number;     // 每日计数重置时间
  totalCount: number;            // 总领取次数
}

/**
 * 平台集成统计
 */
export interface PlatformIntegrationStats {
  totalBindings: number;         // 总绑定数
  activeBindings: number;        // 活跃绑定数
  totalDistributions: number;    // 总发放次数
  totalAmountDistributed: number; // 总发放金额
  distributionsByGame: Record<string, number>; // 按游戏统计
  distributionsByRule: Record<string, number>; // 按规则统计
}

/**
 * 创建绑定配置请求
 */
export interface CreateBindingRequest {
  gameId: string;
  gameName: string;
  gameType: GameType;
  ruleId: string;
  ruleName: string;
  triggerMode: TriggerMode;
  paramsOverride?: PlatformBindingConfig['paramsOverride'];
  limits: PlatformBindingConfig['limits'];
}

/**
 * 更新绑定配置请求
 */
export interface UpdateBindingRequest {
  triggerMode?: TriggerMode;
  paramsOverride?: PlatformBindingConfig['paramsOverride'];
  limits?: Partial<PlatformBindingConfig['limits']>;
  enabled?: boolean;
}

/**
 * 预设游戏列表
 */
export const PRESET_GAMES: GameDefinition[] = [
  // 平台自有游戏
  {
    id: 'match3',
    name: '消消乐',
    type: GameType.NATIVE,
    description: '经典三消游戏，通关即可获得奖励',
    icon: '🎮',
    status: 'available',
    supportsScore: true,
    supportsAchievements: true,
  },
  {
    id: 'puzzle',
    name: '数字拼图',
    type: GameType.NATIVE,
    description: '挑战你的逻辑思维，完成拼图获得丰厚奖励',
    icon: '🧩',
    status: 'coming-soon',
    supportsScore: true,
  },
  {
    id: 'memory',
    name: '记忆翻牌',
    type: GameType.NATIVE,
    description: '考验记忆力的翻牌游戏，记忆越好奖励越多',
    icon: '🧠',
    status: 'coming-soon',
    supportsScore: true,
  },
  {
    id: 'snake',
    name: '贪吃蛇',
    type: GameType.NATIVE,
    description: '经典贪吃蛇游戏',
    icon: '🐍',
    status: 'available',
    supportsScore: true,
  },

  // 外部链接游戏
  {
    id: 'newday',
    name: 'New Day',
    type: GameType.EXTERNAL,
    description: '生存冒险游戏',
    icon: '🌅',
    status: 'available',
    externalUrl: 'https://example.com/newday',
    supportsScore: true,
  },
  {
    id: 'stick-war',
    name: '火柴人保卫战',
    type: GameType.EXTERNAL,
    description: '策略塔防游戏',
    icon: '🛡️',
    status: 'available',
    externalUrl: 'https://example.com/stickman',
    supportsScore: true,
  },
];

/**
 * 触发模式选项
 */
export const TRIGGER_MODE_OPTIONS: { value: TriggerMode; label: string; description: string; applicableTypes: GameType[] }[] = [
  {
    value: TriggerMode.ON_GAME_COMPLETE,
    label: '游戏完成时',
    description: '游戏上报通关/胜利/过关/分数里程碑事件时发放（需游戏集成奖励上报，见发布指南 4.7 代码段 E）',
    applicableTypes: [GameType.NATIVE, GameType.PUBLISHED],
  },
  {
    value: TriggerMode.ON_CLICK,
    label: '点击游玩时',
    description: '玩家从游戏中心点击「游玩」进入时立即发放（无需游戏改造，立即可用）',
    applicableTypes: [GameType.NATIVE, GameType.EXTERNAL, GameType.PUBLISHED],
  },
  {
    value: TriggerMode.ON_ACHIEVEMENT,
    label: '成就解锁时',
    description: '游戏上报成就解锁事件时发放（需游戏集成奖励上报，见发布指南 4.7 代码段 E）',
    applicableTypes: [GameType.NATIVE, GameType.PUBLISHED],
  },
  {
    value: TriggerMode.MANUAL,
    label: '手动触发',
    description: '不参与自动发放，仅供管理端手动调用',
    applicableTypes: [GameType.NATIVE, GameType.EXTERNAL, GameType.PUBLISHED],
  },
];
