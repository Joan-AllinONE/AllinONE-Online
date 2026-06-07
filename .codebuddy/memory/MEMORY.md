# 项目记忆 - AllinONE Gaming Platform

## 项目概述
AllinONE Gaming Platform — 游戏管理平台，包含凭证系统、投票治理、市场交易、钱包管理等功能。

## 技术栈
- React + TypeScript
- localStorage 数据持久化
- sonner toast 通知库
- 无后端，纯前端 SPA

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
