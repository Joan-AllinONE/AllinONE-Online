/**
 * 内容工坊（Content Workshop）隧道路由 — /api/v1/games/__content
 *
 * 与任务广场 __quests 并列的独立隧道，专用于「内容凭证」资产：
 * - mint 时把内容包资产写入游戏文件库 content/{contentId}/{path}
 *   （复用 game_files / GET /:gameId/files/* 分发，含 SW 三级回退），
 *   元信息写入 content_assets 集合（manifest 只含清单，不含大资产本体）。
 * - remix 上架走审核（pending → approved/rejected），approved 后追加到
 *   published_games[gameId].questExtensions，GamePlay ?ext= 即可切换。
 *
 * ⚠️ 双实现铁律：本文件（本地 server）与 cloudfunctions/gamesApi/index.js
 * 的 __content 路由必须保持一致，否则 dev/prod 行为分叉。
 */

import { Router, Request, Response } from 'express';
import { logger } from '../logger.js';

// ==================== MIME ====================

const MIME_MAP: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

function getMimeType(filePath: string): string {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  return MIME_MAP[ext] || 'application/octet-stream';
}

/** 生成内容 ID */
function generateContentId(): string {
  return 'ct_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

// ==================== 路由工厂 ====================

export function createContentRouter(
  useMemoryDB: boolean,
  memoryDB: any,
  pool: any,
  isProduction: boolean
): Router {
  const router = Router();

  // ----- POST /mint — 铸造内容资产（公开无 JWT：资产落库 + 元信息，返回 manifest） -----
  router.post('/mint', async (req: Request, res: Response) => {
    try {
      const body = (req.body || {}) as any;
      const { gameId, contentPack, authorId, authorName } = body;
      if (!gameId || typeof gameId !== 'string') {
        return res.status(400).json({ success: false, error: 'Missing gameId' });
      }
      if (!contentPack || typeof contentPack !== 'object') {
        return res.status(400).json({ success: false, error: 'Missing contentPack' });
      }
      const type = String(contentPack.type || 'custom');
      const slot = String(contentPack.slot || 'inject');
      const name = String(contentPack.name || '未命名内容');

      // 轻量校验（内容凭证按次消费、持有者自担风险，仅做注入模式最小检查；与云函数 __content 对齐）
      const issues: string[] = [];
      if (contentPack.inject === true) {
        const assets = Array.isArray(contentPack.assets) ? contentPack.assets : [];
        const hasJs = assets.some((a: any) => String((a && a.path) || '').toLowerCase().endsWith('.js'));
        const hasInline = typeof contentPack.data === 'object' && contentPack.data && typeof (contentPack.data as any).code === 'string' && String((contentPack.data as any).code).trim();
        if (!hasJs && !hasInline) issues.push('注入模式需要提供 .js 资产（或 data.code 内联脚本）');
      }
      if (issues.length) {
        return res.status(400).json({ success: false, error: `内容校验未通过: ${issues.join('; ')}` });
      }

      // 大小限制：单资产 8MB，总资产 20MB
      const assets = Array.isArray(contentPack.assets) ? contentPack.assets : [];
      const MAX_ASSET = 8 * 1024 * 1024;
      const MAX_TOTAL = 20 * 1024 * 1024;
      let totalSize = 0;
      for (const a of assets) {
        const content = String((a && a.content) || '');
        const size = content.startsWith('__BINARY_BASE64__')
          ? Math.floor((content.length - 16) / 4) * 3
          : Buffer.byteLength(content, 'utf8');
        if (size > MAX_ASSET) {
          return res.status(400).json({ success: false, error: `资产过大: ${a.path}` });
        }
        totalSize += size;
      }
      if (totalSize > MAX_TOTAL) {
        return res.status(400).json({ success: false, error: '内容包总大小超过 20MB 限制' });
      }

      const contentId = generateContentId();

      // ① 资产落库：content/{contentId}/{path}（复用游戏文件库）
      if (assets.length) {
        const files = assets.map((a: any) => ({
          filePath: `content/${contentId}/${String(a.path || '').replace(/^\/+/, '')}`,
          content: String((a && a.content) || ''),
          mimeType: getMimeType(String(a.path || '')),
          size: Buffer.byteLength(String((a && a.content) || ''), 'utf8'),
        }));
        if (useMemoryDB) {
          await memoryDB.saveGameFiles(gameId, files);
        } else {
          const client = await pool.connect();
          try {
            await client.query('BEGIN');
            for (const pf of files) {
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
          } catch (err) {
            await client.query('ROLLBACK');
            throw err;
          } finally {
            client.release();
          }
        }
      }

      // ② manifest：剔除资产本体，只留清单（凭证轻量化、可交易）
      const assetManifest = assets.map((a: any) => ({
        path: `content/${contentId}/${String(a.path || '').replace(/^\/+/, '')}`,
        name: String(a.path || ''),
        size: Buffer.byteLength(String((a && a.content) || ''), 'utf8'),
        mimeType: getMimeType(String(a.path || '')),
      }));
      const manifest = {
        ...contentPack,
        assets: assetManifest,
        type,
        slot,
        name,
        description: String(contentPack.description || ''),
      };

      // ③ 元信息落库
      const record = {
        contentId,
        gameId,
        authorId: String(authorId || 'anonymous'),
        authorName: String(authorName || ''),
        type,
        slot,
        name,
        description: String(contentPack.description || ''),
        manifest,
        assetBase: `content/${contentId}/`,
        createdAt: Date.now(),
      };
      if (useMemoryDB) {
        await memoryDB.upsertContentAsset(contentId, record);
      } else {
        // PostgreSQL：无 content_assets 表则存入 published_games 的 meta 内（简化部署）
        const gres = await pool.query(`SELECT * FROM published_games WHERE id = $1`, [gameId]);
        const existing = gres.rows[0] || null;
        const meta = existing?.game_meta ? { ...(typeof existing.game_meta === 'string' ? JSON.parse(existing.game_meta) : existing.game_meta) } : {};
        const list = Array.isArray(meta.contentAssets) ? meta.contentAssets : [];
        list.push(record);
        meta.contentAssets = list;
        await pool.query(
          `UPDATE published_games SET game_meta=$2, updated_at=NOW() WHERE id=$1`,
          [gameId, JSON.stringify(meta)]
        );
      }

      console.log(`[content] mint 成功: ${contentId}, game=${gameId}, slot=${slot}, assets=${assetManifest.length}`);
      res.json({
        success: true,
        data: { contentId, gameId, manifest, assetBase: `content/${contentId}/`, type, slot, name },
      });
    } catch (e: any) {
      logger.error({ err: e }, '[content] mint error');
      res.status(500).json({ success: false, error: isProduction ? 'Internal server error' : e.message });
    }
  });

  // ----- GET / — 列表（?gameId= 过滤，公开） -----
  router.get('/', async (req: Request, res: Response) => {
    try {
      const gameId = (req.query.gameId as string) || '';
      let list: any[] = [];
      if (useMemoryDB) {
        list = await memoryDB.listContentAssets(gameId || undefined);
      } else {
        const result = await pool.query(`SELECT * FROM published_games WHERE id = $1`, [gameId]);
        const meta = result.rows[0]?.game_meta
          ? (typeof result.rows[0].game_meta === 'string' ? JSON.parse(result.rows[0].game_meta) : result.rows[0].game_meta)
          : {};
        list = Array.isArray(meta.contentAssets) ? meta.contentAssets : [];
        if (!gameId) list = [];
      }
      res.json({ success: true, data: { contents: list } });
    } catch (e: any) {
      logger.error({ err: e }, '[content] list error');
      res.status(500).json({ success: false, error: isProduction ? 'Internal server error' : e.message });
    }
  });

  // ----- GET /:contentId — 详情（公开，loader 按需拉取 manifest） -----
  router.get('/:contentId', async (req: Request, res: Response) => {
    try {
      const contentId = req.params.contentId;
      let record: any = null;
      if (useMemoryDB) {
        record = await memoryDB.getContentAsset(contentId);
      } else {
        const result = await pool.query(`SELECT * FROM published_games WHERE id = $1`, [String(req.query.gameId || '')]);
        const meta = result.rows[0]?.game_meta
          ? (typeof result.rows[0].game_meta === 'string' ? JSON.parse(result.rows[0].game_meta) : result.rows[0].game_meta)
          : {};
        const list = Array.isArray(meta.contentAssets) ? meta.contentAssets : [];
        record = list.find((c: any) => c.contentId === contentId) || null;
      }
      if (!record) return res.status(404).json({ success: false, error: 'content not found' });
      res.json({ success: true, data: record });
    } catch (e: any) {
      logger.error({ err: e }, '[content] detail error');
      res.status(500).json({ success: false, error: isProduction ? 'Internal server error' : e.message });
    }
  });

  // ----- POST /:contentId/remix — 上架 remix 版（走审核，pending） -----
  router.post('/:contentId/remix', async (req: Request, res: Response) => {
    try {
      const contentId = req.params.contentId;
      const { entryPoint, slot } = (req.body || {}) as any;
      let record: any = null;
      if (useMemoryDB) {
        record = await memoryDB.getContentAsset(contentId);
      } else {
        const result = await pool.query(`SELECT * FROM published_games WHERE id = $1`, [String(req.query.gameId || '')]);
        const meta = result.rows[0]?.game_meta
          ? (typeof result.rows[0].game_meta === 'string' ? JSON.parse(result.rows[0].game_meta) : result.rows[0].game_meta)
          : {};
        const list = Array.isArray(meta.contentAssets) ? meta.contentAssets : [];
        record = list.find((c: any) => c.contentId === contentId) || null;
      }
      if (!record) return res.status(404).json({ success: false, error: 'content not found' });

      const remix = {
        status: 'pending' as const,
        entryPoint: String(entryPoint || ''),
        slot: String(slot || record.slot || ''),
        requestedAt: Date.now(),
      };
      const updated = { ...record, remix };

      if (useMemoryDB) {
        await memoryDB.upsertContentAsset(contentId, updated);
      } else {
        const result = await pool.query(`SELECT * FROM published_games WHERE id = $1`, [record.gameId]);
        const meta = result.rows[0]?.game_meta
          ? (typeof result.rows[0].game_meta === 'string' ? JSON.parse(result.rows[0].game_meta) : result.rows[0].game_meta)
          : {};
        const list = Array.isArray(meta.contentAssets) ? meta.contentAssets : [];
        const idx = list.findIndex((c: any) => c.contentId === contentId);
        if (idx >= 0) list[idx] = updated;
        meta.contentAssets = list;
        await pool.query(
          `UPDATE published_games SET game_meta=$2, updated_at=NOW() WHERE id=$1`,
          [record.gameId, JSON.stringify(meta)]
        );
      }

      res.json({ success: true, data: { contentId, remix } });
    } catch (e: any) {
      logger.error({ err: e }, '[content] remix error');
      res.status(500).json({ success: false, error: isProduction ? 'Internal server error' : e.message });
    }
  });

  // ----- PATCH /:contentId/remix-status — 审核 remix（approve → 追加 questExtensions） -----
  router.patch('/:contentId/remix-status', async (req: Request, res: Response) => {
    try {
      const contentId = req.params.contentId;
      const { status, reviewerId } = (req.body || {}) as any;
      if (!['approved', 'rejected'].includes(String(status || ''))) {
        return res.status(400).json({ success: false, error: 'status must be approved or rejected' });
      }

      let record: any = null;
      if (useMemoryDB) {
        record = await memoryDB.getContentAsset(contentId);
      } else {
        const result = await pool.query(`SELECT * FROM published_games WHERE id = $1`, [String(req.query.gameId || '')]);
        const meta = result.rows[0]?.game_meta
          ? (typeof result.rows[0].game_meta === 'string' ? JSON.parse(result.rows[0].game_meta) : result.rows[0].game_meta)
          : {};
        const list = Array.isArray(meta.contentAssets) ? meta.contentAssets : [];
        record = list.find((c: any) => c.contentId === contentId) || null;
      }
      if (!record) return res.status(404).json({ success: false, error: 'content not found' });

      const updated = {
        ...record,
        remix: {
          ...(record.remix || {}),
          status,
          reviewedAt: Date.now(),
          reviewerId: String(reviewerId || ''),
        },
      };

      // 通过审核：追加 questExtensions（游戏方批准 = 公开发行 remix 版）
      if (status === 'approved' && record.gameId) {
        const gdoc = useMemoryDB ? await memoryDB.getPublishedGame(record.gameId) : null;
        const extList = Array.isArray(gdoc?.questExtensions) ? gdoc.questExtensions : [];
        if (!extList.some((x: any) => x.submissionId === contentId)) {
          extList.push({
            submissionId: contentId,
            slot: String(record.slot || ''),
            entryPoint: String(record.remix?.entryPoint || ''),
            assets: Array.isArray(record.manifest?.assets) ? record.manifest.assets : [],
            mergedAt: Date.now(),
            inject: false,
            name: record.name,
          });
          if (useMemoryDB) {
            await memoryDB.savePublishedGame({ ...gdoc, questExtensions: extList });
          } else {
            const result = await pool.query(`SELECT * FROM published_games WHERE id = $1`, [record.gameId]);
            const meta = result.rows[0]?.game_meta
              ? (typeof result.rows[0].game_meta === 'string' ? JSON.parse(result.rows[0].game_meta) : result.rows[0].game_meta)
              : {};
            meta.questExtensions = extList;
            await pool.query(
              `UPDATE published_games SET game_meta=$2, updated_at=NOW() WHERE id=$1`,
              [record.gameId, JSON.stringify(meta)]
            );
          }
        }
      }

      if (useMemoryDB) {
        await memoryDB.upsertContentAsset(contentId, updated);
      }

      res.json({ success: true, data: { contentId, remix: updated.remix } });
    } catch (e: any) {
      logger.error({ err: e }, '[content] remix-status error');
      res.status(500).json({ success: false, error: isProduction ? 'Internal server error' : e.message });
    }
  });

  return router;
}
