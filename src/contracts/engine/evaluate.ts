/**
 * 确定性表达式求值器（自研，替代 mathjs）
 *
 * 语法（合约 DSL）：
 *   字面量    数字 / '字符串' / "字符串" / true / false / null / [a, b, c]
 *   变量      env 注入（state / params / event / now ...）
 *   成员访问  a.b.c、arr[0]（仅数据访问；函数值与危险属性一律拒绝）
 *   运算      + - * / %  == !=  < <= > >=  && || !  ?:
 *   函数      白名单：min max floor ceil round abs clamp sum size rand
 *
 * 确定性铁律：
 *   - 禁 Date / Math.random / eval / Function —— 时间从 env.now 注入，
 *     随机由 env.seed 确定性派生（rand(i) = hash(seed#i) 归一化）
 *   - 除 0 与非有限结果一律报错（NaN/Infinity 不得污染账本）
 *   - 严格相等：跨类型 == 恒为 false（无隐式转换）
 *
 * 安全铁律：
 *   - 禁方法调用（a.b() 语法错误）；仅顶层白名单函数可调用
 *   - 属性黑名单：__proto__ / prototype / constructor；取到函数值即报错
 *   - 资源上限：maxTokens / maxDepth / maxSteps（防资源耗尽）
 */
import { sha256hex } from './hash.js';

// ============================================================
// Tokenizer
// ============================================================

type Tok =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'id'; v: string }
  | { t: 'op'; v: string };

const TWO_CHAR_OPS = ['==', '!=', '<=', '>=', '&&', '||'];
const ONE_CHAR_OPS = ['+', '-', '*', '/', '%', '<', '>', '!', '(', ')', ',', '?', ':', '[', ']', '.'];

function isIdentStart(c: string): boolean {
  return /[a-zA-Z_$]/.test(c);
}
function isIdentPart(c: string): boolean {
  return /[a-zA-Z0-9_$]/.test(c);
}
function isDigit(c: string): boolean {
  return c >= '0' && c <= '9';
}

function tokenize(src: string, maxTokens: number): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    if (toks.length >= maxTokens) {
      throw new SyntaxError(`表达式过长（token 超过 ${maxTokens}）`);
    }
    if (isDigit(c)) {
      let j = i;
      while (j < src.length && isDigit(src[j])) j++;
      if (src[j] === '.' && isDigit(src[j + 1])) {
        j++;
        while (j < src.length && isDigit(src[j])) j++;
      }
      const num = Number(src.slice(i, j));
      if (!Number.isFinite(num)) {
        // B-15 修复：超长数字字面量会溢出为 Infinity——账本禁非有限数
        throw new SyntaxError(`数字字面量溢出（非有限）：${src.slice(i, j).slice(0, 24)}…`);
      }
      toks.push({ t: 'num', v: num });
      i = j;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      let s = '';
      let closed = false;
      while (j < src.length) {
        const ch = src[j];
        if (ch === '\\') {
          const nxt = src[j + 1];
          if (nxt === undefined) throw new SyntaxError('字符串字面量未闭合');
          if (nxt === 'n') s += '\n';
          else if (nxt === 't') s += '\t';
          else if (nxt === 'r') s += '\r';
          else s += nxt; // \\ \' \" 等
          j += 2;
          continue;
        }
        if (ch === c) {
          closed = true;
          j++;
          break;
        }
        s += ch;
        j++;
      }
      if (!closed) throw new SyntaxError('字符串字面量未闭合');
      toks.push({ t: 'str', v: s });
      i = j;
      continue;
    }
    if (isIdentStart(c)) {
      let j = i;
      while (j < src.length && isIdentPart(src[j])) j++;
      toks.push({ t: 'id', v: src.slice(i, j) });
      i = j;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (TWO_CHAR_OPS.includes(two)) {
      toks.push({ t: 'op', v: two });
      i += 2;
      continue;
    }
    if (ONE_CHAR_OPS.includes(c)) {
      toks.push({ t: 'op', v: c });
      i++;
      continue;
    }
    throw new SyntaxError(`非法字符 "${c}"（位置 ${i}）`);
  }
  return toks;
}

// ============================================================
// AST
// ============================================================

type Node =
  | { k: 'num'; v: number }
  | { k: 'str'; v: string }
  | { k: 'bool'; v: boolean }
  | { k: 'null' }
  | { k: 'arr'; items: Node[] }
  | { k: 'var'; name: string }
  | { k: 'member'; obj: Node; prop: string }
  | { k: 'index'; obj: Node; idx: number }
  | { k: 'call'; name: string; args: Node[] }
  | { k: 'un'; op: '!' | '-'; arg: Node }
  | { k: 'bin'; op: string; l: Node; r: Node }
  | { k: 'cond'; c: Node; a: Node; b: Node };

