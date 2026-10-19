/**
 * 静态校验（纯函数）
 *
 * 职责：
 * - validateParams      模板参数 vs paramsSchema（类型/必填/范围/枚举/嵌套）
 * - validateEffectSpec  Effect 声明 vs 模板白名单（类型/必填字段/表达式 lint/数值范围）
 * - validateTemplate    模板整体（clauses 静态检查 + initialState 合法性）
 * - isValidTransition   状态机合法迁移
 *
 * 所有 'expr:' 表达式在部署时 lint 一遍，坏表达式进不了链（fail-fast）。
 */
import { lintExpression } from './evaluate.js';
import type {
  Clause,
  ContractState,
  ContractTemplate,
  Currency,
  EffectSpecFree,
  EffectType,
  ParamFieldRule,
} from '../types.js';

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
}

// ============================================================
// 状态机
// ============================================================

export const STATE_TRANSITIONS: Record<ContractState, ContractState[]> = {
  draft: ['signing', 'terminated'],
  // signing 可直达 active（TeamQuest 开团）/settling/refunded（GroupBuy/TeamQuest 族）
  signing: ['funded', 'active', 'settling', 'refunded', 'terminated'],
  funded: ['active', 'settling', 'refunded', 'terminated'],
  active: ['settling', 'disputed', 'refunded', 'breached', 'terminated'],
  settling: ['fulfilled', 'refunded', 'disputed', 'breached'],
  fulfilled: [],
  breached: ['terminated'],
  disputed: ['settling', 'refunded', 'terminated'],
  refunded: [],
  terminated: [],
};

export const ALL_STATES: ContractState[] = [
  'draft', 'signing', 'funded', 'active', 'settling',
  'fulfilled', 'breached', 'disputed', 'refunded', 'terminated',
];

export function isContractState(v: unknown): v is ContractState {
  return typeof v === 'string' && (ALL_STATES as string[]).includes(v);
}

export function isValidTransition(from: ContractState, to: ContractState): boolean {
  return STATE_TRANSITIONS[from]?.includes(to) ?? false;
}

// ============================================================
// 参数校验
// ============================================================

function checkField(
  rule: ParamFieldRule,
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): void {
  if (value === undefined || value === null) {
    if (rule.required) issues.push({ path, message: '缺少必填字段' });
    return;
  }
  switch (rule.type) {
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        issues.push({ path, message: `必须是数字，实际 ${typeof value}` });
        return;
      }
      if (rule.min !== undefined && value < rule.min) issues.push({ path, message: `不得小于 ${rule.min}，实际 ${value}` });
      if (rule.max !== undefined && value > rule.max) issues.push({ path, message: `不得大于 ${rule.max}，实际 ${value}` });
      return;
    }
    case 'string': {
      if (typeof value !== 'string') {
        issues.push({ path, message: `必须是字符串，实际 ${typeof value}` });
        return;
      }
      if (rule.min !== undefined && value.length < rule.min) issues.push({ path, message: `长度不得小于 ${rule.min}` });
      if (rule.max !== undefined && value.length > rule.max) issues.push({ path, message: `长度不得大于 ${rule.max}` });
      return;
    }
    case 'boolean': {
      if (typeof value !== 'boolean') issues.push({ path, message: `必须是布尔，实际 ${typeof value}` });
      return;
    }
    case 'enum': {
      if (!rule.enumValues || rule.enumValues.length === 0) {
        issues.push({ path, message: '模板定义错误：enum 规则缺少 enumValues' });
        return;
      }
      if (!rule.enumValues.includes(value as string | number)) {
        issues.push({ path, message: `必须是 ${rule.enumValues.join(' / ')} 之一，实际 ${JSON.stringify(value)}` });
      }
      return;
    }
    case 'array': {
      if (!Array.isArray(value)) {
        issues.push({ path, message: `必须是数组，实际 ${typeof value}` });
        return;
      }
      if (rule.minItems !== undefined && value.length < rule.minItems) issues.push({ path, message: `元素数不得小于 ${rule.minItems}` });
      if (rule.maxItems !== undefined && value.length > rule.maxItems) issues.push({ path, message: `元素数不得大于 ${rule.maxItems}` });
      if (rule.itemRule) {
        value.forEach((item, i) => checkField(rule.itemRule!, item, `${path}[${i}]`, issues));
      }
      return;
    }
    case 'object': {
      if (typeof value !== 'object' || Array.isArray(value)) {
        issues.push({ path, message: `必须是对象，实际 ${typeof value}` });
        return;
      }
      if (rule.fields) {
        const obj = value as Record<string, unknown>;
        for (const [k, sub] of Object.entries(rule.fields)) {
          checkField(sub, obj[k], `${path}.${k}`, issues);
        }
      }
      return;
    }
    default:
      issues.push({ path, message: `模板定义错误：未知规则类型 ${String((rule as ParamFieldRule).type)}` });
  }
}

