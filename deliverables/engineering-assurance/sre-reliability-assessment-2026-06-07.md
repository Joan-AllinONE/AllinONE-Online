
# AllinONE Gaming Platform — 主动事故响应评估报告（SRE 视角）

**评估人**: Rex (SRE Engineer)  
**评估日期**: 2026-06-07  
**目标环境**: 腾讯云 CloudBase CloudRun (0.5 CPU / 1GB, min 1 / max 10)  
**关键发现**: 整体可靠性评分 **3.5 / 10**，存在多项高危风险需立即处理。

---

## 一、可观测性评估

| 维度 | 状态 | 评分 | 说明 |
|------|------|------|------|
| 健康检查端点 | ✅ 存在 | 5/10 | `/api/health` 仅返回静态状态信息，不探测 PostgreSQL 真实连通性（当 pool 存在时仅返回 "connected" 字符串，实际未执行 ping） |
| 结构化日志 | ❌ 缺失 | 1/10 | 全部使用 `console.log` / `console.error`。无结构化字段（JSON）、无日志级别、无 trace/correlation ID、无时间戳格式统一 |
| Metrics 暴露 | ❌ 缺失 | 0/10 | 无 Prometheus endpoint、无 Node.js 运行时指标（event loop lag、GC、heap）、无业务指标（请求量、延迟、错误率） |
| 告警配置 | ❌ 缺失 | 0/10 | 无任何告警规则、无 CloudBase 云监控配置、无 Dead Man's Switch |
| 请求追踪 | ❌ 缺失 | 0/10 | 无 request-id 注入、无分布式追踪（OpenTelemetry/Jaeger） |

**关键代码证据**（server.js L44-57）：
```js
app.use((req, res, next) => {
  console.log(`[${req.method}] ${req.path} - Auth:`, authHeader ? 'Present' : 'Missing');
  // 无 timestamp，无 requestId，无结构化字段
```

**改进建议**:
1. 引入 `pino` 或 `winston` 进行结构化日志，每条日志包含 `timestamp`、`level`、`requestId`、`userId`
2. 添加 `/metrics` endpoint（使用 `prom-client`）
3. 健康检查在 PostgreSQL 模式下应执行 `pool.query('SELECT 1')` 并返回延迟
4. 配置 CloudBase 云监控告警：5xx 错误率 > 5%、P95 延迟 > 2s、实例 CPU > 80%

---

## 二、容错与弹性评估

| 维度 | 状态 | 评分 | 说明 |
|------|------|------|------|
| 数据库回退 | ⚠️ 高风险 | 2/10 | **生产环境强制使用内存数据库** — Dockerfile L26 和 cloudbase.json L28 均硬编码 `USE_MEMORY_DB=true` |
| pg Pool 配置 | ⚠️ 使用默认值 | 4/10 | 无 connectionTimeoutMillis、无 statement_timeout、无 idleTimeoutMillis 调优、无 max 连接数限制（默认 10） |
| 优雅关闭 | ⚠️ 部分实现 | 4/10 | SIGINT/SIGTERM 已处理，但 `pool.end()` 是 async 未 await 完成即 `process.exit(0)`；未先 `server.close()` 停止接受新请求 |
| 未捕获异常 | 🔴 高危 | 1/10 | `uncaughtException` 仅 log 不退出 — Node.js 官方文档明确建议**记录后必须退出**，进程可能处于损坏状态 |
| 请求超时 | ❌ 缺失 | 0/10 | Express 无默认超时，CloudRun 侧可能有网关超时但应用层无保护 |
| 限流 | ❌ 缺失 | 0/10 | 无 rate limiting，`/api/redeem/verify` 和 `/api/redeem/use` 可被暴力枚举 |
| 熔断 | ❌ 缺失 | 0/10 | PostgreSQL 故障时无自动降级，无 circuit breaker |

### 🔴 最严重风险: 生产环境使用内存数据库

**证据链**:
- `Dockerfile L26`: `ENV USE_MEMORY_DB=true`
- `cloudbase.json L28`: `"USE_MEMORY_DB": "true"`
- `memoryDatabase.ts L96`: 数据存储在 `private inventory: InventoryItem[] = []`
- 重启/扩容/缩容 → **所有数据永久丢失**

**影响**: 所有用户库存、兑换码、同步状态在容器重启后全部丢失。每次 CloudRun 缩容至 0 或滚动更新都会清空数据。

