/**
 * M1 GSO 游戏主权/收益权认购合约模板（第 3 档开闸，法务前置）
 *
 * 语义：
 * - 社区用 gameCoins/aCoins 认购游戏方出让的收益分成权（revenueShareBps）
 * - 资金全部进服务端托管；softCap 未达全额自动退款
 * - 达标交割：募资一次性转给发行方 + 按认购比例逐人铸 RSV 收益分成凭证（带锁定期）
 * - 收益结算：由 tick 注入周期可观测收益（revenue_ledger 口径），按 RSV 份额自动分账
 * - 治理：governableTopics 白名单（服务端计票，B5 端点实现）
 *
 * 合规话术（必须随合约展示）：
 * 「平台保证合约按公布的规则执行，不保证任何收益结果。」
 */
import type { ContractTemplate } from '../types.js';

export const GSO_TEMPLATE: ContractTemplate = {
  key: 'gso',
  family: 'community_revenue',
  version: 1,
  title: '游戏收益权认购合约（GSO）',
  description:
    '游戏方出让游戏收益分成权，社区认购；达标自动交割并铸收益分成凭证（RSV，带锁定期），收益按份额自动分账。仅纳入平台可观测收益。' +
    '超额认购规则：全额交割、RSV 按认购金额占比分配；hardCap/perUserCap 先到先得（超额部分不退回、不缩减）。只有游戏发布者可发行。',
  riskLevel: 'high',
  requiresAudit: true, // GSO 必须平台审核（合规前置）
  initialState: 'signing',
  effectsWhitelist: [
    'walletTransfer', 'refundAll', 'mintShareVouchers', 'splitPayout', 'grantGovernanceWeight',
    'setState', 'notify', 'openDispute',
  ],
  governanceTopics: ['ADJUST_PRICE', 'GAME_CONFIG', 'MINT_CURRENCY'],
  paramsSchema: {
    gameId: { type: 'string', required: true, min: 1, description: '标的游戏' },
    issuerId: { type: 'string', required: true, min: 1, description: '出让方（游戏方）' },
    gameName: { type: 'string', required: true, min: 1, max: 60, description: '游戏名' },
    raiseTarget: { type: 'number', required: true, min: 1, description: '募资目标' },
    currency: { type: 'enum', required: true, enumValues: ['gameCoins', 'aCoins'], description: '认购币种' },
    revenueShareBps: { type: 'number', required: true, min: 1, max: 10000, description: '出让收益比例(bps)' },
    governanceShareBps: { type: 'number', required: true, min: 0, max: 10000, description: '出让治理比例(bps)' },
    openAt: { type: 'number', required: true, description: '开售时间' },
    closeAt: { type: 'number', required: true, description: '截止时间' },
    softCap: { type: 'number', required: true, min: 1, description: '最低成筹额' },
    hardCap: { type: 'number', min: 1, description: '上限（超额配售拦截）' },
    perUserCap: { type: 'number', required: true, min: 1, description: '单人认购上限（合规）' },
    coolDownMs: { type: 'number', required: true, min: 0, description: '冷静期' },
    lockupMs: { type: 'number', required: true, min: 0, description: 'RSV 锁定期（防炒作）' },
    revenueSources: {
      type: 'array',
      required: true,
      minItems: 1,
      itemRule: {
        type: 'enum',
        enumValues: ['market_commission', 'content_consume', 'store_sale', 'item_sale'],
      },
      description: '收益来源（仅平台可观测）',
    },
    settlementCron: { type: 'enum', required: true, enumValues: ['weekly', 'monthly'], description: '结算周期' },
    governableTopics: { type: 'array', itemRule: { type: 'string' }, description: '治理白名单' },
    disputeWindowMs: { type: 'number', required: true, min: 0, max: 7 * 24 * 3600 * 1000, description: '交割后挑战窗口' },
  },
  clauses: [
    {
      id: 'gso-subscribe',
      title: '认购：资金进托管',
      on: { id: 't-sub', kind: 'manual', action: 'subscribe', enabledStates: ['signing'] },
      when: 'now >= params.openAt && now <= params.closeAt && sumUser(state.contributions, event.userId, "amount") + event.amount <= params.perUserCap && (params.hardCap == null || state.totalRaised + event.amount <= params.hardCap)',
      then: [
        {
          type: 'walletTransfer',
          toUserId: 'escrow',
          fromUserId: 'expr: event.userId',
          currency: 'expr: params.currency',
          amount: 'expr: event.amount',
          reason: 'GSO 认购资金托管',
        },
      ],
      updates: [
        { field: 'totalRaised', op: 'add', value: 'expr: event.amount' },
        { field: 'contributions', op: 'push', value: 0, userIdExpr: 'event.userId', amountExpr: 'event.amount' },
      ],
    },
    {
      id: 'gso-reach-softcap',
      title: '达到 softCap（公示，不立即交割）',
      on: { id: 't-softcap', kind: 'manual', action: 'subscribe', enabledStates: ['signing'] },
      // +1 约定：同触发内 updates 未应用，用 event.amount 预演本次认购
      when: 'state.totalRaised + event.amount >= params.softCap',
      then: [{ type: 'notify', message: 'expr: "已达成筹目标 " + state.totalRaised + " / " + params.softCap', reason: '达标公示' }],
    },
    {
      id: 'gso-settle',
      title: '截止达标：交割 + 铸 RSV + 授治理权',
      on: { id: 't-settle', kind: 'cron', schedule: 'deadline-check', enabledStates: ['signing'] },
      when: 'now > params.closeAt && state.totalRaised >= params.softCap',
      then: [
        {
          type: 'walletTransfer',
          toUserId: 'expr: params.issuerId',
          currency: 'expr: params.currency',
          amount: 'expr: state.totalRaised',
          reason: 'GSO 募资交割',
        },
        {
          type: 'mintShareVouchers',
          currency: 'expr: params.currency',
          table: { kind: 'byField', stateField: 'contributions', amountField: 'amount' },
          lockupMs: 'expr: params.lockupMs',
          reason: '铸收益分成凭证（RSV）',
        },
        {
          type: 'grantGovernanceWeight',
          gameId: 'expr: params.gameId',
          toUserId: 'expr: params.issuerId',
          topic: 'ALL',
          weightBps: 'expr: 10000 - params.governanceShareBps',
          reason: '发行方保留治理权',
        },
        { type: 'setState', to: 'active', reason: '交割完成，收益分成生效' },
      ],
    },
    {
      id: 'gso-refund',
      title: '截止未达标：全额自动退款',
      on: { id: 't-refund', kind: 'cron', schedule: 'deadline-check', enabledStates: ['signing'] },
      when: 'now > params.closeAt && state.totalRaised < params.softCap',
      then: [{ type: 'refundAll', reason: '未达 softCap 全额自动退款' }, { type: 'setState', to: 'refunded', reason: '募资失败' }],
    },
    {
      id: 'gso-revenue-weekly',
      title: '周度收益分成（tick 注入 revenue_ledger 口径）',
      description: 'event.periodRevenue 由服务端从收益台账查询注入，合约按 RSV 份额分账；仅 settlementCron=weekly 生效。',
      on: { id: 't-revenue-w', kind: 'cron', schedule: 'settlement-weekly', enabledStates: ['active'] },
      when: 'event.periodRevenue > 0 && params.settlementCron == "weekly"',
      then: [
        {
          type: 'splitPayout',
          currency: 'expr: params.currency',
          table: {
            kind: 'byField',
            stateField: 'contributions',
            amountField: 'amount',
            mode: 'share',
            poolAmount: 'expr: event.periodRevenue * params.revenueShareBps / 10000',
          },
          reason: 'GSO 周度收益分成',
          source: 'treasury',
        },
      ],
    },
    {
      id: 'gso-revenue-monthly',
      title: '月度收益分成（tick 注入 revenue_ledger 口径）',
      on: { id: 't-revenue-m', kind: 'cron', schedule: 'settlement-monthly', enabledStates: ['active'] },
      when: 'event.periodRevenue > 0 && params.settlementCron == "monthly"',
      then: [
        {
          type: 'splitPayout',
          currency: 'expr: params.currency',
          table: {
            kind: 'byField',
            stateField: 'contributions',
            amountField: 'amount',
            mode: 'share',
            poolAmount: 'expr: event.periodRevenue * params.revenueShareBps / 10000',
          },
          reason: 'GSO 月度收益分成',
          source: 'treasury',
        },
      ],
    },
    {
      id: 'gso-game-delisted',
      title: '退场条款：游戏下架/停运',
      description: '托管余额（如有）按份额退还；已交割收益不追回；RSV 终止分账。',
      on: { id: 't-delist', kind: 'manual', action: 'game-delisted', enabledStates: ['signing', 'active', 'settling'] },
      when: 'true',
      then: [
        { type: 'refundAll', reason: '游戏下架，托管余额按认购比例退还' },
        { type: 'setState', to: 'terminated', reason: '标的游戏下架，合约终止' },
      ],
    },
    {
      id: 'gso-dispute',
      title: '发起挑战',
      on: { id: 't-dispute', kind: 'manual', action: 'dispute', enabledStates: ['active', 'settling'] },
      when: 'true',
      then: [
        { type: 'openDispute', byUserId: 'expr: event.userId', reason: 'expr: event.reason' },
        { type: 'setState', to: 'disputed', reason: 'expr: "挑战人:" + event.userId' },
      ],
    },
  ],
};
