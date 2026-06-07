# 游戏发布参考案例：消消乐 (Match3Game)

> 日期：2026-06-06 | 涉及文件：Match3Game.html, PublishingPipeline.ts, GamePlay.tsx, SkillInitializer.ts

---

## 1. 背景

将 `AllinONE Online/Match3Game.tsx`（React + TypeScript + Tailwind + Framer Motion）重构为独立 HTML 文件 `Match3Game.html`，然后在 AllinONE 平台中发布。

**游戏规格**：8×8 棋盘、6 色宝石、3 消匹配、3 种道具（炸弹 / 闪电 / 彩虹）、60 秒倒计时、30 步限制、1000 分过关。

---

## 2. 平台发布架构

```
┌──────────────────────────────────────────────────────┐
│  GamePlay.tsx (平台侧 - 父页面)                        │
│                                                      │
│  ├─ ProtocolEngine: postMessage 协议引擎               │
│  │   └─ onRedeem → redeemCodeService.verifyCode()     │
│  │               → redeemCodeService.useCode()        │
│  │               → 返回 RedeemResultData               │
│  │                                                    │
│  └─ <iframe srcDoc={注入后的游戏 HTML}>                 │
│      ┌──────────────────────────────────────────────┐ │
│      │  游戏 HTML (注入后)                            │ │
│      │                                              │ │
│      │  ① SkillInitializer 注入:                     │ │
│      │     <script>window.__ALLINONE_CONFIG__=...</script>│
│      │                                              │ │
│      │  ② PublishingPipeline 注入 (inject 模式):      │ │
│      │     - Effect Engine (<head>)                  │ │
│      │     - 兑换条 UI + SDK (</body> 前)             │ │
│      │                                              │ │
│      │  ③ 游戏原始代码:                               │ │
│      │     - POWERUP_META (道具元数据)                │ │
│      │     - PlatformBridge (通信桥接层)              │ │
│      │     - 游戏逻辑 (棋盘/匹配/道具)                 │ │
│      └──────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────┘
```

### 2.1 两种通信模式

| 模式 | 标识 | 通信方式 | 兑换条来源 |
|------|------|----------|-----------|
| **inject (Mode B)** | `protocolMode: 'inject'`（默认） | 游戏→平台: `postMessage('REDEEM_ITEM')`；平台→游戏: `postMessage('REDEEM_RESULT')` + `CustomEvent('allinone:item-redeemed')` | PublishingPipeline 自动注入全套 SDK |
| **integrated (Mode A)** | `protocolMode: 'integrated'` | 游戏自行集成 `AllinONEGame` SDK 构造函数 | 游戏侧自行处理，平台仅注入 Protocol Bridge |

> **本项目使用 inject 模式（默认）**，因此游戏不需要引入任何 SDK 依赖，平台自动处理。

### 2.2 数据流（兑换码核销）

```
用户输入兑换码
  → SDK 兑换条 postMessage('REDEEM_ITEM', {code, gameId})
  → 平台 GamePlay.tsx onRedeem 回调
    → redeemCodeService.verifyCode() ✅
    → redeemCodeService.useCode() ✅
    → 返回 {success: true, itemId, itemName, effectType, effects}
  ← postMessage('REDEEM_RESULT', {...})
  ← SDK 分发 CustomEvent('allinone:item-redeemed', {detail: {...}})
  ← 游戏 PlatformBridge.onItemRedeemed() 监听器
    → gameStats.powerUps[type]++  ← 本地计数+1
    → updateUI() + Toast "兑换成功！"
```

---

## 3. 发布步骤（正确流程）

### Step 1：准备独立 HTML 游戏文件

游戏必须是**纯 HTML/CSS/JS** 文件，不依赖任何框架运行时（React/Vue 等）。

**必须包含**：
```javascript
// 道具元数据 — 发布时平台读取并自动创建商店商品
const POWERUP_META = {
  bomb: {
    itemId: 'match3_bomb',       // ← 与平台兑换码系统的 itemId 一致
    effectType: 'bomb',           // ← 发布时 PowerUpAnalyzer 自动识别
    name: '💣 炸弹道具',
    price: 50,
    currency: 'gameCoins',
    description: '消除目标宝石 3×3 范围内所有宝石',
  },
  lightning: { itemId: 'match3_lightning', ... },
  rainbow:   { itemId: 'match3_rainbow', ... },
};
```

> **关键**：`itemId` 必须与平台兑换码系统中的 `itemId` 匹配。平台通过 `POWERUP_META` 自动识别道具并在发布时配置。

