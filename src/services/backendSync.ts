/**
 * 通用后端同步助手（backendSync）
 *
 * 由 voucherBackend.ts 升级而来，泛化到平台全部需要跨浏览器共享的集合。
 *
 * 根因（Bug 013 及同类）：前端写入全部走 writeQueue → CloudBase JS SDK 浏览器端
 * auth 损坏（auth.call is not a function）→ 线上写入永不落库；另一浏览器读到 0 条。
 *
 * 方案：写入/读取统一走 gamesApi 云函数（admin SDK，无浏览器端 auth 限制）。
 *
 * 约束（来自 memory）：
 * - 绝不回退 writeQueue（线上已失效）
 * - 绝不使用 limit(500) 硬截断，读取一律分页取全量
 * - 使用永久云函数 URL（不过期）
 * - 新增后端路由一律走 /api/v1/games/<collection>，绝不新增顶层 /api/v1/<feature>
 */

import { getCurrentUserId, getCurrentUserRole } from './authTokenService';

// 永久云函数后端地址（与 SW 兜底 PRODUCTION_BACKEND_URL 保持一致）
// ⚠️ 环境隔离铁律（修复 dev 数据泄漏到线上）：
// 绝不硬编码生产 URL 给所有环境。prod 静态托管域名（tcloudbaseapp.com）下用绝对云函数 URL，
// 其余（localhost dev / 其他域名）用相对 /api，由 vite 代理 / server.js 接收，数据落在本地内存库，
// 与线上云函数完全隔离。
const PROD_BACKEND = 'https://allinonegaming-d4gmsmrzz573264f6.service.tcloudbase.com';

/**
 * 是否运行在 prod 云端静态托管域名下（云端账本可达且为权威）。
 * 🆕 导出供 __item/__market 守卫做环境门控：dev/本地环境无云端账本，
 * verify/市场服务端校验须降级放行，否则阻断正常功能。
 */
export function isCloudHosting(): boolean {
  return typeof window !== 'undefined' && /tcloudbaseapp\.com$/.test(window.location.hostname);
}

/** 后端 API 基址（导出供 __item/__market 等隧道客户端复用，保持同一环境隔离策略） */
export const API_BASE = isCloudHosting() ? `${PROD_BACKEND}/api` : '/api';

const DEV_TOKEN_PATH = '/v1/games/dev-token';

/**
 * 可同步集合白名单——必须与云函数 SYNC_COLLECTIONS 严格一致。
 */
export type SyncCollection =
  // 凭证系统（Bug 013 已修）
  | 'vouchers'
  | 'voucher_templates'
  | 'purchases'
  | 'voucher_transactions'
  // 提案 / 治理
  | 'proposals'
  | 'vote_thresholds'
  | 'penalty_logs'
  // 市场
  | 'market_listings'
  // 钱包 / 背包（只读同步，写入维持现状）
  | 'users'
  | 'transactions'
  | 'inventories'
  // 兑换码
  | 'redeem_hosted_items'
  | 'redeem_codes'
  | 'redeem_purchases'
  // 平台配置
  | 'platform_treasury'
  | 'platform_config'
  | 'game_stores'
  | 'store_products'
  // 扩展凭证
  | 'extension_vouchers';

/**
 * 只读集合：仅做「读取同步」，写入维持现状（本地 + writeQueue）。
 * 原因：这些集合涉及资金/资产，公开无鉴权写端点存在被篡改风险。
 */
export const READ_ONLY_COLLECTIONS: ReadonlySet<string> = new Set([
  'users',
  'transactions',
  'inventories',
  // 🆕 B2 防刷（2026-09-22）：以下集合公开写已被云端摘除（写 403），
  // 必须经业务隧道写入（__item/sync、__item/purchase、__market/*），
  // 此处兜底拦截防止未来代码误用直写通道。
  'vouchers',
  'voucher_transactions',
  'market_listings',
  'purchases',
]);

let _backendToken: string | null = null;
let _backendTokenUserId: string | null = null;

