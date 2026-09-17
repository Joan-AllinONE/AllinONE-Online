/**
 * AllinONE OpenGames Protocol - 协议引擎
 *
 * 平台端的协议处理核心，职责：
 * 1. 建立与管理游戏协议通道
 * 2. 统一处理来自游戏的 postMessage 消息
 * 3. 将协议消息路由到对应的 Skills 系统
 * 4. 通过 SchemaRegistry 处理扩展内容
 * 5. 支持双模式：注入适配 (Mode A) / 标准集成 (Mode B)
 *
 * 连接点：
 * - Skills 系统: 通过 SkillGateway 路由协议动作
 * - Voucher 系统: 生成扩展凭证
 * - SchemaRegistry: 模式匹配与数据适配
 * - postMessage: 协议传输层
 */

import {
  type ProtocolMode,
  type GameToPlatformMessage,
  type PlatformToGameMessage,
  type GameProtocolConfig,
  type ProtocolChannelState,
  type ExtensionVoucherPayload,
  type RedeemResultData,
  PROTOCOL_VERSION,
  ProtocolEvents,
  createInitMessage,
} from './ProtocolChannel';
import { SchemaRegistry, getDefaultRegistry } from './SchemaRegistry';
import type { SkillGatewayInterface, SkillContext } from '@/skills/types';

// ==================== 类型定义 ====================

export interface ProtocolEngineConfig {
  /** Schema 注册中心 */
  schemaRegistry?: SchemaRegistry;
  /** Skills 网关 */
  skillGateway?: SkillGatewayInterface;
  /** 协议调试 */
  debug?: boolean;
  /** 认证上下文提供器 */
  authContextProvider?: () => SkillContext | Promise<SkillContext>;
  /** 兑换回调 */
  onRedeem?: (code: string, gameId: string) => Promise<RedeemResultData>;
}

interface GameChannel {
  state: ProtocolChannelState;
  source: MessagePort | Window;
}

// ==================== ProtocolEngine 类 ====================

export class ProtocolEngine {
  private channels: Map<string, GameChannel> = new Map();
  private schemaRegistry: SchemaRegistry;
  private skillGateway?: SkillGatewayInterface;
  private config: ProtocolEngineConfig;
  private messageHandler: ((event: MessageEvent) => void) | null = null;
  private listeners: Map<string, Set<(...args: any[]) => void>> = new Map();

  constructor(config: ProtocolEngineConfig = {}) {
    this.config = {
      debug: false,
      schemaRegistry: config.schemaRegistry || getDefaultRegistry(),
      ...config,
    };
    this.schemaRegistry = this.config.schemaRegistry!;
    this.skillGateway = this.config.skillGateway;
  }

  // ==================== 通道管理 ====================

  /**
   * 建立游戏协议通道
   * 在游戏 iframe 加载完成后调用
   */
  async establishChannel(
    gameId: string,
    iframe: HTMLIFrameElement,
    options?: {
      mode?: ProtocolMode;
      supportedActions?: string[];
      supportedSchemas?: string[];
      skills?: string[];
    }
  ): Promise<void> {
    const mode = options?.mode || 'inject';
    const config: GameProtocolConfig = {
      mode,
      gameId,
      supportedActions: options?.supportedActions || [],
      supportedSchemas: options?.supportedSchemas || [],
      skills: options?.skills || [],
      params: {
        timeout: 30000,
        heartbeat: 5000,
        debug: this.config.debug,
      },
    };

    // 保存通道
    const channel: GameChannel = {
      state: {
        gameId,
        mode,
        status: 'connected',
        protocolVersion: PROTOCOL_VERSION,
        supportedActions: config.supportedActions,
        supportedSchemas: config.supportedSchemas,
        connectedAt: Date.now(),
        lastHeartbeat: Date.now(),
        skills: config.skills,
      },
      source: iframe.contentWindow || iframe,
    };

    this.channels.set(gameId, channel);

    // 如果 iframe 支持 contentWindow，建立通信
    if (iframe.contentWindow) {
      this.sendMessage(channel, createInitMessage(gameId, config));
    }

    this.log(`通道已建立: ${gameId} (mode=${mode})`);
    this.emit(ProtocolEvents.READY, { gameId, mode });
  }

  /**
   * 获取通道状态
   */
  getChannelState(gameId: string): ProtocolChannelState | undefined {
    return this.channels.get(gameId)?.state;
  }

  /**
   * 获取所有活跃通道
   */
  getAllChannels(): ProtocolChannelState[] {
    return Array.from(this.channels.values()).map(c => ({ ...c.state }));
  }

  /**
   * 断开游戏通道
   */
  disconnect(gameId: string): void {
    this.channels.delete(gameId);
    this.emit(ProtocolEvents.DISCONNECTED, { gameId });
    this.log(`通道已断开: ${gameId}`);
  }

