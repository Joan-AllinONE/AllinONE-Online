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
import { signToken, verifyToken } from '../auth/jwt.js';
import { isPubliclyVisible } from './gameReview.js';

// ==================== 审核可见性工具（公开列表/详情过滤） ====================
// 审核机制：未通过审核（pending/rejected/changes_required/removed）的游戏不可公开上架。
// 旧数据缺省 reviewStatus → 视为 approved（向后兼容，存量游戏不受影响）。

/** 从请求头解析 JWT（公开路由挂在全局 authMiddleware 之前，需手动解析） */
function extractAuthInfo(req: Request): { userId?: string; role?: string } {
  const h = req.headers.authorization;
  if (h?.startsWith('Bearer ')) {
    try {
      const payload = verifyToken(h.slice(7));
      return { userId: payload.userId, role: payload.role };
    } catch { /* 无效 token 视同未登录 */ }
  }
  return {};
}

function authIsAdmin(auth: { role?: string }): boolean {
  return auth.role === 'admin' || auth.role === 'platform';
}

/**
 * 发布写接口（POST / 与 PATCH /）的审核字段保护：
 * 审核状态与审核记录只能通过 /api/v1/games/__review 端点变更，
 * 发布方 upsert/patch 数据中携带的审核字段一律剥离，防止洗白 pending/rejected 状态。
 * 注：日常合法写入（如 incrementGamePlayers）会随缓存对象带上 approved，
 * 属正常回写，不告警；仅检测试图携带非法状态的篡改行为。
 */
function stripReviewFields(data: any): any {
  if (!data || typeof data !== 'object') return data;
  const { reviewStatus, reviewRecords, submittedAt, reviewedAt, reviewedBy, ...rest } = data;
  if (reviewStatus && reviewStatus !== 'approved') {
    logger.warn({ strippedStatus: reviewStatus, gameId: data.id }, '[games] 拦截发布数据中非法携带的审核状态（审核状态只能经 __review 端点变更）');
  }
  return rest;
}

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

// ==================== 方案 E：注入型扩展（文件分发层加载时注入） ====================
// 与 public/gameFileServiceWorker-v13.js / cloudfunctions/gamesApi/index.js 保持幂等一致：
// 内容已含注入标记（<!-- AllinONE 注入扩展）时不重复注入。

