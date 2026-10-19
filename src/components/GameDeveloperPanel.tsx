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
    // 「立即结算」= 手动强制结算，跳过 24h 日结周期门槛（platformOwed > 0 即结）
    const result = await gameDeveloperService.executeDailySettlement(gameId, { force: true });
    if (result.settledAccounts > 0) {
      alert(result.message);
    } else {
      alert('当前无待结算的分成');
    }
    setShowSettleConfirm(false);
    loadData();
  };

  // 🆕 创作者分成发放：把 creatorOwed 累积的份额转移到创作者（提案配置的 creatorId）
  const [showCreatorPayConfirm, setShowCreatorPayConfirm] = useState(false);
  const handlePayCreator = async () => {
    if (!account?.revenueSharing?.creatorId) return;
    const amount = account.creatorOwed || 0;
    if (amount <= 0) {
      alert('创作者暂无待结算分成');
      setShowCreatorPayConfirm(false);
      return;
    }
    const result = await gameDeveloperService.withdrawCreatorRevenue({
      gameId,
      amount,
      creatorId: account.revenueSharing.creatorId,
      creatorName: account.revenueSharing.creatorName || account.revenueSharing.creatorId,
    });
    alert(result.message);
    setShowCreatorPayConfirm(false);
    loadData();
  };

  // 🆕 游戏方提现：可提现净额转入发布者个人账户
  const [showWithdrawConfirm, setShowWithdrawConfirm] = useState(false);
  const handleWithdraw = async () => {
    if (!account) return;
    const amount = availableForWithdraw;
    if (amount <= 0) {
      alert('暂无可提现余额');
      setShowWithdrawConfirm(false);
      return;
    }
    const result = await gameDeveloperService.withdrawRevenue({
      gameId,
      amount,
      toUserId: account.publisherId,
      toUserName: account.publisherName,
    });
    alert(result.message);
    setShowWithdrawConfirm(false);
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

  // 可提现 = 总余额 - 平台待结算 - 创作者待结算（creatorOwed 是余额上的留置权）
  const availableForWithdraw = account
    ? Math.max(0, account.availableBalance - account.platformOwed - (account.creatorOwed || 0))
    : 0;

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
          <StatCard
            icon={<Coins className="w-5 h-5 text-sky-400" />}
            label="游戏币收入"
            value={(account?.gameCoinsRevenue || 0).toLocaleString()}
            suffix="gameCoins · 即时分账"
            color="cyan"
          />
        </div>

        {/* 每日结算 & 分成信息 */}
        <div className="mb-8 p-5 bg-slate-800/60 rounded-xl border border-slate-700/50">
          <h3 className="text-white font-semibold mb-3 flex items-center gap-2">
            <Clock className="w-4 h-4 text-purple-400" />
            结算信息
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 text-sm">
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
            <div>
              <span className="text-slate-400">游戏币（gameCoins）：</span>
              <span className="text-sky-300 font-bold">已即时分账</span>
              <span className="text-slate-500 text-xs ml-1">累计 {(account?.gameCoinsRevenue || 0).toLocaleString()}</span>
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
              本环节仅结算 <span className="text-amber-400/80">A币凭证</span>分成（实物进游戏商账户沉淀为待结算）；
              <span className="text-sky-300/80">游戏币收入不经过待结算环节</span>——玩家支付时已按分成比例即时入账各方钱包：游戏方→发布者个人钱包、平台→平台金库、创作者→创作者个人钱包。
            </p>
          </div>
        </div>

        {/* 🆕 三方分成（GameProposal 通过后生效；每笔道具销售按此分账） */}
        <div className="mb-8 p-5 bg-slate-800/60 rounded-xl border border-amber-700/40">
          <h3 className="text-white font-semibold mb-3 flex items-center gap-2">
            <TrendingUp className="w-4 h-4 text-amber-400" />
            三方分成
          </h3>
          {account?.revenueSharing ? (
            <>
              <div className="flex h-5 overflow-hidden rounded-full mb-3 max-w-md">
                <div className="flex items-center justify-center bg-purple-500 text-[10px] text-white"
                  style={{ width: `${Math.round(account.revenueSharing.gameShare * 100)}%` }}>
                  游戏 {Math.round(account.revenueSharing.gameShare * 100)}%
                </div>
                <div className="flex items-center justify-center bg-pink-500 text-[10px] text-white"
                  style={{ width: `${Math.round(account.revenueSharing.platformShare * 100)}%` }}>
                  平台 {Math.round(account.revenueSharing.platformShare * 100)}%
                </div>
                {account.revenueSharing.creatorShare > 0 && (
                  <div className="flex items-center justify-center bg-amber-500 text-[10px] text-white"
                    style={{ width: `${Math.round(account.revenueSharing.creatorShare * 100)}%` }}>
                    创作者 {Math.round(account.revenueSharing.creatorShare * 100)}%
                  </div>
                )}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm">
                <div>
                  <span className="text-slate-400">创作者：</span>
                  <span className="text-amber-300 font-bold">
                    {account.revenueSharing.creatorName || account.revenueSharing.creatorId || '未指定（未配置创作者分成）'}
                  </span>
                </div>
                <div>
                  <span className="text-slate-400">创作者待领取：</span>
                  <span className="text-amber-400 font-bold">{(account.creatorOwed || 0).toLocaleString()} A币</span>
                  <span className="text-slate-500 text-xs ml-1">已领 {(account.creatorSettled || 0).toLocaleString()}</span>
                </div>
                <div>
                  <span className="text-slate-400">来源：</span>
                  <span className="font-mono text-xs text-slate-300">{account.revenueSharing.source}</span>
                </div>
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  onClick={() => setShowCreatorPayConfirm(true)}
                  disabled={(account.creatorOwed || 0) <= 0 || !account.revenueSharing.creatorId}
                  className="flex items-center gap-2 px-4 py-2 bg-amber-600 hover:bg-amber-500 disabled:bg-slate-600 disabled:cursor-not-allowed text-white rounded-lg font-medium text-sm transition-colors"
                >
                  <Coins className="w-4 h-4" />
                  发放创作者分成（{(account.creatorOwed || 0).toLocaleString()} A币）
                </button>
                <button
                  onClick={() => setShowWithdrawConfirm(true)}
                  disabled={availableForWithdraw <= 0}
                  className="flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-500 disabled:bg-slate-600 disabled:cursor-not-allowed text-white rounded-lg font-medium text-sm transition-colors"
                >
                  <Wallet className="w-4 h-4" />
                  游戏方提现（{availableForWithdraw.toLocaleString()} A币）
                </button>
              </div>
              <p className="text-xs text-slate-500 mt-2">
                创作者份额发放至提案配置的创作者账户（{account.revenueSharing.creatorId || '未指定'}）；游戏方净额提现至发布者（{account.publisherName}）。凭证均从本游戏商账户（game-{account.gameId}）转移。
              </p>
            </>
          ) : (
            <p className="text-sm text-slate-500">
              该游戏未配置三方分成，走平台默认：平台抽成 {account?.revenueSharePercent || 10}%，其余归游戏方。
              如需三方分成，发起带收益分配的 GameProposal 并投票通过。
              <br />
              <span className="text-xs text-slate-400">
                说明：本游戏的收入归属方是发布者（{account?.publisherName || account?.publisherId || '未知'}）；
                「创作者」是提案中显式指定的额外分成对象，不会自动取发布者身份——未配置时显示「未指定」属正常状态。
              </span>
            </p>
          )}
          {(account?.gameCoinsRevenue || 0) > 0 && (() => {
            // 从交易记录聚合游戏币分账去向（metadata.credits 由服务端 gamecoins-split 写入）
            const agg = { game: 0, platform: 0, creator: 0 };
            const creatorIds = new Set<string>();
            for (const tx of transactions) {
              if (tx.currency !== 'gameCoins' || !Array.isArray(tx.metadata?.credits)) continue;
              for (const c of tx.metadata.credits) {
                if (c?.role === 'game') agg.game += Number(c.amount) || 0;
                else if (c?.role === 'platform') agg.platform += Number(c.amount) || 0;
                else if (c?.role === 'creator') {
                  agg.creator += Number(c.amount) || 0;
                  if (c.userId) creatorIds.add(c.userId);
                }
              }
            }
            return (
              <div className="mt-3 border-t border-slate-700 pt-3">
                <p className="text-xs text-sky-300/90">
                  🎮 游戏币收入累计 {(account!.gameCoinsRevenue || 0).toLocaleString()} gameCoins——购买时已按分成比例【即时分账】至各方服务端钱包，无待结算环节：
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mt-2 text-xs">
                  <div className="p-2 bg-slate-900/40 rounded border border-slate-700/40">
                    <div className="text-slate-400">游戏方（发布者 {account?.publisherId || '未知'}）</div>
                    <div className="text-green-400 font-bold">+{agg.game.toLocaleString()} gameCoins</div>
                  </div>
                  <div className="p-2 bg-slate-900/40 rounded border border-slate-700/40">
                    <div className="text-slate-400">平台（platform_treasury 金库）</div>
                    <div className="text-blue-400 font-bold">+{agg.platform.toLocaleString()} gameCoins</div>
                  </div>
                  <div className="p-2 bg-slate-900/40 rounded border border-slate-700/40">
                    <div className="text-slate-400">创作者（{creatorIds.size > 0 ? Array.from(creatorIds).join('、') : '未配置'}）</div>
                    <div className="text-amber-400 font-bold">+{agg.creator.toLocaleString()} gameCoins</div>
                  </div>
                </div>
                {(() => {
                  const detail = transactions
                    .filter(t => t.currency === 'gameCoins' && t.metadata?.split)
                    .slice(0, 10);
                  if (detail.length === 0) return null;
                  return (
                    <div className="mt-2 overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="text-slate-500 text-left border-b border-slate-700/40">
                            <th className="py-1.5 pr-3 font-normal">时间</th>
                            <th className="py-1.5 pr-3 font-normal">明细</th>
                            <th className="py-1.5 pr-3 font-normal text-right">游戏方</th>
                            <th className="py-1.5 pr-3 font-normal text-right">平台</th>
                            <th className="py-1.5 font-normal text-right">创作者</th>
                          </tr>
                        </thead>
                        <tbody>
                          {detail.map(tx => {
                            const sp = tx.metadata?.split || {};
                            return (
                              <tr key={tx.id} className="border-b border-slate-800/60">
                                <td className="py-1.5 pr-3 text-slate-400 whitespace-nowrap">{formatTime(tx.timestamp)}</td>
                                <td className="py-1.5 pr-3 text-slate-300 max-w-xs truncate">{tx.description}</td>
                                <td className="py-1.5 pr-3 text-right text-green-400 font-mono">+{Number(sp.gameCut || 0)}</td>
                                <td className="py-1.5 pr-3 text-right text-blue-400 font-mono">+{Number(sp.platformCut || 0)}</td>
                                <td className="py-1.5 text-right text-amber-400 font-mono">+{Number(sp.creatorCut || 0)}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                      <p className="text-[10px] text-slate-500 mt-1">最近 {detail.length} 笔分账明细（每列即该方实际入账 gameCoins）。</p>
                    </div>
                  );
                })()}
                <p className="text-[10px] text-slate-500 mt-1.5">
                  口径：最近 {transactions.length} 笔交易聚合。入账在服务端账本（users.gameCoins），浏览器钱包页以对应账号登录即可看到（本地 dev 需后端可达）。
                </p>
              </div>
            );
          })()}
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
                          <span className={`ml-1 text-[10px] font-normal ${tx.currency === 'gameCoins' ? 'text-sky-400' : 'text-amber-400/70'}`}>
                            {tx.currency === 'gameCoins' ? '游戏币' : 'A币'}
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

      {/* 🆕 创作者分成发放确认弹窗 */}
      <AnimatePresence>
        {showCreatorPayConfirm && (
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
                <h3 className="text-lg font-bold text-white">确认发放创作者分成</h3>
                <button onClick={() => setShowCreatorPayConfirm(false)} className="text-slate-400 hover:text-white">
                  <X className="w-5 h-5" />
                </button>
              </div>
              <p className="text-slate-300 text-sm mb-2">
                将发放 <span className="text-amber-400 font-bold">{(account?.creatorOwed || 0).toLocaleString()} A币</span>
                至创作者 <span className="text-amber-300">{account?.revenueSharing?.creatorName || account?.revenueSharing?.creatorId}</span>。
              </p>
              <p className="text-slate-500 text-xs mb-6">
                凭证从游戏商账户（game-{account?.gameId}）转移，发放后不可撤销。
              </p>
              <div className="flex gap-3">
                <button onClick={() => setShowCreatorPayConfirm(false)}
                  className="flex-1 py-2 px-4 bg-slate-700 hover:bg-slate-600 text-white rounded-lg font-medium text-sm transition-colors">
                  取消
                </button>
                <button onClick={handlePayCreator}
                  className="flex-1 py-2 px-4 bg-amber-600 hover:bg-amber-500 text-white rounded-lg font-medium text-sm transition-colors">
                  确认发放
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 🆕 游戏方提现确认弹窗 */}
      <AnimatePresence>
        {showWithdrawConfirm && (
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
                <h3 className="text-lg font-bold text-white">确认游戏方提现</h3>
                <button onClick={() => setShowWithdrawConfirm(false)} className="text-slate-400 hover:text-white">
                  <X className="w-5 h-5" />
                </button>
              </div>
              <p className="text-slate-300 text-sm mb-2">
                将提现净额 <span className="text-green-400 font-bold">{availableForWithdraw.toLocaleString()} A币</span>
                至发布者 <span className="text-green-300">{account?.publisherName}</span>。
              </p>
              <p className="text-slate-500 text-xs mb-6">
                净额 = 总余额 − 平台待结算 − 创作者待结算。发放后不可撤销。
              </p>
              <div className="flex gap-3">
                <button onClick={() => setShowWithdrawConfirm(false)}
                  className="flex-1 py-2 px-4 bg-slate-700 hover:bg-slate-600 text-white rounded-lg font-medium text-sm transition-colors">
                  取消
                </button>
                <button onClick={handleWithdraw}
                  className="flex-1 py-2 px-4 bg-green-600 hover:bg-green-500 text-white rounded-lg font-medium text-sm transition-colors">
                  确认提现
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
