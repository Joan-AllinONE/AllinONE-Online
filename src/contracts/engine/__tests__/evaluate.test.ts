/**
 * 确定性表达式求值器测试
 * 覆盖：运算语义 / 变量与成员访问 / 白名单函数 / 确定性随机 /
 *       安全拒绝（注入/方法调用/危险属性） / 资源限制
 */
import { describe, it, expect } from 'vitest';
import { evaluateExpression, lintExpression } from '../evaluate.js';

const VARS = {
  state: { total: 100, members: ['u1', 'u2'], nested: { deep: { value: 7 } }, empty: null },
  params: { softCap: 500, minMembers: 3, ratio: 0.3 },
  event: { userId: 'u9', amount: 42, rows: [{ userId: 'a', amount: 10 }] },
  now: 1700000000000,
};

function ev(expr: string, extra: Record<string, unknown> = {}): unknown {
  return evaluateExpression(expr, { vars: { ...VARS, ...extra } });
}

describe('算术与优先级', () => {
  it.each([
    ['1 + 2 * 3', 7],
    ['(1 + 2) * 3', 9],
    ['10 % 3', 1],
    ['2 - 3 - 4', -5],
    ['-params.softCap', -500],
    ['params.softCap * params.ratio', 150],
  ])('%s = %s', (expr, want) => {
    expect(ev(expr)).toBe(want);
  });

  it('除 0 报错（账本禁 NaN）', () => {
    expect(() => ev('1 / 0')).toThrow(/除数为 0/);
    expect(() => ev('5 % 0')).toThrow(/模数为 0/);
  });

  it('字符串拼接：string + number', () => {
    expect(ev("'共' + 3 + '人'")).toBe('共3人');
  });

  it('数字与对象相加报错', () => {
    expect(() => ev('1 + state.members')).toThrow(/\+/);
  });
});

describe('比较 / 逻辑 / 三元', () => {
  it.each([
    ['3 > 2 && 1 <= 1', true],
    ['params.softCap >= 500 || false', true],
    ['!false', true],
    ['1 != 2', true],
    ['1 == 1', true],
    ['params.minMembers > size(state.members) ? "未满" : "已满"', '未满'],
    ['true ? 1 : 2', 1],
    ['false ? 1 : 2', 2],
  ])('%s', (expr, want) => {
    expect(ev(expr)).toBe(want);
  });

  it('严格相等：跨类型恒 false', () => {
    expect(ev("1 == '1'")).toBe(false);
    expect(ev("0 == ''")).toBe(false);
    expect(ev("'1' == '1'")).toBe(true);
    expect(ev('null == null')).toBe(true);
    expect(ev('state.empty == null')).toBe(true);
  });

  it('&& 短路返回右值', () => {
    expect(ev('true && 5')).toBe(5);
    expect(ev('false && 5')).toBe(false);
  });
});

describe('变量与成员访问', () => {
  it('嵌套成员', () => {
    expect(ev('state.nested.deep.value')).toBe(7);
  });

  it('数组索引', () => {
    expect(ev('state.members[0]')).toBe('u1');
    expect(ev('event.rows[0].amount')).toBe(10);
    expect(ev('state.members[9]')).toBe(null); // 越界 → null
  });

  it('null 安全导航', () => {
    expect(ev('state.empty.deep.deeper')).toBe(null);
  });

  it('未知变量报错', () => {
    expect(() => ev('unknownVar')).toThrow(ReferenceError);
    // Date.now()：Date 是未知变量且 member 后跟 '(' 属禁止方法调用 —— 两种拒绝都可接受
    expect(() => ev('Date.now()')).toThrow(/未知函数|未知变量|方法调用/);
    // Math.random()：在 parser 层即被「禁止方法调用」拦截（比变量解析更早）
    expect(() => ev('Math.random()')).toThrow(/未知变量|方法调用/);
  });
});

