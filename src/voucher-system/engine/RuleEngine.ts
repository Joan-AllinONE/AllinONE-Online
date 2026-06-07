/**
 * 凭证规则执行引擎
 * 负责监听平台事件并根据规则自动执行凭证分发/回收
 */

import { voucherService } from '../services/VoucherService';
import {
  Voucher,
  VoucherRules,
  DistributionRule,
  RecycleRule,
  DistributionType,
  RecycleType,
  VoucherStatus,
  TransactionType,
} from '../types';
import { EventBus, VoucherEventType, VoucherEventPayload } from './EventBus';
import { PLATFORM_CURRENCY_TEMPLATE } from '../templates';

/**
 * 规则执行上下文
 */
export interface RuleExecutionContext {
  userId: string;
  userName?: string;
  eventType: string;
  eventData?: Record<string, any>;
  timestamp: number;
}

/**
 * 规则执行结果
 */
export interface RuleExecutionResult {
  success: boolean;
  ruleId: string;
  ruleName: string;
  amount?: number;
  voucherId?: string;
  error?: string;
}

/**
 * 规则引擎配置
 */
export interface RuleEngineConfig {
  enabled: boolean;
  maxDailyExecutionsPerUser: number;
  maxDailyExecutionsGlobal: number;
  enableLogging: boolean;
}

/**
 * 凭证规则引擎
 */
export class VoucherRuleEngine {
  private static instance: VoucherRuleEngine | null = null;
  private config: RuleEngineConfig;
  private executionLog: Map<string, number[]>; // userId -> timestamps
  private globalExecutionLog: number[];
  private listenersSetup = false;

  private constructor(config: Partial<RuleEngineConfig> = {}) {
    this.config = {
      enabled: true,
      maxDailyExecutionsPerUser: 1000,
      maxDailyExecutionsGlobal: 100000,
      enableLogging: true,
      ...config,
    };
    this.executionLog = new Map();
    this.globalExecutionLog = [];
    this.setupEventListeners();
  }

  static getInstance(config?: Partial<RuleEngineConfig>): VoucherRuleEngine {
    if (!VoucherRuleEngine.instance) {
      VoucherRuleEngine.instance = new VoucherRuleEngine(config);
    } else {
      // 如果实例存在但 EventBus 被重置了，重新设置监听器
      VoucherRuleEngine.instance.ensureEventListeners();
    }
    return VoucherRuleEngine.instance;
  }

  /**
   * 确保事件监听器已设置（用于 EventBus 被重置后恢复监听）
   */
  private ensureEventListeners(): void {
    // 重置监听标志，强制重新设置监听器
    this.listenersSetup = false;
    this.setupEventListeners();
  }

  /**
   * 设置事件监听器
   */
  private setupEventListeners(): void {
    if (this.listenersSetup) {
      return; // 避免重复设置
    }

    const eventBus = EventBus.getInstance();

    // 监听游戏相关事件
    eventBus.on(VoucherEventType.GAME_COMPLETE, this.handleGameComplete.bind(this));
    eventBus.on(VoucherEventType.GAME_WIN, this.handleGameWin.bind(this));
    eventBus.on(VoucherEventType.ACHIEVEMENT_UNLOCK, this.handleAchievementUnlock.bind(this));
    eventBus.on(VoucherEventType.TASK_COMPLETE, this.handleTaskComplete.bind(this));

    // 监听用户行为事件
    eventBus.on(VoucherEventType.DAILY_CHECKIN, this.handleDailyCheckin.bind(this));
    eventBus.on(VoucherEventType.USER_REFERRAL, this.handleUserReferral.bind(this));

    // 监听交易事件（用于回收规则）
    eventBus.on(VoucherEventType.VOUCHER_TRANSFER, this.handleVoucherTransfer.bind(this));
    eventBus.on(VoucherEventType.EXCHANGE_EXECUTE, this.handleExchangeExecute.bind(this));

    // 监听调度事件
    eventBus.on(VoucherEventType.SCHEDULE_TRIGGER, this.handleScheduleTrigger.bind(this));

    this.listenersSetup = true;

    if (this.config.enableLogging) {
      console.log('[VoucherRuleEngine] 事件监听器已设置');
    }
  }

