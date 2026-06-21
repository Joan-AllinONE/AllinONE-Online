NEW_FILE_CODE
# zuma-powerup — 祖玛游戏道具创作 SOP

> **游戏**: ZUMA（祖玛）
> **版本**: v1.0.0
> **目标读者**: 外部 AI（ChatGPT/Claude），根据此文档为玩家生成合规的道具 JSON

---

## 描述

祖玛游戏道具 — 玩家可创建各种改变弹珠链、分数、速度的增益道具。

---

## 游戏规则

祖玛(Zuma)游戏道具创作系统。这是一个经典的祖玛游戏：一条由彩色弹珠组成的链沿着蜿蜒路径向终点洞穴移动。玩家控制中央的青蛙射手，发射弹珠插入链中，3个或更多同色弹珠相邻时会消除。如果弹珠链到达终点则游戏结束。道具有助于减缓弹珠链、消除弹珠或获得额外分数。

---

## 可用效果 API

| 效果名 | 说明 |
|--------|------|
| add_score | 立即增加分数，params.bonus 为 5-50 的整数 |
| clear_color | 清除弹珠链中所有指定颜色的弹珠，params.color 为颜色值（如 #0C3406）。每清除一个加5分 |
| slow_chain | 弹珠链大幅减速 10 秒后恢复原速 |
| remove_tail | 移除弹珠链尾部的 N 个弹珠，params.count 为 1-10。每移除一个加3分 |
| reverse_chain | 整条弹珠链反转方向（位置百分比取反） |
| score_multiplier | 当前分数乘以倍率，params.multiplier 为 2-5 |
| freeze_all | 弹珠链完全冻结 5 秒后恢复 |

> 💡 高级模式支持通过 `effectCode` 字段创建以上列表之外的全新效果类型，详见下方「高级创作」章节。

---

## 约束条件

- 单次增加分数最多 50 分
- 单次移除尾部弹珠最多 10 个
- 分数倍率最多 5 倍
- 可用颜色: #0C3406, #077187, #74A57F, #ABD8CE, #E4C5AF
- 弹珠总数: 100
- 初始弹珠数: 20

---

## 禁止事项

- add_score 不要超过 50 分
- remove_tail 不要超过 10 个
- score_multiplier 不要超过 5 倍
- 不要创建能一次性清除超过 20 个弹珠的道具
- 不要创建能直接让游戏结束的道具
- effectCode 不超过 4000 字符
- effectCode 禁止使用: eval, new Function, import, window, document, fetch, localStorage 等危险 API

---

## 创作等级

### 初级（预设道具）

仅可创建以下预设道具：

- **加分宝石**: 立即获得 20 分 (effect: add_score)
- **清色炸弹**: 清除所有深绿色弹珠 (effect: clear_color)
- **减速陷阱**: 弹珠链大幅减速 10 秒 (effect: slow_chain)
- **剪刀**: 移除尾部 5 个弹珠 (effect: remove_tail)
- **反转宝石**: 弹珠链反转方向 (effect: reverse_chain)
- **冰冻宝石**: 弹珠链冻结 5 秒 (effect: freeze_all)

### 中级（效果组合）

可使用已注册效果进行组合，支持 effectScript：

- 可用效果: add_score, clear_color, slow_chain, remove_tail, reverse_chain, score_multiplier, freeze_all
- 最大组合深度: 3
- 单次最多组合效果数: 5

effectScript 格式：

