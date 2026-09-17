# AllinONE 内容工坊（Content Workshop）指南

> 道具工坊的并列升级：玩家按游戏方「内容创作 SOP」创作**完整内容数据包**（地图/角色/剧情/道具），
> 铸造为**内容凭证**（按次使用、可交易），由游戏内 `AllinONE_ContentLoader` 按次应用。

---

## 一、核心概念

| 维度 | 道具工坊（现有） | 内容工坊（新增，并列） |
|---|---|---|
| 交付物 | 道具 JSON | 内容数据包：`data` + `assets[js/css/图片/音频]` |
| 引导 | 道具 SOP（GameItemSop） | 内容创作 SOP（GameContentSop，独立启用） |
| 凭证 | 道具凭证 | 内容凭证（强制，1 张 = 1 次游戏会话） |
| 生效 | 兑换 postMessage 即时激活 | 游戏内「使用内容凭证」→ loader 应用 → 本次会话生效 |
| 交易 | 可交易/转赠 | 可交易/转赠（凭证只存 manifest，资产在内容库，凭证轻） |
| remix | — | 可上架 remix 版（`?ext=` 切换，走审核） |

> 与任务广场的关键区别：任务广场 merge = **永久发行给所有玩家**；内容凭证 = **个人级按次消费**。
> 两者不共享 merge 链路，只共享底层基础设施（文件库、注入器、校验器）。

---

## 二、游戏方：配置「内容创作 SOP」

在发布中心 →「内容创作 SOP」页签（与「道具 SOP」并列）配置：

### 1. 启用开关
必须打开 `enabled`，游戏才会：
- 分发层注入 `AllinONE_ContentLoader` 骨架（空操作，不激活任何内容）
- 在内容工坊开放该游戏的创作

### 2. contentTypes（JSON）
声明支持创作的内容类型：

```json
[
  {
    "type": "map",
    "slot": "levels",
    "label": "地图",
    "description": "创作自定义地图关卡",
    "modes": ["data", "inject"],
    "apiGuide": "window.MarioLevel.build(api)"
  },
  {
    "type": "character",
    "slot": "items",
    "label": "角色",
    "description": "创作自定义角色/皮肤",
    "modes": ["data"]
  },
  {
    "type": "story",
    "slot": "scripts",
    "label": "剧情",
    "description": "创作剧情章节/对话",
    "modes": ["data"]
  }
]
```

### 3. 创作指南 .md（可选，强烈建议）
上传内容创作指南：玩法说明、创作 API 文档、数据结构、资产打包说明、安全约束。
玩家在内容工坊的 AI 生成时会自动带上该文档作为上下文。

### 4. 游戏侧接收内容包（loader SDK）

游戏零改动即获得 loader，只需注册接收函数：

```html
<script>
  // 方式一：链式注册（推荐）
  window.AllinONE_ContentLoader.on('levels', (pack) => {
    window.MarioLevel.build(pack.data);   // 应用到游戏
  });

  // 方式二：对象表注册
  window.AllinONE_ContentHandlers = window.AllinONE_ContentHandlers || {};
  window.AllinONE_ContentHandlers.levels = (pack) => window.MarioLevel.build(pack.data);

  // 方式三：监听全局事件
  window.addEventListener('allinone:content-pack-applied', (ev) => {
    const pack = ev.detail;  // { contentId, type, slot, data, assets, assetBase }
    console.log('内容已应用:', pack.name);
  });
</script>
```

资产读取帮助器（loader 内置）：

```js
// 获取内容包某资产的绝对 URL（图片/音频/js 等）
const url = window.AllinONE_ContentAssets[contentId].url('content/{contentId}/bg.png');
```

---

## 三、玩家侧：内容工坊（/content-workshop）

1. **选择游戏** — 仅展示启用内容创作 SOP 的游戏
2. **创作**（三种入口）：
   - **AI 生成**：描述需求 → AI 结合创作指南生成内容包 JSON（AI 不可用自动回退本地骨架）
   - **多文件上传**：拖拽 js/css/图片/音频 → 自动打包为内容包
   - **粘贴 JSON**：粘贴 ContentPack JSON（含 assets 内嵌 base64）
