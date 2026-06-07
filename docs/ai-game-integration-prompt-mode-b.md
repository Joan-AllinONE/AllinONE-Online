# AllinONE 平台 — Mode B（SDK 集成模式）AI 适配文档

> 将以下内容复制给 AI 助手（如 ChatGPT、Claude、CodeBuddy 等），
> 附上您的游戏 HTML 文件，AI 将自动完成道具平台接入。
>
> **适用模式**：Mode B（SDK 集成模式）— 游戏方通过 SDK 自主控制道具效果，适合需要精确操控的深度游戏。

---

## 任务

为我的 HTML 游戏添加 AllinONE 平台的 **Mode B 道具兑换码接入**功能。游戏通过 `postMessage` 协议与平台双向通信，游戏方完全自主控制道具效果执行。

---

## 游戏信息

> 请在下方填写您的游戏信息，或让 AI 从代码中自动识别。

- **游戏名称**：__（如：ZUMA）__
- **游戏文件路径**：__（如：AllinONE Online/index.html）__
- **游戏实例变量名**：__（如：zumaGame，游戏引擎暴露到 `window` 的变量）__
- **道具列表**（名称 + itemId + effectType + 说明）：

| 道具名 | itemId | effectType | 效果说明 |
|--------|--------|------------|----------|
| 🐸 难度降低 | `{game}_difficulty_reducer` | `difficulty_reducer` | 弹珠移动速度减半 |
| 🌟 分数翻倍 | `{game}_score_boost` | `score_boost` | 消除得分翻倍 |
| ❤️ 清除弹珠 | `{game}_extra_life` | `extra_life` | 清除 5 颗弹珠 |

> **命名规范**：`itemId` = `{游戏名}_{道具英文名}`，`effectType` 用于平台效果匹配。

---

## AI 执行步骤

### 第 1 步：确保代码结构正确

将所有 JS/CSS 内联到单个 `index.html` 中。**平台通过 srcdoc iframe 加载游戏，外部文件引用必然 404。**

```
✅ 正确结构（所有代码内联）
game.zip
  └── index.html   ← 自合一：<style> + <script> 全部内联

❌ 错误结构（外部引用会 404）
game.zip
  ├── index.html   ← <script src="./script.js">
  ├── script.js    ← 在 srcdoc 中 404
  └── style.css    ← 在 srcdoc 中 404
```

### 第 2 步：暴露游戏实例到 window

在游戏引擎初始化代码后添加：

```javascript
// 将游戏实例暴露到全局，供集成脚本访问
window.{gameVariable} = {gameVariable};
// 例如：window.zumaGame = zumaGame;
```

### 第 3 步：在 `<head>` 中引入 SDK

```html
<head>
  <meta charset="UTF-8">
  <title>游戏名称</title>
  <!-- Mode B：引入标准 SDK（本地测试不可用属正常） -->
  <script src="https://cdn.allinone.game/sdk/v1/standard-sdk.js"></script>
  <style>/* 所有 CSS 内联 */</style>
</head>
```

> CDN 是内部域名，本地开发不可用。发布时 Pipeline 会自动注入协议桥接层，不影响核心功能。

### 第 4 步：在 `<body>` 底部添加 Mode B 集成脚本

**必须在游戏引擎脚本之后**。完整模板：

