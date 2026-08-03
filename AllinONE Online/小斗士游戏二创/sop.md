lf2-powerup — 小斗士2 道具创作 SOP
游戏: 小斗士2（Little Fighter 2 / F.LF 网页版）
版本: v1.0.0
目标读者: 外部 AI（ChatGPT/Claude），根据此文档为玩家生成合规的道具 JSON

游戏规则
《小斗士2》是一款经典的横版格斗清关游戏。玩家从 Davis、Bandit、Firen 等角色中选择，在场景中移动、攻击、连招、释放必杀，并使用棍棒、锄头、冰剑等武器与敌人或队友战斗。游戏目标通常是清光场景内所有敌人（PvE）或击败对方队伍（PvP）。

道具的作用是帮助玩家更轻松地战斗，例如回复生命/内力、获得武器、进入无敌状态、召唤队友或敌人。道具不应破坏对战核心平衡，也不应直接秒杀全部敌人或让玩家无法被击败（永久无敌）。

可用效果 API
效果名	说明
invincible	仅对【使用道具的玩家】生效的无敌状态。params.on 默认 true（开启），传 false 关闭；params.duration 为可选秒数，超时自动关闭（建议 1-30）。⚠️ 平台预设实现当前会误将无敌加到全场所有角色（含敌人），属平台 Effect Engine bug；请改用 effectCode 版「定向无敌」或等平台修复。
give_weapon	给所有人类玩家发放武器。params.weapon 可为名称（stick/hoe/stone/wooden_box/ice_sword）或数字 id（100/101/150/151/213）
heal	回复所有人类玩家生命。params.amount 为回复量（默认 100），不超过角色最大血量 hp_bound
restore_mp	回复所有人类玩家内力。params.amount 为回复量（默认 100），不超过角色最大内力 mp_full
spawn_enemy	在敌方队伍召唤敌人。params.id 为角色名/数字 id（默认 bandit），params.count 数量，params.hp 血量
spawn_ally	在我方队伍召唤队友。params.id 为角色名/数字 id（默认 davis），params.count 数量，params.hp 血量
super_mode	一键满血满蓝 + 无敌 + 发放冰剑（213），无参数。⚠️ 其无敌部分同样受平台预设 bug 影响（会波及全场），如需仅自身无敌请改用「定向无敌」effectCode。
💡 高级模式支持通过 effectCode 字段创建以上列表之外的全新效果类型，详见下方「高级创作」章节。
💡 大招/必杀（原游戏需按键组合触发）无法作为预设效果，但可在高级模式用 effectCode 调用 game.performSpecial(char, comboToken) 直接"替角色按出"该招，效果与手动完全一致（见下方高级示例与附录 API）。

约束条件
invincible 持续时间最多 30 秒（即 duration ≤ 30）

give_weapon 的武器只能是：stick(100) / hoe(101) / stone(150) / wooden_box(151) / ice_sword(213)

heal 单次回复量 1-500（实际受 hp_bound 上限约束）

restore_mp 单次回复量 1-500（实际受 mp_full 上限约束）

spawn_enemy / spawn_ally 单次数量 1-10，hp 范围 10-500，id 必须在角色注册表内

禁止事项
invincible 的 duration 不得超过 30

give_weapon 的 weapon 不得超出已注册武器（见约束条件）

spawn_enemy / spawn_ally 的 count 不得超过 10，hp 不得超过 500

不得创建使所有敌人瞬间全灭且不可恢复的道具（严重破坏 PvE/PvP 平衡）

不得修改玩家物理属性（移动速度、跳跃、重力）或操作方式

不得删除/修改关卡静态地形、背景或场景物件

effectCode 不超过 4000 字符

effectCode 禁止使用: eval, new Function, import, window, document, fetch, localStorage, sessionStorage 等危险 API

创作等级
初级（预设道具）
仅可创建以下预设道具（直接选择预设模板）：

