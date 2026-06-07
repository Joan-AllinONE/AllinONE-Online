# AllinONE Gaming Platform — Sprint Backlog & Fix Plan

**日期**：2025-06-07
**基于**：全面技术债审计报告（tech-debt-full-audit-2025-06-07.md）
**规划人**：甄宇航（Zhen）· 工程督导
**数据来源**：Cody（代码审查）、Archi（架构）、Rex（SRE）、Tessa（测试）、Docu（文档）

---

## 📌 TL;DR

- **总 Sprint 数**：7 个 Sprint（14 周 / 3.5 个月）
- **覆盖债项**：50 项全覆盖
- **P0 阻断项**：Sprint 1-2 内全部解决（4 周）
- **上线就绪**：Sprint 2 完成时达到「有条件通过」评级
- **生产就绪**：Sprint 5 完成时达到「通过」评级（含测试安全网）

---

## 🎯 里程碑路线图

```
Sprint 1 (W1-2)    Sprint 2 (W3-4)    Sprint 3 (W5-6)    Sprint 4 (W7-8)
   🔒 安全加固         💾 数据可靠性       📊 可观测性         🏗️ 架构治理
   ─────────         ─────────         ─────────         ─────────
   JWT + CORS +       PG切换 + 竞态      pino + metrics     server拆分 +
   RateLimit +        修复 + 幂等性      + 健康检查         API版本化
   eval移除 +          + 加密哈希        + 性能优化         + 类型修复
   Express升级
       │                  │                  │                  │
       ▼                  ▼                  ▼                  ▼
   安全基线 ✅        数据安全 ✅        可发现性 ✅        可维护性 ✅

Sprint 5 (W9-10)   Sprint 6 (W11-12)  Sprint 7 (W13-14)
   🧪 测试安全网       📝 文档补全        🚀 生产加固
   ─────────         ─────────         ─────────
   vitest + P0测试    ADR + Runbook     Docker多阶段 +
   + CI流水线         + API文档         CDN分离 + 备份
       │                  │                  │
       ▼                  ▼                  ▼
   质量保障 ✅        知识传承 ✅        上线就绪 🚀
```

---

## 📋 Sprint 1: 安全加固（Week 1-2，10 工作日）

> **目标**：消除所有可被攻击者利用的安全漏洞，建立基本安全基线
> **出口标准**：攻击者无法冒充用户 / 兑换码无法被暴力枚举 / 无已知高危漏洞
> **覆盖债项**：#1, #2, #4, #5, #6, #8, #9, #10, #12, #33

---

### S1-1 🔴 实现 JWT 认证（替换 Mock）

**债项**：#6（Priority 30）| **估时**：2d | **P0**

**当前状态**：
```typescript
// server.js:59-73 — 任意 token 通过，始终回退到 userId='1'
function extractUserIdFromToken(token) {
  if (token.includes('user-')) { const match = token.match(/user-(\d+)/); if (match) return match[1]; }
  if (token.startsWith('nd_token_')) return '1';
  return '1'; // ← 任何 token 都返回 '1'
}
```

**修复方案**：

1. **安装依赖**：`pnpm add jsonwebtoken bcryptjs && pnpm add -D @types/jsonwebtoken @types/bcryptjs`
2. **新增 `src/server/auth/jwt.ts`**：
```typescript
import jwt from 'jsonwebtoken';
import { Request, Response, NextFunction } from 'express';

const JWT_SECRET = process.env.JWT_SECRET || (() => {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET must be set in production');
  }
  return 'dev-secret-do-not-use-in-prod';
})();

const TOKEN_EXPIRY = '24h';

export interface JwtPayload {
  userId: string;
  role?: string;
}

export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: TOKEN_EXPIRY });
}

export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, JWT_SECRET) as JwtPayload;
}

// 认证中间件 — 失败时阻断请求
export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'Missing or invalid authorization header' });
  }
  try {
    const payload = verifyToken(authHeader.slice(7));
    (req as any).userId = payload.userId;
    (req as any).userRole = payload.role;
    next();
  } catch (err) {
    return res.status(401).json({ success: false, error: 'Invalid or expired token' });
  }
}
```

3. **修改 `server.js`**：
   - 删除 `extractUserIdFromToken` 函数
   - 替换认证中间件为 `import { authMiddleware } from './src/server/auth/jwt.js'`
   - `app.use('/api/', authMiddleware)` 应用于所有 `/api/` 路径
4. **新增 `.env.example`** 条目：`JWT_SECRET=your-256-bit-secret-here`
5. **新增 `/api/auth/login`** 端点：验证用户凭据 → 返回 JWT token

**验收标准**：
- [ ] 无 token 请求 → 401 `{ success: false, error: "Missing or invalid authorization header" }`
- [ ] 伪造 token → 401
- [ ] 过期 token → 401
- [ ] 有效 token → 提取 userId，继续处理
- [ ] 所有现有 API 行为不变（token 格式更新后）

**文件变更清单**：
| 文件 | 操作 | 说明 |
|------|------|------|
| `src/server/auth/jwt.ts` | 新建 | JWT 签发/验证/中间件 |
| `server.js` | 修改 | 替换认证逻辑 |
| `package.json` | 修改 | 添加 jsonwebtoken, bcryptjs |
| `.env.example` | 修改 | 添加 JWT_SECRET |

---

### S1-2 🔴 配置 CORS 白名单

