/**
 * PlatformDataCenter - 平台数据中心
 *
 * 独立页面（与 PlatformAdmin 并列），展示平台级运营指标：
 *   - KPI：DAU / MAU / 总玩家 / 总游戏次数 / 平均在线时长 / A币流通量 / 金库A币 / 总营收
 *   - 趋势图（recharts）：DAU / 游戏次数 / 营收 可切换，默认 30 天
 *   - 游戏排行表：次数 / 独立玩家 / 平均时长 / 营收
 *   - 玩家分布：新增vs回流（饼图）、角色分布（柱状）、活跃分层（柱状）
 *
 * 数据全部来自真实事件（后端 memory 库聚合），空数据显式展示“暂无数据”（不造假）。
 * 后端接口需要任意有效 JWT，前端用 authTokenService 的 dev-token 取数。
 */
import { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, BarChart, Bar, CartesianGrid, Legend,
} from 'recharts';
import { useAuth } from '@/contexts/authContext';
import { fetchAnalytics } from '@/services/analytics';
import { platformTreasuryService, type TreasuryReport } from '@/services/platformTreasuryService';
import {
  Activity, Users, Gamepad2, Clock, Coins, Wallet, TrendingUp,
  ArrowLeft, RefreshCw, PieChart as PieIcon, BarChart3,
} from 'lucide-react';

// ==================== 类型 ====================

interface OverviewData {
  dau: number;
  mau: number;
  totalPlayers: number;
  totalGamePlays: number;
  avgSessionMs: number;
  totalRevenueACoins: number;
  totalRevenueGameCoins: number;
  generatedAt: number;
}

interface TrendSeriesPoint { date: string; value: number; }
interface TrendData { metric: string; days: number; series: TrendSeriesPoint[]; }

interface GameStat {
  gameId: string;
  gamePlays: number;
  uniquePlayers: number;
  avgSessionMs: number;
  revenueACoins: number;
  revenueGameCoins: number;
}

interface PlayersData {
  totalPlayers: number;
  dau: number;
  mau: number;
  newVsReturning: { new: number; returning: number };
  byRole: Record<string, number>;
  byActivityTier: Record<string, number>;
}

// ==================== 子组件 ====================