### uncaughtException 不退出风险（server.js L771-778）:
```js
process.on('uncaughtException', (err) => {
  console.error('❌ 未捕获的异常:', err);
  // 不退出进程，保持服务器运行  ← 🔴 违反 Node.js 最佳实践
});
```

---

## 三、部署可靠性评估

| 维度 | 状态 | 评分 | 说明 |
|------|------|------|------|
| Dockerfile 最佳实践 | ⚠️ 部分达标 | 4/10 | `node:20-slim` 选型OK；但无多阶段构建、无 USER、无 HEALTHCHECK、构建后未清理 devDependencies（pnpm prune --prod 缺失） |
| 镜像安全 | ⚠️ 有风险 | 3/10 | `COPY . .` 可能包含 `.env`、`.git` 等敏感文件（实际 .dockerignore 已排除 `.git` 但未排除 `.env*`） |
| CloudBase 扩容策略 | ⚠️ 基础配置 | 5/10 | min 1 / max 10 配置合理，但缺少 CPU/Memory 阈值触发的自动扩缩规则细节 |
| 蓝绿/金丝雀部署 | ❌ 缺失 | 0/10 | 无任何渐进式部署策略 |
| 回滚方案 | ❌ 缺失 | 0/10 | 无文档化回滚流程，CloudRun 需手动操作 |
| CI/CD | ⚠️ 仅 GitHub Pages | 3/10 | 仅 `deploy.yml` 部署静态前端到 GitHub Pages；CloudBase 部署无 CI pipeline |

**Dockerfile 审查具体问题**:
```
# 问题1: 无多阶段构建 — 构建依赖和运行时依赖混在一起
# 问题2: 构建后未执行 pnpm prune --prod，node_modules 含 devDependencies
# 问题3: 以 root 运行 — 无 USER node
# 问题4: 无 HEALTHCHECK 指令
# 问题5: COPY . . 前未验证 .env 文件不会进入镜像
```

---

## 四、安全运维评估

| 维度 | 状态 | 评分 | 说明 |
|------|------|------|------|
| CORS 配置 | 🔴 高危 | 1/10 | `app.use(cors())` 无参数 → 允许**所有来源**跨域访问 |
| 密钥管理 | 🔴 高危 | 2/10 | `cloudbase.json` 含明文 envId；多个文件硬编码 envId；认证为 mock 实现（`extractUserIdFromToken` 始终返回 '1'） |
| 依赖安全 | ⚠️ 缺失 | 2/10 | 无 `npm audit` 集成、无 Dependabot/Snyk、无定期依赖扫描 |
| HTTPS/TLS | ✅ 由平台处理 | 6/10 | CloudBase CloudRun 提供 TLS 终止，应用层无需额外配置 |
| 认证 | 🔴 模拟 | 1/10 | `extractUserIdFromToken` 是 mock 实现，`nd_token_*` 格式直接返回默认 userId='1' |
| 敏感信息泄露 | ⚠️ 有风险 | 3/10 | `console.error` 可能泄露栈轨迹给客户端（server.js L569-571 在响应中暴露 error.message） |

### CORS 配置漏洞:
```js
app.use(cors());  // 允许所有来源！应改为:
app.use(cors({ origin: process.env.CORS_ORIGIN || 'https://allinonegaming-d4gmsmrzz573264f6.ap-shanghai.app.tcloudbase.com' }));
```

### 密钥泄露路径:
1. `cloudbase.json L2`: `"envId": "allinonegaming-d4gmsmrzz573264f6"` — 提交在 Git 中
2. `.env.example L2`: 同样包含 envId
3. `db_init/init.cjs L16`: `'allinonegaming-d4gmsmrzz573264f6'` 硬编码
4. `db_init/probe.cjs L7`: 同上

---

## 五、整体风险矩阵（按严重度排序）

### 🔴 严重 (SEV1 — 应立即修复)

| # | 风险项 | Impact | Risk | Effort | SEV 建议 |
|---|--------|--------|------|--------|----------|
| 1 | 生产环境使用内存数据库导致数据永久丢失 | 10 | 10 | 3 | SEV1 |
| 2 | 认证系统为 mock 实现，无实际鉴权 | 10 | 9 | 5 | SEV1 |
| 3 | `uncaughtException` 不退出导致进程处于损坏状态 | 9 | 7 | 1 | SEV1 |
| 4 | CORS 允许所有来源 | 8 | 9 | 1 | SEV1 |

### 🟠 高危 (SEV2 — 1-2 周内修复)

