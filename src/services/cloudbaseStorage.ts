/**
 * CloudBase Cloud Storage 模块
 * 游戏文件存储：上传/下载/删除 URL，用于替代 localStorage + IndexedDB
 */
import { getCloudBaseApp, isCloudBaseReady } from './cloudbase';

const GAME_FILES_PATH = 'games';

/**
 * 上传游戏文件到云存储
 */
export async function uploadGameFiles(
  gameId: string,
  files: Array<{ name: string; content: string; path: string }>
): Promise<{ success: boolean; uploaded: number; errors: string[] }> {
  if (!isCloudBaseReady()) {
    return { success: false, uploaded: 0, errors: ['CloudBase not ready'] };
  }
  const app = getCloudBaseApp() as any;
  let uploaded = 0;
  const errors: string[] = [];

  for (const file of files) {
    try {
      const cloudPath = `${GAME_FILES_PATH}/${gameId}/${file.path || file.name}`;
      const blob = new Blob([file.content], { type: 'application/octet-stream' });
      await app.uploadFile({ cloudPath, fileContent: blob });
      uploaded++;
    } catch (e: any) {
      errors.push(`${file.name}: ${e.message || e}`);
    }
  }
  return { success: errors.length === 0, uploaded, errors };
}

/**
 * 获取游戏文件临时下载 URL
 */
export async function getGameFileTempUrl(gameId: string, filePath: string): Promise<string | null> {
  if (!isCloudBaseReady()) return null;
  try {
    const app = getCloudBaseApp();
    const cloudPath = `${GAME_FILES_PATH}/${gameId}/${filePath}`;
    const result = await app.getTempFileURL({ fileList: [cloudPath] });
    if (result.fileList && result.fileList.length > 0 && result.fileList[0].tempFileURL) {
      return result.fileList[0].tempFileURL;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 删除游戏的所有文件
 */
export async function deleteCloudGameFiles(gameId: string): Promise<boolean> {
  if (!isCloudBaseReady()) return false;
  try {
    const app = getCloudBaseApp() as any;
    await app.deleteFile({ fileList: [`${GAME_FILES_PATH}/${gameId}/`] });
    return true;
  } catch {
    return false;
  }
}

/**
 * 检查 CloudBase 云存储是否可用
 */
export function isCloudStorageReady(): boolean {
  return isCloudBaseReady();
}
