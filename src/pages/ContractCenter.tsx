/**
 * 合约中心 /contracts（B3-B5）
 *
 * - 模板浏览（GroupBuy / TeamQuest / GSO）
 * - 发起拼团（第 1 档，完整闭环）；TeamQuest/GSO 影子模式（自动执行未开闸时 plan 只入账不动钱）
 * - 合约大厅 / 我的合约 / 详情（条款 + 事件链 + codeHash + 「验证未被篡改」）
 * - 合规话术（GSO 必须展示）
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import {
  ArrowLeft, BadgeCheck, Bell, CircleHelp, Coins, FileText, Gavel, HandCoins, Loader2,
  Plus, ShieldCheck, Users, Wrench, X,
} from 'lucide-react';
import { useAuth } from '@/contexts/authContext';
import type { AuthUser } from '@/contexts/authContext';
import {
  deployContract, fetchContractDetail, fetchContractEscrow, fetchTemplates,
  invokeContract, queryContracts, verifyContract,
  type ContractDetail, type ContractSummary, type EscrowEntry, type TemplateSummary,
} from '@/contracts/client/contractTunnel';
import {
  fetchNotifications, markNotificationsRead,
  type NotificationItem,
} from '@/contracts/client/notificationTunnel';
import { voucherItemService, type ItemVoucherTemplate } from '@/services/voucherItemService';
import { questService } from '@/services/questService';
import type { GameQuest } from '@/types/quest';

const STATE_LABEL: Record<string, string> = {
  draft: '待审核', signing: '招募中', funded: '已签署', active: '进行中',
  settling: '已结算', fulfilled: '已完成', breached: '已违约',
  disputed: '争议中', refunded: '已退款', terminated: '已终止',
};

const STATE_STYLE: Record<string, string> = {
  draft: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  signing: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
  active: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  settling: 'bg-violet-500/15 text-violet-300 border-violet-500/30',
  fulfilled: 'bg-emerald-600/20 text-emerald-300 border-emerald-600/40',
  refunded: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
  disputed: 'bg-orange-500/15 text-orange-300 border-orange-500/30',
};

function fmt(n: number | undefined): string {
  return (n ?? 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}

function fmtTime(ms: number | undefined): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function fmtDuration(ms: number | undefined): string {
  if (!ms || ms <= 0) return '无';
  const h = ms / 3600000;
  if (h < 1) return `${Math.round(ms / 60000)} 分钟`;
  if (h < 48) return `${Math.round(h)} 小时`;
  return `${Math.round(h / 24)} 天`;
}

function fmtBps(bps: number | undefined): string {
  if (!bps) return '0%';
  return `${(bps / 100).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}%`;
}

/**
 * 🆕 2026-10-20：按当前合约真实参数与成员分数，生成「扣管理费 → 按比例分配」的结算示例。
 * 有真实分数时用真实数据演示；尚无贡献时用示例分数演示。
 */
function buildPayoutExample(detail: ContractDetail): string[] {
  const p = (detail.params || {}) as Record<string, unknown>;
  const pool = Number((p.rewardPool as Record<string, unknown> | undefined)?.amount) || 0;
  const feeBps = Number(p.leaderFeeBps) || 0;
  const fee = Math.floor(pool * feeBps / 10000);
  const remaining = pool - fee;
  const lines: string[] = [];
  const contribs = (Array.isArray(detail.stateData?.contributions) ? detail.stateData.contributions : [])
    .map((c) => ({ userId: String(c?.userId || ''), amount: Number(c?.amount) || 0 }))
    .filter((c) => c.userId && c.amount > 0)
    .sort((a, b) => b.amount - a.amount);
  const totalScore = contribs.reduce((s, c) => s + c.amount, 0);

  if (pool <= 0) return ['本合约奖池为 0，结算时仅退还保证金，无分配环节。'];
  lines.push(`奖池 ${fmt(pool)} 游戏币 → 先扣团长管理费 ${fmtBps(feeBps)}（${fmt(fee)} 游戏币）→ 剩余 ${fmt(remaining)} 游戏币按贡献比例分配`);

  if (totalScore > 0 && contribs.length > 0) {
    lines.push('按当前已上报分数试算（结算时以最终分数为准）：');
    for (const c of contribs.slice(0, 5)) {
      lines.push(`  · ${c.userId}：${c.amount} 分 → 约 ${fmt(Math.floor(remaining * c.amount / totalScore))} 游戏币`);
    }
    if (contribs.length > 5) lines.push(`  · 其余 ${contribs.length - 5} 名成员同理按分数占比分配`);
    lines.push('（每人实际所得向下取整，尾差归最后一名成员）');
  } else {
    // 尚无真实贡献：用示例演示
    const ex = [{ u: '成员A', s: 60 }, { u: '成员B', s: 30 }, { u: '成员C', s: 10 }];
    lines.push('示例（假设甲 60 分、乙 30 分、丙 10 分，总分 100）：');
    for (const e of ex) {
      lines.push(`  · ${e.u}：${e.s} 分 → ${fmt(Math.floor(remaining * e.s / 100))} 游戏币`);
    }
    lines.push('（每人实际所得向下取整，尾差归最后一名成员）');
  }
  return lines;
}

function fmtRange(a: number | undefined, b: number | undefined): string {
  return `${fmtTime(a)} ~ ${fmtTime(b)}`;
}

/** 通俗条款摘要：按「双方关心的事项」组织，技术细节收进可折叠区 */
function buildPlainTerms(detail: ContractDetail): { title: string; items: string[] }[] {
  const p = (detail.params || {}) as Record<string, unknown>;
  const num = (k: string) => Number(p[k]) || 0;
  const cur = String(p.currency || 'gameCoins') === 'aCoins' ? 'A 币' : '游戏币';
  const dispute = fmtDuration(num('disputeWindowMs'));
  const escrowNote = '资金全程由平台托管账户锁定，规则指纹（codeHash）固化后任何人不可篡改。';
  const sections: { title: string; items: string[] }[] = [];

  if (detail.templateKey === 'group-buy') {
    sections.push({
      title: '💰 买什么、多少钱',
      items: [
        `拼团商品：${String(p.itemTitle || '—')}。`,
        `拼团价 ${fmt(num('groupPrice'))} ${cur}/份（单买对照价 ${fmt(num('unitPrice'))} ${cur}，相当于约 ${fmt(num('groupPrice') / Math.max(num('unitPrice'), 1) * 100)}% 的价格）。`,
        `每人限购 ${fmt(num('perUserLimit'))} 份。`,
      ],
    });
    sections.push({
      title: '👥 成团条件',
      items: [
        `凑够 ${fmt(num('minMembers'))} 人即成团，最多 ${fmt(num('maxMembers'))} 人。`,
        `成团后钱自动划给发起人（卖家）发货。`,
      ],
    });
    sections.push({
      title: '⏰ 时间期限',
      items: [
        `开团时间：${fmtTime(num('openAt'))}；截团时间：${fmtTime(num('closeAt'))}。`,
        `到截团时间人数不够 → 全额自动退款，一分不少。`,
      ],
    });
    sections.push({
      title: '🛡️ 保障与争议',
      items: [
        `交割后 ${dispute}内可以对履约问题发起挑战。`,
        escrowNote,
      ],
    });
  } else if (detail.templateKey === 'team-quest') {
    sections.push({
      title: '💰 押金与奖池',
      items: [
        `加入需交保证金 ${fmt(num('memberBond'))} ${cur}${num('memberBond') ? '（任务结束退还）' : '（本团免保证金）'}。`,
        `团长设置奖池 ${fmt(num('rewardPool') ? (p.rewardPool as Record<string, unknown>).amount : 0)} ${cur}，由团长先注入托管。`,
      ],
    });
    sections.push({
      title: '👥 组队与分工',
      items: [
        `发起人自动入团；最低 ${fmt(num('minMembers'))} 人即成队，达到最高 ${fmt(num('maxMembers'))} 人后封团（封团前可随时加入）。`,
        `贡献点数确定规则：${String(p.contributionRule || '由游戏事件上报，按占比分配奖池')}。`,
        `游戏内贡献由系统/团长按事件上报，结算时余下奖池按贡献占比自动分配。`,
      ],
    });
    sections.push({
      title: '🏦 团长管理费',
      items: [
        num('leaderFeeBps')
          ? `结算时先从奖池抽取 ${fmtBps(num('leaderFeeBps'))}（约 ${fmt(Math.floor(num('rewardPool') ? ((p.rewardPool as Record<string, unknown>).amount as number) * num('leaderFeeBps') / 10000 : 0))} ${cur}）作为团长管理费，剩余 ${fmt(Math.floor(num('rewardPool') ? ((p.rewardPool as Record<string, unknown>).amount as number) * (10000 - num('leaderFeeBps')) / 10000 : 0))} ${cur} 按贡献分配给团员。`
          : '本团不收团长管理费，奖池全额按贡献分配。',
        `零贡献兜底：全员零贡献时奖池原路退回发起人（不抽管理费）。`,
      ],
    });
    sections.push({
      title: '⏰ 时间期限',
      items: [
        `招募截止：${fmtTime(num('recruitmentDeadline'))}。`,
        `任务截止：${fmtTime(num('taskDeadline'))}，到期自动结算奖池并退还保证金。`,
      ],
    });
    sections.push({
      title: '⚠️ 违约处理',
      items: [
        num('earlyExitBps')
          ? `任务中途退出：保证金按 ${fmtBps(num('earlyExitBps'))} 的比例罚没（最多罚 ${fmt(Math.floor(num('memberBond') * num('earlyExitBps') / 10000))} ${cur}），其余退还。`
          : '中途退出不罚没，保证金全额退还。',
        `若队伍始终未达到结算条件，托管资金全额原路退回。`,
      ],
    });
    sections.push({
      title: '🛡️ 保障与争议',
      items: [`结算后 ${dispute}内可以发起挑战。`, escrowNote],
    });
  } else {
    // gso
    const hardCap = num('hardCap');
    sections.push({
      title: '💰 募多少钱',
      items: [
        `${String(p.gameName || '该游戏')} 募资目标 ${fmt(num('raiseTarget'))} ${cur}。`,
        `最低成筹额 ${fmt(num('softCap'))} ${cur}：低于这个数视为募资失败，全额退款。`,
        hardCap ? `募集上限 ${fmt(hardCap)} ${cur}（超募部分拦截）。` : `无募集上限。`,
        `单人认购上限 ${fmt(num('perUserCap'))} ${cur}。`,
      ],
    });
    sections.push({
      title: '📈 你能得到什么',
      items: [
        `游戏方出让未来收益的 ${fmtBps(num('revenueShareBps'))}：你按认购份额占比例获得分红。`,
        num('governanceShareBps') ? `同时出让 ${fmtBps(num('governanceShareBps'))} 的游戏治理投票权（仅限约定事项）。` : undefined,
        `收益来源为平台内可观测收入（道具销售/商店/内容消费），每${String(p.settlementCron) === 'monthly' ? '月' : '周'}自动分账到你持有的收益凭证。`,
      ].filter(Boolean) as string[],
    });
    sections.push({
      title: '⏰ 时间期限',
      items: [
        `开售时间：${fmtTime(num('openAt'))}；认购截止：${fmtTime(num('closeAt'))}。`,
        `认购冷静期：${fmtDuration(num('coolDownMs'))}（期间可反悔退出）。`,
        `收益凭证锁定期：${fmtDuration(num('lockupMs'))}（交割后一段时间内不可转售，防炒作）。`,
      ],
    });
    sections.push({
      title: '⚠️ 募资失败怎么办',
      items: [
        `截止时募集额未达 ${fmt(num('softCap'))} ${cur} → 全额自动原路退款，合约终止。`,
        `游戏下架/停运 → 托管余额按份额退还，已分收益不追回。`,
      ],
    });
    sections.push({
      title: '🛡️ 保障与争议',
      items: [
        `交割后 ${dispute}内可以发起挑战。`,
        escrowNote,
      ],
    });
  }
  return sections;
}

