/* ==========================================================
 * core.js — 桌宠核心
 * 职责：事件总线 / 数值系统 / 动画状态机 / 交互（点击·双击·拖拽）
 *       边缘行走 / 投喂 / 作息 / 位置与存档
 * 核心不关心具体形象（渲染器接口由 pet-svg.js / pet-image.js 实现）
 * 核心不关心具体文案（语音由 speech.js 提供，行为由技能模块挂接）
 * ========================================================== */
(function () {
  'use strict';

  /* ---------------- 事件总线 ---------------- */
  const listeners = new Map();

  function on(event, fn) {
    if (!listeners.has(event)) listeners.set(event, []);
    listeners.get(event).push(fn);
  }
  function off(event, fn) {
    const arr = listeners.get(event);
    if (!arr) return;
    const i = arr.indexOf(fn);
    if (i >= 0) arr.splice(i, 1);
  }
  function emit(event, payload) {
    const arr = listeners.get(event);
    if (!arr) return;
    arr.slice().forEach(function (fn) {
      try { fn(payload); } catch (e) { console.error('[PetCore] listener error @' + event, e); }
    });
  }

  /* ---------------- 数值系统 ---------------- */
  const DEFAULT_STATS = { satiety: 80, mood: 80, energy: 90 };
  const stats = { satiety: 80, mood: 80, energy: 90 };

  function getStats() { return { satiety: stats.satiety, mood: stats.mood, energy: stats.energy }; }

  function setStat(key, delta, silent) {
    if (!(key in stats)) return;
    const v = Math.max(0, Math.min(100, stats[key] + delta));
    if (v === stats[key]) return;
    stats[key] = v;
    if (!silent) emit('stats:change', getStats());
  }
  function setStatsAll(obj) {
    if (!obj) return;
    ['satiety', 'mood', 'energy'].forEach(function (k) {
      if (typeof obj[k] === 'number') stats[k] = Math.max(0, Math.min(100, obj[k]));
    });
    emit('stats:change', getStats());
  }

  /* ---------------- 动画状态机 ---------------- */
  /* 状态：idle / happy / sleepy / sleeping / eating / walking / dragging / talking */
  let animState = 'idle';
  let stateRemain = 0;          // ms；0 表示持续型状态
  let renderer = null;
  let facing = 1;               // 1 朝右，-1 朝左
  const TRANSIENT = {           // 有限时长的状态（到时回落 idle）
    happy: 2000, eating: 2400, talking: 2200
  };

  function getAnimState() { return animState; }

  function setAnimState(state, duration) {
    animState = state;
    stateRemain = duration || TRANSIENT[state] || 0;
    if (renderer) {
      try { renderer.setState(state); } catch (e) { console.error(e); }
    }
    emit('anim:state', state);
  }

  function setRenderer(r) {
    renderer = r;
    if (renderer) {
      try {
        renderer.mount(spriteEl);
        renderer.setState(animState);
        renderer.setFacing(facing);
      } catch (e) { console.error(e); }
    }
  }

  function setFacing(dir) {
    if (dir === facing) return;
    facing = dir;
    if (spriteEl) spriteEl.classList.toggle('face-left', facing === -1);
    if (renderer && renderer.setFacing) {
      try { renderer.setFacing(dir); } catch (e) { /* 图片渲染器可忽略 */ }
    }
  }

  /* ---------------- DOM 引用与位置 ---------------- */
  let petEl = null, spriteEl = null;
  let pos = { x: 120, y: 200 };   // 宠器左上角（px）
  const EDGE = 10;                // 屏幕安全边距
  let walkSpeed = 60;             // 行走速度 px/s
  let walkUntilTs = 0;            // 行走截止时间戳
  let fallingToGround = false;    // 是否正在落回地面

  function petSize() {
    if (!petEl) return { w: 170, h: 165 };
    const r = petEl.getBoundingClientRect();
    return { w: r.width || 170, h: r.height || 165 };
  }

  /* 活动区域：桌面模式下由 Electron 注入可用工作区（已排除任务栏），
     使宠物站立/行走时停在任务栏上方；浏览器模式退化为整个视口。
     注意：拖拽边界仍用整个窗口，允许把宠物拖到屏幕任意角落。 */
  function stage() {
    const wa = window.__PET_WORKAREA__;
    if (wa && wa.width > 0 && wa.height > 0) {
      return { left: wa.x, top: wa.y, w: wa.width, h: wa.height };
    }
    return { left: 0, top: 0, w: window.innerWidth, h: window.innerHeight };
  }

  function groundY() {
    const st = stage();
    return Math.max(st.top + EDGE, st.top + st.h - petSize().h - 12);
  }

  function clampPos() {
    const st = stage(), s = petSize();
    pos.x = Math.max(st.left + EDGE - 20, Math.min(st.left + st.w - s.w + 20, pos.x));
    pos.y = Math.max(st.top + EDGE, Math.min(st.top + st.h - s.h + 30, pos.y));
  }

  function applyPos(withTransition) {
    if (!petEl) return;
    if (withTransition) {
      petEl.style.transition = 'top 0.4s cubic-bezier(0.3, 0.9, 0.4, 1.2)';
    } else {
      petEl.style.transition = 'none';
    }
    petEl.style.left = Math.round(pos.x) + 'px';
    petEl.style.top = Math.round(pos.y) + 'px';
  }

  function getPos() { return { x: pos.x, y: pos.y }; }
  function getRelativePos() {
    const st = stage();
    return {
      x: (pos.x - st.left) / Math.max(1, st.w),
      y: (pos.y - st.top) / Math.max(1, st.h)
    };
  }
  function setRelativePos(rp) {
    if (!rp || typeof rp.x !== 'number') return;
    const st = stage();
    pos.x = st.left + rp.x * st.w;
    pos.y = st.top + rp.y * st.h;
    clampPos(); applyPos(false);
  }

  /* ---------------- 交互：点击 / 双击 / 拖拽 ---------------- */
  let lastInteract = Date.now();
  let boredFired = false;

  function touch() {
    lastInteract = Date.now();
    boredFired = false;
  }

  /* 双击检测：第一次点击延迟 320ms 触发，期间再点则升级为双击 */
  let clickPendingTimer = null;

  function fireClick() {
    emit('pet:click');
    setStat('mood', 2);
    setAnimState('happy');
    touch();
  }
  function fireDblClick() {
    emit('pet:dblclick');
    setStat('mood', 8);
    setAnimState('happy', 2200);
    touch();
  }

  function bindInteractions() {
    if (!petEl) return;
    let dragging = false;
    let downX = 0, downY = 0, downTime = 0, moved = false;
    let offsetX = 0, offsetY = 0;

    petEl.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      dragging = true; moved = false;
      downX = e.clientX; downY = e.clientY; downTime = Date.now();
      const r = petEl.getBoundingClientRect();
      offsetX = e.clientX - r.left;
      offsetY = e.clientY - r.top;
      try { petEl.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      petEl.classList.add('dragging');
    });

    petEl.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      const dx = e.clientX - downX, dy = e.clientY - downY;
      if (!moved && Math.hypot(dx, dy) > 7) {
        moved = true;
        stopWalking(true);
        setAnimState('dragging');
        emit('pet:dragstart');
        petEl.style.transition = 'none';
      }
      if (moved) {
        const s = petSize();
        pos.x = e.clientX - offsetX;
        pos.y = e.clientY - offsetY;
        pos.x = Math.max(-20, Math.min(window.innerWidth - s.w + 20, pos.x));
        pos.y = Math.max(-10, Math.min(window.innerHeight - 30, pos.y));
        petEl.style.left = Math.round(pos.x) + 'px';
        petEl.style.top = Math.round(pos.y) + 'px';
        touch();
      }
    });

    function finish(e) {
      if (!dragging) return;
      dragging = false;
      petEl.classList.remove('dragging');
      const quick = (Date.now() - downTime) < 600;
      if (moved) {
        emit('pet:dragend');
        // 放下后落回地面，带小弹跳感
        fallingToGround = true;
        pos.y = groundY();
        applyPos(true);
        setTimeout(function () { fallingToGround = false; }, 450);
        setAnimState('happy', 1500);
      } else if (quick) {
        // 点击 / 双击
        if (clickPendingTimer) {
          clearTimeout(clickPendingTimer);
          clickPendingTimer = null;
          fireDblClick();
        } else {
          clickPendingTimer = setTimeout(function () {
            clickPendingTimer = null;
            fireClick();
          }, 320);
        }
      }
    }
    petEl.addEventListener('pointerup', finish);
    petEl.addEventListener('pointercancel', finish);
  }

  /* ---------------- 行走（桌面边缘漫步） ---------------- */
  function startWalking(durationSec) {
    if (animState === 'dragging' || animState === 'sleeping' || animState === 'eating') return false;
    const dur = durationSec || (5 + Math.random() * 6);
    walkUntilTs = Date.now() + dur * 1000;
    setAnimState('walking');
    // 若在空中，先落回地面
    const gy = groundY();
    if (Math.abs(pos.y - gy) > 6) {
      pos.y = gy;
      applyPos(true);
    }
    emit('pet:walk:start');
    return true;
  }
  function stopWalking(silent) {
    if (animState !== 'walking') return;
    walkUntilTs = 0;
    setAnimState('idle');
    if (!silent) emit('pet:walk:end');
  }

  /* ---------------- 投喂 ---------------- */
  const FOODS = ['🐟', '🍤', '🍗', '🥠', '🍣', '🍪'];

  function feed(emoji) {
    if (animState === 'eating' || animState === 'dragging') return false;
    const food = emoji || FOODS[Math.floor(Math.random() * FOODS.length)];
    emit('pet:feed:start', food);

    // 食物从天而降的飞行动画
    if (petEl && document.body) {
      const r = petEl.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height * 0.4;
      const el = document.createElement('div');
      el.className = 'food-fly';
      el.textContent = food;
      el.style.left = (cx + (Math.random() * 140 - 70)) + 'px';
      el.style.top = '-60px';
      document.body.appendChild(el);
      // 双 rAF 确保初始位置先生效，再触发过渡
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          el.style.left = cx + 'px';
          el.style.top = cy + 'px';
          el.style.transform = 'scale(0.7)';
        });
      });
      setTimeout(function () { el.remove(); }, 900);
    }

    setTimeout(function () {
      setAnimState('eating');
      setStat('satiety', 26);
      setStat('mood', 4);
      setTimeout(function () { emit('pet:feed:end', food); }, 2100);
    }, 780);
    return true;
  }

  /* ---------------- 作息 ---------------- */
  function sleep() {
    if (animState === 'sleeping') return false;
    stopWalking(true);
    setAnimState('sleeping');
    emit('pet:sleep');
    return true;
  }
  function wake() {
    if (animState !== 'sleeping' && animState !== 'sleepy') return false;
    setAnimState('happy', 1600);
    emit('pet:wake');
    return true;
  }

  /* ---------------- 每秒逻辑 tick ---------------- */
  const lastFired = { hungry: 0, sleepy: 0 };

  function tick() {
    const st = getStats();
    const sleeping = animState === 'sleeping';

    // 数值随时间变化（节奏温和，不影响正常使用）
    setStat('satiety', sleeping ? -0.04 : -0.08, true);
    setStat('energy', sleeping ? 0.9 : (animState === 'walking' ? -0.18 : -0.055), true);
    setStat('mood', st.satiety <= 5 ? -0.12 : -0.03, true);
    emit('stats:change', getStats());

    // 瞬时状态回落
    if (stateRemain > 0) {
      stateRemain -= 1000;
      if (stateRemain <= 0 && animState !== 'dragging') setAnimState('idle');
    }

    // 精力极低 → 自动入睡；睡饱 → 自动醒
    if (!sleeping && st.energy <= 4) {
      setAnimState('sleeping');
      emit('pet:sleep');
    } else if (sleeping && st.energy >= 96) {
      setAnimState('happy', 1600);
      emit('pet:wake');
    }

    // 阈值事件（节流：同类 5 分钟内不重复）
    const now = Date.now();
    if (getStats().satiety < 25 && now - lastFired.hungry > 5 * 60 * 1000) {
      lastFired.hungry = now;
      emit('pet:hungry');
    }
    if (!sleeping && getStats().energy < 16 && now - lastFired.sleepy > 5 * 60 * 1000) {
      lastFired.sleepy = now;
      if (animState === 'idle') setAnimState('sleepy');
      emit('pet:sleepy');
    }

    // 长时间无互动 → 无聊（技能可监听后安排小动作）
    if (!boredFired && Date.now() - lastInteract > 120000 &&
        (animState === 'idle' || animState === 'sleepy')) {
      boredFired = true;
      emit('pet:bored');
    }

    emit('tick', { now: now, stats: getStats(), animState: animState });
  }

  /* ---------------- 渲染循环（行走位移） ---------------- */
  let lastFrameTs = 0;
  function frame(ts) {
    const dt = Math.min(0.05, (ts - lastFrameTs) / 1000 || 0.016);
    lastFrameTs = ts;

    if (animState === 'walking' && !fallingToGround && petEl) {
      const s = petSize();
      pos.x += walkSpeed * dt * facing;
      // 碰到屏幕边缘 → 转身
      if (pos.x <= EDGE) { pos.x = EDGE; setFacing(1); }
      if (pos.x >= window.innerWidth - s.w - EDGE) { pos.x = window.innerWidth - s.w - EDGE; setFacing(-1); }
      petEl.style.left = Math.round(pos.x) + 'px';
      if (Date.now() > walkUntilTs) stopWalking();
    }
    requestAnimationFrame(frame);
  }

  /* ---------------- 初始化 ---------------- */
  function init(opts) {
    petEl = (opts && opts.petEl) || document.getElementById('pet');
    spriteEl = (opts && opts.spriteEl) || document.getElementById('pet-sprite');

    // 初始位置：屏幕下方居中
    const s = petSize();
    pos.x = (window.innerWidth - s.w) / 2;
    pos.y = groundY();
    if (opts && opts.pos) setRelativePos(opts.pos);
    else applyPos(false);

    bindInteractions();

    window.addEventListener('resize', function () {
      clampPos(); applyPos(false);
    });

    setInterval(tick, 1000);
    requestAnimationFrame(frame);
    emit('core:ready');
  }

  /* ---------------- 导出 ---------------- */
  const PetCore = {
    on: on, off: off, emit: emit,
    init: init,
    getStats: getStats, setStat: setStat, setStatsAll: setStatsAll,
    getAnimState: getAnimState, setAnimState: setAnimState,
    setRenderer: setRenderer, setFacing: setFacing,
    getPos: getPos, getRelativePos: getRelativePos, setRelativePos: setRelativePos,
    startWalking: startWalking, stopWalking: stopWalking,
    feed: feed, sleep: sleep, wake: wake,
    FOODS: FOODS
  };

  window.PetCore = PetCore;
})();
