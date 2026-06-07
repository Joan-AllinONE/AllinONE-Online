/**
 * VoucherSkill - 凭证 Skill（MVP v1.0）
 * 
 * 管理数字凭证的完整生命周期：模板创建 → 铸造 → 购买 → 转账 → 核销。
 * 数据持久化到 CloudBase: voucher_templates, vouchers, purchases
 */

import { BaseSkill } from '../BaseSkill';
import type { SkillContext } from '../types';
import { getCloudBaseApp } from '../../services/cloudbase';

// ==================== 类型 ====================

export interface VoucherTemplate {
  id: string;
  gameId: string;
  gameName: string;
  name: string;
  description: string;
  supplyPolicy: 'limited' | 'open';
  totalSupply: number;
  mintedCount: number;
  pricing: { price: number; currency: 'gameCoins' | 'aCoins'; acceptVoucher: boolean };
  gameEffect: { itemId: string; quantity: number };
  rarity: string;
  isActive: boolean;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

export interface Voucher {
  id: string;
  templateId: string;
  holderId: string;
  denomination: number;
  status: 'active' | 'frozen' | 'destroyed' | 'transferred';
  sourceType: 'instant' | 'algorithm' | 'item' | 'vote';
  redeemCode?: string;
  metadata: Record<string, any>;
  createdAt: number;
  updatedAt: number;
}

export interface Purchase {
  id: string;
  userId: string;
  templateId: string;
  voucherId: string;
  gameId: string;
  price: number;
  currency: string;
  status: 'pending' | 'redeemed' | 'expired';
  redeemCode: string;
  paidAt: number;
  redeemedAt?: number;
}

// ==================== Skill ====================

export class VoucherSkill extends BaseSkill {
  constructor() {
    super({
      name: 'voucher',
      version: '1.0.0',
      displayName: '凭证服务',
      description: '数字凭证管理：模板/铸造/购买/转账/核销',
      dependencies: ['wallet'],
    requiredPermissions: [], actions: [] });
  }

  protected async onInitialize(): Promise<void> {
    this.registerAction('createTemplate', this.createTemplate.bind(this), {
      description: '创建凭证模板',
      params: { type: 'object', required: ['gameId', 'gameName', 'name', 'pricing'], properties: {} },
    });

    this.registerAction('getTemplates', this.getTemplates.bind(this), {
      description: '获取凭证模板列表',
      params: { type: 'object', properties: { gameId: { type: 'string' }, isActive: { type: 'boolean' } } },
    });

    this.registerAction('mint', this.mint.bind(this), {
      description: '铸造凭证',
      params: { type: 'object', required: ['templateId', 'count'], properties: { templateId: { type: 'string' }, count: { type: 'number' }, sourceType: { type: 'string' } } },
    });

    this.registerAction('purchase', this.purchase.bind(this), {
      description: '购买凭证',
      params: { type: 'object', required: ['templateId'], properties: {} },
    });

    this.registerAction('transfer', this.transfer.bind(this), {
      description: '转让凭证',
      params: { type: 'object', required: ['voucherId', 'toUserId'], properties: {} },
    });

    this.registerAction('redeem', this.redeem.bind(this), {
      description: '核销凭证（使用兑换码）',
      params: { type: 'object', required: ['redeemCode'], properties: { redeemCode: { type: 'string' }, gameId: { type: 'string' } } },
    });

    this.registerAction('getUserVouchers', this.getUserVouchers.bind(this), {
      description: '获取用户持有的凭证',
      params: { type: 'object', properties: {} },
    });
  }

  // ==================== Actions ====================

