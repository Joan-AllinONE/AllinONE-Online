/**
 * 三方分成（GameProposal revenueSharing）冒烟测试
 *
 * 启动 USE_MEMORY_DB=true 的 server.js，验证：
 *  1. dev-token 签发
 *  2. 开发者账户 upsert（含 revenueSharing 配置）→ 读回一致
 *  3. 交易上报正确 split → 影子对照 consistent=true + revenue_ledger 记账
 *  4. 交易上报错误 split → 影子对照 consistent=false（检出篡改）
 *  5. legacy 账户（无三方配置）→ 按单极重算 consistent=true
 *  6. 分成配置变更哈希链：append ×2 → prevHash 链接
 *  7. verify 端点：链完整 intact=true
 *
 * 运行：node scripts/smoke-revenue-sharing.cjs（需先 tsc -p tsconfig.server.json 编译 server 产物）
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

function baseAccount(accountId, gameId, extra) {
  const now = Date.now();
  return Object.assign({
    accountId, gameId,
    gameName: `冒烟-${gameId}`,
    publisherId: 'dev-1', publisherName: '开发者',
    revenueSharePercent: 10,
    totalRevenue: 0, totalWithdrawn: 0, availableBalance: 0,
    platformOwed: 0, platformSettled: 0,
    lastDailySettlement: now,
    creatorOwed: 0, creatorSettled: 0,
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

    // 1. dev-token
    const tk = await post(`${BASE}/dev-token`, { userId: 'smoke-user-1' });
    const token = tk.json?.data?.token;
    check('dev-token 签发', tk.status === 200 && !!token);

    // 2. 三方分成账户 upsert
    const now = Date.now();
    const acc = baseAccount('game-smoke-rs', 'smoke-rs', {
      revenueSharing: {
        gameShare: 0.6, platformShare: 0.3, creatorShare: 0.1,
        creatorId: 'creator-1', creatorName: '创作者甲',
        source: 'proposal:smoke-p1', effectiveAt: now,
      },
    });
    const up = await post(`${DEV_BASE}`, acc, token);
    check('三方分成账户 upsert', up.status === 200 && up.json?.success === true, `status=${up.status}`);

    const got = await get(`${DEV_BASE}/game-smoke-rs`, token);
    check('账户读回 revenueSharing 一致', got.json?.data?.revenueSharing?.gameShare === 0.6 &&
      got.json?.data?.revenueSharing?.creatorId === 'creator-1' &&
      got.json?.data?.revenueSharing?.source === 'proposal:smoke-p1',
      `got=${JSON.stringify(got.json?.data?.revenueSharing || null).slice(0, 120)}`);

    // 3. 正确 split 交易 → 影子对照一致 + 台账记账
    const txOk = {
      id: 'smoketx_ok1', gameId: 'smoke-rs', accountId: 'game-smoke-rs',
      type: 'purchase', amount: 100, currency: 'aCoins',
      description: '冒烟：正确三方分账',
      metadata: { split: { gameCut: 60, platformCut: 30, creatorCut: 10, mode: 'three-way' } },
      timestamp: Date.now(),
    };
    const t1 = await post(`${DEV_BASE}/game-smoke-rs/transaction`, txOk, token);
    check('正确 split 交易上报', t1.status === 200 && t1.json?.success === true, `status=${t1.status}`);

    const led1 = await get(`${DEV_BASE}/game-smoke-rs/split-ledger`, token);
    const e1 = (led1.json?.data || []).find(e => e.entryId === 'devsplit_smoketx_ok1');
    check('影子对照台账已记账（幂等 entryId）', !!e1, `entries=${(led1.json?.data || []).length}`);
    check('正确 split → consistent=true', e1?.consistent === true, JSON.stringify(e1?.split || null));
    check('台账 commission = 平台份额 30', Number(e1?.commission) === 30, `commission=${e1?.commission}`);

    // 4. 错误 split 交易 → 影子对照检出（consistent=false）
    const txBad = {
      id: 'smoketx_bad1', gameId: 'smoke-rs', accountId: 'game-smoke-rs',
      type: 'purchase', amount: 100, currency: 'aCoins',
      description: '冒烟：篡改三方分账',
      metadata: { split: { gameCut: 90, platformCut: 10, creatorCut: 0, mode: 'three-way' } },
      timestamp: Date.now(),
    };
    await post(`${DEV_BASE}/game-smoke-rs/transaction`, txBad, token);
    const led2 = await get(`${DEV_BASE}/game-smoke-rs/split-ledger`, token);
    const e2 = (led2.json?.data || []).find(e => e.entryId === 'devsplit_smoketx_bad1');
    check('篡改 split → consistent=false（影子检出）', e2?.consistent === false,
      `split=${JSON.stringify(e2?.split || null)} reported=${JSON.stringify(e2?.reportedSplit || null)}`);

    // 5. legacy 账户（无 revenueSharing）→ 单极重算
    const legacyAcc = baseAccount('game-smoke-legacy', 'smoke-legacy');
    await post(`${DEV_BASE}`, legacyAcc, token);
    const txLegacy = {
      id: 'smoketx_leg1', gameId: 'smoke-legacy', accountId: 'game-smoke-legacy',
      type: 'purchase', amount: 105, currency: 'aCoins',
      description: '冒烟：legacy 单极分账',
      metadata: { split: { gameCut: 95, platformCut: 10, creatorCut: 0, mode: 'legacy' } },
      timestamp: Date.now(),
    };
    await post(`${DEV_BASE}/game-smoke-legacy/transaction`, txLegacy, token);
    const led3 = await get(`${DEV_BASE}/game-smoke-legacy/split-ledger`, token);
    const e3 = (led3.json?.data || []).find(e => e.entryId === 'devsplit_smoketx_leg1');
    check('legacy 单极：平台 floor(105×10%)=10 → consistent=true',
      e3?.consistent === true && Number(e3?.split?.platformCut) === 10,
      `split=${JSON.stringify(e3?.split || null)}`);

    // 6. 分成配置变更哈希链
    const h1 = await post(`${DEV_BASE}/game-smoke-rs/revenue-sharing-history`, {
      gameId: 'smoke-rs', config: { gameShare: 0.6, platformShare: 0.3, creatorShare: 0.1 },
      source: 'proposal:smoke-p1', proposalId: 'smoke-p1',
    }, token);
    check('哈希链 append #1', h1.status === 200 && !!h1.json?.data?.hash, `status=${h1.status}`);

    const h2 = await post(`${DEV_BASE}/game-smoke-rs/revenue-sharing-history`, {
      gameId: 'smoke-rs', config: { gameShare: 0.5, platformShare: 0.4, creatorShare: 0.1 },
      source: 'proposal:smoke-p2', proposalId: 'smoke-p2',
    }, token);
    check('哈希链 append #2', h2.status === 200 && h2.json?.data?.prevHash === h1.json?.data?.hash,
      `prevHash===hash#1: ${h2.json?.data?.prevHash === h1.json?.data?.hash}`);

    const hist = await get(`${DEV_BASE}/game-smoke-rs/revenue-sharing-history`, token);
    check('历史读取 length=2', (hist.json?.data || []).length === 2, `len=${(hist.json?.data || []).length}`);

    // 7. verify 端点
    const vf = await get(`${DEV_BASE}/game-smoke-rs/revenue-sharing-verify`, token);
    check('哈希链 verify intact=true', vf.json?.data?.intact === true && vf.json?.data?.length === 2,
      JSON.stringify(vf.json?.data || null));

  } catch (e) {
    console.error('冒烟执行异常:', e);
    results.push({ name: '执行异常', ok: false, detail: String(e) });
  } finally {
    child.kill();
  }

  const passed = results.filter(r => r.ok).length;
  console.log(`\n=== 三方分成冒烟: ${passed}/${results.length} 通过 ===`);
  process.exit(passed === results.length ? 0 : 1);
})();
