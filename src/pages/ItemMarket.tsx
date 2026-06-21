/**
 * ItemMarket — 跨游戏 UGC 道具市场
 *
 * 展示所有游戏中玩家创造的道具，支持跨游戏适配。
 * 三个视图：全部道具 / 兼容当前游戏 / 来自我的游戏
 */

import React, { useState, useEffect, useContext } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Link } from 'react-router-dom';
import {
  Hammer, Search, Filter, ArrowLeft, Globe, ArrowRightLeft,
  Package, Star, Coins, Tag, TrendingUp, Gamepad2, Sparkles,
  X, ChevronDown, ExternalLink, ShieldCheck, Wand2,
} from 'lucide-react';
import { AuthContext } from '@/contexts/authContext';
import { getPublishedGames, type PublishedGame } from '@/services/publishedGameService';
import { voucherItemService } from '@/services/voucherItemService';
import { schemaRegistry } from '@/publishing-center/protocol/SchemaRegistry';
import type { ItemVoucherTemplate } from '@/voucher-system/types';

// ==================== 类型 ====================

interface MarketItem {
  template: ItemVoucherTemplate;
  game: PublishedGame;
  compatibleGames: string[];
}

type MarketView = 'all' | 'compatible' | 'my-game';

// ==================== 常量 ====================

const RARITY_CONFIG: Record<string, { label: string; color: string; bg: string; border: string }> = {
  legendary: { label: '传说', color: 'text-orange-400', bg: 'bg-orange-500/10', border: 'border-orange-500/30' },
  rare: { label: '稀有', color: 'text-purple-400', bg: 'bg-purple-500/10', border: 'border-purple-500/30' },
  uncommon: { label: '精良', color: 'text-blue-400', bg: 'bg-blue-500/10', border: 'border-blue-500/30' },
  common: { label: '普通', color: 'text-slate-400', bg: 'bg-slate-500/10', border: 'border-slate-500/20' },
};

const SCHEMA_LABELS: Record<string, string> = {
  weapon: '武器', shop: '商店', quest: '任务', armor: '防具', consumable: '消耗品',
};

/** 辅助：拼接 className */
const cx = (...args: (string | false | undefined | null)[]) => args.filter(Boolean).join(' ');

// ==================== 组件 ====================