  async createTemplate(params: Partial<VoucherTemplate>, context: SkillContext) {
    const t: VoucherTemplate = {
      id: `vt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      gameId: params.gameId || '',
      gameName: params.gameName || '',
      name: params.name || 'New Voucher',
      description: params.description || '',
      supplyPolicy: params.supplyPolicy || 'open',
      totalSupply: params.totalSupply || 1000,
      mintedCount: 0,
      pricing: params.pricing || { price: 0, currency: 'gameCoins', acceptVoucher: true },
      gameEffect: params.gameEffect || { itemId: '', quantity: 1 },
      rarity: params.rarity || 'common',
      isActive: true,
      createdBy: context.userId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    try {
      const app = getCloudBaseApp();
      await app.database().collection('voucher_templates').add(t);
    } catch { /* local only */ }
    this.saveLocalTemplate(t);
    return { success: true, data: t };
  }

  async getTemplates(params: { gameId?: string; isActive?: boolean }, context: SkillContext) {
    const filter: any = {};
    if (params.gameId) filter.gameId = params.gameId;
    if (params.isActive !== undefined) filter.isActive = params.isActive;
    try {
      const app = getCloudBaseApp();
      let query = app.database().collection('voucher_templates');
      if (filter.gameId) query = query.where({ gameId: filter.gameId });
      if (filter.isActive !== undefined) query = query.where({ isActive: filter.isActive });
      const res = await query.get();
      return { success: true, data: res.data };
    } catch {
      return { success: true, data: this.getLocalTemplates() };
    }
  }

  async mint(params: { templateId: string; count?: number; sourceType?: Voucher['sourceType'] }, context: SkillContext) {
    const count = params.count || 1;
    const sourceType = params.sourceType || 'instant';
    const template = this.getLocalTemplate(params.templateId);
    if (!template) return { success: false, error: 'Template not found' };
    if (template.supplyPolicy === 'limited' && template.mintedCount + count > template.totalSupply) {
      return { success: false, error: 'Supply limit exceeded' };
    }

    const vouchers: Voucher[] = [];
    for (let i = 0; i < count; i++) {
      const v: Voucher = {
        id: `v_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 6)}`,
        templateId: params.templateId,
        holderId: context.userId,
        denomination: template.pricing.price,
        status: 'active',
        sourceType,
        metadata: { gameId: template.gameId, itemId: template.gameEffect.itemId },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      vouchers.push(v);
      this.saveLocalVoucher(v);
    }

    template.mintedCount += count;
    template.updatedAt = Date.now();
    this.saveLocalTemplate(template);

    try {
      const app = getCloudBaseApp();
      const db = app.database();
      await db.collection('voucher_templates').where({ id: params.templateId }).update({ mintedCount: template.mintedCount, updatedAt: template.updatedAt });
      for (const v of vouchers) await db.collection('vouchers').add(v);
    } catch { /* best effort */ }

    return { success: true, data: vouchers };
  }

  async purchase(params: { templateId: string }, context: SkillContext) {
    const template = this.getLocalTemplate(params.templateId);
    if (!template) return { success: false, error: 'Template not found' };
    if (!template.isActive) return { success: false, error: 'Template is inactive' };
    if (template.supplyPolicy === 'limited' && template.mintedCount >= template.totalSupply) {
      return { success: false, error: 'Sold out' };
    }

    const code = `ALLINONE-${template.gameId.toUpperCase()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    const purchase: Purchase = {
      id: `p_${Date.now()}`,
      userId: context.userId,
      templateId: params.templateId,
      voucherId: '',
      gameId: template.gameId,
      price: template.pricing.price,
      currency: template.pricing.currency,
      status: 'pending',
      redeemCode: code,
      paidAt: Date.now(),
    };

    // 通过 wallet Skill 扣款（仅支持 gameCoins）
    if (template.pricing.currency !== 'gameCoins') {
      return { success: false, error: '仅支持 gameCoins 支付，A币请使用凭证支付' };
    }
    try {
      const walletResult = await this.gateway.execute('wallet', 'spend', {
        amount: template.pricing.price,
        description: `购买 ${template.name}`,
      }, context as any);
      if (!walletResult.success) {
        return { success: false, error: walletResult.error || 'Payment failed' };
      }
    } catch {
      return { success: false, error: 'Wallet service unavailable' };
    }

    // 铸造并绑定
    const mintResult = await this.mint({ templateId: params.templateId, count: 1, sourceType: 'instant' }, context);
    if (!mintResult.success || !mintResult.data.length) {
      return { success: false, error: 'Minting failed' };
    }

    const voucher = mintResult.data[0];
    voucher.redeemCode = code;
    this.saveLocalVoucher(voucher);

    purchase.voucherId = voucher.id;
    purchase.status = 'pending';
    this.saveLocalPurchase(purchase);

    try {
      const app = getCloudBaseApp();
      await app.database().collection('purchases').add(purchase);
    } catch { /* best effort */ }

    return { success: true, data: { purchase, voucher, redeemCode: code } };
  }

