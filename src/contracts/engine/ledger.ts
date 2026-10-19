/**
 * 事件哈希链 + Merkle 根（纯函数）
 *
 * - 事件链：hash = sha256(prevHash + ␟ + canonical(body))，只追加、防篡改、可复算
 * - Merkle：日结/锚定用（B6），叶子为事件 hash
 */
import { sha256hex } from './hash.js';
import { canonicalize } from './canonical.js';
import type { ContractEvent } from '../types.js';

export const GENESIS_HASH = '0'.repeat(64);

/** 事件体（不含 hash/prevHash 的部分） */
export interface EventBody {
  seq: number;
  at: number;
  type: string;
  actorId: string;
  payload: Record<string, unknown>;
}

export function computeEventHash(body: EventBody, prevHash: string): string {
  return sha256hex(prevHash + '\u241f' + canonicalize(body));
}

/** 在事件链末尾追加一个事件（纯函数：返回新事件，不修改入参） */
export function appendEvent(history: ContractEvent[], body: Omit<EventBody, 'seq'>): ContractEvent {
  const last = history[history.length - 1];
  const seq = last ? last.seq + 1 : 0;
  const prevHash = last ? last.hash : GENESIS_HASH;
  const full: EventBody = { seq, ...body };
  return {
    ...full,
    prevHash,
    hash: computeEventHash(full, prevHash),
  };
}

export interface ChainVerifyResult {
  intact: boolean;
  /** 首个断点 seq（intact=false 时给出） */
  brokenAt?: number;
  length: number;
}

/** 全链复算：seq 连续 + prevHash 链接 + 每个事件 hash 可复算 */
export function verifyChain(events: ContractEvent[]): ChainVerifyResult {
  let prev = GENESIS_HASH;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.seq !== i) {
      return { intact: false, brokenAt: e.seq, length: events.length };
    }
    if (e.prevHash !== prev) {
      return { intact: false, brokenAt: e.seq, length: events.length };
    }
    const recomputed = computeEventHash(
      { seq: e.seq, at: e.at, type: e.type, actorId: e.actorId, payload: e.payload },
      e.prevHash,
    );
    if (recomputed !== e.hash) {
      return { intact: false, brokenAt: e.seq, length: events.length };
    }
    prev = e.hash;
  }
  return { intact: true, length: events.length };
}

/** Merkle 根：空 → GENESIS；奇数层复制末叶；内部节点 = sha256(a + b) */
export function merkleRoot(hashes: string[]): string {
  if (hashes.length === 0) return GENESIS_HASH;
  let level = hashes.slice();
  while (level.length > 1) {
    if (level.length % 2 === 1) level.push(level[level.length - 1]);
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(sha256hex(level[i] + level[i + 1]));
    }
    level = next;
  }
  return level[0];
}