  /**
   * 启动全局消息监听（需要在 window 上注册）
   */
  startListening(): void {
    if (this.messageHandler) return;

    this.messageHandler = (event: MessageEvent) => {
      this.handleIncomingMessage(event);
    };

    window.addEventListener('message', this.messageHandler);
    this.log('协议引擎已开始监听消息');
  }

  /**
   * 停止全局消息监听
   */
  stopListening(): void {
    if (this.messageHandler) {
      window.removeEventListener('message', this.messageHandler);
      this.messageHandler = null;
      this.log('协议引擎已停止监听');
    }
  }

  // ==================== 消息处理 ====================

  /**
   * 处理从游戏 iframe 发来的上行消息
   */
  private async handleIncomingMessage(event: MessageEvent): Promise<void> {
    const message = event.data as GameToPlatformMessage;
    if (!message || !message.type) return;

    // 找到匹配的游戏通道（通过 event.source 或消息内容中的 gameId）
    let channel: GameChannel | undefined;
    if ('gameId' in message && message.gameId) {
      channel = this.channels.get(message.gameId);
    } else {
      // 通过 source 匹配
      for (const [id, ch] of this.channels) {
        if (ch.source === event.source) {
          channel = ch;
          break;
        }
      }
    }

    // 对 PROTOCOL:READY 消息，即使未找到通道也允许处理
    if (!channel && message.type !== 'PROTOCOL:READY') {
      return;
    }

    // 更新心跳
    if (channel) {
      channel.state.lastHeartbeat = Date.now();
    }

    // 统一处理消息
    try {
      switch (message.type) {
        case 'PROTOCOL:READY':
          await this.handleReady(message, event);
          break;
        case 'PROTOCOL:ACTION_RESULT':
          this.handleActionResult(message);
          break;
        case 'PROTOCOL:SCHEMA_QUERY':
          await this.handleSchemaQuery(message, event);
          break;
        case 'GAME_EVENT':
          await this.handleGameEvent(message);
          break;
        case 'REDEEM_ITEM':
          await this.handleRedeem(message, event);
          break;
        default:
          this.log(`未知消息类型: ${(message as any).type}`);
      }
    } catch (error) {
      console.error('[ProtocolEngine] 处理消息失败:', error);
    }
  }

  /**
   * 处理协议就绪消息
   */
  private async handleReady(
    message: GameToPlatformMessage & { type: 'PROTOCOL:READY' },
    event: MessageEvent
  ): Promise<void> {
    const { gameId, mode, supportedActions, supportedSchemas } = message;

    // 注册/更新通道
    const existing = this.channels.get(gameId);
    if (existing) {
      existing.state.status = 'connected';
      existing.state.mode = mode;
      existing.state.supportedActions = supportedActions;
      existing.state.supportedSchemas = supportedSchemas;
      existing.state.lastHeartbeat = Date.now();
      existing.source = event.source as Window;
    } else {
      this.channels.set(gameId, {
        state: {
          gameId,
          mode,
          status: 'connected',
          protocolVersion: message.protocolVersion,
          supportedActions,
          supportedSchemas,
          connectedAt: Date.now(),
          lastHeartbeat: Date.now(),
          skills: [],
        },
        source: event.source as Window,
      });
    }

    // 声明游戏能力到 SchemaRegistry
    if (supportedSchemas.length > 0) {
      this.schemaRegistry.declareGameCapabilities(gameId, supportedSchemas);
    }

    this.log(`游戏就绪: ${gameId} (mode=${mode}, schemas=${supportedSchemas.length})`);
    this.emit(ProtocolEvents.READY, { gameId, mode, supportedSchemas });
  }

  /**
   * 处理动作结果
   */
  private handleActionResult(
    message: GameToPlatformMessage & { type: 'PROTOCOL:ACTION_RESULT' }
  ): void {
    this.emit(`action:${message.action}:result`, {
      success: message.success,
      data: message.data,
      error: message.error,
      requestId: message.requestId,
    });
  }

  /**
   * 处理 Schema 查询
   */
  private async handleSchemaQuery(
    message: GameToPlatformMessage & { type: 'PROTOCOL:SCHEMA_QUERY' },
    event: MessageEvent
  ): Promise<void> {
    const { schemaName, requestId } = message;
    const schema = this.schemaRegistry.getSchema(schemaName);

    const response: PlatformToGameMessage = {
      type: 'PROTOCOL:SCHEMA_RESPONSE',
      schemaName,
      schema: schema || {
        name: schemaName,
        version: '1.0.0',
        description: '',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
      },
      requestId,
      timestamp: Date.now(),
    };

    event.source?.postMessage(response, { targetOrigin: '*' } as any);
  }

  /**
   * 处理游戏事件
   */
  private async handleGameEvent(
    message: GameToPlatformMessage & { type: 'GAME_EVENT' }
  ): Promise<void> {
    const { event, data } = message;

    // 通过事件系统触发
    this.emit(ProtocolEvents.GAME_EVENT, { event, data });
  }

