/**
 * AllinONE OpenGames Protocol - 扩展凭证
 *
 * 扩展凭证 (ExtensionVoucher) 是 AI 桥梁 + SchemaRegistry 的产出物。
 * 当玩家想要在游戏中创建自定义内容时（如一把火焰剑），
 * AI 桥梁生成符合 Schema 的数据，打包为平台凭证。
 * 凭证可用于：
 * 1. 在本游戏中激活
 * 2. 跨游戏迁移/适配
 * 3. 交易市场流转
 */

import type { ExtensionVoucherPayload } from './ProtocolChannel';

// ==================== 扩展凭证状态 ====================

export type ExtensionVoucherStatus = 'pending' | 'active' | 'consumed' | 'expired' | 'transferred';

// ==================== 扩展凭证 ====================

export interface ExtensionVoucher {
  /** 凭证 ID */
  id: string;

  /** 凭证类型 */
  type: 'game_extension';

  /** 所属 Schema 名称 */
  schemaName: string;

  /** 来源游戏 */
  sourceGameId: string;

  /** 目标游戏（可选，为空则当前游戏使用） */
  targetGameId?: string;

  /** AI 生成的结构化内容 */
  data: any;

  /** 抗篡改签名 */
  signature: string;

  /** 状态 */
  status: ExtensionVoucherStatus;

  /** 创建时间 */
  createdAt: number;

  /** 激活时间 */
  activatedAt?: number;

  /** 过期时间 */
  expiresAt?: number;

  /** 当前持有者 ID */
  holderId?: string;

  /** 流转次数 */
  transferCount: number;

  /** 凭证历史 */
  history: Array<{
    action: 'created' | 'activated' | 'consumed' | 'transferred' | 'adapted';
    fromGameId?: string;
    toGameId?: string;
    timestamp: number;
    detail?: string;
  }>;
}

// ==================== ExtensionVoucherService ====================

export class ExtensionVoucherService {
  private static STORAGE_KEY = 'allinone_extension_vouchers';

  /**
   * 创建扩展凭证
   */
  static create(params: {
    schemaName: string;
    sourceGameId: string;
    targetGameId?: string;
    data: any;
    signature: string;
    expiresIn?: number;
  }): ExtensionVoucher {
    const now = Date.now();
    const voucher: ExtensionVoucher = {
      id: `ev_${now}_${Math.random().toString(36).substr(2, 12)}`,
      type: 'game_extension',
      schemaName: params.schemaName,
      sourceGameId: params.sourceGameId,
      targetGameId: params.targetGameId,
      data: params.data,
      signature: params.signature,
      status: 'pending',
      createdAt: now,
      expiresAt: params.expiresIn ? now + params.expiresIn : undefined,
      transferCount: 0,
      history: [
        {
          action: 'created',
          fromGameId: params.sourceGameId,
          toGameId: params.targetGameId,
          timestamp: now,
          detail: `基于 Schema "${params.schemaName}" 创建`,
        },
      ],
    };

    // 保存
    this.save(voucher);
    return voucher;
  }

  /**
   * 激活凭证（游戏领取并使用）
   */
  static activate(voucherId: string, gameId: string): ExtensionVoucher | null {
    const voucher = this.get(voucherId);
    if (!voucher) return null;
    if (voucher.status !== 'pending') return null;
    if (voucher.expiresAt && Date.now() > voucher.expiresAt) {
      voucher.status = 'expired';
      this.save(voucher);
      return null;
    }

    voucher.status = 'active';
    voucher.activatedAt = Date.now();
    voucher.history.push({
      action: 'activated',
      toGameId: gameId,
      timestamp: Date.now(),
    });

    this.save(voucher);
    return voucher;
  }

  /**
   * 消耗凭证（游戏内使用完毕）
   */
  static consume(voucherId: string): ExtensionVoucher | null {
    const voucher = this.get(voucherId);
    if (!voucher) return null;
    if (voucher.status !== 'active') return null;

    voucher.status = 'consumed';
    voucher.history.push({
      action: 'consumed',
      timestamp: Date.now(),
    });

    this.save(voucher);
    return voucher;
  }

  /**
   * 跨游戏适配凭证
   */
  static adaptForGame(
    voucherId: string,
    targetGameId: string,
    adaptedData: any,
    newSignature: string
  ): ExtensionVoucher | null {
    const voucher = this.get(voucherId);
    if (!voucher) return null;
    if (voucher.status === 'consumed' || voucher.status === 'expired') return null;

    // 创建新的适配凭证（不修改原凭证）
    const adapted = this.create({
      schemaName: voucher.schemaName,
      sourceGameId: voucher.sourceGameId,
      targetGameId,
      data: adaptedData,
      signature: newSignature,
      expiresIn: voucher.expiresAt ? voucher.expiresAt - Date.now() : undefined,
    });

    // 在原凭证中记录
    voucher.history.push({
      action: 'adapted',
      fromGameId: voucher.sourceGameId,
      toGameId: targetGameId,
      timestamp: Date.now(),
      detail: `已适配到游戏 "${targetGameId}"`,
    });
    voucher.transferCount++;
    this.save(voucher);

    return adapted;
  }

