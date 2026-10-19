# ACR — AllinONE Contract Reference（合约模板协议规范）

> 版本：ACR-1/2/3（CW-0，2026-10-11）
> 对标以太坊 ERC：把合约引擎的隐式约定提炼为公开、可版本化、机器可校验的模板创作协议。
> 本文档同时供 **AI 生成（prompt 注入）** 与 **人类创作者** 使用，是合约工坊的唯一权威规范。

## 0. 定位

- 合约引擎（`src/contracts/engine/`）是图灵不完备的安全解释器：DSL 表达式有 maxTokens/maxDepth/maxSteps 资源上限（天然 gas 机制）、Effect 白名单 14 种、状态机迁移表封闭。
- **模板即合约源代码**：`ContractTemplate` JSON（paramsSchema + clauses DSL）就是"Solidity 源码"，官方三模板（group-buy / team-quest / gso）只是该格式的 3 份纯数据。
- 创作产物必须通过 `validateTemplate`（结构校验）+ `lintUgcTemplate`（本规范 ACR 安全 Lint）才能进入 UGC 注册中心。

## 1. ACR-1 核心标准（必选）

### 1.1 元数据契约

```ts
{
  key: string;          // 必须匹配 /^ugc_[a-z0-9][a-z0-9_-]{2,60}$/；服务端注册时强制 ugc_<authorId>_<slug>
  family: 'teamup' | 'community_revenue';
  version: number;      // ≥1 整数；升级 = version+1 新条目（存量实例按冻结 clauses 继续跑）
  title: string;
  riskLevel: 'low' | 'medium' | 'high';
  requiresAudit: boolean;
}
```

- 不得使用官方保留键：`gso` / `team-quest` / `group-buy`。
- `initialState` 不得为终局状态（fulfilled / refunded / terminated）。

### 1.2 规模上限（防状态膨胀 / DoS）

| 上限 | 值 |
|---|---|
| 条款数 | ≤ 50 |
| 单条款 Effect 数 | ≤ 12 |
| updates 字段深度 | ≤ 3（如 `a.b.c`） |
| 模板序列化体积 | ≤ 256 KB |

### 1.3 触发器约束

- `cron.schedule` 白名单：`deadline-check` / `tick-5m`。**`settlement-weekly/monthly` 为 GSO 平台特权**（绑定收益台账注入），UGC 禁用。
- `manual.action` 不得使用隧道保留字：`__protocol` / `deploy` / `sign` / `invoke` / `tick` / `query` / `detail` / `verify` / `escrow`。
- 事件/协议触发器必须声明 `match`；协议触发器建议 `requiresChannelToken: true`（事实源防伪）。

## 2. ACR-2 资金安全标准（涉钱模板必选）

### 2.1 灰名单 Effect（平台特权，UGC 一律禁用）

| Effect | 状态 | 说明 |
|---|---|---|
| `mintVoucher` | ❌ 禁用 | 凭证铸造 = 平台货币主权 |
| `mintShareVouchers` | ❌ 禁用 | GSO 专用（按认购表逐人铸 RSV） |
| `grantGovernanceWeight` | ❌ 禁用 | 治理权重 = 平台主权 |
| `treasuryDeposit` | ❌ 禁用 | 直入平台金库（走市场佣金路径） |

### 2.2 受控 Effect

- `penalize`：目标 **只允许 `expr: event.userId`**（当事人本人），且模板必须 `requiresAudit: true`。

### 2.3 资金守恒（出账收款方封闭）

出账（`fromUserId` 缺省或 `'escrow'`，即从托管释放）时 `toUserId` 合法面：

1. `'expr: event.userId'` —— 事件当事人（退款给本人）
2. `'expr: params.<field>'` —— 且该字段已在 `paramsSchema` 中以 `string`/`enum` 类型声明

**禁止**：
- 硬编码字面量收款人（作者把自己的 ID 写死在条款里）
- 引用未声明的 params 字段
- `splitPayout` 带 `source: 'treasury'`（花平台金库的钱）

入托管（`toUserId: 'escrow'`）时 `fromUserId` 同理封闭：只允许扣 `event.userId` 或声明字段的钱。

### 2.4 退款可达性

