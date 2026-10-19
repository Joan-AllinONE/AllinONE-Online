/**
 * 合约监控台 /contract-admin（B6）
 *
 * - 总览统计（状态分布 / 托管余额 / 死信队列 / 影子计划）
 * - 存证浏览器（列表 → 复算验证 + 事件链 + 托管台账）
 * - 审核队列（requiresAudit 模板的 draft 实例 approve/reject）
 *
 * 权限：需要 admin/platform 角色 token（云函数 requireAdmin 校验）。
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import {
  ArrowLeft, CircleAlert, CircleHelp, FileSearch, Gavel, Loader2, ShieldCheck, Users, X,
} from 'lucide-react';
import {
  activateRule, fetchAdminOverview, fetchContractDetail, fetchContractEscrow, fetchRules, injectRevenue,
  proposeRule, queryContracts, rejectRule, reviewContract, verifyContract, verifyRule,
  type ContractDetail, type ContractSummary, type PlatformRuleSummary,
} from '@/contracts/client/contractTunnel';
import { gameDeveloperService } from '@/services/gameDeveloperService';
import type { GameDeveloperOverview } from '@/types/gameDeveloper';

const STATE_LABEL: Record<string, string> = {
  draft: '待审核', signing: '招募中', funded: '已签署', active: '进行中',
  settling: '已结算', fulfilled: '已完成', breached: '已违约',
  disputed: '争议中', refunded: '已退款', terminated: '已终止',
};

export default function ContractAdmin() {
  const [overview, setOverview] = useState<Awaited<ReturnType<typeof fetchAdminOverview>>['data'] | null>(null);
  const [contracts, setContracts] = useState<ContractSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [detail, setDetail] = useState<ContractDetail | null>(null);
  const [verifyInfo, setVerifyInfo] = useState<Awaited<ReturnType<typeof verifyContract>>['data'] | null>(null);
  const [busy, setBusy] = useState(false);
  const [rules, setRules] = useState<PlatformRuleSummary[]>([]);
  const [ruleDraft, setRuleDraft] = useState<{ key: string; value: string }>({ key: '', value: '' });
  const [revDraft, setRevDraft] = useState({ gameId: '', source: 'store_sale', commission: '' });
  const [showHelp, setShowHelp] = useState(false);
  // 🆕 游戏三方分成配置（GameProposal 通过后写入，游戏级——治理入口是提案而非规则注册表）
  const [sharingAccounts, setSharingAccounts] = useState<GameDeveloperOverview[]>([]);
  const [sharingVerify, setSharingVerify] = useState<Record<string, { intact: boolean; length: number; brokenAt: string | null } | null>>({});

  const reload = useCallback(async () => {
    setLoading(true);
    const [ov, cs, rl, accs] = await Promise.all([
      fetchAdminOverview(), queryContracts({}), fetchRules(),
      gameDeveloperService.getDeveloperOverview(true).catch(() => [] as GameDeveloperOverview[]),
    ]);
    if (ov.ok) {
      setOverview(ov.data || null);
      setError('');
    } else {
      setError(ov.error || '加载失败（需要 admin/platform 角色）');
    }
    if (cs.ok) setContracts(cs.data?.contracts || []);
    if (rl.ok) setRules(rl.data?.rules || []);

    // 三方分成账户 + 逐账户哈希链校验（并行）
    // 注意：先 setSharingVerify 再 setSharingAccounts——React 18 批处理后单次渲染，
    // 避免「accounts 有数据但 verify 表还是空对象」的中间帧触发 undefined.intact 崩溃
    const withSharing = accs.filter((a) => a.revenueSharing);
    const verifyEntries = await Promise.all(withSharing.map(async (a) => [
      a.gameId, await gameDeveloperService.verifyRevenueSharingChain(a.gameId),
    ] as const));
    setSharingVerify(Object.fromEntries(verifyEntries));
    setSharingAccounts(withSharing);
    setLoading(false);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const openDetail = useCallback(async (id: string) => {
    const [d, , v] = await Promise.all([
      fetchContractDetail(id), fetchContractEscrow(id), verifyContract(id),
    ]);
    if (d.ok) setDetail(d.data?.contract || null);
    setVerifyInfo(v.ok ? v.data : null);
  }, []);

  const handleReview = useCallback(async (contractId: string, approve: boolean) => {
    setBusy(true);
    const r = await reviewContract(contractId, approve, approve ? '管理台通过' : '管理台驳回');
    setBusy(false);
    if (r.ok) {
      toast.success(approve ? '已通过审核' : '已驳回');
      setDetail(null);
      void reload();
    } else {
      toast.error(r.error || '操作失败');
    }
  }, [reload]);

  const drafts = contracts.filter((c) => c.state === 'draft');

  const handlePropose = useCallback(async () => {
    const v = Number(ruleDraft.value);
    if (!ruleDraft.key || !Number.isFinite(v) || v < 0 || v > 1) return toast.error('请选择规则并填写 0..1 的值');
    setBusy(true);
    const r = await proposeRule(ruleDraft.key, v);
    setBusy(false);
    if (r.ok) {
      toast.success('已进入 72 小时公示期，期满后可生效');
      setRuleDraft({ key: '', value: '' });
      void reload();
    } else {
      toast.error(r.error || '提交失败');
    }
  }, [ruleDraft, reload]);

  const handleRuleAction = useCallback(async (fn: () => Promise<{ ok: boolean; error?: string }>, msg: string) => {
    setBusy(true);
    const r = await fn();
    setBusy(false);
    if (r.ok) {
      toast.success(msg);
      void reload();
    } else {
      toast.error(r.error || '操作失败');
    }
  }, [reload]);

  const handleInjectRevenue = useCallback(async () => {
    const c = Number(revDraft.commission);
    if (!revDraft.gameId.trim() || !Number.isFinite(c) || c <= 0) return toast.error('请填写 gameId 与正数金额');
    setBusy(true);
    const r = await injectRevenue(revDraft.gameId.trim(), revDraft.source, c);
    setBusy(false);
    if (r.ok) {
      toast.success(`已注入收益台账：${revDraft.gameId} +${c}`);
      setRevDraft({ ...revDraft, commission: '' });
      void reload();
    } else {
      toast.error(r.error || '注入失败');
    }
  }, [revDraft, reload]);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="border-b border-slate-800 px-4 py-4">
        <div className="mx-auto flex max-w-6xl items-center gap-3">
          <Link to="/platform-data-center" className="rounded-lg p-2 hover:bg-slate-800" aria-label="返回">
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <Gavel className="h-6 w-6 text-violet-400" />
          <h1 className="text-lg font-bold">合约监控台</h1>
          <span className="rounded-full border border-slate-700 px-2 py-0.5 text-xs text-slate-400">/contract-admin</span>
          <button
            onClick={() => setShowHelp(true)}
            className="ml-auto flex items-center gap-1 rounded-lg border border-sky-500/40 bg-sky-500/10 px-3 py-1.5 text-sm text-sky-300 hover:bg-sky-500/20"
          >
            <CircleHelp className="h-4 w-4" /> 操作指南
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-6 px-4 py-6">
        {error && (
          <div className="flex items-center gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-300">
            <CircleAlert className="h-4 w-4" /> {error}
          </div>
        )}

        {/* 统计 */}
        <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
            <div className="text-2xl font-bold">{overview?.totalContracts ?? '—'}</div>
            <div className="text-xs text-slate-500">合约总数</div>
          </div>
          {Object.entries(overview?.byState || {}).slice(0, 3).map(([s, n]) => (
            <div key={s} className="rounded-xl border border-slate-800 bg-slate-900 p-4">
              <div className="text-2xl font-bold text-emerald-400">{n}</div>
              <div className="text-xs text-slate-500">{STATE_LABEL[s] || s}</div>
            </div>
          ))}
        </section>

        {/* 托管 / 死信 */}
        <section className="grid gap-4 md:grid-cols-2">
          <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
            <h2 className="mb-3 font-semibold">托管余额（按币种）</h2>
            {overview && Object.keys(overview.escrowSummary).length > 0 ? (
              Object.entries(overview.escrowSummary).map(([k, v]) => (
                <div key={k} className="flex justify-between py-1 text-sm text-slate-300">
                  <span>{k}</span><span className="font-mono">{Number(v).toLocaleString()}</span>
                </div>
              ))
            ) : (
              <p className="text-sm text-slate-500">当前无锁定资金</p>
            )}
          </div>
          <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
            <h2 className="mb-3 flex items-center gap-2 font-semibold">
              <CircleAlert className="h-4 w-4 text-amber-400" /> 死信队列（{overview?.deadLetterCount ?? 0}）
            </h2>
            <div className="max-h-40 space-y-1 overflow-y-auto text-xs">
              {(overview?.deadLetters || []).map((d, i) => (
                <div key={`${d.contractId}-${i}`} className="rounded bg-slate-950 p-2">
                  <span className="font-mono text-slate-300">{d.contractId}</span>
                  <span className="ml-2 text-rose-400">{d.error}</span>
                </div>
              ))}
              {(!overview || (overview.deadLetters || []).length === 0) && (
                <p className="text-slate-500">无挂起失败（全部补偿或重放成功）</p>
              )}
            </div>
          </div>
        </section>

        {/* 审核队列 */}
        <section className="rounded-xl border border-slate-800 bg-slate-900 p-4">
          <h2 className="mb-3 font-semibold">审核队列（GSO 等需审核模板）</h2>
          {drafts.length === 0 ? (
            <p className="text-sm text-slate-500">无待审合约</p>
          ) : (
            <div className="space-y-2">
              {drafts.map((c) => (
                <div key={c.id} className="flex items-center gap-3 rounded-lg bg-slate-950 p-3 text-sm">
                  <span className="font-medium">{c.templateKey}</span>
                  <span className="text-slate-500">{c.initiatorId}</span>
                  <div className="ml-auto flex gap-2">
                    <button
                      disabled={busy}
                      onClick={() => void handleReview(c.id, true)}
                      className="rounded-lg bg-emerald-600 px-3 py-1 text-xs hover:bg-emerald-500 disabled:opacity-50"
                    >
                      通过
                    </button>
                    <button
                      disabled={busy}
                      onClick={() => void handleReview(c.id, false)}
                      className="rounded-lg bg-rose-600 px-3 py-1 text-xs hover:bg-rose-500 disabled:opacity-50"
                    >
                      驳回
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* 平台规则注册表 */}
        <section className="rounded-xl border border-slate-800 bg-slate-900 p-4">
          <h2 className="mb-1 font-semibold">规则注册表</h2>
          <p className="mb-3 text-xs text-slate-500">
            散落的硬编码信任规则收敛点：修改走「提议 → 72h 公示 → 生效」治理门控，全程哈希链存证可复算。服务端资金/限额逻辑读取此表（未接入的读取点见规则描述）。
          </p>
          <div className="space-y-2">
            {rules.map((r) => (
              <div key={r.ruleKey} className="rounded-lg bg-slate-950 p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-emerald-300">{r.ruleKey}</span>
                  <span className="font-bold">{r.value}</span>
                  {r.pendingValue !== null && (
                    <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-xs text-amber-300">
                      待生效 {r.pendingValue}（{r.effectiveAt ? new Date(r.effectiveAt).toLocaleString() : ''} 后）
                    </span>
                  )}
                  <span className={`ml-auto text-xs ${r.chainIntact ? 'text-emerald-400' : 'text-rose-400'}`}>
                    链 {r.chainIntact ? '完整' : '损坏'} · {r.historyCount} 事件 · v{r.version}
                  </span>
                </div>
                <div className="mt-1 text-xs text-slate-500">{r.description}</div>
                {r.pendingValue !== null && (
                  <div className="mt-2 flex gap-2">
                    <button disabled={busy} onClick={() => void handleRuleAction(() => activateRule(r.ruleKey), '规则已生效')}
                      className="rounded bg-emerald-600 px-3 py-1 text-xs hover:bg-emerald-500 disabled:opacity-50">生效</button>
                    <button disabled={busy} onClick={() => void handleRuleAction(() => rejectRule(r.ruleKey), '已否决')}
                      className="rounded bg-rose-600 px-3 py-1 text-xs hover:bg-rose-500 disabled:opacity-50">否决</button>
                  </div>
                )}
              </div>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-800 pt-3">
            <select
              className="rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm"
              value={ruleDraft.key}
              onChange={(e) => setRuleDraft({ ...ruleDraft, key: e.target.value })}
            >
              <option value="">选择规则…</option>
              {rules.map((r) => <option key={r.ruleKey} value={r.ruleKey}>{r.ruleKey}</option>)}
            </select>
            <input
              className="w-28 rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm"
              placeholder="新值 0..1"
              value={ruleDraft.value}
              onChange={(e) => setRuleDraft({ ...ruleDraft, value: e.target.value })}
            />
            <button disabled={busy} onClick={() => void handlePropose()}
              className="rounded-lg bg-amber-600 px-3 py-1.5 text-sm hover:bg-amber-500 disabled:opacity-50">
              提议修改（公示 72h）
            </button>
            <button disabled={busy || !ruleDraft.key} onClick={() => {
              if (!ruleDraft.key) return;
              void verifyRule(ruleDraft.key).then((r) => {
                if (r.ok) toast.success(`治理链完整（${r.data?.length} 事件）`);
                else toast.error('校验失败');
              });
            }} className="rounded-lg bg-slate-800 px-3 py-1.5 text-sm hover:bg-slate-700 disabled:opacity-50">
              验证治理链
            </button>
          </div>
        </section>

        {/* 🆕 游戏三方分成配置（游戏级治理：GameProposal 提案→投票→通过→生效+哈希链存证） */}
        <section className="rounded-xl border border-slate-800 bg-slate-900 p-4">
          <h2 className="mb-1 flex items-center gap-2 font-semibold">
            <Users className="h-4 w-4 text-amber-400" /> 游戏三方分成配置（{sharingAccounts.length}）
          </h2>
          <p className="mb-3 text-xs text-slate-500">
            游戏级分成配置（GameProposal 通过后生效，每笔道具销售按此分账）。<b>修改方式：对游戏再发起带新比例的 GameProposal</b>（投票治理），不走左侧平台规则注册表——注册表管平台默认值，此处管游戏级覆盖。配置变更全程哈希链存证。
          </p>
          {sharingAccounts.length === 0 ? (
            <p className="text-sm text-slate-500">
              暂无游戏配置三方分成。未列出的游戏走平台默认值：
              <span className="mx-1 font-mono text-emerald-300">settlement.revenue_share_percent</span>
              = {rules.find((r) => r.ruleKey === 'settlement.revenue_share_percent')?.value ?? '—'}
              （单极：平台抽成，其余归游戏方；可在上方规则注册表治理修改）
            </p>
          ) : (
            <div className="space-y-2">
              {sharingAccounts.map((a) => {
                const rs = a.revenueSharing!;
                const vf = sharingVerify[a.gameId];
                return (
                  <div key={a.accountId} className="rounded-lg bg-slate-950 p-3 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{a.gameName}</span>
                      <span className="font-mono text-xs text-slate-500">{a.gameId}</span>
                      <span className="ml-auto text-xs text-slate-500">
                        来源 {rs.source}{rs.effectiveAt ? ` · ${new Date(rs.effectiveAt).toLocaleString()} 生效` : ''}
                      </span>
                    </div>
                    <div className="mt-2 flex h-5 overflow-hidden rounded-full">
                      <div className="flex items-center justify-center bg-purple-500 text-[10px] text-white"
                        style={{ width: `${Math.round(rs.gameShare * 100)}%` }}>
                        游戏 {Math.round(rs.gameShare * 100)}%
                      </div>
                      <div className="flex items-center justify-center bg-pink-500 text-[10px] text-white"
                        style={{ width: `${Math.round(rs.platformShare * 100)}%` }}>
                        平台 {Math.round(rs.platformShare * 100)}%
                      </div>
                      {rs.creatorShare > 0 && (
                        <div className="flex items-center justify-center bg-amber-500 text-[10px] text-white"
                          style={{ width: `${Math.round(rs.creatorShare * 100)}%` }}>
                          创作者 {Math.round(rs.creatorShare * 100)}%
                        </div>
                      )}
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                      {rs.creatorShare > 0 && (
                        <span className="text-amber-300">
                          创作者：{rs.creatorName || '未命名'}<span className="text-slate-500"> ({rs.creatorId || '未指定 ID'})</span>
                        </span>
                      )}
                      <span className="text-slate-400">创作者待结算：<span className="font-mono">{a.creatorOwed ?? 0}</span> A币 · 已结算 <span className="font-mono">{a.creatorSettled ?? 0}</span></span>
                      <span className={`ml-auto ${!vf ? 'text-slate-500' : vf.intact ? 'text-emerald-400' : 'text-rose-400'}`}>
                        {!vf ? '链未校验' : `存证链 ${vf.intact ? '完整' : `损坏@${vf.brokenAt}`} · ${vf.length} 次变更`}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* 收益台账注入（测试设施） */}
        <section className="rounded-xl border border-slate-800 bg-slate-900 p-4">
          <h2 className="mb-1 font-semibold">收益台账注入（GSO 分账联调）</h2>
          <p className="mb-3 text-xs text-slate-500">生产数据来自真实成交点记账；此入口仅供测试 GSO 周期分账链路。</p>
          <div className="flex flex-wrap items-center gap-2">
            <input className="w-44 rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm"
              placeholder="gameId" value={revDraft.gameId} onChange={(e) => setRevDraft({ ...revDraft, gameId: e.target.value })} />
            <select className="rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm"
              value={revDraft.source} onChange={(e) => setRevDraft({ ...revDraft, source: e.target.value })}>
              <option value="market_commission">market_commission</option>
              <option value="content_consume">content_consume</option>
              <option value="store_sale">store_sale</option>
              <option value="item_sale">item_sale</option>
            </select>
            <input className="w-28 rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm"
              placeholder="佣金金额" value={revDraft.commission} onChange={(e) => setRevDraft({ ...revDraft, commission: e.target.value })} />
            <button disabled={busy} onClick={() => void handleInjectRevenue()}
              className="rounded-lg bg-sky-600 px-3 py-1.5 text-sm hover:bg-sky-500 disabled:opacity-50">注入</button>
          </div>
        </section>

        {/* 存证浏览器 */}
        <section className="rounded-xl border border-slate-800 bg-slate-900 p-4">
          <h2 className="mb-3 flex items-center gap-2 font-semibold">
            <FileSearch className="h-4 w-4 text-sky-400" /> 存证浏览器（{contracts.length}）
          </h2>
          <div className="max-h-72 space-y-1 overflow-y-auto">
            {contracts.map((c) => (
              <button
                key={c.id}
                onClick={() => void openDetail(c.id)}
                className="flex w-full items-center gap-3 rounded-lg bg-slate-950 px-3 py-2 text-left text-sm hover:bg-slate-800"
              >
                <span className="font-mono text-xs text-slate-500">{c.id}</span>
                <span>{c.templateKey}</span>
                <span className="text-slate-500">{STATE_LABEL[c.state] || c.state}</span>
                <span className="ml-auto text-xs text-slate-600">{c.historyCount} 事件</span>
              </button>
            ))}
          </div>
        </section>
      </main>

      {/* 存证详情 */}
      {detail && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" role="dialog" aria-modal="true">
          <div className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-slate-800 bg-slate-900 p-6">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-lg font-bold">
                <ShieldCheck className={`h-5 w-5 ${verifyInfo?.intact ? 'text-emerald-400' : 'text-rose-400'}`} />
                {detail.id}
              </h2>
              <button onClick={() => setDetail(null)} className="rounded-lg p-1 hover:bg-slate-800" aria-label="关闭">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="mb-3 text-sm">
              规则指纹: {String(verifyInfo?.ruleIntact)} · 事件链: {String(verifyInfo?.chainIntact)}({verifyInfo?.chainLength}) · HMAC: {String(verifyInfo?.signatureValid)}
            </div>
            <div className="mb-3 break-all font-mono text-xs text-slate-500">{detail.codeHash}</div>
            <div className="max-h-64 space-y-1 overflow-y-auto rounded-lg bg-slate-950 p-3 text-xs">
              {[...detail.history].reverse().map((h) => (
                <div key={h.seq} className="flex items-center gap-2 text-slate-400">
                  <span className="w-10 text-slate-600">#{h.seq}</span>
                  <span className="w-28 font-mono text-slate-300">{h.type}</span>
                  <span className="w-24">{h.actorId}</span>
                  <span className="truncate font-mono text-slate-600">{h.hash.slice(0, 16)}…</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {loading && (
        <div className="fixed inset-x-0 bottom-4 flex justify-center">
          <div className="flex items-center gap-2 rounded-full bg-slate-900 px-4 py-2 text-sm text-slate-400">
            <Loader2 className="h-4 w-4 animate-spin" /> 加载中…
          </div>
        </div>
      )}

      {showHelp && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4" role="dialog" aria-modal="true">
          <div className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-slate-800 bg-slate-900 p-6">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-lg font-bold">
                <CircleHelp className="h-5 w-5 text-sky-400" /> 监控台使用指南
              </h2>
              <button onClick={() => setShowHelp(false)} className="rounded-lg p-1 hover:bg-slate-800" aria-label="关闭">
                <X className="h-5 w-5" />
              </button>
            </div>

            <section className="mb-4 rounded-xl border border-slate-800 bg-slate-950 p-4">
              <h3 className="mb-2 font-semibold text-emerald-300">这个页面是干什么的？</h3>
              <p className="text-sm text-slate-300">
                合约监控台是平台管理员对<b>智能合约系统</b>的总控面板：查看所有合约的运行状态、托管中的资金、
                执行失败的记录（死信）、影子模式下的对账日志，以及对合约条款做存证验证。社区用户侧的入口在
                <b> /contracts 合约中心</b>。
              </p>
            </section>

            <section className="mb-4 rounded-xl border border-slate-800 bg-slate-950 p-4">
              <h3 className="mb-2 font-semibold text-sky-300">各区域说明</h3>
              <ul className="list-disc space-y-1 pl-5 text-sm text-slate-300">
                <li><b>统计卡</b>：合约总数与按状态（招募中 / 进行中 / 已结算…）的数量分布。</li>
                <li><b>托管余额</b>：当前锁定在平台托管账户的资金总额（按币种汇总）——这是用户的钱，只能由合约条款释放。</li>
                <li><b>死信队列</b>：执行失败的资金效果记录（如余额不足）。采用 saga 幂等设计，<b>重试不会双花</b>；修复诱因后下次 tick 自动重放。</li>
                <li><b>影子计划</b>：自动执行开关未开启时，引擎照常计算出的执行计划（只入账不动钱）——开闸前用它做对账。</li>
                <li><b>审核队列</b>：GSO 等需审核的合约部署后处于「待审核」，此处通过后才进入招募。</li>
                <li><b>存证浏览器</b>：任意合约的事件账本（每条事件带哈希链），可复算「规则指纹 / 事件链 / 服务端签名」三重完整性。</li>
              </ul>
            </section>

            <section className="mb-4 rounded-xl border border-slate-800 bg-slate-950 p-4">
              <h3 className="mb-2 font-semibold text-amber-300">规则注册表：改规则的正确姿势</h3>
              <p className="text-sm text-slate-300">
                平台的资金比例、限额等信任规则统一收敛在规则注册表，<b>禁止再散落硬编码</b>。修改流程为治理门控：
              </p>
              <ol className="list-decimal space-y-1 pl-5 text-sm text-slate-300">
                <li>选择规则 → 填新值 → <b>提议修改</b>（进入 72 小时公示期，全程哈希链存证）；</li>
                <li>公示期内可<b>否决</b>；期满后点<b>生效</b>（只能生效公示过的值，timelock 语义）；</li>
                <li>生效后服务端读取点自动使用新值（缓存即时失效），任何人可用「验证治理链」复核审计链完整性。</li>
              </ol>
            </section>

            <section className="rounded-xl border border-slate-800 bg-slate-950 p-4">
              <h3 className="mb-2 font-semibold text-violet-300">新合约上线建议流程</h3>
              <ol className="list-decimal space-y-1 pl-5 text-sm text-slate-300">
                <li>先保持<b>影子模式</b>运行（服务端环境变量 <code className="rounded bg-slate-800 px-1">CONTRACT_AUTO_EXECUTE</code> 逐档开启：group-buy → team-quest → gso）；</li>
                <li>观察<b>影子计划</b>的计算结果与<b>死信队列</b>是否干净；</li>
                <li>对账无误后再开对应档位的自动执行开关；</li>
                <li>收益注入面板仅供测试 GSO 周期分账链路，生产数据来自真实成交点的服务端记账。</li>
              </ol>
              <p className="mt-2 text-xs text-slate-500">
                合规提示：对用户展示的口径始终是「平台保证合约按公布的规则执行，不保证任何收益结果」。
              </p>
            </section>
          </div>
        </div>
      )}
    </div>
  );
}
