/**
 * AllinONE OpenGames Protocol - Schema Registry
 *
 * 标准化接口定义中心：
 * - 游戏方注册自己的 Schema（每个游戏定义自己的道具创作规则）
 * - 玩家基于游戏 SOP 自由创作道具
 * - 跨游戏 Schema 数据适配（游戏A → 游戏B）
 * - 提供 SOP 文档供外部 AI 参考
 *
 * v2 重构：从"平台硬编码 3 种通用 Schema"转向"游戏方自行注册 SOP"
 */

import type { ExtensionSchema, JSONSchema, CreationTiers } from './ProtocolChannel';

// ==================== 内部类型 ====================

interface SchemaRegistration {
  schema: ExtensionSchema;
  registeredAt: number;
  /** 实现了此 Schema 的游戏列表 */
  compatibleGames: Set<string>;
}

interface AdapterResult<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  adaptedSchemaName?: string;
}

// ==================== 游戏 → Schema 映射 ====================

/**
 * 游戏专用 Schema 映射表
 * key = gameId (小写)，value = 该游戏支持的 schema 名称列表
 */
const GAME_SCHEMA_MAP: Record<string, string[]> = {
  'match3': ['match3-powerup'],
  'match3game': ['match3-powerup'],
  'zuma': ['zuma-powerup'],
};

// ==================== SchemaRegistry 类 ====================

export class SchemaRegistry {
  private schemas: Map<string, SchemaRegistration> = new Map();
  private gameCapabilities: Map<string, Set<string>> = new Map();  // gameId → Set<schemaName>

  constructor() {
    this.registerBuiltinSchemas();
  }

  // ==================== Schema 管理 ====================

  /**
   * 注册扩展 Schema
   */
  registerSchema(schema: ExtensionSchema): void {
    const key = schema.name;

    if (this.schemas.has(key)) {
      console.warn(`[SchemaRegistry] Schema "${key}" 已存在，将被覆盖`);
    }

    this.schemas.set(key, {
      schema,
      registeredAt: Date.now(),
      compatibleGames: new Set(),
    });

    console.log(`[SchemaRegistry] Schema 已注册: "${key}" v${schema.version}`);
  }

  /**
   * 获取 Schema 定义
   */
  getSchema(name: string): ExtensionSchema | undefined {
    return this.schemas.get(name)?.schema;
  }

  /**
   * 获取所有已注册的 Schema
   */
  getAllSchemas(): ExtensionSchema[] {
    return Array.from(this.schemas.values()).map(r => r.schema);
  }

  /**
   * 按标签搜索 Schema
   */
  searchSchemasByTag(tag: string): ExtensionSchema[] {
    return this.getAllSchemas().filter(s => s.tags?.includes(tag));
  }

  /**
   * 判断 Schema 是否存在
   */
  hasSchema(name: string): boolean {
    return this.schemas.has(name);
  }

  /**
   * 注销 Schema
   */
  unregisterSchema(name: string): void {
    this.schemas.delete(name);
    console.log(`[SchemaRegistry] Schema 已注销: "${name}"`);
  }

  // ==================== 游戏兼容性 ====================

  /**
   * 声明游戏实现的 Schema
   */
  declareGameCapabilities(gameId: string, schemaNames: string[]): void {
    const capabilities = this.gameCapabilities.get(gameId) || new Set();

    for (const name of schemaNames) {
      capabilities.add(name);
      // 同时记录到 Schema 的兼容游戏列表
      const reg = this.schemas.get(name);
      if (reg) {
        reg.compatibleGames.add(gameId);
      }
    }

    this.gameCapabilities.set(gameId, capabilities);
  }

  /**
   * 检查游戏是否兼容某 Schema
   */
  checkGameCompatibility(gameId: string, schemaName: string): boolean {
    const capabilities = this.gameCapabilities.get(gameId);
    return capabilities?.has(schemaName) ?? false;
  }

  /**
   * 获取兼容某 Schema 的所有游戏
   */
  getCompatibleGames(schemaName: string): string[] {
    const reg = this.schemas.get(schemaName);
    return reg ? Array.from(reg.compatibleGames) : [];
  }

  /**
   * 获取游戏的声明能力
   */
  getGameCapabilities(gameId: string): string[] {
    return Array.from(this.gameCapabilities.get(gameId) || []);
  }

  /**
   * 移除游戏的声明（游戏下架时）
   */
  removeGameCapabilities(gameId: string): void {
    const capabilities = this.gameCapabilities.get(gameId);
    if (capabilities) {
      for (const schemaName of capabilities) {
        const reg = this.schemas.get(schemaName);
        reg?.compatibleGames.delete(gameId);
      }
      this.gameCapabilities.delete(gameId);
    }
  }

  // ==================== 跨游戏适配 ====================

