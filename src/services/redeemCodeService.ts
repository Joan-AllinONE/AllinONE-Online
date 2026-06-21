/**
 * 兑换码服务
 * 
 * 提供兑换码生成、验证、管理等功能
 */

import {
  HostedItem,
  RedeemCode,
  RedeemCodeStatus,
  ItemType,
  CreateHostedItemRequest,
  GenerateCodesRequest,
  GenerateCodesResponse,
  VerifyCodeRequest,
  VerifyCodeResponse,
  UseCodeRequest,
  UseCodeResponse,
  ItemStatistics,
  GameRedeemCodeOverview,
  RedeemCodePurchase,
} from '@/types/redeemCode';
import { getToken } from './authTokenService';

// ==================== 工具函数 ====================

/**
 * 生成随机兑换码
 */
function generateRandomCode(
  length: number,
  charset: 'alphanumeric' | 'numeric' | 'alphabetic',
  caseSensitive: boolean
): string {
  const charsets = {
    alphanumeric: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
    numeric: '0123456789',
    alphabetic: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  };
  
  let chars = charsets[charset];
  if (!caseSensitive) {
    chars = chars.toUpperCase();
  }
  
  let code = '';
  for (let i = 0; i < length; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  
  return code;
}

/**
 * 生成唯一ID
 */
function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
}

// ==================== 本地存储键 ====================

const STORAGE_KEYS = {
  HOSTED_ITEMS: 'allinone_redeem_items',
  REDEEM_CODES: 'allinone_redeem_codes',
  PURCHASES: 'allinone_redeem_purchases',
};

// ==================== CloudBase 同步工具（writeQueue 优先） ====================

import { writeQueue } from './writeQueue';

/** 通过 writeQueue 将数据同步到 CloudBase（保证零丢失 + 重试） */
function syncToCloudBase(collection: string, items: any[]): void {
  for (const item of items) {
    writeQueue.enqueue({
      collection,
      operation: 'upsert',
      data: item,
    });
  }
}

let _cloudSyncInitiated = false;

/**
 * 从 CloudBase 加载增量数据到本地缓存（首次调用时异步执行一次）
 * CloudBase 数据覆盖本地缓存（权威数据源）
 */
function initCloudSyncIfNeeded(): void {
  if (_cloudSyncInitiated) return;
  _cloudSyncInitiated = true;
  import('./cloudbase').then(({ isCloudBaseReady, getCloudBaseApp }) => {
    if (!isCloudBaseReady()) return;
    const db = getCloudBaseApp().database();
    const collections = [
      { key: STORAGE_KEYS.HOSTED_ITEMS, name: 'redeem_hosted_items' },
      { key: STORAGE_KEYS.REDEEM_CODES, name: 'redeem_codes' },
      { key: STORAGE_KEYS.PURCHASES, name: 'redeem_purchases' },
    ];
    for (const col of collections) {
      db.collection(col.name).limit(500).get().then(res => {
        if (res.data.length === 0) return;
        const localRaw = localStorage.getItem(col.key);
        const local: any[] = localRaw ? JSON.parse(localRaw) : [];
        // ✅ CloudBase 数据覆盖本地同名 ID（云端为准）
        const cloudMap = new Map(res.data.map((d: any) => [d.id, d]));
        const localOnly = local.filter((x: any) => !cloudMap.has(x.id));
        const merged = [...res.data, ...localOnly];
        localStorage.setItem(col.key, JSON.stringify(merged));
      }).catch(() => {});
    }
  }).catch(() => {});
}

// ==================== 兑换码服务类 ====================

class RedeemCodeService {
  // ==================== 托管道具管理 ====================

