/* =====================================================================
 *  超级玛丽 改造6 —— 第三关（WORLD 1-3「暗夜空岛」）扩展 MOD
 *  作者：AllinONE 二创辅助
 *
 *  设计原则（严格遵守「不碰源代码」）：
 *   - 本文件是一个【纯外部脚本】，所有改动都写在这里。
 *   - 通过 monkeypatch 包裹原游戏的全局函数（draw / enemiesUpdate /
 *     spawnEnemies / buildLevel）来注入新内容，绝不修改 改造6.html 内
 *     的任何一行游戏逻辑。
 *   - 第三关专属：暗色夜景 + 会飞的敌人「暗夜蝠」。1-1 / 1-2 维持白天。
 *
 *  加载方式（任选其一，都不需要改游戏逻辑）：
 *    A. 在 改造6.html 的 </body> 前加一行（唯一对源文件的「新增」）：
 *         <script src="超级玛丽-第三关MOD.js"></script>
 *    B. 零触碰：把书签里的代码拖到浏览器书签栏，进入游戏后点一下书签：
 *         javascript:(function(){var s=document.createElement('script');s.src='超级玛丽-第三关MOD.js';document.head.appendChild(s);})();
 *    C. 直接打开本文件所在目录的 改造6.html，并在网址后加 #l3 自动进第三关。
 *
 *  操作：标题界面按「3」可直接跳到第三关；或在网址加 #l3 / ?level=3。
 * ===================================================================== */
