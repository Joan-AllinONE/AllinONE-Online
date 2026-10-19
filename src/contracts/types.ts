/**
 * AllinONE 合约模块 · 纯类型定义（零依赖）
 *
 * 铁律（由 scripts/check-contracts-isolation.cjs 机器验证）：
 * - 本文件与 engine/ 不得 import 任何项目内其他模块或第三方包
 * - 本模块必须可整体复制到其他项目独立编译
 */

// ============================================================
// 家族 / 模板
// ============================================================

/** 合约族：社区收益（GSO）/ 组团（TeamQuest、GroupBuy） */
export type ContractFamily = 'community_revenue' | 'teamup';

/** 模板键；首发三模板 + 预留扩展 */
export type TemplateKey = 'gso' | 'team-quest' | 'group-buy' | (string & {});

// ============================================================
// 资产与参与方
// ============================================================

export type Currency = 'gameCoins' | 'aCoins';

/** 出资承诺（deploy 时声明，此后固化，__contract/update 403 保护） */
export interface StakeRef {
  kind: 'voucher' | 'wallet';
  voucherId?: string;
  currency?: Currency;
  amount: number;
}

export type PartyRole = 'initiator' | 'participant' | 'platform' | 'arbiter';

/** deploy 时声明的参与方 */
export interface PartySpec {
  userId: string;
  role: PartyRole;
  stake: StakeRef[];
  data?: Record<string, unknown>;
}

/** 运行中的参与方（动态加入者通过 history 事件链累积存证） */
export interface ContractParty extends PartySpec {
  joinedAt: number;
  signedAt?: number;
}

// ============================================================
// Effect 白名单（合约唯一允许执行的副作用类型）
// ============================================================

export type EffectType =
  | 'freezeVoucher'
  | 'unfreezeVoucher'
  | 'transferVoucher'
  | 'mintVoucher' // 受限：模板须显式声明进 effectsWhitelist
  | 'mintShareVouchers' // 受限：GSO 专用（按认购表逐人铸收益分成凭证）
  | 'walletTransfer'
  | 'treasuryDeposit'
  | 'splitPayout'
  | 'refundAll'
  | 'grantGovernanceWeight'
  | 'penalize'
  | 'setState'
  | 'openDispute'
  | 'notify';

export type ForfeitTarget = 'rewardPool' | 'treasury' | 'members';

export interface SplitPayoutRow {
  userId: string;
  amount: number;
}

/** 最终执行的 Effect（数值已解析，禁止表达式残留） */
export type Effect =
  | { type: 'freezeVoucher'; voucherId: string; reason: string }
  | { type: 'unfreezeVoucher'; voucherId: string; reason: string }
  | { type: 'transferVoucher'; voucherId: string; fromUserId?: string; toUserId: string; reason: string }
  | {
      type: 'mintVoucher';
      toUserId: string;
      voucher: { schemaName: string; title: string; denomination?: number; metadata?: Record<string, unknown> };
      reason: string;
    }
  | { type: 'walletTransfer'; toUserId: string; currency: Currency; amount: number; fromUserId?: string; purpose?: string; reason: string }
  | { type: 'treasuryDeposit'; currency: Currency; amount: number; purpose?: string; reason: string }
  | {
      type: 'splitPayout';
      currency: Currency;
      table: SplitPayoutRow[];
      purpose?: string;
      /** 资金来源：escrow（缺省，从合约托管扣）| treasury（平台金库支付，如 GSO 收益分成——托管在交割时已清空） */
      source?: 'escrow' | 'treasury';
      reason: string;
    }
  | {
      type: 'mintShareVouchers';
      currency: Currency;
      /** 每人一份：amount=认购额，share=amount/总认购（0..1） */
      rows: { userId: string; amount: number; share: number }[];
      lockupMs: number;
      reason: string;
    }
  | { type: 'refundAll'; purpose?: string; reason: string }
  | { type: 'grantGovernanceWeight'; gameId: string; toUserId: string; topic: string; weightBps: number; reason: string }
  | { type: 'penalize'; userId: string; currency: Currency; amount: number; forfeitTo: ForfeitTarget; purpose?: string; reason: string }
  | { type: 'setState'; to: ContractState; reason: string }
  | { type: 'openDispute'; byUserId: string; reason: string }
  | { type: 'notify'; message: string; toUserIds?: string[] };