  /**
   * 创建托管道具
   */
  async createHostedItem(request: CreateHostedItemRequest): Promise<HostedItem> {
    const item: HostedItem = {
      id: `item-${generateId()}`,
      gameId: request.gameId,
      name: request.name,
      description: request.description,
      type: request.type,
      codeConfig: {
        length: request.codeConfig.length || 8,
        charset: request.codeConfig.charset || 'alphanumeric',
        caseSensitive: request.codeConfig.caseSensitive ?? false,
        prefix: request.codeConfig.prefix || '',
        expireDays: request.codeConfig.expireDays || 0,
        singleUse: request.codeConfig.singleUse ?? true,
      },
      inventory: {
        total: request.initialInventory,
        available: request.initialInventory,
        sold: 0,
        used: 0,
      },
      pricing: {
        price: request.pricing.price,
        currency: request.pricing.currency || 'ACOIN',
        discount: request.pricing.discount,
        bulkDiscount: request.pricing.bulkDiscount,
      },
      gameEffect: request.gameEffect,
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // 保存到本地存储
    const items = this.getHostedItems();
    items.push(item);
    localStorage.setItem(STORAGE_KEYS.HOSTED_ITEMS, JSON.stringify(items));
    syncToCloudBase('redeem_hosted_items', [item]);

    // 自动生成兑换码
    if (request.initialInventory > 0) {
      await this.generateCodes({
        itemId: item.id,
        gameId: item.gameId,
        quantity: request.initialInventory,
      });
    }

    return item;
  }

  /**
   * 获取所有托管道具
   */
  getHostedItems(gameId?: string): HostedItem[] {
    initCloudSyncIfNeeded();
    const data = localStorage.getItem(STORAGE_KEYS.HOSTED_ITEMS);
    const items: HostedItem[] = data ? JSON.parse(data) : [];
    return gameId ? items.filter(i => i.gameId === gameId) : items;
  }

  /**
   * 获取单个托管道具
   */
  getHostedItem(itemId: string): HostedItem | null {
    const items = this.getHostedItems();
    return items.find(i => i.id === itemId) || null;
  }

  /**
   * 更新托管道具
   */
  async updateHostedItem(itemId: string, updates: Partial<HostedItem>): Promise<HostedItem | null> {
    const items = this.getHostedItems();
    const index = items.findIndex(i => i.id === itemId);
    if (index === -1) return null;

    items[index] = {
      ...items[index],
      ...updates,
      updatedAt: new Date().toISOString(),
    };

    localStorage.setItem(STORAGE_KEYS.HOSTED_ITEMS, JSON.stringify(items));
    syncToCloudBase('redeem_hosted_items', [items[index]]);
    return items[index];
  }

  /**
   * 删除托管道具
   */
  async deleteHostedItem(itemId: string): Promise<boolean> {
    const items = this.getHostedItems();
    const itemToDelete = items.find(i => i.id === itemId);
    const filtered = items.filter(i => i.id !== itemId);
    localStorage.setItem(STORAGE_KEYS.HOSTED_ITEMS, JSON.stringify(filtered));
    
    // ✅ 同步删除 CloudBase 中的数据（防止下次云端同步拉回已删除的数据）
    if (itemToDelete) {
      writeQueue.enqueue({
        collection: 'redeem_hosted_items',
        operation: 'delete',
        where: { id: itemId },
      });
    }
    
    // 同时删除关联的兑换码
    const codes = this.getAllCodes();
    const relatedCodes = codes.filter(c => c.itemId === itemId);
    const filteredCodes = codes.filter(c => c.itemId !== itemId);
    localStorage.setItem(STORAGE_KEYS.REDEEM_CODES, JSON.stringify(filteredCodes));
    // ✅ 同步删除关联兑换码
    for (const code of relatedCodes) {
      writeQueue.enqueue({
        collection: 'redeem_codes',
        operation: 'delete',
        where: { id: code.id },
      });
    }
    
    return true;
  }

  // ==================== 兑换码生成与管理 ====================

  /**
   * 生成兑换码
   */
  async generateCodes(request: GenerateCodesRequest): Promise<GenerateCodesResponse> {
    const item = this.getHostedItem(request.itemId);
    if (!item) {
      return { success: false, codes: [], generatedCount: 0, failedCount: request.quantity };
    }

    const codes: RedeemCode[] = [];
    const existingCodes = new Set(this.getAllCodes().map(c => c.code));
    
    const { prefix, length, charset, caseSensitive, expireDays } = item.codeConfig;
    
    let attempts = 0;
    const maxAttempts = request.quantity * 10; // 防止无限循环
    
    while (codes.length < request.quantity && attempts < maxAttempts) {
      attempts++;
      
      const codeStr = `${prefix}${generateRandomCode(length, charset, caseSensitive)}`;
      
      // 检查是否重复
      if (existingCodes.has(codeStr)) continue;
      
      const code: RedeemCode = {
        id: `code-${generateId()}`,
        code: codeStr,
        gameId: item.gameId,
        itemId: item.id,
        status: RedeemCodeStatus.UNUSED,
        createdAt: new Date().toISOString(),
        expiredAt: (expireDays ?? 0) > 0 
          ? new Date(Date.now() + (expireDays ?? 0) * 24 * 60 * 60 * 1000).toISOString()
          : undefined,
        verifyCount: 0,
      };
      
      codes.push(code);
      existingCodes.add(codeStr);
    }

    // 保存兑换码
    const allCodes = this.getAllCodes();
    allCodes.push(...codes);
    localStorage.setItem(STORAGE_KEYS.REDEEM_CODES, JSON.stringify(allCodes));
    syncToCloudBase('redeem_codes', codes);

    // 更新库存
    await this.updateHostedItem(item.id, {
      inventory: {
        ...item.inventory,
        total: item.inventory.total + codes.length,
        available: item.inventory.available + codes.length,
      },
    });

    // 自动同步到后端
    this.syncToBackend().catch(() => {});

    return {
      success: true,
      codes,
      generatedCount: codes.length,
      failedCount: request.quantity - codes.length,
    };
  }

  /**
   * 获取所有兑换码
   */
  getAllCodes(): RedeemCode[] {
    initCloudSyncIfNeeded();
    const data = localStorage.getItem(STORAGE_KEYS.REDEEM_CODES);
    return data ? JSON.parse(data) : [];
  }

  /**
   * 获取指定道具的兑换码
   */
  getCodesByItem(itemId: string, status?: RedeemCodeStatus): RedeemCode[] {
    const codes = this.getAllCodes();
    return codes.filter(c => {
      if (c.itemId !== itemId) return false;
      if (status && c.status !== status) return false;
      return true;
    });
  }

  // ==================== 验证与使用（游戏方调用） ====================

  /**
   * 验证兑换码
   * 
   * 游戏方在游戏内调用此接口验证玩家输入的兑换码
   */
  async verifyCode(request: VerifyCodeRequest): Promise<VerifyCodeResponse> {
    const codes = this.getAllCodes();
    
    // 第一优先级：精确匹配 gameId + code
    let code = codes.find(c => 
      c.gameId === request.gameId && 
      c.code.toUpperCase() === request.code.toUpperCase()
    );

    // 降级搜索：仅按 code 搜索（gameId 可能因重新发布而变化）
    if (!code) {
      code = codes.find(c => c.code.toUpperCase() === request.code.toUpperCase());
      if (code && code.gameId !== request.gameId) {
        // 找到码但 gameId 不匹配，更新为当前 gameId（重新发布场景）
        code.gameId = request.gameId;
        this.updateCode(code);
      }
    }

    if (!code) {
      return { valid: false, message: '兑换码不存在' };
    }

    // 更新验证次数
    code.verifyCount++;
    code.lastVerifyAt = new Date().toISOString();
    this.updateCode(code);

    // 检查状态
    if (code.status === RedeemCodeStatus.USED) {
      return { valid: false, code, message: '兑换码已被使用' };
    }

    if (code.status === RedeemCodeStatus.EXPIRED || 
        (code.expiredAt && new Date(code.expiredAt) < new Date())) {
      code.status = RedeemCodeStatus.EXPIRED;
      this.updateCode(code);
      return { valid: false, code, message: '兑换码已过期' };
    }

    if (code.status === RedeemCodeStatus.DISABLED) {
      return { valid: false, code, message: '兑换码已禁用' };
    }

    // 获取道具信息
    const item = this.getHostedItem(code.itemId);
    if (!item) {
      return { valid: false, message: '道具信息不存在' };
    }

    return {
      valid: true,
      code,
      item,
      gameEffect: item.gameEffect,
    };
  }

  /**
   * 使用兑换码
   * 
   * 游戏方在验证通过后调用此接口标记兑换码为已使用
   */
  async useCode(request: UseCodeRequest): Promise<UseCodeResponse> {
    // 先验证
    const verifyResult = await this.verifyCode({
      code: request.code,
      gameId: request.gameId,
      userId: request.userId,
    });

    if (!verifyResult.valid) {
      return {
        success: false,
        code: request.code,
        message: verifyResult.message || '验证失败',
        usedAt: new Date().toISOString(),
      };
    }

    const code = verifyResult.code!;
    const item = verifyResult.item!;

    // 更新兑换码状态
    code.status = RedeemCodeStatus.USED;
    code.usedAt = new Date().toISOString();
    code.usedBy = request.userId;
    this.updateCode(code);

    // 更新库存统计
    await this.updateHostedItem(item.id, {
      inventory: {
        ...item.inventory,
        available: item.inventory.available - 1,
        used: item.inventory.used + 1,
      },
    });

    // 自动同步到后端
    this.syncToBackend().catch(() => {});

    return {
      success: true,
      code: request.code,
      item,
      gameEffect: item.gameEffect,
      usedAt: code.usedAt,
    };
  }

  /**
   * 批量验证兑换码（用于导入功能）
   */
  async batchVerifyCodes(codes: string[], gameId: string): Promise<VerifyCodeResponse[]> {
    const results: VerifyCodeResponse[] = [];
    for (const code of codes) {
      const result = await this.verifyCode({ code, gameId, userId: 'batch-verify' });
      results.push(result);
    }
    return results;
  }

  // ==================== 购买相关 ====================

  /**
   * 购买兑换码
   * 
   * 玩家购买时调用，返回兑换码
   */
  async purchaseCodes(
    itemId: string,
    quantity: number,
    userId: string
  ): Promise<{ success: boolean; purchase?: RedeemCodePurchase; codes: string[]; message?: string }> {
    const item = this.getHostedItem(itemId);
    if (!item) {
      return { success: false, codes: [], message: '道具不存在' };
    }

    if (item.inventory.available < quantity) {
      return { success: false, codes: [], message: '库存不足' };
    }

    // 获取可用兑换码
    const availableCodes = this.getCodesByItem(itemId, RedeemCodeStatus.UNUSED);
    if (availableCodes.length < quantity) {
      return { success: false, codes: [], message: '可用兑换码不足' };
    }

    // 计算价格（含批量折扣）
    let totalPrice = item.pricing.price * quantity;
    let discount = 0;

    if (item.pricing.bulkDiscount) {
      for (const bd of item.pricing.bulkDiscount.sort((a, b) => b.minQuantity - a.minQuantity)) {
        if (quantity >= bd.minQuantity) {
          discount = totalPrice * bd.discount;
          totalPrice -= discount;
          break;
        }
      }
    }

    if (item.pricing.discount) {
      discount += totalPrice * item.pricing.discount;
      totalPrice -= totalPrice * item.pricing.discount;
    }

    // 分配兑换码
    const selectedCodes = availableCodes.slice(0, quantity);
    const now = new Date().toISOString();

    selectedCodes.forEach(code => {
      code.status = RedeemCodeStatus.SOLD;
      code.soldAt = now;
      code.soldTo = userId;
      this.updateCode(code);
    });

    // 更新库存
    await this.updateHostedItem(itemId, {
      inventory: {
        ...item.inventory,
        available: item.inventory.available - quantity,
        sold: item.inventory.sold + quantity,
      },
    });

    // 创建购买记录
    const purchase: RedeemCodePurchase = {
      id: `purchase-${generateId()}`,
      userId,
      gameId: item.gameId,
      itemId: item.id,
      codeIds: selectedCodes.map(c => c.id),
      codes: selectedCodes.map(c => c.code),
      quantity,
      unitPrice: item.pricing.price,
      totalPrice: item.pricing.price * quantity,
      currency: item.pricing.currency,
      discount,
      finalPrice: totalPrice,
      status: 'completed',
      paidAt: now,
      completedAt: now,
    };

    const purchases = this.getPurchases();
    purchases.push(purchase);
    localStorage.setItem(STORAGE_KEYS.PURCHASES, JSON.stringify(purchases));
    syncToCloudBase('redeem_purchases', [purchase]);

    // 自动同步到后端
    this.syncToBackend().catch(() => {});

    return {
      success: true,
      purchase,
      codes: selectedCodes.map(c => c.code),
    };
  }

  /**
   * 获取购买记录
   */
  getPurchases(userId?: string, gameId?: string): RedeemCodePurchase[] {
    initCloudSyncIfNeeded();
    const data = localStorage.getItem(STORAGE_KEYS.PURCHASES);
    let purchases: RedeemCodePurchase[] = data ? JSON.parse(data) : [];
    
    if (userId) {
      purchases = purchases.filter(p => p.userId === userId);
    }
    if (gameId) {
      purchases = purchases.filter(p => p.gameId === gameId);
    }
    
    return purchases;
  }

  // ==================== 统计与概览 ====================

  /**
   * 获取道具统计
   */
  async getItemStatistics(itemId: string): Promise<ItemStatistics | null> {
    const item = this.getHostedItem(itemId);
    if (!item) return null;

    const codes = this.getCodesByItem(itemId);
    const purchases = this.getPurchases(undefined, item.gameId)
      .filter(p => p.itemId === itemId);

    const revenue = purchases.reduce((sum, p) => sum + p.finalPrice, 0);

    // 按日期分组统计
    const salesMap = new Map<string, { sold: number; revenue: number }>();
    purchases.forEach(p => {
      const date = p.paidAt.split('T')[0];
      const existing = salesMap.get(date) || { sold: 0, revenue: 0 };
      existing.sold += p.quantity;
      existing.revenue += p.finalPrice;
      salesMap.set(date, existing);
    });

    const salesTrend = Array.from(salesMap.entries())
      .map(([date, data]) => ({ date, ...data }))
      .sort((a, b) => a.date.localeCompare(b.date));

    return {
      itemId,
      totalCodes: codes.length,
      availableCodes: codes.filter(c => c.status === RedeemCodeStatus.UNUSED).length,
      soldCodes: codes.filter(c => c.status === RedeemCodeStatus.SOLD).length,
      usedCodes: codes.filter(c => c.status === RedeemCodeStatus.USED).length,
      expiredCodes: codes.filter(c => c.status === RedeemCodeStatus.EXPIRED).length,
      revenue,
      salesTrend,
    };
  }

  /**
   * 获取游戏兑换码总览
   */
  async getGameOverview(gameId: string): Promise<GameRedeemCodeOverview | null> {
    const items = this.getHostedItems(gameId);
    if (items.length === 0) return null;

    const codes = this.getAllCodes().filter(c => c.gameId === gameId);
    const purchases = this.getPurchases(undefined, gameId);

    const totalRevenue = purchases.reduce((sum, p) => sum + p.finalPrice, 0);

    const topItems = items
      .map(item => {
        const itemPurchases = purchases.filter(p => p.itemId === item.id);
        const sales = itemPurchases.reduce((sum, p) => sum + p.quantity, 0);
        const revenue = itemPurchases.reduce((sum, p) => sum + p.finalPrice, 0);
        return { itemId: item.id, name: item.name, sales, revenue };
      })
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 5);

    return {
      gameId,
      totalItems: items.length,
      totalCodes: codes.length,
      totalAvailable: codes.filter(c => c.status === RedeemCodeStatus.UNUSED).length,
      totalSold: codes.filter(c => c.status === RedeemCodeStatus.SOLD).length,
      totalUsed: codes.filter(c => c.status === RedeemCodeStatus.USED).length,
      totalRevenue: totalRevenue,
      recentSales: purchases.slice(-10).reverse(),
      topItems,
    };
  }

