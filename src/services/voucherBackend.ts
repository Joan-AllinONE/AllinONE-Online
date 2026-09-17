/**
 * 凭证系统后端同步助手（voucherBackend）—— 兼容层
 *
 * Bug 013 的实现已升级为通用的 `backendSync.ts`（支持全平台集合 + 批量写入 + 删除）。
 * 本文件保留为薄兼容层，避免改动已验证通过的凭证系统调用点。
 *
 * 新代码请直接使用 `backendSync.ts`。
 */

import {
  saveToBackend,
  loadFromBackend,
  type BackendUpsertResult,
} from './backendSync';

export type { BackendUpsertResult };

type VoucherCollection =
  | 'vouchers'
  | 'voucher_templates'
  | 'purchases'
  | 'voucher_transactions';

/**
 * 写入单条记录到后端集合（upsert）
 */
export function saveVoucherToBackend(
  collection: VoucherCollection,
  doc: Record<string, any>,
): Promise<BackendUpsertResult> {
  return saveToBackend(collection, doc);
}

/**
 * 分页读取后端集合全部数据（每页 200，循环直到取完，绝不截断）
 */
export function loadCollectionFromBackend<T>(
  collection: VoucherCollection,
): Promise<T[]> {
  return loadFromBackend<T>(collection);
}
