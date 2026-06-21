/**
 * AllinONE Skill 系统 - 库存 Skill
 * 统一道具库存管理：查询、添加、同步、交易
 */

import { BaseSkill } from '../BaseSkill';
import {
  SkillDefinition,
  SkillContext,
  JSONSchema,
} from '../types';
import { SkillErrors } from '../errors';
import { writeQueue } from '../../services/writeQueue';

// ==================== 类型定义 ====================

export interface InventoryItem {
  id: number;
  itemId: string;
  userId: string;
  name: string;
  description: string;
  gameSource: 'allinone' | 'newday' | string;
  gameName: string;
  category: string;
  rarity: 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary' | string;
  icon?: string;
  quantity: number;
  stats?: ItemStats;
  obtainedAt: Date;
  obtainedFrom: string;
  syncStatus: 'not_synced' | 'syncing' | 'synced' | 'failed';
  syncedAt?: Date;
  originalItemId?: string;
  metadata?: Record<string, any>;
}

export interface ItemStats {
  attack?: number;
  defense?: number;
  health?: number;
  speed?: number;
  magic?: number;
  [key: string]: number | undefined;
}

export interface AddItemParams {
  itemId: string;
  name: string;
  description?: string;
  gameSource: string;
  gameName: string;
  category: string;
  rarity?: string;
  icon?: string;
  quantity?: number;
  stats?: ItemStats;
  obtainedFrom?: string;
  originalItemId?: string;
  metadata?: Record<string, any>;
}

export interface QueryParams {
  gameSource?: string;
  category?: string;
  rarity?: string;
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

export interface SyncParams {
  gameSource: string;
  items: Array<{
    itemId: string;
    name: string;
    quantity: number;
    [key: string]: any;
  }>;
  options?: {
    forceUpdate?: boolean;
    skipExisting?: boolean;
  };
}

export interface SyncResult {
  success: boolean;
  synced: number;
  added: number;
  updated: number;
  failed: number;
  duration: number;
  errors?: string[];
}

export interface TradeParams {
  itemId: string;
  quantity: number;
  targetUserId: string;
  price?: number;
  currency?: string;
}

export interface UseItemParams {
  itemId: string;
  quantity?: number;
  targetId?: string;
  context?: Record<string, any>;
}

// ==================== Skill 定义 ====================

const inventorySkillDefinition: SkillDefinition = {
  name: 'inventory',
  displayName: '库存服务',
  version: '1.0.0',
  description: '统一道具库存管理服务，支持查询、添加、同步、交易',
  requiredPermissions: [],
  dependencies: ['auth'],
  actions: [],
  events: [
    'inventory.item.added',      // 道具添加
    'inventory.item.removed',    // 道具移除
    'inventory.item.used',       // 道具使用
    'inventory.item.traded',     // 道具交易
    'inventory.sync.completed',  // 同步完成
    'inventory.sync.failed',     // 同步失败
  ],
};

// ==================== Inventory Skill 实现 ====================

export class InventorySkill extends BaseSkill {
  private items: Map<string, InventoryItem> = new Map();
  private readonly STORAGE_KEY = 'inventory_data';
  private apiBaseUrl: string;

  constructor() {
    super(inventorySkillDefinition);
    this.apiBaseUrl = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000/api';
  }

  async onInitialize(): Promise<void> {
    await this.loadFromStorage();
    this.registerActions();
  }

