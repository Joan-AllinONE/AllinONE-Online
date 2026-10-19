/**
 * 内存数据库替代方案
 * 用于 CloudStudio 等无 PostgreSQL 环境
 *
 * v2（2026-08-15）：新增磁盘持久化（MEMORY_DB_FILE 或默认 .data/memory-db.json）。
 * dev 本地重启后游戏文件/元数据/任务数据自动恢复，解决「上传当时能玩、重启后 File not found」。
 * 注意：CloudStudio / 无持久化磁盘环境仍为纯内存，跨重启需接云存储/云函数。
 */

import fs from 'fs';
import path from 'path';
import { ActivityDef, ClaimEvent, LeaderboardEntry } from '../activity/types';
import { defaultActivities } from '../activity/seed/defaultActivities.js';

interface InventoryItem {
  id: number;
  item_id: string;
  user_id: string;
  name: string;
  description: string;
  game_source: string;
  game_name: string;
  category: string;
  rarity: string;
  stats?: any;
  quantity: number;
  obtained_from: string;
  sync_status: string;
  obtained_at: Date;
  created_at: Date;
  updated_at: Date;
}

interface GameFileRecord {
  id: number;
  game_id: string;
  file_path: string;
  content: string;       // 文本文件内容
  binary?: Buffer;       // 二进制文件（base64 解码后）
  mime_type: string;
  size: number;
  etag: string;
  created_at: Date;
  updated_at: Date;
}

interface SyncLog {
  id: number;
  user_id: string;
  game_source: string;
  sync_type: string;
  items_synced: number;
  items_added: number;
  items_updated: number;
  items_removed: number;
  sync_status: string;
  error_message?: string;
  started_at: Date;
  completed_at?: Date;
  duration_ms: number;
}

// ==================== 开发者账户 ====================

export interface DeveloperAccount {
  accountId: string;
  gameId: string;
  gameName: string;
  publisherId: string;
  publisherName: string;
  revenueSharePercent: number;
  totalRevenue: number;
  totalWithdrawn: number;
  availableBalance: number;
  platformOwed: number;
  platformSettled: number;
  lastDailySettlement: number;
  /** 三方分成配置（GameProposal 通过后写入；未设置走 legacy 单极） */
  revenueSharing?: {
    gameShare: number;
    platformShare: number;
    creatorShare: number;
    creatorId?: string;
    creatorName?: string;
    source?: string;
    effectiveAt?: number;
  };
  /** 创作者待结算分成 */
  creatorOwed?: number;
  /** 创作者已结算分成累计 */
  creatorSettled?: number;
  /** 游戏币（gameCoins）收入累计——封闭货币，不参与 A币三方分成结算 */
  gameCoinsRevenue?: number;
  stats: {
    totalSoldItems: number;
    totalSoldVouchers: number;
    itemSales: Record<string, { templateId: string; name: string; count: number; totalRevenue: number }>;
  };
  status: string;
  createdAt: number;
  updatedAt: number;
}

export interface DeveloperTransaction {
  id: string;
  gameId: string;
  accountId: string;
  type: string;
  amount: number;
  currency: string;
  description: string;
  fromUserId?: string;
  fromUserName?: string;
  metadata?: Record<string, any>;
  timestamp: number;
}

class MemoryDatabase {
  private inventory: InventoryItem[] = [];
  private syncLogs: SyncLog[] = [];
  private gameFiles: GameFileRecord[] = [];
  private developerAccounts: Map<string, DeveloperAccount> = new Map();
  private developerTransactions: DeveloperTransaction[] = [];
  private activities: ActivityDef[] = [...defaultActivities];
  private claims: ClaimEvent[] = [];
  private publishedGames: Map<string, any> = new Map();
  private quests: Map<string, any> = new Map();
  private questClaims: Map<string, any> = new Map();
  private questSubmissions: Map<string, any> = new Map();
  private questMods: Map<string, any> = new Map();
  private gameWallets: Map<string, any> = new Map();
  /** 内容工坊资产库（content_assets） */
  private contentAssets: Map<string, any> = new Map();
  /** 平台钱包用户文档（users：gameCoins 等），任务报酬写平台钱包用 */
  private users: Map<string, any> = new Map();
  /** A币凭证（vouchers），任务报酬发放 A币用 */
  private vouchers: Map<string, any> = new Map();
  /** 合约实例（contract_instances）：B1 智能合约模块 */
  private contractInstances: Map<string, any> = new Map();
  /** 合约托管台账（contract_escrows）：B2 服务端资金权威 */
  private contractEscrows: Map<string, any> = new Map();
  /** 收益台账（revenue_ledger）：GSO 分账唯一合法数据源 */
  private revenueLedger: Map<string, any> = new Map();
  /** 平台规则注册表（contract_rules）：散落硬编码信任规则的收敛收敛点 */
  private contractRules: Map<string, any> = new Map();
  /** 三方分成配置变更历史（append-only 哈希链存证） */
  private revenueSharingHistory: any[] = [];
  /** 站内信通知（notifications）：私域合约邀请等，服务端为唯一可信写入点 */
  private notifications: Map<string, any> = new Map();
  /** UGC 合约模板注册中心（contract_templates_ugc）：合约工坊 CW-1 */
  private contractTemplatesUgc: Map<string, any> = new Map();
  /** 限时活动（limited_events）：时间窗口 + 功能开关 + 状态机（E1-E4） */
  private limitedEvents: Map<string, any> = new Map();
  /** 限时活动参与记录（event_participations）：主键 eventId:userId */
  private eventParticipations: Map<string, any> = new Map();
  /** 限时活动奖励发放（event_grants）：幂等键 grant_<eventId>_<userId>_<rewardId> */
  private eventGrants: Map<string, any> = new Map();
  /** 分阶段活动全服进度（event_stage_progress）：stageId → current */
  private eventStageProgress: Map<string, any> = new Map();
  /** 已归档限时活动（settled + 90 天保留期后移入） */
  private archivedEvents: any[] = [];
  private idCounters = {
    inventory: 1,
    syncLog: 1,
    gameFile: 1,
  };

