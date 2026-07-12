/**
 * 游戏文件托管 API 路由
 *
 * 公开路由（无 JWT）：
 *   GET  /api/v1/games/:gameId/files/*   — 提供单个游戏文件（iframe 子资源加载）
 *   GET  /api/v1/games/:gameId/manifest  — 获取游戏文件清单
 *
 * 认证路由（需 JWT）：
 *   POST   /api/v1/games/:gameId/upload  — 批量上传游戏文件（发布时调用）
 *   DELETE /api/v1/games/:gameId/files   — 删除游戏所有文件（管理用）
 */
import express, { Router, Request, Response } from 'express';
import { logger } from '../logger.js';
import { signToken } from '../auth/jwt.js';

// ==================== MIME 类型映射 ====================

const MIME_MAP: Record<string, string> = {
  // 文本
  '.html': 'text/html; charset=utf-8',
  '.htm':  'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml':  'application/xml; charset=utf-8',
  '.txt':  'text/plain; charset=utf-8',
  '.md':   'text/markdown; charset=utf-8',
  '.csv':  'text/csv; charset=utf-8',
  // 图片
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.svg':  'image/svg+xml',
  '.webp': 'image/webp',
  '.ico':  'image/x-icon',
  '.bmp':  'image/bmp',
  // 音频
  '.mp3':  'audio/mpeg',
  '.ogg':  'audio/ogg',
  '.wav':  'audio/wav',
  '.m4a':  'audio/mp4',
  '.flac': 'audio/flac',
  // 视频
  '.mp4':  'video/mp4',
  '.webm': 'video/webm',
  // 字体
  '.woff':  'font/woff',
  '.woff2': 'font/woff2',
  '.ttf':   'font/ttf',
  '.otf':   'font/otf',
  '.eot':   'application/vnd.ms-fontobject',
  // 其他
  '.wasm': 'application/wasm',
  '.pdf':  'application/pdf',
  '.map':  'application/json',
  '.atlas':'text/plain; charset=utf-8',
  '.fnt':  'text/plain; charset=utf-8',
  '.tmx':  'application/xml; charset=utf-8',
  '.tsx':  'application/xml; charset=utf-8',
};

/** 根据文件扩展名获取 MIME 类型 */
function getMimeType(filePath: string): string {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  return MIME_MAP[ext] || 'application/octet-stream';
}

/** 判断 MIME 类型是否为文本 */
function isTextMimeType(mimeType: string): boolean {
  return mimeType.includes('charset') || mimeType.startsWith('text/') ||
    mimeType.includes('javascript') || mimeType.includes('json') ||
    mimeType.includes('xml') || mimeType.includes('svg') ||
    mimeType.includes('markdown');
}

/** 判断内容是否看起来像 base64 编码 */
function looksLikeBase64(content: string): boolean {
  if (content.length < 4) return false;
  // base64 字符集：A-Z a-z 0-9 + / =，且长度应该是 4 的倍数
  return /^[A-Za-z0-9+/]+={0,2}$/.test(content) && content.length % 4 === 0;
}

/** 判断内容是否为 base64 编码的二进制数据（旧版兼容，仅用于非文本 MIME） */
function isBase64Encoded(content: string, mimeType: string): boolean {
  if (isTextMimeType(mimeType)) {
    return false;
  }
  return looksLikeBase64(content);
}

// ==================== 公开路由工厂 ====================

/**
 * 创建公开路由（挂载在 JWT 中间件之前）
 * GET 请求不需要认证，因为 iframe 内的 <script>/<link> 子资源请求不带 Authorization header
 */
