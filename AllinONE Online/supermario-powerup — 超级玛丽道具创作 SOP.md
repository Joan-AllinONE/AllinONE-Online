supermario-powerup — 超级玛丽道具创作 SOP
游戏: 超级玛丽（Super Mario）
版本: v1.0.0
目标读者: 外部 AI（ChatGPT/Claude），根据此文档为玩家生成合规的道具 JSON

游戏规则
《超级玛丽》是一款经典平台跳跃游戏。玩家控制角色在横向卷轴关卡中移动、跳跃、踩踏敌人、收集金币，并抵达旗杆过关。关卡中包含砖块、问号块、管道、敌人（板栗仔）和道具（蘑菇、星星）等元素。玩家可顶破砖块获得金币或蘑菇，变大后可踩碎砖块。

道具的作用是帮助玩家更轻松地通关，例如增加分数、增加生命、变大、无敌、补充时间或清除敌人。道具不应破坏游戏核心挑战，也不应导致直接胜利。

可用效果 API
效果名	说明
add_score	立即增加分数，params.bonus 为 5-50 的整数
add_life	增加一条额外生命，无参数
become_big	使玩家变大（如果当前为小玛丽），无参数。若已为大玛丽则无效果
invincible	使玩家进入无敌状态，持续 params.duration 帧（约 60 帧/秒），建议 60-300
add_time	增加关卡剩余时间（秒），params.seconds 建议 10-60
clear_enemies	立即清除当前屏幕上的所有敌人（板栗仔），无参数
💡 高级模式支持通过 effectCode 字段创建以上列表之外的全新效果类型，详见下方「高级创作」章节。

约束条件
单次增加分数最多 50 分

单次增加时间最多 60 秒

无敌持续时间最多 300 帧（约 5 秒）

单次加命最多 1 条（道具可重复使用，但每次最多 1 条）

清除敌人无数量限制，但仅限当前已出现的敌人（不包括未激活的）

禁止事项
add_score 的 bonus 不得超过 50

add_time 的 seconds 不得超过 60

invincible 的 duration 不得超过 300

不得创建能直接跳过旗杆或通关的道具

不得修改玩家物理属性（如重力、速度）或控制方式

不得删除或修改关卡中的静态地形（砖块、管道、地面）

effectCode 不超过 4000 字符

effectCode 禁止使用: eval, new Function, import, window, document, fetch, localStorage 等危险 API

创作等级
初级（预设道具）
仅可创建以下预设道具（直接选择预设模板）：

金币袋: 立即获得 20 分 (add_score with bonus: 20)

1UP 蘑菇: 增加一条命 (add_life)

超级蘑菇: 变成大玛丽 (become_big)

无敌星: 无敌 3 秒 (invincible with duration: 180)

时间沙漏: 增加 30 秒时间 (add_time with seconds: 30)

大锤: 清除所有敌人 (clear_enemies)

中级（效果组合）
可使用已注册效果进行组合，支持 effectScript：

可用效果: add_score, add_life, become_big, invincible, add_time, clear_enemies

最大组合深度: 3

单次最多组合效果数: 5

effectScript 格式：

json
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
当玩家需要的效果不在「可用效果 API」列表中时，可以使用 effectCode 字段定义全新的效果逻辑。effectCode 是一个 JavaScript 函数表达式字符串，随道具 JSON 一起打包，在游戏运行时安全执行。

函数签名：function(params)

沙箱可用变量：

变量	说明
api	游戏暴露的 API 对象，包含以下方法：
- getScore(): 返回当前分数
- addScore(bonus): 增加分数
- addLife(): 增加一条命
- becomeBig(): 变大
- setInvincible(duration): 设置无敌帧数
- addTime(seconds): 增加时间
- clearEnemies(): 清除敌人
Math	JavaScript Math 对象
JSON	JavaScript JSON 对象
console	仅限 console.log（调试用）
返回值格式：

json
{
  "message": "提示文字",
  "error": false   // 可选，如果为 true 则显示错误样式
}
安全限制：