**债项**：#1（Priority 45）| **估时**：0.5d | **P0**

**当前状态**：`app.use(cors())` — 无任何 origin 限制

**修复方案**：
```javascript
// server.js — 替换 cors() 调用
const ALLOWED_ORIGINS = [
  process.env.CORS_ORIGIN || 'https://allinonegaming-d4gmsmrzz573264f6.ap-shanghai.app.tcloudbase.com',
  'http://localhost:5173',   // Vite dev server
  'http://localhost:3000',   // 本地 API 调试
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}));
```

**验收标准**：
- [ ] 白名单域名 → 正常响应（含 CORS 头）
- [ ] 非白名单域名 → CORS 错误
- [ ] `OPTIONS` 预检请求 → 200 with correct headers
- [ ] 本地开发 `localhost:5173` 正常工作

---

### S1-3 🔴 添加速率限制

**债项**：#4（Priority 40）| **估时**：0.5d | **P0**

**修复方案**：
```bash
pnpm add express-rate-limit
```

```javascript
// server.js
import rateLimit from 'express-rate-limit';

// 通用限制：100 req / 15min / IP
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests, please try again later' },
});

// 敏感端点限制：10 req / min / IP
const strictLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests on this endpoint' },
});

app.use('/api/', generalLimiter);
app.use('/api/redeem/verify', strictLimiter);
app.use('/api/redeem/use', strictLimiter);
```

**验收标准**：
- [ ] 正常使用不触发限制
- [ ] 第 11 次 `/api/redeem/verify` 请求（1 分钟内）→ 429
- [ ] 响应含 `RateLimit-*` 头

---

### S1-4 🔴 移除 eval() 代码执行

**债项**：#2（Priority 45）| **估时**：1d | **P0**

**当前状态**：`AlgorithmVoucherService.ts:701`
```typescript
new Function(`"use strict"; return (${expr});`)()
```

**修复方案**：替换为安全的数学表达式解析器。

```bash
pnpm add mathjs  # 或 expr-eval
```

```typescript
// AlgorithmVoucherService.ts — 替换 eval
import { evaluate } from 'mathjs'; // 沙箱化解析，无代码执行能力

function evaluateFormula(expr: string, variables: Record<string, number>): number {
  try {
    return evaluate(expr, variables);
  } catch (err) {
    throw new Error(`Formula evaluation failed: ${expr}`);
  }
}
```

**验收标准**：
- [ ] 正常公式 `"totalPower * 0.1 + 50"` → 正确数值
- [ ] 恶意公式 `"process.exit()"` → 抛出 Error，不执行
- [ ] 恶意公式 `"require('fs').unlinkSync('/')"` → 抛出 Error

---

### S1-5 🔴 升级 Express + 双锁文件修复

**债项**：#9（Priority 30）+ #12（Priority 25）| **估时**：0.5d | **P0**

**修复方案**：

1. **删除 npm lockfile，统一 pnpm**：
```bash
rm package-lock.json
# Dockerfile 已使用 pnpm，无需修改
```

2. **升级 Express**：
```bash
pnpm add express@^4.21.2
```

**验收标准**：
- [ ] `pnpm install --frozen-lockfile` 成功
- [ ] Docker 构建使用 `pnpm-lock.yaml`
- [ ] `npm audit` 无 critical/high

---

### S1-6 🟠 日志脱敏 + Helmet 安全头

**债项**：#10（Priority 25）+ #23（Priority 20）| **估时**：0.5d | **P0**

**修复方案**：

```bash
pnpm add helmet
```

```javascript
// server.js
import helmet from 'helmet';
app.use(helmet()); // X-Content-Type-Options, X-Frame-Options, CSP, HSTS 等

// 日志脱敏中间件
app.use((req, res, next) => {
  const authHeader = req.headers.authorization;
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} - Auth: ${authHeader ? '***' : 'Missing'}`);
  // 不再打印完整 token 或 userId
  next();
});
```

**验收标准**：
- [ ] 响应含 `X-Content-Type-Options: nosniff`
- [ ] 响应含 `X-Frame-Options: DENY`（或 SAMEORIGIN）
- [ ] 响应含 `Content-Security-Policy`
- [ ] 日志中无完整 token 或 userId 原文

---

### S1-7 🔴 修复 uncaughtException 处理

**债项**：#7（Priority 35）| **估时**：0.5d | **P0**

**当前状态**：
```javascript
process.on('uncaughtException', (err) => {
  console.error('❌ 未捕获的异常:', err);
  // 不退出 — 🔴 违反 Node.js 最佳实践
});
```

**修复方案**：
```javascript
let shuttingDown = false;

process.on('uncaughtException', async (err) => {
  console.error('❌ Uncaught exception — initiating graceful shutdown:', err);
  if (!shuttingDown) {
    shuttingDown = true;
    try {
      await pool?.end();
    } catch {}
    process.exit(1);
  }
});

