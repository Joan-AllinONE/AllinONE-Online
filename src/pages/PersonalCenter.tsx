/**
 * PersonalCenter - 个人中心（MVP v1.0）
 *
 * 5 个 Tab：凭证资产 / 道具凭证 / 购买记录 / 交易明细 / 投票记录
 * 核心逻辑：货币和道具都以凭证形式存放在凭证系统(VoucherService)
 * 凭证 sourceType 区分：instant(即时) / algorithm(算法) / item(道具) / vote(投票)
 */

import { useState, useEffect } from 'react';
import { useAuth } from '@/contexts/authContext';
import { useWallet } from '@/hooks/useWallet';
import { voucherService } from '@/voucher-system/services/VoucherService';
import type { Voucher } from '@/voucher-system/types';
import { VoucherSourceType, VoucherStatus } from '@/voucher-system/types';
import VoteNotificationPanel from '@/components/voucher-system/VoteNotificationPanel';

type Tab = 'vouchers' | 'items' | 'purchases' | 'transactions' | 'votes';

/** 统一构建 SkillContext */
function getSkillContext(userId?: string) {
  return { userId: userId || 'anonymous', sessionId: 'web' };
}

// ==================== 子面板组件（内联） ====================

function WalletOverview() {
  const { wallet, refreshWalletData } = useWallet();
  const { currentUser } = useAuth();

  return (
    <div className="mx-5 mt-4 p-4 bg-slate-800/60 rounded-2xl border border-slate-700/40">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-white font-bold text-lg">👤 钱包概览</h2>
        <button
          onClick={() => refreshWalletData()}
          className="text-xs text-slate-400 hover:text-purple-400 transition-colors"
        >
          刷新
        </button>
      </div>
      <div className="text-xs text-slate-500 mb-2">{currentUser?.nickname || currentUser?.uid || 'Player'}</div>
      <div className="grid grid-cols-2 gap-3">
        <div className="p-3 bg-slate-700/40 rounded-xl">
          <div className="text-xs text-slate-400">💰 游戏币</div>
          <div className="text-xl font-bold text-yellow-300 mt-1">
            {(wallet?.gameCoins || 0).toLocaleString()}
          </div>
        </div>
        <div className="p-3 bg-slate-700/40 rounded-xl">
          <div className="text-xs text-slate-400">🎫 A币（凭证）</div>
          <div className="text-xl font-bold text-purple-400 mt-1">
            {(wallet?.voucherBalance || 0).toLocaleString()}
          </div>
        </div>
      </div>
    </div>
  );
}

