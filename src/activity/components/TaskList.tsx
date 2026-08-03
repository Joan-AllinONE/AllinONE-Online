import { Gift, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useState } from 'react';
import { ActivityDef, ProgressRecord } from '../types';
import { ActivityIcon } from './ActivityIcon';
import { RewardBadge } from './RewardBadge';

export function TaskList({
  activities,
  getProgress,
  onClaim,
}: {
  activities: ActivityDef[];
  getProgress: (id: string) => ProgressRecord | undefined;
  onClaim: (id: string) => Promise<any>;
}) {
  const [claiming, setClaiming] = useState<string | null>(null);

  if (activities.length === 0) {
    return <p className="py-8 text-center text-sm text-slate-400">暂无进行中的任务</p>;
  }

  const handleClaim = async (id: string) => {
    setClaiming(id);
    try {
      const r = await onClaim(id);
      toast.success(`领取成功，获得 ${r?.total || 0} 游戏币！`);
    } catch (e: any) {
      toast.error(e?.message || '领取失败');
    } finally {
      setClaiming(null);
    }
  };

  return (
    <div className="space-y-3">
      {activities.map((a) => {
        const p = getProgress(a.id);
        const status = p?.status || 'available';
        const current = p?.current || 0;
        const target = p?.target || a.conditions?.target || 1;
        const pct = Math.min(100, Math.round((current / target) * 100));
        const completed = status === 'completed';
        const claimed = status === 'claimed';
        return (
          <div key={a.id} className="rounded-2xl border border-white/10 bg-white/5 p-4">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-500/15 text-indigo-200">
                <ActivityIcon name={a.icon} className="h-5 w-5" />
              </div>
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <h4 className="font-medium text-white">{a.title}</h4>
                  {a.conditions?.event && (
                    <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] text-slate-400">
                      {a.conditions.event}
                    </span>
                  )}
                </div>
                <p className="mt-0.5 text-xs text-slate-400">{a.description}</p>
                <div className="mt-2 flex items-center gap-2">
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/10">
                    <div className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-purple-500" style={{ width: `${pct}%` }} />
                  </div>
                  <span className="text-xs text-slate-400">{current}/{target}</span>
                </div>
                <div className="mt-2 flex gap-1">
                  {a.rewards.map((r, i) => (
                    <RewardBadge key={i} reward={r} />
                  ))}
                </div>
              </div>
              <button
                onClick={() => handleClaim(a.id)}
                disabled={!completed || claimed || claiming === a.id}
                className="mt-1 inline-flex shrink-0 items-center gap-1 rounded-xl bg-gradient-to-r from-fuchsia-500 to-purple-500 px-3 py-1.5 text-sm font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {claiming === a.id ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Gift className="h-3.5 w-3.5" />
                )}
                {claimed ? '已领取' : completed ? '领取' : '进行中'}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
