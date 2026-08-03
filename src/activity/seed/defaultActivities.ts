import { ActivityDef } from '../types';

/**
 * 默认活动种子数据（前端离线兜底 + 与后端 memoryDatabase 默认一致）
 * 所有奖励统一为游戏币（coin），不使用活动积分。
 */
export const defaultActivities: ActivityDef[] = [
  // ===== 每日签到 =====
  {
    id: 'activity-1001',
    type: 'daily_checkin',
    title: '每日签到',
    description: '每天登录签到即可领取游戏币，连续签到第 7 天有大奖！',
    icon: 'gift',
    status: 'active',
    conditions: { event: 'daily.login', target: 1 },
    rewards: [
      { kind: 'gameCoins', amount: 10 },
      { kind: 'gameCoins', amount: 10 },
      { kind: 'gameCoins', amount: 15 },
      { kind: 'gameCoins', amount: 15 },
      { kind: 'gameCoins', amount: 20 },
      { kind: 'gameCoins', amount: 20 },
      { kind: 'gameCoins', amount: 50 },
    ],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },

  // ===== 新手引导 =====
  {
    id: 'activity-2001',
    type: 'onboarding',
    title: '首次发布游戏',
    description: '完成你的第一个游戏发布，奖励 100 游戏币。',
    icon: 'rocket',
    status: 'active',
    conditions: { event: 'game.published', target: 1 },
    rewards: [{ kind: 'gameCoins', amount: 100 }],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
  {
    id: 'activity-2002',
    type: 'onboarding',
    title: '参与首次投票',
    description: '在任意提案中投出你的第一票，奖励 50 游戏币。',
    icon: 'vote',
    status: 'active',
    conditions: { event: 'vote.cast', target: 1 },
    rewards: [{ kind: 'gameCoins', amount: 50 }],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },

  // ===== 成长任务 =====
  {
    id: 'activity-2003',
    type: 'growth',
    title: '畅玩游戏',
    description: '累计游玩 3 局游戏，奖励 30 游戏币。',
    icon: 'gamepad',
    status: 'active',
    conditions: { event: 'game.played', target: 3 },
    rewards: [{ kind: 'gameCoins', amount: 30 }],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
  {
    id: 'activity-2004',
    type: 'growth',
    title: '发布达人',
    description: '累计发布 3 款游戏，奖励 200 游戏币。',
    icon: 'trophy',
    status: 'active',
    conditions: { event: 'game.published', target: 3 },
    rewards: [{ kind: 'gameCoins', amount: 200 }],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },

  // ===== 邀请好友 =====
  {
    id: 'activity-3001',
    type: 'invite',
    title: '邀请好友得游戏币',
    description: '分享专属邀请链接，每成功邀请 1 位好友注册得 20 游戏币。',
    icon: 'users',
    status: 'active',
    conditions: { event: 'user.registered', target: 999 },
    invite: {
      rewardPerInvitee: { kind: 'gameCoins', amount: 20 },
    },
    rewards: [{ kind: 'gameCoins', amount: 20 }],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },

  // ===== 成就 =====
  {
    id: 'activity-4001',
    type: 'achievement',
    title: '活跃玩家',
    description: '累计游玩 10 局游戏，解锁成就奖励 200 游戏币。',
    icon: 'star',
    status: 'active',
    conditions: { event: 'game.played', target: 10 },
    rewards: [{ kind: 'gameCoins', amount: 200 }],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },

  // ===== 限时活动 =====
  {
    id: 'activity-5001',
    type: 'limited_event',
    title: '登录有礼',
    description: '活动期间每日登录即可领取 15 游戏币（限时 7 天）。',
    icon: 'calendar',
    status: 'active',
    startTime: Date.now(),
    endTime: Date.now() + 7 * 24 * 60 * 60 * 1000,
    conditions: { event: 'daily.login', target: 1 },
    rewards: [{ kind: 'gameCoins', amount: 15 }],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },

  // ===== 抽奖 =====
  {
    id: 'activity-6001',
    type: 'lottery',
    title: '幸运大转盘',
    description: '每次抽奖消耗 10 游戏币，有机会赢取 500 游戏币大奖！',
    icon: 'dice',
    status: 'active',
    conditions: { event: 'daily.login', target: 1 },
    lottery: {
      cost: 10,
      prizes: [
        { reward: { kind: 'gameCoins', amount: 500 }, weight: 1, label: '500 游戏币' },
        { reward: { kind: 'gameCoins', amount: 100 }, weight: 5, label: '100 游戏币' },
        { reward: { kind: 'gameCoins', amount: 50 }, weight: 14, label: '50 游戏币' },
        { reward: { kind: 'gameCoins', amount: 20 }, weight: 30, label: '20 游戏币' },
        { reward: { kind: 'gameCoins', amount: 10 }, weight: 50, label: '10 游戏币' },
      ],
    },
    rewards: [{ kind: 'gameCoins', amount: 10 }],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
];
