/**
 * Marketplace — 玩家交易市场（MVP v1.1）
 *
 * 三标签：浏览市场 / 我的上架 / 我的购买
 * 支持 gameCoins + aCoins 两种标价
 * 面额溢价/折价标注，aCoins 支付走凭证系统
 */
import { useState, useEffect, useContext } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { AuthContext } from '@/contexts/authContext';
import { marketplaceService } from '@/services/marketplaceService';
import { voucherService } from '@/voucher-system/services/VoucherService';
import { useWallet } from '@/hooks/useWallet';
import { MARKET_COMMISSION_RATE, loadTreasury } from '@/types/marketplace';
import type { MarketListing, PlatformTreasury } from '@/types/marketplace';
import { VoucherStatus, VoucherSourceType } from '@/voucher-system/types';
import type { Voucher } from '@/voucher-system/types';
import {
  Store, Search, ShoppingCart,
  Tag, TrendingUp, Package, ArrowLeft, Coins,
  AlertTriangle, CheckCircle, Eye, ShieldCheck,
  X, Trash2,
} from 'lucide-react';

type Tab = 'browse' | 'my-listings' | 'my-purchases';

const RARITY_COLORS: Record<string, string> = {
  legendary: 'bg-orange-500/20 text-orange-400 border-orange-500/30',
  epic: 'bg-purple-500/20 text-purple-400 border-purple-500/30',
  rare: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  uncommon: 'bg-green-500/20 text-green-400 border-green-500/30',
  common: 'bg-slate-500/20 text-slate-400 border-slate-500/30',
};

const RARITY_LABEL: Record<string, string> = {
  legendary: '传说',
  epic: '史诗',
  rare: '稀有',
  uncommon: '精良',
  common: '普通',
};

