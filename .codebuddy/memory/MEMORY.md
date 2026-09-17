# 项目记忆 - AllinONE Gaming Platform

> 2026-09-09 精简重写（超限去重）。

## 项目概述
游戏平台：凭证/治理/市场/钱包/GameQuest/道具工坊/内容工坊。React+TS+Vite+Tailwind+shadcn/ui。

## 编辑铁律
- **同一文件多个 replace_in_file 必须逐个串行**（并行有竞态：全报成功但只落盘最后一个）

## 部署环境（永久）
- 前端：`https://allinonegaming-d4gmsmrzz573264f6-1303031594.tcloudbaseapp.com`；后端：`https://allinonegaming-d4gmsmrzz573264f6.service.tcloudbase.com/api/v1/games`；envId `allinonegaming-d4gmsmrzz573264f6`
- 部署：云函数 `npx -p @cloudbase/cli tcb fn deploy gamesApi --force -e <envId>`；前端 `tcb hosting deploy ./dist/static / -e <envId>`
- 构建（绕 pnpm 符号链接）：`node node_modules/vite/bin/vite.js build --outDir dist/static`；server：`node node_modules/typescript/bin/tsc -p tsconfig.server.json`

## 跨浏览器同步（铁律）
- 浏览器端 CloudBase auth 损坏 → writeQueue 线上写库永不落库；唯一写入通道 = gamesApi 云函数
- ❌ writeQueue 共享写 ❌ limit(500) ❌ prod 相对 `/api/**`；✅ 隧道挂 gameId 路由前，走 `/api/v1/games/<collection>` 或 `/__<feature>`；users 写文档用 update() 禁 set()

## 游戏内服务隧道
- `getApiBase()`：prod 绝对云函数 URL，dev `/api/v1/games`（**不用坏掉的 getFeatureApiBase**）；userId 从 JWT 解析；dev 需本地路由

## Service Worker
- 当前 `public/gameFileServiceWorker-v17.js`；三级回退：后端→Cache Storage→IndexedDB(`AllinONE_GameFiles`)；**改 SW 必 bump 文件名+改 main.tsx 注册**；prod server 模式 iframe 走绝对 URL 不过 SW

## 游戏加载
- hostingType：external/server/inline；多文件游戏必须 server；大数据（入口HTML/SOP）存 published_games 文档字段；上传解码用 TextDecoder utf-8
- **iframe sandbox 铁律（09-10）**：GamePlay 三处 sandbox 已加 `allow-modals`；游戏内禁用原生 confirm/alert/prompt（未授 allow-modals 时被静默禁用，confirm 恒返回 false）→ 统一用自定义 DOM 弹窗，参考拼豆模拟器 `askConfirm()`

## GameQuest
- 隧道 `__quests`；扩展三态 A数据/B代码(`window.MarioLevel.build(api)`)/C页面片段；slot Schema 双维护（quest.ts + 云函数）
- **approve 只是改状态，必须再点 merge 才发奖**；dev 提交者带 Bearer dev-token
- 方案E注入：`inject=true` 写 injections，三层幂等注入；原版隔离：`?ext=` 条件化注入（无 ext=纯净原版）+ 游戏侧 A1G 加载器过滤 + baseSnapshot 恢复

## 游戏审核（✅ 云函数已同步并部署，2026-09-10）
- 隧道 `__review`（本地 games.ts + 云函数 index.js 双实现对齐）；状态机 pending→approved/rejected/changes_required+removed；审核字段只能经 __review（两侧 stripReviewFields）；发布自动 pending；后台 `/game-review`（GameBase 入口 + PlatformAdmin 顶部按钮）
- 云函数侧：admin-login 账号 env REVIEW_ADMIN_USER/PASS（默认 admin/admin123）；JWT 复用 dev-token HMAC 方案（secret=JWT_SECRET||'allinone-platform-2026'）；部署 `tcb fn deploy gamesApi --force`；模拟测试 `scripts/test-review-fn.cjs`（Module._load mock node-sdk，mock 必须实现 `.field()`）
- **待审游戏预览**（09-09）：`fetchGamePreview`→external=externalUrl / server=`getApiBase()/:id/files/:entryPoint`（公开路由免 token）/ inline=详情接口 `entryHtmlContent`（admin token）→ **无则从 cloudFileManifest 定位入口回退 files URL（09-11 修复：瘦身剥离后线上 inline 游戏全走此链路）**；ReviewPanel iframe 沙箱预览 + 刷新/新窗口(blob)/全屏/收起；sandbox 与 GamePlay 一致
- **413 元数据瘦身**（09-10，已上线）：云函数 HTTP 访问服务有请求体上限，大游戏（entryHtmlContent>60KB 剥离 / coverImage>120KB canvas 压缩）在 `upsertGameToBackend` 瘦身，否则整份元数据 413 被拒 → 文档残缺（只含 manifest）→ 游戏中心「维护中」；GameCenter `status||'available'`；submit 404 重试 ×3。文件加载回退链：game_files → manifest → **云函数端 admin SDK getTempFileURL 直接回内容（跨浏览器可用）**
- ⚠️ 管线 Logger 只有 `info/success/error/warning`（无 warn）；管线步骤内副作用必须 try/catch

