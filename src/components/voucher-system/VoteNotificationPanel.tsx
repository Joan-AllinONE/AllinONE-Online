/**
 * 投票通知面板
 *
 * 挂载在个人中心，集中展示用户的投票状态：
 *   - 待投票（倒计时 + 权重 + 可立即投票）
 *   - 已投票（记录 + 等待结算）
 *   - 已结算（结果 + 盈余/亏损）
 *   - 顶部未读计数红点
 *
 * @example
 *   <VoteNotificationPanel userId="current-user" />
 */

import { useState, useEffect, useCallback } from 'react';
import { VoteSettlementStatus } from '../../voucher-system/types/vote';
import { voteVoucherService } from '../../voucher-system/services/VoteVoucherService';
import { gameProposalService } from '../../services/gameProposalService';
import type { Voucher } from '../../voucher-system/types';
import type { GameProposal } from '../../types/gameProposal';

// 获取用户 ID：优先从 allinone_user（AuthSkill 持久化的用户信息），回退到默认值
function getVoucherUserId(): string {
  try {
    const userStr = localStorage.getItem('allinone_user');
    if (userStr) {
      const user = JSON.parse(userStr);
      return user.uid || user.id || 'current-user';
    }
  } catch { /* ignore */ }
  return 'current-user';
}

// ==================== 辅助 ====================

function timeLeftLabel(endTimestamp: number): { text: string; urgent: boolean } {
  const now = Date.now();
  const remaining = endTimestamp - now;

  if (remaining <= 0) return { text: '已截止', urgent: true };

  const hours = Math.floor(remaining / 3600000);
  const minutes = Math.floor((remaining % 3600000) / 60000);

  if (hours > 24) {
    const days = Math.floor(hours / 24);
    return { text: `${days}天${hours % 24}小时`, urgent: false };
  }
  if (hours > 1) {
    return { text: `${hours}小时${minutes}分钟`, urgent: hours < 6 };
  }
  if (hours === 1) {
    return { text: `${hours}小时${minutes}分钟`, urgent: true };
  }
  return { text: `${minutes}分钟`, urgent: true };
}

function decisionLabel(decision?: string): { label: string; emoji: string; color: string } {
  switch (decision) {
    case 'approve': return { label: '赞成', emoji: '👍', color: 'text-green-400' };
    case 'reject': return { label: '反对', emoji: '👎', color: 'text-red-400' };
    case 'abstain': return { label: '弃权', emoji: '🤝', color: 'text-gray-400' };
    default: return { label: '未知', emoji: '❓', color: 'text-gray-400' };
  }
}

function statusLabel(status: string): { label: string; color: string; bg: string } {
  switch (status) {
    case 'pending': return { label: '待投票', color: 'text-yellow-400', bg: 'bg-yellow-500/10 border-yellow-400/30' };
    case 'cast': return { label: '已投票', color: 'text-blue-400', bg: 'bg-blue-500/10 border-blue-400/30' };
    case 'settled': return { label: '已结算', color: 'text-gray-400', bg: 'bg-gray-500/10 border-gray-400/30' };
    default: return { label: '未知', color: 'text-gray-400', bg: 'bg-gray-500/10 border-gray-400/30' };
  }
}

// ==================== 组件 ====================

