/**
 * crossGameExchange — 跨游戏道具兑换中心
 *
 * 背景：不同游戏的 effect 是各自私有的 EFFECT_HANDLERS key，
 * 原实现用「搬运源数据 + 猜一个目标 schema 名」的方式做适配，
 * 结果必然是游戏端报「未找到效果」。
 *
 * 本模块把跨游戏使用拆成三条路径，按可靠性排序：
 *
 *   A. EQUIVALENT 等值兑换  — 核销源凭证，按估值兑换成【目标游戏自己的道具凭证】
 *                            目标凭证走目标游戏原有的兑换链路 → 100% 可用
 *   B. SEMANTIC   语义映射  — 源/目标 effect 共享同一语义标签（EffectTags），
 *                            保留外观、把效果替换为目标的等价 effect，参数按约束夹取
 *   C. RAW        原样搬运  — 目标游戏碰巧认得该 effect 名（成功率极低，默认折叠+告警）
 *
 * 执行铁律：先成功产出目标侧凭证，再核销源凭证；任何一步失败则源凭证保持 ACTIVE 可重试。
 */

import { voucherService } from '@/voucher-system';
import { skillGateway } from '@/skills';
import { voucherItemService } from './voucherItemService';
import {
  VoucherSourceType,
  VoucherStatus,
  ItemSupplyPolicy,
  type ItemVoucherTemplate,
  type Voucher,
} from '@/voucher-system/types';
import { getDefaultRegistry } from '@/publishing-center/protocol/SchemaRegistry';
import {
  resolveDataTags,
  resolveEffectTags,
  findEffectsByTags,
  isPrivateRuntimeEffect,
  collectEffectNames,
  TAG_WEIGHTS,
  TAG_LABELS,
  type EffectTag,
} from '@/publishing-center/protocol/EffectTags';

// ==================== 常量 ====================

const MAX_DAILY_CONVERSIONS = 20;
const DAILY_LOG_KEY = 'cross_game_conversions';
/** 折损超过该比例时 UI 需显式提示 */
const VALUE_LOSS_WARN_THRESHOLD = 0.2;
/** 跨游戏兑换手续费率：按目标道具价值收取（2026-09-13 新增） */
export const EXCHANGE_FEE_RATE = 0.1;

/**
 * 跨游戏兑换手续费 = 目标道具价值 × 10%
 * 支付方式由玩家选择：钱包游戏币（精确扣款）或 A 币凭证（整张支付不找零）
 */
export function calcExchangeFee(targetValue: number): number {
  return round2(Math.max(0, targetValue) * EXCHANGE_FEE_RATE);
}
/** 双花兜底：核销源凭证失败时，把源凭证转入平台池使其脱离用户（与 voucherItemService 保持一致） */
const PLATFORM_POOL_ID = 'platform_pool';
const PLATFORM_POOL_NAME = '平台总账户';

const RARITY_COEFFICIENT: Record<string, number> = {
  common: 1,
  uncommon: 1.25,
  rare: 1.6,
  epic: 2,
  legendary: 2.6,
};

/** 效果参数量级 → 估值加成系数 */
const PARAM_VALUE_FACTOR: Record<string, number> = {
  radius: 4,
  seconds: 0.5,
  count: 2,
  bonus: 0.6,
  multiplier: 8,
  amount: 0.6,
  damage: 0.15,
};

// ==================== 类型 ====================

export type ConversionMode = 'EQUIVALENT' | 'SEMANTIC' | 'RAW';

export type ConversionRisk = 'safe' | 'medium' | 'high';

export interface ConversionOption {
  mode: ConversionMode;
  optionId: string;
  /** 简述，如「炸弹道具（来自 match3）→ 清色炸弹」 */
  label: string;
  detail: string;
  sourceValue: number;
  targetValue: number;
  /** ≥0，表示相对源估值损失的比值（0 = 无损） */
  valueLoss: number;
  currency: string;
  /** 0-1 */
  confidence: number;
  risk: ConversionRisk;
  /** 失败原因说明（仅当该路径不可用时） */
  unavailableReason?: string;
  /** 可用的 reason 列表（UI 提示） */
  notes?: string[];

  /** >0 表示目标道具价格高于源估值，需玩家用游戏币/A币凭证补齐的差价（2026-09-13 差价补齐兜底） */
  topUpAmount?: number;

  // ---- 执行所需载荷 ----
  targetTemplateId?: string;
  targetSchemaName?: string;
  targetEffect?: string;
  targetItemData?: Record<string, any>;
}

