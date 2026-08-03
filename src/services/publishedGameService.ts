/**
 * 已发布游戏管理服务
 * 管理通过 Publishing Center 发布的游戏
 * 
 * 存储架构（2026-06-18 重构）：
 * - 游戏元数据（PublishedGame）：CloudBase 数据库为主存储，localStorage/IndexedDB 仅作缓存
 * - 游戏文件内容（HTML/图片/JS等）：CloudBase 云存储为主存储，IndexedDB 仅作本地缓存加速
 * 
 * 读取策略：
 * - getPublishedGames()：同步返回缓存 + 异步从 CloudBase 刷新
 * - getPublishedGame()：同步返回缓存（立即可用）
 * 
 * 写入策略：
 * - savePublishedGame()：先写 CloudBase 数据库（通过 writeQueue），再更新本地缓存
 */

import { saveToDB, loadFromDB, deleteFromDB, trySaveLS, tryLoadLS, deleteLS } from './gameFileDb';
import { gameDeveloperService } from './gameDeveloperService';
import { writeQueue } from './writeQueue';
import { isCloudSyncEnabled } from './cloudbase';
import { globalEventBus } from '@/skills/EventBus';

// ==================== SOP 跨浏览器持久化 ====================
// 背景：CloudBase 数据库 auth 已损坏，published_games 元数据无法跨浏览器持久化。
// 但 CloudBase 云存储（uploadFile + getTempFileURL）正常运行（与 published game 文件相同通道）。
// 因此 SOP 文档复用云存储通道（games/{gameId}/sop/sop.md），同时保留后端 API 作为辅助通道。
// 加载优先级：DB sopDocument 字段 → 后端 API → 云存储 → schema 回退。
//
// ⚠️ v3 修正（2026-07-16）：根因是 getTempFileURL 对匿名用户返回 STORAGE_EXCEED_AUTHORITY，
// cloudFileID/cloudPath + getTempFileURL 对匿名用户不可用。
// 而 published game HTML 跨浏览器工作的真正原因是 entryHtmlContent 直接存 DB 文档（匿名可读）。
// 因此 SOP 复用此 proven pattern — sopDocument 直接存 DB 文档作为首要通道。

const GAMES_API_BASE = '/api/v1/games';

// ---------- SOP 跨浏览器加载通道 ----------
// v3 修正后的通道优先级（按可靠性排序）：
// ⓪ DB 文档 sopDocument 字段（proven pattern，匿名用户可读 DB，最可靠）
// ① 后端 API GET /files/sop/sop.md（公开路由，无 JWT）
// ② 云存储 cloudFileID + getTempFileURL（仅认证用户可用，匿名返回 STORAGE_EXCEED_AUTHORITY）
// ③ 云存储 cloudPath + getTempFileURL（最后手段，匿名同样不可用）
//
// SOP 保存：
//   1. 云存储 uploadFile → 捕获 cloudFileID
//   2. DB 写入 cloudFileManifest + sopDocument（双重保障，匿名可读 sopDocument）
//   3. 后端 API POST /upload（辅助通道）

const SOP_FILE_NAME = 'sop/sop.md';

interface SopUploadResult {
  success: boolean;
  cloudFileID?: string;  // 上传成功时包含 cloudFileID，用于后续跨浏览器加载
}

/**
 * 将 SOP 文档上传到 CloudBase 云存储，并返回 cloudFileID 用于跨浏览器加载
 */
export async function saveSopToCloudStorage(gameId: string, md: string): Promise<SopUploadResult> {
  try {
    const { isCloudBaseReady } = await import('./cloudbase');
    if (!isCloudBaseReady()) {
      console.warn('[PublishedGame] SOP 云存储: CloudBase 未就绪');
      return { success: false };
    }

    const { uploadGameFiles } = await import('./cloudbaseStorage');
    const result = await uploadGameFiles(gameId, [{
      name: 'sop.md',
      path: SOP_FILE_NAME,
      content: md,
    }]);

    if (result.success && result.uploaded > 0 && result.fileManifest.length > 0) {
      const sopCloudFileID = result.fileManifest[0].cloudFileID;
      console.log(`[PublishedGame] SOP 已上传到云存储: games/${gameId}/${SOP_FILE_NAME}, cloudFileID=${sopCloudFileID}`);
      return { success: true, cloudFileID: sopCloudFileID };
    }
    console.warn('[PublishedGame] SOP 云存储上传失败:', result.errors);
    return { success: false };
  } catch (e) {
    console.warn('[PublishedGame] SOP 云存储上传异常:', e);
    return { success: false };
  }
}

/**
 * 从 CloudBase 跨浏览器加载 SOP 文档
 *
 * ⚠️ 2026-07-16 v3 根因修正：
 * getTempFileURL 对匿名用户返回 STORAGE_EXCEED_AUTHORITY（云存储安全规则限制），
 * 因此 cloudFileID/cloudPath + getTempFileURL 方式对匿名用户不可靠。
 * 而 published game HTML 跨浏览器工作的真正原因是 entryHtmlContent 直接存 DB 文档，
 * 匿名用户可读 DB（无鉴权限制）。
 *
 * SOP 应复用此 proven pattern — 优先从 DB 文档直接读 sopDocument 字段：
 * ⓪ DB 文档 sopDocument 字段直接读取（proven pattern，匿名用户可读，最可靠）
 * ① 后端 API GET /files/sop/sop.md（公开路由，无 JWT）
 * ② 云存储 cloudFileID + getTempFileURL（仅认证用户可用，匿名用户会 STORAGE_EXCEED_AUTHORITY）
 * ③ 云存储 cloudPath + getTempFileURL（最后手段，匿名用户同样不可用）
 */