| # | 风险项 | Impact | Risk | Effort | SEV 建议 |
|---|--------|--------|------|--------|----------|
| 5 | 无请求超时控制，可能导致连接池耗尽 | 7 | 7 | 2 | SEV2 |
| 6 | 无限流保护，兑换码 API 可被暴力枚举 | 7 | 8 | 2 | SEV2 |
| 7 | PostgreSQL Pool 使用默认配置，无超时/重试策略 | 6 | 6 | 2 | SEV2 |
| 8 | 优雅关闭不完整（未 await pool.end, 未 server.close） | 5 | 6 | 2 | SEV2 |
| 9 | Docker 镜像以 root 运行 | 6 | 5 | 1 | SEV2 |

### 🟡 中危 (SEV3 — 1 月内修复)

| # | 风险项 | Impact | Risk | Effort | SEV 建议 |
|---|--------|--------|------|--------|----------|
| 10 | 无可观测性（metrics, structured logs, alerting） | 6 | 8 | 5 | SEV3 |
| 11 | 依赖无安全扫描 | 5 | 7 | 3 | SEV3 |
| 12 | Dockerfile 无 HEALTHCHECK | 4 | 5 | 1 | SEV3 |
| 13 | 敏感信息 (envId) 多处硬编码 | 4 | 6 | 2 | SEV3 |
| 14 | 错误详情泄露给客户端（error.message in response） | 4 | 5 | 1 | SEV3 |

### 🟢 低危 (SEV4)

| # | 风险项 | Impact | Risk | Effort | SEV 建议 |
|---|--------|--------|------|--------|----------|
| 15 | 无回滚方案文档 | 3 | 5 | 3 | SEV4 |
| 16 | 无蓝绿/金丝雀部署 | 2 | 4 | 5 | SEV4 |
| 17 | .dockerignore 未排除 .env* 文件 | 3 | 4 | 1 | SEV4 |

---

## 六、假设事故场景分析

### 场景 1: CloudRun 扩容/更新导致全量数据丢失

**SEV 评级**: SEV1  
**触发条件**: CloudRun 执行滚动更新或缩容→扩容（新增实例启动时内存为空）  
**影响范围**: 所有用户 — 库存数据、兑换码、同步状态全部丢失  
**检测方式**: 
- 用户在 `/api/inventory` 返回空列表（无报错，静默丢失）
- 兑换码验证全部返回 "兑换码不存在"
- 无告警（当前无监控）
- 健康检查仍返回 "ok"（不会检测数据完整性）

**时间线**:
```
T+0     CloudBase 触发滚动更新
T+30s   新实例启动，内存数据库为空
T+31s   旧实例终止，所有内存数据不可逆丢失
T+32s   用户开始发现数据丢失
T+???   无监控手段，团队靠用户报告才发现
```

**恢复步骤**:
1. ⚠️ **当前架构下无恢复可能** — 内存数据库无持久化机制
2. 长期方案：切换到 PostgreSQL + 定期备份
3. 短期缓解：设置 `minNum > 1` 降低单点风险（但无法解决滚动更新问题）

---

### 场景 2: 兑换码 API 被暴力枚举

**SEV 评级**: SEV2  
**触发条件**: 攻击者对 `/api/redeem/verify` 发起高速请求枚举有效兑换码  
**影响范围**: 所有已存兑换码可能被盗用  
**检测方式**:
- `/api/redeem/verify` 请求量异常激增
- 多个 `verifyCount` 递增的兑换码
- 当前无任何检测手段

**时间线**:
```
T+0     攻击者开始枚举 (10,000 req/s)
T+30s   服务器 CPU 飙升至 100%
T+60s   合法请求开始超时
T+5min  所有已发布兑换码被扫出
T+10min 攻击者开始批量 useCode 核销
T+???   游戏方反馈用户兑换码无法使用
```

**恢复步骤**:
1. 紧急添加限流 — 对 `/api/redeem/verify` IP/API-key 级别限制 10 req/min
2. 吊销被枚举的兑换码批次
3. 部署 `express-rate-limit` 中间件
4. 对 verify 端点添加验证码或 proof-of-work
5. 添加异常检测告警

---

### 场景 3: PostgreSQL 连接池耗尽

**SEV 评级**: SEV2  
**触发条件**: 高并发下慢查询占据所有连接（Pool 默认 max=10），新请求无法获取连接  
**影响范围**: 所有需要数据库的操作挂起或超时  
**检测方式**: 
- 日志中出现连接超时（但当前无结构化日志不易发现）
- `/api/inventory` 和 `/api/inventory/sync` 长时间无响应
- 健康检查可能仍返回 "ok"（不检查连接池状态）

