/**
 * 限时活动引擎（E1-E4）——纯函数层
 *
 * 设计（docs/limited-time-event-design.md）：
 * - 时间窗口 + 功能开关 + 状态机；活动上下线/周期复用均为配置变更，不发版
 * - 状态机：draft → scheduled(预热) → live(开放) → closing(关闭中/grace 补领) → settled → archived
 * - 参与放行 = 状态 ∩ 时间窗口 ∩ 开关 三重与门（前端隐藏不是安全边界）
 * - 发放幂等：event_grants.id = grant_<eventId>_<userId>_<rewardId>
 *
 * 本文件必须保持纯函数（无 IO），便于 vitest 单测与云函数 JS 版对齐。
 */

// ==================== 类型 ====================

export type EventStatus = 'draft' | 'scheduled' | 'live' | 'closing' | 'settled' | 'archived';
export type EventType = 'collect' | 'staged' | 'game';

export interface EventReward {
  currency: 'gamecoin';
  amount: number;
}

export interface EventRewardRule {
  id: string;
  kind: 'threshold' | 'leaderboard' | 'participation';
  /** 计分指标：freon / score / stage_contrib 等 */
  metric: string;
  /** threshold 型达标线 */
  threshold?: number;
  /** leaderboard 型名次区间（闭区间） */
  rankRange?: [number, number];
  reward: EventReward;
  /** 属于哪个阶段（staged 活动的阶段奖励） */
  stageId?: string;
}

export interface EventStageDef {
  id: string;
  index: number;
  name: string;
  startTime: number;
  endTime: number;
  /** 全服进度目标（建造进度） */
  goal: { metric: string; target: number };
  rewards: EventRewardRule[];
}

export interface EventRollout {
  mode: 'all' | 'percent' | 'whitelist';
  percent?: number;
  whitelist?: string[];
}

export interface LimitedEventDef {
  id: string;
  /** 系列标识（周期活动不变，用于模块映射与归档聚合），如 'freon' */
  slug: string;
  name: string;
  type: EventType;
  status: EventStatus;
  /** 总开关（运营秒级 false） */
  enabled: boolean;
  forceStopAt?: number;
  startTime: number;
  endTime: number;
  /** 预热提前量（小时）：draft → scheduled */
  leadHours: number;
  /** closing 期补领窗口（小时） */
  graceHours: number;
  repeat?: { unit: 'weekly' | 'biweekly' | 'monthly'; count?: number };
  config: {
    /** 计分指标（缺省按类型：collect→freon） */
    metric?: string;
    /** 单次提交上限（防刷） */
    maxValuePerSubmit?: number;
    /** 每日提交次数上限 */
    dailySubmitCap?: number;
    /** 排行榜指标 */
    leaderboardMetric?: string;
    /** Freon 型掉落通道配置（dropHook 用） */
    dropChannels?: Array<{ channel: string; rate: number; dailyCap: number }>;
    /** staged 活动阶段（内嵌，阶段奖励亦内嵌） */
    stages?: EventStageDef[];
    [k: string]: any;
  };
  rewardRules: EventRewardRule[];
  rollout?: EventRollout;
  /** 结算清单（closing→settled 时写入，幂等重结算依据） */
  settleManifest?: { grants: number; settledAt: number; hash: string } | null;
  createdAt: number;
  updatedAt: number;
}

export interface EventParticipation {
  /** 幂等主键 eventId:userId */
  id: string;
  eventId: string;
  userId: string;
  joinedAt: number;
  metrics: Record<string, number>;
  submissions: number;
  /** 每日限流：当日提交次数 */
  submissionsToday: number;
  submissionsDate: string;
  /** 阶段贡献（staged）：stageId → 个人贡献 */
  stageContrib: Record<string, number>;
  lastSubmitAt: number;
}

export interface EventGrant {
  /** 幂等键 grant_<eventId>_<userId>_<rewardId> */
  id: string;
  eventId: string;
  userId: string;
  rewardId: string;
  amount: number;
  grantedAt: number;
  source: 'self_claim' | 'settle_job';
}