### Step 2：编写 PlatformBridge（游戏侧通信层）

```javascript
const PlatformBridge = (() => {
  const ITEM_MAP = {
    'match3_bomb':      'bomb',
    'match3_lightning': 'lightning',
    'match3_rainbow':   'rainbow',
    'bomb':             'bomb',       // 兼容 effectType 作为 itemId
    'lightning':        'lightning',
    'rainbow':          'rainbow',
  };

  function onItemRedeemed(e) {
    const puType = ITEM_MAP[e.detail?.itemId];
    if (!puType) return;
    gameStats.powerUps[puType]++;
    updateUI();
  }

  function init() {
    // ⚠️ 始终注册，不依赖 __ALLINONE_CONFIG__ 检测
    window.addEventListener('allinone:item-redeemed', onItemRedeemed);
    // ⚠️ 只监听一个事件名（SDK 双发 colon/dash 版本，监听两个会重复计数）

    // 平台检测仅用于决定初始道具数量
    const config = window['__ALL' + 'INONE_CONFIG__'];
    if (!config) {
      gameStats.powerUps = { bomb: 2, lightning: 1, rainbow: 1 };  // 独立模式
    }
    // 平台模式：初始 0，通过兑换码获取
    updateUI();
  }

  return { init };
})();

// 页面底部调用
PlatformBridge.init();
```

### Step 3：避免 `__ALLINONE_CONFIG__` 字面量

平台 `SkillInitializer.injectConfigToGamePackage()` 检查 `htmlContent.includes('__ALLINONE_CONFIG__')` 来决定是否注入配置。如果游戏 HTML 中已含此字面量，注入会被跳过。

**解决方案**：使用字符串拼接：
```javascript
const CONFIG_KEY = '__ALL' + 'INONE_CONFIG__';  // ✅ 拆分后不含字面量
const config = window[CONFIG_KEY];
```

### Step 4：发布

平台发布流程会自动：
1. `SkillInitializer.setupGameConfig()` — 注入 `window.__ALLINONE_CONFIG__` 到 `<head>`
2. `PublishingPipeline.generateScriptInjection()` — 注入 Effect Engine + 兑换条 SDK
3. 游戏在 iframe 中以 `srcDoc` 方式加载

---

## 4. 遇到的问题及解决方案

### Issue 1：道具库存始终为 0（fetch 调用不存在的 HTTP 端点）

**现象**：
```
[PlatformBridge] Failed to fetch power-up counts, falling back to local
```

**根因**：游戏侧 PlatformBridge 使用 `fetch('/api/skills/inventory/getItems')` 调用不存在的 HTTP 端点。平台的 Skill 系统运行在内存中的 `SkillGateway`，没有对应的 HTTP 路由。

**错误代码**（已删除）：
```javascript
// ❌ 这条路径不存在
const url = `${apiBase}/inventory/getItems`;
const res = await fetch(url, { method: 'POST', ... });
```

**修复**：参考 ZUMA 的 Mode B 模式，废弃 fetch 桥接，改为监听平台 SDK 分发的 `allinone:item-redeemed` CustomEvent。

**删除的代码**：整套 fetch-based PlatformBridge（~106 行）
- `callSkill()` / `getPowerUpCounts()` / `consumePowerUp()` / `purchasePowerUp()`
- `refreshPowerUps()` / `loadPowerUpsFromPlatform()` / 8 秒定时刷新
- `postMessage` 监听器（INVENTORY_UPDATED / GAME_READY 等）
- `usePowerUp()` 中的 `PlatformBridge.consumePowerUp()` 异步调用

### Issue 2：CustomEvent 监听器从未注册（isPlatform 守卫误判）

**现象**：兑换码验证成功（控制台显示"Effect Engine 已自动执行"），但游戏内道具数量不增加。

**根因**：PlatformBridge 是 IIFE（立即执行函数），`isPlatform` 变量在**定义时**从 `window.__ALLINONE_CONFIG__` 读取并存入闭包。但此时该全局变量**可能尚未注入**（取决于脚本执行顺序），导致 `isPlatform = false` → `init()` 中 `return` → 监听器永远不注册。

**错误代码**（已删除）：
```javascript
const PlatformBridge = (() => {
  const config = window[CONFIG_KEY];           // ← IIFE 执行时读取
  const isPlatform = config !== null;           // ← 存入闭包，可能为 false

  function init() {
    if (!isPlatform) return;                    // ← 直接返回，监听器不注册！
    window.addEventListener('allinone:item-redeemed', ...);
  }
})();
```

