/**
 * 方案 B 后处理：将 bgm.mp3 / icon.svg / manifest.webmanifest 内联到单文件 HTML 中。
 * 运行方式：node scripts/inline-assets.js
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const DIST = join(import.meta.dirname, '..', 'dist-singlefile');
const HTML_PATH = join(DIST, 'index.html');

if (!existsSync(HTML_PATH)) {
  console.error('dist-singlefile/index.html 不存在，请先运行 build:singlefile');
  process.exit(1);
}

let html = readFileSync(HTML_PATH, 'utf-8');

// 1. 内联 icon.svg → data URI
const iconPath = join(DIST, 'icon.svg');
if (existsSync(iconPath)) {
  const iconData = readFileSync(iconPath, 'utf-8');
  const iconBase64 = Buffer.from(iconData).toString('base64');
  html = html.replace(
    /<link[^>]*href="[^"]*icon\.svg"[^>]*\/?>/,
    `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml;base64,${iconBase64}" />`
  );
  console.log('✅ icon.svg 已内联');
}

// 2. 内联 manifest.webmanifest → data URI
const manifestPath = join(DIST, 'manifest.webmanifest');
if (existsSync(manifestPath)) {
  const manifestData = readFileSync(manifestPath, 'utf-8');
  const manifestBase64 = Buffer.from(manifestData).toString('base64');
  html = html.replace(
    /<link[^>]*href="[^"]*manifest\.webmanifest"[^>]*\/?>/,
    `<link rel="manifest" href="data:application/manifest+json;base64,${manifestBase64}" />`
  );
  console.log('✅ manifest.webmanifest 已内联');
}

// 3. 内联 bgm.mp3 → base64 data URI
const bgmPath = join(DIST, 'bgm.mp3');
if (existsSync(bgmPath)) {
  const bgmBuffer = readFileSync(bgmPath);
  const bgmBase64 = bgmBuffer.toString('base64');
  const bgmDataUri = `data:audio/mpeg;base64,${bgmBase64}`;
  
  // 注入脚本：当 bgm.ts 尝试加载 /bgm.mp3 时，替换为 data URI
  // 游戏加载 bgm 的代码在 bgm.ts: a.src = '/bgm.mp3'
  // 我们通过拦截设置 a.src 来替换
  html = html.replace(
    '<script type="module"',
    `<script>window.__RA2WEB_BGM_DATA_URI__ = ${JSON.stringify(bgmDataUri)};</script>
<script type="module"`
  );

  // 给游戏 JS 打补丁：在文件末尾添加代码，拦截 bgm.mp3 的路径
  html = html.replace(
    '</body>',
    `<script type="module">
// 补丁：将 bgm.mp3 的加载路径替换为内联 data URI
const _origCreateElement = document.createElement.bind(document);
document.createElement = function(tag, options) {
  const el = _origCreateElement(tag, options);
  if (tag.toLowerCase() === 'audio') {
    const origSet = Object.getOwnPropertyDescriptor(HTMLAudioElement.prototype, 'src')?.set;
    let srcSet = false;
    Object.defineProperty(el, 'src', {
      get() { return el.getAttribute('src') || ''; },
      set(v) {
        if (v === '/bgm.mp3' && window.__RA2WEB_BGM_DATA_URI__) {
          el.setAttribute('src', window.__RA2WEB_BGM_DATA_URI__);
          srcSet = true;
          return;
        }
        if (origSet) origSet.call(el, v);
        else el.setAttribute('src', v);
      }
    });
  }
  return el;
};
</script></body>`
  );

  console.log(`✅ bgm.mp3 已内联 (${(bgmBuffer.length / 1024 / 1024).toFixed(1)}MB)`);
} else {
  console.log('⚠️ bgm.mp3 不存在，跳过（游戏将以无声模式运行）');
}

writeFileSync(HTML_PATH, html, 'utf-8');
const finalSize = (Buffer.byteLength(html, 'utf-8') / 1024 / 1024).toFixed(1);
console.log(`\n🎮 单文件已生成: dist-singlefile/index.html (${finalSize}MB)`);
