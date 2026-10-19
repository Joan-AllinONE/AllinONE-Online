/**
 * 限时活动引擎单测（E1）——纯函数全迁移路径 / 周期 / 灰度 / 奖励判定 / 提交校验
 */
import { describe, it, expect } from 'vitest';
import {
  LimitedEventDef,
  computeNextStatus, advanceStatus, checkEventGate,
  rolloutAllows, stableHash, shiftByUnit, cloneNextOccurrence,
  checkSubmit, currentStage, computeClaimables, computeLeaderboard,
  computeSettlementGrants, computeDrop, grantId, defaultMetric,
  HOUR_MS, DAY_MS,
} from '../eventEngine';

function mkEvent(p: Partial<LimitedEventDef> = {}): LimitedEventDef {
  const now = 1_700_000_000_000;
  return {
    id: 'evt_freon_1', slug: 'freon', name: 'Freon', type: 'collect',
    status: 'draft', enabled: true,
    startTime: now + 10 * DAY_MS, endTime: now + 17 * DAY_MS,
    leadHours: 24, graceHours: 72,
    config: { metric: 'freon' }, rewardRules: [], rollout: { mode: 'all' },
    settleManifest: null, createdAt: now, updatedAt: now,
    ...p,
  };
}

describe('computeNextStatus 状态机', () => {
  const e = mkEvent();
  it('draft → scheduled（提前 leadHours 预热）', () => {
    expect(computeNextStatus(e, e.startTime - 24 * HOUR_MS - 1)).toBeNull();
    expect(computeNextStatus(e, e.startTime - 24 * HOUR_MS)).toBe('scheduled');
  });
  it('scheduled → live → closing → settled', () => {
    expect(computeNextStatus({ ...e, status: 'scheduled' }, e.startTime)).toBe('live');
    expect(computeNextStatus({ ...e, status: 'live' }, e.endTime)).toBe('closing');
    expect(computeNextStatus({ ...e, status: 'closing' }, e.endTime + 72 * HOUR_MS)).toBe('settled');
    expect(computeNextStatus({ ...e, status: 'closing' }, e.endTime + 71 * HOUR_MS)).toBeNull();
  });
  it('advanceStatus 一次跨多个边界', () => {
    const r = advanceStatus({ ...e, status: 'draft' }, e.startTime + DAY_MS);
    expect(r.status).toBe('live');
    expect(r.transitions).toEqual(['scheduled', 'live']);
  });
  it('settled/archived 不再迁移（幂等）', () => {
    expect(computeNextStatus({ ...e, status: 'settled' }, e.endTime + 999 * DAY_MS)).toBeNull();
    expect(computeNextStatus({ ...e, status: 'archived' }, e.endTime + 999 * DAY_MS)).toBeNull();
  });
  it('紧急下线：任意状态 → closing，且 closing 按 forceStopAt+grace 结算（不卡死）', () => {
    const stopped = { ...e, status: 'live', forceStopAt: e.startTime };
    expect(computeNextStatus(stopped, e.startTime + 1)).toBe('closing');
    const closingStopped = { ...stopped, status: 'closing' };
    expect(computeNextStatus(closingStopped, e.startTime + 71 * HOUR_MS)).toBeNull();
    expect(computeNextStatus(closingStopped, e.startTime + 72 * HOUR_MS)).toBe('settled');
  });
  it('enabled=false 同样进入 closing', () => {
    expect(computeNextStatus({ ...e, status: 'scheduled', enabled: false }, e.startTime - 1)).toBe('closing');
  });
});

describe('checkEventGate 三重校验', () => {
  const e = mkEvent({ status: 'live', startTime: 1000, endTime: 2000, graceHours: 1 });
  it('live 相位放行', () => {
    expect(checkEventGate(e, 'u1', 1500, 'live').ok).toBe(true);
  });
  it('窗口外 403（即使状态字段被误改）', () => {
    expect(checkEventGate(e, 'u1', 900, 'live').ok).toBe(false);
    expect(checkEventGate(e, 'u1', 2000 + HOUR_MS, 'live-or-closing').ok).toBe(false);
  });
  it('closing 拒 live 相位、放行补领', () => {
    const c = { ...e, status: 'closing' as const };
    expect(checkEventGate(c, 'u1', 2100, 'live').ok).toBe(false);
    expect(checkEventGate(c, 'u1', 2100, 'live-or-closing').ok).toBe(true);
  });
  it('开关关闭 / 不存在', () => {
    expect(checkEventGate({ ...e, enabled: false }, 'u1', 1500, 'live').ok).toBe(false);
    expect(checkEventGate(null, 'u1', 1500, 'live').code).toBe(404);
  });
});