💰 能量饮料: 回复 50 HP (heal with amount: 50)

🛡️ 守护护符: 无敌 10 秒 (invincible with duration: 10)

⚔️ 木剑: 获得棍棒武器 (give_weapon with weapon: stick)

🔵 内力泉: 回复 100 MP (restore_mp with amount: 100)

👹 伏击: 召唤 2 个 Bandit 敌人 (spawn_enemy with id: bandit, count: 2)

🤝 战友: 召唤 1 个 Davis 队友 (spawn_ally with id: davis)

🌟 超级战士: 超级模式 (super_mode)

中级（效果组合）
可使用已注册效果进行组合，支持 effectScript：

可用效果: invincible, give_weapon, heal, restore_mp, spawn_enemy, spawn_ally, super_mode

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
game	F.LF 控制桥对象（等价于超级玛丽的 api），包含以下方法（详见附录）：
- getPlayers(): 返回所有人类玩家角色数组
- giveWeapon(char, weaponId): 给角色发武器
- setInvincible(char, on): 设置角色无敌
- heal(char, amount): 回复角色生命
- restoreMp(char, amount): 回复角色内力
- spawn(opts): 召唤角色（opts: {id,count,relation,hp}）
- getMatch(): 返回当前对局对象（可遍历角色/数据）
- performSpecial(char, comboToken): 让角色直接进入对应招式（comboToken 见下方附录，函数内部自动补满内力，无此招安全返回 false）
- comboTag: 只读对象，combo 令牌 → 帧标签映射（可在 effectCode 中 console.log(game.comboTag) 查看）
Math	JavaScript Math 对象
JSON	JavaScript JSON 对象
console	仅限 console.log（调试用）

⚠️ 沙箱同步提示：平台实际以 `lf2-allinone-sop.json` 的 `effectCodeSandbox.game` 白名单为「唯一真相源」来决定暴露哪些桥方法。本文档附录虽列出 performSpecial/getMatch/comboTag，但若 JSON 白名单漏列，平台仍会报「效果出错」。发布前请确认两者一致（最新 JSON 已补全全部 9 个方法，并设 allowCustomEffectNames=true）。
返回值格式：

json
{
  "message": "提示文字",
  "error": false   // 可选，如果为 true 则显示错误样式
}
安全限制：

函数体不超过 4000 字符

禁止使用: eval, new Function, import, window, document, fetch, localStorage, sessionStorage, alert, confirm, prompt 等

完整示例 —— 随机武器盲盒：

