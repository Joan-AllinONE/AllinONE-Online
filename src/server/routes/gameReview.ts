/**
 * 游戏审核机制 API 路由（独立于游戏发布流程）
 *
 * 挂载于 /api/v1/games/__review（必须排在 gamesPublicRouter 之前，否则 __review 被当 gameId）
 * 路由内部自行解析 Authorization Bearer JWT（公开挂载区不能依赖全局 authMiddleware）。
 *
 * 管理员认证：独立账号密码登录（REVIEW_ADMIN_USER / REVIEW_ADMIN_PASS 环境变量，
 * 本地默认 admin / admin123），签发 role=admin 的 JWT。普通 player JWT 一律 403。
 *
 * 端点：
 *   POST /admin-login          — 管理员登录，签发审核 JWT（无需 token）
 *   GET  /list                 — [管理员] 审核队列列表（?status=pending 过滤）
 *   GET  /records/:gameId      — [管理员] 某游戏的完整审核记录
 *   POST /submit               — [发布者/管理员] 提交审核（进入 pending，附自动预检结果）
 *   POST /decide               — [管理员] 审核决定（approve / reject / changes_required）
 *   POST /takedown             — [管理员] 下架已上架游戏
 *
 * 状态机：
 *   (提交/重新提交) → pending → approved | rejected | changes_required
 *   rejected/changes_required → 重新发布提交 → pending
 *   approved → 管理员下架 → removed；removed → 管理员重新通过 → approved
 *   旧数据无 reviewStatus 字段 → 视为 approved（向后兼容）
 *
 * ⚠️ 审核字段（reviewStatus / reviewRecords / submittedAt / reviewedAt / reviewedBy）
 *    只能通过本路由变更；games.ts 的 POST / PATCH 会剥离这些字段，发布方无法洗白状态。
 */
import express, { Router, Request, Response } from 'express';
import { logger } from '../logger.js';
import { signToken, verifyToken } from '../auth/jwt.js';

// ==================== 常量与类型 ====================

export type ReviewAction =
  | 'submit'          // 开发者提交审核
  | 'approve'         // 管理员通过（上架）
  | 'reject'          // 管理员驳回
  | 'changes_required'// 管理员要求修改
  | 'takedown';       // 管理员下架

export type ReviewStatus = 'pending' | 'approved' | 'rejected' | 'changes_required' | 'removed';

export interface ReviewChecklistItem {
  key: string;
  label: string;
  description: string;
  passed: boolean;
  note?: string;
}

export interface AutoCheckItem {
  key: string;
  label: string;
  passed: boolean;
  severity: 'error' | 'warning' | 'info';
  note?: string;
}

export interface GameReviewRecord {
  id: string;
  action: ReviewAction;
  adminId?: string;
  adminName?: string;
  submitterId?: string;
  submitterName?: string;
  reason?: string;
  note?: string;
  checklist?: ReviewChecklistItem[];
  autoChecks?: AutoCheckItem[];
  createdAt: number;
}

/**
 * 人工审核四大硬性条件（与前端 gameReviewService.ts 的 REVIEW_CHECKLIST_TEMPLATE 双维护）。
 * 通过（approve）要求四项全部 passed。
 */
export const CHECKLIST_TEMPLATE: Array<{ key: string; label: string; description: string }> = [
  {
    key: 'content_compliance',
    label: '内容合规性',
    description: '无违法、违规、侵权内容（无色情低俗、暴力血腥、赌博、政治敏感、盗版侵权素材等）',
  },
  {
    key: 'stability',
    label: '运行稳定性',
    description: '游戏可正常启动与运行，无严重崩溃、卡死、白屏等影响体验的问题',
  },
  {
    key: 'info_completeness',
    label: '基础信息完整性',
    description: '名称、简介、封面、分类等必填项齐全，入口文件配置正确',
  },
  {
    key: 'security',
    label: '用户交互与安全性',
    description: '无恶意代码、无诱导支付或变相收费、无隐私窃取行为',
  },
];

const VALID_STATUSES: ReviewStatus[] = ['pending', 'approved', 'rejected', 'changes_required', 'removed'];

// 管理员账号（本地运行默认 admin / admin123，生产必须通过环境变量覆盖）
const REVIEW_ADMIN_USER = process.env.REVIEW_ADMIN_USER || 'admin';
const REVIEW_ADMIN_PASS = process.env.REVIEW_ADMIN_PASS || 'admin123';

