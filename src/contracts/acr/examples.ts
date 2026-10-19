/**
 * 合约工坊操作指南示例模板（CW-2/4 补充）
 *
 * 纯数据、零依赖（ACR 域内铁律）。单测（acrLinter.test.ts）断言每个示例
 * 必须通过 validateUgcTemplate —— 保证指南中的示例永远合规、可直接载入编辑器提交。
 * 页面：src/pages/ContractWorkshop.tsx（「④ 模板示例」章节一键载入）。
 */
export interface GuideExample {
  name: string;
  risk: string;
  points: string[];
  tpl: Record<string, unknown>;
}

export const GUIDE_EXAMPLES: GuideExample[] = [
  {
    name: '示例 A · 到期退款托管',
    risk: 'medium · 自动过审',
    points: [
      '成员通过 join 动作缴款进托管（fromUserId=event.userId，toUserId=escrow）',
      'cron deadline-check 到期未成交 → refundAll 全额原路退款 → setState refunded 终局',
      'params 必含 initiatorId:string（部署时强校验=登录人）、amount:number、deadline:number（毫秒时间戳）',
      '给 AI 的一句话："做一个 xx 人缴款进托管，到期自动全额退款的合约"',
    ],
    tpl: {
      key: 'ugc_demo_escrow_refund',
      family: 'teamup',
      version: 1,
      title: '到期退款托管',
      description: '成员缴款进托管，到期全额自动退款',
      riskLevel: 'medium',
      requiresAudit: false,
      initialState: 'signing',
      effectsWhitelist: ['walletTransfer', 'refundAll', 'setState', 'notify'],
      paramsSchema: {
        initiatorId: { type: 'string', required: true, min: 1, description: '发起人（部署时必须=登录人）' },
        amount: { type: 'number', required: true, min: 1, description: '每人缴款额' },
        deadline: { type: 'number', required: true, description: '截止时间戳（毫秒）' },
      },
      clauses: [
        {
          id: 'c-join',
          title: '缴款进托管',
          on: { id: 't-join', kind: 'manual', action: 'join', enabledStates: ['signing'] },
          when: 'now <= params.deadline',
          then: [
            { type: 'walletTransfer', toUserId: 'escrow', fromUserId: 'expr: event.userId', currency: 'gameCoins', amount: 'expr: params.amount', reason: '缴款进托管' },
          ],
          updates: [{ field: 'memberCount', op: 'add', value: 1 }],
        },
        {
          id: 'c-refund',
          title: '到期全额退款',
          on: { id: 't-refund', kind: 'cron', schedule: 'deadline-check', enabledStates: ['signing'] },
          when: 'now > params.deadline',
          then: [
            { type: 'refundAll', reason: '到期全额退款' },
            { type: 'setState', to: 'refunded', reason: '到期终局' },
          ],
        },
      ],
    },
  },
  {
    name: '示例 B · 打卡分奖池',
    risk: 'medium · 自动过审',
    points: [
      '发起人通过 fund-pool 注入奖池（fromUserId=params.initiatorId，扣发起人自己的钱），poolFunded 置 1 防重复注入',
      '成员 join 缴入场费进托管，同时 push 贡献记录（contributions）',
      '到期 cron：已注资且人数达标 → splitPayout byField 按贡献占比分奖池（share 模式）→ 进 settling；未注资 → refundAll 退款',
      'settling → fulfilled 收尾条款（状态机 signing→settling→fulfilled 逐级迁移）',
      '给 AI 的一句话："做一个发起人注奖池、成员缴入场费、到期按入场均分奖池、未注资全额退款的合约"',
    ],
    tpl: {
      key: 'ugc_demo_pool_split',
      family: 'teamup',
      version: 1,
      title: '打卡分奖池',
      description: '发起人注入奖池，成员缴入场费，到期按贡献均分奖池；未注资全额退款',
      riskLevel: 'medium',
      requiresAudit: false,
      initialState: 'signing',
      effectsWhitelist: ['walletTransfer', 'splitPayout', 'refundAll', 'setState', 'notify'],
      paramsSchema: {
        initiatorId: { type: 'string', required: true, min: 1, description: '发起人（奖池出资人，部署时必须=登录人）' },
        rewardPool: { type: 'number', required: true, min: 1, description: '奖池金额' },
        entryFee: { type: 'number', required: true, min: 1, description: '每人入场费' },
        minMembers: { type: 'number', required: true, min: 1, description: '最低开团人数' },
        deadline: { type: 'number', required: true, description: '截止时间戳（毫秒）' },
      },
      clauses: [
        {
          id: 'c-fund',
          title: '发起人注入奖池',
          on: { id: 't-fund', kind: 'manual', action: 'fund-pool', enabledStates: ['signing'] },
          when: 'state.poolFunded < 1',
          then: [
            { type: 'walletTransfer', toUserId: 'escrow', fromUserId: 'expr: params.initiatorId', currency: 'gameCoins', amount: 'expr: params.rewardPool', purpose: 'pool', reason: '奖池注入' },
          ],
          updates: [
            { field: 'poolFunded', op: 'set', value: 1 },
            { field: 'totalPool', op: 'set', value: 'expr: params.rewardPool' },
          ],
        },
        {
          id: 'c-join',
          title: '成员缴入场费',
          on: { id: 't-join', kind: 'manual', action: 'join', enabledStates: ['signing'] },
          when: 'now <= params.deadline',
          then: [
            { type: 'walletTransfer', toUserId: 'escrow', fromUserId: 'expr: event.userId', currency: 'gameCoins', amount: 'expr: params.entryFee', reason: '入场费托管' },
          ],
          updates: [
            { field: 'memberCount', op: 'add', value: 1 },
            { field: 'contributions', op: 'push', value: 0, userIdExpr: 'event.userId', amountExpr: 'params.entryFee' },
          ],
        },
        {
          id: 'c-settle',
          title: '到期按贡献分奖池',
          on: { id: 't-settle', kind: 'cron', schedule: 'deadline-check', enabledStates: ['signing'] },
          when: 'now > params.deadline && state.poolFunded >= 1 && state.memberCount >= params.minMembers',
          then: [
            {
              type: 'splitPayout',
              currency: 'gameCoins',
              table: { kind: 'byField', stateField: 'contributions', amountField: 'amount', mode: 'share', poolAmount: 'expr: state.totalPool' },
              purpose: 'pool',
              reason: '奖池按贡献分配',
            },
            { type: 'setState', to: 'settling', reason: '分配完成，进入挑战窗口' },
          ],
        },
        {
          id: 'c-settle-unfunded',
          title: '到期未注资兜底退款',
          on: { id: 't-unfunded', kind: 'cron', schedule: 'deadline-check', enabledStates: ['signing'] },
          when: 'now > params.deadline && state.poolFunded < 1',
          then: [
            { type: 'refundAll', reason: '奖池未注入，入场费全额退还' },
            { type: 'setState', to: 'refunded', reason: '未注资终局' },
          ],
        },
        {
          id: 'c-final',
          title: '挑战窗口结束终局',
          on: { id: 't-final', kind: 'cron', schedule: 'deadline-check', enabledStates: ['settling'] },
          when: 'true',
          then: [{ type: 'setState', to: 'fulfilled', reason: '合约终局' }],
        },
      ],
    },
  },
];
