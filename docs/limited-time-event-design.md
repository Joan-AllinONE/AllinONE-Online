# 限时活动（Limited-Time Event）设计文档

> 版本：v1.0（2026-10-15）· 状态：设计评审中
> 参考：Rollercoin Freon Event（资源收集型）、Grand Building（分阶段大型活动）
> 核心思路：**时间窗口 + 功能开关 + 状态机**，活动上下线与周期复用均为配置变更，**不重新部署代码**。

---

## 0. 与现有活动中心的关系

现有 `src/activity/`（签到/任务/成就/抽奖/邀请/排行）是**常驻活动**：静态定义 + localStorage 进度 + best-effort 领奖上报，无生命周期。

限时活动是新增的**有生命周期**子系统，复用现有资产：

| 复用点 | 说明 |
|---|---|
| `activity.ts` 路由 | 扩展为限时活动 API 的挂载点（`/api/v1/activities/...`） |
| memoryDatabase 模式 | 活动表/参与表/奖励发放表进内存库（云函数侧镜像实现，沿用「双实现」铁律） |
| 合约引擎 tick 模式 | server.js 已有 60s 自调 `__contract/tick` 的先例，限时活动状态机复用同一调度器 |
| 规则中心 contract_rules | 平台级参数（每日提交上限等）走 `getPlatformRule()`，不硬编码 |
| 隧道模式 | 写操作全部走云函数/gamesApi（writeQueue 禁用于共享写，铁律不变） |

---

## 1. 总体架构：时间窗口 + 功能开关 + 状态机

### 1.1 状态机

```
  draft ──(到达 start_time - lead_hours，或运营手动)──▶ scheduled ──(到达 start_time)──▶ live
                                                            │                        │
   archived ◀──(结算完成+归档保留期)── settled ◀──(到达 end_time)── closing ◀───────┘
                                  ▲                         │
                                  └──(紧急下线 force_stop)────┘
```

五个用户可见/系统状态（`status` 字段）：

| 状态 | 用户可见性 | 后端行为 |
|---|---|---|
| `draft` 草稿 | 不可见 | 仅运营后台可见，可任意编辑 |
| `scheduled` 预热 | **入口可见但置灰**，展示倒计时/预告（Grand Building 建造预览） | 校验 `start_time` 前拒绝一切参与调用；预加载信号已下发（前端可 prefetch 活动模块） |
| `live` 开放 | 完全开放：入口、玩法、提交、领奖 | 所有参与 API 校验 `now ∈ [start_time, end_time)`；资源掉落开关（Freon 模式）开启；tick 监控 |
| `closing` 关闭中 | 入口显示「已结束，结算中」，禁止新提交，已达成未领取的奖励**仍可领取**（grace 窗口，如 72h） | 停止计分；结算任务跑排行榜/达标判定；防新写入 |
| `settled`/`archived` 结算/归档 | 历史活动页可查结果；入口消失 | 奖励已固化发放（幂等表保证不重不发）；数据归档；周期活动生成下一期实例 |

### 1.2 三要素分工

- **时间窗口**（`start_time`/`end_time`/周期规则）：由**后端**判定，前端展示只用后端返回的 `serverNow` + 状态，前端时钟仅作倒计时渲染。
- **功能开关**（`enabled`/`force_stop`/灰度）：运营后台实时改配置，`/activities/current` 即时反映，无需发版。
- **状态机**：由定时任务 + 到达时间边界驱动迁移；**状态迁移是幂等的**（tick 重放不产生副作用），且任何 API 都以 `窗口校验 ∩ 状态校验 ∩ 开关校验` 三重与门放行。

---

## 2. 数据模型

### 2.1 表设计（内存库 Map / 云数据库集合，字段与未来 PostgreSQL DDL 一致）

**activities（活动表）**

