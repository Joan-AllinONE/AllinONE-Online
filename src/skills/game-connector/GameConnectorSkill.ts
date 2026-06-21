/**
 * GameConnectorSkill - 极简游戏连接器
 * 
 * 每个接入游戏只需提供兑换码核销接口。
 * 数据持久化到 CloudBase collection: game_connectors
 * 
 * @since MVP v1.0
 */

import { BaseSkill } from '../BaseSkill';
import type { SkillContext } from '../types';
import { getCloudBaseApp } from '../../services/cloudbase';

// ==================== 类型定义 ====================

export interface GameConnectorConfig {
  gameId: string;
  gameName: string;
  verifyEndpoint: string;       // POST { code: string } → { valid: boolean, itemId?: string }
  authType: 'none' | 'apiKey' | 'bearer';
  authValue?: string;
  isActive?: boolean;
  createdAt?: number;
  updatedAt?: number;
}

interface VerifyCodeResult {
  valid: boolean;
  itemId?: string;
  itemName?: string;
  quantity?: number;
}

// ==================== Skill 实现 ====================

export class GameConnectorSkill extends BaseSkill {
  private games: Map<string, GameConnectorConfig> = new Map();
  private cloudLoaded = false;

  constructor() {
    super({
      name: 'game-connector',
      version: '1.0.0',
      displayName: '游戏连接器',
      description: '管理第三方游戏的兑换码核销连接',
    });
  }

  protected async onInitialize(): Promise<void> {
    this.registerAction('registerGame', this.registerGame.bind(this), {
      description: '注册一个新的游戏连接器',
      params: {
        type: 'object',
        required: ['gameId', 'gameName', 'verifyEndpoint'],
        properties: {
          gameId: { type: 'string' },
          gameName: { type: 'string' },
          verifyEndpoint: { type: 'string' },
          authType: { type: 'string', enum: ['none', 'apiKey', 'bearer'], default: 'none' },
          authValue: { type: 'string' },
        },
      },
      returns: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          message: { type: 'string' },
        },
      },
    });

    this.registerAction('verifyCode', this.verifyCode.bind(this), {
      description: '核销第三方游戏的兑换码',
      params: {
        type: 'object',
        required: ['gameId', 'code'],
        properties: {
          gameId: { type: 'string' },
          code: { type: 'string' },
        },
      },
      returns: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          data: { type: 'object' },
          message: { type: 'string' },
        },
      },
    });

    this.registerAction('getRegisteredGames', this.getRegisteredGames.bind(this), {
      description: '获取所有已注册的游戏连接器',
      params: { type: 'object', properties: {} },
      returns: { type: 'array' },
    });

    this.registerAction('unregisterGame', this.unregisterGame.bind(this), {
      description: '注销一个游戏连接器',
      params: {
        type: 'object',
        required: ['gameId'],
        properties: {
          gameId: { type: 'string' },
        },
      },
    });

    // 尝试从 CloudBase 加载已注册的游戏连接器（延迟+可重试）
    await this.ensureLoadedFromCloud();
  }

  /** 从 CloudBase 加载数据 — 首次调用时加载，失败后允许重试 */
  private async ensureLoadedFromCloud(): Promise<void> {
    if (this.cloudLoaded) return;
    try {
      const app = getCloudBaseApp();
      const db = app.database();
      const res = await db.collection('game_connectors')
        .where({ isActive: true })
        .get();
      for (const config of res.data) {
        if (!this.games.has(config.gameId)) {
          this.games.set(config.gameId, config as GameConnectorConfig);
        }
      }
      this.cloudLoaded = true;
      console.log(`[game-connector] ✅ 加载了 ${this.games.size} 个游戏连接器`);
    } catch {
      console.warn('[game-connector] CloudBase 未就绪，将在首次操作时重试加载');
    }
  }

  // ==================== Actions ====================

  /**
   * 注册游戏连接器
   */
  async registerGame(
    params: GameConnectorConfig,
    context: SkillContext
  ): Promise<{ success: boolean; message: string }> {
    const { gameId, gameName, verifyEndpoint, authType = 'none', authValue = '' } = params;

    if (!gameId || !gameName || !verifyEndpoint) {
      return { success: false, message: '缺少必要参数：gameId, gameName, verifyEndpoint' };
    }

    const config: GameConnectorConfig = {
      gameId,
      gameName,
      verifyEndpoint,
      authType,
      authValue,
      isActive: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    // 持久化到 CloudBase
    try {
      const app = getCloudBaseApp();
      const db = app.database();

      // 检查是否已存在
      const existing = await db.collection('game_connectors')
        .where({ gameId })
        .get();

      if (existing.data.length > 0) {
        // 更新已有记录
        await db.collection('game_connectors')
          .doc(existing.data[0]._id)
          .update({
            ...config,
            _openid: context.userId,
          });
      } else {
        await db.collection('game_connectors').add({
          ...config,
          _openid: context.userId,
        });
      }
    } catch (err) {
      console.warn('[game-connector] CloudBase 写入失败，仅内存模式', err);
    }

    this.games.set(gameId, config);
    return { success: true, message: `游戏「${gameName}」已注册` };
  }

  /**
   * 核销兑换码（唯一必要接口）
   */
  async verifyCode(
    params: { gameId: string; code: string },
    context: SkillContext
  ): Promise<{ success: boolean; data?: VerifyCodeResult; message?: string }> {
    await this.ensureLoadedFromCloud();
    const { gameId, code } = params;
    const game = this.games.get(gameId);

    if (!game) {
      return { success: false, message: `游戏「${gameId}」未注册` };
    }

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      if (game.authType === 'apiKey' && game.authValue) {
        headers['X-API-Key'] = game.authValue;
      } else if (game.authType === 'bearer' && game.authValue) {
        headers['Authorization'] = `Bearer ${game.authValue}`;
      }

      const response = await fetch(game.verifyEndpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ code }),
      });

      if (!response.ok) {
        return { success: false, message: `核销失败: HTTP ${response.status}` };
      }

      const data = await response.json();
      return {
        success: true,
        data: {
          valid: data.valid ?? true,
          itemId: data.itemId,
          itemName: data.itemName,
          quantity: data.quantity || 1,
        },
      };
    } catch (error: any) {
      return { success: false, message: `核销异常: ${error.message}` };
    }
  }

  /**
   * 获取所有已注册的游戏连接器
   */
  async getRegisteredGames(
    params: any,
    context: SkillContext
  ): Promise<{ success: boolean; data: GameConnectorConfig[] }> {
    await this.ensureLoadedFromCloud();
    const games = Array.from(this.games.values());
    return { success: true, data: games };
  }

  /**
   * 注销游戏连接器
   */
  async unregisterGame(
    params: { gameId: string },
    context: SkillContext
  ): Promise<{ success: boolean; message: string }> {
    const { gameId } = params;
    const game = this.games.get(gameId);

    if (!game) {
      return { success: false, message: `游戏「${gameId}」未注册` };
    }

    // 从 CloudBase 删除
    try {
      const app = getCloudBaseApp();
      const db = app.database();
      const existing = await db.collection('game_connectors')
        .where({ gameId, isActive: true })
        .get();
      if (existing.data.length > 0) {
        await db.collection('game_connectors')
          .doc(existing.data[0]._id)
          .update({ isActive: false, updatedAt: Date.now() });
      }
    } catch {
      // 忽略 CloudBase 错误
    }

    this.games.delete(gameId);
    return { success: true, message: `游戏「${game.gameName}」已注销` };
  }
}

/** 单例导出 */
export const gameConnectorSkill = new GameConnectorSkill();