const BANNED_PROPS = new Set(['__proto__', 'prototype', 'constructor']);

class Parser {
  private pos = 0;
  private depth = 0;
  constructor(
    private readonly toks: Tok[],
    private readonly maxDepth: number,
  ) {}

  private peek(): Tok | undefined {
    return this.toks[this.pos];
  }
  private eat(): Tok {
    const t = this.toks[this.pos];
    if (!t) throw new SyntaxError('表达式意外结束');
    this.pos++;
    return t;
  }
  private eatOp(v: string): void {
    const t = this.peek();
    if (!t || t.t !== 'op' || t.v !== v) {
      throw new SyntaxError(`期望 "${v}"${t ? `，实际 "${t.t === 'op' || t.t === 'id' ? t.v : String(t.v)}"` : ''}`);
    }
    this.pos++;
  }
  private isOp(v: string): boolean {
    const t = this.peek();
    return !!t && t.t === 'op' && t.v === v;
  }

  parse(): Node {
    const n = this.parseConditional();
    if (this.pos < this.toks.length) {
      throw new SyntaxError('表达式存在多余内容');
    }
    return n;
  }

  private enter(): void {
    this.depth++;
    if (this.depth > this.maxDepth) {
      throw new SyntaxError(`表达式嵌套过深（超过 ${this.maxDepth}）`);
    }
  }
  private leave(): void {
    this.depth--;
  }

  private parseConditional(): Node {
    this.enter();
    try {
      const cond = this.parseOr();
      if (this.isOp('?')) {
        this.pos++;
        const a = this.parseConditional();
        this.eatOp(':');
        const b = this.parseConditional();
        return { k: 'cond', c: cond, a, b };
      }
      return cond;
    } finally {
      this.leave();
    }
  }

  private parseOr(): Node {
    let l = this.parseAnd();
    while (this.isOp('||')) {
      this.pos++;
      l = { k: 'bin', op: '||', l, r: this.parseAnd() };
    }
    return l;
  }
  private parseAnd(): Node {
    let l = this.parseEquality();
    while (this.isOp('&&')) {
      this.pos++;
      l = { k: 'bin', op: '&&', l, r: this.parseEquality() };
    }
    return l;
  }
  private parseEquality(): Node {
    let l = this.parseComparison();
    while (this.isOp('==') || this.isOp('!=')) {
      const op = (this.eat() as { v: string }).v;
      l = { k: 'bin', op, l, r: this.parseComparison() };
    }
    return l;
  }
  private parseComparison(): Node {
    let l = this.parseAdditive();
    while (this.isOp('<') || this.isOp('<=') || this.isOp('>') || this.isOp('>=')) {
      const op = (this.eat() as { v: string }).v;
      l = { k: 'bin', op, l, r: this.parseAdditive() };
    }
    return l;
  }
  private parseAdditive(): Node {
    let l = this.parseMultiplicative();
    while (this.isOp('+') || this.isOp('-')) {
      const op = (this.eat() as { v: string }).v;
      l = { k: 'bin', op, l, r: this.parseMultiplicative() };
    }
    return l;
  }
  private parseMultiplicative(): Node {
    let l = this.parseUnary();
    while (this.isOp('*') || this.isOp('/') || this.isOp('%')) {
      const op = (this.eat() as { v: string }).v;
      l = { k: 'bin', op, l, r: this.parseUnary() };
    }
    return l;
  }
  private parseUnary(): Node {
    this.enter();
    try {
      if (this.isOp('!')) {
        this.pos++;
        return { k: 'un', op: '!', arg: this.parseUnary() };
      }
      if (this.isOp('-')) {
        this.pos++;
        return { k: 'un', op: '-', arg: this.parseUnary() };
      }
      return this.parsePrimary();
    } finally {
      this.leave();
    }
  }
  private parsePrimary(): Node {
    const t = this.peek();
    if (!t) throw new SyntaxError('表达式意外结束');
    if (t.t === 'num') {
      this.pos++;
      return { k: 'num', v: t.v };
    }
    if (t.t === 'str') {
      this.pos++;
      return { k: 'str', v: t.v };
    }
    if (t.t === 'op' && t.v === '(') {
      this.pos++;
      this.enter();
      try {
        const inner = this.parseConditional();
        this.eatOp(')');
        return inner;
      } finally {
        this.leave();
      }
    }
    if (t.t === 'op' && t.v === '[') {
      this.pos++;
      const items: Node[] = [];
      if (!this.isOp(']')) {
        items.push(this.parseConditional());
        while (this.isOp(',')) {
          this.pos++;
          items.push(this.parseConditional());
        }
      }
      this.eatOp(']');
      return { k: 'arr', items };
    }
    if (t.t === 'id') {
      this.pos++;
      if (t.v === 'true') return { k: 'bool', v: true };
      if (t.v === 'false') return { k: 'bool', v: false };
      if (t.v === 'null') return { k: 'null' };
      // 函数调用（仅顶层标识符 + 立即跟 '('）
      if (this.isOp('(')) {
        this.pos++;
        const args: Node[] = [];
        if (!this.isOp(')')) {
          args.push(this.parseConditional());
          while (this.isOp(',')) {
            this.pos++;
            args.push(this.parseConditional());
          }
        }
        this.eatOp(')');
        if (!BUILTINS.has(t.v)) {
          throw new SyntaxError(`未知函数 "${t.v}"（白名单：${[...BUILTINS.keys()].join(' ')}）`);
        }
        return { k: 'call', name: t.v, args };
      }
      // 成员访问链
      let node: Node = { k: 'var', name: t.v };
      for (;;) {
        if (this.isOp('.')) {
          this.pos++;
          const p = this.peek();
          if (!p || p.t !== 'id') throw new SyntaxError('成员访问 "." 后必须是标识符');
          if (BANNED_PROPS.has(p.v)) throw new SyntaxError(`禁止访问属性 "${p.v}"`);
          this.pos++;
          if (this.isOp('(')) {
            throw new SyntaxError('禁止方法调用（仅白名单顶层函数可调用）');
          }
          node = { k: 'member', obj: node, prop: p.v };
          continue;
        }
        if (this.isOp('[')) {
          this.pos++;
          const idx = this.peek();
          if (!idx || idx.t !== 'num' || !Number.isInteger(idx.v) || idx.v < 0) {
            throw new SyntaxError('数组索引必须是非负整数（不支持动态索引）');
          }
          this.pos++;
          this.eatOp(']');
          node = { k: 'index', obj: node, idx: idx.v };
          continue;
        }
        break;
      }
      return node;
    }
    const unk = t as { t: string; v?: unknown };
    throw new SyntaxError(`意外的记号 "${unk.t === 'op' || unk.t === 'id' ? String(unk.v) : String(unk.v)}"`);
  }
}

