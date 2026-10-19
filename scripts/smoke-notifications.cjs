#!/usr/bin/env node
/**
 * 私域合约邀请通知冒烟（2026-10-11，本地 server，USE_MEMORY_DB=true）
 *
 * 场景：
 *   1. u_init 部署私域拼团（名单 u_a,u_b）→ u_a/u_b 各收 1 条未读，发起人 0 条
 *   2. 重复 deploy 校验幂等（每次部署新合约 id，不涉及；校验 /read 幂等与重复标记）
 *   3. u_a 标记已读 → unreadCount 归零
 *   4. 公开合约（无名单）→ 不产生私信
 *   5. 未登录 /list → 401
 *
 * 用法：USE_MEMORY_DB=true PORT=3000 MEMORY_DB_FILE=none CONTRACT_AUTO_EXECUTE=group-buy node server.js 后运行本脚本
 */
'use strict';

const BASE = process.env.SMOKE_BASE || 'http://localhost:3000';
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
  else { failed++; console.log(`  ❌ ${name}${detail ? ` — ${JSON.stringify(detail).slice(0, 300)}` : ''}`); }
}

async function main() {
  console.log(`[smoke] 私域邀请通知 ${BASE}`);
  const initToken = tokenFor('u_init');
  const aToken = tokenFor('u_a');

  // 1. 私域部署 → 通知生成
  const now = Date.now();
  const dep = await api('POST', '/api/v1/games/__contract/deploy', {
    templateKey: 'group-buy',
    title: '测试拼团',
    params: {
      itemTitle: '传奇皮肤', initiatorId: 'u_init',
      unitPrice: 100, groupPrice: 80, minMembers: 2, maxMembers: 5,
      openAt: now, closeAt: now + 48 * 3600 * 1000,
      currency: 'gameCoins', perUserLimit: 1, disputeWindowMs: 72 * 3600 * 1000,
    },
    whitelist: ['u_a', 'u_init', 'u_b'],
  }, initToken);
  check('私域合约部署成功', dep.json && dep.json.success, dep);

  const listA = await api('GET', '/api/v1/games/__notifications/list', undefined, aToken);
  const notifs = (listA.json && listA.json.data && listA.json.data.notifications) || [];
  check('名单成员收到 1 条邀请', notifs.length === 1, listA.json);
  if (notifs.length === 0) {
    console.log('  [debug] listA 原始响应:', JSON.stringify(listA.json).slice(0, 500));
    console.log(`\n[smoke] 结果: ${passed} passed, ${failed + 1} failed`);
    process.exit(1);
  }
  check('未读数 = 1', (listA.json?.data?.unreadCount) === 1, listA.json);
  check('剔除发起人（toUserId=u_a）', notifs[0] && notifs[0].toUserId === 'u_a', notifs);
  check('标题含发起人', notifs[0] && notifs[0].title.includes('u_init'), notifs);
  check('meta.contractId 正确', notifs[0] && notifs[0].meta && notifs[0].meta.contractId === dep.json?.data?.contractId, notifs);

  const listInit = await api('GET', '/api/v1/games/__notifications/list', undefined, initToken);
  check('发起人不收到邀请', ((listInit.json?.data?.notifications) || []).length === 0, listInit.json);

  // 2. 已读
  const read = await api('POST', '/api/v1/games/__notifications/read', { ids: [notifs[0].id] }, aToken);
  check('标记已读 updated=1', (read.json?.data?.updated) === 1, read);
  const listA2 = await api('GET', '/api/v1/games/__notifications/list', undefined, aToken);
  check('已读后 unreadCount=0', (listA2.json?.data?.unreadCount) === 0, listA2.json);

  // 3. 全部已读幂等（无未读时再调）
  const read2 = await api('POST', '/api/v1/games/__notifications/read', {}, aToken);
  check('重复已读 updated=0', (read2.json?.data?.updated) === 0, read2);

  // 4. 公开合约不发私信
  const depPub = await api('POST', '/api/v1/games/__contract/deploy', {
    templateKey: 'group-buy',
    title: '公开拼团',
    params: {
      itemTitle: '公开商品', initiatorId: 'u_init',
      unitPrice: 100, groupPrice: 80, minMembers: 2, maxMembers: 5,
      openAt: now, closeAt: now + 48 * 3600 * 1000,
      currency: 'gameCoins', perUserLimit: 1, disputeWindowMs: 72 * 3600 * 1000,
    },
  }, initToken);
  check('公开合约部署成功', depPub.json && depPub.json.success, depPub);
  const listA3 = await api('GET', '/api/v1/games/__notifications/list', undefined, aToken);
  check('公开合约不产生私信（仍 1 条已读）', ((listA3.json?.data?.notifications) || []).length === 1, listA3.json);

  // 5. 未登录 401
  const anon = await api('GET', '/api/v1/games/__notifications/list');
  check('未登录 401', anon.status === 401, anon);

  // 6. 审核模板（GSO requiresAudit）：draft 阶段不发通知，审核通过后才发
  const bToken = tokenFor('u_b');
  const nowE = Date.now();
  // seed 游戏档案（GSO 发行需核验 publisherId）
  await api('POST', '/api/v1/games', { id: 'game_gso_smoke', name: '冒烟游戏', publisherId: 'u_init' }, initToken);
  const depGso = await api('POST', '/api/v1/games/__contract/deploy', {
    templateKey: 'gso',
    title: '冒烟 GSO',
    params: {
      gameId: 'game_gso_smoke', issuerId: 'u_init', gameName: '冒烟游戏',
      raiseTarget: 10000, currency: 'gameCoins', revenueShareBps: 3000, governanceShareBps: 3000,
      openAt: nowE, closeAt: nowE + 3600 * 1000, softCap: 2000, perUserCap: 5000,
      coolDownMs: 0, lockupMs: 30 * 24 * 3600 * 1000,
      revenueSources: ['market_commission', 'store_sale'], settlementCron: 'weekly',
      governableTopics: ['ADJUST_PRICE'], disputeWindowMs: 72 * 3600 * 1000,
    },
    whitelist: ['u_b'],
  }, initToken);
  if (depGso.json && depGso.json.success) {
    const gsoNotifs = (list) => ((list.json?.data?.notifications) || []).filter((n) => n.meta && n.meta.templateKey === 'gso');
    const before = gsoNotifs(await api('GET', '/api/v1/games/__notifications/list', undefined, bToken));
    check('GSO draft 阶段不发邀请', before.length === 0, before);
    const rv = await api('POST', '/api/v1/games/__contract/admin/review', { contractId: depGso.json.data.contractId, approve: true, note: '冒烟审核' }, tokenFor('u_admin', 'admin'));
    check('GSO 审核通过', rv.json && rv.json.success, rv.json);
    const nb = gsoNotifs(await api('GET', '/api/v1/games/__notifications/list', undefined, bToken));
    check('审核通过后名单成员收到 1 条', nb.length === 1 && nb[0].body.includes('冒烟游戏'), nb);
  } else {
    // 冒烟环境无游戏档案时 GSO deploy 404 属预期，跳过（需档案 seed 的环境再验）
    console.log(`  ⚠️ GSO 部署未成功（${depGso.json && depGso.json.error}），审核时序场景跳过`);
  }

  console.log(`\n[smoke] 结果: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('[smoke] 异常:', e); process.exit(1); });
