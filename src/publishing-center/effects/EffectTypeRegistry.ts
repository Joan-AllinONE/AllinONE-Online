/**
 * 效果类型注册表
 *
 * 提供可扩展的效果类型定义系统。
 * 开发者可通过 register() 注册自定义效果类型，
 * PublishingCenter 和 PublishingPipeline 从注册表获取类型信息。
 */

// ==================== 类型定义 ====================

/** 效果参数定义 */
export interface EffectParameter {
  key: string;                    // 参数键名
  label: string;                  // 显示标签
  type: 'number' | 'string' | 'select' | 'boolean';  // 参数类型
  defaultValue: any;              // 默认值
  min?: number;                   // 最小值 (number type)
  max?: number;                   // 最大值 (number type)
  step?: number;                  // 步进 (number type)
  options?: { value: string; label: string }[];  // 选项 (select type)
  description?: string;           // 参数说明
}

/** 效果类型定义 */
export interface EffectTypeDefinition {
  id: string;                     // 效果类型ID (e.g., 'difficulty_reducer')
  name: string;                   // 显示名称 (e.g., '难度降低')
  icon: string;                   // 图标 (e.g., '🎯')
  description: string;            // 描述
  category: 'gameplay' | 'scoring' | 'resource' | 'time' | 'custom';  // 分类
  isAutoExecute: boolean;         // 是否自动执行（无需游戏方配合）
  parameters: EffectParameter[];  // 参数定义
  defaultEffects: Record<string, any>;  // 默认效果参数
}

// ==================== 注册表类 ====================

class EffectTypeRegistryClass {
  private types = new Map<string, EffectTypeDefinition>();

  /** 注册一个效果类型 */
  register(definition: EffectTypeDefinition): void {
    this.types.set(definition.id, definition);
  }

  /** 获取效果类型定义 */
  get(id: string): EffectTypeDefinition | undefined {
    return this.types.get(id);
  }

  /** 获取所有效果类型 */
  getAll(): EffectTypeDefinition[] {
    return Array.from(this.types.values());
  }

  /** 按分类获取效果类型 */
  getByCategory(category: EffectTypeDefinition['category']): EffectTypeDefinition[] {
    return this.getAll().filter(t => t.category === category);
  }

  /** 获取所有自动执行的效果类型 */
  getAutoExecuteTypes(): EffectTypeDefinition[] {
    return this.getAll().filter(t => t.isAutoExecute);
  }

  /** 获取分类列表 */
  getCategories(): { id: EffectTypeDefinition['category']; name: string }[] {
    return [
      { id: 'gameplay', name: '游戏玩法' },
      { id: 'scoring', name: '分数计分' },
      { id: 'resource', name: '资源生命' },
      { id: 'time', name: '时间相关' },
      { id: 'custom', name: '自定义' },
    ];
  }

  /** 检查效果类型是否已注册 */
  has(id: string): boolean {
    return this.types.has(id);
  }
}

// ==================== 单例 ====================

export const effectTypeRegistry = new EffectTypeRegistryClass();

// ==================== 注册内置效果类型 ====================

effectTypeRegistry.register({
  id: 'difficulty_reducer',
  name: '难度降低',
  icon: '🎯',
  description: '自动降低游戏速度（时间膨胀慢放），不跳帧，画面流畅但动作变慢',
  category: 'gameplay',
  isAutoExecute: true,
  parameters: [
    {
      key: 'multiplier',
      label: '速度倍率',
      type: 'number',
      defaultValue: 0.6,
      min: 0.1,
      max: 1.0,
      step: 0.1,
      description: '游戏速度倍率（0.1=极慢, 1.0=正常速度）',
    },
  ],
  defaultEffects: { multiplier: 0.6 },
});

effectTypeRegistry.register({
  id: 'speed_boost',
  name: '速度提升',
  icon: '⚡',
  description: '自动加速游戏帧率，通过时间缩放实现加速效果',
  category: 'gameplay',
  isAutoExecute: true,
  parameters: [
    {
      key: 'multiplier',
      label: '加速倍率',
      type: 'number',
      defaultValue: 1.5,
      min: 1.0,
      max: 3.0,
      step: 0.1,
      description: '帧率加速倍率（1.0=正常, 2.0=双倍速）',
    },
    {
      key: 'duration',
      label: '持续时间(ms)',
      type: 'number',
      defaultValue: 30000,
      min: 5000,
      max: 300000,
      step: 5000,
      description: '加速效果持续时间（毫秒）',
    },
  ],
  defaultEffects: { multiplier: 1.5, duration: 30000 },
});

effectTypeRegistry.register({
  id: 'score_boost',
  name: '分数加成',
  icon: '🌟',
  description: '自动扫描并加倍游戏分数相关变量',
  category: 'scoring',
  isAutoExecute: true,
  parameters: [
    {
      key: 'multiplier',
      label: '分数倍率',
      type: 'number',
      defaultValue: 2,
      min: 1,
      max: 10,
      step: 1,
      description: '分数乘数（2=双倍分数）',
    },
  ],
  defaultEffects: { multiplier: 2 },
});

effectTypeRegistry.register({
  id: 'extra_life',
  name: '额外生命',
  icon: '❤️',
  description: '自动扫描并增加生命值相关变量',
  category: 'resource',
  isAutoExecute: true,
  parameters: [
    {
      key: 'lives',
      label: '增加生命数',
      type: 'number',
      defaultValue: 1,
      min: 1,
      max: 99,
      step: 1,
      description: '增加的生命值数量',
    },
  ],
  defaultEffects: { lives: 1 },
});

effectTypeRegistry.register({
  id: 'time_bonus',
  name: '时间奖励',
  icon: '⏱️',
  description: '自动扫描并增加倒计时相关变量',
  category: 'time',
  isAutoExecute: true,
  parameters: [
    {
      key: 'bonusTime',
      label: '增加秒数',
      type: 'number',
      defaultValue: 30,
      min: 5,
      max: 999,
      step: 5,
      description: '增加的倒计时秒数',
    },
  ],
  defaultEffects: { bonusTime: 30 },
});

effectTypeRegistry.register({
  id: 'custom',
  name: '自定义',
  icon: '📦',
  description: '仅透传数据，需游戏方自行监听 allinone:item-redeemed 事件处理',
  category: 'custom',
  isAutoExecute: false,
  parameters: [],
  defaultEffects: {},
});

export default effectTypeRegistry;