export function createGamesPublicRouter(
  useMemoryDB: boolean,
  memoryDB: any,
  pool: any,
  isProduction: boolean
): Router {
  const router = Router();

  // ----- POST /dev-token — 开发环境令牌签发（桥接 CloudBase Auth 与 JWT） -----
  // 前端使用 CloudBase Auth 登录，但后端 API 需要 JWT。此端点在开发环境中
  // 根据用户 ID 签发 JWT，使前端能够调用认证 API（如游戏文件上传）。
  router.post('/dev-token', (req: Request, res: Response) => {
    try {
      const { userId } = req.body;
      if (!userId || typeof userId !== 'string') {
        return res.status(400).json({ success: false, error: 'Missing userId' });
      }
      const token = signToken({ userId, role: 'player' });
      res.json({ success: true, data: { token } });
    } catch (error: any) {
      logger.error({ err: error }, '[games] dev-token error');
      res.status(500).json({ success: false, error: 'Token generation failed' });
    }
  });

  // ----- GET /:gameId/manifest -----
  router.get('/:gameId/manifest', async (req: Request, res: Response) => {
    try {
      const { gameId } = req.params;
      let files: Array<{ filePath: string; mimeType: string; size: number; etag: string }>;

      if (useMemoryDB) {
        files = await memoryDB.getGameFileManifest(gameId);
      } else {
        const result = await pool.query(
          `SELECT file_path, mime_type, size, etag FROM game_files WHERE game_id = $1 ORDER BY file_path`,
          [gameId]
        );
        files = result.rows.map((r: any) => ({
          filePath: r.file_path,
          mimeType: r.mime_type,
          size: r.size,
          etag: r.etag,
        }));
      }

      res.json({
        success: true,
        data: { gameId, fileCount: files.length, files },
      });
    } catch (error: any) {
      logger.error({ err: error }, '[games] manifest error');
      res.status(500).json({ success: false, error: isProduction ? 'Internal server error' : error.message });
    }
  });

  // ----- GET /:gameId/files/* -----
  router.get('/:gameId/files/*', async (req: Request, res: Response) => {
    try {
      const { gameId } = req.params;
      // Express 的 * 通配符路径：req.params[0] 或 req.path 去掉前缀
      const rawPath = (req.params as any)[0] || req.path.replace(`/api/v1/games/${gameId}/files/`, '');
      const filePath = decodeURIComponent(rawPath).replace(/^\/+/, '');

      if (!filePath) {
        return res.status(400).json({ success: false, error: 'Missing file path' });
      }

      // 防止路径遍历攻击
      if (filePath.includes('..') || filePath.includes('\\')) {
        return res.status(403).json({ success: false, error: 'Invalid file path' });
      }

      let file: { content: string; mime_type: string; size: number; etag: string } | null = null;

      if (useMemoryDB) {
        file = await memoryDB.getGameFile(gameId, filePath);
      } else {
        const result = await pool.query(
          `SELECT content, mime_type, size, etag FROM game_files WHERE game_id = $1 AND file_path = $2`,
          [gameId, filePath]
        );
        file = result.rows[0] || null;
      }

      if (!file) {
        return res.status(404).json({ success: false, error: `File not found: ${filePath}` });
      }

      // ETag 条件请求
      if (req.headers['if-none-match'] === file.etag) {
        return res.status(304).end();
      }

      // 覆盖 Helmet 的 CSP，允许游戏自由使用脚本
      // 安全由 iframe sandbox 属性保障
      res.setHeader('Content-Security-Policy',
        "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:; " +
        "script-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:; " +
        "style-src 'self' 'unsafe-inline' data:; " +
        "img-src 'self' data: blob:; " +
        "media-src 'self' data: blob:; " +
        "font-src 'self' data:; " +
        "connect-src 'self' *; " +
        "worker-src 'self' blob:; " +
        "manifest-src 'self' data:;"
      );

      // 覆盖 Helmet 的其他限制性头
      res.removeHeader('Cross-Origin-Opener-Policy');
      res.removeHeader('Cross-Origin-Embedder-Policy');
      res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');

      // 缓存策略：1小时强缓存 + ETag
      res.setHeader('Cache-Control', 'public, max-age=3600, must-revalidate');
      res.setHeader('ETag', file.etag);
      res.setHeader('Content-Type', file.mime_type);

      // 处理内容编码：二进制文件可能以 base64 存储，需要解码后发送
      const content = file.content;
      if (content.startsWith('__BINARY_BASE64__')) {
        // IndexedDB 保存格式的二进制文件（带前缀标记）
        const base64Data = content.slice('__BINARY_BASE64__'.length);
        const buf = Buffer.from(base64Data, 'base64');
        return res.send(buf);
      } else if (isTextMimeType(file.mime_type) && looksLikeBase64(content)) {
        // 修复：文本文件被错误地以 base64 编码存储（旧版 PublishingPipeline 的问题）
        // 检测到文本 MIME + base64 内容时，自动解码
        try {
          const decoded = Buffer.from(content, 'base64').toString('utf-8');
          // 简单验证：解码后的内容看起来像是有效文本
          if (decoded.length > 0 && /[\x20-\x7E\u00A0-\uFFFF]/.test(decoded.slice(0, 200))) {
            logger.info({ gameId, filePath, mime: file.mime_type }, '[games] auto-decoded base64 text file');
            return res.send(decoded);
          }
        } catch {
          // 解码失败，回退到原文发送
        }
        return res.send(content);
      } else if (!isTextMimeType(file.mime_type) && looksLikeBase64(content)) {
        // 上传 API 存储的二进制文件（无 charset 的 MIME + 有效 base64 内容）
        try {
          const buf = Buffer.from(content, 'base64');
          return res.send(buf);
        } catch {
          // 解码失败，回退到原文发送
        }
      }

      return res.send(content);
    } catch (error: any) {
      logger.error({ err: error }, '[games] file serve error');
      res.status(500).json({ success: false, error: isProduction ? 'Internal server error' : error.message });
    }
  });

  return router;
}