process.on('unhandledRejection', (reason) => {
  console.error('❌ Unhandled rejection:', reason);
  // 不立即退出但记录，配合进程管理器自动重启策略
});
```

**验收标准**：
- [ ] `throw new Error('test')` 在路由中 → 进程退出码 1
- [ ] 退出前 `pool.end()` 被调用
- [ ] CloudRun 自动重启新实例

---

### S1-8 🔴 错误响应净化 + API Key 迁移

**债项**：#8（Priority 32）+ #24（Priority 20）| **估时**：1d | **P0**

**修复方案**：

1. **错误响应净化**（server.js）：
```javascript
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  const isProduction = process.env.NODE_ENV === 'production';
  res.status(500).json({
    success: false,
    error: isProduction ? 'Internal server error' : err.message,
    ...(isProduction ? {} : { stack: err.stack }),
  });
});
```

2. **API Key 迁移**（aiChatService.ts）：
```
当前：localStorage.setItem('ai_api_key', key)
改为：仅存 sessionStorage（页面关闭自动清除），或通过后端 /api/config/keys 端点代理
```

**验收标准**：
- [ ] 生产环境 500 响应不含 `error.message` 详情
- [ ] 生产环境 500 响应不含 stack trace
- [ ] API Key 不在 localStorage 持久化

---

### Sprint 1 总结

| 故事 | 估时 | 阻塞 |
|------|:--:|:--:|
| S1-1 JWT 认证 | 2d | — |
| S1-2 CORS 白名单 | 0.5d | — |
| S1-3 速率限制 | 0.5d | — |
| S1-4 移除 eval() | 1d | — |
| S1-5 Express 升级 + lockfile | 0.5d | — |
| S1-6 日志脱敏 + Helmet | 0.5d | — |
| S1-7 uncaughtException | 0.5d | — |
| S1-8 错误净化 + API Key | 1d | — |
| **Sprint 1 合计** | **6.5d** | **—** |

---

## 📋 Sprint 2: 数据可靠性（Week 3-4，10 工作日）

> **目标**：切换到 PostgreSQL 持久化，修复所有竞态条件和数据正确性缺陷
> **出口标准**：容器重启后数据不丢失 / 兑换码不可双花 / 支付不可超额消费
> **覆盖债项**：#3, #13, #14, #15, #16, #17, #18, #19, #20, #21, #25

---

### S2-1 🔴 切换到 PostgreSQL（移除内存数据库）

**债项**：#3（Priority 40）| **估时**：2d | **P0**

**当前状态**：
- `Dockerfile` L26: `ENV USE_MEMORY_DB=true`
- `cloudbase.json` L28: `"USE_MEMORY_DB": "true"`

**修复方案**：

1. **Dockerfile** — 修改 L26：
```dockerfile
# 改前：
ENV USE_MEMORY_DB=true
# 改后：
# USE_MEMORY_DB 默认为 false，生产环境使用 PostgreSQL
# 本地开发可通过 .env 设置 USE_MEMORY_DB=true 使用内存数据库
```

2. **cloudbase.json** — 删除 envParams 中的 `USE_MEMORY_DB` 或设为 `"false"`：
```json
{
  "envParams": {
    "USE_MEMORY_DB": "false"
  }
}
```

3. **server.js** — 添加 PostgreSQL 连接验证：
```javascript
// server.js — 启动时验证 PG 连接
if (!useMemoryDB) {
  try {
    const client = await pool.connect();
    await client.query('SELECT 1');
    client.release();
    console.log('✅ PostgreSQL connection verified');
  } catch (err) {
    console.error('❌ PostgreSQL connection failed:', err.message);
    process.exit(1); // 无法连接 PG 时不应启动
  }
}
```

4. **健康检查增强**：
```javascript
app.get('/api/health', async (req, res) => {
  let dbStatus = 'unknown';
  let dbLatency = null;
  if (pool) {
    try {
      const start = Date.now();
      await pool.query('SELECT 1');
      dbLatency = Date.now() - start;
      dbStatus = 'connected';
    } catch {
      dbStatus = 'error';
    }
  } else {
    dbStatus = 'memory';
  }
  res.json({
    status: dbStatus === 'connected' || dbStatus === 'memory' ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    database: dbStatus,
    ...(dbLatency !== null ? { dbLatencyMs: dbLatency } : {}),
  });
});
```

**验收标准**：
- [ ] 生产部署：`USE_MEMORY_DB` 为 false，使用 PostgreSQL
- [ ] 容器重启 → 数据保留
- [ ] PG 不可用时进程不启动（fail-fast）
- [ ] `/api/health` 返回 `dbLatencyMs`
- [ ] 缩放新实例 → 数据一致

---

### S2-2 🟠 修复兑换码竞态条件（双花防护）

**债项**：#13（Priority 24）| **估时**：1.5d | **P1**

**当前问题**：`verifyCode` 和 `useCode` 之间无原子性保证

**修复方案**：使用 PostgreSQL 行锁实现原子 check-and-use：

```sql
-- PostgreSQL: 原子兑换
WITH locked AS (
  SELECT * FROM redeem_codes 
  WHERE code = $1 
  FOR UPDATE  -- 行级锁，阻塞并发请求
)
UPDATE redeem_codes 
SET status = 'used', used_by = $2, used_at = NOW() 
FROM locked 
WHERE locked.code = $1 
  AND locked.status = 'active'  -- 仅 active 可兑换
  AND (locked.expires_at IS NULL OR locked.expires_at > NOW())
RETURNING *;
```

如果 `RETURNING` 为空 → 兑换码已被使用/过期/不存在。

**Memory DB 模式**（开发环境）使用简单的互斥锁：
```typescript
// src/server/memoryDatabase.ts
const redeemLocks = new Map<string, Promise<void>>();