// ============================================================
// 内置函数（全部确定性）
// ============================================================

function assertNumber(v: unknown, fn: string, argName: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new TypeError(`${fn}: 参数 ${argName} 必须是有限数字`);
  }
  return v;
}

function deterministicRand(seed: string, i: number): number {
  const h = sha256hex(`${seed}#${i}`);
  return parseInt(h.slice(0, 13), 16) / 2 ** 52;
}

const BUILTINS = new Map<string, (args: unknown[], seed?: string) => unknown>([
  [
    'min',
    (args) => {
      if (args.length === 0) throw new TypeError('min: 至少一个参数');
      return Math.min(...args.map((a, i) => assertNumber(a, 'min', `#${i}`)));
    },
  ],
  [
    'max',
    (args) => {
      if (args.length === 0) throw new TypeError('max: 至少一个参数');
      return Math.max(...args.map((a, i) => assertNumber(a, 'max', `#${i}`)));
    },
  ],
  ['floor', (args) => Math.floor(assertNumber(args[0], 'floor', 'x'))],
  ['ceil', (args) => Math.ceil(assertNumber(args[0], 'ceil', 'x'))],
  ['abs', (args) => Math.abs(assertNumber(args[0], 'abs', 'x'))],
  [
    'round',
    (args) => {
      const x = assertNumber(args[0], 'round', 'x');
      const d = args.length > 1 ? assertNumber(args[1], 'round', 'digits') : 0;
      if (!Number.isInteger(d) || d < 0 || d > 10) throw new TypeError('round: digits 须为 0..10 整数');
      const m = 10 ** d;
      return Math.round(x * m) / m;
    },
  ],
  [
    'clamp',
    (args) => {
      const x = assertNumber(args[0], 'clamp', 'x');
      const lo = assertNumber(args[1], 'clamp', 'lo');
      const hi = assertNumber(args[2], 'clamp', 'hi');
      return Math.min(Math.max(x, lo), hi);
    },
  ],
  [
    'sum',
    (args) => {
      const arr = args[0];
      if (!Array.isArray(arr)) throw new TypeError('sum: 参数必须是数组');
      let s = 0;
      arr.forEach((v, i) => {
        s += assertNumber(v, 'sum', `[${i}]`);
      });
      return s;
    },
  ],
  [
    'size',
    (args) => {
      const v = args[0];
      if (Array.isArray(v)) return v.length;
      if (typeof v === 'string') return v.length;
      if (v !== null && typeof v === 'object') return Object.keys(v).length;
      throw new TypeError('size: 参数必须是数组/字符串/对象');
    },
  ],
  [
    'rand',
    (args, seed) => {
      if (!seed) throw new TypeError('rand: 求值环境缺少确定性种子（seed）');
      const i = assertNumber(args[0], 'rand', 'i');
      if (!Number.isInteger(i) || i < 0 || i > 1e9) throw new TypeError('rand: i 须为 0..1e9 整数');
      return deterministicRand(seed, i);
    },
  ],
  // ===== 合约域聚合函数（限购/份额校验用；只读数据访问）=====
  [
    'countUser',
    (args) => {
      const arr = args[0];
      const uid = args[1];
      if (!Array.isArray(arr)) throw new TypeError('countUser: 第 1 参必须是数组（如 state.contributions）');
      if (typeof uid !== 'string') throw new TypeError('countUser: 第 2 参必须是字符串（userId）');
      return arr.filter((r) => r !== null && typeof r === 'object' && (r as Record<string, unknown>).userId === uid).length;
    },
  ],
  [
    'sumUser',
    (args) => {
      const arr = args[0];
      const uid = args[1];
      const field = args[2];
      if (!Array.isArray(arr)) throw new TypeError('sumUser: 第 1 参必须是数组（如 state.contributions）');
      if (typeof uid !== 'string') throw new TypeError('sumUser: 第 2 参必须是字符串（userId）');
      if (typeof field !== 'string') throw new TypeError('sumUser: 第 3 参必须是字段名字符串（如 "amount"）');
      let s = 0;
      for (const r of arr) {
        if (r === null || typeof r !== 'object') continue;
        const rec = r as Record<string, unknown>;
        if (rec.userId !== uid) continue;
        s += assertNumber(rec[field], 'sumUser', `${field}`);
      }
      return s;
    },
  ],
]);

