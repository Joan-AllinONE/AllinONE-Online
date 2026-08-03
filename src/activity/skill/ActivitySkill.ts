import {
  Skill,
  SkillDefinition,
  SkillGatewayInterface,
  SkillRequest,
  SkillResponse,
  ActionDefinition,
} from '../../skills/types';
import { createError } from '../../skills/errors';
import { ActivityDef, ProgressRecord, RewardDef } from '../types';
import * as activityService from '../service/activityService';
import { dayIndex, checkinRewardForDay } from '../engine/checkinEngine';
import { drawPrize } from '../engine/lotteryEngine';

export interface ActivitySkillOptions {
  gateway: SkillGatewayInterface;
  getUserId: () => string | null;
  getUserName?: () => string | undefined;
}

const ACTIONS: ActionDefinition[] = [
  mkAction('getActivities', true),
  mkAction('getProgress', false),
  mkAction('claim', false),
  mkAction('checkin', false),
  mkAction('drawLottery', false),
  mkAction('getLeaderboard', true),
];

function mkAction(name: string, readonly: boolean): ActionDefinition {
  return {
    name,
    displayName: name,
    description: name,
    paramsSchema: { type: 'object' },
    returnsSchema: { type: 'object' },
    requiredPermissions: [],
    readonly,
    idempotent: false,
  };
}

/**
 * 活动中心 Skill：封装活动读取、进度查询、领奖、签到、抽奖。
 * 奖励统一通过 SkillGateway 委托 wallet 发放游戏币，复用平台经济系统。
 */
export class ActivitySkill implements Skill {
  definition: SkillDefinition = {
    name: 'activity',
    displayName: '活动中心',
    version: '1.0.0',
    description: '活动中心：签到、任务、抽奖、邀请等留存与运营活动',
    requiredPermissions: [],
    actions: ACTIONS,
  };

  private gateway!: SkillGatewayInterface;
  private getUserId: () => string | null;
  private getUserName?: () => string | undefined;

  constructor(opts: ActivitySkillOptions) {
    this.gateway = opts.gateway;
    this.getUserId = opts.getUserId;
    this.getUserName = opts.getUserName;
  }

  async initialize(gateway: SkillGatewayInterface): Promise<void> {
    this.gateway = gateway;
  }

  supportsAction(action: string): boolean {
    return ACTIONS.some((a) => a.name === action);
  }

  getActionDefinition(action: string): ActionDefinition | undefined {
    return ACTIONS.find((a) => a.name === action);
  }

  async execute(request: SkillRequest): Promise<SkillResponse> {
    const { action, params, context } = request;
    const userId = context.userId || this.getUserId();
    try {
      if (!userId && action !== 'getActivities' && action !== 'getLeaderboard') {
        throw new Error('未登录，无法操作活动');
      }
      let data: any;
      switch (action) {
        case 'getActivities':
          data = await this.getActivities();
          break;
        case 'getProgress':
          data = await this.getProgress(userId as string);
          break;
        case 'claim':
          data = await this.claim(params.activityId, userId as string);
          break;
        case 'checkin':
          data = await this.checkin(params.activityId, userId as string);
          break;
        case 'drawLottery':
          data = await this.drawLottery(params.activityId, userId as string);
          break;
        case 'getLeaderboard':
          data = await activityService.fetchLeaderboard();
          break;
        default:
          return this.fail(request, `未知动作 ${action}`);
      }
      return { success: true, data, requestId: request.requestId, timestamp: Date.now() };
    } catch (e: any) {
      return {
        success: false,
        error: createError('4000', e?.message || '活动操作失败'),
        requestId: request.requestId,
        timestamp: Date.now(),
      };
    }
  }

  private fail(request: SkillRequest, message: string): SkillResponse {
    return {
      success: false,
      error: createError('4002', message),
      requestId: request.requestId,
      timestamp: Date.now(),
    };
  }

  private async getActivities(): Promise<ActivityDef[]> {
    return activityService.fetchActivities();
  }

  private buildProgress(
    stored: ProgressRecord[],
    activity: ActivityDef,
    userId: string
  ): ProgressRecord {
    const found = stored.find((p) => p.activityId === activity.id);
    if (found) return found;
    return {
      userId,
      activityId: activity.id,
      status: activity.status === 'active' ? 'available' : 'locked',
      current: 0,
      target: activity.conditions?.target ?? 1,
      streak: 0,
      lastCheckInDay: 0,
      makeupUsed: 0,
      history: [],
      updatedAt: Date.now(),
    };
  }

  async getProgress(userId: string): Promise<ProgressRecord[]> {
    const activities = await activityService.fetchActivities();
    const stored = activityService.loadProgress(userId);
    return activities.map((a) => this.buildProgress(stored, a, userId));
  }

