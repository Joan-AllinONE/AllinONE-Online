/**
 * 道具凭证服务（Voucher Item Service）
 *
 * 将游戏道具映射为凭证系统的一等公民，替代原兑换码系统。
 * 每个游戏道具 = 一个 ItemVoucherTemplate，每次铸造 = 多个 Voucher 实例。
 *
 * 双轨发行策略：
 * - LIMITED（限量型）：总量硬约束，从平台池 transfer，不可增发
 * - OPEN（开放型）：无总量约束，create_new 按需创建
 */

/**
 * 生成唯一ID（同 VoucherService 的实现）
 */
function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

import { voucherService } from '@/voucher-system';
import {
  VoucherSourceType,
  ItemSupplyPolicy,
  ItemVoucherTemplate,
  VoucherStatus,
  Voucher,
  isCurrencyVoucher,
  VoucherMetadata,
} from '@/voucher-system/types';
import { skillGateway } from '@/skills';
import { redeemCodeService } from './redeemCodeService';
import { gameDeveloperService } from './gameDeveloperService';
import { getGameDeveloperAccountId } from '@/types/gameDeveloper';
import { RedeemCode, RedeemCodeStatus, ItemType } from '@/types/redeemCode';
import {
  GameProposalType,
  ProposalStatus,
  VoteStakeholderType,
} from '@/types/gameProposal';
import type {
  GameProposal,
  GameProposalPayload,
} from '@/types/gameProposal';
import { gameProposalService } from './gameProposalService';
import { getDefaultRegistry } from '@/publishing-center/protocol/SchemaRegistry';
import { ExtensionVoucherService } from '@/publishing-center/protocol/ExtensionVoucher';
import { getDefaultEngine } from '@/publishing-center/protocol/ProtocolEngine';
import { saveVoucherToBackend, loadCollectionFromBackend } from './voucherBackend';

// ==================== 常量定义 ====================

const ITEM_TEMPLATE_STORAGE_KEY = 'voucher_item_templates';
const ITEM_PURCHASE_STORAGE_KEY = 'voucher_item_purchases';
const PLATFORM_POOL_ID = 'platform_pool';
const PLATFORM_POOL_NAME = '平台总账户';

// ==================== 类型定义 ====================

export interface ItemVoucherPurchase {
  id: string;
  userId: string;
  userName: string;
  templateId: string;
  voucherId: string;
  gameId: string;
  quantity: number;
  price: number;
  currency: string;
  status: 'pending' | 'redeemed' | 'expired';
  paidAt: number;
  redeemedAt?: number;
  redeemCode?: string;          // 兑换码（供玩家在游戏中输入）
  note?: string;
}

export interface MintItemVouchersRequest {
  gameId: string;
  templateId: string;
  count: number;
  recipientId?: string;
  recipientName?: string;
}

export interface PurchaseItemVoucherRequest {
  userId: string;
  userName: string;
  gameId: string;
  templateId: string;
  paymentMethod?: 'wallet' | 'voucher';
  /** 覆盖支付币种（默认从模板 pricing.currency 推导） */
  paymentCurrency?: string;
}

export interface RedeemItemVoucherRequest {
  userId: string;
  userName: string;
  voucherId: string;
  gameId: string;
}

// ==================== 存储工具 ====================

function loadTemplates(): ItemVoucherTemplate[] {
  try {
    const raw = localStorage.getItem(ITEM_TEMPLATE_STORAGE_KEY);
    const data = raw ? JSON.parse(raw) : [];
    if (!_templatesCloudSyncInitiated) {
      _templatesCloudSyncInitiated = true;
      // Bug 013 修复：读取改分页 + 后端 API 兜底，绝不保留 limit(500) 硬截断
      loadCollectionFromBackend<ItemVoucherTemplate>('voucher_templates').then(cloud => {
        if (cloud.length === 0) return;
        const freshRaw = localStorage.getItem(ITEM_TEMPLATE_STORAGE_KEY);
        const fresh: ItemVoucherTemplate[] = freshRaw ? JSON.parse(freshRaw) : [];
        // ✅ 后端数据覆盖本地同名 ID（云端为准）
        const cloudMap = new Map(cloud.map(d => [d.id, d]));
        const localOnly = fresh.filter(t => !cloudMap.has(t.id));
        const merged = [...cloud, ...localOnly];
        localStorage.setItem(ITEM_TEMPLATE_STORAGE_KEY, JSON.stringify(merged));
        window.dispatchEvent(new CustomEvent('templates-list-updated'));
      }).catch(() => {});
    }
    return data;
  } catch {
    return [];
  }
}

let _templatesCloudSyncInitiated = false;

function saveTemplates(templates: ItemVoucherTemplate[]): void {
  localStorage.setItem(ITEM_TEMPLATE_STORAGE_KEY, JSON.stringify(templates));
  syncTemplatesToCloud(templates);
}

function syncTemplatesToCloud(templates: ItemVoucherTemplate[]): void {
  // Bug 013 修复：写入改走 gamesApi 云函数（写入路径弃用 writeQueue）
  for (const t of templates) {
    saveVoucherToBackend('voucher_templates', t as any).catch(() => {});
  }
}

