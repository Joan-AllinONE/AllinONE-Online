/**
 * Freon 型限时活动模块（E3 示例：资源收集活动）
 *
 * 独立 chunk：仅当 /current 返回该 slug 的 scheduled/live 信号时才被动态 import。
 * 玩法：活动期间通过「参与游戏产出」按钮提交 Freon（后端三重校验+限流），
 * 达标后自助领取 threshold/participation 奖励。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Snowflake, Trophy, Package, Timer } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '../../../contexts/authContext';
import {
  EventModuleProps,
  joinEvent,
  submitEvent,
  fetchEventProgress,
  claimEventReward,
  EventProgress,
} from '../eventTunnel';
import { formatCountdown } from '../../hooks/useCurrentEvents';

export default function FreonModule({ event }: EventModuleProps) {
  const { currentUser } = useAuth();
  const userId = currentUser?.uid || null;
  const [progress, setProgress] = useState<EventProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [, setTick] = useState(0);
  // fetch 时刻：serverNow 是冻结值，须补偿本地已流逝时间倒计时才会走秒
  const fetchedAtRef = useRef(0);

  const refresh = useCallback(async () => {
    if (!userId) return;
    const p = await fetchEventProgress(event.id);
    fetchedAtRef.current = Date.now();
    setProgress(p);
  }, [event.id, userId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // 倒计时每秒刷新（后端 serverNow 校准 + 本地流逝补偿）
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const serverNow = (progress?.serverNow || event.serverNow) + (Date.now() - (fetchedAtRef.current || Date.now()));
  const remainMs = Math.max(0, event.endTime - serverNow);

  const handleJoin = async () => {
    if (!userId) return toast.error('请先登录');
    setBusy(true);
    try {
      await joinEvent(event.id);
      toast.success('已加入活动，开始收集吧！');
      await refresh();
    } catch (e: any) {
      toast.error(e?.message || '加入失败');
    } finally {
      setBusy(false);
    }
  };

  const handleHarvest = async () => {
    if (!userId) return toast.error('请先登录');
    setBusy(true);
    try {
      // 单次提交量（后端 maxValuePerSubmit 校验；这里按 1~5 随机模拟游戏产出）
      await submitEvent(event.id, event.metric, 1 + Math.floor(Math.random() * 4));
      toast.success('收集成功！');
      await refresh();
    } catch (e: any) {
      toast.error(e?.message || '提交失败');
    } finally {
      setBusy(false);
    }
  };

  const handleClaim = async (rewardId: string) => {
    setBusy(true);
    try {
      const r = await claimEventReward(event.id, rewardId);
      toast.success(r?.data?.alreadyGranted ? '该奖励已领取过' : `领取成功 +${r?.data?.amount} 游戏币`);
      await refresh();
    } catch (e: any) {
      toast.error(e?.message || '领取失败');
    } finally {
      setBusy(false);
    }
  };

  const metric = event.metric || 'freon';
  const collected = progress?.participation?.metrics?.[metric] || 0;
  const joined = !!progress?.participation;

  return (
    <div className="space-y-5">
      {/* 顶部：状态条 */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-cyan-500/30 bg-gradient-to-r from-cyan-500/10 to-blue-500/10 p-4">
        <div className="flex items-center gap-2">
          <Snowflake className="h-6 w-6 text-cyan-300" />
          <div>
            <h2 className="text-lg font-bold text-white">{event.name}</h2>
            <p className="text-xs text-slate-400">{event.description || '活动期间收集资源，达标领取奖励'}</p>
          </div>
        </div>
        <div className="flex items-center gap-1.5 rounded-xl bg-white/5 px-3 py-1.5 text-sm text-slate-300">
          <Timer className="h-4 w-4 text-cyan-300" />
          {event.status === 'closing' ? '已结束 · 补领中' : `剩余 ${formatCountdown(remainMs)}`}
        </div>
      </div>

      {/* 收集进度 */}
      <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
        <div className="mb-2 flex items-center justify-between">
          <span className="flex items-center gap-1.5 text-sm font-medium text-slate-300">
            <Package className="h-4 w-4 text-cyan-300" /> 已收集 {metric}
          </span>
          <span className="text-2xl font-bold text-cyan-300">{collected}</span>
        </div>
        {!joined ? (
          <button
            onClick={handleJoin}
            disabled={busy || event.status !== 'live'}
            className="w-full rounded-xl bg-gradient-to-r from-cyan-500 to-blue-500 px-4 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            加入活动
          </button>
        ) : (
          <button
            onClick={handleHarvest}
            disabled={busy || event.status !== 'live'}
            className="w-full rounded-xl bg-gradient-to-r from-cyan-500 to-blue-500 px-4 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            参与游戏产出 {metric}
          </button>
        )}
      </div>

      {/* 奖励列表 */}
      <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
        <h3 className="mb-3 flex items-center gap-1.5 text-sm font-semibold text-white">
          <Trophy className="h-4 w-4 text-amber-300" /> 活动奖励
        </h3>
        {!userId && <p className="text-sm text-slate-400">登录后可查看与领取奖励</p>}
        {userId && (progress?.claimables || []).length === 0 && (
          <p className="text-sm text-slate-400">本活动暂无可自助领取的奖励（排行榜奖励由结算自动发放）</p>
        )}
        <div className="space-y-2">
          {(progress?.claimables || []).map((c) => (
            <div key={c.rewardId} className="flex items-center justify-between rounded-xl bg-white/5 p-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-white">{c.label}</p>
                <p className="text-xs text-slate-400">
                  {c.progress.target !== null
                    ? `进度 ${c.progress.current}/${c.progress.target}`
                    : `已收集 ${c.progress.current}`}
                  {' · '}
                  奖励 {c.reward.amount} 游戏币
                </p>
              </div>
              <button
                onClick={() => handleClaim(c.rewardId)}
                disabled={busy || !c.claimable}
                className="shrink-0 rounded-lg bg-gradient-to-r from-amber-500 to-orange-500 px-4 py-1.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-30"
              >
                {c.claimed ? '已领取' : c.claimable ? '领取' : '未达标'}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
