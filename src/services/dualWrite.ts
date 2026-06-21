/**
 * 双写渐进迁移工具
 *
 * 写入时：同时写 localStorage 和 CloudBase（通过写入队列，保证重试 + 零丢失）
 * 读取时：CloudBase 优先，失败回退 localStorage
 */
import { getCloudBaseApp, isCloudBaseReady } from './cloudbase';
import { writeQueue } from './writeQueue';

export interface CloudWriteResult {
  success: boolean;
  error?: string;
}

/**
 * CloudBase 写入 — 通过写入队列入队，保证数据不丢失
 * 入队后立即返回 success=true（队列会自动重试）
 */
export async function cloudWrite(
  collection: string,
  data: Record<string, any>,
  docId?: string
): Promise<CloudWriteResult> {
  try {
    if (docId) {
      writeQueue.enqueue({
        collection,
        operation: 'update',
        docId,
        data,
      });
    } else {
      writeQueue.enqueue({
        collection,
        operation: 'add',
        data,
      });
    }
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message || String(e) };
  }
}

/**
 * CloudBase 按条件更新 — 通过写入队列入队
 */
export async function cloudUpdateWhere(
  collection: string,
  where: Record<string, any>,
  data: Record<string, any>
): Promise<CloudWriteResult> {
  try {
    writeQueue.enqueue({
      collection,
      operation: 'update',
      where,
      data,
    });
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message || String(e) };
  }
}

/**
 * CloudBase upsert — 通过写入队列入队
 * 用于有 id 字段的记录，先查后写
 */
export async function cloudUpsert(
  collection: string,
  data: Record<string, any> & { id: string }
): Promise<CloudWriteResult> {
  try {
    writeQueue.enqueue({
      collection,
      operation: 'upsert',
      data,
    });
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message || String(e) };
  }
}

/** CloudBase 查询（读取路径，不经过队列） */
export async function cloudRead<T = any>(
  collection: string,
  where: Record<string, any>,
  limit?: number,
  orderBy?: { field: string; direction: 'asc' | 'desc' }
): Promise<T[]> {
  if (!isCloudBaseReady()) return [];
  try {
    const app = getCloudBaseApp();
    const db = app.database();
    let query = db.collection(collection).where(where);
    if (orderBy) query = query.orderBy(orderBy.field, orderBy.direction);
    if (limit) query = query.limit(limit);
    const res = await query.get();
    return (res.data || []) as T[];
  } catch {
    return [];
  }
}

/**
 * CloudBase 删除（先查后删） — 通过写入队列入队
 */
export async function cloudDelete(
  collection: string,
  where: Record<string, any>
): Promise<CloudWriteResult> {
  try {
    writeQueue.enqueue({
      collection,
      operation: 'delete',
      where,
    });
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message || String(e) };
  }
}

/**
 * 创建双写 store 工厂
 * @param lsKey localStorage key
 * @param collection CloudBase 集合名
 * @param idField ID 字段名，默认 'id'
 */
export function createDualStore<T extends Record<string, any>>(
  lsKey: string,
  collection: string,
  idField: string = 'id'
) {
  return {
    /** 读取全部：CloudBase 优先，失败回退 localStorage */
    async getAll(whereFilter?: Record<string, any>): Promise<T[]> {
      try {
        if (isCloudBaseReady()) {
          const data = await cloudRead<T>(collection, whereFilter || {}, 500, {
            field: '_updatedAt',
            direction: 'desc',
          });
          if (data.length > 0) return data;
        }
      } catch { /* fallback */ }
      try {
        const raw = localStorage.getItem(lsKey);
        return raw ? JSON.parse(raw) : [];
      } catch {
        return [];
      }
    },

    /** 按 ID 查询 */
    async getById(id: string): Promise<T | null> {
      try {
        if (isCloudBaseReady()) {
          const results = await cloudRead<T>(collection, { [idField]: id }, 1);
          if (results.length > 0) return results[0];
        }
      } catch { /* fallback */ }
      try {
        const all: T[] = JSON.parse(localStorage.getItem(lsKey) || '[]');
        return all.find((item: any) => item[idField] === id) || null;
      } catch {
        return null;
      }
    },

    /** 保存（双写）— CloudBase 通过队列入队 */
    async save(item: T): Promise<void> {
      // 写 localStorage
      try {
        const all: T[] = JSON.parse(localStorage.getItem(lsKey) || '[]');
        const idx = all.findIndex((x: any) => x[idField] === item[idField]);
        if (idx >= 0) all[idx] = item;
        else all.push(item);
        localStorage.setItem(lsKey, JSON.stringify(all));
      } catch { /* ignore */ }
      // 写 CloudBase（通过队列 upsert，避免重复文档）
      await cloudUpsert(collection, item as Record<string, any> & { id: string });
    },

    /** 批量保存 — CloudBase 通过队列入队 */
    async saveAll(items: T[]): Promise<void> {
      localStorage.setItem(lsKey, JSON.stringify(items));
      for (const item of items) {
        await cloudUpsert(collection, item as Record<string, any> & { id: string });
      }
    },

    /** 删除 — CloudBase 通过队列入队 */
    async remove(id: string): Promise<void> {
      try {
        const all: T[] = JSON.parse(localStorage.getItem(lsKey) || '[]');
        localStorage.setItem(
          lsKey,
          JSON.stringify(all.filter((x: any) => x[idField] !== id))
        );
      } catch { /* ignore */ }
      await cloudDelete(collection, { [idField]: id });
    },

    /** CloudBase 原始写入 */
    cloudWrite: (data: Record<string, any>, docId?: string) =>
      cloudWrite(collection, data, docId),
    cloudRead: (where: Record<string, any>, limit?: number) =>
      cloudRead<T>(collection, where, limit),
  };
}