export function validateParams(
  schema: Record<string, ParamFieldRule>,
  params: Record<string, unknown>,
): ValidationResult {
  const issues: ValidationIssue[] = [];
  if (typeof params !== 'object' || params === null) {
    return { ok: false, issues: [{ path: 'params', message: 'params 必须是对象' }] };
  }
  for (const [key, rule] of Object.entries(schema)) {
    checkField(rule, params[key], `params.${key}`, issues);
  }
  // 未知字段：参数面封闭（防夹带）
  for (const key of Object.keys(params)) {
    if (!(key in schema)) {
      issues.push({ path: `params.${key}`, message: '未知字段（参数面封闭，未在 paramsSchema 中声明）' });
    }
  }
  return { ok: issues.length === 0, issues };
}

// ============================================================
// Effect 声明校验
// ============================================================

const EFFECT_TYPES: EffectType[] = [
  'freezeVoucher', 'unfreezeVoucher', 'transferVoucher', 'mintVoucher', 'mintShareVouchers',
  'walletTransfer', 'treasuryDeposit', 'splitPayout', 'refundAll',
  'grantGovernanceWeight', 'penalize', 'setState', 'openDispute', 'notify',
];

/** 各 EffectType 的必填字段（type 之外） */
const REQUIRED_FIELDS: Record<EffectType, string[]> = {
  freezeVoucher: ['voucherId', 'reason'],
  unfreezeVoucher: ['voucherId', 'reason'],
  transferVoucher: ['voucherId', 'toUserId', 'reason'],
  mintVoucher: ['toUserId', 'voucher', 'reason'],
  mintShareVouchers: ['currency', 'table', 'lockupMs', 'reason'],
  walletTransfer: ['toUserId', 'currency', 'amount', 'reason'],
  treasuryDeposit: ['currency', 'amount', 'reason'],
  splitPayout: ['currency', 'table', 'reason'],
  refundAll: ['reason'],
  grantGovernanceWeight: ['gameId', 'toUserId', 'topic', 'weightBps', 'reason'],
  penalize: ['userId', 'currency', 'amount', 'forfeitTo', 'reason'],
  setState: ['to', 'reason'],
  openDispute: ['byUserId', 'reason'],
  notify: ['message'],
};

const CURRENCIES: Currency[] = ['gameCoins', 'aCoins'];
const FORFEIT_TARGETS = ['rewardPool', 'treasury', 'members'];

/** 'expr:' 前缀的字符串按 DSL lint；其余静态值按 kind 校验 */
function checkVal(
  v: unknown,
  kind: 'num' | 'str' | 'state',
  path: string,
  issues: ValidationIssue[],
): void {
  if (typeof v === 'string' && v.startsWith('expr:')) {
    const lint = lintExpression(v.slice(5).trim());
    if (!lint.ok) issues.push({ path, message: `表达式语法错误：${lint.error}` });
    return;
  }
  switch (kind) {
    case 'num':
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        issues.push({ path, message: `必须是数字或 'expr:' 表达式，实际 ${JSON.stringify(v)}` });
      }
      break;
    case 'str':
      if (typeof v !== 'string') {
        issues.push({ path, message: `必须是字符串或 'expr:' 表达式，实际 ${typeof v}` });
      }
      break;
    case 'state':
      if (!isContractState(v)) {
        issues.push({ path, message: `必须是合法合约状态，实际 ${JSON.stringify(v)}` });
      }
      break;
  }
}