  /**
   * 执行分发规则
   */
  async executeDistributionRule(
    rule: DistributionRule,
    context: RuleExecutionContext
  ): Promise<RuleExecutionResult> {
    try {
      // 检查规则是否启用
      if (!rule.enabled) {
        return { success: false, ruleId: rule.id, ruleName: rule.name, error: '规则已禁用' };
      }

      // 检查执行限制
      if (!this.checkExecutionLimits(context.userId)) {
        return { success: false, ruleId: rule.id, ruleName: rule.name, error: '超出执行限制' };
      }

      // 判断分发模式：从奖池转移 或 创建新凭证
      const sourceMode = rule.source?.mode || 'create_new';

      if (sourceMode === 'transfer_from_pool') {
        // 从奖池转移凭证
        return await this.transferFromPool(rule, context);
      } else {
        // 创建新凭证（原有逻辑）
        return await this.createNewVoucher(rule, context);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '未知错误';
      if (this.config.enableLogging) {
        console.error(`[VoucherRuleEngine] 规则 ${rule.name} 执行失败:`, errorMessage);
      }
      return {
        success: false,
        ruleId: rule.id,
        ruleName: rule.name,
        error: errorMessage,
      };
    }
  }

  /**
   * 从奖池转移凭证给用户
   */
  private async transferFromPool(
    rule: DistributionRule,
    context: RuleExecutionContext
  ): Promise<RuleExecutionResult> {
    const poolHolderId = rule.source?.poolHolderId || 'SYSTEM';
    const poolTag = rule.source?.poolTag;

    if (this.config.enableLogging) {
      console.log(`[VoucherRuleEngine] 从奖池 ${poolHolderId} 转移凭证给 ${context.userId}`);
    }

    // 查找奖池中的可用凭证
    const poolVouchers = voucherService.getUserVouchers(poolHolderId)
      .filter(v => v.status === VoucherStatus.ACTIVE);

    // 如果有指定标签，进一步筛选
    const availableVouchers = poolTag
      ? poolVouchers.filter(v => v.metadata?.tags?.includes(poolTag) || v.metadata?.category === poolTag)
      : poolVouchers;

    if (availableVouchers.length === 0) {
      return { success: false, ruleId: rule.id, ruleName: rule.name, error: '奖池中没有可用凭证' };
    }

    // 计算需要转移的金额
    const targetAmount = this.calculateAllocation(rule, context);

    // 贪心算法：尽可用用多张凭证凑出精确金额，避免整张大额凭证一次性转出
    const sortedVouchers = [...availableVouchers].sort((a, b) => b.denomination - a.denomination);
    const selectedIds: string[] = [];
    let remaining = targetAmount;

    for (const v of sortedVouchers) {
      if (remaining <= 0) break;
      if (v.denomination <= remaining) {
        selectedIds.push(v.id);
        remaining -= v.denomination;
      }
    }

    let voucherToTransfer;
    if (remaining === 0) {
      // 精确匹配成功：转移凑出的所有凭证
      for (const vid of selectedIds) {
        voucherService.transferVoucher(
          { voucherId: vid, toUserId: context.userId, toUserName: context.userName || context.userId, note: `${rule.name} - ${context.eventType}` },
          poolHolderId,
          '凭证规则引擎'
        );
      }
      voucherToTransfer = voucherService.getVoucherById(selectedIds[selectedIds.length - 1]);
    } else {
      // 精确匹配失败：找一张 >= 剩余金额的凭证
      voucherToTransfer = sortedVouchers.find(v => v.denomination >= remaining && !selectedIds.includes(v))
        || availableVouchers[0];
      voucherService.transferVoucher(
        { voucherId: voucherToTransfer.id, toUserId: context.userId, toUserName: context.userName || context.userId, note: `${rule.name} - ${context.eventType}` },
        poolHolderId,
        '凭证规则引擎'
      );
    }

    // 记录执行
    this.logExecution(context.userId);

    if (this.config.enableLogging) {
      console.log(`[VoucherRuleEngine] 成功转移凭证 ${voucherToTransfer.serialNumber} (${voucherToTransfer.denomination} A币) 给 ${context.userId}`);
    }

    return {
      success: true,
      ruleId: rule.id,
      ruleName: rule.name,
      amount: voucherToTransfer.denomination,
      voucherId: voucherToTransfer.id,
    };
  }

  /**
   * 创建新凭证（原有逻辑）
   */
  private async createNewVoucher(
    rule: DistributionRule,
    context: RuleExecutionContext
  ): Promise<RuleExecutionResult> {
    // 计算分配金额
    const amount = this.calculateAllocation(rule, context);
    if (amount <= 0) {
      return { success: false, ruleId: rule.id, ruleName: rule.name, error: '分配金额无效' };
    }

    // 创建凭证
    const voucher = voucherService.createVoucher(
      {
        denomination: amount,
        recipientId: context.userId,
        recipientName: context.userName || context.userId,
        metadata: {
          name: `规则奖励: ${rule.name}`,
          description: `通过规则 ${rule.name} 获得`,
          category: 'rule_reward',
          customData: {
            ruleId: rule.id,
            ruleType: rule.type,
            eventType: context.eventType,
            eventData: context.eventData,
          },
        },
        note: `${rule.name} - ${context.eventType}`,
      },
      'SYSTEM',
      '凭证规则引擎'
    );

    // 记录执行
    this.logExecution(context.userId);

    if (this.config.enableLogging) {
      console.log(`[VoucherRuleEngine] 规则 ${rule.name} 执行成功，创建新凭证 ${voucher.denomination} A币`);
    }

    return {
      success: true,
      ruleId: rule.id,
      ruleName: rule.name,
      amount,
      voucherId: voucher.id,
    };
  }

  /**
   * 执行回收规则
   */
  async executeRecycleRule(
    rule: RecycleRule,
    context: RuleExecutionContext,
    voucherId?: string
  ): Promise<RuleExecutionResult> {
    try {
      if (!rule.enabled) {
        return { success: false, ruleId: rule.id, ruleName: rule.name, error: '规则已禁用' };
      }

      // 获取用户凭证
      const userVouchers = voucherService.getUserVouchers(context.userId);
      const activeVouchers = userVouchers.filter(v => v.status === VoucherStatus.ACTIVE);

      if (activeVouchers.length === 0) {
        return { success: false, ruleId: rule.id, ruleName: rule.name, error: '没有可回收的凭证' };
      }

      let totalRecycled = 0;

      for (const voucher of activeVouchers) {
        // 计算回收金额
        const recycleAmount = this.calculateRecycleAmount(rule, voucher.denomination, context);
        if (recycleAmount <= 0) continue;

        // 执行回收（销毁或转移）
        switch (rule.recycleLogic.destination) {
          case 'burn':
            voucherService.destroyVoucher(
              voucher.id,
              'SYSTEM',
              '凭证规则引擎',
              `${rule.name} - 自动销毁`
            );
            break;
          case 'treasury':
            // 转移到平台金库账户（system-platform）
            voucherService.transferVoucher(
              {
                voucherId: voucher.id,
                toUserId: 'system-platform',
                toUserName: '平台金库',
                note: `${rule.name} - 回收至金库`,
              },
              context.userId,
              context.userName || context.userId
            );
            break;
          case 'platform':
            // 平台收取手续费 → 转入金库账户
            voucherService.transferVoucher(
              {
                voucherId: voucher.id,
                toUserId: 'system-platform',
                toUserName: '平台金库',
                note: `${rule.name} - 平台手续费`,
              },
              context.userId,
              context.userName || context.userId
            );
            break;
        }

        totalRecycled += recycleAmount;
      }

      return {
        success: true,
        ruleId: rule.id,
        ruleName: rule.name,
        amount: totalRecycled,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '未知错误';
      return {
        success: false,
        ruleId: rule.id,
        ruleName: rule.name,
        error: errorMessage,
      };
    }
  }

  /**
   * 计算分配金额
   */
  private calculateAllocation(rule: DistributionRule, context: RuleExecutionContext): number {
    const { mode } = rule.allocation;

    switch (mode) {
      case 'fixed':
        return rule.allocation.fixedAmount || 0;

      case 'ratio':
        // 按比例分配（需要上下文中有基数）
        const baseAmount = context.eventData?.baseAmount || 0;
        return Math.floor(baseAmount * (rule.allocation.ratio || 0));

      case 'tiered':
        // 分档金额
        const threshold = context.eventData?.threshold || 0;
        const tier = rule.allocation.tieredAmounts?.find(
          t => threshold >= t.minThreshold && threshold <= t.maxThreshold
        );
        return tier?.amount || 0;

      case 'formula':
        // 公式计算（简化实现）
        return this.evaluateFormula(rule.allocation.formula || '0', context);

      default:
        return 0;
    }
  }

  /**
   * 计算回收金额
   */
  private calculateRecycleAmount(
    rule: RecycleRule,
    voucherAmount: number,
    context: RuleExecutionContext
  ): number {
    const { mode } = rule.recycleLogic;

    switch (mode) {
      case 'fixed':
        return Math.min(rule.recycleLogic.fixedAmount || 0, voucherAmount);

      case 'percentage':
        return Math.floor(voucherAmount * ((rule.recycleLogic.percentage || 0) / 100));

      case 'sliding':
        const scale = rule.recycleLogic.slidingScale;
        if (scale) {
          const rate = voucherAmount >= scale.threshold ? scale.aboveRate : scale.belowRate;
          return Math.floor(voucherAmount * (rate / 100));
        }
        return 0;

      case 'formula':
        return this.evaluateFormula(rule.recycleLogic.formula || '0', context);

      default:
        return 0;
    }
  }

  /**
   * 评估公式（简化版）
   */
  private evaluateFormula(formula: string, context: RuleExecutionContext): number {
    try {
      // 难度值映射（字符串转数字）
      const difficultyMap: Record<string, number> = {
        'easy': 1,
        'normal': 2,
        'hard': 3,
        'expert': 4,
        'master': 5,
      };
      const difficultyVal = context.eventData?.difficulty;
      const difficultyNum = typeof difficultyVal === 'string' 
        ? (difficultyMap[difficultyVal] || 2)
        : (difficultyVal || 1);

      // 替换上下文变量
      let evalFormula = formula
        .replace(/baseReward/g, String(context.eventData?.baseReward || 100))
        .replace(/difficulty/g, String(difficultyNum))
        .replace(/bonusMultiplier/g, String(context.eventData?.bonusMultiplier || 0))
        .replace(/level/g, String(context.eventData?.level || 1))
        .replace(/score/g, String(context.eventData?.score || 0))
        .replace(/duration/g, String(context.eventData?.duration || 0))
        .replace(/random\((\d+),\s*(\d+)\)/g, (_, min, max) =>
          String(Math.floor(Math.random() * (parseInt(max) - parseInt(min) + 1)) + parseInt(min))
        );

      if (this.config.enableLogging) {
        console.log('[VoucherRuleEngine] 公式计算:', { original: formula, evaluated: evalFormula });
      }

      // 安全计算（使用 mathjs 沙箱解析，无代码执行风险）
      const { evaluate } = require('mathjs');
      const result = evaluate(evalFormula);
      const finalResult = Math.floor(result);
      
      if (this.config.enableLogging) {
        console.log('[VoucherRuleEngine] 公式结果:', finalResult);
      }
      
      return finalResult > 0 ? finalResult : 0;
    } catch (error) {
      if (this.config.enableLogging) {
        console.error('[VoucherRuleEngine] 公式计算错误:', error);
      }
      return 0;
    }
  }

  /**
   * 检查执行限制
   */
  private checkExecutionLimits(userId: string): boolean {
    const now = Date.now();
    const dayStart = new Date().setHours(0, 0, 0, 0);

    // 检查用户每日限制
    const userExecutions = this.executionLog.get(userId) || [];
    const userDailyExecutions = userExecutions.filter(t => t >= dayStart).length;
    if (userDailyExecutions >= this.config.maxDailyExecutionsPerUser) {
      return false;
    }

    // 检查全局限制
    const globalDailyExecutions = this.globalExecutionLog.filter(t => t >= dayStart).length;
    if (globalDailyExecutions >= this.config.maxDailyExecutionsGlobal) {
      return false;
    }

    return true;
  }

  /**
   * 记录执行
   */
  private logExecution(userId: string): void {
    const now = Date.now();

    // 记录用户执行
    if (!this.executionLog.has(userId)) {
      this.executionLog.set(userId, []);
    }
    this.executionLog.get(userId)!.push(now);

    // 记录全局执行
    this.globalExecutionLog.push(now);

    // 清理旧记录（保留7天）
    const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
    this.executionLog.forEach((logs, uid) => {
      this.executionLog.set(
        uid,
        logs.filter(t => t >= weekAgo)
      );
    });
    this.globalExecutionLog = this.globalExecutionLog.filter(t => t >= weekAgo);
  }

  // ==================== 事件处理器 ====================

  private async handleGameComplete(payload: VoucherEventPayload): Promise<void> {
    const context: RuleExecutionContext = {
      userId: payload.userId,
      userName: payload.userName,
      eventType: 'game_complete',
      eventData: payload.data,
      timestamp: Date.now(),
    };

    if (this.config.enableLogging) {
      console.log('[VoucherRuleEngine] 处理游戏完成事件:', payload.data);
    }

    // 查找并执行匹配的分发规则
    const rules = this.findMatchingDistributionRules('game_reward', context);
    
    if (this.config.enableLogging) {
      console.log(`[VoucherRuleEngine] 找到 ${rules.length} 个匹配的游戏奖励规则`);
      rules.forEach((r, i) => {
        console.log(`[VoucherRuleEngine]   [${i + 1}] ${r.name} (ID: ${r.id}, 来源: ${r.source?.mode || 'create_new'})`);
      });
    }
    
    for (const rule of rules) {
      const result = await this.executeDistributionRule(rule, context);
      if (this.config.enableLogging) {
        console.log(`[VoucherRuleEngine] 规则 ${rule.name} 执行结果:`, result);
      }
    }
  }

  private async handleGameWin(payload: VoucherEventPayload): Promise<void> {
    const context: RuleExecutionContext = {
      userId: payload.userId,
      userName: payload.userName,
      eventType: 'game_win',
      eventData: payload.data,
      timestamp: Date.now(),
    };

    const rules = this.findMatchingDistributionRules('game_reward', context);
    for (const rule of rules) {
      await this.executeDistributionRule(rule, context);
    }
  }

  private async handleAchievementUnlock(payload: VoucherEventPayload): Promise<void> {
    const context: RuleExecutionContext = {
      userId: payload.userId,
      userName: payload.userName,
      eventType: 'achievement_unlock',
      eventData: payload.data,
      timestamp: Date.now(),
    };

    const rules = this.findMatchingDistributionRules('achievement_unlock', context);
    for (const rule of rules) {
      await this.executeDistributionRule(rule, context);
    }
  }

  private async handleTaskComplete(payload: VoucherEventPayload): Promise<void> {
    const context: RuleExecutionContext = {
      userId: payload.userId,
      userName: payload.userName,
      eventType: 'task_complete',
      eventData: payload.data,
      timestamp: Date.now(),
    };

    const rules = this.findMatchingDistributionRules('task_completion', context);
    for (const rule of rules) {
      await this.executeDistributionRule(rule, context);
    }
  }

  private async handleDailyCheckin(payload: VoucherEventPayload): Promise<void> {
    const context: RuleExecutionContext = {
      userId: payload.userId,
      userName: payload.userName,
      eventType: 'daily_checkin',
      eventData: payload.data,
      timestamp: Date.now(),
    };

    if (this.config.enableLogging) {
      console.log('[VoucherRuleEngine] 处理每日签到事件:', payload.userId);
    }

    const rules = this.findMatchingDistributionRules('daily_checkin', context);
    
    if (this.config.enableLogging) {
      console.log(`[VoucherRuleEngine] 找到 ${rules.length} 个匹配的签到规则`);
    }
    
    for (const rule of rules) {
      const result = await this.executeDistributionRule(rule, context);
      if (this.config.enableLogging) {
        console.log(`[VoucherRuleEngine] 规则 ${rule.name} 执行结果:`, result);
      }
    }
  }

  private async handleUserReferral(payload: VoucherEventPayload): Promise<void> {
    const context: RuleExecutionContext = {
      userId: payload.userId,
      userName: payload.userName,
      eventType: 'user_referral',
      eventData: payload.data,
      timestamp: Date.now(),
    };

    const rules = this.findMatchingDistributionRules('referral_bonus', context);
    for (const rule of rules) {
      await this.executeDistributionRule(rule, context);
    }
  }

  private async handleVoucherTransfer(payload: VoucherEventPayload): Promise<void> {
    const context: RuleExecutionContext = {
      userId: payload.userId,
      userName: payload.userName,
      eventType: 'voucher_transfer',
      eventData: payload.data,
      timestamp: Date.now(),
    };

    // 执行交易手续费回收规则
    const rules = this.findMatchingRecycleRules('transaction_fee', context);
    for (const rule of rules) {
      await this.executeRecycleRule(rule, context, payload.data?.voucherId);
    }
  }

  private async handleExchangeExecute(payload: VoucherEventPayload): Promise<void> {
    const context: RuleExecutionContext = {
      userId: payload.userId,
      userName: payload.userName,
      eventType: 'exchange_execute',
      eventData: payload.data,
      timestamp: Date.now(),
    };

    const rules = this.findMatchingRecycleRules('exchange_conversion', context);
    for (const rule of rules) {
      await this.executeRecycleRule(rule, context);
    }
  }

  private async handleScheduleTrigger(payload: VoucherEventPayload): Promise<void> {
    const context: RuleExecutionContext = {
      userId: payload.userId,
      userName: payload.userName,
      eventType: payload.data?.scheduleType || 'schedule',
      eventData: payload.data,
      timestamp: Date.now(),
    };

    // 执行定时分发规则
    const distRules = this.findMatchingDistributionRules('daily_checkin', context);
    for (const rule of distRules) {
      await this.executeDistributionRule(rule, context);
    }

    // 执行定时回收规则
    const recycleRules = this.findMatchingRecycleRules('daily_settlement', context);
    for (const rule of recycleRules) {
      await this.executeRecycleRule(rule, context);
    }
  }

  /**
   * 查找匹配的分发规则
   * 从最新模板和存储的凭证中合并规则
   */
  private findMatchingDistributionRules(
    type: DistributionType,
    context: RuleExecutionContext
  ): DistributionRule[] {
    const rules: DistributionRule[] = [];

    // 1. 从最新模板获取规则（优先使用模板，确保使用最新配置）
    if (PLATFORM_CURRENCY_TEMPLATE?.presetRules?.distribution) {
      const templateRules = PLATFORM_CURRENCY_TEMPLATE.presetRules.distribution.filter(
        rule => rule.type === type && rule.enabled
      );
      rules.push(...templateRules);
      if (this.config.enableLogging) {
        console.log(`[VoucherRuleEngine] 从模板加载了 ${templateRules.length} 个规则`);
      }
    }

    // 2. 从存储的凭证中读取规则（作为补充）
    const allVouchers = voucherService.filterVouchers({});
    for (const voucher of allVouchers) {
      if (voucher.rules?.distribution) {
        const matchingRules = voucher.rules.distribution.filter(
          rule => rule.type === type && rule.enabled
        );
        // 只添加模板中没有的规则（按ID判断）
        for (const rule of matchingRules) {
          if (!rules.some(r => r.id === rule.id)) {
            rules.push(rule);
          }
        }
      }
    }

    // 去重并排序
    const uniqueRules = Array.from(new Map(rules.map(r => [r.id, r])).values());
    if (this.config.enableLogging) {
      console.log(`[VoucherRuleEngine] 总共找到 ${uniqueRules.length} 个规则`);
    }
    return uniqueRules.sort((a, b) => a.priority - b.priority);
  }

  /**
   * 查找匹配的回收规则
   */
  private findMatchingRecycleRules(
    type: RecycleType,
    context: RuleExecutionContext
  ): RecycleRule[] {
    const allVouchers = voucherService.filterVouchers({});
    const rules: RecycleRule[] = [];

    for (const voucher of allVouchers) {
      if (voucher.rules?.recycle) {
        const matchingRules = voucher.rules.recycle.filter(
          rule => rule.type === type && rule.enabled
        );
        rules.push(...matchingRules);
      }
    }

    const uniqueRules = Array.from(new Map(rules.map(r => [r.id, r])).values());
    return uniqueRules.sort((a, b) => a.priority - b.priority);
  }

  /**
   * 手动触发事件（用于测试或外部调用）
   */
  triggerEvent(type: VoucherEventType, payload: VoucherEventPayload): void {
    EventBus.getInstance().emit(type, payload);
  }

  /**
   * 销毁引擎实例
   */
  destroy(): void {
    // 注意：我们不销毁 EventBus，因为其他组件可能还在使用它
    // 只是标记当前引擎实例为 null，下次 getInstance 会重新初始化
    this.listenersSetup = false;
    VoucherRuleEngine.instance = null;
    if (this.config.enableLogging) {
      console.log('[VoucherRuleEngine] 引擎已销毁');
    }
  }
}

// 导出单例
export const voucherRuleEngine = VoucherRuleEngine.getInstance();
