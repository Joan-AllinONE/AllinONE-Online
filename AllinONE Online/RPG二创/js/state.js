/* =========================================================================
 * state.js — 全局游戏状态
 *   DB          资源查表（对应 Godot 的 res:// 资源加载）
 *   GameData    装备 / 技能槽 / 已解锁技能 / 金币      (autoloads/game_data.gd)
 *   Inventory   30 格背包                              (autoloads/inventory.gd)
 *   QuestManager 任务四态 + 冷却                        (autoloads/quest_manager.gd)
 *   SaveManager 三槽存档（localStorage 代替 user://）   (autoloads/save_manager.gd)
 * ========================================================================= */
(function (global) {
  'use strict';
  const RPG = global.RPG;

  // ============================================================== 事件总线
  const EventBus = {
    _h: Object.create(null),
    on(evt, fn) { (this._h[evt] || (this._h[evt] = [])).push(fn); },
    off(evt, fn) {
      const list = this._h[evt];
      if (!list) return;
      const i = list.indexOf(fn);
      if (i !== -1) list.splice(i, 1);
    },
    emit(evt, ...args) {
      const list = this._h[evt];
      if (!list) return;
      for (const fn of list) { try { fn(...args); } catch (e) { console.error(e); } }
    },
  };

  // ================================================================== 资源库
  const EQUIP_KEYS = ['helmet', 'body', 'legs', 'weapon', 'ring'];
  const EQUIP_NAMES = ['头盔', '铠甲', '护腿', '武器', '戒指'];
  const RARITY_NAMES = ['普通', '优秀', '稀有'];
  const RARITY_COLORS = ['#8c8c8c', '#26bf26', '#3373ff'];
  const BONUS_LABELS = {
    bonus_damage: ['伤害', ''],
    bonus_health: ['气血', ''],
    bonus_speed: ['速度', ''],
    bonus_mana: ['魔法', ''],
    bonus_crit_chance: ['暴击率', '%'],
    bonus_crit_damage: ['暴击伤害', '%'],
  };

  const DB = {
    G: null,
    init(G) { this.G = G; },
    item(path) { return path ? this.G.items[path] || null : null; },
    skill(path) { return path ? this.G.skills[path] || null : null; },
    quest(path) { return path ? this.G.quests[path] || null : null; },
    dialogue(path) { return path ? this.G.dialogues[path] || null : null; },
    effect(path) { return path ? this.G.effects[path] || null : null; },
    isEquip(it) { return !!it && it.kind === 'equip'; },
    equipKey(it) { return EQUIP_KEYS[it.equip_type] || 'weapon'; },
    equipSlotName(it) { return EQUIP_NAMES[it.equip_type] || ''; },
    rarityName(it) { return RARITY_NAMES[it.rarity || 0] || ''; },
    tierColor(it) { return RARITY_COLORS[Math.max(0, Math.min(2, it.tier || 0))]; },
    rarityColor(it) { return RARITY_COLORS[Math.max(0, Math.min(2, it.rarity || 0))]; },
    /** 返回装备的非零加成列表 [{label,value,suffix}] */
    bonuses(it) {
      const out = [];
      if (!this.isEquip(it)) return out;
      for (const f in BONUS_LABELS) {
        const v = it[f] || 0;
        if (v !== 0) out.push({ label: BONUS_LABELS[f][0], value: v, suffix: BONUS_LABELS[f][1] });
      }
      return out;
    },
  };

  // ================================================================ GameData
  const GameData = {
    equipment: { helmet: null, body: null, legs: null, weapon: null, ring: null },
    skillSlots: [null, null, null, null],
    unlockedSkills: [],
    coins: 0,

    resetToDefault() {
      this.equipment = { helmet: null, body: null, legs: null, weapon: null, ring: null };
      this.skillSlots = [null, null, null, null];
      this.unlockedSkills = [];
      this.coins = 0;
    },
    /** 累加所有已装备物品的某项加成 */
    equipBonus(stat) {
      let total = 0;
      for (const k of EQUIP_KEYS) {
        const it = DB.item(this.equipment[k]);
        if (it) total += it[stat] || 0;
      }
      return total;
    },
    isUnlocked(path) { return this.unlockedSkills.indexOf(path) >= 0; },
    saveState() {
      return {
        coins: this.coins,
        equipment: Object.assign({}, this.equipment),
        skill_slots: this.skillSlots.slice(),
        unlocked_skills: this.unlockedSkills.slice(),
      };
    },
    loadState(d) {
      if (!d) return;
      this.coins = d.coins || 0;
      this.equipment = { helmet: null, body: null, legs: null, weapon: null, ring: null };
      const eq = d.equipment || {};
      for (const k of EQUIP_KEYS) this.equipment[k] = eq[k] || null;
      this.unlockedSkills = (d.unlocked_skills || []).slice();
      this.skillSlots = [null, null, null, null];
      const ss = d.skill_slots || [];
      for (let i = 0; i < Math.min(4, ss.length); i++) this.skillSlots[i] = ss[i] || null;
    },
  };

  // =============================================================== Inventory
  const INVENTORY_SIZE = 30;
  const Inventory = {
    slots: new Array(INVENTORY_SIZE).fill(null),   // {item: path, qty: n}

    resetToDefault() {
      this.slots = new Array(INVENTORY_SIZE).fill(null);
      EventBus.emit('inventory_changed');
    },
    get(i) { return (i >= 0 && i < this.slots.length) ? this.slots[i] : null; },
    emptyIndexes() {
      const out = [];
      for (let i = 0; i < this.slots.length; i++) if (!this.slots[i]) out.push(i);
      return out;
    },
    findIndexes(path, withSpace) {
      const it = DB.item(path);
      const out = [];
      if (!it) return out;
      for (let i = 0; i < this.slots.length; i++) {
        const s = this.slots[i];
        if (!s || s.item !== path) continue;
        if (withSpace) { if (s.qty < it.max_stack) out.push(i); }
        else out.push(i);
      }
      return out;
    },

    /** 返回未能放入的数量（0 = 全部放入） */
    addItem(path, amount) {
      amount = amount === undefined ? 1 : amount;
      const it = DB.item(path);
      if (!it) return amount;
      let remaining = amount;

      if (it.max_stack > 1) {
        for (const i of this.findIndexes(path, true)) {
          if (remaining <= 0) break;
          const s = this.slots[i];
          const give = Math.min(it.max_stack - s.qty, remaining);
          s.qty += give;
          remaining -= give;
        }
      }
      if (remaining > 0) {
        for (const i of this.emptyIndexes()) {
          if (remaining <= 0) break;
          const give = Math.min(it.max_stack, remaining);
          this.slots[i] = { item: path, qty: give };
          remaining -= give;
        }
      }
      const added = amount - remaining;
      if (added > 0) {
        EventBus.emit('inventory_changed');
        QuestManager.addProgressForType('collect', path, added);
      }
      return remaining;
    },

    equipItem(idx) {
      const s = this.get(idx);
      if (!s) return;
      const it = DB.item(s.item);
      if (!DB.isEquip(it)) return;
      const key = DB.equipKey(it);
      const old = GameData.equipment[key];
      GameData.equipment[key] = s.item;
      this.slots[idx] = null;
      if (old) this.addItem(old, 1);
      EventBus.emit('inventory_changed');
      EventBus.emit('equipment_changed');
    },

    unequip(key) {
      const cur = GameData.equipment[key];
      if (!cur) return;
      if (this.emptyIndexes().length === 0) { EventBus.emit('alert', '背包已满，无法卸下装备'); return; }
      this.addItem(cur, 1);
      GameData.equipment[key] = null;
      EventBus.emit('equipment_changed');
    },

    useItem(idx) {
      const s = this.get(idx);
      if (!s) return false;
      const it = DB.item(s.item);
      if (!it || !it.is_consumable) return false;
      s.qty -= 1;
      if (s.qty <= 0) this.slots[idx] = null;
      EventBus.emit('inventory_changed');
      EventBus.emit('used_item', it);
      return true;
    },

    swap(a, b) {
      if (a < 0 || a >= this.slots.length || b < 0 || b >= this.slots.length) return;
      const t = this.slots[a]; this.slots[a] = this.slots[b]; this.slots[b] = t;
      EventBus.emit('inventory_changed');
    },

    merge(from, to) {
      const f = this.get(from), t = this.get(to);
      if (!f || !t || f.item !== t.item) { this.swap(from, to); return; }
      const it = DB.item(f.item);
      if (!it || it.max_stack <= 1) { this.swap(from, to); return; }
      const space = it.max_stack - t.qty;
      const move = Math.min(space, f.qty);
      t.qty += move;
      f.qty -= move;
      if (f.qty <= 0) this.slots[from] = null;
      else if (space <= 0) { this.swap(from, to); return; }
      EventBus.emit('inventory_changed');
    },

    /** 售出：得四分之一价（最低 1 金） */
    sellItem(idx) {
      const s = this.get(idx);
      if (!s) return 0;
      const it = DB.item(s.item);
      const price = Math.max(1, Math.floor((it.price || 0) / 4));
      GameData.coins += price;
      s.qty -= 1;
      if (s.qty <= 0) this.slots[idx] = null;
      EventBus.emit('inventory_changed');
      return price;
    },

    count(path) {
      let t = 0;
      for (const s of this.slots) if (s && s.item === path) t += s.qty;
      return t;
    },

    removeItem(path, amount) {
      let remaining = amount;
      for (let i = this.slots.length - 1; i >= 0 && remaining > 0; i--) {
        const s = this.slots[i];
        if (!s || s.item !== path) continue;
        const rm = Math.min(s.qty, remaining);
        s.qty -= rm; remaining -= rm;
        if (s.qty <= 0) this.slots[i] = null;
      }
      EventBus.emit('inventory_changed');
    },

    saveState() { return this.slots.map((s) => (s ? { item: s.item, qty: s.qty } : null)); },
    loadState(arr) {
      if (!arr || !arr.length) return;
      this.slots = new Array(INVENTORY_SIZE).fill(null);
      for (let i = 0; i < Math.min(arr.length, INVENTORY_SIZE); i++) {
        const e = arr[i];
        if (e && e.item && DB.item(e.item)) this.slots[i] = { item: e.item, qty: e.qty || 1 };
      }
      EventBus.emit('inventory_changed');
      EventBus.emit('equipment_changed');
    },
  };

  // ============================================================ QuestManager
  const COOLDOWN_SEC = 120;
  const QuestManager = {
    data: Object.create(null),    // quest_id -> questDef
    state: Object.create(null),   // quest_id -> {progress,status,claimed_at}
    _now: () => SaveManager.playTime(),

    setQuests(paths) {
      this.data = Object.create(null);
      this._checkCooldowns();
      for (const p of paths || []) {
        const q = DB.quest(p);
        if (!q) continue;
        this.data[q.quest_id] = q;
        if (!this.state[q.quest_id]) {
          this.state[q.quest_id] = { progress: 0, status: 'not_accepted', claimed_at: -1 };
        }
      }
      EventBus.emit('quests_changed');
    },
    _checkCooldowns() {
      const now = this._now();
      for (const id in this.state) {
        const st = this.state[id];
        if (st.status === 'claimed' && st.claimed_at >= 0 && now - st.claimed_at >= COOLDOWN_SEC) {
          st.status = 'not_accepted'; st.progress = 0; st.claimed_at = -1;
        }
      }
    },
    list() { return Object.keys(this.data).map((id) => this.data[id]); },
    getStatus(id) {
      const st = this.state[id];
      if (!st) return '';
      if (st.status === 'claimed' && st.claimed_at >= 0 && this._now() - st.claimed_at >= COOLDOWN_SEC) {
        st.status = 'not_accepted'; st.progress = 0; st.claimed_at = -1;
      }
      return st.status;
    },
    cooldownLeft(id) {
      const st = this.state[id];
      if (!st || st.status !== 'claimed' || st.claimed_at < 0) return 0;
      return Math.max(0, COOLDOWN_SEC - (this._now() - st.claimed_at));
    },
    getProgress(id) { return this.state[id] ? this.state[id].progress : 0; },
    getTarget(id) { return this.data[id] ? this.data[id].quest_target_value : 0; },

    accept(id) {
      const st = this.state[id];
      if (!st || st.status !== 'not_accepted') return;
      st.status = 'active'; st.progress = 0;
      EventBus.emit('quest_accepted', id);
      // 接取收集类任务时，把背包里已有的数量算进去
      const q = this.data[id];
      if (q && q.quest_type === 'collect') {
        const have = Inventory.count(q.quest_target_id);
        if (have > 0) this.addProgress(id, have);
      }
      EventBus.emit('quests_changed');
    },

    addProgress(id, amount) {
      const st = this.state[id];
      const q = this.data[id];
      if (!st || !q || st.status !== 'active') return;
      st.progress = Math.min(st.progress + amount, q.quest_target_value);
      if (st.progress >= q.quest_target_value) {
        st.status = 'completed';
        EventBus.emit('quest_completed', id);
      }
      EventBus.emit('quests_changed');
    },

    addProgressForType(type, targetId, amount) {
      for (const id in this.state) {
        const st = this.state[id], q = this.data[id];
        if (!q || st.status !== 'active') continue;
        if (q.quest_type === type && q.quest_target_id === targetId) this.addProgress(id, amount);
      }
    },

    /** 领取奖励，返回 {ok, item, xp} */
    claim(id, player) {
      const st = this.state[id], q = this.data[id];
      if (!st || !q || st.status !== 'completed') return { ok: false };
      if (q.quest_item_reward) Inventory.addItem(q.quest_item_reward, 1);
      if (q.quest_xp_reward > 0 && player) player.addExp(q.quest_xp_reward);
      if (q.quest_type === 'collect' && q.quest_target_id) {
        Inventory.removeItem(q.quest_target_id, q.quest_target_value);
      }
      st.status = 'claimed';
      st.claimed_at = this._now();
      EventBus.emit('quests_changed');
      return { ok: true, item: q.quest_item_reward, xp: q.quest_xp_reward };
    },

    resetAll() { this.data = Object.create(null); this.state = Object.create(null); },
    saveState() { return JSON.parse(JSON.stringify(this.state)); },
    loadState(d) {
      if (!d) return;
      for (const id in d) {
        this.state[id] = {
          progress: d[id].progress || 0,
          status: d[id].status || 'not_accepted',
          claimed_at: d[id].claimed_at === undefined ? -1 : d[id].claimed_at,
        };
      }
      EventBus.emit('quests_changed');
    },
  };

  // ============================================================= SaveManager
  const SLOT_COUNT = 3;
  const STORE_PREFIX = 'godot_rpg_web_save_';
  const SaveManager = {
    currentSlot: -1,
    accumulated: 0,
    sessionStart: (typeof performance !== 'undefined' ? performance.now() : Date.now()),

    playTime() {
      const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      return this.accumulated + (now - this.sessionStart) / 1000;
    },
    resetTimer() {
      this.accumulated = 0;
      this.sessionStart = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    },
    _key(slot) { return STORE_PREFIX + slot; },

    /** 返回三个槽位的摘要（无存档为 null） */
    listSlots() {
      const out = [];
      for (let i = 0; i < SLOT_COUNT; i++) {
        let raw = null;
        try { raw = global.localStorage.getItem(this._key(i)); } catch (e) { raw = null; }
        if (!raw) { out.push(null); continue; }
        try {
          const d = JSON.parse(raw);
          out.push({
            slot: i,
            level: (d.player && d.player.level) || 1,
            area: d.area || '',
            areaName: d.area_name || '',
            coins: (d.game_data && d.game_data.coins) || 0,
            time: d.play_time || 0,
            date: d.date || '',
          });
        } catch (e) { out.push(null); }
      }
      return out;
    },

    save(slot, game) {
      const payload = {
        version: 1,
        date: new Date().toLocaleString('zh-CN'),
        play_time: this.playTime(),
        area: game.mapKey,
        area_name: game.mapDisplayName ? game.mapDisplayName() : (game.map ? game.map.name : ''),
        player: game.player.saveState(),
        game_data: GameData.saveState(),
        inventory: Inventory.saveState(),
        quests: QuestManager.saveState(),
      };
      try {
        global.localStorage.setItem(this._key(slot), JSON.stringify(payload));
        this.currentSlot = slot;
        return true;
      } catch (e) {
        console.warn('save failed', e);
        return false;
      }
    },

    read(slot) {
      try {
        const raw = global.localStorage.getItem(this._key(slot));
        return raw ? JSON.parse(raw) : null;
      } catch (e) { return null; }
    },

    erase(slot) {
      try { global.localStorage.removeItem(this._key(slot)); } catch (e) { /* ignore */ }
    },
  };

  RPG.EventBus = EventBus;
  RPG.DB = DB;
  RPG.GameData = GameData;
  RPG.Inventory = Inventory;
  RPG.QuestManager = QuestManager;
  RPG.SaveManager = SaveManager;
  RPG.EQUIP_KEYS = EQUIP_KEYS;
  RPG.EQUIP_NAMES = EQUIP_NAMES;
  RPG.INVENTORY_SIZE = INVENTORY_SIZE;
})(window);