export function validateEffectSpec(
  spec: EffectSpecFree,
  whitelist: EffectType[],
  path: string,
  issues: ValidationIssue[],
): void {
  if (!EFFECT_TYPES.includes(spec.type)) {
    issues.push({ path, message: `未知 EffectType "${String(spec.type)}"` });
    return;
  }
  if (!whitelist.includes(spec.type)) {
    issues.push({ path, message: `Effect "${spec.type}" 不在模板白名单内（白名单：${whitelist.join(' ')}）` });
    return;
  }
  for (const f of REQUIRED_FIELDS[spec.type]) {
    if ((spec as unknown as Record<string, unknown>)[f] === undefined) {
      issues.push({ path, message: `缺少必填字段 "${f}"` });
    }
  }
  // 数值字段
  if (spec.amount !== undefined) {
    checkVal(spec.amount, 'num', `${path}.amount`, issues);
    if (typeof spec.amount === 'number' && spec.amount < 0) {
      issues.push({ path, message: 'amount 不得为负' });
    }
  }
  if (spec.bps !== undefined || spec.weightBps !== undefined) {
    const bps = spec.bps ?? spec.weightBps;
    checkVal(bps, 'num', `${path}.bps`, issues);
    if (typeof bps === 'number' && (bps < 0 || bps > 10000)) {
      issues.push({ path, message: 'bps 必须在 0..10000' });
    }
  }
  if (spec.to !== undefined) checkVal(spec.to, 'state', `${path}.to`, issues);
  if (spec.purpose !== undefined) checkVal(spec.purpose, 'str', `${path}.purpose`, issues);
  if (spec.currency !== undefined && !spec.currency.startsWith('expr:') && !(CURRENCIES as string[]).includes(spec.currency)) {
    issues.push({ path, message: `currency 必须是 ${CURRENCIES.join(' / ')} 或 'expr:' 表达式` });
  }
  if (spec.forfeitTo !== undefined && !FORFEIT_TARGETS.includes(spec.forfeitTo)) {
    issues.push({ path, message: `forfeitTo 必须是 ${FORFEIT_TARGETS.join(' / ')}` });
  }
  if (spec.voucher !== undefined) {
    if (!spec.voucher.schemaName || !spec.voucher.title) {
      issues.push({ path, message: 'mintVoucher.voucher 缺少 schemaName/title' });
    }
    if (spec.voucher.denomination !== undefined) {
      checkVal(spec.voucher.denomination, 'num', `${path}.voucher.denomination`, issues);
    }
  }
  if (spec.table !== undefined) {
    const t = spec.table;
    if (t.kind === 'literal') {
      if (!Array.isArray(t.rows)) {
        issues.push({ path, message: 'table.literal.rows 必须是数组' });
      } else {
        t.rows.forEach((r, i) => {
          if (!r.userId || typeof r.amount !== 'number' || r.amount <= 0) {
            issues.push({ path, message: `table.rows[${i}] 需要 userId 与正数 amount` });
          }
        });
      }
    } else if (t.kind === 'byField') {
      if (!t.stateField || !t.amountField) {
        issues.push({ path, message: 'table.byField 需要 stateField 与 amountField' });
      }
      if (t.mode === 'share' && t.poolAmount === undefined) {
        issues.push({ path, message: 'table.byField share 模式必须声明 poolAmount' });
      }
      if (t.poolAmount !== undefined) checkVal(t.poolAmount, 'num', `${path}.table.poolAmount`, issues);
    } else {
      issues.push({ path, message: `未知 table.kind "${String((t as { kind?: string }).kind)}"` });
    }
  }
}

// ============================================================
// 条款 / 模板校验
// ============================================================

const FIELD_PATH_RE = /^[a-zA-Z_$][\w$]*(\.[a-zA-Z_$][\w$]*)*$/;

