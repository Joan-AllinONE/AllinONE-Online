// 一次性：向本地内存库后端播种示例 Freon 限时活动（可重复运行：同 id 409 时忽略）
const BASE = 'http://127.0.0.1:3000';
(async () => {
  const now = Date.now();
  const tok = (await (await fetch(`${BASE}/api/v1/games/dev-token`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: 'smoke-admin', role: 'admin' }),
  })).json()).data.token;

  const ev = {
    slug: 'freon', name: 'Freon 收集周', type: 'collect',
    startTime: now - 60_000, endTime: now + 7 * 86_400_000, leadHours: 0, graceHours: 72,
    config: {
      metric: 'freon', description: '活动期间参与游戏产出收集 Freon，达标领奖！',
      maxValuePerSubmit: 5, dailySubmitCap: 20, leaderboardMetric: 'freon',
    },
    rewardRules: [
      { id: 'rw_f10', kind: 'threshold', metric: 'freon', threshold: 10, reward: { currency: 'gamecoin', amount: 100 } },
      { id: 'rw_f50', kind: 'threshold', metric: 'freon', threshold: 50, reward: { currency: 'gamecoin', amount: 500 } },
      { id: 'rw_ftop', kind: 'leaderboard', metric: 'freon', rankRange: [0, 2], reward: { currency: 'gamecoin', amount: 1000 } },
      { id: 'rw_fjoin', kind: 'participation', metric: 'freon', reward: { currency: 'gamecoin', amount: 20 } },
    ],
    rollout: { mode: 'all' },
  };
  const r = await fetch(`${BASE}/api/v1/games/__event/admin/create`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
    body: JSON.stringify(ev),
  });
  const j = await r.json();
  console.log('create:', r.status, j.success, j.data?.event?.id, j.data?.event?.status, j.error || '');

  const c = await (await fetch(`${BASE}/api/v1/games/__event/current`)).json();
  console.log('current:', JSON.stringify((c.data?.events || []).map((e) => ({ id: e.id, status: e.status }))));
})();
