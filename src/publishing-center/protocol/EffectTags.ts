/**
 * EffectTags — 跨游戏效果语义标签层
 *
 * 目的：解决「A 游戏的 effect 名在 B 游戏里不存在」的根本问题。
 * 各游戏的 effect 名是私有命名空间（remove_area / clear_color / invincible…），
 * 无法直接比较；本模块把它们归一化到一组平台级「语义标签」上，
 * 使平台可以回答两个问题：
 *   1. 这个道具在做什么？（ClearArea / AddTime / BuffPlayer …）
 *   2. 目标游戏里有没有做同一件事的 effect？（语义等价候选）
 *
 * 标签来源（优先级从高到低）：
 *   ① Schema 显式声明（ExtensionSchema.aiGuide.effectTags，由游戏方在 SOP 中注册）
 *   ② 平台内置字典 BUILTIN_EFFECT_TAGS（覆盖已知 Schema，兜底未声明的老 Schema）
 */

// ==================== 标准标签 ====================

export const CANONICAL_TAGS = [
  'CLEAR_AREA',     // 清除一片区域
  'CLEAR_COLOR',    // 按颜色清除
  'CLEAR_ROWCOL',   // 整行/整列清除
  'CLEAR_TAIL',     // 清除队列尾部元素
  'ADD_TIME',       // 增加时间
  'ADD_MOVES',      // 增加步数/次数
  'ADD_SCORE',      // 增加分数
  'MULTIPLY_SCORE', // 分数倍率
  'SLOW',           // 减速
  'FREEZE',         // 冻结/暂停
  'REVERSE',        // 反转
  'SHUFFLE',        // 重排
  'TRANSFORM',      // 变换（改色/替换属性）
  'BUFF_PLAYER',    // 增益角色（无敌/护盾/回血…）
  'DEBUFF_ENEMY',   // 削弱对手
  'DISPLAY',        // 纯展示/收藏（无游戏内玩法效果）
] as const;

export type EffectTag = (typeof CANONICAL_TAGS)[number];

/** 标签中文名（UI 展示用） */
export const TAG_LABELS: Record<EffectTag, string> = {
  CLEAR_AREA: '范围清除',
  CLEAR_COLOR: '同色清除',
  CLEAR_ROWCOL: '整行整列清除',
  CLEAR_TAIL: '尾部清除',
  ADD_TIME: '增加时间',
  ADD_MOVES: '增加步数',
  ADD_SCORE: '增加分数',
  MULTIPLY_SCORE: '分数翻倍',
  SLOW: '减速',
  FREEZE: '冻结',
  REVERSE: '反转',
  SHUFFLE: '重排',
  TRANSFORM: '属性变换',
  BUFF_PLAYER: '角色增益',
  DEBUFF_ENEMY: '削弱敌人',
  DISPLAY: '展示收藏',
};

/**
 * 标签权重：用于启发式估值（无标价的游戏掉落凭证）
 * 权重越高 = 对游戏进程影响越大 = 估值越高
 */
export const TAG_WEIGHTS: Record<EffectTag, number> = {
  CLEAR_AREA: 10,
  CLEAR_COLOR: 18,
  CLEAR_ROWCOL: 14,
  CLEAR_TAIL: 12,
  ADD_TIME: 6,
  ADD_MOVES: 12,
  ADD_SCORE: 5,
  MULTIPLY_SCORE: 14,
  SLOW: 8,
  FREEZE: 10,
  REVERSE: 8,
  SHUFFLE: 6,
  TRANSFORM: 9,
  BUFF_PLAYER: 16,
  DEBUFF_ENEMY: 12,
  DISPLAY: 12,
};

// ==================== 内置字典 ====================

/**
 * 已知 effect → 语义标签 映射
 * 未在此表中的 effect：无标签（即无法做语义映射，只能走「等值兑换」路径）
 */
