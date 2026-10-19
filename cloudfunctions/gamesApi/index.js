/**
 * gamesApi — AllinONE 已发布游戏列表后端（CloudBase 事件型 HTTP 函数）
 *
 * 通过 CloudBase HTTP 访问服务暴露为标准 HTTP 接口（免鉴权），
 * 使用管理员 Node SDK 直接读写真实数据库集合 `published_games`，
 * 因此跨浏览器、跨会话、重启后端都不会丢数据。
 *
 * 部署方式：tcb fn deploy gamesApi --path /api/v1/games
 *   - 函数类型为「事件函数」，HTTP 访问服务把请求以 event 形式投递给 exports.main
 *   - event 包含 httpMethod / path / body / headers / isBase64Encoded
 *   - 前端以 fetch('/api/v1/games') 调用，无需任何 SDK / 登录态
 *
 * 环境变量：无需任何密钥，函数运行在自身环境内（SYMBOL_CURRENT_ENV）。
 */

const cloudbase = require('@cloudbase/node-sdk');

// ★ 合约引擎：自动生成产物（scripts/build-engine.cjs），禁止手工编辑；本地 server 直接用 TS 源码（同一逻辑）
const CE = require('./contract-engine');

const app = cloudbase.init({
  env: cloudbase.SYMBOL_CURRENT_ENV,
});

const db = app.database();
const COLLECTION = 'published_games';

// ========== 三方分成：服务端影子对照 + 配置变更哈希链存证（与本地 gameDeveloper.ts 对齐） ==========
// 注意：这些 helpers 必须在模块顶层——game-developers 等路由挂在对象字面量内，字面量内不能声明 const/function
const SHARING_GENESIS_HASH = '0'.repeat(64);
function computeThreeWaySplitServer(amount, rs, legacyPercent) {
  const g = rs ? Number(rs.gameShare) || 0 : 0;
  const p = rs ? Number(rs.platformShare) || 0 : 0;
  const c = rs ? Number(rs.creatorShare) || 0 : 0;
  if (!rs || (g <= 0 && p <= 0 && c <= 0)) {
    const platformCut = Math.floor((amount * (Number(legacyPercent) || 0)) / 100);
    return { gameCut: amount - platformCut, platformCut, creatorCut: 0, mode: 'legacy' };
  }
  const platformCut = Math.floor(amount * p);
  const creatorCut = Math.floor(amount * c);
  return { gameCut: amount - platformCut - creatorCut, platformCut, creatorCut, mode: 'three-way' };
}
/**
 * 🆕 2026-10-16 拼团履约发货（与本地 fulfillGroupBuyItems 对齐）：按 skuId 把平台池
 * （platform_pool）预铸道具凭证逐成员转移；库存（池内可用凭证）自然减少。
 * 幂等：gbr metadata.itemVoucherId 已存在跳过；池内无货 → 保持待发货，tick 自愈重试。
 * 供成团交割钩子与 __contract/tick 补发共用。
 */
async function fulfillGroupBuyItemsCloud(inst) {
  const p = inst.params || {};
  const skuId = String(p.skuId || '');
  if (!skuId) return;
  const contributions = (inst.stateData && Array.isArray(inst.stateData.contributions)) ? inst.stateData.contributions : [];
  const seen = new Set();
  for (const c of contributions) {
    const uid = String((c && c.userId) || '');
    if (!uid || seen.has(uid)) continue;
    seen.add(uid);
    try {
      const vid2 = 'gbr_' + inst.id + '_' + uid;
      const gbrRes = await gsGet('vouchers', vid2);
      const gbrDoc = (gbrRes && gbrRes.data && gbrRes.data[0]) || null;
      if (!gbrDoc || (gbrDoc.metadata && gbrDoc.metadata.itemVoucherId)) continue;
      let poolDoc = null;
      try {
        let offset = 0;
        while (!poolDoc) {
          const poolRes = await db.collection('vouchers')
            .where({ currentHolderId: 'platform_pool', status: 'active' })
            .skip(offset).limit(100).get();
          const rows = (poolRes && poolRes.data) || [];
          for (const cand of rows) {
            if (cand.frozenAt) continue;
            const st = cand.sourceType || (cand.metadata && cand.metadata.sourceType);
            if (st !== 'item') continue;
            const tpl = cand.metadata && cand.metadata.customData && cand.metadata.customData.itemTemplateId;
            if (tpl !== skuId) continue;
            poolDoc = cand; break;
          }
          if (!poolDoc && rows.length < 100) break;
          offset += 100;
        }
      } catch (_) { /* 池集合异常视为无货 */ }
      if (!poolDoc) {
        console.warn('[contract:group-buy] ⚠️ 履约库存不足：skuId=' + skuId + '（成员 ' + uid + ' 保持待发货）');
        continue;
      }
      const poolId = poolDoc._id || poolDoc.id;
      const del = Object.assign({}, poolDoc, {
        currentHolderId: uid, currentHolderName: uid, lastTransferAt: Date.now(),
        metadata: Object.assign({}, poolDoc.metadata || {}, {
          customData: Object.assign({}, (poolDoc.metadata || {}).customData || {}, {
            fulfilledByContract: inst.id, fulfilledAt: Date.now(),
          }),
        }),
      });
      delete del._id;
      await gsUpsert('vouchers', poolId, del);
      const gmeta = Object.assign({}, gbrDoc.metadata || {}, {
        fulfilled: true, fulfillmentPending: false, itemVoucherId: poolId, deliveredAt: Date.now(),
      });
      delete gbrDoc._id;
      gbrDoc.metadata = gmeta;
      await gsUpsert('vouchers', vid2, gbrDoc);
      console.log('[contract:group-buy] 🎁 履约发货：' + skuId + ' → ' + uid + '（道具凭证 ' + poolId + '）');
    } catch (fulErr) {
      console.warn('[contract:group-buy] 成员 ' + uid + ' 履约发货失败（不阻塞）:', (fulErr && fulErr.message) || fulErr);
    }
  }
}

function sharingEntryHashServer(prevHash, payload) {
  return require('crypto').createHash('sha256').update(
    prevHash + '|' + JSON.stringify({
      accountId: payload.accountId,
      gameId: payload.gameId,
      config: payload.config,
      source: payload.source,
      proposalId: payload.proposalId || null,
      timestamp: payload.timestamp,
    }),
  ).digest('hex');
}

// ========== 平台规则注册中心（模块顶层：__market/buy 与 __contract 共用） ==========
const RULES_COL = 'contract_rules';
const PLATFORM_RULE_DEFAULTS = [
  // ---- 市场 ----
  { ruleKey: 'market.commission_rate', value: 0.05, description: '市场成交佣金率（__market/buy 收益台账记账使用）' },
  // ---- 频控 / 限额 ----
  { ruleKey: 'item_harvest.daily_limit', value: 10, description: '游戏道具每日提取次数上限' },
  { ruleKey: 'cross_exchange.daily_limit', value: 20, description: '跨游戏兑换每日次数上限' },
  // ---- 开发者结算 ----
  { ruleKey: 'settlement.revenue_share_percent', value: 10, description: '游戏方销售平台抽成默认值 %' },
  { ruleKey: 'settlement.cycle_ms', value: 86400000, description: '开发者收益每日结算周期毫秒' },
  // ---- 治理计票 ----
  { ruleKey: 'governance.pass_threshold', value: 0.5, description: '提案通过阈值（赞成/总权重）' },
  { ruleKey: 'governance.weight_acoin', value: 0.3, description: '投票权重公式 A 币系数' },
  { ruleKey: 'governance.weight_gamecoin', value: 0.1, description: '投票权重公式游戏币系数' },
  { ruleKey: 'governance.weight_cap', value: 1000, description: '单用户投票权重上限' },
  { ruleKey: 'governance.rule_cooldown_ms', value: 259200000, description: '规则修改公示期毫秒，默认 72h' },
  // ---- 凭证平台级费率 ----
  { ruleKey: 'voucher.recycle_daily_pct', value: 0.5, description: '每日结算回收比例 %（→金库）' },
  { ruleKey: 'voucher.exchange_fee_pct', value: 2, description: '凭证兑换手续费 %（→销毁）' },
  { ruleKey: 'voucher.transfer_fee_pct', value: 0.5, description: '凭证转账手续费 %（→平台）' },
  // ---- 跨游戏兑换 ----
  { ruleKey: 'cross_exchange.fee_rate', value: 0.1, description: '跨游戏兑换手续费率（按目标道具价值）' },
];
const RULE_COOLDOWN_MS = 72 * 3600 * 1000; // seed 兜底公示期；注册后以 governance.rule_cooldown_ms 为准
const ruleCache = new Map();
async function getPlatformRule(ruleKey, fallback) {
  const cached = ruleCache.get(ruleKey);
  if (cached && Date.now() - cached.at < 60000) return cached.value;
  try {
    const r = await gsGet(RULES_COL, ruleKey);
    const doc = (r && r.data && r.data[0]) || null;
    if (doc && Number.isFinite(Number(doc.value))) {
      ruleCache.set(ruleKey, { value: Number(doc.value), at: Date.now() });
      return Number(doc.value);
    }
  } catch (_) { /* 集合不存在/未 seed → fallback */ }
  return fallback;
}
async function ensureRulesSeeded() {
  for (const def of PLATFORM_RULE_DEFAULTS) {
    try {
      const r = await gsGet(RULES_COL, def.ruleKey);
      if (r && r.data && r.data[0]) continue;
    } catch (_) { /* 集合不存在 */ }
    const now = Date.now();
    const rule = {
      id: def.ruleKey,
      ruleKey: def.ruleKey,
      value: def.value,
      description: def.description,
      pendingValue: null, proposedBy: null, proposedAt: null, effectiveAt: null,
      cooldownMs: RULE_COOLDOWN_MS, version: 1,
      history: [CE.appendEvent([], { at: now, type: 'registered', actorId: 'system', payload: { ruleKey: def.ruleKey, value: def.value, source: 'PLATFORM_RULE_DEFAULTS seed' } })],
    };
    await gsUpsert(RULES_COL, def.ruleKey, rule);
  }
}

// 活动中心种子数据（与前端 src/activity/seed/defaultActivities.ts 保持一致）
const DEFAULT_ACTIVITIES_SEED = [
  { id: 'activity-1001', type: 'daily_checkin', title: '每日签到', description: '每天登录签到即可领取游戏币，连续签到第 7 天有大奖！', icon: 'gift', status: 'active', conditions: { event: 'daily.login', target: 1 }, rewards: [{ kind: 'gameCoins', amount: 10 }, { kind: 'gameCoins', amount: 10 }, { kind: 'gameCoins', amount: 15 }, { kind: 'gameCoins', amount: 15 }, { kind: 'gameCoins', amount: 20 }, { kind: 'gameCoins', amount: 20 }, { kind: 'gameCoins', amount: 50 }] },
  { id: 'activity-2001', type: 'onboarding', title: '首次发布游戏', description: '完成你的第一个游戏发布，奖励 100 游戏币。', icon: 'rocket', status: 'active', conditions: { event: 'game.published', target: 1 }, rewards: [{ kind: 'gameCoins', amount: 100 }] },
  { id: 'activity-2002', type: 'onboarding', title: '参与首次投票', description: '在任意提案中投出你的第一票，奖励 50 游戏币。', icon: 'vote', status: 'active', conditions: { event: 'vote.cast', target: 1 }, rewards: [{ kind: 'gameCoins', amount: 50 }] },
  { id: 'activity-2003', type: 'growth', title: '畅玩游戏', description: '累计游玩 3 局游戏，奖励 30 游戏币。', icon: 'gamepad', status: 'active', conditions: { event: 'game.played', target: 3 }, rewards: [{ kind: 'gameCoins', amount: 30 }] },
  { id: 'activity-2004', type: 'growth', title: '发布达人', description: '累计发布 3 款游戏，奖励 200 游戏币。', icon: 'trophy', status: 'active', conditions: { event: 'game.published', target: 3 }, rewards: [{ kind: 'gameCoins', amount: 200 }] },
  { id: 'activity-3001', type: 'invite', title: '邀请好友得游戏币', description: '分享专属邀请链接，每成功邀请 1 位好友注册得 20 游戏币。', icon: 'users', status: 'active', conditions: { event: 'user.registered', target: 999 }, invite: { rewardPerInvitee: { kind: 'gameCoins', amount: 20 } }, rewards: [{ kind: 'gameCoins', amount: 20 }] },
  { id: 'activity-4001', type: 'achievement', title: '活跃玩家', description: '累计游玩 10 局游戏，解锁成就奖励 200 游戏币。', icon: 'star', status: 'active', conditions: { event: 'game.played', target: 10 }, rewards: [{ kind: 'gameCoins', amount: 200 }] },
  { id: 'activity-5001', type: 'limited_event', title: '登录有礼', description: '活动期间每日登录即可领取 15 游戏币（限时 7 天）。', icon: 'calendar', status: 'active', startTime: Date.now(), endTime: Date.now() + 7 * 24 * 60 * 60 * 1000, conditions: { event: 'daily.login', target: 1 }, rewards: [{ kind: 'gameCoins', amount: 15 }] },
  { id: 'activity-6001', type: 'lottery', title: '幸运大转盘', description: '每次抽奖消耗 10 游戏币，有机会赢取 500 游戏币大奖！', icon: 'dice', status: 'active', conditions: { event: 'daily.login', target: 1 }, lottery: { cost: 10, prizes: [{ reward: { kind: 'gameCoins', amount: 500 }, weight: 1, label: '500 游戏币' }, { reward: { kind: 'gameCoins', amount: 100 }, weight: 5, label: '100 游戏币' }, { reward: { kind: 'gameCoins', amount: 50 }, weight: 14, label: '50 游戏币' }, { reward: { kind: 'gameCoins', amount: 20 }, weight: 30, label: '20 游戏币' }, { reward: { kind: 'gameCoins', amount: 10 }, weight: 50, label: '10 游戏币' }] }, rewards: [{ kind: 'gameCoins', amount: 10 }] },
];

// ----------------------------------------------------------
// 工具函数
// ----------------------------------------------------------

function buildResponse(statusCode, obj, extraHeaders) {
  return {
    statusCode,
    headers: Object.assign(
      {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization',
      },
      extraHeaders || {}
    ),
    body: JSON.stringify(obj),
  };
}

function getCollection() {
  return db.collection(COLLECTION);
}

/**
 * 合并 upsert：按字段 `id` 合并更新（保留文档中已有字段，如 cloudFileManifest /
 * entryHtmlContent），若文档不存在则创建。
 *
 * 关键：发布流程中「整份游戏元数据（POST）」与「文件清单/入口 HTML（回写）」是并发写入的，
 * 若用 .doc().set() 整份覆盖，后到的一方会抹掉先到一方写入的字段。改用合并语义可避免丢字段。
 */
async function upsertMerge(id, data) {
  const payload = Object.assign({}, data);
  delete payload.id;
  delete payload._id;
  // 先尝试合并更新（仅覆盖 payload 中出现的字段，保留其余已有字段）
  const res = await getCollection().where({ id }).update(payload);
  if (res && res.updated > 0) {
    return { created: false, updated: res.updated };
  }
  // 文档尚不存在（POST 尚未落库的竞态）→ 创建，保留主键字段 id
  await getCollection().doc(id).set(Object.assign({ id }, payload));
  return { created: true, updated: 1 };
}

// 首次访问时若集合不存在则自动创建（仅管理员 SDK 可建集合）
async function ensureCollection() {
  try {
    await getCollection().limit(1).get();
  } catch (e) {
    const msg = (e && e.message) || '';
    if (
      msg.indexOf('not exist') >= 0 ||
      msg.indexOf('不存在') >= 0 ||
      msg.indexOf('DATABASE_COLLECTION_NOT_EXIST') >= 0
    ) {
      try {
        await db.createCollection(COLLECTION);
      } catch (_) {
        // 可能并发已创建，忽略
      }
    } else {
      throw e;
    }
  }
}

// 从 event.path 解析子路径（兼容「保留前缀」与「访问服务已剥离前缀」两种情况）
function parseSubPath(path) {
  let p = path || '/';
  p = p.replace(/^\/api\/v1\/games/, '');
  // ⚠️ 剥离 query（方案 A 的 ?ext=<submissionId>），否则 segments/filePath 会被查询串污染
  const qi = p.indexOf('?');
  if (qi >= 0) p = p.slice(0, qi);
  if (!p) p = '/';
  const segments = p.split('/').filter(Boolean); // [] => 列表, [id] => 详情
  return segments;
}

// ----------------------------------------------------------
// 审核机制（与本地 src/server/routes/gameReview.ts 对齐）
// 状态机：submit→pending→approved/rejected/changes_required；takedown→removed；缺省=approved（旧数据兼容）
// 审核字段（reviewStatus/reviewRecords/submittedAt/reviewedAt/reviewedBy）只能经 __review 变更
// ----------------------------------------------------------

// 人工审核四大硬性条件（通过 approve 强制四项全过；双维护：前端 gameReviewService.ts）
const REVIEW_CHECKLIST_TEMPLATE = [
  { key: 'content_compliance', label: '内容合规性', description: '无违法、违规、侵权内容（无色情低俗、暴力血腥、赌博、政治敏感、盗版侵权素材等）' },
  { key: 'stability', label: '运行稳定性', description: '游戏可正常启动与运行，无严重崩溃、卡死、白屏等影响体验的问题' },
  { key: 'info_completeness', label: '基础信息完整性', description: '名称、简介、封面、分类等必填项齐全，入口文件配置正确' },
  { key: 'security', label: '用户交互与安全性', description: '无恶意代码、无诱导支付或变相收费、无隐私窃取行为' },
];

// 审核管理员账号（环境变量可覆盖；线上请在云函数配置中设置 REVIEW_ADMIN_USER / REVIEW_ADMIN_PASS）
const REVIEW_ADMIN_USER = process.env.REVIEW_ADMIN_USER || 'admin';
const REVIEW_ADMIN_PASS = process.env.REVIEW_ADMIN_PASS || 'admin123';

function isPubliclyVisible(game) {
  const s = game && game.reviewStatus;
  return s === undefined || s === null || s === '' || s === 'approved';
}

/** 读取 query 开关参数（all=1 / all=true） */
function reviewQueryFlag(event, key) {
  const q = Object.assign(
    {},
    parseQuery(event.path || ''),
    event.queryStringParameters || {},
    event.queryString ? parseQuery('?' + event.queryString) : {}
  );
  const v = q[key];
  return v === '1' || v === 'true';
}

/**
 * 发布写数据的审核字段保护：剥离发布方携带的审核状态/记录（只能经 __review 变更）。
 * upsertMerge 为字段级合并，payload 不含审核字段时不会覆盖库中原值 → 天然防洗白；
 * 新建游戏的「默认 pending」在 POST / 处理器中补充。
 */
function stripReviewFields(data) {
  if (!data || typeof data !== 'object') return data;
  const { reviewStatus, reviewRecords, submittedAt, reviewedAt, reviewedBy } = data;
  if (reviewStatus && reviewStatus !== 'approved') {
    console.warn('[games] 拦截发布数据中非法携带的审核状态:', reviewStatus, 'gameId=', data.id);
  }
  const rest = Object.assign({}, data);
  delete rest.reviewStatus;
  delete rest.reviewRecords;
  delete rest.submittedAt;
  delete rest.reviewedAt;
  delete rest.reviewedBy;
  return rest;
}

// ---- JWT（复用 dev-token 的 HMAC-SHA256 方案，同一 secret 体系） ----

function base64urlEncode(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

function signJwt(payloadObj, secret) {
  const crypto = require('crypto');
  const header = base64urlEncode({ alg: 'HS256', typ: 'JWT' });
  const body = base64urlEncode(payloadObj);
  const signature = crypto.createHmac('sha256', secret).update(header + '.' + body).digest('base64url');
  return header + '.' + body + '.' + signature;
}

function verifyJwt(token, secret) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return null;
    const crypto = require('crypto');
    const expected = crypto.createHmac('sha256', secret).update(parts[0] + '.' + parts[1]).digest('base64url');
    if (expected !== parts[2]) return null;
    const payloadObj = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (payloadObj.exp && Math.floor(Date.now() / 1000) >= payloadObj.exp) return null;
    return payloadObj;
  } catch (_) {
    return null;
  }
}

const REVIEW_JWT_SECRET = process.env.JWT_SECRET || 'allinone-platform-2026';

/** 从 event.headers 解析 Authorization Bearer（兼容大小写与数组形式） */
function extractAuth(event) {
  const headers = (event && event.headers) || {};
  let authz = headers.authorization || headers.Authorization || '';
  if (Array.isArray(authz)) authz = authz[0] || '';
  if (typeof authz === 'string' && authz.startsWith('Bearer ')) {
    const payloadObj = verifyJwt(authz.slice(7), REVIEW_JWT_SECRET);
    if (payloadObj) return { userId: payloadObj.userId, role: payloadObj.role };
  }
  return {};
}

function authIsAdmin(auth) {
  return auth.role === 'admin' || auth.role === 'platform';
}

/** 校验管理员；失败时返回错误响应对象，通过时返回 null（调用方判空放行） */
function requireAdmin(event) {
  const auth = extractAuth(event);
  if (!auth.userId) {
    return buildResponse(401, { success: false, error: '未登录，请先使用管理员账号登录审核后台' });
  }
  if (!authIsAdmin(auth)) {
    return buildResponse(403, { success: false, error: '权限不足：仅管理员账号可执行审核操作' });
  }
  return null;
}

function newRecordId() {
  return 'rev-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

// ========== 限时活动 __event（E1-E4）helpers：与本地 src/server/eventEngine.ts 对齐 ==========
const EV_HOUR_MS = 3600000;
const EV_DAY_MS = 86400000;
const EV_ARCHIVE_AFTER_MS = 90 * EV_DAY_MS;

/** 状态机：draft→scheduled→live→closing→settled（纯函数，幂等） */
function evNextStatus(e, now) {
  if (e.status === 'archived' || e.status === 'settled') return null;
  const forceStopped = !e.enabled || Number(e.forceStopAt || 0) > 0;
  if (forceStopped && e.status !== 'closing') return 'closing';
  if (e.status === 'closing') {
    const effectiveEnd = forceStopped ? Math.min(e.endTime, Number(e.forceStopAt || e.endTime)) : e.endTime;
    return now >= effectiveEnd + Number(e.graceHours ?? 72) * EV_HOUR_MS ? 'settled' : null;
  }
  if (forceStopped) return null;
  if (e.status === 'draft') return now >= e.startTime - Number(e.leadHours || 0) * EV_HOUR_MS ? 'scheduled' : null;
  if (e.status === 'scheduled') return now >= e.startTime ? 'live' : null;
  if (e.status === 'live') return now >= e.endTime ? 'closing' : null;
  return null;
}
function evAdvance(e, now) {
  const transitions = [];
  let cur = e.status;
  for (let i = 0; i < 8; i++) {
    const next = evNextStatus(Object.assign({}, e, { status: cur }), now);
    if (!next) break;
    transitions.push(next);
    cur = next;
  }
  return { status: cur, transitions };
}
function evStableHash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}
function evRolloutAllows(e, userId) {
  const r = e.rollout;
  if (!r || r.mode === 'all') return true;
  if (r.mode === 'whitelist') return (r.whitelist || []).indexOf(userId) >= 0;
  const pct = Math.max(0, Math.min(100, Number(r.percent) || 0));
  return evStableHash(e.slug + ':' + userId) % 100 < pct;
}
/** 三重校验：窗口 ∩ 状态 ∩ 开关（参与类接口守卫；前端隐藏不是安全边界） */
function evCheckGate(e, userId, now, phase) {
  if (!e) return { ok: false, code: 404, error: '活动不存在' };
  const payload = { expectedPhase: phase, serverNow: now, startTime: e.startTime, endTime: e.endTime, status: e.status };
  if (!e.enabled || Number(e.forceStopAt || 0) > 0) return { ok: false, code: 403, error: 'EVENT_NOT_ACTIVE', payload };
  if (userId && !evRolloutAllows(e, userId)) return { ok: false, code: 403, error: 'EVENT_NOT_ACTIVE', payload };
  if (!(now >= e.startTime && now < e.endTime + Number(e.graceHours ?? 72) * EV_HOUR_MS)) {
    return { ok: false, code: 403, error: 'EVENT_NOT_ACTIVE', payload };
  }
  if (phase === 'live') {
    if (e.status !== 'live' || now >= e.endTime) return { ok: false, code: 403, error: 'EVENT_NOT_ACTIVE', payload };
  } else if (e.status !== 'live' && e.status !== 'closing') {
    return { ok: false, code: 403, error: 'EVENT_NOT_ACTIVE', payload };
  }
  return { ok: true };
}
function evDayKey(now) {
  const d = new Date(now);
  return d.getUTCFullYear() + '-' + (d.getUTCMonth() + 1) + '-' + d.getUTCDate();
}
function evDefaultMetric(e) {
  return (e.config && e.config.metric) || (e.type === 'collect' ? 'freon' : e.type === 'game' ? 'score' : 'stage_contrib');
}
function evCurrentStage(e, now) {
  const stages = (e.config && e.config.stages) || [];
  for (let i = 0; i < stages.length; i++) {
    if (now >= stages[i].startTime && now < stages[i].endTime) return stages[i];
  }
  return null;
}
function evLeaderboard(parts, metric, limit) {
  return parts
    .map(function (p) { return { userId: p.userId, value: (p.metrics && p.metrics[metric]) || 0 }; })
    .filter(function (x) { return x.value > 0; })
    .sort(function (a, b) { return b.value - a.value || (a.userId < b.userId ? -1 : 1); })
    .slice(0, limit || 50);
}
function evSettlementGrants(e, parts) {
  const metric = (e.config && e.config.leaderboardMetric) || evDefaultMetric(e);
  const board = evLeaderboard(parts, metric, 1000);
  const grants = [];
  (e.rewardRules || []).forEach(function (r) {
    if (r.kind !== 'leaderboard' || !r.rankRange) return;
    for (let i = r.rankRange[0]; i <= Math.min(r.rankRange[1], board.length - 1); i++) {
      grants.push({ userId: board[i].userId, rewardId: r.id, amount: r.reward.amount });
    }
  });
  return grants;
}
function evGrantId(eventId, userId, rewardId) {
  return 'grant_' + eventId + '_' + userId + '_' + rewardId;
}
/** 分页取全量集合（铁律：不 limit(500) 截断） */
async function evListAll(col, where) {
  const all = [];
  for (let page = 0; page < 100; page++) {
    let q = db.collection(col).skip(page * 200).limit(200);
    if (where) q = q.where(where);
    const r = await q.get();
    const rows = (r && r.data) || [];
    all.push.apply(all, rows);
    if (rows.length < 200) break;
  }
  return all;
}
/** 云端 gamecoin 入账（幂等由 event_grants 先行落库保证） */
async function evCreditGameCoins(userId, amount, reason) {
  const now = Date.now();
  const ures = await db.collection('users').where({ _openid: userId }).limit(1).get();
  const u = (ures && ures.data && ures.data[0]) || null;
  if (u && u._id) {
    const next = (u.gameCoins || 0) + amount;
    await db.collection('users').doc(String(u._id)).update({ gameCoins: next, updatedAt: now });
    return next;
  }
  await db.collection('users').add({ _openid: userId, gameCoins: amount, instantVouchers: 0, algorithmVouchers: 0, createdAt: now, updatedAt: now });
  return amount;
}
/** 结算：leaderboard 型奖励批量发放（grant id 幂等）+ manifest（重跑安全） */
async function evSettle(e) {
  if (e.settleManifest) return e;
  const parts = await evListAll('event_participations', { eventId: e._id || e.id });
  const grants = evSettlementGrants(e, parts);
  let granted = 0;
  for (const g of grants) {
    const gid = evGrantId(e._id || e.id, g.userId, g.rewardId);
    try {
      await db.collection('event_grants').doc(gid).create({
        eventId: e._id || e.id, userId: g.userId, rewardId: g.rewardId,
        amount: g.amount, grantedAt: Date.now(), source: 'settle_job',
      });
      granted++;
      try { await evCreditGameCoins(g.userId, g.amount, '限时活动结算 ' + (e.name || '')); } catch (err) {
        console.error('[event] 结算入账失败（需人工介入）', e._id || e.id, g.userId, err && err.message);
      }
    } catch (err) { /* 已存在 = 已发放，幂等跳过 */ }
  }
  const manifest = { grants: granted, settledAt: Date.now(), hash: String(granted) + '_' + grants.length };
  return Object.assign({}, e, { settleManifest: manifest, updatedAt: Date.now() });
}
/** 周期克隆（时间平移一个 unit；阶段同步平移） */
function evCloneNext(e, seq) {
  const unit = (e.repeat && e.repeat.unit) || 'weekly';
  const span = e.endTime - e.startTime;
  let start;
  if (unit === 'monthly') {
    const d = new Date(e.startTime);
    const day = d.getDate();
    d.setMonth(d.getMonth() + 1);
    if (d.getDate() !== day) d.setDate(0);
    start = d.getTime();
  } else {
    start = e.startTime + (unit === 'biweekly' ? 14 : 7) * EV_DAY_MS;
  }
  const c = JSON.parse(JSON.stringify(e));
  const id = e._id || e.id;
  delete c._id;
  c.id = 'evt_' + e.slug + '_' + (seq + 1);
  c.status = 'draft';
  c.enabled = true;
  delete c.forceStopAt;
  c.settleManifest = null;
  c.startTime = start;
  c.endTime = start + span;
  c.createdAt = Date.now();
  c.updatedAt = Date.now();
  if (c.config && c.config.stages) {
    const delta = start - e.startTime;
    c.config.stages = c.config.stages.map(function (s) {
      return Object.assign({}, s, { startTime: s.startTime + delta, endTime: s.endTime + delta });
    });
  }
  void id;
  return c;
}
/** tick：状态迁移 + closing 结算 + 周期克隆 + 归档标记 + staged 达标检查（幂等） */
async function eventTickCloud() {
  const now = Date.now();
  const events = await evListAll('limited_events');
  const result = { transitions: 0, settled: 0, cloned: 0, archived: 0 };
  for (const raw of events) {
    const e = Object.assign({}, raw, { id: raw.id || raw._id });
    const adv = evAdvance(e, now);
    let updated = Object.assign({}, e, { status: adv.status, updatedAt: now });
    if (adv.transitions.length > 0) result.transitions += adv.transitions.length;
    if (adv.transitions.indexOf('closing') >= 0) {
      updated = await evSettle(updated);
      result.settled++;
      if (updated.repeat && !updated.forceStopAt) {
        // 期号 = 该 slug 现存期总数（含本期与已归档）+1
        const total = events.filter(function (x) { return x.slug === e.slug; }).length + result.cloned;
        if (!updated.repeat.count || total < updated.repeat.count) {
          const next = evCloneNext(updated, total);
          try {
            const dup = await db.collection('limited_events').doc(next.id).get().catch(function () { return null; });
            if (!dup) {
              await db.collection('limited_events').doc(next.id).create(next);
              result.cloned++;
            }
          } catch (err) { /* 已存在跳过 */ }
        }
      }
    }
    if (adv.status === 'settled' && now >= Number(updated.updatedAt || 0) + EV_ARCHIVE_AFTER_MS) {
      updated = Object.assign({}, updated, { status: 'archived' });
      result.archived++;
    }
    if (adv.transitions.length > 0 || updated.status !== raw.status || updated.settleManifest !== raw.settleManifest) {
      await gsUpsert('limited_events', e.id, updated);
    }
  }
  return result;
}

/** 读取游戏文件的文本内容（game_files 集合，供恶意代码扫描） */
async function loadGameFileContents(gameId) {
  try {
    const res = await db.collection('game_files').doc(String(gameId)).get();
    const docData = (res && res.data && res.data[0]) || res.data || null;
    const files = (docData && docData.files) || [];
    return files.filter((f) => f && typeof f.content === 'string').map((f) => ({ path: f.path, content: f.content }));
  } catch (_) {
    return [];
  }
}

