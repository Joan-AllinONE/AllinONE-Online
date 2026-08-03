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
  if (!p) p = '/';
  const segments = p.split('/').filter(Boolean); // [] => 列表, [id] => 详情
  return segments;
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

exports.main = async (event, context) => {
  const httpMethod = (event.httpMethod || 'GET').toUpperCase();
  let path = event.path || '/';
  let rawBody = event.body || '';

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
    // 凭证系统路由（Bug 013 修复）：vouchers / voucher_templates /
    // purchases / voucher_transactions 的跨浏览器共享
    // 必须放在游戏 id 路由之前，否则 segments[0] 会被当成 gameId 而命中 game not found
    // ----------------------------------------------------------
    const VOUCHER_COLLECTIONS = ['vouchers', 'voucher_templates', 'purchases', 'voucher_transactions'];
    if (segments.length >= 1 && VOUCHER_COLLECTIONS.includes(segments[0])) {
      const colName = segments[0];

      // GET /vouchers?skip=0&limit=200 → 分页公开读取（跨浏览器共享）
      if (httpMethod === 'GET') {
        const q = parseQuery(path);
        const skip = Math.max(0, parseInt(q.skip || '0', 10) || 0);
        const limit = Math.min(200, Math.max(1, parseInt(q.limit || '200', 10) || 200));
        const res = await db.collection(colName).skip(skip).limit(limit).get();
        return buildResponse(200, { success: true, data: { list: res.data || [], skip, limit } });
      }

      // POST /vouchers（或 /vouchers/:id） → upsert 单条
      if (httpMethod === 'POST') {
        const doc = payload;
        if (!doc || !doc.id) {
          return buildResponse(400, { success: false, error: 'missing doc.id' });
        }
        const r = await db.collection(colName).doc(String(doc.id)).set(doc);
        return buildResponse(200, { success: true, data: { id: doc.id, updated: (r && r.updated) || 0 } });
      }

      // DELETE /vouchers/:id → 删除单条
      if (httpMethod === 'DELETE' && segments.length >= 2) {
        const r = await db.collection(colName).doc(String(segments[1])).remove();
        return buildResponse(200, { success: true, data: { id: segments[1], deleted: (r && (r.deleted || r.removed)) || 0 } });
      }

      return buildResponse(405, { success: false, error: 'method not allowed for voucher collection' });
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

    // GET /api/v1/games  → 列表
    // 注意：剔除 entryHtmlContent（自包含 HTML 可达 9MB，超过单回包 1MB 限制），
    // 前端实际播放时改从 CloudBase 云存储（cloudFileManifest）按需下载。
    if (httpMethod === 'GET' && segments.length === 0) {
      const res = await getCollection().field({ entryHtmlContent: false }).limit(1000).get();
      return buildResponse(200, { success: true, data: { games: res.data || [] } });
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
      const game = payload;
      if (!game || !game.id) {
        return buildResponse(400, { success: false, error: 'missing game.id' });
      }
      const r = await upsertMerge(game.id, game);
      return buildResponse(200, { success: true, data: game, created: r.created });
    }

    // PATCH /api/v1/games/:id  → 部分更新（保留兼容，同样走合并 upsert）
    if (httpMethod === 'PATCH' && segments.length === 1) {
      if (!payload || Object.keys(payload).length === 0) {
        return buildResponse(400, { success: false, error: 'empty patch body' });
      }
      const r = await upsertMerge(segments[0], payload);
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
