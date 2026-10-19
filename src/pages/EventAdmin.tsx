/**
 * 限时活动运营后台（E4）：配置即数据——改时间/奖励/开关无需发版
 *
 * 路由 /event-admin。权限：JWT role=admin/platform（服务端 __event/admin/* 强制校验，
 * 本页隐藏仅是展示，不是安全边界）。支持：
 * - 活动列表（时间窗口筛选器：全部/进行中/预热中/已结束/已归档/周期系列）
 * - 创建活动（freon / grand-building 模板一键填充）
 * - 修改时间窗、开关、灰度（percent/whitelist）
 * - 紧急下线 force-stop、手动重结算 resettle（幂等，只补漏发）
 */
import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Ban, RefreshCw, Save, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { API_BASE, authHeaders } from '../services/backendSync';

const BASE = `${API_BASE}/v1/games/__event`;

interface EventRow {
  _id?: string;
  id: string;
  slug: string;
  name: string;
  type: string;
  status: string;
  enabled: boolean;
  forceStopAt?: number;
  startTime: number;
  endTime: number;
  graceHours: number;
  repeat?: { unit: string; count?: number } | null;
  rollout?: { mode: string; percent?: number; whitelist?: string[] };
  rewardRules: any[];
  config: any;
  settleManifest?: any;
}

const T = (ms: number) => new Date(ms).toISOString().slice(0, 16);

/** freon / grand-building 模板（运营一键填充后可改） */
function template(kind: 'freon' | 'grand-building', now: number): any {
  if (kind === 'freon') {
    return {
      slug: 'freon',
      name: 'Freon 收集周',
      type: 'collect',
      startTime: now + 3600_000,
      endTime: now + 7 * 86400_000,
      leadHours: 24,
      graceHours: 72,
      config: {
        metric: 'freon',
        description: '活动期间通过游戏产出收集 Freon，达标领奖',
        maxValuePerSubmit: 5,
        dailySubmitCap: 20,
        leaderboardMetric: 'freon',
        dropChannels: [{ channel: 'game_play', rate: 1, dailyCap: 20 }],
      },
      rewardRules: [
        { id: 'rw_freon_10', kind: 'threshold', metric: 'freon', threshold: 10, reward: { currency: 'gamecoin', amount: 100 } },
        { id: 'rw_freon_50', kind: 'threshold', metric: 'freon', threshold: 50, reward: { currency: 'gamecoin', amount: 500 } },
        { id: 'rw_freon_top3', kind: 'leaderboard', metric: 'freon', rankRange: [0, 2], reward: { currency: 'gamecoin', amount: 1000 } },
        { id: 'rw_freon_join', kind: 'participation', metric: 'freon', reward: { currency: 'gamecoin', amount: 20 } },
      ],
      rollout: { mode: 'all' },
    };
  }
  const s1s = now + 3600_000;
  return {
    slug: 'grand-building',
    name: '共建摩天大楼',
    type: 'staged',
    startTime: s1s,
    endTime: s1s + 14 * 86400_000,
    leadHours: 24,
    graceHours: 72,
    config: {
      metric: 'stage_contrib',
      description: '全服协作分阶段共建，每阶段达标领奖',
      maxValuePerSubmit: 3,
      dailySubmitCap: 30,
      leaderboardMetric: 'stage_contrib',
      stages: [
        { id: 'stg_gb_1', index: 1, name: '地基', startTime: s1s, endTime: s1s + 7 * 86400_000, goal: { metric: 'bricks', target: 100 }, rewards: [{ id: 'rw_gb_s1', kind: 'threshold', metric: 'bricks', stageId: 'stg_gb_1', threshold: 5, reward: { currency: 'gamecoin', amount: 200 } }] },
        { id: 'stg_gb_2', index: 2, name: '主体结构', startTime: s1s + 7 * 86400_000, endTime: s1s + 14 * 86400_000, goal: { metric: 'bricks', target: 200 }, rewards: [{ id: 'rw_gb_s2', kind: 'threshold', metric: 'bricks', stageId: 'stg_gb_2', threshold: 10, reward: { currency: 'gamecoin', amount: 400 } }] },
      ],
    },
    rewardRules: [
      { id: 'rw_gb_top5', kind: 'leaderboard', metric: 'stage_contrib', rankRange: [0, 4], reward: { currency: 'gamecoin', amount: 800 } },
    ],
    rollout: { mode: 'all' },
  };
}