/** 自动预检（提交审核时执行，结果存入 submit 记录，供管理员人工复核参考） */
async function runAutomatedChecks(game) {
  const checks = [];

  // ① 基础信息完整性
  const infoProblems = [];
  if (!game.name || String(game.name).trim().length < 2) infoProblems.push('游戏名称缺失或少于 2 个字符');
  if (!game.summary && !game.description) infoProblems.push('游戏简介/描述缺失');
  if (!game.coverImage && !game.icon) infoProblems.push('游戏封面/图标缺失');
  if (!game.framework) infoProblems.push('游戏分类（framework）缺失');
  if (!game.entryPoint) infoProblems.push('入口文件（entryPoint）未配置');
  checks.push({
    key: 'auto_info_completeness',
    label: '基础信息完整性预检',
    passed: infoProblems.length === 0,
    severity: 'warning',
    note: infoProblems.length ? infoProblems.join('；') : '名称/简介/封面/分类/入口文件均已配置',
  });

  // ② 文件健康度（cloudFileManifest 元数据）
  try {
    const manifest = (game && Array.isArray(game.cloudFileManifest)) ? game.cloudFileManifest : [];
    const fileProblems = [];
    if (game.hostingType !== 'external' && manifest.length === 0) {
      fileProblems.push('未发现已上传文件清单（server/inline 托管模式必须有文件）');
    }
    if (game.hostingType !== 'external' && manifest.length > 0) {
      const entry = game.entryPoint || 'index.html';
      const hasEntry = manifest.some((m) => (m.fileName || m.path) === entry) || manifest.some((m) => /\.html?$/i.test(m.fileName || m.path || ''));
      if (!hasEntry) fileProblems.push('文件清单中未找到入口 HTML 文件');
    }
    checks.push({
      key: 'auto_files_health',
      label: '游戏文件健康度预检',
      passed: fileProblems.length === 0,
      severity: 'warning',
      note: fileProblems.length ? fileProblems.join('；') : ('文件清单 ' + manifest.length + ' 项（云存储托管）'),
    });
  } catch (e) {
    checks.push({ key: 'auto_files_health', label: '游戏文件健康度预检', passed: true, severity: 'info', note: '文件清单读取失败，跳过该预检' });
  }

  // ③ 恶意代码特征扫描（game_files 文本内容；命中仅警告，供人工复核）
  try {
    const fileContents = await loadGameFileContents(game.id);
    const suspicious = [
      { re: /eval\s*\(\s*atob\s*\(/i, label: 'eval(atob(...)) 动态解码执行代码' },
      { re: /new\s+Function\s*\(\s*atob\s*\(/i, label: 'new Function(atob(...)) 动态解码执行代码' },
      { re: /coinhive|cryptonight|deepminer|minerocean/i, label: '疑似浏览器挖矿脚本特征' },
      { re: /document\.cookie[\s\S]{0,160}?(fetch\s*\(|XMLHttpRequest|sendBeacon)/i, label: '读取 Cookie 并外传（疑似隐私窃取）' },
      { re: /(扫码支付|微信转账|支付宝转账|充值联系|加.{0,6}微信.{0,10}(充值|代充|退款))/i, label: '疑似诱导站外支付话术' },
    ];
    const hits = [];
    for (const f of fileContents.slice(0, 60)) {
      for (const sp of suspicious) {
        if (sp.re.test(f.content)) hits.push(f.path + ': ' + sp.label);
      }
    }
    checks.push({
      key: 'auto_code_safety',
      label: '恶意代码特征扫描（自动）',
      passed: hits.length === 0,
      severity: hits.length ? 'warning' : 'info',
      note: hits.length
        ? (hits.length + ' 处可疑特征（仅供人工复核，不自动拦截）：\n' + hits.slice(0, 10).join('\n'))
        : ('已扫描 ' + fileContents.length + ' 个文本文件，未发现可疑特征'),
    });
  } catch (e) {
    checks.push({ key: 'auto_code_safety', label: '恶意代码特征扫描（自动）', passed: true, severity: 'info', note: '扫描执行失败，请管理员人工检查' });
  }

  return checks;
}

// 活动中心路径解析：/api/v1/activities(/:activityId/claim|/leaderboard)
function parseActivitySubPath(path) {
  let p = path || '/';
  p = p.replace(/^\/api\/v1\/activities/, '');
  if (!p) p = '/';
  const segments = p.split('/').filter(Boolean); // [] => 列表, ['leaderboard'] => 排行, [id,'claim'] => 领奖上报
  return segments;
}

function parseQuery(path) {
  const q = {};
  const idx = (path || '').indexOf('?');
  if (idx < 0) return q;
  const search = path.slice(idx + 1);
  for (const pair of search.split('&')) {
    if (!pair) continue;
    const [k, v] = pair.split('=');
    q[decodeURIComponent(k)] = decodeURIComponent(v || '');
  }
  return q;
}

// ----------------------------------------------------------
// MIME 类型映射
// ----------------------------------------------------------

const MIME_MAP = {
  '.html': 'text/html; charset=utf-8',
  '.htm':  'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml':  'application/xml; charset=utf-8',
  '.md':   'text/markdown; charset=utf-8',
  '.txt':  'text/plain; charset=utf-8',
  '.csv':  'text/csv; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.bmp':  'image/bmp',
  '.svg':  'image/svg+xml; charset=utf-8',
  '.ico':  'image/x-icon',
  '.wav':  'audio/wav',
  '.mp3':  'audio/mpeg',
  '.ogg':  'audio/ogg',
  '.m4a':  'audio/mp4',
  '.flac': 'audio/flac',
  '.webm': 'video/webm',
  '.mp4':  'video/mp4',
  '.woff':  'font/woff',
  '.woff2': 'font/woff2',
  '.ttf':  'font/ttf',
  '.otf':  'font/otf',
  '.eot':  'font/eot',
  '.bin':  'application/octet-stream',
  '.dat':  'application/octet-stream',
  '.con':  'text/plain; charset=utf-8',
  '.cfg':  'text/plain; charset=utf-8',
  '.ini':  'text/plain; charset=utf-8',
  '.zip':  'application/zip',
  '.gz':   'application/gzip',
  '.pdf':  'application/pdf',
  '.swf':  'application/x-shockwave-flash',
};

function getMimeType(fileName) {
  const ext = (fileName.match(/\.\w+$/) || [''])[0].toLowerCase();
  return MIME_MAP[ext] || 'application/octet-stream';
}

// ----------------------------------------------------------
// HTTPS fetch 工具（从临时 URL 下载文件内容）
// ----------------------------------------------------------

const https = require('https');
const http  = require('http');

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // 跟随一次重定向
        fetchUrl(res.headers.location).then(resolve, reject);
        res.resume();
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error('HTTP ' + res.statusCode));
        return;
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// ----------------------------------------------------------
// 文件服务路由辅助函数
// ----------------------------------------------------------

/**
 * 从 DB 查询游戏文档并返回 cloudFileManifest。
 * 若游戏不存在或无 manifest，返回 null。
 */
async function getGameManifest(gameId) {
  const res = await getCollection().where({ id: gameId }).limit(1).get();
  if (!res.data || res.data.length === 0) return null;
  const doc = res.data[0];
  return doc.cloudFileManifest || null;
}

/**
 * 在 manifest 中按 fileName 查找 cloudFileID。
 * 匹配策略（按优先级）：
 * 1. 精确匹配：fileName === filePath
 * 2. 后缀匹配：fileName.endsWith('/' + filePath)（处理 games/gameId/ 前缀）
 * 3. 渐进式路径剥离：从 filePath 逐层去掉目录前缀，尝试匹配 fileName
 *    例如 filePath='lf2-flat5/index.html' → 依次尝试 'index.html'
 *    例如 filePath='lf2-flat5/core/animator.js' → 依次尝试 'core/animator.js', 'animator.js'
 */
function findCloudFileID(manifest, filePath) {
  // 1. 精确匹配
  const exact = manifest.find(m => m.fileName === filePath);
  if (exact) return exact.cloudFileID;

  // 2. 后缀匹配（处理 games/gameId/ 前缀）
  const suffix = manifest.find(m => m.fileName.endsWith('/' + filePath));
  if (suffix) return suffix.cloudFileID;

  // 3. 渐进式路径剥离：从 filePath 逐层去掉目录前缀
  let parts = filePath.split('/');
  while (parts.length > 1) {
    parts = parts.slice(1); // 去掉最前面的目录
    const stripped = parts.join('/');
    const match = manifest.find(m => m.fileName === stripped);
    if (match) return match.cloudFileID;
    // 也尝试后缀匹配
    const suffixMatch = manifest.find(m => m.fileName.endsWith('/' + stripped));
    if (suffixMatch) return suffixMatch.cloudFileID;
  }

  return null;
}

/**
 * 用 getTempFileURL 生成临时下载链接并获取文件内容。
 */
async function fetchCloudFile(cloudFileID) {
  const urlResult = await app.getTempFileURL({ fileList: [cloudFileID] });
  if (!urlResult || !urlResult.fileList || urlResult.fileList.length === 0) {
    throw new Error('getTempFileURL returned empty');
  }
  const item = urlResult.fileList[0];
  if (item.code !== 'SUCCESS' && item.status !== 0 && item.code !== 0) {
    throw new Error('getTempFileURL error: ' + (item.message || item.code));
  }
  const tempUrl = item.tempFileURL || item.download_url;
  if (!tempUrl) throw new Error('no temp URL returned');

  const content = await fetchUrl(tempUrl);
  return content;
}

/**
 * 构建文件响应（支持文本和二进制内容）。
 * 云函数 HTTP 响应 body 为 string，二进制需 base64 编码 + isBase64Encoded=true。
 */
function buildFileResponse(statusCode, contentBuffer, mimeType, extraHeaders) {
  // 判断是否需要 base64 编码（二进制内容如图片、音频等）
  const isText = mimeType.startsWith('text/') ||
                 mimeType.startsWith('application/json') ||
                 mimeType.startsWith('application/xml') ||
                 mimeType.startsWith('image/svg+xml') ||
                 (mimeType.startsWith('font/') &&
                 !mimeType.includes('application/octet-stream'));

  const body = isText
    ? contentBuffer.toString('utf8')
    : contentBuffer.toString('base64');

  // 调试日志：记录返回内容的类型和前100字符
  console.log('[gamesApi] buildFileResponse:', {
    mimeType,
    isText,
    bodyType: typeof body,
    bodyLength: body.length,
    bodyPreview: body.substring(0, 100),
    isBase64Encoded: !isText,
  });

  return {
    statusCode,
    headers: Object.assign(
      {
        'Content-Type': mimeType,
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization',
        'Cache-Control': 'public, max-age=3600',
      },
      extraHeaders || {}
    ),
    body,
    isBase64Encoded: !isText,
  };
}

// ----------------------------------------------------------
// 主入口（事件型 HTTP 函数）
// ----------------------------------------------------------

// ----------------------------------------------------------
// 游戏内服务隧道处理器（publishing-center standard-sdk）
// 前端 /api/<feature> → 隧道化 /api/v1/games/__<feature>
// 各 feature 用独立集合，与平台核心资金集合解耦。
// ----------------------------------------------------------

function getUserIdFromPayload(p) {
  return (p && (p.userId || p.user_id || p.playerId)) || 'anonymous';
}

// 从 Authorization: Bearer <jwt> 解析 userId。
// dev-token 签发时已把 userId 编码进 JWT payload，前端各游戏内服务请求只带 token、
// 不在 body 里传 userId，因此必须从 token 解析身份，否则所有玩家都会落到 'anonymous' 串号。
function getUserIdFromAuth(authorization) {
  if (!authorization) return null;
  const m = String(authorization).match(/Bearer\s+(.+)/i);
  if (!m) return null;
  const parts = m[1].split('.');
  if (parts.length < 2) return null;
  try {
    const json = Buffer.from(parts[1], 'base64url').toString('utf-8');
    const payload = JSON.parse(json);
    return payload.userId || null;
  } catch (e) {
    return null;
  }
}

// 优先从 token 解析 userId，回退到请求体；二者皆无则 'anonymous'
function resolveUserId(authorization, body) {
  const fromAuth = getUserIdFromAuth(authorization);
  if (fromAuth) return fromAuth;
  const fromBody = getUserIdFromPayload(body);
  return fromBody || 'anonymous';
}

// 游戏内服务涉及的所有集合，冷启动时一次性预热创建（CloudBase 集合创建为异步，
// 需等待就绪后再写入，否则首次写会报 COLLECTION_NOT_EXIST）。
const GAME_SVC_COLLECTIONS = [
  'game_cloudsaves', 'game_inventories', 'game_leaderboards', 'game_achievements',
  'game_analytics', 'game_wallets', 'game_auth_users', 'store_products',
  'game_store_orders', 'game_developer_accounts', 'game_developer_transactions',
  'quests', 'quest_claims', 'quest_submissions', 'quest_mods',
  'limited_events', 'event_participations', 'event_grants', 'event_stage_progress',
];

let collectionsWarmed = false;
async function warmupGameSvcCollections() {
  if (collectionsWarmed) return;
  collectionsWarmed = true;
  for (const col of GAME_SVC_COLLECTIONS) {
    try {
      await db.createCollection(col);
    } catch (e) { /* 已存在或受限，忽略 */ }
    // 等待集合异步就绪
    await new Promise(r => setTimeout(r, 300));
  }
}

function gsGet(col, id) {
  try {
    return db.collection(col).doc(String(id)).get();
  } catch (e) {
    // 集合不存在时返回空，调用方按"无文档"处理
    return { data: [] };
  }
}
const createdCollections = {};
async function ensureCollection(col) {
  if (createdCollections[col]) return;
  try {
    await db.createCollection(col);
  } catch (e) {
    // 已存在或权限限制：createCollection 可能静默失败，set 时若仍不存在会报错并由调用方重试
  }
  createdCollections[col] = true;
}
async function gsUpsert(col, id, data) {
  const doc = Object.assign({}, data);
  delete doc._id;
  delete doc.id;
  const setDoc = () => db.collection(col).doc(String(id)).set(doc);
  try {
    await setDoc();
  } catch (e) {
    const msg = (e && e.message) || '';
    if (msg.indexOf('not exist') >= 0 || msg.indexOf('不存在') >= 0 || msg.indexOf('COLLECTION_NOT_EXIST') >= 0) {
      await ensureCollection(col);
      // 集合异步就绪：重试若干次，间隔等待
      for (let i = 0; i < 3; i++) {
        try {
          await new Promise(r => setTimeout(r, 600));
          await setDoc();
          return doc;
        } catch (e2) {
          const m2 = (e2 && e2.message) || '';
          if (i === 2 || !(m2.indexOf('not exist') >= 0 || m2.indexOf('不存在') >= 0 || m2.indexOf('COLLECTION_NOT_EXIST') >= 0)) {
            throw e2;
          }
        }
      }
    } else {
      throw e;
    }
  }
  return doc;
}
async function gsAppend(col, doc) {
  const d = Object.assign({}, doc);
  delete d._id;
  delete d.id;
  try {
    return await db.collection(col).add(d);
  } catch (e) {
    const msg = (e && e.message) || '';
    if (msg.indexOf('not exist') >= 0 || msg.indexOf('不存在') >= 0 || msg.indexOf('COLLECTION_NOT_EXIST') >= 0) {
      await ensureCollection(col);
      for (let i = 0; i < 3; i++) {
        try {
          await new Promise(r => setTimeout(r, 600));
          return await db.collection(col).add(d);
        } catch (e2) {
          const m2 = (e2 && e2.message) || '';
          if (i === 2 || !(m2.indexOf('not exist') >= 0 || m2.indexOf('不存在') >= 0 || m2.indexOf('COLLECTION_NOT_EXIST') >= 0)) {
            return null;
          }
        }
      }
    }
    return null;
  }
}

// ----------------------------------------------------------
// 数据分析（__analytics）事件加载与聚合
// 镜像本地 src/server/analytics/analyticsStore.ts 的聚合口径，
// 供平台数据中心 /platform-data-center 在线上（云函数模式）取数。
// ----------------------------------------------------------
async function loadAnalyticsEvents(col) {
  const PAGE = 200;
  const MAX_PAGES = 50; // 防御性上限：最多 1 万条事件
  const all = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await db.collection(col).skip(page * PAGE).limit(PAGE).get();
    const rows = (res && res.data) || [];
    all.push(...rows);
    if (rows.length < PAGE) break;
  }
  // 仅保留合法事件（与本地 addEvents 校验一致），旧桩写入的脏数据（如 type:'play' 无 timestamp）直接滤除
  return all
    .filter(e => e && e.type && Number(e.timestamp) > 0)
    .map(e => Object.assign({}, e, { timestamp: Number(e.timestamp) }));
}

function aYmd(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

function aIsGameCoin(cur) {
  const c = String(cur || 'A币').toLowerCase();
  return c.includes('game') || c.includes('游戏币') || c === 'gc';
}

function aRevenue(evs) {
  let revA = 0, revG = 0;
  for (const e of evs) {
    if (e.type !== 'voucher_tx' && e.type !== 'market_tx') continue;
    const payload = e.payload || {};
    const amt = Number(payload.amount) || 0;
    if (aIsGameCoin(payload.currency)) revG += amt;
    else revA += amt;
  }
  return { revA: Math.round(revA * 100) / 100, revG: Math.round(revG * 100) / 100 };
}

function aggOverview(events) {
  const now = Date.now();
  const day30 = now - 30 * 86400000;
  const today = aYmd(now);
  const dauUsers = new Set(events.filter(e => e.date === today).map(e => e.userId || 'anon'));
  const mauUsers = new Set(events.filter(e => e.timestamp >= day30).map(e => e.userId || 'anon'));
  const allUsers = new Set(events.map(e => e.userId || 'anon'));
  const gamePlays = events.filter(e => e.type === 'game_launch').length;
  const ends = events.filter(e => e.type === 'session_end' && e.timestamp >= day30);
  const avgSessionMs = ends.length > 0
    ? Math.round(ends.reduce((s, e) => s + (Number((e.payload || {}).durationMs) || 0), 0) / ends.length)
    : 0;
  const rev = aRevenue(events);
  return {
    dau: dauUsers.size,
    mau: mauUsers.size,
    totalPlayers: allUsers.size,
    totalGamePlays: gamePlays,
    avgSessionMs,
    totalRevenueACoins: rev.revA,
    totalRevenueGameCoins: rev.revG,
    generatedAt: now,
  };
}

function aggTrends(events, days) {
  const now = Date.now();
  const points = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = aYmd(now - i * 86400000);
    const dayEvents = events.filter(e => e.date === d);
    const rev = aRevenue(dayEvents);
    points.push({
      date: d,
      dau: new Set(dayEvents.map(e => e.userId || 'anon')).size,
      gamePlays: dayEvents.filter(e => e.type === 'game_launch').length,
      revenueACoins: rev.revA,
      revenueGameCoins: rev.revG,
    });
  }
  return points;
}

function aggByGame(events) {
  const map = new Map();
  for (const e of events) {
    const gid = e.gameId;
    if (!gid) continue;
    if (!map.has(gid)) map.set(gid, []);
    map.get(gid).push(e);
  }
  const result = [];
  for (const [gameId, evs] of map.entries()) {
    const ends = evs.filter(e => e.type === 'session_end');
    const rev = aRevenue(evs);
    result.push({
      gameId: String(gameId),
      gamePlays: evs.filter(e => e.type === 'game_launch').length,
      uniquePlayers: new Set(evs.map(e => e.userId || 'anon')).size,
      avgSessionMs: ends.length > 0
        ? Math.round(ends.reduce((s, e) => s + (Number((e.payload || {}).durationMs) || 0), 0) / ends.length)
        : 0,
      revenueACoins: rev.revA,
      revenueGameCoins: rev.revG,
    });
  }
  return result.sort((a, b) => b.gamePlays - a.gamePlays);
}

function aggPlayers(events) {
  const now = Date.now();
  const day30 = now - 30 * 86400000;
  const today = aYmd(now);

  const firstSeen = new Map();
  for (const e of events) {
    const u = e.userId || 'anon';
    const ts = Number(e.timestamp) || 0;
    if (!firstSeen.has(u) || ts < firstSeen.get(u)) firstSeen.set(u, ts);
  }

  const dauUsers = events.filter(e => e.date === today).map(e => e.userId || 'anon');
  const dauSet = new Set(dauUsers);
  const mau = new Set(events.filter(e => e.timestamp >= day30).map(e => e.userId || 'anon')).size;

  let newCount = 0, returningCount = 0;
  for (const u of dauSet) {
    if ((firstSeen.get(u) || 0) >= day30) newCount++;
    else returningCount++;
  }

  const byRole = {};
  for (const e of events) {
    const role = (e.payload || {}).role;
    if (role && e.userId) {
      const r = String(role);
      byRole[r] = (byRole[r] || 0) + 1;
    }
  }

  const activityTier = { '高活跃 (≥10次)': 0, '中活跃 (3-9次)': 0, '低活跃/新 (<3次)': 0 };
  const cnt = new Map();
  for (const e of events) {
    if (Number(e.timestamp) < day30) continue;
    const u = e.userId || 'anon';
    cnt.set(u, (cnt.get(u) || 0) + 1);
  }
  for (const c of cnt.values()) {
    if (c >= 10) activityTier['高活跃 (≥10次)']++;
    else if (c >= 3) activityTier['中活跃 (3-9次)']++;
    else activityTier['低活跃/新 (<3次)']++;
  }

  return {
    totalPlayers: firstSeen.size,
    dau: dauSet.size,
    mau,
    newVsReturning: { new: newCount, returning: returningCount },
    byRole,
    byActivityTier: activityTier,
  };
}

const GAME_SERVICE_HANDLERS = {
  // ============ 存档 ============
  async cloudsave(method, seg, body, q, authorization) {
    const col = 'game_cloudsaves';
    const userId = resolveUserId(authorization, body);
    const gameId = body.gameId || q.gameId;
    if (!gameId) return buildResponse(400, { success: false, error: 'missing gameId' });
    if (method === 'POST' && seg[0] === 'save') {
      const slot = body.slot || 'auto';
      const id = `${gameId}::${userId}::${slot}`;
      await gsUpsert(col, id, {
        gameId, userId, slot,
        data: body.data, progress: body.progress, timestamp: Date.now(),
      });
      return buildResponse(200, { success: true, data: { slot, saved: true } });
    }
    if (method === 'GET' && seg[0] === 'load') {
      const slot = q.slot || 'auto';
      const id = `${gameId}::${userId}::${slot}`;
      const res = await gsGet(col, id);
      const doc = res && res.data && res.data[0];
      return buildResponse(200, { success: true, data: doc ? { data: doc.data, progress: doc.progress, timestamp: doc.timestamp } : null });
    }
    if (method === 'GET' && seg[0] === 'slots') {
      const res = await db.collection(col).where({ gameId, userId }).limit(100).get();
      const docs = (res && res.data) || [];
      const slots = docs.map(d => ({ slot: d.slot, timestamp: d.timestamp, hasData: !!d.data }));
      return buildResponse(200, { success: true, data: { slots } });
    }
    if (method === 'POST' && seg[0] === 'delete') {
      const slot = body.slot || 'auto';
      const id = `${gameId}::${userId}::${slot}`;
      await db.collection(col).doc(String(id)).remove().catch(() => {});
      return buildResponse(200, { success: true, data: { deleted: true } });
    }
    if (method === 'GET' && seg[0] === 'sync') {
      const res = await db.collection(col).where({ gameId, userId }).limit(100).get();
      const docs = (res && res.data) || [];
      return buildResponse(200, { success: true, data: { saves: docs } });
    }
    return buildResponse(405, { success: false, error: 'cloudsave method not allowed' });
  },

  // ============ 背包 ============
  async inventory(method, seg, body, q, authorization) {
    const col = 'game_inventories';
    const userId = resolveUserId(authorization, body);
    const gameSource = body.gameSource || body.gameId;
    if (!gameSource) return buildResponse(400, { success: false, error: 'missing gameSource' });
    if (method === 'GET' && seg.length === 0) {
      const id = `${gameSource}::${userId}`;
      const res = await gsGet(col, id);
      const doc = res && res.data && res.data[0];
      return buildResponse(200, {
        success: true,
        data: doc ? (doc.items || []) : [],
      });
    }
    if (method === 'POST' && seg[0] === 'sync') {
      const items = Array.isArray(body.items) ? body.items : [];
      const id = `${gameSource}::${userId}`;
      await gsUpsert(col, id, { gameSource, userId, items, updatedAt: Date.now() });
      return buildResponse(200, { success: true, data: { synced: true, count: items.length } });
    }
    return buildResponse(405, { success: false, error: 'inventory method not allowed' });
  },

  // ============ 排行榜 ============
  async leaderboard(method, seg, body, q, authorization) {
    const col = 'game_leaderboards';
    const leaderboardId = seg[0];
    const gameId = q.gameId || body.gameId;
    if (!gameId) return buildResponse(400, { success: false, error: 'missing gameId' });
    if (method === 'GET' && seg.length === 1) {
      const limit = Math.min(100, parseInt(q.limit || '50', 10) || 50);
      const res = await db.collection(col)
        .where({ gameId, leaderboardId })
        .orderBy('score', 'desc')
        .limit(limit).get();
      return buildResponse(200, { success: true, data: { entries: (res && res.data) || [] } });
    }
    if (method === 'POST' && seg.length === 2 && seg[1] === 'submit') {
      const userId = resolveUserId(authorization, body);
      const entry = {
        gameId, leaderboardId, userId,
        nickname: body.nickname || userId,
        score: Number(body.score) || 0,
        metadata: body.metadata || {},
        submittedAt: Date.now(),
      };
      await gsUpsert(col, `${gameId}::${leaderboardId}::${userId}`, entry);
      return buildResponse(200, { success: true, data: entry });
    }
    if (method === 'GET' && seg.length === 2 && seg[1] === 'rank') {
      const userId = resolveUserId(authorization, body);
      const res = await db.collection(col).where({ gameId, leaderboardId }).orderBy('score', 'desc').limit(1000).get();
      const entries = (res && res.data) || [];
      const idx = entries.findIndex(e => e.userId === userId);
      return buildResponse(200, {
        success: true,
        data: idx >= 0 ? { rank: idx + 1, score: entries[idx].score } : { rank: -1, score: 0 },
      });
    }
    if (method === 'GET' && seg.length === 2 && seg[1] === 'friends') {
      const limit = Math.min(100, parseInt(q.limit || '50', 10) || 50);
      const res = await db.collection(col).where({ gameId, leaderboardId }).orderBy('score', 'desc').limit(limit).get();
      return buildResponse(200, { success: true, data: { entries: (res && res.data) || [] } });
    }
    return buildResponse(405, { success: false, error: 'leaderboard method not allowed' });
  },

  // ============ 成就 ============
  async achievements(method, seg, body, q, authorization) {
    const col = 'game_achievements';
    const userId = resolveUserId(authorization, body);
    const gameId = body.gameId || (body.params && body.params.gameId);
    if (!gameId) return buildResponse(400, { success: false, error: 'missing gameId' });
    if (method === 'GET' && seg.length === 0) {
      const id = `${gameId}::${userId}`;
      const res = await gsGet(col, id);
      const doc = res && res.data && res.data[0];
      return buildResponse(200, { success: true, data: { achievements: doc ? (doc.achievements || []) : [] } });
    }
    if (method === 'POST' && seg[0] === 'unlock') {
      const achievementId = body.achievementId;
      if (!achievementId) return buildResponse(400, { success: false, error: 'missing achievementId' });
      const id = `${gameId}::${userId}`;
      const res = await gsGet(col, id);
      const doc = (res && res.data && res.data[0]) || { achievements: [] };
      const existing = doc.achievements.find(a => a.id === achievementId);
      if (existing) {
        return buildResponse(200, { success: true, data: { alreadyUnlocked: true, achievement: existing } });
      }
      const achievement = {
        id: achievementId,
        name: body.name || achievementId,
        description: body.description || '',
        unlockedAt: Date.now(),
        metadata: body.metadata || {},
      };
      doc.achievements.push(achievement);
      await gsUpsert(col, id, { gameId, userId, achievements: doc.achievements, updatedAt: Date.now() });
      return buildResponse(200, { success: true, data: { unlocked: true, achievement } });
    }
    return buildResponse(405, { success: false, error: 'achievements method not allowed' });
  },

  // ============ 数据分析埋点（与本地 src/server/routes/analytics.ts 对齐）============
  // 修复记录：旧桩任意 GET 一律返回 {events:[...]}（对象），前端数据中心把 by-game
  // 的对象塞进数组状态 → games.map 渲染 TypeError 白屏；且 POST 只认 /track，
  // 前端 tracker 实际发的 /events 全部 405 丢失。现补齐 4 个查询端点 + /events 写入。
  async analytics(method, seg, body, q, authorization, event) {
    const col = 'game_analytics';

    // ----- POST /__analytics/events {events:[...]}（/track 历史兼容）-----
    if (method === 'POST') {
      const list = Array.isArray(body && body.events)
        ? body.events
        : (Array.isArray(body) ? body : [body]);
      let added = 0, ignored = 0;
      for (const ev of list) {
        if (!ev || !ev.type || !ev.timestamp) { ignored++; continue; }
        // 确定性 _id → 覆盖写天然幂等（同 type+timestamp+userId 视为重复，与本地去重口径一致）
        const uid = String(ev.userId || 'anon');
        const id = ('ev_' + String(ev.type) + '_' + Number(ev.timestamp) + '_' + uid)
          .replace(/[^a-zA-Z0-9_-]/g, '_');
        try {
          await gsUpsert(col, id, {
            type: String(ev.type),
            userId: uid,
            gameId: ev.gameId ? String(ev.gameId) : '',
            payload: ev.payload && typeof ev.payload === 'object' ? ev.payload : {},
            timestamp: Number(ev.timestamp),
            date: String(ev.date || new Date(Number(ev.timestamp)).toISOString().slice(0, 10)),
            createdAt: Date.now(),
          });
          added++;
        } catch (e) {
          console.error('[analytics] event write failed:', (e && e.message) || e);
          ignored++;
        }
      }
      return buildResponse(200, { success: true, data: { added, ignored } });
    }

    // ----- GET /__analytics/{overview|trends|by-game|players} -----
    if (method === 'GET') {
      const sub = seg[0] || '';
      if (['overview', 'trends', 'by-game', 'players'].indexOf(sub) === -1) {
        return buildResponse(404, { success: false, error: 'unknown analytics query: ' + sub });
      }
      // 与本地查询路由一致：需要有效 JWT（前端 fetchAnalytics 始终携带）
      const auth = extractAuth(event);
      if (!auth.userId) {
        return buildResponse(401, { success: false, error: 'unauthorized' });
      }
      const events = await loadAnalyticsEvents(col);
      if (sub === 'overview') {
        return buildResponse(200, { success: true, data: aggOverview(events) });
      }
      if (sub === 'trends') {
        const days = Math.min(Math.max(parseInt(String((q && q.days) || '30'), 10) || 30, 1), 90);
        return buildResponse(200, { success: true, data: aggTrends(events, days) });
      }
      if (sub === 'by-game') {
        return buildResponse(200, { success: true, data: aggByGame(events) });
      }
      return buildResponse(200, { success: true, data: aggPlayers(events) });
    }

    return buildResponse(405, { success: false, error: 'analytics method not allowed' });
  },

  // ============ 钱包（游戏内货币，与平台核心钱包解耦） ============
  async wallet(method, seg, body, q, authorization) {
    const col = 'game_wallets';
    const userId = resolveUserId(authorization, body);
    // balance 为多币种对象，与前端 WalletAPI 的 WalletBalance 对齐
    const EMPTY_BALANCE = { computingPower: 0, gameCoins: 0, diamonds: 0 };
    // my-rewards：当前用户所有游戏钱包汇总（任务报酬可见，无需 gameId）
    if (method === 'GET' && seg[0] === 'my-rewards') {
      let rows = [];
      const total = Object.assign({}, EMPTY_BALANCE);
      try {
        const qres = await db.collection(col).where({ userId }).limit(100).get();
        const list = (qres && qres.data) || [];
        rows = list.map((w) => {
          const balance = Object.assign({}, EMPTY_BALANCE, (w && w.balance) || {});
          for (const k of Object.keys(EMPTY_BALANCE)) total[k] = (total[k] || 0) + (balance[k] || 0);
          return {
            gameId: (w && (w.gameId || String(w._id || '').split('::')[0])) || '',
            userId,
            balance,
            transactions: Array.isArray(w && w.transactions) ? w.transactions : [],
          };
        });
      } catch (e) { /* 查询失败返回空 */ }
      return buildResponse(200, { success: true, data: { userId, total, wallets: rows } });
    }
    const gameId = body.gameId || body.gameSource || (q && q.gameId) || (event && event.queryStringParameters && event.queryStringParameters.gameId) || (event && event.queryString ? (parseQuery('?' + event.queryString).gameId) : null);
    if (!gameId) return buildResponse(400, { success: false, error: 'missing gameId' });
    const id = `${gameId}::${userId}`;
    async function loadWallet() {
      const res = await gsGet(col, id);
      const doc = (res && res.data && res.data[0]) || null;
      const balance = Object.assign({}, EMPTY_BALANCE, (doc && (doc.balance || {})));
      return { _id: id, gameId, userId, balance, transactions: (doc && doc.transactions) || [] };
    }
    if (method === 'GET' && seg[0] === 'balance') {
      const w = await loadWallet();
      return buildResponse(200, { success: true, data: { balance: w.balance, userId } });
    }
    // 通用：从 body 读取各币种增量（前端的 WalletAPI.reward 传 computingPower/gameCoins/diamonds）
    function rewardDeltas(b) {
      const d = {};
      const cp = Number(b.computingPower) || 0;
      const gc = Number(b.gameCoins) || 0;
      const dm = Number(b.diamonds) || 0;
      if (cp) d.computingPower = cp;
      if (gc) d.gameCoins = gc;
      if (dm) d.diamonds = dm;
      return d;
    }
    if (method === 'POST' && seg[0] === 'reward') {
      const deltas = rewardDeltas(body);
      if (Object.keys(deltas).length === 0) return buildResponse(400, { success: false, error: 'invalid amount: no currency provided' });
      const w = await loadWallet();
      for (const k of Object.keys(deltas)) w.balance[k] = (w.balance[k] || 0) + deltas[k];
      const tx = { id: `tx_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, type: 'reward', deltas, reason: body.reason || '', timestamp: Date.now() };
      w.transactions.unshift(tx);
      w.transactions = w.transactions.slice(0, 100);
      await gsUpsert(col, id, w);
      return buildResponse(200, { success: true, data: { balance: w.balance, transaction: tx } });
    }
    // 单一币种扣减：body 含 currency（computingPower|gameCoins|diamonds）与 amount
    if (method === 'POST' && seg[0] === 'spend') {
      const currency = body.currency || 'gameCoins';
      const amount = Number(body.amount) || 0;
      if (amount <= 0) return buildResponse(400, { success: false, error: 'invalid amount' });
      const w = await loadWallet();
      const have = w.balance[currency] || 0;
      if (have < amount) return buildResponse(400, { success: false, error: 'insufficient balance', data: { balance: w.balance } });
      w.balance[currency] = have - amount;
      const tx = { id: `tx_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, type: 'spend', currency, amount, reason: body.reason || '', itemId: body.itemId || '', timestamp: Date.now() };
      w.transactions.unshift(tx);
      w.transactions = w.transactions.slice(0, 100);
      await gsUpsert(col, id, w);
      return buildResponse(200, { success: true, data: { balance: w.balance, transaction: tx } });
    }
    // 币种兑换：fromCurrency -> toCurrency，按 rate 换算
    if (method === 'POST' && seg[0] === 'exchange') {
      const fromCurrency = body.fromCurrency || 'gameCoins';
      const toCurrency = body.toCurrency || 'computingPower';
      const amount = Number(body.amount) || 0;
      const rate = Number(body.rate) || 0;
      if (amount <= 0 || rate <= 0) return buildResponse(400, { success: false, error: 'invalid params' });
      const w = await loadWallet();
      const have = w.balance[fromCurrency] || 0;
      if (have < amount) return buildResponse(400, { success: false, error: 'insufficient balance', data: { balance: w.balance } });
      const toAmount = Math.floor(amount * rate);
      w.balance[fromCurrency] = have - amount;
      w.balance[toCurrency] = (w.balance[toCurrency] || 0) + toAmount;
      const tx = { id: `tx_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, type: 'exchange', fromCurrency, toCurrency, fromAmount: amount, toAmount, rate, timestamp: Date.now() };
      w.transactions.unshift(tx);
      w.transactions = w.transactions.slice(0, 100);
      await gsUpsert(col, id, w);
      return buildResponse(200, { success: true, data: { transaction: tx, balance: w.balance } });
    }
    if (method === 'GET' && seg[0] === 'transactions') {
      const limit = Math.min(100, parseInt((q.limit || '20'), 10) || 20);
      const w = await loadWallet();
      return buildResponse(200, { success: true, data: { transactions: w.transactions.slice(0, limit), balance: w.balance } });
    }

    // ============ 平台钱包（users.gameCoins）跨浏览器写通道 ============
    // 平台余额与游戏内多币种钱包不同：写 users 集合（READ_ONLY 隧道路径会拦截），
    // 故在此 handler 内部直写，绕过通用隧道的 READ_ONLY_COLLECTIONS 检查。
    // ⚠️ 安全铁律：userId 只取 Authorization token 解析值，忽略 body.userId，防越权改他人余额。
    if (seg[0] === 'platform') {
      const platformUserId = resolveUserId(authorization, body);
      const usersCol = 'users';
      const txCol = 'transactions';

      async function loadPlatformUser() {
        try {
          const res = await db.collection(usersCol).where({ _openid: platformUserId }).limit(1).get();
          const doc = (res && res.data && res.data[0]) || null;
          if (doc) {
            return {
              _id: doc._id,
              _openid: doc._openid || platformUserId,
              gameCoins: Number(doc.gameCoins) || 0,
              instantVouchers: Number(doc.instantVouchers) || 0,
              algorithmVouchers: Number(doc.algorithmVouchers) || 0,
              updatedAt: doc.updatedAt || Date.now(),
            };
          }
        } catch (e) { /* 读取失败返回 null */ }
        return null;
      }

      // GET balance：跨浏览器读平台余额
      if (method === 'GET' && seg[1] === 'balance') {
        const u = await loadPlatformUser();
        const balance = u || {
          _openid: platformUserId,
          gameCoins: 0,
          instantVouchers: 0,
          algorithmVouchers: 0,
          updatedAt: Date.now(),
        };
        return buildResponse(200, { success: true, data: { balance: {
          gameCoins: balance.gameCoins,
          instantVouchers: balance.instantVouchers,
          algorithmVouchers: balance.algorithmVouchers,
          lastUpdated: balance.updatedAt,
        } } });
      }

      // GET transactions：跨浏览器读平台流水
      if (method === 'GET' && seg[1] === 'transactions') {
        const limit = Math.min(100, parseInt((q.limit || '50'), 10) || 50);
        let rows = [];
        try {
          const res = await db.collection(txCol).where({ userId: platformUserId }).orderBy('timestamp', 'desc').limit(limit).get();
          rows = (res && res.data) || [];
        } catch (e) { /* 读取失败返回空 */ }
        return buildResponse(200, { success: true, data: { transactions: rows } });
      }

      // POST adjust：delta 正=充值，负=消费；txId 幂等防重
      if (method === 'POST' && seg[1] === 'adjust') {
        const delta = Number(body.delta) || 0;
        if (delta === 0) return buildResponse(400, { success: false, error: 'invalid delta' });
        const txId = String(body.txId || '').trim();
        if (!txId) return buildResponse(400, { success: false, error: 'missing txId' });
        const now = Date.now();
        try {
          // 幂等：txId 已存在则直接返回上次结果
          const dupRes = await db.collection(txCol).where({ _id: `plat_${txId}` }).limit(1).get();
          if (dupRes && dupRes.data && dupRes.data.length > 0) {
            const u = await loadPlatformUser();
            return buildResponse(200, { success: true, data: {
              balance: {
                gameCoins: u ? u.gameCoins : 0,
                instantVouchers: u ? u.instantVouchers : 0,
                algorithmVouchers: u ? u.algorithmVouchers : 0,
                lastUpdated: u ? u.updatedAt : now,
              },
              duplicated: true,
            } });
          }

          let u = await loadPlatformUser();
          if (!u) {
            u = {
              _openid: platformUserId,
              gameCoins: 0,
              instantVouchers: 0,
              algorithmVouchers: 0,
              createdAt: now,
              updatedAt: now,
            };
          }
          const newGameCoins = (u.gameCoins || 0) + delta;
          if (newGameCoins < 0) return buildResponse(400, { success: false, error: 'insufficient balance', data: { balance: { gameCoins: u.gameCoins, instantVouchers: u.instantVouchers, algorithmVouchers: u.algorithmVouchers, lastUpdated: u.updatedAt } } });
          u.gameCoins = newGameCoins;
          u.updatedAt = now;
          const setData = {
            _openid: u._openid,
            gameCoins: u.gameCoins,
            instantVouchers: u.instantVouchers || 0,
            algorithmVouchers: u.algorithmVouchers || 0,
            updatedAt: now,
          };
          if (!u._id) {
            setData.createdAt = now;
            const addRes = await db.collection(usersCol).add(setData);
            u._id = (addRes && addRes.id) || null;
          } else {
            await db.collection(usersCol).doc(String(u._id)).update({ gameCoins: u.gameCoins, updatedAt: now });
          }
          const txDoc = {
            _id: `plat_${txId}`,
            userId: platformUserId,
            type: delta > 0 ? 'income' : 'expense',
            amount: Math.abs(delta),
            description: String(body.description || ''),
            balanceAfter: newGameCoins,
            timestamp: now,
            createdAt: now,
          };
          await db.collection(txCol).doc(`plat_${txId}`).set(txDoc);
          return buildResponse(200, { success: true, data: {
            balance: {
              gameCoins: u.gameCoins,
              instantVouchers: u.instantVouchers || 0,
              algorithmVouchers: u.algorithmVouchers || 0,
              lastUpdated: now,
            },
            transaction: txDoc,
          } });
        } catch (e) {
          console.warn('[wallet platform adjust] 失败', (e && e.message) || e);
          return buildResponse(500, { success: false, error: (e && e.message) || 'write failed' });
        }
      }
      return buildResponse(405, { success: false, error: 'wallet platform method not allowed' });
    }

    return buildResponse(405, { success: false, error: 'wallet method not allowed' });
  },

  // ============ 商店 ============
  async store(method, seg, body, q, authorization) {
    const productsCol = 'store_products';
    const ordersCol = 'game_store_orders';
    if (method === 'GET' && seg[0] === 'products') {
      const gameId = q.gameId || body.gameId;
      if (!gameId) return buildResponse(400, { success: false, error: 'missing gameId' });
      const res = await db.collection(productsCol).where({ gameId }).limit(500).get();
      return buildResponse(200, { success: true, data: { products: (res && res.data) || [] } });
    }
    if (method === 'POST' && seg[0] === 'purchase') {
      const userId = resolveUserId(authorization, body);
      const gameId = body.gameId;
      const productId = body.productId;
      if (!gameId || !productId) return buildResponse(400, { success: false, error: 'missing gameId/productId' });
      const pres = await db.collection(productsCol).where({ gameId, id: productId }).limit(1).get();
      const product = pres && pres.data && pres.data[0];
      if (!product) return buildResponse(404, { success: false, error: 'product not found' });
      // 扣减游戏内钱包余额
      const walletId = `${gameId}::${userId}`;
      const wres = await gsGet('game_wallets', walletId);
      const w = (wres && wres.data && wres.data[0]) || { _id: walletId, gameId, userId, balance: 0, currency: product.currency || 'gameCoin', transactions: [] };
      const price = Number(product.price) || 0;
      if (w.balance < price) return buildResponse(400, { success: false, error: 'insufficient balance', data: { balance: w.balance } });
      w.balance -= price;
      w.transactions.unshift({ id: `tx_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, type: 'purchase', amount: price, productId, timestamp: Date.now() });
      w.transactions = w.transactions.slice(0, 100);
      await gsUpsert('game_wallets', walletId, w);
      const order = {
        _id: `order_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        gameId, userId, productId, price, status: 'paid', createdAt: Date.now(),
      };
      await gsAppend(ordersCol, order);
      return buildResponse(200, { success: true, data: { order, balance: w.balance } });
    }
    if (method === 'POST' && seg[0] === 'checkout') {
      const userId = resolveUserId(authorization, body);
      const gameId = body.gameId;
      const items = Array.isArray(body.items) ? body.items : [];
      if (!gameId || items.length === 0) return buildResponse(400, { success: false, error: 'missing gameId/items' });
      const total = items.reduce((s, it) => s + (Number(it.price) || 0) * (Number(it.quantity) || 1), 0);
      const order = {
        _id: `order_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        gameId, userId, items, total, status: 'paid', createdAt: Date.now(),
      };
      await gsAppend(ordersCol, order);
      return buildResponse(200, { success: true, data: { order, total } });
    }
    return buildResponse(405, { success: false, error: 'store method not allowed' });
  },

  // ============ 认证（匿名，prod 不强制密码） ============
  async auth(method, seg, body) {
    const col = 'game_auth_users';
    if ((method === 'POST' && seg[0] === 'login') || (method === 'POST' && seg[0] === 'register')) {
      const userId = body.userId || body.username || ('guest_' + Math.random().toString(36).slice(2, 10));
      const res = await gsGet(col, userId);
      let user = res && res.data && res.data[0];
      if (!user) {
        user = { _id: userId, userId, username: body.username || userId, createdAt: Date.now(), lastLogin: Date.now() };
        await gsUpsert(col, userId, user);
      } else {
        await db.collection(col).doc(String(userId)).update({ lastLogin: Date.now() }).catch(() => {});
      }
      return buildResponse(200, { success: true, data: { user: { userId: user.userId, username: user.username }, isNew: !!(seg[0] === 'register' && !res) } });
    }
    return buildResponse(405, { success: false, error: 'auth method not allowed' });
  },

  // ============ 游戏开发者账户（平台级，独立集合） ============
  // （三方分成影子对照/哈希链 helpers 见模块顶层 SHARING_* 函数——对象字面量内不能声明 const/function）

  async 'game-developers'(method, seg, body) {
    const col = 'game_developer_accounts';
    if (method === 'GET' && seg.length === 0) {
      const res = await db.collection(col).limit(1000).get();
      return buildResponse(200, { success: true, data: (res && res.data) || [] });
    }
    if (method === 'GET' && seg.length >= 2 && (seg[1] === 'revenue-sharing-history' || seg[1] === 'revenue-sharing-verify' || seg[1] === 'split-ledger')) {
      const accountId = seg[0];
      if (seg[1] === 'revenue-sharing-history') {
        try {
          const res = await db.collection('game_revenue_sharing_history').where({ accountId }).orderBy('timestamp', 'asc').limit(200).get();
          return buildResponse(200, { success: true, data: (res && res.data) || [] });
        } catch {
          return buildResponse(200, { success: true, data: [] });
        }
      }
      if (seg[1] === 'revenue-sharing-verify') {
        let entries = [];
        try {
          const res = await db.collection('game_revenue_sharing_history').where({ accountId }).orderBy('timestamp', 'asc').limit(200).get();
          entries = (res && res.data) || [];
        } catch { /* 集合不存在 → 空链 */ }
        let prevHash = SHARING_GENESIS_HASH;
        let intact = true;
        let brokenAt = null;
        for (const e of entries) {
          const expected = sharingEntryHashServer(prevHash, {
            accountId: e.accountId, gameId: e.gameId, config: e.config,
            source: e.source || 'default', proposalId: e.proposalId || '', timestamp: Number(e.timestamp),
          });
          if (e.hash !== expected) { intact = false; brokenAt = e.entryId; break; }
          prevHash = e.hash;
        }
        return buildResponse(200, { success: true, data: { accountId, intact, length: entries.length, brokenAt } });
      }
      // split-ledger：三方分账影子对照台账（审计可见）
      try {
        const res = await db.collection('revenue_ledger').where({ accountId }).limit(200).get();
        return buildResponse(200, { success: true, data: (res && res.data) || [] });
      } catch {
        return buildResponse(200, { success: true, data: [] });
      }
    }
    if (method === 'GET' && seg.length >= 1 && seg[0] !== 'transactions' && seg[1] !== 'revenue-sharing-history' && seg[1] !== 'revenue-sharing-verify' && seg[1] !== 'split-ledger') {
      const id = seg[0];
      const res = await gsGet(col, id);
      const doc = res && res.data && res.data[0];
      return buildResponse(200, { success: true, data: doc || null });
    }
    if (method === 'POST' && seg.length === 0) {
      if (!body || !body.accountId) return buildResponse(400, { success: false, error: 'missing accountId' });
      await gsUpsert(col, body.accountId, body);
      return buildResponse(200, { success: true, data: body });
    }
    if (method === 'POST' && seg.length === 1 && seg[0] !== 'transactions') {
      const accountId = seg[0];
      const doc = Object.assign({}, body, { accountId });
      await gsUpsert(col, accountId, doc);
      return buildResponse(200, { success: true, data: doc });
    }
    if (method === 'POST' && seg.length >= 2 && seg[1] === 'transactions') {
      const accountId = seg[0];
      const tx = Object.assign({ _id: `devtx_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, timestamp: Date.now() }, body);
      await gsAppend('game_developer_transactions', tx);
      // ---- 三方分成影子对照：服务端按账户配置独立重算，与客户端上报 split 对比 + revenue_ledger 记账 ----
      try {
        const meta = tx.metadata || {};
        if (tx.type === 'purchase' && meta.split) {
          const accRes = await gsGet(col, accountId);
          const account = (accRes && accRes.data && accRes.data[0]) || null;
          if (account) {
            const expected = computeThreeWaySplitServer(Number(tx.amount) || 0, account.revenueSharing, account.revenueSharePercent);
            const reported = meta.split;
            const consistent = Number(reported.gameCut) === expected.gameCut &&
              Number(reported.platformCut) === expected.platformCut &&
              Number(reported.creatorCut) === expected.creatorCut;
            if (!consistent) {
              console.warn(`[GameDev][影子对照] ⚠️ 分账不一致 account=${accountId} tx=${tx._id} ` +
                `上报(g=${reported.gameCut},p=${reported.platformCut},c=${reported.creatorCut}) vs ` +
                `服务端重算(g=${expected.gameCut},p=${expected.platformCut},c=${expected.creatorCut},mode=${expected.mode})`);
            }
            const entryId = `devsplit_${tx._id}`;
            const dup = await gsGet('revenue_ledger', entryId);
            if (!(dup && dup.data && dup.data[0])) {
              await gsUpsert('revenue_ledger', entryId, {
                entryId,
                txId: tx._id,
                source: 'item_sale', // P0a（2026-10-15）：与 GSO 模板枚举口径统一（下划线）
                gameId: tx.gameId,
                accountId,
                grossAmount: Number(tx.amount) || 0,
                commission: expected.platformCut,
                currency: 'aCoins',
                split: expected,
                reportedSplit: reported,
                consistent,
                occurredAt: Number(tx.timestamp) || Date.now(),
                recordedBy: 'server-shadow',
              });
            }
          }
        }
      } catch (shadowErr) {
        console.warn('[GameDev] 影子对照失败（不影响交易记录）:', (shadowErr && shadowErr.message) || shadowErr);
      }
      return buildResponse(200, { success: true, data: tx });
    }
    // ---- GSO 可观测收益记账点（store_sale / content_consume，2026-10-15）----
    // 只写 revenue_ledger（GSO tick sumRevenue 求和 commission 的唯一基数来源），不做钱包即时 credit。
    // 幂等：content_consume 用 cc_<voucherId>；store_sale 用分钟窗键（缺省服务端兜底）。
    if (method === 'POST' && seg.length >= 2 && seg[1] === 'gso-revenue') {
      const accountId = seg[0];
      const source = String((body && body.source) || '');
      const gameId = String((body && body.gameId) || '');
      const amount = Math.floor(Number((body && body.amount) || 0));
      const buyerId = String((body && body.buyerId) || '');
      if (['store_sale', 'content_consume'].indexOf(source) < 0 || !gameId || amount <= 0 || !buyerId) {
        return buildResponse(400, { success: false, error: 'source(store_sale|content_consume)/gameId/amount/buyerId 必填' });
      }
      const minuteWindow = Math.floor(Date.now() / 60000);
      const idem = String((body && body.idempotencyKey) || '') || (buyerId + '_' + gameId + '_' + amount + '_' + minuteWindow);
      const entryId = 'srvr_' + source + '_' + idem;
      try {
        const dup = await gsGet('revenue_ledger', entryId);
        if (dup && dup.data && dup.data[0]) {
          return buildResponse(200, { success: true, data: { duplicate: true, entryId } });
        }
        // 账户缺失自愈（与 gamecoins-split 同模式）：从游戏档案重建默认账户
        const accRes = await gsGet(col, accountId);
        let account = (accRes && accRes.data && accRes.data[0]) || null;
        if (!account) {
          const gRes = await db.collection(COLLECTION).doc(gameId).get().catch(() => null);
          const game = gRes && gRes.data && gRes.data[0];
          if (!game || !game.publisherId) {
            return buildResponse(404, { success: false, error: 'developer account not found，且服务端缺少游戏档案（' + gameId + '）' });
          }
          account = Object.assign({
            accountId, gameId,
            gameName: game.name || game.gameName || game.title || gameId,
            publisherId: game.publisherId,
            publisherName: game.publisherName || game.publisherId,
            revenueSharePercent: typeof game.revenueSharePercent === 'number' ? game.revenueSharePercent : 10,
            status: 'active',
          });
          await gsUpsert(col, accountId, account);
          console.log('[GameDev] ♻️ 账户缺失自愈（gso-revenue）：已从游戏档案重建 ' + accountId);
        }
        const expected = computeThreeWaySplitServer(amount, account.revenueSharing, account.revenueSharePercent);
        await gsUpsert('revenue_ledger', entryId, {
          entryId,
          txId: entryId,
          source,
          gameId,
          accountId,
          grossAmount: amount,
          commission: expected.platformCut,
          currency: 'aCoins',
          split: expected,
          occurredAt: Date.now(),
          recordedBy: 'server',
        });
        console.log('[GameDev] 📒 GSO 收益记账 ' + source + ': ' + gameId + ' +' + amount + ' entry=' + entryId);
        return buildResponse(200, { success: true, data: { duplicate: false, entryId, split: expected } });
      } catch (e) {
        return buildResponse(500, { success: false, error: (e && e.message) || String(e) });
      }
    }
    // ---- 三方分成配置变更存证（append-only 哈希链） ----
    if (method === 'POST' && seg.length >= 2 && seg[1] === 'revenue-sharing-history') {
      const accountId = seg[0];
      const { gameId, config, source, proposalId } = body || {};
      if (!gameId || !config) return buildResponse(400, { success: false, error: 'gameId 与 config 必填' });
      const timestamp = Date.now();
      const HIS_COL = 'game_revenue_sharing_history';
      let prevHash = SHARING_GENESIS_HASH;
      try {
        const prevRes = await db.collection(HIS_COL).where({ accountId }).orderBy('timestamp', 'desc').limit(1).get();
        if (prevRes && prevRes.data && prevRes.data[0] && prevRes.data[0].hash) prevHash = prevRes.data[0].hash;
      } catch { /* 集合不存在 → GENESIS */ }
      const entryId = `rsh_${accountId}_${timestamp}_${Math.random().toString(36).slice(2, 8)}`;
      const entry = {
        entryId, accountId, gameId, config, source: source || 'default',
        proposalId: proposalId || '', prevHash, timestamp,
        hash: sharingEntryHashServer(prevHash, { accountId, gameId, config, source: source || 'default', proposalId: proposalId || '', timestamp }),
      };
      await gsUpsert(HIS_COL, entryId, entry);
      return buildResponse(200, { success: true, data: entry });
    }
    if (method === 'GET' && seg.length >= 2 && seg[1] === 'transactions') {
      const accountId = seg[0];
      const res = await db.collection('game_developer_transactions').where({ accountId }).limit(200).get();
      return buildResponse(200, { success: true, data: (res && res.data) || [] });
    }
    return buildResponse(405, { success: false, error: 'game-developers method not allowed' });
  },

  // ============ 任务系统（GameQuest：接单 → 提交 → 审核 → 合并 → 报酬） ============
  async quests(method, seg, body, q, authorization) {
    const questsCol = 'quests';
    const claimsCol = 'quest_claims';
    const subsCol = 'quest_submissions';
    const userId = resolveUserId(authorization, body);

    // ---------- 静态校验（危险代码扫描 + 路径白名单 + 文件大小） ----------
    const DEFAULT_FORBIDDEN = [
      'eval(', 'Function(', 'document.write', 'javascript:',
      '<script', 'new Function', 'constructor(',
    ];
    const QUEST_BINARY_PREFIX = '__BINARY_BASE64__';
    function questContentSize(content) {
      if (typeof content === 'string' && content.startsWith(QUEST_BINARY_PREFIX)) {
        const b64 = content.slice(QUEST_BINARY_PREFIX.length);
        const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
        return Math.max(0, Math.floor(b64.length / 4) * 3 - pad);
      }
      return Buffer.byteLength(String(content), 'utf8');
    }
    function validateContentPack(contentPack, quest) {
      const issues = [];
      const allowedPaths = (quest && quest.sourceSnapshot && quest.sourceSnapshot.allowedPaths) || [];
      const maxFileSize = (quest && quest.acceptance && quest.acceptance.maxFileSize) || 512 * 1024;
      const forbidden =
        (quest && quest.acceptance && Array.isArray(quest.acceptance.forbiddenPatterns) && quest.acceptance.forbiddenPatterns.length)
          ? quest.acceptance.forbiddenPatterns
          : DEFAULT_FORBIDDEN;
      const scan = (text) => {
        if (typeof text !== 'string') return [];
        const found = [];
        for (const pat of forbidden) {
          if (typeof pat === 'string' && text.indexOf(pat) >= 0) found.push(pat);
        }
        return found;
      };
      const pack = contentPack || {};
      // 独立入口模式：entryPoint 非空 → 资产是完整 HTML 页面（必然含 <script>/JS），
      // 危险代码扫描无意义（页面即代码，安全由 iframe sandbox + 审核流程保障），仅校验大小。
      const isEntryMode = typeof pack.entryPoint === 'string' && !!pack.entryPoint;
      // 方案 E：注入模式。脚本即交付物（data.code / .js 资产），代码会在玩家浏览器运行，
      // 危险代码扫描仅作提示（安全由审核 + 权限管控保障）。
      const isInjectMode = pack.inject === true;
      // data 字段序列化后扫描（注入模式 data 即代码，不扫描，安全靠审核）
      const dataStr = typeof pack.data === 'string' ? pack.data : JSON.stringify(pack.data || {});
      const dataHits = isInjectMode ? [] : scan(dataStr);
      if (dataHits.length) issues.push('data 含危险代码: ' + dataHits.join(','));
      // assets 逐个校验
      const assets = Array.isArray(pack.assets) ? pack.assets : [];
      for (const a of assets) {
        const path = String(a && a.path ? a.path : '').replace(/^\/+/, '');
        if (allowedPaths.length > 0) {
          const ok = allowedPaths.some((p) => {
            const norm = String(p).replace(/^\/+/, '');
            return path === norm || path.indexOf(norm + '/') === 0;
          });
          if (!ok) issues.push('路径不在白名单: ' + path);
        }
        const content = typeof a.content === 'string' ? a.content : '';
        const size = questContentSize(content);
        if (size > maxFileSize) {
          issues.push('文件过大: ' + path + ' (' + size + ' 字节)');
        }
        // 独立入口模式的页面资产 / 注入模式脚本 / 二进制内容跳过危险代码扫描
        if (!isEntryMode && !isInjectMode && !content.startsWith(QUEST_BINARY_PREFIX)) {
          const hits = scan(content);
          if (hits.length) issues.push('文件 ' + path + ' 含危险代码: ' + hits.join(','));
        }
      }

      // P2 内容协商：按 slot 注册表校验 data 形状 / 必填字段 / 允许文件类型（未注册 slot 不强制）
      // 与 src/types/quest.ts 的 QUEST_SLOT_SCHEMAS / validateQuestContent 保持一致。
      const slot = String(quest && quest.contentSlot ? quest.contentSlot : (pack.slot || 'levels'));
      const slotIssues = validateQuestSlot(slot, pack);
      for (const s of slotIssues) issues.push(s);
      return issues;
    }

    // P2 slot Schema 注册表（JS 版，与前端 src/types/quest.ts 对齐）
    const QUEST_SLOT_SCHEMAS = [
      { key: 'levels', label: '关卡', dataShape: 'array', requiredKeys: ['id'], allowSingleObject: true, allowedAssetExts: ['json', 'js', 'png', 'jpg', 'mp3'], hint: 'data 为数组（推荐）或单个对象；每条必须含 id，其余字段以该游戏「任务开发说明」为准（如赌石矿区 { id, name, lv, price, green, cap, ... }、超级玛丽关卡 { id, title, layout?, script? ... }）；layout 为 15 行字符网格（# B ? M X ( C F）或二维数字数组；script 指向 assets 的 .js（window.MarioLevel.build(api)）。⚠️ JSON 数据直接粘贴进 data 框；asset 上传的 json 不会被解析进 data，仅作贴图/音效/脚本等随附文件' },
      { key: 'items', label: '道具', dataShape: 'array', requiredKeys: ['id', 'name'], allowedAssetExts: ['json', 'png'], hint: 'data 为道具数组，每个 { id, name, effect?, ... }；图标可用 png' },
      { key: 'skins', label: '皮肤', dataShape: 'array', requiredKeys: ['id', 'name'], allowedAssetExts: ['json', 'png', 'svg', 'css', 'jpg'], hint: 'data 为皮肤数组，每个 { id, name, ... }；皮肤图可用 png/svg/jpg' },
      { key: 'scripts', label: '脚本/能力', dataShape: 'object', requiredKeys: ['name'], allowedAssetExts: ['js', 'mjs', 'json'], hint: 'data 为单个脚本对象 { name, code?, ... }；源码放 assets 的 js 文件' },
      { key: 'audio', label: '音效', dataShape: 'object', requiredKeys: ['name'], allowedAssetExts: ['mp3', 'wav', 'ogg', 'json'], hint: 'data 为音效对象 { name, src?, ... }；音频本体放 assets' },
      { key: 'art', label: '美术', dataShape: 'object', requiredKeys: [], allowedAssetExts: ['png', 'jpg', 'jpeg', 'svg', 'webp'], hint: 'data 为美术对象 { name?, ... }；图片本体放 assets' },
      { key: 'fix', label: '修复/平衡', dataShape: 'any', requiredKeys: [], allowedAssetExts: ['js', 'json', 'css'], hint: 'data 任意形状；涉及代码放 assets 的 js 文件' },
      { key: 'inject', label: '注入脚本/MOD', dataShape: 'any', requiredKeys: [], allowedAssetExts: ['js', 'mjs'], hint: '模式 E：把 JS 直接注入宿主游戏页面（加载入口 HTML 时自动拼接执行，无需游戏内置加载器）。data 可留空；脚本放 assets 的 .js 文件（或 data.code 内联）。游戏零改动即可生效。⚠️ 高风险：代码会在玩家浏览器里运行，请确保脚本只做关卡/平衡/功能增强' },
    ];
    // 独立入口模式允许的 web 资源扩展名（与前端 QUEST_WEB_ASSET_EXTS 对齐）
    const QUEST_WEB_ASSET_EXTS = [
      'html', 'htm', 'css', 'js', 'mjs', 'json',
      'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp', 'avif',
      'mp3', 'wav', 'ogg', 'oga', 'm4a', 'flac',
      'mp4', 'webm',
      'woff', 'woff2', 'ttf', 'otf', 'eot',
      'txt', 'md', 'map', 'xml',
    ];
    // 方案 C：用统一 HTML 壳把「片段入口」包裹成完整页面（与前端 wrapHtmlFragment 对齐）。
    // 二进制（带 QUEST_BINARY_PREFIX）无法包裹，返回 null 表示不适用。
    function wrapHtmlFragment(content) {
      if (!content || (typeof content === 'string' && content.startsWith(QUEST_BINARY_PREFIX))) return null;
      return [
        '<!DOCTYPE html>',
        '<html lang="zh-CN">',
        '<head>',
        '<meta charset="UTF-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
        '<style>html,body{margin:0;padding:0;height:100%;background:#0d0d1a;color:#eee;font-family:system-ui,sans-serif}</style>',
        '</head>',
        '<body>',
        content,
        '</body>',
        '</html>',
      ].join('\n');
    }
    // 方案 E：从注入型 contentPack 提取注入负载（code + 内联 styles，与本地 quests.ts 对齐）
    function extractInjectPayload(pack) {
      if (!pack) return { code: '', styles: [] };
      const injAssets = Array.isArray(pack.assets) ? pack.assets : [];
      const js = injAssets.find((a) => String((a && a.path) || '').toLowerCase().endsWith('.js'));
      const code =
        (pack.data && typeof pack.data.code === 'string' && pack.data.code.trim()) ||
        (js && typeof js.content === 'string' && !js.content.startsWith(QUEST_BINARY_PREFIX) ? js.content : '');
      const styles = injAssets
        .filter((a) => String((a && a.path) || '').toLowerCase().endsWith('.css'))
        .map((a) => (typeof a.content === 'string' && !a.content.startsWith(QUEST_BINARY_PREFIX) ? a.content : ''))
        .filter(Boolean);
      return { code: code || '', styles };
    }
    // 方案 E：文件分发层注入（与 SW v13 / 本地 games.ts 幂等一致：含注入标记则不重复注入）
    function escapeHtml(s) {
      return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    function escapeScriptClose(code) {
      return String(code).replace(/<\/script/gi, '<\\/script');
    }
    // 内联 CSS 的 url() 重写到 assetBase（相对路径，浏览器按文档 base 解析）
    function rewriteCssUrls(css, base) {
      return String(css).replace(/url\(\s*(['"]?)(?!data:|https?:|\/\/|#)\/?([^'")]+)\1\s*\)/gi,
        (m, q, p) => 'url(' + q + base + String(p).replace(/^\/+/, '') + q + ')');
    }
    // 构造注入块：CSS <link> + 内联 <style> + 资源帮助器 + 用户脚本
    function buildInjectionBlock(inj, resolveBase) {
      const base = resolveBase(inj);
      const parts = [];
      const assets = Array.isArray(inj.assets) ? inj.assets : [];
      // ① CSS 文件资产 → <link>（href = base + 相对路径，保留子目录；CSS 内 url() 相对自身解析）
      assets
        .filter((a) => String((a && a.path) || '').toLowerCase().endsWith('.css'))
        .forEach((a) => {
          const full = String((a && a.path) || '');
          let rel = full;
          if (inj.assetBase && full.startsWith(inj.assetBase)) rel = full.slice(inj.assetBase.length);
          if (rel) parts.push('<link rel="stylesheet" href="' + escapeHtml(base + rel) + '">');
        });
      // ② data.css 内联 → <style> + url() 重写到 assetBase
      (Array.isArray(inj.styles) ? inj.styles : [])
        .filter((s) => s && s.trim())
        .forEach((css) => parts.push('<style data-allinone-css>\n' + rewriteCssUrls(css, base) + '\n</style>'));
      // ③ 资源基础帮助器（图片/声音寻址；server/SW 默认相对 assetBase，按文档 base 解析）
      const sid = inj.submissionId || '';
      parts.push(
        '<script>window.AllinONE_INJECT=window.AllinONE_INJECT||{};' +
          'window.AllinONE_INJECT[' + JSON.stringify(sid) + ']={base:' + JSON.stringify(base) + ',' +
          'url:function(p){return this.base+p}};' +
          'window.AllinONE_asset=function(p){return window.AllinONE_INJECT[' + JSON.stringify(sid) + '].url(p)};</script>'
      );
      // ④ 用户脚本
      if (inj.code && inj.code.trim()) parts.push('<script>\n' + escapeScriptClose(inj.code) + '\n</script>');
      const label = String(inj.name || sid).replace(/--/g, '-');
      return parts.length ? '\n<!-- AllinONE 注入扩展: ' + label + ' -->\n' + parts.join('\n') : '';
    }
    function applyInjectionsToHtml(html, injections, resolveBase) {
      if (!html || !Array.isArray(injections) || !injections.length) return html;
      if (html.indexOf('<!-- AllinONE 注入扩展') >= 0) return html; // 幂等
      const r = resolveBase || ((inj) => (inj && inj.assetBase) || '');
      const blocks = injections.map((inj) => buildInjectionBlock(inj, r)).filter(Boolean).join('\n');
      if (!blocks) return html;
      const lower = html.toLowerCase();
      const bodyIdx = lower.lastIndexOf('</body>'); // 大小写不敏感
      return bodyIdx >= 0 ? html.slice(0, bodyIdx) + blocks + html.slice(bodyIdx) : html + blocks;
    }
    // 内容工坊：ContentLoader 骨架（仅 contentSop.enabled 的游戏注入；幂等标记与 server/SW/GamePlay 一致）
    const CONTENT_LOADER_MARKER = '<!-- AllinONE 内容加载器 -->';
    const CONTENT_LOADER_SNIPPET = '<script>\n(function(){if(window.AllinONE_ContentLoader)return;var L={\n__v:1,_applied:{},_handlers:{},\non:function(s,f){this._handlers[s]=f;return this;},\nbase:function(p){return p&&p.assetBase?p.assetBase:\'\';},\nurl:function(p,path){return this.base(p)+String(path||\'\').replace(/^\\/+/g,\'\');},\napply:function(p){if(!p||!p.contentId)return{ok:false,error:\'invalid pack\'};var cid=p.contentId;\nif(this._applied[cid])return{ok:false,error:\'already applied this session\'};\nwindow.AllinONE_ContentAssets=window.AllinONE_ContentAssets||{};\nwindow.AllinONE_ContentAssets[cid]={base:this.base(p),pack:p,url:function(pp){return this.base+String(pp||\'\').replace(/^\\/+/g,\'\');}};\nvar self=this;var assets=Array.isArray(p.assets)?p.assets:[];\nvar scripts=assets.filter(function(a){return /\\.js$/i.test(String(a.path||\'\'));});\nif(p.data&&typeof p.data.code===\'string\'&&p.data.code.trim()){try{(new Function(p.data.code))();}catch(e){console.error(\'[ContentLoader] data.code error\',e);}}\nfunction run(i){if(i>=scripts.length){window.dispatchEvent(new CustomEvent(\'allinone:content-pack-applied\',{detail:p}));\nvar h=self._handlers[p.slot]||(window.AllinONE_ContentHandlers&&window.AllinONE_ContentHandlers[p.slot]);\nif(h){try{h(p);}catch(e){console.error(\'[ContentLoader] handler error\',e);}}\nreturn{ok:true};}var s=document.createElement(\'script\');s.src=self.url(p,scripts[i].path);\ns.onload=function(){run(i+1);};s.onerror=function(){run(i+1);};document.head.appendChild(s);}\nrun(0);this._applied[cid]=true;return{ok:true,queued:scripts.length};},\nlist:function(){return Object.keys(this._applied);}};\nwindow.AllinONE_ContentLoader=L;\nwindow.addEventListener(\'message\',function(ev){var d=ev&&ev.data;if(!d||d.type!==\'CONTENT_PACK_APPLY\')return;\nif(window.AllinONE_ContentLoader&&d.content){window.AllinONE_ContentLoader.apply(d.content);}});})();\n<\/script>';
    function applyContentLoaderToHtml(html, enabled) {
      if (!enabled || !html || html.indexOf(CONTENT_LOADER_MARKER) >= 0) return html;
      const block = '\n' + CONTENT_LOADER_MARKER + '\n' + CONTENT_LOADER_SNIPPET + '\n';
      const lower = html.toLowerCase();
      // 注入到 </head> 前：loader 必须先于游戏内 AllinONE_ContentLoader.on() 注册代码执行（时序安全）；
      // 与 server games.ts / GamePlay / SW 四份拷贝保持一致。
      const headIdx = lower.lastIndexOf('</head>');
      return headIdx >= 0 ? html.slice(0, headIdx) + block + html.slice(headIdx) : html + block;
    }
    function isEntryFile(filePath, entryPoint) {
      const ep = String(entryPoint || 'index.html').replace(/^\/+/, '');
      const fp = String(filePath).replace(/^\/+/, '');
      return fp === ep;
    }
    function validateQuestSlot(slot, contentPack) {
      const issues = [];

      // 方案 E：注入模式。脚本即交付物（data.code 或 .js 资产），跳过 slot 结构校验与资产白名单。
      // ⚠️ 必须放在 schema 查找之前：未注册 slot（自定义/自由）的注入提交也要校验脚本来源，
      // 否则空提交绕过校验，merge 后无代码可注入。与前端 validateQuestContent 保持一致。
      if (contentPack && contentPack.inject === true) {
        const injectAssets = Array.isArray(contentPack.assets) ? contentPack.assets : [];
        const injectData = contentPack.data;
        const hasJsAsset = injectAssets.some((a) => String((a && a.path) || '').toLowerCase().endsWith('.js'));
        const hasInlineCode =
          injectData && typeof injectData === 'object' && typeof injectData.code === 'string' && injectData.code.trim().length > 0;
        if (!hasJsAsset && !hasInlineCode) {
          issues.push('注入模式需要提供 .js 资产（或 data.code 内联脚本）');
        }
        return issues;
      }

      const schema = QUEST_SLOT_SCHEMAS.find((s) => s.key === slot);
      if (!schema) return [];
      const hasEntry = !!(contentPack && typeof contentPack.entryPoint === 'string' && contentPack.entryPoint);
      const data = contentPack && contentPack.data;
      // 独立入口模式：data 不强制结构（内容以 HTML 页面为准）
      if (!hasEntry) {
        if (schema.dataShape === 'array' && !Array.isArray(data) && !(schema.allowSingleObject && data && typeof data === 'object')) {
          issues.push('slot "' + slot + '" 的 data 应为数组' + (schema.allowSingleObject ? '（或单个对象）' : ''));
        }
        if (schema.dataShape === 'object' && (typeof data !== 'object' || data === null || Array.isArray(data))) {
          issues.push('slot "' + slot + '" 的 data 应为对象');
        }
        // 纯文件补丁（fix 补回被删文件等）：data 为空对象且提供了 assets 时，内容主体在文件里，
        // 跳过必填字段检查（否则 data={} 会被 scripts 等 slot 的 requiredKeys 拦下）。
        // dataShape 检查保留（防止 levels 之类需要数组的 slot 用空 data 蒙混）。
        const hasAssets = Array.isArray(contentPack && contentPack.assets) && contentPack.assets.length > 0;
        const dataIsEmptyObj =
          typeof data === 'object' && data !== null && !Array.isArray(data) && Object.keys(data).length === 0;
        if (schema.requiredKeys && schema.requiredKeys.length && !(dataIsEmptyObj && hasAssets)) {
          if (Array.isArray(data)) {
            for (const item of data) {
              if (item && typeof item === 'object') {
                for (const k of schema.requiredKeys) if (!(k in item)) issues.push('数组元素缺少必需字段: ' + k);
              }
            }
          } else if (data && typeof data === 'object') {
            for (const k of schema.requiredKeys) if (!(k in data)) issues.push('data 缺少必需字段: ' + k);
          }
        }
      }
      const assets = Array.isArray(contentPack && contentPack.assets) ? contentPack.assets : [];
      const allowedExts = hasEntry ? QUEST_WEB_ASSET_EXTS : (schema.allowedAssetExts || []);
      if (allowedExts.length) {
        for (const a of assets) {
          const path = String((a && a.path) || '');
          const dot = path.lastIndexOf('.');
          const ext = dot >= 0 ? path.slice(dot + 1).toLowerCase() : '';
          if (ext && allowedExts.indexOf(ext) < 0) {
            issues.push('文件 ' + path + ' 类型不允许（slot "' + slot + '" 允许: ' + allowedExts.join('/') + '）');
          }
        }
      }
      return issues;
    }

    async function loadQuest(id) {
      const res = await gsGet(questsCol, id);
      const doc = (res && res.data && res.data[0]) || null;
      if (!doc) return null;
      return Object.assign({ id }, doc);
    }

    // ---------- 列表 ----------
    if (method === 'GET' && seg.length === 0) {
      const gameId = q.gameId || body.gameId;
      const status = q.status || '';
      let res;
      try {
        if (gameId && status) {
          res = await db.collection(questsCol).where({ gameId, status }).limit(500).get();
        } else if (gameId) {
          res = await db.collection(questsCol).where({ gameId }).limit(500).get();
        } else if (status) {
          res = await db.collection(questsCol).where({ status }).limit(500).get();
        } else {
          res = await db.collection(questsCol).limit(500).get();
        }
      } catch (e) {
        return buildResponse(200, { success: true, data: [] });
      }
      return buildResponse(200, {
        success: true,
        data: ((res && res.data) || []).map((d) => Object.assign({ id: d._id || d.id }, d)),
      });
    }

    // ---------- 社区模组列表 ----------
    if (method === 'GET' && seg.length === 1 && seg[0] === 'mods') {
      const gameId = q.gameId || body.gameId;
      let res;
      try {
        if (gameId) {
          res = await db.collection('quest_mods').where({ gameId }).limit(500).get();
        } else {
          res = await db.collection('quest_mods').limit(500).get();
        }
      } catch (e) {
        return buildResponse(200, { success: true, data: [] });
      }
      return buildResponse(200, {
        success: true,
        data: ((res && res.data) || []).map((d) => Object.assign({ id: d._id || d.id }, d)),
      });
    }

    // ---------- 详情 ----------
    if (method === 'GET' && seg.length === 1) {
      const quest = await loadQuest(seg[0]);
      if (!quest) return buildResponse(404, { success: false, error: 'quest not found' });
      return buildResponse(200, { success: true, data: quest });
    }

    // ---------- 提交列表（开发者视角） ----------
    if (method === 'GET' && seg.length === 2 && seg[1] === 'submissions') {
      let res;
      try {
        res = await db.collection(subsCol).where({ taskId: seg[0] }).limit(500).get();
      } catch (e) {
        return buildResponse(200, { success: true, data: [] });
      }
      return buildResponse(200, {
        success: true,
        data: ((res && res.data) || []).map((d) => Object.assign({ id: d._id || d.id }, d)),
      });
    }

    // ---------- 创建任务 ----------
    if (method === 'POST' && seg.length === 0) {
      if (!body || !body.id) return buildResponse(400, { success: false, error: 'missing quest.id' });
      if (!body.gameId) return buildResponse(400, { success: false, error: 'missing gameId' });
      const quest = Object.assign(
        {
          type: 'level',
          reward: {},
          escrow: { source: 'platform', frozen: {}, status: 'frozen' },
          sourceSnapshot: { ref: '', license: 'open', allowedPaths: [] },
          acceptance: { maxFileSize: 512 * 1024, description: '' },
          contentSlot: 'levels',
          maxClaimers: 3,
          status: 'open',
          reviewMode: 'developer',
          voteThreshold: 3,
          createdAt: Date.now(),
        },
        body
      );
      // developer 资金源：冻结流水记账（P1，不直接动 A币凭证余额）
      if (quest.escrow && quest.escrow.source === 'developer') {
        await gsAppend('game_developer_transactions', {
          _id: `devtx_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          accountId: `game-${quest.gameId}`,
          gameId: quest.gameId,
          type: 'quest_freeze',
          amount: Number((quest.reward && quest.reward.gameCoins) || 0),
          currency: 'gameCoins',
          description: `任务托管冻结: ${quest.title}`,
          timestamp: Date.now(),
        }).catch(() => {});
      }
      await gsUpsert(questsCol, quest.id, quest);
      return buildResponse(200, { success: true, data: quest });
    }

    // ---------- 领取（原子并发控制 + 幂等唯一键） ----------
    if (method === 'POST' && seg.length === 2 && seg[1] === 'claim') {
      const taskId = seg[0];
      const quest = await loadQuest(taskId);
      if (!quest) return buildResponse(404, { success: false, error: 'quest not found' });
      if (quest.status !== 'open') return buildResponse(400, { success: false, error: 'quest not open' });
      const maxClaimers = Number(quest.maxClaimers) || 0; // 0 = 无限
      if (maxClaimers > 0) {
        let active = 0;
        try {
          const countRes = await db.collection(claimsCol).where({ taskId, status: 'active' }).count();
          active = (countRes && countRes.total) || 0;
        } catch (e) { active = 0; }
        if (active >= maxClaimers) {
          return buildResponse(400, { success: false, error: 'task already fully claimed' });
        }
      }
      const claimId = `${taskId}::${userId}`;
      const existing = await gsGet(claimsCol, claimId);
      if (existing && existing.data && existing.data.length > 0) {
        return buildResponse(200, { success: true, data: { claimId, alreadyClaimed: true } });
      }
      await gsUpsert(claimsCol, claimId, { taskId, userId, status: 'active', claimedAt: Date.now() });
      return buildResponse(200, { success: true, data: { claimId, claimed: true } });
    }

    // ---------- 提交（含静态校验） ----------
    if (method === 'POST' && seg.length === 2 && seg[1] === 'submit') {
      const taskId = seg[0];
      const quest = await loadQuest(taskId);
      if (!quest) return buildResponse(404, { success: false, error: 'quest not found' });
      if (quest.status !== 'open') return buildResponse(400, { success: false, error: 'quest not open' });
      const contentPack = body.contentPack || body;
      const issues = validateContentPack(contentPack, quest);
      const submission = {
        taskId,
        claimId: `${taskId}::${userId}`,
        submitterId: userId,
        submitterName: body.submitterName || userId,
        contentPack,
        description: body.description || '',
        status: issues.length ? 'auto-failed' : 'reviewing',
        autoCheck: { passed: issues.length === 0, issues },
        createdAt: Date.now(),
      };
      const subId = `sub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      await gsUpsert(subsCol, subId, Object.assign({ id: subId }, submission));
      await gsUpsert(claimsCol, `${taskId}::${userId}`, {
        taskId, userId, status: 'submitted', claimedAt: Date.now(),
      }).catch(() => {});
      return buildResponse(200, {
        success: true,
        data: { id: subId, status: submission.status, autoCheck: submission.autoCheck },
      });
    }

    // ---------- 审核 ----------
    if (method === 'POST' && seg.length === 2 && seg[1] === 'review') {
      const subId = body.submissionId;
      if (!subId) return buildResponse(400, { success: false, error: 'missing submissionId' });
      const verdict = body.verdict === 'approve' ? 'approve' : 'reject';
      const res = await gsGet(subsCol, subId);
      const doc = (res && res.data && res.data[0]) || null;
      if (!doc) return buildResponse(404, { success: false, error: 'submission not found' });
      const reviewedBy = resolveUserId(authorization, body);
      const updated = Object.assign({}, doc, {
        review: { verdict, comment: body.comment || '', reviewedBy },
        status: verdict === 'approve' ? 'approved' : 'rejected',
      });
      await gsUpsert(subsCol, subId, updated);
      return buildResponse(200, { success: true, data: updated });
    }

    // ---------- 社区投票（P1，reviewMode=community） ----------
    if (method === 'POST' && seg.length === 2 && seg[1] === 'vote') {
      const taskId = seg[0];
      const subId = body.submissionId;
      if (!subId) return buildResponse(400, { success: false, error: 'missing submissionId' });
      const decision = body.decision === 'reject' ? 'reject' : 'approve';
      const voterName = body.voterName || userId;
      const quest = await loadQuest(taskId);
      if (!quest) return buildResponse(404, { success: false, error: 'quest not found' });
      const res = await gsGet(subsCol, subId);
      const doc = (res && res.data && res.data[0]) || null;
      if (!doc) return buildResponse(404, { success: false, error: 'submission not found' });
      if (doc.status !== 'reviewing') {
        return buildResponse(400, { success: false, error: 'submission not open for voting' });
      }
      const votes = Array.isArray(doc.votes) ? doc.votes : [];
      // 去重：同一 voter 覆盖旧票
      const filtered = votes.filter((v) => v.voterId !== userId);
      filtered.push({ voterId: userId, voterName, decision, votedAt: Date.now() });
      const approve = filtered.filter((v) => v.decision === 'approve').length;
      const reject = filtered.filter((v) => v.decision === 'reject').length;
      const threshold = Number(quest.voteThreshold) || 3;
      const passed = approve >= threshold && approve > reject;
      const updated = Object.assign({}, doc, {
        votes: filtered,
        status: passed ? 'approved' : doc.status,
      });
      await gsUpsert(subsCol, subId, updated);
      return buildResponse(200, {
        success: true,
        data: { id: subId, status: updated.status, approve, reject, passed, votes: filtered },
      });
    }

    // ---------- 关闭任务（仅创建者；退回 escrow，P1） ----------
    if (method === 'POST' && seg.length === 2 && seg[1] === 'close') {
      const taskId = seg[0];
      const quest = await loadQuest(taskId);
      if (!quest) return buildResponse(404, { success: false, error: 'quest not found' });
      if (quest.createdBy && quest.createdBy !== userId) {
        return buildResponse(403, { success: false, error: '只有任务创建者可以关闭任务' });
      }
      if (quest.status === 'closed' || quest.status === 'merged') {
        return buildResponse(400, { success: false, error: 'quest already ' + quest.status });
      }
      const escrow = Object.assign({}, quest.escrow || {}, { status: 'refunded' });
      if (escrow.source === 'developer') {
        await gsAppend('game_developer_transactions', {
          _id: `devtx_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          accountId: `game-${quest.gameId}`,
          gameId: quest.gameId,
          type: 'quest_refund',
          amount: Number((quest.reward && quest.reward.gameCoins) || 0),
          currency: 'gameCoins',
          description: `任务关闭退回托管: ${quest.title}`,
          timestamp: Date.now(),
        }).catch(() => {});
      }
      await gsUpsert(questsCol, taskId, Object.assign({}, quest, { status: 'closed', escrow }));
      return buildResponse(200, { success: true, data: { id: taskId, status: 'closed', escrow } });
    }

    // ---------- 删除任务（仅创建者；仅允许删除已 closed 的任务） ----------
    if (method === 'DELETE' && seg.length === 1) {
      const taskId = seg[0];
      const quest = await loadQuest(taskId);
      if (!quest) return buildResponse(404, { success: false, error: 'quest not found' });
      if (quest.createdBy && quest.createdBy !== userId) {
        return buildResponse(403, { success: false, error: '只有任务创建者可以删除任务' });
      }
      if (quest.status !== 'closed') {
        return buildResponse(400, { success: false, error: '仅已关闭的任务可以删除（先关闭再删除）' });
      }
      try {
        // 删除任务及其领取/提交记录
        const claims = await db.collection(claimsCol).where({ taskId }).limit(1000).get();
        for (const c of (claims && claims.data) || []) {
          if (c._id) await db.collection(claimsCol).doc(String(c._id)).remove().catch(() => {});
        }
        const subs = await db.collection(subsCol).where({ taskId }).limit(1000).get();
        for (const s of (subs && subs.data) || []) {
          if (s._id) await db.collection(subsCol).doc(String(s._id)).remove().catch(() => {});
        }
      } catch (e) {
        console.warn('[quests delete] 清理领取/提交失败', (e && e.message) || e);
      }
      try {
        await db.collection(questsCol).doc(String(taskId)).remove();
      } catch (e) {
        return buildResponse(500, { success: false, error: '删除任务失败: ' + ((e && e.message) || e) });
      }
      return buildResponse(200, { success: true, data: { id: taskId, deleted: true } });
    }

    // ---------- 转社区模组（P1：落选 submission → 可订阅模组） ----------
    if (method === 'POST' && seg.length === 4 && seg[1] === 'submissions' && seg[3] === 'convert') {
      const taskId = seg[0];
      const subId = seg[2];
      const quest = await loadQuest(taskId);
      if (!quest) return buildResponse(404, { success: false, error: 'quest not found' });
      const res = await gsGet(subsCol, subId);
      const doc = (res && res.data && res.data[0]) || null;
      if (!doc) return buildResponse(404, { success: false, error: 'submission not found' });
      const modId = `mod_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const mod = {
        gameId: quest.gameId,
        gameName: quest.gameName || '',
        questId: taskId,
        questTitle: quest.title,
        title: body.title || `${quest.title} · 社区模组`,
        description: body.description || doc.description || '',
        authorId: doc.submitterId,
        authorName: doc.submitterName,
        contentPack: doc.contentPack,
        subscribers: 0,
        createdAt: Date.now(),
      };
      await gsUpsert('quest_mods', modId, Object.assign({ id: modId }, mod));
      await gsUpsert(subsCol, subId, Object.assign({}, doc, { convertedToMod: true, modId }));
      return buildResponse(200, { success: true, data: { id: modId, mod } });
    }

    // ---------- 合并 + 发报酬 ----------
    if (method === 'POST' && seg.length === 2 && seg[1] === 'merge') {
      const taskId = seg[0];
      const quest = await loadQuest(taskId);
      if (!quest) return buildResponse(404, { success: false, error: 'quest not found' });
      let submission = null;
      let subId = body.submissionId;
      if (subId) {
        const sres = await gsGet(subsCol, subId);
        submission = (sres && sres.data && sres.data[0]) || null;
      } else {
        let sres;
        try {
          sres = await db.collection(subsCol).where({ taskId }).limit(500).get();
        } catch (e) { sres = { data: [] }; }
        const list = (sres && sres.data) || [];
        submission = list.find((s) => s.status === 'approved' || s.status === 'reviewing') || null;
        if (submission) subId = submission._id || submission.id;
      }
      if (!submission) return buildResponse(404, { success: false, error: 'submission not found' });

      const contentSlot = quest.contentSlot || 'levels';
      const contentPack = submission.contentPack || {};

      // 方案 C：base 快照（只写一次）——首次 merge 前把原版关键字段存一份，供「恢复原版」回滚。
      // 背景：历史 merge 把扩展数据直接 push 进 base（levels/items），方案 A 只止血、不清理
      // 已污染的文档；快照是唯一能把 base 还原回纯净态的依据。失败不影响合并主流程。
      try {
        const gresS = await getCollection().where({ id: quest.gameId }).limit(1).get();
        const gdocS = (gresS && gresS.data && gresS.data[0]) || null;
        if (gdocS && !gdocS.baseSnapshot) {
          const snap = {
            [contentSlot]: Array.isArray(gdocS[contentSlot]) ? gdocS[contentSlot] : [],
            injections: [],
            snapshotAt: Date.now(),
          };
          if (typeof gdocS.entryHtmlContent === 'string') snap.entryHtmlContent = gdocS.entryHtmlContent;
          if (typeof gdocS.entryPoint === 'string') snap.entryPoint = gdocS.entryPoint;
          await upsertMerge(quest.gameId, { baseSnapshot: snap });
          console.log(`[quests merge] base 快照已写入: ${quest.gameId}, slot=${contentSlot}`);
        }
      } catch (e) {
        console.warn('[quests merge] base 快照写入失败', (e && e.message) || e);
      }

      // 合并：内容包 data 追加到 published_games[gameId][contentSlot]（P2 冲突检测：相同内容去重）。
      // 独立入口模式（HTML 页面扩展）data 常为空对象/空数组，跳过不追加，避免污染关卡列表。
      // 方案 E 注入模式：data 只承载注入代码（data.code），代码由 ①d 消费，绝不追加到 slot。
      const rawData = contentPack.data;
      const dataIsEmpty =
        contentPack.inject === true ||
        rawData === undefined || rawData === null ||
        (Array.isArray(rawData) && rawData.length === 0) ||
        (typeof rawData === 'object' && !Array.isArray(rawData) && Object.keys(rawData).length === 0);
      if (!dataIsEmpty) {
        const gres = await getCollection().where({ id: quest.gameId }).limit(1).get();
        const gdoc = (gres && gres.data && gres.data[0]) || null;
        let slotArr = (gdoc && Array.isArray(gdoc[contentSlot])) ? gdoc[contentSlot] : [];
        const dataKey = JSON.stringify(rawData);
        const deduplicated = slotArr.some((item) => JSON.stringify(item) === dataKey);
        if (!deduplicated) {
          // ⚠️ 数组型 data（levels/items/skins 多元素）必须展开逐条追加，否则 slotArr 出现 [[{...}]] 嵌套，
          // 游戏侧按数组元素消费会拿不到。逐元素去重（内容相同不重复追加）。与本地 quests.ts 对齐。
          if (Array.isArray(rawData)) {
            // 逐元素追加 + 记 submissionId（游戏侧 ?ext=<submissionId> 自动选关）
            const subKey = subId || submission._id || submission.id || 'sub';
            for (const item of rawData) {
              if (item && typeof item === 'object' && !slotArr.some((x) => JSON.stringify(x) === JSON.stringify(item))) {
                slotArr.push(Object.assign({}, item, { _submissionId: subKey }));
              }
            }
          } else {
            // 单对象 data（如单矿区/单关卡扩展）：同样记 submissionId，与数组行为一致（?ext= 隔离语义）
            const subKey = subId || submission._id || submission.id || 'sub';
            slotArr.push(
              rawData && typeof rawData === 'object'
                ? Object.assign({}, rawData, { _submissionId: subKey })
                : rawData,
            );
          }
          await upsertMerge(quest.gameId, { [contentSlot]: slotArr });
        }
      }

      // ①b 资源文件落库（P1）：assets 写入 game_files 集合（追加合并，不覆盖原游戏文件）。
      // 命名空间：extensions/{questId}/{submissionId}/{path}，GET /files/* 公开分发。
      const submissionKey = subId || submission._id || submission.id || 'sub';
      const assets = Array.isArray(contentPack.assets) ? contentPack.assets : [];
      // 方案 E：注入模式判定——勾选 inject 或任务 contentSlot 为 inject 都视为注入（与本地 quests.ts 对齐）
      const isInject = contentPack.inject === true || String(contentSlot || '').trim() === 'inject';
      const assetManifest = [];
      if (assets.length) {
        const ns = `extensions/${taskId}/${submissionKey}`;
        const newFiles = assets
          .map((a) => {
            const rawPath = String((a && a.path) || '').replace(/^\/+/, '');
            const content = typeof (a && a.content) === 'string' ? a.content : '';
            return { path: rawPath ? `${ns}/${rawPath}` : '', content };
          })
          .filter((f) => f.path && f.content);
        // 方案 C：fragment 独立入口 → 用统一 HTML 壳把片段包裹成完整页面（覆盖写入同 path，entryPoint 不变）
        if (contentPack.fragment === true) {
          const rawEP = typeof contentPack.entryPoint === 'string' ? contentPack.entryPoint.replace(/^\/+/, '') : '';
          if (rawEP) {
            const fragPath = `${ns}/${rawEP}`;
            const fragFile = newFiles.find((f) => f.path === fragPath);
            if (fragFile) {
              const wrapped = wrapHtmlFragment(fragFile.content);
              if (wrapped) {
                fragFile.content = wrapped;
                console.log(`[quests merge] fragment 包裹: ${fragPath}`);
              }
            }
          }
        }
        if (newFiles.length) {
          try {
            const gfr = await db.collection('game_files').doc(String(quest.gameId)).get();
            const gfDoc = (gfr && gfr.data && gfr.data[0]) || {};
            const existing = Array.isArray(gfDoc.files) ? gfDoc.files : [];
            // 去掉与新资产同 path 的旧条目，再追加新资产（避免重复，不覆盖其他原文件）
            const merged = existing.filter((f) => !newFiles.some((nf) => nf.path === f.path)).concat(newFiles);
            await db.collection('game_files').doc(String(quest.gameId)).set({
              _id: String(quest.gameId),
              gameId: String(quest.gameId),
              files: merged,
              updatedAt: Date.now(),
            });
            for (const f of newFiles) {
              assetManifest.push({ path: f.path, size: questContentSize(f.content), mimeType: getMimeType(f.path) });
            }
            console.log(`[quests merge] assets 落库: ${quest.gameId}, ${newFiles.length} 个文件 (${ns})`);
          } catch (e) {
            console.warn('[quests merge] assets 落库失败', (e && e.message) || e);
          }
        }
      }

      // ①c 记录扩展入口（P1）：entryPoint 与 assets 元信息写入 published_games[gameId].questExtensions
      const rawEntryPoint = typeof contentPack.entryPoint === 'string' ? contentPack.entryPoint.replace(/^\/+/, '') : '';
      const nsEntry = `extensions/${taskId}/${submissionKey}/`;
      const entryPoint = rawEntryPoint
        ? (assetManifest.some((a) => a.path === nsEntry + rawEntryPoint) ? nsEntry + rawEntryPoint : rawEntryPoint)
        : '';
      // 纯数据提交也写 questExtensions（与本地 quests.ts 对齐）：数据型扩展靠这条记录
      // 在 GamePlay 扩展菜单出 ?ext=<submissionId> 入口，否则合并后玩家永远无法进入该扩展。
      if (assetManifest.length || entryPoint || contentPack.inject === true || !dataIsEmpty) {
        const gresE = await getCollection().where({ id: quest.gameId }).limit(1).get();
        const gdocE = (gresE && gresE.data && gresE.data[0]) || null;
        const exts = Array.isArray(gdocE && gdocE.questExtensions) ? gdocE.questExtensions : [];
        exts.push({
          submissionId: submissionKey,
          slot: contentSlot,
          entryPoint,
          assets: assetManifest,
          inject: contentPack.inject === true ? true : undefined,
          name: quest.title || undefined,
          mergedAt: Date.now(),
        });
        await upsertMerge(quest.gameId, { questExtensions: exts });
      }

      // ①d 注入模式（方案 E）：脚本代码 + 资产清单写入 published_games[gameId].injections，
      // 玩家打开游戏入口 HTML 时由文件分发层/SW/GamePlay 自动拼接执行。游戏零改动即可生效。
      // assets/assetBase 供注入器以 <link> 挂载 CSS 并让脚本用 AllinONE_asset() 引用图片/音频/字体。
      if (isInject) {
        const payload = extractInjectPayload(contentPack);
        if (payload.code || payload.styles.length) {
          const gresI = await getCollection().where({ id: quest.gameId }).limit(1).get();
          const gdocI = (gresI && gresI.data && gresI.data[0]) || null;
          const injs = Array.isArray(gdocI && gdocI.injections) ? gdocI.injections : [];
          if (!injs.some((x) => x.submissionId === submissionKey)) {
            injs.push({
              submissionId: submissionKey,
              name: quest.title || submissionKey,
              slot: contentSlot,
              code: payload.code,
              styles: payload.styles.length ? payload.styles : undefined,
              assets: assetManifest.length ? assetManifest : undefined,
              assetBase: nsEntry,
              mergedAt: Date.now(),
            });
            await upsertMerge(quest.gameId, { injections: injs });
            console.log(`[quests merge] 注入模式合并: ${quest.gameId}, submission=${submissionKey}, code=${payload.code.length} 字节, styles=${payload.styles.length}, assets=${assetManifest.length}`);
          }
        }
      }

      // 报酬发放到平台钱包（游戏币 users.gameCoins + A币凭证 vouchers）
      const reward = quest.reward || {};
      const submitterId = submission.submitterId || 'anonymous';
      const deltas = {};
      // 平台游戏币 → users.gameCoins（读用户文档，加币后按真实 _id 更新；无文档则 add）
      // ⚠️ 修复：旧版 doc(String(submitterId)).set(userDoc) 把加币数据写到 _id=submitterId 的新副本，
      // 玩家原钱包文档（_id 为注册时自动生成）gameCoins 不变 → 钱包余额不涨且产生重复 _openid 文档。
      if (Number(reward.gameCoins) > 0) {
        deltas.gameCoins = Number(reward.gameCoins);
        try {
          const ures = await db.collection('users').where({ _openid: submitterId }).limit(10).get();
          const ulist = (((ures && ures.data) || [])).slice()
            .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
          const userDoc = ulist[0] || null;
          const reason = `任务奖励: ${quest.title}`;
          if (userDoc && userDoc._id) {
            const newGameCoins = (Number(userDoc.gameCoins) || 0) + deltas.gameCoins;
            const hist = Array.isArray(userDoc._walletHistory) ? userDoc._walletHistory : [];
            hist.unshift({
              type: 'quest_reward',
              amount: deltas.gameCoins,
              balance: newGameCoins,
              reason,
              timestamp: Date.now(),
            });
            await db.collection('users').doc(String(userDoc._id)).update({
              gameCoins: newGameCoins,
              updatedAt: Date.now(),
              _walletHistory: hist.slice(0, 100),
            });
          } else {
            await db.collection('users').add({
              _openid: submitterId,
              gameCoins: deltas.gameCoins,
              instantVouchers: 0,
              algorithmVouchers: 0,
              createdAt: Date.now(),
              updatedAt: Date.now(),
              _walletHistory: [{ type: 'quest_reward', amount: deltas.gameCoins, balance: deltas.gameCoins, reason, timestamp: Date.now() }],
            });
          }
        } catch (e) {
          console.warn('[quests merge] 发放平台游戏币失败', (e && e.message) || e);
        }
      }
      // A币 → 创建 A币凭证发给提交者（vouchers 集合）
      if (Number(reward.aCoins) > 0) {
        deltas.aCoins = Number(reward.aCoins);
        try {
          const now = Date.now();
          const vid = `voucher_${now}_${Math.random().toString(36).slice(2, 8)}`;
          const voucher = {
            _id: vid,
            id: vid,
            serialNumber: `AC-${now}-${String(Math.floor(Math.random() * 9000) + 1000)}`,
            denomination: deltas.aCoins,
            currentHolderId: submitterId,
            currentHolderName: submission.submitterName || submitterId,
            status: 'active',
            createdAt: now,
            createdBy: 'quest-reward',
            createdByName: '任务系统',
            sourceType: 'instant',
            category: 'currency',
            transferCount: 0,
            metadata: {
              name: `任务奖励 ${deltas.aCoins} A币`,
              reason: `任务奖励: ${quest.title}`,
            },
          };
          await gsAppend('vouchers', voucher);
        } catch (e) {
          console.warn('[quests merge] 发放 A币凭证失败', (e && e.message) || e);
        }
      }

      // 提交状态 → merged
      const finalSub = Object.assign({}, submission, { status: 'merged', mergedAt: Date.now() });
      await gsUpsert(subsCol, subId || submission._id, finalSub);

      // escrow 释放 + developer 资金源发放流水（P1）
      const escrow = Object.assign({}, quest.escrow || {}, { status: 'released' });
      if (escrow.source === 'developer') {
        await gsAppend('game_developer_transactions', {
          _id: `devtx_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          accountId: `game-${quest.gameId}`,
          gameId: quest.gameId,
          type: 'quest_payout',
          amount: Number(reward.gameCoins) || 0,
          currency: 'gameCoins',
          description: `任务报酬发放: ${quest.title}`,
          timestamp: Date.now(),
        }).catch(() => {});
      }

      // 任务 → merged
      await gsUpsert(questsCol, taskId, Object.assign({}, quest, { status: 'merged', escrow }));

      return buildResponse(200, {
        success: true,
        data: { merged: true, slot: contentSlot, reward: deltas, submissionId: subId || submission._id, deduplicated },
      });
    }

    return buildResponse(405, { success: false, error: 'quests method not allowed' });
  },
};

