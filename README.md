# AllinONE 平台网站

AllinONE 是集游戏开发、道具交易与社区激励于一体的开放式游戏平台，致力于打造“共建、共享、共治，互通、互惠、互利”的 Play2Earn 游戏经济生态。

AllinONE 是一个面向游戏与社区生态的综合平台，提供平台管理、资金池结算、钱包与币种体系、市场与商店、游戏中心、社区奖励等模块。项目采用 React + Vite + TypeScript 构建，支持快速开发与跨平台构建。

## 公司与品牌

- 品牌名：AllinONE
- 品牌定位：将平台治理、虚拟经济与玩家生态整合在同一产品中，兼顾效率与透明度
- 设计风格：现代、暗色主题友好、强调数据展示与交互反馈

## 网站功能总览

- 平台管理系统
  - 平台数据仪表盘（关键指标、趋势）
  - 参数管理（通过投票调整平台参数）
  - 投票决策（提交/投票/否决/生效）
  - 成员管理（角色与权限模拟）
  - 绩效管理（分红权重计算与现金分红执行，含幂等与去重保护）
- 资金池与经济系统
  - 收入/支出、类别与货币维度统计
  - 净收入与总价值计算（现金、游戏币、算力、A币、O币）
  - A币/O币分发与分红（模拟），并记录到资金池与钱包
- 钱包系统
  - 支持现金、游戏币、算力、A币、O币五种资产
  - 交易记录与统计（今日/周/月/累计）
  - 货币兑换（含汇率）、期权解禁事件驱动刷新
  - 幂等保护：同一分红周期的现金分红仅入账一次
- 市场与商店
  - 官方商店购买流程与佣金记录
  - 交易市场模拟（玩家间交易）
- 游戏与社区
  - 游戏中心与个人中心（资产概览、交易记录）
  - 社区奖励（A币/O币奖励与分红演示）
- 其他演示页面
  - 资金池演示、开放经济、团队演示等

## 技术栈

### 前端
- React 18 / React Router 7 / TypeScript 5.7
- Vite 6 / Tailwind CSS 3 / PostCSS
- shadcn/ui 组件 + Lucide Icons
- Framer Motion / React Hook Form / Zod / Recharts

### 后端
- Express 4.21 / JWT 认证 / Helmet 安全头
- PostgreSQL (生产) / 内存数据库 (开发)
- pino 结构化日志 / prom-client 监控
- CloudBase CloudRun 部署

### 测试
- Vitest + jsdom
- 22 个 P0 核心测试（兑换码/凭证支付/凭证服务）
- GitHub Actions CI 流水线

### 安全
- CORS 白名单 / 速率限制 / JWT Bearer Token
- mathjs 沙箱公式求值（替代 eval）
- Helmet 安全头 / 日志脱敏 / 错误净化

## 运行与构建

### 环境要求
- Node.js 20+
- pnpm 10+

### 安装与开发
```bash
pnpm install
pnpm dev           # 并行启动 server.js + Vite dev server
# 前端: http://localhost:3001
# API: http://localhost:3000/api/v1
```

### 构建
```bash
pnpm build         # 编译 server TS → dist/server + Vite 构建前端 → dist/static
pnpm build:server  # 仅编译后端 TypeScript
pnpm build:client  # 仅构建前端
```

### 测试
```bash
pnpm test          # 运行全部测试
pnpm test:watch    # 监听模式
pnpm test:coverage # 生成覆盖率报告
```

### 环境变量
参考 `.env.example`，关键变量：
- `JWT_SECRET` — 生产环境必须设置
- `USE_MEMORY_DB` — 开发用 `true`，生产用 `false`
- `CORS_ORIGIN` — CORS 白名单域名
- `LOG_LEVEL` — `debug` | `info` | `warn` | `error`

## 部署

### CloudBase (推荐)
1. 配置 `cloudbase.json` 中的 `envId` 和环境参数
2. 构建并部署：
```bash
pnpm build
tcb cloudrun deploy
```

### Docker
```bash
docker build -t allinone-gaming .
docker run -p 3000:3000 -e JWT_SECRET=xxx -e USE_MEMORY_DB=false allinone-gaming
```

## API 文档
详见 [docs/api.md](docs/api.md)

## 截图目录约定

- 推荐将产品截图与文案素材放在 `docs/screenshots/` 目录
  - 示例：`docs/screenshots/platform-dashboard.png`
  - 子目录按模块组织：`docs/screenshots/platform/`, `docs/screenshots/wallet/`, `docs/screenshots/fund-pool/` 等
- 在 README 中引用：
  ```
  ![平台管理仪表盘](docs/screenshots/platform/dashboard.png)
  ```

## 目录结构

```
src/
  server/                    # 后端服务
    auth/jwt.ts              # JWT 认证模块
    routes/                  # API 路由（health/inventory/redeem）
    logger.ts                # pino 结构化日志
    requestId.ts             # Request ID 中间件
    metrics.ts               # Prometheus metrics
    memoryDatabase.ts        # 内存数据库适配器
    redeemCodeStore.ts       # 兑换码存储（含双花防护）
  services/                  # 核心业务服务
    voucherPaymentService.ts # A币支付（含并发锁）
    gameDeveloperService.ts  # 游戏商账户 + 每日结算（幂等）
    marketplaceService.ts    # 交易市场
  voucher-system/            # 凭证系统
    services/VoucherService.ts
    storage/VoucherDatabase.ts
  skills/                    # Skill 插件引擎
    auth/ wallet/ inventory/ store/ voucher/ proposal/ game-connector/
  components/ pages/ hooks/ contexts/ types/ utils/

顶层：
  server.js                  # Express 入口（S4 精简至 ~290 行）
  Dockerfile                 # 多阶段构建 + 非 root 用户
  vitest.config.ts           # 测试配置
  tsconfig.server.json       # 服务端 TS 编译
  .github/workflows/test.yml # CI 流水线
  docs/api.md                # API 文档
  docs/adr/                  # 架构决策记录 (×5)
  docs/runbooks/             # 运维 Runbook (×3)
```

## 安全基线

| 措施 | 实现 |
|------|------|
| JWT 认证 | `authMiddleware` 阻断无效/过期 token |
| CORS 白名单 | 仅允许 CloudBase 域名 + localhost |
| 速率限制 | 通用 100req/15min + 兑换码 10req/min |
| eval 移除 | `new Function()` → `mathjs.evaluate()` 沙箱 |
| Helmet | X-Content-Type-Options, X-Frame-Options, CSP |
| 日志脱敏 | pino 结构化日志，不输出 token/userId 原文 |
| 错误净化 | 生产环境不暴露 error.message 详情 |

## 数据可靠性

- 兑换码原子化：code-level mutex 防双花
- 支付并发锁：用户级锁防超额消费
- 结算幂等：batchId + 逐账户独立保存
- 哈希替换：djb2 → FNV-1a，Math.random → crypto.randomUUID()

## 可观测性

- `/api/v1/health` — 含 PG ping 延迟
- `/api/metrics` — Prometheus 格式指标
- pino 结构化日志（开发: pino-pretty, 生产: JSON）
- X-Request-Id 注入/透传


## 贡献

下一步，AllinONE将继续完善平台的安全问题、账户设置、游戏功能等等。
详情请见CONTRIBUTING.md
欢迎提交 PR，也欢迎提出建议与意见。

## 许可证

本项目为演示与内部开发用途，未设置公开许可证；如需开源或授权，请先与维护者确认。