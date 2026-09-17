/**
 * 云函数审核隧道本地模拟测试（mock @cloudbase/node-sdk 内存 DB）
 * 覆盖：admin-login 鉴权、submit/decide/takedown 状态机、列表/详情审核过滤、
 *       发布 upsert 的审核字段剥离与新建默认 pending、upsertMerge 合并语义。
 */
const Module = require('module');

// ---------- 内存 DB mock ----------
const collections = {}; // name -> { idKey: doc }

function getCol(name) {
  if (!collections[name]) collections[name] = {};
  return collections[name];
}

const command = { exists: () => ({ __exists: true }) };

function makeQuery(name, filter) {
  const col = getCol(name);
  const matchAll = !filter || Object.keys(filter).length === 0;
  const matching = () => Object.values(col).filter((d) => {
    if (matchAll) return true;
    if (filter._id && filter._id.__exists) return true;
    return Object.entries(filter).every(([k, v]) => d[k] === v);
  });
  return {
    where: (f) => makeQuery(name, f),
    limit: () => makeQuery(name, filter),
    field: () => makeQuery(name, filter),
    skip: () => makeQuery(name, filter),
    get: async () => ({ data: JSON.parse(JSON.stringify(matching())) }),
    update: async (patch) => {
      let updated = 0;
      for (const d of matching()) {
        Object.assign(d, JSON.parse(JSON.stringify(patch)));
        updated++;
      }
      return { updated };
    },
    remove: async () => {
      let removed = 0;
      for (const d of matching()) { delete col[d._id]; removed++; }
      return { deleted: removed, removed };
    },
  };
}

const mockDb = {
  command,
  createCollection: async (name) => { getCol(name); return {}; },
  collection: (name) => ({
    where: (f) => makeQuery(name, f),
    field: () => makeQuery(name, undefined), // 列表剔除大字段（mock 忽略投影）
    limit: () => makeQuery(name, undefined),
    doc: (id) => ({
      get: async () => {
        const d = getCol(name)[id];
        return d ? { data: [JSON.parse(JSON.stringify(d))] } : { data: [] };
      },
      set: async (doc) => { getCol(name)[id] = JSON.parse(JSON.stringify(doc)); return {}; },
      remove: async () => { const had = !!getCol(name)[id]; delete getCol(name)[id]; return { deleted: had ? 1 : 0, removed: had ? 1 : 0 }; },
    }),
    add: async (doc) => { getCol(name)[doc._id || Date.now()] = JSON.parse(JSON.stringify(doc)); return {}; },
  }),
};

// 拦截 @cloudbase/node-sdk
const origLoad = Module._load;
Module._load = function (request) {
  if (request === '@cloudbase/node-sdk') {
    return { SYMBOL_CURRENT_ENV: 'mock', init: () => ({ database: () => mockDb }) };
  }
  return origLoad.apply(this, arguments);
};

const fn = require('d:/AllinONE Gaming Platform/cloudfunctions/gamesApi/index.js');

function makeEvent(method, path, body, token, query) {
  return {
    httpMethod: method,
    path: path + (query || ''),
    headers: token ? { authorization: 'Bearer ' + token } : {},
    body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : '',
    isBase64Encoded: false,
    queryStringParameters: query ? Object.fromEntries(new URLSearchParams(query)) : {},
  };
}

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name); }
}

