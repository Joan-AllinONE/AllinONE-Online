# 折腾 6 小时，终于把 CloudBase 数据库搞上线了——分享 5 个避坑点

> 一个产品经理 + AI 助手的真实改造记录。从 712 个 TypeScript 报错，到 8 个集合上线，再到双域名部署——整个过程比想象中曲折。

---

## 背景：为什么要折腾？

手头有一个游戏平台项目（AllinONE），代码写了一年多，功能堆了 26 个路由、42 个 Service、6 层 Context。但问题是：

- 数据全存在 **localStorage**，换个浏览器就没了
- 代码臃肿，**712 个 TS 编译错误**，构建跑不过
- 很多模块（算力、O币、New Day 集成）已经废弃但代码还在

于是决定做一次「外科手术」：删废代码、建数据库、统一 Skill 中台、上线。

---

## 第 1 步：删文件，712 个错误→构建成功

改造不是重写，是「做减法」。**18 个批次、200+ 文件**，劈掉一半：

| 删了什么 | 文件数 |
|----------|--------|
| 测试页面 / 演示代码 | 7 |
| 博客模块 | 8 |
| O币模块（合规风险） | 12 |
| 市场 + 资金池（P2 暂不开放） | 17 |
| New Day 集成 + 算力系统 + 废弃 Context | 48 |

每删一批，跑一次 `npx tsc --noEmit`，确认错误数在降。

**结果**：路由从 26→8，Context 从 6→2，TS 错误从 712→519，**全量构建 33 秒通过**。

> 💡 **经验 1**：重构不要贪多。每次只动一个模块，删完→验证→提交，形成「安全节奏」。git 分支 + baseline TAG 是救命稻草。

---

## 第 2 步：建数据库，node-sdk vs 控制台

数据库选了腾讯云 CloudBase（文档型），需要建 8 个集合：

```
users              ← 用户资料 + 余额
transactions       ← 交易流水
voucher_templates  ← 凭证模板
vouchers           ← 凭证实例
purchases          ← 购买记录
proposals          ← 治理提案
inventories        ← 道具库存
game_connectors    ← 游戏连接器
```

### 踩坑 1：node-sdk 的 `createIndex` 不工作

写了一个 `init.cjs` 脚本，用 `@cloudbase/node-sdk` 批量创建集合。集合创建成功了，但索引创建提示 `db.collection(...).createIndex is not a function`。

**原因**：node-sdk v3 的 `database()` 对象没有 `createIndex` 方法。索引只能通过 **控制台手动添加** 或 HTTP API。

**教训**：SDK 的文档和实际 API 不一定对齐，建库脚本只做「集合创建」就够了，索引和权限留给控制台。

> 💡 **经验 2**：CloudBase node-sdk 不等于拥有所有控制台能力。`createCollection`可用，但`createIndex`和`setSecurityRule`只有 HTTP API 能调。

### 踩坑 2：项目 package.json 的 `"type": "module"` 陷阱

初始化脚本用了 `require('@cloudbase/node-sdk')`，结果报了 `require is not defined in ES module scope`。

**原因**：项目根目录 `package.json` 设了 `"type": "module"`，Node 把所有 `.js` 当 ESM 处理。

**修复**：把脚本重命名为 `init.cjs`（CommonJS 后缀），问题消失。

> 💡 **经验 3**：如果项目用了 `"type": "module"`，建库脚本一定要用 `.cjs` 后缀。

---

## 第 3 步：安全规则，控制台找入口找了 10 分钟

进 CloudBase 控制台后，在「数据库」下找安全规则入口——发现它藏在新版 UI 的「权限设置」标签里，而不是旧版的「安全规则」独立标签。

而且新版控制台把自定义 JSON 规则改成了 **单选预设模式**：

| 集合 | 预设选项 |
|------|---------|
| users | 读取和修改本人数据 |
| transactions / vouchers / purchases / inventories | 不可修改数据 |
| voucher_templates / proposals / game_connectors | 读取全部，修改本人数据 |

刚开始以为要全部用自定义 JSON，后来发现预设选项**覆盖了 90% 的场景**，直接点击就行了。

> 💡 **经验 4**：新版 CloudBase 控制台的「权限设置」≈ 旧版的「安全规则」。如果找不到，先检查 UI 是否更新了。

---

## 第 4 步：部署，404 陷阱

构建通过、数据库就绪，把静态文件推到 CloudBase 托管：

```bash
npx tcb hosting deploy dist/static -e allinonegaming-d4gmsmrzz573264f6
```

部署成功，返回了域名 `https://allinonegaming-xxx.tcloudbaseapp.com`。打开——**白屏 404**。

控制台：

```
index-xxx.js  404 (Not Found)
index-xxx.css 404 (Not Found)
```

### 踩坑 4：vite.config.ts 的 `base` 硬编码

检查 `vite.config.ts`：

```ts
export default defineConfig({
  base: "/AllinONE-Gaming-Platform/",  // ← 这是 GitHub Pages 子路径！
})
```

GitHub Pages 部署在 `https://xxx.github.io/AllinONE-Gaming-Platform/`，需要子路径；但 CloudBase 是根目录部署 `https://xxx.tcloudbaseapp.com/`，所有 `/assets/xxx.js` 应该从根目录加载。

**修复**：把 `base` 改为动态读取环境变量：

```ts
function getBaseUrl() {
  return process.env.VITE_BASE_URL || '/';
}
```

重建→部署→刷新，正常。

> 💡 **经验 5**：如果要从 GitHub Pages 迁移到 CloudBase 托管，记得改 `vite.config.ts` 的 `base` 和 `main.tsx` 的 `basename`。建议做成环境变量，一次配置两个环境。

---

## 最终成果

| 项目 | 改造前 | 改造后 |
|------|--------|--------|
| TS 错误 | 712 | 519 |
| 路由 | 26 | 8 |
| Context | 6 | 2 |
| 数据库集合 | 0 | 8 |
| 线上域名 | 仅 GitHub Pages | GitHub + CloudBase 双线 |
| 构建 | ❌ | ✅ 33s |

---

## 总结：5 个关键教训

1. **外科手术式重构**：每次只动一个模块，删→验→提交→下一个
2. **不要指望 SDK 万能**：CloudBase node-sdk 能建集合，不能建索引
3. **`.cjs` 后缀救命**：项目设了 `"type":"module"` 时
4. **控制台 UI 会变**：找不到功能时检查版本更新
5. **base URL 是 404 元凶**：GitHub Pages 和 CloudBase 的路径模式不一样

如果你也在做类似的 CloudBase 迁移，希望这篇能帮你省几小时。

---

*记录于 2026.05.30 · AllinONE Gaming Platform MVP v1.0 改造笔记*
