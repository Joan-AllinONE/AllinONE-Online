/**
 * 道具预览卡片 — 展示 AI 生成的道具结构化预览
 *
 * 根据 Schema 类型动态渲染不同的属性面板。
 */

import React from 'react';
import { motion } from 'framer-motion';
import {
  Sword, Shield, ShoppingBag, ScrollText, Star, Zap,
  Package, Coins, Sparkles, Tag, Hash, Edit3,
} from 'lucide-react';
import type { UGCBridgeResult } from '@/services/ugcBridgeService';

// ==================== 类型定义 ====================

export interface ItemPreviewCardProps {
  /** AI 生成结果 */
  result: UGCBridgeResult;
  /** 编辑回调 */
  onEdit?: () => void;
}

// ==================== 辅助组件 ====================

/** Schema 图标映射 */
const SchemaIcon: React.FC<{ schemaName?: string }> = ({ schemaName }) => {
  const Icon = {
    weapon: Sword,
    armor: Shield,
    shop: ShoppingBag,
    quest: ScrollText,
  }[schemaName || ''] || Package;
  return <Icon className="w-4 h-4" />;
};

/** 稀有度颜色映射 */
const RARITY_COLORS: Record<string, { bg: string; border: string; text: string; glow: string }> = {
  legendary: { bg: 'bg-orange-500/10', border: 'border-orange-500/30', text: 'text-orange-400', glow: 'shadow-orange-500/20' },
  rare: { bg: 'bg-purple-500/10', border: 'border-purple-500/30', text: 'text-purple-400', glow: 'shadow-purple-500/15' },
  uncommon: { bg: 'bg-blue-500/10', border: 'border-blue-500/30', text: 'text-blue-400', glow: 'shadow-blue-500/10' },
  common: { bg: 'bg-slate-500/10', border: 'border-slate-500/20', text: 'text-slate-400', glow: '' },
};

/** 元素颜色映射 */
const ELEMENT_COLORS: Record<string, string> = {
  '火': 'text-red-400', '水': 'text-blue-400', '雷': 'text-yellow-400',
  '风': 'text-green-400', '土': 'text-amber-400', '光': 'text-white',
  '暗': 'text-purple-400', '物理': 'text-slate-300',
};

// ==================== 子组件 ====================