资金可进托管（存在 `walletTransfer toUserId:'escrow'` 条款）的模板，必须存在至少一个出口条款：

- `refundAll`（批量退款），或
- 出账 `walletTransfer`（toUserId ≠ escrow），或
- `splitPayout`（source ≠ treasury），或
- `penalize`（罚没进金库）

否则 lint 报错：**钱进托管必须有出口**。

## 3. ACR-3 治理接口标准

- `governanceTopics` / `grantGovernanceWeight` / settlement 系列 cron 均为平台特权面，UGC 模板不可触达。
- 游戏方出让治理权走 GSO 官方模板（合规前置 + 人工审核）。

## 4. 风险分级（决定审核路径）

| 级别 | 判定 | 审核路径 |
|---|---|---|
| low | effectsWhitelist ⊆ {setState, notify, openDispute} | 自动通过 |
| medium | 含 walletTransfer/splitPayout/refundAll 且通过守恒 lint | 规则引擎自动审 + 抽样人工 |
| high | 含 penalize/freezeVoucher/unfreezeVoucher/transferVoucher，或 family=community_revenue | 必须人工审核 |

实现：`classifyTemplateRisk(tpl)`（`src/contracts/acr/acrLinter.ts`）。

## 5. 防篡改链（TOCTOU）

- 提交注册时：服务端计算模板 `codeHash`（`computeCodeHash`）固化进审核记录。
- 审核时：审核记录快照 codeHash。
- 部署时：重算 codeHash 与审核记录比对，不一致拒绝（防"审核后偷偷改模板"）。

## 6. 影子模式观察期（开闸流程）

新 UGC 模板首次部署强制 `autoExecute=false`（影子模式）：引擎照常产出 EffectPlan，runtime 只记录不执行资金。

- 作者可在 admin/overview 观察影子计划与预期对账。
- 连续 N 个 plan 一致后，平台管理员可对模板 key 开启 `CONTRACT_AUTO_EXECUTE` 真执行（灰度顺序：低风险 → 中风险 → 高风险）。

## 7. 快速上手（给创作者的最小示例）

一个"到期自动退款"的最小合规模板：

```json
{
  "key": "ugc_demo_escrow_refund",
  "family": "teamup",
  "version": 1,
  "title": "到期退款演示",
  "riskLevel": "medium",
  "requiresAudit": false,
  "initialState": "signing",
  "effectsWhitelist": ["walletTransfer", "refundAll", "setState", "notify"],
  "paramsSchema": {
    "payeeId": { "type": "string", "required": true },
    "amount": { "type": "number", "required": true, "min": 1 },
    "deadline": { "type": "number", "required": true }
  },
  "clauses": [
    {
      "id": "c-join",
      "title": "缴款进托管",
      "on": { "id": "t-join", "kind": "manual", "action": "join", "enabledStates": ["signing"] },
      "when": "now <= params.deadline",
      "then": [
        {
          "type": "walletTransfer",
          "toUserId": "escrow",
          "fromUserId": "expr: event.userId",
          "currency": "gameCoins",
          "amount": "expr: params.amount",
          "reason": "缴款"
        }
      ],
      "updates": [{ "field": "count", "op": "add", "value": 1 }]
    },
    {
      "id": "c-refund",
      "title": "到期退款",
      "on": { "id": "t-refund", "kind": "cron", "schedule": "deadline-check", "enabledStates": ["signing"] },
      "when": "now > params.deadline",
      "then": [
        { "type": "refundAll", "reason": "到期全额退款" },
        { "type": "setState", "to": "refunded", "reason": "终局" }
      ]
    }
  ]
}
```

## 8. DSL 速查

- 数值/字符串字段可用 `'expr: <DSL>'` 动态求值；坏表达式部署时 lint fail-fast。
- 变量域：`now` / `state.<field>` / `params.<field>` / `event.<field>`。
- `+1 约定`：同触发内 updates 在全部条款评估后才应用，条件写 `state.X + 1 >=`。
- 状态机：draft → signing → funded → active → settling → fulfilled / refunded / breached / disputed / terminated（迁移表见 `engine/validate.ts STATE_TRANSITIONS`）。