函数体不超过 4000 字符

禁止使用: eval, new Function, import, window, document, fetch, localStorage, sessionStorage, alert, confirm, prompt 等

完整示例 —— 双倍得分道具：

json
{
  "name": "双倍得分",
  "effect": "double_score",
  "params": {},
  "description": "使用 effectCode 实现：接下来 5 秒内所有得分翻倍（此处仅演示单次加倍）",
  "icon": "📈",
  "effectCode": "function(params) {\n  var currentScore = api.getScore();\n  var extra = currentScore > 0 ? currentScore : 10;\n  api.addScore(extra);\n  return { message: '分数翻倍！+' + extra + ' 分' };\n}"
}
道具参数定义
字段	类型	必填	说明
name	string	是	道具名称，最多 20 字符
effect	string	否*	效果类型（中级/高级模式可为任意已注册效果）
params	object	否	效果参数（根据效果类型不同）
description	string	否	道具描述，最多 200 字符
icon	string	否	道具图标 emoji，如 💰、🍄
effectCode	string	否	自定义效果函数体（仅高级模式）。function(params){...} 格式的 JS 函数代码字符串
effectScript	object	否	效果组合脚本（中级/高级模式）。支持 sequence/parallel/chain 操作符组合多个效果
* 若使用预设效果，effect 必填；若使用 effectCode 或 effectScript，则 effect 可省略。

params 子字段
字段	类型	说明
bonus	number	add_score 增加的分数 (5-50)
duration	number	invincible 无敌帧数 (60-300)
seconds	number	add_time 增加的时间秒数 (10-60)
输出格式
请生成如下 JSON 格式的道具定义。

基础示例（预设效果）
json
{
  "name": "金币袋",
  "effect": "add_score",
  "params": { "bonus": 20 },
  "description": "立即获得 20 分",
  "icon": "💰"
}
自定义效果示例（高级模式 effectCode）
json
{
  "name": "无敌冲刺",
  "effect": "super_dash",
  "params": {},
  "description": "无敌 2 秒并清除所有敌人",
  "icon": "⚡",
  "effectCode": "function(params) {\n  api.setInvincible(120);\n  api.clearEnemies();\n  return { message: '无敌冲刺！' };\n}"
}
组合效果示例（中级/高级 effectScript）
json
{
  "name": "奖励大礼包",
  "effect": "reward_pack",
  "params": {},
  "description": "顺序执行：加命 → 加 30 分 → 变大火力（变大）",
  "icon": "🎁",
  "effectScript": {
    "op": "sequence",
    "effects": [
      { "effect": "add_life", "params": {} },
      { "effect": "add_score", "params": { "bonus": 30 } },
      { "effect": "become_big", "params": {} }
    ]
  }
}
道具验证规则（平台侧）
在玩家提交道具时，平台会进行以下校验：

name 不能为空，长度 ≤ 20

若使用预设效果，effect 必须在 availableEffects 列表中

params 中的数值必须在约束范围内（见「约束条件」）

若使用 effectCode，必须通过安全检查（黑名单过滤 + 长度限制）

若使用 effectScript，嵌套深度 ≤ 5，且所有子效果必须合法

道具不得包含禁止行为（见「禁止事项」）

附录：游戏 API 详细说明（供 effectCode 使用）
方法	参数	说明
api.getScore()	无	返回当前 game.score 数值
api.addScore(bonus)	bonus (number)	增加分数，仅在游戏状态为 play 时有效
api.addLife()	无	增加一条生命，仅在游戏状态为 play 时有效
api.becomeBig()	无	使玩家变大，若已大则无效果
api.setInvincible(duration)	duration (number)	设置无敌帧数（60 帧 ≈ 1 秒），覆盖现有无敌时间
api.addTime(seconds)	seconds (number)	增加关卡剩余时间（秒）
api.clearEnemies()	无	立即清空当前所有活跃敌人（板栗仔）
所有 API 调用均会检查游戏状态，若游戏不在 play 状态则忽略操作。