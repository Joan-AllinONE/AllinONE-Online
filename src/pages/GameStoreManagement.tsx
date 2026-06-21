/**
 * GameStoreManagement - 商家游戏商店自助管理
 *
 * 任何已登录用户均可访问，用于注册游戏、管理道具模板、铸造凭证。
 * 数据隔离：商家只能看到和操作自己注册的游戏（通过 ownerId 过滤）。
 * 管理员可在 PlatformAdmin 中进行全量监管。
 */
import { useState, useEffect, useContext } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { AuthContext } from '@/contexts/authContext';
import { platformGameStoreService } from '@/services/platformGameStoreService';
import { voucherItemService } from '@/services/voucherItemService';
import type { ExternalGameStore } from '@/types/platformGameStore';
import type { ItemVoucherTemplate } from '@/voucher-system/types';
import { ItemSupplyPolicy } from '@/voucher-system/types';
import {
  Plus, Edit, Trash2, Gamepad2, Package, Save,
  ChevronDown, Check, AlertCircle, Coins, Store,
  ArrowLeft, Settings, LogIn,
} from 'lucide-react';

// ==================== 类型 ====================

interface GameFormData {
  gameId: string;
  gameName: string;
  gameIcon: string;
  developer: string;
  description: string;
  primaryColor: string;
  secondaryColor: string;
}

interface ItemFormData {
  gameId: string;
  name: string;
  description: string;
  itemType: string;
  icon: string;
  rarity: string;
  supplyPolicy: 'limited' | 'open';
  totalSupply: number;
  price: number;
  currency: string;
  gameItemId: string;
  quantity: number;
  mintCount: number;
}

// ==================== 表单初始值 ====================

const EMPTY_GAME_FORM: GameFormData = {
  gameId: '',
  gameName: '',
  gameIcon: '🎮',
  developer: '',
  description: '',
  primaryColor: '#7c3aed',
  secondaryColor: '#06b6d4',
};

const EMPTY_ITEM_FORM: ItemFormData = {
  gameId: '',
  name: '',
  description: '',
  itemType: 'consumable',
  icon: 'fa-box',
  rarity: 'common',
  supplyPolicy: 'open',
  totalSupply: 100,
  price: 50,
  currency: 'ACOIN',
  gameItemId: '',
  quantity: 1,
  mintCount: 100,
};

// ==================== 未登录提示 ====================

function LoginRequired() {
  const navigate = useNavigate();
  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-900 to-slate-800 flex items-center justify-center">
      <div className="text-center">
        <LogIn className="w-16 h-16 text-slate-600 mx-auto mb-4" />
        <h2 className="text-xl font-bold text-white mb-2">请先登录</h2>
        <p className="text-slate-400 mb-6">登录后即可注册和管理您的游戏商店</p>
        <button
          onClick={() => navigate('/login')}
          className="px-6 py-3 bg-purple-600 hover:bg-purple-700 rounded-lg text-sm font-medium text-white transition-colors"
        >
          前往登录
        </button>
      </div>
    </div>
  );
}

// ==================== 主组件 ====================

