/* ==========================================================
 * skills.js — 可拓展技能系统（模块化架构）
 *
 * 统一注册接口：
 *   PetSkills.register({
 *     id: 'my-skill',            // 唯一 ID（必填）
 *     name: '我的技能',            // 显示名（必填）
 *     description: '技能描述',     // 设置面板中展示
 *     icon: '⭐',                 // emoji 图标
 *     defaultEnabled: true,       // 初始开关（默认 true）
 *     actions: [{                 // 可选：注册到底部工具栏的动作按钮
 *       id: 'act', label: '动作名', icon: '🎈',
 *       onClick: function (ctx) { ... }
 *     }],
 *     setup: function (ctx) { ... }   // 技能逻辑（ctx 见下）
 *   });
 *
 * ctx 能力（技能只允许通过 ctx 与核心通信）：
 *   ctx.on(event, fn)        订阅核心事件（技能停用时自动退订）
 *   ctx.onCleanup(fn)        注册技能停用时的清理回调（清定时器等）
 *   ctx.say(category)/ctx.sayText(text)  说话（气泡+朗读）
 *   ctx.getStats()/ctx.setStat(key, delta)
 *   ctx.getAnimState()/ctx.setAnimState(state, duration)
 *   ctx.feed()/ctx.sleep()/ctx.wake()
 *   ctx.startWalking(sec)/ctx.stopWalking()
 *   ctx.storageGet(key)/ctx.storageSet(key, value)  技能私有持久化
 *
 * 事件一览（核心发出）：
 *   app:start / core:ready / tick(每秒)
 *   pet:click / pet:dblclick / pet:dragstart / pet:dragend
 *   pet:feed:start / pet:feed:end / pet:hungry
 *   pet:sleep / pet:wake / pet:sleepy
 *   pet:walk:start / pet:walk:end / pet:bored
 *   anim:state / stats:change / skills:change
 *
 * 新增技能：写一个新文件调用 PetSkills.register，
 * 在 index.html 追加一行 <script> 即可，不触碰核心代码。
 * ========================================================== */
(function () {
  'use strict';

  const SKILL_STORAGE_PREFIX = 'desktoppet.skill.';

  const registry = new Map();   // id -> entry

  function storageKey(id, key) { return SKILL_STORAGE_PREFIX + id + '.' + key; }

  function makeCtx(entry) {
    return {
      on: function (event, fn) {
        window.PetCore.on(event, fn);
        entry.cleanups.push(function () { window.PetCore.off(event, fn); });
      },
      onCleanup: function (fn) { entry.cleanups.push(fn); },
      say: function (category) { return window.SpeechSystem.say(category); },
      sayText: function (text) { return window.SpeechSystem.sayText(text); },
      sayThrottled: function (category, ms) { return window.SpeechSystem.sayThrottled(category, ms); },
      getStats: function () { return window.PetCore.getStats(); },
      setStat: function (key, delta) { return window.PetCore.setStat(key, delta); },
      getAnimState: function () { return window.PetCore.getAnimState(); },
      setAnimState: function (s, d) { return window.PetCore.setAnimState(s, d); },
      feed: function (e) { return window.PetCore.feed(e); },
      sleep: function () { return window.PetCore.sleep(); },
      wake: function () { return window.PetCore.wake(); },
      startWalking: function (sec) { return window.PetCore.startWalking(sec); },
      stopWalking: function () { return window.PetCore.stopWalking(); },
      storageGet: function (key) {
        try { return JSON.parse(localStorage.getItem(storageKey(entry.def.id, key))); }
        catch (e) { return null; }
      },
      storageSet: function (key, value) {
        try { localStorage.setItem(storageKey(entry.def.id, key), JSON.stringify(value)); }
        catch (e) { /* 存储不可用时静默 */ }
      }
    };
  }

  function enable(entry) {
    if (entry.enabled) return;
    entry.cleanups = [];
    entry.ctx = makeCtx(entry);
    try {
      if (typeof entry.def.setup === 'function') entry.def.setup(entry.ctx);
      entry.enabled = true;
    } catch (e) {
      console.error('[PetSkills] setup 失败: ' + entry.def.id, e);
    }
  }

  function disable(entry) {
    if (!entry.enabled) return;
    entry.cleanups.forEach(function (fn) {
      try { fn(); } catch (e) { console.error('[PetSkills] cleanup error', e); }
    });
    entry.cleanups = [];
    entry.ctx = null;
    entry.enabled = false;
  }

  function register(def) {
    if (!def || !def.id || !def.name) {
      console.error('[PetSkills] register 需要提供 id 和 name');
      return;
    }
    if (registry.has(def.id)) return; // 防重复注册

    const entry = {
      def: def,
      enabled: false,
      cleanups: [],
      ctx: null
    };
    registry.set(def.id, entry);

    // 读取用户上次的开关偏好，无记录时用默认值
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(storageKey(def.id, 'enabled'))); } catch (e) { /* ignore */ }
    const shouldEnable = (saved === null || saved === undefined) ? (def.defaultEnabled !== false) : !!saved;
    if (shouldEnable) enable(entry);

    window.PetCore.emit('skills:change');
  }

  function toggle(id, on) {
    const entry = registry.get(id);
    if (!entry) return;
    if (on) enable(entry); else disable(entry);
    try { localStorage.setItem(storageKey(id, 'enabled'), JSON.stringify(!!on)); } catch (e) { /* ignore */ }
    window.PetCore.emit('skills:change');
  }

  function list() {
    const arr = [];
    registry.forEach(function (entry) {
      arr.push({
        id: entry.def.id,
        name: entry.def.name,
        description: entry.def.description || '',
        icon: entry.def.icon || '🧩',
        enabled: entry.enabled
      });
    });
    return arr;
  }

  /* 汇总所有已启用技能注册的工具栏动作 */
  function getActionButtons() {
    const buttons = [];
    registry.forEach(function (entry) {
      if (!entry.enabled || !Array.isArray(entry.def.actions)) return;
      entry.def.actions.forEach(function (a) {
        buttons.push({
          skillId: entry.def.id,
          skillName: entry.def.name,
          id: a.id,
          label: a.label || a.icon || '动作',
          icon: a.icon || '🎈',
          title: (entry.def.name) + ' · ' + (a.label || ''),
          onClick: function () { a.onClick(entry.ctx); }
        });
      });
    });
    return buttons;
  }

  function getEnabledMap() {
    const m = {};
    registry.forEach(function (entry) { m[entry.def.id] = entry.enabled; });
    return m;
  }

  window.PetSkills = {
    register: register,
    toggle: toggle,
    list: list,
    getActionButtons: getActionButtons,
    getEnabledMap: getEnabledMap
  };
})();
