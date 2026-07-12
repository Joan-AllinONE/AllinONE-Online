# CloudBase → 新云服务迁移对接文档

> **文档目的**：本文档面向 AI 辅助开发和人工开发者，详细描述 AllinONE Gaming Platform 项目中 CloudBase 的全部集成点、数据流、API 调用方式，以及迁移到其他云服务的策略与方案建议。读此文档即可完整了解项目后端现状，无需 AI 额外扫描代码。

---

## 目录

1. [项目概述](#1-项目概述)
2. [当前 CloudBase 集成架构](#2-当前-cloudbase-集成架构)
3. [API 使用清单](#3-api-使用清单)
4. [数据库集合（15个）](#4-数据库集合15个)
5. [文件级依赖关系](#5-文件级依赖关系)
6. [推荐替代云服务对比](#6-推荐替代云服务对比)
7. [迁移策略](#7-迁移策略)
8. [接口抽象层设计建议](#8-接口抽象层设计建议)
9. [与云服务商的沟通要点](#9-与云服务商的沟通要点)

---

## 1. 项目概述

| 属性 | 值 |
|------|-----|
| 项目名称 | AllinONE Gaming Platform |
| 项目类型 | UGC（用户生成内容）游戏平台 |
| 前端技术栈 | React 18 + TypeScript + Vite 6 + Tailwind CSS |
| 后端模式 | Serverless 前端直连云服务（无中间服务器层） |
| 数据策略 | CloudBase 云端为主 + localStorage/IndexedDB 本地缓存兜底（零丢失双写） |
| 当前云服务 | 腾讯 CloudBase (@cloudbase/js-sdk v2.25.7) |
| 部署方式 | CloudBase 静态托管 + 云存储 |

### 核心业务需求

1. **UGC 游戏发布**：用户上传游戏（HTML/CSS/JS 打包），保存到云端，供其他玩家游玩
2. **用户认证**：支持匿名登录 + 邮箱密码登录
3. **数据持久化**：所有用户创作的 UGC 数据必须可靠存储
4. **道具/凭证系统**：游戏内道具模板、铸造、兑换、交易
5. **市场挂牌**：用户间道具交易
6. **AI 分析**：使用云端 AI 模型分析上传的游戏代码
7. **写入零丢失**：通过持久化重试队列保证网络抖动时不丢数据

---

## 2. 当前 CloudBase 集成架构

```
┌─────────────────────────────────────────────────────────┐
│                    React Frontend (SPA)                  │
├─────────────────────────────────────────────────────────┤
│  main.tsx → initCloudBase() → writeQueue.startProcessor │
├────────────┬─────────────┬──────────────┬───────────────┤
│   Auth      │  Database   │   Storage    │     AI        │
│ (匿名+邮箱)  │ (文档型DB)   │  (云存储)     │ (Hunyuan)     │
├────────────┴─────────────┴──────────────┴───────────────┤
│                抽象层 (服务层)                             │
│  writeQueue  ←── 写入队列 (零丢失重试)                     │
│  dualWrite   ←── 双写工具 (CloudBase + localStorage)      │
│  cloudbaseStorage ←── 云存储封装                           │
├─────────────────────────────────────────────────────────┤
│                CloudBase JS SDK                           │
│         @cloudbase/js-sdk v2.25.7                        │
├─────────────────────────────────────────────────────────┤
│              腾讯云 CloudBase 后端                         │
│  ├── 文档数据库 (NoSQL JSON Document DB)                  │
│  ├── 云存储 (File/Object Storage)                        │
│  ├── Auth 服务 (匿名登录 + 邮箱密码)                       │
│  └── AI 模型 (Hunyuan 大模型)                             │
└─────────────────────────────────────────────────────────┘
```

### 架构关键特征

| 特征 | 说明 |
|------|------|
| **前端直连** | 无中间 BFF（Backend for Frontend）层，SDK 在前端直接调用云端 |
| **双写策略** | 写操作同时写 localStorage（缓存）+ CloudBase（云端），读操作云端优先 → 本地兜底 |
| **写入队列** | 所有写入非阻塞入队，后台处理，指数退避重试（1s/2s/4s/8s/16s，最多5次） |
| **零数据丢失** | 队列持久化到 localStorage，页面刷新自动恢复 |
| **后端不可知** | 初始化失败也启动队列（等待恢复后重试），UI 不阻塞 |

---

## 3. API 使用清单

### 3.1 SDK 初始化

```typescript
// cloudbase.ts 第94行
const instance = cloudbase.init({
  env: CLOUDBASE_ENV,                    // 环境ID (string)
  ...(accessKey && { accessKey }),       // 可选密钥
});
```

**迁移替换点**: 新 SDK 的 app 初始化方法

---

### 3.2 认证 API

| 当前 API | 位置 | 用途 | 频率 |
|---------|------|------|------|
| `app.auth({ persistence: 'local' })` | cloudbase.ts:100 | 创建 auth 实例，登录态持久化到 localStorage | 一次/会话 |
| `auth.signInAnonymously()` | cloudbase.ts:121 | 匿名登录（无账号访问） | 一次/会话 |
| `auth.getLoginState()` | cloudbase.ts:105 | 检查当前登录状态 | 初始化时 |
| `auth.signInWithEmailAndPassword()` | AuthSkill.ts | 邮箱密码登录 | 按需 |
| `auth.signUpWithEmailAndPassword()` | AuthSkill.ts | 邮箱密码注册 | 按需 |
| `auth.logout()` | AuthSkill.ts | 登出 | 按需 |

**特殊需求**: 需要在匿名登录和真实登录之间切换；登录态需要跨页面刷新持久化（`persistence: 'local'`）

**迁移替换点**: 新服务的 Auth SDK — 必须支持匿名登录 + 邮箱密码登录 + 跨页面持久化

---

### 3.3 数据库 API（文档型 NoSQL）

所有数据库操作集中在 `writeQueue.ts` 中：

| 当前 API | 等价 SQL/逻辑 | 使用频次 |
|---------|-------------|---------|
| `db.collection(name).add(data)` | `INSERT INTO name ...` | 极高 |
| `db.collection(name).doc(id).update(data)` | `UPDATE name SET ... WHERE _id = ?` | 极高 |
| `db.collection(name).where(cond).update(data)` | `UPDATE name SET ... WHERE ...` | 中 |
| `db.collection(name).where(cond).get()` | `SELECT * FROM name WHERE ...` | 极高 |
| `db.collection(name).where(cond).limit(n).get()` | `SELECT * FROM name WHERE ... LIMIT n` | 高 |
| `db.collection(name).orderBy(field, dir).limit(n).get()` | `SELECT * ... ORDER BY field LIMIT n` | 中 |
| `db.collection(name).doc(id).remove()` | `DELETE FROM name WHERE _id = ?` | 中 |

**Upsert 实现**（当前在 writeQueue.ts:328-352 做客户端模拟）：
```typescript
// 先按 id 字段查 → 存在则 update → 不存在则 add
const res = await db.collection(name).where({ id: data.id }).get();
if (res.data.length > 0) {
  await db.collection(name).doc(res.data[0]._id).update({...data});
} else {
  await db.collection(name).add({...data});
}
```

**迁移替换点**: 如果新服务是 SQL 数据库（如 Supabase PostgreSQL），需要将 `where({key: value})` 映射为 SQL WHERE 子句，`doc(id)` 映射为主键查询。

---

### 3.4 云存储 API

| 当前 API | 位置 | 用途 |
|---------|------|------|
| `app.uploadFile({ cloudPath, filePath })` | cloudbaseStorage.ts:71 | 上传文件到云存储 |
| `app.getTempFileURL({ fileList })` | cloudbaseStorage.ts:101 | 获取临时下载URL |
| `app.deleteFile({ fileList })` | cloudbaseStorage.ts:118 | 删除文件 |
| `app.listFiles({ prefix, limit })` | publishedGameService.ts:581 | 列举目录下文件 |

**文件命名规则**: `games/{gameId}/{filePath}` — 按游戏 ID 分目录存储

**迁移替换点**: 新服务的对象存储或文件存储 API — 必须有类似的上传/下载链接/删除/列举功能

---

### 3.5 AI 模型 API

| 当前 API | 位置 | 用途 |
|---------|------|------|
| `app.ai()` | cloudbase.ts:185 | 获取 AI 实例 |
| `ai.createModel('cloudbase')` | cloudbase.ts:194 | 创建 Hunyuan 模型 |
| `model.streamText({...})` | ugcBridgeService.ts | 流式文本生成（UGC 道具对话） |
| `model.generateText({...})` | GameCodeAnalyzer.ts | 非流式文本生成（代码分析） |

**使用的 Prompt 场景**:
- **UGC 道具工坊对话**：玩家用自然语言描述道具 → AI 生成 Schema 数据 → 铸造为凭证
- **游戏代码分析**：分析上传的游戏 HTML/JS 代码，识别框架类型、功能特征、代码质量
- **SOP 文案生成**：根据游戏类型生成道具创作 SOP 文档

**迁移替换点**: 新服务的 AI API 或第三方 LLM API（需要支持流式和非流式两种模式）

---

## 4. 数据库集合（15个）

### P0 核心集合（必须存在，否则 UGC 核心功能失效）

| 集合名 | 用途 | 关键字段 | 预估体积 |
|--------|------|---------|---------|
| `published_games` | UGC 游戏元数据 | id, name, files[], entryPoint, status | 中 |
| `users` | 用户账户/钱包 | uid, gameCoins, wallet | 中 |
| `transactions` | 交易日志 | id, userId, type, amount | 大 |
| `vouchers` | 道具凭证数据 | id, ownerId, templateId, status | 大 |
| `voucher_templates` | 道具模板定义 | id, name, schema, effects | 小 |

### P1 重要集合（市场/商店/提案功能）

| 集合名 | 用途 | 关键字段 |
|--------|------|---------|
| `voucher_transactions` | 凭证铸造/转移日志 | id, voucherId, type, timestamp |
| `purchases` | 购买/兑换记录 | id, userId, itemId, amount |
| `market_listings` | 挂牌出售信息 | id, voucherId, price, sellerId |
| `proposals` | 投票提案 | id, title, status, votes |
| `game_stores` | 游戏商店配置 | id, gameId, items[] |
| `game_connectors` | 游戏连接配置 | id, gameId, config |
| `platform_treasury` | 平台金库+配置 | id, balance, settings |

### P2 辅助集合

| 集合名 | 用途 | 关键字段 |
|--------|------|---------|
| `vote_thresholds` | 投票规则阈值 | id, type, threshold |
| `penalty_logs` | 惩罚/处罚记录 | id, userId, reason |
| `extension_vouchers` | 扩展凭证（UGC） | id, schema, extensionData |

---

## 5. 文件级依赖关系

### 5.1 核心服务层（必须同步迁移）

| 文件 | 职责 | CloudBase API 调用 | 迁移复杂度 |
|------|------|-------------------|-----------|
| `src/services/cloudbase.ts` | SDK 初始化、Auth、AI 实例 | init, auth, ai | ★★★★★ 核心 |
| `src/services/writeQueue.ts` | 写入重试队列 | database().collection().* (全部DB操作) | ★★★★ |
| `src/services/dualWrite.ts` | 双写 + 读取封装 | database().collection().get/where/limit/orderBy | ★★★ |
| `src/services/cloudbaseStorage.ts` | 云存储封装 | uploadFile, getTempFileURL, deleteFile | ★★★ |
| `src/services/cloudbaseItemSync.ts` | 道具数据云端同步 | database().collection().* | ★★ |

### 5.2 业务服务层（写入路径全部通过 writeQueue）

| 文件 | 用途 | 使用方式 |
|------|------|---------|
| `src/services/publishedGameService.ts` | 游戏发布管理 | writeQueue.enqueue + 直接 database() 查询 |
| `src/services/platformConfigService.ts` | 平台配置 | writeQueue.enqueue + lazy import cloudbase |
| `src/services/platformTreasuryService.ts` | 平台金库 | writeQueue.enqueue |
| `src/services/platformGameStoreService.ts` | 游戏商店 | writeQueue.enqueue + lazy import cloudbase |
| `src/services/gameProposalService.ts` | 提案管理 | writeQueue.enqueue + lazy import cloudbase |
| `src/services/marketplaceService.ts` | 交易市场 | writeQueue.enqueue + lazy import cloudbase |
| `src/services/redeemCodeService.ts` | 兑换码 | writeQueue.enqueue |
| `src/services/voucherItemService.ts` | 道具服务 | writeQueue.enqueue |
| `src/services/gameFileDb.ts` | 文件存储（本地） | lazy import cloudbaseStorage |

### 5.3 Skill 引擎层

| 文件 | 用途 | 使用方式 |
|------|------|---------|
| `src/skills/wallet/WalletSkill.ts` | 钱包管理 | writeQueue.enqueue + getCloudBaseApp() |
| `src/skills/store/StoreSkill.ts` | 商店逻辑 | writeQueue.enqueue |
| `src/skills/proposal/ProposalSkill.ts` | 提案逻辑 | writeQueue.enqueue + getCloudBaseApp() |
| `src/skills/inventory/InventorySkill.ts` | 背包管理 | writeQueue.enqueue |
| `src/skills/voucher/VoucherSkill.ts` | 凭证核心 | getCloudBaseApp() |
| `src/skills/game-connector/GameConnectorSkill.ts` | 游戏连接 | getCloudBaseApp() |
| `src/skills/auth/AuthSkill.ts` | 认证服务 | getCloudBaseApp() — CloudBase Auth |

### 5.4 Voucher 子系统

| 文件 | 用途 | 使用方式 |
|------|------|---------|
| `src/voucher-system/storage/VoucherDatabase.ts` | 主数据库 | writeQueue.enqueue + lazy import cloudbase |
| `src/voucher-system/storage/cloudSync.ts` | 云端同步 | getCloudBaseApp() + writeQueue |
| `src/voucher-system/services/VoteVoucherService.ts` | 投票凭证 | cloudSync 工具函数 |
| `src/voucher-system/services/UserPoolService.ts` | 用户池 | cloudSync 工具函数 |
| `src/voucher-system/services/PlatformBindingService.ts` | 平台绑定 | cloudSync 工具函数 |
| `src/voucher-system/services/AlgorithmVoucherService.ts` | 算法凭证 | cloudSync 工具函数 |

### 5.5 Publishing Center 层

| 文件 | 用途 | 使用方式 |
|------|------|---------|
| `src/publishing-center/protocol/ExtensionVoucher.ts` | 扩展凭证 | lazy import cloudbase |
| `src/publishing-center/ai/GameCodeAnalyzer.ts` | AI 代码分析 | createAIModel() — AI API |

### 5.6 入口 + Context

| 文件 | 用途 | 使用方式 |
|------|------|---------|
| `src/main.tsx` | 应用入口 | initCloudBase() + writeQueue.startProcessor() |
| `src/contexts/authContext.tsx` | 认证上下文 | initCloudBase() + AuthSkill |
| `src/utils/seedTestData.ts` | 测试数据种子 | getCloudBaseApp() |

---

## 6. 推荐替代云服务对比

### 候选方案概览

| 方案 | 数据库 | Auth | 存储 | AI | 前端直连 | 开源 |
|------|--------|------|------|----|---------|------|
| **Supabase** | PostgreSQL | ✅ 匿名+邮箱+OAuth | ✅ S3 兼容 | ❌ 需外挂 | ✅ Row Level Security | ✅ |
| **Firebase** | Firestore (NoSQL) | ✅ 匿名+邮箱+OAuth | ✅ | ✅ Vertex AI | ✅ Security Rules | ❌ |
| **Appwrite** | MariaDB | ✅ 匿名+邮箱+OAuth | ✅ | ❌ | ✅ 权限配置 | ✅ |
| **Convex** | 实时文档DB | ✅ | ✅ 文件存储 | ❌ | ✅ 函数式权限 | ✅(部分) |
| **自建** | PostgreSQL/MySQL | Auth0/NextAuth | MinIO/S3 | OpenAI/Claude API | 需BFF | ✅ |

### 推荐方案：Supabase（最高匹配度）

**匹配理由**:

1. **数据库映射**：PostgreSQL 的 JSONB 类型可以直接存储当前文档型数据，迁移成本最低
2. **Auth 兼容**：支持匿名登录 + 邮箱密码登录，persistence 机制类似
3. **存储兼容**：Supabase Storage 的 upload/download/delete/list API 与当前 CloudBase 存储 API 高度相似
4. **Row Level Security (RLS)**：可以精细控制"谁可以读写什么数据"——这正是 CloudBase 安全规则无法解决导致用户要迁移的首要原因
5. **开源**：可以自托管，不锁定厂商
6. **JS SDK**：浏览器端直接可用，无需中间服务器

### 次选方案：Firebase

**优点**:
- Firestore 同样是文档型 NoSQL，API 风格更接近 CloudBase
- 匿名登录内建支持更好
- Google 生态整合（Vertex AI 可替代 Hunyuan）
- 成熟度最高

**缺点**:
- 闭源，厂商锁定
- Firestore 的查询能力有限（无法 JOIN 等复杂操作）
- 国内访问需要代理

---

## 7. 迁移策略

### 7.1 推荐策略：适配器模式 + 渐进迁移

不要一次性替换所有 CloudBase 调用，而是引入 **抽象接口层**（Adapter Pattern），让新旧后端在过渡期共存。

```
┌──────────────────────────────────────┐
│           service 层 (不变)           │
├──────────────────────────────────────┤
│         BackendAdapter (新增)         │
│  interface IBackendService {          │
│    auth: IAuthAdapter                 │
│    db: IDatabaseAdapter               │
│    storage: IStorageAdapter           │
│    ai: IAIAdapter                     │
│  }                                    │
├──────────────┬───────────────────────┤
│ CloudBase    │  Supabase / Firebase    │
│ Adapter      │  Adapter              │
└──────────────┴───────────────────────┘
```

### 7.2 分阶段迁移计划

| 阶段 | 内容 | 预计工时 | 风险 |
|------|------|---------|------|
| **Phase 1**: 抽象接口 | 定义 IBackendService 接口，不改现有代码 | 1-2天 | 低 |
| **Phase 2**: 新适配器 | 实现 Supabase/Firebase 适配器 | 3-5天 | 中 |
| **Phase 3**: 双写验证 | 同时写 CloudBase + 新后端，读取对比验证 | 2-3天 | 中 |
| **Phase 4**: 切换读取 | 读路径优先新后端，CloudBase 兜底 | 2-3天 | 高 |
| **Phase 5**: 下线 CloudBase | 移除 CloudBase SDK 和旧代码 | 1-2天 | 中 |
| **Phase 6**: AI 迁移 | 替换 AI 模型调用 | 1-2天 | 低 |

### 7.3 可保留的现有基础设施

以下模块**不需要重写**，只需修改其依赖注入：

| 模块 | 保留原因 |
|------|---------|
| `writeQueue.ts` | 队列逻辑与后端无关，只需替换 `db` 实例 |
| `dualWrite.ts` | 双写策略与后端无关，只需替换 `cloudRead/cloudWrite` 内部调用 |
| `publishedGameService.ts` | 业务逻辑不变，只需替换数据库调用方式 |
| 所有 Skill 层 | 业务逻辑与后端无关 |

---

## 8. 接口抽象层设计建议

以下是建议的抽象接口层定义，对接新云服务时直接实现这些接口即可：

```typescript
// ========== src/services/backend/types.ts (新增) ==========

/**
 * 统一后端服务抽象接口
 * 实现此接口以对接任何云服务（Supabase, Firebase, Appwrite, 自建等）
 */

// ─── 认证 ───
export interface IAuthAdapter {
  /** 匿名登录 */
  signInAnonymously(): Promise<{ uid: string }>;
  /** 邮箱密码登录 */
  signInWithEmail(email: string, password: string): Promise<{ uid: string; email: string }>;
  /** 邮箱密码注册 */
  signUpWithEmail(email: string, password: string, nickname: string): Promise<{ uid: string }>;
  /** 登出 */
  signOut(): Promise<void>;
  /** 获取当前用户 */
  getCurrentUser(): Promise<{ uid: string; email?: string; isAnonymous: boolean } | null>;
  /** 监听登录状态变化 */
  onAuthStateChange(callback: (user: any) => void): () => void;
}

// ─── 数据库 ───
export interface IQueryBuilder {
  collection(collection: string): ICollectionQuery;
}

export interface ICollectionQuery {
  where(conditions: Record<string, any>): ICollectionQuery;
  orderBy(field: string, direction: 'asc' | 'desc'): ICollectionQuery;
  limit(n: number): ICollectionQuery;
  /** 查询 */
  get<T = any>(): Promise<{ data: T[] }>;
  /** 新增 */
  add(data: Record<string, any>): Promise<{ id: string }>;
  /** 按主键更新 */
  doc(id: string): { update(data: Record<string, any>): Promise<void>; remove(): Promise<void> };
  /** 条件更新 */
  update(data: Record<string, any>): Promise<void>;
  /** 条件删除 */
  remove(): Promise<void>;
}

// ─── 存储 ───
export interface IStorageAdapter {
  /** 上传文件 */
  uploadFile(params: {
    path: string;           // 存储路径
    file: File | Blob;      // 文件对象
    contentType?: string;   // MIME 类型
  }): Promise<{ url: string; path: string }>;
  /** 获取下载 URL */
  getFileUrl(path: string): Promise<string | null>;
  /** 列举文件 */
  listFiles(prefix: string, limit?: number): Promise<Array<{ name: string; path: string; size: number }>>;
  /** 删除文件 */
  deleteFile(path: string): Promise<void>;
  /** 批量删除前缀 */
  deleteFilesByPrefix(prefix: string): Promise<void>;
}

// ─── AI ───
export interface IAIAdapter {
  /** 流式文本生成 */
  streamText(params: {
    model?: string;
    messages: Array<{ role: string; content: string }>;
    temperature?: number;
    maxTokens?: number;
  }): AsyncIterable<string>;
  /** 非流式文本生成 */
  generateText(params: {
    model?: string;
    messages: Array<{ role: string; content: string }>;
    temperature?: number;
    maxTokens?: number;
  }): Promise<string>;
}

// ─── 统一后端服务 ───
export interface IBackendService {
  auth: IAuthAdapter;
  db: IQueryBuilder;
  storage: IStorageAdapter;
  ai: IAIAdapter;
  /** 是否就绪 */
  isReady(): boolean;
  /** 初始化 */
  init(): Promise<void>;
}
```

### 现有代码改造示例

改造 `cloudbase.ts` 为 `backend.ts`（入口统一）：

```typescript
// src/services/backend.ts (改造后)

// 当前初始化
export async function initCloudBase(): Promise<cloudbase.app.App> { ... }

// 改造为
export async function initBackend(): Promise<IBackendService> {
  const adapter = new SupabaseAdapter(supabaseConfig); // 或 CloudBaseAdapter / FirebaseAdapter
  await adapter.init();
  return adapter;
}

// 旧 API 保留兼容别名（逐步替换）
export const getCloudBaseApp = () => backend.db;
export const isCloudBaseReady = () => backend.isReady();
```

---

## 9. 与云服务商的沟通要点

### 9.1 必问问题清单

与备选云服务商沟通时，请逐项确认以下问题：

| # | 问题 | 原因 |
|---|------|------|
| 1 | **是否支持浏览器端 JS SDK 直连数据库？** | 当前架构无中间服务器，所有数据库读写都在前端完成 |
| 2 | **是否支持匿名登录？** | 未注册用户需要能直接使用平台（查看游戏、游玩） |
| 3 | **匿名用户是否可以写入数据库？** | 这是 CloudBase 导致迁移的根本原因 — 匿名用户无法写入 |
| 4 | **安全规则/RLS 是否支持按用户身份控制读写？** | UGC 平台需要"所有用户可读，仅创建者/持有者可写"的精细权限 |
| 5 | **文档型数据库还是关系型数据库？** | 当前为 JSON 文档型，选择关系型需要数据建模转换 |
| 6 | **是否有 upsert（存在则更新/不存在则插入）操作？** | 当前代码大量依赖 upsert 语义 |
| 7 | **是否有写入重试机制或幂等保证？** | 我们的 writeQueue 已在客户端做了重试，但服务端幂等性能更好 |
| 8 | **文件存储是否支持按路径/前缀批量操作？** | 游戏文件按 `games/{gameId}/` 组织，需要前缀删除/列举 |
| 9 | **SDK 的 bundle 大小？** | 前端加载性能考虑，希望 SDK 尽量小（当前 @cloudbase/js-sdk 较大） |
| 10 | **是否有免费额度？** | MVP 阶段成本控制 |

### 9.2 Supabase 特有确认项

| # | 问题 |
|---|------|
| 1 | RLS 策略是否支持匿名用户的 INSERT？（类似需要） |
| 2 | Realtime 订阅机制能否用于 "xxx 发布了新游戏" 这类通知？ |
| 3 | 是否支持 wasm/edge functions 用于服务端逻辑？ |
| 4 | PostgreSQL 的 JSONB 索引性能如何？ |

### 9.3 Firebase 特有确认项

| # | 问题 |
|---|------|
| 1 | Firestore 安全规则是否支持 `request.auth != null` 的匿名用户？ |
| 2 | 国内 CDN 访问速度？ |
| 3 | Cloud Functions 冷启动时间？ |

### 9.4 Appwrite 特有确认项

| # | 问题 |
|---|------|
| 1 | 匿名用户的数据写入权限是否可以灵活配置？ |
| 2 | 自托管部署的复杂度？ |
| 3 | Realtime 能力是否成熟？ |

---

## 附录 A：现有环境变量

```
# .env
VITE_CLOUDBASE_ENV=allinonegaming-d4gmsmrzz573264f6
USE_MEMORY_DB=true
```

---

## 附录 B：SDK 包版本

```json
// package.json
"@cloudbase/js-sdk": "^2.25.7",      // 前端 SDK
"@cloudbase/node-sdk": "^3.18.1"     // 服务端 SDK（仅 db_init 脚本使用）
```

---

## 附录 C：迁移检查清单

迁移完成后逐项验证：

- [ ] 匿名用户访问主页 → 正常显示
- [ ] 匿名用户发布 UGC 游戏 → 游戏元数据写入云端
- [ ] 匿名用户上传游戏文件 → 文件上传到云存储
- [ ] 刷新页面 → 已发布游戏依然存在（云端数据）
- [ ] 注册邮箱用户 → 创建成功
- [ ] 邮箱用户登录 → 登录成功，匿名数据合并
- [ ] 道具铸造 → 凭证写入数据库
- [ ] 道具交易 → 市场挂牌正常
- [ ] AI 对话 → 道具工坊对话正常工作
- [ ] AI 分析 → 游戏代码分析正常工作
- [ ] 网络断开 → 写入队列自动重试，数据不丢失
- [ ] 刷新页面（有未完成写入）→ 队列恢复并继续处理

---

> **文档版本**: v1.0  
> **最后更新**: 2026-06-21  
> **目标读者**: AI 开发助手 + 云服务接入开发者  
> **补充说明**: 如需了解更详细的某个模块实现或在迁移过程中遇到问题，请参考此文档中标注的文件路径和行号，直接定位到源代码。