json
{
  "name": "随机武器盲盒",
  "effect": "random_weapon",
  "params": {},
  "description": "使用 effectCode 实现：从 5 把武器中随机抽一把发给全员",
  "icon": "🎲",
  "effectCode": "function(params) {\n  var players = game.getPlayers();\n  if (!players.length) return { error: true, message: '暂无玩家' };\n  var pool = [100, 101, 150, 151, 213];\n  var wid = pool[Math.floor(Math.random() * pool.length)];\n  players.forEach(function(p) { game.giveWeapon(p, wid); });\n  return { message: '🎲 随机武器已发放 #' + wid };\n}"
}
【示例 5 · 必杀发射】替全员"按出"必杀（DJA），角色无此招时自动跳过：
json
{
  "name": "必杀连发",
  "effect": "cast_bisha",
  "params": { "token": "DJA" },
  "description": "effectCode：对所有玩家发动必杀（下+跳+攻击）",
  "icon": "🌟",
  "effectCode": "function(params) {\n  var token = (params && params.token) || 'DJA';\n  var players = game.getPlayers();\n  if (!players.length) return { error: true, message: '暂无玩家' };\n  var fired = 0;\n  players.forEach(function(p) { if (game.performSpecial(p, token)) fired++; });\n  if (!fired) return { error: true, message: '当前角色无 ' + token + ' 招式' };\n  return { message: '🌟 必杀发动！(' + token + ' x' + fired + ')' };\n}"
}
【示例 6 · 火球齐射】替全员发动普通特招火球（D>A），支持任意持有该招的角色：
json
{
  "name": "火球齐射",
  "effect": "fireball_volley",
  "params": { "token": "D>A" },
  "description": "effectCode：对全员发动火球类特招（下+前+攻击）",
  "icon": "🔥",
  "effectCode": "function(params) {\n  var token = (params && params.token) || 'D>A';\n  var players = game.getPlayers();\n  if (!players.length) return { error: true, message: '暂无玩家' };\n  var fired = 0;\n  players.forEach(function(p) { if (game.performSpecial(p, token)) fired++; });\n  if (!fired) return { error: true, message: '无人会使 ' + token };\n  return { message: '🔥 火球齐射！x' + fired };\n}"
}
【示例 7 · 智能大招】优先放必杀，没有则放火球，再不行放上升攻击：
json
{
  "name": "智能大招",
  "effect": "smart_special",
  "params": {},
  "description": "effectCode：依次尝试 DJA / D>A / D^A，放出角色会的第一个",
  "icon": "⚡",
  "effectCode": "function(params) {\n  var players = game.getPlayers();\n  if (!players.length) return { error: true, message: '暂无玩家' };\n  var tries = ['DJA', 'D>A', 'D^A'];\n  var fired = 0;\n  players.forEach(function(p) {\n    for (var i = 0; i < tries.length; i++) {\n      if (game.performSpecial(p, tries[i])) { fired++; break; }\n    }\n  });\n  if (!fired) return { error: true, message: '当前角色无可用特招' };\n  return { message: '⚡ 智能大招！x' + fired };\n}"
}
【示例 8 · 定向无敌】仅对本地玩家（道具使用者）生效的无敌，敌人不受影响（绕过平台预设 invincible 误伤全场的 bug）：
json
{
  "name": "定向无敌",
  "effect": "directed_invincible",
  "params": { "duration": 15 },
  "description": "effectCode：仅使用者 15 秒无敌（硬化版，敌人不受影响）",
  "icon": "🛡️",
  "effectCode": "function(params) {\n  try {\n    if (typeof game === 'undefined' || !game) return { error: true, message: '控制桥未就绪' };\n    if (typeof game.getPlayers !== 'function' || typeof game.setInvincible !== 'function') return { error: true, message: '沙箱未开放所需方法' };\n    var players = game.getPlayers();\n    if (!players.length) return { error: true, message: '暂无玩家' };\n    var p = players[0];\n    var dur = (params && params.duration) ? params.duration : 15;\n    game.setInvincible(p, true);\n    if (typeof setTimeout === 'function') {\n      setTimeout(function() { game.setInvincible(p, false); }, dur * 1000);\n    }\n    return { message: '🛡️ 定向无敌 ' + dur + ' 秒（仅使用者）' };\n  } catch (e) {\n    return { error: true, message: '定向无敌异常: ' + (e && e.message ? e.message : e) };\n  }\n}"
}
组合令牌对照（comboToken → 招式）：
- DJA = 下+跳+攻击 → 必杀（bisha）。仅 Henry / Louis / Rudolf 拥有
- D>A / D<A = 下+前/后+攻击 → 火球类特招。Davis / Deep / Firen / Freeze / John / Henry / Rudolf / Louis / Woody / Dennis 拥有
- DvA = 下+上+攻击 → 上升特招（如 Davis 升龙）。多数角色拥有
- D^A = 下+上+攻击的另一种映射，视角色而定
- 完整令牌见 game.comboTag（沙箱内可打印 console.log(game.comboTag) 查看）
注意：performSpecial 会在角色没有对应帧标签时安全返回 false，不会报错；必杀通常需要内力，函数内部已自动补满。
道具参数定义
字段	类型	必填	说明
name	string	是	道具名称，最多 20 字符
effect	string	否*	效果类型（中级/高级模式可为任意已注册效果）
params	object	否	效果参数（根据效果类型不同）
description	string	否	道具描述，最多 200 字符
icon	string	否	道具图标 emoji，如 ⚔️、🛡️
effectCode	string	否	自定义效果函数体（仅高级模式）。function(params){...} 格式的 JS 函数代码字符串
effectScript	object	否	效果组合脚本（中级/高级模式）。支持 sequence/parallel/chain 操作符组合多个效果
* 若使用预设效果，effect 必填；若使用 effectCode 或 effectScript，则 effect 可省略。

