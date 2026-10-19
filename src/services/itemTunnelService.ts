/**
 * 道具凭证安全隧道客户端（itemTunnelService）
 *
 * B2/B3 防刷改造的前端封装：所有凭证/交易/市场云写入统一走
 * `/api/v1/games/__item/*` 与 `/__market/*` 业务隧道（云端写入唯一入口），
 * 不再使用公开集合同步端点（vouchers/market_listings/purchases 已 403）。
 *
 * 服务端职责（对齐 cloudfunctions/gamesApi/index.js 的 __item/__market）：
 * - mint：JWT 身份 → schema 白名单 → 参数范围 → 每日限额 → harvestId 幂等 → HMAC 签名
 * - sync：结构校验 + 服务端签名文档关键字段保护
 * - verify：流通前批量校验（市场上架/兑换）
 * - market：上架/成交/下架的服务端凭证核对与原子状态迁移
 */

import {
  API_BASE,
  authHeaders,
  isCloudHosting,
  type BackendUpsertResult,
} from './backendSync';

const ITEM_BASE = `${API_BASE}/v1/games/__item`;
const MARKET_BASE = `${API_BASE}/v1/games/__market`;

/** 统一响应解析：非 2xx → ok=false + code */
async function postJson<T>(
  url: string,
  body: unknown,
): Promise<{ ok: boolean; status: number; data?: T; error?: string; code?: string }> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: await authHeaders(true),
      body: JSON.stringify(body),
    });
    let json: any = null;
    try {
      json = await res.json();
    } catch { /* 非 JSON 响应 */ }
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: json?.error || `HTTP ${res.status}`,
        code: json?.code,
      };
    }
    return { ok: !!json?.success, status: res.status, data: json?.data as T, error: json?.error, code: json?.code };
  } catch (e: any) {
    return { ok: false, status: 0, error: String(e?.message || e) };
  }
}

// ==================== 道具提取铸造（mint） ====================

export interface MintHarvestPayload {
  gameId: string;
  schemaName: string;
  itemData: Record<string, any>;
  harvestId?: string;
  userName?: string;
}

export interface MintHarvestResponse {
  voucher: Record<string, any>;
  remaining: number;
}

/** 调用服务端铸造道具凭证（唯一道具铸造口，服务端做限额/幂等/签名） */
export function mintHarvestVoucher(
  payload: MintHarvestPayload,
): Promise<{ ok: boolean; status: number; data?: MintHarvestResponse; error?: string; code?: string }> {
  return postJson<MintHarvestResponse>(`${ITEM_BASE}/mint`, payload);
}

// ==================== 凭证/交易记录通用同步（sync） ====================

/**
 * VoucherDatabase 云同步专用通道（替代公开集合写入）。
 * 服务端对 vouchers 做结构校验；服务端签名文档只允许流通状态字段变更；
 * 新建道具凭证执行与 mint 同源的校验+限额+幂等。
 */
export function syncVoucherDoc(
  collection: 'vouchers' | 'voucher_transactions',
  doc: Record<string, any>,
): Promise<BackendUpsertResult> {
  return postJson(`${ITEM_BASE}/sync`, { collection, doc }).then(r => ({
    success: r.ok,
    error: r.error,
  }));
}

// ==================== 流通校验（verify） ====================

export interface VoucherVerifyResult {
  id: string;
  exists: boolean;
  currentHolderId?: string;
  status?: string;
  reviewStatus?: string;
  mintedBy?: string;
  signatureValid?: boolean | null;
  error?: string;
}

/** 批量校验凭证（云端为准：存在性+持有者+状态+审核+签名） */
export async function verifyVouchers(voucherIds: string[]): Promise<VoucherVerifyResult[]> {
  if (!Array.isArray(voucherIds) || voucherIds.length === 0) return [];
  const r = await postJson<{ results: VoucherVerifyResult[] }>(`${ITEM_BASE}/verify`, {
    voucherIds: voucherIds.slice(0, 50),
  });
  return r.ok && r.data ? r.data.results : [];
}

/**
 * 单凭证流通校验（兑换/上架前守卫）。
 * 校验规则（与市场/兑换业务一致）：
 * - 云端必须存在（本地伪造凭证直接拒绝）
 * - 持有者一致
 * - 未被使用/销毁
 * - 高价值审核 pending/rejected 拒绝
 *
 * 🆕 环境门控：仅 prod 云端托管域（有云端账本）执行严格校验；
 * dev/本地环境本地凭证不在云端账本，一律放行（否则阻断正常功能）。
 */
