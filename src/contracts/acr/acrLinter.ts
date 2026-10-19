/**
 * ACR（AllinONE Contract Reference）安全 Linter — CW-0
 *
 * 在 validateTemplate（结构校验）之上叠加 UGC 模板安全级检查（协议规范 ACR-1/2/3）：
 * - ACR-1 核心标准：key 命名空间 / 规模上限 / 触发器约束（cron 白名单、保留动作名）
 * - ACR-2 资金安全：灰名单 Effect（铸币/罚没/治理权）、资金守恒（出账收款方封闭）、退款可达性
 * - ACR-3 治理接口：grantGovernanceWeight / settlement-* cron 为平台特权，UGC 禁用
 *
 * 设计铁律：纯函数、零依赖（只 import ../types.js 与 ../engine/validate.js）。
 * AI 生成与人工导入的模板都必须通过 validateUgcTemplate 才能进入注册中心。
 */
import type { ContractTemplate, EffectSpecFree, EffectType, Clause } from '../types.js';
import { validateTemplate } from '../engine/validate.js';
import type { ValidationIssue, ValidationResult } from '../engine/validate.js';

export const ACR_SPEC_VERSION = 'ACR-1/2/3';

/** UGC 模板 key 命名空间：ugc_<slug>（服务端注册时强制 ugc_<authorId>_<slug>） */
export const UGC_KEY_RE = /^ugc_[a-z0-9][a-z0-9_-]{2,60}$/;

/** 官方模板键（UGC 不得占用） */
export const RESERVED_TEMPLATE_KEYS = ['gso', 'team-quest', 'group-buy'];

/** 规模上限（防状态膨胀 / DoS） */
export const UGC_MAX_CLAUSES = 50;
export const UGC_MAX_EFFECTS_PER_CLAUSE = 12;
export const UGC_MAX_FIELD_DEPTH = 3;
export const UGC_MAX_SERIALIZED_BYTES = 256 * 1024;

/** 灰名单：平台特权 Effect，UGC 模板一律禁用（提案解锁走治理，后续放开需改此处） */
export const UGC_FORBIDDEN_EFFECTS: EffectType[] = [
  'mintVoucher', // 凭证铸造 = 平台货币主权
  'mintShareVouchers', // GSO 专用
  'grantGovernanceWeight', // 治理权重 = 平台主权
  'treasuryDeposit', // 直接入平台金库（走 market 佣金路径）
];

/** 受控名单：penalize 仅允许针对事件当事人本人（expr: event.userId），且必须 requiresAudit */
const CONTROLLED_EFFECTS: EffectType[] = ['penalize'];

/** cron 调度白名单：settlement-weekly/monthly 为 GSO 平台特权（收益注入 revenue_ledger 口径） */
const ALLOWED_SCHEDULES = ['deadline-check', 'tick-5m'];

/** 隧道保留动作名（manual action 不得占用，防与 invoke 内部协议冲突） */
const RESERVED_ACTIONS = ['__protocol', 'deploy', 'sign', 'invoke', 'tick', 'query', 'detail', 'verify', 'escrow'];

/** 低风险 Effect 集：无资金、无资产、无单方损害能力 */
export const LOW_RISK_EFFECTS: EffectType[] = ['setState', 'notify', 'openDispute'];

// ============================================================
// 工具
// ============================================================

function isExpr(v: unknown): v is string {
  return typeof v === 'string' && v.startsWith('expr:');
}

/** 'expr: params.foo.bar' → 'params.foo.bar'；非表达式返回 null */
function exprBody(v: string): string {
  return v.slice(5).trim();
}

/** 表达式首段（'params.foo' → 'params'） */
function exprFirstSegment(body: string): string {
  return body.split('.')[0].trim();
}

function fieldDepth(field: string): number {
  return field.split('.').length;
}

/** effectsWhitelist 中是否声明了给定 effect（供外部消费） */
function whitelists(tpl: ContractTemplate, e: EffectType): boolean {
  return (tpl.effectsWhitelist || []).includes(e);
}
void whitelists;

/** paramsSchema 中声明的字符串字段名集合（合法收款方参数面） */
function declaredStringParams(tpl: ContractTemplate): Set<string> {
  const out = new Set<string>();
  for (const [k, rule] of Object.entries(tpl.paramsSchema || {})) {
    if (rule?.type === 'string' || rule?.type === 'enum') out.add(k);
  }
  return out;
}

// ============================================================
// ACR-2 资金安全：出账收款方封闭 + 退款可达性
// ============================================================