function loadPurchases(): ItemVoucherPurchase[] {
  try {
    const raw = localStorage.getItem(ITEM_PURCHASE_STORAGE_KEY);
    const data = raw ? JSON.parse(raw) : [];
    if (!_purchasesCloudSyncInitiated) {
      _purchasesCloudSyncInitiated = true;
      // Bug 013 修复：读取改分页 + 后端 API 兜底，绝不保留 limit(500) 硬截断
      loadCollectionFromBackend<ItemVoucherPurchase>('purchases').then(cloud => {
        if (cloud.length === 0) return;
        const freshRaw = localStorage.getItem(ITEM_PURCHASE_STORAGE_KEY);
        const fresh: ItemVoucherPurchase[] = freshRaw ? JSON.parse(freshRaw) : [];
        // ✅ 后端数据覆盖本地同名 ID（云端为准）
        const cloudMap = new Map(cloud.map(d => [d.id, d]));
        const localOnly = fresh.filter(p => !cloudMap.has(p.id));
        const merged = [...cloud, ...localOnly];
        localStorage.setItem(ITEM_PURCHASE_STORAGE_KEY, JSON.stringify(merged));
        window.dispatchEvent(new CustomEvent('purchases-list-updated'));
      }).catch(() => {});
    }
    return data;
  } catch {
    return [];
  }
}

let _purchasesCloudSyncInitiated = false;

function savePurchases(purchases: ItemVoucherPurchase[]): void {
  localStorage.setItem(ITEM_PURCHASE_STORAGE_KEY, JSON.stringify(purchases));
  syncPurchasesToCloud(purchases);
}

function syncPurchasesToCloud(purchases: ItemVoucherPurchase[]): void {
  // Bug 013 修复：写入改走 gamesApi 云函数（写入路径弃用 writeQueue）
  for (const p of purchases) {
    saveVoucherToBackend('purchases', p as any).catch(() => {});
  }
}

// ==================== 服务类 ====================

class VoucherItemService {
  // ============ 模板管理 ============

  /**
   * 创建道具模板（游戏方配置道具）
   */
  createItemTemplate(template: Omit<ItemVoucherTemplate, 'id' | 'createdAt' | 'updatedAt' | 'mintedCount'>): ItemVoucherTemplate {
    const templates = loadTemplates();
    const now = Date.now();

    const newTemplate: ItemVoucherTemplate = {
      ...template,
      id: `item-tpl-${generateUUID().slice(0, 8)}`,
      mintedCount: 0,
      createdAt: now,
      updatedAt: now,
    };

    templates.push(newTemplate);
    saveTemplates(templates);
    console.log(`[VoucherItem] 创建道具模板: ${newTemplate.name} (${newTemplate.id}), 策略: ${newTemplate.supplyPolicy}`);
    return newTemplate;
  }

  /**
   * 获取游戏的所有道具模板
   */
  getItemTemplates(gameId: string): ItemVoucherTemplate[] {
    return loadTemplates().filter(t => t.gameId === gameId && t.isActive);
  }

  /**
   * 获取单个道具模板
   */
  getItemTemplate(templateId: string): ItemVoucherTemplate | undefined {
    return loadTemplates().find(t => t.id === templateId);
  }

  /**
   * 更新道具模板
   */
  updateItemTemplate(templateId: string, updates: Partial<ItemVoucherTemplate>): ItemVoucherTemplate | undefined {
    const templates = loadTemplates();
    const index = templates.findIndex(t => t.id === templateId);
    if (index === -1) return undefined;

    templates[index] = { ...templates[index], ...updates, updatedAt: Date.now() };
    saveTemplates(templates);
    return templates[index];
  }

  /**
   * 删除道具模板（软删除）
   */
  removeItemTemplate(templateId: string): boolean {
    const template = this.getItemTemplate(templateId);
    if (!template) return false;
    return !!this.updateItemTemplate(templateId, { isActive: false });
  }

  // ============ 铸造管理 ============

  /**
   * 铸造道具凭证（生成 N 张凭证）
   * - LIMITED 类型：凭证创建到平台总账户，总量不可超
   * - OPEN 类型：仅记录数量，凭证按需创建
   */
  mintItemVouchers(request: MintItemVouchersRequest): { success: boolean; vouchers: Voucher[]; message: string } {
    const template = this.getItemTemplate(request.templateId);
    if (!template) {
      return { success: false, vouchers: [], message: '道具模板不存在' };
    }

    // 检查 LIMITED 类型的总量限制
    if (template.supplyPolicy === ItemSupplyPolicy.LIMITED && template.totalSupply) {
      const remaining = template.totalSupply - template.mintedCount;
      if (request.count > remaining) {
        return {
          success: false,
          vouchers: [],
          message: `限量道具 ${template.name} 剩余可铸造 ${remaining} 个，请求 ${request.count} 个`,
        };
      }
    }

    const recipientId = request.recipientId || PLATFORM_POOL_ID;
    const recipientName = request.recipientName || PLATFORM_POOL_NAME;

    // 构建凭证元数据
    const metadata: VoucherMetadata = {
      sourceType: VoucherSourceType.ITEM, // 确保 VoucherService 能正确设置来源类型
      name: template.name,
      description: template.description,
      category: 'item',
      tags: ['item_voucher', template.gameId, template.itemType],
      issuer: template.gameId,
      customData: {
        itemTemplateId: template.id,
        gameId: template.gameId,
        gameEffect: template.gameEffect,
        itemType: template.itemType,
        rarity: template.rarity,
        attributes: template.attributes,
        consumable: template.consumable,
        stackable: template.stackable,
        imageUrl: template.imageUrl,
        supplyPolicy: template.supplyPolicy,
        totalSupply: template.totalSupply,
      },
    };

    // 批量创建凭证
    const vouchers: Voucher[] = [];
    for (let i = 0; i < request.count; i++) {
      try {
        const voucher = voucherService.createVoucher(
          {
            denomination: template.pricing.price, // 道具凭证的价值
            recipientId,
            recipientName,
            metadata,
            note: `铸造道具凭证: ${template.name}`,
          },
          'SYSTEM',
          '道具凭证系统'
        );

        // 强制设置 sourceType = ITEM
        (voucher as any).sourceType = VoucherSourceType.ITEM;

        vouchers.push(voucher);
      } catch (error) {
        console.error(`[VoucherItem] 铸造第 ${i + 1} 张凭证失败:`, error);
      }
    }

    // 更新模板铸造计数
    this.updateItemTemplate(request.templateId, {
      mintedCount: template.mintedCount + vouchers.length,
    });

    // 🆕 如果铸造给特定用户（非平台池），异步为每张凭证生成兑换码
    const isDirectToUser = request.recipientId && request.recipientId !== PLATFORM_POOL_ID;
    if (isDirectToUser && vouchers.length > 0) {
      this.generateRedeemCodesForMintedVouchers(template, vouchers, request.recipientId!, request.recipientName);
    }

    console.log(`[VoucherItem] 铸造完成: ${template.name} x ${vouchers.length} 张`);
    return {
      success: vouchers.length > 0,
      vouchers,
      message: `成功铸造 ${vouchers.length} 张道具凭证`,
    };
  }

