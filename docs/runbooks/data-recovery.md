# Runbook: 数据恢复

**SEV 级别**: SEV1  
**适用场景**: PostgreSQL 数据损坏、误删除、CloudRun 滚动更新导致数据丢失

## 触发条件

- 用户报告库存/兑换码数据丢失
- `/api/inventory` 返回空列表
- 健康检查数据库状态为 `error`

## 恢复步骤

### 1. 确认影响范围
```bash
# 检查数据库连接
curl https://<service-url>/api/v1/health
# 预期: { "status": "ok", "database": "connected" }
```

### 2. 从 PostgreSQL 备份恢复

CloudBase PostgreSQL 支持自动备份（需预先在控制台配置）。

1. 登录 [CloudBase 控制台](https://tcb.cloud.tencent.com)
2. 导航到 数据库 → MySQL → 备份恢复
3. 选择最近的可用备份点
4. 执行恢复到当前实例

### 3. 内存数据库数据抢救（仅开发环境）

```bash
# 如果使用内存数据库，数据不可恢复。
# 解决方案：切换到 PostgreSQL。
# 修改 cloudbase.json 中 envParams.USE_MEMORY_DB = "false"
```

### 4. 验证恢复

```bash
curl -H "Authorization: Bearer <token>" https://<url>/api/v1/inventory
curl -H "Authorization: Bearer <token>" https://<url>/api/v1/redeem/stats
```

### 5. 通知用户

- 在应用内显示维护公告
- 如数据丢失无法恢复，启动补偿方案

## 预防措施

- 配置 PostgreSQL 每日自动备份（保留 7 天）
- 生产环境严禁 `USE_MEMORY_DB=true`
- 监控 `/api/health` 端点的 `database` 字段
