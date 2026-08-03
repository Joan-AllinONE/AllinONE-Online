/**
 * CloudBase Cloud Storage 模块
 * 游戏文件存储：上传/下载/删除 URL，用于替代 localStorage + IndexedDB
 */
import { getCloudBaseApp, isCloudBaseReady } from './cloudbase';

const GAME_FILES_PATH = 'games';

/**
 * 根据文件扩展名推断 MIME Content-Type
 */
function inferContentType(filename: string): string {
  const ext = filename.toLowerCase().split('.').pop() || '';
  const MIME_MAP: Record<string, string> = {
    html: 'text/html',
    htm: 'text/html',
    css: 'text/css',
    js: 'application/javascript',
    json: 'application/json',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    svg: 'image/svg+xml',
    webp: 'image/webp',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    mp4: 'video/mp4',
    webm: 'video/webm',
    wasm: 'application/wasm',
    txt: 'text/plain',
    xml: 'application/xml',
  };
  return MIME_MAP[ext] || 'application/octet-stream';
}

export interface UploadResult {
  success: boolean;
  uploaded: number;
  errors: string[];
  /** 云存储文件清单：{ fileName, cloudFileID }，用于后续跨浏览器下载 */
  fileManifest: Array<{ fileName: string; cloudFileID: string }>;
}

/**
 * 上传游戏文件到云存储
 * 使用 File 对象（而非裸 Blob）确保 SDK 正确传输文件内容和大小
 */
export async function uploadGameFiles(
  gameId: string,
  files: Array<{ name: string; content: string | Uint8Array; path: string }>
): Promise<UploadResult> {
  if (!isCloudBaseReady()) {
    return { success: false, uploaded: 0, errors: ['CloudBase not ready'], fileManifest: [] };
  }
  const app = getCloudBaseApp() as any;
  let uploaded = 0;
  const errors: string[] = [];
  const fileManifest: Array<{ fileName: string; cloudFileID: string }> = [];

  for (const file of files) {
    try {
      const fileName = file.path || file.name;
      const cloudPath = `${GAME_FILES_PATH}/${gameId}/${fileName}`;
      const contentType = inferContentType(fileName);

      // 使用 File 对象而非 Blob — File 有 name 属性，CloudBase SDK 能正确获取文件大小和内容
      // 支持 string（文本）和 Uint8Array（二进制）两种内容格式
      const fileObj = file.content instanceof Uint8Array
        ? new File([file.content.buffer as ArrayBuffer], fileName, { type: contentType })
        : new File([file.content], fileName, { type: contentType });

      // 上传前验证内容非空
      if (fileObj.size === 0) {
        console.warn(`[CloudStorage] 跳过空文件: ${fileName} (原始内容长度: ${file.content.length})`);
        errors.push(`${file.name}: 文件内容为空`);
        continue;
      }

      console.log(`[CloudStorage] 上传: ${cloudPath}, size=${fileObj.size}B, type=${contentType}`);

      const result = await app.uploadFile({
        cloudPath,
        filePath: fileObj,   // Web SDK v2 推荐用 filePath 传 File 对象
        fileContent: fileObj, // 兼容: 部分 SDK 版本用 fileContent
      });

      // 验证上传结果
      if (result?.fileID) {
        console.log(`[CloudStorage] 上传成功: ${cloudPath} → fileID=${result.fileID}`);
        fileManifest.push({ fileName, cloudFileID: result.fileID });
      } else {
        console.warn(`[CloudStorage] 上传返回异常: ${JSON.stringify(result)}`);
      }

      uploaded++;
    } catch (e: any) {
      console.error(`[CloudStorage] 上传失败: ${file.name}`, e);
      errors.push(`${file.name}: ${e.message || e}`);
    }
  }
  return { success: errors.length === 0, uploaded, errors, fileManifest };
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
