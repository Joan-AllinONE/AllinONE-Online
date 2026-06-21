/**
 * 游戏内容提案类型
 * 覆盖所有需要通过投票治理的游戏修改操作
 */
export enum GameProposalType {
  // 道具相关
  NEW_ITEM = 'new_item',               // 发布新道具
  MINT_ITEM = 'mint_item',             // 铸造道具凭证
  EDIT_ITEM = 'edit_item',             // 修改道具属性
  DELETE_ITEM = 'delete_item',         // 下架道具

  // 货币相关
  NEW_CURRENCY = 'new_currency',       // 发行新游戏币
  MINT_CURRENCY = 'mint_currency',     // 增发游戏币
  ADJUST_PRICE = 'adjust_price',       // 调整道具/货币价格

  // 内容相关
  NEW_CHARACTER = 'new_character',     // 新增角色
  NEW_MAP = 'new_map',                 // 新增地图
  NEW_GAMEPLAY = 'new_gameplay',       // 新增玩法/模式

  // 配置相关
  GAME_CONFIG = 'game_config',         // 游戏配置修改
  DIFFICULTY_ADJUST = 'difficulty_adjust', // 难度调整
}

/**
 * 提案类型的中文标签
 */
export const GameProposalTypeLabel: Record<GameProposalType, string> = {
  [GameProposalType.NEW_ITEM]: '发布新道具',
  [GameProposalType.MINT_ITEM]: '铸造道具凭证',
  [GameProposalType.EDIT_ITEM]: '修改道具属性',
  [GameProposalType.DELETE_ITEM]: '下架道具',
  [GameProposalType.NEW_CURRENCY]: '发行新游戏币',
  [GameProposalType.MINT_CURRENCY]: '增发游戏币',
  [GameProposalType.ADJUST_PRICE]: '调整价格',
  [GameProposalType.NEW_CHARACTER]: '新增角色',
  [GameProposalType.NEW_MAP]: '新增地图',
  [GameProposalType.NEW_GAMEPLAY]: '新增玩法',
  [GameProposalType.GAME_CONFIG]: '游戏配置修改',
  [GameProposalType.DIFFICULTY_ADJUST]: '难度调整',
};

/**
 * 提案状态
 */
export enum ProposalStatus {
  DRAFT = 'draft',           // 草稿
  ACTIVE = 'active',         // 投票中
  PASSED = 'passed',         // 已通过
  REJECTED = 'rejected',     // 已拒绝
  VETOED = 'vetoed',         // 被否决
  EXPIRED = 'expired',       // 已过期
  EXECUTED = 'executed',     // 已执行
  EXECUTION_FAILED = 'execution_failed', // 执行失败
}

/**
 * 提案状态中文标签
 */
export const ProposalStatusLabel: Record<ProposalStatus, string> = {
  [ProposalStatus.DRAFT]: '草稿',
  [ProposalStatus.ACTIVE]: '投票中',
  [ProposalStatus.PASSED]: '已通过',
  [ProposalStatus.REJECTED]: '已拒绝',
  [ProposalStatus.VETOED]: '已被否决',
  [ProposalStatus.EXPIRED]: '已过期',
  [ProposalStatus.EXECUTED]: '已执行',
  [ProposalStatus.EXECUTION_FAILED]: '执行失败',
};

/**
 * 投票权来源（三方治理体系）
 */
export enum VoteStakeholderType {
  GAME_DEVELOPER = 'game_developer',       // 游戏方
  PLAYER_COMMUNITY = 'player_community',    // 玩家社区
  PLATFORM = 'platform',                    // 平台方
}

/**
 * 投票权来源中文标签
 */
export const VoteStakeholderTypeLabel: Record<VoteStakeholderType, string> = {
  [VoteStakeholderType.GAME_DEVELOPER]: '游戏方',
  [VoteStakeholderType.PLAYER_COMMUNITY]: '玩家社区',
  [VoteStakeholderType.PLATFORM]: '平台方',
};

/**
 * 投票决策
 */
export type ProposalVoteDecision = 'approve' | 'reject' | 'abstain';

/**
 * 惩罚类型
 */
export type PenaltyType = 'freeze_assets' | 'force_delist' | 'traffic_limit' | 'warning';

/**
 * 惩罚配置
 */
export interface PenaltyConfig {
  type: PenaltyType;
  durationHours?: number;
  description: string;
}

/**
 * 游戏投票门槛配置
 * 每个游戏可独立配置三方投票权重和通过条件
 */
export interface GameVoteThreshold {
  gameId: string;

