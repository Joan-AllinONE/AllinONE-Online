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

import type { GameContentPack, GameContentSop } from '@/types/quest';
import { applyGamePatchToCache, patchGameOnBackend } from './publishedGameService';

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

// ==================== 内容创作 SOP（跨浏览器同步，参考道具工坊 SOP proven pattern） ====================
// 铁律：浏览器端 CloudBase DB 写入通道已损坏（auth.call is not a function → writeQueue 永不落库），
// 唯一跨浏览器可靠写入通道 = gamesApi 云函数。因此：
// - 保存：patchGameOnBackend（PATCH /api/v1/games/:id，admin SDK 字段级合并 upsert），
//   只 patch contentSop 字段 —— 不触碰封面/简介/entryHtmlContent/审核字段，无全量覆盖风险；
// - 加载：游戏列表/详情接口（GET /api/v1/games）原样返回 contentSop 字段，云端即权威源，
//   前端缓存缺 SOP 时用 refreshGameDetail 补拉一次即可。

/**
 * 保存内容创作 SOP（跨浏览器同步）。
 * 成功后同步合并进前端缓存（内存 + 持久缓存），本会话即时生效；
 * 返回是否成功落库（失败时调用方应提示「仅本次会话生效」）。
 */
export async function saveContentSop(gameId: string, sop: GameContentSop): Promise<boolean> {
  try {
    const payload: GameContentSop = { ...sop, updatedAt: Date.now() };
    const ok = await patchGameOnBackend(gameId, { contentSop: payload });
    if (ok) {
      // 缓存同步：getPublishedGame / getPublishedGames 立即可读新 SOP
      applyGamePatchToCache(gameId, { contentSop: payload });
    }
    return ok;
  } catch (e) {
    console.warn('[ContentService] saveContentSop 失败:', e);
    return false;
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