export function validateClauses(
  clauses: Clause[],
  whitelist: EffectType[],
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  clauses.forEach((clause, ci) => {
    const cPath = `clauses[${ci}](${clause.id || '?'})`;
    if (!clause.id) issues.push({ path: cPath, message: '缺少条款 id' });
    if (!clause.title) issues.push({ path: cPath, message: '缺少条款 title' });
    const on = clause.on;
    if (!on || !on.id) issues.push({ path: `${cPath}.on`, message: '缺少触发器 id' });
    const kinds = ['event', 'protocol', 'cron', 'manual'];
    if (!kinds.includes(on?.kind)) {
      issues.push({ path: `${cPath}.on`, message: `kind 必须是 ${kinds.join(' / ')}` });
    } else {
      if (on.kind === 'event' || on.kind === 'protocol') {
        if (!on.match) issues.push({ path: `${cPath}.on`, message: `${on.kind} 触发器必须声明 match 事件名` });
      }
      if (on.kind === 'manual' && !on.action) {
        issues.push({ path: `${cPath}.on`, message: 'manual 触发器必须声明 action 动作名' });
      }
      if (on.kind === 'cron' && !on.schedule) {
        issues.push({ path: `${cPath}.on`, message: 'cron 触发器必须声明 schedule 调度名' });
      }
    }
    if (on?.enabledStates) {
      on.enabledStates.forEach((s, i) => {
        if (!isContractState(s)) issues.push({ path: `${cPath}.on.enabledStates[${i}]`, message: `非法状态 "${String(s)}"` });
      });
    }
    if (clause.when !== undefined) {
      const lint = lintExpression(clause.when);
      if (!lint.ok) issues.push({ path: `${cPath}.when`, message: `表达式语法错误：${lint.error}` });
    }
    if (!Array.isArray(clause.then) || clause.then.length === 0) {
      issues.push({ path: `${cPath}.then`, message: '条款必须声明至少一个 Effect' });
    } else {
      clause.then.forEach((spec, ei) => {
        validateEffectSpec(spec, whitelist, `${cPath}.then[${ei}]`, issues);
      });
    }
    (clause.updates ?? []).forEach((u, ui) => {
      const uPath = `${cPath}.updates[${ui}]`;
      if (!FIELD_PATH_RE.test(u.field)) {
        issues.push({ path: uPath, message: `非法字段路径 "${u.field}"` });
      }
      if (u.op !== 'add' && u.op !== 'set' && u.op !== 'push') {
        issues.push({ path: uPath, message: `op 必须是 add/set/push，实际 "${String(u.op)}"` });
      }
      if (u.op === 'push') {
        if (!u.userIdExpr || !u.amountExpr) {
          issues.push({ path: uPath, message: 'push 需要声明 userIdExpr 与 amountExpr' });
        } else {
          const l1 = lintExpression(u.userIdExpr);
          if (!l1.ok) issues.push({ path: uPath, message: `userIdExpr 语法错误：${l1.error}` });
          const l2 = lintExpression(u.amountExpr);
          if (!l2.ok) issues.push({ path: uPath, message: `amountExpr 语法错误：${l2.error}` });
        }
      } else {
        checkVal(u.value, 'num', `${uPath}.value`, issues);
      }
    });
  });
  return issues;
}

export function validateTemplate(tpl: ContractTemplate): ValidationResult {
  const issues: ValidationIssue[] = [];
  if (!tpl.key) issues.push({ path: 'key', message: '缺少模板 key' });
  if (!Number.isInteger(tpl.version) || tpl.version < 1) {
    issues.push({ path: 'version', message: 'version 必须是 ≥1 整数' });
  }
  if (tpl.family !== 'community_revenue' && tpl.family !== 'teamup') {
    issues.push({ path: 'family', message: `family 必须是 community_revenue / teamup` });
  }
  if (!Array.isArray(tpl.effectsWhitelist) || tpl.effectsWhitelist.length === 0) {
    issues.push({ path: 'effectsWhitelist', message: '必须声明非空 Effect 白名单' });
  } else {
    tpl.effectsWhitelist.forEach((e, i) => {
      if (!EFFECT_TYPES.includes(e)) issues.push({ path: `effectsWhitelist[${i}]`, message: `未知 EffectType "${String(e)}"` });
    });
  }
  if (!isContractState(tpl.initialState)) {
    issues.push({ path: 'initialState', message: `非法初始状态 "${String(tpl.initialState)}"` });
  }
  if (!Array.isArray(tpl.clauses) || tpl.clauses.length === 0) {
    issues.push({ path: 'clauses', message: '模板必须声明至少一条条款' });
  }
  const clauseIssues = validateClauses(tpl.clauses ?? [], tpl.effectsWhitelist ?? []);
  issues.push(...clauseIssues);
  return { ok: issues.length === 0, issues };
}
