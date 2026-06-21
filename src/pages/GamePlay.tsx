/**
 * 游戏游玩页面
 * 显示游戏详情并嵌入游戏
 */

import { useState, useEffect, useCallback, useContext, useRef } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { getPublishedGame, getSelfContainedGameHtml, loadGameFiles, type PublishedGame } from '@/services/publishedGameService';
import { skillGateway } from '@/skills';
import { platformBindingService, GameType, voucherService } from '@/voucher-system';
import { isCurrencyVoucher } from '@/voucher-system/types';
import { AuthContext } from '@/contexts/authContext';
import { redeemCodeService } from '@/services/redeemCodeService';
import { getToken } from '@/services/authTokenService';
import { Coins, X, AlertCircle, ShieldCheck } from 'lucide-react';
import { ProtocolEngine, schemaRegistry } from '@/publishing-center/protocol';

interface GameSkill {
  id: string;
  name: string;
  icon: string;
  description: string;
  enabled: boolean;
}

/**
 * 从本地 IndexedDB 重新上传游戏文件到服务端
 * 解决后端重启后内存数据丢失的问题
 */
async function reuploadGameFiles(gameId: string): Promise<boolean> {
  try {
    // 1. 从本地 IndexedDB 加载文件
    const files = await loadGameFiles(gameId);
    if (!files || files.length === 0) {
      console.warn('[GamePlay] 本地无文件可重新上传');
      return false;
    }

    // 2. 获取 JWT token
    let token = await getToken();

    if (!token) {
      console.warn('[GamePlay] 无法获取 JWT token，重新上传失败');
      return false;
    }

    // 3. 上传文件到服务端（解码 __BINARY_BASE64__ 前缀，文本文件转为 UTF-8 字符串）
    const BINARY_PREFIX = '__BINARY_BASE64__';
    const TEXT_EXTENSIONS = new Set([
      '.html', '.htm', '.css', '.js', '.mjs', '.json', '.xml', '.svg',
      '.ts', '.tsx', '.jsx', '.vue', '.svelte',
      '.md', '.txt', '.csv', '.yaml', '.yml', '.toml',
      '.scss', '.sass', '.less', '.styl', '.sh',
    ]);
    const isTextFile = (filePath: string) => {
      const ext = '.' + filePath.split('.').pop()?.toLowerCase();
      return TEXT_EXTENSIONS.has(ext);
    };

    const uploadFiles = files.map(f => {
      let content = f.content;
      // 解码 __BINARY_BASE64__ 前缀
      if (content.startsWith(BINARY_PREFIX)) {
        if (isTextFile(f.path)) {
          // 文本文件：base64 → 二进制 → UTF-8 解码
          try {
            const base64 = content.slice(BINARY_PREFIX.length);
            const binaryStr = atob(base64);
            const bytes = new Uint8Array(binaryStr.length);
            for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
            content = new TextDecoder('utf-8').decode(bytes);
          } catch {
            // 解码失败，保留原样让服务器处理
          }
        }
        // 二进制文件：保留 __BINARY_BASE64__ 前缀，服务器会正确解码
      }
      return {
        path: f.path,
        name: f.name,
        content,
        size: f.size || content?.length || 0,
      };
    });

    const resp = await fetch(`/api/v1/games/${gameId}/upload`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ files: uploadFiles }),
    });

    if (resp.ok) {
      const result = await resp.json();
      console.log('[GamePlay] 重新上传成功:', result.data?.saved, '个文件');
      return true;
    } else {
      console.warn('[GamePlay] 重新上传失败:', resp.status);
      return false;
    }
  } catch (e) {
    console.warn('[GamePlay] 重新上传异常:', e);
    return false;
  }
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
  // 服务端模式加载失败时回退到 srcDoc 模式
  const [serverUnavailable, setServerUnavailable] = useState(false);
  
  // 奖励提示状态
  const [rewardToast, setRewardToast] = useState<{
    show: boolean;
    success: boolean;
    message: string;
    amount?: number;
  }>({ show: false, success: false, message: '' });

  useEffect(() => {
    if (!gameId) return;

    // 加载游戏信息
    const publishedGame = getPublishedGame(gameId);
    if (publishedGame) {
      setGame(publishedGame);

      // 根据托管方式加载游戏内容
      (async () => {
        // 服务端托管模式：通过后端 API 提供多文件游戏
        // iframe src 指向服务端 HTML，浏览器自动从同路径加载 JS/CSS 等子资源
        if (publishedGame.hostingType === 'server' && publishedGame.baseUrl) {
          const serverUrl = `${publishedGame.baseUrl}${publishedGame.entryPoint || 'index.html'}`;
          console.log('[GamePlay] 服务端托管模式，入口:', serverUrl);

          // 预检服务端文件是否可用
          let serverOk = false;
          try {
            const resp = await fetch(serverUrl, { method: 'HEAD' });
            if (resp.ok) {
              serverOk = true;
              console.log('[GamePlay] 服务端文件可用，将通过 src 加载');
            } else if (resp.status === 404) {
              // 文件不存在，可能是后端重启导致内存数据丢失，尝试重新上传
              console.log('[GamePlay] 服务端文件 404，尝试从本地重新上传...');
              const reuploaded = await reuploadGameFiles(gameId);
              if (reuploaded) {
                serverOk = true;
                console.log('[GamePlay] 重新上传成功，将通过 src 加载');
              }
            } else {
              console.warn('[GamePlay] 服务端返回', resp.status);
            }
          } catch (e) {
            // 网络不可达，后端可能未启动
            console.warn('[GamePlay] 服务端不可达:', e);
          }

          if (!serverOk) {
            // 服务端不可用，尝试从本地加载作为回退
            console.log('[GamePlay] 服务端不可用，尝试本地 srcDoc 回退');
            const entryContent = await getSelfContainedGameHtml(gameId);
            if (entryContent) {
              setGameHtmlContent(entryContent);
              console.log('[GamePlay] 已加载本地回退内容（自包含），大小:', entryContent.length);
            }
            setServerUnavailable(true);
          }
          return;
        }
        // 外部 URL 模式：直接通过 CDN/外部 URL 加载
        if (publishedGame.hostingType === 'external' && publishedGame.cdnUrl) {
          console.log('[GamePlay] 外部 URL 模式，将通过 src 加载:', publishedGame.cdnUrl);
          return;
        }
        // inline 模式（默认 / 旧游戏）：从本地存储加载 HTML 内容，通过 srcDoc 渲染
        // 使用 getSelfContainedGameHtml 将外部 CSS/JS 内联到 HTML 中，确保 srcdoc 能正确渲染
        const entryContent = await getSelfContainedGameHtml(gameId);
        if (entryContent) {
          setGameHtmlContent(entryContent);
          console.log('[GamePlay] inline 模式，已加载自包含内容，大小:', entryContent.length, '字节');
        } else {
          console.log('[GamePlay] 本地存储中未找到游戏文件，使用 cdnUrl 回退');
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

          // 🆕 如果是 Schema 模式道具，追加发送 EXTENSION_VOUCHER 到游戏
          if (gameEffect?.schemaName && gameEffect?.itemData) {
            try {
              const { ExtensionVoucherService } = await import('@/publishing-center/protocol/ExtensionVoucher');
              const extensionVoucher = ExtensionVoucherService.create({
                schemaName: gameEffect.schemaName,
                sourceGameId: targetGameId || gameId!,
                targetGameId: targetGameId || gameId!,
                data: gameEffect.itemData,
                signature: ExtensionVoucherService.sign(gameEffect.itemData),
                expiresIn: 365 * 24 * 60 * 60 * 1000,
              });

              const engine = protocolRef.current;
              if (engine) {
                engine.sendToGame(targetGameId || gameId!, {
                  type: 'EXTENSION_VOUCHER',
                  voucher: ExtensionVoucherService.toPayload(extensionVoucher),
                  timestamp: Date.now(),
                });
                console.log('[GamePlay] Schema 道具 EXTENSION_VOUCHER 已发送:', gameEffect.schemaName);
              }
            } catch (e) {
              console.warn('[GamePlay] 发送 EXTENSION_VOUCHER 失败:', e);
            }
          }

          return {
            success: true,
            code,
            itemId: gameEffect?.itemId || '',
            itemName: item?.name || '道具',
            quantity: gameEffect?.quantity || 1,
            effectType,
            effects: effectParams,
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
    const hasServerHosting = game?.hostingType === 'server' && !!game?.baseUrl;
    const hasExternalHosting = game?.hostingType === 'external' && !!game?.cdnUrl;
    if (!gameId || !gameHtmlContent && !game?.cdnUrl && !hasServerHosting && !hasExternalHosting) return;

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
  }, [gameId, gameHtmlContent, game?.cdnUrl, game?.hostingType, game?.baseUrl, skills]);

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
  }, [gameId, searchParams, currentUser?.id, gameHtmlContent, game?.cdnUrl, game?.hostingType, game?.baseUrl]);

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
    <div className="min-h-screen bg-slate-900 relative">
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
        <div className="container mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <Link
                to="/game-center"
                className="w-10 h-10 rounded-lg bg-slate-700 hover:bg-slate-600 flex items-center justify-center text-white transition-colors"
              >
                <i className="fa-solid fa-arrow-left"></i>
              </Link>
              <div>
                <h1 className="text-xl font-bold text-white">{game.name}</h1>
                <p className="text-sm text-slate-400">{game.framework} · v{game.version}</p>
              </div>
            </div>

            <div className="flex items-center gap-4">
              {/* 余额显示 */}
              {skills.find(s => s.id === 'wallet')?.enabled && (
                <div className="flex items-center gap-3 bg-slate-700 rounded-lg px-4 py-2">
                  <div className="flex items-center gap-2" title="游戏币">
                    <i className="fa-solid fa-coins text-yellow-500"></i>
                    <span className="text-white font-medium">{balance.gameCoins || 0}</span>
                  </div>
                  <div className="w-px h-4 bg-slate-600"></div>
                  <div className="flex items-center gap-2" title="凭证余额">
                    <ShieldCheck className="w-4 h-4 text-blue-400" />
                    <span className="text-white font-medium">{voucherBalance.totalValue}</span>
                  </div>
                </div>
              )}

              {/* 商店按钮 */}
              {skills.find(s => s.id === 'store')?.enabled && (
                <Link
                  to={`/game-store/${gameId}`}
                  className="px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-lg font-medium transition-colors flex items-center gap-2"
                >
                  <i className="fa-solid fa-store"></i>
                  商店
                </Link>
              )}

              {/* 全屏按钮 */}
              <button
                onClick={handleFullscreen}
                className="w-10 h-10 rounded-lg bg-slate-700 hover:bg-slate-600 flex items-center justify-center text-white transition-colors"
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
              <div className="aspect-video bg-slate-950 relative">
                {/* 服务端托管模式：iframe src 指向后端 API，浏览器自动从同路径加载 JS/CSS 子资源 */}
                {game.hostingType === 'server' && game.baseUrl && !serverUnavailable ? (
                  <iframe
                    id="game-iframe"
                    src={`${game.baseUrl}${game.entryPoint || 'index.html'}`}
                    className="w-full h-full border-0"
                    allow="fullscreen"
                    sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
                  ></iframe>
                ) : game.hostingType === 'external' && game.cdnUrl ? (
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
