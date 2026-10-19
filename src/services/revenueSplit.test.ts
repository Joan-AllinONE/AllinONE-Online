/**
 * 三方收益分成纯函数单测
 * 覆盖：legacy 单极回退 / 三方 floor 尾差归游戏方 / 金额守恒 / 配置校验
 */
import { describe, it, expect } from 'vitest';
import {
  computeThreeWaySplit,
  hasActiveSharingConfig,
  validateRevenueSharingConfig,
} from './revenueSplit';

describe('hasActiveSharingConfig', () => {
  it('无配置 → false', () => {
    expect(hasActiveSharingConfig(undefined)).toBe(false);
    expect(hasActiveSharingConfig(null)).toBe(false);
  });

  it('全 0 配置视为未配置 → false', () => {
    expect(hasActiveSharingConfig({ gameShare: 0, platformShare: 0, creatorShare: 0 })).toBe(false);
  });

  it('任一份额 > 0 → true', () => {
    expect(hasActiveSharingConfig({ gameShare: 0.9, platformShare: 0.1, creatorShare: 0 })).toBe(true);
    expect(hasActiveSharingConfig({ gameShare: 0, platformShare: 1, creatorShare: 0 })).toBe(true);
  });
});

describe('computeThreeWaySplit — legacy 单极', () => {
  it('无配置：平台抽 10%（floor），其余归游戏方，creatorCut = 0', () => {
    const r = computeThreeWaySplit(105, undefined, 10);
    expect(r.mode).toBe('legacy');
    expect(r.platformCut).toBe(10); // floor(105*0.1) = 10
    expect(r.gameCut).toBe(95);
    expect(r.creatorCut).toBe(0);
    expect(r.gameCut + r.platformCut + r.creatorCut).toBe(105);
  });

  it('全 0 配置等价 legacy', () => {
    const r = computeThreeWaySplit(100, { gameShare: 0, platformShare: 0, creatorShare: 0 }, 10);
    expect(r.mode).toBe('legacy');
    expect(r.platformCut).toBe(10);
    expect(r.gameCut).toBe(90);
  });
});

describe('computeThreeWaySplit — 三方模式', () => {
  it('整除场景：60/30/10 精确分账', () => {
    const r = computeThreeWaySplit(100, { gameShare: 0.6, platformShare: 0.3, creatorShare: 0.1 }, 10);
    expect(r.mode).toBe('three-way');
    expect(r.gameCut).toBe(60);
    expect(r.platformCut).toBe(30);
    expect(r.creatorCut).toBe(10);
    expect(r.gameCut + r.platformCut + r.creatorCut).toBe(100);
  });

  it('尾差归游戏方：0.33/0.33/0.33 → 平台 33 / 创作者 33 / 游戏 34', () => {
    const r = computeThreeWaySplit(100, { gameShare: 0.33, platformShare: 0.33, creatorShare: 0.33 }, 10);
    expect(r.platformCut).toBe(33);
    expect(r.creatorCut).toBe(33);
    expect(r.gameCut).toBe(34); // 尾差归游戏方
    expect(r.gameCut + r.platformCut + r.creatorCut).toBe(100);
  });

  it('creatorShare = 0：三方模式两方分账', () => {
    const r = computeThreeWaySplit(100, { gameShare: 0.8, platformShare: 0.2, creatorShare: 0 }, 10);
    expect(r.mode).toBe('three-way');
    expect(r.creatorCut).toBe(0);
    expect(r.platformCut).toBe(20);
    expect(r.gameCut).toBe(80);
  });

  it('不可整除金额：三方之和恒等于 amount', () => {
    const r = computeThreeWaySplit(7, { gameShare: 0.6, platformShare: 0.3, creatorShare: 0.1 }, 10);
    expect(r.platformCut).toBe(2); // floor(2.1)
    expect(r.creatorCut).toBe(0);  // floor(0.7)
    expect(r.gameCut).toBe(5);     // 尾差
    expect(r.gameCut + r.platformCut + r.creatorCut).toBe(7);
  });

  it('金额 0 → 全 0', () => {
    const r = computeThreeWaySplit(0, { gameShare: 0.6, platformShare: 0.3, creatorShare: 0.1 }, 10);
    expect(r.gameCut).toBe(0);
    expect(r.platformCut).toBe(0);
    expect(r.creatorCut).toBe(0);
  });

  it('守恒不变量：随机金额与比例下三方之和 === amount', () => {
    for (let i = 0; i < 200; i++) {
      const amount = Math.floor(Math.random() * 100000) + 1;
      const a = Math.random(), b = Math.random(), c = Math.random();
      const sum = a + b + c;
      const r = computeThreeWaySplit(
        amount,
        { gameShare: a / sum, platformShare: b / sum, creatorShare: c / sum },
        10,
      );
      expect(r.gameCut + r.platformCut + r.creatorCut).toBe(amount);
      expect(r.gameCut).toBeGreaterThanOrEqual(0);
      expect(r.platformCut).toBeGreaterThanOrEqual(0);
      expect(r.creatorCut).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('validateRevenueSharingConfig', () => {
  it('合法配置 → ok', () => {
    expect(validateRevenueSharingConfig({
      gameShare: 0.6, platformShare: 0.3, creatorShare: 0.1, creatorId: 'u1',
    }).ok).toBe(true);
  });

  it('两方（creatorShare=0 无 creatorId）→ ok', () => {
    expect(validateRevenueSharingConfig({ gameShare: 0.9, platformShare: 0.1, creatorShare: 0 }).ok).toBe(true);
  });

  it('之和 ≠ 1 → 拒绝', () => {
    const r = validateRevenueSharingConfig({ gameShare: 0.5, platformShare: 0.3, creatorShare: 0.1 });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('1');
  });

  it('creatorShare > 0 但未指定创作者 → 拒绝', () => {
    const r = validateRevenueSharingConfig({ gameShare: 0.6, platformShare: 0.3, creatorShare: 0.1 });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('创作者');
  });

  it('负数份额 → 拒绝', () => {
    expect(validateRevenueSharingConfig({ gameShare: -0.1, platformShare: 1, creatorShare: 0.1 }).ok).toBe(false);
  });
});
