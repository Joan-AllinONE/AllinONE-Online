/**
 * PlatformAdmin - 平台管理中心 (MVP v1.2)
 *
 * 管理员专属页面，提供金库概览、收入明细、交易历史、游戏商店管理。
 * 整合旧 /platform-store-manage 路由。
 */
import { useState, useEffect, useCallback } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useAuth } from '@/contexts/authContext';
import { platformTreasuryService, type TreasuryReport, type TreasuryTransaction, type RevenueBreakdown, type PlatformVoucherHolding } from '@/services/platformTreasuryService';
import { gameDeveloperService } from '@/services/gameDeveloperService';
import type { GameDeveloperOverview } from '@/types/gameDeveloper';
import PlatformGameStoreManager from '@/components/PlatformGameStoreManager';
import { PoolFundPanel } from '@/voucher-system/components/PoolFundPanel';
import {
  Shield, Coins, TrendingUp, Calendar, History, Store, ArrowLeft,
  Wallet, Landmark, Receipt, BarChart3, FileText, Package, Ticket,
  Gift, Gamepad2, Percent, Users, RefreshCw,
} from 'lucide-react';

// ==================== Tab 定义 ====================

type TabId = 'overview' | 'developers' | 'revenue' | 'history' | 'vouchers' | 'pool' | 'store';

const TABS: { id: TabId; label: string; icon: React.ReactNode }[] = [
  { id: 'overview', label: '金库概览', icon: <Landmark className="w-4 h-4" /> },
  { id: 'developers', label: '游戏商总览', icon: <Gamepad2 className="w-4 h-4" /> },
  { id: 'revenue', label: '收入明细', icon: <BarChart3 className="w-4 h-4" /> },
  { id: 'history', label: '交易历史', icon: <Receipt className="w-4 h-4" /> },
  { id: 'vouchers', label: '凭证资产', icon: <Ticket className="w-4 h-4" /> },
  { id: 'pool', label: '奖池管理', icon: <Gift className="w-4 h-4" /> },
  { id: 'store', label: '商店管理', icon: <Store className="w-4 h-4" /> },
];

// ==================== 子组件 ====================

function ErrorState({ message = '无法加载数据，请先登录管理员账号' }: { message?: string }) {
  const navigate = useNavigate();
  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-900 to-slate-800 flex items-center justify-center">
      <div className="text-center">
        <Shield className="w-16 h-16 text-slate-600 mx-auto mb-4" />
        <p className="text-slate-400 mb-4">{message}</p>
        <button
          onClick={() => navigate('/')}
          className="px-4 py-2 bg-purple-600 hover:bg-purple-700 rounded-lg text-sm font-medium"
        >
          ← 返回基地
        </button>
      </div>
    </div>
  );
}

