/**
 * 双写渐进迁移工具
 *
 * 写入时：同时写 localStorage 和 CloudBase，CloudBase 失败不阻塞
 * 读取时：CloudBase 优先，失败回退 localStorage
 */
import { getCloudBaseApp, isCloudBaseReady } from './cloudbase';

export interface CloudWriteResult {
  success: boolean;
  error?: string;
}

/** CloudBase 写入 */
export async function cloudWrite(
  collection: string,
  data: Record<string, any>,
  docId?: string
): Promise<CloudWriteResult> {
  if (!isCloudBaseReady()) return { success: false, error: 'CloudBase not ready' };
  try {
    const app = getCloudBaseApp();
    const db = app.database();
    if (docId) {
      await db.collection(collection).doc(docId).update({ ...data, _updatedAt: Date.now() });
    } else {
      await db.collection(collection).add({ ...data, _createdAt: Date.now(), _updatedAt: Date.now() });
    }
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message || String(e) };
  }
}

/** CloudBase 按条件更新 */
export async function cloudUpdateWhere(
  collection: string,
  where: Record<string, any>,
  data: Record<string, any>
): Promise<CloudWriteResult> {
  if (!isCloudBaseReady()) return { success: false, error: 'CloudBase not ready' };
  try {
    const app = getCloudBaseApp();
    const db = app.database();
    await db.collection(collection).where(where).update({ ...data, _updatedAt: Date.now() });
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message || String(e) };
  }
}

/** CloudBase 查询 */
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

/** CloudBase 删除（先查后删，安全规则兼容） */
export async function cloudDelete(
  collection: string,
  where: Record<string, any>
): Promise<CloudWriteResult> {
  if (!isCloudBaseReady()) return { success: false, error: 'CloudBase not ready' };
  try {
    const app = getCloudBaseApp();
    const db = app.database();
    const res = await db.collection(collection).where(where).get();
    for (const doc of res.data) {
      await db.collection(collection).doc(doc._id).remove();
    }
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

    /** 保存（双写） */
    async save(item: T): Promise<void> {
      // 写 localStorage
      try {
        const all: T[] = JSON.parse(localStorage.getItem(lsKey) || '[]');
        const idx = all.findIndex((x: any) => x[idField] === item[idField]);
        if (idx >= 0) all[idx] = item;
        else all.push(item);
        localStorage.setItem(lsKey, JSON.stringify(all));
      } catch { /* ignore */ }
      // 写 CloudBase（best effort）
      cloudWrite(collection, item);
    },

    /** 批量保存 */
    async saveAll(items: T[]): Promise<void> {
      localStorage.setItem(lsKey, JSON.stringify(items));
      for (const item of items) {
        cloudWrite(collection, item);
      }
    },

    /** 删除 */
    async remove(id: string): Promise<void> {
      try {
        const all: T[] = JSON.parse(localStorage.getItem(lsKey) || '[]');
        localStorage.setItem(
          lsKey,
          JSON.stringify(all.filter((x: any) => x[idField] !== id))
        );
      } catch { /* ignore */ }
      cloudDelete(collection, { [idField]: id });
    },

    /** CloudBase 原始写入 */
    cloudWrite: (data: Record<string, any>, docId?: string) =>
      cloudWrite(collection, data, docId),
    cloudRead: (where: Record<string, any>, limit?: number) =>
      cloudRead<T>(collection, where, limit),
  };
}
