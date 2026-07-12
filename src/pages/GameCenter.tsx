import { useState, useCallback, useEffect, useContext } from 'react';
import { Link } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { getPublishedGames, type PublishedGame } from '@/services/publishedGameService';
import { platformBindingService, GameType, type PlatformBindingConfig } from '@/voucher-system';
import { AuthContext } from '@/contexts/authContext';
import { isCloudBaseReady } from '@/services/cloudbase';
import { writeQueue, type QueueStatus } from '@/services/writeQueue';
import { Coins, CheckCircle, AlertCircle, X, Bug, Wifi, WifiOff, Database, Activity, RefreshCw } from 'lucide-react';

interface GameCard {
  id: string;
  name: string;
  description: string;
  icon: string;
  difficulty: 'easy' | 'medium' | 'hard';
  rewards: {
    computingPower: number;
    gameCoins: number;
  };
  players: number;
  status: 'available' | 'coming-soon' | 'maintenance';
  externalUrl?: string; // 外部游戏链接
  isPublished?: boolean; // 标记是否为通过发布中心发布的游戏
}

const games: GameCard[] = [
  {
    id: 'newday',
    name: 'New Day',
    description: '冒险RPG游戏，探索新世界，收集稀有道具',
    icon: 'fa-solid fa-dragon',
    difficulty: 'medium',
    rewards: { computingPower: 80, gameCoins: 100 },
    players: 2345,
    status: 'available',
    externalUrl: 'https://yxp6y2qgnh.coze.site/' // New Day 游戏实际地址
  },
  {
    id: 'puzzle',
    name: '数字拼图',
    description: '挑战你的逻辑思维，完成拼图获得丰厚奖励',
    icon: 'fa-solid fa-puzzle-piece',
    difficulty: 'medium',
    rewards: { computingPower: 80, gameCoins: 80 },
    players: 567,
    status: 'coming-soon'
  },
  {
    id: 'memory',
    name: '记忆翻牌',
    description: '考验记忆力的翻牌游戏，记忆越好奖励越多',
    icon: 'fa-solid fa-brain',
    difficulty: 'medium',
    rewards: { computingPower: 70, gameCoins: 70 },
    players: 890,
    status: 'coming-soon'
  },
  {
    id: 'snake',
    name: '贪吃蛇',
    description: '经典贪吃蛇游戏，长度越长算力越高',
    icon: 'fa-solid fa-worm',
    difficulty: 'hard',
    rewards: { computingPower: 100, gameCoins: 100 },
    players: 456,
    status: 'available',
    externalUrl: 'https://z8sspsm3mp.coze.site/'
  },
  {
    id: 'stick-war',
    name: '火柴人保卫战',
    description: '精彩的横版策略塔防游戏，部署火柴人战士守护领地',
    icon: 'fa-solid fa-shield-halved',
    difficulty: 'medium',
    rewards: { computingPower: 100, gameCoins: 100 },
    players: 1890,
    status: 'available',
    externalUrl: 'https://42wv2rvtwg.coze.site/'
  }
];

const statusColors = {
  available: 'text-green-600 bg-green-100 dark:bg-green-900/30 dark:text-green-400',
  'coming-soon': 'text-blue-600 bg-blue-100 dark:bg-blue-900/30 dark:text-blue-400',
  maintenance: 'text-orange-600 bg-orange-100 dark:bg-orange-900/30 dark:text-orange-400'
};

const statusText = {
  available: '可游玩',
  'coming-soon': '即将上线',
  maintenance: '维护中'
};

