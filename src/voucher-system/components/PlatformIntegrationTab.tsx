/**
 * 平台集成 Tab 组件
 * 用于将调试好的凭证规则绑定到具体游戏
 */

import React, { useState, useEffect, useCallback, useContext } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Link2, Gamepad2, ExternalLink, Settings,
  Plus, Trash2, Edit2,
  ToggleLeft, ToggleRight, ChevronDown, ChevronUp,
  AlertCircle, CheckCircle2, Clock, BarChart3,
  Sparkles, MousePointer, Trophy, Zap, Info,
  Building2, UserCircle, Warehouse, Coins,
  Calculator, Cpu, Timer, ArrowRight, RefreshCw, FileText, DollarSign,
} from 'lucide-react';
import { platformBindingService } from '../services/PlatformBindingService';
import { userPoolService } from '../services/UserPoolService';
import { voucherRuleEngine } from '../engine/RuleEngine';
import { algorithmVoucherService } from '../services/AlgorithmVoucherService';
import { AuthContext } from '@/contexts/authContext';
import type {
  PlatformBindingConfig, CreateBindingRequest,
  GameDefinition, PoolSource,
} from '../types/platform';
import { PRESET_GAMES, TRIGGER_MODE_OPTIONS, GameType, TriggerMode } from '../types/platform';
import type { DistributionRule, RecycleRule, ExchangeRate } from '../types';
import { PLATFORM_CURRENCY_TEMPLATE } from '../templates';
import type { UserRewardPool, UserPoolOverview } from '../types/pool';
import type { AlgorithmVoucherTemplate } from '../types/algorithm';
import { PoolFundPanel } from './PoolFundPanel';

interface PlatformIntegrationTabProps {
  currentUserId: string;
  currentUsername: string;
}

const GameTypeLabels: Record<GameType, { label: string; color: string; icon: React.ReactNode }> = {
  native: { label: '平台游戏', color: 'text-green-400 bg-green-400/10', icon: <Gamepad2 className="w-4 h-4" /> },
  external: { label: '外部游戏', color: 'text-blue-400 bg-blue-400/10', icon: <ExternalLink className="w-4 h-4" /> },
  published: { label: '发布游戏', color: 'text-purple-400 bg-purple-400/10', icon: <Sparkles className="w-4 h-4" /> },
};

const TriggerModeIcons: Record<TriggerMode, React.ReactNode> = {
  on_game_complete: <Trophy className="w-4 h-4" />,
  on_click: <MousePointer className="w-4 h-4" />,
  on_achievement: <Zap className="w-4 h-4" />,
  manual: <Settings className="w-4 h-4" />,
};