  async transfer(params: { voucherId: string; toUserId: string }, context: SkillContext) {
    const voucher = this.getLocalVoucher(params.voucherId);
    if (!voucher) return { success: false, error: 'Voucher not found' };
    if (voucher.holderId !== context.userId) return { success: false, error: 'Not the holder' };
    if (voucher.status !== 'active') return { success: false, error: `Voucher is ${voucher.status}` };

    const oldHolder = voucher.holderId;
    voucher.holderId = params.toUserId;
    voucher.status = 'transferred';
    voucher.updatedAt = Date.now();
    voucher.metadata.prevHolderId = oldHolder;
    this.saveLocalVoucher(voucher);

    try {
      const app = getCloudBaseApp();
      await app.database().collection('vouchers').where({ id: params.voucherId }).update({ holderId: params.toUserId, status: 'transferred', updatedAt: voucher.updatedAt });
    } catch { /* best effort */ }

    return { success: true, data: voucher };
  }

  async redeem(params: { redeemCode: string; gameId?: string }, context: SkillContext) {
    // 查找 purchase
    const purchases = this.getLocalPurchases().filter(p => p.redeemCode === params.redeemCode && p.status === 'pending');
    if (purchases.length === 0) return { success: false, error: 'Invalid or already used code' };
    const purchase = purchases[0];

    if (params.gameId) {
      const template = this.getLocalTemplate(purchase.templateId);
      if (template && template.gameId !== params.gameId) return { success: false, error: 'Code not valid for this game' };
    }

    purchase.status = 'redeemed';
    purchase.redeemedAt = Date.now();
    this.saveLocalPurchase(purchase);

    // 更新对应 voucher 状态
    if (purchase.voucherId) {
      const voucher = this.getLocalVoucher(purchase.voucherId);
      if (voucher) {
        voucher.status = 'destroyed';
        voucher.updatedAt = Date.now();
        this.saveLocalVoucher(voucher);
      }
    }

    try {
      const app = getCloudBaseApp();
      const db = app.database();
      await db.collection('purchases').where({ redeemCode: params.redeemCode }).update({ status: 'redeemed', redeemedAt: Date.now() });
    } catch { /* best effort */ }

    return { success: true, data: { redeemed: true, purchase } };
  }

  async getUserVouchers(_params: any, context: SkillContext) {
    const vouchers = this.getLocalVouchers().filter(v => v.holderId === context.userId && v.status === 'active');
    return { success: true, data: vouchers };
  }

  // ==================== 本地缓存 ====================

  private getLocalTemplates(): VoucherTemplate[] {
    try { return JSON.parse(localStorage.getItem('voucher_templates') || '[]'); } catch { return []; }
  }
  private getLocalTemplate(id: string): VoucherTemplate | null {
    return this.getLocalTemplates().find(t => t.id === id) || null;
  }
  private saveLocalTemplate(t: VoucherTemplate): void {
    const all = this.getLocalTemplates().filter(x => x.id !== t.id);
    all.push(t);
    localStorage.setItem('voucher_templates', JSON.stringify(all));
  }

  private getLocalVouchers(): Voucher[] {
    try { return JSON.parse(localStorage.getItem('vouchers') || '[]'); } catch { return []; }
  }
  private getLocalVoucher(id: string): Voucher | null {
    return this.getLocalVouchers().find(v => v.id === id) || null;
  }
  private saveLocalVoucher(v: Voucher): void {
    const all = this.getLocalVouchers().filter(x => x.id !== v.id);
    all.push(v);
    localStorage.setItem('vouchers', JSON.stringify(all));
  }

  private getLocalPurchases(): Purchase[] {
    try { return JSON.parse(localStorage.getItem('purchases') || '[]'); } catch { return []; }
  }
  private saveLocalPurchase(p: Purchase): void {
    const all = this.getLocalPurchases().filter(x => x.id !== p.id);
    all.push(p);
    localStorage.setItem('purchases', JSON.stringify(all));
  }
}

export const voucherSkill = new VoucherSkill();
