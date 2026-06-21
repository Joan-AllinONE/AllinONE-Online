# AllinONE 平台 — Mode A（注入模式）AI 适配文档

> 将以下内容复制给 AI 助手（如 ChatGPT、Claude、CodeBuddy 等），
> 附上您的游戏 HTML 文件，AI 将自动完成道具平台接入。
>
> **适用模式**：Mode A（注入模式）— 零 SDK 依赖，平台自动注入兑换条，游戏只需监听 CustomEvent。

---

## 任务

为我的 HTML 游戏添加 AllinONE 平台的**道具兑换码接入**功能。游戏使用 **Mode A（注入模式）**——平台发布时自动注入兑换条 UI 和 SDK，游戏只需监听兑换成功事件。

---

## 游戏信息

> 请在下方填写您的游戏信息，或让 AI 从代码中自动识别。

- **游戏名称**：__（如：消消乐）__
- **游戏文件路径**：__（如：AllinONE Online/Match3Game.html）__
- **道具列表**（名称 + itemId + 说明）：

| 道具名 | itemId（唯一标识） | 效果说明 |
|--------|-------------------|----------|
| 💣 炸弹道具 | `{game}_bomb` | 消除 3×3 范围 |
| ⚡ 闪电道具 | `{game}_lightning` | 消除整行+整列 |
| 🌈 彩虹道具 | `{game}_rainbow` | 消除同色全部 |

> **itemId 命名规范**：`{游戏名}_{道具名}`，如 `match3_bomb`、`zuma_difficulty_reducer`。

---

## AI 执行步骤

### 第 1 步：分析游戏代码

- 找到游戏的道具系统代码（如 `usePowerUp`、`handleItem` 等函数名）
- 找到道具数量状态变量（如 `gameStats.powerUps`、`items`、`inventory` 等）
- 确认道具在 UI 上的更新方式（如 `updateUI()` 函数）

### 第 2 步：添加道具元数据（POWERUP_META）

在游戏脚本顶部添加常量，供平台发布时自动读取并创建商店商品：

```javascript
// ============ 道具元数据（发布时平台可读取并自动创建商店商品） ============
const POWERUP_META = {
  bomb: {
    itemId: 'match3_bomb',       // ← 用于匹配兑换码系统中的 itemId
    effectType: 'bomb',           // ← 道具效果类型
    name: '💣 炸弹道具',
    price: 50,
    currency: 'gameCoins',
    description: '消除目标宝石 3×3 范围内所有宝石',
  },
  lightning: {
    itemId: 'match3_lightning',
    effectType: 'lightning',
    name: '⚡ 闪电道具',
    price: 80,
    currency: 'gameCoins',
    description: '消除目标宝石所在整行 + 整列',
  },
  rainbow: {
    itemId: 'match3_rainbow',
    effectType: 'rainbow',
    name: '🌈 彩虹道具',
    price: 120,
    currency: 'gameCoins',
    description: '消除棋盘上所有同色宝石',
  },
};
```

> **注意**：`itemId` 必须唯一，建议格式 `{游戏前缀}_{道具英文名}`。平台兑换码系统通过 itemId 匹配道具。

### 第 3 步：添加 PlatformBridge（通信桥接层）

添加以下代码到游戏脚本中（放在 `POWERUP_META` 下方、DOM 引用之前）：

