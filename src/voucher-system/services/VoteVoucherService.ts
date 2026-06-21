/**
 * 投票凭证服务
 * 
 * 将投票流程凭证化，使投票成为凭证系统的一种凭证类型。
 * 混合型设计：
 *   - 阶段一（分发）：即时型语义，提案创建时为每位合格选民发行投票凭证
 *   - 阶段二（投票）：凭证消耗，玩家使用投票凭证提交投票决策
 *   - 阶段三（结算）：计算型语义，收集所有投票凭证，加权计算最终结果
 * 
 * 仅对新提案生效，不可转让。
 */

import { VoucherService, voucherService } from './VoucherService';
import {
  VoucherSourceType,
  VoucherStatus,
  TransactionType,
  type Voucher,
  type Transaction,
} from '../types';
import {
  VoteSettlementStatus,
  VoteCycleStatus,
  type VoteCycle,
  type VoteVoucherInfo,
  type VoteSettlementResult,
} from '../types/vote';
import {
  ProposalStatus,
  VoteStakeholderType,
  GameProposalTypeLabel,
  type ProposalVoteDecision,
  type GameProposal,
  type ProposalVoteRecord,
  type PlayerMetrics,
} from '@/types/gameProposal';
import { generateSimulatedPlayers, calculateVoteWeight, generatePlayerMetrics } from '@/data/simulatedPlayers';
import { persistWithCloudSync, loadWithCloudSync } from '../storage/cloudSync';

// ==================== 常量 ====================

const VOTE_CYCLES_KEY = 'allinone_vote_cycles';
const VOTE_CYCLES_COLLECTION = 'vote_cycles';
const MAX_BATCH_SIZE = 500; // 单次批量创建上限

// ==================== 存储工具 ====================

function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

let voteCyclesCache: VoteCycle[] | null = null;
let cloudSyncInitiated = false;

function loadVoteCycles(): VoteCycle[] {
  if (voteCyclesCache) return voteCyclesCache;
  const { data, cloudSync } = loadWithCloudSync<VoteCycle>(VOTE_CYCLES_KEY, VOTE_CYCLES_COLLECTION);
  voteCyclesCache = data;
  // 捕获初始本地 ID 集合，防止已删除的投票周期从云端"复活"
  const originalIds = new Set(data.map(c => c.id));
  if (!cloudSyncInitiated) {
    cloudSyncInitiated = true;
    cloudSync.then(merged => {
      // 增量合并：只添加缓存中不存在的项，避免覆写期间新创建的数据
      const current = voteCyclesCache!;
      const currentIds = new Set(current.map(c => c.id));
      let added = false;
      for (const m of merged) {
        // 仅添加：云端独有（不在原始本地集合，防僵尸）+ 不在当前缓存（防重复）
        if (!originalIds.has(m.id) && !currentIds.has(m.id)) {
          current.push(m);
          added = true;
        }
      }
      if (added) {
        voteCyclesCache = [...current];
        persistWithCloudSync(VOTE_CYCLES_KEY, voteCyclesCache, VOTE_CYCLES_COLLECTION);
      }
    }).catch(() => {});
  }
  return voteCyclesCache;
}

function saveVoteCycles(cycles: VoteCycle[]): void {
  voteCyclesCache = cycles;
  persistWithCloudSync(VOTE_CYCLES_KEY, cycles, VOTE_CYCLES_COLLECTION);
}

// ==================== 辅助函数 ====================

/**
 * 从 Voucher.metadata.customData 中提取投票凭证信息
 */
function extractVoteInfo(voucher: Voucher): VoteVoucherInfo | null {
  const customData = voucher.metadata?.customData;
  if (!customData || voucher.sourceType !== VoucherSourceType.VOTE) return null;
  return customData.voteInfo as VoteVoucherInfo | null;
}

/**
 * 构建投票凭证的 metadata
 * 名称格式：🗳️ [状态] 游戏简称 - 提案标题（提案类型标签）
 * 描述中包含截止时间、提案简述等关键信息，防止多提案并行时投错票
 */