// ============================================================
// 条款与触发器
// ============================================================

export type TriggerKind = 'event' | 'protocol' | 'cron' | 'manual';

export interface TriggerSpec {
  id: string;
  kind: TriggerKind;
  /** event / protocol：精确匹配的事件名 */
  match?: string;
  /** manual：动作名（join / subscribe / buyback / ...） */
  action?: string;
  /** cron：调度名（deadline-check / settlement-weekly / settlement-monthly / tick-5m） */
  schedule?: string;
  /** protocol 触发是否强制 channelToken 校验（TeamQuest 事实源首发强制） */
  requiresChannelToken?: boolean;
  /** 允许触发的合约状态（缺省 ['funded','active']） */
  enabledStates?: ContractState[];
}

/** 数值：静态数字或 'expr: <DSL>' 表达式字符串 */
export type NumVal = number | string;

export interface StateUpdateSpec {
  /** stateData 上的字段路径（点分：a.b.c） */
  field: string;
  op: 'add' | 'set' | 'push';
  value: NumVal;
  /** op=push 时：贡献记录的 userId 表达式 */
  userIdExpr?: string;
  /** op=push 时：贡献记录的 amount 表达式 */
  amountExpr?: string;
}

export type SplitTableSpec =
  | { kind: 'literal'; rows: SplitPayoutRow[] }
  | {
      kind: 'byField';
      stateField: string;
      userIdField?: string;
      amountField: string;
      /** abs：item[amountField] 即发放金额；share：按 amountField 占比分 poolAmount */
      mode?: 'abs' | 'share';
      /** share 模式的分配总额（如奖池 / 周期收益×分成比例） */
      poolAmount?: NumVal;
    };

/** 条款中的 Effect 声明：动态字段用 'expr: <DSL>' 表达式，其余为静态值 */
export interface EffectSpecFree {
  type: EffectType;
  voucherId?: string;
  fromUserId?: string;
  toUserId?: string;
  userId?: string;
  byUserId?: string;
  to?: string;
  /** 允许 'expr: params.currency' 动态解析（执行器校验枚举合法） */
  currency?: Currency | string;
  amount?: NumVal;
  bps?: NumVal;
  weightBps?: NumVal;
  forfeitTo?: ForfeitTarget;
  gameId?: string;
  topic?: string;
  reason: string;
  message?: string;
  toUserIds?: string[];
  table?: SplitTableSpec;
  /** mintShareVouchers：凭证锁定期 */
  lockupMs?: NumVal;
  /** 资金用途标签（托管台账隔离：bond 保证金 / pool 奖池 / payment 货款…缺省 = 全部） */
  purpose?: string;
  /** splitPayout 资金来源：escrow（缺省）/ treasury（平台金库支付） */
  source?: string;
  voucher?: {
    schemaName: string;
    title: string;
    denomination?: NumVal;
    metadata?: Record<string, unknown>;
  };
}

export interface Clause {
  id: string;
  title: string;
  description?: string;
  on: TriggerSpec;
  /** DSL 条件表达式（缺省 true） */
  when?: string;
  then: EffectSpecFree[];
  /** 条款命中后对 stateData 的更新 */
  updates?: StateUpdateSpec[];
}

// ============================================================
// 状态机
// ============================================================

export type ContractState =
  | 'draft'
  | 'signing'
  | 'funded'
  | 'active'
  | 'settling'
  | 'fulfilled'
  | 'breached'
  | 'disputed'
  | 'refunded'
  | 'terminated';

// ============================================================
// 模板
// ============================================================