async function atomicUseCode(code: string, userId: string) {
  // 确保同一兑换码的操作串行化
  while (redeemLocks.has(code)) {
    await redeemLocks.get(code);
  }
  let resolve: () => void;
  const lock = new Promise<void>(r => { resolve = r; });
  redeemLocks.set(code, lock);
  
  try {
    // 检查 + 更新（此时其他相同 code 的请求在等待）
    const entry = redeemCodes.find(c => c.code === code);
    if (!entry || entry.status !== 'active') return null;
    entry.status = 'used';
    entry.usedBy = userId;
    entry.usedAt = new Date().toISOString();
    return entry;
  } finally {
    redeemLocks.delete(code);
    resolve!();
  }
}
```

**验收标准**：
- [ ] 10 并发请求同一兑换码 → 仅 1 个成功，其余 9 个返回 "已使用"
- [ ] 单元测试覆盖竞态场景（如果有测试框架）

---

### S2-3 🟠 修复凭证支付竞态条件

**债项**：#14（Priority 16）| **估时**：1.5d | **P1**

**当前问题**：`payWithVoucher` 在查询余额和转账之间无锁保护

**修复方案**：
```typescript
// voucherPaymentService.ts
const paymentLocks = new Map<string, Promise<void>>();

async function payWithVoucher(userId: string, amount: number, vouchers: Voucher[]): Promise<PaymentResult> {
  // 用户级支付锁 — 同一用户并发支付串行化
  while (paymentLocks.has(userId)) {
    await paymentLocks.get(userId);
  }
  let resolve: () => void;
  const lock = new Promise<void>(r => { resolve = r; });
  paymentLocks.set(userId, lock);
  
  try {
    // 查询余额（此时无并发）
    const userVouchers = await voucherService.getUserVouchers(userId);
    // ... 贪婪匹配 + 转账逻辑
  } finally {
    paymentLocks.delete(userId);
    resolve!();
  }
}
```

**更优方案**：使用 PostgreSQL advisory lock：
```sql
-- 获取用户级排他锁
SELECT pg_advisory_xact_lock(hashtext('payment_' || $1));
-- 锁在事务结束时自动释放
```

**验收标准**：
- [ ] 同一用户 5 并发支付 → 余额正确扣减，无超额消费
- [ ] 单元测试覆盖：余额 100，5 并发支付 30 → 第 4 次支付失败（余额不足）

---

### S2-4 🟠 修复每日结算幂等性

**债项**：#15（Priority 24）| **估时**：1d | **P1**

**当前问题**：部分账户结算成功、部分失败时，批量保存导致已成功的回滚

**修复方案**：
```typescript
// gameDeveloperService.ts
async function executeDailySettlement(): Promise<SettlementResult> {
  const batchId = `settlement_${Date.now()}`;
  const results: AccountSettlement[] = [];
  
  for (const account of accounts) {
    if (!shouldSettle(account)) continue;
    
    try {
      // 每个账户独立结算 + 独立保存
      const result = await settleAccount(account, batchId);
      await saveAccount(result.updatedAccount); // 立即持久化
      results.push(result);
    } catch (err) {
      console.error(`Settlement failed for account ${account.id}:`, err);
      // 不影响其他账户，下次 checkAndSettle 重试
    }
  }
  
  return { batchId, settledCount: results.length, results };
}
```

**验收标准**：
- [ ] 账户 A 结算成功、B 失败 → A 数据已保存
- [ ] 同一天多次调用 `checkAndSettle` → 仅执行一次
- [ ] `platformOwed` 扣减与转账金额一致

---

### S2-5 🟠 替换非加密哈希 + Math.random()

**债项**：#20（Priority 24）+ #25（Priority 20）| **估时**：1d | **P1**

**修复方案**：

1. **交易哈希（VoucherService.ts:41-49）**：
```typescript
// 改前：djb2 变体（可伪造）
// 改后：使用 Web Crypto API
async function generateTxHash(data: string): Promise<string> {
  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(data));
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}
```

2. **UUID 生成（多处）**：
```typescript
// 改前：Math.random() — 碰撞概率不可忽略
// 改后：
function generateUUID(): string {
  return crypto.randomUUID(); // 全局可用（Node 19+, 浏览器）
}
```

**验收标准**：
- [ ] 交易哈希使用 SHA-256
- [ ] UUID 使用 `crypto.randomUUID()`
- [ ] 1M 次 UUID 生成无碰撞

---

### S2-6 🟠 pg Pool 生产配置 + Schema 迁移

**债项**：#18（Priority 24）| **估时**：1.5d | **P1**

**修复方案**：

1. **pg Pool 调优**：
```javascript
// server.js — Pool 配置
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,                       // 最大连接数
  connectionTimeoutMillis: 5000, // 获取连接超时
  idleTimeoutMillis: 30000,      // 空闲连接回收
  statement_timeout: 10000,      // 单语句超时 10s
});

pool.on('error', (err) => {
  console.error('Unexpected pool error:', err);
  // 不退出进程，Pool 会自动重建连接
});
```

2. **数据库迁移系统**：
```bash
pnpm add node-pg-migrate
```

```json
// package.json — 添加 scripts
{
  "db:migrate": "node-pg-migrate up",
  "db:rollback": "node-pg-migrate down"
}
```

```sql
-- migrations/001_initial_schema.sql
CREATE TABLE IF NOT EXISTS cross_game_inventory (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(255) NOT NULL,
  item_id VARCHAR(255) NOT NULL,
  game_id VARCHAR(255) NOT NULL,
  quantity INTEGER DEFAULT 1,
  obtained_at TIMESTAMP DEFAULT NOW(),
  sync_status VARCHAR(50) DEFAULT 'pending',
  UNIQUE(user_id, item_id, game_id)
);

