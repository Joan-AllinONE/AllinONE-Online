/**
 * 道具工坊（Item Workshop）— OpenGames UGC 玩家创作入口
 *
 * 四步流程：
 * 1. 选择目标游戏 → 展示游戏能力范围（SOP）
 * 2. AI 对话输入 → 描述你想创造的道具
 * 3. 预览生成结果 → 审查/调整属性
 * 4. 发布方式：直接铸造 / 提案上架
 */

import React, { useState, useEffect, useContext } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Link } from 'react-router-dom';
import {
  Hammer, ArrowLeft, Gamepad2, CheckCircle, Loader2,
  Coins, Vote, Rocket, Package, Info, AlertTriangle,
  ExternalLink, Shield, ChevronRight, Sparkles,
} from 'lucide-react';
import { getPublishedGames, type PublishedGame } from '@/services/publishedGameService';
import { voucherItemService } from '@/services/voucherItemService';
import { ugcBridgeService, type UGCBridgeResult } from '@/services/ugcBridgeService';
import { ItemSupplyPolicy } from '@/voucher-system/types';
import type { ItemVoucherTemplate } from '@/voucher-system/types';
import { AuthContext } from '@/contexts/authContext';
import AIDialog from '@/components/ugc/AIDialog';
import ItemPreviewCard from '@/components/ugc/ItemPreviewCard';
import { schemaRegistry } from '@/publishing-center/protocol/SchemaRegistry';

// ==================== 类型定义 ====================

type WorkshopStep = 'select-game' | 'ai-create' | 'publish';

// ==================== 常量 ====================

const STEPS = [
  { key: 'select-game' as WorkshopStep, label: '选择游戏', icon: Gamepad2 },
  { key: 'ai-create' as WorkshopStep, label: '创造道具', icon: Sparkles },
  { key: 'publish' as WorkshopStep, label: '发布', icon: Rocket },
];

// ==================== 组件 ====================

