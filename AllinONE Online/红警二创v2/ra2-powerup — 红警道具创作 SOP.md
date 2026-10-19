ra2-powerup — 红警道具创作 SOP
游戏: 红警复刻版（Red Alert 2 Remake）
版本: v1.0.0
目标读者: 外部 AI（ChatGPT/Claude），根据此文档为玩家生成合规的道具 JSON

游戏规则
《红警复刻版》是一款经典即时战略（RTS）游戏。玩家选择盟军或苏军阵营，通过采集矿石获取资金，建造基地、兵营、战车工厂等建筑，训练步兵、坦克、飞机等作战单位，组建军队摧毁敌方基地。游戏核心循环为：采集资源 → 建造基地 → 生产军队 → 战场对抗。

道具的作用是增强玩家的战术体验——提供资金、开视野、修复单位、增加电力、空投补给等增益，帮助玩家更灵活地应对战场局势。道具不应破坏游戏核心经济平衡，也不应直接决定胜负。

可用效果 API
效果名	说明
add_cash	立即增加资金，params.amount 为 500-5000 的整数，用于建造和训练
reveal_map	开启全图视野（消除战争迷雾），params.duration 为持续秒数（默认 15 秒）
speed_boost	己方所有单位移动速度提升，params.multiplier 为 1.2-3.0 倍率，params.duration 为 10-30 秒。当前版本为视觉提示（徽章 + 闪屏），引擎扩展后可实际修改单位属性
armor_boost	己方所有单位装甲强化，params.multiplier 为 1.2-3.0 倍率，params.duration 为 10-30 秒。当前版本为视觉提示，引擎扩展后可实际修改单位属性
repair_all	立即修复己方所有受损单位至满血，无参数
power_surge	电力系统超载，提供无限电力 params.duration 秒（15-60秒），解决电力不足问题
airdrop_supply	空投补给包，params.cash 为 1000-3000 的资金量，模拟补给到达（含空投箱着陆动画，2秒后资金注入）
spawn_ally	友军增援，params.typeId 为单位类型（如 gi=盟军步兵），params.cellX/cellY 为基地附近生成坐标
place_mine	放置反步兵地雷到地图上。玩家使用道具后点击地图选择放置位置，地雷监测敌方单位接近自动引爆。params.damage 为爆炸伤害（30-150），params.radius 为爆炸范围格数（1-4），params.triggerPx 为触发距离像素（30-100）。地雷有红色脉冲光圈视觉标记，爆炸有扩散动画。每次最多同时存在 5 颗地雷
infinite_ore	激活无限矿产被动收入，持续自动增加资金。params.perSec 为每秒收入（50-1000），默认 200。资金通过引擎 addCash 命令每 500ms 注入一次。右上角显示状态徽章。可调用 deactivateInfiniteOre() 停止
space_rift	时空裂缝：地图随机位置生成持续 15 秒的传送门，任何单位踏入都会被传送到敌方基地内部，直插敌后打穿防线。可通过 params.durationSec / radius 调整时长与半径（默认 15 秒 / 170 像素）。基于引擎 spawnPortal 命令 + 拓展包持续扫描实现。
nuclear_strike	核弹空投：地图随机位置空投核弹，半径 3 格范围爆炸，中心 5 秒内敌方单位陷入恐慌（攻击力减半）。可通过 params.radiusCells / damage / panicSec 调整（默认 3 格 / 320 伤害 / 5 秒）。基于引擎 nuclearStrike 命令实现。
panic_zone	恐慌力场：在敌方基地中心释放力场，范围内敌军单位 5 秒内攻击力减半。基于引擎 panicArea 命令实现。
railgun	轨道炮改装：给己方指定类型（默认 grizzly 灰熊坦克）的武器加装轨道炮，射程 ×rangeMul（默认2，屏幕边缘即可开火），炮弹沿弹道穿透成串敌军。基于引擎 railgunMod 命令（按归属方 owner 生效）实现，纯 effectCode 无法直接做穿透、需经此引擎命令。
airdrop	空投动员兵：给己方动员兵（conscript）开启空降能力，框选后右键敌方目标，动员兵从天而降砸到敌人头顶，落地时对目标点范围内敌军造成范围伤害（空降本身就是攻击）。基于引擎 airdropMod + airdrop 命令（按归属方 owner 生效）实现，纯 effectCode 无法直接拦截右键移动指令、需经此引擎命令接管。
💡 高级模式支持通过 effectCode 字段创建以上列表之外的全新效果类型，详见下方「高级创作」章节。

