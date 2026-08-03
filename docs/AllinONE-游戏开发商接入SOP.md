# AllinONE 游戏开发商接入 SOP（AI 可执行提示词）

> **用途**：将此文档交给 AI 助手（如 Cursor、Copilot、Claude 等），AI 可据此自动完成游戏接入的全部平台侧操作和游戏侧代码生成。
>
> **适用对象**：第三方游戏开发商（非 AllinONE 平台内发布的游戏），通过兑换码机制在 AllinONE 平台商店售卖道具。

---

## 一、整体架构与流程

### 1.1 角色分工

| 角色 | 职责 |
|------|------|
| **游戏开发商（你）** | 在平台注册游戏 → 创建道具模板 → 铸造凭证 → 在游戏侧接入兑换码核销 API |
| **AllinONE 平台** | 提供商店展示、玩家购买、兑换码生成、核销 API |
| **玩家** | 在平台商店购买道具 → 获得兑换码 → 在你的游戏内输入兑换码 → 领取道具 |

### 1.2 完整流程（6 步）

```
步骤1: 注册游戏（平台侧）
  ↓
步骤2: 创建道具模板（平台侧）
  ↓
步骤3: 铸造凭证（平台侧）
  ↓
步骤4: 玩家购买 → 自动获得兑换码 IV-XXXXXXXX（平台自动）
  ↓
步骤5: 游戏内添加兑换码输入 UI（游戏侧）
  ↓
步骤6: 调用 API 验证+核销+发放道具（游戏侧）
```

---

## 二、平台侧操作（步骤 1-3）

### 步骤 1：注册游戏

**入口**：登录 AllinONE → 进入游戏商店 → 点击「管理」→ 进入「我的游戏商店管理」

**操作**：
1. 点击「注册游戏」按钮
2. 填写以下信息：

| 字段 | 格式 | 示例 | 说明 |
|------|------|------|------|
| 游戏ID | `ext-{slug}-{timestamp}` | `ext-genshin-1717300000000` | 全局唯一，注册后不可修改 |
| 游戏名称 | 文本 | `原神` | 展示在商店的游戏名 |
| 图标 | emoji 或 URL | `🎮` | 商店展示用 |
| 开发商 | 文本 | `miHoYo` | 展示在商店的开发商名 |
| 简介 | 文本 | `开放世界冒险游戏` | 一句话描述 |
| 主色调 | HEX 颜色 | `#7c3aed` | 商店卡片主题色 |
| 次要色 | HEX 颜色 | `#06b6d4` | 商店卡片辅助色 |

3. 点击「注册」完成

**AI 自动执行要点**：
- 游戏 ID 必须以 `ext-` 开头，格式为 `ext-{slug}-{timestamp}`
- slug 使用小写英文+短横线，如 `my-cool-game`
- timestamp 使用 `Date.now()` 生成

### 步骤 2：创建道具模板

**操作**：
1. 在已注册游戏列表中点击你的游戏（展开）
2. 点击「创建道具」按钮
3. 填写以下信息：

| 字段 | 可选值 | 示例 | 说明 |
|------|--------|------|------|
| 道具名称 | 文本 | `月卡` | 展示名称 |
| 游戏道具ID | 文本 | `monthly_card` | 你的游戏内部道具标识，核销时据此发放 |
| 类型 | `consumable` / `permanent` / `currency` / `buff` / `package` | `consumable` | 消耗品/永久/货币/增益/礼包 |
| 稀有度 | `common` / `uncommon` / `rare` / `legendary` | `rare` | 普通/精良/稀有/传说 |
| 发行策略 | `open` / `limited` | `open` | 开放型无限量 / 限量型受总量约束 |
| 总量上限 | 数字（仅限量型） | `1000` | 限量型道具的铸造总量上限 |
| 价格 | 数字 | `50` | 购买价格 |
| 货币 | `ACOIN` / `gameCoins` | `ACOIN` | A币（凭证）或游戏币 |
| 描述 | 文本 | `每月领取300原石` | 道具描述 |
| 初次铸造数量 | 数字 | `100` | 创建后立即铸造的凭证数量 |