describe('灰度', () => {
  it('percent 确定性分桶（同用户稳定）', () => {
    const e = mkEvent({ rollout: { mode: 'percent', percent: 50 } });
    const a = rolloutAllows(e, 'userA');
    expect(rolloutAllows(e, 'userA')).toBe(a); // 稳定
    expect(a).toBe(stableHash('freon:userA') % 100 < 50);
  });
  it('whitelist 精确匹配', () => {
    const e = mkEvent({ rollout: { mode: 'whitelist', whitelist: ['u1'] } });
    expect(rolloutAllows(e, 'u1')).toBe(true);
    expect(rolloutAllows(e, 'u2')).toBe(false);
  });
  it('gate 联动灰度（灰度外 403）', () => {
    const e = mkEvent({ status: 'live', startTime: 1000, endTime: 2000, rollout: { mode: 'whitelist', whitelist: ['u1'] } });
    expect(checkEventGate(e, 'u2', 1500, 'live').ok).toBe(false);
  });
});

describe('周期活动', () => {
  it('shiftByUnit weekly/biweekly/monthly', () => {
    const t = Date.UTC(2026, 0, 1);
    expect(shiftByUnit(t, 'weekly')).toBe(t + 7 * DAY_MS);
    expect(shiftByUnit(t, 'biweekly')).toBe(t + 14 * DAY_MS);
    expect(shiftByUnit(Date.UTC(2026, 0, 31), 'monthly')).toBe(Date.UTC(2026, 1, 28)); // 月末溢出回退
  });
  it('cloneNextOccurrence：新 id/时间平移/清 forceStop/阶段同步平移', () => {
    const stageStart = mkEvent().startTime + DAY_MS;
    const e2 = mkEvent({
      status: 'closing', forceStopAt: 123,
      repeat: { unit: 'weekly' },
      config: { metric: 'x', stages: [{ id: 's1', index: 1, name: 'A', startTime: stageStart, endTime: stageStart + DAY_MS, goal: { metric: 'm', target: 1 }, rewards: [] }] },
    });
    const next = cloneNextOccurrence(e2, 1);
    expect(next.id).toBe('evt_freon_2');
    expect(next.status).toBe('draft');
    expect(next.forceStopAt).toBeUndefined();
    expect(next.startTime).toBe(e2.startTime + 7 * DAY_MS);
    expect(next.config.stages![0].startTime).toBe(stageStart + 7 * DAY_MS);
  });
});

describe('提交校验', () => {
  const e = mkEvent({ config: { metric: 'freon', maxValuePerSubmit: 5, dailySubmitCap: 3 } });
  const p = { id: 'x', eventId: 'x', userId: 'u', joinedAt: 0, metrics: {}, submissions: 0, submissionsToday: 0, submissionsDate: dayKey(0), stageContrib: {}, lastSubmitAt: 0 };
  function dayKey(n: number) { return '1970-1-1'; }
  it('单次值超限 400', () => {
    expect(checkSubmit(e, p as any, 6, 1000).ok).toBe(false);
    expect(checkSubmit(e, p as any, 0, 1000).ok).toBe(false);
    expect(checkSubmit(e, p as any, 5, 1000).ok).toBe(true);
  });
  it('每日上限 429（跨日重置由 submissionsDate 判定）', () => {
    const capped = { ...p, submissionsToday: 3, submissionsDate: '1970-1-1' };
    expect(checkSubmit(e, capped as any, 1, 1000).code).toBe(429);
  });
});

