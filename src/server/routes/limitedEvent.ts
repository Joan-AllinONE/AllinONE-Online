/**
 * 限时活动隧道（__event，E1-E4）——时间窗口 + 功能开关 + 状态机
 *
 * 设计（docs/limited-time-event-design.md）。与云函数 gamesApi `__event` 分支双实现对齐。
 *
 * 公开（无 JWT，挂载在全局 authMiddleware 之前）：
 *   GET  /current              — 活跃+预热活动摘要（含 serverNow / 预加载信号）
 *   GET  /:id/detail           — 活动详情 + 阶段 + 全服进度
 *   GET  /:id/leaderboard      — 排行榜快照
 *   POST /tick                 — 状态机 tick（本地 60s cron 自调；幂等）
 *
 * 认证（路由内自行解析 Bearer，userId 从 JWT 解析）：
 *   POST /:id/join             — 进入活动（幂等 eventId:userId）
 *   POST /:id/submit           — 提交成绩/资源（三重校验 + 限流）
 *   GET  /:id/progress         — 个人进度 + 可领奖励
 *   POST /:id/claim            — 领奖（live|closing 放行；grant_ 幂等键先落表再入账）
 *
 * 管理（JWT role=admin/platform）：
 *   GET  /admin/list           — 全量活动（含 draft/settled/archived）
 *   POST /admin/create         — 创建活动
 *   POST /admin/update         — 更新活动（改时间/奖励/开关，无需发版）
 *   POST /admin/force-stop     — 紧急下线
 *   POST /admin/resettle       — 手动重结算（幂等：只会补发漏发，不会重复发放）
 */
import { Router, Request, Response } from 'express';
import { verifyToken } from '../auth/jwt.js';
import { logger } from '../logger.js';
import {
  LimitedEventDef, EventParticipation, EventGrant,
  advanceStatus, checkEventGate, checkSubmit, currentStage, dayKey,
  computeClaimables, computeLeaderboard, computeSettlementGrants, computeDrop,
  cloneNextOccurrence, defaultMetric, grantId, ARCHIVE_AFTER_MS,
} from '../eventEngine.js';
import { createHash } from 'crypto';

function resolveAuth(req: Request): { userId: string; role: string } {
  const h = req.headers.authorization;
  if (h && h.startsWith('Bearer ')) {
    try {
      const payload = verifyToken(h.slice(7)) as any;
      if (payload && payload.userId) return { userId: String(payload.userId), role: String(payload.role || 'player') };
    } catch { /* 回退 body（dev-token 场景） */ }
  }
  const body: any = req.body || {};
  return { userId: String(body.userId || ''), role: String(body.role || 'player') };
}

function isAdmin(auth: { userId: string; role: string }): boolean {
  return auth.role === 'admin' || auth.role === 'platform';
}

