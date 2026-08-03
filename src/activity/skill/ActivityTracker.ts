import { globalEventBus } from '../../skills/EventBus';
import { ActivityDef, ProgressRecord } from '../types';
import { TRACKED_EVENTS, TrackedEvent } from '../config';
import { fetchActivities } from '../service/activityService';
import { evaluateTask } from '../engine/taskEngine';

const PROGRESS_EVENT = 'activity-progress-updated';

/**
 * 活动进度追踪器（后台）：订阅 globalEventBus 上的埋点事件，
 * 命中任务条件时自动推进玩家本地进度（localStorage）。
 *
 * 设计要点：
 *  - 进度本地优先（单玩家持久化），不阻塞任何业务调用方。
 *  - 仅监听任务型活动（onboarding/growth/limited_event/achievement）的 condition.event。
 *  - 进度变化后派发 'activity-progress-updated' 供 UI 刷新。
 */
export class ActivityTracker {
  // 动态获取当前用户，避免登录态变化需手动刷新
  private getUserId: () => string | null = () => null;
  private activities: ActivityDef[] = [];
  // EventBus 通配符处理器签名：(event, data, context)
  private handler = (event: string, payload?: any) => this.onEvent(event as TrackedEvent, payload);

  /** 初始化：载入活动列表与玩家进度，开始监听事件 */
  async init(getUserId: () => string | null): Promise<void> {
    // 幂等：先移除旧监听，避免重复注册导致同一事件被处理两次（进度双倍累加）
    this.dispose();
    this.getUserId = getUserId;
    try {
      this.activities = await fetchActivities();
    } catch {
      this.activities = [];
    }
    // 仅通配符处理器能拿到事件名（handler 收到 (event, data, context)）
    globalEventBus.on('*', this.handler);
  }

  /** 切换用户（登录态变化时） */
  async setUser(getUserId: () => string | null): Promise<void> {
    this.dispose();
    await this.init(getUserId);
  }

  private async onEvent(event: TrackedEvent, _payload?: any): Promise<void> {
    const userId = this.getUserId();
    if (!userId) return;
    if (!TRACKED_EVENTS.includes(event)) return;

    const matched = this.activities.filter(
      (a) => a.type !== 'daily_checkin' && a.conditions && a.conditions.event === event && a.status === 'active'
    );
    if (matched.length === 0) return;

    let records: ProgressRecord[] = [];
    try {
      const raw = localStorage.getItem(`allinone_activity_progress_${userId}`);
      records = raw ? (JSON.parse(raw) as ProgressRecord[]) : [];
    } catch {
      records = [];
    }

    let changed = false;
    for (const activity of matched) {
      let progress = records.find((p) => p.activityId === activity.id);
      if (!progress) {
        progress = {
          userId,
          activityId: activity.id,
          status: 'available',
          current: 0,
          target: activity.conditions?.target ?? 1,
          streak: 0,
          lastCheckInDay: 0,
          makeupUsed: 0,
          history: [],
          updatedAt: Date.now(),
        };
        records.push(progress);
      }
      const updated = evaluateTask(progress, activity, event);
      if (updated !== progress) {
        const i = records.findIndex((p) => p.activityId === activity.id);
        records[i] = updated;
        changed = true;
      }
    }

    if (changed) {
      try {
        localStorage.setItem(`allinone_activity_progress_${userId}`, JSON.stringify(records));
      } catch {
        /* ignore */
      }
      try {
        window.dispatchEvent(new CustomEvent(PROGRESS_EVENT, { detail: { userId } }));
      } catch {
        /* ignore */
      }
    }
  }

  dispose(): void {
    try {
      globalEventBus.off('*', this.handler);
    } catch {
      /* ignore */
    }
  }
}

export { PROGRESS_EVENT };
