/**
 * 本地预览服务（纯本地，零污染）
 *
 * 设计原则（经用户确认）：
 *   - 纯游戏跑通即可，不注入平台协议层 / SDK（避免平台连接错误，零平台依赖）
 *   - 不写后端 / 云存储 / published_games 集合，所有文件仅写入浏览器 IndexedDB
 *
 * 渲染通道：复用「Service Worker 拦截 /api/v1/games/* 从 IndexedDB 回放」的 proven offline 路径，
 * 用真实 URL 加载游戏（模块化多文件游戏用 srcDoc 会白屏，必须用真实 URL）。
 */

import type { UploadedFile, ProtocolMode } from '../types';
import { saveToDB, deleteFromDB } from '@/services/gameFileDb';

/** 本地预览固定草稿键（覆盖式写入，避免堆积） */
export const LOCAL_PREVIEW_ID = 'local-preview-draft';

/** 本地预览结果（供 UI 打开 iframe 使用） */
export interface LocalPreviewResult {
  gameId: string;
  entryPoint: string;
  launchUrl: string;
}

export interface BuildLocalPreviewOptions {
  files: UploadedFile[];
  /** 建议入口（源自分析器，可能首项为 JS）；本服务会优先回退到 HTML */
  entryPoint?: string;
  /** 保留字段（兼容调用方），本地预览不注入协议层 */
  protocolMode?: ProtocolMode;
}

/** Uint8Array -> base64（浏览器标准实现） */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)) as any);
  }
  return btoa(binary);
}

/** 将 UploadedFile.content（解压后为 Uint8Array / 注入后可能为 string）转为可存储字符串 */
function contentToStored(content: ArrayBuffer | string | Uint8Array): string {
  if (typeof content === 'string') return content;
  const bytes = content instanceof Uint8Array ? content : new Uint8Array(content as ArrayBuffer);
  return '__BINARY_BASE64__' + bytesToBase64(bytes);
}

/** 去除路径前导斜杠，使其匹配 Service Worker 的 filePath（不含前导 /） */
function stripLeadingSlash(p: string): string {
  return p.replace(/^\/+/, '');
}

/**
 * 等待 Service Worker 激活并接管页面。
 * 首屏 SW 在 window load 后才注册；若未接管，本地预览请求会被 dev 代理 / 后端吞掉导致 404。
 * 返回 true 表示已有 controller（SW 就绪，能拦截 /api/v1/games/*）。
 */
export function waitForServiceWorkerController(timeoutMs = 3000): Promise<boolean> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return Promise.resolve(false);
  }
  if (navigator.serviceWorker.controller) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    navigator.serviceWorker.addEventListener(
      'controllerchange',
      () => {
        clearTimeout(timer);
        resolve(true);
      },
      { once: true }
    );
  });
}

/**
 * 生成本地预览草稿（纯游戏，不注入协议层）：
 * 1. 选择 HTML 入口（浏览器需 HTML 加载；无 HTML 时回退到传入入口 / 首个文件）
 * 2. 路径归一化（去前导斜杠，保持内部相对引用结构不变）
 * 3. 仅写入 IndexedDB（saveToDB），跳过后端 / 云——零污染
 * 4. 返回 iframe 可直接加载的 launchUrl（由 Service Worker 从 IndexedDB 回放）
 */
export async function buildLocalPreview(
  options: BuildLocalPreviewOptions
): Promise<LocalPreviewResult> {
  const { files } = options;
  if (!files || files.length === 0) {
    throw new Error('没有可预览的游戏文件，请先上传游戏包');
  }

  // 入口选择：优先 HTML（浏览器渲染需要 HTML 入口；分析器入口可能首项是 JS）
  const htmlFile =
    files.find(f => f.name === 'index.html') ||
    files.find(f => f.path.endsWith('.html'));

  let entryPoint: string;
  if (htmlFile) {
    entryPoint = htmlFile.path;
  } else if (options.entryPoint && files.some(f => f.path === options.entryPoint)) {
    entryPoint = options.entryPoint;
  } else {
    entryPoint = files[0].path;
  }
  entryPoint = stripLeadingSlash(entryPoint);

  // 构造 StoredGameFile[]（与 SW serveFromIndexedDB 期望格式一致）
  const storable = files.map(f => ({
    path: stripLeadingSlash(f.path),
    name: f.name,
    content: contentToStored(f.content),
    size:
      f.size ||
      (typeof f.content === 'string'
        ? f.content.length
        : (f.content as ArrayBuffer).byteLength || 0),
  }));

  // 仅写入 IndexedDB（覆盖式），不触碰后端 / 云
  await saveToDB(LOCAL_PREVIEW_ID, JSON.stringify(storable));

  console.log(
    `[LocalPreview] 草稿已写入 IndexedDB: ${LOCAL_PREVIEW_ID}, ${storable.length} 个文件, 入口=${entryPoint}`
  );

  return {
    gameId: LOCAL_PREVIEW_ID,
    entryPoint,
    launchUrl: `/api/v1/games/${LOCAL_PREVIEW_ID}/files/${entryPoint}`,
  };
}

/** 清理本地预览草稿（发布成功后调用，或手动关闭时可选） */
export async function clearLocalPreview(): Promise<void> {
  try {
    await deleteFromDB(LOCAL_PREVIEW_ID);
    console.log('[LocalPreview] 草稿已清理:', LOCAL_PREVIEW_ID);
  } catch (e) {
    console.warn('[LocalPreview] 清理草稿失败（可忽略）:', e);
  }
}