exports.main = async (event, context) => {
  // ★ Timer trigger 适配：定时器 event 非 HTTP 形状 → 伪装成 POST /__contract/tick 走正常流程
  if (event && (event.Type === 'Timer' || event.TriggerName === 'contractTick')) {
    event = Object.assign({}, event, {
      httpMethod: 'POST',
      path: '/api/v1/games/__contract/tick',
      body: JSON.stringify({ source: 'timer' }),
      headers: {},
    });
    // 同一 timer 顺带驱动限时活动状态机（幂等；失败不阻断合约 tick）
    try { await eventTickCloud(); } catch (e) { console.error('[event] timer tick 失败', e && e.message); }
  }
  const httpMethod = (event.httpMethod || 'GET').toUpperCase();
  // 冷启动预热游戏内服务集合（仅实例首次调用执行，确保集合已就绪）
  await warmupGameSvcCollections();
  let path = event.path || '/';
  let rawBody = event.body || '';
  // 方案 A：?ext=<submissionId> —— 决定入口 HTML 注入哪一个扩展（无 ext = 纯净原版，不注入）。
  // CloudBase 访问服务可能把 query 放在 event.path / queryStringParameters / queryString 任一处，全部合并。
  const reqQuery = Object.assign(
    {},
    parseQuery(event.path || ''),
    event.queryStringParameters || {},
    event.queryString ? parseQuery('?' + event.queryString) : {},
  );
  const extParam = typeof reqQuery.ext === 'string' ? reqQuery.ext : '';

  if (event.isBase64Encoded && rawBody) {
    rawBody = Buffer.from(rawBody, 'base64').toString('utf8');
  }

  let payload = {};
  if (rawBody) {
    try {
      payload = JSON.parse(rawBody);
    } catch (_) {
      payload = {};
    }
  }

  // 预检请求
  if (httpMethod === 'OPTIONS') {
    return buildResponse(204, {}, {});
  }

  const segments = parseSubPath(path);

  try {
    await ensureCollection();

    // POST /api/v1/games/dev-token → 签发开发令牌（桥接 CloudBase Auth 与 JWT）
    // 云函数不需要 JWT 认证（使用 admin SDK 直接操作 DB），但前端 authTokenService
    // 依赖此端点获取 token。返回一个简单的 HMAC-SHA256 签名 token。
    if (httpMethod === 'POST' && segments.length === 1 && segments[0] === 'dev-token') {
      const userId = payload.userId || 'anonymous';
      if (!userId || typeof userId !== 'string') {
        return buildResponse(400, { success: false, error: 'Missing userId' });
      }
      // 🆕 角色随签发写入 JWT（合约隧道 requireAdmin 依赖）；白名单防越权注入
      const rawRole = String(payload.role || 'player');
      const safeRole = ['player', 'admin', 'platform', 'developer'].includes(rawRole) ? rawRole : 'player';
      try {
        const crypto = require('crypto');
        const secret = process.env.JWT_SECRET || 'allinone-platform-2026';
        const now = Math.floor(Date.now() / 1000);
        const exp = now + 24 * 3600; // 24h
        // 生成兼容 JWT 格式的 token（header.payload.signature）
        const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
        const payloadJson = Buffer.from(JSON.stringify({ userId, role: safeRole, iat: now, exp })).toString('base64url');
        const signature = crypto.createHmac('sha256', secret).update(header + '.' + payloadJson).digest('base64url');
        const token = header + '.' + payloadJson + '.' + signature;
        return buildResponse(200, { success: true, data: { token } });
      } catch (e) {
        const msg = (e && e.message) || String(e);
        return buildResponse(500, { success: false, error: 'Token generation failed: ' + msg });
      }
    }

    // ----------------------------------------------------------
    // 通用集合同步路由（Bug 013 修复 + 泛化）
    // 覆盖凭证 / 提案 / 市场 / 兑换码 / 平台配置等需跨浏览器共享的集合
    // 必须放在游戏 id 路由之前，否则 segments[0] 会被当成 gameId 而命中 game not found
    // ----------------------------------------------------------
    const SYNC_COLLECTIONS = [
      // 凭证系统
      'vouchers', 'voucher_templates', 'purchases', 'voucher_transactions',
      // 提案 / 治理
      'proposals', 'vote_thresholds', 'penalty_logs',
      // 市场
      'market_listings',
      // 钱包 / 背包（只读同步，写入被拒）
      'users', 'transactions', 'inventories',
      // 兑换码
      'redeem_hosted_items', 'redeem_codes', 'redeem_purchases',
      // 平台配置
      'platform_treasury', 'game_stores', 'platform_config',
      // 扩展凭证
      'extension_vouchers',
      // 商店商品（与 purchases 购买记录分离）
      'store_products',
    ];
    // 只读集合：仅允许 GET；写入涉及资金/资产，公开无鉴权写端点风险过高
    // 🆕 B2 防刷（2026-09-22）：vouchers / voucher_transactions / market_listings / purchases
    // 移入只读——这是「伪造凭证进云端」（V1：一条 curl 即可铸造跨浏览器凭证）的根治点。
    // 写入改为唯一业务入口：
    //   凭证/交易记录 → POST /__item/sync、/__item/mint（结构校验+限额+幂等+服务端签名）
    //   市场挂牌/成交 → POST /__market/list、/__market/buy、/__market/unlist（服务端核对凭证）
    // ⚠️ 部署本版本时必须同步发布前端（B3/B4 改造后的 build），否则旧前端的
    // saveVoucherToBackend 直写会得到 403（只影响云同步，本地功能不中断）。
    const READ_ONLY_COLLECTIONS = [
      'users', 'transactions', 'inventories',
      'vouchers', 'voucher_transactions',
      'market_listings', 'purchases',
    ];

    if (segments.length >= 1 && SYNC_COLLECTIONS.includes(segments[0])) {
      const colName = segments[0];
      const isReadOnly = READ_ONLY_COLLECTIONS.includes(colName);

      // GET /:collection?skip=0&limit=200 → 分页公开读取（跨浏览器共享）
      if (httpMethod === 'GET') {
        const q = parseQuery(path);
        const skip = Math.max(0, parseInt(q.skip || '0', 10) || 0);
        const limit = Math.min(200, Math.max(1, parseInt(q.limit || '200', 10) || 200));
        try {
          const res = await db.collection(colName).skip(skip).limit(limit).get();
          return buildResponse(200, { success: true, data: { list: res.data || [], skip, limit } });
        } catch (e) {
          const msg = (e && e.message) || String(e);
          // 集合不存在/读取失败：返回空列表而非 500，避免前端轮询刷屏
          console.warn('[sync] GET 失败:', colName, msg);
          return buildResponse(200, { success: false, error: msg, data: { list: [], skip, limit } });
        }
      }

      if (isReadOnly && httpMethod !== 'GET') {
        return buildResponse(403, { success: false, error: 'read-only collection: ' + colName });
      }

      // POST /:collection/batch → 批量 upsert（body: { docs: [...] }，单批上限 200）
      if (httpMethod === 'POST' && segments[1] === 'batch') {
        const docs = (payload && payload.docs) || [];
        if (!Array.isArray(docs)) {
          return buildResponse(400, { success: false, error: 'docs must be an array' });
        }
        if (docs.length > 200) {
          return buildResponse(400, { success: false, error: 'batch size exceeds 200' });
        }
        let ok = 0;
        const failed = [];
        for (const doc of docs) {
          if (!doc || !doc.id) { failed.push(null); continue; }
          try {
            await db.collection(colName).doc(String(doc.id)).set(doc);
            ok++;
          } catch (e) {
            failed.push(String(doc.id));
          }
        }
        return buildResponse(200, { success: true, data: { upserted: ok, failed } });
      }

      // POST /:collection（或 /:collection/:id） → upsert 单条
      if (httpMethod === 'POST') {
        const doc = payload;
        if (!doc || !doc.id) {
          return buildResponse(400, { success: false, error: 'missing doc.id' });
        }
        try {
          const r = await db.collection(colName).doc(String(doc.id)).set(doc);
          return buildResponse(200, { success: true, data: { id: doc.id, updated: (r && r.updated) || 0 } });
        } catch (e) {
          const msg = (e && e.message) || String(e);
          console.warn('[sync] POST 单条失败:', colName, doc.id, msg);
          return buildResponse(200, { success: false, error: msg });
        }
      }

      // DELETE /:collection/:id → 删除单条
      if (httpMethod === 'DELETE' && segments.length >= 2) {
        const r = await db.collection(colName).doc(String(segments[1])).remove();
        return buildResponse(200, { success: true, data: { id: segments[1], deleted: (r && (r.deleted || r.removed)) || 0 } });
      }

      return buildResponse(405, { success: false, error: 'method not allowed for collection: ' + colName });
    }

    // ----------------------------------------------------------
    // 游戏文件专用集合 game_files（跨浏览器匿名直读，绕开云存储权限限制）
    // 前端发布时把文件内容 POST 到此；SW 取文件时优先从此集合读。
    // ----------------------------------------------------------
    if (segments.length === 1 && segments[0] === '__files') {
      if (httpMethod === 'POST') {
        const gameId = payload && payload.gameId;
        const files = payload && payload.files;
        if (!gameId || !Array.isArray(files)) {
          return buildResponse(400, { success: false, error: 'missing gameId or files[]' });
        }
        // 仅保留必要的 path/content 字段，减小文档体积
        const slim = files
          .map((f) => ({
            path: (f.path || f.fileName || '').replace(/^\/+/, ''),
            content: typeof f.content === 'string' ? f.content : '',
          }))
          .filter((f) => f.path && f.content);
        try {
          await db
            .collection('game_files')
            .doc(String(gameId))
            .set({ _id: String(gameId), gameId: String(gameId), files: slim, updatedAt: Date.now() });
          return buildResponse(200, { success: true, data: { gameId, fileCount: slim.length } });
        } catch (e) {
          const msg = (e && e.message) || String(e);
          return buildResponse(500, { success: false, error: 'save game_files failed: ' + msg });
        }
      }
      return buildResponse(405, { success: false, error: 'method not allowed for __files' });
    }

    // ----------------------------------------------------------
    // 游戏审核隧道：__review（与本地 src/server/routes/gameReview.ts 对齐）
    // 必须排在 gameId 路由之前，否则 __review 被当 gameId
    //   POST /__review/admin-login     — 审核管理员登录（独立账号密码，签发 role=admin JWT）
    //   GET  /__review/list?status=    — 审核队列列表 [admin]
    //   GET  /__review/records/:gameId — 完整审核记录 [admin]
    //   POST /__review/submit          — 发布者提交审核（pending + 自动预检）
    //   POST /__review/decide          — 审核决定（approve/reject/changes_required）[admin]
    //   POST /__review/takedown        — 下架已上架游戏 [admin]
    // ----------------------------------------------------------
    if (segments.length >= 1 && segments[0] === '__review') {
      const sub = segments.slice(1);
      const reviewQuery = Object.assign(
        {},
        parseQuery(path),
        event.queryStringParameters || {},
        event.queryString ? parseQuery('?' + event.queryString) : {}
      );

      // POST /__review/admin-login
      if (httpMethod === 'POST' && sub.length === 1 && sub[0] === 'admin-login') {
        const username = (payload && payload.username) || '';
        const password = (payload && payload.password) || '';
        if (!username || !password) {
          return buildResponse(400, { success: false, error: '请输入管理员账号和密码' });
        }
        if (username !== REVIEW_ADMIN_USER || password !== REVIEW_ADMIN_PASS) {
          console.warn('[gameReview] 管理员登录失败（账号或密码错误）:', username);
          return buildResponse(401, { success: false, error: '管理员账号或密码错误' });
        }
        const adminId = 'review-admin:' + username;
        const now = Math.floor(Date.now() / 1000);
        const token = signJwt({ userId: adminId, role: 'admin', iat: now, exp: now + 24 * 3600 }, REVIEW_JWT_SECRET);
        console.log('[gameReview] 管理员登录成功:', adminId);
        return buildResponse(200, {
          success: true,
          data: { token, adminId, adminName: username, expiresAt: Date.now() + 24 * 60 * 60 * 1000 },
        });
      }

      // GET /__review/list?status=pending
      if (httpMethod === 'GET' && sub.length === 1 && sub[0] === 'list') {
        const denied = requireAdmin(event);
        if (denied) return denied;
        const statusFilter = typeof reviewQuery.status === 'string' ? reviewQuery.status : '';
        try {
          // 列表剔除大字段（entryHtmlContent），审核摘要不需要
          const res = await getCollection().field({ entryHtmlContent: false }).limit(1000).get();
          let games = res.data || [];
          if (statusFilter) {
            games = games.filter((g) => (g.reviewStatus || 'approved') === statusFilter);
          }
          const summary = games.map((g) => {
            const records = Array.isArray(g.reviewRecords) ? g.reviewRecords : [];
            const latest = records.length ? records[records.length - 1] : null;
            const autoChecks = (latest && latest.autoChecks) || [];
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
              autoCheckWarningCount: autoChecks.filter((c) => c && !c.passed).length,
              recordCount: records.length,
            };
          });
          return buildResponse(200, { success: true, data: { games: summary, total: summary.length } });
        } catch (e) {
          return buildResponse(500, { success: false, error: 'list failed: ' + ((e && e.message) || e) });
        }
      }

      // GET /__review/records/:gameId
      if (httpMethod === 'GET' && sub.length === 2 && sub[0] === 'records') {
        const denied = requireAdmin(event);
        if (denied) return denied;
        const gameId = sub[1];
        const res = await getCollection().where({ id: gameId }).limit(1).get();
        if (!res.data || res.data.length === 0) {
          return buildResponse(404, { success: false, error: '游戏不存在' });
        }
        const doc = res.data[0];
        const records = Array.isArray(doc.reviewRecords) ? doc.reviewRecords : [];
        return buildResponse(200, {
          success: true,
          data: {
            gameId,
            reviewStatus: doc.reviewStatus || 'approved',
            records: records.slice().sort((a, b) => ((b && b.createdAt) || 0) - ((a && a.createdAt) || 0)),
          },
        });
      }

      // POST /__review/submit — 发布者/管理员提交审核
      if (httpMethod === 'POST' && sub.length === 1 && sub[0] === 'submit') {
        const auth = extractAuth(event);
        if (!auth.userId) {
          return buildResponse(401, { success: false, error: '未登录，无法提交审核' });
        }
        const gameId = payload && payload.gameId;
        if (!gameId) return buildResponse(400, { success: false, error: 'missing gameId' });
        const res = await getCollection().where({ id: String(gameId) }).limit(1).get();
        if (!res.data || res.data.length === 0) {
          return buildResponse(404, { success: false, error: '游戏不存在，请先完成发布' });
        }
        const doc = res.data[0];
        // 发布者校验：非管理员必须是发布者本人（publisherId 缺省与 'admin' 平台托管兜底放宽）
        if (!authIsAdmin(auth) && doc.publisherId && doc.publisherId !== 'admin' && doc.publisherId !== auth.userId) {
          return buildResponse(403, { success: false, error: '权限不足：仅游戏发布者或管理员可提交审核' });
        }
        const autoChecks = await runAutomatedChecks(doc);
        const record = {
          id: newRecordId(),
          action: 'submit',
          submitterId: auth.userId,
          submitterName: doc.publisherName || auth.userId,
          note: (payload && payload.note) || '',
          autoChecks,
          createdAt: Date.now(),
        };
        const records = Array.isArray(doc.reviewRecords) ? doc.reviewRecords.slice() : [];
        records.push(record);
        await getCollection().where({ id: String(gameId) }).update({
          reviewStatus: 'pending',
          reviewRecords: records,
          submittedAt: record.createdAt,
          reviewedAt: null,
          reviewedBy: null,
        });
        console.log('[gameReview] 游戏已提交审核:', gameId, 'by', auth.userId);
        return buildResponse(200, { success: true, data: { gameId: String(gameId), reviewStatus: 'pending', autoChecks, record } });
      }

      // POST /__review/decide — 审核决定（approve/reject/changes_required）
      if (httpMethod === 'POST' && sub.length === 1 && sub[0] === 'decide') {
        const denied = requireAdmin(event);
        if (denied) return denied;
        const auth = extractAuth(event);
        const gameId = payload && payload.gameId;
        const result = payload && payload.result;
        if (!gameId || !result) return buildResponse(400, { success: false, error: 'missing gameId or result' });
        if (result !== 'approve' && result !== 'reject' && result !== 'changes_required') {
          return buildResponse(400, { success: false, error: '无效的审核结果: ' + result });
        }
        const res = await getCollection().where({ id: String(gameId) }).limit(1).get();
        if (!res.data || res.data.length === 0) {
          return buildResponse(404, { success: false, error: '游戏不存在' });
        }
        const doc = res.data[0];
        // checklist 校验：逐项核对四大审核条件（后端权威归一化，防伪造）
        const normalized = REVIEW_CHECKLIST_TEMPLATE.map((tpl) => {
          const item = ((payload && payload.checklist) || []).find((c) => c && c.key === tpl.key);
          return {
            key: tpl.key,
            label: tpl.label,
            description: tpl.description,
            passed: !!(item && item.passed),
            note: (item && item.note) || '',
          };
        });
        if (result === 'approve') {
          const failed = normalized.filter((c) => !c.passed);
          if (failed.length > 0) {
            return buildResponse(400, {
              success: false,
              error: '审核未通过硬性条件，不能标记为通过：' + failed.map((f) => f.label).join('、') + ' 未勾选通过',
            });
          }
        } else if (!payload.reason || !String(payload.reason).trim()) {
          return buildResponse(400, { success: false, error: '驳回或要求修改时必须填写原因（将反馈给发布者）' });
        }
        const action = result === 'approve' ? 'approve' : result === 'reject' ? 'reject' : 'changes_required';
        const newStatus = result === 'approve' ? 'approved' : result === 'reject' ? 'rejected' : 'changes_required';
        const adminName = String(auth.userId || '').replace(/^review-admin:/, '');
        const record = {
          id: newRecordId(),
          action,
          adminId: auth.userId,
          adminName,
          reason: payload.reason || '',
          note: payload.note || '',
          checklist: normalized,
          createdAt: Date.now(),
        };
        const records = Array.isArray(doc.reviewRecords) ? doc.reviewRecords.slice() : [];
        records.push(record);
        await getCollection().where({ id: String(gameId) }).update({
          reviewStatus: newStatus,
          reviewRecords: records,
          reviewedAt: record.createdAt,
          reviewedBy: adminName || auth.userId,
        });
        console.log('[gameReview] 审核决定:', gameId, result, 'by', auth.userId);
        return buildResponse(200, { success: true, data: { gameId: String(gameId), reviewStatus: newStatus, record } });
      }

      // POST /__review/takedown — 下架已上架游戏
      if (httpMethod === 'POST' && sub.length === 1 && sub[0] === 'takedown') {
        const denied = requireAdmin(event);
        if (denied) return denied;
        const auth = extractAuth(event);
        const gameId = payload && payload.gameId;
        if (!gameId) return buildResponse(400, { success: false, error: 'missing gameId' });
        if (!payload.reason || !String(payload.reason).trim()) {
          return buildResponse(400, { success: false, error: '下架必须填写原因（便于追溯）' });
        }
        const res = await getCollection().where({ id: String(gameId) }).limit(1).get();
        if (!res.data || res.data.length === 0) {
          return buildResponse(404, { success: false, error: '游戏不存在' });
        }
        const doc = res.data[0];
        const adminName = String(auth.userId || '').replace(/^review-admin:/, '');
        const record = {
          id: newRecordId(),
          action: 'takedown',
          adminId: auth.userId,
          adminName,
          reason: payload.reason,
          note: payload.note || '',
          createdAt: Date.now(),
        };
        const records = Array.isArray(doc.reviewRecords) ? doc.reviewRecords.slice() : [];
        records.push(record);
        await getCollection().where({ id: String(gameId) }).update({
          reviewStatus: 'removed',
          reviewRecords: records,
          reviewedAt: record.createdAt,
          reviewedBy: adminName || auth.userId,
        });
        console.log('[gameReview] 游戏已下架:', gameId, 'by', auth.userId);
        return buildResponse(200, { success: true, data: { gameId: String(gameId), reviewStatus: 'removed', record } });
      }

      return buildResponse(404, { success: false, error: 'not found in __review' });
    }

    // ----------------------------------------------------------
    // 内容工坊隧道：__content（与本地 src/server/routes/content.ts 对齐）
    //   POST /__content/mint            — 铸造内容资产（资产入 game_files，元信息入 content_assets）
    //   GET  /__content?gameId=         — 列表
    //   GET  /__content/:contentId      — 详情
    //   POST /__content/:contentId/remix         — 上架 remix 版（pending，走审核）
    //   PATCH /__content/:contentId/remix-status — 审核（approved → 追加 questExtensions）
    // ----------------------------------------------------------
    if (segments.length >= 1 && segments[0] === '__content') {
      const sub = segments.slice(1); // [] | ['mint'] | [contentId] | [contentId,'remix'] | [contentId,'remix-status']
      const evtQuery = Object.assign(
        {},
        parseQuery(path),
        event.queryStringParameters || {},
        event.queryString ? parseQuery('?' + event.queryString) : {}
      );
      const CONTENT_COL = 'content_assets';
      // 轻量校验（内容凭证按次消费、持有者自担风险，仅做注入模式最小检查）
      const validateContentForMint = (slot, pack) => {
        const issues = [];
        if (pack && pack.inject === true) {
          const assets = Array.isArray(pack.assets) ? pack.assets : [];
          const hasJs = assets.some((a) => String((a && a.path) || '').toLowerCase().endsWith('.js'));
          const hasInline = typeof pack.data === 'object' && pack.data && typeof pack.data.code === 'string' && pack.data.code.trim();
          if (!hasJs && !hasInline) issues.push('注入模式需要提供 .js 资产（或 data.code 内联脚本）');
        }
        return issues;
      };

      // POST /__content/mint
      if (httpMethod === 'POST' && sub.length === 1 && sub[0] === 'mint') {
        const { gameId, contentPack, authorId, authorName } = payload || {};
        if (!gameId || !contentPack || typeof contentPack !== 'object') {
          return buildResponse(400, { success: false, error: 'missing gameId or contentPack' });
        }
        const type = String(contentPack.type || 'custom');
        const slot = String(contentPack.slot || 'inject');
        const name = String(contentPack.name || '未命名内容');

        // 结构校验（内容凭证轻量校验）
        const issues = validateContentForMint(slot, contentPack);
        if (issues && issues.length) {
          return buildResponse(400, { success: false, error: '内容校验未通过: ' + issues.join('; ') });
        }

        const assets = Array.isArray(contentPack.assets) ? contentPack.assets : [];
        const MAX_ASSET = 8 * 1024 * 1024;
        const MAX_TOTAL = 20 * 1024 * 1024;
        let totalSize = 0;
        for (const a of assets) {
          const content = String((a && a.content) || '');
          const size = content.startsWith('__BINARY_BASE64__')
            ? Math.floor((content.length - 16) / 4) * 3
            : Buffer.byteLength(content, 'utf8');
          if (size > MAX_ASSET) return buildResponse(400, { success: false, error: '资产过大: ' + (a.path || '') });
          totalSize += size;
        }
        if (totalSize > MAX_TOTAL) {
          return buildResponse(400, { success: false, error: '内容包总大小超过 20MB 限制' });
        }

        const contentId = 'ct_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

        // ① 资产并入 game_files（路径 content/{contentId}/{path}，合并追加不覆盖原文件）
        if (assets.length) {
          try {
            const gfRes = await db.collection('game_files').doc(String(gameId)).get();
            const gfDoc = gfRes.data && gfRes.data[0];
            const files = Array.isArray(gfDoc && gfDoc.files) ? gfDoc.files.slice() : [];
            for (const a of assets) {
              const path = 'content/' + contentId + '/' + String((a && a.path) || '').replace(/^\/+/, '');
              const content = String((a && a.content) || '');
              const idx = files.findIndex((f) => (f.path || '').replace(/^\/+/, '') === path);
              if (idx >= 0) files[idx] = { path, content };
              else files.push({ path, content });
            }
            await db.collection('game_files').doc(String(gameId)).set({
              _id: String(gameId), gameId: String(gameId), files, updatedAt: Date.now(),
            });
          } catch (e) {
            console.warn('[content] 资产写入 game_files 失败', (e && e.message) || e);
          }
        }

        // ② manifest（不含资产本体）+ 元信息
        const assetManifest = assets.map((a) => ({
          path: 'content/' + contentId + '/' + String((a && a.path) || '').replace(/^\/+/, ''),
          name: String((a && a.path) || ''),
          size: Buffer.byteLength(String((a && a.content) || ''), 'utf8'),
          mimeType: getMimeType(String((a && a.path) || '')),
        }));
        const manifest = Object.assign({}, contentPack, {
          assets: assetManifest,
          type,
          slot,
          name,
          description: String(contentPack.description || ''),
        });
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
          assetBase: 'content/' + contentId + '/',
          createdAt: Date.now(),
        };
        await gsUpsert(CONTENT_COL, contentId, record);
        console.log('[content] mint 成功: ' + contentId + ', game=' + gameId + ', assets=' + assetManifest.length);
        return buildResponse(200, {
          success: true,
          data: { contentId, gameId, manifest, assetBase: 'content/' + contentId + '/', type, slot, name },
        });
      }

      // GET /__content?gameId= → 列表
      if (httpMethod === 'GET' && sub.length === 0) {
        const gameId = evtQuery.gameId || '';
        try {
          let rows = [];
          const res = await db.collection(CONTENT_COL).limit(1000).get();
          rows = (res && res.data) || [];
          if (gameId) rows = rows.filter((c) => c.gameId === gameId);
          rows = rows.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
          return buildResponse(200, { success: true, data: { contents: rows } });
        } catch (e) {
          return buildResponse(200, { success: true, data: { contents: [] }, error: (e && e.message) || '' });
        }
      }

      // GET /__content/:contentId → 详情
      if (httpMethod === 'GET' && sub.length === 1) {
        const res = await db.collection(CONTENT_COL).doc(sub[0]).get();
        const doc = (res && res.data && res.data[0]) || null;
        if (!doc) return buildResponse(404, { success: false, error: 'content not found' });
        return buildResponse(200, { success: true, data: doc });
      }

      // POST /__content/:contentId/remix → 上架 remix 版（pending）
      if (httpMethod === 'POST' && sub.length === 2 && sub[1] === 'remix') {
        const cid = sub[0];
        const res = await db.collection(CONTENT_COL).doc(cid).get();
        const doc = (res && res.data && res.data[0]) || null;
        if (!doc) return buildResponse(404, { success: false, error: 'content not found' });
        const remix = {
          status: 'pending',
          entryPoint: String((payload && payload.entryPoint) || ''),
          slot: String((payload && payload.slot) || doc.slot || ''),
          requestedAt: Date.now(),
        };
        await gsUpsert(CONTENT_COL, cid, Object.assign({}, doc, { remix }));
        return buildResponse(200, { success: true, data: { contentId: cid, remix } });
      }

      // PATCH /__content/:contentId/remix-status → 审核
      if (httpMethod === 'PATCH' && sub.length === 2 && sub[1] === 'remix-status') {
        const cid = sub[0];
        const status = payload && payload.status;
        if (status !== 'approved' && status !== 'rejected') {
          return buildResponse(400, { success: false, error: 'status must be approved or rejected' });
        }
        const res = await db.collection(CONTENT_COL).doc(cid).get();
        const doc = (res && res.data && res.data[0]) || null;
        if (!doc) return buildResponse(404, { success: false, error: 'content not found' });
        const updated = Object.assign({}, doc, {
          remix: Object.assign({}, doc.remix || {}, {
            status,
            reviewedAt: Date.now(),
            reviewerId: String((payload && payload.reviewerId) || ''),
          }),
        });
        // 通过审核 → 追加 questExtensions（公开发行 remix 版）
        if (status === 'approved' && doc.gameId) {
          try {
            const gres = await getCollection().where({ id: doc.gameId }).limit(1).get();
            const gdoc = (gres && gres.data && gres.data[0]) || null;
            const extList = Array.isArray(gdoc && gdoc.questExtensions) ? gdoc.questExtensions.slice() : [];
            if (!extList.some((x) => x.submissionId === cid)) {
              extList.push({
                submissionId: cid,
                slot: String(doc.slot || ''),
                entryPoint: String((doc.remix && doc.remix.entryPoint) || ''),
                assets: Array.isArray(doc.manifest && doc.manifest.assets) ? doc.manifest.assets : [],
                mergedAt: Date.now(),
                inject: false,
                name: doc.name,
              });
              await upsertMerge(doc.gameId, { questExtensions: extList });
            }
          } catch (e) {
            console.warn('[content] remix 通过后追加 questExtensions 失败', (e && e.message) || e);
          }
        }
        await gsUpsert(CONTENT_COL, cid, updated);
        return buildResponse(200, { success: true, data: { contentId: cid, remix: updated.remix } });
      }

      return buildResponse(405, { success: false, error: 'method not allowed for __content' });
    }

    // ----------------------------------------------------------
    // 道具凭证安全隧道：__item（B2 防刷，与本地 src/server/routes/games.ts 对齐）
    // vouchers / voucher_transactions 公开写已摘除（READ_ONLY 403），云端写入唯一入口：
    //   POST /__item/mint    — 道具提取铸造（JWT身份→schema白名单→参数范围→每日限额→harvestId云端幂等→HMAC签名）
    //   POST /__item/update  — 凭证状态迁移（不创建新文档；reviewStatus 变更需 admin）
    //   POST /__item/sync    — VoucherDatabase 通用同步（结构校验+大小限制；服务端签名文档关键字段保护）
    //   POST /__item/verify  — 批量凭证校验（市场上架/兑换前调用）
    //   GET  /__item/harvest-limit?gameId= — 今日剩余提取额度
    // 身份从 JWT 解析（绝不信 body）。已知限制：dev-token 匿名可领（用户决策：暂不接真实登录），
    // 防刷强度来自 服务端限额+幂等+白名单+签名，伪造者即使持合法 token 也无法铸造超范围道具。
    // ----------------------------------------------------------
    if (segments.length >= 1 && segments[0] === '__item') {
      const sub = segments.slice(1);
      const ITEM_DAILY_LIMIT = await getPlatformRule('item_harvest.daily_limit', 10); // 规则注册中心：每日提取上限
      const MAX_ITEM_DATA = 8 * 1024;    // 与前端 MAX_ITEM_DATA_SIZE 一致
      const MAX_EFFECT_CODE = 4000;
      const MAX_VOUCHER_DOC = 16 * 1024;
      const MAX_TX_DOC = 8 * 1024;

      const itemAuth = extractAuth(event);
      if (!itemAuth.userId) {
        return buildResponse(401, { success: false, error: '未登录：道具铸造/同步需要 Bearer token' });
      }

      // 实例级内存频控（每用户每分钟 ≤20 次写；实例重启清零，尽力而为的防洪水层）
      const RATE_WINDOW = 60 * 1000;
      const RATE_MAX = 20;
      const rateMap = global.__itemRateMap || (global.__itemRateMap = new Map());
      const rateCheck = (uid, max) => {
        const now = Date.now();
        const limit = max || RATE_MAX;
        const rateKey = limit === RATE_MAX ? uid : uid + ':' + limit;
        const rec = rateMap.get(rateKey);
        if (!rec || now - rec.start > RATE_WINDOW) { rateMap.set(rateKey, { start: now, n: 1 }); return true; }
        rec.n += 1;
        return rec.n <= limit;
      };

      // schema 效果规则表（与前端 SchemaRegistry 内置 schema 的 aiGuide 对齐；
      // 未知 schema 无精确规则，靠结构+大小+每日限额约束）
      const ITEM_EFFECT_RULES = {
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

      const sha1 = (s) => require('crypto').createHash('sha1').update(String(s)).digest('hex');

      // itemData 结构+规则校验 → 问题列表
      const validateItemData = (schemaName, itemData) => {
        const issues = [];
        if (!itemData || typeof itemData !== 'object' || Array.isArray(itemData)) return ['itemData 必须是对象'];
        if (typeof itemData.name !== 'string' || !itemData.name.trim()) issues.push('道具缺少名称');
        if (typeof itemData.effect !== 'string' || !itemData.effect.trim()) issues.push('道具缺少效果定义');
        if (JSON.stringify(itemData).length > MAX_ITEM_DATA) issues.push('itemData 超过 8KB');
        if (itemData.effectCode && String(itemData.effectCode).length > MAX_EFFECT_CODE) issues.push('effectCode 超过 4KB');
        const rules = ITEM_EFFECT_RULES[schemaName];
        if (rules) {
          if (rules.effects.indexOf(itemData.effect) < 0) {
            issues.push('效果 "' + itemData.effect + '" 不在 ' + schemaName + ' 允许的效果列表内');
          }
          const params = itemData.params;
          if (params && typeof params === 'object' && !Array.isArray(params)) {
            const ranges = rules.paramRanges || {};
            for (const key of Object.keys(ranges)) {
              const v = params[key];
              if (typeof v === 'number') {
                const lo = ranges[key][0], hi = ranges[key][1];
                if (v < lo || v > hi) issues.push('参数 ' + key + '=' + v + ' 超出允许范围 [' + lo + ', ' + hi + ']');
              }
            }
            if (rules.colorEnums) {
              const colorKeys = ['color', 'fromColor', 'toColor'];
              for (const ck of colorKeys) {
                const cv = params[ck];
                if (typeof cv === 'string' && rules.colorEnums.indexOf(cv) < 0) issues.push('颜色参数 ' + ck + '=' + cv + ' 不合法');
              }
            }
            if (JSON.stringify(params).length > 1024) issues.push('params 超过 1KB');
          }
        }
        return issues;
      };

      // 高价值判定（与前端 itemHarvestService.isHighValueItem 一致）
      const HIGH_VALUE_RARITIES = ['epic', 'legendary', 'mythic', '史诗', '传说', '神话'];
      const isHighValueItem = (itemData) => {
        if (!itemData || typeof itemData !== 'object') return false;
        if (typeof itemData.effectCode === 'string' && itemData.effectCode.trim()) return true;
        if (typeof itemData.effectScript === 'string' && itemData.effectScript.trim()) return true;
        if (itemData.highValue === true) return true;
        return HIGH_VALUE_RARITIES.indexOf(String(itemData.rarity || '').toLowerCase()) >= 0;
      };

      // 每日限额（云端计数，key=userId:gameId:日期）
      const bumpHarvestDaily = async (userId, gameId) => {
        const day = new Date().toISOString().slice(0, 10);
        const id = userId + ':' + gameId + ':' + day;
        try {
          const res = await db.collection('item_harvest_daily').doc(id).get();
          const doc = (res && res.data && res.data[0]) || null;
          const count = ((doc && doc.count) || 0) + 1;
          await db.collection('item_harvest_daily').doc(id).set({ _id: id, userId, gameId, date: day, count, updatedAt: Date.now() });
          return { ok: count <= ITEM_DAILY_LIMIT, count };
        } catch (e) {
          // 风控计数基础设施故障时放行：不因辅助设施异常打断正常玩家
          return { ok: true, count: 0, degraded: true };
        }
      };

      // 幂等（harvestId 云端去重）→ true=首次
      const checkAndMarkHarvestSeen = async (userId, gameId, dupKey) => {
        const id = 'hs_' + sha1(dupKey);
        try {
          const res = await db.collection('item_harvest_seen').doc(id).get();
          const doc = (res && res.data && res.data[0]) || null;
          if (doc) return false;
          await db.collection('item_harvest_seen').doc(id).set({ _id: id, userId, gameId, key: String(dupKey).slice(0, 300), createdAt: Date.now() });
          return true;
        } catch (e) {
          return true;
        }
      };

      // mint HMAC 完整性签名（secret 与 JWT 同源；部署时轮换 JWT_SECRET 即同步轮换签名密钥）
      const signVoucherIntegrity = (voucherId, userId, gameId, itemHash) => {
        const crypto = require('crypto');
        return 'v1:' + crypto.createHmac('sha256', REVIEW_JWT_SECRET)
          .update(voucherId + '|' + userId + '|' + gameId + '|' + itemHash)
          .digest('hex');
      };
      const verifyVoucherIntegrity = (doc) => {
        try {
          const ig = doc && doc.integrity;
          if (!ig || ig.v !== 1 || !ig.sig || !ig.userId || !ig.gameId) return false;
          return signVoucherIntegrity(doc.id, ig.userId, ig.gameId, ig.itemHash || '') === ig.sig;
        } catch (e) {
          return false;
        }
      };

      // 构造与前端 Voucher 结构兼容的服务端铸造凭证（sourceType='item'，denomination=0）
      const buildItemVoucher = (userId, userName, gameId, schemaName, itemData, dupKey) => {
        const crypto = require('crypto');
        const voucherId = 'vh_' + Date.now().toString(36) + '_' + crypto.randomBytes(4).toString('hex');
        const itemHash = sha1(JSON.stringify(itemData || {}));
        const highValue = isHighValueItem(itemData);
        const itemName = String((itemData && itemData.name) || '未命名道具').slice(0, 50);
        const customData = {
          origin: 'gameplay',
          gameId,
          schemaName,
          harvestId: dupKey,
          harvestedAt: Date.now(),
          gameEffect: {
            schemaName,
            itemId: String((itemData && itemData.effect) || ''),
            quantity: 1,
            itemData: itemData || {},
          },
        };
        if (highValue) { customData.highValue = true; customData.reviewStatus = 'pending'; }
        return {
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
          integrity: {
            v: 1,
            mintedBy: 'server',
            userId,
            gameId,
            itemHash,
            mintedAt: Date.now(),
          },
        };
      };

      // POST /__item/mint — 道具提取唯一铸造口
      if (httpMethod === 'POST' && sub.length === 1 && sub[0] === 'mint') {
        const { gameId, schemaName, itemData, harvestId, userName } = payload || {};
        if (!gameId || !schemaName) {
          return buildResponse(400, { success: false, error: 'missing gameId or schemaName' });
        }
        if (!rateCheck(itemAuth.userId)) {
          return buildResponse(429, { success: false, error: '操作过于频繁，请稍后再试', code: 'rate_limit' });
        }
        const issues = validateItemData(schemaName, itemData);
        if (issues.length) {
          return buildResponse(400, { success: false, error: '道具校验未通过: ' + issues.join('; '), code: 'invalid' });
        }
        const dupKey = harvestId ? (gameId + ':' + String(harvestId)) : (gameId + ':' + sha1(JSON.stringify(itemData || {})));
        const first = await checkAndMarkHarvestSeen(itemAuth.userId, gameId, dupKey);
        if (!first) {
          return buildResponse(409, { success: false, error: '该道具已提取过，请勿重复提取', code: 'duplicate' });
        }
        const daily = await bumpHarvestDaily(itemAuth.userId, gameId);
        if (!daily.ok) {
          return buildResponse(429, {
            success: false,
            error: '今日在该游戏的道具提取次数已达上限（' + ITEM_DAILY_LIMIT + ' 个），明天再来吧',
            code: 'daily_limit',
            data: { remaining: 0 },
          });
        }
        const voucher = buildItemVoucher(itemAuth.userId, userName, gameId, schemaName, itemData, dupKey);
        voucher.integrity.sig = signVoucherIntegrity(voucher.id, itemAuth.userId, gameId, voucher.integrity.itemHash);
        try {
          await db.collection('vouchers').doc(voucher.id).set(voucher);
        } catch (e) {
          // 铸造写入失败：seen 已标记 → 重试会 duplicate（防双花优先于重试体验）
          return buildResponse(500, { success: false, error: '铸造写入失败: ' + ((e && e.message) || e) });
        }
        console.log('[item] mint 成功: ' + voucher.id + ', user=' + itemAuth.userId + ', game=' + gameId + ', schema=' + schemaName + (daily.degraded ? ' [限额降级]' : ''));
        return buildResponse(200, { success: true, data: { voucher, remaining: Math.max(0, ITEM_DAILY_LIMIT - daily.count) } });
      }

      // POST /__item/update — 凭证状态迁移（不创建新文档）
      if (httpMethod === 'POST' && sub.length === 1 && sub[0] === 'update') {
        const { voucherId, patch } = payload || {};
        if (!voucherId || !patch || typeof patch !== 'object') {
          return buildResponse(400, { success: false, error: 'missing voucherId or patch' });
        }
        if (!rateCheck(itemAuth.userId)) {
          return buildResponse(429, { success: false, error: '操作过于频繁，请稍后再试' });
        }
        const ALLOWED_PATCH = ['status', 'currentHolderId', 'currentHolderName', 'frozenAt', 'lastTransferAt', 'transferCount', 'reviewStatus', 'reviewNote', 'reviewedAt', 'reviewedBy'];
        const clean = {};
        for (const k of ALLOWED_PATCH) if (k in patch) clean[k] = patch[k];
        if (Object.keys(clean).length === 0) {
          return buildResponse(400, { success: false, error: 'patch 中无可迁移字段（白名单: ' + ALLOWED_PATCH.join(',') + '）' });
        }
        // 审核状态只能管理员改（防止玩家自行洗白 pending → approved）
        if ('reviewStatus' in clean && !authIsAdmin(itemAuth)) {
          return buildResponse(403, { success: false, error: 'reviewStatus 变更仅管理员可执行' });
        }
        if ('status' in clean && ['active', 'frozen', 'redeemed', 'destroyed', 'expired'].indexOf(clean.status) < 0) {
          return buildResponse(400, { success: false, error: 'status 值非法' });
        }
        try {
          const res = await db.collection('vouchers').doc(String(voucherId)).get();
          const doc = (res && res.data && res.data[0]) || null;
          if (!doc) {
            return buildResponse(404, { success: false, error: '凭证不存在（以云端账本为准）', code: 'not_found' });
          }
          // 持有者核对：非持有者不能动别人的凭证（挡「复制凭证改持有者」类攻击）；admin 豁免
          if (!authIsAdmin(itemAuth) && doc.currentHolderId && doc.currentHolderId !== itemAuth.userId) {
            return buildResponse(403, { success: false, error: '不是该凭证的当前持有者' });
          }
          const updated = Object.assign({}, doc, clean, { updatedAt: Date.now() });
          await db.collection('vouchers').doc(String(voucherId)).set(updated);
          return buildResponse(200, { success: true, data: { id: String(voucherId) } });
        } catch (e) {
          return buildResponse(500, { success: false, error: (e && e.message) || String(e) });
        }
      }

      // POST /__item/sync — VoucherDatabase 通用同步（vouchers / voucher_transactions）
      if (httpMethod === 'POST' && sub.length === 1 && sub[0] === 'sync') {
        const { collection, doc } = payload || {};
        if (collection !== 'vouchers' && collection !== 'voucher_transactions') {
          return buildResponse(400, { success: false, error: 'collection 必须是 vouchers 或 voucher_transactions' });
        }
        if (!doc || !doc.id) return buildResponse(400, { success: false, error: 'missing doc.id' });
        const docLimit = collection === 'vouchers' ? MAX_VOUCHER_DOC : MAX_TX_DOC;
        if (JSON.stringify(doc).length > docLimit) {
          return buildResponse(413, { success: false, error: collection + ' 文档超过 ' + Math.floor(docLimit / 1024) + 'KB 限制' });
        }
        // 平台备货（platform_pool / SYSTEM 等平台账户持有）不属于玩家日常提取，
        // 不受玩家级频控约束（客户端全量兜底一次可推 200+ 条，20/分钟必 429）
        var PLATFORM_HOLDER_IDS = ['platform_pool', 'SYSTEM', 'system', 'PLATFORM_POOL'];
        var holderId = String((doc && doc.currentHolderId) || '');
        var isPlatformStocking = PLATFORM_HOLDER_IDS.indexOf(holderId) !== -1 || PLATFORM_HOLDER_IDS.indexOf(holderId.toLowerCase()) !== -1;
        // 交易是审计日志（幂等 id），放宽到 300/分钟——客户端兜底一次可推 100 条，20/分钟必 429 轰炸
        var txSync = collection === 'voucher_transactions';
        if (!rateCheck(itemAuth.userId, isPlatformStocking || txSync ? 300 : 20)) {
          return buildResponse(429, { success: false, error: '同步过于频繁，请稍后再试' });
        }
        try {
          if (collection === 'vouchers') {
            const res = await db.collection('vouchers').doc(String(doc.id)).get();
            const existing = (res && res.data && res.data[0]) || null;
            // ① 服务端签名文档关键字段保护：不允许客户端覆盖铸造内容/签名
            if (existing && existing.integrity && existing.integrity.mintedBy === 'server') {
              const ALLOWED = ['status', 'currentHolderId', 'currentHolderName', 'frozenAt', 'lastTransferAt', 'transferCount'];
              const merged = Object.assign({}, existing);
              for (const k of ALLOWED) if (k in doc) merged[k] = doc[k];
              merged.updatedAt = Date.now();
              await db.collection('vouchers').doc(String(doc.id)).set(merged);
              return buildResponse(200, { success: true, data: { id: String(doc.id), protected: true } });
            }
            // ② 新建的道具凭证：与 mint 同源的内容校验+每日限额+幂等（堵「绕过 mint 直接 sync 铸道具」）
            const isNew = !existing;
            const isItem = doc.sourceType === 'item' || (doc.metadata && doc.metadata.sourceType === 'item');
            if (isNew && isItem) {
              const cd = (doc.metadata && doc.metadata.customData) || {};
              const itemData = (cd.gameEffect && cd.gameEffect.itemData) || null;
              // schemaName 只在需要校验 itemData 时必填（平台模板凭证 plt-* 无 itemData，不应被拒）
              if (itemData) {
                const schemaName = cd.schemaName || (cd.gameEffect && cd.gameEffect.schemaName) || '';
                if (!schemaName) {
                  return buildResponse(400, { success: false, error: '道具凭证缺少 schemaName（customData.gameEffect.schemaName）' });
                }
                const issues = validateItemData(schemaName, itemData);
                if (issues.length) {
                  return buildResponse(400, { success: false, error: '道具凭证校验未通过: ' + issues.join('; ') });
                }
              }
              // 平台备货（铸造进 platform_pool/SYSTEM 的初始库存）不属于玩家日常提取，
              // 不扣玩家 item_harvest.daily_limit 额度（否则库存备货被 10/日 闸死）
              if (isPlatformStocking) {
                console.log('[item] sync 平台备货入库（免玩家级提取限额）:', String(doc.id), holderId);
              } else {
                const dupKey = cd.harvestId || ('sync:' + doc.id);
                const first = await checkAndMarkHarvestSeen(itemAuth.userId, cd.gameId || 'unknown', String(dupKey));
                if (!first) {
                  return buildResponse(409, { success: false, error: '该道具已提取过（云端幂等）', code: 'duplicate' });
                }
                const daily = await bumpHarvestDaily(itemAuth.userId, cd.gameId || 'unknown');
                if (!daily.ok) {
                  return buildResponse(429, { success: false, error: '今日提取次数已达上限', code: 'daily_limit' });
                }
              }
            }
            await db.collection('vouchers').doc(String(doc.id)).set(doc);
            return buildResponse(200, { success: true, data: { id: String(doc.id) } });
          }
          // voucher_transactions：审计记录（结构+大小已校验）
          await db.collection('voucher_transactions').doc(String(doc.id)).set(doc);
          return buildResponse(200, { success: true, data: { id: String(doc.id) } });
        } catch (e) {
          return buildResponse(500, { success: false, error: (e && e.message) || String(e) });
        }
      }

      // POST /__item/verify — 批量校验（市场上架/兑换/转移前调用）
      if (httpMethod === 'POST' && sub.length === 1 && sub[0] === 'verify') {
        const ids = (payload && Array.isArray(payload.voucherIds)) ? payload.voucherIds.slice(0, 50) : [];
        const out = [];
        for (const vid of ids) {
          try {
            const res = await db.collection('vouchers').doc(String(vid)).get();
            const doc = (res && res.data && res.data[0]) || null;
            out.push({
              id: String(vid),
              exists: !!doc,
              currentHolderId: doc ? doc.currentHolderId : undefined,
              status: doc ? doc.status : undefined,
              reviewStatus: (doc && doc.metadata && doc.metadata.customData) ? doc.metadata.customData.reviewStatus : undefined,
              mintedBy: (doc && doc.integrity) ? doc.integrity.mintedBy : 'client',
              signatureValid: (doc && doc.integrity) ? verifyVoucherIntegrity(doc) : null,
            });
          } catch (e) {
            out.push({ id: String(vid), exists: false, error: (e && e.message) || String(e) });
          }
        }
        return buildResponse(200, { success: true, data: { results: out } });
      }

      // POST /__item/purchase — 购买记录（purchases 收据式写入；结构校验+大小+频控）
      if (httpMethod === 'POST' && sub.length === 1 && sub[0] === 'purchase') {
        const doc = payload && payload.doc;
        if (!doc || !doc.id) return buildResponse(400, { success: false, error: 'missing doc.id' });
        if (JSON.stringify(doc).length > MAX_TX_DOC) {
          return buildResponse(413, { success: false, error: 'purchases 文档超过 8KB 限制' });
        }
        if (!rateCheck(itemAuth.userId)) {
          return buildResponse(429, { success: false, error: '同步过于频繁，请稍后再试' });
        }
        try {
          await db.collection('purchases').doc(String(doc.id)).set(doc);
          return buildResponse(200, { success: true, data: { id: String(doc.id) } });
        } catch (e) {
          return buildResponse(500, { success: false, error: (e && e.message) || String(e) });
        }
      }

      // GET /__item/harvest-limit?gameId=
      if (httpMethod === 'GET' && sub.length === 1 && sub[0] === 'harvest-limit') {
        const q = parseQuery(path);
        const gameId = q.gameId || '';
        if (!gameId) return buildResponse(400, { success: false, error: 'missing gameId' });
        const day = new Date().toISOString().slice(0, 10);
        try {
          const res = await db.collection('item_harvest_daily').doc(itemAuth.userId + ':' + gameId + ':' + day).get();
          const doc = (res && res.data && res.data[0]) || null;
          const count = (doc && doc.count) || 0;
          return buildResponse(200, { success: true, data: { remaining: Math.max(0, ITEM_DAILY_LIMIT - count), limit: ITEM_DAILY_LIMIT } });
        } catch (e) {
          return buildResponse(200, { success: true, data: { remaining: ITEM_DAILY_LIMIT, limit: ITEM_DAILY_LIMIT } });
        }
      }

      return buildResponse(405, { success: false, error: 'method not allowed for __item' });
    }

    // ----------------------------------------------------------
    // 市场安全隧道：__market（B4，与本地 src/server/routes/games.ts 对齐）
    // market_listings / purchases 公开写已摘除（READ_ONLY 403），云写入唯一入口：
    //   POST /__market/list   — 上架（服务端核对：凭证存在+持有者一致+未被使用+审核状态）
    //   POST /__market/buy    — 成交（原子置 sold + 写 purchases 快照；身份取自 token）
    //   POST /__market/unlist — 下架（核对卖家身份）
    // 本地挂牌展示仍走 GET /market_listings 公开读（未摘除读权限）。
    // ----------------------------------------------------------
    if (segments.length >= 1 && segments[0] === '__market') {
      const sub = segments.slice(1);
      const marketAuth = extractAuth(event);
      if (!marketAuth.userId) {
        return buildResponse(401, { success: false, error: '未登录：市场写入需要 Bearer token' });
      }

      const loadListingDoc = async (listingId) => {
        const res = await db.collection('market_listings').doc(String(listingId)).get();
        return (res && res.data && res.data[0]) || null;
      };

      // POST /__market/list { listing }
      if (httpMethod === 'POST' && sub.length === 1 && sub[0] === 'list') {
        const listing = payload && payload.listing;
        if (!listing || !listing.id || !listing.voucherId || !listing.sellerId) {
          return buildResponse(400, { success: false, error: 'missing listing.id / voucherId / sellerId' });
        }
        if (listing.sellerId !== marketAuth.userId) {
          return buildResponse(403, { success: false, error: '上架者身份与 token 不一致' });
        }
        if (typeof listing.price !== 'number' || !(listing.price > 0)) {
          return buildResponse(400, { success: false, error: '价格必须大于 0' });
        }
        try {
          const vres = await db.collection('vouchers').doc(String(listing.voucherId)).get();
          const voucher = (vres && vres.data && vres.data[0]) || null;
          if (!voucher) {
            return buildResponse(400, { success: false, error: '被挂凭证在云端不存在（本地伪造凭证无法上架）', code: 'voucher_missing' });
          }
          if (voucher.currentHolderId !== listing.sellerId) {
            return buildResponse(403, { success: false, error: '被挂凭证不属于你（云端持有者核对失败）', code: 'holder_mismatch' });
          }
          if (voucher.status === 'redeemed' || voucher.status === 'destroyed') {
            return buildResponse(400, { success: false, error: '该凭证已被使用/销毁，无法上架' });
          }
          const reviewStatus = (voucher.metadata && voucher.metadata.customData) ? voucher.metadata.customData.reviewStatus : undefined;
          if (reviewStatus === 'pending') return buildResponse(403, { success: false, error: '高价值道具审核中，暂不能上架' });
          if (reviewStatus === 'rejected') return buildResponse(403, { success: false, error: '该道具未通过平台审核，不能上架' });
          const doc = Object.assign({}, listing, { status: 'active', serverVerifiedAt: Date.now() });
          await db.collection('market_listings').doc(String(listing.id)).set(doc);
          console.log('[market] list: ' + listing.id + ', voucher=' + listing.voucherId + ', seller=' + listing.sellerId + ', price=' + listing.price);
          return buildResponse(200, { success: true, data: { id: String(listing.id) } });
        } catch (e) {
          return buildResponse(500, { success: false, error: (e && e.message) || String(e) });
        }
      }

      // POST /__market/buy { listingId, buyerId, buyerName, paymentTxIds }
      if (httpMethod === 'POST' && sub.length === 1 && sub[0] === 'buy') {
        const { listingId, buyerId, buyerName, paymentTxIds } = payload || {};
        if (!listingId || !buyerId) return buildResponse(400, { success: false, error: 'missing listingId or buyerId' });
        if (buyerId !== marketAuth.userId) {
          return buildResponse(403, { success: false, error: '买家身份与 token 不一致' });
        }
        try {
          const listing = await loadListingDoc(listingId);
          if (!listing) return buildResponse(404, { success: false, error: '挂牌不存在', code: 'not_found' });
          if (listing.status !== 'active') {
            return buildResponse(409, {
              success: false,
              error: listing.status === 'sold' ? '该商品已售出' : '该商品已下架',
              code: 'not_active',
            });
          }
          if (listing.sellerId === buyerId) return buildResponse(400, { success: false, error: '不能购买自己的商品' });
          const updated = Object.assign({}, listing, {
            status: 'sold',
            soldAt: Date.now(),
            buyerId,
            buyerName: String(buyerName || '').slice(0, 50),
            paymentTxIds: Array.isArray(paymentTxIds) ? paymentTxIds.slice(0, 10).map(String) : [],
            soldAtServer: Date.now(),
          });
          await db.collection('market_listings').doc(String(listingId)).set(updated);
          // purchases 交易快照（云端账本）
          const purId = 'pur_' + String(listingId);
          await db.collection('purchases').doc(purId).set({
            _id: purId,
            id: purId,
            listingId: String(listingId),
            voucherId: listing.voucherId,
            itemName: listing.itemName,
            price: listing.price,
            currency: listing.currency,
            sellerId: listing.sellerId,
            sellerName: listing.sellerName,
            buyerId,
            buyerName: String(buyerName || '').slice(0, 50),
            purchasedAt: Date.now(),
          });
          // B2 收益台账（GSO 分账唯一数据源）：服务端记账佣金，确定性 entryId 幂等
          // 规则注册中心：佣金率读取 contract_rules（治理门控修改；未注册回退 0.05）
          try {
            const commissionRate = await getPlatformRule('market.commission_rate', 0.05);
            const commission = Math.round(Number(listing.price) * commissionRate * 100) / 100;
            let revGameId = listing.gameId || '';
            if (!revGameId && listing.voucherId) {
              try {
                const vr = await gsGet('vouchers', String(listing.voucherId));
                const vd = (vr && vr.data && vr.data[0]) || null;
                if (vd) revGameId = vd.gameId || (vd.metadata && vd.metadata.gameId) || '';
              } catch (_) { /* 反查失败不阻塞成交 */ }
            }
            await gsUpsert('revenue_ledger', 'rev_' + String(listingId), {
              entryId: 'rev_' + String(listingId),
              txId: 'rev_' + String(listingId),
              source: 'market_commission',
              gameId: revGameId,
              grossAmount: Number(listing.price) || 0,
              commission,
              currency: listing.currency || 'gameCoins',
              occurredAt: Date.now(),
              refId: String(listingId),
              recordedBy: 'server',
            });
          } catch (revErr) {
            console.warn('[market] revenue_ledger 记账失败（成交不受影响）:', (revErr && revErr.message) || revErr);
          }
          console.log('[market] buy: ' + listingId + ', buyer=' + buyerId + ', price=' + listing.price);
          return buildResponse(200, { success: true, data: { listingId: String(listingId), status: 'sold' } });
        } catch (e) {
          return buildResponse(500, { success: false, error: (e && e.message) || String(e) });
        }
      }

      // POST /__market/unlist { listingId, userId }
      if (httpMethod === 'POST' && sub.length === 1 && sub[0] === 'unlist') {
        const { listingId, userId } = payload || {};
        if (!listingId || !userId) return buildResponse(400, { success: false, error: 'missing listingId or userId' });
        if (userId !== marketAuth.userId) {
          return buildResponse(403, { success: false, error: '下架者身份与 token 不一致' });
        }
        try {
          const listing = await loadListingDoc(listingId);
          if (!listing) return buildResponse(404, { success: false, error: '挂牌不存在', code: 'not_found' });
          if (listing.sellerId !== userId) return buildResponse(403, { success: false, error: '只能下架自己的商品' });
          if (listing.status !== 'active') {
            return buildResponse(409, { success: false, error: '商品已售出或已下架', code: 'not_active' });
          }
          await db.collection('market_listings').doc(String(listingId)).set(
            Object.assign({}, listing, { status: 'cancelled', cancelledAt: Date.now() })
          );
          return buildResponse(200, { success: true, data: { listingId: String(listingId), status: 'cancelled' } });
        } catch (e) {
          return buildResponse(500, { success: false, error: (e && e.message) || String(e) });
        }
      }

      return buildResponse(405, { success: false, error: 'method not allowed for __market' });
    }

    // ----------------------------------------------------------
    // 通知隧道：__notifications（2026-10-11，与本地 src/server/routes/notifications.ts 对齐）
    // 平台级站内信；写入由服务端产生（__contract/deploy 发私域邀请），此处只读+已读
    //   GET  /list?limit=50  本人通知倒序 + unreadCount
    //   POST /read           { ids?: string[] } 缺省 = 全部已读
    // ----------------------------------------------------------
    if (segments.length >= 1 && segments[0] === '__notifications') {
      const nAuth = extractAuth(event);
      if (!nAuth.userId) return buildResponse(401, { success: false, error: '未登录' });
      const nCol = 'notifications';
      const nSub = segments.slice(1);
      if (httpMethod === 'GET' && nSub[0] === 'list') {
        const limit = Math.min(200, Math.max(1, Number((event.queryStringParameters || {}).limit) || 50));
        let rows = [];
        try {
          // 不用 orderBy（prod 单字段索引缺失时 where+orderBy 查询可能失败）——拉取后 JS 排序
          const r = await db.collection(nCol).where({ toUserId: nAuth.userId }).limit(200).get();
          rows = (r && r.data) || [];
        } catch (e) { rows = []; } // 集合不存在（首次）→ 空
        const notifications = rows
          .map((n) => ({ id: n._id || n.id, toUserId: n.toUserId, type: n.type, title: n.title, body: n.body, link: n.link, read: !!n.read, createdAt: n.createdAt, meta: n.meta }))
          .sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0))
          .slice(0, limit);
        return buildResponse(200, { success: true, data: { notifications, unreadCount: notifications.filter((n) => !n.read).length } });
      }
      if (httpMethod === 'POST' && nSub[0] === 'read') {
        const payloadIds = Array.isArray((payload || {}).ids) ? payload.ids.map((x) => String(x || '').trim()).filter(Boolean) : null;
        let updated = 0;
        try {
          const where = payloadIds && payloadIds.length > 0 ? { toUserId: nAuth.userId, _id: db.command.in(payloadIds) } : { toUserId: nAuth.userId, read: false };
          const r = await db.collection(nCol).where(where).update({ read: true, readAt: Date.now() });
          updated = (r && r.updated) || (r && r.stats && r.stats.updated) || 0;
        } catch (e) { updated = 0; }
        return buildResponse(200, { success: true, data: { updated } });
      }
      return buildResponse(405, { success: false, error: 'method not allowed for __notifications' });
    }

    // ----------------------------------------------------------
    // 限时活动隧道：__event（E1-E4，与本地 src/server/routes/limitedEvent.ts 对齐）
    //   GET  /current          活跃+预热活动摘要（含 serverNow；前端动态导入信号）
    //   GET  /:id/detail       详情 + 阶段 + 全服进度
    //   GET  /:id/leaderboard  排行榜快照
    //   POST /tick             状态机 tick（timer trigger + 惰性触发；幂等）
    //   POST /:id/join|submit|claim、GET /:id/progress（Bearer）
    //   GET /admin/list、POST /admin/create|update|force-stop|resettle（admin JWT）
    // 发放幂等：event_grants doc id = grant_<eventId>_<userId>_<rewardId>
    // ----------------------------------------------------------
    if (segments.length >= 1 && segments[0] === '__event') {
      const evSub = segments.slice(1);
      const evId0 = evSub[0] || '';
      const evNow = Date.now();
      const evAuth = extractAuth(event);
      const evLoad = async function (id) {
        const r = await db.collection('limited_events').doc(String(id)).get().catch(function () { return null; });
        const d = r && r.data && r.data.length > 0 ? r.data[0] : (r && r.data) || null;
        return d ? Object.assign({}, d, { id: d.id || d._id }) : null;
      };
      const evPart = async function (eventId, userId) {
        const r = await db.collection('event_participations').doc(eventId + ':' + userId).get().catch(function () { return null; });
        const d = r && r.data && r.data.length > 0 ? r.data[0] : (r && r.data) || null;
        return d || null;
      };
      const evSavePart = function (p) { return gsUpsert('event_participations', p.id, p); };
      const evGrantsOf = async function (eventId, userId) {
        return evListAll('event_grants', userId ? { eventId: eventId, userId: userId } : { eventId: eventId });
      };
      // 计算可领奖励（threshold/participation；leaderboard 仅结算任务发放）
      const evClaimables = function (e, p, grantedIds) {
        const out = [];
        const collectRules = function (rules, metrics, contrib) {
          (rules || []).forEach(function (r) {
            if (r.kind === 'leaderboard') return;
            let cur, reached;
            if (r.kind === 'participation') {
              cur = Object.keys(metrics).reduce(function (a, k) { return a + metrics[k]; }, 0);
              reached = cur > 0;
            } else if (r.stageId) {
              cur = contrib[r.stageId] || 0;
              reached = cur >= (r.threshold || 1);
            } else {
              cur = metrics[r.metric] || 0;
              reached = cur >= (r.threshold || 1);
            }
            out.push({
              rewardId: r.id, kind: r.kind,
              label: r.kind === 'participation' ? '参与奖' : '达成 ' + (r.threshold || 1) + ' ' + r.metric,
              progress: { current: cur, target: r.kind === 'participation' ? null : r.threshold || 1 },
              reward: r.reward, claimable: !!p && reached && grantedIds.indexOf(r.id) < 0,
              claimed: grantedIds.indexOf(r.id) >= 0,
            });
          });
        };
        collectRules(e.rewardRules, (p && p.metrics) || {}, (p && p.stageContrib) || {});
        (e.config && e.config.stages || []).forEach(function (s) { collectRules(s.rewards, (p && p.metrics) || {}, (p && p.stageContrib) || {}); });
        return out;
      };

      // GET /current
      if (httpMethod === 'GET' && evId0 === 'current') {
        let tickR = null;
        try { tickR = await eventTickCloud(); } catch (e) { /* 惰性 tick 失败不阻断读取 */ }
        const events = await evListAll('limited_events');
        const visible = events.filter(function (raw) {
          const e = Object.assign({}, raw, { id: raw.id || raw._id });
          return e.enabled && !Number(e.forceStopAt || 0) &&
            ['scheduled', 'live', 'closing'].indexOf(e.status) >= 0 &&
            evNow >= e.startTime - Number(e.leadHours || 0) * EV_HOUR_MS &&
            evNow < e.endTime + Number(e.graceHours ?? 72) * EV_HOUR_MS;
        }).map(function (raw) {
          const e = Object.assign({}, raw, { id: raw.id || raw._id });
          return {
            id: e.id, slug: e.slug, name: e.name, type: e.type, status: e.status,
            startTime: e.startTime, endTime: e.endTime, graceHours: e.graceHours,
            serverNow: evNow, description: (e.config && e.config.description) || '',
            metric: evDefaultMetric(e),
          };
        });
        return buildResponse(200, { success: true, data: { serverNow: evNow, events: visible, tick: tickR } });
      }

      // POST /tick
      if (httpMethod === 'POST' && evId0 === 'tick') {
        try {
          return buildResponse(200, { success: true, data: await eventTickCloud() });
        } catch (e) {
          return buildResponse(500, { success: false, error: String((e && e.message) || e) });
        }
      }

      // GET /admin/list（admin JWT）
      if (httpMethod === 'GET' && evId0 === 'admin' && evSub[1] === 'list') {
        const admErr = requireAdmin(event);
        if (admErr) return admErr;
        const events = await evListAll('limited_events');
        const filter = String((event.queryStringParameters || {}).filter || 'all');
        const list = events.filter(function (e) { return filter === 'all' || e.status === filter; });
        return buildResponse(200, { success: true, data: { events: list, archivedCount: events.filter(function (e) { return e.status === 'archived'; }).length } });
      }

      // POST /admin/create|update|force-stop|resettle
      if (httpMethod === 'POST' && evId0 === 'admin' && evSub[1]) {
        const admErr = requireAdmin(event);
        if (admErr) return admErr;
        const action = evSub[1];
        if (action === 'create') {
          const slug = String((payload || {}).slug || '').trim();
          if (!slug) return buildResponse(400, { success: false, error: '缺少 slug' });
          const events = await evListAll('limited_events');
          const seq = events.filter(function (x) { return x.slug === slug; }).length;
          const e = {
            id: String((payload || {}).id || 'evt_' + slug + '_' + (seq + 1)),
            slug: slug, name: String((payload || {}).name || slug), type: (payload || {}).type || 'collect',
            status: 'draft', enabled: (payload || {}).enabled !== false,
            startTime: Number((payload || {}).startTime) || evNow,
            endTime: Number((payload || {}).endTime) || evNow + 7 * EV_DAY_MS,
            leadHours: Number((payload || {}).leadHours) || 0,
            // ⚠️ Number(undefined)=NaN；原三元表达式有优先级错误 → graceHours=NaN → closing 永不结算
            graceHours: Number.isFinite(Number((payload || {}).graceHours)) ? Number((payload || {}).graceHours) : 72,
            repeat: (payload || {}).repeat || null,
            config: (payload || {}).config || {}, rewardRules: (payload || {}).rewardRules || [],
            rollout: (payload || {}).rollout || { mode: 'all' },
            settleManifest: null, createdAt: evNow, updatedAt: evNow,
          };
          const dup = await evLoad(e.id);
          if (dup) return buildResponse(409, { success: false, error: '活动 id 已存在: ' + e.id });
          await gsUpsert('limited_events', e.id, e);
          try { await eventTickCloud(); } catch (err) {}
          return buildResponse(200, { success: true, data: { event: e } });
        }
        if (action === 'update' || action === 'force-stop') {
          const id = String((payload || {}).id || '');
          const e = await evLoad(id);
          if (!e) return buildResponse(404, { success: false, error: '活动不存在' });
          let updated = Object.assign({}, e);
          if (action === 'force-stop') {
            updated.enabled = false;
            updated.forceStopAt = Date.now();
          } else {
            ['name', 'enabled', 'startTime', 'endTime', 'leadHours', 'graceHours', 'repeat', 'config', 'rewardRules', 'rollout'].forEach(function (k) {
              if ((payload || {})[k] !== undefined) updated[k] = payload[k];
            });
            // 数值归一化：NaN 污染状态机比较（now >= NaN 恒 false → 永卡当前状态）
            ['startTime', 'endTime', 'leadHours', 'graceHours'].forEach(function (k) {
              if (updated[k] !== undefined) {
                if (!Number.isFinite(Number(updated[k]))) delete updated[k];
                else updated[k] = Number(updated[k]);
              }
            });
          }
          updated.updatedAt = Date.now();
          delete updated._id;
          await gsUpsert('limited_events', id, updated);
          try { await eventTickCloud(); } catch (err) {}
          return buildResponse(200, { success: true, data: { event: updated } });
        }
        if (action === 'resettle') {
          const id = String((payload || {}).id || '');
          const e = await evLoad(id);
          if (!e) return buildResponse(404, { success: false, error: '活动不存在' });
          const settled = await evSettle(Object.assign({}, e, { settleManifest: null }));
          delete settled._id;
          await gsUpsert('limited_events', id, settled);
          return buildResponse(200, { success: true, data: { manifest: settled.settleManifest } });
        }
        return buildResponse(404, { success: false, error: 'unknown admin action' });
      }

      // ----- 以下为按活动 id 的端点 -----
      const ev = await evLoad(evId0);
      if (!ev) return buildResponse(404, { success: false, error: '活动不存在' });

      // GET /:id/detail
      if (httpMethod === 'GET' && evSub[1] === 'detail') {
        if (!ev.enabled) return buildResponse(404, { success: false, error: '活动不存在' });
        const stages = (ev.config && ev.config.stages) || [];
        const stageProgress = [];
        for (const s of stages) {
          const r = await db.collection('event_stage_progress').doc(s.id).get().catch(function () { return null; });
          const d = r && r.data && r.data.length > 0 ? r.data[0] : (r && r.data) || null;
          if (d) stageProgress.push(d);
        }
        const metric = (ev.config && ev.config.leaderboardMetric) || evDefaultMetric(ev);
        const parts = await evListAll('event_participations', { eventId: ev.id });
        return buildResponse(200, {
          success: true,
          data: {
            serverNow: evNow, event: ev, stageProgress: stageProgress,
            leaderboard: evLeaderboard(parts, metric, 20), totalParticipants: parts.length,
          },
        });
      }

      // GET /:id/leaderboard
      if (httpMethod === 'GET' && evSub[1] === 'leaderboard') {
        const metric = (ev.config && ev.config.leaderboardMetric) || evDefaultMetric(ev);
        const parts = await evListAll('event_participations', { eventId: ev.id });
        return buildResponse(200, { success: true, data: { leaderboard: evLeaderboard(parts, metric, 50), metric: metric } });
      }

      // 认证端点：join / submit / progress / claim
      if (!evAuth.userId) return buildResponse(401, { success: false, error: '未登录' });

      if (httpMethod === 'POST' && evSub[1] === 'join') {
        const gate = evCheckGate(ev, evAuth.userId, evNow, 'live');
        if (!gate.ok) return buildResponse(gate.code, { success: false, error: gate.error, data: gate.payload });
        let p = await evPart(ev.id, evAuth.userId);
        if (p) return buildResponse(200, { success: true, data: { participation: p, alreadyJoined: true } });
        p = {
          id: ev.id + ':' + evAuth.userId, eventId: ev.id, userId: evAuth.userId, joinedAt: evNow,
          metrics: {}, submissions: 0, submissionsToday: 0, submissionsDate: evDayKey(evNow),
          stageContrib: {}, lastSubmitAt: 0,
        };
        await evSavePart(p);
        return buildResponse(200, { success: true, data: { participation: p, alreadyJoined: false } });
      }

      if (httpMethod === 'POST' && evSub[1] === 'submit') {
        const gate = evCheckGate(ev, evAuth.userId, evNow, 'live');
        if (!gate.ok) return buildResponse(gate.code, { success: false, error: gate.error, data: gate.payload });
        const metric = String((payload || {}).metric || '');
        const value = Number((payload || {}).value);
        const p = await evPart(ev.id, evAuth.userId);
        if (!p) return buildResponse(400, { success: false, error: '尚未加入活动' });
        const dm = evDefaultMetric(ev);
        const stage = ev.type === 'staged' ? evCurrentStage(ev, evNow) : null;
        const valid = [dm].concat((ev.config && ev.config.extraMetrics) || []);
        if (stage) valid.push(stage.goal.metric);
        if (!metric || valid.indexOf(metric) < 0) {
          return buildResponse(400, { success: false, error: '非法指标 ' + metric });
        }
        const maxPer = Number((ev.config && ev.config.maxValuePerSubmit) || 50);
        if (!(value > 0) || value > maxPer) {
          return buildResponse(400, { success: false, error: '单次提交须在 1~' + maxPer + ' 之间' });
        }
        const cap = Number((ev.config && ev.config.dailySubmitCap) || 200);
        const today = evDayKey(evNow);
        const todayCount = p.submissionsDate === today ? p.submissionsToday : 0;
        if (todayCount >= cap) return buildResponse(429, { success: false, error: '今日提交次数已达上限 ' + cap });
        const np = Object.assign({}, p, {
          metrics: Object.assign({}, p.metrics),
          stageContrib: Object.assign({}, p.stageContrib),
          submissions: p.submissions + 1, submissionsToday: todayCount + 1, submissionsDate: today, lastSubmitAt: evNow,
        });
        np.metrics[metric] = (p.metrics[metric] || 0) + value;
        if (stage) {
          np.stageContrib[stage.id] = (p.stageContrib[stage.id] || 0) + value;
          const gid = stage.id;
          const r = await db.collection('event_stage_progress').doc(gid).get().catch(function () { return null; });
          const d = r && r.data && r.data.length > 0 ? r.data[0] : (r && r.data) || null;
          const prog = d || { stageId: gid, eventId: ev.id, metric: stage.goal.metric, current: 0 };
          const current = (prog.current || 0) + value;
          const completedAt = current >= stage.goal.target ? prog.completedAt || evNow : prog.completedAt || null;
          await gsUpsert('event_stage_progress', gid, Object.assign({}, prog, { current: current, completedAt: completedAt }));
        }
        await evSavePart(np);
        return buildResponse(200, { success: true, data: { participation: np } });
      }

      if (httpMethod === 'GET' && evSub[1] === 'progress') {
        const p = await evPart(ev.id, evAuth.userId);
        const grants = await evGrantsOf(ev.id, evAuth.userId);
        const claimables = evClaimables(ev, p, grants.map(function (g) { return g.rewardId; }));
        const stageProgress = await evListAll('event_stage_progress', { eventId: ev.id });
        return buildResponse(200, {
          success: true,
          data: {
            serverNow: evNow, participation: p, claimables: claimables, stageProgress: stageProgress,
            totalGranted: grants.reduce(function (a, g) { return a + (g.amount || 0); }, 0),
          },
        });
      }

      if (httpMethod === 'POST' && evSub[1] === 'claim') {
        const gate = evCheckGate(ev, evAuth.userId, evNow, 'live-or-closing');
        if (!gate.ok) return buildResponse(gate.code, { success: false, error: gate.error, data: gate.payload });
        const rewardId = String((payload || {}).rewardId || '');
        const gid = evGrantId(ev.id, evAuth.userId, rewardId);
        // 幂等：已发放直接成功返回（双击/重放友好）
        const dup = await db.collection('event_grants').doc(gid).get().catch(function () { return null; });
        const dupDoc = dup && dup.data && dup.data.length > 0 ? dup.data[0] : (dup && dup.data) || null;
        if (dupDoc) return buildResponse(200, { success: true, data: { alreadyGranted: true, amount: dupDoc.amount, balance: null } });
        const p = await evPart(ev.id, evAuth.userId);
        if (!p) return buildResponse(400, { success: false, error: '尚未加入活动' });
        const grants = await evGrantsOf(ev.id, evAuth.userId);
        const claimables = evClaimables(ev, p, grants.map(function (g) { return g.rewardId; }));
        let target = null;
        for (const c of claimables) if (c.rewardId === rewardId) target = c;
        if (!target || !target.claimable) return buildResponse(400, { success: false, error: '奖励不存在或未达标' });
        try {
          await db.collection('event_grants').doc(gid).create({
            eventId: ev.id, userId: evAuth.userId, rewardId: rewardId,
            amount: target.reward.amount, grantedAt: evNow, source: 'self_claim',
          });
        } catch (err) {
          return buildResponse(200, { success: true, data: { alreadyGranted: true, amount: target.reward.amount, balance: null } });
        }
        let balance = null;
        try { balance = await evCreditGameCoins(evAuth.userId, target.reward.amount, '限时活动领奖 ' + (ev.name || '')); } catch (err) {
          console.error('[event] 领奖入账失败', gid, err && err.message);
        }
        return buildResponse(200, { success: true, data: { alreadyGranted: false, amount: target.reward.amount, balance: balance } });
      }

      return buildResponse(405, { success: false, error: 'method not allowed for __event' });
    }

    // ----------------------------------------------------------
    // 智能合约隧道：__contract（B1/B2，与本地 src/server/routes/contractTunnel.ts 对齐）
    // 引擎 = contract-engine.js（单一编译产物，与 TS 源码同源，防双实现漂移）
    //   GET  /templates          模板列表（公开）
    //   POST /deploy             部署实例（校验→codeHash→HMAC→signing；requiresAudit→draft）
    //   POST /sign               参与方签署
    //   POST /invoke             manual 触发（join/subscribe/settle/dispute...）
    //   POST /tick               cron 驱动（deadline-check / settlement-*；timer trigger 每 5 分钟）
    //   GET  /query              实例列表
    //   GET  /detail?id=         实例详情（含事件链）
    //   GET  /verify?id=         公开复算（规则指纹+事件链+HMAC）
    //   GET  /escrow?id=         托管台账
    //   GET  /admin/overview     平台监控 [admin]
    //   POST /admin/review       合约审核 [admin]
    // 资金权威：gameCoins 走 users/transactions（txId 幂等）；托管台账 contract_escrows；
    // 收益台账 revenue_ledger（GSO 分账唯一数据源）。
    // ----------------------------------------------------------
    if (segments.length >= 1 && segments[0] === '__contract') {
      const cAuth = extractAuth(event);
      const sub = segments.slice(1);
      const CONTRACT_SIGNING_KEY = process.env.CONTRACT_SIGNING_KEY || process.env.JWT_SECRET || 'allinone-contract-dev';
      if (!process.env.CONTRACT_SIGNING_KEY) console.warn('[contract] ⚠️ 未配置 CONTRACT_SIGNING_KEY，回退 JWT_SECRET（生产必须独立配置）');
      const contractHmac = (s) => {
        const crypto = require('crypto');
        return crypto.createHmac('sha256', CONTRACT_SIGNING_KEY).update(s).digest('hex');
      };
      const cId = () => 'ctr_' + Date.now().toString(36) + '_' + (require('crypto').randomBytes(4).toString('hex'));
      const INST_COL = 'contract_instances';
      const ESC_COL = 'contract_escrows';
      const REV_COL = 'revenue_ledger';
      const USERS_COL = 'users';
      const TX_COL = 'transactions';
      // UGC 模板注册中心（合约工坊 CW-1，与本地 contractTunnel.ts 对齐）
      const UGC_COL = 'contract_templates_ugc';
      const ugcTplContentHash = (tplObj) => {
        try { return CE.sha256hex(CE.canonicalize(tplObj)); } catch (e) { return CE.sha256hex(JSON.stringify(tplObj)); }
      };
      const ugcGet = async (key) => {
        try {
          const r = await db.collection(UGC_COL).where({ key: String(key) }).limit(1).get();
          return (r && r.data && r.data[0]) || null;
        } catch (e) { return null; }
      };
      const ugcSlim = (t) => ({
        key: t.key, authorId: t.authorId, authorName: t.authorName,
        version: (t.tpl && t.tpl.version) || t.version || 1,
        family: t.tpl && t.tpl.family, title: t.tpl && t.tpl.title, description: t.tpl && t.tpl.description,
        riskLevel: (t.tpl && t.tpl.riskLevel) || 'medium', requiresAudit: !!(t.tpl && t.tpl.requiresAudit),
        effectsWhitelist: (t.tpl && t.tpl.effectsWhitelist) || [],
        paramsSchema: (t.tpl && t.tpl.paramsSchema) || {},
        governanceTopics: (t.tpl && t.tpl.governanceTopics) || [],
        status: t.status, reviewNote: t.reviewNote, source: t.source, forkOf: t.forkOf,
        riskClass: t.riskClass, stats: t.stats || { deployCount: 0 }, templateFeeBps: t.templateFeeBps || 0,
        createdAt: t.createdAt, updatedAt: t.updatedAt,
      });

      async function loadInstance(id) {
        const r = await gsGet(INST_COL, String(id));
        return (r && r.data && r.data[0]) || null;
      }
      async function saveInstance(inst) {
        await gsUpsert(INST_COL, inst.id, inst);
      }
      // B-12 修复：乐观锁 CAS 写入——version 不符（并发覆盖）时拒绝，调用方返回 409 重试
      // 注意：update 体不得包含 _id（CloudBase 禁止更新 _id）
      async function saveInstanceCAS(inst, expectedVersion) {
        const upd = Object.assign({}, inst);
        delete upd._id;
        upd.version = expectedVersion + 1;
        const res = await db.collection(INST_COL).where({ _id: inst.id, version: expectedVersion }).update(upd);
        const updated = res && res.updated != null ? res.updated : ((res && res.stats && res.stats.updated) || 0);
        if (!updated || updated < 1) return false;
        return true;
      }

      // 平台规则注册中心的基础设施已提升至模块顶层（__market/buy 共用 getPlatformRule）
      /** 平台余额调整（txId 幂等，复用 __wallet/platform/adjust 口径） */
      async function contractAdjust(userId, delta, reason, txId, allowNeg) {
        if (!txId) throw new Error('missing txId');
        const dup = await db.collection(TX_COL).where({ _id: 'plat_' + txId }).limit(1).get();
        if (dup && dup.data && dup.data.length > 0) return { duplicated: true };
        const now = Date.now();
        let ures = await db.collection(USERS_COL).where({ _openid: userId }).limit(1).get();
        let u = (ures && ures.data && ures.data[0]) || null;
        if (!u) {
          u = { _openid: userId, gameCoins: 0, instantVouchers: 0, algorithmVouchers: 0, createdAt: now, updatedAt: now };
        }
        const next = (u.gameCoins || 0) + delta;
        if (next < 0 && !allowNeg) throw new Error('余额不足（' + userId + ' 需 ' + (-delta) + ' gameCoins）');
        if (u._id) {
          await db.collection(USERS_COL).doc(String(u._id)).update({ gameCoins: next, updatedAt: now });
        } else {
          await db.collection(USERS_COL).add({ _openid: userId, gameCoins: next, instantVouchers: 0, algorithmVouchers: 0, createdAt: now, updatedAt: now });
        }
        await db.collection(TX_COL).doc('plat_' + txId).set({
          _id: 'plat_' + txId,
          userId,
          type: delta > 0 ? 'income' : 'expense',
          amount: Math.abs(delta),
          description: String(reason || ''),
          balanceAfter: next,
          timestamp: now,
          createdAt: now,
        });
        return { balance: next };
      }
      async function escrowLock(contractId, fromUserId, currency, amount, txId, reason, purpose) {
        if (amount <= 0) return;
        if (currency !== 'gameCoins') throw new Error('云函数首发仅支持 gameCoins 托管（A币托管 B5 接入）');
        await contractAdjust(fromUserId, -amount, '[contract:' + contractId + '] ' + reason, txId);
        await gsUpsert(ESC_COL, 'esc_' + txId, {
          txId, contractId, fromUserId, kind: 'wallet', currency, purpose: purpose || null, amount, lockedAt: Date.now(), status: 'locked',
        });
      }
      async function escrowListLocked(contractId, kind, purpose) {
        const where = { contractId, status: 'locked', kind };
        if (purpose) where.purpose = purpose;
        const res = await db.collection(ESC_COL).where(where).limit(1000).get();
        return ((res && res.data) || []).sort((a, b) => (a.lockedAt || 0) - (b.lockedAt || 0));
      }
      async function escrowRelease(contractId, toUserId, currency, amount, txId, reason, purpose) {
        if (amount <= 0) return;
        if (currency !== 'gameCoins') throw new Error('云函数首发仅支持 gameCoins 释放');
        // 🆕 顺序修正（2026-10-10 审查，与本地 contractTunnel 对齐）：先扣台账（验证充足）后给收款人入账，
        // 防止余额不足时收款人已拿钱而台账未扣（实例回滚后台账与实际资金不一致）
        let remaining = amount;
        for (const e of await escrowListLocked(contractId, 'wallet', purpose)) {
          if (remaining <= 0) break;
          const take = Math.min(remaining, e.amount);
          e.amount -= take;
          remaining -= take;
          if (e.amount <= 1e-6) { e.status = 'released'; e.releasedAt = Date.now(); e.releasedTo = e.releasedTo || toUserId; }
          await gsUpsert(ESC_COL, e._id || e.entryId, e);
        }
        if (remaining > 1e-6) throw new Error('托管余额不足：' + currency + (purpose ? '/' + purpose : '') + ' 还需 ' + remaining);
        await contractAdjust(toUserId, amount, '[contract:' + contractId + '] ' + reason, txId);
      }
      // B-3 修复：不按 currency 过滤（TeamQuest 币种在 rewardPool.currency，params.currency=undefined
      // 会导致查不到条目 → 退款失效）；purpose 可选定向
      async function escrowRefundAll(contractId, planId, purpose) {
        const where = { contractId, status: 'locked' };
        if (purpose) where.purpose = purpose;
        let res;
        try { res = await db.collection(ESC_COL).where(where).limit(1000).get(); } catch (e) { res = { data: [] }; }
        for (const e of ((res && res.data) || [])) {
          if (e.currency === 'gameCoins') {
            await contractAdjust(e.fromUserId, e.amount, '[contract:' + contractId + '] 退款', planId + ':refund:' + (e._id || e.entryId));
          } else {
            for (const vid of e.voucherIds || []) {
              try {
                const vr = await gsGet('vouchers', vid);
                const v = (vr && vr.data && vr.data[0]) || null;
                if (v && v.currentHolderId === 'contract-escrow:' + contractId) {
                  v.currentHolderId = e.fromUserId;
                  delete v.frozenAt;
                  await gsUpsert('vouchers', vid, v);
                }
              } catch (_) { /* 单凭证失败不阻塞其余退款 */ }
            }
          }
          e.status = 'refunded';
          e.releasedAt = Date.now();
          e.releasedTo = e.fromUserId;
          await gsUpsert(ESC_COL, e._id || e.entryId, e);
        }
      }
      async function escrowForfeit(contractId, userId, currency, amount, planId, purpose) {
        let remaining = amount;
        const mine = await escrowListLocked(contractId, 'wallet', purpose);
        const mineOfUser = mine.filter((e) => e.fromUserId === userId && e.currency === currency);
        for (const e of mineOfUser) {
          if (remaining <= 0) break;
          const take = Math.min(remaining, e.amount);
          e.amount -= take;
          remaining -= take;
          if (e.amount <= 1e-6) { e.status = 'forfeited'; e.releasedAt = Date.now(); }
          await gsUpsert(ESC_COL, e._id || e.entryId, e);
        }
        if (remaining > 1e-6) throw new Error('托管余额不足（罚没）：' + currency + (purpose ? '/' + purpose : '') + ' 还需 ' + remaining);
        if (amount > 0) await contractAdjust('system-platform', amount, '[contract:' + contractId + '] 违约罚没', planId + ':forfeit:' + userId);
      }
      /** Effect 执行器（saga：txId 幂等，失败重放不双花） */
      async function executeEffect(inst, plan, idx, eff) {
        const txId = plan.idempotencyKey + ':' + idx;
        switch (eff.type) {
          case 'walletTransfer':
            if (!eff.fromUserId || eff.fromUserId === 'escrow') {
              await escrowRelease(inst.id, eff.toUserId, eff.currency, eff.amount, txId, eff.reason, eff.purpose);
            } else {
              await escrowLock(inst.id, eff.fromUserId, eff.currency, eff.amount, txId, eff.reason, eff.purpose);
            }
            return;
          case 'treasuryDeposit':
            await escrowRelease(inst.id, 'system-platform', eff.currency, eff.amount, txId, eff.reason, eff.purpose);
            return;
          case 'splitPayout':
            // B-25 修复：source=treasury 从平台金库支付（GSO 收益分成——托管在交割时已清空）
            if (eff.source === 'treasury') {
              for (let i = 0; i < (eff.table || []).length; i++) {
                const row = eff.table[i];
                await contractAdjust('system-platform', -row.amount, '[contract:' + inst.id + '] 平台分成支出', txId + ':' + i + ':spend', true);
                await contractAdjust(row.userId, row.amount, '[contract:' + inst.id + '] ' + eff.reason, txId + ':' + i);
              }
              return;
            }
            for (let i = 0; i < (eff.table || []).length; i++) {
              await escrowRelease(inst.id, eff.table[i].userId, eff.currency, eff.table[i].amount, txId + ':' + i, eff.reason, eff.purpose);
            }
            return;
          case 'refundAll':
            await escrowRefundAll(inst.id, txId, eff.purpose);
            return;
          case 'penalize':
            await escrowForfeit(inst.id, eff.userId, eff.currency, eff.amount, plan.idempotencyKey, eff.purpose);
            return;
          case 'mintShareVouchers': {
            for (const row of eff.rows) {
              const vid = 'rsv_' + Date.now().toString(36) + '_' + require('crypto').randomBytes(4).toString('hex');
              const rsvDoc = {
                id: vid,
                schemaName: 'rsv',
                title: 'RSV:' + inst.id,
                denomination: 0,
                currentHolderId: row.userId,
                currentHolderName: row.userId,
                status: 'active',
                createdAt: Date.now(),
                createdBy: 'contract:' + inst.id,
                metadata: { contractId: inst.id, gameId: inst.gameId || '', codeHash: inst.codeHash, share: row.share, contributed: row.amount, currency: eff.currency, lockupUntil: Date.now() + eff.lockupMs },
                integrity: { v: 1, mintedBy: 'server', planId: plan.idempotencyKey, mintedAt: Date.now(), sig: contractHmac(vid + '|' + row.userId + '|' + inst.codeHash) },
              };
              // B-8 修复：锁定期用 frozenAt 真冻结
              if (eff.lockupMs > 0) rsvDoc.frozenAt = Date.now() + eff.lockupMs;
              await gsUpsert('vouchers', vid, rsvDoc);
            }
            // 🆕 P1（2026-10-15，与本地 contractTunnel 对齐）：GSO 交割 → 调减发行方收益份额。
            // RSV 持有人的周期分账实质来自发行方让渡的份额，而非平台金库额外补贴。
            // 幂等：acc.gsoConveyed.contractId 已等于本合约 → 跳过（saga 重放安全）。
            try {
              const gsoGameId = String(inst.gameId || (inst.params && inst.params.gameId) || '');
              if (gsoGameId) {
                const accId = 'game-' + gsoGameId;
                const aRes = await gsGet('game_developer_accounts', accId);
                const acc = (aRes && aRes.data && aRes.data[0]) || null;
                if (acc && !(acc.gsoConveyed && acc.gsoConveyed.contractId === inst.id)) {
                  const bps = Math.max(0, Math.min(10000, Number(inst.params && inst.params.revenueShareBps) || 0));
                  if (bps > 0) {
                    const keep = 1 - bps / 10000;
                    if (acc.revenueSharing && Number(acc.revenueSharing.gameShareBps) > 0) {
                      const g = Number(acc.revenueSharing.gameShareBps) || 0;
                      const p = Number(acc.revenueSharing.platformShareBps) || 0;
                      const c = Number(acc.revenueSharing.creatorShareBps) || 0;
                      const newG = Math.floor(g * keep);
                      const freed = g - newG;
                      let newP = p, newC = c;
                      if (p + c > 0) { newP = p + Math.floor((freed * p) / (p + c)); newC = c + (freed - (newP - p)); }
                      else { newP = p + freed; }
                      acc.revenueSharing = Object.assign({}, acc.revenueSharing, { gameShareBps: newG, platformShareBps: newP, creatorShareBps: newC });
                    } else {
                      acc.revenueSharePercent = Math.round((Number(acc.revenueSharePercent) || 0) * keep * 100) / 100;
                    }
                    acc.gsoConveyed = { contractId: inst.id, bps: bps, at: Date.now(), planId: plan.idempotencyKey };
                    acc.updatedAt = Date.now();
                    await gsUpsert('game_developer_accounts', accId, acc);
                    console.log('[contract:gso] 发行方份额已调减: ' + accId + ' 出让 ' + bps + 'bps');
                  }
                }
              }
            } catch (gsoErr) {
              console.warn('[contract:gso] 发行方份额调减失败（不阻塞交割）:', (gsoErr && gsoErr.message) || gsoErr);
            }
            return;
          }
          case 'setState':
          case 'openDispute':
          case 'notify':
          case 'grantGovernanceWeight':
            return; // 由 plan.nextState/事件链承载
          // B-23 修复：未实现的效果必须诚实失败（静默 no-op 会吞掉白名单效果）
          default:
            throw new Error('未实现 Effect: ' + eff.type);
        }
      }
      async function applyPlan(inst, plan) {
        const expectedVersion = Number(inst.version) || 1;
        if (plan.shadow) {
          const ev = CE.appendEvent(inst.history, { at: plan.createdAt, type: 'shadow-plan', actorId: 'system', payload: { plan } });
          inst.history.push(ev);
          inst.updatedAt = Date.now();
          inst.version = expectedVersion + 1;
          const ok = await saveInstanceCAS(inst, expectedVersion);
          if (!ok) return { applied: false, error: '合约并发冲突，请重试', conflict: true };
          return { applied: false };
        }
        for (let i = 0; i < plan.effects.length; i++) {
          try {
            await executeEffect(inst, plan, i, plan.effects[i]);
          } catch (e) {
            const dead = CE.appendEvent(inst.history, { at: Date.now(), type: 'effect-failed', actorId: 'system', payload: { planId: plan.idempotencyKey, idx: i, effect: plan.effects[i], error: (e && e.message) || String(e) } });
            inst.history.push(dead);
            inst.updatedAt = Date.now();
            const ok = await saveInstanceCAS(inst, expectedVersion);
            if (!ok) return { applied: false, error: '合约并发冲突（死信未记录）：' + ((e && e.message) || String(e)), conflict: true };
            return { applied: false, error: (e && e.message) || String(e) };
          }
        }
        inst.stateData = CE.applyUpdates(inst.stateData, plan.updates);
        if (plan.nextState) inst.state = plan.nextState;
        // 🆕 P2（2026-10-15，与本地 contractTunnel 对齐）：拼团成团交割（→ settling）
        // 为每位参团成员铸造履约凭证（gbr），平台获得发货/争议抓手；凭证 id 确定性幂等。
        if (inst.templateKey === 'group-buy' && plan.nextState === 'settling') {
          try {
            const seen = {};
            const contribs = (inst.stateData && Array.isArray(inst.stateData.contributions)) ? inst.stateData.contributions : [];
            for (const c of contribs) {
              const uid = String((c && c.userId) || '');
              if (!uid || seen[uid]) continue;
              seen[uid] = 1;
              const vid = 'gbr_' + inst.id + '_' + uid;
              const dup = await gsGet('vouchers', vid);
              if (dup && dup.data && dup.data[0]) continue; // 幂等
              const p = inst.params || {};
              await gsUpsert('vouchers', vid, {
                id: vid, schemaName: 'gbr', title: '拼团凭证:' + String(p.itemTitle || inst.id),
                description: '拼团收据：道具「' + String(p.itemTitle || '未指定') + '」（' + String(p.skuId || '无skuId') + '），成团价 ' + (Number(p.groupPrice) || 0) + ' ' + String(p.currency || 'gameCoins') + '，合约 ' + inst.id + '。发货状态：待发货（发货后 metadata.fulfilled=true）',
                denomination: Number(p.groupPrice) || 0, currentHolderId: uid, currentHolderName: uid, status: 'active',
                createdAt: Date.now(), createdBy: 'contract:' + inst.id,
                metadata: {
                  contractId: inst.id, kind: 'group-buy-receipt',
                  fulfilled: false, fulfillmentPending: true,
                  itemTitle: p.itemTitle, skuId: p.skuId || '',
                  groupPrice: p.groupPrice, currency: p.currency, codeHash: inst.codeHash, planId: plan.idempotencyKey,
                },
                integrity: { v: 1, mintedBy: 'server', planId: plan.idempotencyKey, mintedAt: Date.now(), sig: contractHmac(vid + '|' + uid + '|' + inst.codeHash) },
              });
            }
            // 🆕 2026-10-16 履约发货（与本地 fulfillGroupBuyItems 对齐，tick 补发共用 helper）
            await fulfillGroupBuyItemsCloud(inst);
          } catch (gbErr) {
            console.warn('[contract:group-buy] 履约凭证铸造失败（不阻塞交割）:', (gbErr && gbErr.message) || gbErr);
          }
        }
        inst.history.push(CE.appendEvent(inst.history, { at: plan.createdAt, type: 'trigger', actorId: plan.trigger.actorId, payload: plan.trigger }));
        inst.history.push(CE.appendEvent(inst.history, { at: Date.now(), type: 'effects-applied', actorId: 'system', payload: { planId: plan.idempotencyKey, clauseIds: plan.clauseIds, effects: plan.effects, nextState: plan.nextState || null } }));
        inst.updatedAt = Date.now();
        inst.version = expectedVersion + 1;
        // B-12：CAS——资金效果已被 txId 幂等保护，状态未提交 → 下一轮重试安全
        const ok = await saveInstanceCAS(inst, expectedVersion);
        if (!ok) return { applied: false, error: '合约并发冲突，请重试', conflict: true };
        return { applied: true };
      }

      // GET /templates（公开，含已过审 UGC；UGC 默认影子模式 autoExecute=false）
      if (httpMethod === 'GET' && sub[0] === 'templates') {
        let ugcRows = [];
        try {
          const r = await db.collection(UGC_COL).where({ status: 'approved' }).limit(200).get();
          ugcRows = (r && r.data) || [];
        } catch (e) { ugcRows = []; }
        return buildResponse(200, { success: true, data: {
          templates: CE.listTemplates().map((t) => Object.assign({}, t, {
            // 官方模板 = 公开源码（合约工坊"点击查看代码"），与 verify 端点公开哲学一致
            autoExecute: false, ugc: false,
          })).concat(ugcRows.map((t) => Object.assign({}, ugcSlim(t), { autoExecute: false, ugc: true }))),
        } });
      }

      // POST /deploy
      if (httpMethod === 'POST' && sub[0] === 'deploy') {
        if (!cAuth.userId) return buildResponse(401, { success: false, error: '未登录' });
        // 模板解析：内置 REGISTRY → UGC 注册中心（approved + 内容指纹 TOCTOU，CW-1）
        let tpl = CE.getTemplate(String((payload || {}).templateKey || ''));
        if (!tpl && String((payload || {}).templateKey || '').indexOf('ugc_') === 0) {
          const ugcDoc = await ugcGet(String(payload.templateKey));
          if (!ugcDoc || ugcDoc.status !== 'approved') return buildResponse(404, { success: false, error: '模板不存在' });
          const nowHash = ugcTplContentHash(ugcDoc.tpl);
          if (ugcDoc.reviewedCodeHash && ugcDoc.reviewedCodeHash !== nowHash) {
            return buildResponse(409, { success: false, error: '模板内容与审核版本不一致（已被修改），拒绝部署' });
          }
          const acr = CE.validateUgcTemplate(ugcDoc.tpl);
          if (!acr.ok) return buildResponse(400, { success: false, error: 'UGC 模板校验未通过', data: { issues: acr.issues } });
          tpl = ugcDoc.tpl;
          ugcDoc.stats = Object.assign({}, ugcDoc.stats || {}, { deployCount: ((ugcDoc.stats && ugcDoc.stats.deployCount) || 0) + 1 });
          ugcDoc.updatedAt = Date.now();
          await gsUpsert(UGC_COL, ugcDoc.key, ugcDoc);
        }
        if (!tpl) return buildResponse(404, { success: false, error: '模板不存在' });
        const tplCheck = CE.validateTemplate(tpl);
        if (!tplCheck.ok) return buildResponse(500, { success: false, error: '模板静态校验失败', data: { issues: tplCheck.issues } });
        const params = payload.params || {};
        const paramCheck = CE.validateParams(tpl.paramsSchema, params);
        if (!paramCheck.ok) return buildResponse(400, { success: false, error: '参数校验未通过', data: { issues: paramCheck.issues } });
        if (String(params.initiatorId ?? params.issuerId ?? '') !== cAuth.userId) return buildResponse(403, { success: false, error: '发起人（initiatorId/issuerId）必须与登录身份一致' });
        // 🆕 GSO 收益权出让审核（2026-10-10 与本地 contractTunnel 对齐）：只有游戏发布者（份额持有者）可发行
        if (tpl.key === 'gso') {
          const gsoGameId = String(params.gameId || '');
          const gsoGame = gsoGameId ? await db.collection('published_games').doc(gsoGameId).get().catch(() => null) : null;
          const gsoPub = gsoGame && gsoGame.data && (gsoGame.data[0] || gsoGame.data).publisherId;
          if (!gsoPub) return buildResponse(404, { success: false, error: `GSO 发行失败：游戏档案不存在（${gsoGameId}），无法核验收益份额归属` });
          if (gsoPub !== cAuth.userId) return buildResponse(403, { success: false, error: `GSO 发行失败：只有游戏发布者（当前收益份额持有者 ${gsoPub}）才能发行该游戏的 GSO，当前登录为 ${cAuth.userId}` });
        }
        const codeHash = CE.computeCodeHash({ templateKey: tpl.key, templateVersion: tpl.version, clauses: tpl.clauses, params });
        const now = Date.now();
        const id = cId();
        const inst = {
          id,
          templateKey: tpl.key,
          templateVersion: tpl.version,
          family: tpl.family,
          codeHash,
          integrity: { sig: contractHmac(codeHash), signedBy: 'server', signedAt: now },
          upgradePolicy: 'immutable',
          initiatorId: cAuth.userId,
          gameId: params.gameId ? String(params.gameId) : undefined,
          whitelist: (function () {
            // 🆕 私域合约（2026-10-10，与本地 contractTunnel 对齐）：部署时可携带参与名单
            const wl = Array.isArray((payload || {}).whitelist) ? payload.whitelist : null;
            const cleaned = wl ? Array.from(new Set(wl.map((x) => String(x || '').trim()).filter(Boolean))).slice(0, 500) : [];
            return cleaned.length > 0 ? cleaned : undefined;
          })(),
          params,
          clauses: tpl.clauses,
          parties: [{ userId: cAuth.userId, role: 'initiator', stake: [], joinedAt: now, signedAt: now }],
          escrow: { voucherIds: [], walletHold: [] },
          state: tpl.requiresAudit ? 'draft' : 'signing',
          // 🆕 2026-10-18：发起人自动入团（与本地 contractTunnel 对齐）
          stateData: String(tpl.key).indexOf('ugc_') === 0
            ? CE.deriveInitialStateData(tpl)
            : tpl.key === 'team-quest'
              ? { memberCount: 1, totalRaised: 0, score: 0, poolFunded: 0, contributions: [{ userId: cAuth.userId, amount: 0 }] }
              : { memberCount: 0, totalRaised: 0, score: 0, poolFunded: 0, contributions: [] },
          history: [CE.appendEvent([], { at: now, type: 'deployed', actorId: cAuth.userId, payload: { templateKey: tpl.key, templateVersion: tpl.version, codeHash, title: payload.title || tpl.title } })],
          seed: CE.sha256hex(id + '|' + codeHash).slice(0, 32),
          autoExecute: false, // 云函数自动执行开关由 env CONTRACT_AUTO_EXECUTE 控制（B3 起逐档开）
          createdAt: now,
          updatedAt: now,
          version: 1,
        };
        await saveInstance(inst);
        // 🆕 私域邀请私信（2026-10-11，与本地 contractTunnel 对齐）：服务端生成通知（剔除发起人，幂等 id），失败不阻塞部署。
        // 仅非审核模板（state=signing）立即发送；requiresAudit 模板在 admin/review 通过后再发（draft 阶段成员无法 join）
        try {
          const nWl = inst.state === 'signing' && Array.isArray(inst.whitelist) ? inst.whitelist : [];
          if (nWl.length > 0) {
            const p = inst.params || {};
            const tplName = tpl.key === 'group-buy' ? '拼团' : tpl.key === 'team-quest' ? '组队任务' : tpl.key === 'gso' ? '收益份额认购（GSO）' : (payload.title || tpl.title);
            const subject = String(p.itemTitle || p.questTitle || p.gameName || payload.title || '').trim();
            const bodyMap = {
              'group-buy': '邀你参与拼团' + (subject ? '「' + subject + '」' : '') + '，名额有限，货款由平台托管。',
              'team-quest': '邀你组队完成任务' + (subject ? '「' + subject + '」' : '') + '，押金与奖金池由平台托管。',
              'gso': '邀你认购' + (subject ? '「' + subject + '」' : '') + '的收益分成份额，仅限名单内成员。',
            };
            const nBody = bodyMap[tpl.key] || ('邀你参与' + (subject ? '「' + subject + '」' : '合约') + '。');
            const nNow = Date.now();
            for (const toUserId of nWl) {
              if (!toUserId || toUserId === cAuth.userId) continue; // 剔除发起人
              const nId = 'ntf_' + inst.id + '_' + toUserId;
              await gsUpsert('notifications', nId, {
                id: nId, toUserId, type: 'contract.private_invite',
                title: '[私域邀请] ' + cAuth.userId + ' 发起的' + tplName, body: nBody, link: '/contracts',
                read: false, createdAt: nNow,
                meta: { contractId: inst.id, templateKey: tpl.key, initiatorId: cAuth.userId },
              });
            }
          }
        } catch (nErr) {
          console.warn('[contract] 私域邀请通知生成失败（不影响部署）:', (nErr && nErr.message) || nErr);
        }
        return buildResponse(200, { success: true, data: { contractId: id, codeHash, state: inst.state, autoExecute: inst.autoExecute, requiresAudit: tpl.requiresAudit } });
      }

      // POST /sign
      if (httpMethod === 'POST' && sub[0] === 'sign') {
        if (!cAuth.userId) return buildResponse(401, { success: false, error: '未登录' });
        const inst = await loadInstance((payload || {}).contractId);
        if (!inst) return buildResponse(404, { success: false, error: '合约不存在' });
        const party = (inst.parties || []).find((p) => p.userId === cAuth.userId);
        if (!party) return buildResponse(403, { success: false, error: '你不是该合约参与方' });
        if (!party.signedAt) {
          party.signedAt = Date.now();
          inst.history.push(CE.appendEvent(inst.history, { at: Date.now(), type: 'signed', actorId: cAuth.userId, payload: { signedCount: inst.parties.filter((p) => p.signedAt).length } }));
          inst.updatedAt = Date.now();
          await saveInstance(inst);
        }
        return buildResponse(200, { success: true, data: { contractId: inst.id } });
      }

      // POST /invoke
      if (httpMethod === 'POST' && sub[0] === 'invoke') {
        if (!cAuth.userId) return buildResponse(401, { success: false, error: '未登录' });
        const inst = await loadInstance((payload || {}).contractId);
        if (!inst) return buildResponse(404, { success: false, error: '合约不存在' });
        if (inst.state === 'draft') return buildResponse(409, { success: false, error: '合约待审核中' });
        // 🆕 私域合约门禁（2026-10-10 与本地对齐）：join/subscribe 仅限名单内成员，发起人豁免
        const action = String((payload || {}).action || '');
        if (!action) return buildResponse(400, { success: false, error: 'missing action' });
        if ((action === 'join' || action === 'subscribe') && Array.isArray(inst.whitelist) && inst.whitelist.length > 0) {
          if (inst.initiatorId !== cAuth.userId && !inst.whitelist.includes(cAuth.userId)) {
            return buildResponse(403, { success: false, error: '私域合约：仅名单内 ' + inst.whitelist.length + ' 名成员可参与（发起人 ' + inst.initiatorId + '），当前登录 ' + cAuth.userId });
          }
        }
        const triggerId = String((payload || {}).triggerId || '') || ('tq_' + Date.now().toString(36) + '_' + require('crypto').randomBytes(3).toString('hex'));

        // __protocol：贡献进度上报（TeamQuest 事实源通道）
        // 双通道（P3，2026-10-15，与本地 contractTunnel 对齐）：团长代报 + 成员本人自报
        let triggerKind = 'manual';
        let triggerType = action;
        let triggerPayload = Object.assign({}, (payload || {}).payload || {}, { userId: cAuth.userId, reason: ((payload || {}).payload || {}).reason ?? '（未填写）' });
        if (action === '__protocol') {
          const targetUserId = String(((payload || {}).payload || {}).targetUserId || cAuth.userId);
          const isSelfReport = targetUserId === cAuth.userId;
          if (inst.initiatorId !== cAuth.userId && !isSelfReport) {
            return buildResponse(403, { success: false, error: '仅发起人（团长）或成员本人（自报通道）可上报进度' });
          }
          const points = Number(((payload || {}).payload || {}).points);
          if (!targetUserId || !Number.isFinite(points)) return buildResponse(400, { success: false, error: '缺少 targetUserId 或 points' });
          if (points < 0 || points > 100000) return buildResponse(400, { success: false, error: 'points 须在 0..100000' });
          // 防骗分：目标必须是已加入团队的成员
          const members = Array.isArray(inst.stateData.contributions) ? inst.stateData.contributions : [];
          const isMember = members.some((m) => m && m.userId === targetUserId);
          if (!isMember) return buildResponse(403, { success: false, error: '目标 ' + targetUserId + ' 不是该团队成员，拒绝上报' });
          let prefix = 'GAME_EVENT:';
          for (const c of inst.clauses || []) {
            if (c.on && c.on.kind === 'protocol' && c.on.match && String(c.on.match).endsWith(':*')) {
              prefix = String(c.on.match).slice(0, -1);
              break;
            }
          }
          triggerKind = 'protocol';
          triggerType = prefix + String(((payload || {}).payload || {}).event || 'SCORE');
          triggerPayload = { userId: targetUserId, points };
        }

        const ev = {
          triggerId,
          kind: triggerKind,
          type: triggerType,
          at: Date.now(),
          actorId: cAuth.userId,
          payload: triggerPayload,
          channelTokenValid: triggerKind === 'protocol' ? true : undefined,
        };
        const result = CE.executeTrigger(inst, ev, { now: Date.now() });
        if (!result.plan) {
          const reasons = { 'duplicate-trigger': '重复触发（幂等跳过）', 'no-matching-clause': '无匹配条款', 'condition-not-met': '条件未满足' };
          return buildResponse(409, { success: false, error: result.reasonDetail || reasons[result.reason] || result.reason, code: result.reason });
        }
        const applied = await applyPlan(inst, result.plan);
        if (!applied.applied) {
          if (applied.conflict) {
            return buildResponse(409, { success: false, error: applied.error, code: 'conflict' });
          }
          return buildResponse(applied.error ? 422 : 200, { success: !applied.error, error: applied.error, data: { shadow: result.plan.shadow, plan: result.plan } });
        }
        return buildResponse(200, { success: true, data: { contractId: inst.id, state: inst.state, stateData: inst.stateData, clauseIds: result.plan.clauseIds, idempotencyKey: result.plan.idempotencyKey } });
      }

      // POST /tick（timer trigger 每 5 分钟 + 手动）
      if (httpMethod === 'POST' && sub[0] === 'tick') {
        const now = Date.now();
        const summary = [];
        let res;
        try {
          res = await db.collection(INST_COL).where({}).limit(1000).get();
        } catch (e) { res = { data: [] }; }
        const targets = ((res && res.data) || []).filter((c) => ['signing', 'active', 'settling'].includes(c.state));
        for (const inst of targets) {
          if ((inst.history || []).length > 400) continue;
          const schedules = new Set();
          for (const clause of inst.clauses || []) {
            if (clause.on && clause.on.kind === 'cron' && (clause.on.enabledStates || ['funded', 'active']).includes(inst.state)) {
              schedules.add(clause.on.schedule || 'deadline-check');
            }
          }
          for (const schedule of schedules) {
            const tickPayload = {};
            if (String(schedule).indexOf('settlement-') === 0) {
              const gameId = inst.gameId || (inst.params || {}).gameId || '';
              const periodMs = schedule === 'settlement-weekly' ? 7 * 24 * 3600 * 1000 : 30 * 24 * 3600 * 1000;
              let total = 0;
              try {
                // B-13 修复：时间范围下推 + 游标分页（limit(1000) 截断会导致分账基数偏低）
                const _ = db.command;
                let offset = 0;
                for (;;) {
                  const rev = await db.collection(REV_COL)
                    .where({ gameId, occurredAt: _.gt(now - periodMs).and(_.lte(now)) })
                    .skip(offset).limit(1000).get();
                  const rows = (rev && rev.data) || [];
                  for (const r of rows) {
                    // 存量兼容（P0a）：旧条目 source 为连字符 'item-sale'，归一化后匹配下划线口径
                    const srcNorm = r.source === 'item-sale' ? 'item_sale' : r.source;
                    if (((inst.params || {}).revenueSources || []).indexOf(srcNorm) < 0) continue;
                    total += Number(r.commission) || 0;
                  }
                  if (rows.length < 1000) break;
                  offset += 1000;
                }
              } catch (e) { /* 集合不存在视为 0 */ }
              tickPayload.periodRevenue = total;
              tickPayload.periodStart = now - periodMs;
              tickPayload.periodEnd = now;
            }
            // B-1 修复（致命）：确定性 triggerId（随机 ID 会让死信重试用新 txId 重复执行已成功的资金效果）
            const bucket = schedule === 'settlement-weekly' ? Math.floor(now / (7 * 24 * 3600 * 1000))
              : schedule === 'settlement-monthly' ? Math.floor(now / (30 * 24 * 3600 * 1000))
              : Math.floor(now / (60 * 60 * 1000));
            const ev = { triggerId: 'tick:' + inst.id + ':' + schedule + ':' + bucket, kind: 'cron', type: schedule, at: now, actorId: 'system', payload: tickPayload };
            const result = CE.executeTrigger(inst, ev, { now });
            if (!result.plan) continue;
            const applied = await applyPlan(inst, result.plan);
            summary.push({ contractId: inst.id, action: schedule, applied: applied.applied, error: applied.error });
          }
          // 🆕 2026-10-16 拼团履约补发：成团时池无货的合约，每次 tick 自愈重试发货
          if (inst.templateKey === 'group-buy' && inst.state === 'settling') {
            await fulfillGroupBuyItemsCloud(inst);
          }
        }
        return buildResponse(200, { success: true, data: { scanned: targets.length, executed: summary.length, summary } });
      }

      // GET /query
      if (httpMethod === 'GET' && sub[0] === 'query') {
        let res;
        try {
          res = await db.collection(INST_COL).where({}).limit(1000).get();
        } catch (e) { res = { data: [] }; }
        const slim = ((res && res.data) || []).map((r) => ({
          id: r.id, templateKey: r.templateKey, family: r.family, codeHash: r.codeHash,
          initiatorId: r.initiatorId, gameId: r.gameId, whitelist: Array.isArray(r.whitelist) && r.whitelist.length > 0 ? r.whitelist : undefined, params: r.params, state: r.state,
          stateData: r.stateData, partyCount: (r.parties || []).length, historyCount: (r.history || []).length,
          autoExecute: r.autoExecute, createdAt: r.createdAt, updatedAt: r.updatedAt,
        })).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        return buildResponse(200, { success: true, data: { contracts: slim } });
      }

      // GET /detail?id=
      if (httpMethod === 'GET' && sub[0] === 'detail') {
        const inst = await loadInstance(reqQuery.id);
        if (!inst) return buildResponse(404, { success: false, error: '合约不存在' });
        return buildResponse(200, { success: true, data: { contract: inst } });
      }

      // GET /verify?id=（公开复算）
      if (httpMethod === 'GET' && sub[0] === 'verify') {
        const inst = await loadInstance(reqQuery.id);
        if (!inst) return buildResponse(404, { success: false, error: '合约不存在' });
        const rule = CE.verifyCodeHash(inst.templateKey, inst.templateVersion, inst.clauses, inst.params, inst.codeHash);
        const chain = CE.verifyChain(inst.history || []);
        const sigOk = inst.integrity ? contractHmac(inst.codeHash) === inst.integrity.sig : null;
        return buildResponse(200, { success: true, data: {
          intact: rule.intact && chain.intact && sigOk !== false,
          codeHash: inst.codeHash, recomputed: rule.recomputed,
          ruleIntact: rule.intact, chainIntact: chain.intact, chainLength: chain.length,
          chainBrokenAt: chain.brokenAt || null, signatureValid: sigOk, state: inst.state,
        } });
      }

      // GET /escrow?id=
      if (httpMethod === 'GET' && sub[0] === 'escrow') {
        let res;
        try {
          res = await db.collection(ESC_COL).where({ contractId: String(reqQuery.id || '') }).limit(1000).get();
        } catch (e) { res = { data: [] }; }
        return buildResponse(200, { success: true, data: { entries: (res && res.data) || [] } });
      }

      // GET /admin/overview [admin]
      if (httpMethod === 'GET' && sub[0] === 'admin' && sub[1] === 'overview') {
        const denied = requireAdmin(event);
        if (denied) return denied;
        let res;
        try {
          res = await db.collection(INST_COL).where({}).limit(1000).get();
        } catch (e) { res = { data: [] }; }
        const all = (res && res.data) || [];
        const byState = {};
        const deadLetters = [];
        const shadowPlans = [];
        for (const c of all) {
          byState[c.state] = (byState[c.state] || 0) + 1;
          for (const h of c.history || []) {
            if (h.type === 'effect-failed') deadLetters.push({ contractId: c.id, templateKey: c.templateKey, seq: h.seq, at: h.at, planId: h.payload && h.payload.planId, error: h.payload && h.payload.error });
            else if (h.type === 'shadow-plan') shadowPlans.push({ contractId: c.id, templateKey: c.templateKey, seq: h.seq, at: h.at });
          }
        }
        return buildResponse(200, { success: true, data: { totalContracts: all.length, byState, deadLetters: deadLetters.slice(-50), shadowPlans: shadowPlans.slice(-100), deadLetterCount: deadLetters.length } });
      }

      // POST /admin/review [admin]
      if (httpMethod === 'POST' && sub[0] === 'admin' && sub[1] === 'review') {
        const denied = requireAdmin(event);
        if (denied) return denied;
        const inst = await loadInstance((payload || {}).contractId);
        if (!inst) return buildResponse(404, { success: false, error: '合约不存在' });
        if (inst.state !== 'draft') return buildResponse(409, { success: false, error: '合约状态 ' + inst.state + ' 非待审' });
        inst.state = (payload || {}).approve ? 'signing' : 'terminated';
        inst.history.push(CE.appendEvent(inst.history, { at: Date.now(), type: (payload || {}).approve ? 'review-approved' : 'review-rejected', actorId: cAuth.userId || 'review-admin', payload: { note: String((payload || {}).note || '') } }));
        inst.updatedAt = Date.now();
        await saveInstance(inst);
        // 🆕 审核通过（draft → signing）补发私域邀请私信（deploy 时不发审核模板，2026-10-11）
        if ((payload || {}).approve) {
          try {
            const nWl = Array.isArray(inst.whitelist) ? inst.whitelist : [];
            const p = inst.params || {};
            const tplName = inst.templateKey === 'group-buy' ? '拼团' : inst.templateKey === 'team-quest' ? '组队任务' : inst.templateKey === 'gso' ? '收益份额认购（GSO）' : '合约';
            const subject = String(p.itemTitle || p.questTitle || p.gameName || '').trim();
            const bodyMap = {
              'group-buy': '邀你参与拼团' + (subject ? '「' + subject + '」' : '') + '，名额有限，货款由平台托管。',
              'team-quest': '邀你组队完成任务' + (subject ? '「' + subject + '」' : '') + '，押金与奖金池由平台托管。',
              'gso': '邀你认购' + (subject ? '「' + subject + '」' : '') + '的收益分成份额，仅限名单内成员。',
            };
            const nBody = bodyMap[inst.templateKey] || ('邀你参与' + (subject ? '「' + subject + '」' : '合约') + '。');
            const nNow = Date.now();
            for (const toUserId of nWl) {
              if (!toUserId || toUserId === inst.initiatorId) continue;
              const nId = 'ntf_' + inst.id + '_' + toUserId;
              await gsUpsert('notifications', nId, {
                id: nId, toUserId, type: 'contract.private_invite',
                title: '[私域邀请] ' + inst.initiatorId + ' 发起的' + tplName, body: nBody, link: '/contracts',
                read: false, createdAt: nNow,
                meta: { contractId: inst.id, templateKey: inst.templateKey, initiatorId: inst.initiatorId },
              });
            }
          } catch (nErr) {
            console.warn('[contract] 审核通过后通知生成失败:', (nErr && nErr.message) || nErr);
          }
        }
        return buildResponse(200, { success: true, data: { contractId: inst.id, state: inst.state } });
      }

      // 🆕 POST /admin/arbitrate [admin] — 争议仲裁（P0b，2026-10-15，与本地 contractTunnel 对齐）
      // 此前 disputed 状态不进 tick、无出口 → 托管资金永久冻结。本端点补齐：
      // - ruling=refund  ：全部 locked 原路退回出资人，state → refunded
      // - ruling=release ：payment/pool（GSO 含无 purpose 认购款）放行给发起人；凭证类转发起人；bond 退成员，state → terminated
      if (httpMethod === 'POST' && sub[0] === 'admin' && sub[1] === 'arbitrate') {
        const denied = requireAdmin(event);
        if (denied) return denied;
        const inst = await loadInstance((payload || {}).contractId);
        if (!inst) return buildResponse(404, { success: false, error: '合约不存在' });
        if (inst.state !== 'disputed') return buildResponse(409, { success: false, error: '合约状态 ' + inst.state + ' 非争议中' });
        const r = String((payload || {}).ruling || '');
        if (r !== 'refund' && r !== 'release') return buildResponse(400, { success: false, error: 'ruling 须为 refund（全员退款）或 release（放行给收款方）' });
        const arbId = 'arb_' + inst.id + '_' + r;
        try {
          if (r === 'refund') {
            await escrowRefundAll(inst.id, arbId);
            inst.state = 'refunded';
          } else {
            let locked;
            try { locked = await db.collection(ESC_COL).where({ contractId: inst.id, status: 'locked' }).limit(1000).get(); } catch (e) { locked = { data: [] }; }
            for (const e of ((locked && locked.data) || [])) {
              if (e.kind === 'wallet' && (e.purpose === 'payment' || e.purpose === 'pool' || (inst.templateKey === 'gso' && !e.purpose))) {
                await escrowRelease(inst.id, inst.initiatorId, e.currency, e.amount, arbId + ':' + (e._id || e.entryId), '仲裁放行（交割给收款方）', e.purpose);
              } else if (e.kind === 'voucher') {
                for (const vid of e.voucherIds || []) {
                  try {
                    const vr = await gsGet('vouchers', vid);
                    const v = (vr && vr.data && vr.data[0]) || null;
                    if (v && v.currentHolderId === 'contract-escrow:' + inst.id) {
                      v.currentHolderId = inst.initiatorId;
                      v.lastTransferAt = Date.now();
                      await gsUpsert('vouchers', vid, v);
                    }
                  } catch (_) { /* 单凭证失败不阻塞 */ }
                }
                e.status = 'released'; e.releasedAt = Date.now(); e.releasedTo = inst.initiatorId;
                await gsUpsert(ESC_COL, e._id || e.entryId, e);
              }
            }
            await escrowRefundAll(inst.id, arbId, 'bond');
            inst.state = 'terminated';
          }
        } catch (arbErr) {
          return buildResponse(500, { success: false, error: '仲裁执行失败：' + ((arbErr && arbErr.message) || String(arbErr)) });
        }
        inst.history.push(CE.appendEvent(inst.history, { at: Date.now(), type: 'arbitrated', actorId: cAuth.userId || 'arb-admin', payload: { ruling: r, note: String((payload || {}).note || '') } }));
        inst.updatedAt = Date.now();
        await saveInstance(inst);
        return buildResponse(200, { success: true, data: { contractId: inst.id, state: inst.state, ruling: r } });
      }

      // ---------- 平台规则注册中心端点 ----------
      // GET /rules（公开）：任何人可验证规则值与治理链
      if (httpMethod === 'GET' && sub[0] === 'rules') {
        await ensureRulesSeeded();
        let res;
        try { res = await db.collection(RULES_COL).where({}).limit(100).get(); } catch (e) { res = { data: [] }; }
        const slim = ((res && res.data) || []).map((r) => ({
          ruleKey: r.ruleKey, value: r.value, description: r.description,
          pendingValue: r.pendingValue, proposedBy: r.proposedBy, proposedAt: r.proposedAt,
          effectiveAt: r.effectiveAt, cooldownMs: r.cooldownMs, version: r.version,
          historyCount: (r.history || []).length,
          chainIntact: CE.verifyChain(r.history || []).intact,
        }));
        return buildResponse(200, { success: true, data: { rules: slim } });
      }
      // POST /admin/rules/propose|activate|reject|verify [admin]
      if (httpMethod === 'POST' && sub[0] === 'admin' && sub[1] === 'rules') {
        const denied = requireAdmin(event);
        if (denied) return denied;
        await ensureRulesSeeded();
        const ruleKey = String((payload || {}).ruleKey || '');
        let rr;
        try { rr = await gsGet(RULES_COL, ruleKey); } catch (_) { rr = null; }
        const rule = (rr && rr.data && rr.data[0]) || null;
        if (!rule) return buildResponse(404, { success: false, error: '规则未注册: ' + ruleKey });
        const expectedVersion = Number(rule.version) || 1;
        const op = sub[2];
        if (op === 'propose') {
          const v = Number((payload || {}).value);
          // 范围校验按规则语义放宽：比率类 0..1、限额类可达十万级
          if (!Number.isFinite(v) || v < 0 || v > 100000) return buildResponse(400, { success: false, error: 'value 必须在 0..100000' });
          rule.pendingValue = v;
          rule.proposedBy = cAuth.userId || 'review-admin';
          rule.proposedAt = Date.now();
          rule.effectiveAt = Date.now() + (Number((payload || {}).cooldownMs) > 0 ? Number((payload || {}).cooldownMs) : rule.cooldownMs);
          if ((payload || {}).description) rule.description = String((payload || {}).description);
          rule.history.push(CE.appendEvent(rule.history, { at: Date.now(), type: 'proposed', actorId: rule.proposedBy, payload: { from: rule.value, to: v, effectiveAt: rule.effectiveAt } }));
          rule.version = expectedVersion + 1;
          const upd = Object.assign({}, rule);
          delete upd._id;
          const ok = await db.collection(RULES_COL).where({ _id: ruleKey, version: expectedVersion }).update(upd);
          const updated = ok && ok.updated != null ? ok.updated : ((ok && ok.stats && ok.stats.updated) || 0);
          if (!updated) return buildResponse(409, { success: false, error: '并发冲突，请重试' });
          return buildResponse(200, { success: true, data: { ruleKey, effectiveAt: rule.effectiveAt } });
        }
        if (op === 'activate') {
          if (rule.pendingValue === null || rule.pendingValue === undefined) return buildResponse(409, { success: false, error: '无待生效修改' });
          if (Date.now() < Number(rule.effectiveAt || 0)) return buildResponse(409, { success: false, error: '公示期未满（' + new Date(rule.effectiveAt).toLocaleString() + ' 后可生效）' });
          const from = rule.value;
          rule.value = Number(rule.pendingValue);
          rule.pendingValue = null;
          rule.effectiveAt = null;
          rule.history.push(CE.appendEvent(rule.history, { at: Date.now(), type: 'activated', actorId: cAuth.userId || 'review-admin', payload: { from, to: rule.value } }));
          rule.version = expectedVersion + 1;
          const upd = Object.assign({}, rule);
          delete upd._id;
          const ok = await db.collection(RULES_COL).where({ _id: ruleKey, version: expectedVersion }).update(upd);
          const updated = ok && ok.updated != null ? ok.updated : ((ok && ok.stats && ok.stats.updated) || 0);
          if (!updated) return buildResponse(409, { success: false, error: '并发冲突，请重试' });
          ruleCache.delete(ruleKey); // 失效缓存立即生效
          return buildResponse(200, { success: true, data: { ruleKey, value: rule.value } });
        }
        if (op === 'reject') {
          rule.history.push(CE.appendEvent(rule.history, { at: Date.now(), type: 'rejected', actorId: cAuth.userId || 'review-admin', payload: { pendingValue: rule.pendingValue } }));
          rule.pendingValue = null;
          rule.effectiveAt = null;
          rule.version = expectedVersion + 1;
          await gsUpsert(RULES_COL, ruleKey, rule);
          return buildResponse(200, { success: true, data: { ruleKey, value: rule.value } });
        }
        if (op === 'verify') {
          const chain = CE.verifyChain(rule.history || []);
          return buildResponse(200, { success: true, data: { ruleKey, chainIntact: chain.intact, length: chain.length, brokenAt: chain.brokenAt || null } });
        }
        return buildResponse(404, { success: false, error: 'unknown rules op' });
      }

      // POST /admin/revenue — 收益台账注入（测试设施）
      if (httpMethod === 'POST' && sub[0] === 'admin' && sub[1] === 'revenue') {
        const denied = requireAdmin(event);
        if (denied) return denied;
        const commission = Number((payload || {}).commission);
        if (!(payload || {}).gameId || !Number.isFinite(commission) || commission <= 0) {
          return buildResponse(400, { success: false, error: 'gameId 与正数 commission 必填' });
        }
        const entryId = 'rev_' + Date.now().toString(36) + '_' + require('crypto').randomBytes(3).toString('hex');
        await gsUpsert(REV_COL, entryId, {
          entryId, txId: entryId,
          source: String((payload || {}).source || 'store_sale'),
          gameId: String((payload || {}).gameId),
          grossAmount: commission, commission,
          currency: String((payload || {}).currency || 'gameCoins'),
          occurredAt: Date.now(),
          refId: String((payload || {}).refId || 'admin-test'),
          recordedBy: 'server',
        });
        return buildResponse(200, { success: true, data: { entryId } });
      }

      // ============ UGC 模板注册中心（合约工坊 CW-1，与本地 contractTunnel.ts 对齐） ============
      // POST /ugc-templates/submit — 提交模板（ACR 校验 → 风险分级 → 低/中自动过、高人工审）
      if (httpMethod === 'POST' && sub[0] === 'ugc-templates' && sub[1] === 'submit') {
        if (!cAuth.userId) return buildResponse(401, { success: false, error: '未登录' });
        const tplObj = (payload || {}).tpl;
        if (!tplObj || typeof tplObj !== 'object') return buildResponse(400, { success: false, error: '缺少模板体 tpl（ContractTemplate JSON）' });
        const slug = String((payload || {}).slug || String(tplObj.key || '').replace(/^ugc_[^_]+_/, '')).toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40);
        if (!slug) return buildResponse(400, { success: false, error: '缺少模板 slug（key 后缀）' });
        const fullKey = 'ugc_' + cAuth.userId + '_' + slug;
        tplObj.key = fullKey;
        const acr = CE.validateUgcTemplate(tplObj);
        if (!acr.ok) return buildResponse(400, { success: false, error: 'ACR 校验未通过', data: { issues: acr.issues } });
        const risk = CE.classifyTemplateRisk(tplObj);
        const existing = await ugcGet(fullKey);
        if (existing && existing.authorId !== cAuth.userId) return buildResponse(403, { success: false, error: '模板 key 已被占用' });
        const now = Date.now();
        const autoApproved = risk.level !== 'high';
        const contentHash = ugcTplContentHash(tplObj);
        const doc = {
          key: fullKey,
          authorId: cAuth.userId,
          authorName: String((payload || {}).authorName || cAuth.userId),
          version: ((existing && existing.version) || 0) + 1,
          tpl: tplObj,
          status: autoApproved ? 'approved' : 'pending',
          reviewPath: risk.level === 'medium' ? 'auto+sampled' : risk.level === 'low' ? 'auto' : 'manual',
          reviewedCodeHash: autoApproved ? contentHash : ((existing && existing.reviewedCodeHash) || null),
          reviewNote: '',
          riskClass: risk,
          source: String((payload || {}).source || 'manual'),
          forkOf: (payload || {}).forkOf ? String(payload.forkOf) : null,
          templateFeeBps: Math.max(0, Math.min(1000, Number((payload || {}).templateFeeBps) || 0)),
          stats: (existing && existing.stats) || { deployCount: 0 },
          createdAt: (existing && existing.createdAt) || now,
          updatedAt: now,
        };
        await gsUpsert(UGC_COL, fullKey, doc);
        return buildResponse(200, { success: true, data: { key: fullKey, status: doc.status, riskLevel: risk.level, riskReasons: risk.reasons, reviewPath: doc.reviewPath, version: doc.version } });
      }

      // GET /ugc-templates — 市场列表（公开 approved；?mine=1 本人全部状态）
      if (httpMethod === 'GET' && sub[0] === 'ugc-templates' && !sub[1]) {
        let rows = [];
        const mine = String((reqQuery || {}).mine || '') === '1';
        try {
          if (mine) {
            if (!cAuth.userId) return buildResponse(401, { success: false, error: '未登录' });
            const r = await db.collection(UGC_COL).where({ authorId: cAuth.userId }).limit(200).get();
            rows = (r && r.data) || [];
          } else {
            const r = await db.collection(UGC_COL).where({ status: 'approved' }).limit(200).get();
            rows = (r && r.data) || [];
          }
        } catch (e) { rows = []; }
        return buildResponse(200, { success: true, data: { templates: rows.map(ugcSlim) } });
      }

      // GET /ugc-templates/detail?key= — 模板全量（含 clauses，供 fork / 沙盒）
      if (httpMethod === 'GET' && sub[0] === 'ugc-templates' && sub[1] === 'detail') {
        const doc = await ugcGet((reqQuery || {}).key);
        if (!doc) return buildResponse(404, { success: false, error: 'UGC 模板不存在' });
        if (doc.status !== 'approved' && doc.authorId !== cAuth.userId && !authIsAdmin(cAuth)) {
          return buildResponse(403, { success: false, error: '模板未公开（待审/已驳回）' });
        }
        return buildResponse(200, { success: true, data: { template: Object.assign({}, ugcSlim(doc), { tpl: doc.tpl, reviewedCodeHash: doc.reviewedCodeHash }) } });
      }

      // POST /admin/ugc-templates/review — 人工审核（固化 reviewedCodeHash 防 TOCTOU）
      if (httpMethod === 'POST' && sub[0] === 'admin' && sub[1] === 'ugc-templates' && sub[2] === 'review') {
        const denied = requireAdmin(event);
        if (denied) return denied;
        const doc = await ugcGet((payload || {}).key);
        if (!doc) return buildResponse(404, { success: false, error: 'UGC 模板不存在' });
        if (doc.status !== 'pending') return buildResponse(409, { success: false, error: '模板状态为 ' + doc.status + '，非待审' });
        if ((payload || {}).approve) {
          doc.reviewedCodeHash = ugcTplContentHash(doc.tpl);
          doc.status = 'approved';
        } else {
          doc.status = 'rejected';
        }
        doc.reviewNote = String((payload || {}).note || '');
        doc.updatedAt = Date.now();
        await gsUpsert(UGC_COL, doc.key, doc);
        return buildResponse(200, { success: true, data: { key: doc.key, status: doc.status } });
      }

      return buildResponse(405, { success: false, error: 'method not allowed for __contract' });
    }

    // 点赞/点倒赞隧道：__vote（与本地 src/server/routes/games.ts 对齐）
    //   GET  /__vote?gameId= — 该游戏全部道具投票聚合 + 当前用户投票（游客可读，无 mine）
    //   POST /__vote { gameId, targetId, vote: 'up'|'down'|'cancel' } — 身份取自 token；
    //     每用户每目标一票（确定性 ID vote_{targetId}_{userId} 覆盖写），cancel 删除自己的票
    if (segments.length >= 1 && segments[0] === '__vote') {
      const voteAuth = extractAuth(event);

      const aggregateVotes = async (gid, uid) => {
        const counts = {};
        const mine = {};
        try {
          const res = await db.collection('voucher_votes').where({ gameId: String(gid) }).limit(1000).get();
          const docs = (res && res.data) || [];
          for (const d of docs) {
            const t = String(d.targetId || '');
            if (!t) continue;
            if (!counts[t]) counts[t] = { up: 0, down: 0 };
            if (d.vote === 'up') counts[t].up += 1;
            else if (d.vote === 'down') counts[t].down += 1;
            if (uid && d.userId === uid) mine[t] = d.vote;
          }
        } catch (_) {
          // 集合不存在/查询失败视为空
        }
        return { counts, mine };
      };

      // GET：游客可读（只有 counts，没有 mine）
      if (httpMethod === 'GET') {
        const gid = reqQuery.gameId;
        if (!gid) return buildResponse(400, { success: false, error: 'missing gameId' });
        const data = await aggregateVotes(gid, voteAuth.userId || null);
        return buildResponse(200, { success: true, data });
      }

      // 写操作需登录
      if (!voteAuth.userId) {
        return buildResponse(401, { success: false, error: '未登录：投票需要 Bearer token' });
      }
      // 实例级频控（与 __item 同模式）
      const voteRateMap = global.__voteRateMap || (global.__voteRateMap = new Map());
      const nowMs = Date.now();
      const vr = voteRateMap.get(voteAuth.userId);
      if (!vr || nowMs - vr.start > 60000) {
        voteRateMap.set(voteAuth.userId, { start: nowMs, n: 1 });
      } else if (++vr.n > 30) {
        return buildResponse(429, { success: false, error: '操作过于频繁', code: 'rate_limit' });
      }

      if (httpMethod === 'POST') {
        const { targetId, gameId, vote } = payload || {};
        if (!targetId || !gameId || ['up', 'down', 'cancel'].indexOf(vote) < 0) {
          return buildResponse(400, { success: false, error: 'missing/invalid targetId, gameId or vote' });
        }
        const docId = 'vote_' + String(targetId) + '_' + voteAuth.userId;
        try {
          if (vote === 'cancel') {
            // 集合不存在/无此票时静默视为已取消（.remove 在集合缺失时会抛 ResourceNotFound）
            await db.collection('voucher_votes').where({ _id: docId }).remove();
          } else {
            // gsUpsert：文档体剔除 _id/id + 集合缺失时自动 createCollection 并重试
            await gsUpsert('voucher_votes', docId, {
              targetId: String(targetId),
              gameId: String(gameId),
              userId: voteAuth.userId,
              vote,
              updatedAt: Date.now(),
            });
          }
        } catch (e) {
          const msg = (e && e.message) || String(e);
          // 取消时集合不存在 = 本来就没有票，不算失败
          if (vote === 'cancel' && /not exist|ResourceNotFound/i.test(msg)) {
            const data0 = await aggregateVotes(gameId, voteAuth.userId);
            return buildResponse(200, { success: true, data: data0 });
          }
          return buildResponse(500, { success: false, error: msg });
        }
        const data = await aggregateVotes(gameId, voteAuth.userId);
        return buildResponse(200, { success: true, data });
      }

      return buildResponse(405, { success: false, error: 'method not allowed for __vote' });
    }

    // ----------------------------------------------------------
    // 活动中心路由：activities / activities/leaderboard / activities/:id/claim
    // 与前端 src/activity/seed/defaultActivities.ts 保持一致的种子数据。
    // 跨浏览器共享：活动配置优先读 DB 集合 `activities`，榜单/领奖写 `activity_claims`。
    // ----------------------------------------------------------
    // 隧道兼容：线上 HTTP 访问服务只把 /api/v1/games/* 路由到本函数，
    // activities 前缀无法直达。前端改为请求 /api/v1/games/__activities/*，
    // 此处把 /games/__activities 重写为 /activities 后按 /api/v1/activities/* 处理。
    if (path.includes('__activities')) {
      path = path.replace('__activities', 'activities');
    }
    // HTTP 访问服务已剥掉 /api/v1/games 前缀，event.path 可能是 /activities/...
    if (path.startsWith('/activities') && !path.startsWith('/api/v1/activities')) {
      path = '/api/v1' + path;
    }
    if (path.startsWith('/api/v1/activities')) {
      const aseg = parseActivitySubPath(path);

      // GET /api/v1/activities → 活动列表
      if (httpMethod === 'GET' && aseg.length === 0) {
        let activities = [];
        try {
          const res = await db.collection('activities').limit(1000).get();
          activities = (res && res.data) || [];
        } catch (_) {
          activities = [];
        }
        if (!activities || activities.length === 0) {
          activities = DEFAULT_ACTIVITIES_SEED;
        }
        return buildResponse(200, { success: true, data: { activities } });
      }

      // GET /api/v1/activities/leaderboard → 全网领奖排行榜（跨浏览器）
      if (httpMethod === 'GET' && aseg.length === 1 && aseg[0] === 'leaderboard') {
        let claims = [];
        try {
          const res = await db.collection('activity_claims').limit(1000).get();
          claims = (res && res.data) || [];
        } catch (_) {
          claims = [];
        }
        const byUser = {};
        for (const c of claims) {
          const u = c.userId || 'anonymous';
          if (!byUser[u]) byUser[u] = { userId: u, nickname: c.nickname || u, totalCoins: 0, claims: 0, lastAt: 0 };
          byUser[u].totalCoins += (c.amount || 0);
          byUser[u].claims += 1;
          byUser[u].lastAt = Math.max(byUser[u].lastAt, c.createdAt || 0);
        }
        const ranked = Object.values(byUser).sort((a, b) => b.totalCoins - a.totalCoins).slice(0, 20);
        return buildResponse(200, { success: true, data: { leaderboard: ranked } });
      }

      // POST /api/v1/activities/:id/claim → 上报一次领奖（跨浏览器累计）
      if (httpMethod === 'POST' && aseg.length === 2 && aseg[1] === 'claim') {
        const activityId = aseg[0];
        const userId = payload.userId || 'anonymous';
        const nickname = payload.nickname || userId;
        const amount = Number(payload.amount) || 0;
        if (!activityId) {
          return buildResponse(400, { success: false, error: 'missing activityId' });
        }
        const claimDoc = {
          _id: `${activityId}_${userId}_${Date.now()}`,
          activityId,
          userId,
          nickname,
          amount,
          createdAt: Date.now(),
        };
        try {
          await db.collection('activity_claims').add(claimDoc);
        } catch (e) {
          // 集合可能不存在，尝试创建后重试
          try {
            await db.createCollection('activity_claims');
            await db.collection('activity_claims').add(claimDoc);
          } catch (_) {
            // 仍失败则不影响前端领奖成功提示
          }
        }
        return buildResponse(200, { success: true, data: { activityId, userId, amount } });
      }

      return buildResponse(404, { success: false, error: 'activity endpoint not found' });
    }

    // ----------------------------------------------------------
    // 游戏内服务隧道（publishing-center standard-sdk 调用）
    // 前端把 /api/<feature> 隧道化为 /api/v1/games/__<feature>，此处按 feature 分发。
    // 各 feature 使用独立集合，与平台核心 users/transactions/wallet 解耦，避免资金风险。
    // ----------------------------------------------------------
    if (segments.length >= 1 && segments[0].startsWith('__')) {
      const feature = segments[0].slice(2);
      const handler = GAME_SERVICE_HANDLERS[feature];
      if (handler) {
        try {
          const authorization = (event.headers && (event.headers.Authorization || event.headers.authorization)) || '';
          // CloudBase HTTP 访问服务把 query 放在 event.queryString / queryStringParameters，不在 event.path 内，
          // 合并进 q 以保证 GET 请求的查询参数可读
          const evtQuery = Object.assign(
            {},
            parseQuery(path),
            event.queryStringParameters || {},
            event.queryString ? parseQuery('?' + event.queryString) : {}
          );
          return await handler(httpMethod, segments.slice(1), payload, evtQuery, authorization, event, context);
        } catch (e) {
          const msg = (e && e.message) || String(e);
          console.error('[gamesvc]', feature, msg);
          return buildResponse(500, { success: false, error: feature + ' failed: ' + msg });
        }
      }
      return buildResponse(404, { success: false, error: 'unknown game service: ' + feature });
    }

    // GET /api/v1/games  → 列表
    // 注意：剔除 entryHtmlContent（自包含 HTML 可达 9MB，超过单回包 1MB 限制），
    // 前端实际播放时改从 CloudBase 云存储（cloudFileManifest）按需下载。
    // 审核可见性：默认仅返回已通过审核（approved 或旧数据缺省）的游戏；
    // 管理员（role=admin/platform）可通过 ?all=1 查看全部（含待审核/驳回/已下架）。
    if (httpMethod === 'GET' && segments.length === 0) {
      const listAuth = extractAuth(event);
      const wantAll = reviewQueryFlag(event, 'all');
      const res = await getCollection().field({ entryHtmlContent: false }).limit(1000).get();
      let games = res.data || [];
      if (wantAll && authIsAdmin(listAuth)) {
        console.log('[games] 管理员拉取全量游戏列表（含未过审）:', games.length);
      } else {
        games = games.filter(isPubliclyVisible);
      }
      return buildResponse(200, { success: true, data: { games } });
    }

    // GET /api/v1/games/:id  → 详情（包含 entryHtmlContent，供跨浏览器播放）
    // 注意：列表接口(GET /)仍剔除 entryHtmlContent（避免 N×大HTML 撑爆回包），
    // 但详情接口必须返回，否则前端无法拿到自包含 HTML，只能回退到云存储(常因安全规则失败)。
    if (httpMethod === 'GET' && segments.length === 1) {
      const res = await getCollection().where({ id: segments[0] }).limit(1).get();
      if (!res.data || res.data.length === 0) {
        return buildResponse(404, { success: false, error: 'game not found' });
      }
      const doc = res.data[0];
      // 审核可见性：未通过审核（pending/rejected/changes_required/removed）的游戏，
      // 仅管理员或发布者本人（JWT userId === publisherId）可读，其他一律 404（含直链播放）
      if (!isPubliclyVisible(doc)) {
        const detailAuth = extractAuth(event);
        const isOwner = !!detailAuth.userId && !!doc.publisherId && detailAuth.userId === doc.publisherId;
        if (!authIsAdmin(detailAuth) && !isOwner) {
          console.log('[games] 拦截未过审游戏的公开详情访问:', segments[0], 'status=', doc.reviewStatus);
          return buildResponse(404, { success: false, error: 'game not found' });
        }
      }
      // 6MB 保护：若自包含 HTML 过大，整份文档会超过 HTTP 回包上限(6MB)导致硬失败。
      // 超过 ~5MB 时剔除 entryHtmlContent 并标记，让前端回退到云存储/内联其它方案，
      // 而不是整个详情接口 500。
      const MAX_HTML = 5 * 1024 * 1024;
      if (typeof doc.entryHtmlContent === 'string' && doc.entryHtmlContent.length > MAX_HTML) {
        const size = doc.entryHtmlContent.length;
        delete doc.entryHtmlContent;
        doc.entryHtmlTooLarge = true;
        doc.entryHtmlSize = size;
      }
      return buildResponse(200, { success: true, data: doc });
    }

    // POST /api/v1/games  → 合并 upsert 发布
    // 注意：既接收「整份游戏元数据」，也接收「仅含 id + cloudFileManifest / entryHtmlContent」
    // 的部分回写（前端 patchPublishedGameOnBackend 统一走 POST，避免 HTTP 访问服务对 PATCH
    // 转发不稳定）。合并语义可保证并发写入不互相覆盖。
    if (httpMethod === 'POST' && segments.length === 0) {
      const rawGame = payload;
      if (!rawGame || !rawGame.id) {
        return buildResponse(400, { success: false, error: 'missing game.id' });
      }
      // 审核字段保护：剥离发布数据携带的审核状态/记录（只能经 __review 变更），
      // 防止发布方用缓存回写洗白 pending/rejected 状态。
      const game = stripReviewFields(rawGame);
      // 新创建的游戏默认进入待审核状态：审核独立于发布流程，
      // 即使 submit 审核端点调用失败，新游戏也不会绕过审核直接公开上架。
      // 已存在的游戏走 upsertMerge 字段级合并，审核字段天然保留。
      const existRes = await getCollection().where({ id: String(game.id) }).limit(1).get();
      const isExisting = !!(existRes && existRes.data && existRes.data.length > 0);
      const gameToSave = isExisting ? game : Object.assign({ reviewStatus: 'pending' }, game);
      const r = await upsertMerge(game.id, gameToSave);
      return buildResponse(200, { success: true, data: game, created: r.created });
    }

    // PATCH /api/v1/games/:id  → 部分更新（保留兼容，同样走合并 upsert）
    if (httpMethod === 'PATCH' && segments.length === 1) {
      if (!payload || Object.keys(payload).length === 0) {
        return buildResponse(400, { success: false, error: 'empty patch body' });
      }
      // 审核字段保护：剥离发布方携带的审核状态/记录（只能经 __review 变更）
      const safePatch = stripReviewFields(payload);
      const r = await upsertMerge(segments[0], safePatch);
      return buildResponse(200, { success: true, updated: r.updated, created: r.created });
    }

    // DELETE /api/v1/games/:id  → 删除
    // 优先用 .doc(id).remove()（文档由 .doc(id).set() 创建，_id === id，最可靠），
    // 再用 where().remove() 兜底清理任何残留。兼容 SDK 返回 deleted / removed 两种字段。
    if (httpMethod === 'DELETE' && segments.length === 1) {
      let removed = 0;
      try {
        const r1 = await getCollection().doc(segments[0]).remove();
        removed += (r1 && (r1.deleted || r1.removed)) || 0;
      } catch (_) {
        // 文档不存在或主键不匹配，忽略，走 where 兜底
      }
      try {
        const r2 = await getCollection().where({ id: segments[0] }).remove();
        removed += (r2 && (r2.deleted || r2.removed)) || 0;
      } catch (_) {
        // 忽略
      }
      return buildResponse(200, { success: true, removed });
    }

    // DELETE /api/v1/games  → 清空全部（批量删除，便于「删除全部记录」）
    if (httpMethod === 'DELETE' && segments.length === 0) {
      const listRes = await getCollection().field({ id: true }).limit(1000).get();
      const docs = listRes.data || [];
      let removed = 0;
      for (const d of docs) {
        const gid = d.id || d._id;
        if (!gid) continue;
        try {
          const r1 = await getCollection().doc(gid).remove();
          removed += (r1 && (r1.deleted || r1.removed)) || 0;
        } catch (_) {
          // 忽略
        }
      }
      // 再 where 兜底一次（清理无 id 主键的残留）
      try {
        const r2 = await getCollection().where({ _id: db.command.exists(true) }).remove();
        removed += (r2 && (r2.deleted || r2.removed)) || 0;
      } catch (_) {
        // 忽略
      }
      return buildResponse(200, { success: true, removed });
    }

    // ----------------------------------------------------------
    // 新增路由：manifest + files（模块化游戏跨浏览器加载）
    // ----------------------------------------------------------

    // GET /api/v1/games/:id/manifest → 文件清单（含 MIME 类型和路径）
    if (httpMethod === 'GET' && segments.length === 2 && segments[1] === 'manifest') {
      const gameId = segments[0];
      const manifest = await getGameManifest(gameId);
      if (!manifest) {
        // 游戏 可能没有 manifest（单文件游戏），返回空列表
        return buildResponse(200, {
          success: true,
          data: {
            fileCount: 0,
            files: [],
            gameId,
          },
        });
      }
      const files = manifest.map(m => ({
        path: m.fileName,
        mimeType: getMimeType(m.fileName),
        cloudFileID: m.cloudFileID,
      }));
      return buildResponse(200, {
        success: true,
        data: {
          fileCount: files.length,
          files,
          gameId,
        },
      });
    }

    // GET /api/v1/games/:id/files/*filePath → 从云存储下载单个文件
    // segments: [gameId, "files", pathParts...]
    if (httpMethod === 'GET' && segments.length >= 3 && segments[1] === 'files') {
      const gameId = segments[0];
      const filePath = segments.slice(2).join('/'); // e.g. "LF2_19/data/sprite.dat"

      // 优先从 game_files 集合读取（跨浏览器匿名直读，绕开云存储权限限制）
      try {
        const gfRes = await db.collection('game_files').doc(String(gameId)).get();
        const gfDoc = gfRes.data && gfRes.data[0];
        if (gfDoc && Array.isArray(gfDoc.files)) {
          const normPath = filePath.replace(/^\/+/, '');
          let match = gfDoc.files.find((f) => (f.path || '').replace(/^\/+/, '') === normPath);
          // 扩展资产回退：请求原路径（如 js/gun.js）根目录没有时，回退匹配任务扩展合并的资产
          // （extensions/{questId}/{submissionId}/...，取最新一个），使「补回被删文件」类任务对游戏零改动生效。
          // 匹配策略：① 完全等于 ② 尾部完整路径（extensions/.../js/gun.js）③ 文件名兜底
          // （文件选择器丢失目录前缀：extensions/.../gun.js 响应 js/gun.js 请求）。
          if (!match) {
            const extMatches = gfDoc.files.filter((f) => {
              const p = f.path || '';
              if (!p.startsWith('extensions/')) return false;
              if (p === normPath || p.endsWith('/' + normPath)) return true;
              const base = normPath.split('/').pop();
              return !!base && p.split('/').pop() === base;
            });
            if (extMatches.length) match = extMatches[extMatches.length - 1];
          }
          // 入口兜底（保留原行为，放在精确/扩展匹配之后）
          if (!match) match = gfDoc.files.find((f) => (f.path || '') === 'index.html');
          if (match && typeof match.content === 'string') {
            const mimeType = getMimeType(filePath);
            let body = Buffer.from(match.content, 'utf8');
            // 方案 E：入口 HTML 注入扩展脚本（幂等；失败静默跳过，不影响游戏加载）。
            if (mimeType.indexOf('text/html') >= 0 && !match.content.startsWith('__BINARY_BASE64__')) {
              try {
                const ires = await getCollection().where({ id: gameId }).limit(1).get();
                const idoc = (ires && ires.data && ires.data[0]) || null;
                if (isEntryFile(filePath, idoc && idoc.entryPoint)) {
                  // 方案 E + 方案 A：条件化注入 —— 仅注入 ?ext= 指定的那一个扩展；
                  // 无 ext（或 ext 不匹配）→ 纯净原版，不注入任何扩展脚本。
                  const allInjs = Array.isArray(idoc && idoc.injections) ? idoc.injections : [];
                  const injs = extParam
                    ? allInjs.filter((i) => i && i.submissionId === extParam)
                    : [];
                  if (injs.length) {
                    const injected = applyInjectionsToHtml(match.content, injs);
                    if (injected !== match.content) {
                      body = Buffer.from(injected, 'utf8');
                      console.log(`[files] 入口 HTML 按 ?ext=${extParam} 注入扩展脚本: ${filePath}, ${injs.length} 个`);
                    }
                  }
                  // 内容工坊：仅 contentSop.enabled 的游戏注入 ContentLoader 骨架
                  const contentSopEnabled = !!(idoc && idoc.contentSop && idoc.contentSop.enabled);
                  if (contentSopEnabled) {
                    const withLoader = applyContentLoaderToHtml(Buffer.isBuffer(body) ? body.toString('utf8') : match.content, true);
                    if (withLoader !== (Buffer.isBuffer(body) ? body.toString('utf8') : match.content)) {
                      body = Buffer.from(withLoader, 'utf8');
                      console.log(`[files] 入口 HTML 注入 ContentLoader 骨架: ${filePath}`);
                    }
                  }
                }
              } catch (e) {
                console.warn('[files] 注入扩展跳过', (e && e.message) || e);
              }
            }
            // 二进制文件：前端以 __BINARY_BASE64__ 前缀的 base64 存储，需还原为原始字节
            if (match.content.startsWith('__BINARY_BASE64__')) {
              body = Buffer.from(match.content.slice('__BINARY_BASE64__'.length), 'base64');
            }
            return buildFileResponse(200, body, mimeType);
          }
        }
      } catch (e) {
        console.warn('[files] game_files 读取失败，回退云存储', (e && e.message) || e);
      }

      const manifest = await getGameManifest(gameId);
      if (!manifest) {
        return buildResponse(404, {
          success: false,
          error: 'game not found or no cloudFileManifest',
        });
      }

      const cloudFileID = findCloudFileID(manifest, filePath);
      if (!cloudFileID) {
        return buildResponse(404, {
          success: false,
          error: 'file not found in manifest: ' + filePath,
        });
      }

      try {
        const contentBuffer = await fetchCloudFile(cloudFileID);
        const mimeType = getMimeType(filePath);

        // 6MB 安全上限：云函数回包超过此值会硬失败
        const MAX_SIZE = 6 * 1024 * 1024;
        if (contentBuffer.length > MAX_SIZE) {
          // 超大文件 → 返回 JSON 指示前端改用其他方式加载
          return buildResponse(200, {
            success: false,
            error: 'file too large for cloud function response',
            fileSize: contentBuffer.length,
            cloudFileID,
            suggestion: 'use getTempFileURL or CDN fallback',
          });
        }

        return buildFileResponse(200, contentBuffer, mimeType);
      } catch (fetchErr) {
        const msg = (fetchErr && fetchErr.message) || String(fetchErr);
        return buildResponse(500, {
          success: false,
          error: 'failed to fetch file from cloud storage: ' + msg,
          filePath,
          cloudFileID,
        });
      }
    }

    return buildResponse(405, { success: false, error: 'method not allowed' });
  } catch (e) {
    const msg = (e && e.message) || String(e);
    return buildResponse(500, { success: false, error: msg });
  }
};
