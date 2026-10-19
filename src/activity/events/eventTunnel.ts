/**
 * 限时活动前端隧道客户端（E3）
 *
 * 走 /api/v1/games/__event 隧道（本地 vite 代理 / prod 云函数均可达）。
 * 认权请求统一走 backendSync.authHeaders（内部 await getToken，天然规避早调用 401 坑）。
 */
import { API_BASE, authHeaders } from '../../services/backendSync';

const BASE = `${API_BASE}/v1/games/__event`;

export interface CurrentEventSummary {
  id: string;
  slug: string;
  name: string;
  type: 'collect' | 'staged' | 'game';
  status: 'scheduled' | 'live' | 'closing';
  startTime: number;
  endTime: number;
  graceHours: number;
  serverNow: number;
  description: string;
  metric: string;
}

export interface EventModuleProps {
  event: CurrentEventSummary;
}

async function json(res: Response): Promise<any> {
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error((data && data.error) || `HTTP ${res.status}`);
    (err as any).payload = data?.data;
    throw err;
  }
  return data;
}

/** 活跃/预热/补领期活动摘要（公开；前端动态导入信号源） */
export async function fetchCurrentEvents(): Promise<{ serverNow: number; events: CurrentEventSummary[] }> {
  const res = await fetch(`${BASE}/current`);
  const data = await json(res);
  const events = Array.isArray(data?.data?.events) ? data.data.events : [];
  return { serverNow: Number(data?.data?.serverNow) || Date.now(), events };
}

export async function fetchEventDetail(id: string): Promise<any> {
  const res = await fetch(`${BASE}/${encodeURIComponent(id)}/detail`);
  const data = await json(res);
  return data?.data || {};
}

export async function fetchEventLeaderboard(id: string): Promise<Array<{ userId: string; value: number }>> {
  const res = await fetch(`${BASE}/${encodeURIComponent(id)}/leaderboard`);
  const data = await json(res);
  return Array.isArray(data?.data?.leaderboard) ? data.data.leaderboard : [];
}

export async function joinEvent(eventId: string): Promise<any> {
  const res = await fetch(`${BASE}/${encodeURIComponent(eventId)}/join`, {
    method: 'POST',
    headers: await authHeaders(true),
  });
  return json(res);
}

/** 提交成绩/资源（三重校验+限流在后端） */
export async function submitEvent(eventId: string, metric: string, value: number): Promise<any> {
  const res = await fetch(`${BASE}/${encodeURIComponent(eventId)}/submit`, {
    method: 'POST',
    headers: await authHeaders(true),
    body: JSON.stringify({ metric, value }),
  });
  return json(res);
}

export interface EventProgress {
  serverNow: number;
  participation: {
    metrics: Record<string, number>;
    stageContrib: Record<string, number>;
    submissions: number;
  } | null;
  claimables: Array<{
    rewardId: string;
    kind: string;
    label: string;
    progress: { current: number; target: number | null };
    reward: { currency: string; amount: number };
    claimable: boolean;
    claimed: boolean;
  }>;
  stageProgress: Array<{ stageId: string; current: number; completedAt?: number | null; timedOut?: boolean }>;
  totalGranted: number;
}

export async function fetchEventProgress(eventId: string): Promise<EventProgress | null> {
  try {
    const res = await fetch(`${BASE}/${encodeURIComponent(eventId)}/progress`, {
      headers: await authHeaders(false),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.data || null;
  } catch {
    return null;
  }
}

export async function claimEventReward(eventId: string, rewardId: string): Promise<any> {
  const res = await fetch(`${BASE}/${encodeURIComponent(eventId)}/claim`, {
    method: 'POST',
    headers: await authHeaders(true),
    body: JSON.stringify({ rewardId }),
  });
  return json(res);
}
