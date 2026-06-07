/**
 * S5-2a: redeemCodeStore 核心测试
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { redeemCodeStore, RedeemCodeStatus } from './redeemCodeStore.js';

describe('RedeemCodeStore', () => {
  beforeEach(() => {
    redeemCodeStore.clear();
  });

  const seedCode = () => {
    redeemCodeStore.syncItems([{
      id: 'item-1', gameId: 'game-1', name: '钻石', description: '游戏货币',
      gameEffect: { itemId: 'gem', quantity: 100 },
      inventory: { total: 100, available: 100, sold: 0, used: 0 },
      status: 'active', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }]);
    redeemCodeStore.syncCodes([{
      id: 'code-1', code: 'TEST-CODE-001', gameId: 'game-1', itemId: 'item-1',
      itemName: '钻石', status: RedeemCodeStatus.UNUSED,
      gameEffect: { itemId: 'gem', quantity: 100 },
      createdAt: new Date().toISOString(), verifyCount: 0,
    }]);
  };

  describe('verifyCode', () => {
    it('should verify a valid code', () => {
      seedCode();
      const result = redeemCodeStore.verifyCode('game-1', 'TEST-CODE-001');
      expect(result.valid).toBe(true);
      expect(result.itemName).toBe('钻石');
    });

    it('should reject non-existent code', () => {
      const result = redeemCodeStore.verifyCode('game-1', 'WRONG-CODE');
      expect(result.valid).toBe(false);
    });

    it('should increment verify count', () => {
      seedCode();
      redeemCodeStore.verifyCode('game-1', 'TEST-CODE-001');
      const codes = redeemCodeStore.getAllCodes();
      expect(codes[0].verifyCount).toBe(1);
    });
  });

  describe('useCode', () => {
    it('should use a valid code successfully', () => {
      seedCode();
      const result = redeemCodeStore.useCode('game-1', 'TEST-CODE-001', 'user-1');
      expect(result.success).toBe(true);
      expect(result.itemName).toBe('钻石');
    });

    it('should reject already-used code (S2-2 double-spend protection)', () => {
      seedCode();
      redeemCodeStore.useCode('game-1', 'TEST-CODE-001', 'user-1');
      const result = redeemCodeStore.useCode('game-1', 'TEST-CODE-001', 'user-2');
      expect(result.success).toBe(false);
      expect(result.message).toContain('已被使用');
    });

    it('should reject wrong game code', () => {
      seedCode();
      const result = redeemCodeStore.useCode('game-2', 'TEST-CODE-001', 'user-1');
      expect(result.success).toBe(false);
    });

    it('should update inventory after use', () => {
      seedCode();
      redeemCodeStore.useCode('game-1', 'TEST-CODE-001', 'user-1');
      const items = redeemCodeStore.getAllItems('game-1');
      expect(items[0].inventory.used).toBe(1);
      expect(items[0].inventory.available).toBe(99);
    });
  });

  describe('getStats', () => {
    it('should return correct stats', () => {
      seedCode();
      const stats = redeemCodeStore.getStats();
      expect(stats.codeCount).toBe(1);
      expect(stats.itemCount).toBe(1);
      redeemCodeStore.useCode('game-1', 'TEST-CODE-001', 'user-1');
      expect(redeemCodeStore.getStats().usedCount).toBe(1);
    });
  });
});
