# Runbook: 兑换码紧急吊销

**SEV 级别**: SEV2  
**适用场景**: 兑换码 API 被暴力枚举、批量盗用

## 触发条件

- `/api/redeem/verify` 请求量异常激增（> 正常流量的 10x）
- 多个兑换码的 `verifyCount` 异常递增
- 游戏方反馈兑换码被不明用户使用

## 紧急响应步骤

### 1. 临时阻断（< 5 分钟）

**选项 A：调整速率限制**（最快）
```bash
# 修改 server.js 中 strictLimiter 的 max 值
# 当前：10 req/min → 可临时降为 1 req/min
```

**选项 B：CloudBase 控制台限流**
1. 登录 [CloudBase 控制台](https://tcb.cloud.tencent.com)
2. CloudRun → 服务配置 → 添加自定义限流规则
3. 对 `/api/v1/redeem/verify` 设置 1 req/min

### 2. 吊销被攻击的兑换码批次（< 30 分钟）

```javascript
// 通过 API 批量标记为 DISABLED
// 或在 redeemCodeStore 中手动操作
POST /api/v1/redeem/sync
{
  "codes": [
    { "id": "xxx", "status": "disabled", ... }
  ]
}
```

### 3. 恢复正常运营（< 1 小时）

1. 确认攻击停止
2. 将速率限制恢复为正常值
3. 为受影响的游戏重新生成兑换码批次
4. 通知游戏方新的兑换码

## 后续措施

- 分析攻击日志确定攻击来源 IP
- 考虑添加验证码/proof-of-work 机制
- 监控告警配置：`verifyCount` 增长率 > 100/min → 自动告警