describe('白名单函数', () => {
  it.each([
    ['min(3, 1, 2)', 1],
    ['max(3, 1, 2)', 3],
    ['floor(1.9)', 1],
    ['ceil(1.1)', 2],
    ['abs(0 - 5)', 5],
    ['round(2.567, 2)', 2.57],
    ['clamp(10, 1, 3)', 3],
    ['clamp(0, 1, 3)', 1],
    ['sum([1, 2, 3])', 6],
    ['size(state.members)', 2],
    ['size("hello")', 5],
  ])('%s', (expr, want) => {
    expect(ev(expr)).toBe(want);
  });

  it('函数参数类型校验', () => {
    expect(() => ev('floor("x")')).toThrow(TypeError);
    expect(() => ev('min()')).toThrow(TypeError);
    expect(() => ev('sum(3)')).toThrow(TypeError);
  });

  it('rand：同 seed 确定一致，不同 i 不同', () => {
    const r1 = evaluateExpression('rand(0)', { seed: 'seed-a' });
    const r2 = evaluateExpression('rand(0)', { seed: 'seed-a' });
    const r3 = evaluateExpression('rand(1)', { seed: 'seed-a' });
    const r4 = evaluateExpression('rand(0)', { seed: 'seed-b' });
    expect(r1).toBe(r2);
    expect(r1).not.toBe(r3);
    expect(r1).not.toBe(r4);
    expect(typeof r1).toBe('number');
    expect(r1 as number).toBeGreaterThanOrEqual(0);
    expect(r1 as number).toBeLessThan(1);
  });

  it('rand 无 seed 报错', () => {
    expect(() => ev('rand(0)')).toThrow(/seed/);
  });
});

describe('安全拒绝', () => {
  it('禁方法调用', () => {
    // 字符串字面量后的 .method( 在 primary 之外 → 多余内容；ident 后 .method( → 明确的方法调用拒绝
    expect(() => ev("'abc'.toUpperCase()")).toThrow(/方法调用|未知函数|多余内容/);
    expect(() => ev('state.members.map(1)')).toThrow(/方法调用|未知函数|意外/);
  });

  it('禁危险属性', () => {
    expect(() => ev('state.__proto__')).toThrow(/__proto__|属性/);
    expect(() => ev('state.constructor')).toThrow(/constructor|属性/);
  });

  it('禁赋值 / 禁对象字面量 / 禁 this', () => {
    expect(() => ev('x = 1')).toThrow(SyntaxError);
    expect(() => ev('{ a: 1 }')).toThrow(SyntaxError);
    expect(() => ev('this')).toThrow(ReferenceError);
  });

  it('未知函数报错并列出白名单', () => {
    expect(() => ev('eval(1)')).toThrow(/未知函数/);
    expect(() => ev('Function("x")')).toThrow(/未知函数/);
  });
});

describe('资源限制', () => {
  it('token 超限', () => {
    const long = '1 + '.repeat(600) + '1';
    expect(() => ev(long)).toThrow(SyntaxError);
  });

  it('嵌套深度超限', () => {
    const deep = '('.repeat(80) + '1' + ')'.repeat(80);
    expect(() => ev(deep)).toThrow(SyntaxError);
  });

  it('求值步数超限', () => {
    const wide = '[' + '1,'.repeat(3000) + '1]';
    expect(() => evaluateExpression(wide, { vars: {}, maxSteps: 100 })).toThrow(/步数超限|过长/);
  });

  it('未闭合输入报错', () => {
    expect(() => ev('(1 + 2')).toThrow(SyntaxError);
    expect(() => ev("'abc")).toThrow(SyntaxError);
  });
});

describe('lintExpression', () => {
  it('合法表达式通过', () => {
    expect(lintExpression('size(state.members) >= params.minMembers').ok).toBe(true);
  });
  it('非法表达式拦截', () => {
    const r = lintExpression('a.b()');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeTruthy();
  });
});
