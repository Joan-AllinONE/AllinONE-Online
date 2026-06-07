/**
 * 游戏文件 IndexedDB 存储
 * 替代 localStorage 存储游戏 HTML/CSS/JS/二进制文件
 * IndexedDB 限额远超 localStorage（通常数百 MB）
 */

const DB_NAME = 'AllinONE_GameFiles';
const DB_VERSION = 1;
const STORE_NAME = 'game_files';

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * 异步保存游戏文件 JSON 到 IndexedDB
 */
export async function saveToDB(gameId: string, data: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(data, gameId);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

/**
 * 异步从 IndexedDB 加载游戏文件 JSON
 */
export async function loadFromDB(gameId: string): Promise<string | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const request = tx.objectStore(STORE_NAME).get(gameId);
    request.onsuccess = () => {
      db.close();
      resolve(request.result ?? null);
    };
    request.onerror = () => {
      db.close();
      reject(request.error);
    };
  });
}

/**
 * 异步从 IndexedDB 删除游戏文件
 */
export async function deleteFromDB(gameId: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(gameId);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

/**
 * 迁移指定游戏的数据从 localStorage 到 IndexedDB（兼容旧数据）
 */
export async function migrateGameFromLS(gameId: string): Promise<boolean> {
  try {
    const existing = localStorage.getItem(`allinone_game_files_${gameId}`);
    if (existing) {
      await saveToDB(gameId, existing);
      // 迁移成功后清理 localStorage 中的旧数据
      localStorage.removeItem(`allinone_game_files_${gameId}`);
      // 清理可能的旧分块
      const prefix = `allinone_game_files_${gameId}`;
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key?.startsWith(prefix)) {
          localStorage.removeItem(key);
        }
      }
      return true;
    }
    // 检查是否有分块存储的旧数据
    const metaKey = `allinone_game_files_${gameId}_meta`;
    const meta = localStorage.getItem(metaKey);
    if (meta) {
      try {
        const { total } = JSON.parse(meta);
        let result = '';
        for (let i = 0; i < total; i++) {
          const chunk = localStorage.getItem(`allinone_game_files_${gameId}_part_${i}`);
          if (chunk === null) return false;
          result += chunk;
        }
        await saveToDB(gameId, result);
        // 清理旧分块
        for (let i = 0; i < total; i++) {
          localStorage.removeItem(`allinone_game_files_${gameId}_part_${i}`);
        }
        localStorage.removeItem(metaKey);
        return true;
      } catch { return false; }
    }
    return false;
  } catch {
    return false;
  }
}

// ==================== localStorage 存储（渐进增强：优先 LS，降级到 IndexedDB） ====================

const LS_PREFIX = 'allinone_game_files_';
/** 安全的 localStorage 上限（留有余量，约 2MB JSON 数据） */
const SAFE_LS_LIMIT = 2 * 1024 * 1024;

function getLSKey(gameId: string): string {
  return `${LS_PREFIX}${gameId}`;
}

/**
 * 尝试用 localStorage 保存
 * 如果数据太大或配额不足，返回 false 让调用方降级到 IndexedDB
 */
export function trySaveLS(gameId: string, data: string): boolean {
  if (data.length > SAFE_LS_LIMIT) return false;
  try {
    localStorage.setItem(getLSKey(gameId), data);
    return true;
  } catch (e) {
    if (e instanceof DOMException && e.name === 'QuotaExceededError') {
      console.warn('[Storage] localStorage 配额不足，将降级到 IndexedDB');
    }
    return false;
  }
}

/**
 * 从 localStorage 读取（同步更快）
 */
export function tryLoadLS(gameId: string): string | null {
  return localStorage.getItem(getLSKey(gameId));
}

/**
 * 从 localStorage 删除并清理可能残留的分块数据
 */
export function deleteLS(gameId: string): void {
  const key = getLSKey(gameId);
  localStorage.removeItem(key);
  // 清理可能残留的分块旧数据
  for (let i = 0; i < 100; i++) {
    const partKey = `${key}_part_${i}`;
    if (!localStorage.getItem(partKey)) break;
    localStorage.removeItem(partKey);
  }
  localStorage.removeItem(`${key}_meta`);
}

// ==================== CloudBase 云存储导出（供 publishedGameService 使用） ====================

/**
 * 上传游戏文件到 CloudBase 云存储（异步，best-effort）
 */
export async function uploadToCloudStorage(
  gameId: string,
  files: Array<{ name: string; path: string; content: string }>
): Promise<void> {
  try {
    const { uploadGameFiles } = await import('./cloudbaseStorage');
    await uploadGameFiles(gameId, files);
  } catch {
    // CloudBase 不可用，静默失败
  }
}

/**
 * 从 CloudBase 云存储获取游戏的临时下载 URL
 */
export async function getCloudStorageUrl(gameId: string, filePath: string): Promise<string | null> {
  try {
    const { getGameFileTempUrl } = await import('./cloudbaseStorage');
    return await getGameFileTempUrl(gameId, filePath);
  } catch {
    return null;
  }
}

/**
 * 从 CloudBase 云存储删除游戏文件
 */
export async function deleteCloudStorage(gameId: string): Promise<void> {
  try {
    const { deleteCloudGameFiles } = await import('./cloudbaseStorage');
    await deleteCloudGameFiles(gameId);
  } catch {
    // 静默失败
  }
}
