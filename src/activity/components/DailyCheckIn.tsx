import { useState } from 'react';
import { CalendarCheck, Coins, Loader2 } from 'lucide-react';
import { ActivityDef, ProgressRecord } from '../types';
import { ActivityIcon } from './ActivityIcon';
import { RewardBadge } from './RewardBadge';
import { checkinState, checkinRewardForDay, CHECKIN_CYCLE } from '../engine/checkinEngine';
import { toast } from 'sonner';

export function DailyCheckIn({
  activity,
  progress,
  onCheckIn,
}: {
  activity: ActivityDef;
  progress?: ProgressRecord;
  onCheckIn: () => Promise<any>;
}) {
  const prog = progress;
  const { canCheckIn, isToday } = checkinState(prog || ({ lastCheckInDay: 0 } as ProgressRecord));
  // 实际发奖以连续签到天数 streak 为准（与服务端 ActivitySkill.checkin 一致），
  // 而非日历 cycleDay，避免中断后续签导致显示奖励与实际到账不符。
  const streak = prog?.streak || 0;
  const nextDay = Math.min(streak + 1, CHECKIN_CYCLE);
  const todayReward = checkinRewardForDay(activity, nextDay);
  const claimedDays = Math.min(streak, CHECKIN_CYCLE);
  const [spinning, setSpinning] = useState(false);

  const handle = async () => {
    if (!canCheckIn || spinning) return;
    setSpinning(true);
    try {
      const r = await onCheckIn();
      const amount = r?.amount || todayReward.amount;
      toast.success(`签到成功，获得 ${amount} 游戏币！`);
    } catch (e: any) {
      toast.error(e?.message || '签到失败');
    } finally {
      setSpinning(false);
    }
  };

  const days = Array.from({ length: CHECKIN_CYCLE }, (_, i) => i + 1);

  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
      <div className="mb-4 flex items-center gap-2">
        <CalendarCheck className="h-5 w-5 text-emerald-400" />
        <h3 className="text-lg font-semibold text-white">{activity.title}</h3>
        {activity.rewards.length >= CHECKIN_CYCLE && (
          <span className="ml-auto inline-flex items-center gap-1 text-xs text-amber-300">
            <Coins className="h-3 w-3" /> 第 7 天获 {activity.rewards[CHECKIN_CYCLE - 1]?.amount} 币
          </span>
        )}
      </div>
      <p className="mb-4 text-sm text-slate-400">{activity.description}</p>

      <div className="grid grid-cols-7 gap-2">
        {days.map((d) => {
          const reward = checkinRewardForDay(activity, d);
          const claimed = d <= claimedDays;
          const isTodayCell = d === nextDay;
          return (
            <div
              key={d}
              className={`flex flex-col items-center gap-1 rounded-xl border p-2 text-center ${
                isTodayCell
                  ? 'border-emerald-400/50 bg-emerald-400/10'
                  : claimed
                  ? 'border-white/10 bg-white/5'
                  : 'border-white/5 bg-white/[0.02]'
              }`}
            >
              <span className="text-[10px] text-slate-400">第{d}天</span>
              <ActivityIcon name={activity.icon} className="h-4 w-4 text-indigo-300" />
              <RewardBadge reward={reward} />
            </div>
          );
        })}
      </div>

      <button
        onClick={handle}
        disabled={!canCheckIn || spinning}
        className="mt-4 w-full rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 py-2.5 font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {spinning ? (
          <Loader2 className="mx-auto h-4 w-4 animate-spin" />
        ) : isToday ? (
          '今日已签到'
        ) : (
          `签到领取 ${todayReward.amount} 游戏币`
        )}
      </button>
    </div>
  );
}
