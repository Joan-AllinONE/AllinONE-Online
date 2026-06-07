/**
 * 游戏提案投票服务
 * 管理游戏内容修改的完整投票生命周期
 * 三方治理：游戏方 + 玩家社区 + 平台方
 */
import {
  GameProposalType,
  ProposalStatus,
  VoteStakeholderType,
} from '@/types/gameProposal';
import type {
  GameProposal,
  GameProposalPayload,
  GameVoteThreshold,
  ProposalVoteDecision,
  ProposalVoteRecord,
  ProposalResult,
  PenaltyConfig,
  PenaltyType,
  PenaltyLog,
  PlayerMetrics,
} from '@/types/gameProposal';
import { generateSimulatedPlayers, generatePlayerMetrics, calculateVoteWeight } from '@/data/simulatedPlayers';
import { voteVoucherService } from '@/voucher-system/services/VoteVoucherService';
import { voteFraudDetector } from '@/voucher-system/services/VoteFraudDetector';
import { VoteSettlementStatus } from '@/voucher-system/types/vote';

// ==================== 常量 ====================

const PROPOSALS_STORAGE_KEY = 'game_proposals';
const THRESHOLDS_STORAGE_KEY = 'game_vote_thresholds';
const PENALTY_LOGS_KEY = 'game_penalty_logs';

// ==================== 存储工具 ====================

function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

