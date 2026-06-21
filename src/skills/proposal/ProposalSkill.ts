/**
 * ProposalSkill - 治理提案 Skill（MVP v1.0）
 * 
 * 管理 DAO 治理提案生命周期：创建 → 投票 → 执行 → 结算。
 * 数据持久化到 CloudBase: proposals
 */

import { BaseSkill } from '../BaseSkill';
import type { SkillContext } from '../types';
import { getCloudBaseApp } from '../../services/cloudbase';
import { writeQueue } from '../../services/writeQueue';

// ==================== 类型 ====================

export type ProposalType = 'new_item' | 'mint_item' | 'edit_item' | 'parameter_change';
export type ProposalStatus = 'draft' | 'active' | 'passed' | 'rejected' | 'executed';
export type VoteDecision = 'approve' | 'reject' | 'abstain';

export interface VoteRecord {
  userId: string;
  decision: VoteDecision;
  weight: number;
  timestamp: number;
}

export interface Proposal {
  id: string;
  gameId: string;
  title: string;
  description: string;
  proposalType: ProposalType;
  status: ProposalStatus;
  payload: Record<string, any>;
  proposerId: string;
  votes: VoteRecord[];
  result?: ProposalResult;
  votingEndAt: number;
  createdAt: number;
  updatedAt: number;
}

export interface ProposalResult {
  approveCount: number;
  rejectCount: number;
  abstainCount: number;
  approveWeight: number;
  rejectWeight: number;
  abstainWeight: number;
  passed: boolean;
  finalizedAt: number;
}

// ==================== Skill ====================

export class ProposalSkill extends BaseSkill {
  private readonly VOTING_DURATION = 7 * 24 * 60 * 60 * 1000; // 7 days

  constructor() {
    super({
      name: 'proposal',
      version: '1.0.0',
      displayName: '治理提案',
      description: 'DAO 治理：提案创建/投票/执行/结算',
      dependencies: ['voucher'],
    requiredPermissions: [], actions: [] });
  }

  protected async onInitialize(): Promise<void> {
    this.registerAction('createProposal', this.createProposal.bind(this), {
      description: '创建治理提案',
      params: { type: 'object', required: ['gameId', 'title', 'proposalType'], properties: {} },
    });

    this.registerAction('vote', this.vote.bind(this), {
      description: '对提案投票',
      params: { type: 'object', required: ['proposalId', 'decision'], properties: { proposalId: { type: 'string' }, decision: { type: 'string', enum: ['approve', 'reject', 'abstain'] } } },
    });

    this.registerAction('getProposals', this.getProposals.bind(this), {
      description: '获取提案列表',
      params: { type: 'object', properties: { status: { type: 'string' }, gameId: { type: 'string' } } },
    });

    this.registerAction('getProposal', this.getProposal.bind(this), {
      description: '获取单个提案详情',
      params: { type: 'object', required: ['proposalId'], properties: { proposalId: { type: 'string' } } },
    });

    this.registerAction('executeProposal', this.executeProposal.bind(this), {
      description: '执行已通过的提案',
      params: { type: 'object', required: ['proposalId'], properties: {} },
    });
  }

  // ==================== Actions ====================

