/**
 * 规范化序列化 + 规则指纹（codeHash）
 *
 * 规则公开固化的核心：
 * - canonicalize：对象键排序、数组保序、剔除 undefined、拒绝循环引用与非有限数
 *   → 同一逻辑内容必产出同一字符串，跨端可复算
 * - computeCodeHash：codeHash = sha256(canonical({templateKey, templateVersion, clauses, params}))
 *   固化面 = 模板 + 条款 + 参数；参与方变动与资金变动不进 codeHash（走事件哈希链存证）
 */
import { sha256hex } from './hash.js';
import type { Clause } from '../types.js';

export function canonicalize(value: unknown): string {
  return serialize(value, new Set(), '$');
}

function serialize(v: unknown, seen: Set<unknown>, path: string): string {
  if (v === null) return 'null';
  const t = typeof v;
  if (t === 'number') {
    if (!Number.isFinite(v)) {
      throw new TypeError(`canonicalize: 非有限数字 @ ${path}`);
    }
    return JSON.stringify(v);
  }
  if (t === 'boolean') return v ? 'true' : 'false';
  if (t === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) {
    if (seen.has(v)) throw new TypeError('canonicalize: 检测到循环引用');
    seen.add(v);
    const s = '[' + v.map((x, i) => serialize(x, seen, `${path}[${i}]`)).join(',') + ']';
    seen.delete(v);
    return s;
  }
  if (t === 'object') {
    if (seen.has(v)) throw new TypeError('canonicalize: 检测到循环引用');
    seen.add(v);
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    const s = '{' + keys.map((k) => JSON.stringify(k) + ':' + serialize(obj[k], seen, `${path}.${k}`)).join(',') + '}';
    seen.delete(v);
    return s;
  }
  throw new TypeError(`canonicalize: 不支持的类型 ${t} @ ${path}`);
}

export interface CodeHashInput {
  templateKey: string;
  templateVersion: number;
  clauses: Clause[];
  params: Record<string, unknown>;
}

/** 规则指纹：模板键 + 版本 + 条款 + 参数 的规范化哈希 */
export function computeCodeHash(input: CodeHashInput): string {
  return sha256hex(canonicalize(input));
}

/** 复算实例的 codeHash，与 instance.codeHash 比对即可自证未被篡改 */
export function verifyCodeHash(
  templateKey: string,
  templateVersion: number,
  clauses: Clause[],
  params: Record<string, unknown>,
  expected: string,
): { intact: boolean; recomputed: string } {
  const recomputed = computeCodeHash({ templateKey, templateVersion, clauses, params });
  return { intact: recomputed === expected, recomputed };
}