/** 武器属性面板 */
const WeaponPreview: React.FC<{ data: Record<string, any>; rarityColors: typeof RARITY_COLORS['legendary'] }> = ({ data, rarityColors }) => (
  <div className="space-y-3">
    {/* 属性行 */}
    <div className="flex items-center gap-4 flex-wrap">
      {data.damage && (
        <div className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-800/50 rounded-lg border border-slate-700/30">
          <Sword className="w-3.5 h-3.5 text-rose-400" />
          <span className="text-sm text-slate-300 font-medium">{data.damage}</span>
          <span className="text-xs text-slate-500">攻击力</span>
        </div>
      )}
      {data.element && (
        <div className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-800/50 rounded-lg border border-slate-700/30">
          <Zap className={`w-3.5 h-3.5 ${ELEMENT_COLORS[data.element] || 'text-slate-400'}`} />
          <span className={`text-sm font-medium ${ELEMENT_COLORS[data.element] || 'text-slate-400'}`}>
            {data.element}
          </span>
          <span className="text-xs text-slate-500">元素</span>
        </div>
      )}
      {data.rarity && (
        <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border ${rarityColors.bg} ${rarityColors.border}`}>
          <Star className={`w-3.5 h-3.5 ${rarityColors.text}`} />
          <span className={`text-sm font-medium ${rarityColors.text}`}>
            {data.rarity === 'legendary' ? '传说' : data.rarity === 'rare' ? '稀有' : data.rarity === 'uncommon' ? '精良' : '普通'}
          </span>
        </div>
      )}
    </div>

    {/* 特效列表 */}
    {data.effects && data.effects.length > 0 && (
      <div className="space-y-1.5">
        <span className="text-xs text-slate-500 flex items-center gap-1">
          <Sparkles className="w-3 h-3" />特效
        </span>
        {data.effects.map((effect: any, i: number) => (
          <div key={i} className="px-3 py-2 bg-emerald-500/5 border border-emerald-500/10 rounded-lg text-sm text-emerald-300">
            <span className="font-medium">{effect.type}</span>
            {effect.params && (
              <span className="text-xs text-emerald-400/70 ml-2">
                {Object.entries(effect.params).map(([k, v]) => `${k}: ${v}`).join(', ')}
              </span>
            )}
          </div>
        ))}
      </div>
    )}

    {/* 合成配方 */}
    {data.recipe && data.recipe.length > 0 && (
      <div className="space-y-1.5">
        <span className="text-xs text-slate-500 flex items-center gap-1">
          <Package className="w-3 h-3" />合成配方
        </span>
        <div className="flex flex-wrap gap-2">
          {data.recipe.map((mat: any, i: number) => (
            <span key={i} className="px-2.5 py-1 bg-slate-800/50 border border-slate-700/30 rounded-md text-xs text-slate-300">
              {mat.material} <span className="text-slate-500">×{mat.quantity}</span>
            </span>
          ))}
        </div>
      </div>
    )}
  </div>
);

/** 商店属性面板 */
const ShopPreview: React.FC<{ data: Record<string, any> }> = ({ data }) => (
  <div className="space-y-2">
    {data.description && (
      <p className="text-sm text-slate-400">{data.description}</p>
    )}
    {data.items && data.items.length > 0 && (
      <div className="space-y-1.5">
        <span className="text-xs text-slate-500">商品列表（{data.items.length}件）：</span>
        {data.items.slice(0, 4).map((item: any, i: number) => (
          <div key={i} className="flex items-center justify-between px-3 py-2 bg-slate-800/50 border border-slate-700/30 rounded-lg text-xs">
            <span className="text-slate-300">{item.itemName}</span>
            <span className="flex items-center gap-1 text-slate-400">
              <Coins className="w-3 h-3" />
              {item.price} {item.currencyType || 'gameCoins'}
            </span>
          </div>
        ))}
      </div>
    )}
  </div>
);

/** 任务属性面板 */
const QuestPreview: React.FC<{ data: Record<string, any> }> = ({ data }) => (
  <div className="space-y-2">
    {data.description && (
      <p className="text-sm text-slate-400">{data.description}</p>
    )}
    {data.objectives && data.objectives.length > 0 && (
      <div className="space-y-1.5">
        <span className="text-xs text-slate-500">任务目标：</span>
        {data.objectives.map((obj: any, i: number) => (
          <div key={i} className="flex items-center gap-2 px-3 py-1.5 bg-slate-800/50 border border-slate-700/30 rounded-lg text-xs">
            <Hash className="w-3 h-3 text-slate-500" />
            <span className="text-slate-300">
              {obj.type === 'kill' ? '击败' : obj.type === 'collect' ? '收集' : obj.type === 'reach' ? '到达' : '生存'}：
              {obj.target}
            </span>
            <span className="text-slate-500">×{obj.count}</span>
          </div>
        ))}
      </div>
    )}
    {data.rewards && (
      <div className="flex flex-wrap gap-2 mt-2">
        {data.rewards.exp && (
          <span className="px-2 py-0.5 bg-amber-500/10 border border-amber-500/20 rounded text-xs text-amber-400">+{data.rewards.exp} EXP</span>
        )}
        {data.rewards.gameCoins && (
          <span className="px-2 py-0.5 bg-yellow-500/10 border border-yellow-500/20 rounded text-xs text-yellow-400">+{data.rewards.gameCoins} 金币</span>
        )}
      </div>
    )}
  </div>
);

// ==================== 主组件 ====================

const ItemPreviewCard: React.FC<ItemPreviewCardProps> = ({ result, onEdit }) => {
  if (!result.success || !result.preview) return null;

  const { preview, schemaName, reasoning, template } = result;
  const displayName = preview?.name || preview?.title || '未命名道具';
  const rarity = preview?.rarity || 'common';
  const rarityColors = RARITY_COLORS[rarity] || RARITY_COLORS.common;

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.3, ease: 'easeOut' }}
      className={`relative overflow-hidden rounded-2xl border ${rarityColors.border} 
                  ${rarityColors.bg} backdrop-blur-sm ${rarityColors.glow}`}
    >
      {/* 顶部装饰线 */}
      <div className={`absolute top-0 left-0 right-0 h-0.5 bg-gradient-to-r from-transparent via-${rarity === 'legendary' ? 'orange' : rarity === 'rare' ? 'purple' : 'blue'}-400/50 to-transparent`} />

      {/* 头部 */}
      <div className="px-5 pt-4 pb-3 flex items-start justify-between">
        <div className="flex items-center gap-3">
          <div className={`flex items-center justify-center w-10 h-10 rounded-xl border ${rarityColors.border} ${rarityColors.bg}`}>
            <SchemaIcon schemaName={schemaName} />
          </div>
          <div>
            <h3 className="text-lg font-semibold text-slate-100">{displayName}</h3>
            <span className="inline-flex items-center gap-1 text-xs text-slate-500">
              <Tag className="w-3 h-3" />
              {schemaName === 'weapon' ? '武器' : schemaName === 'shop' ? '商店' : schemaName === 'quest' ? '任务' : schemaName}
            </span>
          </div>
        </div>
        {onEdit && (
          <button
            onClick={onEdit}
            className="flex items-center gap-1 px-3 py-1.5 text-xs text-slate-400 hover:text-slate-300
                       hover:bg-slate-700/30 rounded-lg transition-colors cursor-pointer"
          >
            <Edit3 className="w-3 h-3" />
            调整
          </button>
        )}
      </div>

      {/* 属性区域 */}
      <div className="px-5 pb-4">
        {schemaName === 'weapon' && <WeaponPreview data={preview} rarityColors={rarityColors} />}
        {schemaName === 'shop' && <ShopPreview data={preview} />}
        {schemaName === 'quest' && <QuestPreview data={preview} />}
        {!['weapon', 'shop', 'quest'].includes(schemaName || '') && (
          <pre className="text-xs text-slate-400 bg-slate-800/30 p-3 rounded-xl overflow-auto max-h-40">
            {JSON.stringify(preview, null, 2)}
          </pre>
        )}
      </div>

      {/* AI 分析过程 */}
      {reasoning && (
        <div className="px-5 pb-4">
          <details className="group">
            <summary className="text-xs text-slate-600 hover:text-slate-500 cursor-pointer transition-colors">
              AI 分析过程
            </summary>
            <p className="mt-2 text-xs text-slate-500 leading-relaxed">{reasoning}</p>
          </details>
        </div>
      )}

      {/* 底部信息栏 */}
      <div className="px-5 py-3 border-t border-slate-700/30 flex items-center justify-between text-xs text-slate-500">
        <span className="flex items-center gap-1">
          <Sparkles className="w-3 h-3 text-[#7C3AED]" />
          由 AI 生成
        </span>
        {template && (
          <span className="flex items-center gap-1">
            <Coins className="w-3 h-3" />
            价格：{template.pricing.price} {template.pricing.currency}
          </span>
        )}
      </div>
    </motion.div>
  );
};

export default ItemPreviewCard;
export { RARITY_COLORS, ELEMENT_COLORS, SchemaIcon };
