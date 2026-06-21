/**
 * AllinONE Skill 系统 - 商店 Skill
 * 统一商店服务：商品列表、购买、上架、定价
 */

import { BaseSkill } from '../BaseSkill';
import {
  SkillDefinition,
  SkillContext,
  JSONSchema,
} from '../types';
import { SkillErrors } from '../errors';
import { writeQueue } from '../../services/writeQueue';

// ==================== 类型定义 ====================

export interface StoreProduct {
  id: string;
  name: string;
  description: string;
  category: 'item' | 'currency' | 'vip' | 'bundle' | 'other';
  icon?: string;
  price: {
    amount: number;
    currency: string;
  };
  originalPrice?: {
    amount: number;
    currency: string;
  };
  quantity: number;
  maxPurchasePerUser?: number;
  maxPurchaseTotal?: number;
  purchasedCount: number;
  isLimited: boolean;
  limitedQuantity?: number;
  startTime?: Date;
  endTime?: Date;
  status: 'active' | 'inactive' | 'sold_out';
  requirements?: {
    minLevel?: number;
    maxLevel?: number;
    vipLevel?: number;
    achievements?: string[];
  };
  rewards: StoreReward[];
  tags: string[];
  metadata?: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
}

export interface StoreReward {
  type: 'item' | 'currency' | 'exp' | 'achievement' | 'other';
  itemId?: string;
  itemName?: string;
  quantity: number;
  metadata?: Record<string, any>;
}

export interface PurchaseParams {
  productId: string;
  quantity?: number;
  paymentMethod?: string;
  couponCode?: string;
}

export interface PurchaseResult {
  success: boolean;
  orderId: string;
  product: StoreProduct;
  quantity: number;
  totalPrice: number;
  currency: string;
  discount?: number;
  rewards: StoreReward[];
  purchasedAt: Date;
}

export interface ListProductParams {
  name: string;
  description?: string;
  category: string;
  price: {
    amount: number;
    currency: string;
  };
  quantity: number;
  isLimited?: boolean;
  limitedQuantity?: number;
  rewards: StoreReward[];
  requirements?: StoreProduct['requirements'];
  tags?: string[];
}

export interface QueryProductsParams {
  category?: string;
  status?: string;
  minPrice?: number;
  maxPrice?: number;
  currency?: string;
  tags?: string[];
  sortBy?: 'price' | 'popularity' | 'newest';
  sortOrder?: 'asc' | 'desc';
  page?: number;
  limit?: number;
}

// ==================== Skill 定义 ====================

const storeSkillDefinition: SkillDefinition = {
  name: 'store',
  displayName: '商店服务',
  version: '1.0.0',
  description: '统一商店管理服务，支持商品浏览、购买、上架',
  requiredPermissions: [],
  dependencies: ['auth', 'wallet', 'inventory'],
  actions: [],
  events: [
    'store.product.purchased',    // 商品购买
    'store.product.listed',       // 商品上架
    'store.product.delisted',     // 商品下架
    'store.product.sold_out',     // 商品售罄
  ],
};

// ==================== Store Skill 实现 ====================

export class StoreSkill extends BaseSkill {
  private products: Map<string, StoreProduct> = new Map();
  private orders: Map<string, PurchaseResult> = new Map();
  private userPurchases: Map<string, Map<string, number>> = new Map(); // userId -> productId -> count
  private readonly STORAGE_KEY = 'store_data';

  constructor() {
    super(storeSkillDefinition);
  }

  async onInitialize(): Promise<void> {
    await this.loadFromStorage();
    this.registerActions();
    this.initializeDefaultProducts();
  }

