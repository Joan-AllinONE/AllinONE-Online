# 项目记忆 - AllinONE Gaming Platform

> 2026-10-18 精简合并（智能合约/分成/凭证章节去重）。历史见 `.codebuddy/memory/` 每日归档。

## 项目概述
游戏平台：凭证/治理/市场/钱包/GameQuest/道具工坊/内容工坊/智能合约。React+TS+Vite+Tailwind + Express/云函数后端。

## 编辑铁律
- 同一文件多个 replace_in_file 必须逐个串行（并行竞态：全报成功只落盘最后一个）
- **`??` 与 `||` 不可混用**（`a ?? b || c` 语法错误）；写默认值链要么全程 `||`，要么 `a ?? (b || c)`，写完必须过 esbuild/tsc 验证
- replace_in_file 的 replace_all 只匹配完全相同文本（含缩进），修完必须重编译确认 0 残留
- 云函数路由挂对象字面量内、helpers 放模块顶层；改云函数后必跑 `node --check cloudfunctions/gamesApi/index.js`
- 构建（绕 pnpm 符号链接）：`node node_modules/vite/bin/vite.js build --outDir dist/static`；server：`node node_modules/typescript/bin/tsc -p tsconfig.server.json`；ESM 相对 import 带 `.js` 后缀
- 长命令用 `Start-Process cmd '/c ...>log 2>&1'` 后台跑+轮询日志；vitest 用 `node node_modules/vitest/vitest.mjs run <file>`
- tsc --noEmit 有 ~595 历史告警；验证新增错误**按文件过滤**
- Express：`req.params/req.body` 解构值可能 `string|string[]`，用 `String(x||'')`；`req.body` 用 `const body:any`
- 内存 DB：`MEMORY_DB_FILE` 或 `.data/memory-db.json`（`none` 禁用；冒烟用 none）
- **重启本地 server 必须带 env**：`Start-Process cmd '/c set USE_MEMORY_DB=true&& node server.js > server_run.log 2>&1'`——漏带合约静默影子化无报错
- **server.js 跑编译产物 dist**：改 src/server 后必须 tsc emit + 重启，否则冒烟跑旧代码

## 部署环境（永久）
- 前端 `https://allinonegaming-d4gmsmrzz573264f6-1303031594.tcloudbaseapp.com`；后端 `...service.tcloudbase.com/api/v1/games`；envId `allinonegaming-d4gmsmrzz573264f6`
- 部署：`npx -y -p @cloudbase/cli@2 tcb fn deploy gamesApi --force -e <envId>`（**必须 @2**）；前端 `tcb hosting deploy ./dist/static / -e <envId>`
- 云数据库：`doc(id).set()` 文档体不能带 `_id` → `gsUpsert`；`where().remove()` 集合不存在抛 ResourceNotFound 需容错
- 未部署遗留批次：智能合约全模块、__notifications、GameProposal 分成（fn deploy --force + hosting deploy）

## 跨浏览器同步（铁律）
- 浏览器 CloudBase auth 损坏 → writeQueue 线上永不落库；**唯一写入通道 = gamesApi 云函数**
- ❌ writeQueue 共享写 ❌ limit(500) ❌ prod 相对 `/api/**`；✅ 隧道 `/api/v1/games/<collection>` 或 `/__<feature>`；users 写文档用 update() 禁 set()
- games.ts 特定 GET 路由必须排在 `GET /:id` 之前（users/transactions）
- 平台金库两本账：前端 `system-platform` + 服务端 `platform_treasury`，getReport() 聚合

## 隧道与 token
- 隧道 `getApiBase()`：prod 绝对云函数 URL，dev `/api/v1/games`；userId 从 JWT 解析；dev-token 请求体必须带 `{userId}`
- **早调用 401 坑**：新增前端 fetch 必须补冷启动 401（`getCachedToken() ?? await getToken()` 或先 `await getToken()`；统一走 `backendSync.authHeaders`）
- Service Worker：当前 v19（排除 `__` 隧道）；改 SW 必 bump 文件名+改 main.tsx 注册

