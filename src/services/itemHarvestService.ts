/**
 * 游戏内道具收获服务（Gameplay Item Harvest Service）
 *
 * 「游戏内道具 → 平台道具凭证」反向链路的核心：
 * 游戏通过 GAME_EVENT / ITEM_HARVEST 上报道具收获，本服务负责：
 * 1. 校验：Schema 已注册 + 游戏能力白名单 + 道具数据完整性
 * 2. 风控：每用户每游戏每日限额 + 提取幂等去重（防一份道具反复提取）
 * 3. 铸造：复用凭证系统（sourceType=ITEM），凭证天然可交易/转赠，
 *    且 customData.gameEffect 满足 redeemItemVoucherBySchema 契约，
 *    兑换后可重新下发进游戏（A 提取 → 交易给 B → B 兑换使用，闭环）。
 *
 * 防刷边界（P0）：
 * - 游戏文件可被下载篡改，前端校验只能防误不能防恶；
 *   每日限额是主要硬约束，白名单是第一道防线
 * - 幂等键 = 游戏侧 harvestId（缺失时退化为 itemData 内容 hash，从紧处理）
 * - 铸造凭证 customData.origin='gameplay'，供市场/凭证页展示「游戏掉落」标签
 */

import { voucherService, voucherDB } from '@/voucher-system';
import { VoucherSourceType, type VoucherMetadata } from '@/voucher-system/types';
import { getDefaultRegistry } from '@/publishing-center/protocol/SchemaRegistry';
import type { Voucher } from '@/voucher-system/types';

// ==================== 常量 ====================

/** 每用户每游戏每日提取上限 */
export const DAILY_HARVEST_LIMIT = 10;
/** 幂等记录容量（每用户保留最近 N 个 harvestId） */
const SEEN_HARVESTS_MAX = 500;
/** itemData 序列化后最大长度（防垃圾数据） */
const MAX_ITEM_DATA_SIZE = 8192;
/** effectCode 最大长度（与 SchemaRegistry 高级模式校验一致） */
const MAX_EFFECT_CODE_SIZE = 4000;

const DAILY_STORAGE_KEY = 'item_harvest_daily';
const SEEN_STORAGE_KEY = 'item_harvest_seen';

/** P2 高价值道具：视为「高价值」的稀有度标记（可执行代码道具一律视为高价值） */
export const HIGH_VALUE_RARITIES = ['epic', 'legendary', 'mythic', '史诗', '传说', '神话'];

// ==================== 类型 ====================

export interface ItemHarvestRequest {
  gameId: string;
  userId: string;
  userName?: string;
  /** 道具 Schema 名称（如 match3-powerup） */
  schemaName: string;
  /** 道具完整数据（name/effect/params/description/effectScript/effectCode） */
  itemData: Record<string, any>;
  /** 提取数量（P0 固定为 1） */
  quantity?: number;
  /** 游戏侧道具实例 ID（幂等键，游戏每次掉落生成唯一 ID） */
  harvestId?: string;
  /** 游戏通过 PROTOCOL:READY 声明的 supportedSchemas（白名单，空数组表示未声明） */
  allowedSchemas?: string[];
}

export type ItemHarvestRejectReason =
  | 'not_logged_in'
  | 'schema_not_registered'
  | 'schema_not_allowed'
  | 'invalid_data'
  | 'daily_limit'
  | 'duplicate'
  | 'mint_failed';

export interface ItemHarvestResult {
  success: boolean;
  message: string;
  voucherId?: string;
  voucherName?: string;
  reason?: ItemHarvestRejectReason;
  /** P2 高价值道具：true = 凭证已铸造但处于待审核状态（审核通过前不可交易/兑换） */
  pendingReview?: boolean;
}

// ==================== 存储工具 ====================

interface DailyRecord {
  date: string; // YYYY-MM-DD（本地时区）
  count: number;
}

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function loadDailyMap(): Record<string, DailyRecord> {
  try {
    return JSON.parse(localStorage.getItem(DAILY_STORAGE_KEY) || '{}');
  } catch {
    return {};
  }
}

