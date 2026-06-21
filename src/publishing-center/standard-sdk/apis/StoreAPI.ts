/**
 * Store API - 游戏商店
 */

import type { AllinONEGame } from '../index';
import { getCachedToken } from './tokenManager';

export interface StoreProduct {
  id: string;
  name: string;
  description: string;
  category: 'item' | 'currency' | 'bundle' | 'subscription';
  price: number;
  currencyType: string;
  icon?: string;
  quantity: number;
  metadata?: Record<string, any>;
  limited?: boolean;
  remaining?: number;
}

export interface PurchaseResult {
  success: boolean;
  orderId?: string;
  items?: Array<{ itemId: string; quantity: number }>;
  error?: string;
}

export interface CartItem {
  productId: string;
  quantity: number;
}

export class StoreAPI {
  private game: AllinONEGame;
  private products: Map<string, StoreProduct> = new Map();
  private cart: CartItem[] = [];
  private initialized: boolean = false;
  private isOpen: boolean = false;

  constructor(game: AllinONEGame) {
    this.game = game;
  }

  async initialize(): Promise<void> {
    // 加载商品列表
    await this.loadProducts();
    this.initialized = true;
  }

  /**
   * 获取所有商品
   */
  async getProducts(category?: string): Promise<StoreProduct[]> {
    await this.loadProducts();
    const products = Array.from(this.products.values());
    
    if (category) {
      return products.filter(p => p.category === category);
    }
    
    return products;
  }

  /**
   * 获取单个商品
   */
  async getProduct(productId: string): Promise<StoreProduct | undefined> {
    return this.products.get(productId);
  }

  /**
   * 打开商店
   */
  async open(): Promise<void> {
    await this.loadProducts();
    this.isOpen = true;
    // 触发商店打开事件
  }

  /**
   * 关闭商店
   */
  async close(): Promise<void> {
    this.isOpen = false;
    this.cart = [];
  }

  /**
   * 添加到购物车
   */
  addToCart(productId: string, quantity: number = 1): boolean {
    const product = this.products.get(productId);
    if (!product) return false;

    const existingItem = this.cart.find(item => item.productId === productId);
    if (existingItem) {
      existingItem.quantity += quantity;
    } else {
      this.cart.push({ productId, quantity });
    }

    return true;
  }

  /**
   * 从购物车移除
   */
  removeFromCart(productId: string): void {
    this.cart = this.cart.filter(item => item.productId !== productId);
  }

  /**
   * 清空购物车
   */
  clearCart(): void {
    this.cart = [];
  }

  /**
   * 获取购物车内容
   */
  getCart(): Array<{ product: StoreProduct; quantity: number }> {
    return this.cart.map(item => ({
      product: this.products.get(item.productId)!,
      quantity: item.quantity,
    })).filter(item => item.product);
  }

  /**
   * 计算购物车总价
   */
  getCartTotal(): number {
    return this.cart.reduce((total, item) => {
      const product = this.products.get(item.productId);
      if (product) {
        return total + product.price * item.quantity;
      }
      return total;
    }, 0);
  }

  /**
   * 购买商品
   */
  async purchase(productId: string, quantity: number = 1): Promise<PurchaseResult> {
    const product = this.products.get(productId);
    
    if (!product) {
      return { success: false, error: '商品不存在' };
    }

    if (product.limited && product.remaining !== undefined && product.remaining < quantity) {
      return { success: false, error: '库存不足' };
    }

    try {
      const token = this.getToken();
      if (!token) {
        return { success: false, error: '请先登录' };
      }

      const response = await fetch('/api/store/purchase', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          productId,
          quantity,
          gameId: this.getGameId(),
        }),
      });

      const result = await response.json();

      if (result.success) {
        // 刷新商品列表
        await this.loadProducts();
        
        // 触发购买成功事件
        (this.game as any).emit('store:purchase', {
          productId,
          quantity,
          orderId: result.orderId,
        });
      }

      return result;
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : '购买失败',
      };
    }
  }

  /**
   * 结算购物车
   */
  async checkout(): Promise<PurchaseResult> {
    if (this.cart.length === 0) {
      return { success: false, error: '购物车为空' };
    }

    try {
      const token = this.getToken();
      if (!token) {
        return { success: false, error: '请先登录' };
      }

      const response = await fetch('/api/store/checkout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          items: this.cart,
          gameId: this.getGameId(),
        }),
      });

      const result = await response.json();

      if (result.success) {
        this.cart = [];
        await this.loadProducts();
        
        (this.game as any).emit('store:checkout', {
          orderId: result.orderId,
          items: result.items,
        });
      }

      return result;
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : '结算失败',
      };
    }
  }

  /**
   * 检查是否可以购买
   */
  async canPurchase(productId: string, quantity: number = 1): Promise<boolean> {
    const product = this.products.get(productId);
    if (!product) return false;

    if (product.limited && product.remaining !== undefined) {
      return product.remaining >= quantity;
    }

    return true;
  }

  // ==================== 私有方法 ====================

  private async loadProducts(): Promise<void> {
    try {
      const response = await fetch(`/api/store/products?gameId=${this.getGameId()}`);
      const result = await response.json();

      if (result.success && result.products) {
        this.products.clear();
        result.products.forEach((product: StoreProduct) => {
          this.products.set(product.id, product);
        });
      }
    } catch (error) {
      console.warn('Failed to load store products:', error);
    }
  }

  private getGameId(): string {
    return (this.game as any).getConfig().gameId;
  }

  private getToken(): string | null {
    return localStorage.getItem('allinone_token');
  }
}
