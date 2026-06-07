# AllinONE Gaming Platform — 文档债评估报告

> 审计日期：2026-06-07 | 审计人：Docu（技术文档师） | 版本：v1.0

---

## 目录

1. [评估总览](#1-评估总览)
2. [README 文档](#2-readme-文档)
3. [CONTRIBUTING 文档](#3-contributing-文档)
4. [中英文同步性](#4-中英文同步性)
5. [代码内文档](#5-代码内文档)
6. [API 文档](#6-api-文档)
7. [运维文档](#7-运维文档)
8. [架构文档](#8-架构文档)
9. [文档债明细表（含 Impact/Risk/Effort）](#9-文档债明细表)
10. [缺失文档优先级清单](#10-缺失文档优先级清单)
11. [改进路线图](#11-改进路线图)

---

## 1. 评估总览

| 评估维度 | 当前得分 | 目标得分 | 债项数量 |
|----------|---------|---------|----------|
| README 文档 | 3.0 / 5 | 4.5 | 6 |
| CONTRIBUTING 文档 | 3.0 / 5 | 4.0 | 4 |
| 代码内文档 | 3.0 / 5 | 4.0 | 5 |
| API 文档 | 2.0 / 5 | 4.5 | 6 |
| 运维文档 | 2.0 / 5 | 4.0 | 7 |
| 架构文档 | 1.0 / 5 | 4.0 | 5 |
| **加权总分** | **2.4 / 5** | **4.2 / 5** | **33 项** |

**总体判断**：项目有中等程度的文档债。README 和 CONTRIBUTING 有基本覆盖，但缺乏深度。API 文档、运维文档和架构文档是最大缺口——特别是 API 文档完全缺失独立文件、无 Runbook、无架构设计记录。

---

## 2. README 文档

### 2.1 README.md（中文）

**评分：3.5 / 5**

| 维度 | 状态 | 评价 |
|------|------|------|
| 项目介绍 | ✅ | 品牌定位清晰，功能概览完整（6 大模块） |
| 安装步骤 | ✅ | Node.js 18+ / pnpm / `pnpm install && pnpm dev` |
| 开发指南 | ⚠️ | 有目录结构和核心模块说明，但缺少"5 分钟快速开始"聚焦入口 |
| 部署流程 | ✅ | 4 种部署场景（本地/Nginx/GitHub Pages/Vercel），含代码示例 |
| API 文档 | ❌ | 仅在"可选后端 API"段提了一句 API 基址，无端点说明 |
| 贡献指南 | ⚠️ | 仅 3 行，指向 CONTRIBUTING.md，无快速导航 |
| 截图 | ❌ | 只有截图目录约定（推荐），无实际截图 |
| 徽章 | ❌ | 无构建状态、测试覆盖率、许可证等徽章 |
| 许可证 | ❌ | "未设置公开许可证"——对开源项目是严重信号 |

### 2.2 README_EN.md（英文）

**评分：3.5 / 5**

- 与中文版结构完全对齐
- 翻译质量良好（非机翻痕迹）
- 缺陷与中文版一致

### 2.3 README 债项

| # | 债项 | 严重度 |
|---|------|--------|
| R1 | 缺少项目徽章（build/coverage/license） | 低 |
| R2 | 缺少"5 分钟快速开始"聚焦入口 | 中 |
| R3 | README 中无 API 端点速览 | 高 |
| R4 | 截图目录约定存在但无实际截图 | 中 |
| R5 | 贡献段仅 3 行跳转链接，缺少快速参与指引 | 中 |
| R6 | 许可证状态不明确 | 高 |

---

## 3. CONTRIBUTING 文档

### 3.1 CONTRIBUTING.md（中文）

**评分：3.0 / 5**

| 维度 | 状态 | 评价 |
|------|------|------|
| 欢迎语气 | ✅ | 温暖、激励性强，涵盖非技术人员 |
| 贡献分类 | ✅ | 非技术贡献（5 类）+ 技术贡献（3 类） |
| 任务规划 | ✅ | 近期任务分 3 大方向、18 个子任务 |
| 贡献流程 | ✅ | Fork → Branch → Commit → PR |
| 行为准则 | ✅ | 友好尊重、风格统一 |
| Issue 链接 | ❌ | 仍用占位符 `https://github.com/your-repo/issues` |
| 编码规范 | ❌ | 无 ESLint/Prettier 配置说明，无 TypeScript 规范 |
| 环境搭建 | ❌ | 无本地开发环境详细步骤（依赖安装、数据库配置） |
| 提交规范 | ❌ | 无 commit message 约定（如 Conventional Commits） |
| PR 模板 | ❌ | 无 `.github/PULL_REQUEST_TEMPLATE.md` |
| 测试要求 | ❌ | 无测试运行说明、覆盖率要求 |

### 3.2 CONTRIBUTING.en.md（英文）

**评分：3.0 / 5** — 与中文版完全对齐，同等优缺点。

### 3.3 CONTRIBUTING 债项

| # | 债项 | 严重度 |
|---|------|--------|
| C1 | Issue 链接为占位符 `github.com/your-repo/issues` | 高 |
| C2 | 缺少编码规范/风格指南 | 中 |
| C3 | 缺少本地开发环境搭建指引 | 中 |
| C4 | 缺少 commit message 规范和 PR 模板 | 中 |

---

## 4. 中英文同步性

**评分：4.0 / 5**

| 文件 | 同步状态 | 差异 |
|------|----------|------|
| README.md ↔ README_EN.md | ✅ 对齐 | 贡献段措辞微异（"欢迎提交 PR，也欢迎提出建议" vs "join in the construction"） |
| CONTRIBUTING.md ↔ CONTRIBUTING.en.md | ✅ 对齐 | 几乎逐段对应 |

**结论**：中英文文档同步质量良好，无明显信息缺失。

---

## 5. 代码内文档

### 5.1 整体评估

**评分：3.0 / 5**

| 模块 | JSDoc 覆盖 | 注释质量 | 评分 |
|------|-----------|---------|------|
| `server.js` | 中等 | 好 | 3.5/5 |
| `src/server/redeemCodeStore.ts` | 好 | 好 | 4.0/5 |
| `src/server/memoryDatabase.ts` | 基本 | 可接受 | 3.5/5 |
| `src/skills/*` | **优秀** | 好 | 4.0/5 |
| `src/services/*` | **差** | 不足 | 2.0/5 |
| `src/publishing-center/*` | 中等 | 可接受 | 3.0/5 |
| `src/voucher-system/*` | 中等 | 可接受 | 3.0/5 |

### 5.2 服务层文档缺陷（关键发现）

`src/services/` 是整个应用的核心业务层，在 README 中被重点介绍，但 **JSDoc 覆盖率极低**：

- `walletService.ts`（核心钱包服务）— 文件中未找到（可能已删除/重构）
- `dividendWeightService.ts`（分红权重）— 未找到该文件
- `fundPoolService.ts`（资金池）— 未找到该文件
- `database.ts` — 类级注释为"模拟数据库服务"，无方法级 JSDoc
- 仅 `voucherPaymentService.ts`、`dualWrite.ts`、`cloudbase.ts` 有少量 JSDoc

> ⚠️ **警告**：README.md 第 141-165 行描述的"核心模块说明"中的文件路径（`walletService.ts`、`dividendWeightService.ts`、`fundPoolService.ts` 等）可能在近期重构后被删除或重命名。**README 中的文档与代码实际结构已不同步。**

**新发现**：README 描述 vs 实际代码存在显著偏差：

| README 描述的模块 | 实际文件存在？ | 说明 |
|------------------|--------------|------|
| `src/services/walletService.ts` | ❌ 不存在 | 可能已重构或删除 |
| `src/services/dividendWeightService.ts` | ❌ 不存在 | 可能已重构或删除 |
| `src/services/fundPoolService.ts` | ❌ 不存在 | 可能已重构或删除 |
| `src/services/oCoinService.ts` | ❌ 不存在 | 可能已删除（合规风险） |
| `src/services/marketplaceService.ts` | ❌ 不存在 | 可能已删除 |
| `src/services/officialStoreService.ts` | ❌ 不存在 | 可能已删除 |
| `src/services/optionsManagementService.ts` | ❌ 不存在 | 可能已删除 |

这与 `docs/CloudBase上线经验分享.md` 记录的"外科手术式重构"一致——O币模块、市场、资金池等确实已被删除。**但 README 未更新。**

### 5.3 代码文档债项

| # | 债项 | 严重度 |
|---|------|--------|
| D1 | README 核心模块说明与实际代码不同步（描述已删除的文件） | **严重** |
| D2 | `src/services/` 下核心服务缺少 JSDoc | 高 |
| D3 | `server.js` 端点缺少完整的 @param/@returns/@throws | 中 |
| D4 | 复杂业务逻辑（幂等保护、去重）无内联说明 | 中 |
| D5 | `vite.config.ts` 头部有误导性 "DON'T EDIT" 注释 | 低 |

---

## 6. API 文档

### 6.1 端点清单

#### `/api/inventory/*`

| 端点 | 方法 | server.js 中有？ | 独立文档？ | JSDoc 质量 |
|------|------|:---:|:---:|------|
| `/api/inventory` | GET | ✅ | ❌ | 仅方法+路径 |
| `/api/inventory/summary` | GET | ✅ | ❌ | 仅方法+路径 |
| `/api/inventory` | POST | ✅ | ❌ | 仅方法+路径 |
| `/api/inventory/sync` | POST | ✅ | ❌ | 仅方法+路径 |
| `/api/inventory/:itemId/sync-status` | GET | ✅ | ❌ | 仅方法+路径 |
| `/api/inventory/:itemId/sync-status` | PATCH | ✅ | ❌ | 仅方法+路径 |

#### `/api/redeem/*`

| 端点 | 方法 | server.js 中有？ | 独立文档？ | JSDoc 质量 |
|------|------|:---:|:---:|------|
| `/api/redeem/sync` | POST | ✅ | ❌ | 好（含 Body 说明） |
| `/api/redeem/verify` | POST | ✅ | ❌ | **优秀**（Head/Body/Response 完整） |
| `/api/redeem/use` | POST | ✅ | ❌ | **优秀**（Head/Body/Response 完整） |
| `/api/redeem/stats` | GET | ✅ | ❌ | 仅方法+路径 |

### 6.2 缺失内容

- ❌ 无 OpenAPI/Swagger 规范文件
- ❌ 无独立 API 参考文档（Markdown）
- ❌ 无认证方案说明（Bearer Token 格式、获取方式）
- ❌ 无错误码目录
- ❌ 无分页规范说明
- ❌ 无 SDK 使用示例（仅服务层代码）
- ❌ 无 API 版本策略

### 6.3 API 文档债项

| # | 债项 | 严重度 |
|---|------|--------|
| A1 | 完全没有独立 API 文档文件 | **严重** |
| A2 | 缺少 OpenAPI/Swagger 规范 | 高 |
| A3 | 认证机制无文档（Token 格式、获取流程） | 高 |
| A4 | 无错误码参考 | 中 |
| A5 | `/api/inventory/*` 请求/响应示例缺失 | 中 |
| A6 | 无分页/限流策略文档 | 低 |

---

## 7. 运维文档

### 7.1 已有内容

| 资源 | 状态 | 质量 |
|------|:---:|------|
| `Dockerfile` | ✅ 存在 | 可用但简单（20行，无多阶段构建，无 healthcheck） |
| `cloudbase.json` | ✅ 存在 | CloudRun 配置完整 |
| `.github/workflows/deploy.yml` | ✅ 存在 | GitHub Pages CI/CD 完整 |
| `docs/CloudBase上线经验分享.md` | ✅ 存在 | **优秀**——实用的避坑指南 |
| `.env.example` | ⚠️ 极简 | 仅 2 行，未覆盖 server.js 需要的所有变量 |
| `.env.cloudbase.example` | ⚠️ 部分 | 含 CloudBase 变量，但 DB 配置段不适用 PostgreSQL |
| `.env.crossplatform.example` | ⚠️ 部分 | 引用已删除的功能（New Day、市场） |
| `cloudfunctions/db_init/init.cjs` | ✅ 存在 | 含集合定义和索引 |

### 7.2 缺失内容

- ❌ 无 docker-compose.yml（本地开发多服务编排）
- ❌ 无 Runbook / 故障处理手册
- ❌ 无数据库 Schema 文档（仅 init.cjs 中有集合名）
- ❌ 无环境变量完整参考表
- ❌ 无备份/恢复流程
- ❌ 无监控与告警配置文档
- ❌ 无 CloudBase CloudRun 专属部署文档（Dockerfile 注释说是 CloudBase，但实际是通用 Node 镜像）
- ❌ 无回滚流程
- ❌ 无安全配置清单（CORS、Helmet、HTTPS 等）

### 7.3 运维文档债项

| # | 债项 | 严重度 |
|---|------|--------|
| O1 | 无 Runbook（故障处理/常见问题） | **严重** |
| O2 | 无完整环境变量参考文档 | 高 |
| O3 | 无数据库 Schema 文档（ER 图 + 字段说明） | 高 |
| O4 | 无 docker-compose.yml | 中 |
| O5 | `.env` 示例文件不完整/引用废弃功能 | 中 |
| O6 | 无备份恢复流程 | 中 |
| O7 | 无部署回滚流程 | 中 |

---

## 8. 架构文档

### 8.1 docs/ 目录评估

| 文件 | 类型 | 质量 | 是否架构文档？ |
|------|------|------|:---:|
| `CloudBase上线经验分享.md` | 运维经验/博客 | ⭐⭐⭐⭐⭐ | ❌ |
| `game-publishing-guide-match3.md` | 游戏发布案例 | ⭐⭐⭐⭐⭐ | 部分（含架构图） |
| `ai-game-integration-prompt.md` | AI 提示模板 | ⭐⭐⭐⭐ | ❌ |
| `ai-game-integration-prompt-mode-b.md` | AI 提示模板 | ⭐⭐⭐⭐ | ❌ |

**结论**：docs/ 目录内容丰富但**不含任何正式架构文档**。4 个文件中有 2 个是 AI 提示模板，1 个是运维博客，1 个是游戏发布案例。

### 8.2 缺失内容

- ❌ 系统架构概述文档
- ❌ 架构决策记录（ADR）— **0 个**
- ❌ 系统架构图（仅 game-publishing-guide-match3.md 有一个 ASCII 图）
- ❌ 数据流图
- ❌ 部署架构图
- ❌ 技术选型理由文档
- ❌ 模块间依赖关系图
- ❌ Skill 架构设计说明（虽有一个体系但无设计文档）

### 8.3 架构文档债项

| # | 债项 | 严重度 |
|---|------|--------|
| AR1 | 完全无架构决策记录（ADR） | **严重** |
| AR2 | 无系统架构概述文档 | 高 |
| AR3 | 无正式架构图（仅一个 ASCII 图藏在案例文档中） | 高 |
| AR4 | Skill 体系设计无文档（设计意图/原理） | 中 |
| AR5 | 无技术选型理由（为什么 React、为什么 CloudBase、为什么 PostgreSQL+内存双模式） | 中 |

---

## 9. 文档债明细表

> 评分标准：1 = 极低 / 2 = 低 / 3 = 中 / 4 = 高 / 5 = 极高

### 严重（Critical）

| ID | 债项 | Impact | Risk | Effort | 综合 |
|----|------|:---:|:---:|:---:|:---:|
| **D1** | README 核心模块说明与代码不同步，描述已删除文件 | 5 | 5 | 2 | **12** |
| **A1** | 完全无独立 API 文档 | 5 | 4 | 4 | **13** |
| **O1** | 无 Runbook / 故障处理文档 | 4 | 5 | 3 | **12** |
| **AR1** | 无架构决策记录（ADR） | 4 | 4 | 3 | **11** |

### 高（High）

| ID | 债项 | Impact | Risk | Effort | 综合 |
|----|------|:---:|:---:|:---:|:---:|
| A2 | 缺少 OpenAPI/Swagger 规范 | 4 | 3 | 3 | 10 |
| A3 | 认证机制无文档 | 4 | 4 | 2 | 10 |
| O2 | 无完整环境变量参考 | 3 | 4 | 1 | 8 |
| O3 | 无数据库 Schema 文档 | 3 | 4 | 2 | 9 |
| R3 | README 无 API 端点速览 | 3 | 2 | 1 | 6 |
| R6 | 许可证状态不明确 | 2 | 5 | 1 | 8 |
| C1 | Issue 链接为占位符 | 2 | 4 | 1 | 7 |
| D2 | services/ 层缺少 JSDoc | 3 | 3 | 3 | 9 |
| AR2 | 无系统架构概述文档 | 3 | 3 | 4 | 10 |
| AR3 | 无正式架构图 | 3 | 3 | 3 | 9 |

### 中（Medium）

| ID | 债项 | Impact | Risk | Effort | 综合 |
|----|------|:---:|:---:|:---:|:---:|
| R2 | 缺少"5分钟快速开始" | 2 | 2 | 1 | 5 |
| R4 | 截图目录无实际截图 | 2 | 1 | 2 | 5 |
| R5 | 贡献段过于简短 | 2 | 2 | 1 | 5 |
| C2 | 缺少编码规范 | 3 | 2 | 2 | 7 |
| C3 | 缺少本地开发环境指引 | 3 | 2 | 2 | 7 |
| C4 | 缺少 commit 规范/PR 模板 | 3 | 2 | 1 | 6 |
| D3 | server.js 端点缺少完整 JSDoc | 2 | 2 | 2 | 6 |
| D4 | 复杂逻辑无内联说明 | 2 | 3 | 2 | 7 |
| A4 | 无错误码参考 | 2 | 2 | 2 | 6 |
| A5 | /api/inventory/* 请求/响应示例缺失 | 2 | 2 | 2 | 6 |
| O4 | 无 docker-compose.yml | 2 | 2 | 1 | 5 |
| O5 | .env 示例不完整 | 2 | 3 | 1 | 6 |
| O6 | 无备份恢复流程 | 2 | 3 | 2 | 7 |
| AR4 | Skill 体系无设计文档 | 3 | 2 | 3 | 8 |

### 低（Low）

| ID | 债项 | Impact | Risk | Effort | 综合 |
|----|------|:---:|:---:|:---:|:---:|
| R1 | 缺少项目徽章 | 1 | 1 | 1 | 3 |
| D5 | vite.config.ts 误导性注释 | 1 | 1 | 1 | 3 |
| A6 | 无分页/限流策略文档 | 1 | 1 | 1 | 3 |
| O7 | 无部署回滚流程 | 2 | 2 | 2 | 6 |
| AR5 | 无技术选型理由 | 2 | 1 | 2 | 5 |

---

## 10. 缺失文档优先级清单

### P0 — 立即处理（本周）

| 优先级 | 文档 | 理由 |
|:---:|------|------|
| 1 | **API 参考文档** (`docs/api-reference.md` 或 OpenAPI spec) | 游戏方接入的唯一接口文档；10 个端点全部无外部文档。产出：Swagger YAML + Markdown 参考。 |
| 2 | **更新 README.md/README_EN.md** | 核心模块说明已过时（引用已删除文件）。同步实际代码结构。加 API 速览表。 |
| 3 | **环境变量完整参考** (`docs/environment-variables.md`) | server.js 用了 ~10 个环境变量，仅 1 个出现在 `.env.example` 中。新人无法正确配置。 |

### P1 — 短期处理（本月）

| 优先级 | 文档 | 理由 |
|:---:|------|------|
| 4 | **Runbook** (`docs/runbook.md`) | 覆盖：服务器启动失败、数据库连接失败、内存数据库 vs PostgreSQL 切换、CloudBase 部署 404 问题、兑换码核销失败排查 |
| 5 | **数据库 Schema 文档** (`docs/database-schema.md`) | 8 个集合（CloudBase）/ 对应 PostgreSQL 表，含字段说明、索引、关系。可直接从 `init.cjs` 提取。 |
| 6 | **架构概述** (`docs/architecture.md`) | 系统分层图（前端/后端/数据库/游戏层）、数据流、Skill 体系说明、发布管线说明。 |
| 7 | **CONTRIBUTING 更新** | 修复 Issue 链接、添加编码规范、开发环境搭建。 |

### P2 — 中期处理（本季度）

| 优先级 | 文档 | 理由 |
|:---:|------|------|
| 8 | **架构决策记录（ADR）** | 至少 5 条：为什么选 CloudBase、为什么 PostgreSQL+内存双模式、为什么 localStorage→数据库迁移、为什么 Skill 架构、为什么 iframe 托管游戏 |
| 9 | **服务层 JSDoc 补充** | 对现有 `src/services/` 文件添加完整 JSDoc |
| 10 | **docker-compose.yml** + **容器化部署指南** | 本地开发一键启动（前端+后端+数据库） |
| 11 | **README 增强** | 徽章、截图、5 分钟快速开始 |
| 12 | **许可证明确化** | 选择合适开源许可证并添加到项目 |

### P3 — 长期（持续）

| 优先级 | 文档 | 理由 |
|:---:|------|------|
| 13 | 备份恢复流程 | 生产环境必需 |
| 14 | 部署回滚流程 | CI/CD 配套 |
| 15 | Skill 体系设计文档 | 对第三方游戏开发者至关重要 |
| 16 | 贡献者 Wiki / 开发手册 | 降低新贡献者上手难度 |

---

## 11. 改进路线图

```
Week 1-2 (P0 — 救火):
  ├── Day 1-3: 更新 README.md/README_EN.md（修复过时模块说明 + 加 API 速览）
  ├── Day 4-7: 编写 API 参考文档 (OpenAPI YAML + Markdown)
  └── Day 8-10: 编写环境变量完整参考 + 更新 .env.example 文件

Week 3-4 (P1 — 补基础):
  ├── 编写 Runbook（5 个常见场景）
  ├── 编写数据库 Schema 文档
  ├── 编写架构概述文档（含 Mermaid 图）
  └── 更新 CONTRIBUTING.md/EN.md

Month 2 (P2 — 加固):
  ├── 编写 5 条 ADR
  ├── 补充 services/ JSDoc
  ├── 编写 docker-compose.yml + 容器化指南
  ├── README 最终完善（徽章、截图、快速开始）
  └── 选定并添加开源许可证

Month 3+ (P3 — 可持续):
  ├── 备份恢复流程
  ├── 部署回滚文档
  ├── Skill 体系设计文档
  └── 贡献者 Wiki
```

---

## 附录 A：文件审计清单

| 文件路径 | 类型 | 已读 | 质量评估 |
|----------|------|:---:|------|
| `README.md` | 项目首页 | ✅ | 中等（3.5/5，有过时内容） |
| `README_EN.md` | 项目首页（英） | ✅ | 中等（3.5/5） |
| `CONTRIBUTING.md` | 贡献指南 | ✅ | 中等（3.0/5，缺规范细节） |
| `CONTRIBUTING.en.md` | 贡献指南（英） | ✅ | 中等（3.0/5） |
| `server.js` | 后端入口+API | ✅ | 好（3.5/5，部分端点 JSDoc 优秀） |
| `Dockerfile` | 容器构建 | ✅ | 可用但简单（2.5/5） |
| `docker-compose.yml` | 容器编排 | N/A | **不存在** |
| `.env.example` | 环境变量 | ✅ | 极简（1.0/5） |
| `.env.cloudbase.example` | 环境变量 | ✅ | 部分（2.5/5） |
| `.env.crossplatform.example` | 环境变量 | ✅ | 部分/过时（2.0/5） |
| `.env` | 环境变量 | ✅ | 仅 1 行 |
| `cloudbase.json` | CloudBase 配置 | ✅ | 完整（4.0/5） |
| `.github/workflows/deploy.yml` | CI/CD | ✅ | 完整（4.0/5） |
| `cloudfunctions/db_init/init.cjs` | 数据库初始化 | ✅ | 好（4.0/5，含 Schema） |
| `docs/CloudBase上线经验分享.md` | 运维经验 | ✅ | 优秀（5.0/5） |
| `docs/game-publishing-guide-match3.md` | 游戏发布案例 | ✅ | 优秀（5.0/5） |
| `docs/ai-game-integration-prompt.md` | AI 提示模板 | ✅ | 好（4.0/5） |
| `docs/ai-game-integration-prompt-mode-b.md` | AI 提示模板 | ✅ | 好（4.0/5） |
| `src/server/redeemCodeStore.ts` | 兑换码存储 | ✅ | 好（4.0/5） |
| `src/server/memoryDatabase.ts` | 内存数据库 | ✅ | 可接受（3.5/5） |
| `src/skills/*` | Skill 系统 | 抽检 | 好（4.0/5） |
| `src/services/*` | 核心服务层 | 抽检 | 不足（2.0/5） |
| `vite.config.ts` | 构建配置 | ✅ | 有误导性注释 |

## 附录 B：高亮发现

### 🔴 严重：README 与代码不同步

README.md 第 141-165 行描述的"核心模块"中引用的文件路径在代码库中**已全部不存在**。这与 CloudBase 迁移中的"外科手术式重构"一致，但文档未更新。新贡献者将无法找到描述的任何核心服务文件。

### 🟡 注意：已有高质量内容但分类不当

- `docs/CloudBase上线经验分享.md` 是优秀的运维文档，但它被放在了 docs/ 下作为"经验分享"而非正式的运维手册
- `docs/game-publishing-guide-match3.md` 包含了唯一可找到的系统架构图，但它是一个案例研究而非架构参考

### 🟢 优势：Skill 系统和 Publishing Center 文档完善

`src/skills/` 目录下的类型定义和 EventBus 有项目中最好的 JSDoc 覆盖率。游戏发布文档质量很高（case study + AI prompt templates），说明团队有能力产出高质量文档——只是没有系统性地覆盖所有模块。

---

*报告由 Docu（技术文档师）生成 | 工程保障团队 | 2026-06-07*