function buildVoteMetadata(voteInfo: VoteVoucherInfo, proposalTitle: string): {
  name: string;
  description: string;
  category: string;
  tags: string[];
  sourceType: VoucherSourceType;
  customData: Record<string, any>;
} {
  const statusLabel = voteInfo.settlementStatus === 'settled'
    ? '已结算'
    : voteInfo.settlementStatus === 'cast'
      ? '已投票'
      : '待投票';

  const gameSlug = voteInfo.gameName.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '').toLowerCase().substring(0, 10);
  const deadlineStr = voteInfo.votingEndAt
    ? new Date(voteInfo.votingEndAt).toLocaleString('zh-CN', {
        month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
      })
    : '待定';
  const proposalShortId = voteInfo.proposalId.replace(/[^a-zA-Z0-9]/g, '').slice(-8);

  return {
    name: `🗳️ [${statusLabel}] ${voteInfo.gameName} - ${proposalTitle}`,
    description: [
      `对游戏「${voteInfo.gameName}」的「${voteInfo.proposalType}」提案进行投票。`,
      `📋 提案简述：${voteInfo.proposalDescription || proposalTitle}`,
      `⏰ 投票截止：${deadlineStr}`,
      `🏷️ 提案编号：#${proposalShortId}`,
    ].join('\n'),
    category: 'vote',
    tags: ['vote', 'governance', 'community', gameSlug, voteInfo.proposalType],
    sourceType: VoucherSourceType.VOTE,
    customData: { voteInfo },
  };
}

// ==================== 服务类 ====================

export class VoteVoucherService {
  private vs: VoucherService;

  constructor() {
    this.vs = voucherService;
  }

  // ============ 阶段一：投票权分发 ============

  /**
   * 启动投票周期，为所有合格选民发行投票凭证
   * 在提案创建并进入 ACTIVE 状态时调用
   */
  startVoteCycle(proposal: GameProposal): {
    cycle: VoteCycle;
    voteVouchers: Voucher[];
  } {
    // 1. 获取所有合格选民
    const players = generateSimulatedPlayers();
    const eligibleVoters = proposal.whitelist && proposal.whitelist.length > 0
      ? players.filter(p => proposal.whitelist!.includes(p.id))
      : players;
    const allMetrics = generatePlayerMetrics(proposal.gameId);

    if (eligibleVoters.length === 0) {
      throw new Error('没有合格的投票者');
    }

    // 2. 创建 VoteCycle
    const cycle: VoteCycle = {
      id: `vc-${proposal.id}`,
      proposalId: proposal.id,
      gameId: proposal.gameId,
      gameName: proposal.gameName,
      proposalTitle: proposal.title,
      proposalDescription: proposal.description,
      startDate: proposal.votingStartAt,
      endDate: proposal.votingEndAt,
      settlementDate: new Date(proposal.votingEndAt).toISOString().split('T')[0],
      status: VoteCycleStatus.ACTIVE,
      voteVoucherIds: [],
      thresholdSnapshot: {
        weights: { ...proposal.voteThreshold.weights },
        quorumRate: proposal.voteThreshold.quorumRate,
        passThreshold: proposal.voteThreshold.passThreshold,
        vetoEnabled: proposal.voteThreshold.vetoEnabled,
        autoExecute: proposal.voteThreshold.autoExecute,
      },
      createdAt: Date.now(),
    };

    // 3. 为每位合格选民创建投票凭证
    const vouchers: Voucher[] = [];
    const playerMetricsMap: Record<string, PlayerMetrics> = {};
    for (const p of eligibleVoters) {
      playerMetricsMap[p.id] = allMetrics[p.id] || {
        playerId: p.id,
        activeDaysLast30: 0,
        acoinBalance: 0,
        voucherCount: 0,
        voteParticipationRate: 0,
        gameItemHoldings: {},
        communityReputation: 0,
      };
    }

    for (const player of eligibleVoters) {
      const metrics = playerMetricsMap[player.id];
      const voteWeight = calculateVoteWeight(player, metrics, proposal.gameId);

      const voteInfo: VoteVoucherInfo = {
        proposalId: proposal.id,
        proposalTitle: proposal.title,
        gameId: proposal.gameId,
        gameName: proposal.gameName,
        votingEndAt: proposal.votingEndAt,
        proposalType: GameProposalTypeLabel[proposal.proposalType] || '未知类型',
        proposalDescription: proposal.description.length > 80
          ? proposal.description.substring(0, 80) + '...'
          : proposal.description,
        voterType: player.type,
        baseVoteWeight: player.voteWeight,
        dynamicWeightSnapshot: {
          activeDaysLast30: metrics?.activeDaysLast30 || 0,
          acoinBalance: metrics?.acoinBalance || 0,
          voucherCount: metrics?.voucherCount || 0,
          voteParticipationRate: metrics?.voteParticipationRate || 0,
          communityReputation: metrics?.communityReputation || 0,
        },
        settlementStatus: VoteSettlementStatus.PENDING,
      };

      try {
        const metadata = buildVoteMetadata(voteInfo, proposal.title);
        const voucher = this.vs.createVoucher(
          {
            denomination: voteWeight, // 面额 = 投票权重
            recipientId: player.id,
            recipientName: player.name,
            metadata,
            note: `投票凭证：提案"${proposal.title}"`,
          },
          'SYSTEM',
          '投票系统',
        );
        vouchers.push(voucher);
        cycle.voteVoucherIds.push(voucher.id);
      } catch (error) {
        console.error(`[VoteVoucher] 为 ${player.name} 创建投票凭证失败:`, error);
      }
    }

    // 4. 保存 VoteCycle
    const cycles = loadVoteCycles();
    cycles.push(cycle);
    saveVoteCycles(cycles);

    // 5. 广播事件
    window.dispatchEvent(new CustomEvent('vote-cycle-started', {
      detail: { cycle, voterCount: vouchers.length, proposalId: proposal.id },
    }));

    console.log(`[VoteVoucher] 🗳️ 投票周期已启动: ${proposal.title} | ${vouchers.length} 张投票凭证已发行`);
    return { cycle, voteVouchers: vouchers };
  }

