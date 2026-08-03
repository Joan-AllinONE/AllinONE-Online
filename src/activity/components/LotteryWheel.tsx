import { useState } from 'react';
import { Coins, Dices, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { ActivityDef } from '../types';

export function LotteryWheel({
  activity,
  walletCoins,
  onDraw,
}: {
  activity: ActivityDef;
  walletCoins: number;
  onDraw: () => Promise<any>;
}) {
  const [spinning, setSpinning] = useState(false);
  const [result, setResult] = useState<{ label?: string; amount: number } | null>(null);
  const cost = activity.lottery?.cost || 0;
  const prizes = activity.lottery?.prizes || [];
  const canDraw = walletCoins >= cost && !spinning;

  const handle = async () => {
    if (walletCoins < cost) {
      toast.error(`游戏币不足，需要 ${cost}`);
      return;
    }
    setSpinning(true);
    setResult(null);
    try {
      const r = await onDraw();
      const p = r?.prize;
      setResult({ label: p?.label, amount: p?.reward?.amount || 0 });
      toast.success(`恭喜获得 ${p?.reward?.amount} 游戏币！`);
    } catch (e: any) {
      toast.error(e?.message || '抽奖失败');
    } finally {
      setSpinning(false);
    }
  };

  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
      <div className="mb-4 flex items-center gap-2">
        <Dices className="h-5 w-5 text-purple-400" />
        <h3 className="text-lg font-semibold text-white">{activity.title}</h3>
      </div>
      <p className="mb-4 text-sm text-slate-400">{activity.description}</p>

      <div className="flex flex-wrap gap-2">
        {prizes.map((p, i) => (
          <div
            key={i}
            className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-slate-300"
          >
            {p.label || `${p.reward.amount}`}
          </div>
        ))}
      </div>

      <div className="mt-5 flex items-center justify-between">
        <span className="inline-flex items-center gap-1 text-sm text-amber-300">
          <Coins className="h-4 w-4" /> 每次消耗 {cost} 游戏币
        </span>
        <button
          onClick={handle}
          disabled={!canDraw}
          className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-purple-500 to-fuchsia-500 px-5 py-2.5 font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {spinning && <Loader2 className="h-4 w-4 animate-spin" />}
          {spinning ? '抽奖中…' : '开始抽奖'}
        </button>
      </div>

      {result && (
        <div className="mt-4 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-center text-emerald-300">
          🎉 恭喜获得 <span className="font-bold">{result.amount}</span> 游戏币
          {result.label ? `（${result.label}）` : ''}
        </div>
      )}
    </div>
  );
}