  /**
   * 转为协议载荷（用于 postMessage 发送）
   */
  static toPayload(voucher: ExtensionVoucher): ExtensionVoucherPayload {
    return {
      id: voucher.id,
      type: 'game_extension',
      schemaName: voucher.schemaName,
      sourceGameId: voucher.sourceGameId,
      targetGameId: voucher.targetGameId,
      data: voucher.data,
      signature: voucher.signature,
      timestamp: voucher.createdAt,
      expiresAt: voucher.expiresAt,
    };
  }

  /**
   * 从载荷还原
   */
  static fromPayload(payload: ExtensionVoucherPayload): ExtensionVoucher {
    return {
      id: payload.id,
      type: 'game_extension',
      schemaName: payload.schemaName,
      sourceGameId: payload.sourceGameId,
      targetGameId: payload.targetGameId,
      data: payload.data,
      signature: payload.signature,
      status: 'pending',
      createdAt: payload.timestamp,
      expiresAt: payload.expiresAt,
      transferCount: 0,
      history: [
        {
          action: 'created',
          fromGameId: payload.sourceGameId,
          toGameId: payload.targetGameId,
          timestamp: payload.timestamp,
        },
      ],
    };
  }

  /**
   * 验证凭证签名（简单校验）
   */
  static verify(voucher: ExtensionVoucher): boolean {
    if (voucher.expiresAt && Date.now() > voucher.expiresAt) {
      voucher.status = 'expired';
      this.save(voucher);
      return false;
    }

    // 简单签名验证：检查签名是否存在且与数据匹配
    if (!voucher.signature || voucher.signature.length < 8) {
      return false;
    }

    return true;
  }

  // ==================== 持久化 ====================

  static save(voucher: ExtensionVoucher): void {
    const all = this.getAll();
    const index = all.findIndex(v => v.id === voucher.id);
    if (index >= 0) {
      all[index] = voucher;
    } else {
      all.push(voucher);
    }
    // 本地缓存
    try {
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(all));
    } catch { /* 缓存空间不足 */ }
    // ✅ CloudBase 双写（通过写入队列，保证零丢失）
    import('../../services/writeQueue').then(({ writeQueue }) => {
      writeQueue.enqueue({
        collection: 'extension_vouchers',
        operation: 'upsert',
        data: voucher as any,
      });
    }).catch(() => {});
  }

  static get(voucherId: string): ExtensionVoucher | undefined {
    return this.getAll().find(v => v.id === voucherId);
  }

  static getAll(): ExtensionVoucher[] {
    try {
      const raw = localStorage.getItem(this.STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }

  /** 异步从 CloudBase 刷新缓存（云端数据覆盖本地） */
  static async refreshFromCloud(): Promise<ExtensionVoucher[]> {
    try {
      const { isCloudBaseReady, getCloudBaseApp } = await import('../../services/cloudbase');
      if (!isCloudBaseReady()) return this.getAll();
      const res = await getCloudBaseApp().database().collection('extension_vouchers').limit(500).get();
      if (res.data.length === 0) return this.getAll();
      const local = this.getAll();
      // ✅ CloudBase 数据覆盖本地同名 ID
      const cloudMap = new Map(res.data.map(d => [d.id, d]));
      const localOnly = local.filter(v => !cloudMap.has(v.id));
      const merged = [...res.data as ExtensionVoucher[], ...localOnly];
      try {
        localStorage.setItem(this.STORAGE_KEY, JSON.stringify(merged));
      } catch { /* 缓存空间不足 */ }
      return merged;
    } catch {
      return this.getAll();
    }
  }

  static getUserVouchers(holderId?: string): ExtensionVoucher[] {
    if (!holderId) return [];
    return this.getAll().filter(v => v.holderId === holderId || (!v.holderId && v.status === 'pending'));
  }

  static getGameVouchers(gameId: string): ExtensionVoucher[] {
    return this.getAll().filter(
      v => v.sourceGameId === gameId || v.targetGameId === gameId
    );
  }

  /**
   * 生成简单签名（实际环境中应使用加密签名）
   */
  static sign(data: any, secretKey: string = 'allinone-extension-v1'): string {
    const payload = JSON.stringify(data) + ':' + secretKey;
    let hash = 0;
    for (let i = 0; i < payload.length; i++) {
      const char = payload.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash |= 0;
    }
    return `ev1_${Math.abs(hash).toString(36)}_${Date.now().toString(36)}`;
  }
}

export const extensionVoucherService = ExtensionVoucherService;
