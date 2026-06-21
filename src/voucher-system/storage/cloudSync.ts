/**
 * CloudBase 通用同步工具
 * 为凭证系统各服务提供 CloudBase 数据库优先 + localStorage 缓存能力
 *
 * 架构原则（2026-06-18 上线准备）：
 * - CloudBase 数据库是权威数据源，localStorage 仅作缓存
 * - 写入路径：通过 writeQueue 入队 CloudBase，同时更新本地缓存
 * - 读取路径：CloudBase 数据覆盖本地缓存（云端为准）
 * - CloudBase 不可用时，回退到本地缓存（保证离线可用）
 */

import { isCloudBaseReady, getCloudBaseApp } from '../../services/cloudbase';
import { writeQueue } from '../../services/writeQueue';

/**
 * 将单条记录 upsert 到 CloudBase 集合（通过写入队列，保证不丢失）
 */
export async function upsertToCloud<T extends { id: string }>(
  collection: string,
  data: T,
): Promise<void> {
  writeQueue.enqueue({
    collection,
    operation: 'upsert',
    data: data as Record<string, any>,
  });
}

/**
 * 批量 upsert 到 CloudBase（全量入队，不再截断）
 */
export async function batchUpsertToCloud<T extends { id: string }>(
  collection: string,
  items: T[],
  _limit = 50,
): Promise<void> {
  if (items.length === 0) return;
  for (const item of items) {
    writeQueue.enqueue({
      collection,
      operation: 'upsert',
      data: item as Record<string, any>,
    });
  }
}

/**
 * 从 CloudBase 集合加载所有数据（读取路径，不经过队列）
 */
export async function loadFromCloud<T>(
  collection: string,
  limit = 500,
): Promise<T[]> {
  if (!isCloudBaseReady()) return [];
  try {
    const db = getCloudBaseApp().database();
    const res = await db.collection(collection).limit(limit).get();
    return res.data as T[];
  } catch {
    return [];
  }
}

/**
 * 从 CloudBase 删除记录（通过写入队列，保证不丢失）
 */
export async function deleteFromCloud(
  collection: string,
  id: string,
): Promise<void> {
  writeQueue.enqueue({
    collection,
    operation: 'delete',
    where: { id },
  });
}

/**
 * 通用双写持久化：先写 localStorage，再通过写入队列同步到 CloudBase
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
