# AllinONE 游戏发布完整指南

> **目标读者**：游戏开发者 / 使用 AI 辅助改编游戏的开发者
> **版本**：v2.0 | **适用平台**：AllinONE Gaming Platform

---

## 目录

1. [概述：发布全流程](#1-概述发布全流程)
2. [第一步：游戏 HTML 集成 AllinONE](#2-第一步游戏-html-集成-allinone)
3. [第二步：发布中心配置](#3-第二步发布中心配置)
4. [第三步：道具 SOP 定义](#4-第三步道具-sop-定义)
5. [AI 一键改编：完整提示词](#5-ai-一键改编完整提示词)
6. [ZUMA 完整案例](#6-zuma-完整案例)
7. [检查清单](#7-检查清单)

---

## 1. 概述：发布全流程

```
┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│  ① 集成代码  │ →  │  ② 上传游戏  │ →  │  ③ AI 分析   │ →  │  ④ 配置      │ →  │  ⑤ 发布上线  │
│  (HTML改造)  │    │  (ZIP 包)   │    │  (自动检测)  │    │ Skills+SOP  │    │  (一键部署)  │
└─────────────┘    └─────────────┘    └─────────────┘    └─────────────┘    └─────────────┘
      你来做            上传              平台自动           你来配              平台自动
```

| 步骤 | 谁做 | 说明 |
|------|------|------|
| ① 集成代码 | 开发者（或 AI） | 在游戏 HTML 中添加 AllinONE 通信代码 |
| ② 上传游戏 | 开发者 | 打包为 ZIP 上传到发布中心 |
| ③ AI 分析 | 平台自动 | 检测游戏类型、框架、入口文件 |
| ④ 配置 | 开发者 | 选择 Skills、配置兑换道具、定义道具 SOP |
| ⑤ 发布上线 | 平台自动 | 验证、构建、部署、注入 SDK |

---

## 2. 第一步：游戏 HTML 集成 AllinONE

在游戏 HTML 的 `</body>` 前添加以下代码（约 120 行通用模板）：

### 2.1 CSS 样式

```html
<style>
  /* AllinONE UGC 道具栏 */
  .ugc-bar {
    position: fixed; bottom: 12px; left: 50%; transform: translateX(-50%);
    display: flex; gap: 8px; align-items: center; padding: 8px 16px;
    background: rgba(0,0,0,0.85); border-radius: 12px; z-index: 9999;
    font-family: system-ui; min-height: 40px;
  }
  .ugc-label { color: #4caf50; font-weight: bold; font-size: 12px; margin-right: 4px; }
  .ugc-item {
    padding: 4px 10px; background: #333; border-radius: 8px; cursor: pointer;
    color: #fff; font-size: 13px; border: 1px solid #555; transition: all 0.2s;
  }
  .ugc-item:hover { background: #4caf50; border-color: #4caf50; }
  .ugc-empty { color: #666; font-size: 12px; }
  /* Toast 通知 */
  .toast {
    position: fixed; top: 20px; left: 50%; transform: translateX(-50%) translateY(-100px);
    padding: 10px 20px; background: rgba(0,0,0,0.9); color: #fff; border-radius: 8px;
    font-size: 14px; z-index: 10000; border-left: 4px solid #4caf50;
    transition: transform 0.3s ease; pointer-events: none;
  }
  .toast.show { transform: translateX(-50%) translateY(0); }
</style>
```

### 2.2 HTML 容器

```html
<div id="ugc-bar" class="ugc-bar">
  <span class="ugc-label">PROPS</span>
  <span class="ugc-empty">No items yet</span>
</div>
<div id="toast-container"></div>
```

### 2.3 JavaScript 集成代码（通用模板）

```html
<script>
(function() {
  'use strict';

  // ============ Toast 提示 ============
  function showToast(msg, type) {
    var toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = msg;
    if (type === 'error') toast.style.borderColor = '#f44336';
    else if (type === 'info') toast.style.borderColor = '#2196f3';
    document.getElementById('toast-container').appendChild(toast);
    requestAnimationFrame(function() {
      requestAnimationFrame(function() { toast.classList.add('show'); });
    });
    setTimeout(function() {
      toast.classList.remove('show');
      setTimeout(function() { toast.remove(); }, 400);
    }, 3000);
  }

  // ============ 内置效果表（⚠️ 根据你的游戏自定义）============
  var EFFECT_HANDLERS = {
    // 示例：加分
    add_score: function(params) {
      // TODO: 替换为你的游戏加分逻辑
      // myGame.score += (params.bonus || 10);
      return { message: '✨ +' + (params.bonus || 10) + ' 分' };
    },
    // TODO: 添加更多你的游戏效果...
  };

  // ============ effectCode 沙箱引擎 ============
  var _dynamicHandlerCache = {};

  function registerDynamicEffect(effectName, effectCodeStr) {
    if (EFFECT_HANDLERS[effectName]) return true;
    if (_dynamicHandlerCache[effectName]) {
      EFFECT_HANDLERS[effectName] = _dynamicHandlerCache[effectName];
      return true;
    }
    if (!effectCodeStr || typeof effectCodeStr !== 'string') return false;
    if (effectCodeStr.length > 4000) return false;

    var blocked = [
      'eval(', 'new function', 'import(', 'require(', '__proto__',
      'prototype', 'constructor', 'window.', 'document.',
      'parent.', 'top.', 'globalthis', 'self.',
      'fetch(', 'xmlhttprequest', 'websocket', 'worker(',
      'localstorage', 'sessionstorage', 'cookie',
      'alert(', 'confirm(', 'prompt('
    ];
    var lowerCode = effectCodeStr.toLowerCase();
    for (var i = 0; i < blocked.length; i++) {
      if (lowerCode.indexOf(blocked[i]) !== -1) return false;
    }

    // ⚠️ 沙箱变量：替换为你的游戏对象
    try {
      var sandboxFn = new Function(
        'game', 'Math', 'JSON', 'console',
        'return (' + effectCodeStr + ');'
      );
      var rawHandler = sandboxFn(
        window.myGame || {},  // ⚠️ 替换为你的游戏实例
        Math, JSON, console
      );
      if (typeof rawHandler !== 'function') return false;

      var wrappedHandler = function(params) {
        try { return rawHandler(params) || { message: '效果已执行' }; }
        catch (e) { return { error: true, message: '效果出错: ' + (e.message || e) }; }
      };
      _dynamicHandlerCache[effectName] = wrappedHandler;
      EFFECT_HANDLERS[effectName] = wrappedHandler;
      return true;
    } catch (e) { return false; }
  }

  // ============ UGC 道具库存 ============
  var customPowerUps = [];

  function renderCustomPowerUps() {
    var bar = document.getElementById('ugc-bar');
    bar.innerHTML = '';
    var label = document.createElement('span');
    label.className = 'ugc-label';
    label.textContent = 'PROPS';
    bar.appendChild(label);
    if (customPowerUps.length === 0) {
      var empty = document.createElement('span');
      empty.className = 'ugc-empty';
      empty.textContent = 'No items yet';
      bar.appendChild(empty);
      return;
    }
    customPowerUps.forEach(function(item, index) {
      var el = document.createElement('span');
      el.className = 'ugc-item';
      el.textContent = (item.icon || '⚡') + ' ' + item.name;
      el.title = item.description || item.effect;
      el.onclick = function() { useCustomPowerUp(index); };
      bar.appendChild(el);
    });
  }

  function useCustomPowerUp(index) {
    var item = customPowerUps[index];
    if (!item) return;
    if (item.effectCode && !EFFECT_HANDLERS[item.effect]) {
      if (!registerDynamicEffect(item.effect, item.effectCode)) {
        showToast('❌ 效果注册失败', 'error');
        return;
      }
    }
    var handler = EFFECT_HANDLERS[item.effect];
    if (handler) {
      var result = handler(item.params);
      if (result && result.message) showToast(result.message, result.error ? 'error' : 'success');
    } else {
      showToast('❌ 未找到效果: ' + item.effect, 'error');
    }
    customPowerUps.splice(index, 1);
    renderCustomPowerUps();
  }

  // ============ 接收平台道具 ============
  window.addEventListener('message', function(e) {
    if (e.data && e.data.type === 'EXTENSION_VOUCHER') {
      var v = e.data.voucher;
      if (!v || !v.data) return;
      var data = v.data;
      if (data.effect) {
        customPowerUps.push({
          id: v.id || ('ugc_' + Date.now()),
          name: data.name || (data.effect + '道具'),
          effect: data.effect,
          params: data.params || {},
          description: data.description || '',
          effectCode: data.effectCode || null,
          icon: data.icon || '⚡',
        });
        renderCustomPowerUps();
        showToast('🎁 获得道具: ' + (data.name || data.effect), 'success');
      }
    }
    if (e.data && e.data.type === 'REDEEM_RESULT' && e.data.data && e.data.data.success) {
      showToast('✅ 兑换成功', 'success');
    }
  });

  renderCustomPowerUps();
})();
</script>
```

### 2.4 你需要自定义的部分

| 部分 | 说明 |
|------|------|
| `EFFECT_HANDLERS` | 根据你的游戏逻辑，定义每个效果的具体实现 |
| `sandboxFn` 参数 | 注入你游戏的变量（如 `game`、`board`、`player` 等） |
| `window.myGame` | 替换为你的游戏实例引用 |

---

## 3. 第二步：发布中心配置

### 3.1 Skills 选择建议

| 游戏类型 | 推荐 Skills | 说明 |
|----------|------------|------|
| 休闲/消消乐 | auth, wallet, leaderboard | 基础登录 + 钱包 + 排行榜 |
| 动作/射击 | auth, wallet, achievements | 成就系统适合动作游戏 |
| 策略/RPG | auth, wallet, inventory, store | 背包 + 商店适合装备系统 |
| 卡牌 | auth, wallet, store, achievements | 卡牌收集 + 商店 |
| 塔防 | auth, wallet, inventory | 道具背包管理 |

### 3.2 兑换道具配置

兑换道具是玩家通过兑换码激活的预制道具（与 UGC 玩家创作道具不同）。

| 字段 | 说明 | 示例 |
|------|------|------|
| 名称 | 道具显示名 | 新手礼包 |
| 描述 | 道具说明 | 获得 100 金币 + 双倍积分 30 秒 |
| 效果类型 | 选择内置类型或 custom | score_boost |
| 价格 | ACOIN 价格 | 50 |
| 数量 | 兑换后获得数量 | 1 |

---

## 4. 第三步：道具 SOP 定义

道具 SOP 决定了玩家在道具工坊中能创作什么样的道具。

### 4.1 使用模板快速开始

在发布中心的"道具 SOP"标签页中，点击模板按钮：

- **🎯 ZUMA 案例** — 完整的祖玛游戏 SOP（可直接参考）
- **📎 通用模板** — 基础框架，替换 `[占位符]` 即可

### 4.2 SOP 核心字段

| 字段 | 必填 | 说明 |
|------|------|------|
| schemaName | ✅ | 唯一标识，如 `mygame-item` |
| aiPrompt | ✅ | 游戏世界观 + 道具规则描述 |
| availableEffects | ✅ | 游戏支持的效果列表 |
| effectRules | | 每个效果的详细说明 |
| constraints | | 数值约束（JSON） |
| forbidden | | 禁止事项 |
| effectCodeEnabled | | 是否开启自定义效果函数 |

### 4.3 编辑模式

- **表单模式** — 逐项填写，适合新手
- **JSON 模式** — 直接编辑完整 JSON，适合有经验的开发者或 AI 辅助

---

## 5. AI 一键改编：完整提示词

将以下提示词复制给 ChatGPT / Claude，附上你的游戏代码，AI 会自动完成 AllinONE 集成：

---

### 提示词模板

```
你是一个 AllinONE 游戏平台的技术专家。请帮我将下面的 HTML 游戏改造为 AllinONE 兼容版本。

## 要求

### 1. 游戏 HTML 集成
在游戏 HTML 的 </body> 前添加 AllinONE 集成代码：
- UGC 道具栏（固定底部，显示已获得的道具）
- Toast 通知系统（顶部弹出提示）
- EXTENSION_VOUCHER 监听器（接收平台下发的道具）
- effectCode 沙箱引擎（安全编译 + 执行自定义效果函数）
- EFFECT_HANDLERS 效果表（根据游戏逻辑实现 3-7 种内置效果）

### 2. 道具 SOP 定义
生成一份 GameItemSop JSON，包含：
- schemaName: "{游戏名}-item"
- aiPrompt: 描述游戏世界观和道具创作规则
- availableEffects: 列出所有内置效果
- effectRules: 每个效果的具体说明
- constraints: 数值约束
- forbidden: 禁止事项（如不能直接胜利）
- effectCodeEnabled: true（如果游戏实现了沙箱引擎）
- effectCodeSandbox: 列出沙箱中可用的变量
- presetItems: 3-6 个预设道具

### 3. Skills 推荐
根据游戏类型推荐适合的 Skills：
- auth（必须有）
- wallet（道具交易需要）
- 其他根据游戏特性选择

### 4. 兑换道具
建议 2-3 个兑换道具（新手礼包、增强包等）

## 输出格式
请按以下顺序输出：
1. 修改后的完整 HTML（标注新增的 AllinONE 集成代码）
2. SOP JSON（可直接粘贴到发布中心）
3. 推荐的 Skills 列表
4. 推荐的兑换道具配置

## 游戏代码
（在此粘贴你的游戏 HTML 代码）
```

---

### 使用方式

1. 复制上面的提示词模板
2. 在末尾粘贴你的游戏 HTML 代码
3. 发送给 AI（ChatGPT / Claude / 其他）
4. AI 会输出：改造后的 HTML + SOP JSON + Skills 建议 + 兑换道具配置
5. 将 SOP JSON 粘贴到发布中心的"道具 SOP" → JSON 模式
6. 上传改造后的 HTML，完成发布

---

## 6. ZUMA 完整案例

### 6.1 游戏概况

祖玛（Zuma）：弹珠链沿路径移动，玩家发射弹珠消除同色组，防止到达终点。

### 6.2 内置效果表（7 种）

| 效果名 | 说明 | 关键参数 |
|--------|------|---------|
| add_score | 立即加分 | bonus: 5-50 |
| clear_color | 清除指定颜色弹珠 | color: 颜色值 |
| slow_chain | 弹珠链减速 10 秒 | 无 |
| remove_tail | 移除尾部 N 个弹珠 | count: 1-10 |
| reverse_chain | 弹珠链反转 | 无 |
| score_multiplier | 分数翻倍 | multiplier: 2-5 |
| freeze_all | 冻结 5 秒 | 无 |

### 6.3 沙箱变量

| 变量 | 说明 |
|------|------|
| `game` | Zuma 游戏实例（score, moveSpeed, marbleDataList 等） |
| `gameState` | 游戏状态对象（score(), marbleCount(), moveSpeed()） |
| `marbles` | 弹珠链表数组（{marble, percent}） |
| `Math` | JavaScript Math |
| `JSON` | JavaScript JSON |

### 6.4 SOP JSON

```json
{
  "schemaName": "zuma-powerup",
  "description": "祖玛游戏道具 — 支持3级创作模式的增益道具系统",
  "aiPrompt": "祖玛(Zuma)游戏道具创作系统。这是一条由彩色弹珠组成的链沿着蜿蜒路径向终点洞穴移动。玩家控制中央的青蛙射手，发射弹珠插入链中，3个或更多同色弹珠相邻时会消除。道具有助于减缓弹珠链、消除弹珠或获得额外分数。",
  "availableEffects": ["add_score", "clear_color", "slow_chain", "remove_tail", "reverse_chain", "score_multiplier", "freeze_all"],
  "effectRules": [
    "add_score: 立即增加分数，bonus 为 5-50 的整数",
    "clear_color: 清除所有指定颜色弹珠，每清除一个加5分",
    "slow_chain: 弹珠链大幅减速 10 秒后恢复",
    "remove_tail: 移除尾部 N 个弹珠，N 为 1-10",
    "reverse_chain: 整条弹珠链反转方向",
    "score_multiplier: 当前分数乘以倍率 (2-5)",
    "freeze_all: 弹珠链完全冻结 5 秒后恢复"
  ],
  "constraints": { "maxScoreAdd": 50, "maxTailRemove": 10, "maxMultiplier": 5, "totalMarbles": 100, "initMarbles": 20 },
  "forbidden": [
    "add_score 不要超过 50 分",
    "remove_tail 不要超过 10 个",
    "不要创建能一次性清除超过 20 个弹珠的道具",
    "不要创建能直接让游戏结束的道具"
  ],
  "effectCodeEnabled": true,
  "effectCodeSignature": "function(params)",
  "effectCodeReturns": "{ message: string }",
  "effectCodeSandbox": {
    "game": "Zuma 实例",
    "gameState": "游戏状态 (score/marbleCount/moveSpeed)",
    "marbles": "弹珠链表数组",
    "Math": "JS Math",
    "JSON": "JS JSON"
  },
  "presetItems": [
    { "name": "加分宝石", "effect": "add_score", "params": { "bonus": 20 }, "description": "立即获得20分", "icon": "✨" },
    { "name": "减速陷阱", "effect": "slow_chain", "params": {}, "description": "弹珠链大幅减速10秒", "icon": "🐌" },
    { "name": "剪刀", "effect": "remove_tail", "params": { "count": 5 }, "description": "移除尾部5个弹珠", "icon": "✂️" },
    { "name": "冰冻宝石", "effect": "freeze_all", "params": {}, "description": "弹珠链冻结5秒", "icon": "❄️" }
  ]
}
```

---

## 7. 检查清单

### 游戏 HTML 集成

- [ ] 添加了 UGC 道具栏 CSS + HTML
- [ ] 添加了 Toast 通知系统
- [ ] 添加了 EXTENSION_VOUCHER 监听器
- [ ] 实现了 EFFECT_HANDLERS（至少 3 种效果）
- [ ] 实现了 registerDynamicEffect 沙箱引擎
- [ ] 沙箱变量正确注入游戏实例
- [ ] 安全关键词黑名单已配置

### 发布中心配置

- [ ] 上传了改造后的游戏 ZIP 包
- [ ] AI 分析结果确认无误
- [ ] Skills 选择合理（至少包含 auth + wallet）
- [ ] 配置了 1-3 个兑换道具
- [ ] 道具 SOP 已填写（schemaName + aiPrompt + availableEffects）
- [ ] SOP 预览文档内容正确
- [ ] 点击"一键发布"成功

### 验证

- [ ] 游戏能正常打开并运行
- [ ] 道具栏在游戏底部显示
- [ ] 从道具工坊创建道具后，游戏中能看到并使用
- [ ] effectCode 自定义效果能正常执行
