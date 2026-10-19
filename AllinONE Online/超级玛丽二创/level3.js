/* =====================================================================
 * 超级玛丽改造6 —— 「第三关」数据型任务脚本（GameQuest levels slot / 方案 B）
 * =====================================================================
 * 用法：
 *  1. 在任务广场创建 levels slot 任务；
 *  2. 提交 ContentPack（【不要】加 inject，保持数据型）：
 *     {
 *       "schemaVersion": "1.0",
 *       "slot": "levels",
 *       "data": [
 *         { "id": "lvl3", "title": "第三关", "cols": 150, "script": "level3.js" }
 *       ],
 *       "assets": [
 *         { "path": "level3.js", "content": "…本文件全文…（注意转义换行）" }
 *       ]
 *     }
 *  3. 审核通过 → 「合并并发放报酬」；
 *  4. 重新发布一次改造6（后端要拿到带加载器的新 HTML）；
 *  5. GamePlay 顶部「扩展」菜单选该扩展进入（URL 带 ?ext=），
 *     标题界面即出现「第三关」可选（↑/↓ 或顶部下拉），Enter 开始。
 *
 * 契约：脚本暴露 window.MarioLevel = { build(api) }；
 *   api 提供 setT/pipe/stairUp/stairDown（直接画瓦片）、grid（15×cols 引用）、
 *   T/ROWS/COLS、setFlag(fc)、setEnemies([列号数组])。
 * ===================================================================== */
window.MarioLevel = {
  build: function (api) {
    var setT = api.setT, pipe = api.pipe, stairUp = api.stairUp, stairDown = api.stairDown;
    var COLS3 = 150, c, r;

    /* 敌人出生列（36/100 原为乌龟；数据型 API 仅支持列号，统一按板栗出生） */
    api.setEnemies([16, 36, 52, 70, 100, 118, 130]);

    /* 旗杆列 = 138（城堡由加载器兜底放在 cols-6 = 144） */
    api.setFlag(138);

    /* 坠落缺口（坑洞） */
    var gaps = { 40: 1, 41: 1, 80: 1, 81: 1, 82: 1, 120: 1, 121: 1 };
    for (c = 0; c < COLS3; c++){
      if (!gaps[c]){ api.grid[13][c] = 1; api.grid[14][c] = 1; }
    }

    /* 起始 ? 块（蘑菇）+ 砖 */
    setT(10, 9, 3); setT(12, 9, 2); setT(13, 9, 4); setT(14, 9, 2); setT(18, 9, 3);

    /* 管道 + 寄生食人花（直接写全局 piranhaSpawns；回到原版关卡时 buildLevel 会重置） */
    pipe(24, 11); pipe(60, 10); pipe(98, 9);
    piranhaSpawns = [{ col: 24 }, { col: 60 }, { col: 98 }];

    /* 浮空砖平台 + 空中 ? 块 */
    for (c = 46; c <= 49; c++) setT(c, 8, 2);
    for (c = 88; c <= 91; c++) setT(c, 8, 2);
    setT(55, 9, 3); setT(76, 9, 3); setT(112, 9, 3);

    /* 阶梯 */
    stairUp(64, 5); stairDown(68, 5);

    /* 金币弧线 */
    for (c = 32; c < 38; c++) setT(c, 8 - Math.abs(c - 35), 13);

    /* 通往旗杆的攀登台 */
    setT(128, 10, 6); setT(130, 9, 6); setT(132, 8, 6);

    /* 旗杆（11 = 杆，12 = 旗顶；底部地面由加载器兜底） */
    for (r = 3; r <= 11; r++) setT(138, r, 11);
    setT(138, 12, 12);
  }
};
