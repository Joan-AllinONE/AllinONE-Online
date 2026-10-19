/**
 * 合约隧道客户端（B3）
 *
 * 所有合约操作统一走 `/api/v1/games/__contract/*`（云端写入唯一入口）。
 * prod 下 getApiBase 自动切换绝对云函数 URL（apiBase.ts）。
 */

// 复用市场客户端的 base 解析与认证（同一隧道体系）
import { API_BASE, authHeaders } from '@/services/backendSync';

const CONTRACT_BASE = `${API_BASE}/v1/games/__contract`;

async function request<T>(
  path: string,
  method: 'GET' | 'POST',
  body?: unknown,
): Promise<{ ok: boolean; status: number; data?: T; error?: string; code?: string }> {
  try {
    const res = await fetch(`${CONTRACT_BASE}${path}`, {
      method,
      headers: await authHeaders(true),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json: any = null;
    try {
      json = await res.json();
    } catch { /* 非 JSON */ }
    if (!res.ok) {
      return { ok: false, status: res.status, error: json?.error || `HTTP ${res.status}`, code: json?.code };
    }
    return { ok: !!json?.success, status: res.status, data: json?.data as T, error: json?.error, code: json?.code };
  } catch (e: any) {
    return { ok: false, status: 0, error: String(e?.message || e) };
  }
}

// ==================== 类型 ====================

export interface TemplateSummary {
  key: string;
  family: string;
  version: number;
  title: string;
  description?: string;
  riskLevel: 'low' | 'medium' | 'high';
  requiresAudit: boolean;
  paramsSchema: Record<string, any>;
  governanceTopics: string[];
  autoExecute: boolean;
  /** UGC 模板标记（官方模板为 false） */
  ugc?: boolean;
  /** 官方模板公开源码（GET /templates 返回完整 clauses） */
  initialState?: string;
  effectsWhitelist?: string[];
  clauses?: Array<Record<string, unknown>>;
}

export interface ContractSummary {
  id: string;
  templateKey: string;
  templateVersion: number;
  family: string;
  codeHash: string;
  initiatorId: string;
  gameId?: string;
  /** 私域名单：非空 = 私域合约（仅名单内成员可 join/subscribe，发起人豁免）；缺省 = 公开 */
  whitelist?: string[];
  params: Record<string, any>;
  state: string;
  stateData: Record<string, any>;
  partyCount: number;
  historyCount: number;
  autoExecute: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ContractDetail extends ContractSummary {
  clauses: any[];
  parties: any[];
  history: Array<{ seq: number; at: number; type: string; actorId: string; payload: Record<string, any>; prevHash: string; hash: string }>;
  seed: string;
}

export interface VerifyResult {
  intact: boolean;
  codeHash: string;
  recomputed: string;
  ruleIntact: boolean;
  chainIntact: boolean;
  chainLength: number;
  chainBrokenAt: number | null;
  signatureValid: boolean | null;
  state: string;
}

export interface EscrowEntry {
  entryId: string;
  txId: string;
  contractId: string;
  fromUserId: string;
  kind: string;
  currency: string;
  amount: number;
  lockedAt: number;
  status: string;
  releasedAt?: number;
  releasedTo?: string;
}

// ==================== API ====================

export function fetchTemplates(): Promise<{ ok: boolean; data?: { templates: TemplateSummary[] }; error?: string }> {
  return request('/templates', 'GET');
}

export function deployContract(
  templateKey: string,
  params: Record<string, unknown>,
  title?: string,
  whitelist?: string[],
): Promise<{ ok: boolean; data?: { contractId: string; codeHash: string; state: string; autoExecute: boolean; requiresAudit: boolean }; error?: string }> {
  return request('/deploy', 'POST', {
    templateKey, params, title,
    whitelist: whitelist && whitelist.length > 0 ? whitelist : undefined,
  });
}

export function invokeContract(
  contractId: string,
  action: string,
  payload?: Record<string, unknown>,
  triggerId?: string,
): Promise<{ ok: boolean; data?: { contractId: string; state: string; stateData: Record<string, any>; clauseIds: string[] }; error?: string; code?: string }> {
  return request('/invoke', 'POST', { contractId, action, payload, triggerId });
}

export function signContract(contractId: string): Promise<{ ok: boolean; error?: string }> {
  return request('/sign', 'POST', { contractId });
}

export function queryContracts(
  filter: { state?: string; family?: string; initiatorId?: string; gameId?: string } = {},
): Promise<{ ok: boolean; data?: { contracts: ContractSummary[] }; error?: string }> {
  const qs = new URLSearchParams(
    Object.entries(filter)
      .filter(([, v]) => v !== undefined && v !== '')
      .map(([k, v]) => [k, String(v)]),
  ).toString();
  return request(`/query${qs ? `?${qs}` : ''}`, 'GET');
}

export function fetchContractDetail(id: string): Promise<{ ok: boolean; data?: { contract: ContractDetail }; error?: string }> {
  return request(`/detail?id=${encodeURIComponent(id)}`, 'GET');
}

export function verifyContract(id: string): Promise<{ ok: boolean; data?: VerifyResult; error?: string }> {
  return request(`/verify?id=${encodeURIComponent(id)}`, 'GET');
}

export function fetchContractEscrow(id: string): Promise<{ ok: boolean; data?: { entries: EscrowEntry[] }; error?: string }> {
  return request(`/escrow?id=${encodeURIComponent(id)}`, 'GET');
}

export function fetchAdminOverview(): Promise<{
  ok: boolean;
  data?: {
    totalContracts: number;
    byState: Record<string, number>;
    escrowSummary: Record<string, number>;
    deadLetters: Array<{ contractId: string; templateKey: string; at: number; error: string; planId: string }>;
    shadowPlans: Array<{ contractId: string; templateKey: string; at: number }>;
    deadLetterCount: number;
  };
  error?: string;
}> {
  return request('/admin/overview', 'GET');
}

export function reviewContract(
  contractId: string,
  approve: boolean,
  note?: string,
): Promise<{ ok: boolean; error?: string }> {
  return request('/admin/review', 'POST', { contractId, approve, note });
}

// ==================== 平台规则注册中心 ====================

export interface PlatformRuleSummary {
  ruleKey: string;
  value: number;
  description: string;
  pendingValue: number | null;
  proposedBy: string | null;
  proposedAt: number | null;
  effectiveAt: number | null;
  cooldownMs: number;
  version: number;
  historyCount: number;
  chainIntact: boolean;
}

export function fetchRules(): Promise<{ ok: boolean; data?: { rules: PlatformRuleSummary[] }; error?: string }> {
  return request('/rules', 'GET');
}

export function proposeRule(
  ruleKey: string,
  value: number,
  description?: string,
  cooldownMs?: number,
): Promise<{ ok: boolean; error?: string }> {
  return request('/admin/rules/propose', 'POST', { ruleKey, value, description, cooldownMs });
}

export function activateRule(ruleKey: string): Promise<{ ok: boolean; error?: string }> {
  return request('/admin/rules/activate', 'POST', { ruleKey });
}

export function rejectRule(ruleKey: string): Promise<{ ok: boolean; error?: string }> {
  return request('/admin/rules/reject', 'POST', { ruleKey });
}

export function verifyRule(ruleKey: string): Promise<{ ok: boolean; data?: { ruleKey: string; chainIntact: boolean; length: number }; error?: string }> {
  return request('/admin/rules/verify', 'POST', { ruleKey });
}

/** 测试设施：注入收益台账条目（GSO 分账联调用） */
export function injectRevenue(
  gameId: string,
  source: string,
  commission: number,
): Promise<{ ok: boolean; error?: string }> {
  return request('/admin/revenue', 'POST', { gameId, source, commission });
}

// ==================== UGC 模板注册中心（合约工坊 CW-1） ====================

export interface UgcTemplateSummary {
  key: string;
  authorId: string;
  authorName?: string;
  version: number;
  family: string;
  title?: string;
  description?: string;
  riskLevel: string;
  requiresAudit: boolean;
  effectsWhitelist: string[];
  paramsSchema: Record<string, any>;
  governanceTopics: string[];
  status: 'pending' | 'approved' | 'rejected';
  reviewNote?: string;
  reviewPath?: string;
  source?: 'ai' | 'manual' | 'fork';
  forkOf?: string;
  riskClass?: { level: string; reasons: string[] };
  stats?: { deployCount?: number };
  templateFeeBps?: number;
  createdAt?: number;
  updatedAt?: number;
}

export interface SubmitUgcResult {
  key: string;
  status: 'pending' | 'approved' | 'rejected';
  riskLevel: string;
  riskReasons: string[];
  reviewPath: string;
  version: number;
}

/** 提交模板进注册中心（服务端强制 ACR 校验 + key 命名空间） */
export function submitUgcTemplate(
  tpl: Record<string, unknown>,
  slug: string,
  opts: { source?: string; forkOf?: string; templateFeeBps?: number; authorName?: string } = {},
): Promise<{ ok: boolean; data?: SubmitUgcResult; error?: string; issues?: Array<{ path: string; message: string }> }> {
  return request('/ugc-templates/submit', 'POST', {
    tpl,
    slug,
    source: opts.source,
    forkOf: opts.forkOf,
    templateFeeBps: opts.templateFeeBps,
    authorName: opts.authorName,
  });
}

/** 市场列表（公开 approved）或我的草稿（mine=true 全部状态） */
export function listUgcTemplates(mine = false): Promise<{ ok: boolean; data?: { templates: UgcTemplateSummary[] }; error?: string }> {
  return request(`/ugc-templates${mine ? '?mine=1' : ''}`, 'GET');
}

/** 模板全量（含 clauses，供 fork / 本地沙盒回放） */
export function fetchUgcTemplateDetail(
  key: string,
): Promise<{ ok: boolean; data?: { template: UgcTemplateSummary & { tpl: Record<string, unknown>; reviewedCodeHash?: string } }; error?: string }> {
  return request(`/ugc-templates/detail?key=${encodeURIComponent(key)}`, 'GET');
}

/** 人工审核（admin） */
export function reviewUgcTemplate(
  key: string,
  approve: boolean,
  note?: string,
): Promise<{ ok: boolean; data?: { key: string; status: string }; error?: string }> {
  return request('/admin/ugc-templates/review', 'POST', { key, approve, note });
}
