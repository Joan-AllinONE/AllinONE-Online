# ADR-004: 凭证系统复式记账模型

**状态**: 已接受  
**日期**: 2025-06-07

## 上下文

A币凭证系统需要保证资金安全，杜绝超额消费、重复消费等金融级漏洞。

## 决策

采用 **复式记账模型**（Transfer-Only）：

- **零创建/零销毁**：所有凭证来源于平台预创建库存（`platform_pool`）
- **仅转移**：用户支付 = 用户凭证 transfer 到平台，找零 = 平台 transfer 到用户
- **唯一性**：每张凭证有唯一 ID（`crypto.randomUUID()`）和交易哈希（FNV-1a）

## 安全措施

| 措施 | 实现位置 |
|------|---------|
| 用户级支付锁 | `voucherPaymentService.payWithVoucher()` |
| 兑换码原子 check-and-use | `redeemCodeStore.useCode()` |
| 结算幂等性 | `gameDeveloperService.executeDailySettlement()` |
| 哈希防篡改 | `VoucherService.generateTxHash()` |

## 替代方案

| 方案 | 优点 | 缺点 | 结论 |
|------|------|------|------|
| 账户余额制 | 简单 | 找零复杂、并发写入 | ❌ |
| 区块链 | 去中心化 | 延迟高、成本高 | ❌ |
| Transfer-Only 复式记账 | 安全、可审计、易于对账 | 凭证数量增长 | ✅ |

## 影响

- 平台需预创建标准化面额库存（1/5/10/20/50/100）
- 需监控平台库存耗尽情况（自动补仓）
- 每笔支付生成完整的 transfer 交易链