const BUILTIN_EFFECT_TAGS: Record<string, EffectTag[]> = {
  // ---- match3 消消乐 ----
  remove_area: ['CLEAR_AREA'],
  bomb: ['CLEAR_AREA'],
  remove_row: ['CLEAR_ROWCOL'],
  remove_col: ['CLEAR_ROWCOL'],
  lightning: ['CLEAR_ROWCOL'],
  remove_color: ['CLEAR_COLOR'],
  rainbow: ['CLEAR_COLOR'],
  add_time: ['ADD_TIME'],
  add_moves: ['ADD_MOVES'],
  replace_color: ['TRANSFORM'],
  randomize_cell: ['TRANSFORM'],
  shuffle: ['SHUFFLE'],

  // ---- zuma 祖玛 ----
  add_score: ['ADD_SCORE'],
  clear_color: ['CLEAR_COLOR'],
  clear_green: ['CLEAR_COLOR'],
  slow_chain: ['SLOW'],
  remove_tail: ['CLEAR_TAIL'],
  reverse_chain: ['REVERSE'],
  score_multiplier: ['MULTIPLY_SCORE'],
  freeze_all: ['FREEZE'],

  // ---- 通用动作/角色扮演类 ----
  invincible: ['BUFF_PLAYER'],
  shield: ['BUFF_PLAYER'],
  heal: ['BUFF_PLAYER'],
  extra_life: ['BUFF_PLAYER'],
  speed_up: ['BUFF_PLAYER'],
  freeze: ['FREEZE'],
  slow: ['SLOW'],
  slow_time: ['SLOW'],
  double_score: ['MULTIPLY_SCORE'],
  extra_moves: ['ADD_MOVES'],
  extra_time: ['ADD_TIME'],
  weaken_enemy: ['DEBUFF_ENEMY'],
  stun: ['DEBUFF_ENEMY'],

  // ---- 展示/收藏类 ----
  display: ['DISPLAY'],
};

// ==================== Schema 级声明 ====================

/** schemaName → (effect → tags) */
const SCHEMA_EFFECT_TAGS: Map<string, Record<string, EffectTag[]>> = new Map();

/**
 * 注册某 Schema 的 effect → 标签 声明（游戏方在 SOP 中可选提供）
 * 优先级高于内置字典
 */
export function registerSchemaEffectTags(
  schemaName: string,
  tags: Record<string, string[]>
): void {
  const cleaned: Record<string, EffectTag[]> = {};
  for (const [effect, list] of Object.entries(tags)) {
    const filtered = sanitizeTags(list);
    if (filtered.length > 0) cleaned[effect] = filtered;
  }
  SCHEMA_EFFECT_TAGS.set(schemaName, cleaned);
}

function sanitizeTags(list: string[]): EffectTag[] {
  const known = CANONICAL_TAGS as readonly string[];
  return list.filter(t => known.includes(t)) as EffectTag[];
}

// ==================== 查询 API ====================

/**
 * 解析单个 effect 的语义标签
 */
export function resolveEffectTags(effect: string, schemaName?: string): EffectTag[] {
  if (!effect || typeof effect !== 'string') return [];

  if (schemaName) {
    const declared = SCHEMA_EFFECT_TAGS.get(schemaName)?.[effect];
    if (declared && declared.length > 0) return declared;
  }

  return BUILTIN_EFFECT_TAGS[effect] || [];
}

/**
 * 从道具数据中收集所有 effect 名（含 effectScript 组合里的子效果）
 */
export function collectEffectNames(itemData: any): string[] {
  const names: string[] = [];

  if (!itemData || typeof itemData !== 'object') return names;
  if (typeof itemData.effect === 'string' && itemData.effect.trim()) {
    names.push(itemData.effect.trim());
  }

  const walk = (node: any, depth: number) => {
    if (!node || typeof node !== 'object' || depth > 6) return;
    if (typeof node.effect === 'string' && node.effect.trim()) {
      names.push(node.effect.trim());
    }
    if (Array.isArray(node.effects)) {
      for (const sub of node.effects) walk(sub, depth + 1);
    }
  };
  walk(itemData.effectScript, 0);

  return Array.from(new Set(names));
}

/**
 * 解析整份道具数据的语义标签并集
 */
export function resolveDataTags(itemData: any, schemaName?: string): EffectTag[] {
  const tags = new Set<EffectTag>();
  for (const effect of collectEffectNames(itemData)) {
    for (const t of resolveEffectTags(effect, schemaName)) tags.add(t);
  }
  return Array.from(tags);
}

/**
 * 在一组候选 effect 中，找出与目标标签集存在交集的 effect
 * @returns 按共享标签数降序排列
 */
export function findEffectsByTags(
  candidateEffects: string[],
  wantTags: EffectTag[],
  candidateSchemaName?: string
): { effect: string; shared: EffectTag[] }[] {
  if (wantTags.length === 0) return [];

  const result: { effect: string; shared: EffectTag[] }[] = [];
  for (const effect of candidateEffects) {
    const tags = resolveEffectTags(effect, candidateSchemaName);
    const shared = tags.filter(t => wantTags.includes(t));
    if (shared.length > 0) result.push({ effect, shared });
  }

  return result.sort((a, b) => b.shared.length - a.shared.length);
}

/**
 * 该 effect 是否依赖私有运行时（effectCode / 自定义代码）
 * —— 这类效果严禁跨游戏搬运
 */
export function isPrivateRuntimeEffect(itemData: any): boolean {
  if (!itemData || typeof itemData !== 'object') return false;
  return Boolean(itemData.effectCode);
}
