/**
 * A币电子凭证系统 - 数据库存储层
 * 使用 localStorage 模拟关系型数据库
 * 设计为可轻松迁移到真实数据库（如 MySQL/PostgreSQL）
 */

import type {
  Voucher,
  Transaction,
  UserVoucherStats,
  VoucherSystemStats,
  VoucherFilter,
  PaginatedResult,
} from '../types';
import { VoucherStatus, TransactionType } from '../types';
import { saveVoucherToBackend, loadCollectionFromBackend } from '../../services/voucherBackend';
import { isCloudHosting } from '../../services/backendSync';
import { SEED_DATA_TAG } from '../../utils/seedTestData';

// 存储键名（模拟表名）
const STORAGE_KEYS = {
  VOUCHERS: 'allinone_vouchers',
  TRANSACTIONS: 'allinone_voucher_transactions',
  STATS: 'allinone_voucher_stats',
  SYSTEM_STATS: 'allinone_voucher_system_stats',
  INDEX_HOLDER: 'allinone_voucher_index_holder', // 持有者索引
  INDEX_SERIAL: 'allinone_voucher_index_serial', // 编号索引
};

// 系统容量上限：10亿
const SYSTEM_CAPACITY = 1_000_000_000;

/**
 * 凭证数据库类
 * 提供类似 SQL 数据库的 CRUD 操作
 */
export class VoucherDatabase {
  private static instance: VoucherDatabase | null = null;

  // 内存缓存（减少 localStorage 读取）
  private voucherCache: Map<string, Voucher> = new Map();
  private transactionCache: Map<string, Transaction> = new Map();
  private cacheInitialized = false;

  // 🔒 S3-4 修复：脏标记 + 批量持久化（减少 localStorage 写入频率）
  private voucherDirty = false;
  private transactionDirty = false;
  private indexDirty = false;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly PERSIST_DELAY = 500; // 500ms 批量窗口

  // 🔒 CloudBase 增量同步：仅同步变更的条目，避免全量入队导致队列洪水
  private cloudSyncDirtyVouchers = new Set<string>();
  private cloudSyncDirtyTransactions = new Set<string>();
  private cloudSyncTimer: ReturnType<typeof setTimeout> | null = null;
  /** 已确认推送到服务端的凭证/交易 id（兜底全量同步只推未推送过的，防止每次防抖重复轰炸 429）
   *  持久化到 localStorage 并带 24h TTL：刷新页面不再重推全部凭证；超时后自动允许重推（兼容服务端清库） */
  private cloudSyncedIds = new Set<string>();
  private cloudSyncedAt = new Map<string, number>();
  private static readonly SYNCED_IDS_KEY = 'voucher_system_cloud_synced_ids';
  private static readonly SYNCED_IDS_TTL = 24 * 60 * 60 * 1000;
  private readonly CLOUD_SYNC_DELAY = 2000; // 2s 防抖窗口

  /** 从 localStorage 恢复已推送记录（TTL 过期的丢弃，允许重推） */
  private loadSyncedIds(): void {
    if (typeof window === 'undefined') return;
    try {
      const raw = localStorage.getItem(VoucherDatabase.SYNCED_IDS_KEY);
      if (!raw) return;
      const obj = JSON.parse(raw) as Record<string, number>;
      const now = Date.now();
      for (const [id, ts] of Object.entries(obj)) {
        if (typeof ts === 'number' && now - ts < VoucherDatabase.SYNCED_IDS_TTL) {
          this.cloudSyncedIds.add(id);
          this.cloudSyncedAt.set(id, ts);
        }
      }
    } catch { /* 损坏则忽略，重新全量同步 */ }
  }

