/**
 * Inventory API - 道具库存系统
 */

import type { AllinONEGame } from '../index';
import { getCachedToken } from './tokenManager';

export interface InventoryItem {
  id: string;
  itemId: string;
  name: string;
  description?: string;
  category: string;
  quantity: number;
  icon?: string;
  metadata?: Record<string, any>;
  acquiredAt: string;
  gameSource: string;
}

export interface AddItemParams {
  itemId: string;
  name: string;
  description?: string;
  category?: string;
  quantity?: number;
  icon?: string;
  metadata?: Record<string, any>;
}

export class InventoryAPI {
  private game: AllinONEGame;
  private items: Map<string, InventoryItem> = new Map();
  private initialized: boolean = false;

  constructor(game: AllinONEGame) {
    this.game = game;
  }

  async initialize(): Promise<void> {
    // 加载本地缓存
    const saved = localStorage.getItem(`allinone_inventory_${this.getGameId()}`);
    if (saved) {
      try {
        const items: InventoryItem[] = JSON.parse(saved);
        items.forEach(item => this.items.set(item.itemId, item));
      } catch {
        // 忽略解析错误
      }
    }

    // 从服务器同步
    await this.sync();
    this.initialized = true;
  }

  /**
   * 获取所有道具
   */
  async getAllItems(): Promise<InventoryItem[]> {
    await this.sync();
    return Array.from(this.items.values());
  }

  /**
   * 获取特定类型的道具
   */
  async getItemsByCategory(category: string): Promise<InventoryItem[]> {
    return Array.from(this.items.values()).filter(item => item.category === category);
  }

  /**
   * 获取单个道具
   */
  async getItem(itemId: string): Promise<InventoryItem | undefined> {
    return this.items.get(itemId);
  }

  /**
   * 添加道具
   */
  async addItem(params: AddItemParams): Promise<InventoryItem> {
    const existingItem = this.items.get(params.itemId);
    
    if (existingItem) {
      // 更新数量
      existingItem.quantity += params.quantity || 1;
      this.items.set(params.itemId, existingItem);
    } else {
      // 创建新道具
      const newItem: InventoryItem = {
        id: `${this.getGameId()}_${params.itemId}_${Date.now()}`,
        itemId: params.itemId,
        name: params.name,
        description: params.description,
        category: params.category || 'item',
        quantity: params.quantity || 1,
        icon: params.icon,
        metadata: params.metadata,
        acquiredAt: new Date().toISOString(),
        gameSource: this.getGameId(),
      };
      this.items.set(params.itemId, newItem);
    }

    await this.save();
    
    // 触发事件
    (this.game as any).emit('inventory:update', { 
      type: 'add',
      item: this.items.get(params.itemId),
    });

    return this.items.get(params.itemId)!;
  }

  /**
   * 使用道具
   */
  async useItem(itemId: string, quantity: number = 1): Promise<boolean> {
    const item = this.items.get(itemId);
    
    if (!item || item.quantity < quantity) {
      return false;
    }

    item.quantity -= quantity;
    
    if (item.quantity <= 0) {
      this.items.delete(itemId);
    } else {
      this.items.set(itemId, item);
    }

    await this.save();

    // 触发事件
    (this.game as any).emit('inventory:update', {
      type: 'use',
      itemId,
      quantity,
    });

    return true;
  }

  /**
   * 批量同步道具
   */
  async syncItems(items: Array<{ itemId: string; name: string; quantity: number; category?: string }>): Promise<void> {
    for (const item of items) {
      await this.addItem({
        itemId: item.itemId,
        name: item.name,
        quantity: item.quantity,
        category: item.category || 'item',
      });
    }
  }

  /**
   * 与服务器同步
   */
  async sync(): Promise<void> {
    try {
      const token = this.getToken();
      if (!token) return;

      const response = await fetch(`/api/inventory?gameSource=${this.getGameId()}`, {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });

      const result = await response.json();

      if (result.success && result.items) {
        // 合并服务器数据
        result.items.forEach((item: InventoryItem) => {
          this.items.set(item.itemId, item);
        });
        this.saveLocal();
      }
    } catch (error) {
      console.warn('Failed to sync inventory:', error);
    }
  }

  // ==================== 私有方法 ====================

  private async save(): Promise<void> {
    this.saveLocal();
    
    // 同步到服务器
    try {
      const token = this.getToken();
      if (!token) return;

      await fetch('/api/inventory/sync', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          gameSource: this.getGameId(),
          items: Array.from(this.items.values()),
        }),
      });
    } catch (error) {
      console.warn('Failed to save inventory to server:', error);
    }
  }

  private saveLocal(): void {
    localStorage.setItem(
      `allinone_inventory_${this.getGameId()}`,
      JSON.stringify(Array.from(this.items.values()))
    );
  }

  private getGameId(): string {
    return (this.game as any).getConfig().gameId;
  }

  private getToken(): string | null {
    return localStorage.getItem('allinone_token');
  }
}
