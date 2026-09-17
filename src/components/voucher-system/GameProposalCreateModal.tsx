/**
 * 游戏提案创建弹窗
 * 用于发起各种类型的游戏内容提案
 */
import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  X, Sparkles, Package, Coins, Sword, Map, Gamepad2,
  Settings, TrendingUp, Info, Clock, Users,
} from 'lucide-react';
import {
  GameProposalType,
  GameProposalTypeLabel,
  GameVoteThreshold,
  VoteStakeholderType,
} from '@/types/gameProposal';
import { gameProposalService } from '@/services/gameProposalService';
import { voucherItemService } from '@/services/voucherItemService';
import type { ItemVoucherTemplate } from '@/voucher-system/types';
import { generateSimulatedPlayers, getPlayersByType } from '@/data/simulatedPlayers';

interface GameProposalCreateModalProps {
  gameId: string;
  gameName: string;
  currentUserId: string;
  currentUserName: string;
  userStakeholderType?: VoteStakeholderType;
  onClose: () => void;
  onCreated: () => void;
  initialProposalType?: GameProposalType;
  initialMintTemplate?: { templateId: string; templateName: string } | null;
}

const PROPOSAL_TYPE_OPTIONS = [
  { value: GameProposalType.NEW_ITEM, label: '发布新道具', icon: Package, color: 'text-purple-400' },
  { value: GameProposalType.MINT_ITEM, label: '铸造道具凭证', icon: Coins, color: 'text-cyan-400' },
  { value: GameProposalType.NEW_CURRENCY, label: '发行新游戏币', icon: Coins, color: 'text-yellow-400' },
  { value: GameProposalType.NEW_CHARACTER, label: '新增角色', icon: Sword, color: 'text-red-400' },
  { value: GameProposalType.NEW_MAP, label: '新增地图', icon: Map, color: 'text-green-400' },
  { value: GameProposalType.NEW_GAMEPLAY, label: '新增玩法', icon: Gamepad2, color: 'text-blue-400' },
  { value: GameProposalType.GAME_CONFIG, label: '游戏配置修改', icon: Settings, color: 'text-slate-400' },
];

const RARITY_OPTIONS = [
  { value: 'common', label: '普通' },
  { value: 'uncommon', label: '精良' },
  { value: 'rare', label: '稀有' },
  { value: 'legendary', label: '传说' },
];