  /**
   * 处理兑换请求
   */
  private async handleRedeem(
    message: GameToPlatformMessage & { type: 'REDEEM_ITEM' },
    event: MessageEvent
  ): Promise<void> {
    const { code, gameId } = message.data;

    if (this.config.onRedeem) {
      try {
        const result = await this.config.onRedeem(code, gameId);
        const response: PlatformToGameMessage = {
          type: 'REDEEM_RESULT',
          data: result,
          timestamp: Date.now(),
        };
        event.source?.postMessage(response, { targetOrigin: '*' } as any);

        if (result.success) {
          this.emit(ProtocolEvents.REDEEM_SUCCESS, { code, gameId, result });
        }
      } catch (error) {
        const response: PlatformToGameMessage = {
          type: 'REDEEM_RESULT',
          data: {
            success: false,
            message: error instanceof Error ? error.message : '兑换处理失败',
          },
          timestamp: Date.now(),
        };
        event.source?.postMessage(response, { targetOrigin: '*' } as any);
      }
    }
  }

  // ==================== 平台 → 游戏 ====================

  /**
   * 向指定游戏发送协议消息
   */
  sendToGame(gameId: string, message: PlatformToGameMessage): boolean {
    const channel = this.channels.get(gameId);
    if (!channel) {
      console.warn(`[ProtocolEngine] 游戏通道不存在: ${gameId}`);
      return false;
    }
    return this.sendMessage(channel, message);
  }

  /**
   * 发送扩展凭证到游戏
   */
  async issueVoucher(
    gameId: string,
    voucher: ExtensionVoucherPayload
  ): Promise<boolean> {
    this.emit(ProtocolEvents.VOUCHER_ISSUED, { gameId, voucher });
    return this.sendToGame(gameId, {
      type: 'EXTENSION_VOUCHER',
      voucher,
      timestamp: Date.now(),
    });
  }

  /**
   * 执行协议动作
   * 向游戏发送执行指令，等待结果
   */
  async executeAction(
    gameId: string,
    action: string,
    params: any,
    timeout: number = 10000
  ): Promise<{ success: boolean; data?: any; error?: string }> {
    const requestId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    const sent = this.sendToGame(gameId, {
      type: 'PROTOCOL:EXECUTE',
      action,
      params,
      requestId,
      timestamp: Date.now(),
    });

    if (!sent) {
      return { success: false, error: '游戏通道不可用' };
    }

    // 等待结果或超时
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.off(`action:${action}:result`, handler);
        resolve({ success: false, error: '超时' });
      }, timeout);

      const handler = (result: any) => {
        clearTimeout(timer);
        this.off(`action:${action}:result`, handler);
        resolve(result);
      };

      this.on(`action:${action}:result`, handler);
    });
  }

  // ==================== 事件系统 ====================

  on(event: string, handler: (...args: any[]) => void): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(handler);
  }

  off(event: string, handler: (...args: any[]) => void): void {
    this.listeners.get(event)?.delete(handler);
  }

  private emit(event: string, ...args: any[]): void {
    this.listeners.get(event)?.forEach(handler => {
      try {
        handler(...args);
      } catch (error) {
        console.error(`[ProtocolEngine] 事件处理错误 (${event}):`, error);
      }
    });
  }

  // ==================== 工具方法 ====================

  private sendMessage(channel: GameChannel, message: PlatformToGameMessage): boolean {
    try {
      if ('postMessage' in channel.source) {
        channel.source.postMessage(message, { targetOrigin: '*' } as any);
        return true;
      }
    } catch (error) {
      console.error('[ProtocolEngine] 发送消息失败:', error);
    }
    return false;
  }

  private log(...args: any[]): void {
    if (this.config.debug) {
      console.log('[ProtocolEngine]', ...args);
    }
  }

  /**
   * 🆕 单例配置补挂：getDefaultEngine() 首次创建后 config 固定，
   * GamePlay 等宿主后续传入的 onRedeem/skillGateway 等回调需要补挂到
   * 已存在的单例上（模块级 protocolEngine = getDefaultEngine() 会在
   * import 时就创建无配置单例，首参 config 会被忽略）。
   */
  ensureConfig(config: ProtocolEngineConfig): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * 🆕 仅释放指定游戏的通道（单例模式下宿主组件卸载时使用；
   * 绝不能调用 destroy() —— 那会清空全局 channels/listeners，
   * 且 defaultEngine 仍指向该实例，后续拿到的是空壳引擎）。
   */
  releaseChannel(gameId: string): void {
    this.channels.delete(gameId);
  }

  /**
   * 销毁引擎
   */
  destroy(): void {
    this.stopListening();
    this.channels.clear();
    this.listeners.clear();
  }
}

// ==================== 单例导出 ====================

let defaultEngine: ProtocolEngine | null = null;

export function getDefaultEngine(config?: ProtocolEngineConfig): ProtocolEngine {
  if (!defaultEngine) {
    defaultEngine = new ProtocolEngine(config);
  }
  return defaultEngine;
}

export function resetDefaultEngine(): void {
  defaultEngine?.destroy();
  defaultEngine = null;
}

export const protocolEngine = getDefaultEngine();
