/**
 * A币电子凭证系统 - 预设模板
 * 提供开箱即用的凭证配置模板
 */

import type {
  VoucherTemplate,
  VoucherRules,
  PermissionConfig,
} from './types';
import { PresetTemplateId } from './types';
import { getRuleValue } from '@/services/platformRulesService';

/**
 * 平台通用币模板 (A币标准配置)
 *
 * ⚠️ 模板仅提供业务框架（触发条件、资金来源、限制规则），
 *    具体的发放金额、分配模式等参数由用户在创建绑定时自行配置。
 *    系统不代替用户决定经济参数。
 */
export const PLATFORM_CURRENCY_TEMPLATE: VoucherTemplate = {
  id: PresetTemplateId.PLATFORM_CURRENCY,
  name: '平台通用币',
  description: '适用于平台内流通的虚拟货币，支持游戏奖励、兑换等功能',
  category: 'currency',
  icon: 'coins',
  isDefault: true,
  isSystem: true,
  // 以下为表单默认建议值，用户创建绑定时可自由修改
  defaultDenomination: 0,
  defaultQuantity: 0,
  defaultExpiresDays: undefined,
  presetRules: {
    distribution: [
      {
        id: 'dist-game-reward',
        name: '游戏奖励分发（从奖池）',
        type: 'game_reward',
        enabled: true,
        priority: 1,
        trigger: {
          type: 'event',
          event: 'game_complete',
        },
        // ⚠️ allocation 不预设金额和模式，由用户在创建绑定时配置
        allocation: {},
        limits: {
          maxPerUser: 5000,
          dailyCap: 10000,
          cooldownMinutes: 0,
        },
        source: {
          mode: 'transfer_from_pool',
          poolHolderId: 'SYSTEM', // 从平台账户的奖池转移
        },
      },
      {
        id: 'dist-daily-checkin',
        name: '每日签到奖励（从奖池）',
        type: 'daily_checkin',
        enabled: true,
        priority: 2,
        trigger: {
          type: 'schedule',
          schedule: '0 0 * * *',
        },
        // ⚠️ allocation 不预设金额，由用户在创建绑定时配置
        allocation: {},
        limits: {
          maxPerUser: 50,
          dailyCap: 1000000,
          cooldownMinutes: 1440,
        },
        source: {
          mode: 'transfer_from_pool',
          poolHolderId: 'SYSTEM',
        },
      },
      {
        id: 'dist-referral',
        name: '邀请奖励',
        type: 'referral_bonus',
        enabled: true,
        priority: 3,
        trigger: {
          type: 'event',
          event: 'user_referral',
        },
        // ⚠️ allocation 不预设金额，由用户在创建绑定时配置
        allocation: {},
        limits: {
          maxPerUser: 10000,
          dailyCap: 50000,
        },
      },
    ],
    recycle: [
      {
        id: 'recycle-daily-settlement',
        name: '每日结算回收',
        type: 'daily_settlement',
        enabled: true,
        priority: 1,
        trigger: {
          type: 'schedule',
          schedule: '0 0 * * *',
        },
        recycleLogic: {
          mode: 'percentage',
          // 平台级费率读取规则注册中心（governance 门控修改）
          percentage: getRuleValue('voucher.recycle_daily_pct'),
          destination: 'treasury',
        },
        limits: {
          dailyCap: 100000000,
        },
      },
      {
        id: 'recycle-exchange-fee',
        name: '兑换手续费',
        type: 'exchange_conversion',
        enabled: true,
        priority: 2,
        trigger: {
          type: 'event',
          event: 'exchange_execute',
        },
        recycleLogic: {
          mode: 'percentage',
          // 平台级费率读取规则注册中心（governance 门控修改）
          percentage: getRuleValue('voucher.exchange_fee_pct'),
          destination: 'burn',
        },
        limits: {
          maxPerUser: 10000,
        },
      },
      {
        id: 'recycle-transaction-fee',
        name: '交易手续费',
        type: 'transaction_fee',
        enabled: true,
        priority: 3,
        trigger: {
          type: 'event',
          event: 'voucher_transfer',
        },
        recycleLogic: {
          mode: 'percentage',
          // 平台级费率读取规则注册中心（governance 门控修改）
          percentage: getRuleValue('voucher.transfer_fee_pct'),
          destination: 'platform',
        },
        limits: {},
      },
    ],
    permissions: {
      transfer: {
        enabled: true,
        minAmount: 1,
        maxAmount: 100000,
        dailyLimit: 500000,
        requireVerification: false,
      },
      exchange: {
        enabled: true,
        exchangeRates: [
          {
            targetCurrency: 'GTA_Coin',
            targetSymbol: 'GTA',
            rate: 10,
            fee: 1,
            direction: 'both',
          },
          {
            targetCurrency: 'Minecraft_Diamond',
            targetSymbol: 'DIA',
            rate: 5,
            fee: 0.5,
            direction: 'both',
          },
          {
            targetCurrency: 'Steam_Points',
            targetSymbol: 'SP',
            rate: 100,
            fee: 2,
            direction: 'both',
          },
        ],
        minExchangeAmount: 10,
        dailyLimit: 100000,
        cooldownMinutes: 5,
      },
      freeze: {
        enabled: true,
        roles: ['admin', 'moderator'],
        maxFreezeDuration: 720, // 30天
      },
      destroy: {
        enabled: true,
        roles: ['admin'],
        requireConfirmation: true,
      },
    },
    schedule: {
      issuance: {
        type: 'phased',
        phases: [
          {
            phase: 1,
            name: '创世发行',
            amount: 100000000, // 1亿
            startDate: Date.now(),
          },
          {
            phase: 2,
            name: '生态建设',
            amount: 300000000, // 3亿
            startDate: Date.now() + 30 * 24 * 60 * 60 * 1000, // 30天后
          },
          {
            phase: 3,
            name: '用户激励',
            amount: 400000000, // 4亿
            startDate: Date.now() + 90 * 24 * 60 * 60 * 1000, // 90天后
          },
          {
            phase: 4,
            name: '储备金',
            amount: 200000000, // 2亿
            startDate: Date.now() + 180 * 24 * 60 * 60 * 1000, // 180天后
          },
        ],
      },
    },
  },
  tags: ['currency', 'platform', 'gaming', 'utility'],
  createdAt: Date.now(),
  updatedAt: Date.now(),
  createdBy: 'system',
  usageCount: 0,
};

