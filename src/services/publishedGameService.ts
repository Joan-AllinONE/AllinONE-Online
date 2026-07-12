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
  hostingType?: 'server' | 'inline' | 'external';
  baseUrl?: string;
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
export async function savePublishedGame(game: Omit<PublishedGame, 'players' | 'status'>): Promise<PublishedGame> {
  const newGame: PublishedGame = {
    ...game,
    players: game.players ?? 0,
    status: game.status ?? 'available',
    publisherId: game.publisherId || 'admin',
    publisherName: game.publisherName || '平台管理员',
    revenueSharePercent: game.revenueSharePercent ?? 10,
  };

  // ① 写入 CloudBase 数据库（主存储，通过写入队列）
  writeQueue.enqueue({
    collection: 'published_games',
    operation: 'upsert',
    data: newGame as any,
  });

  // ② 更新本地缓存
  let games = _publishedGamesCache || loadGamesFromCache();
  const existingIndex = games.findIndex(g => g.id === game.id);
  if (existingIndex >= 0) {
    games[existingIndex] = newGame;
  } else {
    games.push(newGame);
  }
  saveGamesToCache(games);

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
  const cloudGames = await loadGamesFromCloudBase();
  // 无论是否为空都更新缓存 + 派发事件（空也表示已同步过）
  saveGamesToCache(cloudGames);
  window.dispatchEvent(new CustomEvent('games-list-updated', {
    detail: { count: cloudGames.length }
  }));
  console.log(`[PublishedGame] 从 CloudBase 刷新缓存，${cloudGames.length} 个游戏`);
  return cloudGames.length;
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
  import('./cloudbaseStorage').then(({ uploadGameFiles }) => {
    const uploadFiles = files.map(f => ({
      name: f.name,
      path: f.path,
      content: typeof f.content === 'string' ? f.content : String(f.content),
    }));
    
    uploadGameFiles(gameId, uploadFiles).then(result => {
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

  // ② 同时保存本地缓存（加速后续读取）
  const json = JSON.stringify(storableFiles);
  if (trySaveLS(gameId, json)) {
    deleteFromDB(gameId).catch(() => {}); // 清理 IndexedDB 残留避免双写
    console.log(`[PublishedGame] 游戏文件已缓存到 localStorage: ${gameId}, ${storableFiles.length} 个文件`);
    return { saved: storableFiles.length, skipped: 0, warnings };
  }

  // ③ localStorage 缓存空间不足 → IndexedDB 缓存
  try {
    await saveToDB(gameId, json);
    console.log(`[PublishedGame] 游戏文件已缓存到 IndexedDB: ${gameId}, ${storableFiles.length} 个文件`);
    return { saved: storableFiles.length, skipped: 0, warnings };
  } catch (e) {
    const msg = `IndexedDB 缓存写入也失败: ${e instanceof Error ? e.message : String(e)}`;
    console.error(`[PublishedGame] ${msg}`);
    warnings.push(msg);
    return { saved: 0, skipped: 0, warnings };
  }
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

  // ② 清除云存储
  import('./cloudbaseStorage').then(({ deleteCloudGameFiles }) => {
    deleteCloudGameFiles(gameId).catch(() => {});
  }).catch(() => {});

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
