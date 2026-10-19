/**
 * 规范化序列化 + codeHash 测试
 */
import { describe, it, expect } from 'vitest';
import { canonicalize, computeCodeHash, verifyCodeHash } from '../canonical.js';
import type { Clause } from '../../types.js';

describe('canonicalize', () => {
  it('对象键序无关', () => {
    expect(canonicalize({ a: 1, b: 2 })).toBe(canonicalize({ b: 2, a: 1 }));
  });

  it('嵌套结构与数组保序', () => {
    const a = { list: [{ y: 2, x: 1 }, 's'], n: null, ok: true };
    const b = { ok: true, n: null, list: [{ x: 1, y: 2 }, 's'] };
    expect(canonicalize(a)).toBe(canonicalize(b));
  });

  it('undefined 字段剔除（与 JSON.stringify 行为一致）', () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe(canonicalize({ a: 1 }));
  });

  it('中文与转义字符稳定', () => {
    expect(canonicalize({ msg: '你好"引号"\\反斜杠\n' })).toBe(canonicalize({ msg: '你好"引号"\\反斜杠\n' }));
  });

  it('循环引用报错', () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    expect(() => canonicalize(a)).toThrow(/循环引用/);
  });

  it('非有限数报错', () => {
    expect(() => canonicalize({ x: Infinity })).toThrow(/非有限/);
    expect(() => canonicalize({ x: NaN })).toThrow(/非有限/);
  });

  it('函数值报错', () => {
    expect(() => canonicalize({ f: () => 1 })).toThrow(/不支持的类型/);
  });
});

describe('computeCodeHash / verifyCodeHash', () => {
  const clause: Clause = {
    id: 'c1',
    title: '满员成团',
    on: { id: 't1', kind: 'manual', action: 'join' },
    when: 'size(state.members) >= params.minMembers',
    then: [{ type: 'setState', to: 'active', reason: '成团' }],
    updates: [{ field: 'members', op: 'add', value: 1 }],
  };

  it('相同内容稳定，参数变化即变', () => {
    const base = { templateKey: 'group-buy', templateVersion: 1, clauses: [clause], params: { minMembers: 3 } };
    const h1 = computeCodeHash(base);
    const h2 = computeCodeHash({ ...base, params: { minMembers: 3 } });
    const h3 = computeCodeHash({ ...base, params: { minMembers: 4 } });
    expect(h1).toBe(h2);
    expect(h1).not.toBe(h3);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('条款 when 改动即变（规则不可暗中篡改）', () => {
    const base = { templateKey: 'group-buy', templateVersion: 1, clauses: [clause], params: {} };
    const tampered: Clause = { ...clause, when: 'true' };
    expect(computeCodeHash(base)).not.toBe(
      computeCodeHash({ ...base, clauses: [tampered] }),
    );
  });

  it('verifyCodeHash 自证', () => {
    const input = { templateKey: 'group-buy', templateVersion: 1, clauses: [clause], params: { minMembers: 3 } };
    const expected = computeCodeHash(input);
    expect(verifyCodeHash(input.templateKey, 1, input.clauses, input.params, expected).intact).toBe(true);
    expect(verifyCodeHash(input.templateKey, 1, input.clauses, { minMembers: 9 }, expected).intact).toBe(false);
  });
});
