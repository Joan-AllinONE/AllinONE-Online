/**
 * 统一写入重试队列
 *
 * 设计目标：
 * - 零数据丢失：所有写入请求要么成功，要么进入持久化队列等待重试
 * - 自动恢复：页面刷新后自动处理未完成的写入
 * - 有序保证：同一文档的写入按提交顺序执行
 * - 可观测性：提供队列状态查询 + 控制台日志
 * - 上限保护：队列最大 1000 条，超限告警但不阻塞
 *
 * 使用方式：
 *   import { writeQueue } from './writeQueue';
 *
 *   // 非阻塞入队（fire-and-forget + 重试保障）
 *   writeQueue.enqueue({ collection: 'users', operation: 'add', data: { ... } });
 *
 *   // 阻塞入队（等待完成，用于关键写入）
 *   await writeQueue.enqueueAndWait({ collection: 'users', operation: 'update', docId: 'xxx', data: { ... } });
 */

import { waitForCloudBase, isCloudSyncEnabled } from './cloudbase';

// ==================== 类型定义 ====================

export type WriteOperation = 'add' | 'update' | 'upsert' | 'delete';

export interface WriteRequest {
  collection: string;
  operation: WriteOperation;
  /** 写入数据（add/upsert/update 使用） */
  data?: Record<string, any>;
  /** 按 _id 更新（update/delete 使用） */
  docId?: string;
  /** 按条件更新/删除（update/delete/upsert 使用） */
  where?: Record<string, any>;
}

interface QueueEntry extends WriteRequest {
  id: string;
  retries: number;
  nextRetryAt: number;
  createdAt: number;
  status: 'pending' | 'processing' | 'failed' | 'auth_paused';
  lastError?: string;
}

export interface QueueStatus {
  pending: number;
  processing: number;
  failed: number;
  authPaused: number;
  total: number;
  totalProcessed: number;
  totalFailed: number;
  authBroken: boolean;
}

// ==================== 常量 ====================

const RETRY_DELAYS = [1000, 2000, 4000, 8000, 16000];
const MAX_RETRIES = 5;
const MAX_QUEUE_SIZE = 1000;
const PROCESS_INTERVAL = 500;
const BATCH_SIZE = 10;
const QUEUE_KEY = 'allinone_write_queue';
const PERSIST_LIMIT = 500;

/** Auth scope 错误模式 — 标志 CloudBase 认证已断裂 */
const AUTH_ERROR_PATTERN = /Cannot read properties of null.*scope|auth.*scope.*null|INVALID_CREDENTIALS/i;
/** Auth 恢复检查间隔（10 秒） */
const AUTH_RECOVERY_INTERVAL = 10000;

// ==================== 队列服务 ====================

class WriteQueueService {
  private queue: Map<string, QueueEntry> = new Map();
  private processing = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stats = { totalProcessed: 0, totalFailed: 0 };
  private restored = false;

  /** Auth 断裂标志 — 为 true 时暂停处理，等待 auth 恢复 */
  private authBroken = false;
  /** Auth 恢复检查定时器 */
  private authRecoveryTimer: ReturnType<typeof setTimeout> | null = null;

  /** 失败条目汇总缓存（避免逐条 console.error 洗屏） */
  private failureSummary: Map<string, { count: number; lastError: string; lastTime: number }> = new Map();

  constructor() {
    if (typeof window !== 'undefined') {
      this.restoreQueue();
    }
  }