function saveDailyMap(map: Record<string, DailyRecord>): void {
  try {
    localStorage.setItem(DAILY_STORAGE_KEY, JSON.stringify(map));
  } catch { /* 存储满等异常忽略 */ }
}

function loadSeenMap(): Record<string, string[]> {
  try {
    return JSON.parse(localStorage.getItem(SEEN_STORAGE_KEY) || '{}');
  } catch {
    return {};
  }
}

function saveSeenMap(map: Record<string, string[]>): void {
  try {
    localStorage.setItem(SEEN_STORAGE_KEY, JSON.stringify(map));
  } catch { /* ignore */ }
}

/** FNV-1a 简易 hash（幂等键退化用，非安全用途） */
function fnv1a(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16);
}

/** itemData 稳定序列化（键排序，保证同内容同 hash） */
function stableStringify(obj: any): string {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj) ?? 'null';
  if (Array.isArray(obj)) return '[' + obj.map(stableStringify).join(',') + ']';
  const keys = Object.keys(obj).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

// ==================== 服务类 ====================

class ItemHarvestService {
  /**
   * 处理游戏内道具收获请求：校验 → 风控 → 铸造道具凭证给玩家
   * 同步方法（voucherService.createVoucher 为同步），GamePlay 收到消息后直接调用
   */
  processItemHarvest(request: ItemHarvestRequest): ItemHarvestResult {
    const { gameId, userId, schemaName, itemData, harvestId, allowedSchemas } = request;

    // ---- ① 登录校验 ----
    if (!userId) {
      return { success: false, message: '请先登录后再提取道具', reason: 'not_logged_in' };
    }

    // ---- ② Schema 注册校验（第一道白名单：全平台注册表） ----
    if (!schemaName || typeof schemaName !== 'string') {
      return { success: false, message: '道具数据缺少 Schema 信息', reason: 'invalid_data' };
    }
    const registry = getDefaultRegistry();
    if (!registry.hasSchema(schemaName)) {
      return { success: false, message: `道具类型 "${schemaName}" 未注册，无法提取`, reason: 'schema_not_registered' };
    }

    // ---- ③ 游戏能力白名单 ----
    // 通道声明过 supportedSchemas（非空）时，必须包含该 schema
    if (allowedSchemas && allowedSchemas.length > 0 && !allowedSchemas.includes(schemaName)) {
      return {
        success: false,
        message: `该游戏未开放 "${schemaName}" 类型道具的提取`,
        reason: 'schema_not_allowed',
      };
    }
    // SchemaRegistry 侧的能力声明（PROTOCOL:READY / GAME_SCHEMA_MAP 注册过）同理约束
    const declaredCaps = registry.getGameCapabilities(gameId);
    if (declaredCaps.length > 0 && !declaredCaps.includes(schemaName)) {
      return {
        success: false,
        message: `该游戏未声明支持 "${schemaName}" 道具，无法提取`,
        reason: 'schema_not_allowed',
      };
    }

    // ---- ④ 道具数据完整性校验 ----
    if (!itemData || typeof itemData !== 'object' || Array.isArray(itemData)) {
      return { success: false, message: '道具数据无效', reason: 'invalid_data' };
    }
    if (typeof itemData.name !== 'string' || !itemData.name.trim()) {
      return { success: false, message: '道具缺少名称，无法提取', reason: 'invalid_data' };
    }
    if (typeof itemData.effect !== 'string' || !itemData.effect.trim()) {
      return { success: false, message: '道具缺少效果定义，无法提取', reason: 'invalid_data' };
    }
    const serialized = JSON.stringify(itemData);
    if (serialized.length > MAX_ITEM_DATA_SIZE) {
      return { success: false, message: '道具数据过大，无法提取', reason: 'invalid_data' };
    }
    if (itemData.effectCode && String(itemData.effectCode).length > MAX_EFFECT_CODE_SIZE) {
      return { success: false, message: '道具 effectCode 超长，无法提取', reason: 'invalid_data' };
    }

    // ---- ⑤ 幂等去重（防同一道具反复提取） ----
    const dupKey = harvestId
      ? `${gameId}:${String(harvestId)}`
      : fnv1a(`${gameId}|${schemaName}|${stableStringify(itemData)}`);
    const seenMap = loadSeenMap();
    const seenList = seenMap[userId] || [];
    if (seenList.includes(dupKey)) {
      return { success: false, message: '该道具已提取过，请勿重复提取', reason: 'duplicate' };
    }

    // ---- ⑥ 每日限额 ----
    const dailyMap = loadDailyMap();
    const dailyKey = `${userId}:${gameId}`;
    const daily = dailyMap[dailyKey];
    if (daily && daily.date === todayStr() && daily.count >= DAILY_HARVEST_LIMIT) {
      return {
        success: false,
        message: `今日在该游戏的道具提取次数已达上限（${DAILY_HARVEST_LIMIT} 个），明天再来吧`,
        reason: 'daily_limit',
      };
    }

    // ---- ⑦ 铸造道具凭证（复用凭证系统，可交易/转赠/兑换回游戏） ----
    // P2 高价值道具：携带可执行代码（effectCode/effectScript）或高稀有度的道具需审核，
    // 审核通过（reviewStatus='approved'）前禁止上架市场与兑换进游戏（拦截点在
    // marketplaceService.validateForListing / voucherItemService.redeemItemVoucherBySchema）。
    const highValue = this.isHighValueItem(itemData);
    const itemName = String(itemData.name).slice(0, 50);
    const gameEffect = {
      schemaName,
      itemId: String(itemData.effect),
      quantity: 1,
      itemData: { ...itemData },
    };
    const metadata: VoucherMetadata = {
      sourceType: VoucherSourceType.ITEM,
      name: itemName,
      description: String(itemData.description || '游戏内掉落道具').slice(0, 200),
      category: 'item',
      tags: ['item_voucher', 'gameplay_harvest', gameId, schemaName],
      issuer: gameId,
      customData: {
        origin: 'gameplay',
        gameId,
        schemaName,
        harvestId: dupKey,
        harvestedAt: Date.now(),
        gameEffect,
        ...(highValue ? { highValue: true, reviewStatus: 'pending' as const } : {}),
      },
    };

    try {
      const voucher = voucherService.createVoucher(
        {
          denomination: 0, // 掉落凭证无面值，交易价格由市场挂牌决定
          recipientId: userId,
          recipientName: request.userName || '玩家',
          metadata,
          note: `游戏内道具提取: ${itemName} (${gameId})`,
        },
        'SYSTEM',
        '游戏收获系统'
      );
      // 强制 sourceType = ITEM（道具凭证二分法：isItemVoucher）
      (voucher as any).sourceType = VoucherSourceType.ITEM;

      // ---- ⑧ 记录幂等 + 限额 ----
      seenList.push(dupKey);
      seenMap[userId] = seenList.slice(-SEEN_HARVESTS_MAX);
      saveSeenMap(seenMap);

      const today = todayStr();
      const current = dailyMap[dailyKey];
      dailyMap[dailyKey] = current && current.date === today
        ? { date: today, count: current.count + 1 }
        : { date: today, count: 1 };
      saveDailyMap(dailyMap);

      console.log(`[ItemHarvest] ✅ 道具提取成功: ${itemName} (${schemaName}) → 用户 ${userId}, 凭证 ${voucher.id}${highValue ? ' [高价值待审核]' : ''}`);
      return {
        success: true,
        message: highValue
          ? `高价值道具「${itemName}」已提取为凭证，待平台审核通过后可交易/使用`
          : `道具「${itemName}」已提取为凭证，可在市场交易`,
        voucherId: voucher.id,
        voucherName: itemName,
        pendingReview: highValue,
      };
    } catch (error) {
      console.error('[ItemHarvest] 铸造凭证失败:', error);
      return {
        success: false,
        message: error instanceof Error ? `提取失败: ${error.message}` : '提取失败，请稍后再试',
        reason: 'mint_failed',
      };
    }
  }

