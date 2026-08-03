import { Coins } from 'lucide-react';
import { RewardDef } from '../types';

export function RewardBadge({ reward }: { reward: RewardDef }) {
  if (reward.kind === 'gameCoins') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-300">
        <Coins className="h-3 w-3" />
        {reward.amount}
      </span>
    );
  }
  return null;
}