```html
<script>
(function() {
  'use strict';

  // 1. 获取游戏实例
  var game = window.{gameVariable};
  if (!game) { console.warn('[AllinONE] 游戏实例未就绪'); return; }

  // 2. 定义道具清单（itemId 与平台兑换码系统一致）
  var REDEEM_ITEMS = [
    { itemId: '{ITEM_ID_1}', effectType: '{EFFECT_TYPE_1}', name: '{ITEM_NAME_1}', desc: '{ITEM_DESC_1}' },
    { itemId: '{ITEM_ID_2}', effectType: '{EFFECT_TYPE_2}', name: '{ITEM_NAME_2}', desc: '{ITEM_DESC_2}' },
  ];

  // 3. 声明协议信息
  window.AllinONE = window.AllinONE || {};
  window.AllinONE.__PROTOCOL_MODE__ = 'integrated';
  window.AllinONE.__GAME_ID__ = '{GAME_ID}';
  window.AllinONE.__ITEMS__ = REDEEM_ITEMS;

  // 4. 发送 PROTOCOL:READY 信号
  function sendReady() {
    window.parent.postMessage({
      type: 'PROTOCOL:READY',
      protocolVersion: '1.0.0',
      mode: 'integrated',
      gameId: '{GAME_ID}',
      supportedActions: ['start', 'pause', 'resume', 'redeem'],
      supportedSchemas: REDEEM_ITEMS.map(function(i) { return i.effectType; }),
      timestamp: Date.now(),
    }, '*');
  }
  sendReady();
  setTimeout(sendReady, 500);
  setTimeout(sendReady, 2000);

  // 5. 道具效果处理函数
  function applyEffect(itemId, effects) {
    var wasRunning = game.isRunning || game.isStart;
    if (wasRunning && game.stop) game.stop();

    switch (itemId) {
      case '{ITEM_ID_1}':
        // TODO: 实现效果逻辑
        break;
      case '{ITEM_ID_2}':
        // TODO: 实现效果逻辑
        break;
    }

    if (wasRunning && game.start) game.start();
  }

  // 6. 监听兑换事件
  window.addEventListener('allinone-item-redeemed', function(e) {
    applyEffect(e.detail.itemId, e.detail.effects);
  });
  window.addEventListener('message', function(event) {
    if (event.data && event.data.type === 'REDEEM_RESULT' && event.data.data && event.data.data.success) {
      applyEffect(event.data.data.itemId, event.data.data.effects);
    }
  });

  // 7. [可选] 通关时发送 GAME_COMPLETE 事件，触发平台奖励
  document.addEventListener('GAME_OVER', function(e) {
    if (e.detail && e.detail.win) {
      window.parent.postMessage({
        type: 'GAME_EVENT',
        event: 'GAME_COMPLETE',
        data: { score: game.score || 0 },
        gameId: '{GAME_ID}',
        timestamp: Date.now(),
      }, '*');
    }
  });
})();
</script>
```

### 第 5 步：发布并验证

1. 打包为 ZIP（仅含 `index.html`）
2. 上传 → 平台自动检测 SDK → 选择 **Mode B**
3. 配置道具（itemId 与脚本中一致）
4. 一键发布 → 试玩验证

---

## 效果类型 → 游戏变量映射表

AI 分析目标游戏时，扫描以下关键词定位需修改的变量：

| effectType | 语义 | 扫描关键词 | 修改方式 |
|------------|------|-----------|----------|
| `difficulty_reducer` | 降低难度/减速 | `moveSpeed, speed, difficulty, gameSpeed` | 乘以 0.5~0.7 |
| `score_boost` | 分数翻倍 | `score, points, multiplier` | 劫持 score setter |
| `extra_life` | 额外生命 | `life, lives, health, hp` | 增加值（+1~+5） |
| `time_bonus` | 时间奖励 | `time, timer, countdown, remaining` | 增加值（+10~+30s） |

---

## ⚠️ 关键注意事项

| # | 规则 | 说明 |
|---|------|------|
| 1 | **所有代码内联** | ZIP 只含一个 index.html，无外部 JS/CSS |
| 2 | **暴露游戏实例** | `window.{variable} = instance` |
| 3 | **脚本顺序** | `<body>` 底部：引擎脚本 → 集成脚本 |
| 4 | **itemId 一致性** | 脚本中的 itemId 必须与发布中心配置一致 |
| 5 | **不要手写 minify** | 使用原始可读代码内联，避免 SyntaxError |
| 6 | **不要依赖 window.onload** | 脚本在 `</body>` 前执行时 DOM 已就绪 |

---

## 数据流（Mode B 兑换码核销全链路）

```
玩家输入兑换码
  → SDK 兑换条 postMessage('REDEEM_ITEM', {code, gameId})
  → 平台验证: verifyCode() → useCode()
  ← postMessage('REDEEM_RESULT', {success, itemId, itemName, ...})
  ← SDK 分发 CustomEvent('allinone-item-redeemed')
  → 游戏 applyEffect() 函数
    → 直接修改游戏状态（如 game.moveSpeed *= 0.6）
    → 游戏方完全自主控制效果执行
```

---

## Mode A vs Mode B 对比

| 对比 | Mode A | Mode B |
|------|--------|--------|
| 修改量 | ~50 行 PlatformBridge | ~200 行集成脚本 |
| SDK 依赖 | 无需引入 | 需引入 SDK |
| 效果控制 | 监听 CustomEvent 计数 | 游戏方自主控制 |
| 适用场景 | 快速发布、简单道具 | 复杂效果、深度集成 |

---

## 参考案例

完整案例见 `docs/game-publishing-guide-match3.md`，涵盖 ZUMA 游戏 Mode B 集成的完整过程。