/**
 * 出账（fromUserId 缺省/='escrow'，即从托管释放）时 toUserId 的合法面：
 * - 'expr: event.userId'            —— 事件当事人（最常见：退款给本人）
 * - 'expr: params.<declared-string>' —— 部署者声明的收款方字段（paramsSchema string/enum 声明）
 * 硬编码字面量收款人（作者把自己的 ID 写死在条款里）一律拒绝。
 */
function checkOutgoingRecipient(
  spec: EffectSpecFree,
  tpl: ContractTemplate,
  path: string,
  issues: ValidationIssue[],
): void {
  const toUserId = spec.toUserId;
  if (toUserId === undefined || toUserId === 'escrow') return; // 入托管，不查
  if (typeof toUserId === 'string' && isExpr(toUserId)) {
    const body = exprBody(toUserId);
    if (body === 'event.userId') return;
    if (exprFirstSegment(body) === 'params') {
      const paramName = body.split('.')[1]?.trim();
      if (paramName && declaredStringParams(tpl).has(paramName)) return;
      issues.push({
        path,
        message: `出账收款方表达式 "${toUserId}" 引用的参数未在 paramsSchema 中以 string/enum 声明（ACR-2）`,
      });
      return;
    }
    issues.push({ path, message: `出账收款方表达式 "${toUserId}" 非法：只允许 event.userId 或 params.<声明字段>（ACR-2）` });
    return;
  }
  issues.push({
    path,
    message: `出账收款方不得硬编码（实际 ${JSON.stringify(toUserId)}）：只能用 'expr: event.userId' 或 'expr: params.<声明字段>'（ACR-2 资金守恒）`,
  });
}

/** 入托管（walletTransfer toUserId='escrow'）时 fromUserId 的合法面：event.userId / params 声明字段 */
function checkEscrowInSource(spec: EffectSpecFree, tpl: ContractTemplate, path: string, issues: ValidationIssue[]): void {
  if (spec.fromUserId === undefined) return; // 缺省=escrow，不存在"入托管缺省"
  if (typeof spec.fromUserId === 'string' && isExpr(spec.fromUserId)) {
    const body = exprBody(spec.fromUserId);
    if (body === 'event.userId') return;
    if (exprFirstSegment(body) === 'params') {
      const paramName = body.split('.')[1]?.trim();
      if (paramName && declaredStringParams(tpl).has(paramName)) return;
    }
  }
  issues.push({
    path,
    message: `入托管出资方 "${String(spec.fromUserId)}" 非法：只能扣事件当事人（event.userId）或 params 声明字段的钱（ACR-2 防偷转他人资金）`,
  });
}

function clauseHasEscrowIn(clause: Clause): boolean {
  return (clause.then || []).some(
    (e) => e.type === 'walletTransfer' && (e.toUserId === 'escrow' || e.toUserId === 'expr: escrow'),
  );
}

function clauseHasRelease(clause: Clause): boolean {
  return (clause.then || []).some((e) => {
    if (e.type === 'refundAll') return true;
    if (e.type === 'penalize') return true; // 罚没也是托管资金的出口（进金库）
    if (e.type === 'walletTransfer') return e.toUserId !== 'escrow';
    if (e.type === 'splitPayout') return e.source !== 'treasury';
    return false;
  });
}

// ============================================================
// 主 Linter
// ============================================================

