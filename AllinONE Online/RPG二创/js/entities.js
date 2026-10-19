/* =========================================================================
 * entities.js — 玩家 / 敌人 / NPC / 掉落物 / 钓鱼点 / 特效
 * 逐条对应原 Godot 脚本的状态机与数值
 * ========================================================================= */
(function (global) {
  'use strict';
  const RPG = global.RPG;
  const M = RPG.M;
  const DB = RPG.DB;
  const GameData = RPG.GameData;
  const Inventory = RPG.Inventory;
  const QuestManager = RPG.QuestManager;
  const EventBus = RPG.EventBus;
  const drawFrame = RPG.drawFrame;

  const DIRS = { down: [0, 1], up: [0, -1], left: [-1, 0], right: [1, 0] };
  // player_state_attack.gd 中的武器旋转角度
  const WEAPON_ROT = { down: 180, left: -90, right: 90, up: 0 };

  function dirName(dx, dy) {
    if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 'right' : 'left';
    return dy > 0 ? 'down' : 'up';
  }

  function drawShadow(ctx, cam, x, y, tex) {
    const im = RPG.Assets.img(tex);
    if (!im || !im.__ok) return;
    const [sx, sy] = cam.toScreen(x, y);
    const w = im.width * 1.5 * cam.zoom, h = im.height * 1.2 * cam.zoom;
    ctx.save();
    ctx.globalAlpha = 0.2;
    ctx.drawImage(im, sx - w / 2, sy - h / 2, w, h);
    ctx.restore();
  }

  // ============================================================ 浮动文字
  class FloatText {
    constructor(x, y, text, color, size) {
      this.x = x; this.y = y;
      this.text = text;
      this.color = color || '#ffffff';
      this.size = size || 9;
      this.life = 0.9;
      this.max = 0.9;
      this.dead = false;
    }
    update(dt) {
      this.life -= dt;
      this.y -= 18 * dt;
      if (this.life <= 0) this.dead = true;
    }
    draw(ctx, cam) {
      const [sx, sy] = cam.toScreen(this.x, this.y);
      const a = M.clamp(this.life / this.max * 1.6, 0, 1);
      ctx.save();
      ctx.globalAlpha = a;
      ctx.font = 'bold ' + Math.round(this.size * cam.zoom) + 'px "Microsoft YaHei", sans-serif';
      ctx.textAlign = 'center';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.85)';
      ctx.strokeText(this.text, sx, sy);
      ctx.fillStyle = this.color;
      ctx.fillText(this.text, sx, sy);
      ctx.restore();
    }
  }

  // ============================================================== 一次性特效
  class Effect {
    constructor(def, x, y) {
      this.def = def;
      this.x = x; this.y = y;
      this.t = 0;
      this.frame = 0;
      this.dead = false;
      this.sx = def.scale ? def.scale[0] : 1;
      this.sy = def.scale ? def.scale[1] : 1;
    }
    update(dt) {
      const n = this.def.frames.length;
      this.t += dt;
      this.frame = Math.floor(this.t * (this.def.fps || 12));
      if (this.frame >= n) this.dead = true;
    }
    draw(ctx, cam) {
      const f = this.def.frames[Math.min(this.frame, this.def.frames.length - 1)];
      const [sx, sy] = cam.toScreen(this.x, this.y);
      drawFrame(ctx, f, sx, sy, { scaleX: this.sx * cam.zoom, scaleY: this.sy * cam.zoom });
    }
  }

  /** 上浮的物品图标（钓鱼收获反馈） */
  class IconFloat {
    constructor(tex, x, y) {
      this.tex = tex; this.x = x; this.y = y;
      this.life = 1.0; this.dead = false;
    }
    update(dt) {
      this.life -= dt; this.y -= 14 * dt;
      if (this.life <= 0) this.dead = true;
    }
    draw(ctx, cam) {
      const im = RPG.Assets.img(this.tex);
      if (!im || !im.__ok) return;
      const [sx, sy] = cam.toScreen(this.x, this.y);
      const w = im.width * cam.zoom, h = im.height * cam.zoom;
      ctx.save();
      ctx.globalAlpha = M.clamp(this.life * 1.4, 0, 1);
      ctx.drawImage(im, sx - w / 2, sy - h / 2, w, h);
      ctx.restore();
    }
  }

  // ================================================================ 掉落物
  class DropItem {
    constructor(g, itemPath, amount, x, y) {
      this.g = g;
      this.item = itemPath;
      this.amount = amount || 1;
      this.x = x; this.y = y;
      this.dead = false;
      this.shine = Math.random() * 2;
      const it = DB.item(itemPath);
      this.icon = it ? it.icon : null;
      this.rarityColor = it && DB.isEquip(it) ? DB.rarityColor(it) : null;
    }
    update(dt) {
      this.shine += dt;
      const p = this.g.player;
      if (!p) return;
      // DropItem 拾取圈 r=6 @(0,-6) vs 玩家碰撞圈 r=7.07 @(0,-7)
      if (M.dist(this.x, this.y - 6, p.x, p.y - 7) <= 13.07) this.pickup();
    }
    pickup() {
      const remaining = Inventory.addItem(this.item, this.amount);
      if (remaining > 0) {
        EventBus.emit('alert', '背包已满');
        if (remaining === this.amount) return;
      }
      RPG.SFX.PICKUP();
      this.dead = true;
    }
    draw(ctx, cam) {
      drawShadow(ctx, cam, this.x, this.y, this.g.data.misc.shadow);
      const im = RPG.Assets.img(this.icon);
      if (!im || !im.__ok) return;
      const [sx, sy] = cam.toScreen(this.x, this.y - 6);
      const w = im.width * cam.zoom, h = im.height * cam.zoom;
      // 稀有度闪光：周期 2.6s 内 0.6s 高亮
      const ph = this.shine % 2.6;
      ctx.drawImage(im, sx - w / 2, sy - h / 2, w, h);
      if (this.rarityColor && ph < 0.6) {
        ctx.save();
        ctx.globalAlpha = 0.45 * Math.sin((ph / 0.6) * Math.PI);
        ctx.globalCompositeOperation = 'lighter';
        ctx.drawImage(im, sx - w / 2, sy - h / 2, w, h);
        ctx.restore();
      }
    }
  }

  // ================================================================== 敌人
  class Enemy {
    constructor(g, def, x, y, zone) {
      this.g = g;
      this.def = def;
      this.x = x; this.y = y;
      this.zone = zone || null;
      this.maxHealth = def.max_health;
      this.hp = def.max_health;
      this.radius = def.radius || 8;
      this.anim = new RPG.Anim(def.anims, def.anim_off);
      this.anim.play('move_down');
      this.state = 'Wander';
      this.dead = false;
      this.selected = false;
      this.hurtFlash = 0;
      // 状态类增益（道具驱动）：冰冻(定身) / 中毒(持续伤害)
      this.frozenTime = 0;
      this.poisonTime = 0;
      this.poisonDps = 0;
      // Wander
      this.targetX = x; this.targetY = y;
      this.speed = 20;
      // Attack
      this.attackTimer = 0;
      this.damageApplied = false;
      this._enterWander();
    }

    /** Area2D 判定中心（碰撞圈 @(0,-6)） */
    get cx() { return this.x; }
    get cy() { return this.y - 6; }

    _enterWander() {
      this.state = 'Wander';
      this.speed = M.rand(20, 20);
      this._pickTarget();
    }
    _pickTarget() {
      if (this.zone) { const p = this.zone.randomPos(); this.targetX = p.x; this.targetY = p.y; }
      else { this.targetX = this.x; this.targetY = this.y; }
    }
    _enterFollow() { this.state = 'Follow'; this.speed = M.rand(20, 35); }
    _enterAttack() { this.state = 'Attack'; this.attackTimer = 0.5; this.damageApplied = false; }

    takeDamage(v) {
      if (this.hp <= 0) return;
      this.hp = Math.max(this.hp - v, 0);
      this.hurtFlash = 0.12;
      if (this.hp <= 0) this._onDead();
    }

    /** 通用状态效果：kind 支持 'freeze' / 'poison'（'burn' 可复用 poison 的 DoT 逻辑）。
     *  新增一种状态 = 在此加一个分支（一次性，之后所有道具纯 JSON 配置）。 */
    applyStatus(kind, duration, dps) {
      duration = duration || 0; dps = dps || 0;
      if (kind === 'freeze') {
        this.frozenTime = Math.max(this.frozenTime, duration);
      } else if (kind === 'poison' || kind === 'burn') {
        this.poisonTime = Math.max(this.poisonTime, duration);
        this.poisonDps = Math.max(this.poisonDps, dps);
      }
      if (this.frozenTime < 0) this.frozenTime = 0;
      if (this.poisonTime < 0) this.poisonTime = 0;
    }

    _onDead() {
      const g = this.g;
      if (g.player && g.player.selectedEnemy === this) g.player.selectedEnemy = null;
      this._dropLoot();
      if (g.player) g.player.addExp(this.def.exp_amount);
      if (this.def.gold_reward > 0) {
        GameData.coins += this.def.gold_reward;
        EventBus.emit('coins_changed');
      }
      if (this.def.enemy_id) QuestManager.addProgressForType('kill', this.def.enemy_id, 1);
      if (this.zone) this.zone.onEnemyDied();
      this.dead = true;
    }

    _dropLoot() {
      const loot = this.def.loot || [];
      if (!loot.length) return;
      const pick = loot[(Math.random() * loot.length) | 0];
      let ax = 0, ay = 1;
      const p = this.g.player;
      if (p) {
        const dx = this.x - p.x, dy = this.y - p.y;
        const len = Math.hypot(dx, dy) || 1;
        ax = dx / len; ay = dy / len;
      }
      this.g.drops.push(new DropItem(this.g, pick.item, pick.amount, this.x + ax * 15, this.y + ay * 15));
    }

    update(dt) {
      if (this.hurtFlash > 0) this.hurtFlash -= dt;
      if (this.frozenTime > 0) this.frozenTime -= dt;
      // 中毒持续伤害（冰冻期间仍生效）
      if (this.poisonTime > 0) {
        this.poisonTime -= dt;
        if (this.hp > 0) {
          this.hp = Math.max(this.hp - this.poisonDps * dt, 0);
          if (this.hp <= 0) { this._onDead(); return; }
        }
      }
      const g = this.g, p = g.player;
      if (!p) return;
      // 冰冻：定身，仅推进动画不执行 AI
      if (this.frozenTime > 0) { this.anim.update(dt); return; }

      const dist = M.dist(this.x, this.y, p.x, p.y);
      // DetectArea r=35 与玩家碰撞圈 r≈7 的重叠判定
      const detectR = (this.def.detect || 35) + 7;

      if (this.state === 'Wander') {
        const dx = this.targetX - this.x, dy = this.targetY - this.y;
        const len = Math.hypot(dx, dy);
        if (len > 0.001) {
          const nx = dx / len, ny = dy / len;
          this._move(nx * this.speed * dt, ny * this.speed * dt);
          this._updateAnim(nx, ny);
        }
        if (M.dist(this.x, this.y, this.targetX, this.targetY) < 20) this._pickTarget();
        if (dist <= detectR) this._enterFollow();

      } else if (this.state === 'Follow') {
        if (dist > detectR) { this._enterWander(); return; }
        if (dist > 15) {
          const nx = (p.x - this.x) / dist, ny = (p.y - this.y) / dist;
          this._move(nx * this.speed * dt, ny * this.speed * dt);
          this._updateAnim(nx, ny);
        } else {
          this._enterAttack();
        }

      } else if (this.state === 'Attack') {
        this.attackTimer -= dt;
        if (this.attackTimer <= 0.25 && !this.damageApplied) {
          this.damageApplied = true;
          if (M.dist(this.x, this.y, p.x, p.y) <= 25) {
            p.takeDamage(this.def.damage);
            g.addFx(g.data.fx.damage, p.x, p.y - 8);
            g.damageText(p.x, p.y - 8, this.def.damage);
            RPG.SFX.IMPACT();
          }
        }
        if (this.attackTimer <= 0) this._enterFollow();
      }

      this.anim.update(dt);
    }

    _move(dx, dy) {
      // 敌人是 Area2D（不参与物理），但仍不该穿墙 —— 用圆形碰撞体约束
      const pos = { x: this.x, y: this.y - 6 };
      this.g.map.moveCircle(pos, dx, dy, this.radius * 0.7);
      this.x = pos.x; this.y = pos.y + 6;
    }

    _updateAnim(dx, dy) { this.anim.play('move_' + dirName(dx, dy)); }

    /** 鼠标点击命中判定 */
    hitTest(wx, wy) {
      return M.dist(wx, wy, this.cx, this.cy) <= this.radius + 3;
    }

    draw(ctx, cam) {
      const g = this.g;
      drawShadow(ctx, cam, this.x, this.y, g.data.misc.shadow);
      if (this.selected) {
        const im = RPG.Assets.img(g.data.misc.selector);
        if (im && im.__ok) {
          const [sx, sy] = cam.toScreen(this.x + 1, this.y - 8);
          ctx.drawImage(im, sx - im.width * cam.zoom / 2, sy - im.height * cam.zoom / 2,
            im.width * cam.zoom, im.height * cam.zoom);
        }
      }
      const [sx, sy] = cam.toScreen(this.x + this.anim.offset[0], this.y + this.anim.offset[1]);
      const f = this.anim.current();
      if (this.hurtFlash > 0) {
        ctx.save();
        drawFrame(ctx, f, sx, sy, { scaleX: cam.zoom, scaleY: cam.zoom });
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = 0.6;
        drawFrame(ctx, f, sx, sy, { scaleX: cam.zoom, scaleY: cam.zoom });
        ctx.restore();
      } else {
        drawFrame(ctx, f, sx, sy, { scaleX: cam.zoom, scaleY: cam.zoom });
      }
      // 血条 20x5
      if (this.hp < this.maxHealth) {
        const [bx, by] = cam.toScreen(this.x - 10, this.y - 28);
        const w = 20 * cam.zoom, h = 4 * cam.zoom;
        ctx.fillStyle = 'rgba(0,0,0,0.7)';
        ctx.fillRect(bx, by, w, h);
        ctx.fillStyle = '#d63b3b';
        ctx.fillRect(bx + 1, by + 1, (w - 2) * M.clamp(this.hp / this.maxHealth, 0, 1), h - 2);
      }
      // 冰冻标记：围绕头顶的青色冰晶
      if (this.frozenTime > 0) {
        const [sx, sy] = cam.toScreen(this.x, this.y - 16);
        ctx.save(); ctx.globalCompositeOperation = 'lighter';
        ctx.strokeStyle = 'rgba(160,235,255,0.9)'; ctx.lineWidth = 2 * cam.zoom;
        const r = 9 * cam.zoom;
        ctx.beginPath();
        for (let i = 0; i < 6; i++) {
          const a = Math.PI / 2 + i * Math.PI / 3;
          const x = sx + Math.cos(a) * r, y = sy + Math.sin(a) * r;
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.closePath(); ctx.stroke();
        ctx.restore();
      }
      // 中毒标记：淡绿色毒气罩
      if (this.poisonTime > 0) {
        const [sx, sy] = cam.toScreen(this.x, this.y - 6);
        ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.5;
        ctx.fillStyle = 'rgba(130,225,85,0.55)';
        ctx.beginPath(); ctx.ellipse(sx, sy, 11 * cam.zoom, 14 * cam.zoom, 0, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      }
    }
  }

  // ================================================================ 刷怪区
  class EnemyZone {
    constructor(g, def) {
      this.g = g;
      this.def = def;
      this.enemyDef = g.data.enemies[def.enemy];
      this.cx = def.center[0]; this.cy = def.center[1];
      this.hw = def.size[0] / 2; this.hh = def.size[1] / 2;
      this.rate = def.spawn_rate || 3;
      this.max = def.max_enemies || 5;
      this.count = 0;
      this.timer = this.rate;
    }
    randomPos() {
      return { x: this.cx + M.rand(-this.hw, this.hw), y: this.cy + M.rand(-this.hh, this.hh) };
    }
    update(dt) {
      this.timer -= dt;
      if (this.timer > 0) return;
      this.timer = this.rate;
      if (this.count >= this.max || !this.enemyDef) return;
      const p = this.randomPos();
      this.g.enemies.push(new Enemy(this.g, this.enemyDef, p.x, p.y, this));
      this.count++;
    }
    onEnemyDied() { this.count = Math.max(0, this.count - 1); }
  }

  // ================================================================== NPC
  const NPC_TYPE = { IDLE: 0, SHOP: 1, QUEST: 2, CRAFTING: 3 };

  class NPC {
    constructor(g, inst) {
      this.g = g;
      this.def = g.data.npcs[inst.scene] || { anims: {}, anim_off: [0, -8] };
      this.x = inst.pos[0]; this.y = inst.pos[1];
      this.type = inst.type;
      this.dialogue = inst.dialogue;
      this.canMove = inst.can_move;
      this.moveSpeed = inst.move_speed || 30;
      this.waitTime = inst.wait_time || 3;
      this.name = (DB.dialogue(this.dialogue) || {}).npc_name || this.def.name || 'NPC';
      this.anim = new RPG.Anim(this.def.anims, this.def.anim_off);
      this.lastDir = 'down';
      this.anim.play('idle_down');
      this.target = null;
      this.wait = 0;
      this.stuck = 0;
      this.radius = 8;
    }

    update(dt) {
      if (!this.canMove) { this.anim.update(dt); return; }
      if (this.wait > 0) {
        this.wait -= dt;
        this.anim.play('idle_' + this.lastDir);
        this.anim.update(dt);
        return;
      }
      if (!this.target) { this.target = this.g.map.randomNavPos(); if (!this.target) { this.anim.update(dt); return; } }

      const dx = this.target.x - this.x, dy = this.target.y - this.y;
      const len = Math.hypot(dx, dy);
      if (len < 6) { this.target = null; this.wait = this.waitTime; this.anim.play('idle_' + this.lastDir); this.anim.update(dt); return; }

      const nx = dx / len, ny = dy / len;
      this.lastDir = dirName(nx, ny);
      const pos = { x: this.x, y: this.y - 6 };
      const blocked = this.g.map.moveCircle(pos, nx * this.moveSpeed * dt, ny * this.moveSpeed * dt, this.radius * 0.7);
      this.x = pos.x; this.y = pos.y + 6;

      if (blocked) {
        this.stuck += dt;
        this.anim.play('idle_' + this.lastDir);
        if (this.stuck >= 3) { this.target = this.g.map.randomNavPos(); this.stuck = 0; }
      } else {
        this.stuck = 0;
        this.anim.play('move_' + this.lastDir);
      }
      this.anim.update(dt);
    }

    hitTest(wx, wy) { return M.dist(wx, wy, this.x, this.y - 8) <= 16; }

    draw(ctx, cam) {
      drawShadow(ctx, cam, this.x, this.y, this.g.data.misc.shadow);
      const [sx, sy] = cam.toScreen(this.x + this.anim.offset[0], this.y + this.anim.offset[1]);
      drawFrame(ctx, this.anim.current(), sx, sy, { scaleX: cam.zoom, scaleY: cam.zoom });
      // 可交互提示
      const p = this.g.player;
      if (p && M.dist(this.x, this.y - 6, p.x, p.y) <= 21) {
        const [tx, ty] = cam.toScreen(this.x, this.y - 24);
        ctx.save();
        ctx.font = 'bold ' + Math.round(6 * cam.zoom) + 'px "Microsoft YaHei", sans-serif';
        ctx.textAlign = 'center';
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(0,0,0,0.85)';
        ctx.strokeText('E', tx, ty);
        ctx.fillStyle = '#ffd84d';
        ctx.fillText('E', tx, ty);
        ctx.restore();
      }
    }
  }

  // =============================================================== 钓鱼点
  const FishState = { NONE: 0, CASTING: 1, REELING: 2 };

  class FishingSpot {
    constructor(g, def) {
      this.g = g;
      this.x = def.pos[0]; this.y = def.pos[1];
      this.pool = def.pool || [];
      this.biteMin = def.bite ? def.bite[0] : 2;
      this.biteMax = def.bite ? def.bite[1] : 4;
      this.reelTimeout = def.reel_timeout || 3;
      this.interactRadius = def.radius || 16;
      this.state = FishState.NONE;
      this.timer = 0;
      this.bob = 0;
    }

    beginFishing(player) {
      if (this.state !== FishState.NONE) return false;
      if (!this.pool.length) { this.g.hintText(player.x, player.y - 20, '这里没有鱼'); return false; }
      this.state = FishState.CASTING;
      RPG.SFX.FISH_CAST();
      this.g.hintText(player.x, player.y - 20, '开始钓鱼…');
      this.timer = M.rand(this.biteMin, this.biteMax);
      return true;
    }

    onInteract(player) {
      if (this.state === FishState.CASTING) {
        this.g.hintText(player.x, player.y - 20, '收竿了');
        this._end(player);
      } else if (this.state === FishState.REELING) {
        this._catch(player);
      }
    }

    update(dt, player) {
      this.bob += dt;
      if (this.state === FishState.NONE) return;
      this.timer -= dt;
      if (this.timer > 0) return;
      if (this.state === FishState.CASTING) {
        this.state = FishState.REELING;
        RPG.SFX.FISH_BITE();
        this.g.hintText(player.x, player.y - 20, '有鱼上钩了！按 E 收竿');
        player.rodShake = 0.3;
        this.timer = this.reelTimeout;
      } else if (this.state === FishState.REELING) {
        this.g.hintText(player.x, player.y - 20, '鱼跑了…');
        this._end(player);
      }
    }

    _catch(player) {
      this.state = FishState.NONE;
      const path = this.pool[(Math.random() * this.pool.length) | 0];
      const item = DB.item(path);
      RPG.SFX.FISH_CATCH();
      this.g.hintText(player.x + 10, player.y - 20, '钓到了 ' + (item ? item.name : '鱼') + '！');
      if (item && item.icon) this.g.icons.push(new IconFloat(item.icon, player.x, player.y - 24));
      Inventory.addItem(path, 1);
      this._end(player);
    }

    _end(player) {
      this.state = FishState.NONE;
      this.timer = 0;
      if (player) player.onFishingEnded();
    }

    draw(ctx, cam) {
      const p = this.g.player;
      // InteractRadius(r=16) 与玩家碰撞圈（圆心 (0,-7)、r≈7）的重叠判定
      const near = p && M.dist(this.x, this.y, p.cx, p.cy) <= this.interactRadius + p.radius;
      if (!near && this.state === FishState.NONE) return;
      const [sx, sy] = cam.toScreen(this.x, this.y);
      ctx.save();
      // 水面涟漪
      ctx.strokeStyle = this.state === FishState.REELING ? '#ffd84d' : 'rgba(180,230,255,0.75)';
      ctx.lineWidth = Math.max(1, cam.zoom * 0.6);
      const r = (6 + Math.sin(this.bob * 3) * 2) * cam.zoom;
      ctx.beginPath();
      ctx.ellipse(sx, sy, r, r * 0.45, 0, 0, Math.PI * 2);
      ctx.stroke();
      if (near && this.state === FishState.NONE) {
        ctx.font = 'bold ' + Math.round(6 * cam.zoom) + 'px "Microsoft YaHei", sans-serif';
        ctx.textAlign = 'center';
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(0,0,0,0.85)';
        ctx.strokeText('E 钓鱼', sx, sy - 10 * cam.zoom);
        ctx.fillStyle = '#9fe6ff';
        ctx.fillText('E 钓鱼', sx, sy - 10 * cam.zoom);
      }
      ctx.restore();
    }
  }

  // ================================================================= 玩家
  class Player {
    constructor(g) {
      const d = g.data.player;
      this.g = g;
      this.def = d;
      this.x = 0; this.y = 0;
      this.radius = 6.4;                 // CircleShape2D r=7.07，略收紧以便过窄道
      this.colOffY = -7;                 // player.tscn: CollisionShape2D position = (0,-7)
      this.anim = new RPG.Anim(d.anims, d.anim_off);
      this.lastDirection = 'down';
      this.state = 'Idle';

      // ---- 属性（player.gd @export 默认值）
      this.maxHealth = d.max_health;
      this.maxMana = d.max_mana;
      this.moveSpeed = d.move_speed;
      this.damage = d.damage;
      this.critChance = d.crit_chance;
      this.critDamage = d.crit_damage;
      this.baseExp = d.base_exp;
      this.expMultiplier = d.exp_multiplier;

      this.currHealth = this.maxHealth;
      this.currMana = this.maxMana;
      this.currExp = 0;
      this.nextLevelExp = d.base_exp;
      this.currLevel = 1;
      this.currPoints = 0;
      this.strength = 0; this.dexterity = 0; this.intelligence = 0;

      // ---- 限时增益（由 AllinONE 道具 effectCode 驱动）----
      this.dmgBuff = 0; this.dmgBuffTime = 0;     // 攻击力加成
      this.defBuff = 0; this.defBuffTime = 0;     // 减伤
      this.invincibleTime = 0;                    // 无敌剩余秒数

      // ---- 武器附魔（由 apply_enchant 设置；key=元素，value={level,expire,base,statusDur,dps}）----
      this.enchants = {};

      this.selectedEnemy = null;
      this.isDialogueActive = false;
      this.isFishing = false;
      this.currentFishingSpot = null;
      this.rodShake = 0;

      this.attackTime = 0;
      this.attackHits = null;
      this.hurtFlash = 0;
      this.anim.play('idle_down');
    }

    // ------------------------------------------------------------ 有效属性
    /** 碰撞体（CollisionShape2D）中心 —— Area2D 重叠判定一律用它，而非精灵原点 */
    get cx() { return this.x; }
    get cy() { return this.y + this.colOffY; }

    effMaxHealth() { return this.maxHealth + GameData.equipBonus('bonus_health'); }
    effMaxMana() { return this.maxMana + GameData.equipBonus('bonus_mana'); }
    effMoveSpeed() { return this.moveSpeed + GameData.equipBonus('bonus_speed'); }

    resetHealth() { this.currHealth = this.effMaxHealth(); }
    resetMana() { this.currMana = this.effMaxMana(); }

    statsDisplay() {
      return {
        damage: { base: this.damage, bonus: GameData.equipBonus('bonus_damage') },
        health: { base: this.maxHealth, bonus: GameData.equipBonus('bonus_health') },
        speed: { base: this.moveSpeed, bonus: GameData.equipBonus('bonus_speed') },
        mana: { base: this.maxMana, bonus: GameData.equipBonus('bonus_mana') },
        crit_chance: { base: this.critChance, bonus: GameData.equipBonus('bonus_crit_chance') },
        crit_damage: { base: this.critDamage, bonus: GameData.equipBonus('bonus_crit_damage') },
      };
    }

    /** 装备变更后重算上限（增加上限时同步补血，卸下时只 clamp） */
    applyEquipmentStats() {
      const newMax = this.effMaxHealth();
      const diff = newMax - this._lastMaxHp0();
      if (diff > 0) this.currHealth += diff;
      this.currHealth = Math.min(this.currHealth, newMax);
      this.currMana = Math.min(this.currMana, this.effMaxMana());
      this._maxHpCache = newMax;
      EventBus.emit('player_stats_updated');
    }
    _lastMaxHp0() {
      if (this._maxHpCache === undefined) this._maxHpCache = this.effMaxHealth();
      return this._maxHpCache;
    }

    // ------------------------------------------------------------ 经验升级
    addExp(v) {
      this.currExp += v;
      while (this.currExp >= this.nextLevelExp) this.levelUp();
      EventBus.emit('player_stats_updated');
    }
    levelUp() {
      this.currExp -= this.nextLevelExp;
      this.currLevel += 1;
      this.currPoints += 4;
      this.nextLevelExp *= this.expMultiplier;
      this.maxHealth += 1.0 + this.currLevel * 0.5;
      this.maxMana += 1.0 + this.currLevel * 0.3;
      this._maxHpCache = this.effMaxHealth();
      this.resetHealth();
      this.resetMana();
      this.g.addFx(this.g.data.fx.level, this.x, this.y - 6);
      this.g.hintText(this.x, this.y - 26, '升级！Lv.' + this.currLevel, '#ffd84d');
      EventBus.emit('player_stats_updated');
    }

    /** STR +1.5攻 +3血 / DEX +2速 +2%暴击 / INT +15法 +5%暴伤 */
    upgradeStat(name) {
      if (this.currPoints <= 0) return false;
      this.currPoints -= 1;
      if (name === 'STR') { this.strength++; this.damage += 1.5; this.maxHealth += 3; this._maxHpCache = this.effMaxHealth(); this.resetHealth(); }
      else if (name === 'DEX') { this.dexterity++; this.moveSpeed += 2; this.critChance += 2; }
      else if (name === 'INT') { this.intelligence++; this.maxMana += 15; this.critDamage += 5; this.resetMana(); }
      EventBus.emit('player_stats_updated');
      return true;
    }

    // 通用增益效果：stat 支持 'damage' / 'defense' / 'invincible'（'speed' 可后续扩展）。
    // 新增一种增益 = 在此加一个分支（一次性，之后所有道具纯 JSON 配置）。
    // amount/duration 为 0 时表示仅刷新/清除：invincible 用 Math.max 叠加时长。
    addBuff(stat, amount, duration) {
      amount = amount || 0; duration = duration || 0;
      if (stat === 'damage') { this.dmgBuff = amount; this.dmgBuffTime = duration; }
      else if (stat === 'defense') { this.defBuff = amount; this.defBuffTime = duration; }
      else if (stat === 'invincible') { this.invincibleTime = Math.max(this.invincibleTime, duration); }
      EventBus.emit('player_stats_updated');
    }

    getDamage(skillDmg) {
      skillDmg = skillDmg || 0;
      let total = this.damage + skillDmg + GameData.equipBonus('bonus_damage') + this.dmgBuff;
      const crit = this.critChance + GameData.equipBonus('bonus_crit_chance');
      const critDmg = this.critDamage + GameData.equipBonus('bonus_crit_damage');
      let isCrit = false;
      if (Math.random() * 100 <= crit) { total *= (1 + critDmg / 100); isCrit = true; }
      return { value: total, crit: isCrit };
    }

    useMana(v) { this.currMana = Math.max(this.currMana - v, 0); EventBus.emit('player_stats_updated'); }
    addMana(v) { this.currMana = Math.min(this.currMana + v, this.effMaxMana()); EventBus.emit('player_stats_updated'); }
    heal(v) { this.currHealth = Math.min(this.currHealth + v, this.effMaxHealth()); EventBus.emit('player_stats_updated'); }

    takeDamage(v) {
      if (this.currHealth <= 0) return;
      if (this.invincibleTime > 0) { this.g.hintText(this.x, this.y - 20, '无敌', '#9fe6ff'); return; }
      const reduced = Math.max(0, v - this.defBuff);
      this.currHealth = Math.max(this.currHealth - reduced, 0);
      this.hurtFlash = 0.15;
      EventBus.emit('player_stats_updated');
      if (this.currHealth <= 0) this.g.onPlayerDead();
    }

    // -------------------------------------------------------------- 技能
    useSkill(index) {
      const path = GameData.skillSlots[index];
      const skill = DB.skill(path);
      if (!skill) return;
      if (this.currMana < skill.mana_cost) {
        this.g.hintText(this.x, this.y - 20, '法力不足', '#ff8a8a');
        return;
      }
      if (skill.is_aoe) this._aoeSkill(skill);
      else this._singleSkill(skill);
    }

    _singleSkill(skill) {
      const e = this.selectedEnemy;
      if (!e || e.dead) { this.selectedEnemy = null; this.g.hintText(this.x, this.y - 20, '未选中目标', '#ff8a8a'); return; }
      const tx = e.x, ty = e.y;
      this.useMana(skill.mana_cost);
      const dmg = this.getDamage(skill.base_dmg);
      e.takeDamage(dmg.value);
      if (skill.effect) this.g.addFx(skill.effect, tx, ty - 8);
      this.g.damageText(tx, ty - 8, dmg.value, dmg.crit);
      RPG.SFX.SKILL_HIT();
    }

    _aoeSkill(skill) {
      this.useMana(skill.mana_cost);
      let ox, oy;
      if (this.selectedEnemy && !this.selectedEnemy.dead) { ox = this.selectedEnemy.x; oy = this.selectedEnemy.y; }
      else { const m = this.g.mouseWorld(); ox = m[0]; oy = m[1]; }
      let hit = 0;
      for (const e of this.g.enemies) {
        if (e.dead) continue;
        if (M.dist(ox, oy, e.cx, e.cy) > skill.aoe_radius) continue;
        const dmg = this.getDamage(skill.base_dmg);
        e.takeDamage(dmg.value);
        this.g.damageText(e.x, e.y - 8, dmg.value, dmg.crit);
        if (skill.effect) this.g.addFx(skill.effect, e.x, e.y - 8);
        hit++;
      }
      if (hit === 0 && skill.effect) this.g.addFx(skill.effect, ox, oy);
      RPG.SFX.SKILL_HIT();
    }

    // -------------------------------------------------------------- 钓鱼
    startFishing(spot) {
      if (this.isFishing) return;
      this.isFishing = true;
      this.currentFishingSpot = spot;
      this.anim.play('idle_' + this.lastDirection);
    }
    onFishingEnded() { this.isFishing = false; this.currentFishingSpot = null; this.rodShake = 0; }

    // ------------------------------------------------------------ 主更新
    update(dt) {
      const Input = RPG.Input;
      if (this.hurtFlash > 0) this.hurtFlash -= dt;
      if (this.rodShake > 0) this.rodShake -= dt;
      // 限时增益衰减
      if (this.dmgBuffTime > 0) { this.dmgBuffTime -= dt; if (this.dmgBuffTime <= 0) { this.dmgBuffTime = 0; this.dmgBuff = 0; } }
      if (this.defBuffTime > 0) { this.defBuffTime -= dt; if (this.defBuffTime <= 0) { this.defBuffTime = 0; this.defBuff = 0; } }
      if (this.invincibleTime > 0) { this.invincibleTime -= dt; if (this.invincibleTime < 0) this.invincibleTime = 0; }

      // 钓鱼中：只响应 E
      if (this.isFishing) {
        if (Input.justAction('interact')) {
          if (this.currentFishingSpot) this.currentFishingSpot.onInteract(this);
          else this.onFishingEnded();
        }
        this.anim.update(dt);
        return;
      }
      if (this.isDialogueActive || this.g.uiBlocking()) { this.anim.update(dt); return; }

      // 交互：优先 NPC，其次钓鱼点
      if (Input.justAction('interact')) {
        if (!this._interactNpc()) this._interactFishing();
      }
      for (let i = 0; i < 4; i++) if (Input.justAction('skill_' + (i + 1))) this.useSkill(i);

      // FSM
      if (this.state === 'Attack') {
        this.attackTime -= dt;
        this._checkWeaponHits();
        if (this.attackTime <= 0) { this.state = 'Idle'; this.attackHits = null; this.anim.play('idle_' + this.lastDirection); }
      } else {
        if (Input.justAction('attack')) { this._enterAttack(); }
        else {
          let ix = 0, iy = 0;
          if (Input.pressed('move_left')) ix -= 1;
          if (Input.pressed('move_right')) ix += 1;
          if (Input.pressed('move_up')) iy -= 1;
          if (Input.pressed('move_down')) iy += 1;
          if (ix !== 0 || iy !== 0) {
            const len = Math.hypot(ix, iy);
            ix /= len; iy /= len;
            this.lastDirection = dirName(ix, iy);
            this.state = 'Walk';
            this.anim.play('walk_' + this.lastDirection);
            const sp = this.effMoveSpeed();
            const pos = { x: this.x, y: this.y + this.colOffY };
            this.g.map.moveCircle(pos, ix * sp * dt, iy * sp * dt, this.radius);
            this.x = pos.x; this.y = pos.y - this.colOffY;
          } else if (this.state !== 'Idle') {
            this.state = 'Idle';
            this.anim.play('idle_' + this.lastDirection);
          }
        }
      }
      this.anim.update(dt);
    }

    _enterAttack() {
      this.state = 'Attack';
      // attack_* 动画：1 帧 @5fps → 0.2s
      this.attackTime = 0.2;
      this.attackHits = new Set();
      this.anim.play('attack_' + this.lastDirection, true);
      RPG.SFX.SLASH();
    }

    /** 武器碰撞盒：Weapon 挂点 + (0,-11) 旋转后，尺寸 6x22 */
    weaponPos() {
      const a = this.def.attach[this.lastDirection];
      return [this.x + a[0], this.y + a[1]];
    }
    _checkWeaponHits() {
      const [wx, wy] = this.weaponPos();
      const d = DIRS[this.lastDirection];
      // 命中盒中心 = 武器挂点 + 朝向 * 11；沿朝向半长 11，横向半宽 3
      const cx = wx + d[0] * 11, cy = wy + d[1] * 11;
      const halfAlong = 11, halfSide = 3;
      for (const e of this.g.enemies) {
        if (e.dead || this.attackHits.has(e)) continue;
        // 敌人碰撞圈 (cx,cy,r) 与 OBB 的近似判定
        const rx = e.cx - cx, ry = e.cy - cy;
        const along = Math.abs(d[0] !== 0 ? rx : ry);
        const side = Math.abs(d[0] !== 0 ? ry : rx);
        if (along <= halfAlong + e.radius && side <= halfSide + e.radius) {
          this.attackHits.add(e);
          const dmg = this.getDamage();
          e.takeDamage(dmg.value);
          this.g.addFx(this.g.data.fx.damage, e.x, e.y - 8);
          this.g.damageText(e.x, e.y - 8, dmg.value, dmg.crit);
          RPG.SFX.HIT();
          // 武器附魔：等级越高，附加元素伤害越大
          this._applyEnchants(e);
          RPG.EventBus.emit('player_attack_hit', { enemy: e, damage: dmg.value, x: e.x, y: e.y });
        }
      }
    }

    /** 武器附魔结算：每次命中敌人时，按附魔等级追加元素伤害 + 状态 + 特效 */
    _applyEnchants(e) {
      const enc = this.enchants;
      if (!enc) return;
      const now = Date.now();
      const MAP = {
        lightning: { vfx: 'lightning', status: null },
        fire:      { vfx: 'flame',    status: 'burn' },
        freeze:    { vfx: 'ice',      status: 'freeze' },
        poison:    { vfx: 'poison',   status: 'poison' },
      };
      for (const k in enc) {
        const cfg = enc[k];
        if (!cfg) continue;
        if (now >= cfg.expire) { enc[k] = null; continue; }   // 过期自动清除
        const m = MAP[k];
        if (!m) continue;
        // 等级缩放：附加伤害 = 基础伤害 × 等级
        const bonus = cfg.base * cfg.level;
        if (this.g.spawnParticles) this.g.spawnParticles(m.vfx, e.cx, e.cy, {});
        if (bonus > 0 && e.takeDamage) e.takeDamage(bonus);
        if (m.status && e.applyStatus) e.applyStatus(m.status, cfg.statusDur, cfg.dps * cfg.level);
      }
    }

    _interactNpc() {
      let best = null, bestD = Infinity;
      for (const n of this.g.npcs) {
        const d = M.dist2(this.x, this.y, n.x, n.y - 6);
        if (d <= 21 * 21 && d < bestD) { best = n; bestD = d; }
      }
      if (!best) return false;
      this.g.interactNpc(best);
      return true;
    }

    _interactFishing() {
      let best = null, bestD = Infinity;
      for (const s of this.g.fishing) {
        if (s.state !== FishState.NONE) continue;
        const d = M.dist2(this.cx, this.cy, s.x, s.y);
        const rr = s.interactRadius + this.radius;
        if (d <= rr * rr && d < bestD) { best = s; bestD = d; }
      }
      if (!best) return;
      if (best.beginFishing(this)) this.startFishing(best);
    }

    // -------------------------------------------------------------- 绘制
    draw(ctx, cam) {
      drawShadow(ctx, cam, this.x, this.y, this.def.shadow);
      const [sx, sy] = cam.toScreen(this.x + this.anim.offset[0], this.y + this.anim.offset[1]);
      const f = this.anim.current();
      if (this.hurtFlash > 0) {
        ctx.save();
        drawFrame(ctx, f, sx, sy, { scaleX: cam.zoom, scaleY: cam.zoom });
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = 0.7;
        drawFrame(ctx, f, sx, sy, { scaleX: cam.zoom, scaleY: cam.zoom });
        ctx.restore();
      } else {
        drawFrame(ctx, f, sx, sy, { scaleX: cam.zoom, scaleY: cam.zoom });
      }
      if (this.state === 'Attack') this._drawWeapon(ctx, cam);
      if (this.isFishing) this._drawRod(ctx, cam);
    }

    _drawWeapon(ctx, cam) {
      const im = RPG.Assets.img(this.def.weapon_icon);
      if (!im || !im.__ok) return;
      const [wx, wy] = this.weaponPos();
      const [sx, sy] = cam.toScreen(wx, wy);
      ctx.save();
      ctx.translate(sx, sy);
      ctx.rotate(WEAPON_ROT[this.lastDirection] * Math.PI / 180);
      const w = im.width * cam.zoom, h = im.height * cam.zoom;
      ctx.drawImage(im, -w / 2, -11 * cam.zoom - h / 2, w, h);
      ctx.restore();
    }

    _drawRod(ctx, cam) {
      const im = RPG.Assets.img(this.def.rod);
      if (!im || !im.__ok) return;
      const a = this.def.attach[this.lastDirection];
      const d = DIRS[this.lastDirection];
      const stretch = (1.7 - 1) * im.width * 0.5;
      const dist = 1.0 + stretch;
      let px = this.x + a[0] + d[0] * dist;
      let py = this.y + a[1] + d[1] * dist;
      if (this.lastDirection === 'left' || this.lastDirection === 'right') py -= 3;
      const [sx, sy] = cam.toScreen(px, py);
      ctx.save();
      ctx.translate(sx, sy);
      if (this.rodShake > 0) ctx.rotate(Math.sin(this.rodShake * 60) * 0.22);
      const w = im.width * 1.7 * cam.zoom, h = im.height * 0.7 * cam.zoom;
      ctx.drawImage(im, -w / 2, -h / 2, w, h);
      ctx.restore();
    }

    // -------------------------------------------------------------- 存档
    saveState() {
      return {
        health: this.currHealth, max_health: this.maxHealth,
        mana: this.currMana, max_mana: this.maxMana,
        exp: this.currExp, next_level_exp: this.nextLevelExp,
        level: this.currLevel, points: this.currPoints,
        str: this.strength, dex: this.dexterity, int: this.intelligence,
        damage: this.damage, move_speed: this.moveSpeed,
        crit_chance: this.critChance, crit_damage: this.critDamage,
        pos_x: this.x, pos_y: this.y,
      };
    }
    loadState(d) {
      if (!d) return;
      this.maxHealth = d.max_health !== undefined ? d.max_health : this.maxHealth;
      this.maxMana = d.max_mana !== undefined ? d.max_mana : this.maxMana;
      this.currHealth = d.health !== undefined ? d.health : this.effMaxHealth();
      this.currMana = d.mana !== undefined ? d.mana : this.effMaxMana();
      this.currExp = d.exp || 0;
      this.nextLevelExp = d.next_level_exp || this.baseExp;
      this.currLevel = d.level || 1;
      this.currPoints = d.points || 0;
      this.strength = d.str || 0; this.dexterity = d.dex || 0; this.intelligence = d.int || 0;
      this.damage = d.damage !== undefined ? d.damage : this.damage;
      this.moveSpeed = d.move_speed !== undefined ? d.move_speed : this.moveSpeed;
      this.critChance = d.crit_chance || 0;
      this.critDamage = d.crit_damage || 0;
      this.x = d.pos_x || 0; this.y = d.pos_y || 0;
      this._maxHpCache = this.effMaxHealth();
      EventBus.emit('player_stats_updated');
    }
  }

  RPG.FloatText = FloatText;
  RPG.Effect = Effect;
  RPG.IconFloat = IconFloat;
  RPG.DropItem = DropItem;
  RPG.Enemy = Enemy;
  RPG.EnemyZone = EnemyZone;
  RPG.NPC = NPC;
  RPG.NPC_TYPE = NPC_TYPE;
  RPG.FishingSpot = FishingSpot;
  RPG.FishState = FishState;
  RPG.Player = Player;
})(window);
