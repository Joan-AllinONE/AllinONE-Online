/**
 * 拼团履约全链路冒烟 — 2026-10-16
 *
 * 验证：
 *  1. 发起人部署后 join（按成团价付款进托管）
 *  2. 第二人 join 触发「满员即交割」（min=max=2）→ settling
 *  3. 自动发货：平台池（platform_pool）中 skuId 匹配的道具凭证逐成员转移（库存扣减）
 *  4. gbr 履约凭证已铸造
 *  5. 资金闭环：托管全额交割给发起人
 *
 * 运行：node scripts/smoke-groupbuy-fulfill.cjs（需先 tsc -p tsconfig.server.json）
 */
const { spawn } = require('child_process');
const path = require('path');

const PORT = 5199;
const BASE = `http://127.0.0.1:${PORT}/api/v1/games`;

function waitPort(port, timeoutMs) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const net = require('net');
      const s = net.connect(port, '127.0.0.1');
      s.once('connect', () => { s.destroy(); resolve(); });
      s.once('error', () => {
        s.destroy();
        if (Date.now() - start > timeoutMs) reject(new Error('server not ready'));
        else setTimeout(tryOnce, 300);
      });
    };
    tryOnce();
  });
}

async function post(url, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  let json = null;
  try { json = await res.json(); } catch { /* ignore */ }
  return { status: res.status, json };
}

async function get(url, token) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { headers });
  let json = null;
  try { json = await res.json(); } catch { /* ignore */ }
  return { status: res.status, json };
}

const poolVoucher = (id) => ({
  id,
  schemaName: 'item',
  title: '超级蘑菇（冒烟池）',
  denomination: 5,
  currentHolderId: 'platform_pool',
  currentHolderName: '平台总账户',
  status: 'active',
  createdAt: Date.now(),
  sourceType: 'item',
  metadata: {
    sourceType: 'item',
    name: '超级蘑菇',
    description: '冒烟测试道具',
    category: 'item',
    customData: { itemTemplateId: 'tpl-smoke-mushroom', schemaName: 'item', gameId: 'gbfulfill' },
  },
});