function TabBar({ active, onChange }: { active: TabId; onChange: (id: TabId) => void }) {
  return (
    <div className="flex gap-1 p-1 bg-slate-800/50 rounded-xl border border-slate-700/50">
      {TABS.map(t => (
        <button
          key={t.id}
          onClick={() => onChange(t.id)}
          className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
            active === t.id
              ? 'bg-purple-600 text-white shadow-lg shadow-purple-600/20'
              : 'text-slate-400 hover:text-white hover:bg-slate-700/50'
          }`}
        >
          {t.icon}
          {t.label}
        </button>
      ))}
    </div>
  );
}

function StatCard({ icon, label, value, suffix, color = 'purple' }: {
  icon: React.ReactNode; label: string; value: string; suffix?: string; color?: string;
}) {
  const colorMap: Record<string, string> = {
    purple: 'border-purple-500/20 bg-purple-500/5',
    cyan: 'border-cyan-500/20 bg-cyan-500/5',
    amber: 'border-amber-500/20 bg-amber-500/5',
    green: 'border-green-500/20 bg-green-500/5',
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

// ==================== Tab: 金库概览 ====================

function OverviewTab({ report, loading }: { report: TreasuryReport | null; loading: boolean }) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="w-6 h-6 border-2 border-purple-500/30 border-t-purple-500 rounded-full animate-spin" />
        <span className="ml-3 text-slate-400">加载金库数据...</span>
      </div>
    );
  }

  if (!report) {
    return <div className="py-10 text-center text-slate-500">暂无金库数据</div>;
  }

  const { balance, cumulative, todayIncome, monthlyIncome, totalTransactions } = report;

  return (
    <div className="space-y-6">
      {/* 余额卡片 */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          icon={<Coins className="w-4 h-4 text-yellow-500" />}
          label="金库 gameCoins"
          value={balance.gameCoins.toLocaleString()}
          suffix="GC"
          color="amber"
        />
        <StatCard
          icon={<Wallet className="w-4 h-4 text-blue-400" />}
          label="金库 A币"
          value={balance.aCoins.toLocaleString()}
          suffix="A币"
          color="cyan"
        />
        <StatCard
          icon={<TrendingUp className="w-4 h-4 text-green-400" />}
          label="今日收入"
          value={(todayIncome.gameCoins + todayIncome.aCoins).toLocaleString()}
          color="green"
        />
        <StatCard
          icon={<Calendar className="w-4 h-4 text-purple-400" />}
          label="本月收入"
          value={(monthlyIncome.gameCoins + monthlyIncome.aCoins).toLocaleString()}
          color="purple"
        />
      </div>

      {/* 累计分类 */}
      <div className="p-5 bg-slate-800/60 rounded-xl border border-slate-700/50">
        <h3 className="text-sm font-semibold text-white mb-4 flex items-center gap-2">
          <BarChart3 className="w-4 h-4 text-purple-400" />
          累计收入分类
        </h3>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          {[
            { label: 'P2P 交易佣金', value: cumulative.p2pCommission, color: 'text-purple-400' },
            { label: '提案押金没收', value: cumulative.proposalForfeit, color: 'text-cyan-400' },
            { label: '凭证规则回收', value: cumulative.voucherRecycle, color: 'text-amber-400' },
            { label: '平台手续费', value: cumulative.platformCollect, color: 'text-green-400' },
          ].map(item => (
            <div key={item.label} className="text-center">
              <div className={`text-xl font-bold ${item.color}`}>{item.value.toLocaleString()}</div>
              <div className="text-xs text-slate-500 mt-1">{item.label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* 统计信息 */}
      <div className="flex items-center gap-6 text-xs text-slate-500 p-4 bg-slate-800/40 rounded-xl border border-slate-700/30">
        <div className="flex items-center gap-1.5">
          <Receipt className="w-3.5 h-3.5" />
          累计 {totalTransactions} 笔交易
        </div>
        <div className="flex items-center gap-1.5">
          <TrendingUp className="w-3.5 h-3.5" />
          今日 gameCoins: +{todayIncome.gameCoins.toLocaleString()} GC
        </div>
        <div className="flex items-center gap-1.5">
          <TrendingUp className="w-3.5 h-3.5" />
          今日 A币: +{todayIncome.aCoins.toLocaleString()} A币
        </div>
      </div>
    </div>
  );
}

// ==================== Tab: 收入明细 ====================

function RevenueTab({ report, loading }: { report: TreasuryReport | null; loading: boolean }) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="w-6 h-6 border-2 border-purple-500/30 border-t-purple-500 rounded-full animate-spin" />
      </div>
    );
  }

  if (!report) {
    return <div className="py-10 text-center text-slate-500">暂无收入数据</div>;
  }

  const items: { source: string; icon: string; label: string; description: string; color: string }[] = [
    {
      source: 'p2p_commission',
      icon: '🏪',
      label: 'P2P 交易佣金',
      description: '玩家交易市场每笔成交抽取 5%，由买家承担',
      color: 'text-purple-400',
    },
    {
      source: 'proposal_forfeit',
      icon: '🗳️',
      label: '提案押金没收',
      description: '游戏内容提案未通过时，押金收归平台',
      color: 'text-cyan-400',
    },
    {
      source: 'voucher_recycle',
      icon: '🔄',
      label: '凭证规则回收',
      description: '过期/消耗的凭证按规则引擎回收至金库',
      color: 'text-amber-400',
    },
    {
      source: 'platform_collect',
      icon: '🏛️',
      label: '平台手续费',
      description: '凭证流转、铸造等环节的平台服务费',
      color: 'text-green-400',
    },
  ];

  return (
    <div className="space-y-4">
      {items.map(item => {
        let amount = 0;
        switch (item.source) {
          case 'p2p_commission': amount = report.cumulative.p2pCommission; break;
          case 'proposal_forfeit': amount = report.cumulative.proposalForfeit; break;
          case 'voucher_recycle': amount = report.cumulative.voucherRecycle; break;
          case 'platform_collect': amount = report.cumulative.platformCollect; break;
        }

        return (
          <div
            key={item.source}
            className="p-4 bg-slate-800/60 rounded-xl border border-slate-700/50 flex items-center justify-between flex-wrap gap-3"
          >
            <div className="flex items-center gap-3">
              <span className="text-2xl">{item.icon}</span>
              <div>
                <h4 className="font-semibold text-white">{item.label}</h4>
                <p className="text-xs text-slate-500 mt-0.5">{item.description}</p>
              </div>
            </div>
            <div className="text-right">
              <div className={`text-xl font-bold ${item.color}`}>
                {amount.toLocaleString()}
              </div>
              <span className="text-xs text-slate-500">累计收入</span>
            </div>
          </div>
        );
      })}

      {Object.values(report.cumulative).every(v => v === 0) && (
        <p className="py-10 text-center text-slate-500">暂未产生任何平台收入</p>
      )}
    </div>
  );
}

// ==================== Tab: 游戏商总览 ====================

function DevelopersTab() {
  const [overview, setOverview] = useState<GameDeveloperOverview[]>([]);
  const [loading, setLoading] = useState(true);
  const [percentInputs, setPercentInputs] = useState<Record<string, number>>({});

  const loadDevs = useCallback(async () => {
    setLoading(true);
    try {
      const data = await gameDeveloperService.getDeveloperOverview();
      setOverview(data);
      const inputs: Record<string, number> = {};
      for (const d of data) {
        inputs[d.gameId] = d.revenueSharePercent;
      }
      setPercentInputs(inputs);
    } catch (e) {
      console.warn('[DevsTab] 加载失败:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadDevs(); }, [loadDevs]);

  const handleSettleAll = async () => {
    const result = await gameDeveloperService.executeDailySettlement();
    alert(result.message);
    loadDevs();
  };

  const handleUpdatePercent = async (gameId: string) => {
    const newPercent = percentInputs[gameId];
    if (newPercent < 0 || newPercent > 100) {
      alert('分成比例需在 0-100 之间');
      return;
    }
    await gameDeveloperService.updateAccount(gameId, { revenueSharePercent: newPercent });
    loadDevs();
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="w-6 h-6 border-2 border-purple-500/30 border-t-purple-500 rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* 操作栏 */}
      <div className="flex items-center justify-between flex-wrap gap-3 p-4 bg-slate-800/60 rounded-xl border border-slate-700/50">
        <div>
          <h3 className="text-white font-semibold text-sm">游戏商账户概览</h3>
          <p className="text-xs text-slate-500 mt-1">共 {overview.length} 个游戏商账户，平台按比例自动分成</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={handleSettleAll}
            className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium text-sm transition-colors"
          >
            <RefreshCw className="w-4 h-4" />
            批量每日结算
          </button>
          <button
            onClick={loadDevs}
            className="flex items-center gap-1.5 px-4 py-2 bg-slate-700 hover:bg-slate-600 text-slate-300 rounded-lg font-medium text-sm transition-colors"
          >
            <RefreshCw className="w-4 h-4" />
            刷新
          </button>
        </div>
      </div>

      {/* 统计卡 */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          icon={<Gamepad2 className="w-4 h-4 text-purple-400" />}
          label="游戏商总数"
          value={overview.length.toString()}
          suffix="个"
          color="purple"
        />
        <StatCard
          icon={<Coins className="w-4 h-4 text-yellow-400" />}
          label="游戏商总收入"
          value={overview.reduce((s, d) => s + d.totalRevenue, 0).toLocaleString()}
          suffix="A币"
          color="amber"
        />
        <StatCard
          icon={<Landmark className="w-4 h-4 text-blue-400" />}
          label="待结算分成"
          value={overview.reduce((s, d) => s + d.platformOwed, 0).toLocaleString()}
          suffix="A币"
          color="cyan"
        />
        <StatCard
          icon={<TrendingUp className="w-4 h-4 text-green-400" />}
          label="已结算分成"
          value={overview.reduce((s, d) => s + d.platformSettled, 0).toLocaleString()}
          suffix="A币"
          color="green"
        />
      </div>

      {/* 表格 */}
      {overview.length === 0 ? (
        <div className="py-10 text-center text-slate-500">
          <Gamepad2 className="w-12 h-12 text-slate-600 mx-auto mb-3" />
          <p>暂无游戏商账户</p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500 border-b border-slate-700/50">
                <th className="pb-2 pr-4 font-medium">游戏</th>
                <th className="pb-2 pr-4 font-medium">发布者</th>
                <th className="pb-2 pr-4 font-medium text-right">累计收入</th>
                <th className="pb-2 pr-4 font-medium text-right">可用余额</th>
                <th className="pb-2 pr-4 font-medium text-right">待结算</th>
                <th className="pb-2 pr-4 font-medium text-center">分成%</th>
                <th className="pb-2 pr-4 font-medium">状态</th>
                <th className="pb-2 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {overview.map(dev => (
                <tr key={dev.accountId} className="border-b border-slate-700/20 hover:bg-slate-800/40 transition-colors">
                  <td className="py-2.5 pr-4">
                    <div className="flex items-center gap-2">
                      <Gamepad2 className="w-4 h-4 text-purple-400" />
                      <span className="text-white font-medium">{dev.gameName}</span>
                    </div>
                  </td>
                  <td className="py-2.5 pr-4 text-slate-300">{dev.publisherName}</td>
                  <td className="py-2.5 pr-4 text-right font-mono font-bold text-amber-400">
                    {dev.totalRevenue.toLocaleString()}
                  </td>
                  <td className="py-2.5 pr-4 text-right font-mono text-green-400">
                    {dev.availableBalance.toLocaleString()}
                  </td>
                  <td className="py-2.5 pr-4 text-right font-mono text-blue-400">
                    {dev.platformOwed.toLocaleString()}
                  </td>
                  <td className="py-2.5 pr-4 text-center">
                    <div className="flex items-center justify-center gap-1">
                      <input
                        type="number"
                        min="0"
                        max="100"
                        value={percentInputs[dev.gameId] ?? dev.revenueSharePercent}
                        onChange={(e) => setPercentInputs(prev => ({ ...prev, [dev.gameId]: parseInt(e.target.value) || 0 }))}
                        className="w-14 px-1.5 py-1 bg-slate-700 border border-slate-600 rounded text-center text-xs text-white [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                      />
                      <span className="text-xs text-slate-500">%</span>
                    </div>
                  </td>
                  <td className="py-2.5 pr-4">
                    <span className={`px-1.5 py-0.5 rounded text-xs ${dev.status === 'active' ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}`}>
                      {dev.status === 'active' ? '正常' : dev.status}
                    </span>
                  </td>
                  <td className="py-2.5">
                    <button
                      onClick={() => handleUpdatePercent(dev.gameId)}
                      className="px-2 py-1 bg-purple-600/20 hover:bg-purple-600/40 text-purple-400 rounded text-xs transition-colors"
                    >
                      更新
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 结算提示 */}
      <div className="p-4 bg-slate-800/40 rounded-xl border border-slate-700/30 text-xs text-slate-500">
        <p>💡 每日 00:00 自动结算平台分成。点击"批量每日结算"可手动触发即时结算。双击分成百分比单元格可直接修改。</p>
      </div>
    </div>
  );
}

// ==================== Tab: 交易历史 ====================

function HistoryTab({ report, loading }: { report: TreasuryReport | null; loading: boolean }) {
  const [txs, setTxs] = useState<TreasuryTransaction[]>([]);

  useEffect(() => {
    setTxs(platformTreasuryService.getTransactions());
  }, [report]);

  const sourceLabel = (s: string): string => {
    const map: Record<string, string> = {
      p2p_commission: 'P2P 佣金',
      proposal_forfeit: '提案没收',
      voucher_recycle: '凭证回收',
      voucher_expire: '凭证过期',
      platform_collect: '平台手续费',
    };
    return map[s] || s;
  };

  const formatTime = (ts: number) => {
    const d = new Date(ts);
    return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="w-6 h-6 border-2 border-purple-500/30 border-t-purple-500 rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {txs.length === 0 ? (
        <p className="py-10 text-center text-slate-500">暂无交易记录</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500 border-b border-slate-700/50">
                <th className="pb-2 pr-4 font-medium">时间</th>
                <th className="pb-2 pr-4 font-medium">来源</th>
                <th className="pb-2 pr-4 font-medium">货币</th>
                <th className="pb-2 pr-4 font-medium text-right">金额</th>
                <th className="pb-2 font-medium">描述</th>
              </tr>
            </thead>
            <tbody>
              {txs.map(tx => (
                <tr key={tx.id} className="border-b border-slate-700/20 hover:bg-slate-800/40 transition-colors">
                  <td className="py-2.5 pr-4 text-slate-400 whitespace-nowrap">{formatTime(tx.timestamp)}</td>
                  <td className="py-2.5 pr-4">
                    <span className="px-1.5 py-0.5 bg-slate-700 rounded text-xs text-slate-300">
                      {sourceLabel(tx.source)}
                    </span>
                  </td>
                  <td className="py-2.5 pr-4">
                    <span className={tx.currency === 'gameCoins' ? 'text-yellow-400' : 'text-blue-400'}>
                      {tx.currency === 'gameCoins' ? 'GC' : 'A币'}
                    </span>
                  </td>
                  <td className="py-2.5 pr-4 text-right font-mono font-bold">
                    <span className={tx.currency === 'gameCoins' ? 'text-yellow-300' : 'text-blue-300'}>
                      +{tx.amount.toLocaleString()}
                    </span>
                  </td>
                  <td className="py-2.5 text-slate-400 max-w-xs truncate">{tx.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ==================== Tab: 凭证资产 ====================

function VoucherAssetsTab({ report, loading }: { report: TreasuryReport | null; loading: boolean }) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="w-6 h-6 border-2 border-purple-500/30 border-t-purple-500 rounded-full animate-spin" />
      </div>
    );
  }

  const vh = report?.vouchers;

  if (!vh) {
    return (
      <div className="py-10 text-center text-slate-500">
        <Ticket className="w-12 h-12 text-slate-600 mx-auto mb-3" />
        <p>无法加载凭证数据，请确认凭证系统已初始化</p>
      </div>
    );
  }

  const statusLabels: Record<string, { label: string; color: string }> = {
    active: { label: '流通中', color: 'text-green-400 bg-green-500/10' },
    frozen: { label: '冻结中', color: 'text-blue-400 bg-blue-500/10' },
    expired: { label: '已过期', color: 'text-slate-400 bg-slate-500/10' },
    destroyed: { label: '已销毁', color: 'text-red-400 bg-red-500/10' },
    redeemed: { label: '已使用', color: 'text-amber-400 bg-amber-500/10' },
  };

  const sortedDenoms = Object.keys(vh.byDenomination).map(Number).sort((a, b) => a - b);

  return (
    <div className="space-y-6">
      {/* 总览卡片 */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          icon={<Ticket className="w-4 h-4 text-blue-400" />}
          label="凭证总面额（A币）"
          value={vh.totalFaceValue.toLocaleString()}
          suffix="A币"
          color="cyan"
        />
        <StatCard
          icon={<Package className="w-4 h-4 text-purple-400" />}
          label="持有凭证总数"
          value={vh.totalCount.toLocaleString()}
          suffix="张"
          color="purple"
        />
        <StatCard
          icon={<Wallet className="w-4 h-4 text-green-400" />}
          label="流通中"
          value={(vh.byStatus['active']?.count || 0).toLocaleString()}
          suffix="张"
          color="green"
        />
        <StatCard
          icon={<Shield className="w-4 h-4 text-blue-400" />}
          label="冻结中"
          value={(vh.byStatus['frozen']?.count || 0).toLocaleString()}
          suffix="张"
          color="cyan"
        />
      </div>

      {/* 两个账户拆分 */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {[
          { a: vh.accounts.treasury, icon: '🏛️', border: 'border-amber-500/20' },
          { a: vh.accounts.pool, icon: '🔄', border: 'border-purple-500/20' },
        ].map(({ a, icon, border }) => (
          <div key={a.accountId} className={`p-4 bg-slate-800/60 rounded-xl border ${border}`}>
            <div className="flex items-center gap-2 mb-3">
              <span className="text-xl">{icon}</span>
              <div>
                <h4 className="font-semibold text-white text-sm">{a.accountName}</h4>
                <p className="text-xs text-slate-500">{a.description}</p>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3 text-center">
              <div>
                <div className="text-lg font-bold text-amber-300">{a.totalFaceValue.toLocaleString()}</div>
                <div className="text-xs text-slate-500">面额 (A币)</div>
              </div>
              <div>
                <div className="text-lg font-bold text-white">{a.voucherCount}</div>
                <div className="text-xs text-slate-500">总凭证</div>
              </div>
              <div>
                <div className="text-lg font-bold text-green-400">{a.activeCount}</div>
                <div className="text-xs text-slate-500">活跃</div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* 面额分布 */}
      <div className="p-5 bg-slate-800/60 rounded-xl border border-slate-700/50">
        <h3 className="text-sm font-semibold text-white mb-4 flex items-center gap-2">
          <BarChart3 className="w-4 h-4 text-blue-400" />
          凭证面额分布
        </h3>
        {sortedDenoms.length === 0 ? (
          <p className="text-slate-500 text-sm">暂无凭证数据</p>
        ) : (
          <div className="space-y-3">
            {sortedDenoms.map(denom => {
              const d = vh.byDenomination[denom];
              const maxCount = Math.max(...sortedDenoms.map(dn => vh.byDenomination[dn].count), 1);
              const pct = (d.count / maxCount) * 100;
              return (
                <div key={denom} className="flex items-center gap-3">
                  <span className="w-16 text-right text-sm font-mono text-amber-300 font-bold">{denom}</span>
                  <div className="flex-1 h-5 bg-slate-700 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-amber-500 to-amber-400 rounded-full transition-all"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className="w-20 text-right text-xs text-slate-400">{d.count} 张</span>
                  <span className="w-24 text-right text-xs text-slate-500">={d.faceValue.toLocaleString()} A币</span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 状态分布 */}
      <div className="p-5 bg-slate-800/60 rounded-xl border border-slate-700/50">
        <h3 className="text-sm font-semibold text-white mb-4 flex items-center gap-2">
          <FileText className="w-4 h-4 text-purple-400" />
          按状态分布
        </h3>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          {Object.entries(statusLabels).map(([status, { label, color }]) => {
            const stat = vh.byStatus[status];
            return (
              <div key={status} className="p-3 rounded-lg bg-slate-700/30 text-center">
                <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${color} mb-2`}>
                  {label}
                </span>
                <div className="text-lg font-bold text-white">{stat?.count || 0}</div>
                <div className="text-xs text-slate-500">{stat?.faceValue?.toLocaleString() || 0} A币</div>
              </div>
            );
          })}
        </div>
      </div>

      {/* 查询时间 */}
      <p className="text-xs text-slate-600 text-right">
        数据查询时间：{new Date(vh.queriedAt).toLocaleString()}
      </p>
    </div>
  );
}

