/**
 * 通用云同步工具
 * 为凭证系统各服务提供「云端为准 + localStorage 缓存」能力
 *
 * 架构原则（2026-08-04 修订）：
 * - 云端数据库是权威数据源，localStorage 仅作缓存
 * - 写入路径：走 gamesApi 云函数（admin SDK）——浏览器端 CloudBase JS SDK auth 已损坏，
 *   writeQueue 线上永不落库，故不再使用
 * - 读取路径：后端分页拉全量，云端数据覆盖本地缓存（绝不 limit 截断）
 * - 后端不可达时，回退到本地缓存（保证离线可用）
 */

import {
  saveToBackend,
  saveBatchToBackend,
  loadFromBackend,
  deleteFromBackend,
  type SyncCollection,
} from '../../services/backendSync';

/**
 * 将单条记录 upsert 到云端集合（走后端云函数）
 */
export async function upsertToCloud<T extends { id: string }>(
  collection: string,
  data: T,
): Promise<void> {
  await saveToBackend(collection as SyncCollection, data as Record<string, any>);
}

/**
 * 批量 upsert 到云端（全量提交，不再截断）
 */
export async function batchUpsertToCloud<T extends { id: string }>(
  collection: string,
  items: T[],
  _limit = 50,
): Promise<void> {
  if (items.length === 0) return;
  await saveBatchToBackend(collection as SyncCollection, items as Record<string, any>[]);
}

/**
 * 从云端集合加载所有数据（分页全量，绝不截断）
 */
export async function loadFromCloud<T>(
  collection: string,
  _limit = 500,
): Promise<T[]> {
  return loadFromBackend<T>(collection as SyncCollection);
}

/**
 * 从云端删除记录（走后端云函数）
 */
export async function deleteFromCloud(
  collection: string,
  id: string,
): Promise<void> {
  await deleteFromBackend(collection as SyncCollection, id);
}

/**
 * 通用双写持久化：先写 localStorage，再同步到云端
 * @param storageKey localStorage 键名
 * @param data 要持久化的数据
 * @param cloudCollection CloudBase 集合名（可选）
 */
export function persistWithCloudSync<T extends { id: string }>(
  storageKey: string,
  data: T[],
  cloudCollection?: string,
): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(storageKey, JSON.stringify(data));
  } catch {
    // localStorage 写入失败（可能空间不足）
  }
  if (cloudCollection) {
    batchUpsertToCloud(cloudCollection, data).catch(() => {});
  }
}

/**
 * 通用加载：CloudBase 数据库为权威数据源，localStorage 为缓存
 * 
 * 策略：
 * 1. 先读 localStorage 缓存（同步返回，立即可用）
 * 2. 异步从 CloudBase 加载权威数据，**覆盖**本地缓存（云端为准）
 * 3. CloudBase 不可用时，回退到本地缓存数据
 * 
 * @param storageKey localStorage 缓存键名
 * @param cloudCollection CloudBase 集合名（可选）
 * @returns [缓存数据, cloudSyncPromise] — 缓存数据立即可用，cloudSyncPromise 异步刷新缓存
 */
export function loadWithCloudSync<T extends { id: string }>(
  storageKey: string,
  cloudCollection?: string,
): { data: T[]; cloudSync: Promise<T[]> } {
  // 1. 先从本地缓存读取（同步返回，保证 UI 立即可用）
  let data: T[] = [];
  if (typeof window !== 'undefined') {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) data = JSON.parse(raw);
    } catch {
      // 解析失败，返回空数组
    }
  }

  // 2. 异步从 CloudBase 加载权威数据，**覆盖**本地缓存
  const cloudSync = (async (): Promise<T[]> => {
    if (!cloudCollection) return data;
    const cloudData = await loadFromCloud<T>(cloudCollection);
    if (cloudData.length === 0) return data; // CloudBase 无数据 → 使用本地缓存

    // ✅ CloudBase 数据为权威数据源 → 覆盖本地缓存
    // 合并策略：云端数据覆盖本地同名 ID，本地独有的数据保留
    const cloudMap = new Map(cloudData.map(d => [d.id, d]));
    const localOnlyItems = data.filter(d => !cloudMap.has(d.id));
    const merged = [...cloudData, ...localOnlyItems];

    // 更新本地缓存（以 CloudBase 权威数据为准）
    try {
      localStorage.setItem(storageKey, JSON.stringify(merged));
    } catch { /* 缓存空间不足，静默处理 */ }

    return merged;
  })();

  return { data, cloudSync };
}
