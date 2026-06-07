/**
 * 算法凭证服务
 * 管理计算分配型凭证的创建、结算、发行等全流程
 * 适用于A币日结、分红等基于贡献度计算的凭证发放
 */

import { voucherDB } from '../storage/VoucherDatabase';
import { EventBus } from '../engine/EventBus';
import { VoucherService } from './VoucherService';
import { VoucherSourceType } from '../types';
import type { 
  Voucher, 
  VoucherStatus, 
  Transaction,
  AlgorithmVoucherInfo
} from '../types';
import type {
  AlgorithmVoucherTemplate,
  SettlementCycle,
  SettlementResult,
  UserSettlementResult,
  NetworkSnapshot,
  UserPersonalData,
  ContributionAlgorithm,
  DistributionPoolConfig,
  GamePoolSourceConfig,
  UserEstimatedReward,
  ContributionLeaderboardItem,
  SettlementHistoryQuery,
  SettlementHistoryResult,
  CreateAlgorithmTemplateRequest,
  UpdateAlgorithmTemplateRequest,
  SettlementOptions,
} from '../types/algorithm';
import {
  SettlementStatus,
  DEFAULT_CONTRIBUTION_ALGORITHM,
  DEFAULT_POOL_CONFIG,
  DEFAULT_SETTLEMENT_OPTIONS,
} from '../types/algorithm';

// Storage keys
const STORAGE_KEY = 'algorithm_voucher_system';
const TEMPLATES_KEY = `${STORAGE_KEY}:templates`;
const CYCLES_KEY = `${STORAGE_KEY}:cycles`;
const SETTLEMENT_RESULTS_KEY = `${STORAGE_KEY}:settlement_results`;
const USER_RESULTS_KEY = `${STORAGE_KEY}:user_results`;

/**
 * 生成唯一ID
 */
function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

/**
 * 生成凭证编号
 */
function generateSerialNumber(index: number): string {
  const prefix = 'AC';
  const date = new Date();
  const dateStr = date.getFullYear().toString().slice(-2) +
                  String(date.getMonth() + 1).padStart(2, '0') +
                  String(date.getDate()).padStart(2, '0');
  const randomStr = Math.random().toString(36).substring(2, 6).toUpperCase();
  const indexStr = String(index).padStart(6, '0');
  return `${prefix}-${dateStr}-${randomStr}-${indexStr}`;
}

/**
 * 数据收集器接口
 * 用于从各个系统收集全网数据
 */
export interface DataCollector {
  /** 收集全网游戏币总量 */
  collectTotalGameCoins(): Promise<number>;
  
  /** 收集全网算力总量 */
  collectTotalComputingPower(): Promise<number>;
  
  /** 收集全网交易额 */
  collectTotalTransactionVolume(startDate: string, endDate: string): Promise<number>;
  
  /** 收集平台净收入 */
  collectPlatformNetIncome(startDate: string, endDate: string): Promise<number>;
  
  /** 收集所有用户的个人数据 */
  collectAllUserData(startDate: string, endDate: string): Promise<UserPersonalData[]>;
  
  /** 收集活跃用户数 */
  collectActiveUserCount(): Promise<number>;

  // === 多奖池支持：游戏级数据收集 ===
  
  /** 收集游戏收入（用于游戏奖池计算） */
  collectGameRevenue?(gameId: string, startDate: string, endDate: string): Promise<number>;
  
  /** 收集游戏玩家数 */
  collectGamePlayerCount?(gameId: string, startDate: string, endDate: string): Promise<number>;
  
  /** 收集游戏局数 */
  collectGameSessions?(gameId: string, startDate: string, endDate: string): Promise<number>;
  
  /** 收集游戏总分数 */
  collectGameTotalScore?(gameId: string, startDate: string, endDate: string): Promise<number>;

  /** 收集游戏玩家ID列表（用于游戏奖池独立分配） */
  collectGameUserIds?(gameId: string, startDate: string, endDate: string): Promise<string[]>;
}

/**
 * 默认数据收集器实现
 * 实际使用时需要接入真实的业务系统
 */
class DefaultDataCollector implements DataCollector {
  async collectTotalGameCoins(): Promise<number> {
    // TODO: 从游戏系统获取
    return 0;
  }
  
  async collectTotalComputingPower(): Promise<number> {
    // TODO: 从算力系统获取
    return 0;
  }
  
  async collectTotalTransactionVolume(startDate: string, endDate: string): Promise<number> {
    // TODO: 从交易系统获取
    return 0;
  }
  
  async collectPlatformNetIncome(startDate: string, endDate: string): Promise<number> {
    // TODO: 从财务系统获取
    return 0;
  }
  
  async collectAllUserData(startDate: string, endDate: string): Promise<UserPersonalData[]> {
    // TODO: 从用户系统获取
    return [];
  }
  
  async collectActiveUserCount(): Promise<number> {
    // TODO: 从用户系统获取
    return 0;
  }
}

/**
 * 算法凭证服务类
 */
export class AlgorithmVoucherService {
  private static instance: AlgorithmVoucherService;
  private eventBus: EventBus;
  private voucherService: VoucherService;
  private dataCollector: DataCollector;
  private initialized: boolean = false;
  
  // 内存缓存
  private templates: Map<string, AlgorithmVoucherTemplate> = new Map();
  private cycles: Map<string, SettlementCycle> = new Map();
  
  private constructor() {
    this.eventBus = EventBus.getInstance();
    this.voucherService = new VoucherService();
    this.dataCollector = new DefaultDataCollector();
  }
  
  static getInstance(): AlgorithmVoucherService {
    if (!AlgorithmVoucherService.instance) {
      AlgorithmVoucherService.instance = new AlgorithmVoucherService();
    }
    return AlgorithmVoucherService.instance;
  }
  
  /**
   * 初始化服务
   */
  async initialize(dataCollector?: DataCollector): Promise<void> {
    if (this.initialized) return;
    
    if (dataCollector) {
      this.dataCollector = dataCollector;
    }
    
    await this.loadFromStorage();
    this.initialized = true;
    
    console.log('[AlgorithmVoucherService] 初始化完成');
  }
  
