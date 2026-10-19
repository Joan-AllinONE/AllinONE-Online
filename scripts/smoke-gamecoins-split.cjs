/**
 * 游戏币三方即时分账冒烟（2026-10-08 语义：gameCoins 为平台通用货币，三方分成基数含游戏币收入）
 *
 * 验证：
 *  1. 三方配置账户：gamecoins-split amount=10（60/30/10）→ 游戏方 +6 / 平台金库 +3 / 创作者 +1
 *  2. 各方 users.gameCoins 实际余额变化（dev-token 以目标身份查 __wallet/platform/balance）
 *  3. 幂等：同分钟重放 → 余额不变
 *  4. legacy 账户（无三方配置）：平台抽成 10% → 游戏 90 / 平台 10
 *  5. 无 token 冷启动（回归 2026-10-08 手动测试 401 坑）：裸发 → 401 拒绝且绝不入账；
 *     补签 token 后重试 → 正常分账（对应前端 apiFetch getCachedToken() ?? await getToken()）
 *
 * 运行：node scripts/smoke-gamecoins-split.cjs（需先 tsc -p tsconfig.server.json）
 */
const { spawn } = require('child_process');
const path = require('path');

const PORT = 5197;
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

/** 以目标 userId 身份签发 token，读其平台钱包余额 */
async function readBalance(userId) {
  const tk = await post(`${BASE}/dev-token`, { userId, role: 'player' });
  const res = await fetch(`${BASE}/__wallet/platform/balance`, {
    headers: { Authorization: `Bearer ${tk.json?.data?.token}` },
  });
  const json = await res.json();
  return Number(json?.data?.balance?.gameCoins) || 0;
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
    const tk = await post(`${BASE}/dev-token`, { userId: 'buyer-gc' });
    const token = tk.json?.data?.token;
    check('dev-token 签发', tk.status === 200 && !!token);

    // 三方配置账户
    const up = await post(`${DEV_BASE}`, baseAccount('game-gcsmoke', 'gcsmoke', 'publisher-gc', {
      revenueSharing: {
        gameShare: 0.6, platformShare: 0.3, creatorShare: 0.1,
        creatorId: 'creator-gc', creatorName: '创作者乙',
        source: 'proposal:gc-p1', effectiveAt: Date.now(),
      },
    }), token);
    check('三方配置账户 upsert', up.status === 200 && up.json?.success === true);

    const beforePub = await readBalance('publisher-gc');
    const beforePlat = await readBalance('platform_treasury');
    const beforeCre = await readBalance('creator-gc');

    // 1. 三方即时分账
    const r1 = await post(`${DEV_BASE}/game-gcsmoke/gamecoins-split`, {
      gameId: 'gcsmoke', amount: 10, buyerId: 'buyer-gc', buyerName: '买家甲', itemName: '增加生命',
    }, token);
    const split1 = r1.json?.data?.split;
    check('gamecoins-split 请求成功', r1.status === 200 && r1.json?.success === true, `status=${r1.status}`);
    check('三方份额 6/3/1（尾差归游戏方）',
      split1?.gameCut === 6 && split1?.platformCut === 3 && split1?.creatorCut === 1,
      JSON.stringify(split1 || null));

    const afterPub = await readBalance('publisher-gc');
    const afterPlat = await readBalance('platform_treasury');
    const afterCre = await readBalance('creator-gc');
    check('游戏方钱包 +6', afterPub - beforePub === 6, `${beforePub} → ${afterPub}`);
    check('平台金库钱包 +3', afterPlat - beforePlat === 3, `${beforePlat} → ${afterPlat}`);
    check('创作者钱包 +1', afterCre - beforeCre === 1, `${beforeCre} → ${afterCre}`);

    // 2. 幂等：同分钟重放 → 余额不变
    const r2 = await post(`${DEV_BASE}/game-gcsmoke/gamecoins-split`, {
      gameId: 'gcsmoke', amount: 10, buyerId: 'buyer-gc', buyerName: '买家甲', itemName: '增加生命',
    }, token);
    const afterReplay = await readBalance('publisher-gc');
    check('同分钟重放被幂等挡住', r2.status === 200 && afterReplay === afterPub, `${afterPub} → ${afterReplay}`);

    // 3. legacy 账户（无三方配置）
    await post(`${DEV_BASE}`, baseAccount('game-gclegacy', 'gclegacy', 'publisher-legacy'), token);
    const r3 = await post(`${DEV_BASE}/game-gclegacy/gamecoins-split`, {
      gameId: 'gclegacy', amount: 100, buyerId: 'buyer-gc', buyerName: '买家甲', itemName: '道具B',
    }, token);
    const split3 = r3.json?.data?.split;
    check('legacy：游戏 90 / 平台 10 / 创作者 0',
      split3?.gameCut === 90 && split3?.platformCut === 10 && split3?.creatorCut === 0,
      JSON.stringify(split3 || null));
    const legacyPub = await readBalance('publisher-legacy');
    check('legacy 游戏方钱包 +90', legacyPub === 90, `balance=${legacyPub}`);

    // 4. 缺 creatorId 的三方配置 → 拒绝
    await post(`${DEV_BASE}`, baseAccount('game-gcbad', 'gcbad', 'publisher-bad', {
      revenueSharing: { gameShare: 0.6, platformShare: 0.3, creatorShare: 0.1, source: 'bad', effectiveAt: Date.now() },
    }), token);
    const r4 = await post(`${DEV_BASE}/game-gcbad/gamecoins-split`, {
      gameId: 'gcbad', amount: 10, buyerId: 'buyer-gc', buyerName: '买家甲', itemName: '道具C',
    }, token);
    check('三方配置缺 creatorId → 400 拒绝', r4.status === 400, `status=${r4.status}`);

    // 5. 无 token 冷启动（回归 2026-10-08 手动测试 401 坑）：
    //    前端 apiFetch 缓存未命中曾裸发请求 → 服务端必须 401 拒绝且【绝不入账】；
    //    补签 token 后重试必须成功。独立账户/buyer 避免与场景 1 幂等键冲突。
    await post(`${DEV_BASE}`, baseAccount('game-gccold', 'gccold', 'publisher-cold', {
      revenueSharing: {
        gameShare: 0.6, platformShare: 0.3, creatorShare: 0.1,
        creatorId: 'creator-cold', creatorName: '创作者丙',
        source: 'proposal:cold-1', effectiveAt: Date.now(),
      },
    }), token);
    const coldBody = {
      gameId: 'gccold', amount: 20, buyerId: 'buyer-cold', buyerName: '买家丙', itemName: '冷启动道具',
    };
    const coldBeforePub = await readBalance('publisher-cold');
    const coldBeforePlat = await readBalance('platform_treasury');
    const coldBeforeCre = await readBalance('creator-cold');
    const cold = await post(`${DEV_BASE}/game-gccold/gamecoins-split`, coldBody); // 故意不带 token
    check('冷启动裸发（无 Authorization）→ 401 拒绝',
      cold.status === 401, `status=${cold.status} err=${cold.json?.error || ''}`);
    const coldUntouched =
      (await readBalance('publisher-cold')) === coldBeforePub &&
      (await readBalance('platform_treasury')) === coldBeforePlat &&
      (await readBalance('creator-cold')) === coldBeforeCre;
    check('裸发 401 未产生任何入账', coldUntouched);
    // 模拟前端 apiFetch 补签 token（getCachedToken() ?? await getToken()）后的重试路径
    const coldTk = await post(`${BASE}/dev-token`, { userId: 'buyer-cold' });
    const coldRetry = await post(`${DEV_BASE}/game-gccold/gamecoins-split`, coldBody, coldTk.json?.data?.token);
    const coldSplit = coldRetry.json?.data?.split;
    check('补签 token 后重试成功（12/6/2）',
      coldRetry.status === 200 && coldSplit?.gameCut === 12 && coldSplit?.platformCut === 6 && coldSplit?.creatorCut === 2,
      `status=${coldRetry.status} split=${JSON.stringify(coldSplit || null)}`);
    const coldSettled =
      (await readBalance('publisher-cold')) - coldBeforePub === 12 &&
      (await readBalance('platform_treasury')) - coldBeforePlat === 6 &&
      (await readBalance('creator-cold')) - coldBeforeCre === 2;
    check('冷启动账户三方入账正确', coldSettled);

  } catch (e) {
    console.error('冒烟执行异常:', e);
    results.push({ name: '执行异常', ok: false, detail: String(e) });
  } finally {
    child.kill();
  }

  const passed = results.filter(r => r.ok).length;
  console.log(`\n=== 游戏币三方分账冒烟: ${passed}/${results.length} 通过 ===`);
  process.exit(passed === results.length ? 0 : 1);
})();