export interface EventStageProgress {
  stageId: string;
  eventId: string;
  metric: string;
  current: number;
  completedAt?: number | null;
}

export const HOUR_MS = 3600_000;
export const DAY_MS = 86_400_000;
/** settled 后归档保留期 */
export const ARCHIVE_AFTER_MS = 90 * DAY_MS;

// ==================== 状态机 ====================

/**
 * 计算活动的下一状态（纯函数，幂等：重放同参同果）。
 * 返回 null = 无迁移。紧急下线（!enabled 或 forceStopAt）直接进入 closing（已 settled 则不动）。
 */
export function computeNextStatus(e: LimitedEventDef, now: number): EventStatus | null {
  if (e.status === 'archived' || e.status === 'settled') return null;
  const forceStopped = !e.enabled || (e.forceStopAt ?? 0) > 0;
  if (forceStopped && e.status !== 'closing') return 'closing';
  // closing → settled：按「有效结束时间」计 grace（紧急下线以 forceStopAt 为准）
  if (e.status === 'closing') {
    const effectiveEnd = forceStopped ? Math.min(e.endTime, e.forceStopAt ?? e.endTime) : e.endTime;
    return now >= effectiveEnd + e.graceHours * HOUR_MS ? 'settled' : null;
  }
  if (forceStopped) return null;
  switch (e.status) {
    case 'draft':
      return now >= e.startTime - e.leadHours * HOUR_MS ? 'scheduled' : null;
    case 'scheduled':
      return now >= e.startTime ? 'live' : null;
    case 'live':
      return now >= e.endTime ? 'closing' : null;
    default:
      return null;
  }
}

/** tick 内循环迁移直至稳定（一次 tick 可跨多个边界） */
export function advanceStatus(e: LimitedEventDef, now: number): { status: EventStatus; transitions: EventStatus[] } {
  const transitions: EventStatus[] = [];
  let cur = e.status;
  for (let i = 0; i < 8; i++) {
    const next = computeNextStatus({ ...e, status: cur }, now);
    if (!next) break;
    transitions.push(next);
    cur = next;
  }
  return { status: cur, transitions };
}

/** 三重校验：窗口 ∩ 状态 ∩ 开关（参与类接口的守卫） */
export function checkEventGate(
  e: LimitedEventDef | null | undefined,
  userId: string | null | undefined,
  now: number,
  phase: 'live' | 'live-or-closing',
): { ok: true } | { ok: false; code: number; error: string; payload?: Record<string, any> } {
  if (!e) return { ok: false, code: 404, error: '活动不存在' };
  const payload = {
    expectedPhase: phase,
    serverNow: now,
    startTime: e.startTime,
    endTime: e.endTime,
    status: e.status,
  };
  if (!e.enabled || (e.forceStopAt ?? 0) > 0) {
    return { ok: false, code: 403, error: 'EVENT_NOT_ACTIVE', payload };
  }
  // 灰度：非放行用户视为「未开启」
  if (userId && !rolloutAllows(e, userId)) {
    return { ok: false, code: 403, error: 'EVENT_NOT_ACTIVE', payload };
  }
  const inWindow = now >= e.startTime && now < e.endTime + e.graceHours * HOUR_MS;
  if (!inWindow) {
    return { ok: false, code: 403, error: 'EVENT_NOT_ACTIVE', payload };
  }
  if (phase === 'live') {
    if (e.status !== 'live' || now >= e.endTime) {
      return { ok: false, code: 403, error: 'EVENT_NOT_ACTIVE', payload };
    }
  } else {
    if (e.status !== 'live' && e.status !== 'closing') {
      return { ok: false, code: 403, error: 'EVENT_NOT_ACTIVE', payload };
    }
  }
  return { ok: true };
}

// ==================== 灰度 ====================

