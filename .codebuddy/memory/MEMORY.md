# 项目记忆 - AllinONE Gaming Platform

## 项目概述
AllinONE Gaming Platform — 游戏管理平台，包含凭证系统、投票治理、市场交易、钱包管理等功能。

## 技术栈
- React + TypeScript
- CloudBase 数据库为权威数据源 + localStorage/IndexedDB 仅作缓存
- sonner toast 通知库
- Vite 构建

## 投票凭证系统架构
- `voteVoucherService` - 投票凭证核心服务（混合型：即时发放 + 计算型结算）
- `VoteFraudDetector` - 防作弊系统（6条规则）
- `VoteNotifications` - 全局 Toast 通知（挂载于 App.tsx）
- `VoteNotificationPanel` - 个人中心投票面板（挂载于 GamePersonalCenter）
- 事件驱动：`vote-cycle-started`, `vote-cast`, `vote-cycle-settled`

## 文件结构
- `src/voucher-system/` - 凭证系统核心模块
- `src/voucher-system/services/` - 服务层 (VoucherService, VoteVoucherService, VoteFraudDetector)
- `src/voucher-system/types/` - 类型定义 (vote.ts, algorithm.ts, platform.ts, pool.ts)
- `src/components/voucher-system/` - UI 组件
- `src/services/gameProposalService.ts` - 游戏提案投票服务
- `src/pages/GamePersonalCenter.tsx` - 个人中心页面（大型页面，~2300行）
- `src/data/simulatedPlayers.ts` - 55位模拟玩家数据

## 已知限制
- 投票系统使用模拟玩家数据，非真实用户

## CloudBase 初始化与数据可靠性（2026-06-17 修复）
- **核心原则**：平台准备上线，必须保证数据不丢失、不不同步、不报错
- **初始化顺序**：main.tsx 中 `initCloudBase()` 必须在 `initializeSkills()` 之前完成（链式调用），否则所有 Skills 永久降级为 localStorage/内存模式
- **waitForCloudBase()**：cloudbase.ts 新增此函数，写入路径（cloudWrite/cloudUpdateWhere/cloudDelete）改为 await waitForCloudBase() 而非 isCloudBaseReady() + return，确保数据不因初始化时序丢失
- **dualWrite.ts**：save()/saveAll()/remove() 中的 cloudWrite/cloudDelete 从 fire-and-forget 改为 await
- **AuthSkill**：不缓存 cloudbaseAuth，改为 getAuth() 延迟获取，每次操作动态检查
- **GameConnectorSkill**：CloudBase 数据加载改为 ensureLoadedFromCloud() 延迟+可重试模式
- **marketplaceService**：移除 saveListings 的 slice(-20) 限制，改用 waitForCloudBase + Promise.allSettled 并行同步
- **匿名登录**：需在腾讯云开发控制台开启，envId=allinonegaming-d4gmsmrzz573264f6

## 红警道具创作 SOP（2026-06-26 创建）
- 文件：`AllinONE Online/ra2-powerup — 红警道具创作 SOP.md`
- 参照超级玛丽 SOP 模板格式，适配红警 RTS 游戏特点
- 10 种可用效果 API：add_cash, reveal_map, speed_boost, armor_boost, repair_all, power_surge, airdrop_supply, spawn_ally, place_mine, infinite_ore
- effectCode 沙箱注入 `game = window.__ra2allinone`，通过 emit(cmd) 走引擎管线
- 5 种引擎命令：addCash, repairAll, powerSurge, revealMap, spawnAlly
- 预设道具 11 个（空投资金/侦察卫星/急行军令/纳米装甲/战场维修站/电力超载/超级空投/炸弹箱/重型炸弹箱/无限矿产/超级矿脉）

