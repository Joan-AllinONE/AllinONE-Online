/**
 * 平台规则注册中心客户端（前端只读投影）
 *
 * 数据源：GET /api/v1/games/__contract/rules（公开端点，无需登录）。
 * 规则的权威源是云端 contract_rules 集合；本服务只做「读取 + 缓存 + 兜底」，
 * 绝不写规则（修改走合约治理：propose → 公示期 → activate）。
 *
 * 设计约束（check-contracts-isolation）：
 * - 本文件禁止 import src/contracts/**（避免把合约引擎拖进前端 bundle），
 *   兜底默认值在此独立声明，与 types.ts PLATFORM_RULE_DEFAULTS 数值保持一致，
 *   一致性由 scripts/check-contracts-isolation.cjs 的防回潮守卫校验。
 *
 * 使用模式：
 * - 同步读取：getRuleValue('market.commission_rate') —— 返回缓存值，未加载时返回兜底值；
 * - 高精度场景：先 `await ensureRulesReady()`（带超时，失败绝不阻塞业务），再同步读取；
 * - 页面挂载 / 模块初始化：scheduleRulesRefresh() 后台预热，无需等待。
 */

import { API_BASE } from './backendSync';

const RULES_URL = `${API_BASE}/v1/games/__contract/rules`;
const CACHE_STORAGE_KEY = 'platform_rules_cache_v1';
const REFRESH_INTERVAL_MS = 60_000;

/** 兜底副本（与 src/contracts/types.ts PLATFORM_RULE_DEFAULTS 数值一致；防回潮守卫校验） */
export const PLATFORM_RULE_FALLBACKS: Record<string, number> = {
  'market.commission_rate': 0.05,
  'item_harvest.daily_limit': 10,
  'cross_exchange.daily_limit': 20,
  'settlement.revenue_share_percent': 10,
  'settlement.cycle_ms': 86400000,
  'governance.pass_threshold': 0.5,
  'governance.weight_acoin': 0.3,
  'governance.weight_gamecoin': 0.1,
  'governance.weight_cap': 1000,
  'governance.rule_cooldown_ms': 259200000,
  'voucher.recycle_daily_pct': 0.5,
  'voucher.exchange_fee_pct': 2,
  'voucher.transfer_fee_pct': 0.5,
  'cross_exchange.fee_rate': 0.1,
};

let cache: Record<string, number> = loadPersisted();
let lastRefreshAt = 0;
let refreshing: Promise<void> | null = null;

function loadPersisted(): Record<string, number> {
  try {
    const raw = localStorage.getItem(CACHE_STORAGE_KEY);
    if (!raw) return { ...PLATFORM_RULE_FALLBACKS };
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { ...PLATFORM_RULE_FALLBACKS, ...(parsed as Record<string, number>) };
    }
  } catch { /* 损坏即重建 */ }
  return { ...PLATFORM_RULE_FALLBACKS };
}

function persist(): void {
  try { localStorage.setItem(CACHE_STORAGE_KEY, JSON.stringify(cache)); } catch { /* 隐私模式等 */ }
}

/**
 * 拉取规则注册中心（60s 节流；失败静默保留现有缓存/兜底值）。
 * 返回结构归一化：只接受 { data: { rules: [{ ruleKey, value }] } } 形状。
 */
export function refreshRules(force = false): Promise<void> {
  if (!force && Date.now() - lastRefreshAt < REFRESH_INTERVAL_MS) return Promise.resolve();
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const res = await fetch(RULES_URL);
      const json: any = await res.json().catch(() => null);
      const rules = json && json.data && json.data.rules;
      if (Array.isArray(rules)) {
        const next: Record<string, number> = {};
        for (const r of rules) {
          if (r && typeof r.ruleKey === 'string' && Number.isFinite(Number(r.value))) {
            next[r.ruleKey] = Number(r.value);
          }
        }
        // 云端缺失的键回退兜底副本；链损坏（chainIntact=false）时仍以服务端值为准（服务端已校验）
        cache = { ...PLATFORM_RULE_FALLBACKS, ...next };
        lastRefreshAt = Date.now();
        persist();
      }
    } catch { /* 服务不可达：保留现有值 */ }
    finally { refreshing = null; }
  })();
  return refreshing;
}

/** 后台预热（不等待、不抛错）——适合模块加载 / useEffect 挂载时调用 */
export function scheduleRulesRefresh(): void {
  refreshRules().catch(() => { /* 静默 */ });
}

/** 等待首次加载完成（带超时兜底，超时后用兜底值，绝不阻塞业务） */
export async function ensureRulesReady(timeoutMs = 1500): Promise<void> {
  if (Date.now() - lastRefreshAt < REFRESH_INTERVAL_MS) return;
  try {
    await Promise.race([
      refreshRules(true),
      new Promise<void>(resolve => setTimeout(resolve, timeoutMs)),
    ]);
  } catch { /* 兜底值 */ }
}

/** 同步读取规则值（未加载时返回兜底副本值） */
export function getRuleValue(ruleKey: string): number {
  const v = cache[ruleKey];
  return Number.isFinite(v) ? (v as number) : (PLATFORM_RULE_FALLBACKS[ruleKey] ?? 0);
}

// 模块加载即后台预热一次（首屏即用缓存/兜底值，不阻塞）
scheduleRulesRefresh();
