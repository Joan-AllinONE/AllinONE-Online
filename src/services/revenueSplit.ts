/**
 * 三方收益分成纯函数（零依赖，前端 / 本地服务端 / 单测共享同一份实现）
 *
 * 语义（2026-10-07 已确认）：GameProposal 的 revenueSharing 通过后写入
 * gameDeveloperAccount.revenueSharing（比例配置型），此后每卖出一份道具
 * 按新比例三方分账。钱来自未来每一笔销售，不存在存量资金问题。
 *
 * 尾差规则：platformCut / creatorCut 各自 floor，剩余全部归游戏方
 * （保证 gameCut + platformCut + creatorCut === amount，尾差归游戏方）。
 */

export interface RevenueSharingRatio {
  /** 游戏方份额 (0-1) */
  gameShare: number;
  /** 平台份额 (0-1) */
  platformShare: number;
  /** 创作者份额 (0-1)，可为 0 */
  creatorShare?: number;
}

export interface ThreeWaySplitResult {
  /** 游戏方所得 */
  gameCut: number;
  /** 平台所得（进 platformOwed，沿用日结清金库） */
  platformCut: number;
  /** 创作者所得（进 creatorOwed） */
  creatorCut: number;
  /**
   * legacy = 账户无三方配置，走单极分成
   * （平台抽 legacyPlatformPercent%，其余归游戏方，creatorCut=0）
   */
  mode: 'legacy' | 'three-way';
}

/** 三方配置是否有效存在（全 0 视为未配置 → 走 legacy 单极） */
export function hasActiveSharingConfig(config?: RevenueSharingRatio | null): boolean {
  if (!config) return false;
  const gameShare = Number(config.gameShare) || 0;
  const platformShare = Number(config.platformShare) || 0;
  const creatorShare = Number(config.creatorShare) || 0;
  return gameShare > 0 || platformShare > 0 || creatorShare > 0;
}

/**
 * 计算一笔销售的三方分账
 * @param amount 销售总额（A币）
 * @param config 三方比例配置（0-1 小数）；无配置时走 legacy 单极
 * @param legacyPlatformPercent legacy 平台抽成（0-100 百分比）
 */
export function computeThreeWaySplit(
  amount: number,
  config: RevenueSharingRatio | null | undefined,
  legacyPlatformPercent: number,
): ThreeWaySplitResult {
  if (!hasActiveSharingConfig(config)) {
    const platformCut = Math.floor((amount * (legacyPlatformPercent || 0)) / 100);
    return { gameCut: amount - platformCut, platformCut, creatorCut: 0, mode: 'legacy' };
  }
  const platformCut = Math.floor(amount * ((config as RevenueSharingRatio).platformShare || 0));
  const creatorCut = Math.floor(amount * ((config as RevenueSharingRatio).creatorShare || 0));
  // 尾差归游戏方：floor 保证 gameCut >= 0 且三方之和 === amount
  const gameCut = amount - platformCut - creatorCut;
  return { gameCut, platformCut, creatorCut, mode: 'three-way' };
}

/**
 * 校验三方比例配置（表单 / 提案执行共用）
 * 规则：三方非负、之和 = 1（±1e-4 容差）、creatorShare > 0 时必须指定创作者 userId
 */
export function validateRevenueSharingConfig(
  config: RevenueSharingRatio & { creatorId?: string },
): { ok: boolean; message: string } {
  const gameShare = Number(config.gameShare) || 0;
  const platformShare = Number(config.platformShare) || 0;
  const creatorShare = Number(config.creatorShare) || 0;
  if (gameShare < 0 || platformShare < 0 || creatorShare < 0) {
    return { ok: false, message: '分成比例不能为负数' };
  }
  const sum = gameShare + platformShare + creatorShare;
  if (Math.abs(sum - 1) > 0.0001) {
    return { ok: false, message: `三方分成比例之和应为 1，当前为 ${sum.toFixed(4)}` };
  }
  if (creatorShare > 0 && !config.creatorId) {
    return { ok: false, message: '创作者份额大于 0 时必须指定创作者 userId' };
  }
  return { ok: true, message: 'OK' };
}