export default function GameCenter() {
  const { currentUser } = useContext(AuthContext);
  const [publishedGames, setPublishedGames] = useState<GameCard[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  
  // ==================== 诊断面板状态 ====================
  const [showDebug, setShowDebug] = useState(false);
  const [debugInfo, setDebugInfo] = useState({
    cloudBaseReady: false,
    queueStatus: null as QueueStatus | null,
    gamesSource: 'initializing' as 'cloudbase' | 'cache' | 'indexeddb' | 'none',
    lastRefresh: '',
    refreshCount: 0,
    _fetchDone: false,
  });
  
  // 定时刷新诊断信息
  useEffect(() => {
    const updateDebugInfo = () => {
      const cbReady = isCloudBaseReady();
      const qs = writeQueue.getStatus();
      setDebugInfo(prev => ({
        ...prev,
        cloudBaseReady: cbReady,
        queueStatus: qs,
      }));
    };

    updateDebugInfo();
    const timer = setInterval(updateDebugInfo, 3000);
    return () => clearInterval(timer);
  }, []);

  // 监听存储变化时更新来源信息
  useEffect(() => {
    const onGamesUpdated = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      setDebugInfo(prev => ({
        ...prev,
        lastRefresh: new Date().toLocaleTimeString(),
        refreshCount: prev.refreshCount + 1,
        gamesSource: detail?.count !== undefined ? 'cloudbase' : prev.gamesSource,
      }));
    };
    window.addEventListener('games-list-updated', onGamesUpdated);
    return () => window.removeEventListener('games-list-updated', onGamesUpdated);
  }, []);
  
  // 奖励提示状态
  const [rewardToast, setRewardToast] = useState<{
    show: boolean;
    success: boolean;
    message: string;
    amount?: number;
  }>({ show: false, success: false, message: '' });

  // 加载已发布的游戏
  useEffect(() => {
    const loadPublishedGames = () => {
      try {
        const published = getPublishedGames();
        // 诊断：判断数据来源
        let source: 'cloudbase' | 'cache' | 'indexeddb' | 'none' = 'none';
        if (published.length > 0) {
          const hasCloudData = localStorage.getItem('allinone_published_games') !== null;
          source = hasCloudData ? 'cache' : 'indexeddb';
        }
        setDebugInfo(prev => ({
          ...prev,
          gamesSource: source,
          lastRefresh: published.length > 0 ? new Date().toLocaleTimeString() : prev.lastRefresh,
        }));

        const formattedGames: GameCard[] = published.map(pg => ({
          id: pg.id,
          name: pg.name,
          description: pg.description,
          icon: getFrameworkIcon(pg.framework),
          difficulty: 'medium',
          rewards: { computingPower: 50, gameCoins: 50 },
          players: pg.players || 0,
          status: pg.status,
          isPublished: true,
          externalUrl: pg.externalUrl,
        }));
        setPublishedGames(formattedGames);
      } catch (error) {
        console.error('加载已发布游戏失败:', error);
      } finally {
        setIsLoading(false);
      }
    };

    loadPublishedGames();
    
    // 监听同页面 JS 派发的 games-list-updated 事件（CloudBase 刷新后触发）
    const handleGameListUpdated = () => loadPublishedGames();
    window.addEventListener('games-list-updated', handleGameListUpdated);
    
    // 监听 storage 变化（跨标签页同步）
    const handleStorageChange = () => loadPublishedGames();
    window.addEventListener('storage', handleStorageChange);
    
    return () => {
      window.removeEventListener('games-list-updated', handleGameListUpdated);
      window.removeEventListener('storage', handleStorageChange);
    };
  }, []);

  // 根据框架获取图标
  const getFrameworkIcon = (framework: string): string => {
    const icons: Record<string, string> = {
      'phaser': 'fa-solid fa-gamepad',
      'three-js': 'fa-solid fa-cube',
      'unity-webgl': 'fa-brands fa-unity',
      'react': 'fa-brands fa-react',
      'vue': 'fa-brands fa-vuejs',
      'vanilla-js': 'fa-brands fa-js',
      'typescript': 'fa-brands fa-js',
      'rpg-maker': 'fa-solid fa-dragon',
      'construct': 'fa-solid fa-puzzle-piece',
    };
    return icons[framework] || 'fa-solid fa-gamepad';
  };

  // 合并内置游戏和已发布的游戏
  const allGames = [...games, ...publishedGames];

  // 所有游戏（不再按难度筛选）
  const filteredGames = allGames;

  /**
   * 生成带自动登录参数的游戏 URL
   */
  const getAutoLoginUrl = useCallback((baseUrl: string): string => {
    return baseUrl;
  }, []);

  /**
   * 显示奖励提示
   */
  const showRewardToast = (success: boolean, message: string, amount?: number) => {
    setRewardToast({ show: true, success, message, amount });
    setTimeout(() => {
      setRewardToast(prev => ({ ...prev, show: false }));
    }, 4000);
  };

  /**
   * 触发游戏奖励（外部游戏：点击即得）
   */
  const triggerGameReward = useCallback(async (gameId: string, gameName: string, gameType: GameType, extraData?: Record<string, any>) => {
    // 获取用户ID（优先 currentUser，回退到凭证系统的 guest ID / 默认 ID）
    let userId: string | null = null;
    let userName: string = '玩家';

    if (currentUser?.uid) {
      userId = currentUser.uid;
      userName = currentUser.nickname || '玩家';
    } else {
      // 使用 allinone_user 做会话恢复（AuthSkill 持久化的用户信息）
      const userStr = localStorage.getItem('allinone_user');
      
      if (userStr) {
        try {
          const user = JSON.parse(userStr);
          userId = user.uid || user.id || user.userId || user._id;
          userName = user.username || user.nickname || '玩家';
          console.log('[GameCenter] 使用 allinone_user:', { userId, userName });
        } catch {
          userId = 'user_001';
        }
      } else {
        userId = 'user_001';
        console.log('[GameCenter] 使用默认用户ID:', userId);
      }
    }

    if (!userId) {
      console.log('[GameCenter] 无法获取用户ID，跳过奖励发放');
      return;
    }

    try {
      // 查找该游戏的活跃绑定配置
      const bindings = platformBindingService.getActiveBindingsForGame(gameId);
      
      if (bindings.length === 0) {
        console.log(`[GameCenter] 游戏 ${gameName} 没有配置奖励规则`);
        showRewardToast(false, `${gameName} 暂未配置凭证奖励规则，请在凭证系统绑定`, 0);
        return;
      }

      console.log(`[GameCenter] 为游戏 ${gameName} 触发奖励，找到 ${bindings.length} 个绑定配置`);

      // 依次处理每个绑定配置
      for (const binding of bindings) {
        const result = await platformBindingService.distributeSimpleReward(
          binding.id,
          userId,
          userName,
          {
            event: 'GAME_CLICK',
            gameId,
            gameName,
            gameType,
            timestamp: Date.now(),
            ...extraData,
          }
        );

        if (result.success && result.record) {
          showRewardToast(true, `获得 ${result.record.amount} A币奖励！`, result.record.amount);
          console.log(`[GameCenter] 奖励发放成功:`, result.record);
        } else if (result.error) {
          // 显示所有错误信息给用户（配置错误、奖池余额不足等）
          showRewardToast(false, result.error, 0);
          console.log(`[GameCenter] 奖励未发放: ${result.error}`);
        }
      }
    } catch (error) {
      console.error('[GameCenter] 触发奖励失败:', error);
    }
  }, [currentUser]);

  /**
   * 处理外部游戏跳转（带自动登录和奖励）
   */
  const handleExternalGameClick = useCallback(async (game: GameCard) => {
    if (!game.externalUrl) return;

    // 先触发奖励（点击即得）
    await triggerGameReward(game.id, game.name, GameType.EXTERNAL);

    const autoLoginUrl = getAutoLoginUrl(game.externalUrl);

    // 打开新窗口
    window.open(autoLoginUrl, '_blank', 'noopener,noreferrer');
  }, [getAutoLoginUrl, triggerGameReward]);

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-slate-100 dark:from-slate-900 dark:to-slate-800 relative">
      {/* 奖励提示 Toast */}
      <AnimatePresence>
        {rewardToast.show && (
          <motion.div
            initial={{ opacity: 0, y: -50, x: '-50%' }}
            animate={{ opacity: 1, y: 0, x: '-50%' }}
            exit={{ opacity: 0, y: -50, x: '-50%' }}
            className={`fixed top-24 left-1/2 z-50 px-6 py-4 rounded-xl shadow-2xl flex items-center gap-3 ${
              rewardToast.success
                ? 'bg-gradient-to-r from-green-600 to-emerald-600 text-white'
                : 'bg-gradient-to-r from-red-600 to-orange-600 text-white'
            }`}
          >
            {rewardToast.success ? (
              <>
                <div className="w-10 h-10 rounded-full bg-white/20 flex items-center justify-center">
                  <Coins className="w-5 h-5" />
                </div>
                <div>
                  <p className="font-bold text-lg">🎉 {rewardToast.message}</p>
                  {rewardToast.amount && (
                    <p className="text-white/80 text-sm">已存入您的A币钱包</p>
                  )}
                </div>
              </>
            ) : (
              <>
                <AlertCircle className="w-6 h-6" />
                <p>{rewardToast.message}</p>
              </>
            )}
            <button
              onClick={() => setRewardToast(prev => ({ ...prev, show: false }))}
              className="ml-4 p-1 hover:bg-white/20 rounded-full transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>
      {/* Header */}
      <header className="bg-white/90 dark:bg-slate-900/90 backdrop-blur-md shadow-sm">
        <div className="container mx-auto px-4 md:px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <Link to="/" className="flex items-center gap-2">
                <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-blue-600 to-indigo-600 flex items-center justify-center">
                  <span className="text-white font-bold text-xl">A</span>
                </div>
                <span className="text-xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-blue-600 to-indigo-600">AllinONE</span>
              </Link>
              <div className="hidden md:block w-px h-6 bg-slate-300 dark:bg-slate-600"></div>
              <h1 className="hidden md:block text-lg font-semibold text-slate-700 dark:text-slate-200">游戏中心</h1>
            </div>
            
            <div className="flex items-center gap-4">
              <Link
                to="/publishing-center"
                className="px-4 py-2 text-sm font-medium text-white bg-gradient-to-r from-purple-600 to-pink-600 rounded-lg shadow-md hover:shadow-lg hover:from-purple-700 hover:to-pink-700 transition-all transform hover:-translate-y-0.5 flex items-center gap-2"
              >
                <i className="fa-solid fa-rocket"></i>
                发布游戏
              </Link>
              <div className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
                <i className="fa-solid fa-coins text-yellow-500"></i>
                <span>全网算力: <span className="font-semibold text-blue-600 dark:text-blue-400">1,234</span></span>
              </div>
              <div className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
                <i className="fa-solid fa-gem text-purple-500"></i>
                <span>全网游戏币: <span className="font-semibold text-purple-600 dark:text-purple-400">5,678</span></span>
              </div>
            </div>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 md:px-6 py-8">
        {/* Stats Section */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
          <motion.div 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-white dark:bg-slate-800 rounded-xl p-6 shadow-md"
          >
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-lg bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center">
                <i className="fa-solid fa-gamepad text-blue-600 dark:text-blue-400 text-xl"></i>
              </div>
              <div>
                <div className="text-2xl font-bold text-slate-900 dark:text-white">12</div>
                <div className="text-sm text-slate-500 dark:text-slate-400">今日游戏次数</div>
              </div>
            </div>
          </motion.div>

          <motion.div 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
            className="bg-white dark:bg-slate-800 rounded-xl p-6 shadow-md"
          >
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-lg bg-green-100 dark:bg-green-900/30 flex items-center justify-center">
                <i className="fa-solid fa-trophy text-green-600 dark:text-green-400 text-xl"></i>
              </div>
              <div>
                <div className="text-2xl font-bold text-slate-900 dark:text-white">856</div>
                <div className="text-sm text-slate-500 dark:text-slate-400">今日获得算力</div>
              </div>
            </div>
          </motion.div>

          <motion.div 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
            className="bg-white dark:bg-slate-800 rounded-xl p-6 shadow-md"
          >
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-lg bg-purple-100 dark:bg-purple-900/30 flex items-center justify-center">
                <i className="fa-solid fa-star text-purple-600 dark:text-purple-400 text-xl"></i>
              </div>
              <div>
                <div className="text-2xl font-bold text-slate-900 dark:text-white">4.8</div>
                <div className="text-sm text-slate-500 dark:text-slate-400">平均游戏评分</div>
              </div>
            </div>
          </motion.div>

          <motion.div 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3 }}
            className="bg-white dark:bg-slate-800 rounded-xl p-6 shadow-md"
          >
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-lg bg-orange-100 dark:bg-orange-900/30 flex items-center justify-center">
                <i className="fa-solid fa-fire text-orange-600 dark:text-orange-400 text-xl"></i>
              </div>
              <div>
                <div className="text-2xl font-bold text-slate-900 dark:text-white">7</div>
                <div className="text-sm text-slate-500 dark:text-slate-400">连续游戏天数</div>
              </div>
            </div>
          </motion.div>
        </div>



        {/* Games Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {filteredGames.map((game, index) => (
            <motion.div
              key={game.id}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: index * 0.1 }}
              className="bg-white dark:bg-slate-800 rounded-xl shadow-md hover:shadow-xl transition-all duration-300 overflow-hidden group"
            >
              <div className="p-6">
                <div className="flex items-start justify-between mb-4">
                  <div className="w-16 h-16 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center text-white text-2xl group-hover:scale-110 transition-transform">
                    <i className={game.icon}></i>
                  </div>
                  <div className="flex flex-col gap-2">
                    <span className={`px-2 py-1 rounded-full text-xs font-medium ${statusColors[game.status]}`}>
                      {game.status === 'coming-soon' ? statusText['coming-soon'] : statusText[game.status]}
                    </span>
                  </div>
                </div>
                
                <h3 className="text-xl font-bold text-slate-900 dark:text-white mb-2">
                  {game.name}
                </h3>
                <p className="text-slate-600 dark:text-slate-300 text-sm mb-4 line-clamp-2">
                  {game.description}
                </p>
                {game.isPublished && (
                  <span className="inline-block px-2 py-1 mb-2 text-xs font-medium text-purple-600 bg-purple-100 dark:bg-purple-900/30 dark:text-purple-400 rounded-full">
                    <i className="fa-solid fa-rocket mr-1"></i>
                    已发布游戏
                  </span>
                )}
                
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-4 text-sm text-slate-500 dark:text-slate-400">
                    <div className="flex items-center gap-1">
                      <i className="fa-solid fa-coins text-yellow-500"></i>
                      <span>{game.rewards.computingPower}</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <i className="fa-solid fa-gem text-purple-500"></i>
                      <span>{game.rewards.gameCoins}</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <i className="fa-solid fa-users"></i>
                      <span>{game.players}</span>
                    </div>
                  </div>
                </div>
                
                <div className="flex gap-2">
                  {game.status === 'available' ? (
                    <>
                      {game.isPublished ? (
                        <>
                          <Link
                            to={`/game/${game.id}`}
                            className="flex-1 bg-blue-600 hover:bg-blue-700 text-white text-center py-2 px-4 rounded-lg font-medium transition-colors"
                          >
                            游玩 ▶
                          </Link>
                          <Link
                            to={`/game-store/${game.id}`}
                            className="px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-lg transition-colors"
                            title="游戏商店"
                          >
                            <i className="fa-solid fa-store"></i>
                          </Link>
                        </>
                      ) : game.externalUrl ? (
                        <button
                          onClick={() => handleExternalGameClick(game)}
                          className="flex-1 bg-purple-600 hover:bg-purple-700 text-white text-center py-2 px-4 rounded-lg font-medium transition-colors"
                        >
                          开始游戏
                        </button>
                      ) : (
                        <Link
                          to={`/game/${game.id}`}
                          className="flex-1 bg-blue-600 hover:bg-blue-700 text-white text-center py-2 px-4 rounded-lg font-medium transition-colors"
                        >
                          开始游戏
                        </Link>
                      )}
                    </>
                  ) : (
                    <button
                      disabled
                      className="flex-1 bg-slate-300 dark:bg-slate-600 text-slate-500 dark:text-slate-400 text-center py-2 px-4 rounded-lg font-medium cursor-not-allowed"
                    >
                      {game.status === 'coming-soon' ? '敬请期待' : '维护中'}
                    </button>
                  )}
                  <button className="px-4 py-2 border border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-300 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors">
                    <i className="fa-solid fa-info-circle"></i>
                  </button>
                </div>
              </div>
            </motion.div>
          ))}
        </div>
      </main>

      {/* ==================== 诊断面板（开发/调试用） ==================== */}
      <div className="fixed bottom-4 right-4 z-50 flex flex-col items-end gap-2">
        <AnimatePresence>
          {showDebug && (
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="bg-white/95 dark:bg-slate-800/95 backdrop-blur-md rounded-xl shadow-2xl border border-slate-200 dark:border-slate-700 p-5 w-80 text-sm"
            >
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-bold text-slate-900 dark:text-white flex items-center gap-2">
                  <Activity className="w-4 h-4 text-indigo-500" />
                  系统诊断
                </h3>
                <button
                  onClick={() => setShowDebug(false)}
                  className="p-1 hover:bg-slate-100 dark:hover:bg-slate-700 rounded transition-colors"
                >
                  <X className="w-4 h-4 text-slate-400" />
                </button>
              </div>

              {/* CloudBase 状态 */}
              <div className="mb-3 p-3 rounded-lg bg-slate-50 dark:bg-slate-900/50">
                <div className="flex items-center gap-2 mb-1.5">
                  {debugInfo.cloudBaseReady ? (
                    <Wifi className="w-4 h-4 text-green-500" />
                  ) : (
                    <WifiOff className="w-4 h-4 text-red-400" />
                  )}
                  <span className="font-medium text-slate-700 dark:text-slate-200">
                    CloudBase: {debugInfo.cloudBaseReady ? '已就绪' : '未就绪'}
                  </span>
                </div>
                <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                  <Database className="w-3 h-3" />
                  <span>
                    数据来源: {
                      debugInfo.gamesSource === 'cloudbase' ? '☁️ CloudBase' :
                      debugInfo.gamesSource === 'cache' ? '💾 localStorage缓存' :
                      debugInfo.gamesSource === 'indexeddb' ? '📦 IndexedDB缓存' :
                      '❌ 无数据'
                    }
                  </span>
                </div>
                {debugInfo.lastRefresh && (
                  <div className="text-xs text-slate-400 mt-1">
                    最近刷新: {debugInfo.lastRefresh} (×{debugInfo.refreshCount})
                  </div>
                )}
              </div>

              {/* WriteQueue 状态 */}
              {debugInfo.queueStatus && (
                <div className="mb-3 p-3 rounded-lg bg-slate-50 dark:bg-slate-900/50">
                  <div className="flex items-center gap-2 mb-1.5">
                    <Activity className="w-4 h-4 text-amber-500" />
                    <span className="font-medium text-slate-700 dark:text-slate-200">
                      写入队列
                    </span>
                    {debugInfo.queueStatus.authBroken && (
                      <span className="text-xs bg-red-100 text-red-600 px-1.5 py-0.5 rounded">
                        Auth断裂
                      </span>
                    )}
                  </div>
                  <div className="grid grid-cols-3 gap-1 text-xs text-slate-500 dark:text-slate-400">
                    <span className="bg-white dark:bg-slate-800 rounded px-2 py-1 text-center">
                      ⏳ 待处理 {debugInfo.queueStatus.pending}
                    </span>
                    <span className="bg-white dark:bg-slate-800 rounded px-2 py-1 text-center">
                      ❌ 失败 {debugInfo.queueStatus.failed}
                    </span>
                    <span className="bg-white dark:bg-slate-800 rounded px-2 py-1 text-center">
                      📦 共 {debugInfo.queueStatus.total}
                    </span>
                  </div>
                  <div className="flex justify-between text-xs text-slate-400 mt-1.5">
                    <span>已完成: {debugInfo.queueStatus.totalProcessed}</span>
                    <span>累计失败: {debugInfo.queueStatus.totalFailed}</span>
                  </div>
                  {debugInfo.queueStatus.authPaused > 0 && (
                    <div className="text-xs text-amber-600 mt-1">
                      ⚠️ {debugInfo.queueStatus.authPaused} 项暂停（等待Auth恢复）
                    </div>
                  )}
                </div>
              )}

              {/* 快速操作 */}
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    writeQueue.retryAll();
                    setDebugInfo(prev => ({ ...prev, lastRefresh: new Date().toLocaleTimeString(), refreshCount: prev.refreshCount + 1 }));
                  }}
                  className="flex-1 py-1.5 px-3 text-xs bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg transition-colors flex items-center justify-center gap-1"
                >
                  <RefreshCw className="w-3 h-3" />
                  重试失败项
                </button>
                <button
                  onClick={() => {
                    // 强制从 CloudBase 刷新
                    import('@/services/publishedGameService').then(({ refreshGamesFromCloudBase }) => {
                      refreshGamesFromCloudBase().then(count => {
                        setDebugInfo(prev => ({
                          ...prev,
                          gamesSource: 'cloudbase' as const,
                          lastRefresh: new Date().toLocaleTimeString(),
                          refreshCount: prev.refreshCount + 1,
                        }));
                      });
                    });
                  }}
                  className="flex-1 py-1.5 px-3 text-xs bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg transition-colors flex items-center justify-center gap-1"
                >
                  <Database className="w-3 h-3" />
                  强制同步
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* 诊断触发按钮 */}
        <button
          onClick={() => setShowDebug(prev => !prev)}
          className={`p-2.5 rounded-full shadow-lg transition-all ${
            showDebug
              ? 'bg-indigo-600 text-white'
              : 'bg-white dark:bg-slate-800 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 border border-slate-200 dark:border-slate-700'
          }`}
          title="系统诊断"
        >
          <Bug className="w-5 h-5" />
        </button>
      </div>
    </div>
  );
}