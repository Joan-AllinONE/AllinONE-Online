/**
 * 54位模拟玩家数据（含4个测试账户映射 + 创始人Joan）
 * 分属游戏方、玩家社区、平台方三大利益方
 * 用于游戏内容提案投票
 */
import { VoteStakeholderType } from '@/types/gameProposal';
import type { SimulatedPlayer, PlayerMetrics } from '@/types/gameProposal';

/**
 * 生成54位模拟玩家（含4个测试账户映射 + 创始人Joan）
 */
export function generateSimulatedPlayers(): SimulatedPlayer[] {
  const players: SimulatedPlayer[] = [];

  // ===== 游戏方 (5人) =====
  const developers: SimulatedPlayer[] = [
    { id: 'dev-001', name: 'GameDev_张三', type: VoteStakeholderType.GAME_DEVELOPER, voteWeight: 1.0, gameId: 'game-1' },
    { id: 'dev-002', name: 'GameDev_李四', type: VoteStakeholderType.GAME_DEVELOPER, voteWeight: 1.0, gameId: 'game-1' },
    { id: 'dev-003', name: 'GameDev_王五', type: VoteStakeholderType.GAME_DEVELOPER, voteWeight: 1.0, gameId: 'game-2' },
    { id: 'dev-004', name: 'GameDev_赵六', type: VoteStakeholderType.GAME_DEVELOPER, voteWeight: 1.0, gameId: 'game-2' },
    { id: 'dev-005', name: 'GameDev_陈七', type: VoteStakeholderType.GAME_DEVELOPER, voteWeight: 1.0, gameId: 'game-3' },
  ];
  players.push(...developers);

  // ===== 玩家社区 (29人) =====
  // VIP高权重玩家 (5人, voteWeight=2.0)
  const vipNames = ['暗夜猎手', '星辰大海', '极速风暴', '烈焰战神', '冰霜女皇'];
  for (let i = 0; i < 5; i++) {
    players.push({
      id: `player-vip-${String(i + 1).padStart(3, '0')}`,
      name: `VIP_${vipNames[i]}`,
      type: VoteStakeholderType.PLAYER_COMMUNITY,
      voteWeight: 2.0,
    });
  }

  // 测试账户映射 (4人) — 对应 testAccounts.ts，可用于实际登录+投票
  // test-001: player1/冒险者小明 (level 5) → voteWeight=1.5
  players.push({
    id: 'test-001',
    name: '冒险者小明',
    type: VoteStakeholderType.PLAYER_COMMUNITY,
    voteWeight: 1.5,
  });
  // test-002: player2/探险家小红 (level 3) → voteWeight=0.5
  players.push({
    id: 'test-002',
    name: '探险家小红',
    type: VoteStakeholderType.PLAYER_COMMUNITY,
    voteWeight: 0.5,
  });
  // test-003: dev1/开发者老张 (level 10) → 游戏方, voteWeight=2.0
  players.push({
    id: 'test-003',
    name: '开发者老张',
    type: VoteStakeholderType.GAME_DEVELOPER,
    voteWeight: 2.0,
    gameId: 'game-1',
  });
  // test-004: admin/管理员 (level 99) → 平台方, voteWeight=3.0, 有否决权
  players.push({
    id: 'test-004',
    name: '管理员',
    type: VoteStakeholderType.PLATFORM,
    voteWeight: 3.0,
    hasVetoRight: true,
  });

  // 活跃玩家 (20人, voteWeight=1.0)
  const activeNames = [
    '雷霆', '破晓', '疾风', '龙魂', '天启',
    '赤焰', '冰魄', '剑圣', '法神', '弓皇',
    '破军', '贪狼', '七杀', '神算', '医仙',
    '铁壁', '影舞', '雷神', '凤舞', '龙骑',
  ];
  for (let i = 0; i < 20; i++) {
    players.push({
      id: `player-active-${String(i + 1).padStart(3, '0')}`,
      name: `活跃玩家_${activeNames[i]}`,
      type: VoteStakeholderType.PLAYER_COMMUNITY,
      voteWeight: 1.0,
    });
  }

  // 普通玩家 (10人, voteWeight=0.5)
  for (let i = 0; i < 10; i++) {
    players.push({
      id: `player-normal-${String(i + 1).padStart(3, '0')}`,
      name: `普通玩家_${String(i + 1).padStart(3, '0')}`,
      type: VoteStakeholderType.PLAYER_COMMUNITY,
      voteWeight: 0.5,
    });
  }

  // ===== 平台方 (10人) =====
  // 创始人 Joan (1人, hasVetoRight=true, voteWeight=3.0)
  players.push({
    id: 'platform-founder',
    name: 'Joan（创始人）',
    type: VoteStakeholderType.PLATFORM,
    voteWeight: 3.0,
    hasVetoRight: true,
  });

  // 平台管理员 (4人, voteWeight=1.5)
  const adminNames = ['审核官', '运营官', '技术官', '安全官'];
  for (let i = 0; i < 4; i++) {
    players.push({
      id: `platform-admin-${String(i + 1).padStart(3, '0')}`,
      name: `平台管理_${adminNames[i]}`,
      type: VoteStakeholderType.PLATFORM,
      voteWeight: 1.5,
    });
  }

  // 社区代表 (5人, voteWeight=1.0)
  const repNames = ['周', '吴', '郑', '钱', '孙'];
  for (let i = 0; i < 5; i++) {
    players.push({
      id: `platform-rep-${String(i + 1).padStart(3, '0')}`,
      name: `社区代表_${repNames[i]}`,
      type: VoteStakeholderType.PLATFORM,
      voteWeight: 1.0,
    });
  }

  return players;
}

