/**
 * CloudBase 道具注册表同步服务
 *
 * 将道具凭证模板同步到 CloudBase 文档数据库，
 * 支持跨游戏查询、跨玩家发现和云端持久化。
 */

import { getCloudBaseApp, isCloudBaseReady } from './cloudbase';
import { voucherItemService } from './voucherItemService';
import { getPublishedGames } from './publishedGameService';
import { ExtensionVoucherService } from '@/publishing-center/protocol/ExtensionVoucher';
import type { ItemVoucherTemplate } from '@/voucher-system/types';
import type { ExtensionVoucher } from '@/publishing-center/protocol/ExtensionVoucher';

// ==================== 类型定义 ====================

export interface CloudItemRecord {
  _id?: string;
  id: string;
  templateId: string;
  gameId: string;
  gameName: string;
  name: string;
  description: string;
  itemType: string;
  rarity: string;
  schemaName: string;
  itemData: Record<string, any>;
  source: 'developer' | 'player_ugc' | 'ai_generated';
  createdBy: string;
  price: number;
  currency: string;
  supplyPolicy: 'limited' | 'open';
  totalSupply?: number;
  mintedCount: number;
  isActive: boolean;
  createdAt: number;
  updatedAt: number;
  /** 兼容的游戏 ID 列表 */
  compatibleGames: string[];
  tags: string[];
}

export interface SyncResult {
  success: boolean;
  synced: number;
  errors: string[];
}

// ==================== 服务类 ====================

class CloudBaseItemSync {
  private readonly COLLECTION = 'item_registry';
  private readonly UGC_COLLECTION = 'ugc_vouchers';

  /**
   * 同步道具模板到云端注册表
   */
  async syncTemplate(template: ItemVoucherTemplate): Promise<boolean> {
    if (!isCloudBaseReady()) {
      console.warn('[CloudBaseItemSync] CloudBase 未就绪，跳过同步');
      return false;
    }

    try {
      const db = getCloudBaseApp().database();

      const record: Partial<CloudItemRecord> = {
        id: template.id,
        templateId: template.id,
        gameId: template.gameId,
        gameName: template.gameName || '',
        name: template.name,
        description: template.description,
        itemType: template.itemType,
        rarity: template.rarity || 'common',
        schemaName: template.gameEffect.schemaName || template.gameEffect.itemId || 'unknown',
        itemData: template.gameEffect.itemData || {},
        source: template.source || 'developer',
        createdBy: template.createdBy,
        price: template.pricing.price,
        currency: template.pricing.currency,
        supplyPolicy: template.supplyPolicy,
        totalSupply: template.totalSupply,
        mintedCount: template.mintedCount,
        isActive: template.isActive,
        createdAt: template.createdAt,
        updatedAt: template.updatedAt,
        compatibleGames: [template.gameId],
        tags: [template.itemType, template.rarity || 'common', template.source || 'developer'],
      };

      // 检查是否已存在
      const existing = await db.collection(this.COLLECTION)
        .where({ id: record.id })
        .get();

      if (existing.data.length > 0) {
        await db.collection(this.COLLECTION)
          .doc(existing.data[0]._id)
          .update(record as any);
      } else {
        await db.collection(this.COLLECTION).add(record as any);
      }

      return true;
    } catch (e) {
      console.warn('[CloudBaseItemSync] 同步模板失败:', e);
      return false;
    }
  }

  /**
   * 批量同步所有模板
   */
  async syncAllTemplates(): Promise<SyncResult> {
    const result: SyncResult = { success: false, synced: 0, errors: [] };

    try {
      const games = getPublishedGames();

      for (const game of games) {
        const templates = voucherItemService.getItemTemplates(game.id);
        for (const tpl of templates) {
          const ok = await this.syncTemplate(tpl);
          if (ok) result.synced++;
          else result.errors.push(`同步失败: ${tpl.name}`);
        }
      }

      result.success = result.errors.length === 0;
      return result;
    } catch (e) {
      result.errors.push(String(e));
      return result;
    }
  }

