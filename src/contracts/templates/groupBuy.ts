/**
 * M3 GroupBuy 拼团合约模板（第 1 档开闸）
 *
 * 语义：
 * - 参与者付款进托管（escrow），服务端资金台账为准
 * - 满员即成团交割给发起人；或到截止时达标交割 / 未达标全额自动退款
 * - disputeWindowMs 内可挑战（冻结，进仲裁）
 *
 * 交割对象 = params.initiatorId（发起人即收款与履约方；平台做托管保证）。
 */
import type { ContractTemplate } from '../types.js';

export const GROUP_BUY_TEMPLATE: ContractTemplate = {
  key: 'group-buy',
  family: 'teamup',
  version: 1,
  title: '拼团合约',
  description:
    'N 人成团享团购价；满员或到期达标自动交割给发起人，未达标全额自动退款。资金全程服务端托管。',
  riskLevel: 'low',
  requiresAudit: false,
  initialState: 'signing',
  effectsWhitelist: ['walletTransfer', 'refundAll', 'setState', 'notify', 'openDispute'],
  governanceTopics: [],
  paramsSchema: {
    gameId: { type: 'string', description: '关联游戏（可选）' },
    skuId: { type: 'string', description: '商品标识（可选）' },
    itemTitle: { type: 'string', required: true, min: 1, max: 50, description: '拼团商品名' },
    initiatorId: { type: 'string', required: true, min: 1, description: '发起人（收款与履约方）' },
    unitPrice: { type: 'number', required: true, min: 1, description: '单买对照价' },
    groupPrice: { type: 'number', required: true, min: 1, description: '成团单价' },
    minMembers: { type: 'number', required: true, min: 2, max: 500, description: '最低成团人数' },
    maxMembers: { type: 'number', required: true, min: 2, max: 500, description: '人数上限' },
    openAt: { type: 'number', required: true, description: '开团时间戳' },
    closeAt: { type: 'number', required: true, description: '截团时间戳' },
    currency: { type: 'enum', required: true, enumValues: ['gameCoins', 'aCoins'], description: '结算币种' },
    perUserLimit: { type: 'number', required: true, min: 1, description: '每人限购份数' },
    disputeWindowMs: { type: 'number', required: true, min: 0, max: 7 * 24 * 3600 * 1000, description: '交割后挑战窗口' },
  },
  clauses: [
    {
      id: 'gb-join',
      title: '加入拼团：货款进托管',
      description: '成员按成团价付款，资金由平台托管账户锁定；事件链记录每笔出资。',
      on: { id: 't-join', kind: 'manual', action: 'join', enabledStates: ['signing'] },
      when: 'now <= params.closeAt && state.memberCount < params.maxMembers && countUser(state.contributions, event.userId) < params.perUserLimit',
      then: [
        {
          type: 'walletTransfer',
          toUserId: 'escrow',
          fromUserId: 'expr: event.userId',
          currency: 'expr: params.currency',
          amount: 'expr: params.groupPrice',
          purpose: 'payment',
          reason: '拼团货款托管',
        },
      ],
      updates: [
        { field: 'memberCount', op: 'add', value: 1 },
        { field: 'contributions', op: 'push', value: 0, userIdExpr: 'event.userId', amountExpr: 'params.groupPrice' },
      ],
    },
    {
      id: 'gb-reach-max',
      title: '满员即成团交割',
      on: { id: 't-reach-max', kind: 'manual', action: 'join', enabledStates: ['signing'] },
      // 注意：同一触发事件内 updates 在全部条款评估后才应用，join 类判定用 +1 模拟本次加入后
      when: 'state.memberCount + 1 >= params.maxMembers',
      then: [
        {
          type: 'walletTransfer',
          toUserId: 'expr: params.initiatorId',
          currency: 'expr: params.currency',
          amount: 'expr: (state.memberCount + 1) * params.groupPrice',
          purpose: 'payment',
          reason: '满员成团交割',
        },
        { type: 'setState', to: 'settling', reason: '成团交割，进入挑战窗口' },
      ],
    },
    {
      id: 'gb-settle-signing',
      title: '到期达标交割（未满员）',
      on: { id: 't-settle-signing', kind: 'cron', schedule: 'deadline-check', enabledStates: ['signing'] },
      when: 'now > params.closeAt && state.memberCount >= params.minMembers && state.memberCount < params.maxMembers',
      then: [
        {
          type: 'walletTransfer',
          toUserId: 'expr: params.initiatorId',
          currency: 'expr: params.currency',
          amount: 'expr: state.memberCount * params.groupPrice',
          purpose: 'payment',
          reason: '到期达标交割',
        },
        { type: 'setState', to: 'settling', reason: '交割完成，进入挑战窗口' },
      ],
    },
    {
      id: 'gb-refund',
      title: '到期未成团全额自动退款',
      on: { id: 't-refund', kind: 'cron', schedule: 'deadline-check', enabledStates: ['signing'] },
      when: 'now > params.closeAt && state.memberCount < params.minMembers',
      then: [{ type: 'refundAll', purpose: 'payment', reason: '流团全额自动退款' }, { type: 'setState', to: 'refunded', reason: '流团' }],
    },
    {
      id: 'gb-confirm',
      title: '挑战窗口结束 → 终局',
      on: { id: 't-confirm', kind: 'cron', schedule: 'deadline-check', enabledStates: ['settling'] },
      when: 'now > params.closeAt + params.disputeWindowMs',
      then: [{ type: 'setState', to: 'fulfilled', reason: '挑战窗口结束，合约终局' }],
    },
    {
      id: 'gb-dispute',
      title: '发起挑战',
      on: { id: 't-dispute', kind: 'manual', action: 'dispute', enabledStates: ['settling', 'active'] },
      when: 'true',
      then: [
        { type: 'openDispute', byUserId: 'expr: event.userId', reason: 'expr: event.reason' },
        { type: 'setState', to: 'disputed', reason: 'expr: "挑战人:" + event.userId' },
      ],
    },
  ],
};