  // ============ 查询方法 ============

  /**
   * 获取某提案中某用户的投票凭证
   */
  getUserVoteVoucher(proposalId: string, userId: string): Voucher | null {
    const allVouchers = this.vs.getUserVouchers(userId);
    return allVouchers.find(v => {
      if (v.sourceType !== VoucherSourceType.VOTE) return false;
      const info = extractVoteInfo(v);
      return info?.proposalId === proposalId;
    }) || null;
  }

  /**
   * 获取提案的所有投票凭证
   */
  getProposalVoteVouchers(proposalId: string): Voucher[] {
    // 通过 VoteCycle 获取 voucher IDs
    const cycle = this.getVoteCycle(proposalId);
    if (!cycle) return [];

    const vouchers: Voucher[] = [];
    for (const voucherId of cycle.voteVoucherIds) {
      const v = this.vs.getVoucherById(voucherId);
      if (v) vouchers.push(v);
    }
    return vouchers;
  }

  /**
   * 获取玩家所有投票凭证
   * @param userId 用户ID
   * @param status 可选的状态筛选（默认不过滤，返回全部投票凭证）
   */
  getUserVoteVouchers(userId: string, status?: VoucherStatus): Voucher[] {
    const allVouchers = this.vs.getUserVouchers(userId);
    const voteVouchers = allVouchers.filter(v => v.sourceType === VoucherSourceType.VOTE);
    if (status) {
      return voteVouchers.filter(v => v.status === status);
    }
    return voteVouchers;
  }

  /**
   * 获取投票周期
   */
  getVoteCycle(proposalId: string): VoteCycle | undefined {
    return loadVoteCycles().find(c => c.proposalId === proposalId);
  }

  /**
   * 获取所有投票周期
   */
  getAllVoteCycles(): VoteCycle[] {
    return loadVoteCycles();
  }

