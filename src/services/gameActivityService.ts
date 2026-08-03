// S4-3 修复：定义具体接口替换 any 类型
interface GameActivityData {
  userId: string;
  sessionId: string;
  gameId: string;
  gameName: string;
  startTime: Date;
  endTime: Date;
  duration: number;
  score: number;
  level: number;
  achievements: string[];
  computingPowerEarned: number;
  gameCoinsEarned: number;
  activityType: string;
}

interface PlayerActivityStats {
  userId: string;
  totalPlayTime: number;
  totalSessions: number;
  averageSessionTime: number;
  totalScore: number;
  averageScore: number;
  achievementCount: number;
  consecutiveDays: number;
  socialInteractions: number;
  tasksCompleted: number;
  lastActiveDate: Date;
  activityLevel: 'low' | 'medium' | 'high' | 'very_high';
}

// 已废弃类型 — 保留引用兼容（MVP v1.0: computing types removed）
type ComputingPowerBreakdown = Record<string, unknown>;
type NetworkActivityData = Record<string, unknown>;

class GameActivityService {
  private activities: GameActivityData[] = [];
  private playerStats: Map<string, PlayerActivityStats> = new Map();
  
  constructor() {
    this.initializeMockData();
  }

  // 初始化模拟数据
  private initializeMockData(): void {
    const mockActivities: GameActivityData[] = [
      {
        userId: 'user_001',
        sessionId: 'session_001',
        gameId: 'match3',
        gameName: '消消乐',
        startTime: new Date(Date.now() - 3600000),
        endTime: new Date(Date.now() - 3000000),
        duration: 600,
        score: 1250,
        level: 5,
        achievements: ['first_win', 'combo_master'],
        computingPowerEarned: 85,
        gameCoinsEarned: 120,
        activityType: 'game_play'
      },
      {
        userId: 'user_002',
        sessionId: 'session_002',
        gameId: 'memory',
        gameName: '记忆翻牌',
        startTime: new Date(Date.now() - 7200000),
        endTime: new Date(Date.now() - 6600000),
        duration: 600,
        score: 980,
        level: 3,
        achievements: ['memory_master'],
        computingPowerEarned: 65,
        gameCoinsEarned: 90,
        activityType: 'game_play'
      }
    ];

    this.activities = mockActivities;
    this.updatePlayerStats();
  }

  // 记录游戏活动
  async recordGameActivity(activity: Omit<GameActivityData, 'sessionId'>): Promise<GameActivityData> {
    const sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const fullActivity: GameActivityData = {
      ...activity,
      sessionId
    };

    this.activities.push(fullActivity);
    this.updatePlayerStats();
    
    // 同步更新钱包中的算力和游戏币
    try {
      // MVP v1.0: walletService removed, wallet sync disabled
    } catch (error) {
      console.warn('同步钱包数据失败:', error);
    }
    
    console.log('记录游戏活动:', fullActivity);
    return fullActivity;
  }

  // 记录玩家登录
  async recordDailyLogin(userId: string): Promise<void> {
    const loginActivity: GameActivityData = {
      userId,
      sessionId: `login_${Date.now()}`,
      gameId: 'system',
      gameName: '每日登录',
      startTime: new Date(),
      duration: 0,
      score: 0,
      level: 0,
      achievements: [],
      computingPowerEarned: 10, // 登录奖励10算力
      gameCoinsEarned: 5,
      activityType: 'daily_login',
      endTime: new Date()
    };

    await this.recordGameActivity(loginActivity);
  }

  // 记录社交互动
  async recordSocialInteraction(userId: string, _interactionType: string): Promise<void> {
    const socialActivity: GameActivityData = {
      userId,
      sessionId: `social_${Date.now()}`,
      gameId: 'social',
      gameName: '社交互动',
      startTime: new Date(),
      duration: 0,
      score: 0,
      level: 0,
      achievements: [],
      computingPowerEarned: 5, // 社交互动奖励5算力
      gameCoinsEarned: 3,
      activityType: 'social_interaction',
      endTime: new Date()
    };

    await this.recordGameActivity(socialActivity);
  }

  // 记录任务完成
  async recordTaskCompletion(userId: string, taskName: string, reward: number): Promise<void> {
    const taskActivity: GameActivityData = {
      userId,
      sessionId: `task_${Date.now()}`,
      gameId: 'system',
      gameName: `任务完成: ${taskName}`,
      startTime: new Date(),
      duration: 0,
      score: 0,
      level: 0,
      achievements: [],
      computingPowerEarned: reward,
      gameCoinsEarned: Math.floor(reward * 0.5),
      activityType: 'task_completion',
      endTime: new Date()
    };

    await this.recordGameActivity(taskActivity);
  }

