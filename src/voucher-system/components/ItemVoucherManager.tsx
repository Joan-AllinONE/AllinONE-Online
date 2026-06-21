/**
 * 道具凭证管理组件
 *
 * 在凭证系统页面中管理游戏道具凭证模板。
 * 游戏方在此创建/编辑/铸造道具凭证，模板数据自动同步到游戏商店。
 */
import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Package, Plus, Edit3, Trash2, Copy, Coins, AlertCircle,
  CheckCircle, X, Sparkles, TrendingUp, Shield,
  ChevronDown, ChevronUp, Search, Database, Gamepad2,
  BarChart3, RefreshCw, ExternalLink, Vote, Bug, Hammer
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { voucherItemService, type ItemVoucherPurchase } from '@/services/voucherItemService';
import { getPublishedGames, type PublishedGame } from '@/services/publishedGameService';
import { ItemVoucherTemplate, ItemSupplyPolicy } from '@/voucher-system/types';
import { gameProposalService } from '@/services/gameProposalService';
import { generateSimulatedPlayers, getPlayersByType } from '@/data/simulatedPlayers';
import { VoteStakeholderType, GameVoteThreshold, GameProposalType } from '@/types/gameProposal';
import GameProposalCreateModal from '@/components/voucher-system/GameProposalCreateModal';
import GameProposalList from '@/components/voucher-system/GameProposalList';

// ==================== 类型定义 ====================

interface ItemVoucherManagerProps {
  currentUserId: string;
  currentUsername: string;
  initialGameId?: string;
}

// ==================== 常量 ====================

const ITEM_TYPES = [
  { value: 'consumable', label: '消耗品' },
  { value: 'permanent', label: '永久道具' },
  { value: 'currency', label: '货币' },
  { value: 'buff', label: '增益' },
  { value: 'package', label: '礼包' },
];

const RARITY_OPTIONS = [
  { value: 'common', label: '普通', color: 'bg-slate-500' },
  { value: 'uncommon', label: '精良', color: 'bg-blue-500' },
  { value: 'rare', label: '稀有', color: 'bg-purple-500' },
  { value: 'legendary', label: '传说', color: 'bg-orange-500' },
];

// ==================== 主组件 ====================