4. 点击「创建并铸造」完成

**AI 自动执行要点**：
- `gameItemId` 是核销时的关键标识，必须与游戏内部道具系统一致
- 开放型道具（`open`）可无限铸造，限量型（`limited`）受 `totalSupply` 硬约束
- 铸造的凭证进入平台池（platform_pool），供玩家购买

### 步骤 3：补充铸造（可选）

**操作**：
1. 在道具列表中找到目标道具
2. 输入铸造数量
3. 点击「铸造」按钮

**说明**：
- 铸造后凭证自动上架，玩家即可在商店购买
- 限量型道具的累计铸造量不可超过 `totalSupply`

---

## 三、游戏侧接入（步骤 5-6）

### 3.1 API 基础信息

| 项目 | 值 |
|------|---|
| Base URL | `https://<你的平台域名>/api/v1/redeem` |
| Content-Type | `application/json` |
| 鉴权 | 无强制鉴权（建议生产环境使用 API Key） |
| 响应格式 | `{ "success": boolean, "data": {...}, "error": string }` |

> **注意**：旧路径 `/api/redeem` 已弃用（Deprecation: true），将于 2026-09-01 下线，请使用 `/api/v1/redeem`。

### 3.2 接口一：验证兑换码

**验证玩家输入的兑换码是否有效（幂等，不修改状态）**

```
POST /api/v1/redeem/verify
```

**Request Body**:
```json
{
  "code": "IV-A3F9K2M7",
  "gameId": "ext-genshin-1717300000000"
}
```

**Response（有效）**:
```json
{
  "success": true,
  "data": {
    "valid": true,
    "code": "IV-A3F9K2M7",
    "itemName": "月卡",
    "gameEffect": {
      "itemId": "monthly_card",
      "quantity": 1
    }
  }
}
```

**Response（无效）**:
```json
{
  "success": true,
  "data": {
    "valid": false,
    "message": "兑换码已被使用"
  }
}
```

**可能的无效原因**：
- `兑换码不存在`
- `兑换码已被使用`
- `兑换码已过期`
- `兑换码不属于此游戏`

**参数说明**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|:---:|------|
| code | string | ✅ | 玩家输入的兑换码，格式 `IV-XXXXXXXX`（8位字母数字） |
| gameId | string | ✅ | 你的游戏ID，即注册时的 `ext-{slug}-{timestamp}` |

### 3.3 接口二：核销兑换码

**标记兑换码为已使用并发放道具。⚠️ 必须先调用 verify 确认有效后再调用此接口。**

```
POST /api/v1/redeem/use
```

**Request Body**:
```json
{
  "code": "IV-A3F9K2M7",
  "gameId": "ext-genshin-1717300000000",
  "userId": "player_12345"
}
```

**Response（成功）**:
```json
{
  "success": true,
  "data": {
    "success": true,
    "code": "IV-A3F9K2M7",
    "itemName": "月卡",
    "gameEffect": {
      "itemId": "monthly_card",
      "quantity": 1
    },
    "usedAt": "2026-06-02T09:00:00.000Z"
  }
}
```

**参数说明**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|:---:|------|
| code | string | ✅ | 兑换码 |
| gameId | string | ✅ | 游戏ID |
| userId | string | ✅ | 玩家在你的游戏中的唯一标识 |

**返回的 `gameEffect` 是发放道具的唯一依据**：
- `itemId`：你在步骤2中设置的 `游戏道具ID`
- `quantity`：发放数量

### 3.4 接口三：统计查询（可选）

```
GET /api/v1/redeem/stats
```

返回平台兑换码的全局统计数据，可用于运营分析。

---

## 四、代码示例

### 4.1 Node.js 后端接入