  // 更新玩家统计数据
  private updatePlayerStats(): void {
    const playerActivities = new Map<string, GameActivityData[]>();
    
    // 按用户分组活动数据
    this.activities.forEach(activity => {
      if (!playerActivities.has(activity.userId)) {
        playerActivities.set(activity.userId, []);
      }
      playerActivities.get(activity.userId)!.push(activity);
    });

    // 计算每个玩家的统计数据
    playerActivities.forEach((activities, userId) => {
      const gameActivities = activities.filter(a => a.activityType === 'game_play');
      const totalPlayTime = gameActivities.reduce((sum, a) => sum + a.duration, 0) / 60; // 转换为分钟
      const totalSessions = gameActivities.length;
      const totalScore = gameActivities.reduce((sum, a) => sum + a.score, 0);
      const achievementCount = new Set(gameActivities.flatMap(a => a.achievements)).size;
      const socialInteractions = activities.filter(a => a.activityType === 'social_interaction').length;
      const tasksCompleted = activities.filter(a => a.activityType === 'task_completion').length;
      
      // 计算连续登录天数（简化实现）
      const loginDates = activities
        .filter(a => a.activityType === 'daily_login')
        .map(a => a.startTime.toDateString());
      const uniqueLoginDates = new Set(loginDates);
      const consecutiveDays = uniqueLoginDates.size;

      // 计算活跃度等级
      const activityScore = totalPlayTime + totalSessions * 2 + achievementCount * 5 + socialInteractions * 3;
      let activityLevel: 'low' | 'medium' | 'high' | 'very_high';
      if (activityScore < 50) activityLevel = 'low';
      else if (activityScore < 150) activityLevel = 'medium';
      else if (activityScore < 300) activityLevel = 'high';
      else activityLevel = 'very_high';

      const stats: PlayerActivityStats = {
        userId,
        totalPlayTime,
        totalSessions,
        averageSessionTime: totalSessions > 0 ? totalPlayTime / totalSessions : 0,
        totalScore,
        averageScore: totalSessions > 0 ? totalScore / totalSessions : 0,
        achievementCount,
        consecutiveDays,
        socialInteractions,
        tasksCompleted,
        lastActiveDate: new Date(Math.max(...activities.map(a => a.startTime.getTime()))),
        activityLevel
      };

      this.playerStats.set(userId, stats);
    });
  }

  // 计算玩家算力分解
  async getPlayerComputingPowerBreakdown(userId: string): Promise<ComputingPowerBreakdown> {
    const stats = this.playerStats.get(userId);
    if (!stats) {
      return {
        baseActivity: 0,
        gamePerformance: 0,
        socialContribution: 0,
        loyaltyBonus: 0,
        achievementBonus: 0,
        economicContribution: 0,
        total: 0
      };
    }

    // 基础活动算力（基于游戏时长和场次）
    const baseActivity = Math.floor(stats.totalPlayTime * 0.5 + stats.totalSessions * 2);
    
    // 游戏表现算力（基于分数和等级）
    const gamePerformance = Math.floor(stats.averageScore * 0.1 + stats.totalScore * 0.01);
    
    // 社交贡献算力
    const socialContribution = stats.socialInteractions * 5;
    
    // 忠诚度奖励算力（基于连续登录天数）
    const loyaltyBonus = stats.consecutiveDays * 10;
    
    // 成就奖励算力
    const achievementBonus = stats.achievementCount * 15;
    
    // 经济贡献算力（从其他服务获取，这里简化处理）
    const economicContribution = 50; // 简化实现
    
    const total = baseActivity + gamePerformance + socialContribution + loyaltyBonus + achievementBonus + economicContribution;

    return {
      baseActivity,
      gamePerformance,
      socialContribution,
      loyaltyBonus,
      achievementBonus,
      economicContribution,
      total
    };
  }

  // 获取玩家活动统计
  async getPlayerStats(userId: string): Promise<PlayerActivityStats | null> {
    return this.playerStats.get(userId) || null;
  }

  // 获取全网活动数据
  async getNetworkActivityData(): Promise<NetworkActivityData> {
    try {
      // MVP v1.0: mock data removed, returning empty defaults
      return {
        totalActivePlayers: 0, totalTransactions: 0, totalVolume: 0,
        averageSessionTime: 0, topGames: [], timestamp: Date.now()
      } as any;
    } catch (error) {
      console.error('获取全网活动数据失败:', error);
      
      // 如果模拟数据导入失败，使用基础计算方法
      const allStats = Array.from(this.playerStats.values());
      
      const totalActivePlayers = allStats.length || 5; // 至少显示5个活跃玩家
      const totalGameSessions = allStats.reduce((sum, stats) => sum + stats.totalSessions, 0) || 25;
      const totalPlayTime = allStats.reduce((sum, stats) => sum + stats.totalPlayTime, 0) || 120;
      const averagePlayerLevel = 3.5; // 默认平均等级
      
      // 生成默认顶级玩家
      const topPerformers = Array(5).fill(0).map((_, i) => ({
        userId: `user_00${i+1}`,
        username: `玩家00${i+1}`,
        computingPower: 100 - i * 10,
        activityScore: 1000 - i * 100
      }));
      
      // 生成默认游戏热度
      const gamePopularity = [
        {
          gameId: 'match3',
          gameName: '消消乐',
          playerCount: 15,
          totalSessions: 45,
          averageScore: 850
        },
        {
          gameId: 'memory',
          gameName: '记忆翻牌',
          playerCount: 12,
          totalSessions: 36,
          averageScore: 720
        },
        {
          gameId: 'puzzle',
          gameName: '益智拼图',
          playerCount: 8,
          totalSessions: 24,
          averageScore: 650
        }
      ];
      
      return {
        totalActivePlayers,
        totalGameSessions,
        totalPlayTime,
        averagePlayerLevel,
        topPerformers,
        gamePopularity
      };
    }
  }

  // 获取玩家最近活动
  async getPlayerRecentActivities(userId: string, limit: number = 20): Promise<GameActivityData[]> {
    return this.activities
      .filter(activity => activity.userId === userId)
      .sort((a, b) => b.startTime.getTime() - a.startTime.getTime())
      .slice(0, limit);
  }

  // 获取全网最近活动
  async getRecentActivities(limit: number = 50): Promise<GameActivityData[]> {
    return this.activities
      .sort((a, b) => b.startTime.getTime() - a.startTime.getTime())
      .slice(0, limit);
  }
}

// 导出服务实例
export const gameActivityService = new GameActivityService();

// 导出类型
export type { 
  GameActivityData, 
  PlayerActivityStats, 
  ComputingPowerBreakdown, 
  NetworkActivityData 
};
