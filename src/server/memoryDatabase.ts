/**
 * 内存数据库替代方案
 * 用于 CloudStudio 等无 PostgreSQL 环境
 * 数据仅在服务器运行期间保留
 */

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
  private idCounters = {
    inventory: 1,
    syncLog: 1,
    gameFile: 1,
  };

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
    return newItem;
  }

  async updateInventoryQuantity(id: number, quantity: number): Promise<void> {
    const item = this.inventory.find(i => i.id === id);
    if (item) {
      item.quantity = quantity;
      item.updated_at = new Date();
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
  }

  async addDeveloperTransaction(tx: DeveloperTransaction): Promise<void> {
    this.developerTransactions.push(tx);
    // 保留最近 1000 条
    if (this.developerTransactions.length > 1000) {
      this.developerTransactions = this.developerTransactions.slice(-1000);
    }
  }

  async getDeveloperTransactions(accountId?: string, limit?: number): Promise<DeveloperTransaction[]> {
    let result = accountId
      ? this.developerTransactions.filter(t => t.accountId === accountId)
      : [...this.developerTransactions];
    result.sort((a, b) => b.timestamp - a.timestamp);
    if (limit) result = result.slice(0, limit);
    return result;
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

  clear(): void {
    this.inventory = [];
    this.syncLogs = [];
    this.gameFiles = [];
    this.developerAccounts.clear();
    this.developerTransactions = [];
    this.idCounters = { inventory: 1, syncLog: 1, gameFile: 1 };
  }
}

// 导出单例
export const memoryDB = new MemoryDatabase();
