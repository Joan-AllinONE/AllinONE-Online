/**
 * Achievement API - 成就系统
 */

import type { AllinONEGame } from '../index';
import { getCachedToken } from './tokenManager';

export interface Achievement {
  id: string;
  name: string;
  description: string;
  icon?: string;
  points: number;
  rarity: 'common' | 'rare' | 'epic' | 'legendary';
  unlockedAt?: string;
  progress?: number;
  maxProgress?: number;
}

export class AchievementAPI {
  private game: AllinONEGame;
  private achievements: Map<string, Achievement> = new Map();
  private unlockedAchievements: Set<string> = new Set();
  private initialized: boolean = false;

  constructor(game: AllinONEGame) {
    this.game = game;
  }

  async initialize(): Promise<void> {
    // 加载成就定义
    await this.loadAchievements();
    
    // 加载已解锁成就
    const saved = localStorage.getItem(`allinone_achievements_${this.getGameId()}`);
    if (saved) {
      try {
        const unlocked: string[] = JSON.parse(saved);
        unlocked.forEach(id => this.unlockedAchievements.add(id));
      } catch {
        // 忽略解析错误
      }
    }

    this.initialized = true;
  }

  /**
   * 获取所有成就
   */
  async getAllAchievements(): Promise<Achievement[]> {
    await this.loadAchievements();
    return Array.from(this.achievements.values()).map(achievement => ({
      ...achievement,
      unlockedAt: this.unlockedAchievements.has(achievement.id) 
        ? achievement.unlockedAt || new Date().toISOString()
        : undefined,
    }));
  }

  /**
   * 获取已解锁成就
   */
  async getUnlockedAchievements(): Promise<Achievement[]> {
    const all = await this.getAllAchievements();
    return all.filter(a => this.unlockedAchievements.has(a.id));
  }

  /**
   * 解锁成就
   */
  async unlock(achievementId: string): Promise<boolean> {
    if (this.unlockedAchievements.has(achievementId)) {
      return true; // 已经解锁
    }

    const achievement = this.achievements.get(achievementId);
    if (!achievement) {
      console.warn(`Achievement not found: ${achievementId}`);
      return false;
    }

    try {
      const token = this.getToken();
      if (!token) return false;

      const response = await fetch('/api/achievements/unlock', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          achievementId,
          gameId: this.getGameId(),
        }),
      });

      const result = await response.json();

      if (result.success) {
        this.unlockedAchievements.add(achievementId);
        this.saveUnlockedAchievements();

        // 触发解锁事件
        (this.game as any).emit('achievement:unlocked', { achievement });

        // 发放奖励
        if (achievement.points > 0) {
          const wallet = (this.game as any).wallet;
          if (wallet) {
            await wallet.reward({ computingPower: achievement.points });
          }
        }

        return true;
      }

      return false;
    } catch (error) {
      console.error('Failed to unlock achievement:', error);
      return false;
    }
  }

  /**
   * 更新成就进度
   */
  async updateProgress(achievementId: string, progress: number): Promise<void> {
    const achievement = this.achievements.get(achievementId);
    if (!achievement || !achievement.maxProgress) return;

    achievement.progress = progress;

    if (progress >= achievement.maxProgress) {
      await this.unlock(achievementId);
    }

    this.achievements.set(achievementId, achievement);
  }

  /**
   * 检查是否已解锁
   */
  isUnlocked(achievementId: string): boolean {
    return this.unlockedAchievements.has(achievementId);
  }

  /**
   * 获取总积分
   */
  getTotalPoints(): number {
    let total = 0;
    for (const id of this.unlockedAchievements) {
      const achievement = this.achievements.get(id);
      if (achievement) {
        total += achievement.points;
      }
    }
    return total;
  }

  // ==================== 私有方法 ====================

  private async loadAchievements(): Promise<void> {
    if (this.achievements.size > 0) return;

    try {
      const response = await fetch(`/api/achievements?gameId=${this.getGameId()}`);
      const result = await response.json();

      if (result.success && result.achievements) {
        result.achievements.forEach((achievement: Achievement) => {
          this.achievements.set(achievement.id, achievement);
        });
      }
    } catch (error) {
      console.warn('Failed to load achievements:', error);
    }
  }

  private saveUnlockedAchievements(): void {
    localStorage.setItem(
      `allinone_achievements_${this.getGameId()}`,
      JSON.stringify(Array.from(this.unlockedAchievements))
    );
  }

  private getGameId(): string {
    return (this.game as any).getConfig().gameId;
  }

  private getToken(): string | null {
    return localStorage.getItem('allinone_token');
  }
}