## 内容工坊
- 内容凭证=按次消费；`__content` 隧道；GamePlay「内容凭证」→ CONTENT_PACK_APPLY
- ⚠️ **GamePlay 新增 hook 必须放 isLoading/!game 早退之前**，否则白屏
- ⚠️ **内容凭证绝不能进道具兑换链路**（schemaName 'content' 未注册，混入必报「Schema 未注册」）：等值兑换候选池已排除 content 模板；redeemItemVoucher 入口有内容守卫（返回 `isContentVoucher:true` 不核销）；GamePlay `?itemVoucher=` 识别内容凭证直接走 redeemContentVoucher+CONTENT_PACK_APPLY；GameStore 跨游戏列表排除 `cd.contentId`（09-10 修，四防线）

## ProtocolEngine 单例铁律
- **必须 `getDefaultEngine()`，绝不 new**（双实例→「游戏通道不存在」→购买道具不可用）；宿主用 `ensureConfig` 补回调，cleanup 用 off+releaseChannel **绝不 destroy()**
- dev-token 请求体必须带 `{userId}`

## 核心约定
- A币=凭证非余额；`isCurrencyVoucher()/isItemVoucher()`；两套凭证存储：VoucherDatabase(allinone_vouchers) vs VoucherSkill(vouchers)
- SkillGateway 单例只在 skills/index.ts 导出；每个已发布游戏自动建 `game-{gameId}` 账户
- main.tsx：initCloudBase() 先于 initializeSkills()；dev 写云由 isCloudSyncEnabled()（DEV）总控，`VITE_CLOUD_SYNC_ENABLED` 不进 .env
- **道具发行策略（09-12 修）**：初始库存与总量解耦——PublishingCenter 发布时以表单 `supplyPolicy`（存 metadata.supplyPolicy）为准：OPEN→无 totalSupply 可无限增发；LIMITED→totalSupply=initialInventory 锁定。旧逻辑 `isLimited=initialInventory>0` 使策略恒无效已废弃；初始铸造按 initialInventory 张执行（与策略无关）。服务层 mintItemVouchers 已按 LIMITED 硬约束/OPEN 放行

## ITEM_HARVEST 道具提取（P0+P1+P2 已实施 2026-09-08）
- 链路：游戏 postMessage `GAME_EVENT/ITEM_HARVEST {schemaName,harvestId,itemData}` → GamePlay → itemHarvestService.processItemHarvest（Schema注册+白名单+每日10+harvestId幂等）→ 铸 sourceType=ITEM 凭证（denomination=0 可交易）；结果回发 `PLATFORM_EVENT/ITEM_HARVEST_RESULT`，游戏 success 后删道具防双花；**itemData 序列化 ≤8KB（MAX_ITEM_DATA_SIZE）**
- isPlatformMode 恒 false 已修（双保险）：①游戏侧 ensurePlatformMode() 懒检测（`__ALLINONE_CONFIG__` 或 AllinONE.__GAME_ID__ 任一存在）②管线 Mode A generateConfigScript 注入 `__ALLINONE_CONFIG__`；方案A须重新发布游戏
- P1 反向提取：GamePlay「游戏道具」→ `REQUEST_GAME_ITEMS` → 游戏回 `GAME_ITEMS` → 逐项提取（harvestId=itemId）→ 成功后 `ITEM_CONSUMED`
- P2a 高价值审核：effectCode/rarity/highValue → customData 加 highValue+reviewStatus='pending'；市场与兑换拦截 pending；`/game-review`「道具审核」tab
- P2b 跨游戏兑换（2026-09-10 重写，旧「猜 schema 名 + 原样搬运」已废弃）：三路径兑换器 `src/services/crossGameExchange.ts` + 语义标签层 `EffectTags.ts` + 弹窗 `CrossGameExchangeModal.tsx`。A 等值兑换(推荐/100%生效，铸造目标游戏原生凭证) > B 语义映射 > C 原样搬运(折叠+勾选)。跨游戏无 conversion 时 `redeemItemVoucher` 返回 needsConversion:true 由上层弹窗引导。铁律：先产出目标凭证再核销源凭证；目标价值 ≤ 源估值；effectCode 道具禁走 C；每日 20 次上限
- 游戏侧参考实现：Match3Game_effectcode.html；发布文档 v3.1（4.4 代码段 D 四段代码）；改游戏 HTML 须重新发布

## 其他
- 内存 DB 磁盘持久化：`MEMORY_DB_FILE` 或 `.data/memory-db.json`（`none` 禁用）
- 游戏桥：LF2 用 `window.myGame`（`_getLocalPlayer()` 筛 CPU，角色 `.con`）；RA2 用 `window.__ra2allinone`
- A1G 脚本关卡：`window.MarioLevel={build(api)}`；参考 `AllinONE Online/超级玛丽二创/level3.js`
- 拼豆模拟器：`AllinONE Online/拼豆模拟器/index.html`，已接入 perler-artwork Schema（作品提取→凭证→市场交易→兑换回游戏）