  private registerActions(): void {
    // 获取道具列表
    this.registerAction(
      'getItems',
      this.getItems.bind(this),
      {
        displayName: '获取道具列表',
        description: '获取用户库存中的道具列表',
        paramsSchema: {
          type: 'object',
          properties: {
            gameSource: { type: 'string' },
            category: { type: 'string' },
            rarity: { type: 'string' },
            page: { type: 'number', default: 1 },
            limit: { type: 'number', default: 20 },
            sortBy: { type: 'string' },
            sortOrder: { type: 'string', enum: ['asc', 'desc'] },
          },
        },
        returnsSchema: { type: 'object' },
        requiredPermissions: ['inventory:read:items'],
        readonly: true,
        idempotent: true,
      }
    );

    // 获取单个道具
    this.registerAction(
      'getItem',
      this.getItem.bind(this),
      {
        displayName: '获取道具详情',
        description: '获取指定道具的详细信息',
        paramsSchema: {
          type: 'object',
          properties: {
            itemId: { type: 'string' },
          },
          required: ['itemId'],
        },
        returnsSchema: { type: 'object' },
        requiredPermissions: ['inventory:read:items'],
        readonly: true,
        idempotent: true,
      }
    );

    // 添加道具
    this.registerAction(
      'addItem',
      this.addItem.bind(this),
      {
        displayName: '添加道具',
        description: '添加道具到库存',
        paramsSchema: {
          type: 'object',
          properties: {
            itemId: { type: 'string' },
            name: { type: 'string' },
            description: { type: 'string' },
            gameSource: { type: 'string' },
            gameName: { type: 'string' },
            category: { type: 'string' },
            rarity: { type: 'string' },
            icon: { type: 'string' },
            quantity: { type: 'number', default: 1 },
            stats: { type: 'object' },
            obtainedFrom: { type: 'string' },
            originalItemId: { type: 'string' },
            metadata: { type: 'object' },
          },
          required: ['itemId', 'name', 'gameSource', 'gameName', 'category'],
        },
        returnsSchema: { type: 'object' },
        requiredPermissions: ['inventory:write:add'],
        readonly: false,
        idempotent: false,
      }
    );

    // 批量添加道具
    this.registerAction(
      'addItems',
      this.addItems.bind(this),
      {
        displayName: '批量添加道具',
        description: '批量添加道具到库存',
        paramsSchema: {
          type: 'object',
          properties: {
            items: { type: 'array' },
          },
          required: ['items'],
        },
        returnsSchema: { type: 'object' },
        requiredPermissions: ['inventory:write:add'],
        readonly: false,
        idempotent: false,
      }
    );

    // 移除道具
    this.registerAction(
      'removeItem',
      this.removeItem.bind(this),
      {
        displayName: '移除道具',
        description: '从库存中移除道具',
        paramsSchema: {
          type: 'object',
          properties: {
            itemId: { type: 'string' },
            quantity: { type: 'number' },
          },
          required: ['itemId'],
        },
        returnsSchema: { type: 'object' },
        requiredPermissions: ['inventory:write:remove'],
        readonly: false,
        idempotent: false,
      }
    );

    // 使用道具
    this.registerAction(
      'useItem',
      this.useItem.bind(this),
      {
        displayName: '使用道具',
        description: '使用指定道具',
        paramsSchema: {
          type: 'object',
          properties: {
            itemId: { type: 'string' },
            quantity: { type: 'number', default: 1 },
            targetId: { type: 'string' },
            context: { type: 'object' },
          },
          required: ['itemId'],
        },
        returnsSchema: { type: 'object' },
        requiredPermissions: ['inventory:write:use'],
        readonly: false,
        idempotent: false,
      }
    );

    // 同步库存
    this.registerAction(
      'sync',
      this.sync.bind(this),
      {
        displayName: '同步库存',
        description: '从外部游戏同步道具',
        paramsSchema: {
          type: 'object',
          properties: {
            gameSource: { type: 'string' },
            items: { type: 'array' },
            options: { type: 'object' },
          },
          required: ['gameSource', 'items'],
        },
        returnsSchema: { type: 'object' },
        requiredPermissions: ['inventory:write:sync'],
        readonly: false,
        idempotent: false,
      }
    );

    // 获取同步状态
    this.registerAction(
      'getSyncStatus',
      this.getSyncStatus.bind(this),
      {
        displayName: '获取同步状态',
        description: '获取道具的同步状态',
        paramsSchema: {
          type: 'object',
          properties: {
            itemId: { type: 'string' },
          },
          required: ['itemId'],
        },
        returnsSchema: { type: 'object' },
        requiredPermissions: ['inventory:read:sync'],
        readonly: true,
        idempotent: true,
      }
    );

    // 更新同步状态
    this.registerAction(
      'updateSyncStatus',
      this.updateSyncStatus.bind(this),
      {
        displayName: '更新同步状态',
        description: '更新道具的同步状态',
        paramsSchema: {
          type: 'object',
          properties: {
            itemId: { type: 'string' },
            syncStatus: { type: 'string', enum: ['not_synced', 'syncing', 'synced', 'failed'] },
          },
          required: ['itemId', 'syncStatus'],
        },
        returnsSchema: { type: 'object' },
        requiredPermissions: ['inventory:write:sync'],
        readonly: false,
        idempotent: true,
      }
    );

    // 获取统计
    this.registerAction(
      'getSummary',
      this.getSummary.bind(this),
      {
        displayName: '获取统计',
        description: '获取库存统计信息',
        paramsSchema: { type: 'object' },
        returnsSchema: { type: 'object' },
        requiredPermissions: ['inventory:read:stats'],
        readonly: true,
        idempotent: true,
      }
    );

    // 交易道具
    this.registerAction(
      'trade',
      this.trade.bind(this),
      {
        displayName: '交易道具',
        description: '与其他用户交易道具',
        paramsSchema: {
          type: 'object',
          properties: {
            itemId: { type: 'string' },
            quantity: { type: 'number' },
            targetUserId: { type: 'string' },
            price: { type: 'number' },
            currency: { type: 'string' },
          },
          required: ['itemId', 'quantity', 'targetUserId'],
        },
        returnsSchema: { type: 'object' },
        requiredPermissions: ['inventory:write:trade'],
        readonly: false,
        idempotent: false,
      }
    );
  }