约束条件
单次增加资金最多 5000

单次增加资金最少 500

速度/装甲倍率范围 1.2-3.0

速度/装甲 buff 持续时间 10-30 秒

电力超载持续时间最多 60 秒

空投补给资金量 1000-3000

地雷爆炸伤害 30-150

地雷爆炸范围 1-4 格

地雷触发距离 30-100 像素

同时存在的地雷最多 5 颗

无限矿产每秒收入 50-1000

轨道炮射程倍率 rangeMul 默认 2（5格→10格）

轨道炮穿透走廊宽度 pierceWidth 默认 48 像素

空投落地伤害 impactDamage 默认 90（上限 200）

空投落地半径 impactRadius 默认 256 像素（上限 512）

空投下落耗时 fallTicks 默认 45（上限 90，约 2.25 秒）

禁止事项
add_cash 的 amount 不得超过 5000

speed_boost 和 armor_boost 的倍率不得超过 3.0

buff 持续时间不得超过 30 秒

不得创建能直接摧毁敌方基地的道具

不得创建能让己方单位无敌的道具

不得创建能直接消灭敌方所有单位的道具

repair_all 不能附带额外攻击加成

不得创建能跳过建造等待时间的道具

place_mine 伤害不得超过 150

place_mine 爆炸半径不得超过 4 格

同时存在的地雷不得超过 5 颗

不得创建能自动追踪敌人的智能地雷

不得创建隐形不可见的地雷（必须有视觉标记）

infinite_ore 每秒收入不得超过 1000

effectCode 不超过 4000 字符

effectCode 禁止使用: eval, new Function, import, window, document, fetch, localStorage 等危险 API

创作等级
初级（预设道具）
仅可创建以下预设道具（直接选择预设模板）：

空投资金: 立即获得 2000 资金 (add_cash with amount: 2000)

侦察卫星: 开启全图视野 (reveal_map)

急行军令: 全军移速翻倍 15 秒 (speed_boost with multiplier: 2.0, duration: 15)

纳米装甲: 全军装甲强化 2 倍 20 秒 (armor_boost with multiplier: 2.0, duration: 20)

战场维修站: 修复所有受损单位至满血 (repair_all)

电力超载: 无限电力 30 秒 (power_surge with duration: 30)

超级空投: 投 3000 资金补给包 (airdrop_supply with cash: 3000)

炸弹箱: 放置反步兵地雷 (place_mine with damage: 80, radius: 2, triggerPx: 60)

重型炸弹箱: 放置重型地雷 (place_mine with damage: 150, radius: 4, triggerPx: 80)

无限矿产: 资金持续 +200/秒 (infinite_ore with perSec: 200)

超级矿脉: 资金狂飙 +500/秒 (infinite_ore with perSec: 500)

中级（效果组合）
可使用已注册效果进行组合，支持 effectScript：