```javascript
// redeemClient.js - AllinONE 兑换码客户端
const REDEEM_API = 'https://<平台域名>/api/v1/redeem';

/**
 * 验证 + 核销兑换码（推荐的安全流程）
 * @param {string} gameId - 游戏ID (ext-xxx-xxx)
 * @param {string} code - 玩家输入的兑换码 (IV-XXXXXXXX)
 * @param {string} playerId - 玩家在你游戏中的ID
 */
async function redeemCode(gameId, code, playerId) {
  // Step 1: 验证兑换码
  const verifyRes = await fetch(REDEEM_API + '/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, gameId }),
  });
  const verifyData = await verifyRes.json();

  if (!verifyData.success || !verifyData.data.valid) {
    return {
      success: false,
      error: verifyData.data?.message || '验证失败',
    };
  }

  // Step 2: 核销兑换码（标记为已使用）
  const useRes = await fetch(REDEEM_API + '/use', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, gameId, userId: playerId }),
  });
  const useData = await useRes.json();

  if (!useData.success || !useData.data.success) {
    return {
      success: false,
      error: useData.data?.message || '核销失败',
    };
  }

  // Step 3: 根据 gameEffect 发放道具
  const { gameEffect, itemName } = useData.data;
  await grantItemToPlayer(playerId, gameEffect);

  return {
    success: true,
    itemName,
    gameEffect,
  };
}

// 发放道具到玩家背包（替换为你的游戏逻辑）
async function grantItemToPlayer(playerId, gameEffect) {
  const { itemId, quantity } = gameEffect;
  // TODO: 替换为你的数据库操作
  // await db.addItem(playerId, itemId, quantity);
  console.log(`发放 ${quantity}x ${itemId} 给玩家 ${playerId}`);
}

module.exports = { redeemCode };
```

### 4.2 Python 后端接入

```python
# redeem_client.py - AllinONE 兑换码客户端
import requests

REDEEM_API = "https://<平台域名>/api/v1/redeem"

def redeem_code(game_id: str, code: str, player_id: str) -> dict:
    """验证并核销兑换码"""
    # Step 1: 验证
    verify_resp = requests.post(
        f"{REDEEM_API}/verify",
        json={"code": code, "gameId": game_id},
    )
    verify_data = verify_resp.json()

    if not verify_data.get("success") or not verify_data["data"].get("valid"):
        return {
            "success": False,
            "error": verify_data["data"].get("message", "验证失败"),
        }

    # Step 2: 核销
    use_resp = requests.post(
        f"{REDEEM_API}/use",
        json={"code": code, "gameId": game_id, "userId": player_id},
    )
    use_data = use_resp.json()

    if not use_data.get("success") or not use_data["data"].get("success"):
        return {
            "success": False,
            "error": use_data["data"].get("message", "核销失败"),
        }

    # Step 3: 发放道具
    game_effect = use_data["data"]["gameEffect"]
    grant_item(player_id, game_effect["itemId"], game_effect["quantity"])

    return {
        "success": True,
        "itemName": use_data["data"]["itemName"],
        "gameEffect": game_effect,
    }

def grant_item(player_id: str, item_id: str, quantity: int):
    """发放道具到玩家背包（替换为你的游戏逻辑）"""
    # TODO: 替换为你的数据库操作
    # db.execute("INSERT INTO inventory ...")
    print(f"发放 {quantity}x {item_id} 给 {player_id}")
```

### 4.3 游戏内兑换 UI 设计建议

**输入框设计**：
- 兑换码格式为 `IV-XXXXXXXX`（前缀 `IV-` + 8位字母数字）
- 建议使用分段输入框：先显示固定的 `IV-`，后面8个字符输入位
- 支持粘贴自动识别（玩家可能从剪贴板粘贴完整码）

**错误处理**：
- `兑换码不存在` → 提示"请检查输入是否正确"
- `兑换码已被使用` → 提示"此兑换码已使用，每个码只能使用一次"
- `兑换码已过期` → 提示"兑换码已过期，请联系客服"
- `兑换码不属于此游戏` → 提示"此兑换码不适用于本游戏"
- 网络错误 → 提示"网络异常，请稍后重试"

**安全建议**：
- ✅ 必须先 verify 再 use，不可跳过验证直接核销
- ✅ 服务端请求去重（基于 code 去重），防止并发重复核销
- ✅ 核销操作应是幂等的（同一 code 多次 use 只生效一次）
- ❌ 不要在前端直接调用 use 接口，必须通过你的游戏后端中转

