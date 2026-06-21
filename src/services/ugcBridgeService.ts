/**
 * UGC 桥接器（UGC Bridge Service）
 *
 * 将 AI 生成的扩展凭证内容转换为道具凭证模板，打通：
 * ProtocolAIBridge → voucherItemService 的完整链路。
 *
 * 核心流程：
 * 玩家自然语言 → AI分析 → Schema数据 → ItemVoucherTemplate → 铸造/兑换
 *
 * Phase 1: 数据解耦与桥接
 */

import { ProtocolAIBridge, type PlayerIntent, type AIBridgeResult } from '@/publishing-center/protocol/ProtocolAIBridge';
import { SchemaRegistry, getDefaultRegistry } from '@/publishing-center/protocol/SchemaRegistry';
import { ExtensionVoucherService } from '@/publishing-center/protocol/ExtensionVoucher';
import { voucherItemService } from './voucherItemService';
import { ItemSupplyPolicy, VoucherSourceType } from '@/voucher-system/types';
import type { ItemVoucherTemplate } from '@/voucher-system/types';
import type { ExtensionSchema, ExtensionVoucherPayload } from '@/publishing-center/protocol/ProtocolChannel';
import type { GameItemSop } from './publishedGameService';

// ==================== 类型定义 ====================

export interface UGCIntent {
  /** 玩家自然语言描述 */
  rawInput: string;
  /** 目标游戏 ID */
  targetGameId: string;
  /** 游戏名称 */
  gameName: string;
  /** 用户 ID */
  userId: string;
  /** 用户名称 */
  userName: string;
  /** 优先 Schema（可选） */
  preferredSchema?: string;
  /** 🆕 创作等级 */
  tier?: 'preset' | 'intermediate' | 'advanced';
}

export interface UGCBridgeResult {
  success: boolean;
  /** 创建的道具模板 */
  template?: ItemVoucherTemplate;
  /** AI 生成的结构化预览数据 */
  preview?: Record<string, any>;
  /** AI 的分析过程 */
  reasoning?: string;
  /** 需要追问的问题 */
  questions?: string[];
  /** Schema 名称 */
  schemaName?: string;
  /** 错误信息 */
  error?: string;
}

// ==================== UGCBridgeService 类 ====================

export class UGCBridgeService {
  private bridge: ProtocolAIBridge;
  private schemaRegistry: SchemaRegistry;
  private debug: boolean;
  private aiInitialized: boolean = false;

  constructor(options?: { debug?: boolean }) {
    this.debug = options?.debug ?? false;
    this.schemaRegistry = getDefaultRegistry();
    this.bridge = new ProtocolAIBridge({
      schemaRegistry: this.schemaRegistry,
      debug: this.debug,
    });
  }

