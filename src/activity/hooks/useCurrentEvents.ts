/**
 * 限时活动 Hook（E3）：轮询 /current + serverNow 时钟偏移校准
 *
 * 倒计时一律使用后端 serverNow 偏移（offset = serverNow - Date.now()），
 * 绝不信任客户端本地时钟。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchCurrentEvents, CurrentEventSummary } from '../events/eventTunnel';
import { preloadEventModule } from '../events/registry';

const POLL_MS = 30_000;

export function useCurrentEvents() {
  const [events, setEvents] = useState<CurrentEventSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [clockOffset, setClockOffset] = useState(0); // serverNow - Date.now()
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const { serverNow, events: list } = await fetchCurrentEvents();
      setEvents(list);
      setClockOffset(serverNow - Date.now());
      // scheduled 期预加载模块（到点秒开）；live 亦确保已加载
      for (const e of list) {
        if (e.status === 'scheduled' || e.status === 'live') {
          if (typeof requestIdleCallback === 'function') {
            requestIdleCallback(() => preloadEventModule(e.slug));
          } else {
            preloadEventModule(e.slug);
          }
        }
      }
    } catch {
      /* 网络失败保留上次结果 */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    timerRef.current = setInterval(refresh, POLL_MS);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [refresh]);

  /** 后端校准时间（本地时钟 + 偏移） */
  const serverNow = () => Date.now() + clockOffset;

  const findBySlug = (slug: string) => events.find((e) => e.slug === slug) || null;

  return { events, loading, refresh, serverNow, findBySlug, clockOffset };
}

/** 格式化倒计时（dd hh:mm:ss） */
export function formatCountdown(ms: number): string {
  if (ms <= 0) return '00:00:00';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return d > 0 ? `${d}天 ${pad(h)}:${pad(m)}:${pad(sec)}` : `${pad(h)}:${pad(m)}:${pad(sec)}`;
}