-- ... (复用 server.js 中已有的 SQL schema)
```

**验收标准**：
- [ ] `pnpm db:migrate` 创建所有表
- [ ] Pool 配置生效（`SHOW max_connections` 验证）
- [ ] Pool error 事件有监听

---

### Sprint 2 总结

| 故事 | 估时 | 阻塞 |
|------|:--:|:--:|
| S2-1 PostgreSQL 切换 | 2d | — |
| S2-2 兑换码竞态修复 | 1.5d | — |
| S2-3 支付竞态修复 | 1.5d | — |
| S2-4 每日结算幂等修复 | 1d | — |
| S2-5 加密哈希 + UUID | 1d | — |
| S2-6 Pool 配置 + Migration | 1.5d | — |
| **Sprint 2 合计** | **8.5d** | **—** |

---

## 📋 Sprint 3: 可观测性 & 性能（Week 5-6，10 工作日）

> **目标**：建立完整的可观测性基线，修复关键性能瓶颈
> **出口标准**：运维可通过日志/指标发现故障 / N+1 查询消除
> **覆盖债项**：#21, #16, #17, #22, #39

---

### S3-1 🟡 结构化日志（pino）

**债项**：#21（Priority 21）| **估时**：1.5d | **P2**

```bash
pnpm add pino pino-pretty
```

```typescript
// src/server/logger.ts
import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: process.env.NODE_ENV !== 'production'
    ? { target: 'pino-pretty', options: { colorize: true } }
    : undefined,
  serializers: {
    req: (req) => ({ method: req.method, url: req.url }),
    res: (res) => ({ statusCode: res.statusCode }),
    err: pino.stdSerializers.err,
  },
});

// 请求日志中间件
export function requestLogger(req, res, next) {
  const start = Date.now();
  res.on('finish', () => {
    logger.info({
      method: req.method,
      url: req.originalUrl,
      statusCode: res.statusCode,
      duration: Date.now() - start,
      userId: (req as any).userId,
    }, 'request completed');
  });
  next();
}
```

**验收标准**：
- [ ] 每条日志含 `timestamp`, `level`, `requestId`, `userId`
- [ ] 生产环境 JSON 格式输出
- [ ] 开发环境 pino-pretty 彩色输出

---

### S3-2 🟡 Request ID 中间件

**债项**：#21（附加）| **估时**：0.5d | **P2**

```typescript
// src/server/requestId.ts
import { randomUUID } from 'crypto';
import { AsyncLocalStorage } from 'async_hooks';

const requestContext = new AsyncLocalStorage<{ requestId: string }>();

export function requestIdMiddleware(req, res, next) {
  const requestId = req.headers['x-request-id'] || randomUUID();
  res.setHeader('x-request-id', requestId);
  requestContext.run({ requestId }, () => next());
}
```

---

### S3-3 🟡 Prometheus Metrics

**债项**：#21（附加）| **估时**：1d | **P2**

```bash
pnpm add prom-client
```

```typescript
// src/server/metrics.ts
import { collectDefaultMetrics, Registry, Counter, Histogram } from 'prom-client';

const registry = new Registry();
collectDefaultMetrics({ register: registry });

export const httpRequestsTotal = new Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'path', 'status'],
  registers: [registry],
});

export const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration',
  labelNames: ['method', 'path'],
  registers: [registry],
});

// GET /metrics endpoint
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', registry.contentType);
  res.end(await registry.metrics());
});
```

**验收标准**：
- [ ] `GET /metrics` 返回 Prometheus 格式指标
- [ ] 含 `http_requests_total`, `http_request_duration_seconds`
- [ ] 含 Node.js 运行时指标（event loop lag, GC, heap）

---

### S3-4 🟡 修复 N+1 查询 + localStorage 序列化

**债项**：#16（Priority 24）+ #17（Priority 24）| **估时**：1.5d | **P2**

**N+1 修复**（server.js:380-418）：
```sql
-- 改前：每个道具独立 SELECT + INSERT/UPDATE（100道具 = 200次DB往返）
-- 改后：批量操作
-- 1. 批量 SELECT 现有记录
SELECT * FROM cross_game_inventory 
WHERE user_id = $1 AND item_id = ANY($2::text[]);

-- 2. 应用层合并后批量 UPSERT
INSERT INTO cross_game_inventory (user_id, item_id, game_id, quantity, sync_status)
SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::int[], $5::text[])
ON CONFLICT (user_id, item_id, game_id) 
DO UPDATE SET quantity = EXCLUDED.quantity, sync_status = EXCLUDED.sync_status;
```

**localStorage 优化**（VoucherDatabase.ts:96-100）：
```typescript
// 改前：每次写操作全量序列化
// 改后：引入脏标记 + 批量持久化
class VoucherDatabase {
  private dirty = false;
  private persistTimer: NodeJS.Timeout | null = null;
  
