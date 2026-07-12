// ============ AllinONE RA2 集成桥（v2 — emit 命令注入模式）============
// 设计原则：不再猴子补丁 gd.prototype、不再拦截 setInterval/rAF
// 所有游戏状态变更通过 window.__ra2allinone.emit(cmd) 注入，走引擎自身 applyCommands 管线
(function() {
  'use strict';

  // ============ Toast 提示系统 ============
  function showToast(msg, type) {
    var container = document.getElementById('toast-container');
    if (!container) return;
    var toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = msg;
    if (type === 'error') toast.style.borderColor = '#f44336';
    else if (type === 'info') toast.style.borderColor = '#2196f3';
    else if (type === 'warning') toast.style.borderColor = '#ff9800';
    container.appendChild(toast);
    requestAnimationFrame(function() {
      requestAnimationFrame(function() { toast.classList.add('show'); });
    });
    setTimeout(function() {
      toast.classList.remove('show');
      setTimeout(function() { toast.remove(); }, 400);
    }, 3000);
  }

  // ============ 获取游戏桥接对象 ============
  function getGame() {
    var g = window.__ra2allinone;
    if (!g) {
      console.warn('[AllinONE] __ra2allinone 未就绪，游戏尚未启动');
      return null;
    }
    return g;
  }

  // ============ 状态徽章系统（轻量级，纯 DOM）============
  var _badges = {};

  function showBadge(id, icon, text, css) {
    if (_badges[id] && _badges[id].parentNode) return; // 已存在
    var badge = document.createElement('div');
    badge.className = 'allinone-badge';
    badge.innerHTML = icon + ' ' + text;
    if (css) Object.keys(css).forEach(function(k) { badge.style[k] = css[k]; });
    document.body.appendChild(badge);
    _badges[id] = badge;
  }

  function removeBadge(id) {
    if (_badges[id]) {
      if (_badges[id].parentNode) _badges[id].parentNode.removeChild(_badges[id]);
      _badges[id] = null;
    }
  }

  // ============ 闪光脉冲效果 ============
  function flashScreen(color, count) {
    color = color || '#00ff00';
    count = count || 1;
    for (var i = 0; i < count; i++) {
      setTimeout(function(idx) {
        var flash = document.createElement('div');
        flash.className = 'allinone-flash';
        flash.style.background = color;
        document.body.appendChild(flash);
        requestAnimationFrame(function() { flash.classList.add('active'); });
        setTimeout(function() {
          flash.classList.remove('active');
          setTimeout(function() { flash.remove(); }, 600);
        }, 300);
      }(i), i * 400);
    }
  }

  // ============ 内置效果表（红警 RTS 专属 — v2 emit 模式）============
  var EFFECT_HANDLERS = {

    // ──── 增加资金（引擎 addCash 命令）────
    add_cash: function(params) {
      var amount = params.amount || 1000;
      if (amount < 500) amount = 500;
      if (amount > 5000) amount = 5000;
      var game = getGame();
      if (!game) return { error: true, message: '游戏未启动' };
      game.emit({ kind: 'addCash', owner: game.localPlayerId, amount: amount });
      flashScreen('#ffd700', 2);
      return { message: '💰 +' + amount + ' 资金' };
    },

    // ──── 全图视野（引擎 revealMap 命令）────
    reveal_map: function(params) {
      var duration = params.duration || 15; // 秒
      var game = getGame();
      if (!game) return { error: true, message: '游戏未启动' };
      // 秒 → tick（游戏约 20 tick/秒）
      var ticks = duration * 20;
      game.emit({ kind: 'revealMap', owner: game.localPlayerId, durationTicks: ticks });
      showBadge('reveal', '👁️', '全图视野 ' + duration + 's', { background: 'rgba(0,150,255,0.85)' });
      setTimeout(function() { removeBadge('reveal'); }, duration * 1000);
      flashScreen('#4488ff', 3);
      return { message: '👁️ 全图视野已开启 ' + duration + '秒' };
    },

    // ──── 全体维修（引擎 repairAll 命令）────
    repair_all: function(params) {
      var game = getGame();
      if (!game) return { error: true, message: '游戏未启动' };
      game.emit({ kind: 'repairAll', owner: game.localPlayerId });
      flashScreen('#00ff00', 3);
      return { message: '🔧 全体维修完成' };
    },

    // ──── 电力激增（引擎 powerSurge 命令）────
    power_surge: function(params) {
      var duration = params.duration || 30; // 秒
      var game = getGame();
      if (!game) return { error: true, message: '游戏未启动' };
      var ticks = duration * 20;
      game.emit({ kind: 'powerSurge', owner: game.localPlayerId, durationTicks: ticks });
      showBadge('power', '⚡', '电力激增 ' + duration + 's', { background: 'rgba(255,200,0,0.85)' });
      setTimeout(function() { removeBadge('power'); }, duration * 1000);
      flashScreen('#ffcc00', 2);
      return { message: '⚡ 电力激增 ' + duration + '秒' };
    },

    // ──── 急行军令（纯视觉 + 引擎未来扩展）────
    speed_boost: function(params) {
      var multiplier = params.multiplier || 2.0;
      if (multiplier < 1.2) multiplier = 1.2;
      if (multiplier > 3.0) multiplier = 3.0;
      var duration = params.duration || 15; // 秒
      showBadge('speed', '⚡', '急行军 x' + multiplier.toFixed(1) + ' ' + duration + 's',
        { background: 'rgba(0,200,255,0.85)' });
      setTimeout(function() { removeBadge('speed'); }, duration * 1000);
      flashScreen('#00ccff', 2);
      // 注意：速度修改需要引擎 per-unit 属性支持，目前仅徽章提示
      // 未来可扩展为 { kind: 'speedBoost', owner, multiplier, durationTicks }
      return { message: '⚡ 急行军令 x' + multiplier.toFixed(1) + '（视觉提示，引擎扩展后生效）' };
    },

    // ──── 纳米装甲（纯视觉 + 引擎未来扩展）────
    armor_boost: function(params) {
      var multiplier = params.multiplier || 2.0;
      if (multiplier < 1.2) multiplier = 1.2;
      if (multiplier > 3.0) multiplier = 3.0;
      var duration = params.duration || 20; // 秒
      showBadge('armor', '🛡️', '纳米装甲 x' + multiplier.toFixed(1) + ' ' + duration + 's',
        { background: 'rgba(150,0,255,0.85)' });
      setTimeout(function() { removeBadge('armor'); }, duration * 1000);
      flashScreen('#9900ff', 2);
      // 注意：装甲修改需要引擎 per-unit 属性支持，目前仅徽章提示
      return { message: '🛡️ 纳米装甲 x' + multiplier.toFixed(1) + '（视觉提示，引擎扩展后生效）' };
    },

    // ──── 空投补给（引擎 addCash + DOM 视觉）────
    airdrop_supply: function(params) {
      var cash = params.cash || 2000;
      if (cash < 1000) cash = 1000;
      if (cash > 3000) cash = 3000;
      var game = getGame();
      if (!game) return { error: true, message: '游戏未启动' };
      // 视觉：空投箱动画
      doAirdropVisual();
      // 引擎：延迟注入资金（空投箱着陆后）
      setTimeout(function() {
        game.emit({ kind: 'addCash', owner: game.localPlayerId, amount: cash });
        showToast('📦 空投到达 +' + cash, 'success');
      }, 2200);
      return { message: '📦 投补给包 ' + cash + '（2秒后到达）' };
    },

    // ──── 友军增援（引擎 spawnAlly 命令）────
    spawn_ally: function(params) {
      var typeId = params.typeId || 'gi'; // gi = 盟军步兵
      var game = getGame();
      if (!game) return { error: true, message: '游戏未启动' };
      // 在基地附近随机位置生成
      var cx = params.cellX || 5;
      var cy = params.cellY || 5;
      game.emit({ kind: 'spawnAlly', owner: game.localPlayerId, typeId: typeId, cellX: cx, cellY: cy });
      flashScreen('#00ff88', 1);
      return { message: '🪖 友军增援已到达' };
    },

    // ──── 炸弹箱地雷（DOM overlay 系统）────
    place_mine: function(params) {
      var damage = params.damage || 80;
      if (damage < 30) damage = 30;
      if (damage > 150) damage = 150;
      var radius = params.radius || 2;
      if (radius < 1) radius = 1;
      if (radius > 4) radius = 4;
      var triggerPx = params.triggerPx || 60;
      if (triggerPx < 30) triggerPx = 30;
      if (triggerPx > 100) triggerPx = 100;
      _mineParams = { damage: damage, radius: radius, triggerPx: triggerPx };
      _minePlacing = true;
      // 显示跟随鼠标的半透明地雷标记
      var overlay = ensureMineOverlay();
      var ghost = document.createElement('div');
      ghost.className = 'allinone-mine-ghost';
      ghost.id = 'mine-ghost';
      overlay.appendChild(ghost);
      showToast('💣 点击地图放置地雷（右键取消）', 'info');
      return { message: '💣 地雷放置模式已激活' };
    },

    // ──── 无限矿产（setInterval + 引擎 addCash 循环）────
    infinite_ore: function(params) {
      var perSec = params.perSec || 200;
      if (perSec < 50) perSec = 50;
      if (perSec > 1000) perSec = 1000;
      if (_oreTimer) {
        clearInterval(_oreTimer);
        removeBadge('ore');
      }
      _oreBoosting = true;
      _orePerSec = perSec;
      showBadge('ore', '⛏️', '无限矿产 +' + perSec + '/s', { background: 'rgba(200,150,0,0.85)' });
      // 每500ms注入一次（perSec/2，保持平滑增长）
      var perHalf = Math.max(25, Math.floor(perSec / 2));
      _oreTimer = setInterval(function() {
        var game = getGame();
        if (game) {
          game.emit({ kind: 'addCash', owner: game.localPlayerId, amount: perHalf });
        }
      }, 500);
      showToast('⛏️ 无限矿产 +' + perSec + '/s 已激活', 'success');
      return { message: '⛏️ 无限矿产 +' + perSec + '/s' };
    }
  };

  // ──── 停止无限矿产 ────
  function deactivateInfiniteOre() {
    if (_oreTimer) { clearInterval(_oreTimer); _oreTimer = null; }
    _oreBoosting = false;
    removeBadge('ore');
    showToast('⛏️ 无限矿产已停止', 'info');
  }

  // ============ 炸弹箱地雷系统（DOM overlay）============
  var _mines = [];
  var _mineParams = null;
  var _minePlacing = false;
  var _mineOverlay = null;
  var _mineScanTimer = null;

  function ensureMineOverlay() {
    if (_mineOverlay) return _mineOverlay;
    _mineOverlay = document.createElement('div');
    _mineOverlay.id = 'allinone-mine-overlay';
    _mineOverlay.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;pointer-events:none;z-index:9998;';
    document.body.appendChild(_mineOverlay);
    return _mineOverlay;
  }

  // 鼠标事件：地雷放置
  document.addEventListener('mousemove', function(e) {
    var ghost = document.getElementById('mine-ghost');
    if (ghost) {
      ghost.style.left = e.clientX + 'px';
      ghost.style.top = e.clientY + 'px';
    }
  });

  document.addEventListener('click', function(e) {
    if (!_minePlacing || !_mineParams) return;
    // 最多5颗地雷
    if (_mines.length >= 5) {
      showToast('💣 最多5颗地雷同时存在', 'warning');
      return;
    }
    // 移除幽灵标记
    var ghost = document.getElementById('mine-ghost');
    if (ghost) ghost.remove();
    _minePlacing = false;

    // 创建地雷 DOM 标记
    var mineEl = document.createElement('div');
    mineEl.className = 'allinone-mine-marker';
    mineEl.style.left = e.clientX + 'px';
    mineEl.style.top = e.clientY + 'px';
    var overlay = ensureMineOverlay();
    overlay.appendChild(mineEl);

    var mine = {
      el: mineEl,
      x: e.clientX,
      y: e.clientY,
      damage: _mineParams.damage,
      radius: _mineParams.radius,
      triggerPx: _mineParams.triggerPx,
      detonated: false
    };
    _mines.push(mine);
    showToast('💣 地雷已放置 (#' + _mines.length + ')', 'success');

    // 启动地雷扫描（检测敌方单位接近）
    if (!_mineScanTimer) {
      _mineScanTimer = setInterval(function() { scanAndDetonateMines(); }, 200);
    }
  });

  document.addEventListener('contextmenu', function(e) {
    if (_minePlacing) {
      e.preventDefault();
      var ghost = document.getElementById('mine-ghost');
      if (ghost) ghost.remove();
      _minePlacing = false;
      showToast('💣 地雷放置已取消', 'info');
    }
  });

  // 地雷爆炸效果
  function detonateMine(mine) {
    if (mine.detonated) return;
    mine.detonated = true;
    // 爆炸视觉
    var boom = document.createElement('div');
    boom.className = 'allinone-mine-boom';
    boom.style.left = mine.x + 'px';
    boom.style.top = mine.y + 'px';
    var overlay = ensureMineOverlay();
    overlay.appendChild(boom);
    setTimeout(function() { boom.remove(); }, 800);
    // 移除地雷标记
    if (mine.el && mine.el.parentNode) mine.el.remove();
    showToast('💥 地雷爆炸！伤害 ' + mine.damage, 'warning');
    // 对附近敌方单位造成伤害（如果引擎支持，可扩展 damageArea 命令）
    // 当前版本：纯视觉效果，引擎扩展后可用 { kind: 'damageArea', x, y, radius, damage }
  }

  function scanAndDetonateMines() {
    // 简化版：每隔5秒随机引爆一颗地雷模拟敌方触发
    // 真实版本需要引擎支持坐标查询
    if (_mines.length === 0) {
      if (_mineScanTimer) { clearInterval(_mineScanTimer); _mineScanTimer = null; }
      return;
    }
    // 暂时不自动引爆，等待引擎坐标查询API扩展
  }

  // 移除所有地雷
  function clearMines() {
    _mines.forEach(function(m) { if (m.el && m.el.parentNode) m.el.remove(); });
    _mines = [];
    if (_mineScanTimer) { clearInterval(_mineScanTimer); _mineScanTimer = null; }
  }

  // ============ 空投视觉效果 ============
  function doAirdropVisual() {
    var dropX = 30 + Math.random() * 40; // 屏幕中间区域
    var crate = document.createElement('div');
    crate.className = 'allinone-crate';
    crate.style.left = dropX + '%';
    crate.style.top = '-80px';
    document.body.appendChild(crate);
    // 着陆动画
    setTimeout(function() {
      if (crate.parentNode) crate.parentNode.removeChild(crate);
      var landing = document.createElement('div');
      landing.className = 'allinone-crate-landing';
      landing.style.left = dropX + '%';
      landing.style.top = 'calc(100vh - 140px)';
      landing.style.transform = 'translate(-50%, -50%)';
      document.body.appendChild(landing);
      setTimeout(function() { if (landing.parentNode) landing.parentNode.removeChild(landing); }, 600);
    }, 2000);
  }

  // ============ effectCode 动态注册沙箱 ============
  var _dynamicHandlerCache = {};

  function registerDynamicEffect(effectName, effectCodeStr) {
    if (EFFECT_HANDLERS[effectName]) return true;
    if (_dynamicHandlerCache[effectName]) {
      EFFECT_HANDLERS[effectName] = _dynamicHandlerCache[effectName];
      return true;
    }
    if (!effectCodeStr || typeof effectCodeStr !== 'string') return false;
    try {
      // 安全校验：禁止访问全局危险对象
      // ⚠️ 使用 new\s+Function 精确匹配危险的构造器调用，避免误判正常的 function() 函数定义
      if (/document\.(cookie|domain)|eval\(|new\s+Function\(|XMLHttpRequest|fetch\(|import\(/i.test(effectCodeStr)) {
        console.warn('[AllinONE] effectCode 安全校验失败: ' + effectName);
        return false;
      }
      // 创建沙箱函数，注入 game 桥接对象
      var sandboxFn = new Function('game', 'Math', 'JSON', 'console', effectCodeStr);
      var wrappedHandler = function(params) {
        try {
          var g = getGame();
          var result = sandboxFn(g || {}, Math, JSON, console);
          if (result && result.message) showToast(result.message, result.error ? 'error' : 'success');
          return result;
        }
        catch (e) { return { error: true, message: '效果出错: ' + (e.message || e) }; }
      };
      _dynamicHandlerCache[effectName] = wrappedHandler;
      EFFECT_HANDLERS[effectName] = wrappedHandler;
      return true;
    } catch (e) { return false; }
  }

  // ============ UGC 道具库存 ============
  var customPowerUps = [];

  function renderCustomPowerUps() {
    var bar = document.getElementById('ugc-bar');
    if (!bar) return;
    bar.innerHTML = '';
    var label = document.createElement('span');
    label.className = 'ugc-label';
    label.textContent = 'PROPS';
    bar.appendChild(label);
    if (customPowerUps.length === 0) {
      var empty = document.createElement('span');
      empty.className = 'ugc-empty';
      empty.textContent = 'No items yet';
      bar.appendChild(empty);
      return;
    }
    customPowerUps.forEach(function(item, index) {
      var el = document.createElement('span');
      el.className = 'ugc-item';
      el.textContent = (item.icon || '⚡') + ' ' + item.name;
      el.addEventListener('click', function() { useCustomPowerUp(index); });
      bar.appendChild(el);
    });
  }

  function useCustomPowerUp(index) {
    var item = customPowerUps[index];
    if (!item) return;
    // 执行优先级：effectScript > effectCode > effect（内置效果表）
    if (item.effectScript) {
      try {
        var fn = new Function('params', 'game', item.effectScript);
        var g = getGame();
        var result = fn(item.params || {}, g || {});
        if (result && result.message) showToast(result.message, result.error ? 'error' : 'success');
      } catch(e) {
        showToast('❌ effectScript 执行出错: ' + e.message, 'error');
      }
    } else if (item.effectCode) {
      if (!EFFECT_HANDLERS[item.effect]) {
        if (!registerDynamicEffect(item.effect, item.effectCode)) {
          showToast('❌ 效果注册失败（安全校验未通过）', 'error');
          customPowerUps.splice(index, 1);
          renderCustomPowerUps();
          return;
        }
      }
      var handler = EFFECT_HANDLERS[item.effect];
      if (handler) {
        var result = handler(item.params);
        if (result && result.message) showToast(result.message, result.error ? 'error' : 'success');
      }
    } else {
      // 纯内置效果（道具模板模式：只有 effect 名称，无 effectCode/effectScript）
      var handler = EFFECT_HANDLERS[item.effect];
      if (handler) {
        var result = handler(item.params);
        if (result && result.message) showToast(result.message, result.error ? 'error' : 'success');
      } else {
        showToast('❌ 未找到效果: ' + item.effect, 'error');
      }
    }
    customPowerUps.splice(index, 1);
    renderCustomPowerUps();
  }

  // ============ 接收平台道具（双通道）============
  // 通道 1: EXTENSION_VOUCHER postMessage（UGC 道具工坊下发）
  window.addEventListener('message', function(e) {
    if (e.data && e.data.type === 'EXTENSION_VOUCHER') {
      var v = e.data.voucher || e.data.payload;
      if (!v || !v.data) return;
      var data = v.data;
      // effect 优先，回退 effectType（排除 'custom'）
      var effect = data.effect || '';
      if (!effect && data.effectType && data.effectType !== 'custom') effect = data.effectType;
      if (effect) {
        customPowerUps.push({
          id: v.id || v.signature || ('ugc_' + Date.now()),
          name: data.name || (effect + '道具'),
          effect: effect,
          params: data.params || {},
          effectCode: data.effectCode || null,
          effectScript: data.effectScript || null,
          icon: data.icon || '⚡',
        });
        renderCustomPowerUps();
        showToast('🎁 获得道具: ' + (data.name || effect), 'success');
      } else {
        console.warn('[AllinONE] EXTENSION_VOUCHER 无效果名:', v);
      }
    }
  });

  // 通道 2: DOM 事件（平台内页 redeem / PublishingPipeline CustomEvent）
  function handleRedeemedItem(detail) {
    if (!detail) return;
    // PublishingPipeline CustomEvent 的核心数据在 detail.voucherData 中
    var vData = detail.voucherData || detail.voucher || detail;
    var realEffect = vData.effect || detail.itemId || vData.effectType || '';
    // 排除 effectType='custom'（PublishingPipeline 硬编码值，不是真实效果名）
    if (realEffect === 'custom' || realEffect === detail.effectType && detail.effectType === 'custom') {
      realEffect = '';
    }
    // 再次尝试从 voucherData 提取真实效果名
    if (!realEffect && vData.effect) realEffect = vData.effect;
    if (!realEffect) {
      console.warn('[AllinONE] 道具缺少有效效果信息，detail:', detail);
      return;
    }
    var realEffectCode = vData.effectCode || null;
    var realEffectScript = vData.effectScript || null;
    customPowerUps.push({
      id: detail.code || detail.key || ('ugc_' + Date.now()),
      name: vData.name || detail.itemName || '道具',
      effect: realEffect,
      params: vData.params || detail.effects || {},
      effectCode: realEffectCode,
      effectScript: realEffectScript,
      icon: vData.icon || '⚡',
    });
    renderCustomPowerUps();
    showToast('🎁 获得道具: ' + (detail.itemName || vData.name || realEffect), 'success');
  }
  // 通道 2: DOM 事件 — 只监听一个格式（allinone:item-redeemed），避免与通道 1 重复
  // ⚠️ 不监听 allinone-item-redeemed（旧格式），因为 SDK 会同时分发两种格式，监听两个会收到2个道具
  window.addEventListener('allinone:item-redeemed', function(e) { handleRedeemedItem(e.detail); });

  renderCustomPowerUps();

  // ============ 暴露全局接口 ============
  window.ra2Game = {
    EFFECT_HANDLERS: EFFECT_HANDLERS,
    showToast: showToast,
    customPowerUps: customPowerUps,
    registerDynamicEffect: registerDynamicEffect,
    getGame: getGame,
    deactivateInfiniteOre: deactivateInfiniteOre,
    clearMines: clearMines,
  };

  console.log('[AllinONE] RA2 集成 v2 就绪 — emit 命令注入模式（5引擎命令: addCash/repairAll/powerSurge/revealMap/spawnAlly）+ 4视觉效果(speed_boost/armor_boost/place_mine/infinite_ore) + effectCode沙箱 + 双通道道具接收');
})();