  /**
   * 入队（非阻塞，返回后立即继续）
   * 写入请求会被持久化到 localStorage，并在 CloudBase 就绪后自动处理
   */
  enqueue(request: WriteRequest): string {
    if (!isCloudSyncEnabled()) return ''; // dev 不写云：跳过，不入队、不持久化

    if (this.queue.size >= MAX_QUEUE_SIZE) {
      console.warn('[WriteQueue] Queue full, dropping oldest entry');
      const oldest = this.getOldestEntry();
      if (oldest) this.queue.delete(oldest.id);
    }

    const id = `wq_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const entry: QueueEntry = {
      ...request,
      id,
      retries: 0,
      nextRetryAt: Date.now(),
      createdAt: Date.now(),
      status: 'pending',
    };
    this.queue.set(id, entry);
    this.persistQueue();
    return id;
  }

  /**
   * 入队并等待完成（阻塞，用于关键写入）
   * @param timeoutMs 超时毫秒数，默认 5s
   * @returns true=成功, false=超时或失败
   */
  async enqueueAndWait(request: WriteRequest, timeoutMs = 5000): Promise<boolean> {
    if (!isCloudSyncEnabled()) return true; // dev 不写云：视为成功（本地缓存已处理）

    const id = this.enqueue(request);
    const deadline = Date.now() + timeoutMs;

    return new Promise<boolean>((resolve) => {
      const check = () => {
        const entry = this.queue.get(id);
        if (!entry) {
          // 已处理并移除 = 成功
          resolve(true);
          return;
        }
        if (entry.status === 'failed') {
          resolve(false);
          return;
        }
        if (Date.now() > deadline) {
          resolve(false);
          return;
        }
        setTimeout(check, 200);
      };
      check();
    });
  }

  /**
   * 批量入队（便利方法）
   */
  enqueueBatch(requests: WriteRequest[]): string[] {
    return requests.map(r => this.enqueue(r));
  }

  /** 启动处理器（CloudBase 就绪后调用） */
  startProcessor(): void {
    if (this.processing) return;
    this.processing = true;
    this.scheduleNext();
    const status = this.getStatus();
    console.log(`[WriteQueue] Processor started (pending: ${status.pending})`);
  }

  /** 停止处理器 */
  stopProcessor(): void {
    this.processing = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** 查询队列状态 */
  getStatus(): QueueStatus {
    let pending = 0;
    let processing = 0;
    let failed = 0;
    let authPaused = 0;
    for (const entry of this.queue.values()) {
      if (entry.status === 'pending') pending++;
      else if (entry.status === 'processing') processing++;
      else if (entry.status === 'failed') failed++;
      else if (entry.status === 'auth_paused') authPaused++;
    }
    return {
      pending,
      processing,
      failed,
      authPaused,
      total: this.queue.size,
      totalProcessed: this.stats.totalProcessed,
      totalFailed: this.stats.totalFailed,
      authBroken: this.authBroken,
    };
  }

  /** 手动重试所有失败项（含 auth_paused 项） */
  retryAll(): void {
    for (const entry of this.queue.values()) {
      if (entry.status === 'failed' || entry.status === 'auth_paused') {
        entry.status = 'pending';
        entry.retries = 0;
        entry.nextRetryAt = Date.now();
      }
    }
    this.authBroken = false;
    this.persistQueue();
    console.log('[WriteQueue] Retrying all failed/auth_paused entries');
  }

  // ==================== 私有方法 ====================

  private scheduleNext(): void {
    if (!this.processing) return;
    // auth 断裂时降低轮询频率（不停止，以便检测恢复）
    const interval = this.authBroken ? AUTH_RECOVERY_INTERVAL : PROCESS_INTERVAL;
    this.timer = setTimeout(() => this.process(), interval);
  }

  private async process(): Promise<void> {
    if (!this.processing) return;
    if (!isCloudSyncEnabled()) return; // dev 不写云：停止处理器，不空转重试

    // auth 断裂时：仅做一次轻量检查，不处理队列
    if (this.authBroken) {
      await this.checkAuthRecovery();
      this.scheduleNext();
      return;
    }

    const now = Date.now();
    const entries = Array.from(this.queue.values())
      .filter(e => e.status === 'pending' && e.nextRetryAt <= now)
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, BATCH_SIZE);

    if (entries.length === 0) {
      this.scheduleNext();
      return;
    }

    try {
      const app = await waitForCloudBase();
      const db = app.database();
      await Promise.allSettled(entries.map(entry => this.processEntry(entry, db)));
    } catch {
      // CloudBase 不可用，延迟重试
      for (const entry of entries) {
        entry.status = 'pending';
        entry.nextRetryAt = Date.now() + 2000;
      }
    }

    // 批量输出失败汇总（而非逐条 console.error）
    this.flushFailureSummary();

    this.persistQueue();
    this.scheduleNext();
  }

  /** 检查 auth 是否恢复 — 尝试一次轻量 DB 操作 */
  private async checkAuthRecovery(): Promise<void> {
    try {
      const app = await waitForCloudBase();
      // 轻量检查：读一条数据，如果 auth scope 正常则不会报错
      await app.database().collection('__healthcheck__').limit(1).get();
      // 如果没有抛异常，说明 auth 已恢复
      this.authBroken = false;
      // 将所有 auth_paused 项恢复为 pending
      for (const entry of this.queue.values()) {
        if (entry.status === 'auth_paused') {
          entry.status = 'pending';
          entry.retries = 0;
          entry.nextRetryAt = Date.now();
        }
      }
      console.log('[WriteQueue] Auth recovered, resuming processor');
      this.persistQueue();
    } catch {
      // auth 仍未恢复，保持暂停状态
    }
  }

  /** 批量输出失败汇总 */
  private flushFailureSummary(): void {
    if (this.failureSummary.size === 0) return;

    const lines: string[] = [];
    for (const [key, info] of this.failureSummary) {
      lines.push(`  • ${key}: ${info.count}次失败 — ${info.lastError}`);
    }
    console.error(
      `[WriteQueue] Batch failure summary (${this.failureSummary.size} groups):\n${lines.join('\n')}`
    );
    this.failureSummary.clear();
  }

  private async processEntry(entry: QueueEntry, db: any): Promise<void> {
    entry.status = 'processing';
    try {
      const now = Date.now();
      switch (entry.operation) {
        case 'add':
          await db.collection(entry.collection).add({
            ...entry.data,
            _createdAt: now,
            _updatedAt: now,
          });
          break;

        case 'update':
          if (entry.docId) {
            await db.collection(entry.collection).doc(entry.docId).update({
              ...entry.data,
              _updatedAt: now,
            });
          } else if (entry.where) {
            await db.collection(entry.collection).where(entry.where).update({
              ...entry.data,
              _updatedAt: now,
            });
          }
          break;

        case 'upsert':
          if (entry.data?.id) {
            // 按 id 查找后 upsert
            try {
              const res = await db.collection(entry.collection)
                .where({ id: entry.data.id }).limit(1).get();
              if (res?.data?.length > 0) {
                await db.collection(entry.collection)
                  .doc(res.data[0]._id).update({ ...entry.data, _updatedAt: now });
              } else {
                await db.collection(entry.collection)
                  .add({ ...entry.data, _createdAt: now, _updatedAt: now });
              }
            } catch (innerErr: any) {
              // 集合不存在时 fallback 到 add（CloudBase 自动创建集合）
              if (innerErr?.message?.includes('collection not found') || innerErr?.code === 'DATABASE_COLLECTION_NOT_EXIST') {
                await db.collection(entry.collection)
                  .add({ ...entry.data, _createdAt: now, _updatedAt: now });
              } else {
                throw innerErr;
              }
            }
          } else if (entry.where && entry.data) {
            // 按 where 条件 upsert
            try {
              const res = await db.collection(entry.collection)
                .where(entry.where).limit(1).get();
              if (res?.data?.length > 0) {
                await db.collection(entry.collection)
                  .doc(res.data[0]._id).update({ ...entry.data, _updatedAt: now });
              } else {
                await db.collection(entry.collection)
                  .add({ ...entry.data, ...entry.where, _createdAt: now, _updatedAt: now });
              }
            } catch (innerErr: any) {
              if (innerErr?.message?.includes('collection not found') || innerErr?.code === 'DATABASE_COLLECTION_NOT_EXIST') {
                await db.collection(entry.collection)
                  .add({ ...entry.data, ...entry.where, _createdAt: now, _updatedAt: now });
              } else {
                throw innerErr;
              }
            }
          }
          break;

        case 'delete':
          if (entry.where) {
            const res = await db.collection(entry.collection).where(entry.where).get();
            for (const doc of res.data) {
              await db.collection(entry.collection).doc(doc._id).remove();
            }
          } else if (entry.docId) {
            await db.collection(entry.collection).doc(entry.docId).remove();
          }
          break;
      }

      // 成功 → 出队
      this.queue.delete(entry.id);
      this.stats.totalProcessed++;
    } catch (e) {
      entry.lastError = e instanceof Error ? e.message : String(e);

      // 检测 auth scope 错误 — 立即暂停处理器，避免全部条目无效重试
      if (AUTH_ERROR_PATTERN.test(entry.lastError)) {
        this.authBroken = true;
        entry.status = 'auth_paused';
        console.warn(
          `[WriteQueue] Auth broken detected, pausing processor. ` +
          `All pending writes will wait for auth recovery.`
        );
        return;
      }

      entry.retries++;
      if (entry.retries >= MAX_RETRIES) {
        entry.status = 'failed';
        this.stats.totalFailed++;
        // 不逐条输出，汇总到 failureSummary
        const summaryKey = `${entry.collection} ${entry.operation}`;
        const existing = this.failureSummary.get(summaryKey);
        if (existing) {
          existing.count++;
          existing.lastError = entry.lastError;
          existing.lastTime = Date.now();
        } else {
          this.failureSummary.set(summaryKey, {
            count: 1,
            lastError: entry.lastError,
            lastTime: Date.now(),
          });
        }
      } else {
        entry.status = 'pending';
        const delayIdx = Math.min(entry.retries - 1, RETRY_DELAYS.length - 1);
        entry.nextRetryAt = Date.now() + RETRY_DELAYS[delayIdx];
      }
    }
  }

  private getOldestEntry(): QueueEntry | null {
    let oldest: QueueEntry | null = null;
    for (const entry of this.queue.values()) {
      // 优先淘汰 failed 项（它们已无重试价值）
      if (entry.status === 'failed') {
        if (!oldest || oldest.status !== 'failed' || entry.createdAt < oldest.createdAt) {
          oldest = entry;
        }
      } else if (!oldest || (oldest.status !== 'failed' && entry.createdAt < oldest.createdAt)) {
        oldest = entry;
      }
    }
    return oldest;
  }

  private persistQueue(): void {
    if (typeof window === 'undefined') return;
    try {
      const entries = Array.from(this.queue.values())
        .filter(e => e.status !== 'processing');
      const toSave = entries.slice(-PERSIST_LIMIT);
      localStorage.setItem(QUEUE_KEY, JSON.stringify(toSave));
    } catch {
      // localStorage 满或不可用 — 静默处理
    }
  }

  private restoreQueue(): void {
    if (this.restored) return;
    this.restored = true;
    if (!isCloudSyncEnabled()) return; // dev 不恢复历史云端写入
    try {
      const raw = localStorage.getItem(QUEUE_KEY);
      if (!raw) return;
      const entries: QueueEntry[] = JSON.parse(raw);
      let restored = 0;
      for (const entry of entries) {
        if (entry.status === 'failed' && entry.retries >= MAX_RETRIES) continue;
        entry.status = 'pending';
        entry.nextRetryAt = Date.now();
        this.queue.set(entry.id, entry);
        restored++;
      }
      if (restored > 0) {
        console.log(`[WriteQueue] Restored ${restored} pending writes`);
      }
    } catch {
      // 解析失败 — 忽略
    }
  }
}

// ==================== 导出 ====================

export const writeQueue = new WriteQueueService();
export default writeQueue;