**时间线**:
```
T+0     同步请求批量到达，每个 sync 操作使用 client = await pool.connect()
T+2s    连接池中 10 个连接全部被占用
T+5s    新请求 await pool.connect() 阻塞（默认无超时）
T+30s   Express 无默认超时 → 请求堆积
T+60s   内存中堆积的请求导致 OOM
T+???   CloudRun 健康检查可能通过（取决于配置），实例不会自动重启
```

**恢复步骤**:
1. 临时: 重启 CloudRun 实例释放连接
2. 配置 `statement_timeout` 为 10s
3. 配置 `connectionTimeoutMillis` 为 5000ms
4. 为 `/api/inventory/sync` 添加请求队列/背压机制
5. 添加 `pool.on('error')` 事件监听
6. 增加连接数 max 至 20（需评估 CloudBase PostgreSQL 连接限制）

---

## 七、部署前检查清单

### 必需（阻塞部署）

- [ ] **数据库切换**: 将 `USE_MEMORY_DB` 从 `true` 改为 `false`，确保 PostgreSQL 连接可用
- [ ] **数据库初始化**: 确保 `cross_game_inventory` 和 `user_inventory_summary` 表已创建
- [ ] **CORS 限制**: 配置 `cors({ origin: <具体域名> })`，禁止 `*`
- [ ] **认证实现**: 替换 mock 认证为真实 JWT/OAuth 实现
- [ ] **uncaughtException 修复**: 日志记录后 `process.exit(1)`，配合进程管理器自动重启
- [ ] **请求超时**: 添加 `server.setTimeout(30000)` 或使用 `express-timeout` 中间件
- [ ] **限流**: 对 `/api/redeem/verify` 和 `/api/redeem/use` 添加 rate limiting
- [ ] **密钥外部化**: 从代码中移除所有硬编码 envId，改用环境变量
- [ ] **.env 文件排除**: `.dockerignore` 添加 `.env*`，`.gitignore` 确认 `.env` 已排除

### 推荐（首周部署）

- [ ] **Dockerfile 加固**: 添加 `USER node`, `HEALTHCHECK`, `pnpm prune --prod`
- [ ] **优雅关闭完善**: `server.close()` + `await pool.end()` + 超时强制退出
- [ ] **pg Pool 配置**: `connectionTimeoutMillis`, `statement_timeout`, `idleTimeoutMillis`
- [ ] **健康检查增强**: `/api/health` 在 PG 模式下执行 `SELECT 1`
- [ ] **错误响应净化**: 生产环境不向客户端暴露 `error.message` 详情
- [ ] **依赖扫描**: 添加 `npm audit` 到 CI pipeline

### 后续迭代

- [ ] 结构化日志 (pino/winston) + request-id 中间件
- [ ] Prometheus metrics endpoint + CloudBase 云监控告警
- [ ] 蓝绿部署 / 灰度发布策略
- [ ] 回滚 Runbook 编写
- [ ] 数据库备份策略（每日自动备份 + 保留 7 天）
- [ ] 混沌工程测试（随机杀实例验证恢复能力）

---

## 八、关键 Runbook 条目建议

1. **数据丢失恢复 Runbook** — 从 PostgreSQL 备份恢复 inventory 数据（SEV1 场景1）
2. **兑换码批量吊销 Runbook** — 发现被枚举后紧急失效兑换码（SEV2 场景2）
3. **数据库连接池耗尽 Runbook** — 诊断和恢复步骤（SEV2 场景3）
4. **CloudRun 实例故障 Runbook** — 实例不健康时的手动介入步骤
5. **回滚 Runbook** — CloudRun 版本回滚操作步骤 + 数据一致性验证
6. **OOM Kill 处理 Runbook** — 内存超限时的诊断和扩容指南
7. **SSL 证书过期 Runbook** — CloudBase 域名证书管理
8. **限流触发后用户沟通 Runbook** — 被限流用户的通知模板和申诉流程

---

## 九、总结

| 类别 | 评分 |
|------|------|
| **整体可靠性** | **3.5 / 10** |
| 可观测性 | 1.2 / 10 |
| 容错与弹性 | 2.2 / 10 |
| 部署可靠性 | 3.0 / 10 |
| 安全运维 | 2.8 / 10 |

**核心结论**: 该系统当前**不适合生产环境上线**。最致命的问题是生产环境使用内存数据库（所有数据在重启时永久丢失）和 mock 认证系统（无实际安全保护）。建议在上线前至少完成 SEV1 级别的 4 项修复。
