/**
 * 已发布游戏管理服务
 * 管理通过 Publishing Center 发布的游戏
 * 
 * - 游戏元数据（列表、配置）存储在 localStorage
 * - 游戏文件内容（HTML/图片/JS等）存储在 IndexedDB（限额远超 localStorage）
 */

import { saveToDB, loadFromDB, deleteFromDB, migrateGameFromLS, trySaveLS, tryLoadLS, deleteLS } from './gameFileDb';
import { gameDeveloperService } from './gameDeveloperService';

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
  /** 道具名称 (如: 难度降低器) */
  name: string;
  /** 道具描述 */
  description: string;
  /** 游戏内道具ID (游戏方自定义, 如 difficulty_reducer) */
  gameItemId: string;
  /** 效果类型 - 决定了 Effect Engine 如何注入执行脚本，支持注册表扩展 */
  effectType: RedeemEffectType;
  /** 效果元数据 (透传给游戏 + Effect Engine) */
  effects: Record<string, any>;
  /** 兑换后数量 */
  quantity: number;
  /** 价格 */
  price: number;
  /** 货币 */
  currency: string;
  /** 图标 */
  icon?: string;
  /** 稀有度 */
  rarity?: string;
  /** 图片URL */
  imageUrl?: string;
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
  /** 游戏配置的可兑换道具列表 (通过兑换条注入) */
  redeemItems?: RedeemItemConfig[];
  /** 协议模式: inject=注入适配(默认), integrated=标准集成 */
  protocolMode?: 'inject' | 'integrated' | 'hybrid';
  /** 🆕 发布者用户ID（谁发布的这个游戏） */
  publisherId?: string;
  /** 🆕 发布者名称 */
  publisherName?: string;
  /** 🆕 平台分成比例 (0-100)，默认 10 */
  revenueSharePercent?: number;
}

const STORAGE_KEY = 'allinone_published_games';
const FILES_STORAGE_PREFIX = 'allinone_game_files_';

/**
 * 保存发布的游戏
 */
export function savePublishedGame(game: Omit<PublishedGame, 'players' | 'status'>): PublishedGame {
  const games = getPublishedGames();
  
  const newGame: PublishedGame = {
    ...game,
    players: 0,
    status: 'available',
    publisherId: game.publisherId || 'admin',
    publisherName: game.publisherName || '平台管理员',
    revenueSharePercent: game.revenueSharePercent ?? 10,
  };
  
  // 检查是否已存在同名游戏
  const existingIndex = games.findIndex(g => g.id === game.id);
  if (existingIndex >= 0) {
    games[existingIndex] = newGame;
  } else {
    games.push(newGame);
  }
  
  localStorage.setItem(STORAGE_KEY, JSON.stringify(games));
  
  // CloudBase 双写
  import('./cloudbase').then(({ isCloudBaseReady, getCloudBaseApp }) => {
    if (!isCloudBaseReady()) return;
    const db = getCloudBaseApp().database();
    db.collection('published_games').where({ id: newGame.id }).get().then(res => {
      if (res.data.length > 0) {
        db.collection('published_games').doc(res.data[0]._id).update(newGame as any).catch(() => {});
      } else {
        db.collection('published_games').add(newGame as any).catch(() => {});
      }
    }).catch(() => {});
  }).catch(() => {});
  
  // 🆕 自动创建/更新游戏开发者账户
  if (game.publisherId || game.publisherName) {
    try {
      gameDeveloperService.ensureAccount({
        gameId: game.id,
        gameName: game.name || game.id,
        publisherId: game.publisherId || 'admin',
        publisherName: game.publisherName || '平台管理员',
        revenueSharePercent: game.revenueSharePercent ?? 10,
      });
    } catch (e) {
      console.warn('[PublishedGame] 创建开发者账户失败:', e);
    }
  }
  
  // 派发自定义事件，通知同一页面内的其他组件刷新游戏列表
  window.dispatchEvent(new CustomEvent('game-published', { detail: { game: newGame } }));
  console.log('[PublishedGame] 游戏已保存:', newGame.name);
  
  return newGame;
}

