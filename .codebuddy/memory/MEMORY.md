# 项目记忆 - AllinONE Gaming Platform

## ⚠️ 跨浏览器数据持久化架构（2026-07-16 已验证生效，务必先读）

**核心发现**：CloudBase DB **读取**对匿名用户正常可用（即使 auth 写入损坏），这是跨浏览器数据共享的 proven pattern。published game HTML 跨浏览器加载真正靠 `entryHtmlContent` 直接存 DB 文档，**不是** `getTempFileURL`（后者对匿名用户返回 STORAGE_EXCEED_AUTHORITY）。

**CloudBase 环境现状**：
- **DB 写入**：JS SDK auth 损坏（`auth.call is not a function`），`published_games` 等集合写入**失败**
- **DB 读取**：匿名用户可正常读取 `published_games` 集合（无鉴权限制），这是 proven pattern 的基础
- **云存储 uploadFile**：正常运行（与 DB auth 无关的独立通道）
- **云存储 getTempFileURL**：**仅认证用户可用**，匿名用户返回 STORAGE_EXCEED_AUTHORITY（云存储安全规则限制）

**跨浏览器共享数据三条通道（按可靠性排序）**：
- **⓪ DB 文档字段（首要通道，已验证生效）**：`sopDocument`/`entryHtmlContent` 直接存 `published_games` 文档 → 匿名用户可读 DB → 跨浏览器可达。写入靠 writeQueue（本地可用）或后端 API（线上可用）
- **① 后端 API（辅助通道）**：`GET /:gameId/files/*`（公开，无 JWT）→ 需 `USE_MEMORY_DB=true node server.js` 运行才有用
- **② 云存储 getTempFileURL（仅认证用户可用，匿名不可用）**：uploadFile → cloudFileID → getTempFileURL → fetch。匿名用户返回 STORAGE_EXCEED_AUTHORITY

**部署环境**：线上 = CloudBase 静态托管前端 + gamesApi 云函数后端（永久 URL，不过期）
**云函数 API URL**：`https://allinonegaming-d4gmsmrzz573264f6.service.tcloudbase.com/api/v1/games`（永久稳定，不过期）
**前端 URL**：`https://allinonegaming-d4gmsmrzz573264f6-1303031594.tcloudbaseapp.com`
**config.js __API_BASE_URL**：`https://allinonegaming-d4gmsmrzz573264f6.service.tcloudbase.com/api`（SW 代理到此域名）
**云函数能力**：游戏列表/详情/CRUD + manifest(346文件清单) + files/:filePath(从云存储直接下载单文件) + POST /dev-token(HMAC-SHA256 JWT)
**config.js cache-busting**：`?v=20260726`（每次部署更新版本号强制 CDN 刷新）
**SW 代理策略**：`/api/v1/games/*` 全代理到云函数（含 `/api/v1/games/__activities` 活动中心隧道）；其余非游戏 `/api/*` 返回 404 空 JSON（避免 503 瀑布）
**SW 硬编码兜底**：`PRODUCTION_BACKEND_URL = 'https://allinonegaming-...service.tcloudbase.com/api'`——CloudBase 域名下 `getApiBaseUrl()` 直接返回硬编码 URL，不依赖 Cache Storage/config.js（解决首次访问/incognito 404 问题）
**SW install 预加载**：`fetch('/config.js?_sw_init=...')` + `skipWaiting()` + `clients.claim()`——SW 激活前就有后端地址
**SW 文件名 cache-busting**：`gameFileServiceWorker-v6.js`——CDN 缓存旧版 SW 时通过更改文件名强制刷新（关键经验：CDN 对 SW 文件缓存极顽固，改文件名比 query 参数更可靠）
**SW getApiBaseUrl URL 校验**：`isValidBackendUrl()` 拒绝 HTTP URL 和 CloudStudio URL，无效时清除 Cache Storage 并使用硬编码 `PRODUCTION_BACKEND_URL`——CDN 缓存旧版 config.js 会污染 Cache Storage 导致 Mixed Content
**游戏文件上传 bug（根因）**：`saveGameFiles()` 中 `String(uint8Array)` 返回逗号分隔字节值（`"47,42,10,..."`）而非 JS 代码——修复为 `TextDecoder('utf-8').decode(bytes)`。云存储中的 JS 文件需重新上传才能恢复正确内容
**SW proxyToBackend 三个浏览器兼容性修复**：
1. POST body 用 `await req.clone().arrayBuffer()` 替代 ReadableStream——避免 `duplex: 'half'` 在某些浏览器 SW 环境中导致 fetch 静默失败
2. 只复制 `SAFE_HEADERS = ['content-type', 'authorization', 'accept']`——避免 Host/Origin/Referer 等 forbidden headers 导致 fetch 失败
3. `resp.type === 'cors'` → 重新构造 Response（type: 'basic'）——跨域代理返回的 'cors' type 与原始 'same-origin' 请求模式不匹配，浏览器视为 network error

