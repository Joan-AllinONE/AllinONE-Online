/* ==========================================================
 * pet-image.js — 图片宠物渲染器（用户上传图片自动生成桌宠）
 * 实现与 SVG 渲染器相同的接口：mount / setState / setFacing
 * 图片经过中心裁剪 + 压缩（见 main.js 上传流程），动作语义与
 * 默认宠物一致（待机浮动 / 开心跳跳 / 困倦倾斜 / 行走摇摆…）。
 * ========================================================== */
(function () {
  'use strict';

  function ImageRenderer(imageSrc) {
    let container = null;

    return {
      mount: function (el) {
        container = el;
        container.innerHTML =
          '<div class="image-pet state-idle">' +
            '<img src="' + imageSrc + '" alt="自定义桌宠形象" draggable="false"/>' +
          '</div>';
      },
      setState: function (state) {
        const el = container && container.querySelector('.image-pet');
        if (el) el.setAttribute('class', 'image-pet state-' + state);
      },
      setFacing: function (dir) {
        /* 图片形象不做镜像翻转，避免文字/图案反向 */
      },
      destroy: function () {
        if (container) container.innerHTML = '';
      }
    };
  }

  window.PetRenderers = window.PetRenderers || {};
  window.PetRenderers.image = ImageRenderer;

  /* 图片压缩工具：中心方形裁剪 + 缩放到 max 尺寸，输出 dataURL（PNG） */
  window.PetRenderers.prepareImageFile = function (file, maxSize, callback) {
    maxSize = maxSize || 260;
    const reader = new FileReader();
    reader.onerror = function () { callback(null); };
    reader.onload = function () {
      const img = new Image();
      img.onerror = function () { callback(null); };
      img.onload = function () {
        try {
          const side = Math.min(img.width, img.height);
          const canvas = document.createElement('canvas');
          canvas.width = maxSize;
          canvas.height = maxSize;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(
            img,
            (img.width - side) / 2, (img.height - side) / 2, side, side,
            0, 0, maxSize, maxSize
          );
          callback(canvas.toDataURL('image/png'));
        } catch (e) {
          callback(null);
        }
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  };
})();