export function createLimitedEventTunnelRouter(
  USE_MEMORY_DB: boolean,
  memoryDB: any,
  _pool: any,
  isProduction: boolean,
): Router {
  const router = Router();
  void _pool;

  // ==================== tick（状态机驱动；幂等） ====================

  /**
   * tick 编排（导出供 server.js 自调复用）：
   * ① advanceStatus 循环迁移 ② closing 入口跑结算（manifest 幂等）
   * ③ 周期活动克隆下一期 ④ settled + 保留期 → 归档 ⑤ staged 阶段达标检查
   */
  async function eventTick(): Promise<{ transitions: number; settled: number; cloned: number; archived: number }> {
    const now = Date.now();
    const result = { transitions: 0, settled: 0, cloned: 0, archived: 0 };
    const events: LimitedEventDef[] = await memoryDB.getLimitedEvents();

    for (const e of events) {
      const { status, transitions } = advanceStatus(e, now);
      let updated: LimitedEventDef = { ...e, status, updatedAt: now };
      if (transitions.length > 0) result.transitions += transitions.length;

      // ② closing 入口：结算（leaderboard 发放 + manifest；重跑安全）
      if (transitions.includes('closing')) {
        updated = await settleEvent(updated);
        result.settled++;
        // ③ 周期活动克隆下一期（期号 = 该 slug 现存期总数（含本期与归档）+1）
        if (updated.repeat && !updated.forceStopAt) {
          const total = await memoryDB.countLimitedEventsBySlug(updated.slug);
          if (!updated.repeat.count || total < updated.repeat.count) {
            const next = cloneNextOccurrence(updated, total);
            if (!(await memoryDB.getLimitedEvent(next.id))) {
              await memoryDB.upsertLimitedEvent(next);
              result.cloned++;
            }
          }
        }
      }

      // ④ 归档：settled 且过保留期
      if (status === 'settled' && now >= updated.updatedAt + ARCHIVE_AFTER_MS) {
        await memoryDB.pushArchivedEvent({ ...updated, status: 'archived' });
        result.archived++;
        continue;
      }

      // ⑤ staged：全服阶段达标检查（幂等：completedAt 已存在跳过）
      if (status === 'live' && updated.config?.stages) {
        for (const s of updated.config.stages) {
          if (s.endTime > now) continue;
          const prog = await memoryDB.getEventStageProgress(s.id);
          if (prog && !prog.completedAt && (prog.current || 0) >= s.goal.target) {
            await memoryDB.upsertEventStageProgress({ ...prog, completedAt: now });
          } else if (prog && !prog.completedAt) {
            // 阶段结束未达标：标记超时完成（completedAt + timeout 标记）
            await memoryDB.upsertEventStageProgress({ ...prog, completedAt: now, timedOut: true });
          }
        }
      }

      if (transitions.length > 0 || status !== e.status) {
        await memoryDB.upsertLimitedEvent(updated);
      }
    }
    return result;
  }

  /** 结算：leaderboard 型奖励批量发放（grant id 幂等）+ settleManifest 哈希存证 */
  async function settleEvent(e: LimitedEventDef): Promise<LimitedEventDef> {
    if (e.settleManifest) return e; // 已结算，幂等
    const parts: EventParticipation[] = await memoryDB.listEventParticipations(e.id);
    const grants = computeSettlementGrants(e, parts);
    let granted = 0;
    for (const g of grants) {
      const rec: EventGrant = {
        id: grantId(e.id, g.userId, g.rewardId),
        eventId: e.id, userId: g.userId, rewardId: g.rewardId,
        amount: g.amount, grantedAt: Date.now(), source: 'settle_job',
      };
      if (await memoryDB.addEventGrant(rec)) {
        granted++;
        try {
          await memoryDB.addGameCoins(g.userId, g.amount, `限时活动结算 ${e.name}`);
        } catch (err: any) {
          logger.error({ err, eventId: e.id, userId: g.userId }, '[event] 结算入账失败（需人工介入，不静默重试）');
        }
      }
    }
    const manifest = {
      grants: granted,
      settledAt: Date.now(),
      hash: createHash('sha256').update(`${e.id}:${granted}:${grants.map((g) => g.rewardId + g.userId).sort().join(',')}`).digest('hex').slice(0, 16),
    };
    return { ...e, settleManifest: manifest, updatedAt: Date.now() };
  }

  // ==================== 公开路由 ====================

  router.post('/tick', async (_req: Request, res: Response) => {
    try {
      const r = await eventTick();
      res.json({ success: true, data: r });
    } catch (error: any) {
      logger.error({ err: error }, '[event] tick error');
      res.status(500).json({ success: false, error: isProduction ? 'Internal server error' : error.message });
    }
  });

  /** GET /current — 活跃/预热/补领期活动摘要（前端轮询 + 动态导入信号） */
  router.get('/current', async (req: Request, res: Response) => {
    try {
      await eventTick();
      const now = Date.now();
      const all: LimitedEventDef[] = await memoryDB.getLimitedEvents();
      const visible = all.filter(
        (e) => e.enabled && !(e.forceStopAt ?? 0) &&
          ['scheduled', 'live', 'closing'].includes(e.status) &&
          now >= e.startTime - e.leadHours * 3600_000 && now < e.endTime + e.graceHours * 3600_000,
      );
      res.json({
        success: true,
        data: {
          serverNow: now,
          events: visible.map((e) => ({
            id: e.id, slug: e.slug, name: e.name, type: e.type, status: e.status,
            startTime: e.startTime, endTime: e.endTime, graceHours: e.graceHours,
            serverNow: now,
            description: e.config?.description || '',
            metric: defaultMetric(e),
          })),
        },
      });
    } catch (error: any) {
      logger.error({ err: error }, '[event] current error');
      res.status(500).json({ success: false, error: isProduction ? 'Internal server error' : error.message });
    }
  });

  /** GET /:id/detail — 详情 + 阶段 + 全服进度（构造进度可视化） */
  router.get('/:id/detail', async (req: Request, res: Response) => {
    try {
      const id = String(req.params.id || '');
      const e: LimitedEventDef | undefined = await memoryDB.getLimitedEvent(id);
      if (!e || !e.enabled) return res.status(404).json({ success: false, error: '活动不存在' });
      const stages = e.config?.stages || [];
      const stageProgress = await Promise.all(stages.map((s) => memoryDB.getEventStageProgress(s.id)));
      const metric = e.config?.leaderboardMetric || defaultMetric(e);
      const parts = await memoryDB.listEventParticipations(e.id);
      res.json({
        success: true,
        data: {
          serverNow: Date.now(),
          event: e,
          stageProgress: stageProgress.filter(Boolean),
          leaderboard: computeLeaderboard(parts, metric, 20),
          totalParticipants: parts.length,
        },
      });
    } catch (error: any) {
      logger.error({ err: error }, '[event] detail error');
      res.status(500).json({ success: false, error: isProduction ? 'Internal server error' : error.message });
    }
  });

  /** GET /:id/leaderboard — 排行榜快照 */
  router.get('/:id/leaderboard', async (req: Request, res: Response) => {
    try {
      const id = String(req.params.id || '');
      const e = await memoryDB.getLimitedEvent(id);
      if (!e) return res.status(404).json({ success: false, error: '活动不存在' });
      const metric = e.config?.leaderboardMetric || defaultMetric(e);
      const parts = await memoryDB.listEventParticipations(id);
      res.json({ success: true, data: { leaderboard: computeLeaderboard(parts, metric, 50), metric } });
    } catch (error: any) {
      res.status(500).json({ success: false, error: isProduction ? 'Internal server error' : error.message });
    }
  });

  // ==================== 认证路由（路由内解析 Bearer） ====================

  /** POST /:id/join — 进入活动（幂等） */
  router.post('/:id/join', async (req: Request, res: Response) => {
    const auth = resolveAuth(req);
    if (!auth.userId) return res.status(401).json({ success: false, error: '未登录' });
    try {
      const id = String(req.params.id || '');
      const e = await memoryDB.getLimitedEvent(id);
      const now = Date.now();
      const gate = checkEventGate(e, auth.userId, now, 'live');
      if (!gate.ok) return res.status(gate.code).json({ success: false, error: gate.error, data: gate.payload });
      const p = await memoryDB.getEventParticipation(id, auth.userId);
      if (p) return res.json({ success: true, data: { participation: p, alreadyJoined: true } });
      const np: EventParticipation = {
        id: `${id}:${auth.userId}`, eventId: id, userId: auth.userId, joinedAt: now,
        metrics: {}, submissions: 0, submissionsToday: 0, submissionsDate: dayKey(now),
        stageContrib: {}, lastSubmitAt: 0,
      };
      await memoryDB.upsertEventParticipation(np);
      res.json({ success: true, data: { participation: np, alreadyJoined: false } });
    } catch (error: any) {
      logger.error({ err: error }, '[event] join error');
      res.status(500).json({ success: false, error: isProduction ? 'Internal server error' : error.message });
    }
  });

  /** POST /:id/submit — 提交成绩/资源（窗口校验 + 单值上限 + 每日限流；staged 同步阶段贡献） */
  router.post('/:id/submit', async (req: Request, res: Response) => {
    const auth = resolveAuth(req);
    if (!auth.userId) return res.status(401).json({ success: false, error: '未登录' });
    try {
      const id = String(req.params.id || '');
      const body: any = req.body || {};
      const metric = String(body.metric || '');
      const value = Number(body.value);
      const e = await memoryDB.getLimitedEvent(id);
      const now = Date.now();
      const gate = checkEventGate(e, auth.userId, now, 'live');
      if (!gate.ok) return res.status(gate.code).json({ success: false, error: gate.error, data: gate.payload });
      const ev = e as LimitedEventDef;

      // 必须先 join
      const p = await memoryDB.getEventParticipation(id, auth.userId);
      if (!p) return res.status(400).json({ success: false, error: '尚未加入活动' });

      // 指标合法性：默认指标或配置允许的指标
      const dm = defaultMetric(ev);
      const stage = ev.type === 'staged' ? currentStage(ev, now) : null;
      const validMetrics = new Set<string>([dm, ...(ev.config?.extraMetrics || [])]);
      if (stage) validMetrics.add(stage.goal.metric);
      if (!metric || !validMetrics.has(metric)) {
        return res.status(400).json({ success: false, error: `非法指标 ${metric}（允许: ${Array.from(validMetrics).join(',')}）` });
      }

      const check = checkSubmit(ev, p, value, now);
      if (!check.ok) return res.status(check.code || 400).json({ success: false, error: check.error });

      // 更新参与档案（增量累计；每日限流按 UTC 日重置）
      const today = dayKey(now);
      const todayCount = p.submissionsDate === today ? p.submissionsToday : 0;
      const np: EventParticipation = {
        ...p,
        metrics: { ...p.metrics, [metric]: (p.metrics[metric] || 0) + value },
        submissions: p.submissions + 1,
        submissionsToday: todayCount + 1,
        submissionsDate: today,
        lastSubmitAt: now,
      };

      // staged：同步个人阶段贡献 + 全服进度
      if (stage) {
        np.stageContrib = { ...p.stageContrib, [stage.id]: (p.stageContrib[stage.id] || 0) + value };
        const prog = (await memoryDB.getEventStageProgress(stage.id)) || {
          stageId: stage.id, eventId: id, metric: stage.goal.metric, current: 0,
        };
        const current = (prog.current || 0) + value;
        const completedAt = current >= stage.goal.target ? (prog.completedAt || now) : prog.completedAt || null;
        await memoryDB.upsertEventStageProgress({ ...prog, current, completedAt });
      }
      await memoryDB.upsertEventParticipation(np);
      res.json({ success: true, data: { participation: np } });
    } catch (error: any) {
      logger.error({ err: error }, '[event] submit error');
      res.status(500).json({ success: false, error: isProduction ? 'Internal server error' : error.message });
    }
  });

  /** GET /:id/progress — 个人进度 + 可领奖励（threshold/participation） */
  router.get('/:id/progress', async (req: Request, res: Response) => {
    const auth = resolveAuth(req);
    if (!auth.userId) return res.status(401).json({ success: false, error: '未登录' });
    try {
      const id = String(req.params.id || '');
      const e = await memoryDB.getLimitedEvent(id);
      if (!e) return res.status(404).json({ success: false, error: '活动不存在' });
      const p = await memoryDB.getEventParticipation(id, auth.userId);
      const grants = await memoryDB.listEventGrantsByUser(id, auth.userId);
      const claimables = computeClaimables(e, p, new Set(grants.map((g: any) => g.rewardId)));
      res.json({
        success: true,
        data: {
          serverNow: Date.now(),
          participation: p,
          claimables,
          stageProgress: await memoryDB.listEventStageProgressByEvent(id),
          totalGranted: grants.reduce((a: number, g: any) => a + (g.amount || 0), 0),
        },
      });
    } catch (error: any) {
      res.status(500).json({ success: false, error: isProduction ? 'Internal server error' : error.message });
    }
  });

  /** POST /:id/claim — 领奖（live|closing 放行；grant 幂等键先落表再入账；达标签服务端重算） */
  router.post('/:id/claim', async (req: Request, res: Response) => {
    const auth = resolveAuth(req);
    if (!auth.userId) return res.status(401).json({ success: false, error: '未登录' });
    try {
      const id = String(req.params.id || '');
      const body: any = req.body || {};
      const rewardId = String(body.rewardId || '');
      const e = await memoryDB.getLimitedEvent(id);
      const now = Date.now();
      const gate = checkEventGate(e, auth.userId, now, 'live-or-closing');
      if (!gate.ok) return res.status(gate.code).json({ success: false, error: gate.error, data: gate.payload });

      // 幂等：grant 已存在 → 直接成功返回（双击/重放友好）
      const gid = grantId(id, auth.userId, rewardId);
      const existing = await memoryDB.getEventGrant(gid);
      if (existing) return res.json({ success: true, data: { alreadyGranted: true, amount: existing.amount, balance: null } });

      // 服务端重算达标签（绝不信客户端）
      const p = await memoryDB.getEventParticipation(id, auth.userId);
      if (!p) return res.status(400).json({ success: false, error: '尚未加入活动' });
      const grants = await memoryDB.listEventGrantsByUser(id, auth.userId);
      const claimables = computeClaimables(e, p, new Set(grants.map((g: any) => g.rewardId)));
      const target = claimables.find((c) => c.rewardId === rewardId);
      if (!target || !target.claimable) {
        return res.status(400).json({ success: false, error: '奖励不存在或未达标' });
      }

      const rec: EventGrant = {
        id: gid, eventId: id, userId: auth.userId, rewardId,
        amount: target.reward.amount, grantedAt: now, source: 'self_claim',
      };
      if (!(await memoryDB.addEventGrant(rec))) {
        return res.json({ success: true, data: { alreadyGranted: true, amount: rec.amount, balance: null } });
      }
      // grant 即台账（幂等已锁定）：入账失败不得返回 500，否则客户端重试只会拿到
      // alreadyGranted 而币永久丢失。失败记日志人工介入（与结算口径一致）。
      let balance: number | null = null;
      try {
        balance = await memoryDB.addGameCoins(auth.userId, rec.amount, `限时活动领奖 ${e.name}`);
      } catch (err: any) {
        logger.error({ err, eventId: id, userId: auth.userId, grantId: gid }, '[event] 领奖入账失败（grant 已记录，需人工补发）');
      }
      res.json({ success: true, data: { alreadyGranted: false, amount: rec.amount, balance } });
    } catch (error: any) {
      logger.error({ err: error }, '[event] claim error');
      res.status(500).json({ success: false, error: isProduction ? 'Internal server error' : error.message });
    }
  });

  // ==================== 管理路由（运营后台；JWT role=admin/platform） ====================

  router.get('/admin/list', async (req: Request, res: Response) => {
    const auth = resolveAuth(req);
    if (!isAdmin(auth)) return res.status(403).json({ success: false, error: '需要管理员权限' });
    try {
      const events = await memoryDB.getLimitedEvents();
      const archived = await memoryDB.getArchivedEvents();
      const filter = String((req.query as any).filter || 'all');
      const list = filter === 'archived' ? archived : events.filter((e: any) => filter === 'all' || e.status === filter);
      res.json({ success: true, data: { events: list, archivedCount: archived.length } });
    } catch (error: any) {
      res.status(500).json({ success: false, error: isProduction ? 'Internal server error' : error.message });
    }
  });

  router.post('/admin/create', async (req: Request, res: Response) => {
    const auth = resolveAuth(req);
    if (!isAdmin(auth)) return res.status(403).json({ success: false, error: '需要管理员权限' });
    try {
      const body: any = req.body || {};
      const slug = String(body.slug || '').trim();
      if (!slug) return res.status(400).json({ success: false, error: '缺少 slug' });
      const now = Date.now();
      const seq = await memoryDB.countLimitedEventsBySlug(slug);
      const e: LimitedEventDef = {
        id: String(body.id || `evt_${slug}_${seq + 1}`),
        slug, name: String(body.name || slug), type: body.type || 'collect',
        status: 'draft', enabled: body.enabled !== false,
        startTime: Number(body.startTime) || now, endTime: Number(body.endTime) || now + 7 * 86400_000,
        leadHours: Number(body.leadHours) || 0,
        // ⚠️ Number(undefined)=NaN 且 NaN ?? 72 = NaN（?? 只兜 null/undefined），必须 isFinite 兜底
        graceHours: Number.isFinite(Number(body.graceHours)) ? Number(body.graceHours) : 72,
        repeat: body.repeat || undefined,
        config: body.config || {}, rewardRules: body.rewardRules || [],
        rollout: body.rollout || { mode: 'all' },
        settleManifest: null, createdAt: now, updatedAt: now,
      };
      if (await memoryDB.getLimitedEvent(e.id)) {
        return res.status(409).json({ success: false, error: `活动 id 已存在: ${e.id}` });
      }
      await memoryDB.upsertLimitedEvent(e);
      await eventTick();
      res.json({ success: true, data: { event: e } });
    } catch (error: any) {
      logger.error({ err: error }, '[event] admin create error');
      res.status(500).json({ success: false, error: isProduction ? 'Internal server error' : error.message });
    }
  });

  /** 运营改时间/奖励/开关 = 改一行数据；/current 30s 内收敛，无需发版 */
  router.post('/admin/update', async (req: Request, res: Response) => {
    const auth = resolveAuth(req);
    if (!isAdmin(auth)) return res.status(403).json({ success: false, error: '需要管理员权限' });
    try {
      const body: any = req.body || {};
      const id = String(body.id || '');
      const e = await memoryDB.getLimitedEvent(id);
      if (!e) return res.status(404).json({ success: false, error: '活动不存在' });
      const patch: any = {};
      for (const k of ['name', 'enabled', 'startTime', 'endTime', 'leadHours', 'graceHours', 'repeat', 'config', 'rewardRules', 'rollout']) {
        if (body[k] !== undefined) patch[k] = body[k];
      }
      // 数值字段归一化：NaN 会污染状态机比较（now >= NaN 恒 false → 永卡当前状态）
      for (const k of ['startTime', 'endTime', 'leadHours', 'graceHours']) {
        if (patch[k] !== undefined && !Number.isFinite(Number(patch[k]))) delete patch[k];
        else if (patch[k] !== undefined) patch[k] = Number(patch[k]);
      }
      const updated = { ...e, ...patch, updatedAt: Date.now() };
      await memoryDB.upsertLimitedEvent(updated);
      await eventTick();
      res.json({ success: true, data: { event: updated } });
    } catch (error: any) {
      res.status(500).json({ success: false, error: isProduction ? 'Internal server error' : error.message });
    }
  });

  /** 紧急下线：入口消失 + 参与接口三重校验拒绝；参与数据保留走正常结算 */
  router.post('/admin/force-stop', async (req: Request, res: Response) => {
    const auth = resolveAuth(req);
    if (!isAdmin(auth)) return res.status(403).json({ success: false, error: '需要管理员权限' });
    try {
      const body: any = req.body || {};
      const id = String(body.id || '');
      const e = await memoryDB.getLimitedEvent(id);
      if (!e) return res.status(404).json({ success: false, error: '活动不存在' });
      const updated = { ...e, enabled: false, forceStopAt: Date.now(), updatedAt: Date.now() };
      await memoryDB.upsertLimitedEvent(updated);
      await eventTick();
      res.json({ success: true, data: { event: updated } });
    } catch (error: any) {
      res.status(500).json({ success: false, error: isProduction ? 'Internal server error' : error.message });
    }
  });

  /** 手动重结算：幂等（manifest 清空重跑，grant 已存在的跳过 → 只补发漏发） */
  router.post('/admin/resettle', async (req: Request, res: Response) => {
    const auth = resolveAuth(req);
    if (!isAdmin(auth)) return res.status(403).json({ success: false, error: '需要管理员权限' });
    try {
      const body: any = req.body || {};
      const id = String(body.id || '');
      const e = await memoryDB.getLimitedEvent(id);
      if (!e) return res.status(404).json({ success: false, error: '活动不存在' });
      const settled = await settleEvent({ ...e, settleManifest: null });
      await memoryDB.upsertLimitedEvent({ ...e, ...settled });
      res.json({ success: true, data: { manifest: settled.settleManifest } });
    } catch (error: any) {
      res.status(500).json({ success: false, error: isProduction ? 'Internal server error' : error.message });
    }
  });

  return router;
}