  /** 查询用户当日剩余提取次数（供 UI 展示） */
  getRemainingToday(userId: string, gameId: string): number {
    const daily = loadDailyMap()[`${userId}:${gameId}`];
    if (!daily || daily.date !== todayStr()) return DAILY_HARVEST_LIMIT;
    return Math.max(0, DAILY_HARVEST_LIMIT - daily.count);
  }

  // ==================== P2a 高价值道具审核流 ====================

  /**
   * 高价值道具判定（提交流程自动调用）：
   * ① 携带可执行代码（effectCode/effectScript）→ 安全风险，必须审核
   * ② 稀有度为 epic/legendary/mythic/史诗/传说/神话 → 平衡性风险
   * ③ itemData.highValue === true → 游戏方显式声明
   */
  isHighValueItem(itemData: Record<string, any>): boolean {
    if (!itemData || typeof itemData !== 'object') return false;
    if (typeof itemData.effectCode === 'string' && itemData.effectCode.trim()) return true;
    if (typeof itemData.effectScript === 'string' && itemData.effectScript.trim()) return true;
    if (itemData.highValue === true) return true;
    const rarity = String(itemData.rarity || '').toLowerCase();
    return HIGH_VALUE_RARITIES.includes(rarity) || HIGH_VALUE_RARITIES.includes(String(itemData.rarity || ''));
  }

