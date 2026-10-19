/**
 * ContractAIBridge — 合约工坊 AI 桥（CW-3）
 *
 * 自然语言 → ContractTemplate JSON（ACR 规范内生成）→ 本地 ACR 校验 → 失败回炉重生成。
 * 复用 ugcBridgeService 的 CloudBase AI 接入模式（deepseek-v4-flash，登录用户可用）。
 *
 * 安全设计：
 * - System prompt 注入 ACR 规范精简版 + Effect 白名单 + 官方模板 few-shot；
 * - 明令禁止编造白名单外 Effect / 灰名单特权 Effect（服务端 lint 兜底，prompt 只是第一道）；
 * - 生成结果一律过 validateUgcTemplate（纯函数，前端本地可跑），失败把 issues 回喂 AI 修复（最多 1 次）。
 */
import { validateUgcTemplate } from '@/contracts/index.js';
import type { ContractTemplate } from '@/contracts/index.js';

// ==================== ACR Prompt 精简规范（与 docs/acr-spec.md 同步维护） ====================

const ACR_PROMPT_SPEC = `
# ACR 合约模板规范（必须严格遵守，违反即拒绝部署）

## 模板结构
{
  "key": "ugc_<作者>_<slug>",   // 服务端会强制改写，你给 slug 含义即可；小写字母数字_-
  "family": "teamup" | "community_revenue",
  "version": 1,
  "title": "简短标题",
  "description": "合约语义说明",
  "riskLevel": "low" | "medium" | "high",
  "requiresAudit": false,
  "initialState": "signing",
  "effectsWhitelist": [ ...实际用到的 EffectType，只能从中选 ],
  "paramsSchema": { "字段名": { "type": "number|string|boolean|enum|array|object", "required": true, "min": 0, "max": 100, "enumValues": [...], "description": "中文说明" } },
  "clauses": [ { "id": "c-xxx", "title": "中文标题", "on": { "id": "t-xxx", "kind": "manual|event|protocol|cron", "action": "join", "match": "事件名", "schedule": "deadline-check", "enabledStates": ["signing","active"] }, "when": "DSL 条件或缺省 true", "then": [ Effect 声明 ], "updates": [ { "field": "计数器", "op": "add|set|push", "value": 1 } ] } ]
}

## Effect 白名单（只能用这些，禁止编造）
walletTransfer(资金托管/释放), refundAll(托管退款), splitPayout(按表分账), setState(状态迁移), notify(通知), openDispute(挑战), freezeVoucher/unfreezeVoucher(冻结凭证), transferVoucher(转移凭证), penalize(罚没，高危)

## 绝对禁止（平台特权，UGC 禁用）
- mintVoucher / mintShareVouchers / grantGovernanceWeight / treasuryDeposit
- splitPayout 的 source 不许写 "treasury"
- cron.schedule 只能是 "deadline-check" 或 "tick-5m"（settlement-weekly/monthly 禁用）

## 资金守恒（ACR-2，最易犯错）
- 入托管：walletTransfer 的 toUserId="escrow"，fromUserId 只能是 "expr: event.userId" 或 "expr: params.<string字段>"
- 出账（fromUserId 缺省=从托管释放）：toUserId 只能是 "expr: event.userId" 或 "expr: params.<paramsSchema 里声明的 string 字段>"；禁止硬编码任何具体用户 ID
- penalize 的 userId 只能是 "expr: event.userId"（罚当事人本人），且 requiresAudit 必须 true
- 有资金进托管就必须有出口条款（refundAll / 出账 walletTransfer / splitPayout / penalize 至少其一）

## 触发器与 DSL
- manual 动作名禁止：__protocol / deploy / sign / invoke / tick 等保留字；用 join / subscribe / leave / fund-pool / settle / dispute 等语义名
- when 表达式变量：now / state.<field> / params.<field> / event.<field>；运算符支持 + - * / == != >= <= > > && || !；null 判空用 params.xxx == null
- 同触发内多条条款的 updates 在全部评估后才应用 → "达到人数开团"的 when 要写 state.memberCount + 1 >= params.minMembers
- 条款数 ≤ 50，单条款 Effect ≤ 12

## 风险分级（服务端自动判定）
- low = effectsWhitelist ⊆ {setState, notify, openDispute}
- medium = 含 walletTransfer / splitPayout / refundAll
- high = 含 penalize / freezeVoucher / unfreezeVoucher / transferVoucher（needs requiresAudit=true）
`.trim();