  /**
   * 获取投票统计
   */
  getVoteStatistics(proposalId: string): {
    totalEligible: number;
    totalVoted: number;
    approveCount: number;
    rejectCount: number;
    abstainCount: number;
    remaining: number;
    expired: boolean;
  } {
    const vouchers = this.getProposalVoteVouchers(proposalId);
    const cycle = this.getVoteCycle(proposalId);

    let approveCount = 0, rejectCount = 0, abstainCount = 0, votedCount = 0;

    for (const v of vouchers) {
      const info = extractVoteInfo(v);
      if (!info) continue;
      if (info.settlementStatus !== VoteSettlementStatus.PENDING) {
        votedCount++;
        if (info.decision === 'approve') approveCount++;
        else if (info.decision === 'reject') rejectCount++;
        else if (info.decision === 'abstain') abstainCount++;
      }
    }

    return {
      totalEligible: vouchers.length,
      totalVoted: votedCount,
      approveCount,
      rejectCount,
      abstainCount,
      remaining: vouchers.length - votedCount,
      expired: cycle ? Date.now() > cycle.endDate : false,
    };
  }

  // ============ 阶段二：投票执行 ============

  /**
   * 玩家使用投票凭证提交投票决策
   * @returns 操作结果
   */
  castVote(
    voucherId: string,
    userId: string,
    decision: ProposalVoteDecision,
    comment?: string,
  ): { success: boolean; message: string; updatedVoucher?: Voucher } {
    const voucher = this.vs.getVoucherById(voucherId);

    if (!voucher) {
      return { success: false, message: '投票凭证不存在' };
    }

    if (voucher.sourceType !== VoucherSourceType.VOTE) {
      return { success: false, message: '该凭证不是投票凭证' };
    }

    // 检查凭证状态
    if (voucher.status !== VoucherStatus.ACTIVE) {
      return { success: false, message: `凭证状态异常: ${voucher.status}` };
    }

    // 检查持有者
    if (voucher.currentHolderId !== userId) {
      return { success: false, message: '您不是该凭证的持有者，无权投票' };
    }

    // 提取投票信息
    const voteInfo = extractVoteInfo(voucher);
    if (!voteInfo) {
      return { success: false, message: '投票凭证数据异常' };
    }

    // 检查是否已投票
    if (voteInfo.settlementStatus !== VoteSettlementStatus.PENDING) {
      return { success: false, message: '您已投过票，无法重复投票' };
    }

    // 检查投票时间是否过期
    const cycle = this.getVoteCycle(voteInfo.proposalId);
    if (cycle && Date.now() > cycle.endDate) {
      return { success: false, message: '投票已截止' };
    }

    // 更新投票凭证信息
    const now = Date.now();
    voteInfo.decision = decision;
    voteInfo.votedAt = now;
    voteInfo.voteComment = comment;
    voteInfo.settlementStatus = VoteSettlementStatus.CAST;

    // 更新凭证 metadata
    if (!voucher.metadata) {
      voucher.metadata = { name: '', description: '', category: '', tags: [], sourceType: VoucherSourceType.VOTE, customData: {} };
    }
    if (!voucher.metadata.customData) {
      voucher.metadata.customData = {};
    }
    voucher.metadata.customData.voteInfo = voteInfo;

    // 刷新凭证名称，反映已投票状态
    const gameName = voteInfo.gameName || '';
    voucher.metadata.name = `🗳️ [已投票] ${gameName} - ${voteInfo.proposalTitle}`;

    // 标记为已消耗（FROZEN = 已投票但未结算的状态）
    voucher.status = VoucherStatus.FROZEN;

    // 存储更新
    const voucherDB = (this.vs as any).db;
    if (voucherDB && typeof voucherDB.updateVoucher === 'function') {
      voucherDB.updateVoucher(voucher);
    }

    // 创建投票交易记录
    try {
      const txNote = `投票: ${decision === 'approve' ? '赞成' : decision === 'reject' ? '反对' : '弃权'} "${voteInfo.proposalTitle}"${comment ? ` (${comment})` : ''}`;
      // 直接插入交易记录
      if (voucherDB && typeof voucherDB.insertTransaction === 'function') {
        const tx: Transaction = {
          id: generateUUID(),
          voucherId: voucher.id,
          type: TransactionType.EXCHANGE, // 使用兑换类型标记投票消耗
          fromUserId: userId,
          fromUserName: voucher.currentHolderName,
          toUserId: 'VOTE_SYSTEM',
          toUserName: '投票系统',
          amount: voucher.denomination,
          timestamp: now,
          txHash: '',
          note: txNote,
        };
        voucherDB.insertTransaction(tx);
      }
    } catch (e) {
      console.warn('[VoteVoucher] 交易记录写入失败:', e);
    }

    // 广播投票事件
    window.dispatchEvent(new CustomEvent('vote-cast', {
      detail: {
        proposalId: voteInfo.proposalId,
        voterId: userId,
        decision,
        voucherId,
      },
    }));

    console.log(`[VoteVoucher] ✅ ${voucher.currentHolderName} ${decision === 'approve' ? '赞成' : decision === 'reject' ? '反对' : '弃权'} "${voteInfo.proposalTitle}"`);

    // 检查是否可以提前结算
    this.checkAndSettle(voteInfo.proposalId);

    return { success: true, message: '投票成功', updatedVoucher: voucher };
  }

