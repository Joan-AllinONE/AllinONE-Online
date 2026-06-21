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
let _cloudSyncInitiated = false;

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
  try {
    const { isCloudBaseReady, getCloudBaseApp } = await import('./cloudbase');
    if (!isCloudBaseReady()) return [];

    const res = await getCloudBaseApp().database()
      .collection('published_games')
      .limit(500)
      .get();

    if (res.data.length === 0) return [];
    return res.data as PublishedGame[];
  } catch (e) {
    console.warn('[PublishedGame] CloudBase 数据库读取失败:', e);
    return [];
  }
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

  // 异步从 CloudBase 刷新缓存（首次调用时触发一次）
  if (!_cloudSyncInitiated) {
    _cloudSyncInitiated = true;
    refreshGamesFromCloudBase();
  }

  return _publishedGamesCache!;
}

/**
 * 从 CloudBase 刷新游戏列表缓存
 * 数据库是权威数据源，本地缓存仅用于加速
 */
export async function refreshGamesFromCloudBase(): Promise<void> {
  const cloudGames = await loadGamesFromCloudBase();
  if (cloudGames.length > 0) {
    // CloudBase 数据覆盖本地缓存（权威数据源）
    saveGamesToCache(cloudGames);
    window.dispatchEvent(new CustomEvent('games-list-updated'));
    console.log(`[PublishedGame] 从 CloudBase 刷新缓存，${cloudGames.length} 个游戏`);
  }
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
    uploadGameFiles(gameId, files.map(f => ({
      name: f.name,
      path: f.path,
      content: typeof f.content === 'string' ? f.content : String(f.content),
    }))).then(result => {
      if (result.success) {
        console.log(`[PublishedGame] 游戏文件已上传到云存储: ${gameId}, ${result.uploaded} 个文件`);
      } else {
        console.warn(`[PublishedGame] 云存储上传部分失败: ${result.errors.join(', ')}`);
      }
    }).catch(() => {});
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

  // ④ 从 CloudBase 云存储下载（最终兜底）
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
 * 从 CloudBase 云存储下载游戏文件
 */
async function loadGameFilesFromCloud(gameId: string): Promise<StoredGameFile[] | null> {
  try {
    const { isCloudBaseReady, getCloudBaseApp } = await import('./cloudbase');
    if (!isCloudBaseReady()) return null;

    const app = getCloudBaseApp() as any;
    // 获取游戏目录下所有文件的临时 URL
    const cloudPath = `games/${gameId}/`;
    const result = await app.listFiles({ prefix: cloudPath, limit: 100 });
    
    if (!result?.fileList || result.fileList.length === 0) return null;

    const files: StoredGameFile[] = [];
    const errors: string[] = [];

    // 逐个下载文件内容
    for (const fileMeta of result.fileList) {
      try {
        const tempUrlResult = await app.getTempFileURL({ fileList: [fileMeta.fileid || fileMeta.Key || cloudPath + fileMeta.name] });
        if (tempUrlResult?.fileList?.[0]?.tempFileURL) {
          const url = tempUrlResult.fileList[0].tempFileURL;
          const response = await fetch(url);
          const content = await response.text();
          const path = fileMeta.name || fileMeta.Key?.replace(cloudPath, '') || 'unknown';
          files.push({
            path,
            name: path.split('/').pop() || path,
            content,
            size: fileMeta.size || content.length,
          });
        }
      } catch (e) {
        errors.push(`${fileMeta.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    if (errors.length > 0) {
      console.warn(`[PublishedGame] 云存储文件下载部分失败: ${errors.join(', ')}`);
    }

    return files.length > 0 ? files : null;
  } catch (e) {
    console.warn('[PublishedGame] 云存储文件加载失败:', e);
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
  deleteGameFiles,
  refreshGamesFromCloudBase,
};