/**
 * 获取所有已发布的游戏
 */
export function getPublishedGames(): PublishedGame[] {
  try {
    const data = localStorage.getItem(STORAGE_KEY);
    if (data) {
      return JSON.parse(data);
    }
  } catch (e) {
    console.error('[PublishedGame] 读取游戏列表失败:', e);
  }
  return [];
}

/**
 * 获取单个游戏
 */
export function getPublishedGame(id: string): PublishedGame | null {
  const games = getPublishedGames();
  return games.find(g => g.id === id) || null;
}

/**
 * 删除发布的游戏
 */
export async function deletePublishedGame(id: string): Promise<boolean> {
  const games = getPublishedGames();
  const filtered = games.filter(g => g.id !== id);

  if (filtered.length < games.length) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(filtered));
    // CloudBase 删除
    import('./cloudbase').then(({ isCloudBaseReady, getCloudBaseApp }) => {
      if (!isCloudBaseReady()) return;
      getCloudBaseApp().database().collection('published_games').where({ id: id }).get().then(res => {
        for (const doc of res.data) {
          getCloudBaseApp().database().collection('published_games').doc(doc._id).remove().catch(() => {});
        }
      }).catch(() => {});
    }).catch(() => {});
    // 同时删除游戏文件存储
    await deleteGameFiles(id);
    console.log('[PublishedGame] 游戏已删除:', id);
    return true;
  }

  return false;
}

/**
 * 更新游戏玩家数（模拟）
 */
export function incrementGamePlayers(id: string): void {
  const games = getPublishedGames();
  const game = games.find(g => g.id === id);
  
  if (game) {
    game.players += 1;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(games));
  }
}

/**
 * 清空所有发布的游戏（调试用）
 */
export function clearPublishedGames(): void {
  localStorage.removeItem(STORAGE_KEY);
  // 同时清理所有游戏文件数据
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith(FILES_STORAGE_PREFIX)) {
      localStorage.removeItem(key);
    }
  }
  console.log('[PublishedGame] 所有游戏已清空');
}

// ==================== 游戏文件存储（使用 IndexedDB） ====================

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
 * 将游戏文件内容存储到 IndexedDB
 * 保留所有文件的完整性
 */
export async function saveGameFiles(
  gameId: string,
  files: Array<{ path: string; name: string; content: any; size?: number }>
): Promise<{ saved: number; skipped: number; warnings: string[] }> {
  const storableFiles: StoredGameFile[] = [];
  const warnings: string[] = [];

  for (const f of files) {
    let contentStr: string;

    // 处理不同格式的文件内容 — 保留原始数据完整性
    if (typeof f.content === 'string') {
      contentStr = f.content;
    } else if (f.content instanceof Uint8Array) {
      const cleanBytes = new Uint8Array(f.content);
      contentStr = '__BINARY_BASE64__' + arrayBufferToBase64(cleanBytes.buffer);
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

  const json = JSON.stringify(storableFiles);

  // 后台异步上传到 CloudBase 云存储（best-effort，不阻塞返回）
  import('./cloudbaseStorage').then(({ uploadGameFiles }) => {
    uploadGameFiles(gameId, files.map(f => ({
      name: f.name,
      path: f.path,
      content: typeof f.content === 'string' ? f.content : String(f.content),
    }))).catch(() => {});
  }).catch(() => {});

  // ① 优先尝试 localStorage（同步、快速）
  if (trySaveLS(gameId, json)) {
    // 同时清理可能残留的 IndexedDB 数据（避免双写）
    deleteFromDB(gameId).catch(() => {});
    console.log(`[PublishedGame] 游戏文件已保存到 localStorage: ${gameId}, ${storableFiles.length} 个文件`);
    return { saved: storableFiles.length, skipped: 0, warnings };
  }

  // ② localStorage 放不下 → 降级到 IndexedDB
  try {
    await saveToDB(gameId, json);
    console.log(`[PublishedGame] 游戏文件已保存到 IndexedDB: ${gameId}, ${storableFiles.length} 个文件`);
    return { saved: storableFiles.length, skipped: 0, warnings };
  } catch (e) {
    const msg = `IndexedDB 也写入失败: ${e instanceof Error ? e.message : String(e)}`;
    console.error(`[PublishedGame] ${msg}`);
    warnings.push(msg);
    return { saved: 0, skipped: 0, warnings };
  }
}

/**
 * 从 IndexedDB 加载已存储的游戏文件（兼容 localStorage 旧数据）
 */
export async function loadGameFiles(gameId: string): Promise<StoredGameFile[] | null> {
  try {
    // ① 优先从 localStorage 读取（同步更快）
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
        // 自动迁移到新的 localStorage 格式
        try {
          if (trySaveLS(gameId, result)) {
            for (let i = 0; i < total; i++) localStorage.removeItem(`${key}_part_${i}`);
            localStorage.removeItem(metaKey);
          }
        } catch { /* 迁移失败不影响读取 */ }
        return JSON.parse(result) as StoredGameFile[];
      } catch { /* 解析失败则忽略 */ }
    }

    // ③ 最后尝试 IndexedDB（大文件存留地）
    const dbData = await loadFromDB(gameId);
    if (dbData !== null) {
      return JSON.parse(dbData) as StoredGameFile[];
    }
  } catch (e) {
    console.error('[PublishedGame] 加载游戏文件失败:', e);
  }
  return null;
}