  /** 领取任务/邀请奖励（游戏币） */
  private async claim(activityId: string, userId: string) {
    const activities = await activityService.fetchActivities();
    const activity = activities.find((a) => a.id === activityId);
    if (!activity) throw new Error('活动不存在');
    const progressList = await this.getProgress(userId);
    const progress = progressList.find((p) => p.activityId === activityId);
    if (!progress) throw new Error('进度不存在');
    if (progress.status !== 'completed') throw new Error('任务尚未完成');

    const rewards: RewardDef[] =
      activity.rewards && activity.rewards.length > 0
        ? activity.rewards
        : activity.invite
          ? [activity.invite.rewardPerInvitee]
          : [];

    const total = await this.dispatchRewards(rewards, userId, activity.type);

    progress.status = 'claimed';
    progress.lastClaimedAt = Date.now();
    progress.history.push({ at: Date.now(), rewards });
    activityService.saveProgress(userId, progressList);

    await activityService.recordClaim({
      id: `${activityId}_${userId}_${Date.now()}`,
      activityId,
      userId,
      userName: this.getUserName?.(),
      amount: total,
      at: Date.now(),
    });

    return { success: true, progress, rewards, total };
  }

  /** 每日签到 */
  private async checkin(activityId: string, userId: string) {
    const activities = await activityService.fetchActivities();
    const activity = activities.find((a) => a.id === activityId);
    if (!activity || activity.type !== 'daily_checkin') throw new Error('非签到活动');
    const progressList = await this.getProgress(userId);
    const progress = progressList.find((p) => p.activityId === activityId);
    if (!progress) throw new Error('进度不存在');

    const today = dayIndex();
    if (progress.lastCheckInDay === today) throw new Error('今日已签到');

    const streak = progress.lastCheckInDay === today - 1 ? progress.streak + 1 : 1;
    const reward = checkinRewardForDay(activity, streak);

    await this.dispatchRewards([reward], userId, 'daily_checkin');

    progress.streak = streak;
    progress.lastCheckInDay = today;
    progress.current = Math.min(progress.current + 1, 7);
    progress.status = 'available';
    progress.history.push({ at: Date.now(), rewards: [reward] });
    activityService.saveProgress(userId, progressList);

    return { success: true, progress, reward };
  }

  /** 幸运抽奖（消耗游戏币） */
  private async drawLottery(activityId: string, userId: string) {
    const activities = await activityService.fetchActivities();
    const activity = activities.find((a) => a.id === activityId);
    if (!activity || activity.type !== 'lottery' || !activity.lottery)
      throw new Error('非抽奖活动');
    const cost = activity.lottery.cost;

    // 必须先校验扣费结果：余额不足时 WalletSkill 会抛错，网关将其转换为
    // { success: false } 返回（不会抛出），若不检查会错误地继续抽奖并发奖（白嫖）。
    const spendRes = await this.gateway.execute(
      'wallet',
      'spend',
      { amount: cost, description: '抽奖消耗' },
      { userId, sessionId: 'activity' }
    );
    if (!spendRes.success) {
      throw new Error(spendRes.error?.message || '游戏币不足，抽奖失败');
    }

    const prize = drawPrize(activity.lottery);
    const total = await this.dispatchRewards([prize.reward], userId, 'lottery');

    const progressList = await this.getProgress(userId);
    const progress = progressList.find((p) => p.activityId === activityId);
    if (progress) {
      progress.current += 1;
      progress.history.push({ at: Date.now(), rewards: [prize.reward] });
      activityService.saveProgress(userId, progressList);
    }

    return { success: true, prize, total };
  }

  /** 统一发放奖励（当前仅游戏币） */
  private async dispatchRewards(rewards: RewardDef[], userId: string, activityType?: string): Promise<number> {
    let total = 0;
    // 活动类型 → 描述前缀映射
    const typeLabel: Record<string, string> = {
      daily_checkin: '每日签到',
      onboarding: '新手任务',
      growth: '成长任务',
      limited_event: '限时活动',
      achievement: '成就解锁',
      lottery: '幸运抽奖',
      invite: '邀请奖励',
    };
    for (const r of rewards) {
      if (r.kind === 'gameCoins' && r.amount > 0) {
        try {
          const prefix = typeLabel[activityType || ''] || '活动奖励';
          const desc = r.label || `${prefix} +${r.amount}游戏币`;
          await this.gateway.execute(
            'wallet',
            'recharge',
            { amount: r.amount, description: desc },
            { userId, sessionId: 'activity' }
          );
          total += r.amount;
        } catch (e) {
          console.warn('[ActivitySkill] 发放奖励失败', r, e);
        }
      }
    }
    // 触发钱包 UI 刷新
    try {
      window.dispatchEvent(new CustomEvent('wallet-updated', { detail: { userId } }));
    } catch {
      /* ignore */
    }
    return total;
  }
}