  /** 持久化已推送记录（限流 300 条防 localStorage 膨胀） */
  private persistSyncedIds(): void {
    if (typeof window === 'undefined') return;
    try {
      const now = Date.now();
      const obj: Record<string, number> = {};
      for (const [id, ts] of this.cloudSyncedAt) {
        if (now - ts < VoucherDatabase.SYNCED_IDS_TTL) obj[id] = ts;
      }
      localStorage.setItem(VoucherDatabase.SYNCED_IDS_KEY, JSON.stringify(obj));
    } catch { /* 容量不足等忽略 */ }
  }

  /** 标记推送成功（内存 + 持久化） */
  private markSynced(id: string): void {
    this.cloudSyncedIds.add(id);
    this.cloudSyncedAt.set(id, Date.now());
    this.persistSyncedIds();
  }

  /**
   * 下行同步（2026-10-17 交易闭环最后一环）：服务端是账本（云端即账本铁律），
   * 合约履约/商店发货等在服务端把凭证转移给本人，但客户端从未拉取 →
   * 用户在浏览器永远"看不到"已到账的道具。此方法拉取 currentHolderId=本人
   * 的服务端凭证并合并入本地缓存。冲突策略：本地更新时间更新则保留本地（本地可能有
   * 未推送的变更），否则以服务端为准。拉回的凭证标记已同步防回推。
   * @returns 合并的凭证数
   */
  async pullMyVouchersFromBackend(myUserId: string): Promise<number> {
    if (typeof window === 'undefined' || !myUserId) return 0;
    try {
      const rows = await loadCollectionFromBackend<any>('vouchers');
      if (!Array.isArray(rows) || rows.length === 0) return 0;
      let merged = 0;
      for (const doc of rows) {
        if (!doc || String(doc.currentHolderId || '') !== myUserId) continue;
        const id = String(doc.id || doc._id || '');
        if (!id) continue;
        const local = this.voucherCache.get(id);
        const serverTs = Number(doc.updatedAt || doc.lastTransferAt || 0);
        const localTs = Number(local && (local.updatedAt || (local as any).lastTransferAt) || 0);
        if (local && localTs > serverTs) continue; // 本地较新（可能有未推送变更），保留本地
        this.voucherCache.set(id, doc as Voucher);
        this.voucherDirty = true;
        this.markSynced(id); // 服务端来的不需要再推回
        merged++;
      }
      if (merged > 0) {
        console.log(`[VoucherDatabase] 下行同步：从服务端合并 ${merged} 张本人凭证`);
        this.schedulePersist();
      }
      return merged;
    } catch (e: any) {
      console.warn('[VoucherDatabase] 下行同步失败:', e?.message || e);
      return 0;
    }
  }

  private constructor() {
    this.initCache();
    this.loadSyncedIds();
  }

  /**
   * 获取单例实例
   */
  static getInstance(): VoucherDatabase {
    if (!VoucherDatabase.instance) {
      VoucherDatabase.instance = new VoucherDatabase();
    }
    return VoucherDatabase.instance;
  }

  /**
   * 重置单例（测试用）
   */
  static resetInstance(): void {
    VoucherDatabase.instance = null;
  }

  // ==================== 初始化与缓存 ====================

  /**
   * 初始化缓存
   */
  private initCache(): void {
    if (typeof window === 'undefined') return;

    try {
      // 加载所有凭证到缓存
      const vouchersData = localStorage.getItem(STORAGE_KEYS.VOUCHERS);
      if (vouchersData) {
        const vouchers: Voucher[] = JSON.parse(vouchersData);
        vouchers.forEach(v => this.voucherCache.set(v.id, v));
      }

      // 加载所有交易到缓存
      const transactionsData = localStorage.getItem(STORAGE_KEYS.TRANSACTIONS);
      if (transactionsData) {
        const transactions: Transaction[] = JSON.parse(transactionsData);
        transactions.forEach(t => this.transactionCache.set(t.id, t));
      }

      this.cacheInitialized = true;
      this.initCloudBaseSync().catch(() => {});
    } catch (error) {
      console.error('[VoucherDatabase] 缓存初始化失败:', error);
    }
  }