```ts
interface LimitedEventDef {
  id: string;                 // evt_<slug>_<seq>，周期活动每期独立 id（evt_freon_2026w42）
  slug: string;               // 活动系列标识，周期活动不变（如 'freon'），用于模块映射与归档聚合
  name: string;
  type: 'collect' | 'staged' | 'game';   // Freon 收集型 / Grand Building 分阶段型 / 小游戏型
  status: 'draft' | 'scheduled' | 'live' | 'closing' | 'settled' | 'archived';
  enabled: boolean;           // 总开关（运营可秒级 false）
  forceStopAt?: number;       // 紧急下线时间戳（审计）
  startTime: number;          // epoch ms，统一 UTC 存储
  endTime: number;
  leadHours: number;          // 预热提前量（draft→scheduled）
  graceHours: number;         // closing 期间补领窗口
  repeat?: {                  // 周期活动；一次性活动省略
    unit: 'weekly' | 'biweekly' | 'monthly';
    count?: number;           // 总期数，缺省无限
  };
  config: Record<string, any>;  // 类型相关玩法配置 JSON（见 2.3）
  ruleKeys?: string[];          // 依赖的平台规则键（接 contract_rules）
  rewardRules: RewardRule[];    // 见下
  createdAt: number;
  updatedAt: number;
  createdBy?: string;
}
```

**event_stages（活动阶段表，仅 staged 类型）**

```ts
interface EventStage {
  id: string;                 // stg_<eventId>_<n>
  eventId: string;
  index: number;              // 阶段序号 1..N
  name: string;               // 「地基」「一层」…（Grand Building 建造进度）
  startTime: number;          // 阶段切片由后端从活动窗口推导+运营微调
  endTime: number;
  goal: { metric: string; target: number };  // 全服进度目标（如全服累计 Freon × 10000）
  rewards: RewardRule[];      // 阶段达标奖励（全服型/个人贡献型）
}
```

**event_rewards（奖励规则，内嵌于活动/阶段，同时发放记录独立成表）**

```ts
interface RewardRule {
  id: string;                 // rw_<eventId>_<seq>
  kind: 'threshold' | 'leaderboard' | 'participation' | 'per_unit';
  metric: string;             // 'freon' | 'score' | 'stage_contrib' ...
  threshold?: number;         // threshold 型达标线
  rankRange?: [number, number]; // 排行榜型名次区间
  reward: { currency: 'gamecoin' | 'coin' | 'voucher'; amount: number; itemId?: string };
}
```

**event_participations（用户参与记录表）**

```ts
interface EventParticipation {
  id: string;                 // <eventId>:<userId>  ← 天然幂等键
  eventId: string;
  userId: string;
  joinedAt: number;
  metrics: Record<string, number>;   // { freon: 320, score: 12500 }
  submissions: number;               // 提交次数（限流/防刷依据）
  stageContrib: Record<string, number>;  // stageId → 本阶段贡献
  lastSubmitAt: number;
}
```

**event_grants（奖励发放表 —— 发放幂等的唯一事实）**

```ts
interface EventGrant {
  id: string;                 // grant_<eventId>_<userId>_<rewardId>  ← 幂等键
  eventId: string; userId: string; rewardId: string;
  amount: number; grantedAt: number;
  source: 'self_claim' | 'settle_job';
}
```

**event_stage_progress（全服阶段进度，staged 型）**：`{ stageId, metric, current, completedAt? }`

### 2.2 周期活动支持

- `repeat` 定义在**系列配置**上；每期是独立的 activity 记录（独立 id、独立参与/发放数据），**绝不做跨期复用行**——天然避免幂等与归档混乱。
- 生成机制：tick 检测到 `repeat` 活动进入 `closing` 且尚未有下一期实例 → 用系列模板 `cloneNextOccurrence()` 生成 `draft → scheduled` 的新记录（时间按 unit 平移，配置快照拷贝）。
- 归档聚合查询按 `slug` 分组展示「往期回顾」。

### 2.3 分阶段活动支持（Grand Building 模式）

