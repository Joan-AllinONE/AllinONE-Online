/**
 * 游戏游玩页面
 * 显示游戏详情并嵌入游戏
 */

import { useState, useEffect, useCallback, useContext, useRef } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { getPublishedGame, getSelfContainedGameHtml, getCloudHostedGameHtml, type PublishedGame } from '@/services/publishedGameService';
import { skillGateway } from '@/skills';
import { globalEventBus } from '@/skills/EventBus';
import { platformBindingService, GameType, voucherService } from '@/voucher-system';
import { isCurrencyVoucher } from '@/voucher-system/types';
import { AuthContext } from '@/contexts/authContext';
import { redeemCodeService } from '@/services/redeemCodeService';
import { track } from '@/services/analytics';
import { Coins, X, AlertCircle, ShieldCheck } from 'lucide-react';
import { ProtocolEngine, schemaRegistry } from '@/publishing-center/protocol';

interface GameSkill {
  id: string;
  name: string;
  icon: string;
  description: string;
  enabled: boolean;
}

export default function GamePlay() {
  const { gameId } = useParams<{ gameId: string }>();
  const [searchParams] = useSearchParams();
  const { currentUser } = useContext(AuthContext);
  const [game, setGame] = useState<PublishedGame | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [skills, setSkills] = useState<GameSkill[]>([]);
  const [balance, setBalance] = useState<Record<string, number>>({});
  const [voucherBalance, setVoucherBalance] = useState<{ count: number; totalValue: number }>({ count: 0, totalValue: 0 });
  const [gameHtmlContent, setGameHtmlContent] = useState<string | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  
  // 奖励提示状态
  const [rewardToast, setRewardToast] = useState<{
    show: boolean;
    success: boolean;
    message: string;
    amount?: number;
  }>({ show: false, success: false, message: '' });

  // 会话开始时间戳（用于计算在线时长）
  const sessionStartRef = useRef<number>(0);

  useEffect(() => {
    if (!gameId) return;

    // 加载游戏信息
    const publishedGame = getPublishedGame(gameId);
    if (publishedGame) {
      // 模块化多文件游戏（RequireJS/AMD/动态 import）必须用真实 URL 渲染，
      // 否则 srcDoc 内联时运行时子资源（XHR 拉模块）解析到父页 → 404 白屏。
      // 这里强制构造服务端托管 URL，由 Service Worker 从 IndexedDB 本地缓存 / 后端 提供文件，
      // 因此即使发布记录为 inline（当时后端不可用）也能正常加载，无需重新发布。
      const effectiveGame =
        publishedGame.isModular
          ? {
              ...publishedGame,
              hostingType: 'server' as const,
              cdnUrl: `/api/v1/games/${gameId}/files/${publishedGame.entryPoint || 'index.html'}`,
            }
          : publishedGame;

      setGame(effectiveGame);
      setRenderError(null);

      // 📊 数据中心埋点：游戏启动 + 会话开始
      sessionStartRef.current = Date.now();
      const uid = currentUser?.uid || currentUser?.id || 'anonymous';
      track({ type: 'game_launch', userId: uid, gameId });
      track({ type: 'session_start', userId: uid, gameId });

      // 根据托管方式加载游戏内容
      (async () => {
        // 外部 URL 模式：直接通过 CDN/外部 URL 加载
        if (effectiveGame.hostingType === 'external' && effectiveGame.cdnUrl) {
          console.log('[GamePlay] 外部 URL 模式，将通过 src 加载:', effectiveGame.cdnUrl);
          return;
        }

        // 服务端托管模式：直接通过真实 URL iframe 加载（多文件模块化游戏的正确渲染方式）
        // Service Worker 会拦截该 URL：后端优先，失败回放 IndexedDB 本地文件
        if (effectiveGame.hostingType === 'server' && effectiveGame.cdnUrl) {
          console.log('[GamePlay] 服务端托管模式（SW 提供文件），将通过真实 URL 加载:', effectiveGame.cdnUrl);
          return;
        }

        // ① 云托管模式（优先）：从 CloudBase 云存储加载，URL 重写为永久公开链接
        // 子资源由浏览器直接从云存储 CDN 按需加载，零鉴权
        const cloudHtml = await getCloudHostedGameHtml(gameId);
        if (cloudHtml) {
          setGameHtmlContent(cloudHtml);
          console.log('[GamePlay] 云托管模式（URL 重写），HTML 大小:', cloudHtml.length, '字节');
          return;
        }

        // ② 回退：自包含内联模式（本地缓存 / 文档 entryHtmlContent）
        const entryContent = await getSelfContainedGameHtml(gameId);
        if (entryContent) {
          setGameHtmlContent(entryContent);
          console.log('[GamePlay] 自包含内联模式（回退），大小:', entryContent.length, '字节');
        } else {
          console.log('[GamePlay] 云托管与本地均无内容');
        }
      })();

      // 加载游戏启用的Skills
      const enabledSkills: GameSkill[] = [
        { id: 'wallet', name: '钱包系统', icon: 'fa-wallet', description: '游戏币管理', enabled: publishedGame.skills?.includes('wallet') },
        { id: 'inventory', name: '道具系统', icon: 'fa-box', description: '道具管理', enabled: publishedGame.skills?.includes('inventory') },
        { id: 'store', name: '商店系统', icon: 'fa-store', description: '游戏内购买', enabled: publishedGame.skills?.includes('store') },
        { id: 'achievements', name: '成就系统', icon: 'fa-trophy', description: '成就追踪', enabled: publishedGame.skills?.includes('achievements') },
      ];
      setSkills(enabledSkills);

      // 加载余额
      loadBalance();
      loadVoucherBalance();
    }
    setIsLoading(false);
  }, [gameId]);

  // 📊 数据中心埋点：会话结束（离开页面/切换游戏时上报在线时长）
  useEffect(() => {
    return () => {
      if (sessionStartRef.current && gameId) {
        const uid = currentUser?.uid || currentUser?.id || 'anonymous';
        track({
          type: 'session_end',
          userId: uid,
          gameId,
          payload: { durationMs: Date.now() - sessionStartRef.current },
        });
      }
    };
  }, [gameId, currentUser]);

  const loadBalance = async () => {
    try {
      const result = await skillGateway.execute('wallet', 'getBalance', {}, {
        userId: currentUser?.uid || currentUser?.id || 'anonymous',
        sessionId: 'web',
      });
      if (result.success && result.data) {
        const raw = result.data as any;
        const walletData = raw?.data ?? raw;
        setBalance({
          gameCoins: walletData.gameCoins || 0,
        });
      }
    } catch (error) {
      console.error('加载余额失败:', error);
    }
  };

  // 加载凭证余额
  const loadVoucherBalance = () => {
    if (!currentUser?.id) return;
    
    try {
      const vouchers = voucherService.getUserVouchers(currentUser.id);
      const activeVouchers = vouchers.filter(
        v => v.status === 'active' && isCurrencyVoucher((v as any).sourceType)
      );
      const totalValue = activeVouchers.reduce((sum, v) => sum + v.denomination, 0);
      setVoucherBalance({
        count: activeVouchers.length,
        totalValue,
      });
    } catch (error) {
      console.error('加载凭证余额失败:', error);
    }
  };

  const handleFullscreen = useCallback(() => {
    const iframe = document.getElementById('game-iframe') as HTMLIFrameElement;
    if (iframe) {
      if (iframe.requestFullscreen) {
        iframe.requestFullscreen();
      }
    }
  }, []);

  // 显示奖励提示
  const showRewardToast = (success: boolean, message: string, amount?: number) => {
    setRewardToast({ show: true, success, message, amount });
    setTimeout(() => {
      setRewardToast(prev => ({ ...prev, show: false }));
    }, 4000);
  };

  // 触发游戏奖励
  const triggerGameReward = useCallback(async (eventType: string, eventData?: Record<string, any>) => {
    if (!currentUser?.id || !gameId) {
      console.log('[GamePlay] 用户未登录或游戏ID不存在，跳过奖励发放');
      return;
    }

    try {
      // 查找该游戏的活跃绑定配置
      const bindings = platformBindingService.getActiveBindingsForGame(gameId);
      
      if (bindings.length === 0) {
        console.log(`[GamePlay] 游戏 ${gameId} 没有配置奖励规则`);
        return;
      }

      console.log(`[GamePlay] 为游戏 ${gameId} 触发奖励，找到 ${bindings.length} 个绑定配置`);

      // 依次处理每个绑定配置
      for (const binding of bindings) {
        const result = await platformBindingService.distributeSimpleReward(
          binding.id,
          currentUser.id,
          currentUser.username || '玩家',
          {
            event: eventType,
            gameId,
            gameType: GameType.PUBLISHED,
            timestamp: Date.now(),
            ...eventData,
          }
        );

        if (result.success && result.record) {
          showRewardToast(true, `获得 ${result.record.amount} 凭证奖励！`, result.record.amount);
          loadVoucherBalance(); // 刷新凭证余额
          // 通知外部钱包组件刷新
          window.dispatchEvent(new CustomEvent('wallet-updated', { detail: { userId: currentUser.id } }));
          console.log(`[GamePlay] 奖励发放成功:`, result.record);
        } else if (result.error) {
          // 只在特定情况下显示错误（如冷却中）
          if (result.error.includes('冷却') || result.error.includes('上限')) {
            console.log(`[GamePlay] 奖励未发放: ${result.error}`);
          }
        }
      }
    } catch (error) {
      console.error('[GamePlay] 触发奖励失败:', error);
    }
  }, [currentUser, gameId]);

  // ===== AllinONE Protocol Engine =====
  const protocolRef = useRef<ProtocolEngine | null>(null);

  useEffect(() => {
    if (!gameId) return;

    // 创建 ProtocolEngine 实例，挂载兑换回调
    const engine = new ProtocolEngine({
      debug: false,
      skillGateway: skillGateway as any,
      authContextProvider: async () => ({
        userId: currentUser?.id || 'anonymous',
        sessionId: crypto.randomUUID(),
        source: 'gameplay',
      }),
      onRedeem: async (code: string, redeemGameId: string) => {
        if (!currentUser?.id) {
          return { success: false, message: '用户未登录' };
        }

        const targetGameId = redeemGameId || gameId;
        if (!targetGameId) {
          return { success: false, message: '游戏ID无效' };
        }

        try {
          const verifyResult = await redeemCodeService.verifyCode({
            code,
            gameId: targetGameId,
            userId: currentUser.id,
          });

          if (!verifyResult.valid) {
            // 增强错误提示
            let errorMessage = verifyResult.message || '兑换码无效';
            if (errorMessage === '兑换码不存在') {
              errorMessage = '兑换码无效，请检查是否输入正确';
            } else if (errorMessage === '兑换码已被使用') {
              errorMessage = '该兑换码已被使用';
            } else if (errorMessage === '兑换码已过期') {
              errorMessage = '该兑换码已过期';
            } else if (errorMessage === '兑换码已禁用') {
              errorMessage = '该兑换码已被禁用';
            }
            return {
              success: false,
              message: errorMessage,
            };
          }

          const useResult = await redeemCodeService.useCode({
            code,
            gameId: targetGameId,
            userId: currentUser.id,
          });

          if (!useResult.success) {
            return {
              success: false,
              message: useResult.message || '兑换码使用失败',
            };
          }

          const item = useResult.item;
          const gameEffect = item?.gameEffect as Record<string, any> | undefined;

          // effectType: 优先读一等字段，回退到 metadata.effectType
          const effectType = gameEffect?.effectType || (gameEffect?.metadata?.effectType as string) || 'custom';

          // effects: 提取效果参数（排除元数据字段），传给 Effect Engine
          const rawMetadata = (gameEffect?.metadata || {}) as Record<string, any>;
          const { rarity, supplyPolicy, effectType: _et, ...effectParams } = rawMetadata;

          showRewardToast(true, `兑换成功! 获得 ${item?.name || '道具'}`);

          // ⚠️ 不再单独发送 EXTENSION_VOUCHER（避免与 REDEEM_RESULT 重复导致用户收到2个道具）
          // Schema 道具数据通过 REDEEM_RESULT.voucherData 单一通道传递
          // voucherItemService.redeemItemVoucherBySchema 的 URL 参数路径仍使用 EXTENSION_VOUCHER（独立通道，不经过 onRedeem）

          // realEffectName: 真实效果名（如 heal/invincible），优先 itemData.effect → itemId
          // → 非 custom 的 effectType；最终回落 'custom'。
          // ⚠️ 不能用 effectType 直接填 effect：effectType 默认 'custom'，
          // 会导致游戏侧 EFFECT_HANDLERS['custom'] 不存在 → 「未找到效果: custom」。
          const realEffectName =
            (gameEffect?.itemData as Record<string, any> | undefined)?.effect ||
            gameEffect?.itemId ||
            (effectType !== 'custom' ? effectType : '') ||
            'custom';

          return {
            success: true,
            code,
            itemId: gameEffect?.itemId || '',
            itemName: item?.name || '道具',
            quantity: gameEffect?.quantity || 1,
            effectType,
            effects: effectParams,
            // 🆕 voucherData: 携带完整的 itemData（effect/effectCode/effectScript/params/icon）
            // 游戏端 SDK/桥接通过 REDEEM_RESULT → CustomEvent → handleRedeemedItem 接收
            // voucherData: 优先用 itemData；缺失时合成 effect 填真实效果名（realEffectName），
            // 保证游戏侧 EFFECT_HANDLERS[realEffectName] 可命中（而非 'custom'）。
            voucherData: gameEffect?.itemData
              ? { ...(gameEffect.itemData as Record<string, any>), effect: realEffectName }
              : {
                  effect: realEffectName,
                  params: effectParams,
                  itemId: gameEffect?.itemId,
                  effectType,
                },
            schemaName: gameEffect?.schemaName || null,
            message: `兑换成功! 获得 ${item?.name || '道具'}`,
          };
        } catch (error) {
          return {
            success: false,
            message: error instanceof Error ? error.message : '兑换失败',
          };
        }
      },
    });

    // 启动协议监听
    engine.startListening();

    // 监听协议游戏事件 → 触发奖励
    engine.on('game:event', ({ event, data }: { event: string; data: any }) => {
      if (['GAME_COMPLETE', 'GAME_WIN', 'LEVEL_COMPLETE', 'ACHIEVEMENT_UNLOCK', 'SCORE_MILESTONE'].includes(event)) {
        triggerGameReward(event.replace('GAME_', ''), data);
        try { globalEventBus.emit('game.played', { gameId, event }, { userId: 'anonymous', sessionId: 'web' }); } catch { /* ignore */ }
      }
    });

    protocolRef.current = engine;

    return () => {
      engine.stopListening();
      engine.destroy();
      protocolRef.current = null;
    };
  }, [gameId, currentUser, triggerGameReward]);

  // iframe 加载完成后建立协议通道
  useEffect(() => {
    // 判断是否有任何可加载的游戏内容
    const hasExternalHosting = game?.hostingType === 'external' && !!game?.cdnUrl;
    if (!gameId || !gameHtmlContent && !game?.cdnUrl && !hasExternalHosting) return;

    // 等待 DOM 渲染完成找到 iframe
    const timer = setTimeout(() => {
      const iframe = document.getElementById('game-iframe') as HTMLIFrameElement;
      if (iframe && protocolRef.current && gameId) {
        // 使用游戏发布时保存的协议模式，默认 inject
        const channelMode = (game as any)?.protocolMode === 'integrated' ? 'integrated' : 'inject';
        protocolRef.current.establishChannel(gameId, iframe, {
          mode: channelMode,
          skills: skills.filter(s => s.enabled).map(s => s.id),
        });
        console.log('[GamePlay] 协议通道已建立:', gameId, 'mode:', channelMode);
      }
    }, 1000);

    return () => clearTimeout(timer);
  }, [gameId, gameHtmlContent, game?.cdnUrl, game?.hostingType, skills]);

  // 🆕 URL 参数自动下发：检测 itemVoucher / redeemVoucher 参数，轮询等待通道就绪后自动下发
  useEffect(() => {
    const pendingVoucherId = searchParams.get('itemVoucher') || searchParams.get('redeemVoucher');
    if (!pendingVoucherId || !gameId || !currentUser?.id) return;

    let cancelled = false;
    let attempts = 0;
    const MAX_ATTEMPTS = 30; // 500ms × 30 = 15s

    const tryDispatch = () => {
      if (cancelled) return;
      attempts++;

      if (!protocolRef.current) {
        if (attempts < MAX_ATTEMPTS) {
          setTimeout(tryDispatch, 500);
        } else {
          console.warn('[GamePlay] 协议引擎未就绪，放弃自动下发');
        }
        return;
      }

      const channelState = protocolRef.current.getChannelState(gameId);
      if (!channelState || channelState.status !== 'connected') {
        if (attempts < MAX_ATTEMPTS) {
          setTimeout(tryDispatch, 500);
        } else {
          console.warn('[GamePlay] 游戏通道未就绪，放弃自动下发');
          showRewardToast(false, '游戏通道未就绪，请稍后再试');
        }
        return;
      }

      // 通道就绪，执行兑换
      import('@/services/voucherItemService').then(({ voucherItemService: vis }) => {
        if (cancelled) return;
        const result = vis.redeemItemVoucher({
          userId: currentUser.id!,
          userName: currentUser.username || '玩家',
          voucherId: pendingVoucherId,
          gameId,
        });

        if (result.success && result.dispatchedToGame) {
          showRewardToast(true, `道具「${result.gameInfo?.itemData?.name || '未知'}」已发送到游戏！`);
          console.log('[GamePlay] URL 参数自动下发成功:', pendingVoucherId);
        } else if (result.success) {
          showRewardToast(true, result.message);
          console.log('[GamePlay] URL 参数兑换成功（未下发到游戏）:', pendingVoucherId);
        } else {
          showRewardToast(false, result.message);
          console.warn('[GamePlay] URL 参数自动下发失败:', result.message);
        }
      }).catch(err => {
        console.error('[GamePlay] 加载 voucherItemService 失败:', err);
      });
    };

    // 首次延迟1s后开始轮询（等待 iframe 建立）
    const startTimer = setTimeout(tryDispatch, 1000);
    return () => {
      cancelled = true;
      clearTimeout(startTimer);
    };
  }, [gameId, searchParams, currentUser?.id, gameHtmlContent, game?.cdnUrl, game?.hostingType]);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center">
        <div className="text-center">
          <div className="w-16 h-16 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
          <p className="text-white">加载游戏中...</p>
        </div>
      </div>
    );
  }

  if (!game) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center">
        <div className="text-center">
          <i className="fa-solid fa-gamepad text-6xl text-slate-600 mb-4"></i>
          <h2 className="text-2xl font-bold text-white mb-2">游戏未找到</h2>
          <p className="text-slate-400 mb-4">该游戏可能已被删除或不存在</p>
          <Link
            to="/game-center"
            className="px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium transition-colors"
          >
            返回游戏中心
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-900 relative overflow-x-hidden">
      {/* 奖励提示 Toast */}
      <AnimatePresence>
        {rewardToast.show && (
          <motion.div
            initial={{ opacity: 0, y: -50, x: '-50%' }}
            animate={{ opacity: 1, y: 0, x: '-50%' }}
            exit={{ opacity: 0, y: -50, x: '-50%' }}
            className={`fixed top-20 sm:top-24 left-1/2 z-50 px-4 sm:px-6 py-3 sm:py-4 rounded-xl shadow-2xl flex items-center gap-3 max-w-[92vw] ${
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
                  <p className="font-bold text-sm sm:text-lg">🎉 {rewardToast.message}</p>
                  {rewardToast.amount && (
                    <p className="text-white/80 text-sm">已存入您的凭证资产</p>
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
      <header className="bg-slate-800 border-b border-slate-700">
        <div className="container mx-auto px-3 sm:px-4 py-3 sm:py-4">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 sm:gap-4 min-w-0">
              <Link
                to="/game-center"
                className="w-9 h-9 sm:w-10 sm:h-10 shrink-0 rounded-lg bg-slate-700 hover:bg-slate-600 flex items-center justify-center text-white transition-colors"
              >
                <i className="fa-solid fa-arrow-left"></i>
              </Link>
              <div className="min-w-0">
                <h1 className="text-base sm:text-xl font-bold text-white truncate">{game.name}</h1>
                <p className="text-xs sm:text-sm text-slate-400 truncate">{game.framework} · v{game.version}</p>
              </div>
            </div>

            <div className="flex items-center gap-2 sm:gap-4 shrink-0">
              {/* 余额显示 */}
              {skills.find(s => s.id === 'wallet')?.enabled && (
                <div className="flex items-center gap-1.5 sm:gap-3 bg-slate-700 rounded-lg px-2 sm:px-4 py-1.5 sm:py-2">
                  <div className="flex items-center gap-1 sm:gap-2" title="游戏币">
                    <i className="fa-solid fa-coins text-yellow-500"></i>
                    <span className="text-white font-medium text-sm sm:text-base">{balance.gameCoins || 0}</span>
                  </div>
                  <div className="w-px h-4 bg-slate-600"></div>
                  <div className="flex items-center gap-1 sm:gap-2" title="凭证余额">
                    <ShieldCheck className="w-4 h-4 text-blue-400" />
                    <span className="text-white font-medium text-sm sm:text-base">{voucherBalance.totalValue}</span>
                  </div>
                </div>
              )}

              {/* 商店按钮 */}
              {skills.find(s => s.id === 'store')?.enabled && (
                <Link
                  to={`/game-store/${gameId}`}
                  className="px-2 sm:px-4 py-1.5 sm:py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-lg font-medium transition-colors flex items-center gap-1 sm:gap-2"
                >
                  <i className="fa-solid fa-store"></i>
                  <span className="hidden sm:inline">商店</span>
                </Link>
              )}

              {/* 全屏按钮 */}
              <button
                onClick={handleFullscreen}
                className="w-9 h-9 sm:w-10 sm:h-10 shrink-0 rounded-lg bg-slate-700 hover:bg-slate-600 flex items-center justify-center text-white transition-colors"
              >
                <i className="fa-solid fa-expand"></i>
              </button>
            </div>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-6">
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
          {/* 游戏区域 */}
          <div className="lg:col-span-3">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="bg-slate-800 rounded-xl overflow-hidden border border-slate-700"
            >
                {/* 游戏嵌入区域 */}
                <div className="relative w-full bg-slate-950 h-[68dvh] lg:h-auto lg:aspect-video">
                  {/* 显式报错：模块化游戏误用内联模式 */}
                  {renderError ? (
                    <div className="absolute inset-0 flex items-center justify-center p-6">
                      <div className="text-center max-w-md">
                        <AlertCircle className="w-12 h-12 text-red-500 mx-auto mb-4" />
                        <h3 className="text-lg font-bold text-white mb-2">游戏无法以内联模式加载</h3>
                        <p className="text-slate-400 text-sm leading-relaxed">{renderError}</p>
                      </div>
                    </div>
                  ) : (game.hostingType === 'external' || game.hostingType === 'server') && game.cdnUrl ? (
                    <iframe
                      id="game-iframe"
                      src={game.cdnUrl}
                      className="w-full h-full border-0"
                      allow="fullscreen"
                      sandbox="allow-scripts allow-same-origin allow-popups"
                    ></iframe>
                  ) : gameHtmlContent ? (
                  <iframe
                    id="game-iframe"
                    srcDoc={gameHtmlContent}
                    className="w-full h-full border-0"
                    allow="fullscreen"
                    sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
                  ></iframe>
                ) : game.cdnUrl ? (
                  <iframe
                    id="game-iframe"
                    src={game.cdnUrl}
                    className="w-full h-full border-0"
                    allow="fullscreen"
                    sandbox="allow-scripts allow-same-origin allow-popups"
                  ></iframe>
                ) : (
                  <div className="absolute inset-0 flex items-center justify-center">
                    <div className="text-center">
                      <i className="fa-solid fa-gamepad text-6xl text-slate-700 mb-4"></i>
                      <p className="text-slate-500">游戏加载中...</p>
                      <p className="text-slate-600 text-sm mt-2">入口文件: {game.entryPoint || '未配置'}, 请通过 Publishing Center 重新发布</p>
                    </div>
                  </div>
                )}
              </div>

              {/* 游戏信息 */}
              <div className="p-6">
                <h2 className="text-lg font-bold text-white mb-2">游戏介绍</h2>
                <p className="text-slate-400">{game.description}</p>
                
                <div className="mt-4 flex flex-wrap gap-2">
                  <span className="px-3 py-1 bg-slate-700 text-slate-300 rounded-full text-sm">
                    <i className="fa-solid fa-file-code mr-1"></i>
                    {game.fileCount} 个文件
                  </span>
                  <span className="px-3 py-1 bg-slate-700 text-slate-300 rounded-full text-sm">
                    <i className="fa-solid fa-weight-hanging mr-1"></i>
                    {(game.size / 1024 / 1024).toFixed(2)} MB
                  </span>
                  <span className="px-3 py-1 bg-slate-700 text-slate-300 rounded-full text-sm">
                    <i className="fa-solid fa-users mr-1"></i>
                    {game.players} 人在玩
                  </span>
                </div>
              </div>
            </motion.div>
          </div>

          {/* 侧边栏 - Skills & 操作 */}
          <div className="space-y-6">
            {/* Skills 状态 */}
            <motion.div
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              className="bg-slate-800 rounded-xl p-6 border border-slate-700"
            >
              <h3 className="text-lg font-bold text-white mb-4">
                <i className="fa-solid fa-plug mr-2 text-blue-500"></i>
                游戏功能
              </h3>
              <div className="space-y-3">
                {skills.map(skill => (
                  <div
                    key={skill.id}
                    className={`flex items-center gap-3 p-3 rounded-lg ${
                      skill.enabled ? 'bg-green-500/10 border border-green-500/30' : 'bg-slate-700/50'
                    }`}
                  >
                    <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${
                      skill.enabled ? 'bg-green-500/20 text-green-400' : 'bg-slate-600 text-slate-400'
                    }`}>
                      <i className={`fa-solid ${skill.icon}`}></i>
                    </div>
                    <div className="flex-1">
                      <p className={`font-medium ${skill.enabled ? 'text-white' : 'text-slate-400'}`}>
                        {skill.name}
                      </p>
                      <p className="text-xs text-slate-500">{skill.description}</p>
                    </div>
                    {skill.enabled && (
                      <i className="fa-solid fa-check-circle text-green-500"></i>
                    )}
                  </div>
                ))}
              </div>
            </motion.div>

            {/* 快速操作 */}
            <motion.div
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.1 }}
              className="bg-slate-800 rounded-xl p-6 border border-slate-700"
            >
              <h3 className="text-lg font-bold text-white mb-4">
                <i className="fa-solid fa-bolt mr-2 text-yellow-500"></i>
                快速操作
              </h3>
              <div className="space-y-3">
                <button
                  onClick={() => loadBalance()}
                  className="w-full px-4 py-3 bg-slate-700 hover:bg-slate-600 text-white rounded-lg transition-colors flex items-center gap-3"
                >
                  <i className="fa-solid fa-rotate"></i>
                  刷新余额
                </button>
                
                <Link
                  to={`/game-store/${gameId}`}
                  className="w-full px-4 py-3 bg-purple-600 hover:bg-purple-700 text-white rounded-lg transition-colors flex items-center gap-3 justify-center"
                >
                  <i className="fa-solid fa-shopping-bag"></i>
                  进入商店
                </Link>

                <button
                  onClick={handleFullscreen}
                  className="w-full px-4 py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors flex items-center gap-3"
                >
                  <i className="fa-solid fa-expand"></i>
                  全屏游戏
                </button>
              </div>
            </motion.div>

            {/* 游戏数据 */}
            <motion.div
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.2 }}
              className="bg-slate-800 rounded-xl p-6 border border-slate-700"
            >
              <h3 className="text-lg font-bold text-white mb-4">
                <i className="fa-solid fa-chart-bar mr-2 text-green-500"></i>
                游戏数据
              </h3>
              <div className="space-y-4">
                <div className="flex justify-between">
                  <span className="text-slate-400">在线玩家</span>
                  <span className="text-white font-medium">{game.players || 0}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">框架</span>
                  <span className="text-white font-medium capitalize">{game.framework}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">版本</span>
                  <span className="text-white font-medium">{game.version}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">发布日期</span>
                  <span className="text-white font-medium">
                    {game.publishedAt ? new Date(game.publishedAt).toLocaleDateString() : '-'}
                  </span>
                </div>
              </div>
            </motion.div>
          </div>
        </div>
      </main>
    </div>
  );
}
