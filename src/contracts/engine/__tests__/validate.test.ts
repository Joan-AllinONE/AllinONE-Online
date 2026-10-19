/**
 * 静态校验测试：参数 / Effect 白名单 / 条款 / 状态机
 */
import { describe, it, expect } from 'vitest';
import {
  validateParams,
  validateTemplate,
  validateClauses,
  validateEffectSpec,
  isValidTransition,
} from '../validate.js';
import type { ValidationIssue } from '../validate.js';
import type { Clause, ContractTemplate, EffectSpecFree, ParamFieldRule } from '../../types.js';

describe('validateParams', () => {
  const schema: Record<string, ParamFieldRule> = {
    minMembers: { type: 'number', required: true, min: 2, max: 1000 },
    title: { type: 'string', required: true, max: 20 },
    currency: { type: 'enum', required: true, enumValues: ['gameCoins', 'aCoins'] },
    tags: { type: 'array', itemRule: { type: 'string' }, maxItems: 3 },
    buyback: {
      type: 'object',
      fields: { priceBps: { type: 'number', min: 0, max: 10000 } },
    },
    note: { type: 'string' },
  };

  it('合法参数通过', () => {
    const r = validateParams(schema, {
      minMembers: 3,
      title: '拼团',
      currency: 'gameCoins',
      tags: ['a', 'b'],
      buyback: { priceBps: 500 },
    });
    expect(r.ok).toBe(true);
  });

  it('必填缺失', () => {
    const r = validateParams(schema, { title: 'x', currency: 'aCoins' });
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.path === 'params.minMembers')).toBe(true);
  });

  it('范围与枚举', () => {
    const r = validateParams(schema, { minMembers: 1, title: 'x', currency: 'usd' });
    expect(r.issues.some((i) => i.path === 'params.minMembers' && i.message.includes('不得小于'))).toBe(true);
    expect(r.issues.some((i) => i.path === 'params.currency' && i.message.includes('之一'))).toBe(true);
  });

  it('未知字段拦截（参数面封闭）', () => {
    const r = validateParams(schema, { minMembers: 3, title: 'x', currency: 'aCoins', hack: 1 });
    expect(r.issues.some((i) => i.path === 'params.hack' && i.message.includes('未知字段'))).toBe(true);
  });

  it('嵌套 object/array 递归校验', () => {
    const r = validateParams(schema, {
      minMembers: 3,
      title: 'x',
      currency: 'aCoins',
      tags: ['a', 5],
      buyback: { priceBps: 20000 },
    });
    expect(r.issues.some((i) => i.path === 'params.tags[1]')).toBe(true);
    expect(r.issues.some((i) => i.path === 'params.buyback.priceBps')).toBe(true);
  });

  it('required 字段显式 null 也算缺失', () => {
    const r = validateParams(schema, { minMembers: null, title: 'x', currency: 'aCoins' });
    expect(r.issues.some((i) => i.path === 'params.minMembers')).toBe(true);
  });
});

describe('Effect 白名单与条款校验', () => {
  const whitelist = ['walletTransfer', 'setState', 'notify'] as const;

  it('白名单外 Effect 拦截', () => {
    const issues: ValidationIssue[] = [];
    const spec: EffectSpecFree = { type: 'penalize', userId: 'u', currency: 'gameCoins', amount: 1, forfeitTo: 'treasury', reason: 'r' };
    validateEffectSpec(spec, [...whitelist], 'then[0]', issues);
    expect(issues.some((i) => i.message.includes('不在模板白名单'))).toBe(true);
  });

  it('表达式语法错误在部署时被 lint 拦截', () => {
    const badClause: Clause = {
      id: 'c1',
      title: '坏条件',
      on: { id: 't1', kind: 'manual', action: 'join' },
      when: 'size(state.members >=', // 语法错误
      then: [{ type: 'setState', to: 'active', reason: 'r' }],
    };
    const issues = validateClauses([badClause], [...whitelist]);
    expect(issues.some((i) => i.path.includes('when') && i.message.includes('语法错误'))).toBe(true);
  });

  it('trigger 类型字段缺失拦截', () => {
    const badClause: Clause = {
      id: 'c1',
      title: '缺 action',
      on: { id: 't1', kind: 'manual' } as Clause['on'],
      then: [{ type: 'notify', message: 'm', reason: '通知' }],
    };
    const issues = validateClauses([badClause], [...whitelist]);
    expect(issues.some((i) => i.message.includes('必须声明 action'))).toBe(true);
  });

  it('bps 越界与负数 amount 拦截', () => {
    const issues: ValidationIssue[] = [];
    validateEffectSpec(
      { type: 'walletTransfer', toUserId: 'u', currency: 'gameCoins', amount: -5, reason: 'r' },
      [...whitelist],
      'e1',
      issues,
    );
    expect(issues.some((i) => i.message.includes('不得为负'))).toBe(true);
  });
});

describe('validateTemplate', () => {
  const goodTemplate: ContractTemplate = {
    key: 'group-buy',
    family: 'teamup',
    version: 1,
    title: '拼团',
    riskLevel: 'low',
    requiresAudit: false,
    initialState: 'signing',
    effectsWhitelist: ['walletTransfer', 'setState', 'notify', 'splitPayout'],
    paramsSchema: { minMembers: { type: 'number', required: true, min: 2 } },
    clauses: [
      {
        id: 'join',
        title: '加入拼团',
        on: { id: 't-join', kind: 'manual', action: 'join' },
        when: 'state.memberCount < params.maxMembers',
        then: [
          { type: 'walletTransfer', toUserId: 'expr: event.userId', currency: 'gameCoins', amount: 'expr: params.groupPrice', reason: '入团托管' },
        ],
        updates: [{ field: 'memberCount', op: 'add', value: 1 }],
      },
    ],
  };

  it('合法模板通过', () => {
    const r = validateTemplate(goodTemplate);
    expect(r.issues).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('initialState 非法拦截', () => {
    const r = validateTemplate({ ...goodTemplate, initialState: 'running' as never });
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.path === 'initialState')).toBe(true);
  });

  it('空白名单 / 空条款拦截', () => {
    expect(validateTemplate({ ...goodTemplate, effectsWhitelist: [] }).ok).toBe(false);
    expect(validateTemplate({ ...goodTemplate, clauses: [] }).ok).toBe(false);
  });
});

describe('状态机迁移表', () => {
  it('合法迁移', () => {
    expect(isValidTransition('draft', 'signing')).toBe(true);
    expect(isValidTransition('signing', 'funded')).toBe(true);
    expect(isValidTransition('funded', 'active')).toBe(true);
    expect(isValidTransition('funded', 'refunded')).toBe(true);
    expect(isValidTransition('active', 'settling')).toBe(true);
    expect(isValidTransition('settling', 'fulfilled')).toBe(true);
    expect(isValidTransition('disputed', 'settling')).toBe(true);
    expect(isValidTransition('breached', 'terminated')).toBe(true);
  });

  it('非法迁移', () => {
    expect(isValidTransition('funded', 'draft')).toBe(false);
    expect(isValidTransition('fulfilled', 'active')).toBe(false);
    expect(isValidTransition('refunded', 'active')).toBe(false);
    expect(isValidTransition('terminated', 'active')).toBe(false);
    expect(isValidTransition('draft', 'active')).toBe(false); // 不可跳过签署
  });
});
