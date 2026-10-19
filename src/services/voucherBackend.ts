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
import { syncVoucherDoc, syncPurchaseDoc } from './itemTunnelService';

export type { BackendUpsertResult };

type VoucherCollection =
  | 'vouchers'
  | 'voucher_templates'
  | 'purchases'
  | 'voucher_transactions';

/**
 * 写入单条记录到后端集合（upsert）
 *
 * 🆕 B2 防刷路由：vouchers / voucher_transactions / purchases 的公开集合同步写
 * 已被云端摘除（READ_ONLY 403），分别改走 __item/sync 与 __item/purchase 隧道。
 * voucher_templates 维持原通用同步（公开数据，非资产）。
 */
export function saveVoucherToBackend(
  collection: VoucherCollection,
  doc: Record<string, any>,
): Promise<BackendUpsertResult> {
  if (collection === 'vouchers' || collection === 'voucher_transactions') {
    return syncVoucherDoc(collection, doc);
  }
  if (collection === 'purchases') {
    return syncPurchaseDoc(doc);
  }
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