/**
 * 获取游戏入口文件的文本内容（HTML）
 */
export async function getGameEntryContent(gameId: string): Promise<string | null> {
  const files = await loadGameFiles(gameId);
  if (!files) return null;

  // 先尝试用 entryPoint 精确匹配
  const game = getPublishedGame(gameId);
  const entryPoint = game?.entryPoint || 'index.html';

  // 按优先级查找：精确路径匹配 → 路径结尾匹配 → 文件名匹配
  const entry = files.find(f =>
    f.path === entryPoint ||
    f.path.endsWith('/' + entryPoint) ||
    f.name === entryPoint
  );

  if (entry) return entry.content;

  // 找不到入口文件时，回退到第一个 HTML 文件
  const htmlFile = files.find(f => f.name.endsWith('.html'));
  return htmlFile?.content || null;
}

/**
 * 删除游戏文件存储
 */
export async function deleteGameFiles(gameId: string): Promise<void> {
  // 清理两种存储中的数据
  deleteLS(gameId);
  try {
    await deleteFromDB(gameId);
    console.log(`[PublishedGame] 游戏文件已删除: ${gameId}`);
  } catch (e) {
    console.error('[PublishedGame] 删除 IndexedDB 游戏文件失败:', e);
  }
}

/**
 * 启动游戏 - 初始化运行时并返回API
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

    // 动态导入PublishedGameRuntime
    const { createGameRuntime } = await import('@/publishing-center/runtime/PublishedGameRuntime');
    
    // 创建运行时
    const api = await createGameRuntime(gameId, {
      debug: true,
    });

    // 增加玩家计数
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
 * 获取游戏的Skill配置
 */
export function getGameSkillConfigs(gameId: string): Record<string, any> | null {
  const game = getPublishedGame(gameId);
  return game?.skillConfigs || null;
}

/**
 * 更新游戏的Skill配置
 */
export function updateGameSkillConfigs(
  gameId: string, 
  skillConfigs: Record<string, any>
): PublishedGame | null {
  const games = getPublishedGames();
  const gameIndex = games.findIndex(g => g.id === gameId);
  
  if (gameIndex < 0) {
    return null;
  }

  games[gameIndex] = {
    ...games[gameIndex],
    skillConfigs: {
      ...games[gameIndex].skillConfigs,
      ...skillConfigs,
    },
    updatedAt: new Date().toISOString(),
  };

  localStorage.setItem(STORAGE_KEY, JSON.stringify(games));
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
};