params 子字段
字段	类型	说明
on	boolean	invincible 的开关（默认 true）
duration	number	invincible 无敌秒数（1-30）
weapon	string|number	give_weapon 的武器名或数字 id
amount	number	heal / restore_mp 的回复量（1-500）
id	string|number	spawn_enemy / spawn_ally 的角色名或数字 id
count	number	spawn 的数量（1-10）
hp	number	spawn 角色的血量（10-500）
输出格式
请生成如下 JSON 格式的道具定义。

基础示例（预设效果）
json
{
  "name": "守护护符",
  "effect": "invincible",
  "params": { "duration": 10 },
  "description": "无敌 10 秒",
  "icon": "🛡️"
}
自定义效果示例（高级模式 effectCode）
【示例 1 · 冰霜领域】全员冰剑 + 无敌 15 秒，超时自动解除：
json
{
  "name": "冰霜领域",
  "effect": "frost_domain",
  "params": {},
  "description": "effectCode：给全员冰剑(213)并无敌 15 秒",
  "icon": "❄️",
  "effectCode": "function(params) {\n  var players = game.getPlayers();\n  if (!players.length) return { error: true, message: '暂无玩家' };\n  players.forEach(function(p) {\n    game.giveWeapon(p, 213);\n    game.setInvincible(p, true);\n  });\n  setTimeout(function() {\n    game.getPlayers().forEach(function(p) { game.setInvincible(p, false); });\n  }, 15000);\n  return { message: '❄️ 冰霜领域：全员冰剑+无敌 15 秒' };\n}"
}
【示例 2 · 战地医师】全员满血满蓝并召唤 1 名援军：
json
{
  "name": "战地医师",
  "effect": "battle_medic",
  "params": {},
  "description": "effectCode：全员满状态并召唤 Davis 援军",
  "icon": "⛑️",
  "effectCode": "function(params) {\n  var players = game.getPlayers();\n  if (!players.length) return { error: true, message: '暂无玩家' };\n  players.forEach(function(p) {\n    game.heal(p, 9999);\n    game.restoreMp(p, 9999);\n  });\n  game.spawn({ id: 'davis', count: 1, relation: 'ally', hp: 120 });\n  return { message: '⛑️ 全员满状态，援军已至！' };\n}"
}
【示例 3 · 强敌试炼】按参数召唤一批高血量敌人（可传入 hp）：
json
{
  "name": "强敌试炼",
  "effect": "demon_summon",
  "params": { "hp": 300 },
  "description": "effectCode：召唤 3 个 300 血 Bandit 作为挑战",
  "icon": "😈",
  "effectCode": "function(params) {\n  try {\n    if (typeof game === 'undefined' || !game) return { error: true, message: '控制桥未就绪' };\n    if (typeof game.spawn !== 'function') return { error: true, message: '沙箱未开放 game.spawn（请确认平台桥为最新 lf2-flat5）' };\n    var players = (typeof game.getPlayers === 'function') ? game.getPlayers() : [];\n    if (!players.length) return { error: true, message: '暂无玩家，无法定位敌队' };\n    var hp = (params && params.hp) ? params.hp : 300;\n    game.spawn({ id: 'bandit', count: 3, relation: 'enemy', hp: hp });\n    return { message: '😈 强敌来袭 x3 (HP ' + hp + ')' };\n  } catch (e) {\n    return { error: true, message: '强敌试炼异常: ' + (e && e.message ? e.message : e) };\n  }\n}"
}
【示例 4 · 玩家状态快照】读取并打印全员 HP/MP/武器到控制台（纯信息类道具）：
json
{
  "name": "状态快照",
  "effect": "status_report",
  "params": {},
  "description": "effectCode：打印全员状态到控制台",
  "icon": "📊",
  "effectCode": "function(params) {\n  var players = game.getPlayers();\n  var lines = players.map(function(p) {\n    var w = (p.hold && p.hold.obj) ? (p.hold.obj.id || '?') : '徒手';\n    return 'HP ' + p.health.hp + '/' + p.health.hp_bound + ' MP ' + p.health.mp + ' 武器#' + w;\n  });\n  console.log('[LF2]', lines);\n  return { message: '📊 已打印 ' + players.length + ' 名玩家状态' };\n}"
}
组合效果示例（中级/高级 effectScript）
json
{
  "name": "战备大礼包",
  "effect": "war_pack",
  "params": {},
  "description": "顺序执行：回血 100 → 无敌 8 秒 → 发冰剑",
  "icon": "🎁",
  "effectScript": {
    "op": "sequence",
    "effects": [
      { "effect": "heal", "params": { "amount": 100 } },
      { "effect": "invincible", "params": { "duration": 8 } },
      { "effect": "give_weapon", "params": { "weapon": "ice_sword" } }
    ]
  }
}
道具验证规则（平台侧）
在玩家提交道具时，平台会进行以下校验：