  // ========== 磁盘持久化（v2） ==========
  private persistenceFile: string = '';
  private persistTimer: NodeJS.Timeout | null = null;
  private loadingFromDisk = false;

  constructor(persistenceFile?: string) {
    const env = process.env.MEMORY_DB_FILE;
    // 显式 none/false/空 禁用；默认项目根 .data/memory-db.json
    if (env === 'none' || env === 'false' || env === '') {
      this.persistenceFile = '';
    } else {
      this.persistenceFile = persistenceFile || env || path.join(process.cwd(), '.data', 'memory-db.json');
    }
    if (this.persistenceFile) {
      this.loadFromDisk();
      console.log(`[内存DB] 磁盘持久化已启用: ${this.persistenceFile}`);
    }
  }

  /** 写操作后防抖落盘（500ms 合并高频写） */
  private schedulePersist(): void {
    if (this.loadingFromDisk || !this.persistenceFile) return;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistToDisk();
    }, 500);
  }

  private persistToDisk(): void {
    try {
      const dir = path.dirname(this.persistenceFile);
      fs.mkdirSync(dir, { recursive: true });
      const snapshot = {
        idCounters: this.idCounters,
        gameFiles: this.gameFiles.map((f) => ({
          ...f,
          created_at: f.created_at instanceof Date ? f.created_at.toISOString() : f.created_at,
          updated_at: f.updated_at instanceof Date ? f.updated_at.toISOString() : f.updated_at,
        })),
        publishedGames: Array.from(this.publishedGames.values()),
        quests: Array.from(this.quests.values()),
        questClaims: Array.from(this.questClaims.values()),
        questSubmissions: Array.from(this.questSubmissions.values()),
        questMods: Array.from(this.questMods.values()),
        gameWallets: Array.from(this.gameWallets.values()),
        developerAccounts: Array.from(this.developerAccounts.values()),
        developerTransactions: this.developerTransactions,
        inventory: this.inventory.map((i) => ({
          ...i,
          obtained_at: i.obtained_at instanceof Date ? i.obtained_at.toISOString() : i.obtained_at,
          created_at: i.created_at instanceof Date ? i.created_at.toISOString() : i.created_at,
          updated_at: i.updated_at instanceof Date ? i.updated_at.toISOString() : i.updated_at,
        })),
        syncLogs: this.syncLogs,
        activities: this.activities,
        claims: this.claims,
        users: Array.from(this.users.values()),
        vouchers: Array.from(this.vouchers.values()),
        contractInstances: Array.from(this.contractInstances.values()),
        contractEscrows: Array.from(this.contractEscrows.values()),
        revenueLedger: Array.from(this.revenueLedger.values()),
        contractRules: Array.from(this.contractRules.values()),
        revenueSharingHistory: this.revenueSharingHistory,
        notifications: Array.from(this.notifications.values()),
        contractTemplatesUgc: Array.from(this.contractTemplatesUgc.values()),
        limitedEvents: Array.from(this.limitedEvents.values()),
        eventParticipations: Array.from(this.eventParticipations.values()),
        eventGrants: Array.from(this.eventGrants.values()),
        eventStageProgress: Array.from(this.eventStageProgress.values()),
        archivedEvents: this.archivedEvents,
      };
      fs.writeFileSync(this.persistenceFile, JSON.stringify(snapshot));
    } catch (e) {
      console.warn('[内存DB] 持久化写入失败:', e instanceof Error ? e.message : String(e));
    }
  }

  private loadFromDisk(): void {
    try {
      if (!fs.existsSync(this.persistenceFile)) return;
      this.loadingFromDisk = true;
      const raw = fs.readFileSync(this.persistenceFile, 'utf8');
      const data = JSON.parse(raw);
      if (data) {
        if (data.idCounters) this.idCounters = { ...this.idCounters, ...data.idCounters };
        if (Array.isArray(data.gameFiles)) {
          this.gameFiles = data.gameFiles.map((f: any) => ({
            ...f,
            created_at: f.created_at ? new Date(f.created_at) : new Date(),
            updated_at: f.updated_at ? new Date(f.updated_at) : new Date(),
          }));
        }
        if (Array.isArray(data.publishedGames)) {
          this.publishedGames = new Map(data.publishedGames.map((g: any) => [g.id || g._id, g]));
        }
        if (Array.isArray(data.quests)) this.quests = new Map(data.quests.map((q: any) => [q.id || q._id, q]));
        if (Array.isArray(data.questClaims)) this.questClaims = new Map(data.questClaims.map((c: any) => [c.id || c._id, c]));
        if (Array.isArray(data.questSubmissions)) this.questSubmissions = new Map(data.questSubmissions.map((s: any) => [s.id || s._id, s]));
        if (Array.isArray(data.questMods)) this.questMods = new Map(data.questMods.map((m: any) => [m.id || m._id, m]));
        if (Array.isArray(data.gameWallets)) this.gameWallets = new Map(data.gameWallets.map((w: any) => [w.id || w._id, w]));
        if (Array.isArray(data.contentAssets)) this.contentAssets = new Map(data.contentAssets.map((c: any) => [c.contentId || c._id, c]));
        if (Array.isArray(data.developerAccounts)) {
          this.developerAccounts = new Map(data.developerAccounts.map((a: any) => [a.accountId, a]));
        }
        if (Array.isArray(data.developerTransactions)) this.developerTransactions = data.developerTransactions;
        if (Array.isArray(data.inventory)) {
          this.inventory = data.inventory.map((i: any) => ({
            ...i,
            obtained_at: i.obtained_at ? new Date(i.obtained_at) : new Date(),
            created_at: i.created_at ? new Date(i.created_at) : new Date(),
            updated_at: i.updated_at ? new Date(i.updated_at) : new Date(),
          }));
        }
        if (Array.isArray(data.syncLogs)) this.syncLogs = data.syncLogs;
        if (Array.isArray(data.activities)) this.activities = data.activities;
        if (Array.isArray(data.claims)) this.claims = data.claims;
        if (Array.isArray(data.users)) this.users = new Map(data.users.map((u: any) => [u._openid || u.userId || u._id, u]));
        if (Array.isArray(data.vouchers)) this.vouchers = new Map(data.vouchers.map((v: any) => [v.id || v._id, v]));
        if (Array.isArray(data.contractInstances)) this.contractInstances = new Map(data.contractInstances.map((c: any) => [c.id || c._id, c]));
        if (Array.isArray(data.contractEscrows)) this.contractEscrows = new Map(data.contractEscrows.map((e: any) => [e.entryId || e._id, e]));
        if (Array.isArray(data.revenueLedger)) this.revenueLedger = new Map(data.revenueLedger.map((r: any) => [r.entryId || r._id, r]));
        if (Array.isArray(data.contractRules)) this.contractRules = new Map(data.contractRules.map((r: any) => [r.ruleKey || r._id, r]));
        if (Array.isArray(data.revenueSharingHistory)) this.revenueSharingHistory = data.revenueSharingHistory;
        if (Array.isArray(data.notifications)) this.notifications = new Map(data.notifications.map((n: any) => [n.id || n._id, n]));
        if (Array.isArray(data.contractTemplatesUgc)) this.contractTemplatesUgc = new Map(data.contractTemplatesUgc.map((t: any) => [t.key || t._id, t]));
        if (Array.isArray(data.limitedEvents)) this.limitedEvents = new Map(data.limitedEvents.map((e: any) => [e.id || e._id, e]));
        if (Array.isArray(data.eventParticipations)) this.eventParticipations = new Map(data.eventParticipations.map((p: any) => [p.id || p._id, p]));
        if (Array.isArray(data.eventGrants)) this.eventGrants = new Map(data.eventGrants.map((g: any) => [g.id || g._id, g]));
        if (Array.isArray(data.eventStageProgress)) this.eventStageProgress = new Map(data.eventStageProgress.map((s: any) => [s.stageId || s._id, s]));
        if (Array.isArray(data.archivedEvents)) this.archivedEvents = data.archivedEvents;
      }
      console.log(
        `[内存DB] 从磁盘恢复: 游戏文件 ${this.gameFiles.length}, 游戏 ${this.publishedGames.size}, 任务 ${this.quests.size}, 提交 ${this.questSubmissions.size}`,
      );
    } catch (e) {
      console.warn('[内存DB] 持久化读取失败:', e instanceof Error ? e.message : String(e));
    } finally {
      this.loadingFromDisk = false;
    }
  }

  /** 立即落盘（供关闭前调用） */
  flush(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.persistToDisk();
  }

  // ========== 库存操作 ==========
  
  async queryInventory(userId: string, options?: {
    gameSource?: string;
    category?: string;
    rarity?: string;
    page?: number;
    limit?: number;
  }): Promise<{ items: InventoryItem[]; total: number }> {
    let result = this.inventory.filter(item => item.user_id === userId);
    
    if (options?.gameSource) {
      result = result.filter(item => item.game_source === options.gameSource);
    }
    if (options?.category) {
      result = result.filter(item => item.category === options.category);
    }
    if (options?.rarity) {
      result = result.filter(item => item.rarity === options.rarity);
    }
    
    const total = result.length;
    const page = options?.page || 1;
    const limit = options?.limit || 50;
    const start = (page - 1) * limit;
    const end = start + limit;
    
    return {
      items: result.slice(start, end),
      total
    };
  }

  async findInventoryItem(userId: string, itemId: string, gameSource: string): Promise<InventoryItem | null> {
    return this.inventory.find(
      item => item.user_id === userId && item.item_id === itemId && item.game_source === gameSource
    ) || null;
  }

  async addInventoryItem(item: Omit<InventoryItem, 'id' | 'created_at' | 'updated_at'>): Promise<InventoryItem> {
    const newItem: InventoryItem = {
      ...item,
      id: this.idCounters.inventory++,
      created_at: new Date(),
      updated_at: new Date()
    };
    this.inventory.push(newItem);
    console.log('[内存DB] 添加道具:', newItem.name, '用户:', item.user_id);
    this.schedulePersist();
    return newItem;
  }

  async updateInventoryQuantity(id: number, quantity: number): Promise<void> {
    const item = this.inventory.find(i => i.id === id);
    if (item) {
      item.quantity = quantity;
      item.updated_at = new Date();
      this.schedulePersist();
    }
  }

  async updateSyncStatus(itemId: string, userId: string, status: string): Promise<void> {
    const item = this.inventory.find(
      i => i.item_id === itemId && i.user_id === userId
    );
    if (item) {
      item.sync_status = status;
      item.updated_at = new Date();
      console.log('[内存DB] 更新同步状态:', itemId, '->', status);
      this.schedulePersist();
    }
  }

  // ========== 统计操作 ==========
  
  async getInventorySummary(userId: string): Promise<any[]> {
    const userItems = this.inventory.filter(item => item.user_id === userId);
    const summary: Record<string, any> = {};
    
    userItems.forEach(item => {
      if (!summary[item.game_source]) {
        summary[item.game_source] = {
          user_id: userId,
          game_source: item.game_source,
          total_items: 0,
          total_quantity: 0,
          legendary_count: 0,
          epic_count: 0,
          rare_count: 0
        };
      }
      
      const s = summary[item.game_source];
      s.total_items++;
      s.total_quantity += item.quantity;
      
      if (item.rarity === 'legendary') s.legendary_count++;
      else if (item.rarity === 'epic') s.epic_count++;
      else if (item.rarity === 'rare') s.rare_count++;
    });
    
    return Object.values(summary);
  }

  // ========== 同步日志 ==========
  
  async addSyncLog(log: Omit<SyncLog, 'id'>): Promise<void> {
    this.syncLogs.push({
      ...log,
      id: this.idCounters.syncLog++
    });
    this.schedulePersist();
  }

  // ========== 游戏文件存储 ==========

  /**
   * 批量保存游戏文件（upsert：同一 game_id + file_path 覆盖）
   */
  async saveGameFiles(gameId: string, files: Array<{
    filePath: string;
    content: string;
    mimeType: string;
    size: number;
  }>): Promise<{ saved: number }> {
    for (const file of files) {
      const existingIdx = this.gameFiles.findIndex(
        f => f.game_id === gameId && f.file_path === file.filePath
      );
      const now = new Date();
      // 简单 etag：size + timestamp
      const etag = `"${file.size}-${now.getTime().toString(36)}"`;
      const record: GameFileRecord = {
        id: existingIdx >= 0 ? this.gameFiles[existingIdx].id : this.idCounters.gameFile++,
        game_id: gameId,
        file_path: file.filePath,
        content: file.content,
        mime_type: file.mimeType,
        size: file.size,
        etag,
        created_at: existingIdx >= 0 ? this.gameFiles[existingIdx].created_at : now,
        updated_at: now,
      };
      if (existingIdx >= 0) {
        this.gameFiles[existingIdx] = record;
      } else {
        this.gameFiles.push(record);
      }
    }
    console.log(`[内存DB] 游戏文件已保存: ${gameId}, ${files.length} 个文件`);
    this.schedulePersist();
    return { saved: files.length };
  }

  /**
   * 获取单个游戏文件
   */
  async getGameFile(gameId: string, filePath: string): Promise<GameFileRecord | null> {
    return this.gameFiles.find(
      f => f.game_id === gameId && f.file_path === filePath
    ) || null;
  }

  /**
   * 获取游戏的所有文件清单
   */
  async getGameFileManifest(gameId: string): Promise<Array<{
    filePath: string;
    mimeType: string;
    size: number;
    etag: string;
  }>> {
    return this.gameFiles
      .filter(f => f.game_id === gameId)
      .map(f => ({
        filePath: f.file_path,
        mimeType: f.mime_type,
        size: f.size,
        etag: f.etag,
      }));
  }

  /**
   * 删除游戏的所有文件
   */
  async deleteGameFiles(gameId: string): Promise<{ deleted: number }> {
    const before = this.gameFiles.length;
    this.gameFiles = this.gameFiles.filter(f => f.game_id !== gameId);
    const deleted = before - this.gameFiles.length;
    console.log(`[内存DB] 游戏文件已删除: ${gameId}, ${deleted} 个文件`);
    this.schedulePersist();
    return { deleted };
  }

  // ========== 开发者账户操作 ==========

  async getDeveloperAccount(accountId: string): Promise<DeveloperAccount | null> {
    return this.developerAccounts.get(accountId) || null;
  }

  /** users 集合只读列表（钱包跨端同步 / 分账余额可见性；剔除 _walletHistory 内部字段） */
  async listUsers(): Promise<any[]> {
    return Array.from(this.users.values()).map((u: any) => {
      if (!u || typeof u !== 'object') return u;
      const { _walletHistory, ...rest } = u;
      return rest;
    });
  }

  /**
   * 钱包流水只读列表（跨端同步；从 users._walletHistory 摊平并补 userId/id 字段）。
   * 消费方：GET /api/v1/games/transactions（金库报表三方分成收益聚合、WalletSkill 服务端流水）。
   * 注意：_walletHistory 仅保留最近 100 条/用户，本列表非全量审计账本。
   */
  async listTransactions(): Promise<any[]> {
    const out: any[] = [];
    for (const [uid, u] of this.users.entries()) {
      const hist = Array.isArray((u as any)?._walletHistory) ? (u as any)._walletHistory : [];
      for (const h of hist) {
        out.push({
          id: h.txId || `wtx_${uid}_${h.timestamp}`,
          userId: uid,
          txId: h.txId,
          type: h.type,
          amount: h.amount,
          description: h.description,
          balanceAfter: h.balanceAfter,
          timestamp: h.timestamp,
        });
      }
    }
    out.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    return out;
  }

  async getAllDeveloperAccounts(): Promise<DeveloperAccount[]> {
    return Array.from(this.developerAccounts.values());
  }

  async upsertDeveloperAccount(account: DeveloperAccount): Promise<void> {
    this.developerAccounts.set(account.accountId, account);
    console.log('[\u5185\u5b58DB] \u5f00\u53d1\u8005\u8d26\u6237\u5df2\u4fdd\u5b58:', account.accountId);
    this.schedulePersist();
  }

  async addDeveloperTransaction(tx: DeveloperTransaction): Promise<void> {
    this.developerTransactions.push(tx);
    // 保留最近 1000 条
    if (this.developerTransactions.length > 1000) {
      this.developerTransactions = this.developerTransactions.slice(-1000);
    }
    this.schedulePersist();
  }

  async getDeveloperTransactions(accountId?: string, limit?: number): Promise<DeveloperTransaction[]> {
    let result = accountId
      ? this.developerTransactions.filter(t => t.accountId === accountId)
      : [...this.developerTransactions];
    result.sort((a, b) => b.timestamp - a.timestamp);
    if (limit) result = result.slice(0, limit);
    return result;
  }

  // ========== 活动中心 ==========

  async getActivities(): Promise<ActivityDef[]> {
    return this.activities.filter((a) => a.status !== 'draft');
  }

  async getActivity(id: string): Promise<ActivityDef | undefined> {
    return this.activities.find((a) => a.id === id);
  }

  async upsertActivity(a: ActivityDef): Promise<void> {
    const i = this.activities.findIndex((x) => x.id === a.id);
    if (i >= 0) this.activities[i] = a;
    else this.activities.push(a);
    this.schedulePersist();
  }

  async deleteActivity(id: string): Promise<void> {
    this.activities = this.activities.filter((a) => a.id !== id);
    this.schedulePersist();
  }

  async addClaim(e: ClaimEvent): Promise<void> {
    this.claims.push(e);
    if (this.claims.length > 2000) this.claims = this.claims.slice(-2000);
    this.schedulePersist();
  }

  // ========== 限时活动（E1-E4：时间窗口 + 功能开关 + 状态机） ==========

  async getLimitedEvents(): Promise<any[]> {
    return Array.from(this.limitedEvents.values());
  }

  async getLimitedEvent(id: string): Promise<any | undefined> {
    return this.limitedEvents.get(String(id || ''));
  }

  async countLimitedEventsBySlug(slug: string): Promise<number> {
    let n = 0;
    for (const e of this.limitedEvents.values()) if (e.slug === slug) n++;
    return n + this.archivedEvents.filter((e: any) => e.slug === slug).length;
  }

  async upsertLimitedEvent(e: any): Promise<void> {
    this.limitedEvents.set(String(e.id), e);
    this.schedulePersist();
  }

  async deleteLimitedEvent(id: string): Promise<void> {
    this.limitedEvents.delete(String(id));
    this.schedulePersist();
  }

  async getEventParticipation(eventId: string, userId: string): Promise<any | undefined> {
    return this.eventParticipations.get(`${eventId}:${userId}`);
  }

  async upsertEventParticipation(p: any): Promise<void> {
    this.eventParticipations.set(String(p.id), p);
    this.schedulePersist();
  }

  async listEventParticipations(eventId: string): Promise<any[]> {
    return Array.from(this.eventParticipations.values()).filter((p) => p.eventId === eventId);
  }

  /** 幂等插入发放记录：id 已存在返回 null（调用方据此判定「已发放」） */
  async addEventGrant(g: any): Promise<any | null> {
    if (this.eventGrants.has(String(g.id))) return null;
    this.eventGrants.set(String(g.id), g);
    this.schedulePersist();
    return g;
  }

  async getEventGrant(id: string): Promise<any | undefined> {
    return this.eventGrants.get(String(id));
  }

  async listEventGrantsByUser(eventId: string, userId: string): Promise<any[]> {
    return Array.from(this.eventGrants.values()).filter((g) => g.eventId === eventId && g.userId === userId);
  }

  async listEventGrantsByEvent(eventId: string): Promise<any[]> {
    return Array.from(this.eventGrants.values()).filter((g) => g.eventId === eventId);
  }

  async getEventStageProgress(stageId: string): Promise<any | undefined> {
    return this.eventStageProgress.get(String(stageId));
  }

  async upsertEventStageProgress(p: any): Promise<void> {
    this.eventStageProgress.set(String(p.stageId), p);
    this.schedulePersist();
  }

  async listEventStageProgressByEvent(eventId: string): Promise<any[]> {
    return Array.from(this.eventStageProgress.values()).filter((s) => s.eventId === eventId);
  }

  async pushArchivedEvent(e: any): Promise<void> {
    this.archivedEvents.push(e);
    this.limitedEvents.delete(String(e.id));
    this.schedulePersist();
  }

  async getArchivedEvents(): Promise<any[]> {
    return this.archivedEvents;
  }

  async getLeaderboard(limit = 20): Promise<LeaderboardEntry[]> {
    const map = new Map<string, LeaderboardEntry>();
    for (const c of this.claims) {
      const e = map.get(c.userId) || {
        userId: c.userId,
        userName: c.userName || '玩家',
        totalCoins: 0,
      };
      e.totalCoins += c.amount || 0;
      map.set(c.userId, e);
    }
    return Array.from(map.values())
      .sort((a, b) => b.totalCoins - a.totalCoins)
      .slice(0, limit);
  }

  // ========== 调试 ==========
  
  getStats(): { inventoryCount: number; syncLogCount: number; gameFileCount: number; developerAccountCount: number; developerTxCount: number } {
    return {
      inventoryCount: this.inventory.length,
      syncLogCount: this.syncLogs.length,
      gameFileCount: this.gameFiles.length,
      developerAccountCount: this.developerAccounts.size,
      developerTxCount: this.developerTransactions.length,
    };
  }

  // ========== 任务系统（GameQuest） ==========

  async listQuests(gameId?: string, status?: string): Promise<any[]> {
    let result = Array.from(this.quests.values());
    if (gameId) result = result.filter((q) => q.gameId === gameId);
    if (status) result = result.filter((q) => q.status === status);
    return result
      .map((q) => ({ ...q, id: q.id || q._id }))
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }

  async getQuest(id: string): Promise<any | null> {
    const q = this.quests.get(id);
    return q ? { ...q, id } : null;
  }

  async upsertQuest(id: string, quest: any): Promise<void> {
    this.quests.set(id, { ...quest, id });
    this.schedulePersist();
  }

  async getQuestClaim(id: string): Promise<any | null> {
    return this.questClaims.get(id) || null;
  }

  async upsertQuestClaim(id: string, claim: any): Promise<void> {
    this.questClaims.set(id, { ...claim, id });
    this.schedulePersist();
  }

  async countActiveQuestClaims(taskId: string): Promise<number> {
    let count = 0;
    for (const c of this.questClaims.values()) {
      if (c.taskId === taskId && c.status === 'active') count++;
    }
    return count;
  }

  async getQuestSubmission(id: string): Promise<any | null> {
    return this.questSubmissions.get(id) || null;
  }

  async upsertQuestSubmission(id: string, sub: any): Promise<void> {
    this.questSubmissions.set(id, { ...sub, id });
    this.schedulePersist();
  }

  async listQuestSubmissions(taskId: string): Promise<any[]> {
    return Array.from(this.questSubmissions.values())
      .filter((s) => s.taskId === taskId)
      .map((s) => ({ ...s, id: s.id || s._id }))
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }

  async upsertQuestMod(id: string, mod: any): Promise<void> {
    this.questMods.set(id, { ...mod, id });
    this.schedulePersist();
  }

  async listQuestMods(gameId?: string): Promise<any[]> {
    let result = Array.from(this.questMods.values());
    if (gameId) result = result.filter((m) => m.gameId === gameId);
    return result
      .map((m) => ({ ...m, id: m.id || m._id }))
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }

  async deleteQuest(id: string): Promise<void> {
    this.quests.delete(id);
    this.schedulePersist();
  }

  async deleteQuestClaimsByTask(taskId: string): Promise<void> {
    for (const [k, c] of this.questClaims.entries()) {
      if (c.taskId === taskId) this.questClaims.delete(k);
    }
    this.schedulePersist();
  }

  async deleteQuestSubmissionsByTask(taskId: string): Promise<void> {
    for (const [k, s] of this.questSubmissions.entries()) {
      if (s.taskId === taskId) this.questSubmissions.delete(k);
    }
    this.schedulePersist();
  }

  // ========== 游戏内钱包（game_wallets，与云函数对齐） ==========

  async upsertGameWallet(id: string, wallet: any): Promise<void> {
    this.gameWallets.set(id, { ...wallet, _id: id, id });
    this.schedulePersist();
  }

  async getGameWallet(id: string): Promise<any | null> {
    return this.gameWallets.get(id) || null;
  }

  /** 列出某用户在全部游戏的 game_wallets（供 __wallet/my-rewards 汇总） */
  async listGameWalletsByUser(userId: string): Promise<any[]> {
    const out: any[] = [];
    for (const w of this.gameWallets.values()) {
      if (w && (w.userId === userId || String(w._id || w.id || '').endsWith(`::${userId}`))) {
        out.push({ ...w });
      }
    }
    return out;
  }

  // ========== 已发布游戏（元数据） ==========

  async savePublishedGame(game: any): Promise<void> {
    if (!game || !game.id) return;
    this.publishedGames.set(game.id, { ...game, id: game.id });
    this.schedulePersist();
  }

  async getPublishedGame(gameId: string): Promise<any | null> {
    const g = this.publishedGames.get(gameId);
    return g ? { ...g } : null;
  }

  async listPublishedGames(): Promise<any[]> {
    return Array.from(this.publishedGames.values()).sort(
      (a, b) => (b.createdAt || 0) - (a.createdAt || 0)
    );
  }

  async deletePublishedGame(gameId: string): Promise<void> {
    this.publishedGames.delete(gameId);
    this.schedulePersist();
  }

  // ========== 内容工坊资产库（content_assets） ==========

  async listContentAssets(gameId?: string): Promise<any[]> {
    let result = Array.from(this.contentAssets.values());
    if (gameId) result = result.filter((c) => c.gameId === gameId);
    return result
      .map((c) => ({ ...c, contentId: c.contentId || c._id }))
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }

  async getContentAsset(contentId: string): Promise<any | null> {
    const c = this.contentAssets.get(contentId);
    return c ? { ...c } : null;
  }

  async upsertContentAsset(contentId: string, record: any): Promise<void> {
    this.contentAssets.set(contentId, { ...record, contentId });
    this.schedulePersist();
  }

  async deleteContentAsset(contentId: string): Promise<void> {
    this.contentAssets.delete(contentId);
    this.schedulePersist();
  }

  // ========== 平台钱包（users：游戏币） ==========

  async getUser(userId: string): Promise<any | null> {
    const u = this.users.get(userId);
    if (process.env.MEMORY_DB_TRACE === '1' && userId === 'u_init') {
      console.log(`[memdb-trace] getUser(${userId}) gameCoins=${u?.gameCoins} pid=${process.pid}`);
    }
    return u ? { ...u } : null;
  }

  /** 给用户加平台游戏币（users.gameCoins）。用户不存在则初始化文档（对齐 WalletSkill 的默认文档）。 */
  async addGameCoins(userId: string, amount: number, reason: string): Promise<number> {
    if (!userId || amount <= 0) return 0;
    const now = Date.now();
    const existing = this.users.get(userId) || {
      _openid: userId,
      gameCoins: 0,
      instantVouchers: 0,
      algorithmVouchers: 0,
      createdAt: now,
      updatedAt: now,
    };
    const before = Number(existing.gameCoins) || 0;
    existing.gameCoins = before + amount;
    existing.updatedAt = now;
    existing._walletHistory = existing._walletHistory || [];
    existing._walletHistory.unshift({
      type: 'quest_reward',
      amount,
      balance: existing.gameCoins,
      reason,
      timestamp: now,
    });
    existing._walletHistory = existing._walletHistory.slice(0, 100);
    this.users.set(userId, existing);
    this.schedulePersist();
    return existing.gameCoins;
  }

  /**
   * 平台余额调整（正负均可，对齐云函数 __wallet/platform/adjust）。
   * delta 正=充值，负=消费；txId 幂等防重；记录到 users[userId]._walletHistory。
   * allowNegative：平台金库账户（system-platform）支出时可透支为负（资金守恒由收益台账审计）。
   */
  async adjustPlatformBalance(userId: string, delta: number, reason: string, txId: string, allowNegative = false): Promise<{ balance: any; transaction: any } | null> {
    if (!userId || !txId) return null;
    const now = Date.now();
    const existing = this.users.get(userId) || {
      _openid: userId,
      gameCoins: 0,
      instantVouchers: 0,
      algorithmVouchers: 0,
      createdAt: now,
      updatedAt: now,
    };
    existing._walletHistory = existing._walletHistory || [];
    // 幂等：txId 已存在直接返回上次结果
    const dup = existing._walletHistory.find((h: any) => h.txId === txId);
    if (dup) {
      return {
        balance: { gameCoins: existing.gameCoins, instantVouchers: existing.instantVouchers || 0, algorithmVouchers: existing.algorithmVouchers || 0, lastUpdated: existing.updatedAt },
        transaction: dup,
      };
    }
    const before = Number(existing.gameCoins) || 0;
    const after = before + delta;
    if (after < 0 && !allowNegative) return null; // 余额不足
    existing.gameCoins = after;
    existing.updatedAt = now;
    const tx = {
      txId,
      type: delta > 0 ? 'income' : 'expense',
      amount: Math.abs(delta),
      description: reason,
      balanceAfter: after,
      timestamp: now,
    };
    existing._walletHistory.unshift(tx);
    existing._walletHistory = existing._walletHistory.slice(0, 100);
    this.users.set(userId, existing);
    this.schedulePersist();
    return {
      balance: { gameCoins: existing.gameCoins, instantVouchers: existing.instantVouchers || 0, algorithmVouchers: existing.algorithmVouchers || 0, lastUpdated: existing.updatedAt },
      transaction: tx,
    };
  }

  // ========== 智能合约（contract_instances / contract_escrows / revenue_ledger） ==========

  async getContractInstance(id: string): Promise<any | null> {
    // B-18 修复：返回深拷贝——此前返回 Map 内部引用，调用方（applyPlan）直接修改
    // 会污染存储对象并使 CAS 的 expectedVersion 失效（全部误报并发冲突）
    const doc = this.contractInstances.get(id);
    return doc ? structuredClone(doc) : null;
  }

  async putContractInstance(doc: any): Promise<void> {
    this.contractInstances.set(doc.id, { ...doc, _id: doc.id });
    this.schedulePersist();
  }

  /**
   * 乐观锁写入：Map 中 version 与 expected 不符时拒绝（返回 false）
   * B-12 修复：防 async 交错/并发请求的读-改-写覆盖（丢事件链 = 幂等失效）
   */
  async putContractInstanceCAS(doc: any, expectedVersion: number): Promise<boolean> {
    const cur = this.contractInstances.get(doc.id);
    if (cur && Number(cur.version) !== Number(expectedVersion)) return false;
    this.contractInstances.set(doc.id, { ...doc, _id: doc.id, version: Number(doc.version) });
    this.schedulePersist();
    return true;
  }

  async listContractInstances(filter: { initiatorId?: string; state?: string; family?: string; gameId?: string } = {}): Promise<any[]> {
    // B-27 修复：返回深拷贝——此前返回 Map 真身引用，tick 循环在真身上 version+1 后
    // 再做 CAS（cur===doc）永远不等 → 一次冲突后 version 错位永久锁死
    const rows = Array.from(this.contractInstances.values()).map((r) => structuredClone(r));
    return rows.filter((r) => {
      if (filter.initiatorId && r.initiatorId !== filter.initiatorId) return false;
      if (filter.state && r.state !== filter.state) return false;
      if (filter.family && r.family !== filter.family) return false;
      if (filter.gameId && r.gameId !== filter.gameId) return false;
      return true;
    });
  }

  // ========== UGC 合约模板注册中心（contract_templates_ugc，CW-1） ==========

  /** upsert UGC 模板文档（key 为幂等键：同名同作者覆盖 = 新版本提交） */
  async putUgcTemplateDoc(doc: any): Promise<void> {
    this.contractTemplatesUgc.set(doc.key, { ...doc, _id: doc.key });
    this.schedulePersist();
  }

  async getUgcTemplateDoc(key: string): Promise<any | null> {
    const doc = this.contractTemplatesUgc.get(key);
    return doc ? structuredClone(doc) : null;
  }

  /**
   * 列表：公开列表（status=approved）；?mine → 本人全部状态。
   * 每个 key 保留最高版本（提交同 key 即覆盖，无多版本并存）。
   */
  async listUgcTemplates(filter: { status?: string; authorId?: string } = {}): Promise<any[]> {
    return Array.from(this.contractTemplatesUgc.values())
      .filter((t: any) => {
        if (filter.authorId) return t.authorId === filter.authorId;
        if (filter.status) return t.status === filter.status;
        return t.status === 'approved';
      })
      .sort((a: any, b: any) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  // ========== 站内信通知（notifications） ==========

  /** upsert 通知（id 确定性 = 幂等键：重试/重复部署不产生重复通知） */
  async putNotification(doc: any): Promise<void> {
    this.notifications.set(doc.id, { ...doc, _id: doc.id });
    this.schedulePersist();
  }

  async listNotifications(toUserId: string, limit = 50): Promise<any[]> {
    return Array.from(this.notifications.values())
      .filter((n) => n.toUserId === toUserId)
      .sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0))
      .slice(0, Math.max(1, limit))
      .map((r) => structuredClone(r));
  }

  async unreadNotificationCount(toUserId: string): Promise<number> {
    let count = 0;
    for (const n of this.notifications.values()) {
      if (n.toUserId === toUserId && !n.read) count += 1;
    }
    return count;
  }

  /** 标记已读：ids 缺省 = 全部本人通知；返回实际更新条数 */
  async markNotificationsRead(toUserId: string, ids?: string[]): Promise<number> {
    let updated = 0;
    const idSet = ids && ids.length > 0 ? new Set(ids) : null;
    for (const n of this.notifications.values()) {
      if (n.toUserId !== toUserId || n.read) continue;
      if (idSet && !idSet.has(n.id)) continue;
      n.read = true;
      n.readAt = Date.now();
      updated += 1;
    }
    if (updated > 0) this.schedulePersist();
    return updated;
  }

  async getVoucherDoc(voucherId: string): Promise<any | null> {
    return this.vouchers.get(voucherId) || null;
  }

  async putVoucherDoc(voucherId: string, doc: any): Promise<void> {
    this.vouchers.set(voucherId, { ...doc, _id: voucherId });
    this.schedulePersist();
  }

  /** 服务端铸造合约凭证（RSV 等）：写入 vouchers 集合 + 服务端签名标记 */
  async putContractVoucher(doc: any): Promise<void> {
    this.vouchers.set(doc.id, { ...doc, _id: doc.id });
    this.schedulePersist();
  }

  /** 🆕 2026-10-16：本地 __item/__market vouchers 集合直读（与 __contract 统一存储；prod 云函数同一集合） */
  getVouchersStore(): Map<string, any> {
    return this.vouchers;
  }

  /**
   * 🆕 拼团履约发货（2026-10-16）：在平台池中找一张指定 skuId 的可用道具凭证。
   * 库存语义与商店购买一致：池内 active 且未被冻结的 ITEM 凭证。
   */
  async findPoolItemVoucher(templateId: string): Promise<any | null> {
    for (const v of this.vouchers.values()) {
      if (v.currentHolderId !== 'platform_pool') continue;
      if (v.status !== 'active' || v.frozenAt) continue;
      const src = (v as any).sourceType || v.metadata?.sourceType;
      if (src !== 'item') continue;
      if (v.metadata?.customData?.itemTemplateId !== templateId) continue;
      return { ...v };
    }
    return null;
  }

  async putEscrowEntry(entry: any): Promise<void> {
    this.contractEscrows.set(entry.entryId, { ...entry, _id: entry.entryId });
    this.schedulePersist();
  }

  async getEscrowEntry(entryId: string): Promise<any | null> {
    return this.contractEscrows.get(entryId) || null;
  }

  async listEscrowByContract(contractId: string): Promise<any[]> {
    return Array.from(this.contractEscrows.values()).filter((e) => e.contractId === contractId);
  }

  async listEscrowByTx(txId: string): Promise<any | null> {
    for (const e of this.contractEscrows.values()) {
      if (e.txId === txId) return e;
    }
    return null;
  }

  async listAllEscrows(): Promise<any[]> {
    return Array.from(this.contractEscrows.values());
  }

  /** 查用户持有的 active 凭证（A币托管锁定用） */
  async listContractVouchersByHolder(userId: string): Promise<any[]> {
    return Array.from(this.vouchers.values()).filter(
      (v) => v.currentHolderId === userId && v.status === 'active',
    );
  }

  async putRevenueEntry(entry: any): Promise<void> {
    this.revenueLedger.set(entry.entryId, { ...entry, _id: entry.entryId });
    this.schedulePersist();
  }

  async getRevenueEntry(entryId: string): Promise<any | null> {
    return this.revenueLedger.get(entryId) || null;
  }

  /** 按账户列出台账明细（三方分账影子对照审计用） */
  async listRevenueEntriesByAccount(accountId: string): Promise<any[]> {
    const list: any[] = [];
    for (const r of this.revenueLedger.values()) {
      if (r.accountId === accountId) list.push(r);
    }
    list.sort((a, b) => (Number(a.occurredAt) || 0) - (Number(b.occurredAt) || 0));
    return list;
  }

  /** 查询某游戏在时间窗内的可观测收益（GSO 分账口径） */
  async sumRevenue(gameId: string, source: string, fromMs: number, toMs: number): Promise<number> {
    let sum = 0;
    for (const r of this.revenueLedger.values()) {
      if (r.gameId !== gameId) continue;
      // 存量兼容（P0a）：旧条目 source 为连字符 'item-sale'，归一化后匹配下划线口径
      const src = r.source === 'item-sale' ? 'item_sale' : r.source;
      if (src !== source) continue;
      if (r.occurredAt > fromMs && r.occurredAt <= toMs) sum += Number(r.commission) || 0;
    }
    return sum;
  }

  // ========== 三方分成配置变更历史（append-only 哈希链存证） ==========

  async addRevenueSharingEntry(entry: any): Promise<void> {
    this.revenueSharingHistory.push(entry);
    // append-only，保留最近 500 条
    if (this.revenueSharingHistory.length > 500) {
      this.revenueSharingHistory = this.revenueSharingHistory.slice(-500);
    }
    this.schedulePersist();
  }

  async getRevenueSharingHistory(accountId?: string, limit?: number): Promise<any[]> {
    const list = accountId
      ? this.revenueSharingHistory.filter(e => e.accountId === accountId)
      : [...this.revenueSharingHistory];
    return limit ? list.slice(-limit) : list;
  }

  // ========== 平台规则注册表（contract_rules） ==========

  async getPlatformRuleDoc(ruleKey: string): Promise<any | null> {
    // B-26 修复：深拷贝（返回 Map 引用会让 propose 直接改存储对象 → CAS 误报并发冲突）
    const doc = this.contractRules.get(ruleKey);
    return doc ? structuredClone(doc) : null;
  }

  async putPlatformRuleDoc(doc: any): Promise<void> {
    this.contractRules.set(doc.ruleKey || doc.id, { ...doc, _id: doc.ruleKey || doc.id });
    this.schedulePersist();
  }

  /** 乐观锁写入（治理链防并发覆盖） */
  async putPlatformRuleDocCAS(doc: any, expectedVersion: number): Promise<boolean> {
    const cur = this.contractRules.get(doc.ruleKey || doc.id);
    if (cur && Number(cur.version) !== Number(expectedVersion)) return false;
    this.contractRules.set(doc.ruleKey || doc.id, { ...doc, _id: doc.ruleKey || doc.id, version: Number(doc.version) });
    this.schedulePersist();
    return true;
  }

  async listPlatformRules(): Promise<any[]> {
    return Array.from(this.contractRules.values());
  }

  // ========== A币凭证（vouchers） ==========

  /** 创建 A币凭证并发给用户（category=currency，可计入余额） */
  async createACoinVoucher(params: {
    id: string;
    denomination: number;
    holderId: string;
    holderName?: string;
    note?: string;
    reason?: string;
  }): Promise<any | null> {
    if (!params.id || !params.holderId || params.denomination <= 0) return null;
    const now = Date.now();
    const voucher = {
      id: params.id,
      serialNumber: `AC-${now}-${String(Math.floor(Math.random() * 9000) + 1000)}`,
      denomination: params.denomination,
      currentHolderId: params.holderId,
      currentHolderName: params.holderName || params.holderId,
      status: 'active',
      createdAt: now,
      createdBy: 'quest-reward',
      createdByName: '任务系统',
      sourceType: 'instant',
      category: 'currency',
      transferCount: 0,
      metadata: {
        name: `任务奖励 ${params.denomination} A币`,
        reason: params.reason || params.note || '任务报酬',
        note: params.note,
      },
    };
    this.vouchers.set(params.id, voucher);
    this.schedulePersist();
    return voucher;
  }

  async getUserVouchers(userId: string): Promise<any[]> {
    return Array.from(this.vouchers.values()).filter((v) => v.currentHolderId === userId);
  }

  clear(): void {
    this.inventory = [];
    this.syncLogs = [];
    this.gameFiles = [];
    this.developerAccounts.clear();
    this.developerTransactions = [];
    this.publishedGames.clear();
    this.quests.clear();
    this.questClaims.clear();
    this.questSubmissions.clear();
    this.questMods.clear();
    this.gameWallets.clear();
    this.contentAssets.clear();
    this.users.clear();
    this.vouchers.clear();
    this.idCounters = { inventory: 1, syncLog: 1, gameFile: 1 };
  }
}

// 导出单例
export const memoryDB = new MemoryDatabase();
