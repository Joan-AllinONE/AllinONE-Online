# Runbook: CloudRun 实例故障

**SEV 级别**: SEV2  
**适用场景**: CloudRun 实例不健康、OOM、连接池耗尽

## 触发条件

- 健康检查返回非 200
- 实例 CPU > 80% 持续 5min
- 用户报告 502/504 错误

## 诊断步骤

### 1. 检查实例状态
```bash
# 健康检查
curl https://<service-url>/api/v1/health
# 检查 metrics
curl https://<service-url>/api/metrics
```

### 2. 查看 CloudBase 日志
1. 登录 [CloudBase 控制台](https://tcb.cloud.tencent.com) → 日志监控
2. 筛选错误日志：`level:50`（error 级别）
3. 检查是否有 `Uncaught exception`、`DB connection failed` 等

### 3. 连接池耗尽诊断
```bash
# 检查当前活跃连接
SELECT count(*) FROM pg_stat_activity WHERE state = 'active';
# 如果 > 15，可能存在连接池耗尽
```

## 恢复步骤

### 快速恢复（< 5 分钟）
1. 登录 CloudBase 控制台
2. CloudRun → 服务 → 重启实例
3. 新实例将自动释放所有连接

### 根本修复

| 症状 | 修复 |
|------|------|
| 连接池耗尽 | 增加 Pool max: 20→30，配置 statement_timeout |
| OOM | 增加内存 1GB→2GB（CloudRun 配置） |
| 慢查询 | 添加索引、优化 N+1 查询 |
| 未捕获异常 | 已修复：uncaughtException → process.exit(1) → 自动重启 |

## 预防措施

- 配置 CloudBase 云监控告警（5xx > 5%, P95 > 2s, CPU > 80%）
- Dockerfile 已添加 HEALTHCHECK
- Server 已配置 connectionTimeoutMillis、statement_timeout