**修复**：
1. `isPlatform` 检测从 IIFE 闭包 → 移到 `init()` 内部（延迟到调用时）
2. CustomEvent 监听器**始终注册**（独立模式下无害，平台模式下由 SDK 分发）

### Issue 3：一个兑换码触发两次计数（双重事件）

**现象**：输入一个兑换码，道具数量 +2 而不是 +1。

**根因**：SDK 在 `REDEEM_RESULT` 成功时**同时分发两个事件名**：

```javascript
window.dispatchEvent(new CustomEvent('allinone-item-redeemed', { detail }));
window.dispatchEvent(new CustomEvent('allinone:item-redeemed', { detail }));
```

旧代码监听 `allinone-item-redeemed` 后**重新分发**为 `allinone:item-redeemed`，导致循环触发。

**错误代码**（已删除）：
```javascript
window.addEventListener('allinone:item-redeemed', onItemRedeemed);
window.addEventListener('allinone-item-redeemed', function(e) {
  window.dispatchEvent(new CustomEvent('allinone:item-redeemed', ...));  // ❌ 重新分发导致循环
});
```

**修复**：只监听一个事件名（`allinone:item-redeemed`），放弃 dash 版本的转发逻辑。

---

## 5. 最终工作架构

```
兑换码输入 → SDK 兑换条 postMessage('REDEEM_ITEM')
  → 平台 verifyCode + useCode
  ← SDK 分发 CustomEvent('allinone:item-redeemed')
  → 游戏 onItemRedeemed() → gameStats.powerUps[type]++ ✅

游戏中使用道具 → gameStats.powerUps[type]-- (纯本地扣除) ✅
```

**通信原则**：
1. 游戏 **不需要** HTTP API — 平台 Skill 系统仅在内存中
2. 游戏 **只监听** `allinone:item-redeemed` CustomEvent（单事件）
3. 道具使用 **纯本地扣除**，不需要同步平台
4. **不依赖** `__ALLINONE_CONFIG__` 来注册监听器

---

## 6. 游戏发布检查清单

在提交游戏发布前，确认：

| # | 检查项 | 说明 |
|---|--------|------|
| ✅ | 独立 HTML | 纯 HTML/CSS/JS，无 React/Vue 等框架依赖 |
| ✅ | `POWERUP_META` | 包含所有道具的 `itemId`/`name`/`effectType` |
| ✅ | `itemId` 命名规范 | 建议格式 `{gameId}_{powerupName}`（如 `match3_bomb`） |
| ✅ | PlatformBridge 始终注册 | 监听器不依赖 `__ALLINONE_CONFIG__` 守卫 |
| ✅ | 只监听一个事件 | `allinone:item-redeemed`（不是两个） |
| ✅ | 避免 `__ALLINONE_CONFIG__` 字面量 | 用 `'__ALL' + 'INONE_CONFIG__'` 拆分 |
| ✅ | 不调用 fetch API | 不请求 `/api/skills/*` |
| ✅ | 初始道具 = 0 | 平台模式下从 0 开始，通过兑换获取 |
| ✅ | 道具用完提示 | 点击道具按钮时 Toast 提示"请使用兑换码" |
| ✅ | 独立模式降级 | `!__ALLINONE_CONFIG__` 时赠送默认道具数量 |

---

## 7. 调试技巧

启用在控制台查看 PlatformBridge 状态：

1. 查看初始化日志：`[Match3Game] PlatformBridge 初始化完成`
2. 查看兑换事件：`[Match3Game] CustomEvent 收到: match3_bomb → powerUps.bomb=1`
3. 查看未知道具：`[Match3Game] 未知道具ID: xxx 跳过`（需更新 ITEM_MAP）

---

## 8. 相关文件

| 文件 | 角色 |
|------|------|
| `AllinONE Online/Match3Game.html` | 消消乐游戏源文件（本次交付物） |
| `AllinONE Online/index.html` | ZUMA 游戏 — Mode B 参考实现 |
| `src/pages/GamePlay.tsx` | 平台游戏容器页面（含 onRedeem 回调） |
| `src/publishing-center/core/PublishingPipeline.ts` | SDK 注入（兑换条 UI + Effect Engine + CustomEvent 分发） |
| `src/publishing-center/core/SkillInitializer.ts` | `__ALLINONE_CONFIG__` 注入 |
| `src/publishing-center/protocol/ProtocolEngine.ts` | postMessage 协议引擎 |