  /**
   * 跨游戏数据适配
   * 将某个 Schema 的数据适配到目标游戏兼容的格式
   */
  adaptForGame<T = any>(
    data: any,
    schemaName: string,
    targetGameId: string
  ): AdapterResult<T> {
    const schema = this.getSchema(schemaName);
    if (!schema) {
      return { success: false, error: `Schema "${schemaName}" 未注册` };
    }

    if (!this.checkGameCompatibility(targetGameId, schemaName)) {
      return {
        success: false,
        error: `游戏 "${targetGameId}" 不兼容 Schema "${schemaName}"`,
      };
    }

    // 查找针对目标游戏的适配器
    if (schema.adapters && schema.adapters[targetGameId]) {
      try {
        const adapted = schema.adapters[targetGameId](data);
        return {
          success: true,
          data: adapted as T,
          adaptedSchemaName: schemaName,
        };
      } catch (error) {
        return {
          success: false,
          error: `适配失败: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }

    // 没有特定适配器时，直接返回原始数据（假设兼容）
    return {
      success: true,
      data: data as T,
      adaptedSchemaName: schemaName,
    };
  }

  /**
   * 自动适配：查找目标游戏最接 Schema 并转换数据
   *
   * 🆕 增强：当无法直接适配时，尝试字段映射转换
   */
  autoAdapt<T = any>(
    data: any,
    sourceSchemaName: string,
    targetGameId: string
  ): AdapterResult<T> {
    // 1. 尝试直接适配
    const direct = this.adaptForGame<T>(data, sourceSchemaName, targetGameId);
    if (direct.success) return direct;

    // 2. 查找目标游戏支持的所有 Schema，找数据结构最接近的
    const capabilities = this.getGameCapabilities(targetGameId);
    for (const capSchemaName of capabilities) {
      if (capSchemaName === sourceSchemaName) continue;

      const capSchema = this.getSchema(capSchemaName);
      if (capSchema && this.canAutoConvert(sourceSchemaName, capSchemaName)) {
        // 🆕 尝试字段映射转换
        const converted = this.convertFields(data, sourceSchemaName, capSchemaName);
        return this.adaptForGame<T>(converted, capSchemaName, targetGameId);
      }
    }

    return {
      success: false,
      error: `无法自动适配数据到游戏 "${targetGameId}"`,
    };
  }

  /**
   * 🆕 字段映射转换：将源 Schema 数据转换为目标 Schema 格式
   */
  private convertFields(data: any, fromSchema: string, toSchema: string): any {
    const converted = { ...data };

    // weapon → quest: 武器属性转任务奖励
    if (fromSchema === 'weapon' && toSchema === 'quest') {
      return {
        title: data.name ? `获取${data.name}` : '武器装备任务',
        description: `完成挑战以获得 ${data.name || '稀有武器'}`,
        objectives: [
          { type: 'survive', target: '试炼场', count: 1 },
        ],
        rewards: {
          exp: Math.min((data.damage || 50) * 2, 10000),
          gameCoins: Math.min((data.damage || 50) * 5, 100000),
          items: data.name ? [data.name] : [],
        },
      };
    }

    // quest → weapon: 任务转武器名称（弱转换）
    if (fromSchema === 'quest' && toSchema === 'weapon') {
      const title = data.title || '';
      return {
        name: title.replace(/^(获取|击败|收集|到达|消灭)/, ''),
        damage: (data.rewards?.exp || 50) / 2,
        element: '物理',
        rarity: (data.rewards?.exp || 0) > 500 ? 'rare' : 'uncommon',
      };
    }

    // weapon/shop → shop
    if ((fromSchema === 'weapon' || fromSchema === 'quest') && toSchema === 'shop') {
      return {
        name: `${data.name || data.title || '神秘'} 商店`,
        description: `出售 ${data.name || data.title || '稀有'} 相关道具`,
        items: [
          {
            itemName: data.name || data.title || '道具',
            price: Math.round((data.damage || 100) / 2),
            currencyType: 'gameCoins',
            stock: -1,
          },
        ],
      };
    }

    return converted;
  }

  /**
   * 校验数据是否符合 Schema 规范
   */
  validateData(schemaName: string, data: any): { valid: boolean; errors: string[] } {
    const schema = this.getSchema(schemaName);
    if (!schema) {
      return { valid: false, errors: [`Schema "${schemaName}" 未注册`] };
    }

    return this.validateAgainstSchema(schema.outputSchema, data, '$');
  }

  /**
   * 🆕 按创作等级校验数据
   *
   * - preset: 只允许 aiGuide.creationTiers.preset.items 中完全匹配的道具
   * - intermediate: effect 必须在 availableEffects 列表中，可使用 effectScript 组合
   * - advanced: 允许 effectScript 和自定义效果（受约束限制）
   */
  validateDataForTier(
    schemaName: string,
    data: any,
    tier: 'preset' | 'intermediate' | 'advanced'
  ): { valid: boolean; errors: string[] } {
    const schema = this.getSchema(schemaName);
    if (!schema) {
      return { valid: false, errors: [`Schema "${schemaName}" 未注册`] };
    }

    const tiers = schema.aiGuide?.creationTiers;
    if (!tiers) {
      // 没有 creationTiers 配置时，降级为普通校验
      return this.validateData(schemaName, data);
    }

    const errors: string[] = [];

    if (tier === 'preset') {
      // 初级：必须与某个预设道具完全匹配
      const presets = tiers.preset.items;
      const matched = presets.some(p =>
        p.name === data.name && p.effect === data.effect
      );
      if (!matched) {
        errors.push(
          `初级模式只能创建预设道具。可用预设: ${presets.map(p => p.name).join('、')}`
        );
      }
    } else if (tier === 'intermediate') {
      // 中级：允许 effectScript 组合，每个效果必须在 availableEffects 中
      const allowedEffects = tiers.intermediate.availableEffects;
      const maxDepth = tiers.intermediate.maxCompositionDepth ?? 3;
      const maxEffects = tiers.intermediate.maxEffectsPerComposition ?? 5;

      if (data.effectScript) {
        // 校验 effectScript
        const scriptErrors = this.validateEffectScript(
          data.effectScript,
          allowedEffects,
          maxDepth,
          maxEffects
        );
        errors.push(...scriptErrors);
      } else {
        // 单效果模式：effect 必须在 availableEffects 中
        if (!allowedEffects.includes(data.effect)) {
          errors.push(
            `中级模式仅支持已注册效果。可用效果: ${allowedEffects.join('、')}`
          );
        }
      }

      // 通用字段校验
      const baseValidation = this.validateData(schemaName, data);
      // 对于 effectScript 模式，effect 字段可能不在 enum 中，跳过 enum 校验错误
      if (data.effectScript) {
        const filteredErrors = baseValidation.errors.filter(
          e => !e.includes('不在允许值') && !e.includes('effect')
        );
        errors.push(...filteredErrors);
      } else {
        errors.push(...baseValidation.errors);
      }
    } else if (tier === 'advanced') {
      // 高级：允许 effectScript、effectCode 和自定义效果
      if (data.effectScript) {
        const maxDepth = tiers.advanced.maxScriptDepth ?? 5;
        const allowedOps = tiers.advanced.allowedOperators ?? ['sequence', 'parallel', 'chain'];
        const scriptErrors = this.validateEffectScriptAdvanced(
          data.effectScript,
          maxDepth,
          allowedOps
        );
        errors.push(...scriptErrors);
      } else if (data.effectCode) {
        // 🆕 effectCode 自定义效果校验
        if (!tiers.advanced.effectCodeEnabled) {
          errors.push('当前游戏未启用 effectCode 自定义效果');
        }
        if (typeof data.effectCode !== 'string' || data.effectCode.length === 0) {
          errors.push('effectCode 必须是非空字符串');
        }
        if (data.effectCode.length > 4000) {
          errors.push('effectCode 超过 4000 字符限制');
        }
        if (!data.effect || typeof data.effect !== 'string') {
          errors.push('使用 effectCode 时必须指定 effect 字段作为效果名称');
        }
        // 安全检查：禁止危险关键词
        const blockedPatterns = [
          'eval(', 'new Function', 'import(', 'require(', '__proto__',
          'window.', 'document.', 'parent.', 'top.', 'globalThis',
          'fetch(', 'XMLHttpRequest', 'WebSocket', 'Worker(',
          'localStorage', 'sessionStorage',
        ];
        const lowerCode = data.effectCode.toLowerCase();
        for (const pattern of blockedPatterns) {
          if (lowerCode.includes(pattern.toLowerCase())) {
            errors.push(`effectCode 包含禁止关键词: ${pattern}`);
            break;
          }
        }
      } else if (!tiers.advanced.customEffectAllowed) {
        // 不允许自定义效果名时，effect 必须在 availableEffects 中
        const allowedEffects = schema.aiGuide?.availableEffects || [];
        if (!allowedEffects.includes(data.effect)) {
          errors.push(
            `高级模式不支持自定义效果名。可用效果: ${allowedEffects.join('、')}`
          );
        }
      }

      // 通用约束校验（但不做 enum 校验）
      const baseValidation = this.validateData(schemaName, data);
      const filteredErrors = baseValidation.errors.filter(
        e => !e.includes('不在允许值')
      );
      errors.push(...filteredErrors);
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * 🆕 校验 effectScript（中级模式）
   */
  private validateEffectScript(
    script: any,
    allowedEffects: string[],
    maxDepth: number,
    maxEffects: number,
    depth: number = 0
  ): string[] {
    const errors: string[] = [];

    if (depth > maxDepth) {
      errors.push(`effectScript 嵌套深度超过限制 (${maxDepth})`);
      return errors;
    }

    if (!script || typeof script !== 'object') {
      errors.push('effectScript 必须是对象');
      return errors;
    }

    if (script.op) {
      // 组合模式
      const validOps = ['sequence', 'parallel', 'chain'];
      if (!validOps.includes(script.op)) {
        errors.push(`effectScript 操作符 "${script.op}" 无效，可用: ${validOps.join('/')}`);
      }

      if (!Array.isArray(script.effects) || script.effects.length === 0) {
        errors.push('effectScript 组合必须包含 effects 数组');
      } else if (script.effects.length > maxEffects) {
        errors.push(`组合效果数超过限制 (${maxEffects})`);
      } else {
        for (const sub of script.effects) {
          errors.push(...this.validateEffectScript(sub, allowedEffects, maxDepth, maxEffects, depth + 1));
        }
      }
    } else if (script.effect) {
      // 单效果节点
      if (!allowedEffects.includes(script.effect)) {
        errors.push(`效果 "${script.effect}" 不在允许列表中。可用: ${allowedEffects.join('、')}`);
      }
    } else {
      errors.push('effectScript 节点必须包含 op(组合) 或 effect(单效果)');
    }

    return errors;
  }

  /**
   * 🆕 校验 effectScript（高级模式 - 允许自定义效果）
   */
  private validateEffectScriptAdvanced(
    script: any,
    maxDepth: number,
    allowedOps: string[],
    depth: number = 0
  ): string[] {
    const errors: string[] = [];

    if (depth > maxDepth) {
      errors.push(`effectScript 嵌套深度超过限制 (${maxDepth})`);
      return errors;
    }

    if (!script || typeof script !== 'object') {
      errors.push('effectScript 必须是对象');
      return errors;
    }

    if (script.op) {
      if (!allowedOps.includes(script.op)) {
        errors.push(`effectScript 操作符 "${script.op}" 无效，可用: ${allowedOps.join('/')}`);
      }
      if (!Array.isArray(script.effects) || script.effects.length === 0) {
        errors.push('effectScript 组合必须包含 effects 数组');
      } else {
        for (const sub of script.effects) {
          errors.push(...this.validateEffectScriptAdvanced(sub, maxDepth, allowedOps, depth + 1));
        }
      }
    } else if (!script.effect) {
      errors.push('effectScript 节点必须包含 op(组合) 或 effect(单效果)');
    }

    return errors;
  }

  // ==================== 游戏 Schema 自动注册 ====================

  /**
   * 根据游戏 ID 自动注册该游戏专用的 Schema 并声明能力
   * @returns 注册的 schema 名称列表
   */
  autoRegisterGameSchemas(gameId: string): string[] {
    const schemaNames = GAME_SCHEMA_MAP[gameId.toLowerCase()] || [];
    if (schemaNames.length > 0) {
      this.declareGameCapabilities(gameId, schemaNames);
      console.log(`[SchemaRegistry] 游戏 "${gameId}" 自动注册 Schema:`, schemaNames);
    }
    return schemaNames;
  }

  // ==================== SOP 文档生成 ====================

  /**
   * 根据 Schema 生成 SOP Markdown 文档
   * 玩家可将此文档复制给外部 AI（ChatGPT/Claude）生成合规的道具 JSON
   */
  generateSOPMarkdown(schemaName: string): string {
    const schema = this.getSchema(schemaName);
    if (!schema) return '';

    const lines: string[] = [];

    lines.push(`# ${schema.name} — 道具创作 SOP`);
    lines.push('');
    lines.push(`## 描述`);
    lines.push(schema.description);
    lines.push('');

    // AI Guide - 能力声明
    const guide = schema.aiGuide;
    if (guide?.prompt) {
      lines.push(`## 游戏规则`);
      lines.push(guide.prompt);
      lines.push('');
    }

    // 可用效果 API
    if (guide?.availableEffects && guide.availableEffects.length > 0) {
      lines.push(`## 可用效果 API`);
      lines.push('');

      if (guide.effectRules && guide.effectRules.length > 0) {
        lines.push('| 效果名 | 说明 |');
        lines.push('|--------|------|');
        for (const rule of guide.effectRules) {
          const colonIdx = rule.indexOf(':');
          if (colonIdx > 0) {
            const effectName = rule.slice(0, colonIdx).trim();
            const effectDesc = rule.slice(colonIdx + 1).trim();
            lines.push(`| ${effectName} | ${effectDesc} |`);
          } else {
            lines.push(`| ${rule} | - |`);
          }
        }
      } else {
        for (const effect of guide.availableEffects) {
          lines.push(`- ${effect}`);
        }
      }
      // 🆕 高级模式 effectCode 提示
      if (guide.creationTiers?.advanced?.effectCodeEnabled) {
        lines.push('');
        lines.push(`> 💡 高级模式支持通过 \`effectCode\` 字段创建以上列表之外的全新效果类型，详见下方「高级创作」章节。`);
      }
      lines.push('');
    }

    // 约束条件
    if (guide?.constraints) {
      lines.push(`## 约束条件`);
      const c = guide.constraints;
      if (c.maxCellsPerEffect) lines.push(`- 单次消除格子数 ≤ ${c.maxCellsPerEffect}`);
      if (c.maxTimeAdd) lines.push(`- 增加时间最多 ${c.maxTimeAdd} 秒`);
      if (c.maxMovesAdd) lines.push(`- 增加步数最多 ${c.maxMovesAdd} 步`);
      if (c.validColors) lines.push(`- 可用颜色: ${c.validColors.join(', ')}`);
      if (c.boardSize) lines.push(`- 棋盘大小: ${c.boardSize}×${c.boardSize}`);
      // 通用约束
      for (const [key, val] of Object.entries(c)) {
        if (!['maxCellsPerEffect', 'maxTimeAdd', 'maxMovesAdd', 'validColors', 'boardSize',
              'damageRange', 'maxEffectsPerItem', 'validElements'].includes(key)) {
          lines.push(`- ${key}: ${JSON.stringify(val)}`);
        }
      }
      lines.push('');
    }

    // 禁止事项
    if (guide?.forbidden && guide.forbidden.length > 0) {
      lines.push(`## 禁止事项`);
      for (const f of guide.forbidden) {
        lines.push(`- ${f}`);
      }
      lines.push('');
    }

    // 🆕 创作等级说明
    if (guide?.creationTiers) {
      const ct = guide.creationTiers;
      lines.push(`## 创作等级`);
      lines.push('');

      lines.push(`### 初级（预设道具）`);
      lines.push(`仅可创建以下预设道具：`);
      lines.push('');
      for (const item of ct.preset.items) {
        lines.push(`- **${item.name}**: ${item.description} (effect: ${item.effect})`);
      }
      lines.push('');

      lines.push(`### 中级（效果组合）`);
      lines.push(`可使用已注册效果进行组合，支持 effectScript：`);
      lines.push(`- 可用效果: ${ct.intermediate.availableEffects.join(', ')}`);
      if (ct.intermediate.maxCompositionDepth) {
        lines.push(`- 最大组合深度: ${ct.intermediate.maxCompositionDepth}`);
      }
      if (ct.intermediate.maxEffectsPerComposition) {
        lines.push(`- 单次最多组合效果数: ${ct.intermediate.maxEffectsPerComposition}`);
      }
      lines.push('');
      lines.push(`effectScript 格式：`);
      lines.push('```json');
      lines.push(JSON.stringify({
        op: 'sequence',
        effects: [
          { effect: '效果名', params: {} },
          { effect: '效果名', params: {} },
        ],
      }, null, 2));
      lines.push('```');
      lines.push(`操作符: sequence(顺序) | parallel(并行) | chain(链式)`);
      lines.push('');

      lines.push(`### 高级（自由创作）`);
      lines.push(`支持 effectScript 自由组合、effectCode 自定义效果和自定义效果名：`);
      lines.push(`- effectScript: ${ct.advanced.effectScriptEnabled ? '已启用' : '未启用'}`);
      lines.push(`- 自定义效果名: ${ct.advanced.customEffectAllowed ? '允许' : '不允许'}`);
      if (ct.advanced.effectCodeEnabled) {
        lines.push(`- **effectCode 自定义效果函数**: 已启用`);
      }
      if (ct.advanced.allowedOperators) {
        lines.push(`- 允许的操作符: ${ct.advanced.allowedOperators.join(', ')}`);
      }
      if (ct.advanced.maxScriptDepth) {
        lines.push(`- 最大脚本嵌套深度: ${ct.advanced.maxScriptDepth}`);
      }
      lines.push('');

      // 🆕 effectCode 详细说明
      if (ct.advanced.effectCodeEnabled) {
        lines.push(`#### effectCode — 自定义效果函数`);
        lines.push('');
        lines.push(`当玩家需要的效果不在「可用效果 API」列表中时，可以使用 \`effectCode\` 字段定义全新的效果逻辑。`);
        lines.push(`\`effectCode\` 是一个 JavaScript 函数表达式字符串，随道具 JSON 一起打包，在游戏运行时安全执行。`);
        lines.push('');
        lines.push(`**函数签名：**`);
        lines.push('```');
        lines.push(`function(params, row, col)`);
        lines.push('```');
        lines.push('');
        lines.push(`**沙箱可用变量：**`);
        lines.push('');
        lines.push('| 变量 | 说明 |');
        lines.push('|------|------|');
        lines.push('| `board` | 棋盘二维数组，`board[r][c].color` 获取颜色 |');
        lines.push('| `BOARD_SIZE` | 棋盘尺寸（通常 8） |');
        lines.push('| `gameStats` | 游戏状态对象（.score / .moves / .timeLeft） |');
        lines.push('| `renderBoard` | 渲染函数，调用 `renderBoard(false)` 刷新画面 |');
        lines.push('| `showToast` | 提示函数，`showToast(\'文字\', \'success\')` |');
        lines.push('| `Math` | JavaScript Math 对象 |');
        lines.push('| `JSON` | JavaScript JSON 对象 |');
        lines.push('');
        lines.push(`**返回值格式：**`);
        lines.push('```json');
        lines.push('{');
        lines.push('  "matches": [{"row": 0, "col": 0}],   // 要消除的格子（空数组=不消除）');
        lines.push('  "boardEffect": "function(){}",          // 棋盘副作用函数（可选）');
        lines.push('  "instantMessage": "提示文字",            // 即时消息（可选）');
        lines.push('  "animType": "bomb|lightning|rainbow"    // 动画类型（可选）');
        lines.push('}');
        lines.push('```');
        lines.push('');
        lines.push(`**安全限制：**`);
        lines.push(`- 函数体不超过 4000 字符`);
        lines.push(`- 禁止使用: eval, new Function, import, window, document, fetch, localStorage 等危险 API`);
        lines.push('');
        lines.push(`**完整示例 — 随机宝石道具：**`);
        lines.push('```json');
        const effectCodeExample = schema.examples?.find(e => e.effectCode);
        if (effectCodeExample) {
          lines.push(JSON.stringify(effectCodeExample, null, 2));
        } else {
          lines.push(JSON.stringify({
            name: '随机宝石',
            effect: 'randomize_cell',
            params: { target: 'selected' },
            description: '将选中的宝石随机变色',
            effectCode: "function(params, row, col) {\n  var colors = ['red','blue','green','yellow','purple','orange'];\n  var cur = board[row][col].color;\n  var nc = cur;\n  while (nc === cur) nc = colors[Math.floor(Math.random()*colors.length)];\n  board[row][col].color = nc;\n  return { matches:[], boardEffect:function(){renderBoard(false);}, instantMessage:'变成'+nc+'色！' };\n}"
          }, null, 2));
        }
        lines.push('```');
        lines.push('');
      }
    }

    // 输入参数定义
    const inputProps = schema.inputSchema.properties || {};
    const required = schema.inputSchema.required || [];
    if (Object.keys(inputProps).length > 0) {
      lines.push(`## 道具参数定义`);
      lines.push('');
      lines.push('| 字段 | 类型 | 必填 | 说明 |');
      lines.push('|------|------|------|------|');
      for (const [key, prop] of Object.entries(inputProps)) {
        const p = prop as JSONSchema;
        const isRequired = required.includes(key);
        let desc = p.description || '-';
        if (p.enum) desc += ` (可选: ${p.enum.join('/')})`;
        if (p.minimum !== undefined) desc += ` [最小: ${p.minimum}]`;
        if (p.maximum !== undefined) desc += ` [最大: ${p.maximum}]`;
        lines.push(`| ${key} | ${p.type || '-'} | ${isRequired ? '是' : '否'} | ${desc} |`);
      }
      lines.push('');
    }

    // 示例
    if (schema.examples && schema.examples.length > 0) {
      lines.push(`## 输出格式`);
      lines.push('请生成如下 JSON：');
      lines.push('');
      lines.push(`### 基础示例`);
      lines.push('```json');
      lines.push(JSON.stringify(schema.examples[0], null, 2));
      lines.push('```');
      lines.push('');

      // 🆕 如果有 effectCode 示例，单独展示
      const effectCodeExample = schema.examples.find(e => e.effectCode);
      if (effectCodeExample) {
        lines.push(`### 自定义效果示例（高级模式 effectCode）`);
        lines.push('```json');
        lines.push(JSON.stringify(effectCodeExample, null, 2));
        lines.push('```');
        lines.push('');
      }

      // 如果有 effectScript 示例，单独展示
      const effectScriptExample = schema.examples.find(e => e.effectScript);
      if (effectScriptExample && effectScriptExample !== effectCodeExample) {
        lines.push(`### 组合效果示例（中级/高级 effectScript）`);
        lines.push('```json');
        lines.push(JSON.stringify(effectScriptExample, null, 2));
        lines.push('```');
        lines.push('');
      }
    }

    return lines.join('\n');
  }

  // ==================== 内置 Schema ====================

  private registerBuiltinSchemas(): void {
    // Match3 消消乐专用道具 Schema（v2 核心：游戏方自定义 + 3级创作模式）
    this.registerSchema({
      name: 'match3-powerup',
      version: '2.0.0',
      description: '消消乐游戏道具 — 玩家可创建各种效果的增益道具（支持3级创作模式）',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '道具名称' },
          effect: {
            type: 'string',
            description: '效果类型（中级/高级模式可为任意已注册效果）',
          },
          params: {
            type: 'object',
            description: '效果参数（根据效果类型不同）',
            properties: {
              radius: { type: 'number', description: 'remove_area 的半径 (1-3)', minimum: 1, maximum: 3 },
              color: {
                type: 'string',
                description: '颜色 (red/blue/green/yellow/purple/orange)',
                enum: ['red', 'blue', 'green', 'yellow', 'purple', 'orange'],
              },
              seconds: { type: 'number', description: 'add_time 增加的秒数 (5-30)', minimum: 5, maximum: 30 },
              count: { type: 'number', description: 'add_moves 增加的步数 (1-5)', minimum: 1, maximum: 5 },
              fromColor: { type: 'string', description: 'replace_color 源颜色' },
              toColor: { type: 'string', description: 'replace_color 目标颜色' },
            },
          },
          description: { type: 'string', description: '道具描述' },
          effectCode: {
            type: 'string',
            description: '自定义效果函数体（仅高级模式）。function(params,row,col){...} 格式的 JS 函数代码字符串，运行时在游戏沙箱中执行。可用变量：board(棋盘数组)、BOARD_SIZE(棋盘尺寸)、gameStats(游戏状态)、renderBoard(渲染函数)、showToast(提示函数)。返回值格式：{ matches: [{row,col}], boardEffect: function(), instantMessage: string, animType: string }',
          },
          effectScript: {
            type: 'object',
            description: '效果组合脚本（中级/高级模式）。支持 sequence/parallel/chain 操作符组合多个效果',
            properties: {
              op: { type: 'string', description: '操作符: sequence(顺序) | parallel(并行) | chain(链式)' },
              effects: {
                type: 'array',
                description: '子效果列表',
                items: {
                  type: 'object',
                  properties: {
                    effect: { type: 'string', description: '效果名' },
                    params: { type: 'object', description: '效果参数' },
                    op: { type: 'string', description: '嵌套操作符' },
                    effects: { type: 'array', description: '嵌套子效果' },
                  },
                },
              },
            },
          },
        },
        required: ['name'],
      },
      outputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          effect: { type: 'string' },
          params: { type: 'object' },
          description: { type: 'string' },
          effectScript: { type: 'object' },
          effectCode: { type: 'string' },
          createdAt: { type: 'string' },
        },
      },
      adapters: {},
      examples: [
        {
          name: '炸弹道具',
          effect: 'remove_area',
          params: { radius: 1 },
          description: '消除目标位置 3×3 范围内的所有宝石',
        },
        {
          name: '闪电道具',
          effect: 'remove_row',
          params: {},
          description: '消除目标宝石所在的整行和整列',
        },
        {
          name: '彩虹道具',
          effect: 'remove_color',
          params: {},
          description: '消除棋盘上所有与目标同色的宝石',
        },
        {
          name: '冷冻时间',
          effect: 'add_time',
          params: { seconds: 15 },
          description: '增加15秒游戏时间',
        },
        {
          name: '万能方块',
          effect: 'replace_color',
          params: { fromColor: 'red', toColor: 'blue' },
          description: '将所有红色宝石变为蓝色',
        },
        {
          name: '时空炸弹',
          effect: 'remove_area',
          params: { radius: 1 },
          description: '先炸后延时：3×3 范围消除 + 10秒',
          effectScript: {
            op: 'sequence',
            effects: [
              { effect: 'remove_area', params: { radius: 1 } },
              { effect: 'add_time', params: { seconds: 10 } },
            ],
          },
        },
        {
          name: '随机宝石',
          effect: 'randomize_cell',
          params: { target: 'selected' },
          description: '将选中的宝石随机变为红/蓝/绿/黄/紫/橙中的一种颜色，创造意外连击',
          effectCode: "function(params, row, col) {\n  var colors = ['red','blue','green','yellow','purple','orange'];\n  var cur = board[row][col].color;\n  var nc = cur;\n  while (nc === cur && colors.length > 1) nc = colors[Math.floor(Math.random()*colors.length)];\n  board[row][col].color = nc;\n  return { matches:[], boardEffect:function(){renderBoard(false);}, instantMessage:'宝石变成了'+nc+'色！' };\n}",
        },
      ],
      tags: ['match3', 'powerup', 'consumable'],
      aiGuide: {
        prompt: '消消乐(Match3)游戏道具创作系统。游戏是一个8×8的棋盘，宝石有6种颜色(red/blue/green/yellow/purple/orange)。玩家通过匹配3个或更多同色宝石来消除它们获得分数。道具可以增强消除能力或改变游戏状态。',
        availableEffects: ['remove_area', 'remove_row', 'remove_col', 'remove_color', 'add_time', 'add_moves', 'replace_color', 'shuffle', 'bomb', 'lightning', 'rainbow'],
        constraints: {
          maxCellsPerEffect: 20,
          maxTimeAdd: 30,
          maxMovesAdd: 5,
          validColors: ['red', 'blue', 'green', 'yellow', 'purple', 'orange'],
          boardSize: 8,
        },
        effectRules: [
          'remove_area: 以目标格为中心消除正方形区域，radius=1为3×3，radius=2为5×5',
          'remove_row: 消除目标宝石所在的整行(8个格子)',
          'remove_col: 消除目标宝石所在的整列(8个格子)',
          'remove_color: 消除棋盘上所有指定颜色的宝石',
          'add_time: 增加游戏时间，5-30秒',
          'add_moves: 增加游戏步数，1-5步',
          'replace_color: 将一种颜色的宝石全部替换为另一种颜色',
          'shuffle: 随机重排棋盘上所有宝石的位置',
          'bomb: 同 remove_area（兼容别名）',
          'lightning: 同 remove_row（兼容别名）',
          'rainbow: 同 remove_color（兼容别名）',
        ],
        forbidden: [
          '不要创建消除超过20个格子的道具',
          'add_time 不要超过30秒',
          'add_moves 不要超过5步',
          'effectCode: 高级模式可自定义效果函数。函数签名 function(params,row,col)，可用变量: board(8×8棋盘数组)、BOARD_SIZE(8)、gameStats(游戏状态)、renderBoard(fn)、showToast(fn)。返回 { matches:[{row,col}], boardEffect:fn, instantMessage:string, animType:string }',
          '不要创建直接影响分数的道具',
          'radius 最大为3',
        ],
        creationTiers: {
          preset: {
            items: [
              { name: '炸弹道具', effect: 'remove_area', params: { radius: 1 }, description: '消除目标位置 3×3 范围内的所有宝石', icon: 'bomb' },
              { name: '闪电道具', effect: 'remove_row', params: {}, description: '消除目标宝石所在的整行', icon: 'zap' },
              { name: '彩虹道具', effect: 'remove_color', params: {}, description: '消除棋盘上所有与目标同色的宝石', icon: 'rainbow' },
              { name: '冷冻时间', effect: 'add_time', params: { seconds: 15 }, description: '增加15秒游戏时间', icon: 'clock' },
              { name: '额外步数', effect: 'add_moves', params: { count: 3 }, description: '增加3步游戏步数', icon: 'footprints' },
              { name: '变色方块', effect: 'replace_color', params: { fromColor: 'red', toColor: 'blue' }, description: '将红色宝石变为蓝色', icon: 'palette' },
              { name: '洗牌道具', effect: 'shuffle', params: {}, description: '随机重排棋盘上所有宝石', icon: 'shuffle' },
            ],
          },
          intermediate: {
            availableEffects: ['remove_area', 'remove_row', 'remove_col', 'remove_color', 'add_time', 'add_moves', 'replace_color', 'shuffle', 'bomb', 'lightning', 'rainbow'],
            maxCompositionDepth: 3,
            maxEffectsPerComposition: 5,
          },
          advanced: {
            effectScriptEnabled: true,
            customEffectAllowed: true,
            effectCodeEnabled: true,
            allowedOperators: ['sequence', 'parallel', 'chain'],
            maxScriptDepth: 5,
          },
        },
      },
    });

    // ═══════════════════════════════════════════════════════════════
    // ZUMA 祖玛游戏专用道具 Schema
    // ═══════════════════════════════════════════════════════════════
    this.registerSchema({
      name: 'zuma-powerup',
      version: '1.0.0',
      description: '祖玛游戏道具 — 玩家可创建各种改变弹珠链、分数、速度的增益道具（支持3级创作模式）',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '道具名称' },
          effect: {
            type: 'string',
            description: '效果类型（中级/高级模式可为任意已注册效果）',
          },
          params: {
            type: 'object',
            description: '效果参数（根据效果类型不同）',
            properties: {
              bonus: { type: 'number', description: 'add_score 增加的分数 (5-50)', minimum: 5, maximum: 50 },
              color: {
                type: 'string',
                description: '颜色 (深绿/青蓝/浅绿/浅蓝/米色)',
                enum: ['#0C3406', '#077187', '#74A57F', '#ABD8CE', '#E4C5AF'],
              },
              count: { type: 'number', description: 'remove_tail 移除的弹珠数 (1-10)', minimum: 1, maximum: 10 },
              multiplier: { type: 'number', description: 'score_multiplier 分数倍率 (2-5)', minimum: 2, maximum: 5 },
            },
          },
          description: { type: 'string', description: '道具描述' },
          icon: { type: 'string', description: '道具图标 emoji' },
          effectCode: {
            type: 'string',
            description: '自定义效果函数体（仅高级模式）。function(params){...} 格式的 JS 函数代码字符串，运行时在游戏沙箱中执行。可用变量：game(Zuma实例)、gameState(游戏状态对象)、marbles(弹珠链表数组)、Math、JSON、console。返回值格式：{ message: string, error?: boolean }',
          },
          effectScript: {
            type: 'object',
            description: '效果组合脚本（中级/高级模式）。支持 sequence/parallel/chain 操作符组合多个效果',
            properties: {
              op: { type: 'string', description: '操作符: sequence(顺序) | parallel(并行) | chain(链式)' },
              effects: {
                type: 'array',
                description: '子效果列表',
                items: {
                  type: 'object',
                  properties: {
                    effect: { type: 'string', description: '效果名' },
                    params: { type: 'object', description: '效果参数' },
                    op: { type: 'string', description: '嵌套操作符' },
                    effects: { type: 'array', description: '嵌套子效果' },
                  },
                },
              },
            },
          },
        },
        required: ['name'],
      },
      outputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          effect: { type: 'string' },
          params: { type: 'object' },
          description: { type: 'string' },
          icon: { type: 'string' },
          effectScript: { type: 'object' },
          effectCode: { type: 'string' },
          createdAt: { type: 'string' },
        },
      },
      adapters: {},
      examples: [
        {
          name: '加分宝石',
          effect: 'add_score',
          params: { bonus: 20 },
          description: '立即获得 20 分',
          icon: '✨',
        },
        {
          name: '清色炸弹',
          effect: 'clear_color',
          params: { color: '#0C3406' },
          description: '清除所有深绿色弹珠',
          icon: '💥',
        },
        {
          name: '减速陷阱',
          effect: 'slow_chain',
          params: {},
          description: '弹珠链大幅减速 10 秒',
          icon: '🐌',
        },
        {
          name: '剪刀',
          effect: 'remove_tail',
          params: { count: 5 },
          description: '移除弹珠链尾部 5 个弹珠',
          icon: '✂️',
        },
        {
          name: '反转宝石',
          effect: 'reverse_chain',
          params: {},
          description: '整条弹珠链反转方向',
          icon: '🔄',
        },
        {
          name: '双倍积分',
          effect: 'score_multiplier',
          params: { multiplier: 2 },
          description: '当前分数翻倍',
          icon: '✨',
        },
        {
          name: '冰冻宝石',
          effect: 'freeze_all',
          params: {},
          description: '弹珠链完全冻结 5 秒',
          icon: '❄️',
        },
        {
          name: '减速+加分',
          effect: 'slow_chain',
          params: {},
          description: '先减速弹珠链，再加 15 分',
          icon: '⏳',
          effectScript: {
            op: 'sequence',
            effects: [
              { effect: 'slow_chain', params: {} },
              { effect: 'add_score', params: { bonus: 15 } },
            ],
          },
        },
        {
          name: '清除绿珠',
          effect: 'clear_green',
          params: {},
          description: '使用 effectCode 自定义效果：清除所有深绿色(#0C3406)弹珠并加分',
          icon: '🟢',
          effectCode: "function(params) {\n  var count = 0;\n  for (var i = marbles.length - 1; i >= 0; i--) {\n    if (marbles[i].marble.Color === '#0C3406') {\n      game.removeMarbleFromDataList(marbles[i].marble, i);\n      count++;\n    }\n  }\n  game.score += count * 5;\n  return { message: '清除了 ' + count + ' 个绿珠！+' + (count*5) + ' 分' };\n}",
        },
      ],
      tags: ['zuma', 'powerup', 'consumable'],
      aiGuide: {
        prompt: '祖玛(Zuma)游戏道具创作系统。这是一个经典的祖玛游戏：一条由彩色弹珠组成的链沿着蜿蜒路径向终点洞穴移动。玩家控制中央的青蛙射手，发射弹珠插入链中，3个或更多同色弹珠相邻时会消除。如果弹珠链到达终点则游戏结束。道具有助于减缓弹珠链、消除弹珠或获得额外分数。',
        availableEffects: ['add_score', 'clear_color', 'slow_chain', 'remove_tail', 'reverse_chain', 'score_multiplier', 'freeze_all'],
        constraints: {
          maxScoreAdd: 50,
          maxTailRemove: 10,
          maxMultiplier: 5,
          validColors: ['#0C3406', '#077187', '#74A57F', '#ABD8CE', '#E4C5AF'],
          totalMarbles: 100,
          initMarbles: 20,
        },
        effectRules: [
          'add_score: 立即增加分数，params.bonus 为 5-50 的整数',
          'clear_color: 清除弹珠链中所有指定颜色的弹珠，params.color 为颜色值（如 #0C3406）。每清除一个加5分',
          'slow_chain: 弹珠链大幅减速 10 秒后恢复原速',
          'remove_tail: 移除弹珠链尾部的 N 个弹珠，params.count 为 1-10。每移除一个加3分',
          'reverse_chain: 整条弹珠链反转方向（位置百分比取反）',
          'score_multiplier: 当前分数乘以倍率，params.multiplier 为 2-5',
          'freeze_all: 弹珠链完全冻结 5 秒后恢复',
        ],
        forbidden: [
          'add_score 不要超过 50 分',
          'remove_tail 不要超过 10 个',
          'score_multiplier 不要超过 5 倍',
          'effectCode: 高级模式可自定义效果函数。函数签名 function(params)，可用变量: game(Zuma实例)、gameState({score,marbleCount,moveSpeed,pathLength})、marbles(弹珠链表数组，每个元素有 marble 和 percent 属性)。返回 { message: string }',
          '不要创建能一次性清除超过 20 个弹珠的道具',
          '不要创建能直接让游戏结束的道具',
        ],
        creationTiers: {
          preset: {
            items: [
              { name: '加分宝石', effect: 'add_score', params: { bonus: 20 }, description: '立即获得 20 分', icon: '✨' },
              { name: '清色炸弹', effect: 'clear_color', params: { color: '#0C3406' }, description: '清除所有深绿色弹珠', icon: '💥' },
              { name: '减速陷阱', effect: 'slow_chain', params: {}, description: '弹珠链大幅减速 10 秒', icon: '🐌' },
              { name: '剪刀', effect: 'remove_tail', params: { count: 5 }, description: '移除尾部 5 个弹珠', icon: '✂️' },
              { name: '反转宝石', effect: 'reverse_chain', params: {}, description: '弹珠链反转方向', icon: '🔄' },
              { name: '冰冻宝石', effect: 'freeze_all', params: {}, description: '弹珠链冻结 5 秒', icon: '❄️' },
            ],
          },
          intermediate: {
            availableEffects: ['add_score', 'clear_color', 'slow_chain', 'remove_tail', 'reverse_chain', 'score_multiplier', 'freeze_all'],
            maxCompositionDepth: 3,
            maxEffectsPerComposition: 5,
          },
          advanced: {
            effectScriptEnabled: true,
            customEffectAllowed: true,
            effectCodeEnabled: true,
            allowedOperators: ['sequence', 'parallel', 'chain'],
            maxScriptDepth: 5,
          },
        },
      },
    });

    // 武器 Schema（通用，保留兼容）
    this.registerSchema({
      name: 'weapon',
      version: '1.0.0',
      description: '标准武器物品定义',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '武器名称' },
          damage: { type: 'number', description: '伤害值', minimum: 1, maximum: 99999 },
          element: { type: 'string', description: '元素属性', enum: ['火', '水', '雷', '风', '土', '光', '暗'] },
          icon: { type: 'string', description: '图标URL或CSS类名' },
          effects: {
            type: 'array',
            description: '特效列表',
            items: {
              type: 'object',
              properties: {
                type: { type: 'string', description: '特效类型' },
                params: { type: 'object', description: '特效参数' },
              },
            },
          },
          recipe: {
            type: 'array',
            description: '合成配方',
            items: {
              type: 'object',
              properties: {
                material: { type: 'string', description: '材料名称' },
                quantity: { type: 'number', description: '所需数量', minimum: 1 },
              },
            },
          },
          rarity: { type: 'string', description: '稀有度', enum: ['common', 'uncommon', 'rare', 'legendary'] },
        },
        required: ['name', 'damage'],
      },
      outputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          damage: { type: 'number' },
          element: { type: 'string' },
          icon: { type: 'string' },
          effects: { type: 'array' },
          recipe: { type: 'array' },
          rarity: { type: 'string' },
          createdAt: { type: 'string' },
        },
      },
      adapters: {},
      examples: [
        {
          name: '烈焰之剑',
          damage: 85,
          element: '火',
          icon: 'fa-fire-sword',
          rarity: 'rare',
          effects: [{ type: 'burn', params: { damagePerSec: 15, duration: 3000 } }],
          recipe: [
            { material: '精铁锭', quantity: 5 },
            { material: '火焰精华', quantity: 3 },
          ],
        },
      ],
      tags: ['equipment', 'combat'],
      aiGuide: {
        prompt: '这是传统RPG游戏的武器创作系统。武器分为物理和元素两类。物理武器包含剑、斧、弓等，元素武器拥有火/水/雷/风/土/光/暗属性。武器可以附带最多2个特效，特效之间可能存在组合反应。',
        constraints: {
          damageRange: [10, 500],
          maxEffectsPerItem: 2,
          validElements: ['火', '水', '雷', '风', '土', '光', '暗'],
        },
        availableEffects: ['burn', 'freeze', 'shock', 'bleed', 'lifesteal', 'armor_break', 'poison'],
        effectRules: [
          '火+雷 = 超载：额外40%范围伤害',
          '水+雷 = 感电增强：弹跳目标+2',
          '火+水 = 蒸发：第一击伤害翻倍',
          '风+任何元素 = 扩散：效果范围+50%',
        ],
        forbidden: [
          '不要给武器设置超过2个特效',
          '吸血效果不能超过15%',
          '不要创造4个元素以上的组合',
          '防具类不要设置damage属性',
        ],
      },
    });

    // 商店 Schema
    this.registerSchema({
      name: 'shop',
      version: '1.0.0',
      description: '标准游戏商店定义',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '商店名称' },
          description: { type: 'string', description: '商店描述' },
          items: {
            type: 'array',
            description: '商品列表',
            items: {
              type: 'object',
              properties: {
                itemName: { type: 'string', description: '商品名称' },
                price: { type: 'number', description: '价格', minimum: 0 },
                currencyType: { type: 'string', description: '货币类型', enum: ['gameCoins', 'diamonds', 'cash'] },
                stock: { type: 'number', description: '库存（-1为无限）' },
              },
            },
          },
        },
        required: ['name', 'items'],
      },
      outputSchema: {
        type: 'object',
        properties: {
          shopId: { type: 'string' },
          name: { type: 'string' },
          description: { type: 'string' },
          items: { type: 'array' },
          createdAt: { type: 'string' },
        },
      },
      adapters: {},
      examples: [
        {
          name: '铁匠铺',
          description: '出售各种武器和防具',
          items: [
            { itemName: '铁剑', price: 500, currencyType: 'gameCoins', stock: 10 },
            { itemName: '钢盾', price: 800, currencyType: 'gameCoins', stock: 5 },
          ],
        },
      ],
      tags: ['economy', 'ui'],
      aiGuide: {
        prompt: '这是游戏内商店定义系统。商店可以包含多个商品，每个商品有名称、价格、货币类型和库存量。库存为-1表示无限供应。货币类型支持gameCoins(游戏币)、diamonds(钻石)和cash(现金)。',
        constraints: {
          validElements: ['gameCoins', 'diamonds', 'cash'],
        },
        forbidden: [
          '商品价格不应为负数',
          '库存数量应为非负整数（-1表示无限）',
        ],
      },
    });

    // 任务 Schema
    this.registerSchema({
      name: 'quest',
      version: '1.0.0',
      description: '标准任务/挑战定义',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '任务标题' },
          description: { type: 'string', description: '任务描述' },
          objectives: {
            type: 'array',
            description: '任务目标',
            items: {
              type: 'object',
              properties: {
                type: { type: 'string', description: '目标类型', enum: ['kill', 'collect', 'reach', 'survive'] },
                target: { type: 'string', description: '目标对象' },
                count: { type: 'number', description: '目标数量', minimum: 1 },
              },
            },
          },
          rewards: {
            type: 'object',
            properties: {
              exp: { type: 'number' },
              gameCoins: { type: 'number' },
              items: { type: 'array', items: { type: 'string' } },
            },
          },
        },
        required: ['title', 'objectives'],
      },
      outputSchema: {
        type: 'object',
        properties: {
          questId: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string' },
          objectives: { type: 'array' },
          rewards: { type: 'object' },
        },
      },
      adapters: {},
      examples: [
        {
          title: '消灭哥布林',
          description: '森林里的哥布林越来越猖獗了，去消灭它们！',
          objectives: [
            { type: 'kill', target: '哥布林', count: 10 },
          ],
          rewards: { exp: 100, gameCoins: 200 },
        },
      ],
      tags: ['content', 'progression'],
      aiGuide: {
        prompt: '这是RPG游戏的任务/挑战创建系统。任务可以有多个目标（击败敌人、收集物品、到达地点、生存），并配有经验值和金币奖励。',
        availableEffects: ['kill', 'collect', 'reach', 'survive'],
        constraints: {
          validElements: ['kill', 'collect', 'reach', 'survive'],
        },
        forbidden: [
          '任务目标数量至少为1',
          '奖励不应过于夸张（经验≤10000，金币≤100000）',
        ],
      },
    });
  }

  // ==================== 内部工具 ====================

  /**
   * 递归校验数据是否符合 JSON Schema
   */
  private validateAgainstSchema(
    schema: JSONSchema,
    data: any,
    path: string
  ): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!schema || !schema.type) {
      return { valid: true, errors: [] };
    }

    // 检查类型
    if (schema.type === 'object') {
      if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        errors.push(`${path}: 期望 object，实际为 ${typeof data}`);
        return { valid: false, errors };
      }

      // 检查必需字段
      if (schema.required) {
        for (const key of schema.required) {
          if (!(key in data)) {
            errors.push(`${path}.${key}: 缺少必需字段`);
          }
        }
      }

      // 递归检查属性
      if (schema.properties) {
        for (const [key, propSchema] of Object.entries(schema.properties)) {
          if (key in data) {
            const result = this.validateAgainstSchema(propSchema, data[key], `${path}.${key}`);
            errors.push(...result.errors);
          }
        }
      }
    } else if (schema.type === 'array') {
      if (!Array.isArray(data)) {
        errors.push(`${path}: 期望 array，实际为 ${typeof data}`);
        return { valid: false, errors };
      }

      if (schema.items) {
        for (let i = 0; i < data.length; i++) {
          const result = this.validateAgainstSchema(schema.items, data[i], `${path}[${i}]`);
          errors.push(...result.errors);
        }
      }
    } else if (schema.type === 'number' || schema.type === 'integer') {
      if (typeof data !== 'number') {
        errors.push(`${path}: 期望 number，实际为 ${typeof data}`);
      } else {
        if (schema.minimum !== undefined && data < schema.minimum) {
          errors.push(`${path}: 值 ${data} 小于最小值 ${schema.minimum}`);
        }
        if (schema.maximum !== undefined && data > schema.maximum) {
          errors.push(`${path}: 值 ${data} 大于最大值 ${schema.maximum}`);
        }
      }
    } else if (schema.type === 'string') {
      if (typeof data !== 'string') {
        errors.push(`${path}: 期望 string，实际为 ${typeof data}`);
      } else {
        if (schema.enum && !schema.enum.includes(data)) {
          errors.push(`${path}: "${data}" 不在允许值 [${schema.enum.join(', ')}] 中`);
        }
      }
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * 判断两个 Schema 是否可以自动转换
   */
  private canAutoConvert(from: string, to: string): boolean {
    const fromSchema = this.getSchema(from);
    const toSchema = this.getSchema(to);

    if (!fromSchema || !toSchema) return false;

    // 检查输出结构与输入结构是否兼容（简化版）
    const fromProps = Object.keys(fromSchema.outputSchema.properties || {});
    const toInputProps = Object.keys(toSchema.inputSchema.properties || {});

    // 如果目标输入包含大部分源输出的字段，认为是兼容的
    const common = fromProps.filter(p => toInputProps.includes(p));
    return common.length >= Math.min(fromProps.length, toInputProps.length) * 0.5;
  }
}

// ==================== 单例导出 ====================

let defaultRegistry: SchemaRegistry | null = null;

export function getDefaultRegistry(): SchemaRegistry {
  if (!defaultRegistry) {
    defaultRegistry = new SchemaRegistry();
  }
  return defaultRegistry;
}

export function resetDefaultRegistry(): void {
  defaultRegistry = null;
}

export const schemaRegistry = getDefaultRegistry();