export async function loadSopFromCloudStorage(gameId: string): Promise<string | null> {
  console.log(`[PublishedGame] SOP 跨浏览器加载开始: gameId=${gameId}`);
  try {
    const { isCloudBaseReady, getCloudBaseApp } = await import('./cloudbase');

    // ⓪ DB 文档直接读取 sopDocument（proven pattern，与 entryHtmlContent 一致）
    // 匿名用户可读 published_games 集合，这是最可靠的跨浏览器通道
    if (isCloudBaseReady()) {
      try {
        const db = getCloudBaseApp().database();
        const res = await db.collection('published_games')
          .where({ id: gameId })
          .field({ sopDocument: true })
          .limit(1)
          .get();
        if (res?.data?.length > 0 && res.data[0].sopDocument) {
          console.log(`[PublishedGame] SOP 从 DB 文档直接加载成功: ${gameId} (${String(res.data[0].sopDocument).length} 字节)`);
          return res.data[0].sopDocument as string;
        }
        console.log(`[PublishedGame] SOP DB 文档无 sopDocument 字段，继续尝试其他通道`);
      } catch (e) {
        console.warn('[PublishedGame] SOP DB 文档读取失败:', e);
      }
    }

    // ① 后端 API（公开路由，无需 JWT）
    const backendMd = await loadSopFromBackend(gameId);
    if (backendMd) {
      console.log(`[PublishedGame] SOP 从后端 API 加载成功: ${gameId} (${backendMd.length} 字节)`);
      return backendMd;
    }

    // ② 云存储 cloudFileID + getTempFileURL（仅认证用户可用）
    if (isCloudBaseReady()) {
      const app = getCloudBaseApp() as any;
      const db = app.database();
      const sopCloudPath = `games/${gameId}/${SOP_FILE_NAME}`;

      let sopCloudFileID: string | null = null;
      try {
        const res = await db.collection('published_games')
          .where({ id: gameId })
          .field({ cloudFileManifest: true })
          .limit(1)
          .get();
        if (res?.data?.length > 0) {
          const manifest = res.data[0].cloudFileManifest as Array<{ fileName: string; cloudFileID: string }> | undefined;
          if (manifest && manifest.length > 0) {
            const sopEntry = manifest.find((m: { fileName: string; cloudFileID: string }) => m.fileName === SOP_FILE_NAME);
            if (sopEntry) {
              sopCloudFileID = sopEntry.cloudFileID;
              console.log(`[PublishedGame] SOP cloudFileID 从 manifest 找到: ${sopCloudFileID}`);
            } else {
              const existingID = manifest[0].cloudFileID;
              const bucketPrefix = extractCloudBucketPrefix(existingID);
              if (bucketPrefix) {
                sopCloudFileID = `${bucketPrefix}/${sopCloudPath}`;
                console.log(`[PublishedGame] SOP cloudFileID 从 bucket 前缀构造: ${sopCloudFileID}`);
              }
            }
          }
        }
      } catch (e) {
        console.warn('[PublishedGame] SOP: 读取 cloudFileManifest 失败:', e);
      }

      if (sopCloudFileID) {
        const text = await fetchSopByCloudFileID(app, sopCloudFileID, gameId);
        if (text) return text;
      }

      // ③ 云存储 cloudPath + getTempFileURL（最后手段）
      console.log(`[PublishedGame] SOP cloudFileID 方式失败，回退到 cloudPath 方式: ${sopCloudPath}`);
      try {
        const result = await app.getTempFileURL({ fileList: [sopCloudPath] });
        console.log(`[PublishedGame] SOP cloudPath getTempFileURL 结果:`, JSON.stringify(result?.fileList?.map((f: any) => ({ code: f.code, status: f.status, tempFileURL: f.tempFileURL ? '(有URL)' : '(无URL)' }))));
        if (!result?.fileList || result.fileList.length === 0) {
          console.warn('[PublishedGame] SOP cloudPath getTempFileURL 返回空 fileList');
          return null;
        }

        const item = result.fileList[0];
        if (!item.tempFileURL) {
          console.warn(`[PublishedGame] SOP cloudPath getTempFileURL 返回无 tempFileURL, code=${item.code}, status=${item.status}`);
          return null;
        }

        const permanentUrl = stripUrlSignature(item.tempFileURL);
        for (const url of [permanentUrl, item.tempFileURL]) {
          try {
            const resp = await fetch(url);
            if (resp.ok) {
              const text = await resp.text();
              if (text && text.length > 0) {
                console.log(`[PublishedGame] SOP 从云存储(cloudPath回退)加载成功: ${gameId} (${text.length} 字节)`);
                return text;
              }
            }
          } catch (fetchErr) {
            console.warn(`[PublishedGame] SOP cloudPath fetch 异常: url=${url.substring(0, 80)}`);
          }
        }
        return null;
      } catch (e) {
        console.warn('[PublishedGame] SOP cloudPath getTempFileURL 异常:', e);
        return null;
      }
    }

    console.warn(`[PublishedGame] SOP 所有通道均失败: ${gameId}`);
    return null;
  } catch (e) {
    console.warn('[PublishedGame] SOP 跨浏览器加载异常:', e);
    return null;
  }
}

/** 从已有 cloudFileID 提取 cloud://envId.bucketId 前缀，用于构造其他文件的 cloudFileID */
function extractCloudBucketPrefix(cloudFileID: string): string | null {
  // cloudFileID 格式: cloud://envId.bucketId/cloudPath
  // 例如: cloud://allinonegaming-d4gmsmrzz573264f6.616c-...-1303031594/games/game-xxx/index.html
  // 提取 cloud://envId.bucketId 部分（不含 /cloudPath）
  if (!cloudFileID.startsWith('cloud://')) return null;
  const slashIdx = cloudFileID.indexOf('/', 8); // 8 = 'cloud://' 的长度
  if (slashIdx < 0) return null;
  return cloudFileID.substring(0, slashIdx);
}

/** 用 cloudFileID 获取下载 URL 并 fetch 内容 */
async function fetchSopByCloudFileID(app: any, cloudFileID: string, gameId: string): Promise<string | null> {
  try {
    const result = await app.getTempFileURL({ fileList: [cloudFileID] });
    console.log(`[PublishedGame] SOP cloudFileID getTempFileURL 结果:`, JSON.stringify(result?.fileList?.map((f: any) => ({ code: f.code, status: f.status, tempFileURL: f.tempFileURL ? '(有URL)' : '(无URL)' }))));
    if (!result?.fileList || result.fileList.length === 0) {
      console.warn('[PublishedGame] SOP cloudFileID getTempFileURL 返回空 fileList');
      return null;
    }

    const item = result.fileList[0];
    if (!item.tempFileURL) {
      console.warn(`[PublishedGame] SOP cloudFileID getTempFileURL 返回无 tempFileURL, code=${item.code}, status=${item.status}`);
      return null;
    }

    // 尝试永久公开 URL（stripUrlSignature）+ 临时 URL
    const permanentUrl = stripUrlSignature(item.tempFileURL);
    for (const url of [permanentUrl, item.tempFileURL]) {
      try {
        const resp = await fetch(url);
        if (resp.ok) {
          const text = await resp.text();
          if (text && text.length > 0) {
            console.log(`[PublishedGame] SOP 从云存储(cloudFileID)加载成功: ${gameId} (${text.length} 字节)`);
            return text;
          }
        }
        console.warn(`[PublishedGame] SOP cloudFileID fetch 失败: status=${resp.status}`);
      } catch (fetchErr) {
        console.warn(`[PublishedGame] SOP cloudFileID fetch 异常:`, fetchErr);
      }
    }
    return null;
  } catch (e) {
    console.warn('[PublishedGame] SOP cloudFileID getTempFileURL 异常:', e);
    return null;
  }
}

/** 将 SOP cloudFileID 添加到游戏的 cloudFileManifest 并写数据库（让其他浏览器可读取）
 *  同时将 sopDocument 内容也写入 DB（proven pattern，与 entryHtmlContent 一致，匿名用户可读）
 */
function addSopToCloudManifest(gameId: string, sopCloudFileID: string, sopMd?: string): void {
  // ① 读取当前缓存的游戏 manifest
  let games = _publishedGamesCache || loadGamesFromCache();
  const game = games.find(g => g.id === gameId);

  let manifest: Array<{ fileName: string; cloudFileID: string }>;

  if (game) {
    // 游戏在缓存中 → 更新本地缓存
    manifest = game.cloudFileManifest || [];
    const existingIdx = manifest.findIndex((m: { fileName: string; cloudFileID: string }) => m.fileName === SOP_FILE_NAME);
    if (existingIdx >= 0) {
      manifest[existingIdx] = { fileName: SOP_FILE_NAME, cloudFileID: sopCloudFileID };
    } else {
      manifest.push({ fileName: SOP_FILE_NAME, cloudFileID: sopCloudFileID });
    }
    game.cloudFileManifest = manifest;
    saveGamesToCache(games);
  } else {
    // ⚠️ 游戏不在缓存中（savePublishedGame 的 invalidateGamesCache 可能已清空）
    // 不回退 — 直接构建 manifest 写入 DB
    console.warn(`[PublishedGame] addSopToCloudManifest: 游戏 ${gameId} 不在缓存中，直接 DB 写入`);
    manifest = [{ fileName: SOP_FILE_NAME, cloudFileID: sopCloudFileID }];
  }

  // ② 写数据库：cloudFileManifest + sopDocument（双重保障）
  // sopDocument 直接存 DB 文档是匿名用户可读的 proven pattern（与 entryHtmlContent 一致）
  const dbData: Record<string, any> = {
    id: gameId,
    cloudFileManifest: manifest,
    _sopManifestUpdatedAt: Date.now(),
  };
  if (sopMd) {
    dbData.sopDocument = sopMd;
    dbData._sopDocumentUpdatedAt = Date.now();
  }

  writeQueue.enqueue({
    collection: 'published_games',
    operation: 'upsert',
    where: { id: gameId },
    data: dbData,
  });
  console.log(`[PublishedGame] SOP cloudFileID + sopDocument 已入队写 DB: ${sopCloudFileID}${sopMd ? ` (${sopMd.length} 字节)` : ''}`);

  // ③ 同时保存 SOP 到后端 API（辅助通道，fire-and-forget）
  if (sopMd) {
    saveSopToBackend(gameId, sopMd).then(ok => {
      if (ok) console.log(`[PublishedGame] SOP 后端 API 保存成功: ${gameId}`);
      else console.warn(`[PublishedGame] SOP 后端 API 保存失败（后端可能未运行）`);
    }).catch(() => {});
  }
}

