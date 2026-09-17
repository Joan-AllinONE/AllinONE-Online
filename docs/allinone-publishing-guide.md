# AllinONE 游戏发布完整指南

> **目标读者**：游戏开发者 / 使用 AI 辅助改编游戏的开发者
> **版本**：v3.1 | **适用平台**：AllinONE Gaming Platform
>
> ### ⚠️ v3.1 相对 v3.0 的重大变化
>
> **道具经济闭环上线（ITEM_HARVEST）**：游戏内产出的道具（战斗掉落 / 合成 / 成就奖励…）现在可以**提取为平台凭证**，玩家可将其**上架市场交易**，其他玩家购买后**兑换回游戏使用**（还能**跨游戏适配**）。这是平台第一条「游戏内产出 → 真实流转」的经济通道，强烈建议所有游戏接入（见 [4.4 代码段 D](#44-代码段-d道具提取通道-item-harvest--v31-新增强烈建议)）。
>
> ### ⚠️ v3.0 相对旧版的重大变化
>
> 旧版（v2.0）只要求游戏「能跑起来 + 接道具」。**v3.0 起，平台要求接入的游戏必须具备可扩展性**：
>
> 1. **预留 slot 挂载点**——玩家能通过任务广场提交「第二关 / 新地图 / 新道具」，合并后直接进游戏；
> 2. **开放内容创作 SOP**——玩家能在内容工坊用 AI 创作地图、角色、剧情，铸成内容凭证后按次使用；
> 3. **原版 / 扩展必须隔离**——不带 `?ext=` 打开时是**纯净原版**，绝不加载任何扩展。
>
> 一句话：**接入前请先想清楚「玩家能为这个游戏加什么」，并在代码里留好接入口。**

---

## 目录

1. [三大开放通道总览](#1-三大开放通道总览)
2. [发布全流程](#2-发布全流程)
3. [第一步：可扩展性设计（硬性要求）](#3-第一步可扩展性设计硬性要求)
4. [第二步：游戏 HTML 集成四段代码](#4-第二步游戏-html-集成四段代码)
5. [第三步：发布中心配置](#5-第三步发布中心配置)
6. [第四步：任务广场发布首批任务 + 任务开发说明](#6-第四步任务广场发布首批任务--任务开发说明)
7. [完整参考案例：超级玛丽](#7-完整参考案例超级玛丽)
8. [AI 一键改编：完整提示词](#8-ai-一键改编完整提示词)
9. [检查清单](#9-检查清单)
10. [附录：平台接口速查](#10-附录平台接口速查)

---

## 1. 三大开放通道总览

平台为玩家提供三条并列的创作通道，它们**共享底层设施**（文件库、注入器、校验器、凭证经济），但**出口完全不同**。接入游戏时你需要明确开放哪几条。

| 通道 | 入口 | 交付物 | 生效范围 | 审核 | 游戏侧需要做什么 |
|---|---|---|---|---|---|
| **道具工坊** `/workshop` | 玩家自由创作 | 单个道具 JSON | 兑换后长期持有 | 上架需社区投票 | 实现 `EFFECT_HANDLERS` + 双通道监听（**必须**） |
| **任务广场** `/quests` | 有人发悬赏，玩家接单 | 内容包 ContentPack | **永久发行，所有玩家可见** | 开发者直审 / 社区投票 | 预留 **slot 挂载点** + 内容应用函数（**必须**） |
| **内容工坊** `/content-workshop` | 玩家自由创作 | 完整内容数据包（data + assets） | **个人、按次、本次会话** | 铸造不审；上架 remix 强制审核 | 一行注册 `AllinONE_ContentLoader.on`（**可选，强烈建议**） |

**关键区别（务必理解）**：

- 任务广场 merge = **给游戏添东西**（永久发行，`?ext=` 可切换）；
- 内容凭证 = **给自己造体验**（1 张凭证 = 1 次游戏会话，用完即走）；
- 道具凭证 = **给自己加 buff**（兑换后进入背包，长期可用）。

### 🆕 v3.1 道具经济闭环（ITEM_HARVEST）

v3.1 起，道具凭证不再只能靠「兑换码 / 道具工坊」从外部进入游戏——**游戏内产出的道具也能反向提取为凭证**，形成完整闭环：

```
游戏内产出道具（掉落/合成/成就…）
   → 玩家提取为平台凭证（游戏侧 postMessage，见代码段 D）
   → 上架市场出售给其他玩家
   → 买家复制兑换码在游戏内兑换 / 或进入游戏页自动下发
   → 道具回到游戏生效（甚至可适配到另一个游戏使用）
```

对开发者的意义：玩家获得了**打金/交易**的真实动机，游戏时长与留存直接受益。你只需要在游戏里声明「哪些道具可提取」并实现一条 postMessage 通道（约 60 行代码，见 [4.4 代码段 D](#44-代码段-d道具提取通道-item-harvest--v31-新增强烈建议)）。

---

## 2. 发布全流程

```
┌──────────────┐   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
│ ① 可扩展性改造 │ → │ ② 集成代码    │ → │ ③ 上传游戏    │ → │ ④ 配置        │ → │ ⑤ 发布上线    │ → │ ⑥ 发首批任务  │
│  (预留接入口)  │   │ (四段代码)    │   │  (ZIP 包)    │   │ SOP ×2 +技能  │   │  (一键部署)  │   │ + 任务开发说明 │
└──────────────┘   └──────────────┘   └──────────────┘   └──────────────┘   └──────────────┘   └──────────────┘
     你来做             你来做            上传              AI分析+你来配        平台自动            你来发
```

| 步骤 | 谁做 | 说明 |
|------|------|------|
| ① 可扩展性改造 | 开发者（或 AI） | 把硬编码的关卡/地图/配置抽成可外部注入，预留 slot |
| ② 集成代码 | 开发者（或 AI） | 添加扩展加载器 + 内容 loader 注册 + 道具双通道监听 + 道具提取通道（推荐） |
| ③ 上传游戏 | 开发者 | 打包为 ZIP 上传到发布中心 |
| ④ 配置 | 开发者 | 选 Skills、配兑换道具、填**道具 SOP**、开**内容创作 SOP** |
| ⑤ 发布上线 | 平台自动 | 验证、注入 SDK、进入审核（新游戏默认 `pending`） |
| ⑥ 发首批任务 | 开发者 | 在任务广场发任务，并上传《任务开发说明》，社区才能接单 |

---

## 3. 第一步：可扩展性设计（硬性要求）

### 3.1 什么是挂载点 slot

平台**不做源码 diff 合并**。玩家的产物永远是一个**内容包 ContentPack**，被**追加**到你预先声明的**挂载点 slot** 上。

```
原游戏（base，神圣不可侵犯）  +  玩家的 ContentPack  →  合并后追加到 slot
```

内置 slot 注册表（`QUEST_SLOT_SCHEMAS`，提交时按此校验）：

| slot | 标签 | `data` 顶层形状 | 必填字段 | 允许的资源后缀 |
|---|---|---|---|---|
| `levels` | 关卡 | 数组 | `id`, `title` | json / js / png / jpg / mp3 |
| `items` | 道具 | 数组 | `id`, `name` | json / png |
| `skins` | 皮肤 | 数组 | `id`, `name` | json / png / svg / css / jpg |
| `scripts` | 脚本/能力 | 对象 | `name` | js / mjs / json |
| `audio` | 音效 | 对象 | `name` | mp3 / wav / ogg / json |
| `art` | 美术 | 对象 | — | png / jpg / jpeg / svg / webp |
| `fix` | 修复/平衡 | 任意 | — | js / json / css |
| `inject` | 注入脚本/MOD | 任意 | — | js/css/图片/音频/字体（几乎全部） |

> **未注册的自定义 slot 也允许**（自由扩展），只是不强制结构校验。

### 3.2 玩家的五种提交形态，与你的工作量

| 形态 | 玩家交什么 | 你需要做什么 | 推荐度 |
|---|---|---|---|
| **A · 数据型** | 一份 JSON（如关卡字符网格） | 解析 JSON 并应用到游戏 ★ | ★★★ 强烈建议支持 |
| **B · 脚本型** | 一个 `.js`，暴露 `window.<Game>Level.build(api)` | 提供构建 API + 沙箱加载脚本 | ★★ |
| **C · 页面型** | 完整 HTML 页面或片段 | 无需改动（平台用统一壳包裹） | 平台托管 |
| **D · 补文件** | 上传游戏缺失/损坏的文件 | 无需改动（三级路径回退匹配） | 平台托管 |
| **E · 注入 MOD** | 上传一个 JS MOD | **零改动**（平台把脚本注入入口 HTML） | 兜底方案 |

> **只有形态 A 需要你真正写代码**，且它恰好是「玩家能做第二关/新地图」的核心路径。
> 形态 E 是兜底：即使你一行接入口都没留，玩家也能靠注入 MOD 扩展——但体验远不如 A。

### 3.3 接入前必须完成的四项改造

这是本指南的核心。请对照检查你的游戏：

#### ✅ 改造 1：内容数据外置，不要硬编码

```js
// ❌ 反例：关卡写死在代码里，玩家永远加不了新关
var LEVELS = [ { id: '1-1', grid: [[1,1,1],[0,0,0]] } ];

// ✅ 正例：原版数据仍内置，但可被外部数据覆盖/追加
var LEVELS = [ { id: '1-1', grid: [[1,1,1],[0,0,0]] } ];  // 原版（无 _submissionId）
var EXT_LEVELS = [];   // 平台合并进来的扩展关卡（每条带 _submissionId）
function getAllLevels(){ return EXT_LEVELS.length ? LEVELS.concat(EXT_LEVELS) : LEVELS; }
```

#### ✅ 改造 2：提供「内容应用函数」

一个纯函数，输入玩家的 data，输出应用到游戏：

```js
/**
 * 应用一个扩展关卡/地图。返回 true 表示成功。
 * ⚠️ 必须做「防御式兜底」：玩家数据可能缺字段、超范围、格式错误。
 */
function applyLevel(lv){
  if (!lv) return false;
  var rows = parseLayout(lv.layout, lv.cols);   // TODO: 你的解析逻辑
  if (!rows) return false;
  // TODO: 补齐/截断到游戏要求的尺寸、底部地面兜底、终点兜底、出生点校验
  applyToGame(rows);                             // TODO: 写回你的网格/世界
  return true;
}
```

**兜底是必须的**：玩家（和 AI）会提交不完美的数据。尺寸不足补空、超出截断、关键元素（地面/终点/出生点）缺失时自动补上——参考超级玛丽的 `a1gApplyLevel()`。

#### ✅ 改造 3：提供玩家可见的入口 UI

玩家必须能**选到**扩展内容，否则合并了也玩不到。最低要求是一个下拉菜单 / 选关列表：

```
标题界面：[ 关卡 ▼ ]  原版 1-1 / 第二关：砖间历险 / 幽暗森林
```

#### ✅ 改造 4：（进阶）开放构建 API

当纯数据表达不了时（程序化生成、动态地形），暴露一个构建器：

```js
// 玩家脚本入口：window.<Game>Level = { build: function(api){ ... } }
// api 由你定义，例如：
//   api.setT(col,row,value)   放一个瓦片
//   api.pipe(col,topRow)      画管道
//   api.stairUp(col,height)   上升阶梯
//   api.setFlag(col)          设终点
//   api.setEnemies([cols])    设敌人出生点
//   api.grid                  二维数组引用（直接读写）
//   api.T / api.ROWS / api.COLS   常量
```

**API 就是你的边界**：只暴露操作瓦片/实体的能力，不要暴露内部物理、渲染、存档——这些属于源码，平台原则里不公开。

### 3.4 铁律：原版与扩展必须隔离

平台在加载扩展时会给入口 URL 追加 `?ext=<submissionId>`。你的扩展加载器**必须**按此过滤：

| URL | 应该加载什么 |
|---|---|
| 无 `?ext=` | **只有原版**（过滤掉所有带 `_submissionId` 的条目） |
| `?ext=<submissionId>` | 原版 + 该 submissionId 的条目 |

违反这条的后果：玩家打开游戏就看到别人的魔改内容，原版体验被污染。平台在分发层（云函数 / server / SW / inline）也会做同样的过滤，但**游戏侧必须自己兜底**——因为 server 模式下游戏是独立 iframe，平台无法替你筛 `doc.levels`。

---

## 4. 第二步：游戏 HTML 集成四段代码

### 4.1 代码段 A：扩展内容加载器（任务广场 · 必做）

这是通用骨架，直接复制后改 3 处 TODO 即可。源自超级玛丽 `超级玛丽改造5.html` 的 `A1G_EXT`：

```html
<script>
/* ===================== AllinONE 扩展加载器（levels slot） =====================
 * 平台把玩家提交的关卡合并到 published_games[gameId].levels（数组逐条展开追加，
 * 每条带 _submissionId）；启动时拉取公开详情接口，按 ?ext= 过滤后应用到游戏。
 * 铁律：无 ?ext= = 纯净原版（只留无 _submissionId 的原生条目）；
 *       有 ?ext=<id> = 原版 + 该扩展。
 */
var A1G_EXT = {
  gameId: '', apiBase: '',
  customLevels: [],   // 过滤后的扩展关卡
  assetPaths: [],     // 已合并扩展的资源完整路径（脚本/贴图解析用）
  sel: 0,             // 菜单选中项：0=原版，1..N=扩展
  active: -1,         // 当前实际游玩：-1=原版，0..N-1=扩展
  started: false      // 防止重复拉取
};

/* API 基址：线上必须走云函数绝对地址（静态托管域名下 /api 会被 rewrite 吞掉） */
function a1gApiBase(){
  if (/tcloudbaseapp\.com$/.test(location.hostname))
    return 'https://allinonegaming-d4gmsmrzz573264f6.service.tcloudbase.com/api/v1/games';
  return '/api/v1/games';
}
/* gameId 三个来源：① URL path ② ?gameId= ③ 平台的 PROTOCOL:INIT 消息 */
function a1gDetectGameId(){
  var m = location.pathname.match(/\/api\/v1\/games\/([^\/]+?)(\/|$)/);
  if (m){ try { return decodeURIComponent(m[1]); } catch(e){} }
  try { var q = new URLSearchParams(location.search); if (q.get('gameId')) return q.get('gameId'); } catch(e){}
  return '';
}
function a1gExtParam(){
  try { return new URLSearchParams(location.search).get('ext') || ''; } catch(e){ return ''; }
}
/* 路径按段编码（保留 / 分隔，支持中文文件名） */
function a1gEncodePath(p){
  return String(p).split('/').map(function(seg){ return encodeURIComponent(seg); }).join('/');
}
/* 拉取并过滤扩展内容 */
function a1gLoadCustomLevels(){
  var id = A1G_EXT.gameId || a1gDetectGameId();
  if (!id || A1G_EXT.started) return;
  A1G_EXT.gameId = id; A1G_EXT.started = true;
  fetch(a1gApiBase() + '/' + encodeURIComponent(id), { cache: 'no-cache' })
    .then(function(r){ return r.ok ? r.json() : null; })
    .then(function(json){
      if (!json) return;
      var doc = json && json.data ? json.data : json;
      /* 兼容历史嵌套：旧 merge 曾把数组整体 push，产生 [[{...}]]，扁平化一层 */
      var levels = Array.isArray(doc.levels) ? doc.levels : [];   // TODO: 'levels' 换成你的 slot
      var flat = [];
      for (var i = 0; i < levels.length; i++){
        if (Array.isArray(levels[i])){ for (var j = 0; j < levels[i].length; j++) flat.push(levels[i][j]); }
        else flat.push(levels[i]);
      }
      /* 收集已合并扩展的资源路径（如 extensions/quest_x/sub_y/level2.js） */
      var assetPaths = [];
      var exts = Array.isArray(doc.questExtensions) ? doc.questExtensions : [];
      for (var k = 0; k < exts.length; k++){
        var e = exts[k];
        if (e && Array.isArray(e.assets)) for (var m = 0; m < e.assets.length; m++)
          if (e.assets[m] && e.assets[m].path) assetPaths.push(e.assets[m].path);
      }
      A1G_EXT.assetPaths = assetPaths;
      /* 按 ?ext= 过滤：无 ext = 纯净原版；有 ext = 原版 + 该扩展 */
      var ext = a1gExtParam();
      A1G_EXT.customLevels = flat.filter(function(l){
        if (!l || typeof l !== 'object') return false;
        if (!ext) return !l._submissionId;
        return !l._submissionId || l._submissionId === ext;
      });
      if (A1G_EXT.customLevels.length > 0) a1gBuildSelector();
      console.log('[EXT] 扩展内容:', A1G_EXT.customLevels.length, '条');
      a1gAutoSelectFromUrl();   // ?ext= 时自动选中
    })
    .catch(function(){ console.warn('[EXT] 扩展内容加载失败'); });
}
/* 相对路径 → 扩展资源完整路径（三级回退：完全相等 → 以 '/' + 目标 结尾 → basename） */
function a1gResolveAsset(rel){
  var s = rel ? String(rel) : '';
  if (!s) return s;
  if (s.indexOf('extensions/') === 0) return s;
  for (var i = 0; i < A1G_EXT.assetPaths.length; i++){
    var p = A1G_EXT.assetPaths[i];
    if (p === s || p.indexOf('/' + s) >= 0) return p;
    if (p.split('/').pop() === s.split('/').pop()) return p;
  }
  return s;
}
/* 拉取一个已合并的资源文件（脚本用 Blob URL + <script> 执行，非裸 eval） */
function a1gRunScript(src){
  return fetch(a1gApiBase() + '/' + encodeURIComponent(A1G_EXT.gameId) + '/files/' + a1gEncodePath(src),
               { cache: 'no-cache' })
    .then(function(r){ if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
    .then(function(code){
      return new Promise(function(resolve, reject){
        try {
          var s = document.createElement('script');
          s.textContent = code;                  // 或 Blob URL，见超级玛丽实现
          s.onerror = function(){ reject(new Error('脚本加载失败')); };
          document.head.appendChild(s);
          resolve();
        } catch(e){ reject(e); }
      });
    });
}
/* ★TODO 1：把扩展内容应用到游戏（必须做防御式兜底） */
function a1gApplyLevel(lv){
  // 示例（超级玛丽）：解析 15 行字符网格 → 补齐/截断 → 底部地面兜底 → 终点兜底 → 敌人出生点
  // var rows = parseLayout(lv.layout, lv.cols);
  // if (!rows) return false;
  // grid = rows; COLS = rows[0].length; LEVEL_W = COLS * T; ...
  // return true;
  return false;   // TODO: 替换成你的实现
}
/* ★TODO 2：在标题/主菜单渲染入口选择器 */
function a1gBuildSelector(){
  var sel = document.getElementById('level-select');   // TODO: 换成你的 UI 容器
  if (!sel) return;
  var opts = ['原版'];
  for (var i = 0; i < A1G_EXT.customLevels.length; i++)
    opts.push(A1G_EXT.customLevels[i].title || ('扩展 ' + (i + 1)));
  sel.innerHTML = '';
  for (var o = 0; o < opts.length; o++){
    var opt = document.createElement('option');
    opt.value = String(o); opt.textContent = opts[o];
    if (o === A1G_EXT.sel) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.onchange = function(){ a1gSyncSel(Number(sel.value) || 0); };
}
function a1gSyncSel(s){ A1G_EXT.sel = s; /* 选中时如需预加载脚本，在这里触发 */ }
/* 从 ?ext=<submissionId> 自动选中对应扩展（GamePlay 数据型扩展入口透传） */
function a1gAutoSelectFromUrl(){
  var ext = a1gExtParam();
  if (!ext) return;
  for (var i = 0; i < A1G_EXT.customLevels.length; i++){
    if (A1G_EXT.customLevels[i]._submissionId === ext){ a1gSyncSel(i + 1); return; }
  }
}
/* ★TODO 3：游戏开始/重置时，用扩展内容替换默认内容 */
function resetLevel(){
  if (A1G_EXT.active >= 0 && A1G_EXT.customLevels[A1G_EXT.active]){
    if (a1gApplyLevel(A1G_EXT.customLevels[A1G_EXT.active])) { /* 已应用扩展 */ return; }
  }
  buildLevel();      // 原版
}
/* 平台协议 INIT 消息带 gameId（内联/srcDoc 模式下是唯一来源） */
window.addEventListener('message', function(e){
  var d = e.data;
  if (d && d.type === 'PROTOCOL:INIT' && d.gameId){ A1G_EXT.gameId = d.gameId; a1gLoadCustomLevels(); }
});
</script>
```

> **改完记得在启动时调用一次** `a1gLoadCustomLevels()`（或等 `PROTOCOL:INIT`）。
> 完整可运行版本见 `AllinONE Online/超级玛丽二创/超级玛丽改造5.html`（`A1G_EXT` 段落）。

### 4.2 代码段 B：内容工坊接收器（内容创作 · 强烈建议）

**你不需要自己写 loader**——平台在分发时会自动注入 `AllinONE_ContentLoader` 骨架（空操作）。你只需在游戏里**注册接收函数**：

```html
<script>
  // 方式一：链式注册（推荐）
  window.AllinONE_ContentLoader.on('levels', function(pack){
    // pack = { contentId, type, slot, name, data, assets, assetBase }
    a1gApplyLevel(pack.data);        // 复用代码段 A 的应用函数
    startGame();                     // 本次会话立即生效
  });

  // 方式二：对象表注册
  window.AllinONE_ContentHandlers = window.AllinONE_ContentHandlers || {};
  window.AllinONE_ContentHandlers.levels = function(pack){ a1gApplyLevel(pack.data); };

  // 方式三：监听全局事件
  window.addEventListener('allinone:content-pack-applied', function(ev){
    console.log('内容已应用:', ev.detail.name);
  });
</script>
```

loader 会按顺序做：`data.code` 内联执行 → `assets` 里的 `.js` 依次执行 → 派发 `allinone:content-pack-applied` → 调用你的 slot handler。

读取内容包里的图片/音频等资产，用内置帮助器：

```js
// 注入模式下：
var url = AllinONE_asset('bg.png');
// 非注入模式下：
var url = window.AllinONE_ContentAssets[contentId].url('content/' + contentId + '/bg.png');
```

> **注意**：内容凭证是**按次消费**——1 张凭证 = 1 次游戏会话。刷新/关闭后失效，玩家需要再用一张。所以不要把它写进持久化存档。

### 4.3 代码段 C：道具双通道（道具工坊 · 必做）

道具通过**两条通道**下发，必须**同时监听**，否则兑换码兑换的道具到不了游戏。

```html
<!-- ===== CSS：道具栏 + Toast ===== -->
<style>
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
  .toast {
    position: fixed; top: 20px; left: 50%; transform: translateX(-50%) translateY(-100px);
    padding: 10px 20px; background: rgba(0,0,0,0.9); color: #fff; border-radius: 8px;
    font-size: 14px; z-index: 10000; border-left: 4px solid #4caf50;
    transition: transform 0.3s ease; pointer-events: none;
  }
  .toast.show { transform: translateX(-50%) translateY(0); }
</style>

<!-- ===== HTML 容器 ===== -->
<div id="ugc-bar" class="ugc-bar">
  <span class="ugc-label">PROPS</span>
  <span class="ugc-empty">No items yet</span>
</div>
<div id="toast-container"></div>

<script>
(function() {
  'use strict';

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

  /* ===== ★TODO：实现你的内置效果（3-7 种） ===== */
  var EFFECT_HANDLERS = {
    add_score: function(params) {
      // TODO: myGame.score += (params.bonus || 10);
      return { message: '✨ +' + (params.bonus || 10) + ' 分' };
    }
    // TODO: 更多效果...
  };

  /* ===== effectCode 沙箱引擎（自定义效果函数） ===== */
  var _cache = {};
  function registerDynamicEffect(name, codeStr) {
    if (EFFECT_HANDLERS[name]) return true;
    if (_cache[name]) { EFFECT_HANDLERS[name] = _cache[name]; return true; }
    if (!codeStr || typeof codeStr !== 'string' || codeStr.length > 4000) return false;
    var blocked = ['eval(', 'new function', 'import(', 'require(', '__proto__',
      'prototype', 'constructor', 'window.', 'document.', 'parent.', 'top.',
      'globalthis', 'self.', 'fetch(', 'xmlhttprequest', 'websocket', 'worker(',
      'localstorage', 'sessionstorage', 'cookie', 'alert(', 'confirm(', 'prompt('];
    var lower = codeStr.toLowerCase();
    for (var i = 0; i < blocked.length; i++) if (lower.indexOf(blocked[i]) !== -1) return false;
    try {
      // TODO: 把 'game' 换成你的游戏实例
      var fn = new Function('game', 'Math', 'JSON', 'console', 'return (' + codeStr + ');');
      var raw = fn(window.myGame || {}, Math, JSON, console);
      if (typeof raw !== 'function') return false;
      var wrapped = function(params) {
        try { return raw(params) || { message: '效果已执行' }; }
        catch (e) { return { error: true, message: '效果出错: ' + (e.message || e) }; }
      };
      _cache[name] = wrapped; EFFECT_HANDLERS[name] = wrapped;
      return true;
    } catch (e) { return false; }
  }

  /* ===== 道具库存 ===== */
  var customPowerUps = [];
  function renderCustomPowerUps() {
    var bar = document.getElementById('ugc-bar');
    bar.innerHTML = '';
    var label = document.createElement('span');
    label.className = 'ugc-label'; label.textContent = 'PROPS';
    bar.appendChild(label);
    if (!customPowerUps.length) {
      var empty = document.createElement('span');
      empty.className = 'ugc-empty'; empty.textContent = 'No items yet';
      bar.appendChild(empty); return;
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
        showToast('❌ 效果注册失败', 'error'); return;
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
  function addPowerUp(effect, name, params, extra) {
    customPowerUps.push({
      id: (extra && extra.id) || ('ugc_' + Date.now()),
      name: name || effect,
      effect: effect,
      params: params || {},
      description: (extra && extra.description) || '',
      effectCode: (extra && extra.effectCode) || null,
      icon: (extra && extra.icon) || '⚡'
    });
    renderCustomPowerUps();
    showToast('🎁 获得道具: ' + (name || effect), 'success');
  }

  /* ===== 通道 1：EXTENSION_VOUCHER（UGC 道具工坊下发） ===== */
  window.addEventListener('message', function(e) {
    if (!e.data || e.data.type !== 'EXTENSION_VOUCHER') return;
    var v = e.data.voucher;
    if (!v || !v.data || !v.data.effect) return;
    addPowerUp(v.data.effect, v.data.name, v.data.params, v.data);
  });

  /* ===== 通道 2：allinone:item-redeemed（兑换码兑换下发） =====
     ⚠️ detail.effectType 固定为 'custom'；detail.voucherData.effect 在兑换码路径下
        同样可能是占位 'custom'。真正的效果名在 detail.itemId。 */
  var _redeemedIds = {};
  function handleRedeemedItem(detail) {
    var key = detail.code || detail.itemId;
    if (_redeemedIds[key]) return;
    _redeemedIds[key] = true;

    var vd = detail.voucherData || {};
    var realEffect = (vd.effect && vd.effect !== 'custom') ? vd.effect : null;
    if (!realEffect && detail.itemId && detail.itemId !== 'custom') realEffect = detail.itemId;
    if (!realEffect) return;

    addPowerUp(realEffect, vd.name || detail.itemName, vd.params || detail.effects, vd);
  }
  window.addEventListener('allinone:item-redeemed', function(e) { handleRedeemedItem(e.detail); });

  renderCustomPowerUps();
})();
</script>
```

> 完整可运行版本见 `AllinONE Online/超级玛丽二创/超级玛丽改造6.html`（`window.gameAPI` + UGC 集成段）。

### 4.4 代码段 D：道具提取通道（ITEM_HARVEST · v3.1 新增，强烈建议）

让游戏内产出的道具可被玩家**提取为平台凭证**（上架交易 → 买家兑换回游戏 → 可跨游戏适配）。骨架直接复制后改 3 处 TODO：

```html
<script>
/* ===================== AllinONE 道具提取通道（ITEM_HARVEST） =====================
 * 玩家把游戏内产出的道具提取为平台凭证，可上架市场交易；买家兑换回游戏使用。
 * 三条铁律：
 *   1. 只有 origin='gameplay' 的道具参与提取（本地示例/演示道具绝不带此标记）
 *   2. 提取成功后必须删除游戏内道具（防双花：一份道具不能两侧同时存在）
 *   3. harvestId 必须唯一且稳定（平台幂等键，同一道具只能提取一次）
 */
(function() {
  'use strict';

  var harvestItems = [];        // 可提取道具池（你的游戏产出时往里 push）
  var pendingHarvest = {};      // harvestId → true（已发送待平台确认，防重复提交）

  /* ===== 平台模式懒检测：平台内运行才开启提取 ===== */
  function ensurePlatformMode() {
    var cfg = window['__ALL' + 'INONE_CONFIG__'];           // 发布管线注入（v3.1 起）
    var bridge = window.AllinONE;
    return !!(cfg && typeof cfg === 'object') ||
           !!(bridge && (bridge.__GAME_ID__ || bridge.GAME_ID));
  }

  /* ===== ★TODO 1：你的游戏产出可提取道具时调用（连击掉落/BOSS 掉落/成就奖励…） ===== */
  function spawnHarvestItem(name, effect, params, description) {
    if (!ensurePlatformMode()) return;    // 非平台环境（直接打开 HTML）不掉落
    var item = {
      id: 'harvest_' + Date.now() + '_' + Math.floor(Math.random() * 1e6),  // 幂等键，必须唯一
      name: name,
      effect: effect,                     // 必须是道具 SOP availableEffects 里的效果名
      params: params || {},
      description: description || '',
      origin: 'gameplay'                  // ★ 参与提取的标记，缺了平台不认
    };
    harvestItems.push(item);
    // TODO: 在你的游戏 UI 里渲染道具 + 「提取凭证」按钮（点击调 extractHarvestItem(item.id)）
    console.log('[Harvest] 掉落可提取道具:', item.name);
  }

  /* ===== 提取为凭证：postMessage 给平台 → 平台校验+铸造 → 回发结果 ===== */
  function extractHarvestItem(itemId) {
    var item = null;
    for (var i = 0; i < harvestItems.length; i++)
      if (harvestItems[i].id === itemId) { item = harvestItems[i]; break; }
    if (!item || item.origin !== 'gameplay' || pendingHarvest[item.id]) return;
    pendingHarvest[item.id] = true;
    window.parent.postMessage({
      type: 'GAME_EVENT',
      event: 'ITEM_HARVEST',
      data: {
        schemaName: 'YOUR-GAME-powerup',          // ★TODO 2：与道具 SOP 的 schemaName 一致
        harvestId: item.id,
        itemData: { name: item.name, effect: item.effect,
                    params: item.params, description: item.description },
        quantity: 1,
        source: 'gameplay'
      },
      timestamp: Date.now()
    }, '*');
    // 兜底：平台 10s 无响应自动解锁，允许重试
    (function(hid) {
      setTimeout(function() {
        if (pendingHarvest[hid]) { delete pendingHarvest[hid]; /* TODO: 恢复 UI */ }
      }, 10000);
    })(item.id);
  }

  /* ===== 平台 → 游戏 的三类消息 ===== */
  window.addEventListener('message', function(e) {
    var d = e.data;
    if (!d || d.type !== 'PLATFORM_EVENT') return;

    // ① 提取结果：成功必须删游戏内道具（防双花）；失败解锁可重试
    if (d.event === 'ITEM_HARVEST_RESULT') {
      var r = d.data || {};
      delete pendingHarvest[r.harvestId];
      if (r.success) {
        harvestItems = harvestItems.filter(function(p){ return p.id !== r.harvestId; });
        // TODO: 刷新你的道具 UI + toast「已提取为凭证，可在市场交易」
      }
      return;
    }

    // ② 反向提取：平台「游戏道具」面板请求道具清单（只报 origin='gameplay' 的）
    if (d.event === 'REQUEST_GAME_ITEMS') {
      window.parent.postMessage({
        type: 'GAME_EVENT', event: 'GAME_ITEMS',
        data: { items: harvestItems.map(function(p) {
          return { itemId: p.id, schemaName: 'YOUR-GAME-powerup',
                   itemData: { name: p.name, effect: p.effect,
                               params: p.params || {}, description: p.description || '' } };
        }) },
        timestamp: Date.now()
      }, '*');
      return;
    }

    // ③ 反向提取完成确认：删除对应道具（防双花，幂等安全）
    if (d.event === 'ITEM_CONSUMED') {
      var consumedId = (d.data || {}).itemId;
      harvestItems = harvestItems.filter(function(p){ return p.id !== consumedId; });
      delete pendingHarvest[consumedId];
      // TODO: 刷新你的道具 UI
      return;
    }
  });

  // 暴露给你的游戏逻辑调用
  window.AllinONEHarvest = { spawn: spawnHarvestItem, extract: extractHarvestItem };
})();
</script>
```

**★TODO 3**：在你的游戏逻辑里决定「什么时候掉落可提取道具」，例如：

```js
// 示例（Match3 参考实现）：一步内累计消除 ≥ 6 个宝石触发稀有掉落
if (totalMatches >= 6) {
  AllinONEHarvest.spawn('炸弹道具', 'bomb', { radius: 1 }, '清除 3×3 范围宝石');
}
```

**平台侧规则（自动执行，无需你实现）**：

| 规则 | 说明 |
|---|---|
| 限额 | 每用户每游戏每日 10 次提取 |
| 幂等 | 同一 `harvestId` 只能成功提取一次，重复提交被拦截 |
| Schema 校验 | `schemaName` 必须与道具 SOP 注册的一致（如 `match3-powerup`），效果名须在 `availableEffects` 内 |
| 高价值审核 | `itemData` 含 `effectCode` / `effectScript`、或稀有度为高价值档位、或 `highValue: true` → 凭证标记 `pending`，审核通过前禁止上架与兑换 |
| 跨游戏适配 | 买家可将 A 游戏的道具凭证「适配到」B 游戏使用：B 的 SOP 声明包含原 schema → 保持；有声明但不含且效果可通用执行 → 映射到 B 的第一个 schema；B 无声明 → 保持原 schema |

> 完整可运行版本见 `AllinONE Online/Match3Game_effectcode.html`（搜索 `dropHarvestItem` / `extractHarvestItem` / `REQUEST_GAME_ITEMS`）。
>
> ⚠️ **平台模式检测**：发布管线会在 `<head>` 注入 `window.__ALLINONE_CONFIG__`（v3.1 起）。请在**掉落时机**动态检测（懒检测，如上方 `ensurePlatformMode`），不要只在 `init()` 时检测一次——历史版本管线不注入该变量，仅靠 init 检测会导致掉落被静默关闭且零报错。直接双击打开 HTML 时两个注入物都不存在，提取功能应保持关闭。

### 4.5 各代码段工作量对比

| 代码段 | 必须？ | 工作量 | 不做的后果 |
|---|---|---|---|
| A · 扩展加载器 | ✅ 必须 | 中（改 3 处 TODO） | 玩家做的第二关/地图永远进不了游戏 |
| B · 内容 loader 注册 | 建议 | 小（1 行注册） | 内容工坊无法为该游戏开放 |
| C · 道具双通道 | ✅ 必须 | 中（填效果表） | 道具工坊与兑换码道具到不了游戏 |
| D · 道具提取通道（v3.1） | 强烈建议 | 中（改 3 处 TODO） | 游戏内道具无法提取为凭证交易，玩家失去「打金」动机 |
| E · 游戏奖励活动上报（v3.2） | 可选加入 | 小（1 个工具函数 + 每个触发点 1 行） | 只能有「进入游戏」的点击奖励，无法奖励通关/成就等真实游戏行为 |

---

### 4.6 跨游戏道具兑换（v3.2 · 游戏方需要知道的事）

各游戏的 `effect` 是**各自私有的 `EFFECT_HANDLERS` key**（如 `remove_area` / `clear_color` / `invincible`），
跨游戏原样搬运必然报「未找到效果」。平台因此提供**三条转换路径**，可靠性从高到低：

| 路径 | 说明 | 可靠性 | 谁决定可用性 |
|---|---|---|---|
| **A 等值兑换**（推荐） | 核销原凭证 → 按估值兑换为**目标游戏自己的道具凭证**，走目标游戏原生兑换链路 | **100%** | 目标游戏有道具模板（你发布的道具或已过审 UGC） |
| **B 语义映射** | 按效果语义标签（如 `CLEAR_COLOR` / `ADD_TIME`）替换成目标游戏的等价 effect，参数按其约束夹取 | 中 | 双方效果共享同一语义标签 |
| **C 原样搬运** | 直接把源 effect 搬过去 | 极低（默认折叠 + 需玩家勾选告知） | 目标游戏恰好实现了同名 effect |

执行铁律：**先产出目标侧凭证，再核销源凭证**；任一步失败则源凭证保持 ACTIVE 可重试。含 `effectCode` 的道具禁止走 B/C。

#### 游戏方可以做的两件事

**① 声明效果语义标签**（发布道具 Schema 时写进 `aiGuide.effectTags`）：

```jsonc
aiGuide: {
  availableEffects: ['remove_area', 'clear_color', 'add_time'],
  effectTags: {
    remove_area:  ['CLEAR_AREA'],   // 范围清除
    clear_color:  ['CLEAR_COLOR'],  // 同色清除
    add_time:     ['ADD_TIME'],     // 增加时间
  }
}
```

可用标签（`src/publishing-center/protocol/EffectTags.ts`）：
`CLEAR_AREA` / `CLEAR_COLOR` / `CLEAR_ROWCOL` / `CLEAR_TAIL` / `ADD_TIME` / `ADD_MOVES` /
`ADD_SCORE` / `MULTIPLY_SCORE` / `SLOW` / `FREEZE` / `REVERSE` / `SHUFFLE` / `TRANSFORM` /
`BUFF_PLAYER` / `DEBUFF_ENEMY` / `DISPLAY`。
**不声明也没关系**——平台内置字典已覆盖 match3 / zuma / 常见通用效果的常见命名。

**② 上报道具价值**（`ITEM_HARVEST` 时在 `itemData.value` 带上估值点数）：

```js
bridge.harvestItem({
  schemaName: 'match3-powerup',
  harvestId: 'drop-' + Date.now(),
  itemData: { name: '炸弹道具', effect: 'remove_area', params: { radius: 1 }, value: 20 },
});
```

不给 `value` 时，平台会按「语义标签权重 × 参数量级 × 稀有度系数」启发式估值（自带 +30% 自定义代码加成）。
规则：**目标道具价值 ≤ 源道具估值**，禁止低换高；折损 > 20% 时 UI 会显式提示。

### 4.7 平台游戏奖励活动（GAME_EVENT 上报 · v3.2 新增，可选加入）

平台运营者可以在**凭证系统 →「游戏绑定」**中为你的游戏配置 **A 币凭证奖励**（奖池来源可选平台奖池或用户奖池）。玩家游玩你的游戏时即可自动获得凭证奖励。

**是否加入由你决定**——这是一个纯增量活动：

| 加入程度 | 你需要做的 | 玩家能获得的奖励 |
|---|---|---|
| 不做任何事 | 无 | 仅「进入游戏」时的点击奖励（平台自动触发 GAME_CLICK，无需游戏配合） |
| **集成代码段 E**（推荐） | 1 个工具函数 + 每个触发点 1 行 | 通关 / 胜利 / 过关 / 成就 / 分数里程碑等**真实游戏行为**奖励 |

**触发机制（平台侧自动执行，无需你实现发放逻辑）**：

1. **点击奖励**：玩家从游戏中心点「游玩」进入游戏时，平台自动触发（游戏侧零改动）；
2. **行为奖励**：游戏内上报下方白名单事件时，平台自动发放——**这需要游戏侧集成代码段 E**；
3. **防刷**：绑定配置的每日上限 / 总量上限 / 冷却时间由平台自动执行，重复上报是安全的。

**运营者：绑定「触发方式」怎么选**（凭证系统 → 游戏绑定 → 触发方式）：

| 触发方式 | 实际触发时机 | 对游戏侧的要求 |
|---|---|---|
| **点击游玩时**（ON_CLICK） | 玩家从游戏中心点「游玩」进入的瞬间 | **无**——立即可用，推荐作为起步选项 |
| **游戏完成时**（ON_GAME_COMPLETE） | 游戏上报 `GAME_COMPLETE` / `GAME_WIN` / `LEVEL_COMPLETE` / `SCORE_MILESTONE` | 需集成代码段 E 并重新发布 |
| **成就解锁时**（ON_ACHIEVEMENT） | 游戏上报 `ACHIEVEMENT_UNLOCK` | 需集成代码段 E 并重新发布 |
| **手动触发**（MANUAL） | 不参与自动发放，仅供管理端调用 | 无 |

> ⚠️ **未集成代码段 E 的游戏请选「点击游玩时」**——「游戏完成时 / 成就解锁时」依赖游戏上报事件，游戏未集成时绑定永远不会触发（绑定列表会显示提醒）。两种方式可叠加：为同一游戏创建多条绑定（如一条点击奖励 + 一条通关奖励），平台按各自限制独立防刷。

**可上报事件（平台白名单）**：

| 事件 | 语义 | 典型触发点 |
|---|---|---|
| `GAME_COMPLETE` | 通关 | 到达终点 / 打败最终 BOSS |
| `GAME_WIN` | 对局胜利 | 竞技/对抗玩法获胜 |
| `LEVEL_COMPLETE` | 过关（非最终关） | 通过第 N 关 |
| `ACHIEVEMENT_UNLOCK` | 成就解锁 | 成就系统触发 |
| `SCORE_MILESTONE` | 分数里程碑 | 分数首次突破阈值 |

#### 代码段 E：游戏奖励上报骨架

```html
<script>
/* ===================== AllinONE 游戏奖励活动上报（GAME_EVENT） =====================
 * 平台「游戏绑定」奖励的触发通道：在通关/胜利/成就等关键时刻上报给平台，
 * 平台按绑定配置自动发放 A 币凭证奖励（每日/总量/冷却限制由平台自动执行）。
 * 事件白名单：GAME_COMPLETE / GAME_WIN / LEVEL_COMPLETE /
 *             ACHIEVEMENT_UNLOCK / SCORE_MILESTONE
 */
var AllinONE_Reward = {
  /** 是否运行在平台 iframe 内（独立双击打开 HTML 时为 false，全部跳过） */
  inPlatform: function () {
    try { return !!(window.parent && window.parent !== window); } catch (e) { return false; }
  },
  /** ★ 在游戏的关键状态切换点调用（每个事件只上报一次） */
  report: function (event, data) {
    if (!AllinONE_Reward.inPlatform()) return;   // 非平台环境不上报
    try {
      window.parent.postMessage({
        type: 'GAME_EVENT',
        event: event,                            // 如 'GAME_COMPLETE'
        data: data || {},                        // 如 { score: 2500, coins: 12, level: 3 }
        timestamp: Date.now()
      }, '*');
      console.log('[Reward] 已上报', event, data || '');
    } catch (e) { /* 上报失败绝不影响游戏运行 */ }
  }
};
</script>
```

**调用方式——★铁律：只在状态切换点上报（单次触发），绝不在渲染/游戏循环里调用**：

```js
// ✅ 正例（超级玛丽改造6 实际实现）：到达门口 → 状态切换为 cleared，只执行一次
if (player.x >= DOOR_X) {
  game.state = 'cleared';
  AllinONE_Reward.report('GAME_COMPLETE', {
    score: game.score, coins: game.coins, level: game.level + 1, levelName: game.levelName
  });
}

// ❌ 反例：放在 requestAnimationFrame / update() / draw() 里，每帧都会上报
```

**数据字段建议**：`data` 里带上 `score` / `level` 等游戏上下文（平台侧展示与将来按分档发放会用到），但字段名与结构由你自定义，平台不校验。

> 完整可运行版本见 `AllinONE Online/超级玛丽二创/超级玛丽改造6.html`——通关点（`player.x >= DOOR_X → state='cleared'`）内联了与代码段 E 等价的 `postMessage` 上报。
>
> ⚠️ **改完游戏 HTML 必须重新发布**，上报代码才会进入线上包；行为奖励生效还需要运营者已在「游戏绑定」中为该游戏创建绑定且奖池有余额。

---

## 5. 第三步：发布中心配置

### 5.1 流程与页签

```
① 上传游戏（ZIP）→ ② AI 分析（自动检测类型/框架/入口）→ ③ 配置（5 个页签）→ ④ 一键发布
```

**③ 配置** 的 5 个页签：

| 页签 | 内容 |
|---|---|
| **Skills** | 选择平台能力（auth / wallet / leaderboard / achievements / inventory / store…） |
| **兑换道具** | 玩家用兑换码激活的预制道具 |
| **道具 SOP** | 玩家在道具工坊能创作什么（`GameItemSop`） |
| **内容创作 SOP** | 玩家在内容工坊能创作什么（`GameContentSop`）——**新增强制项** |
| **简介** | 封面与游戏介绍 |

### 5.2 Skills 选择建议

| 游戏类型 | 推荐 Skills |
|----------|------------|
| 休闲/消消乐 | auth, wallet, leaderboard |
| 动作/射击 | auth, wallet, achievements |
| 策略/RPG | auth, wallet, inventory, store |
| 卡牌 | auth, wallet, store, achievements |
| 塔防 | auth, wallet, inventory |

### 5.3 道具 SOP（GameItemSop）

| 字段 | 必填 | 说明 |
|------|------|------|
| `schemaName` | ✅ | 唯一标识，如 `mario-powerup` |
| `aiPrompt` | ✅ | 游戏世界观 + 道具规则描述 |
| `availableEffects` | ✅ | 游戏支持的效果列表（须与 `EFFECT_HANDLERS` 一一对应） |
| `effectRules` | | 每个效果的详细说明 |
| `constraints` | | 数值约束（JSON） |
| `forbidden` | | 禁止事项 |
| `effectCodeEnabled` | | 是否开启自定义效果函数（需实现沙箱引擎） |
| `effectCodeSandbox` | | 沙箱可用变量清单 |
| `presetItems` | | 3-6 个预设道具 |

编辑模式：**表单模式**（新手）/ **JSON 模式**（有经验者或 AI 辅助）。
发布中心内置两个模板按钮：`🎯 ZUMA 案例`、`📎 通用模板`。

### 5.4 内容创作 SOP（GameContentSop）—— 新增

**必须显式打开 `enabled` 开关**，平台才会：① 在分发时注入 `AllinONE_ContentLoader` 骨架；② 在内容工坊开放该游戏的创作入口。

```jsonc
{
  "enabled": true,
  "contentTypes": [
    {
      "type": "map",              // map | character | story | item | custom
      "slot": "levels",           // 复用 QUEST_SLOT_SCHEMAS 或自定义挂载点
      "label": "地图",
      "description": "创作自定义地图关卡",
      "modes": ["data", "inject"], // data | inject | extension | fragment
      "apiGuide": "window.MarioLevel.build(api)，api 暴露 setT/pipe/stairUp/stairDown/grid/setFlag/setEnemies"
    },
    {
      "type": "character",
      "slot": "items",
      "label": "角色",
      "description": "创作自定义角色/皮肤",
      "modes": ["data"]
    }
  ],
  "allowedModes": ["data", "inject", "extension", "fragment"]
}
```

同时**强烈建议上传一份创作指南 `.md`**：玩法说明、创作 API、数据结构、资产打包规范、安全约束。
这份文档会**自动作为上下文喂给玩家的 AI**——你写得越清楚，玩家产出的内容质量越高。

**ContentPack 数据格式**（玩家提交 / AI 生成的目标形态）：

```jsonc
{
  "type": "map",
  "slot": "levels",
  "name": "幽暗森林",
  "description": "一张黑暗森林风格的地图",
  "data": { "id": "forest", "title": "幽暗森林", "layout": ["###...", "..."], "script": "js/map.js" },
  "assets": [
    { "path": "js/map.js", "content": "window.MarioLevel.build({...})" },
    { "path": "bg.png",    "content": "__BINARY_BASE64__..." }
  ]
}
```

---

## 6. 第四步：任务广场发布首批任务 + 任务开发说明

发布完成后，去 `/quests` 为你自己的游戏发 1-3 个任务，作为社区参与的「种子」。

### 6.1 任务字段

| 字段 | 说明 | 建议值 |
|---|---|---|
| `title` / `description` | 任务标题与要求描述 | 越具体越好，AI 和玩家都靠它理解需求 |
| `type` | level / item / skin / script / audio / art / fix | |
| `contentSlot` | 挂载点 | 与代码段 A 读取的字段一致（如 `levels`） |
| `reward` | `{ gameCoins?, aCoins?, voucherTemplateId? }` | 报酬走平台钱包，合并即发放 |
| `reviewMode` | `developer`（直审）/ `community`（投票，默认 3 票通过） | 明确需求用直审 |
| `maxClaimers` | 0=无限 / 1=独占 / N=竞争 | 3 |
| `acceptance.maxFileSize` | 单文件上限 | 默认 512KB |
| `devGuide` | **《任务开发说明》.md** | **必须上传** |

### 6.2 《任务开发说明》（devGuide）

这是**玩家与玩家 AI 的唯一依据**。原则：**只公开接口与数据格式，一行游戏源码都不给。**

模板见 `docs/游戏任务开发说明-模板.md`，填写好的范例见 `AllinONE Online/超级玛丽二创/超级玛丽-任务开发说明.md`。

必须包含 7 节：

1. **游戏简介**（玩法 + 操作）
2. **你能为这个游戏做什么**（任务类型 × 难度 × 对应 slot 的表格）
3. **通用约定**（ContentPack / assets 相对路径 / 合并后才生效 / 安全与版权）
4. **游戏方开放的接口**（数据字段表 + 效果表 + 脚本沙箱签名与可用变量）
5. **让 AI 帮你完成任务的提示词模板**（可直接复制的那段）
6. **提交格式与步骤**（data / assets / entryPoint + 提交前自检清单）
7. **常见问题**

> **第 5 节是整个系统的放大器**：玩家不会写代码也能靠它完成提交——把任务要求 + 接口表丢给 AI，AI 输出 JSON，粘贴提交，完事。而你的源码从头到尾没离开过服务器。

---

## 7. 完整参考案例：超级玛丽

仓库内的两个文件分别示范两条通道，建议对照阅读：

| 文件 | 示范内容 | 关键符号 |
|---|---|---|
| `AllinONE Online/超级玛丽二创/超级玛丽改造5.html` | **任务广场 slot 扩展**（模式 A 数据型 + 模式 B 脚本型 + `?ext=` 过滤） | `A1G_EXT`、`a1gLoadCustomLevels()`、`a1gApplyLevel()`、`a1gPrepareScriptLevel()`、`a1gBuildSelector()` |
| `AllinONE Online/超级玛丽二创/超级玛丽改造6.html` | **道具通道 + 奖励上报**（`window.gameAPI` 效果 API + 双通道监听 + 沙箱 + 通关 `GAME_COMPLETE` 上报） | `window.gameAPI`、`EFFECT_HANDLERS`、`handleRedeemedItem()`、`GAME_EVENT/GAME_COMPLETE`（见 4.7 代码段 E） |
| `AllinONE Online/Match3Game_effectcode.html` | **道具提取通道（v3.1）**（连击掉落 → 提取凭证 → 交易闭环 + 懒检测） | `ensurePlatformMode()`、`dropHarvestItem()`、`extractHarvestItem()`、`HARVEST_PRESETS` |

### 7.1 关卡数据格式（15 行字符网格）

| 字符 | 含义 | 字符 | 含义 |
|---|---|---|---|
| ` `（空格） | 空 | `[` | 管道身（左） |
| `#` | 地面 | `]` | 管道身（右） |
| `B` | 砖块 | `C` / `o` | 金币 |
| `?` | 问号金币块 | `M` | 蘑菇块 |
| `U` | 已用块 | `X` | 硬块 |
| `(` | 管道（左缘） | `F` | 旗杆 |
| `)` | 管道（右缘） | | |

关卡字段：`id`✅ / `title`✅ / `layout` 或 `script`（二选一）/ `cols` / `enemyCols` / `flag` / `flagCol` / `castleCol`

硬性规则：行数固定 15；每行等宽；底部留 1~2 行 `#` 地面；管道上下成对；敌人不放出生点。

### 7.2 构建 API（模式 B）

```js
window.MarioLevel = { build: function (api) {
  api.setT(8, 9, 3);        // 在 (列8, 行9) 放问号金币块
  api.pipe(22, 11);         // 画管道
  api.stairUp(64, 4);       // 上升阶梯
  api.stairDown(116, 6);    // 下降阶梯
  api.setFlag(138);         // 旗杆列
  api.setEnemies([15, 28, 47]);
} };
```

`api` 还提供 `grid`（15×cols 二维数组引用）、常量 `T` / `ROWS` / `COLS`。
底部两行地面与末尾旗杆由游戏侧自动兜底，玩家不用画。

### 7.3 建议的 contentSop

```jsonc
{
  "enabled": true,
  "contentTypes": [
    { "type": "map", "slot": "levels", "label": "地图",
      "description": "创作自定义地图关卡（MarioLevel.build 格式）",
      "modes": ["data", "inject"],
      "apiGuide": "window.MarioLevel.build(api)，api 暴露 setT/pipe/stairUp/stairDown/grid/setFlag/setEnemies" }
  ],
  "sopDocument": "# 超级玛丽地图创作指南\n..."
}
```

---

## 8. AI 一键改编：完整提示词

把下面这段复制给 ChatGPT / Claude，附上你的游戏代码，AI 会完成全部改造。

````text
你是一个 AllinONE 游戏平台的技术专家。请帮我把下面的 HTML 游戏改造为 AllinONE 兼容版本。

【背景】
AllinONE 是一个 UGC 游戏平台。玩家可以通过三条通道为游戏贡献内容：
1. 道具工坊：玩家创作道具 JSON，兑换后在游戏内使用（需游戏实现效果表 + 双通道监听）
2. 任务广场：玩家接悬赏做「第二关 / 新地图 / 新道具」，审核合并后永久发行给所有玩家
3. 内容工坊：玩家用 AI 创作完整内容数据包（地图/角色/剧情），铸成内容凭证后按次使用

平台铁律：
- 不做源码 diff 合并。玩家的产物是「内容包 ContentPack」，被追加到游戏声明的挂载点 slot 上
- 原版与扩展必须隔离：URL 无 ?ext= 时只加载纯净原版；?ext=<submissionId> 时才加载该扩展
- 只公开接口与数据格式，游戏源码不对外

═══════════════════════════════════════
【任务 1 · 可扩展性改造（最重要，先做）】
═══════════════════════════════════════

分析我的游戏，找出「玩家最可能想扩展什么」（关卡 / 地图 / 角色 / 道具 / 剧情），然后：

1. 内容数据外置：把硬编码的关卡/地图数据抽成数组常量，允许外部数据追加，不要写死
2. 提供内容应用函数 applyContent(data)，输入玩家的 data 输出应用到游戏，返回布尔值。
   必须做防御式兜底：尺寸不足补空、超出截断、关键元素（地面/终点/出生点）缺失时自动补上
3. 提供玩家可见的入口 UI：标题界面或主菜单加一个下拉/列表，能选到「原版」和各个扩展内容
4. （可选）如果纯数据表达不了，设计一个构建 API：
   window.<Game>Level = { build: function(api){ ... } }
   api 只暴露操作瓦片/实体的能力（如 setT / pipe / setFlag / setEnemies / grid），
   不要暴露内部物理、渲染、存档逻辑

═══════════════════════════════════════
【任务 2 · 集成代码段 A：扩展内容加载器】
═══════════════════════════════════════

在游戏 HTML 的 </body> 前添加扩展加载器，要求：

1. API 基址按 hostname 判断：
   - tcloudbaseapp.com 结尾 → https://allinonegaming-d4gmsmrzz573264f6.service.tcloudbase.com/api/v1/games
   - 其他 → /api/v1/games
2. gameId 三个来源依次尝试：① URL path /api/v1/games/<gameId> ② ?gameId= ③ 平台 postMessage
   { type:'PROTOCOL:INIT', gameId }
3. 启动时 fetch GET {apiBase}/{gameId}（返回 { data: {...} }），读取我声明的 slot 字段（如 doc.levels）
4. 兼容历史嵌套：数组元素还是数组时扁平化一层
5. 收集 doc.questExtensions[].assets[].path 作为资源路径清单
6. 按 ?ext= 过滤（铁律）：
   - 无 ?ext= → 只保留没有 _submissionId 的条目（纯净原版）
   - 有 ?ext=<id> → 保留无 _submissionId 的 + _submissionId === <id> 的
7. 有 ?ext= 时自动选中对应扩展
8. 资源相对路径解析用三级回退：完全相等 → 以 '/'+目标 结尾 → basename 相同
9. 拉取资源：GET {apiBase}/{gameId}/files/{path}（路径按段 encodeURIComponent）
10. 脚本型关卡（data.script）用 fetch + Blob URL + <script> 标签执行（不用裸 eval），
    加载后调用 window.<Game>Level.build(api)，把构建结果缓存起来
11. 游戏开始/重置时：选中了扩展就用 applyContent 应用，否则走原版逻辑
12. 全部失败要 catch 住并降级到原版，绝不能因为扩展加载失败导致游戏打不开

═══════════════════════════════════════
【任务 3 · 集成代码段 B：内容工坊接收器】
═══════════════════════════════════════

注册内容包接收函数（平台会自动注入 AllinONE_ContentLoader 骨架，你只需注册回调）：

window.AllinONE_ContentLoader.on('<slot>', function(pack){
  // pack = { contentId, type, slot, name, data, assets, assetBase }
  applyContent(pack.data);   // 复用任务 1 的应用函数
});

注意：内容凭证是按次消费（1 张 = 1 次会话），不要写进持久化存档。

═══════════════════════════════════════
【任务 4 · 集成代码段 C：道具双通道】
═══════════════════════════════════════

1. UGC 道具栏（固定底部，显示已获得道具）+ Toast 通知（顶部弹出）
2. EFFECT_HANDLERS 效果表：根据游戏逻辑实现 3-7 种内置效果，每种返回 { message: string }
3. effectCode 沙箱引擎：new Function 编译自定义效果，注入游戏实例作为沙箱变量，
   长度上限 4000 字符，黑名单拦截 eval / new Function / window / document / fetch /
   localStorage / alert 等危险 API
4. 必须同时监听两条通道，缺一不可：
   - postMessage { type:'EXTENSION_VOUCHER' }（UGC 道具工坊下发）
   - CustomEvent 'allinone:item-redeemed'（兑换码兑换下发）
5. 解析效果名时必须排除占位 'custom'：
   detail.effectType 固定是 'custom'（不要用）；
   detail.voucherData.effect 在兑换码路径下也可能是 'custom'；
   真正的效果名在 detail.itemId
6. 同一个道具去重（按 code 或 itemId），避免重复入包

═══════════════════════════════════════
【任务 5 · 集成代码段 D：游戏内道具提取（ITEM_HARVEST，强烈建议）】
═══════════════════════════════════════

让游戏内产出的道具可提取为平台凭证（上架市场交易 → 买家兑换回游戏 → 可跨游戏适配）：

1. 实现 window.AllinONEHarvest = { spawn, extract }：
   - spawn(name, effect, params, description)：产出可提取道具，带唯一 id（平台幂等键）
     和 origin:'gameplay' 标记；先做平台模式懒检测
     （window.__ALLINONE_CONFIG__ 或 window.AllinONE.__GAME_ID__/GAME_ID 任一存在），
     非平台环境（直接打开 HTML）不掉落
   - extract(itemId)：postMessage { type:'GAME_EVENT', event:'ITEM_HARVEST',
     data:{ schemaName, harvestId, itemData:{name,effect,params,description}, quantity:1, source:'gameplay' } }
2. 监听平台三类消息（type:'PLATFORM_EVENT'）：
   - ITEM_HARVEST_RESULT：success → 删除游戏内道具（防双花）；失败 → 解锁允许重试（附 10s 超时兜底）
   - REQUEST_GAME_ITEMS → 回 { type:'GAME_EVENT', event:'GAME_ITEMS',
     data:{ items:[{ itemId, schemaName, itemData }] } }（只报 origin='gameplay' 的道具）
   - ITEM_CONSUMED → 删除对应道具（平台反向提取完成确认）
3. schemaName 必须与道具 SOP 的 schemaName 一致；effect 必须在 availableEffects 内
4. 在游戏逻辑里选一个产出点（如连击 ≥ 6 / BOSS 掉落 / 成就奖励）触发 spawn
5. UI：掉落提示 + 可提取道具列表 + 「提取凭证」按钮 + 提取结果 toast

═══════════════════════════════════════
【任务 6 · 输出配套配置】
═══════════════════════════════════════

1. 道具 SOP（GameItemSop JSON）：
   schemaName="{游戏名}-powerup"、aiPrompt（世界观+规则）、availableEffects（与 EFFECT_HANDLERS 一一对应）、
   effectRules、constraints（数值上限）、forbidden（禁止事项）、
   effectCodeEnabled、effectCodeSignature="function(params)"、effectCodeReturns="{ message: string }"、
   effectCodeSandbox（沙箱可用变量清单）、presetItems（3-6 个预设道具）

2. 内容创作 SOP（GameContentSop JSON）：
   { enabled: true, contentTypes: [{ type, slot, label, description, modes, apiGuide }] }
   modes 从 data / inject / extension / fragment 中选；apiGuide 写清你的构建 API

3. 内容创作指南 .md：玩法说明、创作 API、数据结构、资产打包规范、安全约束。
   这份文档会作为上下文喂给玩家的 AI，请写详细

4. 《任务开发说明》.md（玩家版，7 节）：
   ① 游戏简介（玩法+操作）② 你能为这个游戏做什么（任务类型×难度×slot 表格）③ 通用约定
   ④ 游戏方开放的接口（数据字段表+效果表+脚本沙箱）⑤ 让 AI 帮你完成任务的提示词模板
   ⑥ 提交格式与步骤（data/assets/entryPoint + 提交前自检）⑦ 常见问题
   原则：只公开接口与数据格式，不出现任何游戏源码

5. 推荐 Skills 列表（auth 必须有，wallet 建议有，其余按游戏类型选）

6. 建议 2-3 个兑换道具

7. 建议 2-3 个种子任务（标题 + 描述 + slot + 报酬 + 审核方式），用于发到任务广场

═══════════════════════════════════════
【输出格式】
═══════════════════════════════════════

按顺序输出：
1. 可扩展性改造说明（你改了哪些地方、为什么）
2. 修改后的完整 HTML（标注新增的 AllinONE 集成代码段 A / B / C / D）
3. 道具 SOP JSON
4. 内容创作 SOP JSON
5. 内容创作指南 .md
6. 《任务开发说明》.md
7. 推荐的 Skills 列表
8. 建议的兑换道具配置
9. 建议的种子任务

═══════════════════════════════════════
【参考实现】
═══════════════════════════════════════

- 扩展加载器完整范例：AllinONE Online/超级玛丽二创/超级玛丽改造5.html（搜索 A1G_EXT）
- 道具通道完整范例：AllinONE Online/超级玛丽二创/超级玛丽改造6.html（搜索 window.gameAPI）
- 任务开发说明范例：AllinONE Online/超级玛丽二创/超级玛丽-任务开发说明.md

═══════════════════════════════════════
【游戏代码】
═══════════════════════════════════════
（在此粘贴你的游戏 HTML 代码）
````

### 使用方式

1. 复制上面的提示词，在末尾粘贴你的游戏 HTML
2. 发给 AI（ChatGPT / Claude / 其他）
3. AI 输出改造后的 HTML + 两份 SOP JSON + 两份 .md + Skills + 种子任务
4. HTML 打包成 ZIP 上传发布中心
5. 「道具 SOP」页签 → JSON 模式 → 粘贴；「内容创作 SOP」页签 → 粘贴 + 开 `enabled`
6. 「兑换道具」填好 → 一键发布
7. 发布后去 `/quests` 发种子任务，上传《任务开发说明》.md

---

## 9. 检查清单

### 可扩展性（v3.0 新增，一票否决）

- [ ] 关卡/地图/内容数据已外置，未硬编码
- [ ] 提供了内容应用函数，且做了防御式兜底（尺寸补齐/截断、关键元素缺失自动补）
- [ ] 提供了玩家可见的入口 UI（下拉/列表能选到扩展内容）
- [ ] 声明了 slot（优先用内置 `levels` / `items` / `skins` / `scripts`…）
- [ ] （可选）开放了构建 API，且只暴露瓦片/实体操作，不暴露内部实现

### 代码段 A · 扩展加载器

- [ ] API 基址按 hostname 区分 prod / dev
- [ ] gameId 三个来源都支持（URL path / `?gameId=` / `PROTOCOL:INIT`）
- [ ] 拉取详情接口，读取声明的 slot 字段
- [ ] 兼容历史嵌套数组，扁平化一层
- [ ] **按 `?ext=` 过滤：无 ext = 纯净原版**（只留无 `_submissionId` 的条目）
- [ ] 有 `?ext=` 时自动选中对应扩展
- [ ] 资源路径三级回退解析
- [ ] 脚本型内容用 Blob URL + `<script>` 执行（非裸 eval）
- [ ] 全程 try/catch，扩展加载失败降级到原版，不影响游戏启动

### 代码段 B · 内容 loader

- [ ] 注册了 `window.AllinONE_ContentLoader.on('<slot>', handler)`
- [ ] 复用代码段 A 的应用函数，没有重复实现
- [ ] 内容凭证按次生效，未写入持久化存档

### 代码段 C · 道具双通道

- [ ] UGC 道具栏 CSS + HTML 已添加
- [ ] Toast 通知系统已添加
- [ ] `EFFECT_HANDLERS` 实现 ≥ 3 种效果，与 SOP 的 `availableEffects` 一一对应
- [ ] `registerDynamicEffect` 沙箱引擎已实现，黑名单已配置
- [ ] 沙箱变量正确注入游戏实例
- [ ] 监听 `EXTENSION_VOUCHER`（通道 1）
- [ ] 监听 `allinone:item-redeemed`（通道 2）
- [ ] 效果名解析排除了占位 `'custom'`，从 `detail.itemId` 取真值
- [ ] 同一道具去重

### 代码段 D · 道具提取通道（v3.1）

- [ ] `window.AllinONEHarvest = { spawn, extract }` 已实现
- [ ] 平台模式懒检测：**掉落时机**动态检测 `__ALLINONE_CONFIG__` / `AllinONE.__GAME_ID__`/`GAME_ID`，非平台环境不掉落（不要只在 init 时检测一次）
- [ ] 可提取道具带唯一 `id`（harvestId 幂等键）+ `origin: 'gameplay'` 标记；演示/示例道具不带该标记
- [ ] `ITEM_HARVEST` 的 `schemaName` 与道具 SOP 一致，`effect` 在 `availableEffects` 内
- [ ] 监听 `ITEM_HARVEST_RESULT`：success 删除游戏内道具（防双花），失败解锁重试（10s 超时兜底）
- [ ] 监听 `REQUEST_GAME_ITEMS` → 回 `GAME_ITEMS`（只报 `origin='gameplay'` 的道具）
- [ ] 监听 `ITEM_CONSUMED` → 删除对应道具
- [ ] 产出点合理（连击 / 掉落 / 成就奖励），且普通游玩可触达（界面或文档有提示触发条件）

### 代码段 E · 游戏奖励活动上报（v3.2，可选）

- [ ] `AllinONE_Reward.report()` 已实现，`inPlatform()` 正确判定平台 iframe 环境（独立双击打开 HTML 时不上报）
- [ ] 只在**状态切换点**上报（单次触发），未放在渲染/游戏循环里
- [ ] 上报事件在平台白名单内（`GAME_COMPLETE` / `GAME_WIN` / `LEVEL_COMPLETE` / `ACHIEVEMENT_UNLOCK` / `SCORE_MILESTONE`）
- [ ] 全程 try/catch，上报失败不影响游戏运行
- [ ] （活动生效条件）游戏已重新发布 + 运营者已在凭证系统「游戏绑定」为该游戏创建绑定且奖池有余额

### 发布中心配置

- [ ] 上传了改造后的 ZIP 包
- [ ] AI 分析结果无误（类型 / 框架 / 入口文件）
- [ ] Skills 含 `auth` + `wallet`
- [ ] 配置了 1-3 个兑换道具
- [ ] **道具 SOP** 已填写（schemaName + aiPrompt + availableEffects）
- [ ] **内容创作 SOP** 已填且 `enabled: true`，contentTypes 与代码段 B 的 slot 一致
- [ ] 上传了内容创作指南 .md
- [ ] 封面与简介已填
- [ ] 一键发布成功（新游戏进入 `pending` 等待审核）

### 任务广场

- [ ] 发布了 1-3 个种子任务
- [ ] 上传了《任务开发说明》.md（7 节齐全，不含源码）
- [ ] 任务的 `contentSlot` 与代码段 A 读取的字段一致

### 端到端验证

- [ ] 直接打开游戏 = 纯净原版，看不到任何扩展内容
- [ ] 玩家在任务广场提交关卡 → 审核合并 → 带 `?ext=` 打开 → 菜单里能选到并正常游玩
- [ ] 玩家在内容工坊铸凭证 → 游戏内「内容凭证 (N)」→ 使用 → 本局生效，刷新后失效
- [ ] 道具工坊创建道具 → 游戏内道具栏出现并可使用
- [ ] 兑换码兑换道具 → 游戏内道具栏出现并可使用
- [ ] effectCode 自定义效果能正常执行
- [ ] 🆕 游戏内产出道具 → 提取为凭证成功 → 游戏内道具消失（防双花），重复提取被幂等拦截
- [ ] 🆕 提取的凭证可上架市场 → 另一账号购买 → 兑换码兑换 / 游戏页自动下发均能让道具生效
- [ ] 🆕 （可选）A 游戏提取的道具凭证，在 B 游戏「来自其他游戏的道具」→「适配到本游戏」后正常生效
- [ ] 🆕 （可选）集成代码段 E 并重新发布后：通关/达成触发点 → 玩家收到绑定奖励；重复触发受冷却/上限拦截；独立打开 HTML 无任何上报
- [ ] 断开网络 / 接口报错时，游戏仍能正常打开（降级到原版）

---

## 10. 附录：平台接口速查

### 10.1 游戏详情与文件

| 用途 | 请求 |
|---|---|
| 游戏详情（含合并后的 slot 数据） | `GET {apiBase}/{gameId}` → `{ data: { levels: [...], questExtensions: [...], injections: [...] } }` |
| 拉取文件 | `GET {apiBase}/{gameId}/files/{path}`（path 按段 URL 编码） |

`apiBase`：

```js
// 线上（CloudBase 静态托管域名下 /api 会被 rewrite 吞掉，必须用绝对地址）
'https://allinonegaming-d4gmsmrzz573264f6.service.tcloudbase.com/api/v1/games'
// 本地开发
'/api/v1/games'
```

### 10.2 合并后写入的字段

| 字段 | 说明 |
|---|---|
| `doc.<slot>` | 数组型 data **逐条展开追加**，每条写 `_submissionId`；对象型整体写入 |
| `doc.questExtensions[]` | `{ submissionId, slot, entryPoint, assets[], inject?, name? }` |
| `doc.injections[]` | 模式 E 注入脚本：`{ submissionId, slot, code, styles?, assets?, assetBase? }` |
| `doc.baseSnapshot` | 首次 merge 前的 base 快照（用于「恢复原版」） |

### 10.3 消息与事件

| 方向 | 事件 | 载荷 |
|---|---|---|
| 平台 → 游戏 | `postMessage { type:'PROTOCOL:INIT', gameId }` | gameId 唯一来源（inline/srcDoc 模式） |
| 平台 → 游戏 | `postMessage { type:'EXTENSION_VOUCHER', voucher }` | UGC 道具工坊下发 |
| 平台 → 游戏 | `postMessage { type:'CONTENT_PACK_APPLY', content }` | 内容凭证使用 |
| 平台 → 游戏 | `CustomEvent 'allinone:item-redeemed'` | 兑换码兑换下发 |
| 内容 loader → 游戏 | `CustomEvent 'allinone:content-pack-applied'` | `{ contentId, type, slot, data, assets, assetBase }` |
| 🆕 游戏 → 平台 | `postMessage { type:'GAME_EVENT', event:'ITEM_HARVEST', data:{ schemaName, harvestId, itemData:{name,effect,params,description}, quantity, source } }` | 道具提取为平台凭证（见代码段 D） |
| 🆕 游戏 → 平台 | `postMessage { type:'GAME_EVENT', event:'GAME_COMPLETE' \| 'GAME_WIN' \| 'LEVEL_COMPLETE' \| 'ACHIEVEMENT_UNLOCK' \| 'SCORE_MILESTONE', data:{ score, level, ... } }` | 游戏奖励活动上报：平台按「游戏绑定」配置自动发放 A 币凭证（见 4.7 代码段 E，可选加入） |
| 🆕 平台 → 游戏 | `postMessage { type:'PLATFORM_EVENT', event:'ITEM_HARVEST_RESULT', data:{ harvestId, success, voucherName?, message? } }` | 提取结果；success 必须删游戏内道具 |
| 🆕 平台 → 游戏 | `postMessage { type:'PLATFORM_EVENT', event:'REQUEST_GAME_ITEMS' }` | 平台「游戏道具」面板请求清单（反向提取） |
| 🆕 游戏 → 平台 | `postMessage { type:'GAME_EVENT', event:'GAME_ITEMS', data:{ items:[{ itemId, schemaName, itemData }] } }` | 回应反向提取（只报 `origin='gameplay'` 的） |
| 🆕 平台 → 游戏 | `postMessage { type:'PLATFORM_EVENT', event:'ITEM_CONSUMED', data:{ itemId } }` | 反向提取完成确认 → 删除对应道具 |

### 10.4 体积与限制

| 场景 | 限制 |
|---|---|
| 任务提交单文件 | 默认 512KB（`acceptance.maxFileSize` 可覆盖） |
| 内容包单资产 | ≤ 8MB |
| 内容包总包 | ≤ 20MB |
| 二进制文件 | base64 后加前缀 `__BINARY_BASE64__`，分发时自动解码 |

### 10.5 危险代码扫描

提交内容默认扫描并拦截：`eval(`、`new Function`、`import(`、`require(`、`__proto__`、`prototype`、`constructor`、`window.`、`document.`、`parent.`、`top.`、`fetch(`、`XMLHttpRequest`、`WebSocket`、`localStorage`、`sessionStorage`、`cookie`、`alert(` 等。

> ⚠️ 模式 E（注入 MOD）只做**提示**不做拦截——代码会在玩家浏览器里真实运行，由审核流程 + 权限管控兜底。