  async createProposal(
    params: { gameId: string; title: string; description?: string; proposalType: ProposalType; payload?: Record<string, any>; votingDuration?: number },
    context: SkillContext
  ) {
    const proposal: Proposal = {
      id: `prop_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      gameId: params.gameId,
      title: params.title,
      description: params.description || '',
      proposalType: params.proposalType,
      status: 'active',
      payload: params.payload || {},
      proposerId: context.userId,
      votes: [],
      votingEndAt: Date.now() + (params.votingDuration || this.VOTING_DURATION),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.saveLocalProposal(proposal);
    try {
      const app = getCloudBaseApp();
      await app.database().collection('proposals').add(proposal);
    } catch { /* local only */ }
    return { success: true, data: proposal };
  }

  async vote(params: { proposalId: string; decision: VoteDecision }, context: SkillContext) {
    const proposal = this.getLocalProposal(params.proposalId);
    if (!proposal) return { success: false, error: 'Proposal not found' };
    if (proposal.status !== 'active') return { success: false, error: 'Proposal is not active' };
    if (Date.now() > proposal.votingEndAt) return { success: false, error: 'Voting has ended' };

    // 反欺诈：同一用户不可重复投票
    const existing = proposal.votes.find(v => v.userId === context.userId);
    if (existing) return { success: false, error: 'Already voted' };

    // 计算投票权重
    const weight = await this.calculateVoteWeight(context.userId);
    proposal.votes.push({ userId: context.userId, decision: params.decision, weight, timestamp: Date.now() });
    proposal.updatedAt = Date.now();
    this.saveLocalProposal(proposal);

    try {
      const app = getCloudBaseApp();
      await app.database().collection('proposals').where({ id: params.proposalId }).update({ votes: proposal.votes, updatedAt: proposal.updatedAt });
    } catch { /* best effort */ }

    return { success: true, data: { voted: true, weight } };
  }

  async getProposals(params: { status?: ProposalStatus; gameId?: string }, context: SkillContext) {
    let all = this.getLocalProposals();
    if (params.status) all = all.filter(p => p.status === params.status);
    if (params.gameId) all = all.filter(p => p.gameId === params.gameId);

    // 自动结算已到期的提案
    const now = Date.now();
    for (const p of all) {
      if (p.status === 'active' && now > p.votingEndAt) {
        this.finalizeProposal(p);
      }
    }

    return { success: true, data: all };
  }

  async getProposal(params: { proposalId: string }, context: SkillContext) {
    const proposal = this.getLocalProposal(params.proposalId);
    if (!proposal) return { success: false, error: 'Proposal not found' };
    if (proposal.status === 'active' && Date.now() > proposal.votingEndAt) {
      this.finalizeProposal(proposal);
    }
    return { success: true, data: proposal };
  }

  async executeProposal(params: { proposalId: string }, context: SkillContext) {
    const proposal = this.getLocalProposal(params.proposalId);
    if (!proposal) return { success: false, error: 'Proposal not found' };
    if (proposal.status !== 'passed') return { success: false, error: 'Proposal not passed' };

    proposal.status = 'executed';
    proposal.updatedAt = Date.now();
    this.saveLocalProposal(proposal);

    try {
      const app = getCloudBaseApp();
      await app.database().collection('proposals').where({ id: params.proposalId }).update({ status: 'executed', updatedAt: proposal.updatedAt });
    } catch { /* best effort */ }

    return { success: true, data: proposal };
  }

  // ==================== 私有方法 ====================

  private finalizeProposal(proposal: Proposal): void {
    let approveWeight = 0, rejectWeight = 0, abstainWeight = 0;
    for (const v of proposal.votes) {
      if (v.decision === 'approve') approveWeight += v.weight;
      else if (v.decision === 'reject') rejectWeight += v.weight;
      else abstainWeight += v.weight;
    }
    const totalWeight = approveWeight + rejectWeight + abstainWeight;
    const passed = approveWeight > rejectWeight && totalWeight > 0 && approveWeight > totalWeight * 0.5;
    proposal.result = {
      approveCount: proposal.votes.filter(v => v.decision === 'approve').length,
      rejectCount: proposal.votes.filter(v => v.decision === 'reject').length,
      abstainCount: proposal.votes.filter(v => v.decision === 'abstain').length,
      approveWeight,
      rejectWeight,
      abstainWeight,
      passed,
      finalizedAt: Date.now(),
    };
    proposal.status = passed ? 'passed' : 'rejected';
    proposal.updatedAt = Date.now();
    this.saveLocalProposal(proposal);
  }

  private async calculateVoteWeight(userId: string): Promise<number> {
    // 权重 = A币(凭证) * 0.3 + gameCoins * 0.1（上限 1000）
    try {
      const result = await this.gateway.execute('wallet', 'getBalance', {}, { userId } as any);
      if (result.success) {
        const bal = result.data;
        // A币从凭证系统读取
        let aCoinBalance = 0;
        try {
          const { voucherPaymentService } = await import('@/services/voucherPaymentService');
          aCoinBalance = voucherPaymentService.getUserVoucherBalance(userId);
        } catch { /* fallback */ }
        return Math.min(aCoinBalance * 0.3 + (bal.gameCoins || 0) * 0.1, 1000) || 1;
      }
    } catch { /* fallback */ }
    return 1;
  }

  private getLocalProposals(): Proposal[] {
    try { return JSON.parse(localStorage.getItem('proposals') || '[]'); } catch { return []; }
  }
  private getLocalProposal(id: string): Proposal | null {
    return this.getLocalProposals().find(p => p.id === id) || null;
  }
  private saveLocalProposal(p: Proposal): void {
    const all = this.getLocalProposals().filter(x => x.id !== p.id);
    all.push(p);
    localStorage.setItem('proposals', JSON.stringify(all));
    // CloudBase 双写（通过写入队列）
    writeQueue.enqueue({
      collection: 'proposals',
      operation: 'upsert',
      data: p as any,
    });
  }
}

export const proposalSkill = new ProposalSkill();
