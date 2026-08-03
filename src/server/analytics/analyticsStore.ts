/**
 * 平台数据中心 - 后端事件存储与聚合
 *
 * 双模设计（与 inventoryStore / redeemCodeStore 一致）：
 *   - 内存模式（USE_MEMORY_DB=true / 开发）：纯内存数组，重启丢数据（部署现实）
 *   - PostgreSQL 模式（生产）：预留表 analytics_events / analytics_daily，接入后自动持久化
 *
 * 事件来自客户端埋点（src/services/analytics.ts）批量上报，
 * 经 POST /api/v1/analytics/events 落入本存储，再由此处聚合出 DAU/MAU/次数/时长/营收。
 */

// ==================== 类型 ====================

export type AnalyticsEventType =
  | 'register'
  | 'login'
  | 'logout'
  | 'game_launch'
  | 'session_start'
  | 'session_end'
  | 'voucher_tx'
  | 'market_tx';

export interface AnalyticsEvent {
  type: AnalyticsEventType;
  userId?: string;
  gameId?: string;
  payload?: Record<string, any>;
  /** 毫秒时间戳（客户端生成） */
  timestamp: number;
  /** 'YYYY-MM-DD'（客户端生成，用于 DAU 分桶） */
  date: string;
}

export interface OverviewMetrics {
  dau: number;
  mau: number;
  totalPlayers: number;
  totalGamePlays: number;
  avgSessionMs: number;
  totalRevenueACoins: number;
  totalRevenueGameCoins: number;
  generatedAt: number;
}

export interface TrendPoint {
  date: string;
  dau: number;
  gamePlays: number;
  revenueACoins: number;
  revenueGameCoins: number;
}

export interface GameStat {
  gameId: string;
  gamePlays: number;
  uniquePlayers: number;
  avgSessionMs: number;
  revenueACoins: number;
  revenueGameCoins: number;
}

export interface PlayersStat {
  totalPlayers: number;
  dau: number;
  mau: number;
  newVsReturning: { new: number; returning: number };
  byRole: Record<string, number>;
  byActivityTier: Record<string, number>;
}

// ==================== 工具 ====================