  /**
   * 设置自定义数据收集器
   */
  setDataCollector(collector: DataCollector): void {
    this.dataCollector = collector;
  }
  
  // ========== 模板管理 ==========
  
  /**
   * 创建算法凭证模板
   */
  createTemplate(
    request: CreateAlgorithmTemplateRequest,
    creatorId: string,
    creatorName: string
  ): AlgorithmVoucherTemplate {
    const now = Date.now();
    
    const template: AlgorithmVoucherTemplate = {
      id: generateUUID(),
      name: request.name,
      description: request.description,
      minDenomination: request.minDenomination ?? 0.0001,
      denominationUnit: request.denominationUnit ?? 'ACOIN',
      settlementCycle: request.settlementCycle,
      settlementTime: request.settlementTime,
      settlementDayOfWeek: request.settlementDayOfWeek,
      settlementDayOfMonth: request.settlementDayOfMonth,
      algorithm: {
        ...DEFAULT_CONTRIBUTION_ALGORITHM,
        ...request.algorithm,
      },
      poolConfig: {
        ...DEFAULT_POOL_CONFIG,
        ...request.poolConfig,
      },
      isActive: true,
      createdAt: now,
      updatedAt: now,
      createdBy: creatorId,
      createdByName: creatorName,
    };
    
    this.templates.set(template.id, template);
    this.saveToStorage();
    
    // 触发事件
    this.eventBus.emit({
      type: 'TEMPLATE_CREATED',
      templateId: template.id,
      templateName: template.name,
      timestamp: now,
    });
    
    console.log(`[AlgorithmVoucherService] 创建模板: ${template.name}`);
    return template;
  }
  
  /**
   * 更新算法凭证模板
   */
  updateTemplate(
    templateId: string,
    request: UpdateAlgorithmTemplateRequest
  ): AlgorithmVoucherTemplate | null {
    const template = this.templates.get(templateId);
    if (!template) return null;
    
    const updates: Partial<AlgorithmVoucherTemplate> = {
      updatedAt: Date.now(),
    };
    
    if (request.name !== undefined) updates.name = request.name;
    if (request.description !== undefined) updates.description = request.description;
    if (request.isActive !== undefined) updates.isActive = request.isActive;
    if (request.algorithm) {
      updates.algorithm = { ...template.algorithm, ...request.algorithm };
    }
    if (request.poolConfig) {
      updates.poolConfig = { ...template.poolConfig, ...request.poolConfig };
    }
    
    const updatedTemplate = { ...template, ...updates };
    this.templates.set(templateId, updatedTemplate);
    this.saveToStorage();
    
    this.eventBus.emit({
      type: 'TEMPLATE_UPDATED',
      templateId,
      timestamp: Date.now(),
    });
    
    return updatedTemplate;
  }
  
  /**
   * 删除算法凭证模板
   */
  deleteTemplate(templateId: string): boolean {
    const template = this.templates.get(templateId);
    if (!template) return false;
    
    // 检查是否有进行中的结算周期
    const hasActiveCycles = Array.from(this.cycles.values()).some(
      c => c.templateId === templateId && 
           c.status !== SettlementStatus.COMPLETED && 
           c.status !== SettlementStatus.FAILED
    );
    
    if (hasActiveCycles) {
      console.warn(`[AlgorithmVoucherService] 无法删除模板 ${templateId}：存在进行中的结算周期`);
      return false;
    }
    
    this.templates.delete(templateId);
    this.saveToStorage();
    
    this.eventBus.emit({
      type: 'TEMPLATE_DELETED',
      templateId,
      timestamp: Date.now(),
    });
    
    return true;
  }
  
  /**
   * 获取所有模板
   */
  getTemplates(): AlgorithmVoucherTemplate[] {
    return Array.from(this.templates.values()).sort(
      (a, b) => b.createdAt - a.createdAt
    );
  }
  
  /**
   * 获取活跃模板
   */
  getActiveTemplates(): AlgorithmVoucherTemplate[] {
    return this.getTemplates().filter(t => t.isActive);
  }
  
  /**
   * 获取单个模板
   */
  getTemplate(templateId: string): AlgorithmVoucherTemplate | null {
    return this.templates.get(templateId) || null;
  }
  
  // ========== 结算周期管理 ==========
  
  /**
   * 创建新的结算周期
   */
  createSettlementCycle(
    templateId: string,
    startDate: string,
    endDate: string
  ): SettlementCycle | null {
    const template = this.templates.get(templateId);
    if (!template) return null;
    
    // 获取该模板的最新周期序号
    const existingCycles = Array.from(this.cycles.values())
      .filter(c => c.templateId === templateId)
      .sort((a, b) => b.cycleNumber - a.cycleNumber);
    
    const nextCycleNumber = existingCycles.length > 0 
      ? existingCycles[0].cycleNumber + 1 
      : 1;
    
    const cycle: SettlementCycle = {
      id: generateUUID(),
      templateId,
      templateName: template.name,
      cycleNumber: nextCycleNumber,
      startDate,
      endDate,
      settlementDate: endDate,
      status: SettlementStatus.PENDING,
      createdAt: Date.now(),
    };
    
    this.cycles.set(cycle.id, cycle);
    this.saveToStorage();
    
    console.log(`[AlgorithmVoucherService] 创建结算周期: ${template.name} #${nextCycleNumber}`);
    return cycle;
  }
  
