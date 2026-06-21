# 游戏能力声明规范（Game Capability Declaration）

> **版本**: v1.0  
> **日期**: 2026-06-08  
> **目标读者**: 接入 AllinONE OpenGames 的游戏开发者

---

## 核心理念：不给代码，给方法

接入 OpenGames UGC 系统**不需要**游戏开发者暴露源代码，只需：

1. **声明能力**：告诉平台和 AI 你的游戏能做什么（Schema SOP）
2. **实现工厂**：编写一个通用的 `ItemFactory`，将数据变为游戏对象
3. **注册监听**：接收平台推送的 `EXTENSION_VOUCHER`，调用工厂创建

之后，**无论玩家创造多少种新道具，游戏代码都不需要修改**。

---

## 接入总成本：约 2 小时

| 步骤 | 内容 | 预估时间 |
|------|------|----------|
| 1 | 编写 `game-capabilities.json` | 30 分钟 |
| 2 | 实现 `ItemFactory` | 45 分钟 |
| 3 | 在入口注册监听 | 15 分钟 |

---

## Step 1: 编写能力声明文件

在游戏仓库根目录创建 `game-capabilities.json`：

```jsonc
{
  "$schema": "https://allinone.gg/schemas/game-capabilities-v1.json",
  "gameId": "my-rpg-game",
  "version": "1.0.0",

  "schemas": [
    {
      "name": "weapon",
      "version": "1.0.0",
      "description": "标准武器创作",

      // ══════════════════════════════════════
      // AI 可依赖的 SOP — 不泄露源码，只声明规则
      // ══════════════════════════════════════
      "aiGuide": {
        "prompt": "这是一个传统RPG游戏。武器分为物理和元素两类，元素属性包括火/水/雷/风。武器可以附带最多2个特效。",

        "constraints": {
          "damageRange": [10, 500],
          "maxEffectsPerItem": 2,
          "validElements": ["火", "水", "雷", "风", "光", "暗", "物理"]
        },

        "availableEffects": [
          "burn",        // 灼烧：每秒伤害
          "freeze",      // 冰冻：减速
          "shock",       // 感电：连锁伤害
          "bleed",       // 出血：伤害加深
          "lifesteal"    // 吸血
        ],

        "effectRules": [
          "火+雷 = 超载：额外40%范围伤害",
          "水+雷 = 感电增强：弹跳目标+2",
          "火+水 = 蒸发：第一击伤害翻倍"
        ],

        "forbidden": [
          "不要给武器设置超过2个特效",
          "吸血效果不能超过15%",
          "不要创造4个元素以上的组合"
        ]
      },

      // ══════════════════════════════════════
      // 数据 Schema 定义（AI 和平台据此校验）
      // ══════════════════════════════════════
      "inputSchema": {
        "type": "object",
        "required": ["name", "damage"],
        "properties": {
          "name": { "type": "string", "description": "武器名称" },
          "damage": { "type": "number", "minimum": 10, "maximum": 500 },
          "element": { "type": "string", "enum": ["火","水","雷","风","光","暗","物理"] },
          "effects": { "type": "array", "maxItems": 2 },
          "rarity": { "type": "string", "enum": ["common","uncommon","rare","legendary"] },
          "recipe": { "type": "array" }
        }
      }
    }
  ]
}
```

### SOP 字段说明

| 字段 | 类型 | 必须 | 说明 |
|------|------|------|------|
| `prompt` | string | ✅ | AI 生成时的上下文提示（描述世界观、规则风格） |
| `constraints` | object | ✅ | 硬性数值约束 |
| `availableEffects` | string[] | - | 可用的效果/状态类型清单 |
| `effectRules` | string[] | - | 效果组合规则（自然语言，如"火+雷=额外伤害"） |
| `forbidden` | string[] | ✅ | 禁止事项（AI 硬约束） |

---

## Step 2: 实现 ItemFactory

在游戏项目中创建 `ItemFactory.ts`（参考实现可从 `@allinone/standard-sdk/ItemFactory` 导入）：