  // 三方投票权重 (总和应等于1.0)
  weights: {
    gameDeveloper: number;      // 游戏方权重
    playerCommunity: number;    // 玩家社区权重
    platform: number;           // 平台方权重
  };

  // 通用规则
  minVoteDurationHours: number;
  maxVoteDurationHours: number;
  quorumRate: number;              // 法定人数比例
  passThreshold: number;           // 通过阈值（加权赞成 > 此值）

  // 特殊规则
  vetoEnabled: boolean;
  vetoByFounderOnly: boolean;
  autoExecute: boolean;
  requiresPlatformReview: boolean;

  // 惩罚规则
  penaltyRules: {
    enabled: boolean;
    maxRefusalCount: number;
    penalties: PenaltyConfig[];
  };
}

/**
 * 提案数据载荷
 * 不同类型的提案携带不同的数据
 */
export interface GameProposalPayload {
  proposalType: GameProposalType;
  
  // 道具提案数据
  itemTemplate?: {
    name: string;
    description: string;
    itemType: string;
    rarity: string;
    pricing: { price: number; currency: string };
    gameEffect: { itemId: string; quantity: number; schemaName?: string; itemData?: Record<string, any>; schemaVersion?: string };
    supplyPolicy: 'limited' | 'open';
    totalSupply?: number;
    mintCount?: number;
  };

  // 货币提案数据
  currencyData?: {
    currencyType: string;
    amount: number;
    exchangeRate?: number;
  };

  // 角色/地图/玩法提案数据
  contentData?: {
    type: string;
    name: string;
    description: string;
    configJson?: Record<string, any>;
  };

  // 配置修改提案数据
  configChanges?: Record<string, any>;

  // 铸造提案数据
  mintData?: {
    templateId: string;
    templateName: string;
    count: number;
  };
}

/**
 * 提案实体
 */
export interface GameProposal {
  id: string;
  gameId: string;
  gameName: string;
  
  // 提案基本信息
  title: string;
  description: string;
  reason: string;
  proposalType: GameProposalType;
  payload: GameProposalPayload;
  
  // 状态
  status: ProposalStatus;
  proposerId: string;
  proposerName: string;
  proposerType: VoteStakeholderType;
  
  // 投票配置
  voteThreshold: GameVoteThreshold;
  voteDurationHours: number;
  votingStartAt: number;
  votingEndAt: number;
  whitelist?: string[];
  
  // 收益分成
  revenueSharing?: {
    gameShare: number;
    platformShare: number;
    creatorShare?: number;
  };
  
  // 投票记录与结果
  voteRecords: ProposalVoteRecord[];
  result?: ProposalResult;
  
  // 时间戳
  createdAt: number;
  executedAt?: number;
  executionResult?: string;
}

/**
 * 提案投票记录
 */
export interface ProposalVoteRecord {
  id: string;
  proposalId: string;
  voterId: string;
  voterName: string;
  voterType: VoteStakeholderType;
  decision: ProposalVoteDecision;
  comment?: string;
  votedAt: number;
  voteWeight: number;
}

/**
 * 提案投票结果
 */
export interface ProposalResult {
  // 三方分别统计
  gameDeveloperVotes: { approve: number; reject: number; abstain: number };
  playerCommunityVotes: { approve: number; reject: number; abstain: number };
  platformVotes: { approve: number; reject: number; abstain: number };
  
  // 加权总分
  weightedApproveScore: number;
  weightedRejectScore: number;
  
  // 参与度
  totalEligibleVoters: number;
  totalVoted: number;
  participationRate: number;
  
  // 最终结果
  finalStatus: ProposalStatus;
  passedAt?: number;
  executedAt?: number;
  executedBy?: string;
}

/**
 * 模拟玩家
 */
export interface SimulatedPlayer {
  id: string;
  name: string;
  type: VoteStakeholderType;
  voteWeight: number;
  gameId?: string;
  hasVetoRight?: boolean;
}

/**
 * 玩家动态指标（用于计算动态投票权重）
 */
export interface PlayerMetrics {
  playerId: string;
  activeDaysLast30: number;
  acoinBalance: number;
  voucherCount: number;
  voteParticipationRate: number;
  gameItemHoldings: { [key: string]: number };
  communityReputation: number;
}

/**
 * 惩罚日志
 */
export interface PenaltyLog {
  id: string;
  gameId: string;
  gameName: string;
  proposalId: string;
  proposalTitle: string;
  penaltyType: PenaltyType;
  description: string;
  durationHours?: number;
  appliedAt: number;
  expiresAt?: number;
  isActive: boolean;
}