  /**
   * 手动触发结算
   */
  async triggerSettlement(
    templateId: string,
    cycleDate?: string,
    options: SettlementOptions = DEFAULT_SETTLEMENT_OPTIONS,
    executedBy?: string
  ): Promise<SettlementCycle> {
    const template = this.templates.get(templateId);
    if (!template) {
      throw new Error(`模板不存在: ${templateId}`);
    }
    
    // 确定结算日期范围
    const targetDate = cycleDate || this.getTodayDate();
    const { startDate, endDate } = this.calculateDateRange(template, targetDate);
    
    // 创建或获取结算周期
    let cycle = Array.from(this.cycles.values()).find(
      c => c.templateId === templateId && 
           c.startDate === startDate && 
           c.endDate === endDate
    );
    
    if (!cycle) {
      cycle = this.createSettlementCycle(templateId, startDate, endDate)!;
    }
    
    // 检查状态
    if (cycle.status === SettlementStatus.COMPLETED) {
      throw new Error('该周期已结算完成');
    }
    
    if (cycle.status === SettlementStatus.COLLECTING ||
        cycle.status === SettlementStatus.CALCULATING ||
        cycle.status === SettlementStatus.ISSUING) {
      throw new Error('该周期正在进行中');
    }
    
    // 执行结算流程
    cycle.status = SettlementStatus.COLLECTING;
    cycle.startedAt = Date.now();
    cycle.executedBy = executedBy;
    this.saveToStorage();
    
    try {
      await this.executeSettlement(cycle, template, options);
      return cycle;
    } catch (error) {
      cycle.status = SettlementStatus.FAILED;
      cycle.errorMessage = error instanceof Error ? error.message : '未知错误';
      this.saveToStorage();
      throw error;
    }
  }
  
  /**
   * 执行完整结算流程
   */
  private async executeSettlement(
    cycle: SettlementCycle,
    template: AlgorithmVoucherTemplate,
    options: SettlementOptions
  ): Promise<void> {
    console.log(`[AlgorithmVoucherService] 开始结算: ${template.name} #${cycle.cycleNumber}`);
    
    // 阶段1: 收集全网数据
    const networkData = await this.collectNetworkData(cycle, template);
    cycle.networkSnapshot = networkData;
    this.saveToStorage();
    
    // 阶段2: 计算所有用户的贡献分数
    cycle.status = SettlementStatus.CALCULATING;
    this.saveToStorage();
    
    const userDataList = await this.dataCollector.collectAllUserData(
      cycle.startDate,
      cycle.endDate
    );
    
    const userResults = this.calculateAllUserContributions(
      userDataList,
      networkData,
      template.algorithm
    );
    
    // 阶段3: 计算发放池并分配
    const distributionPool = this.calculateDistributionPool(networkData, template.poolConfig, template);
    const settlementResult = this.calculateSettlementDistribution(
      userResults,
      distributionPool,
      template,
      options
    );
    
    // 阶段3b: 游戏池独立分配（每个游戏池只分给该游戏的玩家）
    if (template.poolConfig.gamePools && template.poolConfig.gamePools.length > 0) {
      await this.distributeGamePoolsToPlayers(
        template, networkData, userResults, settlementResult, cycle, options
      );
    }
    
    cycle.result = settlementResult;
    this.saveToStorage();
    
    // 阶段4: 发行凭证
    if (options.autoIssue) {
      cycle.status = SettlementStatus.ISSUING;
      this.saveToStorage();
      
      await this.issueVouchersToUsers(settlementResult.userResults, cycle, template);
    }
    
    // 完成结算
    cycle.status = SettlementStatus.COMPLETED;
    cycle.completedAt = Date.now();
    this.saveToStorage();
    
    // 触发完成事件
    this.eventBus.emit({
      type: 'SETTLEMENT_COMPLETED',
      cycleId: cycle.id,
      templateId: template.id,
      templateName: template.name,
      cycleNumber: cycle.cycleNumber,
      totalDistributed: settlementResult.totalDistributed,
      totalParticipants: settlementResult.totalParticipants,
      timestamp: Date.now(),
    });
    
    console.log(`[AlgorithmVoucherService] 结算完成: ${template.name} #${cycle.cycleNumber}`);
  }
  
  /**
   * 收集全网数据（支持多奖池）
   */
  private async collectNetworkData(
    cycle: SettlementCycle,
    template: AlgorithmVoucherTemplate
  ): Promise<NetworkSnapshot> {
    console.log('[AlgorithmVoucherService] 收集全网数据...');
    
    const [
      totalGameCoins,
      totalComputingPower,
      totalTransactionVolume,
      platformNetIncome,
      activeUsers,
    ] = await Promise.all([
      this.dataCollector.collectTotalGameCoins(),
      this.dataCollector.collectTotalComputingPower(),
      this.dataCollector.collectTotalTransactionVolume(cycle.startDate, cycle.endDate),
      this.dataCollector.collectPlatformNetIncome(cycle.startDate, cycle.endDate),
      this.dataCollector.collectActiveUserCount(),
    ]);
    
    // 计算总贡献分数（使用分式公式，需要全网总量）
    const userDataList = await this.dataCollector.collectAllUserData(
      cycle.startDate,
      cycle.endDate
    );
    
    let totalContributionScore = 0;
    for (const userData of userDataList) {
      const score = this.calculateContributionScore(
        userData, template.algorithm,
        totalGameCoins, totalComputingPower, totalTransactionVolume
      );
      totalContributionScore += score;
    }
    
    // 计算平台发放池（游戏池单独存储，不合并到总池）
    let distributionPool: number;
    let totalSupply: number | undefined;
    let totalValue: number | undefined;
    const gamePoolDetails: { gameId: string; gameName: string; amount: number; calculationDetail: string }[] = [];
    
    if (template.poolConfig.calculationMode === 'fixed' && template.poolConfig.fixedTotalSupply) {
      // 固定总量模式（平台池）
      totalSupply = template.poolConfig.fixedTotalSupply;
      totalValue = totalSupply * template.minDenomination;
      distributionPool = totalValue;
    } else if (template.totalSupply && template.totalValue) {
      // 模板设置了总量上限
      totalSupply = template.totalSupply;
      totalValue = template.totalValue;
      const calculatedPool = platformNetIncome * template.poolConfig.ratio;
      distributionPool = Math.min(calculatedPool, totalValue);
    } else {
      // 自动计算模式（平台池）
      distributionPool = platformNetIncome * template.poolConfig.ratio;
      totalSupply = Math.floor(distributionPool / template.minDenomination);
      totalValue = totalSupply * template.minDenomination;
    }
    
    // 计算各游戏奖池（仅记录，不合并到总池）
    if (template.poolConfig.gamePools && template.poolConfig.gamePools.length > 0) {
      for (const gamePool of template.poolConfig.gamePools) {
        try {
          const poolAmount = await this.calculateGamePoolAmount(gamePool, cycle);
          gamePoolDetails.push({
            gameId: gamePool.gameId,
            gameName: gamePool.gameName,
            amount: poolAmount,
            calculationDetail: this.getGamePoolCalculationDetail(gamePool, poolAmount),
          });
        } catch (error) {
          console.error(`[AlgorithmVoucherService] 计算游戏奖池 ${gamePool.gameName} 失败:`, error);
          gamePoolDetails.push({
            gameId: gamePool.gameId,
            gameName: gamePool.gameName,
            amount: 0,
            calculationDetail: '计算失败',
          });
        }
      }
    }
    
    return {
      timestamp: Date.now(),
      totalGameCoins,
      totalComputingPower,
      totalTransactionVolume,
      totalContributionScore,
      totalActiveUsers: activeUsers,
      platformNetIncome,
      distributionPool,
      carriedOverAmount: 0,
      totalSupply,
      totalValue,
      minContributionScore: 0,
      maxContributionScore: 0,
      avgContributionScore: totalContributionScore / (userDataList.length || 1),
      gamePoolDetails,
    };
  }