export default function Marketplace() {
  const navigate = useNavigate();
  const { currentUser, isAuthenticated } = useContext(AuthContext);
  const { wallet, refreshWalletData } = useWallet();
  const [activeTab, setActiveTab] = useState<Tab>('browse');
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<'price_asc' | 'price_desc' | 'date_desc' | 'popularity'>('date_desc');
  const [currencyFilter, setCurrencyFilter] = useState<'all' | 'gameCoins' | 'aCoins'>('all');
  const [showListModal, setShowListModal] = useState(false);
  const [purchasing, setPurchasing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // 上架弹窗状态
  const [userItemVouchers, setUserItemVouchers] = useState<Voucher[]>([]);
  const [treasury, setTreasury] = useState<PlatformTreasury>(() => loadTreasury());

  const refreshListings = () => {
    refreshWalletData();
    setTreasury(loadTreasury());
  };

  useEffect(() => {
    if (!isAuthenticated) {
      navigate('/login');
      return;
    }
    refreshListings();
  }, [isAuthenticated, sortBy]);

  // 加载用户可上架的道具凭证
  useEffect(() => {
    if (showListModal && currentUser) {
      const uid = currentUser.uid || currentUser.id || '';
      const vouchers = voucherService.getUserVouchers(uid);
      const itemVouchers = vouchers.filter(
        v =>
          v.status === VoucherStatus.ACTIVE &&
          v.sourceType === VoucherSourceType.ITEM
      );
      setUserItemVouchers(itemVouchers);
    }
  }, [showListModal, currentUser]);

  const handlePurchase = async (listing: MarketListing) => {
    if (!currentUser) return;
    setError(null);
    setPurchasing(listing.id);

    try {
      const result = await marketplaceService.purchase(
        listing.id,
        currentUser.uid || currentUser.id || '',
        currentUser.nickname || currentUser.username || '玩家'
      );
      if (result.success) {
        setSuccess(result.message);
        refreshListings();
        window.dispatchEvent(new CustomEvent('wallet-updated'));
      } else {
        setError(result.message);
      }
    } catch (e: any) {
      setError(e?.message || '购买失败');
    } finally {
      setPurchasing(null);
      setTimeout(() => {
        setError(null);
        setSuccess(null);
      }, 4000);
    }
  };

  const handleDelist = async (listingId: string) => {
    if (!currentUser) return;
    const uid = currentUser.uid || currentUser.id || '';
    const result = marketplaceService.delistItem(listingId, uid);
    if (result.success) {
      setSuccess('下架成功，凭证已退还');
      refreshListings();
    } else {
      setError(result.message);
    }
  };

  const filteredListings = marketplaceService.searchListings({
    query: searchQuery || undefined,
    currency: currencyFilter === 'all' ? undefined : currencyFilter,
    sortBy,
  });

  const filteredMyListings = marketplaceService.getUserListings(
    currentUser?.uid || currentUser?.id || ''
  );

  const filteredMyPurchases = marketplaceService.getUserPurchases(
    currentUser?.uid || currentUser?.id || ''
  );

  const stats = marketplaceService.getStats();

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-900 via-slate-800 to-slate-900 text-white">
      {/* Header */}
      <header className="bg-slate-800/80 backdrop-blur-md border-b border-slate-700 sticky top-0 z-50">
        <div className="container mx-auto px-4 py-4">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div className="flex items-center gap-4">
              <Link
                to="/"
                className="w-10 h-10 rounded-lg bg-slate-700 hover:bg-slate-600 flex items-center justify-center text-white transition-colors"
              >
                <ArrowLeft className="w-5 h-5" />
              </Link>
              <div>
                <h1 className="text-xl font-bold text-white flex items-center gap-2">
                  <Store className="w-5 h-5 text-purple-400" />
                  🏪 玩家交易市场
                </h1>
                <p className="text-sm text-slate-400">
                  {activeTab === 'browse' && '浏览市场，发现心仪道具'}
                  {activeTab === 'my-listings' && '管理你在售的商品'}
                  {activeTab === 'my-purchases' && '查看购买记录'}
                </p>
              </div>
            </div>

            {/* 余额 */}
            <div className="flex items-center gap-3 bg-slate-700/50 rounded-lg px-4 py-2">
              <div className="flex items-center gap-2" title="游戏币（钱包）">
                <Coins className="w-4 h-4 text-yellow-500" />
                <span className="text-white font-medium text-sm">
                  {(wallet?.gameCoins || 0).toLocaleString()}
                </span>
              </div>
              <div className="w-px h-4 bg-slate-600" />
              <div className="flex items-center gap-2" title="A币（凭证）">
                <ShieldCheck className="w-4 h-4 text-blue-400" />
                <span className="text-white font-medium text-sm">
                  {(wallet?.voucherBalance || 0).toLocaleString()}
                </span>
              </div>
              {activeTab === 'browse' && (
                <>
                  <div className="w-px h-4 bg-slate-600" />
                  <button
                    onClick={() => setShowListModal(true)}
                    className="px-3 py-1.5 bg-purple-600 hover:bg-purple-700 rounded-lg text-sm text-white font-medium transition-colors flex items-center gap-1.5"
                  >
                    <Tag className="w-3.5 h-3.5" />
                    上架道具
                  </button>
                </>
              )}
            </div>
          </div>

          {/* 标签页 */}
          <div className="flex items-center gap-2 mt-4 pt-4 border-t border-slate-700/50">
            {[
              { key: 'browse' as Tab, label: '浏览市场' },
              { key: 'my-listings' as Tab, label: `我的上架 (${filteredMyListings.length})` },
              { key: 'my-purchases' as Tab, label: `我的购买 (${filteredMyPurchases.length})` },
            ].map((tab) => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`px-4 py-2 rounded-lg font-medium transition-all text-sm ${
                  activeTab === tab.key
                    ? 'bg-purple-600 text-white'
                    : 'text-slate-400 hover:text-white hover:bg-slate-700/50'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>
      </header>

      {/* Toast */}
      <AnimatePresence>
        {(error || success) && (
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className={`fixed top-20 left-1/2 -translate-x-1/2 z-50 px-6 py-3 rounded-xl shadow-lg flex items-center gap-3 ${
              error ? 'bg-red-600' : 'bg-green-600'
            }`}
          >
            {error ? <AlertTriangle className="w-5 h-5" /> : <CheckCircle className="w-5 h-5" />}
            <span className="text-sm font-medium">{error || success}</span>
            <button onClick={() => { setError(null); setSuccess(null); }}>
              <X className="w-4 h-4" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      <main className="container mx-auto px-4 py-6">
        {/* 统计卡片（浏览标签） */}
        {activeTab === 'browse' && (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
            {[
              { icon: <Store className="w-5 h-5" />, label: '在售', value: stats.totalListings, color: 'text-purple-400' },
              { icon: <TrendingUp className="w-5 h-5" />, label: '今日成交', value: stats.dailyTransactions, color: 'text-green-400' },
              { icon: <Coins className="w-5 h-5" />, label: '总成交额', value: stats.totalVolume, color: 'text-yellow-400' },
              { icon: <Tag className="w-5 h-5" />, label: '均价', value: stats.averagePrice, color: 'text-blue-400' },
            ].map((s, i) => (
              <div key={i} className="p-4 bg-slate-800/60 rounded-xl border border-slate-700/40">
                <div className={`${s.color} mb-1`}>{s.icon}</div>
                <div className="text-2xl font-bold">{typeof s.value === 'number' ? s.value.toLocaleString() : s.value}</div>
                <div className="text-xs text-slate-400 mt-0.5">{s.label}</div>
              </div>
            ))}
          </div>
        )}

        {/* 平台金库（浏览标签） */}
        {activeTab === 'browse' && (
          <div className="mb-6 p-4 bg-amber-500/10 border border-amber-500/20 rounded-xl">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div className="flex items-center gap-2">
                <span className="text-lg">🏛️</span>
                <span className="text-sm font-medium text-amber-300">平台金库</span>
                <span className="text-xs text-slate-500">（{MARKET_COMMISSION_RATE * 100}% 交易佣金累积）</span>
              </div>
              <div className="flex items-center gap-4 text-sm">
                <div className="flex items-center gap-1.5">
                  <Coins className="w-4 h-4 text-yellow-500" />
                  <span className="font-bold text-yellow-400">{treasury.gameCoins.toLocaleString()}</span>
                  <span className="text-slate-500 text-xs">GC</span>
                </div>
                <div className="w-px h-4 bg-amber-500/30" />
                <div className="flex items-center gap-1.5">
                  <ShieldCheck className="w-4 h-4 text-blue-400" />
                  <span className="font-bold text-blue-400">{treasury.aCoins.toLocaleString()}</span>
                  <span className="text-slate-500 text-xs">A币</span>
                </div>
                <div className="w-px h-4 bg-amber-500/30" />
                <span className="text-xs text-slate-500">
                  {treasury.totalTransactions > 0 ? `${treasury.totalTransactions} 笔交易` : '暂无交易'}
                </span>
              </div>
            </div>
          </div>
        )}

        {/* 搜索栏（浏览标签） */}
        {activeTab === 'browse' && (
          <div className="flex flex-col sm:flex-row gap-3 mb-6">
            <div className="flex-1 relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <input
                type="text"
                placeholder="搜索道具名称..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-10 pr-4 py-2.5 bg-slate-700 rounded-lg text-white text-sm border border-slate-600 focus:border-purple-500 focus:outline-none transition-colors"
              />
            </div>
            <select
              value={currencyFilter}
              onChange={(e) => setCurrencyFilter(e.target.value as any)}
              className="px-4 py-2.5 bg-slate-700 rounded-lg text-white text-sm border border-slate-600 focus:border-purple-500 focus:outline-none"
            >
              <option value="all">全部货币</option>
              <option value="gameCoins">💰 游戏币</option>
              <option value="aCoins">🎫 A币</option>
            </select>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as any)}
              className="px-4 py-2.5 bg-slate-700 rounded-lg text-white text-sm border border-slate-600 focus:border-purple-500 focus:outline-none"
            >
              <option value="date_desc">最新上架</option>
              <option value="price_asc">价格从低到高</option>
              <option value="price_desc">价格从高到低</option>
              <option value="popularity">最受欢迎</option>
            </select>
          </div>
        )}

        {/* ====== 浏览市场 ====== */}
        {activeTab === 'browse' && (
          <>
            {filteredListings.length === 0 ? (
              <EmptyState icon={<Package className="w-16 h-16" />} text="暂无在售商品" sub="成为第一个上架道具的玩家吧！" />
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {filteredListings.map((listing) => (
                  <ListingCard
                    key={listing.id}
                    listing={listing}
                    isOwner={listing.sellerId === (currentUser?.uid || currentUser?.id)}
                    isPurchasing={purchasing === listing.id}
                    onPurchase={() => handlePurchase(listing)}
                    onDelist={() => handleDelist(listing.id)}
                  />
                ))}
              </div>
            )}
          </>
        )}

        {/* ====== 我的上架 ====== */}
        {activeTab === 'my-listings' && (
          <>
            {filteredMyListings.length === 0 ? (
              <EmptyState icon={<Tag className="w-16 h-16" />} text="还没有在售商品" sub="前往「浏览市场」页面上架你的道具凭证" />
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {filteredMyListings.map((listing) => (
                  <ListingCard
                    key={listing.id}
                    listing={listing}
                    isOwner={true}
                    isPurchasing={false}
                    onPurchase={() => {}}
                    onDelist={() => handleDelist(listing.id)}
                  />
                ))}
              </div>
            )}
          </>
        )}

        {/* ====== 我的购买 ====== */}
        {activeTab === 'my-purchases' && (
          <>
            {filteredMyPurchases.length === 0 ? (
              <EmptyState icon={<ShoppingCart className="w-16 h-16" />} text="暂无购买记录" sub="在浏览市场中发现心仪的道具吧" />
            ) : (
              <div className="space-y-3">
                {filteredMyPurchases.map((listing) => (
                  <div key={listing.id} className="p-4 bg-slate-800/60 rounded-xl border border-slate-700/40 flex items-center justify-between flex-wrap gap-3">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-lg bg-purple-500/20 flex items-center justify-center text-purple-400">
                        <Package className="w-5 h-5" />
                      </div>
                      <div>
                        <div className="font-medium text-white">{listing.itemName}</div>
                        <div className="text-xs text-slate-400">
                          卖家: {listing.sellerName} · {listing.soldAt ? new Date(listing.soldAt).toLocaleDateString() : '—'}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {listing.rarity && (
                        <span className={`text-xs px-2 py-0.5 rounded border ${RARITY_COLORS[listing.rarity] || ''}`}>
                          {RARITY_LABEL[listing.rarity] || listing.rarity}
                        </span>
                      )}
                      <span className="font-bold text-yellow-400">
                        -{listing.price.toLocaleString()} {listing.currency === 'aCoins' ? 'A币' : 'GC'}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </main>

      {/* 上架弹窗 */}
      <AnimatePresence>
        {showListModal && (
          <ListingModal
            userItemVouchers={userItemVouchers}
            onClose={() => setShowListModal(false)}
            onListed={() => {
              setShowListModal(false);
              refreshListings();
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

// ==================== 空状态 ====================

function EmptyState({ icon, text, sub }: { icon: React.ReactNode; text: string; sub: string }) {
  return (
    <div className="text-center py-16">
      <div className="text-slate-600 mb-4 flex justify-center">{icon}</div>
      <p className="text-slate-400 text-lg mb-1">{text}</p>
      <p className="text-slate-500 text-sm">{sub}</p>
    </div>
  );
}

// ==================== 商品卡片 ====================

function ListingCard({
  listing,
  isOwner,
  isPurchasing,
  onPurchase,
  onDelist,
}: {
  listing: MarketListing;
  isOwner: boolean;
  isPurchasing: boolean;
  onPurchase: () => void;
  onDelist: () => void;
}) {
  const priceDiff = listing.price - listing.denomination;
  const priceDiffPercent = listing.denomination > 0
    ? Math.round((priceDiff / listing.denomination) * 100)
    : 0;

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="bg-slate-800/60 rounded-xl border border-slate-700/40 hover:border-purple-500/30 transition-all overflow-hidden"
    >
      {/* 道具图标区域 */}
      <div className="aspect-square bg-gradient-to-br from-slate-700 to-slate-800 flex items-center justify-center relative">
        <Package className="w-12 h-12 text-slate-500" />
        {/* 状态标签 */}
        {listing.status !== 'active' && (
          <div className={`absolute top-2 right-2 px-2 py-0.5 rounded text-xs font-medium ${
            listing.status === 'sold' ? 'bg-green-600 text-white' : 'bg-slate-600 text-slate-300'
          }`}>
            {listing.status === 'sold' ? '已售出' : '已取消'}
          </div>
        )}
        {/* 稀有度标签 */}
        {listing.rarity && listing.status === 'active' && (
          <div className={`absolute top-2 right-2 px-2 py-0.5 rounded text-xs border ${RARITY_COLORS[listing.rarity] || ''}`}>
            {RARITY_LABEL[listing.rarity] || listing.rarity}
          </div>
        )}
        {/* 凭证编号 */}
        <div className="absolute bottom-2 left-2 text-[10px] text-slate-600 font-mono">
          #{listing.voucherSerial}
        </div>
      </div>

      <div className="p-4">
        <h3 className="font-bold text-white text-sm mb-1 truncate">{listing.itemName}</h3>
        <p className="text-xs text-slate-400 mb-3 line-clamp-2">{listing.itemDescription}</p>

        {/* 价格 + 面额提示 */}
        <div className="flex items-end justify-between mb-2">
          <div>
            <div className="flex items-center gap-1.5">
              {listing.currency === 'aCoins' ? (
                <ShieldCheck className="w-4 h-4 text-blue-400" />
              ) : (
                <Coins className="w-4 h-4 text-yellow-500" />
              )}
              <span className="text-xl font-bold text-white">{listing.price.toLocaleString()}</span>
              <span className="text-xs text-slate-500">{listing.currency === 'aCoins' ? 'A币' : 'GC'}</span>
            </div>
            {/* 面值差异提示 */}
            {listing.denomination > 0 && Math.abs(priceDiffPercent) > 20 && (
              <div className={`text-[10px] mt-0.5 ${
                priceDiffPercent > 0 ? 'text-orange-400' : 'text-green-400'
              }`}>
                <AlertTriangle className="w-3 h-3 inline mr-0.5" />
                {priceDiffPercent > 0
                  ? `溢价 ${priceDiffPercent}%（面值 ${listing.denomination}）`
                  : `折价 ${Math.abs(priceDiffPercent)}%（面值 ${listing.denomination}）`}
              </div>
            )}
          </div>
          <div className="text-[10px] text-slate-500 flex items-center gap-1">
            <Eye className="w-3 h-3" />
            {listing.views}
          </div>
        </div>

        {/* 卖家信息 */}
        <div className="flex items-center gap-2 text-xs text-slate-500 mb-3">
          <span>卖家: {listing.sellerName}</span>
          {listing.gameName && <span>· {listing.gameName}</span>}
        </div>

        {/* 操作按钮 */}
        {listing.status === 'active' && (
          <>
            {isOwner ? (
              <button
                onClick={onDelist}
                className="w-full py-2.5 bg-red-600/20 hover:bg-red-600/40 text-red-400 rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2 border border-red-500/20"
              >
                <Trash2 className="w-4 h-4" />
                下架
              </button>
            ) : (
              <button
                onClick={onPurchase}
                disabled={isPurchasing}
                className={`w-full py-2.5 rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2 ${
                  isPurchasing
                    ? 'bg-slate-600 text-slate-300'
                    : 'bg-purple-600 hover:bg-purple-700 text-white'
                }`}
              >
                {isPurchasing ? (
                  <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                ) : (
                  <ShoppingCart className="w-4 h-4" />
                )}
                {isPurchasing ? '处理中...' : `立即购买 · 佣金 ${Math.round(MARKET_COMMISSION_RATE * 100)}%`}
              </button>
            )}
          </>
        )}
      </div>
    </motion.div>
  );
}

// ==================== 上架弹窗 ====================

function ListingModal({
  userItemVouchers,
  onClose,
  onListed,
}: {
  userItemVouchers: Voucher[];
  onClose: () => void;
  onListed: () => void;
}) {
  const { currentUser } = useContext(AuthContext);
  const [selectedVoucherId, setSelectedVoucherId] = useState('');
  const [price, setPrice] = useState(100);
  const [currency, setCurrency] = useState<'gameCoins' | 'aCoins'>('gameCoins');
  const [error, setError] = useState('');

  const selectedVoucher = userItemVouchers.find(v => v.id === selectedVoucherId);

  const handleSubmit = () => {
    setError('');
    if (!selectedVoucherId) { setError('请选择要上架的道具凭证'); return; }
    if (price <= 0) { setError('价格必须大于 0'); return; }

    const uid = currentUser?.uid || currentUser?.id || '';
    const result = marketplaceService.listItem(
      selectedVoucherId,
      uid,
      currentUser?.nickname || currentUser?.username || '玩家',
      price,
      currency
    );
    if (result.success) {
      onListed();
    } else {
      setError(result.message);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <motion.div
        initial={{ scale: 0.95, y: 20 }}
        animate={{ scale: 1, y: 0 }}
        className="bg-slate-800 rounded-2xl p-6 w-full max-w-md border border-slate-700"
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-bold text-white flex items-center gap-2">
            <Tag className="w-5 h-5 text-purple-400" />
            上架道具
          </h3>
          <button onClick={onClose} className="text-slate-400 hover:text-white">
            <X className="w-5 h-5" />
          </button>
        </div>

        {userItemVouchers.length === 0 ? (
          <div className="text-center py-8">
            <Package className="w-12 h-12 text-slate-600 mx-auto mb-3" />
            <p className="text-slate-400">暂无道具凭证可上架</p>
            <p className="text-xs text-slate-500 mt-1">在游戏商店购买道具凭证后会出现在这里</p>
          </div>
        ) : (
          <div className="space-y-4">
            {/* 选择凭证 */}
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-2">选择道具凭证</label>
              <select
                value={selectedVoucherId}
                onChange={(e) => {
                  setSelectedVoucherId(e.target.value);
                  const v = userItemVouchers.find(v => v.id === e.target.value);
                  if (v?.denomination) setPrice(v.denomination);
                }}
                className="w-full px-3 py-2.5 bg-slate-700 rounded-lg text-white text-sm border border-slate-600 focus:border-purple-500 focus:outline-none"
              >
                <option value="">— 选择凭证 —</option>
                {userItemVouchers.map((v) => {
                  const meta = v.metadata || {};
                  const name = meta.name || v.serialNumber || v.id.slice(0, 8);
                  return (
                    <option key={v.id} value={v.id}>
                      {name}（面值: {v.denomination}）
                    </option>
                  );
                })}
              </select>
            </div>

            {/* 凭证详情预览 */}
            {selectedVoucher && (
              <div className="p-3 bg-slate-900/50 rounded-lg border border-slate-700/40">
                <div className="flex items-center gap-2 text-xs text-slate-400">
                  <span>面值: {selectedVoucher.denomination}</span>
                  <span>·</span>
                  <span>编号: #{selectedVoucher.serialNumber || selectedVoucher.id.slice(0, 10)}</span>
                </div>
                {selectedVoucher.metadata?.description && (
                  <div className="text-xs text-slate-500 mt-1">{selectedVoucher.metadata.description}</div>
                )}
              </div>
            )}

            {/* 价格 */}
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-2">售价</label>
              <div className="flex gap-2">
                <select
                  value={currency}
                  onChange={(e) => setCurrency(e.target.value as any)}
                  className="px-3 py-2.5 bg-slate-700 rounded-lg text-white text-sm border border-slate-600"
                >
                  <option value="gameCoins">💰 游戏币</option>
                  <option value="aCoins">🎫 A币</option>
                </select>
                <input
                  type="number"
                  value={price}
                  onChange={(e) => setPrice(Number(e.target.value))}
                  min="1"
                  className="flex-1 px-3 py-2.5 bg-slate-700 rounded-lg text-white text-sm border border-slate-600 focus:border-purple-500 focus:outline-none"
                />
              </div>
            </div>

            {/* 面额提示 */}
            {selectedVoucher && (
              <div className="p-2 bg-amber-500/10 border border-amber-500/20 rounded-lg text-xs text-amber-400">
                面额与标价可脱离：此凭证铸造面值为 {selectedVoucher.denomination}，您可以自由设定市场售价。
                {Math.abs(price - selectedVoucher.denomination) / selectedVoucher.denomination > 0.2 && (
                  <span className="block mt-1 text-orange-400">⚠️ 当前标价与面值差异超过 20%，买家可见溢价/折价标注。</span>
                )}
              </div>
            )}

            {/* 佣金提示 */}
            <div className="p-2 bg-purple-500/10 border border-purple-500/20 rounded-lg text-xs text-purple-400">
              平台佣金: {Math.round(MARKET_COMMISSION_RATE * 100)}%，从卖家收入中扣除。
              {currency === 'aCoins' && ' A币支付将通过凭证系统完成（大面额匹配 + 找零）。'}
            </div>

            {error && (
              <div className="p-2 bg-red-500/10 border border-red-500/20 rounded-lg text-xs text-red-400">
                {error}
              </div>
            )}

            <div className="flex gap-3">
              <button
                onClick={onClose}
                className="flex-1 py-2.5 bg-slate-700 hover:bg-slate-600 rounded-lg text-sm font-medium text-slate-300 transition-colors"
              >
                取消
              </button>
              <button
                onClick={handleSubmit}
                disabled={!selectedVoucherId}
                className="flex-1 py-2.5 bg-purple-600 hover:bg-purple-700 disabled:bg-slate-600 disabled:text-slate-400 rounded-lg text-sm font-medium text-white transition-colors"
              >
                确认上架
              </button>
            </div>
          </div>
        )}
      </motion.div>
    </motion.div>
  );
}
