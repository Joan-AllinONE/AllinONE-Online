{
  "schemaName": "zuma-powerup",
  "description": "祖玛游戏道具 — 支持3级创作模式的增益道具系统",
  "aiPrompt": "祖玛(Zuma)游戏道具创作系统。这是一条由彩色弹珠组成的链沿着蝇蜒路径向终点洞穴移动。玩家控制中央的青蛙射手，发射弹珠插入链中，3个或更多同色弹珠相邻时会消除。如果弹珠链到达终点则游戏结束。道具有助于减缓弹珠链、消除弹珠或获得额外分数。",
  "availableEffects": [
    "add_score",
    "clear_color",
    "slow_chain",
    "remove_tail",
    "reverse_chain",
    "score_multiplier",
    "freeze_all"
  ],
  "effectRules": [
    "add_score: 立即增加分数，bonus 为 5-50 的整数",
    "clear_color: 清除所有指定颜色弹珠，每清除一个加5分",
    "slow_chain: 弹珠链大幅减速 10 秒后恢复",
    "remove_tail: 移除尾部 N 个弹珠，N 为 1-10",
    "reverse_chain: 整条弹珠链反转方向",
    "score_multiplier: 当前分数乘以倍率 (2-5)",
    "freeze_all: 弹珠链完全冻结 5 秒后恢复"
  ],
  "constraints": {
    "maxScoreAdd": 50,
    "maxTailRemove": 10,
    "maxMultiplier": 5,
    "totalMarbles": 100,
    "initMarbles": 20
  },
  "forbidden": [
    "add_score 不要超过 50 分",
    "remove_tail 不要超过 10 个",
    "score_multiplier 不要超过 5 倍",
    "不要创建能一次性清除超过 20 个弹珠的道具",
    "不要创建能直接让游戏结束的道具"
  ],
  "effectCodeEnabled": true,
  "effectCodeSignature": "function(params)",
  "effectCodeReturns": "{ message: string }",
  "effectCodeSandbox": {
    "game": "Zuma 实例",
    "gameState": "游戏状态 (score/marbleCount/moveSpeed)",
    "marbles": "弹珠链表数组",
    "Math": "JS Math",
    "JSON": "JS JSON"
  },
  "presetItems": [
    {
      "name": "加分宝石",
      "effect": "add_score",
      "params": {
        "bonus": 20
      },
      "description": "立即获得20分",
      "icon": "✨"
    },
    {
      "name": "清色炸弹",
      "effect": "clear_color",
      "params": {
        "color": "#0C3406"
      },
      "description": "清除所有深绿色弹珠",
      "icon": "💚"
    },
    {
      "name": "减速陷阱",
      "effect": "slow_chain",
      "params": {},
      "description": "弹珠链大幅减速10秒",
      "icon": "🐌"
    },
    {
      "name": "剪刀",
      "effect": "remove_tail",
      "params": {
        "count": 5
      },
      "description": "移除尾部5个弹珠",
      "icon": "✂️"
    },
    {
      "name": "反转宝石",
      "effect": "reverse_chain",
      "params": {},
      "description": "弹珠链反转方向",
      "icon": "🔄"
    },
    {
      "name": "冰冻宝石",
      "effect": "freeze_all",
      "params": {},
      "description": "弹珠链冻结5秒",
      "icon": "❄️"
    }
  ],
  "examples": [
    {
      "name": "加分宝石",
      "effect": "add_score",
      "params": {
        "bonus": 20
      },
      "description": "立即获得20分",
      "icon": "✨"
    },
    {
      "name": "清除绿珠",
      "effect": "clear_green",
      "params": {},
      "description": "effectCode 自定义效果",
      "icon": "🟢",
      "effectCode": "function(params){var c=0;for(var i=marbles.length-1;i>=0;i--){if(marbles[i].marble.Color==='#0C3406'){game.removeMarbleFromDataList(marbles[i].marble,i);c++;}}game.score+=c*5;return{message:'清除了'+c+'个绿珠'}}"
    }
  ]
}