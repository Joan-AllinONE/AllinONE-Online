/**
 * PublishedGameRuntime - 已发布游戏的运行时环境
 * 
 * 职责：
 * 1. 自动加载游戏配置的Skills
 * 2. 提供统一的Skill调用接口
 * 3. 管理游戏生命周期
 * 4. 处理游戏与平台的通信
 */

import { skillGateway } from '@/skills/index';
import { AuthSkill } from '@/skills/auth/AuthSkill';
import { WalletSkill } from '@/skills/wallet/WalletSkill';
import { InventorySkill } from '@/skills/inventory/InventorySkill';
import { StoreSkill } from '@/skills/store/StoreSkill';
import type { Skill, SkillContext } from '@/skills/types';
import type { PublishedGame } from '@/services/publishedGameService';

export interface RuntimeConfig {
  gameId: string;
  userId?: string;
  authToken?: string;
  debug?: boolean;
}

export interface RuntimeState {
  isReady: boolean;
  isAuthenticated: boolean;
  initializedSkills: string[];
  currentUser: RuntimeUser | null;
}

export interface RuntimeUser {
  userId: string;
  username: string;
  avatar?: string;
  level?: number;
  isGuest: boolean;
}

export interface GameAPI {
  // 认证相关
  auth: {
    login: (credentials?: any) => Promise<RuntimeUser>;
    logout: () => Promise<void>;
    getCurrentUser: () => RuntimeUser | null;
    isAuthenticated: () => boolean;
  };
  
  // 钱包相关
  wallet: {
    getBalance: () => Promise<Record<string, number>>;
    getTransactions: (limit?: number) => Promise<any[]>;
    spend: (currency: string, amount: number, reason?: string) => Promise<boolean>;
    earn: (currency: string, amount: number, reason?: string) => Promise<boolean>;
    transfer: (toUserId: string, currency: string, amount: number) => Promise<boolean>;
  };
  
  // 库存相关
  inventory: {
    getItems: () => Promise<any[]>;
    addItem: (item: any) => Promise<boolean>;
    removeItem: (itemId: string, quantity?: number) => Promise<boolean>;
    useItem: (itemId: string) => Promise<any>;
    hasItem: (itemId: string) => Promise<boolean>;
  };
  
  // 商店相关
  store: {
    getProducts: () => Promise<any[]>;
    purchase: (productId: string, quantity?: number) => Promise<any>;
    getPurchaseHistory: () => Promise<any[]>;
  };
  
  // 通用Skill调用
  callSkill: (skillName: string, action: string, params?: any) => Promise<any>;
  
  // 事件监听
  on: (event: string, handler: (data: any) => void) => void;
  off: (event: string, handler: (data: any) => void) => void;
  
  // 状态
  getState: () => RuntimeState;
}

/**
 * 已发布游戏运行时类
 */
export class PublishedGameRuntime {
  private gameId: string;
  private config: RuntimeConfig;
  private state: RuntimeState;
  private eventHandlers: Map<string, Set<(data: any) => void>> = new Map();
  private debug: boolean;

  constructor(config: RuntimeConfig) {
    this.gameId = config.gameId;
    this.config = config;
    this.debug = config.debug || false;
    this.state = {
      isReady: false,
      isAuthenticated: false,
      initializedSkills: [],
      currentUser: null,
    };

    this.log('PublishedGameRuntime 创建', config);
  }

  /**
   * 初始化运行时
   */
  async initialize(publishedGame?: PublishedGame): Promise<void> {
    this.log('开始初始化运行时...');

    try {
      // 1. 加载游戏配置
      const gameConfig = publishedGame || await this.loadGameConfig();
      
      // 2. 初始化已配置的Skills
      if (gameConfig.skills) {
        await this.initializeSkills(gameConfig.skills);
      }

      // 3. 如果有token，自动登录
      if (this.config.authToken) {
        await this.autoLogin();
      }

      // 4. 标记为就绪
      this.state.isReady = true;
      this.emit('runtime:ready', { gameId: this.gameId });

      this.log('运行时初始化完成');
    } catch (error) {
      this.error('运行时初始化失败:', error);
      throw error;
    }
  }

  /**
   * 加载游戏配置
   */
  private async loadGameConfig(): Promise<PublishedGame> {
    // 从localStorage或服务加载
    const { getPublishedGame } = await import('@/services/publishedGameService');
    const game = getPublishedGame(this.gameId);
    
    if (!game) {
      throw new Error(`游戏 ${this.gameId} 未找到`);
    }

    return game;
  }

