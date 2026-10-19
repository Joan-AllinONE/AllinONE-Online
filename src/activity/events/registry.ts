/**
 * 限时活动模块注册表（E3 动态导入核心）
 *
 * 映射表本身 <1KB 随主包；活动模块体是独立 chunk，仅当后端 /current
 * 返回 scheduled/live 信号时才由前端 import() 按需下载——活动未开启
 * 用户不下载无用代码，不影响首屏性能。
 */
import type { EventModuleProps } from './eventTunnel';

export type EventModuleComponent = (props: EventModuleProps) => any;

const EVENT_MODULES: Record<string, () => Promise<{ default: EventModuleComponent }>> = {
  // Freon 型：资源收集活动
  freon: () => import('./freon'),
  // Grand Building 型：分阶段大型活动
  'grand-building': () => import('./grand-building'),
};

/** 预加载（scheduled 期 requestIdleCallback 调用；到点秒开） */
export function preloadEventModule(slug: string): void {
  const loader = EVENT_MODULES[slug];
  if (loader) loader().catch(() => {});
}

/** 加载活动模块；slug 未注册返回 null（活动未开启不影响主功能） */
export async function loadEventModule(slug: string): Promise<EventModuleComponent | null> {
  const loader = EVENT_MODULES[slug];
  if (!loader) return null;
  try {
    const mod = await loader();
    return mod.default || null;
  } catch {
    return null;
  }
}

/** 已注册的活动 slug（运营后台提示用） */
export function registeredEventSlugs(): string[] {
  return Object.keys(EVENT_MODULES);
}
