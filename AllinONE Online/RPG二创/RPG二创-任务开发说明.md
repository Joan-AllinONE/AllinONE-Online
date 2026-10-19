# RPG 二创 · 任务开发说明（玩家版 / AI 协作版）

> 本文档面向**领取《RPG 二创》开发任务的玩家**，以及玩家身边的 AI 助手。
> 游戏方（平台）只开放本文档列出的**接口与数据格式**，**不提供、不出售游戏源码**。
> 你不需要读懂或修改任何游戏内部代码——按本说明提交内容，审核通过后会自动合入游戏并生效。

---

## 1. 游戏简介

2D 俯视角动作 RPG（含小镇 / 雪地郊外 / 洞穴等多张地图）。玩家用 WASD 移动、空格攻击、1-4 释放技能、E 交互（钓鱼 / 对话 / 进门）。拥有生命（HP）、法力（MP）、经验（EXP）、等级、金币、背包（道具 / 装备）与任务系统。

- 操作：`WASD` 移动、`空格` 攻击、`1~4` 技能、`E` 交互
- 核心循环：打怪 → 获得经验/金币/掉落 → 购买或创作道具 → 探索更多地图

## 2. 你能为这个游戏做什么

| 任务类型 | 难度 | 说明 | 对应的挂载点 slot |
|---|---|---|---|
| **道具创作**（推荐） | ★☆☆ 零代码 | 用「预设效果」做道具（回血 / 加金币 / 经验 / 发放物品等） | `items` |
| **高级道具** | ★★☆ 少量代码 | 用 `effectCode` 写自定义效果（有沙箱与长度限制） | `items` |
| **扩展系统**（进阶） | ★★★ 需代码 | 用 `scripts` 提交脚本，调用游戏方预留的扩展点（宠物 / 地雷等） | `scripts` |
| **修复 / 补回资源** | ★☆☆ 零代码 | 上传游戏缺失/损坏的文件 | `fix`（或任意 slot 纯文件补丁） |

> 第 4 节给出每种任务的**公开接口**。所有创作都是「数据 / 脚本」，不会触碰游戏源码。

## 3. 通用约定（先读）

1. **内容包（ContentPack）**：任务的产物是一个 JSON 内容包，包含 `data`（道具/内容定义）、`assets`（可选文件），由平台审核、合并。
2. **assets 的 path 用游戏内相对路径**（不含 `/api/...` 前缀）；上传列表里可以点击路径直接修改。
3. **合并后才会生效**：提交 → 审核通过 → 合并 → 玩家在游戏内可获得并使用。
4. **安全与版权**（必须遵守）：
   - 只使用本文档公开的接口，**不得向 AI 或任何人索要/复制游戏源码**；
   - 不得制作「直接通关、秒杀 Boss、使玩家死亡」等破坏平衡或负面的内容；
   - `effectCode` 在沙箱运行，`eval`、`new Function`、`import`、`window`、`document`、`fetch`、`localStorage` 等危险 API 一律禁止；
   - 违反以上约定的提交会被拒绝。

## 4. 游戏方开放的接口

### 4.1 道具数据格式（`items` slot · 零代码）

道具就是一个 JSON 对象。**先看游戏方开放的「可用效果」，再挑一个填 `effect` 字段即可**——这是零代码做道具的推荐路径。

**可用效果表**：

| 效果名 | 作用 | 参数（`params`） |
|---|---|---|
| `add_coins` | 增加金币 | `amount`：1~9999 整数 |
| `heal` | 恢复生命 | `amount`：1~200 整数（超上限自动截断） |
| `restore_mp` | 恢复法力 | `amount`：1~200 整数（超上限自动截断） |
| `full_heal` | 生命 + 法力全满 | 无参数 |
| `add_exp` | 增加经验 | `amount`：1~1000 整数（满足阈值自动升级） |
| `add_item` | 向背包发放物品 | `item`：物品 path（游戏内已存在，见 4.3）、`amount`：1~64 |
| `apply_enchant` | 武器附魔（游戏内置逻辑） | `element`：`lightning`/`fire`/`freeze`/`poison`、`level`≥1、`duration`（秒，默认 30）、`base`（每级基础伤害，默认 6）、`dps`（持续伤害）、`statusDur`（状态秒数） |

