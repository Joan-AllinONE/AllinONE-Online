/**
 * 平台绑定服务
 * 管理凭证规则与游戏的绑定配置，以及奖励发放记录
 */

import type {
  PlatformBindingConfig,
  CreateBindingRequest,
  UpdateBindingRequest,
  RewardDistributionRecord,
  UserRewardLimit,
  PlatformIntegrationStats,
  GameDefinition,
  TriggerMode,
  PoolSource,
} from '../types/platform';
import { PRESET_GAMES, GameType } from '../types/platform';
import { voucherService } from './VoucherService';
import { VoucherStatus } from '../types';
import { voucherRuleEngine } from '../engine/RuleEngine';
import type { DistributionRule, RecycleRule, ExchangeRate, VoucherRules } from '../types';
import { PLATFORM_CURRENCY_TEMPLATE } from '../templates';
import { userPoolService } from './UserPoolService';

const STORAGE_KEYS = {
  BINDINGS: 'voucher_platform_bindings',
  REWARD_RECORDS: 'voucher_reward_records',
  USER_LIMITS: 'voucher_user_reward_limits',
};

/**
 * 从模板和存储中获取规则
 */
function getRuleById(ruleId: string): DistributionRule | null {
  // 1. 从模板中查找
  const templateRules = PLATFORM_CURRENCY_TEMPLATE?.presetRules?.distribution || [];
  const templateRule = templateRules.find(r => r.id === ruleId);
  if (templateRule) return templateRule;

  // 2. 从存储的凭证中查找
  const allVouchers = voucherService.filterVouchers({});
  for (const voucher of allVouchers) {
    if (voucher.rules?.distribution) {
      const rule = voucher.rules.distribution.find(r => r.id === ruleId);
      if (rule) return rule;
    }
  }

  return null;
}

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
 * 平台绑定服务类
 */
export class PlatformBindingService {
  private static instance: PlatformBindingService | null = null;
  
  private bindings: Map<string, PlatformBindingConfig> = new Map();
  private rewardRecords: Map<string, RewardDistributionRecord> = new Map();
  private userLimits: Map<string, UserRewardLimit> = new Map();
  private initialized = false;

  private constructor() {
    this.loadFromStorage();
  }

  static getInstance(): PlatformBindingService {
    if (!PlatformBindingService.instance) {
      PlatformBindingService.instance = new PlatformBindingService();
    }
    return PlatformBindingService.instance;
  }

  // ==================== 存储管理 ====================

  private loadFromStorage(): void {
    try {
      // 加载绑定配置
      const bindingsData = localStorage.getItem(STORAGE_KEYS.BINDINGS);
      if (bindingsData) {
        const bindings: PlatformBindingConfig[] = JSON.parse(bindingsData);
        bindings.forEach(b => this.bindings.set(b.id, b));
        console.log(`[PlatformBindingService] 加载 ${bindings.length} 个绑定配置:`,
          bindings.map(b => `[${b.gameName}]规则=${b.ruleId} 启用=${b.enabled}`));
      } else {
        console.log('[PlatformBindingService] 没有找到任何绑定配置');
      }

      // 加载发放记录
      const recordsData = localStorage.getItem(STORAGE_KEYS.REWARD_RECORDS);
      if (recordsData) {
        const records: RewardDistributionRecord[] = JSON.parse(recordsData);
        records.forEach(r => this.rewardRecords.set(r.id, r));
      }

      // 加载用户限制
      const limitsData = localStorage.getItem(STORAGE_KEYS.USER_LIMITS);
      if (limitsData) {
        const limits: UserRewardLimit[] = JSON.parse(limitsData);
        limits.forEach(l => this.userLimits.set(`${l.userId}:${l.bindingId}`, l));
      }

      this.initialized = true;
      console.log('[PlatformBindingService] 数据加载完成:', {
        bindings: this.bindings.size,
        records: this.rewardRecords.size,
        limits: this.userLimits.size,
      });
    } catch (error) {
      console.error('[PlatformBindingService] 加载数据失败:', error);
    }
  }