export interface ParamFieldRule {
  type: 'number' | 'string' | 'boolean' | 'enum' | 'array' | 'object';
  required?: boolean;
  min?: number;
  max?: number;
  /** enum 候选值 */
  enumValues?: (string | number)[];
  minItems?: number;
  maxItems?: number;
  /** array 元素规则 */
  itemRule?: ParamFieldRule;
  /** object 字段规则 */
  fields?: Record<string, ParamFieldRule>;
  description?: string;
}

export interface ContractTemplate {
  key: TemplateKey;
  family: ContractFamily;
  version: number;
  title: string;
  description?: string;
  riskLevel: 'low' | 'medium' | 'high';
  requiresAudit: boolean;
  paramsSchema: Record<string, ParamFieldRule>;
  effectsWhitelist: EffectType[];
  clauses: Clause[];
  initialState: ContractState;
  /** gso 专属：治理白名单（社区可投事项） */
  governanceTopics?: string[];
}

// ============================================================
// 实例 / 事件账本
// ============================================================

export interface IntegrityProof {
  sig: string;
  signedBy: 'server';
  signedAt: number;
}

export interface WalletHold {
  currency: Currency;
  amount: number;
}

export interface EscrowState {
  voucherIds: string[];
  walletHold: WalletHold[];
}