function loadProposals(): GameProposal[] {
  try {
    const raw = localStorage.getItem(PROPOSALS_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveProposals(proposals: GameProposal[]): void {
  localStorage.setItem(PROPOSALS_STORAGE_KEY, JSON.stringify(proposals));
  // CloudBase 双写
  import('./cloudbase').then(({ isCloudBaseReady, getCloudBaseApp }) => {
    if (!isCloudBaseReady()) return;
    const db = getCloudBaseApp().database();
    for (const proposal of proposals.slice(-10)) {
      db.collection('proposals').where({ id: proposal.id }).get().then(res => {
        if (res.data.length > 0) {
          db.collection('proposals').doc(res.data[0]._id).update(proposal as any).catch(() => {});
        } else {
          db.collection('proposals').add(proposal as any).catch(() => {});
        }
      }).catch(() => {});
    }
  }).catch(() => {});
}

function loadThresholds(): Record<string, GameVoteThreshold> {
  try {
    const raw = localStorage.getItem(THRESHOLDS_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveThresholds(thresholds: Record<string, GameVoteThreshold>): void {
  localStorage.setItem(THRESHOLDS_STORAGE_KEY, JSON.stringify(thresholds));
}

function loadPenaltyLogs(): PenaltyLog[] {
  try {
    const raw = localStorage.getItem(PENALTY_LOGS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function savePenaltyLogs(logs: PenaltyLog[]): void {
  localStorage.setItem(PENALTY_LOGS_KEY, JSON.stringify(logs));
}

// ==================== 默认投票门槛 ====================

export function getDefaultVoteThreshold(gameId: string): GameVoteThreshold {
  return {
    gameId,
    weights: {
      gameDeveloper: 0.40,
      playerCommunity: 0.35,
      platform: 0.25,
    },
    minVoteDurationHours: 24,
    maxVoteDurationHours: 168,
    quorumRate: 0.5,
    passThreshold: 0.55,
    vetoEnabled: true,
    vetoByFounderOnly: true,
    autoExecute: true,
    requiresPlatformReview: true,
    penaltyRules: {
      enabled: true,
      maxRefusalCount: 3,
      penalties: [
        { type: 'warning', description: '第一次警告通知' },
        { type: 'freeze_assets', durationHours: 72, description: '冻结游戏资产72小时' },
        { type: 'traffic_limit', durationHours: 168, description: '限制流量50%持续7天' },
        { type: 'force_delist', description: '强制下架游戏' },
      ],
    },
  };
}

// ==================== 服务类 ====================

class GameProposalService {
  private debugMode = false;

  // ============ 调试模式 ============

  /** 启用/禁用调试模式（降低投票门槛） */
  setDebugMode(enabled: boolean): void {
    this.debugMode = enabled;
    // 持久化到 localStorage
    localStorage.setItem('game_proposal_debug_mode', enabled ? '1' : '0');
    console.log(`[GameProposal] 调试模式: ${enabled ? '🟢 已开启' : '🔴 已关闭'}`);
  }

  /** 查询调试模式状态 */
  isDebugMode(): boolean {
    return this.debugMode;
  }

  /** 初始化调试模式状态 */
  initDebugMode(): void {
    try {
      this.debugMode = localStorage.getItem('game_proposal_debug_mode') === '1';
    } catch { this.debugMode = false; }
  }

  // ============ 投票门槛管理 ============

  /**
   * 获取游戏的投票门槛配置
   */
  getGameVoteThreshold(gameId: string): GameVoteThreshold {
    const thresholds = loadThresholds();
    const base = thresholds[gameId] || getDefaultVoteThreshold(gameId);
    // 调试模式：大幅降低阈值以便测试
    if (this.debugMode) {
      return {
        ...base,
        quorumRate: 0.1,        // 10% 法定人数
        passThreshold: 0.3,     // 30% 通过阈值
        minVoteDurationHours: 0.1, // 6分钟最短投票期
        autoExecute: true,
        vetoEnabled: true,
      };
    }
    return base;
  }

  /**
   * 更新游戏的投票门槛
   */
  updateGameVoteThreshold(gameId: string, threshold: GameVoteThreshold): void {
    const thresholds = loadThresholds();
    thresholds[gameId] = { ...threshold, gameId };
    saveThresholds(thresholds);
    console.log(`[GameProposal] 更新投票门槛: ${gameId}`);
  }

  // ============ 提案生命周期 ============

  /**
   * 发起提案
   */
  createProposal(params: {
    gameId: string;
    gameName: string;
    title: string;
    description: string;
    reason: string;
    proposalType: GameProposalType;
    payload: GameProposalPayload;
    proposerId: string;
    proposerName: string;
    proposerType: VoteStakeholderType;
    voteDurationHours?: number;
    whitelist?: string[];
    revenueSharing?: { gameShare: number; platformShare: number; creatorShare?: number };
  }): GameProposal {
    const proposals = loadProposals();
    const threshold = this.getGameVoteThreshold(params.gameId);

    // Clamp vote duration
    const durationHours = Math.min(
      Math.max(params.voteDurationHours || 48, threshold.minVoteDurationHours),
      threshold.maxVoteDurationHours
    );

    const now = Date.now();
    const proposal: GameProposal = {
      id: `proposal-${generateUUID().slice(0, 8)}`,
      gameId: params.gameId,
      gameName: params.gameName,
      title: params.title,
      description: params.description,
      reason: params.reason,
      proposalType: params.proposalType,
      payload: params.payload,
      status: ProposalStatus.ACTIVE,
      proposerId: params.proposerId,
      proposerName: params.proposerName,
      proposerType: params.proposerType,
      voteThreshold: threshold,
      voteDurationHours: durationHours,
      votingStartAt: now,
      votingEndAt: now + durationHours * 3600000,
      whitelist: params.whitelist,
      revenueSharing: params.revenueSharing,
      voteRecords: [],
      createdAt: now,
    };

    proposals.push(proposal);
    saveProposals(proposals);

    // 🆕 凭证化：新提案自动启动投票凭证周期
    try {
      voteVoucherService.startVoteCycle(proposal);
    } catch (err) {
      console.warn('[GameProposal] 投票凭证周期启动失败（不影响提案创建）:', err);
    }

    // 广播提案创建事件
    window.dispatchEvent(new CustomEvent('proposal-created', { detail: { proposal } }));
    console.log(`[GameProposal] 提案创建: ${proposal.title} (${proposal.id})`);
    return proposal;
  }

  /**
   * 对提案投票
   * 优先使用投票凭证系统（新提案），回退到直接投票记录（旧提案兼容）
   */
  submitProposalVote(
    proposalId: string,
    voterId: string,
    voterName: string,
    voterType: VoteStakeholderType,
    decision: ProposalVoteDecision,
    comment?: string
  ): { success: boolean; proposal?: GameProposal; message: string } {
    const proposals = loadProposals();
    const index = proposals.findIndex(p => p.id === proposalId);
    if (index === -1) {
      return { success: false, message: '提案不存在' };
    }

    const proposal = proposals[index];

    // 检查提案状态
    if (proposal.status !== ProposalStatus.ACTIVE) {
      return { success: false, message: '提案已结束，无法投票' };
    }

    // 检查投票截止时间
    if (Date.now() > proposal.votingEndAt) {
      this.finalizeProposal(proposalId);
      return { success: false, message: '投票已截止' };
    }

    // 🆕 优先使用投票凭证系统
    const voteVoucher = voteVoucherService.getUserVoteVoucher(proposalId, voterId);
    if (voteVoucher) {
      // 🛡️ 防作弊预检
      const fraudCheck = voteFraudDetector.precheckVote(
        voterId, voterName, proposalId, voteVoucher.denomination,
      );
      if (fraudCheck.warnings.length > 0) {
        console.warn(`[FraudDetector] ⚠️ 投票前警告 (${voterName}):`, fraudCheck.warnings);
      }

      // 新提案：通过凭证系统投票
      const result = voteVoucherService.castVote(voteVoucher.id, voterId, decision, comment);
      if (!result.success) {
        return { success: false, message: result.message };
      }

      // 同步更新提案的 voteRecords（保持兼容）
      const players = generateSimulatedPlayers();
      const player = players.find(p => p.id === voterId);
      const record: ProposalVoteRecord = {
        id: `vr-${generateUUID().slice(0, 8)}`,
        proposalId,
        voterId,
        voterName,
        voterType,
        decision,
        comment,
        votedAt: Date.now(),
        voteWeight: voteVoucher.denomination,
      };
      proposal.voteRecords.push(record);
      saveProposals(proposals);

      // 同步结算状态
      this.syncVoucherSettlementToProposal(proposal);

      window.dispatchEvent(new CustomEvent('proposal-voted', {
        detail: { proposalId, voterName, decision },
      }));

      console.log(`[GameProposal] 🗳️ ${voterName} ${decision === 'approve' ? '赞成' : decision === 'reject' ? '反对' : '弃权'} (凭证投票) ${proposal.title}`);
      return { success: true, proposal, message: '投票成功' };
    }

    // 🆕 没有投票凭证时，检查该提案是否为新提案（有关联的 VoteCycle）
    // 新提案必须通过凭证系统投票，无凭证者应被拒绝
    const voteCycle = voteVoucherService.getVoteCycle(proposalId);
    if (voteCycle) {
      return { success: false, message: '🎫 您没有该提案的投票凭证，无法投票。请联系提案发起人或确认是否在白名单中。' };
    }

    // 旧提案兼容：白名单检查
    if (proposal.whitelist && proposal.whitelist.length > 0) {
      if (!proposal.whitelist.includes(voterId)) {
        return { success: false, message: '您不在本次投票白名单中' };
      }
    }

    // 旧提案：检查是否已投票
    const existingVote = proposal.voteRecords.find(v => v.voterId === voterId);
    if (existingVote) {
      return { success: false, message: '您已投过票，无法重复投票' };
    }

    // 计算动态投票权重
    const players = generateSimulatedPlayers();
    const player = players.find(p => p.id === voterId);
    const allMetrics = generatePlayerMetrics(proposal.gameId);
    const playerMetrics = player ? allMetrics[player.id] : undefined;
    const voteWeight = player && playerMetrics
      ? calculateVoteWeight(player, playerMetrics, proposal.gameId)
      : (player?.voteWeight || 1.0);

    // 记录投票
    const record: ProposalVoteRecord = {
      id: `vr-${generateUUID().slice(0, 8)}`,
      proposalId,
      voterId,
      voterName,
      voterType,
      decision,
      comment,
      votedAt: Date.now(),
      voteWeight,
    };

    proposal.voteRecords.push(record);
    saveProposals(proposals);

    // 检查是否可以提前结束
    this.checkAndFinalize(proposal);

    // 广播投票事件
    window.dispatchEvent(new CustomEvent('proposal-voted', {
      detail: { proposalId, voterName, decision },
    }));

    console.log(`[GameProposal] ${voterName} ${decision === 'approve' ? '赞成' : decision === 'reject' ? '反对' : '弃权'} 提案 ${proposal.title}`);
    return { success: true, proposal, message: '投票成功' };
  }

  /**
   * 检查是否可以提前结束投票
   */
  private checkAndFinalize(proposal: GameProposal): void {
    const players = generateSimulatedPlayers();
    const allEligible = proposal.whitelist && proposal.whitelist.length > 0
      ? players.filter(p => proposal.whitelist!.includes(p.id))
      : players;

    const totalEligible = allEligible.length;
    const totalVoted = proposal.voteRecords.length;

    // 如果所有人都投票了，提前结束
    if (totalVoted >= totalEligible) {
      this.finalizeProposal(proposal.id);
    }
  }

  /**
   * 结束投票并计算结果
   */
  finalizeProposal(proposalId: string): { success: boolean; proposal?: GameProposal; message: string } {
    const proposals = loadProposals();
    const index = proposals.findIndex(p => p.id === proposalId);
    if (index === -1) {
      return { success: false, message: '提案不存在' };
    }

    const proposal = proposals[index];

    // 刷新数据
    const freshProposals = loadProposals();
    const freshProposal = freshProposals.find(p => p.id === proposalId);
    if (!freshProposal) {
      return { success: false, message: '提案不存在' };
    }

    if (freshProposal.status !== ProposalStatus.ACTIVE) {
      return { success: false, message: '提案已经结束' };
    }

    // 🆕 优先使用投票凭证系统结算
    const voteCycle = voteVoucherService.getVoteCycle(proposalId);
    let result: ProposalResult;

    if (voteCycle) {
      // 新提案：使用凭证系统结算（如果尚未结算）
      if (voteCycle.status !== 'completed') {
        const settleResult = voteVoucherService.settleVoteCycle(proposalId);
        if (!settleResult.success || !settleResult.result) {
          return { success: false, message: settleResult.message };
        }

        // 转换为 ProposalResult
        result = {
          gameDeveloperVotes: settleResult.result.gameDeveloperVotes,
          playerCommunityVotes: settleResult.result.playerCommunityVotes,
          platformVotes: settleResult.result.platformVotes,
          weightedApproveScore: settleResult.result.weightedApproveScore,
          weightedRejectScore: settleResult.result.weightedRejectScore,
          totalEligibleVoters: settleResult.result.totalEligibleVoters,
          totalVoted: settleResult.result.totalVoted,
          participationRate: settleResult.result.participationRate,
          finalStatus: settleResult.result.finalStatus,
          passedAt: settleResult.result.passedAt,
        };
      } else {
        // 已经自动结算过，复用已有结果
        result = {
          gameDeveloperVotes: voteCycle.result!.gameDeveloperVotes,
          playerCommunityVotes: voteCycle.result!.playerCommunityVotes,
          platformVotes: voteCycle.result!.platformVotes,
          weightedApproveScore: voteCycle.result!.weightedApproveScore,
          weightedRejectScore: voteCycle.result!.weightedRejectScore,
          totalEligibleVoters: voteCycle.result!.totalEligibleVoters,
          totalVoted: voteCycle.result!.totalVoted,
          participationRate: voteCycle.result!.participationRate,
          finalStatus: voteCycle.result!.finalStatus,
          passedAt: voteCycle.result!.passedAt,
        };
      }

      freshProposal.result = result;
      freshProposal.status = result.finalStatus;
    } else {
      // 旧提案：传统计算方式
      result = this.calculateResult(freshProposal);
      freshProposal.result = result;

      // 检查是否满足通过条件
      const players = generateSimulatedPlayers();
      const allEligible = freshProposal.whitelist && freshProposal.whitelist.length > 0
        ? players.filter(p => freshProposal.whitelist!.includes(p.id))
        : players;

      // 检查法定人数
      if (result.participationRate < freshProposal.voteThreshold.quorumRate) {
        freshProposal.status = ProposalStatus.REJECTED;
        result.finalStatus = ProposalStatus.REJECTED;
      } else if (result.weightedApproveScore >= freshProposal.voteThreshold.passThreshold) {
        freshProposal.status = ProposalStatus.PASSED;
        result.finalStatus = ProposalStatus.PASSED;
        result.passedAt = Date.now();
      } else {
        freshProposal.status = ProposalStatus.REJECTED;
        result.finalStatus = ProposalStatus.REJECTED;
      }
    }

    saveProposals(freshProposals);

    // 🛡️ 结算后防作弊审计
    try {
      const voteTimestamps = freshProposal.voteRecords
        .filter(r => r.votedAt)
        .map(r => ({ voterId: r.voterId, timestamp: r.votedAt }));
      const decisions = freshProposal.voteRecords.map(r => ({
        voterId: r.voterId,
        decision: r.decision,
      }));
      const weights = freshProposal.voteRecords.map(r => ({
        voterId: r.voterId,
        weight: r.voteWeight,
      }));
      const auditLogs = voteFraudDetector.postSettlementAudit(
        proposalId, voteTimestamps, decisions, weights,
      );
      if (auditLogs.length > 0) {
        console.log(`[FraudDetector] 📋 结算审计完成: ${auditLogs.length} 条日志`, auditLogs);
      }
    } catch (e) {
      console.warn('[FraudDetector] 结算审计失败:', e);
    }

    // 🆕 自动执行逻辑：提案通过 + autoExecute=true → 触发自动执行事件
    if (freshProposal.status === ProposalStatus.PASSED && freshProposal.voteThreshold.autoExecute) {
      window.dispatchEvent(new CustomEvent('proposal-auto-execute', {
        detail: { proposal: freshProposal },
      }));
      console.log(`[GameProposal] 🔧 自动执行触发: ${freshProposal.title}`);
    }

    // 广播投票结束事件
    window.dispatchEvent(new CustomEvent('proposal-finalized', {
      detail: { proposal: freshProposal },
    }));

    console.log(`[GameProposal] 投票结束: ${freshProposal.title} → ${freshProposal.status}`);
    return {
      success: true,
      proposal: freshProposal,
      message: freshProposal.status === ProposalStatus.PASSED ? '提案已通过' : '提案被拒绝',
    };
  }

  /**
   * 计算加权投票结果
   */
  private calculateResult(proposal: GameProposal): ProposalResult {
    const players = generateSimulatedPlayers();
    const allEligible = proposal.whitelist && proposal.whitelist.length > 0
      ? players.filter(p => proposal.whitelist!.includes(p.id))
      : players;

    const result: ProposalResult = {
      gameDeveloperVotes: { approve: 0, reject: 0, abstain: 0 },
      playerCommunityVotes: { approve: 0, reject: 0, abstain: 0 },
      platformVotes: { approve: 0, reject: 0, abstain: 0 },
      weightedApproveScore: 0,
      weightedRejectScore: 0,
      totalEligibleVoters: allEligible.length,
      totalVoted: proposal.voteRecords.length,
      participationRate: proposal.voteRecords.length / Math.max(allEligible.length, 1),
      finalStatus: proposal.status,
    };

    // 按利益方分组统计
    for (const record of proposal.voteRecords) {
      const group = record.voterType === VoteStakeholderType.GAME_DEVELOPER
        ? 'gameDeveloperVotes'
        : record.voterType === VoteStakeholderType.PLAYER_COMMUNITY
          ? 'playerCommunityVotes'
          : 'platformVotes';

      result[group][record.decision]++;
    }

    // 计算各方权重得分
    const weights = proposal.voteThreshold.weights;

    // 游戏方得分
    const devTotal = allEligible.filter(p => p.type === VoteStakeholderType.GAME_DEVELOPER).length;
    if (devTotal > 0) {
      const devApproveRate = result.gameDeveloperVotes.approve / devTotal;
      const devRejectRate = result.gameDeveloperVotes.reject / devTotal;
      result.weightedApproveScore += devApproveRate * weights.gameDeveloper;
      result.weightedRejectScore += devRejectRate * weights.gameDeveloper;
    }

    // 玩家社区得分
    const playerTotal = allEligible.filter(p => p.type === VoteStakeholderType.PLAYER_COMMUNITY).length;
    if (playerTotal > 0) {
      // 玩家使用加权投票
      let playerWeightedApprove = 0;
      let playerWeightedReject = 0;
      let playerTotalWeight = 0;

      for (const p of allEligible.filter(p => p.type === VoteStakeholderType.PLAYER_COMMUNITY)) {
        const vote = proposal.voteRecords.find(v => v.voterId === p.id);
        if (vote) {
          playerTotalWeight += vote.voteWeight;
          if (vote.decision === 'approve') playerWeightedApprove += vote.voteWeight;
          if (vote.decision === 'reject') playerWeightedReject += vote.voteWeight;
        } else {
          playerTotalWeight += p.voteWeight;
        }
      }

      if (playerTotalWeight > 0) {
        result.weightedApproveScore += (playerWeightedApprove / playerTotalWeight) * weights.playerCommunity;
        result.weightedRejectScore += (playerWeightedReject / playerTotalWeight) * weights.playerCommunity;
      }
    }

    // 平台方得分
    const platformTotal = allEligible.filter(p => p.type === VoteStakeholderType.PLATFORM).length;
    if (platformTotal > 0) {
      const platformApproveRate = result.platformVotes.approve / platformTotal;
      const platformRejectRate = result.platformVotes.reject / platformTotal;
      result.weightedApproveScore += platformApproveRate * weights.platform;
      result.weightedRejectScore += platformRejectRate * weights.platform;
    }

    return result;
  }

  /**
   * 否决提案（仅创始人/平台管理员）
   */
  vetoProposal(proposalId: string, vetoerId: string): { success: boolean; proposal?: GameProposal; message: string } {
    const proposals = loadProposals();
    const index = proposals.findIndex(p => p.id === proposalId);
    if (index === -1) {
      return { success: false, message: '提案不存在' };
    }

    const proposal = proposals[index];

    if (proposal.status !== ProposalStatus.ACTIVE) {
      return { success: false, message: '只能否决进行中的提案' };
    }

    if (!proposal.voteThreshold.vetoEnabled) {
      return { success: false, message: '该游戏未启用否决权' };
    }

    // 检查否决权限
    const players = generateSimulatedPlayers();
    const vetoer = players.find(p => p.id === vetoerId);
    if (!vetoer) {
      return { success: false, message: '无否决权限' };
    }

    if (proposal.voteThreshold.vetoByFounderOnly && !vetoer.hasVetoRight) {
      return { success: false, message: '仅平台创始人拥有一票否决权' };
    }

    proposal.status = ProposalStatus.VETOED;
    if (!proposal.result) {
      proposal.result = this.calculateResult(proposal);
    }
    proposal.result.finalStatus = ProposalStatus.VETOED;

    saveProposals(proposals);

    window.dispatchEvent(new CustomEvent('proposal-vetoed', {
      detail: { proposal, vetoerName: vetoer.name },
    }));

    console.log(`[GameProposal] ${vetoer.name} 否决提案: ${proposal.title}`);
    return { success: true, proposal, message: `提案已被 ${vetoer.name} 否决` };
  }

  /**
   * 执行通过的提案
   */
  executeProposal(proposalId: string, executorId?: string): { success: boolean; message: string } {
    const proposals = loadProposals();
    const index = proposals.findIndex(p => p.id === proposalId);
    if (index === -1) {
      return { success: false, message: '提案不存在' };
    }

    const proposal = proposals[index];

    if (proposal.status !== ProposalStatus.PASSED) {
      return { success: false, message: '只有已通过的提案才能执行' };
    }

    proposal.status = ProposalStatus.EXECUTED;
    proposal.executedAt = Date.now();
    if (proposal.result) {
      proposal.result.executedAt = Date.now();
      proposal.result.executedBy = executorId;
    }

    saveProposals(proposals);

    window.dispatchEvent(new CustomEvent('proposal-executed', {
      detail: { proposal },
    }));

    console.log(`[GameProposal] 提案已执行: ${proposal.title}`);
    return { success: true, message: '提案已执行' };
  }

  /**
   * 标记提案执行失败
   */
  markExecutionFailed(proposalId: string, error: string): void {
    const proposals = loadProposals();
    const index = proposals.findIndex(p => p.id === proposalId);
    if (index === -1) return;

    proposals[index].status = ProposalStatus.EXECUTION_FAILED;
    proposals[index].executionResult = error;
    saveProposals(proposals);

    console.error(`[GameProposal] 提案执行失败: ${proposals[index].title} - ${error}`);
  }

  // ============ 查询方法 ============

  /**
   * 获取游戏的所有提案
   */
  getGameProposals(gameId: string): GameProposal[] {
    return loadProposals()
      .filter(p => p.gameId === gameId)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * 获取活跃提案
   */
  getActiveProposals(gameId?: string): GameProposal[] {
    let proposals = loadProposals().filter(p => p.status === ProposalStatus.ACTIVE);

    // 自动结束过期提案
    const now = Date.now();
    for (const p of proposals) {
      if (now > p.votingEndAt) {
        this.finalizeProposal(p.id);
      }
    }

    // 重新加载以获取更新后的状态
    proposals = loadProposals().filter(p => p.status === ProposalStatus.ACTIVE);

    if (gameId) {
      proposals = proposals.filter(p => p.gameId === gameId);
    }

    return proposals.sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * 获取已完成提案
   */
  getFinishedProposals(gameId?: string): GameProposal[] {
    let proposals = loadProposals().filter(
      p => p.status !== ProposalStatus.ACTIVE && p.status !== ProposalStatus.DRAFT
    );

    if (gameId) {
      proposals = proposals.filter(p => p.gameId === gameId);
    }

    return proposals.sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * 获取单个提案
   */
  getProposal(id: string): GameProposal | undefined {
    return loadProposals().find(p => p.id === id);
  }

  /**
   * 获取所有提案
   */
  getAllProposals(): GameProposal[] {
    return loadProposals().sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * 删除提案（仅草稿或已完成的）
   */
  deleteProposal(proposalId: string): boolean {
    const proposals = loadProposals();
    const index = proposals.findIndex(p => p.id === proposalId);
    if (index === -1) return false;

    if (proposals[index].status === ProposalStatus.ACTIVE) {
      console.warn('[GameProposal] 无法删除进行中的提案');
      return false;
    }

    proposals.splice(index, 1);
    saveProposals(proposals);
    return true;
  }

  // ============ 惩罚机制 ============

  /**
   * 同步凭证结算状态到提案（检查是否有已结算的凭证周期）
   */
  private syncVoucherSettlementToProposal(proposal: GameProposal): void {
    const cycle = voteVoucherService.getVoteCycle(proposal.id);
    if (!cycle || !cycle.result) return;

    // 如果凭证系统已结算但提案状态未同步
    if (proposal.status === ProposalStatus.ACTIVE &&
      (cycle.result.finalStatus === ProposalStatus.PASSED ||
       cycle.result.finalStatus === ProposalStatus.REJECTED)) {
      this.finalizeProposal(proposal.id);
    }
  }

  /**
   * 获取游戏的惩罚次数
   */
  getGameRefusalCount(gameId: string): number {
    const logs = loadPenaltyLogs();
    return logs.filter(l => l.gameId === gameId && l.isActive).length;
  }

  /**
   * 应用惩罚
   */
  applyPenalty(
    gameId: string,
    gameName: string,
    proposalId: string,
    proposalTitle: string,
    penaltyType: PenaltyType,
    description: string,
    durationHours?: number,
  ): PenaltyLog {
    const logs = loadPenaltyLogs();

    const log: PenaltyLog = {
      id: `penalty-${generateUUID().slice(0, 8)}`,
      gameId,
      gameName,
      proposalId,
      proposalTitle,
      penaltyType,
      description,
      durationHours,
      appliedAt: Date.now(),
      expiresAt: durationHours ? Date.now() + durationHours * 3600000 : undefined,
      isActive: true,
    };

    logs.push(log);
    savePenaltyLogs(logs);

    // 广播惩罚事件
    window.dispatchEvent(new CustomEvent('penalty-applied', { detail: { penalty: log } }));

    console.log(`[GameProposal] 惩罚已应用: ${gameName} - ${description}`);
    return log;
  }

  /**
   * 获取游戏的惩罚日志
   */
  getGamePenaltyLogs(gameId: string): PenaltyLog[] {
    return loadPenaltyLogs()
      .filter(l => l.gameId === gameId)
      .sort((a, b) => b.appliedAt - a.appliedAt);
  }

  /**
   * 获取所有活跃的惩罚
   */
  getActivePenalties(): PenaltyLog[] {
    return loadPenaltyLogs().filter(l => l.isActive);
  }

  /**
   * 撤销惩罚
   */
  revokePenalty(penaltyId: string): boolean {
    const logs = loadPenaltyLogs();
    const index = logs.findIndex(l => l.id === penaltyId);
    if (index === -1) return false;

    logs[index].isActive = false;
    savePenaltyLogs(logs);
    return true;
  }

  /**
   * 检查过期惩罚并自动撤销
   */
  checkExpiredPenalties(): void {
    const logs = loadPenaltyLogs();
    const now = Date.now();
    let changed = false;

    for (const log of logs) {
      if (log.isActive && log.expiresAt && now > log.expiresAt) {
        log.isActive = false;
        changed = true;
      }
    }

    if (changed) {
      savePenaltyLogs(logs);
    }
  }
}

// 导出单例
export const gameProposalService = new GameProposalService();
export default gameProposalService;
