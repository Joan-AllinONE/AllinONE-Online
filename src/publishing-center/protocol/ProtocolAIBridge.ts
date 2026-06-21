/**
 * AllinONE OpenGames Protocol - AI 桥梁
 *
 * AI 桥梁是协议层的"大脑"，负责将玩家的自然语言意图
 * 翻译为符合 Schema 的结构化数据，并打包为扩展凭证。
 *
 * 核心流程：
 * 1. 接收玩家意图（自然语言）
 * 2. 检查目标游戏支持的 Schema
 * 3. 找到最匹配的 Schema 定义
 * 4. AI 分析玩家意图并填充 Schema 字段
 * 5. 生成符合 Schema 的 JSON 配置
 * 6. 打包为平台扩展凭证 (ExtensionVoucher)
 * 7. 下发给游戏执行
 *
 * 注意：此模块的 AI 调用部分整合了项目中已有的
 * GameCodeAnalyzer 的 AI 能力，避免重复造轮子。
 */

import { SchemaRegistry, getDefaultRegistry } from './SchemaRegistry';
import { ExtensionVoucherService } from './ExtensionVoucher';
import type { ExtensionSchema, GameProtocolConfig } from './ProtocolChannel';

// ==================== 类型定义 ====================

export interface PlayerIntent {
  /** 玩家原始输入 */
  rawInput: string;
  /** 目标游戏 ID */
  targetGameId: string;
  /** 可选的目标 Schema */
  preferredSchema?: string;
  /** 🆕 创作等级 */
  tier?: 'preset' | 'intermediate' | 'advanced';
  /** 附加上下文 */
  context?: Record<string, any>;
}

export interface AIBridgeResult {
  success: boolean;
  voucher?: {
    id: string;
    schemaName: string;
    data: any;
  };
  /** AI 需要向玩家追问的问题 */
  questions?: string[];
  /** 建议的 Schema */
  suggestedSchema?: string;
  error?: string;
  /** AI 的分析过程 */
  reasoning?: string;
}

export interface AIBridgeConfig {
  /** Schema 注册中心 */
  schemaRegistry?: SchemaRegistry;
  /** AI 模型调用函数 */
  aiModel?: {
    generateText: (prompt: string, options?: any) => Promise<string>;
  };
  /** 是否启用调试 */
  debug?: boolean;
}

// ==================== ProtocolAIBridge 类 ====================

export class ProtocolAIBridge {
  private schemaRegistry: SchemaRegistry;
  private config: AIBridgeConfig;

  constructor(config: AIBridgeConfig = {}) {
    this.config = {
      schemaRegistry: config.schemaRegistry || getDefaultRegistry(),
      aiModel: config.aiModel,
      debug: config.debug || false,
    };
    this.schemaRegistry = this.config.schemaRegistry!;
  }

