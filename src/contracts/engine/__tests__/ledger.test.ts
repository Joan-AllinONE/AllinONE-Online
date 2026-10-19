/**
 * 事件哈希链 + Merkle 根测试：追加 / 复算 / 篡改检测 / 断链检测
 */
import { describe, it, expect } from 'vitest';
import { appendEvent, verifyChain, computeEventHash, merkleRoot, GENESIS_HASH } from '../ledger.js';
import { sha256hex } from '../hash.js';
import type { ContractEvent } from '../../types.js';

function buildChain(n: number): ContractEvent[] {
  const events: ContractEvent[] = [];
  const actors = ['u1', 'u2', 'system'];
  for (let i = 0; i < n; i++) {
    events.push(
      appendEvent(events, {
        at: 1700000000000 + i * 1000,
        type: i % 2 === 0 ? 'trigger' : 'effect',
        actorId: actors[i % actors.length],
        payload: { seq: i, note: `事件${i}` },
      }),
    );
  }
  return events;
}

describe('appendEvent', () => {
  it('首事件 seq=0，prevHash=GENESIS', () => {
    const e = appendEvent([], { at: 1, type: 'deployed', actorId: 'u1', payload: { a: 1 } });
    expect(e.seq).toBe(0);
    expect(e.prevHash).toBe(GENESIS_HASH);
    expect(e.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('链式追加：seq 递增、prevHash 链接', () => {
    const chain = buildChain(5);
    for (let i = 1; i < chain.length; i++) {
      expect(chain[i].seq).toBe(i);
      expect(chain[i].prevHash).toBe(chain[i - 1].hash);
    }
  });

  it('纯函数：不修改入参数组', () => {
    const chain = buildChain(2);
    const len = chain.length;
    appendEvent(chain, { at: 1, type: 'note', actorId: 'u', payload: {} });
    expect(chain.length).toBe(len);
  });
});

describe('verifyChain', () => {
  it('合法链通过', () => {
    const r = verifyChain(buildChain(10));
    expect(r.intact).toBe(true);
    expect(r.length).toBe(10);
  });

  it('空链通过', () => {
    expect(verifyChain([]).intact).toBe(true);
  });

  it('篡改 payload → 断链检测', () => {
    const chain = buildChain(6);
    (chain[3].payload as Record<string, unknown>).note = '被篡改';
    const r = verifyChain(chain);
    expect(r.intact).toBe(false);
    expect(r.brokenAt).toBe(3);
  });

  it('篡改 hash → 断链检测', () => {
    const chain = buildChain(6);
    chain[2].hash = 'f'.repeat(64);
    const r = verifyChain(chain);
    expect(r.intact).toBe(false);
    // seq2 自身 hash 重算不匹配，最先暴露
    expect(r.brokenAt).toBe(2);
  });

  it('删除中间事件（seq 断档）→ 检测', () => {
    const chain = buildChain(6);
    chain.splice(2, 1);
    const r = verifyChain(chain);
    expect(r.intact).toBe(false);
  });

  it('重排事件 → 检测', () => {
    const chain = buildChain(6);
    const tmp = chain[1];
    chain[1] = chain[2];
    chain[2] = tmp;
    expect(verifyChain(chain).intact).toBe(false);
  });
});

describe('computeEventHash', () => {
  it('与手工复算一致（canonicalize 键按字母序）', () => {
    const body = { seq: 0, at: 123, type: 'deployed', actorId: 'u1', payload: { x: 1 } };
    const h = computeEventHash(body, GENESIS_HASH);
    // canonicalize 输出键按字母序：actorId < at < payload < seq < type
    const manual = '{"actorId":"u1","at":123,"payload":{"x":1},"seq":0,"type":"deployed"}';
    expect(h).toBe(sha256hex(GENESIS_HASH + '\u241f' + manual));
  });
});

describe('merkleRoot', () => {
  it('空 → GENESIS', () => {
    expect(merkleRoot([])).toBe(GENESIS_HASH);
  });

  it('单叶 = 自身', () => {
    const leaf = sha256hex('leaf');
    expect(merkleRoot([leaf])).toBe(leaf);
  });

  it('两叶 = sha256(a+b)', () => {
    const a = sha256hex('a');
    const b = sha256hex('b');
    expect(merkleRoot([a, b])).toBe(sha256hex(a + b));
  });

  it('三叶：奇数复制末叶', () => {
    const [a, b, c] = [sha256hex('a'), sha256hex('b'), sha256hex('c')];
    const expected = sha256hex(sha256hex(a + b) + sha256hex(c + c));
    expect(merkleRoot([a, b, c])).toBe(expected);
  });

  it('确定性：同样输入同根；乱序不同根', () => {
    const leaves = [sha256hex('x1'), sha256hex('x2'), sha256hex('x3'), sha256hex('x4')];
    expect(merkleRoot(leaves)).toBe(merkleRoot([...leaves]));
    expect(merkleRoot(leaves)).not.toBe(merkleRoot([...leaves].reverse()));
  });
});
