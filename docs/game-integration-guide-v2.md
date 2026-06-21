# AllinONE 游戏开发者对接指南 v2.0

> **版本**: v2.0
> **日期**: 2026-06-11
> **目标读者**: 接入 AllinONE OpenGames 平台的游戏开发者
> **前置文档**: `game-capability-declaration.md`（基础对接，本文档在此基础上扩展）

---

## 目录

1. [架构概览](#1-架构概览)
2. [基础对接（3 步完成）](#2-基础对接)
3. [effectCode 自定义效果（进阶）](#3-effectcode-自定义效果)
4. [安全沙箱规范](#4-安全沙箱规范)
5. [Schema 能力声明](#5-schema-能力声明)
6. [完整示例：RPG 游戏](#6-完整示例rpg-游戏)
7. [检查清单](#7-检查清单)

---

## 1. 架构概览

AllinONE 平台的道具体系分为 **两个层级**：

```
层级 1：数据道具（所有游戏自动支持）
├── 玩家创建 JSON → 平台校验 → 凭证铸造 → 下发游戏 → ItemFactory.create()
└── 游戏开发者只写一个工厂函数，数据变游戏对象

层级 2：effectCode 自定义效果（游戏需实现运行时）
├── 玩家创建 JSON + effectCode 函数 → 平台校验 → 凭证铸造 → 下发游戏
├── 游戏端编译 effectCode → 注册到效果系统 → 使用时执行
└── 玩家可创造游戏内不存在的全新效果类型
```

### 通信架构

```
┌──────────────────────────────────────────────────┐
│  AllinONE 平台（父页面 GamePlay.tsx）               │
│                                                  │
│  ProtocolEngine ←→ iframe (游戏)                   │
│  ├─ REDEEM_ITEM / REDEEM_RESULT（兑换码）           │
│  └─ EXTENSION_VOUCHER（UGC 道具下发）               │
│      └─ voucher.data = { name, effect, params,   │
│          effectScript, effectCode }               │
└──────────────────────────────────────────────────┘
```

---

## 2. 基础对接

> 预估时间：约 2 小时。详见 `game-capability-declaration.md`。

### Step 1：编写能力声明 `game-capabilities.json`

声明你的游戏支持哪些道具 Schema、效果列表、数值约束。平台 AI 据此校验玩家创建的道具。

### Step 2：实现 `ItemFactory`

将 Schema 数据转为游戏对象：

```javascript
ItemFactory.register('weapon', (data) => {
  return gameWorld.createWeapon({
    name: data.name,
    attack: data.damage,
    element: data.element || 'physical',
    effects: data.effects || [],
    source: 'ugc',
  });
});
```

### Step 3：注册 EXTENSION_VOUCHER 监听

**方式 A：使用 SDK（推荐）**

```javascript
import { ProtocolClient } from '@allinone/standard-sdk/protocol';
import { ItemFactory } from './ItemFactory';

const client = new ProtocolClient({
  gameId: 'my-rpg-game',
  supportedSchemas: ['weapon', 'armor', 'potion'],
});
await client.initialize();

client.on('voucher', (payload) => {
  if (payload.type !== 'game_extension') return;
  const item = ItemFactory.create(payload.schemaName, payload.data);
  if (item) playerInventory.add(item);
});
```

**方式 B：inject 模式（平台自动注入 SDK，无需任何依赖）**

```javascript
// 游戏只需监听 postMessage
window.addEventListener('message', function(e) {
  if (e.data && e.data.type === 'EXTENSION_VOUCHER') {
    var v = e.data.voucher;
    if (!v || !v.data) return;
    var data = v.data;

    // 1. 检查是否包含 effectCode（自定义效果）
    if (data.effectCode) {
      registerDynamicEffect(data.effect, data.effectCode);
      customItems.push({
        id: v.id, name: data.name, effect: data.effect,
        params: data.params, effectCode: data.effectCode,
      });
    }
    // 2. 普通数据道具
    else if (data.effect) {
      var item = ItemFactory.create(v.schemaName || 'default', data);
      if (item) playerInventory.add(item);
    }
  }
});
```

---

## 3. effectCode 自定义效果

### 3.1 什么是 effectCode？

`effectCode` 是一个 **JavaScript 函数表达式字符串**，由玩家在道具工坊中创建，随道具 JSON 一起打包下发到游戏。游戏运行时在安全沙箱中编译并执行，实现全新的效果逻辑。

**一个完整的道具 JSON 示例：**

```json
{
  "name": "随机宝石",
  "effect": "randomize_cell",
  "params": { "target": "selected" },
  "description": "将选中的宝石随机变色",
  "effectCode": "function(params, row, col) {\n  var colors = ['red','blue','green'];\n  board[row][col].color = colors[Math.floor(Math.random()*3)];\n  return { matches: [], boardEffect: function(){ renderBoard(false); } };\n}"
}
```

### 3.2 数据流

```
玩家 → 道具工坊创建 JSON+effectCode
  → 平台 Schema 校验（effectCode ≤ 4000字符，安全关键词检查）
  → 铸造为凭证 → EXTENSION_VOUCHER 下发
  → 游戏接收 → 保存 effectCode 字符串
  → 玩家使用道具时 → 编译 effectCode → 注入沙箱变量 → 执行
```

### 3.3 游戏开发者需要实现什么？

你的游戏需要实现一个 **效果运行时引擎**（约 50-80 行代码），核心是三件事：

| 步骤 | 内容 | 你的选择 |
|------|------|----------|
| ① 定义沙箱 API | 决定 effectCode 函数能访问哪些游戏变量 | 你的游戏世界暴露什么 |
| ② 编译 & 注册 | 用 `new Function()` 编译字符串，注册到效果表 | 照搬模板即可 |
| ③ 声明契约 | 在 Schema 的 `aiGuide.effectCode` 中告诉 AI 沙箱里有什么 | 让 AI 正确生成代码 |

---

## 4. 安全沙箱规范

### 4.1 平台侧已实施的安全校验

平台在 `validateDataForTier()` 中对 `effectCode` 做如下检查：

| 检查项 | 规则 |
|--------|------|
| 长度限制 | ≤ 4000 字符 |
| 必须指定 effect | `effect` 字段不能为空 |
| 关键词黑名单 | `eval(`、`new Function`、`import(`、`require(`、`__proto__`、`window.`、`document.`、`parent.`、`fetch(`、`XMLHttpRequest`、`WebSocket`、`Worker(`、`localStorage`、`sessionStorage` |

### 4.2 游戏侧沙箱实现模板

以下是一个通用的安全沙箱模板，**可直接复制到你游戏中使用**（约 60 行）：

```javascript
/**
 * 通用 effectCode 沙箱引擎
 *
 * @param {string} effectName   - 效果名称（如 'randomize_cell'）
 * @param {string} effectCodeStr - effectCode 函数体字符串
 * @param {object} sandbox      - 你的游戏注入的沙箱变量
 *                                如 { player, enemies, world, Math, JSON }
 * @param {object} effectTable  - 你的游戏效果注册表
 * @returns {boolean} 是否注册成功
 */
function registerDynamicEffect(effectName, effectCodeStr, sandbox, effectTable) {
  // 1. 如果已注册（内置效果或缓存），跳过
  if (effectTable[effectName]) return true;

  // 2. 基本校验
  if (!effectCodeStr || typeof effectCodeStr !== 'string') return false;
  if (effectCodeStr.length > 4000) {
    console.warn('[GameSDK] effectCode 超过长度限制:', effectName);
    return false;
  }

  // 3. 安全关键词检查
  var blocked = [
    'eval(', 'new function', 'import(', 'require(', '__proto__',
    'prototype', 'constructor', 'window.', 'document.',
    'parent.', 'top.', 'globalthis', 'self.',
    'fetch(', 'xmlhttprequest', 'websocket', 'worker(',
    'localstorage', 'sessionstorage', 'cookie',
    'alert(', 'confirm(', 'prompt(',
    'settimeout', 'setinterval', 'location'
  ];
  var lowerCode = effectCodeStr.toLowerCase();
  for (var i = 0; i < blocked.length; i++) {
    if (lowerCode.indexOf(blocked[i]) !== -1) {
      console.warn('[GameSDK] effectCode 安全检查失败:', blocked[i]);
      return false;
    }
  }

  // 4. 编译：将沙箱变量作为函数参数注入
  var sandboxKeys = Object.keys(sandbox);
  var sandboxVals = sandboxKeys.map(function(k) { return sandbox[k]; });

  try {
    var sandboxFn = new Function(
      ...sandboxKeys,            // 参数名列表
      'return (' + effectCodeStr + ');'  // 返回函数表达式
    );
    var rawHandler = sandboxFn.apply(null, sandboxVals);

    if (typeof rawHandler !== 'function') {
      console.warn('[GameSDK] effectCode 未返回函数:', effectName);
      return false;
    }

    // 5. 安全包装：try-catch 防止运行时崩溃影响游戏
    var wrappedHandler = function() {
      try {
        return rawHandler.apply(null, arguments);
      } catch (e) {
        console.error('[GameSDK] 自定义效果执行出错:', effectName, e);
        return { error: e.message || String(e) };
      }
    };

    effectTable[effectName] = wrappedHandler;
    console.log('[GameSDK] 动态效果已注册:', effectName);
    return true;
  } catch (e) {
    console.error('[GameSDK] effectCode 编译失败:', effectName, e);
    return false;
  }
}
```

---

## 5. Schema 能力声明

### 5.1 在 `game-capabilities.json` 中声明 effectCode 契约

要让 AI 正确生成 `effectCode`，必须在 Schema 的 `aiGuide` 中声明：

```jsonc
{
  "gameId": "my-rpg-game",
  "schemas": [
    {
      "name": "rpg-skill",
      "version": "1.0.0",
      "description": "RPG 技能创作",
      "aiGuide": {
        "prompt": "这是一个回合制RPG游戏...",

        // ═══ 关键：声明 effectCode 能力 ═══
        "creationTiers": {
          "advanced": {
            "effectScriptEnabled": true,
            "customEffectAllowed": true,
            "effectCodeEnabled": true
          }
        },

        "effectRules": [
          "effectCode 用于创建全新技能效果",
          "effectCode 函数签名: function(params, caster, target)",
          "返回 { damage, heal, statusEffects, message }",
          "沙箱可用: caster, target, battleState, Math, JSON"
        ],

        "forbidden": [
          "effectCode 不超过 4000 字符",
          "禁止修改 caster/target 以外的对象",
          "禁止使用 eval、Function、fetch 等危险 API"
        ]
      },

      "inputSchema": {
        "type": "object",
        "required": ["name", "effect"],
        "properties": {
          "name": { "type": "string" },
          "effect": { "type": "string", "description": "效果名称" },
          "params": { "type": "object" },
          "description": { "type": "string" },
          "effectCode": {
            "type": "string",
            "description": "自定义效果函数体。function(params,caster,target){...} 格式"
          }
        }
      }
    }
  ]
}
```

### 5.2 effectCode 契约三要素

| 要素 | 你需要定义的内容 | 示例（RPG） |
|------|----------------|------------|
| **函数签名** | effectCode 接收什么参数 | `function(params, caster, target)` |
| **沙箱变量** | 注入哪些游戏对象 | `caster`, `target`, `battleState` |
| **返回格式** | 函数必须返回什么 | `{ damage, heal, statusEffects }` |

---

## 6. 完整示例：RPG 游戏

以下是一个完整的回合制 RPG 游戏对接 AllinONE + effectCode 的参考实现。

### 6.1 游戏侧代码

```javascript
// ═══════════════════════════════════════
// RPG 游戏 AllinONE 集成层
// ═══════════════════════════════════════

// ---------- 游戏状态 ----------
var player = { hp: 100, atk: 15, def: 5, buffs: [] };
var enemies = [{ id: 'e1', name: '史莱姆', hp: 50, atk: 8 }];
var battleState = { turn: 1, log: [] };

// ---------- 内置效果表 ----------
var SKILL_HANDLERS = {
  fire_bolt: function(params, caster, target) {
    var dmg = params.baseDamage || 20;
    target.hp -= dmg;
    return { damage: dmg, message: caster.name + ' 发射火球造成 ' + dmg + ' 伤害！' };
  },
  heal: function(params, caster, target) {
    var heal = params.healAmount || 30;
    caster.hp = Math.min(caster.hp + heal, 100);
    return { heal: heal, message: caster.name + ' 恢复了 ' + heal + ' HP！' };
  },
};

// ---------- 沙箱变量（effectCode 能访问的所有变量） ----------
var effectSandbox = {
  player: player,           // 玩家角色
  enemies: enemies,         // 敌人列表
  battleState: battleState, // 战斗状态
  Math: Math,               // 数学对象
  JSON: JSON,               // JSON 对象
  console: console,         // 控制台
};

// ---------- UGC 道具库存 ----------
var customSkills = [];

// ---------- 接收平台道具 ----------
window.addEventListener('message', function(e) {
  if (e.data && e.data.type === 'EXTENSION_VOUCHER') {
    var v = e.data.voucher;
    if (!v || !v.data) return;
    var data = v.data;

    if (data.effect && data.effectCode) {
      // 自定义效果道具：保存 effectCode，使用前再编译
      customSkills.push({
        id: v.id || ('ugc_' + Date.now()),
        name: data.name || (data.effect + '技能'),
        effect: data.effect,
        params: data.params || {},
        effectCode: data.effectCode,
      });
      console.log('[RPG] 自定义技能到账:', data.name, data.effect);
    } else if (data.effect) {
      // 普通数据道具（无 effectCode）
      console.log('[RPG] 数据道具到账:', data.name);
    }
  }
});

// ---------- 使用技能（自动注册 effectCode） ----------
function useSkill(skill) {
  // 1. 检查是否有 effectCode 需要注册
  if (skill.effectCode && !SKILL_HANDLERS[skill.effect]) {
    var ok = registerDynamicEffect(
      skill.effect,
      skill.effectCode,
      effectSandbox,   // ← 注入你定义的沙箱变量
      SKILL_HANDLERS
    );
    if (!ok) {
      console.warn('[RPG] 技能注册失败:', skill.effect);
      return;
    }
  }

  // 2. 执行效果
  var handler = SKILL_HANDLERS[skill.effect];
  if (handler) {
    var target = enemies[0]; // 默认打第一个敌人
    var result = handler(skill.params, player, target);
    console.log('[RPG] 技能结果:', result);
    battleState.log.push(result.message || '技能执行完成');
  }
}
```

### 6.2 AI 生成的 effectCode 示例

玩家在道具工坊中说："我想创造一个吸血斩技能，对敌人造成 25 伤害并回复自身 50% 伤害量的生命"

AI 根据 Schema 的 `effectCode` 契约生成的 JSON：

```json
{
  "name": "吸血斩",
  "effect": "vampiric_slash",
  "params": { "baseDamage": 25, "lifestealRatio": 0.5 },
  "description": "对敌人造成25伤害，回复50%伤害量的HP",
  "effectCode": "function(params, caster, target) {\n  var dmg = params.baseDamage || 25;\n  var ratio = params.lifestealRatio || 0.5;\n  target.hp -= dmg;\n  var heal = Math.floor(dmg * ratio);\n  caster.hp = Math.min(caster.hp + heal, 100);\n  return {\n    damage: dmg,\n    heal: heal,\n    message: caster.name + ' 吸血斩！造成 ' + dmg + ' 伤害，回复 ' + heal + ' HP'\n  };\n}"
}
```

### 6.3 各游戏类型对照表

| 游戏类型 | 函数签名 | 沙箱变量 | 返回格式 |
|----------|---------|---------|---------|
| **消消乐** | `function(params, row, col)` | `board`, `BOARD_SIZE`, `gameStats` | `{ matches, boardEffect, instantMessage }` |
| **回合制 RPG** | `function(params, caster, target)` | `player`, `enemies`, `battleState` | `{ damage, heal, statusEffects, message }` |
| **卡牌游戏** | `function(params, card, gameState)` | `deck`, `hand`, `opponent`, `gameState` | `{ drawCards, damage, effects, message }` |
| **塔防游戏** | `function(params, tower, wave)` | `towers`, `enemies`, `path`, `wave` | `{ damage, slow, areaEffect, message }` |
| **跑酷游戏** | `function(params, player, level)` | `player`, `obstacles`, `coins`, `level` | `{ speed, shield, scoreBonus, message }` |
| **模拟经营** | `function(params, building, city)` | `buildings`, `resources`, `population` | `{ production, cost, upgrades, message }` |

---

## 7. 检查清单

### 基础对接（所有游戏）

| # | 检查项 | 说明 |
|---|--------|------|
| ☐ | 游戏为纯 HTML/CSS/JS | 无 React/Vue 等框架运行时依赖 |
| ☐ | `game-capabilities.json` 已编写 | 包含 Schema、约束、效果列表 |
| ☐ | `ItemFactory` 已实现 | 每种 Schema 对应一个创建函数 |
| ☐ | `EXTENSION_VOUCHER` 监听已注册 | 接收道具时正确解析 `data` |
| ☐ | `__ALLINONE_CONFIG__` 使用字符串拼接 | 避免注入检测跳过 |
| ☐ | 不调用 fetch API | 平台 Skill 系统仅在内存中 |
| ☐ | 独立模式降级 | 无平台时给默认道具数量 |

### effectCode 对接（需要自定义效果的游戏）

| # | 检查项 | 说明 |
|---|--------|------|
| ☐ | 定义了沙箱变量对象 | 明确 effectCode 能访问哪些游戏对象 |
| ☐ | 实现了 `registerDynamicEffect()` | 可使用上方通用模板 |
| ☐ | 安全关键词检查已就位 | 黑名单与平台一致 |
| ☐ | `try-catch` 包裹执行 | 防止自定义代码崩溃游戏 |
| ☐ | Schema 中声明 `effectCodeEnabled: true` | 平台允许高级模式使用 |
| ☐ | `effectRules` 中声明函数签名和返回格式 | AI 据此生成正确代码 |
| ☐ | `forbidden` 中声明安全限制 | AI 知道什么不能做 |
| ☐ | 道具接收时保存 `effectCode` 字符串 | 从 `voucher.data.effectCode` 提取 |
| ☐ | 使用道具时调用 `registerDynamicEffect()` | 首次使用时自动编译注册 |

---

## 附录 A：常见问题

### Q: 我的游戏不需要自定义效果，还需要实现 effectCode 运行时吗？

**不需要。** 如果玩家只使用预定义的效果（如 `fire_bolt`, `heal`），只需实现 `ItemFactory` 即可。effectCode 运行时是可选的进阶功能。

### Q: effectCode 的函数签名必须跟 Match3 一样吗？

**不需要。** 函数签名完全由你的游戏决定。关键是：
1. 你在 `effectRules` 中声明了什么签名
2. 你的 `registerDynamicEffect()` 执行时传什么参数

### Q: 一个游戏可以同时支持多种 Schema 的 effectCode 吗？

**可以。** 例如 RPG 游戏可以同时支持 `rpg-skill`（技能）和 `rpg-equipment`（装备），每种 Schema 有独立的 effectCode 契约和沙箱变量。

### Q: effectCode 编译失败会怎样？

**不影响游戏。** 沙箱模板中的 `try-catch` 会捕获编译错误，控制台输出警告，道具被标记为不可用但不会崩溃。

### Q: 我可以限制 effectCode 的执行频率吗？

**可以。** 在 `wrappedHandler` 中加入节流逻辑即可：

```javascript
var lastExec = 0;
var wrappedHandler = function() {
  if (Date.now() - lastExec < 100) return { message: '冷却中...' };
  lastExec = Date.now();
  return rawHandler.apply(null, arguments);
};
```

---

## 附录 B：相关文件

| 文件 | 说明 |
|------|------|
| `docs/game-capability-declaration.md` | 基础对接文档（Step 1-3） |
| `docs/game-publishing-guide-match3.md` | Match3 游戏发布参考案例 |
| `src/publishing-center/standard-sdk/protocol/ProtocolClient.ts` | 协议客户端 SDK |
| `src/publishing-center/standard-sdk/index.ts` | AllinONEGame SDK 主入口 |
| `src/publishing-center/protocol/SchemaRegistry.ts` | Schema 注册与校验中心 |
| `src/publishing-center/protocol/ProtocolAIBridge.ts` | AI 提示词生成 |
| `src/publishing-center/core/PublishingPipeline.ts` | 发布流水线（SDK 注入） |
| `AllinONE Online/Match3Game_effectcode.html` | Match3 游戏 effectCode 参考实现 |