```json
{
  "op": "sequence",
  "effects": [
    { "effect": "效果名", "params": {} },
    { "effect": "效果名", "params": {} }
  ]
}
操作符: sequence(顺序) | parallel(并行) | chain(链式)
高级（自由创作）
支持 effectScript 自由组合、effectCode 自定义效果和自定义效果名：
effectScript: 已启用
自定义效果名: 允许
effectCode 自定义效果函数: 已启用
允许的操作符: sequence, parallel, chain
最大脚本嵌套深度: 5
effectCode — 自定义效果函数
当玩家需要的效果不在「可用效果 API」列表中时，可以使用 effectCode 字段定义全新的效果逻辑。effectCode 是一个 JavaScript 函数表达式字符串，随道具 JSON 一起打包，在游戏运行时安全执行。函数签名：
function(params)
沙箱可用变量：
变量	说明
game	Zuma 游戏实例，可访问 game.score、game.moveSpeed、game.marbleDataList、game.removeMarbleFromDataList(marble, index) 等方法
gameState	游戏状态对象：gameState.score() 当前分数、gameState.marbleCount() 弹珠数、gameState.moveSpeed() 移动速度、gameState.pathLength 路径长度
marbles	弹珠链表数组，每个元素 { marble: {Color, x, y, ID, overlap()}, percent: number }
Math	JavaScript Math 对象
JSON	JavaScript JSON 对象
返回值格式：
{
  "message": "提示文字"
}
安全限制：
函数体不超过 4000 字符
禁止使用: eval, new Function, import, window, document, fetch, localStorage 等危险 API
完整示例 — 清除绿珠道具：
{
  "name": "清除绿珠",
  "effect": "clear_green",
  "params": {},
  "description": "使用 effectCode 自定义效果：清除所有深绿色(#0C3406)弹珠并加分",
  "icon": "🟢",
  "effectCode": "function(params) {\n  var count = 0;\n  for (var i = marbles.length - 1; i >= 0; i--) {\n    if (marbles[i].marble.Color === '#0C3406') {\n      game.removeMarbleFromDataList(marbles[i].marble, i);\n      count++;\n    }\n  }\n  game.score += count * 5;\n  return { message: '清除了 ' + count + ' 个绿珠！+' + (count*5) + ' 分' };\n}"
}
道具参数定义
字段	类型	必填	说明
name	string	是	道具名称
effect	string	否	效果类型（中级/高级模式可为任意已注册效果）
params	object	否	效果参数（根据效果类型不同）
description	string	否	道具描述
icon	string	否	道具图标 emoji
effectCode	string	否	自定义效果函数体（仅高级模式）。function(params){...} 格式的 JS 函数代码字符串，运行时在游戏沙箱中执行。可用变量：game(Zuma实例)、gameState(游戏状态对象)、marbles(弹珠链表数组)、Math、JSON、console。返回值格式：{ message: string, error?: boolean }
effectScript	object	否	效果组合脚本（中级/高级模式）。支持 sequence/parallel/chain 操作符组合多个效果
params 子字段：
字段	类型	说明
bonus	number	add_score 增加的分数 (5-50) [最小: 5] [最大: 50]
color	string	颜色 (#0C3406/#077187/#74A57F/#ABD8CE/#E4C5AF) (可选: #0C3406/#077187/#74A57F/#ABD8CE/#E4C5AF)
count	number	remove_tail 移除的弹珠数 (1-10) [最小: 1] [最大: 10]
multiplier	number	score_multiplier 分数倍率 (2-5) [最小: 2] [最大: 5]
输出格式
请生成如下 JSON：
基础示例
{
  "name": "加分宝石",
  "effect": "add_score",
  "params": { "bonus": 20 },
  "description": "立即获得 20 分",
  "icon": "✨"
}
自定义效果示例（高级模式 effectCode）
{
  "name": "清除绿珠",
  "effect": "clear_green",
  "params": {},
  "description": "使用 effectCode 自定义效果：清除所有深绿色(#0C3406)弹珠并加分",
  "icon": "🟢",
  "effectCode": "function(params) {\n  var count = 0;\n  for (var i = marbles.length - 1; i >= 0; i--) {\n    if (marbles[i].marble.Color === '#0C3406') {\n      game.removeMarbleFromDataList(marbles[i].marble, i);\n      count++;\n    }\n  }\n  game.score += count * 5;\n  return { message: '清除了 ' + count + ' 个绿珠！+' + (count*5) + ' 分' };\n}"
}
组合效果示例（中级/高级 effectScript）
{
  "name": "减速+加分",
  "effect": "slow_chain",
  "params": {},
  "description": "先减速弹珠链，再加 15 分",
  "icon": "⏳",
  "effectScript": {
    "op": "sequence",
    "effects": [
      { "effect": "slow_chain", "params": {} },
      { "effect": "add_score", "params": { "bonus": 15 } }
    ]
  }
}