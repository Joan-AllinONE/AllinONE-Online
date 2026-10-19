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
import crypto from 'crypto';
import { logger } from '../logger.js';
import { signToken, verifyToken } from '../auth/jwt.js';
import { isPubliclyVisible } from './gameReview.js';
import { memoryDB } from '../memoryDatabase.js';

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

// ==================== 道具凭证安全隧道（B2/B4 本地双实现） ====================
// 与云函数 gamesApi 的 __item / __market 对齐（本地 dev 环境可测同一协议）。
// dev 用模块级内存存储（重启清零，与内存库行为一致）；线上唯一权威实现为云函数。

/** 本地集合存储：collection → (docId → doc) */
const localItemStore = new Map<string, Map<string, any>>();
function localCollection(name: string): Map<string, any> {
  // 🆕 2026-10-16：vouchers 统一到 memoryDB.vouchers——生产云函数里 __item/__market/__contract
  // 本就是同一 'vouchers' 集合，此前本地双 Map 导致拼团履约发货在 __contract 侧看不到 __item 池凭证。
  // 注意：直接 Map.set 不会触发 memoryDB 落盘调度（dev 可接受，重启丢临时池凭证）。
  if (name === 'vouchers') return memoryDB.getVouchersStore();
  let m = localItemStore.get(name);
  if (!m) {
    m = new Map();
    localItemStore.set(name, m);
  }
  return m;
}

/** 本地规则注册中心（contract_rules）读取——与云函数 getPlatformRule 对齐 */
/** 兜底副本（与 src/contracts/types.ts PLATFORM_RULE_DEFAULTS 数值一致，防回潮守卫脚本校验） */
const LOCAL_RULE_FALLBACKS: Record<string, number> = {
  'market.commission_rate': 0.05,
  'item_harvest.daily_limit': 10,
  'cross_exchange.daily_limit': 20,
  'settlement.revenue_share_percent': 10,
  'settlement.cycle_ms': 86400000,
  'governance.pass_threshold': 0.5,
  'governance.weight_acoin': 0.3,
  'governance.weight_gamecoin': 0.1,
  'governance.weight_cap': 1000,
  'governance.rule_cooldown_ms': 259200000,
  'voucher.recycle_daily_pct': 0.5,
  'voucher.exchange_fee_pct': 2,
  'voucher.transfer_fee_pct': 0.5,
  'cross_exchange.fee_rate': 0.1,
};
async function getLocalRule(ruleKey: string): Promise<number> {
  // 读 memoryDB.contract_rules（与本地合约隧道 __contract/rules 治理同源；
  // 直读不缓存——治理 activate 后立即生效）
  try {
    const doc = await memoryDB.getPlatformRuleDoc(ruleKey);
    if (doc && Number.isFinite(Number(doc.value))) return Number(doc.value);
  } catch { /* 集合不存在 → 兜底 */ }
  return LOCAL_RULE_FALLBACKS[ruleKey] ?? 0;
}

const MAX_ITEM_DATA = 8 * 1024;
const MAX_EFFECT_CODE = 4000;
const MAX_VOUCHER_DOC = 16 * 1024;
const MAX_TX_DOC = 8 * 1024;

/** 实例级频控：userId → { start, n } */
const localRateMap = new Map<string, { start: number; n: number }>();
function localRateCheck(userId: string, max = 20, windowMs = 60_000): boolean {
  const now = Date.now();
  const rec = localRateMap.get(userId);
  if (!rec || now - rec.start > windowMs) {
    localRateMap.set(userId, { start: now, n: 1 });
    return true;
  }
  rec.n += 1;
  return rec.n <= max;
}

/** schema 效果规则表（与前端 SchemaRegistry 内置 schema 对齐；未知 schema 仅结构+大小校验） */
const ITEM_EFFECT_RULES: Record<string, {
  effects: string[];
  paramRanges: Record<string, [number, number]>;
  colorEnums?: string[];
}> = {
  'match3-powerup': {
    effects: ['remove_area', 'remove_row', 'remove_col', 'remove_color', 'add_time', 'add_moves', 'replace_color', 'shuffle', 'bomb', 'lightning', 'rainbow', 'randomize_cell'],
    paramRanges: { radius: [1, 3], seconds: [5, 30], count: [1, 5] },
    colorEnums: ['red', 'blue', 'green', 'yellow', 'purple', 'orange'],
  },
  'gushi-powerup': {
    effects: ['add_coins', 'flash_plus', 'lucky_cut', 'market_up', 'mine_pass'],
    paramRanges: { bonus: [500, 50000], times: [1, 9], cuts: [1, 9], mult: [1.1, 1.5], seconds: [15, 600] },
  },
};

const HIGH_VALUE_RARITIES = ['epic', 'legendary', 'mythic', '史诗', '传说', '神话'];

