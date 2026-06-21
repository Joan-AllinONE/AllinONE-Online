import { PlatformParameter } from '@/types/platformManagement';
import { writeQueue } from '@/services/writeQueue';

/**
 * 平台参数配置服务
 * 提供实时的平台参数获取，与平台管理系统的投票决策结果同步
 */
class PlatformConfigService {
  private readonly STORAGE_KEY = 'platform_config';
  
  // 默认参数配置
  private readonly DEFAULT_CONFIG = {
    'a-coin-mining-weight': 0.7,
    'a-coin-staking-weight': 0.2,
    'income-platform-ratio': 0.3,
    'game-coin-to-a-coin-rate': 100, // 1个A币可兑换的游戏币数量
    'a-coin-to-game-coin-rate': 100, // A币兑换游戏币的比例
    'cash-to-game-coin-rate': 100,   // 现金兑换游戏币的比例 (1元 = 100游戏币)
    'cash-to-computing-power-rate': 10, // 现金兑换算力的比例 (1元 = 10算力)
    'game-coin-to-cash-rate': 0.01,  // 游戏币兑换现金的比例
    'computing-power-to-cash-rate': 0.1, // 算力兑换现金的比例
    
    // 🔶 O币绩效分配权重（面向未来绩效，获得期权）
    'ocoin-performance-revenue-weight': 0.3,    // 收入增加量权重
    'ocoin-performance-player-weight': 0.2,     // 玩家增加量权重
    'ocoin-performance-development-weight': 0.2, // 开发贡献权重
    'ocoin-performance-management-weight': 0.15, // 管理贡献权重
    'ocoin-performance-marketing-weight': 0.15,  // 营销贡献权重
    
    // 💰 分红权重分配（面向历史和当下绩效，获得现金）
    'dividend-performance-revenue-weight': 0.35,    // 历史收入贡献权重
    'dividend-performance-player-weight': 0.15,     // 历史玩家增长贡献权重
    'dividend-performance-development-weight': 0.2,  // 历史开发贡献权重
    'dividend-performance-management-weight': 0.15, // 历史管理贡献权重
    'dividend-performance-marketing-weight': 0.15,  // 历史营销贡献权重
    
    lastUpdated: new Date().toISOString()
  };

  constructor() {
    this.initializeConfig();
  }

  /**
   * 初始化配置
   */
  private initializeConfig(): void {
    const stored = localStorage.getItem(this.STORAGE_KEY);
    if (!stored) {
      this.saveConfig(this.DEFAULT_CONFIG);
    }
    // 异步从 CloudBase 拉取最新配置
    this.syncFromCloud();
  }

  private syncFromCloud(): void {
    import('./cloudbase').then(({ isCloudBaseReady, getCloudBaseApp }) => {
      if (!isCloudBaseReady()) return;
      // 从 saveConfig 写入的同一集合读取
      getCloudBaseApp().database().collection('platform_treasury').where({ id: 'platform_config' }).limit(1).get().then(res => {
        if (res.data.length > 0) {
          const cloudDoc = res.data[0] as any;
          // saveConfig 存储结构为 { id, config, _createdAt, _updatedAt }
          const cloudConfig = cloudDoc.config || cloudDoc;
          delete cloudConfig._id;
          delete cloudConfig._createdAt;
          delete cloudConfig._updatedAt;
          delete cloudConfig.id;
          localStorage.setItem(this.STORAGE_KEY, JSON.stringify(cloudConfig));
          console.log('[PlatformConfig] 已从 CloudBase 同步配置');
        }
      }).catch(() => {});
    }).catch(() => {});
  }

  /**
   * 获取所有配置
   */
  getConfig(): Record<string, any> {
    const stored = localStorage.getItem(this.STORAGE_KEY);
    return stored ? JSON.parse(stored) : this.DEFAULT_CONFIG;
  }

  /**
   * 获取特定参数值
   */
  getParameter(paramId: string): number {
    const config = this.getConfig();
    return config[paramId] !== undefined ? config[paramId] : this.DEFAULT_CONFIG[paramId as keyof typeof this.DEFAULT_CONFIG];
  }

  /**
   * 更新参数值（通常由平台管理系统的投票结果触发）
   */
  updateParameter(paramId: string, value: number): void {
    const config = this.getConfig();
    config[paramId] = value;
    config.lastUpdated = new Date().toISOString();
    this.saveConfig(config);
    
    // 触发参数更新事件，通知其他服务
    window.dispatchEvent(new CustomEvent('platform-config-updated', {
      detail: { paramId, value, timestamp: new Date() }
    }));
    
    console.log(`[PlatformConfig] 参数更新: ${paramId} = ${value}`);
  }

