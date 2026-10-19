/**
 * 通知隧道（__notifications）——平台级站内信（首期仅私域合约邀请）
 *
 * 设计（2026-10-11）：
 * - 通知由服务端生成（contractTunnel deploy 成功后调用 buildContractInviteNotifications），
 *   不信任前端写入；userId 从 JWT 解析（与 __contract 同口径）
 * - 幂等：通知 id 确定性 = ntf_<contractId>_<toUserId>，隧道重试不产生重复
 * - 首期只做「发起时邀请」，剔除发起人自己；公开合约（whitelist 空）不发私信
 *
 * 端点：
 *   GET  /list?limit=50  本人通知倒序 + unreadCount
 *   POST /read           { ids?: string[] } 缺省 = 全部已读
 */
import { Router, Request, Response } from 'express';
import { verifyToken } from '../auth/jwt.js';

/** 通知记录形状（本地内存库与云端 notifications 集合同构） */
export interface NotificationRecord {
  id: string;
  toUserId: string;
  type: 'contract.private_invite';
  title: string;
  body: string;
  link: string;
  read: boolean;
  createdAt: number;
  meta?: { contractId: string; templateKey: string; initiatorId: string };
}

/**
 * 纯函数（导出供单测）：为私域合约生成邀请通知（剔除发起人，每人一条）。
 * whitelist 空 = 公开合约 → 返回空数组（公开合约大厅可见，不发逐人私信）。
 */
export function buildContractInviteNotifications(
  instance: {
    id: string;
    templateKey: string;
    initiatorId: string;
    whitelist?: string[] | null;
    params?: Record<string, any>;
  },
  fallbackTitle?: string,
): NotificationRecord[] {
  const wl = Array.isArray(instance.whitelist) ? instance.whitelist : [];
  if (wl.length === 0) return [];
  const now = Date.now();
  const p = instance.params || {};
  const tplName =
    instance.templateKey === 'group-buy' ? '拼团'
    : instance.templateKey === 'team-quest' ? '组队任务'
    : instance.templateKey === 'gso' ? '收益份额认购（GSO）'
    : fallbackTitle || '合约';
  const subject = String(p.itemTitle || p.questTitle || p.gameName || fallbackTitle || '').trim();
  const bodyMap: Record<string, string> = {
    'group-buy': `邀你参与拼团${subject ? `「${subject}」` : ''}，名额有限，货款由平台托管。`,
    'team-quest': `邀你组队完成任务${subject ? `「${subject}」` : ''}，押金与奖金池由平台托管。`,
    gso: `邀你认购${subject ? `「${subject}」` : ''}的收益分成份额，仅限名单内成员。`,
  };
  const body = bodyMap[instance.templateKey] || `邀你参与${subject ? `「${subject}」` : '合约'}。`;
  return wl
    .filter((u) => u && u !== instance.initiatorId)
    .map((toUserId) => ({
      id: `ntf_${instance.id}_${toUserId}`,
      toUserId,
      type: 'contract.private_invite' as const,
      title: `[私域邀请] ${instance.initiatorId} 发起的${tplName}`,
      body,
      link: `/contracts`,
      read: false,
      createdAt: now,
      meta: { contractId: instance.id, templateKey: instance.templateKey, initiatorId: instance.initiatorId },
    }));
}

export function createNotificationsTunnelRouter(USE_MEMORY_DB: boolean, memoryDB: any): Router {
  const router = Router();
  const isMemory = USE_MEMORY_DB || !!memoryDB;

  function resolveUserId(req: Request): string {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      try {
        const payload = verifyToken(authHeader.slice(7));
        if (payload && payload.userId) return payload.userId;
      } catch { /* 回退 */ }
    }
    const body: any = req.body || {};
    return String(body.userId || '');
  }

  /** GET /list?limit=50 — 本人通知倒序 + 未读数 */
  router.get('/list', async (req: Request, res: Response) => {
    const userId = resolveUserId(req);
    if (!userId) return res.status(401).json({ success: false, error: '未登录' });
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    let notifications: any[] = [];
    let unreadCount = 0;
    if (isMemory) {
      notifications = await memoryDB.listNotifications(userId, limit);
      unreadCount = await memoryDB.unreadNotificationCount(userId);
    }
    return res.json({ success: true, data: { notifications, unreadCount } });
  });

  /** POST /read — 标记已读（ids 缺省 = 全部本人通知） */
  router.post('/read', async (req: Request, res: Response) => {
    const userId = resolveUserId(req);
    if (!userId) return res.status(401).json({ success: false, error: '未登录' });
    const body: any = req.body || {};
    const ids: string[] | undefined = Array.isArray(body.ids)
      ? body.ids.map((x: unknown) => String(x || '').trim()).filter(Boolean)
      : undefined;
    let updated = 0;
    if (isMemory) {
      updated = await memoryDB.markNotificationsRead(userId, ids);
    }
    return res.json({ success: true, data: { updated } });
  });

  return router;
}
