/**
 * Quest API - 游戏任务中心（GameQuest）
 *
 * 每个已发布游戏「任务中心」的标准 SDK 能力（与道具凭证商店并列）。
 * 走 API_BASE + Bearer <dev-token>。
 */

import type { AllinONEGame } from '../index';
import { getToken } from './tokenManager';
import { getApiBase } from '../../../../services/apiBase';
import type { GameQuest, ContentPack, QuestExtensionRecord } from '@/types/quest';

// 走云函数 __quests 隧道（dev/prod 同路径），不能用 API_BASE（dev 返回 /api/quests 404）。
const API_BASE = `${getApiBase()}/__quests`;

export class QuestAPI {
  private game: AllinONEGame;
  private quests: Map<string, GameQuest> = new Map();
  private initialized: boolean = false;

  constructor(game: AllinONEGame) {
    this.game = game;
  }

  async initialize(): Promise<void> {
    await this.loadQuests();
    this.initialized = true;
  }

  /** 获取本游戏所有任务 */
  async getQuests(): Promise<GameQuest[]> {
    await this.loadQuests();
    return Array.from(this.quests.values());
  }

  /** 获取单个任务（内存缓存） */
  async getQuest(questId: string): Promise<GameQuest | undefined> {
    return this.quests.get(questId);
  }

  /** 领取任务 */
  async claim(taskId: string): Promise<{ success: boolean; message: string }> {
    try {
      const token = await getToken();
      const response = await fetch(`${API_BASE}/${taskId}/claim`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({}),
      });
      const result = await response.json();
      return { success: !!result.success, message: result.error || (result.success ? '领取成功' : '领取失败') };
    } catch (error) {
      return { success: false, message: error instanceof Error ? error.message : '领取失败' };
    }
  }

  /** 提交内容包 */
  async submit(
    taskId: string,
    contentPack: ContentPack,
    description?: string,
  ): Promise<{ success: boolean; message: string; data?: any }> {
    try {
      const token = await getToken();
      const response = await fetch(`${API_BASE}/${taskId}/submit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ contentPack, description }),
      });
      const result = await response.json();
      return {
        success: !!result.success,
        message: result.error || (result.success ? '提交成功' : '提交失败'),
        data: result.data,
      };
    } catch (error) {
      return { success: false, message: error instanceof Error ? error.message : '提交失败' };
    }
  }

  /**
   * 按 slot 读取游戏已合并的扩展数据（P2 游戏读取侧按 slot 消费）
   * 读 published_games[gameId][slot] 数组（如 levels = 基础关卡 + 任务合并的新关卡）。
   * 走公开详情接口（跨浏览器匿名可读，无需 JWT）。
   */
  async getSlotData(slot: string): Promise<any[]> {
    try {
      const gameId = (this.game as any).getConfig().gameId;
      const res = await fetch(`${getApiBase()}/${encodeURIComponent(gameId)}`);
      if (!res.ok) return [];
      const json = await res.json();
      const doc = json?.data || {};
      const arr = Array.isArray(doc[slot]) ? doc[slot] : [];
      // 供游戏侧核对实际挂载点
      if (this.game.debug) console.log(`[QuestAPI] slot "${slot}" -> ${arr.length} 条`);
      return arr;
    } catch (error) {
      console.warn('[QuestAPI] getSlotData 失败:', error);
      return [];
    }
  }

  /** 获取该游戏已合并的全部扩展入口记录（questExtensions，P1 写入） */
  async getExtensions(): Promise<QuestExtensionRecord[]> {
    try {
      const gameId = (this.game as any).getConfig().gameId;
      const res = await fetch(`${getApiBase()}/${encodeURIComponent(gameId)}`);
      if (!res.ok) return [];
      const json = await res.json();
      const doc = json?.data || {};
      return Array.isArray(doc.questExtensions) ? doc.questExtensions : [];
    } catch (error) {
      console.warn('[QuestAPI] getExtensions 失败:', error);
      return [];
    }
  }

  // ==================== 私有方法 ====================

  private async loadQuests(): Promise<void> {
    try {
      const gameId = (this.game as any).getConfig().gameId;
      const response = await fetch(`${API_BASE}?gameId=${encodeURIComponent(gameId)}`);
      const result = await response.json();
      if (result.success && Array.isArray(result.data)) {
        this.quests.clear();
        result.data.forEach((q: GameQuest) => {
          this.quests.set(q.id, q);
        });
      }
    } catch (error) {
      console.warn('Failed to load quests:', error);
    }
  }
}
