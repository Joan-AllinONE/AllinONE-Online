/**
 * 限时活动路由页（E3）：路由守卫 + 动态导入 + 状态占位
 *
 * - 路由 /activity/event/:slug；无活跃活动 → 占位页（不加载活动模块）
 * - scheduled → 倒计时预告（serverNow 校准）+ requestIdleCallback 预加载
 * - live/closing → import() 动态下载活动模块（独立 chunk）渲染
 * - 活动模块崩溃由 ErrorBoundary 兜底，不影响平台主功能
 */
import { Suspense, useCallback, useEffect, useRef, useState, ComponentType } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Hourglass, PartyPopper, Zap } from 'lucide-react';
import { useCurrentEvents, formatCountdown } from '../hooks/useCurrentEvents';
import { loadEventModule, preloadEventModule } from './registry';
import type { EventModuleProps } from './eventTunnel';

function EventSkeleton() {
  return (
    <div className="animate-pulse space-y-4">
      <div className="h-20 rounded-2xl bg-white/5" />
      <div className="h-32 rounded-2xl bg-white/5" />
      <div className="h-48 rounded-2xl bg-white/5" />
    </div>
  );
}

export default function EventPage() {
  const { slug = '' } = useParams();
  const { events, loading, serverNow, findBySlug, refresh } = useCurrentEvents();
  const [Module, setModule] = useState<ComponentType<EventModuleProps> | null>(null);
  const [, setTick] = useState(0);

  // 倒计时每秒重渲染
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const event = findBySlug(slug);
  // 已加载模块的 slug：避免每次轮询 setModule 产生新组件引用导致重挂载（状态丢失）
  const loadedSlugRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    if (!event || !['scheduled', 'live', 'closing'].includes(event.status)) return;
    // scheduled → 仅预加载不渲染；live/closing → 渲染
    if (event.status === 'scheduled') {
      preloadEventModule(slug);
      return;
    }
    if (loadedSlugRef.current === slug && Module) return; // 已加载，跳过
    const mod = await loadEventModule(slug);
    if (mod) {
      loadedSlugRef.current = slug;
      setModule(() => mod);
    }
  }, [event, slug, Module]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <Link to="/activity" className="mb-4 inline-flex items-center gap-1 text-sm text-slate-400 hover:text-white">
        <ArrowLeft className="h-4 w-4" /> 返回活动中心
      </Link>

      {loading && <EventSkeleton />}

      {!loading && !event && (
        <div className="rounded-2xl border border-white/10 bg-white/5 p-10 text-center">
          <PartyPopper className="mx-auto mb-3 h-10 w-10 text-slate-500" />
          <h2 className="mb-1 text-lg font-semibold text-white">活动未开始或已结束</h2>
          <p className="text-sm text-slate-400">该限时活动当前不在开放窗口内，去活动中心看看其他内容吧。</p>
        </div>
      )}

      {!loading && event?.status === 'scheduled' && (
        <div className="rounded-2xl border border-indigo-500/30 bg-gradient-to-br from-indigo-500/10 to-purple-500/10 p-10 text-center">
          <Hourglass className="mx-auto mb-3 h-10 w-10 animate-pulse text-indigo-300" />
          <h2 className="mb-1 text-xl font-bold text-white">{event.name} 即将开启</h2>
          <p className="mb-4 text-sm text-slate-400">{event.description || '敬请期待'}</p>
          <div className="mb-4 font-mono text-3xl font-bold text-indigo-300">
            {formatCountdown(event.startTime - serverNow())}
          </div>
          <p className="inline-flex items-center gap-1 text-xs text-slate-500">
            <Zap className="h-3 w-3" /> 活动资源已预加载，到点秒开
          </p>
        </div>
      )}

      {!loading && event && ['live', 'closing'].includes(event.status) && (
        <Suspense fallback={<EventSkeleton />}>
          {Module ? (
            <Module event={event} />
          ) : (
            <div className="rounded-2xl border border-white/10 bg-white/5 p-10 text-center text-sm text-slate-400">
              活动模块加载中…（未注册的活动类型：<code>{slug}</code>）
            </div>
          )}
        </Suspense>
      )}

      {!loading && event?.status === 'closing' && (
        <p className="mt-4 text-center text-xs text-slate-500">
          活动已结束，结算进行中；已达成的奖励仍可补领（宽限期 {event.graceHours} 小时）。
          <button onClick={refresh} className="ml-1 underline hover:text-white">刷新</button>
        </p>
      )}
    </div>
  );
}
