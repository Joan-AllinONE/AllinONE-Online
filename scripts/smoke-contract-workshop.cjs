#!/usr/bin/env node
/**
 * 合约工坊 UGC 模板注册中心冒烟（CW-6，本地 server，USE_MEMORY_DB=true）
 *
 * 场景：
 *   1. 中风险合规模板提交 → 自动过审（approved，reviewPath=auto+sampled）
 *   2. 恶意模板（硬编码收款人）→ 400 ACR 校验未通过
 *   3. 高风险模板（penalize）→ pending；admin approve → approved
 *   4. 高风险未过审时部署 → 404
 *   5. 过审后部署 UGC 模板 → 成功且 autoExecute=false（影子模式）
 *   6. GET /templates 合并 UGC（ugc=true）
 *   7. GET /ugc-templates 市场列表 / ?mine=1
 *   8. admin reject 模板 → 市场不可见、部署 404
 *   9. key 命名空间：服务端强制 ugc_<authorId>_<slug>
 *  10. 部署计数 stats.deployCount 递增
 *
 * 用法：USE_MEMORY_DB=true PORT=3111 MEMORY_DB_FILE=none node server.js 后运行本脚本
 */
'use strict';

const BASE = process.env.SMOKE_BASE || 'http://localhost:3111';
const SECRET = process.env.JWT_SECRET || 'dev-secret-do-not-use-in-prod-change-me';

function signToken(payload) {
  const crypto = require('crypto');
  const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const header = b64u({ alg: 'HS256', typ: 'JWT' });
  const body = b64u(payload);
  const sig = crypto.createHmac('sha256', SECRET).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}