**凭证系统跨浏览器同步（Bug 013，2026-08-03 已修复并部署）**：
- **根因**：`vouchers`/`voucher_transactions` 写入全走 `writeQueue` → CloudBase JS SDK 浏览器端 auth 损坏 → 线上永落库；另一浏览器 `syncFromCloudBase()` 拉到 0 条 → 商店显示「未铸造/已售罄」。同时读取用 `limit(500)` 硬截断（2026-07-02 同模式遗漏）。
- **修复**：凭证写入改走 `gamesApi` 云函数（admin SDK 无 auth 限制），读取改分页+后端兜底。新增文件 `src/services/voucherBackend.ts`（URL 硬编码 `...service.tcloudbase.com/api/v1/games/<collection>`，GET 分页 + POST upsert + DELETE）。
- **改动文件**：`src/voucher-system/storage/VoucherDatabase.ts`（syncVouchersToCloud/syncTransactionsToCloud/syncFromCloudBase 弃用 writeQueue）、`src/services/voucherItemService.ts`（templates/purchases 写入+读取）、`cloudfunctions/gamesApi/index.js`（新增 vouchers/voucher_templates/purchases/voucher_transactions 路由，置于游戏 id 路由之前）。
- **验证**：浏览器 A 铸造的凭证已存于 DB（GET 返回真实 serialNumber）；POST upsert 成功、DELETE 成功。已清理测试数据。
- **约束**：绝不回退 writeQueue（线上失效）、绝不保留 limit(500)、用永久云函数 URL（云函数已 deploy --force）。

## 项目概述
AllinONE Gaming Platform — 游戏管理平台，凭证系统、投票治理、市场交易、钱包管理。

## 技术栈
- React + TypeScript + Vite + Tailwind CSS + shadcn/ui
- **线上**：gamesApi 云函数（`/api/v1/games/*`）+ CloudBase DB；SW 代理到云函数域名（`service.tcloudbase.com`）
- sonner toast 通知库

## 核心架构知识
- **A币 = 凭证，非钱包余额**：A币仅在 VoucherService/voucherPaymentService（凭证制），不在 WalletSkill（余额制）
- **凭证二分法**：`isCurrencyVoucher()` 判断A币类，`isItemVoucher()` 判断道具类
- **两套凭证存储**：`VoucherDatabase`（凭证系统，key=`allinone_vouchers`）与 `VoucherSkill`（Skill，key=`vouchers`）独立存储
- **SkillGateway 单例规则**：`skillGateway` 单例只在 `skills/index.ts` 创建并导出（`getDefaultGateway({debug:...})`）；`SkillGateway.ts` 不导出实例，仅导出类+函数。**所有代码必须从 `skills/index` 导入 skillGateway，绝不能从 `SkillGateway.ts` 直接导入**（历史 bug：两实例导致 skillNotFound 空白无报错）
- **SkillGateway userId**：`skillGateway.execute()` 必须传 `context: { userId, sessionId }`
- **游戏商账户体系**：每个已发布游戏自动创建 `game-{gameId}` 账户

## SOP 跨浏览器持久化方案（2026-07-16 v3，已验证生效）

**proven pattern**：任何跨浏览器共享数据，复用 `entryHtmlContent` 的成功经验 — **直接存 DB 文档字段**，匿名用户可读 DB（无鉴权限制）。不要用云存储 `getTempFileURL`（匿名不可用）。