name 不能为空，长度 ≤ 20

若使用预设效果，effect 必须在 availableEffects 列表中

params 中的数值必须在约束范围内（见「约束条件」）

若使用 effectCode，必须通过安全检查（黑名单过滤 + 长度限制 ≤ 4000）

若使用 effectScript，嵌套深度 ≤ 5，且所有子效果必须合法

道具不得包含禁止行为（见「禁止事项」）

附录：游戏 API 详细说明（供 effectCode 使用）
方法	参数	说明
game.getPlayers()	无	返回当前所有人类玩家角色对象数组（type==='character' 且 !is_npc）
game.giveWeapon(char, weaponId)	char, weaponId	给指定角色发武器，weaponId 为 100/101/150/151/213
game.setInvincible(char, on)	char, on(boolean)	设置角色无敌标记（默认不触发，由道具开启/关闭）
game.heal(char, amount)	char, amount	回复角色生命，上限为 hp_bound
game.restoreMp(char, amount)	char, amount	回复角色内力，上限为 mp_full
game.spawn(opts)	opts={id,count,relation,hp}	召唤角色；relation='ally' 加入我方，否则敌方；hp 默认 100
game.getMatch()	无	返回当前对局对象，可遍历 match.character（uid→角色）与 match.data.object（对象注册表）
game.comboTag	无	只读对象：combo 令牌 → 帧标签映射（如 {DJA:'hit_ja', 'D>A':'hit_Fa'}）。可在 effectCode 中打印 game.comboTag 查看全部
game.performSpecial(char, comboToken)	char, comboToken	让角色直接进入对应招式动画帧（等效于"按出"该招）。内部自动补满内力；若角色无此招式（帧标签不存在）则安全返回 false，不会报错。comboToken 取值见上方【组合令牌对照】
所有 API 调用均在游戏运行后生效（窗口派发 lf2-ready 事件表示控制桥就绪）。

角色 id 注册表（spawn 的 id 取值）：Davis=11, Bandit=30, Deep=1, John=2, Henry=4, Rudolf=5, Louis=6, Firen=7, Freeze=8, Dennis=9, Woody=10

武器 id 注册表（give_weapon 的 weapon 取值）：stick=100, hoe=101, stone=150, wooden_box=151, ice_sword=213
