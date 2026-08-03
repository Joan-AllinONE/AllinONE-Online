import { Check, Lock } from 'lucide-react';
import { ActivityDef, ProgressRecord } from '../types';
import { ActivityIcon } from './ActivityIcon';
import { RewardBadge } from './RewardBadge';

export function AchievementGrid({
  activities,
  getProgress,
}: {
  activities: ActivityDef[];
  getProgress: (id: string) => ProgressRecord | undefined;
}) {
  if (activities.length === 0) {
    return <p className="py-8 text-center text-sm text-slate-400">暂无成就</p>;
  }
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {activities.map((a) => {
        const status = getProgress(a.id)?.status || 'available';
        const done = status === 'completed' || status === 'claimed';
        return (
          <div
            key={a.id}
            className={`flex flex-col items-center gap-2 rounded-2xl border p-4 text-center ${
              done ? 'border-amber-400/40 bg-amber-400/10' : 'border-white/10 bg-white/5'
            }`}
          >
            <div
              className={`flex h-12 w-12 items-center justify-center rounded-full ${
                done ? 'bg-amber-400/20 text-amber-300' : 'bg-white/10 text-slate-400'
              }`}
            >
              {done ? <Check className="h-6 w-6" /> : <Lock className="h-5 w-5" />}
            </div>
            <ActivityIcon name={a.icon} className="h-5 w-5 text-indigo-300" />
            <h4 className="text-sm font-medium text-white">{a.title}</h4>
            <div className="flex gap-1">
              {a.rewards.map((r, i) => (
                <RewardBadge key={i} reward={r} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