  /**
   * 处理玩家意图 —— AI 桥梁的核心入口
   *
   * 完整流程：
   * 1. 解析玩家意图中的目标游戏和目标 Schema
   * 2. 获取 Schema 定义
   * 3. 检查缺失字段 → 生成追问问题
   * 4. AI 生成符合 Schema 的数据
   * 5. 校验数据合法性
   * 6. 打包为扩展凭证
   */
  async processPlayerIntent(intent: PlayerIntent): Promise<AIBridgeResult> {
    this.log('处理玩家意图:', intent.rawInput);

    try {
      // Step 1: 确定目标 Schema
      const schemaResult = this.resolveSchema(intent);
      if (!schemaResult.schema) {
        return {
          success: false,
          error: schemaResult.error || '没有找到匹配的 Schema',
          suggestedSchema: schemaResult.suggestedSchema,
          questions: schemaResult.questions,
        };
      }

      const { schema, schemaName } = schemaResult;

      // Step 2: 分析意图提取结构
      const analysis = await this.analyzeIntent(intent.rawInput, schema, schemaName);
      if (!analysis.success) {
        return {
          success: false,
          error: analysis.error,
          questions: analysis.questions,
          suggestedSchema: schemaName,
          reasoning: analysis.reasoning,
        };
      }

      // Step 3: 校验数据（按创作等级）
      const tier = intent.tier || 'advanced';  // 默认高级（兼容旧行为）
      const validation = this.schemaRegistry.validateDataForTier(schemaName, analysis.data!, tier);
      if (!validation.valid) {
        return {
          success: false,
          error: `数据校验失败（${tier === 'preset' ? '初级' : tier === 'intermediate' ? '中级' : '高级'}模式）: ${validation.errors.join('; ')}`,
          questions: validation.errors.map(e =>
            `请检查 "${e}" 相关的信息`
          ),
          suggestedSchema: schemaName,
          reasoning: analysis.reasoning,
        };
      }

      // Step 4: 打包为凭证
      const signature = ExtensionVoucherService.sign(analysis.data!);
      const voucher = ExtensionVoucherService.create({
        schemaName,
        sourceGameId: intent.targetGameId,
        targetGameId: intent.targetGameId,
        data: analysis.data!,
        signature,
        expiresIn: 30 * 24 * 60 * 60 * 1000, // 30 天有效
      });

      this.log('扩展凭证已创建:', voucher.id, 'for schema:', schemaName);

      return {
        success: true,
        voucher: {
          id: voucher.id,
          schemaName,
          data: analysis.data,
        },
        reasoning: analysis.reasoning,
      };
    } catch (error) {
      return {
        success: false,
        error: `AI 桥梁处理失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  // ==================== Schema 解析 ====================

  private resolveSchema(intent: PlayerIntent): {
    schema?: ExtensionSchema;
    schemaName?: string;
    error?: string;
    questions?: string[];
    suggestedSchema?: string;
  } {
    // 如果玩家指定了优先 Schema
    if (intent.preferredSchema) {
      const schema = this.schemaRegistry.getSchema(intent.preferredSchema);
      if (schema) {
        return { schema, schemaName: intent.preferredSchema };
      }
      return {
        error: `指定的 Schema "${intent.preferredSchema}" 不存在`,
        suggestedSchema: intent.preferredSchema,
      };
    }

    // 检查目标游戏支持哪些 Schema
    const capabilities = this.schemaRegistry.getGameCapabilities(intent.targetGameId);

    // v2: 优先使用游戏声明的 Schema，不再做关键词猜测
    if (capabilities.length > 0) {
      const schemas: Array<{ schema: ExtensionSchema; name: string }> = [];
      for (const name of capabilities) {
        const schema = this.schemaRegistry.getSchema(name);
        if (schema) {
          schemas.push({ schema, name });
        }
      }

      if (schemas.length === 0) {
        return { error: '目标游戏暂未实现任何扩展 Schema' };
      }

      // 只有一个 Schema → 自动选择
      if (schemas.length === 1) {
        return { schema: schemas[0].schema, schemaName: schemas[0].name };
      }

      // 多个 Schema → 让玩家选择
      return {
        questions: [
          `你想创建哪种类型的内容？游戏 "${intent.targetGameId}" 支持：`,
          ...schemas.map(s => `- ${s.name}: ${s.schema.description}`),
        ],
        suggestedSchema: schemas[0].name,
      };
    }

    // 游戏未声明 Schema → 列出所有可用 Schema 供玩家选择
    const allSchemas = this.schemaRegistry.getAllSchemas();
    if (allSchemas.length === 0) {
      return { error: '没有可用的 Schema 定义' };
    }

    // 如果只有一个 Schema，自动选择
    if (allSchemas.length === 1) {
      return { schema: allSchemas[0], schemaName: allSchemas[0].name };
    }

    // 提示玩家选择
    return {
      questions: [
        `你想创建什么？可用的模板：`,
        ...allSchemas.map(s => `- ${s.name}: ${s.description}`),
      ],
      suggestedSchema: allSchemas[0].name,
    };
  }

  // ==================== AI 意图分析 ====================

  /**
   * 使用 AI 分析玩家意图并填充 Schema
   *
   * 如果配置了 AI 模型，使用 LLM 进行结构化生成；
   * 否则回退到模板匹配。
   */
  private async analyzeIntent(
    input: string,
    schema: ExtensionSchema,
    schemaName: string
  ): Promise<{
    success: boolean;
    data?: any;
    error?: string;
    questions?: string[];
    reasoning?: string;
  }> {
    // 尝试用 AI 模型，失败则自动回退模板
    if (this.config.aiModel) {
      const aiResult = await this.analyzeWithAI(input, schema, schemaName);
      if (aiResult.success) return aiResult;
      // AI 失败，记录原因并降级到模板
      this.log('AI 分析失败，降级到模板回退:', aiResult.error);
    }

    // 回退：用 Schema 的示例数据 + 关键词填充
    return this.analyzeWithTemplate(input, schema, schemaName);
  }

  /**
   * AI 驱动分析
   */
  private async analyzeWithAI(
    input: string,
    schema: ExtensionSchema,
    schemaName: string
  ): Promise<{
    success: boolean;
    data?: any;
    error?: string;
    questions?: string[];
    reasoning?: string;
  }> {
    const prompt = this.buildAIPrompt(input, schema, schemaName);

    try {
      const result = await this.config.aiModel!.generateText(prompt, {
        temperature: 0.7,
        maxTokens: 2048,
      });

      const parsed = this.parseAIResult(result);
      if (!parsed) {
        return {
          success: false,
          error: 'AI 输出格式异常，无法解析',
          questions: ['请用更明确的方式描述你想要的', schema.inputSchema.required?.length
            ? `需要提供: ${schema.inputSchema.required.join(', ')}`
            : undefined,
          ].filter(Boolean) as string[],
        };
      }

      // 检查缺失字段
      const missing = this.findMissingFields(parsed.data, schema);
      if (missing.length > 0) {
        return {
          success: false,
          error: '缺少必要信息',
          questions: missing.map(f =>
            `请提供"${f}"（${schema.inputSchema.properties?.[f]?.description || f}）`
          ),
          reasoning: parsed.reasoning,
        };
      }

      return {
        success: true,
        data: parsed.data,
        reasoning: parsed.reasoning,
      };
    } catch (error) {
      return {
        success: false,
        error: `AI 调用失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * 模板回退分析
   */
  private async analyzeWithTemplate(
    input: string,
    schema: ExtensionSchema,
    _schemaName: string
  ): Promise<{
    success: boolean;
    data?: any;
    error?: string;
    questions?: string[];
    reasoning?: string;
  }> {
    const lower = input.toLowerCase();
    const example = schema.examples?.[0];

    // 从玩家输入中提取基本信息
    const data: any = {};

    // 尝试从输入中提取名称
    const nameMatch = input.match(/(?:叫|名为|叫做|名称|name)(?:\s*[:：])?\s*["""']?([^""""'\s，。]+)/);
    if (nameMatch) {
      data.name = nameMatch[1];
    }

    // 🆕 match3-powerup Schema 的效果检测
    if (_schemaName === 'match3-powerup' || schema.tags?.includes('match3')) {
      const effectMap: Record<string, string> = {
        '炸弹': 'remove_area', '爆炸': 'remove_area', '炸': 'remove_area', 'bomb': 'remove_area',
        '闪电': 'remove_row', '十字': 'remove_row', '雷': 'remove_row', 'lightning': 'remove_row',
        '彩虹': 'remove_color', '同色消除': 'remove_color', 'rainbow': 'remove_color',
        '冷冻时间': 'add_time', '加时间': 'add_time', '延时': 'add_time', '时间': 'add_time',
        '加步': 'add_moves', '步数': 'add_moves', '加步数': 'add_moves',
        '变色': 'replace_color', '万能': 'replace_color', '变换': 'replace_color',
        '洗牌': 'shuffle', '重排': 'shuffle', '打乱': 'shuffle',
      };
      for (const [key, effect] of Object.entries(effectMap)) {
        if (lower.includes(key)) {
          data.effect = effect;
          if (!data.name) {
            const effectNames: Record<string, string> = {
              remove_area: '炸弹道具', remove_row: '闪电道具', remove_color: '彩虹道具',
              add_time: '冷冻时间', add_moves: '额外步数', replace_color: '万能方块', shuffle: '洗牌道具',
            };
            data.name = effectNames[effect] || `${effect}道具`;
          }
          // 提取效果参数
          data.params = {};
          if (effect === 'remove_area') {
            const radiusMatch = input.match(/半径\s*(\d)|(\d)×(\d)/);
            data.params.radius = radiusMatch ? Math.min(parseInt(radiusMatch[1] || radiusMatch[3]), 3) : 1;
          } else if (effect === 'add_time') {
            const secMatch = input.match(/(\d+)\s*秒/);
            data.params.seconds = secMatch ? Math.min(parseInt(secMatch[1]), 30) : 10;
          } else if (effect === 'add_moves') {
            const cntMatch = input.match(/(\d+)\s*步/);
            data.params.count = cntMatch ? Math.min(parseInt(cntMatch[1]), 5) : 1;
          } else if (effect === 'replace_color') {
            const colorMap: Record<string, string> = {
              '红': 'red', '蓝': 'blue', '绿': 'green', '黄': 'yellow', '紫': 'purple', '橙': 'orange',
            };
            const colorKeys = Object.keys(colorMap);
            const foundColors: string[] = [];
            for (const ck of colorKeys) {
              if (input.includes(ck)) foundColors.push(colorMap[ck]);
            }
            if (foundColors.length >= 2) {
              data.params.fromColor = foundColors[0];
              data.params.toColor = foundColors[1];
            } else if (foundColors.length === 1) {
              data.params.fromColor = foundColors[0];
            }
          }
          break;
        }
      }
    }

    // 通用：尝试提取数字 → damage
    if (schema.inputSchema.properties?.damage && !data.damage) {
      const numMatches = input.match(/(\d+)/g);
      if (numMatches) {
        data.damage = Math.min(parseInt(numMatches[0]), 99999);
      }
    }

    // 通用：尝试提取元素关键词
    if (schema.inputSchema.properties?.element && !data.element) {
      const elementMap: Record<string, string> = {
        '火': '火', '炎': '火', '烈焰': '火',
        '水': '水', '冰': '水', '霜': '水',
        '雷': '雷', '电': '雷',
        '风': '风', '土': '土', '光': '光', '暗': '暗',
      };
      for (const [key, val] of Object.entries(elementMap)) {
        if (lower.includes(key)) {
          data.element = val;
          break;
        }
      }
    }

    // 检查缺失字段
    const missing = this.findMissingFields(data, schema);

    if (missing.length > 0) {
      // 使用示例补充
      if (example) {
        for (const key of missing) {
          if (example[key] !== undefined && data[key] === undefined) {
            data[key] = example[key];
          }
        }
      }

      // 再次检查
      const stillMissing = this.findMissingFields(data, schema);
      if (stillMissing.length > 0) {
        return {
          success: false,
          data,
          error: '信息不完整，请补充',
          questions: stillMissing.map(f => {
            const prop = schema.inputSchema.properties?.[f];
            return prop
              ? `请提供"${f}"（${prop.description || f}${prop.enum ? `, 可选值: ${prop.enum.join('/')}` : ''}）`
              : `请提供"${f}"`;
          }),
          reasoning: `基于关键词提取，缺失字段: ${stillMissing.join(', ')}`,
        };
      }
    }

    return {
      success: true,
      data,
      reasoning: `模板填充: 从输入 "${input}" 中提取了 ${Object.keys(data).length} 个字段`,
    };
  }

  // ==================== 辅助方法 ====================

  /**
   * 构建 AI 提示词（含 SOP 注入）
   */
  private buildAIPrompt(input: string, schema: ExtensionSchema, _schemaName: string): string {
    const requiredFields = schema.inputSchema.required || [];
    const properties = schema.inputSchema.properties || {};

    let fieldsDesc = requiredFields.map(f => {
      const p = properties[f];
      if (!p) return `- ${f}: (无详细定义)`;
      let desc = `- ${f}: ${p.description || ''}`;
      if (p.type) desc += ` (类型: ${p.type})`;
      if (p.enum) desc += ` [可选: ${p.enum.join(', ')}]`;
      if (p.minimum !== undefined) desc += ` 最小值: ${p.minimum}`;
      if (p.maximum !== undefined) desc += ` 最大值: ${p.maximum}`;
      return desc;
    }).join('\n');

    // 所有可用属性（包括可选的 effectScript）
    const allProps = Object.entries(properties);
    if (allProps.length > requiredFields.length) {
      const optionalFields = allProps.filter(([key]) => !requiredFields.includes(key));
      if (optionalFields.length > 0) {
        fieldsDesc += '\n\n可选字段:\n' + optionalFields.map(([key, p]) => {
          const prop = p as any;
          let desc = `- ${key}: ${prop.description || ''}`;
          if (prop.type) desc += ` (类型: ${prop.type})`;
          return desc;
        }).join('\n');
      }
    }

    const examples = schema.examples?.length
      ? `\n参考示例:\n${JSON.stringify(schema.examples[0], null, 2)}`
      : '';

    // SOP 注入
    const sopSection = schema.aiGuide ? this.buildSOPPrompt(schema.aiGuide) : '';

    // effectScript 说明（高级模式）
    const effectScriptSection = schema.aiGuide?.creationTiers?.advanced?.effectScriptEnabled
      ? '\neffectScript 效果组合（高级功能）:\n' +
        '当玩家需要组合多个效果时，使用 effectScript 字段。格式如下：\n' +
        'effectScript: {\n' +
        '  op: "sequence" | "parallel" | "chain",\n' +
        '  effects: [\n' +
        '    { effect: "效果名", params: {...} },\n' +
        '    { effect: "效果名", params: {...} }\n' +
        '  ]\n' +
        '}\n' +
        '- sequence: 效果按顺序依次执行\n' +
        '- parallel: 效果同时执行（匹配去重）\n' +
        '- chain: 前一个效果的终点触发下一个效果\n' +
        '注意：使用 effectScript 时，effect 字段填第一个子效果名，params 填第一个子效果参数。\n'
      : '';

    // 🆕 effectCode 说明（高级模式 - 自定义效果函数）
    const effectCodeSection = schema.aiGuide?.creationTiers?.advanced?.effectCodeEnabled
      ? '\neffectCode 自定义效果函数（高级功能，用于创造全新效果类型）:\n' +
        '当玩家想要的效果不在已注册效果列表中时，可以使用 effectCode 定义全新的效果逻辑。\n' +
        'effectCode 是一个字符串，内容为完整的 JavaScript 函数表达式。格式如下：\n' +
        'effectCode: "function(params, row, col) {\\n' +
        '  // params: 道具参数对象\\n' +
        '  // row, col: 玩家点击的目标格坐标\\n' +
        '  // 可用变量: board(棋盘二维数组, board[r][c].color 获取颜色),\\n' +
        '  //           BOARD_SIZE(棋盘尺寸, 通常8),\\n' +
        '  //           gameStats(游戏状态: .score/.moves/.timeLeft),\\n' +
        '  //           renderBoard(fn, 传false), showToast(fn)\\n' +
        '  // 返回值: { matches: [{row,col},...], boardEffect: function(){}, instantMessage: \\"文字\\", animType: \\"bomb|lightning|rainbow\\" }\\n' +
        '}"\n' +
        '注意：\n' +
        '- effectCode 中的函数禁止使用 eval/Function/import/window/document/fetch 等危险API\n' +
        '- 函数体不超过4000字符\n' +
        '- 必须同时提供 effect 字段作为效果名称标识（如 "randomize_cell"）\n' +
        '- 示例：随机改变选中宝石颜色的 effectCode:\n' +
        '  effect: "randomize_cell", effectCode: "function(params,row,col){var colors=[\'red\',\'blue\',\'green\',\'yellow\',\'purple\',\'orange\'];var nc=colors[Math.floor(Math.random()*colors.length)];board[row][col].color=nc;return{matches:[],boardEffect:function(){renderBoard(false);},instantMessage:\'\u53d8\u6210\'+nc+\'\u8272\uff01\'};}"\n'
      : '';

    return `你是一个游戏内容生成助手。请根据玩家的需求，生成一个符合以下 Schema 的 JSON 数据。

目标 Schema: "${schema.name}"
描述: ${schema.description}

必需字段:
${fieldsDesc}${examples}
${sopSection}${effectScriptSection}${effectCodeSection}
玩家需求: "${input}"

请严格按照以下 JSON 格式返回（不要包含其他内容）:
{
  "data": { ... 符合 Schema 的JSON },
  "reasoning": "简要解释你的分析过程"
}`;
  }

  /**
   * 🆕 构建 SOP（能力声明）提示词段落
   */
  private buildSOPPrompt(aiGuide: NonNullable<ExtensionSchema['aiGuide']>): string {
    const parts: string[] = [''];

    // 能力上下文
    if (aiGuide.prompt) {
      parts.push(`游戏能力声明:\n${aiGuide.prompt}`);
    }

    // 可用效果
    if (aiGuide.availableEffects && aiGuide.availableEffects.length > 0) {
      parts.push(`\n可用效果:\n${aiGuide.availableEffects.map(e => `- ${e}`).join('\n')}`);
    }

    // 数值约束
    if (aiGuide.constraints) {
      const c = aiGuide.constraints;
      parts.push('\n硬性约束（必须严格遵守）:');
      if (c.damageRange) parts.push(`- 伤害范围: ${c.damageRange[0]} ~ ${c.damageRange[1]}`);
      if (c.maxEffectsPerItem) parts.push(`- 每个道具最多 ${c.maxEffectsPerItem} 个特效`);
      if (c.validElements) parts.push(`- 可用元素: ${c.validElements.join(', ')}`);
      for (const [key, val] of Object.entries(c)) {
        if (!['damageRange', 'maxEffectsPerItem', 'validElements'].includes(key)) {
          parts.push(`- ${key}: ${JSON.stringify(val)}`);
        }
      }
    }

    // 效果组合规则
    if (aiGuide.effectRules && aiGuide.effectRules.length > 0) {
      parts.push(`\n效果组合规则:\n${aiGuide.effectRules.map(r => `- ${r}`).join('\n')}`);
    }

    // 禁止事项
    if (aiGuide.forbidden && aiGuide.forbidden.length > 0) {
      parts.push(`\n禁止事项（绝对不可违反）:\n${aiGuide.forbidden.map(f => `- ${f}`).join('\n')}`);
    }

    return parts.join('\n');
  }

  /**
   * 解析 AI 返回结果
   */
  private parseAIResult(result: string): { data: any; reasoning: string } | null {
    try {
      // 尝试提取 JSON
      const jsonMatch = result.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;

      const parsed = JSON.parse(jsonMatch[0]);
      return {
        data: parsed.data || parsed,
        reasoning: parsed.reasoning || 'AI 生成',
      };
    } catch {
      return null;
    }
  }

  /**
   * 查找 Schema 必需但数据中缺失的字段
   */
  private findMissingFields(data: any, schema: ExtensionSchema): string[] {
    const required = schema.inputSchema.required || [];
    return required.filter(f => data[f] === undefined || data[f] === null || data[f] === '');
  }

  private log(...args: any[]): void {
    if (this.config.debug) {
      console.log('[ProtocolAIBridge]', ...args);
    }
  }
}

export default ProtocolAIBridge;
