/**
 * QuestService - 任务发布系统平台级服务
 *
 * 走游戏内服务隧道 /api/v1/games/__quests（prod）或 /api/quests（dev）。
 * 与 gameDeveloperService 同构：封装后端调用 + 身份从 token 解析。
 */

import { getApiBase } from './apiBase';
import { getToken, getCurrentUserId } from './authTokenService';
import type { GameQuest, QuestSubmission, ContentPack, QuestMod } from '@/types/quest';

// 任务系统走云函数 __quests 隧道（dev/prod 同路径）。不能用 getFeatureApiBase('quests')：
// 它 dev 返回 /api/quests，而 server.js 无此路由 → 404，导致「发布失败」。
const API_BASE = `${getApiBase()}/__quests`;

async function apiFetch(path: string, options: RequestInit = {}): Promise<any> {
  const token = await getToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((options.headers as Record<string, string>) || {}),
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const resp = await fetch(`${API_BASE}${path}`, { ...options, headers });
  const json = await resp.json();
  if (!resp.ok) throw new Error(json.error || `HTTP ${resp.status}`);
  return json.data;
}

class QuestService {
  /** 任务列表（可跨游戏 + 按状态筛选） */
  async listQuests(gameId?: string, status?: string): Promise<GameQuest[]> {
    try {
      const params = new URLSearchParams();
      if (gameId) params.set('gameId', gameId);
      if (status) params.set('status', status);
      const qs = params.toString();
      return ((await apiFetch(`?${qs}`)) as GameQuest[]) || [];
    } catch (e) {
      console.warn('[Quest] 加载任务列表失败:', e);
      return [];
    }
  }

  /** 任务详情 */
  async getQuest(id: string): Promise<GameQuest | null> {
    try {
      return (await apiFetch(`/${id}`)) as GameQuest | null;
    } catch (e) {
      console.warn('[Quest] 加载任务详情失败:', e);
      return null;
    }
  }

  /** 开发者创建任务 */
  async createQuest(quest: GameQuest): Promise<GameQuest | null> {
    try {
      return (await apiFetch('', { method: 'POST', body: JSON.stringify(quest) })) as GameQuest;
    } catch (e) {
      console.warn('[Quest] 创建任务失败:', e);
      return null;
    }
  }

  /** 领取任务 */
  async claimQuest(id: string): Promise<{ success: boolean; message: string }> {
    try {
      const token = await getToken();
      const res = await fetch(`${API_BASE}/${id}/claim`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({}),
      });
      const json = await res.json();
      return { success: !!json.success, message: json.error || (json.success ? '领取成功' : '领取失败') };
    } catch (e) {
      return { success: false, message: e instanceof Error ? e.message : '领取失败' };
    }
  }

  /** 提交内容包 */
  async submitQuest(
    id: string,
    contentPack: ContentPack,
    description: string,
  ): Promise<{ success: boolean; message: string; data?: any }> {
    try {
      const token = await getToken();
      const res = await fetch(`${API_BASE}/${id}/submit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ contentPack, description, submitterName: getCurrentUserId() }),
      });
      const json = await res.json();
      return {
        success: !!json.success,
        message: json.error || (json.success ? '提交成功' : '提交失败'),
        data: json.data,
      };
    } catch (e) {
      return { success: false, message: e instanceof Error ? e.message : '提交失败' };
    }
  }

  /** 提交列表（开发者视角） */
  async listSubmissions(taskId: string): Promise<QuestSubmission[]> {
    try {
      return (await apiFetch(`/${taskId}/submissions`)) as QuestSubmission[];
    } catch (e) {
      console.warn('[Quest] 加载提交列表失败:', e);
      return [];
    }
  }

  /** 审核提交 */
  async reviewSubmission(
    taskId: string,
    submissionId: string,
    verdict: 'approve' | 'reject',
    comment: string,
  ): Promise<{ success: boolean; message: string }> {
    try {
      const token = await getToken();
      const res = await fetch(`${API_BASE}/${taskId}/review`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ submissionId, verdict, comment }),
      });
      const json = await res.json();
      return { success: !!json.success, message: json.error || '操作成功' };
    } catch (e) {
      return { success: false, message: e instanceof Error ? e.message : '操作失败' };
    }
  }

  /** 合并 + 发报酬 */
  async mergeQuest(
    taskId: string,
    submissionId?: string,
  ): Promise<{ success: boolean; message: string; data?: any }> {
    try {
      const token = await getToken();
      const res = await fetch(`${API_BASE}/${taskId}/merge`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ submissionId }),
      });
      const json = await res.json();
      return { success: !!json.success, message: json.error || '合并成功', data: json.data };
    } catch (e) {
      return { success: false, message: e instanceof Error ? e.message : '合并失败' };
    }
  }

  /** 社区投票（P1） */
  async vote(
    taskId: string,
    submissionId: string,
    decision: 'approve' | 'reject',
  ): Promise<{ success: boolean; message: string; data?: any }> {
    try {
      const token = await getToken();
      const res = await fetch(`${API_BASE}/${taskId}/vote`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ submissionId, decision }),
      });
      const json = await res.json();
      return { success: !!json.success, message: json.error || '投票成功', data: json.data };
    } catch (e) {
      return { success: false, message: e instanceof Error ? e.message : '投票失败' };
    }
  }

  /** 关闭任务（退回 escrow，仅创建者） */
  async closeQuest(taskId: string): Promise<{ success: boolean; message: string }> {
    try {
      const token = await getToken();
      const res = await fetch(`${API_BASE}/${taskId}/close`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({}),
      });
      const json = await res.json();
      return { success: !!json.success, message: json.error || '已关闭' };
    } catch (e) {
      return { success: false, message: e instanceof Error ? e.message : '关闭失败' };
    }
  }

  /** 删除任务（仅创建者；仅已关闭任务可删，删除任务及其领取/提交记录） */
  async deleteQuest(taskId: string): Promise<{ success: boolean; message: string }> {
    try {
      const token = await getToken();
      const res = await fetch(`${API_BASE}/${taskId}`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
      });
      const json = await res.json();
      return { success: !!json.success, message: json.error || '任务已删除' };
    } catch (e) {
      return { success: false, message: e instanceof Error ? e.message : '删除失败' };
    }
  }

  /** 转社区模组（P1） */
  async convertToMod(
    taskId: string,
    submissionId: string,
    title?: string,
    description?: string,
  ): Promise<{ success: boolean; message: string; data?: any }> {
    try {
      const token = await getToken();
      const res = await fetch(`${API_BASE}/${taskId}/submissions/${submissionId}/convert`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ title, description }),
      });
      const json = await res.json();
      return { success: !!json.success, message: json.error || '已转为社区模组', data: json.data };
    } catch (e) {
      return { success: false, message: e instanceof Error ? e.message : '转换失败' };
    }
  }

  /** 社区模组列表（P1） */
  async listMods(gameId?: string): Promise<QuestMod[]> {
    try {
      const qs = gameId ? `?gameId=${encodeURIComponent(gameId)}` : '';
      return ((await apiFetch(`/mods${qs}`)) as QuestMod[]) || [];
    } catch (e) {
      console.warn('[Quest] 加载社区模组失败:', e);
      return [];
    }
  }
}

export const questService = new QuestService();
export default questService;
