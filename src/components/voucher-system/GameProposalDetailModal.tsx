/**
 * 游戏提案详情弹窗
 * 展示提案完整信息 + 投票操作区
 */
import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  X, Clock, Users, Vote, ThumbsUp, ThumbsDown, MinusCircle,
  ShieldAlert, CheckCircle, XCircle, AlertTriangle,
  Calendar, User, BarChart3, Zap, Send, TrendingUp,
  RefreshCw, Bug,
} from 'lucide-react';
import {
  GameProposal,
  GameProposalType,
  ProposalStatus,
  ProposalStatusLabel,
  VoteStakeholderType,
  VoteStakeholderTypeLabel,
  ProposalVoteDecision,
} from '@/types/gameProposal';
import { gameProposalService } from '@/services/gameProposalService';
import { voucherItemService } from '@/services/voucherItemService';
import { gameDeveloperService } from '@/services/gameDeveloperService';
import { voteVoucherService } from '@/voucher-system/services/VoteVoucherService';
import { VoteSettlementStatus } from '@/voucher-system/types/vote';
import { generateSimulatedPlayers } from '@/data/simulatedPlayers';
import { getProposalTypeLabel } from '@/services/gameProposalTestData';

interface GameProposalDetailModalProps {
  proposal: GameProposal;
  currentUserId: string;
  currentUserName: string;
  userStakeholderType?: VoteStakeholderType;
  onClose: () => void;
  onUpdated: () => void;
}

