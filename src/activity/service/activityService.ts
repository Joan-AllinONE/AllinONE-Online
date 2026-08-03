import { ActivityDef, ProgressRecord, ClaimEvent, LeaderboardEntry } from '../types';
import { ACTIVITY_API_BASE, ACTIVITY_CACHE_KEY, progressKey } from '../config';
import { defaultActivities } from '../seed/defaultActivities';

/** 获取后端 JWT（复用 games 的 dev-token 端点，仅用于签名以调用认证 API） */
async function getBackendToken(userId: string): Promise<string | null> {
  try {
    const res = await fetch(`/api/v1/games/dev-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId }),
    });
    const json = await res.json();
    if (json?.success && json?.data?.token) return json.data.token;
  } catch {
    /* dev-token 不可用 → 排行榜 best-effort 跳过 */
  }
  return null;
}

/** 拉取活动列表（后端优先，失败回退缓存/种子） */
export async function fetchActivities(): Promise<ActivityDef[]> {
  try {
    const res = await fetch(`${ACTIVITY_API_BASE}/`);
    if (res.ok) {
      const data = await res.json();
      // 后端可能返回 { success, activities } 或裸数组；
      // 线上 SW 对未实现的端点返回 { success:true, data:null }（非数组），
      // 必须防御性过滤，否则下游 activities.filter 会抛 "n.filter is not a function"。
      const raw = Array.isArray(data?.activities)
        ? data.activities
        : Array.isArray(data)
          ? data
          : [];
      if (raw.length > 0) {
        try {
          localStorage.setItem(ACTIVITY_CACHE_KEY, JSON.stringify(raw));
        } catch {
          /* ignore */
        }
        return raw as ActivityDef[];
      }
    }
  } catch {
    /* ignore network */
  }
  const cached = typeof localStorage !== 'undefined' ? localStorage.getItem(ACTIVITY_CACHE_KEY) : null;
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed as ActivityDef[];
    } catch {
      /* ignore */
    }
  }
  return defaultActivities;
}

/** 读取玩家本地进度 */
export function loadProgress(userId: string): ProgressRecord[] {
  try {
    const raw = localStorage.getItem(progressKey(userId));
    return raw ? (JSON.parse(raw) as ProgressRecord[]) : [];
  } catch {
    return [];
  }
}

/** 保存玩家本地进度 */
export function saveProgress(userId: string, records: ProgressRecord[]): void {
  try {
    localStorage.setItem(progressKey(userId), JSON.stringify(records));
  } catch {
    /* ignore */
  }
}

/** 上报领奖事件（用于排行榜，best-effort） */
export async function recordClaim(event: ClaimEvent): Promise<void> {
  try {
    const token = await getBackendToken(event.userId);
    await fetch(`${ACTIVITY_API_BASE}/${event.activityId}/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        userId: event.userId,
        nickname: event.userName,
        amount: event.amount,
        at: event.at,
      }),
    });
  } catch {
    /* best effort */
  }
}

/** 拉取排行榜 */
export async function fetchLeaderboard(): Promise<LeaderboardEntry[]> {
  try {
    const res = await fetch(`${ACTIVITY_API_BASE}/leaderboard`);
    if (res.ok) {
      const data = await res.json();
      return data.leaderboard || [];
    }
  } catch {
    /* ignore */
  }
  return [];
}