(function () {
  'use strict';

  function apply() {
    if (typeof draw === 'undefined' || typeof game === 'undefined' || typeof ctx === 'undefined') {
      console.warn('[Mario L3 Mod] 游戏尚未就绪，注入跳过。请确保本脚本在 改造6.html 之后加载。');
      return;
    }

    /* ------------------------------------------------------------------
     * 1) 暗色主题：白天调色板 -> 夜色调色板（仅第三关 game.level===2 生效）
     * ------------------------------------------------------------------ */
    var DAY2NIGHT = {
      '#5c94fc': '#0e1230',  // 天空 -> 深夜蓝
      '#c84c0c': '#5a2410',  // 地面砖
      '#7a2e08': '#3a1606',
      '#d8732a': '#7a3e16',  // 砖块
      '#8a3c10': '#4a2408',
      '#fac000': '#9a7a10',  // ? 块
      '#e08800': '#6a5a08',
      '#fff0b0': '#3a3550',
      '#8a4500': '#4a3008',
      '#9c5020': '#5a2e10',  // 用过砖
      '#6a3210': '#3a1e08',
      '#d8732a': '#7a3e16',  // 实心块
      '#fff0c0': '#3a3550',
      '#8a3c10': '#4a2408',
      '#11a012': '#0c5a10',  // 管道顶
      '#7ce07c': '#2a6a2a',
      '#005800': '#023002',
      '#0d8c0e': '#0a5a0c',  // 管道身
      '#6cd06c': '#2a6a2a',
      '#ffd400': '#caa800',  // 金币
      '#b07800': '#7a5400',
      '#b8e0b8': '#7a9a9a',  // 旗杆
      '#1e9e30': '#0f6b20',  // 旗/草
      '#0f7a1e': '#0a5214',
      '#27b53c': '#166b24',
      '#c84c0c': '#5a2410',  // 城堡
      '#8a3208': '#3a1606',
      '#101010': '#000000'
    };

    var _fsDesc = Object.getOwnPropertyDescriptor(CanvasRenderingContext2D.prototype, 'fillStyle');
    Object.defineProperty(ctx, 'fillStyle', {
      configurable: true,
      get: function () { return _fsDesc.get.call(this); },
      set: function (v) {
        if (game.level === 2 && typeof v === 'string' && DAY2NIGHT.hasOwnProperty(v)) v = DAY2NIGHT[v];
        _fsDesc.set.call(this, v);
      }
    });

    /* ------------------------------------------------------------------
     * 2) 飞行敌人「暗夜蝠」：独立数组 + 独立更新/绘制（不污染原敌人数组）
     * ------------------------------------------------------------------ */
    var flyEnemies = [];
    var flySpawns = [];

    // 蝙蝠像素精灵（12x9），K=身体黑，Y=发光眼；夜空里靠紫色光晕显形
    var BAT_A = [
      "....KKKK....",
      "..KKKKKKKK..",
      ".KKKKKKKKKK.",
      "KKYKKKKKKYKK",
      "KKKKKKKKKKKK",
      ".KKKKKKKKKK.",
      "..KKK..KKK..",
      "...KK..KK...",
      "....K..K...."
    ];
    var BAT_B = [
      "............",
      "....KKKK....",
      "..KKKKKKKK..",
      "KKYKKKKKKYKK",
      "KKKKKKKKKKKK",
      ".KKKKKKKKKK.",
      "..KKK..KKK..",
      "...KK..KK...",
      "....K..K...."
    ];

    function flyUpdate() {
      if (game.state !== 'play') return;
      for (var i = flyEnemies.length - 1; i >= 0; i--) {
        var f = flyEnemies[i];
        if (f.dead) { flyEnemies.splice(i, 1); continue; }
        f.t++;
        // 水平巡逻（在 x0..x1 之间来回）
        f.x += f.dir * f.speed;
        if (f.x <= f.x0) { f.x = f.x0; f.dir = 1; }
        else if (f.x >= f.x1) { f.x = f.x1; f.dir = -1; }
        // 垂直正弦浮动（飞行，无视重力/瓦片）
        f.y = f.baseY + Math.sin(f.t * f.freq + f.phase) * f.amp;
        // 与玩家碰撞：从上方踩扁；否则受伤
        if (overlap(player, f)) {
          var fromTop = player.vy > 0.5 && (player.y + player.h - f.y) < (f.h * 0.6);
          if (fromTop) {
            f.dead = true; player.vy = -7.5; addScore(200, f.x, f.y - 10); sfx('stomp');
          } else {
            damagePlayer();
          }
        }
      }
    }

    function drawFlyers() {
      flyEnemies.forEach(function (f) {
        if (f.dead) return;
        var dx = Math.round(f.x - camX), dy = Math.round(f.y);
        // 紫色光晕（让黑蝙蝠在夜空里显形）
        ctx.save();
        ctx.globalAlpha = 0.28;
        ctx.fillStyle = '#9b6bff';
        ctx.beginPath();
        ctx.arc(dx + f.w / 2, dy + f.h / 2, f.w * 0.72, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        var spr = (Math.floor(f.t / 6) % 2 === 0) ? BAT_A : BAT_B;
        drawSprite(spr, dx, dy, f.w, f.h, f.dir < 0);
      });
    }

    /* ------------------------------------------------------------------
     * 3) 夜空装饰：星空 + 月亮 + 暗角（叠加在已夜色化的场景之上）
     * ------------------------------------------------------------------ */
    var STARS = [];
    for (var si = 0; si < 70; si++) {
      STARS.push({
        x: 4 + Math.random() * (W - 8),
        y: 8 + Math.random() * 198,           // 仅屏幕上半部（瓦片最高到 y≈224）
        r: 0.5 + Math.random() * 1.3,
        p: Math.random() * Math.PI * 2
      });
    }
    function drawNightSky() {
      for (var i = 0; i < STARS.length; i++) {
        var s = STARS[i];
        var tw = 0.5 + 0.5 * Math.sin(tickN * 0.05 + s.p);
        ctx.save();
        ctx.globalAlpha = 0.45 + 0.55 * tw;
        ctx.fillStyle = '#dfe6ff';
        ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      }
      // 月亮（带阴影坑）
      ctx.save();
      ctx.fillStyle = '#e9e2b0';
      ctx.beginPath(); ctx.arc(W - 90, 70, 34, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(20,24,55,0.5)';
      ctx.beginPath(); ctx.arc(W - 78, 62, 30, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      // 暗角
      var g = ctx.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, H * 0.78);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(1, 'rgba(0,0,0,0.42)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    }

    /* ------------------------------------------------------------------
     * 4) 第三关地图构建（WORLD 1-3，200 列，夜空空岛 + 飞行敌人）
     * ------------------------------------------------------------------ */
    function coinArc(c0, row, n) {
      for (var i = 0; i < n; i++) {
        var rr = row - Math.round(Math.sin((i / (n - 1)) * Math.PI) * 2);
        setT(c0 + i, rr, 13);
      }
    }

    function buildLevel3() {
      COLS = 200;
      piranhaSpawns = [{ col: 28 }, { col: 140 }];
      // 按新列宽重建 grid
      if (!grid.length || grid[0].length !== COLS) {
        grid = [];
        for (var rr = 0; rr < ROWS; rr++) grid.push(new Array(COLS).fill(0));
      } else {
        for (var rr2 = 0; rr2 < ROWS; rr2++) for (var cc2 = 0; cc2 < COLS; cc2++) grid[rr2][cc2] = 0;
      }
      LEVEL_W = COLS * T;
      FLAG_COL = 186; CASTLE_COL = 192; DOOR_X = (CASTLE_COL + 2.4) * T;

      var c, r;
      // 坠落缺口（坑洞）
      var gaps = { 38: 1, 39: 1, 70: 1, 71: 1, 72: 1, 73: 1, 110: 1, 111: 1, 112: 1,
                   150: 1, 151: 1, 152: 1, 153: 1, 178: 1, 179: 1 };
      for (c = 0; c < COLS; c++) if (!gaps[c]) { grid[13][c] = 1; grid[14][c] = 1; }

      // 起始 ? 块（蘑菇）
      setT(10, 9, 3); setT(18, 9, 3);

      // 管道（部分寄生食人花）
      pipe(28, 11); pipe(60, 10); pipe(95, 9); pipe(140, 10);

      // 4 宽巨坑的踏脚石
      setT(71, 11, 6); setT(72, 11, 6);
      setT(151, 11, 6); setT(152, 11, 6);

      // 浮空砖平台（上方放金币）
      for (c = 45; c <= 48; c++) setT(c, 8, 2);
      for (c = 100; c <= 104; c++) setT(c, 8, 2);
      for (c = 140; c <= 144; c++) setT(c, 8, 2);

      // 空中 ? 块
      setT(55, 9, 3); setT(90, 9, 3); setT(130, 9, 3); setT(165, 9, 3);

      // 金币弧线
      coinArc(24, 7, 5); coinArc(80, 7, 6); coinArc(120, 7, 6); coinArc(160, 7, 5);

      // 阶梯
      stairUp(114, 5); stairDown(119, 5);

      // 通往旗杆的垂直攀登台
      setT(156, 10, 6); setT(158, 9, 6); setT(160, 8, 6); setT(162, 7, 6); setT(164, 6, 6);

      // 旗杆 + 城堡
      setT(FLAG_COL, 12, 12);
      for (r = 3; r <= 11; r++) setT(FLAG_COL, r, 11);

      // 地面敌人（板栗 / 乌龟）
      enemySpawns = [
        { x: 14 * T + 2, y: 13 * T - 28 }, { x: 34 * T + 2, y: 13 * T - 28, t: 'koopa' },
        { x: 50 * T + 2, y: 13 * T - 28 }, { x: 64 * T + 2, y: 13 * T - 28 },
        { x: 84 * T + 2, y: 13 * T - 28, t: 'koopa' }, { x: 98 * T + 2, y: 13 * T - 28 },
        { x: 108 * T + 2, y: 13 * T - 28 }, { x: 122 * T + 2, y: 13 * T - 28, t: 'koopa' },
        { x: 138 * T + 2, y: 13 * T - 28 }, { x: 155 * T + 2, y: 13 * T - 28 },
        { x: 168 * T + 2, y: 13 * T - 28 }, { x: 175 * T + 2, y: 13 * T - 28 }
      ];

      // 会飞的敌人（暗夜蝠）—— 仅第三关
      flySpawns = [
        { x: 35, baseY: 6, amp: 1.2, freq: 0.040, range: 4 },
        { x: 65, baseY: 5, amp: 1.5, freq: 0.050, range: 4 },
        { x: 88, baseY: 7, amp: 1.0, freq: 0.045, range: 5 },
        { x: 105, baseY: 5.5, amp: 1.3, freq: 0.050, range: 4 },
        { x: 125, baseY: 6.5, amp: 1.1, freq: 0.040, range: 5 },
        { x: 145, baseY: 5, amp: 1.6, freq: 0.055, range: 4 },
        { x: 162, baseY: 7, amp: 1.2, freq: 0.045, range: 5 },
        { x: 172, baseY: 6, amp: 1.4, freq: 0.050, range: 4 }
      ];
    }

    function buildFlyers() {
      flyEnemies.length = 0;
      (flySpawns || []).forEach(function (s) {
        var sx = s.x * T;
        var baseY = s.baseY * T;
        flyEnemies.push({
          x: sx, y: baseY, w: 30, h: 24,
          baseY: baseY, amp: s.amp * T, freq: s.freq, phase: Math.random() * Math.PI * 2,
          speed: 1.1, dir: Math.random() < 0.5 ? -1 : 1,
          x0: sx - s.range * T, x1: sx + s.range * T,
          t: Math.floor(Math.random() * 60), dead: false
        });
      });
    }

    /* ------------------------------------------------------------------
     * 5) 包裹原游戏函数（monkeypatch，不改源码）
     * ------------------------------------------------------------------ */
    var _origDraw = draw;
    draw = function () {
      _origDraw();
      if (game.level === 2 && (game.state === 'play' || game.state === 'flag' ||
          game.state === 'walkoff' || game.state === 'dying')) {
        drawNightSky();
        drawFlyers();
      }
    };

    var _origEU = enemiesUpdate;
    enemiesUpdate = function () {
      _origEU();
      if (game.level === 2) flyUpdate();
    };

    var _origSpawn = spawnEnemies;
    spawnEnemies = function () {
      _origSpawn();
      if (game.level === 2) buildFlyers();
      else flyEnemies.length = 0;   // 非第三关清空，避免残留惰性数据
    };

    var _origBuild = buildLevel;
    buildLevel = function (level) {
      if (level === 2) { buildLevel3(); return; }
      _origBuild(level);
    };

    // 接入第三关流程：原 1-1 / 1-2 通关后进入 1-3；1-3 通关为 GAME CLEAR
    LAST_LEVEL = 2;

    // 调试/检视句柄（只读引用，不影响游戏逻辑）
    window.MarioL3 = { flyEnemies: flyEnemies, flyUpdate: flyUpdate, get level() { return game.level; } };

    /* ------------------------------------------------------------------
     * 6) 便捷入口：标题界面按「3」直接进第三关；网址 #l3 / ?level=3 自动进
     * ------------------------------------------------------------------ */
    document.addEventListener('keydown', function (e) {
      if (game.state === 'title' && (e.key === '3')) {
        e.preventDefault();
        game.level = 2; game.levelName = '1-3'; resetLevel(); game.state = 'play';
      }
    });
    if (location.hash === '#l3' || /[?&]level=3/.test(location.search)) {
      game.level = 2; game.levelName = '1-3'; resetLevel(); game.state = 'play';
    }

    // 注入可选的夜色 CSS（仅画面点缀，不依赖外部 css 文件也可用）
    try {
      var st = document.createElement('style');
      st.textContent = 'canvas{box-shadow:0 0 42px rgba(80,110,220,.28);}' +
        'body{background:#05060f !important;}';
      document.head.appendChild(st);
    } catch (e) { /* 忽略 */ }

    console.log('[Mario L3 Mod] 已注入：暗夜空岛（WORLD 1-3）+ 飞行敌人「暗夜蝠」');
  }

  // 确保游戏脚本已先执行（放在 </body> 前即可）；否则等 load 事件
  if (typeof draw !== 'undefined' && typeof game !== 'undefined' && typeof ctx !== 'undefined') {
    apply();
  } else {
    window.addEventListener('load', apply);
  }
})();
