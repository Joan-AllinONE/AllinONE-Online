/**
 * 执行引擎（纯函数）：TriggerEvent + ContractInstance → EffectPlan
 *
 * 流程（对应设计文档 9.7 执行流水线的纯函数部分）：
 *   1. 幂等检查（triggerId 已入 history → 跳过）
 *   2. 条款匹配（trigger spec 对齐 + 状态门 + channelToken 强制门）
 *   3. when 条件求值（确定性 DSL）
 *   4. EffectSpec 解析（'expr:' 求值 / splitPayout 表构造）
 *   5. 状态迁移校验（非法迁移整体拒绝，宁拒不半执行）
 *
 * 本文件不执行任何 IO；EffectPlan 交由 runtime（B1 隧道 / B2 资金原语）落地。
 * 影子模式（instance.autoExecute=false）：照常产出 plan，置 shadow=true，
 * 由 runtime 决定「只记录对账日志，不动钱」。
 */
import { evaluateExpression, evalNumber, evalString } from './evaluate.js';
import { isValidTransition } from './validate.js';
import type {
  ContractInstance,
  ContractState,
  Currency,
  Effect,
  EffectPlan,
  EffectSpecFree,
  NumVal,
  SplitPayoutRow,
  SplitTableSpec,
  StateUpdate,
  TriggerEvent,
  TriggerSpec,
} from '../types.js';

export interface ExecuteResult {
  plan: EffectPlan | null;
  /** plan 为 null 时的原因 */
  reason?: 'duplicate-trigger' | 'no-matching-clause' | 'condition-not-met' | 'rejected' | 'eval-error';
  reasonDetail?: string;
}

const DEFAULT_ENABLED_STATES: ContractState[] = ['funded', 'active'];

// ============================================================
// 触发器匹配
// ============================================================

export function triggerMatches(on: TriggerSpec, ev: TriggerEvent): boolean {
  if (on.kind !== ev.kind) return false;
  switch (on.kind) {
    case 'event':
    case 'protocol': {
      const m = on.match ?? '';
      // 'XXX:*' 前缀通配（如 GAME_EVENT:*）；否则精确匹配
      if (m.endsWith(':*')) return ev.type.startsWith(m.slice(0, -1));
      return m === ev.type;
    }
    case 'manual':
      return on.action === ev.type;
    case 'cron':
      return on.schedule === ev.type;
    default:
      return false;
  }
}

function hasTriggerEvent(instance: ContractInstance, triggerId: string): boolean {
  return instance.history.some(
    (h) => h.type === 'trigger' && (h.payload as Record<string, unknown>).triggerId === triggerId,
  );
}

// ============================================================
// 'expr:' 解析助手
// ============================================================

function resolveNum(v: NumVal, env: Record<string, unknown>, path: string, seed?: string): number {
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new TypeError(`${path}: 非有限数字`);
    return v;
  }
  if (typeof v === 'string' && v.startsWith('expr:')) {
    const n = evalNumber(v.slice(5).trim(), { vars: env, seed });
    if (!Number.isFinite(n)) throw new TypeError(`${path}: 表达式结果非有限`);
    return n;
  }
  throw new TypeError(`${path}: 必须是数字或 'expr:' 表达式`);
}

function resolveStr(v: string | undefined, env: Record<string, unknown>, _path: string, seed?: string): string | undefined {
  if (v === undefined) return undefined;
  if (v.startsWith('expr:')) {
    return evalString(v.slice(5).trim(), { vars: env, seed });
  }
  return v;
}