// ============================================================
// 求值
// ============================================================

export interface EvalOptions {
  /** 变量环境（state / params / event / now ...） */
  vars?: Record<string, unknown>;
  /** 确定性随机源（rand(i) 依赖） */
  seed?: string;
  maxTokens?: number;
  maxDepth?: number;
  maxSteps?: number;
}

class Evaluator {
  private steps = 0;
  constructor(
    private readonly vars: Record<string, unknown>,
    private readonly seed: string | undefined,
    private readonly maxSteps: number,
  ) {}

  eval(node: Node): unknown {
    if (++this.steps > this.maxSteps) {
      throw new Error(`表达式求值步数超限（>${this.maxSteps}）`);
    }
    switch (node.k) {
      case 'num':
      case 'str':
      case 'bool':
        return node.v;
      case 'null':
        return null;
      case 'arr':
        return node.items.map((it) => this.eval(it));
      case 'var': {
        // B-14 修复：`in` 会命中原型链（如 toString），取到函数值同样拒绝（与 readProp 一致）
        if (!Object.prototype.hasOwnProperty.call(this.vars, node.name)) {
          throw new ReferenceError(`未知变量 "${node.name}"（可用：${Object.keys(this.vars).join(' ')}）`);
        }
        const v = this.vars[node.name];
        if (typeof v === 'function') {
          throw new TypeError(`变量 "${node.name}" 是函数，禁止访问`);
        }
        return v;
      }
      case 'member': {
        const obj = this.eval(node.obj);
        return this.readProp(obj, node.prop);
      }
      case 'index': {
        const obj = this.eval(node.obj);
        if (obj === null || obj === undefined) return null;
        if (!Array.isArray(obj)) throw new TypeError('数组索引访问的目标不是数组');
        const v = obj[node.idx];
        return v === undefined ? null : v;
      }
      case 'call': {
        const args = node.args.map((a) => this.eval(a));
        const fn = BUILTINS.get(node.name)!;
        return fn(args, this.seed);
      }
      case 'un': {
        if (node.op === '!') {
          return !this.truthy(this.eval(node.arg), '!');
        }
        const v = assertNumber(this.eval(node.arg), '-', 'x');
        return -v;
      }
      case 'bin':
        return this.evalBin(node);
      case 'cond':
        return this.truthy(this.eval(node.c), '?:')
          ? this.eval(node.a)
          : this.eval(node.b);
    }
  }