## RA2 effectCode 命令注入模式（2026-06-24 实施）
- **设计原则**：effectCode 通过 `game.emit(cmd)` 注入命令，走游戏引擎自身管线（emit → localCommands → takeLocal → stepWith → applyCommands），与 Match3Game 的"直接状态修改模式"不同
- **桥接对象**：`window.__ra2allinone`（始终暴露，不限 DEV）= `{ view, world, localPlayerId, emit }`
- **第一次失败根因**：`window.__ra2view` 仅 DEV 模式暴露，生产构建中 undefined → 所有 effectCode 无效
- **新增 5 种 EffectCommand**：addCash、repairAll、powerSurge（电力激增）、revealMap（全图视野）、spawnAlly（友军增援）
- **world.ts**：`_powerSurgeTimers` + `_revealTimers` Map 属性，stepPower() 和 step() 中递减计时器
- **world-renderer.ts**：cellVisible/cellExplored 支持 `_revealTimers`（激活时恒返回 true）
- **play.ts**：`window.__ra2play` 也改为始终暴露
- **构建验证**：typecheck + build + build:singlefile 全部通过

## 核心架构知识（2026-06-05 更新）
- **A币 = 凭证，非钱包余额**：A币仅在 VoucherService/voucherPaymentService 中管理（凭证制），不在 WalletSkill 中（余额制）。WalletSkill v3 仅管理 gameCoins。
- **A币余额 = sum of 用户所有 A币类 ACTIVE 凭证的 denomination**（排除道具凭证），通过 `voucherPaymentService.getUserVoucherBalance()` 获取
- **交易市场**：道具凭证上架冻结→买家支付（gameCoins走钱包 / aCoins走凭证）→解冻→transferVoucher 转让
- **凭证二分法（2026-06-03）**：`isCurrencyVoucher()` 判断A币类(instant/algorithm/vote)，`isItemVoucher()` 判断道具类(item)。支付/余额仅计A币类；上架交易仅道具类。
- **两套凭证存储**：`VoucherDatabase`（凭证系统，key=`allinone_vouchers`，字段`currentHolderId`）与 `VoucherSkill`（Skill，key=`vouchers`，字段`holderId`）是独立存储，真正数据在前者
- **SkillGateway userId**：所有 `skillGateway.execute()` 必须传第4参数 `context: { userId, sessionId }`，否则默认 `'anonymous'`
- **VoucherSourceType 定义位置**：`src/voucher-system/types.ts` 有完整4种 + 类型守卫函数(isCurrencyVoucher/isItemVoucher)——应导入前者
- **游戏商账户体系（2026-06-05）**：
  - 每个已发布游戏自动创建 `game-{gameId}` 账户（GameDeveloperAccount）
  - 玩家购买道具的凭证收入 → `game-{gameId}`（非 SYSTEM）
  - 平台分成：配对记账模式，platformOwed 字段记录待结算金额
  - 每日结算：每日 00:00 将 platformOwed 转入 `platform_treasury`
  - 存量游戏首次启动时自动补建账户
  - 相关文件：`src/types/gameDeveloper.ts`、`src/services/gameDeveloperService.ts`、`src/components/GameDeveloperPanel.tsx`
  - PublishedGame 新增字段：`publisherId`、`publisherName`、`revenueSharePercent`
  - PlatformAdmin 新增"游戏商总览"Tab

