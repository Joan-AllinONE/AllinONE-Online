/**
 * useWallet - MVP v1.1 钱包 Hook
 *
 * 读取 gameCoins（钱包）和 voucherBalance（仅A币类凭证余额，排除道具凭证）
 * voucherBalance 通过 voucherPaymentService.getUserVoucherBalance() 读取，
 * 该方法内部已按 isCurrencyVoucher() 过滤，道具凭证（sourceType='item'）不计入。
 */
import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@/contexts/authContext';
import { voucherPaymentService } from '@/services/voucherPaymentService';

export interface WalletData {
  gameCoins: number;
  voucherBalance: number;  // A币余额（凭证合计）
  instantVouchers: number;
  algorithmVouchers: number;
  lastUpdated: number;
}

export function useWallet() {
  const { currentUser, isAuthenticated } = useAuth();
  const [wallet, setWallet] = useState<WalletData | null>(null);
  const [loading, setLoading] = useState(true);

  const refreshWalletData = useCallback(async () => {
    if (!isAuthenticated) { setLoading(false); return; }
    try {
      setLoading(true);
      const uid = currentUser?.uid || currentUser?.id || 'anonymous';

      // 读钱包 gameCoins
      let gameCoins = 0;
      try {
        const { skillGateway } = await import('@/skills/index');
        const result = await skillGateway.execute('wallet', 'getBalance', {}, {
          userId: uid,
          sessionId: 'web',
        } as any);
        if (result.success && result.data) {
          const raw = result.data as any;
          const walletData = raw?.data ?? raw;
          gameCoins = walletData.gameCoins || 0;
          console.log('[useWallet] wallet.getBalance result: gameCoins=', gameCoins);
        }
      } catch { /* Skill not ready, fallback */ }

      // 读凭证 A币余额
      let voucherBalance = 0;
      try {
        voucherBalance = voucherPaymentService.getUserVoucherBalance(uid);
        console.log('[useWallet] voucherBalance=', voucherBalance);
      } catch { /* fallback */ }

      // localStorage fallback for gameCoins
      if (gameCoins === 0) {
        try {
          const saved = localStorage.getItem('wallet_v3') || localStorage.getItem('wallet_v2');
          if (saved) {
            const data = JSON.parse(saved);
            const userWallet = data[uid];
            if (userWallet) {
              gameCoins = userWallet.gameCoins || 0;
            }
          }
        } catch { /* ignore */ }
      }

      setWallet({
        gameCoins,
        voucherBalance,
        instantVouchers: 0,
        algorithmVouchers: 0,
        lastUpdated: Date.now(),
      });
    } catch (err) {
      console.warn('useWallet: refresh failed', err);
      setWallet({ gameCoins: 0, voucherBalance: 0, instantVouchers: 0, algorithmVouchers: 0, lastUpdated: Date.now() });
    } finally {
      setLoading(false);
    }
  }, [isAuthenticated, currentUser]);

  useEffect(() => { refreshWalletData(); }, [refreshWalletData]);

  useEffect(() => {
    const handler = () => refreshWalletData();
    window.addEventListener('allinoneAuthChange', handler);
    window.addEventListener('wallet-updated', handler);
    return () => {
      window.removeEventListener('allinoneAuthChange', handler);
      window.removeEventListener('wallet-updated', handler);
    };
  }, [refreshWalletData]);

  return { wallet, loading, refreshWalletData };
}