- `config.stages` 与 stages 表配合：前端「建造进度」= `event_stage_progress.current / goal.target`，阶段切换由 tick 在阶段边界执行（开启下一阶段的掉落/子活动、关闭上一阶段）。
- 阶段奖励结算：阶段 endTime 到达即结算该阶段（不必等活动整体结束），tick 幂等处理。

### 2.4 资源收集型支持（Freon 模式）

- `config.dropChannels`: `{ channel: 'game_play' | 'item_harvest' | 'quest' | 'checkin', rate: number, dailyCap: number }`。
- 实现：在既有 `__item/mint`、GameQuest 发奖、ITEM_HARVEST 掉落等服务端处理点中，加入**统一的时间窗口判断钩子** `activeEventDropHook(channel, userId)`（在 `src/activity/server/dropHook.ts`），命中活跃活动则额外记 `event_participations.metrics`。前端零改动即可看到活动资源掉落。

---

## 3. 后端实现

### 3.1 技术栈映射

本项目**无 Redis / 无独立定时服务**，映射如下（设计对标准栈同样成立，附注迁移路径）：

| 通用方案 | 本项目落地 |
|---|---|
| Redis 缓存活跃活动 | 进程内 `ActiveEventCache`（60s TTL，tick 时主动刷新）；云函数冷启动时从 DB 重读 |
| 定时任务 cron | server.js 复用合约 60s tick 调度器，追加 `eventTick()`；云函数侧由前端 `GET /current` 请求触发的惰性 tick + 定期自调兜底（与合约引擎同模式） |
| 分布式锁 | 单实例内存库无此问题；未来 PostgreSQL/多实例时用 `UPDATE ... WHERE version=n` CAS（合约引擎已用同模式） |

### 3.2 状态机 tick（核心迁移函数）

```ts
// src/server/eventEngine.ts（纯函数，便于单测 + 云函数复用源）
export function computeNextStatus(e: LimitedEventDef, now: number): LimitedEventDef['status'] | null {
  if (!e.enabled || e.forceStopAt) return e.status === 'settled' ? null : 'closing';
  switch (e.status) {
    case 'draft':     return now >= e.startTime - e.leadHours * 3600e3 ? 'scheduled' : null;
    case 'scheduled': return now >= e.startTime ? 'live' : null;
    case 'live':      return now >= e.endTime ? 'closing' : null;
    case 'closing':   return now >= e.endTime + e.graceHours * 3600e3 ? 'settled' : null;
    default:          return null;  // settled 归档由清理任务处理
  }
}
```

- tick 每 60s 扫 `status NOT IN (settled, archived) AND startTime <= now + 7d` 的记录（**避免全表扫**，长期归档不进扫描集）。
- 状态迁移与「迁移时的动作」分离：`onTransition(e, from, to)` 负责开启掉落、生成下一期、触发结算，全部幂等（先查 `event_grants` / 期号存在性再写）。

### 3.3 三重校验中间件（防绕过前端）

所有参与类接口过同一守卫，**前端隐藏永远不是安全边界**：

```ts
function requireEventWindow(eventId: string, phase: 'live' | 'live-or-closing') {
  // 1. 从 ActiveEventCache 取活动（缓存 miss 回源 DB）
  // 2. enabled && !forceStopAt
  // 3. status 属于放行相位（领奖接口放行 closing）
  // 4. now ∈ [startTime, endTime + grace)  —— 即使 status 字段被误改，时间窗口仍硬校验
  // 5. 周期活动校验「本期」id，非 slug（防止旧期数据写入新期）
}
```

失败统一 `403 { code: 'EVENT_NOT_ACTIVE', expectedPhase, serverNow, startTime, endTime }` —— 前端用该 payload 渲染「未开始/已结束」状态。

### 3.4 关键接口设计

统一挂 `/api/v1/activities`（本地 Express + 云函数 `__event` 双实现，沿现有隧道与 Bearer JWT 鉴权）：

