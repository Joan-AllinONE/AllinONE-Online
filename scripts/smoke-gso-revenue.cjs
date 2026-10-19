/**
 * GSO 可观测收益记账点（store_sale / content_consume）冒烟 — 2026-10-15
 *
 * 验证：
 *  1. content_consume 记账：三方 6/3/1 → commission=3（GSO tick sumRevenue 口径）
 *  2. 幂等：同 idempotencyKey 重放 → duplicate:true 且不产生新台账条目
 *  3. store_sale 记账 + 无 idempotencyKey 服务端分钟窗兜底
 *  4. 非法 source → 400
 *  5. split-ledger 审计端点可见 srvr_ 条目
 *
 * 运行：node scripts/smoke-gso-revenue.cjs（需先 tsc -p tsconfig.server.json）
 */
const { spawn } = require('child_process');
const path = require('path');

const PORT = 5198;
const BASE = `http://127.0.0.1:${PORT}/api/v1/games`;
const DEV_BASE = `http://127.0.0.1:${PORT}/api/v1/game-developers`;

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

function baseAccount(accountId, gameId, publisherId, extra) {
  const now = Date.now();
  return Object.assign({
    accountId, gameId,
    gameName: `冒烟-${gameId}`,
    publisherId, publisherName: `发布者-${publisherId}`,
    revenueSharePercent: 10,
    totalRevenue: 0, totalWithdrawn: 0, availableBalance: 0,
    platformOwed: 0, platformSettled: 0,
    lastDailySettlement: now,
    creatorOwed: 0, creatorSettled: 0, gameCoinsRevenue: 0,
    stats: { totalSoldItems: 0, totalSoldVouchers: 0, itemSales: {} },
    status: 'active', createdAt: now, updatedAt: now,
  }, extra || {});
}

(async () => {
  const serverPath = path.join(__dirname, '..', 'server.js');
  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, USE_MEMORY_DB: 'true', PORT: String(PORT), MEMORY_DB_FILE: 'none' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (d) => { const s = String(d || ''); if (s.includes('Error') || s.includes('FATAL')) console.error('[server]', s.slice(0, 300)); });

  const results = [];
  const check = (name, cond, detail) => {
    results.push({ name, ok: !!cond, detail: detail || '' });
    console.log(`${cond ? '✅' : '❌'} ${name}${detail ? '  — ' + detail : ''}`);
  };

  try {
    await waitPort(PORT, 15000);
    const tk = await post(`${BASE}/dev-token`, { userId: 'buyer-gso' });
    const token = tk.json?.data?.token;
    check('dev-token 签发', tk.status === 200 && !!token);

    // 三方 6/3/1 账户
    await post(`${DEV_BASE}`, baseAccount('game-gsorev', 'gsorev', 'publisher-gso', {
      revenueSharing: {
        gameShare: 0.6, platformShare: 0.3, creatorShare: 0.1,
        creatorId: 'creator-gso', creatorName: '创作者戊',
        source: 'manual', effectiveAt: Date.now(),
      },
    }), token);

    // 1. content_consume 记账
    const r1 = await post(`${DEV_BASE}/game-gsorev/gso-revenue`, {
      source: 'content_consume', gameId: 'gsorev', amount: 10,
      buyerId: 'buyer-gso', buyerName: '买家戊', itemName: '矿区内容包',
      idempotencyKey: 'cc_v1',
    }, token);
    const split1 = r1.json?.data?.split;
    check('content_consume 记账成功', r1.status === 200 && r1.json?.success === true, `status=${r1.status}`);
    check('三方份额 6/3/1', split1?.gameCut === 6 && split1?.platformCut === 3 && split1?.creatorCut === 1,
      JSON.stringify(split1 || null));
    check('commission=3（GSO tick 求和口径）', r1.json?.data?.split?.platformCut === 3);

    // 2. 幂等重放
    const r2 = await post(`${DEV_BASE}/game-gsorev/gso-revenue`, {
      source: 'content_consume', gameId: 'gsorev', amount: 10,
      buyerId: 'buyer-gso', idempotencyKey: 'cc_v1',
    }, token);
    check('同 idempotencyKey 重放 → duplicate:true',
      r2.status === 200 && r2.json?.data?.duplicate === true, JSON.stringify(r2.json?.data || null));

    // 3. store_sale 无 idem（服务端分钟窗兜底）
    const r3 = await post(`${DEV_BASE}/game-gsorev/gso-revenue`, {
      source: 'store_sale', gameId: 'gsorev', amount: 50,
      buyerId: 'buyer-gso', buyerName: '买家戊', itemName: '商店商品',
    }, token);
    check('store_sale 记账成功（分钟窗兜底幂等键）',
      r3.status === 200 && r3.json?.data?.duplicate === false && r3.json?.data?.entryId?.startsWith('srvr_store_sale_'),
      JSON.stringify(r3.json?.data || null));

    // 4. 非法 source
    const r4 = await post(`${DEV_BASE}/game-gsorev/gso-revenue`, {
      source: 'bogus', gameId: 'gsorev', amount: 1, buyerId: 'buyer-gso',
    }, token);
    check('非法 source → 400 拒绝', r4.status === 400, `status=${r4.status}`);

    // 5. split-ledger 审计可见
    const led = await get(`${DEV_BASE}/game-gsorev/split-ledger`, token);
    const rows = Array.isArray(led.json?.data) ? led.json.data : [];
    const srvrRows = rows.filter(r => String(r.entryId || '').startsWith('srvr_'));
    check('split-ledger 可见 2 条 srvr_ 记账（幂等不重复）', srvrRows.length === 2,
      `srvr=${srvrRows.length}, total=${rows.length}`);
  } catch (e) {
    console.error('冒烟执行异常:', e);
    results.push({ name: '执行异常', ok: false, detail: String(e) });
  } finally {
    child.kill();
  }

  const passed = results.filter(r => r.ok).length;
  console.log(`\n=== GSO 收益记账冒烟: ${passed}/${results.length} 通过 ===`);
  process.exit(passed === results.length ? 0 : 1);
})();