export default function EventAdmin() {
  const [rows, setRows] = useState<EventRow[]>([]);
  const [filter, setFilter] = useState('all');
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<any>(null);
  const [editing, setEditing] = useState<string | null>(null); // 编辑中的活动 id

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${BASE}/admin/list?filter=${filter}`, { headers: await authHeaders(false) });
      const data = await res.json();
      if (!res.ok || !data?.success) {
        toast.error(data?.error || `HTTP ${res.status}（需要管理员登录）`);
        setRows([]);
        return;
      }
      setRows(data?.data?.events || []);
    } catch {
      toast.error('加载失败');
    }
  }, [filter]);

  useEffect(() => {
    load();
  }, [load]);

  const post = async (path: string, body: any) => {
    setBusy(true);
    try {
      const res = await fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: await authHeaders(true),
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok || !data?.success) {
        toast.error(data?.error || `HTTP ${res.status}`);
        return null;
      }
      return data.data;
    } finally {
      setBusy(false);
    }
  };

  const handleCreate = async () => {
    if (!form) return;
    // 表单里的 datetime-local → epoch（本地时区，后端存 UTC epoch）
    const payload = {
      ...form,
      startTime: new Date(form.startTime).getTime(),
      endTime: new Date(form.endTime).getTime(),
      repeat: form.repeatUnit ? { unit: form.repeatUnit } : undefined,
    };
    delete payload.repeatUnit;
    const r = await post('/admin/create', payload);
    if (r) {
      toast.success(`已创建 ${r.event.id}（当前状态 ${r.event.status}）`);
      setForm(null);
      load();
    }
  };

  const handleUpdate = async (row: EventRow, patch: any) => {
    const r = await post('/admin/update', { id: row.id, ...patch });
    if (r) {
      toast.success('已更新（前端 /current 30s 内收敛）');
      load();
    }
  };

  const handleForceStop = async (row: EventRow) => {
    const r = await post('/admin/force-stop', { id: row.id });
    if (r) {
      toast.warning('已紧急下线：入口消失+接口拒绝，参与数据保留正常结算');
      load();
    }
  };

  const handleResettle = async (row: EventRow) => {
    const r = await post('/admin/resettle', { id: row.id });
    if (r) {
      toast.success(`重结算完成：发放 ${r.manifest?.grants ?? 0} 笔（幂等，只补漏发）`);
      load();
    }
  };

  const statusBadge = (s: string) => {
    const map: Record<string, string> = {
      draft: 'bg-slate-500/20 text-slate-300', scheduled: 'bg-indigo-500/20 text-indigo-300',
      live: 'bg-emerald-500/20 text-emerald-300', closing: 'bg-amber-500/20 text-amber-300',
      settled: 'bg-blue-500/20 text-blue-300', archived: 'bg-white/10 text-slate-400',
    };
    return `rounded-full px-2 py-0.5 text-xs font-medium ${map[s] || map.draft}`;
  };

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1 className="flex items-center gap-2 text-2xl font-bold text-white">
          <Sparkles className="h-6 w-6 text-indigo-400" /> 限时活动运营后台
        </h1>
        <div className="flex items-center gap-2">
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="rounded-xl border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-slate-200"
          >
            {['all', 'draft', 'scheduled', 'live', 'closing', 'settled', 'archived'].map((f) => (
              <option key={f} value={f}>{f === 'all' ? '全部' : f}</option>
            ))}
          </select>
          <button onClick={load} className="inline-flex items-center gap-1 rounded-xl bg-white/10 px-3 py-1.5 text-sm text-slate-200 hover:bg-white/20">
            <RefreshCw className="h-4 w-4" /> 刷新
          </button>
          <button
            onClick={() => setForm(template('freon', Date.now()))}
            className="rounded-xl bg-gradient-to-r from-cyan-500 to-blue-500 px-3 py-1.5 text-sm font-semibold text-white"
          >
            + Freon 活动
          </button>
          <button
            onClick={() => setForm(template('grand-building', Date.now()))}
            className="rounded-xl bg-gradient-to-r from-amber-500 to-orange-500 px-3 py-1.5 text-sm font-semibold text-white"
          >
            + 建造活动
          </button>
        </div>
      </div>

      {/* 创建表单 */}
      {form && (
        <div className="mb-6 space-y-3 rounded-2xl border border-indigo-500/30 bg-indigo-500/5 p-5">
          <h3 className="text-sm font-semibold text-white">创建活动（提交后状态机按时间窗口自动流转）</h3>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <label className="text-xs text-slate-400">
              名称
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="mt-1 w-full rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-sm text-white" />
            </label>
            <label className="text-xs text-slate-400">
              slug（模块映射）
              <input value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} className="mt-1 w-full rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-sm text-white" />
            </label>
            <label className="text-xs text-slate-400">
              开始时间
              <input type="datetime-local" value={T(form.startTime)} onChange={(e) => setForm({ ...form, startTime: new Date(e.target.value).getTime() })} className="mt-1 w-full rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-sm text-white" />
            </label>
            <label className="text-xs text-slate-400">
              结束时间
              <input type="datetime-local" value={T(form.endTime)} onChange={(e) => setForm({ ...form, endTime: new Date(e.target.value).getTime() })} className="mt-1 w-full rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-sm text-white" />
            </label>
            <label className="text-xs text-slate-400">
              预热提前（小时）
              <input type="number" value={form.leadHours} onChange={(e) => setForm({ ...form, leadHours: Number(e.target.value) })} className="mt-1 w-full rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-sm text-white" />
            </label>
            <label className="text-xs text-slate-400">
              补领窗口（小时）
              <input type="number" value={form.graceHours} onChange={(e) => setForm({ ...form, graceHours: Number(e.target.value) })} className="mt-1 w-full rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-sm text-white" />
            </label>
            <label className="text-xs text-slate-400">
              周期（一次性活动留空）
              <select value={form.repeatUnit || ''} onChange={(e) => setForm({ ...form, repeatUnit: e.target.value })} className="mt-1 w-full rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-sm text-white">
                <option value="">一次性</option>
                <option value="weekly">每周</option>
                <option value="biweekly">双周</option>
                <option value="monthly">每月</option>
              </select>
            </label>
            <label className="text-xs text-slate-400">
              灰度
              <select
                value={form.rollout?.mode || 'all'}
                onChange={(e) => setForm({ ...form, rollout: { ...form.rollout, mode: e.target.value } })}
                className="mt-1 w-full rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-sm text-white"
              >
                <option value="all">全量</option>
                <option value="percent">按比例</option>
                <option value="whitelist">白名单</option>
              </select>
            </label>
          </div>
          <details className="text-xs text-slate-400">
            <summary className="cursor-pointer">配置 JSON / 奖励规则（高级）</summary>
            <textarea
              value={JSON.stringify({ config: form.config, rewardRules: form.rewardRules }, null, 2)}
              onChange={(e) => {
                try {
                  const parsed = JSON.parse(e.target.value);
                  setForm({ ...form, config: parsed.config, rewardRules: parsed.rewardRules });
                } catch { /* 编辑中 JSON 不完整时忽略 */ }
              }}
              rows={10}
              className="mt-2 w-full rounded-lg border border-white/10 bg-black/30 p-2 font-mono text-xs text-slate-200"
            />
          </details>
          <div className="flex gap-2">
            <button onClick={handleCreate} disabled={busy} className="inline-flex items-center gap-1 rounded-xl bg-gradient-to-r from-indigo-500 to-purple-500 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40">
              <Save className="h-4 w-4" /> 创建
            </button>
            <button onClick={() => setForm(null)} className="rounded-xl bg-white/10 px-4 py-2 text-sm text-slate-300">取消</button>
          </div>
        </div>
      )}

      {/* 活动列表 */}
      <div className="overflow-x-auto rounded-2xl border border-white/10 bg-white/5">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/10 text-left text-xs text-slate-400">
              <th className="p-3">活动</th><th className="p-3">状态</th><th className="p-3">窗口（UTC）</th>
              <th className="p-3">周期</th><th className="p-3">灰度</th><th className="p-3">结算</th><th className="p-3">操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={7} className="p-6 text-center text-slate-400">暂无活动（或需要管理员账号登录后查看）</td></tr>
            )}
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-white/5">
                <td className="p-3">
                  <p className="font-medium text-white">{r.name}</p>
                  <p className="text-xs text-slate-500">{r.id} · {r.type} · {r.enabled ? '开关:开' : '开关:关'}</p>
                </td>
                <td className="p-3"><span className={statusBadge(r.status)}>{r.status}</span></td>
                <td className="p-3 text-xs text-slate-300">
                  {new Date(r.startTime).toISOString().slice(0, 16)} ~<br />
                  {new Date(r.endTime).toISOString().slice(0, 16)}
                </td>
                <td className="p-3 text-xs text-slate-300">{r.repeat ? r.repeat.unit : '—'}</td>
                <td className="p-3 text-xs text-slate-300">
                  {r.rollout?.mode === 'percent' ? `${r.rollout.percent}%` : r.rollout?.mode === 'whitelist' ? `${(r.rollout.whitelist || []).length} 人` : '全量'}
                </td>
                <td className="p-3 text-xs text-slate-300">{r.settleManifest ? `✅ ${r.settleManifest.grants} 笔` : '—'}</td>
                <td className="p-3">
                  <div className="flex flex-wrap gap-1">
                    {editing === r.id ? (
                      <>
                        <button onClick={() => { handleUpdate(r, { enabled: !r.enabled }); setEditing(null); }} className="rounded-lg bg-white/10 px-2 py-1 text-xs text-slate-200">
                          {r.enabled ? '关闭开关' : '开启开关'}
                        </button>
                        <button onClick={() => setEditing(null)} className="rounded-lg bg-white/5 px-2 py-1 text-xs text-slate-400">收起</button>
                      </>
                    ) : (
                      <button onClick={() => setEditing(r.id)} className="rounded-lg bg-white/10 px-2 py-1 text-xs text-slate-200">编辑</button>
                    )}
                    {r.status !== 'settled' && r.status !== 'archived' && (
                      <button
                        onClick={() => handleForceStop(r)}
                        disabled={!!r.forceStopAt}
                        className="inline-flex items-center gap-1 rounded-lg bg-rose-500/20 px-2 py-1 text-xs text-rose-300 disabled:opacity-40"
                      >
                        <Ban className="h-3 w-3" /> {r.forceStopAt ? '已下线' : '紧急下线'}
                      </button>
                    )}
                    <button onClick={() => handleResettle(r)} className="inline-flex items-center gap-1 rounded-lg bg-white/10 px-2 py-1 text-xs text-slate-200">
                      <RefreshCw className="h-3 w-3" /> 重结算
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-4 flex items-center gap-1 text-xs text-slate-500">
        <AlertTriangle className="h-3 w-3" /> 所有状态流转由后端状态机驱动；本页修改 = 改数据，不需要发版。紧急下线后参与数据保留，按实际达成正常结算。
      </p>
    </div>
  );
}
