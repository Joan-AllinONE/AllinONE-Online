/**
 * 执行引擎测试：TriggerEvent → EffectPlan（纯函数全路径）
 * 用一个 mini GroupBuy 条款集覆盖：加入/成团/幂等/条件门/状态门/
 * channelToken 强制/非法迁移/影子模式/expr 解析/splitPayout 表
 */
import { describe, it, expect } from 'vitest';
import { executeTrigger, applyUpdates } from '../execute.js';
import type { Clause, ContractInstance, TriggerEvent } from '../../types.js';

const NOW = 1700000000000;

const CLAUSES: Clause[] = [
  {
    id: 'join',
    title: '加入拼团（资金入托管）',
    on: { id: 't-join', kind: 'manual', action: 'join' },
    when: 'state.memberCount < params.maxMembers',
    then: [
      {
        type: 'walletTransfer',
        toUserId: 'escrow',
        currency: 'gameCoins',
        amount: 'expr: params.groupPrice',
        fromUserId: 'expr: event.userId',
        reason: '拼团货款托管',
      },
    ],
    updates: [{ field: 'memberCount', op: 'add', value: 1 }],
  },
  {
    id: 'reach-quorum',
    title: '满员成团',
    on: { id: 't-join2', kind: 'manual', action: 'join' },
    when: 'state.memberCount + 1 >= params.minMembers',
    then: [{ type: 'setState', to: 'active', reason: '达到最低成团人数' }],
  },
  {
    id: 'deadline-refund',
    title: '到期未成团自动退款',
    on: { id: 't-deadline', kind: 'cron', schedule: 'deadline-check' },
    when: 'now > params.closeAt && state.memberCount < params.minMembers',
    then: [{ type: 'refundAll', reason: '流团全额退款' }, { type: 'setState', to: 'refunded', reason: '流团' }],
  },
  {
    id: 'quest-progress',
    title: '游戏内进度（强制 channelToken）',
    on: { id: 't-proto', kind: 'protocol', match: 'GAME_EVENT:SCORE', requiresChannelToken: true },
    then: [{ type: 'notify', message: '进度已记录', reason: '进度通知' }],
    updates: [{ field: 'score', op: 'add', value: 'expr: event.points' }],
  },
  {
    id: 'settle',
    title: '结算分配',
    on: { id: 't-settle', kind: 'manual', action: 'settle', enabledStates: ['settling'] },
    then: [
      {
        type: 'splitPayout',
        currency: 'gameCoins',
        table: { kind: 'byField', stateField: 'contributions', amountField: 'amount' },
        reason: '按贡献分配',
      },
    ],
  },
];

function makeInstance(overrides: Partial<ContractInstance> = {}): ContractInstance {
  return {
    id: 'ctr_test',
    templateKey: 'group-buy',
    templateVersion: 1,
    family: 'teamup',
    codeHash: 'x'.repeat(64),
    upgradePolicy: 'immutable',
    initiatorId: 'u0',
    params: { maxMembers: 5, minMembers: 3, groupPrice: 100, closeAt: NOW - 1 },
    clauses: CLAUSES,
    parties: [],
    escrow: { voucherIds: [], walletHold: [] },
    state: 'funded',
    stateData: { memberCount: 0, score: 0, contributions: [
      { userId: 'u1', amount: 30 },
      { userId: 'u2', amount: 70 },
    ] },
    history: [],
    seed: 'seed-x',
    autoExecute: false,
    createdAt: NOW,
    updatedAt: NOW,
    version: 1,
    ...overrides,
  };
}

function joinEvent(triggerId: string, userId: string): TriggerEvent {
  return { triggerId, kind: 'manual', type: 'join', at: NOW, actorId: userId, payload: { userId } };
}