  /**
   * 🆕 为铸造给用户的凭证异步生成兑换码
   * 不影响铸造主流程，失败仅记录日志
   */
  private async generateRedeemCodesForMintedVouchers(
    template: ItemVoucherTemplate,
    vouchers: Voucher[],
    recipientId: string,
    recipientName?: string,
  ): Promise<void> {
    try {
      const hostedItems = redeemCodeService.getHostedItems(template.gameId);
      let hostedItem = hostedItems.find(
        h => h.name === template.name && h.gameId === template.gameId
      );

      if (!hostedItem) {
        hostedItem = await redeemCodeService.createHostedItem({
          gameId: template.gameId,
          name: template.name,
          description: template.description || '',
          type: (template.itemType === 'permanent' ? ItemType.PERMANENT : ItemType.CONSUMABLE) as ItemType,
          codeConfig: {
            prefix: 'IV-',
            length: 8,
            charset: 'alphanumeric',
            caseSensitive: false,
            singleUse: true,
          },
          initialInventory: 0,
          pricing: {
            price: template.pricing.price,
            currency: template.pricing.currency,
          },
          gameEffect: {
            itemId: template.gameEffect.itemId || template.gameEffect.schemaName || 'ugc-item',
            quantity: template.gameEffect.quantity,
            metadata: template.gameEffect.metadata,
            // 保留 Schema 信息，确保 GamePlay.tsx 能发送 EXTENSION_VOUCHER
            schemaName: template.gameEffect.schemaName,
            itemData: template.gameEffect.itemData,
          },
        });
      }

      // 为每张凭证生成兑换码
      const allCodes = redeemCodeService.getAllCodes();
      const existingCodes = new Set(allCodes.map(c => c.code.toUpperCase()));
      const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

      for (const voucher of vouchers) {
        for (let attempt = 0; attempt < 100; attempt++) {
          const randomPart = Array.from({ length: 8 }, () =>
            CHARS[Math.floor(Math.random() * CHARS.length)]
          ).join('');
          const testCode = `IV-${randomPart}`;
          if (!existingCodes.has(testCode.toUpperCase())) {
            const newCode: RedeemCode = {
              id: `code-${generateUUID().slice(0, 8)}`,
              code: testCode,
              gameId: template.gameId,
              itemId: hostedItem.id,
              status: RedeemCodeStatus.SOLD,
              createdAt: new Date().toISOString(),
              soldAt: new Date().toISOString(),
              soldTo: recipientId,
              verifyCount: 0,
            };
            allCodes.push(newCode);
            existingCodes.add(testCode.toUpperCase());
            // 将兑换码关联到购买记录
            const purchase: ItemVoucherPurchase = {
              id: `purchase-${generateUUID().slice(0, 8)}`,
              userId: recipientId,
              userName: recipientName || '玩家',
              templateId: template.id,
              voucherId: voucher.id,
              gameId: template.gameId,
              quantity: 1,
              price: template.pricing.price,
              currency: template.pricing.currency,
              status: 'pending',
              paidAt: Date.now(),
              redeemCode: testCode,
              note: `道具工坊直接铸造`,
            };
            const purchases = loadPurchases();
            purchases.push(purchase);
            savePurchases(purchases);
            break;
          }
        }
      }
      localStorage.setItem('allinone_redeem_codes', JSON.stringify(allCodes));
      console.log(`[VoucherItem] 已为 ${vouchers.length} 张凭证生成兑换码`);
    } catch (e) {
      console.warn('[VoucherItem] 生成兑换码失败（不影响铸造）:', e);
    }
  }

  /**
   * 获取平台池中指定模板的道具凭证数量
   */
  getPoolItemVoucherCount(templateId: string): number {
    const allVouchers = voucherService.getUserVouchers(PLATFORM_POOL_ID);
    return allVouchers.filter(v =>
      v.status === VoucherStatus.ACTIVE &&
      (v as any).sourceType === VoucherSourceType.ITEM &&
      v.metadata?.customData?.itemTemplateId === templateId
    ).length;
  }

  // ============ 购买流程 ============

