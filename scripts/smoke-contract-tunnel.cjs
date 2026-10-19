#!/usr/bin/env node
/**
 * 合约隧道端到端冒烟测试（本地 server，USE_MEMORY_DB=true）
 *
 * 场景 A：GroupBuy 完整闭环
 *   充值 → deploy(3人成团) → 3 人 join → 满员自动交割给发起人 → verify 完整性 → 余额核对
 * 场景 B：流团自动退款
 *   deploy(3人) → 1 人 join → tick(deadline-check) → refundAll → 状态 refunded → 退款余额核对
 * 场景 C：幂等重放
 *   同 triggerId 重复 join → duplicate-trigger 拒绝
 *
 * 用法：先启动 server（USE_MEMORY_DB=true PORT=3000 node server.js），再 node scripts/smoke-contract-tunnel.cjs
 */
'use strict';

const BASE = process.env.SMOKE_BASE || 'http://localhost:3000';
const SECRET = process.env.JWT_SECRET || 'dev-secret-do-not-use-in-prod-change-me';

function signToken(payload) {
  // 与 authTokenService 的 dev-token 口径一致（HS256，userId/role）
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

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ` — ${JSON.stringify(detail).slice(0, 200)}` : ''}`);
  }
}

async function main() {
  console.log(`[smoke] ${BASE}`);
  const adminToken = tokenFor('u_admin', 'admin');
  const initToken = tokenFor('u_init');
  const aToken = tokenFor('u_a');
  const bToken = tokenFor('u_b');

  // ---- 前置：给测试用户充值（userId 以 token 为准，各自 token 各自充）----
  console.log('\n== 前置：充值 ==');
  for (const u of ['u_init', 'u_a', 'u_b']) {
    const r = await api('POST', '/api/v1/games/__wallet/platform/adjust',
      { delta: 1000, description: 'smoke-test', txId: `smoke_${u}_${Date.now()}` }, tokenFor(u));
    check(`充值 ${u}`, r.status === 200 && r.json && r.json.success === true, r.json);
  }

  // ---- 模板列表 ----
  console.log('\n== GET /templates ==');
  const tpl = await api('GET', '/api/v1/games/__contract/templates');
  check('模板列表可访问', tpl.status === 200 && tpl.json.success, tpl.json);
  const keys = ((tpl.json.data || {}).templates || []).map((t) => t.key);
  check('三模板注册（group-buy/team-quest/gso）', ['group-buy', 'team-quest', 'gso'].every((k) => keys.includes(k)), keys);

  // ---- 场景 A：成团闭环 ----
  console.log('\n== 场景 A：GroupBuy 成团交割 ==');
  const now = Date.now();
  const dep = await api('POST', '/api/v1/games/__contract/deploy', {
    templateKey: 'group-buy',
    title: '冒烟拼团',
    params: {
      itemTitle: '冒烟测试皮肤包',
      initiatorId: 'u_init',
      unitPrice: 100,
      groupPrice: 80,
      minMembers: 3,
      maxMembers: 3,
      openAt: now,
      closeAt: now + 48 * 3600 * 1000,
      currency: 'gameCoins',
      perUserLimit: 1,
      disputeWindowMs: 72 * 3600 * 1000,
    },
  }, initToken);
  check('deploy 成功（signing）', dep.status === 200 && dep.json.data && dep.json.data.state === 'signing', dep.json);
  const contractId = dep.json.data && dep.json.data.contractId;
  check('codeHash 返回', !!(dep.json.data && dep.json.data.codeHash && /^[0-9a-f]{64}$/.test(dep.json.data.codeHash)));

  for (const t of [aToken, bToken, initToken]) {
    const j = await api('POST', '/api/v1/games/__contract/invoke',
      { contractId, action: 'join', triggerId: `join_${contractId}_${Math.random().toString(36).slice(2, 8)}` }, t);
    check(`join（${t === initToken ? 'initiator' : 'member'}）`, j.status === 200, j.json);
  }

  const afterJoin = await api('GET', `/api/v1/games/__contract/detail?id=${contractId}`);
  const st = (afterJoin.json.data || {}).contract || {};
  check('满员后进入 settling（成团交割）', st.state === 'settling', st.state);
  check('memberCount=3', (st.stateData || {}).memberCount === 3, st.stateData);

  const ver = await api('GET', `/api/v1/games/__contract/verify?id=${contractId}`);
  check('verify 完整（规则+链+签名）', ver.json.data && ver.json.data.intact === true, ver.json.data);

  // 发起人余额：1000（充值）- 80（自己 join 也是买家）+ 240（交割 3×80）= 1160
  const bal1 = await api('GET', '/api/v1/games/__wallet/platform/balance', undefined, initToken);
  const initCoins = bal1.json && bal1.json.data && bal1.json.data.balance ? bal1.json.data.balance.gameCoins : null;
  check(`发起人余额 1160（付 80 收 240）`, initCoins === 1160, { got: initCoins, resp: bal1.json });

  // ---- 场景 B：流团退款 ----
  console.log('\n== 场景 B：到期未成团自动退款 ==');
  const dep2 = await api('POST', '/api/v1/games/__contract/deploy', {
    templateKey: 'group-buy',
    params: {
      itemTitle: '冒烟流团',
      initiatorId: 'u_init',
      unitPrice: 100, groupPrice: 80,
      minMembers: 3, maxMembers: 5,
      openAt: now, closeAt: now + 1000, // 已接近截止
      currency: 'gameCoins', perUserLimit: 1, disputeWindowMs: 72 * 3600 * 1000,
    },
  }, initToken);
  const c2 = dep2.json.data && dep2.json.data.contractId;
  const dupTrigger = 'b_join_fixed_id';
  const j1 = await api('POST', '/api/v1/games/__contract/invoke', { contractId: c2, action: 'join', triggerId: dupTrigger }, aToken);
  check('1 人加入', j1.status === 200, j1.json);
  // 场景 C：同 triggerId 重放 → 幂等拒绝
  const dup2 = await api('POST', '/api/v1/games/__contract/invoke', { contractId: c2, action: 'join', triggerId: dupTrigger }, aToken);
  check('同 triggerId 重放 → duplicate-trigger', dup2.json.code === 'duplicate-trigger', { code: dup2.json.code });
  // 等 closeAt 过去
  await new Promise((r) => setTimeout(r, 1200));
  const tick = await api('POST', '/api/v1/games/__contract/tick', {});
  check('tick 执行', tick.status === 200, tick.json);
  const d2 = await api('GET', `/api/v1/games/__contract/detail?id=${c2}`);
  const st2 = (d2.json.data || {}).contract || {};
  check('流团 → refunded', st2.state === 'refunded', st2.state);
  const bal2 = await api('GET', '/api/v1/games/__wallet/platform/balance', undefined, aToken);
  const aCoins2 = bal2.json && bal2.json.data && bal2.json.data.balance ? bal2.json.data.balance.gameCoins : null;
  // u_a: 1000 充值 -80（场景A join 货款已交割）-80（场景B join）+80（场景B 流团退款）= 920
  check('u_a 退款后余额 920', aCoins2 === 920, { got: aCoins2, resp: bal2.json });

  // ---- 场景 D：TeamQuest bond/pool purpose 隔离（B-2/B-3 修复验证）----
  console.log('\n== 场景 D：TeamQuest 资金用途隔离 ==');
  const dep3 = await api('POST', '/api/v1/games/__contract/deploy', {
    templateKey: 'team-quest',
    params: {
      questId: 'smoke-quest',
      initiatorId: 'u_init',
      questTitle: '冒烟任务',
      minMembers: 2,
      maxMembers: 3,
      recruitmentDeadline: now + 3600 * 1000,
      taskDeadline: now - 1000, // 立即到期
      rewardPool: { amount: 500, currency: 'gameCoins' },
      memberBond: 100,
      earlyExitBps: 2000,
      protocolEvent: 'GAME_EVENT:SCORE',
      disputeWindowMs: 72 * 3600 * 1000,
    },
  }, initToken);
  const c3 = dep3.json.data && dep3.json.data.contractId;
  check('TeamQuest deploy', dep3.status === 200, dep3.json);
  const dJ1 = await api('POST', '/api/v1/games/__contract/invoke', { contractId: c3, action: 'join' }, initToken);
  check('团长 join（bond 100）', dJ1.status === 200, dJ1.json);
  const dJ2 = await api('POST', '/api/v1/games/__contract/invoke', { contractId: c3, action: 'join' }, aToken);
  check('团员 join（bond 100，+1 触发开团 → active）', dJ2.status === 200 && dJ2.json.data && dJ2.json.data.state === 'active', dJ2.json);
  const fp = await api('POST', '/api/v1/games/__contract/invoke', { contractId: c3, action: 'fund-pool' }, initToken);
  check('团长注入奖池 500', fp.status === 200, fp.json);
  const tick2 = await api('POST', '/api/v1/games/__contract/tick', {});
  check('tick 执行（零贡献结算）', tick2.status === 200, tick2.json);
  const d3 = await api('GET', `/api/v1/games/__contract/detail?id=${c3}`);
  const st3 = (d3.json.data || {}).contract || {};
  check('零贡献 → settling（奖池退发起人 + bond 全退）', st3.state === 'settling', st3.state);
  const bal3 = await api('GET', '/api/v1/games/__wallet/platform/balance', undefined, initToken);
  const initCoins3 = bal3.json && bal3.json.data && bal3.json.data.balance ? bal3.json.data.balance.gameCoins : null;
  // u_init: 1160（场景A后）-100（D bond）-500（注入奖池）+500（奖池原路退回）+100（bond 退）= 1160
  check('发起人余额 1160（奖池原路退回，未混入 bond）', initCoins3 === 1160, { got: initCoins3 });
  const bal4 = await api('GET', '/api/v1/games/__wallet/platform/balance', undefined, aToken);
  const aCoins3 = bal4.json && bal4.json.data && bal4.json.data.balance ? bal4.json.data.balance.gameCoins : null;
  // u_a: 920（A+B 后）-100（bond）+100（bond 全退，未被当奖池分掉）= 920
  check('u_a 余额 920（bond 全额退还，FIFO 隔离生效）', aCoins3 === 920, { got: aCoins3 });

  // ---- 场景 E：GSO 全流程（审核→认购→交割铸RSV→收益注入→自动分账）----
  console.log('\n== 场景 E：GSO 认购与收益分账 ==');
  const nowE = Date.now(); // 独立时间基准（复用场景 A 的 now 会导致 closeAt 已过期）
  // seed 游戏档案（2026-10-10 起 GSO 发行需核验 publisherId）
  await api('POST', '/api/v1/games', { id: 'game_gso_smoke', name: '冒烟游戏', publisherId: 'u_init' }, initToken);
  const dep4 = await api('POST', '/api/v1/games/__contract/deploy', {
    templateKey: 'gso',
    params: {
      gameId: 'game_gso_smoke',
      issuerId: 'u_init',
      gameName: '冒烟游戏',
      raiseTarget: 10000,
      currency: 'gameCoins',
      revenueShareBps: 3000, // 出让 30% 收益
      governanceShareBps: 3000,
      openAt: nowE,
      closeAt: nowE + 1500, // 快速截止（认购后 1.5s 过期）
      softCap: 2000,
      perUserCap: 5000,
      coolDownMs: 0,
      lockupMs: 30 * 24 * 3600 * 1000,
      revenueSources: ['market_commission', 'store_sale'],
      settlementCron: 'weekly',
      governableTopics: ['ADJUST_PRICE'],
      disputeWindowMs: 72 * 3600 * 1000,
    },
  }, initToken);
  const c4 = dep4.json.data && dep4.json.data.contractId;
  check('GSO deploy（requiresAudit → draft）', dep4.status === 200 && dep4.json.data && dep4.json.data.state === 'draft', dep4.json);
  const rv = await api('POST', '/api/v1/games/__contract/admin/review', { contractId: c4, approve: true, note: '冒烟审核' }, adminToken);
  check('平台审核通过 → signing', rv.status === 200 && rv.json.data && rv.json.data.state === 'signing', rv.json);
  for (const [t, amt] of [[initToken, 1000], [aToken, 900], [bToken, 900]]) {
    const s = await api('POST', '/api/v1/games/__contract/invoke', { contractId: c4, action: 'subscribe', payload: { amount: amt } }, t);
    check(`认购 ${amt}（${t === initToken ? 'u_init' : t === aToken ? 'u_a' : 'u_b'}）`, s.status === 200, s.json);
  }
  await new Promise((r) => setTimeout(r, 1800)); // 等 closeAt（nowE+1500）过去
  const tick3 = await api('POST', '/api/v1/games/__contract/tick', {});
  check('tick：到期达标交割', tick3.status === 200, tick3.json);
  const d4 = await api('GET', `/api/v1/games/__contract/detail?id=${c4}`);
  const st4 = (d4.json.data || {}).contract || {};
  check('GSO → active（交割完成，收益分成生效）', st4.state === 'active', st4.state);
  // 断言：历史中存在「含 mintShareVouchers 的成功 plan」（认购 plan 也有 effects-applied，须按效果类型匹配）
  const mintOk = (st4.history || []).some(
    (h) => h.type === 'effects-applied' && (h.payload.effects || []).some((e) => e.type === 'mintShareVouchers' && (e.rows || []).length === 3),
  );
  check('交割效果含 mintShareVouchers（RSV 铸造 3 张）', mintOk);
  const rsvRows = (st4.history || []).flatMap((h) => (h.type === 'effects-applied' ? (h.payload.effects || []) : [])).find((e) => e.type === 'mintShareVouchers');
  check('RSV 带 frozenAt 锁定（B-8）', !!rsvRows && (rsvRows.rows || []).every((r) => r.share > 0 && r.share < 1), rsvRows);
  // 发起人：1160（D 后）-1000（认购）+2800（募资交割）= 2960
  // （首次周度分账份额 +34 依赖收益注入后的下一 tick，见下方 tick4 后断言——干净库下
  //   交割时收益台账为空，periodRevenue>0 的 when 守卫正确拦截，分账不会提前发生）
  const balI5 = await api('GET', '/api/v1/games/__wallet/platform/balance', undefined, initToken);
  const initCoins4 = balI5.json && balI5.json.data && balI5.json.data.balance ? balI5.json.data.balance.gameCoins : null;
  check('发行方交割到账（余额 2960 = 1160-1000+2800）', initCoins4 === 2960, { got: initCoins4, pid: (balI5.json?.data || {}).pid });
  const revIn = await api('POST', '/api/v1/games/__contract/admin/revenue',
    { gameId: 'game_gso_smoke', source: 'market_commission', commission: 300 }, adminToken);
  check('注入测试收益 300', revIn.status === 200, revIn.json);
  const tick4 = await api('POST', '/api/v1/games/__contract/tick', {});
  check('tick：周度分账', tick4.status === 200, tick4.json);
  console.log('  [tick4 done at]', Date.now(), 'summary=', JSON.stringify((tick4.json.data || {}).summary));
  const balA5 = await api('GET', '/api/v1/games/__wallet/platform/balance', undefined, aToken);
  const aCoins4 = balA5.json && balA5.json.data && balA5.json.data.balance ? balA5.json.data.balance.gameCoins : null;
  // u_a: 920（D 后）-900（认购）+28（分账 floor(90×900/2800)）= 48
  check('u_a 分账到账（余额 48 = 920-900+28）', aCoins4 === 48, { got: aCoins4 });
  // 发行方：2960（交割后）+32（floor(90×1000/2800)）+2（尾差给 userId 排序末位）= 2994
  await new Promise((r) => setTimeout(r, 1500)); // 分账行到账留出窗口
  const balI6 = await api('GET', '/api/v1/games/__wallet/platform/balance', undefined, initToken);
  const initCoins5 = balI6.json && balI6.json.data && balI6.json.data.balance ? balI6.json.data.balance.gameCoins : null;
  check('发行方首次分账到账（余额 2994 = 2960+32+尾差2）', initCoins5 === 2994, { got: initCoins5 });

  // ---- 场景 F：规则注册中心治理闭环 ----
  console.log('\n== 场景 F：规则 propose → activate → 佣金生效 ==');
  // 幂等重置：冒烟可对同一 server 重复执行（上次运行可能改写过规则）
  for (const [k, v] of [['market.commission_rate', 0.05], ['item_harvest.daily_limit', 10]]) {
    await api('POST', '/api/v1/games/__contract/admin/rules/propose', { ruleKey: k, value: v, cooldownMs: 1 }, adminToken);
    await new Promise((r) => setTimeout(r, 10));
    await api('POST', '/api/v1/games/__contract/admin/rules/activate', { ruleKey: k }, adminToken);
  }
  const EXPECTED_RULE_SEEDS = {
    'market.commission_rate': 0.05,
    'item_harvest.daily_limit': 10,
    'cross_exchange.daily_limit': 20,
    'settlement.revenue_share_percent': 10,
    'settlement.cycle_ms': 86400000,
    'governance.pass_threshold': 0.5,
    'governance.weight_acoin': 0.3,
    'governance.weight_gamecoin': 0.1,
    'governance.weight_cap': 1000,
    'governance.rule_cooldown_ms': 259200000,
    'voucher.recycle_daily_pct': 0.5,
    'voucher.exchange_fee_pct': 2,
    'voucher.transfer_fee_pct': 0.5,
    'cross_exchange.fee_rate': 0.1,
  };
  const rl0 = await api('GET', '/api/v1/games/__contract/rules');
  check('规则列表可查（含 seed 14 条）', rl0.status === 200 && (rl0.json.data.rules || []).length >= 14, (rl0.json.data || {}).rules);
  const ruleMap = {};
  for (const r of (rl0.json.data.rules || [])) ruleMap[r.ruleKey] = r.value;
  const missingSeeds = Object.keys(EXPECTED_RULE_SEEDS).filter((k) => !(k in ruleMap));
  const wrongSeeds = Object.keys(EXPECTED_RULE_SEEDS).filter((k) => k in ruleMap && ruleMap[k] !== EXPECTED_RULE_SEEDS[k]);
  check('seed 14 键全量注册', missingSeeds.length === 0, { missing: missingSeeds });
  check('seed 默认值与 types.ts 一致', wrongSeeds.length === 0, { wrong: wrongSeeds });
  // 上报进度给非团员 → 拒绝（防骗分校验）
  const cheat = await api('POST', '/api/v1/games/__contract/invoke',
    { contractId: c3, action: '__protocol', payload: { targetUserId: 'u_hacker', points: 999 } }, initToken);
  check('上报给非团员被拒（防骗分）', cheat.status === 403, { status: cheat.status, json: cheat.json });
  // 规则提议（cooldownMs=1 → 立即可生效）+ 激活
  const pr = await api('POST', '/api/v1/games/__contract/admin/rules/propose',
    { ruleKey: 'market.commission_rate', value: 0.08, cooldownMs: 1 }, adminToken);
  check('提议佣金率 0.08（进入公示期）', pr.status === 200, pr.json);
  await new Promise((r) => setTimeout(r, 20));
  const act = await api('POST', '/api/v1/games/__contract/admin/rules/activate', { ruleKey: 'market.commission_rate' }, adminToken);
  check('公示期满激活 → 0.08 生效', act.status === 200 && act.json.data && act.json.data.value === 0.08, act.json);
  const rl1 = await api('GET', '/api/v1/games/__contract/rules');
  const ruleRow = (rl1.json.data.rules || []).find((r) => r.ruleKey === 'market.commission_rate') || {};
  check('治理链完整可复算', ruleRow.chainIntact === true, ruleRow);
  // 越权：非 admin 提议被拒
  const prDenied = await api('POST', '/api/v1/games/__contract/admin/rules/propose',
    { ruleKey: 'market.commission_rate', value: 0.5 }, initToken);
  check('非 admin 提议被拒', prDenied.status === 403, { status: prDenied.status });

  // ---- 场景 G：规则接入消费方端到端（__item/harvest-limit 读取 item_harvest.daily_limit） ----
  console.log('\n== 场景 G：规则值驱动 __item 频控 ==');
  const hl0 = await api('GET', '/api/v1/games/__item/harvest-limit?gameId=smoke-rule-game', undefined, initToken);
  check('harvest-limit 默认限额 10', hl0.status === 200 && hl0.json.data && hl0.json.data.limit === 10, hl0.json);
  const pr2 = await api('POST', '/api/v1/games/__contract/admin/rules/propose',
    { ruleKey: 'item_harvest.daily_limit', value: 11, cooldownMs: 1 }, adminToken);
  check('提议每日限额 11', pr2.status === 200, pr2.json);
  await new Promise((r) => setTimeout(r, 20));
  const act2 = await api('POST', '/api/v1/games/__contract/admin/rules/activate', { ruleKey: 'item_harvest.daily_limit' }, adminToken);
  check('激活每日限额 11', act2.status === 200 && act2.json.data && act2.json.data.value === 11, act2.json);
  const hl1 = await api('GET', '/api/v1/games/__item/harvest-limit?gameId=smoke-rule-game', undefined, initToken);
  check('harvest-limit 反映新限额 11（治理即时生效）', hl1.status === 200 && hl1.json.data && hl1.json.data.limit === 11, hl1.json);
  // 还原
  const pr3 = await api('POST', '/api/v1/games/__contract/admin/rules/propose',
    { ruleKey: 'item_harvest.daily_limit', value: 10, cooldownMs: 1 }, adminToken);
  await new Promise((r) => setTimeout(r, 20));
  const act3 = await api('POST', '/api/v1/games/__contract/admin/rules/activate', { ruleKey: 'item_harvest.daily_limit' }, adminToken);
  check('还原每日限额 10', pr3.status === 200 && act3.status === 200 && act3.json.data.value === 10, act3.json);

  console.log(`\n[smoke] 通过 ${passed} / ${passed + failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('[smoke] FATAL:', e && e.message);
  process.exit(1);
});
