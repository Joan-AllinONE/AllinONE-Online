/**
 * 超级玛丽 · 脚本关卡示例（GameQuest 方案 B）
 *
 * 提交方式（任务中心提交面板）：
 *   - data：   [{ "id": "lvl2", "title": "第二关：空中花园", "cols": 150, "script": "level2.js" }]
 *   - assets：上传本文件（path = level2.js）
 *   - entryPoint / fragment 不填（这是数据关卡，不是独立页面）
 *
 * 接口约定：暴露 window.MarioLevel = { build(api) }
 * api 提供：
 *   - setT(c, r, v)     在 (列, 行) 画瓦片 v（0空 1地面 2砖 3问号金币 4问号蘑菇 6硬块 13金币）
 *   - pipe(c, topRow)   画 2 格宽管道（c 左列，topRow 顶部行）
 *   - stairUp(c0, n) / stairDown(c0, n)  画硬块台阶
 *   - setFlag(fc)       设置旗杆列（默认 cols-12）
 *   - setEnemies([c,..])  敌人出生列号数组
 *   - grid / T / ROWS / COLS  也可直接读写
 * 底部两行地面与末尾旗杆由游戏侧兜底，无需画。
 */
window.MarioLevel = {
  build: function (api) {
    var setT = api.setT;
    var pipe = api.pipe;
    var stairUp = api.stairUp;
    var stairDown = api.stairDown;
    var c;

    /* ---- 出生区（前 18 列留缓冲） ---- */
    setT(8, 9, 3);                          // 问号金币
    setT(12, 9, 2); setT(13, 9, 4); setT(14, 9, 2);   // 砖 + 问号蘑菇

    /* ---- 第一组管道 ---- */
    pipe(22, 11);
    pipe(34, 10);

    /* ---- 空中金币桥 ---- */
    for (c = 42; c <= 46; c++) setT(c, 7, 13);

    /* ---- 砖块高台 + 高处奖励 ---- */
    for (c = 52; c <= 58; c++) setT(c, 9, 2);
    setT(54, 5, 3);
    setT(55, 8, 13);

    /* ---- 台阶 ---- */
    stairUp(64, 4);
    stairDown(70, 4);

    /* ---- 第二组管道 ---- */
    pipe(80, 9);

    /* ---- 跳跃高台 ---- */
    for (c = 90; c <= 100; c++) setT(c, 7, 2);
    setT(93, 3, 13);
    setT(96, 3, 13);

    /* ---- 大台阶 ---- */
    stairUp(108, 6);
    stairDown(116, 6);

    /* ---- 终点区 ---- */
    pipe(126, 10);
    for (c = 132; c <= 136; c++) setT(c, 10, 13);

    /* ---- 敌人与旗杆 ---- */
    api.setEnemies([15, 28, 47, 68, 88, 110, 130]);
    api.setFlag(138);
  }
};