const ItemWorkshop: React.FC = () => {
  const { currentUser } = useContext(AuthContext);

  // 游戏列表
  const [games, setGames] = useState<PublishedGame[]>([]);
  const [selectedGame, setSelectedGame] = useState<PublishedGame | null>(null);
  const [loadingGames, setLoadingGames] = useState(true);

  // 工作流状态
  const [step, setStep] = useState<WorkshopStep>('select-game');
  const [ugcResult, setUgcResult] = useState<UGCBridgeResult | null>(null);

  // 发布状态
  const [publishing, setPublishing] = useState(false);
  const [publishMethod, setPublishMethod] = useState<'direct' | 'proposal'>('direct');
  const [publishResult, setPublishResult] = useState<{ success: boolean; message: string } | null>(null);
  const [mintedVoucherId, setMintedVoucherId] = useState<string | null>(null);

  // 铸造参数（可编辑）
  const [mintCount, setMintCount] = useState(3);
  const [itemPrice, setItemPrice] = useState<number | ''>('');

  // 游戏能力声明
  const [gameCapabilities, setGameCapabilities] = useState<Array<{
    name: string; description: string; aiGuide?: any;
  }>>([]);

  // 用户信息
  const userId = currentUser?.id || `guest-${Date.now()}`;
  const userName = currentUser?.username || '访客玩家';

  // 加载游戏列表
  useEffect(() => {
    try {
      const publishedGames = getPublishedGames();
      setGames(publishedGames);
    } catch (e) {
      console.warn('加载游戏列表失败:', e);
    }
    setLoadingGames(false);
  }, []);

  // 选择游戏后加载能力声明
  const handleSelectGame = (game: PublishedGame) => {
    setSelectedGame(game);

    // 🆕 如果游戏自带 SOP，动态注册到 SchemaRegistry
    if (game.itemSop) {
      ugcBridgeService.registerGameSop(game.id, game.itemSop);
    }

    // 如果工坊上传了独立 SOP 文档，覆写 schema 的 rawMarkdown（不影响 itemSop 的 JSON 字段）
    if (game.sopDocument) {
      const schemas = ugcBridgeService.getAvailableSchemas(game.id);
      const target = schemas[0];
      if (target) {
        if (!target.aiGuide) (target as any).aiGuide = {};
        target.aiGuide!.rawMarkdown = game.sopDocument;
      }
    }

    const capabilities = ugcBridgeService.getAvailableSchemas(game.id);
    setGameCapabilities(capabilities);
    setStep('ai-create');
    setUgcResult(null);
    setPublishResult(null);
  };

  // AI 生成完成
  // 进入游戏创建页面时初始化价格
  const handleUGCRsult = (result: UGCBridgeResult) => {
    setUgcResult(result);
    setItemPrice(result.template?.pricing?.price ?? 10);
    setMintCount(3);
  };

  // 进入发布阶段
  const handleProceedToPublish = () => {
    setStep('publish');
  };

  // 返回 AI 创建阶段
  const handleBackToCreate = () => {
    setStep('ai-create');
    setUgcResult(null);
    setPublishResult(null);
    setMintedVoucherId(null);
    setMintCount(3);
  };

  // 返回选择游戏
  const handleBackToGames = () => {
    setStep('select-game');
    setSelectedGame(null);
    setUgcResult(null);
    setPublishResult(null);
    setGameCapabilities([]);
    setMintedVoucherId(null);
    setMintCount(3);
  };

  // 直接铸造
  const handleDirectMint = async () => {
    if (!ugcResult?.template || !selectedGame) return;

    setPublishing(true);
    setPublishResult(null);

    try {
      const template = ugcResult.template;

      // 应用用户编辑的价格
      if (itemPrice !== '' && Number(itemPrice) > 0) {
        const newPrice = Number(itemPrice);
        template.pricing = {
          ...template.pricing,
          price: newPrice,
          voucherPrice: newPrice,
        };
        // 持久化价格变更到 localStorage
        voucherItemService.updateItemTemplate(template.id, { pricing: template.pricing });
      }

      // 铸造凭证
      const mintResult = voucherItemService.mintItemVouchers({
        gameId: template.gameId,
        templateId: template.id,
        count: mintCount,
        recipientId: userId,
        recipientName: userName,
      });

      if (mintResult.success) {
        setPublishResult({
          success: true,
          message: `「${template.name}」已创建并铸造 ${mintResult.vouchers.length} 张凭证！\n你可以在游戏中使用，或到凭证系统中查看。`,
        });
        // 保存铸造结果中的第一张凭证 ID，用于"去游戏使用"
        if (mintResult.vouchers.length > 0) {
          setMintedVoucherId(mintResult.vouchers[0].id);
        }
      } else {
        setPublishResult({ success: false, message: mintResult.message });
      }
    } catch (e) {
      setPublishResult({
        success: false,
        message: e instanceof Error ? e.message : '发布失败',
      });
    } finally {
      setPublishing(false);
    }
  };

  // 提案上架
  const handleProposal = async () => {
    if (!ugcResult?.template || !selectedGame) return;

    setPublishing(true);
    setPublishResult(null);

    try {
      const template = ugcResult.template;

      const proposal = voucherItemService.proposeNewItem({
        gameId: template.gameId,
        gameName: template.gameName || selectedGame.name,
        template: {
          gameId: template.gameId,
          name: template.name,
          description: template.description,
          itemType: template.itemType,
          supplyPolicy: template.supplyPolicy,
          pricing: template.pricing,
          gameEffect: template.gameEffect,
          rarity: template.rarity,
          consumable: template.consumable ?? true,
          stackable: template.stackable ?? true,
          isActive: true,
          createdBy: userId,
        },
        proposerId: userId,
        proposerName: userName,
        proposerType: 'player_community' as any,
        reason: `玩家 ${userName} 通过道具工坊创造的道具`,
        voteDurationHours: 48,
      });

      setPublishResult({
        success: true,
        message: `提案已创建！「${template.name}」正在等待社区投票（48小时）。通过后将自动上架。`,
      });
    } catch (e) {
      setPublishResult({
        success: false,
        message: e instanceof Error ? e.message : '提案创建失败',
      });
    } finally {
      setPublishing(false);
    }
  };

  // ==================== 渲染 ====================

  return (
    <div className="min-h-screen bg-[#0F0F23]">
      <div className="max-w-4xl mx-auto px-4 py-8">
        {/* 顶部导航 */}
        <div className="flex items-center justify-between mb-8">
          <Link
            to="/voucher-system?tab=item-vouchers"
            className="flex items-center gap-2 text-slate-400 hover:text-slate-300 transition-colors cursor-pointer"
          >
            <ArrowLeft className="w-4 h-4" />
            <span className="text-sm">道具凭证管理</span>
          </Link>
          <h1 className="text-xl font-bold text-slate-100 flex items-center gap-2">
            <Hammer className="w-5 h-5 text-[#7C3AED]" />
            道具工坊
          </h1>
        </div>

        {/* 步骤指示器 */}
        <div className="flex items-center justify-center gap-2 mb-10">
          {STEPS.map((s, i) => {
            const isActive = step === s.key;
            const isPast = STEPS.findIndex(x => x.key === step) > i;
            const Icon = s.icon;
            return (
              <React.Fragment key={s.key}>
                {i > 0 && (
                  <div className={`w-8 h-0.5 ${isPast ? 'bg-[#7C3AED]' : 'bg-slate-700'}`} />
                )}
                <div className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-all duration-200
                  ${isActive ? 'bg-[#7C3AED]/15 text-[#7C3AED] border border-[#7C3AED]/30' :
                    isPast ? 'bg-[#7C3AED]/5 text-violet-300/70' : 'bg-slate-800/50 text-slate-500'}`}>
                  <Icon className="w-4 h-4" />
                  <span className="hidden sm:inline">{s.label}</span>
                </div>
              </React.Fragment>
            );
          })}
        </div>

        {/* Step 1: 选择游戏 */}
        <AnimatePresence mode="wait">
          {step === 'select-game' && (
            <motion.div
              key="select-game"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -12 }}
            >
              <div className="text-center mb-8">
                <h2 className="text-2xl font-bold text-slate-100 mb-2">选择目标游戏</h2>
                <p className="text-slate-500 max-w-md mx-auto">
                  选择一个已发布的游戏，查看它支持的创造能力，然后开始创造你的道具。
                </p>
              </div>

              {loadingGames ? (
                <div className="flex justify-center py-16">
                  <Loader2 className="w-8 h-8 animate-spin text-[#7C3AED]" />
                </div>
              ) : games.length === 0 ? (
                <div className="text-center py-16">
                  <Package className="w-12 h-12 text-slate-600 mx-auto mb-4" />
                  <p className="text-slate-500">暂无可用游戏</p>
                  <p className="text-xs text-slate-600 mt-1">需要先在发布中心发布游戏</p>
                </div>
              ) : (
                <div className="grid gap-4 sm:grid-cols-2">
                  {games.map((game) => {
                    const capabilities = ugcBridgeService.getAvailableSchemas(game.id);
                    return (
                      <button
                        key={game.id}
                        onClick={() => handleSelectGame(game)}
                        className="text-left p-5 bg-slate-800/40 border border-slate-700/50 rounded-xl
                                   hover:border-[#7C3AED]/30 hover:bg-slate-800/60 transition-all duration-200
                                   cursor-pointer group"
                      >
                        <div className="flex items-start gap-3">
                          <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-[#7C3AED]/10 text-[#7C3AED]">
                            <Gamepad2 className="w-5 h-5" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <h3 className="text-slate-100 font-medium truncate group-hover:text-[#7C3AED] transition-colors">
                              {game.name}
                            </h3>
                            <p className="text-xs text-slate-500 mt-0.5 line-clamp-1">{game.description}</p>
                            {capabilities.length > 0 && (
                              <div className="flex flex-wrap gap-1.5 mt-2">
                                {capabilities.map((cap) => (
                                  <span key={cap.name} className="px-2 py-0.5 bg-slate-700/30 border border-slate-600/30 rounded text-xs text-slate-400">
                                    {cap.name}
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                          <ChevronRight className="w-4 h-4 text-slate-600 group-hover:text-[#7C3AED] transition-colors flex-shrink-0 mt-1" />
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </motion.div>
          )}

          {/* Step 2: AI 创造 */}
          {step === 'ai-create' && selectedGame && (
            <motion.div
              key="ai-create"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -12 }}
            >
              {/* 游戏能力展示 */}
              {gameCapabilities.length > 0 && (
                <motion.div 
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="mb-8 p-4 bg-slate-800/30 border border-slate-700/30 rounded-xl"
                >
                  <h3 className="text-sm font-medium text-slate-300 flex items-center gap-2 mb-3">
                    <Shield className="w-4 h-4 text-[#7C3AED]" />
                    {selectedGame.name} 的创作规则
                  </h3>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {gameCapabilities.map((cap) => {
                      const guide = cap.aiGuide;
                      const isMatch3 = cap.name === 'match3-powerup';
                      return (
                        <div key={cap.name} className="p-3 bg-slate-800/20 rounded-lg border border-slate-700/20">
                          <div className="flex items-center gap-2 mb-1.5">
                            <span className="px-2 py-0.5 bg-[#7C3AED]/15 text-[#7C3AED] border border-[#7C3AED]/20 rounded text-xs font-medium">
                              {cap.name}
                            </span>
                            <span className="text-xs text-slate-400">{cap.description}</span>
                          </div>
                          {guide && (
                            <div className="text-xs text-slate-500 space-y-0.5">
                              {guide.availableEffects && guide.availableEffects.length > 0 && (
                                <span className="block">
                                  可用效果：{guide.availableEffects.length} 种
                                  {isMatch3 && (
                                    <span className="text-violet-400/80 ml-1">
                                      ({guide.availableEffects.slice(0, 4).join('、')}{guide.availableEffects.length > 4 ? '...' : ''})
                                    </span>
                                  )}
                                </span>
                              )}
                              {guide.constraints?.maxCellsPerEffect && (
                                <span className="block">单次消除上限：{guide.constraints.maxCellsPerEffect} 格</span>
                              )}
                              {guide.constraints?.maxTimeAdd && (
                                <span className="block">加时上限：{guide.constraints.maxTimeAdd} 秒</span>
                              )}
                              {guide.constraints?.maxMovesAdd && (
                                <span className="block">加步上限：{guide.constraints.maxMovesAdd} 步</span>
                              )}
                              {guide.constraints?.damageRange && (
                                <span className="block">伤害范围：{guide.constraints.damageRange[0]} ~ {guide.constraints.damageRange[1]}</span>
                              )}
                              {guide.constraints?.maxEffectsPerItem && (
                                <span className="block">最多特效：{guide.constraints.maxEffectsPerItem}个</span>
                              )}
                              {guide.constraints?.validElements && (
                                <span className="block">可用元素：{guide.constraints.validElements.join(' / ')}</span>
                              )}
                              {guide.constraints?.validColors && (
                                <span className="block">可用颜色：{guide.constraints.validColors.join(' / ')}</span>
                              )}
                              {guide.forbidden && guide.forbidden.length > 0 && (
                                <span className="block text-rose-400/70">
                                  禁止：{guide.forbidden[0]}{guide.forbidden.length > 1 ? ` 等${guide.forbidden.length}条规则` : ''}
                                </span>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </motion.div>
              )}

              {/* 提示信息 */}
              {gameCapabilities.length === 0 && (
                <div className="mb-6 p-4 bg-amber-500/10 border border-amber-500/20 rounded-xl flex items-start gap-3">
                  <AlertTriangle className="w-5 h-5 text-amber-400 flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="text-sm text-amber-300">此游戏暂未声明创作规则（SOP）</p>
                    <p className="text-xs text-amber-400/70 mt-1">
                      将使用通用规则生成道具。建议游戏开发者补充 SOP 以获得最佳效果。
                    </p>
                  </div>
                </div>
              )}

              {/* AI 对话输入 */}
              <AIDialog
                gameId={selectedGame.id}
                gameName={selectedGame.name}
                userId={userId}
                userName={userName}
                onResult={handleUGCRsult}
              />

              {/* 预览区域 */}
              <AnimatePresence>
                {ugcResult?.success && (
                  <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -20 }}
                    className="mt-8 space-y-4"
                  >
                    <ItemPreviewCard
                      result={ugcResult}
                      onEdit={handleBackToCreate}
                    />

                    {/* 进入发布 */}
                    <div className="flex justify-center">
                      <button
                        onClick={handleProceedToPublish}
                        className="flex items-center gap-2 px-6 py-3 bg-[#7C3AED] hover:bg-[#6D28D9]
                                   text-white font-medium rounded-xl text-sm
                                   shadow-lg shadow-[#7C3AED]/25 transition-all duration-200 cursor-pointer"
                      >
                        继续发布
                        <Rocket className="w-4 h-4" />
                      </button>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* 返回按钮 */}
              <div className="mt-6 text-center">
                <button
                  onClick={handleBackToGames}
                  className="text-xs text-slate-500 hover:text-slate-400 transition-colors cursor-pointer"
                >
                  ← 选择其他游戏
                </button>
              </div>
            </motion.div>
          )}

          {/* Step 3: 发布 */}
          {step === 'publish' && ugcResult?.success && (
            <motion.div
              key="publish"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -12 }}
              className="max-w-lg mx-auto"
            >
              <div className="text-center mb-8">
                <h2 className="text-2xl font-bold text-slate-100 mb-2">发布道具</h2>
                <p className="text-slate-500">
                  选择一种方式让「{ugcResult.template?.name || '未命名'}」进入游戏世界
                </p>
              </div>

              {/* 预览摘要 */}
              <div className="mb-6">
                <ItemPreviewCard result={ugcResult} />
              </div>

              {/* 可编辑参数 */}
              {!publishResult && (
                <div className="mb-6 p-4 bg-slate-800/50 border border-slate-700/50 rounded-xl space-y-4">
                  <h3 className="text-sm font-medium text-slate-300">铸造参数</h3>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs text-slate-500 mb-1">道具价格（ACOIN）</label>
                      <input
                        type="number"
                        min={1}
                        value={itemPrice}
                        onChange={e => setItemPrice(e.target.value === '' ? '' : Math.max(1, Number(e.target.value)))}
                        className="w-full px-3 py-2 bg-slate-700/50 border border-slate-600 rounded-lg text-sm text-white focus:outline-none focus:border-[#7C3AED]"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-slate-500 mb-1">铸造数量（最大 5）</label>
                      <input
                        type="number"
                        min={1}
                        max={5}
                        value={mintCount}
                        onChange={e => setMintCount(Math.min(5, Math.max(1, Number(e.target.value) || 1)))}
                        className="w-full px-3 py-2 bg-slate-700/50 border border-slate-600 rounded-lg text-sm text-white focus:outline-none focus:border-[#7C3AED]"
                      />
                    </div>
                  </div>
                  <p className="text-xs text-slate-600">
                    💰 总价：{(Number(itemPrice) || 0) * mintCount} ACOIN（单价 {itemPrice || 0} × {mintCount} 张）
                  </p>
                </div>
              )}

              {/* 发布方式选择 */}
              {!publishResult && (
                <div className="space-y-3">
                  {/* 直接铸造 */}
                  <button
                    onClick={() => setPublishMethod('direct')}
                    className={`w-full text-left p-4 rounded-xl border transition-all duration-200 cursor-pointer
                      ${publishMethod === 'direct'
                        ? 'border-[#7C3AED]/40 bg-[#7C3AED]/10'
                        : 'border-slate-700/50 bg-slate-800/30 hover:border-slate-600/50'}`}
                  >
                    <div className="flex items-start gap-3">
                      <Coins className={`w-5 h-5 flex-shrink-0 mt-0.5 ${publishMethod === 'direct' ? 'text-[#7C3AED]' : 'text-slate-500'}`} />
                      <div>
                        <span className="text-sm font-medium text-slate-200">直接铸造</span>
                        <p className="text-xs text-slate-500 mt-1">
                          立即铸造道具凭证，可在凭证系统中查看和兑换到游戏
                        </p>
                      </div>
                    </div>
                  </button>

                  {/* 提案上架 */}
                  <button
                    onClick={() => setPublishMethod('proposal')}
                    className={`w-full text-left p-4 rounded-xl border transition-all duration-200 cursor-pointer
                      ${publishMethod === 'proposal'
                        ? 'border-[#7C3AED]/40 bg-[#7C3AED]/10'
                        : 'border-slate-700/50 bg-slate-800/30 hover:border-slate-600/50'}`}
                  >
                    <div className="flex items-start gap-3">
                      <Vote className={`w-5 h-5 flex-shrink-0 mt-0.5 ${publishMethod === 'proposal' ? 'text-[#7C3AED]' : 'text-slate-500'}`} />
                      <div>
                        <span className="text-sm font-medium text-slate-200">提案上架</span>
                        <p className="text-xs text-slate-500 mt-1">
                          提交社区投票（48小时），通过后自动上架到游戏商店
                        </p>
                      </div>
                    </div>
                  </button>

                  {/* 发布按钮 */}
                  <button
                    onClick={publishMethod === 'direct' ? handleDirectMint : handleProposal}
                    disabled={publishing}
                    className="w-full flex items-center justify-center gap-2 py-3 bg-[#F43F5E] hover:bg-[#E11D48]
                               text-white font-medium rounded-xl text-sm
                               disabled:opacity-50 disabled:cursor-not-allowed
                               shadow-lg shadow-[#F43F5E]/20 transition-all duration-200 cursor-pointer mt-6"
                  >
                    {publishing ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        发布中...
                      </>
                    ) : (
                      <>
                        <Rocket className="w-4 h-4" />
                        {publishMethod === 'direct' ? '立即铸造' : '提交提案'}
                      </>
                    )}
                  </button>
                </div>
              )}

              {/* 发布结果 */}
              <AnimatePresence>
                {publishResult && (
                  <motion.div
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    className={`mt-6 p-5 rounded-xl border ${
                      publishResult.success
                        ? 'bg-emerald-500/10 border-emerald-500/20'
                        : 'bg-rose-500/10 border-rose-500/20'
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      <CheckCircle className={`w-5 h-5 flex-shrink-0 mt-0.5 ${publishResult.success ? 'text-emerald-400' : 'text-rose-400'}`} />
                      <div>
                        <p className={`text-sm ${publishResult.success ? 'text-emerald-300' : 'text-rose-300'}`}>
                          {publishResult.success ? '发布成功！' : '发布失败'}
                        </p>
                        <p className="text-xs text-slate-500 mt-1 whitespace-pre-line">{publishResult.message}</p>
                      </div>
                    </div>

                    {publishResult.success && (
                      <div className="flex gap-3 mt-4">
                        {mintedVoucherId && selectedGame && (
                          <Link
                            to={`/game/${selectedGame.id}?itemVoucher=${mintedVoucherId}`}
                            className="flex items-center gap-1.5 px-3 py-1.5 bg-gradient-to-r from-emerald-500/20 to-cyan-500/20 border border-emerald-500/25
                                       text-emerald-300 rounded-lg text-xs hover:from-emerald-500/30 hover:to-cyan-500/30 transition-colors cursor-pointer font-medium"
                          >
                            <Gamepad2 className="w-3 h-3" />
                            去游戏中使用
                          </Link>
                        )}
                        <Link
                          to={`/game-store/${selectedGame?.id}`}
                          className="flex items-center gap-1.5 px-3 py-1.5 bg-cyan-500/15 border border-cyan-500/25
                                     text-cyan-300 rounded-lg text-xs hover:bg-cyan-500/20 transition-colors cursor-pointer"
                        >
                          <ExternalLink className="w-3 h-3" />
                          游戏商店
                        </Link>
                        <Link
                          to="/voucher-system?tab=item-vouchers"
                          className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-500/15 border border-emerald-500/25
                                     text-emerald-300 rounded-lg text-xs hover:bg-emerald-500/20 transition-colors cursor-pointer"
                        >
                          <ExternalLink className="w-3 h-3" />
                          查看凭证
                        </Link>
                        <button
                          onClick={handleBackToCreate}
                          className="flex items-center gap-1.5 px-3 py-1.5 bg-[#7C3AED]/15 border border-[#7C3AED]/25
                                     text-violet-300 rounded-lg text-xs hover:bg-[#7C3AED]/20 transition-colors cursor-pointer"
                        >
                          <Sparkles className="w-3 h-3" />
                          创造下一个
                        </button>
                      </div>
                    )}
                  </motion.div>
                )}
              </AnimatePresence>

              {/* 返回 */}
              <div className="mt-6 text-center">
                <button
                  onClick={handleBackToCreate}
                  className="text-xs text-slate-500 hover:text-slate-400 transition-colors cursor-pointer"
                >
                  ← 返回 AI 创建
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* 底部信息 */}
        <div className="mt-16 text-center">
          <p className="text-xs text-slate-600">
            道具工坊支持两种创作模式：AI 对话（内置分析）和粘贴 JSON（外部 AI 生成）。
            <br />
            所有道具均需通过游戏方公开的 SOP 校验后方可发布。
          </p>
        </div>
      </div>
    </div>
  );
};

export default ItemWorkshop;
