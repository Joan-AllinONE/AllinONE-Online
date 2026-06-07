# ADR-002: JWT 认证方案

**状态**: 已接受  
**日期**: 2025-06-07

## 上下文

原系统使用 Mock 认证（任意 token 均通过），存在严重安全漏洞。需要选择适合的认证方案。

## 决策

采用 **JWT (jsonwebtoken)** + **Bearer Token** 方案：

- 签发：`signToken({ userId, role })` → 24h 有效期
- 验证：`authMiddleware` 中间件拦截所有 `/api/` 请求
- 密钥：生产环境通过 `JWT_SECRET` 环境变量配置（256-bit）

## 替代方案

| 方案 | 优点 | 缺点 | 结论 |
|------|------|------|------|
| Session/Cookie | 服务端可控 | 需 Redis 存储、不适用 SPA | ❌ |
| OAuth2/OIDC | 第三方集成 | 过度工程（当前阶段） | ❌ |
| API Key | 简单 | 无法区分用户 | ❌ |
| JWT | 无状态、SPA 友好、可扩展 | token 泄露风险 | ✅ |

## 影响

- 前端需在所有 API 请求中携带 `Authorization: Bearer <token>`
- 需在后端实现 `/api/auth/login` 和 `/api/auth/register` 端点
- 旧版 Mock token（`nd_token_*`）不再支持