/**
 * 游戏奖励币模板
 * ⚠️ 框架模板，所有金额参数由用户在创建绑定时配置
 */
export const GAME_REWARD_TEMPLATE: VoucherTemplate = {
  id: PresetTemplateId.GAME_REWARD,
  name: '游戏奖励币',
  description: '专门用于游戏内奖励，根据游戏表现分发',
  category: 'gaming',
  icon: 'trophy',
  isDefault: false,
  isSystem: true,
  defaultDenomination: 0,
  defaultQuantity: 0,
  defaultExpiresDays: 365,
  presetRules: {
    distribution: [
      {
        id: 'dist-game-win',
        name: '游戏胜利奖励',
        type: 'game_reward',
        enabled: true,
        priority: 1,
        trigger: { type: 'event', event: 'game_win' },
        // ⚠️ 用户需在创建绑定时配置分档金额
        allocation: {},
        limits: { maxPerUser: 5000, dailyCap: 20000 },
      },
      {
        id: 'dist-achievement',
        name: '成就解锁奖励',
        type: 'achievement_unlock',
        enabled: true,
        priority: 2,
        trigger: { type: 'event', event: 'achievement_unlock' },
        // ⚠️ 用户需在创建绑定时配置金额
        allocation: {},
        limits: { maxPerUser: 50000 },
      },
    ],
    recycle: [
      {
        id: 'recycle-expiration',
        name: '过期销毁',
        type: 'expiration_burn',
        enabled: true,
        priority: 1,
        trigger: { type: 'condition', condition: 'expired' },
        recycleLogic: { mode: 'percentage', percentage: 100, destination: 'burn' },
        limits: {},
      },
    ],
    permissions: {
      transfer: { enabled: true, minAmount: 1, maxAmount: 10000, dailyLimit: 50000 },
      exchange: {
        enabled: true,
        exchangeRates: [
          { targetCurrency: 'Platform_ACoin', targetSymbol: 'ACOIN', rate: 0.1, fee: 0, direction: 'to_only' },
        ],
        minExchangeAmount: 100,
      },
      freeze: { enabled: true, roles: ['admin'] },
      destroy: { enabled: true, roles: ['admin'], requireConfirmation: true },
    },
  },
  tags: ['gaming', 'rewards', 'achievement'],
  createdAt: Date.now(),
  updatedAt: Date.now(),
  createdBy: 'system',
  usageCount: 0,
};

/**
 * 稳定价值币模板
 */
