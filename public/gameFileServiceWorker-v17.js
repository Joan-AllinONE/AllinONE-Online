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
 *  3) 方案 E「注入型扩展」：入口 HTML 由后端返回后，读取游戏详情的 injections，
 *     把注入块（CSS <link> + 内联 <style> + AllinONE_asset 资源帮助器 + 用户脚本）拼进页面
 *     （</body> 前）。任何游戏零改动即可生效，脚本可用 AllinONE_asset('文件名') 引用图片/音频。
 *  4) 方案 A「条件化注入」：仅当请求 URL 带 ?ext=<submissionId> 时注入对应扩展；
 *     无 ext = 纯净原版，绝不注入。与云函数 / dev games.ts 文件分发层保持一致。
 *     ⚠️ 注入过的 HTML 不再回写 IndexedDB，避免污染原版本地副本。
 *  5) v17：dev/同源直连转发改为显式重建请求（method/headers/body）。
 *     修复部分 Chrome 版本在 SW fetch handler 中直接 fetch(req) 转发 POST 丢失 body →
 *     后端收到空 body → dev-token 400 'Missing userId' → 任务提交者被记成 anonymous。
 *
 * 仅拦截同源 /api 请求；跨域请求（如游戏 iframe 直接托管在后端域）由浏览器直接发出，不在此 scope。
 */

const GAME_FILES_PREFIX = '/api/v1/games/';
// v17：同源转发行为修复（不涉及缓存语义，缓存名沿用 v5）
const CACHE_NAME = 'allinone-gamefiles-v5';
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

// ==================== v17：同源直连转发（显式重建请求） ====================
// 修复：部分 Chrome 版本在 SW fetch handler 中直接 fetch(req) 转发带 body 的请求
// 会丢失 POST body（后端收到空 body → 'Missing userId' 400）。
// 显式重建请求：非 GET/HEAD 用 arrayBuffer() 读出 body + 复制 headers 后 fetch(url, init)。
async function sameOriginFetch(req) {
  if (req.method === 'GET' || req.method === 'HEAD') {
    return fetch(req);
  }
  const headers = {};
  for (const [k, v] of req.headers.entries()) {
    // content-length 由浏览器按新 body 自动计算，不复制
    if (k.toLowerCase() === 'content-length') continue;
    headers[k] = v;
  }
  const body = await req.clone().arrayBuffer();
  return fetch(req.url, {
    method: req.method,
    headers,
    body,
    redirect: 'follow',
  });
}