function escapeHtml(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escapeScriptClose(code: string): string {
  return String(code).replace(/<\/script/gi, '<\\/script');
}

/** 内联 CSS 的 url() 重写到 assetBase（相对路径，浏览器按文档 base 解析） */
function rewriteCssUrls(css: string, base: string): string {
  return String(css).replace(
    /url\(\s*(['"]?)(?!data:|https?:|\/\/|#)\/?([^'")]+)\1\s*\)/gi,
    (_m: string, q: string, p: string) => `url(${q}${base}${String(p).replace(/^\/+/, '')}${q})`,
  );
}

/** 构造注入块：CSS <link> + 内联 <style> + 资源帮助器 + 用户脚本 */
function buildInjectionBlock(inj: any, resolveBase: (inj: any) => string): string {
  const base = resolveBase(inj);
  const parts: string[] = [];
  const assets = Array.isArray(inj.assets) ? inj.assets : [];
  // ① CSS 文件资产 → <link>（href = base + 相对路径，保留子目录；CSS 内 url() 相对自身解析）
  assets
    .filter((a: any) => String((a && a.path) || '').toLowerCase().endsWith('.css'))
    .forEach((a: any) => {
      const full = String((a && a.path) || '');
      let rel = full;
      if (inj.assetBase && full.startsWith(inj.assetBase)) rel = full.slice(inj.assetBase.length);
      if (rel) parts.push(`<link rel="stylesheet" href="${escapeHtml(base + rel)}">`);
    });
  // ② data.css 内联 → <style> + url() 重写到 assetBase
  (Array.isArray(inj.styles) ? inj.styles : [])
    .filter((s: string) => s && s.trim())
    .forEach((css: string) => parts.push(`<style data-allinone-css>\n${rewriteCssUrls(css, base)}\n</style>`));
  // ③ 资源基础帮助器（图片/声音寻址；server/SW 默认相对 assetBase，按文档 base 解析）
  const sid = inj.submissionId || '';
  parts.push(
    `<script>window.AllinONE_INJECT=window.AllinONE_INJECT||{};` +
      `window.AllinONE_INJECT[${JSON.stringify(sid)}]={base:${JSON.stringify(base)},` +
      `url:function(p){return this.base+p}};` +
      `window.AllinONE_asset=function(p){return window.AllinONE_INJECT[${JSON.stringify(sid)}].url(p)};</script>`,
  );
  // ④ 用户脚本
  if (inj.code && inj.code.trim()) parts.push(`<script>\n${escapeScriptClose(inj.code)}\n</script>`);
  const label = String(inj.name || sid).replace(/--/g, '-');
  return parts.length ? `\n<!-- AllinONE 注入扩展: ${label} -->\n` + parts.join('\n') : '';
}

function applyInjectionsToHtml(html: string, injections: any[], resolveBase?: (inj: any) => string): string {
  if (!html || !Array.isArray(injections) || !injections.length) return html;
  if (html.indexOf('<!-- AllinONE 注入扩展') >= 0) return html; // 幂等
  const r = resolveBase || ((inj: any) => (inj && inj.assetBase) || '');
  const blocks = injections.map((inj) => buildInjectionBlock(inj, r)).filter(Boolean).join('\n');
  if (!blocks) return html;
  const lower = html.toLowerCase();
  const bodyIdx = lower.lastIndexOf('</body>'); // 大小写不敏感（部分游戏用 </BODY>）
  return bodyIdx >= 0 ? html.slice(0, bodyIdx) + blocks + html.slice(bodyIdx) : html + blocks;
}

function isEntryFile(filePath: string, entryPoint?: string): boolean {
  const ep = String(entryPoint || 'index.html').replace(/^\/+/, '');
  const fp = String(filePath).replace(/^\/+/, '');
  return fp === ep;
}

// ==================== 内容工坊：ContentLoader 骨架注入 ====================
// 仅 contentSop.enabled 的游戏注入固定 loader SDK（空操作，不激活任何内容）。
// loader 由游戏内使用「内容凭证」时通过 postMessage CONTENT_PACK_APPLY 按次激活。
// 幂等标记：<!-- AllinONE 内容加载器 -->（与云函数 / SW v13 / GamePlay 保持一致）。
const CONTENT_LOADER_MARKER = '<!-- AllinONE 内容加载器 -->';

const CONTENT_LOADER_SNIPPET = `<script>
(function(){if(window.AllinONE_ContentLoader)return;var L={
__v:1,_applied:{},_handlers:{},
on:function(s,f){this._handlers[s]=f;return this;},
base:function(p){return p&&p.assetBase?p.assetBase:'';},
url:function(p,path){return this.base(p)+String(path||'').replace(/^\\/+/g,'');},
apply:function(p){if(!p||!p.contentId)return{ok:false,error:'invalid pack'};var cid=p.contentId;
if(this._applied[cid])return{ok:false,error:'already applied this session'};
window.AllinONE_ContentAssets=window.AllinONE_ContentAssets||{};
window.AllinONE_ContentAssets[cid]={base:this.base(p),pack:p,url:function(pp){return this.base+String(pp||'').replace(/^\\/+/g,'');}};
var self=this;var assets=Array.isArray(p.assets)?p.assets:[];
var scripts=assets.filter(function(a){return /\\.js$/i.test(String(a.path||''));});
if(p.data&&typeof p.data.code==='string'&&p.data.code.trim()){try{(new Function(p.data.code))();}catch(e){console.error('[ContentLoader] data.code error',e);}}
function run(i){if(i>=scripts.length){window.dispatchEvent(new CustomEvent('allinone:content-pack-applied',{detail:p}));
var h=self._handlers[p.slot]||(window.AllinONE_ContentHandlers&&window.AllinONE_ContentHandlers[p.slot]);
if(h){try{h(p);}catch(e){console.error('[ContentLoader] handler error',e);}}
return{ok:true};}var s=document.createElement('script');s.src=self.url(p,scripts[i].path);
s.onload=function(){run(i+1);};s.onerror=function(){run(i+1);};document.head.appendChild(s);}
run(0);this._applied[cid]=true;return{ok:true,queued:scripts.length};},
list:function(){return Object.keys(this._applied);}};
window.AllinONE_ContentLoader=L;
window.addEventListener('message',function(ev){var d=ev&&ev.data;if(!d||d.type!=='CONTENT_PACK_APPLY')return;
if(window.AllinONE_ContentLoader&&d.content){window.AllinONE_ContentLoader.apply(d.content);}});})();
<\/script>`;

/** 给入口 HTML 追加 ContentLoader 骨架（仅启用内容工坊的游戏；幂等） */
function applyContentLoaderToHtml(html: string, enabled: boolean): string {
  if (!enabled || !html || html.indexOf(CONTENT_LOADER_MARKER) >= 0) return html;
  const block = '\n' + CONTENT_LOADER_MARKER + '\n' + CONTENT_LOADER_SNIPPET + '\n';
  const lower = html.toLowerCase();
  const bodyIdx = lower.lastIndexOf('</body>');
  return bodyIdx >= 0 ? html.slice(0, bodyIdx) + block + html.slice(bodyIdx) : html + block;
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

/**
 * 扩展资产回退匹配（只应作用于 extensions/ 路径，调用方需先过滤）：
 * 请求原路径（如 js/gun.js）在游戏根目录不存在时，回退匹配任务扩展合并的资产
 * （extensions/{questId}/{submissionId}/...），使「补回被删文件」类任务对游戏零改动生效。
 * 匹配策略（优先级从高到低）：
 *   1. 完全等于请求路径（p === target）
 *   2. 尾部完整路径匹配（p.endsWith('/' + target)）→ 前端保留目录结构时命中（extensions/.../js/gun.js）
 *   3. 文件名兜底匹配（basename 相等）→ 文件选择器丢失目录前缀时命中
 *      （extensions/.../gun.js 响应 js/gun.js 请求，最新一个合并胜出）
 */
function matchExtensionPath(p: string, target: string): boolean {
  if (p === target || p.endsWith('/' + target)) return true;
  const base = target.split('/').pop();
  return !!base && p.split('/').pop() === base;
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

  // ----- GET /（游戏列表，公开；未通过审核的游戏不对外展示） -----
  router.get('/', async (req: Request, res: Response) => {
    try {
      let games: any[] = [];
      if (useMemoryDB) {
        games = await memoryDB.listPublishedGames();
      } else {
        const result = await pool.query(`SELECT * FROM published_games ORDER BY created_at DESC`);
        games = result.rows;
      }
      // 审核可见性：默认仅返回已通过审核（approved 或旧数据缺省）的游戏。
      // 管理员（JWT role=admin/platform）可通过 ?all=1 查看全部（含待审核/驳回/已下架）。
      const auth = extractAuthInfo(req);
      const wantAll = req.query.all === '1' || req.query.all === 'true';
      if (wantAll && authIsAdmin(auth)) {
        logger.info({ adminId: auth.userId, count: games.length }, '[games] 管理员拉取全量游戏列表（含未过审）');
      } else {
        games = games.filter((g) => isPubliclyVisible(g));
      }
      res.json({ success: true, data: { games } });
    } catch (e: any) {
      logger.error({ err: e }, '[games] list error');
      res.status(500).json({ success: false, error: isProduction ? 'Internal server error' : e.message });
    }
  });

  // ----- GET /:id（游戏详情，公开；未通过审核时仅管理员/发布者本人可见） -----
  router.get('/:id', async (req: Request, res: Response) => {
    try {
      const gameId = req.params.id;
      if (gameId === 'dev-token') {
        return res.status(404).json({ success: false, error: 'not found' });
      }
      let game: any = null;
      if (useMemoryDB) {
        game = await memoryDB.getPublishedGame(gameId);
      } else {
        const result = await pool.query(`SELECT * FROM published_games WHERE id = $1`, [gameId]);
        game = result.rows[0] || null;
      }
      if (!game) return res.status(404).json({ success: false, error: 'game not found' });

      // 审核可见性：未通过审核（pending/rejected/changes_required/removed）的游戏，
      // 仅管理员或发布者本人（带 JWT 且 userId 匹配 publisherId）可读，其他一律 404
      // （包含 GamePlay 直链——未过审游戏不可公开游玩）。
      if (!isPubliclyVisible(game)) {
        const auth = extractAuthInfo(req);
        const isOwner = !!auth.userId && !!game.publisherId && auth.userId === game.publisherId;
        if (!authIsAdmin(auth) && !isOwner) {
          logger.info({ gameId, status: game.reviewStatus }, '[games] 拦截未过审游戏的公开详情访问');
          return res.status(404).json({ success: false, error: 'game not found' });
        }
      }
      res.json({ success: true, data: game });
    } catch (e: any) {
      logger.error({ err: e }, '[games] detail error');
      res.status(500).json({ success: false, error: isProduction ? 'Internal server error' : e.message });
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

      // 扩展资产回退：请求原路径（如 js/gun.js）在游戏根目录不存在时，
      // 回退匹配任务扩展合并的资产（extensions/{questId}/{submissionId}/js/gun.js，取最新一个）。
      // 使「补回被删文件」类 fix 任务对游戏零改动生效（index.html 的 <script src="js/gun.js"> 可直接命中）。
      if (!file) {
        let extPath: string | undefined;
        if (useMemoryDB) {
          const manifest = (await memoryDB.getGameFileManifest(gameId)) || [];
          const extPaths = manifest
            .map((f: { filePath: string }) => f.filePath)
            .filter((p: string) => p.startsWith('extensions/') && matchExtensionPath(p, filePath));
          extPath = extPaths.length ? extPaths[extPaths.length - 1] : undefined;
        } else {
          const result = await pool.query(
            `SELECT file_path FROM game_files WHERE game_id = $1 AND file_path LIKE 'extensions/%'`,
            [gameId]
          );
          const extPaths = (result.rows || [])
            .map((r: any) => r.file_path)
            .filter((p: string) => matchExtensionPath(p, filePath));
          extPath = extPaths.length ? extPaths[extPaths.length - 1] : undefined;
        }
        if (extPath) {
          file = useMemoryDB
            ? await memoryDB.getGameFile(gameId, extPath)
            : (
                await pool.query(
                  `SELECT content, mime_type, size, etag FROM game_files WHERE game_id = $1 AND file_path = $2`,
                  [gameId, extPath]
                )
              ).rows[0] || null;
        }
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
      let content = file.content;
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
            content = decoded;
          }
        } catch {
          // 解码失败，回退到原文发送
        }
      } else if (!isTextMimeType(file.mime_type) && looksLikeBase64(content)) {
        // 上传 API 存储的二进制文件（无 charset 的 MIME + 有效 base64 内容）
        try {
          const buf = Buffer.from(content, 'base64');
          return res.send(buf);
        } catch {
          // 解码失败，回退到原文发送
        }
      }

      // 方案 E + 方案 A：入口 HTML 条件化注入扩展脚本 + 内容工坊 ContentLoader 骨架（幂等）。失败静默跳过。
      // ⚠️ 与云函数 gamesApi 双维护：仅注入 ?ext= 指定的那一个；无 ext = 纯净原版，不注入。
      if (isTextMimeType(file.mime_type) && file.mime_type.includes('html')) {
        try {
          const gdoc = useMemoryDB ? await memoryDB.getPublishedGame(gameId) : null;
          if (isEntryFile(filePath, (gdoc as any)?.entryPoint)) {
            const extParam = typeof req.query.ext === 'string' ? req.query.ext : '';
            const allInjs = Array.isArray((gdoc as any)?.injections) ? (gdoc as any).injections : [];
            const injs = extParam
              ? allInjs.filter((i: any) => i && i.submissionId === extParam)
              : [];
            if (injs.length) {
              const injected = applyInjectionsToHtml(content, injs);
              if (injected !== content) {
                content = injected;
                logger.info({ gameId, filePath, ext: extParam }, `[games] 入口 HTML 按 ?ext= 注入扩展脚本: ${injs.length} 个`);
              }
            }
            // 内容工坊：仅 contentSop.enabled 的游戏注入 loader SDK（空操作）
            const contentSopEnabled = !!(gdoc as any)?.contentSop?.enabled;
            if (contentSopEnabled) {
              const withLoader = applyContentLoaderToHtml(content, true);
              if (withLoader !== content) {
                content = withLoader;
                logger.info({ gameId, filePath }, '[games] 入口 HTML 注入 ContentLoader 骨架');
              }
            }
          }
        } catch (e) {
          logger.warn({ err: e }, '[games] 注入扩展跳过');
        }
      }

      return res.send(content);
    } catch (error: any) {
      logger.error({ err: error }, '[games] file serve error');
      res.status(500).json({ success: false, error: isProduction ? 'Internal server error' : error.message });
    }
  });

  // ----- POST /__files（集合级批量写 game_files，公开无 JWT，跨浏览器匿名直读） -----
  // 前端 saveGameFiles 第③步调用 ${GAMES_API_BASE}/__files，dev 本地也必须支持，
  // 否则文件只存浏览器本地，本地后端无文件 → 游戏加载报 "File not found"。
  router.post('/__files', express.json({ limit: '150mb' }), async (req: Request, res: Response) => {
    try {
      const { gameId, files } = req.body as {
        gameId: string;
        files?: Array<{ path: string; name: string; content: string; size?: number }>;
      };
      if (!gameId || !files || !Array.isArray(files) || files.length === 0) {
        return res.status(400).json({ success: false, error: 'Missing gameId or files array' });
      }
      const MAX_FILE_SIZE = 10 * 1024 * 1024;
      const MAX_TOTAL_SIZE = 100 * 1024 * 1024;
      let totalSize = 0;
      const processedFiles: Array<{ filePath: string; content: string; mimeType: string; size: number }> = [];
      for (const f of files) {
        const filePath = f.path || f.name;
        const content = f.content || '';
        const size = f.size || content.length;
        if (size > MAX_FILE_SIZE) {
          return res.status(400).json({ success: false, error: `File too large: ${filePath}` });
        }
        totalSize += size;
        if (totalSize > MAX_TOTAL_SIZE) {
          return res.status(400).json({ success: false, error: 'Total size exceeds 100MB limit' });
        }
        processedFiles.push({ filePath, content, mimeType: getMimeType(filePath), size });
      }
      let saved = 0;
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
      console.log(`[Games] __files 写入成功: ${gameId}, ${saved} 个文件`);
      res.json({ success: true, data: { saved } });
    } catch (e: any) {
      console.warn('[Games] __files 写入失败:', e);
      res.status(500).json({ success: false, error: isProduction ? 'Internal server error' : e.message });
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

  // ----- POST /（保存/upsert 游戏元数据，认证） -----
  router.post('/', async (req: Request, res: Response) => {
    try {
      const body = (req.body || {}) as any;
      if (!body || !body.id) {
        return res.status(400).json({ success: false, error: 'Missing game id' });
      }
      // 审核字段保护：剥离发布数据中的审核状态/记录（只能经 __review 端点变更）
      const game = stripReviewFields(body);
      // 保留库中已有的审核字段（upsert 覆盖写会抹掉 reviewStatus，导致 pending 被洗白成缺省）
      // ⚠️ 新创建的游戏默认进入待审核状态（reviewStatus=pending）：审核独立于发布流程，
      // 即使 submit 审核端点调用失败，新游戏也不会绕过审核直接公开上架。
      // 已存在的游戏保留原审核字段（旧数据缺省 = approved 向后兼容）。
      let existingReview: Record<string, any> = {};
      if (useMemoryDB) {
        const existing = await memoryDB.getPublishedGame(game.id);
        if (existing) {
          existingReview = {
            reviewStatus: existing.reviewStatus,
            reviewRecords: existing.reviewRecords,
            submittedAt: existing.submittedAt,
            reviewedAt: existing.reviewedAt,
            reviewedBy: existing.reviewedBy,
          };
        } else {
          existingReview = { reviewStatus: 'pending' };
        }
        await memoryDB.savePublishedGame({ ...game, ...existingReview });
      } else {
        const existing = await pool.query(`SELECT game_meta FROM published_games WHERE id = $1`, [game.id]);
        const existingMeta = existing.rows[0]?.game_meta || null;
        if (existingMeta) {
          existingReview = {
            reviewStatus: existingMeta.reviewStatus,
            reviewRecords: existingMeta.reviewRecords,
            submittedAt: existingMeta.submittedAt,
            reviewedAt: existingMeta.reviewedAt,
            reviewedBy: existingMeta.reviewedBy,
          };
        } else {
          existingReview = { reviewStatus: 'pending' };
        }
        const merged = { ...game, ...existingReview };
        await pool.query(
          `INSERT INTO published_games (id, name, entry_point, hosting_type, game_meta, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
           ON CONFLICT (id) DO UPDATE SET name=$2, entry_point=$3, hosting_type=$4, game_meta=$5, updated_at=NOW()`,
          [merged.id, merged.name, merged.entryPoint, merged.hostingType, JSON.stringify(merged)]
        );
      }
      res.json({ success: true, data: game });
    } catch (e: any) {
      logger.error({ err: e }, '[games] save error');
      res.status(500).json({ success: false, error: isProduction ? 'Internal server error' : e.message });
    }
  });

  // ----- PATCH /:id（部分更新游戏元数据，认证） -----
  router.patch('/:id', async (req: Request, res: Response) => {
    try {
      const gameId = req.params.id;
      const patch = stripReviewFields(req.body || {}) as any;
      let existing: any = null;
      if (useMemoryDB) {
        existing = await memoryDB.getPublishedGame(gameId);
      } else {
        const result = await pool.query(`SELECT * FROM published_games WHERE id = $1`, [gameId]);
        existing = result.rows[0] || null;
      }
      if (!existing) return res.status(404).json({ success: false, error: 'game not found' });
      const updated = { ...existing, ...patch, id: gameId };
      if (useMemoryDB) {
        await memoryDB.savePublishedGame(updated);
      } else {
        await pool.query(
          `UPDATE published_games SET name=$2, entry_point=$3, hosting_type=$4, game_meta=$5, updated_at=NOW() WHERE id=$1`,
          [gameId, updated.name, updated.entryPoint, updated.hostingType, JSON.stringify(updated)]
        );
      }
      res.json({ success: true, data: updated });
    } catch (e: any) {
      logger.error({ err: e }, '[games] patch error');
      res.status(500).json({ success: false, error: isProduction ? 'Internal server error' : e.message });
    }
  });

  // ----- DELETE /:id（删除游戏及文件，认证） -----
  router.delete('/:id', async (req: Request, res: Response) => {
    try {
      const gameId = req.params.id;
      if (useMemoryDB) {
        await memoryDB.deletePublishedGame(gameId);
        await memoryDB.deleteGameFiles(gameId);
      } else {
        await pool.query('DELETE FROM game_files WHERE game_id = $1', [gameId]);
        await pool.query('DELETE FROM published_games WHERE id = $1', [gameId]);
      }
      res.json({ success: true, data: { deleted: true } });
    } catch (e: any) {
      logger.error({ err: e }, '[games] delete error');
      res.status(500).json({ success: false, error: isProduction ? 'Internal server error' : e.message });
    }
  });

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