// ---------- 后端 API 通道（辅助通道，需后端运行） ----------

let _backendSopToken: string | null = null;

/** 获取后端 dev-token（无需登录，仅用于签名 JWT 以调用认证 API） */
async function getBackendSopToken(): Promise<string | null> {
  if (_backendSopToken) return _backendSopToken;
  try {
    const res = await fetch(`${GAMES_API_BASE}/dev-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'platform-admin' }),
    });
    const json = await res.json();
    if (json?.success && json?.data?.token) {
      _backendSopToken = json.data.token;
      return _backendSopToken;
    }
  } catch {
    /* dev-token 不可用（如本地无后端）→ 回退云存储 */
  }
  return null;
}

/**
 * 将 SOP 文档持久化到后端 API（作为游戏文件 sop/sop.md）
 * 返回 true 表示成功，false 表示后端不可用
 */
export async function saveSopToBackend(gameId: string, md: string): Promise<boolean> {
  try {
    const token = await getBackendSopToken();
    if (!token) return false;
    const res = await fetch(`${GAMES_API_BASE}/${encodeURIComponent(gameId)}/upload`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        files: [
          { path: 'sop/sop.md', name: 'sop.md', content: md, size: md.length },
        ],
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * 从后端 API 读取 SOP 文档（跨浏览器辅助通道）
 * 返回 markdown 字符串，或 null（不存在/后端不可用）
 */
export async function loadSopFromBackend(gameId: string): Promise<string | null> {
  try {
    const res = await fetch(
      `${GAMES_API_BASE}/${encodeURIComponent(gameId)}/files/sop/sop.md`
    );
    if (!res.ok) return null;
    const text = await res.text();
    return text && text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

/**
 * 效果类型 - 支持内置类型和自定义扩展
 * 内置类型定义见 publishing-center/effects/EffectTypeRegistry.ts
 */
export type RedeemEffectType = string;

/** 内置效果类型常量（向后兼容） */
export const BUILT_IN_EFFECT_TYPES = {
  DIFFICULTY_REDUCER: 'difficulty_reducer',
  SPEED_BOOST: 'speed_boost',
  SCORE_BOOST: 'score_boost',
  EXTRA_LIFE: 'extra_life',
  TIME_BONUS: 'time_bonus',
  CUSTOM: 'custom',
} as const;

export interface RedeemItemConfig {
  name: string;
  description: string;
  gameItemId: string;
  effectType: RedeemEffectType;
  effects: Record<string, any>;
  quantity: number;
  price: number;
  currency: string;
  icon?: string;
  rarity?: string;
  imageUrl?: string;
}

export interface GameItemSop {
  schemaName: string;
  description?: string;
  aiPrompt: string;
  availableEffects: string[];
  effectRules: string[];
  constraints: Record<string, any>;
  forbidden: string[];
  effectCodeEnabled: boolean;
  effectCodeSignature?: string;
  effectCodeSandbox?: Record<string, string>;
  effectCodeReturns?: string;
  presetItems?: Array<{
    name: string;
    effect: string;
    params: Record<string, any>;
    description: string;
    icon?: string;
  }>;
  examples?: any[];
  paramFields?: Array<{
    name: string;
    type: string;
    description: string;
    constraints?: string;
  }>;
  /** 用户上传的 SOP 原始 Markdown 文档 */
  sopMarkdownRaw?: string;
}

export interface PublishedGame {
  id: string;
  name: string;
  description: string;
  framework: string;
  version: string;
  icon?: string;
  difficulty?: 'easy' | 'medium' | 'hard';
  rewards?: {
    computingPower: number;
    gameCoins: number;
  };
  players: number;
  status: 'available' | 'coming-soon' | 'maintenance';
  externalUrl?: string;
  cdnUrl?: string;
  publishedAt?: string;
  createdAt: string;
  updatedAt: string;
  skills: string[];
  skillConfigs?: Record<string, any>;
  entryPoint: string;
  fileCount: number;
  size: number;
  redeemItems?: RedeemItemConfig[];
  protocolMode?: 'inject' | 'integrated' | 'hybrid';
  publisherId?: string;
  publisherName?: string;
  revenueSharePercent?: number;
  itemSop?: GameItemSop;
  /** 道具工坊上传的 SOP 原始文档（与 itemSop 完全独立，互不影响） */
  sopDocument?: string;
  /** 云存储文件清单（fileName → cloudFileID），SOP 文件也存于此，跨浏览器加载用 cloudFileID 模式 */
  cloudFileManifest?: Array<{ fileName: string; cloudFileID: string }>;
  hostingType?: 'server' | 'inline' | 'external';
  baseUrl?: string;
  /** 是否为模块化多文件游戏（RequireJS/AMD/动态import）。模块化游戏必须用真实URL托管，srcDoc 内联会白屏 */
  isModular?: boolean;
}

const CACHE_KEY = 'allinone_published_games';  // localStorage 缓存键名（仅缓存）
const FILES_STORAGE_PREFIX = 'allinone_game_files_';

// ==================== 内存缓存 ====================

let _publishedGamesCache: PublishedGame[] | null = null;
let _cloudRefreshRetries = 0;
const MAX_CLOUD_REFRESH_RETRIES = 3;

/** 清除缓存 */
function invalidateGamesCache(): void {
  _publishedGamesCache = null;
}

/**
 * 将游戏列表写入本地缓存（仅缓存，不是主存储）
 * 优先 localStorage（同步快），配额不足时静默降级到 IndexedDB
 */
function saveGamesToCache(games: PublishedGame[]): void {
  _publishedGamesCache = games;
  const json = JSON.stringify(games);

  // ① 优先 localStorage（同步读写，速度最快）
  try {
    localStorage.setItem(CACHE_KEY, json);
    return;
  } catch (e) {
    if (!(e instanceof DOMException && e.name === 'QuotaExceededError')) {
      console.error('[PublishedGame] localStorage 缓存写入错误:', e);
      return;
    }
    // 配额不足 → 尝试释放旧格式游戏文件残留
    freeLocalStorageSpace();
    try {
      localStorage.setItem(CACHE_KEY, json);
      return;
    } catch { /* 仍然不足 */ }
  }

  // ② localStorage 放不下 → 降级到 IndexedDB 缓存
  console.warn('[PublishedGame] localStorage 缓存不足，降级到 IndexedDB 缓存');
  saveToDB('__games_cache__', json).catch(e => {
    console.error('[PublishedGame] IndexedDB 缓存写入失败:', e);
  });
  // 清除 localStorage 中的旧数据避免下次读到过期缓存
  localStorage.removeItem(CACHE_KEY);
}

/** 释放 localStorage 中的旧格式游戏文件残留空间 */
function freeLocalStorageSpace(): void {
  let freed = 0;
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const key = localStorage.key(i);
    if (key?.startsWith(FILES_STORAGE_PREFIX)) {
      const value = localStorage.getItem(key);
      if (value) freed += value.length;
      localStorage.removeItem(key);
    }
  }
  if (freed > 0) {
    console.log(`[PublishedGame] 已释放约 ${freed.toLocaleString()} 字符的 localStorage 空间`);
  }
}

/**
 * 从本地缓存读取游戏列表（仅缓存，数据源是 CloudBase）
 */
function loadGamesFromCache(): PublishedGame[] {
  try {
    const data = localStorage.getItem(CACHE_KEY);
    if (data) return JSON.parse(data);
  } catch (e) {
    console.error('[PublishedGame] 读取本地缓存失败:', e);
  }
  return [];
}

/**
 * 异步从 IndexedDB 缓存加载（localStorage 空时使用）
 */
async function loadGamesFromIDBCache(): Promise<PublishedGame[]> {
  try {
    const raw = await loadFromDB('__games_cache__');
    if (raw) {
      const games: PublishedGame[] = JSON.parse(raw);
      // 回写到 localStorage 尝试（如果现在有空间了）
      try {
        localStorage.setItem(CACHE_KEY, raw);
      } catch { /* localStorage 仍然不足 */ }
      return games;
    }
  } catch (e) {
    console.warn('[PublishedGame] IndexedDB 缓存加载失败:', e);
  }
  return [];
}

// ==================== CloudBase 数据库操作（主存储） ====================

/**
 * 从 CloudBase 数据库加载全部游戏元数据
 * 这是数据的权威来源
 */
async function loadGamesFromCloudBase(): Promise<PublishedGame[]> {
  const { isCloudBaseReady, getCloudBaseApp } = await import('./cloudbase');
  if (!isCloudBaseReady()) {
    // 抛错而非返回 [] — 让重试机制感知到"未就绪 ≠ 空集合"
    throw new Error('[PublishedGame] CloudBase 未就绪，无法加载游戏列表');
  }

  const res = await getCloudBaseApp().database()
    .collection('published_games')
    .limit(500)
    .get();

  console.log(`[PublishedGame] CloudBase 返回 ${res.data.length} 条已发布游戏记录`);
  // 兼容 CloudBase JSON 序列化丢失 undefined / Date 类型的情况
  return (res.data as PublishedGame[]) || [];
}

/**
 * 从 CloudBase 数据库加载单个游戏元数据
 */
async function loadGameFromCloudBase(gameId: string): Promise<PublishedGame | null> {
  try {
    const { isCloudBaseReady, getCloudBaseApp } = await import('./cloudbase');
    if (!isCloudBaseReady()) return null;

    const res = await getCloudBaseApp().database()
      .collection('published_games')
      .where({ id: gameId })
      .limit(1)
      .get();

    if (res.data.length > 0) return res.data[0] as PublishedGame;
    return null;
  } catch {
    return null;
  }
}

// ==================== 业务逻辑 ====================

/**
 * 保存发布的游戏
 * CloudBase 数据库为主存储，本地缓存为辅助
 */
export async function savePublishedGame(
  game: Omit<PublishedGame, 'players' | 'status'>,
  opts?: { waitForCloud?: boolean }
): Promise<PublishedGame> {
  const newGame: PublishedGame = {
    ...game,
    players: game.players ?? 0,
    status: game.status ?? 'available',
    publisherId: game.publisherId || 'admin',
    publisherName: game.publisherName || '平台管理员',
    revenueSharePercent: game.revenueSharePercent ?? 10,
  };

  // ① 写入 CloudBase 数据库（主存储，通过写入队列）
  // waitForCloud=true 时阻塞等待落云，用于 SOP 等关键字段，避免后台云刷新覆盖尚未落云的本地写入
  if (opts?.waitForCloud) {
    await writeQueue.enqueueAndWait({
      collection: 'published_games',
      operation: 'upsert',
      data: newGame as any,
    });
  } else {
    writeQueue.enqueue({
      collection: 'published_games',
      operation: 'upsert',
      data: newGame as any,
    });
  }

  // ② 更新本地缓存
  let games = _publishedGamesCache || loadGamesFromCache();
  const existingIndex = games.findIndex(g => g.id === game.id);
  if (existingIndex >= 0) {
    games[existingIndex] = newGame;
  } else {
    games.push(newGame);
  }
  saveGamesToCache(games);

  // ②.5 若含 SOP 文档 → 同步持久化到跨浏览器通道
  // v3 修正：SOP 跨浏览器持久化优先用 DB 文档 sopDocument 字段（proven pattern），
  // 云存储 + 后端 API 作为辅助通道
  if (newGame.sopDocument) {
    const sopMd = newGame.sopDocument;

    // 主通道：云存储上传（捕获 cloudFileID → 写 DB manifest + sopDocument）
    saveSopToCloudStorage(game.id, sopMd).then(uploadResult => {
      if (uploadResult.success && uploadResult.cloudFileID) {
        // v3 修正：传入 sopMd 确保 sopDocument 也写入 DB（匿名用户可读的 proven pattern）
        addSopToCloudManifest(game.id, uploadResult.cloudFileID, sopMd);
      } else if (!uploadResult.success) {
        console.warn('[PublishedGame] SOP 云存储保存失败，尝试后端 API 辅助通道');
        // 后端 API 作为辅助通道
        saveSopToBackend(game.id, sopMd).then(ok2 => {
          if (!ok2) console.warn('[PublishedGame] SOP 后端保存也失败，已保留本地缓存兜底');
        }).catch(() => {});
        // 同时尝试单独写 sopDocument 到 DB（兜底）
        writeQueue.enqueue({
          collection: 'published_games',
          operation: 'upsert',
          where: { id: game.id },
          data: { id: game.id, sopDocument: sopMd, _sopDocumentUpdatedAt: Date.now() },
        });
      }
    }).catch(() => {
      saveSopToBackend(game.id, sopMd).catch(() => {});
      // 兜底：写 sopDocument 到 DB
      writeQueue.enqueue({
        collection: 'published_games',
        operation: 'upsert',
        where: { id: game.id },
        data: { id: game.id, sopDocument: sopMd, _sopDocumentUpdatedAt: Date.now() },
      });
    });
  }

  // ③ 自动创建/更新游戏开发者账户（fire-and-forget）
  if (game.publisherId || game.publisherName) {
    gameDeveloperService.ensureAccount({
      gameId: game.id,
      gameName: game.name || game.id,
      publisherId: game.publisherId || 'admin',
      publisherName: game.publisherName || '平台管理员',
      revenueSharePercent: game.revenueSharePercent ?? 10,
    }).catch(e => console.warn('[PublishedGame] 创建开发者账户失败:', e));
  }

  // ④ 派发事件通知其他组件刷新
  window.dispatchEvent(new CustomEvent('game-published', { detail: { game: newGame } }));
  invalidateGamesCache();
  console.log('[PublishedGame] 游戏已保存到 CloudBase + 缓存:', newGame.name);

  // 活动中心埋点：游戏发布
  try { globalEventBus.emit('game.published', { gameId: newGame.id, title: newGame.name }, { userId: newGame.publisherId || 'anonymous', sessionId: 'web' }); } catch { /* ignore */ }

  return newGame;
}

/**
 * 获取所有已发布的游戏
 * 同步返回缓存（立即可用），异步从 CloudBase 刷新缓存
 */
export function getPublishedGames(): PublishedGame[] {
  if (_publishedGamesCache) return _publishedGamesCache;

  // 从本地缓存加载
  _publishedGamesCache = loadGamesFromCache();

  // 如果缓存为空，尝试从 IndexedDB 缓存加载
  if (!_publishedGamesCache.length) {
    // 异步加载 IndexedDB 缓存（不阻塞同步返回）
    loadGamesFromIDBCache().then(idbGames => {
      if (idbGames.length > 0 && !_publishedGamesCache?.length) {
        _publishedGamesCache = idbGames;
        saveGamesToCache(idbGames);
        window.dispatchEvent(new CustomEvent('games-list-updated'));
      }
    }).catch(() => {});
  }

  // 异步从 CloudBase 刷新缓存（带重试机制）
  // 条件放宽：只要重试次数未达上限就允许触发刷新（空缓存总是触发，有缓存也触发首次刷新）
  if (_cloudRefreshRetries < MAX_CLOUD_REFRESH_RETRIES && _publishedGamesCache.length === 0) {
    scheduleCloudRefresh();
  } else if (_cloudRefreshRetries === 0 && _publishedGamesCache.length > 0) {
    // 有缓存时也触发一次后台刷新（静默更新）
    scheduleCloudRefresh();
  }

  return _publishedGamesCache!;
}

/**
 * 带重试的 CloudBase 刷新调度器
 * 指数退避：1s → 2s → 4s，最多 3 次
 */
function scheduleCloudRefresh(): void {
  if (!isCloudSyncEnabled()) return; // dev 不写云：禁止后台拉取线上数据覆盖本地视图

  refreshGamesFromCloudBase()
    .then((count) => {
      _cloudRefreshRetries = 0; // 成功，重置计数器
      console.log(`[PublishedGame] CloudBase 刷新成功，${count} 个游戏`);
    })
    .catch((err) => {
      _cloudRefreshRetries++;
      if (_cloudRefreshRetries < MAX_CLOUD_REFRESH_RETRIES) {
        const delay = Math.pow(2, _cloudRefreshRetries) * 1000;
        console.warn(
          `[PublishedGame] CloudBase 刷新失败，${delay / 1000}s 后重试 (${_cloudRefreshRetries}/${MAX_CLOUD_REFRESH_RETRIES})`
        );
        setTimeout(scheduleCloudRefresh, delay);
      } else {
        console.error('[PublishedGame] CloudBase 刷新已达最大重试次数，放弃');
      }
    });
}

/**
 * 从 CloudBase 刷新游戏列表缓存
 * 数据库是权威数据源，本地缓存仅用于加速
 */
export async function refreshGamesFromCloudBase(): Promise<number> {
  if (!isCloudSyncEnabled()) return 0; // dev 不写云：不触达云端

  const cloudGames = await loadGamesFromCloudBase();

  // 🆕 合并本地缓存中尚存的 SOP 字段，避免云刷新覆盖尚未落云的本地写入
  // 场景：道具工坊上传 SOP 文档后触发的后台云刷新，可能先于 writeQueue 落云，
  // 此时云端还没有 sopDocument / itemSop，若直接覆盖本地缓存，SOP 会在刷新后丢失。
  // 策略：以云端为权威，但云端缺失的 SOP 字段用本地值补齐（仅补齐，不反向覆盖云端）。
  let mergedGames = cloudGames;
  try {
    const localGames = _publishedGamesCache || loadGamesFromCache();
    if (localGames.length > 0) {
      const localMap = new Map(localGames.map(g => [g.id, g]));
      mergedGames = cloudGames.map(cg => {
        const lg = localMap.get(cg.id);
        if (!lg) return cg;
        return {
          ...cg,
          sopDocument: cg.sopDocument ?? lg.sopDocument,
          itemSop: cg.itemSop ?? lg.itemSop,
        };
      });
    }
  } catch {
    // 合并失败不影响主流程，退化为直接使用云端数据
  }

  // 🆕 SOP 跨浏览器补齐（云存储为主 + 后端 API 为辅）
  // 对云端/本地都缺失 sopDocument 的游戏，从跨浏览器通道加载补齐。
  // 优先云存储（与 published game 文件同一通道，正常运行），后端 API 作为辅助。
  try {
    const needSop = mergedGames.filter(g => !g.sopDocument);
    if (needSop.length > 0) {
      await Promise.all(needSop.map(async (g) => {
        // 主通道：云存储
        const md = await loadSopFromCloudStorage(g.id);
        if (md) {
          g.sopDocument = md;
          return;
        }
        // 辅助通道：后端 API
        const md2 = await loadSopFromBackend(g.id);
        if (md2) g.sopDocument = md2;
      }));
    }
  } catch {
    // 跨浏览器通道不可用不影响主流程
  }

  // 无论是否为空都更新缓存 + 派发事件（空也表示已同步过）
  saveGamesToCache(mergedGames);
  window.dispatchEvent(new CustomEvent('games-list-updated', {
    detail: { count: mergedGames.length }
  }));
  console.log(`[PublishedGame] 从 CloudBase 刷新缓存，${mergedGames.length} 个游戏`);
  return mergedGames.length;
}

/**
 * 获取单个游戏（同步，从缓存）
 */
export function getPublishedGame(id: string): PublishedGame | null {
  const games = getPublishedGames();
  return games.find(g => g.id === id) || null;
}

/**
 * 删除发布的游戏
 */
export async function deletePublishedGame(id: string): Promise<boolean> {
  // ① 从 CloudBase 数据库删除（主存储）
  writeQueue.enqueue({
    collection: 'published_games',
    operation: 'delete',
    where: { id: id },
  });

  // ② 更新本地缓存
  const games = getPublishedGames();
  const filtered = games.filter(g => g.id !== id);

  if (filtered.length < games.length) {
    saveGamesToCache(filtered);
    // ③ 删除游戏文件缓存
    await deleteGameFiles(id);
    invalidateGamesCache();
    console.log('[PublishedGame] 游戏已从 CloudBase + 缓存删除:', id);
    return true;
  }

  return false;
}

/**
 * 更新游戏玩家数
 */
export function incrementGamePlayers(id: string): void {
  const games = getPublishedGames();
  const game = games.find(g => g.id === id);

  if (game) {
    game.players += 1;
    // 更新本地缓存
    saveGamesToCache(games);
    // 同步到 CloudBase（非阻塞）
    writeQueue.enqueue({
      collection: 'published_games',
      operation: 'upsert',
      data: game as any,
    });
  }
}

/**
 * 清空所有发布的游戏（调试用）
 */
export function clearPublishedGames(): void {
  // 清除本地缓存
  localStorage.removeItem(CACHE_KEY);
  deleteFromDB('__games_cache__').catch(() => {});
  // 清除游戏文件缓存
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const key = localStorage.key(i);
    if (key?.startsWith(FILES_STORAGE_PREFIX)) {
      localStorage.removeItem(key);
    }
  }
  _publishedGamesCache = null;
  console.log('[PublishedGame] 本地缓存已清空');
}

// ==================== 游戏文件存储 ====================

export interface StoredGameFile {
  path: string;
  name: string;
  content: string;
  size: number;
}

/** 将二进制数据转为 base64 字符串 */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * 将游戏文件内容存储
 * CloudBase 云存储为主，IndexedDB/localStorage 为本地缓存
 */
export async function saveGameFiles(
  gameId: string,
  files: Array<{ path: string; name: string; content: any; size?: number }>
): Promise<{ saved: number; skipped: number; warnings: string[] }> {
  const storableFiles: StoredGameFile[] = [];
  const warnings: string[] = [];

  for (const f of files) {
    let contentStr: string;

    if (typeof f.content === 'string') {
      contentStr = f.content;
    } else if (f.content instanceof Uint8Array) {
      contentStr = '__BINARY_BASE64__' + arrayBufferToBase64(new Uint8Array(f.content).buffer);
    } else if (f.content instanceof ArrayBuffer) {
      contentStr = '__BINARY_BASE64__' + arrayBufferToBase64(f.content);
    } else {
      contentStr = String(f.content);
    }

    const fileSize = f.size || f.content?.length || contentStr.length;

    storableFiles.push({
      path: f.path,
      name: f.name,
      content: contentStr,
      size: fileSize,
    });
  }

  // ① 上传到 CloudBase 云存储（主存储）
  // dev 不写云：跳过云端上传与文档写入，仅保留本地缓存（见下方 ②）
  if (isCloudSyncEnabled()) {
    import('./cloudbaseStorage').then(({ uploadGameFiles }) => {
      // 将文件内容统一转换为正确的格式：
      // - string：直接使用（文本文件）
      // - Uint8Array/ArrayBuffer：文本文件用 TextDecoder 解码，二进制文件传原始 bytes
      //   ⚠️ 绝不能用 String(uint8Array)——会返回 "47,42,10,..." 逗号分隔字节值
      const uploadFiles = files.map(f => {
        const filePath = f.path || f.name;
        let content: string | Uint8Array;

        if (typeof f.content === 'string') {
          content = f.content;
        } else if (f.content instanceof Uint8Array || f.content instanceof ArrayBuffer) {
          const bytes = f.content instanceof Uint8Array ? f.content : new Uint8Array(f.content);
          // 判断是否为文本文件（JS/HTML/CSS/JSON/XML/TXT/MD 等）
          const isText = /\.(html?|js|mjs|ts|css|json|xml|txt|md|csv|svg|con|cfg|ini)$/i.test(filePath);
          if (isText) {
            content = new TextDecoder('utf-8').decode(bytes);
          } else {
            // 二进制文件：传原始 Uint8Array，由 uploadGameFiles 处理
            content = bytes;
          }
        } else {
          content = String(f.content);
        }

        return {
          name: f.name,
          path: filePath,
          content,
        };
      });

      uploadGameFiles(gameId, uploadFiles as Array<{ name: string; content: string | Uint8Array; path: string }>).then(result => {
        if (result.success) {
          console.log(`[PublishedGame] 游戏文件已上传到云存储: ${gameId}, ${result.uploaded} 个文件`);
          // 将 cloudFileID 清单写入 published_games 文档，使跨浏览器可下载
          if (result.fileManifest.length > 0) {
            writeQueue.enqueue({
              collection: 'published_games',
              operation: 'upsert',
              where: { id: gameId },
              data: { id: gameId, cloudFileManifest: result.fileManifest, _cloudFilesUpdatedAt: Date.now() },
            });
          }
        } else {
          console.warn(`[PublishedGame] 云存储上传部分失败: ${result.errors.join(', ')}`);
        }
      }).catch(() => {});

      // ② 同时存储入口 HTML 内容到文档（跨浏览器立即可用，无需云存储下载）
      // 找到第一个 HTML 文件作为入口内容
      const htmlFile = uploadFiles.find(f => {
        const name = (f.path || f.name).toLowerCase();
        return name.endsWith('.html') || name.endsWith('.htm');
      });
      if (htmlFile) {
        writeQueue.enqueue({
          collection: 'published_games',
          operation: 'upsert',
          where: { id: gameId },
          data: {
            id: gameId,
            entryHtmlContent: typeof htmlFile.content === 'string' ? htmlFile.content : String(htmlFile.content),
            _entryHtmlUpdatedAt: Date.now(),
          },
        });
      }
    }).catch(() => {});
  }

  // ② 同时保存本地缓存（加速页面内同步读取）
  const json = JSON.stringify(storableFiles);
  // 始终写入 IndexedDB：Service Worker 离线兜底只读 IndexedDB，
  // 之前小游戏(<4.5MB)只写 localStorage 且会 deleteFromDB，导致 SW 无法离线/跨 origin 回放。
  try {
    await saveToDB(gameId, json);
  } catch (e) {
    console.warn(
      `[PublishedGame] IndexedDB 写入失败（降级仅 localStorage）: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (trySaveLS(gameId, json)) {
    console.log(
      `[PublishedGame] 游戏文件已缓存到 localStorage + IndexedDB: ${gameId}, ${storableFiles.length} 个文件`,
    );
  } else {
    console.log(
      `[PublishedGame] 游戏文件已缓存到 IndexedDB: ${gameId}, ${storableFiles.length} 个文件`,
    );
  }
  return { saved: storableFiles.length, skipped: 0, warnings };
}

/**
 * 加载已存储的游戏文件
 * 优先本地缓存（快速），其次从 CloudBase 云存储下载
 */
export async function loadGameFiles(gameId: string): Promise<StoredGameFile[] | null> {
  // ① 优先从本地缓存读取（同步、快速）
  const lsData = tryLoadLS(gameId);
  if (lsData !== null) {
    return JSON.parse(lsData) as StoredGameFile[];
  }

  // ② 回退到 localStorage 分块数据（兼容旧格式）
  const key = `${FILES_STORAGE_PREFIX}${gameId}`;
  const metaKey = `${key}_meta`;
  const meta = localStorage.getItem(metaKey);
  if (meta) {
    try {
      const { total } = JSON.parse(meta);
      let result = '';
      for (let i = 0; i < total; i++) {
        const chunk = localStorage.getItem(`${key}_part_${i}`);
        if (chunk === null) return null;
        result += chunk;
      }
      // 自动迁移到新格式
      try {
        if (trySaveLS(gameId, result)) {
          for (let i = 0; i < total; i++) localStorage.removeItem(`${key}_part_${i}`);
          localStorage.removeItem(metaKey);
        }
      } catch { /* 迁移失败不影响读取 */ }
      return JSON.parse(result) as StoredGameFile[];
    } catch { /* 解析失败则忽略 */ }
  }

  // ③ IndexedDB 缓存
  const dbData = await loadFromDB(gameId);
  if (dbData !== null) {
    return JSON.parse(dbData) as StoredGameFile[];
  }

  // ④ 从 CloudBase 文档中读取 entryHtmlContent（跨浏览器最快路径）
  const inlineHtml = await loadEntryHtmlFromDocument(gameId);
  if (inlineHtml) {
    // 构造单文件清单（仅含入口 HTML），写入本地缓存加速后续
    const singleFile: StoredGameFile = {
      path: gameId + '.html',
      name: gameId + '.html',
      content: inlineHtml,
      size: inlineHtml.length,
    };
    const json = JSON.stringify([singleFile]);
    trySaveLS(gameId, json) || await saveToDB(gameId, json).catch(() => {});
    return [singleFile];
  }

  // ⑤ 从 CloudBase 云存储下载（cloudFileManifest 方式）
  const cloudFiles = await loadGameFilesFromCloud(gameId);
  if (cloudFiles && cloudFiles.length > 0) {
    // 下载后写入本地缓存，加速下次读取
    const json = JSON.stringify(cloudFiles);
    trySaveLS(gameId, json) || await saveToDB(gameId, json).catch(() => {});
    return cloudFiles;
  }

  return null;
}

/**
 * 从 CloudBase 文档中读取存储的入口 HTML 内容
 * 这是跨浏览器加载的最快路径 — 不需要云存储下载
 */
async function loadEntryHtmlFromDocument(gameId: string): Promise<string | null> {
  try {
    const { isCloudBaseReady, getCloudBaseApp } = await import('./cloudbase');
    if (!isCloudBaseReady()) return null;

    const db = getCloudBaseApp().database();
    const res = await db.collection('published_games')
      .where({ id: gameId })
      .field({ entryHtmlContent: true })
      .limit(1)
      .get();

    if (res?.data?.length > 0 && res.data[0].entryHtmlContent) {
      console.log(`[PublishedGame] 从 CloudBase 文档加载了入口 HTML: ${gameId} (${res.data[0].entryHtmlContent.length} 字节)`);
      return res.data[0].entryHtmlContent;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 从 CloudBase 云存储下载游戏文件
 * 
 * 策略：
 * 1. 从 published_games 文档中读取 cloudFileManifest（上传时保存的 cloudFileID 清单）
 * 2. 使用 getTempFileURL 获取每个文件的临时下载链接
 * 3. fetch 下载内容，组装为 StoredGameFile[] 返回
 * 
 * 如果游戏文档中没有 cloudFileManifest，回退到尝试 getTempFileURL
 * 直接构造路径（兼容旧数据，但不可靠）
 */
async function loadGameFilesFromCloud(gameId: string): Promise<StoredGameFile[] | null> {
  try {
    const { isCloudBaseReady, getCloudBaseApp } = await import('./cloudbase');
    if (!isCloudBaseReady()) return null;

    const app = getCloudBaseApp() as any;
    const db = app.database();
    const cloudPath = `games/${gameId}/`;

    // ① 尝试从游戏文档中读取 cloudFileManifest（新路径，可靠）
    let fileManifest: Array<{ fileName: string; cloudFileID: string }> | null = null;
    try {
      const gameDoc = await db.collection('published_games')
        .where({ id: gameId }).limit(1).get();
      if (gameDoc?.data?.length > 0) {
        const doc = gameDoc.data[0];
        fileManifest = doc.cloudFileManifest || null;
      }
    } catch { /* 文档不存在或读取失败 */ }

    // ② 如果有清单，逐个下载
    if (fileManifest && fileManifest.length > 0) {
      return await downloadFilesFromManifest(app, fileManifest, cloudPath);
    }

    // ③ 无清单时回退：尝试直接构造路径下载（兼容旧数据）
    console.log(`[PublishedGame] 无 cloudFileManifest，尝试直接路径下载: ${gameId}`);
    return await downloadFilesFromPathGuess(app, cloudPath);

  } catch (e) {
    console.warn('[PublishedGame] 云存储文件加载失败:', e);
    return null;
  }
}

/** 从 cloudFileManifest 下载文件（可靠途径） */
async function downloadFilesFromManifest(
  app: any,
  manifest: Array<{ fileName: string; cloudFileID: string }>,
  _cloudPath: string
): Promise<StoredGameFile[]> {
  const cloudFileIDs = manifest.map(f => f.cloudFileID);
  
  // 批量获取临时下载 URL
  const tempUrlResult = await app.getTempFileURL({ fileList: cloudFileIDs });
  const urlMap = new Map<string, string>();
  if (tempUrlResult?.fileList) {
    for (const item of tempUrlResult.fileList) {
      if (item.tempFileURL) {
        urlMap.set(item.fileID, item.tempFileURL);
      }
    }
  }

  // 逐个下载文件内容
  const files: StoredGameFile[] = [];
  for (const m of manifest) {
    const url = urlMap.get(m.cloudFileID);
    if (!url) continue;
    try {
      const response = await fetch(url);
      if (!response.ok) continue;
      const content = await response.text();
      files.push({
        path: m.fileName,
        name: m.fileName.split('/').pop() || m.fileName,
        content,
        size: content.length,
      });
    } catch { /* 单个文件下载失败不影响其他文件 */ }
  }

  if (files.length > 0) {
    console.log(`[PublishedGame] 从 cloudFileManifest 下载了 ${files.length} 个文件`);
  }
  return files;
}

/** 无清单时回退：直接构造路径获取临时 URL（兼容旧数据） */
async function downloadFilesFromPathGuess(
  app: any,
  cloudPath: string
): Promise<StoredGameFile[] | null> {
  // 尝试常见的入口文件名
  const commonFiles = ['index.html'];
  const fileList = commonFiles.map(fn => `${cloudPath}${fn}`);

  try {
    const tempUrlResult = await app.getTempFileURL({ fileList });
    if (!tempUrlResult?.fileList) return null;

    const files: StoredGameFile[] = [];
    for (const item of tempUrlResult.fileList) {
      if (!item.tempFileURL || item.code === 'STORAGE_FILE_NONEXIST') continue;
      try {
        const response = await fetch(item.tempFileURL);
        if (!response.ok) continue;
        const content = await response.text();
        const path = item.fileID?.replace(cloudPath, '') || 'index.html';
        files.push({
          path,
          name: path.split('/').pop() || path,
          content,
          size: content.length,
        });
      } catch { /* skip */ }
    }

    return files.length > 0 ? files : null;
  } catch {
    return null;
  }
}

/**
 * 获取游戏入口文件的文本内容（HTML）
 */
export async function getGameEntryContent(gameId: string): Promise<string | null> {
  const files = await loadGameFiles(gameId);
  if (!files) return null;

  const game = getPublishedGame(gameId);
  const entryPoint = game?.entryPoint || 'index.html';

  const entry = files.find(f =>
    f.path === entryPoint ||
    f.path.endsWith('/' + entryPoint) ||
    f.name === entryPoint
  );

  if (entry) return decodeFileContent(entry.content);

  const htmlFile = files.find(f => f.name.endsWith('.html'));
  return htmlFile ? decodeFileContent(htmlFile.content) : null;
}

/** 解码文件内容 */
function decodeFileContent(content: string): string {
  if (!content) return content;
  if (content.startsWith('__BINARY_BASE64__')) {
    try {
      const base64 = content.slice('__BINARY_BASE64__'.length);
      const binaryStr = atob(base64);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
      return new TextDecoder('utf-8').decode(bytes);
    } catch {
      return content;
    }
  }
  return content;
}

/**
 * 获取自包含的游戏 HTML（将外部 JS/CSS 内联替换）
 */
export async function getSelfContainedGameHtml(gameId: string): Promise<string | null> {
  const files = await loadGameFiles(gameId);
  if (!files) return null;

  const game = getPublishedGame(gameId);
  const entryPoint = game?.entryPoint || 'index.html';

  const entry = files.find(f =>
    f.path === entryPoint ||
    f.path.endsWith('/' + entryPoint) ||
    f.name === entryPoint
  ) || files.find(f => f.name.endsWith('.html'));

  if (!entry) return null;

  let html = decodeFileContent(entry.content);
  const entryDir = entry.path.includes('/') ? entry.path.substring(0, entry.path.lastIndexOf('/') + 1) : '';

  const fileMap = new Map<string, string>();
  for (const f of files) {
    fileMap.set(f.path, decodeFileContent(f.content));
  }

  html = html.replace(
    /<link\s+[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)["'][^>]*\/?>/gi,
    (_match, href: string) => {
      const resolvedPath = resolveRelativePath(entryDir, href);
      const cssContent = fileMap.get(resolvedPath);
      if (cssContent !== undefined) {
        return `<style>/* inlined from ${href} */\n${cssContent}\n</style>`;
      }
      return _match;
    }
  );

  html = html.replace(
    /<script\s+[^>]*src=["']([^"']+)["'][^>]*><\/script>/gi,
    (_match, src: string) => {
      if (_match.includes('type="module"') || _match.includes("type='module'")) {
        return _match;
      }
      const resolvedPath = resolveRelativePath(entryDir, src);
      const jsContent = fileMap.get(resolvedPath);
      if (jsContent !== undefined) {
        return `<script>/* inlined from ${src} */\n${jsContent}\n</script>`;
      }
      return _match;
    }
  );

  return html;
}

/** 解析相对路径 */
function resolveRelativePath(baseDir: string, relativePath: string): string {
  const cleanPath = relativePath.split('?')[0].split('#')[0];
  if (cleanPath.startsWith('/')) return cleanPath.replace(/^\//, '');
  const combined = baseDir + cleanPath;
  const parts = combined.split('/');
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === '..') resolved.pop();
    else if (part !== '.' && part !== '') resolved.push(part);
  }
  return resolved.join('/');
}

// ==================== 云托管加载（URL 重写方案 / 公开读永久 URL） ====================

/**
 * 去掉临时下载 URL 的签名查询参数，得到永久公开 URL
 * 前提：CloudBase 云存储安全规则为公开读（read: true）
 * 这样 srcDoc 内的子资源可直接从云存储加载，无需任何鉴权 API 调用
 */
function stripUrlSignature(url: string): string {
  const i = url.indexOf('?');
  return i >= 0 ? url.slice(0, i) : url;
}

/**
 * 从 cloudFileManifest 中挑选最佳入口 HTML
 * 优先级：dist/index.html > dist/*.html > index.html > 非辅助非 src HTML > 非 src HTML > 兜底
 */
function pickBestEntryFromManifest(
  manifest: Array<{ fileName: string; cloudFileID: string }>
): string | null {
  const htmls = manifest
    .map(m => m.fileName)
    .filter(n => /\.html?$/i.test(n));
  if (htmls.length === 0) return null;

  const AUX = /(css|style|helper|bridge|test|demo|template|layout|partial|fragment)/i;
  const lower = (s: string) => s.toLowerCase();

  return (
    htmls.find(n => lower(n) === 'dist/index.html') ||
    htmls.find(n => lower(n).startsWith('dist/') && lower(n).endsWith('index.html')) ||
    htmls.find(n => lower(n).endsWith('/dist/index.html')) ||
    htmls.find(n => lower(n) === 'index.html') ||
    htmls.filter(n => !AUX.test(n) && !lower(n).startsWith('src/'))[0] ||
    htmls.filter(n => !lower(n).startsWith('src/'))[0] ||
    htmls[0]
  );
}

/** 重写 HTML 中的相对路径为云存储永久 URL */
function rewriteRelativeUrls(
  html: string,
  baseDir: string,
  urlMap: Map<string, string>
): string {
  return html.replace(
    /(href|src)\s*=\s*["']([^"']+)["']/gi,
    (match, attr: string, rawVal: string) => {
      const v = rawVal.trim();
      // 跳过绝对 URL / data / blob / 锚点 / 协议类
      if (
        /^(https?:)?\/\//i.test(v) ||
        v.startsWith('data:') ||
        v.startsWith('blob:') ||
        v.startsWith('#') ||
        v.startsWith('mailto:') ||
        v.startsWith('javascript:')
      ) {
        return match;
      }
      const resolved = resolveRelativePath(baseDir, v);
      const url =
        urlMap.get(resolved) ||
        urlMap.get(v) ||
        urlMap.get(v.replace(/^\.\//, ''));
      return url ? `${attr}="${url}"` : match;
    }
  );
}

/**
 * 获取云托管游戏 HTML（URL 重写方案，真正的多文件云加载）
 *
 * 流程（"CDN 当网盘"体验，子资源零鉴权）：
 * 1. 从 published_games 文档读取 cloudFileManifest（fileName → cloudFileID）
 * 2. getTempFileURL 批量获取 URL（打开游戏时仅调一次），去签名得永久公开 URL
 * 3. 选取最佳入口 HTML，fetch 其内容
 * 4. 重写入口 HTML 中所有相对路径为云存储永久 URL
 * 5. 返回 HTML，交由 iframe srcDoc 渲染；浏览器自动从云存储按需加载子资源
 *
 * 前提：CloudBase 云存储安全规则设为公开读（read: true）
 * 返回 null 时由上层回退到 getSelfContainedGameHtml
 */
export async function getCloudHostedGameHtml(gameId: string): Promise<string | null> {
  try {
    const { isCloudBaseReady, getCloudBaseApp } = await import('./cloudbase');
    if (!isCloudBaseReady()) return null;

    const app = getCloudBaseApp() as any;
    const db = app.database();

    // ① 读取文档中的文件清单 + 入口 HTML 回退内容
    let manifest: Array<{ fileName: string; cloudFileID: string }> | null = null;
    let entryHtmlContent: string | null = null;
    try {
      const res = await db.collection('published_games')
        .where({ id: gameId })
        .field({ cloudFileManifest: true, entryHtmlContent: true })
        .limit(1)
        .get();
      if (res?.data?.length > 0) {
        manifest = res.data[0].cloudFileManifest || null;
        entryHtmlContent = res.data[0].entryHtmlContent || null;
      }
    } catch { /* 文档读取失败 → 交给上层回退 */ }

    if (!manifest || manifest.length === 0) return null;

    // ② 批量获取临时 URL（一次调用），去签名 → 永久公开 URL
    const cloudFileIDs = manifest.map(m => m.cloudFileID);
    const urlMap = new Map<string, string>(); // fileName → 永久公开 URL
    try {
      const r = await app.getTempFileURL({ fileList: cloudFileIDs });
      if (r?.fileList) {
        for (const item of r.fileList) {
          if (item.status !== undefined && item.status !== 0) {
            console.warn(`[PublishedGame] getTempFileURL 项失败: ${item.fileID} status=${item.status} ${item.errMsg || ''}`);
          }
          if (item.tempFileURL && item.fileID) {
            const m = manifest.find(x => x.cloudFileID === item.fileID);
            if (m) urlMap.set(m.fileName, stripUrlSignature(item.tempFileURL));
          }
        }
      }
    } catch (e) {
      console.warn('[PublishedGame] getTempFileURL 批量获取失败:', e);
    }

    if (urlMap.size === 0) {
      console.warn('[PublishedGame] 未获取到任何云存储 URL（检查安全规则是否已设公开读）');
      return null;
    }

    // ③ 选取最佳入口 HTML 并 fetch 其内容
    const entryFileName = pickBestEntryFromManifest(manifest);
    let html: string | null = null;
    const entryUrl = entryFileName ? urlMap.get(entryFileName) : null;
    if (entryUrl) {
      try {
        const resp = await fetch(entryUrl);
        if (resp.ok) html = await resp.text();
      } catch { /* fetch 失败回退到文档内容 */ }
    }
    if (!html && entryHtmlContent) {
      html = entryHtmlContent;
      console.log('[PublishedGame] 入口 HTML 使用文档 entryHtmlContent 回退');
    }
    if (!html) return null;

    // ④ 重写相对路径为永久 URL
    const entryDir = entryFileName && entryFileName.includes('/')
      ? entryFileName.substring(0, entryFileName.lastIndexOf('/') + 1)
      : '';
    const rewritten = rewriteRelativeUrls(html, entryDir, urlMap);
    console.log(`[PublishedGame] 云托管模式（URL 重写完成），入口: ${entryFileName}, HTML 大小: ${rewritten.length} 字节, 子资源: ${urlMap.size} 个`);
    return rewritten;
  } catch (e) {
    console.warn('[PublishedGame] getCloudHostedGameHtml 失败:', e);
    return null;
  }
}

/**
 * 删除游戏文件存储（本地缓存 + 云存储）
 */
export async function deleteGameFiles(gameId: string): Promise<void> {
  // ① 清除本地缓存
  deleteLS(gameId);
  try {
    await deleteFromDB(gameId);
  } catch (e) {
    console.error('[PublishedGame] 删除 IndexedDB 缓存失败:', e);
  }

  // ② 清除云存储（dev 不写云：跳过）
  if (isCloudSyncEnabled()) {
    import('./cloudbaseStorage').then(({ deleteCloudGameFiles }) => {
      deleteCloudGameFiles(gameId).catch(() => {});
    }).catch(() => {});
  }

  console.log(`[PublishedGame] 游戏文件缓存已清除: ${gameId}`);
}

/**
 * 启动游戏
 */
export async function launchGame(gameId: string): Promise<{
  success: boolean;
  api?: any;
  error?: string;
}> {
  try {
    const game = getPublishedGame(gameId);
    if (!game) {
      return { success: false, error: '游戏不存在' };
    }

    const { createGameRuntime } = await import('@/publishing-center/runtime/PublishedGameRuntime');
    const api = await createGameRuntime(gameId, { debug: true });
    incrementGamePlayers(gameId);

    return { success: true, api };
  } catch (error) {
    console.error('[PublishedGame] 启动游戏失败:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

/**
 * 获取游戏的 Skill 配置
 */
export function getGameSkillConfigs(gameId: string): Record<string, any> | null {
  const game = getPublishedGame(gameId);
  return game?.skillConfigs || null;
}

/**
 * 更新游戏的 Skill 配置
 */
export function updateGameSkillConfigs(
  gameId: string,
  skillConfigs: Record<string, any>
): PublishedGame | null {
  const games = getPublishedGames();
  const gameIndex = games.findIndex(g => g.id === gameId);

  if (gameIndex < 0) return null;

  games[gameIndex] = {
    ...games[gameIndex],
    skillConfigs: {
      ...games[gameIndex].skillConfigs,
      ...skillConfigs,
    },
    updatedAt: new Date().toISOString(),
  };

  // 更新本地缓存
  saveGamesToCache(games);

  // 同步到 CloudBase（非阻塞）
  writeQueue.enqueue({
    collection: 'published_games',
    operation: 'upsert',
    data: games[gameIndex] as any,
  });

  return games[gameIndex];
}

export default {
  savePublishedGame,
  getPublishedGames,
  getPublishedGame,
  deletePublishedGame,
  incrementGamePlayers,
  clearPublishedGames,
  launchGame,
  getGameSkillConfigs,
  updateGameSkillConfigs,
  saveGameFiles,
  loadGameFiles,
  getGameEntryContent,
  getSelfContainedGameHtml,
  getCloudHostedGameHtml,
  deleteGameFiles,
  refreshGamesFromCloudBase,
};
