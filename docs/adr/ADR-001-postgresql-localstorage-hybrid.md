# ADR-001: PostgreSQL + localStorage 混合存储

**状态**: 已接受  
**日期**: 2025-06-07  
**决策者**: 工程团队

## 上下文

AllinONE Gaming Platform 需要同时支持：
1. **生产环境**（CloudBase CloudRun）：数据持久化、水平扩展、高可用
2. **本地开发**：零配置快速启动、无外部依赖

## 决策

采用 **PostgreSQL + localStorage 双层存储**：

- **生产环境**：`USE_MEMORY_DB=false` → PostgreSQL（CloudBase 托管）
- **开发环境**：`USE_MEMORY_DB=true` → 内存数据库 + localStorage 缓存
- **凭证系统**：优先 localStorage（离线可用），后台异步同步到 CloudBase

## 替代方案

| 方案 | 优点 | 缺点 | 结论 |
|------|------|------|------|
| 纯 PostgreSQL | 一致性强 | 本地开发需安装 PG | ❌ 不选 |
| 纯 localStorage | 零配置 | 数据不持久化、不可扩展 | ❌ 不选 |
| 混合存储 | 兼顾开发体验和生产可靠性 | 需维护两套存储适配器 | ✅ 选择 |

## 影响

- 需维护 `memoryDatabase.ts` 和 PostgreSQL 两套查询逻辑
- 生产环境严禁 `USE_MEMORY_DB=true`（已在 cloudbase.json 中设为 false）
- 未来可考虑统一迁移到 CloudBase 文档数据库