  /**
   * 计算单个游戏奖池金额（参考即时型凭证的分配逻辑）
   */
  private async calculateGamePoolAmount(
    gamePool: GamePoolSourceConfig,
    cycle: SettlementCycle
  ): Promise<number> {
    // 固定总量模式
    if (gamePool.calculationMode === 'fixed' && gamePool.fixedTotalSupply) {
      // 参考 DistributionRule.allocation.mode = 'fixed'
      return gamePool.fixedTotalSupply;
    }
    
    // 自动计算模式
    let baseAmount = 0;
    
    switch (gamePool.allocation.mode) {
      case 'fixed':
        // 固定金额（类似 DistributionRule.allocation.fixedAmount）
        baseAmount = gamePool.allocation.fixedAmount || 0;
        break;
        
      case 'ratio':
        // 按游戏收入比例（类似 DistributionRule.allocation.ratio）
        const gameRevenue = await this.dataCollector.collectGameRevenue?.(gamePool.gameId, cycle.startDate, cycle.endDate) || 0;
        baseAmount = gameRevenue * (gamePool.allocation.ratio || 0);
        break;
        
      case 'formula':
        // 自定义公式（类似 DistributionRule.allocation.formula）
        const metrics = await this.collectGameMetrics(gamePool, cycle);
        baseAmount = this.evaluateGamePoolFormula(gamePool.allocation.formula || '0', metrics);
        break;
    }
    
    return Math.max(0, baseAmount);
  }

  /**
   * 收集游戏计量要素数据
   */
  private async collectGameMetrics(
    gamePool: GamePoolSourceConfig,
    cycle: SettlementCycle
  ): Promise<Record<string, number>> {
    const metrics: Record<string, number> = {};
    const m = gamePool.metrics;
    
    if (m?.gameRevenue) {
      metrics.gameRevenue = await this.dataCollector.collectGameRevenue?.(gamePool.gameId, cycle.startDate, cycle.endDate) || 0;
    }
    if (m?.playerCount) {
      metrics.playerCount = await this.dataCollector.collectGamePlayerCount?.(gamePool.gameId, cycle.startDate, cycle.endDate) || 0;
    }
    if (m?.gameSessions) {
      metrics.gameSessions = await this.dataCollector.collectGameSessions?.(gamePool.gameId, cycle.startDate, cycle.endDate) || 0;
    }
    if (m?.totalScore) {
      metrics.totalScore = await this.dataCollector.collectGameTotalScore?.(gamePool.gameId, cycle.startDate, cycle.endDate) || 0;
    }
    if (m?.averageScore && m.totalScore && m.playerCount) {
      metrics.averageScore = (metrics.totalScore || 0) / Math.max(1, metrics.playerCount || 1);
    }
    
    return metrics;
  }

  /**
   * 计算公式结果（使用 mathjs 沙箱解析，无代码执行风险）
   */
  private evaluateGamePoolFormula(formula: string, metrics: Record<string, number>): number {
    try {
      const { evaluate } = require('mathjs');
      const result = evaluate(formula, metrics);
      return typeof result === 'number' ? result : 0;
    } catch {
      console.warn(`[AlgorithmVoucherService] 公式计算失败: ${formula}`);
      return 0;
    }
  }

  /**
   * 生成游戏奖池计算详情文本
   */
  private getGamePoolCalculationDetail(gamePool: GamePoolSourceConfig, amount: number): string {
    if (gamePool.calculationMode === 'fixed') {
      return `固定总量: ${amount} A币`;
    }
    switch (gamePool.allocation.mode) {
      case 'fixed':
        return `固定金额: ${gamePool.allocation.fixedAmount} A币`;
      case 'ratio':
        return `收入提成: ${(gamePool.allocation.ratio || 0) * 100}% => ${amount.toFixed(4)} A币`;
      case 'formula':
        return `公式计算: ${gamePool.allocation.formula} => ${amount.toFixed(4)} A币`;
      default:
        return `${amount.toFixed(4)} A币`;
    }
  }
  