export const STABLE_VALUE_TEMPLATE: VoucherTemplate = {
  id: PresetTemplateId.STABLE_VALUE,
  name: '稳定价值币',
  description: '锚定固定价值的代币，适合长期持有',
  category: 'stable',
  icon: 'shield',
  isDefault: false,
  isSystem: true,
  defaultDenomination: 0,
  defaultQuantity: 0,
  presetRules: {
    distribution: [
      {
        id: 'dist-manual',
        name: '手动发行',
        type: 'manual_issuance',
        enabled: true,
        priority: 1,
        trigger: { type: 'manual' },
        // ⚠️ 用户需在创建绑定时配置金额
        allocation: {},
        limits: { maxTotal: 10000000 },
      },
    ],
    recycle: [
      {
        id: 'recycle-buyback',
        name: '平台回购',
        type: 'buyback',
        enabled: true,
        priority: 1,
        trigger: { type: 'manual' },
        recycleLogic: { mode: 'percentage', percentage: 100, destination: 'treasury' },
        limits: {},
      },
    ],
    permissions: {
      transfer: { enabled: true, minAmount: 100, maxAmount: 1000000 },
      exchange: { enabled: true, exchangeRates: [], minExchangeAmount: 1000 },
      freeze: { enabled: true, roles: ['admin'] },
      destroy: { enabled: false },
    },
  },
  tags: ['stable', 'value', 'investment'],
  createdAt: Date.now(),
  updatedAt: Date.now(),
  createdBy: 'system',
  usageCount: 0,
};

/**
 * 通缩型代币模板
 */
export const DEFLATIONARY_TEMPLATE: VoucherTemplate = {
  id: PresetTemplateId.DEFLATIONARY,
  name: '通缩型代币',
  description: '随着使用逐渐减少的稀缺性代币，具有升值潜力',
  category: 'deflationary',
  icon: 'flame',
  isDefault: false,
  isSystem: true,
  defaultDenomination: 0,
  defaultQuantity: 0,
  presetRules: {
    distribution: [
      {
        id: 'dist-event',
        name: '特殊事件奖励',
        type: 'event_reward',
        enabled: true,
        priority: 1,
        trigger: { type: 'event', event: 'special_event' },
        // ⚠️ 用户需在创建绑定时配置金额
        allocation: {},
        limits: { maxTotal: 21000000 },
      },
    ],
    recycle: [
      {
        id: 'recycle-tx-fee',
        name: '交易销毁',
        type: 'transaction_fee',
        enabled: true,
        priority: 1,
        trigger: { type: 'event', event: 'voucher_transfer' },
        recycleLogic: {
          mode: 'sliding',
          slidingScale: { threshold: 10000, belowRate: 1, aboveRate: 2 },
          destination: 'burn',
        },
        limits: {},
      },
      {
        id: 'recycle-expiration',
        name: '过期销毁',
        type: 'expiration_burn',
        enabled: true,
        priority: 2,
        trigger: { type: 'condition', condition: 'expired' },
        recycleLogic: { mode: 'percentage', percentage: 100, destination: 'burn' },
        limits: {},
      },
    ],
    permissions: {
      transfer: { enabled: true, minAmount: 1 },
      exchange: { enabled: true, exchangeRates: [], minExchangeAmount: 1 },
      freeze: { enabled: true, roles: ['admin'] },
      destroy: { enabled: true, roles: ['admin'], requireConfirmation: true },
    },
  },
  tags: ['deflationary', 'scarce', 'collectible'],
  createdAt: Date.now(),
  updatedAt: Date.now(),
  createdBy: 'system',
  usageCount: 0,
};

/**
 * 积分系统模板
 */