export default function VoteNotificationPanel() {
  // Align with "凭证资产" section: use voucher_guest_id for lookup
  const voucherUserId = getVoucherUserId();
  const [activeTab, setActiveTab] = useState<'pending' | 'voted' | 'settled'>('pending');
  const [allVouchers, setAllVouchers] = useState<Voucher[]>([]);
  const [proposals, setProposals] = useState<GameProposal[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  // 加载数据
  const loadData = useCallback(() => {
    try {
      const vouchers = voteVoucherService.getUserVoteVouchers(voucherUserId);
      setAllVouchers(vouchers);
      setProposals(gameProposalService.getAllProposals());
    } catch (e) {
      console.error('[VotePanel] 加载投票数据失败:', e);
    }
  }, [voucherUserId]);

  useEffect(() => {
    loadData();

    // 监听投票事件自动刷新
    const handlers = ['vote-cast', 'vote-cycle-started', 'vote-cycle-settled'];
    for (const event of handlers) {
      window.addEventListener(event, loadData);
    }

    // 定时刷新倒计时（每分钟）
    const timer = setInterval(loadData, 30000);

    return () => {
      for (const event of handlers) {
        window.removeEventListener(event, loadData);
      }
      clearInterval(timer);
    };
  }, [loadData]);

  // 手动刷新
  const handleRefresh = () => {
    setRefreshing(true);
    loadData();
    setTimeout(() => setRefreshing(false), 600);
  };

  // 分类凭证
  const pendingVouchers = allVouchers.filter(v => {
    const vi = (v.metadata?.customData as any)?.voteInfo;
    return vi?.settlementStatus === VoteSettlementStatus.PENDING;
  });
  const castVouchers = allVouchers.filter(v => {
    const vi = (v.metadata?.customData as any)?.voteInfo;
    return vi?.settlementStatus === VoteSettlementStatus.CAST;
  });
  const settledVouchers = allVouchers.filter(v => {
    const vi = (v.metadata?.customData as any)?.voteInfo;
    return vi?.settlementStatus === VoteSettlementStatus.SETTLED;
  });

  // 未读计数 = 待投票数
  const unreadCount = pendingVouchers.length;

  // ==================== 渲染辅助 ====================

  const renderVoucherCard = (
    voucher: Voucher,
    index: number,
  ) => {
    const vi = (voucher.metadata?.customData as any)?.voteInfo;
    if (!vi) return null;

    const proposal = proposals.find(p => p.id === vi.proposalId);
    const isPending = vi.settlementStatus === VoteSettlementStatus.PENDING;
    const isCast = vi.settlementStatus === VoteSettlementStatus.CAST;
    const isSettled = vi.settlementStatus === VoteSettlementStatus.SETTLED;

    const tl = isPending && vi.votingEndAt
      ? timeLeftLabel(vi.votingEndAt)
      : null;

    const dec = !isPending ? decisionLabel(vi.decision) : null;
    const st = statusLabel(vi.settlementStatus);

    return (
      <div
        key={voucher.id}
        className={`rounded-lg border p-4 transition-all hover:border-opacity-60 ${st.bg}`}
        style={{ animationDelay: `${index * 50}ms` }}
      >
        {/* 头部: 标题 + 状态 */}
        <div className="flex items-start justify-between mb-2">
          <div className="flex-1 min-w-0">
            <h4 className="font-bold text-sm text-white truncate">
              {vi.proposalTitle}
            </h4>
            <div className="flex items-center gap-2 mt-1">
              <span className="text-xs text-slate-400">{vi.gameName}</span>
              <span className="text-xs px-1.5 py-0.5 rounded bg-slate-700/50 text-slate-400">
                {vi.proposalType}
              </span>
            </div>
          </div>
          <span className={`text-xs font-medium px-2 py-0.5 rounded whitespace-nowrap ml-2 ${st.color} bg-opacity-20`}>
            {st.label}
          </span>
        </div>

        {/* 投票权重 */}
        <div className="flex items-center gap-3 mb-2 text-xs text-slate-400">
          <span>⚖️ 权重: <b className="text-slate-300">{voucher.denomination.toFixed(2)}</b></span>
          {vi.voterType && (
            <span>👤 {vi.voterType === 'game_developer' ? '游戏方' : vi.voterType === 'player_community' ? '玩家社区' : '平台方'}</span>
          )}
        </div>

        {/* 待投票: 倒计时 */}
        {isPending && tl && (
          <div className="mt-2">
            <div className="flex items-center justify-between">
              <span className={`text-xs ${tl.urgent ? 'text-red-400 animate-pulse' : 'text-yellow-400'}`}>
                ⏰ 剩余 {tl.text}
              </span>
              {vi.votingEndAt && (
                <span className="text-[10px] text-slate-500">
                  截止: {new Date(vi.votingEndAt).toLocaleDateString('zh-CN')}
                </span>
              )}
            </div>
          </div>
        )}

        {/* 已投票: 决策 + 时间 */}
        {isCast && dec && (
          <div className="mt-2">
            <span className={`text-sm font-medium ${dec.color}`}>
              {dec.emoji} 已投{dec.label}
            </span>
            {vi.votedAt && (
              <span className="text-[10px] text-slate-500 ml-2">
                {new Date(vi.votedAt).toLocaleString('zh-CN')}
              </span>
            )}
          </div>
        )}

        {/* 已结算: 结果 */}
        {isSettled && (
          <div className="mt-2">
            {dec && (
              <span className={`text-sm font-medium ${dec.color}`}>
                {dec.emoji} 投了{dec.label}
              </span>
            )}
            {proposal && proposal.result && (
              <span className={`ml-2 text-xs font-bold px-1.5 py-0.5 rounded ${
                proposal.result.finalStatus === 'passed'
                  ? 'text-green-400 bg-green-500/10'
                  : 'text-red-400 bg-red-500/10'
              }`}>
                {proposal.result.finalStatus === 'passed' ? '✅ 通过' : '❌ 拒绝'}
              </span>
            )}
            {proposal?.result && (
              <div className="mt-1 text-[10px] text-slate-500">
                参与率: {Math.round(proposal.result.participationRate * 100)}% ·
                赞成率: {Math.round(proposal.result.weightedApproveScore * 100)}%
              </div>
            )}
          </div>
        )}

        {/* 提案简述 */}
        {vi.proposalDescription && (
          <p className="mt-2 text-xs text-slate-500 line-clamp-2">
            {vi.proposalDescription}
          </p>
        )}
      </div>
    );
  };

  // ==================== 主渲染 ====================

  return (
    <div>
      {/* 标题栏 */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <h3 className="text-lg font-bold text-cyan-400">🗳️ 投票通知</h3>
          {unreadCount > 0 && (
            <span className="inline-flex items-center justify-center w-6 h-6 text-xs font-bold text-white bg-red-500 rounded-full animate-pulse">
              {unreadCount}
            </span>
          )}
        </div>
        <button
          onClick={handleRefresh}
          className="text-xs text-slate-400 hover:text-slate-200 transition-colors px-2 py-1 rounded hover:bg-slate-700/50"
        >
          {refreshing ? '⏳ 刷新中...' : '🔄 刷新'}
        </button>
      </div>

      {/* 统计概览 */}
      <div className="grid grid-cols-3 gap-3 mb-4">
        {([
          { key: 'pending', label: '待投票', count: pendingVouchers.length, color: 'text-yellow-400', bg: 'bg-yellow-500/10 border-yellow-400/20' },
          { key: 'voted', label: '已投票', count: castVouchers.length, color: 'text-blue-400', bg: 'bg-blue-500/10 border-blue-400/20' },
          { key: 'settled', label: '已结算', count: settledVouchers.length, color: 'text-gray-400', bg: 'bg-gray-500/10 border-gray-400/20' },
        ] as const).map(item => (
          <button
            key={item.key}
            onClick={() => setActiveTab(item.key)}
            className={`${item.bg} rounded-lg border p-3 transition-all hover:border-opacity-60 ${
              activeTab === item.key ? 'ring-1 ring-white/20' : ''
            }`}
          >
            <div className={`text-2xl font-bold ${item.color}`}>{item.count}</div>
            <div className="text-xs text-slate-400 mt-1">{item.label}</div>
          </button>
        ))}
      </div>

      {/* 子标签 */}
      <div className="flex space-x-3 mb-4 border-b border-slate-600/30">
        {([
          { key: 'pending', label: `待投票 (${pendingVouchers.length})`, color: 'text-yellow-400', border: 'border-yellow-400' },
          { key: 'voted', label: `已投票 (${castVouchers.length})`, color: 'text-blue-400', border: 'border-blue-400' },
          { key: 'settled', label: `已结算 (${settledVouchers.length})`, color: 'text-gray-400', border: 'border-gray-400' },
        ] as const).map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`pb-2 px-1 text-sm font-medium transition-colors ${
              activeTab === tab.key
                ? `${tab.color} border-b-2 ${tab.border}`
                : 'text-slate-400 hover:text-slate-300'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* 内容区 */}
      <div className="space-y-3 max-h-[600px] overflow-y-auto pr-1">
        {/* 待投票 */}
        {activeTab === 'pending' && (
          pendingVouchers.length > 0 ? (
            pendingVouchers.map((v, i) => renderVoucherCard(v, i))
          ) : (
            <div className="text-center py-12">
              <div className="text-4xl mb-3">🎉</div>
              <p className="text-slate-400 text-sm">暂无待投票提案</p>
              <p className="text-xs text-slate-500 mt-1">当有新的社区提案时，投票凭证会自动发放至你的账户</p>
            </div>
          )
        )}

        {/* 已投票 */}
        {activeTab === 'voted' && (
          castVouchers.length > 0 ? (
            castVouchers.map((v, i) => renderVoucherCard(v, i))
          ) : (
            <div className="text-center py-12">
              <div className="text-4xl mb-3">🗳️</div>
              <p className="text-slate-400 text-sm">暂无已投票记录</p>
              <p className="text-xs text-slate-500 mt-1">你投票后，记录将显示在此处</p>
            </div>
          )
        )}

        {/* 已结算 */}
        {activeTab === 'settled' && (
          settledVouchers.length > 0 ? (
            settledVouchers.map((v, i) => renderVoucherCard(v, i))
          ) : (
            <div className="text-center py-12">
              <div className="text-4xl mb-3">📊</div>
              <p className="text-slate-400 text-sm">暂无已结算投票</p>
              <p className="text-xs text-slate-500 mt-1">投票结算后，结果将显示在此处</p>
            </div>
          )
        )}
      </div>
    </div>
  );
}
