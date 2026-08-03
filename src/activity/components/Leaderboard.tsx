import { Crown, Medal } from 'lucide-react';
import { LeaderboardEntry } from '../types';

export function Leaderboard({ entries }: { entries: LeaderboardEntry[] }) {
  if (entries.length === 0) {
    return <p className="py-8 text-center text-sm text-slate-400">暂无排行数据，快去参加活动吧！</p>;
  }
  return (
    <div className="space-y-2">
      {entries.map((e, i) => (
        <div
          key={e.userId}
          className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/5 px-4 py-3"
        >
          <div className="w-7 text-center">
            {i === 0 ? (
              <Crown className="mx-auto h-5 w-5 text-amber-400" />
            ) : i === 1 ? (
              <Medal className="mx-auto h-5 w-5 text-slate-300" />
            ) : i === 2 ? (
              <Medal className="mx-auto h-5 w-5 text-orange-400" />
            ) : (
              <span className="text-sm text-slate-400">{i + 1}</span>
            )}
          </div>
          <div className="flex-1 truncate text-sm text-white">{e.userName || '匿名玩家'}</div>
          <div className="text-sm font-semibold text-amber-300">+{e.totalCoins}</div>
        </div>
      ))}
    </div>
  );
}
