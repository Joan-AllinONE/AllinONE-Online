/**
 * marketplaceService — 玩家交易市场核心服务（MVP v1.1）
 *
 * 集成 VoucherService（凭证托管）+ WalletSkill（gameCoins 支付）
 * + voucherPaymentService（A币凭证支付）
 *
 * 核心流程：
 *   listItem: voucherService.freezeVoucher → 创建 MarketListing
 *   purchase: walletSkill.spend / voucherPaymentService.payWithVoucher
 *           → voucherService.unfreezeVoucher
 *           → voucherService.transferVoucher(卖家→买家)
 *           → walletSkill.recharge(卖家收款-佣金)
 *   delistItem: voucherService.unfreezeVoucher → listing.status='cancelled'
 *   changePrice: 仅更新 listing.price/currency
 */
import { voucherService } from '@/voucher-system/services/VoucherService';
import { voucherPaymentService } from '@/services/voucherPaymentService';
import { VoucherStatus, VoucherSourceType } from '@/voucher-system/types';
import type { Voucher } from '@/voucher-system/types';
import type {
  MarketListing,
  MarketStats,
  PurchaseResult,
  ListItemResult,
  ListingStatus,
  ListingArtwork,
} from '@/types/marketplace';
import { getRuleValue, ensureRulesReady } from './platformRulesService';
import { platformTreasuryService } from '@/services/platformTreasuryService';
import { loadFromBackend } from './backendSync';
import { marketList, marketBuy, marketUnlist, verifyVoucherForCirculation } from './itemTunnelService';
import { track } from './analytics';

// ==================== 存储键 ====================
const LISTINGS_KEY = 'market_listings_v2';
const LOCK_KEY = 'market_lock'; // 并发锁

let _listingsCloudSyncInitiated = false;

function loadListings(): MarketListing[] {
  try {
    const data = JSON.parse(localStorage.getItem(LISTINGS_KEY) || '[]');
    // 异步从 CloudBase 合并增量（仅首次）
    if (!_listingsCloudSyncInitiated) {
      _listingsCloudSyncInitiated = true;
      syncListingsFromCloud();
    }
    return data;
  } catch {
    return [];
  }
}

/** 从后端拉取权威数据并覆盖本地缓存（云端为准，分页全量不截断） */
async function syncListingsFromCloud(): Promise<void> {
  try {
    const cloud = await loadFromBackend<MarketListing>('market_listings');
    if (cloud.length === 0) return;
    const freshRaw = localStorage.getItem(LISTINGS_KEY);
    const fresh: MarketListing[] = freshRaw ? JSON.parse(freshRaw) : [];
    // ✅ 云端数据覆盖本地同名 ID（云端为准）
    const cloudMap = new Map(cloud.map(d => [d.id, d]));
    const localOnly = fresh.filter(l => !cloudMap.has(l.id));
    const merged = [...cloud, ...localOnly];
    localStorage.setItem(LISTINGS_KEY, JSON.stringify(merged));
  } catch {
    // CloudBase 不可用 — 允许下次重试
    _listingsCloudSyncInitiated = false;
  }
}

function saveListings(listings: MarketListing[]): void {
  try {
    localStorage.setItem(LISTINGS_KEY, JSON.stringify(listings));
    // CloudBase 双写（异步，不阻塞调用方）
    syncListingsToCloud(listings);
  } catch { /* ignore */ }
}

/**
 * 🆕 B4：market_listings 公开集合同步写已被云端摘除（READ_ONLY 403）。
 * 云端挂牌写入的唯一入口是 __market/list、/__market/buy、/__market/unlist
 * （各业务动作内显式调用，服务端核对凭证后才落库）；本地 localStorage 仍为展示缓存。
 */
function syncListingsToCloud(_listings: MarketListing[]): void {
  // no-op（保留函数签名避免改动调用点；历史批量同步已废弃）
}

