// ============ AllinONE RA2 拓展包 v2 — 战术级 effectCode 支持 ============
// 设计：在「emit 命令注入」架构上新增 6 个引擎命令（由 world.applyCommands 处理）：
//   spawnPortal    在地图随机位置生成持续 N 秒的传送门，踏入单位被传送到敌方基地
//   nuclearStrike 随机位置空投核弹，3x3 范围爆炸 + 中心敌军恐慌（攻击减半）
//   panicArea      指定区域敌军陷入恐慌（攻击减半）N 秒
//   teleportUnit   立即将某单位瞬移到目标坐标
//   railgunMod     给指定类型单位（按 owner）加轨道炮：射程翻倍 + 炮弹穿透
//   airdropMod     给指定类型（默认 conscript 动员兵）开启「空降」能力（按 owner 生效）
//   airdrop        执行空投：选中的动员兵天降到目标点，落地造成范围伤害（砸击）
// 另注册 4 个 EFFECT_HANDLERS：space_rift / nuclear_strike / panic_zone / railgun_tank / airdrop_conscript
// 传送门/核爆/恐慌/伞兵动画在页面上下文（非 effectCode 沙箱）运行，可访问 document/setInterval/rAF
//
// 本文件可直接 <script src> 引入，也已内联进 红警复刻版v2.html（</body> 之前）。
(function () {
  'use strict';

  var CELL = 256; // 1 格 = 256 像素（与引擎 $r 一致）

  function getGame() { return window.__ra2allinone || null; }
  function getBridge() { return window.ra2Game || null; }

  // ---------- 通用视觉 overlay ----------
  function ensureOverlay(id) {
    var o = document.getElementById(id);
    if (o) return o;
    o = document.createElement('div');
    o.id = id;
    o.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;pointer-events:none;z-index:9997;';
    document.body.appendChild(o);
    return o;
  }

  // ---------- 样式注入 ----------
  function injectStyles() {
    if (document.getElementById('allinone-ext-style')) return;
    var css = [
      '.allinone-portal{position:absolute;width:96px;height:96px;margin:-48px 0 0 -48px;border-radius:50%;',
      'background:radial-gradient(circle,rgba(190,90,255,0.9) 0%,rgba(130,40,210,0.4) 45%,transparent 72%);',
      'box-shadow:0 0 34px 10px rgba(190,90,255,0.75);animation:portalSpin 1.2s linear infinite;}',
      '.allinone-portal.teleport-burst{box-shadow:0 0 70px 26px rgba(255,255,255,0.95);}',
      '@keyframes portalSpin{from{transform:rotate(0) scale(1);}to{transform:rotate(360deg) scale(1.1);}}',
      '.allinone-nuke{position:absolute;width:48px;height:48px;margin:-24px 0 0 -24px;border-radius:50%;',
      'background:radial-gradient(circle,#fff 0%,#ffd34d 28%,#ff7a00 62%,transparent 78%);',
      'animation:nukePop .55s ease-out forwards;}',
      '@keyframes nukePop{from{transform:scale(.2);opacity:1;}to{transform:scale(13);opacity:0;}}',
      '.allinone-nuke-ring{position:absolute;width:24px;height:24px;margin:-12px 0 0 -12px;border-radius:50%;',
      'border:7px solid rgba(255,180,40,0.9);animation:nukeRing 1.25s ease-out forwards;}',
      '@keyframes nukeRing{from{transform:scale(1);opacity:.9;}to{transform:scale(46);opacity:0;}}',
      '.allinone-panic{position:absolute;width:30px;height:30px;margin:-15px 0 0 -15px;',
      'border-radius:50%;background:radial-gradient(circle,rgba(255,60,60,0.85),transparent 70%);',
      'animation:panicPulse .8s ease-in-out infinite;}',
      '@keyframes panicPulse{from{transform:scale(.6);opacity:.9;}to{transform:scale(1.4);opacity:.2;}}',
      '.allinone-para{position:absolute;font-size:30px;line-height:1;margin:-15px 0 0 -15px;pointer-events:none;text-shadow:0 2px 3px rgba(0,0,0,.45);animation:paraSwing 1.4s ease-in-out infinite;z-index:9998;}',
      '@keyframes paraSwing{0%,100%{transform:rotate(-7deg);}50%{transform:rotate(7deg);}}',
      '.allinone-impact{position:absolute;width:26px;height:26px;margin:-13px 0 0 -13px;border-radius:50%;border:5px solid rgba(255,210,90,.95);box-sizing:border-box;animation:impactPop .7s ease-out forwards;pointer-events:none;z-index:9998;}',
      '@keyframes impactPop{from{transform:scale(.4);opacity:.95;}to{transform:scale(6);opacity:0;}}',
      '.allinone-crash{position:absolute;font-size:26px;line-height:1;margin:-13px 0 0 -13px;pointer-events:none;animation:crashPop .7s ease-out forwards;z-index:9998;}',
      '@keyframes crashPop{from{transform:scale(.5);opacity:1;}to{transform:scale(1.8);opacity:0;}}'
    ].join('');
    var st = document.createElement('style');
    st.id = 'allinone-ext-style';
    st.textContent = css;
    document.head.appendChild(st);
  }

  // ---------- 屏幕坐标换算（兼容相机平移/缩放）----------
  // 注意：worldToScreen 定义在 Camera 上（引擎自身也用 this.camera.worldToScreen），
  // 而 g.view 是 GameView 实例，需经 g.view.camera 才能拿到正确屏幕坐标。
  function screenOf(g, x, y) {
    if (g && g.view && g.view.camera && g.view.camera.worldToScreen) {
      var p = g.view.camera.worldToScreen(x, y);
      return { x: p.x, y: p.y };
    }
    return { x: x, y: y }; // 退化：直接用世界坐标（仅在接口异常时）
  }

  // ---------- 核爆闪光 ----------
  function nukeFlash(x, y) {
    var g = getGame();
    var sp = screenOf(g, x, y);
    var sx = sp.x, sy = sp.y;
    var overlay = ensureOverlay('allinone-fx-overlay');
    var flash = document.createElement('div');
    flash.className = 'allinone-nuke';
    flash.style.left = sx + 'px'; flash.style.top = sy + 'px';
    overlay.appendChild(flash);
    setTimeout(function () { flash.remove(); }, 1300);
    var ring = document.createElement('div');
    ring.className = 'allinone-nuke-ring';
    ring.style.left = sx + 'px'; ring.style.top = sy + 'px';
    overlay.appendChild(ring);
    setTimeout(function () { ring.remove(); }, 1500);
  }

  // ---------- 工具：找敌方基地（建造场）中心 ----------
  function findEnemyBase(w, me) {
    var enemyId = -1;
    w.players.forEach(function (p) { if (p.id !== me) enemyId = p.id; });
    var tx = 5, ty = 5;
    w.entities.forEach(function (e) {
      if (e.owner === enemyId) {
        var def = w.rules.units.get(e.typeId);
        if (def && def.isConYard) { tx = e.cellX; ty = e.cellY; }
      }
    });
    return { x: tx * CELL + CELL / 2, y: ty * CELL + CELL / 2 };
  }

  // ---------- 传送门视觉 ----------
  function updatePortalVisual(p, g) {
    if (!p._el) {
      var overlay = ensureOverlay('allinone-portal-overlay');
      var el = document.createElement('div');
      el.className = 'allinone-portal';
      overlay.appendChild(el);
      p._el = el;
    }
    var sp = screenOf(g, p.x, p.y);
    var sx = sp.x, sy = sp.y;
    p._el.style.left = sx + 'px';
    p._el.style.top = sy + 'px';
    var remain = Math.max(0, (p.expiryTick - g.world.tick) / 20);
    p._el.title = '🌀 时空裂缝 剩余 ' + remain.toFixed(0) + 's';
  }
  function removePortalVisual(p) { if (p && p._el && p._el.parentNode) p._el.remove(); }
  function showPortalTeleportFx(p) {
    if (!p._el) return;
    p._el.classList.add('teleport-burst');
    setTimeout(function () { if (p._el) p._el.classList.remove('teleport-burst'); }, 400);
  }

  // ---------- 恐慌标记（核爆/恐慌力场命中的单位头顶红标）----------
  var _panicMarks = new Map(); // entityId -> div
  function updatePanicMarks(g, nowTick) {
    var w = g.world;
    var seen = new Set();
    w.entities.forEach(function (e) {
      if (e._panicUntil && e._panicUntil > nowTick && e.hp > 0) {
        seen.add(e.id);
        var el = _panicMarks.get(e.id);
        if (!el) {
          var overlay = ensureOverlay('allinone-panic-overlay');
          el = document.createElement('div');
          el.className = 'allinone-panic';
          overlay.appendChild(el);
          _panicMarks.set(e.id, el);
        }
        var sp = screenOf(g, e.x, e.y);
        el.style.left = sp.x + 'px';
        el.style.top = (sp.y - 30) + 'px';
        el.title = '😱 恐慌中（攻击减半）';
      }
    });
    // 清理已解除恐慌或已阵亡单位的标记
    _panicMarks.forEach(function (el, id) {
      if (!seen.has(id)) { if (el.parentNode) el.remove(); _panicMarks.delete(id); }
    });
  }

  // ---------- 伞兵空降动画（rAF 驱动，平滑下落）----------
  var _paraSprites = new Map(); // entityId -> div
  var _paraRaf = null;
  function spawnImpact(g, id) {
    if (!g || !g.world) return;
    var e = g.world.entities.get(id);
    if (!e) return;
    var sp = screenOf(g, e.x, e.y);
    var ov = ensureOverlay('allinone-impact-overlay');
    var ring = document.createElement('div');
    ring.className = 'allinone-impact';
    ring.style.left = sp.x + 'px'; ring.style.top = sp.y + 'px';
    ov.appendChild(ring);
    setTimeout(function () { if (ring.parentNode) ring.remove(); }, 720);
    var boom = document.createElement('div');
    boom.className = 'allinone-crash';
    boom.textContent = '💥';
    boom.style.left = sp.x + 'px'; boom.style.top = sp.y + 'px';
    ov.appendChild(boom);
    setTimeout(function () { if (boom.parentNode) boom.remove(); }, 720);
  }
  function paraLoop() {
    var g = getGame();
    if (g && g.world) {
      var w = g.world;
      var live = new Set();
      w.entities.forEach(function (e) {
        if (e._airborne) {
          live.add(e.id);
          var sp = screenOf(g, e.x, e.y);
          var total = e._airFallTotal || 45;
          var remain = Math.max(0, (e._airLandingTick || 0) - w.tick);
          var prog = Math.min(1, remain / total);
          var off = prog * 300; // 从目标点上方 300px 下落到地面
          var sway = Math.sin(Date.now() / 200 + e.id) * 6;
          var el = _paraSprites.get(e.id);
          if (!el) {
            var ov = ensureOverlay('allinone-para-overlay');
            el = document.createElement('div');
            el.className = 'allinone-para';
            el.textContent = '🪂';
            ov.appendChild(el);
            _paraSprites.set(e.id, el);
          }
          el.style.left = (sp.x + sway) + 'px';
          el.style.top = (sp.y - off) + 'px';
          el._landed = false;
        }
      });
      // 已落地或已消失的单位：触发尘环并清理精灵
      _paraSprites.forEach(function (el, id) {
        if (!live.has(id)) {
          if (!el._landed) { el._landed = true; spawnImpact(g, id); }
          if (el.parentNode) el.remove();
          _paraSprites.delete(id);
        }
      });
    }
    _paraRaf = requestAnimationFrame(paraLoop);
  }

  // ---------- 主扫描循环（页面上下文）----------
  var _portalScanTimer = null;
  var _lastSeenNuke = 0;
  function startScan() {
    if (_portalScanTimer) return;
    _portalScanTimer = setInterval(function () {
      var g = getGame();
      if (!g || !g.world) return;
      var w = g.world;

      // 核爆闪光监听（引擎命令 nuclearStrike 写入 w._lastNuke）
      if (w._lastNuke && w._lastNuke.at !== _lastSeenNuke) {
        _lastSeenNuke = w._lastNuke.at;
        nukeFlash(w._lastNuke.x, w._lastNuke.y);
      }

      if (!w._portals || w._portals.length === 0) return;
      var nowTick = w.tick;
      var expired = [];
      w._portals.forEach(function (p, idx) {
        if (nowTick > p.expiryTick) { expired.push(idx); return; }
        updatePortalVisual(p, g);
        // 扫描踏入传送门的单位（任何阵营都会触发，己方单位因此直插敌后）
        w.entities.forEach(function (e) {
          var dx = e.x - p.x, dy = e.y - p.y;
          if (dx * dx + dy * dy <= p.radius * p.radius) {
            var last = p.lastTele.get(e.id) || 0;
            if (nowTick - last > 20) { // 至少间隔 1 秒，避免原地抖动
              e.x = p.targetX; e.y = p.targetY;
              e.cellX = Math.floor(p.targetX / CELL);
              e.cellY = Math.floor(p.targetY / CELL);
              e.path = []; e.waypoint = null; e.goal = null;
              e.targetId = null; e.attackMove = false;
              p.lastTele.set(e.id, nowTick);
              showPortalTeleportFx(p);
            }
          }
        });
      });
      // 移除过期传送门（倒序 splice）
      expired.sort(function (a, b) { return b - a; }).forEach(function (i) {
        removePortalVisual(w._portals[i]);
        w._portals.splice(i, 1);
      });

      // 恐慌单位视觉标记（核爆 / 恐慌力场）
      updatePanicMarks(g, nowTick);
    }, 150);
  }

  // ---------- 新增 EFFECT_HANDLERS（可被 UGC 道具 effect 直接引用）----------
  var EXTRA_HANDLERS = {
    space_rift: function (params) {
      var g = getGame();
      if (!g || !g.world) return { error: true, message: '游戏未启动' };
      var w = g.world;
      var rx = Math.floor(Math.random() * w.terrain.width);
      var ry = Math.floor(Math.random() * w.terrain.height);
      var base = findEnemyBase(w, g.localPlayerId);
      g.emit({
        kind: 'spawnPortal',
        owner: g.localPlayerId,
        x: rx * CELL + CELL / 2, y: ry * CELL + CELL / 2,
        radius: (params && params.radius) || 170,
        durationSec: (params && params.durationSec) || 15,
        targetX: base.x, targetY: base.y
      });
      startScan();
      return { message: '🌀 时空裂缝开启！15 秒内踏入的单位将被传送至敌方基地内部' };
    },

    nuclear_strike: function (params) {
      var g = getGame();
      if (!g || !g.world) return { error: true, message: '游戏未启动' };
      var w = g.world;
      var rx = Math.floor(Math.random() * w.terrain.width);
      var ry = Math.floor(Math.random() * w.terrain.height);
      g.emit({
        kind: 'nuclearStrike',
        owner: g.localPlayerId,
        x: rx * CELL + CELL / 2, y: ry * CELL + CELL / 2,
        radiusCells: (params && params.radiusCells) || 3,
        damage: (params && params.damage) || 320,
        panicSec: (params && params.panicSec) || 5
      });
      startScan();
      return { message: '☢️ 核弹空投！3x3 范围爆炸，中心敌军恐慌 ' + ((params && params.panicSec) || 5) + ' 秒（攻击减半）' };
    },

    panic_zone: function (params) {
      var g = getGame();
      if (!g || !g.world) return { error: true, message: '游戏未启动' };
      var w = g.world;
      var base = findEnemyBase(w, g.localPlayerId);
      g.emit({
        kind: 'panicArea',
        owner: g.localPlayerId,
        x: base.x, y: base.y,
        radius: ((params && params.radius) || 3) * CELL,
        panicSec: (params && params.panicSec) || 5
      });
      return { message: '😱 恐慌力场！敌方基地单位攻击减半 ' + ((params && params.panicSec) || 5) + ' 秒' };
    },

    // 轨道炮灰熊：只强化「自己」的灰熊（按 owner 记录），射程翻倍 + 炮弹穿透
    railgun_tank: function (params) {
      var g = getGame();
      if (!g || !g.world) return { error: true, message: '游戏未启动' };
      var rangeMul = (params && params.rangeMul) || 2;
      var pierceWidth = (params && params.pierceWidth) || 48;
      g.emit({
        kind: 'railgunMod',
        owner: g.localPlayerId,
        typeId: 'grizzly',
        rangeMul: rangeMul,
        pierce: true,
        pierceWidth: pierceWidth
      });
      return { message: '🚀 轨道炮灰熊已部署！射程 x' + rangeMul + '，炮弹穿透成串敌军（仅己方灰熊）' };
    },

    // 空投动员兵：给「己方」动员兵(conscript)开启空降能力。框选后右键敌方目标，
    // 引擎把选中动员兵天降到该点，落地时对该点范围内敌军造成 AoE 砸击伤害。
    airdrop_conscript: function (params) {
      var g = getGame();
      if (!g || !g.world) return { error: true, message: '游戏未启动' };
      var fallTicks = (params && params.fallTicks) || 45;     // 下落时长（tick，20tick≈1s）
      var impactDamage = (params && params.impactDamage) || 90; // 落地砸击中心伤害
      var impactRadius = (params && params.impactRadius) || 256; // 砸击半径（像素，1格=256）
      g.emit({
        kind: 'airdropMod',
        owner: g.localPlayerId,
        typeId: (params && params.typeId) || 'conscript',
        fallTicks: fallTicks,
        impactDamage: impactDamage,
        impactRadius: impactRadius
      });
      return { message: '🪂 动员兵空降已就绪！框选动员兵 → 右键点击敌方目标，他们从天而降砸击（落地造成范围伤害）' };
    }
  };

  // ---------- 注册到 bridge 的 EFFECT_HANDLERS ----------
  function registerHandlers() {
    var b = getBridge();
    if (!b || !b.EFFECT_HANDLERS) return false;
    Object.keys(EXTRA_HANDLERS).forEach(function (k) {
      if (!b.EFFECT_HANDLERS[k]) b.EFFECT_HANDLERS[k] = EXTRA_HANDLERS[k];
    });
    return true;
  }

  // ---------- 启动 ----------
  injectStyles();
  startScan(); // 立即启动，核爆闪光在无声时也很轻量
  if (!_paraRaf) paraLoop(); // 启动伞兵下落动画（rAF 平滑）
  // 桥接对象可能稍后就绪，循环尝试注册直到成功
  var _regTry = setInterval(function () {
    if (registerHandlers()) { clearInterval(_regTry); }
  }, 300);

  // 调试入口
  window.ra2Ext = { EXTRA_HANDLERS: EXTRA_HANDLERS, findEnemyBase: findEnemyBase, CELL: CELL };

  console.log('[AllinONE] 拓展包 v2 就绪 — 新增命令: spawnPortal/nuclearStrike/panicArea/teleportUnit/railgunMod/airdropMod/airdrop；新增效果: space_rift/nuclear_strike/panic_zone/railgun_tank/airdrop_conscript');
})();