export function lintUgcTemplate(tpl: ContractTemplate): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const wl = tpl.effectsWhitelist || [];

  // ---- ACR-1：key 命名空间与保留键 ----
  if (typeof tpl.key !== 'string' || !UGC_KEY_RE.test(tpl.key)) {
    issues.push({ path: 'key', message: `UGC 模板 key 必须匹配 ${UGC_KEY_RE}（命名空间隔离）` });
  }
  if (RESERVED_TEMPLATE_KEYS.includes(String(tpl.key))) {
    issues.push({ path: 'key', message: `key "${String(tpl.key)}" 是官方模板保留键` });
  }

  // ---- ACR-1：规模上限 ----
  const clauses = Array.isArray(tpl.clauses) ? tpl.clauses : [];
  if (clauses.length > UGC_MAX_CLAUSES) {
    issues.push({ path: 'clauses', message: `条款数 ${clauses.length} 超过上限 ${UGC_MAX_CLAUSES}` });
  }
  try {
    const size = JSON.stringify(tpl).length;
    if (size > UGC_MAX_SERIALIZED_BYTES) {
      issues.push({ path: 'clauses', message: `模板序列化体积 ${size}B 超过上限 ${UGC_MAX_SERIALIZED_BYTES}B` });
    }
  } catch {
    issues.push({ path: 'clauses', message: '模板包含不可序列化内容' });
  }

  // ---- ACR-3 / ACR-2：灰名单 Effect ----
  for (const [i, e] of wl.entries()) {
    if (UGC_FORBIDDEN_EFFECTS.includes(e)) {
      issues.push({ path: `effectsWhitelist[${i}]`, message: `Effect "${e}" 为平台特权，UGC 模板禁用（ACR-3）` });
    }
  }

  // ---- ACR-2：托管流分析（先聚合，供可达性判定） ----
  let hasEscrowIn = false;
  let hasAnyRelease = false;

  clauses.forEach((clause, ci) => {
    const cPath = `clauses[${ci}](${clause?.id || '?'})`;

    // ---- ACR-1：触发器约束 ----
    const on = clause?.on;
    if (on?.kind === 'cron' && !ALLOWED_SCHEDULES.includes(String(on.schedule))) {
      issues.push({
        path: `${cPath}.on.schedule`,
        message: `cron 调度 "${String(on.schedule)}" 不在 UGC 白名单 [${ALLOWED_SCHEDULES.join(' / ')}]（settlement-* 为 GSO 平台特权）`,
      });
    }
    if (on?.kind === 'manual' && RESERVED_ACTIONS.includes(String(on.action))) {
      issues.push({ path: `${cPath}.on.action`, message: `manual 动作名 "${String(on.action)}" 为隧道保留字` });
    }

    // ---- ACR-1：updates 字段深度 ----
    (clause?.updates || []).forEach((u, ui) => {
      if (fieldDepth(String(u.field || '')) > UGC_MAX_FIELD_DEPTH) {
        issues.push({ path: `${cPath}.updates[${ui}].field`, message: `字段路径 "${u.field}" 深度超过 ${UGC_MAX_FIELD_DEPTH}（防状态膨胀）` });
      }
      if (u.op === 'push') {
        // push 记录集也计入规模：每条款 push 声明数已由结构限制，这里只查总量
      }
    });

    // ---- ACR-1：单条款 Effect 数上限 ----
    const then = Array.isArray(clause?.then) ? clause.then : [];
    if (then.length > UGC_MAX_EFFECTS_PER_CLAUSE) {
      issues.push({ path: `${cPath}.then`, message: `单条款 Effect 数 ${then.length} 超过上限 ${UGC_MAX_EFFECTS_PER_CLAUSE}` });
    }

    const escIn = clauseHasEscrowIn(clause);
    const rel = clauseHasRelease(clause);
    if (escIn) hasEscrowIn = true;
    if (rel) hasAnyRelease = true;

    then.forEach((spec, ei) => {
      const ePath = `${cPath}.then[${ei}]`;
      if (!spec || typeof spec !== 'object') return;

      // ---- ACR-2：penalize 只许罚事件当事人本人 ----
      if (spec.type === 'penalize') {
        if (!CONTROLLED_EFFECTS.includes('penalize')) return;
        if (spec.userId !== 'expr: event.userId') {
          issues.push({
            path: `${ePath}.userId`,
            message: `penalize 只允许针对事件当事人本人（'expr: event.userId'），实际 ${JSON.stringify(spec.userId)}（ACR-2 防罚没他人资产）`,
          });
        }
        if (!tpl.requiresAudit) {
          issues.push({ path: 'requiresAudit', message: '含 penalize 的模板必须 requiresAudit=true（人工审核）' });
        }
      }

      // ---- ACR-2：资金守恒 ----
      if (spec.type === 'walletTransfer') {
        // 出账（fromUserId 缺省 = escrow 释放）
        if (spec.fromUserId === undefined || spec.fromUserId === 'escrow') {
          checkOutgoingRecipient(spec, tpl, `${ePath}.toUserId`, issues);
        } else {
          // 入托管：扣款来源封闭
          checkEscrowInSource(spec, tpl, `${ePath}.fromUserId`, issues);
        }
      }

      // ---- ACR-2：splitPayout 禁花平台金库 ----
      if (spec.type === 'splitPayout' && spec.source === 'treasury') {
        issues.push({ path: `${ePath}.source`, message: "splitPayout source='treasury'（平台金库支付）为 GSO 平台特权，UGC 禁用" });
      }

      // ---- ACR-2：splitPayout literal 分账表可硬编码收款人（洗托管资金），UGC 只允许 byField ----
      if (spec.type === 'splitPayout' && spec.table && spec.table.kind === 'literal') {
        issues.push({
          path: `${ePath}.table`,
          message: "splitPayout literal 分账表禁止（可硬编码收款人，ACR-2 资金守恒）：UGC 只允许 table.kind='byField'（按贡献记录分账）",
        });
      }

      // ---- ACR-2：transferVoucher 收款方同样封闭 ----
      if (spec.type === 'transferVoucher') {
        checkOutgoingRecipient(spec, tpl, `${ePath}.toUserId`, issues);
      }
    });
  });

  // ---- ACR-2：退款可达性（资金进托管必须有出口） ----
  if (hasEscrowIn && !hasAnyRelease) {
    issues.push({
      path: 'clauses',
      message: '资金可进托管但无任何出口条款（refundAll / 出账 walletTransfer / splitPayout / penalize）——ACR-2 要求存在可达的退款路径',
    });
  }

  // ---- ACR-1：initialState 不得为终局态 ----
  if (['fulfilled', 'refunded', 'terminated'].includes(String(tpl.initialState))) {
    issues.push({ path: 'initialState', message: 'initialState 不得为终局状态（fulfilled/refunded/terminated）' });
  }

  return issues;
}