export interface ConversionListResult {
  ok: boolean;
  message?: string;
  sourceVoucherId: string;
  sourceGameId: string;
  sourceName: string;
  sourceValue: number;
  sourceTags: EffectTag[];
  options: ConversionOption[];
  recommendedId?: string;
}

export interface ConversionExecuteRequest {
  voucherId: string;
  userId: string;
  userName: string;
  targetGameId: string;
  optionId: string;
  /** 补差价/手续费支付方式：gamecoin=钱包游戏币（精确扣款），voucher=A币凭证（整张支付不找零） */
  paymentMethod?: 'gamecoin' | 'voucher';
  /** paymentMethod='voucher' 时用于支付的 A 币凭证 ID 列表 */
  paymentVoucherIds?: string[];
}

export interface ConversionExecuteResult {
  success: boolean;
  message: string;
  /** 路径 A 生成的目标游戏道具凭证 ID */
  newVoucherId?: string;
  /** 路径 B/C 是否已下发到游戏 */
  dispatchedToGame?: boolean;
}

interface ConversionRecord {
  id: string;
  userId: string;
  sourceVoucherId: string;
  sourceGameId: string;
  targetGameId: string;
  mode: ConversionMode;
  sourceValue: number;
  targetValue: number;
  targetTemplateId?: string;
  newVoucherId?: string;
  createdAt: number;
}

// ==================== 选项缓存 ====================

/** key = `${voucherId}::${targetGameId}` */
const optionCache = new Map<string, ConversionOption[]>();
const optionIndex = new Map<string, { key: string; option: ConversionOption }>();

// ==================== 内部工具 ====================