function tokenFor(userId, role) {
  return signToken({ userId, role: role || 'player', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 });
}
async function api(method, path, body, token) {
  const res = await fetch(BASE + path, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: `Bearer ${token}` } : {}),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* noop */ }
  return { status: res.status, json };
}

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? ` — ${JSON.stringify(detail).slice(0, 400)}` : ''}`); }
}

// ============ 模板样例 ============

function compliantMediumTpl() {
  return {
    key: 'ugc_temp',
    family: 'teamup',
    version: 1,
    title: '到期退款演示（冒烟）',
    description: '成员缴款进托管，到期全额自动退款',
    riskLevel: 'medium',
    requiresAudit: false,
    initialState: 'signing',
    effectsWhitelist: ['walletTransfer', 'refundAll', 'setState', 'notify'],
    paramsSchema: {
      initiatorId: { type: 'string', required: true, min: 1, description: '发起人' },
      amount: { type: 'number', required: true, min: 1, description: '每人缴款' },
      deadline: { type: 'number', required: true, description: '截止时间戳 ms' },
    },
    clauses: [
      {
        id: 'c-join', title: '缴款进托管',
        on: { id: 't-join', kind: 'manual', action: 'join', enabledStates: ['signing'] },
        when: 'now <= params.deadline',
        then: [{ type: 'walletTransfer', toUserId: 'escrow', fromUserId: 'expr: event.userId', currency: 'gameCoins', amount: 'expr: params.amount', reason: '缴款' }],
        updates: [{ field: 'count', op: 'add', value: 1 }],
      },
      {
        id: 'c-refund', title: '到期全额退款',
        on: { id: 't-refund', kind: 'cron', schedule: 'deadline-check', enabledStates: ['signing'] },
        when: 'now > params.deadline',
        then: [{ type: 'refundAll', reason: '到期全额退款' }, { type: 'setState', to: 'refunded', reason: '终局' }],
      },
    ],
  };
}

function maliciousTpl() {
  const t = compliantMediumTpl();
  t.clauses = [
    {
      id: 'c-steal', title: '偷钱条款',
      on: { id: 't-steal', kind: 'cron', schedule: 'deadline-check', enabledStates: ['signing'] },
      when: 'true',
      then: [{ type: 'walletTransfer', toUserId: 'attacker_123', currency: 'gameCoins', amount: 100, reason: '打款给作者' }],
    },
    {
      id: 'c-in', title: '缴款进托管',
      on: { id: 't-in', kind: 'manual', action: 'join', enabledStates: ['signing'] },
      when: 'true',
      then: [{ type: 'walletTransfer', toUserId: 'escrow', fromUserId: 'expr: event.userId', currency: 'gameCoins', amount: 'expr: params.amount', reason: '缴款' }],
    },
  ];
  return t;
}

function stateSeedTpl() {
  const t = compliantMediumTpl();
  t.title = '状态预置测试（冒烟）';
  t.effectsWhitelist = ['setState', 'notify'];
  t.clauses = [
    {
      id: 'c-ping', title: '自定义 state 字段计数',
      on: { id: 't-ping', kind: 'manual', action: 'ping', enabledStates: ['signing'] },
      when: 'state.customCount < 3',
      then: [{ type: 'notify', toUserId: 'expr: event.userId', message: 'pong', reason: 'ping' }],
      updates: [{ field: 'customCount', op: 'add', value: 1 }],
    },
  ];
  return t;
}

function highRiskTpl() {
  const t = compliantMediumTpl();
  t.title = '罚没测试模板（冒烟）';
  t.requiresAudit = true;
  t.effectsWhitelist = ['walletTransfer', 'refundAll', 'setState', 'notify', 'penalize'];
  t.clauses = [
    {
      id: 'c-join', title: '缴款进托管',
      on: { id: 't-join', kind: 'manual', action: 'join', enabledStates: ['signing'] },
      when: 'true',
      then: [{ type: 'walletTransfer', toUserId: 'escrow', fromUserId: 'expr: event.userId', currency: 'gameCoins', amount: 'expr: params.amount', reason: '缴款' }],
    },
    {
      id: 'c-quit', title: '退出罚没（当事人本人）',
      on: { id: 't-quit', kind: 'manual', action: 'leave', enabledStates: ['signing'] },
      when: 'true',
      then: [{ type: 'penalize', userId: 'expr: event.userId', currency: 'gameCoins', amount: 1, forfeitTo: 'treasury', purpose: 'bond', reason: '退出违约' }],
    },
    {
      id: 'c-refund', title: '到期全额退款',
      on: { id: 't-refund', kind: 'cron', schedule: 'deadline-check', enabledStates: ['signing'] },
      when: 'now > params.deadline',
      then: [{ type: 'refundAll', reason: '到期全额退款' }, { type: 'setState', to: 'refunded', reason: '终局' }],
    },
  ];
  return t;
}

async function main() {
  console.log(`[smoke] 合约工坊 UGC 注册中心 ${BASE}`);
  const creatorToken = tokenFor('u_creator');
  const adminToken = tokenFor('u_admin', 'admin');
  const P = '/api/v1/games/__contract';

  // 1. 合规中风险模板 → 自动过审
  const sub1 = await api('POST', `${P}/ugc-templates/submit`, { tpl: compliantMediumTpl(), slug: 'escrow-refund-smoke', source: 'manual' }, creatorToken);
  check('合规中风险模板提交成功', sub1.status === 200 && sub1.json?.success, sub1.json);
  check('key 强制为 ugc_<authorId>_<slug>', sub1.json?.data?.key === 'ugc_u_creator_escrow-refund-smoke', sub1.json?.data);
  check('中风险自动过审（auto+sampled）', sub1.json?.data?.status === 'approved' && sub1.json?.data?.reviewPath === 'auto+sampled', sub1.json?.data);
  check('风险分级 = medium', sub1.json?.data?.riskLevel === 'medium', sub1.json?.data);

  // 2. 恶意模板拒绝
  const sub2 = await api('POST', `${P}/ugc-templates/submit`, { tpl: maliciousTpl(), slug: 'evil' }, creatorToken);
  check('硬编码收款人模板被拒（ACR-2）', sub2.status === 400 && JSON.stringify(sub2.json?.data?.issues || '').includes('出账收款方'), sub2.json);

  // 2b. Bug A：splitPayout literal 分账表（硬编码收款人）拒绝
  const evilSplit = compliantMediumTpl();
  evilSplit.title = 'literal 分账洗钱（冒烟）';
  evilSplit.effectsWhitelist = ['walletTransfer', 'splitPayout', 'setState', 'notify'];
  evilSplit.clauses = [
    {
      id: 'c-in', title: '缴款进托管',
      on: { id: 't-in', kind: 'manual', action: 'join', enabledStates: ['signing'] },
      when: 'true',
      then: [{ type: 'walletTransfer', toUserId: 'escrow', fromUserId: 'expr: event.userId', currency: 'gameCoins', amount: 'expr: params.amount', reason: '缴款' }],
    },
    {
      id: 'c-split', title: 'literal 分账',
      on: { id: 't-split', kind: 'cron', schedule: 'deadline-check', enabledStates: ['signing'] },
      when: 'true',
      then: [{ type: 'splitPayout', currency: 'gameCoins', table: { kind: 'literal', rows: [{ userId: 'attacker_123', amount: 'expr: state.totalRaised' }] }, reason: '洗钱' }],
    },
  ];
  const sub2a = await api('POST', `${P}/ugc-templates/submit`, { tpl: evilSplit, slug: 'evil-split' }, creatorToken);
  check('splitPayout literal 分账表被拒（Bug A）', sub2a.status === 400 && JSON.stringify(sub2a.json?.data?.issues || '').includes('literal 分账表禁止'), sub2a.json);

  // 2c. 官方保留键冲突（slug=模板内 key 是官方键也会被强制改写为 ugc_ 前缀，验证不报错且 key 正确）
  const sub2b = await api('POST', `${P}/ugc-templates/submit`, { tpl: compliantMediumTpl(), slug: 'escrow-refund-smoke' }, tokenFor('u_other'));
  check('同 slug 不同作者 → 独立命名空间（ugc_u_other_…）', sub2b.status === 200 && sub2b.json?.data?.key === 'ugc_u_other_escrow-refund-smoke', sub2b.json?.data);

  // 3. 高风险模板 → pending → admin approve
  const sub3 = await api('POST', `${P}/ugc-templates/submit`, { tpl: highRiskTpl(), slug: 'penalize-smoke' }, creatorToken);
  check('高风险模板进入人工审核（pending）', sub3.json?.data?.status === 'pending' && sub3.json?.data?.riskLevel === 'high', sub3.json?.data);
  const hrKey = sub3.json?.data?.key;

  const depPending = await api('POST', `${P}/deploy`, {
    templateKey: hrKey,
    params: { initiatorId: 'u_creator', amount: 10, deadline: Date.now() + 3600e3 },
  }, creatorToken);
  check('未过审高风险模板部署被拒（404）', depPending.status === 404, depPending.json);

  const rev1 = await api('POST', `${P}/admin/ugc-templates/review`, { key: hrKey, approve: true, note: '冒烟放行' }, adminToken);
  check('admin 审核通过高风险模板', rev1.json?.success && rev1.json?.data?.status === 'approved', rev1.json);
  const revNoAdmin = await api('POST', `${P}/admin/ugc-templates/review`, { key: hrKey, approve: true }, creatorToken);
  check('非 admin 审核被拒（403）', revNoAdmin.status === 403, revNoAdmin);

  // 5. 过审后部署
  const dep1 = await api('POST', `${P}/deploy`, {
    templateKey: hrKey,
    params: { initiatorId: 'u_creator', amount: 10, deadline: Date.now() + 3600e3 },
    title: 'UGC 罚没演示',
  }, creatorToken);
  check('UGC 模板部署成功', dep1.json?.success, dep1.json);
  check('UGC 部署为影子模式（autoExecute=false）', dep1.json?.data?.autoExecute === false, dep1.json?.data);

  // 6. GET /templates 合并 UGC
  const tplList = await api('GET', `${P}/templates`, undefined, creatorToken);
  const merged = (tplList.json?.data?.templates || []).find((t) => t.key === hrKey);
  check('GET /templates 合并已过审 UGC（ugc=true）', !!merged && merged.ugc === true, tplList.json?.data?.templates?.map((t) => t.key));

  // 7. 市场列表
  const market = await api('GET', `${P}/ugc-templates`, undefined, creatorToken);
  const marketKeys = (market.json?.data?.templates || []).map((t) => t.key);
  check('市场列表含两个过审模板', marketKeys.includes('ugc_u_creator_escrow-refund-smoke') && marketKeys.includes(hrKey), marketKeys);
  const mineList = await api('GET', `${P}/ugc-templates?mine=1`, undefined, creatorToken);
  check('?mine=1 返回本人模板', ((mineList.json?.data?.templates) || []).some((t) => t.key === hrKey), mineList.json?.data);

  // 10. 部署计数（同一 server 进程可能跑过多次冒烟，累积计数只验证 ≥1 且部署后递增）
  const beforeCnt = (await api('GET', `${P}/ugc-templates/detail?key=${encodeURIComponent(hrKey)}`, undefined, creatorToken)).json?.data?.template?.stats?.deployCount || 0;
  await api('POST', `${P}/deploy`, { templateKey: hrKey, params: { initiatorId: 'u_creator', amount: 10, deadline: Date.now() + 3600e3 } }, creatorToken);
  const afterCnt = (await api('GET', `${P}/ugc-templates/detail?key=${encodeURIComponent(hrKey)}`, undefined, creatorToken)).json?.data?.template?.stats?.deployCount || 0;
  check('部署计数随部署递增', afterCnt > beforeCnt, { beforeCnt, afterCnt });

  // 11. Bug D 端到端：UGC 自定义 state 字段（state.customCount）——部署预置后 invoke 不应 500
  const sub5 = await api('POST', `${P}/ugc-templates/submit`, { tpl: stateSeedTpl(), slug: 'state-seed-smoke' }, creatorToken);
  check('notify-only 低风险模板自动过审', sub5.json?.data?.status === 'approved' && sub5.json?.data?.riskLevel === 'low', sub5.json?.data);
  const dep5 = await api('POST', `${P}/deploy`, {
    templateKey: sub5.json?.data?.key,
    params: { initiatorId: 'u_creator', amount: 1, deadline: Date.now() + 3600e3 },
    title: '状态预置演示',
  }, creatorToken);
  check('state-seed 模板部署成功', dep5.json?.success, dep5.json);
  const inv5 = await api('POST', `${P}/invoke`, { contractId: dep5.json?.data?.contractId, action: 'ping' }, creatorToken);
  // 核心回归：修复前 evaluate 读未初始化 state.customCount（null 参与比较）直接 eval-error 500；
  // 修复后（stateData 预置）when 求值成功、命中 c-ping 条款并产出 plan。
  const hitPing = (inv5.json?.data?.plan?.clauseIds || []).includes('c-ping');
  check('invoke 读自定义 state 字段不炸（stateData 预置生效）', inv5.status === 200 && inv5.json?.success && hitPing && inv5.json?.data?.plan?.updates?.some((u) => u.field === 'customCount' && u.op === 'add'), inv5.json);

  // 8. reject 流程
  const sub4 = await api('POST', `${P}/ugc-templates/submit`, { tpl: highRiskTpl(), slug: 'reject-smoke' }, creatorToken);
  const rjKey = sub4.json?.data?.key;
  const rev2 = await api('POST', `${P}/admin/ugc-templates/review`, { key: rjKey, approve: false, note: '不合规' }, adminToken);
  check('admin 驳回', rev2.json?.data?.status === 'rejected', rev2.json);
  const dep2 = await api('POST', `${P}/deploy`, { templateKey: rjKey, params: { initiatorId: 'u_creator', amount: 1, deadline: Date.now() + 3600e3 } }, creatorToken);
  check('驳回后部署 404', dep2.status === 404, dep2.json);
  const market2 = await api('GET', `${P}/ugc-templates`, undefined, creatorToken);
  check('驳回后市场不可见', !((market2.json?.data?.templates) || []).some((t) => t.key === rjKey), null);

  console.log(`\n[smoke] 结果: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('[smoke] 异常退出:', e);
  process.exit(1);
});