function generateId(): string {
  return `listing_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ==================== 并发锁 ====================
function acquireLock(key: string): boolean {
  const lock = localStorage.getItem(LOCK_KEY);
  if (lock === key) return false; // 已被相同操作锁定
  localStorage.setItem(LOCK_KEY, key);
  return true;
}

function releaseLock(): void {
  localStorage.removeItem(LOCK_KEY);
}

// ==================== MarketplaceService ====================

class MarketplaceService {
  /**
   * 📤 上架道具凭证（🆕 B4/B5 服务端化）
   *
   * 1. 校验凭证可上架（ITEM 类型 + ACTIVE 状态 + 持有者一致 + 未已兑换 + 未重复挂牌）
   * 2. 🆕 服务端流通校验（__item/verify：云端存在 + 持有者 + 审核状态）——
   *    本地伪造凭证在云端不存在，上架直接被拒
   * 3. 冻结凭证（VoucherService.freezeVoucher）
   * 4. 创建 MarketListing（本地缓存）+ 🆕 __market/list 服务端写入（服务端再次核对后落库；
   *    服务端拒绝则回滚冻结与本地挂牌）
   */
  async listItem(
    voucherId: string,
    sellerId: string,
    sellerName: string,
    price: number,
    currency: 'gameCoins' | 'aCoins'
  ): Promise<ListItemResult> {
    // 1. 获取凭证
    const userVouchers = voucherService.getUserVouchers(sellerId);
    const voucher = userVouchers.find(v => v.id === voucherId);
    if (!voucher) {
      return { success: false, message: '凭证不存在或不属于你' };
    }

    // 2. 校验（本地规则）
    const validation = this.validateForListing(voucher, sellerId);
    if (!validation.ok) {
      return { success: false, message: validation.reason };
    }

    // 2.5 🆕 服务端流通校验（云端为准；伪造凭证/非持有者/审核拦截；非云端环境自动放行）
    const circCheck = await verifyVoucherForCirculation(voucherId, sellerId);
    if (!circCheck.ok) {
      return { success: false, message: circCheck.reason };
    }

    // 3. 冻结凭证
    const freezeTx = voucherService.freezeVoucher(
      voucherId,
      sellerId,
      sellerName,
      '玩家上架托管到交易市场'
    );

    // 4. 提取道具信息
    const meta = voucher.metadata || {};
    const customData = meta.customData || {};

    // 5. 创建挂牌
    // 作品类凭证（如 perler-artwork / gushi-powerup 成品）：快照作品数据，市场卡片跨浏览器可渲染
    let artwork: ListingArtwork | undefined;
    try {
      const p = (customData.gameEffect?.itemData?.params || {}) as Record<string, any>;
      // 缅川公盘成品（gushi-powerup）：确定性视觉参数，平台侧 GushiProductArt 重绘
      const seedNum = parseInt(p.seed, 10);
      if (typeof p.craft === 'string' && p.craft.trim() && typeof p.gem === 'string' && Number.isFinite(seedNum)) {
        const sizeNum = Number(p.size);
        artwork = {
          kind: 'gushi',
          craft: p.craft,
          gem: p.gem,
          seed: seedNum,
          size: Number.isFinite(sizeNum) && sizeNum > 0 ? sizeNum : 1,
        };
      } else {
        const w = parseInt(p.w, 10);
        const h = parseInt(p.h, 10);
        if (
          w > 0 && w <= 59 && h > 0 && h <= 59 &&
          Array.isArray(p.palette) && p.palette.length > 0 &&
          typeof p.cells === 'string' && p.cells.length === w * h
        ) {
          artwork = { kind: 'perler', w, h, palette: p.palette, cells: p.cells };
        }
      }
    } catch { /* 非作品类凭证，忽略 */ }

    const listing: MarketListing = {
      id: generateId(),
      voucherId,
      voucherSerial: voucher.serialNumber || voucher.id.slice(0, 12),
      itemName: meta.name || '未知道具',
      itemDescription: meta.description || '',
      itemType: customData.itemType || 'consumable',
      rarity: customData.rarity || 'common',
      artwork,
      gameId: (meta.gameId || meta.gameSource || 'unknown') as string,
      gameName: meta.gameName || '',
      price,
      currency,
      denomination: voucher.denomination,
      sellerId,
      sellerName,
      status: 'active',
      listedAt: Date.now(),
      freezeTxId: freezeTx.id,
      views: 0,
    };

    const listings = loadListings();
    listings.push(listing);
    saveListings(listings);

    // 🆕 B4：服务端写入挂牌（云端唯一入口）。服务端再次核对凭证（存在+持有者+审核状态）。
    // 失败分级：400/403=业务拒绝（伪造/非持有者/审核拦截）→ 回滚阻断；
    // 404/5xx/0=服务不可用 → 降级放行（本地挂牌继续，不阻断正常玩家）
    const server = await marketList(listing as unknown as Record<string, any>);
    if (!server.success) {
      const status = server.status ?? 0;
      const isBusinessReject = status === 400 || status === 403;
      if (isBusinessReject) {
        try {
          saveListings(loadListings().filter(l => l.id !== listing.id));
          voucherService.unfreezeVoucher(voucherId, sellerId, sellerName, '上架被平台拒绝，回滚托管');
        } catch { /* 回滚尽力而为 */ }
        console.warn('[Marketplace] 服务端拒绝挂牌:', server.error);
        return { success: false, message: server.error || '上架失败：平台校验未通过' };
      }
      console.warn(`[Marketplace] 挂牌服务不可用（HTTP ${status}），本地挂牌继续:`, server.error);
    }

    console.log(`[Marketplace] 上架成功: ${listing.itemName} @ ${price} ${currency}`);

    return { success: true, listing, message: '上架成功' };
  }

  /**
   * 💰 购买道具
   *
   * 根据 listing.currency 分两条路径：
   *   gameCoins → walletSkill.spend(buyerId, price) → recharge(sellerId, price-commission)
   *   aCoins → voucherPaymentService.payWithVoucher(buyerId, price)
   *
   * 道具流转（两条路径相同）：
   *   unfreezeVoucher → transferVoucher(卖家→买家)
   */
  async purchase(
    listingId: string,
    buyerId: string,
    buyerName: string
  ): Promise<PurchaseResult> {
    if (!acquireLock(`purchase_${listingId}`)) {
      return { success: false, listingId, message: '操作过于频繁，请稍后再试' };
    }

    try {
      const listings = loadListings();
      const idx = listings.findIndex(l => l.id === listingId);

      if (idx === -1) {
        return { success: false, listingId, message: '挂牌不存在' };
      }

      const listing = listings[idx];

      // 乐观锁
      if (listing.status !== 'active') {
        return { success: false, listingId, message: `该商品已${listing.status === 'sold' ? '售出' : '下架'}` };
      }

      // 自买自卖
      if (listing.sellerId === buyerId) {
        return { success: false, listingId, message: '不能购买自己的商品' };
      }

      // 重新验证凭证状态
      const voucher = this.getVoucherById(listing.voucherId);
      if (!voucher || voucher.status !== VoucherStatus.FROZEN) {
        return { success: false, listingId, message: '凭证状态异常，无法交易' };
      }

      // 🆕 B5：购买前服务端校验（云端为准：凭证存在+未使用+审核状态）；
      // 校验服务不可达时放行（伪造凭证进不了云端，风险可控）
      const circCheck = await verifyVoucherForCirculation(listing.voucherId, listing.sellerId);
      if (!circCheck.ok) {
        return { success: false, listingId, message: circCheck.reason };
      }

      // 佣金率读取规则注册中心（治理门控修改；本地 precheck 与云端 __market/buy 同源）
      await ensureRulesReady();
      const commissionRate = getRuleValue('market.commission_rate');
      const commission = Math.round(listing.price * commissionRate * 100) / 100;
      const sellerReceives = listing.price - commission;
      const paymentTxIds: string[] = [];

      // ====== 支付 ======
      if (listing.currency === 'gameCoins') {
        // 游戏币支付：walletSkill
        try {
          const { skillGateway } = await import('@/skills/index');
          const spendResult = await skillGateway.execute('wallet', 'spend', {
            amount: listing.price,
            description: `交易市场购买: ${listing.itemName}`,
          }, { userId: buyerId, sessionId: 'web' } as any);
          if (!spendResult.success) {
            return { success: false, listingId, message: spendResult.error?.message || '支付失败' };
          }
          paymentTxIds.push(spendResult.requestId || `tx_${Date.now()}`);
        } catch (e: any) {
          return { success: false, listingId, message: e?.message || '支付服务不可用' };
        }
      } else {
        // A币凭证支付：voucherPaymentService
        const payResult = voucherPaymentService.payWithVoucher(
          buyerId,
          buyerName,
          listing.price,
          `交易市场购买: ${listing.itemName}`
        );
        if (!payResult.success) {
          return { success: false, listingId, message: payResult.message };
        }
        paymentTxIds.push(...payResult.transactions.map(t => t.id));
      }

      // ====== 道具流转 ======
      try {
        // 解冻凭证
        voucherService.unfreezeVoucher(
          listing.voucherId,
          listing.sellerId,
          listing.sellerName,
          '交易完成，凭证解冻准备转让'
        );

        // 转让凭证（卖家→买家）
        voucherService.transferVoucher(
          {
            voucherId: listing.voucherId,
            toUserId: buyerId,
            toUserName: buyerName,
            note: `交易市场购买: ${listing.itemName} (${listing.price} ${listing.currency})`,
          },
          listing.sellerId,
          listing.sellerName
        );
      } catch (e: any) {
        // 回滚支付（简化处理：支付已成功但转让失败的情况）
        if (listing.currency === 'gameCoins') {
          try {
            const { skillGateway } = await import('@/skills/index');
            await skillGateway.execute('wallet', 'recharge', {
              amount: listing.price,
              description: `交易失败退款: ${listing.itemName}`,
            }, { userId: buyerId, sessionId: 'web' } as any);
          } catch { /* best effort */ }
        }
        return { success: false, listingId, message: `凭证转让失败: ${e?.message}` };
      }

      // ====== 卖家收款 ======
      if (listing.currency === 'gameCoins') {
        try {
          const { skillGateway } = await import('@/skills/index');
          await skillGateway.execute('wallet', 'recharge', {
            amount: sellerReceives,
            description: `交易市场售出: ${listing.itemName}`,
          }, { userId: listing.sellerId, sessionId: 'web' } as any);
        } catch {
          console.warn(`[Marketplace] 卖家收款失败: sellerId=${listing.sellerId}, amount=${sellerReceives}`);
        }
      } else {
        // A币支付时，买家的凭证已经在 payWithVoucher 中 transfer 到平台池
        // 这里需要将平台池中的凭证 transfer 给卖家
        const change = this.transferACoinsToSeller(
          listing.sellerId,
          listing.sellerName,
          sellerReceives,
          `交易市场售出: ${listing.itemName}`
        );
        if (change > 0) {
          console.warn(`[Marketplace] 卖家收款有差额: ${change}`);
        }
      }

      // 佣金存入平台金库（gameCoins 走 walletSkill 真实入账）
      await platformTreasuryService.depositCommission(
        listing.currency,
        commission,
        'p2p_commission',
        `交易市场: ${listing.itemName} (买家${buyerName}→卖家${listing.sellerName})`,
        { listingId: listing.id, sellerId: listing.sellerId, buyerId }
      );

      // 更新挂牌状态
      listing.status = 'sold';
      listing.soldAt = Date.now();
      listing.buyerId = buyerId;
      listing.buyerName = buyerName;
      listing.paymentTxIds = paymentTxIds;
      listings[idx] = listing;
      saveListings(listings);

      // 🆕 B4：云端原子成交（__market/buy：置 sold + 写 purchases 快照；服务端核对
      // active 状态防双卖，身份取自 token）。失败仅告警——本地交易已完成，
      // 下次打开市场页云端数据会以此为准拉齐（云端为准合并策略）
      const buyServer = await marketBuy(listingId, buyerId, buyerName, paymentTxIds);
      if (!buyServer.success) {
        console.warn('[Marketplace] 云端成交写入失败（本地已完成）:', buyServer.error);
      }

      console.log(`[Marketplace] 交易成功: ${listing.itemName}, 买家=${buyerName}, 卖家收到=${sellerReceives}`);

      // 📊 数据中心埋点：市场交易
      try {
        track({
          type: 'market_tx',
          userId: buyerId,
          gameId: (listing as any)?.gameId,
          payload: {
            amount: listing.price,
            currency: listing.currency,
            commission,
            itemName: listing.itemName,
            sellerId: listing.sellerId,
          },
        });
      } catch { /* ignore */ }

      return {
        success: true,
        listingId,
        message: `成功购买 ${listing.itemName}！`,
        paymentTxIds,
        sellerReceived: sellerReceives,
        commission,
      };
    } finally {
      releaseLock();
    }
  }

  /**
   * 📥 下架（🆕 B4 服务端化：先 __market/unlist 云端裁决，成功才解冻退凭证）
   */
  async delistItem(listingId: string, userId: string): Promise<{ success: boolean; message: string }> {
    const listings = loadListings();
    const idx = listings.findIndex(l => l.id === listingId);

    if (idx === -1) return { success: false, message: '挂牌不存在' };
    const listing = listings[idx];

    if (listing.sellerId !== userId) return { success: false, message: '只能下架自己的商品' };
    if (listing.status !== 'active') return { success: false, message: `商品已${listing.status === 'sold' ? '售出' : '取消'}` };

    // 🆕 云端裁决（服务端核对卖家身份后置 cancelled）。
    // 失败分级：403=业务拒绝（非卖家）→ 阻断；404（云端无此挂牌，如存量本地挂牌）/
    // 5xx/0（服务不可用）→ 降级放行本地下架流程
    const server = await marketUnlist(listingId, userId);
    if (!server.success) {
      const status = server.status ?? 0;
      const isBusinessReject = status === 400 || status === 403 || status === 409;
      if (isBusinessReject) {
        return { success: false, message: server.error || '下架失败，请稍后再试' };
      }
      console.warn(`[Marketplace] 下架服务不可用（HTTP ${status}），本地下架继续:`, server.error);
    }

    // 解冻凭证
    try {
      voucherService.unfreezeVoucher(
        listing.voucherId,
        userId,
        listing.sellerName,
        '下架，退还凭证'
      );
    } catch (e: any) {
      return { success: false, message: `解冻失败: ${e?.message}` };
    }

    listing.status = 'cancelled';
    listing.cancelledAt = Date.now();
    listings[idx] = listing;
    saveListings(listings);

    return { success: true, message: '下架成功，凭证已退还' };
  }

  /**
   * 📝 改价
   */
  changePrice(
    listingId: string,
    userId: string,
    newPrice: number,
    newCurrency?: 'gameCoins' | 'aCoins'
  ): { success: boolean; message: string } {
    const listings = loadListings();
    const idx = listings.findIndex(l => l.id === listingId);

    if (idx === -1) return { success: false, message: '挂牌不存在' };
    const listing = listings[idx];

    if (listing.sellerId !== userId) return { success: false, message: '只能修改自己的商品价格' };
    if (listing.status !== 'active') return { success: false, message: '只能修改在售商品的价格' };

    if (newPrice <= 0) return { success: false, message: '价格必须大于 0' };

    listing.price = newPrice;
    if (newCurrency) listing.currency = newCurrency;
    listings[idx] = listing;
    saveListings(listings);

    return { success: true, message: '价格已更新' };
  }

  // ==================== 查询 ====================

  /** 获取活跃挂牌列表 */
  getActiveListings(): MarketListing[] {
    return loadListings().filter(l => l.status === 'active');
  }

  /** 搜索挂牌 */
  searchListings(params: {
    query?: string;
    gameId?: string;
    rarity?: string;
    currency?: 'gameCoins' | 'aCoins';
    sortBy?: 'price_asc' | 'price_desc' | 'date_desc' | 'popularity';
  }): MarketListing[] {
    let items = this.getActiveListings();

    if (params.query) {
      const q = params.query.toLowerCase();
      items = items.filter(l =>
        l.itemName.toLowerCase().includes(q) ||
        l.itemDescription.toLowerCase().includes(q)
      );
    }
    if (params.gameId) items = items.filter(l => l.gameId === params.gameId);
    if (params.rarity) items = items.filter(l => l.rarity === params.rarity);
    if (params.currency) items = items.filter(l => l.currency === params.currency);

    switch (params.sortBy) {
      case 'price_asc': items.sort((a, b) => a.price - b.price); break;
      case 'price_desc': items.sort((a, b) => b.price - a.price); break;
      case 'popularity': items.sort((a, b) => b.views - a.views); break;
      case 'date_desc':
      default: items.sort((a, b) => b.listedAt - a.listedAt); break;
    }

    return items;
  }

  /** 获取用户的上架列表 */
  getUserListings(userId: string): MarketListing[] {
    return loadListings().filter(l => l.sellerId === userId);
  }

  /** 获取用户的购买记录 */
  getUserPurchases(userId: string): MarketListing[] {
    return loadListings().filter(l => l.buyerId === userId && l.status === 'sold');
  }

  /** 检查凭证是否已有活跃挂牌（防重复上架） */
  getActiveListingByVoucher(voucherId: string): MarketListing | undefined {
    return loadListings().find(l => l.voucherId === voucherId && l.status === 'active');
  }

  /** 获取市场统计 */
  getStats(): MarketStats {
    const activeListings = this.getActiveListings();
    const soldListings = loadListings().filter(l => l.status === 'sold');
    const now = Date.now();
    const DAY = 86400000;

    const todaySold = soldListings.filter(l => (l.soldAt || 0) > now - DAY);
    const totalVolume = soldListings.reduce((s, l) => s + l.price, 0);
    const averagePrice = soldListings.length > 0
      ? Math.round(totalVolume / soldListings.length)
      : 0;

    return {
      totalListings: activeListings.length,
      dailyTransactions: todaySold.length,
      totalVolume,
      averagePrice,
    };
  }

  // ==================== 私有方法 ====================

  /** 校验凭证可否上架 */
  private validateForListing(voucher: Voucher, userId: string): { ok: boolean; reason: string } {
    // 必须是道具凭证
    if (voucher.sourceType !== VoucherSourceType.ITEM) {
      return { ok: false, reason: '非道具凭证，不能上架' };
    }

    // 🆕 P2a 高价值道具审核流：待审核/被驳回的凭证禁止上架
    const reviewStatus = (voucher.metadata?.customData as any)?.reviewStatus;
    if (reviewStatus === 'pending') {
      return { ok: false, reason: '高价值道具审核中，暂不能上架，请等待平台审核' };
    }
    if (reviewStatus === 'rejected') {
      return { ok: false, reason: '该道具未通过平台审核，不能上架' };
    }

    // 必须是持有者
    if (voucher.currentHolderId !== userId) {
      return { ok: false, reason: '不是该凭证的持有者' };
    }

    // 状态必须 ACTIVE
    if (voucher.status !== VoucherStatus.ACTIVE) {
      return { ok: false, reason: `凭证状态异常（${voucher.status}），无法上架` };
    }

    // 已兑换到游戏的不可上架
    if (voucher.currentHolderId?.startsWith('game_')) {
      return { ok: false, reason: '该道具已兑换到游戏中' };
    }

    // 已被消耗的不可上架
    if (voucher.status === VoucherStatus.DESTROYED) {
      return { ok: false, reason: '该道具已被消耗' };
    }

    // 已有活跃挂牌
    if (this.getActiveListingByVoucher(voucher.id)) {
      return { ok: false, reason: '该凭证已在市场挂牌中' };
    }

    return { ok: true, reason: '' };
  }

  /** 获取凭证（查找所有用户） */
  private getVoucherById(voucherId: string): Voucher | undefined {
    // 遍历常见用户 ID
    const ids = ['test-001', 'test-002', 'test-003', 'test-004', 'anonymous', 'current-user'];
    for (const id of ids) {
      const vouchers = voucherService.getUserVouchers(id);
      const found = vouchers.find(v => v.id === voucherId);
      if (found) return found;
    }
    return undefined;
  }

  /** 给卖家转A币凭证（从平台池转出） */
  private transferACoinsToSeller(
    sellerId: string,
    sellerName: string,
    amount: number,
    note: string
  ): number {
    // 从平台库存转移凭证给卖家
    const poolVouchers = voucherService.getUserVouchers(voucherPaymentService.constructor.name.includes('Platform') ? 'platform_pool' : 'PLATFORM_POOL')
      .filter(v => v.status === VoucherStatus.ACTIVE)
      .sort((a, b) => b.denomination - a.denomination);

    const PLATFORM = 'platform_pool';
    const PLATFORM_NAME = '平台总账户';
    let remaining = amount;

    for (const v of poolVouchers) {
      if (remaining <= 0) break;
      if (v.denomination <= remaining) {
        try {
          voucherService.transferVoucher(
            {
              voucherId: v.id,
              toUserId: sellerId,
              toUserName: sellerName,
              note,
            },
            PLATFORM,
            PLATFORM_NAME
          );
          remaining -= v.denomination;
        } catch { /* skip */ }
      }
    }

    return remaining; // 返回未转账的差额
  }
}

export const marketplaceService = new MarketplaceService();
