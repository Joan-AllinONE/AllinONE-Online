/**
 * 合约工坊（Contract Workshop）— CW-2/4/5
 *
 * 三模式创作（对齐道具/内容工坊）：
 * - 模板库：官方模板 + UGC 市场（浏览 / fork）
 * - AI 生成：自然语言 → ACR 合规模板（contractAIBridge）
 * - JSON 导入：直接编辑模板源码（ACR 纯函数本地校验）
 *
 * 沙盒模拟器：前端直接复用合约引擎纯函数（executeTrigger/applyUpdates 零后端），
 * 剧本回放 EffectPlan / stateData diff / 状态迁移。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { BookOpen, CircleHelp, ListChecks, X } from 'lucide-react';
import {
  fetchTemplates,
  listUgcTemplates,
  fetchUgcTemplateDetail,
  submitUgcTemplate,
  type TemplateSummary,
  type UgcTemplateSummary,
} from '@/contracts/client/contractTunnel';
import {
  validateTemplate,
  validateUgcTemplate,
  classifyTemplateRisk,
  deriveInitialStateData,
  executeTrigger,
  applyUpdates,
} from '@/contracts/index.js';
import type { ContractInstance, ContractTemplate, EffectPlan } from '@/contracts/index.js';
import { generateContractTemplate, iterateContractTemplate } from '@/services/contractAIBridge';

// ==================== 沙盒模型 ====================

interface SandboxStep {
  idx: number;
  kind: string;
  type: string;
  actorId: string;
  payloadText: string;
  at: number;
  /** 回放产物 */
  result?: string;
  ok?: boolean;
}

function buildSandboxInstance(tpl: ContractTemplate, params: Record<string, unknown>): ContractInstance {
  return {
    id: 'sandbox',
    templateKey: tpl.key,
    templateVersion: tpl.version,
    family: tpl.family,
    codeHash: 'sandbox',
    upgradePolicy: 'immutable',
    initiatorId: String(params.initiatorId ?? params.issuerId ?? 'sandbox_user'),
    params,
    clauses: tpl.clauses,
    parties: [],
    escrow: { voucherIds: [], walletHold: [] },
    state: tpl.initialState,
    stateData: deriveInitialStateData(tpl),
    history: [],
    seed: 'sandbox-seed-0123456789abcdef',
    autoExecute: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    version: 1,
  };
}

function describePlan(plan: EffectPlan): string {
  const parts: string[] = [];
  parts.push(`条款: ${plan.clauseIds.join(', ')}`);
  for (const e of plan.effects) {
    const eff = e as Record<string, unknown>;
    const amt = eff.amount !== undefined ? ` ${String(eff.amount)}` : '';
    const to = eff.toUserId || eff.userId || eff.to || '';
    parts.push(`→ ${e.type}${to ? ` → ${String(to)}` : ''}${amt}`);
  }
  if (plan.updates.length > 0) {
    parts.push(`state: ${plan.updates.map((u) => `${u.op}:${u.field}`).join(', ')}`);
  }
  if (plan.nextState) parts.push(`迁移 → ${plan.nextState}`);
  return parts.join(' | ');
}

// ==================== 页面 ====================

type Mode = 'library' | 'ai' | 'json';

// 示例模板数据已移至 @/contracts/acr/examples.js（供单测断言示例永远合规）
import { GUIDE_EXAMPLES } from '@/contracts/acr/examples.js';

// ==================== 可创作合约类型清单（基于引擎 Effect 能力 + ACR 边界） ====================

interface ContractTypeMeta {
  name: string;
  risk: 'low' | 'medium' | 'high';
  scene: string;
  points: string[];
  prompt: string;
}

const CONTRACT_TYPES: ContractTypeMeta[] = [
  {
    name: '押金托管 · 到期退款',
    risk: 'medium',
    scene: '报名费/押金类：达标则进入履约，到期未成交全额原路退款',
    points: [
      'join 条款：walletTransfer 进托管（toUserId=escrow，fromUserId=event.userId，金额 expr: params.amount）',
      'cron deadline-check：when now > params.deadline → refundAll + setState refunded',
      'params：initiatorId(string) / amount(number) / deadline(number 毫秒)',
      'stateData：memberCount 计数（updates add）',
    ],
    prompt: '做一个押金托管合约：成员每人缴 N 币进托管，到期自动全额原路退款；参数化人数、金额、截止时间。',
  },
  {
    name: '拼团预购 · 成团交割',
    risk: 'medium',
    scene: '团购/预售：人数达标则货款交割给卖家，未达标全额退款',
    points: [
      'join 条款：缴款进托管 + memberCount add',
      'cron 到期（达标分支）：when now>deadline && state.memberCount+1 已达标（注意 +1 约定）→ 出账 walletTransfer toUserId=expr: params.sellerId（sellerId 须在 paramsSchema 声明 string）+ setState settling→fulfilled',
      'cron 到期（未达标分支）：refundAll + setState refunded',
      '可选：notify 通知成团/流团',
    ],
    prompt: '做一个拼团预购合约：每人缴款进托管，到期人数达标就把货款交割给卖家（卖家 ID 部署时填），未达标全额退款。',
  },
  {
    name: '奖池分成 · 按贡献分配',
    risk: 'medium',
    scene: '活动奖池/分红：发起人注资，参与者按贡献占比分池',
    points: [
      'fund-pool 条款：发起人注资（fromUserId=expr: params.initiatorId）+ poolFunded 置 1 防重复 + totalPool 记账',
      'join 条款：入场费进托管 + contributions push（userIdExpr=event.userId，amountExpr=金额字段）',
      'cron 到期（已注资）：splitPayout table byField（stateField=contributions，mode=share，poolAmount=expr: state.totalPool）+ setState settling',
      'cron 到期（未注资兜底）：refundAll',
      'settling→fulfilled 收尾条款（enabledStates: ["settling"]）',
    ],
    prompt: '做一个奖池分成合约：发起人注入奖池，成员缴入场费，到期按每人入场费占比均分奖池；奖池未注入则入场费全额退还。',
  },
  {
    name: '众筹达标交割',
    risk: 'medium',
    scene: '软顶众筹：总筹款达标才交割给发起方，否则全额退',
    points: [
      'subscribe 条款：缴款进托管 + totalRaised add（expr 金额）+ contributions push',
      'cron 到期（达标）：when state.totalRaised >= params.softCap → 出账交割（toUserId=expr: params.recipientId，amount=expr: state.totalRaised）+ setState fulfilled',
      'cron 到期（未达标）：refundAll + setState refunded',
      'params：recipientId(string) / softCap / deadline',
    ],
    prompt: '做一个软顶众筹合约：支持者缴款进托管，到期总筹款达标就一次性交割给发起方，未达标全额退款。',
  },
  {
    name: '保证金 · 违约罚没',
    risk: 'high',
    scene: '需要罚则的承诺合约：退出/违约罚保证金，履约到期退还',
    points: [
      'requiresAudit 必须 = true（含 penalize 强制人工审核）',
      'join 条款：保证金进托管（建议 purpose: "bond" 定向隔离）',
      'leave 条款：penalize userId=expr: event.userId（只能罚当事人本人，forfeitTo=treasury）',
      'cron 到期：剩余保证金 refundAll + setState refunded',
      '提交后进 pending，需平台管理员审核通过才能被部署',
    ],
    prompt: '做一个保证金合约：成员缴保证金进托管，中途退出罚没保证金（只罚退出者本人），坚持到期全额退还保证金。',
  },
  {
    name: '公示承诺 · 打卡计数',
    risk: 'low',
    scene: '无资金的社会性合约：公开承诺、打卡、投票意愿登记',
    points: [
      'effectsWhitelist 只声明 setState / notify / openDispute',
      'join 条款：notify 通知 + memberCount add',
      'cron 到期：setState fulfilled（或配合 notify 播报）',
      '无资金流 → 自动过审，适合第一次体验创作',
    ],
    prompt: '做一个无资金的打卡公示合约：成员加入即登记打卡，到期自动结束并公告参与人数。',
  },
];