  /**
   * 计算贡献分数（分式公式）
   *
   * 公式：个人贡献分数 = (个人游戏币 / 全网游戏币) × 游戏币权重 +
   *                     (个人算力 / 全网算力) × 算力权重 +
   *                     (个人交易额 / 全网交易额) × 交易额权重
   */
  private calculateContributionScore(
    userData: UserPersonalData,
    algorithm: ContributionAlgorithm,
    totalGameCoins: number,
    totalComputingPower: number,
    totalTransactionVolume: number
  ): number {
    const { weights } = algorithm;
    
    // 分式公式：个人占比 × 权重（避免除以零）
    const gameCoinsRatio = totalGameCoins > 0 ? (userData.gameCoins || 0) / totalGameCoins : 0;
    const computingPowerRatio = totalComputingPower > 0 ? (userData.computingPower || 0) / totalComputingPower : 0;
    const transactionVolumeRatio = totalTransactionVolume > 0 ? (userData.transactionVolume || 0) / totalTransactionVolume : 0;
    
    // 计算贡献分数
    const score = 
      gameCoinsRatio * weights.gameCoins +
      computingPowerRatio * weights.computingPower +
      transactionVolumeRatio * weights.transactionVolume;
    
    return score;
  }
  
  /**
   * 计算所有用户的贡献
   */
  private calculateAllUserContributions(
    userDataList: UserPersonalData[],
    networkData: NetworkSnapshot,
    algorithm: ContributionAlgorithm
  ): UserPersonalData[] {
    const { totalGameCoins, totalComputingPower, totalTransactionVolume } = networkData;
    return userDataList.map(userData => ({
      ...userData,
      contributionScore: this.calculateContributionScore(
        userData, algorithm,
        totalGameCoins, totalComputingPower, totalTransactionVolume
      ),
    })).sort((a, b) => (b.contributionScore || 0) - (a.contributionScore || 0));
  }
  
  /**
   * 计算发放池
   */
  private calculateDistributionPool(
    networkData: NetworkSnapshot,
    poolConfig: DistributionPoolConfig,
    template?: AlgorithmVoucherTemplate
  ): number {
    // 检查是否使用固定总量模式
    if (poolConfig.calculationMode === 'fixed' && poolConfig.fixedTotalSupply && template) {
      // 固定总量模式：发放池 = 总量 * 最小面值
      return poolConfig.fixedTotalSupply * template.minDenomination;
    }
    
    // 自动计算模式：发放池 = 平台净收入 * 发放比例
    const basePool = networkData.platformNetIncome * poolConfig.ratio;
    const withCarryOver = basePool + networkData.carriedOverAmount;
    
    // 如果设置了总量上限，则不能超过上限
    if (template?.totalSupply) {
      const maxPool = template.totalSupply * template.minDenomination;
      return Math.min(Math.max(0, withCarryOver), maxPool);
    }
    
    return Math.max(0, withCarryOver);
  }
  
  /**
   * 计算结算分配
   */
  private calculateSettlementDistribution(
    userResults: UserPersonalData[],
    distributionPool: number,
    template: AlgorithmVoucherTemplate,
    options: SettlementOptions
  ): SettlementResult {
    const totalContributionScore = userResults.reduce(
      (sum, u) => sum + (u.contributionScore || 0), 
      0
    );
    
    const validUserResults: UserSettlementResult[] = [];
    let totalDistributed = 0;
    let totalVoucherCount = 0;
    
    console.log(`[AlgorithmVoucherService] 计算分配: ${userResults.length} 个用户, 发放池: ${distributionPool}, 阈值: ${options.minThreshold}`);
    
    for (const userData of userResults) {
      const contributionScore = userData.contributionScore || 0;
      const contributionRatio = totalContributionScore > 0 
        ? contributionScore / totalContributionScore 
        : 0;
      
      // 计算应得金额
      const calculatedAmount = distributionPool * contributionRatio;
      
      // 检查最小阈值
      if (calculatedAmount < options.minThreshold) {
        console.log(`[AlgorithmVoucherService] 用户 ${userData.userName} 被跳过: 计算金额 ${calculatedAmount.toFixed(6)} < 阈值 ${options.minThreshold}`);
        continue;
      }
      
      // 计算实际凭证数量（限制每人最多10张，防止性能问题）
      const MAX_VOUCHERS_PER_USER = 10;
      let actualVoucherCount = Math.floor(calculatedAmount / template.minDenomination);
      if (actualVoucherCount > MAX_VOUCHERS_PER_USER) {
        console.log(`[AlgorithmVoucherService] 用户 ${userData.userName} 凭证数量从 ${actualVoucherCount} 限制为 ${MAX_VOUCHERS_PER_USER}`);
        actualVoucherCount = MAX_VOUCHERS_PER_USER;
      }
      const actualTotalValue = actualVoucherCount * template.minDenomination;
      
      if (actualVoucherCount <= 0) {
        console.log(`[AlgorithmVoucherService] 用户 ${userData.userName} 被跳过: 凭证数量 ${actualVoucherCount} <= 0`);
        continue;
      }
      
      const result: UserSettlementResult = {
        userId: userData.userId,
        userName: userData.userName,
        personalData: {
          gameCoins: userData.gameCoins,
          computingPower: userData.computingPower,
          transactionVolume: userData.transactionVolume,
        },
        contributionScore,
        contributionRatio,
        calculatedAmount,
        actualVoucherCount,
        actualTotalValue,
        voucherIds: [],
        status: 'pending',
      };
      
      validUserResults.push(result);
      totalDistributed += actualTotalValue;
      totalVoucherCount += actualVoucherCount;
    }
    
    // 计算统计数据
    const amounts = validUserResults.map(r => r.actualTotalValue);
    amounts.sort((a, b) => a - b);
    
    const averagePerUser = validUserResults.length > 0 
      ? totalDistributed / validUserResults.length 
      : 0;
    const medianPerUser = amounts.length > 0
      ? amounts[Math.floor(amounts.length / 2)]
      : 0;
    const minReward = amounts.length > 0 ? amounts[0] : 0;
    const maxReward = amounts.length > 0 ? amounts[amounts.length - 1] : 0;
    
    console.log(`[AlgorithmVoucherService] 分配计算完成: ${userResults.length} 参与者, ${validUserResults.length} 符合资格, 发放 ${totalVoucherCount} 张凭证`);
    console.log(`[AlgorithmVoucherService] 符合资格用户:`, validUserResults.map(u => `${u.userName}: ${u.actualVoucherCount}张(${u.contributionRatio.toFixed(4)})`).join(', '));
    
    return {
      totalParticipants: userResults.length,
      eligibleParticipants: validUserResults.length,
      totalDistributed,
      totalVouchersIssued: totalVoucherCount,
      averagePerUser,
      medianPerUser,
      minReward,
      maxReward,
      totalVoucherCount,
      userResults: validUserResults,
      calculatedAt: Date.now(),
    };
  }