  /**
   * 批量更新参数
   */
  batchUpdateParameters(updates: Record<string, number>): void {
    const config = this.getConfig();
    Object.entries(updates).forEach(([paramId, value]) => {
      config[paramId] = value;
    });
    config.lastUpdated = new Date().toISOString();
    this.saveConfig(config);
    
    // 触发批量更新事件
    window.dispatchEvent(new CustomEvent('platform-config-batch-updated', {
      detail: { updates, timestamp: new Date() }
    }));
    
    console.log('[PlatformConfig] 批量参数更新:', updates);
  }

  /**
   * 获取兑换汇率（供钱包服务使用）
   */
  getExchangeRates(): {
    gameCoinsToRMB: number;
    computingPowerToRMB: number;
    aCoinToGameCoin: number;
    cashToGameCoin: number;
    cashToComputingPower: number;
  } {
    const config = this.getConfig();
    return {
      gameCoinsToRMB: config['game-coin-to-cash-rate'] || 0.01,
      computingPowerToRMB: config['computing-power-to-cash-rate'] || 0.1,
      aCoinToGameCoin: config['a-coin-to-game-coin-rate'] || 100,
      cashToGameCoin: config['cash-to-game-coin-rate'] || 100,
      cashToComputingPower: config['cash-to-computing-power-rate'] || 10,
    };
  }

  /**
   * 获取A币分配参数
   */
  getACoinAllocation(): {
    miningWeight: number;
    stakingWeight: number;
  } {
    const config = this.getConfig();
    return {
      miningWeight: config['a-coin-mining-weight'] || 0.7,
      stakingWeight: config['a-coin-staking-weight'] || 0.2,
    };
  }

  /**
   * 获取收入分配参数
   */
  getIncomeDistribution(): {
    platformRatio: number;
  } {
    const config = this.getConfig();
    return {
      platformRatio: config['income-platform-ratio'] || 0.3,
    };
  }

  /**
   * 🔶 获取O币绩效分配权重（面向未来绩效，奖励期权）
   */
  getOCoinPerformanceWeights(): {
    revenueWeight: number;      // 收入增加量权重
    playerWeight: number;       // 玩家增加量权重
    developmentWeight: number;  // 开发贡献权重
    managementWeight: number;   // 管理贡献权重
    marketingWeight: number;    // 营销贡献权重
  } {
    const config = this.getConfig();
    return {
      revenueWeight: config['ocoin-performance-revenue-weight'] || 0.3,
      playerWeight: config['ocoin-performance-player-weight'] || 0.2,
      developmentWeight: config['ocoin-performance-development-weight'] || 0.2,
      managementWeight: config['ocoin-performance-management-weight'] || 0.15,
      marketingWeight: config['ocoin-performance-marketing-weight'] || 0.15,
    };
  }

  /**
   * 💰 获取分红权重分配（面向历史和当下绩效，奖励现金）
   */
  getDividendPerformanceWeights(): {
    revenueWeight: number;      // 历史收入贡献权重
    playerWeight: number;       // 历史玩家增长贡献权重
    developmentWeight: number;  // 历史开发贡献权重
    managementWeight: number;   // 历史管理贡献权重
    marketingWeight: number;    // 历史营销贡献权重
  } {
    const config = this.getConfig();
    return {
      revenueWeight: config['dividend-performance-revenue-weight'] || 0.35,
      playerWeight: config['dividend-performance-player-weight'] || 0.15,
      developmentWeight: config['dividend-performance-development-weight'] || 0.2,
      managementWeight: config['dividend-performance-management-weight'] || 0.15,
      marketingWeight: config['dividend-performance-marketing-weight'] || 0.15,
    };
  }

  /**
   * 保存配置到localStorage
   */
  private saveConfig(config: Record<string, any>): void {
    localStorage.setItem(this.STORAGE_KEY, JSON.stringify(config));
    // CloudBase 双写（通过写入队列，upsert by id='platform_config'）
    writeQueue.enqueue({
      collection: 'platform_treasury',
      operation: 'upsert',
      data: { id: 'platform_config', config, _updatedAt: Date.now() },
    });
  }

  /**
   * 重置为默认配置
   */
  resetToDefaults(): void {
    this.saveConfig(this.DEFAULT_CONFIG);
    window.dispatchEvent(new CustomEvent('platform-config-reset', {
      detail: { timestamp: new Date() }
    }));
    console.log('[PlatformConfig] 配置已重置为默认值');
  }

  /**
   * 导出配置（用于备份）
   */
  exportConfig(): string {
    return JSON.stringify(this.getConfig(), null, 2);
  }

  /**
   * 导入配置（用于恢复）
   */
  importConfig(configJson: string): boolean {
    try {
      const config = JSON.parse(configJson);
      this.saveConfig(config);
      window.dispatchEvent(new CustomEvent('platform-config-imported', {
        detail: { timestamp: new Date() }
      }));
      console.log('[PlatformConfig] 配置导入成功');
      return true;
    } catch (error) {
      console.error('[PlatformConfig] 配置导入失败:', error);
      return false;
    }
  }
}

export const platformConfigService = new PlatformConfigService();
export default platformConfigService;