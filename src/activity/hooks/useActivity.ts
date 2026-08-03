import { useCallback, useEffect, useState } from 'react';
import { skillGateway } from '../../skills/index';
import { ActivityDef, ProgressRecord, LeaderboardEntry } from '../types';
import { PROGRESS_EVENT } from '../skill/ActivityTracker';

/** 活动中心 React Hook：封装活动读取、进度查询与各类操作 */
export function useActivity(userId: string | null | undefined) {
  const [activities, setActivities] = useState<ActivityDef[]>([]);
  const [progress, setProgress] = useState<ProgressRecord[]>([]);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const ctx = (uid: string) => ({ userId: uid, sessionId: 'activity' });

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      // 活动列表无需登录即可浏览；仅进度/领奖需要 userId。
      // 此前提早用 !userId 直接 return 并把 activities 置空，导致未登录/登录态未就绪时
      // 活动中心只剩 tab 栏、无任何内容（已修复）。
      const acts = await skillGateway.execute(
        'activity',
        'getActivities',
        {},
        ctx(userId || 'anon')
      );
      // skillGateway 可能把非数组数据透传（如后端/ SW 返回 { data: null }），
      // 必须确保 activities 始终是数组，否则 ActivityCenter 的 .filter 会崩溃。
      const actsData = acts.success && Array.isArray(acts.data) ? acts.data : [];
      setActivities(actsData);

      if (userId) {
        const prog = await skillGateway.execute('activity', 'getProgress', {}, ctx(userId));
        setProgress(prog.success ? prog.data || [] : []);
      } else {
        setProgress([]);
      }
    } catch (e) {
      console.warn('[useActivity] 加载失败', e);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  const refreshLeaderboard = useCallback(async () => {
    try {
      const r = await skillGateway.execute('activity', 'getLeaderboard', {}, ctx(userId || 'anon'));
      setLeaderboard(r.success ? r.data || [] : []);
    } catch {
      /* ignore */
    }
  }, [userId]);

  useEffect(() => {
    refresh();
    refreshLeaderboard();
  }, [refresh, refreshLeaderboard]);

  // 监听后台追踪器进度更新（ActivityTracker 通过 window CustomEvent 派发），
  // 使任务进度条 / 红点 / 成就墙在 game.published、vote.cast 等事件后自动刷新。
  useEffect(() => {
    if (!userId) return;
    const onProgress = () => refresh();
    window.addEventListener(PROGRESS_EVENT, onProgress);
    return () => window.removeEventListener(PROGRESS_EVENT, onProgress);
  }, [userId, refresh]);

  const claim = useCallback(
    async (activityId: string) => {
      const r = await skillGateway.execute('activity', 'claim', { activityId }, ctx(userId!));
      await refresh();
      if (!r.success) throw new Error(r.error?.message || '领取失败');
      return r.data;
    },
    [userId, refresh]
  );

  const checkin = useCallback(
    async (activityId: string) => {
      const r = await skillGateway.execute('activity', 'checkin', { activityId }, ctx(userId!));
      await refresh();
      if (!r.success) throw new Error(r.error?.message || '签到失败');
      return r.data;
    },
    [userId, refresh]
  );

  const drawLottery = useCallback(
    async (activityId: string) => {
      const r = await skillGateway.execute('activity', 'drawLottery', { activityId }, ctx(userId!));
      await refresh();
      if (!r.success) throw new Error(r.error?.message || '抽奖失败');
      return r.data;
    },
    [userId, refresh]
  );

  const getProgress = (activityId: string) => progress.find((p) => p.activityId === activityId);
  const pendingCount = progress.filter((p) => p.status === 'completed').length;

  return {
    activities,
    progress,
    leaderboard,
    loading,
    refresh,
    refreshLeaderboard,
    claim,
    checkin,
    drawLottery,
    getProgress,
    pendingCount,
  };
}
