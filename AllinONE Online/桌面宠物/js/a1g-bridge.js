/* ==========================================================
 * a1g-bridge.js — AllinONE 游戏平台接入桥（指南 v3.2）
 *
 * 五段代码全部集中在这里，index.html 只需一行 <script>：
 *   A 扩展内容加载器（任务广场）  slot = skills / skins
 *   B 内容工坊接收器              slot = skills / skins
 *   C 道具双通道（EFFECT_HANDLERS + effectCode 沙箱）
 *   D 道具提取通道（ITEM_HARVEST）
 *   E 游戏奖励活动上报（GAME_EVENT）
 *
 * 设计前提：桌宠的天然扩展点就是「技能」与「皮肤」——
 *   技能 = scripts 型扩展（玩家提交一个调用 PetSkills.register 的 js）
 *   皮肤 = data 型扩展（玩家提交一份 {name, image, css} JSON）
 *
 * 铁律：
 *   1. 无 ?ext= → 纯净原版，绝不加载任何带 _submissionId 的条目
 *   2. 直接双击打开 HTML / Electron 桌面模式下，全部功能静默关闭
 *   3. 任何一步失败都降级，绝不影响桌宠本身运行
 * ========================================================== */
(function () {
  'use strict';

  /* ---------------- 通用 ---------------- */
  function inIframe() {
    try { return !!(window.parent && window.parent !== window); } catch (e) { return false; }
  }
  function log() {
    if (!window.console) return;
    try { console.log.apply(console, ['[A1G]'].concat([].slice.call(arguments))); } catch (e) {}
  }
  function warn() {
    if (!window.console) return;
    try { console.warn.apply(console, ['[A1G]'].concat([].slice.call(arguments))); } catch (e) {}
  }

  /* ==========================================================
   * 代码段 A：扩展内容加载器（任务广场）
   * ========================================================== */
  var A1G_EXT = {
    gameId: '',
    started: false,
    assetPaths: [],
    skills: [],      // 过滤后的扩展技能
    skins: [],       // 过滤后的扩展皮肤
    applied: []      // 已应用记录 { kind, name, ids }
  };

  function a1gApiBase() {
    if (/tcloudbaseapp\.com$/.test(location.hostname)) {
      return 'https://allinonegaming-d4gmsmrzz573264f6.service.tcloudbase.com/api/v1/games';
    }
    return '/api/v1/games';
  }

  /* gameId 三个来源：① URL path ② ?gameId= ③ 平台 PROTOCOL:INIT */
  function a1gDetectGameId() {
    var m = location.pathname.match(/\/api\/v1\/games\/([^\/]+?)(\/|$)/);
    if (m) { try { return decodeURIComponent(m[1]); } catch (e) { /* ignore */ } }
    try {
      var q = new URLSearchParams(location.search);
      if (q.get('gameId')) return q.get('gameId');
    } catch (e) { /* ignore */ }
    return '';
  }

  function a1gExtParam() {
    try { return new URLSearchParams(location.search).get('ext') || ''; } catch (e) { return ''; }
  }

  function a1gEncodePath(p) {
    return String(p).split('/').map(function (s) { return encodeURIComponent(s); }).join('/');
  }

  /* 兼容历史嵌套：旧 merge 曾把数组整体 push，产生 [[{...}]] */
  function a1gFlatten(arr) {
    var out = [];
    (arr || []).forEach(function (it) {
      if (Array.isArray(it)) it.forEach(function (x) { out.push(x); });
      else out.push(it);
    });
    return out;
  }

  /* 铁律：无 ?ext= = 纯净原版；有 ?ext= = 原版 + 该扩展 */
  function a1gFilter(list) {
    var ext = a1gExtParam();
    return (list || []).filter(function (it) {
      if (!it || typeof it !== 'object') return false;
      if (!ext) return !it._submissionId;
      return !it._submissionId || it._submissionId === ext;
    });
  }

  /* 相对路径 → 扩展资源完整路径（三级回退） */
  function a1gResolveAsset(rel) {
    var s = rel ? String(rel) : '';
    if (!s) return s;
    if (s.indexOf('extensions/') === 0) return s;
    for (var i = 0; i < A1G_EXT.assetPaths.length; i++) {
      var p = A1G_EXT.assetPaths[i];
      if (p === s || p.indexOf('/' + s) >= 0) return p;
      if (p.split('/').pop() === s.split('/').pop()) return p;
    }
    return s;
  }

  function a1gFetchText(src) {
    return fetch(a1gApiBase() + '/' + encodeURIComponent(A1G_EXT.gameId) + '/files/' + a1gEncodePath(src),
      { cache: 'no-cache' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    });
  }

  /* 脚本用 Blob URL + <script> 执行，不用裸 eval */
  function a1gRunCode(code) {
    return new Promise(function (resolve, reject) {
      try {
        var url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
        var s = document.createElement('script');
        s.src = url;
        s.onerror = function () { URL.revokeObjectURL(url); reject(new Error('脚本执行失败')); };
        s.onload = function () { URL.revokeObjectURL(url); resolve(); };
        document.head.appendChild(s);
      } catch (e) { reject(e); }
    });
  }

  function a1gRunScript(src) {
    return a1gFetchText(a1gResolveAsset(src)).then(a1gRunCode);
  }

  /* ★ 应用一个扩展技能（脚本型：执行后 diff 出新增的技能） */
  function a1gApplySkill(entry) {
    return new Promise(function (resolve) {
      var before = {};
      if (window.PetSkills) {
        window.PetSkills.list().forEach(function (s) { before[s.id] = 1; });
      }
      function finish() {
        var added = [];
        if (window.PetSkills) {
          added = window.PetSkills.list().filter(function (s) { return !before[s.id]; });
        }
        A1G_EXT.applied.push({
          kind: 'skill',
          name: entry.name || entry.id || '扩展技能',
          ids: added.map(function (s) { return s.id; })
        });
        log('应用扩展技能:', entry.name || entry.id, '→ 新增', added.length, '个');
        resolve(added.length > 0);
      }
      if (window.__A1G_SKILL_DEF__) delete window.__A1G_SKILL_DEF__;
      var p;
      if (entry.script) p = a1gRunScript(entry.script);
      else if (entry.code) p = a1gRunCode(entry.code);
      else p = Promise.resolve();
      p.then(function () {
        /* 也支持脚本只声明 window.__A1G_SKILL_DEF__，由桥代为注册 */
        if (window.__A1G_SKILL_DEF__ && window.PetSkills) {
          try { window.PetSkills.register(window.__A1G_SKILL_DEF__); } catch (e) { warn('注册失败', e); }
          delete window.__A1G_SKILL_DEF__;
        }
      }).catch(function (e) { warn('扩展技能加载失败', e); }).then(finish);
    });
  }

  /* ★ 应用一个扩展皮肤（数据型，防御式兜底） */
  function a1gApplySkin(skin) {
    if (!skin || typeof skin !== 'object') return false;
    if (!skin.name) return false;                      // 必填字段缺失 → 拒绝
    try {
      if (skin.css && String(skin.css).length < 20000) {
        var st = document.createElement('style');
        st.textContent = skin.css;
        st.setAttribute('data-a1g-skin', skin.id || skin.name);
        document.head.appendChild(st);
      }
      var img = skin.image || skin.asset || '';
      if (img && window.PetAppearance) {
        var src = img;
        if (!/^(data:|https?:|blob:)/.test(src)) {
          /* 相对路径 → 先按三级回退解析，再拼成平台文件地址 */
          src = a1gApiBase() + '/' + encodeURIComponent(A1G_EXT.gameId) +
                '/files/' + a1gEncodePath(a1gResolveAsset(src));
        }
        var probe = new Image();
        /* 加载成功才切换形象，失败保留原样（防御式兜底）。
         * persist:false —— 平台皮肤按次生效，不写入持久存档（刷新即还原原形象） */
        probe.onload = function () { window.PetAppearance.setCustomImage(src, { persist: false }); };
        probe.onerror = function () { warn('皮肤图片加载失败，已保留原形象:', src); };
        probe.src = src;
      }
      A1G_EXT.applied.push({ kind: 'skin', name: skin.name, ids: [skin.id || skin.name] });
      log('应用扩展皮肤:', skin.name);
      return true;
    } catch (e) {
      warn('皮肤应用失败', e);
      return false;
    }
  }

  function a1gLoadExtensions() {
    var id = A1G_EXT.gameId || a1gDetectGameId();
    if (!id || A1G_EXT.started) return;
    A1G_EXT.gameId = id;
    A1G_EXT.started = true;

    fetch(a1gApiBase() + '/' + encodeURIComponent(id), { cache: 'no-cache' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (json) {
        if (!json) return;
        var doc = json && json.data ? json.data : json;

        var exts = Array.isArray(doc.questExtensions) ? doc.questExtensions : [];
        var paths = [];
        exts.forEach(function (e) {
          if (e && Array.isArray(e.assets)) {
            e.assets.forEach(function (a) { if (a && a.path) paths.push(a.path); });
          }
        });
        A1G_EXT.assetPaths = paths;

        A1G_EXT.skills = a1gFilter(a1gFlatten(doc.skills));
        A1G_EXT.skins = a1gFilter(a1gFlatten(doc.skins));

        log('扩展内容：技能', A1G_EXT.skills.length, '皮肤', A1G_EXT.skins.length);

        A1G_EXT.skins.forEach(a1gApplySkin);
        /* 技能脚本串行加载，避免并发 diff 互相干扰 */
        A1G_EXT.skills.reduce(function (chain, sk) {
          return chain.then(function () { return a1gApplySkill(sk); });
        }, Promise.resolve());
      })
      .catch(function () { warn('扩展内容加载失败，已降级为原版'); });
  }

  /* ==========================================================
   * 代码段 B：内容工坊接收器（内容凭证 · 按次生效）
   * ========================================================== */
  function a1gRegisterContentHandlers() {
    function onPack(pack) {
      if (!pack) return;
      if (pack.slot === 'skins') { a1gApplySkin(pack.data); return; }
      if (pack.slot === 'skills') { a1gApplySkill(pack.data || {}); return; }
    }
    /* 方式一（v3.2 时序铁律 · 主注册）：全局挂载表。
     * loader 在 apply() 时才读取本表，任何时机设置都有效，不依赖 loader 注入顺序。
     * （反例：赌石小游戏只用 loader.on() 且早于 loader 定义，条件守卫被静默跳过，
     *  内容凭证永不生效——平台 2026-09-18 已改为 head 注入根治，但挂载表写法对
     *  任何注入顺序都安全，故一律以此为主。） */
    window.AllinONE_ContentHandlers = window.AllinONE_ContentHandlers || {};
    window.AllinONE_ContentHandlers.skills = onPack;
    window.AllinONE_ContentHandlers.skins = onPack;
    /* 方式二（兜底，loader 只会触发其一）：链式注册，指向同一函数 */
    var L = window.AllinONE_ContentLoader;
    if (L && typeof L.on === 'function') {
      L.on('skills', onPack);
      L.on('skins', onPack);
      log('内容工坊接收器已注册（skills / skins）');
    }
  }

  /* ==========================================================
   * 代码段 C：道具双通道（道具工坊 + 兑换码）
   * ========================================================== */
  var EFFECT_HANDLERS = {
    feed_snack: function (params) {
      var n = Math.min(60, Math.max(1, (params && params.amount) || 25));
      if (window.PetCore) window.PetCore.setStat('satiety', n);
      if (window.PetFX) window.PetFX.spawn('crumb', 4);
      if (window.PetCore) window.PetCore.setAnimState('eating', 2400);
      return { message: '🍚 吃到零食啦，饱食 +' + n };
    },
    boost_mood: function (params) {
      var n = Math.min(60, Math.max(1, (params && params.amount) || 20));
      if (window.PetCore) window.PetCore.setStat('mood', n);
      if (window.PetFX) window.PetFX.spawn('heart', 5);
      if (window.PetCore) window.PetCore.setAnimState('happy', 1800);
      return { message: '😊 心情 +' + n };
    },
    boost_energy: function (params) {
      var n = Math.min(60, Math.max(1, (params && params.amount) || 25));
      if (window.PetCore) window.PetCore.setStat('energy', n);
      if (window.PetCore) window.PetCore.wake();
      if (window.PetFX) window.PetFX.spawn('sparkle', 4);
      return { message: '⚡ 精力 +' + n };
    },
    wake_up: function () {
      if (window.PetCore) window.PetCore.wake();
      return { message: '🌞 起床啦，伸个懒腰' };
    },
    start_walk: function (params) {
      var sec = Math.min(60, Math.max(2, (params && params.seconds) || 8));
      if (window.PetCore) window.PetCore.startWalking(sec);
      return { message: '🚶 出门散步 ' + sec + ' 秒' };
    },
    teach_word: function () {
      if (window.PetWord && window.PetWord.teachNow) {
        var w = window.PetWord.teachNow();
        if (w) return { message: '🔤 学会：' + w.w + ' ' + w.c };
        return { message: '🔤 今天的单词已经背完啦' };
      }
      return { message: '🔤 需要开启「每日单词」技能才能教学' };
    }
  };

  var _dynCache = {};
  var BLOCKED = ['eval(', 'new function', 'import(', 'require(', '__proto__', 'prototype',
    'constructor', 'window.', 'document.', 'parent.', 'top.', 'globalthis', 'self.',
    'fetch(', 'xmlhttprequest', 'websocket', 'worker(', 'localstorage', 'sessionstorage',
    'cookie', 'alert(', 'confirm(', 'prompt('];

  function registerDynamicEffect(name, codeStr) {
    if (EFFECT_HANDLERS[name]) return true;
    if (_dynCache[name]) { EFFECT_HANDLERS[name] = _dynCache[name]; return true; }
    if (!codeStr || typeof codeStr !== 'string' || codeStr.length > 4000) return false;
    var lower = codeStr.toLowerCase();
    for (var i = 0; i < BLOCKED.length; i++) if (lower.indexOf(BLOCKED[i]) !== -1) return false;
    try {
      /* 沙箱变量：pet（能力白名单）+ 纯函数，不暴露 DOM / 网络 / 存储 */
      var petApi = {
        setStat: function (k, d) { return window.PetCore ? window.PetCore.setStat(k, d) : 0; },
        getStats: function () { return window.PetCore ? window.PetCore.getStats() : {}; },
        setAnimState: function (s, d) { return window.PetCore ? window.PetCore.setAnimState(s, d) : null; },
        say: function (t) { return window.SpeechSystem ? window.SpeechSystem.sayText(String(t)) : null; },
        fx: function (t, n) { return window.PetFX ? window.PetFX.spawn(t, n || 4) : null; }
      };
      var fn = new Function('pet', 'Math', 'JSON', 'console', 'return (' + codeStr + ');');
      var raw = fn(petApi, Math, JSON, console);
      if (typeof raw !== 'function') return false;
      var wrapped = function (params) {
        try { return raw(params) || { message: '效果已执行' }; }
        catch (e) { return { error: true, message: '效果出错: ' + (e.message || e) }; }
      };
      _dynCache[name] = wrapped;
      EFFECT_HANDLERS[name] = wrapped;
      return true;
    } catch (e) { return false; }
  }

  var customPowerUps = [];

  function showToast(msg, type) {
    var box = document.getElementById('a1g-toast');
    if (!box) return;
    var el = document.createElement('div');
    el.className = 'a1g-toast-item' + (type === 'error' ? ' error' : '');
    el.textContent = msg;
    box.appendChild(el);
    requestAnimationFrame(function () { el.classList.add('show'); });
    setTimeout(function () {
      el.classList.remove('show');
      setTimeout(function () { el.remove(); }, 300);
    }, 3000);
  }

  function renderBar() {
    var bar = document.getElementById('a1g-bar');
    if (!bar) return;
    bar.innerHTML = '';
    var label = document.createElement('span');
    label.className = 'a1g-label';
    label.textContent = '道具';
    bar.appendChild(label);
    if (!customPowerUps.length) {
      var empty = document.createElement('span');
      empty.className = 'a1g-empty';
      empty.textContent = '暂无道具';
      bar.appendChild(empty);
      return;
    }
    customPowerUps.forEach(function (item, index) {
      var el = document.createElement('span');
      el.className = 'a1g-item';
      el.textContent = (item.icon || '⚡') + ' ' + item.name;
      el.title = item.description || item.effect;
      el.onclick = function () { usePowerUp(index); };
      bar.appendChild(el);
    });
  }

  function usePowerUp(index) {
    var item = customPowerUps[index];
    if (!item) return;
    if (item.effectCode && !EFFECT_HANDLERS[item.effect]) {
      if (!registerDynamicEffect(item.effect, item.effectCode)) {
        showToast('❌ 效果注册失败', 'error');
        return;
      }
    }
    var handler = EFFECT_HANDLERS[item.effect];
    if (handler) {
      var r = handler(item.params);
      if (r && r.message) showToast(r.message, r.error ? 'error' : '');
    } else {
      showToast('❌ 未找到效果: ' + item.effect, 'error');
    }
    customPowerUps.splice(index, 1);
    renderBar();
  }

  function addPowerUp(effect, name, params, extra) {
    customPowerUps.push({
      id: (extra && extra.id) || ('ugc_' + Date.now()),
      name: name || effect,
      effect: effect,
      params: params || {},
      description: (extra && extra.description) || '',
      effectCode: (extra && extra.effectCode) || null,
      icon: (extra && extra.icon) || '⚡'
    });
    renderBar();
    showToast('🎁 获得道具: ' + (name || effect));
  }

  function a1gInitItemChannel() {
    var bar = document.createElement('div');
    bar.id = 'a1g-bar';
    bar.className = 'a1g-bar';
    var toast = document.createElement('div');
    toast.id = 'a1g-toast';
    toast.className = 'a1g-toast';
    document.body.appendChild(bar);
    document.body.appendChild(toast);
    renderBar();

    /* 通道 1：UGC 道具工坊下发（按凭证 id 去重，防重复入包） */
    var seenVoucher = {};
    window.addEventListener('message', function (e) {
      var d = e.data;
      if (!d || d.type !== 'EXTENSION_VOUCHER') return;
      var v = d.voucher;
      if (!v || !v.data || !v.data.effect) return;
      var key = v.id || v.voucherId || v.data.id || '';
      if (key && seenVoucher[key]) return;
      if (key) seenVoucher[key] = true;
      addPowerUp(v.data.effect, v.data.name, v.data.params, v.data);
    });

    /* 通道 2：兑换码兑换下发（真效果名在 detail.itemId） */
    var seen = {};
    window.addEventListener('allinone:item-redeemed', function (e) {
      var detail = e.detail || {};
      var key = detail.code || detail.itemId;
      if (!key || seen[key]) return;
      seen[key] = true;
      var vd = detail.voucherData || {};
      var real = (vd.effect && vd.effect !== 'custom') ? vd.effect : null;
      if (!real && detail.itemId && detail.itemId !== 'custom') real = detail.itemId;
      if (!real) return;
      addPowerUp(real, vd.name || detail.itemName, vd.params || detail.effects, vd);
    });
  }

  /* ==========================================================
   * 代码段 D：道具提取通道（ITEM_HARVEST）
   * ========================================================== */
  var harvestItems = [];
  var pendingHarvest = {};
  var SCHEMA_NAME = 'deskpet-powerup';
  /* 4.6 跨游戏兑换：上报道具估值点数（不给时平台会启发式估值，显式给更稳） */
  var EFFECT_VALUE = { feed_snack: 10, boost_mood: 10, boost_energy: 12, wake_up: 6, start_walk: 8, teach_word: 15 };

  /* 平台模式懒检测：每次掉落时动态判断，不要只在 init 检测一次 */
  function ensurePlatformMode() {
    var cfg = window['__ALL' + 'INONE_CONFIG__'];
    var bridge = window.AllinONE;
    return !!(cfg && typeof cfg === 'object') ||
           !!(bridge && (bridge.__GAME_ID__ || bridge.GAME_ID));
  }

  function spawnHarvestItem(name, effect, params, description, value) {
    if (!ensurePlatformMode()) return null;      // 非平台环境不掉落
    var item = {
      id: 'dp_' + Date.now() + '_' + Math.floor(Math.random() * 1e6),
      name: name,
      effect: effect,
      params: params || {},
      description: description || '',
      value: value || 0,
      origin: 'gameplay'
    };
    harvestItems.push(item);
    log('掉落可提取道具:', name);
    return item;
  }

  function extractHarvestItem(itemId) {
    var item = null;
    for (var i = 0; i < harvestItems.length; i++) {
      if (harvestItems[i].id === itemId) { item = harvestItems[i]; break; }
    }
    if (!item || item.origin !== 'gameplay' || pendingHarvest[item.id]) return;
    pendingHarvest[item.id] = true;
    window.parent.postMessage({
      type: 'GAME_EVENT',
      event: 'ITEM_HARVEST',
      data: {
        schemaName: SCHEMA_NAME,
        harvestId: item.id,
        itemData: { name: item.name, effect: item.effect, params: item.params,
                    description: item.description, value: item.value || EFFECT_VALUE[item.effect] || 10 },
        quantity: 1,
        source: 'gameplay'
      },
      timestamp: Date.now()
    }, '*');
    setTimeout(function () {
      if (pendingHarvest[item.id]) delete pendingHarvest[item.id];   // 10s 超时解锁可重试
    }, 10000);
  }

  function a1gInitHarvest() {
    window.addEventListener('message', function (e) {
      var d = e.data;
      if (!d || d.type !== 'PLATFORM_EVENT') return;
      if (d.event === 'ITEM_HARVEST_RESULT') {
        var r = d.data || {};
        /* v3.2 铁律：success 才删游戏内道具（防双花）；失败只解锁，道具保留可重试 */
        if (r.success) {
          harvestItems = harvestItems.filter(function (p) { return p.id !== r.harvestId; });
        }
        delete pendingHarvest[r.harvestId];
        showToast(r.success ? '✅ 已提取为凭证，可上架市场' : ('❌ ' + (r.message || '提取失败，可稍后重试')),
          r.success ? '' : 'error');
        return;
      }
      if (d.event === 'REQUEST_GAME_ITEMS') {
        window.parent.postMessage({
          type: 'GAME_EVENT', event: 'GAME_ITEMS',
          data: { items: harvestItems.map(function (p) {
            return { itemId: p.id, schemaName: SCHEMA_NAME,
              itemData: { name: p.name, effect: p.effect, params: p.params || {},
                          description: p.description || '', value: p.value || EFFECT_VALUE[p.effect] || 10 } };
          }) },
          timestamp: Date.now()
        }, '*');
        return;
      }
      if (d.event === 'ITEM_CONSUMED') {
        var id = (d.data || {}).itemId;
        harvestItems = harvestItems.filter(function (p) { return p.id !== id; });
        delete pendingHarvest[id];
      }
    });
  }

  /* ==========================================================
   * 代码段 E：游戏奖励活动上报（GAME_EVENT）
   * ========================================================== */
  var AllinONE_Reward = {
    inPlatform: inIframe,
    report: function (event, data) {
      if (!inIframe()) return;
      try {
        window.parent.postMessage({
          type: 'GAME_EVENT', event: event, data: data || {}, timestamp: Date.now()
        }, '*');
        log('已上报', event, data || '');
      } catch (e) { /* 上报失败绝不影响游戏 */ }
    }
  };

  /* ==========================================================
   * 装配
   * ========================================================== */
  function boot() {
    a1gInitItemChannel();
    a1gInitHarvest();
    a1gRegisterContentHandlers();

    /* 平台协议 INIT：内联 / srcDoc 模式下 gameId 的唯一来源 */
    window.addEventListener('message', function (e) {
      var d = e.data;
      if (d && d.type === 'PROTOCOL:INIT' && d.gameId) {
        A1G_EXT.gameId = d.gameId;
        a1gLoadExtensions();
      }
    });

    a1gLoadExtensions();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }

  /* 暴露给技能与游戏逻辑 */
  window.AllinONEHarvest = { spawn: spawnHarvestItem, extract: extractHarvestItem, list: function () { return harvestItems.slice(); } };
  window.AllinONE_Reward = AllinONE_Reward;
  window.A1G = {
    ext: A1G_EXT,
    effects: EFFECT_HANDLERS,
    addPowerUp: addPowerUp,
    applySkin: a1gApplySkin,
    applySkill: a1gApplySkill,
    resolveAsset: a1gResolveAsset
  };
})();
