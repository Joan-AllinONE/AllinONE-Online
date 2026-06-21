/**
 * 游戏道具工厂（ItemFactory）— 数据驱动道具系统参考实现
 *
 * 这是给游戏开发者的参考代码。
 * 游戏方只需实现一次此工厂，之后所有玩家创作的道具都将秒级生效。
 *
 * 核心原则：不暴露源代码，只声明 Schema SOP + 实现 ItemFactory。
 *
 * 使用方式：
 * 1. 实现 createWeapon / createArmor / ... 方法
 * 2. 注册到 ItemFactory 的 registry 中
 * 3. 在 ProtocolClient 的 on('voucher') 回调中调用 ItemFactory.create()
 *
 * 示例（游戏侧 main.ts）：
 * ```typescript
 * import { ItemFactory } from './ItemFactory';
 *
 * // 注册武器创建函数
 * ItemFactory.register('weapon', (data) => gameWorld.createWeapon({
 *   id: `ugc_${Date.now()}`,
 *   name: data.name,
 *   damage: data.damage,
 *   element: data.element || 'physical',
 *   effects: data.effects || [],
 *   rarity: data.rarity || 'common',
 *   recipe: data.recipe || [],
 *   source: 'ugc',
 * }));
 *
 * // 注册商店创建函数
 * ItemFactory.register('shop', (data) => gameWorld.createShop({
 *   name: data.name,
 *   description: data.description,
 *   items: data.items.map(i => ({ ...i, source: 'ugc' })),
 * }));
 * ```
 */

// ==================== 类型定义 ====================

/** 武器数据（来自 Schema weapon） */
export interface WeaponData {
  name: string;
  damage: number;
  element?: string;
  icon?: string;
  effects?: Array<{ type: string; [key: string]: any }>;
  recipe?: Array<{ material: string; quantity: number }>;
  rarity?: string;
}

/** 商店数据（来自 Schema shop） */
export interface ShopData {
  name: string;
  description?: string;
  items: Array<{
    itemName: string;
    price: number;
    currencyType?: string;
    stock?: number;
  }>;
}

/** 任务数据（来自 Schema quest） */
export interface QuestData {
  title: string;
  description?: string;
  objectives: Array<{
    type: 'kill' | 'collect' | 'reach' | 'survive';
    target: string;
    count: number;
  }>;
  rewards?: {
    exp?: number;
    gameCoins?: number;
    items?: string[];
  };
}

/** 通用道具创建函数签名 */
export type ItemCreateFn = (data: any) => any | null;

// ==================== ItemFactory 类 ====================

export class ItemFactory {
  /** Schema → 创建函数的注册表 */
  private static registry: Map<string, ItemCreateFn> = new Map();

  /**
   * 注册 Schema 对应的创建函数
   * @param schemaName Schema 名称（如 'weapon', 'shop', 'quest'）
   * @param createFn 创建函数，接收平台下发的结构化数据，返回游戏对象
   */
  static register(schemaName: string, createFn: ItemCreateFn): void {
    this.registry.set(schemaName, createFn);
    console.log(`[ItemFactory] ✅ 已注册: ${schemaName}`);
  }

  /**
   * 批量注册多个 Schema
   */
  static registerAll(entries: Record<string, ItemCreateFn>): void {
    for (const [name, fn] of Object.entries(entries)) {
      this.register(name, fn);
    }
  }

  /**
   * 注销 Schema
   */
  static unregister(schemaName: string): void {
    this.registry.delete(schemaName);
    console.log(`[ItemFactory] ❌ 已注销: ${schemaName}`);
  }

  /**
   * 创建道具 — 游戏端核心入口
   *
   * 调用时机：收到平台的 EXTENSION_VOUCHER 消息后
   *
   * @param schemaName Schema 名称
   * @param data 平台下发的结构化数据
   * @returns 游戏对象，或 null（Schema 不支持 / 创建失败）
   */
  static create(schemaName: string, data: any): any | null {
    const createFn = this.registry.get(schemaName);
    if (!createFn) {
      console.warn(`[ItemFactory] ⚠️ 不支持的 Schema: "${schemaName}"。已注册的 Schema: [${Array.from(this.registry.keys()).join(', ')}]`);
      return null;
    }

    try {
      const item = createFn(data);
      if (item) {
        console.log(`[ItemFactory] 🎁 已创建道具: "${schemaName}" → ${data.name || data.title || '(无名)'}`);
      }
      return item;
    } catch (error) {
      console.error(`[ItemFactory] ❌ 创建道具失败:`, error);
      return null;
    }
  }

  /**
   * 安全检查：验证道具数据是否符合预期格式
   * 游戏方可根据自己的规则实现此方法
   */
  static validate(schemaName: string, data: any): string[] {
    const errors: string[] = [];

    switch (schemaName) {
      case 'weapon': {
        if (!data.name) errors.push('缺少武器名称');
        if (typeof data.damage !== 'number' || data.damage <= 0) errors.push('伤害值无效');
        if (data.effects && data.effects.length > 3) errors.push('特效过多（最多3个）');
        break;
      }
      case 'shop': {
        if (!data.name) errors.push('缺少商店名称');
        if (!Array.isArray(data.items)) errors.push('商品列表无效');
        break;
      }
      case 'quest': {
        if (!data.title) errors.push('缺少任务标题');
        if (!Array.isArray(data.objectives) || data.objectives.length === 0) errors.push('任务目标无效');
        break;
      }
    }

    return errors;
  }

  /**
   * 获取已注册的 Schema 列表
   */
  static getRegisteredSchemas(): string[] {
    return Array.from(this.registry.keys());
  }

  /**
   * 检查 Schema 是否已注册
   */
  static hasSchema(schemaName: string): boolean {
    return this.registry.has(schemaName);
  }
}

export default ItemFactory;
