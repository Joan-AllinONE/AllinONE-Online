import { defineConfig, type Plugin } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const GAME_DATA_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../game-data');

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
        if (req.method === 'HEAD') { res.end(); return; }
        createReadStream(filePath, { start, end }).pipe(res);
      });
    },
  };
}

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

/**
 * 方案 B: 单文件构建专用配置
 * 将所有 JS / CSS / 图片 / 字体 / 音频 全部内联到一个 HTML 文件中。
 * 使用 vite-plugin-singlefile 处理 JS 和 CSS 内联，
 * 自定义插件处理 bgm.mp3 等大文件转为 base64 data URI。
 */
export default defineConfig({
  plugins: [
    gameDataPlugin(),
    witnessMockPlugin(),
    viteSingleFile({
      removeViteModuleLoader: true,
      useRecommendedBuildConfig: true,
    }),
    // 移除 crossorigin 确保 file:// 可运行
    {
      name: 'ra2web:no-crossorigin',
      enforce: 'post',
      transformIndexHtml(html) {
        return html.replace(/crossorigin\b\s*/g, '');
      },
    } as Plugin,
  ],
  base: './',
  build: {
    target: 'es2022',
    outDir: 'dist-singlefile',
    assetsInlineLimit: 100 * 1024 * 1024, // 100MB，确保 bgm.mp3 (6MB) 也会被内联
    cssMinify: true,
    rollupOptions: {
      output: {
        // 手动分包确保所有模块被打在一起
        manualChunks: undefined,
      },
    },
  },
  server: {
    port: 5173,
    host: true,
  },
});