const FEW_SHOT = `
# 参考示例（合规最小模板）
${JSON.stringify(
  {
    key: 'ugc_demo_escrow_refund',
    family: 'teamup',
    version: 1,
    title: '到期退款演示',
    description: '成员缴款进托管，到期全额自动退款',
    riskLevel: 'medium',
    requiresAudit: false,
    initialState: 'signing',
    effectsWhitelist: ['walletTransfer', 'refundAll', 'setState', 'notify'],
    paramsSchema: {
      payeeId: { type: 'string', required: true, description: '收款方（出账演示）' },
      amount: { type: 'number', required: true, min: 1, description: '每人缴款' },
      deadline: { type: 'number', required: true, description: '截止时间戳 ms' },
    },
    clauses: [
      {
        id: 'c-join',
        title: '缴款进托管',
        on: { id: 't-join', kind: 'manual', action: 'join', enabledStates: ['signing'] },
        when: 'now <= params.deadline',
        then: [
          { type: 'walletTransfer', toUserId: 'escrow', fromUserId: 'expr: event.userId', currency: 'gameCoins', amount: 'expr: params.amount', reason: '缴款' },
        ],
        updates: [{ field: 'count', op: 'add', value: 1 }],
      },
      {
        id: 'c-refund',
        title: '到期全额退款',
        on: { id: 't-refund', kind: 'cron', schedule: 'deadline-check', enabledStates: ['signing'] },
        when: 'now > params.deadline',
        then: [{ type: 'refundAll', reason: '到期全额退款' }, { type: 'setState', to: 'refunded', reason: '终局' }],
      },
    ],
  },
  null,
  0,
)}`.trim();

// ==================== AI 接入 ====================

type GenerateFn = (prompt: string) => Promise<string>;

let aiGenerate: GenerateFn | null = null;
let aiInitTried = false;

/** 延迟初始化 CloudBase AI（登录用户可用；失败静默降级为不可用） */
async function ensureAI(): Promise<GenerateFn | null> {
  if (aiInitTried) return aiGenerate;
  aiInitTried = true;
  try {
    const { isCloudBaseReady, getCloudBaseApp } = await import('./cloudbase');
    if (!isCloudBaseReady()) return null;
    const app = getCloudBaseApp();
    const auth = app.auth({ persistence: 'local' });
    let isRealUser = false;
    try {
      const loginState = await auth.getLoginState();
      isRealUser = !!loginState && !(loginState.user as unknown as { is_anonymous?: boolean } | undefined)?.is_anonymous;
    } catch {
      /* 未登录 */
    }
    if (!isRealUser) return null;
    const model = app.ai().createModel('cloudbase');
    aiGenerate = async (prompt: string) => {
      const result = await model.generateText({
        model: 'deepseek-v4-flash',
        messages: [{ role: 'user', content: prompt }],
      });
      return result.text;
    };
    console.log('[contractAIBridge] AI 模型已接入 (cloudbase/deepseek-v4-flash)');
    return aiGenerate;
  } catch (e) {
    console.warn('[contractAIBridge] AI 初始化失败:', e instanceof Error ? e.message : String(e));
    return null;
  }
}

// ==================== 输出解析 ====================

function parseTemplateOutput(text: string): { tpl?: Record<string, unknown>; reasoning?: string; questions?: string[] } {
  try {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return {};
    const parsed = JSON.parse(m[0]) as Record<string, unknown>;
    // 允许 { tpl: {...}, reasoning } 或直接模板对象
    const tpl = (parsed.tpl && typeof parsed.tpl === 'object' ? parsed.tpl : parsed) as Record<string, unknown>;
    const reasoning = typeof parsed.reasoning === 'string' ? parsed.reasoning : undefined;
    const questions = Array.isArray(parsed.questions) ? (parsed.questions as string[]) : undefined;
    if (!tpl || typeof tpl !== 'object' || !('clauses' in tpl)) return { reasoning, questions };
    return { tpl, reasoning, questions };
  } catch {
    return {};
  }
}

// ==================== 核心 API ====================

export interface ContractAIResult {
  ok: boolean;
  tpl?: Record<string, unknown>;
  reasoning?: string;
  questions?: string[];
  issues?: Array<{ path: string; message: string }>;
  error?: string;
}

function systemSection(): string {
  return `${ACR_PROMPT_SPEC}\n\n${FEW_SHOT}`;
}