  private saveToStorage(): void {
    try {
      localStorage.setItem(STORAGE_KEYS.BINDINGS, JSON.stringify([...this.bindings.values()]));
      localStorage.setItem(STORAGE_KEYS.REWARD_RECORDS, JSON.stringify([...this.rewardRecords.values()]));
      localStorage.setItem(STORAGE_KEYS.USER_LIMITS, JSON.stringify([...this.userLimits.values()]));
    } catch (error) {
      console.error('[PlatformBindingService] 保存数据失败:', error);
    }
  }

  // ==================== 绑定配置管理 ====================

  /**
   * 创建绑定配置
   */
  createBinding(
    request: CreateBindingRequest & {
      poolSource?: PoolSource;
      poolOwnerId?: string;
      poolId?: string;
      sourceCategory?: 'rule' | 'algorithm';
      algorithmTemplateId?: string;
      /** 自定义分发规则（替代ruleId引用的预设规则） */
      customDistributionRule?: DistributionRule;
      /** 自定义回收规则 */
      customRecycleRules?: RecycleRule[];
      /** 自定义兑换币种 */
      customExchangeRates?: ExchangeRate[];
    },
    operatorId: string,
    operatorName: string
  ): PlatformBindingConfig {
    const now = Date.now();
    const binding: PlatformBindingConfig & {
      poolSource?: PoolSource;
      poolOwnerId?: string;
      poolId?: string;
      sourceCategory?: string;
      algorithmTemplateId?: string;
      customDistributionRule?: DistributionRule;
      customRecycleRules?: RecycleRule[];
      customExchangeRates?: ExchangeRate[];
    } = {
      id: generateUUID(),
      gameId: request.gameId,
      gameName: request.gameName,
      gameType: request.gameType,
      ruleId: request.ruleId,
      ruleName: request.ruleName,
      triggerMode: request.triggerMode,
      paramsOverride: request.paramsOverride,
      limits: request.limits,
      enabled: true,
      createdAt: now,
      updatedAt: now,
      createdBy: operatorId,
      createdByName: operatorName,
      // 奖池相关配置
      poolSource: request.poolSource || 'platform',
      poolOwnerId: request.poolOwnerId,
      poolId: request.poolId,
      // 来源类型
      sourceCategory: request.sourceCategory,
      algorithmTemplateId: request.algorithmTemplateId,
      // 自定义规则
      customDistributionRule: request.customDistributionRule,
      customRecycleRules: request.customRecycleRules,
      customExchangeRates: request.customExchangeRates,
    };

    this.bindings.set(binding.id, binding as PlatformBindingConfig);
    this.saveToStorage();

    console.log('[PlatformBindingService] 创建绑定:', binding);
    return binding as PlatformBindingConfig;
  }

  /**
   * 更新绑定配置
   */
  updateBinding(
    bindingId: string,
    request: UpdateBindingRequest
  ): PlatformBindingConfig | null {
    const binding = this.bindings.get(bindingId);
    if (!binding) return null;

    if (request.triggerMode !== undefined) {
      binding.triggerMode = request.triggerMode;
    }
    if (request.paramsOverride !== undefined) {
      binding.paramsOverride = request.paramsOverride;
    }
    if (request.limits !== undefined) {
      binding.limits = { ...binding.limits, ...request.limits };
    }
    if (request.enabled !== undefined) {
      binding.enabled = request.enabled;
    }

    binding.updatedAt = Date.now();
    this.bindings.set(bindingId, binding);
    this.saveToStorage();

    return binding;
  }

  /**
   * 删除绑定配置
   */
  deleteBinding(bindingId: string): boolean {
    const result = this.bindings.delete(bindingId);
    if (result) {
      this.saveToStorage();
    }
    return result;
  }