  private schedulePersist() {
    this.dirty = true;
    if (!this.persistTimer) {
      this.persistTimer = setTimeout(() => {
        this.persistVouchers();
        this.persistTimer = null;
      }, 500); // 500ms 内合并多次写入
    }
  }
}
```

**验收标准**：
- [ ] 批量同步 100 道具 → ≤ 3 次数据库往返
- [ ] localStorage 写入频率降低 ≥ 80%

---

### S3-5 🟢 启动优化（main.tsx 非阻塞）

**债项**：#43（Priority 20）| **估时**：0.5d | **P3**

```typescript
// main.tsx — 将同步阻塞改为异步
// 改前：
for (const game of publishedGames) {
  await gameDeveloperService.ensureAccount(game.id);
}
await gameDeveloperService.checkAndSettle();

// 改后：
ReactDOM.createRoot(document.getElementById('root')!).render(<App />);
// 后台异步执行
requestIdleCallback(async () => {
  for (const game of publishedGames) {
    await gameDeveloperService.ensureAccount(game.id);
  }
  await gameDeveloperService.checkAndSettle();
});
```

---

### Sprint 3 总结

| 故事 | 估时 |
|------|:--:|
| S3-1 结构化日志 | 1.5d |
| S3-2 Request ID | 0.5d |
| S3-3 Metrics | 1d |
| S3-4 N+1 + 序列化优化 | 1.5d |
| S3-5 启动优化 | 0.5d |
| **Sprint 3 合计** | **5d** |

---

## 📋 Sprint 4: 架构治理（Week 7-8，10 工作日）

> **目标**：拆分 server.js 单体、API 版本化、类型修复
> **出口标准**：新功能可在独立模块开发
> **覆盖债项**：#29, #11, #32, #33, #38, #41

---

### S4-1 🟡 server.js 模块化拆分

**债项**：#29（Priority 18）| **估时**：3d | **P2**

**目标结构**：
```
server.js                 → 仅入口：Express 初始化 + 中间件注册
src/server/
  app.ts                  → Express app 工厂
  routes/
    inventory.ts          → /api/v1/inventory/*
    redeem.ts             → /api/v1/redeem/*
    health.ts             → /api/health
  middleware/
    auth.ts               → JWT 认证中间件
    requestId.ts          → Request ID
    logger.ts             → 请求日志
    errorHandler.ts       → 全局错误处理
  db/
    pool.ts               → pg Pool 管理
    adapter.ts            → PostgreSQL / MemoryDB 统一接口
```

**拆分原则**：每个路由文件 ≤ 200 行，逻辑委托给 `src/services/`

**验收标准**：
- [ ] server.js ≤ 100 行（仅入口 + 启动逻辑）
- [ ] 每个路由文件独立 `express.Router()`
- [ ] 现有 API 行为完全不变

---

### S4-2 🟡 API 版本化 + 统一响应格式

**债项**：#11（Priority 25）+ #41（Priority 16）| **估时**：1.5d | **P2**

```typescript
// 统一响应 envelope
interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  meta?: {
    apiVersion: string;
    timestamp: string;
    requestId: string;
  };
}

// server.js — 路由挂载
app.use('/api/v1/inventory', inventoryRouter);
app.use('/api/v1/redeem', redeemRouter);

// 旧路径兼容 90 天（返回 deprecation warning header）
app.use('/api/inventory', (req, res, next) => {
  res.set('Deprecation', 'true');
  res.set('Sunset', 'Mon, 01 Sep 2026 00:00:00 GMT');
  next();
}, inventoryRouter);
```

**验收标准**：
- [ ] 所有新端点 `/api/v1/*`
- [ ] 所有响应含 `{ success, data/error, meta: { apiVersion } }`
- [ ] 旧路径 `/api/*` 仍可用但返回 Deprecation header

---

### S4-3 🟡 TypeScript any 清理 + Stub 服务修复

**债项**：#32（Priority 12）+ #33（Priority 12）| **估时**：2d | **P2**

**修复清单**：

| 文件 | 问题 | 修复 |
|------|------|------|
| `database.ts:1` | `type Achievement = any` | 定义 `Achievement` 接口 |
| `gameActivityService.ts:2-5` | `type GameActivityData = any` | 定义 `GameActivityData` 接口 |
| `cleanupDuplicateTransactions.ts:2` | `walletService` stub 永远返回 [] | 接入真实 `WalletSkill` |
| `platformManagementService.ts:12` | `testDataService` stub | 接入 `platformConfigService` |
| `friendService.ts` | 全 mock 数据 | 标注 `// MOCK` 或接入真实后端 |

**验收标准**：
- [ ] `database.ts` 中 0 处 `any` 类型
- [ ] Stub 服务有明确的 `// TODO: Implement real backend` 注释
- [ ] TypeScript strict mode 新增类型错误 ≤ 50 个

---

### S4-4 🟢 服务间依赖整理

**债项**：#39（Priority 12）| **估时**：1d | **P3**

```typescript
// 提取共享常量到独立模块
// src/constants.ts
export const PLATFORM_POOL_ID = 'platform_pool';
export const SYSTEM_USER_ID = 'system';

// voucherPaymentService.ts — 改前
// const platformPoolId = 'platform_pool'; // 硬编码
// 改后：
import { PLATFORM_POOL_ID } from '@/constants';
```

---

### Sprint 4 总结

| 故事 | 估时 |
|------|:--:|
| S4-1 server.js 拆分 | 3d |
| S4-2 API 版本化 | 1.5d |
| S4-3 TypeScript + Stub 修复 | 2d |
| S4-4 依赖整理 | 1d |
| **Sprint 4 合计** | **7.5d** |

---

## 📋 Sprint 5: 测试安全网（Week 9-10，10 工作日）

> **目标**：建立测试基础设施 + 覆盖 P0 核心资金路径
> **出口标准**：CI 运行测试 / 资金路径覆盖率 ≥ 30%
> **覆盖债项**：#50（结构性测试债，Tessa Phase 0-1）

---

### S5-1 🔴 测试基础设施搭建

**债项**：#50 | **估时**：1d | **P0**

```bash
pnpm add -D vitest @vitest/coverage-v8 @vitest/ui jsdom
```

```typescript
// vitest.config.ts
import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      thresholds: {
        lines: 65,
        functions: 60,
        branches: 60,
        statements: 65,
      },
    },
  },
});
```

```json
// package.json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage"
  }
}
```

---

### S5-2 🟠 P0 核心测试（Tessa Phase 1）

| 故事 | 模块 | 估时 | 用例数 |
|------|------|:--:|:--:|
| S5-2a | VoucherService.transferVoucher | 1.5d | 8 |
| S5-2b | WalletSkill spend/recharge | 1d | 7 |
| S5-2c | voucherPaymentService.payWithVoucher | 2d | 8 |
| S5-2d | marketplaceService.purchase | 2d | 10 |
| S5-2e | redeemCodeService.verifyCode + useCode | 1d | 10 |
| S5-2f | platformTreasuryService | 1d | 6 |

测试用例大纲详见 Tessa 报告中 4.1-4.3 节。

---

### S5-3 CI 测试流水线

```yaml
# .github/workflows/test.yml
name: Test Suite
on:
  pull_request:
    branches: [main]
  push:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - uses: pnpm/action-setup@v2
      - run: pnpm install --frozen-lockfile
      - run: pnpm test -- --coverage
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: coverage
          path: coverage/
```

---

### Sprint 5 总结

| 故事 | 估时 |
|------|:--:|
| S5-1 测试基础设施 | 1d |
| S5-2 P0 核心测试 | 8.5d |
| S5-3 CI 流水线 | 0.5d |
| **Sprint 5 合计** | **10d** |

---

## 📋 Sprint 6: 文档补全（Week 11-12，10 工作日）

> **目标**：建立 ADR、Runbook、API 文档
> **出口标准**：新成员可通过文档理解系统 / 故障有文档化处理流程
> **覆盖债项**：#26, #30, #35, #36, 文档债 33 项

---

### S6-1 📝 架构决策记录（5 条 ADR）

| ADR | 决策 | 估时 |
|-----|------|:--:|
| ADR-001 | 为什么选择 PostgreSQL + localStorage 混合存储 | 0.5d |
| ADR-002 | 为什么使用 JWT 而非 Session/Cookie 认证 | 0.5d |
| ADR-003 | 为什么单体架构而非微服务（当前阶段） | 0.5d |
| ADR-004 | 凭证系统的复式记账模型设计 | 0.5d |
| ADR-005 | 兑换码原子化方案选择（PG row lock vs Redis） | 0.5d |

---

### S6-2 📝 Runbook（3 本）

| Runbook | 内容 | 估时 |
|---------|------|:--:|
| 数据恢复 Runbook | PostgreSQL 备份恢复、内存数据库数据抢救 | 1d |
| 兑换码紧急吊销 Runbook | 发现被枚举后的紧急响应步骤 | 0.5d |
| CloudRun 实例故障 Runbook | 实例不健康诊断、手动介入、回滚 | 0.5d |

---

### S6-3 📝 API 文档 + README 更新

**债项**：#36 | **估时**：2.5d

- 使用 OpenAPI 3.0 规范生成 `docs/api.md`
- 更新 README 核心模块说明与代码同步
- 更新 `.env.example` 补全所有环境变量

---

### Sprint 6 总结

| 故事 | 估时 |
|------|:--:|
| S6-1 ADR × 5 | 2.5d |
| S6-2 Runbook × 3 | 2d |
| S6-3 API 文档 + README | 2.5d |
| **Sprint 6 合计** | **7d** |

---

## 📋 Sprint 7: 生产加固（Week 13-14，10 工作日）

> **目标**：Docker 多阶段构建、CDN 分离、数据库备份、优雅关闭
> **出口标准**：生产部署零停机 / 镜像体积优化 / 备份自动化
> **覆盖债项**：#19, #27, #37, #42, #48, #49

---

### S7-1 🟠 Docker 多阶段构建

**债项**：#19（Priority 24）| **估时**：1.5d

```dockerfile
# Stage 1: Build frontend
FROM node:20-slim AS builder
WORKDIR /app
COPY pnpm-lock.yaml ./
RUN npm install -g pnpm
RUN pnpm fetch --prod
COPY . .
RUN pnpm install --offline --prod
RUN pnpm build:client

# Stage 2: Production
FROM node:20-slim
WORKDIR /app
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nodejs
COPY --from=builder /app/dist/static ./dist/static
COPY --from=builder /app/server.js ./
COPY --from=builder /app/node_modules ./node_modules
USER nodejs
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/api/health', r => process.exit(r.statusCode === 200 ? 0 : 1))"
CMD ["node", "server.js"]
```

---

### S7-2 🟡 静态资源 CDN 分离

**债项**：#37（Priority 16）| **估时**：1d

```bash
# CloudBase 静态托管部署
tcb hosting deploy dist/static -e allinonegaming-d4gmsmrzz573264f6
```

- server.js 中移除 `express.static` 和 SPA fallback
- CloudRun 仅运行 API
- 前端路由由 CloudBase 静态托管处理

---

### S7-3 🟠 优雅关闭完善

**债项**：#27（Priority 20）| **估时**：0.5d

```javascript
// server.js
const GRACEFUL_TIMEOUT = 10000; // 10s

process.on('SIGTERM', async () => {
  console.log('SIGTERM received — shutting down gracefully');
  
  // 1. 停止接受新请求
  server.close();
  
  // 2. 等待现有请求完成（最多 10s）
  const shutdownTimer = setTimeout(() => {
    console.error('Forced shutdown after timeout');
    process.exit(1);
  }, GRACEFUL_TIMEOUT);
  
  // 3. 关闭数据库连接
  try {
    await pool.end();
    console.log('DB pool closed');
  } catch (err) {
    console.error('Error closing pool:', err);
  }
  
  clearTimeout(shutdownTimer);
  process.exit(0);
});
```

---

### S7-4 🟢 数据库备份策略

**债项**：#42（附加）| **估时**：0.5d

```yaml
# CloudBase 云函数 — 每日备份
# 或在 CloudBase 控制台配置自动备份策略
# 保留 7 天，每日 03:00 UTC 执行
```

---

### Sprint 7 总结

| 故事 | 估时 |
|------|:--:|
| S7-1 Docker 多阶段 | 1.5d |
| S7-2 CDN 分离 | 1d |
| S7-3 优雅关闭 | 0.5d |
| S7-4 备份策略 | 0.5d |
| **Sprint 7 合计** | **3.5d** |

---

## ✅ 全局行动清单（Top 20 按优先级）

| # | 行动 | Sprint | 负责 | 紧急度 |
|---|------|:------:|------|:------:|
| 1 | 配置 CORS 白名单 | S1 | 后端 | P0 |
| 2 | 移除 eval() 代码执行 | S1 | 后端 | P0 |
| 3 | 切换到 PostgreSQL | S2 | 后端/SRE | P0 |
| 4 | 添加速率限制 | S1 | 后端 | P0 |
| 5 | 认证中间件阻断未认证请求 | S1 | 后端 | P0 |
| 6 | 实现 JWT 认证 | S1 | 后端 | P0 |
| 7 | 修复 uncaughtException | S1 | 后端 | P0 |
| 8 | API Key 迁移出 localStorage | S1 | 前端/后端 | P0 |
| 9 | 升级 Express | S1 | 后端 | P0 |
| 10 | 日志 PII 脱敏 + Helmet | S1 | 后端 | P0 |
| 11 | 修复兑换码竞态条件 | S2 | 后端 | P1 |
| 12 | 修复支付竞态条件 | S2 | 后端 | P1 |
| 13 | 修复每日结算幂等性 | S2 | 后端 | P1 |
| 14 | 替换非加密哈希 + crypto UUID | S2 | 后端 | P1 |
| 15 | 结构化日志 + Metrics | S3 | 后端/SRE | P2 |
| 16 | 修复 N+1 查询 | S3 | 后端 | P2 |
| 17 | server.js 模块化拆分 | S4 | 后端 | P2 |
| 18 | 搭建测试基础设施 | S5 | QA | P0 |
| 19 | Docker 多阶段构建 | S7 | SRE | P1 |
| 20 | 编写 Runbook × 3 | S6 | Doc | P2 |

---

## 📊 投入产出预估

| 阶段 | Sprint | 工作日 | 累计覆盖率 | 风险降幅 | 评级 |
|------|:------:|:------:|:----------:|:--------:|:----:|
| 基准 | — | 0 | 0% | 0% | 🔴 1.6/5 |
| 安全加固 | S1 | 6.5d | — | -60% | 🔴 → 🟠 |
| 数据可靠性 | S2 | 8.5d | — | -25% | 🟠 → 🟡 |
| 可观测性 | S3 | 5d | — | -5% | 🟡 |
| 架构治理 | S4 | 7.5d | — | -5% | 🟡 → 🟢 |
| 测试安全网 | S5 | 10d | 30%+ | -5% | 🟢 |
| 文档补全 | S6 | 7d | — | — | 🟢 |
| 生产加固 | S7 | 3.5d | — | — | 🟢 ✅ |
| **合计** | **S1-S7** | **~48d** | **30-65%** | **~100%** | **🟢 3.8/5** |

---

## ⚠️ 风险与依赖

1. **JWT 认证 vs 现有前端**：前端需同步更新 token 传递方式（`Authorization: Bearer <jwt>`）
2. **PostgreSQL 连接限制**：CloudBase PostgreSQL 免费版可能有连接数上限，需验证
3. **localStorage 数据迁移**：现有测试用户的 localStorage 数据迁移到 PG 路径未设计
4. **server.js 拆分**：需与 S1 JWT 认证改造协调，避免合并冲突（建议先 S1 认证上线 → 再 S4 拆分）
5. **测试框架**：localStorage 依赖的服务需 jsdom 环境
6. **人力假设**：以上估时基于 1 名全栈开发 + 1 名兼职 SRE，可并行化压缩

---

> 本 Sprint Backlog 由甄宇航（Zhen）· 工程督导基于 5 位成员（Cody/Archi/Rex/Tessa/Docu）的审计报告编制。所有修复方案均来源于对应成员的专业建议，主理人仅做编排与可执行化转换。
