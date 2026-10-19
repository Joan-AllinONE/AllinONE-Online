/* ==========================================================
 * pet-svg.js — SVG 宠物渲染器（橘小猫）
 * 实现统一渲染器接口：mount / setState / setFacing
 * 状态动画与表情切换由 CSS 类驱动（见 style.css），资源占用低。
 * ========================================================== */
(function () {
  'use strict';

  /* viewBox: 0 0 200 190，部件坐标手工调校 */
  const SVG_MARKUP =
    '<svg class="pet-svg state-idle" viewBox="0 0 200 190" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
      /* 地面影子（不随跳跃） */
      '<ellipse class="ground-shadow" cx="100" cy="182" rx="50" ry="8" fill="#4a3b2a" opacity="0.14"/>' +

      '<g class="pet-all">' +
        /* 尾巴 */
        '<path class="tail" d="M148 152 Q184 138 176 98" fill="none" stroke="#f0a028" stroke-width="15" stroke-linecap="round"/>' +
        '<path class="tail" d="M148 152 Q184 138 176 98" fill="none" stroke="#fbb540" stroke-width="9" stroke-linecap="round"/>' +

        /* 耳朵 */
        '<path d="M52 82 L62 30 L94 56 Z" fill="#fbb540"/>' +
        '<path d="M61 70 L66 44 L83 57 Z" fill="#ffd8b0"/>' +
        '<path d="M148 82 L138 30 L106 56 Z" fill="#fbb540"/>' +
        '<path d="M139 70 L134 44 L117 57 Z" fill="#ffd8b0"/>' +

        /* 身体 */
        '<ellipse class="body" cx="100" cy="126" rx="58" ry="53" fill="#fbb540"/>' +
        /* 肚皮 */
        '<ellipse cx="100" cy="150" rx="31" ry="26" fill="#ffe9c9"/>' +

        /* 手手 */
        '<ellipse cx="66" cy="152" rx="13" ry="9" fill="#fbb540" transform="rotate(14 66 152)"/>' +
        '<ellipse cx="134" cy="152" rx="13" ry="9" fill="#fbb540" transform="rotate(-14 134 152)"/>' +

        /* 脚脚 */
        '<ellipse class="foot-l" cx="80" cy="174" rx="14" ry="8" fill="#f0a028"/>' +
        '<ellipse class="foot-r" cx="120" cy="174" rx="14" ry="8" fill="#f0a028"/>' +

        /* 脸 */
        '<g class="face">' +
          /* 睁眼 */
          '<g class="eyes-open">' +
            '<circle cx="76" cy="100" r="9" fill="#3d3d3d"/>' +
            '<circle cx="79" cy="97" r="3" fill="#fff"/>' +
            '<circle cx="124" cy="100" r="9" fill="#3d3d3d"/>' +
            '<circle cx="127" cy="97" r="3" fill="#fff"/>' +
          '</g>' +
          /* 眯眼笑（^ ^） */
          '<g class="eyes-happy">' +
            '<path d="M67 102 Q76 90 85 102" fill="none" stroke="#3d3d3d" stroke-width="4.5" stroke-linecap="round"/>' +
            '<path d="M115 102 Q124 90 133 102" fill="none" stroke="#3d3d3d" stroke-width="4.5" stroke-linecap="round"/>' +
          '</g>' +
          /* 闭眼（- -） */
          '<g class="eyes-closed">' +
            '<path d="M67 100 L85 100" fill="none" stroke="#3d3d3d" stroke-width="4.5" stroke-linecap="round"/>' +
            '<path d="M115 100 L133 100" fill="none" stroke="#3d3d3d" stroke-width="4.5" stroke-linecap="round"/>' +
          '</g>' +
          /* 惊讶眼（拖拽时） */
          '<g class="eyes-surprised">' +
            '<circle cx="76" cy="100" r="12" fill="#3d3d3d"/>' +
            '<circle cx="79" cy="96" r="4" fill="#fff"/>' +
            '<circle cx="124" cy="100" r="12" fill="#3d3d3d"/>' +
            '<circle cx="127" cy="96" r="4" fill="#fff"/>' +
          '</g>' +

          /* 腮红 */
          '<ellipse cx="60" cy="116" rx="9" ry="6" fill="#ff9e9e" opacity="0.55"/>' +
          '<ellipse cx="140" cy="116" rx="9" ry="6" fill="#ff9e9e" opacity="0.55"/>' +

          /* 普通嘴（ω 微笑） */
          '<g class="mouth-normal">' +
            '<path d="M90 118 Q95 124 100 119 Q105 124 110 118" fill="none" stroke="#7a5230" stroke-width="3.2" stroke-linecap="round"/>' +
          '</g>' +
          /* 张嘴（进食/惊讶/说话） */
          '<g class="mouth-open">' +
            '<ellipse cx="100" cy="122" rx="10" ry="8" fill="#b5533c"/>' +
            '<ellipse cx="100" cy="126" rx="6" ry="4" fill="#ff8f8f"/>' +
          '</g>' +
          /* 大笑嘴（开心） */
          '<g class="mouth-happy">' +
            '<path d="M87 116 Q100 133 113 116 Z" fill="#b5533c"/>' +
            '<path d="M93 125 Q100 130 107 125 L107 127 Q100 132 93 127 Z" fill="#ff8f8f"/>' +
          '</g>' +
        '</g>' +
      '</g>' +
    '</svg>';

  function SVGRenderer() {
    let container = null;
    let svg = null;
    let blinkTimer = null;
    let destroyed = false;

    function scheduleBlink() {
      if (destroyed) return;
      const delay = 2200 + Math.random() * 2800;
      blinkTimer = setTimeout(function () {
        if (svg && !destroyed) {
          const st = svg.getAttribute('class') || '';
          // 仅在「睁眼」的状态下眨眼
          if (/state-(idle|walking|talking)/.test(st)) {
            svg.classList.add('blink');
            setTimeout(function () {
              if (svg) svg.classList.remove('blink');
            }, 150);
          }
        }
        scheduleBlink();
      }, delay);
    }

    return {
      mount: function (el) {
        container = el;
        container.innerHTML = SVG_MARKUP;
        svg = container.querySelector('svg');
        scheduleBlink();
      },
      setState: function (state) {
        if (!svg) return;
        svg.setAttribute('class', 'pet-svg state-' + state);
      },
      setFacing: function (dir) {
        /* 朝向翻转由外层 #pet-sprite 统一处理，这里无需额外操作 */
      },
      destroy: function () {
        destroyed = true;
        if (blinkTimer) clearTimeout(blinkTimer);
        if (container) container.innerHTML = '';
      }
    };
  }

  window.PetRenderers = window.PetRenderers || {};
  window.PetRenderers.svg = SVGRenderer;
})();
