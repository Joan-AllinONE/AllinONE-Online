/* ==========================================================
 * pet-rig.js — 图片生成可动桌宠渲染器（RigRenderer）
 *
 * 生成流程（全自动，用户零操作）：
 *   1. 图片加载 → 中心裁剪 + 降采样
 *   2. 洪水填充背景去除（四角/四边中点取色，仅从边框扩展，
 *      主体内部同色不受影响）
 *   3. alpha 包围盒裁剪主体
 *   4. 骨架绑定：底边中点为支点（transform-origin），全状态
 *      动作形变（呼吸/跳跃/倾斜/行走/悬空摆动）
 *   5. 表情系统双路线：
 *      - 路线 A「精修形象」：抠图成功时按主体包围盒裁剪居中，呈现
 *        干净透明背景的可动形象（不叠加额外五官，保留原图观感）
 *      - 路线 B「表情徽章」：背景去除效果不佳时保留原图方图，并在
 *        上方悬浮 kaomoji 徽章随状态切换（零失败兜底）
 *   6. 落地影子随跳跃缩放 + 粒子位置自适应
 *
 * 降级：任何处理失败自动回退（由 main.js 接管切换回
 * ImageRenderer / 保持原形象）。
 * 接口与 SVG/Image 渲染器一致：mount / setState / setFacing。
 * ========================================================== */
