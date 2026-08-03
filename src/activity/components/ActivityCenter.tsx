import { useMemo, useState } from 'react';
import { Copy, Gift, Trophy, Dices, UserPlus, BarChart3, CalendarCheck, ListChecks } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '../../contexts/authContext';
import { useWallet } from '../../hooks/useWallet';
import { useActivity } from '../hooks/useActivity';
import { DailyCheckIn } from './DailyCheckIn';
import { TaskList } from './TaskList';
import { EventBanner } from './EventBanner';
import { AchievementGrid } from './AchievementGrid';
import { LotteryWheel } from './LotteryWheel';
import { Leaderboard } from './Leaderboard';
import { RewardBadge } from './RewardBadge';

type TabKey = 'checkin' | 'task' | 'achievement' | 'lottery' | 'invite' | 'rank';

const TABS: { key: TabKey; label: string; icon: any }[] = [
  { key: 'checkin', label: '签到', icon: CalendarCheck },
  { key: 'task', label: '任务', icon: ListChecks },
  { key: 'achievement', label: '成就', icon: Trophy },
  { key: 'lottery', label: '抽奖', icon: Dices },
  { key: 'invite', label: '邀请', icon: UserPlus },
  { key: 'rank', label: '排行', icon: BarChart3 },
];

export function ActivityCenter() {
  const { currentUser } = useAuth();
  const userId = currentUser?.uid || null;
  const { wallet } = useWallet();
  const { activities, leaderboard, loading, claim, checkin, drawLottery, getProgress, pendingCount, refreshLeaderboard } =
    useActivity(userId);
  const [tab, setTab] = useState<TabKey>('checkin');

  const grouped = useMemo(() => {
    return {
      checkin: activities.filter((a) => a.type === 'daily_checkin'),
      tasks: activities.filter(
        (a) => a.type === 'onboarding' || a.type === 'growth' || a.type === 'limited_event'
      ),
      achievements: activities.filter((a) => a.type === 'achievement'),
      lottery: activities.filter((a) => a.type === 'lottery'),
      invite: activities.filter((a) => a.type === 'invite'),
    };
  }, [activities]);

  const copyInvite = () => {
    if (!userId) return;
    const url = `${window.location.origin}${window.location.pathname}?invite=${userId}`;
    navigator.clipboard?.writeText(url).then(
      () => toast.success('邀请链接已复制'),
      () => toast.error('复制失败')
    );
  };

  const invite = grouped.invite[0];
  const inviteProgress = invite ? getProgress(invite.id) : undefined;

  const handleClaimInvite = async () => {
    if (!invite) return;
    try {
      const r = await claim(invite.id);
      toast.success(`领取成功，获得 ${r?.total || 0} 游戏币！`);
    } catch (e: any) {
      toast.error(e?.message || '领取失败');
    }
  };

  if (loading) {
    return <div className="py-20 text-center text-slate-400">活动加载中…</div>;
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-white">
            <Gift className="h-6 w-6 text-fuchsia-400" /> 活动中心
          </h1>
          <p className="mt-1 text-sm text-slate-400">完成任务、签到抽奖，赢取游戏币奖励</p>
        </div>
        {pendingCount > 0 && (
          <span className="rounded-full bg-rose-500 px-3 py-1 text-sm font-semibold text-white">
            可领取 {pendingCount}
          </span>
        )}
      </div>

      {/* Tab 栏 */}
      <div className="mb-6 flex flex-wrap gap-2">
        {TABS.map((t) => {
          const Icon = t.icon;
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              onClick={() => {
                setTab(t.key);
                if (t.key === 'rank') refreshLeaderboard();
              }}
              className={`inline-flex items-center gap-1.5 rounded-xl px-4 py-2 text-sm font-medium transition ${
                active
                  ? 'bg-gradient-to-r from-indigo-500 to-purple-500 text-white'
                  : 'bg-white/5 text-slate-300 hover:bg-white/10'
              }`}
            >
              <Icon className="h-4 w-4" />
              {t.label}
            </button>
          );
        })}
      </div>

      <div className="space-y-6">
        {tab === 'checkin' && (
          <>
            <EventBanner activities={activities} />
            {grouped.checkin.map((a) => (
              <DailyCheckIn
                key={a.id}
                activity={a}
                progress={getProgress(a.id)}
                onCheckIn={() => checkin(a.id)}
              />
            ))}
          </>
        )}

        {tab === 'task' && (
          <TaskList activities={grouped.tasks} getProgress={getProgress} onClaim={claim} />
        )}

        {tab === 'achievement' && (
          <AchievementGrid activities={grouped.achievements} getProgress={getProgress} />
        )}

        {tab === 'lottery' &&
          grouped.lottery.map((a) => (
            <LotteryWheel
              key={a.id}
              activity={a}
              walletCoins={wallet?.gameCoins || 0}
              onDraw={() => drawLottery(a.id)}
            />
          ))}

        {tab === 'invite' && invite && (
          <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
            <div className="mb-3 flex items-center gap-2">
              <UserPlus className="h-5 w-5 text-emerald-400" />
              <h3 className="text-lg font-semibold text-white">{invite.title}</h3>
            </div>
            <p className="mb-4 text-sm text-slate-400">{invite.description}</p>
            <div className="flex items-center gap-2 rounded-xl bg-white/5 p-3">
              <code className="flex-1 truncate text-sm text-indigo-300">
                {window.location.origin}
                {window.location.pathname}?invite={userId || ''}
              </code>
              <button
                onClick={copyInvite}
                className="inline-flex items-center gap-1 rounded-lg bg-indigo-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-600"
              >
                <Copy className="h-4 w-4" /> 复制
              </button>
            </div>
            {invite.invite?.rewardPerInvitee && (
              <div className="mt-3 flex items-center justify-between">
                <span className="text-sm text-slate-300">
                  邀请奖励：
                  <RewardBadge reward={invite.invite.rewardPerInvitee} />
                </span>
                <button
                  onClick={handleClaimInvite}
                  disabled={inviteProgress?.status !== 'completed'}
                  className="rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {inviteProgress?.status === 'claimed' ? '已领取' : '领取邀请奖励'}
                </button>
              </div>
            )}
            <p className="mt-3 text-xs text-slate-500">
              说明：通过你的邀请链接注册的新用户，可在本机领取邀请奖励（跨浏览器邀请人奖励需平台钱包打通，当前版本暂未开放）。
            </p>
          </div>
        )}

        {tab === 'rank' && <Leaderboard entries={leaderboard} />}
      </div>
    </div>
  );
}