**v1 失败**：`getTempFileURL({ fileList: [cloudPath] })` → 匿名用户返回空/错误
**v2 失败**：cloudFileID + getTempFileURL → 匿名用户返回 STORAGE_EXCEED_AUTHORITY
**v3 成功**：sopDocument 直接存 DB 文档 + 后端 API 辅助 → 匿名用户可读 DB → 跨浏览器可达 ✓

**加载优先级**：⓪ DB sopDocument → ① 后端 API → ② 云存储 cloudFileID → ③ 云存储 cloudPath
**保存流程**：
1. 云存储 uploadFile → 捕获 cloudFileID
2. DB 写入 cloudFileManifest + sopDocument（双重保障）
3. 后端 API POST /upload（辅助通道）
4. 云存储失败时仍写 sopDocument 到 DB（兜底）

**关键文件**：`src/services/publishedGameService.ts`
**关键教训**：`addSopToCloudManifest` 在游戏不在缓存时不能直接 return，需构建 manifest 并写 DB

## LF2 / F.LF 游戏桥与角色识别

**`window.myGame` 游戏桥**（由 `flf-boot.js` 暴露）：
- `getMatch()` → `manager.match`（注意：需 `this.match = match` 赋值，否则永远 null）
- `getPlayers()` → `match.character` 中 `type === 'character' && !c.is_npc` 的角色。VS 模式下**包含 CPU 对手**（`is_npc` undefined、`controller.type = 'AIcontroller'`），因此不等于"仅人类玩家"
- `setInvincible(char, on)`、`heal(char, amount)`、`restoreMp(char, amount)`、`giveWeapon(char, id)` — 单角色 API

**本地玩家识别**（平台侧 Effect Engine 使用）：
- `_getLocalPlayer(game)`：从 `getPlayers()` 筛除 `controller.type === 'AIcontroller'/'AIscript'`，返回第一个人类角色
- invincible/super_mode/heal/restore_mp/give_weapon 等预设效果处理器**不再自动执行**（返回 false → 委托 CustomEvent）

**预设道具本地玩家方案演进（关键！别走老路）**：
- **❌ v1（已废弃，全场误伤）**：Effect Engine 自动执行 → 跳过 CustomEvent → 道具不在 props 栏显示
- **❌ v2（已废弃，道具不可用）**：把 effect 改名为 `_local_<x>` + 注入 effectCode 沙箱脚本。问题：游戏内置 `EFFECT_HANDLERS` 只认原名 `heal`/`invincible`，不认 `_local_heal`；且游戏 sandbox（`new Function('game',...)`）在注册时捕获 `window.myGame`，game 引用可能陈旧；安全检查过严也会拒注册
- **✅ v3（2026-07-24 当前方案，LocalPatcher）**：保持原始 effect 名 → 游戏识别并加到 customPowerUps；Effect Engine 注入 LocalPatcher，轮询 `window.allinoneAdapter`（游戏暴露的 `handlers` 引用，指向内部 EFFECT_HANDLERS 同一对象），就绪后**原地替换** `handlers.heal`/`invincible`/`super_mode`/`restore_mp`/`give_weapon` 为本地玩家版本（筛除 AI 角色，仅对第一个人类角色调用 `window.myGame` 单角色 API）。玩家点击道具 → `useCustomPowerUp` → `EFFECT_HANDLERS[effect]` 命中替换后的 handler → 仅本地玩家生效。不依赖 effectCode 沙箱、不改游戏文件。

**关键教训**：
1. `getPlayers()` ≠ "仅人类玩家"。任何需要"只对道具使用者"的效果，必须用 `_getLocalPlayer()` 或类似筛选
2. **effect 名不能加前缀**，否则游戏内置 handler 表查不到 → 道具不可用。改通过 `allinoneAdapter.handlers` 原地替换（引用同一对象）
3. **LF2 角色用 `.con` 引用 controller（不是 `.controller`）**！`_getLocalPlayer` 必须检查 `(p && p.con) || (p && p.controller)` 兼容两种属性名。人类 controller type: `'keyboard'`/`'touch'`/`'gamepad'`；AI: `'AIcontroller'`/`'AIscript'`