function localSha1(s: string): string {
  return crypto.createHash('sha1').update(String(s)).digest('hex');
}

function validateItemData(schemaName: string, itemData: any): string[] {
  const issues: string[] = [];
  if (!itemData || typeof itemData !== 'object' || Array.isArray(itemData)) return ['itemData 必须是对象'];
  if (typeof itemData.name !== 'string' || !itemData.name.trim()) issues.push('道具缺少名称');
  if (typeof itemData.effect !== 'string' || !itemData.effect.trim()) issues.push('道具缺少效果定义');
  if (JSON.stringify(itemData).length > MAX_ITEM_DATA) issues.push('itemData 超过 8KB');
  if (itemData.effectCode && String(itemData.effectCode).length > MAX_EFFECT_CODE) issues.push('effectCode 超过 4KB');
  const rules = ITEM_EFFECT_RULES[schemaName];
  if (rules) {
    if (!rules.effects.includes(itemData.effect)) {
      issues.push(`效果 "${itemData.effect}" 不在 ${schemaName} 允许的效果列表内`);
    }
    const params = itemData.params;
    if (params && typeof params === 'object' && !Array.isArray(params)) {
      for (const [key, [lo, hi]] of Object.entries(rules.paramRanges)) {
        const v = (params as any)[key];
        if (typeof v === 'number' && (v < lo || v > hi)) {
          issues.push(`参数 ${key}=${v} 超出允许范围 [${lo}, ${hi}]`);
        }
      }
      if (rules.colorEnums) {
        for (const ck of ['color', 'fromColor', 'toColor']) {
          const cv = (params as any)[ck];
          if (typeof cv === 'string' && !rules.colorEnums.includes(cv)) {
            issues.push(`颜色参数 ${ck}=${cv} 不合法`);
          }
        }
      }
      if (JSON.stringify(params).length > 1024) issues.push('params 超过 1KB');
    }
  }
  return issues;
}

function isHighValueItem(itemData: any): boolean {
  if (!itemData || typeof itemData !== 'object') return false;
  if (typeof itemData.effectCode === 'string' && itemData.effectCode.trim()) return true;
  if (typeof itemData.effectScript === 'string' && itemData.effectScript.trim()) return true;
  if (itemData.highValue === true) return true;
  return HIGH_VALUE_RARITIES.includes(String(itemData.rarity || '').toLowerCase());
}

function bumpHarvestDaily(userId: string, gameId: string, dailyLimit: number): { ok: boolean; count: number } {
  const day = new Date().toISOString().slice(0, 10);
  const id = `${userId}:${gameId}:${day}`;
  const col = localCollection('item_harvest_daily');
  const prev = col.get(id);
  const count = ((prev && prev.count) || 0) + 1;
  col.set(id, { _id: id, userId, gameId, date: day, count, updatedAt: Date.now() });
  return { ok: count <= dailyLimit, count };
}

function checkAndMarkHarvestSeen(userId: string, gameId: string, dupKey: string): boolean {
  const id = 'hs_' + localSha1(dupKey);
  const col = localCollection('item_harvest_seen');
  if (col.has(id)) return false;
  col.set(id, { _id: id, userId, gameId, key: String(dupKey).slice(0, 300), createdAt: Date.now() });
  return true;
}

function signVoucherIntegrity(voucherId: string, userId: string, gameId: string, itemHash: string): string {
  const secret = process.env.JWT_SECRET || 'dev-secret-do-not-use-in-prod-change-me';
  return 'v1:' + crypto.createHmac('sha256', secret).update(`${voucherId}|${userId}|${gameId}|${itemHash}`).digest('hex');
}

function verifyVoucherIntegrity(doc: any): boolean {
  try {
    const ig = doc && doc.integrity;
    if (!ig || ig.v !== 1 || !ig.sig || !ig.userId || !ig.gameId) return false;
    return signVoucherIntegrity(doc.id, ig.userId, ig.gameId, ig.itemHash || '') === ig.sig;
  } catch {
    return false;
  }
}

