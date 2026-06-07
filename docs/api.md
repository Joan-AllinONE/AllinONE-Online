# AllinONE Gaming Platform — API 文档 v1

**Base URL**: `https://<service-url>/api/v1`  
**认证**: `Authorization: Bearer <jwt_token>`  
**格式**: JSON

---

## 通用响应格式

```json
{
  "success": true,
  "data": { ... },
  "message": "操作成功"
}
// 错误:
{
  "success": false,
  "error": "错误描述"
}
```

---

## 1. 健康检查

### `GET /health`

无需认证。返回服务状态和数据库连通性。

**响应**:
```json
{
  "status": "ok",
  "timestamp": "2026-06-07T08:00:00.000Z",
  "database": "connected",
  "mode": "postgresql",
  "dbLatencyMs": 12
}
```

---

## 2. Metrics

### `GET /metrics`

Prometheus 格式指标端点。返回 HTTP 请求计数、延迟直方图、Node.js 运行时指标。

---

## 3. 库存管理

### `GET /inventory`

获取当前用户的库存列表。

**参数**: `?gameSource=xxx&page=1&limit=50`

### `GET /inventory/summary`

获取按游戏分组的库存汇总。

### `POST /inventory`

添加道具到库存。

**Body**:
```json
{
  "itemId": "sword_001",
  "name": "传说之剑",
  "gameSource": "rpg-game",
  "quantity": 1
}
```

### `POST /inventory/sync`

批量同步库存（游戏方接入接口）。

**Body**:
```json
{
  "gameSource": "rpg-game",
  "items": [
    { "id": "item1", "name": "道具1", "quantity": 5 }
  ]
}
```

### `GET /inventory/:itemId/sync-status`

获取单个道具的同步状态。

### `PATCH /inventory/:itemId/sync-status`

更新道具同步状态。`syncStatus`: `not_synced` | `syncing` | `synced` | `failed`

---

## 4. 兑换码

> ⚠️ 兑换码端点有严格速率限制：10 req/min

### `POST /redeem/sync`

前端同步兑换码数据到后端。

### `POST /redeem/verify`

验证兑换码。

**Body**: `{ "code": "IV-A3F9K2M7", "gameId": "game-1" }`  
**响应**: `{ "valid": true, "itemName": "钻石", "gameEffect": { ... } }`

### `POST /redeem/use`

核销兑换码（游戏方调用）。

**Body**: `{ "code": "IV-A3F9K2M7", "gameId": "game-1", "userId": "player-1" }`

### `GET /redeem/stats`

获取兑换码统计。

---

## 旧版路径兼容

`/api/*` 路径在 2026-09-01 前仍可用，但会返回 `Deprecation: true` 头。请迁移到 `/api/v1/*`。

---

## 速率限制

| 端点 | 限制 |
|------|------|
| 通用 `/api/` | 100 req / 15 min |
| `/api/redeem/verify` | 10 req / 1 min |
| `/api/redeem/use` | 10 req / 1 min |

超过限制返回 `429 Too Many Requests`。