export const POINTS_SYSTEM_TEMPLATE: VoucherTemplate = {
  id: PresetTemplateId.POINTS_SYSTEM,
  name: '积分系统',
  description: '用于激励用户的积分体系，无上限发行',
  category: 'points',
  icon: 'star',
  isDefault: false,
  isSystem: true,
  defaultDenomination: 0,
  defaultQuantity: 0,
  presetRules: {
    distribution: [
      {
        id: 'dist-task',
        name: '任务完成奖励',
        type: 'task_completion',
        enabled: true,
        priority: 1,
        trigger: { type: 'event', event: 'task_complete' },
        // ⚠️ 用户需在创建绑定时配置金额
        allocation: {},
        limits: { maxPerUser: 1000 },
      },
      {
        id: 'dist-checkin',
        name: '每日签到',
        type: 'daily_checkin',
        enabled: true,
        priority: 2,
        trigger: { type: 'schedule', schedule: '0 0 * * *' },
        // ⚠️ 用户需在创建绑定时配置金额
        allocation: {},
        limits: { cooldownMinutes: 1440 },
      },
      {
        id: 'dist-platform-bonus',
        name: '平台奖励',
        type: 'platform_bonus',
        enabled: true,
        priority: 3,
        trigger: { type: 'event', event: 'platform_event' },
        // ⚠️ 用户需在创建绑定时配置金额
        allocation: {},
        limits: { dailyCap: 1000000 },
      },
    ],
    recycle: [
      {
        id: 'recycle-exchange',
        name: '积分兑换消耗',
        type: 'exchange_conversion',
        enabled: true,
        priority: 1,
        trigger: { type: 'event', event: 'points_redeem' },
        recycleLogic: { mode: 'percentage', percentage: 100, destination: 'burn' },
        limits: {},
      },
      {
        id: 'recycle-expiration',
        name: '年度清零',
        type: 'expiration_burn',
        enabled: true,
        priority: 2,
        trigger: { type: 'schedule', schedule: '0 0 1 1 *' }, // 每年1月1日
        recycleLogic: { mode: 'percentage', percentage: 100, destination: 'burn' },
        limits: {},
      },
    ],
    permissions: {
      transfer: { enabled: false }, // 积分不可转让
      exchange: {
        enabled: true,
        exchangeRates: [
          { targetCurrency: 'Platform_ACoin', targetSymbol: 'ACOIN', rate: 0.01, fee: 0, direction: 'to_only' },
        ],
        minExchangeAmount: 100,
        dailyLimit: 10000,
      },
      freeze: { enabled: true, roles: ['admin'] },
      destroy: { enabled: true, roles: ['admin'] },
    },
  },
  tags: ['points', 'rewards', 'loyalty'],
  createdAt: Date.now(),
  updatedAt: Date.now(),
  createdBy: 'system',
  usageCount: 0,
};

/**
 * 活动门票模板
 */
export const EVENT_TICKET_TEMPLATE: VoucherTemplate = {
  id: PresetTemplateId.EVENT_TICKET,
  name: '活动门票',
  description: '限时活动参与的凭证',
  category: 'event',
  icon: 'ticket',
  isDefault: false,
  isSystem: true,
  defaultDenomination: 0,
  defaultQuantity: 0,
  defaultExpiresDays: 7,
  presetRules: {
    distribution: [
      {
        id: 'dist-event',
        name: '活动参与',
        type: 'event_reward',
        enabled: true,
        priority: 1,
        trigger: { type: 'manual' },
        // ⚠️ 用户需在创建绑定时配置金额
        allocation: {},
        limits: { maxPerUser: 5 },
      },
    ],
    recycle: [
      {
        id: 'recycle-expiration',
        name: '活动结束销毁',
        type: 'expiration_burn',
        enabled: true,
        priority: 1,
        trigger: { type: 'condition', condition: 'expired' },
        recycleLogic: { mode: 'percentage', percentage: 100, destination: 'burn' },
        limits: {},
      },
    ],
    permissions: {
      transfer: { enabled: true, minAmount: 1, maxAmount: 5 },
      exchange: { enabled: false, exchangeRates: [] },
      freeze: { enabled: true, roles: ['admin'] },
      destroy: { enabled: true, roles: ['admin'] },
    },
  },
  tags: ['event', 'ticket', 'limited'],
  createdAt: Date.now(),
  updatedAt: Date.now(),
  createdBy: 'system',
  usageCount: 0,
};

/**
 * 会员凭证模板
 */
export const MEMBERSHIP_TEMPLATE: VoucherTemplate = {
  id: PresetTemplateId.MEMBERSHIP,
  name: '会员凭证',
  description: '平台会员身份凭证，享有专属权益',
  category: 'membership',
  icon: 'crown',
  isDefault: false,
  isSystem: true,
  defaultDenomination: 0,
  defaultQuantity: 0,
  defaultExpiresDays: 365,
  presetRules: {
    distribution: [
      {
        id: 'dist-purchase',
        name: '会员购买',
        type: 'manual_issuance',
        enabled: true,
        priority: 1,
        trigger: { type: 'event', event: 'membership_purchase' },
        // ⚠️ 用户需在创建绑定时配置金额
        allocation: {},
        limits: { maxPerUser: 1 },
      },
    ],
    recycle: [
      {
        id: 'recycle-expiration',
        name: '到期回收',
        type: 'expiration_burn',
        enabled: true,
        priority: 1,
        trigger: { type: 'condition', condition: 'expired' },
        recycleLogic: { mode: 'percentage', percentage: 100, destination: 'burn' },
        limits: {},
      },
    ],
    permissions: {
      transfer: { enabled: false }, // 会员不可转让
      exchange: { enabled: false, exchangeRates: [] },
      freeze: { enabled: true, roles: ['admin'] },
      destroy: { enabled: true, roles: ['admin'] },
    },
  },
  tags: ['membership', 'vip', 'exclusive'],
  createdAt: Date.now(),
  updatedAt: Date.now(),
  createdBy: 'system',
  usageCount: 0,
};