  /**
   * 游戏池独立分配：每个游戏奖池只分给该游戏的玩家
   * 玩家在该游戏内的贡献度占比由该玩家相对于其他游戏玩家的贡献度决定
   */
  private async distributeGamePoolsToPlayers(
    template: AlgorithmVoucherTemplate,
    networkData: NetworkSnapshot,
    userResults: UserPersonalData[],
    settlementResult: SettlementResult,
    cycle: SettlementCycle,
    options: SettlementOptions
  ): Promise<void> {
    const gamePools = template.poolConfig.gamePools || [];
    console.log(`[AlgorithmVoucherService] 开始游戏池独立分配，共 ${gamePools.length} 个游戏奖池`);

    for (const gamePool of gamePools) {
      try {
        const gameDetail = networkData.gamePoolDetails?.find(d => d.gameId === gamePool.gameId);
        if (!gameDetail || gameDetail.amount <= 0) {
          console.log(`[AlgorithmVoucherService] 游戏 ${gamePool.gameName} 奖池金额为0，跳过`);
          continue;
        }

        // 获取该游戏的玩家ID列表
        const gamePlayerIds = await this.dataCollector.collectGameUserIds?.(
          gamePool.gameId, cycle.startDate, cycle.endDate
        ) || [];

        if (gamePlayerIds.length === 0) {
          console.log(`[AlgorithmVoucherService] 游戏 ${gamePool.gameName} 无活跃玩家，跳过`);
          continue;
        }

        // 筛选出参与该游戏的用户
        const gameUserResults = userResults.filter(u => gamePlayerIds.includes(u.userId));
        if (gameUserResults.length === 0) {
          console.log(`[AlgorithmVoucherService] 游戏 ${gamePool.gameName} 的玩家不在结算名单中，跳过`);
          continue;
        }

        // 在游戏玩家中重新计算贡献度占比
        const totalGameScore = gameUserResults.reduce((sum, u) => sum + (u.contributionScore || 0), 0);
        if (totalGameScore <= 0) {
          console.log(`[AlgorithmVoucherService] 游戏 ${gamePool.gameName} 玩家总贡献为0，跳过`);
          continue;
        }

        console.log(`[AlgorithmVoucherService] 游戏 ${gamePool.gameName} 奖池 ${gameDetail.amount.toFixed(4)} A币，${gameUserResults.length} 名玩家`);

        for (const user of gameUserResults) {
          const ratio = (user.contributionScore || 0) / totalGameScore;
          const amount = gameDetail.amount * ratio;

          if (amount < options.minThreshold) continue;

          let voucherCount = Math.floor(amount / template.minDenomination);
          if (voucherCount <= 0) continue;
          if (voucherCount > 10) voucherCount = 10; // 每人最多10张
          const totalValue = voucherCount * template.minDenomination;

          // 查找或创建用户结算结果
          let existingResult = settlementResult.userResults.find(r => r.userId === user.userId);
          if (existingResult) {
            existingResult.calculatedAmount += amount;
            existingResult.actualVoucherCount += voucherCount;
            existingResult.actualTotalValue += totalValue;
          } else {
            const newResult: UserSettlementResult = {
              userId: user.userId,
              userName: user.userName,
              personalData: {
                gameCoins: user.gameCoins,
                computingPower: user.computingPower,
                transactionVolume: user.transactionVolume,
              },
              contributionScore: user.contributionScore || 0,
              contributionRatio: ratio,
              calculatedAmount: amount,
              actualVoucherCount: voucherCount,
              actualTotalValue: totalValue,
              voucherIds: [],
              status: 'pending',
            };
            settlementResult.userResults.push(newResult);
          }

          settlementResult.totalDistributed += totalValue;
          settlementResult.totalVouchersIssued += voucherCount;
        }

        console.log(`[AlgorithmVoucherService] 游戏 ${gamePool.gameName} 奖池分配完成: ${gameDetail.amount.toFixed(4)} A币 => ${gameUserResults.length} 名玩家`);
      } catch (error) {
        console.error(`[AlgorithmVoucherService] 游戏 ${gamePool.gameName} 奖池分配失败:`, error);
      }
    }

    // 更新结算统计
    const validResults = settlementResult.userResults;
    settlementResult.totalParticipants = validResults.length;
    settlementResult.eligibleParticipants = validResults.length;
    settlementResult.averagePerUser = validResults.length > 0
      ? settlementResult.totalDistributed / validResults.length
      : 0;

    console.log(`[AlgorithmVoucherService] 游戏池分配完成: ${settlementResult.totalVouchersIssued} 张凭证, ${settlementResult.totalDistributed.toFixed(4)} A币`);
  }

