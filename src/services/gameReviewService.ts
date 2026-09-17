/**
 * 游戏审核服务（前端 API 封装）
 *
 * 与后端 src/server/routes/gameReview.ts 配套（CHECKLIST_TEMPLATE 等常量双维护）。
 * 审核后台独立于玩家 CloudBase Auth：管理员通过 __review/admin-login 登录，
 * 会话保存在 sessionStorage（关闭浏览器即失效），不与 authTokenService 冲突。
 *
 * 审核状态机：
 *   (提交/重新提交) → pending → approved | rejected | changes_required
 *   approved → 管理员下架 → removed；removed → 管理员重新通过 → approved
 *   旧数据无 reviewStatus → 视为 approved（向后兼容）
 */

import { getApiBase } from './apiBase';
import { getToken } from './authTokenService';

// ==================== 类型定义 ====================

export type GameReviewStatus = 'pending' | 'approved' | 'rejected' | 'changes_required' | 'removed';

export type ReviewAction =
  | 'submit'
  | 'approve'
  | 'reject'
  | 'changes_required'
  | 'takedown';

export interface ReviewChecklistItem {
  key: string;
  label: string;
  description: string;
  passed: boolean;
  note?: string;
}

export interface AutoCheckItem {
  key: string;
  label: string;
  passed: boolean;
  severity: 'error' | 'warning' | 'info';
  note?: string;
}

/** 审核记录（完整保留，便于追溯：审核时间、审核管理员、审核结果及备注） */
export interface GameReviewRecord {
  id: string;
  action: ReviewAction;
  adminId?: string;
  adminName?: string;
  submitterId?: string;
  submitterName?: string;
  reason?: string;
  note?: string;
  checklist?: ReviewChecklistItem[];
  autoChecks?: AutoCheckItem[];
  createdAt: number;
}

export interface ReviewQueueItem {
  id: string;
  name: string;
  summary?: string;
  description?: string;
  coverImage?: string;
  framework?: string;
  hostingType?: string;
  entryPoint?: string;
  cdnUrl?: string;
  externalUrl?: string;
  publisherId?: string;
  publisherName?: string;
  fileCount?: number;
  size?: number;
  createdAt?: string;
  updatedAt?: string;
  reviewStatus: GameReviewStatus;
  submittedAt?: number;
  reviewedAt?: number;
  reviewedBy?: string;
  latestRecord?: GameReviewRecord;
  autoCheckWarningCount: number;
  recordCount: number;
}

export interface ReviewSession {
  token: string;
  adminId: string;
  adminName: string;
  expiresAt: number;
}

// ==================== 审核条件模板（与后端 CHECKLIST_TEMPLATE 双维护） ====================

/**
 * 人工审核四大硬性条件（游戏上架需全部满足）：
 * 1. 内容合规性 — 无违法、违规、侵权内容
 * 2. 运行稳定性 — 无严重崩溃、卡死等问题
 * 3. 基础信息完整性 — 名称、简介、封面、分类等必填项齐全
 * 4. 用户交互与安全性 — 无恶意代码、无诱导支付或隐私窃取行为
 */
export const REVIEW_CHECKLIST_TEMPLATE: Array<{ key: string; label: string; description: string }> = [
  {
    key: 'content_compliance',
    label: '内容合规性',
    description: '无违法、违规、侵权内容（无色情低俗、暴力血腥、赌博、政治敏感、盗版侵权素材等）',
  },
  {
    key: 'stability',
    label: '运行稳定性',
    description: '游戏可正常启动与运行，无严重崩溃、卡死、白屏等影响体验的问题',
  },
  {
    key: 'info_completeness',
    label: '基础信息完整性',
    description: '名称、简介、封面、分类等必填项齐全，入口文件配置正确',
  },
  {
    key: 'security',
    label: '用户交互与安全性',
    description: '无恶意代码、无诱导支付或变相收费、无隐私窃取行为',
  },
];

