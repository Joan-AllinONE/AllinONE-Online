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

// ----------------------------------------------------------
// 主入口（事件型 HTTP 函数）
// ----------------------------------------------------------

exports.main = async (event, context) => {
  const httpMethod = (event.httpMethod || 'GET').toUpperCase();
  const path = event.path || '/';
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

    return buildResponse(405, { success: false, error: 'method not allowed' });
  } catch (e) {
    const msg = (e && e.message) || String(e);
    return buildResponse(500, { success: false, error: msg });
  }
};
