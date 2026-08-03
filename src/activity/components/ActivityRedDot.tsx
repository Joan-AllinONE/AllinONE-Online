import { useActivity } from '../hooks/useActivity';

/** 活动红点：当有可领取奖励时显示。用于首页/导航栏入口。 */
export function ActivityRedDot({
  userId,
  className = '',
}: {
  userId: string | null | undefined;
  className?: string;
}) {
  const { pendingCount } = useActivity(userId);
  if (!userId || pendingCount <= 0) return null;
  return (
    <span
      className={`inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-bold text-white ${className}`}
    >
      {pendingCount > 99 ? '99+' : pendingCount}
    </span>
  );
}
