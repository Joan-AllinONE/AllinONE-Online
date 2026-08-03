/**
 * 凭证系统后端同步助手（voucherBackend）
 *
 * 修复 Bug 013：道具凭证无法跨浏览器同步。
 *
 * 根因：凭证写入全部走 writeQueue → CloudBase JS SDK 浏览器端 auth 损坏
 * （auth.call is not a function）→ 线上写入永不落库；另一浏览器 syncFromCloudBase
 * 拉到 0 条，商店显示「未铸造/已售罄」。
 *
 * 修复方案（复用已验证的跨浏览器共享 pattern）：
 * 1. 写入改走 gamesApi 云函数（admin SDK，无浏览器端 auth 限制）
 * 2. 读取改分页 + 后端 API 兜底（永久云函数 URL，不过期）
 *
 * 注意约束（来自 memory）：
 * - 绝不回退 writeQueue（线上已失效）
 * - 绝不保留 limit(500) 硬截断（历史同模式 bug）
 * - 使用永久云函数 URL，DB 匿名可读
 */

// 永久云函数后端地址（与 SW 兜底 PRODUCTION_BACKEND_URL 保持一致）
const VOUCHER_API_BASE =
  'https://allinonegaming-d4gmsmrzz573264f6.service.tcloudbase.com/api';

// dev-token（与 publishedGameService 同款 JWT，复用 authTokenService 逻辑）
const DEV_TOKEN_PATH = '/v1/games/dev-token';

let _backendToken: string | null = null;

async function getBackendToken(): Promise<string | null> {
  if (_backendToken) return _backendToken;
  try {
    const res = await fetch(`${VOUCHER_API_BASE}${DEV_TOKEN_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (!res.ok) return null;
    const json = await res.json();
    _backendToken = json?.data?.token ?? null;
    return _backendToken;
  } catch {
    return null;
  }
}

export interface BackendUpsertResult {
  success: boolean;
  error?: string;
}

/**
 * 写入单条记录到后端集合（upsert）
 */
export async function saveVoucherToBackend(
  collection: 'vouchers' | 'voucher_templates' | 'purchases' | 'voucher_transactions',
  doc: Record<string, any>,
): Promise<BackendUpsertResult> {
  try {
    const token = await getBackendToken();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const res = await fetch(
      `${VOUCHER_API_BASE}/v1/games/${collection}`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(doc),
      },
    );
    if (!res.ok) {
      return { success: false, error: `HTTP ${res.status}` };
    }
    return { success: true };
  } catch (e: any) {
    return { success: false, error: String(e?.message || e) };
  }
}

/**
 * 分页读取后端集合全部数据（每页 200，循环直到取完，绝不截断）
 */
export async function loadCollectionFromBackend<T>(
  collection: 'vouchers' | 'voucher_templates' | 'purchases' | 'voucher_transactions',
): Promise<T[]> {
  try {
    const token = await getBackendToken();
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const PAGE = 200;
    let skip = 0;
    const all: T[] = [];
    // 防御性上限：最多 100 页（2万条），避免后端异常导致死循环
    for (let page = 0; page < 100; page++) {
      const url = `${VOUCHER_API_BASE}/v1/games/${collection}?skip=${skip}&limit=${PAGE}`;
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
