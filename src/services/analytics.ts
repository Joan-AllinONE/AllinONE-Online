/**
 * 平台数据中心 - 客户端埋点发射器
 *
 * 职责：
 *   1. track(type, opts) 收集用户行为事件
 *   2. 本地队列（内存 + localStorage 兜底）+ 批量上报到后端 POST /api/v1/analytics/events
 *   3. 页面隐藏/卸载时用 sendBeacon 兜底 flush（避免会话结束时丢最后一条事件）
 *
 * 设计取舍：
 *   - 事件只落后端 memory 库（不走 CloudBase，避免 auth 损坏影响），与 gameFiles 通道一致
 *   - 默认始终上报（本地联调与线上均需要真实数据）；可用 VITE_ANALYTICS_DISABLED=true 关闭
 *   - 无后端可达时静默失败，不影响正常游戏体验
 */
import { getToken } from './authTokenService';

export type AnalyticsEventType =
  | 'register'
  | 'login'
  | 'logout'
  | 'game_launch'
  | 'session_start'
  | 'session_end'
  | 'voucher_tx'
  | 'market_tx';

export interface AnalyticsEventInput {
  type: AnalyticsEventType;
  userId?: string;
  gameId?: string;
  payload?: Record<string, any>;
  timestamp?: number;
}

export interface AnalyticsEvent extends AnalyticsEventInput {
  timestamp: number;
  date: string;
}

const ENDPOINT = '/api/v1/analytics/events';
const QUEUE_KEY = 'allinone_analytics_queue';
const ANON_KEY = 'allinone_analytics_anon';
const FLUSH_THRESHOLD = 10;
const FLUSH_INTERVAL_MS = 15000;

function isEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  if (import.meta.env.VITE_ANALYTICS_DISABLED === 'true') return false;
  return true;
}

function getAnonId(): string {
  try {
    let id = localStorage.getItem(ANON_KEY);
    if (!id) {
      id = 'anon-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
      localStorage.setItem(ANON_KEY, id);
    }
    return id;
  } catch {
    return 'anon-fallback';
  }
}

// ==================== 队列 ====================

let queue: AnalyticsEvent[] = [];
let flushing = false;

function loadQueue(): void {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    if (raw) queue = JSON.parse(raw);
  } catch {
    queue = [];
  }
}

function persistQueue(): void {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  } catch {
    /* ignore quota errors */
  }
}

loadQueue();

// ==================== 上报 ====================

async function flush(): Promise<void> {
  if (flushing || queue.length === 0 || !isEnabled()) return;
  flushing = true;
  const batch = queue.splice(0, 500);
  persistQueue();
  try {
    await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: batch }),
      keepalive: true,
    });
  } catch {
    // 上报失败：归还队列，下次重试
    queue = batch.concat(queue);
    persistQueue();
  } finally {
    flushing = false;
  }
}

function scheduleFlush(): void {
  if (queue.length >= FLUSH_THRESHOLD) void flush();
}

// ==================== 对外 API ====================

export function track(input: AnalyticsEventInput): void {
  if (!isEnabled()) return;
  const ts = input.timestamp ?? Date.now();
  const date = new Date(ts).toISOString().slice(0, 10);
  const userId = input.userId || getAnonId();
  queue.push({ ...input, userId, timestamp: ts, date });
  persistQueue();
  scheduleFlush();
}

// 页面隐藏/卸载时兜底 flush（优先 sendBeacon）
if (typeof window !== 'undefined') {
  const beaconFlush = () => {
    if (queue.length === 0) return;
    const batch = queue.splice(0, 500);
    persistQueue();
    try {
      const blob = new Blob([JSON.stringify({ events: batch })], {
        type: 'application/json',
      });
      if (navigator.sendBeacon) navigator.sendBeacon(ENDPOINT, blob);
    } catch {
      /* ignore */
    }
  };
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') beaconFlush();
  });
  window.addEventListener('pagehide', beaconFlush);
  // 周期 flush 兜底
  setInterval(() => void flush(), FLUSH_INTERVAL_MS);
}

// ==================== 查询助手（供 DataCenter 页使用） ====================

/**
 * 带鉴权地拉取数据中心接口。
 * 复用 authTokenService.getToken() 获取 dev-token（角色 player），后端鉴权 middleware 接受任意有效 token。
 */
export async function fetchAnalytics<T = any>(
  path: string
): Promise<T | null> {
  try {
    const token = await getToken();
    if (!token) return null;
    const res = await fetch(`/api/v1/analytics/${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json?.data ?? null;
  } catch {
    return null;
  }
}