function VoucherAssetPanel() {
  const { currentUser, isAuthenticated } = useAuth();
  const [vouchers, setVouchers] = useState<Voucher[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!isAuthenticated) { setLoading(false); return; }
    const uid = currentUser?.uid || currentUser?.id || 'anonymous';
    try {
      // 从凭证系统获取当前用户的即时凭证 + 算法凭证
      const userVouchers = voucherService.getUserVouchers(uid);
      const assetVouchers = userVouchers.filter(
        v => (v.status === VoucherStatus.ACTIVE || v.status === VoucherStatus.REDEEMED) &&
             (v.sourceType === VoucherSourceType.INSTANT ||
              v.sourceType === VoucherSourceType.ALGORITHM ||
              !v.sourceType)
      );
      setVouchers(assetVouchers);
    } catch {
      // Fallback: 尝试从 VoucherSkill 获取
      (async () => {
        try {
          const { skillGateway } = await import('@/skills/index');
          const result = await skillGateway.execute('voucher', 'getUserVouchers', {}, getSkillContext(uid));
          if (result.success && result.data) {
            const raw = result.data as any;
            const list = Array.isArray(raw?.data) ? raw.data : Array.isArray(raw) ? raw : [];
            setVouchers(list);
          }
        } catch { /* ignore */ }
      })();
    } finally {
      setLoading(false);
    }
  }, [isAuthenticated, currentUser]);

  if (loading) return <div className="text-slate-400 text-center py-10">加载中...</div>;
  if (vouchers.length === 0) {
    return (
      <div className="text-center py-16 text-slate-500">
        <div className="text-5xl mb-3">🎫</div>
        <p>暂无凭证资产</p>
        <p className="text-xs mt-1">前往凭证工坊铸造你的第一张凭证</p>
      </div>
    );
  }

  const instantVouchers = vouchers.filter(v => (!v.sourceType || v.sourceType === VoucherSourceType.INSTANT) && v.status === VoucherStatus.ACTIVE);
  const instantRedeemed = vouchers.filter(v => (!v.sourceType || v.sourceType === VoucherSourceType.INSTANT) && v.status === VoucherStatus.REDEEMED);
  const algorithmVouchers = vouchers.filter(v => v.sourceType === VoucherSourceType.ALGORITHM && v.status === VoucherStatus.ACTIVE);
  const algorithmRedeemed = vouchers.filter(v => v.sourceType === VoucherSourceType.ALGORITHM && v.status === VoucherStatus.REDEEMED);

  return (
    <div className="px-5 space-y-4">
      {/* 即时凭证 */}
      {instantVouchers.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-purple-400 mb-2">⚡ 即时凭证 ({instantVouchers.length})</h3>
          <div className="space-y-2">
            {instantVouchers.map(v => (
              <div key={v.id} className="p-3 bg-slate-800/60 rounded-xl border border-slate-700/40 flex items-center justify-between">
                <div>
                  <div className="text-white font-medium text-sm">{v.serialNumber || v.id.slice(0, 12)}</div>
                  <div className="text-xs text-slate-400 mt-0.5">{v.currentHolderName || '我'} · {new Date(v.createdAt).toLocaleDateString()}</div>
                </div>
                <div className="text-right">
                  <div className="text-purple-400 font-bold">{v.denomination} 面值</div>
                  <div className="text-[10px] text-slate-500">即时</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 算法凭证 */}
      {algorithmVouchers.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-orange-400 mb-2">⚖️ 算法凭证 ({algorithmVouchers.length})</h3>
          <div className="space-y-2">
            {algorithmVouchers.map(v => (
              <div key={v.id} className="p-3 bg-slate-800/60 rounded-xl border border-slate-700/40 flex items-center justify-between">
                <div>
                  <div className="text-white font-medium text-sm">{v.serialNumber || v.id.slice(0, 12)}</div>
                  <div className="text-xs text-slate-400 mt-0.5">
                    {v.currentHolderName || '我'} · {new Date(v.createdAt).toLocaleDateString()}
                    {v.algorithmInfo && ` · 第${v.algorithmInfo.cycleNumber || '?'}轮`}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-orange-400 font-bold">{v.denomination} 面值</div>
                  <div className="text-[10px] text-slate-500">算法</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 已使用的即时凭证 */}
      {instantRedeemed.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-amber-500/70 mb-2">⚡ 即时凭证 · 已使用 ({instantRedeemed.length})</h3>
          <div className="space-y-2">
            {instantRedeemed.map(v => (
              <div key={v.id} className="p-3 bg-slate-800/30 rounded-xl border border-dashed border-slate-700/30 flex items-center justify-between opacity-60">
                <div>
                  <div className="text-slate-400 font-medium text-sm line-through">{v.serialNumber || v.id.slice(0, 12)}</div>
                  <div className="text-xs text-slate-500 mt-0.5">
                    {v.currentHolderName || '我'} · {new Date(v.createdAt).toLocaleDateString()}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-slate-500 font-bold">{v.denomination} 面值</div>
                  <span className="text-[10px] px-1.5 py-0.5 bg-amber-500/15 text-amber-400/70 rounded">已使用</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 已使用的算法凭证 */}
      {algorithmRedeemed.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-amber-500/70 mb-2">⚖️ 算法凭证 · 已使用 ({algorithmRedeemed.length})</h3>
          <div className="space-y-2">
            {algorithmRedeemed.map(v => (
              <div key={v.id} className="p-3 bg-slate-800/30 rounded-xl border border-dashed border-slate-700/30 flex items-center justify-between opacity-60">
                <div>
                  <div className="text-slate-400 font-medium text-sm line-through">{v.serialNumber || v.id.slice(0, 12)}</div>
                  <div className="text-xs text-slate-500 mt-0.5">
                    {v.currentHolderName || '我'} · {new Date(v.createdAt).toLocaleDateString()}
                    {v.algorithmInfo && ` · 第${v.algorithmInfo.cycleNumber || '?'}轮`}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-slate-500 font-bold">{v.denomination} 面值</div>
                  <span className="text-[10px] px-1.5 py-0.5 bg-amber-500/15 text-amber-400/70 rounded">已使用</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ItemVoucherPanel() {
  const { currentUser, isAuthenticated } = useAuth();
  const [items, setItems] = useState<Voucher[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!isAuthenticated) { setLoading(false); return; }
    const uid = currentUser?.uid || currentUser?.id || 'anonymous';
    try {
      // 从凭证系统获取当前用户的道具凭证
      const userVouchers = voucherService.getUserVouchers(uid);
      const itemVouchers = userVouchers.filter(
        v => (v.status === VoucherStatus.ACTIVE || v.status === VoucherStatus.REDEEMED) &&
             v.sourceType === VoucherSourceType.ITEM
      );
      setItems(itemVouchers);
    } catch {
      // Fallback: 尝试从 InventorySkill 获取
      (async () => {
        try {
          const { skillGateway } = await import('@/skills/index');
          const result = await skillGateway.execute('inventory', 'getItems', { limit: 20 }, getSkillContext(uid));
          if (result.success && result.data) {
            const raw = result.data as any;
            const list = raw?.data?.items ?? raw?.items ?? [];
            const filtered = list.filter((item: any) => !item.userId || item.userId === uid);
            // 将 InventoryItem 转为 Voucher 兼容格式
            setItems(filtered.map((item: any) => ({
              id: item.id?.toString() || item.itemId,
              serialNumber: item.name || item.itemId,
              denomination: 1,
              currentHolderId: uid,
              currentHolderName: '',
              status: VoucherStatus.ACTIVE,
              createdAt: item.obtainedAt || Date.now(),
              createdBy: '',
              createdByName: '',
              transferCount: 0,
              metadata: {
                sourceType: VoucherSourceType.ITEM,
                name: item.name,
                gameSource: item.gameSource,
                gameName: item.gameName,
                quantity: item.quantity,
                icon: item.icon,
              },
            } as Voucher)));
          }
        } catch { /* ignore */ }
      })();
    } finally {
      setLoading(false);
    }
  }, [isAuthenticated, currentUser]);

  const activeItems = items.filter(v => v.status === VoucherStatus.ACTIVE);
  const redeemedItems = items.filter(v => v.status === VoucherStatus.REDEEMED);

  if (loading) return <div className="text-slate-400 text-center py-10">加载中...</div>;
  if (activeItems.length === 0 && redeemedItems.length === 0) {
    return (
      <div className="text-center py-16 text-slate-500">
        <div className="text-5xl mb-3">🎒</div>
        <p>暂无道具凭证</p>
        <p className="text-xs mt-1">在游戏商店购买道具后会显示在这里</p>
      </div>
    );
  }

  const renderItemRow = (v: Voucher, i: number, isRedeemed: boolean) => {
    const meta = v.metadata || {};
    const itemName = meta.name || meta.itemId || v.serialNumber || `道具 #${i + 1}`;
    const gameName = meta.gameName || meta.gameSource || '未知游戏';
    const qty = meta.quantity || 1;
    return (
      <div key={v.id || i} className={`p-3.5 rounded-xl border flex items-center justify-between ${
        isRedeemed
          ? 'bg-slate-800/30 border-dashed border-slate-700/30 opacity-60'
          : 'bg-slate-800/60 border-slate-700/40'
      }`}>
        <div>
          <div className={`font-medium text-sm ${isRedeemed ? 'text-slate-400 line-through' : 'text-white'}`}>{itemName}</div>
          <div className="text-xs text-slate-400 mt-0.5">{gameName} · x{qty}</div>
        </div>
        <div className="text-right">
          <div className={`font-bold ${isRedeemed ? 'text-slate-500' : 'text-cyan-400'}`}>{v.denomination} 面值</div>
          {isRedeemed ? (
            <span className="text-[10px] px-1.5 py-0.5 bg-amber-500/15 text-amber-400/70 rounded">已使用</span>
          ) : (
            <div className="text-[10px] text-slate-500">道具凭证</div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-2.5 px-5">
      {activeItems.map((v, i) => renderItemRow(v, i, false))}
      {redeemedItems.length > 0 && (
        <div className="pt-4 mt-2 border-t border-slate-700/50">
          <h3 className="text-xs font-medium text-amber-500/60 mb-2 uppercase tracking-wider">已使用的道具凭证 ({redeemedItems.length})</h3>
          <div className="space-y-2">
            {redeemedItems.map((v, i) => renderItemRow(v, i, true))}
          </div>
        </div>
      )}
    </div>
  );
}

function PurchaseHistoryPanel() {
  const { currentUser, isAuthenticated } = useAuth();
  const [purchases, setPurchases] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!isAuthenticated) { setLoading(false); return; }
    let cancelled = false;
    (async () => {
      try {
        const { skillGateway } = await import('@/skills/index');
        // 用 wallet.getTransactions 获取支出记录
        const result = await skillGateway.execute('wallet', 'getTransactions', { limit: 20 }, getSkillContext(currentUser?.uid || currentUser?.id));
        if (cancelled) return;
        if (result.success && result.data) {
          const raw = result.data as any;
          const txList = Array.isArray(raw?.data) ? raw.data : Array.isArray(raw) ? raw : [];
          // 只显示支出（购买）记录
          const expenses = txList.filter((t: any) => t.type === 'expense');
          setPurchases(expenses);
        }
      } catch {
        // Fallback: 从 localStorage 的 purchases 读取
        try {
          const raw = localStorage.getItem('purchases');
          if (raw) {
            const uid = currentUser?.uid || currentUser?.id || 'anonymous';
            const all = JSON.parse(raw);
            setPurchases(all.filter((p: any) => p.userId === uid));
          }
        } catch { /* ignore */ }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [isAuthenticated, currentUser]);

  if (loading) return <div className="text-slate-400 text-center py-10">加载中...</div>;
  if (purchases.length === 0) {
    return (
      <div className="text-center py-16 text-slate-500">
        <div className="text-5xl mb-3">📋</div>
        <p>暂无购买记录</p>
        <p className="text-xs mt-1">在凭证工坊购买凭证后会显示在这里</p>
      </div>
    );
  }

  return (
    <div className="space-y-2.5 px-5">
      {purchases.map((p: any, i: number) => (
        <div key={p.id || i} className="p-3.5 bg-slate-800/60 rounded-xl border border-slate-700/40 flex items-center justify-between">
          <div>
            <div className="text-white font-medium text-sm">{p.description || p.redeemCode || '购买记录'}</div>
            <div className="text-xs text-slate-400 mt-0.5">{new Date(p.timestamp || p.paidAt).toLocaleString()}</div>
          </div>
          <div className="text-right">
            <div className="text-yellow-400 font-bold">-{p.amount || p.price} {p.currency}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function TransactionPanel() {
  const { currentUser, isAuthenticated } = useAuth();
  const [transactions, setTransactions] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!isAuthenticated) { setLoading(false); return; }
    let cancelled = false;
    (async () => {
      try {
        const { skillGateway } = await import('@/skills/index');
        const result = await skillGateway.execute('wallet', 'getTransactions', { limit: 50 }, getSkillContext(currentUser?.uid || currentUser?.id));
        if (cancelled) return;
        if (result.success && result.data) {
          const raw = result.data as any;
          const txList = Array.isArray(raw?.data) ? raw.data : Array.isArray(raw) ? raw : [];
          setTransactions(txList);
        }
      } catch {
        // Fallback: 从 wallet_tx 读取
        try {
          const raw = localStorage.getItem('wallet_tx');
          if (raw) {
            const uid = currentUser?.uid || currentUser?.id || 'anonymous';
            const all: any[] = JSON.parse(raw);
            setTransactions(all.filter(t => t.userId === uid).slice(-50).reverse());
          }
        } catch { /* ignore */ }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [isAuthenticated, currentUser]);

  if (loading) return <div className="text-slate-400 text-center py-10">加载中...</div>;
  if (transactions.length === 0) {
    return (
      <div className="text-center py-16 text-slate-500">
        <div className="text-5xl mb-3">📊</div>
        <p>暂无交易记录</p>
        <p className="text-xs mt-1">钱包收支明细会显示在这里</p>
      </div>
    );
  }

  return (
    <div className="space-y-2.5 px-5">
      {transactions.map((tx: any, i: number) => (
        <div key={tx.id || i} className="p-3.5 bg-slate-800/60 rounded-xl border border-slate-700/40 flex items-center justify-between">
          <div>
            <div className="text-white font-medium text-sm">{tx.description || '交易'}</div>
            <div className="text-xs text-slate-400 mt-0.5">{new Date(tx.timestamp).toLocaleString()}</div>
          </div>
          <div className="text-right">
            <div className={tx.type === 'income' ? 'text-green-400 font-bold' : 'text-red-400 font-bold'}>
              {tx.type === 'income' ? '+' : '-'}{tx.amount} {tx.currency}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ==================== 主页面 ====================

export default function PersonalCenter() {
  const { isAuthenticated } = useAuth();
  const [activeTab, setActiveTab] = useState<Tab>('vouchers');

  const tabs: { key: Tab; label: string }[] = [
    { key: 'vouchers', label: '🎫 凭证' },
    { key: 'items', label: '🎒 道具' },
    { key: 'purchases', label: '📋 购买' },
    { key: 'transactions', label: '📊 明细' },
    { key: 'votes', label: '🗳️ 投票' },
  ];

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center text-white">
        <div className="text-center">
          <div className="text-5xl mb-4">🔒</div>
          <p className="text-slate-400">请先登录以查看个人中心</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-900 via-slate-800 to-slate-900 text-white pb-20">
      <WalletOverview />

      {/* Tab Bar */}
      <div className="flex mx-5 mt-4 bg-slate-800/40 rounded-xl p-1">
        {tabs.map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`flex-1 py-2.5 text-xs font-medium rounded-lg transition-all duration-200 ${
              activeTab === tab.key
                ? 'bg-purple-600/40 text-purple-300 shadow-sm'
                : 'text-slate-400 hover:text-slate-300'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="mt-4">
        {activeTab === 'vouchers' && <VoucherAssetPanel />}
        {activeTab === 'items' && <ItemVoucherPanel />}
        {activeTab === 'purchases' && <PurchaseHistoryPanel />}
        {activeTab === 'transactions' && <TransactionPanel />}
        {activeTab === 'votes' && <VoteNotificationPanel />}
      </div>
    </div>
  );
}