  /**
   * 调度批量持久化（S3-4：500ms 窗口合并多次写入）
   */
  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.flush();
      this.persistTimer = null;
    }, this.PERSIST_DELAY);
  }

  /**
   * 立即刷新所有脏数据到 localStorage
   */
  private flush(): void {
    if (this.voucherDirty) this._persistVouchers();
    if (this.transactionDirty) this._persistTransactions();
    if (this.indexDirty) this._persistIndex();
  }

  /**
   * 持久化凭证数据（内部实现）
   */
  private _persistVouchers(): void {
    if (typeof window === 'undefined') return;

    const vouchers = Array.from(this.voucherCache.values());
    localStorage.setItem(STORAGE_KEYS.VOUCHERS, JSON.stringify(vouchers));
    this.syncVouchersToCloud();
    this.voucherDirty = false;

    // 标记索引需更新（延迟执行）
    this.indexDirty = true;
  }

  /**
   * 持久化交易数据（内部实现，S3-4）
   */
  private _persistTransactions(): void {
    if (typeof window === 'undefined') return;

    const transactions = Array.from(this.transactionCache.values());
    localStorage.setItem(STORAGE_KEYS.TRANSACTIONS, JSON.stringify(transactions));
    this.syncTransactionsToCloud();
    this.transactionDirty = false;
  }

  /**
   * 持久化索引数据（S3-4）
   */
  private _persistIndex(): void {
    if (typeof window === 'undefined') return;
    this.updateHolderIndex();
    this.indexDirty = false;
  }

  /**
   * 持久化交易数据（旧接口，通过 schedulePersist 批量写入）
   */
  private persistTransactions(): void {
    this.transactionDirty = true;
    this.schedulePersist();
  }

  /**
   * 持久化凭证数据（旧接口，通过 schedulePersist 批量写入）
   */
  private persistVouchers(): void {
    this.voucherDirty = true;
    this.schedulePersist();
  }

  /**
   * 更新持有者索引
   */
  private updateHolderIndex(): void {
    if (typeof window === 'undefined') return;

    const index: Record<string, string[]> = {};
    this.voucherCache.forEach(voucher => {
      if (!index[voucher.currentHolderId]) {
        index[voucher.currentHolderId] = [];
      }
      index[voucher.currentHolderId].push(voucher.id);
    });
    localStorage.setItem(STORAGE_KEYS.INDEX_HOLDER, JSON.stringify(index));
  }

  // ==================== 凭证 CRUD 操作 ====================

  /**
   * 插入凭证（INSERT）
   */
  insertVoucher(voucher: Voucher): void {
    // 检查是否已达系统上限
    if (this.voucherCache.size >= SYSTEM_CAPACITY) {
      throw new Error('系统凭证数量已达上限（10亿）');
    }

    // 检查ID唯一性
    if (this.voucherCache.has(voucher.id)) {
      throw new Error(`凭证ID已存在: ${voucher.id}`);
    }

    this.voucherCache.set(voucher.id, voucher);
    this.cloudSyncDirtyVouchers.add(voucher.id);
    this.persistVouchers();
  }

  /**
   * 更新凭证（UPDATE）
   */
  updateVoucher(voucher: Voucher): void {
    if (!this.voucherCache.has(voucher.id)) {
      throw new Error(`凭证不存在: ${voucher.id}`);
    }

    this.voucherCache.set(voucher.id, voucher);
    this.cloudSyncDirtyVouchers.add(voucher.id);
    this.persistVouchers();
  }

  /**
   * 获取凭证（SELECT by ID）
   */
  getVoucherById(id: string): Voucher | null {
    return this.voucherCache.get(id) || null;
  }

  /**
   * 获取凭证（SELECT by Serial Number）
   */
  getVoucherBySerialNumber(serialNumber: string): Voucher | null {
    for (const voucher of this.voucherCache.values()) {
      if (voucher.serialNumber === serialNumber) {
        return voucher;
      }
    }
    return null;
  }

  /**
   * 获取所有凭证（SELECT *）
   */
  getAllVouchers(): Voucher[] {
    return Array.from(this.voucherCache.values());
  }

  /**
   * 筛选凭证（SELECT with WHERE）
   */
  filterVouchers(filter: VoucherFilter): Voucher[] {
    let results = Array.from(this.voucherCache.values());

    if (filter.status) {
      results = results.filter(v => v.status === filter.status);
    }

    if (filter.holderId) {
      results = results.filter(v => v.currentHolderId === filter.holderId);
    }

    if (filter.minDenomination !== undefined) {
      results = results.filter(v => v.denomination >= filter.minDenomination!);
    }

    if (filter.maxDenomination !== undefined) {
      results = results.filter(v => v.denomination <= filter.maxDenomination!);
    }

    if (filter.startDate !== undefined) {
      results = results.filter(v => v.createdAt >= filter.startDate!);
    }

    if (filter.endDate !== undefined) {
      results = results.filter(v => v.createdAt <= filter.endDate!);
    }

    if (filter.keyword) {
      const keyword = filter.keyword.toLowerCase();
      results = results.filter(v =>
        v.serialNumber.toLowerCase().includes(keyword) ||
        v.currentHolderName.toLowerCase().includes(keyword) ||
        v.metadata?.name?.toLowerCase().includes(keyword) ||
        v.metadata?.description?.toLowerCase().includes(keyword)
      );
    }

    // 默认按创建时间倒序
    return results.sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * 分页查询
   */
  getVouchersPaginated(
    filter: VoucherFilter,
    page: number = 1,
    pageSize: number = 20
  ): PaginatedResult<Voucher> {
    const allResults = this.filterVouchers(filter);
    const total = allResults.length;
    const startIndex = (page - 1) * pageSize;
    const endIndex = startIndex + pageSize;
    const items = allResults.slice(startIndex, endIndex);

    return {
      items,
      total,
      page,
      pageSize,
      hasMore: endIndex < total,
    };
  }

  /**
   * 获取用户的所有凭证
   */
  getVouchersByHolder(holderId: string): Voucher[] {
    return Array.from(this.voucherCache.values())
      .filter(v => v.currentHolderId === holderId)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  // ==================== 交易记录操作 ====================

  /**
   * 插入交易记录
   */
  insertTransaction(transaction: Transaction): void {
    this.transactionCache.set(transaction.id, transaction);
    this.cloudSyncDirtyTransactions.add(transaction.id);
    this.persistTransactions();
  }

  /**
   * 批量插入交易记录
   */
  insertTransactions(transactions: Transaction[]): void {
    transactions.forEach(t => {
      this.transactionCache.set(t.id, t);
      this.cloudSyncDirtyTransactions.add(t.id);
    });
    this.persistTransactions();
  }

  /**
   * 获取交易记录
   */
  getTransactionById(id: string): Transaction | null {
    return this.transactionCache.get(id) || null;
  }

  /**
   * 获取凭证的所有交易记录
   */
  getTransactionsByVoucherId(voucherId: string): Transaction[] {
    return Array.from(this.transactionCache.values())
      .filter(t => t.voucherId === voucherId)
      .sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * 获取用户的所有相关交易
   */
  getTransactionsByUser(userId: string): Transaction[] {
    return Array.from(this.transactionCache.values())
      .filter(t => t.fromUserId === userId || t.toUserId === userId)
      .sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * 获取用户的交易统计
   */
  getUserTransactionStats(userId: string): { sent: number; received: number } {
    let sent = 0;
    let received = 0;

    this.transactionCache.forEach(t => {
      if (t.type === TransactionType.TRANSFER) {
        if (t.fromUserId === userId) sent++;
        if (t.toUserId === userId) received++;
      }
    });

    return { sent, received };
  }

  // ==================== 统计查询 ====================

  /**
   * 获取用户持有统计
   */
  getUserStats(userId: string): UserVoucherStats {
    const userVouchers = this.getVouchersByHolder(userId);
    const { sent, received } = this.getUserTransactionStats(userId);

    return {
      userId,
      totalCount: userVouchers.length,
      totalValue: userVouchers.reduce((sum, v) => sum + v.denomination, 0),
      activeCount: userVouchers.filter(v => v.status === VoucherStatus.ACTIVE).length,
      frozenCount: userVouchers.filter(v => v.status === VoucherStatus.FROZEN).length,
      receivedCount: received,
      sentCount: sent,
    };
  }

  /**
   * 获取系统统计
   */
  getSystemStats(): VoucherSystemStats {
    const allVouchers = Array.from(this.voucherCache.values());
    const allTransactions = Array.from(this.transactionCache.values());

    const uniqueHolders = new Set(allVouchers.map(v => v.currentHolderId)).size;
    const transferCount = allTransactions.filter(
      t => t.type === TransactionType.TRANSFER
    ).length;

    return {
      totalVouchers: allVouchers.length,
      totalValue: allVouchers.reduce((sum, v) => sum + v.denomination, 0),
      activeVouchers: allVouchers.filter(v => v.status === VoucherStatus.ACTIVE).length,
      totalTransactions: allTransactions.length,
      totalTransfers: transferCount,
      uniqueHolders,
      systemCapacity: SYSTEM_CAPACITY,
      utilizationRate: (allVouchers.length / SYSTEM_CAPACITY) * 100,
    };
  }

  // ==================== 高级查询 ====================

  /**
   * 搜索凭证（全文搜索）
   */
  searchVouchers(query: string): Voucher[] {
    const lowerQuery = query.toLowerCase().trim();
    if (!lowerQuery) return [];

    return Array.from(this.voucherCache.values()).filter(v =>
      v.id.toLowerCase().includes(lowerQuery) ||
      v.serialNumber.toLowerCase().includes(lowerQuery) ||
      v.currentHolderName.toLowerCase().includes(lowerQuery) ||
      v.metadata?.name?.toLowerCase().includes(lowerQuery) ||
      v.metadata?.description?.toLowerCase().includes(lowerQuery) ||
      v.metadata?.issuer?.toLowerCase().includes(lowerQuery)
    );
  }

  /**
   * 获取凭证流转历史
   */
  getVoucherHistory(voucherId: string): { voucher: Voucher | null; transactions: Transaction[] } {
    const voucher = this.getVoucherById(voucherId);
    const transactions = this.getTransactionsByVoucherId(voucherId);
    return { voucher, transactions };
  }

  /**
   * 获取最近的交易
   */
  getRecentTransactions(limit: number = 10): Transaction[] {
    return Array.from(this.transactionCache.values())
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);
  }

  /**
   * 获取最近的凭证
   */
  getRecentVouchers(limit: number = 10): Voucher[] {
    return Array.from(this.voucherCache.values())
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
  }

  // ==================== 数据完整性检查 ====================

  /**
   * 验证数据一致性
   */
  verifyDataIntegrity(): { valid: boolean; issues: string[] } {
    const issues: string[] = [];

    // 检查所有凭证的持有者是否与最新交易一致
    this.voucherCache.forEach(voucher => {
      const transactions = this.getTransactionsByVoucherId(voucher.id);
      if (transactions.length > 0) {
        const latestTx = transactions[transactions.length - 1];
        if (latestTx.toUserId !== voucher.currentHolderId) {
          issues.push(
            `凭证 ${voucher.id} 持有者不一致: 凭证记录为 ${voucher.currentHolderId}, 最新交易为 ${latestTx.toUserId}`
          );
        }
      }
    });

    return {
      valid: issues.length === 0,
      issues,
    };
  }

  // ==================== 数据导出 ====================

  /**
   * 导出所有数据（用于备份）
   */
  exportAllData(): {
    vouchers: Voucher[];
    transactions: Transaction[];
    stats: VoucherSystemStats;
    exportedAt: number;
  } {
    return {
      vouchers: this.getAllVouchers(),
      transactions: Array.from(this.transactionCache.values()),
      stats: this.getSystemStats(),
      exportedAt: Date.now(),
    };
  }

  /**
   * 导入数据（用于恢复）
   */
  importData(data: {
    vouchers: Voucher[];
    transactions: Transaction[];
  }): void {
    // 清空现有数据
    this.voucherCache.clear();
    this.transactionCache.clear();
    this.cloudSyncDirtyVouchers.clear();
    this.cloudSyncDirtyTransactions.clear();

    // 导入凭证
    data.vouchers.forEach(v => {
      this.voucherCache.set(v.id, v);
      this.cloudSyncDirtyVouchers.add(v.id);
    });
    this.persistVouchers();

    // 导入交易
    data.transactions.forEach(t => {
      this.transactionCache.set(t.id, t);
      this.cloudSyncDirtyTransactions.add(t.id);
    });
    this.persistTransactions();
  }

  // ==================== 系统容量检查 ====================

  /**
   * 检查是否还有容量
   */
  hasCapacity(count: number = 1): boolean {
    return (this.voucherCache.size + count) <= SYSTEM_CAPACITY;
  }

  /**
   * 获取剩余容量
   */
  getRemainingCapacity(): number {
    return SYSTEM_CAPACITY - this.voucherCache.size;
  }

  // ==================== CloudBase 双写（通过写入队列） ====================

  /** 测试数据守卫（方案 A 环境隔离）：prod（云端真实库）绝不推送 seed 标识的测试凭证 */
  private isSeedVoucher(v: any): boolean {
    const tags = v?.metadata?.tags;
    return Array.isArray(tags) && tags.includes(SEED_DATA_TAG);
  }

  private syncVouchersToCloud(): void {
    if (typeof window === 'undefined') return;
    // Bug 013 修复：写入改走 gamesApi 云函数（admin SDK，无浏览器端 auth 限制）
    // 不再使用 writeQueue（CloudBase JS SDK 浏览器端 auth 已损坏，线上永落库）
    const prodGuard = isCloudHosting();
    const dirty = Array.from(this.cloudSyncDirtyVouchers).filter(id => {
      const v = this.voucherCache.get(id);
      if (prodGuard && v && this.isSeedVoucher(v)) {
        console.debug(`[VoucherDatabase] 线上环境跳过测试凭证 ${id} 的云同步（防污染真实数据）`);
        return false;
      }
      return true;
    });
    this.cloudSyncDirtyVouchers.clear();
    if (dirty.length === 0) {
      this.scheduleCloudSyncFallback();
      return;
    }
    for (const id of dirty) {
      const v = this.voucherCache.get(id);
      if (v) {
        saveVoucherToBackend('vouchers', v as any).then((r: { success?: boolean; error?: string }) => {
          if (!r || !r.success) {
            console.warn(`[VoucherDatabase] 凭证 ${id} 同步到服务端失败:`, r?.error || '未知错误');
          } else {
            this.markSynced(id);
          }
        }).catch((err: any) => {
          console.warn(`[VoucherDatabase] 凭证 ${id} 同步请求异常:`, err?.message || err);
        });
      }
    }
    this.scheduleCloudSyncFallback();
  }

  private syncTransactionsToCloud(): void {
    if (typeof window === 'undefined') return;
    const dirty = Array.from(this.cloudSyncDirtyTransactions);
    this.cloudSyncDirtyTransactions.clear();
    if (dirty.length === 0) {
      this.scheduleCloudSyncFallback();
      return;
    }
    for (const id of dirty) {
      const tx = this.transactionCache.get(id);
      if (tx) {
        saveVoucherToBackend('voucher_transactions', tx as any).then((r: { success?: boolean; error?: string }) => {
          if (!r || !r.success) {
            console.warn(`[VoucherDatabase] 交易 ${id} 同步到服务端失败:`, r?.error || '未知错误');
          } else {
            this.markSynced(id);
          }
        }).catch((err: any) => {
          console.warn(`[VoucherDatabase] 交易 ${id} 同步请求异常:`, err?.message || err);
        });
      }
    }
    this.scheduleCloudSyncFallback();
  }

  /**
   * 防抖全量同步兜底 — 2s 内无新变更时触发一次全量同步
   * 确保即使增量标记遗漏，数据最终也会一致
   */
  private scheduleCloudSyncFallback(): void {
    if (this.cloudSyncTimer) clearTimeout(this.cloudSyncTimer);
    this.cloudSyncTimer = setTimeout(() => {
      // 全量兜底：仅在没有脏标记且存在未推送过的数据时才同步（已推送的不再重复轰炸）
      // 线上环境过滤 seed 测试凭证（防污染真实数据）
      const prodGuard = isCloudHosting();
      if (this.cloudSyncDirtyVouchers.size === 0 && this.voucherCache.size > 0) {
        const vouchers = Array.from(this.voucherCache.values())
          .filter(v => !this.cloudSyncedIds.has(v.id) && !(prodGuard && this.isSeedVoucher(v)))
          .slice(0, 200);
        for (const v of vouchers) {
          saveVoucherToBackend('vouchers', v as any).then((r: { success?: boolean; error?: string }) => {
            if (!r || !r.success) {
              console.warn(`[VoucherDatabase] 兜底同步凭证 ${v.id} 失败:`, r?.error || '未知错误');
            } else {
              this.markSynced(v.id);
            }
          }).catch((err: any) => {
            console.warn(`[VoucherDatabase] 兜底同步凭证 ${v.id} 请求异常:`, err?.message || err);
          });
        }
      }
      if (this.cloudSyncDirtyTransactions.size === 0 && this.transactionCache.size > 0) {
        const txs = Array.from(this.transactionCache.values()).filter(t => !this.cloudSyncedIds.has(t.id)).slice(0, 100);
        for (const tx of txs) {
          saveVoucherToBackend('voucher_transactions', tx as any).then((r: { success?: boolean; error?: string }) => {
            if (!r || !r.success) {
              console.warn(`[VoucherDatabase] 兜底同步交易 ${tx.id} 失败:`, r?.error || '未知错误');
            } else {
              this.markSynced(tx.id);
            }
          }).catch((err: any) => {
            console.warn(`[VoucherDatabase] 兜底同步交易 ${tx.id} 请求异常:`, err?.message || err);
          });
        }
      }
      this.cloudSyncTimer = null;
    }, this.CLOUD_SYNC_DELAY);
  }

  async syncFromCloudBase(): Promise<void> {
    if (typeof window === 'undefined') return;
    try {
      // Bug 013 修复：读取改分页 + 后端 API 兜底，绝不保留 limit(500) 硬截断
      const cloudVouchers = await loadCollectionFromBackend<any>('vouchers');
      for (const doc of cloudVouchers) {
        // 后端为准：云端的凭证（已铸造）覆盖本地版本，避免另一浏览器显示"未铸造/已售罄"
        this.voucherCache.set(doc.id, doc);
      }
      const cloudTx = await loadCollectionFromBackend<any>('voucher_transactions');
      for (const doc of cloudTx) {
        if (!this.transactionCache.has(doc.id)) {
          this.transactionCache.set(doc.id, doc);
        }
      }
      if (cloudVouchers.length > 0 || cloudTx.length > 0) {
        this.persistVouchers();
        this.persistTransactions();
      }
    } catch { /* ignore */ }
  }

  private async initCloudBaseSync(): Promise<void> {
    await this.syncFromCloudBase();
  }
}

// 导出单例
export const voucherDB = VoucherDatabase.getInstance();