---

## 五、AI 执行指令

> 以下是给 AI 助手的执行指令模板，AI 可直接据此操作。

### 指令 A：自动注册游戏 + 创建道具

```
请帮我在 AllinONE 平台完成以下操作：

1. 注册游戏：
   - 游戏ID: ext-{我的游戏slug}-{当前timestamp}
   - 游戏名称: {游戏名}
   - 图标: {emoji}
   - 开发商: {开发商名}
   - 简介: {一句话描述}

2. 为这个游戏创建以下道具模板：
   - 道具名: {道具名}
   - 游戏道具ID: {itemId}
   - 类型: {consumable/permanent/currency/buff/package}
   - 稀有度: {common/uncommon/rare/legendary}
   - 发行策略: {open/limited}
   - 价格: {价格数字} {ACOIN/gameCoins}
   - 初次铸造: {数量}

请在"我的游戏商店管理"页面 (/game-store-manage) 完成操作。
```

### 指令 B：生成游戏侧兑换码接入代码

```
请根据 AllinONE 兑换码 API 为我的游戏生成后端接入代码：

- 游戏ID: ext-{slug}-{timestamp}
- 平台地址: {平台URL}
- 编程语言: {Node.js/Python/其他}
- 游戏框架: {Express/FastAPI/其他}

需要实现：
1. 兑换码输入接口（接收玩家输入的 IV-XXXXXXXX）
2. 调用平台 verify 接口验证
3. 调用平台 use 接口核销
4. 根据返回的 gameEffect 发放道具
5. 错误处理和请求去重

API 文档参考本文档第三、四章节。
```

### 指令 C：生成游戏内兑换 UI

```
请为我的游戏生成兑换码输入 UI：

- 游戏引擎: {Unity/Godot/Cocos/HTML5/其他}
- UI框架: {内置UI/React/Vue/其他}

要求：
1. 分段输入框：IV- 前缀固定 + 8位字符输入
2. 支持粘贴完整码自动识别
3. 提交按钮触发后端兑换流程
4. 友好的错误提示（不存在/已使用/已过期/网络异常）
5. 兑换成功动画和道具展示
```

---

## 六、常见问题

### Q1: 兑换码格式是什么？
**A**: `IV-XXXXXXXX`，其中 `IV-` 是固定前缀，后面8位是大写字母和数字的组合。例如 `IV-A3F9K2M7`。

### Q2: 我能在测试环境验证 API 吗？
**A**: 可以。本地开发时 Base URL 为 `http://localhost:3001/api/v1/redeem`。确保 AllinONE 后端服务已启动。

### Q3: 限量型道具铸造完了怎么办？
**A**: 限量型道具达到 `totalSupply` 上限后无法继续铸造。如需更多库存，需要创建新的道具模板。开放型道具无此限制。

### Q4: 玩家可以退款吗？
**A**: 当前版本不支持自动退款。如玩家购买后未使用兑换码，需由平台管理员手动处理。

### Q5: `/api/redeem` 和 `/api/v1/redeem` 有什么区别？
**A**: `/api/redeem` 是旧路径，已标记为弃用（Deprecation: true），将于 2026-09-01 下线。请统一使用 `/api/v1/redeem`。

### Q6: 一个游戏可以注册多少个道具？
**A**: 没有数量限制。你可以根据游戏需要创建任意数量的道具模板。

---

## 七、检查清单

接入完成后，请逐项确认：

- [ ] 游戏已在平台注册（格式 `ext-{slug}-{timestamp}`）
- [ ] 至少创建了一个道具模板（配置了 gameItemId）
- [ ] 已铸造初始库存（凭证进入平台池）
- [ ] 道具在平台商店正常展示
- [ ] 游戏内兑换码输入 UI 已实现
- [ ] 后端 verify 接口调用正常
- [ ] 后端 use 接口调用正常
- [ ] 核销后游戏内道具正确发放
- [ ] 错误场景均有友好提示
- [ ] 已做请求去重防护
