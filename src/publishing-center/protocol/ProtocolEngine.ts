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

/**
 * 🆕 防刷加固（B1）：channelToken 强制校验开关。
 * - false（灰度期，当前）：上行消息缺失 channelToken 仅告警放行 —— 兼容存量已发布
 *   游戏（其注入 SDK / 游戏手写 postMessage 不携带 token）；token 不匹配仍直接丢弃。
 * - true（强制期，B6 切换）：缺失 token 的上行消息一律丢弃。
 * 切换前提：已发布游戏重新发布（新注入 SDK 会透传 token）后，控制台改此常量。
 */
const CHANNEL_TOKEN_ENFORCED = false;

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
  /** 🆕 通道令牌：establishChannel 时生成，经 PROTOCOL:INIT 下发，游戏侧上行必须透传（灰度期缺失仅告警） */
  token?: string;
  /** 🆕 游戏 iframe origin（http/https src 可推导时）；下行 targetOrigin 用，推导不出回退 '*'（opaque origin 场景） */
  origin?: string;
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

    // 🆕 防刷加固（B1）：生成一次性通道令牌。游戏侧从 PROTOCOL:INIT.config.params
    // 读取并在上行消息中透传（注入 SDK 已实现透传；存量游戏不带 token → 灰度告警放行）。
    const channelToken = this.generateChannelToken();

    // 🆕 推导 iframe origin（供下行 targetOrigin 收紧；blob/srcdoc 等 opaque origin 回退 '*'）
    let iframeOrigin: string | undefined;
    try {
      if (iframe.src && /^https?:/i.test(iframe.src)) {
        iframeOrigin = new URL(iframe.src).origin;
      }
    } catch { /* keep undefined */ }

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
        channelToken,
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
      source: (iframe.contentWindow || iframe) as Window,
      token: channelToken,
      origin: iframeOrigin,
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
   *
   * 🆕 防刷加固（B1）：
   * 1. 通道匹配只信任 event.source —— 旧实现优先信任消息体 gameId，父页面控制台
   *    一行 window.postMessage({type:'GAME_EVENT', gameId:...}) 即可伪造
   *    ITEM_HARVEST 直接铸造凭证（V2 漏洞）。现在 event.source 必须是已注册
   *    通道的 iframe contentWindow，否则一律丢弃。
   * 2. PROTOCOL:READY 不再允许凭空注册通道（V3 漏洞：伪造 READY 污染能力白名单）。
   * 3. channelToken 校验：token 不匹配一律丢弃；缺失在灰度期（CHANNEL_TOKEN_ENFORCED=false）
   *    仅告警放行，B6 切强制后丢弃。
   */
  private async handleIncomingMessage(event: MessageEvent): Promise<void> {
    const message = event.data as GameToPlatformMessage;
    if (!message || !message.type) return;

    // ① 通道匹配：只认 event.source，忽略消息体中的 gameId（不可信）
    let channel: GameChannel | undefined;
    for (const [, ch] of this.channels) {
      if (ch.source === event.source) {
        channel = ch;
        break;
      }
    }
    if (!channel) {
      // 含 PROTOCOL:READY —— 未注册来源的 READY 一律丢弃，不允许凭空注册
      this.log(`丢弃未注册来源的上行消息: type=${(message as any).type}`);
      return;
    }

    // ② channelToken 校验
    if (channel.token) {
      const msgToken = (message as any).channelToken;
      if (typeof msgToken === 'string' && msgToken) {
        if (msgToken !== channel.token) {
          this.log(`丢弃 token 不匹配的上行消息: type=${(message as any).type}, gameId=${channel.state.gameId}`);
          return;
        }
      } else if (CHANNEL_TOKEN_ENFORCED) {
        this.log(`丢弃缺失 channelToken 的上行消息（强制模式）: type=${(message as any).type}`);
        return;
      } else {
        // 灰度期：存量游戏不带 token，告警放行
        console.warn(`[ProtocolEngine] 上行消息缺失 channelToken（灰度期放行，存量游戏需重新发布后 B6 切强制）: type=${(message as any).type}, gameId=${channel.state.gameId}`);
      }
    }

    // 更新心跳
    channel.state.lastHeartbeat = Date.now();

    // 统一处理消息
    try {
      switch (message.type) {
        case 'PROTOCOL:READY':
          await this.handleReady(message, channel);
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
   *
   * 🆕 防刷加固（B1）：
   * - 通道已在 establishChannel 建立，此处只更新既有通道，不再凭空注册；
   * - gameId 以通道自身的为准（不信任消息体）；
   * - 能力声明（supportedSchemas）只允许「从空设置为非空」一次，
   *   此后不允许扩大白名单（伪造 READY 无法解锁更多 schema）。
   */
  private async handleReady(
    message: GameToPlatformMessage & { type: 'PROTOCOL:READY' },
    channel: GameChannel
  ): Promise<void> {
    const { mode, supportedActions, supportedSchemas } = message;
    const gameId = channel.state.gameId;

    // 更新既有通道
    channel.state.status = 'connected';
    channel.state.mode = mode;
    if (Array.isArray(supportedActions)) {
      channel.state.supportedActions = supportedActions;
    }
    channel.state.lastHeartbeat = Date.now();

    // 能力声明：仅允许从空到非空设置一次，此后拒绝扩大
    if (Array.isArray(supportedSchemas) && supportedSchemas.length > 0) {
      const prev = channel.state.supportedSchemas || [];
      if (prev.length === 0) {
        channel.state.supportedSchemas = supportedSchemas.slice();
        this.schemaRegistry.declareGameCapabilities(gameId, supportedSchemas);
      } else {
        const added = supportedSchemas.filter(s => !prev.includes(s));
        if (added.length > 0) {
          this.log(`忽略扩大能力声明的 READY（gameId=${gameId}，被拒新增: ${added.join(', ')}）`);
        }
      }
    }

    const declaredCount = (channel.state.supportedSchemas || []).length;
    this.log(`游戏就绪: ${gameId} (mode=${mode}, schemas=${declaredCount})`);
    this.emit(ProtocolEvents.READY, { gameId, mode, supportedSchemas: channel.state.supportedSchemas });
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
        // 🆕 B1：targetOrigin 尽力收紧——http(s) iframe 用推导出的 origin；
        // blob/srcdoc 等 opaque origin 场景 postMessage 只能用 '*'。
        const targetOrigin = channel.origin || '*';
        channel.source.postMessage(message, { targetOrigin } as any);
        return true;
      }
    } catch (error) {
      console.error('[ProtocolEngine] 发送消息失败:', error);
    }
    return false;
  }

  /**
   * 🆕 生成通道令牌（B1）：128bit 随机 hex，经 PROTOCOL:INIT 下发。
   */
  private generateChannelToken(): string {
    try {
      const buf = new Uint8Array(16);
      crypto.getRandomValues(buf);
      return Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('');
    } catch {
      return `tk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}${Math.random().toString(36).slice(2, 12)}`;
    }
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
