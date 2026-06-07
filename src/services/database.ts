// S4-3 修复：定义具体接口替换 any 类型
interface Achievement {
  id: string;
  name: string;
  description: string;
  icon: string;
  progress: number;
  maxProgress: number;
  unlockedAt?: Date;
}

interface GameRecord {
  id: string;
  userId: string;
  gameId: string;
  gameName: string;
  score: number;
  computingPowerEarned: number;
  gameCoinsEarned: number;
  completedAt: Date;
}

interface UserProfile {
  id: string;
  username: string;
  email: string;
  joinedAt: Date;
  lastActiveAt: Date;
}

interface ComputingPowerStats {
  totalComputingPower: number;
  todayEarned: number;
  weeklyEarned: number;
  monthlyEarned: number;
  totalGamesPlayed: number;
  averageScore: number;
  bestScore: number;
  currentRank: number;
  nextRankThreshold: number;
  earnings?: ReturnType<DatabaseService['calculateEarnings']>;
}

// 模拟数据库服务 - 在实际项目中可以替换为真实的数据库连接
class DatabaseService {
  private storageKey = 'computing_power_data';
  private currentUserId = 'user_001'; // 模拟当前用户ID
  
  // 获取用户数据
  private getUserData(userId: string = this.currentUserId) {
    const data = localStorage.getItem(`${this.storageKey}_${userId}`);
    return data ? JSON.parse(data) : this.getDefaultUserData(userId);
  }
  
  // 保存用户数据
  private saveUserData(userId: string = this.currentUserId, data: any) {
    localStorage.setItem(`${this.storageKey}_${userId}`, JSON.stringify(data));
  }
  
  // 获取默认用户数据
  private getDefaultUserData(userId: string) {
    return {
      user: {
        id: userId,
        username: `Player_${userId.slice(-4)}`,
        email: `${userId}@example.com`,
        joinedAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString()
      },
      stats: {
        totalComputingPower: 0,
        todayEarned: 0,
        weeklyEarned: 0,
        monthlyEarned: 0,
        totalGamesPlayed: 0,
        averageScore: 0,
        bestScore: 0,
        currentRank: 1,
        nextRankThreshold: 1000
      },
      gameRecords: [],
      achievements: this.getDefaultAchievements()
    };
  }
  
  // 获取默认成就
  private getDefaultAchievements(): Achievement[] {
    return [
      {
        id: 'first_game',
        name: '初次体验',
        description: '完成第一场游戏',
        icon: 'fa-solid fa-play',
        progress: 0,
        maxProgress: 1
      },
      {
        id: 'score_master',
        name: '得分大师',
        description: '单局得分超过5000分',
        icon: 'fa-solid fa-star',
        progress: 0,
        maxProgress: 1
      },
      {
        id: 'game_veteran',
        name: '游戏老手',
        description: '完成10场游戏',
        icon: 'fa-solid fa-trophy',
        progress: 0,
        maxProgress: 10
      },
      {
        id: 'computing_collector',
        name: '算力收集者',
        description: '累计获得1000算力',
        icon: 'fa-solid fa-coins',
        progress: 0,
        maxProgress: 1000
      }
    ];
  }
  
