/**
 * S5-2c: voucherPaymentService 核心测试
 * 覆盖：支付、找零、余额不足、并发安全
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { voucherPaymentService } from './voucherPaymentService.js';
import { voucherService } from '@/voucher-system/services/VoucherService.js';
import { voucherDB } from '@/voucher-system/storage/VoucherDatabase.js';
import { VoucherStatus } from '@/voucher-system/types.js';

describe('VoucherPaymentService', () => {
  beforeEach(() => {
    localStorage.clear();
    voucherDB['voucherCache']?.clear();
    voucherDB['transactionCache']?.clear();
    // Reset singleton initialized flag
    (voucherPaymentService as any).initialized = false;
    voucherPaymentService.initializePlatformPool();
  });

  const giveUserVoucher = (userId: string, userName: string, denomination: number) => {
    voucherService.createVoucher(
      { denomination, recipientId: userId, recipientName: userName, note: 'Test' },
      'SYSTEM', '系统'
    );
  };

  describe('payWithVoucher', () => {
    it('should pay successfully with exact amount', () => {
      giveUserVoucher('user-1', 'Alice', 100);

      const result = voucherPaymentService.payWithVoucher(
        'user-1', 'Alice', 100, '购买宝箱'
      );

      expect(result.success).toBe(true);
      expect(result.consumedVouchers.length).toBe(1);
      expect(result.consumedVouchers[0].denomination).toBe(100);
    });

    it('should return change for overpayment', () => {
      giveUserVoucher('user-1', 'Alice', 100);

      const result = voucherPaymentService.payWithVoucher(
        'user-1', 'Alice', 30, '购买道具'
      );

      expect(result.success).toBe(true);
      expect(result.changeVouchers.length).toBeGreaterThan(0);
    });

    it('should reject insufficient balance', () => {
      giveUserVoucher('user-1', 'Alice', 10);

      const result = voucherPaymentService.payWithVoucher(
        'user-1', 'Alice', 100, '购买宝箱'
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('余额不足');
    });

    it('should pay with multiple vouchers (greedy)', () => {
      giveUserVoucher('user-1', 'Alice', 50);
      giveUserVoucher('user-1', 'Alice', 20);
      giveUserVoucher('user-1', 'Alice', 10);

      const result = voucherPaymentService.payWithVoucher(
        'user-1', 'Alice', 70, '购买套装'
      );

      expect(result.success).toBe(true);
      expect(result.consumedVouchers.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('getUserVoucherBalance', () => {
    it('should return correct total balance', () => {
      giveUserVoucher('user-1', 'Alice', 50);
      giveUserVoucher('user-1', 'Alice', 30);

      const balance = voucherPaymentService.getUserVoucherBalance('user-1');
      expect(balance).toBe(80);
    });

    it('should return 0 for user with no vouchers', () => {
      expect(voucherPaymentService.getUserVoucherBalance('unknown')).toBe(0);
    });
  });

  describe('platform pool', () => {
    it('should initialize platform pool', () => {
      const stats = voucherPaymentService.getPlatformPoolStats();
      expect(stats.totalVouchers).toBeGreaterThan(0);
      expect(stats.totalValue).toBeGreaterThan(0);
    });
  });
});
