/**
 * ACR 安全 Linter 单测（CW-0）
 *
 * 覆盖面：
 * - 灰名单 Effect（铸币/治理/金库）拦截
 * - penalize 目标封闭（只许 event.userId）
 * - 资金守恒：出账收款方封闭（禁硬编码收款人 / params 未声明字段）
 * - 退款可达性（有进无出 → 拒绝）
 * - cron 白名单（settlement-* 为平台特权）
 * - 保留动作名 / key 命名空间 / 风险分级
 */
import { describe, it, expect } from 'vitest';
import { lintUgcTemplate, classifyTemplateRisk, validateUgcTemplate, deriveInitialStateData } from '../acrLinter.js';
import { GUIDE_EXAMPLES } from '../examples.js';
import type { ContractTemplate } from '../../types.js';

function baseTemplate(overrides: Partial<ContractTemplate> = {}): ContractTemplate {
  return {
    key: 'ugc_demo_escrow_refund',
    family: 'teamup',
    version: 1,
    title: '测试模板',
    riskLevel: 'medium',
    requiresAudit: false,
    initialState: 'signing',
    effectsWhitelist: ['walletTransfer', 'refundAll', 'setState', 'notify'],
    paramsSchema: {
      initiatorId: { type: 'string', required: true },
      payeeId: { type: 'string', required: true },
      amount: { type: 'number', required: true, min: 1 },
      deadline: { type: 'number', required: true },
    },
    clauses: [
      {
        id: 'c-join',
        title: '缴款进托管',
        on: { id: 't-join', kind: 'manual', action: 'join', enabledStates: ['signing'] },
        when: 'now <= params.deadline',
        then: [
          {
            type: 'walletTransfer',
            toUserId: 'escrow',
            fromUserId: 'expr: event.userId',
            currency: 'gameCoins',
            amount: 'expr: params.amount',
            reason: '缴款',
          },
        ],
        updates: [{ field: 'count', op: 'add', value: 1 }],
      },
      {
        id: 'c-refund',
        title: '到期退款',
        on: { id: 't-refund', kind: 'cron', schedule: 'deadline-check', enabledStates: ['signing'] },
        when: 'now > params.deadline',
        then: [
          { type: 'refundAll', reason: '到期全额退款' },
          { type: 'setState', to: 'refunded', reason: '终局' },
        ],
      },
    ],
    ...overrides,
  } as ContractTemplate;
}

