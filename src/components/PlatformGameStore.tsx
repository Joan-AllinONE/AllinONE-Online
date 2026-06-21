/**
 * 平台游戏商店 - 主展示组件
 *
 * 专门展示"未在 AllinONE 发布的外部游戏"的道具/商品。
 * 玩家购买后获得兑换码，可在外部游戏中使用。
 */
import { useState, useEffect, useContext, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { platformGameStoreService } from '@/services/platformGameStoreService';
import { voucherItemService } from '@/services/voucherItemService';
import { skillGateway } from '@/skills';
import { AuthContext } from '@/contexts/authContext';
import type {
  ExternalGameStore,
  PlatformStoreItem,
  PlatformStoreQuery,
  StoreSortBy,
} from '@/types/platformGameStore';
import {
  Store, ShoppingCart, Gamepad2, Globe, Coins, Check, Copy,
  X, Search, SlidersHorizontal, ChevronDown, Package, TrendingUp,
  ShieldCheck, ArrowLeft, Tag, Sparkles, Settings,
  BookOpen, Code, Server, Terminal, AlertCircle,
  CheckCircle2, ClipboardList, UserPlus, Download,
} from 'lucide-react';
import sopMarkdown from '../../docs/allinone-game-store-developer-sop.md?raw';

// ==================== 类型 ====================

type TabMode = 'browse' | 'myItems' | 'devGuide';

interface PurchaseState {
  isPurchasing: boolean;
  templateId: string | null;
  success: boolean;
  error: string | null;
  redeemCode?: string;
}

// ==================== Rarity 常量 ====================

const RARITY_LABEL: Record<string, string> = {
  legendary: '传说',
  rare: '稀有',
  uncommon: '精良',
  common: '普通',
};

const RARITY_COLORS: Record<string, string> = {
  legendary: 'bg-orange-500 text-white',
  rare: 'bg-purple-500 text-white',
  uncommon: 'bg-blue-500 text-white',
  common: 'bg-slate-500 text-white',
};

const RARITY_GRADIENTS: Record<string, string> = {
  legendary: 'bg-gradient-to-br from-orange-500 to-red-500',
  rare: 'bg-gradient-to-br from-purple-500 to-pink-500',
  uncommon: 'bg-gradient-to-br from-blue-500 to-cyan-500',
  common: 'bg-gradient-to-br from-slate-500 to-slate-600',
};

const ITEM_TYPE_LABEL: Record<string, string> = {
  consumable: '消耗品',
  permanent: '永久道具',
  currency: '货币',
  buff: '增益',
  package: '礼包',
};

// ==================== 子组件 ====================

function GameCard({ store, itemCount, onClick }: {
  store: ExternalGameStore;
  itemCount: number;
  onClick: () => void;
}) {
  return (
    <motion.button
      whileHover={{ scale: 1.03, y: -4 }}
      whileTap={{ scale: 0.97 }}
      onClick={onClick}
      className="relative overflow-hidden rounded-2xl border border-slate-700/50 bg-slate-800/60 p-5 text-left transition-all hover:border-purple-500/30 hover:bg-slate-800/80"
    >
      <div className="flex items-start gap-4">
        <div
          className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl text-2xl"
          style={{ background: `linear-gradient(135deg, ${store.theme.primaryColor}30, ${store.theme.secondaryColor}20)` }}
        >
          {store.gameIcon}
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="font-bold text-white truncate">{store.gameName}</h3>
          <p className="text-xs text-slate-400 mt-0.5">{store.developer}</p>
          <p className="text-xs text-slate-500 mt-1 line-clamp-2">{store.description}</p>
          <div className="flex items-center gap-3 mt-3">
            <span className="inline-flex items-center gap-1 text-xs text-purple-400">
              <Package className="w-3.5 h-3.5" />
              {itemCount} 个道具
            </span>
          </div>
        </div>
      </div>
    </motion.button>
  );
}

function ItemCard({ item, onPurchase, purchaseState, onGameClick }: {
  item: PlatformStoreItem;
  onPurchase: (item: PlatformStoreItem) => void;
  purchaseState: PurchaseState;
  onGameClick: (gameId: string) => void;
}) {
  const isThisBuying = purchaseState.isPurchasing && purchaseState.templateId === item.templateId;
  const isThisSuccess = purchaseState.success && purchaseState.templateId === item.templateId;

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="bg-slate-800 rounded-xl overflow-hidden border border-slate-700 hover:border-purple-500/30 transition-all group flex flex-col"
    >
      {/* 图标区域 */}
      <div className="aspect-square bg-gradient-to-br from-slate-700 to-slate-800 flex items-center justify-center relative">
        <div className={`w-20 h-20 rounded-2xl flex items-center justify-center text-white text-3xl font-bold ${RARITY_GRADIENTS[item.rarity] || RARITY_GRADIENTS.common}`}>
          {item.name.charAt(0)}
        </div>
        {item.rarity && (
          <div className={`absolute top-2 right-2 px-2 py-0.5 rounded-full text-xs font-medium ${RARITY_COLORS[item.rarity] || 'bg-slate-500 text-white'}`}>
            {RARITY_LABEL[item.rarity] || item.rarity}
          </div>
        )}
        {item.template.supplyPolicy === 'limited' && (
          <div className="absolute top-2 left-2 px-2 py-0.5 bg-amber-500 rounded-full text-xs text-white font-medium">
            限量
          </div>
        )}
        {/* 游戏来源标签 */}
        <button
          onClick={(e) => { e.stopPropagation(); onGameClick(item.gameId); }}
          className="absolute bottom-2 left-2 px-2 py-0.5 bg-slate-900/70 hover:bg-slate-900 rounded-full text-xs text-slate-300 flex items-center gap-1 transition-colors"
        >
          <Globe className="w-3 h-3" />
          {item.gameIcon} {item.gameName}
        </button>
      </div>

      {/* 信息区域 */}
      <div className="p-4 flex-1 flex flex-col">
        <h3 className="text-lg font-bold text-white mb-1">{item.name}</h3>
        <p className="text-slate-400 text-sm mb-3 flex-1">{item.description}</p>

        {/* 类型+库存 */}
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          {item.itemType && (
            <span className="px-2 py-0.5 bg-slate-700 rounded text-xs text-slate-300">
              {ITEM_TYPE_LABEL[item.itemType] || item.itemType}
            </span>
          )}
          {item.template.supplyPolicy === 'limited' && (
            <span className={`text-xs ${item.availableCount > 0 ? 'text-green-400' : 'text-red-400'}`}>
              剩余: {item.availableCount}
            </span>
          )}
        </div>

        {/* 价格 */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-1.5">
            {item.currency === 'ACOIN' ? (
              <ShieldCheck className="w-4 h-4 text-blue-400" />
            ) : (
              <Coins className="w-4 h-4 text-yellow-500" />
            )}
            <span className="text-xl font-bold text-white">{item.price}</span>
            <span className="text-xs text-slate-500">{item.currency === 'ACOIN' ? 'A币' : '币'}</span>
          </div>
        </div>

        {/* 购买按钮 */}
        <button
          onClick={() => onPurchase(item)}
          disabled={isThisBuying}
          className={`w-full py-2.5 rounded-lg font-medium transition-all flex items-center justify-center gap-2 text-sm ${
            isThisSuccess
              ? 'bg-green-600 text-white'
              : item.availableCount === 0 && item.template.supplyPolicy === 'limited'
                ? 'bg-slate-600 text-slate-400 cursor-not-allowed'
                : 'bg-purple-600 hover:bg-purple-700 text-white disabled:bg-slate-600'
          }`}
        >
          {isThisBuying ? (
            <><div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />处理中...</>
          ) : isThisSuccess ? (
            <><Check className="w-4 h-4" />购买成功!</>
          ) : item.availableCount === 0 && item.template.supplyPolicy === 'limited' ? (
            <><X className="w-4 h-4" />已售罄</>
          ) : (
            <><ShoppingCart className="w-4 h-4" />购买</>
          )}
        </button>

        {/* 错误提示 */}
        {purchaseState.error && purchaseState.templateId === item.templateId && (
          <p className="mt-2 text-xs text-red-400 text-center">{purchaseState.error}</p>
        )}

        {/* 兑换码显示 */}
        {isThisSuccess && purchaseState.redeemCode && (
          <div className="mt-3 p-3 bg-yellow-500/10 border border-yellow-500/30 rounded-lg">
            <p className="text-xs text-yellow-400 mb-1 text-center">🎫 您的兑换码</p>
            <div className="flex items-center gap-2">
              <p className="flex-1 text-center font-mono font-bold text-lg text-yellow-300 tracking-wider">
                {purchaseState.redeemCode}
              </p>
              <button
                onClick={() => navigator.clipboard.writeText(purchaseState.redeemCode!).catch(() => {})}
                className="p-1.5 bg-slate-700 hover:bg-slate-600 rounded text-slate-300 hover:text-white transition-colors"
                title="复制兑换码"
              >
                <Copy className="w-4 h-4" />
              </button>
            </div>
            <p className="text-xs text-slate-500 text-center mt-1">在游戏内输入此码兑换道具</p>
          </div>
        )}
      </div>
    </motion.div>
  );
}

function EmptyState({ icon, title, description }: { icon: React.ReactNode; title: string; description: string }) {
  return (
    <div className="text-center py-20">
      <div className="w-16 h-16 mx-auto mb-4 text-slate-600 flex items-center justify-center">
        {icon}
      </div>
      <h3 className="text-xl font-bold text-white mb-2">{title}</h3>
      <p className="text-slate-400 max-w-md mx-auto">{description}</p>
    </div>
  );
}

// ==================== 我的道具面板 ====================

function MyItemsPanel() {
  const { currentUser } = useContext(AuthContext);
  const [myVouchers, setMyVouchers] = useState<any[]>([]);
  const [myPurchases, setMyPurchases] = useState<any[]>([]);
  const [copiedCode, setCopiedCode] = useState<string | null>(null);

  useEffect(() => {
    if (!currentUser?.id) return;
    const allStores = platformGameStoreService.getGames(true);
    const gameIds = allStores.map(s => s.gameId);

    let vouchers: any[] = [];
    let purchases: any[] = [];
    for (const gid of gameIds) {
      vouchers = vouchers.concat(voucherItemService.getUserItemVouchers(currentUser.id, gid));
      purchases = purchases.concat(voucherItemService.getUserPurchases(currentUser.id, gid));
    }
    setMyVouchers(vouchers);
    setMyPurchases(purchases);
  }, [currentUser?.id]);

  const copyCode = (code: string) => {
    navigator.clipboard.writeText(code).catch(() => {});
    setCopiedCode(code);
    setTimeout(() => setCopiedCode(null), 2000);
  };

  if (!currentUser?.id) {
    return <EmptyState icon={<ShieldCheck className="w-16 h-16" />} title="请先登录" description="登录后查看已购买的道具凭证和兑换码" />;
  }

  if (myVouchers.length === 0 && myPurchases.length === 0) {
    return <EmptyState icon={<Package className="w-16 h-16" />} title="还没有道具凭证" description="在平台商店购买道具后将在这里查看凭证和兑换码" />;
  }

  return (
    <div className="space-y-6">
      {/* 待兑换的凭证 */}
      {myVouchers.length > 0 && (
        <section>
          <h3 className="text-white font-semibold flex items-center gap-2 mb-4">
            <span className="w-2 h-2 bg-green-400 rounded-full" />
            我的道具凭证 ({myVouchers.length})
          </h3>
          <div className="space-y-3">
            {myVouchers.map((voucher, idx) => {
              const customData = voucher.metadata?.customData || {};
              const rarity = customData.rarity || 'common';
              const purchase = myPurchases.find((p: any) => p.voucherId === voucher.id);
              const code = purchase?.redeemCode;

              return (
                <motion.div
                  key={voucher.id}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: idx * 0.05 }}
                  className="bg-slate-800 rounded-xl border border-slate-700 p-5"
                >
                  <div className="flex items-start justify-between flex-wrap gap-3">
                    <div className="flex items-center gap-3">
                      <div className={`w-10 h-10 rounded-lg flex items-center justify-center text-white text-lg font-bold ${RARITY_GRADIENTS[rarity] || RARITY_GRADIENTS.common}`}>
                        {voucher.metadata?.name?.charAt(0) || '?'}
                      </div>
                      <div>
                        <h4 className="font-semibold text-white text-sm">{voucher.metadata?.name || '未知道具'}</h4>
                        <p className="text-xs text-slate-400">{voucher.metadata?.description}</p>
                        <div className="flex items-center gap-2 mt-1 flex-wrap">
                          <span className={`text-xs px-1.5 py-0.5 rounded ${RARITY_COLORS[rarity] || RARITY_COLORS.common}`}>
                            {RARITY_LABEL[rarity] || rarity}
                          </span>
                          <span className="text-xs font-mono text-slate-500">#{voucher.serialNumber}</span>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* 兑换码 */}
                  {code && (
                    <div className="mt-4 pt-4 border-t border-slate-700">
                      <div className="flex items-center justify-between p-3 bg-slate-900/60 rounded-lg border border-slate-600/50">
                        <div>
                          <p className="text-xs text-slate-400 mb-1">兑换码</p>
                          <p className="text-lg font-mono font-bold tracking-wider text-yellow-400">{code}</p>
                        </div>
                        <button
                          onClick={() => copyCode(code)}
                          className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm transition-colors ${
                            copiedCode === code
                              ? 'bg-green-600/20 text-green-400'
                              : 'bg-slate-700 hover:bg-slate-600 text-white'
                          }`}
                        >
                          {copiedCode === code ? (
                            <><Check className="w-4 h-4" />已复制</>
                          ) : (
                            <><Copy className="w-4 h-4" />复制</>
                          )}
                        </button>
                      </div>
                      <p className="text-xs text-slate-500 text-center mt-2">
                        将此兑换码复制到游戏中，在兑换页面输入即可领取
                      </p>
                    </div>
                  )}
                </motion.div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}

// ==================== 开发者指南面板 ====================

function DeveloperGuidePanel() {
  const [activeSection, setActiveSection] = useState<'overview' | 'api' | 'integration'>('overview');

  const handleDownloadSop = () => {
    const blob = new Blob([sopMarkdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'AllinONE-游戏开发商接入SOP.md';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const sections = [
    { id: 'overview' as const, label: '流程概览', icon: <BookOpen className="w-4 h-4" /> },
    { id: 'api' as const, label: 'API 文档', icon: <Code className="w-4 h-4" /> },
    { id: 'integration' as const, label: '接入示例', icon: <Terminal className="w-4 h-4" /> },
  ];

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      {/* 顶部横幅 */}
      <div className="bg-gradient-to-r from-purple-600/20 via-blue-600/20 to-cyan-600/20 border border-purple-500/30 rounded-2xl p-6">
        <div className="flex items-start gap-4">
          <div className="p-3 bg-purple-500/20 rounded-xl shrink-0">
            <BookOpen className="w-8 h-8 text-purple-400" />
          </div>
          <div>
            <h2 className="text-2xl font-bold text-white mb-2">游戏开发商接入指南</h2>
            <p className="text-slate-300 leading-relaxed">
              通过 AllinONE 平台商店注册游戏、创建道具、管理兑换码，让玩家在平台购买后在你的游戏中使用兑换码领取道具。
              本指南涵盖从注册到后端 API 接入的完整流程。
            </p>
          </div>
        </div>
        {/* 一键下载 SOP 文档 */}
        <button
          onClick={handleDownloadSop}
          className="mt-4 flex items-center gap-2 px-5 py-2.5 bg-gradient-to-r from-purple-600 to-cyan-600 hover:from-purple-500 hover:to-cyan-500 text-white rounded-xl font-medium text-sm transition-all shadow-lg shadow-purple-500/20 hover:shadow-purple-500/40"
        >
          <Download className="w-4 h-4" />
          下载 AI 可执行 SOP 文档 (.md)
        </button>
      </div>

      {/* 子标签 */}
      <div className="flex gap-2 border-b border-slate-700/50 pb-2">
        {sections.map(s => (
          <button
            key={s.id}
            onClick={() => setActiveSection(s.id)}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              activeSection === s.id
                ? 'bg-purple-600 text-white'
                : 'text-slate-400 hover:text-white hover:bg-slate-800'
            }`}
          >
            {s.icon}
            {s.label}
          </button>
        ))}
      </div>

      {/* ==================== 流程概览 ==================== */}
      {activeSection === 'overview' && <OverviewSection />}

      {/* ==================== API 文档 ==================== */}
      {activeSection === 'api' && <ApiDocsSection />}

      {/* ==================== 接入示例 ==================== */}
      {activeSection === 'integration' && <IntegrationSection />}
    </div>
  );
}

function OverviewSection() {
  const steps = [
    {
      num: 1,
      title: '注册游戏',
      desc: '在平台商店管理面板（⚙ 管理）中注册你的游戏。填写游戏 ID（格式 ext-{slug}-{timestamp}）、游戏名称、开发商和简介。',
      icon: <UserPlus className="w-5 h-5" />,
      color: 'purple',
    },
    {
      num: 2,
      title: '创建道具模板',
      desc: '选中已注册的游戏，创建道具模板。配置道具名称、游戏内道具 ID（gameItemId）、类型、稀有度、发行策略（限量/开放）、价格和货币。',
      icon: <Package className="w-5 h-5" />,
      color: 'cyan',
    },
    {
      num: 3,
      title: '铸造凭证',
      desc: '创建道具后可立即铸造初始库存。铸造的凭证进入平台池（platform_pool），供玩家购买。限量型道具受总量上限约束，开放型可不限量铸造。',
      icon: <Sparkles className="w-5 h-5" />,
      color: 'amber',
    },
    {
      num: 4,
      title: '玩家购买 → 获得兑换码',
      desc: '玩家在平台商店浏览道具，选择支付方式（钱包余额/A币凭证）购买成功后，获得格式为 IV-XXXXXXXX 的兑换码。',
      icon: <ShoppingCart className="w-5 h-5" />,
      color: 'green',
    },
    {
      num: 5,
      title: '游戏内输入兑换码',
      desc: '玩家在你的游戏内输入兑换码。你的游戏后端调用平台 API 进行验证和核销。',
      icon: <Terminal className="w-5 h-5" />,
      color: 'blue',
    },
    {
      num: 6,
      title: '调用 API 核销发放道具',
      desc: '先调用 POST /api/redeem/verify 验证兑换码有效性，再调用 POST /api/redeem/use 标记为已使用，根据返回的 gameEffect 数据发放道具给玩家。',
      icon: <CheckCircle2 className="w-5 h-5" />,
      color: 'emerald',
    },
  ];

  const colorMap: Record<string, string> = {
    purple: 'border-purple-500/30 bg-purple-500/5',
    cyan: 'border-cyan-500/30 bg-cyan-500/5',
    amber: 'border-amber-500/30 bg-amber-500/5',
    green: 'border-green-500/30 bg-green-500/5',
    blue: 'border-blue-500/30 bg-blue-500/5',
    emerald: 'border-emerald-500/30 bg-emerald-500/5',
  };

  return (
    <div className="space-y-6">
      {/* 流程图 */}
      <div className="bg-slate-800/60 rounded-xl border border-slate-700/50 p-6">
        <h3 className="text-lg font-bold text-white mb-6 flex items-center gap-2">
          <ClipboardList className="w-5 h-5 text-purple-400" />
          完整流程
        </h3>
        <div className="space-y-4">
          {steps.map((step, i) => (
            <div key={step.num} className="flex gap-4">
              {/* 左侧：步骤编号和连线 */}
              <div className="flex flex-col items-center shrink-0">
                <div className={`w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold text-white bg-${step.color === 'purple' ? 'purple' : step.color === 'cyan' ? 'cyan' : step.color === 'amber' ? 'amber' : step.color === 'green' ? 'green' : step.color === 'blue' ? 'blue' : 'emerald'}-600`}
                  style={{
                    background: step.color === 'purple' ? '#7c3aed' : step.color === 'cyan' ? '#06b6d4' : step.color === 'amber' ? '#d97706' : step.color === 'green' ? '#16a34a' : step.color === 'blue' ? '#2563eb' : '#059669',
                  }}
                >
                  {step.num}
                </div>
                {i < steps.length - 1 && (
                  <div className="w-0.5 h-8 bg-slate-600/50 my-1" />
                )}
              </div>
              {/* 右侧：内容 */}
              <div className={`flex-1 rounded-xl border p-4 ${colorMap[step.color]}`}>
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-slate-400">{step.icon}</span>
                  <h4 className="font-semibold text-white">{step.title}</h4>
                </div>
                <p className="text-sm text-slate-400 leading-relaxed">{step.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 角色分工 */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="bg-slate-800/60 rounded-xl border border-purple-500/20 p-5">
          <h4 className="font-bold text-white flex items-center gap-2 mb-3">
            <Settings className="w-5 h-5 text-purple-400" />
            你在平台侧操作（3 步）
          </h4>
          <ul className="space-y-2 text-sm text-slate-300">
            <li className="flex items-start gap-2">
              <CheckCircle2 className="w-4 h-4 text-green-400 mt-0.5 shrink-0" />
              <span>进入 ⚙ 管理 → 注册游戏（填游戏ID、名称、开发商）</span>
            </li>
            <li className="flex items-start gap-2">
              <CheckCircle2 className="w-4 h-4 text-green-400 mt-0.5 shrink-0" />
              <span>选中游戏 → 创建道具（配置名称/价格/gameItemId）</span>
            </li>
            <li className="flex items-start gap-2">
              <CheckCircle2 className="w-4 h-4 text-green-400 mt-0.5 shrink-0" />
              <span>铸造凭证 → 设定初始库存数量</span>
            </li>
          </ul>
        </div>
        <div className="bg-slate-800/60 rounded-xl border border-blue-500/20 p-5">
          <h4 className="font-bold text-white flex items-center gap-2 mb-3">
            <Server className="w-5 h-5 text-blue-400" />
            你在游戏侧做（2 步）
          </h4>
          <ul className="space-y-2 text-sm text-slate-300">
            <li className="flex items-start gap-2">
              <Terminal className="w-4 h-4 text-yellow-400 mt-0.5 shrink-0" />
              <span>游戏内添加兑换码输入框，接收玩家输入的 IV-XXXXXXXX</span>
            </li>
            <li className="flex items-start gap-2">
              <Terminal className="w-4 h-4 text-yellow-400 mt-0.5 shrink-0" />
              <span>后端调用 verifyCode → useCode → 根据 gameEffect 发放道具</span>
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}

function ApiDocsSection() {
  const baseUrl = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000';

  return (
    <div className="space-y-6">
      {/* 基础信息 */}
      <div className="bg-slate-800/60 rounded-xl border border-slate-700/50 p-5">
        <h3 className="text-lg font-bold text-white flex items-center gap-2 mb-4">
          <Server className="w-5 h-5 text-blue-400" />
          API 基础信息
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
          <div className="bg-slate-900/50 rounded-lg p-3">
            <span className="text-slate-500 text-xs">Base URL</span>
            <p className="text-slate-300 font-mono">{baseUrl}/api/redeem</p>
          </div>
          <div className="bg-slate-900/50 rounded-lg p-3">
            <span className="text-slate-500 text-xs">Content-Type</span>
            <p className="text-slate-300 font-mono">application/json</p>
          </div>
          <div className="bg-slate-900/50 rounded-lg p-3">
            <span className="text-slate-500 text-xs">鉴权方式</span>
            <p className="text-slate-300">Bearer Token（可选，建议使用 API Key）</p>
          </div>
          <div className="bg-slate-900/50 rounded-lg p-3">
            <span className="text-slate-500 text-xs">响应格式</span>
            <p className="text-slate-300 font-mono">{`{ success, data, error }`}</p>
          </div>
        </div>
      </div>

      {/* 验证接口 */}
      <div className="bg-slate-800/60 rounded-xl border border-green-500/20 p-5">
        <div className="flex items-center gap-2 mb-4">
          <span className="px-2 py-0.5 bg-green-600 rounded text-xs font-bold text-white">POST</span>
          <h3 className="text-lg font-bold text-white font-mono">/api/redeem/verify</h3>
          <span className="text-xs text-green-400">验证兑换码</span>
        </div>
        <p className="text-sm text-slate-400 mb-4">
          验证玩家输入的兑换码是否有效。此接口是幂等的，不会修改兑换码状态，可多次调用。
        </p>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div>
            <h4 className="text-sm font-semibold text-white mb-2">Request Body</h4>
            <pre className="bg-slate-950 rounded-lg p-3 text-xs text-slate-300 overflow-x-auto">
{`{
  "code": "IV-A3F9K2M7",
  "gameId": "ext-genshin-1717300000000"
}`}
            </pre>
          </div>
          <div>
            <h4 className="text-sm font-semibold text-white mb-2">Response (有效)</h4>
            <pre className="bg-slate-950 rounded-lg p-3 text-xs text-slate-300 overflow-x-auto">
{`{
  "success": true,
  "data": {
    "valid": true,
    "code": "IV-A3F9K2M7",
    "itemName": "月卡",
    "gameEffect": {
      "itemId": "monthly_card",
      "quantity": 1
    }
  }
}`}
            </pre>
          </div>
        </div>
        <div className="mt-3">
          <h4 className="text-sm font-semibold text-white mb-2">错误响应示例</h4>
          <pre className="bg-slate-950 rounded-lg p-3 text-xs text-slate-300 overflow-x-auto">
{`// 已使用:   { "success": true, "data": { "valid": false, "message": "兑换码已被使用" } }
// 已过期:   { "success": true, "data": { "valid": false, "message": "兑换码已过期" } }
// 不存在:   { "success": true, "data": { "valid": false, "message": "兑换码不存在" } }`}
          </pre>
        </div>
      </div>

      {/* 核销接口 */}
      <div className="bg-slate-800/60 rounded-xl border border-red-500/20 p-5">
        <div className="flex items-center gap-2 mb-4">
          <span className="px-2 py-0.5 bg-red-600 rounded text-xs font-bold text-white">POST</span>
          <h3 className="text-lg font-bold text-white font-mono">/api/redeem/use</h3>
          <span className="text-xs text-red-400">核销兑换码</span>
        </div>
        <p className="text-sm text-slate-400 mb-4">
          标记兑换码为已使用并发放道具。<strong className="text-amber-400">⚠️ 应先调用 verify 确认有效，再调用此接口。</strong> 调用后兑换码不可再使用。
        </p>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div>
            <h4 className="text-sm font-semibold text-white mb-2">Request Body</h4>
            <pre className="bg-slate-950 rounded-lg p-3 text-xs text-slate-300 overflow-x-auto">
{`{
  "code": "IV-A3F9K2M7",
  "gameId": "ext-genshin-1717300000000",
  "userId": "player_12345"
}`}
            </pre>
          </div>
          <div>
            <h4 className="text-sm font-semibold text-white mb-2">Response (成功)</h4>
            <pre className="bg-slate-950 rounded-lg p-3 text-xs text-slate-300 overflow-x-auto">
{`{
  "success": true,
  "data": {
    "success": true,
    "code": "IV-A3F9K2M7",
    "itemName": "月卡",
    "gameEffect": {
      "itemId": "monthly_card",
      "quantity": 1
    },
    "usedAt": "2026-06-02T09:00:00.000Z"
  }
}`}
            </pre>
          </div>
        </div>
      </div>

      {/* 同步接口 */}
      <div className="bg-slate-800/60 rounded-xl border border-purple-500/20 p-5">
        <div className="flex items-center gap-2 mb-4">
          <span className="px-2 py-0.5 bg-purple-600 rounded text-xs font-bold text-white">POST</span>
          <h3 className="text-lg font-bold text-white font-mono">/api/redeem/sync</h3>
          <span className="text-xs text-purple-400">前端数据同步（平台内部使用）</span>
        </div>
        <p className="text-sm text-slate-400">
          平台前端自动调用，将 localStorage 中的兑换码和道具数据同步到后端存储。游戏开发商无需关心此接口。
        </p>
      </div>
    </div>
  );
}

function IntegrationSection() {
  const baseUrl = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000';

  return (
    <div className="space-y-6">
      {/* Node.js 示例 */}
      <div className="bg-slate-800/60 rounded-xl border border-slate-700/50 p-5">
        <h3 className="text-lg font-bold text-white flex items-center gap-2 mb-4">
          <Terminal className="w-5 h-5 text-green-400" />
          Node.js 后端接入示例
        </h3>
        <pre className="bg-slate-950 rounded-lg p-4 text-xs text-slate-300 overflow-x-auto leading-relaxed">
{`// redeemClient.js - 游戏后端兑换码客户端
const REDEEM_API = '${baseUrl}/api/redeem';

/**
 * 验证 + 核销兑换码（推荐的安全流程）
 */
async function redeemCode(gameId, code, playerId) {
  // Step 1: 验证兑换码
  const verifyRes = await fetch(REDEEM_API + '/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, gameId }),
  });
  const verifyData = await verifyRes.json();

  if (!verifyData.success || !verifyData.data.valid) {
    return {
      success: false,
      error: verifyData.data?.message || '验证失败',
    };
  }

  // Step 2: 核销兑换码
  const useRes = await fetch(REDEEM_API + '/use', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, gameId, userId: playerId }),
  });
  const useData = await useRes.json();

  if (!useData.success || !useData.data.success) {
    return {
      success: false,
      error: useData.data?.message || '核销失败',
    };
  }

  // Step 3: 根据 gameEffect 发放道具
  const { gameEffect, itemName } = useData.data;
  await grantItemToPlayer(playerId, gameEffect);

  return {
    success: true,
    itemName,
    gameEffect,
  };
}

// 发放道具到玩家背包
async function grantItemToPlayer(playerId, gameEffect) {
  const { itemId, quantity } = gameEffect;
  // 你的游戏逻辑：给玩家添加道具
  // await db.addItem(playerId, itemId, quantity);
  console.log(\`发放 \${quantity}x \${itemId} 给玩家 \${playerId}\`);
}`}
        </pre>
      </div>

      {/* 游戏内兑换 UI */}
      <div className="bg-slate-800/60 rounded-xl border border-slate-700/50 p-5">
        <h3 className="text-lg font-bold text-white flex items-center gap-2 mb-4">
          <Gamepad2 className="w-5 h-5 text-purple-400" />
          游戏内兑换 UI 设计建议
        </h3>
        <div className="space-y-3">
          <div className="flex items-start gap-3 bg-slate-900/50 rounded-lg p-3">
            <Code className="w-5 h-5 text-blue-400 mt-0.5 shrink-0" />
            <div>
              <h4 className="text-sm font-semibold text-white">输入框格式提示</h4>
              <p className="text-xs text-slate-400 mt-1">
                兑换码格式为 <code className="text-yellow-400 bg-slate-800 px-1 rounded">IV-XXXXXXXX</code>（8位字母数字）。
                建议使用分段输入框（如 IV- + 8个字符），提升用户体验。
              </p>
            </div>
          </div>
          <div className="flex items-start gap-3 bg-slate-900/50 rounded-lg p-3">
            <AlertCircle className="w-5 h-5 text-amber-400 mt-0.5 shrink-0" />
            <div>
              <h4 className="text-sm font-semibold text-white">错误提示</h4>
              <p className="text-xs text-slate-400 mt-1">
                处理常见错误：兑换码不存在 / 已被使用 / 已过期 / 不属于此游戏。
                向玩家展示友好的错误提示，引导联系客服或检查输入。
              </p>
            </div>
          </div>
          <div className="flex items-start gap-3 bg-slate-900/50 rounded-lg p-3">
            <ShieldCheck className="w-5 h-5 text-green-400 mt-0.5 shrink-0" />
            <div>
              <h4 className="text-sm font-semibold text-white">防重放保护</h4>
              <p className="text-xs text-slate-400 mt-1">
                务必先调用 verify 再调用 use，确保原子性。
                建议添加服务端请求去重（基于 code 去重），防止同一兑换码被重复核销。
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Python 示例 */}
      <div className="bg-slate-800/60 rounded-xl border border-slate-700/50 p-5">
        <h3 className="text-lg font-bold text-white flex items-center gap-2 mb-4">
          <Terminal className="w-5 h-5 text-yellow-400" />
          Python 后端接入示例
        </h3>
        <pre className="bg-slate-950 rounded-lg p-4 text-xs text-slate-300 overflow-x-auto leading-relaxed">
{`# redeem_client.py
import requests

REDEEM_API = "${baseUrl}/api/redeem"

def redeem_code(game_id: str, code: str, player_id: str) -> dict:
    """验证并核销兑换码"""
    # Step 1: 验证
    verify_resp = requests.post(
        f"{REDEEM_API}/verify",
        json={"code": code, "gameId": game_id},
    )
    verify_data = verify_resp.json()

    if not verify_data.get("success") or not verify_data["data"].get("valid"):
        return {
            "success": False,
            "error": verify_data["data"].get("message", "验证失败"),
        }

    # Step 2: 核销
    use_resp = requests.post(
        f"{REDEEM_API}/use",
        json={"code": code, "gameId": game_id, "userId": player_id},
    )
    use_data = use_resp.json()

    if not use_data.get("success") or not use_data["data"].get("success"):
        return {
            "success": False,
            "error": use_data["data"].get("message", "核销失败"),
        }

    # Step 3: 发放道具
    game_effect = use_data["data"]["gameEffect"]
    grant_item(player_id, game_effect["itemId"], game_effect["quantity"])

    return {
        "success": True,
        "itemName": use_data["data"]["itemName"],
        "gameEffect": game_effect,
    }

def grant_item(player_id: str, item_id: str, quantity: int):
    """发放道具到玩家背包（你的游戏逻辑）"""
    # db.execute("INSERT INTO inventory ...")
    print(f"发放 {quantity}x {item_id} 给 {player_id}")
`}
        </pre>
      </div>
    </div>
  );
}

// ==================== 主组件 ====================

export default function PlatformGameStore() {
  const { currentUser } = useContext(AuthContext);
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<TabMode>('browse');
  const [games, setGames] = useState<ExternalGameStore[]>([]);
  const [items, setItems] = useState<PlatformStoreItem[]>([]);
  const [selectedGameId, setSelectedGameId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<StoreSortBy>('popular');
  const [showFilters, setShowFilters] = useState(false);
  const [balance, setBalance] = useState<Record<string, number>>({});
  const [voucherBalance, setVoucherBalance] = useState<number>(0);
  const [isLoading, setIsLoading] = useState(true);

  const [purchaseState, setPurchaseState] = useState<PurchaseState>({
    isPurchasing: false,
    templateId: null,
    success: false,
    error: null,
  });

  // 刷新商店数据
  const refreshStore = useCallback(() => {
    const gs = platformGameStoreService.getGames(true);
    setGames(gs);

    const query: PlatformStoreQuery = {
      gameId: selectedGameId || undefined,
      sortBy,
      search: searchQuery || undefined,
    };
    setItems(platformGameStoreService.getStoreItems(query));
  }, [selectedGameId, sortBy, searchQuery]);

  // 刷新余额
  const loadBalance = useCallback(async () => {
    try {
      const result = await skillGateway.execute('wallet', 'getBalance', {}, {
        userId: currentUser?.uid || currentUser?.id || 'anonymous',
        sessionId: 'web',
      });
      if (result.success && result.data) {
        const raw = result.data as any;
        const w = raw?.data ?? raw;
        setBalance({
          gameCoins: w.gameCoins || 0,
        });
      }
    } catch { /* ignore */ }
    // A币余额从凭证系统读取
    try {
      const { voucherPaymentService } = await import('@/services/voucherPaymentService');
      const uid = currentUser?.uid || currentUser?.id || 'anonymous';
      setVoucherBalance(voucherPaymentService.getUserVoucherBalance(uid));
    } catch { /* ignore */ }
  }, [currentUser]);

  useEffect(() => {
    setIsLoading(true);
    refreshStore();
    loadBalance();
    setIsLoading(false);

    // 监听购买成功事件
    const handler = () => refreshStore();
    window.addEventListener('platform-store-purchased', handler);
    return () => window.removeEventListener('platform-store-purchased', handler);
  }, [refreshStore, loadBalance]);

  // 搜索防抖
  useEffect(() => {
    const t = setTimeout(refreshStore, 300);
    return () => clearTimeout(t);
  }, [searchQuery, sortBy, selectedGameId, refreshStore]);

  // ============ 购买处理 ============

  const handlePurchase = async (item: PlatformStoreItem) => {
    if (purchaseState.isPurchasing) return;
    if (!currentUser?.id) {
      setPurchaseState({
        isPurchasing: false,
        templateId: item.templateId,
        success: false,
        error: '请先登录',
      });
      return;
    }

    setPurchaseState({
      isPurchasing: true,
      templateId: item.templateId,
      success: false,
      error: null,
    });

    try {
      const result = await platformGameStoreService.purchaseItem({
        userId: currentUser.id,
        userName: currentUser.username || '玩家',
        gameId: item.gameId,
        templateId: item.templateId,
        paymentMethod: item.currency === 'ACOIN' ? 'voucher' : 'wallet',
        paymentCurrency: item.currency === 'ACOIN' ? 'aCoins' : 'gameCoins',
      });

      if (!result.success) {
        throw new Error(result.message);
      }

      await loadBalance();
      refreshStore();

      setPurchaseState({
        isPurchasing: false,
        templateId: item.templateId,
        success: true,
        error: null,
        redeemCode: result.redeemCode,
      });

      setTimeout(() => {
        setPurchaseState(prev => ({ ...prev, success: false, templateId: null, redeemCode: undefined }));
      }, 6000);
    } catch (error) {
      setPurchaseState({
        isPurchasing: false,
        templateId: item.templateId,
        success: false,
        error: error instanceof Error ? error.message : '购买失败',
      });
    }
  };

  // ============ 渲染 ============

  const overview = platformGameStoreService.getOverview();

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-slate-900 to-slate-800 flex items-center justify-center">
        <div className="text-center">
          <div className="w-12 h-12 border-4 border-purple-500 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-slate-400">加载游戏商店...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-900 via-slate-800 to-slate-900 text-white">
      {/* Header */}
      <header className="bg-slate-800/80 backdrop-blur-md border-b border-slate-700 sticky top-0 z-50">
        <div className="container mx-auto px-4 py-4">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div className="flex items-center gap-4">
              <div>
                <h1 className="text-xl font-bold text-white flex items-center gap-2">
                  <Store className="w-5 h-5 text-purple-400" />
                  游戏商店
                </h1>
                <p className="text-sm text-slate-400">
                  {activeTab === 'browse' && '来自各大游戏的道具与商品，购买即得兑换码'}
                  {activeTab === 'myItems' && '查看已购买的道具凭证和兑换码'}
                  {activeTab === 'devGuide' && '游戏开发商接入指南：注册游戏 → 管理道具 → API 核销'}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-3">
              {/* 余额 */}
              <div className="flex items-center gap-2 bg-slate-700/50 rounded-lg px-3 py-1.5">
                <Coins className="w-4 h-4 text-yellow-500" />
                <span className="text-white font-medium text-sm">{balance.gameCoins || 0}</span>
              </div>
              <div className="flex items-center gap-2 bg-slate-700/50 rounded-lg px-3 py-1.5" title="A币（凭证系统）">
                <ShieldCheck className="w-4 h-4 text-blue-400" />
                <span className="text-white font-medium text-sm">{voucherBalance || 0}</span>
              </div>

              {/* 管理入口 */}
              <button
                onClick={() => navigate('/game-store-manage')}
                className="flex items-center gap-1.5 px-3 py-2 bg-slate-700/50 hover:bg-slate-600/80 text-slate-300 hover:text-white rounded-lg text-sm font-medium transition-colors"
                title="管理我的游戏和道具"
              >
                <Settings className="w-4 h-4" />
                <span className="hidden sm:inline">管理</span>
              </button>

              {/* 标签页切换 */}
              <div className="flex bg-slate-700/30 rounded-lg p-0.5">
                <button
                  onClick={() => setActiveTab('browse')}
                  className={`px-3 py-1.5 rounded-md text-sm font-medium transition-all ${
                    activeTab === 'browse' ? 'bg-purple-600 text-white' : 'text-slate-400 hover:text-white'
                  }`}
                >
                  <Store className="w-4 h-4 inline mr-1" />
                  商店
                </button>
                <button
                  onClick={() => setActiveTab('myItems')}
                  className={`px-3 py-1.5 rounded-md text-sm font-medium transition-all ${
                    activeTab === 'myItems' ? 'bg-green-600 text-white' : 'text-slate-400 hover:text-white'
                  }`}
                >
                  <Package className="w-4 h-4 inline mr-1" />
                  我的道具
                </button>
                <button
                  onClick={() => setActiveTab('devGuide')}
                  className={`px-3 py-1.5 rounded-md text-sm font-medium transition-all ${
                    activeTab === 'devGuide' ? 'bg-cyan-600 text-white' : 'text-slate-400 hover:text-white'
                  }`}
                >
                  <BookOpen className="w-4 h-4 inline mr-1" />
                  开发者指南
                </button>
              </div>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="container mx-auto px-4 py-8">
        {activeTab === 'browse' && (
          <>
            {/* 概览统计 */}
            {overview.gameCount > 0 && (
              <div className="grid grid-cols-3 gap-4 mb-8">
                <div className="bg-slate-800/60 rounded-xl p-4 border border-slate-700/50 text-center">
                  <p className="text-2xl font-bold text-purple-400">{overview.gameCount}</p>
                  <p className="text-xs text-slate-400 mt-1">合作游戏</p>
                </div>
                <div className="bg-slate-800/60 rounded-xl p-4 border border-slate-700/50 text-center">
                  <p className="text-2xl font-bold text-cyan-400">{overview.itemCount}</p>
                  <p className="text-xs text-slate-400 mt-1">可购道具</p>
                </div>
                <div className="bg-slate-800/60 rounded-xl p-4 border border-slate-700/50 text-center">
                  <p className="text-2xl font-bold text-green-400">{overview.totalAvailable}</p>
                  <p className="text-xs text-slate-400 mt-1">库存可用</p>
                </div>
              </div>
            )}

            {/* 搜索和筛选 */}
            {games.length > 0 && (
              <div className="flex items-center gap-3 mb-6 flex-wrap">
                <div className="relative flex-1 min-w-[200px] max-w-md">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                    placeholder="搜索道具或游戏..."
                    className="w-full py-2 pl-10 pr-4 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm placeholder:text-slate-500 focus:outline-none focus:border-purple-500"
                  />
                </div>
                <button
                  onClick={() => setShowFilters(!showFilters)}
                  className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm transition-colors ${
                    showFilters ? 'bg-purple-600 text-white' : 'bg-slate-800 text-slate-400 hover:text-white'
                  }`}
                >
                  <SlidersHorizontal className="w-4 h-4" />
                  筛选
                </button>
                <div className="relative">
                  <select
                    value={sortBy}
                    onChange={e => setSortBy(e.target.value as StoreSortBy)}
                    className="appearance-none px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm pr-8 cursor-pointer focus:outline-none focus:border-purple-500"
                  >
                    <option value="popular">最受欢迎</option>
                    <option value="price-asc">价格从低到高</option>
                    <option value="price-desc">价格从高到低</option>
                    <option value="newest">最新上架</option>
                  </select>
                  <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500 pointer-events-none" />
                </div>
              </div>
            )}

            {/* 游戏选择标签 */}
            <AnimatePresence>
              {showFilters && games.length > 0 && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  className="overflow-hidden mb-6"
                >
                  <div className="flex flex-wrap gap-2 p-3 bg-slate-800/50 rounded-xl">
                    <button
                      onClick={() => setSelectedGameId(null)}
                      className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                        !selectedGameId ? 'bg-purple-600 text-white' : 'bg-slate-700 text-slate-400 hover:text-white'
                      }`}
                    >
                      全部游戏
                    </button>
                    {games.map(game => (
                      <button
                        key={game.id}
                        onClick={() => setSelectedGameId(game.gameId)}
                        className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                          selectedGameId === game.gameId ? 'bg-purple-600 text-white' : 'bg-slate-700 text-slate-400 hover:text-white'
                        }`}
                      >
                        {game.gameIcon} {game.gameName}
                      </button>
                    ))}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* 游戏卡片网格（仅当未选中具体游戏时显示） */}
            {!selectedGameId && games.length > 0 && !searchQuery && (
              <div className="mb-8">
                <h2 className="text-lg font-bold text-white mb-4 flex items-center gap-2">
                  <Gamepad2 className="w-5 h-5 text-purple-400" />
                  合作游戏
                </h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  {games.map(game => (
                    <GameCard
                      key={game.id}
                      store={game}
                      itemCount={voucherItemService.getItemTemplates(game.gameId).length}
                      onClick={() => setSelectedGameId(game.gameId)}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* 道具网格 */}
            {items.length > 0 ? (
              <>
                <h2 className="text-lg font-bold text-white mb-4 flex items-center gap-2">
                  <TrendingUp className="w-5 h-5 text-orange-400" />
                  {selectedGameId ? `${games.find(g => g.gameId === selectedGameId)?.gameIcon || ''} 道具列表` : '热门道具'}
                </h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5">
                  {items.map(item => (
                    <ItemCard
                      key={item.templateId}
                      item={item}
                      onPurchase={handlePurchase}
                      purchaseState={purchaseState}
                      onGameClick={(gid) => setSelectedGameId(gid)}
                    />
                  ))}
                </div>
              </>
            ) : (
              <EmptyState
                icon={<Package className="w-16 h-16" />}
                title="暂无道具"
                description={games.length === 0
                  ? '平台商店尚未接入外部游戏，请联系管理员注册游戏和道具'
                  : '当前条件下没有找到道具，请尝试其他筛选条件'}
              />
            )}
          </>
        )}

        {activeTab === 'myItems' && <MyItemsPanel />}
        {activeTab === 'devGuide' && <DeveloperGuidePanel />}
      </main>
    </div>
  );
}