  /** 审核后台：列出全部高价值道具凭证（pending/approved/rejected 全状态） */
  getHighValueVouchers(): Voucher[] {
    return voucherDB.getAllVouchers().filter(v => {
      const cd = (v.metadata as any)?.customData || {};
      return (v as any).sourceType === VoucherSourceType.ITEM && cd.highValue === true;
    });
  }

  /**
   * 审核后台：管理员审核决定（approve → 可交易/可用；reject → 永久禁交易）
   * 仅允许从 pending 变更；凭证经 voucherDB.updateVoucher 自动云同步（跨浏览器生效）。
   */
  decideItemReview(
    voucherId: string,
    approved: boolean,
    note: string,
    adminName: string,
  ): { success: boolean; message: string } {
    const voucher = voucherDB.getVoucherById(voucherId);
    if (!voucher) return { success: false, message: '凭证不存在' };
    const metaAny = voucher.metadata as any;
    if (!metaAny.customData || typeof metaAny.customData !== 'object') metaAny.customData = {};
    const cd = metaAny.customData as Record<string, any>;
    if (cd.highValue !== true) return { success: false, message: '该凭证不是高价值道具，无需审核' };
    if (cd.reviewStatus && cd.reviewStatus !== 'pending') {
      return { success: false, message: `该凭证已审核过（${cd.reviewStatus}），不能重复审核` };
    }
    cd.reviewStatus = approved ? 'approved' : 'rejected';
    cd.reviewNote = String(note || '').slice(0, 200);
    cd.reviewedAt = Date.now();
    cd.reviewedBy = String(adminName || 'admin').slice(0, 50);
    voucherDB.updateVoucher(voucher);
    console.log(`[ItemHarvest] ${approved ? '✅ 审核通过' : '❌ 审核驳回'}: 凭证 ${voucherId}（${voucher.metadata?.name}）by ${cd.reviewedBy}`);
    return {
      success: true,
      message: approved
        ? `道具「${voucher.metadata?.name}」审核通过，可交易/使用`
        : `道具「${voucher.metadata?.name}」已驳回${cd.reviewNote ? `：${cd.reviewNote}` : ''}`,
    };
  }
}

export const itemHarvestService = new ItemHarvestService();
export default itemHarvestService;