  /**
   * 延迟初始化 CloudBase AI 模型
   * 成功后重建 ProtocolAIBridge 实例以接入 AI，失败则保持模板回退
   *
   * 前提：用户必须已完成真实登录（非匿名），否则 AI 调用会被拒绝
   */
  private async ensureAI(): Promise<void> {
    if (this.aiInitialized) return;
    this.aiInitialized = true;

    try {
      const { isCloudBaseReady, getCloudBaseApp } = await import('./cloudbase');
      if (!isCloudBaseReady()) {
        this.log('CloudBase 未就绪，使用模板回退');
        return;
      }

      const cloudbaseApp = getCloudBaseApp();

      // 检查用户是否真实登录（匿名用户无法调用 AI）
      const auth = cloudbaseApp.auth({ persistence: 'local' });
      let isRealUser = false;
      try {
        const loginState = await auth.getLoginState();
        isRealUser = !!loginState && !loginState.user?.is_anonymous;
      } catch {
        // getLoginState 未登录时可能抛异常
      }
      if (!isRealUser) {
        this.log('用户未登录或为匿名用户，AI 不可用，使用模板回退');
        return;
      }

      const ai = cloudbaseApp.ai();
      const model = ai.createModel('cloudbase');

      // 重建 bridge，接入 AI 模型
      this.bridge = new ProtocolAIBridge({
        schemaRegistry: this.schemaRegistry,
        debug: this.debug,
        aiModel: {
          generateText: async (prompt: string, _options?: any): Promise<string> => {
            const result = await model.generateText({
              model: 'deepseek-v4-flash',
              messages: [{ role: 'user', content: prompt }],
            });
            return result.text;
          },
        },
      });

      this.log('AI 模型已接入 (cloudbase/deepseek-v4-flash)');
    } catch (error) {
      this.log('AI 模型初始化失败，将使用模板回退:', error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * 从玩家意图创建道具 — UGC 核心入口（AI 对话模式）
   */
  async createFromIntent(intent: UGCIntent): Promise<UGCBridgeResult> {
    this.log('处理 UGC 意图:', intent.rawInput);

    // 延迟初始化 AI 模型（首次调用时尝试接入 CloudBase AI）
    await this.ensureAI();

    try {
      // Step 1: AI 分析
      const playerIntent: PlayerIntent = {
        rawInput: intent.rawInput,
        targetGameId: intent.targetGameId,
        preferredSchema: intent.preferredSchema,
        tier: intent.tier,
      };

      const result: AIBridgeResult = await this.bridge.processPlayerIntent(playerIntent);

      if (!result.success) {
        return {
          success: false,
          error: result.error,
          questions: result.questions,
          reasoning: result.reasoning,
        };
      }

      // Step 2: 提取数据
      const voucherData = result.voucher!;
      const schemaName = voucherData.schemaName;
      const schema = this.schemaRegistry.getSchema(schemaName);

      return this.buildTemplateFromData(voucherData.data, schemaName, schema, intent, 'ai_generated', result.reasoning);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      this.log('UGC 创建失败:', errMsg);
      return { success: false, error: `UGC 道具创建失败: ${errMsg}` };
    }
  }

  /**
   * 🆕 从 JSON 创建道具 — 粘贴模式核心入口
   *
   * 玩家使用外部 AI 生成 JSON → 粘贴到编辑器 → 校验 → 创建模板
   */
  async createFromJSON(params: {
    gameId: string;
    gameName: string;
    userId: string;
    userName: string;
    jsonData: string;
    schemaName?: string;
    /** 🆕 创作等级（影响校验规则） */
    tier?: 'preset' | 'intermediate' | 'advanced';
  }): Promise<UGCBridgeResult> {
    this.log('处理粘贴 JSON:', params.jsonData.slice(0, 100));

    try {
      // Step 1: 解析 JSON
      let data: any;
      try {
        data = JSON.parse(params.jsonData);
      } catch {
        return { success: false, error: 'JSON 格式无效，请检查语法' };
      }

      // Step 2: 确定 Schema
      const schemaName = params.schemaName || data.schemaName || undefined;

      // 尝试自动匹配：优先根据 gameId 解析，然后根据数据字段猜测
      let resolvedSchemaName = schemaName;
      if (!resolvedSchemaName) {
        // 根据 gameId 的游戏能力解析
        const caps = this.schemaRegistry.getGameCapabilities(params.gameId);
        if (caps.length > 0) {
          resolvedSchemaName = caps[0];
        } else if (data.effect) {
          resolvedSchemaName = 'match3-powerup';
        } else if (data.damage) {
          resolvedSchemaName = 'weapon';
        } else if (data.objectives) {
          resolvedSchemaName = 'quest';
        } else if (data.items) {
          resolvedSchemaName = 'shop';
        }
      }

      if (!resolvedSchemaName) {
        return { success: false, error: '无法确定 Schema 类型，请在 JSON 中包含 effect 字段或手动指定 Schema' };
      }

      const schema = this.schemaRegistry.getSchema(resolvedSchemaName);
      if (!schema) {
        return { success: false, error: `Schema "${resolvedSchemaName}" 未注册` };
      }

      // Step 3: 校验数据（按创作等级）
      const tier = params.tier || (data.effectScript ? 'advanced' : 'intermediate');
      const validation = this.schemaRegistry.validateDataForTier(resolvedSchemaName, data, tier);
      if (!validation.valid) {
        return {
          success: false,
          error: `JSON 校验失败（${tier === 'preset' ? '初级' : tier === 'intermediate' ? '中级' : '高级'}模式）:\n${validation.errors.map(e => `  - ${e}`).join('\n')}`,
        };
      }

      return this.buildTemplateFromData(data, resolvedSchemaName, schema, params, 'paste_json', '玩家粘贴的 JSON 数据');
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      this.log('JSON 创建失败:', errMsg);
      return { success: false, error: `道具创建失败: ${errMsg}` };
    }
  }

  /**
   * 从结构化数据构建 ItemVoucherTemplate（AI 和粘贴模式共用）
   */
  private buildTemplateFromData(
    data: any,
    schemaName: string,
    schema: ExtensionSchema | undefined,
    params: { gameId: string; gameName: string; userId: string; userName: string },
    source: string,
    reasoning?: string,
  ): UGCBridgeResult {
    const price = this.estimatePrice(data, schema);
    const rarity = this.inferRarity(data, schema);
    const itemName = this.extractName(data, schema);

    const template = voucherItemService.createItemTemplate({
      gameId: params.gameId,
      gameName: params.gameName,
      name: itemName,
      description: `玩家 ${params.userName} 创作：${(data.description || data.name || '自定义道具').slice(0, 100)}`,
      itemType: this.inferItemType(schemaName),
      icon: 'fa-cube',
      supplyPolicy: ItemSupplyPolicy.OPEN,
      pricing: {
        price,
        currency: 'ACOIN',
        acceptVoucher: true,
        voucherPrice: price,
      },
      gameEffect: {
        schemaName,
        schemaVersion: schema?.version,
        itemData: data,
        quantity: 1,
      },
      rarity,
      consumable: true,
      stackable: true,
      isActive: true,
      createdBy: params.userId,
      source,
    });

    this.log('UGC 道具模板已创建:', template.id, 'name:', itemName);

    return {
      success: true,
      template,
      preview: data,
      reasoning,
      schemaName,
    };
  }

  /**
   * 🆕 将 UGC 道具兑换下发到游戏
   *
   * 先调用 voucherItemService.redeemItemVoucherBySchema，
   * 将道具数据通过 ProtocolEngine 下发到游戏 iframe。
   */
  async redeemToGame(params: {
    userId: string;
    userName: string;
    voucherId: string;
    gameId: string;
  }): Promise<{ success: boolean; message: string; dispatchedToGame?: boolean }> {
    const result = await (voucherItemService as any).redeemItemVoucherBySchema?.(params);

    if (!result) {
      return {
        success: false,
        message: 'Schema 模式兑换未启用，请检查 voucherItemService.redeemItemVoucherBySchema',
      };
    }

    return result;
  }

  /**
   * 获取 AI 桥梁实例（供 UI 组件复用）
   */
  getBridge(): ProtocolAIBridge {
    return this.bridge;
  }

  // ==================== 辅助方法 ====================

  /**
   * 基于内容和 Schema 估算价格
   */
  private estimatePrice(data: Record<string, any>, schema?: ExtensionSchema): number {
    let basePrice = 50;

    // 根据 Schema 类型调整基础价
    if (schema?.name === 'match3-powerup') {
      // Match3 道具基于效果类型定价
      const effectPricing: Record<string, number> = {
        remove_area: 50, remove_row: 80, remove_col: 80,
        remove_color: 120, add_time: 60, add_moves: 70,
        replace_color: 100, shuffle: 40,
      };
      basePrice = effectPricing[data.effect] || 50;
      // 半径越大越贵
      if (data.params?.radius) basePrice += data.params.radius * 20;
      // 加时间/步数越多越贵
      if (data.params?.seconds) basePrice += data.params.seconds * 2;
      if (data.params?.count) basePrice += data.params.count * 10;
      return Math.round(basePrice / 10) * 10;
    }

    if (schema?.name === 'weapon') basePrice = 100;
    else if (schema?.name === 'shop') basePrice = 300;
    else if (schema?.name === 'quest') basePrice = 200;

    // 根据伤害值调整
    if (typeof data.damage === 'number') {
      const dmg = data.damage;
      if (dmg > 300) basePrice += 200;
      else if (dmg > 150) basePrice += 100;
      else if (dmg > 50) basePrice += 50;
    }

    // 根据元素稀有度
    const rareElements = ['光', '暗', '雷'];
    if (typeof data.element === 'string' && rareElements.includes(data.element)) {
      basePrice += 50;
    }

    // 根据配方复杂度
    if (Array.isArray(data.recipe) && data.recipe.length > 2) {
      basePrice += 30 * data.recipe.length;
    }

    // 根据效果数量
    if (Array.isArray(data.effects) && data.effects.length > 0) {
      basePrice += 40 * data.effects.length;
    }

    return Math.round(basePrice / 10) * 10;
  }

  /**
   * 基于数据推断稀有度
   */
  private inferRarity(data: Record<string, any>, schema?: ExtensionSchema): string {
    let score = 0;

    // Match3 道具稀有度基于效果
    if (schema?.name === 'match3-powerup') {
      const effectRarity: Record<string, number> = {
        remove_area: 1, remove_row: 1, remove_col: 1,
        remove_color: 2, add_time: 1, add_moves: 1,
        replace_color: 2, shuffle: 1,
      };
      score += effectRarity[data.effect] || 0;
      if (data.params?.radius && data.params.radius >= 3) score += 2;
      if (data.params?.seconds && data.params.seconds >= 25) score += 1;
      if (data.params?.count && data.params.count >= 4) score += 1;
      if (score >= 4) return 'legendary';
      if (score >= 3) return 'rare';
      if (score >= 1) return 'uncommon';
      return 'common';
    }

    // 通用：伤害值
    if (typeof data.damage === 'number') {
      if (data.damage > 300) score += 3;
      else if (data.damage > 150) score += 2;
      else if (data.damage > 50) score += 1;
    }

    // 稀有元素
    const rareElements = ['光', '暗', '雷'];
    if (typeof data.element === 'string' && rareElements.includes(data.element)) {
      score += 1;
    }

    // 复杂配方
    if (Array.isArray(data.recipe) && data.recipe.length > 2) {
      score += 1;
    }

    // 效果
    if (Array.isArray(data.effects)) {
      if (data.effects.length >= 2) score += 2;
      else if (data.effects.length >= 1) score += 1;
    }

    if (score >= 5) return 'legendary';
    if (score >= 3) return 'rare';
    if (score >= 1) return 'uncommon';
    return 'common';
  }

  /**
   * 从数据中提取道具名称
   */
  private extractName(data: Record<string, any>, schema?: ExtensionSchema): string {
    // 优先使用数据中的 name 字段
    if (data.name && typeof data.name === 'string') return data.name;
    if (data.title && typeof data.title === 'string') return data.title;

    // 回退到示例数据的名称
    const example = schema?.examples?.[0];
    if (example?.name) return example.name;
    if (example?.title) return example.title;

    return '未知道具';
  }

  /**
   * 根据 Schema 名称推断道具类型
   */
  private inferItemType(schemaName: string): string {
    const typeMap: Record<string, string> = {
      weapon: 'permanent',
      armor: 'permanent',
      shop: 'currency',
      quest: 'consumable',
      consumable: 'consumable',
    };
    return typeMap[schemaName] || 'consumable';
  }

  /**
   * 获取游戏的可用 Schema 列表（含 AI Guide 基本信息）
   * v2: 自动注册游戏专用 Schema
   */
  getAvailableSchemas(gameId: string): Array<{
    name: string;
    description: string;
    aiGuide?: ExtensionSchema['aiGuide'];
  }> {
    // 自动注册游戏专用 Schema
    this.schemaRegistry.autoRegisterGameSchemas(gameId);

    const capabilities = this.schemaRegistry.getGameCapabilities(gameId);
    const schemas: Array<{ name: string; description: string; aiGuide?: ExtensionSchema['aiGuide'] }> = [];

    if (capabilities.length > 0) {
      for (const name of capabilities) {
        const schema = this.schemaRegistry.getSchema(name);
        if (schema) {
          schemas.push({
            name: schema.name,
            description: schema.description,
            aiGuide: schema.aiGuide,
          });
        }
      }
    }
    // 无声明时返回空数组（不再回退到全部内置 Schema）
    // 游戏方未设置 SOP 时，道具工坊将仅显示高级模式

    return schemas;
  }

  /**
   * 🆕 生成游戏的 SOP Markdown 文档
   * 玩家可复制给外部 AI 使用
   */
  generateSOPMarkdown(gameId: string): string {
    // 自动注册游戏专用 Schema
    this.schemaRegistry.autoRegisterGameSchemas(gameId);

    const capabilities = this.schemaRegistry.getGameCapabilities(gameId);

    // 优先查找用户上传的原始 SOP Markdown（遍历所有关联 Schema）
    if (capabilities.length > 0) {
      for (const name of capabilities) {
        const schema = this.schemaRegistry.getSchema(name);
        if (schema?.aiGuide?.rawMarkdown) {
          return schema.aiGuide.rawMarkdown;
        }
      }
    }

    // 回退：从 Schema 自动生成
    const parts: string[] = [];
    const schemaNames = capabilities.length > 0
      ? capabilities
      : this.schemaRegistry.getAllSchemas().map(s => s.name);

    for (const name of schemaNames) {
      const md = this.schemaRegistry.generateSOPMarkdown(name);
      if (md) parts.push(md);
    }

    return parts.join('\n---\n\n');
  }

  /**
   * 🆕 从 GameItemSop 动态注册 Schema
   * 游戏方发布时定义的 SOP，在道具工坊选游戏时调用
   */
  registerGameSop(gameId: string, sop: GameItemSop): void {
    try {
      // 检查是否已注册同名 Schema
      const existingSchema = this.schemaRegistry.getSchema(sop.schemaName);
      if (existingSchema) {
        this.log(`Schema ${sop.schemaName} 已存在，更新游戏能力声明`);
        // 即使 Schema 已存在，也必须声明该游戏的能力关联，否则道具工坊无法读取
        this.schemaRegistry.declareGameCapabilities(gameId, [sop.schemaName]);

        // 如果游戏提供了自定义 SOP，用游戏的数据覆盖 creationTiers（游戏自定义优先于内置）
        if (sop.presetItems && sop.presetItems.length > 0) {
          existingSchema.aiGuide = {
            ...existingSchema.aiGuide,
            prompt: sop.aiPrompt || existingSchema.aiGuide?.prompt || '',
            availableEffects: sop.availableEffects,
            effectRules: sop.effectRules,
            constraints: sop.constraints,
            forbidden: sop.forbidden,
            rawMarkdown: sop.sopMarkdownRaw || existingSchema.aiGuide?.rawMarkdown,
            creationTiers: {
              preset: { items: sop.presetItems || [] },
              intermediate: {
                availableEffects: sop.availableEffects,
                maxCompositionDepth: 3,
                maxEffectsPerComposition: 5,
              },
              advanced: {
                effectScriptEnabled: true,
                customEffectAllowed: true,
                effectCodeEnabled: sop.effectCodeEnabled,
                allowedOperators: ['sequence', 'parallel', 'chain'],
                maxScriptDepth: 5,
              },
            },
          };
          this.log(`已用游戏自定义 SOP 更新内置 Schema: ${sop.schemaName}`);
        } else if (sop.sopMarkdownRaw) {
          // 即使无 presetItems，也存储用户上传的原始 SOP 文档
          if (existingSchema.aiGuide) {
            existingSchema.aiGuide.rawMarkdown = sop.sopMarkdownRaw;
          }
        }
        return;
      }

      // 构建 inputSchema properties
      const inputProps: Record<string, any> = {
        name: { type: 'string', description: '道具名称' },
        effect: { type: 'string', description: '效果类型' },
        params: {
          type: 'object',
          properties: sop.paramFields?.reduce((acc: Record<string, any>, f) => {
            acc[f.name] = { type: f.type, description: f.description, ...(f.constraints ? { constraints: f.constraints } : {}) };
            return acc;
          }, {} as Record<string, any>) || {},
        },
        description: { type: 'string', description: '道具描述' },
        icon: { type: 'string', description: '道具图标' },
      };
      if (sop.effectCodeEnabled) {
        inputProps.effectCode = {
          type: 'string',
          description: '自定义效果函数体（仅高级模式）',
        };
      }
      inputProps.effectScript = {
        type: 'object',
        description: '效果组合脚本（中级/高级模式）',
      };

      const schema: ExtensionSchema = {
        name: sop.schemaName,
        version: '1.0.0',
        description: sop.description || `${gameId} 游戏道具`,
        inputSchema: {
          type: 'object',
          properties: inputProps,
          required: ['name'],
        },
        outputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string' }, name: { type: 'string' }, effect: { type: 'string' },
            params: { type: 'object' }, description: { type: 'string' }, icon: { type: 'string' },
            effectScript: { type: 'object' }, effectCode: { type: 'string' },
            createdAt: { type: 'string' },
          },
        },
        examples: sop.examples || [],
        aiGuide: {
          prompt: sop.aiPrompt,
          availableEffects: sop.availableEffects,
          effectRules: sop.effectRules,
          constraints: sop.constraints,
          forbidden: sop.forbidden,
          rawMarkdown: sop.sopMarkdownRaw,
          creationTiers: {
            preset: { items: sop.presetItems || [] },
            intermediate: {
              availableEffects: sop.availableEffects,
              maxCompositionDepth: 3,
              maxEffectsPerComposition: 5,
            },
            advanced: {
              effectScriptEnabled: true,
              customEffectAllowed: true,
              effectCodeEnabled: sop.effectCodeEnabled,
              allowedOperators: ['sequence', 'parallel', 'chain'],
              maxScriptDepth: 5,
            },
          },
        },
      };

      this.schemaRegistry.registerSchema(schema);
      this.schemaRegistry.declareGameCapabilities(gameId, [sop.schemaName]);
      this.log(`已注册游戏 SOP: ${sop.schemaName} → ${gameId}`);
    } catch (e) {
      console.warn(`[UGCBridge] 注册游戏 SOP 失败:`, e);
    }
  }

  private log(...args: any[]): void {
    if (this.debug) {
      console.log('[UGCBridge]', ...args);
    }
  }
}

// 导出单例
export const ugcBridgeService = new UGCBridgeService({ debug: true });
export default ugcBridgeService;
