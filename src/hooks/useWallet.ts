/**
 * useWallet - MVP v1.2 钱包 Hook
 *
 * 读取 gameCoins（钱包）和 voucherBalance（仅A币类凭证余额，排除道具凭证）
 * 新增：transactions（交易明细）、stats（收支统计）
 * v1.2.1: 交易明细读取增加 localStorage 直读兜底，确保 skillGateway 失败时不丢失数据
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

export interface TransactionItem {
  id: string;
  type: 'income' | 'expense';
  amount: number;
  description: string;
  timestamp: number;
  currency?: string;
}

export interface WalletStatsData {
  todayIncome: number;
  todayExpense: number;
  totalIncome: number;
  totalExpense: number;
  transactionCount: number;
}

/** 直接从 localStorage 读取交易记录（兜底，不依赖 skillGateway） */
function readTransactionsFromLocalStorage(userId: string): TransactionItem[] {
  try {
    const raw = localStorage.getItem('allinone_wallet_transactions');
    if (!raw) return [];
    const all = JSON.parse(raw) as Record<string, any[]>;
    const list = all[userId] || [];
    return list.map(tx => ({
      id: tx.id || '',
      type: tx.type || 'income',
      amount: tx.amount || 0,
      description: tx.description || '交易',
      timestamp: tx.timestamp || Date.now(),
      currency: tx.currency || '游戏币',
    }));
  } catch {
    return [];
  }
}

/** 从交易列表计算统计 */
function computeStats(txs: TransactionItem[]): WalletStatsData {
  const now = Date.now();
  const DAY = 86400000;
  let todayIncome = 0, todayExpense = 0, totalIncome = 0, totalExpense = 0;
  for (const tx of txs) {
    const age = now - tx.timestamp;
    if (tx.type === 'income') {
      totalIncome += tx.amount;
      if (age < DAY) todayIncome += tx.amount;
    } else {
      totalExpense += tx.amount;
      if (age < DAY) todayExpense += tx.amount;
    }
  }
  return {
    todayIncome, todayExpense,
    totalIncome, totalExpense,
    transactionCount: txs.length,
  };
}

export function useWallet() {
  const { currentUser, isAuthenticated } = useAuth();
  const [wallet, setWallet] = useState<WalletData | null>(null);
  const [transactions, setTransactions] = useState<TransactionItem[]>([]);
  const [stats, setStats] = useState<WalletStatsData | null>(null);
  const [loading, setLoading] = useState(true);

  const refreshWalletData = useCallback(async () => {
    if (!isAuthenticated) { setLoading(false); return; }
    const uid = currentUser?.uid || currentUser?.id || 'anonymous';

    try {
      setLoading(true);

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
        }
      } catch { /* Skill not ready */ }

      // 读凭证 A币余额
      let voucherBalance = 0;
      try {
        voucherBalance = voucherPaymentService.getUserVoucherBalance(uid);
      } catch { /* fallback */ }

      setWallet({
        gameCoins,
        voucherBalance,
        instantVouchers: 0,
        algorithmVouchers: 0,
        lastUpdated: Date.now(),
      });

      // 读交易明细 — skillGateway 优先，失败时直读 localStorage 兜底
      let txItems: TransactionItem[] = [];
      let txFromGateway = false;
      try {
        const { skillGateway } = await import('@/skills/index');
        const txResult = await skillGateway.execute('wallet', 'getTransactions', { limit: 50 }, {
          userId: uid,
          sessionId: 'web',
        } as any);
        if (txResult.success && txResult.data) {
          const raw = txResult.data as any;
          const txList = Array.isArray(raw?.data) ? raw.data : Array.isArray(raw) ? raw : [];
          if (txList.length > 0) {
            txItems = txList.map((tx: any) => ({
              id: tx.id || '',
              type: tx.type || 'income',
              amount: tx.amount || 0,
              description: tx.description || '交易',
              timestamp: tx.timestamp || Date.now(),
              currency: tx.currency || '游戏币',
            }));
            txFromGateway = true;
          }
        }
      } catch { /* skillGateway 异常 */ }

      // skillGateway 失败或返回空 → 直读 localStorage 兜底
      if (!txFromGateway || txItems.length === 0) {
        const localTxs = readTransactionsFromLocalStorage(uid);
        if (localTxs.length > 0) {
          txItems = localTxs;
          console.log(`[useWallet] 从 localStorage 兜底读取 ${localTxs.length} 条交易记录`);
        }
      }

      setTransactions(txItems);
      setStats(computeStats(txItems));

    } catch (err) {
      console.warn('useWallet: refresh failed', err);
      // 全局异常兜底：至少尝试从 localStorage 读余额
      const localTxs = readTransactionsFromLocalStorage(
        currentUser?.uid || currentUser?.id || 'anonymous'
      );
      setTransactions(localTxs);
      setStats(computeStats(localTxs));
      setWallet({
        gameCoins: 0,
        voucherBalance: 0,
        instantVouchers: 0,
        algorithmVouchers: 0,
        lastUpdated: Date.now(),
      });
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

  return { wallet, transactions, stats, loading, refreshWalletData };
}