  /**
   * 获取绑定配置
   */
  getBinding(bindingId: string): PlatformBindingConfig | null {
    return this.bindings.get(bindingId) || null;
  }

  /**
   * 获取游戏的所有绑定配置
   */
  getBindingsByGame(gameId: string): PlatformBindingConfig[] {
    return [...this.bindings.values()].filter(b => b.gameId === gameId);
  }

  /**
   * 获取规则的所有绑定配置
   */
  getBindingsByRule(ruleId: string): PlatformBindingConfig[] {
    return [...this.bindings.values()].filter(b => b.ruleId === ruleId);
  }

  /**
   * 获取所有绑定配置
   */
  getAllBindings(): PlatformBindingConfig[] {
    return [...this.bindings.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * 启用/禁用绑定
   */
  toggleBinding(bindingId: string, enabled: boolean): boolean {
    const binding = this.bindings.get(bindingId);
    if (!binding) return false;

    binding.enabled = enabled;
    binding.updatedAt = Date.now();
    this.saveToStorage();
    return true;
  }

  // ==================== 游戏列表 ====================

  /**
   * 获取所有游戏定义（包括预设和动态添加的）
   */
  getAllGames(): GameDefinition[] {
    // 从发布中心获取已发布的游戏
    const publishedGames = this.getPublishedGames();
    return [...PRESET_GAMES, ...publishedGames];
  }

  /**
   * 获取指定游戏
   */
  getGame(gameId: string): GameDefinition | undefined {
    return this.getAllGames().find(g => g.id === gameId);
  }

  /**
   * 获取指定类型的游戏
   */
  getGamesByType(type: GameType): GameDefinition[] {
    return this.getAllGames().filter(g => g.type === type);
  }

  /**
   * 从发布中心获取已发布的游戏
   */
  private getPublishedGames(): GameDefinition[] {
    try {
      const publishedData = localStorage.getItem('allinone_published_games');
      if (publishedData) {
        const games = JSON.parse(publishedData);
        return games.map((g: any) => ({
          id: g.id,
          name: g.name,
          type: GameType.PUBLISHED,
          description: g.description,
          icon: this.normalizeIcon(g.icon, g.framework),
          status: g.status || 'available',
          isPublished: true,
          supportsScore: true,
          supportsAchievements: true,
        }));
      }
    } catch (error) {
      console.error('[PlatformBindingService] 获取已发布游戏失败:', error);
    }
    return [];
  }

  /**
   * 将 Font Awesome 类名转换为绑定 UI 能显示的 emoji
   */
  private normalizeIcon(icon: string | undefined, framework?: string): string {
    if (!icon || icon.startsWith('fa-')) {
      const frameworkEmojis: Record<string, string> = {
        phaser: '🎮',
        'three-js': '🧊',
        'unity-webgl': '🎯',
        react: '⚛️',
        default: '🎮',
      };
      return frameworkEmojis[framework || ''] || frameworkEmojis.default;
    }
    return icon;
  }

  // ==================== 奖励发放 ====================

  /**
   * 检查用户是否可以领取奖励
   */
  canUserReceiveReward(userId: string, bindingId: string): { allowed: boolean; reason?: string } {
    const binding = this.bindings.get(bindingId);
    if (!binding) {
      return { allowed: false, reason: '绑定配置不存在' };
    }
    if (!binding.enabled) {
      return { allowed: false, reason: '该奖励已禁用' };
    }

    const limitKey = `${userId}:${bindingId}`;
    let userLimit = this.userLimits.get(limitKey);
    const now = Date.now();

    // 检查每日重置
    if (userLimit && now > userLimit.dailyCountResetAt) {
      userLimit.dailyCount = 0;
      userLimit.dailyCountResetAt = this.getNextResetTime();
    }

    // 检查每日上限
    if (userLimit && userLimit.dailyCount >= binding.limits.maxDaily) {
      return { allowed: false, reason: '今日领取次数已达上限' };
    }

    // 检查总上限
    if (userLimit && userLimit.totalCount >= binding.limits.maxPerUser) {
      return { allowed: false, reason: '该奖励总领取次数已达上限' };
    }

    // 检查冷却时间
    if (userLimit && binding.limits.cooldownMinutes > 0) {
      const cooldownMs = binding.limits.cooldownMinutes * 60 * 1000;
      if (now - userLimit.lastReceivedAt < cooldownMs) {
        const remainingMinutes = Math.ceil((cooldownMs - (now - userLimit.lastReceivedAt)) / 60000);
        return { allowed: false, reason: `冷却中，还需等待 ${remainingMinutes} 分钟` };
      }
    }

    return { allowed: true };
  }

  /**
   * 发放奖励（通过规则引擎）
   */
  async distributeReward(
    bindingId: string,
    userId: string,
    userName: string,
    triggerData: Record<string, any>
  ): Promise<{ success: boolean; record?: RewardDistributionRecord; error?: string }> {
    const binding = this.bindings.get(bindingId);
    if (!binding) {
      return { success: false, error: '绑定配置不存在' };
    }

    // 检查是否可以领取
    const checkResult = this.canUserReceiveReward(userId, bindingId);
    if (!checkResult.allowed) {
      return { success: false, error: checkResult.reason };
    }

    try {
      // 使用规则引擎触发事件
      const eventType = this.getEventTypeByTriggerMode(binding.triggerMode);
      const result = await voucherRuleEngine.triggerEvent(eventType, {
        userId,
        userName,
        gameId: binding.gameId,
        gameType: binding.gameType,
        ...triggerData,
      });

      if (!result.success || result.vouchers.length === 0) {
        return { success: false, error: result.message || '没有匹配的奖励规则' };
      }

      // 更新用户限制
      this.updateUserLimit(userId, bindingId);

      // 创建发放记录
      const record: RewardDistributionRecord = {
        id: generateUUID(),
        bindingId,
        gameId: binding.gameId,
        userId,
        userName,
        ruleId: binding.ruleId,
        voucherId: result.vouchers[0].id,
        amount: result.vouchers[0].denomination,
        timestamp: Date.now(),
        triggerData,
        source: result.source,
      };

      this.rewardRecords.set(record.id, record);
      this.saveToStorage();

      console.log('[PlatformBindingService] 奖励发放成功:', record);
      return { success: true, record };
    } catch (error) {
      console.error('[PlatformBindingService] 奖励发放失败:', error);
      return { success: false, error: String(error) };
    }
  }

  /**
   * 直接发放奖励（简单场景，如点击即得）
   * 支持平台奖池和用户奖池
   */
  async distributeSimpleReward(
    bindingId: string,
    userId: string,
    userName: string,
    triggerData: Record<string, any>
  ): Promise<{ success: boolean; record?: RewardDistributionRecord; error?: string }> {
    const binding = this.bindings.get(bindingId) as PlatformBindingConfig & {
      poolSource?: PoolSource;
      poolOwnerId?: string;
      poolId?: string;
    };
    if (!binding) {
      return { success: false, error: '绑定配置不存在' };
    }

    // 检查是否可以领取
    const checkResult = this.canUserReceiveReward(userId, bindingId);
    if (!checkResult.allowed) {
      return { success: false, error: checkResult.reason };
    }

    try {
      // 获取规则配置 — 优先使用自定义规则，其次从模板查找
      const rule = (binding as any).customDistributionRule || getRuleById(binding.ruleId);
      if (!rule) {
        return { success: false, error: '规则不存在' };
      }

      // 检查规则是否配置了金额（防止模板预设规则为空的情况）
      const hasNoAllocation = !rule.allocation || (!rule.allocation.fixedAmount && (!rule.allocation.tieredAmounts || rule.allocation.tieredAmounts.length === 0));
      if (hasNoAllocation) {
        // 区分新旧绑定：旧绑定引用模板规则，新绑定缺少配置
        const useCustomRule = (binding as any).customDistributionRule;
        const msg = useCustomRule
          ? `绑定 ${binding.gameName} 的自定义规则缺少金额配置，请在「游戏绑定」中编辑`
          : `绑定 ${binding.gameName} 引用模板规则 "${binding.ruleName}"，但模板不再预设金额。请在「游戏绑定」Tab中编辑此绑定，展开规则配置并填写发放金额`;
        return { success: false, error: msg };
      }

      let amount: number;
      let allocationMode = rule.allocation.mode;

      // 计算奖励金额
      if (rule.allocation.mode === 'fixed' && rule.allocation.fixedAmount) {
        // 优先使用 paramsOverride 中的 baseReward，如果有的话
        if (binding.paramsOverride?.baseReward) {
          amount = binding.paramsOverride.baseReward;
        } else {
          amount = rule.allocation.fixedAmount;
        }
      } else if (rule.allocation.mode === 'tiered' && rule.allocation.tieredAmounts?.length) {
        // 分档奖励：根据分数选择对应金额
        const score = triggerData?.score || 0;
        const tier = rule.allocation.tieredAmounts
          .sort((a, b) => a.minThreshold - b.minThreshold)
          .find(t => score >= t.minThreshold && score < t.maxThreshold);
        amount = tier?.amount || rule.allocation.tieredAmounts[0]?.amount || 10;
      } else {
        return { success: false, error: '该绑定未配置有效的分配模式或金额' };
      }

      // 创建或转移凭证
      let voucher;
      let source: 'pool_transfer' | 'new_created' | 'user_pool_transfer' = 'new_created';
      let poolSource: PoolSource | undefined;
      let poolOwnerId: string | undefined;
      let poolId: string | undefined;
      let poolName: string | undefined;

      // 🎯 优先尝试从用户奖池转移
      const bindingPoolSource = binding.poolSource || 'platform';
      
      if (bindingPoolSource === 'user' && binding.poolOwnerId) {
        // 使用指定的用户奖池
        if (binding.poolId) {
          // 从指定奖池发放
          const result = userPoolService.distributeFromPool(
            binding.poolId,
            userId,
            userName,
            amount
          );
          if (result.success) {
            voucher = voucherService.getVoucherById(result.voucherId!);
            source = 'user_pool_transfer';
            poolSource = 'user';
            poolOwnerId = binding.poolOwnerId;
            poolId = binding.poolId;
            const pool = userPoolService.getPool(binding.poolId);
            poolName = pool?.name;
          }
        } else {
          // 从该用户的所有活跃奖池中随机选择
          const result = userPoolService.distributeFromUserPools(
            binding.poolOwnerId,
            userId,
            userName,
            amount
          );
          if (result.success) {
            voucher = voucherService.getVoucherById(result.voucherId!);
            source = 'user_pool_transfer';
            poolSource = 'user';
            poolOwnerId = binding.poolOwnerId;
            poolId = result.poolId;
            poolName = result.poolName;
          }
        }
      }

      // 🏦 如果绑定的池来源是平台奖池，尝试从平台奖池转移
      // 注意：用户奖池失败后不兜底到平台奖池，避免显示误导性错误
      if (!voucher && bindingPoolSource !== 'user' && rule.source?.mode === 'transfer_from_pool') {
        const poolHolderId = rule.source.poolHolderId || 'SYSTEM';
        const poolVouchers = voucherService.getUserVouchers(poolHolderId)
          .filter(v => v.status === VoucherStatus.ACTIVE);

        if (poolVouchers.length > 0) {
          // 贪心算法：尽可能用多张凭证凑出精确金额
          // 避免整张大额凭证（如 100）一次性转出而实际只需发放少量（如 1）
          const sortedVouchers = [...poolVouchers].sort((a, b) => b.denomination - a.denomination);
          const selectedIds: string[] = [];
          let remaining = amount;

          for (const v of sortedVouchers) {
            if (remaining <= 0) break;
            if (v.denomination <= remaining) {
              selectedIds.push(v.id);
              remaining -= v.denomination;
            }
          }

          if (remaining === 0) {
            // 精确匹配成功：转移凑出的所有凭证
            for (const vid of selectedIds) {
              voucherService.transferVoucher(
                { voucherId: vid, toUserId: userId, toUserName: userName, note: `${binding.gameName}游戏奖励` },
                poolHolderId,
                '奖池系统'
              );
            }
            voucher = voucherService.getVoucherById(selectedIds[selectedIds.length - 1]);
            source = 'pool_transfer';
            poolSource = 'platform';
          } else {
            // 精确匹配失败：找一张面额 >= 剩余金额的凭证，转移后给奖池找零
            const overflowVoucher = sortedVouchers.find(v => v.denomination >= remaining && !selectedIds.includes(v));
            if (overflowVoucher) {
              voucherService.transferVoucher(
                { voucherId: overflowVoucher.id, toUserId: userId, toUserName: userName, note: `${binding.gameName}游戏奖励` },
                poolHolderId,
                '奖池系统'
              );
              // 从平台标准库存中给奖池找零，避免多发给用户
              const changeAmount = overflowVoucher.denomination - remaining;
              this.giveChangeToAccount(poolHolderId, changeAmount, `${binding.gameName}奖励找零`);
              voucher = overflowVoucher;
              source = 'pool_transfer';
              poolSource = 'platform';
            }
          }
        }
      }

      // 🚫 所有奖池余额均不足 — 返回明确错误，不再后台隐式创建凭证
      if (!voucher) {
        if (bindingPoolSource === 'user') {
          return {
            success: false,
            error: '用户奖池凭证不足，请检查该用户奖池是否已耗尽或未存入凭证'
          };
        }
        return {
          success: false,
          error: '平台奖池余额不足，请前往「奖池管理」充值后再发放奖励'
        };
      }

      // 更新用户限制
      this.updateUserLimit(userId, bindingId);

      // 创建发放记录
      const record: RewardDistributionRecord = {
        id: generateUUID(),
        bindingId,
        gameId: binding.gameId,
        userId,
        userName,
        ruleId: binding.ruleId,
        voucherId: voucher.id,
        amount: voucher.denomination,
        timestamp: Date.now(),
        triggerData,
        source,
        poolSource,
        poolOwnerId,
        poolId,
        poolName,
      };

      this.rewardRecords.set(record.id, record);
      this.saveToStorage();

      console.log('[PlatformBindingService] 简单奖励发放成功:', record);

      // 通知钱包刷新凭证余额
      window.dispatchEvent(new CustomEvent('wallet-updated', { detail: { userId } }));

      return { success: true, record };
    } catch (error) {
      console.error('[PlatformBindingService] 简单奖励发放失败:', error);
      return { success: false, error: String(error) };
    }
  }

  /**
   * 更新用户领取限制
   */
  private updateUserLimit(userId: string, bindingId: string): void {
    const limitKey = `${userId}:${bindingId}`;
    let userLimit = this.userLimits.get(limitKey);
    const now = Date.now();

    if (!userLimit) {
      userLimit = {
        userId,
        bindingId,
        lastReceivedAt: now,
        dailyCount: 1,
        dailyCountResetAt: this.getNextResetTime(),
        totalCount: 1,
      };
    } else {
      // 检查是否需要重置每日计数
      if (now > userLimit.dailyCountResetAt) {
        userLimit.dailyCount = 1;
        userLimit.dailyCountResetAt = this.getNextResetTime();
      } else {
        userLimit.dailyCount++;
      }
      userLimit.lastReceivedAt = now;
      userLimit.totalCount++;
    }

    this.userLimits.set(limitKey, userLimit);
  }

  /**
   * 获取下次重置时间（次日0点）
   */
  private getNextResetTime(): number {
    const now = new Date();
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    return tomorrow.getTime();
  }

  /**
   * 根据触发模式获取事件类型
   */
  private getEventTypeByTriggerMode(mode: TriggerMode): string {
    switch (mode) {
      case TriggerMode.ON_GAME_COMPLETE:
        return 'GAME_COMPLETE';
      case TriggerMode.ON_CLICK:
        return 'GAME_CLICK';
      case TriggerMode.ON_ACHIEVEMENT:
        return 'ACHIEVEMENT_UNLOCK';
      case TriggerMode.MANUAL:
        return 'MANUAL_TRIGGER';
      default:
        return 'GAME_EVENT';
    }
  }

  // ==================== 查询统计 ====================

  /**
   * 获取用户的发放记录
   */
  getUserRewardRecords(userId: string): RewardDistributionRecord[] {
    return [...this.rewardRecords.values()]
      .filter(r => r.userId === userId)
      .sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * 获取游戏的发放记录
   */
  getGameRewardRecords(gameId: string): RewardDistributionRecord[] {
    return [...this.rewardRecords.values()]
      .filter(r => r.gameId === gameId)
      .sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * 获取所有发放记录
   */
  getAllRewardRecords(): RewardDistributionRecord[] {
    return [...this.rewardRecords.values()].sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * 获取统计信息
   */
  getStats(): PlatformIntegrationStats {
    const records = [...this.rewardRecords.values()];
    const bindings = [...this.bindings.values()];

    const distributionsByGame: Record<string, number> = {};
    const distributionsByRule: Record<string, number> = {};

    records.forEach(r => {
      distributionsByGame[r.gameId] = (distributionsByGame[r.gameId] || 0) + 1;
      distributionsByRule[r.ruleId] = (distributionsByRule[r.ruleId] || 0) + 1;
    });

    return {
      totalBindings: bindings.length,
      activeBindings: bindings.filter(b => b.enabled).length,
      totalDistributions: records.length,
      totalAmountDistributed: records.reduce((sum, r) => sum + r.amount, 0),
      distributionsByGame,
      distributionsByRule,
    };
  }

  /**
   * 获取活跃绑定（用于游戏触发）
   */
  getActiveBindingsForGame(gameId: string, triggerMode?: TriggerMode): PlatformBindingConfig[] {
    return [...this.bindings.values()].filter(b => 
      b.gameId === gameId && 
      b.enabled &&
      (!triggerMode || b.triggerMode === triggerMode)
    );
  }

  // ==================== 平台奖池资金管理 ====================

  /**
   * 查询平台奖池余额
   * 统计所有发放到 SYSTEM 持有者的有效凭证
   */
  getSystemPoolBalance(): { totalAmount: number; voucherCount: number; vouchers: { id: string; denomination: number; serialNumber: string }[] } {
    const systemVouchers = voucherService.filterVouchers({
      holderId: 'SYSTEM',
      status: 'active' as any,
    });

    return {
      totalAmount: systemVouchers.reduce((sum, v) => sum + v.denomination, 0),
      voucherCount: systemVouchers.length,
      vouchers: systemVouchers.map(v => ({
        id: v.id,
        denomination: v.denomination,
        serialNumber: (v as any).serialNumber || '',
      })),
    };
  }

  /**
   * 🏦 向平台奖池划拨凭证（从平台库存 transfer，而非铸币）
   *
   * 从 platform_pool（平台总账户）中转移已有凭证到 SYSTEM（平台奖池），
   * 供后续游戏奖励分发使用。不创建新凭证——凭证总量不变，仅改变持有者。
   */
  fundSystemPool(
    amount: number,
    denomination: number,
    count: number,
    operatorId: string,
    operatorName: string,
    note?: string
  ): { success: boolean; created: number; totalAmount: number; error?: string } {
    try {
      // 1. 从 platform_pool 获取指定面额的可用凭证
      const poolVouchers = voucherService.getUserVouchers('platform_pool')
        .filter(v => v.status === VoucherStatus.ACTIVE && v.denomination === denomination);

      if (poolVouchers.length < count) {
        return {
          success: false,
          created: 0,
          totalAmount: 0,
          error: `平台库存不足：需要 ${count} 张面额 ${denomination} A币，实际可用 ${poolVouchers.length} 张。（请先通过平台管理→商店管理确保障证库存充足，或联系管理员向 platform_pool 注入凭证）`,
        };
      }

      // 2. 按需划拨（贪心取前 count 张）
      let transferred = 0;
      let totalAmount = 0;
      const toTransfer = poolVouchers.slice(0, count);

      for (const v of toTransfer) {
        voucherService.transferVoucher(
          {
            voucherId: v.id,
            toUserId: 'SYSTEM',
            toUserName: '平台奖池',
            note: note || `平台库存划拨至奖池: ${denomination}A币 (操作者: ${operatorName})`,
          },
          'platform_pool',
          '平台总账户'
        );
        transferred++;
        totalAmount += v.denomination;
      }

      console.log(`[PlatformBindingService] 奖池划拨成功: ${totalAmount}A币 (${transferred}张), 操作者: ${operatorName}`);
      return { success: true, created: transferred, totalAmount };
    } catch (error) {
      console.error('[PlatformBindingService] 奖池划拨失败:', error);
      return { success: false, created: 0, totalAmount: 0, error: String(error) };
    }
  }

  /**
   * 🔙 清空平台奖池（划拨回 platform_pool，而非销毁）
   */
  clearSystemPool(operatorId: string, operatorName: string): { success: boolean; clearedCount: number } {
    const systemVouchers = voucherService.filterVouchers({
      holderId: 'SYSTEM',
      status: 'active' as any,
    });

    let clearedCount = 0;
    for (const v of systemVouchers) {
      try {
        voucherService.transferVoucher(
          {
            voucherId: v.id,
            toUserId: 'platform_pool',
            toUserName: '平台总账户',
            note: `奖池回收: ${operatorName} 清空奖池，凭证回库`,
          },
          'SYSTEM',
          '平台奖池'
        );
        clearedCount++;
      } catch (e) {
        console.warn(`[PlatformBindingService] 回收凭证失败: ${v.id}`, e);
      }
    }

    console.log(`[PlatformBindingService] 奖池已清空: ${clearedCount}张凭证回收至 platform_pool, 操作者: ${operatorName}`);
    return { success: true, clearedCount };
  }

  /**
   * 从平台标准库存（platform_pool）中取合适面额的凭证给指定账户找零
   * 用于发放奖励时，奖池中只有大额凭证而需找回差额的场景
   */
  private giveChangeToAccount(targetHolderId: string, amount: number, note: string): void {
    const poolVouchers = voucherService.getUserVouchers('platform_pool')
      .filter(v => v.status === VoucherStatus.ACTIVE)
      .sort((a, b) => b.denomination - a.denomination);

    let remaining = amount;
    for (const v of poolVouchers) {
      if (remaining <= 0) break;
      if (v.denomination <= remaining) {
        voucherService.transferVoucher(
          { voucherId: v.id, toUserId: targetHolderId, toUserName: targetHolderId, note },
          'platform_pool',
          '奖池系统'
        );
        remaining -= v.denomination;
      }
    }

    if (remaining > 0) {
      console.warn(`[PlatformBindingService] 找零不足，还差 ${remaining}，平台标准库存可能不够`);
    }
  }
}

// 导出单例
export const platformBindingService = PlatformBindingService.getInstance();