  // ==================== 私有方法 ====================

  private updateCode(updatedCode: RedeemCode): void {
    const codes = this.getAllCodes();
    const index = codes.findIndex(c => c.id === updatedCode.id);
    if (index !== -1) {
      codes[index] = updatedCode;
      localStorage.setItem(STORAGE_KEYS.REDEEM_CODES, JSON.stringify(codes));
    }
  }

  // ==================== 后端同步与 API 客户端 ====================

  /** 后端 API 基础 URL */
  private apiBaseUrl: string = '';

  /** 设置后端 API 地址 */
  setApiBaseUrl(url: string): void {
    this.apiBaseUrl = url.replace(/\/$/, '');
  }

  /** 获取后端 API 地址 */
  getApiBaseUrl(): string {
    return this.apiBaseUrl || (typeof window !== 'undefined' ? window.location.origin : '');
  }

  /**
   * 同步所有兑换码和道具到后端
   * 在购买、铸造、生成兑换码后自动调用
   */
  async syncToBackend(): Promise<{ success: boolean; message: string }> {
    try {
      const codes = this.getAllCodes();
      const items = this.getHostedItems();

      // 转换为后端格式
      const codeRecords = codes.map(c => ({
        id: c.id,
        code: c.code,
        gameId: c.gameId,
        itemId: c.itemId,
        itemName: items.find(i => i.id === c.itemId)?.name || '',
        status: c.status,
        gameEffect: items.find(i => i.id === c.itemId)?.gameEffect || { itemId: '', quantity: 0 },
        createdAt: c.createdAt,
        soldAt: c.soldAt,
        soldTo: c.soldTo,
        usedAt: c.usedAt,
        usedBy: c.usedBy,
        expiredAt: c.expiredAt,
        verifyCount: c.verifyCount,
        lastVerifyAt: c.lastVerifyAt,
      }));

      const itemRecords = items.map(i => ({
        id: i.id,
        gameId: i.gameId,
        name: i.name,
        description: i.description,
        gameEffect: i.gameEffect,
        inventory: i.inventory,
        status: i.status,
        createdAt: i.createdAt,
        updatedAt: i.updatedAt,
      }));

      // 获取 JWT token 用于认证（通过集中式 token 服务）
      let token: string | null = null;
      try {
        token = await getToken();
      } catch { /* 获取 token 失败，继续无认证请求 */ }

      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;

      const response = await fetch(`${this.getApiBaseUrl()}/api/redeem/sync`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ codes: codeRecords, items: itemRecords }),
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result = await response.json();

      console.log('[RedeemService] 同步到后端:', result.data);
      return { success: true, message: '同步成功' };
    } catch (error) {
      console.warn('[RedeemService] 后端同步失败（离线模式）:', error);
      return { success: false, message: '后端不可用，运行在离线模式' };
    }
  }

  /**
   * 通过后端 API 验证兑换码（游戏方 SDK 使用）
   */
  async verifyCodeViaApi(params: { code: string; gameId: string; apiKey?: string }): Promise<VerifyCodeResponse> {
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (params.apiKey) {
        headers['Authorization'] = `Bearer ${params.apiKey}`;
      }

      const response = await fetch(`${this.getApiBaseUrl()}/api/redeem/verify`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ code: params.code, gameId: params.gameId }),
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result = await response.json();

      if (!result.success) {
        return { valid: false, message: result.error || 'API 调用失败' };
      }

      return result.data as VerifyCodeResponse;
    } catch (error) {
      console.warn('[RedeemService] API 验证失败，回退到本地:', error);
      return this.verifyCode({ code: params.code, gameId: params.gameId, userId: 'api-call' });
    }
  }

  /**
   * 通过后端 API 核销兑换码（游戏方 SDK 使用）
   */
  async useCodeViaApi(params: { code: string; gameId: string; userId: string; apiKey?: string }): Promise<UseCodeResponse> {
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (params.apiKey) {
        headers['Authorization'] = `Bearer ${params.apiKey}`;
      }

      const response = await fetch(`${this.getApiBaseUrl()}/api/redeem/use`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ code: params.code, gameId: params.gameId, userId: params.userId }),
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result = await response.json();

      if (!result.success) {
        return { success: false, code: params.code, usedAt: new Date().toISOString(), message: result.error || 'API 调用失败' };
      }

      const data = result.data as UseCodeResponse;

      // 同时更新本地状态
      const localCode = this.getAllCodes().find(c => c.code.toUpperCase() === params.code.toUpperCase());
      if (localCode) {
        localCode.status = RedeemCodeStatus.USED;
        localCode.usedAt = data.usedAt;
        localCode.usedBy = params.userId;
        this.updateCode(localCode);
      }

      return data;
    } catch (error) {
      console.warn('[RedeemService] API 核销失败，回退到本地:', error);
      return this.useCode({ code: params.code, gameId: params.gameId, userId: params.userId });
    }
  }
}

// ==================== 导出单例 ====================

export const redeemCodeService = new RedeemCodeService();
export default redeemCodeService;
