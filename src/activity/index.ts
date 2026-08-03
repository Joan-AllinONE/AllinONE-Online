/**
 * 活动中心模块 - 公开 API
 *
 * 该模块自包含、可复用：只需在应用启动处调用 installActivityModule(...) 即可挂载，
 * 不依赖平台其它业务模块。奖励统一通过传入的 SkillGateway 发放。
 */
import { SkillGateway } from '../skills/SkillGateway';
import { globalEventBus } from '../skills/EventBus';
import { ActivitySkill } from './skill/ActivitySkill';
import { ActivityTracker } from './skill/ActivityTracker';
import type { TrackedEvent } from './config';

export * from './types';
export { defaultActivities } from './seed/defaultActivities';
export { ActivityCenter } from './components/ActivityCenter';
export { ActivityRedDot } from './components/ActivityRedDot';
export { useActivity } from './hooks/useActivity';

export interface InstallOptions {
  gateway: SkillGateway;
  getUserId: () => string | null;
  getUserName?: () => string | undefined;
}

export interface ActivityModuleHandle {
  skill: ActivitySkill;
  tracker: ActivityTracker;
  /** 用户登录态变化时调用，重初始化追踪器 */
  setUser: (userId: string | null) => Promise<void>;
  dispose: () => void;
}

/** 安装活动中心模块：注册 Skill + 启动后台进度追踪器 */
export function installActivityModule(opts: InstallOptions): ActivityModuleHandle {
  const skill = new ActivitySkill({
    gateway: opts.gateway,
    getUserId: opts.getUserId,
    getUserName: opts.getUserName,
  });
  opts.gateway.registerSkill(skill);

  const tracker = new ActivityTracker();
  tracker.init(opts.getUserId);

  return {
    skill,
    tracker,
    async setUser() {
      await tracker.setUser(opts.getUserId);
    },
    dispose() {
      tracker.dispose();
      opts.gateway.unregisterSkill?.('activity');
    },
  };
}

/** 向事件总线发送活动追踪事件（供平台各流程埋点调用） */
export function trackActivityEvent(event: TrackedEvent, payload?: any): void {
  globalEventBus.emit(event, payload, { userId: 'anonymous', sessionId: 'web' });
}