describe('lintUgcTemplate', () => {
  it('合法基线模板通过（零 issue）', () => {
    const issues = lintUgcTemplate(baseTemplate());
    expect(issues).toEqual([]);
  });

  it('validateUgcTemplate 合法基线 ok', () => {
    const r = validateUgcTemplate(baseTemplate());
    expect(r.ok).toBe(true);
  });

  // ---- key 命名空间 ----
  it('非法 key / 官方保留 key 拒绝', () => {
    expect(lintUgcTemplate(baseTemplate({ key: 'my-template' })).some((i) => i.path === 'key')).toBe(true);
    expect(lintUgcTemplate(baseTemplate({ key: 'gso' })).some((i) => i.path === 'key')).toBe(true);
    expect(lintUgcTemplate(baseTemplate({ key: 'team-quest' })).some((i) => i.path === 'key')).toBe(true);
  });

  // ---- 灰名单 Effect ----
  it('铸币 / 治理权重 / 金库存入 Effect 全部拦截', () => {
    for (const bad of ['mintVoucher', 'mintShareVouchers', 'grantGovernanceWeight', 'treasuryDeposit']) {
      const tpl = baseTemplate({
        effectsWhitelist: [bad as any, 'setState'],
        clauses: [
          {
            id: 'c-bad',
            title: '恶意',
            on: { id: 't-bad', kind: 'cron', schedule: 'deadline-check' },
            then: [{ type: bad as any, reason: 'x' } as any],
          },
        ],
      });
      // 结构校验会拦截缺必填字段的 spec，但 lint 的灰名单检查在结构之前独立运行
      const issues = lintUgcTemplate(tpl);
      expect(
        issues.some((i) => i.message.includes('平台特权') || i.path.startsWith('effectsWhitelist')),
        `灰名单 ${bad} 应被拦截`,
      ).toBe(true);
    }
  });

  // ---- penalize 目标封闭 ----
  it('penalize 目标非 event.userId 拒绝；requiresAudit=false 也拒绝', () => {
    const tpl = baseTemplate({
      effectsWhitelist: ['walletTransfer', 'refundAll', 'setState', 'notify', 'penalize'],
      clauses: [
        {
          id: 'c-pen',
          title: '罚没他人',
          on: { id: 't-pen', kind: 'manual', action: 'punish' },
          then: [
            {
              type: 'penalize',
              userId: 'expr: params.victimId',
              currency: 'gameCoins',
              amount: 100,
              forfeitTo: 'treasury',
              reason: 'x',
            } as any,
          ],
        },
      ],
    });
    const issues = lintUgcTemplate(tpl);
    expect(issues.some((i) => i.message.includes('只允许针对事件当事人本人'))).toBe(true);
    expect(issues.some((i) => i.path === 'requiresAudit')).toBe(true);
  });

  it('penalize 目标为 event.userId 且 requiresAudit=true 通过', () => {
    const tpl = baseTemplate({
      requiresAudit: true,
      effectsWhitelist: ['walletTransfer', 'refundAll', 'setState', 'notify', 'penalize'],
      clauses: [
        {
          id: 'c-join',
          title: '加入',
          on: { id: 't-join', kind: 'manual', action: 'join' },
          then: [
            {
              type: 'penalize',
              userId: 'expr: event.userId',
              currency: 'gameCoins',
              amount: 10,
              forfeitTo: 'treasury',
              reason: '自愿惩罚',
            } as any,
          ],
        },
      ],
    });
    const issues = lintUgcTemplate(tpl);
    expect(issues.filter((i) => i.message.includes('penalize') || i.path === 'requiresAudit')).toEqual([]);
  });

  // ---- 出账收款方封闭 ----
  it('硬编码收款人拒绝', () => {
    const tpl = baseTemplate({
      clauses: [
        {
          id: 'c-steal',
          title: '偷钱条款',
          on: { id: 't-steal', kind: 'cron', schedule: 'deadline-check' },
          then: [
            {
              type: 'walletTransfer',
              toUserId: 'attacker_123',
              currency: 'gameCoins',
              amount: 'expr: params.amount',
              reason: '打款给作者',
            } as any,
          ],
        },
        {
          id: 'c-in',
          title: '进托管',
          on: { id: 't-in', kind: 'manual', action: 'join' },
          then: [
            {
              type: 'walletTransfer',
              toUserId: 'escrow',
              fromUserId: 'expr: event.userId',
              currency: 'gameCoins',
              amount: 'expr: params.amount',
              reason: '缴款',
            } as any,
          ],
        },
      ],
    });
    const issues = lintUgcTemplate(tpl);
    expect(issues.some((i) => i.message.includes('出账收款方不得硬编码'))).toBe(true);
  });

  it('出账收款方引用未声明 params 字段拒绝；声明的 string 字段通过', () => {
    const mk = (toUserId: string) =>
      baseTemplate({
        clauses: [
          {
            id: 'c-out',
            title: '出账',
            on: { id: 't-out', kind: 'cron', schedule: 'deadline-check' },
            then: [
              { type: 'walletTransfer', toUserId, currency: 'gameCoins', amount: 'expr: params.amount', reason: '打款' } as any,
            ],
          },
          {
            id: 'c-in',
            title: '进托管',
            on: { id: 't-in', kind: 'manual', action: 'join' },
            then: [
              { type: 'walletTransfer', toUserId: 'escrow', fromUserId: 'expr: event.userId', currency: 'gameCoins', amount: 'expr: params.amount', reason: '缴款' } as any,
            ],
          },
        ],
      });
    // payeeId 已声明（string）→ 通过
    expect(lintUgcTemplate(mk('expr: params.payeeId')).filter((i) => i.message.includes('出账收款方'))).toEqual([]);
    // secretAccount 未声明 → 拒绝
    expect(lintUgcTemplate(mk('expr: params.secretAccount')).some((i) => i.message.includes('出账收款方'))).toBe(true);
  });

  it('入托管扣款来源非当事人拒绝（偷转他人资金）', () => {
    const tpl = baseTemplate({
      clauses: [
        {
          id: 'c-in',
          title: '偷扣他人',
          on: { id: 't-in', kind: 'manual', action: 'join' },
          then: [
            {
              type: 'walletTransfer',
              toUserId: 'escrow',
              fromUserId: 'expr: "user_" + "victim"',
              currency: 'gameCoins',
              amount: 100,
              reason: '偷扣',
            } as any,
          ],
        },
        {
          id: 'c-out',
          title: '出账',
          on: { id: 't-out', kind: 'cron', schedule: 'deadline-check' },
          then: [{ type: 'refundAll', reason: '退款' } as any],
        },
      ],
    });
    expect(lintUgcTemplate(tpl).some((i) => i.message.includes('入托管出资方'))).toBe(true);
  });

  // ---- 退款可达性 ----
  it('有进无出（无任何出口条款）拒绝', () => {
    const tpl = baseTemplate({
      clauses: [
        {
          id: 'c-join',
          title: '缴款进托管',
          on: { id: 't-join', kind: 'manual', action: 'join' },
          then: [
            {
              type: 'walletTransfer',
              toUserId: 'escrow',
              fromUserId: 'expr: event.userId',
              currency: 'gameCoins',
              amount: 'expr: params.amount',
              reason: '缴款',
            } as any,
          ],
        },
      ],
    });
    expect(lintUgcTemplate(tpl).some((i) => i.message.includes('无任何出口条款'))).toBe(true);
  });

  // ---- cron 白名单 ----
  it('settlement-* cron（平台收益注入特权）拒绝', () => {
    const tpl = baseTemplate({
      clauses: [
        {
          id: 'c-rev',
          title: '冒充 GSO 收益分成',
          on: { id: 't-rev', kind: 'cron', schedule: 'settlement-weekly' },
          then: [{ type: 'refundAll', reason: 'x' } as any],
        },
      ],
    });
    expect(lintUgcTemplate(tpl).some((i) => i.message.includes('不在 UGC 白名单'))).toBe(true);
  });

  // ---- 保留动作名 ----
  it('保留动作名 __protocol 拒绝', () => {
    const tpl = baseTemplate({
      clauses: [
        {
          id: 'c-hijack',
          title: '劫持协议通道',
          on: { id: 't-hijack', kind: 'manual', action: '__protocol' },
          then: [{ type: 'notify', message: 'x', reason: 'x' } as any],
        },
      ],
    });
    expect(lintUgcTemplate(tpl).some((i) => i.message.includes('隧道保留字'))).toBe(true);
  });

  // ---- updates 深度 ----
  it('updates 字段深度 > 3 拒绝', () => {
    const tpl = baseTemplate({
      clauses: [
        {
          id: 'c-deep',
          title: '深路径',
          on: { id: 't-deep', kind: 'manual', action: 'join' },
          then: [{ type: 'notify', message: 'x', reason: 'x' } as any],
          updates: [{ field: 'a.b.c.d', op: 'set', value: 1 }],
        },
      ],
    });
    expect(lintUgcTemplate(tpl).some((i) => i.message.includes('深度超过'))).toBe(true);
  });
});