## RA2 红警道具
- effectCode 通过 `game.emit(cmd)` 注入命令，走引擎管线
- 桥接对象：`window.__ra2allinone`（始终暴露）= `{ view, world, localPlayerId, emit }`
- 5 种 EffectCommand：addCash, repairAll, powerSurge, revealMap, spawnAlly

## CloudBase 初始化顺序
- main.tsx 中 `initCloudBase()` 必须在 `initializeSkills()` 之前
- `waitForCloudBase()`：写入路径用 await 而非 isCloudBaseReady() + return
- 匿名登录：需腾讯云开发控制台开启，envId=allinonegaming-d4gmsmrzz573264f6

## Dev/Prod 数据隔离（2026-07-18 实施，方案 C）

**根因**：`.env` 中 `VITE_CLOUDBASE_ENV=allinonegaming-d4gmsmrzz573264f6` 同时被 dev 和 prod 使用 → dev 上传的游戏实时出现在线上。

**方案 C（dev 不写云）已落地**：用 `import.meta.env.DEV` 作总开关，dev 禁用云同步、prod 启用。
- `src/services/cloudbase.ts`：新增 `isCloudSyncEnabled()`；`initCloudBase()` 禁用时抛错 → `app` 保持 null → `isCloudBaseReady()` 返回 false → 所有云端读写自动短路。
- `src/services/writeQueue.ts`：`enqueue`/`enqueueAndWait`/`process`/`restoreQueue` 在禁用时直接 no-op，避免空转重试。
- `src/services/publishedGameService.ts`：`scheduleCloudRefresh`/`refreshGamesFromCloudBase`/`saveGameFiles`/`deleteGameFiles` 的云端路径加 `isCloudSyncEnabled()` 守卫，禁止 dev 拉取/推送线上数据。
- ⚠️ `VITE_CLOUD_SYNC_ENABLED` 绝不能写进 `.env`（会误伤线上）；dev 临时联调云用命令行 `VITE_CLOUD_SYNC_ENABLED=true pnpm run dev`。

## 钱包明细（transactions）

- **本地存储**：`allinone_wallet_transactions`（localStorage），每用户最多200条，新交易在前
- **WalletSkill.adjustBalance**：写入 writeQueue（CloudBase）+ 同时写 localStorage
- **WalletSkill.getTransactions**：CloudBase 优先 → 失败回退 localStorage
- **useWallet hook**：返回 `{ wallet, transactions, stats, loading, refresh }`，transactions 为 TransactionItem[]
- **GameBase.tsx HUD**：点击余额 → 右侧抽屉（WalletDetailDrawer）显示明细+统计

## 写入队列（writeQueue）
- 核心：`src/services/writeQueue.ts` — enqueue(非阻塞)/enqueueAndWait(阻塞)
- 统一工具：`src/voucher-system/storage/cloudSync.ts`
- 注意：CloudBase DB **写入**在部署环境无效（auth 捾坏），但**读取**正常（匿名可读）。writeQueue 写入在本地开发环境可用，线上靠后端 API 替代写入

## 游戏加载渲染架构（2026-07-18 修复，A+B+C 已落地）

**模块化多文件游戏（RequireJS/AMD/动态 import）必须用「服务端托管」真实 URL 渲染，不可用 srcDoc 内联**（内联时运行时 XHR 子资源解析到父页 `/game/` → 404 白屏）。