(async () => {
  // ---- ① admin-login 鉴权 ----
  const bad = await fn.main(makeEvent('POST', '/api/v1/games/__review/admin-login', { username: 'admin', password: 'wrong' }));
  check('A1 错误密码 401', bad.statusCode === 401);

  const ok = await fn.main(makeEvent('POST', '/api/v1/games/__review/admin-login', { username: 'admin', password: 'admin123' }));
  const okBody = JSON.parse(ok.body);
  const adminToken = okBody.data && okBody.data.token;
  check('A2 正确登录签发 JWT', ok.statusCode === 200 && adminToken && adminToken.split('.').length === 3);
  const claims = JSON.parse(Buffer.from(adminToken.split('.')[1], 'base64url').toString('utf8'));
  check('A3 token role=admin', claims.role === 'admin' && claims.userId === 'review-admin:admin');

  const dev = await fn.main(makeEvent('POST', '/api/v1/games/dev-token', { userId: 'dev-tester' }));
  const playerToken = JSON.parse(dev.body).data.token;
  check('A4 player token role=player', JSON.parse(Buffer.from(playerToken.split('.')[1], 'base64url').toString('utf8')).role === 'player');

  const noAuth = await fn.main(makeEvent('GET', '/api/v1/games/__review/list'));
  check('A5 list 无 token 401', noAuth.statusCode === 401);
  const playerList = await fn.main(makeEvent('GET', '/api/v1/games/__review/list', null, playerToken));
  check('A6 list player token 403', playerList.statusCode === 403);

  // ---- ② 发布：新建默认 pending + 审核字段剥离 ----
  const g = { id: 'e2e-fn', name: '云函数测试游戏', description: 'd', framework: 'phaser', entryPoint: 'index.html', hostingType: 'server', publisherId: 'dev-tester', publisherName: '测试发布者', coverImage: 'data:image/png;base64,x', createdAt: new Date().toISOString() };
  const save1 = await fn.main(makeEvent('POST', '/api/v1/games', g, playerToken));
  check('B1 发布成功', save1.statusCode === 200);
  check('B2 新建默认 pending', getCol('published_games')['e2e-fn'].reviewStatus === 'pending');

  const save2 = await fn.main(makeEvent('POST', '/api/v1/games', Object.assign({}, g, { reviewStatus: 'approved', reviewRecords: [{ fake: 1 }] }), playerToken));
  check('B3 发布携带非法审核状态被剥离', save2.statusCode === 200 && getCol('published_games')['e2e-fn'].reviewStatus === 'pending');

  // ---- ③ 公开列表/详情拦截 ----
  const pubList = await fn.main(makeEvent('GET', '/api/v1/games'));
  const pubGames = JSON.parse(pubList.body).data.games;
  check('C1 pending 游戏不在公开列表', !pubGames.some((x) => x.id === 'e2e-fn'));
  const detail404 = await fn.main(makeEvent('GET', '/api/v1/games/e2e-fn'));
  check('C2 匿名详情 404', detail404.statusCode === 404);
  const detailOwner = await fn.main(makeEvent('GET', '/api/v1/games/e2e-fn', null, playerToken));
  check('C3 发布者详情可读', detailOwner.statusCode === 200);
  const detailAdmin = await fn.main(makeEvent('GET', '/api/v1/games/e2e-fn', null, adminToken));
  check('C4 管理员详情可读', detailAdmin.statusCode === 200);

  // ---- ④ 提交审核 + 自动预检 ----
  const sub = await fn.main(makeEvent('POST', '/api/v1/games/__review/submit', { gameId: 'e2e-fn' }, playerToken));
  const subBody = JSON.parse(sub.body);
  check('D1 提交审核成功 pending', sub.statusCode === 200 && subBody.data.reviewStatus === 'pending');
  check('D2 自动预检 3 项', Array.isArray(subBody.data.autoChecks) && subBody.data.autoChecks.length === 3);

  // ---- ⑤ decide：checklist 校验 + 状态机 ----
  const ck3 = JSON.stringify({ gameId: 'e2e-fn', result: 'approve', checklist: [
    { key: 'content_compliance', passed: true }, { key: 'stability', passed: true },
    { key: 'info_completeness', passed: true }, { key: 'security', passed: false }] });
  const badApprove = await fn.main(makeEvent('POST', '/api/v1/games/__review/decide', ck3, adminToken));
  check('E1 四项未全过拒绝 approve 400', badApprove.statusCode === 400);

  const noReason = await fn.main(makeEvent('POST', '/api/v1/games/__review/decide', { gameId: 'e2e-fn', result: 'reject', reason: '' }, adminToken));
  check('E2 驳回无原因 400', noReason.statusCode === 400);

  const allOK = JSON.stringify({ gameId: 'e2e-fn', result: 'approve', note: 'ok', checklist: REVIEW_ALL_PASS() });
  function REVIEW_ALL_PASS() {
    return [
      { key: 'content_compliance', passed: true }, { key: 'stability', passed: true },
      { key: 'info_completeness', passed: true }, { key: 'security', passed: true }];
  }
  const approve = await fn.main(makeEvent('POST', '/api/v1/games/__review/decide', allOK, adminToken));
  const approveBody = JSON.parse(approve.body);
  check('E3 通过 → approved', approve.statusCode === 200 && approveBody.data.reviewStatus === 'approved');
  check('E4 记录含管理员/checklist', approveBody.data.record.adminName === 'admin' && approveBody.data.record.checklist.length === 4);

  const pubList2 = await fn.main(makeEvent('GET', '/api/v1/games'));
  check('E5 通过后公开列表可见', JSON.parse(pubList2.body).data.games.some((x) => x.id === 'e2e-fn'));

  // ---- ⑥ 下架 + 记录追溯 + admin ?all=1 ----
  const td = await fn.main(makeEvent('POST', '/api/v1/games/__review/takedown', { gameId: 'e2e-fn', reason: '复审发现异常' }, adminToken));
  check('F1 下架 → removed', td.statusCode === 200 && JSON.parse(td.body).data.reviewStatus === 'removed');
  const pubList3 = await fn.main(makeEvent('GET', '/api/v1/games'));
  check('F2 下架后公开列表隐藏', !JSON.parse(pubList3.body).data.games.some((x) => x.id === 'e2e-fn'));

  const recs = await fn.main(makeEvent('GET', '/api/v1/games/__review/records/e2e-fn', null, adminToken));
  const recsBody = JSON.parse(recs.body);
  check('F3 记录 3 条时间倒序', recsBody.data.records.length === 3
    && recsBody.data.records[0].action === 'takedown'
    && recsBody.data.records[2].action === 'submit');

  const adminAll = await fn.main(makeEvent('GET', '/api/v1/games', null, adminToken, '?all=1'));
  check('F4 admin all=1 可见已下架游戏', JSON.parse(adminAll.body).data.games.some((x) => x.id === 'e2e-fn' && x.reviewStatus === 'removed'));

  // ---- ⑦ 重新提交回 pending（重新发布场景）----
  const resub = await fn.main(makeEvent('POST', '/api/v1/games/__review/submit', { gameId: 'e2e-fn' }, playerToken));
  check('G1 重新提交回 pending', resub.statusCode === 200 && JSON.parse(resub.body).data.reviewStatus === 'pending');

  console.log('\nRESULT: pass=' + pass + ' fail=' + fail);
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error('TEST_ERROR', e); process.exit(1); });