function userSection(intent: string, mode: 'create' | 'iterate', currentTpl?: Record<string, unknown>): string {
  if (mode === 'create') {
    return `用户需求："${intent}"\n\n请生成一个符合 ACR 规范的合约模板。严格按以下 JSON 格式返回（不要包含其他文字）：\n{ "tpl": { ...完整 ContractTemplate... }, "reasoning": "设计说明（中文，简述条款逻辑与资金流）", "questions": ["缺失关键信息时的追问，无则省略"] }\n注意：paramsSchema 的 description 要写清楚，玩家看得懂；时间类参数用毫秒时间戳并在 description 说明。`;
  }
  return `当前模板：\n${JSON.stringify(currentTpl, null, 0)}\n\n用户修改需求："${intent}"\n\n请在保持 ACR 合规的前提下输出修改后的完整模板。严格按以下 JSON 格式返回（不要包含其他文字）：\n{ "tpl": { ...修改后的完整 ContractTemplate... }, "reasoning": "改动说明（中文）" }`;
}

/** 本地 ACR 校验（纯函数；AI 出口必过） */
export function checkTemplate(tpl: unknown): { ok: boolean; issues: Array<{ path: string; message: string }> } {
  try {
    const r = validateUgcTemplate(tpl as ContractTemplate);
    return { ok: r.ok, issues: r.issues };
  } catch (e) {
    return { ok: false, issues: [{ path: 'tpl', message: e instanceof Error ? e.message : String(e) }] };
  }
}

/** 自然语言生成合约模板（含一次回炉修复） */
export async function generateContractTemplate(intent: string): Promise<ContractAIResult> {
  const generate = await ensureAI();
  if (!generate) {
    return { ok: false, error: 'AI 暂不可用（需真实登录）。可切换「JSON 导入」模式手动粘贴模板。' };
  }
  const prompt = `${systemSection()}\n\n# 任务\n${userSection(intent, 'create')}`;
  let text: string;
  try {
    text = await generate(prompt);
  } catch (e) {
    return { ok: false, error: `AI 调用失败: ${e instanceof Error ? e.message : String(e)}` };
  }
  const first = parseTemplateOutput(text);
  if (first.questions && first.questions.length > 0 && !first.tpl) {
    return { ok: false, questions: first.questions, reasoning: first.reasoning, error: 'AI 需要更多信息' };
  }
  if (!first.tpl) return { ok: false, error: 'AI 输出格式异常，无法解析出模板' };

  const check1 = checkTemplate(first.tpl);
  if (check1.ok) return { ok: true, tpl: first.tpl, reasoning: first.reasoning };

  // 回炉：把 issues 喂回去修复一次
  try {
    const fixPrompt = `${systemSection()}\n\n# 任务\n${userSection(intent, 'create')}\n\n# 上次输出未通过校验，请修复以下问题后重新输出完整模板：\n${check1.issues
      .map((i) => `- [${i.path}] ${i.message}`)
      .join('\n')}`;
    const text2 = await generate(fixPrompt);
    const second = parseTemplateOutput(text2);
    if (second.tpl) {
      const check2 = checkTemplate(second.tpl);
      if (check2.ok) return { ok: true, tpl: second.tpl, reasoning: second.reasoning };
      return { ok: false, tpl: second.tpl, issues: check2.issues, error: 'AI 生成两次均未通过 ACR 校验，可切换 JSON 模式手动修复' };
    }
  } catch {
    /* 回炉失败，按首轮结果返回 */
  }
  return { ok: false, tpl: first.tpl, issues: check1.issues, error: 'AI 生成未通过 ACR 校验，可切换 JSON 模式手动修复' };
}

/** 迭代修改现有模板（生成 diff 语义的完整模板） */
export async function iterateContractTemplate(
  tpl: Record<string, unknown>,
  instruction: string,
): Promise<ContractAIResult> {
  const generate = await ensureAI();
  if (!generate) return { ok: false, error: 'AI 暂不可用（需真实登录）' };
  const prompt = `${systemSection()}\n\n# 任务\n${userSection(instruction, 'iterate', tpl)}`;
  try {
    const text = await generate(prompt);
    const parsed = parseTemplateOutput(text);
    if (!parsed.tpl) return { ok: false, error: 'AI 输出格式异常' };
    const check = checkTemplate(parsed.tpl);
    if (!check.ok) return { ok: false, tpl: parsed.tpl, issues: check.issues, error: '修改后的模板未通过 ACR 校验' };
    return { ok: true, tpl: parsed.tpl, reasoning: parsed.reasoning };
  } catch (e) {
    return { ok: false, error: `AI 调用失败: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** AI 可用性（UI 提示用） */
export async function isAIAvailable(): Promise<boolean> {
  return (await ensureAI()) !== null;
}