- `hostingType` 三态：`external`（CDN URL）/ `server`（真实 URL `/api/v1/games/:id/files/<entry>`，后端 `GET /:gameId/files/*` 公开服务）/ `inline`（srcDoc 内联，仅适合单文件游戏）。
- `GamePlay.tsx`：加载逻辑对 `server` 模式提前 return 用真实 URL iframe；JSX 渲染条件 `(external||server) && cdnUrl`。
- `GameCodeAnalyzer.isModular`：检测模块加载器特征；`PublishedGame.isModular` 标记；模块化游戏若误用内联 → `GamePlay` 显式报错提示改用 server 模式重发。
- **Service Worker**：`public/gameFileServiceWorker.js`（→ `dist/static/gameFileServiceWorker.js`）拦截 `/api/v1/games/*`，**三级回退**：①后端优先 ②Cache Storage 回放 ③**IndexedDB 本地文件回放**（`AllinONE_GameFiles`/`game_files`/key=gameId，精确 miss 时扫描全部键兜底，解决发布 gameId 与存储键不一致）；保正确 MIME + 宽松 CSP。`main.tsx` 注册。仅过滤游戏文件请求，不影响其他。模块化游戏因此**无需后端在线、无需重发**即可加载。
- 运行验证：后端 `USE_MEMORY_DB=true PORT=3000 node server.js`；vite 代理 `/api` → :3000（`vite.config.ts`）。

## 活动中心（ActivityCenter）修复（2026-08-03 已部署生效）

**根因**：活动中心页面崩溃 `n.filter is not a function` + 控制台 `api/v1/activities/:1` 404。
- 线上 HTTP 访问服务只把 `/api/v1/games/*` 路由到 gamesApi 云函数，`/api/v1/activities/*` 无路由 → 404。
- SW 对非游戏 `/api/*` 返回 `{ success: true, data: null }`（非数组），前端 `fetchActivities` 未防御 → `activities.filter` 崩溃。

**关键约束（踩坑经验）**：
1. **HTTP 访问服务路径限制**：云函数 gamesApi 的 HTTP 访问服务 path 固定为 `/api/v1/games`，无法（易）改成更宽前缀。新功能若需后端，必须**复用 `/api/v1/games` 前缀 + 特殊隧道段**，云函数内部剥离前缀后分发。
2. **云函数 event.path 已剥前缀**：HTTP 访问服务转发时 `event.path` 已是 `/__activities/...`（不含 `/api/v1/games`）。重写时用 `path.replace('__activities','activities')` 再补 `/api/v1` 前缀。
3. **`const path` 不可重新赋值**：`exports.main` 中 `path` 是 const，重写路径必须先把 `const path` 改为 `let path`，否则抛 TypeError → 500。
4. **SW 改文件名绕过 CDN**：CDN 对 SW 文件缓存极顽固，修复 SW 必须 bump 文件名（v8→v9）并同步改 `main.tsx` 注册路径。
5. **前端 API base 走隧道**：`src/activity/config.ts` 的 `ACTIVITY_API_BASE = '/api/v1/games/__activities'`（不是 `/api/v1/activities`）。

**改动清单**：
- `cloudfunctions/gamesApi/index.js`：新增 `DEFAULT_ACTIVITIES_SEED`（9 个种子，与前端 `src/activity/seed/defaultActivities.ts` 一致）；`/api/v1/activities` GET 列表（DB 优先，空则种子）、`/activities/leaderboard`（聚合 `activity_claims` 集合，跨浏览器）、`POST /activities/:id/claim`（写 `activity_claims`）。`path` 改 `let`，加 `__activities` 隧道重写。`tcb fn deploy gamesApi --force --path /api/v1/games` 部署。
- `src/activity/service/activityService.ts`：`fetchActivities` 防御非数组（后端/SW 返回非数组时回退 localStorage→种子），确保永远返回 ActivityDef[]。
- `src/activity/hooks/useActivity.ts`：`acts.data` 非数组时兜底空数组。
- `src/activity/config.ts`：`ACTIVITY_API_BASE = '/api/v1/games/__activities'`。
- `public/gameFileServiceWorker-v9.js` + `src/main.tsx`：SW 新增 activities 代理分支（实际走 games 隧道自然代理），文件名 v8→v9。

**验证**：线上 `GET /api/v1/games/__activities` 返回 9 活动；`/leaderboard` 返回榜单；`POST /claim` 成功写库。前端强制刷新（Ctrl+Shift+R）后活动中心正常显示且可跨浏览器共享领奖。

**约束**：新增后端路由一律走 `/api/v1/games/__<feature>` 隧道，绝不新增顶层 `/api/v1/<feature>`（HTTP 访问服务不路由）；前端 `fetchActivities` 类回退逻辑必须防御非数组。