  /**
   * 初始化Skills
   */
  private async initializeSkills(skillIds: string[]): Promise<void> {
    this.log('初始化Skills:', skillIds);

    for (const skillId of skillIds) {
      try {
        // 检查Skill是否已在网关注册
        const skill = skillGateway.getSkill(skillId);
        
        if (skill) {
          this.state.initializedSkills.push(skillId);
          this.log(`✓ Skill "${skillId}" 已就绪`);
        } else {
          // 尝试动态创建并注册Skill
          await this.createAndRegisterSkill(skillId);
        }
      } catch (error) {
        this.error(`✗ Skill "${skillId}" 初始化失败:`, error);
      }
    }
  }

  /**
   * 创建并注册Skill
   */
  private async createAndRegisterSkill(skillId: string): Promise<void> {
    const factories: Record<string, any> = {
      auth: AuthSkill,
      wallet: WalletSkill,
      inventory: InventorySkill,
      store: StoreSkill,
    };

    const SkillClass = factories[skillId];
    if (!SkillClass) {
      this.warn(`Skill "${skillId}" 尚未实现，跳过`);
      return;
    }

    const config = { gameId: this.gameId };
    const skill = new SkillClass(config);
    await skillGateway.registerSkill(skill, config);
    
    this.state.initializedSkills.push(skillId);
    this.log(`✓ Skill "${skillId}" 动态注册成功`);
  }

  /**
   * 自动登录
   */
  private async autoLogin(): Promise<void> {
    try {
      const result = await skillGateway.execute(
        'auth',
        'validateToken',
        { token: this.config.authToken },
        { gameId: this.gameId }
      );

      if (result.success && result.data) {
        this.state.isAuthenticated = true;
        this.state.currentUser = {
          userId: result.data.userId,
          username: result.data.username || 'Player',
          avatar: result.data.avatar,
          isGuest: result.data.isGuest || false,
        };
        this.log('自动登录成功');
      }
    } catch (error) {
      this.warn('自动登录失败:', error);
    }
  }