/**
 * 空模板（自定义）
 */
export const CUSTOM_TEMPLATE: VoucherTemplate = {
  id: PresetTemplateId.CUSTOM,
  name: '自定义凭证',
  description: '从零开始配置您的凭证规则',
  category: 'custom',
  icon: 'settings',
  isDefault: false,
  isSystem: true,
  defaultDenomination: 0,
  defaultQuantity: 0,
  presetRules: {
    distribution: [],
    recycle: [],
    permissions: {
      transfer: { enabled: true },
      exchange: { enabled: false, exchangeRates: [] },
      freeze: { enabled: true, roles: ['admin'] },
      destroy: { enabled: true, roles: ['admin'] },
    },
  },
  tags: ['custom', 'diy'],
  createdAt: Date.now(),
  updatedAt: Date.now(),
  createdBy: 'system',
  usageCount: 0,
};

/**
 * 所有预设模板列表
 */
export const ALL_TEMPLATES: VoucherTemplate[] = [
  PLATFORM_CURRENCY_TEMPLATE,
  GAME_REWARD_TEMPLATE,
  STABLE_VALUE_TEMPLATE,
  DEFLATIONARY_TEMPLATE,
  POINTS_SYSTEM_TEMPLATE,
  EVENT_TICKET_TEMPLATE,
  MEMBERSHIP_TEMPLATE,
  CUSTOM_TEMPLATE,
];

/**
 * 根据ID获取模板
 */
export function getTemplateById(id: string): VoucherTemplate | undefined {
  return ALL_TEMPLATES.find(t => t.id === id);
}

/**
 * 获取默认模板
 */
export function getDefaultTemplate(): VoucherTemplate {
  return PLATFORM_CURRENCY_TEMPLATE;
}

/**
 * 获取分类列表
 */
export function getTemplateCategories(): { id: string; name: string }[] {
  return [
    { id: 'all', name: '全部' },
    { id: 'currency', name: '货币' },
    { id: 'gaming', name: '游戏' },
    { id: 'stable', name: '稳定币' },
    { id: 'deflationary', name: '通缩型' },
    { id: 'points', name: '积分' },
    { id: 'event', name: '活动' },
    { id: 'membership', name: '会员' },
    { id: 'custom', name: '自定义' },
  ];
}

/**
 * 获取图标组件名称
 */
export function getTemplateIconName(template: VoucherTemplate): string {
  return template.icon || 'shield';
}

/**
 * 克隆模板并创建自定义版本
 */
export function cloneTemplate(
  template: VoucherTemplate,
  overrides: Partial<VoucherTemplate>
): VoucherTemplate {
  return {
    ...template,
    ...overrides,
    id: `${template.id}_custom_${Date.now()}`,
    isSystem: false,
    isDefault: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    usageCount: 0,
  };
}

/**
 * 合并规则配置
 */
export function mergeRules(
  baseRules: VoucherRules | undefined,
  overrideRules: VoucherRules | undefined
): VoucherRules {
  // 默认权限配置
  const defaultPermissions: PermissionConfig = {
    transfer: { enabled: true },
    exchange: { enabled: false, exchangeRates: [] },
    freeze: { enabled: true, roles: ['admin'] },
    destroy: { enabled: true, roles: ['admin'] },
  };

  return {
    distribution: overrideRules?.distribution ?? baseRules?.distribution ?? [],
    recycle: overrideRules?.recycle ?? baseRules?.recycle ?? [],
    permissions: {
      ...defaultPermissions,
      ...baseRules?.permissions,
      ...overrideRules?.permissions,
      // 确保 exchangeRates 被正确合并
      exchange: {
        ...defaultPermissions.exchange,
        ...baseRules?.permissions?.exchange,
        ...overrideRules?.permissions?.exchange,
        exchangeRates: [
          ...(baseRules?.permissions?.exchange?.exchangeRates ?? []),
          ...(overrideRules?.permissions?.exchange?.exchangeRates ?? []),
        ],
      },
    },
    schedule: {
      ...baseRules?.schedule,
      ...overrideRules?.schedule,
    },
  };
}
