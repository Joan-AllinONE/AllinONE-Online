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
   */
  async adjustPlatformBalance(userId: string, delta: number, reason: string, txId: string): Promise<{ balance: any; transaction: any } | null> {
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
    if (after < 0) return null; // 余额不足
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