export const PlatformIntegrationTab: React.FC<PlatformIntegrationTabProps> = ({
  currentUserId,
  currentUsername,
}) => {
  const { currentUser } = useContext(AuthContext);
  const [bindings, setBindings] = useState<PlatformBindingConfig[]>([]);
  const [games, setGames] = useState<GameDefinition[]>([]);
  const [rules, setRules] = useState<DistributionRule[]>([]);
  const [isCreating, setIsCreating] = useState(false);
  const [editingBinding, setEditingBinding] = useState<PlatformBindingConfig | null>(null);
  const [expandedBinding, setExpandedBinding] = useState<string | null>(null);
  const [stats, setStats] = useState({ total: 0, active: 0, distributed: 0 });

  // 奖池相关状态
  const [poolMode, setPoolMode] = useState<PoolSource>('platform');
  const [selectedPoolOwner, setSelectedPoolOwner] = useState<string>('');
  const [userPools, setUserPools] = useState<UserPoolOverview[]>([]);
  const [selectedPoolId, setSelectedPoolId] = useState<string>('');
  const [usersWithPools, setUsersWithPools] = useState<{ userId: string; userName: string; poolCount: number }[]>([]);

  // 算法模板状态
  const [algorithmTemplates, setAlgorithmTemplates] = useState<AlgorithmVoucherTemplate[]>([]);
  const [selectedAlgorithmTemplateId, setSelectedAlgorithmTemplateId] = useState<string>('');
  // 奖励来源类型：'rule' = 固定规则(原有), 'algorithm' = 算法模板
  const [sourceCategory, setSourceCategory] = useState<'rule' | 'algorithm'>('rule');

  // 奖池充值面板
  const [showPoolFundPanel, setShowPoolFundPanel] = useState(false);
  const [poolBalance, setPoolBalance] = useState({ totalAmount: 0, voucherCount: 0 });

  // 表单状态
  const [formData, setFormData] = useState<Partial<CreateBindingRequest>>({
    gameId: '',
    ruleId: '',
    triggerMode: TriggerMode.ON_GAME_COMPLETE,
    limits: {
      cooldownMinutes: 0,
      maxDaily: 9999,
      maxPerUser: 99999,
    },
  });

  // ===== 自定义规则编辑器状态 =====
  const [showRuleEditor, setShowRuleEditor] = useState(false);
  const [ruleEditor, setRuleEditor] = useState({
    type: 'game_reward' as string,
    allocationMode: 'fixed' as 'fixed' | 'tiered',
    fixedAmount: 0,        // ⚠️ 默认无金额，由用户自行填入
    tieredAmounts: [] as { minThreshold: number; maxThreshold: number; amount: number }[],
    recycleRules: [] as RecycleRule[],
    exchangeRates: [] as ExchangeRate[],
  });

  // 加载数据
  useEffect(() => {
    loadData();

    // 监听 storage 变化（跨标签页），新游戏发布后自动刷新列表
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === 'allinone_published_games') {
        loadData();
      }
    };
    // 监听同标签页内的自定义事件（同一页面发布游戏后自动刷新）
    const handleGamePublished = () => {
      loadData();
    };
    // 监听游戏列表后台刷新完成（publishedGameService 从后端拉取成功后派发）：
    // 首次打开页面时游戏列表可能仍在异步加载，刷新完成后补一次 loadData
    const handleGamesListUpdated = () => {
      loadData();
    };
    window.addEventListener('storage', handleStorageChange);
    window.addEventListener('game-published', handleGamePublished);
    window.addEventListener('games-list-updated', handleGamesListUpdated);
    return () => {
      window.removeEventListener('storage', handleStorageChange);
      window.removeEventListener('game-published', handleGamePublished);
      window.removeEventListener('games-list-updated', handleGamesListUpdated);
    };
  }, []);

  const loadData = () => {
    const allBindings = platformBindingService.getAllBindings();
    const allGames = platformBindingService.getAllGames();
    
    // 从模板中获取规则
    const templateRules = PLATFORM_CURRENCY_TEMPLATE?.presetRules?.distribution || [];
    const serviceStats = platformBindingService.getStats();

    setBindings(allBindings);
    setGames(allGames);
    setRules(templateRules.filter(r => r.type === 'game_reward'));

    // 加载算法模板
    const algTemplates = algorithmVoucherService.getTemplates();
    setAlgorithmTemplates(algTemplates);

    setStats({
      total: serviceStats.totalBindings + algTemplates.length,
      active: serviceStats.activeBindings,
      distributed: serviceStats.totalDistributions,
    });

    // 加载有奖池的用户列表
    const users = userPoolService.getUsersWithPools();
    setUsersWithPools(users);

    // 加载平台奖池余额
    const sysPool = platformBindingService.getSystemPoolBalance();
    setPoolBalance({ totalAmount: sysPool.totalAmount, voucherCount: sysPool.voucherCount });
  };

  // 加载指定用户的奖池列表
  const loadUserPools = (userId: string) => {
    if (!userId) {
      setUserPools([]);
      return;
    }
    const pools = userPoolService.getUserPoolOverviews(userId);
    setUserPools(pools.filter(p => p.status === 'active'));
  };

  // 获取选中的游戏信息
  const selectedGame = games.find(g => g.id === formData.gameId);

  // 处理创建绑定
  const handleCreate = () => {
    if (!formData.gameId) return;
    if (sourceCategory === 'rule' && !formData.ruleId) return;
    if (sourceCategory === 'algorithm' && !selectedAlgorithmTemplateId) return;

    const game = games.find(g => g.id === formData.gameId);
    if (!game) return;

    let ruleId = formData.ruleId || '';
    let ruleName = '';

    if (sourceCategory === 'rule') {
      const rule = rules.find(r => r.id === formData.ruleId);
      if (!rule) return;
      ruleName = rule.name;

      // 校验：模板已剥离金额参数，用户必须通过规则编辑器配置
      if (!showRuleEditor) {
        alert('请展开「规则配置」并设置发放金额后再创建绑定');
        return;
      }
      if (ruleEditor.allocationMode === 'fixed' && (!ruleEditor.fixedAmount || ruleEditor.fixedAmount <= 0)) {
        alert('请填写有效的固定金额（大于0）');
        return;
      }
      if (ruleEditor.allocationMode === 'tiered' && (!ruleEditor.tieredAmounts || ruleEditor.tieredAmounts.length === 0)) {
        alert('请至少添加一个分档配置');
        return;
      }
    } else {
      const tmpl = algorithmTemplates.find(t => t.id === selectedAlgorithmTemplateId);
      if (!tmpl) return;
      ruleId = tmpl.id;
      ruleName = `[算法] ${tmpl.name}`;
    }

    const request: CreateBindingRequest & {
      poolSource?: PoolSource;
      poolOwnerId?: string;
      poolId?: string;
      sourceCategory?: 'rule' | 'algorithm';
      algorithmTemplateId?: string;
      customDistributionRule?: DistributionRule;
      customRecycleRules?: RecycleRule[];
      customExchangeRates?: ExchangeRate[];
    } = {
      gameId: game.id,
      gameName: game.name,
      gameType: game.type,
      ruleId,
      ruleName,
      triggerMode: formData.triggerMode || TriggerMode.ON_GAME_COMPLETE,
      paramsOverride: formData.paramsOverride,
      limits: formData.limits || {
        cooldownMinutes: 0,
        maxDaily: 9999,
        maxPerUser: 99999,
      },
      poolSource: poolMode,
      poolOwnerId: poolMode === 'user' ? selectedPoolOwner : undefined,
      poolId: poolMode === 'user' ? selectedPoolId || undefined : undefined,
      sourceCategory,
      algorithmTemplateId: sourceCategory === 'algorithm' ? selectedAlgorithmTemplateId : undefined,
      // 传递自定义规则配置
      ...(sourceCategory === 'rule' && showRuleEditor ? {
        customDistributionRule: {
          id: `custom-${Date.now()}`,
          name: `自定义: ${ruleEditor.type}`,
          type: ruleEditor.type as any,
          enabled: true,
          priority: 1,
          trigger: { type: 'event', event: 'game_complete' },
          allocation: ruleEditor.allocationMode === 'fixed'
            ? { mode: 'fixed', fixedAmount: ruleEditor.fixedAmount }
            : { mode: 'tiered', tieredAmounts: ruleEditor.tieredAmounts },
          limits: {
            maxPerUser: formData.limits?.maxPerUser || 99999,
            dailyCap: formData.limits?.maxDaily || 9999,
            cooldownMinutes: formData.limits?.cooldownMinutes || 0,
          },
          source: {
            mode: 'transfer_from_pool',
            poolHolderId: poolMode === 'user' ? selectedPoolOwner || 'SYSTEM' : 'SYSTEM',
          },
        },
        customRecycleRules: ruleEditor.recycleRules,
        customExchangeRates: ruleEditor.exchangeRates,
      } : {}),
    };

    platformBindingService.createBinding(request, currentUserId, currentUsername);
    loadData();
    resetForm();
    setIsCreating(false);
  };

  // 处理更新绑定
  const handleUpdate = () => {
    if (!editingBinding) return;

    platformBindingService.updateBinding(editingBinding.id, {
      triggerMode: formData.triggerMode,
      paramsOverride: formData.paramsOverride,
      limits: formData.limits,
    });
    loadData();
    resetForm();
    setEditingBinding(null);
  };

  // 处理删除绑定
  const handleDelete = (bindingId: string) => {
    if (confirm('确定要删除这个绑定配置吗？')) {
      platformBindingService.deleteBinding(bindingId);
      loadData();
    }
  };

  // 处理切换启用状态
  const handleToggle = (bindingId: string, enabled: boolean) => {
    platformBindingService.toggleBinding(bindingId, !enabled);
    loadData();
  };

  // 开始编辑
  const startEdit = (binding: PlatformBindingConfig) => {
    setEditingBinding(binding);
    setFormData({
      gameId: binding.gameId,
      ruleId: binding.ruleId,
      triggerMode: binding.triggerMode,
      paramsOverride: binding.paramsOverride,
      limits: binding.limits,
    });
    setIsCreating(true);
  };

  // 重置表单
  const resetForm = () => {
    setFormData({
      gameId: '',
      ruleId: '',
      triggerMode: TriggerMode.ON_GAME_COMPLETE,
      limits: {
        cooldownMinutes: 0,
        maxDaily: 9999,
        maxPerUser: 99999,
      },
    });
    // 重置奖池相关状态
    setPoolMode('platform');
    setSelectedPoolOwner('');
    setSelectedPoolId('');
    setUserPools([]);
    // 重置算法模板状态
    setSourceCategory('rule');
    setSelectedAlgorithmTemplateId('');
    // 重置规则编辑器
    setShowRuleEditor(false);
    setRuleEditor({
      type: 'game_reward',
      allocationMode: 'fixed',
      fixedAmount: 0,
      tieredAmounts: [],
      recycleRules: [],
      exchangeRates: [],
    });
  };

  // 取消创建/编辑
  const handleCancel = () => {
    resetForm();
    setIsCreating(false);
    setEditingBinding(null);
  };

  // 从选中的规则填充规则编辑器
  const populateRuleEditor = (ruleId: string) => {
    const rule = rules.find(r => r.id === ruleId);
    if (!rule) return;
    setRuleEditor({
      type: rule.type,
      allocationMode: rule.allocation.mode === 'tiered' ? 'tiered' : 'fixed',
      // ⚠️ 不再给默认值，用户必须自行填写金额
      fixedAmount: rule.allocation.fixedAmount || 0,
      tieredAmounts: rule.allocation.tieredAmounts || [],
      recycleRules: [],
      exchangeRates: [],
    });
    setShowRuleEditor(true);
  };

  // 获取可用的触发模式
  const getAvailableTriggerModes = (gameType: GameType) => {
    return TRIGGER_MODE_OPTIONS.filter(opt => opt.applicableTypes.includes(gameType));
  };

  return (
    <div className="space-y-6">
      {/* 统计卡片 */}
      <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-slate-800/50 rounded-xl p-4 border border-white/10"
        >
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-blue-500/20 flex items-center justify-center">
              <Link2 className="w-5 h-5 text-blue-400" />
            </div>
            <div>
              <p className="text-slate-400 text-sm">总绑定数</p>
              <p className="text-2xl font-bold text-white">{stats.total}</p>
            </div>
          </div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="bg-slate-800/50 rounded-xl p-4 border border-white/10"
        >
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-green-500/20 flex items-center justify-center">
              <CheckCircle2 className="w-5 h-5 text-green-400" />
            </div>
            <div>
              <p className="text-slate-400 text-sm">启用中</p>
              <p className="text-2xl font-bold text-white">{stats.active}</p>
            </div>
          </div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
          className="bg-slate-800/50 rounded-xl p-4 border border-white/10"
        >
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-purple-500/20 flex items-center justify-center">
              <BarChart3 className="w-5 h-5 text-purple-400" />
            </div>
            <div>
              <p className="text-slate-400 text-sm">已发放次数</p>
              <p className="text-2xl font-bold text-white">{stats.distributed}</p>
            </div>
          </div>
        </motion.div>

        {/* ⭐ 平台奖池余额卡片 — 点击展开充值面板 */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
          className="bg-gradient-to-br from-blue-600/20 to-purple-600/20 rounded-xl p-4 border border-white/10 cursor-pointer hover:from-blue-600/30 hover:to-purple-600/30 transition-all"
          onClick={() => setShowPoolFundPanel(!showPoolFundPanel)}
        >
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-yellow-500/20 flex items-center justify-center">
              <Coins className="w-5 h-5 text-yellow-400" />
            </div>
            <div>
              <p className="text-slate-300 text-sm flex items-center gap-1">
                平台奖池余额
                {poolBalance.voucherCount === 0 && (
                  <span className="text-xs text-yellow-400">(空)</span>
                )}
              </p>
              <p className="text-2xl font-bold text-white">
                {poolBalance.totalAmount.toLocaleString()}
              </p>
              <p className="text-xs text-slate-400">{poolBalance.voucherCount} 张凭证</p>
            </div>
          </div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.35 }}
          className="bg-gradient-to-br from-emerald-600/20 to-teal-600/20 rounded-xl p-4 border border-white/10"
        >
          <button
            onClick={() => setShowPoolFundPanel(true)}
            className="w-full flex items-center gap-3"
          >
            <div className="w-10 h-10 rounded-lg bg-green-500/20 flex items-center justify-center">
              <DollarSign className="w-5 h-5 text-green-400" />
            </div>
            <div className="text-left">
              <p className="text-slate-300 text-sm">操作</p>
              <p className="text-sm font-bold text-green-400">充值奖池</p>
              <p className="text-xs text-slate-400">注入凭证资金</p>
            </div>
          </button>
        </motion.div>
      </div>

      {/* 平台奖池充值面板 */}
      <AnimatePresence>
        {showPoolFundPanel && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
          >
            <PoolFundPanel
              currentUserId={currentUserId}
              currentUsername={currentUsername}
              onBalanceChange={(newBalance) => setPoolBalance(newBalance)}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {/* 操作栏 */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-white flex items-center gap-2">
            <Gamepad2 className="w-6 h-6 text-blue-400" />
            游戏奖励绑定
          </h2>
          <p className="text-slate-400 text-sm mt-1">
            将调试好的凭证规则绑定到具体游戏，玩家满足条件即可自动获得奖励
          </p>
        </div>
        <button
          onClick={() => setIsCreating(true)}
          disabled={isCreating}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg font-medium transition-colors"
        >
          <Plus className="w-4 h-4" />
          新建绑定
        </button>
      </div>

      {/* 创建/编辑表单 */}
      <AnimatePresence>
        {isCreating && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="bg-slate-800/50 rounded-xl border border-white/10 overflow-hidden"
          >
            <div className="p-6 space-y-6">
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-bold text-white">
                  {editingBinding ? '编辑绑定' : '新建绑定'}
                </h3>
                <button onClick={handleCancel} className="text-slate-400 hover:text-white">
                  <span className="sr-only">关闭</span>
                  ×
                </button>
              </div>

              {/* 步骤 1: 选择游戏 */}
              <div className="space-y-3">
                <label className="text-sm font-medium text-slate-300">选择游戏</label>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                  {games.map(game => {
                    const typeInfo = GameTypeLabels[game.type];
                    const isSelected = formData.gameId === game.id;
                    const isPlayable = !game.status || game.status === 'available';
                    const statusBadge = game.status === 'coming-soon'
                      ? { text: '即将上线', color: 'text-blue-400 bg-blue-400/10' }
                      : game.status === 'maintenance'
                      ? { text: '维护中', color: 'text-orange-400 bg-orange-400/10' }
                      : null;
                    return (
                      <button
                        key={game.id}
                        onClick={() => {
                          if (!isPlayable) return;
                          // 切换游戏后若当前触发方式不适用于新游戏类型，自动回落到第一个可用项
                          const available = getAvailableTriggerModes(game.type);
                          const stillValid = available.some(o => o.value === formData.triggerMode);
                          const triggerMode = stillValid ? formData.triggerMode : (available[0]?.value ?? TriggerMode.ON_GAME_COMPLETE);
                          setFormData({ ...formData, gameId: game.id, triggerMode });
                        }}
                        disabled={!!editingBinding || !isPlayable}
                        title={!isPlayable ? (game.status === 'coming-soon' ? '该游戏尚未上线，暂不可绑定' : '该游戏正在维护中，暂不可绑定') : ''}
                        className={`p-4 rounded-xl border text-left transition-all ${
                          isSelected
                            ? 'border-blue-500 bg-blue-500/10'
                            : 'border-white/10 bg-slate-800 hover:border-white/20'
                        } ${editingBinding || !isPlayable ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'}`}
                      >
                        <div className="flex items-start gap-3">
                          <span className="text-2xl">{game.icon}</span>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="font-medium text-white truncate">{game.name}</span>
                              {statusBadge && (
                                <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] ${statusBadge.color}`}>
                                  {statusBadge.text}
                                </span>
                              )}
                            </div>
                            <p className="text-xs text-slate-400 mt-1">{game.description}</p>
                            <div className="flex items-center gap-2 mt-2">
                              <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs ${typeInfo.color}`}>
                                {typeInfo.icon}
                                {typeInfo.label}
                              </span>
                            </div>
                          </div>
                          {isSelected && (
                            <CheckCircle2 className="w-5 h-5 text-blue-400 shrink-0" />
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* 步骤 2: 选择来源类型 + 具体规则/模板 */}
              {formData.gameId && (
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="space-y-3"
                >
                  <label className="text-sm font-medium text-slate-300">
                    奖励来源类型
                    <span className="text-xs text-slate-500 ml-2 font-normal">选择使用固定规则还是算法模板</span>
                  </label>
                  
                  {/* 来源类型切换 */}
                  <div className="grid grid-cols-2 gap-3 mb-3">
                    <button onClick={() => { setSourceCategory('rule'); setFormData({ ...formData, ruleId: '' }); setSelectedAlgorithmTemplateId(''); }}
                      className={`p-3 rounded-xl border text-left transition-all ${sourceCategory === 'rule' ? 'border-purple-500 bg-purple-500/10' : 'border-white/10 bg-slate-800 hover:border-white/20'}`}>
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-lg bg-purple-500/20 flex items-center justify-center">
                          <Sparkles className="w-4 h-4 text-purple-400" />
                        </div>
                        <div>
                          <span className="font-medium text-white text-sm">固定规则</span>
                          <p className="text-xs text-slate-400 mt-0.5">即时发放，事件触发</p>
                        </div>
                        {sourceCategory === 'rule' && <CheckCircle2 className="w-4 h-4 text-purple-400 ml-auto" />}
                      </div>
                    </button>
                    <button onClick={() => { setSourceCategory('algorithm'); setFormData({ ...formData, ruleId: '' }); setSelectedAlgorithmTemplateId(''); }}
                      className={`p-3 rounded-xl border text-left transition-all ${sourceCategory === 'algorithm' ? 'border-rose-500 bg-rose-500/10' : 'border-white/10 bg-slate-800 hover:border-white/20'}`}>
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-lg bg-rose-500/20 flex items-center justify-center">
                          <Calculator className="w-4 h-4 text-rose-400" />
                        </div>
                        <div>
                          <span className="font-medium text-white text-sm">算法模板</span>
                          <p className="text-xs text-slate-400 mt-0.5">周期结算，动态分配</p>
                        </div>
                        {sourceCategory === 'algorithm' && <CheckCircle2 className="w-4 h-4 text-rose-400 ml-auto" />}
                      </div>
                    </button>
                  </div>

                  {/* 固定规则选择 */}
                  {sourceCategory === 'rule' && (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      {rules.map(rule => {
                        const isSelected = formData.ruleId === rule.id;
                        return (
                          <button key={rule.id} onClick={() => {
                            setFormData({ ...formData, ruleId: rule.id });
                            // 自动展开规则编辑器，因为模板不再预设金额
                            if (!showRuleEditor) {
                              populateRuleEditor(rule.id);
                              setShowRuleEditor(true);
                            }
                          }}
                            className={`p-4 rounded-xl border text-left transition-all ${isSelected ? 'border-purple-500 bg-purple-500/10' : 'border-white/10 bg-slate-800 hover:border-white/20'} ${editingBinding ? 'opacity-60 cursor-not-allowed' : ''}`}>
                            <div className="flex items-start gap-3">
                              <div className="w-10 h-10 rounded-lg bg-purple-500/20 flex items-center justify-center shrink-0">
                                <Sparkles className="w-5 h-5 text-purple-400" />
                              </div>
                              <div className="flex-1 min-w-0">
                                <span className="font-medium text-white">{rule.name}</span>
                                <p className="text-xs text-slate-400 mt-1">
                                  {rule.allocation.fixedAmount ? `固定奖励: ${rule.allocation.fixedAmount} A币` : 
                                   rule.allocation.tieredAmounts?.length ? `分档奖励: ${rule.allocation.tieredAmounts.length} 档` : 
                                   '需配置金额'}
                                </p>
                                {!rule.allocation.fixedAmount && !rule.allocation.tieredAmounts?.length && (
                                  <p className="text-xs text-yellow-400 mt-1">选择后请在下方配置金额</p>
                                )}
                              </div>
                              {isSelected && <CheckCircle2 className="w-5 h-5 text-purple-400 shrink-0" />}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  )}

                  {/* 算法模板选择 */}
                  {sourceCategory === 'algorithm' && (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      {algorithmTemplates.length === 0 ? (
                        <div className="col-span-full p-4 rounded-xl border border-dashed border-white/10 text-center text-slate-500">
                          <p className="text-sm">暂无算法模板</p>
                          <p className="text-xs mt-1">请先在「发放来源」创建算法模板</p>
                        </div>
                      ) : algorithmTemplates.filter(t => t.isActive).map(tmpl => {
                        const isSelected = selectedAlgorithmTemplateId === tmpl.id;
                        return (
                          <button key={tmpl.id} onClick={() => setSelectedAlgorithmTemplateId(tmpl.id)}
                            className={`p-4 rounded-xl border text-left transition-all ${isSelected ? 'border-rose-500 bg-rose-500/10' : 'border-white/10 bg-slate-800 hover:border-white/20'}`}>
                            <div className="flex items-start gap-3">
                              <div className="w-10 h-10 rounded-lg bg-rose-500/20 flex items-center justify-center shrink-0">
                                <Cpu className="w-5 h-5 text-rose-400" />
                              </div>
                              <div className="flex-1 min-w-0">
                                <span className="font-medium text-white">{tmpl.name}</span>
                                <p className="text-xs text-slate-400 mt-1">{tmpl.settlementCycle} @ {tmpl.settlementTime} 结算</p>
                                <p className="text-xs text-rose-400 mt-1">游戏币{(tmpl.algorithm.weights.gameCoins * 100).toFixed(0)}%</p>
                              </div>
                              {isSelected && <CheckCircle2 className="w-5 h-5 text-rose-400 shrink-0" />}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </motion.div>
              )}

              {/* 固定规则 + 规则编辑按钮 */}
              {sourceCategory === 'rule' && formData.ruleId && (
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="pt-2"
                >
                  <button
                    onClick={() => {
                      if (!showRuleEditor) populateRuleEditor(formData.ruleId!);
                      setShowRuleEditor(!showRuleEditor);
                    }}
                    className={`w-full flex items-center justify-between p-3 rounded-xl border transition-all ${
                      showRuleEditor
                        ? 'border-blue-500 bg-blue-500/5'
                        : 'border-white/10 bg-slate-800/30 hover:border-white/20'
                    }`}
                  >
                    <span className="text-sm text-slate-300 flex items-center gap-2">
                      <Settings className="w-4 h-4 text-blue-400" />
                      {showRuleEditor ? '收起规则配置' : '展开规则配置'}
                    </span>
                    <span className="text-xs text-blue-400">
                      {showRuleEditor ? '▲' : '▼'}
                    </span>
                  </button>
                </motion.div>
              )}

              {/* ⚙️ 规则编辑器 — 仅固定规则时显示 */}
              {sourceCategory === 'rule' && showRuleEditor && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  className="bg-slate-900/50 rounded-xl border border-blue-500/20 overflow-hidden"
                >
                  <div className="p-4 space-y-4">
                    <h4 className="text-sm font-medium text-blue-400 flex items-center gap-2">
                      <Settings className="w-4 h-4" />
                      规则自定义配置
                    </h4>

                    {/* 奖励类型 */}
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                      <div className="space-y-2">
                        <label className="text-xs font-medium text-slate-400">奖励类型</label>
                        <select
                          value={ruleEditor.type}
                          onChange={e => setRuleEditor({ ...ruleEditor, type: e.target.value })}
                          className="w-full bg-slate-800 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:border-blue-500 focus:outline-none"
                        >
                          <option value="game_reward">游戏奖励</option>
                          <option value="daily_checkin">每日签到</option>
                          <option value="referral_bonus">邀请奖励</option>
                          <option value="task_completion">任务完成</option>
                          <option value="achievement_unlock">成就解锁</option>
                          <option value="event_reward">活动奖励</option>
                          <option value="manual_issuance">手动发放</option>
                          <option value="platform_bonus">平台奖励</option>
                        </select>
                      </div>
                      <div className="space-y-2">
                        <label className="text-xs font-medium text-slate-400">分配模式</label>
                        <select
                          value={ruleEditor.allocationMode}
                          onChange={e => setRuleEditor({ ...ruleEditor, allocationMode: e.target.value as 'fixed' | 'tiered' })}
                          className="w-full bg-slate-800 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:border-blue-500 focus:outline-none"
                        >
                          <option value="fixed">固定金额</option>
                          <option value="tiered">分档奖励</option>
                        </select>
                      </div>
                      {ruleEditor.allocationMode === 'fixed' && (
                        <div className="space-y-2">
                          <label className="text-xs font-medium text-slate-400">固定金额 (A币)</label>
                          <input
                            type="number"
                            min="1"
                            value={ruleEditor.fixedAmount || ''}
                            onChange={e => setRuleEditor({ ...ruleEditor, fixedAmount: parseInt(e.target.value) || 0 })}
                            placeholder="请输入发放金额"
                            className="w-full bg-slate-800 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:border-blue-500 focus:outline-none"
                          />
                          {ruleEditor.fixedAmount === 0 && (
                            <p className="text-xs text-yellow-400 mt-1">金额不能为0，请填写有效金额</p>
                          )}
                        </div>
                      )}
                    </div>

                    {/* 分档配置 */}
                    {ruleEditor.allocationMode === 'tiered' && (
                      <div className="bg-slate-800/30 rounded-lg p-3 border border-white/10">
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-xs font-medium text-slate-400">分档金额配置</span>
                          <button
                            onClick={() => setRuleEditor({
                              ...ruleEditor,
                              tieredAmounts: [...ruleEditor.tieredAmounts, { minThreshold: 0, maxThreshold: 1000, amount: 50 }]
                            })}
                            className="text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1"
                          >
                            <Plus className="w-3 h-3" />添加分档
                          </button>
                        </div>
                        {ruleEditor.tieredAmounts.length === 0 ? (
                          <p className="text-xs text-slate-500 text-center py-2">暂无分档，请在左侧选择「分档奖励」模式</p>
                        ) : (
                          <div className="space-y-2">
                            {ruleEditor.tieredAmounts.map((tier, i) => (
                              <div key={i} className="flex items-center gap-2">
                                <input type="number" placeholder="最低分" value={tier.minThreshold}
                                  onChange={e => {
                                    const list = [...ruleEditor.tieredAmounts];
                                    list[i] = { ...list[i], minThreshold: parseInt(e.target.value) || 0 };
                                    setRuleEditor({ ...ruleEditor, tieredAmounts: list });
                                  }}
                                  className="w-24 bg-slate-900 border border-white/10 rounded px-2 py-1 text-white text-xs" />
                                <span className="text-slate-500">~</span>
                                <input type="number" placeholder="最高分" value={tier.maxThreshold}
                                  onChange={e => {
                                    const list = [...ruleEditor.tieredAmounts];
                                    list[i] = { ...list[i], maxThreshold: parseInt(e.target.value) || 0 };
                                    setRuleEditor({ ...ruleEditor, tieredAmounts: list });
                                  }}
                                  className="w-24 bg-slate-900 border border-white/10 rounded px-2 py-1 text-white text-xs" />
                                <span className="text-slate-400 text-xs">→</span>
                                <input type="number" placeholder="金额" value={tier.amount}
                                  onChange={e => {
                                    const list = [...ruleEditor.tieredAmounts];
                                    list[i] = { ...list[i], amount: parseInt(e.target.value) || 0 };
                                    setRuleEditor({ ...ruleEditor, tieredAmounts: list });
                                  }}
                                  className="w-20 bg-slate-900 border border-white/10 rounded px-2 py-1 text-white text-xs" />
                                <button onClick={() => {
                                  const list = ruleEditor.tieredAmounts.filter((_, j) => j !== i);
                                  setRuleEditor({ ...ruleEditor, tieredAmounts: list });
                                }} className="p-1 text-red-400 hover:text-red-300">
                                  <Trash2 className="w-3 h-3" />
                                </button>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}

                    {/* 回收规则 */}
                    <div className="bg-slate-800/30 rounded-lg p-3 border border-white/10">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs font-medium text-slate-400">回收规则</span>
                        <button
                          onClick={() => setRuleEditor({
                            ...ruleEditor,
                            recycleRules: [...ruleEditor.recycleRules, {
                              id: `recycle-${Date.now()}`,
                              name: '新回收规则',
                              type: 'expiration_burn',
                              enabled: true,
                              priority: ruleEditor.recycleRules.length + 1,
                              trigger: { type: 'condition', condition: 'expired' },
                              recycleLogic: { mode: 'percentage', percentage: 100, destination: 'burn' },
                              limits: {},
                            }]
                          })}
                          className="text-xs text-orange-400 hover:text-orange-300 flex items-center gap-1"
                        >
                          <Plus className="w-3 h-3" />添加规则
                        </button>
                      </div>
                      {ruleEditor.recycleRules.length === 0 ? (
                        <p className="text-xs text-slate-500 text-center py-2">暂未配置回收规则</p>
                      ) : (
                        <div className="space-y-2">
                          {ruleEditor.recycleRules.map((rr, i) => (
                            <div key={rr.id} className="flex items-center gap-2 bg-slate-900/50 rounded p-2">
                              <select value={rr.type}
                                onChange={e => {
                                  const list = [...ruleEditor.recycleRules];
                                  list[i] = { ...list[i], type: e.target.value as any };
                                  setRuleEditor({ ...ruleEditor, recycleRules: list });
                                }}
                                className="flex-1 bg-slate-900 border border-white/10 rounded px-2 py-1 text-white text-xs">
                                <option value="expiration_burn">过期销毁</option>
                                <option value="transaction_fee">交易手续费</option>
                                <option value="daily_settlement">每日结算回收</option>
                                <option value="exchange_conversion">兑换消耗</option>
                                <option value="penalty_deduction">惩罚扣除</option>
                                <option value="buyback">平台回购</option>
                              </select>
                              <select value={rr.recycleLogic.mode}
                                onChange={e => {
                                  const list = [...ruleEditor.recycleRules];
                                  list[i] = { ...list[i], recycleLogic: { ...list[i].recycleLogic, mode: e.target.value as any } };
                                  setRuleEditor({ ...ruleEditor, recycleRules: list });
                                }}
                                className="w-20 bg-slate-900 border border-white/10 rounded px-2 py-1 text-white text-xs">
                                <option value="percentage">比例%</option>
                                <option value="fixed">固定值</option>
                              </select>
                              <input type="number" placeholder={rr.recycleLogic.mode === 'percentage' ? '比例%' : '金额'}
                                value={rr.recycleLogic.mode === 'percentage' ? rr.recycleLogic.percentage || '' : rr.recycleLogic.fixedAmount || ''}
                                onChange={e => {
                                  const list = [...ruleEditor.recycleRules];
                                  const val = parseFloat(e.target.value) || 0;
                                  if (list[i].recycleLogic.mode === 'percentage') {
                                    list[i] = { ...list[i], recycleLogic: { ...list[i].recycleLogic, percentage: val } };
                                  } else {
                                    list[i] = { ...list[i], recycleLogic: { ...list[i].recycleLogic, fixedAmount: val } };
                                  }
                                  setRuleEditor({ ...ruleEditor, recycleRules: list });
                                }}
                                className="w-16 bg-slate-900 border border-white/10 rounded px-2 py-1 text-white text-xs" />
                              <select value={rr.recycleLogic.destination}
                                onChange={e => {
                                  const list = [...ruleEditor.recycleRules];
                                  list[i] = { ...list[i], recycleLogic: { ...list[i].recycleLogic, destination: e.target.value as any } };
                                  setRuleEditor({ ...ruleEditor, recycleRules: list });
                                }}
                                className="w-20 bg-slate-900 border border-white/10 rounded px-2 py-1 text-white text-xs">
                                <option value="burn">销毁</option>
                                <option value="treasury">国库</option>
                                <option value="pool">奖池</option>
                                <option value="platform">平台</option>
                              </select>
                              <button onClick={() => {
                                const list = ruleEditor.recycleRules.filter((_, j) => j !== i);
                                setRuleEditor({ ...ruleEditor, recycleRules: list });
                              }} className="p-1 text-red-400 hover:text-red-300">
                                <Trash2 className="w-3 h-3" />
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* 兑换币种 */}
                    <div className="bg-slate-800/30 rounded-lg p-3 border border-white/10">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs font-medium text-slate-400">兑换币种</span>
                        <button
                          onClick={() => setRuleEditor({
                            ...ruleEditor,
                            exchangeRates: [...ruleEditor.exchangeRates, {
                              targetCurrency: 'New_Coin',
                              targetSymbol: 'NEW',
                              rate: 1,
                              fee: 0,
                              direction: 'both',
                            }]
                          })}
                          className="text-xs text-emerald-400 hover:text-emerald-300 flex items-center gap-1"
                        >
                          <Plus className="w-3 h-3" />添加币种
                        </button>
                      </div>
                      {ruleEditor.exchangeRates.length === 0 ? (
                        <p className="text-xs text-slate-500 text-center py-2">暂未配置兑换币种</p>
                      ) : (
                        <div className="space-y-2">
                          {ruleEditor.exchangeRates.map((er, i) => (
                            <div key={i} className="flex items-center gap-2 bg-slate-900/50 rounded p-2">
                              <input type="text" placeholder="币种名称" value={er.targetCurrency}
                                onChange={e => {
                                  const list = [...ruleEditor.exchangeRates];
                                  list[i] = { ...list[i], targetCurrency: e.target.value };
                                  setRuleEditor({ ...ruleEditor, exchangeRates: list });
                                }}
                                className="flex-1 bg-slate-900 border border-white/10 rounded px-2 py-1 text-white text-xs" />
                              <input type="text" placeholder="符号" value={er.targetSymbol || ''}
                                onChange={e => {
                                  const list = [...ruleEditor.exchangeRates];
                                  list[i] = { ...list[i], targetSymbol: e.target.value };
                                  setRuleEditor({ ...ruleEditor, exchangeRates: list });
                                }}
                                className="w-16 bg-slate-900 border border-white/10 rounded px-2 py-1 text-white text-xs" />
                              <span className="text-xs text-slate-500">1A→</span>
                              <input type="number" step="0.01" placeholder="汇率" value={er.rate}
                                onChange={e => {
                                  const list = [...ruleEditor.exchangeRates];
                                  list[i] = { ...list[i], rate: parseFloat(e.target.value) || 0 };
                                  setRuleEditor({ ...ruleEditor, exchangeRates: list });
                                }}
                                className="w-20 bg-slate-900 border border-white/10 rounded px-2 py-1 text-white text-xs" />
                              <span className="text-xs text-slate-500">费</span>
                              <input type="number" step="0.1" placeholder="%" value={er.fee || 0}
                                onChange={e => {
                                  const list = [...ruleEditor.exchangeRates];
                                  list[i] = { ...list[i], fee: parseFloat(e.target.value) || 0 };
                                  setRuleEditor({ ...ruleEditor, exchangeRates: list });
                                }}
                                className="w-14 bg-slate-900 border border-white/10 rounded px-2 py-1 text-white text-xs" />
                              <button onClick={() => {
                                const list = ruleEditor.exchangeRates.filter((_, j) => j !== i);
                                setRuleEditor({ ...ruleEditor, exchangeRates: list });
                              }} className="p-1 text-red-400 hover:text-red-300">
                                <Trash2 className="w-3 h-3" />
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    <p className="text-xs text-slate-500 flex items-center gap-1">
                      <Info className="w-3 h-3" />
                      自定义配置将替代预设规则应用于此绑定。创建后可在详情中查看。
                    </p>
                  </div>
                </motion.div>
              )}
              {formData.gameId && (sourceCategory === 'rule' ? formData.ruleId : selectedAlgorithmTemplateId) && selectedGame && (
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="space-y-3"
                >
                  <label className="text-sm font-medium text-slate-300">触发方式</label>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {/* 算法模板自动添加周期结算选项 */}
                    {sourceCategory === 'algorithm' && (
                      <button onClick={() => setFormData({ ...formData, triggerMode: 'periodic_settlement' as TriggerMode })}
                        className={`p-4 rounded-xl border text-left transition-all ${
                          formData.triggerMode === 'periodic_settlement' ? 'border-rose-500 bg-rose-500/10' : 'border-white/10 bg-slate-800 hover:border-white/20'
                        }`}>
                        <div className="flex items-start gap-3">
                          <div className="w-8 h-8 rounded-lg bg-rose-500/20 flex items-center justify-center shrink-0">
                            <Timer className="w-4 h-4 text-rose-400" />
                          </div>
                          <div>
                            <span className="font-medium text-white">周期结算</span>
                            <p className="text-xs text-slate-400 mt-1">按结算周期自动计算并发放奖励</p>
                          </div>
                          {formData.triggerMode === 'periodic_settlement' && <CheckCircle2 className="w-5 h-5 text-rose-400 shrink-0 ml-auto" />}
                        </div>
                      </button>
                    )}
                    {getAvailableTriggerModes(selectedGame.type).map(option => {
                      const isSelected = formData.triggerMode === option.value;
                      return (
                        <button key={option.value} onClick={() => setFormData({ ...formData, triggerMode: option.value })}
                          className={`p-4 rounded-xl border text-left transition-all ${
                            isSelected ? 'border-green-500 bg-green-500/10' : 'border-white/10 bg-slate-800 hover:border-white/20'
                          }`}>
                          <div className="flex items-start gap-3">
                            <div className="w-8 h-8 rounded-lg bg-green-500/20 flex items-center justify-center shrink-0">
                              {TriggerModeIcons[option.value] || <Zap className="w-4 h-4 text-green-400" />}
                            </div>
                            <div>
                              <span className="font-medium text-white">{option.label}</span>
                              <p className="text-xs text-slate-400 mt-1">{option.description}</p>
                            </div>
                            {isSelected && <CheckCircle2 className="w-5 h-5 text-green-400 shrink-0 ml-auto" />}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </motion.div>
              )}

              {/* 步骤 4: 选择奖池来源 */}
              {formData.gameId && (sourceCategory === 'rule' ? formData.ruleId : selectedAlgorithmTemplateId) && (
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="space-y-3"
                >
                  <label className="text-sm font-medium text-slate-300">
                    奖励来源（奖池）
                    <span className="text-xs text-slate-500 ml-2 font-normal">
                      选择从哪个奖池发放奖励
                    </span>
                  </label>
                  
                  {/* 奖池来源切换 */}
                  <div className="grid grid-cols-2 gap-3 mb-4">
                    <button
                      onClick={() => {
                        setPoolMode('platform');
                        setSelectedPoolOwner('');
                        setSelectedPoolId('');
                        setUserPools([]);
                      }}
                      className={`p-4 rounded-xl border text-left transition-all ${
                        poolMode === 'platform'
                          ? 'border-blue-500 bg-blue-500/10'
                          : 'border-white/10 bg-slate-800 hover:border-white/20'
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-lg bg-blue-500/20 flex items-center justify-center">
                          <Building2 className="w-5 h-5 text-blue-400" />
                        </div>
                        <div>
                          <span className="font-medium text-white">平台奖池</span>
                          <p className="text-xs text-slate-400 mt-1">从平台官方奖池发放</p>
                        </div>
                        {poolMode === 'platform' && (
                          <CheckCircle2 className="w-5 h-5 text-blue-400 ml-auto" />
                        )}
                      </div>
                    </button>
                    
                    <button
                      onClick={() => {
                        setPoolMode('user');
                        setSelectedPoolOwner('');
                        setSelectedPoolId('');
                        setUserPools([]);
                      }}
                      className={`p-4 rounded-xl border text-left transition-all ${
                        poolMode === 'user'
                          ? 'border-purple-500 bg-purple-500/10'
                          : 'border-white/10 bg-slate-800 hover:border-white/20'
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-lg bg-purple-500/20 flex items-center justify-center">
                          <UserCircle className="w-5 h-5 text-purple-400" />
                        </div>
                        <div>
                          <span className="font-medium text-white">用户奖池</span>
                          <p className="text-xs text-slate-400 mt-1">从指定用户的奖池发放</p>
                        </div>
                        {poolMode === 'user' && (
                          <CheckCircle2 className="w-5 h-5 text-purple-400 ml-auto" />
                        )}
                      </div>
                    </button>
                  </div>
                  
                  {/* 选择用户奖池 */}
                  {poolMode === 'user' && (
                    <div className="space-y-3 p-4 bg-slate-900/50 rounded-xl border border-white/10">
                      <div>
                        <label className="text-xs text-slate-400 block mb-2">选择奖池所有者</label>
                        <select
                          value={selectedPoolOwner}
                          onChange={(e) => {
                            const userId = e.target.value;
                            setSelectedPoolOwner(userId);
                            setSelectedPoolId('');
                            loadUserPools(userId);
                          }}
                          className="w-full bg-slate-900 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:border-purple-500 focus:outline-none"
                        >
                          <option value="">选择用户...</option>
                          {usersWithPools.map(user => (
                            <option key={user.userId} value={user.userId}>
                              {user.userName} (奖池: {user.poolCount}个)
                            </option>
                          ))}
                        </select>
                      </div>
                      
                      {/* 显示该用户的奖池列表 */}
                      {userPools.length > 0 && (
                        <div className="mt-3">
                          <label className="text-xs text-slate-400 block mb-2">选择具体奖池</label>
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                            {userPools.map(pool => (
                              <div
                                key={pool.id}
                                onClick={() => setSelectedPoolId(pool.id)}
                                className={`p-3 rounded-lg border cursor-pointer transition-all ${
                                  selectedPoolId === pool.id
                                    ? 'border-purple-500 bg-purple-500/10'
                                    : 'border-white/10 bg-slate-800 hover:border-white/20'
                                }`}
                              >
                                <div className="flex items-center justify-between">
                                  <span className="font-medium text-white text-sm">{pool.name}</span>
                                  <span className={`text-xs px-2 py-0.5 rounded ${
                                    pool.status === 'active' ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'
                                  }`}>
                                    {pool.status === 'active' ? '活跃' : '已耗尽'}
                                  </span>
                                </div>
                                <div className="flex items-center gap-3 mt-2 text-xs text-slate-400">
                                  <span className="flex items-center gap-1">
                                    <Coins className="w-3 h-3" />
                                    余额: {pool.totalBalance} A币
                                  </span>
                                  <span className="flex items-center gap-1">
                                    <Warehouse className="w-3 h-3" />
                                    {pool.voucherCount} 张凭证
                                  </span>
                                </div>
                                <p className="text-xs text-slate-500 mt-1">
                                  已发放: {pool.distributionCount}次
                                </p>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      
                      {selectedPoolOwner && userPools.length === 0 && (
                        <div className="p-3 bg-yellow-500/10 rounded-lg border border-yellow-500/20">
                          <p className="text-xs text-yellow-400">
                            该用户没有活跃的奖池，请先创建奖池
                          </p>
                        </div>
                      )}
                    </div>
                  )}
                </motion.div>
              )}

              {/* 步骤 5: 限制条件 */}
              {formData.gameId && (sourceCategory === 'rule' ? formData.ruleId : selectedAlgorithmTemplateId) && (
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="space-y-4"
                >
                  <label className="text-sm font-medium text-slate-300">限制条件</label>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div>
                      <label className="text-xs text-slate-400 block mb-2">冷却时间（分钟）</label>
                      <input
                        type="number"
                        value={formData.limits?.cooldownMinutes || 0}
                        onChange={e => setFormData({
                          ...formData,
                          limits: { ...formData.limits!, cooldownMinutes: parseInt(e.target.value) || 0 }
                        })}
                        className="w-full bg-slate-900 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:border-blue-500 focus:outline-none"
                        placeholder="0 = 无冷却"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-slate-400 block mb-2">每日上限</label>
                      <input
                        type="number"
                        value={formData.limits?.maxDaily || 9999}
                        onChange={e => setFormData({
                          ...formData,
                          limits: { ...formData.limits!, maxDaily: parseInt(e.target.value) || 9999 }
                        })}
                        className="w-full bg-slate-900 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:border-blue-500 focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-slate-400 block mb-2">每用户总上限</label>
                      <input
                        type="number"
                        value={formData.limits?.maxPerUser || 99999}
                        onChange={e => setFormData({
                          ...formData,
                          limits: { ...formData.limits!, maxPerUser: parseInt(e.target.value) || 99999 }
                        })}
                        className="w-full bg-slate-900 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:border-blue-500 focus:outline-none"
                      />
                    </div>
                  </div>
                  <p className="text-xs text-slate-500">
                    <Info className="w-3 h-3 inline mr-1" />
                    冷却时间设为 1440 分钟即表示每24小时可领取一次
                  </p>
                </motion.div>
              )}

              {/* 操作按钮 */}
              <div className="flex justify-end gap-3 pt-4 border-t border-white/10">
                <button
                  onClick={handleCancel}
                  className="px-4 py-2 text-slate-400 hover:text-white transition-colors"
                >
                  取消
                </button>
                <button
                  onClick={editingBinding ? handleUpdate : handleCreate}
                  disabled={!formData.gameId || (sourceCategory === 'rule' ? !formData.ruleId : !selectedAlgorithmTemplateId)}
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg font-medium transition-colors"
                >
                  {editingBinding ? '保存修改' : '创建绑定'}
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 绑定列表 */}
      <div className="space-y-4">
        {bindings.length === 0 ? (
          <div className="text-center py-12 bg-slate-800/30 rounded-xl border border-white/10 border-dashed">
            <Link2 className="w-12 h-12 text-slate-600 mx-auto mb-4" />
            <h3 className="text-lg font-medium text-slate-400">暂无绑定配置</h3>
            <p className="text-slate-500 text-sm mt-1">点击上方"新建绑定"按钮开始配置</p>
          </div>
        ) : (
          bindings.map((binding, index) => (
            <motion.div
              key={binding.id}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: index * 0.05 }}
              className={`bg-slate-800/50 rounded-xl border ${
                binding.enabled ? 'border-white/10' : 'border-white/5 opacity-70'
              } overflow-hidden`}
            >
              <div className="p-4">
                <div className="flex items-center gap-4">
                  {/* 游戏图标 */}
                  <div className="w-12 h-12 rounded-xl bg-slate-700 flex items-center justify-center text-2xl shrink-0">
                    {games.find(g => g.id === binding.gameId)?.icon || '🎮'}
                  </div>

                  {/* 主要信息 */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-white">{binding.gameName}</span>
                      <span className={`text-xs px-2 py-0.5 rounded ${GameTypeLabels[binding.gameType].color}`}>
                        {GameTypeLabels[binding.gameType].label}
                      </span>
                      <span className="text-slate-500">→</span>
                      <span className="text-sm text-purple-400">{binding.ruleName}</span>
                      {(binding as any).sourceCategory === 'algorithm' && (
                        <span className="text-xs px-1.5 py-0.5 rounded bg-rose-500/20 text-rose-400 flex items-center gap-1">
                          <Calculator className="w-3 h-3" />算法
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-4 mt-1 text-xs text-slate-400">
                      <span className="flex items-center gap-1">
                        {TriggerModeIcons[binding.triggerMode]}
                        {TRIGGER_MODE_OPTIONS.find(o => o.value === binding.triggerMode)?.label}
                      </span>
                      {/* 触发方式依赖提醒：行为类触发需游戏已集成平台奖励上报（发布指南 4.7 代码段 E） */}
                      {binding.gameType !== GameType.EXTERNAL &&
                       (binding.triggerMode === TriggerMode.ON_GAME_COMPLETE || binding.triggerMode === TriggerMode.ON_ACHIEVEMENT) && (
                        <span
                          className="text-amber-400/90"
                          title="该触发方式需要游戏已集成平台奖励上报（发布指南 4.7 代码段 E）并重新发布，否则不会发放。如需「进入即发」，请编辑绑定改选「点击游玩时」。"
                        >
                          需游戏集成上报，未集成请改选「点击游玩时」
                        </span>
                      )}
                      {/* 奖池来源标签 */}
                      {(binding as any).poolSource === 'user' ? (
                        <span className="flex items-center gap-1 text-purple-400">
                          <UserCircle className="w-3 h-3" />
                          用户奖池
                          {(binding as any).poolName && `(${(binding as any).poolName})`}
                        </span>
                      ) : (
                        <span className="flex items-center gap-1 text-blue-400">
                          <Building2 className="w-3 h-3" />
                          平台奖池
                        </span>
                      )}
                      {binding.limits.cooldownMinutes > 0 && (
                        <span className="flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          冷却: {binding.limits.cooldownMinutes >= 1440
                            ? `${Math.floor(binding.limits.cooldownMinutes / 1440)}天`
                            : `${binding.limits.cooldownMinutes}分钟`}
                        </span>
                      )}
                      <span>每日: {binding.limits.maxDaily}</span>
                    </div>
                  </div>

                  {/* 状态开关 */}
                  <button
                    onClick={() => handleToggle(binding.id, binding.enabled)}
                    className={`p-2 rounded-lg transition-colors ${
                      binding.enabled ? 'text-green-400 hover:bg-green-400/10' : 'text-slate-500 hover:bg-white/5'
                    }`}
                    title={binding.enabled ? '点击禁用' : '点击启用'}
                  >
                    {binding.enabled ? <ToggleRight className="w-6 h-6" /> : <ToggleLeft className="w-6 h-6" />}
                  </button>

                  {/* 操作按钮 */}
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => setExpandedBinding(expandedBinding === binding.id ? null : binding.id)}
                      className="p-2 text-slate-400 hover:text-white hover:bg-white/5 rounded-lg transition-colors"
                    >
                      {expandedBinding === binding.id ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                    </button>
                    <button
                      onClick={() => startEdit(binding)}
                      className="p-2 text-slate-400 hover:text-blue-400 hover:bg-blue-400/10 rounded-lg transition-colors"
                    >
                      <Edit2 className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => handleDelete(binding.id)}
                      className="p-2 text-slate-400 hover:text-red-400 hover:bg-red-400/10 rounded-lg transition-colors"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                {/* 展开详情 */}
                <AnimatePresence>
                  {expandedBinding === binding.id && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      className="mt-4 pt-4 border-t border-white/10"
                    >
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                        <div>
                          <span className="text-slate-500 block">绑定ID</span>
                          <span className="text-slate-300 font-mono text-xs">{binding.id.slice(0, 8)}...</span>
                        </div>
                        <div>
                          <span className="text-slate-500 block">规则ID</span>
                          <span className="text-slate-300 font-mono text-xs">{binding.ruleId.slice(0, 8)}...</span>
                        </div>
                        <div>
                          <span className="text-slate-500 block">创建者</span>
                          <span className="text-slate-300">{binding.createdByName}</span>
                        </div>
                        <div>
                          <span className="text-slate-500 block">创建时间</span>
                          <span className="text-slate-300">{new Date(binding.createdAt).toLocaleString()}</span>
                        </div>
                      </div>
                      {binding.paramsOverride && (
                        <div className="mt-3 p-3 bg-slate-900/50 rounded-lg">
                          <span className="text-slate-500 text-sm block mb-1">参数覆盖</span>
                          <pre className="text-xs text-slate-400 overflow-x-auto">
                            {JSON.stringify(binding.paramsOverride, null, 2)}
                          </pre>
                        </div>
                      )}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </motion.div>
          ))
        )}
      </div>

      {/* 使用说明 */}
      <div className="bg-blue-500/5 border border-blue-500/20 rounded-xl p-4">
        <div className="flex items-start gap-3">
          <Info className="w-5 h-5 text-blue-400 shrink-0 mt-0.5" />
          <div>
            <h4 className="text-sm font-medium text-blue-400">使用说明</h4>
            <ul className="text-xs text-slate-400 mt-2 space-y-1 list-disc list-inside">
              <li><strong>平台游戏</strong>（消消乐等）：游戏完成时自动触发奖励发放</li>
              <li><strong>外部游戏</strong>（New Day等）：玩家点击"游玩"按钮时立即发放奖励</li>
              <li><strong>发布游戏</strong>（ming等）：支持游戏内成就触发和商店货币打通</li>
              <li>建议在测试Tab中充分验证规则后再绑定到生产环境</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
};

export default PlatformIntegrationTab;