  /**
   * 查询云端道具注册表
   */
  async queryItems(filters: {
    gameId?: string;
    schemaName?: string;
    rarity?: string;
    source?: string;
    keyword?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<CloudItemRecord[]> {
    if (!isCloudBaseReady()) {
      // 回退到本地
      return this.queryLocalItems(filters);
    }

    try {
      const db = getCloudBaseApp().database();
      let query = db.collection(this.COLLECTION).where({ isActive: true });

      if (filters.gameId) {
        query = query.where({ gameId: filters.gameId });
      }
      if (filters.schemaName) {
        query = query.where({ schemaName: filters.schemaName });
      }

      const res = await query.limit(filters.limit || 50).get();
      let items = res.data as CloudItemRecord[];

      // 本地过滤（部分条件不支持云端 where）
      if (filters.rarity) {
        items = items.filter(i => i.rarity === filters.rarity);
      }
      if (filters.source) {
        items = items.filter(i => i.source === filters.source);
      }
      if (filters.keyword) {
        const kw = filters.keyword.toLowerCase();
        items = items.filter(i =>
          i.name.toLowerCase().includes(kw) ||
          i.description.toLowerCase().includes(kw)
        );
      }

      return items;
    } catch (e) {
      console.warn('[CloudBaseItemSync] 查询失败，回退本地:', e);
      return this.queryLocalItems(filters);
    }
  }

  /**
   * 本地回退查询
   */
  private queryLocalItems(filters: {
    gameId?: string;
    schemaName?: string;
    rarity?: string;
    source?: string;
    keyword?: string;
    limit?: number;
    offset?: number;
  }): CloudItemRecord[] {
    const games = (() => {
      try {
        return getPublishedGames();
      } catch {
        return [];
      }
    })();

    const results: CloudItemRecord[] = [];

    for (const game of games) {
      if (filters.gameId && game.id !== filters.gameId) continue;

      const templates = voucherItemService.getItemTemplates(game.id);
      for (const tpl of templates) {
        if (filters.schemaName) {
          const schemaName = tpl.gameEffect.schemaName || tpl.gameEffect.itemId;
          if (schemaName !== filters.schemaName) continue;
        }
        if (filters.rarity && tpl.rarity !== filters.rarity) continue;
        if (filters.source && tpl.source !== filters.source) continue;
        if (filters.keyword) {
          const kw = filters.keyword.toLowerCase();
          if (!tpl.name.toLowerCase().includes(kw) && !tpl.description.toLowerCase().includes(kw)) continue;
        }

        results.push({
          id: tpl.id,
          templateId: tpl.id,
          gameId: tpl.gameId,
          gameName: tpl.gameName || '',
          name: tpl.name,
          description: tpl.description,
          itemType: tpl.itemType,
          rarity: tpl.rarity || 'common',
          schemaName: tpl.gameEffect.schemaName || tpl.gameEffect.itemId || 'unknown',
          itemData: tpl.gameEffect.itemData || {},
          source: tpl.source || 'developer',
          createdBy: tpl.createdBy,
          price: tpl.pricing.price,
          currency: tpl.pricing.currency,
          supplyPolicy: tpl.supplyPolicy,
          totalSupply: tpl.totalSupply,
          mintedCount: tpl.mintedCount,
          isActive: tpl.isActive,
          createdAt: tpl.createdAt,
          updatedAt: tpl.updatedAt,
          compatibleGames: [tpl.gameId],
          tags: [tpl.itemType, tpl.rarity || 'common'],
        });
      }
    }

    if (filters.limit) {
      return results.slice(filters.offset || 0, (filters.offset || 0) + filters.limit);
    }
    return results;
  }

  /**
   * 🆕 记录跨游戏适配关系
   */
  async recordAdaptation(params: {
    sourceTemplateId: string;
    sourceGameId: string;
    targetGameId: string;
    adaptedSchemaName: string;
  }): Promise<void> {
    if (!isCloudBaseReady()) return;

    try {
      const db = getCloudBaseApp().database();
      const res = await db.collection(this.COLLECTION)
        .where({ id: params.sourceTemplateId })
        .get();

      if (res.data.length > 0) {
        const record = res.data[0] as CloudItemRecord;
        if (!record.compatibleGames.includes(params.targetGameId)) {
          record.compatibleGames.push(params.targetGameId);
          await db.collection(this.COLLECTION)
            .doc(res.data[0]._id)
            .update({ compatibleGames: record.compatibleGames } as any);
        }
      }
    } catch (e) {
      console.warn('[CloudBaseItemSync] 记录适配失败:', e);
    }
  }

  /**
   * 同步 ExtensionVoucher 到云端
   */
  async syncUGCVoucher(voucher: ExtensionVoucher): Promise<boolean> {
    if (!isCloudBaseReady()) return false;

    try {
      const db = getCloudBaseApp().database();
      await db.collection(this.UGC_COLLECTION).add({
        voucherId: voucher.id,
        schemaName: voucher.schemaName,
        sourceGameId: voucher.sourceGameId,
        targetGameId: voucher.targetGameId,
        data: voucher.data,
        status: voucher.status,
        createdAt: voucher.createdAt,
        transferCount: voucher.transferCount,
      } as any);

      return true;
    } catch (e) {
      console.warn('[CloudBaseItemSync] 同步UGC凭证失败:', e);
      return false;
    }
  }
}

export const cloudbaseItemSync = new CloudBaseItemSync();
export default cloudbaseItemSync;