/** 事件哈希链节点（只追加；hash = sha256(prevHash + canonical(body))） */
export interface ContractEvent {
  seq: number;
  at: number;
  /** deployed / signed / trigger / effect / state / dispute / note ... */
  type: string;
  actorId: string;
  payload: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

export interface ContractInstance {
  id: string;
  templateKey: string;
  templateVersion: number;
  family: ContractFamily;
  /** 规则指纹：sha256(canonical({templateKey, templateVersion, clauses, params})) */
  codeHash: string;
  /** 部署时由服务端 HMAC 签发（密钥 CONTRACT_SIGNING_KEY，与 JWT_SECRET 分离） */
  integrity?: IntegrityProof;
  upgradePolicy: 'immutable' | 'versioned' | 'governed';
  initiatorId: string;
  gameId?: string;
  /**
   * 私域名单（可选）：非空时仅名单内成员（含发起人）可执行"进入类"动作（join/subscribe），
   * 其余 manual 动作（leave/fund-pool/dispute 等）与 cron 不受限。缺省 = 公开合约。
   * 门禁在合约隧道 invoke 层统一实施（模板 DSL 零感知）。
   */
  whitelist?: string[];
  params: Record<string, unknown>;
  /** 冻结的条款副本（verify 端点用它重算 codeHash 自证） */
  clauses: Clause[];
  parties: ContractParty[];
  escrow: EscrowState;
  state: ContractState;
  /** 模板运行时状态（members / totalSubscribed / subscribers ...） */
  stateData: Record<string, unknown>;
  history: ContractEvent[];
  /** 确定性随机源（求值器 rand(i) 由它派生；禁 Math.random） */
  seed: string;
  /** false = 影子模式：engine 照常产出 EffectPlan，runtime 只记录不执行资金 */
  autoExecute: boolean;
  createdAt: number;
  updatedAt: number;
  /** 乐观锁（B1 隧道写入用，防并发追加断链） */
  version: number;
}

// ============================================================
// 执行计划（engine 纯函数产物 → runtime 执行）
// ============================================================

export interface TriggerEvent {
  /** 幂等键成分，runtime 保证唯一（建议含序号） */
  triggerId: string;
  kind: TriggerKind;
  /** 事件名 / manual 动作名 / cron 调度名 */
  type: string;
  at: number;
  actorId: string;
  payload: Record<string, unknown>;
  /** protocol 事件的 channelToken 校验结果（强制条款要求 true） */
  channelTokenValid?: boolean;
}

export interface StateUpdate {
  field: string;
  op: 'add' | 'set' | 'push';
  value?: number;
  /** op=push 时的贡献记录 */
  userId?: string;
  amount?: number;
}

export interface EffectPlan {
  contractId: string;
  templateKey: string;
  clauseIds: string[];
  idempotencyKey: string;
  trigger: TriggerEvent;
  effects: Effect[];
  updates: StateUpdate[];
  nextState?: ContractState;
  /** 影子模式产物：runtime 只记录对账日志，不动钱 */
  shadow: boolean;
  createdAt: number;
}

// ============================================================
// 托管 / 收益台账（B2 服务端资金权威；类型先行）
// ============================================================

export type EscrowEntryStatus = 'locked' | 'released' | 'refunded' | 'forfeited' | 'split';

export interface EscrowEntry {
  entryId: string;
  /** 幂等键 */
  txId: string;
  contractId: string;
  fromUserId: string;
  kind: 'voucher' | 'wallet';
  /** 资金用途（bond / pool / payment…；release/refund 按用途定向，防 FIFO 混淆） */
  purpose?: string;
  voucherId?: string;
  voucherIds?: string[];
  currency?: Currency;
  amount: number;
  lockedAt: number;
  status: EscrowEntryStatus;
  releasedAt?: number;
  releasedTo?: string;
}

export type RevenueSource = 'market_commission' | 'content_consume' | 'store_sale' | 'item_sale';

export interface RevenueEntry {
  entryId: string;
  /** 幂等键 */
  txId: string;
  source: RevenueSource;
  gameId: string;
  grossAmount: number;
  commission: number;
  currency: Currency;
  occurredAt: number;
  refId?: string;
  recordedBy: 'server';
}

// ============================================================
// 平台规则注册中心（把散落的硬编码信任规则收敛为公开、可验证、治理门控的注册表）
// ============================================================

/** 平台级规则（如市场佣金率、每日提取限额）；修改走 propose → 公示期 → activate 的治理门控 */
export interface PlatformRule {
  id: string;
  /** 规则键（如 'market.commission_rate'） */
  ruleKey: string;
  /** 当前生效值 */
  value: number;
  description: string;
  /** 待生效值（公示期中） */
  pendingValue: number | null;
  proposedBy: string | null;
  proposedAt: number | null;
  /** 公示期满，可 activate 的时间 */
  effectiveAt: number | null;
  /** 公示期（毫秒），治理参数 */
  cooldownMs: number;
  version: number;
  /** 规则治理审计链（复用合约事件哈希链；type: registered/proposed/activated/rejected） */
  history: ContractEvent[];
}

/** 内置规则键与默认值（首装 seed；后续全部服务端硬编码点逐步迁移读取此表） */
export const PLATFORM_RULE_DEFAULTS: Array<{ ruleKey: string; value: number; description: string }> = [
  // ---- 市场 ----
  { ruleKey: 'market.commission_rate', value: 0.05, description: '市场成交佣金率（__market/buy 收益台账记账使用；原前端/服务端双处硬编码收敛）' },
  // ---- 频控 / 限额 ----
  { ruleKey: 'item_harvest.daily_limit', value: 10, description: '游戏道具每日提取次数上限（接入点：itemHarvestService / __item/harvest-limit）' },
  { ruleKey: 'cross_exchange.daily_limit', value: 20, description: '跨游戏兑换每日次数上限（接入点：crossGameExchange）' },
  // ---- 开发者结算（原 gameDeveloperService DEFAULT_REVENUE_SHARE/DAY_MS 硬编码收敛） ----
  { ruleKey: 'settlement.revenue_share_percent', value: 10, description: '游戏方道具/凭证销售的平台抽成默认值 %（接入点：gameDeveloperService / PublishingPipeline）' },
  { ruleKey: 'settlement.cycle_ms', value: 86400000, description: '开发者收益每日结算周期毫秒（接入点：gameDeveloperService.executeDailySettlement）' },
  // ---- 治理计票（原 ProposalSkill 硬编码收敛） ----
  { ruleKey: 'governance.pass_threshold', value: 0.5, description: '提案通过阈值：赞成权重 / 总权重 必须 > 该值（接入点：ProposalSkill.finalizeProposal）' },
  { ruleKey: 'governance.weight_acoin', value: 0.3, description: '投票权重公式 A 币系数（接入点：ProposalSkill.calculateVoteWeight）' },
  { ruleKey: 'governance.weight_gamecoin', value: 0.1, description: '投票权重公式游戏币系数（接入点：ProposalSkill.calculateVoteWeight）' },
  { ruleKey: 'governance.weight_cap', value: 1000, description: '单用户投票权重上限（接入点：ProposalSkill.calculateVoteWeight）' },
  { ruleKey: 'governance.rule_cooldown_ms', value: 259200000, description: '规则修改公示期毫秒，默认 72h（接入点：注册中心 seed / propose）' },
  // ---- 凭证平台级费率（原 voucher-system/templates.ts 硬编码收敛；模板只引用，汇率表留模板） ----
  { ruleKey: 'voucher.recycle_daily_pct', value: 0.5, description: '每日结算回收比例 %（→金库；接入点：凭证模板 recycle-daily-settlement）' },
  { ruleKey: 'voucher.exchange_fee_pct', value: 2, description: '凭证兑换手续费 %（→销毁；接入点：凭证模板 recycle-exchange-fee）' },
  { ruleKey: 'voucher.transfer_fee_pct', value: 0.5, description: '凭证转账手续费 %（→平台；接入点：凭证模板 recycle-transaction-fee）' },
  // ---- 跨游戏兑换（原 crossGameExchange.ts 硬编码收敛） ----
  { ruleKey: 'cross_exchange.fee_rate', value: 0.1, description: '跨游戏兑换手续费率（按目标道具价值；接入点：calcExchangeFee）' },
];

// ============================================================
// GSO 模板参数
// ============================================================

/** 治理白名单（游戏方仅让出这些事项的表决权） */
export type GovernableTopic = 'ADJUST_PRICE' | 'GAME_CONFIG' | 'MINT_CURRENCY';

export type VotingWeightRule = 'share_linear' | 'share_time_weighted';

export interface GsoParams {
  gameId: string;
  issuerId: string;
  raiseTarget: number;
  currency: Currency;
  revenueShareBps: number;
  governanceShareBps: number;
  openAt: number;
  closeAt: number;
  softCap: number;
  hardCap?: number;
  perUserCap: number;
  coolDownMs: number;
  lockupMs: number;
  transferableAfterLockup: boolean;
  buyback?: { priceBps: number; until: number };
  revenueSources: RevenueSource[];
  settlementCron: 'weekly' | 'monthly';
  governableTopics: string[];
  votingWeightRule: VotingWeightRule;
  minHoldingMsForVote: number;
}

// ============================================================
// TeamQuest / GroupBuy 模板参数
// ============================================================

export type PayoutRule =
  | { kind: 'equal' }
  | { kind: 'byContribution' }
  | { kind: 'byRank'; ranks: { rank: number; bps: number }[] }
  | { kind: 'custom'; table: { userId: string; bps: number }[] };

export interface TeamQuestParams {
  questId: string;
  gameId?: string;
  initiatorId: string;
  minMembers: number;
  maxMembers: number;
  recruitmentDeadline: number;
  taskDeadline: number;
  objectives: { event: string; target: number; weightBps?: number }[];
  rewardPool: {
    source: 'platform' | 'game' | 'members';
    currency: Currency | 'item';
    amount?: number;
    poolId?: string;
  };
  memberBond: number;
  payoutRule: PayoutRule;
  breach: {
    underContributionBps: number;
    earlyExitBps: number;
    earlyExitRejoinable: boolean;
    leaderFailBps: number;
    forfeitTo: ForfeitTarget;
  };
  onMiss: 'refundInitiator' | 'refundAll' | 'toTreasury';
  disputeWindowMs: number;
}

export interface GroupBuyParams {
  gameId?: string;
  skuId?: string;
  itemTitle: string;
  initiatorId: string;
  /** 单买价（对照价） */
  unitPrice: number;
  /** 成团单价 */
  groupPrice: number;
  minMembers: number;
  maxMembers: number;
  openAt: number;
  closeAt: number;
  currency: Currency;
  perUserLimit: number;
  disputeWindowMs: number;
}