function ErrorState({ message }: { message: string }) {
  const navigate = useNavigate();
  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-900 to-slate-800 flex items-center justify-center">
      <div className="text-center">
        <Activity className="w-16 h-16 text-slate-600 mx-auto mb-4" />
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

function StatCard({ icon, label, value, suffix, color = 'purple' }: {
  icon: React.ReactNode; label: string; value: string; suffix?: string; color?: string;
}) {
  const colorMap: Record<string, string> = {
    purple: 'border-purple-500/20 bg-purple-500/5',
    cyan: 'border-cyan-500/20 bg-cyan-500/5',
    amber: 'border-amber-500/20 bg-amber-500/5',
    green: 'border-green-500/20 bg-green-500/5',
    blue: 'border-blue-500/20 bg-blue-500/5',
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

function SectionTitle({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <h3 className="text-sm font-semibold text-white mb-4 flex items-center gap-2">
      {icon}
      {children}
    </h3>
  );
}

function EmptyHint({ text = '暂无数据' }: { text?: string }) {
  return (
    <div className="py-10 text-center text-slate-500 text-sm">
      <BarChart3 className="w-10 h-10 text-slate-600 mx-auto mb-2" />
      {text}
    </div>
  );
}

function Loading({ label }: { label?: string }) {
  return (
    <div className="flex items-center justify-center py-16">
      <div className="w-6 h-6 border-2 border-purple-500/30 border-t-purple-500 rounded-full animate-spin" />
      {label && <span className="ml-3 text-slate-400">{label}</span>}
    </div>
  );
}

// ==================== 工具 ====================

function fmtDuration(ms: number): string {
  if (!ms || ms <= 0) return '0分';
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m <= 0) return `${s}秒`;
  if (s <= 0) return `${m}分`;
  return `${m}分${s}秒`;
}

function fmtDateShort(d: string): string {
  // 'YYYY-MM-DD' -> 'MM/DD'
  const parts = d.split('-');
  return parts.length === 3 ? `${parts[1]}/${parts[2]}` : d;
}

const PIE_COLORS = ['#8b5cf6', '#22d3ee', '#f59e0b', '#22c55e', '#ef4444', '#ec4899'];

// ==================== 主组件 ====================

type TrendMetric = 'dau' | 'gamePlays' | 'revenue';

export default function PlatformDataCenter() {
  const { currentUser, isAuthenticated } = useAuth();
  const navigate = useNavigate();

  const isAdmin = currentUser?.role === 'admin' || currentUser?.role === 'platform';

  const [overview, setOverview] = useState<OverviewData | null>(null);
  const [trend, setTrend] = useState<TrendData | null>(null);
  const [games, setGames] = useState<GameStat[]>([]);
  const [players, setPlayers] = useState<PlayersData | null>(null);
  const [treasury, setTreasury] = useState<TreasuryReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [trendMetric, setTrendMetric] = useState<TrendMetric>('dau');

  const loadAll = useCallback(async () => {
    if (!isAdmin) return;
    setRefreshing(true);
    try {
      const uid = currentUser?.uid || 'admin';
      const [ov, tr, gm, pl, tr2] = await Promise.all([
        fetchAnalytics<OverviewData>('overview'),
        fetchAnalytics<TrendData>(`trends?metric=${trendMetric}&days=30`),
        fetchAnalytics<GameStat[]>('by-game'),
        fetchAnalytics<PlayersData>('players'),
        platformTreasuryService.getReport().catch(() => null),
      ]);
      setOverview(ov);

      // 后端 /trends 返回 TrendPoint[] 数组，需转为趋势图所需的 {date, value} 序列
      const raw: any[] = Array.isArray(tr) ? tr : [];
      const series = raw.map((p) => ({
        date: p.date,
        value:
          trendMetric === 'revenue'
            ? (Number(p.revenueACoins) || 0) + (Number(p.revenueGameCoins) || 0)
            : Number(trendMetric === 'dau' ? p.dau : p.gamePlays) || 0,
      }));
      setTrend({ metric: trendMetric, days: 30, series });

      setGames(gm || []);
      setPlayers(pl);
      setTreasury(tr2);
    } catch (e) {
      console.warn('[DataCenter] 加载失败:', e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [isAdmin, currentUser, trendMetric]);

  useEffect(() => { loadAll(); }, [loadAll]);

  // 30s 自动刷新
  useEffect(() => {
    if (!isAdmin) return;
    const interval = setInterval(loadAll, 30000);
    return () => clearInterval(interval);
  }, [loadAll, isAdmin]);

  // a币流通量：凭证系统总面额（来自金库报表的凭证资产）
  const circulationACoins = useMemo(() => {
    const vh = treasury?.vouchers;
    if (!vh) return 0;
    // 流通中 + 冻结中 + 池资金 都算已发行 A币
    const active = vh.byStatus['active']?.faceValue || 0;
    const frozen = vh.byStatus['frozen']?.faceValue || 0;
    return active + frozen;
  }, [treasury]);

  const treasuryACoins = treasury?.balance.aCoins ?? 0;
  const treasuryGC = treasury?.balance.gameCoins ?? 0;
  const totalRevenue = (overview?.totalRevenueACoins ?? 0) + (overview?.totalRevenueGameCoins ?? 0);

  if (!isAuthenticated || !isAdmin) {
    return (
      <ErrorState
        message={!isAuthenticated ? '请先登录管理员账号' : '无权访问：需要管理员权限'}
      />
    );
  }

  const trendData = trend?.series ?? [];

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
                <Activity className="w-5 h-5 text-purple-400" />
                平台数据中心
              </h1>
              <p className="text-xs text-slate-500">管理员: {currentUser?.nickname}</p>
            </div>
          </div>
          <button
            onClick={loadAll}
            disabled={refreshing}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-700 hover:bg-slate-600 rounded-lg text-sm transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
            {refreshing ? '刷新中' : '刷新'}
          </button>
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-4 py-6 space-y-8">
        {loading ? (
          <Loading label="加载数据中心..." />
        ) : (
          <>
            {/* KPI 卡片 */}
            <section className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <StatCard icon={<Users className="w-4 h-4 text-cyan-400" />} label="DAU（今日活跃）" value={(overview?.dau ?? 0).toLocaleString()} color="cyan" />
              <StatCard icon={<Users className="w-4 h-4 text-purple-400" />} label="MAU（30日活跃）" value={(overview?.mau ?? 0).toLocaleString()} color="purple" />
              <StatCard icon={<Users className="w-4 h-4 text-green-400" />} label="累计玩家" value={(overview?.totalPlayers ?? 0).toLocaleString()} color="green" />
              <StatCard icon={<Gamepad2 className="w-4 h-4 text-amber-400" />} label="总游戏次数" value={(overview?.totalGamePlays ?? 0).toLocaleString()} color="amber" />
              <StatCard icon={<Clock className="w-4 h-4 text-blue-400" />} label="平均在线时长" value={fmtDuration(overview?.avgSessionMs ?? 0)} color="blue" />
              <StatCard icon={<Coins className="w-4 h-4 text-yellow-400" />} label="A币流通量" value={circulationACoins.toLocaleString()} suffix="A币" color="amber" />
              <StatCard icon={<Wallet className="w-4 h-4 text-emerald-400" />} label="金库 A币 / GC" value={`${treasuryACoins.toLocaleString()} / ${treasuryGC.toLocaleString()}`} color="green" />
              <StatCard icon={<TrendingUp className="w-4 h-4 text-purple-400" />} label="总营收" value={totalRevenue.toLocaleString()} suffix="币" color="purple" />
            </section>

            {/* 趋势图 */}
            <section className="p-5 bg-slate-800/60 rounded-xl border border-slate-700/50">
              <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
                <SectionTitle icon={<TrendingUp className="w-4 h-4 text-purple-400" />}>
                  趋势分析（近 30 天）
                </SectionTitle>
                <div className="flex gap-1 p-1 bg-slate-900/60 rounded-lg">
                  {([
                    { id: 'dau', label: 'DAU' },
                    { id: 'gamePlays', label: '游戏次数' },
                    { id: 'revenue', label: '营收' },
                  ] as { id: TrendMetric; label: string }[]).map(m => (
                    <button
                      key={m.id}
                      onClick={() => setTrendMetric(m.id)}
                      className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                        trendMetric === m.id ? 'bg-purple-600 text-white' : 'text-slate-400 hover:text-white'
                      }`}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
              </div>
              {trendData.length === 0 ? (
                <EmptyHint text="暂无趋势数据（需玩家开始游戏/交易后出数）" />
              ) : (
                <ResponsiveContainer width="100%" height={280}>
                  <AreaChart data={trendData} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="trendGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#8b5cf6" stopOpacity={0.4} />
                        <stop offset="95%" stopColor="#8b5cf6" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                    <XAxis dataKey="date" tickFormatter={fmtDateShort} stroke="#64748b" fontSize={11} />
                    <YAxis stroke="#64748b" fontSize={11} allowDecimals={false} />
                    <Tooltip
                      contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8, fontSize: 12 }}
                      labelStyle={{ color: '#cbd5e1' }}
                      formatter={(v: number) => [v.toLocaleString(), trendMetric === 'revenue' ? '总营收' : trendMetric === 'gamePlays' ? '游戏次数' : 'DAU']}
                      labelFormatter={(l) => `日期 ${l}`}
                    />
                    <Area type="monotone" dataKey="value" stroke="#8b5cf6" strokeWidth={2} fill="url(#trendGrad)" />
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </section>

            {/* 游戏排行表 */}
            <section className="p-5 bg-slate-800/60 rounded-xl border border-slate-700/50">
              <SectionTitle icon={<Gamepad2 className="w-4 h-4 text-amber-400" />}>
                游戏排行
              </SectionTitle>
              {games.length === 0 ? (
                <EmptyHint text="暂无游戏数据（需玩家启动游戏后出数）" />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs text-slate-500 border-b border-slate-700/50">
                        <th className="pb-2 pr-4 font-medium">游戏 ID</th>
                        <th className="pb-2 pr-4 font-medium text-right">游戏次数</th>
                        <th className="pb-2 pr-4 font-medium text-right">独立玩家</th>
                        <th className="pb-2 pr-4 font-medium text-right">平均时长</th>
                        <th className="pb-2 font-medium text-right">营收</th>
                      </tr>
                    </thead>
                    <tbody>
                      {games.map(g => (
                        <tr key={g.gameId} className="border-b border-slate-700/20 hover:bg-slate-800/40 transition-colors">
                          <td className="py-2.5 pr-4 font-mono text-purple-300">{g.gameId}</td>
                          <td className="py-2.5 pr-4 text-right text-white">{g.gamePlays.toLocaleString()}</td>
                          <td className="py-2.5 pr-4 text-right text-cyan-300">{g.uniquePlayers.toLocaleString()}</td>
                          <td className="py-2.5 pr-4 text-right text-blue-300">{fmtDuration(g.avgSessionMs)}</td>
                          <td className="py-2.5 text-right text-amber-300">
                            {(g.revenueACoins + g.revenueGameCoins).toLocaleString()}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {/* 玩家分布 */}
            <section className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              {/* 新增 vs 回流 */}
              <div className="p-5 bg-slate-800/60 rounded-xl border border-slate-700/50">
                <SectionTitle icon={<PieIcon className="w-4 h-4 text-purple-400" />}>新增 vs 回流</SectionTitle>
                {!players || (players.newVsReturning.new === 0 && players.newVsReturning.returning === 0) ? (
                  <EmptyHint text="暂无玩家数据" />
                ) : (
                  <ResponsiveContainer width="100%" height={220}>
                    <PieChart>
                      <Pie
                        data={[
                          { name: '新增', value: players.newVsReturning.new },
                          { name: '回流', value: players.newVsReturning.returning },
                        ]}
                        dataKey="value"
                        nameKey="name"
                        cx="50%"
                        cy="50%"
                        outerRadius={70}
                        label
                      >
                        <Cell fill="#22c55e" />
                        <Cell fill="#8b5cf6" />
                      </Pie>
                      <Tooltip contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8, fontSize: 12 }} />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                    </PieChart>
                  </ResponsiveContainer>
                )}
              </div>

              {/* 角色分布 */}
              <div className="p-5 bg-slate-800/60 rounded-xl border border-slate-700/50">
                <SectionTitle icon={<BarChart3 className="w-4 h-4 text-cyan-400" />}>角色分布</SectionTitle>
                {!players || Object.keys(players.byRole).length === 0 ? (
                  <EmptyHint text="暂无玩家数据" />
                ) : (
                  <ResponsiveContainer width="100%" height={220}>
                    <BarChart data={Object.entries(players.byRole).map(([k, v]) => ({ name: k, value: v }))}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                      <XAxis dataKey="name" stroke="#64748b" fontSize={11} />
                      <YAxis stroke="#64748b" fontSize={11} allowDecimals={false} />
                      <Tooltip contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8, fontSize: 12 }} />
                      <Bar dataKey="value" fill="#22d3ee" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </div>

              {/* 活跃分层 */}
              <div className="p-5 bg-slate-800/60 rounded-xl border border-slate-700/50">
                <SectionTitle icon={<BarChart3 className="w-4 h-4 text-amber-400" />}>活跃分层</SectionTitle>
                {!players || Object.keys(players.byActivityTier).length === 0 ? (
                  <EmptyHint text="暂无玩家数据" />
                ) : (
                  <ResponsiveContainer width="100%" height={220}>
                    <BarChart data={Object.entries(players.byActivityTier).map(([k, v]) => ({ name: k.replace(/\s*\(.*\)/, ''), value: v }))}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                      <XAxis dataKey="name" stroke="#64748b" fontSize={10} />
                      <YAxis stroke="#64748b" fontSize={11} allowDecimals={false} />
                      <Tooltip contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8, fontSize: 12 }} />
                      <Bar dataKey="value" fill="#f59e0b" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </div>
            </section>

            <p className="text-xs text-slate-600 text-center">
              数据基于真实用户行为事件聚合（后端内存库）。内存模式重启会清空，生产建议接入 PostgreSQL 持久化。
              {overview ? ` 最后更新：${new Date(overview.generatedAt).toLocaleString()}` : ''}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