const ItemVoucherManager: React.FC<ItemVoucherManagerProps> = ({
  currentUserId,
  currentUsername,
  initialGameId,
}) => {
  const [games, setGames] = useState<PublishedGame[]>([]);
  const [selectedGameId, setSelectedGameId] = useState<string>(initialGameId || '');
  const [templates, setTemplates] = useState<ItemVoucherTemplate[]>([]);
  const [overview, setOverview] = useState<ReturnType<typeof voucherItemService.getGameItemOverview> | null>(null);
  const [loading, setLoading] = useState(true);

  // 弹窗状态
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<ItemVoucherTemplate | null>(null);
  const [showMintForm, setShowMintForm] = useState<{ template: ItemVoucherTemplate } | null>(null);
  const [showProposalModal, setShowProposalModal] = useState(false);
  const [showProposalList, setShowProposalList] = useState(false);
  const [voteMode, setVoteMode] = useState(false); // 是否使用投票治理模式
  const [debugMode, setDebugMode] = useState(false); // 调试模式
  const [proposalCreateMintTemplate, setProposalCreateMintTemplate] = useState<{templateId: string, templateName: string} | null>(null);

  // 操作反馈
  const [actionMsg, setActionMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // 加载游戏列表
  useEffect(() => {
    const publishedGames = getPublishedGames();
    setGames(publishedGames);
    if (!selectedGameId && publishedGames.length > 0) {
      setSelectedGameId(publishedGames[0].id);
    }
    setLoading(false);
  }, []);

  // 加载模板数据
  useEffect(() => {
    if (!selectedGameId) {
      setTemplates([]);
      setOverview(null);
      return;
    }
    const items = voucherItemService.getItemTemplates(selectedGameId);
    setTemplates(items);
    setOverview(voucherItemService.getGameItemOverview(selectedGameId));
  }, [selectedGameId]);

  const selectedGame = games.find(g => g.id === selectedGameId);

  // 加载投票门槛配置
  useEffect(() => {
    if (selectedGameId) {
      const threshold = gameProposalService.getGameVoteThreshold(selectedGameId);
      // 如果游戏配置了投票治理（通过阈值不为0），启用投票模式
      setVoteMode(threshold.passThreshold > 0);
    }
  }, [selectedGameId]);

  // 初始化调试模式
  useEffect(() => {
    gameProposalService.initDebugMode();
    setDebugMode(gameProposalService.isDebugMode());
  }, []);

  const toggleDebugMode = () => {
    const next = !debugMode;
    gameProposalService.setDebugMode(next);
    setDebugMode(next);
  };

  // 获取当前用户的利益方类型
  const getUserStakeholderType = (): VoteStakeholderType => {
    const players = generateSimulatedPlayers();
    const player = players.find(p => p.id === currentUserId);
    return player?.type || VoteStakeholderType.PLAYER_COMMUNITY;
  };

  const showAction = (type: 'success' | 'error', text: string) => {
    setActionMsg({ type, text });
    setTimeout(() => setActionMsg(null), 3000);
  };

  const refreshTemplates = () => {
    if (!selectedGameId) return;
    setTemplates(voucherItemService.getItemTemplates(selectedGameId));
    setOverview(voucherItemService.getGameItemOverview(selectedGameId));
  };

  // ============ 创建模板 ============
  const handleCreateTemplate = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!selectedGameId || !selectedGame) return;

    const formData = new FormData(e.currentTarget);
    const supplyPolicy = formData.get('supplyPolicy') as string;
    const isLimited = supplyPolicy === ItemSupplyPolicy.LIMITED;

    const newTemplate = voucherItemService.createItemTemplate({
      gameId: selectedGameId,
      gameName: selectedGame.name,
      name: formData.get('name') as string,
      description: formData.get('description') as string,
      itemType: formData.get('itemType') as string || 'consumable',
      icon: 'fa-box',
      supplyPolicy: supplyPolicy as ItemSupplyPolicy,
      totalSupply: isLimited ? parseInt(formData.get('totalSupply') as string) || 100 : undefined,
      pricing: {
        price: parseFloat(formData.get('price') as string) || 10,
        currency: formData.get('currency') as string || 'ACOIN',
        acceptVoucher: formData.get('acceptVoucher') === 'on',
        voucherPrice: parseFloat(formData.get('voucherPrice') as string) || 10,
      },
      gameEffect: {
        itemId: formData.get('gameItemId') as string,
        quantity: parseInt(formData.get('gameQuantity') as string) || 1,
        metadata: {},
      },
      rarity: formData.get('rarity') as string || 'common',
      consumable: formData.get('consumable') === 'on',
      stackable: formData.get('stackable') === 'on',
      isActive: true,
      createdBy: currentUserId,
    });

    // 自动铸造初始库存
    const initialMint = parseInt(formData.get('initialMint') as string) || 100;
    voucherItemService.mintItemVouchers({
      gameId: selectedGameId,
      templateId: newTemplate.id,
      count: initialMint,
    });

    setShowCreateForm(false);
    refreshTemplates();
    showAction('success', `已创建道具「${newTemplate.name}」并铸造 ${initialMint} 张凭证`);
  };

  // ============ 编辑模板 ============
  const handleEditTemplate = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!editingTemplate) return;

    const formData = new FormData(e.currentTarget);
    const updates: Partial<ItemVoucherTemplate> = {
      name: formData.get('name') as string,
      description: formData.get('description') as string,
      pricing: {
        price: parseFloat(formData.get('price') as string) || 10,
        currency: formData.get('currency') as string || 'ACOIN',
        acceptVoucher: formData.get('acceptVoucher') === 'on',
        voucherPrice: parseFloat(formData.get('voucherPrice') as string) || 10,
      },
      rarity: formData.get('rarity') as string || 'common',
      consumable: formData.get('consumable') === 'on',
      stackable: formData.get('stackable') === 'on',
      isActive: formData.get('isActive') === 'on',
    };

    voucherItemService.updateItemTemplate(editingTemplate.id, updates);
    setEditingTemplate(null);
    refreshTemplates();
    showAction('success', `已更新道具「${updates.name}」`);
  };

  // ============ 删除模板 ============
  const handleDeleteTemplate = (templateId: string, name: string) => {
    if (!confirm(`确认停售道具「${name}」？玩家将无法再购买该道具凭证。`)) return;
    voucherItemService.removeItemTemplate(templateId);
    refreshTemplates();
    showAction('success', `已停售道具「${name}」`);
  };

  // ============ 铸造凭证 ============
  const handleMint = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!showMintForm) return;

    const formData = new FormData(e.currentTarget);
    const count = parseInt(formData.get('count') as string) || 1;

    const result = voucherItemService.mintItemVouchers({
      gameId: selectedGameId!,
      templateId: showMintForm.template.id,
      count,
    });

    if (result.success) {
      showAction('success', `成功铸造 ${count} 张「${showMintForm.template.name}」凭证`);
      setShowMintForm(null);
      refreshTemplates();
    } else {
      showAction('error', result.message);
    }
  };

  // ============ 渲染 ============

  return (
    <div className="space-y-6">
      {/* 操作反馈 */}
      <AnimatePresence>
        {actionMsg && (
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className={`fixed top-4 right-4 z-50 px-4 py-3 rounded-lg shadow-lg flex items-center gap-2 ${
              actionMsg.type === 'success'
                ? 'bg-green-500/90 text-white'
                : 'bg-red-500/90 text-white'
            }`}
          >
            {actionMsg.type === 'success' ? <CheckCircle className="w-5 h-5" /> : <AlertCircle className="w-5 h-5" />}
            <span className="font-medium">{actionMsg.text}</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 头部：游戏选择器 + 操作按钮 */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-gradient-to-br from-purple-500 to-pink-500 rounded-lg">
            <Package className="w-5 h-5 text-white" />
          </div>
          <div>
            <h2 className="text-xl font-bold text-white flex items-center gap-2">
              道具凭证管理
              <span className="px-2 py-0.5 bg-purple-500/20 text-purple-300 text-xs rounded-full">
                持续运营
              </span>
            </h2>
            <p className="text-sm text-slate-400">
              创建和管理游戏道具凭证，模板更新后自动同步到游戏商店
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {selectedGameId && (
            <>
              {/* 调试模式开关 */}
              <button
                onClick={toggleDebugMode}
                title={debugMode ? '关闭调试模式（恢复正常阈值）' : '开启调试模式（降低投票门槛便于测试）'}
                className={`flex items-center gap-2 px-3 py-2 rounded-lg font-medium transition-all text-sm border ${
                  debugMode
                    ? 'bg-amber-500/20 text-amber-400 border-amber-500/40 hover:bg-amber-500/30'
                    : 'bg-slate-700/50 text-slate-500 border-slate-600/30 hover:bg-slate-600/50 hover:text-slate-300'
                }`}
              >
                {debugMode ? <Bug className="w-4 h-4" /> : <Bug className="w-4 h-4 opacity-50" />}
                <span className="hidden sm:inline">{debugMode ? '调试中' : '调试'}</span>
              </button>

              {/* 投票治理模式下的按钮 */}
              <button
                onClick={() => setShowProposalList(!showProposalList)}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-all text-sm ${
                  showProposalList
                    ? 'bg-purple-600 text-white shadow-md'
                    : 'bg-slate-700/50 text-slate-300 hover:bg-slate-600 hover:text-white border border-slate-600'
                }`}
              >
                <Vote className="w-4 h-4" />
                游戏提案
              </button>

              {/* 🆕 道具工坊入口 */}
              <Link
                to="/workshop"
                className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-violet-600 to-purple-600
                           hover:from-violet-500 hover:to-purple-500 text-white rounded-lg font-medium
                           transition-all shadow-lg shadow-violet-500/25 text-sm"
              >
                <Hammer className="w-4 h-4" />
                道具工坊
              </Link>

              {voteMode ? (
                <button
                  onClick={() => setShowProposalModal(true)}
                  className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-500 hover:to-pink-500 text-white rounded-lg font-medium transition-all shadow-lg shadow-purple-500/25 text-sm"
                >
                  <Vote className="w-4 h-4" />
                  发起投票提案
                </button>
              ) : (
                <button
                  onClick={() => setShowCreateForm(true)}
                  className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-500 hover:to-pink-500 text-white rounded-lg font-medium transition-all shadow-lg shadow-purple-500/25 text-sm"
                >
                  <Plus className="w-4 h-4" />
                  创建道具凭证
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {/* 游戏选择器 */}
      <div className="flex items-center gap-4 flex-wrap">
        <div className="flex items-center gap-2">
          <Gamepad2 className="w-5 h-5 text-slate-400" />
          <span className="text-sm text-slate-400">选择游戏：</span>
        </div>
        <div className="flex flex-wrap gap-2">
          {games.length === 0 ? (
            <span className="text-sm text-slate-500 italic">暂无已发布的游戏，请先在发布中心发布游戏</span>
          ) : (
            games.map(game => (
              <button
                key={game.id}
                onClick={() => setSelectedGameId(game.id)}
                className={`px-4 py-2 rounded-lg font-medium transition-all text-sm ${
                  selectedGameId === game.id
                    ? 'bg-purple-600 text-white shadow-md'
                    : 'bg-slate-700/50 text-slate-300 hover:bg-slate-600 hover:text-white'
                }`}
              >
                {game.name}
              </button>
            ))
          )}
        </div>
        {selectedGameId && (
          <button
            onClick={refreshTemplates}
            className="p-2 text-slate-400 hover:text-white hover:bg-slate-700/50 rounded-lg transition-colors"
            title="刷新"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        )}
      </div>

      {!selectedGameId ? (
        <div className="text-center py-16 bg-slate-800/30 rounded-xl border border-dashed border-slate-700">
          <Gamepad2 className="w-16 h-16 text-slate-600 mx-auto mb-4" />
          <h3 className="text-lg font-medium text-slate-400">请先选择游戏</h3>
          <p className="text-slate-500 text-sm mt-1">选择要管理道具凭证的游戏</p>
        </div>
      ) : (
        <>
          {/* 提案列表 */}
          {showProposalList && (
            <div className="bg-slate-800/40 border border-slate-700/50 rounded-xl p-5">
              <GameProposalList
                gameId={selectedGameId}
                gameName={selectedGame?.name || ''}
                currentUserId={currentUserId}
                currentUserName={currentUsername}
              />
            </div>
          )}

          {templates.length === 0 && !showProposalList ? (
        <div className="text-center py-16 bg-slate-800/30 rounded-xl border border-dashed border-slate-700">
          <Package className="w-16 h-16 text-slate-600 mx-auto mb-4" />
          <h3 className="text-lg font-medium text-slate-400">暂无道具凭证模板</h3>
          <p className="text-slate-500 text-sm mt-2 mb-6">
            游戏「{selectedGame?.name}」还没有配置任何道具凭证，请创建第一个道具凭证模板
          </p>
          <button
            onClick={() => setShowCreateForm(true)}
            className="px-6 py-3 bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-500 hover:to-pink-500 text-white rounded-lg font-medium transition-all shadow-lg"
          >
            <Plus className="w-4 h-4 inline-block mr-2" />
            创建第一个道具凭证
          </button>
        </div>
      ) : (
        <>
          {/* 统计概览 */}
          {overview && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {[
                { label: '道具模板', value: overview.templateCount, icon: Package, color: 'from-purple-500 to-pink-500' },
                { label: '已铸造', value: overview.totalMinted, icon: Database, color: 'from-blue-500 to-cyan-500' },
                { label: '已售出', value: overview.totalSold, icon: TrendingUp, color: 'from-green-500 to-emerald-500' },
                { label: '已兑换', value: overview.totalRedeemed, icon: Shield, color: 'from-amber-500 to-orange-500' },
              ].map((stat, idx) => (
                <motion.div
                  key={stat.label}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: idx * 0.05 }}
                  className="bg-slate-800/50 border border-slate-700/50 rounded-xl p-4"
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs text-slate-400">{stat.label}</span>
                    <div className={`p-1.5 rounded-lg bg-gradient-to-br ${stat.color}`}>
                      <stat.icon className="w-3.5 h-3.5 text-white" />
                    </div>
                  </div>
                  <p className="text-2xl font-bold text-white">{stat.value}</p>
                </motion.div>
              ))}
            </div>
          )}

          {/* 模板列表 */}
          <div className="space-y-3">
            <h3 className="text-white font-semibold flex items-center gap-2">
              <BarChart3 className="w-4 h-4 text-purple-400" />
              道具模板列表
              <span className="text-xs text-slate-500 font-normal">({templates.length} 个模板)</span>
            </h3>
            {templates.map((template, index) => {
              const rarityColor = template.rarity === 'legendary' ? 'from-orange-500 to-red-500' :
                template.rarity === 'rare' ? 'from-purple-500 to-pink-500' :
                template.rarity === 'uncommon' ? 'from-blue-500 to-cyan-500' :
                'from-slate-500 to-slate-600';

              return (
                <motion.div
                  key={template.id}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: index * 0.03 }}
                  className={`bg-slate-800/40 rounded-xl border p-5 transition-all ${
                    template.isActive
                      ? 'border-slate-700/50 hover:border-purple-500/30'
                      : 'border-slate-700/30 opacity-60'
                  }`}
                >
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-4">
                      {/* 图标 */}
                      <div className={`w-12 h-12 rounded-xl bg-gradient-to-br ${rarityColor} flex items-center justify-center text-white text-lg font-bold flex-shrink-0`}>
                        {template.name.charAt(0)}
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <h4 className="font-semibold text-white">{template.name}</h4>
                          {template.rarity && (
                            <span className={`text-xs px-1.5 py-0.5 rounded ${
                              template.rarity === 'legendary' ? 'bg-orange-500/20 text-orange-400' :
                              template.rarity === 'rare' ? 'bg-purple-500/20 text-purple-400' :
                              template.rarity === 'uncommon' ? 'bg-blue-500/20 text-blue-400' :
                              'bg-slate-500/20 text-slate-400'
                            }`}>
                              {RARITY_OPTIONS.find(r => r.value === template.rarity)?.label || template.rarity}
                            </span>
                          )}
                          {!template.isActive && (
                            <span className="text-xs px-1.5 py-0.5 bg-red-500/20 text-red-400 rounded">已停售</span>
                          )}
                        </div>
                        <p className="text-sm text-slate-400 mt-0.5">{template.description}</p>
                        <div className="flex items-center gap-3 mt-1.5 text-xs text-slate-500">
                          <span className="flex items-center gap-1">
                            <Coins className="w-3 h-3 text-yellow-500" />
                            {template.pricing.price} {template.pricing.currency}
                          </span>
                          <span>·</span>
                          <span>{ITEM_TYPES.find(t => t.value === template.itemType)?.label || template.itemType}</span>
                          <span>·</span>
                          <span>铸造: {template.mintedCount}{template.totalSupply ? ` / ${template.totalSupply}` : ''}</span>
                          <span>·</span>
                          <span>ID: {template.gameEffect?.itemId ?? '-'}</span>
                          <span>·</span>
                          <span className={`font-medium ${
                            template.supplyPolicy === ItemSupplyPolicy.LIMITED ? 'text-amber-400' : 'text-green-400'
                          }`}>
                            {template.supplyPolicy === ItemSupplyPolicy.LIMITED ? '限量' : '开放'}
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* 操作按钮 */}
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <button
                        onClick={() => setEditingTemplate(template)}
                        className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-700 transition-colors"
                        title="编辑"
                      >
                        <Edit3 className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => {
                          if (voteMode) {
                            setProposalCreateMintTemplate({ templateId: template.id, templateName: template.name });
                            setShowProposalModal(true);
                          } else {
                            setShowMintForm({ template });
                          }
                        }}
                        className="p-2 rounded-lg text-slate-400 hover:text-cyan-400 hover:bg-slate-700 transition-colors"
                        title={voteMode ? '发起铸造提案' : '铸造凭证'}
                      >
                        <Database className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => handleDeleteTemplate(template.id, template.name)}
                        className="p-2 rounded-lg text-slate-400 hover:text-red-400 hover:bg-slate-700 transition-colors"
                        title="停售"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                </motion.div>
              );
            })}
          </div>
        </>
      )}

      {/* ============ 创建模板弹窗 ============ */}
      <AnimatePresence>
        {showCreateForm && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          >
            <motion.div
              initial={{ scale: 0.95 }}
              animate={{ scale: 1 }}
              exit={{ scale: 0.95 }}
              className="bg-slate-800 rounded-2xl max-w-lg w-full max-h-[90vh] overflow-auto border border-slate-700 shadow-2xl"
            >
              <div className="p-5 border-b border-slate-700 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Package className="w-5 h-5 text-purple-400" />
                  <h3 className="text-lg font-bold text-white">创建道具凭证模板</h3>
                </div>
                <button onClick={() => setShowCreateForm(false)} className="text-slate-400 hover:text-white transition-colors">
                  <X className="w-5 h-5" />
                </button>
              </div>
              <form onSubmit={handleCreateTemplate} className="p-5 space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1">
                    <label className="text-sm font-medium text-slate-300">道具名称 *</label>
                    <input name="name" required placeholder="如：生命药水" className="w-full px-3 py-2 rounded-lg border border-slate-600 bg-slate-700 text-white text-sm focus:ring-2 focus:ring-purple-500 focus:border-transparent" />
                  </div>
                  <div className="space-y-1">
                    <label className="text-sm font-medium text-slate-300">道具类型</label>
                    <select name="itemType" className="w-full px-3 py-2 rounded-lg border border-slate-600 bg-slate-700 text-white text-sm focus:ring-2 focus:ring-purple-500">
                      {ITEM_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                    </select>
                  </div>
                </div>
                <div className="space-y-1">
                  <label className="text-sm font-medium text-slate-300">描述</label>
                  <input name="description" placeholder="道具效果描述，玩家购买时可见" className="w-full px-3 py-2 rounded-lg border border-slate-600 bg-slate-700 text-white text-sm focus:ring-2 focus:ring-purple-500" />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1">
                    <label className="text-sm font-medium text-slate-300">价格 (ACOIN)</label>
                    <input name="price" type="number" min="0" defaultValue="10" className="w-full px-3 py-2 rounded-lg border border-slate-600 bg-slate-700 text-white text-sm focus:ring-2 focus:ring-purple-500" />
                  </div>
                  <div className="space-y-1">
                    <label className="text-sm font-medium text-slate-300">货币类型</label>
                    <select name="currency" className="w-full px-3 py-2 rounded-lg border border-slate-600 bg-slate-700 text-white text-sm focus:ring-2 focus:ring-purple-500">
                      <option value="ACOIN">ACOIN</option>
                      <option value="GameCoin">GameCoin</option>
                    </select>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1">
                    <label className="text-sm font-medium text-slate-300">发行策略</label>
                    <select name="supplyPolicy" className="w-full px-3 py-2 rounded-lg border border-slate-600 bg-slate-700 text-white text-sm focus:ring-2 focus:ring-purple-500">
                      <option value={ItemSupplyPolicy.OPEN}>开放发行（可无限增发）</option>
                      <option value={ItemSupplyPolicy.LIMITED}>限量发行（总量锁定）</option>
                    </select>
                  </div>
                  <div className="space-y-1">
                    <label className="text-sm font-medium text-slate-300">稀有度</label>
                    <select name="rarity" className="w-full px-3 py-2 rounded-lg border border-slate-600 bg-slate-700 text-white text-sm focus:ring-2 focus:ring-purple-500">
                      {RARITY_OPTIONS.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                    </select>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1">
                    <label className="text-sm font-medium text-slate-300">游戏内道具ID *</label>
                    <input name="gameItemId" required placeholder="如：health_potion" className="w-full px-3 py-2 rounded-lg border border-slate-600 bg-slate-700 text-white text-sm focus:ring-2 focus:ring-purple-500" />
                  </div>
                  <div className="space-y-1">
                    <label className="text-sm font-medium text-slate-300">兑换数量</label>
                    <input name="gameQuantity" type="number" min="1" defaultValue="1" className="w-full px-3 py-2 rounded-lg border border-slate-600 bg-slate-700 text-white text-sm focus:ring-2 focus:ring-purple-500" />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1">
                    <label className="text-sm font-medium text-slate-300">初始铸造数量</label>
                    <input name="initialMint" type="number" min="0" defaultValue="100" className="w-full px-3 py-2 rounded-lg border border-slate-600 bg-slate-700 text-white text-sm focus:ring-2 focus:ring-purple-500" />
                  </div>
                  <div className="space-y-1">
                    <label className="text-sm font-medium text-slate-300">总量（限量策略）</label>
                    <input name="totalSupply" type="number" min="1" defaultValue="1000" className="w-full px-3 py-2 rounded-lg border border-slate-600 bg-slate-700 text-white text-sm focus:ring-2 focus:ring-purple-500" />
                  </div>
                </div>
                <div className="flex items-center gap-4 text-sm">
                  <label className="flex items-center gap-2 text-slate-300">
                    <input name="consumable" type="checkbox" defaultChecked className="rounded border-slate-600 bg-slate-700 text-purple-500 focus:ring-purple-500" />
                    消耗品
                  </label>
                  <label className="flex items-center gap-2 text-slate-300">
                    <input name="stackable" type="checkbox" className="rounded border-slate-600 bg-slate-700 text-purple-500 focus:ring-purple-500" />
                    可堆叠
                  </label>
                  <label className="flex items-center gap-2 text-slate-300">
                    <input name="acceptVoucher" type="checkbox" defaultChecked className="rounded border-slate-600 bg-slate-700 text-purple-500 focus:ring-purple-500" />
                    接受凭证支付
                  </label>
                </div>
                <div className="flex justify-end gap-3 pt-4 border-t border-slate-700">
                  <button type="button" onClick={() => setShowCreateForm(false)} className="px-4 py-2 rounded-lg border border-slate-600 text-slate-300 hover:text-white hover:bg-slate-700 transition-colors text-sm">取消</button>
                  <button type="submit" className="px-4 py-2 bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-500 hover:to-pink-500 text-white rounded-lg font-medium transition-all text-sm shadow-lg">
                    <Sparkles className="w-4 h-4 inline-block mr-1" />
                    创建并铸造
                  </button>
                </div>
              </form>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ============ 编辑模板弹窗 ============ */}
      <AnimatePresence>
        {editingTemplate && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          >
            <motion.div
              initial={{ scale: 0.95 }}
              animate={{ scale: 1 }}
              exit={{ scale: 0.95 }}
              className="bg-slate-800 rounded-2xl max-w-lg w-full border border-slate-700 shadow-2xl"
            >
              <div className="p-5 border-b border-slate-700 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Edit3 className="w-5 h-5 text-purple-400" />
                  <h3 className="text-lg font-bold text-white">编辑道具模板</h3>
                </div>
                <button onClick={() => setEditingTemplate(null)} className="text-slate-400 hover:text-white transition-colors">
                  <X className="w-5 h-5" />
                </button>
              </div>
              <form onSubmit={handleEditTemplate} className="p-5 space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1">
                    <label className="text-sm font-medium text-slate-300">道具名称</label>
                    <input name="name" defaultValue={editingTemplate.name} required className="w-full px-3 py-2 rounded-lg border border-slate-600 bg-slate-700 text-white text-sm focus:ring-2 focus:ring-purple-500" />
                  </div>
                  <div className="space-y-1">
                    <label className="text-sm font-medium text-slate-300">稀有度</label>
                    <select name="rarity" defaultValue={editingTemplate.rarity} className="w-full px-3 py-2 rounded-lg border border-slate-600 bg-slate-700 text-white text-sm focus:ring-2 focus:ring-purple-500">
                      {RARITY_OPTIONS.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                    </select>
                  </div>
                </div>
                <div className="space-y-1">
                  <label className="text-sm font-medium text-slate-300">描述</label>
                  <input name="description" defaultValue={editingTemplate.description} className="w-full px-3 py-2 rounded-lg border border-slate-600 bg-slate-700 text-white text-sm focus:ring-2 focus:ring-purple-500" />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1">
                    <label className="text-sm font-medium text-slate-300">价格</label>
                    <input name="price" type="number" min="0" defaultValue={editingTemplate.pricing.price} className="w-full px-3 py-2 rounded-lg border border-slate-600 bg-slate-700 text-white text-sm focus:ring-2 focus:ring-purple-500" />
                  </div>
                  <div className="space-y-1">
                    <label className="text-sm font-medium text-slate-300">货币</label>
                    <select name="currency" defaultValue={editingTemplate.pricing.currency} className="w-full px-3 py-2 rounded-lg border border-slate-600 bg-slate-700 text-white text-sm focus:ring-2 focus:ring-purple-500">
                      <option value="ACOIN">ACOIN</option>
                      <option value="GameCoin">GameCoin</option>
                    </select>
                  </div>
                </div>
                <div className="flex items-center gap-4 text-sm flex-wrap">
                  <label className="flex items-center gap-2 text-slate-300">
                    <input name="consumable" type="checkbox" defaultChecked={editingTemplate.consumable !== false} className="rounded border-slate-600 bg-slate-700 text-purple-500 focus:ring-purple-500" />
                    消耗品
                  </label>
                  <label className="flex items-center gap-2 text-slate-300">
                    <input name="stackable" type="checkbox" defaultChecked={editingTemplate.stackable} className="rounded border-slate-600 bg-slate-700 text-purple-500 focus:ring-purple-500" />
                    可堆叠
                  </label>
                  <label className="flex items-center gap-2 text-slate-300">
                    <input name="isActive" type="checkbox" defaultChecked={editingTemplate.isActive} className="rounded border-slate-600 bg-slate-700 text-purple-500 focus:ring-purple-500" />
                    上架中
                  </label>
                </div>
                <div className="flex justify-end gap-3 pt-4 border-t border-slate-700">
                  <button type="button" onClick={() => setEditingTemplate(null)} className="px-4 py-2 rounded-lg border border-slate-600 text-slate-300 hover:text-white hover:bg-slate-700 transition-colors text-sm">取消</button>
                  <button type="submit" className="px-4 py-2 bg-gradient-to-r from-purple-600 to-pink-600 text-white rounded-lg font-medium transition-all text-sm">
                    <CheckCircle className="w-4 h-4 inline-block mr-1" />
                    保存修改
                  </button>
                </div>
              </form>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ============ 铸造凭证弹窗 ============ */}
      <AnimatePresence>
        {showMintForm && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          >
            <motion.div
              initial={{ scale: 0.95 }}
              animate={{ scale: 1 }}
              exit={{ scale: 0.95 }}
              className="bg-slate-800 rounded-2xl max-w-md w-full border border-slate-700 shadow-2xl"
            >
              <div className="p-5 border-b border-slate-700 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Database className="w-5 h-5 text-cyan-400" />
                  <h3 className="text-lg font-bold text-white">铸造凭证</h3>
                </div>
                <button onClick={() => setShowMintForm(null)} className="text-slate-400 hover:text-white transition-colors">
                  <X className="w-5 h-5" />
                </button>
              </div>
              <form onSubmit={handleMint} className="p-5 space-y-4">
                <div className="p-4 bg-slate-700/30 rounded-lg">
                  <p className="text-white font-medium">{showMintForm.template.name}</p>
                  <p className="text-xs text-slate-400 mt-1">{showMintForm.template.description}</p>
                  <div className="flex items-center gap-3 mt-2 text-xs text-slate-500">
                    <span>已铸造: {showMintForm.template.mintedCount}</span>
                    {showMintForm.template.totalSupply && <span>总量: {showMintForm.template.totalSupply}</span>}
                    <span className={showMintForm.template.supplyPolicy === ItemSupplyPolicy.LIMITED ? 'text-amber-400' : 'text-green-400'}>
                      {showMintForm.template.supplyPolicy === ItemSupplyPolicy.LIMITED ? '限量' : '开放'}
                    </span>
                  </div>
                </div>
                <div className="space-y-1">
                  <label className="text-sm font-medium text-slate-300">铸造数量</label>
                  <input name="count" type="number" min="1" defaultValue="10" className="w-full px-3 py-2 rounded-lg border border-slate-600 bg-slate-700 text-white text-sm focus:ring-2 focus:ring-cyan-500" />
                </div>
                {showMintForm.template.supplyPolicy === ItemSupplyPolicy.LIMITED && showMintForm.template.totalSupply && (
                  <p className="text-xs text-amber-400">
                    限量策略，剩余可铸造: {Math.max(0, showMintForm.template.totalSupply - showMintForm.template.mintedCount)} 张
                  </p>
                )}
                <div className="flex justify-end gap-3 pt-4 border-t border-slate-700">
                  <button type="button" onClick={() => setShowMintForm(null)} className="px-4 py-2 rounded-lg border border-slate-600 text-slate-300 hover:text-white hover:bg-slate-700 transition-colors text-sm">取消</button>
                  <button type="submit" className="px-4 py-2 bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white rounded-lg font-medium transition-all text-sm shadow-lg">
                    <Database className="w-4 h-4 inline-block mr-1" />
                    开始铸造
                  </button>
                </div>
              </form>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ============ 提案创建弹窗 ============ */}
      <AnimatePresence>
        {showProposalModal && selectedGameId && (
          <GameProposalCreateModal
            gameId={selectedGameId}
            gameName={selectedGame?.name || ''}
            currentUserId={currentUserId}
            currentUserName={currentUsername}
            userStakeholderType={getUserStakeholderType()}
            initialProposalType={proposalCreateMintTemplate ? GameProposalType.MINT_ITEM : undefined}
            initialMintTemplate={proposalCreateMintTemplate}
            onClose={() => {
              setShowProposalModal(false);
              setProposalCreateMintTemplate(null);
            }}
            onCreated={() => {
              setProposalCreateMintTemplate(null);
              refreshTemplates();
            }}
          />
        )}
      </AnimatePresence>
    </>
  )}
    </div>
  );
};

export default ItemVoucherManager;