export default function GameStoreManagement() {
  const { currentUser, isAuthenticated } = useContext(AuthContext);
  const navigate = useNavigate();

  const [games, setGames] = useState<ExternalGameStore[]>([]);
  const [selectedGameId, setSelectedGameId] = useState<string | null>(null);
  const [templates, setTemplates] = useState<ItemVoucherTemplate[]>([]);
  const [showGameForm, setShowGameForm] = useState(false);
  const [showItemForm, setShowItemForm] = useState(false);
  const [editingGameId, setEditingGameId] = useState<string | null>(null);
  const [gameForm, setGameForm] = useState<GameFormData>(EMPTY_GAME_FORM);
  const [itemForm, setItemForm] = useState<ItemFormData>(EMPTY_ITEM_FORM);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [mintCount, setMintCount] = useState<Record<string, number>>({});

  const ownerId = currentUser?.id || '';

  // 刷新数据（只加载当前用户的游戏）
  const refresh = () => {
    setGames(platformGameStoreService.getGames(false, ownerId));
    if (selectedGameId) {
      setTemplates(voucherItemService.getItemTemplates(selectedGameId));
    }
  };

  useEffect(refresh, [selectedGameId, ownerId]);

  useEffect(() => {
    const handler = () => refresh();
    window.addEventListener('platform-store-purchased', handler);
    return () => window.removeEventListener('platform-store-purchased', handler);
  }, [selectedGameId, ownerId]);

  // ============ 消息提示 ============

  const showMsg = (type: 'success' | 'error', text: string) => {
    setMessage({ type, text });
    setTimeout(() => setMessage(null), 3000);
  };

  // ============ 游戏管理 ============

  const handleRegisterGame = () => {
    if (!gameForm.gameId || !gameForm.gameName || !gameForm.developer) {
      showMsg('error', '请填写游戏ID、名称和开发商');
      return;
    }

    const existing = platformGameStoreService.getGame(gameForm.gameId);
    if (existing && !editingGameId) {
      showMsg('error', `游戏ID "${gameForm.gameId}" 已存在`);
      return;
    }

    if (editingGameId) {
      platformGameStoreService.updateGame(editingGameId, {
        gameName: gameForm.gameName,
        gameIcon: gameForm.gameIcon,
        developer: gameForm.developer,
        description: gameForm.description,
        theme: {
          primaryColor: gameForm.primaryColor,
          secondaryColor: gameForm.secondaryColor,
        },
      });
      showMsg('success', '游戏信息已更新');
    } else {
      platformGameStoreService.registerGame({
        gameId: gameForm.gameId,
        gameName: gameForm.gameName,
        gameIcon: gameForm.gameIcon,
        developer: gameForm.developer,
        description: gameForm.description,
        theme: {
          primaryColor: gameForm.primaryColor,
          secondaryColor: gameForm.secondaryColor,
        },
        isActive: true,
        ownerId,
        ownerName: currentUser?.nickname || currentUser?.username || '',
      });
      showMsg('success', `游戏 "${gameForm.gameName}" 已注册`);
    }

    setShowGameForm(false);
    setEditingGameId(null);
    setGameForm(EMPTY_GAME_FORM);
    refresh();
  };

  const handleEditGame = (game: ExternalGameStore) => {
    setEditingGameId(game.gameId);
    setGameForm({
      gameId: game.gameId,
      gameName: game.gameName,
      gameIcon: game.gameIcon,
      developer: game.developer,
      description: game.description,
      primaryColor: game.theme.primaryColor,
      secondaryColor: game.theme.secondaryColor,
    });
    setShowGameForm(true);
  };

  const handleDeleteGame = (gameId: string) => {
    if (!confirm('确定要下架该游戏吗？下架后玩家将无法购买该游戏的道具。')) return;
    platformGameStoreService.deleteGame(gameId);
    if (selectedGameId === gameId) setSelectedGameId(null);
    showMsg('success', '游戏已下架');
    refresh();
  };

  // ============ 道具管理 ============

  const handleCreateItem = () => {
    if (!itemForm.gameId || !itemForm.name || !itemForm.gameItemId) {
      showMsg('error', '请填写所属游戏、道具名称和游戏道具ID');
      return;
    }

    const store = platformGameStoreService.getGame(itemForm.gameId);
    voucherItemService.createItemTemplate({
      gameId: itemForm.gameId,
      gameName: store?.gameName || itemForm.gameId,
      name: itemForm.name,
      description: itemForm.description,
      itemType: itemForm.itemType,
      icon: itemForm.icon,
      supplyPolicy: itemForm.supplyPolicy === 'limited' ? ItemSupplyPolicy.LIMITED : ItemSupplyPolicy.OPEN,
      totalSupply: itemForm.supplyPolicy === 'limited' ? itemForm.totalSupply : undefined,
      pricing: {
        price: itemForm.price,
        currency: itemForm.currency,
        acceptVoucher: true,
        voucherPrice: itemForm.price,
      },
      gameEffect: {
        itemId: itemForm.gameItemId,
        quantity: itemForm.quantity,
        metadata: {},
      },
      rarity: itemForm.rarity,
      consumable: itemForm.itemType !== 'permanent',
      stackable: true,
      createdBy: ownerId,
      isActive: true,
    });

    refresh();
    showMsg('success', `道具 "${itemForm.name}" 已创建`);

    setShowItemForm(false);
    setItemForm({ ...EMPTY_ITEM_FORM, gameId: selectedGameId || '' });
  };

  const handleMint = (templateId: string, templateName: string, gameId: string) => {
    const count = mintCount[templateId] || 100;
    const result = voucherItemService.mintItemVouchers({
      gameId,
      templateId,
      count,
    });
    if (result.success) {
      showMsg('success', `已铸造 ${result.vouchers.length} 张 "${templateName}" 凭证`);
    } else {
      showMsg('error', result.message);
    }
    refresh();
  };

  // ============ 未登录拦截 ============

  if (!isAuthenticated || !currentUser) {
    return <LoginRequired />;
  }

  // ============ 渲染 ============

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-900 to-slate-800 text-white">
      {/* 顶部导航 */}
      <div className="sticky top-0 z-40 bg-slate-900/90 backdrop-blur border-b border-slate-700/50 px-4 py-3">
        <div className="max-w-5xl mx-auto flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <button
              onClick={() => navigate('/game-store')}
              className="p-1.5 hover:bg-slate-700 rounded-lg text-slate-400 hover:text-white transition-colors"
              title="返回商店"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
            <div>
              <h1 className="text-lg font-bold flex items-center gap-2">
                <Store className="w-5 h-5 text-purple-400" />
                我的游戏商店管理
              </h1>
              <p className="text-xs text-slate-500">商家: {currentUser.nickname || currentUser.username}</p>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-4 py-6">
        {/* 消息提示 */}
        {message && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            className={`mb-4 p-3 rounded-lg flex items-center gap-2 ${
              message.type === 'success' ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'
            }`}
          >
            {message.type === 'success' ? <Check className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
            {message.text}
          </motion.div>
        )}

        {/* 游戏列表 */}
        <section className="mb-8">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-bold flex items-center gap-2">
              <Gamepad2 className="w-5 h-5 text-purple-400" />
              我的游戏 ({games.filter(g => g.isActive).length})
            </h2>
            <button
              onClick={() => {
                setEditingGameId(null);
                setGameForm(EMPTY_GAME_FORM);
                setShowGameForm(!showGameForm);
                setShowItemForm(false);
              }}
              className="flex items-center gap-1.5 px-3 py-2 bg-purple-600 hover:bg-purple-700 rounded-lg text-sm font-medium transition-colors"
            >
              <Plus className="w-4 h-4" />
              注册游戏
            </button>
          </div>

          {/* 游戏表单 */}
          {showGameForm && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              className="mb-4 p-4 bg-slate-800 rounded-xl border border-purple-500/20 overflow-hidden"
            >
              <h3 className="text-white font-semibold mb-3">{editingGameId ? '编辑游戏' : '注册新游戏'}</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-slate-400 mb-1 block">游戏ID (ext-xxx-xxx)</label>
                  <input
                    value={gameForm.gameId}
                    onChange={e => setGameForm(f => ({ ...f, gameId: e.target.value }))}
                    disabled={!!editingGameId}
                    className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white text-sm disabled:opacity-50"
                    placeholder="ext-genshin-1717300000000"
                  />
                </div>
                <div>
                  <label className="text-xs text-slate-400 mb-1 block">游戏名称</label>
                  <input
                    value={gameForm.gameName}
                    onChange={e => setGameForm(f => ({ ...f, gameName: e.target.value }))}
                    className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white text-sm"
                    placeholder="原神"
                  />
                </div>
                <div>
                  <label className="text-xs text-slate-400 mb-1 block">图标 (emoji)</label>
                  <input
                    value={gameForm.gameIcon}
                    onChange={e => setGameForm(f => ({ ...f, gameIcon: e.target.value }))}
                    className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white text-sm"
                    placeholder="🎮"
                  />
                </div>
                <div>
                  <label className="text-xs text-slate-400 mb-1 block">开发商</label>
                  <input
                    value={gameForm.developer}
                    onChange={e => setGameForm(f => ({ ...f, developer: e.target.value }))}
                    className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white text-sm"
                    placeholder="miHoYo"
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className="text-xs text-slate-400 mb-1 block">简介</label>
                  <input
                    value={gameForm.description}
                    onChange={e => setGameForm(f => ({ ...f, description: e.target.value }))}
                    className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white text-sm"
                    placeholder="开放世界冒险游戏"
                  />
                </div>
                <div>
                  <label className="text-xs text-slate-400 mb-1 block">主色调</label>
                  <input
                    type="color"
                    value={gameForm.primaryColor}
                    onChange={e => setGameForm(f => ({ ...f, primaryColor: e.target.value }))}
                    className="w-full h-9 bg-slate-700 border border-slate-600 rounded-lg cursor-pointer"
                  />
                </div>
                <div>
                  <label className="text-xs text-slate-400 mb-1 block">次要色</label>
                  <input
                    type="color"
                    value={gameForm.secondaryColor}
                    onChange={e => setGameForm(f => ({ ...f, secondaryColor: e.target.value }))}
                    className="w-full h-9 bg-slate-700 border border-slate-600 rounded-lg cursor-pointer"
                  />
                </div>
              </div>
              <div className="flex items-center gap-2 mt-4">
                <button onClick={handleRegisterGame} className="px-4 py-2 bg-purple-600 hover:bg-purple-700 rounded-lg text-sm font-medium flex items-center gap-1.5">
                  <Save className="w-4 h-4" />
                  {editingGameId ? '保存修改' : '注册'}
                </button>
                <button onClick={() => { setShowGameForm(false); setEditingGameId(null); }} className="px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded-lg text-sm">
                  取消
                </button>
              </div>
            </motion.div>
          )}

          {/* 游戏卡片 */}
          <div className="space-y-3">
            {games.length === 0 && (
              <div className="text-center py-10 bg-slate-800/40 rounded-xl border border-slate-700/30">
                <Gamepad2 className="w-12 h-12 text-slate-600 mx-auto mb-3" />
                <p className="text-slate-500">您还没有注册游戏，点击上方按钮注册第一个游戏</p>
              </div>
            )}
            {games.map(game => (
              <motion.div
                key={game.id}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className={`flex items-center justify-between p-4 rounded-xl border transition-all cursor-pointer ${
                  selectedGameId === game.gameId
                    ? 'bg-purple-600/10 border-purple-500/40'
                    : 'bg-slate-800/60 border-slate-700/50 hover:border-slate-600'
                } ${!game.isActive ? 'opacity-50' : ''}`}
                onClick={() => setSelectedGameId(selectedGameId === game.gameId ? null : game.gameId)}
              >
                <div className="flex items-center gap-4">
                  <div className="text-3xl">{game.gameIcon}</div>
                  <div>
                    <h3 className="font-bold text-white">{game.gameName}</h3>
                    <p className="text-xs text-slate-400">{game.developer} · {game.description}</p>
                    <p className="text-xs text-slate-500 font-mono mt-0.5">{game.gameId}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {!game.isActive && <span className="text-xs px-2 py-0.5 bg-red-500/20 text-red-400 rounded">已下架</span>}
                  <button onClick={(e) => { e.stopPropagation(); handleEditGame(game); }} className="p-2 hover:bg-slate-700 rounded-lg text-slate-400 hover:text-white" title="编辑">
                    <Edit className="w-4 h-4" />
                  </button>
                  <button onClick={(e) => { e.stopPropagation(); handleDeleteGame(game.gameId); }} className="p-2 hover:bg-red-500/20 rounded-lg text-slate-400 hover:text-red-400" title="下架">
                    <Trash2 className="w-4 h-4" />
                  </button>
                  <ChevronDown className={`w-4 h-4 text-slate-500 transition-transform ${selectedGameId === game.gameId ? 'rotate-180' : ''}`} />
                </div>
              </motion.div>
            ))}
          </div>
        </section>

        {/* 道具管理 */}
        {selectedGameId && (
          <motion.section initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mb-8">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-bold flex items-center gap-2">
                <Package className="w-5 h-5 text-cyan-400" />
                道具模板 ({templates.length})
              </h2>
              <button
                onClick={() => {
                  setItemForm({ ...EMPTY_ITEM_FORM, gameId: selectedGameId });
                  setShowItemForm(!showItemForm);
                }}
                className="flex items-center gap-1.5 px-3 py-2 bg-cyan-600 hover:bg-cyan-700 rounded-lg text-sm font-medium transition-colors"
              >
                <Plus className="w-4 h-4" />
                创建道具
              </button>
            </div>

            {/* 道具表单 */}
            {showItemForm && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                className="mb-4 p-4 bg-slate-800 rounded-xl border border-cyan-500/20 overflow-hidden"
              >
                <h3 className="text-white font-semibold mb-3">创建道具模板</h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-slate-400 mb-1 block">道具名称</label>
                    <input
                      value={itemForm.name}
                      onChange={e => setItemForm(f => ({ ...f, name: e.target.value }))}
                      className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white text-sm"
                      placeholder="月卡"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-slate-400 mb-1 block">游戏道具ID</label>
                    <input
                      value={itemForm.gameItemId}
                      onChange={e => setItemForm(f => ({ ...f, gameItemId: e.target.value }))}
                      className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white text-sm"
                      placeholder="monthly_card"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-slate-400 mb-1 block">类型</label>
                    <select
                      value={itemForm.itemType}
                      onChange={e => setItemForm(f => ({ ...f, itemType: e.target.value }))}
                      className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white text-sm"
                    >
                      <option value="consumable">消耗品</option>
                      <option value="permanent">永久道具</option>
                      <option value="currency">货币</option>
                      <option value="buff">增益</option>
                      <option value="package">礼包</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-xs text-slate-400 mb-1 block">稀有度</label>
                    <select
                      value={itemForm.rarity}
                      onChange={e => setItemForm(f => ({ ...f, rarity: e.target.value }))}
                      className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white text-sm"
                    >
                      <option value="common">普通</option>
                      <option value="uncommon">精良</option>
                      <option value="rare">稀有</option>
                      <option value="legendary">传说</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-xs text-slate-400 mb-1 block">发行策略</label>
                    <select
                      value={itemForm.supplyPolicy}
                      onChange={e => setItemForm(f => ({ ...f, supplyPolicy: e.target.value as 'limited' | 'open' }))}
                      className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white text-sm"
                    >
                      <option value="open">开放型</option>
                      <option value="limited">限量型</option>
                    </select>
                  </div>
                  {itemForm.supplyPolicy === 'limited' && (
                    <div>
                      <label className="text-xs text-slate-400 mb-1 block">总量上限</label>
                      <input
                        type="number"
                        value={itemForm.totalSupply}
                        onChange={e => setItemForm(f => ({ ...f, totalSupply: Number(e.target.value) }))}
                        className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white text-sm"
                      />
                    </div>
                  )}
                  <div>
                    <label className="text-xs text-slate-400 mb-1 block">价格</label>
                    <input
                      type="number"
                      value={itemForm.price}
                      onChange={e => setItemForm(f => ({ ...f, price: Number(e.target.value) }))}
                      className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white text-sm"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-slate-400 mb-1 block">货币</label>
                    <select
                      value={itemForm.currency}
                      onChange={e => setItemForm(f => ({ ...f, currency: e.target.value }))}
                      className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white text-sm"
                    >
                      <option value="ACOIN">A币</option>
                      <option value="gameCoins">游戏币</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-xs text-slate-400 mb-1 block">初次铸造数量</label>
                    <input
                      type="number"
                      value={itemForm.mintCount}
                      onChange={e => setItemForm(f => ({ ...f, mintCount: Number(e.target.value) }))}
                      className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white text-sm"
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <label className="text-xs text-slate-400 mb-1 block">描述</label>
                    <input
                      value={itemForm.description}
                      onChange={e => setItemForm(f => ({ ...f, description: e.target.value }))}
                      className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white text-sm"
                      placeholder="每月领取300原石"
                    />
                  </div>
                </div>
                <div className="flex items-center gap-2 mt-4">
                  <button onClick={handleCreateItem} className="px-4 py-2 bg-cyan-600 hover:bg-cyan-700 rounded-lg text-sm font-medium flex items-center gap-1.5">
                    <Save className="w-4 h-4" />
                    创建并铸造
                  </button>
                  <button onClick={() => setShowItemForm(false)} className="px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded-lg text-sm">
                    取消
                  </button>
                </div>
              </motion.div>
            )}

            {/* 道具列表 */}
            <div className="space-y-3">
              {templates.length === 0 && (
                <p className="text-slate-500 text-center py-8">暂无道具模板，点击上方按钮创建</p>
              )}
              {templates.map(t => {
                const poolCount = voucherItemService.getPoolItemVoucherCount(t.id);
                return (
                  <motion.div
                    key={t.id}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className={`p-4 rounded-xl border transition-all ${
                      t.isActive ? 'bg-slate-800/60 border-slate-700/50' : 'bg-slate-800/30 border-slate-700/30 opacity-60'
                    }`}
                  >
                    <div className="flex items-center justify-between flex-wrap gap-3">
                      <div>
                        <h4 className="font-bold text-white">{t.name}</h4>
                        <p className="text-xs text-slate-400">{t.description}</p>
                        <div className="flex items-center gap-2 mt-1 flex-wrap">
                          <span className="text-xs px-1.5 py-0.5 bg-slate-700 rounded text-slate-300">{t.itemType}</span>
                          <span className="text-xs px-1.5 py-0.5 bg-slate-700 rounded text-slate-300">{t.rarity}</span>
                          <span className="text-xs font-mono text-slate-500">{t.id}</span>
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        <div className="text-right">
                          <div className="flex items-center gap-1 text-sm">
                            <Coins className="w-4 h-4 text-yellow-500" />
                            <span className="text-white font-bold">{t.pricing.price}</span>
                            <span className="text-xs text-slate-500">{t.pricing.currency}</span>
                          </div>
                          <div className="text-xs text-slate-500 mt-0.5">
                            库存: {poolCount}
                            {t.supplyPolicy === 'limited' && t.totalSupply && ` / ${t.totalSupply - t.mintedCount} 可铸`}
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <input
                            type="number"
                            min="1"
                            value={mintCount[t.id] || 100}
                            onChange={e => setMintCount(p => ({ ...p, [t.id]: Number(e.target.value) }))}
                            className="w-16 px-2 py-1.5 bg-slate-700 border border-slate-600 rounded-lg text-white text-sm text-center"
                          />
                          <button
                            onClick={() => handleMint(t.id, t.name, t.gameId)}
                            className="px-3 py-1.5 bg-purple-600 hover:bg-purple-700 rounded-lg text-xs font-medium"
                          >
                            铸造
                          </button>
                        </div>
                      </div>
                    </div>
                  </motion.div>
                );
              })}
            </div>
          </motion.section>
        )}

        {/* 底部提示 */}
        <div className="mt-8 p-4 bg-slate-800/40 rounded-xl border border-slate-700/30 text-xs text-slate-500">
          <p className="flex items-center gap-1.5 mb-1">
            <Settings className="w-3.5 h-3.5" />
            <span className="font-medium text-slate-400">商家管理须知</span>
          </p>
          <ul className="space-y-1 ml-5 list-disc">
            <li>您只能管理自己注册的游戏，如需查看他人游戏请访问商店首页。</li>
            <li>游戏下架后玩家将无法购买该游戏的道具，请谨慎操作。</li>
            <li>铸造凭证后道具将上架到平台商店，玩家可直接购买获得兑换码。</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
