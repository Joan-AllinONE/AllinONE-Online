/** 活动中心模块 - 常量配置
 * 线上 HTTP 访问服务只把 /api/v1/games/* 路由到 gamesApi 云函数，
 * /api/v1/activities/* 无法直达（404）。前端统一走 /api/v1/games/__activities 隧道，
 * 云函数内部剥掉 __activities 前缀后按 /api/v1/activities 处理。
 * SW 也会把 /api/v1/games/* 正常代理到后端。 */
export const ACTIVITY_API_BASE = '/api/v1/games/__activities';
export const DAY_MS = 86400000;

/** 进度缓存（localStorage，按用户隔离） */
export const progressKey = (userId: string) => `allinone_activity_progress_${userId}`;
/** 活动列表缓存（localStorage） */
export const ACTIVITY_CACHE_KEY = 'allinone_activities_cache';
/** 每日登录去重标记 */
export const dailyLoginKey = (userId: string) => `allinone_daily_login_${userId}`;

/** ActivityTracker 订阅的事件 */
export const TRACKED_EVENTS = [
  'game.played',
  'vote.cast',
  'game.published',
  'daily.login',
  'user.registered',
] as const;

export type TrackedEvent = (typeof TRACKED_EVENTS)[number];