  /**
   * 向用户发行凭证
   */
  private async issueVouchersToUsers(
    userResults: UserSettlementResult[],
    cycle: SettlementCycle,
    template: AlgorithmVoucherTemplate
  ): Promise<void> {
    console.log(`[AlgorithmVoucherService] 开始发行凭证，共 ${userResults.length} 个用户`);
    console.log(`[AlgorithmVoucherService] 用户列表:`, userResults.map(u => `${u.userName}(${u.userId}): ${u.actualVoucherCount}张`));
    
    for (const userResult of userResults) {
      try {
        const voucherIds: string[] = [];
        
        console.log(`[AlgorithmVoucherService] 为用户 ${userResult.userName}(${userResult.userId}) 发行 ${userResult.actualVoucherCount} 张凭证`);
        
        // 批量创建凭证
        for (let i = 0; i < userResult.actualVoucherCount; i++) {
          const algorithmInfo: AlgorithmVoucherInfo = {
            templateId: template.id,
            templateName: template.name,
            settlementCycleId: cycle.id,
            cycleNumber: cycle.cycleNumber,
            settlementDate: cycle.settlementDate,
            contributionScore: userResult.contributionScore,
            contributionRatio: userResult.contributionRatio,
            calculatedAmount: userResult.calculatedAmount,
            actualAmount: template.minDenomination,
            personalDataSnapshot: userResult.personalData,
            networkSnapshot: cycle.networkSnapshot ? {
              totalGameCoins: cycle.networkSnapshot.totalGameCoins,
              totalComputingPower: cycle.networkSnapshot.totalComputingPower,
              totalTransactionVolume: cycle.networkSnapshot.totalTransactionVolume,
              totalContributionScore: cycle.networkSnapshot.totalContributionScore,
              distributionPool: cycle.networkSnapshot.distributionPool,
            } : undefined,
          };
          
          const voucher = this.voucherService.createVoucher({
            denomination: template.minDenomination,
            recipientId: userResult.userId,
            recipientName: userResult.userName,
            metadata: {
              name: `${template.name} #${cycle.cycleNumber}`,
              description: `${template.description || '算法分配型凭证'} - 周期${cycle.cycleNumber}`,
              category: 'algorithm_voucher',
              issuer: 'system',
              symbol: template.denominationUnit,
              sourceType: VoucherSourceType.ALGORITHM, // ✅ 在创建时就指定为算法型
            },
          }, 'system', '系统');
          
          // 更新凭证的算法信息
          const updatedVoucher: Voucher = {
            ...voucher,
            algorithmInfo,
          };
          
          // 保存到数据库
          voucherDB.updateVoucher(updatedVoucher);
          voucherIds.push(voucher.id);
        }
        
        userResult.voucherIds = voucherIds;
        userResult.status = 'issued';
        userResult.issuedAt = Date.now();
        
      } catch (error) {
        console.error(`[AlgorithmVoucherService] 为用户 ${userResult.userId} 发行凭证失败:`, error);
        userResult.status = 'failed';
        userResult.errorMessage = error instanceof Error ? error.message : '发行失败';
      }
    }
    
    // 保存结算结果
    this.saveSettlementResults(cycle.id, userResults);
    
    // 统计发行结果
    const issuedCount = userResults.filter(u => u.status === 'issued').length;
    const failedCount = userResults.filter(u => u.status === 'failed').length;
    const totalVouchersIssued = userResults.reduce((sum, u) => sum + (u.voucherIds?.length || 0), 0);
    console.log(`[AlgorithmVoucherService] 凭证发行完成: ${issuedCount} 成功, ${failedCount} 失败, 共 ${totalVouchersIssued} 张凭证`);
  }
  
  // ========== 查询方法 ==========
  
  /**
   * 获取用户的算法型凭证
   */
  getUserAlgorithmVouchers(userId: string): Voucher[] {
    const allVouchers = voucherDB.getVouchersByHolder(userId);
    return allVouchers.filter(v => v.sourceType === VoucherSourceType.ALGORITHM);
  }
  
  /**
   * 获取用户算法型凭证统计
   */
  getUserAlgorithmVoucherStats(userId: string): {
    totalCount: number;
    totalValue: number;
    vouchers: Voucher[];
  } {
    const vouchers = this.getUserAlgorithmVouchers(userId);
    const totalValue = vouchers.reduce((sum, v) => sum + v.denomination, 0);
    
    return {
      totalCount: vouchers.length,
      totalValue,
      vouchers,
    };
  }
  
  /**
   * 获取结算周期列表
   */
  getSettlementCycles(templateId?: string): SettlementCycle[] {
    let cycles = Array.from(this.cycles.values());
    
    if (templateId) {
      cycles = cycles.filter(c => c.templateId === templateId);
    }
    
    return cycles.sort((a, b) => b.createdAt - a.createdAt);
  }
  
  /**
   * 获取单个结算周期
   */
  getSettlementCycle(cycleId: string): SettlementCycle | null {
    return this.cycles.get(cycleId) || null;
  }
  
  /**
   * 获取用户结算历史
   */
  getUserSettlementHistory(userId: string): UserSettlementResult[] {
    const results: UserSettlementResult[] = [];
    
    for (const cycle of this.cycles.values()) {
      if (cycle.result) {
        const userResult = cycle.result.userResults.find(r => r.userId === userId);
        if (userResult) {
          results.push(userResult);
        }
      }
    }
    
    return results.sort((a, b) => (b.issuedAt || 0) - (a.issuedAt || 0));
  }
  
  /**
   * 预估用户收益
   */
  async estimateUserReward(
    userId: string,
    templateId: string
  ): Promise<UserEstimatedReward | null> {
    const template = this.templates.get(templateId);
    if (!template) return null;
    
    // 获取当前全网数据
    const now = new Date();
    const startDate = this.getTodayDate();
    const endDate = startDate;
    
    const userDataList = await this.dataCollector.collectAllUserData(startDate, endDate);
    const userData = userDataList.find(u => u.userId === userId);
    
    if (!userData) return null;
    
    const networkSnapshot = await this.collectNetworkData(
      {
        id: 'temp',
        templateId,
        cycleNumber: 0,
        startDate,
        endDate,
        settlementDate: endDate,
        status: SettlementStatus.PENDING,
        createdAt: Date.now(),
      },
      template
    );
    
    const contributionScore = this.calculateContributionScore(
      userData, template.algorithm,
      networkSnapshot.totalGameCoins, networkSnapshot.totalComputingPower, networkSnapshot.totalTransactionVolume
    );
    const contributionRatio = networkSnapshot.totalContributionScore > 0
      ? contributionScore / networkSnapshot.totalContributionScore
      : 0;
    
    const estimatedAmount = networkSnapshot.distributionPool * contributionRatio;
    const estimatedVoucherCount = Math.floor(estimatedAmount / template.minDenomination);
    
    // 计算排名
    const sortedUsers = userDataList
      .map(u => ({
        userId: u.userId,
        score: this.calculateContributionScore(
          u, template.algorithm,
          networkSnapshot.totalGameCoins, networkSnapshot.totalComputingPower, networkSnapshot.totalTransactionVolume
        ),
      }))
      .sort((a, b) => b.score - a.score);
    
    const rank = sortedUsers.findIndex(u => u.userId === userId) + 1;
    const percentile = sortedUsers.length > 0
      ? (rank / sortedUsers.length) * 100
      : 0;
    
    return {
      userId,
      personalData: {
        gameCoins: userData.gameCoins,
        computingPower: userData.computingPower,
        transactionVolume: userData.transactionVolume,
      },
      contributionScore,
      contributionRatio,
      estimatedAmount,
      estimatedVoucherCount,
      rank: rank || undefined,
      totalParticipants: sortedUsers.length,
      percentile,
      basedOnSnapshot: networkSnapshot,
      estimatedAt: Date.now(),
    };
  }
  