  /**
   * 获取游戏API - 这是游戏开发者的主要接口
   */
  getAPI(): GameAPI {
    return {
      // 认证API
      auth: {
        login: async (credentials?: any) => {
          const result = await skillGateway.execute(
            'auth',
            'login',
            credentials || { anonymous: true },
            { gameId: this.gameId }
          );

          if (result.success && result.data) {
            this.state.isAuthenticated = true;
            this.state.currentUser = {
              userId: result.data.user.userId,
              username: result.data.user.username,
              avatar: result.data.user.avatar,
              isGuest: result.data.user.isGuest,
            };
            this.emit('auth:login', this.state.currentUser);
          }

          return this.state.currentUser!;
        },

        logout: async () => {
          await skillGateway.execute('auth', 'logout', {}, { gameId: this.gameId });
          this.state.isAuthenticated = false;
          this.state.currentUser = null;
          this.emit('auth:logout', {});
        },

        getCurrentUser: () => this.state.currentUser,
        isAuthenticated: () => this.state.isAuthenticated,
      },

      // 钱包API
      wallet: {
        getBalance: async () => {
          const result = await skillGateway.execute(
            'wallet',
            'getBalance',
            {},
            { gameId: this.gameId, userId: this.state.currentUser?.userId }
          );
          return result.success ? result.data : {};
        },

        getTransactions: async (limit = 10) => {
          const result = await skillGateway.execute(
            'wallet',
            'getTransactions',
            { limit },
            { gameId: this.gameId, userId: this.state.currentUser?.userId }
          );
          return result.success ? result.data?.transactions || [] : [];
        },

        spend: async (currency: string, amount: number, reason?: string) => {
          const result = await skillGateway.execute(
            'wallet',
            'spend',
            { currency, amount, reason },
            { gameId: this.gameId, userId: this.state.currentUser?.userId }
          );
          
          if (result.success) {
            this.emit('wallet:spend', { currency, amount, reason });
          }
          
          return result.success;
        },

        earn: async (currency: string, amount: number, reason?: string) => {
          const result = await skillGateway.execute(
            'wallet',
            'reward',
            { [currency]: amount, reason },
            { gameId: this.gameId, userId: this.state.currentUser?.userId }
          );
          
          if (result.success) {
            this.emit('wallet:earn', { currency, amount, reason });
          }
          
          return result.success;
        },

        transfer: async (toUserId: string, currency: string, amount: number) => {
          const result = await skillGateway.execute(
            'wallet',
            'transfer',
            { toUserId, currency, amount },
            { gameId: this.gameId, userId: this.state.currentUser?.userId }
          );
          return result.success;
        },
      },

      // 库存API
      inventory: {
        getItems: async () => {
          const result = await skillGateway.execute(
            'inventory',
            'getItems',
            {},
            { gameId: this.gameId, userId: this.state.currentUser?.userId }
          );
          return result.success ? result.data?.items || [] : [];
        },

        addItem: async (item: any) => {
          const result = await skillGateway.execute(
            'inventory',
            'addItem',
            item,
            { gameId: this.gameId, userId: this.state.currentUser?.userId }
          );
          
          if (result.success) {
            this.emit('inventory:add', item);
          }
          
          return result.success;
        },

        removeItem: async (itemId: string, quantity = 1) => {
          const result = await skillGateway.execute(
            'inventory',
            'removeItem',
            { itemId, quantity },
            { gameId: this.gameId, userId: this.state.currentUser?.userId }
          );
          
          if (result.success) {
            this.emit('inventory:remove', { itemId, quantity });
          }
          
          return result.success;
        },

        useItem: async (itemId: string) => {
          const result = await skillGateway.execute(
            'inventory',
            'useItem',
            { itemId },
            { gameId: this.gameId, userId: this.state.currentUser?.userId }
          );
          
          if (result.success) {
            this.emit('inventory:use', { itemId, result: result.data });
          }
          
          return result.data;
        },

        hasItem: async (itemId: string) => {
          const result = await skillGateway.execute(
            'inventory',
            'hasItem',
            { itemId },
            { gameId: this.gameId, userId: this.state.currentUser?.userId }
          );
          return result.success ? result.data?.hasItem : false;
        },
      },

      // 商店API
      store: {
        getProducts: async () => {
          const result = await skillGateway.execute(
            'store',
            'getProducts',
            {},
            { gameId: this.gameId }
          );
          return result.success ? result.data?.products || [] : [];
        },

        purchase: async (productId: string, quantity = 1) => {
          const result = await skillGateway.execute(
            'store',
            'purchase',
            { productId, quantity },
            { gameId: this.gameId, userId: this.state.currentUser?.userId }
          );
          
          if (result.success) {
            this.emit('store:purchase', { productId, quantity, result: result.data });
          }
          
          return result.data;
        },

        getPurchaseHistory: async () => {
          const result = await skillGateway.execute(
            'store',
            'getPurchaseHistory',
            {},
            { gameId: this.gameId, userId: this.state.currentUser?.userId }
          );
          return result.success ? result.data?.history || [] : [];
        },
      },

      // 通用Skill调用
      callSkill: async (skillName: string, action: string, params?: any) => {
        const result = await skillGateway.execute(
          skillName,
          action,
          params,
          { gameId: this.gameId, userId: this.state.currentUser?.userId }
        );
        
        if (!result.success) {
          throw new Error(result.error?.message || 'Skill调用失败');
        }
        
        return result.data;
      },

      // 事件监听
      on: (event: string, handler: (data: any) => void) => {
        if (!this.eventHandlers.has(event)) {
          this.eventHandlers.set(event, new Set());
        }
        this.eventHandlers.get(event)!.add(handler);
      },

      off: (event: string, handler: (data: any) => void) => {
        this.eventHandlers.get(event)?.delete(handler);
      },

      // 状态
      getState: () => ({ ...this.state }),
    };
  }

  /**
   * 发射事件
   */
  private emit(event: string, data: any): void {
    this.eventHandlers.get(event)?.forEach(handler => {
      try {
        handler(data);
      } catch (error) {
        this.error('事件处理器错误:', error);
      }
    });
  }

  /**
   * 销毁运行时
   */
  destroy(): void {
    this.log('销毁运行时...');
    this.eventHandlers.clear();
    this.state.isReady = false;
    this.emit('runtime:destroy', { gameId: this.gameId });
  }

  // 日志工具
  private log(...args: any[]): void {
    if (this.debug) {
      console.log('[PublishedGameRuntime]', ...args);
    }
  }

  private error(...args: any[]): void {
    console.error('[PublishedGameRuntime]', ...args);
  }

  private warn(...args: any[]): void {
    console.warn('[PublishedGameRuntime]', ...args);
  }
}

/**
 * 便捷函数：创建游戏运行时
 */
export async function createGameRuntime(
  gameId: string,
  config?: Omit<RuntimeConfig, 'gameId'>
): Promise<GameAPI> {
  const runtime = new PublishedGameRuntime({ gameId, ...config });
  await runtime.initialize();
  return runtime.getAPI();
}

/**
 * 便捷函数：快速启动游戏
 */
export async function launchGame(
  gameId: string,
  container?: HTMLElement
): Promise<{ runtime: PublishedGameRuntime; api: GameAPI }> {
  const runtime = new PublishedGameRuntime({ gameId, debug: true });
  await runtime.initialize();
  
  const api = runtime.getAPI();
  
  // 自动匿名登录
  if (!api.auth.isAuthenticated()) {
    await api.auth.login({ anonymous: true });
  }
  
  return { runtime, api };
}

export default PublishedGameRuntime;
