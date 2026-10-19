/**
 * Grand Building 型限时活动模块（E4：分阶段大型活动）
 *
 * 独立 chunk。展示「建造进度」= 全服阶段进度（stageProgress），
 * 玩家在本阶段提交贡献（stage_contrib），阶段达标后可领阶段奖励。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Building2, Hammer, Trophy, Timer } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '../../../contexts/authContext';
import {
  EventModuleProps,
  joinEvent,
  submitEvent,
  fetchEventProgress,
  fetchEventDetail,
  claimEventReward,
  EventProgress,
} from '../eventTunnel';
import { formatCountdown } from '../../hooks/useCurrentEvents';

interface StageInfo {
  id: string;
  index: number;
  name: string;
  startTime: number;
  endTime: number;
  goal: { metric: string; target: number };
}

export default function GrandBuildingModule({ event }: EventModuleProps) {
  const { currentUser } = useAuth();
  const userId = currentUser?.uid || null;
  const [progress, setProgress] = useState<EventProgress | null>(null);
  const [stages, setStages] = useState<StageInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [, setTick] = useState(0);
  // fetch 时刻补偿：serverNow 是冻结值，否则倒计时不走秒
  const fetchedAtRef = useRef(0);

  const refresh = useCallback(async () => {
    if (!userId) return;
    const p = await fetchEventProgress(event.id);
    fetchedAtRef.current = Date.now();
    setProgress(p);
  }, [event.id, userId]);

  useEffect(() => {
    fetchEventDetail(event.id)
      .then((d) => setStages(d?.event?.config?.stages || []))
      .catch(() => {});
    refresh();
  }, [event.id, refresh]);

  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const serverNow = (progress?.serverNow || event.serverNow) + (Date.now() - (fetchedAtRef.current || Date.now()));
  const currentStage = stages.find((s) => serverNow >= s.startTime && serverNow < s.endTime) || null;
  const joined = !!progress?.participation;

  const handleJoin = async () => {
    if (!userId) return toast.error('请先登录');
    setBusy(true);
    try {
      await joinEvent(event.id);
      toast.success('已加入工程队！');
      await refresh();
    } catch (e: any) {
      toast.error(e?.message || '加入失败');
    } finally {
      setBusy(false);
    }
  };

  const handleContribute = async () => {
    if (!userId || !currentStage) return;
    setBusy(true);
    try {
      await submitEvent(event.id, currentStage.goal.metric, 1);
      toast.success('贡献 +1，工程又前进了一步！');
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

  const stageProgressOf = (stageId: string) => progress?.stageProgress?.find((s) => s.stageId === stageId);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-500/30 bg-gradient-to-r from-amber-500/10 to-orange-500/10 p-4">
        <div className="flex items-center gap-2">
          <Building2 className="h-6 w-6 text-amber-300" />
          <div>
            <h2 className="text-lg font-bold text-white">{event.name}</h2>
            <p className="text-xs text-slate-400">{event.description || '全服协作，分阶段共建宏伟建筑'}</p>
          </div>
        </div>
        <div className="flex items-center gap-1.5 rounded-xl bg-white/5 px-3 py-1.5 text-sm text-slate-300">
          <Timer className="h-4 w-4 text-amber-300" />
          {event.status === 'closing'
            ? '已结束 · 补领中'
            : `剩余 ${formatCountdown(Math.max(0, event.endTime - serverNow))}`}
        </div>
      </div>

      {/* 建造进度：阶段时间线 */}
      <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
        <h3 className="mb-4 flex items-center gap-1.5 text-sm font-semibold text-white">
          <Building2 className="h-4 w-4 text-amber-300" /> 建造进度
        </h3>
        <div className="space-y-3">
          {stages.map((s) => {
            const prog = stageProgressOf(s.id);
            const pct = Math.min(100, Math.round(((prog?.current || 0) / s.goal.target) * 100));
            const done = !!prog?.completedAt;
            const active = currentStage?.id === s.id;
            return (
              <div key={s.id} className={`rounded-xl border p-3 ${active ? 'border-amber-400/50 bg-amber-500/10' : 'border-white/10 bg-white/5'}`}>
                <div className="mb-1.5 flex items-center justify-between text-sm">
                  <span className="font-medium text-white">
                    第 {s.index} 阶段 · {s.name} {done && '✅'} {active && '🔨'}
                  </span>
                  <span className="text-slate-400">{prog?.current || 0}/{s.goal.target}</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-white/10">
                  <div
                    className={`h-full rounded-full transition-all ${done ? 'bg-emerald-500' : 'bg-gradient-to-r from-amber-400 to-orange-500'}`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>
            );
          })}
          {stages.length === 0 && <p className="text-sm text-slate-400">暂无阶段数据</p>}
        </div>
      </div>

      {/* 参与操作 */}
      <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
        {currentStage ? (
          <>
            <p className="mb-3 text-sm text-slate-300">
              当前阶段：<span className="font-semibold text-amber-300">{currentStage.name}</span>
              （个人贡献 {progress?.participation?.stageContrib?.[currentStage.id] || 0}）
            </p>
            {!joined ? (
              <button
                onClick={handleJoin}
                disabled={busy || event.status !== 'live'}
                className="w-full rounded-xl bg-gradient-to-r from-amber-500 to-orange-500 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-40"
              >
                加入工程队
              </button>
            ) : (
              <button
                onClick={handleContribute}
                disabled={busy || event.status !== 'live'}
                className="inline-flex w-full items-center justify-center gap-1.5 rounded-xl bg-gradient-to-r from-amber-500 to-orange-500 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-40"
              >
                <Hammer className="h-4 w-4" /> 投入建设（贡献 +1）
              </button>
            )}
          </>
        ) : (
          <p className="text-sm text-slate-400">
            {event.status === 'closing' ? '活动已结束，可领取已达成奖励' : '当前不在任何阶段窗口内'}
          </p>
        )}
      </div>

      {/* 阶段奖励 */}
      <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
        <h3 className="mb-3 flex items-center gap-1.5 text-sm font-semibold text-white">
          <Trophy className="h-4 w-4 text-amber-300" /> 阶段奖励
        </h3>
        <div className="space-y-2">
          {(progress?.claimables || []).map((c) => (
            <div key={c.rewardId} className="flex items-center justify-between rounded-xl bg-white/5 p-3">
              <div>
                <p className="text-sm font-medium text-white">{c.label}</p>
                <p className="text-xs text-slate-400">
                  进度 {c.progress.current}/{c.progress.target ?? '—'} · 奖励 {c.reward.amount} 游戏币
                </p>
              </div>
              <button
                onClick={() => handleClaim(c.rewardId)}
                disabled={busy || !c.claimable}
                className="rounded-lg bg-gradient-to-r from-amber-500 to-orange-500 px-4 py-1.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-30"
              >
                {c.claimed ? '已领取' : c.claimable ? '领取' : '未达标'}
              </button>
            </div>
          ))}
          {(!progress?.claimables || progress.claimables.length === 0) && (
            <p className="text-sm text-slate-400">{userId ? '暂无可领取奖励' : '登录后可查看奖励'}</p>
          )}
        </div>
      </div>
    </div>
  );
}