// 将同域 /api/* 请求代理到后端。返回 Response，或 null（未配置基地址）。
// 注意浏览器兼容性问题：
//  1. POST body：用 arrayBuffer() 替代 ReadableStream（避免 duplex 兼容性问题）
//  2. Headers：只复制安全 headers（避免 forbidden headers 导致 fetch 失败）
//  3. CORS type：跨域代理返回的 Response type 是 'cors'，与原始 'same-origin' 不匹配
//     → 需要重新构造 Response（type: 'basic'）以匹配原始请求模式
async function proxyToBackend(req) {
  const base = await getApiBaseUrl();
  const url = new URL(req.url);
  if (!url.pathname.startsWith('/api/')) return null;
  // 未配置云函数基地址（dev 模式）→ 回退到同源直连（vite 代理 / server.js 同源托管）。
  // 这样 handleGameFileRequest 的三级回退在 dev 下也完整可用：后端 → Cache → IndexedDB。
  if (!base) {
    try {
      const resp = await sameOriginFetch(req);
      return resp;
    } catch (e) {
      console.warn('[SW] 同源后端请求失败:', req.url, e);
      return null;
    }
  }
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
    // 用 arrayBuffer() 读取完整 body，避免 ReadableStream 传输问题。
    if (resp.type === 'cors') {
      const bodyBuffer = await resp.arrayBuffer();
      const newHeaders = new Headers();
      for (const [k, v] of resp.headers.entries()) {
        // 去掉 CORS 相关头，因为响应将变为 same-origin 类型
        if (!k.toLowerCase().startsWith('access-control-')) {
          newHeaders.set(k, v);
        }
      }
      return new Response(bodyBuffer, {
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

// ==================== 方案 E：注入型扩展 ====================

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// 转义注入代码里的 </script>，避免提前闭合内联 script 标签
function escapeScriptClose(code) {
  return String(code).replace(/<\/script/gi, '<\\/script');
}

// 内联 CSS 的 url() 重写到 assetBase（相对路径，浏览器按文档 base 解析）
function rewriteCssUrls(css, base) {
  return String(css).replace(
    /url\(\s*(['"]?)(?!data:|https?:|\/\/|#)\/?([^'")]+)\1\s*\)/gi,
    (m, q, p) => 'url(' + q + base + String(p).replace(/^\/+/, '') + q + ')'
  );
}

// 构造注入块：CSS <link> + 内联 <style> + AllinONE_asset 资源帮助器 + 用户脚本。
// resolveBase(inj)：server/SW 模式默认相对 assetBase（浏览器按文档 base 解析）；
// GamePlay inline 模式传绝对文件分发 URL（srcDoc 的 baseURI 是 about:srcdoc）。
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
  // ③ 资源基础帮助器（图片/声音寻址）
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

// 把 injections 的注入块拼接进 HTML（</body> 前；无 body 则追加末尾）。
// 大小写不敏感匹配（部分游戏用 </BODY>）；幂等：含注入标记则不重复注入。
function applyInjectionsToHtml(html, injections, resolveBase) {
  if (!html || !Array.isArray(injections) || !injections.length) return html;
  if (html.indexOf('<!-- AllinONE 注入扩展') >= 0) return html;
  const r = resolveBase || ((inj) => (inj && inj.assetBase) || '');
  const blocks = injections.map((inj) => buildInjectionBlock(inj, r)).filter(Boolean).join('\n');
  if (!blocks) return html;
  const lower = html.toLowerCase();
  const bodyIdx = lower.lastIndexOf('</body>');
  if (bodyIdx >= 0) {
    return html.slice(0, bodyIdx) + blocks + html.slice(bodyIdx);
  }
  return html + blocks;
}

// ==================== 内容工坊：ContentLoader 骨架注入 ====================
// 仅 contentSop.enabled 的游戏注入固定 loader SDK（空操作，不激活任何内容）。
// 幂等标记：<!-- AllinONE 内容加载器 -->（与 server games.ts / 云函数 / GamePlay 保持一致）。
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
function applyContentLoaderToHtml(html, enabled) {
  if (!enabled || !html || html.indexOf(CONTENT_LOADER_MARKER) >= 0) return html;
  const block = '\n' + CONTENT_LOADER_MARKER + '\n' + CONTENT_LOADER_SNIPPET + '\n';
  const lower = html.toLowerCase();
  const bodyIdx = lower.lastIndexOf('</body>');
  return bodyIdx >= 0 ? html.slice(0, bodyIdx) + block + html.slice(bodyIdx) : html + block;
}

// 判断请求的文件是否为游戏入口（entryPoint 缺失时按 index.html 兜底；支持中文名编码兜底）
function isEntryFile(filePath, entryPoint) {
  const ep = String(entryPoint || 'index.html').replace(/^\/+/, '');
  const fp = String(filePath).replace(/^\/+/, '');
  if (fp === ep) return true;
  try {
    return decodeURIComponent(fp) === ep;
  } catch {
    return false;
  }
}

// 拉取游戏详情，取出 injections（方案 E）。失败返回 null（不阻断游戏加载）。
async function fetchGameInjections(gameId) {
  try {
    const base = await getApiBaseUrl();
    const detailUrl = base
      ? base + '/v1/games/' + encodeURIComponent(gameId)
      : '/api/v1/games/' + encodeURIComponent(gameId);
    const resp = await fetch(detailUrl, { redirect: 'follow' });
    if (!resp || !resp.ok) return null;
    const json = await resp.json().catch(() => null);
    const doc = json && json.data ? json.data : null;
    if (!doc) return null;
    const injections = Array.isArray(doc.injections) ? doc.injections : [];
    return {
      injections,
      entryPoint: typeof doc.entryPoint === 'string' ? doc.entryPoint : '',
      contentSopEnabled: !!(doc.contentSop && doc.contentSop.enabled),
    };
  } catch (e) {
    console.warn('[SW] 获取注入配置失败:', gameId, e);
    return null;
  }
}

// 后端命中时：若是入口 HTML 且 URL 带 ?ext= → 只注入该扩展后返回新的 Response。
// ⚠️ 方案 A：无 ?ext= = 纯净原版 → 不注入任何扩展（原版必须保持干净）。
// ⚠️ 幂等：后端/云函数已在文件分发层注入（内容含注入标记）则直接透传，避免重复注入。
async function maybeInjectEntryHtml(gameId, filePath, resp, extParam) {
  const mime = getMimeType(filePath);
  if (mime.indexOf('text/html') < 0) return resp;
  const text = await resp.clone().text();
  if (text.indexOf('<!-- AllinONE 注入扩展') >= 0 && text.indexOf(CONTENT_LOADER_MARKER) >= 0) return resp;
  const meta = await fetchGameInjections(gameId);
  if (!meta) return resp;
  if (!isEntryFile(filePath, meta.entryPoint)) return resp;
  let out = text;
  // 方案 A：条件化注入 —— 只取 ?ext= 指定的那一个；无 ext 时注入列表为空 → out 不变
  const list = extParam
    ? (meta.injections || []).filter((i) => i && i.submissionId === extParam)
    : [];
  const injected = applyInjectionsToHtml(out, list);
  if (injected !== out) out = injected;
  const withLoader = applyContentLoaderToHtml(out, meta.contentSopEnabled);
  if (withLoader !== out) out = withLoader;
  if (out === text) return resp;
  console.log('[SW] 按 ?ext=' + (extParam || '(无)') + ' 注入到入口 HTML:', filePath, 'injections:', list.length, 'loader:', meta.contentSopEnabled);
  return new Response(out, {
    status: 200,
    headers: {
      'Content-Type': mime,
      'Access-Control-Allow-Origin': '*',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'unsafe-none',
      'Cache-Control': 'no-cache',
      // 标记：注入过的副本不回写 IndexedDB（避免污染原版本地文件）
      'X-AllinONE-Injected': list.length ? '1' : '0',
    },
  });
}

// 三级回退：后端优先 -> Cache -> IndexedDB
async function handleGameFileRequest(req) {
  const url = new URL(req.url);
  const parsed = parseGameFileUrl(url.pathname);
  if (!parsed) {
    return new Response('Not a game file request', { status: 400 });
  }
  // 方案 A：?ext=<submissionId> 决定注入哪个扩展（无 ext = 纯净原版）
  const extParam = url.searchParams.get('ext') || '';

  console.log('[SW] 游戏文件请求:', parsed.gameId, parsed.filePath, extParam ? '?ext=' + extParam : '');

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
      // 方案 E + 方案 A：入口 HTML 按 ?ext= 条件注入扩展
      const out = await maybeInjectEntryHtml(parsed.gameId, parsed.filePath, resp, extParam);
      console.log('[SW] 后端返回成功:', parsed.filePath, 'status:', out.status, 'type:', out.type, 'size:', out.headers.get('content-length') || 'unknown');
      const cache = await caches.open(CACHE_NAME);
      cache.put(req, out.clone());
      // 持久化到 IndexedDB，供离线/后端不可用时耐久回放（方案2）
      // ⚠️ 注入过的副本不回写：否则原版（无 ?ext=）离线回放时会拿到带扩展的 HTML
      if (out.headers.get('X-AllinONE-Injected') !== '1') {
        void persistToIDB(parsed.gameId, parsed.filePath, out.clone());
      }
      return out;
    }
    console.warn('[SW] 后端返回非 OK:', parsed.filePath, 'status:', resp ? resp.status : 'null', 'ok:', resp ? resp.ok : 'null');
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
  //    带 ?ext= 时在此补注入（本地副本是纯净原版，注入不会回写）
  const idbResp = await serveFromIndexedDB(parsed, extParam);
  if (idbResp) return idbResp;

  return new Response(
    '/* 游戏文件不可用：后端离线且本地无缓存。请先在线加载一次本游戏，或启动后端服务。 */',
    {
      status: 503,
      headers: { 'Content-Type': 'application/javascript; charset=utf-8' },
    },
  );
}

async function serveFromIndexedDB(parsed, extParam) {
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

  // ⚠️ URL.pathname 保留百分号编码（中文文件名尤甚，如 超级玛丽改造5.html → %E8%B6%85...），
  // 而本地 IndexedDB 写入的是解码后的原始路径 → 必须同时匹配解码与编码两种形态。
  let decoded = '';
  try {
    decoded = decodeURIComponent(filePath);
  } catch {
    decoded = filePath;
  }

  const pathCandidates = [filePath, decoded];
  // 精确匹配
  let match = files.find((f) => f && pathCandidates.includes(f.path));
  // 回退：忽略前导斜杠
  if (!match) {
    for (const p of pathCandidates) {
      match = files.find((f) => f && f.path === p.replace(/^\/+/, ''));
      if (match) break;
    }
  }
  // 回退：扫描全部键的后缀（发布时路径与请求路径可能不完全一致）
  if (!match) {
    const keys = files.map((f) => (f && f.path) || '');
    for (const p of pathCandidates) {
      for (const key of keys) {
        if (key && key.endsWith(p)) {
          match = files.find((f) => f && f.path === key);
          if (match) break;
        }
      }
      if (match) break;
    }
  }
  if (!match || typeof match.content !== 'string') return null;

  let body = match.content;
  let mime = getMimeType(decoded);

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

  // 方案 A：IndexedDB 里存的是纯净原版 → 带 ?ext= 时在此按 submissionId 注入（不回写 IndexedDB）
  if (extParam && mime.indexOf('text/html') >= 0 && body.indexOf('<!-- AllinONE 注入扩展') < 0) {
    try {
      const meta = await fetchGameInjections(gameId);
      if (meta && isEntryFile(filePath, meta.entryPoint)) {
        const list = (meta.injections || []).filter((i) => i && i.submissionId === extParam);
        const injected = applyInjectionsToHtml(body, list);
        if (injected !== body) body = injected;
      }
    } catch (e) {
      /* 注入失败不阻断加载 */
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

// 判断是否是「应代理到云函数后端」的 API 请求
// 云函数现已支持 /api/v1/games/* 与 /api/v1/activities/* 两类路由
function isProxiedApiRequest(pathname) {
  return pathname.startsWith('/api/v1/games') || pathname.startsWith('/api/v1/activities');
}

// 判断是否是游戏文件请求（走三级回退）
function isGameApiRequest(pathname) {
  return pathname.startsWith('/api/v1/games');
}

// 统一入口：
// - 游戏相关 /api/v1/games/* 请求 → 代理到云函数后端（有三级回退）
// - 活动中心 /api/v1/activities/* 请求 → 代理到云函数后端（已支持）
// - 其余非游戏 /api/* 请求（analytics/redeem 等）→ 云函数不处理，返回空 JSON
// - 未配置基地址时 → 直接走默认网络（dev vite 代理 / 同域 server.js）
async function handleRequest(req) {
  const url = new URL(req.url);
  const base = await getApiBaseUrl();

  // 未配置基地址 → dev 模式（vite 代理或 server.js 同源）
  // 游戏文件请求仍尝试走 handleGameFileRequest（其内部后端代理 base 为空时返回 null，
  // 会继续回退 Cache → IndexedDB 本地文件），避免「后端重启/文件丢失」时白屏。
  if (!base) {
    const parsedDev = parseGameFileUrl(url.pathname);
    if (req.method === 'GET' && parsedDev) {
      return handleGameFileRequest(req);
    }
    try {
      // v17：显式重建请求转发，修复 POST body 丢失（dev-token 400 'Missing userId'）
      return await sameOriginFetch(req);
    } catch (e) {
      return new Response(
        JSON.stringify({ success: false, error: 'network unavailable (no backend configured)' }),
        { status: 503, headers: { 'Content-Type': 'application/json; charset=utf-8' } },
      );
    }
  }

  // 活动中心请求 → 代理到云函数后端（后端已支持，跨浏览器共享榜单/领奖）
  if (url.pathname.startsWith('/api/v1/activities')) {
    try {
      const resp = await proxyToBackend(req);
      if (resp) return resp;
    } catch (e) {
      console.warn('[SW] activities 代理失败:', e);
    }
    return new Response(
      JSON.stringify({ success: true, data: { activities: [] }, message: 'activities backend unavailable' }),
      { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } },
    );
  }

  // 非游戏/活动 API 路径 → 云函数不处理，返回空 200（静默处理，避免控制台 404 噪音）
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