| 接口 | 方法 | 鉴权 | 说明 |
|---|---|---|---|
| `/current` | GET | 无 | 返回活跃+预热活动摘要（含 `serverNow`、状态、倒计时、模块清单 `moduleIds` 供前端动态 import、预加载信号）；CDN/浏览器可缓存 ≤30s |
| `/:id/detail` | GET | 无 | 活动详情+阶段+全服进度（staged 建造进度） |
| `/:id/join` | POST | Bearer | 进入活动；幂等 `eventId:userId`；窗口校验；返回个人参与档案 |
| `/:id/submit` | POST | Bearer | 提交成绩/资源：`{ metric, value, proof? }`；窗口校验；限流（每日次数走 `getPlatformRule('event.submit_daily_limit')`）；增量或绝对值由 `config.submitMode` 决定 |
| `/:id/progress` | GET | Bearer | 个人 metrics/阶段贡献/可领奖励列表 |
| `/:id/claim` | POST | Bearer | 领奖：body `{ rewardId }`；`live|closing` 放行；**幂等键 `grant_<eventId>_<userId>_<rewardId>`**，先 insert 后发奖（DB 唯一约束兜底重复）；达标签发服务端重算，不信客户端 |
| `/:id/leaderboard` | GET | 无 | 榜单快照（closing 期固化为 settle 产物） |
| `__event/admin/*` | POST | 运营鉴权 | CRUD 活动配置、force_stop、手动重结算（复用 `__contract/admin` 的 env 鉴权模式） |

### 3.5 幂等 / 并发 / 结算一致性

- **参与幂等**：`join`/`submit` 均以 `(eventId, userId)` 为主键 upsert；submit 用 `lastSubmitAt` + 增量 CAS（`WHERE metrics->'freon' = $old`）防并发覆盖，本项目内存库单线程天然串行，云函数侧沿用合约引擎的 CAS 版式。
- **发奖幂等**：`event_grants.id` 唯一键 → `doc(id).set()` / INSERT 冲突即判「已发放」直接返回成功（对客户端幂等友好）。钱包入账复用现有 `wallet.spend`/入账幂等模式（`grant_` 前缀即幂等键）。
- **结算一致性**：closing→settled 由 tick 驱动 `settleEvent(eventId)`：重算所有 threshold/leaderboard/participation 奖 → 批量生成 grants（逐条幂等）→ 写 `settleManifest`（哈希链，复用 game_revenue_sharing_history 模式）→ 才置 `settled`。tick 崩溃重跑安全：manifest 已存在的 grant 跳过。
- **周期换期**：新一期生成是独立事务（新 doc），旧期数据不被触碰。

---

## 4. 前端实现

### 4.1 动态导入（按需加载，核心）

活动模块独立目录、独立 chunk：

```
src/activity/events/<slug>/        # 每个活动系列一个目录
  freon/
    index.tsx                      # 默认导出 React.lazy 可用的组件工厂
    FreonBoard.tsx / freon.css
  grand-building/
    index.tsx / BuildingView.tsx
src/activity/events/registry.ts    # slug → () => import('./freon/index.tsx')
```

```ts
// registry.ts —— 静态映射表本身 <1KB，随主包；模块体不进主包
export const EVENT_MODULES: Record<string, () => Promise<any>> = {
  freon: () => import('./freon'),
  'grand-building': () => import('./grand-building'),
};
```

加载流程：

1. `useCurrentEvents()` 轮询 `GET /current`（30s，进入活动页时立即刷新）。
2. 只有当响应中活动 `status ∈ {scheduled, live}` 时，才执行 `EVENT_MODULES[slug]()` 触发 Vite 代码分割产物的按需下载；`draft/closing/settled` 永不 import。
3. `scheduled` 状态用 `requestIdleCallback` **预加载**（倒计时页 prefetch 模块与资源图），到点秒开。
4. React 边界：`<Suspense fallback={<EventSkeleton/>}>` + ErrorBoundary——活动模块崩溃不影响平台主功能。

