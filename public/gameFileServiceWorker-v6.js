/**
 * AllinONE 游戏文件 Service Worker
 * ---------------------------------
 * 职责：
 *  1) 拦截本站【同域】的 /api/* 请求，代理到可运行时配置的后端基地址
 *     （window.__API_BASE_URL，由页面写入 Cache Storage 的 allinone-config/api-config）。
 *     这样在 CloudBase 静态托管下，/api 不会被 rewrite 到 index.html，后端保持可达。
 *  2) 游戏文件 GET /api/v1/games/:gameId/files/* 三级回退：
 *       ① 后端优先（经代理）
 *       ② Cache Storage 回放
 *       ③ IndexedDB 本地文件回放（发布时写入，按 origin 隔离）
 *
 * 仅拦截同源 /api 请求；跨域请求（如游戏 iframe 直接托管在后端域）由浏览器直接发出，不在此 scope。
 */

const GAME_FILES_PREFIX = '/api/v1/games/';
const CACHE_NAME = 'allinone-gamefiles-v1';
const CONFIG_CACHE = 'allinone-config';
const CONFIG_KEY = '/api-config';

// IndexedDB（游戏文件离线兜底）
const IDB_NAME = 'AllinONE_GameFiles';
const IDB_VERSION = 1;
const IDB_STORE = 'game_files';

const MIME_MAP = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.ts': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.wasm': 'application/wasm',
};

function getMimeType(path) {
  const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
  return MIME_MAP[ext] || 'application/octet-stream';
}

function isTextMime(mime) {
  return (
    mime.startsWith('text/') ||
    mime.includes('javascript') ||
    mime.includes('json') ||
    mime.includes('xml') ||
    mime.includes('css')
  );
}