// ==================== 主组件 ====================

export default function PlatformAdmin() {
  const { currentUser, isAuthenticated } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  const initialTab = (searchParams.get('tab') as TabId) || 'overview';
  const [activeTab, setActiveTab] = useState<TabId>(TABS.some(t => t.id === initialTab) ? initialTab : 'overview');
  const [report, setReport] = useState<TreasuryReport | null>(null);
  const [loading, setLoading] = useState(true);

  // 权限检查
  const isAdmin = currentUser?.role === 'admin' || currentUser?.role === 'platform';

  // 加载金库数据
  const loadReport = useCallback(async () => {
    if (!isAdmin) return;
    setLoading(true);
    try {
      const r = await platformTreasuryService.getReport();
      setReport(r);
    } catch (e) {
      console.warn('[PlatformAdmin] Failed to load report:', e);
    } finally {
      setLoading(false);
    }
  }, [isAdmin]);

  useEffect(() => { loadReport(); }, [loadReport]);

  // 自动刷新（每30秒）
  useEffect(() => {
    if (!isAdmin) return;
    const interval = setInterval(loadReport, 30000);
    return () => clearInterval(interval);
  }, [loadReport, isAdmin]);

  const handleTabChange = (tab: TabId) => {
    setActiveTab(tab);
    setSearchParams({ tab }, { replace: true });
    if (tab === 'overview') loadReport(); // 切换回概览时刷新
  };

  if (!isAuthenticated || !isAdmin) {
    return <ErrorState message={!isAuthenticated ? '请先登录管理员账号' : '无权访问：需要管理员权限'} />;
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-900 to-slate-800 text-white">
      {/* 顶部导航 */}
      <div className="sticky top-0 z-40 bg-slate-900/90 backdrop-blur border-b border-slate-700/50 px-4 py-3">
        <div className="max-w-6xl mx-auto flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <button
              onClick={() => navigate('/')}
              className="p-1.5 hover:bg-slate-700 rounded-lg text-slate-400 hover:text-white transition-colors"
              title="返回基地"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
            <div>
              <h1 className="text-lg font-bold flex items-center gap-2">
                <Shield className="w-5 h-5 text-purple-400" />
                平台管理中心
              </h1>
              <p className="text-xs text-slate-500">管理员: {currentUser?.nickname}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => navigate('/platform-data-center')}
              className="flex items-center gap-1.5 px-3 py-2 bg-slate-700/60 hover:bg-slate-600 rounded-lg text-sm font-medium text-slate-200 transition-colors"
              title="前往平台数据中心"
            >
              <BarChart3 className="w-4 h-4 text-purple-400" />
              数据中心
            </button>
            <TabBar active={activeTab} onChange={handleTabChange} />
          </div>
        </div>
      </div>

      {/* 内容区 */}
      <div className="max-w-6xl mx-auto px-4 py-6">
        <AnimatePresence mode="wait">
          <motion.div
            key={activeTab}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.2 }}
          >
            {activeTab === 'overview' && <OverviewTab report={report} loading={loading} />}
            {activeTab === 'developers' && <DevelopersTab />}
            {activeTab === 'revenue' && <RevenueTab report={report} loading={loading} />}
            {activeTab === 'history' && <HistoryTab report={report} loading={loading} />}
            {activeTab === 'vouchers' && <VoucherAssetsTab report={report} loading={loading} />}
            {activeTab === 'pool' && (
              <PoolFundPanel
                currentUserId={currentUser?.uid || 'admin'}
                currentUsername={currentUser?.nickname || '管理员'}
              />
            )}
            {activeTab === 'store' && <PlatformGameStoreManager />}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