describe('classifyTemplateRisk', () => {
  it('纯通知模板 = low', () => {
    const r = classifyTemplateRisk(
      baseTemplate({ effectsWhitelist: ['setState', 'notify', 'openDispute'] }),
    );
    expect(r.level).toBe('low');
  });

  it('涉资金流转（walletTransfer/refundAll）= medium', () => {
    expect(classifyTemplateRisk(baseTemplate()).level).toBe('medium');
  });

  it('penalize / 凭证冻结 / transferVoucher / community_revenue = high', () => {
    expect(classifyTemplateRisk(baseTemplate({ effectsWhitelist: ['penalize', 'setState'] as any })).level).toBe('high');
    expect(classifyTemplateRisk(baseTemplate({ effectsWhitelist: ['freezeVoucher', 'setState'] as any })).level).toBe('high');
    expect(classifyTemplateRisk(baseTemplate({ effectsWhitelist: ['transferVoucher', 'setState'] as any })).level).toBe('high');
    expect(classifyTemplateRisk(baseTemplate({ family: 'community_revenue' })).level).toBe('high');
  });
});

describe('安全漏洞回归：splitPayout literal 分账表（Bug A 修复）', () => {
  it('literal 表硬编码收款人拒绝（洗托管资金）；byField 通过', () => {
    const mk = (kind: string) =>
      baseTemplate({
        effectsWhitelist: ['walletTransfer', 'splitPayout', 'setState', 'notify'],
        clauses: [
          {
            id: 'c-in',
            title: '缴款进托管',
            on: { id: 't-in', kind: 'manual', action: 'join' },
            then: [
              { type: 'walletTransfer', toUserId: 'escrow', fromUserId: 'expr: event.userId', currency: 'gameCoins', amount: 'expr: params.amount', reason: '缴款' } as any,
            ],
            updates: [{ field: 'contributions', op: 'push', value: 0 }],
          },
          {
            id: 'c-split',
            title: '分账',
            on: { id: 't-split', kind: 'cron', schedule: 'deadline-check' },
            then: [
              kind === 'literal'
                ? { type: 'splitPayout', currency: 'gameCoins', table: { kind: 'literal', rows: [{ userId: 'attacker_123', amount: 'expr: state.totalRaised' }] }, reason: '洗钱' } as any
                : { type: 'splitPayout', currency: 'gameCoins', table: { kind: 'byField', amountField: 'share', poolAmount: 'expr: state.totalRaised' }, reason: '按贡献分' } as any,
            ],
          },
        ],
      });
    // literal：拒绝
    expect(lintUgcTemplate(mk('literal')).some((i) => i.message.includes('literal 分账表禁止'))).toBe(true);
    // byField：通过（无 literal 相关 issue）
    expect(lintUgcTemplate(mk('byField')).filter((i) => i.message.includes('literal'))).toEqual([]);
  });
});