function base64FromArrayBuffer(buf) {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// ==================== 运行时后端基地址（代理目标） ====================

// 生产环境硬编码兜底：CloudBase 云函数永久 URL
// 当 Cache Storage 为空（首次访问/incognito）或 Cache Storage 中的 URL 无效时使用
// 开发环境（localhost）不使用硬编码，让 vite 代理处理
const PRODUCTION_BACKEND_URL = 'https://allinonegaming-d4gmsmrzz573264f6.service.tcloudbase.com/api';

// 校验 URL 是否有效（HTTPS + 不是已废弃的 CloudStudio URL）
function isValidBackendUrl(url) {
  if (!url || typeof url !== 'string' || url.length === 0) return false;
  // 必须 HTTPS（Mixed Content 会被浏览器阻止）
  if (!url.startsWith('https://')) return false;
  // 不能是已废弃的 CloudStudio URL（URL 会过期）
  if (url.includes('codebuddy.cloudstudio.run')) return false;
  return true;
}

async function getApiBaseUrl() {
  try {
    const cache = await caches.open(CONFIG_CACHE);
    const res = await cache.match(CONFIG_KEY);
    if (res) {
      const data = await res.json().catch(() => null);
      // 兼容两种字段名：syncApiConfigToSW 用 apiBaseUrl，install 预加载用 baseUrl
      const url = (data && data.apiBaseUrl) || (data && data.baseUrl);
      // 校验 URL 有效性：必须是 HTTPS 且不是 CloudStudio URL
      if (isValidBackendUrl(url)) {
        return url.replace(/\/$/, '');
      }
      // URL 无效（HTTP/CloudStudio）→ 清除 Cache Storage 中的旧值，使用硬编码兜底
      console.warn('[SW] Cache Storage 中的后端 URL 无效，使用硬编码兜底:', url);
      await cache.delete(CONFIG_KEY).catch(() => {});
    }
  } catch {
    /* ignore */
  }

  // Cache Storage 空/无效时：生产环境用硬编码兜底，开发环境返回空字符串
  if (self.location.origin.includes('tcloudbaseapp.com')) {
    return PRODUCTION_BACKEND_URL;
  }

  return '';
}

// 将同域 /api/* 请求代理到后端。返回 Response，或 null（未配置基地址）。
// 注意浏览器兼容性问题：
//  1. POST body：用 arrayBuffer() 替代 ReadableStream（避免 duplex 兼容性问题）
//  2. Headers：只复制安全 headers（避免 forbidden headers 导致 fetch 失败）
//  3. CORS type：跨域代理返回的 Response type 是 'cors'，与原始 'same-origin' 不匹配
//     → 需要重新构造 Response（type: 'basic'）以匹配原始请求模式
async function proxyToBackend(req) {
  const base = await getApiBaseUrl();
  if (!base) return null;
  const url = new URL(req.url);
  if (!url.pathname.startsWith('/api/')) return null;
  // base 形如 https://host/api，pathname 形如 /api/v1/games/...
  // 去掉 pathname 开头的 /api 再拼接，避免 /api/api 重复
  const target = base + url.pathname.slice('/api'.length) + url.search;

  // 只复制安全 headers，避免 forbidden headers（Host/Origin/Referer 等）导致 fetch 失败
  const SAFE_HEADERS = ['content-type', 'authorization', 'accept'];
  const headers = {};
  for (const [k, v] of req.headers.entries()) {
    if (SAFE_HEADERS.includes(k.toLowerCase())) {
      headers[k] = v;
    }
  }

  const init = {
    method: req.method,
    headers,
    redirect: 'follow',
    mode: 'cors',
  };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    // 用 arrayBuffer() 替代 ReadableStream，避免 duplex: 'half' 兼容性问题
    init.body = await req.clone().arrayBuffer();
  }
  try {
    const resp = await fetch(target, init);
    // 跨域代理响应的 type 是 'cors'，与原始 'same-origin' 请求模式不匹配。
    // 必须重新构造 Response（type: 'basic'），否则浏览器视为 network error。
    if (resp.type === 'cors') {
      const newHeaders = new Headers();
      for (const [k, v] of resp.headers.entries()) {
        // 去掉 CORS 相关头，因为响应将变为 same-origin 类型
        if (!k.toLowerCase().startsWith('access-control-')) {
          newHeaders.set(k, v);
        }
      }
      return new Response(resp.body, {
        status: resp.status,
        statusText: resp.statusText,
        headers: newHeaders,
      });
    }
    return resp;
  } catch (e) {
    console.warn('[SW] 后端代理请求失败:', target, e);
    return null;
  }
}