describe('executeTrigger', () => {
  it('加入拼团：托管转账 + 计数更新', () => {
    const inst = makeInstance();
    const r = executeTrigger(inst, joinEvent('tq-1', 'u1'), { now: NOW });
    expect(r.plan).not.toBeNull();
    const plan = r.plan!;
    expect(plan.idempotencyKey).toBe('ctr_test:tq-1');
    expect(plan.clauseIds).toContain('join');
    expect(plan.effects).toContainEqual({
      type: 'walletTransfer',
      toUserId: 'escrow',
      currency: 'gameCoins',
      amount: 100, // expr: params.groupPrice 已解析
      fromUserId: 'u1', // expr: event.userId 已解析
      reason: '拼团货款托管',
    });
    expect(plan.updates).toContainEqual({ field: 'memberCount', op: 'add', value: 1 });
    expect(plan.shadow).toBe(true); // autoExecute=false → 影子
  });

  it('多个条款可被同一触发命中（join + 满员判定）', () => {
    const inst = makeInstance({ stateData: { memberCount: 2, contributions: [] } });
    const r = executeTrigger(inst, joinEvent('tq-2', 'u3'), { now: NOW });
    const plan = r.plan!;
    expect(plan.clauseIds).toContain('join');
    expect(plan.clauseIds).toContain('reach-quorum');
    expect(plan.nextState).toBe('active'); // funded → active 合法
    expect(plan.effects.some((e) => e.type === 'walletTransfer')).toBe(true);
  });

  it('幂等：重复 triggerId 跳过', () => {
    const inst = makeInstance({
      history: [
        {
          seq: 0, at: NOW, type: 'trigger', actorId: 'u1',
          payload: { triggerId: 'tq-dup' }, prevHash: '0'.repeat(64), hash: 'x'.repeat(64),
        },
      ],
    });
    const r = executeTrigger(inst, joinEvent('tq-dup', 'u1'), { now: NOW });
    expect(r.plan).toBeNull();
    expect(r.reason).toBe('duplicate-trigger');
  });

  it('条件不满足 → condition-not-met', () => {
    // 只挂 join 条款并设为满员：触发器匹配但 when 拦下
    const inst = makeInstance({ clauses: [CLAUSES[0]], stateData: { memberCount: 5, contributions: [] } });
    const r = executeTrigger(inst, joinEvent('tq-3', 'u9'), { now: NOW });
    expect(r.reason).toBe('condition-not-met');
  });

  it('无匹配触发器 → no-matching-clause', () => {
    const inst = makeInstance();
    const r = executeTrigger(inst, { triggerId: 'tq-4', kind: 'manual', type: 'unknown', at: NOW, actorId: 'u1', payload: {} }, { now: NOW });
    expect(r.reason).toBe('no-matching-clause');
  });

  it('状态门：settle 只在 settling 可触发', () => {
    const ev: TriggerEvent = { triggerId: 'tq-5', kind: 'manual', type: 'settle', at: NOW, actorId: 'u1', payload: {} };
    expect(executeTrigger(makeInstance(), ev, { now: NOW }).reason).toBe('condition-not-met'); // funded
    const settling = makeInstance({ state: 'settling' });
    const r = executeTrigger(settling, ev, { now: NOW });
    expect(r.plan).not.toBeNull();
    const split = r.plan!.effects.find((e) => e.type === 'splitPayout');
    expect(split).toMatchObject({
      type: 'splitPayout',
      currency: 'gameCoins',
      table: [
        { userId: 'u1', amount: 30 },
        { userId: 'u2', amount: 70 },
      ],
    });
  });

  it('channelToken 强制：缺失即整体拒绝', () => {
    const inst = makeInstance();
    const ev: TriggerEvent = {
      triggerId: 'tq-6', kind: 'protocol', type: 'GAME_EVENT:SCORE',
      at: NOW, actorId: 'u1', payload: { points: 10 }, channelTokenValid: false,
    };
    const r = executeTrigger(inst, ev, { now: NOW });
    expect(r.plan).toBeNull();
    expect(r.reason).toBe('rejected');
    expect(r.reasonDetail).toContain('channelToken');
  });

  it('channelToken 有效时放行并解析 expr 更新', () => {
    const inst = makeInstance();
    const ev: TriggerEvent = {
      triggerId: 'tq-7', kind: 'protocol', type: 'GAME_EVENT:SCORE',
      at: NOW, actorId: 'u1', payload: { points: 10 }, channelTokenValid: true,
    };
    const r = executeTrigger(inst, ev, { now: NOW });
    expect(r.plan).not.toBeNull();
    expect(r.plan!.updates).toContainEqual({ field: 'score', op: 'add', value: 10 });
  });

  it('cron 流团：退款 + 状态迁移', () => {
    const inst = makeInstance(); // closeAt 已过 & memberCount=0 < minMembers
    const ev: TriggerEvent = {
      triggerId: 'tick-1', kind: 'cron', type: 'deadline-check',
      at: NOW, actorId: 'system', payload: {},
    };
    const r = executeTrigger(inst, ev, { now: NOW });
    const plan = r.plan!;
    expect(plan.effects.some((e) => e.type === 'refundAll')).toBe(true);
    expect(plan.nextState).toBe('refunded');
  });

  it('非法状态迁移整体拒绝', () => {
    const badClauses: Clause[] = [
      {
        id: 'bad',
        title: '非法迁移',
        on: { id: 't-bad', kind: 'manual', action: 'join' },
        then: [{ type: 'setState', to: 'draft', reason: '不许回草稿' }],
      },
    ];
    const inst = makeInstance({ clauses: badClauses });
    const r = executeTrigger(inst, joinEvent('tq-8', 'u1'), { now: NOW });
    expect(r.plan).toBeNull();
    expect(r.reason).toBe('rejected');
    expect(r.reasonDetail).toContain('非法状态迁移');
  });

  it('when 求值失败 → eval-error 拒绝（宁拒不半执行）', () => {
    const badClauses: Clause[] = [
      {
        id: 'broken',
        title: '坏条件',
        on: { id: 't-broken', kind: 'manual', action: 'join' },
        when: 'state.memberCount / 0 > 1',
        then: [{ type: 'notify', message: 'x', reason: '通知' }],
      },
    ];
    const inst = makeInstance({ clauses: badClauses });
    const r = executeTrigger(inst, joinEvent('tq-9', 'u1'), { now: NOW });
    expect(r.reason).toBe('eval-error');
  });

  it('autoExecute=true → shadow=false', () => {
    const inst = makeInstance({ autoExecute: true });
    const r = executeTrigger(inst, joinEvent('tq-10', 'u1'), { now: NOW });
    expect(r.plan!.shadow).toBe(false);
  });
});

describe('applyUpdates', () => {
  it('add / set / 嵌套路径 / 非数字 add 目标按 0 处理', () => {
    const next = applyUpdates(
      { memberCount: 2, nested: { count: 1 }, fresh: 'str' },
      [
        { field: 'memberCount', op: 'add', value: 3 },
        { field: 'nested.count', op: 'set', value: 9 },
        { field: 'fresh', op: 'add', value: 4 },
        { field: 'brand.new', op: 'set', value: 7 },
      ],
    );
    expect(next).toEqual({ memberCount: 5, nested: { count: 9 }, fresh: 4, brand: { new: 7 } });
  });

  it('纯函数：不改入参', () => {
    const orig = { memberCount: 2 };
    applyUpdates(orig, [{ field: 'memberCount', op: 'add', value: 1 }]);
    expect(orig.memberCount).toBe(2);
  });
});