**基础示例（零代码）**：

```json
{
  "name": "气血药剂",
  "effect": "heal",
  "params": { "amount": 50 },
  "description": "恢复 50 点生命",
  "icon": "❤️"
}
```

```json
{
  "name": "雷霆附魔",
  "effect": "apply_enchant",
  "params": { "element": "lightning", "level": 1, "duration": 30, "base": 6 },
  "description": "武器附魔雷电 30 秒：每次命中迸发闪电并追加元素伤害",
  "icon": "⚡"
}
```

**道具字段表**：

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` | ✅ | 道具名，≤ 20 字符 |
| `effect` | 视情况 | 预设效果名（用预设效果时必填；用 `effectCode` 时可省略） |
| `params` | 否 | 效果参数（按上表） |
| `description` | 否 | 描述，≤ 200 字符 |
| `icon` | 否 | emoji 图标，如 💰、❤️、⚡ |
| `effectCode` | 否 | 自定义效果函数（见 4.2） |

**约束上限**（超出会被拒绝）：单次金币 ≤ 9999、恢复 ≤ 200、经验 ≤ 1000、物品数量 ≤ 64。

### 4.2 高级道具：`effectCode`（进阶 · 少量代码）

当预设效果表达不了时，可以写一个**自定义效果函数**（JavaScript 函数表达式字符串，随道具提交，沙箱运行）。

**签名**：`function(params) { ... return { message: "提示文字" }; }`

**沙箱可用变量**（游戏方开放的全部运行环境）：

| 变量 | 说明 |
|---|---|
| `game` | RPG 游戏实例。`game.player` 含 `heal(n)` / `addMana(n)` / `addExp(n)` 等方法；`game.loadMap(key, spawn)` 切换地图 |
| `GameData` | 全局数据对象，如 `GameData.coins`（金币数量） |
| `Inventory` | 背包对象，`Inventory.addItem(path, amount)` 发放物品 |
| `EventBus` | 事件总线，`EventBus.emit('coins_changed' / 'inventory_changed' / 'player_stats_updated')` 刷新界面 |
| `Math` / `JSON` / `console` | 标准 JS 对象（console 仅限 `console.log`） |

**限制**：函数体 ≤ 4000 字符；禁止 `eval` / `new Function` / `import` / `window` / `document` / `fetch` / `localStorage` 等。

**示例**（自定义效果：金币 + 经验一次性发放）：

```json
{
  "name": "丰收礼包",
  "effect": "harvest_pack",
  "params": {},
  "description": "同时获得金币与经验",
  "icon": "🎁",
  "effectCode": "function(params) { GameData.coins += 500; game.player.addExp(300); EventBus.emit('coins_changed'); EventBus.emit('player_stats_updated'); return { message: '丰收！+500 金币 +300 经验' }; }"
}
```

### 4.3 发放物品：可用物品清单（`add_item` 的 `item` 参数）

`add_item` 只能发放**游戏内已存在**的物品 path。以下是部分预设物品（完整清单可参考任务附件 `allinone-sop.json` 或向任务方索取白名单）：

| 物品 path | 说明 |
|---|---|
| `res://data/food/item_food_fish.tres` | 鱼（可用于收集任务） |
| `res://data/potions/item_hp_small_5.tres` | 小型生命药水 |
| … | 其余以任务附件中的预设清单为准 |

### 4.4 扩展系统（`scripts` slot · 进阶）

游戏方预留在运行时注册的高级效果（配合 4.2 的 `effectCode` 或提交脚本调用）。**只需引用效果名即可，不需要改游戏代码**：

