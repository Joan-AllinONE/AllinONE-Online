/**
 * M2 TeamQuest 组团任务合约模板（第 2 档开闸）
 *
 * 语义：
 * - 团员缴保证金入托管；发起人注入奖池
 * - 任务进度走 protocol 事件（**强制 channelToken**——违约判定事实源）
 * - 截止自动结算：奖池按贡献占比分配 + 保证金全退（中途退出者已按违约条款罚没）
 * - 整体未成团自动退款
 */
import type { ContractTemplate } from '../types.js';

export const TEAM_QUEST_TEMPLATE: ContractTemplate = {
  key: 'team-quest',
  family: 'teamup',
  version: 1,
  title: '组团任务合约',
  description:
    '发起人自动入团；达最低人数即开团，达最高人数后封团。团员缴保证金入托管、发起人注入奖池；贡献点数按合约写明的规则确定（游戏事件/团长代报）；截止自动结算：先抽团长管理费（比例可选），余下奖池按贡献占比分配 + 保证金全退；未成团或未注资自动退款。',
  riskLevel: 'medium',
  requiresAudit: false,
  initialState: 'signing',
  effectsWhitelist: ['walletTransfer', 'splitPayout', 'refundAll', 'penalize', 'setState', 'notify', 'openDispute'],
  governanceTopics: [],
  paramsSchema: {
    questId: { type: 'string', required: true, min: 1, description: '关联任务' },
    gameId: { type: 'string', description: '关联游戏（可选）' },
    initiatorId: { type: 'string', required: true, min: 1, description: '团长' },
    questTitle: { type: 'string', required: true, min: 1, max: 60, description: '任务标题' },
    minMembers: { type: 'number', required: true, min: 2, max: 100, description: '最低开团人数' },
    maxMembers: { type: 'number', required: true, min: 2, max: 100, description: '人数上限' },
    recruitmentDeadline: { type: 'number', required: true, description: '招募截止' },
    taskDeadline: { type: 'number', required: true, description: '任务截止' },
    rewardPool: {
      type: 'object',
      required: true,
      fields: {
        amount: { type: 'number', required: true, min: 0, description: '奖池金额（0=无奖池，仅保证金返还）' },
        currency: { type: 'enum', required: true, enumValues: ['gameCoins', 'aCoins'], description: '币种' },
      },
    },
    memberBond: { type: 'number', required: true, min: 0, description: '团员保证金（0=免保证金）' },
    earlyExitBps: { type: 'number', required: true, min: 0, max: 10000, description: '中途退出罚没比例(bps)' },
    leaderFeeBps: { type: 'number', required: true, min: 0, max: 5000, description: '团长管理费(bps)：结算时先从奖池抽取给团长，其余按贡献分配' },
    contributionRule: { type: 'string', required: true, min: 1, max: 200, description: '贡献点数确定规则（结算依据，须在合约中写明）' },
    protocolEvent: { type: 'string', required: true, min: 1, description: '贡献事件名（GAME_EVENT:XXX）' },
    disputeWindowMs: { type: 'number', required: true, min: 0, max: 7 * 24 * 3600 * 1000, description: '结算后挑战窗口' },
  },
  clauses: [
    {
      id: 'tq-join',
      title: '加入团队：保证金进托管（2026-10-20 修正：按最高人数封团）',
      description: '招募期与任务进行中均可加入，人数达到最高成团人数后封团（发起人自动计入）。',
      on: { id: 't-join', kind: 'manual', action: 'join', enabledStates: ['signing', 'active'] },
      when: 'now <= params.recruitmentDeadline && state.memberCount < params.maxMembers && countUser(state.contributions, event.userId) < 1',
      then: [
        {
          type: 'walletTransfer',
          toUserId: 'escrow',
          fromUserId: 'expr: event.userId',
          currency: 'expr: params.rewardPool.currency',
          amount: 'expr: params.memberBond',
          purpose: 'bond',
          reason: '团员保证金托管',
        },
      ],
      updates: [
        { field: 'memberCount', op: 'add', value: 1 },
        { field: 'contributions', op: 'push', value: 0, userIdExpr: 'event.userId', amountExpr: '0' },
      ],
    },
    {
      id: 'tq-reach-quorum',
      title: '达到最低人数 → 开团',
      on: { id: 't-quorum', kind: 'manual', action: 'join', enabledStates: ['signing'] },
      // +1 约定：同触发内 updates 在全部条款评估后才应用
      when: 'state.memberCount + 1 >= params.minMembers',
      then: [{ type: 'setState', to: 'active', reason: '达到最低开团人数' }],
    },
    {
      id: 'tq-manual-open',
      title: '团长手动成团（🆕 2026-10-20）',
      description: '人数已达最低开团人数后，团长可不等招募截止，提前手动开团（进入 active 后即可注入奖池并开始上报贡献）。',
      on: { id: 't-manual-open', kind: 'manual', action: 'open-team', enabledStates: ['signing'] },
      when: 'state.memberCount >= params.minMembers',
      then: [{ type: 'setState', to: 'active', reason: 'expr: "团长手动成团，当前 " + state.memberCount + " 人"' }],
    },
    {
      id: 'tq-fund-pool',
      title: '团长注入奖池',
      on: { id: 't-fund', kind: 'manual', action: 'fund-pool', enabledStates: ['active'] },
      when: 'params.rewardPool.amount > 0 && !state.poolFunded',
      then: [
        {
          type: 'walletTransfer',
          toUserId: 'escrow',
          fromUserId: 'expr: params.initiatorId',
          currency: 'expr: params.rewardPool.currency',
          amount: 'expr: params.rewardPool.amount',
          purpose: 'pool',
          reason: '团长注入奖池',
        },
      ],
      updates: [{ field: 'poolFunded', op: 'set', value: 1 }],
    },
    {
      id: 'tq-progress',
      title: '任务进度上报（强制 channelToken）',
      description: '违约/分配判定的事实源：缺失或无效 channelToken 的协议事件一律拒绝。',
      on: {
        id: 't-progress',
        kind: 'protocol',
        match: 'GAME_EVENT:*',
        requiresChannelToken: true,
        enabledStates: ['active'],
      },
      when: 'event.points != null',
      then: [{ type: 'notify', message: 'expr: "贡献+[" + event.points + "]" + event.userId', reason: '贡献记录' }],
      updates: [
        { field: 'score', op: 'add', value: 'expr: event.points' },
        { field: 'contributions', op: 'push', value: 0, userIdExpr: 'event.userId', amountExpr: 'event.points' },
      ],
    },
    {
      id: 'tq-leave',
      title: '中途退出 → 按约罚没',
      on: { id: 't-leave', kind: 'manual', action: 'leave', enabledStates: ['signing', 'active'] },
      when: 'params.earlyExitBps > 0',
      then: [
        {
          type: 'penalize',
          userId: 'expr: event.userId',
          currency: 'expr: params.rewardPool.currency',
          amount: 'expr: params.memberBond * params.earlyExitBps / 10000',
          forfeitTo: 'treasury',
          purpose: 'bond',
          reason: '中途退出违约罚没',
        },
        {
          type: 'walletTransfer',
          toUserId: 'expr: event.userId',
          currency: 'expr: params.rewardPool.currency',
          amount: 'expr: params.memberBond * (10000 - params.earlyExitBps) / 10000',
          purpose: 'bond',
          reason: '保证金剩余退还',
        },
      ],
      updates: [{ field: 'memberCount', op: 'add', value: -1 }],
    },
    {
      id: 'tq-settle',
      title: '截止自动结算：先抽团长管理费，余下奖池按贡献分配 + 保证金退还',
      description: '结算顺序（2026-10-18）：① 团长管理费 = 奖池 × leaderFeeBps/10000 划给团长；② 剩余奖池按贡献占比分配；③ 保证金全额退还。管理费在分配前抽取，团员分配基数=奖池×(1-管理费率)。',
      on: { id: 't-settle', kind: 'cron', schedule: 'deadline-check', enabledStates: ['active'] },
      // 🆕 注资守卫：奖池未注入（poolFunded≠1 且 amount>0）时不结算，避免 splitPayout 从空托管转出 → 死信卡死保证金
      when: 'now > params.taskDeadline && state.memberCount >= params.minMembers && state.score > 0 && (params.rewardPool.amount == 0 || state.poolFunded == 1)',
      then: [
        {
          type: 'walletTransfer',
          toUserId: 'expr: params.initiatorId',
          fromUserId: 'escrow',
          currency: 'expr: params.rewardPool.currency',
          amount: 'expr: params.rewardPool.amount * params.leaderFeeBps / 10000',
          purpose: 'pool',
          reason: '团长管理费（按约抽取）',
        },
        {
          type: 'splitPayout',
          currency: 'expr: params.rewardPool.currency',
          table: {
            kind: 'byField',
            stateField: 'contributions',
            amountField: 'amount',
            mode: 'share',
            poolAmount: 'expr: params.rewardPool.amount * (10000 - params.leaderFeeBps) / 10000',
          },
          purpose: 'pool',
          reason: '剩余奖池按贡献占比分配',
        },
        { type: 'refundAll', purpose: 'bond', reason: '任务完成，保证金全额退还' },
        { type: 'setState', to: 'settling', reason: '结算完成，进入挑战窗口' },
      ],
    },
    {
      id: 'tq-settle-empty',
      title: '零贡献结算：奖池退回发起人 + 保证金退还',
      description: 'B-24 兜底：全部成员零贡献时无分配对象，奖池原路退回，避免资金卡死托管。',
      on: { id: 't-settle-empty', kind: 'cron', schedule: 'deadline-check', enabledStates: ['active'] },
      // 🆕 同 tq-settle：注资守卫（零贡献退发起人奖池也需托管里真有钱）
      when: 'now > params.taskDeadline && state.memberCount >= params.minMembers && state.score <= 0 && (params.rewardPool.amount == 0 || state.poolFunded == 1)',
      then: [
        {
          type: 'walletTransfer',
          toUserId: 'expr: params.initiatorId',
          currency: 'expr: params.rewardPool.currency',
          amount: 'expr: params.rewardPool.amount',
          purpose: 'pool',
          reason: '零贡献，奖池退回发起人',
        },
        { type: 'refundAll', purpose: 'bond', reason: '任务零贡献，保证金全额退还' },
        { type: 'setState', to: 'settling', reason: '结算完成，进入挑战窗口' },
      ],
    },
    {
      id: 'tq-refund',
      title: '未成团自动退款',
      on: { id: 't-refund', kind: 'cron', schedule: 'deadline-check', enabledStates: ['signing'] },
      when: 'now > params.recruitmentDeadline && state.memberCount < params.minMembers',
      then: [{ type: 'refundAll', purpose: 'bond', reason: '未成团全额自动退款' }, { type: 'setState', to: 'refunded', reason: '未成团' }],
    },
    {
      id: 'tq-settle-unfunded',
      title: '截止未注资兜底：保证金退还（2026-10-10 审查新增）',
      description: '人数达标但团长始终未注入奖池——tq-settle/tq-settle-empty 因注资守卫不触发，若缺此条款保证金将永久卡死托管。',
      on: { id: 't-settle-unfunded', kind: 'cron', schedule: 'deadline-check', enabledStates: ['active'] },
      when: 'now > params.taskDeadline && state.memberCount >= params.minMembers && params.rewardPool.amount > 0 && state.poolFunded != 1',
      then: [
        { type: 'refundAll', purpose: 'bond', reason: '奖池未注入，保证金全额退还' },
        { type: 'setState', to: 'settling', reason: '未注资兜底结算，进入挑战窗口' },
      ],
    },
    {
      id: 'tq-settle-understaffed',
      title: '截止人数不足兜底：奖池退发起人 + 保证金退还（2026-10-10 审查新增）',
      description: 'active 状态中途退出致人数低于 minMembers 时，tq-settle（要求≥min）与 tq-refund（仅 signing）均不覆盖——若缺此条款托管资金永久卡死。refundAll(pool) 按出资人原路退回（=发起人），未注资则无条目自然空操作。',
      on: { id: 't-settle-understaffed', kind: 'cron', schedule: 'deadline-check', enabledStates: ['active'] },
      when: 'now > params.taskDeadline && state.memberCount < params.minMembers',
      then: [
        { type: 'refundAll', purpose: 'pool', reason: '人数不足，奖池按出资人原路退回' },
        { type: 'refundAll', purpose: 'bond', reason: '人数不足，保证金全额退还' },
        { type: 'setState', to: 'settling', reason: '人数不足兜底结算，进入挑战窗口' },
      ],
    },
    {
      id: 'tq-confirm',
      title: '挑战窗口结束 → 终局',
      on: { id: 't-confirm', kind: 'cron', schedule: 'deadline-check', enabledStates: ['settling'] },
      when: 'now > params.taskDeadline + params.disputeWindowMs',
      then: [{ type: 'setState', to: 'fulfilled', reason: '挑战窗口结束，合约终局' }],
    },
    {
      id: 'tq-dispute',
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