// ==================== 工具函数 ====================

interface AuthInfo { userId?: string; role?: string }

/** 从 Authorization header 解析 JWT（无效/缺失返回空对象，不抛错） */
function extractAuth(req: Request): AuthInfo {
  const h = req.headers.authorization;
  if (h?.startsWith('Bearer ')) {
    try {
      const payload = verifyToken(h.slice(7));
      return { userId: payload.userId, role: payload.role };
    } catch { /* 无效 token 视同未登录 */ }
  }
  return {};
}

/** 管理员判定：JWT 角色必须是 admin 或 platform */
function isAdmin(auth: AuthInfo): boolean {
  return auth.role === 'admin' || auth.role === 'platform';
}

/** 校验管理员身份，失败时写 401/403 响应并返回 false */
function requireAdmin(req: Request, res: Response): { userId: string; role?: string } | null {
  const auth = extractAuth(req);
  if (!auth.userId) {
    res.status(401).json({ success: false, error: '未登录，请先使用管理员账号登录审核后台' });
    return null;
  }
  if (!isAdmin(auth)) {
    res.status(403).json({ success: false, error: '权限不足：仅管理员账号可执行审核操作' });
    return null;
  }
  return { userId: auth.userId, role: auth.role };
}

function newRecordId(): string {
  return `rev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 公开可见性：approved 或 旧数据缺省（视为已上架，向后兼容） */
export function isPubliclyVisible(game: any): boolean {
  const s = game?.reviewStatus;
  return s === undefined || s === null || s === '' || s === 'approved';
}

// ==================== 数据访问（内存 DB / PG 双模式） ====================

interface GameStore {
  getGame(gameId: string): Promise<any | null>;
  saveGame(game: any): Promise<void>;
  getFileManifest(gameId: string): Promise<Array<{ filePath: string; mimeType: string; size: number }>>;
  getFile(gameId: string, filePath: string): Promise<{ content: string; mime_type: string; size: number } | null>;
}

function createStore(useMemoryDB: boolean, memoryDB: any, pool: any): GameStore {
  if (useMemoryDB) {
    return {
      async getGame(gameId) {
        return memoryDB.getPublishedGame(gameId);
      },
      async saveGame(game) {
        await memoryDB.savePublishedGame(game);
      },
      async getFileManifest(gameId) {
        return (await memoryDB.getGameFileManifest(gameId)) || [];
      },
      async getFile(gameId, filePath) {
        return memoryDB.getGameFile(gameId, filePath);
      },
    };
  }
  return {
    async getGame(gameId) {
      const r = await pool.query(`SELECT * FROM published_games WHERE id = $1`, [gameId]);
      const row = r.rows[0];
      if (!row) return null;
      // PG 模式元数据存于 game_meta JSONB
      return { ...(row.game_meta || {}), id: row.id, name: row.name, entry_point: row.entry_point, hosting_type: row.hosting_type };
    },
    async saveGame(game) {
      await pool.query(
        `INSERT INTO published_games (id, name, entry_point, hosting_type, game_meta, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
         ON CONFLICT (id) DO UPDATE SET name=$2, entry_point=$3, hosting_type=$4, game_meta=$5, updated_at=NOW()`,
        [game.id, game.name, game.entryPoint, game.hostingType, JSON.stringify(game)]
      );
    },
    async getFileManifest(gameId) {
      const r = await pool.query(
        `SELECT file_path, mime_type, size FROM game_files WHERE game_id = $1 ORDER BY file_path`,
        [gameId]
      );
      return (r.rows || []).map((row: any) => ({ filePath: row.file_path, mimeType: row.mime_type, size: row.size }));
    },
    async getFile(gameId, filePath) {
      const r = await pool.query(
        `SELECT content, mime_type, size FROM game_files WHERE game_id = $1 AND file_path = $2`,
        [gameId, filePath]
      );
      return r.rows[0] || null;
    },
  };
}

// ==================== 自动预检（提交审核时执行，结果供管理员参考） ====================

/** 恶意代码特征扫描（文本文件内容级；命中仅作警告提示，不自动拦截，由管理员人工判定） */
const SUSPICIOUS_PATTERNS: Array<{ pattern: RegExp; label: string; severity: 'error' | 'warning' }> = [
  { pattern: /eval\s*\(\s*atob\s*\(/i, label: '检测到 eval(atob(...)) 动态解码执行代码（常见混淆恶意代码手法）', severity: 'error' },
  { pattern: /new\s+Function\s*\(\s*atob\s*\(/i, label: '检测到 new Function(atob(...)) 动态解码执行代码', severity: 'error' },
  { pattern: /coinhive|cryptonight|deepminer|minerocean/i, label: '检测到疑似浏览器挖矿脚本特征', severity: 'error' },
  { pattern: /document\.cookie[\s\S]{0,160}?(fetch\s*\(|XMLHttpRequest|sendBeacon)/i, label: '检测到读取 Cookie 并向外部发送的行为（疑似隐私窃取）', severity: 'warning' },
  { pattern: /(localStorage|sessionStorage)\.(getItem|setItem)[\s\S]{0,200}?(fetch\s*\(|XMLHttpRequest|sendBeacon)/i, label: '检测到读取本地存储并向外部发送的行为，请人工确认用途', severity: 'warning' },
  { pattern: /(扫码支付|微信转账|支付宝转账|充值联系|加.{0,6}微信.{0,10}(充值|代充|退款))/i, label: '检测到疑似诱导站外支付话术，请人工确认', severity: 'warning' },
];

const TEXT_FILE_RE = /\.(html?|js|mjs|css|json|txt|md|xml|svg|vue)$/i;
const MAX_SCAN_FILES = 60;
const MAX_SCAN_FILE_SIZE = 2 * 1024 * 1024; // 单文件扫描上限 2MB

async function runAutomatedChecks(
  store: GameStore,
  game: any
): Promise<AutoCheckItem[]> {
  const checks: AutoCheckItem[] = [];

  // ① 基础信息完整性
  const infoProblems: string[] = [];
  if (!game?.name || String(game.name).trim().length < 2) infoProblems.push('游戏名称缺失或少于 2 个字符');
  if (!game?.summary && !game?.description) infoProblems.push('游戏简介/描述缺失');
  if (!game?.coverImage && !game?.icon) infoProblems.push('游戏封面/图标缺失');
  if (!game?.framework) infoProblems.push('游戏分类（framework）缺失');
  if (!game?.entryPoint) infoProblems.push('入口文件（entryPoint）未配置');
  checks.push({
    key: 'auto_info_completeness',
    label: '基础信息完整性预检',
    passed: infoProblems.length === 0,
    severity: 'warning',
    note: infoProblems.length ? infoProblems.join('；') : '名称/简介/封面/分类/入口文件均已配置',
  });

  // ② 文件健康度
  try {
    const manifest = await store.getFileManifest(game.id);
    const totalSize = manifest.reduce((sum, f) => sum + (f.size || 0), 0);
    const fileProblems: string[] = [];
    if (game.hostingType !== 'external' && manifest.length === 0) {
      fileProblems.push('游戏未上传任何文件（server/inline 托管模式必须有文件）');
    }
    if (totalSize > 100 * 1024 * 1024) {
      fileProblems.push(`游戏总大小 ${(totalSize / 1024 / 1024).toFixed(1)}MB 超过 100MB 上限`);
    }
    if (game.hostingType !== 'external' && manifest.length > 0) {
      const hasEntry = manifest.some((f) => f.filePath === (game.entryPoint || 'index.html'))
        || manifest.some((f) => /\.html?$/i.test(f.filePath));
      if (!hasEntry) fileProblems.push('文件清单中未找到入口 HTML 文件');
    }
    checks.push({
      key: 'auto_files_health',
      label: '游戏文件健康度预检',
      passed: fileProblems.length === 0,
      severity: 'warning',
      note: fileProblems.length
        ? fileProblems.join('；')
        : `共 ${manifest.length} 个文件，总大小 ${(totalSize / 1024 / 1024).toFixed(2)}MB`,
    });
  } catch (e: any) {
    checks.push({
      key: 'auto_files_health',
      label: '游戏文件健康度预检',
      passed: true,
      severity: 'info',
      note: `文件清单读取失败（${e?.message || e}），跳过文件预检`,
    });
  }

  // ③ 恶意代码特征扫描（仅扫描文本文件，命中仅警告）
  try {
    const manifest = await store.getFileManifest(game.id);
    const textFiles = manifest.filter(
      (f) => TEXT_FILE_RE.test(f.filePath) && (f.size || 0) <= MAX_SCAN_FILE_SIZE
    ).slice(0, MAX_SCAN_FILES);
    const hits: string[] = [];
    for (const f of textFiles) {
      const file = await store.getFile(game.id, f.filePath);
      const content = file?.content || '';
      if (!content || content.startsWith('__BINARY_BASE64__')) continue;
      for (const sp of SUSPICIOUS_PATTERNS) {
        if (sp.pattern.test(content)) {
          hits.push(`${f.filePath}: ${sp.label}`);
        }
      }
    }
    checks.push({
      key: 'auto_code_safety',
      label: '恶意代码特征扫描（自动）',
      passed: hits.length === 0,
      severity: hits.length ? 'warning' : 'info',
      note: hits.length
        ? `${hits.length} 处可疑特征（仅供人工复核，不自动拦截）：\n${hits.slice(0, 10).join('\n')}`
        : `已扫描 ${textFiles.length} 个文本文件，未发现可疑特征`,
    });
  } catch (e: any) {
    checks.push({
      key: 'auto_code_safety',
      label: '恶意代码特征扫描（自动）',
      passed: true,
      severity: 'info',
      note: `扫描执行失败（${e?.message || e}），请管理员人工检查`,
    });
  }

  return checks;
}

// ==================== 路由工厂 ====================

export function createGameReviewRouter(
  useMemoryDB: boolean,
  memoryDB: any,
  pool: any,
  isProduction: boolean
): Router {
  const router = Router();
  const store = createStore(useMemoryDB, memoryDB, pool);
  router.use(express.json({ limit: '2mb' }));

  // ----- POST /admin-login：管理员登录（审核后台专属账号，独立于玩家 CloudBase Auth） -----
  router.post('/admin-login', (req: Request, res: Response) => {
    try {
      const { username, password } = (req.body || {}) as { username?: string; password?: string };
      if (!username || !password) {
        return res.status(400).json({ success: false, error: '请输入管理员账号和密码' });
      }
      if (username !== REVIEW_ADMIN_USER || password !== REVIEW_ADMIN_PASS) {
        logger.warn({ username }, '[gameReview] 管理员登录失败（账号或密码错误）');
        return res.status(401).json({ success: false, error: '管理员账号或密码错误' });
      }
      const adminId = `review-admin:${username}`;
      const token = signToken({ userId: adminId, role: 'admin' });
      logger.info({ adminId }, '[gameReview] 管理员登录成功');
      res.json({
        success: true,
        data: {
          token,
          adminId,
          adminName: username,
          expiresAt: Date.now() + 24 * 60 * 60 * 1000, // JWT 有效期 24h
        },
      });
    } catch (e: any) {
      logger.error({ err: e }, '[gameReview] admin-login error');
      res.status(500).json({ success: false, error: isProduction ? 'Internal server error' : e.message });
    }
  });

  // ----- GET /list：审核队列（管理员） -----
  router.get('/list', async (req: Request, res: Response) => {
    const auth = requireAdmin(req, res);
    if (!auth) return;
    try {
      const status = typeof req.query.status === 'string' ? req.query.status : '';
      let games: any[] = [];
      if (useMemoryDB) {
        games = await memoryDB.listPublishedGames();
      } else {
        const r = await pool.query(`SELECT * FROM published_games ORDER BY created_at DESC`);
        games = (r.rows || []).map((row: any) => ({ ...(row.game_meta || {}), id: row.id, name: row.name }));
      }
      if (status) {
        if (!VALID_STATUSES.includes(status as ReviewStatus)) {
          return res.status(400).json({ success: false, error: `无效的状态过滤参数: ${status}` });
        }
        games = games.filter((g) => (g.reviewStatus || 'approved') === status);
      }
      // 轻量摘要：剔除大字段（entryHtmlContent/cloudFileManifest 等）与全量记录，只带最新一条
      const summary = games.map((g) => {
        const records: GameReviewRecord[] = Array.isArray(g.reviewRecords) ? g.reviewRecords : [];
        const latest = records.length ? records[records.length - 1] : null;
        const autoChecks = latest?.autoChecks || [];
        const failedAutoChecks = autoChecks.filter((c) => !c.passed).length;
        return {
          id: g.id,
          name: g.name,
          summary: g.summary,
          description: g.description,
          coverImage: g.coverImage,
          framework: g.framework,
          hostingType: g.hostingType,
          entryPoint: g.entryPoint,
          cdnUrl: g.cdnUrl,
          externalUrl: g.externalUrl,
          publisherId: g.publisherId,
          publisherName: g.publisherName,
          fileCount: g.fileCount,
          size: g.size,
          createdAt: g.createdAt,
          updatedAt: g.updatedAt,
          reviewStatus: g.reviewStatus || 'approved',
          submittedAt: g.submittedAt,
          reviewedAt: g.reviewedAt,
          reviewedBy: g.reviewedBy,
          latestRecord: latest,
          autoCheckWarningCount: failedAutoChecks,
          recordCount: records.length,
        };
      });
      res.json({ success: true, data: { games: summary, total: summary.length } });
    } catch (e: any) {
      logger.error({ err: e }, '[gameReview] list error');
      res.status(500).json({ success: false, error: isProduction ? 'Internal server error' : e.message });
    }
  });

  // ----- GET /records/:gameId：完整审核记录（管理员） -----
  router.get('/records/:gameId', async (req: Request, res: Response) => {
    const auth = requireAdmin(req, res);
    if (!auth) return;
    try {
      const game = await store.getGame(String(req.params.gameId));
      if (!game) return res.status(404).json({ success: false, error: '游戏不存在' });
      const records: GameReviewRecord[] = Array.isArray(game.reviewRecords) ? game.reviewRecords : [];
      // 时间倒序（最新在前）便于追溯查看
      const sorted = [...records].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      res.json({
        success: true,
        data: {
          gameId: game.id,
          reviewStatus: game.reviewStatus || 'approved',
          records: sorted,
        },
      });
    } catch (e: any) {
      logger.error({ err: e }, '[gameReview] records error');
      res.status(500).json({ success: false, error: isProduction ? 'Internal server error' : e.message });
    }
  });

  // ----- POST /submit：提交审核（发布者或管理员） -----
  router.post('/submit', async (req: Request, res: Response) => {
    const auth = extractAuth(req);
    if (!auth.userId) {
      return res.status(401).json({ success: false, error: '未登录，无法提交审核' });
    }
    try {
      const { gameId, note } = (req.body || {}) as { gameId?: string; note?: string };
      if (!gameId) return res.status(400).json({ success: false, error: 'Missing gameId' });

      const game = await store.getGame(gameId);
      if (!game) return res.status(404).json({ success: false, error: '游戏不存在，请先完成发布' });

      // 发布者校验：非管理员必须是游戏发布者本人。
      // publisherId 缺省的旧数据与 'admin' 兜底值（savePublishedGame 未登录时的平台托管默认）均放宽；
      // 否则未登录发布的游戏会因 publisherId='admin' 与 dev-token userId='anonymous' 不匹配而无法提交。
      if (!isAdmin(auth) && game.publisherId && game.publisherId !== 'admin' && game.publisherId !== auth.userId) {
        return res.status(403).json({ success: false, error: '权限不足：仅游戏发布者或管理员可提交审核' });
      }

      const autoChecks = await runAutomatedChecks(store, game);
      const record: GameReviewRecord = {
        id: newRecordId(),
        action: 'submit',
        submitterId: auth.userId,
        submitterName: game.publisherName || auth.userId,
        note,
        autoChecks,
        createdAt: Date.now(),
      };
      const records: GameReviewRecord[] = Array.isArray(game.reviewRecords) ? game.reviewRecords : [];
      records.push(record);

      game.reviewStatus = 'pending';
      game.reviewRecords = records;
      game.submittedAt = record.createdAt;
      game.reviewedAt = undefined;
      game.reviewedBy = undefined;
      await store.saveGame(game);

      logger.info({ gameId, userId: auth.userId, autoCheckFails: autoChecks.filter((c) => !c.passed).length }, '[gameReview] 游戏已提交审核');
      res.json({ success: true, data: { gameId, reviewStatus: 'pending', autoChecks, record } });
    } catch (e: any) {
      logger.error({ err: e }, '[gameReview] submit error');
      res.status(500).json({ success: false, error: isProduction ? 'Internal server error' : e.message });
    }
  });

  // ----- POST /decide：审核决定（管理员） -----
  // result: approve（通过上架）| reject（驳回）| changes_required（需修改）
  router.post('/decide', async (req: Request, res: Response) => {
    const auth = requireAdmin(req, res);
    if (!auth) return;
    try {
      const { gameId, result, reason, note, checklist } = (req.body || {}) as {
        gameId?: string;
        result?: string;
        reason?: string;
        note?: string;
        checklist?: ReviewChecklistItem[];
      };
      if (!gameId || !result) return res.status(400).json({ success: false, error: 'Missing gameId or result' });

      const game = await store.getGame(gameId);
      if (!game) return res.status(404).json({ success: false, error: '游戏不存在' });

      if (result !== 'approve' && result !== 'reject' && result !== 'changes_required') {
        return res.status(400).json({ success: false, error: `无效的审核结果: ${result}（仅支持 approve / reject / changes_required）` });
      }

      // checklist 校验：逐项核对四大审核条件
      const normalized: ReviewChecklistItem[] = CHECKLIST_TEMPLATE.map((tpl) => {
        const item = (checklist || []).find((c) => c && c.key === tpl.key);
        return {
          key: tpl.key,
          label: tpl.label,
          description: tpl.description,
          passed: !!(item && item.passed),
          note: item?.note || '',
        };
      });

      if (result === 'approve') {
        const failed = normalized.filter((c) => !c.passed);
        if (failed.length > 0) {
          return res.status(400).json({
            success: false,
            error: `审核未通过硬性条件，不能标记为通过：${failed.map((f) => f.label).join('、')} 未勾选通过`,
          });
        }
      } else {
        // 驳回 / 需修改 必须填写原因
        if (!reason || !String(reason).trim()) {
          return res.status(400).json({ success: false, error: '驳回或要求修改时必须填写原因（将反馈给发布者）' });
        }
      }

      const action: ReviewAction = result === 'approve' ? 'approve' : result === 'reject' ? 'reject' : 'changes_required';
      const newStatus: ReviewStatus = result === 'approve' ? 'approved' : result === 'reject' ? 'rejected' : 'changes_required';

      const record: GameReviewRecord = {
        id: newRecordId(),
        action,
        adminId: auth.userId,
        adminName: auth.userId.replace(/^review-admin:/, ''),
        reason: reason || '',
        note: note || '',
        checklist: normalized,
        createdAt: Date.now(),
      };
      const records: GameReviewRecord[] = Array.isArray(game.reviewRecords) ? game.reviewRecords : [];
      records.push(record);

      game.reviewStatus = newStatus;
      game.reviewRecords = records;
      game.reviewedAt = record.createdAt;
      game.reviewedBy = record.adminName || auth.userId;
      await store.saveGame(game);

      logger.info({ gameId, result, adminId: auth.userId }, '[gameReview] 审核决定已记录');
      res.json({ success: true, data: { gameId, reviewStatus: newStatus, record } });
    } catch (e: any) {
      logger.error({ err: e }, '[gameReview] decide error');
      res.status(500).json({ success: false, error: isProduction ? 'Internal server error' : e.message });
    }
  });

  // ----- POST /takedown：下架已上架游戏（管理员） -----
  router.post('/takedown', async (req: Request, res: Response) => {
    const auth = requireAdmin(req, res);
    if (!auth) return;
    try {
      const { gameId, reason, note } = (req.body || {}) as { gameId?: string; reason?: string; note?: string };
      if (!gameId) return res.status(400).json({ success: false, error: 'Missing gameId' });
      if (!reason || !String(reason).trim()) {
        return res.status(400).json({ success: false, error: '下架必须填写原因（便于追溯）' });
      }

      const game = await store.getGame(gameId);
      if (!game) return res.status(404).json({ success: false, error: '游戏不存在' });

      const record: GameReviewRecord = {
        id: newRecordId(),
        action: 'takedown',
        adminId: auth.userId,
        adminName: auth.userId.replace(/^review-admin:/, ''),
        reason,
        note: note || '',
        createdAt: Date.now(),
      };
      const records: GameReviewRecord[] = Array.isArray(game.reviewRecords) ? game.reviewRecords : [];
      records.push(record);

      game.reviewStatus = 'removed';
      game.reviewRecords = records;
      game.reviewedAt = record.createdAt;
      game.reviewedBy = record.adminName || auth.userId;
      await store.saveGame(game);

      logger.info({ gameId, adminId: auth.userId }, '[gameReview] 游戏已下架');
      res.json({ success: true, data: { gameId, reviewStatus: 'removed', record } });
    } catch (e: any) {
      logger.error({ err: e }, '[gameReview] takedown error');
      res.status(500).json({ success: false, error: isProduction ? 'Internal server error' : e.message });
    }
  });

  return router;
}
