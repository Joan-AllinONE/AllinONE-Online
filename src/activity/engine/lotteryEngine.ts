import { LotteryPrize } from '../types';

/** 按权重随机抽取一个奖品 */
export function drawPrize(lottery: { prizes: LotteryPrize[] }): LotteryPrize {
  const prizes = lottery.prizes;
  if (prizes.length === 0) throw new Error('抽奖奖品为空');
  const total = prizes.reduce((s, p) => s + Math.max(p.weight, 0), 0);
  if (total <= 0) return prizes[prizes.length - 1];
  let r = Math.random() * total;
  for (const p of prizes) {
    if (r < p.weight) return p;
    r -= Math.max(p.weight, 0);
  }
  return prizes[prizes.length - 1];
}
