/* =========================================================================
 * core.js — 资源加载 / 输入 / 音频 / 数学工具
 * 全部使用 <img> / <audio> 标签加载，兼容 file:// 协议（不使用 fetch/XHR）
 * ========================================================================= */
(function (global) {
  'use strict';

  // ------------------------------------------------------------------ math
  const M = {
    clamp: (v, a, b) => (v < a ? a : v > b ? b : v),
    lerp: (a, b, t) => a + (b - a) * t,
    rand: (a, b) => a + Math.random() * (b - a),
    randInt: (a, b) => Math.floor(a + Math.random() * (b - a + 1)),
    pick: (arr) => arr[Math.floor(Math.random() * arr.length)],
    dist: (ax, ay, bx, by) => Math.hypot(bx - ax, by - ay),
    dist2: (ax, ay, bx, by) => (bx - ax) * (bx - ax) + (by - ay) * (by - ay),
  };

  // --------------------------------------------------------------- assets
  const Assets = {
    images: Object.create(null),
    pending: 0,
    loaded: 0,
    failed: [],

    /** 同步返回 Image 对象（可能尚未 complete，绘制时会自动跳过） */
    img(path) {
      if (!path) return null;
      let im = this.images[path];
      if (im) return im;
      im = new Image();
      im.__ok = false;
      this.pending++;
      im.onload = () => { im.__ok = true; this.loaded++; };
      im.onerror = () => { this.loaded++; this.failed.push(path); };
      im.src = path;
      this.images[path] = im;
      return im;
    },

    /** 预加载一批路径 */
    preload(paths) {
      paths.forEach((p) => p && this.img(p));
    },

    get progress() {
      return this.pending === 0 ? 1 : this.loaded / this.pending;
    },

    ready() {
      return this.loaded >= this.pending;
    },
  };

  // ---------------------------------------------------------------- audio
  const Audio_ = {
    enabled: true,
    volume: 0.6,
    bgmVolume: 0.25,
    _pool: Object.create(null),
    _bgm: null,
    _ctx: null,
    _unlocked: false,

    unlock() {
      if (this._unlocked) return;
      this._unlocked = true;
      try {
        const AC = global.AudioContext || global.webkitAudioContext;
        if (AC) this._ctx = new AC();
        if (this._ctx && this._ctx.state === 'suspended') this._ctx.resume();
      } catch (e) { /* ignore */ }
      if (this._bgm) this._bgm.play().catch(() => {});
    },

    /** 播放文件音效（对象池，最多同时 4 份） */
    play(path, vol) {
      if (!this.enabled || !path) return;
      let list = this._pool[path];
      if (!list) {
        list = this._pool[path] = [];
        for (let i = 0; i < 4; i++) {
          const a = new global.Audio();
          a.preload = 'auto';
          a.src = path;
          list.push(a);
        }
      }
      for (const a of list) {
        if (a.paused || a.ended || a.currentTime === 0) {
          try {
            a.volume = M.clamp((vol === undefined ? 1 : vol) * this.volume, 0, 1);
            a.currentTime = 0;
            a.play().catch(() => {});
          } catch (e) { /* ignore */ }
          return;
        }
      }
      try {
        const a = list[0];
        a.currentTime = 0;
        a.play().catch(() => {});
      } catch (e) { /* ignore */ }
    },

    /** 程序化点击音（对应原项目 SoundManager._make_click） */
    beep(startHz, duration, amplitude) {
      if (!this.enabled) return;
      const ctx = this._ctx;
      if (!ctx) return;
      try {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        const t0 = ctx.currentTime;
        osc.type = 'sine';
        osc.frequency.setValueAtTime(startHz, t0);
        osc.frequency.exponentialRampToValueAtTime(Math.max(40, startHz * 0.3), t0 + duration);
        const amp = amplitude * this.volume;
        gain.gain.setValueAtTime(amp, t0);
        gain.gain.linearRampToValueAtTime(0.0001, t0 + duration);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(t0);
        osc.stop(t0 + duration + 0.02);
      } catch (e) { /* ignore */ }
    },

    bgm(path) {
      if (!path) return;
      if (this._bgm) { try { this._bgm.pause(); } catch (e) {} }
      const a = new global.Audio();
      a.src = path;
      a.loop = true;
      a.volume = M.clamp(this.bgmVolume, 0, 1);
      this._bgm = a;
      a.play().catch(() => {});
    },

    setBgmVolume(v) {
      this.bgmVolume = M.clamp(v, 0, 1);
      if (this._bgm) this._bgm.volume = this.bgmVolume;
    },

    setVolume(v) { this.volume = M.clamp(v, 0, 1); },
  };

  /** 音效语义名 → 具体播放方式（对应原项目 Sound 枚举） */
  const SFX = {
    _audioMap: null,
    init(audioData) { this._audioMap = audioData || {}; },
    SLASH()      { Audio_.play(this._audioMap.SLASH, 0.7); },
    HIT()        { Audio_.play(this._audioMap.HIT, 0.7); },
    PICKUP()     { Audio_.play(this._audioMap.PICKUP, 0.8); },
    IMPACT()     { Audio_.play(this._audioMap.IMPACT, 0.7); },
    SKILL_HIT()  { Audio_.play(this._audioMap.SKILL_HIT, 0.7); },
    BUTTON()     { Audio_.beep(1200, 0.03, 0.12); },
    BUY()        { Audio_.beep(800, 0.04, 0.10); },
    SELL()       { Audio_.beep(600, 0.04, 0.10); },
    CRAFT()      { Audio_.beep(1500, 0.05, 0.10); },
    FISH_CAST()  { Audio_.beep(700, 0.10, 0.10); },
    FISH_BITE()  { Audio_.beep(1500, 0.04, 0.12); },
    FISH_CATCH() { Audio_.beep(900, 0.12, 0.12); },
  };

  // ---------------------------------------------------------------- input
  const Input = {
    keys: Object.create(null),
    justPressed: Object.create(null),
    mouse: { x: 0, y: 0, wx: 0, wy: 0, down: false, clicked: false },

    /** 对应 project.godot 的 InputMap */
    actions: {
      move_up: ['KeyW', 'ArrowUp'],
      move_down: ['KeyS', 'ArrowDown'],
      move_left: ['KeyA', 'ArrowLeft'],
      move_right: ['KeyD', 'ArrowRight'],
      attack: ['Space'],
      interact: ['KeyE'],
      skill_1: ['Digit1', 'Numpad1'],
      skill_2: ['Digit2', 'Numpad2'],
      skill_3: ['Digit3', 'Numpad3'],
      skill_4: ['Digit4', 'Numpad4'],
    },

    init(canvas) {
      global.addEventListener('keydown', (e) => {
        // 输入框内不拦截
        const t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
        if (!this.keys[e.code]) this.justPressed[e.code] = true;
        this.keys[e.code] = true;
        if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].indexOf(e.code) >= 0) {
          e.preventDefault();
        }
        Audio_.unlock();
      });
      global.addEventListener('keyup', (e) => { this.keys[e.code] = false; });
      global.addEventListener('blur', () => { this.keys = Object.create(null); });

      canvas.addEventListener('mousemove', (e) => {
        const r = canvas.getBoundingClientRect();
        this.mouse.x = (e.clientX - r.left) * (canvas.width / r.width);
        this.mouse.y = (e.clientY - r.top) * (canvas.height / r.height);
      });
      canvas.addEventListener('mousedown', (e) => {
        if (e.button === 0) { this.mouse.down = true; this.mouse.clicked = true; }
        Audio_.unlock();
      });
      global.addEventListener('mouseup', () => { this.mouse.down = false; });
      canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    },

    pressed(action) {
      const codes = this.actions[action];
      if (!codes) return false;
      for (const c of codes) if (this.keys[c]) return true;
      return false;
    },

    justAction(action) {
      const codes = this.actions[action];
      if (!codes) return false;
      for (const c of codes) if (this.justPressed[c]) return true;
      return false;
    },

    /** 每帧末清理一次性状态 */
    endFrame() {
      this.justPressed = Object.create(null);
      this.mouse.clicked = false;
    },
  };

  // ------------------------------------------------------------ animation
  /** 帧动画播放器：data = { frames:[{tex,region}], fps, loop } */
  class Anim {
    constructor(map, offset) {
      this.map = map || {};
      this.offset = offset || [0, 0];
      this.name = null;
      this.time = 0;
      this.frame = 0;
      this.finished = false;
      this.speed = 1;
    }
    play(name, restart) {
      if (!this.map[name]) {
        // 回退链：同族 *_down → idle_down → 任意可用动画
        const down = name.replace(/_(down|up|left|right)$/, '_down');
        if (this.map[down]) name = down;
        else if (this.map.idle_down) name = 'idle_down';
        else {
          const keys = Object.keys(this.map);
          if (!keys.length) return;
          name = keys[0];
        }
      }
      if (this.name === name && !restart) return;
      this.name = name;
      this.time = 0;
      this.frame = 0;
      this.finished = false;
    }
    update(dt) {
      const a = this.map[this.name];
      if (!a || !a.frames || a.frames.length === 0) return;
      const fps = (a.fps || 5) * this.speed;
      this.time += dt;
      const step = 1 / Math.max(0.001, fps);
      while (this.time >= step) {
        this.time -= step;
        if (this.frame + 1 >= a.frames.length) {
          if (a.loop) this.frame = 0;
          else { this.finished = true; break; }
        } else {
          this.frame++;
        }
      }
    }
    current() {
      const a = this.map[this.name];
      if (!a || !a.frames || !a.frames.length) return null;
      return a.frames[Math.min(this.frame, a.frames.length - 1)];
    }
  }

  /** 绘制一个动画帧（以 x,y 为锚点，frame.region 为图集区域） */
  function drawFrame(ctx, frame, x, y, opt) {
    if (!frame) return;
    const im = Assets.img(frame.tex);
    if (!im || !im.__ok) return;
    opt = opt || {};
    const r = frame.region;
    const sw = r ? r[2] : im.width;
    const sh = r ? r[3] : im.height;
    const sx = r ? r[0] : 0;
    const sy = r ? r[1] : 0;
    const scaleX = opt.scaleX === undefined ? 1 : opt.scaleX;
    const scaleY = opt.scaleY === undefined ? 1 : opt.scaleY;
    const w = sw * scaleX;
    const h = sh * scaleY;
    const dx = x - w / 2 + (opt.ox || 0);
    const dy = y - h / 2 + (opt.oy || 0);
    if (opt.alpha !== undefined && opt.alpha < 1) {
      ctx.save();
      ctx.globalAlpha = opt.alpha;
      ctx.drawImage(im, sx, sy, sw, sh, dx, dy, w, h);
      ctx.restore();
    } else {
      ctx.drawImage(im, sx, sy, sw, sh, dx, dy, w, h);
    }
  }

  global.RPG = global.RPG || {};
  global.RPG.M = M;
  global.RPG.Assets = Assets;
  global.RPG.Audio = Audio_;
  global.RPG.SFX = SFX;
  global.RPG.Input = Input;
  global.RPG.Anim = Anim;
  global.RPG.drawFrame = drawFrame;
})(window);