// ============================================================
// 风险分级（决定审核路径：低=自动通过；中=规则引擎自动审+抽样；高=人工）
// ============================================================

export interface TemplateRiskClassification {
  level: 'low' | 'medium' | 'high';
  reasons: string[];
}

export function classifyTemplateRisk(tpl: ContractTemplate): TemplateRiskClassification {
  const wl = new Set(tpl.effectsWhitelist || []);
  const reasons: string[] = [];

  // 高风险信号：受控 Effect / 治理面 / 平台特权面
  if (wl.has('penalize')) reasons.push('含罚没（penalize）');
  if (wl.has('freezeVoucher') || wl.has('unfreezeVoucher')) reasons.push('含凭证冻结/解冻');
  if (wl.has('transferVoucher')) reasons.push('含凭证转移');
  if (tpl.family === 'community_revenue') reasons.push('family=community_revenue（收益权属）');
  if (tpl.requiresAudit) reasons.push('模板自声明 requiresAudit');

  if (reasons.length > 0) return { level: 'high', reasons };

  // 中风险：涉资金流转
  const funds = ['walletTransfer', 'splitPayout', 'refundAll'].some((e) => wl.has(e as EffectType));
  if (funds) return { level: 'medium', reasons: ['涉资金流转（托管/退款/分账）'] };

  return { level: 'low', reasons: [] };
}

// ============================================================
// 部署期 stateData 预置：从 clauses.updates 推导初始字段（CW 修复）
//
// 背景：引擎 evaluate 对未初始化的 state 字段返回 null，参与算术/比较即抛
// TypeError（assertArith 拒绝 null）——官方模板靠 deploy preset 5 键，
// UGC 自定义字段（如 state.count）首次触发必炸。因此部署时按 updates
// 声明推导初始值：add→0、push→[]、set→null（set 字段语义由作者负责）。
// ============================================================

export function deriveInitialStateData(tpl: ContractTemplate): Record<string, unknown> {
  const seed: Record<string, unknown> = {
    memberCount: 0,
    totalRaised: 0,
    score: 0,
    poolFunded: 0,
    contributions: [],
  };
  for (const clause of Array.isArray(tpl?.clauses) ? tpl.clauses : []) {
    for (const u of (clause?.updates || []) as Array<{ field?: string; op?: string }>) {
      if (!u?.field) continue;
      const segs = String(u.field).split('.');
      if (segs.length !== 1) continue; // 只预置顶层字段；嵌套路径由 applyUpdates 自建
      if (u.op === 'push') {
        if (!Array.isArray(seed[segs[0]])) seed[segs[0]] = [];
      } else if (u.op === 'add') {
        if (typeof seed[segs[0]] !== 'number') seed[segs[0]] = 0;
      } else if (u.op === 'set' && !(segs[0] in seed)) {
        seed[segs[0]] = null;
      }
    }
  }
  return seed;
}

// ============================================================
// 统一入口：结构校验（validateTemplate）+ ACR 安全 Lint
// ============================================================

export function validateUgcTemplate(tpl: ContractTemplate): ValidationResult {
  const structural = validateTemplate(tpl);
  const issues: ValidationIssue[] = [...structural.issues, ...lintUgcTemplate(tpl)];
  return { ok: issues.length === 0, issues };
}
