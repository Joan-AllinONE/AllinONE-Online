/**
 * __item / __market 隧道冒烟测试（临时脚本，验证后删除）
 *
 * 启动 USE_MEMORY_DB=true 的 server.js，依次验证：
 *  1. dev-token 签发
 *  2. __item/mint 正常铸造（含签名）
 *  3. __item/mint 幂等（重复 harvestId → 409）
 *  4. __item/mint 限额（第 11 次 → 429）
 *  5. __item/mint 非法效果 → 400
 *  6. __item/sync 同步凭证 → OK；新建 item 凭证无 schemaName → 400
 *  7. __item/verify 校验
 *  8. __item/update：非持有者改 status → 403
 *  9. __market/list：云端无凭证 → 400；有凭证 → OK
 * 10. __market/buy → sold + purchases；再次 buy → 409
 * 11. 无 token mint → 401
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

    // 11. 无 token mint → 401
    const noAuth = await post(`${BASE}/__item/mint`, { gameId: 'g1', schemaName: 'match3-powerup', itemData: { name: 'x', effect: 'shuffle' } });
    check('无 token mint → 401', noAuth.status === 401, `status=${noAuth.status}`);

    // 2. mint 正常
    const mk = await post(`${BASE}/__item/mint`, {
      gameId: 'smoke-game', schemaName: 'match3-powerup',
      itemData: { name: '测试炸弹', effect: 'remove_area', params: { radius: 1 }, description: '冒烟' },
      harvestId: 'h-001', userName: '冒烟用户',
    }, token);
    const voucher = mk.json?.data?.voucher;
    check('mint 铸造成功', mk.status === 200 && !!voucher, `voucherId=${voucher?.id} remaining=${mk.json?.data?.remaining}`);
    check('mint 凭证带服务端签名', voucher?.integrity?.mintedBy === 'server' && !!voucher?.integrity?.sig);
    check('mint 凭证 sourceType=item', voucher?.sourceType === 'item' || voucher?.metadata?.sourceType === 'item');

    // 3. 幂等
    const dup = await post(`${BASE}/__item/mint`, {
      gameId: 'smoke-game', schemaName: 'match3-powerup',
      itemData: { name: '测试炸弹', effect: 'remove_area', params: { radius: 1 } },
      harvestId: 'h-001',
    }, token);
    check('重复 harvestId → 409 duplicate', dup.status === 409 && dup.json?.code === 'duplicate', `status=${dup.status}`);

    // 5. 非法效果
    const bad = await post(`${BASE}/__item/mint`, {
      gameId: 'smoke-game', schemaName: 'match3-powerup',
      itemData: { name: '超神器', effect: 'destroy_universe', params: {} },
      harvestId: 'h-bad',
    }, token);
    check('非法效果 → 400', bad.status === 400, `status=${bad.status} err=${bad.json?.error?.slice(0, 40)}`);

    // 参数越界
    const oob = await post(`${BASE}/__item/mint`, {
      gameId: 'smoke-game', schemaName: 'match3-powerup',
      itemData: { name: '时间膨胀', effect: 'add_time', params: { seconds: 999 } },
      harvestId: 'h-oob',
    }, token);
    check('参数越界 → 400', oob.status === 400, `status=${oob.status}`);

    // 4. 限额：已用 1 次（h-001 成功）+ h-bad/h-oob 被拒不计数（拒绝发生在 mark seen/bump 之前？顺序：seen→bump→铸造，
    // 非法效果在 seen 之前 → 不计数；h-001 计数 1。再打 9 次到上限，第 11 次 429
    let last;
    for (let i = 2; i <= 11; i++) {
      last = await post(`${BASE}/__item/mint`, {
        gameId: 'smoke-game', schemaName: 'match3-powerup',
        itemData: { name: '批量' + i, effect: 'shuffle', params: {} },
        harvestId: 'h-' + i,
      }, token);
    }
    check('每日限额第 11 次 → 429', last.status === 429 && last.json?.code === 'daily_limit', `status=${last.status}`);

    // 6. sync
    const syncDoc = { id: 'vh_smoke_sync_1', denomination: 5, status: 'active', currentHolderId: 'smoke-user-1', metadata: { name: '同步凭证' } };
    const s1 = await post(`${BASE}/__item/sync`, { collection: 'vouchers', doc: syncDoc }, token);
    check('sync 普通凭证 → OK', s1.status === 200 && s1.json?.success === true, `status=${s1.status}`);

    const badItem = { id: 'vh_smoke_sync_2', sourceType: 'item', metadata: { sourceType: 'item', customData: { gameId: 'smoke-game' } } };
    const s2 = await post(`${BASE}/__item/sync`, { collection: 'vouchers', doc: badItem }, token);
    check('sync 新建 item 凭证缺 schemaName → 400', s2.status === 400, `status=${s2.status}`);

    // 7. verify
    const vf = await post(`${BASE}/__item/verify`, { voucherIds: [voucher.id, 'vh_not_exist'] }, token);
    const r0 = vf.json?.data?.results?.[0];
    const r1 = vf.json?.data?.results?.[1];
    check('verify 已有凭证 exists=true', r0?.exists === true && r0?.mintedBy === 'server');
    check('verify 不存在凭证 exists=false', r1?.exists === false);

    // 8. update 非持有者
    const tk2 = await post(`${BASE}/dev-token`, { userId: 'attacker-1' });
    const t2 = tk2.json?.data?.token;
    const upd = await post(`${BASE}/__item/update`, { voucherId: voucher.id, patch: { status: 'redeemed' } }, t2);
    check('非持有者 update → 403', upd.status === 403, `status=${upd.status}`);

    // 管理员洗白 reviewStatus：玩家 token → 403
    const mint2 = await post(`${BASE}/__item/mint`, {
      gameId: 'game2', schemaName: 'match3-powerup',
      itemData: { name: '高价值', effect: 'shuffle', params: {}, effectCode: 'function(){}' },
      harvestId: 'g2-h1',
    }, t2);
    const hv = mint2.json?.data?.voucher;
    check('高价值道具 pendingReview', mint2.status === 200 && hv?.metadata?.customData?.reviewStatus === 'pending');
    const whitewash = await post(`${BASE}/__item/update`, { voucherId: hv.id, patch: { reviewStatus: 'approved' } }, t2);
    check('玩家洗白 reviewStatus → 403', whitewash.status === 403, `status=${whitewash.status}`);

    // 9. market/list
    const badList = await post(`${BASE}/__market/list`, {
      listing: { id: 'lst_1', voucherId: 'vh_fake_999', sellerId: 'smoke-user-1', price: 10, currency: 'gameCoins', itemName: '假货' },
    }, token);
    check('挂伪造凭证 → 400 voucher_missing', badList.status === 400 && badList.json?.code === 'voucher_missing', `status=${badList.status}`);

    // 用 smoke-user-1 自己的凭证上架（第一个 mint 的凭证持有人是 smoke-user-1）
    const okList = await post(`${BASE}/__market/list`, {
      listing: { id: 'lst_2', voucherId: voucher.id, sellerId: 'smoke-user-1', price: 10, currency: 'gameCoins', itemName: '测试炸弹' },
    }, token);
    check('持有者上架 → OK', okList.status === 200, `status=${okList.status} err=${okList.json?.error || ''}`);

    // 冒名上架（attacker 挂别人的凭证）
    const stolenList = await post(`${BASE}/__market/list`, {
      listing: { id: 'lst_3', voucherId: voucher.id, sellerId: 'attacker-1', price: 5, currency: 'gameCoins', itemName: '偷来的' },
    }, t2);
    check('非持有者上架 → 403', stolenList.status === 403, `status=${stolenList.status}`);

    // 10. buy
    const tk3 = await post(`${BASE}/dev-token`, { userId: 'buyer-1' });
    const t3 = tk3.json?.data?.token;
    const buy = await post(`${BASE}/__market/buy`, { listingId: 'lst_2', buyerId: 'buyer-1', buyerName: '买家' }, t3);
    check('购买 → sold', buy.status === 200, `status=${buy.status}`);
    const buy2 = await post(`${BASE}/__market/buy`, { listingId: 'lst_2', buyerId: 'buyer-1', buyerName: '买家' }, t3);
    check('重复购买 → 409 not_active', buy2.status === 409 && buy2.json?.code === 'not_active', `status=${buy2.status}`);
    const vfBuy = await post(`${BASE}/__item/verify`, { voucherIds: [voucher.id] }, t3);
    check('购买后凭证 holder 核对（云端 holder 仍是卖家，核销由业务层转移）', vfBuy.json?.data?.results?.[0]?.exists === true);

    // unlist
    const tk4 = await post(`${BASE}/dev-token`, { userId: 'seller-x' });
    const t4 = tk4.json?.data?.token;
    const mkSeller = await post(`${BASE}/__item/mint`, {
      gameId: 'game-x', schemaName: 'gushi-powerup',
      itemData: { name: '玉币包', effect: 'add_coins', params: { bonus: 5000 } },
      harvestId: 'gx-1',
    }, t4);
    const gv = mkSeller.json?.data?.voucher;
    check('gushi-powerup mint', mkSeller.status === 200, `status=${mkSeller.status} err=${mkSeller.json?.error || ''}`);
    await post(`${BASE}/__market/list`, { listing: { id: 'lst_x', voucherId: gv.id, sellerId: 'seller-x', price: 8, currency: 'gameCoins', itemName: '玉币包' } }, t4);
    const stolenUnlist = await post(`${BASE}/__market/unlist`, { listingId: 'lst_x', userId: 'buyer-1' }, t3);
    check('非卖家下架 → 403', stolenUnlist.status === 403, `status=${stolenUnlist.status}`);
    const okUnlist = await post(`${BASE}/__market/unlist`, { listingId: 'lst_x', userId: 'seller-x' }, t4);
    check('卖家下架 → OK', okUnlist.status === 200, `status=${okUnlist.status}`);

    // harvest-limit
    const hl = await get(`${BASE}/__item/harvest-limit?gameId=game-x`, t4);
    check('harvest-limit 查询', hl.status === 200 && hl.json?.data?.remaining === 9, `remaining=${hl.json?.data?.remaining}`);

    // __item/purchase（purchases 收据式写入）
    const pur = await post(`${BASE}/__item/purchase`, { doc: { id: 'smoke-pur-1', itemName: '玉币包', price: 8, buyerId: 'seller-x', status: 'purchased' } }, t4);
    check('purchase 收据写入', pur.status === 200, `status=${pur.status}`);
    const purBad = await post(`${BASE}/__item/purchase`, { doc: { no_id: true } }, t4);
    check('purchase 缺 id → 400', purBad.status === 400, `status=${purBad.status}`);

  } catch (e) {
    console.error('冒烟测试异常:', e);
    results.push({ name: 'EXCEPTION', ok: false, detail: String(e) });
  } finally {
    child.kill();
  }

  const failed = results.filter(r => !r.ok);
  console.log(`\n===== 结果: ${results.length - failed.length}/${results.length} 通过 =====`);
  process.exit(failed.length ? 1 : 0);
})();