  /**
   * 购买道具凭证
   * - wallet 支付：从钱包扣款
   * - voucher 支付：从用户凭证扣款（调用 voucherPaymentService）
   * - 成功后，道具凭证转移到用户
   */
  async purchaseItemVoucher(request: PurchaseItemVoucherRequest): Promise<{
    success: boolean;
    purchase?: ItemVoucherPurchase;
    voucher?: Voucher;
    redeemCode?: string;
    message: string;
  }> {
    const template = this.getItemTemplate(request.templateId);
    if (!template) {
      return { success: false, message: '道具模板不存在' };
    }

    // 检查是否有可用凭证
    // 强制约束：如果没有可用的道具凭证，不允许购买，提示先铸造
    const availableVouchers = voucherService.getUserVouchers(PLATFORM_POOL_ID)
      .filter(v =>
        v.status === VoucherStatus.ACTIVE &&
        (v as any).sourceType === VoucherSourceType.ITEM &&
        v.metadata?.customData?.itemTemplateId === request.templateId
      );

    if (availableVouchers.length === 0) {
      return { success: false, message: `「${template.name}」当前无可用库存，请先到「道具凭证管理」中进行铸造后再购买` };
    }

    // 扣款
    const price = template.pricing.price;
    // 使用传入的支付币种，否则从模板 pricing 推导
    const targetCurrency = request.paymentCurrency
      || (template.pricing.currency === 'ACOIN' ? 'aCoins' : template.pricing.currency);

    try {
      if (request.paymentMethod === 'voucher' && template.pricing.acceptVoucher !== false) {
        // ===== 凭证支付 =====
        const voucherPrice = template.pricing.voucherPrice || price;

        // 仅选取 A币类型凭证（排除道具凭证），确保余额计算准确
        const userAcoinVouchers = voucherService.getUserVouchers(request.userId)
          .filter(v => v.status === VoucherStatus.ACTIVE && isCurrencyVoucher((v as any).sourceType))
          .sort((a, b) => a.denomination - b.denomination);

        const currentBalance = userAcoinVouchers.reduce((sum, v) => sum + v.denomination, 0);

        // 明确余额不足提示
        if (currentBalance < voucherPrice) {
          if (currentBalance === 0) {
            return {
              success: false,
              message: `A币凭证余额为 0，无法支付「${template.name}」（需要 ${voucherPrice} A币）。请获取A币凭证或切换为「游戏币支付」`,
            };
          }
          return {
            success: false,
            message: `A币凭证余额不足：当前 ${currentBalance} A币，需要 ${voucherPrice} A币，还差 ${voucherPrice - currentBalance} A币`,
          };
        }

        // 凑单：从小到大选取凭证，直到覆盖价格
        let totalSelected = 0;
        const selectedVouchers: Voucher[] = [];
        for (const v of userAcoinVouchers) {
          selectedVouchers.push(v);
          totalSelected += v.denomination;
          if (totalSelected >= voucherPrice) break;
        }

        // 转移用户凭证到游戏商账户（game-{gameId}）
        const developerAccountId = getGameDeveloperAccountId(request.gameId);
        for (const v of selectedVouchers) {
          voucherService.transferVoucher(
            {
              voucherId: v.id,
              toUserId: developerAccountId,
              toUserName: `${template.gameName || '游戏'} 开发者`,
              note: `购买道具凭证: ${template.name}`,
            },
            request.userId,
            request.userName
          );
        }

        // 🆕 记录收入到游戏开发者账户
        await gameDeveloperService.recordPurchaseRevenue({
          gameId: request.gameId,
          gameName: template.gameName || '游戏',
          amount: voucherPrice,
          itemName: template.name,
          templateId: request.templateId,
          buyerId: request.userId,
          buyerName: request.userName,
        });

        // 找零（由开发者账户铸造）
        const change = totalSelected - voucherPrice;
        if (change > 0) {
          voucherService.createVoucher(
            {
              denomination: change,
              recipientId: request.userId,
              recipientName: request.userName,
              metadata: {
                name: '购物找零',
                description: `购买 ${template.name} 的找零`,
                category: 'change',
              },
              note: '凭证支付找零',
            },
            developerAccountId,
            `${template.gameName || '游戏'} 开发者`
          );
        }
      } else if (request.paymentMethod === 'wallet') {
        // ===== 钱包支付 =====
        const spendResult = await skillGateway.execute('wallet', 'spend', {
          currency: targetCurrency,
          amount: price,
          description: `购买道具凭证: ${template.name}`,
        }, { userId: request.userId, sessionId: 'web' });

        if (!spendResult.success) {
          return { success: false, message: spendResult.error?.message || '支付失败' };
        }

        // 🆕 记录收入到游戏开发者账户
        await gameDeveloperService.recordPurchaseRevenue({
          gameId: request.gameId,
          gameName: template.gameName || '游戏',
          amount: price,
          itemName: template.name,
          templateId: request.templateId,
          buyerId: request.userId,
          buyerName: request.userName,
        });
      } else {
        // 用户选了凭证支付但模板未启用凭证 → 明确报错，不静默降级扣游戏币
        return { success: false, message: `「${template.name}」未启用凭证支付，请切换为游戏币支付后重试` };
      }

      // 转移道具凭证给用户
      const targetVoucher = availableVouchers[0];
      voucherService.transferVoucher(
        {
          voucherId: targetVoucher.id,
          toUserId: request.userId,
          toUserName: request.userName,
          note: `购买道具: ${template.name}`,
        },
        PLATFORM_POOL_ID,
        PLATFORM_POOL_NAME
      );

      // ===== 生成兑换码（兼容旧系统 verifyCode 接口） =====
      let redeemCodeStr: string | undefined;
      try {
        const hostedItems = redeemCodeService.getHostedItems(request.gameId);
        let hostedItem = hostedItems.find(
          h => h.name === template.name && h.gameId === request.gameId
        );

        // 没有则创建新的托管道具记录
        if (!hostedItem) {
          hostedItem = await redeemCodeService.createHostedItem({
            gameId: request.gameId,
            name: template.name,
            description: template.description || '',
            type: (template.itemType === 'permanent' ? ItemType.PERMANENT : ItemType.CONSUMABLE) as ItemType,
            codeConfig: {
              prefix: 'IV-',
              length: 8,
              charset: 'alphanumeric',
              caseSensitive: false,
              singleUse: true,
            },
            initialInventory: 0,
            pricing: {
              price: template.pricing.price,
              currency: template.pricing.currency,
            },
            gameEffect: {
              itemId: template.gameEffect.itemId || template.gameEffect.schemaName || 'ugc-item',
              quantity: template.gameEffect.quantity,
              metadata: template.gameEffect.metadata,
              // 保留 Schema 信息，确保 GamePlay.tsx 能发送 EXTENSION_VOUCHER
              schemaName: template.gameEffect.schemaName,
              itemData: template.gameEffect.itemData,
            },
          });
        }

        // 生成唯一兑换码字符串
        const allCodes = redeemCodeService.getAllCodes();
        const existingCodes = new Set(allCodes.map(c => c.code.toUpperCase()));
        const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

        for (let attempt = 0; attempt < 100; attempt++) {
          const randomPart = Array.from({ length: 8 }, () =>
            CHARS[Math.floor(Math.random() * CHARS.length)]
          ).join('');
          const testCode = `IV-${randomPart}`;
          if (!existingCodes.has(testCode.toUpperCase())) {
            const newCode: RedeemCode = {
              id: `code-${generateUUID().slice(0, 8)}`,
              code: testCode,
              gameId: request.gameId,
              itemId: hostedItem.id,
              status: RedeemCodeStatus.SOLD,
              createdAt: new Date().toISOString(),
              soldAt: new Date().toISOString(),
              soldTo: request.userId,
              verifyCount: 0,
            };
            allCodes.push(newCode);
            localStorage.setItem('allinone_redeem_codes', JSON.stringify(allCodes));
            redeemCodeStr = testCode;
            break;
          }
        }
      } catch (e) {
        console.warn('[VoucherItemService] 生成兑换码失败（不影响购买）:', e);
      }
      // ===== 兑换码生成结束 =====

      // 记录购买
      const purchase: ItemVoucherPurchase = {
        id: `purchase-${generateUUID().slice(0, 8)}`,
        userId: request.userId,
        userName: request.userName,
        templateId: request.templateId,
        voucherId: targetVoucher.id,
        gameId: request.gameId,
        quantity: 1,
        price,
        currency: template.pricing.currency,
        status: 'pending',
        paidAt: Date.now(),
        redeemCode: redeemCodeStr,
        note: `购买 ${template.name}`,
      };

      const purchases = loadPurchases();
      purchases.push(purchase);
      savePurchases(purchases);

      return {
        success: true,
        purchase,
        voucher: targetVoucher,
        redeemCode: redeemCodeStr,
        message: `成功购买 ${template.name}${redeemCodeStr ? `，兑换码: ${redeemCodeStr}` : ''}`,
      };
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : '购买失败',
      };
    }
  }

  // ============ 兑换流程 ============

  /**
   * 兑换道具凭证到游戏
   * 将用户的道具凭证标记为已兑换，并返回游戏所需信息
   */
  redeemItemVoucher(request: RedeemItemVoucherRequest): {
    success: boolean;
    message: string;
    gameInfo?: { itemId?: string; schemaName?: string; itemData?: Record<string, any>; quantity: number; metadata?: Record<string, any> };
    /** Schema 模式下是否已下发到游戏 */
    dispatchedToGame?: boolean;
  } {
    // 检查凭证
    const voucher = voucherService.getVoucherById(request.voucherId);
    if (!voucher) {
      return { success: false, message: '凭证不存在' };
    }

    if (voucher.currentHolderId !== request.userId) {
      return { success: false, message: '您不是该凭证的持有者' };
    }

    if (voucher.status !== VoucherStatus.ACTIVE) {
      return { success: false, message: '凭证不可用' };
    }

    const sourceType = (voucher as any).sourceType;
    if (sourceType !== VoucherSourceType.ITEM) {
      return { success: false, message: '该凭证不是道具凭证' };
    }

    const customData = voucher.metadata?.customData;
    if (!customData?.gameId || !customData?.gameEffect) {
      return { success: false, message: '凭证缺少游戏信息' };
    }

    const gameEffect = customData.gameEffect;

    // === 模式判断：Schema 模式 vs 传统模式 ===
    if (gameEffect.schemaName && gameEffect.itemData) {
      // Schema 模式——通过 ProtocolEngine 下发到游戏
      return this.redeemItemVoucherBySchema(request);
    }

    // 传统模式——返回 itemId
    // 统一标记凭证为已使用（REDEEMED），保留在用户记录中
    voucherService.redeemVoucher(
      request.voucherId,
      request.userId,
      request.userName,
      `兑换道具: ${voucher.metadata?.name || '未知'} → ${customData.gameId}`
    );

    // 更新购买记录
    const purchases = loadPurchases();
    const purchaseIndex = purchases.findIndex(p => p.voucherId === request.voucherId);
    if (purchaseIndex >= 0) {
      purchases[purchaseIndex].status = 'redeemed';
      purchases[purchaseIndex].redeemedAt = Date.now();
      savePurchases(purchases);
    }

    const gameInfo = {
      itemId: gameEffect.itemId,
      quantity: gameEffect.quantity,
      metadata: gameEffect.metadata,
    };

    return {
      success: true,
      message: `已使用 ${voucher.metadata?.name}，该凭证已标记为已使用`,
      gameInfo,
    };
  }

  /**
   * 🆕 Schema 模式兑换：将道具凭证下发到游戏运行时
   *
   * 通过 ProtocolEngine.issueVoucher() 将道具数据 postMessage 到游戏 iframe。
   * 游戏端 ProtocolClient.on('voucher') 接收后，调用 ItemFactory 动态创建道具。
   *
   * 与传统 redeemItemVoucher 的区别：
   * - 传统：验证 itemId → 标记凭证已使用
   * - Schema 模式：验证 schemaName → ProtocolEngine 下发 → 标记已使用
   */
  redeemItemVoucherBySchema(request: RedeemItemVoucherRequest): {
    success: boolean;
    message: string;
    gameInfo?: { schemaName?: string; itemData?: Record<string, any>; quantity: number; metadata?: Record<string, any> };
    dispatchedToGame?: boolean;
  } {
    // 基础验证
    const voucher = voucherService.getVoucherById(request.voucherId);
    if (!voucher) {
      return { success: false, message: '凭证不存在' };
    }

    if (voucher.currentHolderId !== request.userId) {
      return { success: false, message: '您不是该凭证的持有者' };
    }

    if (voucher.status !== VoucherStatus.ACTIVE) {
      return { success: false, message: '凭证不可用' };
    }

    const sourceType = (voucher as any).sourceType;
    if (sourceType !== VoucherSourceType.ITEM) {
      return { success: false, message: '该凭证不是道具凭证' };
    }

    const customData = voucher.metadata?.customData;
    if (!customData?.gameId || !customData?.gameEffect) {
      return { success: false, message: '凭证缺少游戏信息' };
    }

    const gameEffect = customData.gameEffect;
    const { schemaName, itemData } = gameEffect;

    // 校验 Schema 注册
    const registry = getDefaultRegistry();
    const schema = registry.getSchema(schemaName);
    if (!schema) {
      return { success: false, message: `Schema "${schemaName}" 未注册，请联系游戏开发者` };
    }

    // 生成扩展凭证
    const extensionVoucher = ExtensionVoucherService.create({
      schemaName,
      sourceGameId: customData.gameId,
      targetGameId: request.gameId,
      data: itemData,
      signature: ExtensionVoucherService.sign(itemData),
      expiresIn: 365 * 24 * 60 * 60 * 1000, // 1年有效
    });

    // 通过协议引擎下发给游戏（sendToGame 是同步方法，直接调用可避免 Promise 包裹）
    const protocolEngine = getDefaultEngine();
    const dispatched = protocolEngine.sendToGame(request.gameId, {
      type: 'EXTENSION_VOUCHER',
      voucher: ExtensionVoucherService.toPayload(extensionVoucher),
      timestamp: Date.now(),
    });

    if (!dispatched) {
      return { success: false, message: '游戏通道不可用，请确认游戏正在运行' };
    }

    // 标记凭证已使用
    voucherService.redeemVoucher(
      request.voucherId,
      request.userId,
      request.userName,
      `Schema兑换: ${schemaName} → ${customData.gameId}`
    );

    // 更新购买记录
    const purchases = loadPurchases();
    const purchaseIndex = purchases.findIndex(p => p.voucherId === request.voucherId);
    if (purchaseIndex >= 0) {
      purchases[purchaseIndex].status = 'redeemed';
      purchases[purchaseIndex].redeemedAt = Date.now();
      savePurchases(purchases);
    }

    const gameInfo = {
      schemaName,
      itemData,
      quantity: gameEffect.quantity,
      metadata: gameEffect.metadata,
    };

    console.log(`[VoucherItem] ✅ Schema 兑换成功: ${schemaName} → ${request.gameId}, 道具: ${itemData?.name || '未知'}`);

    return {
      success: true,
      message: `道具「${itemData?.name || schemaName}」已发送到游戏，即刻生效！`,
      gameInfo,
      dispatchedToGame: true,
    };
  }

  // ============ 查询方法 ============

  /**
   * 获取用户的道具凭证
   */
  getUserItemVouchers(userId: string, gameId?: string): Voucher[] {
    const allVouchers = voucherService.getUserVouchers(userId);
    return allVouchers.filter(v => {
      const sourceType = (v as any).sourceType;
      if (sourceType !== VoucherSourceType.ITEM) return false;
      if (gameId && v.metadata?.customData?.gameId !== gameId) return false;
      return true;
    });
  }

  /**
   * 获取用户的购买记录
   */
  getUserPurchases(userId: string, gameId?: string): ItemVoucherPurchase[] {
    return loadPurchases().filter(p => {
      if (p.userId !== userId) return false;
      if (gameId && p.gameId !== gameId) return false;
      return true;
    });
  }

  /**
   * 获取游戏的所有购买记录
   */
  getGamePurchases(gameId: string): ItemVoucherPurchase[] {
    return loadPurchases().filter(p => p.gameId === gameId);
  }

  /**
   * 获取所有游戏中道具模板的总览
   */
  getGameItemOverview(gameId: string): {
    templateCount: number;
    totalMinted: number;
    totalSold: number;
    totalRedeemed: number;
    templates: ItemVoucherTemplate[];
  } {
    const templates = this.getItemTemplates(gameId);
    const purchases = this.getGamePurchases(gameId);

    return {
      templateCount: templates.length,
      totalMinted: templates.reduce((sum, t) => sum + t.mintedCount, 0),
      totalSold: purchases.length,
      totalRedeemed: purchases.filter(p => p.status === 'redeemed').length,
      templates,
    };
  }

  /**
   * 分配一个道具凭证的兑换链接（用于生成游戏入口）
   */
  getRedeemUrl(voucherId: string, gameUrl: string): string {
    const url = new URL(gameUrl, window.location.origin);
    url.searchParams.set('itemVoucher', voucherId);
    return url.toString();
  }

  // ============ 投票治理 - 道具提案 ============

  /**
   * 🆕 发起道具发布提案（替代直接创建）
   * 通过投票治理流程，而非直接创建道具模板
   */
  proposeNewItem(params: {
    gameId: string;
    gameName: string;
    template: Omit<ItemVoucherTemplate, 'id' | 'createdAt' | 'updatedAt' | 'mintedCount'>;
    proposerId: string;
    proposerName: string;
    proposerType: VoteStakeholderType;
    reason: string;
    voteDurationHours?: number;
    whitelist?: string[];
    revenueSharing?: { gameShare: number; platformShare: number; creatorShare?: number };
  }): GameProposal {
    const payload: GameProposalPayload = {
      proposalType: GameProposalType.NEW_ITEM,
      itemTemplate: {
        name: params.template.name,
        description: params.template.description,
        itemType: params.template.itemType,
        rarity: params.template.rarity || 'common',
        pricing: { price: params.template.pricing.price, currency: params.template.pricing.currency },
        gameEffect: {
          itemId: params.template.gameEffect.itemId || params.template.gameEffect.schemaName || '',
          quantity: params.template.gameEffect.quantity,
          // 🆕 Schema 模式字段直通
          schemaName: params.template.gameEffect.schemaName,
          itemData: params.template.gameEffect.itemData,
          schemaVersion: params.template.gameEffect.schemaVersion,
        },
        supplyPolicy: params.template.supplyPolicy === ItemSupplyPolicy.LIMITED ? 'limited' : 'open',
        totalSupply: params.template.totalSupply,
        mintCount: 100, // 默认初始铸造100张
      },
    };

    return gameProposalService.createProposal({
      gameId: params.gameId,
      gameName: params.gameName,
      title: `【道具发布】${params.template.name}`,
      description: `发布新道具「${params.template.name}」：${params.template.description}`,
      reason: params.reason,
      proposalType: GameProposalType.NEW_ITEM,
      payload,
      proposerId: params.proposerId,
      proposerName: params.proposerName,
      proposerType: params.proposerType,
      voteDurationHours: params.voteDurationHours,
      whitelist: params.whitelist,
      revenueSharing: params.revenueSharing,
    });
  }

  /**
   * 🆕 发起道具铸造提案
   */
  proposeMintVouchers(params: {
    gameId: string;
    gameName: string;
    templateId: string;
    templateName: string;
    count: number;
    reason: string;
    proposerId: string;
    proposerName: string;
    proposerType: VoteStakeholderType;
    voteDurationHours?: number;
    whitelist?: string[];
  }): GameProposal {
    // 铸造提案前置校验：限量道具不可超发
    const template = this.getItemTemplate(params.templateId);
    if (template && template.supplyPolicy === 'limited' && template.totalSupply) {
      const remaining = Math.max(0, template.totalSupply - template.mintedCount);
      if (params.count > remaining) {
        throw new Error(
          `限量道具「${template.name}」剩余可铸造 ${remaining} 张，无法发起铸造 ${params.count} 张的提案`,
        );
      }
    }

    const payload: GameProposalPayload = {
      proposalType: GameProposalType.MINT_ITEM,
      mintData: {
        templateId: params.templateId,
        templateName: params.templateName,
        count: params.count,
      },
    };

    return gameProposalService.createProposal({
      gameId: params.gameId,
      gameName: params.gameName,
      title: `【铸造凭证】${params.templateName} x ${params.count}`,
      description: `为道具「${params.templateName}」铸造 ${params.count} 张凭证`,
      reason: params.reason,
      proposalType: GameProposalType.MINT_ITEM,
      payload,
      proposerId: params.proposerId,
      proposerName: params.proposerName,
      proposerType: params.proposerType,
      voteDurationHours: params.voteDurationHours,
      whitelist: params.whitelist,
    });
  }

  /**
   * 🆕 执行已通过的道具提案
   * 根据提案类型执行相应的道具操作（创建模板/铸造凭证等）
   */
  executeApprovedProposal(proposalId: string): {
    success: boolean;
    message: string;
    template?: ItemVoucherTemplate;
    vouchers?: Voucher[];
  } {
    const proposal = gameProposalService.getProposal(proposalId);
    if (!proposal) {
      return { success: false, message: '提案不存在' };
    }

    if (proposal.status !== ProposalStatus.PASSED) {
      return { success: false, message: '只有已通过的提案才能执行' };
    }

    try {
      // 根据提案类型执行不同操作
      if (proposal.proposalType === GameProposalType.NEW_ITEM && proposal.payload.itemTemplate) {
        const tmpl = proposal.payload.itemTemplate;
        const newTemplate = this.createItemTemplate({
          gameId: proposal.gameId,
          gameName: proposal.gameName,
          name: tmpl.name,
          description: tmpl.description,
          itemType: tmpl.itemType,
          icon: 'fa-box',
          supplyPolicy: tmpl.supplyPolicy === 'limited' ? ItemSupplyPolicy.LIMITED : ItemSupplyPolicy.OPEN,
          totalSupply: tmpl.totalSupply,
          pricing: {
            price: tmpl.pricing.price,
            currency: tmpl.pricing.currency,
            acceptVoucher: true,
            voucherPrice: tmpl.pricing.price,
          },
          gameEffect: {
            itemId: tmpl.gameEffect.itemId,
            quantity: tmpl.gameEffect.quantity || 1,
            // 🆕 Schema 模式字段直通
            schemaName: (tmpl.gameEffect as any).schemaName,
            itemData: (tmpl.gameEffect as any).itemData,
            schemaVersion: (tmpl.gameEffect as any).schemaVersion,
            metadata: {},
          },
          rarity: tmpl.rarity,
          consumable: tmpl.itemType === 'consumable',
          stackable: true,
          isActive: true,
          createdBy: proposal.proposerId,
          // 🆕 标记来源
          source: (tmpl as any).source || 'developer',
        });

        // 自动铸造初始库存
        const mintCount = tmpl.mintCount || 100;
        const mintResult = this.mintItemVouchers({
          gameId: proposal.gameId,
          templateId: newTemplate.id,
          count: mintCount,
        });

        // 标记为已执行
        gameProposalService.executeProposal(proposalId);

        return {
          success: true,
          message: `已创建道具「${newTemplate.name}」并铸造 ${mintCount} 张凭证`,
          template: newTemplate,
          vouchers: mintResult.vouchers,
        };

      } else if (proposal.proposalType === GameProposalType.MINT_ITEM && proposal.payload.mintData) {
        const mintData = proposal.payload.mintData;
        const mintResult = this.mintItemVouchers({
          gameId: proposal.gameId,
          templateId: mintData.templateId,
          count: mintData.count,
        });

        gameProposalService.executeProposal(proposalId);

        return {
          success: mintResult.success,
          message: mintResult.message,
          vouchers: mintResult.vouchers,
        };
      }

      // 对于其他类型（配置修改/内容修改等），标记为已执行
      gameProposalService.executeProposal(proposalId);
      return { success: true, message: '提案已执行' };

    } catch (error) {
      const errMsg = error instanceof Error ? error.message : '执行失败';
      gameProposalService.markExecutionFailed(proposalId, errMsg);
      return { success: false, message: errMsg };
    }
  }

  /**
   * 🆕 通用提案执行器（按类型分发）
   * 处理所有 GameProposalType 的执行逻辑
   */
  executeProposalByType(proposal: GameProposal): { success: boolean; message: string } {
    switch (proposal.proposalType) {
      case GameProposalType.NEW_ITEM:
      case GameProposalType.MINT_ITEM: {
        const result = this.executeApprovedProposal(proposal.id);
        return { success: result.success, message: result.message };
      }
      case GameProposalType.EDIT_ITEM: {
        // 修改道具属性 → 更新现有模板
        if (proposal.payload.itemTemplate) {
          const tmpl = proposal.payload.itemTemplate;
          const templates = this.getItemTemplates(proposal.gameId);
          const existing = templates.find(t => t.name === tmpl.name);
          if (existing) {
            this.updateItemTemplate(existing.id, {
              description: tmpl.description,
              pricing: {
                price: tmpl.pricing.price,
                currency: tmpl.pricing.currency,
                acceptVoucher: true,
                voucherPrice: tmpl.pricing.price,
              },
              rarity: tmpl.rarity,
            });
          }
        }
        gameProposalService.executeProposal(proposal.id);
        return { success: true, message: '道具属性已更新' };
      }
      case GameProposalType.DELETE_ITEM: {
        // 下架道具 → 软删除模板
        if (proposal.payload.itemTemplate) {
          const templates = this.getItemTemplates(proposal.gameId);
          const existing = templates.find(t => t.name === proposal.payload.itemTemplate!.name);
          if (existing) {
            this.removeItemTemplate(existing.id);
          }
        }
        gameProposalService.executeProposal(proposal.id);
        return { success: true, message: '道具已下架' };
      }
      case GameProposalType.ADJUST_PRICE: {
        // 调整价格 → 更新模板定价
        if (proposal.payload.itemTemplate) {
          const tmpl = proposal.payload.itemTemplate;
          const templates = this.getItemTemplates(proposal.gameId);
          const existing = templates.find(t => t.name === tmpl.name);
          if (existing) {
            this.updateItemTemplate(existing.id, {
              pricing: {
                price: tmpl.pricing.price,
                currency: tmpl.pricing.currency,
                acceptVoucher: true,
                voucherPrice: tmpl.pricing.price,
              },
            });
          }
        }
        gameProposalService.executeProposal(proposal.id);
        return { success: true, message: '价格已调整' };
      }
      // 内容类提案（角色/地图/玩法/配置/难度）
      // 当前阶段仅标记为已执行，具体实现由游戏方自行处理
      case GameProposalType.NEW_CHARACTER:
      case GameProposalType.NEW_MAP:
      case GameProposalType.NEW_GAMEPLAY:
      case GameProposalType.GAME_CONFIG:
      case GameProposalType.DIFFICULTY_ADJUST:
      case GameProposalType.NEW_CURRENCY:
      case GameProposalType.MINT_CURRENCY:
        gameProposalService.executeProposal(proposal.id);
        return {
          success: true,
          message: `提案「${proposal.title}」已标记为已执行，具体实现由游戏方处理`,
        };
      default:
        gameProposalService.executeProposal(proposal.id);
        return { success: true, message: '提案已标记为已执行' };
    }
  }

  /**
   * 🆕 初始化自动执行监听器
   * 在应用启动时调用一次，监听 proposal-auto-execute 事件
   */
  initAutoExecuteListener(): void {
    window.addEventListener('proposal-auto-execute', ((e: CustomEvent) => {
      const { proposal } = e.detail as { proposal: GameProposal };
      console.log(`[VoucherItem] 🔧 自动执行提案: ${proposal.title} (${proposal.proposalType})`);

      const result = this.executeProposalByType(proposal);

      if (result.success) {
        console.log(`[VoucherItem] ✅ 自动执行成功: ${proposal.title}`);
      } else {
        console.error(`[VoucherItem] ❌ 自动执行失败: ${proposal.title} - ${result.message}`);
        gameProposalService.markExecutionFailed(proposal.id, result.message);
      }
    }) as EventListener);
    console.log('[VoucherItem] 自动执行监听器已注册');
  }
}

// 导出单例
export const voucherItemService = new VoucherItemService();
export default voucherItemService;