function buildItemVoucher(userId: string, userName: string, gameId: string, schemaName: string, itemData: any, dupKey: string): any {
  const voucherId = 'vh_' + Date.now().toString(36) + '_' + crypto.randomBytes(4).toString('hex');
  const itemHash = localSha1(JSON.stringify(itemData || {}));
  const highValue = isHighValueItem(itemData);
  const itemName = String((itemData && itemData.name) || '未命名道具').slice(0, 50);
  const customData: Record<string, any> = {
    origin: 'gameplay',
    gameId,
    schemaName,
    harvestId: dupKey,
    harvestedAt: Date.now(),
    gameEffect: { schemaName, itemId: String((itemData && itemData.effect) || ''), quantity: 1, itemData: itemData || {} },
  };
  if (highValue) {
    customData.highValue = true;
    customData.reviewStatus = 'pending';
  }
  const voucher: any = {
    id: voucherId,
    serialNumber: 'SN' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(2).toString('hex').toUpperCase(),
    denomination: 0,
    currentHolderId: userId,
    currentHolderName: String(userName || '玩家').slice(0, 50),
    status: 'active',
    createdAt: Date.now(),
    createdBy: 'SYSTEM',
    createdByName: '游戏收获系统',
    transferCount: 0,
    sourceType: 'item',
    metadata: {
      sourceType: 'item',
      name: itemName,
      description: String((itemData && itemData.description) || '游戏内掉落道具').slice(0, 200),
      category: 'item',
      tags: ['item_voucher', 'gameplay_harvest', String(gameId).slice(0, 60), String(schemaName).slice(0, 60)],
      issuer: String(gameId).slice(0, 60),
      customData,
    },
    integrity: { v: 1, mintedBy: 'server', userId, gameId, itemHash, mintedAt: Date.now() },
  };
  voucher.integrity.sig = signVoucherIntegrity(voucherId, userId, gameId, itemHash);
  return voucher;
}

