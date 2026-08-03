/**
 * 活动中心模块 - 类型定义
 *
 * 该模块完全自包含，仅依赖：
 *  - globalEventBus（事件总线，用于进度追踪）
 *  - SkillGateway（用于发放游戏币奖励）
 *  - 后端 /api/v1/activities（活动配置与排行榜）
 * 不依赖平台其它业务模块，可作为独立包复用。
 */

export type ActivityType =
  | 'daily_checkin' // 每日签到
  | 'onboarding' // 新手任务
  | 'growth' // 成长任务
  | 'limited_event' // 限时活动
  | 'invite' // 邀请有礼
  | 'achievement' // 成就
  | 'lottery'; // 幸运抽奖

export type ActivityStatus = 'draft' | 'active' | 'ended';

/** 奖励定义：按用户决策，统一使用游戏币 */
export interface RewardDef {
  kind: 'gameCoins';
  amount: number;
  label?: string;
}

/** 任务型活动的完成条件（事件驱动） */
export interface ActivityCondition {
  /** globalEventBus 事件名，例如 'game.played' */
  event: string;
  /** 需要触发的次数 */
  target: number;
}

export interface LotteryPrize {
  reward: RewardDef;
  /** 相对权重 */
  weight: number;
  label?: string;
}

/** 活动定义（由后端/种子数据提供，跨浏览器共享） */
export interface ActivityDef {
  id: string;
  type: ActivityType;
  title: string;
  description: string;
  /** lucide 图标名，例如 'Gift' */
  icon?: string;
  status: ActivityStatus;
  sortOrder?: number;
  startTime?: number;
  endTime?: number;
  /** 任务型活动条件 */
  conditions?: ActivityCondition;
  /** 签到/任务/成就/邀请的奖励；签到时按索引对应第 N 天 */
  rewards: RewardDef[];
  /** 抽奖配置 */
  lottery?: {
    /** 每次抽奖消耗游戏币 */
    cost: number;
    prizes: LotteryPrize[];
  };
  /** 邀请配置 */
  invite?: {
    /** 每成功邀请 1 人的奖励 */
    rewardPerInvitee: RewardDef;
  };
  createdBy?: string;
  createdAt?: number;
  updatedAt?: number;
}

export type ProgressStatus = 'locked' | 'available' | 'completed' | 'claimed';

/** 玩家进度（localStorage 优先，单玩家本地持久化） */
export interface ProgressRecord {
  userId: string;
  activityId: string;
  status: ProgressStatus;
  current: number;
  target: number;
  /** 连续签到天数 */
  streak: number;
  /** 最后一次签到的 dayIndex（floor(ts/DAY)） */
  lastCheckInDay: number;
  makeupUsed: number;
  lastClaimedAt?: number;
  history: { at: number; rewards: RewardDef[] }[];
  updatedAt: number;
}

/** 领奖事件（上报后端用于排行榜） */
export interface ClaimEvent {
  id: string;
  activityId: string;
  userId: string;
  userName?: string;
  amount: number;
  at: number;
}

export interface LeaderboardEntry {
  userId: string;
  userName: string;
  totalCoins: number;
}