/** 确定性哈希（同用户同活动结果稳定，避免刷新忽隐忽现） */
export function stableHash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

export function rolloutAllows(e: LimitedEventDef, userId: string): boolean {
  const r = e.rollout;
  if (!r || r.mode === 'all') return true;
  if (r.mode === 'whitelist') {
    return (r.whitelist || []).includes(userId);
  }
  const pct = Math.max(0, Math.min(100, Number(r.percent) || 0));
  return stableHash(`${e.slug}:${userId}`) % 100 < pct;
}

// ==================== 周期活动 ====================

/** 周期平移：weekly +7d / biweekly +14d / monthly 同日下月 */
export function shiftByUnit(t: number, unit: 'weekly' | 'biweekly' | 'monthly'): number {
  if (unit === 'weekly') return t + 7 * DAY_MS;
  if (unit === 'biweekly') return t + 14 * DAY_MS;
  const d = new Date(t);
  const day = d.getDate();
  d.setMonth(d.getMonth() + 1);
  if (d.getDate() !== day) d.setDate(0); // 月末溢出回退到当月最后一天
  return d.getTime();
}

/**
 * 生成下一期实例（周期活动）。seq = 已存在期数（含本期），新期 status=draft、
 * 时间平移一个 unit、配置/奖励快照拷贝、清 forceStop/settleManifest。
 */
