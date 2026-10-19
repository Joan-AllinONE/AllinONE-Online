/**
 * 合约模块统一出口
 *
 * 分层（模块独立性硬性要求）：
 * - types / config / engine  → 零业务依赖（守卫脚本机器验证），可整体移植
 * - runtime / client / ui    → 只依赖 engine + 注入的 adapters（B1+ 逐步加入）
 */
export * from './types.js';
export * from './config.js';
export { sha256hex } from './engine/hash.js';
export { canonicalize, computeCodeHash, verifyCodeHash } from './engine/canonical.js';
export type { CodeHashInput } from './engine/canonical.js';
export { evaluateExpression, lintExpression, evalNumber, evalString } from './engine/evaluate.js';
export type { EvalOptions } from './engine/evaluate.js';
export {
  validateParams,
  validateTemplate,
  validateClauses,
  validateEffectSpec,
  isValidTransition,
  isContractState,
  STATE_TRANSITIONS,
  ALL_STATES,
} from './engine/validate.js';
export type { ValidationIssue, ValidationResult } from './engine/validate.js';
export { executeTrigger, applyUpdates, triggerMatches } from './engine/execute.js';
export type { ExecuteResult, ExecuteOptions } from './engine/execute.js';
export { appendEvent, verifyChain, computeEventHash, merkleRoot, GENESIS_HASH } from './engine/ledger.js';
export type { EventBody, ChainVerifyResult } from './engine/ledger.js';
export { getTemplate, listTemplates, registerTemplate } from './templates/index.js';
export { GROUP_BUY, TEAM_QUEST, GSO } from './templates/index.js';
// ACR 安全 Linter（CW-0：UGC 模板创作协议规范）
export {
  ACR_SPEC_VERSION,
  UGC_KEY_RE,
  RESERVED_TEMPLATE_KEYS,
  UGC_MAX_CLAUSES,
  UGC_MAX_EFFECTS_PER_CLAUSE,
  UGC_MAX_FIELD_DEPTH,
  UGC_MAX_SERIALIZED_BYTES,
  LOW_RISK_EFFECTS,
  lintUgcTemplate,
  classifyTemplateRisk,
  validateUgcTemplate,
  deriveInitialStateData,
} from './acr/acrLinter.js';
export type { TemplateRiskClassification } from './acr/acrLinter.js';
