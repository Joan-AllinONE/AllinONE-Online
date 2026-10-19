/**
 * 私域合约（whitelist）门禁与可见性单测（2026-10-10）
 * 被测：contractTunnel.ts 导出的两个纯函数——
 *   isEntryBlockedByWhitelist：进入类动作（join/subscribe）门禁
 *   isHiddenFromViewer：大厅列表可见性过滤
 * 铁律：纯函数不依赖 DB/网络，直接模块级 import。
 */
import { describe, expect, it } from 'vitest';
// eslint-disable-next-line import/order
import { isEntryBlockedByWhitelist, isHiddenFromViewer } from '../../server/routes/contractTunnel.js';

describe('isEntryBlockedByWhitelist（私域进入门禁）', () => {
  const WL = ['test-001', 'test-002', '小明'];

  it('公开合约（名单缺省/空/非数组）永不拦截', () => {
    expect(isEntryBlockedByWhitelist(undefined, '任何人', 'issuer')).toBe(false);
    expect(isEntryBlockedByWhitelist(null, '任何人', 'issuer')).toBe(false);
    expect(isEntryBlockedByWhitelist([], '任何人', 'issuer')).toBe(false);
  });

  it('名单内成员不拦截', () => {
    expect(isEntryBlockedByWhitelist(WL, 'test-001', 'issuer')).toBe(false);
    expect(isEntryBlockedByWhitelist(WL, 'test-002', 'issuer')).toBe(false);
    expect(isEntryBlockedByWhitelist(WL, '小明', 'issuer')).toBe(false);
  });

  it('名单外成员拦截', () => {
    expect(isEntryBlockedByWhitelist(WL, 'admin', 'issuer')).toBe(true);
    expect(isEntryBlockedByWhitelist(WL, 'random-user', 'issuer')).toBe(true);
  });

  it('发起人豁免（即使不在名单内，团长开团依赖此规则）', () => {
    expect(isEntryBlockedByWhitelist(WL, 'issuer', 'issuer')).toBe(false);
  });

  it('未登录一律拦截（无法核验身份）', () => {
    expect(isEntryBlockedByWhitelist(WL, null, 'issuer')).toBe(true);
    expect(isEntryBlockedByWhitelist(WL, undefined, 'issuer')).toBe(true);
  });

  it('ID 精确匹配（大小写敏感，防大小写变体绕过）', () => {
    expect(isEntryBlockedByWhitelist(WL, 'TEST-001', 'issuer')).toBe(true);
    expect(isEntryBlockedByWhitelist(WL, 'test-1', 'issuer')).toBe(true);
  });
});

describe('isHiddenFromViewer（大厅可见性）', () => {
  const WL = ['test-001', 'test-002'];

  it('公开合约对所有人可见', () => {
    expect(isHiddenFromViewer(undefined, null, 'issuer')).toBe(false);
    expect(isHiddenFromViewer([], 'random', 'issuer')).toBe(false);
  });

  it('私域合约对名单外与匿名在大厅隐藏', () => {
    expect(isHiddenFromViewer(WL, 'random', 'issuer')).toBe(true);
    expect(isHiddenFromViewer(WL, null, 'issuer')).toBe(true);
    expect(isHiddenFromViewer(WL, undefined, 'issuer')).toBe(true);
  });

  it('名单内成员与发起人可见', () => {
    expect(isHiddenFromViewer(WL, 'test-001', 'issuer')).toBe(false);
    expect(isHiddenFromViewer(WL, 'issuer', 'issuer')).toBe(false);
  });

  it('平台角色（admin/platform）豁免可见（平台监督）', () => {
    expect(isHiddenFromViewer(WL, 'admin-id', 'issuer', 'admin')).toBe(false);
    expect(isHiddenFromViewer(WL, 'op-id', 'issuer', 'platform')).toBe(false);
  });
});