### 4.2 入口条件渲染与路由守卫

- 活动中心新增「限时活动」Tab + 首页 Banner 入口：仅当 `/current` 返回非空时渲染，未开启时 DOM 中不存在入口（而非 `display:none`）。
- 路由 `/activity/event/:slug` 守卫：无活跃活动 → 渲染「活动未开始/已结束」占位页（含下期开始倒计时，数据来自后端 `expectedPhase/startTime`），**不加载活动模块**。
- 深链分享：`scheduled` 期访问展示预告页 + 「开始提醒我」（localStorage 标记 + 到点红点，复用 `ActivityRedDot`）。

### 4.3 未开始 / 已结束展示

| 状态 | 展示 |
|---|---|
| scheduled | 置灰入口 + 倒计时（用后端 `serverNow` 校准本地时钟偏移：`offset = serverNow - Date.now()`，所有倒计时加 offset） |
| live | 正常玩法 |
| closing | 「已结束·结算中」+ 可领奖励提示（grace 补领） |
| settled/archived | 历史活动页只读结果（按 slug 聚合往期） |

性能预算：主包不新增任何活动模块代码（守卫验证：对照 dist chunk 清单，`freon-*.js` 等必须是独立 chunk 且不被 index 预引用）。

---

## 5. 功能开关与运营后台

### 5.1 配置即数据

活动定义是 DB 记录而非代码：运营后台（PlatformAdmin 现有页签扩展「限时活动」）通过 `__event/admin/*` 增删改查，**改时间/奖励/开关 = 改一行数据**，前端 `/current` 30s 内收敛。

### 5.2 时间窗口筛选器

后台列表内置筛选：`全部 / 进行中 / 预热中 / 已结束 / 已归档 / 周期系列`，+ 时间轴可视化展示各活动窗口重叠（避免运营误设两个同时段收集型活动互相稀释掉落率）。

### 5.3 灰度发布

`config.rollout: { mode: 'percent' | 'whitelist', percent?: number, whitelist?: string[] }`（复用私域合约 whitelist 的成熟模式）：

- `/current` 与 `requireEventWindow` 均判定灰度：percent 用 `hash(userId) % 100 < percent` 确定性分桶（同一用户结果稳定，避免刷新忽隐忽现）；
- 新活动首日 `percent: 10` 观察 → 全量；
- 灰度外用户看到「即将上线」预告而非报错。

### 5.4 紧急下线

`force_stop`：一键 `enabled=false` 或 forceStopAt=now → 下一次 `/current`（≤30s）入口消失、参与 API 三重校验拒绝；已产生的参与数据保留，奖励按「按实际达成结算」走正常 closing 流程，不丢用户数据。全过程后台操作日志留痕。

---

## 6. 安全与边界

1. **后端强制校验**：所有窗口/状态/开关判定在服务端（3.3 三重校验）；前端仅负责展示。直接 curl 参与接口在窗口外必 403。
2. **时区与时钟**：全部时间字段 UTC epoch ms 存储；前端渲染才转本地时区；倒计时以 `serverNow` 偏移校准；**绝不信任客户端时间戳**（submit 的 `at` 仅作展示，计分以服务端接收时间窗内为准）。
3. **限流**：submit 每日次数上限走规则中心（`event.submit_daily_limit`，可运营热调）；单用户 `submissions` 计数在参与档案中，超限 429。
4. **防刷防作弊**：submit 的 value 服务端合理性校验（`config.maxValuePerSubmit`、与游戏时长/道具获取速率的交叉校验，复用 ITEM_HARVEST 的 channelToken 灰度体系）；小游戏型活动要求携带游戏侧签名回执（PROTOCOL:INIT 通道下发 token，同凭证防刷 S1 模式）。
5. **发奖幂等**：见 3.5；claim 重放/双击/多端并发全部收敛到 `event_grants` 唯一键。
6. **数据归档**：settled + 保留期（默认 90 天）→ tick 移入归档集合（内存库：从主 Map 移入 `archivedEvents`，persist 快照分开）；排行榜快照随归档固化。归档数据永不参与 tick 扫描。
7. **日志与监控**：状态迁移、force_stop、发奖失败、submit 限流命中全部结构化日志（`[event]` 前缀，与现有 logger 一致）；异常迁移（如 tick 连续失败）告警。