可用效果: add_cash, reveal_map, speed_boost, armor_boost, repair_all, power_surge, airdrop_supply, spawn_ally, place_mine, infinite_ore

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
game	红警桥接对象，通过沙箱参数注入（等同于 window.__ra2allinone）。包含以下属性和方法：
- view: 游戏视图对象
- world: 游戏世界对象
- localPlayerId: 本地玩家 ID
- emit(cmd): 注入命令走引擎管线（与玩家点击移动等价）
- 可用 emit 命令：
  - addCash(owner, amount): 增加资金
  - repairAll(owner): 修复所有单位
  - powerSurge(owner, durationTicks): 电力超载
  - revealMap(owner, durationTicks): 开全图视野
  - spawnAlly(owner, typeId, cellX, cellY): 生成友军单位
  - spawnPortal(owner, x, y, radius, durationSec, targetX, targetY): 在地图 (x,y) 生成持续 durationSec 秒、半径 radius 像素的传送门，踏入单位被瞬移到 (targetX,targetY)
  - nuclearStrike(owner, x, y, radiusCells, damage, panicSec): 在 (x,y) 空投核弹，radiusCells 格范围爆炸（伤害 damage），中心 panicSec 秒敌军攻击减半
  - panicArea(owner, x, y, radius, panicSec): 在 (x,y) 半径 radius 像素内敌军陷入 panicSec 秒恐慌（攻击减半）
  - teleportUnit(entityId, x, y): 将指定单位瞬移到 (x,y)
  - railgunMod(owner, typeId, rangeMul, pierce, pierceWidth): 给 owner 方指定 typeId 单位（默认 grizzly 灰熊）加装轨道炮，射程 ×rangeMul，pierce 为 true 时炮弹穿透弹道走廊内所有敌军（pierceWidth 像素宽）。按归属方生效。
  - airdropMod(owner, typeId, fallTicks, impactDamage, impactRadius): 给 owner 方指定 typeId 单位（默认 conscript 动员兵）开启空降能力，fallTicks 为下落 tick 数，落地时对 impactRadius 像素内敌军造成 impactDamage 范围伤害。按归属方生效。
  - airdrop(owner, entityIds, x, y): 令 owner 方指定的 entityIds 单位从 (x,y) 天降，落地触发范围伤害（由 airdropMod 配置决定）。通常由引擎在右键时自动调用，effectCode 也可手动调用。
ra2	红警桥接对象别名（同 game）
Math	JavaScript Math 对象
JSON	JavaScript JSON 对象
console	仅限 console.log（调试用）
getGame	获取红警桥接对象（同 game），可在 effectCode 内直接调用
返回值格式：
返回值格式：

json
{
  "message": "提示文字",
  "error": false   // 可选，如果为 true 则显示错误样式
}
安全限制：

函数体不超过 4000 字符

禁止使用: eval, new Function, import, window, document, fetch, localStorage, sessionStorage, alert, confirm, prompt 等

完整示例 —— 全图视野 + 资金组合道具：

json
{
  "name": "指挥部礼包",
  "effect": "command_pack",
  "params": {},
  "description": "使用 effectCode 实现：开全图视野 10 秒 + 增加 1500 资金",
  "icon": "🎖️",
  "effectCode": "function(params) {\n  var game = getGame();\n  if (!game) return { error: true, message: '游戏未启动' };\n  game.emit({ kind: 'revealMap', owner: game.localPlayerId, durationTicks: 200 });\n  game.emit({ kind: 'addCash', owner: game.localPlayerId, amount: 1500 });\n  return { message: '🎖️ 指挥部礼包：全图视野 10s + 1500 资金' };\n}"
}
道具参数定义
字段	类型	必填	说明
name	string	是	道具名称，最多 20 字符
effect	string	否*	效果类型（中级/高级模式可为任意已注册效果）
params	object	否	效果参数（根据效果类型不同）
description	string	否	道具描述，最多 200 字符
icon	string	否	道具图标 emoji，如 💰、🛡️
effectCode	string	否	自定义效果函数体（仅高级模式）。function(params){...} 格式的 JS 函数代码字符串
effectScript	object	否	效果组合脚本（中级/高级模式）。支持 sequence/parallel/chain 操作符组合多个效果
* 若使用预设效果，effect 必填；若使用 effectCode 或 effectScript，则 effect 可省略。

params 子字段
字段	类型	说明
amount	number	add_cash 增加的资金量 (500-5000)
multiplier	number	speed_boost / armor_boost 的倍率 (1.2-3.0)
duration	number	buff 持续时间/电力超载时间 (10-60 秒)
cash	number	airdrop_supply 空投补给资金量 (1000-3000)
damage	number	place_mine 地雷爆炸伤害 (30-150)
radius	number	place_mine 地雷爆炸范围格数 (1-4)
triggerPx	number	place_mine 地雷触发距离像素 (30-100)
perSec	number	infinite_ore 每秒自动增加的资金量 (50-1000)
typeId	string	spawn_ally 单位类型 ID（如 gi=盟军步兵）
cellX	number	spawn_ally 生成坐标 X
cellY	number	spawn_ally 生成坐标 Y
输出格式
请生成如下 JSON 格式的道具定义。