function getPath(obj: unknown, field: string): unknown {
  let cur: unknown = obj;
  for (const seg of field.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

const VALID_CURRENCIES = ['gameCoins', 'aCoins'];

const STATES_SET = new Set<string>([
  'draft', 'signing', 'funded', 'active', 'settling',
  'fulfilled', 'breached', 'disputed', 'refunded', 'terminated',
]);

/** 币种解析：静态枚举或 'expr:' 表达式（结果必须命中枚举） */
function resolveCurrency(v: string | undefined, env: Record<string, unknown>, p: string, seed?: string): string {
  const s = resolveStr(v, env, p, seed);
  if (!s || !VALID_CURRENCIES.includes(s)) {
    throw new TypeError(`${p}: currency 必须解析为 gameCoins / aCoins，实际 ${String(s)}`);
  }
  return s;
}

function resolveTable(
  table: SplitTableSpec | undefined,
  stateData: Record<string, unknown>,
  env: Record<string, unknown>,
  seed?: string,
): SplitPayoutRow[] {
  if (!table) return [];
  if (table.kind === 'literal') return table.rows.map((r) => ({ ...r }));
  const arr = getPath(stateData, table.stateField);
  if (!Array.isArray(arr)) {
    throw new TypeError(`splitPayout.byField: stateData.${table.stateField} 不是数组`);
  }
  const userIdField = table.userIdField ?? 'userId';
  const raw: SplitPayoutRow[] = [];
  for (const item of arr) {
    if (item === null || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const userId = rec[userIdField];
    const amount = rec[table.amountField];
    if (typeof userId === 'string' && userId && typeof amount === 'number' && amount > 0) {
      raw.push({ userId, amount });
    }
  }
  if (table.mode !== 'share') return raw;
  // share 模式：按 amountField 占比分 poolAmount（同人多行合并）
  const pool = resolveNum(table.poolAmount ?? 0, env, 'table.poolAmount', seed);
  if (pool < 0) throw new TypeError('table.poolAmount 不得为负');
  const totals = new Map<string, number>();
  let sum = 0;
  for (const r of raw) {
    totals.set(r.userId, (totals.get(r.userId) || 0) + r.amount);
    sum += r.amount;
  }
  if (sum <= 0) return [];
  const rows: SplitPayoutRow[] = [];
  let allocated = 0;
  const entries = [...totals.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)); // 确定性顺序
  entries.forEach(([userId, w], i) => {
    if (i < entries.length - 1) {
      const amt = Math.floor((pool * w) / sum);
      rows.push({ userId, amount: amt });
      allocated += amt;
    } else {
      rows.push({ userId, amount: Math.max(0, Math.floor(pool) - allocated) }); // 尾差给最后一人，保证总额守恒
    }
  });
  return rows;
}

function resolveEffectSpec(
  spec: EffectSpecFree,
  env: Record<string, unknown>,
  stateData: Record<string, unknown>,
  seed?: string,
): Effect {
  const p = `effect(${spec.type})`;
  const num = (v: NumVal | undefined, field: string, opts?: { nonNegative?: boolean }): number => {
    if (v === undefined) throw new TypeError(`${p}: 缺少 ${field}`);
    const n = resolveNum(v, env, `${p}.${field}`, seed);
    if (opts?.nonNegative && n < 0) throw new TypeError(`${p}.${field} 不得为负`);
    return n;
  };
  const str = (v: string | undefined, field: string): string => {
    if (v === undefined) throw new TypeError(`${p}: 缺少 ${field}`);
    const s = resolveStr(v, env, p, seed);
    if (s === undefined) throw new TypeError(`${p}: 缺少 ${field}`);
    return s;
  };
  switch (spec.type) {
    case 'freezeVoucher':
      return { type: 'freezeVoucher', voucherId: str(spec.voucherId, 'voucherId'), reason: str(spec.reason, 'reason') };
    case 'unfreezeVoucher':
      return { type: 'unfreezeVoucher', voucherId: str(spec.voucherId, 'voucherId'), reason: str(spec.reason, 'reason') };
    case 'transferVoucher':
      return {
        type: 'transferVoucher',
        voucherId: str(spec.voucherId, 'voucherId'),
        fromUserId: resolveStr(spec.fromUserId, env, p, seed),
        toUserId: str(spec.toUserId, 'toUserId'),
        reason: str(spec.reason, 'reason'),
      };
    case 'mintVoucher': {
      if (!spec.voucher) throw new TypeError(`${p}: 缺少 voucher`);
      const vs = spec.voucher;
      return {
        type: 'mintVoucher',
        toUserId: str(spec.toUserId, 'toUserId'),
        voucher: {
          schemaName: resolveStr(vs.schemaName, env, p, seed) ?? '',
          title: resolveStr(vs.title, env, p, seed) ?? '',
          denomination: vs.denomination !== undefined ? num(vs.denomination, 'voucher.denomination') : undefined,
          metadata: vs.metadata,
        },
        reason: str(spec.reason, 'reason'),
      };
    }
    case 'walletTransfer': {
      return {
        type: 'walletTransfer',
        toUserId: str(spec.toUserId, 'toUserId'),
        currency: resolveCurrency(spec.currency, env, `${p}.currency`, seed) as Currency,
        amount: num(spec.amount, 'amount', { nonNegative: true }),
        fromUserId: resolveStr(spec.fromUserId, env, p, seed),
        purpose: resolveStr(spec.purpose, env, p, seed),
        reason: str(spec.reason, 'reason'),
      };
    }
    case 'treasuryDeposit': {
      return {
        type: 'treasuryDeposit',
        currency: resolveCurrency(spec.currency, env, `${p}.currency`, seed) as Currency,
        amount: num(spec.amount, 'amount', { nonNegative: true }),
        reason: str(spec.reason, 'reason'),
      };
    }
    case 'splitPayout': {
      const source = resolveStr(spec.source, env, p, seed);
      return {
        type: 'splitPayout',
        currency: resolveCurrency(spec.currency, env, `${p}.currency`, seed) as Currency,
        table: resolveTable(spec.table, stateData, env, seed),
        purpose: resolveStr(spec.purpose, env, p, seed),
        source: source === 'treasury' ? 'treasury' : 'escrow',
        reason: str(spec.reason, 'reason'),
      };
    }
    case 'mintShareVouchers': {
      const rows = resolveTable(spec.table, stateData, env, seed);
      // rows 为 (userId, 认购额) → 计算份额 share = amount / 总额
      const total = rows.reduce((s, r) => s + r.amount, 0);
      if (total <= 0) throw new TypeError(`${p}: 认购总额为 0，无法铸收益分成凭证`);
      const lockupMs = num(spec.lockupMs ?? 0, 'lockupMs', { nonNegative: true });
      return {
        type: 'mintShareVouchers',
        currency: resolveCurrency(spec.currency, env, `${p}.currency`, seed) as Currency,
        rows: rows.map((r) => ({ userId: r.userId, amount: r.amount, share: r.amount / total })),
        lockupMs,
        reason: str(spec.reason, 'reason'),
      };
    }
    case 'refundAll':
      return { type: 'refundAll', purpose: resolveStr(spec.purpose, env, p, seed), reason: str(spec.reason, 'reason') };
    case 'grantGovernanceWeight': {
      const bps = spec.weightBps ?? spec.bps;
      return {
        type: 'grantGovernanceWeight',
        gameId: str(spec.gameId, 'gameId'),
        toUserId: str(spec.toUserId, 'toUserId'),
        topic: str(spec.topic, 'topic'),
        weightBps: num(bps, 'weightBps'),
        reason: str(spec.reason, 'reason'),
      };
    }
    case 'penalize': {
      if (!spec.forfeitTo) throw new TypeError(`${p}: 缺少 forfeitTo`);
      return {
        type: 'penalize',
        userId: str(spec.userId, 'userId'),
        currency: resolveCurrency(spec.currency, env, `${p}.currency`, seed) as Currency,
        amount: num(spec.amount, 'amount', { nonNegative: true }),
        forfeitTo: spec.forfeitTo,
        purpose: resolveStr(spec.purpose, env, p, seed),
        reason: str(spec.reason, 'reason'),
      };
    }
    case 'setState': {
      const to = resolveStr(spec.to, env, p, seed);
      if (to === undefined) throw new TypeError(`${p}: 缺少 to`);
      if (!STATES_SET.has(to)) throw new TypeError(`${p}: 非法目标状态 "${to}"`);
      return { type: 'setState', to: to as ContractState, reason: str(spec.reason, 'reason') };
    }
    case 'openDispute':
      return { type: 'openDispute', byUserId: str(spec.byUserId, 'byUserId'), reason: str(spec.reason, 'reason') };
    case 'notify':
      return {
        type: 'notify',
        message: resolveStr(spec.message, env, p, seed) ?? '',
        toUserIds: spec.toUserIds ? spec.toUserIds.map((u) => resolveStr(u, env, p, seed) ?? u) : undefined,
      };
    default:
      throw new TypeError(`未知 EffectType: ${String((spec as { type?: unknown }).type)}`);
  }
}

// ============================================================
// 入口：executeTrigger
// ============================================================

export interface ExecuteOptions {
  now: number;
}

export function executeTrigger(
  instance: ContractInstance,
  ev: TriggerEvent,
  opts: ExecuteOptions,
): ExecuteResult {
  // 1. 幂等
  if (hasTriggerEvent(instance, ev.triggerId)) {
    return { plan: null, reason: 'duplicate-trigger' };
  }

  const env: Record<string, unknown> = {
    state: instance.stateData,
    params: instance.params,
    event: ev.payload,
    now: opts.now,
  };

  const matchedEffects: Effect[] = [];
  const matchedClauseIds: string[] = [];
  const updates: StateUpdate[] = [];
  let nextState: ContractState | undefined;
  let anyMatched = false;

  for (const clause of instance.clauses) {
    if (!triggerMatches(clause.on, ev)) continue;
    anyMatched = true;

    // channelToken 强制门（TeamQuest 事实源）
    if (clause.on.requiresChannelToken && ev.kind === 'protocol' && ev.channelTokenValid !== true) {
      return {
        plan: null,
        reason: 'rejected',
        reasonDetail: `条款 ${clause.id} 要求 channelToken 校验通过的协议事件`,
      };
    }

    // 状态门
    const enabled = clause.on.enabledStates ?? DEFAULT_ENABLED_STATES;
    if (!enabled.includes(instance.state)) continue;

    // 条件门
    if (clause.when !== undefined) {
      let cond: unknown;
      try {
        cond = evaluateExpression(clause.when, { vars: env, seed: instance.seed });
      } catch (e) {
        return { plan: null, reason: 'eval-error', reasonDetail: `条款 ${clause.id} when 求值失败: ${(e as Error).message}` };
      }
      if (!cond) continue;
    }

    // Effect 解析
    for (const spec of clause.then) {
      try {
        matchedEffects.push(resolveEffectSpec(spec, env, instance.stateData, instance.seed));
      } catch (e) {
        return { plan: null, reason: 'eval-error', reasonDetail: `条款 ${clause.id} effect 解析失败: ${(e as Error).message}` };
      }
    }
    matchedClauseIds.push(clause.id);

    // stateData 更新
    for (const u of clause.updates ?? []) {
      try {
        if (u.op === 'push') {
          const userId = evalString((u.userIdExpr ?? 'event.userId').trim().startsWith('expr:')
            ? (u.userIdExpr ?? '').slice(5).trim()
            : (u.userIdExpr ?? 'event.userId'), { vars: env, seed: instance.seed });
          const amount = evalNumber((u.amountExpr ?? '0').trim().startsWith('expr:')
            ? (u.amountExpr ?? '').slice(5).trim()
            : (u.amountExpr ?? '0'), { vars: env, seed: instance.seed });
          updates.push({ field: u.field, op: 'push', userId, amount });
        } else {
          const v = resolveNum(u.value, env, `updates.${u.field}`, instance.seed);
          updates.push({ field: u.field, op: u.op, value: v });
        }
      } catch (e) {
        return { plan: null, reason: 'eval-error', reasonDetail: `条款 ${clause.id} updates.${u.field} 求值失败: ${(e as Error).message}` };
      }
    }

    // 状态迁移（取最后一个 setState）
    for (const eff of clause.then) {
      if (eff.type === 'setState' && typeof eff.to === 'string' && !eff.to.startsWith('expr:')) {
        nextState = eff.to as ContractState;
      } else if (eff.type === 'setState' && typeof eff.to === 'string') {
        const s = evalString(eff.to.slice(5).trim(), { vars: env, seed: instance.seed });
        nextState = s as ContractState;
      }
    }
  }

  if (!anyMatched) {
    return { plan: null, reason: 'no-matching-clause' };
  }
  if (matchedClauseIds.length === 0) {
    // 有条款匹配了触发器，但被状态门/条件门拦下
    return { plan: null, reason: 'condition-not-met' };
  }

  // 状态迁移校验
  if (nextState !== undefined && !isValidTransition(instance.state, nextState)) {
    return {
      plan: null,
      reason: 'rejected',
      reasonDetail: `非法状态迁移 ${instance.state} → ${nextState}`,
    };
  }

  return {
    plan: {
      contractId: instance.id,
      templateKey: instance.templateKey,
      clauseIds: matchedClauseIds,
      idempotencyKey: `${instance.id}:${ev.triggerId}`,
      trigger: ev,
      effects: matchedEffects,
      updates,
      nextState,
      shadow: !instance.autoExecute,
      createdAt: opts.now,
    },
  };
}

// ============================================================
// stateData 应用（runtime 在 Effect 全部执行成功后调用）
// ============================================================

function cloneDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(cloneDeep);
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = cloneDeep(val);
    return out;
  }
  return v;
}

/** 纯函数：返回应用更新后的新 stateData（不修改入参） */
export function applyUpdates(
  stateData: Record<string, unknown>,
  updates: StateUpdate[],
): Record<string, unknown> {
  const next = cloneDeep(stateData) as Record<string, unknown>;
  for (const u of updates) {
    const segs = u.field.split('.');
    let cur: Record<string, unknown> = next;
    for (let i = 0; i < segs.length - 1; i++) {
      const seg = segs[i];
      if (typeof cur[seg] !== 'object' || cur[seg] === null) cur[seg] = {};
      cur = cur[seg] as Record<string, unknown>;
    }
    const leaf = segs[segs.length - 1];
    if (u.op === 'push') {
      if (!Array.isArray(cur[leaf])) cur[leaf] = [];
      (cur[leaf] as unknown[]).push({ userId: u.userId, amount: u.amount });
    } else if (u.op === 'set') {
      cur[leaf] = u.value;
    } else {
      const prev = typeof cur[leaf] === 'number' ? cur[leaf] : 0;
      cur[leaf] = prev + (u.value ?? 0);
    }
  }
  return next;
}