export default function ContractWorkshop() {
  // 模板库
  const [official, setOfficial] = useState<TemplateSummary[]>([]);
  const [ugcList, setUgcList] = useState<UgcTemplateSummary[]>([]);
  const [mine, setMine] = useState(false);
  const [loadingLib, setLoadingLib] = useState(false);

  // 编辑器
  const [mode, setMode] = useState<Mode>('library');
  const [tplText, setTplText] = useState('');
  /** 模板来源：official=官方模板查看（豁免 UGC 安全 Lint）；ugc=UGC 创作对象（全量 ACR 校验） */
  const [tplSource, setTplSource] = useState<'official' | 'ugc'>('ugc');
  const [slug, setSlug] = useState('');
  const [feeBps, setFeeBps] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [submitMsg, setSubmitMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // AI
  const [aiInput, setAiInput] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [aiMsg, setAiMsg] = useState('');
  const [aiTplInfo, setAiTplInfo] = useState('');

  // 沙盒
  const [sandboxSteps, setSandboxSteps] = useState<SandboxStep[]>([]);
  const [sandboxState, setSandboxState] = useState<string>('');
  const [sandboxNow, setSandboxNow] = useState<number>(Date.now());
  const [sbAction, setSbAction] = useState('join');
  const [sbActor, setSbActor] = useState('u_alice');
  const [sbPayload, setSbPayload] = useState('{}');
  const [showGuide, setShowGuide] = useState(false);
  const [showSpec, setShowSpec] = useState(false);
  const [showTypes, setShowTypes] = useState(false);
  const sbInstanceRef = useRef<ContractInstance | null>(null);

  // ---- 解析与校验（ACR 纯函数本地跑） ----
  const parsed = useMemo((): { tpl: ContractTemplate | null; parseError: string } => {
    if (!tplText.trim()) return { tpl: null, parseError: '' };
    try {
      const t = JSON.parse(tplText) as ContractTemplate;
      if (!t || typeof t !== 'object' || !Array.isArray(t.clauses)) return { tpl: null, parseError: 'JSON 需为 ContractTemplate 对象（含 clauses 数组）' };
      return { tpl: t, parseError: '' };
    } catch (e) {
      return { tpl: null, parseError: `JSON 语法错误: ${e instanceof Error ? e.message : String(e)}` };
    }
  }, [tplText]);

  const acrCheck = useMemo(() => {
    if (!parsed.tpl) return null;
    try {
      // 官方模板只跑结构校验（部署走平台通道，不受 UGC 安全 Lint 约束）
      return tplSource === 'official' ? validateTemplate(parsed.tpl) : validateUgcTemplate(parsed.tpl);
    } catch (e) {
      return { ok: false, issues: [{ path: 'tpl', message: e instanceof Error ? e.message : String(e) }] };
    }
  }, [parsed.tpl, tplSource]);

  const risk = useMemo(() => {
    if (!parsed.tpl || !acrCheck?.ok) return null;
    if (tplSource === 'official') {
      // 官方模板直接用其声明的 riskLevel，不走 UGC 分级
      return { level: parsed.tpl.riskLevel || 'medium', reasons: ['官方模板（风险由平台审定）'] };
    }
    try {
      return classifyTemplateRisk(parsed.tpl);
    } catch {
      return null;
    }
  }, [parsed.tpl, acrCheck, tplSource]);

  // ---- 模板库加载 ----
  const loadLibrary = useCallback(async () => {
    setLoadingLib(true);
    const [off, ugc] = await Promise.all([fetchTemplates(), listUgcTemplates(mine)]);
    if (off.ok && off.data) setOfficial(off.data.templates);
    if (ugc.ok && ugc.data) setUgcList(ugc.data.templates);
    setLoadingLib(false);
  }, [mine]);

  useEffect(() => {
    if (mode === 'library') void loadLibrary();
  }, [mode, loadLibrary]);

  // ---- fork / 加载模板 ----
  const loadOfficial = (t: TemplateSummary) => {
    if (!t.clauses || t.clauses.length === 0) {
      setSubmitMsg({ ok: false, text: '官方模板源码加载失败（未返回 clauses），请刷新重试' });
      return;
    }
    const tpl = {
      key: t.key,
      family: t.family,
      version: t.version,
      title: t.title,
      description: t.description,
      riskLevel: t.riskLevel,
      requiresAudit: t.requiresAudit,
      initialState: t.initialState || 'signing',
      effectsWhitelist: t.effectsWhitelist || [],
      paramsSchema: t.paramsSchema,
      governanceTopics: t.governanceTopics || [],
      clauses: t.clauses,
    };
    setTplText(JSON.stringify(tpl, null, 2));
    setTplSource('official');
    setMode('json');
    setSubmitMsg({
      ok: true,
      text: `已载入官方模板「${t.title}」完整源码（只读参考）。\n· 官方模板豁免 UGC 安全 Lint（部署走平台通道）；\n· 点「复制 JSON」可带走；切到 AI 模式用「按描述修改当前模板」生成 UGC 变体；\n· 想把它改造成自己的 UGC 模板？点校验面板的「转为 UGC 创作对象」。`,
    });
  };

  const loadUgc = async (t: UgcTemplateSummary) => {
    const r = await fetchUgcTemplateDetail(t.key);
    if (r.ok && r.data) {
      const full = r.data.template;
      setTplText(JSON.stringify(full.tpl, null, 2));
      setTplSource('ugc');
      setSlug(t.key.replace(/^ugc_[^_]+_/, '') + '-fork');
      setSubmitMsg({ ok: true, text: `已载入 ${t.key}（fork），改完可直接提交为新模板` });
      setMode('json');
    } else {
      setSubmitMsg({ ok: false, text: r.error || '载入失败' });
    }
  };

  /** 载入操作指南中的示例模板到编辑器（示例均通过 ACR 校验） */
  const loadGuideExample = (idx: number) => {
    const ex = GUIDE_EXAMPLES[idx];
    if (!ex) return;
    const slug = String(ex.tpl.key).replace('ugc_demo_', 'demo-');
    setTplText(JSON.stringify(ex.tpl, null, 2));
    setTplSource('ugc');
    setSlug(slug);
    setSubmitMsg({ ok: true, text: `已载入「${ex.name}」，可先在沙盒回放，或直接改 slug 提交` });
    setMode('json');
  };

  // ---- AI 生成 ----
  const runAI = async (isIterate: boolean) => {
    if (!aiInput.trim()) return;
    setAiBusy(true);
    setAiMsg('');
    try {
      const r = isIterate && parsed.tpl
        ? await iterateContractTemplate(parsed.tpl as unknown as Record<string, unknown>, aiInput)
        : await generateContractTemplate(aiInput);
      if (r.ok && r.tpl) {
        setTplText(JSON.stringify(r.tpl, null, 2));
        setTplSource('ugc');
        setMode('json');
        const slugGuess = String((r.tpl as Record<string, unknown>).key || 'ai-contract').replace(/^ugc_[^_]+_/, '');
        setSlug(slugGuess.replace(/[^a-z0-9_-]/gi, '').toLowerCase().slice(0, 40) || 'ai-contract');
        setAiMsg(`✅ 生成通过 ACR 校验${r.reasoning ? `：${r.reasoning}` : ''}`);
        setAiTplInfo('');
      } else if (r.tpl) {
        setTplText(JSON.stringify(r.tpl, null, 2));
        setTplSource('ugc');
        setMode('json');
        setAiMsg(`⚠️ ${r.error || '未通过校验'}，已载入 JSON 编辑器供修复`);
        setAiTplInfo((r.issues || []).map((i) => `[${i.path}] ${i.message}`).join('\n'));
      } else if (r.questions && r.questions.length > 0) {
        setAiMsg(`🤖 AI 追问：\n${r.questions.join('\n')}`);
      } else {
        setAiMsg(`❌ ${r.error || '生成失败'}`);
      }
    } finally {
      setAiBusy(false);
    }
  };

  // ---- 提交注册 ----
  const submit = async () => {
    if (!parsed.tpl) return;
    setSubmitting(true);
    setSubmitMsg(null);
    try {
      const source = tplText.includes('-fork') ? 'fork' : 'manual';
      const r = await submitUgcTemplate(parsed.tpl as unknown as Record<string, unknown>, slug.trim(), {
        source: source as 'manual' | 'fork',
        templateFeeBps: feeBps,
      });
      if (r.ok && r.data) {
        setSubmitMsg({
          ok: true,
          text: `✅ 已提交 ${r.data.key}（v${r.data.version}）→ ${r.data.status === 'approved' ? '已通过（' + r.data.reviewPath + '）' : '待人工审核'} · 风险 ${r.data.riskLevel}${r.data.riskReasons.length ? '：' + r.data.riskReasons.join('；') : ''}`,
        });
      } else {
        const issues = (r as unknown as { issues?: Array<{ path: string; message: string }> }).issues || [];
        setSubmitMsg({
          ok: false,
          text: `❌ ${r.error || '提交失败'}${issues.length ? '\n' + issues.map((i) => `[${i.path}] ${i.message}`).join('\n') : ''}`,
        });
      }
    } finally {
      setSubmitting(false);
    }
  };

  // ---- 沙盒 ----
  const resetSandbox = () => {
    if (!parsed.tpl) return;
    let params: Record<string, unknown> = {};
    try {
      params = JSON.parse(sbPayload || '{}') as Record<string, unknown>;
    } catch {
      /* 保持空 */
    }
    sbInstanceRef.current = buildSandboxInstance(parsed.tpl, params);
    setSandboxSteps([]);
    setSandboxNow(Date.now());
    setSandboxState(JSON.stringify(sbInstanceRef.current.stateData, null, 2));
  };

  const runStep = (kind: 'manual' | 'cron' | 'event' | 'protocol', type: string, atOverride?: number) => {
    const inst = sbInstanceRef.current;
    if (!inst) return;
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(sbPayload || '{}') as Record<string, unknown>;
    } catch {
      /* ignore */
    }
    // 时间快进（tickCron）需绕过 setState 异步：显式传入目标时刻，避免闭包读到旧 sandboxNow
    const at = atOverride ?? sandboxNow;
    const ev: Record<string, unknown> = {
      triggerId: `sb-${inst.history.length}-${type}-${at}`,
      kind,
      type,
      at,
      actorId: sbActor || 'sandbox_user',
      payload,
      ...(kind === 'protocol' ? { channelTokenValid: true } : {}),
    };
    const result = executeTrigger(inst, ev as never, { now: at });
    const actor = String(ev.actorId);
    const idx = sandboxSteps.length + 1;
    if (!result.plan) {
      setSandboxSteps((s) => [...s, { idx, kind, type, actorId: actor, payloadText: JSON.stringify(payload), at, ok: false, result: `未触发：${result.reasonDetail || result.reason}` }]);
      return;
    }
    const plan = result.plan;
    inst.stateData = applyUpdates(inst.stateData, plan.updates);
    if (plan.nextState) inst.state = plan.nextState;
    inst.history.push({ seq: inst.history.length, at, type: 'trigger', actorId: actor, payload: { ...ev }, prevHash: '0', hash: `sb-${inst.history.length}` });
    inst.version += 1;
    setSandboxSteps((s) => [...s, { idx, kind, type, actorId: actor, payloadText: JSON.stringify(payload), at, ok: true, result: describePlan(plan) }]);
    setSandboxState(JSON.stringify(inst.stateData, null, 2));
    setSandboxNow(at + 1);
  };

  const tickCron = (schedule: string, jumpMs: number) => {
    // 直接以目标时刻调用（setState 后闭包内 sandboxNow 仍旧，快进会失效）
    const target = sandboxNow + jumpMs;
    setSandboxNow(target);
    runStep('cron', schedule, target);
  };

  // ============================================================

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      {/* 顶栏 */}
      <div className="border-b border-gray-800 bg-gray-900/80 px-4 py-3 flex items-center gap-3 sticky top-0 z-10">
        <Link to="/contracts" className="text-sm text-gray-400 hover:text-white">← 合约大厅</Link>
        <h1 className="text-lg font-bold">合约工坊</h1>
        <span className="text-xs text-gray-500">ACR-1/2/3 · 模板即合约源码 · 部署前必须通过安全校验</span>
        <button
          onClick={() => setShowTypes(true)}
          className="ml-auto flex items-center gap-1 rounded-lg border border-gray-700 px-2.5 py-1.5 text-sm text-gray-300 hover:bg-gray-800"
          title="可创作的合约类型"
        >
          <ListChecks className="h-4 w-4" /> 创作类型
        </button>
        <button
          onClick={() => setShowSpec(true)}
          className="flex items-center gap-1 rounded-lg border border-gray-700 px-2.5 py-1.5 text-sm text-gray-300 hover:bg-gray-800"
          title="ACR 协议规范"
        >
          <BookOpen className="h-4 w-4" /> ACR 规范
        </button>
        <button
          onClick={() => setShowGuide(true)}
          className="flex items-center gap-1 rounded-lg border border-gray-700 px-2.5 py-1.5 text-sm text-gray-300 hover:bg-gray-800"
          title="操作指南"
        >
          <CircleHelp className="h-4 w-4" /> 操作指南
        </button>
        <div className="flex gap-1">
          {(['library', 'ai', 'json'] as Mode[]).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`px-3 py-1.5 rounded text-sm ${mode === m ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'}`}
            >
              {m === 'library' ? '模板库' : m === 'ai' ? 'AI 生成' : 'JSON 编辑'}
            </button>
          ))}
        </div>
      </div>

      {/* 全局提示条（所有模式可见：模板点击反馈 / 提交结果） */}
      {submitMsg && (
        <div className={`mx-4 mt-3 max-w-[1600px] xl:mx-auto flex items-start gap-2 rounded-lg border p-3 text-sm ${submitMsg.ok ? 'border-green-800 bg-green-900/30 text-green-200' : 'border-yellow-800 bg-yellow-900/30 text-yellow-200'}`}>
          <span className="flex-1 whitespace-pre-wrap">{submitMsg.text}</span>
          <button onClick={() => setSubmitMsg(null)} className="shrink-0 opacity-60 hover:opacity-100" title="关闭">✕</button>
        </div>
      )}

      <div className="flex gap-4 p-4 max-w-[1600px] mx-auto">
        {/* 左栏：模板库（常驻窄栏） */}
        <div className="w-80 shrink-0 space-y-3">
          <div className="bg-gray-900 rounded-lg border border-gray-800 p-3">
            <div className="flex items-center justify-between mb-2">
              <h2 className="font-semibold text-sm">模板库</h2>
              <label className="text-xs text-gray-400 flex items-center gap-1">
                <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} className="accent-blue-600" />
                我的
              </label>
            </div>
            {loadingLib ? (
              <div className="text-xs text-gray-500 py-4 text-center">加载中…</div>
            ) : (
              <div className="space-y-2 max-h-[70vh] overflow-y-auto">
                {official.map((t) => (
                  <button
                    key={t.key}
                    onClick={() => loadOfficial(t)}
                    className="w-full text-left bg-gray-800/60 hover:bg-gray-800 rounded p-2 border border-gray-700/50"
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-xs px-1.5 py-0.5 rounded bg-blue-900/60 text-blue-300">官方</span>
                      <span className="text-sm font-medium truncate">{t.title || t.key}</span>
                    </div>
                    <div className="text-xs text-gray-500 mt-1 flex gap-2">
                      <span>{t.family}</span>
                      <span>风险 {t.riskLevel}</span>
                      <span>{t.autoExecute ? '自动执行' : '影子'}</span>
                    </div>
                  </button>
                ))}
                {ugcList.map((t) => (
                  <button
                    key={t.key}
                    onClick={() => void loadUgc(t)}
                    className="w-full text-left bg-gray-800/60 hover:bg-gray-800 rounded p-2 border border-gray-700/50"
                  >
                    <div className="flex items-center gap-2">
                      <span className={`text-xs px-1.5 py-0.5 rounded ${t.status === 'approved' ? 'bg-green-900/60 text-green-300' : t.status === 'pending' ? 'bg-yellow-900/60 text-yellow-300' : 'bg-red-900/60 text-red-300'}`}>
                        UGC·{t.status === 'approved' ? '已过审' : t.status === 'pending' ? '待审' : '驳回'}
                      </span>
                      <span className="text-sm font-medium truncate">{t.title || t.key}</span>
                    </div>
                    <div className="text-xs text-gray-500 mt-1 flex gap-2">
                      <span>{t.family}</span>
                      <span>风险 {t.riskLevel}</span>
                      <span>部署 {t.stats?.deployCount || 0} 次</span>
                      {t.source === 'ai' && <span>AI 创作</span>}
                    </div>
                  </button>
                ))}
                {ugcList.length === 0 && <div className="text-xs text-gray-500 py-2 text-center">暂无 UGC 模板，来创作第一个吧</div>}
              </div>
            )}
          </div>
        </div>

        {/* 中/右栏 */}
        <div className="flex-1 min-w-0 space-y-4">
          {/* AI 模式 */}
          {mode === 'ai' && (
            <div className="bg-gray-900 rounded-lg border border-gray-800 p-4 space-y-3">
              <h2 className="font-semibold">AI 生成合约模板</h2>
              <p className="text-xs text-gray-500">用自然语言描述合约逻辑（如「3 人成团拼购，每人 50 币，不成团全额退款，成团后货款给卖家」）。AI 输出会过本地 ACR 校验，不合规自动回炉。</p>
              <textarea
                value={aiInput}
                onChange={(e) => setAiInput(e.target.value)}
                rows={3}
                placeholder="描述你想要的合约…"
                className="w-full bg-gray-800 border border-gray-700 rounded p-2 text-sm"
              />
              <div className="flex gap-2">
                <button
                  onClick={() => void runAI(false)}
                  disabled={aiBusy || !aiInput.trim()}
                  className="px-4 py-1.5 rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-sm"
                >
                  {aiBusy ? '生成中…' : '生成模板'}
                </button>
                {parsed.tpl && (
                  <button
                    onClick={() => void runAI(true)}
                    disabled={aiBusy || !aiInput.trim()}
                    className="px-4 py-1.5 rounded bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-sm"
                  >
                    按描述修改当前模板
                  </button>
                )}
              </div>
              {aiMsg && <pre className="text-xs whitespace-pre-wrap bg-gray-800 rounded p-2">{aiMsg}{aiTplInfo ? `\n\n${aiTplInfo}` : ''}</pre>}
            </div>
          )}

          {/* JSON 编辑器 */}
          {mode === 'json' && (
            <div className="bg-gray-900 rounded-lg border border-gray-800 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="font-semibold">模板源码（JSON）</h2>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-500">粘贴外部 AI 生成的模板，或直接编辑</span>
                  <button
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(tplText);
                        setSubmitMsg({ ok: true, text: '模板 JSON 已复制到剪贴板' });
                      } catch {
                        setSubmitMsg({ ok: false, text: '复制失败（浏览器权限），请手动全选复制' });
                      }
                    }}
                    disabled={!tplText.trim()}
                    className="rounded bg-gray-700 px-2.5 py-1 text-xs hover:bg-gray-600 disabled:opacity-50"
                  >
                    复制 JSON
                  </button>
                  <button
                    onClick={() => { setTplText(''); setSubmitMsg(null); }}
                    disabled={!tplText.trim()}
                    className="rounded bg-gray-700 px-2.5 py-1 text-xs hover:bg-gray-600 disabled:opacity-50"
                  >
                    清空
                  </button>
                </div>
              </div>
              <textarea
                value={tplText}
                onChange={(e) => setTplText(e.target.value)}
                rows={18}
                spellCheck={false}
                className="w-full bg-gray-800 border border-gray-700 rounded p-2 text-xs font-mono"
                placeholder='粘贴 ContractTemplate JSON…（可在模板库 fork UGC 模板获得起点）'
              />
            </div>
          )}

          {/* 校验面板 */}
          {mode !== 'library' && (
            <div className="bg-gray-900 rounded-lg border border-gray-800 p-4 space-y-2">
              <div className="flex items-center justify-between">
                <h2 className="font-semibold text-sm">ACR 校验</h2>
                <span className={`text-xs px-2 py-0.5 rounded ${tplSource === 'official' ? 'bg-indigo-900/60 text-indigo-300' : 'bg-gray-800 text-gray-400'}`}>
                  {tplSource === 'official' ? '官方模板 · 豁免 UGC 安全 Lint' : 'UGC 创作中'}
                </span>
              </div>
              {parsed.parseError && <div className="text-sm text-red-400">{parsed.parseError}</div>}
              {!parsed.tpl && !parsed.parseError && <div className="text-xs text-gray-500">在 JSON 编辑器载入模板后自动校验</div>}
              {tplSource === 'official' && (
                <div className="rounded border border-indigo-900/60 bg-indigo-900/20 p-2 text-xs text-indigo-200 space-y-1">
                  <p>当前是<b>官方模板</b>：key（gso / team-quest / group-buy）、平台特权 Effect、settlement cron 等均为平台内置能力，<b>不受 UGC 安全 Lint 约束</b>，部署走平台通道（合约大厅直接发起）。上方校验仅检查 JSON 结构。</p>
                  <button
                    onClick={() => { setTplSource('ugc'); setSubmitMsg({ ok: false, text: '已切换为 UGC 创作校验——下方问题即改造为合规 UGC 模板需逐条修复的内容（key/特权 Effect 等由服务端在你提交时强制改写，但平台特权 Effect 必须由你移除）。' }); }}
                    className="rounded bg-indigo-600 px-2.5 py-1 text-xs hover:bg-indigo-500"
                  >
                    转为 UGC 创作对象（查看需修复项）
                  </button>
                </div>
              )}
              {acrCheck && (
                <>
                  <div className="flex items-center gap-2">
                    {acrCheck.ok ? (
                      <span className="text-green-400 text-sm font-medium">
                        ✅ 通过（{tplSource === 'official' ? '仅结构校验' : '结构 + 安全 Lint'}）
                      </span>
                    ) : (
                      <span className="text-red-400 text-sm font-medium">❌ {acrCheck.issues.length} 个问题</span>
                    )}
                    {risk && (
                      <span className={`text-xs px-2 py-0.5 rounded ${risk.level === 'low' ? 'bg-green-900/60 text-green-300' : risk.level === 'medium' ? 'bg-yellow-900/60 text-yellow-300' : 'bg-red-900/60 text-red-300'}`}>
                        风险 {risk.level}{risk.reasons.length ? `：${risk.reasons.join('；')}` : '（纯通知类）'}
                      </span>
                    )}
                  </div>
                  {!acrCheck.ok && (
                    <ul className="text-xs space-y-1 max-h-40 overflow-y-auto">
                      {acrCheck.issues.map((i, idx) => (
                        <li key={idx} className="text-red-300">
                          <span className="font-mono text-gray-400">[{i.path}]</span> {i.message}
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
              {/* 提交区（官方模板不显示——部署走合约大厅） */}
              {tplSource === 'official' ? (
                parsed.tpl && (
                  <div className="pt-2 border-t border-gray-800 text-xs text-gray-400 space-y-1">
                    <p>官方模板不经过 UGC 注册中心：在「合约大厅」发起合约时直接选用即可（自动执行档位由平台配置）。</p>
                  </div>
                )
              ) : acrCheck?.ok && parsed.tpl && (
                <div className="pt-2 border-t border-gray-800 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <label className="text-xs text-gray-400">slug</label>
                    <input
                      value={slug}
                      onChange={(e) => setSlug(e.target.value)}
                      placeholder="my-escrow-refund"
                      className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs w-56"
                    />
                    <label className="text-xs text-gray-400 ml-2">部署抽成 bps（可选 0–1000）</label>
                    <input
                      type="number"
                      value={feeBps}
                      min={0}
                      max={1000}
                      onChange={(e) => setFeeBps(Number(e.target.value) || 0)}
                      className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs w-20"
                    />
                    <button
                      onClick={() => void submit()}
                      disabled={submitting || !slug.trim()}
                      className="ml-auto px-4 py-1.5 rounded bg-green-600 hover:bg-green-500 disabled:opacity-50 text-sm"
                    >
                      {submitting ? '提交中…' : '提交注册中心'}
                    </button>
                  </div>
                  <div className="text-xs text-gray-500">提交后 key 将强制为 <span className="font-mono">ugc_&lt;你的ID&gt;_{slug || '…'}</span>；低/中风险自动过审，高风险转人工。新模板首次部署为影子模式。</div>
                  {submitMsg && <pre className={`text-xs whitespace-pre-wrap rounded p-2 ${submitMsg.ok ? 'bg-green-900/30 text-green-200' : 'bg-red-900/30 text-red-200'}`}>{submitMsg.text}</pre>}
                </div>
              )}
            </div>
          )}

          {/* 沙盒模拟器 */}
          {mode !== 'library' && parsed.tpl && (
            <div className="bg-gray-900 rounded-lg border border-gray-800 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="font-semibold text-sm">沙盒模拟器（本地引擎回放，不动真钱）</h2>
                <button onClick={resetSandbox} className="text-xs px-2 py-1 rounded bg-gray-700 hover:bg-gray-600">重置实例</button>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-2 space-y-2">
                  <div className="flex flex-wrap gap-2 items-center">
                    <select value={sbAction} onChange={(e) => setSbAction(e.target.value)} className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs">
                      {Array.from(new Set(parsed.tpl.clauses.flatMap((c): string[] => {
                        if (c.on.kind === 'manual') return [c.on.action || ''];
                        if (c.on.kind === 'cron') return [c.on.schedule || ''];
                        if (c.on.kind === 'event' || c.on.kind === 'protocol') return [c.on.match || ''];
                        return [];
                      }))).filter((a) => a !== '').map((a) => (
                        <option key={a} value={a}>{a}</option>
                      ))}
                    </select>
                    <input value={sbActor} onChange={(e) => setSbActor(e.target.value)} className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs w-28" placeholder="actorId" />
                    <input value={sbPayload} onChange={(e) => setSbPayload(e.target.value)} className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs w-52 font-mono" placeholder='payload JSON，如 {"amount":50}' />
                    <button
                      onClick={() => {
                        const clause = parsed.tpl!.clauses.find((c) => (c.on.action || c.on.schedule || c.on.match) === sbAction);
                        if (!clause) return;
                        // 直接透传条款真实 kind（protocol 携带 channelTokenValid，事件才可命中）
                        runStep(clause.on.kind as 'manual' | 'cron' | 'event' | 'protocol', sbAction);
                      }}
                      className="px-3 py-1 rounded bg-blue-600 hover:bg-blue-500 text-xs"
                    >
                      触发
                    </button>
                    <button onClick={() => tickCron('deadline-check', 3600 * 1000)} className="px-3 py-1 rounded bg-gray-700 hover:bg-gray-600 text-xs">
                      时间快进 1h + deadline-check
                    </button>
                  </div>
                  <div className="text-xs text-gray-500">沙盒时钟：{new Date(sandboxNow).toLocaleString()}</div>
                  <div className="bg-gray-950 rounded border border-gray-800 p-2 max-h-56 overflow-y-auto space-y-1">
                    {sandboxSteps.length === 0 && <div className="text-xs text-gray-600">先点「重置实例」，再触发动作回放</div>}
                    {sandboxSteps.map((s) => (
                      <div key={s.idx} className="text-xs font-mono">
                        <span className={s.ok ? 'text-green-400' : 'text-yellow-400'}>#{s.idx} {s.type}({s.actorId})</span>
                        <span className="text-gray-400"> → {s.result}</span>
                      </div>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-gray-400 mb-1">stateData</div>
                  <pre className="bg-gray-950 rounded border border-gray-800 p-2 text-xs font-mono max-h-64 overflow-auto">{sandboxState || '{}'}</pre>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 可创作合约类型弹层 */}
      {showTypes && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-4" onClick={() => setShowTypes(false)}>
          <div className="my-6 w-full max-w-3xl space-y-4 rounded-xl border border-gray-700 bg-gray-900 p-5" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-bold">目前可创作的合约类型</h2>
                <p className="text-xs text-gray-500">基于引擎 Effect 能力 + ACR 边界整理 · 每类附编辑要点 · 点「用 AI 生成」自动预填需求</p>
              </div>
              <button onClick={() => setShowTypes(false)} className="rounded p-1 text-gray-400 hover:bg-gray-800 hover:text-white">
                <X className="h-5 w-5" />
              </button>
            </div>

            {CONTRACT_TYPES.map((t) => (
              <div key={t.name} className="rounded-lg border border-gray-700 bg-gray-800/40 p-3 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-gray-100">{t.name}</span>
                  <span className={`rounded px-1.5 py-0.5 text-[11px] ${t.risk === 'low' ? 'bg-green-900/60 text-green-300' : t.risk === 'medium' ? 'bg-yellow-900/60 text-yellow-300' : 'bg-red-900/60 text-red-300'}`}>
                    {t.risk === 'low' ? 'low · 自动过审' : t.risk === 'medium' ? 'medium · 自动过审+抽样' : 'high · 人工审核'}
                  </span>
                  <button
                    onClick={() => { setAiInput(t.prompt); setMode('ai'); setShowTypes(false); setSubmitMsg({ ok: true, text: `已按「${t.name}」预填 AI 需求，可直接生成或先补充细节。` }); }}
                    className="ml-auto rounded bg-blue-600 px-2.5 py-1 text-xs hover:bg-blue-500"
                  >
                    用 AI 生成
                  </button>
                </div>
                <p className="text-xs text-gray-400">适用：{t.scene}</p>
                <ul className="list-disc space-y-0.5 pl-5 text-xs leading-relaxed text-gray-300">
                  {t.points.map((p, i) => (
                    <li key={i}>{p}</li>
                  ))}
                </ul>
              </div>
            ))}

            <div className="rounded-lg border border-gray-800 bg-gray-900/60 p-3 text-xs text-gray-400 space-y-1">
              <p><b className="text-gray-200">能力边界（暂不可创作）</b>：凭证铸造 / 治理权重授予 / 平台金库支付 / settlement 收益注入——均为平台特权（ACR-3）。收益分成类需求请使用官方 GSO 模板（合约大厅发起）。</p>
              <p>每个类型的完整可运行示例见「操作指南 ④ 模板示例」，可一键载入编辑器改参数。</p>
            </div>
          </div>
        </div>
      )}

      {/* ACR 规范弹层 */}
      {showSpec && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-4" onClick={() => setShowSpec(false)}>
          <div className="my-6 w-full max-w-3xl space-y-4 rounded-xl border border-gray-700 bg-gray-900 p-5" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-bold">ACR — AllinONE Contract Reference</h2>
                <p className="text-xs text-gray-500">版本 ACR-1/2/3 · 合约模板创作协议 · 与 docs/acr-spec.md 同步维护 · 校验实现见 acrLinter.ts</p>
              </div>
              <button onClick={() => setShowSpec(false)} className="rounded p-1 text-gray-400 hover:bg-gray-800 hover:text-white">
                <X className="h-5 w-5" />
              </button>
            </div>

            <SpecSection title="ACR-1 核心标准（必选）">
              <SpecTable
                head={['条目', '规则']}
                rows={[
                  ['key 命名空间', "必须匹配 /^ugc_[a-z0-9][a-z0-9_-]{2,60}$/，服务端注册时强制 ugc_<作者ID>_<slug>；不得占用官方保留键 gso / team-quest / group-buy"],
                  ['元数据', 'family（teamup | community_revenue）/ version（≥1 整数，升级=version+1）/ title / riskLevel / requiresAudit'],
                  ['initialState', '不得为终局状态（fulfilled / refunded / terminated）'],
                  ['条款数', '≤ 50'],
                  ['单条款 Effect 数', '≤ 12'],
                  ['updates 字段深度', '≤ 3（如 a.b.c）'],
                  ['模板序列化体积', '≤ 256 KB'],
                  ['cron 调度白名单', 'deadline-check / tick-5m（settlement-weekly/monthly 为 GSO 平台特权，禁用）'],
                  ['manual 动作名', '不得使用隧道保留字：__protocol / deploy / sign / invoke / tick / query / detail / verify / escrow'],
                ]}
              />
            </SpecSection>

            <SpecSection title="ACR-2 资金安全标准（涉钱模板必选）">
              <h4 className="mb-1 text-xs font-semibold text-gray-200">灰名单 Effect（平台特权，UGC 一律禁用）</h4>
              <SpecTable
                head={['Effect', '状态', '原因']}
                rows={[
                  ['mintVoucher', '❌ 禁用', '凭证铸造 = 平台货币主权'],
                  ['mintShareVouchers', '❌ 禁用', 'GSO 专用（按认购表逐人铸 RSV）'],
                  ['grantGovernanceWeight', '❌ 禁用', '治理权重 = 平台主权'],
                  ['treasuryDeposit', '❌ 禁用', '直入平台金库（走市场佣金路径）'],
                ]}
              />
              <h4 className="mb-1 mt-3 text-xs font-semibold text-gray-200">受控 Effect</h4>
              <ul className="list-disc space-y-0.5 pl-5">
                <li><b>penalize</b>：目标只允许 <code>expr: event.userId</code>（罚当事人本人），且模板必须 requiresAudit=true</li>
              </ul>
              <h4 className="mb-1 mt-3 text-xs font-semibold text-gray-200">资金守恒（出账收款方封闭）</h4>
              <ul className="list-disc space-y-0.5 pl-5">
                <li>出账（fromUserId 缺省 = 从托管释放）时 toUserId 只允许：<code>expr: event.userId</code> 或 <code>expr: params.某字段</code>（该字段须在 paramsSchema 以 string/enum 声明）</li>
                <li><b>禁止硬编码任何收款人 ID</b>（防"偷钱条款"）</li>
                <li>入托管（toUserId='escrow'）时 fromUserId 同理封闭：只能扣 event.userId 或声明字段的钱</li>
                <li><b>splitPayout 只允许 byField 分账表</b>（literal 表可硬编码收款人，已封禁）；source 不得为 'treasury'</li>
              </ul>
              <h4 className="mb-1 mt-3 text-xs font-semibold text-gray-200">退款可达性</h4>
              <p>资金可进托管的模板，必须存在至少一个出口条款：refundAll / 出账 walletTransfer / splitPayout（source≠treasury）/ penalize。<b>钱进托管必须有出口。</b></p>
            </SpecSection>

            <SpecSection title="ACR-3 治理接口标准">
              <p>governanceTopics / grantGovernanceWeight / settlement 系列 cron 均为平台特权面，UGC 模板不可触达。游戏方出让治理权走 GSO 官方模板（合规前置 + 人工审核）。</p>
            </SpecSection>

            <SpecSection title="风险分级（决定审核路径）">
              <SpecTable
                head={['级别', '判定', '审核路径']}
                rows={[
                  ['low', 'effectsWhitelist ⊆ {setState, notify, openDispute}', '自动通过'],
                  ['medium', '含 walletTransfer / splitPayout / refundAll 且通过守恒 lint', '规则引擎自动审 + 抽样人工'],
                  ['high', '含 penalize / freezeVoucher / unfreezeVoucher / transferVoucher，或 family=community_revenue', '必须人工审核'],
                ]}
              />
              <p className="mt-1 text-gray-400">部署防篡改：审核通过时固化模板内容指纹（codeHash），部署时重算比对，不一致拒绝（防"审核后偷改"）。UGC 模板首次部署恒为影子模式（autoExecute=false）。</p>
            </SpecSection>

            <SpecSection title="Effect 白名单速查（模板只能声明这些）">
              <SpecTable
                head={['Effect', '用途', '关键约束']}
                rows={[
                  ['walletTransfer', '资金托管 / 释放', '出账收款方封闭（见 ACR-2）；入托管扣款来源封闭'],
                  ['refundAll', '托管原路退款', '通常配 setState refunded 终局'],
                  ['splitPayout', '按贡献表分账', 'UGC 只许 byField（share 均分 / proportional 按额）；poolAmount 为 expr'],
                  ['setState', '状态机迁移', '只能迁到 STATE_TRANSITIONS 允许的下一状态'],
                  ['notify', '站内通知', 'toUserId 支持 expr'],
                  ['openDispute', '发起争议', '争议态下资金冻结'],
                  ['freezeVoucher / unfreezeVoucher', '冻结 / 解冻凭证', '高危 → 风险分级 high，需人工审'],
                  ['transferVoucher', '转移凭证', '收款方封闭同 walletTransfer；高危 → high'],
                  ['penalize', '罚没', '仅罚 event.userId；forfeitTo ∈ treasury/rewardPool/members；requiresAudit=true'],
                ]}
              />
            </SpecSection>

            <SpecSection title="模板结构骨架">
              <pre className="max-h-72 overflow-auto rounded bg-gray-950 p-2 text-[10px] leading-relaxed text-emerald-200/90">{`{
  "key": "ugc_<作者>_<slug>",
  "family": "teamup",          // teamup | community_revenue
  "version": 1,
  "title": "...", "description": "...",
  "riskLevel": "medium",       // low | medium | high
  "requiresAudit": false,
  "initialState": "signing",
  "effectsWhitelist": [ ...实际用到的 Effect... ],
  "paramsSchema": {
    "initiatorId": { "type": "string", "required": true, "min": 1, "description": "发起人" },
    "amount":     { "type": "number", "required": true, "min": 1, "description": "..." },
    "deadline":   { "type": "number", "required": true, "description": "毫秒时间戳" }
  },
  "clauses": [
    {
      "id": "c-join", "title": "缴款进托管",
      "on": { "id": "t-join", "kind": "manual", "action": "join", "enabledStates": ["signing"] },
      "when": "now <= params.deadline",
      "then": [
        { "type": "walletTransfer", "toUserId": "escrow", "fromUserId": "expr: event.userId",
          "currency": "gameCoins", "amount": "expr: params.amount", "reason": "..." }
      ],
      "updates": [ { "field": "memberCount", "op": "add", "value": 1 } ]
    }
  ]
}`}</pre>
            </SpecSection>

            <SpecSection title="DSL 速查">
              <ul className="list-disc space-y-0.5 pl-5">
                <li>变量域：<code>now</code> / <code>state.字段</code> / <code>params.字段</code> / <code>event.字段</code>；动态值用 <code>'expr: ...'</code> 前缀</li>
                <li>运算符：+ - * / == != &gt;= &lt;= &gt; &lt; &amp;&amp; || !；null 判空 <code>state.x == null</code></li>
                <li><b>+1 约定</b>：同触发内全部条款评估完后才应用 updates → "达到人数开团"的 when 写 <code>state.memberCount + 1 &gt;= params.minMembers</code></li>
                <li>状态机：draft → signing → funded → active → settling → fulfilled / refunded / breached / disputed / terminated（迁移表见 engine/validate.ts）</li>
                <li>stateData 预置：部署时按 updates 推导初始字段（add→0 / push→[] / set→null），when 读取未声明过的字段会算术报错</li>
              </ul>
            </SpecSection>
          </div>
        </div>
      )}

      {/* 操作指南弹层 */}
      {showGuide && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/70 p-4 overflow-y-auto" onClick={() => setShowGuide(false)}>
          <div className="w-full max-w-3xl rounded-xl border border-gray-700 bg-gray-900 p-5 my-6 space-y-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold">合约工坊 · 操作指南</h2>
              <button onClick={() => setShowGuide(false)} className="rounded p-1 text-gray-400 hover:bg-gray-800 hover:text-white">
                <X className="h-5 w-5" />
              </button>
            </div>

            <GuideSection title="① 工坊是什么">
              <p>合约工坊让<b>人人可创作合约模板</b>。模板（ContractTemplate JSON）就是合约的"源代码"：声明参数、条款与资金流，平台引擎在沙盒内解释执行。创作产物必须通过 <b>ACR 安全校验</b>（结构校验 + 安全 Lint）才能进入注册中心，被他人部署使用。</p>
            </GuideSection>

            <GuideSection title="② 三种创作模式">
              <ul className="list-disc pl-5 space-y-1">
                <li><b>模板库</b>：浏览官方模板与 UGC 市场。点击任一模板即<b>载入完整源码</b>到 JSON 编辑器——官方模板可「复制 JSON」带走，或切到 AI 模式用「按描述修改当前模板」生成你的变体；点 UGC 模板即 <b>fork</b>（改 slug 后提交即成你的新模板）。</li>
                <li><b>AI 生成</b>：用自然语言描述合约逻辑（如"3 人成团，每人 50 币，不成团全额退款"）。AI 输出会先过本地 ACR 校验，<b>不合规会自动回炉重生成一次</b>；信息不足时 AI 会向你追问。需真实账号登录后可用。</li>
                <li><b>JSON 编辑</b>：直接粘贴/编辑模板源码，适合从外部工具导入或手动微调。校验错误按 <code>[路径]</code> 精确定位到字段。</li>
              </ul>
            </GuideSection>

            <GuideSection title="③ ACR 校验面板（实时）">
              <p>编辑器内模板每次变动都会自动跑 <b>结构校验 + 安全 Lint</b>。常见拒绝原因：</p>
              <ul className="list-disc pl-5 space-y-1">
                <li><b>收款方封闭</b>：出账 toUserId 只允许 <code>expr: event.userId</code> 或 <code>expr: params.某string字段</code>，<b>禁止硬编码任何用户 ID</b>（防偷钱条款）；</li>
                <li><b>平台特权 Effect 禁用</b>：mintVoucher / mintShareVouchers / grantGovernanceWeight / treasuryDeposit；</li>
                <li><b>splitPayout 只许 byField</b> 分账表（literal 表可硬编码收款人，已封禁）；</li>
                <li><b>penalize 只许罚事件当事人</b>（<code>expr: event.userId</code>），且模板必须 requiresAudit=true；</li>
                <li><b>cron 白名单</b>：只有 deadline-check / tick-5m；</li>
                <li><b>退款可达</b>：资金进托管就必须有出口条款（refundAll / 出账 / splitPayout / penalize）。</li>
              </ul>
              <p className="text-gray-400">完整规范见项目 <code>docs/acr-spec.md</code>。</p>
            </GuideSection>

            <GuideSection title="④ 模板示例（要点抄给 AI / 一键载入）">
              <p>以下示例均<b>通过 ACR 校验</b>。两种用法：<b>把"要点"逐条粘贴给 AI 模式</b>（AI 会按要点生成变体，如改人数、加条件、换币种），或直接「载入编辑器」改参数提交。</p>
              {GUIDE_EXAMPLES.map((ex, idx) => (
                <div key={ex.name} className="rounded-lg border border-gray-700 bg-gray-900/70 p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-gray-100">{ex.name}</span>
                      <span className="rounded bg-blue-900/60 px-1.5 py-0.5 text-[11px] text-blue-300">{ex.risk}</span>
                    </div>
                    <button
                      onClick={() => loadGuideExample(idx)}
                      className="rounded bg-blue-600 px-2.5 py-1 text-xs hover:bg-blue-500"
                    >
                      载入编辑器
                    </button>
                  </div>
                  <ul className="list-disc pl-5 space-y-0.5">
                    {ex.points.map((p, i) => (
                      <li key={i}>{p}</li>
                    ))}
                  </ul>
                  <details>
                    <summary className="cursor-pointer text-xs text-gray-400 hover:text-gray-200">展开完整模板 JSON</summary>
                    <pre className="mt-1 max-h-60 overflow-auto rounded bg-gray-950 p-2 text-[10px] leading-relaxed text-emerald-200/90">{JSON.stringify(ex.tpl, null, 2)}</pre>
                  </details>
                </div>
              ))}
              <p className="text-gray-400">向 AI 描述的万能句式：<code>"做 [&lt;人数/金额/时间&gt; 参数化] 的 [&lt;进托管条件&gt;] 合约：[&lt;成交时资金去向&gt;]，[&lt;未成交/到期时退款规则&gt;]，[&lt;争议/罚则，可选&gt;]"</code> —— AI 会自动映射为 paramsSchema + clauses。</p>
            </GuideSection>

            <GuideSection title="⑤ 沙盒模拟器（发布前必玩）">
              <p>前端直接跑合约引擎纯函数，<b>不动任何真实资产</b>。步骤：</p>
              <ol className="list-decimal pl-5 space-y-1">
                <li>点「重置实例」——params 取自 payload 输入框当前内容（首个动作触发前可先填好 params JSON）；</li>
                <li>下拉选动作（自动列出模板全部触发器）、填 actorId 与 payload JSON；</li>
                <li>点「触发」逐条回放：日志展示命中条款、Effect 流、state 更新与状态迁移；</li>
                <li>「时间快进 1h + deadline-check」模拟到期场景（退款/结算条款）；</li>
                <li>右侧实时观察 stateData 变化。</li>
              </ol>
              <p className="text-gray-400">提示：读自定义 state 字段的条款依赖部署时的字段预置（按 updates 声明推导），沙盒与线上行为一致；若触发报算术错误，通常是 when 读取了模板从未 update 过的字段。</p>
            </GuideSection>

            <GuideSection title="⑥ 提交注册">
              <ul className="list-disc pl-5 space-y-1">
                <li>校验通过后填写 <b>slug</b>（小写字母数字-_），最终 key 强制为 <code>ugc_&lt;你的ID&gt;_&lt;slug&gt;</code>；同 slug 重复提交 = 新版本（version+1），不同作者同名 slug 互不冲突；</li>
                <li><b>风险分级决定审核路径</b>：low（纯通知/状态）自动过审；medium（涉资金流转）自动过审 + 抽样人工；high（penalize / 冻结或转移凭证 / community_revenue）转平台人工审核；</li>
                <li><b>部署抽成 templateFeeBps</b>（0–1000，可选）：他人部署你的模板时预留的作者分成比例（资金结算后续开放）；</li>
                <li>驳回的模板不进市场、不可部署；修改后重新提交即可。</li>
              </ul>
            </GuideSection>

            <GuideSection title="⑦ 部署与影子模式">
              <p>提交通过后，到「合约大厅」发起合约时即可选择你的 UGC 模板。<b>UGC 模板首次部署恒为影子模式</b>：引擎照常产出执行计划（EffectPlan）但不动真实资金，供平台观察对账；开闸真执行由平台按风险灰度。已过审模板内容与审核版本指纹绑定——过审后若改动需重新提交审核。</p>
            </GuideSection>

            <GuideSection title="⑧ 常见问题">
              <ul className="list-disc pl-5 space-y-1">
                <li><b>AI 按钮提示不可用？</b>AI 生成需要真实登录（游客不可用），可切 JSON 模式手动粘贴模板；</li>
                <li><b>部署报"模板不存在"？</b>该 UGC 模板未过审（pending）或已被驳回；</li>
                <li><b>官方模板能直接用吗？</b>能——在合约大厅发起合约即可选用，无需经过工坊；工坊针对的是<b>定制化模板</b>；</li>
                <li><b>我的草稿在哪？</b>勾选模板库右上「我的」，可见你全部状态（含待审/驳回）的模板。</li>
              </ul>
            </GuideSection>
          </div>
        </div>
      )}
    </div>
  );
}

function GuideSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-gray-800 bg-gray-800/40 p-3">
      <h3 className="mb-1.5 text-sm font-semibold text-blue-300">{title}</h3>
      <div className="space-y-1.5 text-xs leading-relaxed text-gray-300 [&_code]:rounded [&_code]:bg-gray-950 [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[11px] [&_code]:text-emerald-300">
        {children}
      </div>
    </section>
  );
}

/** ACR 规范弹层小节 */
function SpecSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-gray-800 bg-gray-800/40 p-3">
      <h3 className="mb-1.5 text-sm font-semibold text-indigo-300">{title}</h3>
      <div className="space-y-1.5 text-xs leading-relaxed text-gray-300 [&_code]:rounded [&_code]:bg-gray-950 [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[11px] [&_code]:text-emerald-300">
        {children}
      </div>
    </section>
  );
}

/** ACR 规范表格 */
function SpecTable({ head, rows }: { head: string[]; rows: string[][] }) {
  return (
    <div className="overflow-x-auto rounded border border-gray-800">
      <table className="w-full text-left text-[11px] leading-relaxed">
        <thead>
          <tr className="bg-gray-900/80 text-gray-400">
            {head.map((h) => (
              <th key={h} className="px-2 py-1.5 font-medium">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-gray-800/60 align-top">
              {r.map((c, j) => (
                <td key={j} className={`px-2 py-1.5 ${j === 0 ? 'whitespace-nowrap font-mono text-emerald-300' : ''}`}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
