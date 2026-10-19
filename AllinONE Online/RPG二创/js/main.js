/* =========================================================================
 * main.js — 游戏主循环 / 地图装载 / 传送门 / 目标选择 / UI / 标题 / 存档
 * 依赖：gamedata.js, core.js, world.js, state.js, entities.js
 * 全程不依赖 fetch/XHR，兼容 file:// 双击运行
 * ========================================================================= */
(function (global) {
  'use strict';

  const RPG = global.RPG;
  const M = RPG.M, Input = RPG.Input, Assets = RPG.Assets,
        Audio_ = RPG.Audio, SFX = RPG.SFX, EventBus = RPG.EventBus,
        DB = RPG.DB, GameData = RPG.GameData, Inventory = RPG.Inventory,
        QuestManager = RPG.QuestManager, SaveManager = RPG.SaveManager;
  const GAMEDATA = global.GAMEDATA;

  DB.init(GAMEDATA);
  SFX.init(GAMEDATA.audio);

  // ----------------------------------------------------------- 模块级变量
  let game = null;
  let state = 'loading';            // loading | title | play | pause | gameover
  let selectedInv = -1;
  let last = 0;
  const $ = (id) => document.getElementById(id);
  const canvas = $('game');

  // ============================================================ 纹理预加载
  function allTexturePaths() {
    const s = new Set();
    const add = (p) => { if (p) s.add(p); };
    const addAnims = (anims) => {
      if (!anims) return;
      for (const a in anims) { const fr = anims[a].frames || []; for (const f of fr) add(f.tex); }
    };
    for (const k in GAMEDATA.tilesets) { const ts = GAMEDATA.tilesets[k]; for (const sk in ts.sources) add(ts.sources[sk].tex); }
    addAnims(GAMEDATA.player.anims);
    for (const k in GAMEDATA.enemies) addAnims(GAMEDATA.enemies);
    for (const k in GAMEDATA.npcs) addAnims(GAMEDATA.npcs[k].anims);
    for (const k in GAMEDATA.effects) { const e = GAMEDATA.effects[k]; for (const f of (e.frames || [])) add(f.tex); }
    for (const k in GAMEDATA.items) add(GAMEDATA.items[k].icon);
    for (const k in GAMEDATA.skills) {
      const sk = GAMEDATA.skills[k];
      add(sk.icon);
      if (sk.effect) { const d = DB.effect(sk.effect); if (d) for (const f of (d.frames || [])) add(f.tex); }
    }
    for (const k in GAMEDATA.dialogues) add(GAMEDATA.dialogues[k].npc_icon);
    add(GAMEDATA.misc.shadow); add(GAMEDATA.misc.selector);
    add(GAMEDATA.player.weapon_icon); add(GAMEDATA.player.rod);
    const fxTex = (fx) => { if (!fx) return; if (typeof fx === 'string') { const d = DB.effect(fx); if (d) for (const f of (d.frames || [])) add(f.tex); } else if (fx.frames) for (const f of fx.frames) add(f.tex); };
    fxTex(GAMEDATA.fx.damage); fxTex(GAMEDATA.fx.level);
    return [...s];
  }

  /** 地图显示名。test_map 是原项目遗留的空白调试场景，如实标注以免误入。 */
  const MAP_NAMES = {
    town: '小镇',
    suburb: '雪地郊外',
    cave: '洞穴',
    test_map: '测试空地（原项目调试用，无地形）',
  };
  const mapName = (key) => MAP_NAMES[key] || key;

  // ================================================================== Game
  class Game {
    constructor(cv) {
      this.canvas = cv;
      this.ctx = cv.getContext('2d');
      this.cam = new RPG.Camera(cv.width, cv.height);
      this.data = GAMEDATA;
      this.player = null;
      this.map = null;
      this.mapKey = '';
      this.enemies = []; this.npcs = []; this.zones = []; this.fishing = [];
      this.drops = []; this.effects = []; this.floats = []; this.icons = []; this.vfx = [];
      this.portals = [];
      this.modal = null;          // 当前打开的模态面板名
      this._portalCd = 0;
      this._dlg = null;
    }

    /** 当前地图的中文显示名（供存档/读档界面使用）。 */
    mapDisplayName() {
      return mapName(this.mapKey);
    }

    // -------------------------------------------------------- 地图装载
    loadMap(key, spawnId) {
      const def = GAMEDATA.maps[key];
      this.map = new RPG.GameMap(key, def, GAMEDATA);
      this.mapKey = key;
      this.enemies = []; this.npcs = []; this.zones = []; this.fishing = [];
      this.drops = []; this.effects = []; this.floats = []; this.icons = [];
      this.portals = def.objects.portals || [];
      const o = def.objects || {};
      for (const n of (o.npcs || [])) this.npcs.push(new RPG.NPC(this, n));
      for (const z of (o.zones || [])) this.zones.push(new RPG.EnemyZone(this, z));
      for (const f of (o.fishing || [])) if (f) this.fishing.push(new RPG.FishingSpot(this, f));
      for (const d of (o.drops || [])) this.drops.push(new RPG.DropItem(this, d.item, d.amount, d.pos[0], d.pos[1]));
      if (!this.player) {
        this.player = new RPG.Player(this);
        this.player.applyEquipmentStats();
      }
      const sp = this.map.spawnPos(spawnId);
      this.player.x = sp.x; this.player.y = sp.y;
      this.player.selectedEnemy = null;
      this.player.isDialogueActive = false;
      this.player.isFishing = false;
      this.player.currentFishingSpot = null;
      this._portalCd = 0.6;
    }

    // -------------------------------------------------------- 新游戏
    newGame(slot) {
      Audio_.unlock();
      GameData.resetToDefault();
      Inventory.slots = new Array(RPG.INVENTORY_SIZE).fill(null);
      QuestManager.resetAll();
      QuestManager.setQuests(Object.keys(GAMEDATA.quests));
      GameData.unlockedSkills = [];
      GameData.skillSlots = [null, null, null, null];
      let si = 0;
      for (const st of GAMEDATA.skill_tree) {
        if (st.is_free && GameData.unlockedSkills.indexOf(st.skill) < 0) {
          GameData.unlockedSkills.push(st.skill);
          if (si < 4) GameData.skillSlots[si++] = st.skill;
        }
      }
      this.player = null;
      this.loadMap(GAMEDATA.start_map, 'TownPos');
      this.player.applyEquipmentStats();
      SaveManager.currentSlot = slot;
      startPlay();
    }

    // -------------------------------------------------------- 读档
    loadGame(slot) {
      Audio_.unlock();
      const data = SaveManager.read(slot);
      if (!data) return;
      GameData.resetToDefault();
      Inventory.slots = new Array(RPG.INVENTORY_SIZE).fill(null);
      QuestManager.resetAll();
      this.player = null;
      this.loadMap(data.area || GAMEDATA.start_map, null);
      GameData.loadState(data.game_data);
      Inventory.loadState(data.inventory);
      QuestManager.setQuests(Object.keys(GAMEDATA.quests));
      QuestManager.loadState(data.quests);
      this.player.loadState(data.player);
      this.player.applyEquipmentStats();
      SaveManager.currentSlot = slot;
      startPlay();
    }

    saveGame() {
      if (SaveManager.currentSlot < 0) { toast('请先在标题界面选择存档槽'); return false; }
      const ok = SaveManager.save(SaveManager.currentSlot, this);
      if (ok) toast('已保存至存档槽 ' + (SaveManager.currentSlot + 1));
      return ok;
    }

    respawn() {
      const p = this.player;
      p.currHealth = p.effMaxHealth();
      p.currMana = p.effMaxMana();
      const sp = this.map.spawnPos('PlayerSpawn');
      p.x = sp.x; p.y = sp.y; p.selectedEnemy = null;
      state = 'play';
      $('gameover').classList.add('hidden');
      $('hud').classList.remove('hidden');
    }

    onPlayerDead() {
      state = 'gameover';
      $('gameover').classList.remove('hidden');
    }

    // -------------------------------------------------------- 辅助方法
    addFx(src, x, y) {
      let def = (typeof src === 'string') ? DB.effect(src) : src;
      if (!def || !def.frames || !def.frames.length) return;
      this.effects.push(new RPG.Effect(def, x, y));
    }
    hintText(x, y, text, color) {
      this.floats.push(new RPG.FloatText(x, y, text, color || '#ffffff', 9));
    }
    damageText(x, y, value, crit) {
      this.floats.push(new RPG.FloatText(x, y, '-' + Math.round(value), crit ? '#ffd84d' : '#ff5555', crit ? 12 : 9));
    }

    // -------------------------------------------------------- 程序化视觉特效（无需外部素材）
    // 所有特效都是轻量自包含对象：{ t, life, dead, update(dt), draw(ctx, cam) }。
    // 道具 effectCode 只需调用一个通用原语即可触发任意画面特效：
    //   game.spawnParticles(kind, x, y, opts)
    // 支持的 kind： flame / ring / dash / shield / lightning / ice / poison / spark
    // 新增一种视觉 = 在此 switch 里加一个 case（一次性，之后所有道具纯 JSON 配置）。

    /**
     * 武器附魔（由 AllinONE 道具 apply_enchant 调用）。
     * params: { element, level, duration, base, dps, statusDur }
     * 等级越高，每次挥砍命中的附加元素伤害越大（bonus = base × level）。
     */
    applyEnchant(params) {
      if (!this.player) return { error: true, message: '游戏尚未开始' };
      params = params || {};
      const VALID = { lightning: 1, fire: 1, freeze: 1, poison: 1 };
      const element = params.element;
      if (!VALID[element]) return { error: true, message: '未知附魔元素: ' + element };
      const level = Math.max(1, Math.floor(params.level || 1));
      const duration = Math.max(1, Math.floor(params.duration || 30));
      const base = params.base != null ? params.base : 6;        // 每级基础附加元素伤害
      const statusDur = params.statusDur != null ? params.statusDur : 3;
      const dps = params.dps != null ? params.dps : 6;
      this.player.enchants[element] = {
        level, expire: Date.now() + duration * 1000, base, statusDur, dps,
      };
      const NAMES = { lightning: '雷霆', fire: '烈焰', freeze: '冰霜', poison: '剧毒' };
      EventBus.emit('player_stats_updated');
      return {
        message: '✨ 武器附魔【' + NAMES[element] + ' Lv' + level + '】' + duration +
          '秒内每击附加 ' + (base * level) + ' 点元素伤害' +
          (element !== 'lightning' ? '（状态每秒 ' + (dps * level) + '）' : ''),
      };
    }

    spawnParticles(kind, x, y, opts) {
      opts = opts || {};
      switch (kind) {
        case 'flame': {
          const n = opts.count || 6;
          for (let i = 0; i < n; i++) {
            const a = Math.random() * Math.PI * 2, sp = 8 + Math.random() * 16;
            this.vfx.push({
              t: 0, life: 0.4 + Math.random() * 0.35, x, y,
              vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 12, r0: 5 + Math.random() * 5, dead: false,
              update(dt) { this.t += dt; this.x += this.vx * dt; this.y += this.vy * dt; this.vy -= 16 * dt; if (this.t >= this.life) this.dead = true; },
              draw(ctx, cam) {
                const k = 1 - this.t / this.life, [sx, sy] = cam.toScreen(this.x, this.y), r = (this.r0 * (0.4 + k)) * cam.zoom;
                ctx.save(); ctx.globalCompositeOperation = 'lighter';
                const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, r);
                g.addColorStop(0, 'rgba(255,245,160,' + (0.95 * k) + ')');
                g.addColorStop(0.4, 'rgba(255,140,30,' + (0.7 * k) + ')');
                g.addColorStop(1, 'rgba(170,30,0,0)');
                ctx.fillStyle = g; ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2); ctx.fill();
                ctx.restore();
              }
            });
          }
          break;
        }
        case 'ring': {
          const r = opts.r || 90, color = opts.color || 'rgba(255,150,40,';
          this.vfx.push({
            t: 0, life: 0.5, x, y, maxR: r, color, dead: false,
            update(dt) { this.t += dt; if (this.t >= this.life) this.dead = true; },
            draw(ctx, cam) {
              const k = this.t / this.life, [sx, sy] = cam.toScreen(this.x, this.y), rr = (this.maxR * k) * cam.zoom;
              ctx.save(); ctx.globalCompositeOperation = 'lighter';
              ctx.strokeStyle = this.color + (1 - k) * 0.8 + ')'; ctx.lineWidth = 3 * cam.zoom;
              ctx.beginPath(); ctx.arc(sx, sy, rr, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
            }
          });
          break;
        }
        case 'dash': {
          const tx = opts.tx != null ? opts.tx : x, ty = opts.ty != null ? opts.ty : y;
          this.vfx.push({
            t: 0, life: 0.35, x, y, tx, ty, dead: false,
            update(dt) { this.t += dt; if (this.t >= this.life) this.dead = true; },
            draw(ctx, cam) {
              const k = 1 - this.t / this.life, [sx, sy] = cam.toScreen(this.x, this.y), [ex, ey] = cam.toScreen(this.tx, this.ty);
              ctx.save(); ctx.globalCompositeOperation = 'lighter';
              ctx.strokeStyle = 'rgba(140,210,255,' + (0.85 * k) + ')'; ctx.lineWidth = 6 * cam.zoom; ctx.lineCap = 'round';
              ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.stroke();
              ctx.fillStyle = 'rgba(140,210,255,' + (0.4 * k) + ')';
              const gx = sx + (ex - sx) * 0.35, gy = sy + (ey - sy) * 0.35;
              ctx.beginPath(); ctx.arc(gx, gy, 5 * cam.zoom, 0, Math.PI * 2); ctx.fill();
              ctx.restore();
            }
          });
          break;
        }
        case 'shield': {
          const dur = opts.dur || 6;
          this.vfx.push({
            t: 0, life: dur, g: this, dead: false,
            update(dt) { this.t += dt; if (this.t >= this.life) this.dead = true; },
            draw(ctx, cam) {
              const p = this.g.player; if (!p) return;
              const [sx, sy] = cam.toScreen(p.x, p.y + (p.colOffY || -7)), r = 18 * cam.zoom;
              ctx.save(); ctx.globalCompositeOperation = 'lighter';
              const pulse = 0.5 + 0.5 * Math.sin(this.t * 8);
              ctx.strokeStyle = 'rgba(120,220,255,' + (0.4 + 0.35 * pulse) + ')'; ctx.lineWidth = 2.5 * cam.zoom;
              ctx.beginPath(); ctx.ellipse(sx, sy, r * 0.8, r, 0, 0, Math.PI * 2); ctx.stroke();
              ctx.restore();
            }
          });
          break;
        }
        case 'lightning': {
          // 落点白光 + 冲击环
          this.vfx.push({
            t: 0, life: 0.45, x, y, dead: false,
            update(dt) { this.t += dt; if (this.t >= this.life) this.dead = true; },
            draw(ctx, cam) {
              const k = 1 - this.t / this.life, [sx, sy] = cam.toScreen(this.x, this.y);
              ctx.save(); ctx.globalCompositeOperation = 'lighter';
              const rr = (10 + 60 * (1 - k)) * cam.zoom;
              ctx.strokeStyle = 'rgba(180,220,255,' + (0.8 * k) + ')'; ctx.lineWidth = 3 * cam.zoom;
              ctx.beginPath(); ctx.arc(sx, sy, rr, 0, Math.PI * 2); ctx.stroke();
              const rg = ctx.createRadialGradient(sx, sy, 0, sx, sy, 28 * cam.zoom * k);
              rg.addColorStop(0, 'rgba(255,255,255,' + (0.9 * k) + ')');
              rg.addColorStop(1, 'rgba(160,210,255,0)');
              ctx.fillStyle = rg; ctx.beginPath(); ctx.arc(sx, sy, 28 * cam.zoom * k, 0, Math.PI * 2); ctx.fill();
              ctx.restore();
            }
          });
          // 锯齿电柱（自天空劈落）
          const top = y - 130, bot = y, n = 6, segs = [];
          for (let i = 0; i <= n; i++) {
            const yy = top + (bot - top) * (i / n);
            const jx = (i === 0 || i === n) ? 0 : (Math.random() - 0.5) * 18;
            segs.push({ x: x + jx, y: yy });
          }
          this.vfx.push({
            t: 0, life: 0.22, x, y, segs, dead: false,
            update(dt) { this.t += dt; if (this.t >= this.life) this.dead = true; },
            draw(ctx, cam) {
              const a = 1 - this.t / this.life, [bx, by] = cam.toScreen(this.segs[0].x, this.segs[0].y);
              ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.lineCap = 'round';
              ctx.strokeStyle = 'rgba(205,235,255,' + a + ')'; ctx.lineWidth = 4.5 * cam.zoom;
              ctx.beginPath(); ctx.moveTo(bx, by);
              for (let i = 1; i < this.segs.length; i++) { const [px, py] = cam.toScreen(this.segs[i].x, this.segs[i].y); ctx.lineTo(px, py); }
              ctx.stroke();
              ctx.strokeStyle = 'rgba(255,255,255,' + (a * 0.9) + ')'; ctx.lineWidth = 1.6 * cam.zoom;
              ctx.beginPath(); ctx.moveTo(bx, by);
              for (let i = 1; i < this.segs.length; i++) { const [px, py] = cam.toScreen(this.segs[i].x, this.segs[i].y); ctx.lineTo(px, py); }
              ctx.stroke();
              ctx.restore();
            }
          });
          break;
        }
        case 'ice': {
          const n = opts.count || 8;
          this.vfx.push({
            t: 0, life: 0.55, x, y, n, dead: false,
            update(dt) { this.t += dt; if (this.t >= this.life) this.dead = true; },
            draw(ctx, cam) {
              const k = this.t / this.life, [sx, sy] = cam.toScreen(this.x, this.y);
              ctx.save(); ctx.globalCompositeOperation = 'lighter';
              const rr = (8 + 50 * k) * cam.zoom;
              ctx.strokeStyle = 'rgba(150,230,255,' + (0.8 * (1 - k)) + ')'; ctx.lineWidth = 2.5 * cam.zoom;
              ctx.beginPath(); ctx.arc(sx, sy, rr, 0, Math.PI * 2); ctx.stroke();
              for (let i = 0; i < this.n; i++) {
                const ang = (i / this.n) * Math.PI * 2 + k, d = (10 + 40 * k) * cam.zoom;
                const px = sx + Math.cos(ang) * d, py = sy + Math.sin(ang) * d;
                ctx.strokeStyle = 'rgba(200,245,255,' + (0.9 * (1 - k)) + ')'; ctx.lineWidth = 2 * cam.zoom;
                ctx.beginPath();
                ctx.moveTo(px - 4 * cam.zoom, py); ctx.lineTo(px + 4 * cam.zoom, py);
                ctx.moveTo(px, py - 4 * cam.zoom); ctx.lineTo(px, py + 4 * cam.zoom);
                ctx.stroke();
              }
              ctx.restore();
            }
          });
          break;
        }
        case 'poison': {
          const n = opts.count || 7;
          for (let i = 0; i < n; i++) {
            const a = Math.random() * Math.PI * 2, sp = 6 + Math.random() * 14;
            this.vfx.push({
              t: 0, life: 0.5 + Math.random() * 0.5, x, y,
              vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 8, r0: 4 + Math.random() * 5, dead: false,
              update(dt) { this.t += dt; this.x += this.vx * dt; this.y += this.vy * dt; this.vy -= 10 * dt; if (this.t >= this.life) this.dead = true; },
              draw(ctx, cam) {
                const k = 1 - this.t / this.life, [sx, sy] = cam.toScreen(this.x, this.y), r = (this.r0 * (0.5 + k)) * cam.zoom;
                ctx.save(); ctx.globalCompositeOperation = 'lighter';
                const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, r);
                g.addColorStop(0, 'rgba(180,255,120,' + (0.8 * k) + ')');
                g.addColorStop(0.5, 'rgba(90,200,60,' + (0.5 * k) + ')');
                g.addColorStop(1, 'rgba(40,120,30,0)');
                ctx.fillStyle = g; ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2); ctx.fill();
                ctx.restore();
              }
            });
          }
          break;
        }
        case 'spark': {
          const n = opts.count || 10;
          for (let i = 0; i < n; i++) {
            const a = Math.random() * Math.PI * 2, sp = 20 + Math.random() * 40;
            this.vfx.push({
              t: 0, life: 0.3 + Math.random() * 0.2, x, y,
              vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, r0: 2 + Math.random() * 3, dead: false,
              update(dt) { this.t += dt; this.x += this.vx * dt; this.y += this.vy * dt; if (this.t >= this.life) this.dead = true; },
              draw(ctx, cam) {
                const k = 1 - this.t / this.life, [sx, sy] = cam.toScreen(this.x, this.y), r = (this.r0 * (0.4 + k)) * cam.zoom;
                ctx.save(); ctx.globalCompositeOperation = 'lighter';
                const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, r);
                g.addColorStop(0, 'rgba(255,240,180,' + (0.95 * k) + ')');
                g.addColorStop(1, 'rgba(255,200,80,0)');
                ctx.fillStyle = g; ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2); ctx.fill();
                ctx.restore();
              }
            });
          }
          break;
        }
        default:
          if (typeof console !== 'undefined' && console.warn) console.warn('spawnParticles: 未知特效类型 "' + kind + '"');
      }
    }
    mouseWorld() { return this.cam.toWorld(Input.mouse.x, Input.mouse.y); }
    uiBlocking() { return this.modal !== null; }

    interactNpc(npc) {
      switch (npc.type) {
        case RPG.NPC_TYPE.IDLE: this._openDialogue(npc); break;
        case RPG.NPC_TYPE.SHOP: openPanel('shop'); break;
        case RPG.NPC_TYPE.QUEST: openPanel('quests'); break;
        case RPG.NPC_TYPE.CRAFTING: openPanel('craft'); break;
        default: this._openDialogue(npc);
      }
    }
    _openDialogue(npc) {
      const d = DB.dialogue(npc.dialogue);
      this._dlg = { npc: npc, lines: (d && d.lines) || ['……'], i: 0 };
      this.modal = 'dialogue';
      this.player.isDialogueActive = true;
      renderPanel();
    }

    // -------------------------------------------------------- 传送门
    _checkPortals(dt) {
      if (this._portalCd > 0) { this._portalCd -= dt; return; }
      if (this.uiBlocking()) return;
      // Godot 的 Portal 是 Area2D + body_entered：判定的是玩家 CollisionShape2D
      // （圆心 (0,-7)、r≈7.07）与门矩形的“形状重叠”，而不是精灵原点落点。
      const px = this.player.cx, py = this.player.cy, pr = this.player.radius;
      for (const p of (this.portals || [])) {
        const hw = (p.size ? p.size[0] : 32) / 2, hh = (p.size ? p.size[1] : 32) / 2;
        let hit;
        if (p.shape === 'circle') {                       // 圆 vs 圆
          const rr = hw + pr;
          const ddx = px - p.pos[0], ddy = py - p.pos[1];
          hit = ddx * ddx + ddy * ddy <= rr * rr;
        } else {                                          // 圆 vs 矩形（最近点）
          const nx = M.clamp(px, p.pos[0] - hw, p.pos[0] + hw);
          const ny = M.clamp(py, p.pos[1] - hh, p.pos[1] + hh);
          const ddx = px - nx, ddy = py - ny;
          hit = ddx * ddx + ddy * ddy <= pr * pr;
        }
        if (hit) { this._transitionTo(p); break; }
      }
    }
    _transitionTo(p) {
      this._portalCd = 0.6;
      const key = p.target_scene;

      // portal.gd：target_scene 为空 → 场景内传送（只移动玩家，不重载地图）
      if (!key) {
        if (!p.target_pos) return;
        this.player.x = p.target_pos[0];
        this.player.y = p.target_pos[1];
        this.player.selectedEnemy = null;
        this.cam.follow(this.player.x, this.player.y);
        return;
      }

      // target_scene 有值 → 跨地图传送（WorldManager.go_to_area）
      this.loadMap(key, p.target_spawn);
      if (SaveManager.currentSlot >= 0) this.saveGame();
      this.hintText(this.player.x, this.player.y - 22, '进入 ' + mapName(key), '#9fe6ff');
    }

    // -------------------------------------------------------- 更新
    update(dt) {
      this.player.update(dt);
      for (const z of this.zones) z.update(dt);
      for (const e of this.enemies) e.update(dt);
      for (const n of this.npcs) n.update(dt);
      for (const f of this.fishing) f.update(dt, this.player);
      for (const d of this.drops) d.update(dt);
      for (const e of this.effects) e.update(dt);
      for (const f of this.floats) f.update(dt);
      for (const i of this.icons) i.update(dt);
      for (const v of this.vfx) v.update(dt);

      this.enemies = this.enemies.filter((e) => !e.dead);
      this.drops = this.drops.filter((d) => !d.dead);
      this.effects = this.effects.filter((e) => !e.dead);
      this.floats = this.floats.filter((f) => !f.dead);
      this.icons = this.icons.filter((i) => !i.dead);
      this.vfx = this.vfx.filter((v) => !v.dead);

      this.cam.follow(this.player.x, this.player.y);
      this._checkPortals(dt);
    }

    // -------------------------------------------------------- 渲染
    render() {
      const ctx = this.ctx, cam = this.cam;
      ctx.imageSmoothingEnabled = false;
      ctx.fillStyle = '#15151c';
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      if (!this.map) return;
      this.map.draw(ctx, cam);

      for (const e of this.enemies) e.selected = (e === this.player.selectedEnemy);

      const ents = [];
      for (const e of this.enemies) if (!e.dead) ents.push(e);
      for (const n of this.npcs) ents.push(n);
      for (const d of this.drops) ents.push(d);
      for (const f of this.fishing) ents.push(f);
      ents.push(this.player);
      ents.sort((a, b) => a.y - b.y);

      for (const e of ents) e.draw(ctx, cam);
      for (const e of this.effects) e.draw(ctx, cam);
      for (const v of this.vfx) v.draw(ctx, cam);
      this._drawPortalSigns(ctx, cam);
      for (const f of this.floats) f.draw(ctx, cam);
      for (const i of this.icons) i.draw(ctx, cam);
    }

    /** 靠近传送门时在门上方显示目的地，避免玩家误入空白的 test_map。 */
    _drawPortalSigns(ctx, cam) {
      if (!this.player) return;
      const px = this.player.cx, py = this.player.cy;
      ctx.save();
      ctx.textAlign = 'center';
      ctx.font = 'bold ' + Math.round(5.5 * cam.zoom) + 'px "Microsoft YaHei", sans-serif';
      for (const p of (this.portals || [])) {
        if (!p.target_scene) continue;                 // 场景内传送（进商店）不标注
        if (Math.hypot(px - p.pos[0], py - p.pos[1]) > 46) continue;
        const [sx, sy] = cam.toScreen(p.pos[0], p.pos[1]);
        const hh = (p.size ? p.size[1] : 32) / 2;
        const ty = sy - (hh + 8) * cam.zoom;
        const label = '→ ' + mapName(p.target_scene);
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(0,0,0,0.85)';
        ctx.strokeText(label, sx, ty);
        ctx.fillStyle = p.target_scene === 'test_map' ? '#ffb15c' : '#9fe6ff';
        ctx.fillText(label, sx, ty);
      }
      ctx.restore();
    }
  }

  // ============================================================ 状态切换
  function startPlay() {
    state = 'play';
    $('title').classList.add('hidden');
    $('pause').classList.add('hidden');
    $('gameover').classList.add('hidden');
    $('hud').classList.remove('hidden');
    if (GAMEDATA.audio.bgm) Audio_.bgm(GAMEDATA.audio.bgm);
  }
  function openPause() {
    if (game.modal) closePanel();
    state = 'pause';
    $('pause').classList.remove('hidden');
  }
  function resumePlay() { state = 'play'; $('pause').classList.add('hidden'); }
  function toTitle() {
    ['pause', 'gameover', 'panel', 'hud'].forEach((id) => $(id).classList.add('hidden'));
    game.player = null;
    state = 'title';
    showTitle();
  }

  // ============================================================ 面板系统
  function openPanel(name) {
    if (game.modal === name) { closePanel(); return; }
    game.modal = name;
    selectedInv = -1;
    renderPanel();
  }
  function closePanel() {
    game.modal = null;
    selectedInv = -1;
    game._dlg = null;
    if (game.player) game.player.isDialogueActive = false;
    $('panel').classList.add('hidden');
  }
  function renderPanel() {
    if (!game.modal) { $('panel').classList.add('hidden'); return; }
    let html = '';
    switch (game.modal) {
      case 'inventory': html = panelInventory(); break;
      case 'equipment': html = panelEquipment(); break;
      case 'skills': html = panelSkills(); break;
      case 'quests': html = panelQuests(); break;
      case 'shop': html = panelShop(); break;
      case 'craft': html = panelCraft(); break;
      case 'stats': html = panelStats(); break;
      case 'dialogue': html = panelDialogue(); break;
    }
    const p = $('panel');
    p.innerHTML = html;
    p.classList.remove('hidden');
  }

  const img = (src) => src ? `<img src="${src}" class="ico" onerror="this.style.visibility='hidden'">` : '';

  function panelInventory() {
    let grid = '';
    for (let i = 0; i < Inventory.slots.length; i++) {
      const s = Inventory.slots[i];
      let inner = '', cls = 'slot';
      if (s) {
        const it = DB.item(s.item);
        inner = img(it ? it.icon : null) + `<span class="qty">${s.qty > 1 ? s.qty : ''}</span>`;
        if (DB.isEquip(it)) cls += ' eq';
        if (i === selectedInv) cls += ' sel';
      }
      grid += `<div class="${cls}" data-act="sel_inv" data-i="${i}">${inner}</div>`;
    }
    let actions = '';
    if (selectedInv >= 0) {
      const s = Inventory.slots[selectedInv];
      if (s) {
        const it = DB.item(s.item);
        const canEq = DB.isEquip(it), canUse = it && it.is_consumable;
        actions = `<div class="actions"><b>${it.name}</b> ×${s.qty}`
          + (canEq ? ` <button data-act="equip" data-i="${selectedInv}">装备</button>` : '')
          + (canUse ? ` <button data-act="use" data-i="${selectedInv}">使用</button>` : '')
          + ` <button data-act="sell" data-i="${selectedInv}">出售</button></div>`;
      }
    }
    return `<div class="ph">背包 (${Inventory.slots.filter(Boolean).length}/${Inventory.slots.length})</div>`
      + `<div class="grid">${grid}</div>${actions}`
      + `<div class="close"><button data-act="close">关闭 (Esc)</button></div>`;
  }

  function panelEquipment() {
    let rows = '';
    RPG.EQUIP_KEYS.forEach((k) => {
      const path = GameData.equipment[k];
      const idx = RPG.EQUIP_KEYS.indexOf(k);
      let inner = '<i>空</i>';
      if (path) {
        const it = DB.item(path);
        inner = img(it.icon) + `<b>${it.name}</b>`;
        const b = DB.bonuses(it).map((x) => `<span style="color:${DB.rarityColor(it)}">${x.label}+${x.value}${x.suffix}</span>`).join(' ');
        inner += `<div class="bonus">${b}</div>`;
      }
      rows += `<div class="eqrow"><div class="eqname">${RPG.EQUIP_NAMES[idx]}</div>`
        + `<div class="eqitem">${inner}</div>`
        + (path ? `<button data-act="unequ" data-k="${k}">卸下</button>` : '') + `</div>`;
    });
    return `<div class="ph">装备</div>${rows}<div class="close"><button data-act="close">关闭 (Esc)</button></div>`;
  }

  function panelSkills() {
    const list = GameData.unlockedSkills.map((sp) => {
      const sk = DB.skill(sp);
      const equipped = GameData.skillSlots.indexOf(sp);
      const slots = [0, 1, 2, 3].map((s) => `<button data-act="skill_equip" data-sp="${sp}" data-s="${s}">${s + 1}</button>`).join('');
      return `<div class="skillrow">${img(sk.icon)}<b>${sk.name}</b><span>${sk.description}</span>`
        + `<div class="slotbtns">装到:${slots}${equipped >= 0 ? ` <em>已装${equipped + 1}</em>` : ''}</div></div>`;
    }).join('') || '<div>暂无已解锁技能</div>';
    const sl = GameData.skillSlots.map((sp, i) => `<div class="skslot">槽${i + 1}: ${sp ? DB.skill(sp).name : '空'}</div>`).join('');
    return `<div class="ph">技能 (按 1-4 释放)</div><div class="slots">${sl}</div>${list}<div class="close"><button data-act="close">关闭 (Esc)</button></div>`;
  }

  function panelQuests() {
    const list = QuestManager.list().map((q) => {
      const st = QuestManager.getStatus(q.quest_id);
      const prog = QuestManager.getProgress(q.quest_id), tgt = QuestManager.getTarget(q.quest_id);
      let btn = '';
      if (st === 'not_accepted') btn = `<button data-act="quest_accept" data-id="${q.quest_id}">接取</button>`;
      else if (st === 'completed') btn = `<button data-act="quest_claim" data-id="${q.quest_id}">领取</button>`;
      else if (st === 'claimed') { const cd = QuestManager.cooldownLeft(q.quest_id); btn = cd > 0 ? `冷却 ${Math.ceil(cd)}s` : '已完成'; }
      else btn = `${prog}/${tgt}`;
      return `<div class="qrow"><b>${q.quest_name}</b><div class="qd">${q.quest_descrip}</div><div>${btn}</div></div>`;
    }).join('') || '<div>暂无任务</div>';
    return `<div class="ph">任务</div>${list}<div class="close"><button data-act="close">关闭 (Esc)</button></div>`;
  }

  function panelShop() {
    const buy = (GAMEDATA.shop_items || []).map((p) => {
      const it = DB.item(p);
      return `<div class="shoprow">${img(it.icon)}<b>${it.name}</b><span>💰${it.price}</span><button data-act="buy" data-p="${p}">购买</button></div>`;
    }).join('') || '<div>商店暂无商品</div>';
    let sell = '';
    Inventory.slots.forEach((s, i) => {
      if (!s) return;
      const it = DB.item(s.item);
      const price = Math.max(1, Math.floor((it.price || 0) / 4));
      sell += `<div class="shoprow">${img(it.icon)}<b>${it.name}</b><span>×${s.qty} 卖💰${price}</span><button data-act="sell" data-i="${i}">出售</button></div>`;
    });
    return `<div class="ph">商店 (持有 💰${GameData.coins})</div><div class="subh">购买</div>${buy}`
      + `<div class="subh">出售背包物品</div>${sell || '<div>背包空空</div>'}`
      + `<div class="close"><button data-act="close">关闭 (Esc)</button></div>`;
  }

  function panelCraft() {
    const rows = (GAMEDATA.recipes || []).map((r) => {
      const out = DB.item(r.item);
      const mats = r.materials.map((m) => `${DB.item(m.item).name}×${m.amount}(${Inventory.count(m.item)})`).join('，');
      const ok = r.materials.every((m) => Inventory.count(m.item) >= m.amount);
      return `<div class="craftrow">${img(out.icon)}<b>${out.name}</b><div class="qd">材料: ${mats}</div>`
        + `<button data-act="craft" data-p="${r.item}">${ok ? '合成' : '材料不足'}</button></div>`;
    }).join('') || '<div>暂无配方</div>';
    return `<div class="ph">合成</div>${rows}<div class="close"><button data-act="close">关闭 (Esc)</button></div>`;
  }

  function panelStats() {
    const p = game.player, d = p.statsDisplay();
    const row = (l, base, bonus) =>
      `<tr><td>${l}</td><td>${base}${bonus ? ` <span class="bonus">(+${bonus})</span>` : ''}</td></tr>`;
    const up = (name, val) => `<div class="strbox">${name}: ${val} <button data-act="stat_up" data-s="${name}">+ (消耗✦1)</button></div>`;
    return `<div class="ph">属性 (剩余 ✦${p.currPoints})</div>`
      + up('力量 STR', p.strength) + up('敏捷 DEX', p.dexterity) + up('智力 INT', p.intelligence)
      + `<table class="stattab">`
      + row('伤害', d.damage.base, d.damage.bonus)
      + row('生命', d.health.base, d.health.bonus)
      + row('速度', d.speed.base, d.speed.bonus)
      + row('魔法', d.mana.base, d.mana.bonus)
      + row('暴击率%', d.crit_chance.base, d.crit_chance.bonus)
      + row('暴击伤害%', d.crit_damage.base, d.crit_damage.bonus)
      + `</table><div class="close"><button data-act="close">关闭 (Esc)</button></div>`;
  }

  function panelDialogue() {
    const dlg = game._dlg; if (!dlg) return '';
    const d = DB.dialogue(dlg.npc.dialogue) || {};
    const line = dlg.lines[dlg.i] || '';
    const last = dlg.i >= dlg.lines.length - 1;
    return `<div class="ph">${dlg.npc.name || 'NPC'}</div>`
      + `<div class="dlgline">${img(d.npc_icon)}${line}</div>`
      + `<div class="close"><button data-act="dlg_next">${last ? '结束' : '继续'}</button></div>`;
  }

  // -------------------------------------------------------- 面板动作
  function claimQuest(id) {
    const r = QuestManager.claim(id, game.player);
    if (r.ok) { toast('任务完成！' + (r.xp ? ' 经验+' + r.xp : '')); }
  }
  function equipSkill(path, idx) {
    for (let i = 0; i < 4; i++) if (GameData.skillSlots[i] === path) GameData.skillSlots[i] = null;
    GameData.skillSlots[idx] = path;
    EventBus.emit('player_stats_updated');
  }
  function buyShopItem(path) {
    const it = DB.item(path); if (!it) return;
    if (GameData.coins < it.price) { toast('金币不足'); return; }
    const rem = Inventory.addItem(path, 1);
    if (rem > 0) { toast('背包已满'); return; }
    GameData.coins -= it.price;
    EventBus.emit('coins_changed');
    SFX.BUY();
  }
  function craftRecipe(itemPath) {
    const r = (GAMEDATA.recipes || []).find((x) => x.item === itemPath);
    if (!r) return;
    for (const m of r.materials) if (Inventory.count(m.item) < m.amount) { toast('材料不足'); return; }
    for (const m of r.materials) Inventory.removeItem(m.item, m.amount);
    Inventory.addItem(itemPath, 1);
    SFX.CRAFT(); toast('合成成功');
  }
  function advanceDialogue() {
    const dlg = game._dlg;
    if (!dlg) { closePanel(); return; }
    dlg.i++;
    if (dlg.i >= dlg.lines.length) closePanel();
    else renderPanel();
  }

  function handlePanelAction(act, btn) {
    switch (act) {
      case 'close': closePanel(); return;
      case 'sel_inv': selectedInv = parseInt(btn.dataset.i, 10); renderPanel(); return;
      case 'equip': Inventory.equipItem(parseInt(btn.dataset.i, 10)); renderPanel(); return;
      case 'use': Inventory.useItem(parseInt(btn.dataset.i, 10)); renderPanel(); return;
      case 'sell': Inventory.sellItem(parseInt(btn.dataset.i, 10)); SFX.SELL(); renderPanel(); return;
      case 'unequ': Inventory.unequip(btn.dataset.k); renderPanel(); return;
      case 'quest_accept': QuestManager.accept(btn.dataset.id); renderPanel(); return;
      case 'quest_claim': claimQuest(btn.dataset.id); renderPanel(); return;
      case 'skill_equip': (() => { equipSkill(btn.dataset.sp, parseInt(btn.dataset.s, 10)); renderPanel(); })(); return;
      case 'buy': buyShopItem(btn.dataset.p); renderPanel(); return;
      case 'craft': craftRecipe(btn.dataset.p); renderPanel(); return;
      case 'stat_up': game.player.upgradeStat(btn.dataset.s); renderPanel(); return;
      case 'dlg_next': advanceDialogue(); return;
    }
  }

  // ============================================================ 标题界面
  function fmtTime(sec) {
    sec = Math.floor(sec || 0);
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    if (h > 0) return h + '时' + m + '分';
    if (m > 0) return m + '分' + s + '秒';
    return s + '秒';
  }
  function showTitle() {
    state = 'title';
    $('loading').classList.add('hidden');
    $('hud').classList.add('hidden');
    $('title').classList.remove('hidden');
    const slots = SaveManager.listSlots();
    let html = '';
    slots.forEach((s, i) => {
      if (s) {
        html += `<div class="slotcard"><div class="sl">存档 ${i + 1}</div>`
          + `<div>Lv.${s.level} · ${s.areaName || s.area}</div>`
          + `<div>金币 💰${s.coins} · 时长 ${fmtTime(s.time)}</div>`
          + `<div class="date">${s.date}</div>`
          + `<div class="btns"><button data-act="title_load" data-s="${i}">继续</button>`
          + `<button data-act="title_del" data-s="${i}">删除</button></div></div>`;
      } else {
        html += `<div class="slotcard empty"><div class="sl">存档 ${i + 1}</div><div>空</div>`
          + `<div class="btns"><button data-act="title_new" data-s="${i}">新游戏</button></div></div>`;
      }
    });
    $('slots').innerHTML = html;
  }

  // ============================================================ HUD
  function updateHUD() {
    const p = game.player; if (!p) return;
    const set = (f, t, v, mx) => {
      $(f).style.width = Math.max(0, Math.min(100, (v / mx) * 100)) + '%';
      $(t).textContent = Math.ceil(v) + '/' + Math.round(mx);
    };
    set('hpfill', 'hptext', p.currHealth, p.effMaxHealth());
    set('mpfill', 'mptext', p.currMana, p.effMaxMana());
    set('expfill', 'exptext', p.currExp, p.nextLevelExp);
    $('lvltext').textContent = 'Lv.' + p.currLevel;
    $('cointxt').textContent = '💰' + GameData.coins;
    $('pointtxt').textContent = '✦' + p.currPoints;
  }

  // ============================================================ Toast
  let toastTimer = null;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), 1800);
  }

  // ============================================================ 事件总线刷新
  function refresh() { if (game && game.modal && game.modal !== 'dialogue') renderPanel(); }
  EventBus.on('inventory_changed', refresh);
  EventBus.on('equipment_changed', () => { if (game && game.player) game.player.applyEquipmentStats(); refresh(); });
  EventBus.on('coins_changed', refresh);
  EventBus.on('quests_changed', refresh);
  EventBus.on('player_stats_updated', refresh);
  EventBus.on('alert', (m) => toast(m));
  EventBus.on('used_item', (it) => {
    if (!it || !game || !game.player) return;
    const n = it.name || '';
    if (n.indexOf('法') >= 0 || n.indexOf('魔') >= 0) { game.player.addMana(it.value); toast('+' + it.value + ' 法力'); }
    else { game.player.heal(it.value); toast('+' + it.value + ' 生命'); }
  });

  // ============================================================ 输入接线
  function wireUI() {
    // 画布点击：选择敌人
    canvas.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || state !== 'play' || !game || game.uiBlocking() || !game.player) return;
      const w = game.mouseWorld();
      let best = null, bd = Infinity;
      for (const en of game.enemies) {
        if (en.dead) continue;
        if (en.hitTest(w[0], w[1])) {
          const d = M.dist2(w[0], w[1], en.cx, en.cy);
          if (d < bd) { bd = d; best = en; }
        }
      }
      if (best) game.player.selectedEnemy = best;
    });

    $('panel').addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (b) handlePanelAction(b.dataset.act, b);
    });
    $('title').addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const s = parseInt(b.dataset.s, 10);
      if (b.dataset.act === 'title_new') game.newGame(s);
      else if (b.dataset.act === 'title_load') game.loadGame(s);
      else if (b.dataset.act === 'title_del') { SaveManager.erase(s); showTitle(); }
    });
    $('pause').addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      if (b.dataset.act === 'pause_resume') resumePlay();
      else if (b.dataset.act === 'pause_save') game.saveGame();
      else if (b.dataset.act === 'pause_title') toTitle();
    });
    $('gameover').addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      if (b.dataset.act === 'go_respawn') game.respawn();
      else if (b.dataset.act === 'go_title') toTitle();
    });

    window.addEventListener('keydown', (e) => {
      if (state === 'play') {
        if (game.modal) { if (e.code === 'Escape') closePanel(); return; }
        switch (e.code) {
          case 'KeyI': openPanel('inventory'); break;
          case 'KeyO': openPanel('equipment'); break;
          case 'KeyK': openPanel('skills'); break;
          case 'KeyL': openPanel('quests'); break;
          case 'KeyU': openPanel('stats'); break;
          case 'Escape': openPause(); break;
        }
      } else if (state === 'pause') {
        if (e.code === 'Escape') resumePlay();
      }
    });
  }

  // ============================================================ 主循环
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (state === 'loading') {
      const p = Assets.progress;
      $('pfill').style.width = (p * 100) + '%';
      $('ploading').textContent = Math.floor(p * 100) + '%';
      if (Assets.ready()) showTitle();
    } else if (state === 'play') {
      game.update(dt);
    }
    if (game) game.render();
    if (game && game.player && (state === 'play' || state === 'pause' || state === 'gameover')) updateHUD();
    Input.endFrame();
    requestAnimationFrame(frame);
  }

  // ============================================================ 启动
  function boot() {
    game = new Game(canvas);
    RPG.game = game;                 // 暴露实例，便于浏览器控制台调试与自动化测试
    Input.init(canvas);
    Assets.preload(allTexturePaths());
    wireUI();
    last = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    requestAnimationFrame(frame);
  }

  global.addEventListener('load', boot);
  RPG.Game = Game;
})(window);