describe('操作指南示例（GUIDE_EXAMPLES）必须永远合规', () => {
  it.each(GUIDE_EXAMPLES.map((ex) => [ex.name, ex] as const))('%s 通过 validateUgcTemplate', (_name, ex) => {
    const r = validateUgcTemplate(ex.tpl as any);
    expect(r.issues, r.issues.map((i) => `[${i.path}] ${i.message}`).join('\n')).toEqual([]);
  });

  it.each(GUIDE_EXAMPLES.map((ex) => [ex.name, ex] as const))('%s 状态机可达终局（有终局迁移条款）', (_name, ex) => {
    const tpl = ex.tpl as any;
    const hasTerminal = tpl.clauses.some(
      (c: any) => (c.then || []).some((e: any) => e.type === 'setState' && ['fulfilled', 'refunded'].includes(e.to)),
    );
    expect(hasTerminal).toBe(true);
  });
});

describe('deriveInitialStateData（Bug D 修复：stateData 预置）', () => {
  it('updates 推导：add→0、push→[]、set→null；与官方 preset 合并', () => {
    const tpl = baseTemplate();
    (tpl.clauses[0].updates as any[]).push({ field: 'maxCap', op: 'set', value: 10 });
    const seed = deriveInitialStateData(tpl);
    // 基线模板 c-join 有 add count → 0
    expect(seed.count).toBe(0);
    // 官方 preset 保留
    expect(seed.memberCount).toBe(0);
    expect(Array.isArray(seed.contributions)).toBe(true);
    // set 字段预置 null
    expect(seed.maxCap).toBeNull();
  });

  it('官方模板（team-quest）可完整预置不炸', () => {
    const seed = deriveInitialStateData({ clauses: [{ updates: [] }] } as any);
    expect(seed.memberCount).toBe(0);
  });
});