  private registerActions(): void {
    // 获取商品列表
    this.registerAction(
      'getProducts',
      this.getProducts.bind(this),
      {
        displayName: '获取商品列表',
        description: '获取商店商品列表',
        paramsSchema: {
          type: 'object',
          properties: {
            category: { type: 'string' },
            status: { type: 'string' },
            minPrice: { type: 'number' },
            maxPrice: { type: 'number' },
            currency: { type: 'string' },
            tags: { type: 'array', items: { type: 'string' } },
            sortBy: { type: 'string', enum: ['price', 'popularity', 'newest'] },
            sortOrder: { type: 'string', enum: ['asc', 'desc'] },
            page: { type: 'number', default: 1 },
            limit: { type: 'number', default: 20 },
          },
        },
        returnsSchema: { type: 'object' },
        requiredPermissions: ['store:read:products'],
        readonly: true,
        idempotent: true,
      }
    );

    // 获取商品详情
    this.registerAction(
      'getProduct',
      this.getProduct.bind(this),
      {
        displayName: '获取商品详情',
        description: '获取指定商品的详细信息',
        paramsSchema: {
          type: 'object',
          properties: {
            productId: { type: 'string' },
          },
          required: ['productId'],
        },
        returnsSchema: { type: 'object' },
        requiredPermissions: ['store:read:products'],
        readonly: true,
        idempotent: true,
      }
    );

    // 购买商品
    this.registerAction(
      'purchase',
      this.purchase.bind(this),
      {
        displayName: '购买商品',
        description: '购买指定商品',
        paramsSchema: {
          type: 'object',
          properties: {
            productId: { type: 'string' },
            quantity: { type: 'number', default: 1, minimum: 1 },
            paymentMethod: { type: 'string' },
            couponCode: { type: 'string' },
          },
          required: ['productId'],
        },
        returnsSchema: { type: 'object' },
        requiredPermissions: ['store:write:purchase'],
        readonly: false,
        idempotent: false,
      }
    );

    // 上架商品
    this.registerAction(
      'listProduct',
      this.listProduct.bind(this),
      {
        displayName: '上架商品',
        description: '将商品上架到商店',
        paramsSchema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            description: { type: 'string' },
            category: { type: 'string', enum: ['item', 'currency', 'vip', 'bundle', 'other'] },
            price: {
              type: 'object',
              properties: {
                amount: { type: 'number', minimum: 0 },
                currency: { type: 'string' },
              },
              required: ['amount', 'currency'],
            },
            quantity: { type: 'number', minimum: 1 },
            isLimited: { type: 'boolean' },
            limitedQuantity: { type: 'number' },
            rewards: { type: 'array' },
            requirements: { type: 'object' },
            tags: { type: 'array', items: { type: 'string' } },
          },
          required: ['name', 'category', 'price', 'quantity', 'rewards'],
        },
        returnsSchema: { type: 'object' },
        requiredPermissions: ['store:admin:list'],
        readonly: false,
        idempotent: false,
      }
    );

    // 下架商品
    this.registerAction(
      'delistProduct',
      this.delistProduct.bind(this),
      {
        displayName: '下架商品',
        description: '将商品从商店下架',
        paramsSchema: {
          type: 'object',
          properties: {
            productId: { type: 'string' },
          },
          required: ['productId'],
        },
        returnsSchema: { type: 'object' },
        requiredPermissions: ['store:admin:delist'],
        readonly: false,
        idempotent: true,
      }
    );

    // 获取购买历史
    this.registerAction(
      'getPurchaseHistory',
      this.getPurchaseHistory.bind(this),
      {
        displayName: '获取购买历史',
        description: '获取用户的购买历史',
        paramsSchema: {
          type: 'object',
          properties: {
            limit: { type: 'number', default: 50 },
            offset: { type: 'number', default: 0 },
          },
        },
        returnsSchema: { type: 'array' },
        requiredPermissions: ['store:read:history'],
        readonly: true,
        idempotent: true,
      }
    );

    // 获取推荐商品
    this.registerAction(
      'getRecommendations',
      this.getRecommendations.bind(this),
      {
        displayName: '获取推荐商品',
        description: '获取推荐商品列表',
        paramsSchema: {
          type: 'object',
          properties: {
            limit: { type: 'number', default: 10 },
            category: { type: 'string' },
          },
        },
        returnsSchema: { type: 'array' },
        requiredPermissions: ['store:read:products'],
        readonly: true,
        idempotent: true,
      }
    );

    // 检查可购买性
    this.registerAction(
      'checkAvailability',
      this.checkAvailability.bind(this),
      {
        displayName: '检查可购买性',
        description: '检查用户是否可以购买指定商品',
        paramsSchema: {
          type: 'object',
          properties: {
            productId: { type: 'string' },
            quantity: { type: 'number', default: 1 },
          },
          required: ['productId'],
        },
        returnsSchema: { type: 'object' },
        requiredPermissions: ['store:read:products'],
        readonly: true,
        idempotent: true,
      }
    );
  }

  // ==================== 动作实现 ====================

  private async getProducts(params: QueryProductsParams, _context: SkillContext): Promise<{ products: StoreProduct[]; total: number; page: number; limit: number }> {
    let products = Array.from(this.products.values());

    // 过滤
    if (params.category) {
      products = products.filter(p => p.category === params.category);
    }
    if (params.status) {
      products = products.filter(p => p.status === params.status);
    } else {
      // 默认只显示 active 状态
      products = products.filter(p => p.status === 'active');
    }
    if (params.minPrice !== undefined) {
      products = products.filter(p => p.price.amount >= params.minPrice!);
    }
    if (params.maxPrice !== undefined) {
      products = products.filter(p => p.price.amount <= params.maxPrice!);
    }
    if (params.currency) {
      products = products.filter(p => p.price.currency === params.currency);
    }
    if (params.tags && params.tags.length > 0) {
      products = products.filter(p => params.tags!.some(tag => p.tags.includes(tag)));
    }

    // 排序
    const sortBy = params.sortBy || 'newest';
    const sortOrder = params.sortOrder || 'desc';
    products.sort((a, b) => {
      let comparison = 0;
      switch (sortBy) {
        case 'price':
          comparison = a.price.amount - b.price.amount;
          break;
        case 'popularity':
          comparison = a.purchasedCount - b.purchasedCount;
          break;
        case 'newest':
          comparison = a.createdAt.getTime() - b.createdAt.getTime();
          break;
      }
      return sortOrder === 'asc' ? comparison : -comparison;
    });

    // 分页
    const page = params.page || 1;
    const limit = params.limit || 20;
    const total = products.length;
    const start = (page - 1) * limit;
    const paginatedProducts = products.slice(start, start + limit);

    return {
      products: paginatedProducts,
      total,
      page,
      limit,
    };
  }

  private async getProduct(params: { productId: string }, _context: SkillContext): Promise<StoreProduct | null> {
    return this.products.get(params.productId) || null;
  }

  private async purchase(params: PurchaseParams, context: SkillContext): Promise<PurchaseResult> {
    const { productId, quantity = 1, paymentMethod, couponCode } = params;

    const product = this.products.get(productId);
    if (!product) {
      throw SkillErrors.notFound(`商品 ${productId}`);
    }

    // 检查商品状态
    if (product.status !== 'active') {
      throw SkillErrors.validationError('product', '商品已下架或售罄');
    }

    // 检查时间限制
    const now = new Date();
    if (product.startTime && now < product.startTime) {
      throw SkillErrors.validationError('product', '商品尚未开始销售');
    }
    if (product.endTime && now > product.endTime) {
      throw SkillErrors.validationError('product', '商品已结束销售');
    }

    // 检查限购
    const userPurchaseCount = this.getUserPurchaseCount(context.userId, productId);
    if (product.maxPurchasePerUser && userPurchaseCount + quantity > product.maxPurchasePerUser) {
      throw SkillErrors.validationError('quantity', `超出限购数量，每人限购 ${product.maxPurchasePerUser} 个`);
    }

    if (product.isLimited && product.limitedQuantity) {
      const remaining = product.limitedQuantity - product.purchasedCount;
      if (quantity > remaining) {
        throw SkillErrors.validationError('quantity', `库存不足，剩余 ${remaining} 个`);
      }
    }

    // 计算总价
    let totalPrice = product.price.amount * quantity;
    let discount = 0;

    // 应用优惠券
    if (couponCode) {
      const couponResult = await this.applyCoupon(couponCode, totalPrice);
      discount = couponResult.discount;
      totalPrice -= discount;
    }

    // 调用 Wallet Skill 扣款
    try {
      await this.callSkill('wallet', 'spend', {
        amount: totalPrice,
        currency: product.price.currency,
        description: `购买 ${product.name} x${quantity}`,
        relatedId: productId,
      }, context);
    } catch (error) {
      throw SkillErrors.insufficientBalance(product.price.currency, totalPrice, 0);
    }

    // 发放奖励
    const rewards: StoreReward[] = [];
    for (const reward of product.rewards) {
      const rewardQty = reward.quantity * quantity;
      rewards.push({ ...reward, quantity: rewardQty });

      // 根据奖励类型发放
      if (reward.type === 'item') {
        await this.callSkill('inventory', 'addItem', {
          itemId: reward.itemId || `${productId}_reward`,
          name: reward.itemName || product.name,
          gameSource: 'store',
          gameName: 'AllinONE Store',
          category: 'store_purchase',
          quantity: rewardQty,
          obtainedFrom: `purchase:${productId}`,
        }, context);
      } else if (reward.type === 'currency') {
        // 货币奖励通过 wallet skill 发放
        await this.callSkill('wallet', 'reward', {
          [reward.itemId || 'gameCoins']: rewardQty,
          description: `购买 ${product.name} 奖励`,
        }, context);
      }
    }

    // 更新商品销量
    product.purchasedCount += quantity;
    if (product.isLimited && product.limitedQuantity && product.purchasedCount >= product.limitedQuantity) {
      product.status = 'sold_out';
      this.emit('store.product.sold_out', { productId, product }, context);
    }
    this.products.set(productId, product);

    // 记录用户购买
    this.recordUserPurchase(context.userId, productId, quantity);

    // 创建订单
    const order: PurchaseResult = {
      success: true,
      orderId: this.generateId(),
      product,
      quantity,
      totalPrice,
      currency: product.price.currency,
      discount,
      rewards,
      purchasedAt: new Date(),
    };

    this.orders.set(order.orderId, order);
    await this.saveToStorage();

    // 发布购买事件
    this.emit('store.product.purchased', {
      orderId: order.orderId,
      productId,
      userId: context.userId,
      quantity,
      totalPrice,
    }, context);

    return order;
  }

  private async listProduct(params: ListProductParams, context: SkillContext): Promise<StoreProduct> {
    const product: StoreProduct = {
      id: this.generateId(),
      name: params.name,
      description: params.description || '',
      category: params.category as any,
      icon: params.icon,
      price: params.price,
      quantity: params.quantity,
      maxPurchasePerUser: params.maxPurchasePerUser,
      maxPurchaseTotal: params.maxPurchaseTotal,
      purchasedCount: 0,
      isLimited: params.isLimited || false,
      limitedQuantity: params.limitedQuantity,
      status: 'active',
      requirements: params.requirements,
      rewards: params.rewards,
      tags: params.tags || [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    this.products.set(product.id, product);
    await this.saveToStorage();

    this.emit('store.product.listed', { product }, context);

    return product;
  }

  private async delistProduct(params: { productId: string }, context: SkillContext): Promise<{ success: boolean }> {
    const product = this.products.get(params.productId);
    if (!product) {
      throw SkillErrors.notFound(`商品 ${params.productId}`);
    }

    product.status = 'inactive';
    product.updatedAt = new Date();
    this.products.set(params.productId, product);
    await this.saveToStorage();

    this.emit('store.product.delisted', { productId: params.productId }, context);

    return { success: true };
  }

  private async getPurchaseHistory(params: { limit?: number; offset?: number }, context: SkillContext): Promise<PurchaseResult[]> {
    const userOrders = Array.from(this.orders.values())
      .filter(order => {
        // 这里简化处理，实际应该通过 order 中的 userId 过滤
        return true;
      })
      .sort((a, b) => b.purchasedAt.getTime() - a.purchasedAt.getTime());

    const offset = params.offset || 0;
    const limit = params.limit || 50;

    return userOrders.slice(offset, offset + limit);
  }

  private async getRecommendations(params: { limit?: number; category?: string }, _context: SkillContext): Promise<StoreProduct[]> {
    let products = Array.from(this.products.values())
      .filter(p => p.status === 'active')
      .sort((a, b) => b.purchasedCount - a.purchasedCount);

    if (params.category) {
      products = products.filter(p => p.category === params.category);
    }

    return products.slice(0, params.limit || 10);
  }

  private async checkAvailability(
    params: { productId: string; quantity?: number },
    context: SkillContext
  ): Promise<{ available: boolean; reason?: string; maxQuantity?: number }> {
    const { productId, quantity = 1 } = params;

    const product = this.products.get(productId);
    if (!product) {
      return { available: false, reason: '商品不存在' };
    }

    if (product.status !== 'active') {
      return { available: false, reason: '商品已下架或售罄' };
    }

    const userPurchaseCount = this.getUserPurchaseCount(context.userId, productId);
    if (product.maxPurchasePerUser) {
      const remaining = product.maxPurchasePerUser - userPurchaseCount;
      if (remaining <= 0) {
        return { available: false, reason: '已达到购买上限' };
      }
      if (quantity > remaining) {
        return { available: true, maxQuantity: remaining };
      }
    }

    if (product.isLimited && product.limitedQuantity) {
      const remaining = product.limitedQuantity - product.purchasedCount;
      if (remaining <= 0) {
        return { available: false, reason: '商品已售罄' };
      }
      if (quantity > remaining) {
        return { available: true, maxQuantity: remaining };
      }
    }

    return { available: true, maxQuantity: quantity };
  }

  // ==================== 辅助方法 ====================

  private async applyCoupon(couponCode: string, totalPrice: number): Promise<{ discount: number; finalPrice: number }> {
    // 简化版优惠券处理，实际应该查询数据库
    const couponMap: Record<string, number> = {
      'DISCOUNT10': 0.1,
      'DISCOUNT20': 0.2,
      'DISCOUNT50': 0.5,
    };

    const discountRate = couponMap[couponCode.toUpperCase()] || 0;
    const discount = totalPrice * discountRate;

    return {
      discount,
      finalPrice: totalPrice - discount,
    };
  }

  private getUserPurchaseCount(userId: string, productId: string): number {
    const userPurchases = this.userPurchases.get(userId);
    if (!userPurchases) return 0;
    return userPurchases.get(productId) || 0;
  }

  private recordUserPurchase(userId: string, productId: string, quantity: number): void {
    if (!this.userPurchases.has(userId)) {
      this.userPurchases.set(userId, new Map());
    }
    const userMap = this.userPurchases.get(userId)!;
    const currentCount = userMap.get(productId) || 0;
    userMap.set(productId, currentCount + quantity);
  }

  private async loadFromStorage(): Promise<void> {
    try {
      const data = localStorage.getItem(this.STORAGE_KEY);
      if (data) {
        const parsed = JSON.parse(data);
        this.products = new Map(Object.entries(parsed.products || {}));
        this.orders = new Map(Object.entries(parsed.orders || {}));
        
        // 恢复日期对象
        this.products.forEach(product => {
          product.createdAt = new Date(product.createdAt);
          product.updatedAt = new Date(product.updatedAt);
          if (product.startTime) product.startTime = new Date(product.startTime);
          if (product.endTime) product.endTime = new Date(product.endTime);
        });
        
        this.orders.forEach(order => {
          order.purchasedAt = new Date(order.purchasedAt);
        });
      }
    } catch (error) {
      console.error('[StoreSkill] 加载数据失败:', error);
    }
  }

  private async saveToStorage(): Promise<void> {
    try {
      const data = {
        products: Object.fromEntries(this.products),
        orders: Object.fromEntries(this.orders),
        updatedAt: new Date().toISOString(),
      };
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(data));
      // CloudBase 双写（通过写入队列，全量入队不再截断）
      const products = Array.from(this.products.values());
      for (const product of products) {
        writeQueue.enqueue({
          collection: 'purchases',
          operation: 'upsert',
          data: product as any,
        });
      }
    } catch (error) {
      console.error('[StoreSkill] 保存数据失败:', error);
    }
  }

  private initializeDefaultProducts(): void {
    if (this.products.size === 0) {
      // 初始化一些默认商品
      const defaultProducts: Omit<StoreProduct, 'id' | 'purchasedCount' | 'createdAt' | 'updatedAt'>[] = [
        {
          name: '新手礼包',
          description: '包含初始游戏币和道具',
          category: 'bundle',
          price: { amount: 0, currency: 'cash' },
          quantity: 1,
          isLimited: true,
          limitedQuantity: 1,
          maxPurchasePerUser: 1,
          status: 'active',
          rewards: [
            { type: 'currency', itemId: 'gameCoins', quantity: 1000 },
            { type: 'item', itemName: '新手剑', quantity: 1 },
          ],
          tags: ['newbie', 'free'],
        },
        {
          name: '游戏币礼包（小）',
          description: '1000 游戏币',
          category: 'currency',
          price: { amount: 10, currency: 'cash' },
          quantity: 9999,
          status: 'active',
          rewards: [
            { type: 'currency', itemId: 'gameCoins', quantity: 1000 },
          ],
          tags: ['currency', 'popular'],
        },
        {
          name: '游戏币礼包（大）',
          description: '10000 游戏币',
          category: 'currency',
          price: { amount: 88, currency: 'cash' },
          originalPrice: { amount: 100, currency: 'cash' },
          quantity: 9999,
          status: 'active',
          rewards: [
            { type: 'currency', itemId: 'gameCoins', quantity: 10000 },
          ],
          tags: ['currency', 'popular', 'discount'],
        },
      ];

      defaultProducts.forEach(product => {
        const newProduct: StoreProduct = {
          ...product,
          id: this.generateId(),
          purchasedCount: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        this.products.set(newProduct.id, newProduct);
      });

      this.saveToStorage();
    }
  }
}

// 导出单例
export const storeSkill = new StoreSkill();