// ==================== IndexedDB 本地文件回放 ====================
function idbGet(gameId) {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(IDB_NAME, IDB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
      };
      req.onsuccess = () => {
        const db = req.result;
        try {
          const tx = db.transaction(IDB_STORE, 'readonly');
          const getReq = tx.objectStore(IDB_STORE).get(gameId);
          getReq.onsuccess = () => {
            db.close();
            resolve(getReq.result || null);
          };
          getReq.onerror = () => {
            db.close();
            resolve(null);
          };
        } catch {
          db.close();
          resolve(null);
        }
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function idbSet(gameId, data) {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(IDB_NAME, IDB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
      };
      req.onsuccess = () => {
        const db = req.result;
        try {
          const tx = db.transaction(IDB_STORE, 'readwrite');
          tx.objectStore(IDB_STORE).put(data, gameId);
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => {
            db.close();
            resolve();
          };
        } catch {
          db.close();
          resolve();
        }
      };
      req.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

// 将后端返回的游戏文件持久化到 IndexedDB，供离线/后端不可用时耐久回放（方案2）
async function persistToIDB(gameId, filePath, resp) {
  try {
    const mime = getMimeType(filePath);
    let content;
    if (isTextMime(mime)) {
      content = await resp.clone().text();
    } else {
      const buf = await resp.clone().arrayBuffer();
      content = '__BINARY_BASE64__' + base64FromArrayBuffer(buf);
    }
    const raw = await idbGet(gameId);
    let files = [];
    if (raw) {
      try {
        files = JSON.parse(raw);
        if (!Array.isArray(files)) files = [];
      } catch {
        files = [];
      }
    }
    const idx = files.findIndex((f) => f && f.path === filePath);
    if (idx >= 0) files[idx].content = content;
    else files.push({ path: filePath, content });
    await idbSet(gameId, JSON.stringify(files));
  } catch (e) {
    console.warn('[SW] 游戏文件持久化到 IndexedDB 失败:', gameId, filePath, e);
  }
}

function parseGameFileUrl(pathname) {
  if (!pathname.startsWith(GAME_FILES_PREFIX)) return null;
  const rest = pathname.slice(GAME_FILES_PREFIX.length); // :gameId/files/<filePath>
  const parts = rest.split('/');
  if (parts.length < 3) return null;
  const gameId = parts[0];
  const filePath = parts.slice(2).join('/'); // 去掉 'files'
  return { gameId, filePath };
}

// 三级回退：后端优先 -> Cache -> IndexedDB
async function handleGameFileRequest(req) {
  const url = new URL(req.url);
  const parsed = parseGameFileUrl(url.pathname);
  if (!parsed) {
    return new Response('Not a game file request', { status: 400 });
  }

  // 本地预览游戏（local-preview-*）：始终从 IndexedDB 读，不请求后端
  if (parsed.gameId.startsWith('local-preview')) {
    const idbResp = await serveFromIndexedDB(parsed);
    if (idbResp) return idbResp;
    return new Response('本地预览游戏文件不可用', { status: 404 });
  }

  // ① 优先请求后端（经 SW 代理到可配置基地址）
  try {
    const resp = await proxyToBackend(req);
    if (resp && resp.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(req, resp.clone());
      // 持久化到 IndexedDB，供离线/后端不可用时耐久回放（方案2）
      void persistToIDB(parsed.gameId, parsed.filePath, resp.clone());
      return resp;
    }
  } catch (err) {
    console.warn('[SW] 后端请求失败，尝试本地回放:', req.url, err);
  }

  // ② Cache Storage 回放（首次在线加载后由步骤①写入）
  try {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(req);
    if (cached) return cached;
  } catch {
    /* ignore */
  }

  // ③ IndexedDB 本地文件回放（发布时写入，按 origin 隔离）
  const idbResp = await serveFromIndexedDB(parsed);
  if (idbResp) return idbResp;

  return new Response(
    '/* 游戏文件不可用：后端离线且本地无缓存。请先在线加载一次本游戏，或启动后端服务。 */',
    {
      status: 503,
      headers: { 'Content-Type': 'application/javascript; charset=utf-8' },
    },
  );
}

async function serveFromIndexedDB(parsed) {
  const { gameId, filePath } = parsed;
  const raw = await idbGet(gameId);
  if (!raw) return null;
  let files;
  try {
    files = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(files)) return null;

  // 精确匹配
  let match = files.find((f) => f && f.path === filePath);
  // 回退：忽略前导斜杠
  if (!match) match = files.find((f) => f && f.path === filePath.replace(/^\/+/, ''));
  // 回退：扫描全部键（发布时 gameId 与存储键可能不一致）
  if (!match) {
    for (const key of files.map((f) => (f && f.path) || '')) {
      if (key && key.endsWith(filePath)) {
        match = files.find((f) => f && f.path === key);
        if (match) break;
      }
    }
  }
  if (!match || typeof match.content !== 'string') return null;

  let body = match.content;
  let mime = getMimeType(filePath);

  // 处理二进制 base64 存储
  if (body.startsWith('__BINARY_BASE64__')) {
    try {
      const b64 = body.slice('__BINARY_BASE64__'.length);
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new Response(bytes, {
        status: 200,
        headers: {
          'Content-Type': mime,
          'Access-Control-Allow-Origin': '*',
          'Cross-Origin-Resource-Policy': 'same-origin',
          'Cross-Origin-Embedder-Policy': 'unsafe-none',
          'Cache-Control': 'no-cache',
        },
      });
    } catch {
      return null;
    }
  }

  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': mime,
      'Access-Control-Allow-Origin': '*',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'unsafe-none',
      'Cache-Control': 'no-cache',
    },
  });
}