export const REVIEW_STATUS_META: Record<GameReviewStatus, { label: string; badge: string; dot: string }> = {
  pending: {
    label: '待审核',
    badge: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
    dot: 'bg-amber-400',
  },
  approved: {
    label: '已上架',
    badge: 'bg-green-500/15 text-green-400 border-green-500/30',
    dot: 'bg-green-400',
  },
  rejected: {
    label: '已驳回',
    badge: 'bg-red-500/15 text-red-400 border-red-500/30',
    dot: 'bg-red-400',
  },
  changes_required: {
    label: '需修改',
    badge: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
    dot: 'bg-blue-400',
  },
  removed: {
    label: '已下架',
    badge: 'bg-slate-500/15 text-slate-400 border-slate-500/30',
    dot: 'bg-slate-400',
  },
};

export const REVIEW_ACTION_META: Record<ReviewAction, { label: string; color: string }> = {
  submit: { label: '提交审核', color: 'text-amber-400' },
  approve: { label: '审核通过', color: 'text-green-400' },
  reject: { label: '驳回', color: 'text-red-400' },
  changes_required: { label: '要求修改', color: 'text-blue-400' },
  takedown: { label: '下架', color: 'text-slate-400' },
};

// ==================== 管理员会话管理（sessionStorage） ====================

const REVIEW_SESSION_KEY = 'allinone_review_admin_session';

/** 获取审核管理员会话（过期返回 null） */
export function getReviewSession(): ReviewSession | null {
  try {
    const raw = sessionStorage.getItem(REVIEW_SESSION_KEY);
    if (!raw) return null;
    const session: ReviewSession = JSON.parse(raw);
    if (!session.token || Date.now() >= session.expiresAt) {
      sessionStorage.removeItem(REVIEW_SESSION_KEY);
      return null;
    }
    return session;
  } catch {
    return null;
  }
}

/** 退出审核管理员登录 */
export function logoutReviewAdmin(): void {
  sessionStorage.removeItem(REVIEW_SESSION_KEY);
}

/**
 * 管理员登录审核后台
 * 独立于玩家账号体系（CloudBase Auth），使用后端 REVIEW_ADMIN_USER/REVIEW_ADMIN_PASS 账号
 */
export async function adminLogin(username: string, password: string): Promise<
  { success: true; session: ReviewSession } | { success: false; error: string }
