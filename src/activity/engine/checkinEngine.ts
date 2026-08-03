import { ActivityDef, ProgressRecord } from '../types';
import { DAY_MS } from '../config';

export function dayIndex(ts: number = Date.now()): number {
  return Math.floor(ts / DAY_MS);
}

/** 7 天为一个签到周期 */
export const CHECKIN_CYCLE = 7;

export function checkinState(progress: ProgressRecord): {
  canCheckIn: boolean;
  isToday: boolean;
  cycleDay: number;
} {
  const today = dayIndex();
  const isToday = progress.lastCheckInDay === today;
  const cycleDay = (today % CHECKIN_CYCLE) + 1;
  return { canCheckIn: !isToday, isToday, cycleDay };
}

/** 取第 N 天（1-based）的签到奖励，超出长度则用最后一个 */
export function checkinRewardForDay(activity: ActivityDef, day: number): import('../types').RewardDef {
  const rewards = activity.rewards;
  const idx = Math.min(Math.max(day, 1) - 1, rewards.length - 1);
  return rewards[idx] ?? rewards[0];
}