/** 注册 __item / __market 本地隧道路由（dev 双实现，逻辑与云函数对齐） */
function registerItemMarketTunnels(router: Router): void {
  // ---------- POST /__item/mint ----------
  router.post('/__item/mint', express.json({ limit: '1mb' }), async (req: Request, res: Response) => {
    const auth = extractAuthInfo(req);
    if (!auth.userId) return res.status(401).json({ success: false, error: '未登录：道具铸造需要 Bearer token' });
    if (!localRateCheck(auth.userId)) return res.status(429).json({ success: false, error: '操作过于频繁', code: 'rate_limit' });
    const { gameId, schemaName, itemData, harvestId, userName } = req.body || {};
    if (!gameId || !schemaName) return res.status(400).json({ success: false, error: 'missing gameId or schemaName' });
    const issues = validateItemData(schemaName, itemData);
    if (issues.length) return res.status(400).json({ success: false, error: `道具校验未通过: ${issues.join('; ')}`, code: 'invalid' });
    const dupKey = harvestId ? `${gameId}:${String(harvestId)}` : `${gameId}:${localSha1(JSON.stringify(itemData || {}))}`;
    if (!checkAndMarkHarvestSeen(auth.userId, gameId, dupKey)) {
      return res.status(409).json({ success: false, error: '该道具已提取过，请勿重复提取', code: 'duplicate' });
    }
    const ITEM_DAILY_LIMIT = await getLocalRule('item_harvest.daily_limit');
    const daily = bumpHarvestDaily(auth.userId, gameId, ITEM_DAILY_LIMIT);
    if (!daily.ok) {
      return res.status(429).json({ success: false, error: `今日在该游戏的道具提取次数已达上限（${ITEM_DAILY_LIMIT} 个）`, code: 'daily_limit', data: { remaining: 0 } });
    }
    const voucher = buildItemVoucher(auth.userId, userName, gameId, schemaName, itemData, dupKey);
    localCollection('vouchers').set(voucher.id, voucher);
    logger.info({ voucherId: voucher.id, userId: auth.userId, gameId }, '[item] mint 成功（本地）');
    return res.json({ success: true, data: { voucher, remaining: Math.max(0, ITEM_DAILY_LIMIT - daily.count) } });
  });

  // ---------- POST /__item/update ----------
  router.post('/__item/update', express.json({ limit: '1mb' }), (req: Request, res: Response) => {
    const auth = extractAuthInfo(req);
    if (!auth.userId) return res.status(401).json({ success: false, error: '未登录' });
    if (!localRateCheck(auth.userId)) return res.status(429).json({ success: false, error: '操作过于频繁' });
    const { voucherId, patch } = req.body || {};
    if (!voucherId || !patch || typeof patch !== 'object') return res.status(400).json({ success: false, error: 'missing voucherId or patch' });
    const ALLOWED_PATCH = ['status', 'currentHolderId', 'currentHolderName', 'frozenAt', 'lastTransferAt', 'transferCount', 'reviewStatus', 'reviewNote', 'reviewedAt', 'reviewedBy'];
    const clean: Record<string, any> = {};
    for (const k of ALLOWED_PATCH) if (k in patch) clean[k] = patch[k];
    if (Object.keys(clean).length === 0) return res.status(400).json({ success: false, error: 'patch 中无可迁移字段' });
    if ('reviewStatus' in clean && !authIsAdmin(auth)) return res.status(403).json({ success: false, error: 'reviewStatus 变更仅管理员可执行' });
    if ('status' in clean && !['active', 'frozen', 'redeemed', 'destroyed', 'expired'].includes(clean.status)) {
      return res.status(400).json({ success: false, error: 'status 值非法' });
    }
    const col = localCollection('vouchers');
    const doc = col.get(String(voucherId));
    if (!doc) return res.status(404).json({ success: false, error: '凭证不存在（以云端账本为准）', code: 'not_found' });
    if (!authIsAdmin(auth) && doc.currentHolderId && doc.currentHolderId !== auth.userId) {
      return res.status(403).json({ success: false, error: '不是该凭证的当前持有者' });
    }
    col.set(String(voucherId), { ...doc, ...clean, updatedAt: Date.now() });
    return res.json({ success: true, data: { id: String(voucherId) } });
  });

  // ---------- POST /__item/sync ----------
  router.post('/__item/sync', express.json({ limit: '1mb' }), async (req: Request, res: Response) => {
    const auth = extractAuthInfo(req);
    if (!auth.userId) return res.status(401).json({ success: false, error: '未登录' });
    const { collection, doc } = req.body || {};
    if (collection !== 'vouchers' && collection !== 'voucher_transactions') {
      return res.status(400).json({ success: false, error: 'collection 必须是 vouchers 或 voucher_transactions' });
    }
    if (!doc || !doc.id) return res.status(400).json({ success: false, error: 'missing doc.id' });
    const docLimit = collection === 'vouchers' ? MAX_VOUCHER_DOC : MAX_TX_DOC;
    if (JSON.stringify(doc).length > docLimit) {
      return res.status(413).json({ success: false, error: `${collection} 文档超过 ${Math.floor(docLimit / 1024)}KB 限制` });
    }
    // 平台备货（platform_pool / SYSTEM 等平台账户持有）不属于玩家日常提取，
    // 不受玩家级频控约束（客户端全量兜底一次可推 200+ 条，20/分钟必 429）
    const PLATFORM_HOLDER_IDS = new Set(['platform_pool', 'SYSTEM', 'system', 'PLATFORM_POOL']);
    const isPlatformStocking = PLATFORM_HOLDER_IDS.has(String(doc.currentHolderId || '')) || PLATFORM_HOLDER_IDS.has(String(doc.currentHolderId || '').toLowerCase());
    // 交易是审计日志（幂等 id），放宽到 300/分钟——客户端兜底一次可推 100 条，20/分钟必 429 轰炸
    const txSync = collection === 'voucher_transactions';
    if (!localRateCheck(auth.userId, isPlatformStocking || txSync ? 300 : 20)) return res.status(429).json({ success: false, error: '同步过于频繁，请稍后再试' });
    const col = localCollection(collection);
    if (collection === 'vouchers') {
      const existing = col.get(String(doc.id)) || null;
      if (existing && existing.integrity && existing.integrity.mintedBy === 'server') {
        const ALLOWED = ['status', 'currentHolderId', 'currentHolderName', 'frozenAt', 'lastTransferAt', 'transferCount'];
        const merged: any = { ...existing };
        for (const k of ALLOWED) if (k in doc) merged[k] = doc[k];
        merged.updatedAt = Date.now();
        col.set(String(doc.id), merged);
        return res.json({ success: true, data: { id: String(doc.id), protected: true } });
      }
      const isNew = !existing;
      const isItem = doc.sourceType === 'item' || (doc.metadata && doc.metadata.sourceType === 'item');
      if (isNew && isItem) {
        const cd = (doc.metadata && doc.metadata.customData) || {};
        const itemData = (cd.gameEffect && cd.gameEffect.itemData) || null;
        // schemaName 的唯一用途是校验 itemData 的效果合法性；平台模板凭证（plt-*，
        // 铸自道具工坊/seed）没有 itemData，强制要求 schemaName 会让合法凭证全部 400
        if (itemData) {
          const schemaName = cd.schemaName || (cd.gameEffect && cd.gameEffect.schemaName) || '';
          if (!schemaName) {
            logger.warn({ userId: auth.userId, voucherId: String(doc.id), holder: doc.currentHolderId, templateId: cd.itemTemplateId }, '[item] sync 拒绝：道具凭证缺少 schemaName');
            return res.status(400).json({ success: false, error: '道具凭证缺少 schemaName' });
          }
          const issues = validateItemData(schemaName, itemData);
          if (issues.length) {
            logger.warn({ userId: auth.userId, voucherId: String(doc.id), holder: doc.currentHolderId, templateId: cd.itemTemplateId, issues }, '[item] sync 拒绝：道具凭证校验未通过');
            return res.status(400).json({ success: false, error: `道具凭证校验未通过: ${issues.join('; ')}` });
          }
        }
        // 平台备货（铸造进 platform_pool/SYSTEM 的初始库存）不属于玩家日常提取，
        // 不扣玩家 item_harvest.daily_limit 额度（否则 616 张库存被 10/日 闸死）
        if (isPlatformStocking) {
          logger.info({ userId: auth.userId, voucherId: String(doc.id), holder: doc.currentHolderId, templateId: cd.itemTemplateId }, '[item] sync 平台备货入库（免玩家级提取限额）');
        } else {
          const dupKey = cd.harvestId || `sync:${doc.id}`;
          if (!checkAndMarkHarvestSeen(auth.userId, cd.gameId || 'unknown', String(dupKey))) {
            logger.warn({ userId: auth.userId, voucherId: String(doc.id) }, '[item] sync 拒绝：幂等重复');
            return res.status(409).json({ success: false, error: '该道具已提取过（幂等）', code: 'duplicate' });
          }
          const ITEM_DAILY_LIMIT = await getLocalRule('item_harvest.daily_limit');
          const daily = bumpHarvestDaily(auth.userId, cd.gameId || 'unknown', ITEM_DAILY_LIMIT);
          if (!daily.ok) {
            logger.warn({ userId: auth.userId, voucherId: String(doc.id), gameId: cd.gameId, limit: ITEM_DAILY_LIMIT }, '[item] sync 拒绝：今日提取次数达上限');
            return res.status(429).json({ success: false, error: '今日提取次数已达上限', code: 'daily_limit' });
          }
        }
      }
    }
    col.set(String(doc.id), doc);
    return res.json({ success: true, data: { id: String(doc.id) } });
  });

  // ---------- POST /__item/verify ----------
  router.post('/__item/verify', express.json({ limit: '1mb' }), (req: Request, res: Response) => {
    const auth = extractAuthInfo(req);
    if (!auth.userId) return res.status(401).json({ success: false, error: '未登录' });
    const ids = (req.body && Array.isArray(req.body.voucherIds)) ? req.body.voucherIds.slice(0, 50) : [];
    const col = localCollection('vouchers');
    const results = ids.map((vid: string) => {
      const doc = col.get(String(vid)) || null;
      return {
        id: String(vid),
        exists: !!doc,
        currentHolderId: doc ? doc.currentHolderId : undefined,
        status: doc ? doc.status : undefined,
        reviewStatus: (doc && doc.metadata && doc.metadata.customData) ? doc.metadata.customData.reviewStatus : undefined,
        mintedBy: (doc && doc.integrity) ? doc.integrity.mintedBy : 'client',
        signatureValid: (doc && doc.integrity) ? verifyVoucherIntegrity(doc) : null,
      };
    });
    return res.json({ success: true, data: { results } });
  });

  // ---------- POST /__item/purchase ----------
  router.post('/__item/purchase', express.json({ limit: '1mb' }), (req: Request, res: Response) => {
    const auth = extractAuthInfo(req);
    if (!auth.userId) return res.status(401).json({ success: false, error: '未登录' });
    const doc = req.body && req.body.doc;
    if (!doc || !doc.id) return res.status(400).json({ success: false, error: 'missing doc.id' });
    if (JSON.stringify(doc).length > MAX_TX_DOC) {
      return res.status(413).json({ success: false, error: 'purchases 文档超过 8KB 限制' });
    }
    if (!localRateCheck(auth.userId)) return res.status(429).json({ success: false, error: '同步过于频繁，请稍后再试' });
    localCollection('purchases').set(String(doc.id), doc);
    return res.json({ success: true, data: { id: String(doc.id) } });
  });

  // ---------- GET /__item/harvest-limit ----------
  router.get('/__item/harvest-limit', async (req: Request, res: Response) => {
    const auth = extractAuthInfo(req);
    if (!auth.userId) return res.status(401).json({ success: false, error: '未登录' });
    const gameId = String(req.query.gameId || '');
    if (!gameId) return res.status(400).json({ success: false, error: 'missing gameId' });
    const ITEM_DAILY_LIMIT = await getLocalRule('item_harvest.daily_limit');
    const day = new Date().toISOString().slice(0, 10);
    const rec = localCollection('item_harvest_daily').get(`${auth.userId}:${gameId}:${day}`);
    const count = (rec && rec.count) || 0;
    return res.json({ success: true, data: { remaining: Math.max(0, ITEM_DAILY_LIMIT - count), limit: ITEM_DAILY_LIMIT } });
  });

  // ---------- POST /__market/list ----------
  router.post('/__market/list', express.json({ limit: '1mb' }), (req: Request, res: Response) => {
    const auth = extractAuthInfo(req);
    if (!auth.userId) return res.status(401).json({ success: false, error: '未登录：市场写入需要 Bearer token' });
    const listing = req.body && req.body.listing;
    if (!listing || !listing.id || !listing.voucherId || !listing.sellerId) {
      return res.status(400).json({ success: false, error: 'missing listing.id / voucherId / sellerId' });
    }
    if (listing.sellerId !== auth.userId) return res.status(403).json({ success: false, error: '上架者身份与 token 不一致' });
    if (typeof listing.price !== 'number' || !(listing.price > 0)) return res.status(400).json({ success: false, error: '价格必须大于 0' });
    const voucher = localCollection('vouchers').get(String(listing.voucherId)) || null;
    if (!voucher) return res.status(400).json({ success: false, error: '被挂凭证不存在（云端为准）', code: 'voucher_missing' });
    if (voucher.currentHolderId !== listing.sellerId) return res.status(403).json({ success: false, error: '被挂凭证不属于你', code: 'holder_mismatch' });
    if (voucher.status === 'redeemed' || voucher.status === 'destroyed') return res.status(400).json({ success: false, error: '该凭证已被使用/销毁，无法上架' });
    const reviewStatus = (voucher.metadata && voucher.metadata.customData) ? voucher.metadata.customData.reviewStatus : undefined;
    if (reviewStatus === 'pending') return res.status(403).json({ success: false, error: '高价值道具审核中，暂不能上架' });
    if (reviewStatus === 'rejected') return res.status(403).json({ success: false, error: '该道具未通过平台审核，不能上架' });
    localCollection('market_listings').set(String(listing.id), { ...listing, status: 'active', serverVerifiedAt: Date.now() });
    return res.json({ success: true, data: { id: String(listing.id) } });
  });

  // ---------- POST /__market/buy ----------
  router.post('/__market/buy', express.json({ limit: '1mb' }), (req: Request, res: Response) => {
    const auth = extractAuthInfo(req);
    if (!auth.userId) return res.status(401).json({ success: false, error: '未登录' });
    const { listingId, buyerId, buyerName, paymentTxIds } = req.body || {};
    if (!listingId || !buyerId) return res.status(400).json({ success: false, error: 'missing listingId or buyerId' });
    if (buyerId !== auth.userId) return res.status(403).json({ success: false, error: '买家身份与 token 不一致' });
    const lcol = localCollection('market_listings');
    const listing = lcol.get(String(listingId)) || null;
    if (!listing) return res.status(404).json({ success: false, error: '挂牌不存在', code: 'not_found' });
    if (listing.status !== 'active') {
      return res.status(409).json({ success: false, error: listing.status === 'sold' ? '该商品已售出' : '该商品已下架', code: 'not_active' });
    }
    if (listing.sellerId === buyerId) return res.status(400).json({ success: false, error: '不能购买自己的商品' });
    lcol.set(String(listingId), {
      ...listing,
      status: 'sold',
      soldAt: Date.now(),
      buyerId,
      buyerName: String(buyerName || '').slice(0, 50),
      paymentTxIds: Array.isArray(paymentTxIds) ? paymentTxIds.slice(0, 10).map(String) : [],
      soldAtServer: Date.now(),
    });
    const purId = 'pur_' + String(listingId);
    localCollection('purchases').set(purId, {
      _id: purId, id: purId, listingId: String(listingId), voucherId: listing.voucherId,
      itemName: listing.itemName, price: listing.price, currency: listing.currency,
      sellerId: listing.sellerId, sellerName: listing.sellerName, buyerId,
      buyerName: String(buyerName || '').slice(0, 50), purchasedAt: Date.now(),
    });
    return res.json({ success: true, data: { listingId: String(listingId), status: 'sold' } });
  });

  // ---------- POST /__market/unlist ----------
  router.post('/__market/unlist', express.json({ limit: '1mb' }), (req: Request, res: Response) => {
    const auth = extractAuthInfo(req);
    if (!auth.userId) return res.status(401).json({ success: false, error: '未登录' });
    const { listingId, userId } = req.body || {};
    if (!listingId || !userId) return res.status(400).json({ success: false, error: 'missing listingId or userId' });
    if (userId !== auth.userId) return res.status(403).json({ success: false, error: '下架者身份与 token 不一致' });
    const lcol = localCollection('market_listings');
    const listing = lcol.get(String(listingId)) || null;
    if (!listing) return res.status(404).json({ success: false, error: '挂牌不存在', code: 'not_found' });
    if (listing.sellerId !== userId) return res.status(403).json({ success: false, error: '只能下架自己的商品' });
    if (listing.status !== 'active') return res.status(409).json({ success: false, error: '商品已售出或已下架', code: 'not_active' });
    lcol.set(String(listingId), { ...listing, status: 'cancelled', cancelledAt: Date.now() });
    return res.json({ success: true, data: { listingId: String(listingId), status: 'cancelled' } });
  });

  // ---------- 道具凭证点赞/点倒赞：__vote（与云函数 __vote 对齐） ----------
  //   GET  /__vote?gameId= — 该游戏全部道具投票聚合 + 当前用户投票（游客可读，无 mine）
  //   POST /__vote { gameId, targetId, vote: 'up'|'down'|'cancel' } — 身份取自 token；
  //     每用户每目标一票（确定性 ID vote_{targetId}_{userId} 覆盖写），cancel 删除自己的票
  const aggregateVotes = (gameId: string, userId?: string) => {
    const counts: Record<string, { up: number; down: number }> = {};
    const mine: Record<string, 'up' | 'down'> = {};
    for (const doc of localCollection('voucher_votes').values()) {
      if (doc.gameId !== gameId) continue;
      const t = String(doc.targetId || '');
      if (!t) continue;
      if (!counts[t]) counts[t] = { up: 0, down: 0 };
      if (doc.vote === 'up') counts[t].up += 1;
      else if (doc.vote === 'down') counts[t].down += 1;
      if (userId && doc.userId === userId) mine[t] = doc.vote;
    }
    return { counts, mine };
  };

  router.get('/__vote', (req: Request, res: Response) => {
    const gameId = String(req.query.gameId || '');
    if (!gameId) return res.status(400).json({ success: false, error: 'missing gameId' });
    const auth = extractAuthInfo(req);
    return res.json({ success: true, data: aggregateVotes(gameId, auth.userId) });
  });

  router.post('/__vote', express.json({ limit: '64kb' }), (req: Request, res: Response) => {
    const auth = extractAuthInfo(req);
    if (!auth.userId) return res.status(401).json({ success: false, error: '未登录：投票需要 Bearer token' });
    if (!localRateCheck(auth.userId)) return res.status(429).json({ success: false, error: '操作过于频繁', code: 'rate_limit' });
    const { targetId, gameId, vote } = req.body || {};
    if (!targetId || !gameId || !['up', 'down', 'cancel'].includes(vote)) {
      return res.status(400).json({ success: false, error: 'missing/invalid targetId, gameId or vote' });
    }
    const col = localCollection('voucher_votes');
    const id = `vote_${String(targetId)}_${auth.userId}`;
    if (vote === 'cancel') {
      col.delete(id);
    } else {
      col.set(id, {
        _id: id,
        targetId: String(targetId),
        gameId: String(gameId),
        userId: auth.userId,
        vote,
        updatedAt: Date.now(),
      });
    }
    return res.json({ success: true, data: aggregateVotes(String(gameId), auth.userId) });
  });
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
  // 注入到 </head> 前：loader 定义必须先于游戏内 AllinONE_ContentLoader.on() 注册代码执行（时序安全）；
  // loader 仅定义全局对象 + 注册 message 监听，无 DOM 依赖，head 阶段执行安全。
  const headIdx = lower.lastIndexOf('</head>');
  return headIdx >= 0 ? html.slice(0, headIdx) + block + html.slice(headIdx) : html + block;
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
      const { userId, role } = req.body;
      if (!userId || typeof userId !== 'string') {
        return res.status(400).json({ success: false, error: 'Missing userId' });
      }
      // 🆕 角色随签发写入 JWT（合约隧道 requireAdmin 依赖）；白名单防越权注入
      const safeRole = ['player', 'admin', 'platform', 'developer'].includes(String(role)) ? String(role) : 'player';
      const token = signToken({ userId, role: safeRole });
      res.json({ success: true, data: { token } });
    } catch (error: any) {
      logger.error({ err: error }, '[games] dev-token error');
      res.status(500).json({ success: false, error: 'Token generation failed' });
    }
  });

  // ----------------------------------------------------------
  // 道具凭证安全隧道（B2/B4 本地双实现，与云函数 __item / __market 对齐）
  //   POST /__item/mint | /__item/update | /__item/sync | /__item/verify
  //   GET  /__item/harvest-limit?gameId=
  //   POST /__market/list | /__market/buy | /__market/unlist
  // 身份从 JWT 解析（与云函数一致，绝不信 body）。
  // ----------------------------------------------------------
  registerItemMarketTunnels(router);

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

  // ----- GET /users（users 集合只读同步，钱包/分账余额跨端可见；须 Bearer token） -----
  // ⚠️ 必须注册在 GET /:id 之前，否则 'users' 会被当 gameId 截胡（前端 loadFromBackend('users')
  // 永远 404 → WalletSkill 回退 localStorage 旧值 → 服务端分账的钱在钱包 UI 不可见）。
  router.get('/users', async (req: Request, res: Response) => {
    try {
      const auth = extractAuthInfo(req);
      if (!auth.userId) {
        return res.status(401).json({ success: false, error: '未登录：users 只读同步需要 Bearer token' });
      }
      const skip = Math.max(0, parseInt(String(req.query.skip || '0'), 10) || 0);
      const limit = Math.min(500, Math.max(1, parseInt(String(req.query.limit || '200'), 10) || 200));
      if (useMemoryDB) {
        const all = await memoryDB.listUsers();
        return res.json({ success: true, data: { list: all.slice(skip, skip + limit), total: all.length } });
      }
      if (pool) {
        const result = await pool.query(
          `SELECT * FROM users ORDER BY updated_at DESC OFFSET $1 LIMIT $2`,
          [skip, limit],
        );
        return res.json({ success: true, data: { list: result.rows } });
      }
      return res.json({ success: true, data: { list: [] } });
    } catch (e: any) {
      logger.error({ err: e }, '[games] users list error');
      res.status(500).json({ success: false, error: isProduction ? 'Internal server error' : e.message });
    }
  });

  // ----- GET /transactions（钱包流水只读同步；须 Bearer token；勿放 GET /:id 之后） -----
  // 消费方：WalletSkill 服务端流水回退 + 平台金库报表（platformTreasuryService）聚合三方分成收益。
  router.get('/transactions', async (req: Request, res: Response) => {
    try {
      const auth = extractAuthInfo(req);
      if (!auth.userId) {
        return res.status(401).json({ success: false, error: '未登录：transactions 只读同步需要 Bearer token' });
      }
      const skip = Math.max(0, parseInt(String(req.query.skip || '0'), 10) || 0);
      const limit = Math.min(500, Math.max(1, parseInt(String(req.query.limit || '200'), 10) || 200));
      if (useMemoryDB) {
        const all = await memoryDB.listTransactions();
        return res.json({ success: true, data: { list: all.slice(skip, skip + limit), total: all.length } });
      }
      if (pool) {
        const result = await pool.query(
          `SELECT * FROM transactions ORDER BY timestamp DESC OFFSET $1 LIMIT $2`,
          [skip, limit],
        );
        return res.json({ success: true, data: { list: result.rows } });
      }
      return res.json({ success: true, data: { list: [] } });
    } catch (e: any) {
      logger.error({ err: e }, '[games] transactions list error');
      res.status(500).json({ success: false, error: isProduction ? 'Internal server error' : e.message });
    }
  });

  // ----- GET /:collection（只读同步白名单；必须注册在 GET /:id 之前，否则被当 gameId 截胡 → 404） -----
  // 与云函数 SYNC_COLLECTIONS GET 分支对齐。只读：写入仍走 __item/* / __market/* 唯一入口。
  // 2026-10-17：补齐本地实现——此前 GET /vouchers 等全部 404，跨浏览器恢复与服务端池验证通道断裂。
  const SYNC_READ_COLLECTIONS = new Set([
    // 凭证 / 模板 / 购买 / 流水
    'vouchers', 'voucher_templates', 'purchases', 'voucher_transactions',
    // 提案 / 治理
    'proposals', 'vote_thresholds', 'penalty_logs',
    // 市场
    'market_listings',
    // 钱包 / 背包
    'inventories',
    // 兑换码
    'redeem_hosted_items', 'redeem_codes', 'redeem_purchases',
    // 平台配置 / 商店
    'platform_treasury', 'game_stores', 'platform_config', 'store_products',
    // 扩展凭证
    'extension_vouchers',
    // 奖池 / 绑定 / 奖励（PlatformBindingService / UserPoolService）
    'user_pools', 'platform_bindings', 'reward_records', 'user_reward_limits',
  ]);
  router.get('/:collection', async (req: Request, res: Response, next: Function) => {
    const collection = String(req.params.collection || '');
    if (!SYNC_READ_COLLECTIONS.has(collection)) return next(); // 非白名单 → 交给 GET /:id（游戏详情）
    try {
      const auth = extractAuthInfo(req);
      if (!auth.userId) {
        return res.status(401).json({ success: false, error: `未登录：${collection} 只读同步需要 Bearer token` });
      }
      const skip = Math.max(0, parseInt(String(req.query.skip || '0'), 10) || 0);
      const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit || '200'), 10) || 200));
      const col = localCollection(collection);
      const all = Array.from(col.values()).sort((a: any, b: any) => (b.createdAt || b.updatedAt || 0) - (a.createdAt || a.updatedAt || 0));
      return res.json({ success: true, data: { list: all.slice(skip, skip + limit), skip, limit } });
    } catch (e) {
      // 集合不存在/读取失败：返回空列表而非 500，避免前端轮询刷屏（与云函数对齐）
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn(`[sync] GET ${collection} 失败: ${msg}`);
      return res.json({ success: false, error: msg, data: { list: [], skip: 0, limit: 200 } });
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