基础示例（预设效果）
json
{
  "name": "空投资金",
  "effect": "add_cash",
  "params": { "amount": 2000 },
  "description": "立即获得 2000 资金，加速基地建设",
  "icon": "💰"
}
自定义效果示例（高级模式 effectCode）
json
{
  "name": "指挥官特权",
  "effect": "commander_pack",
  "params": {},
  "description": "全图视野 10 秒 + 修复所有单位",
  "icon": "⭐",
  "effectCode": "function(params) {\n  var game = getGame();\n  if (!game) return { error: true, message: '游戏未启动' };\n  game.emit({ kind: 'revealMap', owner: game.localPlayerId, durationTicks: 200 });\n  game.emit({ kind: 'repairAll', owner: game.localPlayerId });\n  return { message: '⭐ 指挥官特权：全图视野 + 全体维修' };\n}"
}
组合效果示例（中级/高级 effectScript）
json
{
  "name": "战争礼包",
  "effect": "war_pack",
  "params": {},
  "description": "顺序执行：加 2000 资金 → 开全图视野 → 修复全部单位",
  "icon": "🎁",
  "effectScript": {
    "op": "sequence",
    "effects": [
      { "effect": "add_cash", "params": { "amount": 2000 } },
      { "effect": "reveal_map", "params": { "duration": 15 } },
      { "effect": "repair_all", "params": {} }
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
game.emit({ kind: 'addCash', owner, amount })	owner: 玩家 ID, amount: 500-5000	增加资金，走引擎命令管线
game.emit({ kind: 'repairAll', owner })	owner: 玩家 ID	修复己方所有受损单位至满血
game.emit({ kind: 'powerSurge', owner, durationTicks })	owner: 玩家 ID, durationTicks: 秒×20	电力超载，durationTicks 为 tick 数（约 20 tick/秒）
game.emit({ kind: 'revealMap', owner, durationTicks })	owner: 玩家 ID, durationTicks: 秒×20	全图视野，消除战争迷雾
game.emit({ kind: 'spawnAlly', owner, typeId, cellX, cellY })	owner: 玩家 ID, typeId: 单位类型, cellX/cellY: 格坐标	在指定坐标生成友军单位
game.view	无	游戏视图对象（只读）
game.world	无	游戏世界对象（只读）
game.localPlayerId	无	本地玩家 ID（只读）
game.emit(cmd)	cmd: { kind, owner, ...params }	通用命令注入，走引擎 applyCommands 管线
game.emit({ kind: 'railgunMod', owner, typeId, rangeMul, pierce, pierceWidth })	owner: 玩家 ID, typeId: 单位类型（默认 grizzly）, rangeMul: 射程倍率（默认2）, pierce: 是否穿透（true/false）, pierceWidth: 穿透走廊像素宽（默认48）	给指定单位加装轨道炮（射程×倍率 + 穿透），按归属方生效
game.emit({ kind: 'airdropMod', owner, typeId, fallTicks, impactDamage, impactRadius })	owner: 玩家 ID, typeId: 单位类型（默认 conscript）, fallTicks: 下落 tick 数（默认45）, impactDamage: 落地伤害（默认90）, impactRadius: 落地半径像素（默认256）	给指定单位开启空降能力，按归属方生效
game.emit({ kind: 'airdrop', owner, entityIds, x, y })	owner: 玩家 ID, entityIds: 单位 id 数组, x/y: 天降落点像素坐标	令指定单位从 (x,y) 天降，落地触发范围伤害（由 airdropMod 配置决定）
可用单位类型 ID（spawn_ally 参数）
typeId	说明
gi	盟军步兵（Guardian Infantry）
e1	苏军步兵（Conscript）
mtnk	盟军中型坦克（Grizzly Battle Tank）
htnk	苏军重型坦克（Rhino Heavy Tank）
所有 emit 命令均走引擎自身 applyCommands 管线注入，与玩家点击移动等操作等价，不会绕过游戏逻辑。若游戏未在运行状态，命令会被忽略。