// ==================== 认证路由工厂 ====================

/**
 * 创建认证路由（挂载在 JWT 中间件之后）
 * POST/DELETE 操作需要 JWT 认证
 */
export function createGamesAuthRouter(
  useMemoryDB: boolean,
  memoryDB: any,
  pool: any,
  isProduction: boolean
): Router {
  const router = Router();

  // 上传路由需要更大的 body 限制（默认 100KB 不够）
  const uploadBodyLimit = express.json({ limit: '150mb' });

  // ----- POST /:gameId/upload -----
  router.post('/:gameId/upload', uploadBodyLimit, async (req: Request, res: Response) => {
    try {
      const { gameId } = req.params;
      const userId = (req as any).userId;
      const { files } = req.body as { files?: Array<{ path: string; name: string; content: string; size?: number }> };

      if (!files || !Array.isArray(files) || files.length === 0) {
        return res.status(400).json({ success: false, error: 'Missing or empty files array' });
      }

      // 大小限制：单文件 10MB，单游戏 100MB
      const MAX_FILE_SIZE = 10 * 1024 * 1024;
      const MAX_TOTAL_SIZE = 100 * 1024 * 1024;

      let totalSize = 0;
      const processedFiles: Array<{ filePath: string; content: string; mimeType: string; size: number }> = [];

      for (const f of files) {
        const filePath = f.path || f.name;
        const content = f.content || '';
        const size = f.size || content.length;

        if (size > MAX_FILE_SIZE) {
          return res.status(400).json({
            success: false,
            error: `File too large: ${filePath} (${(size / 1024 / 1024).toFixed(1)}MB > 10MB limit)`,
          });
        }

        totalSize += size;
        if (totalSize > MAX_TOTAL_SIZE) {
          return res.status(400).json({
            success: false,
            error: `Total size exceeds 100MB limit`,
          });
        }

        processedFiles.push({
          filePath,
          content,
          mimeType: getMimeType(filePath),
          size,
        });
      }

      let saved: number;
      if (useMemoryDB) {
        const result = await memoryDB.saveGameFiles(gameId, processedFiles);
        saved = result.saved;
      } else {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          for (const pf of processedFiles) {
            const etag = `"${pf.size}-${Date.now().toString(36)}"`;
            await client.query(
              `INSERT INTO game_files (game_id, file_path, content, mime_type, size, etag)
               VALUES ($1, $2, $3, $4, $5, $6)
               ON CONFLICT (game_id, file_path)
               DO UPDATE SET content=$3, mime_type=$4, size=$5, etag=$6, updated_at=NOW()`,
              [gameId, pf.filePath, pf.content, pf.mimeType, pf.size, etag]
            );
          }
          await client.query('COMMIT');
          saved = processedFiles.length;
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        } finally {
          client.release();
        }
      }

      logger.info({ gameId, userId, saved, totalSize }, '[games] files uploaded');
      res.json({
        success: true,
        data: { gameId, saved, totalSize, hostingType: 'server' },
        message: `Successfully uploaded ${saved} files`,
      });
    } catch (error: any) {
      logger.error({ err: error }, '[games] upload error');
      res.status(500).json({ success: false, error: isProduction ? 'Internal server error' : error.message });
    }
  });

  // ----- DELETE /:gameId/files -----
  router.delete('/:gameId/files', async (req: Request, res: Response) => {
    try {
      const { gameId } = req.params;
      const userId = (req as any).userId;
      let deleted: number;

      if (useMemoryDB) {
        const result = await memoryDB.deleteGameFiles(gameId);
        deleted = result.deleted;
      } else {
        const result = await pool.query(`DELETE FROM game_files WHERE game_id = $1`, [gameId]);
        deleted = result.rowCount || 0;
      }

      logger.info({ gameId, userId, deleted }, '[games] files deleted');
      res.json({
        success: true,
        data: { gameId, deleted },
        message: `Deleted ${deleted} files`,
      });
    } catch (error: any) {
      logger.error({ err: error }, '[games] delete error');
      res.status(500).json({ success: false, error: isProduction ? 'Internal server error' : error.message });
    }
  });

  return router;
}