describe('奖励判定与结算', () => {
  const e = mkEvent({
    rewardRules: [
      { id: 'r10', kind: 'threshold', metric: 'freon', threshold: 10, reward: { currency: 'gamecoin', amount: 100 } },
      { id: 'rjoin', kind: 'participation', metric: 'freon', reward: { currency: 'gamecoin', amount: 20 } },
      { id: 'rtop', kind: 'leaderboard', metric: 'freon', rankRange: [0, 1], reward: { currency: 'gamecoin', amount: 500 } },
    ],
  });
  const p: any = { metrics: { freon: 12 }, stageContrib: {} };
  it('threshold/participation 自助可领；leaderboard 不出现在 claimables', () => {
    const cs = computeClaimables(e, p, new Set());
    expect(cs.find((c) => c.rewardId === 'r10')?.claimable).toBe(true);
    expect(cs.find((c) => c.rewardId === 'rjoin')?.claimable).toBe(true);
    expect(cs.find((c) => c.rewardId === 'rtop')).toBeUndefined();
    // 已领取后不再可领
    const cs2 = computeClaimables(e, p, new Set(['r10']));
    expect(cs2.find((c) => c.rewardId === 'r10')?.claimable).toBe(false);
    expect(cs2.find((c) => c.rewardId === 'r10')?.claimed).toBe(true);
  });
  it('未达标不可领', () => {
    const cs = computeClaimables(e, { metrics: { freon: 5 }, stageContrib: {} } as any, new Set());
    expect(cs.find((c) => c.rewardId === 'r10')?.claimable).toBe(false);
  });
  it('结算：排行榜名次区间 → 发放清单', () => {
    const parts: any[] = [
      { userId: 'a', metrics: { freon: 30 } },
      { userId: 'b', metrics: { freon: 20 } },
      { userId: 'c', metrics: { freon: 10 } },
    ];
    const grants = computeSettlementGrants(e, parts);
    expect(grants).toEqual([
      { userId: 'a', rewardId: 'rtop', amount: 500 },
      { userId: 'b', rewardId: 'rtop', amount: 500 },
    ]);
  });
  it('榜单稳定排序（同分按 userId）', () => {
    const board = computeLeaderboard([
      { userId: 'b', metrics: { freon: 10 } } as any,
      { userId: 'a', metrics: { freon: 10 } } as any,
    ], 'freon');
    expect(board[0].userId).toBe('a');
  });
});

describe('Freon 掉落钩子', () => {
  it('仅 live+开关+窗口+通道匹配的 collect 活动掉落', () => {
    const live = mkEvent({ status: 'live', startTime: 1000, endTime: 2000, config: { metric: 'freon', dropChannels: [{ channel: 'game_play', rate: 2, dailyCap: 9 }] } });
    expect(computeDrop([live], 'game_play', 'u1', 1500)).toBe(2);
    expect(computeDrop([live], 'item_harvest', 'u1', 1500)).toBe(0);
    expect(computeDrop([{ ...live, status: 'closing' }], 'game_play', 'u1', 1500)).toBe(0);
  });
});

describe('杂项', () => {
  it('defaultMetric 按类型回退（config.metric 显式指定时优先）', () => {
    expect(defaultMetric(mkEvent())).toBe('freon');
    expect(defaultMetric(mkEvent({ type: 'game', config: {} }))).toBe('score');
    expect(defaultMetric(mkEvent({ type: 'staged', config: {} }))).toBe('stage_contrib');
    expect(defaultMetric(mkEvent({ type: 'game', config: { metric: 'stars' } }))).toBe('stars');
  });
  it('grantId 幂等键格式', () => {
    expect(grantId('e', 'u', 'r')).toBe('grant_e_u_r');
  });
  it('currentStage 窗口命中', () => {
    const stages = [
      { id: 's1', index: 1, name: 'a', startTime: 0, endTime: 100, goal: { metric: 'm', target: 1 }, rewards: [] },
      { id: 's2', index: 2, name: 'b', startTime: 100, endTime: 200, goal: { metric: 'm', target: 1 }, rewards: [] },
    ];
    const e = mkEvent({ type: 'staged', config: { stages } });
    expect(currentStage(e, 50)?.id).toBe('s1');
    expect(currentStage(e, 150)?.id).toBe('s2');
    expect(currentStage(e, 999)).toBeNull();
  });
});