const GameProposalDetailModal: React.FC<GameProposalDetailModalProps> = ({
  proposal: initialProposal,
  currentUserId,
  currentUserName,
  userStakeholderType,
  onClose,
  onUpdated,
}) => {
  const [proposal, setProposal] = useState<GameProposal>(initialProposal);
  const [voteComment, setVoteComment] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [actionMsg, setActionMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    // 定时刷新提案数据
    const interval = setInterval(() => {
      const updated = gameProposalService.getProposal(initialProposal.id);
      if (updated) setProposal(updated);
    }, 5000);
    return () => clearInterval(interval);
  }, [initialProposal.id]);

  const isActive = proposal.status === ProposalStatus.ACTIVE;
  const hasExpired = Date.now() > proposal.votingEndAt;
  
  // 🆕 从凭证系统检查是否已投票（新提案）或从 voteRecords 检查（旧提案）
  const voteVoucher = voteVoucherService.getUserVoteVoucher(proposal.id, currentUserId);
  const hasVotedViaVoucher = voteVoucher ? 
    (() => {
      const info = voteVoucher.metadata?.customData?.voteInfo;
      return info && info.settlementStatus !== VoteSettlementStatus.PENDING;
    })() : false;
  const hasVotedViaRecords = proposal.voteRecords.some(v => v.voterId === currentUserId);
  const hasVoted = hasVotedViaVoucher || hasVotedViaRecords;

  // 计算用户类型
  const players = generateSimulatedPlayers();
  const currentPlayer = players.find(p => p.id === currentUserId);
  const voterType = userStakeholderType || currentPlayer?.type || VoteStakeholderType.PLAYER_COMMUNITY;

  const getTimeInfo = () => {
    const now = Date.now();
    const remaining = proposal.votingEndAt - now;
    if (remaining <= 0) return { label: '已截止', type: 'expired' as const };
    const hours = Math.floor(remaining / 3600000);
    const mins = Math.floor((remaining % 3600000) / 60000);
    let label = '';
    if (hours > 24) label = `${Math.floor(hours / 24)}天 ${hours % 24}小时`;
    else if (hours > 0) label = `${hours}小时${mins}分`;
    else label = `${mins}分钟`;
    return { label: `剩余 ${label}`, type: 'active' as const };
  };

  const timeInfo = getTimeInfo();

  const handleVote = (decision: ProposalVoteDecision) => {
    if (isSubmitting) return;
    setIsSubmitting(true);
    setActionMsg(null);

    // 🆕 前置验证：新提案必须有投票凭证才能投票
    const voteCycle = voteVoucherService.getVoteCycle(proposal.id);
    if (voteCycle && !voteVoucher) {
      setActionMsg({ type: 'error', text: '🎫 您没有该提案的投票凭证，无法投票。请联系提案发起人或确认是否在白名单中。' });
      setIsSubmitting(false);
      setTimeout(() => setActionMsg(null), 4000);
      return;
    }

    const result = gameProposalService.submitProposalVote(
      proposal.id,
      currentUserId,
      currentUserName,
      voterType,
      decision,
      voteComment || undefined,
    );

    if (result.success && result.proposal) {
      setProposal(result.proposal);
      setActionMsg({ type: 'success', text: '投票成功！' });
      onUpdated();
    } else {
      setActionMsg({ type: 'error', text: result.message });
    }

    setIsSubmitting(false);
    setTimeout(() => setActionMsg(null), 3000);
  };

  const handleFinalize = () => {
    const result = gameProposalService.finalizeProposal(proposal.id);
    if (result.success && result.proposal) {
      setProposal(result.proposal);
      onUpdated();
    }
  };

  const handleVeto = () => {
    if (!confirm('确认使用一票否决权？此操作不可撤销。')) return;
    const result = gameProposalService.vetoProposal(proposal.id, currentUserId);
    if (result.success && result.proposal) {
      setProposal(result.proposal);
      onUpdated();
    }
  };

  // 🆕 获取投票记录（合并凭证系统和 legacy voteRecords）
  const getVoteRecords = () => {
    // 先尝试从凭证系统获取
    const voucherVotes = voteVoucherService.getProposalVoteVouchers(proposal.id)
      .filter(v => {
        const info = v.metadata?.customData?.voteInfo;
        return info && info.settlementStatus !== VoteSettlementStatus.PENDING;
      })
      .map(v => {
        const info = v.metadata!.customData!.voteInfo;
        return {
          id: v.id,
          voterName: v.currentHolderName,
          voterType: info.voterType,
          decision: info.decision || 'abstain',
          comment: info.voteComment,
          weight: v.denomination,
        };
      });

    if (voucherVotes.length > 0) return voucherVotes;

    // Legacy 回退
    return proposal.voteRecords.map(r => ({
      id: r.id,
      voterName: r.voterName,
      voterType: r.voterType,
      decision: r.decision,
      comment: r.comment,
      weight: r.voteWeight,
    }));
  };

  const voteRecords = getVoteRecords();

  const handleExecute = async () => {
    if (!confirm('确认执行该提案？')) return;
    // 🆕 三方分成配置提案：先写入游戏分成配置（校验失败则中止执行）
    if (proposal.revenueSharing) {
      const rsResult = await gameDeveloperService.applyRevenueSharingConfig({
        gameId: proposal.gameId,
        gameName: proposal.gameName,
        config: {
          gameShare: proposal.revenueSharing.gameShare,
          platformShare: proposal.revenueSharing.platformShare,
          creatorShare: proposal.revenueSharing.creatorShare || 0,
          creatorId: proposal.revenueSharing.creatorId,
          creatorName: proposal.revenueSharing.creatorName,
        },
        proposalId: proposal.id,
      });
      if (!rsResult.success) {
        alert(`分成配置校验失败：${rsResult.message}`);
        return;
      }
    }
    const result = voucherItemService.executeProposalByType(proposal);
    if (result.success) {
      const updated = gameProposalService.getProposal(proposal.id);
      if (updated) setProposal(updated);
      onUpdated();
    } else {
      alert(`执行失败：${result.message}`);
    }
  };

  /**
   * 模拟全员投票（调试功能）
   * 默认分配：~75% 赞成 / ~20% 反对 / ~5% 弃权
   */
  const handleSimulateAllVotes = () => {
    const allPlayers = generateSimulatedPlayers();
    const total = allPlayers.length;

    if (!confirm(
      `即将模拟全部 ${total} 名玩家投票。\n\n` +
      `默认分配：~75% 赞成 / ~20% 反对 / ~5% 弃权\n\n` +
      `此操作不可撤销，是否继续？`
    )) return;

    setIsSubmitting(true);

    // Fisher-Yates shuffle
    const shuffle = <T,>(arr: T[]): T[] => {
      const a = [...arr];
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    };

    // 按比例分配决策
    const approveCount = Math.floor(total * 0.75);
    const rejectCount = Math.floor(total * 0.20);
    const abstainCount = total - approveCount - rejectCount;

    const decisions: ProposalVoteDecision[] = [
      ...Array(approveCount).fill('approve' as const),
      ...Array(rejectCount).fill('reject' as const),
      ...Array(abstainCount).fill('abstain' as const),
    ];

    const shuffledDecisions = shuffle(decisions);
    let successCount = 0;

    for (let i = 0; i < allPlayers.length; i++) {
      const player = allPlayers[i];
      const decision = shuffledDecisions[i];
      const decisionLabel = decision === 'approve' ? '赞成' : decision === 'reject' ? '反对' : '弃权';
      const result = gameProposalService.submitProposalVote(
        proposal.id,
        player.id,
        player.name,
        player.type,
        decision,
        `[模拟] ${decisionLabel}`,
      );
      if (result.success) successCount++;
    }

    // 自动结束投票
    const finalizeResult = gameProposalService.finalizeProposal(proposal.id);
    if (finalizeResult.success && finalizeResult.proposal) {
      setProposal(finalizeResult.proposal);
    }

    setActionMsg({ type: 'success', text: `✅ 模拟完成：${successCount}/${total} 名玩家已投票，提案已自动结算` });
    setIsSubmitting(false);
    onUpdated();
    setTimeout(() => setActionMsg(null), 5000);
  };

  const isDebugMode = gameProposalService.isDebugMode();

  const renderVoteSummary = (title: string, votes: { approve: number; reject: number; abstain: number }, color: string) => (
    <div className="bg-slate-700/30 rounded-lg p-3">
      <p className="text-xs text-slate-400 mb-2">{title}</p>
      <div className="flex items-center gap-3">
        <span className="flex items-center gap-1 text-xs text-green-400">
          <ThumbsUp className="w-3 h-3" /> {votes.approve}
        </span>
        <span className="flex items-center gap-1 text-xs text-red-400">
          <ThumbsDown className="w-3 h-3" /> {votes.reject}
        </span>
        <span className="flex items-center gap-1 text-xs text-slate-400">
          <MinusCircle className="w-3 h-3" /> {votes.abstain}
        </span>
      </div>
      <div className="mt-2 w-full h-1 bg-slate-700 rounded-full overflow-hidden">
        <div
          className={`h-full ${color} rounded-full transition-all`}
          style={{
            width: `${(votes.approve + votes.reject + votes.abstain) > 0
              ? (votes.approve / (votes.approve + votes.reject + votes.abstain)) * 100
              : 0}%`
          }}
        />
      </div>
    </div>
  );

  const canVeto = proposal.voteThreshold?.vetoEnabled && currentPlayer?.hasVetoRight && isActive;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
        onClick={onClose}
      >
        <motion.div
          initial={{ scale: 0.95, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.95, opacity: 0 }}
          onClick={e => e.stopPropagation()}
          className="bg-slate-800 rounded-2xl max-w-2xl w-full max-h-[85vh] overflow-auto border border-slate-700 shadow-2xl"
        >
          {/* Header */}
          <div className="p-5 border-b border-slate-700 flex items-center justify-between sticky top-0 bg-slate-800/95 backdrop-blur-sm z-10">
            <div className="flex items-center gap-3">
              <div className={`p-2 rounded-lg ${
                isActive ? 'bg-amber-500/20' :
                proposal.status === ProposalStatus.PASSED || proposal.status === ProposalStatus.EXECUTED ? 'bg-green-500/20' :
                'bg-slate-700/50'
              }`}>
                <Vote className={`w-5 h-5 ${isActive ? 'text-amber-400' : 'text-purple-400'}`} />
              </div>
              <div>
                <h3 className="text-lg font-bold text-white">{proposal.title}</h3>
                <p className="text-sm text-slate-400">
                  {proposal.gameName} · {getProposalTypeLabel(proposal.proposalType)}
                </p>
              </div>
            </div>
            <button onClick={onClose} className="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-slate-700 transition-colors">
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="p-5 space-y-5">
            {/* 操作反馈 */}
            <AnimatePresence>
              {actionMsg && (
                <motion.div
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  className={`px-4 py-2 rounded-lg text-sm flex items-center gap-2 ${
                    actionMsg.type === 'success'
                      ? 'bg-green-500/20 text-green-400 border border-green-500/30'
                      : 'bg-red-500/20 text-red-400 border border-red-500/30'
                  }`}
                >
                  {actionMsg.type === 'success' ? <CheckCircle className="w-4 h-4" /> : <AlertTriangle className="w-4 h-4" />}
                  {actionMsg.text}
                </motion.div>
              )}
            </AnimatePresence>

            {/* 状态标签 */}
            <div className="flex items-center gap-3 flex-wrap">
              <span className={`px-3 py-1 rounded-full text-sm font-medium border ${
                isActive ? 'bg-amber-500/20 text-amber-400 border-amber-500/30' :
                proposal.status === ProposalStatus.PASSED || proposal.status === ProposalStatus.EXECUTED ? 'bg-green-500/20 text-green-400 border-green-500/30' :
                proposal.status === ProposalStatus.VETOED || proposal.status === ProposalStatus.REJECTED ? 'bg-red-500/20 text-red-400 border-red-500/30' :
                'bg-slate-500/20 text-slate-400 border-slate-500/30'
              }`}>
                {ProposalStatusLabel[proposal.status]}
              </span>

              <span className="flex items-center gap-1 text-sm text-slate-400">
                <User className="w-4 h-4" />
                {VoteStakeholderTypeLabel[proposal.proposerType]} · {proposal.proposerName}
              </span>

              <span className="flex items-center gap-1 text-sm text-slate-400">
                <Calendar className="w-4 h-4" />
                {new Date(proposal.createdAt).toLocaleDateString('zh-CN')}
              </span>

              {isActive && (
                <span className={`flex items-center gap-1 text-sm font-medium ${timeInfo.type === 'expired' ? 'text-red-400' : 'text-amber-400'}`}>
                  <Clock className="w-4 h-4" />
                  {timeInfo.label}
                </span>
              )}
            </div>

            {/* 描述与理由 */}
            <div className="space-y-3">
              <div className="bg-slate-700/30 rounded-lg p-4">
                <p className="text-sm font-medium text-slate-300 mb-1">提案描述</p>
                <p className="text-sm text-slate-400">{proposal.description}</p>
              </div>
              <div className="bg-slate-700/30 rounded-lg p-4 border-l-2 border-purple-500">
                <p className="text-sm font-medium text-slate-300 mb-1">提案理由</p>
                <p className="text-sm text-slate-400">{proposal.reason}</p>
              </div>
            </div>

            {/* 道具详情（仅道具相关提案） */}
            {proposal.payload.itemTemplate && (
              <div className="bg-slate-700/30 rounded-lg p-4">
                <p className="text-sm font-medium text-slate-300 mb-3">道具详情</p>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <span className="text-slate-500">道具名称：</span>
                    <span className="text-white">{proposal.payload.itemTemplate.name}</span>
                  </div>
                  <div>
                    <span className="text-slate-500">稀有度：</span>
                    <span className="text-purple-400">{proposal.payload.itemTemplate.rarity}</span>
                  </div>
                  <div>
                    <span className="text-slate-500">发行策略：</span>
                    <span className={proposal.payload.itemTemplate.supplyPolicy === 'limited' ? 'text-amber-400' : 'text-green-400'}>
                      {proposal.payload.itemTemplate.supplyPolicy === 'limited' ? '限量发行' : '开放发行'}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-500">价格：</span>
                    <span className="text-yellow-400">{proposal.payload.itemTemplate.pricing.price} {proposal.payload.itemTemplate.pricing.currency}</span>
                  </div>
                  {proposal.payload.itemTemplate.totalSupply && (
                    <div>
                      <span className="text-slate-500">总量：</span>
                      <span className="text-white">{proposal.payload.itemTemplate.totalSupply}</span>
                    </div>
                  )}
                  <div>
                    <span className="text-slate-500">铸造数量：</span>
                    <span className="text-white">{proposal.payload.itemTemplate.mintCount}</span>
                  </div>
                </div>
              </div>
            )}

            {/* 收益分成 */}
            {proposal.revenueSharing && (
              <div className="bg-slate-700/30 rounded-lg p-4">
                <p className="text-sm font-medium text-slate-300 mb-3 flex items-center gap-2">
                  <TrendingUp className="w-4 h-4 text-green-400" />
                  收益分成
                </p>
                <div className="flex items-center gap-3">
                  <div className="flex-1 bg-slate-700 rounded-full h-6 overflow-hidden flex">
                    <div className="bg-purple-500 h-full flex items-center justify-center text-xs font-medium text-white"
                      style={{ width: `${proposal.revenueSharing.gameShare * 100}%` }}>
                      游戏方 {Math.round(proposal.revenueSharing.gameShare * 100)}%
                    </div>
                    <div className="bg-pink-500 h-full flex items-center justify-center text-xs font-medium text-white"
                      style={{ width: `${proposal.revenueSharing.platformShare * 100}%` }}>
                      平台 {Math.round(proposal.revenueSharing.platformShare * 100)}%
                    </div>
                    {proposal.revenueSharing.creatorShare && proposal.revenueSharing.creatorShare > 0 && (
                      <div className="bg-amber-500 h-full flex items-center justify-center text-xs font-medium text-white"
                        style={{ width: `${proposal.revenueSharing.creatorShare * 100}%` }}>
                        创作者 {Math.round(proposal.revenueSharing.creatorShare * 100)}%
                      </div>
                    )}
                  </div>
                </div>
                {/* 🆕 创作者身份说明：通过后写入该游戏三方分成配置，此后每笔道具销售按此分账 */}
                {proposal.revenueSharing.creatorShare && proposal.revenueSharing.creatorShare > 0 && (
                  <p className="text-xs text-amber-300/90 mt-2">
                    创作者：{proposal.revenueSharing.creatorName || '未指定'}
                    {proposal.revenueSharing.creatorId && (
                      <span className="text-slate-500"> (ID: {proposal.revenueSharing.creatorId})</span>
                    )}
                    {!proposal.revenueSharing.creatorId && (
                      <span className="text-red-400"> — 未指定创作者 ID，提案执行将被拒绝</span>
                    )}
                  </p>
                )}
                <p className="text-xs text-slate-500 mt-1">
                  提案通过后写入该游戏的分成配置，此后每笔道具销售按此比例三方分账
                </p>
              </div>
            )}

            {/* 投票门槛 */}
            <div className="bg-slate-700/30 rounded-lg p-4">
              <p className="text-sm font-medium text-slate-300 mb-3 flex items-center gap-2">
                <BarChart3 className="w-4 h-4 text-purple-400" />
                投票门槛
              </p>
              <div className="grid grid-cols-3 gap-3 text-sm">
                <div>
                  <p className="text-slate-500">游戏方权重</p>
                  <p className="text-white font-medium">{Math.round(proposal.voteThreshold.weights.gameDeveloper * 100)}%</p>
                </div>
                <div>
                  <p className="text-slate-500">玩家权重</p>
                  <p className="text-white font-medium">{Math.round(proposal.voteThreshold.weights.playerCommunity * 100)}%</p>
                </div>
                <div>
                  <p className="text-slate-500">平台权重</p>
                  <p className="text-white font-medium">{Math.round(proposal.voteThreshold.weights.platform * 100)}%</p>
                </div>
                <div>
                  <p className="text-slate-500">通过阈值</p>
                  <p className="text-white font-medium">{Math.round(proposal.voteThreshold.passThreshold * 100)}%</p>
                </div>
                <div>
                  <p className="text-slate-500">法定人数</p>
                  <p className="text-white font-medium">{Math.round(proposal.voteThreshold.quorumRate * 100)}%</p>
                </div>
                <div>
                  <p className="text-slate-500">投票时长</p>
                  <p className="text-white font-medium">{proposal.voteDurationHours}h</p>
                </div>
              </div>
            </div>

            {/* 投票统计（有结果时显示） */}
            {proposal.result && (
              <div className="space-y-3">
                <p className="text-sm font-medium text-slate-300 flex items-center gap-2">
                  <BarChart3 className="w-4 h-4 text-cyan-400" />
                  投票结果
                </p>
                <div className="grid grid-cols-3 gap-3">
                  {renderVoteSummary('游戏方', proposal.result.gameDeveloperVotes, 'bg-blue-500')}
                  {renderVoteSummary('玩家社区', proposal.result.playerCommunityVotes, 'bg-purple-500')}
                  {renderVoteSummary('平台方', proposal.result.platformVotes, 'bg-cyan-500')}
                </div>

                {/* 加权得分 */}
                <div className="bg-slate-700/30 rounded-lg p-4">
                  <div className="flex justify-between items-center mb-2">
                    <span className="text-sm text-slate-400">加权赞成分</span>
                    <span className="text-green-400 font-bold">{Math.round(proposal.result.weightedApproveScore * 100)}%</span>
                  </div>
                  <div className="w-full h-2 bg-slate-700 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-green-500 to-emerald-500 rounded-full transition-all"
                      style={{ width: `${proposal.result.weightedApproveScore * 100}%` }}
                    />
                  </div>
                  <div className="flex justify-between mt-3 text-xs text-slate-500">
                    <span>参与率：{Math.round(proposal.result.participationRate * 100)}%</span>
                    <span>已投票：{proposal.result.totalVoted}/{proposal.result.totalEligibleVoters}</span>
                  </div>
                </div>
              </div>
            )}

            {/* 投票操作区 */}
            {isActive && !hasExpired && (
              <div className="bg-slate-700/30 rounded-lg p-5 border border-slate-600">
                <p className="text-sm font-medium text-white mb-3">
                  {hasVoted ? '您已投过票' : '提交您的投票'}
                </p>

                {hasVoted ? (
                  <div className="text-sm text-slate-400">
                    感谢您的参与！等待投票截止后将公布结果。
                  </div>
                ) : (
                  <>
                    <div className="mb-3">
                      <textarea
                        value={voteComment}
                        onChange={e => setVoteComment(e.target.value)}
                        placeholder="可选：发表投票意见..."
                        rows={2}
                        className="w-full px-3 py-2 rounded-lg border border-slate-600 bg-slate-700 text-white text-sm focus:ring-2 focus:ring-purple-500 resize-none"
                      />
                    </div>
                    <div className="flex items-center gap-3">
                      <button
                        onClick={() => handleVote('approve')}
                        disabled={isSubmitting}
                        className="flex-1 flex items-center justify-center gap-2 px-4 py-3 bg-green-600 hover:bg-green-500 text-white rounded-lg font-medium transition-all disabled:opacity-50"
                      >
                        <ThumbsUp className="w-4 h-4" />
                        赞成
                      </button>
                      <button
                        onClick={() => handleVote('reject')}
                        disabled={isSubmitting}
                        className="flex-1 flex items-center justify-center gap-2 px-4 py-3 bg-red-600 hover:bg-red-500 text-white rounded-lg font-medium transition-all disabled:opacity-50"
                      >
                        <ThumbsDown className="w-4 h-4" />
                        反对
                      </button>
                      <button
                        onClick={() => handleVote('abstain')}
                        disabled={isSubmitting}
                        className="flex-1 flex items-center justify-center gap-2 px-4 py-3 bg-slate-600 hover:bg-slate-500 text-white rounded-lg font-medium transition-all disabled:opacity-50"
                      >
                        <MinusCircle className="w-4 h-4" />
                        弃权
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}

            {/* 投票记录列表 */}
            {voteRecords.length > 0 && (
              <div>
                <p className="text-sm font-medium text-slate-300 mb-3 flex items-center gap-2">
                  <Users className="w-4 h-4 text-slate-400" />
                  投票记录 ({voteRecords.length})
                </p>
                <div className="space-y-2 max-h-48 overflow-y-auto">
                  {voteRecords.map(record => (
                    <div key={record.id} className="flex items-center justify-between bg-slate-700/20 rounded-lg px-3 py-2">
                      <div className="flex items-center gap-2">
                        <span className="text-sm text-white">{record.voterName}</span>
                        <span className="text-xs px-1.5 py-0.5 rounded bg-slate-700 text-slate-400">
                          {VoteStakeholderTypeLabel[record.voterType]}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        {record.decision === 'approve' && <ThumbsUp className="w-3.5 h-3.5 text-green-400" />}
                        {record.decision === 'reject' && <ThumbsDown className="w-3.5 h-3.5 text-red-400" />}
                        {record.decision === 'abstain' && <MinusCircle className="w-3.5 h-3.5 text-slate-400" />}
                        {record.comment && <span className="text-xs text-slate-500 ml-1">{record.comment}</span>}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* 底部操作栏 */}
          <div className="p-5 border-t border-slate-700 flex items-center justify-between">
            <div className="flex items-center gap-2">
              {(proposal.status === ProposalStatus.ACTIVE || hasExpired) && (
                <button
                  onClick={handleFinalize}
                  className="flex items-center gap-1 px-3 py-2 bg-slate-700 hover:bg-slate-600 text-slate-300 rounded-lg text-sm transition-colors"
                >
                  <RefreshCw className="w-4 h-4" />
                  结束投票
                </button>
              )}

              {/* 调试：模拟全员投票 */}
              {isActive && isDebugMode && (
                <button
                  onClick={handleSimulateAllVotes}
                  disabled={isSubmitting}
                  className="flex items-center gap-1 px-3 py-2 bg-amber-600/30 hover:bg-amber-600/50 text-amber-400 rounded-lg text-sm transition-colors border border-amber-500/30 disabled:opacity-50"
                >
                  <Bug className="w-4 h-4" />
                  模拟全员投票
                </button>
              )}

              {canVeto && (
                <button
                  onClick={handleVeto}
                  className="flex items-center gap-1 px-3 py-2 bg-red-600/30 hover:bg-red-600/50 text-red-400 rounded-lg text-sm transition-colors border border-red-500/30"
                >
                  <ShieldAlert className="w-4 h-4" />
                  一票否决
                </button>
              )}

              {proposal.status === ProposalStatus.PASSED && (
                <button
                  onClick={handleExecute}
                  className="flex items-center gap-1 px-4 py-2 bg-gradient-to-r from-green-600 to-emerald-600 hover:from-green-500 hover:to-emerald-500 text-white rounded-lg font-medium text-sm transition-all"
                >
                  <Zap className="w-4 h-4" />
                  执行提案
                </button>
              )}
            </div>
            <button
              onClick={onClose}
              className="px-4 py-2 border border-slate-600 text-slate-300 hover:text-white hover:bg-slate-700 rounded-lg text-sm transition-colors"
            >
              关闭
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
};

export default GameProposalDetailModal;
