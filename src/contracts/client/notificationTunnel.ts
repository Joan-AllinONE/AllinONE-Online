/**
 * 通知隧道客户端（2026-10-11）
 *
 * 平台级站内信（首期仅私域合约邀请）：
 * - GET  /api/v1/games/__notifications/list  本人通知倒序 + unreadCount
 * - POST /api/v1/games/__notifications/read  标记已读（ids 缺省 = 全部）
 * - authHeaders 内部 await getToken —— 天然规避「早调用 401」冷启动坑
 */
import { API_BASE, authHeaders } from '@/services/backendSync';

const NOTIF_BASE = `${API_BASE}/v1/games/__notifications`;

export interface NotificationItem {
  id: string;
  toUserId: string;
  type: string;
  title: string;
  body: string;
  link?: string;
  read: boolean;
  createdAt: number;
  meta?: { contractId: string; templateKey: string; initiatorId: string };
}

async function request<T>(path: string, method: 'GET' | 'POST', body?: unknown): Promise<{ ok: boolean; data?: T; error?: string }> {
  try {
    const res = await fetch(`${NOTIF_BASE}${path}`, {
      method,
      headers: await authHeaders(true),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json: any = null;
    try {
      json = await res.json();
    } catch { /* 非 JSON */ }
    if (!res.ok) {
      return { ok: false, error: json?.error || `HTTP ${res.status}` };
    }
    return { ok: !!json?.success, data: json?.data as T, error: json?.error };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) };
  }
}

export function fetchNotifications(limit = 50): Promise<{ ok: boolean; data?: { notifications: NotificationItem[]; unreadCount: number }; error?: string }> {
  return request(`/list?limit=${limit}`, 'GET');
}

export function markNotificationsRead(ids?: string[]): Promise<{ ok: boolean; data?: { updated: number }; error?: string }> {
  return request('/read', 'POST', { ids: ids && ids.length > 0 ? ids : undefined });
}