---

## 7. 测试与运维

### 7.1 测试矩阵

| 层 | 内容 |
|---|---|
| 单元测试（vitest） | `computeNextStatus` 全迁移路径 × enabled/forceStop/周期边界；`cloneNextOccurrence` 期号计算跨月/跨年；奖励重算纯函数；灰度分桶稳定性 |
| 集成/冒烟（cjs 脚本，复用现有 smoke 模式） | 起内存 server：创建活动 → 时钟推进（mock now）→ scheduled→live→submit→claim→closing→settle→归档全链路；幂等重放（重复 claim/重复 settle）；窗口外 submit 403；紧急下线；周期活动第二期生成 |
| E2E（agent-browser，发布前） | 前台倒计时渲染、活动模块按需加载（Network 面板验证非活跃期零下载）、grace 期补领 |
| 守卫 | `check-contracts-isolation.cjs` 追加：EVENT_MODULES 主包零引用检测、活动模块禁止 import 平台内部写通道 |

### 7.2 监控告警

- 指标：活跃活动数、submit QPS、claim 失败率、tick 耗时、settle 积压数。
- 告警线：tick 连续 3 次失败；活动 `live` 但 `/current` 5 分钟无返回；发奖失败 > 0（发奖失败必须人工介入，不静默）。

### 7.3 回滚方案

- 配置回滚：`enabled=false` 即等效下线，无代码回滚需求——这是本设计的核心收益。
- 代码回滚：活动模块是独立 chunk，回滚主包不影响已结束活动数据；`registry` 中删除条目即彻底摘除入口。
- 结算错误：`__event/admin/resettle` 手动重结算（幂等，只会补发漏发，不会重复发放——由 grants 表保证）。

### 7.4 活动结束后的数据生命周期

```
live 数据（participations/grants） ──90天保留──▶ 归档集合 ──按 slug 聚合统计──▶ 永久保留结果摘要，明细可清理
```

周期换期不迁移旧数据，每期天然隔离；归档按 `slug` 聚合出「往期活动效果报表」（参与人数、发放总量、峰值日活）供运营决策下期排期。

---

## 8. 实施排期建议（4 批次）

| 批次 | 内容 | 验证 |
|---|---|---|
| E1 | 数据模型 + eventEngine 纯函数 + tick 接线 + `/current` + 三重校验中间件（本地双实现） | 单测 + 冒烟全链路 |
| E2 | join/submit/claim/progress 接口 + event_grants 幂等 + Freon dropHook 接入 `__item` 等掉落点 | 冒烟 + 防刷交叉校验 |
| E3 | 前端 registry/动态导入/倒计时校准/入口与路由守卫 + 一个示例活动（freon） | E2E + chunk 独立性守卫 |
| E4 | 运营后台（CRUD/筛选/灰度/紧急下线）+ staged 阶段引擎 + 归档任务 + grand-building 模板 | 全量回归 + 上线（tcb fn deploy + hosting deploy） |

## 附：与本项目铁律的对照清单

- 写通道只走 Express/云函数（`__event`），❌ writeQueue；❌ 前端自签写库
- 云函数实现与本地 `src/server` 保持同构（改动跑 `node --check cloudfunctions/gamesApi/index.js`）
- Express `req.params` 归一化 `String(x||'')`；`req.body` 用 `const body:any`
- 早调用 401 坑：所有新增前端 fetch 走 `backendSync.authHeaders` 或先 `await getToken()`
- 平台参数不硬编码，全部进规则中心（4 份副本对齐）