  /**
   * 获取贡献度排行榜
   */
  async getContributionLeaderboard(
    templateId: string,
    cycleId?: string,
    limit: number = 100
  ): Promise<ContributionLeaderboardItem[]> {
    let userResults: UserSettlementResult[] = [];
    
    if (cycleId) {
      const cycle = this.cycles.get(cycleId);
      if (cycle?.result) {
        userResults = cycle.result.userResults;
      }
    } else {
      // 获取最新周期的数据
      const cycles = this.getSettlementCycles(templateId);
      const latestCycle = cycles.find(c => c.status === SettlementStatus.COMPLETED);
      if (latestCycle?.result) {
        userResults = latestCycle.result.userResults;
      }
    }
    
    return userResults
      .sort((a, b) => b.contributionScore - a.contributionScore)
      .slice(0, limit)
      .map((r, index) => ({
        rank: index + 1,
        userId: r.userId,
        userName: r.userName,
        contributionScore: r.contributionScore,
        contributionRatio: r.contributionRatio,
        gameCoins: r.personalData.gameCoins,
        computingPower: r.personalData.computingPower,
        transactionVolume: r.personalData.transactionVolume,
        rewardAmount: r.actualTotalValue,
        voucherCount: r.actualVoucherCount,
      }));
  }
  
  // ========== 工具方法 ==========
  
  /**
   * 计算日期范围
   */
  private calculateDateRange(
    template: AlgorithmVoucherTemplate,
    targetDate: string
  ): { startDate: string; endDate: string } {
    const date = new Date(targetDate);
    let startDate: Date;
    let endDate: Date;
    
    switch (template.settlementCycle) {
      case 'daily':
        startDate = new Date(date);
        endDate = new Date(date);
        break;
        
      case 'weekly':
        const dayOfWeek = date.getDay();
        const diff = date.getDate() - dayOfWeek;
        startDate = new Date(date.setDate(diff));
        endDate = new Date(date);
        endDate.setDate(startDate.getDate() + 6);
        break;
        
      case 'monthly':
        startDate = new Date(date.getFullYear(), date.getMonth(), 1);
        endDate = new Date(date.getFullYear(), date.getMonth() + 1, 0);
        break;
        
      default:
        startDate = new Date(date);
        endDate = new Date(date);
    }
    
    return {
      startDate: this.formatDate(startDate),
      endDate: this.formatDate(endDate),
    };
  }
  
  /**
   * 获取今天日期字符串
   */
  private getTodayDate(): string {
    return this.formatDate(new Date());
  }
  
  /**
   * 格式化日期
   */
  private formatDate(date: Date): string {
    return date.toISOString().split('T')[0];
  }
  
  // ========== 存储管理 ==========
  
  /**
   * 从存储加载数据
   */
  private async loadFromStorage(): Promise<void> {
    try {
      // 加载模板
      const templatesData = localStorage.getItem(TEMPLATES_KEY);
      if (templatesData) {
        const templates = JSON.parse(templatesData) as AlgorithmVoucherTemplate[];
        this.templates = new Map(templates.map(t => [t.id, t]));
      }
      
      // 加载周期
      const cyclesData = localStorage.getItem(CYCLES_KEY);
      if (cyclesData) {
        const cycles = JSON.parse(cyclesData) as SettlementCycle[];
        this.cycles = new Map(cycles.map(c => [c.id, c]));
      }
      
      console.log(`[AlgorithmVoucherService] 加载完成: ${this.templates.size} 模板, ${this.cycles.size} 周期`);
    } catch (error) {
      console.error('[AlgorithmVoucherService] 加载数据失败:', error);
    }
  }
  
  /**
   * 保存到存储
   */
  private saveToStorage(): void {
    try {
      localStorage.setItem(TEMPLATES_KEY, JSON.stringify(Array.from(this.templates.values())));
      localStorage.setItem(CYCLES_KEY, JSON.stringify(Array.from(this.cycles.values())));
    } catch (error) {
      console.error('[AlgorithmVoucherService] 保存数据失败:', error);
    }
  }
  
  /**
   * 保存结算结果
   */
  private saveSettlementResults(cycleId: string, userResults: UserSettlementResult[]): void {
    try {
      const key = `${USER_RESULTS_KEY}:${cycleId}`;
      localStorage.setItem(key, JSON.stringify(userResults));
    } catch (error) {
      console.error('[AlgorithmVoucherService] 保存结算结果失败:', error);
    }
  }
  
  /**
   * 获取结算结果
   */
  getSettlementResults(cycleId: string): UserSettlementResult[] {
    try {
      const key = `${USER_RESULTS_KEY}:${cycleId}`;
      const data = localStorage.getItem(key);
      return data ? JSON.parse(data) : [];
    } catch (error) {
      console.error('[AlgorithmVoucherService] 获取结算结果失败:', error);
      return [];
    }
  }
}

// 导出单例
export const algorithmVoucherService = AlgorithmVoucherService.getInstance();
