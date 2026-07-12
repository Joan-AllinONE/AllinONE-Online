import { defineConfig, type Plugin } from 'vite';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const GAME_DATA_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../game-data');

/**
 * 开发期把仓库根的 game-data/（玩家自备的红警2文件）以 /game-data/* 暴露给浏览器。
 * 支持 HTTP Range，便于后续按需读取大体积 .mix 的片段。
 */
function gameDataPlugin(): Plugin {
  return {
    name: 'ra2web:serve-game-data',
    configureServer(server) {
      server.middlewares.use('/game-data', (req, res) => {
        const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/');
        const filePath = normalize(join(GAME_DATA_DIR, urlPath));
        if (
          !filePath.startsWith(GAME_DATA_DIR) ||
          !existsSync(filePath) ||
          !statSync(filePath).isFile()
        ) {
          res.statusCode = 404;
          res.end('not found');
          return;
        }
        const size = statSync(filePath).size;
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Type', 'application/octet-stream');

        const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
        let start = 0;
        let end = size - 1;
        if (range) {
          start = Number(range[1]);
          end = range[2] ? Number(range[2]) : end;
          if (start > end || end >= size) {
            res.statusCode = 416;
            res.setHeader('Content-Range', `bytes */${size}`);
            res.end();
            return;
          }
          res.statusCode = 206;
          res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
        }
        res.setHeader('Content-Length', end - start + 1);
        if (req.method === 'HEAD') {
          res.end();
          return;
        }
        createReadStream(filePath, { start, end }).pipe(res);
      });
    },
  };
}

/** 开发期模拟 /api/witness（见证者计数），内存计数，便于本地验证 UI。 */
function witnessMockPlugin(): Plugin {
  let count = 0;
  return {
    name: 'ra2web:witness-mock',
    configureServer(server) {
      server.middlewares.use('/api/witness', (req, res) => {
        if (req.method === 'POST') count += 1;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ n: count, total: count }));
      });
    },
  };
}

/** 修复 file:// 直开：
 *  1. 去除 crossorigin 属性
 *  2. 将 type="module" 改为 defer（IIFE 格式不需要模块，但需要等 DOM 就绪）
 *  3. 移除 manifest 链接（Chrome 不允许 file:// 加载 manifest） */
function fixBuildHtmlPlugin(): Plugin {
  return {
    name: 'ra2web:fix-build-html',
    enforce: 'post',
    transformIndexHtml(html) {
      return html
        .replace(/crossorigin\b\s*/g, '')
        .replace(/type="module"/g, 'defer')
        .replace(/<link[^>]*rel="manifest"[^>]*\/?>\s*/g, '');
    },
  };
}

export default defineConfig({
  plugins: [gameDataPlugin(), witnessMockPlugin(), fixBuildHtmlPlugin()],
  base: './',
  build: {
    target: 'es2022',
    rollupOptions: {
      output: {
        format: 'iife',
        inlineDynamicImports: true,
        name: 'ra2web',
      },
    },
  },
  server: {
    port: 5173,
    host: true,
  },
});