> {
  try {
    const res = await fetch(`${getApiBase()}/__review/admin-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const json = await res.json();
    if (!res.ok || !json?.success) {
      return { success: false, error: json?.error || `登录失败（HTTP ${res.status}）` };
    }
    const session: ReviewSession = json.data;
    sessionStorage.setItem(REVIEW_SESSION_KEY, JSON.stringify(session));
    return { success: true, session };
  } catch (e) {
    return { success: false, error: `无法连接审核后端：${e instanceof Error ? e.message : String(e)}` };
  }
}

// ==================== API 调用 ====================

async function reviewFetch(
  path: string,
  init: RequestInit = {},
): Promise<{ ok: boolean; status: number; json: any }> {
  const session = getReviewSession();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init.headers as Record<string, string> || {}),
  };
  if (session) headers.Authorization = `Bearer ${session.token}`;
  const res = await fetch(`${getApiBase()}/__review${path}`, { ...init, headers });
  let json: any = null;
  try { json = await res.json(); } catch { /* 非 JSON 响应 */ }
  // 会话过期自动清除（下次进入需重新登录）
  if (res.status === 401 && session) logoutReviewAdmin();
  return { ok: res.ok && json?.success, status: res.status, json };
}

/** 管理员：拉取审核队列（status 省略 = 全部） */
export async function fetchReviewQueue(status?: GameReviewStatus): Promise<ReviewQueueItem[]> {
  const qs = status ? `?status=${encodeURIComponent(status)}` : '';
  const { ok, json } = await reviewFetch(`/list${qs}`);
  if (!ok) throw new Error(json?.error || '拉取审核队列失败');
  return (json?.data?.games || []) as ReviewQueueItem[];
}

/** 管理员：拉取某游戏的完整审核记录（时间倒序） */
export async function fetchReviewRecords(gameId: string): Promise<GameReviewRecord[]> {
  const { ok, json } = await reviewFetch(`/records/${encodeURIComponent(gameId)}`);
  if (!ok) throw new Error(json?.error || '拉取审核记录失败');
  return (json?.data?.records || []) as GameReviewRecord[];
}

/**
 * 审核状态变更后刷新前端游戏列表缓存：
 * 后端列表接口已过滤未过审游戏，主动刷新可让游戏中心即时隐藏/显示对应游戏，
 * 避免「发布后 pending 游戏仍短暂显示在游戏中心」的缓存残留问题。
 */
function refreshGamesCache(): void {
  import('./publishedGameService')
    .then(({ refreshGamesFromCloudBase }) => {
      refreshGamesFromCloudBase().catch(() => {});
    })
    .catch(() => {});
}

/**
 * 发布者/管理员：提交游戏进入待审核状态（发布流程自动调用）
 * 后端会同时执行自动预检（信息完整性/文件健康度/恶意代码特征扫描）
 *
 * ⚠️ 发布时序竞态兜底：发布链路中 cloudFileManifest 的小体积 PATCH（创建游戏文档）
 * 与本请求并发，若文档尚未创建，后端 submit 返回 404「游戏不存在」——自动延迟重试。
 */
export async function submitGameForReview(
  gameId: string,
  meta?: { gameName?: string; note?: string },
  attempt = 0,
): Promise<{ success: boolean; autoChecks?: AutoCheckItem[]; error?: string }> {
  try {
    // 发布者通道复用 authTokenService 的 dev-token JWT（后端校验发布者身份）
    const token = await getToken();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${getApiBase()}/__review/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ gameId, note: meta?.note }),
    });
    const json = await res.json().catch(() => null);
    if (res.status === 404 && attempt < 3) {
      // 游戏文档未就绪（并发创建中）→ 延迟重试
      await new Promise((r) => setTimeout(r, 1500));
      return submitGameForReview(gameId, meta, attempt + 1);
    }
    if (!res.ok || !json?.success) {
      return { success: false, error: json?.error || `提交审核失败（HTTP ${res.status}）` };
    }
    // 同步前端缓存：刚发布的 pending 游戏立即从游戏中心隐藏
    refreshGamesCache();
    return { success: true, autoChecks: json?.data?.autoChecks };
  } catch (e) {
    return { success: false, error: `无法连接审核后端：${e instanceof Error ? e.message : String(e)}` };
  }
}

/** 管理员：提交审核决定（approve / reject / changes_required） */
export async function submitReviewDecision(params: {
  gameId: string;
  result: 'approve' | 'reject' | 'changes_required';
  reason?: string;
  note?: string;
  checklist: ReviewChecklistItem[];
}): Promise<{ ok: boolean; error?: string }> {
  const { ok, status, json } = await reviewFetch('/decide', {
    method: 'POST',
    body: JSON.stringify(params),
  });
  if (ok) refreshGamesCache(); // 审核结果即时同步到游戏中心缓存
  return { ok, error: json?.error || (ok ? undefined : `审核提交失败（HTTP ${status}）`) };
}

/** 管理员：下架已上架游戏（必填原因，用于追溯） */
export async function takedownGame(params: {
  gameId: string;
  reason: string;
  note?: string;
}): Promise<{ ok: boolean; error?: string }> {
  const { ok, status, json } = await reviewFetch('/takedown', {
    method: 'POST',
    body: JSON.stringify(params),
  });
  if (ok) refreshGamesCache();
  return { ok, error: json?.error || (ok ? undefined : `下架失败（HTTP ${status}）`) };
}

/** 审核状态是否公开可见（approved 或旧数据缺省） */
export function isGamePubliclyVisible(reviewStatus?: string): boolean {
  return !reviewStatus || reviewStatus === 'approved';
}

// ==================== 审核预览（试玩验证运行稳定性） ====================

export interface GamePreview {
  mode: 'url' | 'html' | 'none';
  url?: string;
  html?: string;
  /** 无法内嵌预览时的说明 */
  note?: string;
}

/** 文件路由预览 URL（与 GamePlay 的 buildGameFileUrl 同构：公开可访问，iframe 免 token） */
function gameFilePreviewUrl(gameId: string, entryPoint: string): string {
  return `${getApiBase()}/${encodeURIComponent(gameId)}/files/${entryPoint || 'index.html'}`;
}

/**
 * 管理员：解析待审游戏的预览方式
 * - external：外部 URL（iframe 直连）
 * - server：游戏文件路由 URL（公开可访问，iframe 直连）
 * - inline：详情接口取 entryHtmlContent → srcDoc；取不到时（元数据瘦身剥离 >60KB / 写入失败）
 *   回退到文件路由 URL——文件已上传云存储（cloudFileManifest），云函数端 admin SDK 可跨浏览器取回
 */
export async function fetchGamePreview(game: ReviewQueueItem): Promise<GamePreview> {
  const hostingType = game.hostingType || 'inline';

  if (hostingType === 'external') {
    const url = game.externalUrl || game.cdnUrl;
    return url
      ? { mode: 'url', url }
      : { mode: 'none', note: '外部游戏未配置 URL，无法预览' };
  }

  if (hostingType === 'server') {
    return { mode: 'url', url: gameFilePreviewUrl(game.id, game.entryPoint || 'index.html') };
  }

  // inline / hostingType 未知：详情接口（pending/rejected 等非公开游戏要求 admin token）
  try {
    const session = getReviewSession();
    const headers: Record<string, string> = {};
    if (session) headers.Authorization = `Bearer ${session.token}`;
    const res = await fetch(`${getApiBase()}/${encodeURIComponent(game.id)}`, { headers });
    if (!res.ok) {
      // 残缺文档（详情 404）→ 直接尝试文件路由
      return { mode: 'url', url: gameFilePreviewUrl(game.id, game.entryPoint || 'index.html') };
    }
    const json = await res.json();
    const doc = json?.data || {};

    // ① 入口 HTML 内嵌预览（小体积自包含游戏，元数据里存了 entryHtmlContent）
    const html = doc.entryHtmlContent;
    if (html && typeof html === 'string') {
      return { mode: 'html', html };
    }

    // ② entryHtmlContent 缺失（>60KB 被元数据瘦身剥离，或写入失败）→
    //    从 cloudFileManifest 定位入口 HTML 回退文件路由（云存储链路跨浏览器可用）
    const manifest: Array<{ fileName?: string; path?: string; cloudPath?: string }> = Array.isArray(doc.cloudFileManifest)
      ? doc.cloudFileManifest
      : [];
    const entryFromDoc = doc.entryPoint || game.entryPoint;
    const htmlInManifest =
      manifest.find((m) => (m.fileName || m.path || m.cloudPath || '') === (entryFromDoc || '')) ||
      manifest.find((m) => /\.html?$/i.test(m.fileName || m.path || m.cloudPath || ''));
    const entryName =
      entryFromDoc ||
      (htmlInManifest && (htmlInManifest.fileName || htmlInManifest.path || htmlInManifest.cloudPath)) ||
      'index.html';

    if (manifest.length > 0 || hostingType === 'server') {
      return {
        mode: 'url',
        url: gameFilePreviewUrl(game.id, entryName),
        note: '入口 HTML 未随元数据存储，已通过云存储文件链路预览',
      };
    }

    return { mode: 'none', note: '该游戏未存储入口 HTML 内容且无文件清单（cloudFileManifest），无法预览' };
  } catch (e) {
    return { mode: 'none', note: `入口内容获取异常：${e instanceof Error ? e.message : String(e)}` };
  }
}

/** 在新窗口打开预览（inline 模式用 blob URL） */
export function openPreviewInNewTab(preview: GamePreview, gameName: string): void {
  if (preview.mode === 'url' && preview.url) {
    window.open(preview.url, '_blank', 'noopener');
    return;
  }
  if (preview.mode === 'html' && preview.html) {
    const blob = new Blob([preview.html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank', 'noopener');
    // 60s 后释放（给页面加载留足时间）
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return;
  }
  console.warn(`[gameReview] 无法在新窗口打开预览: ${gameName}`);
}
