/**
 * SHA-256 纯实现测试：与 Node crypto 对拍 + 标准向量
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { sha256hex } from '../hash.js';

function nodeSha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

describe('sha256hex 标准向量', () => {
  it('空串', () => {
    expect(sha256hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
  it('abc', () => {
    expect(sha256hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('sha256hex 与 Node crypto 对拍', () => {
  const samples = [
    'a',
    'hello world',
    'The quick brown fox jumps over the lazy dog',
    '你好，世界',
    '🎉🎮 emoji 输入',
    'a'.repeat(55), // 边界：+8+1 恰好 64
    'a'.repeat(56), // 边界：跨块
    'a'.repeat(63),
    'a'.repeat(64),
    'a'.repeat(65),
    'a'.repeat(1000),
    JSON.stringify({ b: 2, a: [1, 2, 3], c: 'x' }),
  ];
  samples.forEach((s) => {
    it(`对拍（len=${s.length}）`, () => {
      expect(sha256hex(s)).toBe(nodeSha256(s));
    });
  });
  it('Uint8Array 输入与字符串一致', () => {
    const bytes = Uint8Array.from([0x61, 0x62, 0x63]);
    expect(sha256hex(bytes)).toBe(sha256hex('abc'));
  });
});