  /**
   * 检查是否可以提前结束投票
   */
  private checkAndSettle(proposalId: string): void {
    const stats = this.getVoteStatistics(proposalId);
    if (stats.remaining <= 0) {
      this.settleVoteCycle(proposalId);
    }
  }

  // ============ 阶段三：投票结算 ============

  /**
   * 投票截止后，收集所有投票凭证，计算加权结果
   */
  settleVoteCycle(proposalId: string): {
    success: boolean;
    result?: VoteSettlementResult;
    message: string;
  } {
    const cycles = loadVoteCycles();
    const cycleIndex = cycles.findIndex(c => c.proposalId === proposalId);
    if (cycleIndex === -1) {
      return { success: false, message: '投票周期不存在' };
    }

    const cycle = cycles[cycleIndex];

    if (cycle.status === VoteCycleStatus.COMPLETED) {
      return { success: false, message: '投票已经结算' };
    }

    cycle.status = VoteCycleStatus.SETTLING;

    // 收集所有投票凭证
    const vouchers = this.getProposalVoteVouchers(proposalId);
    const players = generateSimulatedPlayers();

    // 按利益方分组统计
    const result: VoteSettlementResult = {
      gameDeveloperVotes: { approve: 0, reject: 0, abstain: 0 },
      playerCommunityVotes: { approve: 0, reject: 0, abstain: 0 },
      platformVotes: { approve: 0, reject: 0, abstain: 0 },
      weightedApproveScore: 0,
      weightedRejectScore: 0,
      totalEligibleVoters: vouchers.length,
      totalVoted: 0,
      participationRate: 0,
      finalStatus: ProposalStatus.ACTIVE, // 暂时
      calculatedAt: Date.now(),
    };

    for (const voucher of vouchers) {
      const info = extractVoteInfo(voucher);
      if (!info || info.settlementStatus === VoteSettlementStatus.PENDING) continue;

      result.totalVoted++;

      // 分组计数
      const group =
        info.voterType === VoteStakeholderType.GAME_DEVELOPER
          ? 'gameDeveloperVotes'
          : info.voterType === VoteStakeholderType.PLAYER_COMMUNITY
            ? 'playerCommunityVotes'
            : 'platformVotes';

      if (info.decision === 'approve') result[group].approve++;
      else if (info.decision === 'reject') result[group].reject++;
      else result[group].abstain++;

      // 更新凭证结算状态
      info.settlementStatus = VoteSettlementStatus.SETTLED;
      info.settledAt = Date.now();

      if (!voucher.metadata?.customData) {
        if (!voucher.metadata) voucher.metadata = { name: '', description: '', category: '', tags: [], sourceType: VoucherSourceType.VOTE, customData: {} };
        else voucher.metadata.customData = {};
      }
      voucher.metadata.customData!.voteInfo = info;

      // 刷新凭证名称和描述，反映已结算状态和最终结果
      const gameName = info.gameName || '';
      const decisionLabel = info.decision === 'approve' ? '赞成' : info.decision === 'reject' ? '反对' : '弃权';
      const passed = result.finalStatus === ProposalStatus.PASSED;
      voucher.metadata.name = `🗳️ [已结算] ${gameName} - ${info.proposalTitle}`;
      voucher.metadata.description = [
        voucher.metadata.description || `投票凭证：${info.proposalTitle}`,
        `✅ 已投票：${decisionLabel} · 提案${passed ? '已通过 ✓' : '被拒绝 ✗'}`,
      ].join('\n');

      // 更新凭证状态
      voucher.status = VoucherStatus.EXPIRED; // 投票凭证在结算后过期

      const voucherDB = (this.vs as any).db;
      if (voucherDB && typeof voucherDB.updateVoucher === 'function') {
        voucherDB.updateVoucher(voucher);
      }
    }

    // 计算参与率
    result.participationRate = result.totalEligibleVoters > 0
      ? result.totalVoted / result.totalEligibleVoters
      : 0;

    // 计算三方加权得分
    const weights = cycle.thresholdSnapshot.weights;

    // 游戏方得分
    const devTotal = players.filter(p => p.type === VoteStakeholderType.GAME_DEVELOPER).length;
    if (devTotal > 0) {
      const devApproveRate = result.gameDeveloperVotes.approve / devTotal;
      const devRejectRate = result.gameDeveloperVotes.reject / devTotal;
      result.weightedApproveScore += devApproveRate * weights.gameDeveloper;
      result.weightedRejectScore += devRejectRate * weights.gameDeveloper;
    }

    // 玩家社区得分（加权）
    const playerVouchers = vouchers.filter(v => {
      const i = extractVoteInfo(v);
      return i?.voterType === VoteStakeholderType.PLAYER_COMMUNITY;
    });

    let playerTotalWeight = 0;
    for (const v of playerVouchers) {
      const i = extractVoteInfo(v);
      if (i && i.settlementStatus !== VoteSettlementStatus.PENDING) {
        if (i.decision === 'approve') result.weightedApproveScore += (v.denomination / playerVouchers.length) * weights.playerCommunity;
        if (i.decision === 'reject') result.weightedRejectScore += (v.denomination / playerVouchers.length) * weights.playerCommunity;
      }
      playerTotalWeight += v.denomination;
    }

    // 平台方得分
    const platformTotal = players.filter(p => p.type === VoteStakeholderType.PLATFORM).length;
    if (platformTotal > 0) {
      const platformApproveRate = result.platformVotes.approve / platformTotal;
      const platformRejectRate = result.platformVotes.reject / platformTotal;
      result.weightedApproveScore += platformApproveRate * weights.platform;
      result.weightedRejectScore += platformRejectRate * weights.platform;
    }

    // 判断最终结果
    if (result.participationRate < cycle.thresholdSnapshot.quorumRate) {
      result.finalStatus = ProposalStatus.REJECTED;
    } else if (result.weightedApproveScore >= cycle.thresholdSnapshot.passThreshold) {
      result.finalStatus = ProposalStatus.PASSED;
      result.passedAt = Date.now();
    } else {
      result.finalStatus = ProposalStatus.REJECTED;
    }

    cycle.result = result;
    cycle.status = VoteCycleStatus.COMPLETED;
    cycle.completedAt = Date.now();
    saveVoteCycles(cycles);

    // 广播结算完成事件
    window.dispatchEvent(new CustomEvent('vote-cycle-settled', {
      detail: { cycle, result, proposalId },
    }));

    console.log(`[VoteVoucher] 📊 投票结算完成: ${cycle.proposalTitle} → ${result.finalStatus} (赞成:${Math.round(result.weightedApproveScore * 100)}%)`);

    return {
      success: true,
      result,
      message: result.finalStatus === ProposalStatus.PASSED ? '提案已通过' : '提案被拒绝',
    };
  }
}

// ==================== 单例导出 ====================

export const voteVoucherService = new VoteVoucherService();
export default voteVoucherService;