(function () {
  'use strict';

  /* ---------------- 背景去除（洪水填充） ---------------- */
  function sampleAvg(d, w, cx, cy) {
    let r = 0, g = 0, b = 0, n = 0;
    for (let y = cy - 2; y <= cy + 2; y++) {
      for (let x = cx - 2; x <= cx + 2; x++) {
        const i = (y * w + x) * 4;
        r += d[i]; g += d[i + 1]; b += d[i + 2]; n++;
      }
    }
    return [r / n, g / n, b / n];
  }

  /* 返回 { removedRatio }；直接修改 canvas 像素 alpha */
  function floodRemoveBackground(ctx, w, h) {
    const imageData = ctx.getImageData(0, 0, w, h);
    const d = imageData.data;

    const seeds = [
      [3, 3], [w - 4, 3], [3, h - 4], [w - 4, h - 4],
      [w >> 1, 3], [w >> 1, h - 4], [3, h >> 1], [w - 4, h >> 1]
    ];
    const bgColors = seeds.map(function (p) { return sampleAvg(d, w, p[0], p[1]); });

    const TOL2 = 44 * 44; // 颜色容差（欧氏距离平方）
    function isBackground(i) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      for (let c = 0; c < bgColors.length; c++) {
        const bc = bgColors[c];
        const dr = r - bc[0], dg = g - bc[1], db = b - bc[2];
        if (dr * dr + dg * dg + db * db < TOL2) return true;
      }
      return false;
    }

    /* BFS：从全部边框像素出发，遇背景色则置透明并继续扩展 */
    const visited = new Uint8Array(w * h);
    const queue = new Int32Array(w * h * 2);
    let head = 0, tail = 0;
    function seed(x, y) {
      const idx = y * w + x;
      if (!visited[idx]) { visited[idx] = 1; queue[tail++] = idx; }
    }
    for (let x = 0; x < w; x++) { seed(x, 0); seed(x, h - 1); }
    for (let y = 0; y < h; y++) { seed(0, y); seed(w - 1, y); }

    let removed = 0;
    while (head < tail) {
      const idx = queue[head++];
      const i = idx * 4;
      if (d[i + 3] !== 0 && !isBackground(i)) continue; // 非背景：阻断扩展
      if (d[i + 3] !== 0) { d[i + 3] = 0; removed++; }
      const x = idx % w, y = (idx / w) | 0;
      if (x > 0 && !visited[idx - 1]) { visited[idx - 1] = 1; queue[tail++] = idx - 1; }
      if (x < w - 1 && !visited[idx + 1]) { visited[idx + 1] = 1; queue[tail++] = idx + 1; }
      if (y > 0 && !visited[idx - w]) { visited[idx - w] = 1; queue[tail++] = idx - w; }
      if (y < h - 1 && !visited[idx + w]) { visited[idx + w] = 1; queue[tail++] = idx + w; }
    }

    /* 边缘羽化：与透明像素相邻的不透明像素做一次 alpha 衰减 */
    const alphaCopy = new Uint8Array(w * h);
    for (let p = 0; p < w * h; p++) alphaCopy[p] = d[p * 4 + 3];
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const p = y * w + x;
        if (alphaCopy[p] === 0) continue;
        if (alphaCopy[p - 1] === 0 || alphaCopy[p + 1] === 0 ||
            alphaCopy[p - w] === 0 || alphaCopy[p + w] === 0) {
          d[p * 4 + 3] = Math.round(alphaCopy[p] * 0.55);
        }
      }
    }

    ctx.putImageData(imageData, 0, 0);
    return { removedRatio: removed / (w * h) };
  }

  /* alpha 包围盒裁剪（等比缩放 + 留边），返回 dataURL 与锚点信息 */
  function cropToBoundingBox(ctx, size) {
    const imageData = ctx.getImageData(0, 0, size, size);
    const d = imageData.data;
    let minX = size, minY = size, maxX = 0, maxY = 0, found = false;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (d[(y * size + x) * 4 + 3] > 16) {
          found = true;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (!found) return null;
    const pad = 8;
    minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
    maxX = Math.min(size - 1, maxX + pad); maxY = Math.min(size - 1, maxY + pad);
    const bw = maxX - minX + 1, bh = maxY - minY + 1;

    const out = document.createElement('canvas');
    const inner = Math.max(bw, bh);
    out.width = size; out.height = size;
    const octx = out.getContext('2d');
    octx.drawImage(
      ctx.canvas,
      minX, minY, bw, bh,
      (size - bw) / 2, (size - bh) / 2, bw, bh
    );
    return {
      dataURL: out.toDataURL('image/png'),
      /* 面部区启发式：主体上 1/3 的中心（供表情叠层定位参考） */
      faceY: minY + (maxY - minY) * 0.30,
      subjectRatio: (bw * bh) / (size * size)
    };
  }

  /* ---------------- 表情徽章（路线 B 兜底） ---------------- */
  const BADGE_MAP = {
    idle: '',
    happy: '(☆▽☆)',
    sleepy: '(´-ω-`)',
    sleeping: '(˘ω˘) zzZ',
    eating: '(´∀｀)ｍ',
    walking: '(・ω・)ノ',
    dragging: '(⊙ω⊙)',
    talking: '(・∀・)'
  };

  /* ---------------- 渲染器 ---------------- */
  function RigRenderer(imageSrc) {
    let container = null;
    let rootEl = null, flipEl = null, bodyEl = null, badgeEl = null, imgEl = null;
    let mode = 'badge';           // 'face' | 'badge'
    let currentState = 'idle';
    let destroyed = false;

    function applyState(state) {
      currentState = state;
      if (rootEl) rootEl.setAttribute('class', 'rig-pet state-' + state);
      if (bodyEl) bodyEl.setAttribute('class', 'rig-body state-' + state);
      if (badgeEl) {
        const text = mode === 'badge' ? (BADGE_MAP[state] || '') : '';
        badgeEl.textContent = text;
        badgeEl.classList.toggle('hidden', !text);
      }
    }

    function buildDom() {
      container.innerHTML =
        '<div class="rig-pet state-idle">' +
          '<div class="rig-shadow"></div>' +
          '<div class="rig-flip">' +
            '<div class="rig-body state-idle"><img class="rig-img" alt="自定义桌宠形象" draggable="false"/></div>' +
          '</div>' +
          '<div class="rig-badge hidden"></div>' +
        '</div>';
      rootEl = container.querySelector('.rig-pet');
      flipEl = container.querySelector('.rig-flip');
      bodyEl = container.querySelector('.rig-body');
      imgEl = container.querySelector('.rig-img');
      badgeEl = container.querySelector('.rig-badge');
    }

    /* 图片 → 抠图 → 主体裁剪 → 选择表情路线 */
    function processImage(img) {
      const size = 240;
      const canvas = document.createElement('canvas');
      canvas.width = size; canvas.height = size;
      const ctx = canvas.getContext('2d');
      let ok = false;

      try {
        const side = Math.min(img.width, img.height);
        ctx.drawImage(img,
          (img.width - side) / 2, (img.height - side) / 2, side, side,
          0, 0, size, size);

        const res = floodRemoveBackground(ctx, size, size);
        /* 去除率过小说明背景未被识别，过大说明主体被误吃 → 走徽章路线 */
        if (res.removedRatio > 0.02 && res.removedRatio < 0.9) {
          const cropped = cropToBoundingBox(ctx, size);
          if (cropped && cropped.subjectRatio > 0.08) {
            imgEl.src = cropped.dataURL;
            ok = true;
          }
        }
        if (!ok) imgEl.src = canvas.toDataURL('image/png');
      } catch (e) {
        /* 任何像素处理异常 → 完整原图 + 徽章路线 */
        ok = false;
        imgEl.src = imageSrc;
      }

      mode = ok ? 'face' : 'badge';
      if (mode === 'badge') {
        /* 背景去除效果不佳 → 保留原图方图，并悬浮表情徽章兜底 */
        badgeEl.classList.remove('hidden');
      }
      applyState(currentState);
    }

    return {
      mount: function (el) {
        container = el;
        buildDom();
        const img = new Image();
        img.onload = function () { if (!destroyed) processImage(img); };
        img.onerror = function () { if (!destroyed) { mode = 'badge'; imgEl.src = imageSrc; applyState(currentState); } };
        img.src = imageSrc;
      },
      setState: function (state) { applyState(state); },
      setFacing: function (dir) {
        if (flipEl) flipEl.classList.toggle('flip-left', dir === -1);
      },
      destroy: function () {
        destroyed = true;
        if (container) container.innerHTML = '';
      },
      getMode: function () { return mode; }
    };
  }

  window.PetRenderers = window.PetRenderers || {};
  window.PetRenderers.rig = RigRenderer;
})();
