/* =====================================================================
 *  超级玛丽改造6 —— 「直达第三关道具」（注入模式测试道具）
 *  ==============================================================
 *  作用：标题界面出现「⚡ 直达第三关」道具按钮（或按数字 3），
 *        点击后一键进入 WORLD 1-3。也可用 URL ?level=3 / #l3 自动进入。
 *
 *  设计原则（严格遵守「不碰源代码」）：
 *   - 本文件是一个【纯外部脚本】，所有改动都写在这里，游戏 .html 一行不改。
 *   - 通过 monkeypatch 包裹 buildLevel(level) 提供第三关地图（level===2），
 *     并设置 LAST_LEVEL=2，让 1-1 → 1-2 → 1-3 → GAME CLEAR 流程完整。
 *   - 悬浮按钮为独立 DOM 元素，不侵入游戏 HUD。
 *
 *  提交方式（平台任务系统，注入模式 / 模式 E）：
 *   - 勾选「注入模式」，assets 上传本文件（.js）+ 可选 超级玛丽-直达第三关道具.css
 *   - 合并后，玩家打开游戏入口 HTML 即自动生效（平台在 </body> 前内联执行本脚本）
 * ===================================================================== */
(function () {
  'use strict';

  function boot() {
    if (typeof game === 'undefined' || typeof buildLevel !== 'function' || typeof resetLevel !== 'function' || typeof setT !== 'function') {
      // 游戏尚未就绪（理论上注入在 </body> 前 = 游戏脚本之后，不会发生），等 load 兜底
      window.addEventListener('load', boot);
      return;
    }

    /* ------------------------------------------------------------------
     * 1) WORLD 1-3 地图（精简测试版：约 150 列，含坑洞/管道/阶梯/金币/敌人/旗杆）
     * ------------------------------------------------------------------ */
    function buildLevel3() {
      var COLS3 = 150;
      var c, r;
      piranhaSpawns = [{ col: 28 }, { col: 110 }];
      // 按新列宽重建 grid
      if (!grid.length || grid[0].length !== COLS3) {
        grid = [];
        for (r = 0; r < ROWS; r++) grid.push(new Array(COLS3).fill(0));
      } else {
        for (r = 0; r < ROWS; r++) for (c = 0; c < COLS3; c++) grid[r][c] = 0;
      }
      COLS = COLS3;
      LEVEL_W = COLS * T;
      FLAG_COL = 138; CASTLE_COL = 144; DOOR_X = (CASTLE_COL + 2.4) * T;

      // 坠落缺口（坑洞）
      var gaps = { 40: 1, 41: 1, 80: 1, 81: 1, 82: 1, 120: 1, 121: 1 };
      for (c = 0; c < COLS; c++) if (!gaps[c]) { grid[13][c] = 1; grid[14][c] = 1; }

      // 起始 ? 块（蘑菇）+ 砖
      setT(10, 9, 3); setT(12, 9, 2); setT(13, 9, 4); setT(14, 9, 2); setT(18, 9, 3);

      // 管道（部分寄生食人花）
      pipe(24, 11); pipe(60, 10); pipe(98, 9);

      // 浮空砖平台 + 空中 ? 块
      for (c = 46; c <= 49; c++) setT(c, 8, 2);
      for (c = 88; c <= 91; c++) setT(c, 8, 2);
      setT(55, 9, 3); setT(76, 9, 3); setT(112, 9, 3);

      // 阶梯
      stairUp(64, 5); stairDown(68, 5);

      // 金币弧线
      for (c = 32; c < 38; c++) setT(c, 8 - Math.abs(c - 35), 13);

      // 通往旗杆的攀登台
      setT(128, 10, 6); setT(130, 9, 6); setT(132, 8, 6);

      // 旗杆 + 城堡
      setT(FLAG_COL, 12, 12);
      for (r = 3; r <= 11; r++) setT(FLAG_COL, r, 11);

      // 地面敌人（板栗 / 乌龟）
      enemySpawns = [
        { x: 16 * T + 2, y: 13 * T - 28 }, { x: 36 * T + 2, y: 13 * T - 28, t: 'koopa' },
        { x: 52 * T + 2, y: 13 * T - 28 }, { x: 70 * T + 2, y: 13 * T - 28 },
        { x: 100 * T + 2, y: 13 * T - 28, t: 'koopa' }, { x: 118 * T + 2, y: 13 * T - 28 },
        { x: 130 * T + 2, y: 13 * T - 28 }
      ];
    }

    // monkeypatch：level===2 走自建 1-3，其余走原逻辑（不碰源码）
    var _origBuild = buildLevel;
    buildLevel = function (level) {
      if (level === 2) { buildLevel3(); return; }
      _origBuild(level);
    };
    // 打通 1-3 关卡流程：1-3 通关 = GAME CLEAR
    LAST_LEVEL = 2;

    /* ------------------------------------------------------------------
     * 2) 「直达第三关」道具：状态切换 + 悬浮按钮 + 键盘 3 + URL 参数
     * ------------------------------------------------------------------ */
    function goLevel3() {
      if (typeof resetLevel !== 'function') return;
      game.level = 2;
      game.levelName = '1-3';
      resetLevel();
      game.state = 'play';
    }

    // 悬浮道具按钮（内联样式自包含，不依赖外部 css 也能用）
    var btn = document.createElement('button');
    btn.id = 'allinone-go-l3';
    btn.textContent = '⚡ 直达第三关';
    btn.setAttribute('title', '使用道具：一键进入 WORLD 1-3');
    btn.style.cssText =
      'position:fixed;bottom:18px;right:18px;z-index:99999;padding:10px 18px;' +
      'font:bold 15px system-ui,sans-serif;color:#0e1230;background:linear-gradient(180deg,#ffe28a,#f8a200);' +
      'border:2px solid #9a6a00;border-radius:999px;cursor:pointer;' +
      'box-shadow:0 4px 14px rgba(248,162,0,.45);transition:transform .12s;' +
      'pointer-events:auto;';
    btn.onmouseover = function () { btn.style.transform = 'scale(1.06)'; };
    btn.onmouseout = function () { btn.style.transform = 'scale(1)'; };
    btn.onclick = function () {
      if (game.state === 'title' || game.state === 'gameover' || game.state === 'cleared' || game.state === 'play') {
        goLevel3();
      }
    };
    document.body.appendChild(btn);

    // 标题界面按数字「3」直达第三关
    document.addEventListener('keydown', function (e) {
      if (e.key === '3' && (game.state === 'title' || game.state === 'gameover')) {
        e.preventDefault();
        goLevel3();
      }
    });

    // URL ?level=3 / #l3 自动直达（改造6 被平台 iframe 加载时也适用）
    if (location.hash === '#l3' || /[?&]level=3/.test(location.search)) {
      goLevel3();
    }

    console.log('[Mario 直达第三关道具] 已注入：按钮 / 按 3 / ?level=3 均可进入 WORLD 1-3');
  }

  if (typeof game !== 'undefined' && typeof buildLevel === 'function') {
    boot();
  } else {
    window.addEventListener('load', boot);
  }
})();