const GameProposalCreateModal: React.FC<GameProposalCreateModalProps> = ({
  gameId,
  gameName,
  currentUserId,
  currentUserName,
  userStakeholderType,
  onClose,
  onCreated,
  initialProposalType,
  initialMintTemplate,
}) => {
  const players = generateSimulatedPlayers();
  const currentPlayer = players.find(p => p.id === currentUserId);
  const voterType = userStakeholderType || currentPlayer?.type || VoteStakeholderType.PLAYER_COMMUNITY;

  const threshold = gameProposalService.getGameVoteThreshold(gameId);

  // 表单状态
  const [step, setStep] = useState<1 | 2>(1);
  const [proposalType, setProposalType] = useState<GameProposalType>(initialProposalType || GameProposalType.NEW_ITEM);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [reason, setReason] = useState('');

  // 道具相关（仅 NEW_ITEM / MINT_ITEM）
  const [itemName, setItemName] = useState('');
  const [itemDesc, setItemDesc] = useState('');
  const [itemType, setItemType] = useState('consumable');
  const [itemRarity, setItemRarity] = useState('uncommon');
  const [itemPrice, setItemPrice] = useState(100);
  const [supplyPolicy, setSupplyPolicy] = useState<'limited' | 'open'>('limited');
  const [totalSupply, setTotalSupply] = useState(100);
  const [mintCount, setMintCount] = useState(100);
  const [gameItemId, setGameItemId] = useState('');

  // MINT_ITEM 专用状态
  const [gameTemplates, setGameTemplates] = useState<ItemVoucherTemplate[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState(initialMintTemplate?.templateId || '');

  // 从 initialMintTemplate 预填充 MINT_ITEM 表单
  useEffect(() => {
    if (initialMintTemplate) {
      setSelectedTemplateId(initialMintTemplate.templateId);
      setTitle(`【铸造凭证】${initialMintTemplate.templateName}`);
      setDescription(`为道具「${initialMintTemplate.templateName}」铸造凭证`);
      setItemName(initialMintTemplate.templateName);
    }
  }, [initialMintTemplate]);

  // 当切换到 MINT_ITEM 时加载该游戏的道具模板
  useEffect(() => {
    if (proposalType === GameProposalType.MINT_ITEM) {
      setGameTemplates(voucherItemService.getItemTemplates(gameId));
    }
  }, [proposalType, gameId]);

  // 内容相关（NEW_CHARACTER / NEW_MAP / NEW_GAMEPLAY）
  const [contentName, setContentName] = useState('');
  const [contentDesc, setContentDesc] = useState('');

  // 投票配置
  const [voteDurationHours, setVoteDurationHours] = useState(72);
  const [whitelistEnabled, setWhitelistEnabled] = useState(false);
  const [selectedWhitelist, setSelectedWhitelist] = useState<string[]>([]);

  // 收益分成（可选）
  const [revenueEnabled, setRevenueEnabled] = useState(false);
  const [gameShare, setGameShare] = useState(40);
  const [platformShare, setPlatformShare] = useState(30);
  const [creatorShare, setCreatorShare] = useState(30);

  /** 校验铸造提案的供应量，返回错误消息或 null */
  const validateMintSupply = (tpl: ItemVoucherTemplate | undefined, count: number): string | null => {
    if (!tpl) return '请先选择道具模板';
    if (tpl.supplyPolicy !== 'limited' || !tpl.totalSupply) return null; // open 类型不限量
    const remaining = Math.max(0, tpl.totalSupply - tpl.mintedCount);
    if (count > remaining) {
      return `限量道具「${tpl.name}」剩余可铸造 ${remaining} 张，你请求铸造 ${count} 张。不可超过上限。`;
    }
    return null;
  };

  const handleSubmit = () => {
    if (!title.trim()) return;

    // 铸造提案：检查道具模板铸造上限
    if (proposalType === GameProposalType.MINT_ITEM) {
      const tpl = gameTemplates.find(t => t.id === selectedTemplateId);
      const mintError = validateMintSupply(tpl, mintCount);
      if (mintError) {
        // Supply exhausted — this should not happen because canSubmit is disabled,
        // but handle edge case here as safety net.
        console.warn('[ProposalModal] 铸造提案被阻止:', mintError);
        return;
      }
    }

    const payload: any = { proposalType };

    if (proposalType === GameProposalType.NEW_ITEM) {
      payload.itemTemplate = {
        name: itemName,
        description: itemDesc,
        itemType,
        rarity: itemRarity,
        pricing: { price: itemPrice, currency: 'ACOIN' },
        gameEffect: { itemId: gameItemId, quantity: 1 },
        supplyPolicy,
        totalSupply: supplyPolicy === 'limited' ? totalSupply : undefined,
        mintCount,
      };
    } else if (proposalType === GameProposalType.MINT_ITEM) {
      const tpl = gameTemplates.find(t => t.id === selectedTemplateId);
      payload.mintData = {
        templateId: selectedTemplateId,
        templateName: tpl?.name || itemName,
        count: mintCount,
      };
    } else if ([GameProposalType.NEW_CHARACTER, GameProposalType.NEW_MAP, GameProposalType.NEW_GAMEPLAY].includes(proposalType)) {
      payload.contentData = {
        type: proposalType,
        name: contentName,
        description: contentDesc,
      };
    } else if (proposalType === GameProposalType.GAME_CONFIG) {
      payload.configChanges = { description: contentDesc };
    }

    gameProposalService.createProposal({
      gameId,
      gameName,
      title,
      description,
      reason,
      proposalType,
      payload,
      proposerId: currentUserId,
      proposerName: currentUserName,
      proposerType: voterType,
      voteDurationHours,
      whitelist: whitelistEnabled && selectedWhitelist.length > 0 ? selectedWhitelist : undefined,
      revenueSharing: revenueEnabled
        ? {
            gameShare: gameShare / 100,
            platformShare: platformShare / 100,
            creatorShare: creatorShare / 100,
          }
        : undefined,
    });

    onCreated();
    onClose();
  };

  // 铸造提案：校验当前选中模板的铸造上限
  const selectedMintTemplate = proposalType === GameProposalType.MINT_ITEM
    ? gameTemplates.find(t => t.id === selectedTemplateId)
    : null;
  const mintRemaining = selectedMintTemplate?.totalSupply
    ? Math.max(0, selectedMintTemplate.totalSupply - selectedMintTemplate.mintedCount)
    : Infinity;
  const mintSupplyExhausted = selectedMintTemplate?.totalSupply
    ? mintCount > mintRemaining
    : false;

  const canProceed = step === 1 && title.trim() && description.trim() && reason.trim()
    && (proposalType !== GameProposalType.MINT_ITEM || !!selectedTemplateId)
    && !mintSupplyExhausted;  // 铸造上限耗尽时禁止下一步
  const canSubmit = step === 2 && title.trim()
    && !mintSupplyExhausted;  // 铸造上限耗尽时禁止提交

  const playerTypes = getPlayersByType(VoteStakeholderType.PLAYER_COMMUNITY);

  return (
    <AnimatePresence>
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
          className="bg-slate-800 rounded-2xl max-w-2xl w-full max-h-[90vh] overflow-auto border border-slate-700 shadow-2xl"
        >
          {/* Header */}
          <div className="p-5 border-b border-slate-700 flex items-center justify-between sticky top-0 bg-slate-800/95 backdrop-blur-sm z-10">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-gradient-to-br from-purple-500 to-pink-500 rounded-lg">
                <Sparkles className="w-5 h-5 text-white" />
              </div>
              <div>
                <h3 className="text-lg font-bold text-white">
                  {step === 1 ? '发起游戏内容提案' : '设置投票条件'}
                </h3>
                <p className="text-sm text-slate-400">{gameName}</p>
              </div>
            </div>
            <button onClick={onClose} className="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-slate-700 transition-colors">
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="p-5 space-y-4">
            {/* 步骤指示器 */}
            <div className="flex items-center gap-4 mb-4">
              <div className={`flex items-center gap-2 ${step >= 1 ? 'text-purple-400' : 'text-slate-500'}`}>
                <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold ${step >= 1 ? 'bg-purple-500 text-white' : 'bg-slate-700 text-slate-400'}`}>1</div>
                <span className="text-sm font-medium">填写提案详情</span>
              </div>
              <div className="flex-1 h-px bg-slate-700" />
              <div className={`flex items-center gap-2 ${step >= 2 ? 'text-purple-400' : 'text-slate-500'}`}>
                <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold ${step >= 2 ? 'bg-purple-500 text-white' : 'bg-slate-700 text-slate-400'}`}>2</div>
                <span className="text-sm font-medium">设置投票条件</span>
              </div>
            </div>

            {/* 步骤1：提案详情 */}
            {step === 1 && (
              <div className="space-y-4">
                {/* 提案类型选择 */}
                <div className="space-y-1">
                  <label className="text-sm font-medium text-slate-300">提案类型 *</label>
                  <div className="grid grid-cols-2 gap-2">
                    {PROPOSAL_TYPE_OPTIONS.map(opt => (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => setProposalType(opt.value)}
                        className={`flex items-center gap-2 p-3 rounded-lg border text-sm transition-all ${
                          proposalType === opt.value
                            ? 'border-purple-500 bg-purple-500/10 text-white'
                            : 'border-slate-600 bg-slate-700/50 text-slate-400 hover:border-slate-500'
                        }`}
                      >
                        <opt.icon className={`w-4 h-4 ${opt.color}`} />
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-1">
                  <label className="text-sm font-medium text-slate-300">提案标题 *</label>
                  <input
                    value={title}
                    onChange={e => setTitle(e.target.value)}
                    placeholder="简明扼要的提案标题"
                    className="w-full px-3 py-2 rounded-lg border border-slate-600 bg-slate-700 text-white text-sm focus:ring-2 focus:ring-purple-500"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-sm font-medium text-slate-300">提案描述 *</label>
                  <textarea
                    value={description}
                    onChange={e => setDescription(e.target.value)}
                    placeholder="详细描述提案内容，包括具体修改方案..."
                    rows={3}
                    className="w-full px-3 py-2 rounded-lg border border-slate-600 bg-slate-700 text-white text-sm focus:ring-2 focus:ring-purple-500 resize-none"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-sm font-medium text-slate-300">提案理由 *</label>
                  <textarea
                    value={reason}
                    onChange={e => setReason(e.target.value)}
                    placeholder="说明为什么要发起这个提案，对游戏和玩家社区有哪些好处..."
                    rows={3}
                    className="w-full px-3 py-2 rounded-lg border border-slate-600 bg-slate-700 text-white text-sm focus:ring-2 focus:ring-purple-500 resize-none"
                  />
                </div>

                {/* 道具相关字段 */}
                {proposalType === GameProposalType.NEW_ITEM && (
                  <div className="space-y-3 p-4 bg-slate-700/30 rounded-lg border border-slate-700">
                    <p className="text-sm font-medium text-purple-400 flex items-center gap-1">
                      <Package className="w-4 h-4" /> 道具详情
                    </p>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <label className="text-xs text-slate-400">道具名称</label>
                        <input value={itemName} onChange={e => setItemName(e.target.value)}
                          placeholder="如：能量核心"
                          className="w-full px-3 py-1.5 rounded-lg border border-slate-600 bg-slate-700 text-white text-sm focus:ring-2 focus:ring-purple-500" />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs text-slate-400">稀有度</label>
                        <select value={itemRarity} onChange={e => setItemRarity(e.target.value)}
                          className="w-full px-3 py-1.5 rounded-lg border border-slate-600 bg-slate-700 text-white text-sm">
                          {RARITY_OPTIONS.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                        </select>
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs text-slate-400">价格 (ACOIN)</label>
                        <input value={itemPrice} onChange={e => setItemPrice(Number(e.target.value))}
                          type="number" min="1"
                          className="w-full px-3 py-1.5 rounded-lg border border-slate-600 bg-slate-700 text-white text-sm" />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs text-slate-400">发行策略</label>
                        <select value={supplyPolicy} onChange={e => setSupplyPolicy(e.target.value as 'limited' | 'open')}
                          className="w-full px-3 py-1.5 rounded-lg border border-slate-600 bg-slate-700 text-white text-sm">
                          <option value="limited">限量发行</option>
                          <option value="open">开放发行</option>
                        </select>
                      </div>
                      {supplyPolicy === 'limited' && (
                        <div className="space-y-1">
                          <label className="text-xs text-slate-400">总量</label>
                          <input value={totalSupply} onChange={e => setTotalSupply(Number(e.target.value))}
                            type="number" min="1"
                            className="w-full px-3 py-1.5 rounded-lg border border-slate-600 bg-slate-700 text-white text-sm" />
                        </div>
                      )}
                      <div className="space-y-1">
                        <label className="text-xs text-slate-400">铸造数量</label>
                        <input value={mintCount} onChange={e => setMintCount(Number(e.target.value))}
                          type="number" min="1"
                          className="w-full px-3 py-1.5 rounded-lg border border-slate-600 bg-slate-700 text-white text-sm" />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs text-slate-400">游戏内道具ID</label>
                        <input value={gameItemId} onChange={e => setGameItemId(e.target.value)}
                          placeholder="如：skin_star_explorer"
                          className="w-full px-3 py-1.5 rounded-lg border border-slate-600 bg-slate-700 text-white text-sm" />
                      </div>
                    </div>
                  </div>
                )}

                {/* MINT_ITEM 道具铸造模板选择器 */}
                {proposalType === GameProposalType.MINT_ITEM && (
                  <div className="space-y-3 p-4 bg-slate-700/30 rounded-lg border border-slate-700">
                    <p className="text-sm font-medium text-cyan-400 flex items-center gap-1">
                      <Coins className="w-4 h-4" /> 铸造详情
                    </p>
                    <div className="space-y-3">
                      <div className="space-y-1">
                        <label className="text-xs text-slate-400">选择道具模板</label>
                        <select
                          value={selectedTemplateId}
                          onChange={e => {
                            setSelectedTemplateId(e.target.value);
                            const tpl = gameTemplates.find(t => t.id === e.target.value);
                            if (tpl) {
                              setItemName(tpl.name);
                              setTitle(`【铸造凭证】${tpl.name}`);
                              setDescription(`为${tpl.gameEffect?.schemaName === 'content' ? '内容' : '道具'}「${tpl.name}」铸造凭证`);
                            }
                          }}
                          className="w-full px-3 py-1.5 rounded-lg border border-slate-600 bg-slate-700 text-white text-sm"
                        >
                          <option value="">-- 请选择模板 --</option>
                          {gameTemplates.map(t => (
                            <option key={t.id} value={t.id}>
                              {t.name}（{t.gameEffect?.schemaName === 'content' ? '内容·' : ''}已铸造 {t.mintedCount}{t.totalSupply ? ` / ${t.totalSupply}` : ''}）
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs text-slate-400">铸造数量</label>
                        <input
                          value={mintCount}
                          onChange={e => setMintCount(Number(e.target.value))}
                          type="number" min="1"
                          className="w-full px-3 py-1.5 rounded-lg border border-slate-600 bg-slate-700 text-white text-sm"
                        />
                      </div>
                      {selectedTemplateId && (() => {
                        const tpl = gameTemplates.find(t => t.id === selectedTemplateId);
                        if (tpl && tpl.totalSupply) {
                          const remaining = Math.max(0, tpl.totalSupply - tpl.mintedCount);
                          const exceeded = mintCount > remaining;
                          return (
                            <div className="space-y-1">
                              <p className={`text-xs ${exceeded ? 'text-red-400' : 'text-amber-400'}`}>
                                {exceeded ? '❌' : '⚠️'} 限量策略，剩余可铸造: {remaining} 张
                              </p>
                              {exceeded && (
                                <p className="text-xs text-red-400/80">
                                  铸造数量 ({mintCount}) 已超出上限，无法发起投票。请减少数量。
                                </p>
                              )}
                            </div>
                          );
                        }
                        return null;
                      })()}
                      {gameTemplates.length === 0 && !initialMintTemplate && (
                        <p className="text-xs text-slate-500">该游戏暂无道具模板，请先创建道具</p>
                      )}
                    </div>
                  </div>
                )}

                {/* 内容相关字段 */}
                {[GameProposalType.NEW_CHARACTER, GameProposalType.NEW_MAP, GameProposalType.NEW_GAMEPLAY].includes(proposalType) && (
                  <div className="space-y-3 p-4 bg-slate-700/30 rounded-lg border border-slate-700">
                    <p className="text-sm font-medium text-blue-400 flex items-center gap-1">
                      <Gamepad2 className="w-4 h-4" /> 内容详情
                    </p>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <label className="text-xs text-slate-400">内容名称</label>
                        <input value={contentName} onChange={e => setContentName(e.target.value)}
                          placeholder="如：暗影刺客/火山地图"
                          className="w-full px-3 py-1.5 rounded-lg border border-slate-600 bg-slate-700 text-white text-sm" />
                      </div>
                      <div className="space-y-1 col-span-2">
                        <label className="text-xs text-slate-400">内容描述</label>
                        <textarea value={contentDesc} onChange={e => setContentDesc(e.target.value)}
                          placeholder="描述新增内容的详细信息..."
                          rows={2}
                          className="w-full px-3 py-1.5 rounded-lg border border-slate-600 bg-slate-700 text-white text-sm resize-none" />
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* 步骤2：投票条件 */}
            {step === 2 && (
              <div className="space-y-4">
                {/* 当前投票门槛提示 */}
                <div className="p-4 bg-slate-700/30 rounded-lg border border-amber-500/20">
                  <p className="text-sm font-medium text-amber-400 flex items-center gap-1 mb-2">
                    <Info className="w-4 h-4" /> 当前游戏投票门槛
                  </p>
                  <div className="grid grid-cols-3 gap-2 text-xs">
                    <div><span className="text-slate-500">游戏方权重</span><br /><span className="text-white">{Math.round(threshold.weights.gameDeveloper * 100)}%</span></div>
                    <div><span className="text-slate-500">玩家权重</span><br /><span className="text-white">{Math.round(threshold.weights.playerCommunity * 100)}%</span></div>
                    <div><span className="text-slate-500">平台权重</span><br /><span className="text-white">{Math.round(threshold.weights.platform * 100)}%</span></div>
                    <div><span className="text-slate-500">通过阈值</span><br /><span className="text-white">{Math.round(threshold.passThreshold * 100)}%</span></div>
                    <div><span className="text-slate-500">法定人数</span><br /><span className="text-white">{Math.round(threshold.quorumRate * 100)}%</span></div>
                    <div><span className="text-slate-500">否决权</span><br /><span className="text-white">{threshold.vetoEnabled ? '已启用' : '未启用'}</span></div>
                  </div>
                </div>

                {/* 投票时长 */}
                <div className="space-y-1">
                  <label className="text-sm font-medium text-slate-300 flex items-center gap-1">
                    <Clock className="w-4 h-4" /> 投票时长
                  </label>
                  <div className="flex items-center gap-3">
                    <input
                      type="range"
                      min={threshold.minVoteDurationHours}
                      max={threshold.maxVoteDurationHours}
                      step="24"
                      value={voteDurationHours}
                      onChange={e => setVoteDurationHours(Number(e.target.value))}
                      className="flex-1 accent-purple-500"
                    />
                    <span className="text-white font-medium min-w-[80px] text-right">
                      {voteDurationHours >= 24 ? `${Math.floor(voteDurationHours / 24)} 天` : ''}{voteDurationHours % 24 > 0 ? ` ${voteDurationHours % 24}h` : ''}
                    </span>
                  </div>
                  <p className="text-xs text-slate-500">
                    最少 {threshold.minVoteDurationHours}h，最多 {threshold.maxVoteDurationHours}h
                  </p>
                </div>

                {/* 白名单 */}
                <div className="space-y-2">
                  <label className="flex items-center gap-2 text-sm text-slate-300">
                    <input
                      type="checkbox"
                      checked={whitelistEnabled}
                      onChange={e => setWhitelistEnabled(e.target.checked)}
                      className="rounded border-slate-600 bg-slate-700 text-purple-500"
                    />
                    <Users className="w-4 h-4" /> 启用投票白名单（限定投票人）
                  </label>
                  {whitelistEnabled && (
                    <div className="p-3 bg-slate-700/30 rounded-lg border border-slate-700">
                      <p className="text-xs text-slate-400 mb-2">选择允许投票的玩家（默认全部可投）</p>
                      <div className="flex flex-wrap gap-1 max-h-32 overflow-y-auto">
                        {playerTypes.slice(0, 15).map(p => (
                          <button
                            key={p.id}
                            type="button"
                            onClick={() => {
                              setSelectedWhitelist(prev =>
                                prev.includes(p.id) ? prev.filter(id => id !== p.id) : [...prev, p.id]
                              );
                            }}
                            className={`text-xs px-2 py-1 rounded-full transition-colors ${
                              selectedWhitelist.includes(p.id)
                                ? 'bg-purple-500 text-white'
                                : 'bg-slate-700 text-slate-400 hover:text-white'
                            }`}
                          >
                            {p.name}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                {/* 收益分成（仅 NEW_ITEM 提案） */}
                {proposalType === GameProposalType.NEW_ITEM && (
                  <div className="space-y-2">
                    <label className="flex items-center gap-2 text-sm text-slate-300">
                      <input
                        type="checkbox"
                        checked={revenueEnabled}
                        onChange={e => setRevenueEnabled(e.target.checked)}
                        className="rounded border-slate-600 bg-slate-700 text-purple-500"
                      />
                      <TrendingUp className="w-4 h-4" /> 设置收益分成
                    </label>
                    {revenueEnabled && (
                      <div className="p-3 bg-slate-700/30 rounded-lg border border-slate-700 space-y-2">
                        <div className="grid grid-cols-3 gap-2">
                          <div className="space-y-1">
                            <label className="text-xs text-slate-400">游戏方 (%)</label>
                            <input type="number" value={gameShare} onChange={e => setGameShare(Number(e.target.value))}
                              min="0" max="100" className="w-full px-2 py-1.5 rounded border border-slate-600 bg-slate-700 text-white text-sm" />
                          </div>
                          <div className="space-y-1">
                            <label className="text-xs text-slate-400">平台 (%)</label>
                            <input type="number" value={platformShare} onChange={e => setPlatformShare(Number(e.target.value))}
                              min="0" max="100" className="w-full px-2 py-1.5 rounded border border-slate-600 bg-slate-700 text-white text-sm" />
                          </div>
                          <div className="space-y-1">
                            <label className="text-xs text-slate-400">创作者 (%)</label>
                            <input type="number" value={creatorShare} onChange={e => setCreatorShare(Number(e.target.value))}
                              min="0" max="100" className="w-full px-2 py-1.5 rounded border border-slate-600 bg-slate-700 text-white text-sm" />
                          </div>
                        </div>
                        {gameShare + platformShare + creatorShare !== 100 && (
                          <p className="text-xs text-amber-400">注意：三方比例之和应为 100%（当前 {gameShare + platformShare + creatorShare}%）</p>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* 底部按钮 */}
          <div className="p-5 border-t border-slate-700 flex justify-between">
            <div>
              {step === 2 && (
                <button
                  type="button"
                  onClick={() => setStep(1)}
                  className="px-4 py-2 rounded-lg border border-slate-600 text-slate-300 hover:text-white hover:bg-slate-700 transition-colors text-sm"
                >
                  上一步
                </button>
              )}
            </div>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 rounded-lg border border-slate-600 text-slate-300 hover:text-white hover:bg-slate-700 transition-colors text-sm"
              >
                取消
              </button>
              {step === 1 ? (
                <button
                  type="button"
                  disabled={!canProceed}
                  onClick={() => setStep(2)}
                  className="px-6 py-2 bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-500 hover:to-pink-500 text-white rounded-lg font-medium text-sm shadow-lg disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                >
                  下一步
                </button>
              ) : (
                <button
                  type="button"
                  disabled={!canSubmit}
                  onClick={handleSubmit}
                  className="px-6 py-2 bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-500 hover:to-pink-500 text-white rounded-lg font-medium text-sm shadow-lg disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                >
                  <Sparkles className="w-4 h-4 inline-block mr-1" />
                  发起投票
                </button>
              )}
            </div>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
};

export default GameProposalCreateModal;
