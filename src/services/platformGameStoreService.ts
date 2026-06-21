/**
 * 平台游戏商店服务
 *
 * 管理外部游戏注册、平台商店道具查询、购买流程。
 * 底层复用 voucherItemService + redeemCodeService。
 */
import {
  ExternalGameStore,
  PlatformStoreItem,
  PlatformStoreQuery,
  PlatformPurchaseResult,
  PLATFORM_GAME_STORES_KEY,
  StoreSortBy,
  StoreFilterCategory,
} from '@/types/platformGameStore';
import { voucherItemService, type PurchaseItemVoucherRequest } from '@/services/voucherItemService';
import { skillGateway } from '@/skills';
import type { ItemVoucherTemplate } from '@/voucher-system/types';
import { writeQueue } from './writeQueue';

// ==================== 存储工具 ====================

function loadStores(): ExternalGameStore[] {
  try {
    const raw = localStorage.getItem(PLATFORM_GAME_STORES_KEY);
    const data = raw ? JSON.parse(raw) : [];
    if (!_storesCloudSyncInitiated) {
      _storesCloudSyncInitiated = true;
      import('./cloudbase').then(({ isCloudBaseReady, getCloudBaseApp }) => {
        if (!isCloudBaseReady()) return;
        getCloudBaseApp().database().collection('game_stores').limit(500).get().then(res => {
          if (res.data.length === 0) return;
          const freshRaw = localStorage.getItem(PLATFORM_GAME_STORES_KEY);
          const fresh: ExternalGameStore[] = freshRaw ? JSON.parse(freshRaw) : [];
          // ✅ CloudBase 数据覆盖本地同名 ID（云端为准）
          const cloudMap = new Map(res.data.map(d => [d.id, d]));
          const localOnly = fresh.filter(s => !cloudMap.has(s.id));
          const merged = [...res.data as ExternalGameStore[], ...localOnly];
          localStorage.setItem(PLATFORM_GAME_STORES_KEY, JSON.stringify(merged));
        }).catch(() => {});
      }).catch(() => {});
    }
    return data;
  } catch {
    return [];
  }
}

let _storesCloudSyncInitiated = false;

function saveStores(stores: ExternalGameStore[]): void {
  localStorage.setItem(PLATFORM_GAME_STORES_KEY, JSON.stringify(stores));
  // CloudBase 双写（通过写入队列，全量入队不再截断）
  for (const store of stores) {
    writeQueue.enqueue({
      collection: 'game_stores',
      operation: 'upsert',
      data: store as any,
    });
  }
}

// ==================== 服务类 ====================

class PlatformGameStoreService {
  // ============ 外部游戏注册 ============

  /** 注册外部游戏 */
  registerGame(data: Omit<ExternalGameStore, 'id' | 'createdAt' | 'updatedAt'>): ExternalGameStore {
    const stores = loadStores();
    const now = Date.now();
    const store: ExternalGameStore = {
      ...data,
      id: `pg-store-${data.gameId}`,
      createdAt: now,
      updatedAt: now,
    };
    stores.push(store);
    saveStores(stores);
    console.log(`[PlatformStore] 注册外部游戏: ${store.gameName} (${store.gameId})`);
    return store;
  }

  /** 获取所有外部游戏（支持按 ownerId 过滤） */
  getGames(activeOnly = true, ownerId?: string): ExternalGameStore[] {
    const stores = loadStores();
    let result = activeOnly ? stores.filter(s => s.isActive) : stores;
    if (ownerId) {
      result = result.filter(s => s.ownerId === ownerId);
    }
    return result;
  }

  /** 获取单个外部游戏 */
  getGame(gameId: string): ExternalGameStore | undefined {
    return loadStores().find(s => s.gameId === gameId);
  }

  /** 更新外部游戏信息 */
  updateGame(gameId: string, updates: Partial<ExternalGameStore>): ExternalGameStore | undefined {
    const stores = loadStores();
    const idx = stores.findIndex(s => s.gameId === gameId);
    if (idx === -1) return undefined;
    stores[idx] = { ...stores[idx], ...updates, updatedAt: Date.now() };
    saveStores(stores);
    return stores[idx];
  }

  /** 删除外部游戏（软删除） */
  deleteGame(gameId: string): boolean {
    return !!this.updateGame(gameId, { isActive: false });
  }

  // ============ 平台商店道具查询 ============

