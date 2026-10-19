/**
 * 道具凭证点赞/点倒赞 - 前端隧道封装
 *
 * 走 gamesApi 隧道 __vote（与 __item/__market 同模式）：
 *   GET  /api/v1/games/__vote?gameId=  — 拉取该游戏全部道具投票聚合 + 当前用户投票
 *   POST /api/v1/games/__vote          — 投票/切换/取消 { gameId, targetId, vote }
 *
 * 铁律：prod 下 getApiBase() 返回绝对云函数 URL（浏览器 auth 损坏，唯一写入通道 = 云函数）。
 * 身份从 Bearer token（dev-token）解析，不接受 body 传入，防刷：每用户每目标一票（确定性文档 ID 覆盖写）。
 */
import { getToken } from './authTokenService';
import { getApiBase } from './apiBase';

export type VoteValue = 'up' | 'down';

export interface VoteCounts {
  up: number;
  down: number;
}

/** 一次拉取的投票快照：counts 为聚合计数，mine 为当前用户的投票 */
export interface VoteSnapshot {
  counts: Record<string, VoteCounts>;
  mine: Record<string, VoteValue>;
}

function endpoint(): string {
  return `${getApiBase()}/__vote`;
}

async function requestVote<T>(search: string, init?: RequestInit): Promise<T | null> {
  try {
    const token = await getToken();
    const res = await fetch(`${endpoint()}${search}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    if (!res.ok) return null;
    const json = await res.json();
    return (json && json.data) || null;
  } catch {
    return null;
  }
}

/** 防御性归一化：确保 counts/mine 一定是普通对象（云函数旧桩曾返回异常形状） */
function normalizeSnapshot(data: any): VoteSnapshot | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const counts: Record<string, VoteCounts> = {};
  if (data.counts && typeof data.counts === 'object' && !Array.isArray(data.counts)) {
    for (const [k, v] of Object.entries(data.counts)) {
      counts[k] = {
        up: Number((v as any)?.up) || 0,
        down: Number((v as any)?.down) || 0,
      };
    }
  }
  const mine: Record<string, VoteValue> = {};
  if (data.mine && typeof data.mine === 'object' && !Array.isArray(data.mine)) {
    for (const [k, v] of Object.entries(data.mine)) {
      if (v === 'up' || v === 'down') mine[k] = v;
    }
  }
  return { counts, mine };
}

/** 拉取某游戏的投票快照（游客/失败返回 null，调用方保持原状） */
export async function fetchItemVotes(gameId: string): Promise<VoteSnapshot | null> {
  if (!gameId) return null;
  const data = await requestVote<any>(`?gameId=${encodeURIComponent(gameId)}`);
  return normalizeSnapshot(data);
}

/** 投票 / 切换 / 取消（vote='cancel' 删除自己的票），返回服务端最新快照 */
export async function sendItemVote(
  gameId: string,
  targetId: string,
  vote: VoteValue | 'cancel'
): Promise<VoteSnapshot | null> {
  if (!gameId || !targetId) return null;
  const data = await requestVote<any>('', {
    method: 'POST',
    body: JSON.stringify({ gameId, targetId, vote }),
  });
  return normalizeSnapshot(data);
}