function ymd(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

// ==================== 内存存储 ====================

class AnalyticsStore {
  private events: AnalyticsEvent[] = [];

  // ========== 写入 ==========

  /** 批量写入事件（幂等：相同 userId+type+timestamp 视为重复，丢弃） */
  addEvents(incoming: AnalyticsEvent[]): { added: number; ignored: number } {
    let added = 0;
    let ignored = 0;
    for (const ev of incoming) {
      if (!ev || !ev.type || !ev.timestamp) {
        ignored++;
        continue;
      }
      const dup = this.events.some(
        e =>
          e.type === ev.type &&
          e.timestamp === ev.timestamp &&
          (e.userId || '') === (ev.userId || '')
      );
      if (dup) {
        ignored++;
        continue;
      }
      this.events.push({
        type: ev.type,
        userId: ev.userId,
        gameId: ev.gameId,
        payload: ev.payload,
        timestamp: ev.timestamp,
        date: ev.date || ymd(ev.timestamp),
      });
      added++;
    }
    return { added, ignored };
  }

  // ========== 查询：概览 ==========

  getOverview(): OverviewMetrics {
    const now = Date.now();
    const day30 = now - 30 * 86400000;

    const recent = this.events.filter(e => e.timestamp >= day30);
    const today = ymd(now);

    const dauUsers = new Set(
      this.events.filter(e => e.date === today).map(e => e.userId || 'anon')
    );
    const mauUsers = new Set(recent.map(e => e.userId || 'anon'));
    const allUsers = new Set(this.events.map(e => e.userId || 'anon'));

    const gamePlays = this.events.filter(e => e.type === 'game_launch').length;

    const sessionEnds = recent.filter(e => e.type === 'session_end');
    const avgSessionMs =
      sessionEnds.length > 0
        ? Math.round(
            sessionEnds.reduce(
              (s, e) => s + (Number(e.payload?.durationMs) || 0),
              0
            ) / sessionEnds.length
          )
        : 0;

    let revA = 0;
    let revG = 0;
    for (const e of this.events.filter(
      e => e.type === 'voucher_tx' || e.type === 'market_tx'
    )) {
      const amt = Number(e.payload?.amount) || 0;
      const cur = String(e.payload?.currency || 'A币').toLowerCase();
      const isGameCoin = cur.includes('game') || cur.includes('游戏币') || cur === 'gc';
      if (isGameCoin) revG += amt;
      else revA += amt;
    }

    return {
      dau: dauUsers.size,
      mau: mauUsers.size,
      totalPlayers: allUsers.size,
      totalGamePlays: gamePlays,
      avgSessionMs,
      totalRevenueACoins: Math.round(revA * 100) / 100,
      totalRevenueGameCoins: Math.round(revG * 100) / 100,
      generatedAt: now,
    };
  }

  // ========== 查询：趋势 ==========

  getTrends(metric: string, days: number): TrendPoint[] {
    const now = Date.now();
    const points: TrendPoint[] = [];

    for (let i = days - 1; i >= 0; i--) {
      const d = ymd(now - i * 86400000);
      const dayEvents = this.events.filter(e => e.date === d);
      const dau = new Set(dayEvents.map(e => e.userId || 'anon')).size;
      const gamePlays = dayEvents.filter(e => e.type === 'game_launch').length;

      let revA = 0;
      let revG = 0;
      for (const e of dayEvents.filter(
        e => e.type === 'voucher_tx' || e.type === 'market_tx'
      )) {
        const amt = Number(e.payload?.amount) || 0;
        const cur = String(e.payload?.currency || 'A币').toLowerCase();
        const isGameCoin = cur.includes('game') || cur.includes('游戏币') || cur === 'gc';
        if (isGameCoin) revG += amt;
        else revA += amt;
      }

      points.push({
        date: d,
        dau,
        gamePlays,
        revenueACoins: Math.round(revA * 100) / 100,
        revenueGameCoins: Math.round(revG * 100) / 100,
      });
    }
    return points;
  }

  // ========== 查询：按游戏 ==========

  getByGame(): GameStat[] {
    const map = new Map<string, AnalyticsEvent[]>();
    for (const e of this.events) {
      const gid = e.gameId;
      if (!gid) continue;
      if (!map.has(gid)) map.set(gid, []);
      map.get(gid)!.push(e);
    }

    const result: GameStat[] = [];
    for (const [gameId, evs] of map.entries()) {
      const launches = evs.filter(e => e.type === 'game_launch').length;
      const players = new Set(evs.map(e => e.userId || 'anon')).size;
      const ends = evs.filter(e => e.type === 'session_end');
      const avgSessionMs =
        ends.length > 0
          ? Math.round(
              ends.reduce(
                (s, e) => s + (Number(e.payload?.durationMs) || 0),
                0
              ) / ends.length
            )
          : 0;

      let revA = 0;
      let revG = 0;
      for (const e of evs.filter(
        e => e.type === 'voucher_tx' || e.type === 'market_tx'
      )) {
        const amt = Number(e.payload?.amount) || 0;
        const cur = String(e.payload?.currency || 'A币').toLowerCase();
        const isGameCoin = cur.includes('game') || cur.includes('游戏币') || cur === 'gc';
        if (isGameCoin) revG += amt;
        else revA += amt;
      }

      result.push({
        gameId,
        gamePlays: launches,
        uniquePlayers: players,
        avgSessionMs,
        revenueACoins: Math.round(revA * 100) / 100,
        revenueGameCoins: Math.round(revG * 100) / 100,
      });
    }

    return result.sort((a, b) => b.gamePlays - a.gamePlays);
  }

  // ========== 查询：玩家分布 ==========

  getPlayers(): PlayersStat {
    const now = Date.now();
    const day30 = now - 30 * 86400000;
    const today = ymd(now);

    // 首次出现日期
    const firstSeen = new Map<string, number>();
    for (const e of this.events) {
      const u = e.userId || 'anon';
      const ts = e.timestamp;
      if (!firstSeen.has(u) || ts < firstSeen.get(u)!) {
        firstSeen.set(u, ts);
      }
    }

    const allUsers = Array.from(firstSeen.keys());
    const totalPlayers = allUsers.length;

    const dauUsers = this.events
      .filter(e => e.date === today)
      .map(e => e.userId || 'anon');
    const dau = new Set(dauUsers).size;

    const mau = new Set(
      this.events.filter(e => e.timestamp >= day30).map(e => e.userId || 'anon')
    ).size;

    // 新增 vs 回流
    let newCount = 0;
    let returningCount = 0;
    for (const u of new Set(dauUsers)) {
      const fs = firstSeen.get(u)!;
      if (fs >= day30) newCount++;
      else returningCount++;
    }

    // 按角色（来自 login/register 的 payload.role）
    const byRole: Record<string, number> = {};
    for (const e of this.events) {
      const role = e.payload?.role;
      if (role && e.userId) {
        const r = String(role);
        byRole[r] = (byRole[r] || 0) + 1;
      }
    }

    // 按活跃分层（基于 30 天内事件数）
    const activityTier: Record<string, number> = {
      '高活跃 (≥10次)': 0,
      '中活跃 (3-9次)': 0,
      '低活跃/新 (<3次)': 0,
    };
    const eventCountByUser = new Map<string, number>();
    for (const e of this.events) {
      if (e.timestamp < day30) continue;
      const u = e.userId || 'anon';
      eventCountByUser.set(u, (eventCountByUser.get(u) || 0) + 1);
    }
    for (const cnt of eventCountByUser.values()) {
      if (cnt >= 10) activityTier['高活跃 (≥10次)']++;
      else if (cnt >= 3) activityTier['中活跃 (3-9次)']++;
      else activityTier['低活跃/新 (<3次)']++;
    }

    return {
      totalPlayers,
      dau,
      mau,
      newVsReturning: { new: newCount, returning: returningCount },
      byRole,
      byActivityTier: activityTier,
    };
  }

  // ========== 维护 ==========

  getEventCount(): number {
    return this.events.length;
  }

  clear(): void {
    this.events = [];
  }
}

// 导出单例
export const analyticsStore = new AnalyticsStore();