export async function verifyVoucherForCirculation(
  voucherId: string,
  userId: string,
): Promise<{ ok: boolean; reason: string; detail?: VoucherVerifyResult }> {
  if (!isCloudHosting()) {
    return { ok: true, reason: '' };
  }
  try {
    const results = await verifyVouchers([voucherId]);
    const v = results[0];
    if (!v) return { ok: false, reason: '校验服务不可用，请稍后再试' };
    if (!v.exists) return { ok: false, reason: '凭证校验失败：云端不存在该凭证', detail: v };
    if (v.currentHolderId && userId && v.currentHolderId !== userId) {
      return { ok: false, reason: '凭证校验失败：你不是该凭证的持有者', detail: v };
    }
    if (v.status === 'redeemed' || v.status === 'destroyed') {
      return { ok: false, reason: '凭证校验失败：该凭证已被使用或销毁', detail: v };
    }
    if (v.reviewStatus === 'pending') {
      return { ok: false, reason: '高价值道具审核中，暂不能使用', detail: v };
    }
    if (v.reviewStatus === 'rejected') {
      return { ok: false, reason: '该道具未通过平台审核，不能使用', detail: v };
    }
    return { ok: true, reason: '', detail: v };
  } catch (e: any) {
    // 校验服务不可达：放行（与 mint 限额降级同哲学——辅助设施故障不阻断正常玩家），
    // 但伪造凭证本身进不了云端，风险可控
    return { ok: true, reason: '' };
  }
}

// ==================== 今日提取额度（harvest-limit） ====================

/** 查询今日剩余提取额度（服务端计数为准；失败返回 null 由调用方回落本地值） */
export async function getHarvestLimitRemote(
  gameId: string,
): Promise<{ remaining: number; limit: number } | null> {
  try {
    const res = await fetch(`${ITEM_BASE}/harvest-limit?gameId=${encodeURIComponent(gameId)}`, {
      headers: await authHeaders(false),
    });
    if (!res.ok) return null;
    const json = await res.json();
    if (json?.success && json?.data) {
      return { remaining: json.data.remaining, limit: json.data.limit };
    }
    return null;
  } catch {
    return null;
  }
}

// ==================== 购买记录同步（purchases 收据式写入） ====================

/**
 * 游戏商店购买记录专用通道（purchases 集合公开写已摘除 403）。
 * 收据式写入：结构校验+大小限制+频控（购买资产本身由 vouchers 强校验保护，
 * 收据仅影响「已购记录」展示）。
 */
export function syncPurchaseDoc(doc: Record<string, any>): Promise<BackendUpsertResult> {
  return postJson(`${ITEM_BASE}/purchase`, { doc }).then(r => ({
    success: r.ok,
    error: r.error,
  }));
}

// ==================== 市场隧道（__market） ====================

export interface MarketTunnelResult extends BackendUpsertResult {
  /** HTTP 状态：400/403=业务拒绝（应阻断）；404/5xx/0=服务不可用（可降级放行） */
  status?: number;
}

/** 上架（服务端核对凭证存在+持有者+审核状态后写入 market_listings） */
export function marketList(listing: Record<string, any>): Promise<MarketTunnelResult> {
  return postJson(`${MARKET_BASE}/list`, { listing }).then(r => ({
    success: r.ok,
    error: r.error,
    status: r.status,
  }));
}

/** 成交（服务端原子置 sold + 写 purchases 快照；buyerId 必须与 token 一致） */
export function marketBuy(
  listingId: string,
  buyerId: string,
  buyerName: string,
  paymentTxIds: string[],
): Promise<{ success: boolean; error?: string; code?: string }> {
  return postJson(`${MARKET_BASE}/buy`, { listingId, buyerId, buyerName, paymentTxIds }).then(r => ({
    success: r.ok,
    error: r.error,
    code: r.code,
  }));
}

/** 下架（服务端核对卖家后置 cancelled） */
export function marketUnlist(listingId: string, userId: string): Promise<MarketTunnelResult> {
  return postJson(`${MARKET_BASE}/unlist`, { listingId, userId }).then(r => ({
    success: r.ok,
    error: r.error,
    status: r.status,
  }));
}

// ==================== 管理端：凭证状态迁移（__item/update） ====================

/**
 * 凭证状态迁移（审核决定等）。reviewStatus 变更服务端要求 admin 角色 token。
 * @param adminToken 可选——管理员会话 token（游戏审核后台登录态）；缺省用 dev-token
 */
export async function itemUpdate(
  voucherId: string,
  patch: Record<string, any>,
  adminToken?: string | null,
): Promise<{ success: boolean; error?: string; code?: string }> {
  try {
    const headers = adminToken
      ? { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` }
      : await authHeaders(true);
    const res = await fetch(`${ITEM_BASE}/update`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ voucherId, patch }),
    });
    let json: any = null;
    try {
      json = await res.json();
    } catch { /* ignore */ }
    return { success: res.ok && !!json?.success, error: json?.error, code: json?.code };
  } catch (e: any) {
    return { success: false, error: String(e?.message || e) };
  }
}