async function getBackendToken(): Promise<string | null> {
  const uid = getCurrentUserId();
  // 🆕 缓存绑定 userId：切换账号（player1 → admin）后旧 token 的 role 已失效，必须重新签发
  if (_backendToken && _backendTokenUserId === uid) return _backendToken;
  try {
    const res = await fetch(`${API_BASE}${DEV_TOKEN_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // 🆕 必须携带 userId：本地/云函数 dev-token 路由按 body.userId 签发
      // JWT（云函数缺省回退 'anonymous'，本地严格校验 400）。空 body 曾致
      // 400 → extension_vouchers 401（跨游戏道具列表读取失败）。
      // 🆕 携带 role：合约隧道 requireAdmin 依赖 JWT role（'admin'/'platform' 放行）。
      body: JSON.stringify({ userId: uid, role: getCurrentUserRole() }),
    });
    if (!res.ok) return null;
    const json = await res.json();
    _backendToken = json?.data?.token ?? null;
    _backendTokenUserId = uid;
    return _backendToken;
  } catch {
    return null;
  }
}

/** 带鉴权头的 fetch headers（导出供 __item/__market 等隧道客户端复用） */
export async function authHeaders(withJson = false): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  if (withJson) headers['Content-Type'] = 'application/json';
  const token = await getBackendToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}

export interface BackendUpsertResult {
  success: boolean;
  error?: string;
}

/**
 * 写入单条记录到后端集合（upsert）
 */
export async function saveToBackend(
  collection: SyncCollection,
  doc: Record<string, any>,
): Promise<BackendUpsertResult> {
  if (READ_ONLY_COLLECTIONS.has(collection)) {
    return { success: false, error: 'read-only collection' };
  }
  try {
    const res = await fetch(`${API_BASE}/v1/games/${collection}`, {
      method: 'POST',
      headers: await authHeaders(true),
      body: JSON.stringify(doc),
    });
    if (!res.ok) return { success: false, error: `HTTP ${res.status}` };
    return { success: true };
  } catch (e: any) {
    return { success: false, error: String(e?.message || e) };
  }
}

/**
 * 批量 upsert（一次 HTTP，避免 N 条记录 N 次请求）
 * 后端每批上限 200，超出自动分片。
 */
export async function saveBatchToBackend(
  collection: SyncCollection,
  docs: Record<string, any>[],
): Promise<BackendUpsertResult> {
  if (READ_ONLY_COLLECTIONS.has(collection)) {
    return { success: false, error: 'read-only collection' };
  }
  if (!Array.isArray(docs) || docs.length === 0) return { success: true };
  try {
    const headers = await authHeaders(true);
    const CHUNK = 200;
    for (let i = 0; i < docs.length; i += CHUNK) {
      const slice = docs.slice(i, i + CHUNK);
      const res = await fetch(`${API_BASE}/v1/games/${collection}/batch`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ docs: slice }),
      });
      if (!res.ok) return { success: false, error: `HTTP ${res.status}` };
    }
    return { success: true };
  } catch (e: any) {
    return { success: false, error: String(e?.message || e) };
  }
}

/**
 * 分页读取后端集合全部数据（每页 200，循环直到取完，绝不截断）
 */
export async function loadFromBackend<T>(
  collection: SyncCollection,
): Promise<T[]> {
  try {
    const headers = await authHeaders(false);
    const PAGE = 200;
    let skip = 0;
    const all: T[] = [];
    // 防御性上限：最多 100 页（2万条），避免后端异常导致死循环
    for (let page = 0; page < 100; page++) {
      const url = `${API_BASE}/v1/games/${collection}?skip=${skip}&limit=${PAGE}`;
      const res = await fetch(url, { headers });
      if (!res.ok) break;
      const json = await res.json();
      const rows: T[] = json?.data?.list ?? json?.data ?? [];
      if (!Array.isArray(rows) || rows.length === 0) break;
      all.push(...rows);
      if (rows.length < PAGE) break;
      skip += PAGE;
    }
    return all;
  } catch {
    return [];
  }
}

/**
 * 删除后端集合中的单条记录
 */
export async function deleteFromBackend(
  collection: SyncCollection,
  id: string,
): Promise<BackendUpsertResult> {
  if (READ_ONLY_COLLECTIONS.has(collection)) {
    return { success: false, error: 'read-only collection' };
  }
  try {
    const res = await fetch(
      `${API_BASE}/v1/games/${collection}/${encodeURIComponent(id)}`,
      { method: 'DELETE', headers: await authHeaders(false) },
    );
    if (!res.ok) return { success: false, error: `HTTP ${res.status}` };
    return { success: true };
  } catch (e: any) {
    return { success: false, error: String(e?.message || e) };
  }
}