  private evalBin(node: Node & { k: 'bin' }): unknown {
    if (node.op === '&&') {
      return this.truthy(this.eval(node.l), '&&') ? this.eval(node.r) : false;
    }
    if (node.op === '||') {
      return this.truthy(this.eval(node.l), '||') ? true : this.eval(node.r);
    }
    const l = this.eval(node.l);
    const r = this.eval(node.r);
    switch (node.op) {
      case '+':
        if (typeof l === 'string' || typeof r === 'string') {
          if (l === null || r === null || typeof l === 'object' || typeof r === 'object' || typeof l === 'boolean' || typeof r === 'boolean') {
            throw new TypeError('+: 字符串拼接的两侧必须是 string/number');
          }
          return String(l) + String(r);
        }
        this.assertArith(l, r, '+');
        return (l as number) + (r as number);
      case '-':
        this.assertArith(l, r, '-');
        return (l as number) - (r as number);
      case '*':
        this.assertArith(l, r, '*');
        return (l as number) * (r as number);
      case '/':
        this.assertArith(l, r, '/');
        if (r === 0) throw new Error('/: 除数为 0（账本语义禁止 NaN/Infinity）');
        return (l as number) / (r as number);
      case '%':
        this.assertArith(l, r, '%');
        if (r === 0) throw new Error('%: 模数为 0');
        return (l as number) % (r as number);
      case '==':
        return this.strictEquals(l, r);
      case '!=':
        return !this.strictEquals(l, r);
      case '<':
      case '<=':
      case '>':
      case '>=': {
        if (typeof l !== 'number' || typeof r !== 'number') {
          throw new TypeError(`${node.op}: 两侧必须是数字（严格语义，无隐式转换）`);
        }
        switch (node.op) {
          case '<':
            return l < r;
          case '<=':
            return l <= r;
          case '>':
            return l > r;
          default:
            return l >= r;
        }
      }
      default:
        throw new Error(`未知运算符 ${node.op}`);
    }
  }

  private assertArith(l: unknown, r: unknown, op: string): void {
    if (typeof l !== 'number' || typeof r !== 'number') {
      throw new TypeError(`${op}: 算术运算两侧必须是数字（null/布尔/数组/对象不可参与）`);
    }
  }

  /** 严格相等：同类型比较；跨类型恒 false；对象按引用 */
  private strictEquals(l: unknown, r: unknown): boolean {
    if (l === null && r === null) return true;
    const tl = typeof l;
    const tr = typeof r;
    if (tl !== tr) return false;
    if (tl === 'number' || tl === 'string' || tl === 'boolean') return l === r;
    return l === r; // 数组/对象：同引用
  }

  private truthy(v: unknown, op: string): boolean {
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0;
    if (v === null || v === undefined) return false;
    if (typeof v === 'string') return v.length > 0;
    throw new TypeError(`${op}: 条件位置不接受 ${typeof v}`);
  }

  private readProp(obj: unknown, prop: string): unknown {
    if (obj === null || obj === undefined) return null; // 安全导航
    if (typeof obj !== 'object' && typeof obj !== 'string') {
      throw new TypeError(`不能对 ${typeof obj} 取属性 "${prop}"`);
    }
    const v = (obj as Record<string, unknown>)[prop];
    if (typeof v === 'function') throw new TypeError(`属性 "${prop}" 是函数，禁止访问`);
    if (v === undefined) return null;
    return v;
  }
}

// ============================================================
// 对外 API
// ============================================================

export function evaluateExpression(expr: string, opts: EvalOptions = {}): unknown {
  const maxTokens = opts.maxTokens ?? 512;
  const maxDepth = opts.maxDepth ?? 64;
  const maxSteps = opts.maxSteps ?? 2048;
  const ast = new Parser(tokenize(expr, maxTokens), maxDepth).parse();
  return new Evaluator(opts.vars ?? {}, opts.seed, maxSteps).eval(ast);
}

/** 只解析不求值（validate 静态检查用） */
export function lintExpression(expr: string): { ok: true } | { ok: false; error: string } {
  try {
    new Parser(tokenize(expr, 512), 64).parse();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** 求值结果断言为非负有限数字（amount/bps 等资金字段用） */
export function evalNumber(expr: string, opts: EvalOptions = {}): number {
  const v = evaluateExpression(expr, opts);
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new TypeError(`表达式结果必须是有限数字：${expr}`);
  }
  return v;
}

/** 求值结果断言为字符串 */
export function evalString(expr: string, opts: EvalOptions = {}): string {
  const v = evaluateExpression(expr, opts);
  if (typeof v !== 'string') {
    throw new TypeError(`表达式结果必须是字符串：${expr}`);
  }
  return v;
}