// 其他 /api 请求：代理到后端；后端不可用返回 503
async function handleApiRequest(req) {
  const parsed = parseGameFileUrl(new URL(req.url).pathname);
  if (req.method === 'GET' && parsed) {
    return handleGameFileRequest(req);
  }
  try {
    const resp = await proxyToBackend(req);
    if (resp) return resp;
  } catch (e) {
    console.warn('[SW] /api 代理失败:', e);
  }
  return new Response(
    JSON.stringify({ success: false, error: 'backend unavailable (SW proxy)' }),
    { status: 503, headers: { 'Content-Type': 'application/json; charset=utf-8' } },
  );
}

// 判断是否是游戏 API 请求（云函数后端仅处理 /api/v1/games/*）
function isGameApiRequest(pathname) {
  return pathname.startsWith('/api/v1/games');
}

// 统一入口：
// - 游戏相关 /api/v1/games/* 请求 → 代理到云函数后端（有三级回退）
// - 非游戏 /api/* 请求（activities/analytics/redeem 等）→ 云函数不处理，返回空 JSON
// - 未配置基地址时 → 直接走默认网络（dev vite 代理 / 同域 server.js）
async function handleRequest(req) {
  const url = new URL(req.url);
  const base = await getApiBaseUrl();

  // 未配置基地址 → 放行走默认网络（dev 模式，vite 代理或 server.js 同源）
  if (!base) {
    try {
      return await fetch(req);
    } catch (e) {
      return new Response(
        JSON.stringify({ success: false, error: 'network unavailable (no backend configured)' }),
        { status: 503, headers: { 'Content-Type': 'application/json; charset=utf-8' } },
      );
    }
  }

  // 非游戏 API 路径 → 云函数不处理，返回空 200（静默处理，避免控制台 404 噪音）
  if (!isGameApiRequest(url.pathname)) {
    return new Response(
      JSON.stringify({ success: true, data: null, message: 'endpoint not available on cloud function' }),
      { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } },
    );
  }

  // 游戏文件 GET 请求 → 三级回退
  const parsed = parseGameFileUrl(url.pathname);
  if (req.method === 'GET' && parsed) {
    return handleGameFileRequest(req);
  }

  // 其他游戏 API 请求 → 代理到云函数后端
  try {
    const resp = await proxyToBackend(req);
    if (resp) return resp;
  } catch (e) {
    console.warn('[SW] 游戏 API 代理失败:', e);
  }

  return new Response(
    JSON.stringify({ success: false, error: 'backend unavailable (SW proxy)' }),
    { status: 503, headers: { 'Content-Type': 'application/json; charset=utf-8' } },
  );
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  // 仅处理本站同源的 /api/ 请求；跨域（如游戏 iframe 在后端域）不在此 scope，直接放行
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith('/api/')) return;
  event.respondWith(handleRequest(req));
});

self.addEventListener('install', (event) => {
  // 不再预加载 config.js：CDN 可能返回旧版（含已废弃的 CloudStudio URL）
  // 改为依赖 getApiBaseUrl() 的硬编码兜底（PRODUCTION_BACKEND_URL）
  // 页面加载后 syncApiConfigToSW() 会写入正确的 URL 到 Cache Storage
  // 清除旧的无效 Cache Storage 条目（可能包含 CloudStudio URL）
  event.waitUntil(
    caches.open(CONFIG_CACHE).then((cache) =>
      cache.delete(CONFIG_KEY).catch(() => {})
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== CACHE_NAME && k !== CONFIG_CACHE)
          .map((k) => caches.delete(k)),
      ),
    ).then(() => self.clients.claim()),
  );
});