const ItemMarketPage: React.FC = () => {
  const { currentUser } = useContext(AuthContext);

  const [games, setGames] = useState<PublishedGame[]>([]);
  const [items, setItems] = useState<MarketItem[]>([]);
  const [loading, setLoading] = useState(true);

  const [view, setView] = useState<MarketView>('all');
  const [selectedGame, setSelectedGame] = useState<string>('');
  const [searchQuery, setSearchQuery] = useState('');
  const [filterRarity, setFilterRarity] = useState<string>('');
  const [filterSchema, setFilterSchema] = useState<string>('');
  const [showFilters, setShowFilters] = useState(false);

  const [adaptTarget, setAdaptTarget] = useState<string>('');
  const [adaptingItem, setAdaptingItem] = useState<string | null>(null);
  const [adaptResult, setAdaptResult] = useState<{ success: boolean; message: string } | null>(null);

  useEffect(() => {
    const publishedGames = getPublishedGames();
    setGames(publishedGames);

    const allItems: MarketItem[] = [];
    for (const game of publishedGames) {
      const templates = voucherItemService.getItemTemplates(game.id);
      for (const tpl of templates) {
        const schemaName = tpl.gameEffect.schemaName || tpl.gameEffect.itemId || '';
        const compatibleGames = schemaName
          ? schemaRegistry.getCompatibleGames(schemaName)
          : [game.id];
        if (!compatibleGames.includes(game.id)) compatibleGames.unshift(game.id);
        allItems.push({ template: tpl, game, compatibleGames });
      }
    }

    setItems(allItems);
    setLoading(false);
  }, []);

  const filteredItems = items.filter(item => {
    const tpl = item.template;
    const schemaName = tpl.gameEffect.schemaName || tpl.gameEffect.itemId || '';
    if (view === 'compatible' && selectedGame && !item.compatibleGames.includes(selectedGame)) return false;
    if (view === 'my-game' && selectedGame && tpl.gameId !== selectedGame) return false;
    if (filterRarity && tpl.rarity !== filterRarity) return false;
    if (filterSchema && schemaName !== filterSchema) return false;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      return tpl.name.toLowerCase().includes(q) || tpl.description.toLowerCase().includes(q) || (tpl.gameName || '').toLowerCase().includes(q);
    }
    return true;
  });

  const allRarities = [...new Set(items.map(i => i.template.rarity).filter(Boolean))];
  const allSchemas = [...new Set(items.map(i => i.template.gameEffect.schemaName || i.template.gameEffect.itemId || '').filter(Boolean))];

  const handleAdapt = async (item: MarketItem, targetGameId: string) => {
    setAdaptingItem(item.template.id);
    setAdaptResult(null);
    const schemaName = item.template.gameEffect.schemaName || '';
    const itemData = item.template.gameEffect.itemData || {};
    try {
      const result = schemaRegistry.autoAdapt(itemData, schemaName, targetGameId);
      if (result.success) {
        setAdaptResult({ success: true, message: `已适配到 "${games.find(g => g.id === targetGameId)?.name || targetGameId}"` });
      } else {
        setAdaptResult({ success: false, message: result.error || '适配失败' });
      }
    } catch (e) {
      setAdaptResult({ success: false, message: e instanceof Error ? e.message : '适配异常' });
    } finally {
      setAdaptingItem(null);
    }
  };

  // 稀有度顶部线颜色
  const getRarityLineClass = (r: string | undefined) => {
    if (r === 'legendary') return 'from-orange-400 via-orange-300 to-transparent';
    if (r === 'rare') return 'from-purple-400 via-purple-300 to-transparent';
    if (r === 'uncommon') return 'from-blue-400 via-blue-300 to-transparent';
    return 'from-slate-500 via-slate-400 to-transparent';
  };

  return (
    <div className="min-h-screen bg-[#0F0F23]">
      <div className="max-w-6xl mx-auto px-4 py-8">
        {/* 头部 */}
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-3">
            <Link to="/voucher-system?tab=item-vouchers" className="text-slate-400 hover:text-slate-300 transition-colors">
              <ArrowLeft className="w-5 h-5" />
            </Link>
            <h1 className="text-2xl font-bold text-slate-100 flex items-center gap-2">
              <Globe className="w-6 h-6 text-[#7C3AED]" />
              跨游戏道具市场
            </h1>
          </div>
          <Link
            to="/workshop"
            className="flex items-center gap-2 px-4 py-2 bg-[#7C3AED] hover:bg-[#6D28D9] text-white rounded-lg text-sm font-medium transition-colors shadow-lg shadow-[#7C3AED]/25"
          ><Hammer className="w-4 h-4" />创建道具</Link>
        </div>

        {/* 工具栏 */}
        <div className="space-y-4 mb-6">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex bg-slate-800/50 border border-slate-700/30 rounded-lg p-1">
              {([['all', '全部'], ['compatible', '兼容游戏'], ['my-game', '我的游戏']] as [MarketView, string][]).map(([v, label]) => {
                const isActive = view === v;
                const btnClass = isActive
                  ? 'px-3 py-1.5 text-xs rounded-md font-medium transition-colors cursor-pointer bg-[#7C3AED]/20 text-[#7C3AED]'
                  : 'px-3 py-1.5 text-xs rounded-md font-medium transition-colors cursor-pointer text-slate-400 hover:text-slate-300';
                return (<button key={v} onClick={() => setView(v)} className={btnClass}>{label}</button>);
              })}
            </div>

            {(view === 'compatible' || view === 'my-game') && (
              <select value={selectedGame} onChange={e => setSelectedGame(e.target.value)}
                className="px-3 py-1.5 bg-slate-800/50 border border-slate-700/30 rounded-lg text-sm text-slate-300 cursor-pointer">
                <option value="">选择游戏...</option>
                {games.map(g => (<option key={g.id} value={g.id}>{g.name}</option>))}
              </select>
            )}

            <div className="flex-1 min-w-[200px] relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
              <input type="text" value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
                placeholder="搜索道具名称..."
                className="w-full pl-9 pr-4 py-1.5 bg-slate-800/50 border border-slate-700/30 rounded-lg text-sm text-slate-200 placeholder:text-slate-600 outline-none focus:border-[#7C3AED]/30 transition-colors" />
            </div>

            <button onClick={() => setShowFilters(!showFilters)}
              className={cx(
                'flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg transition-colors cursor-pointer',
                showFilters ? 'bg-[#7C3AED]/20 text-[#7C3AED] border border-[#7C3AED]/30' : 'bg-slate-800/50 border border-slate-700/30 text-slate-400 hover:text-slate-300'
              )}>
              <Filter className="w-3.5 h-3.5" />筛选
              <ChevronDown className={cx('w-3 h-3 transition-transform', showFilters && 'rotate-180')} />
            </button>
          </div>

          {/* 高级筛选 */}
          <AnimatePresence>
            {showFilters && (
              <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}
                className="flex flex-wrap gap-2 overflow-hidden">
                <div className="flex flex-wrap gap-2">
                  {['', ...allRarities].map(r => {
                    const isActive = filterRarity === r;
                    const btnClass = isActive
                      ? 'px-2.5 py-1 text-xs rounded-md border transition-colors cursor-pointer border-[#7C3AED]/30 bg-[#7C3AED]/15 text-[#7C3AED]'
                      : 'px-2.5 py-1 text-xs rounded-md border transition-colors cursor-pointer border-slate-700/30 text-slate-400 hover:border-slate-600/40';
                    return (<button key={r || 'all'} onClick={() => setFilterRarity(r)} className={btnClass}>{r ? RARITY_CONFIG[r]?.label || r : '全部稀有度'}</button>);
                  })}
                </div>
                <div className="flex flex-wrap gap-2">
                  {['', ...allSchemas].map(s => {
                    const isActive = filterSchema === s;
                    const btnClass = isActive
                      ? 'px-2.5 py-1 text-xs rounded-md border transition-colors cursor-pointer border-[#7C3AED]/30 bg-[#7C3AED]/15 text-[#7C3AED]'
                      : 'px-2.5 py-1 text-xs rounded-md border transition-colors cursor-pointer border-slate-700/30 text-slate-400 hover:border-slate-600/40';
                    return (<button key={s || 'all'} onClick={() => setFilterSchema(s)} className={btnClass}>{s ? SCHEMA_LABELS[s] || s : '全部类型'}</button>);
                  })}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* 道具列表 */}
        {loading ? (
          <div className="flex justify-center py-24">
            <div className="flex items-center gap-3 text-slate-500"><Sparkles className="w-5 h-5 animate-spin" /><span>正在探索全平台道具...</span></div>
          </div>
        ) : filteredItems.length === 0 ? (
          <div className="text-center py-24">
            <Package className="w-16 h-16 text-slate-700 mx-auto mb-4" />
            <p className="text-slate-500 text-lg">暂无道具</p>
            <p className="text-slate-600 text-sm mt-1">{view === 'all' ? '还没有玩家创建道具，去道具工坊创造第一个吧！' : '更改筛选条件试试'}</p>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {filteredItems.map(({ template: tpl, game, compatibleGames }) => {
              const rarityInfo = RARITY_CONFIG[tpl.rarity || 'common'] || RARITY_CONFIG.common;
              const schemaName = tpl.gameEffect.schemaName || tpl.gameEffect.itemId || '';
              const schemaLabel = SCHEMA_LABELS[schemaName] || schemaName;
              const cardClass = cx(
                'relative p-4 rounded-xl border', rarityInfo.border, rarityInfo.bg,
                'bg-slate-800/30 backdrop-blur-sm hover:bg-slate-800/50 transition-all duration-200 cursor-pointer group'
              );
              const lineClass = cx('absolute top-0 left-0 right-0 h-0.5 rounded-t-xl bg-gradient-to-r', getRarityLineClass(tpl.rarity));

              return (
                <motion.div key={tpl.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className={cardClass}>
                  <div className={lineClass} />
                  <div className="flex items-center justify-between mb-2">
                    <span className={cx('px-2 py-0.5 text-xs rounded-full', rarityInfo.color, rarityInfo.bg, 'border', rarityInfo.border)}>{rarityInfo.label}</span>
                    <span className="text-xs text-slate-500 flex items-center gap-1"><Gamepad2 className="w-3 h-3" />{game.name}</span>
                  </div>
                  <h3 className="text-slate-100 font-semibold mb-1 group-hover:text-[#7C3AED] transition-colors">{tpl.name}</h3>
                  <p className="text-xs text-slate-500 line-clamp-2 mb-3">{tpl.description}</p>
                  <div className="flex flex-wrap gap-1.5 mb-3">
                    <span className="px-2 py-0.5 bg-slate-700/30 rounded text-xs text-slate-400">{schemaLabel}</span>
                    <span className="px-2 py-0.5 bg-slate-700/30 rounded text-xs text-slate-400 flex items-center gap-1"><Coins className="w-3 h-3" />{tpl.pricing.price} {tpl.pricing.currency}</span>
                    {tpl.source === 'ai_generated' && (
                      <span className="px-2 py-0.5 bg-[#7C3AED]/10 border border-[#7C3AED]/20 rounded text-xs text-[#7C3AED] flex items-center gap-1"><Sparkles className="w-3 h-3" />AI</span>
                    )}
                  </div>
                  <div className="mb-3">
                    <span className="text-xs text-slate-500 flex items-center gap-1 mb-1"><Globe className="w-3 h-3" />兼容游戏 ({compatibleGames.length || 1})：</span>
                    <div className="flex flex-wrap gap-1">
                      {compatibleGames.slice(0, 3).map(gid => (
                        <span key={gid} className="px-1.5 py-0.5 bg-emerald-500/10 border border-emerald-500/15 rounded text-xs text-emerald-400">{games.find(g => g.id === gid)?.name || gid}</span>
                      ))}
                      {compatibleGames.length > 3 && (<span className="px-1.5 py-0.5 text-xs text-slate-500">+{compatibleGames.length - 3}</span>)}
                    </div>
                  </div>
                  {compatibleGames.length > 1 && (
                    <div className="flex items-center gap-2">
                      <select onChange={e => setAdaptTarget(e.target.value)} onClick={e => e.stopPropagation()}
                        className="flex-1 px-2 py-1 bg-slate-700/30 border border-slate-600/30 rounded text-xs text-slate-300 cursor-pointer" value={adaptTarget}>
                        <option value="">适配到...</option>
                        {compatibleGames.map(gid => (<option key={gid} value={gid}>{games.find(g => g.id === gid)?.name || gid}</option>))}
                      </select>
                      <button disabled={!adaptTarget || adaptingItem === tpl.id}
                        onClick={(e) => { e.stopPropagation(); handleAdapt({ template: tpl, game, compatibleGames }, adaptTarget); }}
                        className="flex items-center gap-1 px-2 py-1 bg-[#7C3AED]/15 border border-[#7C3AED]/25 text-violet-300 rounded text-xs hover:bg-[#7C3AED]/20 transition-colors disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer">
                        <ArrowRightLeft className="w-3 h-3" />适配
                      </button>
                    </div>
                  )}
                </motion.div>
              );
            })}
          </div>
        )}

        {!loading && items.length > 0 && (
          <div className="mt-8 pt-6 border-t border-slate-700/30 text-center">
            <p className="text-xs text-slate-600">
              共 {items.length} 个道具，跨 {games.length} 个游戏 | AI 生成：{items.filter(i => i.template.source === 'ai_generated').length} 个 | 传说级：{items.filter(i => i.template.rarity === 'legendary').length} 个
            </p>
          </div>
        )}
      </div>
    </div>
  );
};

export default ItemMarketPage;
