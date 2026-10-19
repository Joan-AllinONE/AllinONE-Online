/**
 * 限时活动冒烟（E1-E4）——全生命周期端到端
 *
 * 前置：USE_MEMORY_DB=true MEMORY_DB_FILE=none PORT=3100 node server.js
 * 运行：node scripts/smoke-limited-event.cjs
 * 幂等性：slug/userId 带 runId 后缀，可对同一 server 重复运行。
 */
const BASE = 'http://127.0.0.1:3100';
const RUN = 'r' + Date.now().toString(36).slice(-5);
let pass = 0, fail = 0;
const FAILS = [];
function assert(cond, name, extra) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; FAILS.push(name); console.log(`  ❌ ${name}${extra ? ' — ' + JSON.stringify(extra).slice(0, 200) : ''}`); }
}
async function api(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}
const EV = '/api/v1/games/__event';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log(`=== 限时活动冒烟（run=${RUN}）===`);
  const now = Date.now();
  const U1 = `smoke-${RUN}-p1`, U2 = `smoke-${RUN}-p2`;

  // 0. token
  const adminTok = (await api('POST', '/api/v1/games/dev-token', { userId: 'smoke-admin', role: 'admin' })).json?.data?.token;
  const p1 = (await api('POST', '/api/v1/games/dev-token', { userId: U1 })).json?.data?.token;
  const p2 = (await api('POST', '/api/v1/games/dev-token', { userId: U2 })).json?.data?.token;
  assert(!!adminTok && !!p1 && !!p2, 'dev-token 签发（admin/p1/p2）');

  // 1. 创建 freon 活动（窗口已开始 → tick 后 live）
  const create = await api('POST', `${EV}/admin/create`, {
    slug: `smokefreon${RUN}`, name: '冒烟 Freon', type: 'collect',
    startTime: now - 1000, endTime: now + 10 * 60_000,
    leadHours: 0, graceHours: 0,
    config: { metric: 'freon', maxValuePerSubmit: 5, dailySubmitCap: 10, leaderboardMetric: 'freon' },
    rewardRules: [
      { id: 'r10', kind: 'threshold', metric: 'freon', threshold: 3, reward: { currency: 'gamecoin', amount: 100 } },
      { id: 'rjoin', kind: 'participation', metric: 'freon', reward: { currency: 'gamecoin', amount: 20 } },
      { id: 'rtop', kind: 'leaderboard', metric: 'freon', rankRange: [0, 0], reward: { currency: 'gamecoin', amount: 500 } },
    ],
  }, adminTok);
  assert(create.status === 200 && create.json?.data?.event, 'admin/create 创建活动', create.json);
  const evId = create.json?.data?.event?.id;
  const det0 = await api('GET', `${EV}/${evId}/detail`);
  assert(det0.json?.data?.event?.status === 'live', 'create 后 tick 即 live（draft→scheduled→live）', det0.json?.data?.event?.status);

  // 2. /current 可见
  const cur = await api('GET', `${EV}/current`);
  assert(cur.json?.data?.events?.some((e) => e.id === evId), '/current 返回活跃活动');
  assert(typeof cur.json?.data?.serverNow === 'number', '/current 携带 serverNow（时钟校准）');

  // 3. join + submit
  const join = await api('POST', `${EV}/${evId}/join`, {}, p1);
  assert(join.status === 200 && join.json?.data?.participation, 'join 进入活动');
  const join2 = await api('POST', `${EV}/${evId}/join`, {}, p1);
  assert(join2.json?.data?.alreadyJoined === true, 'join 幂等（重复 join 不新建）');
  const sub = await api('POST', `${EV}/${evId}/submit`, { metric: 'freon', value: 3 }, p1);
  assert(sub.status === 200 && sub.json?.data?.participation?.metrics?.freon === 3, 'submit 计分');

  // 4. 防刷校验
  const bad1 = await api('POST', `${EV}/${evId}/submit`, { metric: 'freon', value: 10 }, p1);
  assert(bad1.status === 400, '单次超 maxValuePerSubmit → 400', bad1.json);
  const bad2 = await api('POST', `${EV}/${evId}/submit`, { metric: 'hack', value: 1 }, p1);
  assert(bad2.status === 400, '非法指标 → 400', bad2.json);

  // 5. 领奖（threshold + participation）+ 幂等
  const prog = await api('GET', `${EV}/${evId}/progress`, null, p1);
  const c10 = prog.json?.data?.claimables?.find((c) => c.rewardId === 'r10');
  assert(c10?.claimable === true, 'progress 显示 threshold 奖可领');
  const claim = await api('POST', `${EV}/${evId}/claim`, { rewardId: 'r10' }, p1);
  assert(claim.status === 200 && claim.json?.data?.amount === 100, 'claim 领取 100 游戏币（服务端重算达标）', claim.json);
  const claim2 = await api('POST', `${EV}/${evId}/claim`, { rewardId: 'r10' }, p1);
  assert(claim2.json?.data?.alreadyGranted === true, 'claim 重放幂等（alreadyGranted，不重复发放）', claim2.json);
  const prog2 = await api('GET', `${EV}/${evId}/progress`, null, p1);
  assert(prog2.json?.data?.totalGranted === 100, 'totalGranted=100（未重复计）', prog2.json?.data?.totalGranted);
  const claimJoin = await api('POST', `${EV}/${evId}/claim`, { rewardId: 'rjoin' }, p1);
  assert(claimJoin.json?.data?.amount === 20, 'participation 奖可领', claimJoin.json);

  // 6. 灰度白名单：未加入者 403
  const wcreate = await api('POST', `${EV}/admin/create`, {
    slug: `smokegray${RUN}`, name: '灰度', type: 'collect',
    startTime: now - 1000, endTime: now + 10 * 60_000, leadHours: 0, graceHours: 0,
    rollout: { mode: 'whitelist', whitelist: [U1] },
    config: { metric: 'freon' }, rewardRules: [],
  }, adminTok);
  const gid = wcreate.json?.data?.event?.id;
  const gj2 = await api('POST', `${EV}/${gid}/join`, {}, p2);
  assert(gj2.status === 403 && gj2.json?.error === 'EVENT_NOT_ACTIVE', '灰度外用户参与 → 403 EVENT_NOT_ACTIVE', gj2.json);
  const gj1 = await api('POST', `${EV}/${gid}/join`, {}, p1);
  assert(gj1.status === 200, '灰度内用户正常参与');

  // 7. 紧急下线：force-stop → /current 消失 + 参与 403
  await api('POST', `${EV}/admin/force-stop`, { id: gid }, adminTok);
  const cur2 = await api('GET', `${EV}/current`);
  assert(!cur2.json?.data?.events?.some((e) => e.id === gid), 'force-stop 后 /current 不再返回');
  const gs2 = await api('POST', `${EV}/${gid}/submit`, { metric: 'freon', value: 1 }, p1);
  assert(gs2.status === 403, 'force-stop 后参与接口 403');

  // 8. 结算：强制到期 → closing→settled（graceHours=0）→ leaderboard 发放
  await api('POST', `${EV}/admin/update`, { id: evId, endTime: now - 2000 }, adminTok);
  const tick = await api('POST', `${EV}/tick`);
  assert(tick.status === 200, 'tick 执行正常（update 内部 tick 可能已先行完成迁移）');
  const list = await api('GET', `${EV}/admin/list?filter=all`, null, adminTok);
  const settledEv = list.json?.data?.events?.find((e) => e.id === evId);
  assert(settledEv?.status === 'settled', '活动状态 settled', settledEv?.status);
  assert((settledEv?.settleManifest?.grants || 0) >= 1, '结算清单：leaderboard top1 已发放', settledEv?.settleManifest);
  const lateClaim = await api('POST', `${EV}/${evId}/claim`, { rewardId: 'rjoin' }, p1);
  assert(lateClaim.status === 403, 'settled 后 claim 关闭（403）');
  const resettle = await api('POST', `${EV}/admin/resettle`, { id: evId }, adminTok);
  assert(resettle.json?.data?.manifest?.grants === 0, '手动重结算幂等（已发放的跳过，补发 0）', resettle.json);

  // 9. 周期活动克隆下一期
  const rep = await api('POST', `${EV}/admin/create`, {
    slug: `smokerep${RUN}`, name: '周期活动', type: 'collect',
    startTime: now - 1000, endTime: now + 60_000, leadHours: 0, graceHours: 0,
    repeat: { unit: 'weekly' },
    config: { metric: 'freon' }, rewardRules: [],
  }, adminTok);
  const repId = rep.json?.data?.event?.id;
  const repStart = rep.json?.data?.event?.startTime;
  await api('POST', `${EV}/admin/update`, { id: repId, endTime: now - 2000 }, adminTok);
  await api('POST', `${EV}/tick`);
  const list2 = await api('GET', `${EV}/admin/list?filter=all`, null, adminTok);
  const nextId = `evt_smokerep${RUN}_2`;
  const next = list2.json?.data?.events?.find((e) => e.id === nextId);
  assert(!!next, '周期活动 closing 时克隆下一期 ' + nextId);
  assert(next && Math.abs(next.startTime - (repStart + 7 * 86400_000)) < 2000, '下一期时间 +7d', next && { s: next.startTime, exp: repStart + 7 * 86400_000 });
  assert(next?.status === 'draft', '下一期初始为 draft（下期到点再开）', next?.status);

  // 10. 分阶段活动（grand-building 模式）；阶段1 窗口 3s 后切阶段2
  const s1s = now - 1000, s1e = now + 3000, s2s = s1e, s2e = s1e + 60_000;
  const gb = await api('POST', `${EV}/admin/create`, {
    slug: `smokegb${RUN}`, name: '共建', type: 'staged',
    startTime: s1s, endTime: s2e, leadHours: 0, graceHours: 0,
    config: {
      metric: 'stage_contrib', leaderboardMetric: 'stage_contrib',
      stages: [
        { id: `stg_${RUN}_1`, index: 1, name: '地基', startTime: s1s, endTime: s1e, goal: { metric: 'bricks', target: 2 }, rewards: [{ id: 'rws1', kind: 'threshold', metric: 'bricks', stageId: `stg_${RUN}_1`, threshold: 1, reward: { currency: 'gamecoin', amount: 50 } }] },
        { id: `stg_${RUN}_2`, index: 2, name: '主体', startTime: s2s, endTime: s2e, goal: { metric: 'bricks', target: 2 }, rewards: [] },
      ],
    },
    rewardRules: [],
  }, adminTok);
  const gbId = gb.json?.data?.event?.id;
  const gbdet = await api('GET', `${EV}/${gbId}/detail`);
  assert(gbdet.json?.data?.event?.status === 'live', 'staged 活动 live', gbdet.json?.data?.event?.status);
  await api('POST', `${EV}/${gbId}/join`, {}, p1);
  const s1 = await api('POST', `${EV}/${gbId}/submit`, { metric: 'bricks', value: 1 }, p1);
  assert(s1.json?.data?.participation?.stageContrib?.[`stg_${RUN}_1`] === 1, '阶段贡献计入 stageContrib', s1.json);
  const det = await api('GET', `${EV}/${gbId}/detail`);
  assert(det.json?.data?.stageProgress?.[0]?.current === 1, '全服阶段进度 current=1（建造进度）', det.json?.data?.stageProgress);
  const gprog = await api('GET', `${EV}/${gbId}/progress`, null, p1);
  const rws1 = gprog.json?.data?.claimables?.find((c) => c.rewardId === 'rws1');
  assert(rws1?.claimable === true, '阶段 threshold 奖可领（stageId 匹配）');
  await api('POST', `${EV}/${gbId}/claim`, { rewardId: 'rws1' }, p1);
  // 等阶段1结束、阶段2开始
  await sleep(3500);
  const s2sub = await api('POST', `${EV}/${gbId}/submit`, { metric: 'bricks', value: 1 }, p1);
  assert(s2sub.json?.data?.participation?.stageContrib?.[`stg_${RUN}_2`] === 1, '阶段2 贡献归属阶段2', s2sub.json?.data?.participation?.stageContrib);
  // tick：阶段1 超时收尾
  await api('POST', `${EV}/tick`);
  const det2 = await api('GET', `${EV}/${gbId}/detail`);
  const sp1 = det2.json?.data?.stageProgress?.find((s) => s.stageId === `stg_${RUN}_1`);
  assert(!!sp1 && (!!sp1.completedAt || sp1.timedOut), '阶段结束 tick 收尾（completedAt/timedOut）', sp1);

  // 11. 窗口外参与拒绝（活动未开始）
  const future = await api('POST', `${EV}/admin/create`, {
    slug: `smokefuture${RUN}`, name: '未来活动', type: 'collect',
    startTime: now + 10 * 86400_000, endTime: now + 11 * 86400_000, leadHours: 0, graceHours: 0,
    config: { metric: 'freon' }, rewardRules: [],
  }, adminTok);
  const fid = future.json?.data?.event?.id;
  const fj = await api('POST', `${EV}/${fid}/join`, {}, p1);
  assert(fj.status === 403, '未到窗口的活动参与 → 403');

  // 12. 非管理员访问 admin 接口 403
  const noadmin = await api('GET', `${EV}/admin/list`, null, p1);
  assert(noadmin.status === 403, '非管理员访问 admin 接口 → 403');

  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
  if (FAILS.length) { console.log('失败项：', FAILS.join(' | ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error('冒烟异常:', e); process.exit(1); });