| 效果名 | 说明 |
|---|---|
| `summon_cat` | 召唤一只橘猫伙伴（跟随、自动攻击，按 T 对话、E 喂食） |
| `mine_system` | 激活地雷系统（按 M 布设地雷） |
| `mine_cross` / `mine_big` / `mine_freeze` / `mine_poison` / `mine_frostbite` / `mine_nova` | 切换不同地雷类型（十字 / 高爆 / 冰冻 / 剧毒 / 霜毒 / 新星） |

> 更复杂的自定义系统：可以提交 `scripts` 脚本，通过游戏方预留的扩展点（如宠物系统、地雷系统）接入。脚本同样在沙箱运行，需通过安全审核。

## 5. 让 AI 帮你完成任务（提示词模板）

> 把下面的「任务描述」换成任务广场里的要求，把「接口」部分换成第 4 节接口表，直接发给你的 AI 助手即可。

```
请帮我完成《RPG 二创》的开发任务。

【任务要求】
<在这里粘贴任务广场上的任务描述，例如：制作一件“火系武器附魔 + 恢复少量法力”的双效果道具>

【你只能使用以下接口，禁止查看或猜测游戏源码】
1) 道具 = JSON 对象：{ name(≤20字符), effect, params, description, icon };
2) 可用预设效果：add_coins(amount 1-9999) / heal(amount 1-200) / restore_mp(amount 1-200) /
   full_heal / add_exp(amount 1-1000) / add_item(item 必须来自白名单, amount 1-64) /
   apply_enchant(element 取 lightning|fire|freeze|poison, level≥1, duration, base)；
3) 自定义效果用 effectCode：function(params){...}，可用 game/GameData/Inventory/EventBus/Math/JSON，
   函数体 ≤4000 字符，禁止 eval/new Function/window/document/fetch/localStorage；
4) 不要制作能直接通关、秒杀 Boss 或让玩家死亡的道具。

【请输出】
一个可直接提交的道具 JSON（不要输出其他代码或解释）。
```

## 6. 提交格式与步骤

在任务详情页的「提交」表单中填写：

- **data**：你的道具对象（或道具数组）；纯文件补丁时留空 `{}` 即可
- **assets**：需要上传的文件（脚本类任务传 `.js`，纯文件补丁传被补的文件）
- **entryPoint**：仅当你提交完整 HTML 页面时填写（一般道具任务不用）

**提交前自检**：
- [ ] `name` 非空且 ≤ 20 字符
- [ ] 预设效果名拼写正确，`params` 数值在约束上限内（金币≤9999、恢复≤200、经验≤1000、物品≤64）
- [ ] `add_item` 的 `item` 来自游戏内白名单
- [ ] `effectCode`（如有）≤ 4000 字符，不含危险 API，返回 `{ message }`
- [ ] 不包含通关/秒杀/负面内容
- [ ] assets 的 path 是游戏内相对路径

## 7. 常见问题

**Q：提交后道具没有出现？**
先确认任务状态是「已合并」；道具是玩家在游戏内「领取/兑换」后出现在底部 PROPS 道具栏并点击使用，不是自动发放到所有人。

**Q：报「data 缺少必需字段」？**
`items` slot 的 data 元素需要 `id` 与 `name` 等必填字段；纯文件补丁则把 data 留空 `{}` 并上传文件即可。

**Q：`add_item` 报物品不存在？**
`item` 必须填游戏内真实存在的 path（参考 4.3 白名单），不能自己编路径。

**Q：我完全不会写代码，能做吗？**
可以。只做「预设效果道具」或「纯文件补丁」就是填 JSON/传文件，零代码；`effectCode` 和扩展系统属于进阶玩法，可完全跳过。

---

*本文档由游戏方发布。游戏方保留对接口、数值上限与审核规则的最终解释权；破坏平衡或窃取源码的行为将被拒绝并可能追责。*