  // ==================== 动作实现 ====================

  private async getItems(params: QueryParams, context: SkillContext): Promise<{ items: InventoryItem[]; total: number; page: number; limit: number }> {
    let items = Array.from(this.items.values());

    // 过滤
    if (params.gameSource) {
      items = items.filter(item => item.gameSource === params.gameSource);
    }
    if (params.category) {
      items = items.filter(item => item.category === params.category);
    }
    if (params.rarity) {
      items = items.filter(item => item.rarity === params.rarity);
    }

    // 排序
    const sortBy = params.sortBy || 'obtainedAt';
    const sortOrder = params.sortOrder || 'desc';
    items.sort((a, b) => {
      const aVal = (a as any)[sortBy];
      const bVal = (b as any)[sortBy];
      return sortOrder === 'asc' ? (aVal > bVal ? 1 : -1) : (aVal < bVal ? 1 : -1);
    });

    // 分页
    const page = params.page || 1;
    const limit = params.limit || 20;
    const total = items.length;
    const start = (page - 1) * limit;
    const paginatedItems = items.slice(start, start + limit);

    return {
      items: paginatedItems,
      total,
      page,
      limit,
    };
  }

  private async getItem(params: { itemId: string }, _context: SkillContext): Promise<InventoryItem | null> {
    return this.items.get(params.itemId) || null;
  }

  private async addItem(params: AddItemParams, context: SkillContext): Promise<InventoryItem> {
    const existingItem = this.items.get(params.itemId);

    if (existingItem) {
      // 更新数量
      existingItem.quantity += params.quantity || 1;
      existingItem.syncStatus = 'not_synced';
      this.items.set(params.itemId, existingItem);
      await this.saveToStorage();

      this.emit('inventory.item.updated', { item: existingItem, added: params.quantity || 1 }, context);
      return existingItem;
    }

    const newItem: InventoryItem = {
      id: Date.now(),
      itemId: params.itemId,
      userId: context.userId,
      name: params.name,
      description: params.description || '',
      gameSource: params.gameSource as any,
      gameName: params.gameName,
      category: params.category,
      rarity: params.rarity || 'common',
      icon: params.icon,
      quantity: params.quantity || 1,
      stats: params.stats,
      obtainedAt: new Date(),
      obtainedFrom: params.obtainedFrom || 'system',
      syncStatus: 'not_synced',
      originalItemId: params.originalItemId,
      metadata: params.metadata,
    };

    this.items.set(params.itemId, newItem);
    await this.saveToStorage();

    this.emit('inventory.item.added', { item: newItem }, context);

    return newItem;
  }

  private async addItems(params: { items: AddItemParams[] }, context: SkillContext): Promise<{ success: InventoryItem[]; failed: { item: AddItemParams; error: string }[] }> {
    const success: InventoryItem[] = [];
    const failed: { item: AddItemParams; error: string }[] = [];

    for (const item of params.items) {
      try {
        const result = await this.addItem(item, context);
        success.push(result);
      } catch (error) {
        failed.push({
          item,
          error: error instanceof Error ? error.message : '未知错误',
        });
      }
    }

    return { success, failed };
  }