export function cloneNextOccurrence(e: LimitedEventDef, seq: number): LimitedEventDef {
  const unit = e.repeat?.unit || 'weekly';
  const span = e.endTime - e.startTime;
  const start = shiftByUnit(e.startTime, unit);
  const c: LimitedEventDef = {
    ...structuredCloneSafe(e),
    id: `evt_${e.slug}_${seq + 1}`,
    status: 'draft',
    enabled: true,
    forceStopAt: undefined,
    settleManifest: null,
    startTime: start,
    endTime: start + span,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  // 阶段时间同步平移
  if (c.config.stages) {
    const delta = start - e.startTime;
    c.config.stages = c.config.stages.map((s) => ({ ...s, startTime: s.startTime + delta, endTime: s.endTime + delta }));
  }
  return c;
}

function structuredCloneSafe<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

// ==================== 提交校验 ====================

export function defaultMetric(e: LimitedEventDef): string {
  return e.config.metric || (e.type === 'collect' ? 'freon' : e.type === 'game' ? 'score' : 'stage_contrib');
}

export function dayKey(now: number): string {
  const d = new Date(now);
  return `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}`;
}

export interface SubmitCheck {
  ok: boolean
  error?: string;
  code?: number;
}

/** submit 校验：单次值上限 + 每日次数上限（周期重置） */
export function checkSubmit(
  e: LimitedEventDef,
  p: EventParticipation,
  value: number,
  now: number,
): SubmitCheck {
  const maxPer = Number(e.config.maxValuePerSubmit) || 50;
  if (!Number.isFinite(value) || value <= 0 || value > maxPer) {
    return { ok: false, code: 400, error: `单次提交须在 1~${maxPer} 之间` };
  }
  const cap = Number(e.config.dailySubmitCap) || 200;
  const today = dayKey(now);
  const todayCount = p.submissionsDate === today ? p.submissionsToday : 0;
  if (todayCount >= cap) {
    return { ok: false, code: 429, error: `今日提交次数已达上限 ${cap}` };
  }
  return { ok: true };
}

/** 当前所处阶段（staged；窗口外返回 null） */
export function currentStage(e: LimitedEventDef, now: number): EventStageDef | null {
  const stages = e.config.stages || [];
  return stages.find((s) => now >= s.startTime && now < s.endTime) || null;
}

// ==================== 奖励判定 ====================

export interface ClaimableReward {
  rewardId: string;
  kind: EventRewardRule['kind'];
  label: string;
  progress: { current: number; target: number | null };
  reward: EventReward;
  claimable: boolean;
  claimed: boolean;
}

/**
 * 计算用户可领奖励（threshold/participation 自助领取；leaderboard 仅结算任务发放）。
 * claimedGrantIds = 已存在的 grant id 集合。
 */
export function computeClaimables(
  e: LimitedEventDef,
  p: EventParticipation | null,
  grantedRewardIds: Set<string>,
): ClaimableReward[] {
  const out: ClaimableReward[] = [];
  const collect = (rules: EventRewardRule[], metrics: Record<string, number>, contrib: Record<string, number>) => {
    for (const r of rules) {
      if (r.kind === 'leaderboard') continue; // 结算任务发放
      const current = r.kind === 'participation' ? Object.values(metrics).reduce((a, b) => a + b, 0) : (metrics[r.metric] ?? (r.stageId ? contrib[r.stageId] ?? metrics[r.metric] ?? 0 : 0));
      const target = r.kind === 'participation' ? 1 : r.threshold ?? 1;
      const claimed = grantedRewardIds.has(r.id);
      const reached = r.kind === 'participation'
        ? (current > 0)
        : r.stageId
          ? (contrib[r.stageId] ?? 0) >= (r.threshold ?? 1)
          : current >= target;
      out.push({
        rewardId: r.id,
        kind: r.kind,
        label: r.kind === 'participation' ? '参与奖' : `达成 ${r.threshold} ${r.metric}`,
        progress: { current: r.stageId ? contrib[r.stageId] ?? 0 : current, target: r.kind === 'participation' ? null : target },
        reward: r.reward,
        claimable: !!p && reached && !claimed,
        claimed,
      });
    }
  };
  collect(e.rewardRules || [], p?.metrics || {}, p?.stageContrib || {});
  for (const s of e.config.stages || []) {
    collect(s.rewards || [], p?.metrics || {}, p?.stageContrib || {});
  }
  return out;
}

/** 排行榜：按指标倒序取前 N（tie 按 userId 字典序稳定） */
export function computeLeaderboard(
  participations: EventParticipation[],
  metric: string,
  limit = 50,
): Array<{ userId: string; value: number }> {
  return participations
    .map((p) => ({ userId: p.userId, value: p.metrics[metric] ?? 0 }))
    .filter((x) => x.value > 0)
    .sort((a, b) => b.value - a.value || (a.userId < b.userId ? -1 : 1))
    .slice(0, limit);
}

/** 结算：由全部参与记录算出 leaderboard 型应发奖励（幂等由 grant id 兜底） */
export function computeSettlementGrants(
  e: LimitedEventDef,
  participations: EventParticipation[],
): Array<{ userId: string; rewardId: string; amount: number }> {
  const metric = e.config.leaderboardMetric || defaultMetric(e);
  const board = computeLeaderboard(participations, metric, 1000);
  const grants: Array<{ userId: string; rewardId: string; amount: number }> = [];
  for (const r of e.rewardRules || []) {
    if (r.kind !== 'leaderboard' || !r.rankRange) continue;
    const [lo, hi] = r.rankRange;
    for (let i = lo; i <= Math.min(hi, board.length - 1); i++) {
      grants.push({ userId: board[i].userId, rewardId: r.id, amount: r.reward.amount });
    }
  }
  return grants;
}

/** Freon 型掉落：给定通道与基础量，算出活跃 collect 活动应掉落数量 */
export function computeDrop(
  events: LimitedEventDef[],
  channel: string,
  userId: string,
  now: number,
): number {
  let total = 0;
  for (const e of events) {
    if (e.type !== 'collect' || e.status !== 'live' || !e.enabled) continue;
    if (checkEventGate(e, userId, now, 'live').ok !== true) continue;
    const ch = (e.config.dropChannels || []).find((c) => c.channel === channel);
    if (!ch || !(ch.rate > 0)) continue;
    total += ch.rate;
  }
  return Math.floor(total);
}

export function grantId(eventId: string, userId: string, rewardId: string): string {
  return `grant_${eventId}_${userId}_${rewardId}`;
}
