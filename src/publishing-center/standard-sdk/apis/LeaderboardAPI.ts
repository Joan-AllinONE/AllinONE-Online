/**
 * Leaderboard API - 排行榜系统
 */

import type { AllinONEGame } from '../index';
import { getCachedToken } from './tokenManager';

export interface LeaderboardEntry {
  rank: number;
  userId: string;
  username: string;
  avatar?: string;
  score: number;
  metadata?: Record<string, any>;
  timestamp: string;
}

export interface LeaderboardData {
  id: string;
  name: string;
  entries: LeaderboardEntry[];
  totalEntries: number;
  userRank?: number;
  userScore?: number;
}

export class LeaderboardAPI {
  private game: AllinONEGame;
  private leaderboards: Map<string, LeaderboardData> = new Map();
  private initialized: boolean = false;

  constructor(game: AllinONEGame) {
    this.game = game;
  }

  async initialize(): Promise<void> {
    this.initialized = true;
  }

  /**
   * 获取排行榜
   */
  async getLeaderboard(leaderboardId: string = 'global', limit: number = 100): Promise<LeaderboardData | null> {
    try {
      const response = await fetch(`/api/leaderboard/${leaderboardId}?gameId=${this.getGameId()}&limit=${limit}`);
      const result = await response.json();

      if (result.success) {
        this.leaderboards.set(leaderboardId, result.data);
        return result.data;
      }

      return null;
    } catch (error) {
      console.error('Failed to get leaderboard:', error);
      return null;
    }
  }

  /**
   * 提交分数
   */
  async submitScore(score: number, metadata?: Record<string, any>, leaderboardId: string = 'global'): Promise<boolean> {
    try {
      const token = this.getToken();
      if (!token) return false;

      const response = await fetch(`/api/leaderboard/${leaderboardId}/submit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          score,
          metadata,
          gameId: this.getGameId(),
        }),
      });

      const result = await response.json();

      if (result.success) {
        // 更新本地缓存
        await this.getLeaderboard(leaderboardId);
      }

      return result.success;
    } catch (error) {
      console.error('Failed to submit score:', error);
      return false;
    }
  }

  /**
   * 获取玩家排名
   */
  async getUserRank(leaderboardId: string = 'global'): Promise<{ rank: number; score: number } | null> {
    try {
      const token = this.getToken();
      if (!token) return null;

      const response = await fetch(`/api/leaderboard/${leaderboardId}/rank`, {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });

      const result = await response.json();

      if (result.success) {
        return { rank: result.rank, score: result.score };
      }

      return null;
    } catch (error) {
      console.error('Failed to get user rank:', error);
      return null;
    }
  }

  /**
   * 获取好友排行榜
   */
  async getFriendsLeaderboard(leaderboardId: string = 'global'): Promise<LeaderboardData | null> {
    try {
      const token = this.getToken();
      if (!token) return null;

      const response = await fetch(`/api/leaderboard/${leaderboardId}/friends?gameId=${this.getGameId()}`, {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });

      const result = await response.json();
      return result.success ? result.data : null;
    } catch (error) {
      console.error('Failed to get friends leaderboard:', error);
      return null;
    }
  }

  // ==================== 私有方法 ====================

  private getGameId(): string {
    return (this.game as any).getConfig().gameId;
  }

  private getToken(): string | null {
    return localStorage.getItem('allinone_token');
  }
}
