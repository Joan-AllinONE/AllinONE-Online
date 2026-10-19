/**
 * 私域合约邀请通知纯函数单测（2026-10-11）
 * 覆盖：公开合约不发 / 剔除发起人 / 幂等 id / 文案按模板区分
 */
import { describe, it, expect } from 'vitest';
import { buildContractInviteNotifications } from '@/server/routes/notifications';

describe('buildContractInviteNotifications', () => {
  const base = {
    id: 'ctr_test1',
    templateKey: 'group-buy',
    initiatorId: 'alice',
    params: { itemTitle: '传奇皮肤' },
  };

  it('公开合约（whitelist 空/缺省）不发私信', () => {
    expect(buildContractInviteNotifications(base).length).toBe(0);
    expect(buildContractInviteNotifications({ ...base, whitelist: [] }).length).toBe(0);
  });

  it('为名单内成员逐个生成并剔除发起人自己', () => {
    const rows = buildContractInviteNotifications({ ...base, whitelist: ['bob', 'alice', 'carol', ''] });
    expect(rows.map((r) => r.toUserId).sort()).toEqual(['bob', 'carol']);
  });

  it('id 确定性（幂等）：重复调用不产生新 id', () => {
    const a = buildContractInviteNotifications({ ...base, whitelist: ['bob'] });
    const b = buildContractInviteNotifications({ ...base, whitelist: ['bob'] });
    expect(a[0].id).toBe(b[0].id);
    expect(a[0].id).toBe('ntf_ctr_test1_bob');
  });

  it('文案按模板区分', () => {
    const gso = buildContractInviteNotifications({
      id: 'ctr_g', templateKey: 'gso', initiatorId: 'alice',
      whitelist: ['bob'], params: { gameName: '跳一跳' },
    })[0];
    expect(gso.title).toContain('收益份额认购');
    expect(gso.body).toContain('跳一跳');
    const tq = buildContractInviteNotifications({
      id: 'ctr_t', templateKey: 'team-quest', initiatorId: 'alice',
      whitelist: ['bob'], params: { questTitle: '冲榜' },
    })[0];
    expect(tq.title).toContain('组队任务');
  });

  it('meta 携带 contractId / initiatorId 供前端跳详情', () => {
    const r = buildContractInviteNotifications({ ...base, whitelist: ['bob'] })[0];
    expect(r.meta?.contractId).toBe('ctr_test1');
    expect(r.meta?.initiatorId).toBe('alice');
    expect(r.type).toBe('contract.private_invite');
  });
});
