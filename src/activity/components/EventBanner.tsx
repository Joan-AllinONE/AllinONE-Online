import { ActivityDef } from '../types';
import { isLimitedEventOpen } from '../engine/taskEngine';
import { ActivityIcon } from './ActivityIcon';

function countdown(endTime?: number): string {
  if (!endTime) return '';
  const ms = endTime - Date.now();
  if (ms <= 0) return '已结束';
  const d = Math.floor(ms / 86400000);
  const h = Math.floor((ms % 86400000) / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return d > 0 ? `剩 ${d} 天 ${h} 小时` : `剩 ${h} 小时 ${m} 分`;
}

export function EventBanner({ activities }: { activities: ActivityDef[] }) {
  const open = activities.filter((a) => a.type === 'limited_event' && isLimitedEventOpen(a));
  if (open.length === 0) return null;

  return (
    <div className="space-y-3">
      {open.map((a) => (
        <div
          key={a.id}
          className="relative overflow-hidden rounded-2xl border border-fuchsia-500/30 bg-gradient-to-r from-fuchsia-600/20 to-purple-600/20 p-5"
        >
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-fuchsia-500/20 text-fuchsia-200">
              <ActivityIcon name={a.icon} className="h-6 w-6" />
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <span className="rounded-full bg-fuchsia-500/30 px-2 py-0.5 text-[10px] font-semibold text-fuchsia-200">
                  限时
                </span>
                <h4 className="font-semibold text-white">{a.title}</h4>
              </div>
              <p className="mt-0.5 text-xs text-slate-300">{a.description}</p>
            </div>
            {a.endTime && (
              <span className="shrink-0 text-xs font-medium text-fuchsia-200">
                {countdown(a.endTime)}
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
