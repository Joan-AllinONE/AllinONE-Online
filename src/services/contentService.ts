/**
 * 内容工坊服务（Content Workshop Service）
 *
 * 打通「内容创作 → 内容凭证」链路：
 * - mintContentVoucher：内容包资产落库（__content/mint，本地 server + 云函数双实现）
 * - 凭证铸造走 voucherItemService.mintContentVouchers（同道具凭证经济）
 * - remix 上架走审核（pending → approved 追加 questExtensions，GamePlay ?ext= 切换）
 *
 * 与任务广场 merge 的区别：内容凭证是个人级按次消费（会话级），不写平台 injections。
 */

import type { GameContentPack } from '@/types/quest';

const CONTENT_API_BASE =
  typeof window !== 'undefined' && /tcloudbaseapp\.com$/.test(window.location.hostname)
    ? 'https://allinonegaming-d4gmsmrzz573264f6.service.tcloudbase.com/api/v1/games/__content'
    : '/api/v1/games/__content';

export interface MintContentResult {
  success: boolean;
  contentId?: string;
  gameId?: string;
  manifest?: GameContentPack;
  assetBase?: string;
  type?: string;
  slot?: string;
  name?: string;
  message?: string;
}

export interface ContentAssetRecordView {
  contentId: string;
  gameId: string;
  authorId: string;
  authorName?: string;
  type: string;
  slot: string;
  name: string;
  description?: string;
  manifest: GameContentPack;
  assetBase: string;
  remix?: {
    status: 'pending' | 'approved' | 'rejected';
    entryPoint?: string;
    slot?: string;
    requestedAt?: number;
    reviewedAt?: number;
    reviewerId?: string;
  };
  createdAt: number;
}

/**
 * 铸造内容资产：内容包资产落库到游戏文件库 content/{contentId}/{path}，
 * 元信息写入 content_assets 集合。返回 manifest（凭证 metadata 用）。
 */
export async function mintContentVoucher(params: {
  gameId: string;
  contentPack: GameContentPack;
  authorId?: string;
  authorName?: string;
}): Promise<MintContentResult> {
  try {
    const res = await fetch(`${CONTENT_API_BASE}/mint`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    const json = await res.json().catch(() => null);
    if (!json || !json.success || !json.data) {
      return { success: false, message: json?.error || `HTTP ${res.status}` };
    }
    const d = json.data;
    return {
      success: true,
      contentId: d.contentId,
      gameId: d.gameId,
      manifest: d.manifest,
      assetBase: d.assetBase,
      type: d.type,
      slot: d.slot,
      name: d.name,
    };
  } catch (e) {
    return { success: false, message: e instanceof Error ? e.message : '铸造失败' };
  }
}

/** 拉取内容资产详情（loader 按需拉取 manifest） */
export async function getContentAsset(contentId: string): Promise<ContentAssetRecordView | null> {
  try {
    const res = await fetch(`${CONTENT_API_BASE}/${encodeURIComponent(contentId)}`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) return null;
    const json = await res.json().catch(() => null);
    return json?.success && json.data ? (json.data as ContentAssetRecordView) : null;
  } catch {
    return null;
  }
}

/** 列出某游戏的内容资产 */
export async function listContentAssets(gameId: string): Promise<ContentAssetRecordView[]> {
  try {
    const res = await fetch(`${CONTENT_API_BASE}?gameId=${encodeURIComponent(gameId)}`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) return [];
    const json = await res.json().catch(() => null);
    return json?.success && Array.isArray(json?.data?.contents) ? json.data.contents : [];
  } catch {
    return [];
  }
}

/**
 * 用 CloudBase AI（deepseek-v4-flash）生成内容包 JSON（复用 ugcBridgeService 的 AI 接入模式）。
 * 未登录/未就绪时返回 null，调用方回退到「复制提示词 → 外部 AI → 粘贴 JSON」。
 */
export async function generateContentWithAI(prompt: string): Promise<string | null> {
  try {
    const { isCloudBaseReady, getCloudBaseApp } = await import('./cloudbase');
    if (!isCloudBaseReady()) return null;
    const ai = getCloudBaseApp().ai();
    const model = ai.createModel('cloudbase');
    const result = await model.generateText({
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: prompt }],
    });
    const text = typeof result?.text === 'string' ? result.text : String(result || '');
    return text || null;
  } catch (e) {
    console.warn('[ContentService] AI 生成失败:', e);
    return null;
  }
}

/** 上架 remix 版（走审核，pending） */
export async function requestRemix(contentId: string, opts?: { entryPoint?: string; slot?: string }): Promise<{ success: boolean; message?: string }> {
  try {
    const res = await fetch(`${CONTENT_API_BASE}/${encodeURIComponent(contentId)}/remix`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entryPoint: opts?.entryPoint || '', slot: opts?.slot || '' }),
    });
    const json = await res.json().catch(() => null);
    return json?.success
      ? { success: true }
      : { success: false, message: json?.error || `HTTP ${res.status}` };
  } catch (e) {
    return { success: false, message: e instanceof Error ? e.message : '上架失败' };
  }
}

/** 审核 remix（approved → 追加 questExtensions） */
export async function reviewRemix(
  contentId: string,
  status: 'approved' | 'rejected',
  reviewerId?: string,
): Promise<{ success: boolean; message?: string }> {
  try {
    const res = await fetch(`${CONTENT_API_BASE}/${encodeURIComponent(contentId)}/remix-status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, reviewerId }),
    });
    const json = await res.json().catch(() => null);
    return json?.success
      ? { success: true }
      : { success: false, message: json?.error || `HTTP ${res.status}` };
  } catch (e) {
    return { success: false, message: e instanceof Error ? e.message : '审核失败' };
  }
}
