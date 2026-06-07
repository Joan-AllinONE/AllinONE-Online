/**
 * S5-2b: VoucherService 核心测试
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { voucherService } from './VoucherService.js';
import { voucherDB } from '../storage/VoucherDatabase.js';
import { VoucherStatus } from '../types.js';

describe('VoucherService', () => {
  beforeEach(() => {
    localStorage.clear();
    voucherDB['voucherCache']?.clear();
    voucherDB['transactionCache']?.clear();
  });

  describe('createVoucher', () => {
    it('should create a single voucher', () => {
      const v = voucherService.createVoucher(
        { denomination: 100, recipientId: 'user-1', recipientName: 'TestUser', note: 'Test' },
        'SYSTEM', '系统'
      );

      expect(v.denomination).toBe(100);
      expect(v.currentHolderId).toBe('user-1');
      expect(v.status).toBe(VoucherStatus.ACTIVE);
    });

    it('should create vouchers with correct denomination', () => {
      const results = [10, 50, 200].map(d =>
        voucherService.createVoucher(
          { denomination: d, recipientId: 'user-1', recipientName: 'Test', note: '' },
          'SYSTEM', '系统'
        )
      );
      expect(results.map(r => r.denomination)).toEqual([10, 50, 200]);
    });
  });

  describe('batchCreateVouchers', () => {
    it('should batch create vouchers for platform pool', () => {
      const vouchers = voucherService.batchCreateVouchers(
        { count: 5, denomination: 10, recipientId: 'pool-1', recipientName: 'Pool', note: 'Batch' },
        'SYSTEM', '系统'
      );
      expect(vouchers.length).toBe(5);
      expect(vouchers[0].denomination).toBe(10);
    });
  });

  describe('getUserVouchers', () => {
    it('should return user vouchers', () => {
      voucherService.createVoucher(
        { denomination: 100, recipientId: 'user-1', recipientName: 'A', note: '' },
        'SYSTEM', '系统'
      );
      voucherService.createVoucher(
        { denomination: 50, recipientId: 'user-1', recipientName: 'A', note: '' },
        'SYSTEM', '系统'
      );

      const vouchers = voucherService.getUserVouchers('user-1');
      expect(vouchers.length).toBe(2);
      expect(vouchers.reduce((s, v) => s + v.denomination, 0)).toBe(150);
    });

    it('should return empty array for unknown user', () => {
      const vouchers = voucherService.getUserVouchers('unknown');
      expect(vouchers).toEqual([]);
    });
  });

  describe('transferVoucher', () => {
    it('should transfer voucher between users', () => {
      const v = voucherService.createVoucher(
        { denomination: 100, recipientId: 'user-1', recipientName: 'Sender', note: 'Test' },
        'SYSTEM', '系统'
      );

      const tx = voucherService.transferVoucher(
        { voucherId: v.id, toUserId: 'user-2', toUserName: 'Receiver', note: 'Transfer' },
        'user-1', 'Sender'
      );

      expect(tx.type).toBe('transfer');
      expect(tx.fromUserId).toBe('user-1');
      expect(tx.toUserId).toBe('user-2');

      // Verify both users' balances
      expect(voucherService.getUserVouchers('user-1').length).toBe(0);
      expect(voucherService.getUserVouchers('user-2').length).toBe(1);
    });

    it('should throw for non-existent voucher', () => {
      expect(() => {
        voucherService.transferVoucher(
          { voucherId: 'nonexistent', toUserId: 'user-2', toUserName: 'X', note: '' },
          'user-1', 'X'
        );
      }).toThrow();
    });
  });
});