  private async removeItem(params: { itemId: string; quantity?: number }, context: SkillContext): Promise<{ success: boolean; removed: number }> {
    const item = this.items.get(params.itemId);
    if (!item) {
      throw SkillErrors.itemNotFound(params.itemId);
    }

    const removeQty = params.quantity || item.quantity;
    
    if (removeQty >= item.quantity) {
      this.items.delete(params.itemId);
      await this.saveToStorage();
      
      this.emit('inventory.item.removed', { itemId: params.itemId, quantity: item.quantity }, context);
      return { success: true, removed: item.quantity };
    }

    item.quantity -= removeQty;
    this.items.set(params.itemId, item);
    await this.saveToStorage();

    this.emit('inventory.item.updated', { item, removed: removeQty }, context);
    return { success: true, removed: removeQty };
  }

  private async useItem(params: UseItemParams, context: SkillContext): Promise<{ success: boolean; result?: any }> {
    const item = this.items.get(params.itemId);
    if (!item) {
      throw SkillErrors.itemNotFound(params.itemId);
    }

    const useQty = params.quantity || 1;
    if (item.quantity < useQty) {
      throw SkillErrors.validationError('quantity', '数量不足');
    }

    // 扣除数量
    item.quantity -= useQty;
    if (item.quantity <= 0) {
      this.items.delete(params.itemId);
    } else {
      this.items.set(params.itemId, item);
    }

    await this.saveToStorage();

    this.emit('inventory.item.used', {
      itemId: params.itemId,
      quantity: useQty,
      targetId: params.targetId,
      context: params.context,
    }, context);

    return {
      success: true,
      result: {
        item,
        used: useQty,
        remaining: item.quantity,
      },
    };
  }

  private async sync(params: SyncParams, context: SkillContext): Promise<SyncResult> {
    const startTime = Date.now();
    const result: SyncResult = {
      success: true,
      synced: 0,
      added: 0,
      updated: 0,
      failed: 0,
      duration: 0,
      errors: [],
    };

    for (const itemData of params.items) {
      try {
        const existingItem = this.items.get(itemData.itemId);

        if (existingItem && !params.options?.skipExisting) {
          // 更新现有道具
          if (params.options?.forceUpdate || existingItem.syncStatus !== 'synced') {
            existingItem.quantity = itemData.quantity;
            existingItem.syncStatus = 'synced';
            existingItem.syncedAt = new Date();
            this.items.set(itemData.itemId, existingItem);
            result.updated++;
          }
        } else if (!existingItem) {
          // 添加新道具
          const newItem: InventoryItem = {
            id: Date.now() + Math.random(),
            itemId: itemData.itemId,
            userId: context.userId,
            name: itemData.name,
            description: itemData.description || '',
            gameSource: params.gameSource,
            gameName: itemData.gameName || params.gameSource,
            category: itemData.category || 'general',
            rarity: itemData.rarity || 'common',
            quantity: itemData.quantity,
            obtainedAt: new Date(),
            obtainedFrom: params.gameSource,
            syncStatus: 'synced',
            syncedAt: new Date(),
            originalItemId: itemData.originalItemId,
          };
          this.items.set(itemData.itemId, newItem);
          result.added++;
        }

        result.synced++;
      } catch (error) {
        result.failed++;
        result.errors?.push(`同步 ${itemData.itemId} 失败: ${error instanceof Error ? error.message : '未知错误'}`);
      }
    }

    await this.saveToStorage();
    result.duration = Date.now() - startTime;

    this.emit('inventory.sync.completed', {
      gameSource: params.gameSource,
      result,
    }, context);

    return result;
  }

  private async getSyncStatus(params: { itemId: string }, _context: SkillContext): Promise<{ syncStatus: string; syncedAt?: Date }> {
    const item = this.items.get(params.itemId);
    if (!item) {
      throw SkillErrors.itemNotFound(params.itemId);
    }

    return {
      syncStatus: item.syncStatus,
      syncedAt: item.syncedAt,
    };
  }