function customDataOf(voucher: Voucher): Record<string, any> {
  return (voucher.metadata?.customData || {}) as Record<string, any>;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * 启发式估值：把效果标签 + 参数量级 + 稀有度 折算成统一估值点数
 * 用于「游戏掉落凭证（denomination = 0）」这类没有标价的道具
 */
function estimateHeuristicValue(itemData: any, rarity?: string): number {
  const effects = collectEffectNames(itemData);
  let base = 0;
  for (const effect of effects) {
    const tags = resolveEffectTags(effect);
    let effectScore = tags.reduce((sum, t) => sum + TAG_WEIGHTS[t], 0);
    // 无字典收录的自定义效果给一个保守底分
    if (tags.length === 0) effectScore = 8;
    base += effectScore;
  }
  if (effects.length === 0) base = 8;

  // 参数量级加成
  const params = (itemData?.params || {}) as Record<string, any>;
  let magnitude = 0;
  for (const [key, val] of Object.entries(params)) {
    if (typeof val !== 'number' || !Number.isFinite(val)) continue;
    const factor = PARAM_VALUE_FACTOR[key];
    if (factor) magnitude += val * factor;
  }
  base += Math.min(magnitude, 40);

  // 稀有度系数
  const coeff = rarity ? RARITY_COEFFICIENT[rarity] ?? 1 : 1;
  let value = base * coeff;

  // 自定义代码加成（更强的能力 → 更高的估值）
  if (itemData?.effectCode) value *= 1.3;
  else if (itemData?.effectScript) value *= 1.15;

  return round2(Math.max(value, 5));
}

/**
 * 计算源道具估值
 * 优先级：模板标价 > 凭证面额 > 启发式估值
 */
function estimateSourceValue(voucher: Voucher, cd: Record<string, any>): number {
  const templateId = cd.itemTemplateId as string | undefined;
  if (templateId) {
    const tpl = voucherItemService.getItemTemplate(templateId);
    const tplPrice = Number(tpl?.pricing?.price ?? 0);
    if (tpl && Number.isFinite(tplPrice) && tplPrice > 0) return round2(tplPrice);
  }

  // 游戏方可选上报的道具价值（游戏掉落时写在 itemData.value）
  const reported = Number(cd.gameEffect?.itemData?.value || 0);
  if (reported > 0) return round2(reported);

  const denomination = Number((voucher as any).denomination || 0);
  if (denomination > 0) return round2(denomination);

  return estimateHeuristicValue(cd.gameEffect?.itemData, cd.rarity);
}

/** 收集目标游戏已知的所有 Schema（能力声明 ∪ 道具模板声明） */
function collectTargetSchemas(targetGameId: string): string[] {
  const registry = getDefaultRegistry();
  const caps = registry.getGameCapabilities(targetGameId);
  const fromTemplates = voucherItemService
    .getItemTemplates(targetGameId)
    .map(t => t.gameEffect?.schemaName)
    .filter((s): s is string => Boolean(s));

  const all = Array.from(new Set([...caps, ...fromTemplates]));
  // 只保留真实注册过的 Schema
  return all.filter(s => registry.getSchema(s));
}

/** 取 Schema 声明的可用效果列表 */
function availableEffectsOf(schemaName: string): string[] {
  const schema = getDefaultRegistry().getSchema(schemaName);
  if (!schema) return [];
  const declared = schema.aiGuide?.availableEffects || [];
  const preset = (schema.aiGuide?.creationTiers?.preset?.items || []).map(i => i.effect);
  return Array.from(new Set([...declared, ...preset].filter(Boolean)));
}

function remainingSupply(tpl: ItemVoucherTemplate): number {
  if (tpl.supplyPolicy === ItemSupplyPolicy.LIMITED && typeof tpl.totalSupply === 'number') {
    return Math.max(tpl.totalSupply - tpl.mintedCount, 0);
  }
  return Number.MAX_SAFE_INTEGER;
}

/** 今日已兑换次数 */
function todayConversionCount(userId: string): number {
  try {
    const raw = localStorage.getItem(DAILY_LOG_KEY);
    if (!raw) return 0;
    const list: ConversionRecord[] = JSON.parse(raw);
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    return list.filter(r => r.userId === userId && r.createdAt >= startOfDay.getTime()).length;
  } catch {
    return 0;
  }
}

function appendConversionRecord(record: ConversionRecord): void {
  // ⚠️ 仅本地记账：'cross_game_conversions' 不在 gamesApi 云函数 SYNC_COLLECTIONS
  // 白名单内（贸然上送会 404）。每日限额按浏览器本地统计即可满足用途；
  // 后续若需跨浏览器审计，需先扩 SyncCollection 白名单 + 云函数并重新部署。
  try {
    const raw = localStorage.getItem(DAILY_LOG_KEY);
    const list: ConversionRecord[] = raw ? JSON.parse(raw) : [];
    list.push(record);
    localStorage.setItem(DAILY_LOG_KEY, JSON.stringify(list.slice(-200)));
  } catch (e) {
    console.warn('[CrossGameExchange] 写入本地兑换日志失败:', e);
  }
}

/**
 * 按目标 Schema 的约束夹取参数
 */
function clampParams(params: Record<string, any>, constraints?: Record<string, any>): Record<string, any> {
  if (!constraints) return { ...params };

  const clamped: Record<string, any> = { ...params };
  const limiters: Record<string, number> = {};
  if (typeof constraints.maxCellsPerEffect === 'number') limiters.count = constraints.maxCellsPerEffect;
  if (typeof constraints.maxTailRemove === 'number') limiters.count = Math.min(limiters.count ?? Infinity, constraints.maxTailRemove);
  if (typeof constraints.maxMovesAdd === 'number') limiters.count = Math.min(limiters.count ?? Infinity, constraints.maxMovesAdd);
  if (typeof constraints.maxTimeAdd === 'number') limiters.seconds = constraints.maxTimeAdd;
  if (typeof constraints.maxScoreAdd === 'number') limiters.bonus = constraints.maxScoreAdd;
  if (typeof constraints.maxMultiplier === 'number') limiters.multiplier = constraints.maxMultiplier;

  for (const [key, max] of Object.entries(limiters)) {
    if (typeof clamped[key] === 'number') {
      clamped[key] = Math.max(1, Math.min(clamped[key], max));
    }
  }
  return clamped;
}

const NUMERIC_PARAM_ALIASES: Record<string, string[]> = {
  count: ['count', 'radius', 'cells', 'amount'],
  radius: ['radius', 'count', 'cells'],
  seconds: ['seconds', 'time', 'duration'],
  bonus: ['bonus', 'score', 'amount'],
  multiplier: ['multiplier', 'times'],
};

/** 语义映射缺参时的保守默认值（防止目标 effect 读到 undefined → NaN） */
const DEFAULT_PARAM_VALUES: Record<string, number> = {
  radius: 1,
  count: 3,
  seconds: 10,
  bonus: 15,
  multiplier: 2,
};

/**
 * 语义映射：把源道具数据改造为目标游戏可执行的数据
 * - effect 换成目标游戏的等价 effect
 * - 同名参数直接保留，异名参数按别名取值；仍缺的数值参数补保守默认值；
 *   全部过约束夹取
 * - effectCode 一律剥离（跨游戏执行必然崩）
 * - icon 等展示字段原样透传
 */
function buildSemanticItemData(
  sourceItemData: Record<string, any>,
  targetSchemaName: string,
  targetEffect: string,
): Record<string, any> {
  const schema = getDefaultRegistry().getSchema(targetSchemaName);
  const declaredParams = Object.keys(
    (schema?.inputSchema?.properties?.params as any)?.properties || {}
  );

  const sourceParams = (sourceItemData?.params || {}) as Record<string, any>;
  const mapped: Record<string, any> = {};

  for (const key of declaredParams) {
    if (typeof sourceParams[key] === 'number' && Number.isFinite(sourceParams[key])) {
      mapped[key] = sourceParams[key];
      continue;
    }
    if (typeof sourceParams[key] === 'string') {
      mapped[key] = sourceParams[key];   // 颜色类等字符串参数原样带过去
      continue;
    }
    const aliases = NUMERIC_PARAM_ALIASES[key] || [];
    for (const alias of aliases) {
      if (typeof sourceParams[alias] === 'number' && Number.isFinite(sourceParams[alias])) {
        mapped[key] = sourceParams[alias];
        break;
      }
    }
    // 仍缺 → 保守默认值（仅数值型参数）
    if (typeof mapped[key] === 'undefined') {
      const fallback = DEFAULT_PARAM_VALUES[key];
      if (typeof fallback === 'number') mapped[key] = fallback;
    }
  }

  return {
    name: sourceItemData?.name || '跨游戏道具',
    description: sourceItemData?.description
      ? `${sourceItemData.description}（跨游戏语义映射）`
      : `由其他游戏的道具语义映射而来`,
    ...(typeof sourceItemData?.icon === 'string' ? { icon: sourceItemData.icon } : {}),
    effect: targetEffect,
    params: clampParams(mapped, schema?.aiGuide?.constraints as Record<string, any>),
    adapted: true,
  };
}

// ==================== 对外 API ====================

/**
 * 列出某张道具凭证在某目标游戏里的所有可用兑换方式
 */
export function listConversionOptions(input: {
  voucherId: string;
  targetGameId: string;
  userId: string;
}): ConversionListResult {
  const { voucherId, targetGameId, userId } = input;

  const emptyBase = (): ConversionListResult => ({
    ok: false,
    message: '',
    sourceVoucherId: voucherId,
    sourceGameId: '',
    sourceName: '',
    sourceValue: 0,
    sourceTags: [],
    options: [],
  });

  const voucher = voucherService.getVoucherById(voucherId);
  if (!voucher) return { ...emptyBase(), message: '凭证不存在' };
  if (voucher.currentHolderId !== userId) return { ...emptyBase(), message: '您不是该凭证的持有者' };
  if (voucher.status !== VoucherStatus.ACTIVE) return { ...emptyBase(), message: '凭证不可用' };
  if ((voucher as any).sourceType !== VoucherSourceType.ITEM) {
    return { ...emptyBase(), message: '该凭证不是道具凭证' };
  }

  const cd = customDataOf(voucher);
  const sourceGameId = cd.gameId as string;
  const gameEffect = cd.gameEffect || {};
  const itemData = (gameEffect.itemData || {}) as Record<string, any>;
  const schemaName = (gameEffect.schemaName || cd.schemaName) as string;
  const sourceName = voucher.metadata?.name || itemData?.name || '未知道具';

  if (!sourceGameId || sourceGameId === targetGameId) {
    return { ...emptyBase(), message: '该道具属于本游戏，无需跨游戏兑换' };
  }

  const reviewStatus = cd.reviewStatus;
  if (reviewStatus === 'pending') return { ...emptyBase(), message: '高价值道具审核中，暂不能跨游戏使用' };
  if (reviewStatus === 'rejected') return { ...emptyBase(), message: '该道具未通过平台审核，无法使用' };

  const sourceValue = estimateSourceValue(voucher, cd);
  const sourceTags = resolveDataTags(itemData, schemaName);
  const currency = voucherItemService.getItemTemplate(cd.itemTemplateId)?.pricing?.currency || 'ACOIN';

  const options: ConversionOption[] = [];
  const notes = {
    EQUIVALENT: [] as string[],
    SEMANTIC: [] as string[],
    RAW: [] as string[],
  };

  // ---------- 路径 A：等值兑换（含差价补齐兜底，2026-09-13） ----------
  const templates = voucherItemService.getItemTemplates(targetGameId);
  const eligible = templates
    .filter(t => {
      // 内容模板（内容工坊）不是"道具"：schemaName 'content' 未注册、走
      // CONTENT_PACK_APPLY 专用通道，绝不能成为跨游戏等值兑换的目标
      if (t.gameEffect?.schemaName === 'content' || (t as any).itemType === 'content') return false;
      if (!t.gameEffect?.schemaName && !t.gameEffect?.itemId) return false;
      const price = Number(t.pricing?.price || 0);
      return price > 0 && remainingSupply(t) > 0;
    })
    .sort((a, b) => a.pricing.price - b.pricing.price);

  // 精确等值：价格不高于源估值（优先推荐）
  const affordable = eligible.filter(t => t.pricing.price <= sourceValue).slice(-3).reverse();
  // 差价补齐兜底：目标道具价格高于源估值，玩家可用游戏币/A币补齐差额（即使已有等值选项也提供更贵目标）
  const topUpCandidates = eligible.filter(t => t.pricing.price > sourceValue).slice(0, 3);

  const buildEquivalentOption = (tpl: ItemVoucherTemplate): ConversionOption => {
    const targetValue = round2(tpl.pricing.price);
    const topUp = Math.max(0, round2(targetValue - sourceValue));
    const loss = sourceValue > 0 ? round2(Math.max(0, (sourceValue - targetValue) / sourceValue)) : 0;
    const fee = calcExchangeFee(targetValue);
    return {
      mode: 'EQUIVALENT',
      optionId: `eq-${tpl.id}`,
      label: `${sourceName} → ${tpl.name}`,
      detail: tpl.description || '兑换为目标游戏的同类型道具',
      sourceValue,
      targetValue,
      valueLoss: loss,
      currency: tpl.pricing?.currency || currency,
      confidence: 0.99,
      risk: 'safe',
      notes: [
        '兑换后得到的是本游戏原生道具，100% 生效',
        ...(topUp > 0 ? [`目标道具价值高于源道具：需补差价 ${topUp}（游戏币或A币）`] : []),
        ...(loss > VALUE_LOSS_WARN_THRESHOLD ? [`折损 ${Math.round(loss * 100)}%，目标道具价值低于原道具`] : []),
        ...(tpl.supplyPolicy === ItemSupplyPolicy.LIMITED ? ['限量道具，剩余库存有限'] : []),
        `兑换手续费 ${fee}（目标道具价值的 10%）`,
      ],
      targetTemplateId: tpl.id,
      targetSchemaName: tpl.gameEffect?.schemaName,
      targetItemData: (tpl.gameEffect?.itemData || {}) as Record<string, any>,
      ...(topUp > 0 ? { topUpAmount: topUp } : {}),
    };
  };
  for (const tpl of affordable) options.push(buildEquivalentOption(tpl));
  for (const tpl of topUpCandidates) options.push(buildEquivalentOption(tpl));

  if (affordable.length === 0) {
    if (topUpCandidates.length > 0) {
      notes.EQUIVALENT.push('目标游戏暂无价值不高于该道具的道具；可补差价兑换（下方选项，100% 生效）');
    } else {
      notes.EQUIVALENT.push('目标游戏暂无可兑换的道具');
    }
  }

  // ---------- 路径 B：语义映射 ----------
  const privateRuntime = isPrivateRuntimeEffect(itemData);
  const targetSchemas = collectTargetSchemas(targetGameId);

  if (privateRuntime) {
    notes.SEMANTIC.push('该道具含自定义代码（effectCode），仅支持等值兑换');
  } else if (sourceTags.length === 0) {
    notes.SEMANTIC.push('该道具效果无法识别为通用语义，仅支持等值兑换');
  } else {
    const seen = new Set<string>();
    for (const targetSchema of targetSchemas) {
      const candidates = findEffectsByTags(availableEffectsOf(targetSchema), sourceTags, targetSchema);
      for (const { effect, shared } of candidates) {
        const key = `${targetSchema}::${effect}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const confidence = Math.min(0.55 + shared.length * 0.12, 0.85);
        options.push({
          mode: 'SEMANTIC',
          optionId: `sm-${hashKey(`${voucherId}::${targetGameId}::${key}`)}`,
          label: `${sourceName} → ${effect}`,
          detail: `按语义「${shared.map(t => TAG_LABELS[t] || t).join(' / ')}」映射为目标游戏的 ${effect} 效果`,
          sourceValue,
          targetValue: sourceValue,
          valueLoss: 0,
          currency,
          confidence: round2(confidence),
          risk: 'medium',
          notes: ['保留道具外观，效果替换为目标游戏的等价效果', '若目标游戏未正确实现该效果，可能不生效'],
          targetSchemaName: targetSchema,
          targetEffect: effect,
          targetItemData: undefined, // 执行时按最新源数据即时计算
        });
      }
      if (seen.size >= 6) break;
    }
    if (seen.size === 0) {
      notes.SEMANTIC.push('目标游戏中没有语义等价的效果');
    }
  }

  // ---------- 路径 C：原样搬运（高风险，UI 默认折叠） ----------
  const sourceEffect = String(itemData?.effect || '');
  const rawSupported = privateRuntime || !sourceEffect
    ? []
    : targetSchemas.filter(s => availableEffectsOf(s).includes(sourceEffect));

  if (privateRuntime) {
    notes.RAW.push('含自定义代码的道具禁止跨游戏搬运');
  } else if (rawSupported.length === 0) {
    notes.RAW.push(`目标游戏不认识效果 "${sourceEffect || '未知'}"，原样搬运基本必然失败`);
  } else {
    options.push({
      mode: 'RAW',
      optionId: `raw-${hashKey(`${voucherId}::${targetGameId}::${rawSupported[0]}::${sourceEffect}`)}`,
      label: `${sourceName}（原样使用）`,
      detail: `把原始效果 ${sourceEffect} 直接搬进目标游戏`,
      sourceValue,
      targetValue: sourceValue,
      valueLoss: 0,
      currency,
      confidence: 0.2,
      risk: 'high',
      notes: ['不推荐：仅当目标游戏恰好实现了同名效果时才会生效'],
      targetSchemaName: rawSupported[0],
    });
  }

  // ---------- 汇总 ----------
  if (options.length === 0) {
    return {
      ok: true,
      message: `该道具无法跨游戏使用。${[notes.EQUIVALENT[0], notes.SEMANTIC[0], notes.RAW[0]]
        .filter(Boolean)
        .join('；')}。可回到原游戏使用，或在市场出售。`,
      sourceVoucherId: voucherId,
      sourceGameId,
      sourceName,
      sourceValue,
      sourceTags,
      options: [],
    };
  }

  // 推荐：优先精确等值（无差价），其次带补差价的等值兑换，最后其他路径
  const recommended =
    options.find(o => o.mode === 'EQUIVALENT' && !o.topUpAmount) ||
    options.find(o => o.mode === 'EQUIVALENT') ||
    options[0];

  const cacheKey = `${voucherId}::${targetGameId}`;
  optionCache.set(cacheKey, options);
  for (const opt of options) optionIndex.set(opt.optionId, { key: cacheKey, option: opt });

  return {
    ok: true,
    sourceVoucherId: voucherId,
    sourceGameId,
    sourceName,
    sourceValue,
    sourceTags,
    options,
    recommendedId: recommended.optionId,
  };
}

/** 简单稳定 hash（用于生成 optionId） */
function hashKey(input: string): string {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = (h << 5) - h + input.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h).toString(36);
}

/**
 * 执行跨游戏兑换（2026-09-13 起为 async：支持手续费/差价的异步支付）
 *
 * 支付规则：
 *  - 手续费 = 目标道具价值 × 10%（所有路径均收取）
 *  - 差价补齐 = 目标道具价格 − 源估值（仅带 topUpAmount 的等值兑换选项）
 *  - 两者合并为应付总额，玩家可选钱包游戏币（精确扣款）或 A 币凭证（整张支付不找零）
 *  - 支付发生在兑换之前；兑换失败（目标凭证未产出 / 目标游戏未受理）自动全额退款
 */
export async function executeConversion(input: ConversionExecuteRequest): Promise<ConversionExecuteResult> {
  const { voucherId, userId, userName, targetGameId, optionId } = input;

  const cached = optionIndex.get(optionId);
  if (!cached) {
    return { success: false, message: '兑换选项已失效，请重新选择兑换方式' };
  }
  const { option } = cached;

  // 每日限额
  if (todayConversionCount(userId) >= MAX_DAILY_CONVERSIONS) {
    return { success: false, message: `今日跨游戏兑换已达上限（${MAX_DAILY_CONVERSIONS} 次）` };
  }

  const voucher = voucherService.getVoucherById(voucherId);
  if (!voucher) return { success: false, message: '凭证不存在' };
  if (voucher.currentHolderId !== userId) return { success: false, message: '您不是该凭证的持有者' };
  if (voucher.status !== VoucherStatus.ACTIVE) return { success: false, message: '凭证不可用（可能已使用）' };

  const cd = customDataOf(voucher);
  const sourceGameId = String(cd.gameId || '');
  const itemData = (cd.gameEffect?.itemData || {}) as Record<string, any>;
  const sourceName = voucher.metadata?.name || itemData?.name || '未知道具';

  const recordBase = {
    id: `conv-${hashKey(`${voucherId}-${Date.now()}`)}`,
    userId,
    sourceVoucherId: voucherId,
    sourceGameId,
    targetGameId,
    mode: option.mode,
    sourceValue: option.sourceValue,
    targetValue: option.targetValue,
    createdAt: Date.now(),
  };

  // ---------- 手续费 & 差价补齐支付 ----------
  const fee = calcExchangeFee(option.targetValue);
  const topUp = option.topUpAmount || 0;
  const totalPay = round2(topUp + fee);

  /** 支付回执（用于失败退款） */
  let payReceipt: {
    method: 'gamecoin' | 'voucher';
    amount: number;
    vouchers: { id: string; denomination: number }[];
  } | null = null;

  /** 兑换失败时全额退款（游戏币走 recharge；A币凭证逐张转回） */
  const refundPayment = async () => {
    if (!payReceipt) return;
    try {
      if (payReceipt.method === 'gamecoin') {
        await skillGateway.execute('wallet', 'recharge', {
          amount: payReceipt.amount,
          description: '跨游戏兑换失败退款',
        }, { userId, sessionId: 'web' });
      } else {
        for (const pv of payReceipt.vouchers) {
          try {
            voucherService.transferVoucher(
              { voucherId: pv.id, toUserId: userId, toUserName: userName, note: '跨游戏兑换支付退款' },
              PLATFORM_POOL_ID,
              PLATFORM_POOL_NAME,
            );
          } catch (e2) {
            console.error('[CrossGameExchange] 退还支付凭证失败，请人工核查:', pv.id, e2);
          }
        }
      }
      console.log(`[CrossGameExchange] 已退款 ${payReceipt.amount}（${payReceipt.method}）`);
    } catch (e) {
      console.error('[CrossGameExchange] 退款流程异常，请人工核查:', payReceipt, e);
    }
  };

  if (totalPay > 0) {
    if (!input.paymentMethod) {
      return { success: false, message: '本次兑换需支付手续费/差价，请先选择支付方式' };
    }

    if (input.paymentMethod === 'gamecoin') {
      // 钱包游戏币：精确扣款（spend 余额不足会抛错 → gateway 转为 success:false）
      const spendResult = await skillGateway.execute('wallet', 'spend', {
        amount: totalPay,
        description: `跨游戏兑换支付（差价 ${topUp} + 手续费 ${fee}）`,
      }, { userId, sessionId: 'web' });
      if (!spendResult.success) {
        return { success: false, message: spendResult.error?.message || '游戏币支付失败' };
      }
      payReceipt = { method: 'gamecoin', amount: totalPay, vouchers: [] };
    } else {
      // A 币凭证：整张支付不找零；差价部分归目标游戏开发者账户，手续费归平台池
      const ids = input.paymentVoucherIds || [];
      if (ids.length === 0) {
        return { success: false, message: '请选择用于支付的A币凭证' };
      }
      const used: { id: string; denomination: number }[] = [];
      let sum = 0;
      for (const vid of ids) {
        const pv = voucherService.getVoucherById(vid);
        if (!pv || pv.currentHolderId !== userId || pv.status !== VoucherStatus.ACTIVE) {
          return { success: false, message: '所选支付凭证不可用，请重新选择' };
        }
        const denom = Number((pv as any).denomination || 0);
        if (!(denom > 0)) {
          return { success: false, message: '所选凭证无面额，不能用于支付' };
        }
        used.push({ id: vid, denomination: denom });
        sum = round2(sum + denom);
      }
      if (sum < totalPay) {
        return { success: false, message: `所选A币凭证合计 ${sum}，不足以支付 ${totalPay}` };
      }

      const devAccount = `game-${targetGameId}`;
      let devNeed = topUp;
      for (const pv of used) {
        const toDev = devNeed > 0;
        if (toDev) devNeed = round2(devNeed - pv.denomination);
        const target = toDev
          ? { id: devAccount, name: `${targetGameId} 开发者` }
          : { id: PLATFORM_POOL_ID, name: PLATFORM_POOL_NAME };
        voucherService.transferVoucher(
          { voucherId: pv.id, toUserId: target.id, toUserName: target.name, note: '跨游戏兑换支付（差价/手续费）' },
          userId,
          userName,
        );
      }
      payReceipt = { method: 'voucher', amount: totalPay, vouchers: used };
    }
  }

  // ---------- 路径 A：等值兑换 ----------
  if (option.mode === 'EQUIVALENT') {
    if (!option.targetTemplateId) {
      return { success: false, message: '兑换选项缺少目标道具模板' };
    }
    const template = voucherItemService.getItemTemplate(option.targetTemplateId);
    if (!template || !template.isActive) {
      return { success: false, message: '目标道具已下架，请重新选择兑换方式' };
    }
    if (remainingSupply(template) <= 0) {
      return { success: false, message: `目标道具「${template.name}」库存不足，请重新选择兑换方式` };
    }

    // ① 先产出目标凭证（失败则源凭证不动）
    const mint = voucherItemService.mintItemVouchers({
      gameId: targetGameId,
      templateId: template.id,
      count: 1,
      recipientId: userId,
      recipientName: userName,
    });
    if (!mint.success || mint.vouchers.length === 0) {
      await refundPayment();
      return { success: false, message: mint.message || '目标道具凭证生成失败，源道具未被消耗，已退还支付' };
    }

    // ② 再核销源凭证
    try {
      voucherService.redeemVoucher(
        voucherId,
        userId,
        userName,
        `跨游戏等值兑换: ${sourceName} (${sourceGameId}) → ${template.name} (${targetGameId})`
      );
    } catch (e) {
      // ⚠️ 双花防护：目标凭证已产出，源凭证绝不能留在用户手里再次兑换。
      // 核销失败（极小概率）→ 退而把源凭证强制转入平台池，使其脱离用户。
      console.error('[CrossGameExchange] 核销源凭证失败，执行转入平台池兜底:', e);
      try {
        voucherService.transferVoucher(
          { voucherId, toUserId: PLATFORM_POOL_ID, toUserName: PLATFORM_POOL_NAME, note: '跨游戏兑换核销失败兜底' },
          userId,
          userName,
        );
      } catch (e2) {
        console.error('[CrossGameExchange] 兜底转账也失败，存在重复兑换风险，请人工核查:', voucherId, e2);
      }
      return {
        success: false,
        message: '兑换过程中源凭证核销异常，已自动保护源道具；目标道具可能已生成，请联系客服核查',
      };
    }

    const newVoucherId = mint.vouchers[0].id;
    appendConversionRecord({ ...recordBase, targetTemplateId: template.id, newVoucherId });

    return {
      success: true,
      message: `已兑换为本游戏道具「${template.name}」，可在下方「我的道具凭证」中使用`,
      newVoucherId,
    };
  }

  // ---------- 路径 B/C：语义映射 / 原样搬运 ----------
  let conversionPayload: { mode: 'SEMANTIC' | 'RAW'; targetSchemaName: string; itemData: Record<string, any> };

  if (option.mode === 'SEMANTIC') {
    if (!option.targetSchemaName || !option.targetEffect) {
      return { success: false, message: '兑换选项缺少目标效果信息，请重新选择' };
    }
    conversionPayload = {
      mode: 'SEMANTIC',
      targetSchemaName: option.targetSchemaName,
      itemData: buildSemanticItemData(itemData, option.targetSchemaName, option.targetEffect),
    };
  } else {
    if (!option.targetSchemaName) {
      return { success: false, message: '目标游戏不支持原样使用，请改用等值兑换' };
    }
    conversionPayload = {
      mode: 'RAW',
      targetSchemaName: option.targetSchemaName,
      itemData: { ...itemData },
    };
  }

  const result = voucherItemService.redeemItemVoucher({
    userId,
    userName,
    voucherId,
    gameId: targetGameId,
    conversion: conversionPayload,
  });

  if (!result.success) {
    await refundPayment();
    return { success: false, message: result.message };
  }

  appendConversionRecord({ ...recordBase });

  return {
    success: true,
    message: result.message,
    dispatchedToGame: result.dispatchedToGame,
  };
}

/**
 * 清除某凭证的选项缓存（兑换完成/失败后调用）
 */
export function clearConversionCache(voucherId: string): void {
  for (const [optionId, { key }] of optionIndex) {
    if (key.startsWith(`${voucherId}::`)) optionIndex.delete(optionId);
  }
  for (const key of optionCache.keys()) {
    if (key.startsWith(`${voucherId}::`)) optionCache.delete(key);
  }
}

export const crossGameExchange = {
  listConversionOptions,
  executeConversion,
  clearConversionCache,
  MAX_DAILY_CONVERSIONS,
};