export default function ContractCenter() {
  const { currentUser } = useAuth() as unknown as { currentUser: AuthUser | null };
  const userId = currentUser?.id || '';

  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [contracts, setContracts] = useState<ContractSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<'hall' | 'mine'>('hall');
  const [showCreate, setShowCreate] = useState(false);
  const [detail, setDetail] = useState<ContractDetail | null>(null);
  const [verifyInfo, setVerifyInfo] = useState<Awaited<ReturnType<typeof verifyContract>>['data'] | null>(null);
  const [escrowEntries, setEscrowEntries] = useState<EscrowEntry[]>([]);
  const [busy, setBusy] = useState(false);
  // TeamQuest 贡献上报 / GSO 认购输入
  const [progressInput, setProgressInput] = useState({ targetUserId: '', points: '' });
  const [subscribeAmount, setSubscribeAmount] = useState('');
  const [showHelp, setShowHelp] = useState(false);
  const [showTech, setShowTech] = useState(false);
  // 🆕 私域邀请私信（铃铛 + 未读徽章 + 下拉列表）
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [showNotif, setShowNotif] = useState(false);

  // 发起表单（三模板共用一个对话框，type 切换）
  const [createType, setCreateType] = useState<'group-buy' | 'team-quest' | 'gso'>('group-buy');
  // 任务广场进行中任务（team-quest 表单下拉可关联）
  const [plazaQuests, setPlazaQuests] = useState<GameQuest[]>([]);
  useEffect(() => {
    if (!showCreate || createType !== 'team-quest') return;
    questService.listQuests(undefined, 'open')
      .then(setPlazaQuests)
      .catch(() => setPlazaQuests([]));
  }, [showCreate, createType]);
  const [form, setForm] = useState({
    // group-buy
    itemTitle: '', unitPrice: 100, groupPrice: 80,
    minMembers: 3, maxMembers: 5, closeInHours: 48, perUserLimit: 1,
    skuId: '',
    initiatorJoin: false, // 🆕 2026-10-16：发起人同时加入（按成团价付款）
    // team-quest
    questTitle: '', tqMin: 2, tqMax: 5, bond: 100, poolAmount: 500, taskInHours: 72,
    questIdLink: '',
    tqLeaderFeeBps: 500, // 团长管理费（bps），默认 5%
    tqContributionRule: '贡献点数由游戏内任务事件自动上报；团长可代报、成员可自报，最终按贡献占比分池。',
    // gso
    gameId: '', gameName: '', raiseTarget: 10000, revenueShareBps: 3000, softCap: 3000, perUserCap: 5000,
    // 🆕 2026-10-15：store_sale/content_consume 记账点已落地，四来源全部可选
    gsoSources: ['market_commission', 'item_sale', 'store_sale', 'content_consume'] as string[],
    // 私域合约（三模板通用）
    whitelistEnabled: false, whitelistText: '',
  });

  // 拼团 skuId 履约下拉：全平台在架道具凭证模板（skuId = 模板 ID 时成团即按模板履约）
  const [skuTemplates, setSkuTemplates] = useState<ItemVoucherTemplate[]>([]);
  useEffect(() => {
    try { setSkuTemplates(voucherItemService.getAllActiveItemTemplates()); } catch { /* 本地存储不可用 */ }
  }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    const [t, c] = await Promise.all([fetchTemplates(), queryContracts({})]);
    if (t.ok) setTemplates(t.data?.templates || []);
    if (c.ok) setContracts(c.data?.contracts || []);
    setLoading(false);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // 🐛 修复：「我的合约」此前只按发起人过滤 → 参与认购的合约不显示。
  // 现纳入 contributions 中出现过的用户（认购记录在 stateData，query 接口已返回）。
  const visible = tab === 'mine'
    ? contracts.filter((c) =>
        c.initiatorId === userId ||
        (Array.isArray(c.stateData?.contributions) &&
          (c.stateData.contributions as Array<{ userId?: string }>).some((u) => u?.userId === userId)))
    : contracts;

  const openDetail = useCallback(async (id: string) => {
    const [d, e] = await Promise.all([fetchContractDetail(id), fetchContractEscrow(id)]);
    if (d.ok) setDetail(d.data?.contract || null);
    if (e.ok) setEscrowEntries(e.data?.entries || []);
    const v = await verifyContract(id);
    setVerifyInfo(v.ok ? v.data : null);
  }, []);

  // 🆕 私域邀请私信：挂载拉取 + 60s 轮询（与合约列表刷新节奏一致；不做长连接推送）
  const loadNotifications = useCallback(async () => {
    if (!userId) return;
    const r = await fetchNotifications(50);
    if (r.ok) {
      setNotifications(r.data?.notifications || []);
      setUnreadCount(r.data?.unreadCount || 0);
    }
  }, [userId]);

  useEffect(() => {
    void loadNotifications();
    const t = setInterval(() => { void loadNotifications(); }, 60_000);
    return () => clearInterval(t);
  }, [loadNotifications]);

  const handleNotificationClick = useCallback(async (n: NotificationItem) => {
    setShowNotif(false);
    if (!n.read) {
      void markNotificationsRead([n.id]);
      setUnreadCount((c) => Math.max(0, c - 1));
      setNotifications((list) => list.map((x) => (x.id === n.id ? { ...x, read: true } : x)));
    }
    const contractId = n.meta?.contractId;
    if (contractId) void openDetail(contractId);
  }, [openDetail]);

  const handleJoin = useCallback(async (c: ContractSummary) => {
    setBusy(true);
    const triggerId = `join_${c.id}_${userId}_${Date.now()}`;
    const r = await invokeContract(c.id, 'join', { userId }, triggerId);
    setBusy(false);
    if (r.ok) {
      toast.success('已加入拼团，货款已进平台托管');
      void reload();
      void openDetail(c.id);
    } else {
      toast.error(r.error || '加入失败');
    }
  }, [userId, reload, openDetail]);

  const handleReportProgress = useCallback(async (contractId: string) => {
    if (!progressInput.targetUserId.trim() || progressInput.points === '') return toast.error('请填写成员 ID 与分数');
    setBusy(true);
    const triggerId = `proto_${contractId}_${Date.now()}`;
    const r = await invokeContract(contractId, '__protocol', {
      targetUserId: progressInput.targetUserId.trim(),
      points: Number(progressInput.points),
    }, triggerId);
    setBusy(false);
    if (r.ok) {
      toast.success(`已上报：${progressInput.targetUserId.trim()} +${progressInput.points}`);
      setProgressInput({ targetUserId: '', points: '' });
      void openDetail(contractId);
    } else {
      toast.error(r.error || '上报失败');
    }
  }, [progressInput, openDetail]);

  // 🆕 2026-10-18：团长注入奖池（此前模板有 fund-pool 条款但 UI 从未提供入口）
  const handleFundPool = useCallback(async (contractId: string) => {
    setBusy(true);
    const triggerId = `fund_${contractId}_${Date.now()}`;
    const r = await invokeContract(contractId, 'fund-pool', {}, triggerId);
    setBusy(false);
    if (r.ok) {
      toast.success('奖池已注入平台托管');
      void reload();
      void openDetail(contractId);
    } else {
      toast.error(r.error || '注入奖池失败');
    }
  }, [reload, openDetail]);

  // 🆕 2026-10-20：团长手动成团（人数已达最低开团人数时可提前开团）
  const handleManualOpen = useCallback(async (contractId: string) => {
    setBusy(true);
    const triggerId = `open_${contractId}_${Date.now()}`;
    const r = await invokeContract(contractId, 'open-team', {}, triggerId);
    setBusy(false);
    if (r.ok) {
      toast.success('已手动成团，任务开始（可注入奖池并上报贡献）');
      void reload();
      void openDetail(contractId);
    } else {
      toast.error(r.error || '手动成团失败');
    }
  }, [reload, openDetail]);

  const handleSubscribe = useCallback(async (contractId: string) => {
    const amount = Number(subscribeAmount);
    if (!Number.isFinite(amount) || amount <= 0) return toast.error('请填写认购金额');
    // 🐛 客户端预检：给出明确的超额原因（否则条款拒绝只报笼统的"条件未满足"）
    const d = detail;
    if (d && d.id === contractId) {
      const mine = (Array.isArray(d.stateData?.contributions) ? d.stateData.contributions : [])
        .filter((c: any) => c && c.userId === userId)
        .reduce((s: number, c: any) => s + (Number(c.amount) || 0), 0);
      const perUserCap = Number(d.params?.perUserCap) || Infinity;
      if (mine + amount > perUserCap) {
        return toast.error(`超出单人认购上限：已认购 ${fmt(mine)} + 本次 ${fmt(amount)} > 上限 ${fmt(perUserCap)}，最多还可认购 ${fmt(Math.max(perUserCap - mine, 0))}`);
      }
      const raised = Number(d.stateData?.totalRaised) || 0;
      const hardCap = Number(d.params?.hardCap);
      if (Number.isFinite(hardCap) && raised + amount > hardCap) {
        return toast.error(`超出募集上限：已募集 ${fmt(raised)} + 本次 ${fmt(amount)} > 上限 ${fmt(hardCap)}`);
      }
    }
    setBusy(true);
    const triggerId = `sub_${contractId}_${userId}_${Date.now()}`;
    const r = await invokeContract(contractId, 'subscribe', { amount }, triggerId);
    setBusy(false);
    if (r.ok) {
      toast.success(`认购成功：${fmt(amount)} 游戏币已进托管`);
      setSubscribeAmount('');
      void reload();
      void openDetail(contractId);
    } else {
      toast.error(r.error || '认购失败');
    }
  }, [subscribeAmount, userId, detail, reload, openDetail]);

  const handleCreate = useCallback(async () => {
    if (!userId) {
      toast.error('请先登录');
      return;
    }
    const now = Date.now();
    // 🆕 私域名单解析（三模板通用）：逗号/分号/空白分隔，去重上限 500
    const whitelist = form.whitelistEnabled
      ? Array.from(new Set(form.whitelistText.split(/[\n,，;；\s]+/).map(s => s.trim()).filter(Boolean)))
      : [];
    if (form.whitelistEnabled && whitelist.length === 0) {
      return toast.error('已开启私域：请填写至少一个成员 ID');
    }
    if (whitelist.length > 500) {
      return toast.error(`私域名单上限 500 人（当前 ${whitelist.length}）`);
    }
    const wlArg = whitelist.length > 0 ? whitelist : undefined;
    let r;
    if (createType === 'group-buy') {
      if (!form.itemTitle.trim()) return toast.error('请填写拼团商品名');
      if (form.groupPrice >= form.unitPrice) return toast.error('成团价应低于单买价');
      // 履约校验：skuId 非空必须是真实在架的道具凭证模板 ID（成团后按模板铸造履约凭证）
      const sku = form.skuId.trim();
      if (sku && !voucherItemService.getItemTemplate(sku)) {
        return toast.error('skuId 不是有效的道具凭证模板 ID——请从下拉选择，或留空仅作记录');
      }
      setBusy(true);
      r = await deployContract('group-buy', {
        itemTitle: form.itemTitle.trim(),
        skuId: sku || undefined,
        initiatorId: userId,
        unitPrice: form.unitPrice,
        groupPrice: form.groupPrice,
        minMembers: form.minMembers,
        maxMembers: Math.max(form.maxMembers, form.minMembers),
        openAt: now,
        closeAt: now + form.closeInHours * 3600 * 1000,
        currency: 'gameCoins',
        perUserLimit: form.perUserLimit,
        disputeWindowMs: 72 * 3600 * 1000,
      }, undefined, wlArg);
    } else if (createType === 'team-quest') {
      if (!form.questTitle.trim()) return toast.error('请填写任务标题');
      if (!form.tqContributionRule.trim()) return toast.error('请填写贡献点数确定规则（将写入合约条款）');
      setBusy(true);
      r = await deployContract('team-quest', {
        // P3（2026-10-15）：优先关联真实 GameQuest 任务 ID；未填则回退占位 ID
        questId: form.questIdLink.trim() || `quest_${now}`,
        initiatorId: userId,
        questTitle: form.questTitle.trim(),
        minMembers: form.tqMin,
        maxMembers: Math.max(form.tqMax, form.tqMin),
        recruitmentDeadline: now + 24 * 3600 * 1000,
        taskDeadline: now + form.taskInHours * 3600 * 1000,
        rewardPool: { amount: form.poolAmount, currency: 'gameCoins' },
        memberBond: form.bond,
        earlyExitBps: 2000,
        // 🆕 2026-10-18：团长管理费 + 贡献规则写入合约（codeHash 固化不可篡改）
        leaderFeeBps: form.tqLeaderFeeBps,
        contributionRule: form.tqContributionRule.trim(),
        protocolEvent: 'GAME_EVENT:SCORE',
        disputeWindowMs: 72 * 3600 * 1000,
      }, undefined, wlArg);
    } else {
      if (!form.gameId.trim() || !form.gameName.trim()) return toast.error('请填写关联游戏');
      setBusy(true);
      r = await deployContract('gso', {
        gameId: form.gameId.trim(),
        issuerId: userId,
        gameName: form.gameName.trim(),
        raiseTarget: form.raiseTarget,
        currency: 'gameCoins',
        revenueShareBps: form.revenueShareBps,
        governanceShareBps: 3000,
        openAt: now,
        closeAt: now + form.closeInHours * 3600 * 1000,
        softCap: form.softCap,
        perUserCap: form.perUserCap,
        coolDownMs: 0,
        lockupMs: 30 * 24 * 3600 * 1000,
        // 2026-10-15：store_sale/content_consume 记账点已落地（gso-revenue 端点），四来源按勾选透传
        revenueSources: form.gsoSources.length > 0 ? form.gsoSources : ['market_commission', 'item_sale'],
        settlementCron: 'weekly',
        governableTopics: ['ADJUST_PRICE', 'GAME_CONFIG', 'MINT_CURRENCY'],
        disputeWindowMs: 72 * 3600 * 1000,
      }, undefined, wlArg);
    }
    // 🆕 2026-10-16：发起人可选加入（按成团价付款后计入 memberCount；min=max 时满员即交割）
    if (r?.ok && createType === 'group-buy' && form.initiatorJoin && r.data?.contractId) {
      const j = await invokeContract(r.data.contractId, 'join', {}, `join_${r.data.contractId}_${userId}`);
      if (j.ok) {
        toast.success('已作为发起人加入拼团并支付成团价');
      } else {
        toast.error(`发起人加入失败：${j.error || '未知错误'}（合约已创建，可到详情手动加入）`);
      }
    }
    setBusy(false);
    if (r?.ok) {
      const state = r.data?.state;
      toast.success(
        state === 'draft' ? '合约已提交，待平台审核（GSO 需审核后进入招募）' : '合约已部署，进入招募中',
      );
      setShowCreate(false);
      void reload();
    } else if (r) {
      toast.error(r.error || '部署失败');
    }
  }, [userId, form, createType, reload]);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="border-b border-slate-800 bg-slate-950/80 px-4 py-4 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-3">
          <Link to="/game-center" className="rounded-lg p-2 hover:bg-slate-800" aria-label="返回">
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <Gavel className="h-6 w-6 text-emerald-400" />
          <h1 className="text-lg font-bold">合约中心</h1>
          <span className="hidden rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-300 lg:inline">
            平台保证合约按公布的规则执行，不保证任何收益结果
          </span>
          <div className="ml-auto flex items-center gap-2">
            {/* 🆕 私域邀请私信铃铛 */}
            <div className="relative">
              <button
                onClick={() => { setShowNotif((v) => !v); if (!showNotif) void loadNotifications(); }}
                className="relative flex items-center rounded-lg border border-indigo-500/40 bg-indigo-500/10 px-3 py-1.5 text-sm text-indigo-300 hover:bg-indigo-500/20"
                aria-label="私信通知"
              >
                <Bell className="h-4 w-4" />
                {unreadCount > 0 && (
                  <span className="absolute -right-1.5 -top-1.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-bold text-white">
                    {unreadCount > 99 ? '99+' : unreadCount}
                  </span>
                )}
              </button>
              {showNotif && (
                <>
                {/* 点外部关闭 */}
                <div className="fixed inset-0 z-40" onClick={() => setShowNotif(false)} />
                <div className="absolute right-0 top-11 z-50 w-80 rounded-xl border border-slate-700 bg-slate-900 shadow-2xl">
                  <div className="flex items-center justify-between border-b border-slate-800 px-4 py-2.5">
                    <span className="text-sm font-semibold">私信</span>
                    {unreadCount > 0 && (
                      <button
                        onClick={() => { void markNotificationsRead(); void loadNotifications(); }}
                        className="text-xs text-indigo-300 hover:text-indigo-200"
                      >
                        全部已读
                      </button>
                    )}
                  </div>
                  <div className="max-h-80 overflow-y-auto">
                    {notifications.length === 0 && (
                      <div className="px-4 py-6 text-center text-sm text-slate-500">暂无私信</div>
                    )}
                    {notifications.map((n) => (
                      <button
                        key={n.id}
                        onClick={() => void handleNotificationClick(n)}
                        className={`block w-full border-b border-slate-800/60 px-4 py-3 text-left transition hover:bg-slate-800/60 ${n.read ? '' : 'bg-indigo-500/5'}`}
                      >
                        <div className="flex items-center gap-2">
                          {!n.read && <span className="h-2 w-2 shrink-0 rounded-full bg-indigo-400" />}
                          <span className="truncate text-sm font-medium text-slate-100">{n.title}</span>
                        </div>
                        <div className="mt-0.5 line-clamp-2 text-xs text-slate-400">{n.body}</div>
                        <div className="mt-1 text-[10px] text-slate-500">{fmtTime(n.createdAt)}</div>
                      </button>
                    ))}
                  </div>
                </div>
                </>
              )}
            </div>
            <button
              onClick={() => setShowHelp(true)}
              className="flex items-center gap-1 rounded-lg border border-sky-500/40 bg-sky-500/10 px-3 py-1.5 text-sm text-sky-300 hover:bg-sky-500/20"
            >
              <CircleHelp className="h-4 w-4" /> 操作指南
            </button>
            <button
              onClick={() => setTab('hall')}
              className={`rounded-lg px-3 py-1.5 text-sm ${tab === 'hall' ? 'bg-emerald-600' : 'bg-slate-800 hover:bg-slate-700'}`}
            >
              合约大厅
            </button>
            <button
              onClick={() => setTab('mine')}
              className={`rounded-lg px-3 py-1.5 text-sm ${tab === 'mine' ? 'bg-emerald-600' : 'bg-slate-800 hover:bg-slate-700'}`}
            >
              我的合约
            </button>
            <Link
              to="/contract-workshop"
              className="flex items-center gap-1 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium hover:bg-indigo-500"
            >
              <Wrench className="h-4 w-4" /> 合约工坊
            </Link>
            <button
              onClick={() => setShowCreate(true)}
              className="flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium hover:bg-emerald-500"
            >
              <Plus className="h-4 w-4" /> 发起拼团
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-6 px-4 py-6">
        {/* 模板卡片 */}
        <section className="grid gap-4 md:grid-cols-3">
          {templates.map((t) => (
            <div key={t.key} className="rounded-xl border border-slate-800 bg-slate-900 p-4">
              <div className="mb-2 flex items-center gap-2">
                {t.key === 'group-buy' && <HandCoins className="h-5 w-5 text-sky-400" />}
                {t.key === 'team-quest' && <Users className="h-5 w-5 text-emerald-400" />}
                {t.key === 'gso' && <Coins className="h-5 w-5 text-amber-400" />}
                <h3 className="font-semibold">{t.title}</h3>
                <span className={`ml-auto rounded-full border px-2 py-0.5 text-xs ${t.autoExecute ? 'border-emerald-500/40 text-emerald-300' : 'border-slate-600 text-slate-400'}`}>
                  {t.autoExecute ? '自动执行已开闸' : '影子模式'}
                </span>
              </div>
              <p className="text-sm text-slate-400">{t.description}</p>
            </div>
          ))}
          {templates.length === 0 && !loading && (
            <div className="col-span-3 rounded-xl border border-slate-800 bg-slate-900 p-6 text-center text-slate-500">
              暂无可用模板（后端未启用或网络异常）
            </div>
          )}
        </section>

        {/* 合约列表 */}
        <section className="space-y-3">
          {loading && <div className="flex items-center gap-2 text-slate-400"><Loader2 className="h-4 w-4 animate-spin" /> 加载中…</div>}
          {!loading && visible.length === 0 && (
            <div className="rounded-xl border border-slate-800 bg-slate-900 p-8 text-center text-slate-500">
              {tab === 'mine' ? '你还没有发起过合约' : '暂无进行中的合约，点右上角「发起拼团」创建第一个'}
            </div>
          )}
          {visible.map((c) => {
            const members = Number(c.stateData?.memberCount) || 0;
            const minM = Number(c.params?.minMembers) || 0;
            const maxM = Number(c.params?.maxMembers) || 0;
            const progress = maxM > 0 ? Math.min(100, Math.round((members / maxM) * 100)) : 0;
            return (
              <div key={c.id} className="rounded-xl border border-slate-800 bg-slate-900 p-4 transition hover:border-slate-700">
                <div className="flex flex-wrap items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{c.params?.itemTitle || c.templateKey}</span>
                      <span className={`rounded-full border px-2 py-0.5 text-xs ${STATE_STYLE[c.state] || 'border-slate-600 text-slate-400'}`}>
                        {STATE_LABEL[c.state] || c.state}
                      </span>
                      {!c.autoExecute && (
                        <span className="rounded-full border border-slate-700 px-2 py-0.5 text-xs text-slate-400">影子</span>
                      )}
                      {Array.isArray(c.whitelist) && c.whitelist.length > 0 && (
                        <span className="rounded-full border border-indigo-500/50 bg-indigo-500/10 px-2 py-0.5 text-xs text-indigo-300">
                          私域 · {c.whitelist.length} 人
                        </span>
                      )}
                    </div>
                    <div className="mt-1 text-xs text-slate-500">
                      {c.templateKey} · 发起人 {c.initiatorId} · {fmtTime(c.createdAt)}
                      {c.params?.groupPrice ? ` · 成团价 ${fmt(c.params.groupPrice)} 游戏币` : ''}
                    </div>
                  </div>
                  <div className="w-40">
                    <div className="h-2 overflow-hidden rounded-full bg-slate-800">
                      <div className="h-full rounded-full bg-emerald-500" style={{ width: `${progress}%` }} />
                    </div>
                    <div className="mt-1 text-xs text-slate-500">{members}/{maxM} 人（最低 {minM}）</div>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => void openDetail(c.id)}
                      className="rounded-lg bg-slate-800 px-3 py-1.5 text-sm hover:bg-slate-700"
                    >
                      详情
                    </button>
                    {/* 🐛 修复：GSO 合约无 join 触发器（认购走 subscribe 且需金额输入），
                        大厅卡片「加入」对 GSO 会报「无匹配条款」→ 改为仅拼团/组团显示，GSO 请进详情页认购 */}
                    {c.state === 'signing' && c.initiatorId !== userId && c.templateKey !== 'gso' && (
                      (() => {
                        // 🆕 私域门禁：名单外成员按钮禁用并提示（服务端仍会兜底校验）
                        const blocked = Array.isArray(c.whitelist) && c.whitelist.length > 0 && !c.whitelist.includes(userId);
                        return (
                          <button
                            disabled={busy || blocked}
                            title={blocked ? '私域合约：仅名单内成员可参与' : undefined}
                            onClick={() => void handleJoin(c)}
                            className="flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            <HandCoins className="h-4 w-4" /> {blocked ? '名单外' : '加入'}
                          </button>
                        );
                      })()
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </section>
      </main>

      {/* 发起拼团 */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" role="dialog" aria-modal="true">
          <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-slate-800 bg-slate-900 p-6">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-lg font-bold"><HandCoins className="h-5 w-5 text-sky-400" /> 发起合约</h2>
              <button onClick={() => setShowCreate(false)} className="rounded-lg p-1 hover:bg-slate-800" aria-label="关闭">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="mb-3 flex gap-2">
              {([['group-buy', '拼团'], ['team-quest', '组团任务'], ['gso', 'GSO 认购']] as const).map(([k, label]) => (
                <button
                  key={k}
                  onClick={() => setCreateType(k)}
                  className={`rounded-lg px-3 py-1.5 text-sm ${createType === k ? 'bg-emerald-600' : 'bg-slate-800 hover:bg-slate-700'}`}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="space-y-3 text-sm">
              {createType === 'group-buy' && (
              <>
              <label className="block">
                <span className="text-slate-400">拼团商品名</span>
                <input
                  className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 outline-none focus:border-emerald-500"
                  value={form.itemTitle}
                  onChange={(e) => setForm({ ...form, itemTitle: e.target.value })}
                  placeholder="例：传奇皮肤包"
                />
              </label>
              <label className="block">
                <span className="text-slate-400">履约商品（skuId，可选——选择道具凭证模板，成团即履约）</span>
                <select
                  className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 outline-none focus:border-emerald-500"
                  value={form.skuId}
                  onChange={(e) => setForm({ ...form, skuId: e.target.value })}
                >
                  <option value="">不关联（仅随凭证记录）</option>
                  {skuTemplates.map(t => (
                    <option key={t.id} value={t.id}>
                      {t.name || t.id}（{t.gameId}，{t.pricing?.price ?? '?'} {t.pricing?.currency === 'aCoins' ? 'A币' : '游戏币'}）
                    </option>
                  ))}
                </select>
                <span className="mt-1 block text-xs text-slate-500">成团后每位成员自动获得履约凭证（gbr），skuId 关联道具凭证时成团即自动发货到成员背包（平台池库存扣减）。</span>
              </label>
              {/* 🆕 2026-10-16：发起人可选加入 */}
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  checked={form.initiatorJoin}
                  onChange={(e) => setForm({ ...form, initiatorJoin: e.target.checked })}
                />
                <span className="text-slate-300">发起人同时加入拼团（部署后立即按成团价付款，计入成员数）</span>
              </label>
              {form.initiatorJoin && (
                <p className="-mt-1 text-xs text-slate-500">
                  注意：发起人此前不计入成员数，勾选后会立即支付 {fmt(form.groupPrice)} 游戏币进托管；若最低成团人数-1 名成员到齐即成团。
                </p>
              )}
              </>
              )}
              {createType === 'team-quest' && (
              <>
              <label className="block">
                <span className="text-slate-400">任务标题</span>
                <input
                  className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 outline-none focus:border-emerald-500"
                  value={form.questTitle}
                  onChange={(e) => setForm({ ...form, questTitle: e.target.value })}
                  placeholder="例：组队刷副本拿奖励"
                />
              </label>
              <label className="block">
                <span className="text-slate-400">关联任务广场任务（可选，选择后成员完成任务广场任务即履约）</span>
                <select
                  className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 outline-none focus:border-emerald-500"
                  value={form.questIdLink}
                  onChange={(e) => {
                    const qid = e.target.value;
                    const q = plazaQuests.find(x => x.id === qid);
                    setForm({ ...form, questIdLink: qid, questTitle: q ? `${q.title}（组团）` : form.questTitle });
                  }}
                >
                  <option value="">— 不关联任务（自由组队）—</option>
                  {plazaQuests.map((q) => (
                    <option key={q.id} value={q.id}>#{q.id} · {q.title}（{q.gameName || q.gameId}）</option>
                  ))}
                </select>
                {plazaQuests.length === 0 && (
                  <span className="mt-1 block text-xs text-slate-500">暂无可关联的进行中任务——可先到任务广场发布，或复制任务卡片上的编号手动填写。</span>
                )}
              </label>
              <label className="block">
                <span className="text-slate-400">或手动输入任务编号（任务广场任务卡片上的 #编号）</span>
                <input
                  className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 outline-none focus:border-emerald-500"
                  value={form.questIdLink}
                  onChange={(e) => setForm({ ...form, questIdLink: e.target.value })}
                  placeholder="例：quest_xxx；留空则仅作自由组队（不挂任务系统）"
                />
              </label>
              </>
              )}
              {createType === 'gso' && (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <label className="block">
                    <span className="text-slate-400">关联游戏 ID</span>
                    <input className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2"
                      value={form.gameId} onChange={(e) => setForm({ ...form, gameId: e.target.value })} placeholder="game-xxx" />
                  </label>
                  <label className="block">
                    <span className="text-slate-400">游戏名称</span>
                    <input className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2"
                      value={form.gameName} onChange={(e) => setForm({ ...form, gameName: e.target.value })} placeholder="例：赌石小游戏" />
                  </label>
                </div>
                <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-300">
                  GSO 需平台审核通过后进入招募；收益仅纳入平台可观测收益（市场佣金/内容消费/商店/道具销售），
                  到期达标自动交割并按认购份额铸收益分成凭证（RSV，带锁定期）。平台保证规则执行，不保证收益结果。
                </p>
              </>
              )}
              {createType === 'group-buy' && (
              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="text-slate-400">单买价（游戏币）</span>
                  <input type="number" min={1} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2"
                    value={form.unitPrice} onChange={(e) => setForm({ ...form, unitPrice: Number(e.target.value) || 0 })} />
                </label>
                <label className="block">
                  <span className="text-slate-400">成团价（游戏币）</span>
                  <input type="number" min={1} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2"
                    value={form.groupPrice} onChange={(e) => setForm({ ...form, groupPrice: Number(e.target.value) || 0 })} />
                </label>
                <label className="block">
                  <span className="text-slate-400">最低成团人数</span>
                  <input type="number" min={2} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2"
                    value={form.minMembers} onChange={(e) => setForm({ ...form, minMembers: Number(e.target.value) || 2 })} />
                </label>
                <label className="block">
                  <span className="text-slate-400">人数上限</span>
                  <input type="number" min={2} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2"
                    value={form.maxMembers} onChange={(e) => setForm({ ...form, maxMembers: Number(e.target.value) || 2 })} />
                </label>
                <label className="block">
                  <span className="text-slate-400">截团（小时后）</span>
                  <input type="number" min={1} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2"
                    value={form.closeInHours} onChange={(e) => setForm({ ...form, closeInHours: Number(e.target.value) || 48 })} />
                </label>
                <label className="block">
                  <span className="text-slate-400">每人限购</span>
                  <input type="number" min={1} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2"
                    value={form.perUserLimit} onChange={(e) => setForm({ ...form, perUserLimit: Number(e.target.value) || 1 })} />
                </label>
              </div>
              )}
              {createType === 'team-quest' && (
              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="text-slate-400">最低开团人数</span>
                  <input type="number" min={2} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2"
                    value={form.tqMin} onChange={(e) => setForm({ ...form, tqMin: Number(e.target.value) || 2 })} />
                </label>
                <label className="block">
                  <span className="text-slate-400">人数上限</span>
                  <input type="number" min={2} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2"
                    value={form.tqMax} onChange={(e) => setForm({ ...form, tqMax: Number(e.target.value) || 2 })} />
                </label>
                <label className="block">
                  <span className="text-slate-400">团员保证金（游戏币）</span>
                  <input type="number" min={0} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2"
                    value={form.bond} onChange={(e) => setForm({ ...form, bond: Number(e.target.value) || 0 })} />
                </label>
                <label className="block">
                  <span className="text-slate-400">奖池（游戏币）</span>
                  <input type="number" min={0} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2"
                    value={form.poolAmount} onChange={(e) => setForm({ ...form, poolAmount: Number(e.target.value) || 0 })} />
                </label>
                <label className="block">
                  <span className="text-slate-400">任务时长（小时）</span>
                  <input type="number" min={1} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2"
                    value={form.taskInHours} onChange={(e) => setForm({ ...form, taskInHours: Number(e.target.value) || 72 })} />
                </label>
                {/* 🆕 2026-10-18：团长管理费（自下而上抽成，写入合约） */}
                <label className="block">
                  <span className="text-slate-400">团长管理费（结算时从奖池抽取）</span>
                  <select className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2"
                    value={form.tqLeaderFeeBps} onChange={(e) => setForm({ ...form, tqLeaderFeeBps: Number(e.target.value) })}>
                    <option value={0}>0%（不抽成）</option>
                    <option value={300}>3%</option>
                    <option value={500}>5%（默认）</option>
                    <option value={800}>8%</option>
                    <option value={1000}>10%</option>
                  </select>
                </label>
                <label className="block col-span-2">
                  <span className="text-slate-400">贡献点数确定规则（写入合约条款，codeHash 固化后不可篡改）</span>
                  <input className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2"
                    value={form.tqContributionRule} onChange={(e) => setForm({ ...form, tqContributionRule: e.target.value })} />
                </label>
                <div className="col-span-2 rounded-lg bg-slate-950 p-2 text-xs text-slate-500">
                  发起人自动入团；达到最低人数即开团，最高 {form.tqMax} 人封团；中途退出罚没 20%；贡献由游戏事件上报（强制 channelToken）；截止自动结算：先抽团长管理费（{form.tqLeaderFeeBps / 100}%），余下奖池按贡献分配+退保证金
                </div>
              </div>
              )}
              {createType === 'gso' && (
              <>
              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="text-slate-400">募资目标（游戏币）</span>
                  <input type="number" min={1} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2"
                    value={form.raiseTarget} onChange={(e) => setForm({ ...form, raiseTarget: Number(e.target.value) || 1 })} />
                </label>
                <label className="block">
                  <span className="text-slate-400">出让收益比例 %</span>
                  <input type="number" min={1} max={100} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2"
                    value={form.revenueShareBps / 100} onChange={(e) => setForm({ ...form, revenueShareBps: Math.round((Number(e.target.value) || 1) * 100) })} />
                </label>
                <label className="block">
                  <span className="text-slate-400">最低成筹额（softCap）</span>
                  <input type="number" min={1} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2"
                    value={form.softCap} onChange={(e) => setForm({ ...form, softCap: Number(e.target.value) || 1 })} />
                </label>
                <label className="block">
                  <span className="text-slate-400">单人认购上限</span>
                  <input type="number" min={1} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2"
                    value={form.perUserCap} onChange={(e) => setForm({ ...form, perUserCap: Number(e.target.value) || 1 })} />
                </label>
                <label className="block">
                  <span className="text-slate-400">认购截止（小时后）</span>
                  <input type="number" min={1} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2"
                    value={form.closeInHours} onChange={(e) => setForm({ ...form, closeInHours: Number(e.target.value) || 48 })} />
                </label>
              </div>
              {/* 🆕 2026-10-15：四来源记账点均已落地，按勾选计入分账基数 */}
              <div className="mt-3 rounded-lg border border-slate-700 bg-slate-950/50 p-3">
                <div className="mb-2 text-xs text-slate-400">计入分账的收益来源（服务端 revenue_ledger 事实源，全选 = 最完整口径）</div>
                <div className="grid grid-cols-2 gap-2">
                  {([
                    ['market_commission', '市场佣金'],
                    ['item_sale', '道具销售'],
                    ['store_sale', '商店销售'],
                    ['content_consume', '内容按次消费'],
                  ] as const).map(([key, label]) => (
                    <label key={key} className="flex cursor-pointer items-center gap-2">
                      <input
                        type="checkbox"
                        checked={form.gsoSources.includes(key)}
                        onChange={(e) => setForm({
                          ...form,
                          gsoSources: e.target.checked
                            ? [...form.gsoSources, key]
                            : form.gsoSources.filter(s => s !== key),
                        })}
                      />
                      <span className="text-slate-300">{label}</span>
                    </label>
                  ))}
                </div>
              </div>
              </>
              )}
              {/* 🆕 私域合约（三模板通用） */}
              <div className="rounded-lg border border-slate-700 bg-slate-950/50 p-3">
                <label className="flex cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    checked={form.whitelistEnabled}
                    onChange={(e) => setForm({ ...form, whitelistEnabled: e.target.checked })}
                  />
                  <span className="text-slate-300">私域合约 —— 仅名单内成员可参与（认购 / 加入）</span>
                </label>
                {form.whitelistEnabled && (
                  <>
                    <textarea
                      rows={3}
                      className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
                      value={form.whitelistText}
                      onChange={(e) => setForm({ ...form, whitelistText: e.target.value })}
                      placeholder={'成员 ID，逗号 / 分号 / 换行分隔，例：\ntest-001, test-002\n小明'}
                    />
                    <p className="mt-1 text-xs text-slate-500">
                      发起人自动豁免（可开团 / 可管理）；名单外成员在大厅可见该合约但无法认购或加入；上限 500 人。不勾选 = 公开合约（大厅招募）。
                    </p>
                  </>
                )}
              </div>
              <p className="rounded-lg border border-slate-800 bg-slate-950 p-3 text-xs text-slate-500">
                {createType === 'group-buy'
                  ? '规则按公开条款执行（codeHash 固化后不可篡改）：满员或到期达标自动交割给发起人；未达标全额自动退款；交割后 72 小时内可发起挑战。资金全程由平台托管账户锁定。'
                  : createType === 'team-quest'
                    ? '规则按公开条款执行（codeHash 固化后不可篡改）：保证金与奖池分开托管；截止自动按贡献占比分配奖池并退还保证金；中途退出按比例罚没。'
                    : '规则按公开条款执行（codeHash 固化后不可篡改）：未达 softCap 全额自动退款；达标自动交割并铸收益分成凭证；收益按份额自动分账。'}
              </p>
              <button
                disabled={busy}
                onClick={() => void handleCreate()}
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-600 py-2.5 font-medium hover:bg-emerald-500 disabled:opacity-50"
              >
                {busy && <Loader2 className="h-4 w-4 animate-spin" />} 部署合约
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 合约详情 */}
      {detail && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" role="dialog" aria-modal="true">
          <div className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-slate-800 bg-slate-900 p-6">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-lg font-bold">
                <FileText className="h-5 w-5 text-emerald-400" />
                {detail.params?.itemTitle || detail.templateKey}
                <span className={`rounded-full border px-2 py-0.5 text-xs ${STATE_STYLE[detail.state] || ''}`}>
                  {STATE_LABEL[detail.state] || detail.state}
                </span>
              </h2>
              <button onClick={() => { setDetail(null); setVerifyInfo(null); }} className="rounded-lg p-1 hover:bg-slate-800" aria-label="关闭">
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* 验证状态 */}
            <div className="mb-4 rounded-xl border border-slate-800 bg-slate-950 p-4 text-sm">
              <div className="flex items-center gap-2">
                {verifyInfo?.intact
                  ? <><BadgeCheck className="h-5 w-5 text-emerald-400" /><span className="font-medium text-emerald-300">验证未被篡改</span></>
                  : <><ShieldCheck className="h-5 w-5 text-rose-400" /><span className="font-medium text-rose-300">完整性校验未通过</span></>}
              </div>
              <div className="mt-2 break-all font-mono text-xs text-slate-500">codeHash: {detail.codeHash}</div>
              {verifyInfo && (
                <div className="mt-1 text-xs text-slate-500">
                  规则指纹一致: {String(verifyInfo.ruleIntact)} · 事件链完整({verifyInfo.chainLength}): {String(verifyInfo.chainIntact)} · 服务端签名: {String(verifyInfo.signatureValid)}
                </div>
              )}
            </div>

            {/* 进度 */}
            <div className="mb-4 grid grid-cols-3 gap-3 text-center text-sm">
              <div className="rounded-lg bg-slate-950 p-3">
                <div className="text-xl font-bold text-emerald-400">{Number(detail.stateData?.memberCount) || 0}</div>
                <div className="text-xs text-slate-500">当前人数</div>
              </div>
              <div className="rounded-lg bg-slate-950 p-3">
                <div className="text-xl font-bold text-sky-400">{fmt(Number(detail.stateData?.totalRaised) || 0)}</div>
                <div className="text-xs text-slate-500">已托管（币）</div>
              </div>
              <div className="rounded-lg bg-slate-950 p-3">
                <div className="text-xl font-bold text-amber-400">{fmt((Number(detail.stateData?.memberCount) || 0) * (Number(detail.params?.groupPrice) || 0))}</div>
                <div className="text-xs text-slate-500">预计交割额</div>
              </div>
            </div>

            {/* 🆕 私域参与名单 */}
            {Array.isArray(detail.whitelist) && detail.whitelist.length > 0 && (
              <div className="mb-4">
                <h3 className="mb-2 text-sm font-medium text-slate-300">
                  参与名单 <span className="text-xs text-indigo-300">私域 · {detail.whitelist.length} 人</span>
                  <span className={`ml-2 text-xs ${detail.initiatorId === userId ? 'text-sky-300' : detail.whitelist.includes(userId) ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {detail.initiatorId === userId
                      ? '你是发起人（自动豁免，可开团 / 可管理）'
                      : detail.whitelist.includes(userId)
                        ? '你已在名单内，可参与认购 / 加入'
                        : '你不在名单内，无法参与认购 / 加入'}
                  </span>
                </h3>
                <div className="flex flex-wrap gap-1.5">
                  {detail.whitelist.map((w) => (
                    <span
                      key={w}
                      className={`rounded-full border px-2 py-0.5 text-xs ${w === userId ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-300' : 'border-slate-700 bg-slate-950 text-slate-300'}`}
                    >
                      {w}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* 托管台账 */}
            {escrowEntries.length > 0 && (
              <div className="mb-4">
                <h3 className="mb-2 text-sm font-medium text-slate-300">托管台账</h3>
                <div className="max-h-32 space-y-1 overflow-y-auto rounded-lg bg-slate-950 p-3 text-xs">
                  {escrowEntries.map((e) => (
                    <div key={e.entryId} className="flex items-center justify-between text-slate-400">
                      <span>{e.fromUserId}</span>
                      <span>{fmt(e.amount)} {e.currency}</span>
                      <span className={e.status === 'locked' ? 'text-sky-400' : e.status === 'refunded' ? 'text-rose-400' : 'text-emerald-400'}>
                        {e.status}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* 条款（通俗摘要 + 技术细节折叠） */}
            <div className="mb-4">
              <h3 className="mb-2 text-sm font-medium text-slate-300">合约条款（通俗版）</h3>
              <div className="space-y-3">
                {buildPlainTerms(detail).map((sec) => (
                  <div key={sec.title} className="rounded-lg border border-slate-800 bg-slate-950 p-3">
                    <div className="text-sm font-medium text-slate-200">{sec.title}</div>
                    <ul className="mt-1.5 space-y-1">
                      {sec.items.map((it, i) => (
                        <li key={i} className="flex gap-1.5 text-xs leading-relaxed text-slate-400">
                          <span className="text-slate-600">·</span>
                          <span>{it}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
              <button
                onClick={() => setShowTech(!showTech)}
                className="mt-2 text-xs text-slate-500 underline-offset-2 hover:text-slate-300 hover:underline"
              >
                {showTech ? '收起技术条款 ▲' : '查看技术条款 ▼'}
              </button>
              {showTech && (
                <div className="mt-2 space-y-2">
                  {detail.clauses.map((cl) => (
                    <div key={cl.id} className="rounded-lg bg-slate-950 p-3 text-xs">
                      <div className="font-medium text-slate-300">{cl.title}</div>
                      {cl.description && <div className="mt-1 text-slate-500">{cl.description}</div>}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* 事件链 */}
            <div>
              <h3 className="mb-2 text-sm font-medium text-slate-300">事件账本（{detail.history.length}）</h3>
              <div className="max-h-48 space-y-1 overflow-y-auto rounded-lg bg-slate-950 p-3 text-xs">
                {[...detail.history].reverse().map((h) => (
                  <div key={h.seq} className="flex items-center gap-2 text-slate-400">
                    <span className="w-10 text-slate-600">#{h.seq}</span>
                    <span className="w-24">{fmtTime(h.at)}</span>
                    <span className="w-28 font-mono text-slate-300">{h.type}</span>
                    <span className="truncate">{h.actorId}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* 操作 */}
            {detail.state === 'signing' && detail.initiatorId !== userId && detail.templateKey === 'group-buy' && (
              <button
                disabled={busy}
                onClick={() => void handleJoin(detail as unknown as ContractSummary)}
                className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-600 py-2.5 font-medium hover:bg-emerald-500 disabled:opacity-50"
              >
                <HandCoins className="h-4 w-4" /> 加入拼团（{fmt(detail.params?.groupPrice)} 游戏币）
              </button>
            )}
            {detail.state === 'signing' && detail.templateKey === 'team-quest' && detail.initiatorId !== userId && (
              <button
                disabled={busy}
                onClick={() => void handleJoin(detail as unknown as ContractSummary)}
                className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-600 py-2.5 font-medium hover:bg-emerald-500 disabled:opacity-50"
              >
                <Users className="h-4 w-4" /> 加入团队（保证金 {fmt(detail.params?.memberBond)} 游戏币）
              </button>
            )}
            {/* 🆕 2026-10-20：团长手动成团（signing 且人数已达最低开团人数） */}
            {detail.templateKey === 'team-quest' && detail.state === 'signing' && detail.initiatorId === userId
              && Number(detail.stateData?.memberCount) >= Number(detail.params?.minMembers) && (
              <button
                disabled={busy}
                onClick={() => void handleManualOpen(detail.id)}
                className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-600 py-2.5 font-medium hover:bg-emerald-500 disabled:opacity-50"
              >
                <Users className="h-4 w-4" /> 手动成团（当前 {fmt(detail.stateData?.memberCount)} 人，已达最低 {fmt(detail.params?.minMembers)} 人）
              </button>
            )}
            {/* 🆕 2026-10-18：团长注入奖池入口（amount>0 且未注资时显示） */}
            {detail.templateKey === 'team-quest' && detail.state === 'active' && detail.initiatorId === userId
              && Number((detail.params?.rewardPool as Record<string, unknown> | undefined)?.amount) > 0
              && !Number(detail.stateData?.poolFunded) && (
              <button
                disabled={busy}
                onClick={() => void handleFundPool(detail.id)}
                className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg bg-amber-600 py-2.5 font-medium hover:bg-amber-500 disabled:opacity-50"
              >
                <Coins className="h-4 w-4" /> 注入奖池（{fmt(Number((detail.params?.rewardPool as Record<string, unknown>).amount))} 游戏币进托管）
              </button>
            )}
            {detail.templateKey === 'team-quest' && detail.state === 'active' && detail.initiatorId === userId && (
              <div className="mt-4 rounded-lg border border-slate-800 bg-slate-950 p-3">
                <div className="mb-2 text-xs text-slate-400">上报成员贡献（团长代报通道；成员也可通过 __protocol 自报本人进度；游戏内事件自动上报接入中）</div>
                <div className="flex gap-2">
                  <input
                    className="w-32 rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm"
                    placeholder="成员 ID"
                    value={progressInput.targetUserId}
                    onChange={(e) => setProgressInput({ ...progressInput, targetUserId: e.target.value })}
                  />
                  <input
                    className="w-24 rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm"
                    placeholder="分数"
                    value={progressInput.points}
                    onChange={(e) => setProgressInput({ ...progressInput, points: e.target.value })}
                  />
                  <button
                    disabled={busy}
                    onClick={() => void handleReportProgress(detail.id)}
                    className="flex-1 rounded-lg bg-sky-600 px-3 py-1.5 text-sm font-medium hover:bg-sky-500 disabled:opacity-50"
                  >
                    上报
                  </button>
                </div>
                {/* 🆕 2026-10-20：填报提示 */}
                <div className="mt-2 space-y-1 rounded-lg border border-slate-800 bg-slate-900/60 p-2.5 text-xs leading-relaxed text-slate-500">
                  <div><span className="text-slate-400">成员 ID</span>：填被上报成员的用户 ID，必须已加入本团队（可从下方事件账本的 join 记录中查看）；冒名上报非本人/非成员会被拒绝。</div>
                  <div><span className="text-slate-400">分数</span>：本次要记的贡献点数（正整数），同一成员可多次上报、自动累加；截止后按每人累计分数占全队总分比例分配奖池（先抽团长管理费）。</div>
                  {detail.params?.contributionRule
                    ? <div><span className="text-slate-400">本合约贡献规则</span>：{String(detail.params.contributionRule)}</div>
                    : null}
                  <div className="rounded-md bg-slate-950/80 p-2 text-slate-400">
                    <div className="mb-1 font-medium text-slate-400">💡 分配示例</div>
                    {buildPayoutExample(detail).map((l, i) => <div key={i} className={l.startsWith('  ·') ? 'pl-2' : ''}>{l.trim()}</div>)}
                  </div>
                </div>
              </div>
            )}
            {/* 🆕 2026-10-20：成员自报通道（__protocol 本人进度，服务端校验 targetUserId=本人） */}
            {detail.templateKey === 'team-quest' && detail.state === 'active' && detail.initiatorId !== userId
              && Array.isArray(detail.stateData?.contributions)
              && (detail.stateData.contributions as Array<{ userId?: string }>).some((u) => u?.userId === userId) && (
              <div className="mt-4 rounded-lg border border-slate-800 bg-slate-950 p-3">
                <div className="mb-2 text-xs text-slate-400">自报我的贡献进度（每次填一个正整数分值，自动累加；结算按累计分数占比分奖池）</div>
                <div className="flex gap-2">
                  <input
                    className="w-24 rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm"
                    placeholder="分数"
                    value={progressInput.points}
                    onChange={(e) => setProgressInput({ ...progressInput, points: e.target.value })}
                  />
                  <button
                    disabled={busy}
                    onClick={() => {
                      const id = detail.id;
                      if (progressInput.points === '') { toast.error('请填写分数'); return; }
                      setBusy(true);
                      void invokeContract(id, '__protocol', { targetUserId: userId, points: Number(progressInput.points) }, `proto_${id}_${Date.now()}`)
                        .then((r) => {
                          setBusy(false);
                          if (r.ok) { toast.success(`已自报 +${progressInput.points}`); setProgressInput({ targetUserId: '', points: '' }); void openDetail(id); }
                          else toast.error(r.error || '自报失败');
                        });
                    }}
                    className="flex-1 rounded-lg bg-sky-600 px-3 py-1.5 text-sm font-medium hover:bg-sky-500 disabled:opacity-50"
                  >
                    自报
                  </button>
                </div>
                {detail.params?.contributionRule && (
                  <div className="mt-2 rounded-lg border border-slate-800 bg-slate-900/60 p-2.5 text-xs text-slate-500">
                    <span className="text-slate-400">本合约贡献规则</span>：{String(detail.params.contributionRule)}
                  </div>
                )}
                <div className="mt-2 rounded-md border border-slate-800 bg-slate-950/80 p-2 text-xs text-slate-400">
                  <div className="mb-1 font-medium text-slate-400">💡 分配示例</div>
                  {buildPayoutExample(detail).map((l, i) => <div key={i} className={l.startsWith('  ·') ? 'pl-2' : ''}>{l.trim()}</div>)}
                </div>
              </div>
            )}
            {detail.templateKey === 'gso' && detail.state === 'signing' && (
              <div className="mt-4 rounded-lg border border-slate-800 bg-slate-950 p-3">
                <div className="mb-2 text-xs text-slate-400">认购金额（单人上限 {fmt(detail.params?.perUserCap)} 游戏币）</div>
                <div className="flex gap-2">
                  <input
                    className="flex-1 rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm"
                    placeholder="认购金额"
                    value={subscribeAmount}
                    onChange={(e) => setSubscribeAmount(e.target.value)}
                  />
                  {(() => {
                    // 🆕 私域门禁：名单外成员禁止认购（服务端仍兜底校验）
                    const wlBlocked = Array.isArray(detail.whitelist) && detail.whitelist.length > 0
                      && detail.initiatorId !== userId && !detail.whitelist.includes(userId);
                    return (
                      <>
                        {wlBlocked && (
                          <span className="text-xs text-indigo-300/80">私域合约：仅名单内 {detail.whitelist!.length} 名成员可认购</span>
                        )}
                        <button
                          disabled={busy || wlBlocked}
                          title={wlBlocked ? '私域合约：仅名单内成员可认购' : undefined}
                          onClick={() => void handleSubscribe(detail.id)}
                          className="rounded-lg bg-amber-600 px-4 py-1.5 text-sm font-medium hover:bg-amber-500 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          <Coins className="h-4 w-4" />
                        </button>
                      </>
                    );
                  })()}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {showHelp && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4" role="dialog" aria-modal="true">
          <div className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-slate-800 bg-slate-900 p-6">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-lg font-bold">
                <CircleHelp className="h-5 w-5 text-sky-400" /> 合约使用指南
              </h2>
              <button onClick={() => setShowHelp(false)} className="rounded-lg p-1 hover:bg-slate-800" aria-label="关闭">
                <X className="h-5 w-5" />
              </button>
            </div>

            <section className="mb-4 rounded-xl border border-slate-800 bg-slate-950 p-4">
              <h3 className="mb-2 font-semibold text-emerald-300">合约是什么？</h3>
              <ul className="list-disc space-y-1 pl-5 text-sm text-slate-300">
                <li>合约 = 平台作为第三方保证人，按<b>公开条款</b>自动执行资金收付的规则容器。</li>
                <li>条款一经部署即被 <b>codeHash（规则指纹）</b> 固化，任何人（包括平台）都无法篡改；每一步执行都记入事件账本，详情页可一键验证。</li>
                <li>你的资金先进入<b>平台托管账户</b>锁定（不是消费），达成条件自动放行给应收方，条件不满足自动原路退回。</li>
              </ul>
            </section>

            <section className="mb-4 rounded-xl border border-slate-800 bg-slate-950 p-4">
              <h3 className="mb-2 font-semibold text-sky-300">三种合约怎么玩</h3>
              <ul className="list-disc space-y-1 pl-5 text-sm text-slate-300">
                <li><b>拼团</b>：发起人设定团购价与人数 → 大家点「加入」（付成团价进托管）→ 满员或到期达标，货款自动交割给发起人；到期没凑够人数，<b>全额自动退款</b>。</li>
                <li><b>组团任务</b>：团员缴保证金进托管，团长注入奖池 → 任务期间贡献由游戏事件上报 → 截止后<b>奖池按贡献占比自动分配</b>、保证金全额退还；中途退出按比例罚没。</li>
                <li><b>GSO 认购</b>：游戏方出让一定比例的收益分成权，社区用游戏币认购 → 达到最低成筹额后资金交割给游戏方，认购者按份额获得<b>收益分成凭证（RSV）</b>，此后每周期平台把该游戏的可观测收益按份额自动分账。<b>需平台审核</b>；未达最低成筹额全额退款。</li>
                <li>以上三种均支持<b>公开 / 私域</b>两种模式，详见下方「公开合约与私域合约」。</li>
              </ul>
            </section>

            <section className="mb-4 rounded-xl border border-slate-800 bg-slate-950 p-4">
              <h3 className="mb-2 font-semibold text-amber-300">「影子模式」是什么？</h3>
              <p className="text-sm text-slate-300">
                看到卡片上的「影子」标记，表示该模板的<b>自动执行开关尚未开启</b>：条款照常计算、结果照常入账本（影子计划），但<b>不会真实动钱</b>。这是平台的灰度安全机制——新合约先影子运行、对账无误后逐档开闸。开闸由服务端环境变量 <code className="rounded bg-slate-800 px-1">CONTRACT_AUTO_EXECUTE</code> 控制；<b>本地开发环境已默认开闸三种模板</b>，无需配置。
              </p>
            </section>

            <section className="mb-4 rounded-xl border border-slate-800 bg-slate-950 p-4">
              <h3 className="mb-2 font-semibold text-indigo-300">公开合约与私域合约</h3>
              <ul className="list-disc space-y-1 pl-5 text-sm text-slate-300">
                <li><b>公开合约</b>（默认）：部署后在合约大厅公开招募，任何登录用户都可加入 / 认购。</li>
                <li><b>私域合约</b>：发起时勾选「私域合约」并填写成员 ID 名单（上限 500 人，逗号 / 分号 / 换行分隔）——仅名单内成员可加入 / 认购。适合只面向特定人群的 GSO 认购、内部组团等场景。</li>
                <li>发起人<b>自动豁免</b>（不需要把自己写进名单，团长可直接开团）。</li>
                <li>名单外成员<b>在大厅看不到私域合约</b>（仅发起人、名单内成员与平台可见）；持有合约链接可查看详情与验证，但加入 / 认购按钮不可用，服务端也会拒绝绕过前端的请求。</li>
                <li>私域不影响其他权利：中途退出、发起挑战、查看托管台账与事件验证照常可用；卡片与详情页会显示「<span className="text-indigo-300">私域 · N 人</span>」徽章与完整名单。</li>
              </ul>
            </section>

            <section className="rounded-xl border border-slate-800 bg-slate-950 p-4">
              <h3 className="mb-2 font-semibold text-violet-300">完整操作流程</h3>
              <ol className="list-decimal space-y-1 pl-5 text-sm text-slate-300">
                <li>登录（合约操作需要登录态，余额里需有游戏币）。</li>
                <li>点右上角「发起合约」→ 选模板 → 填参数 →（可选）勾选「私域合约」并填写成员名单 → 部署，得到 64 位 codeHash。</li>
                <li>其他用户在「合约大厅」点「加入 / 认购」，资金自动进托管（私域合约仅名单内成员可见并参与）。</li>
                <li>满员或到期后，服务端定时任务自动交割 / 分账 / 退款（本地测试可手动触发：<code className="rounded bg-slate-800 px-1">POST /api/v1/games/__contract/tick</code>）。</li>
                <li>详情页随时点「验证未被篡改」复核规则指纹与事件链。</li>
              </ol>
              <p className="mt-2 text-xs text-slate-500">
                常见问题：加入后余额立刻减少是资金进托管（退款会原路返回）；认购提示「条件未满足」请检查认购窗口时间 / 单人上限 / 剩余额度；大厅里看不到某个合约，可能是它开启了<b>私域名单</b>而你不在名单内；「加入 / 认购」按钮显示「名单外」同理。
              </p>
            </section>
          </div>
        </div>
      )}
    </div>
  );
}