  private async updateSyncStatus(
    params: { itemId: string; syncStatus: InventoryItem['syncStatus'] },
    context: SkillContext
  ): Promise<{ success: boolean }> {
    const item = this.items.get(params.itemId);
    if (!item) {
      throw SkillErrors.itemNotFound(params.itemId);
    }

    item.syncStatus = params.syncStatus;
    if (params.syncStatus === 'synced') {
      item.syncedAt = new Date();
    }

    this.items.set(params.itemId, item);
    await this.saveToStorage();

    return { success: true };
  }

  private async getSummary(_params: any, _context: SkillContext): Promise<any> {
    const items = Array.from(this.items.values());
    
    const byGame = new Map<string, { count: number; value: number }>();
    const byCategory = new Map<string, number>();
    const byRarity = new Map<string, number>();

    for (const item of items) {
      // 按游戏统计
      const gameStats = byGame.get(item.gameSource) || { count: 0, value: 0 };
      gameStats.count += item.quantity;
      byGame.set(item.gameSource, gameStats);

      // 按分类统计
      byCategory.set(item.category, (byCategory.get(item.category) || 0) + item.quantity);

      // 按稀有度统计
      byRarity.set(item.rarity, (byRarity.get(item.rarity) || 0) + item.quantity);
    }

    return {
      total: items.length,
      totalQuantity: items.reduce((sum, item) => sum + item.quantity, 0),
      byGame: Array.from(byGame.entries()).map(([source, stats]) => ({ source, ...stats })),
      byCategory: Object.fromEntries(byCategory),
      byRarity: Object.fromEntries(byRarity),
      syncStatus: {
        synced: items.filter(i => i.syncStatus === 'synced').length,
        notSynced: items.filter(i => i.syncStatus === 'not_synced').length,
        syncing: items.filter(i => i.syncStatus === 'syncing').length,
        failed: items.filter(i => i.syncStatus === 'failed').length,
      },
    };
  }

  private async trade(params: TradeParams, context: SkillContext): Promise<{ success: boolean; tradeId: string }> {
    const item = this.items.get(params.itemId);
    if (!item) {
      throw SkillErrors.itemNotFound(params.itemId);
    }

    if (item.quantity < params.quantity) {
      throw SkillErrors.validationError('quantity', '道具数量不足');
    }

    // 扣除道具
    item.quantity -= params.quantity;
    if (item.quantity <= 0) {
      this.items.delete(params.itemId);
    } else {
      this.items.set(params.itemId, item);
    }

    await this.saveToStorage();

    const tradeId = this.generateId();

    this.emit('inventory.item.traded', {
      tradeId,
      itemId: params.itemId,
      quantity: params.quantity,
      fromUserId: context.userId,
      toUserId: params.targetUserId,
      price: params.price,
      currency: params.currency,
    }, context);

    return { success: true, tradeId };
  }

  // ==================== 数据持久化 ====================

  private async loadFromStorage(): Promise<void> {
    try {
      const data = localStorage.getItem(this.STORAGE_KEY);
      if (data) {
        const parsed = JSON.parse(data);
        this.items = new Map(Object.entries(parsed.items || {}));
      }
    } catch (error) {
      console.error('[InventorySkill] 加载数据失败:', error);
    }
  }

  private async saveToStorage(): Promise<void> {
    try {
      const data = {
        items: Object.fromEntries(this.items),
        updatedAt: new Date().toISOString(),
      };
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(data));
      // CloudBase 双写（通过写入队列，全量入队不再截断）
      const items = Array.from(this.items.values());
      for (const item of items) {
        writeQueue.enqueue({
          collection: 'inventories',
          operation: 'upsert',
          data: item as any,
        });
      }
    } catch (error) {
      console.error('[InventorySkill] 保存数据失败:', error);
    }
  }

  // ==================== 公共方法 ====================

  /**
   * 获取所有道具
   */
  getAllItems(): InventoryItem[] {
    return Array.from(this.items.values());
  }

  /**
   * 按条件查找道具
   */
  findItems(predicate: (item: InventoryItem) => boolean): InventoryItem[] {
    return this.getAllItems().filter(predicate);
  }
}

// 导出单例
export const inventorySkill = new InventorySkill();
