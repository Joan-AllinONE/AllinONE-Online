/**
 * GameDeveloperPanel - 游戏开发者面板
 *
 * 查看游戏销售收入、道具销售统计、提现/再投资。
 * 每日结算：显示待结算的平台分成。
 */
import { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { gameDeveloperService } from '@/services/gameDeveloperService';
import { getPublishedGame } from '@/services/publishedGameService';
import type { PublishedGame } from '@/services/publishedGameService';
import type { GameDeveloperAccount, GameItemSaleStat, DeveloperRevenueTransaction } from '@/types/gameDeveloper';
import {
  TrendingUp, Coins, Wallet, BarChart3, Clock, Package,
  ArrowLeft, RefreshCw, Landmark, Settings, X,
} from 'lucide-react';

interface Props {
  gameId: string;
  onBack: () => void;
}

export default function GameDeveloperPanel({ gameId, onBack }: Props) {
  const [account, setAccount] = useState<GameDeveloperAccount | null>(null);
  const [game, setGame] = useState<PublishedGame | null>(null);
  const [loading, setLoading] = useState(true);
  const [itemSales, setItemSales] = useState<GameItemSaleStat[]>([]);
  const [transactions, setTransactions] = useState<DeveloperRevenueTransaction[]>([]);
  const [showSettleConfirm, setShowSettleConfirm] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const devAccount = await gameDeveloperService.getAccount(gameId);
      setAccount(devAccount || null);

      const pubGame = getPublishedGame(gameId);
      setGame(pubGame);

      if (devAccount) {
        const sales = await gameDeveloperService.getItemSalesStats(gameId);
        setItemSales(sales);
        const txs = await gameDeveloperService.getTransactions(gameId, 20);
        setTransactions(txs);
      }
    } catch (e) {
      console.error('[DevPanel] 加载数据失败:', e);
    } finally {
      setLoading(false);
    }
  }, [gameId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleSettle = async () => {
    if (!account) return;
    const result = await gameDeveloperService.executeDailySettlement(gameId);
    if (result.settledAccounts > 0) {
      alert(result.message);
    } else {
      alert('当前无待结算的分成');
    }
    setShowSettleConfirm(false);
    loadData();
  };

  const formatTime = (ts: number) => {
    const d = new Date(ts);
    return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-purple-900 to-slate-900 flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-purple-500/30 border-t-purple-500 rounded-full animate-spin" />
      </div>
    );
  }

  if (!account && !game) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-purple-900 to-slate-900 flex items-center justify-center">
        <div className="text-center">
          <Package className="w-16 h-16 text-slate-600 mx-auto mb-4" />
          <h2 className="text-xl font-bold text-white mb-2">开发者账户未找到</h2>
          <p className="text-slate-400 mb-4">该游戏尚未设置开发者账户</p>
          <button onClick={onBack} className="px-4 py-2 bg-purple-600 hover:bg-purple-700 rounded-lg font-medium">
            ← 返回
          </button>
        </div>
      </div>
    );
  }

  const availableForWithdraw = account ? Math.max(0, account.availableBalance - account.platformOwed) : 0;

  return (
    <div className="min-h-screen bg-gradient-to-b from-purple-900 via-slate-900 to-slate-900">
      {/* Header */}
      <header className="bg-slate-800/80 backdrop-blur-md border-b border-slate-700 sticky top-0 z-50">
        <div className="container mx-auto px-4 py-4">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div className="flex items-center gap-4">
              <button
                onClick={onBack}
                className="w-10 h-10 rounded-lg bg-slate-700 hover:bg-slate-600 flex items-center justify-center text-white transition-colors"
              >
                <ArrowLeft className="w-5 h-5" />
              </button>
              <div>
                <h1 className="text-xl font-bold text-white flex items-center gap-2">
                  <Settings className="w-5 h-5 text-purple-400" />
                  开发者面板
                </h1>
                <p className="text-sm text-slate-400">{game?.name || gameId}</p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={loadData}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-300 text-sm transition-colors"
                title="刷新数据"
              >
                <RefreshCw className="w-4 h-4" />
                刷新
              </button>
            </div>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8">
        {/* 收入概览 */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          <StatCard
            icon={<Coins className="w-5 h-5 text-yellow-400" />}
            label="累计收入"
            value={(account?.totalRevenue || 0).toLocaleString()}
            suffix="A币"
            color="amber"
          />
          <StatCard
            icon={<Wallet className="w-5 h-5 text-green-400" />}
            label="可提现余额"
            value={availableForWithdraw.toLocaleString()}
            suffix="A币"
            color="green"
          />
          <StatCard
            icon={<Landmark className="w-5 h-5 text-blue-400" />}
            label="待结算分成"
            value={(account?.platformOwed || 0).toLocaleString()}
            suffix={`A币 (${account?.revenueSharePercent || 10}%)`}
            color="cyan"
          />
          <StatCard
            icon={<TrendingUp className="w-5 h-5 text-purple-400" />}
            label="已结算分成"
            value={(account?.platformSettled || 0).toLocaleString()}
            suffix="A币"
            color="purple"
          />
        </div>

        {/* 每日结算 & 分成信息 */}
        <div className="mb-8 p-5 bg-slate-800/60 rounded-xl border border-slate-700/50">
          <h3 className="text-white font-semibold mb-3 flex items-center gap-2">
            <Clock className="w-4 h-4 text-purple-400" />
            结算信息
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm">
            <div>
              <span className="text-slate-400">平台分成比例：</span>
              <span className="text-white font-bold">{account?.revenueSharePercent || 10}%</span>
            </div>
            <div>
              <span className="text-slate-400">待结算：</span>
              <span className="text-amber-400 font-bold">{(account?.platformOwed || 0).toLocaleString()} A币</span>
            </div>
            <div>
              <span className="text-slate-400">上次结算：</span>
              <span className="text-slate-300">{account?.lastDailySettlement ? formatTime(account.lastDailySettlement) : '暂无'}</span>
            </div>
          </div>
          <div className="mt-4">
            <button
              onClick={() => setShowSettleConfirm(true)}
              disabled={!account || account.platformOwed <= 0}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-600 disabled:cursor-not-allowed text-white rounded-lg font-medium text-sm transition-colors"
            >
              <RefreshCw className="w-4 h-4" />
              立即结算（每日自动）
            </button>
            <p className="text-xs text-slate-500 mt-2">
              系统会在每日 00:00 自动结算平台分成。此处可手动触发即时结算。
            </p>
          </div>
        </div>

        {/* 道具销售统计 */}
        <div className="mb-8">
          <h3 className="text-white font-semibold mb-4 flex items-center gap-2">
            <BarChart3 className="w-4 h-4 text-yellow-400" />
            道具销售统计
          </h3>
          {itemSales.length === 0 ? (
            <div className="p-6 bg-slate-800/40 rounded-xl border border-slate-700/30 text-center text-slate-500">
              暂无销售数据
            </div>
          ) : (
            <div className="space-y-3">
              {itemSales.map((item) => (
                <div key={item.templateId} className="p-4 bg-slate-800/60 rounded-xl border border-slate-700/50 flex items-center justify-between flex-wrap gap-3">
                  <div>
                    <h4 className="text-white font-medium">{item.name}</h4>
                    <p className="text-xs text-slate-500">售出 {item.count} 次</p>
                  </div>
                  <div className="text-right">
                    <div className="text-lg font-bold text-amber-400">{item.totalRevenue.toLocaleString()}</div>
                    <span className="text-xs text-slate-500">A币</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 交易历史 */}
        <div>
          <h3 className="text-white font-semibold mb-4 flex items-center gap-2">
            <Clock className="w-4 h-4 text-slate-400" />
            收入记录
          </h3>
          {transactions.length === 0 ? (
            <div className="p-6 bg-slate-800/40 rounded-xl border border-slate-700/30 text-center text-slate-500">
              暂无交易记录
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-slate-500 border-b border-slate-700/50">
                    <th className="pb-2 pr-4 font-medium">时间</th>
                    <th className="pb-2 pr-4 font-medium">类型</th>
                    <th className="pb-2 pr-4 font-medium">金额</th>
                    <th className="pb-2 font-medium">描述</th>
                  </tr>
                </thead>
                <tbody>
                  {transactions.map(tx => {
                    const typeLabel: Record<string, { label: string; color: string }> = {
                      purchase: { label: '收入', color: 'text-green-400' },
                      settlement: { label: '结算', color: 'text-blue-400' },
                      withdrawal: { label: '提现', color: 'text-red-400' },
                      refund: { label: '退款', color: 'text-amber-400' },
                      reinvest: { label: '再投资', color: 'text-purple-400' },
                    };
                    const tl = typeLabel[tx.type] || { label: tx.type, color: 'text-slate-300' };
                    return (
                      <tr key={tx.id} className="border-b border-slate-700/20 hover:bg-slate-800/40 transition-colors">
                        <td className="py-2.5 pr-4 text-slate-400 whitespace-nowrap">{formatTime(tx.timestamp)}</td>
                        <td className="py-2.5 pr-4">
                          <span className={`text-xs font-medium ${tl.color}`}>{tl.label}</span>
                        </td>
                        <td className="py-2.5 pr-4 font-mono font-bold">
                          <span className={tx.type === 'withdrawal' ? 'text-red-400' : 'text-green-400'}>
                            {tx.type === 'withdrawal' ? '-' : '+'}{tx.amount.toLocaleString()}
                          </span>
                        </td>
                        <td className="py-2.5 text-slate-400 max-w-xs truncate">{tx.description}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </main>

      {/* 结算确认弹窗 */}
      <AnimatePresence>
        {showSettleConfirm && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
          >
            <motion.div
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="bg-slate-800 rounded-xl p-6 max-w-sm w-full mx-4 border border-slate-700"
            >
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-bold text-white">确认结算</h3>
                <button onClick={() => setShowSettleConfirm(false)} className="text-slate-400 hover:text-white">
                  <X className="w-5 h-5" />
                </button>
              </div>
              <p className="text-slate-300 text-sm mb-2">
                将结算 <span className="text-amber-400 font-bold">{(account?.platformOwed || 0).toLocaleString()} A币</span> 的平台分成至平台金库。
              </p>
              <p className="text-slate-500 text-xs mb-6">
                分成比例: {account?.revenueSharePercent || 10}%，结算后不可撤销。
              </p>
              <div className="flex gap-3">
                <button
                  onClick={() => setShowSettleConfirm(false)}
                  className="flex-1 py-2 px-4 bg-slate-700 hover:bg-slate-600 text-white rounded-lg font-medium text-sm transition-colors"
                >
                  取消
                </button>
                <button
                  onClick={handleSettle}
                  className="flex-1 py-2 px-4 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium text-sm transition-colors"
                >
                  确认结算
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ==================== 子组件 ====================

function StatCard({ icon, label, value, suffix, color = 'purple' }: {
  icon: React.ReactNode; label: string; value: string; suffix?: string; color?: string;
}) {
  const colorMap: Record<string, string> = {
    purple: 'border-purple-500/20 bg-purple-500/5',
    cyan: 'border-cyan-500/20 bg-cyan-500/5',
    amber: 'border-amber-500/20 bg-amber-500/5',
    green: 'border-green-500/20 bg-green-500/5',
    red: 'border-red-500/20 bg-red-500/5',
  };

  return (
    <div className={`p-4 rounded-xl border ${colorMap[color] || colorMap.purple}`}>
      <div className="flex items-center gap-2 mb-2">
        {icon}
        <span className="text-xs text-slate-400">{label}</span>
      </div>
      <div className="text-2xl font-bold text-white">
        {value}
        {suffix && <span className="text-sm font-normal text-slate-400 ml-1">{suffix}</span>}
      </div>
    </div>
  );
}
