/**
 * AllinONE OpenGames Protocol - 统一导出
 *
 * Phase 1 基础设施：
 * - ProtocolChannel: 消息类型、配置、Schema 等所有类型定义
 * - ProtocolEngine: 协议核心引擎（平台端消息路由）
 * - SchemaRegistry: 标准化接口注册中心 & 跨游戏适配
 *
 * Phase 2 AI 驱动扩展：
 * - ProtocolAIBridge: AI 意图翻译引擎（自然语言 → Schema）
 * - ExtensionVoucher: 扩展凭证系统（跨游戏内容载体）
 *
 * Phase 3 桥接层：
 * - ProtocolClient: SDK 端协议客户端（在 standard-sdk 中）
 * - InjectAdapter: 注入模式适配器（在 PublishingPipeline 中）
 */

// ==================== Phase 1 核心 ====================

export * from './ProtocolChannel';
export type { AIGuide } from './ProtocolChannel';
export { SchemaRegistry, getDefaultRegistry, resetDefaultRegistry, schemaRegistry } from './SchemaRegistry';
export {
  ProtocolEngine,
  getDefaultEngine,
  resetDefaultEngine,
  protocolEngine,
  type ProtocolEngineConfig,
} from './ProtocolEngine';

// ==================== Phase 2 AI 驱动扩展 ====================

export { ProtocolAIBridge } from './ProtocolAIBridge';
export type { PlayerIntent, AIBridgeResult, AIBridgeConfig } from './ProtocolAIBridge';
export {
  ExtensionVoucherService,
  extensionVoucherService,
  type ExtensionVoucher,
  type ExtensionVoucherStatus,
} from './ExtensionVoucher';

// ==================== Phase 3 前瞻引用（占位） ====================

// 下阶段实现，目前导出类型占位
export type { ProtocolClientConfig } from './types/ProtocolClientConfig';

// ==================== 版本信息 ====================

export const OPEN_GAMES_VERSION = '1.0.0';
export const OPEN_GAMES_NAME = 'AllinONE OpenGames Protocol';