3. **预览 + 校验** — 结构校验（slot 注册表）+ 资产清单
4. **铸造内容凭证（强制）** — 设置单价/张数 → 内容资产落库 + 铸造凭证
5. **可选：上架 remix 版** — 提交审核，通过后出现在游戏「扩展」入口（`?ext=` 切换）

### ContentPack 数据格式

```jsonc
{
  "type": "map",                     // map | character | story | item | custom
  "slot": "levels",                  // 复用 QUEST_SLOT_SCHEMAS 或自定义
  "name": "幽暗森林",
  "description": "一张黑暗森林风格的地图",
  "data": { "title": "幽暗森林", "layout": ["###...", "..."], "script": "js/map.js" },
  "assets": [
    { "path": "js/map.js", "content": "window.MarioLevel.build({...})" },
    { "path": "bg.png", "content": "__BINARY_BASE64__..." },   // 二进制用 base64 前缀
    { "path": "music.mp3", "content": "__BINARY_BASE64__..." }
  ]
}
```

---

## 四、游戏内使用内容凭证

1. 打开游戏（仅 contentSop 启用的游戏显示「内容凭证」按钮）
2. 点击「内容凭证 (N)」→ 选择一张未使用的内容凭证
3. 点击使用 → 凭证 REDEEMED（消耗）→ GamePlay 通过
   `postMessage({ type: 'CONTENT_PACK_APPLY', content: {...} })`
   交给游戏内 loader 按次应用（**本次会话生效，刷新/关闭后需重新兑换**）
4. 游戏收到 `allinone:content-pack-applied` 事件或 slot handler 被调用

---

## 五、安全与审核

| 行为 | 策略 |
|---|---|
| 铸造内容凭证 | 默认不审核（持有者自担风险，可下架） |
| 上架 remix 版 | **强制审核**（pending → 游戏方在发布中心审核 → approved 后公开） |

内容脚本在游戏 iframe 内执行（本就在平台沙箱中），风险等同游戏自身代码。
单资产 ≤ 8MB，总包 ≤ 20MB。

---

## 六、演示：超级玛丽二创

超级玛丽已内置 `A1G_EXT` + `window.MarioLevel.build(api)`，是第一个示范：

**建议的 contentSop：**

```jsonc
{
  "enabled": true,
  "contentTypes": [
    {
      "type": "map",
      "slot": "levels",
      "label": "地图",
      "description": "创作自定义地图关卡（MarioLevel.build 格式）",
      "modes": ["data", "inject"],
      "apiGuide": "window.MarioLevel.build(api)，api 暴露 setT/pipe/stairUp/stairDown/grid/setFlag/setEnemies"
    }
  ],
  "sopDocument": "# 超级玛丽地图创作指南\n...（layout 字符网格格式、assets 打包说明）"
}
```

玩家创作一张「幽暗森林」地图 → 铸造内容凭证 → 游戏内使用 → 本局即可选择新地图。

---

## 七、技术链路（后端）

```
内容工坊                      后端 __content 隧道              分发/消费
───────                       ──────────────────               ────────
创作 ContentPack     →   POST /api/v1/games/__content/mint  →   content_assets 集合
                            资产落库 game_files: content/{contentId}/{path}
凭证铸造/交易         →   凭证系统（customData.contentPack manifest）
游戏内使用            →   GET 文件 content/{contentId}/...（复用 /files/* 三级分发）
remix 上架            →   POST /__content/:id/remix (pending)
                         PATCH /__content/:id/remix-status (approved → questExtensions)
GamePlay ?ext= 切换   →   读取 questExtensions（与任务广场扩展共用）
```

- 本地 server：`src/server/routes/content.ts`（挂 `app.use('/api/v1/games/__content', ...)`，在 gamesPublicRouter 之前）
- 云函数：`cloudfunctions/gamesApi/index.js`（`__content` 分支，与本地对齐）
- ⚠️ **双实现铁律**：本地与云函数必须保持一致，否则 dev/prod 行为分叉
- loader 注入点（幂等标记 `<!-- AllinONE 内容加载器 -->`）：
  server `games.ts` / 云函数 `gamesApi` / SW `gameFileServiceWorker-v14.js` / GamePlay inline 模式