/**
 * 按类型筛选玩家
 */
export function getPlayersByType(type: VoteStakeholderType): SimulatedPlayer[] {
  return generateSimulatedPlayers().filter(p => p.type === type);
}

/**
 * 统计各类玩家数量
 */
export function getPlayerStats(): Record<VoteStakeholderType, { count: number; totalWeight: number }> {
  const players = generateSimulatedPlayers();
  const stats: Record<string, { count: number; totalWeight: number }> = {};

  for (const p of players) {
    if (!stats[p.type]) {
      stats[p.type] = { count: 0, totalWeight: 0 };
    }
    stats[p.type].count++;
    stats[p.type].totalWeight += p.voteWeight;
  }

  return stats as Record<VoteStakeholderType, { count: number; totalWeight: number }>;
}

// ==================== 动态投票权重引擎 ====================

/**
 * 辅助随机数生成器 [min, max]
 */
function randRange(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * 动态计算玩家投票权重
 *
 * 公式：
 *   voteWeight = BASE_WEIGHT × (
 *     活跃度因子 × 0.35 +
 *     资产因子   × 0.25 +
 *     治理因子   × 0.25 +
 *     亲密度因子 × 0.15
 *   )
 * 每个因子范围 [0.2~0.3, 1.0]，总乘数 ≈ [0.85, 1.0]
 */
export function calculateVoteWeight(
  player: SimulatedPlayer,
  metrics: PlayerMetrics,
  gameId?: string,
): number {
  const baseWeight = player.voteWeight;

  // 1. 活跃度因子 (35%)：近30天活跃天数 / 20，上限 1.0
  const activityFactor = Math.min(metrics.activeDaysLast30 / 20, 1.0) * 0.8 + 0.2;

  // 2. 资产因子 (25%)：ACOIN + 凭证价值的 log 归一化
  const totalAssets = metrics.acoinBalance + metrics.voucherCount * 50;
  const assetFactor = Math.min(Math.log10(Math.max(totalAssets, 1) + 1) / 5, 1.0) * 0.8 + 0.2;

  // 3. 治理参与因子 (25%)：历史投票参与率
  const governanceFactor = Math.min(metrics.voteParticipationRate, 1.0) * 0.7 + 0.3;

  // 4. 游戏亲密度因子 (15%)：目标游戏道具持有量
  let intimacyFactor = 0.6; // 默认值
  if (gameId && metrics.gameItemHoldings[gameId]) {
    const holdings = metrics.gameItemHoldings[gameId] || 0;
    intimacyFactor = Math.min(holdings / 10, 1.0) * 0.4 + 0.6;
  }

  const compositeFactor =
    activityFactor * 0.35 +
    assetFactor * 0.25 +
    governanceFactor * 0.25 +
    intimacyFactor * 0.15;

  return Math.round(baseWeight * compositeFactor * 100) / 100;
}

/**
 * 为所有54位模拟玩家生成动态指标（带随机波动）
 * 不同类型玩家有不同的指标分布特征
 */
export function generatePlayerMetrics(gameId?: string): Record<string, PlayerMetrics> {
  const players = generateSimulatedPlayers();
  const metrics: Record<string, PlayerMetrics> = {};

  for (const p of players) {
    const isVip = p.id.startsWith('player-vip');
    const isActive = p.id.startsWith('player-active');
    const isNormal = p.id.startsWith('player-normal');
    const isPlatform = p.type === VoteStakeholderType.PLATFORM;
    const isDev = p.type === VoteStakeholderType.GAME_DEVELOPER;
    // 测试账户（来自 testAccounts.ts）
    const isTest001 = p.id === 'test-001'; // player1 冒险者小明 level 5
    const isTest002 = p.id === 'test-002'; // player2 探险家小红 level 3
    const isTest003 = p.id === 'test-003'; // dev1 开发者老张 level 10
    const isTest004 = p.id === 'test-004'; // admin 管理员 level 99

    metrics[p.id] = {
      playerId: p.id,
      activeDaysLast30: isTest004 ? randRange(28, 30)
        : isVip || isTest003 ? randRange(25, 30)
        : isTest001 ? randRange(20, 28)
        : isActive ? randRange(20, 28)
        : isTest002 ? randRange(10, 20)
        : isNormal ? randRange(3, 12)
        : isPlatform ? randRange(25, 30)
        : randRange(22, 30), // dev
      acoinBalance: isTest004 ? randRange(50000, 100000)
        : isTest003 ? randRange(30000, 60000)
        : isVip ? randRange(5000, 20000)
        : isTest001 ? randRange(8000, 18000)
        : isActive ? randRange(1000, 8000)
        : isTest002 ? randRange(2000, 5000)
        : isNormal ? randRange(100, 2000)
        : isPlatform ? randRange(10000, 50000)
        : randRange(3000, 15000), // dev
      voucherCount: isTest004 ? randRange(30, 60)
        : isTest003 ? randRange(15, 40)
        : isVip ? randRange(10, 50)
        : isTest001 ? randRange(5, 25)
        : isActive ? randRange(3, 20)
        : isTest002 ? randRange(2, 10)
        : isNormal ? randRange(0, 5)
        : isPlatform ? randRange(5, 30)
        : randRange(5, 25), // dev
      voteParticipationRate: isTest004 ? randRange(80, 100) / 100
        : isVip || isTest003 ? randRange(75, 95) / 100
        : isTest001 ? randRange(65, 90) / 100
        : isActive ? randRange(60, 90) / 100
        : isTest002 ? randRange(40, 70) / 100
        : isNormal ? randRange(20, 50) / 100
        : isPlatform ? randRange(70, 100) / 100
        : randRange(70, 95) / 100, // dev
      gameItemHoldings: gameId ? {
        [gameId]: isTest004 ? randRange(10, 20)
          : isTest003 ? randRange(8, 15)
          : isVip ? randRange(5, 15)
          : isTest001 ? randRange(3, 12)
          : isActive ? randRange(2, 8)
          : isTest002 ? randRange(1, 6)
          : isNormal ? randRange(0, 3)
          : randRange(3, 10),
      } : {},
      communityReputation: isTest004 ? randRange(85, 100)
        : isTest003 ? randRange(75, 95)
        : isVip ? randRange(70, 100)
        : isTest001 ? randRange(55, 85)
        : isActive ? randRange(40, 80)
        : isTest002 ? randRange(30, 60)
        : isNormal ? randRange(10, 50)
        : randRange(60, 95),
    };
  }

  return metrics;
}
