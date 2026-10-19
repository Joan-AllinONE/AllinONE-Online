/* =========================================================================
 * world.js — 瓦片地图渲染（分块缓存）+ 碰撞网格 + 摄像机
 * ========================================================================= */
(function (global) {
  'use strict';
  const RPG = global.RPG;
  const M = RPG.M;

  const TILE = 16;
  const CHUNK = 16;              // 每个缓存块 16x16 瓦片 = 256x256 像素
  const CHUNK_PX = TILE * CHUNK;

  // -------------------------------------------------------------- 摄像机
  class Camera {
    constructor(w, h) {
      this.x = 0; this.y = 0;
      this.w = w; this.h = h;
      this.zoom = 3;             // 对应 player.tscn 的 Camera2D zoom
    }
    get viewW() { return this.w / this.zoom; }
    get viewH() { return this.h / this.zoom; }
    follow(tx, ty) { this.x = tx; this.y = ty; }
    /** 世界坐标 → 屏幕坐标 */
    toScreen(wx, wy) {
      return [(wx - this.x) * this.zoom + this.w / 2, (wy - this.y) * this.zoom + this.h / 2];
    }
    /** 屏幕坐标 → 世界坐标 */
    toWorld(sx, sy) {
      return [(sx - this.w / 2) / this.zoom + this.x, (sy - this.h / 2) / this.zoom + this.y];
    }
    bounds() {
      const hw = this.viewW / 2, hh = this.viewH / 2;
      return [this.x - hw, this.y - hh, this.x + hw, this.y + hh];
    }
  }

  // ---------------------------------------------------------------- 图层
  class TileLayer {
    constructor(def, tilesets) {
      this.name = def.name;
      this.group = def.group;
      this.z = def.z;
      this.visible = def.visible !== false;
      this.ox = def.offset ? def.offset[0] : 0;
      this.oy = def.offset ? def.offset[1] : 0;
      this.ts = tilesets[def.tileset] || null;
      this.cells = new Map();          // "cx,cy" -> [srcId, ax, ay]
      this.chunks = new Map();         // "chx,chy" -> canvas | null
      this.minX = Infinity; this.minY = Infinity;
      this.maxX = -Infinity; this.maxY = -Infinity;

      const c = def.cells || [];
      for (let i = 0; i + 4 < c.length; i += 5) {
        const cx = c[i], cy = c[i + 1];
        this.cells.set(cx + ',' + cy, [c[i + 2], c[i + 3], c[i + 4]]);
        if (cx < this.minX) this.minX = cx;
        if (cy < this.minY) this.minY = cy;
        if (cx > this.maxX) this.maxX = cx;
        if (cy > this.maxY) this.maxY = cy;
      }
    }

    srcRect(srcId, ax, ay) {
      if (!this.ts) return null;
      const s = this.ts.sources[String(srcId)];
      if (!s) return null;
      const rw = s.rs[0], rh = s.rs[1];
      const mx = s.margins ? s.margins[0] : 0;
      const my = s.margins ? s.margins[1] : 0;
      const sx = s.sep ? s.sep[0] : 0;
      const sy = s.sep ? s.sep[1] : 0;
      return {
        tex: s.tex,
        x: mx + ax * (rw + sx),
        y: my + ay * (rh + sy),
        w: rw, h: rh,
      };
    }

    tileInfo(srcId, ax, ay) {
      if (!this.ts) return null;
      const s = this.ts.sources[String(srcId)];
      if (!s) return null;
      return s.tiles[ax + ',' + ay] || null;
    }

    /** 渲染一个分块到离屏 canvas */
    buildChunk(chx, chy) {
      const key = chx + ',' + chy;
      if (this.chunks.has(key)) return this.chunks.get(key);
      const cv = document.createElement('canvas');
      cv.width = CHUNK_PX; cv.height = CHUNK_PX;
      const cx2 = cv.getContext('2d');
      cx2.imageSmoothingEnabled = false;
      let any = false;
      const bx = chx * CHUNK, by = chy * CHUNK;
      for (let ty = 0; ty < CHUNK; ty++) {
        for (let tx = 0; tx < CHUNK; tx++) {
          const cell = this.cells.get((bx + tx) + ',' + (by + ty));
          if (!cell) continue;
          const r = this.srcRect(cell[0], cell[1], cell[2]);
          if (!r) continue;
          const im = RPG.Assets.img(r.tex);
          if (!im || !im.__ok) continue;
          cx2.drawImage(im, r.x, r.y, r.w, r.h, tx * TILE, ty * TILE, TILE, TILE);
          any = true;
        }
      }
      const out = any ? cv : null;
      this.chunks.set(key, out);
      return out;
    }

    draw(ctx, cam) {
      if (!this.visible || !this.ts) return;
      const [l, t, r, b] = cam.bounds();
      // 图层世界偏移
      const wl = l - this.ox, wt = t - this.oy, wr = r - this.ox, wb = b - this.oy;
      const c0 = Math.floor(wl / CHUNK_PX), c1 = Math.floor(wr / CHUNK_PX);
      const r0 = Math.floor(wt / CHUNK_PX), r1 = Math.floor(wb / CHUNK_PX);
      for (let cy = r0; cy <= r1; cy++) {
        for (let cx = c0; cx <= c1; cx++) {
          const cv = this.buildChunk(cx, cy);
          if (!cv) continue;
          const wx = cx * CHUNK_PX + this.ox;
          const wy = cy * CHUNK_PX + this.oy;
          const [sx, sy] = cam.toScreen(wx, wy);
          ctx.drawImage(cv, Math.round(sx), Math.round(sy),
            CHUNK_PX * cam.zoom, CHUNK_PX * cam.zoom);
        }
      }
    }
  }

  // ---------------------------------------------------------------- 地图
  class GameMap {
    constructor(key, def, data) {
      this.key = key;
      this.def = def;
      this.name = def.name || key;
      // Godot 中瓦片层未开 y_sort/z_index，绘制顺序即场景树顺序（转换器已保序）
      this.layers = (def.layers || []).map((l) => new TileLayer(l, data.tilesets));
      this.objects = def.objects || {};
      this.quests = def.quests || [];

      // 碰撞：Map<"cx,cy", {x,y,w,h}>  (世界坐标 AABB)
      this.solids = new Map();
      for (const layer of this.layers) {
        for (const [k, cell] of layer.cells) {
          const info = layer.tileInfo(cell[0], cell[1], cell[2]);
          if (!info || !info.solid) continue;
          const p = k.split(',');
          const cx = parseInt(p[0], 10), cy = parseInt(p[1], 10);
          // Godot 瓦片原点在格子中心
          const centerX = cx * TILE + TILE / 2 + layer.ox;
          const centerY = cy * TILE + TILE / 2 + layer.oy;
          const box = info.box || [-TILE / 2, -TILE / 2, TILE, TILE];
          const rect = { x: centerX + box[0], y: centerY + box[1], w: box[2], h: box[3] };
          const gk = Math.floor(rect.x / TILE) + ',' + Math.floor(rect.y / TILE);
          let arr = this.solids.get(gk);
          if (!arr) { arr = []; this.solids.set(gk, arr); }
          arr.push(rect);
        }
      }

      // 导航格（Navigation 图层：NPC 随机漫游目标）
      this.navCells = [];
      for (const layer of this.layers) {
        if (layer.name !== 'Navigation') continue;
        for (const k of layer.cells.keys()) {
          const p = k.split(',');
          this.navCells.push([
            parseInt(p[0], 10) * TILE + TILE / 2 + layer.ox,
            parseInt(p[1], 10) * TILE + TILE / 2 + layer.oy,
          ]);
        }
        layer.visible = false;    // Navigation 层不渲染
      }
    }

    /** 查询与给定 AABB 相交的所有实体碰撞盒 */
    querySolids(x, y, w, h, out) {
      out.length = 0;
      const c0 = Math.floor((x - TILE) / TILE), c1 = Math.floor((x + w + TILE) / TILE);
      const r0 = Math.floor((y - TILE) / TILE), r1 = Math.floor((y + h + TILE) / TILE);
      for (let cy = r0; cy <= r1; cy++) {
        for (let cx = c0; cx <= c1; cx++) {
          const arr = this.solids.get(cx + ',' + cy);
          if (!arr) continue;
          for (const rc of arr) {
            if (rc.x < x + w && rc.x + rc.w > x && rc.y < y + h && rc.y + rc.h > y) out.push(rc);
          }
        }
      }
      return out;
    }

    /** 圆形角色能否站在 (x,y) */
    freeAt(x, y, radius) {
      const tmp = [];
      this.querySolids(x - radius, y - radius, radius * 2, radius * 2, tmp);
      return tmp.length === 0;
    }

    /** 圆 vs 瓦片 AABB 相交判定 */
    circleHits(cx, cy, r) {
      const tmp = [];
      this.querySolids(cx - r, cy - r, r * 2, r * 2, tmp);
      for (const rc of tmp) {
        const nx = M.clamp(cx, rc.x, rc.x + rc.w);
        const ny = M.clamp(cy, rc.y, rc.y + rc.h);
        const ddx = cx - nx, ddy = cy - ny;
        if (ddx * ddx + ddy * ddy < r * r) return true;
      }
      return false;
    }

    /** 带滑动的移动求解（先 X 后 Y，模拟 move_and_slide）；返回是否发生碰撞 */
    moveCircle(pos, dx, dy, r) {
      let blocked = false;
      if (dx !== 0) {
        if (!this.circleHits(pos.x + dx, pos.y, r)) pos.x += dx;
        else blocked = true;
      }
      if (dy !== 0) {
        if (!this.circleHits(pos.x, pos.y + dy, r)) pos.y += dy;
        else blocked = true;
      }
      return blocked;
    }

    /** 全部瓦片层（实体统一绘制在其上，与 Godot 的 _ensure_player_on_top 一致） */
    draw(ctx, cam) {
      for (const l of this.layers) l.draw(ctx, cam);
    }

    /** 随机导航格坐标（NPC 漫游目标）；没有导航层时返回 null */
    randomNavPos() {
      if (!this.navCells.length) return null;
      const c = this.navCells[(Math.random() * this.navCells.length) | 0];
      return { x: c[0], y: c[1] };
    }

    /** 出生点坐标查询（找不到时回退 PlayerSpawn / 第一个） */
    spawnPos(id) {
      const sp = this.objects.spawns || {};
      let p = sp[id] || sp.PlayerSpawn;
      if (!p) {
        const ks = Object.keys(sp);
        if (ks.length) p = sp[ks[0]];
      }
      return p ? { x: p[0], y: p[1] } : { x: 0, y: 0 };
    }
  }

  RPG.TILE = TILE;
  RPG.Camera = Camera;
  RPG.GameMap = GameMap;
})(window);