## CloudBase 同步架构（2026-06-18 更新：CloudBase 为权威数据源）
所有业务服务已实现 CloudBase 数据库为权威数据源 + localStorage/IndexedDB 仅作缓存：
- **写入**：`localStorage.setItem()`（更新缓存）+ `writeQueue.enqueue()` 入队 → CloudBase（权威数据源）。写入队列支持指数退避重试(5次)、localStorage 持久化、页面刷新自动恢复，保证零数据丢失
- **读取**：先从本地缓存同步读取（立即可用），首次调用时异步从 CloudBase 加载权威数据，**覆盖**本地缓存（云端为准）
- **删除**：本地删除 + `writeQueue.enqueue({ operation: 'delete' })` → CloudBase delete，防止下次云端同步拉回已删除数据
- **写入队列核心**：`src/services/writeQueue.ts` — enqueue(非阻塞)/enqueueAndWait(阻塞)/startProcessor/getStatus/retryAll
- **统一工具**：`src/voucher-system/storage/cloudSync.ts`（persistWithCloudSync / loadWithCloudSync / upsertToCloud / deleteFromCloud）
- **已入队的服务**（15+个文件）：cloudSync.ts, dualWrite.ts, VoucherDatabase.ts, WalletSkill.ts, publishedGameService, platformTreasuryService, platformConfigService, platformGameStoreService, gameProposalService, voucherItemService, marketplaceService, redeemCodeService, ExtensionVoucher.ts, StoreSkill, ProposalSkill, InventorySkill, main.tsx(startProcessor)
- **已移除的数据截断**：VoucherDatabase slice(-20)→全量, gameStore/proposal/voucherItem slice(-10)→全量, InventorySkill slice(-20)→全量, redeemCodeService slice(-20)→全量, marketplaceService 直写CloudBase→writeQueue
- **自检修复（第四轮）**：RETRY_DELAYS[3] 80000→8000；dualWrite save/saveAll add→upsert；WalletSkill 交易/初始文档 add→upsert；platformTreasuryService add→upsert；writeQueue getOldestEntry 优先淘汰 failed 项
- **自检修复（第五轮，2026-06-18）**：
  - redeemCodeService.ts：updateHostedItem 集合名从 `redeem_codes` 修正为 `redeem_hosted_items`；deleteHostedItem 新增 writeQueue delete（托管道具+关联兑换码）
  - marketplaceService.ts：syncListingsToCloud 从直接写CloudBase API改为writeQueue.enqueue upsert；新增顶部 import { writeQueue }
  - gameProposalService.ts：loadThresholds/loadPenaltyLogs 异步回调中从初始闭包 data 改为重新读取 freshRaw/fresh；deleteProposal 新增 writeQueue delete
  - 删除操作3处全部修复：已删除数据不会从 CloudBase 拉回
- **全量审计+修复：CloudBase 数据覆盖本地缓存（2026-06-18）**
  - 核心原则：CloudBase 数据库是权威数据源，localStorage/IndexedDB 仅作缓存。上线后数据不能依赖浏览器本地存储
  - 修复 cloudSync.ts：`loadWithCloudSync` 合并策略从"仅补充本地缺失 ID"改为"CloudBase 数据覆盖本地同名 ID，本地独有数据保留"
  - 修复 redeemCodeService.ts：`syncToCloudBase` 从`items.slice(-20)`直接写CloudBase改为通过writeQueue全量upsert（零丢失+重试）；`initCloudSyncIfNeeded`合并策略改为云端覆盖本地
  - 修复 voucherItemService.ts：loadTemplates/loadPurchases 合并策略改为云端覆盖本地同名ID
  - 修复 gameProposalService.ts：loadProposals 合并策略改为云端覆盖本地；新增 thresholds→CloudBase(`vote_thresholds`集合) + penaltyLogs→CloudBase(`penalty_logs`集合)的写入队列同步
  - 修复 marketplaceService.ts：syncListingsFromCloud 合并策略改为云端覆盖本地
  - 修复 platformGameStoreService.ts：loadStores 合并策略改为云端覆盖本地
  - 修复 ExtensionVoucher.ts：save() 新增 writeQueue.enqueue 写入 CloudBase(`extension_vouchers`集合)；新增 refreshFromCloud() 异步刷新方法
  - platformConfigService.ts：已正确实现 CloudBase 覆盖模式（syncFromCloud 直接覆盖 localStorage），无需修改
- 无需迁移：useTheme（UI偏好）、authContext（会话状态）、authTokenService（安全）、standard-sdk/apis（iframe协议）、gameFileDb（已有云存储）、VoteFraudDetector（设备指纹）