  /** 获取平台商店所有道具（聚合所有外部游戏的模板） */
  getStoreItems(query?: PlatformStoreQuery): PlatformStoreItem[] {
    const stores = this.getGames(true);
    const gameMap = new Map(stores.map(s => [s.gameId, s]));

    // 收集所有外部游戏的模板
    let allTemplates: { template: ItemVoucherTemplate; store: ExternalGameStore }[] = [];
    for (const store of stores) {
      const templates = voucherItemService.getItemTemplates(store.gameId);
      for (const t of templates) {
        allTemplates.push({ template: t, store });
      }
    }

    // 筛选
    if (query) {
      if (query.gameId) {
        allTemplates = allTemplates.filter(t => t.template.gameId === query.gameId);
      }
      if (query.category && query.category !== 'all') {
        allTemplates = allTemplates.filter(t => {
          const c = query.category!;
          if (c === 'weapon') return t.template.itemType === 'permanent' && t.template.rarity !== 'common';
          if (c === 'permanent') return t.template.itemType === 'permanent';
          return t.template.itemType === c;
        });
      }
      if (query.search) {
        const q = query.search.toLowerCase();
        allTemplates = allTemplates.filter(t =>
          t.template.name.toLowerCase().includes(q) ||
          t.template.description?.toLowerCase().includes(q) ||
          t.store.gameName.toLowerCase().includes(q)
        );
      }
    }

    // 转换为视图层道具
    let items: PlatformStoreItem[] = allTemplates.map(({ template, store }) => ({
      templateId: template.id,
      gameId: template.gameId,
      gameName: store.gameName,
      gameIcon: store.gameIcon,
      name: template.name,
      description: template.description,
      itemType: template.itemType,
      icon: template.icon || 'fa-box',
      rarity: template.rarity || 'common',
      price: template.pricing.price,
      currency: template.pricing.currency,
      totalSupply: template.totalSupply || 0,
      mintedCount: template.mintedCount,
      availableCount: voucherItemService.getPoolItemVoucherCount(template.id),
      redeemCodeCount: 0, // 后续在 UI 中实时计算
      template,
    }));

    // 排序
    if (query?.sortBy) {
      switch (query.sortBy) {
        case 'price-asc':
          items.sort((a, b) => a.price - b.price);
          break;
        case 'price-desc':
          items.sort((a, b) => b.price - a.price);
          break;
        case 'newest':
          items.sort((a, b) => b.template.createdAt - a.template.createdAt);
          break;
        case 'popular':
          items.sort((a, b) => b.mintedCount - a.mintedCount);
          break;
      }
    }

    return items;
  }

  /** 获取单个平台道具详情 */
  getStoreItem(templateId: string): PlatformStoreItem | undefined {
    const template = voucherItemService.getItemTemplate(templateId);
    if (!template) return undefined;
    const store = this.getGame(template.gameId);
    if (!store) return undefined;

    return {
      templateId: template.id,
      gameId: template.gameId,
      gameName: store.gameName,
      gameIcon: store.gameIcon,
      name: template.name,
      description: template.description,
      itemType: template.itemType,
      icon: template.icon || 'fa-box',
      rarity: template.rarity || 'common',
      price: template.pricing.price,
      currency: template.pricing.currency,
      totalSupply: template.totalSupply || 0,
      mintedCount: template.mintedCount,
      availableCount: voucherItemService.getPoolItemVoucherCount(template.id),
      redeemCodeCount: 0,
      template,
    };
  }

  // ============ 购买流程 ============

  /** 在平台商店购买道具 */
  async purchaseItem(params: PurchaseItemVoucherRequest): Promise<PlatformPurchaseResult> {
    const template = voucherItemService.getItemTemplate(params.templateId);
    const itemName = template?.name || '未知道具';

    try {
      const result = await voucherItemService.purchaseItemVoucher(params);

      if (!result.success) {
        return {
          success: false,
          itemName,
          message: result.message,
        };
      }

      // 触发全局更新
      window.dispatchEvent(new CustomEvent('wallet-updated'));
      window.dispatchEvent(new CustomEvent('platform-store-purchased', {
        detail: { templateId: params.templateId, gameId: params.gameId },
      }));

      return {
        success: true,
        itemName,
        redeemCode: result.redeemCode,
        voucherId: result.voucher?.id,
        message: result.message,
      };
    } catch (error) {
      return {
        success: false,
        itemName,
        message: error instanceof Error ? error.message : '购买失败',
      };
    }
  }

  // ============ 统计 ============

  /** 获取平台商店总览 */
  getOverview(): {
    gameCount: number;
    itemCount: number;
    totalAvailable: number;
  } {
    const stores = this.getGames(true);
    const items = this.getStoreItems();
    return {
      gameCount: stores.length,
      itemCount: items.length,
      totalAvailable: items.reduce((sum, i) => sum + i.availableCount, 0),
    };
  }
}

// 导出单例
export const platformGameStoreService = new PlatformGameStoreService();
export default platformGameStoreService;
