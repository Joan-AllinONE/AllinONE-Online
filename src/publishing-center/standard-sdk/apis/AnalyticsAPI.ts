/**
 * Analytics API - 数据分析
 */

import type { AllinONEGame } from '../index';
import { getFeatureApiBase } from '../../../../services/apiBase';

export interface AnalyticsEvent {
  name: string;
  timestamp: number;
  properties?: Record<string, any>;
}

export class AnalyticsAPI {
  private game: AllinONEGame;
  private initialized: boolean = false;
  private eventQueue: AnalyticsEvent[] = [];
  private flushInterval: number = 5000; // 5秒
  private flushTimer: any = null;
  private sessionId: string;

  constructor(game: AllinONEGame) {
    this.game = game;
    this.sessionId = this.generateSessionId();
  }

  async initialize(): Promise<void> {
    // 启动定时刷新
    this.startFlushTimer();
    
    // 监听页面关闭
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', () => {
        this.flush();
      });
    }

    this.initialized = true;

    // 发送会话开始事件
    this.track('session_start', {
      gameId: this.getGameId(),
      sessionId: this.sessionId,
      timestamp: Date.now(),
    });
  }

  /**
   * 追踪事件
   */
  track(eventName: string, properties?: Record<string, any>): void {
    const event: AnalyticsEvent = {
      name: eventName,
      timestamp: Date.now(),
      properties: {
        ...properties,
        gameId: this.getGameId(),
        sessionId: this.sessionId,
      },
    };

    this.eventQueue.push(event);

    // 如果队列过大，立即刷新
    if (this.eventQueue.length >= 50) {
      this.flush();
    }
  }

  /**
   * 追踪页面/场景访问
   */
  trackPageView(pageName: string, properties?: Record<string, any>): void {
    this.track('page_view', {
      page: pageName,
      ...properties,
    });
  }

  /**
   * 追踪玩家行为
   */
  trackPlayerAction(action: string, properties?: Record<string, any>): void {
    this.track('player_action', {
      action,
      ...properties,
    });
  }

  /**
   * 追踪经济事件（消费、获得等）
   */
  trackEconomy(
    action: 'earn' | 'spend' | 'purchase',
    currency: string,
    amount: number,
    properties?: Record<string, any>
  ): void {
    this.track('economy', {
      action,
      currency,
      amount,
      ...properties,
    });
  }

  /**
   * 追踪进度
   */
  trackProgress(level: number, score?: number, properties?: Record<string, any>): void {
    this.track('progress', {
      level,
      score,
      ...properties,
    });
  }

  /**
   * 立即刷新数据
   */
  async flush(): Promise<void> {
    if (this.eventQueue.length === 0) return;

    const events = [...this.eventQueue];
    this.eventQueue = [];

    try {
      const response = await fetch(`${getFeatureApiBase('analytics')}/track`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          gameId: this.getGameId(),
          sessionId: this.sessionId,
          events,
        }),
      });

      if (!response.ok) {
        // 如果发送失败，将事件重新放回队列
        this.eventQueue.unshift(...events);
      }
    } catch (error) {
      // 如果发送失败，将事件重新放回队列
      this.eventQueue.unshift(...events);
      console.warn('Failed to send analytics events:', error);
    }
  }

  /**
   * 销毁
   */
  destroy(): void {
    this.stopFlushTimer();
    this.flush();
  }

  // ==================== 私有方法 ====================

  private startFlushTimer(): void {
    this.flushTimer = setInterval(() => {
      this.flush();
    }, this.flushInterval);
  }

  private stopFlushTimer(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private generateSessionId(): string {
    return `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  private getGameId(): string {
    return (this.game as any).getConfig().gameId;
  }
}
