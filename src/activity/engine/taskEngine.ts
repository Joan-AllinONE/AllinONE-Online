import { ActivityDef, ProgressRecord } from '../types';

/** 任务型活动类型 */
const TASK_TYPES: ActivityDef['type'][] = ['onboarding', 'growth', 'limited_event', 'achievement'];

export function isTaskType(type: ActivityDef['type']): boolean {
  return TASK_TYPES.includes(type);
}

/**
 * 处理一次事件触发，更新进度。
 * 返回新的 ProgressRecord（若发生变化），否则返回原对象。
 */
export function evaluateTask(
  progress: ProgressRecord,
  activity: ActivityDef,
  event: string
): ProgressRecord {
  if (!isTaskType(activity.type)) return progress;
  if (activity.status !== 'active') return progress;
  if (!activity.conditions || activity.conditions.event !== event) return progress;
  if (progress.status === 'completed' || progress.status === 'claimed') return progress;

  const current = Math.min(progress.current + 1, activity.conditions.target);
  const status: ProgressRecord['status'] =
    current >= activity.conditions.target ? 'completed' : 'available';

  return { ...progress, current, status, updatedAt: Date.now() };
}

/** 限时活动是否在有效期内 */
export function isLimitedEventOpen(activity: ActivityDef, now = Date.now()): boolean {
  if (activity.type !== 'limited_event') return activity.status === 'active';
  if (activity.status !== 'active') return false;
  if (activity.startTime && now < activity.startTime) return false;
  if (activity.endTime && now > activity.endTime) return false;
  return true;
}