```typescript
// ItemFactory.ts — 游戏方实现

class ItemFactory {
  // Schema → 创建函数的注册表
  static registry: Record<string, (data: any) => any> = {};

  /**
   * 注册 Schema 对应的创建函数
   */
  static register(schemaName: string, createFn: (data: any) => any) {
    this.registry[schemaName] = createFn;
  }

  /**
   * 创建道具（核心入口，调用频率最高）
   */
  static create(schemaName: string, data: any): any | null {
    const fn = this.registry[schemaName];
    if (!fn) return null;
    return fn(data);
  }
}

// ═══════════════════════════════════════════
// 具体实现：以下例子展示你的游戏逻辑
// ═══════════════════════════════════════════

ItemFactory.register('weapon', (data) => {
  // 游戏方实现：将 Schema 数据转为游戏武器对象
  return {
    id: `ugc_${Date.now()}`,
    name: data.name,
    attack: data.damage,
    element: data.element || 'physical',
    effects: (data.effects || []).map(e => ({
      type: e.type,
      apply(target) {
        switch (e.type) {
          case 'burn': target.applyBurn(e.damagePerSec, e.duration); break;
          case 'freeze': target.applySlow(e.slowPct, e.duration); break;
          case 'shock': target.applyChainLightning(e.targets); break;
        }
      }
    })),
    recipe: data.recipe || [],
    rarity: data.rarity || 'common',
    source: 'ugc',
  };
});

ItemFactory.register('shop', (data) => {
  return gameWorld.createShop({
    name: data.name,
    items: data.items.map(i => ({
      name: i.itemName,
      price: i.price,
      currency: i.currencyType || 'gameCoins',
    })),
  });
});

ItemFactory.register('quest', (data) => {
  return gameWorld.createQuest({
    title: data.title,
    description: data.description,
    objectives: data.objectives,
    rewards: data.rewards,
  });
});
```

**关键点**：
- `ItemFactory.create()` 只依赖 `data`，不依赖任何预定义的 ID 或枚举
- 新增 Schema 类型只需新增一个 `register()` 调用
- 现有道具逻辑完全不受影响

---

## Step 3: 注册监听

在游戏入口文件（如 `main.ts`）中：

```typescript
import { ProtocolClient } from '@allinone/standard-sdk/protocol';
import { ItemFactory } from './ItemFactory';

// 1. 初始化协议客户端，声明支持哪些 Schema
const client = new ProtocolClient({
  gameId: 'my-rpg-game',
  mode: 'integrated',
  supportedSchemas: ['weapon', 'shop', 'quest'],
  supportedActions: ['pause', 'resume'],
});

await client.initialize();

// 2. 监听平台推送的 UGC 道具（唯一需要写的监听代码）
client.on('voucher', (payload) => {
  if (payload.type !== 'game_extension') return;

  const item = ItemFactory.create(
    payload.schemaName,   // 如 'weapon'
    payload.data           // { name: "天罚", damage: 180, ... }
  );

  if (item) {
    playerInventory.add(item);
    showToast(`🎁 获得道具: ${item.name}`);
    console.log(`[UGC] 道具已创建: ${item.name}`, item);
  } else {
    console.warn(`[UGC] 不支持的 Schema: ${payload.schemaName}`);
  }
});

console.log('✅ UGC 道具系统就绪 — 新道具实时生效，无需重新发布游戏');
```

---

## 完整端到端流程

```
  玩家: "我想创造一把传说级的雷剑..."
    |
    v
┌─ 平台 AI 桥梁 ────────────────────────┐
│ 1. 读取 game-capabilities.json SOP    │
│ 2. 约束校验：伤害[10,500]、最多2特效    │
│ 3. 生成数据：{ name:"天罚", damage:180 } │
│ 4. Schema 校验 → 通过                  │
│ 5. 创建 ExtensionVoucher               │
└───────────────────────────────────────┘
    |
    | postMessage('EXTENSION_VOUCHER', {...})
    v
┌─ 游戏侧（毫秒级生效！）───────────────┐
│ 1. ProtocolClient.on('voucher')      │
│ 2. ItemFactory.create('weapon', data) │
│ 3. playerInventory.add(item)          │
│                                       │
│ ⏱ 总耗时: < 100ms                     │
│ 🚀 不需要重新发布                      │
└───────────────────────────────────────┘
```

---

## FAQ

### Q: 我需要对现有代码做什么改动？
**A: 零改动。** ItemFactory 和 voucher 监听是纯新增代码，不影响现有武器/道具系统。

### Q: 玩家创造的道具会影响游戏平衡吗？
**A:** AI 桥梁会严格按你声明的 SOP（`constraints` 和 `forbidden`）生成数据。此外，你可以在 `ItemFactory.create()` 中添加自己的校验逻辑。

### Q: 如果我不想支持某类 Schema 怎么办？
**A:** 不注册即可。如果游戏不在 `supportedSchemas` 中声明某 Schema，平台不会下发该类型道具。

### Q: 我能看到哪些 Schema 已经被平台内置了吗？
**A:** 目前内置 `weapon`、`shop`、`quest` 三种。你也可以通过 `SchemaRegistry` 注册自定义 Schema。

### Q: 一个道具可以在不同游戏中流转吗？
**A:** 可以。平台的 `ExtensionVoucher.adaptForGame()` 支持跨游戏适配。只要目标游戏声明了兼容的 Schema，数据会自动转换。