  // 添加游戏记录
  async addGameRecord(record: Omit<GameRecord, 'id' | 'completedAt'>): Promise<void> {
    const userData = this.getUserData();
    
    const newRecord: GameRecord = {
      id: `game_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      ...record,
      completedAt: new Date()
    };
    
    // 添加游戏记录
    userData.gameRecords.unshift(newRecord);
    
    // 更新统计数据
    userData.stats.totalComputingPower += record.computingPowerEarned;
    userData.stats.todayEarned += record.computingPowerEarned;
    userData.stats.weeklyEarned += record.computingPowerEarned;
    userData.stats.monthlyEarned += record.computingPowerEarned;
    userData.stats.totalGamesPlayed += 1;
    userData.stats.bestScore = Math.max(userData.stats.bestScore, record.score);
    userData.stats.averageScore = Math.round(
      userData.gameRecords.reduce((sum: number, game: any) => sum + game.score, 0) / userData.gameRecords.length
    );
    
    // 更新等级
    userData.stats.currentRank = Math.floor(userData.stats.totalComputingPower / 1000) + 1;
    userData.stats.nextRankThreshold = userData.stats.currentRank * 1000;
    
    // 检查成就
    this.checkAchievements(userData, newRecord);
    
    // 更新最后活跃时间
    userData.user.lastActiveAt = new Date().toISOString();
    
    // 保存数据
    this.saveUserData(this.currentUserId, userData);
    
    console.log('游戏记录已保存:', newRecord);
  }
  
  // 检查成就
  private checkAchievements(userData: any, newRecord: GameRecord) {
    userData.achievements.forEach((achievement: Achievement) => {
      if (achievement.unlockedAt) return; // 已解锁的成就跳过
      
      switch (achievement.id) {
        case 'first_game':
          if (userData.stats.totalGamesPlayed >= 1) {
            achievement.unlockedAt = new Date();
            achievement.progress = 1;
          }
          break;
          
        case 'score_master':
          if (newRecord.score >= 5000) {
            achievement.unlockedAt = new Date();
            achievement.progress = 1;
          }
          break;
          
        case 'game_veteran':
          achievement.progress = userData.stats.totalGamesPlayed;
          if (userData.stats.totalGamesPlayed >= 10) {
            achievement.unlockedAt = new Date();
          }
          break;
          
        case 'computing_collector':
          achievement.progress = userData.stats.totalComputingPower;
          if (userData.stats.totalComputingPower >= 1000) {
            achievement.unlockedAt = new Date();
          }
          break;
      }
    });
  }
  
  // 获取用户算力数据
  async getUserComputingData(): Promise<{
    user: UserProfile;
    stats: ComputingPowerStats;
    recentGames: GameRecord[];
    achievements: Achievement[];
  }> {
    const userData = this.getUserData();
    
    // 计算收益分配
    const earnings = this.calculateEarnings(userData.stats.totalComputingPower);
    
    // 转换日期字符串为Date对象
    const user: UserProfile = {
      ...userData.user,
      joinedAt: new Date(userData.user.joinedAt),
      lastActiveAt: new Date(userData.user.lastActiveAt)
    };
    
    const recentGames: GameRecord[] = userData.gameRecords.slice(0, 5).map((game: any) => ({
      ...game,
      completedAt: new Date(game.completedAt)
    }));
    
    const achievements: Achievement[] = userData.achievements.map((achievement: any) => ({
      ...achievement,
      unlockedAt: achievement.unlockedAt ? new Date(achievement.unlockedAt) : undefined
    }));
    
    return {
      user,
      stats: {
        ...userData.stats,
        earnings // 添加收益数据
      },
      recentGames,
      achievements
    };
  }
  
  // 获取游戏历史
  async getGameHistory(limit: number = 50): Promise<GameRecord[]> {
    const userData = this.getUserData();
    return userData.gameRecords.slice(0, limit).map((game: any) => ({
      ...game,
      completedAt: new Date(game.completedAt)
    }));
  }
  
  // 获取全网算力统计
  getNetworkStats() {
    const totalNetworkPower = 50000000; // 全网总算力 5000万
    const dailyReward = 100000; // 每日总奖励 10万
    return { totalNetworkPower, dailyReward };
  }

  // 计算收益分配
  calculateEarnings(userPower: number) {
    const { totalNetworkPower, dailyReward } = this.getNetworkStats();
    const userRatio = userPower / totalNetworkPower;
    const dailyEarning = dailyReward * userRatio;
    const hourlyEarning = dailyEarning / 24;
    
    return {
      userRatio: userRatio * 100, // 转换为百分比
      dailyEarning: Math.round(dailyEarning * 100) / 100,
      hourlyEarning: Math.round(hourlyEarning * 100) / 100,
      monthlyEarning: Math.round(dailyEarning * 30 * 100) / 100
    };
  }

  // 获取排行榜
  async getLeaderboard(): Promise<Array<{
    rank: number;
    username: string;
    totalComputingPower: number;
  }>> {
    // 模拟排行榜数据
    const userData = this.getUserData();
    const mockLeaderboard = [
      { username: userData.user.username, totalComputingPower: userData.stats.totalComputingPower },
      { username: 'AliceGamer', totalComputingPower: 15420 },
      { username: 'BobMaster', totalComputingPower: 12350 },
      { username: 'CharlieAce', totalComputingPower: 9870 },
      { username: 'DianaQueen', totalComputingPower: 8650 },
      { username: 'EvanKing', totalComputingPower: 7430 },
      { username: 'FionaWiz', totalComputingPower: 6210 },
      { username: 'GeorgeHero', totalComputingPower: 5890 },
      { username: 'HelenStar', totalComputingPower: 4670 },
      { username: 'IvanChamp', totalComputingPower: 3450 }
    ];
    
    // 按算力排序
    mockLeaderboard.sort((a, b) => b.totalComputingPower - a.totalComputingPower);
    
    // 添加排名
    return mockLeaderboard.map((player, index) => ({
      ...player,
      rank: index + 1
    }));
  }
  
  // 清除所有数据（用于测试）
  async clearAllData(): Promise<void> {
    localStorage.removeItem(`${this.storageKey}_${this.currentUserId}`);
  }
}

// 导出单例实例
export const databaseService = new DatabaseService();