```javascript
// ============ 平台桥接层 ============
// Mode A 极简桥接：监听平台 SDK 注入的 allinone:item-redeemed CustomEvent
// 始终注册监听器（平台模式下由 SDK 分发，独立模式下无害）
const PlatformBridge = (() => {
  // itemId → 道具类型映射
  const ITEM_MAP = {
    'match3_bomb':      'bomb',
    'match3_lightning': 'lightning',
    'match3_rainbow':   'rainbow',
    // 也允许 effectType 作为 itemId（兼容不同命名方式）
    'bomb':             'bomb',
    'lightning':        'lightning',
    'rainbow':          'rainbow',
  };

  function onItemRedeemed(e) {
    const detail = e.detail;
    if (!detail || !detail.itemId) return;

    const puType = ITEM_MAP[detail.itemId];
    if (!puType) {
      console.log('[PlatformBridge] 未知道具ID:', detail.itemId, '跳过');
      return;
    }

    gameStats.powerUps[puType]++;  // ★ 本地计数 +1
    updateUI();                     // ★ 刷新界面
    console.log('[PlatformBridge] 兑换成功:', detail.itemId, '→ powerUps.' + puType + '=' + gameStats.powerUps[puType]);
  }

  function init() {
    // ⚠️ 关键：始终注册监听器，不依赖 __ALLINONE_CONFIG__ 检测
    // 只监听一个事件名（SDK 同时分发 colon/dash 两个版本，监听一个即可
    window.addEventListener('allinone:item-redeemed', onItemRedeemed);
    console.log('[PlatformBridge] CustomEvent 监听器已注册');

    // 平台检测：仅用于决定初始道具数量
    const CONFIG_KEY = '__ALL' + 'INONE_CONFIG__';
    const config = window[CONFIG_KEY];
    const isPlatform = typeof config === 'object' && config !== null;

    if (!isPlatform) {
      // 独立模式：赠送默认道具用于测试
      gameStats.powerUps = { bomb: 2, lightning: 1, rainbow: 1 };
    }
    // 平台模式：初始道具为 0，通过兑换码获取
    updateUI();
  }

  return { init };
})();
```

然后在页面初始化代码末尾（`updateUI()`、`startTimer()` 之后）调用：

```javascript
PlatformBridge.init();
```

### 第 4 步：修改道具点击处理逻辑

将道具数量为 0 时的处理简化——不跳购买、不调 API，仅提示"请使用兑换码"：

```javascript
function handlePowerUpClick(type) {
  if (gameStats.powerUps[type] === 0) {
    showToast('道具已用完，请使用兑换码获取更多道具', 'info');
    return;
  }
  // 激活/取消道具选择...
}
```

道具使用只需本地扣除：

```javascript
function usePowerUp(type) {
  if (!gameStats.powerUps[type]) return;
  gameStats.powerUps[type]--;  // 纯本地扣除
  // ...执行道具效果...
}
```

---

## ⚠️ 关键注意事项

| # | 规则 | 错误示例 | 正确做法 |
|---|------|---------|---------|
| 1 | **不要用 `fetch` 调用平台 API** | `fetch('/api/skills/inventory/getItems')` — 此端点不存在 | 只监听 `allinone:item-redeemed` CustomEvent |
| 2 | **不要用 `isPlatform` 守卫监听器** | `if (!isPlatform) return; addEventListener(...)` — IIFE 中 `isPlatform` 可能未就绪 | 始终注册监听器，不依赖平台检测 |
| 3 | **只监听一个事件名** | 同时监听 `allinone:item-redeemed` 和 `allinone-item-redeemed` — 会重复计数 | 只监听 `allinone:item-redeemed`（colon 版本） |
| 4 | **不要写 `__ALLINONE_CONFIG__` 字面量** | `window['__ALLINONE_CONFIG__']` — 会被平台跳过注入 | 拆分为 `'__ALL' + 'INONE_CONFIG__'` |
| 5 | **平台模式初始道具为 0** | 初始给 99 个道具 — 破坏兑换经济 | 平台模式下从 0 开始，独立模式可送默认数量 |

---

## 数据流（兑换码核销全链路）

```
玩家输入兑换码
  → 平台注入的兑换条 postMessage('REDEEM_ITEM', {code, gameId})
  → 平台验证: verifyCode() → useCode()
  ← postMessage('REDEEM_RESULT', {success: true, itemId, itemName, ...})
  ← SDK 分发 CustomEvent('allinone:item-redeemed', {detail: {itemId, ...}})
  → 游戏 PlatformBridge.onItemRedeemed() 监听器
    → gameStats.powerUps[type]++  ← 本地计数 +1
    → updateUI()                  ← 刷新道具按钮显示
```

---

## 验证方法

完成修改后，检查以下控制台日志：

```
[PlatformBridge] CustomEvent 监听器已注册
// 兑换成功后:
[PlatformBridge] 兑换成功: match3_bomb → powerUps.bomb=1
```

---

## 参考案例

完整案例见 `docs/game-publishing-guide-match3.md`，覆盖消消乐游戏从开发到发布的完整过程。