## 凭证 × 兑换码流程（⚠️ 多次踩坑）
链条：铸造/转移凭证 → 兑换码 IV-XXXXXXXX（redeemCodeService）→ 购买记录 → 游戏内 verify/use 核销（/api/v1/redeem/*）。新履约通道必须走完整链条。
1. **三层排查铁律**：资产"看不到/没到账"：①服务端账本（.data/memory-db.json）②客户端下行同步（`VoucherDatabase.pullMyVouchersFromBackend`，VoucherManager loadData 前置调用）③UI 过滤
2. 合约履约池只认 holder=`platform_pool`+sourceType=item+itemTemplateId=skuId；个人库存≠平台备货
3. `__item/sync`：schemaName 仅在 itemData 存在时必填；防重推靠 cloudSyncedIds（localStorage，24h TTL）
4. 非购买来源凭证用 `voucherItemService.ensureRedeemCodeForVoucher()` 幂等补挂兑换码；回写凭证用 `VoucherDatabase.updateVoucher`
5. 清库联调三步：服务端充值（`__wallet/platform/adjust`）→ 平台池备货 → 60s tick 自愈

## TeamQuest 四项改造（✅ 10-18 实施 / 10-20 修正，**已上线 10-20**）
按**最高人数**封团（tq-join：signing+active + memberCount<maxMembers；达最低人数开团后仍可加入——10-20 用户纠正，首版"达最低即封团"错误）｜发起人自动入团（deploy stateData 特判 memberCount=1，双实现）｜注入奖池 UI 补齐（fund-pool 按钮）｜团长管理费 leaderFeeBps+贡献规则 contributionRule 写入合约（结算先抽费再分池）｜手动成团 tq-manual-open（action open-team）+ 上报填报提示/成员自报 UI/分配示例 buildPayoutExample。10-20 已部署：tcb fn deploy gamesApi --force + hosting deploy 成功；**gamesApi env 为空（CONTRACT_AUTO_EXECUTE 未设，合约线上仍影子模式）**——开闸需 tcb fn config update 加 env 或控制台设置。详见 2026-10-18.md。

## 智能合约模块（B0-B6+R1-R6 ✅，未部署）
- 架构：`src/contracts/` + contractTunnel.ts + 云函数 `__contract`（contract-engine.cjs 由 build-engine.cjs 生成）；端点 templates/deploy/sign/invoke/tick/query/detail/verify/escrow/admin；三模板 group-buy/team-quest/gso
- dev 环境 USE_MEMORY_DB=true 时 CONTRACT_AUTO_EXECUTE 三档全开；server.js 60s 自调 `__contract/tick`；GSO 发行仅游戏 publisherId
- 私域 whitelist：join/subscribe 名单外且非 initiator → 403；leave/fund-pool/dispute/cron 不受限；双实现（contractTunnel.ts+云函数）
- DSL：`'expr: '` 动态字段；join when 用 `state.X+1>=`；byField share 尾差最后一人；防回归：tick triggerId 确定性/escrow purpose 定向过滤/CAS/RSV frozenAt
- 规则中心 contract_rules seed 14 键，4 份兜底副本对齐（types.ts+云函数+games.ts LOCAL_RULE_FALLBACKS+前端 PLATFORM_RULE_FALLBACKS）；守卫 `scripts/check-contracts-isolation.cjs` 挂 build 前置
- env：CONTRACT_AUTO_EXECUTE（冒烟必带）、CONTRACT_SIGNING_KEY；模板改动后跑 `node scripts/build-engine.cjs`
- 验证：单测（src/contracts/engine/__tests__/）+ 冒烟 54/54

## 合约 × 平台打通 P0-P3（✅ 10-15 实施，未部署）
- P0a revenue_ledger source 统一 `item_sale`；P0b `POST /__contract/admin/arbitrate`（refund/release 两路径）终结 disputed 死锁
- P1 GSO 交割自动调减发行方份额（幂等 gsoConveyed.contractId）；P2 拼团成团铸履约凭证 gbr_<contractId>_<userId> + skuId 表单；P3 `__protocol` 双通道（团长代报+本人自报，冒名 403）+ GamePlay PROTOCOL_CONTRIBUTE 事件桥 + GSO 记账点 gso-revenue（幂等 st_/cc_ 键）
- 坑：`/api/v1/game-developers/:id` GET 需 Bearer；云函数 game-developers 无 gamecoins-split 分支（上线补齐）

## GameProposal 三方分成（✅ 实施，未部署）
- gameCoins 路径：`POST /:accountId/gamecoins-split` 服务端即时分账（幂等 gcsplit_键）；A币路径：实物落袋 game-{gameId}+留置权
- 纯函数单一源 `src/services/revenueSplit.ts`（floor 尾差归游戏方）；server import 带 .js
- 影子对照 revenue_ledger（devsplit_ 幂等）+ split-ledger 审计 + 哈希链

## __notifications（✅ 10-11 实施，未部署）
- 首期仅私域合约邀请：服务端 contractTunnel deploy 落库后 `buildContractInviteNotifications`（幂等 ntf_<contractId>_<toUserId>）；云函数 deploy 内联镜像
- 读取 `GET/POST /__notifications/list|read`；前端 notificationTunnel.ts + ContractCenter 铃铛 60s 轮询
- 验证：单测 5 用例 + smoke 13/13

## 其他约定
- **测试数据隔离（用户铁律）**：测试数据只留本地不污染服务器；`backendSync.isCloudHosting()` 判 prod；seed 凭证打 `SEED_DATA_TAG`，prod 同步过滤
- 必须用 `getDefaultEngine()` 绝不 new（ProtocolEngine 双实例坑）；A币=凭证非余额；SkillGateway 单例只在 skills/index.ts 导出；每个已发布游戏自动建 `game-{gameId}` 账户
- 前端铁律：接口返回值必须归一化再进 state；排错先下载线上包按行定位，再 dev-token curl 复现
- 游戏桥：LF2 `window.myGame`；RA2 `window.__ra2allinone`；A1G `window.MarioLevel`
- GamePlay 新增 hook 必须放 isLoading/!game 早退之前；内容凭证绝不进道具兑换链路
- GameQuest `__quests`：approve 只是改状态，必须再点 merge 才发奖