(async () => {
  const serverPath = path.join(__dirname, '..', 'server.js');
  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, USE_MEMORY_DB: 'true', PORT: String(PORT), MEMORY_DB_FILE: 'none' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => { const s = String(d || ''); if (s.includes('[contract')) console.log('[server-out]', s.trim().slice(0, 400)); });
  child.stderr.on('data', (d) => { const s = String(d || ''); if (s.includes('contract') || s.includes('Error') || s.includes('FATAL')) console.error('[server-err]', s.trim().slice(0, 400)); });

  const results = [];
  const check = (name, cond, detail) => {
    results.push({ name, ok: !!cond, detail: detail || '' });
    console.log(`${cond ? '✅' : '❌'} ${name}${detail ? '  — ' + detail : ''}`);
  };

  try {
    await waitPort(PORT, 15000);

    // dev-token 助手
    const tokenOf = async (uid) => (await post(`${BASE}/dev-token`, { userId: uid })).json?.data?.token;

    // 预置池内凭证（__item/sync 通道）×2 + 双方充值
    const seedToken = await tokenOf('seeder');
    for (const id of ['pool-smoke-1', 'pool-smoke-2']) {
      const s = await post(`${BASE}/__item/sync`, { collection: 'vouchers', doc: poolVoucher(id) }, seedToken);
      check(`预置池凭证 ${id}`, s.status === 200, `status=${s.status} err=${s.json?.error || ''}`);
    }
    for (const uid of ['test-002', 'test-003']) {
      const t = await tokenOf(uid);
      const a = await post(`${BASE}/__wallet/platform/adjust`, { delta: 100, txId: `topup-${uid}-gbf` }, t);
      check(`${uid} 充值 100`, a.status === 200, `status=${a.status} err=${a.json?.error || ''}`);
    }

    // 发起人部署（min=max=2 → 第二个 join 即满员交割）
    const initiatorToken = await tokenOf('test-002');
    const now = Date.now();
    const dep = await post(`${BASE}/__contract/deploy`, {
      templateKey: 'group-buy',
      params: {
        itemTitle: '超级蘑菇拼团',
        skuId: 'tpl-smoke-mushroom',
        initiatorId: 'test-002',
        unitPrice: 10, groupPrice: 5,
        minMembers: 2, maxMembers: 2,
        openAt: now, closeAt: now + 3600_000,
        currency: 'gameCoins', perUserLimit: 1,
        disputeWindowMs: 60_000,
      },
      userId: 'test-002',
    }, initiatorToken);
    const contractId = dep.json?.data?.contractId;
    check('拼团合约部署', dep.status === 200 && !!contractId, `status=${dep.status} err=${dep.json?.error || ''}`);

    // 发起人自己加入（新功能：扣款进托管）
    const j1 = await post(`${BASE}/__contract/invoke`, { contractId, action: 'join', payload: { userId: 'test-002' }, userId: 'test-002' }, initiatorToken);
    check('发起人加入并付款', j1.status === 200 && j1.json?.success === true, `status=${j1.status} err=${j1.json?.error || ''}`);

    // 第二人加入 → 满员即交割
    const memberToken = await tokenOf('test-003');
    const j2 = await post(`${BASE}/__contract/invoke`, { contractId, action: 'join', payload: { userId: 'test-003' }, userId: 'test-003' }, memberToken);
    check('第二人加入（满员即交割）', j2.status === 200 && j2.json?.data?.state === 'settling',
      `state=${j2.json?.data?.state} err=${j2.json?.error || ''}`);

    const det = await get(`${BASE}/__contract/detail?id=${encodeURIComponent(contractId)}`, initiatorToken);
    check('合约进入 settling', det.json?.data?.contract?.state === 'settling', `state=${det.json?.data?.contract?.state}`);

    // 发货断言：__item/verify 读 holder
    const verify = async (ids) => (await post(`${BASE}/__item/verify`, { voucherIds: ids }, seedToken)).json?.data?.results || [];
    const vr = await verify(['pool-smoke-1', 'pool-smoke-2', `gbr_${contractId}_test-002`, `gbr_${contractId}_test-003`]);
    const byId = Object.fromEntries(vr.map(r => [r.id, r]));
    check('池凭证1 → test-002（库存扣减）', byId['pool-smoke-1']?.currentHolderId === 'test-002',
      `holder=${byId['pool-smoke-1']?.currentHolderId}`);
    check('池凭证2 → test-003（库存扣减）', byId['pool-smoke-2']?.currentHolderId === 'test-003',
      `holder=${byId['pool-smoke-2']?.currentHolderId}`);
    check('gbr 履约凭证已铸造（两人份）',
      byId[`gbr_${contractId}_test-002`]?.exists === true && byId[`gbr_${contractId}_test-003`]?.exists === true);

    // 资金闭环：发起人余额 = 充值100 - 托管5 + 交割10 = 105
    const bal = await get(`${BASE}/__wallet/platform/balance`, initiatorToken);
    const coins = Number(bal.json?.data?.balance?.gameCoins) || 0;
    check('资金闭环：发起人 100-5+10=105', coins === 105, `gameCoins=${coins}`);

    // ── 场景 3：池空成团 → 待发货 → 补池 → tick 自愈补发 ──
    for (const uid of ['test-004', 'test-005']) {
      const t = await tokenOf(uid);
      await post(`${BASE}/__wallet/platform/adjust`, { delta: 100, txId: `topup-${uid}-gbf3` }, t);
    }
    const dep3 = await post(`${BASE}/__contract/deploy`, {
      templateKey: 'group-buy',
      params: {
        itemTitle: '超级蘑菇拼团3（池空）',
        skuId: 'tpl-smoke-berry',
        initiatorId: 'test-004',
        unitPrice: 10, groupPrice: 5,
        minMembers: 2, maxMembers: 2,
        openAt: now, closeAt: now + 3600_000,
        currency: 'gameCoins', perUserLimit: 1,
        disputeWindowMs: 60_000,
      },
      userId: 'test-004',
    }, await tokenOf('test-004'));
    const cid3 = dep3.json?.data?.contractId;
    check('场景3 合约部署', dep3.status === 200 && !!cid3, `err=${dep3.json?.error || ''}`);
    const t4 = await tokenOf('test-004'); const t5 = await tokenOf('test-005');
    await post(`${BASE}/__contract/invoke`, { contractId: cid3, action: 'join', payload: { userId: 'test-004' }, userId: 'test-004' }, t4);
    const j5 = await post(`${BASE}/__contract/invoke`, { contractId: cid3, action: 'join', payload: { userId: 'test-005' }, userId: 'test-005' }, t5);
    check('场景3 池空成团（settling，暂无货）', j5.json?.data?.state === 'settling', `state=${j5.json?.data?.state}`);

    // 补池：sync 两张 tpl-smoke-berry
    for (const id of ['pool-smoke-3', 'pool-smoke-4']) {
      await post(`${BASE}/__item/sync`, { collection: 'vouchers', doc: poolVoucher(id).id ? { ...poolVoucher(id), id, metadata: { ...poolVoucher(id).metadata, customData: { ...poolVoucher(id).metadata.customData, itemTemplateId: 'tpl-smoke-berry' } } } : poolVoucher(id) }, seedToken);
    }
    // tick 自愈补发
    const tick = await post(`${BASE}/__contract/tick`, {}, seedToken);
    check('tick 调用成功', tick.status === 200, `err=${tick.json?.error || ''}`);
    const vr3 = await verify(['pool-smoke-3', 'pool-smoke-4', `gbr_${cid3}_test-004`, `gbr_${cid3}_test-005`]);
    const byId3 = Object.fromEntries(vr3.map(r => [r.id, r]));
    check('补发：pool-smoke-3 → test-004', byId3['pool-smoke-3']?.currentHolderId === 'test-004', `holder=${byId3['pool-smoke-3']?.currentHolderId}`);
    check('补发：pool-smoke-4 → test-005', byId3['pool-smoke-4']?.currentHolderId === 'test-005', `holder=${byId3['pool-smoke-4']?.currentHolderId}`);
    check('补发：gbr 已铸造（两人份）',
      byId3[`gbr_${cid3}_test-004`]?.exists === true && byId3[`gbr_${cid3}_test-005`]?.exists === true);
  } catch (e) {
    console.error('冒烟执行异常:', e);
    results.push({ name: '执行异常', ok: false, detail: String(e) });
  } finally {
    child.kill();
  }

  const passed = results.filter(r => r.ok).length;
  console.log(`\n=== 拼团履约全链路冒烟: ${passed}/${results.length} 通过 ===`);
  process.exit(passed === results.length ? 0 : 1);
})();
