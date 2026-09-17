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

const app = cloudbase.init({
  env: cloudbase.SYMBOL_CURRENT_ENV,
});

const db = app.database();
const COLLECTION = 'published_games';

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

  // ============ 数据分析埋点 ============
  async analytics(method, seg, body) {
    const col = 'game_analytics';
    if (method === 'POST' && seg[0] === 'track') {
      const events = Array.isArray(body.events) ? body.events : [body];
      for (const ev of events) {
        await gsAppend(col, Object.assign({ _id: `ev_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, createdAt: Date.now() }, ev));
      }
      return buildResponse(200, { success: true, data: { tracked: events.length } });
    }
    if (method === 'GET') {
      const res = await db.collection(col).limit(1).get();
      return buildResponse(200, { success: true, data: { events: (res && res.data) || [] } });
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
  async 'game-developers'(method, seg, body) {
    const col = 'game_developer_accounts';
    if (method === 'GET' && seg.length === 0) {
      const res = await db.collection(col).limit(1000).get();
      return buildResponse(200, { success: true, data: (res && res.data) || [] });
    }
    if (method === 'GET' && seg.length >= 1 && seg[0] !== 'transactions') {
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
      return buildResponse(200, { success: true, data: tx });
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
      { key: 'levels', label: '关卡', dataShape: 'array', requiredKeys: ['id', 'title'], allowedAssetExts: ['json', 'js', 'png', 'jpg', 'mp3'], hint: 'data 为关卡数组，每关 { id, title, layout?, script?, cols?, enemyCols?, ... }；layout 为 15 行字符网格（#地面 B砖 ?金币 M蘑菇 X硬块 (|管道 C金币 F旗杆）或二维数字数组；script 指向 assets 的 .js（暴露 window.MarioLevel.build(api)，api 提供 setT/pipe/stairUp/stairDown/setFlag/setEnemies）；贴图/音效可放 png/jpg/mp3' },
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
      const bodyIdx = lower.lastIndexOf('</body>');
      return bodyIdx >= 0 ? html.slice(0, bodyIdx) + block + html.slice(bodyIdx) : html + block;
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
        if (schema.dataShape === 'array' && !Array.isArray(data)) {
          issues.push('slot "' + slot + '" 的 data 应为数组');
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
            slotArr.push(rawData);
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
      if (assetManifest.length || entryPoint || contentPack.inject === true) {
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
      try {
        const crypto = require('crypto');
        const secret = process.env.JWT_SECRET || 'allinone-platform-2026';
        const now = Math.floor(Date.now() / 1000);
        const exp = now + 24 * 3600; // 24h
        // 生成兼容 JWT 格式的 token（header.payload.signature）
        const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
        const payloadJson = Buffer.from(JSON.stringify({ userId, role: 'player', iat: now, exp })).toString('base64url');
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
    const READ_ONLY_COLLECTIONS = ['users', 'transactions', 'inventories'];

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
