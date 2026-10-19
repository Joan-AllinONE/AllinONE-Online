/**
 * contractTunnel - 智能合约隧道（__contract）本地双实现
 *
 * 与云函数 gamesApi 的 __contract 分支对齐（引擎统一编译产物，逻辑同源）。
 * 挂在 /api/v1/games/__contract（gamesPublicRouter 之前）。
 *
 * 端点：
 *   GET  /templates           模板列表（公开）
 *   POST /deploy              部署实例（校验 → codeHash → HMAC → signing；requiresAudit → draft）
 *   POST /sign                参与方签署
 *   POST /invoke              manual 触发（join / subscribe / settle / dispute ...）
 *   POST /tick                cron 驱动（deadline-check / settlement-weekly；由定时器或手动调用）
 *   GET  /query               实例列表（?state=&family=&initiatorId=&gameId=）
 *   GET  /detail?id=          实例详情（含完整事件链）
 *   GET  /verify?id=          公开复算（codeHash + 事件链完整性）
 *   GET  /escrow?id=          托管台账（参与者自查）
 *   GET  /admin/overview      平台监控（admin）
 *   POST /admin/review        合约审核（requiresAudit 模板 draft → signing，admin）
 *
 * 资金权威（B2 铁律）：
 * - 所有资金操作走服务端原语：gameCoins 走 users 调整（txId 幂等）；A币走服务端直改 vouchers 文档
 * - 托管台账 contract_escrows；Effect 执行 saga 化（txId 幂等 → 失败重放不双花）
 * - 影子模式（autoExecute=false）：plan 只入事件链，不动钱
 */
import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { verifyToken } from '../auth/jwt.js';
import {
  CONTRACTS_ENABLED,
  CONTRACT_AUTO_EXECUTE,
  getTemplate,
  listTemplates,
  validateParams,
  validateTemplate,
  validateUgcTemplate,
  classifyTemplateRisk,
  deriveInitialStateData,
  computeCodeHash,
  verifyCodeHash,
  executeTrigger,
  applyUpdates,
  appendEvent,
  verifyChain,
  sha256hex,
  canonicalize,
} from '../../contracts/index.js';
import type { ContractInstance, Effect, EffectPlan, PlatformRule, TriggerEvent } from '../../contracts/index.js';
import { PLATFORM_RULE_DEFAULTS } from '../../contracts/index.js';
import { buildContractInviteNotifications } from './notifications.js';

const GENESIS_HASH = '0'.repeat(64);
const ESCROW_SYSTEM_ACCOUNT = 'system-platform';

function signingKey(): string {
  // 合约签名密钥与 JWT_SECRET 分离（轮换 JWT 不得作废合约签名）；dev 缺省回退并告警
  const k = process.env.CONTRACT_SIGNING_KEY || process.env.JWT_SECRET || 'allinone-contract-dev';
  if (!process.env.CONTRACT_SIGNING_KEY) {
    console.warn('[contract] ⚠️ 未配置 CONTRACT_SIGNING_KEY，回退（生产必须独立配置）');
  }
  return k;
}

function hmacSign(codeHash: string): string {
  return crypto.createHmac('sha256', signingKey()).update(codeHash).digest('hex');
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}

/** cron 触发确定性桶（同桶内重复 tick 幂等跳过；跨桶（下个周期）自然重试） */
function tickBucket(schedule: string, now: number): number {
  if (schedule === 'settlement-weekly') return Math.floor(now / (7 * 24 * 3600 * 1000));
  if (schedule === 'settlement-monthly') return Math.floor(now / (30 * 24 * 3600 * 1000));
  return Math.floor(now / (60 * 60 * 1000)); // deadline-check 等：小时桶
}

/**
 * 🆕 私域合约门禁纯函数（导出供单测）：进入类动作（join/subscribe）是否被名单拦截。
 * 规则：名单为空/缺省 = 公开合约永不拦截；未登录一律拦截；发起人豁免；其余按名单精确匹配（大小写敏感）。
 */
export function isEntryBlockedByWhitelist(
  whitelist: string[] | undefined | null,
  userId: string | undefined | null,
  initiatorId: string | undefined | null,
): boolean {
  if (!Array.isArray(whitelist) || whitelist.length === 0) return false;
  if (!userId) return true;
  if (userId === initiatorId) return false;
  return !whitelist.includes(userId);
}

/**
 * 🆕 私域合约可见性纯函数（导出供单测）：大厅列表是否对该查看者隐藏该合约。
 * 规则：公开合约人人可见；私域仅发起人 / 名单内成员 / 平台角色（admin|platform）可见。
 */
export function isHiddenFromViewer(
  whitelist: string[] | undefined | null,
  viewerId: string | undefined | null,
  initiatorId: string | undefined | null,
  viewerRole?: string | null,
): boolean {
  if (!Array.isArray(whitelist) || whitelist.length === 0) return false;
  if (viewerRole === 'admin' || viewerRole === 'platform') return false;
  if (!viewerId) return true;
  if (viewerId === initiatorId) return false;
  return !whitelist.includes(viewerId);
}

export function createContractTunnelRouter(
  USE_MEMORY_DB: boolean,
  memoryDB: any,
  _pool: any,
  _isProduction: boolean,
): Router {
  const router = Router();
  const isMemory = USE_MEMORY_DB || !!memoryDB;

  function resolveUserId(req: Request): string {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      try {
        const payload = verifyToken(authHeader.slice(7));
        if (payload && payload.userId) return payload.userId;
      } catch {
        // 回退
      }
    }
    const body: any = req.body || {};
    return String(body.userId || 'anonymous');
  }

  function resolveRole(req: Request): string {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      try {
        const payload = verifyToken(authHeader.slice(7));
        if (payload && payload.role) return payload.role;
      } catch {
        // 回退
      }
    }
    return '';
  }

  function requireAdmin(req: Request): string | null {
    const role = resolveRole(req);
    if (role !== 'admin' && role !== 'platform') return '权限不足：仅平台管理员可操作';
    return null;
  }

  // ============================================================
  // 资金原语（B2：服务端资金权威）
  // ============================================================

  /** 锁定资金进托管：gameCoins → users adjust(-)；aCoins → 服务端直改凭证文档 */
  async function escrowLock(
    contractId: string,
    fromUserId: string,
    currency: string,
    amount: number,
    txId: string,
    reason: string,
    purpose?: string,
  ): Promise<void> {
    if (amount <= 0) return;
    if (currency === 'gameCoins') {
      const r = await memoryDB.adjustPlatformBalance(fromUserId, -amount, `[contract:${contractId}] ${reason}`, txId);
      if (!r) throw new Error(`余额不足（${fromUserId} 需 ${amount} gameCoins）`);
      await memoryDB.putEscrowEntry({
        entryId: newId('esc'),
        txId,
        contractId,
        fromUserId,
        kind: 'wallet',
        currency,
        purpose,
        amount,
        lockedAt: Date.now(),
        status: 'locked',
      });
      return;
    }
    // aCoins = 凭证：服务端直改 currentHolderId → 托管账户 + frozenAt
    // MVP：按金额找该用户持有的 active 凭证逐张冻结（找齐 amount 面额）
    const need = amount;
    let got = 0;
    const frozenIds: string[] = [];
    const rows = (await memoryDB.listContractVouchersByHolder(fromUserId)) || [];
    for (const v of rows) {
      if (got >= need) break;
      if (v.status !== 'active' || v.frozenAt) continue;
      const face = Number(v.denomination) || 0;
      if (face <= 0 || got + face > need + 1e-6) continue;
      v.currentHolderId = `contract-escrow:${contractId}`;
      v.frozenAt = Date.now();
      await memoryDB.putVoucherDoc(v.id, v);
      frozenIds.push(v.id);
      got += face;
    }
    if (got < need) throw new Error(`A币凭证面额不足以托管 ${amount}（仅锁定 ${got}）`);
    // 记录凭证托管映射（释放/退款时回转）
    await memoryDB.putEscrowEntry({
      entryId: newId('escv'),
      txId,
      contractId,
      fromUserId,
      kind: 'voucher',
      currency,
      purpose,
      amount: got,
      voucherIds: frozenIds,
      lockedAt: Date.now(),
      status: 'locked',
    });
  }

  /** 从托管释放资金给目标（FIFO 扣减 locked 记录；purpose 定向隔离 bond/pool） */
  async function escrowRelease(
    contractId: string,
    toUserId: string,
    currency: string,
    amount: number,
    txId: string,
    reason: string,
    purpose?: string,
  ): Promise<void> {
    if (amount <= 0) return;
    if (currency !== 'gameCoins') {
      // A币：voucher kind 的锁定记录 → 凭证 currentHolderId 转给目标
      const entries = (await memoryDB.listEscrowByContract(contractId)) || [];
      const vEntries = entries.filter(
        (e: any) => e.status === 'locked' && e.kind === 'voucher' && (purpose === undefined || e.purpose === purpose),
      );
      for (const e of vEntries) {
        for (const vid of e.voucherIds || []) {
          const v = await memoryDB.getVoucherDoc(vid);
          if (v && v.currentHolderId === `contract-escrow:${contractId}`) {
            v.currentHolderId = toUserId;
            v.lastTransferAt = Date.now();
            await memoryDB.putVoucherDoc(vid, v);
          }
        }
        e.status = 'released';
        e.releasedAt = Date.now();
        e.releasedTo = toUserId;
        await memoryDB.putEscrowEntry(e);
      }
      return;
    }
    // 🆕 顺序修正（2026-10-10 审查）：必须先扣减托管台账（验证充足）成功后，
    // 才给收款人入账。此前先入账后验证——余额不足时收款人已拿钱而台账未扣，
    // 实例回滚后台账与实际资金不一致（审计失真 + 潜在超发窗口）。
    let remaining = amount;
    const entries = (await memoryDB.listEscrowByContract(contractId)) || [];
    const locked = entries
      .filter(
        (e: any) =>
          e.status === 'locked' && e.currency === currency && e.kind === 'wallet' &&
          (purpose === undefined || e.purpose === purpose),
      )
      .sort((a: any, b: any) => a.lockedAt - b.lockedAt);
    for (const e of locked) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, e.amount);
      e.amount -= take;
      remaining -= take;
      if (e.amount <= 1e-6) {
        e.status = 'released';
        e.releasedAt = Date.now();
        e.releasedTo = e.releasedTo || toUserId;
      }
      await memoryDB.putEscrowEntry(e);
    }
    if (remaining > 1e-6) {
      throw new Error(`托管余额不足：${currency}${purpose ? `/${purpose}` : ''} 还需 ${remaining}`);
    }
    await memoryDB.adjustPlatformBalance(toUserId, amount, `[contract:${contractId}] ${reason}`, txId);
  }

  /**
   * refundAll：托管内全部 locked 退回原出资人
   * B-3 修复：不再按 instance.params.currency 过滤（TeamQuest 币种在 rewardPool.currency，
   * params.currency=undefined 会导致查不到任何条目 → 退款失效）；改为退全部 locked
   * （可选 purpose 定向：bond/pool 隔离）。
   */
  async function escrowRefundAll(contractId: string, planId: string, purpose?: string): Promise<void> {
    const entries = (await memoryDB.listEscrowByContract(contractId)) || [];
    const locked = entries.filter(
      (e: any) => e.status === 'locked' && (purpose === undefined || e.purpose === purpose),
    );
    for (const e of locked) {
      if (e.currency === 'gameCoins') {
        await memoryDB.adjustPlatformBalance(
          e.fromUserId, e.amount, `[contract:${contractId}] 退款`, `${planId}:refund:${e.entryId}`,
        );
      } else {
        // B-10 修复：aCoins 托管 entry 存的是 voucherIds 数组（不是 voucherId 单数）
        for (const vid of e.voucherIds || []) {
          const v = await memoryDB.getVoucherDoc(vid);
          if (v && v.currentHolderId === `contract-escrow:${contractId}`) {
            v.currentHolderId = e.fromUserId;
            delete v.frozenAt;
            await memoryDB.putVoucherDoc(vid, v);
          }
        }
      }
      e.status = 'refunded';
      e.releasedAt = Date.now();
      e.releasedTo = e.fromUserId;
      await memoryDB.putEscrowEntry(e);
    }
  }

  /** 罚没：从违约者托管记录扣 → 平台金库（purpose 定向） */
  async function escrowForfeit(
    contractId: string, userId: string, currency: string, amount: number, planId: string, purpose?: string,
  ): Promise<void> {
    let remaining = amount;
    const entries = (await memoryDB.listEscrowByContract(contractId)) || [];
    const locked = entries
      .filter(
        (e: any) =>
          e.status === 'locked' && e.currency === currency && e.fromUserId === userId && e.kind === 'wallet' &&
          (purpose === undefined || e.purpose === purpose),
      )
      .sort((a: any, b: any) => a.lockedAt - b.lockedAt);
    for (const e of locked) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, e.amount);
      e.amount -= take;
      remaining -= take;
      if (e.amount <= 1e-6) {
        e.status = 'forfeited';
        e.releasedAt = Date.now();
      }
      await memoryDB.putEscrowEntry(e);
    }
    if (remaining > 1e-6) {
      throw new Error(`托管余额不足（罚没）：${currency}${purpose ? `/${purpose}` : ''} 还需 ${remaining}`);
    }
    if (currency === 'gameCoins' && amount > 0) {
      await memoryDB.adjustPlatformBalance(
        ESCROW_SYSTEM_ACCOUNT, amount, `[contract:${contractId}] 违约罚没`, `${planId}:forfeit:${userId}`,
      );
    }
  }

  // ============================================================
  // 🆕 P1（2026-10-15）：GSO 交割时调减发行方收益份额
  // ============================================================
  /**
   * GSO 经济闭环：交割铸 RSV 后，发行方（游戏方）的后续销售分成按出让比例调减，
   * 使 RSV 持有人的周期分账实质来自发行方让渡的份额，而非平台金库额外补贴。
   * 幂等：account.gsoConveyed.contractId 已等于本合约 → 跳过（saga 重放安全）。
   */
  async function adjustIssuerRevenueShareForGso(instance: ContractInstance, planId: string): Promise<void> {
    try {
      const gameId = String(instance.gameId || (instance.params as Record<string, any>)?.gameId || '');
      if (!gameId) return;
      const accountId = `game-${gameId}`;
      const account = await memoryDB.getDeveloperAccount(accountId);
      if (!account) {
        console.warn(`[contract:gso] ⚠️ 发行方账户不存在（${accountId}），份额调减跳过——后续销售仍按原比例入账`);
        return;
      }
      if ((account as any).gsoConveyed?.contractId === instance.id) return; // 幂等
      const bps = Math.max(0, Math.min(10000, Number((instance.params as Record<string, any>).revenueShareBps) || 0));
      if (bps <= 0) return;
      const keep = 1 - bps / 10000;
      const prevSharing = (account as any).revenueSharing;
      if (prevSharing && typeof prevSharing === 'object' && Number(prevSharing.gameShareBps) > 0) {
        // 三方配置：游戏方份额按 keep 缩减；释放的 bps 按平台/创作者原权重比例承接
        const g = Number(prevSharing.gameShareBps) || 0;
        const p = Number(prevSharing.platformShareBps) || 0;
        const c = Number(prevSharing.creatorShareBps) || 0;
        const newG = Math.floor(g * keep);
        const freed = g - newG;
        let newP = p;
        let newC = c;
        if (p + c > 0) {
          newP = p + Math.floor((freed * p) / (p + c));
          newC = c + (freed - (newP - p));
        } else {
          newP = p + freed;
        }
        (account as any).revenueSharing = { ...prevSharing, gameShareBps: newG, platformShareBps: newP, creatorShareBps: newC };
      } else {
        // legacy 抽成比例：按 keep 比例缩减（保留两位小数）
        const pct = Number(account.revenueSharePercent) || 0;
        account.revenueSharePercent = Math.round(pct * keep * 100) / 100;
      }
      (account as any).gsoConveyed = { contractId: instance.id, bps, at: Date.now(), planId };
      account.updatedAt = Date.now();
      await memoryDB.upsertDeveloperAccount(account);
      console.log(
        `[contract:gso] 发行方份额已调减：${accountId} 出让 ${bps}bps` +
        `（revenueSharing=${JSON.stringify((account as any).revenueSharing)} percent=${account.revenueSharePercent}）`,
      );
    } catch (e) {
      console.warn('[contract:gso] 发行方份额调减失败（不阻塞交割）:', e instanceof Error ? e.message : String(e));
    }
  }

  // ============================================================
  // 🆕 P2（2026-10-15）：拼团成团交割 → 平台铸造履约凭证（发货收据）
  // ============================================================
  /**
   * 拼团 × 平台履约打通：成团交割（state → settling）时，为每位参团成员铸造
   * 「拼团履约凭证」（gbr），作为平台侧的发货/收货凭证与后续争议/核销依据。
   * skuId（可选）随合约参数透传进凭证 metadata，供接入真实商品/订单系统。
   * 幂等：凭证 id 确定性（gbr_<contractId>_<userId>），已存在则跳过。
   */
  async function mintGroupBuyReceipts(instance: ContractInstance, planId: string): Promise<void> {
    try {
      const contributions = Array.isArray((instance.stateData as Record<string, any>)?.contributions)
        ? ((instance.stateData as Record<string, any>).contributions as Array<Record<string, unknown>>)
        : [];
      const seen = new Set<string>();
      const p = (instance.params || {}) as Record<string, any>;
      for (const c of contributions) {
        const uid = String(c?.userId || '');
        if (!uid || seen.has(uid)) continue;
        seen.add(uid);
        const vid = `gbr_${instance.id}_${uid}`;
        if (await memoryDB.getVoucherDoc(vid)) continue; // 幂等
        await memoryDB.putContractVoucher({
          id: vid,
          schemaName: 'gbr',
          title: `拼团凭证:${String(p.itemTitle || instance.id)}`,
          description: `拼团收据：道具「${String(p.itemTitle || '未指定')}」（${String(p.skuId || '无skuId')}），成团价 ${Number(p.groupPrice) || 0} ${String(p.currency || 'gameCoins')}，合约 ${instance.id}。发货状态：待发货（发货后 metadata.fulfilled=true）`,
          denomination: Number(p.groupPrice) || 0,
          currentHolderId: uid,
          currentHolderName: uid,
          status: 'active',
          createdAt: Date.now(),
          createdBy: `contract:${instance.id}`,
          metadata: {
            contractId: instance.id,
            kind: 'group-buy-receipt',
            // 履约语义（2026-10-16 升级）：铸造时仅是「待发货」收据；
            // 真正的道具凭证交割由 fulfillGroupBuyItems 转移平台池凭证后置 fulfilled:true+itemVoucherId。
            fulfilled: false,
            fulfillmentPending: true,
            itemTitle: p.itemTitle,
            skuId: p.skuId || '',
            groupPrice: p.groupPrice,
            currency: p.currency,
            codeHash: instance.codeHash,
            planId,
          },
          integrity: { v: 1, mintedBy: 'server', planId, mintedAt: Date.now(), sig: hmacSign(`${vid}|${uid}|${instance.codeHash}`) },
        });
      }
      if (seen.size > 0) console.log(`[contract:group-buy] 履约凭证已铸造：${seen.size} 份（${instance.id}）`);
    } catch (e) {
      console.warn('[contract:group-buy] 履约凭证铸造失败（不阻塞交割）:', e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * 🆕 拼团履约发货（2026-10-16）：成团交割（→ settling）后，按 skuId 把平台池
   * （platform_pool）中的预铸道具凭证逐成员转移——与商店购买同一库存通道，
   * 库存（池内可用凭证数）自然减少。幂等：gbr metadata.itemVoucherId 已存在则跳过；
   * 池内无该 skuId 凭证 → 保持待发货（不阻塞交割），下次 tick 重试自愈。
   */
  /** 履约异常写入合约事件账本（服务端 console 浏览器不可见，事件账本才是玩家/发起方能看到的渠道）。
   *  幂等：同 type+同 key 已存在则跳过，防 60s tick 重试刷屏。 */
  function appendDeliveryEvent(instance: ContractInstance, type: string, payload: Record<string, unknown>): void {
    try {
      const dedupeKey = `${type}:${instance.id}:${String(payload.skuId || '')}:${String(payload.members || payload.reason || '')}`;
      const dup = instance.history.some((e) => e.type === type && `${e.type}:${instance.id}:${String((e.payload || {}).skuId || '')}:${String((e.payload || {}).members || (e.payload || {}).reason || '')}` === dedupeKey);
      if (dup) return;
      instance.history.push(appendEvent(instance.history, {
        at: Date.now(),
        type,
        actorId: 'system',
        payload,
      }));
    } catch (e) {
      console.warn('[contract:group-buy] 履约事件写入失败（不阻塞）:', e instanceof Error ? e.message : String(e));
    }
  }

  async function fulfillGroupBuyItems(instance: ContractInstance): Promise<void> {
    const p = (instance.params || {}) as Record<string, any>;
    const skuId = String(p.skuId || '');
    if (!skuId) {
      appendDeliveryEvent(instance, 'delivery-skipped', { reason: 'missing-skuId', note: '拼团参数缺少 skuId，无法履约发货；请在合约参数中补充道具 skuId' });
      return;
    }
    const contributions = Array.isArray((instance.stateData as Record<string, any>)?.contributions)
      ? ((instance.stateData as Record<string, any>).contributions as Array<Record<string, unknown>>)
      : [];
    const seen = new Set<string>();
    const pendingShortage = new Set<string>();
    for (const c of contributions) {
      const uid = String(c?.userId || '');
      if (!uid || seen.has(uid)) continue;
      seen.add(uid);
      try {
        const gbrId = `gbr_${instance.id}_${uid}`;
        const gbr = await memoryDB.getVoucherDoc(gbrId);
        if (!gbr || gbr.metadata?.itemVoucherId) continue; // 收据不存在或已发货
        const poolVoucher = await memoryDB.findPoolItemVoucher(skuId);
        if (!poolVoucher) {
          console.warn(`[contract:group-buy] ⚠️ 履约库存不足：skuId=${skuId} 无可用池凭证（成员 ${uid} 保持待发货，重试自愈）`);
          pendingShortage.add(uid);
          continue;
        }
        // 道具凭证交割：池 → 成员（与 __item 转移同字段语义）
        const delivered = {
          ...poolVoucher,
          currentHolderId: uid,
          currentHolderName: uid,
          lastTransferAt: Date.now(),
          metadata: {
            ...(poolVoucher.metadata || {}),
            customData: {
              ...((poolVoucher.metadata || {}).customData || {}),
              fulfilledByContract: instance.id,
              fulfilledAt: Date.now(),
            },
          },
        };
        await memoryDB.putVoucherDoc(poolVoucher.id, delivered);
        // gbr 收据回填发货结果
        await memoryDB.putVoucherDoc(gbrId, {
          ...gbr,
          metadata: { ...(gbr.metadata || {}), fulfilled: true, fulfillmentPending: false, itemVoucherId: poolVoucher.id, deliveredAt: Date.now() },
        });
        console.log(`[contract:group-buy] 🎁 履约发货：${skuId} → ${uid}（道具凭证 ${poolVoucher.id}）`);
      } catch (e) {
        console.warn(`[contract:group-buy] 成员 ${uid} 履约发货失败（不阻塞，重试自愈）:`, e instanceof Error ? e.message : String(e));
      }
    }
    if (pendingShortage.size > 0) {
      appendDeliveryEvent(instance, 'delivery-out-of-stock', {
        skuId,
        members: Array.from(pendingShortage),
        note: `履约库存不足：平台池无 skuId=${skuId} 的可用凭证，${pendingShortage.size} 位成员保持待发货；请备货后等待下次自动重试`,
      });
    }
  }

  // ============================================================
  // Effect 执行器（saga：txId 幂等 → 失败可重放不双花）
  // ============================================================

  async function executeEffect(
    instance: ContractInstance,
    plan: EffectPlan,
    idx: number,
    eff: Effect,
  ): Promise<void> {
    const txId = `${plan.idempotencyKey}:${idx}`;
    switch (eff.type) {
      case 'walletTransfer': {
        if (!eff.fromUserId || eff.fromUserId === 'escrow') {
          // 托管释放（purpose 定向）
          await escrowRelease(instance.id, eff.toUserId, eff.currency, eff.amount, txId, eff.reason, eff.purpose);
        } else {
          // 锁定进托管
          await escrowLock(instance.id, eff.fromUserId, eff.currency, eff.amount, txId, eff.reason, eff.purpose);
        }
        return;
      }
      case 'treasuryDeposit':
        await escrowRelease(instance.id, ESCROW_SYSTEM_ACCOUNT, eff.currency, eff.amount, txId, eff.reason, eff.purpose);
        return;
      case 'splitPayout': {
        // B-25 修复：source=treasury 时从平台金库支付（GSO 收益分成——托管在交割时已清空，
        // 从托管扣会导致"托管余额不足"中断 saga 且部分资金已发出）。平台侧允许透支记账，守恒由收益台账审计。
        if (eff.source === 'treasury') {
          console.log(`[contract:treasury-payout] ${instance.id} rows=${(eff.table || []).length} plan=${plan.idempotencyKey}`);
          for (const [i, row] of (eff.table || []).entries()) {
            const spent = await memoryDB.adjustPlatformBalance(
              ESCROW_SYSTEM_ACCOUNT, -row.amount, `[contract:${instance.id}] 平台分成支出`, `${txId}:${i}:spend`, true,
            );
            if (!spent) throw new Error(`平台金库支出失败（${row.userId} ${row.amount}）`);
            const paid = await memoryDB.adjustPlatformBalance(
              row.userId, row.amount, `[contract:${instance.id}] ${eff.reason}`, `${txId}:${i}`,
            );
            if (!paid) throw new Error(`分账到账失败（${row.userId}）`);
            console.log(`[contract:treasury-payout] row ${i}: ${row.userId} +${row.amount} → paid after=${paid.balance.gameCoins} updatedAt=${paid.balance.lastUpdated} now=${Date.now()}`);
          }
          return;
        }
        for (const [i, row] of (eff.table || []).entries()) {
          await escrowRelease(instance.id, row.userId, eff.currency, row.amount, `${txId}:${i}`, eff.reason, eff.purpose);
        }
        return;
      }
      case 'refundAll':
        await escrowRefundAll(instance.id, txId, eff.purpose);
        return;
      case 'penalize':
        await escrowForfeit(instance.id, eff.userId, eff.currency, eff.amount, plan.idempotencyKey, eff.purpose);
        return;
      case 'freezeVoucher': {
        const v = await memoryDB.getVoucherDoc(eff.voucherId);
        if (v) {
          v.frozenAt = Date.now();
          await memoryDB.putVoucherDoc(v.id, v);
        }
        return;
      }
      case 'unfreezeVoucher': {
        const v = await memoryDB.getVoucherDoc(eff.voucherId);
        if (v) {
          delete v.frozenAt;
          await memoryDB.putVoucherDoc(v.id, v);
        }
        return;
      }
      case 'transferVoucher': {
        const v = await memoryDB.getVoucherDoc(eff.voucherId);
        if (v) {
          v.currentHolderId = eff.toUserId;
          v.lastTransferAt = Date.now();
          await memoryDB.putVoucherDoc(v.id, v);
        }
        return;
      }
      case 'mintVoucher': {
        const vid = newId('cv');
        await memoryDB.putContractVoucher({
          id: vid,
          schemaName: eff.voucher.schemaName,
          title: eff.voucher.title,
          denomination: eff.voucher.denomination || 0,
          currentHolderId: eff.toUserId,
          currentHolderName: eff.toUserId,
          status: 'active',
          createdAt: Date.now(),
          createdBy: `contract:${instance.id}`,
          metadata: { ...(eff.voucher.metadata || {}), contractId: instance.id, codeHash: instance.codeHash },
          integrity: { v: 1, mintedBy: 'server', planId: plan.idempotencyKey, mintedAt: Date.now(), sig: hmacSign(`${vid}|${eff.toUserId}|${instance.codeHash}`) },
        });
        return;
      }
      case 'mintShareVouchers': {
        // GSO：按认购表逐人铸 RSV（收益分成凭证），锁定 lockupMs
        for (const row of eff.rows) {
          const vid = newId('rsv');
        await memoryDB.putContractVoucher({
          id: vid,
          schemaName: 'rsv',
          title: `RSV:${instance.id}`,
          denomination: 0,
          currentHolderId: row.userId,
          currentHolderName: row.userId,
          status: 'active',
          // B-8 修复：锁定期用 frozenAt 真冻结（此前 lockupUntil 只在 metadata，锁定期形同虚设）
          ...(eff.lockupMs > 0 ? { frozenAt: Date.now() + eff.lockupMs } : {}),
          createdAt: Date.now(),
            createdBy: `contract:${instance.id}`,
            metadata: {
              contractId: instance.id,
              gameId: instance.gameId || '',
              codeHash: instance.codeHash,
              share: row.share,
              contributed: row.amount,
              currency: eff.currency,
              lockupUntil: Date.now() + eff.lockupMs,
            },
            integrity: { v: 1, mintedBy: 'server', planId: plan.idempotencyKey, mintedAt: Date.now(), sig: hmacSign(`${vid}|${row.userId}|${instance.codeHash}`) },
          });
        }
        return;
      }
      case 'grantGovernanceWeight':
      case 'setState':
      case 'openDispute':
      case 'notify':
        // 状态类效果：由 plan 的 nextState / 事件链承载，此处无需额外动作
        return;
      default:
        throw new Error(`未实现的 Effect 类型: ${(eff as { type: string }).type}`);
    }
  }

  // ============================================================
  // plan 落地（乐观锁 + saga + 事件链）
  // ============================================================

  async function applyPlan(instance: ContractInstance, plan: EffectPlan): Promise<{ applied: boolean; error?: string; failedIdx?: number; conflict?: boolean }> {
    const expectedVersion = Number(instance.version) || 1;
    if (plan.shadow) {
      // 影子模式：只记录，不动钱
      const ev = appendEvent(instance.history, {
        at: plan.createdAt,
        type: 'shadow-plan',
        actorId: 'system',
        payload: { plan: plan as unknown as Record<string, unknown> },
      });
      instance.history.push(ev);
      instance.updatedAt = Date.now();
      instance.version += 1;
      const ok = await memoryDB.putContractInstanceCAS(instance, expectedVersion);
      if (!ok) return { applied: false, error: '合约并发冲突，请重试', conflict: true };
      return { applied: false };
    }

    // saga：逐条执行；txId 幂等保证重放安全
    for (let i = 0; i < plan.effects.length; i++) {
      try {
        await executeEffect(instance, plan, i, plan.effects[i]);
      } catch (e) {
        const msg = (e as Error).message;
        // 死信记录：不追加 trigger 事件（幂等键未消费）→ 重放安全
        const dead = appendEvent(instance.history, {
          at: Date.now(),
          type: 'effect-failed',
          actorId: 'system',
          payload: { planId: plan.idempotencyKey, idx: i, effect: plan.effects[i] as unknown as Record<string, unknown>, error: msg },
        });
        instance.history.push(dead);
        instance.updatedAt = Date.now();
        const ok = await memoryDB.putContractInstanceCAS(instance, expectedVersion);
        if (!ok) return { applied: false, error: `合约并发冲突（死信未记录）：${msg}`, conflict: true };
        return { applied: false, error: msg, failedIdx: i };
      }
    }

    // 全部成功：应用 stateData 更新 + 状态迁移 + 追加事件
    const nextStateData = applyUpdates(instance.stateData, plan.updates);
    instance.stateData = nextStateData;
    if (plan.nextState) instance.state = plan.nextState;

    // 🆕 P1/P2 平台业务接线（2026-10-15）
    // - GSO 交割（→ active）：调减发行方收益份额，RSV 分账来自让渡份额而非平台额外补贴
    // - 拼团成团（→ settling）：为每位成员铸造履约凭证（gbr），平台获得履约抓手
    if (instance.templateKey === 'gso' && plan.nextState === 'active') {
      await adjustIssuerRevenueShareForGso(instance, plan.idempotencyKey);
    }
    if (instance.templateKey === 'group-buy' && plan.nextState === 'settling') {
      await mintGroupBuyReceipts(instance, plan.idempotencyKey);
      await fulfillGroupBuyItems(instance); // 🆕 2026-10-16：成团即发货（池凭证 → 成员背包）
    }

    const trigEv = appendEvent(instance.history, {
      at: plan.createdAt,
      type: 'trigger',
      actorId: plan.trigger.actorId,
      payload: { ...plan.trigger } as unknown as Record<string, unknown>,
    });
    instance.history.push(trigEv);
    const effEv = appendEvent(instance.history, {
      at: Date.now(),
      type: 'effects-applied',
      actorId: 'system',
      payload: {
        planId: plan.idempotencyKey,
        clauseIds: plan.clauseIds,
        effects: plan.effects as unknown as Record<string, unknown>,
        nextState: plan.nextState || null,
      },
    });
    instance.history.push(effEv);
    instance.updatedAt = Date.now();
    instance.version = expectedVersion + 1;
    // B-12 修复：CAS 写入——并发（async 交错/多实例）时后写不覆盖前写
    const ok = await memoryDB.putContractInstanceCAS(instance, expectedVersion);
    if (!ok) {
      // 资金效果已被 txId 幂等保护，状态未提交 → 客户端/tick 下一轮重试安全
      return { applied: false, error: '合约并发冲突，请重试', conflict: true };
    }
    return { applied: true };
  }

  function makeTriggerEvent(partial: Partial<TriggerEvent> & { triggerId: string; kind: TriggerEvent['kind']; type: string; actorId: string }): TriggerEvent {
    return {
      at: Date.now(),
      payload: {},
      ...partial,
    } as TriggerEvent;
  }

  // ============================================================
  // 端点
  // ============================================================

  // ============================================================
  // 平台规则注册中心（散落硬编码信任规则的收敛点）
  // 注册表 + 治理门控（propose → 公示期 → activate）+ 可验证账本（复用事件哈希链）
  // ============================================================

  let rulesSeeded = false;
  async function ensureRulesSeeded(): Promise<void> {
    if (rulesSeeded) return;
    rulesSeeded = true;
    for (const def of PLATFORM_RULE_DEFAULTS) {
      const existing = await memoryDB.getPlatformRuleDoc(def.ruleKey);
      if (existing) continue;
      const now = Date.now();
      const rule: PlatformRule = {
        id: def.ruleKey,
        ruleKey: def.ruleKey,
        value: def.value,
        description: def.description,
        pendingValue: null,
        proposedBy: null,
        proposedAt: null,
        effectiveAt: null,
        cooldownMs: 72 * 3600 * 1000,
        version: 1,
        history: [],
      };
      rule.history.push(appendEvent(rule.history, {
        at: now,
        type: 'registered',
        actorId: 'system',
        payload: { ruleKey: def.ruleKey, value: def.value, source: 'PLATFORM_RULE_DEFAULTS seed' },
      }));
      await memoryDB.putPlatformRuleDoc(rule);
    }
  }

  /** 服务端读取平台规则（未注册时回退 fallback——存量硬编码迁移的兼容层） */
  async function getPlatformRule(ruleKey: string, fallback: number): Promise<number> {
    await ensureRulesSeeded();
    const doc = await memoryDB.getPlatformRuleDoc(ruleKey);
    if (!doc || typeof doc.value !== 'number' || !Number.isFinite(doc.value)) return fallback;
    return doc.value;
  }

  /** GET /rules — 公开可读（任何人可验证规则值与治理链） */
  router.get('/rules', async (_req: Request, res: Response) => {
    await ensureRulesSeeded();
    const rows = await memoryDB.listPlatformRules();
    const slim = rows.map((r: any) => ({
      ruleKey: r.ruleKey,
      value: r.value,
      description: r.description,
      pendingValue: r.pendingValue,
      proposedBy: r.proposedBy,
      proposedAt: r.proposedAt,
      effectiveAt: r.effectiveAt,
      cooldownMs: r.cooldownMs,
      version: r.version,
      historyCount: (r.history || []).length,
      chainIntact: verifyChain(r.history || []).intact,
    }));
    return res.json({ success: true, data: { rules: slim } });
  });

  /** POST /admin/rules/propose — 发起规则修改（进入公示期） */
  router.post('/admin/rules/propose', async (req: Request, res: Response) => {
    const denied = requireAdmin(req);
    if (denied) return res.status(403).json({ success: false, error: denied });
    await ensureRulesSeeded();
    const { ruleKey, value, description, cooldownMs } = req.body || {};
    const doc = await memoryDB.getPlatformRuleDoc(String(ruleKey || ''));
    if (!doc) return res.status(404).json({ success: false, error: `规则未注册: ${ruleKey}` });
    const v = Number(value);
    // 范围校验按规则语义放宽：比率类 0..1、限额类可达十万级
    if (!Number.isFinite(v) || v < 0 || v > 100000) {
      return res.status(400).json({ success: false, error: 'value 必须在 0..100000' });
    }
    const expectedVersion = Number(doc.version) || 1;
    doc.pendingValue = v;
    doc.proposedBy = resolveUserId(req);
    doc.proposedAt = Date.now();
    doc.effectiveAt = Date.now() + (Number(cooldownMs) > 0 ? Number(cooldownMs) : doc.cooldownMs);
    if (description) doc.description = String(description);
    doc.history.push(appendEvent(doc.history, {
      at: Date.now(),
      type: 'proposed',
      actorId: doc.proposedBy,
      payload: { from: doc.value, to: v, effectiveAt: doc.effectiveAt },
    }));
    doc.version = expectedVersion + 1;
    const ok = await memoryDB.putPlatformRuleDocCAS(doc, expectedVersion);
    if (!ok) return res.status(409).json({ success: false, error: '并发冲突，请重试' });
    return res.json({ success: true, data: { ruleKey: doc.ruleKey, effectiveAt: doc.effectiveAt } });
  });

  /** POST /admin/rules/activate — 公示期满后确认生效（timelock 范式：只能生效公示过的值） */
  router.post('/admin/rules/activate', async (req: Request, res: Response) => {
    const denied = requireAdmin(req);
    if (denied) return res.status(403).json({ success: false, error: denied });
    await ensureRulesSeeded();
    const { ruleKey } = req.body || {};
    const doc = await memoryDB.getPlatformRuleDoc(String(ruleKey || ''));
    if (!doc) return res.status(404).json({ success: false, error: `规则未注册: ${ruleKey}` });
    if (doc.pendingValue === null || doc.pendingValue === undefined) {
      return res.status(409).json({ success: false, error: '无待生效修改' });
    }
    if (Date.now() < Number(doc.effectiveAt || 0)) {
      return res.status(409).json({ success: false, error: `公示期未满（${new Date(doc.effectiveAt).toLocaleString()} 后可生效）` });
    }
    const expectedVersion = Number(doc.version) || 1;
    const from = doc.value;
    doc.value = Number(doc.pendingValue);
    doc.pendingValue = null;
    doc.effectiveAt = null;
    doc.history.push(appendEvent(doc.history, {
      at: Date.now(),
      type: 'activated',
      actorId: resolveUserId(req),
      payload: { from, to: doc.value },
    }));
    doc.version = expectedVersion + 1;
    const ok = await memoryDB.putPlatformRuleDocCAS(doc, expectedVersion);
    if (!ok) return res.status(409).json({ success: false, error: '并发冲突，请重试' });
    return res.json({ success: true, data: { ruleKey: doc.ruleKey, value: doc.value } });
  });

  /** POST /admin/rules/reject — 公示期内否决 */
  router.post('/admin/rules/reject', async (req: Request, res: Response) => {
    const denied = requireAdmin(req);
    if (denied) return res.status(403).json({ success: false, error: denied });
    const { ruleKey } = req.body || {};
    const doc = await memoryDB.getPlatformRuleDoc(String(ruleKey || ''));
    if (!doc) return res.status(404).json({ success: false, error: `规则未注册: ${ruleKey}` });
    const expectedVersion = Number(doc.version) || 1;
    doc.history.push(appendEvent(doc.history, {
      at: Date.now(),
      type: 'rejected',
      actorId: resolveUserId(req),
      payload: { pendingValue: doc.pendingValue },
    }));
    doc.pendingValue = null;
    doc.effectiveAt = null;
    doc.version = expectedVersion + 1;
    const ok = await memoryDB.putPlatformRuleDocCAS(doc, expectedVersion);
    if (!ok) return res.status(409).json({ success: false, error: '并发冲突，请重试' });
    return res.json({ success: true, data: { ruleKey: doc.ruleKey, value: doc.value } });
  });

  /** POST /admin/rules/verify — 规则治理链复算 */
  router.post('/admin/rules/verify', async (req: Request, res: Response) => {
    await ensureRulesSeeded();
    const { ruleKey } = req.body || {};
    const doc = await memoryDB.getPlatformRuleDoc(String(ruleKey || ''));
    if (!doc) return res.status(404).json({ success: false, error: `规则未注册: ${ruleKey}` });
    const chain = verifyChain(doc.history || []);
    return res.json({ success: true, data: { ruleKey: doc.ruleKey, chainIntact: chain.intact, length: chain.length, brokenAt: chain.brokenAt ?? null } });
  });

  /** POST /admin/revenue — 收益台账注入（测试设施；生产数据来自真实成交点记账） */
  router.post('/admin/revenue', async (req: Request, res: Response) => {
    const denied = requireAdmin(req);
    if (denied) return res.status(403).json({ success: false, error: denied });
    const { gameId, source, commission, currency, refId } = req.body || {};
    if (!gameId || !Number.isFinite(Number(commission)) || Number(commission) <= 0) {
      return res.status(400).json({ success: false, error: 'gameId 与正数 commission 必填' });
    }
    const entryId = newId('rev');
    await memoryDB.putRevenueEntry({
      entryId,
      txId: entryId,
      source: String(source || 'store_sale'),
      gameId: String(gameId),
      grossAmount: Number(commission),
      commission: Number(commission),
      currency: String(currency || 'gameCoins'),
      occurredAt: Date.now(),
      refId: String(refId || 'admin-test'),
      recordedBy: 'server',
    });
    return res.json({ success: true, data: { entryId } });
  });

  // ============================================================
  // UGC 模板注册中心（合约工坊 CW-1）
  //   POST /ugc-templates/submit   提交注册（ACR 校验 → 风险分级 → 低/中自动过、高人工审）
  //   GET  /ugc-templates          公开市场列表（approved）；?mine=1 本人全部状态
  //   GET  /ugc-templates/detail   单模板详情（tpl 全量）
  //   POST /admin/ugc-templates/review  人工审核（approve 时固化 reviewedCodeHash 防 TOCTOU）
  // ============================================================

  /** 模板内容指纹（审核与部署两时刻比对，防"审核后偷改"） */
  function templateContentHash(tpl: unknown): string {
    try {
      return sha256hex(canonicalize(tpl as Record<string, unknown>));
    } catch {
      return sha256hex(JSON.stringify(tpl));
    }
  }

  /** UGC 模板文档瘦身（列表返回不含完整 clauses） */
  function ugcTemplateSlim(t: any): Record<string, unknown> {
    const tpl = t.tpl || {};
    return {
      key: t.key,
      authorId: t.authorId,
      authorName: t.authorName,
      version: tpl.version || t.version || 1,
      family: tpl.family,
      title: tpl.title || t.title,
      description: tpl.description || t.description,
      riskLevel: tpl.riskLevel || 'medium',
      requiresAudit: tpl.requiresAudit ?? t.requiresAudit ?? false,
      effectsWhitelist: tpl.effectsWhitelist || [],
      paramsSchema: tpl.paramsSchema || {},
      governanceTopics: tpl.governanceTopics || [],
      status: t.status,
      reviewNote: t.reviewNote,
      source: t.source,
      forkOf: t.forkOf,
      riskClass: t.riskClass,
      stats: t.stats || { deployCount: 0 },
      templateFeeBps: t.templateFeeBps || 0,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    };
  }

  /** POST /ugc-templates/submit — 提交模板进注册中心 */
  router.post('/ugc-templates/submit', async (req: Request, res: Response) => {
    if (!CONTRACTS_ENABLED) return res.status(403).json({ success: false, error: '合约模块未启用' });
    const userId = resolveUserId(req);
    if (!userId || userId === 'anonymous') return res.status(401).json({ success: false, error: '未登录' });
    const body: any = req.body || {};
    const tpl = body.tpl;
    if (!tpl || typeof tpl !== 'object') {
      return res.status(400).json({ success: false, error: '缺少模板体 tpl（ContractTemplate JSON）' });
    }
    // key 命名空间强制：ugc_<authorId>_<slug>（防冒名与键冲突）
    const slug = String(body.slug || String(tpl.key || '').replace(/^ugc_[^_]+_/, '')).toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40);
    if (!slug) return res.status(400).json({ success: false, error: '缺少模板 slug（key 后缀）' });
    const fullKey = `ugc_${userId}_${slug}`;
    tpl.key = fullKey;

    // ACR 全量校验（结构 + 安全 Lint）
    const acr = validateUgcTemplate(tpl);
    if (!acr.ok) {
      return res.status(400).json({ success: false, error: 'ACR 校验未通过', data: { issues: acr.issues } });
    }
    const risk = classifyTemplateRisk(tpl);

    const now = Date.now();
    const existing = await memoryDB.getUgcTemplateDoc(fullKey);
    if (existing && existing.authorId !== userId) {
      return res.status(403).json({ success: false, error: '模板 key 已被占用' });
    }

    const contentHash = templateContentHash(tpl);
    // 审核路径：low → 自动通过；medium → 规则引擎（ACR lint 即规则）自动通过 + 标记抽样；high → 人工
    const autoApproved = risk.level !== 'high';
    const doc = {
      key: fullKey,
      authorId: userId,
      authorName: String(body.authorName || userId),
      version: (existing?.version || 0) + 1,
      tpl,
      status: autoApproved ? 'approved' : 'pending',
      reviewPath: risk.level === 'medium' ? 'auto+sampled' : risk.level === 'low' ? 'auto' : 'manual',
      reviewedCodeHash: autoApproved ? contentHash : existing?.reviewedCodeHash || null,
      reviewNote: '',
      riskClass: risk,
      source: String(body.source || 'manual'), // 'ai' | 'manual' | 'fork'
      forkOf: body.forkOf ? String(body.forkOf) : undefined,
      templateFeeBps: Math.max(0, Math.min(1000, Number(body.templateFeeBps) || 0)), // 可选：部署抽成（bps，0=免费）
      stats: existing?.stats || { deployCount: 0 },
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    await memoryDB.putUgcTemplateDoc(doc);
    return res.json({
      success: true,
      data: {
        key: fullKey,
        status: doc.status,
        riskLevel: risk.level,
        riskReasons: risk.reasons,
        reviewPath: doc.reviewPath,
        version: doc.version,
      },
    });
  });

  /** GET /ugc-templates — 市场列表（公开 approved / ?mine=1 本人全部） */
  router.get('/ugc-templates', async (req: Request, res: Response) => {
    if (!CONTRACTS_ENABLED) return res.status(403).json({ success: false, error: '合约模块未启用' });
    const mine = String(req.query.mine || '') === '1';
    const viewerRole = resolveRole(req);
    let rows: any[];
    if (mine) {
      const userId = resolveUserId(req);
      if (!userId || userId === 'anonymous') return res.status(401).json({ success: false, error: '未登录' });
      rows = await memoryDB.listUgcTemplates({ authorId: userId });
    } else if (viewerRole === 'admin' || viewerRole === 'platform') {
      // 管理员可看待审队列
      rows = (await memoryDB.listUgcTemplates({})).concat(await memoryDB.listUgcTemplates({ status: 'pending' }));
      const seen = new Set<string>();
      rows = rows.filter((r) => (seen.has(r.key) ? false : (seen.add(r.key), true)));
    } else {
      rows = await memoryDB.listUgcTemplates({ status: 'approved' });
    }
    return res.json({ success: true, data: { templates: rows.map(ugcTemplateSlim) } });
  });

  /** GET /ugc-templates/detail?key= — 模板全量（含 clauses，供 fork / 沙盒回放） */
  router.get('/ugc-templates/detail', async (req: Request, res: Response) => {
    if (!CONTRACTS_ENABLED) return res.status(403).json({ success: false, error: '合约模块未启用' });
    const key = String(req.query.key || '');
    const doc = await memoryDB.getUgcTemplateDoc(key);
    if (!doc) return res.status(404).json({ success: false, error: `UGC 模板不存在: ${key}` });
    // 非公开状态：仅作者与平台可读
    const viewerId = resolveUserId(req);
    const viewerRole = resolveRole(req);
    if (doc.status !== 'approved' && doc.authorId !== viewerId && viewerRole !== 'admin' && viewerRole !== 'platform') {
      return res.status(403).json({ success: false, error: '模板未公开（待审/已驳回）' });
    }
    return res.json({ success: true, data: { template: { ...ugcTemplateSlim(doc), tpl: doc.tpl, reviewedCodeHash: doc.reviewedCodeHash } } });
  });

  /** POST /admin/ugc-templates/review — 人工审核（高风险模板 / 抽样） */
  router.post('/admin/ugc-templates/review', async (req: Request, res: Response) => {
    const denied = requireAdmin(req);
    if (denied) return res.status(403).json({ success: false, error: denied });
    const body: any = req.body || {};
    const doc = await memoryDB.getUgcTemplateDoc(String(body.key || ''));
    if (!doc) return res.status(404).json({ success: false, error: `UGC 模板不存在: ${body.key}` });
    if (doc.status !== 'pending') return res.status(409).json({ success: false, error: `模板状态为 ${doc.status}，非待审` });
    const approve = !!body.approve;
    if (approve) {
      // 审核通过：固化内容指纹（部署时重算比对，TOCTOU 防护）
      doc.reviewedCodeHash = templateContentHash(doc.tpl);
      doc.status = 'approved';
    } else {
      doc.status = 'rejected';
    }
    doc.reviewNote = String(body.note || '');
    doc.updatedAt = Date.now();
    await memoryDB.putUgcTemplateDoc(doc);
    return res.json({ success: true, data: { key: doc.key, status: doc.status } });
  });

  /** GET /templates — 模板列表（公开，含已过审 UGC） */
  router.get('/templates', async (_req: Request, res: Response) => {
    if (!CONTRACTS_ENABLED) return res.status(403).json({ success: false, error: '合约模块未启用' });
    const official = listTemplates().map((t) => ({
      // 官方模板 = 公开源码（合约工坊"点击查看代码"），与 verify 端点公开哲学一致
      ...t,
      autoExecute: CONTRACT_AUTO_EXECUTE[t.key] === true,
      ugc: false,
    }));
    // 已过审 UGC 模板并入公开市场（UGC 新模板默认影子模式：autoExecute=false）
    const ugcRows = await memoryDB.listUgcTemplates({ status: 'approved' });
    const ugcList = ugcRows.map((doc: any) => {
      const slim = ugcTemplateSlim(doc) as Record<string, any>;
      return {
        ...slim,
        autoExecute: false, // UGC 模板默认影子模式，开闸由平台管理（CONTRACT_AUTO_EXECUTE 不含 ugc_ 键）
        ugc: true,
      };
    });
    return res.json({ success: true, data: { templates: [...official, ...ugcList] } });
  });

  /** POST /deploy — 部署合约实例 */
  router.post('/deploy', async (req: Request, res: Response) => {
    if (!CONTRACTS_ENABLED) return res.status(403).json({ success: false, error: '合约模块未启用' });
    const userId = resolveUserId(req);
    if (!userId || userId === 'anonymous') return res.status(401).json({ success: false, error: '未登录' });
    const { templateKey, params, title } = req.body || {};
    // 模板解析：内置 REGISTRY → UGC 注册中心（approved）+ 内容指纹 TOCTOU 校验（CW-1）
    let tpl = getTemplate(templateKey);
    if (!tpl) {
      const ugcDoc = String(templateKey).startsWith('ugc_') ? await memoryDB.getUgcTemplateDoc(String(templateKey)) : null;
      if (!ugcDoc || ugcDoc.status !== 'approved') {
        return res.status(404).json({ success: false, error: `模板不存在: ${templateKey}` });
      }
      const nowHash = templateContentHash(ugcDoc.tpl);
      if (ugcDoc.reviewedCodeHash && ugcDoc.reviewedCodeHash !== nowHash) {
        return res.status(409).json({ success: false, error: '模板内容与审核版本不一致（已被修改），拒绝部署' });
      }
      const acr = validateUgcTemplate(ugcDoc.tpl);
      if (!acr.ok) {
        return res.status(400).json({ success: false, error: 'UGC 模板校验未通过', data: { issues: acr.issues } });
      }
      tpl = ugcDoc.tpl;
      // 部署计数（市场统计）
      ugcDoc.stats = { ...(ugcDoc.stats || {}), deployCount: (ugcDoc.stats?.deployCount || 0) + 1 };
      ugcDoc.updatedAt = Date.now();
      await memoryDB.putUgcTemplateDoc(ugcDoc);
    }
    if (!tpl) return res.status(404).json({ success: false, error: `模板不存在: ${templateKey}` });

    const tplCheck = validateTemplate(tpl);
    if (!tplCheck.ok) {
      return res.status(500).json({ success: false, error: '模板静态校验失败（服务端 bug）', data: { issues: tplCheck.issues } });
    }
    const paramCheck = validateParams(tpl.paramsSchema, params || {});
    if (!paramCheck.ok) {
      return res.status(400).json({ success: false, error: '参数校验未通过', data: { issues: paramCheck.issues } });
    }

    // 发起人身份一致性：initiatorId（GSO 为 issuerId）必须是本人（防冒名发起）
    const declaredInitiator = String(params.initiatorId ?? params.issuerId ?? '');
    if (declaredInitiator !== userId) {
      return res.status(403).json({ success: false, error: '发起人（initiatorId/issuerId）必须与登录身份一致' });
    }

    // 🆕 GSO 收益权出让审核（2026-10-10）：只有游戏发布者（当前份额持有者）可发行 GSO——
    // 无份额账户（即使登录身份与 issuerId 一致）不得出让他人游戏的收益权。
    if (templateKey === 'gso') {
      const gsoGameId = String(params.gameId || '');
      const game = gsoGameId ? await memoryDB.getPublishedGame(gsoGameId) : null;
      if (!game || !game.publisherId) {
        return res.status(404).json({ success: false, error: `GSO 发行失败：游戏档案不存在（${gsoGameId}），无法核验收益份额归属` });
      }
      if (game.publisherId !== userId) {
        return res.status(403).json({
          success: false,
          error: `GSO 发行失败：只有游戏发布者（当前收益份额持有者 ${game.publisherId}）才能发行该游戏的 GSO，当前登录为 ${userId}`,
        });
      }
    }

    const clauses = tpl.clauses;
    const codeHash = computeCodeHash({
      templateKey: tpl.key,
      templateVersion: tpl.version,
      clauses,
      params,
    });

    const now = Date.now();
    const id = newId('ctr');
    // 🆕 私域合约（2026-10-10）：部署时可携带参与名单（可选）。
    // 非空 = 私域：仅名单内成员（含发起人豁免）可 join/subscribe；缺省/空 = 公开合约（大厅招募）。
    const rawWhitelist = Array.isArray((req.body || {}).whitelist) ? ((req.body as any).whitelist as unknown[]) : null;
    const whitelist: string[] | undefined = rawWhitelist
      ? Array.from(new Set(rawWhitelist.map((x) => String(x || '').trim()).filter(Boolean))).slice(0, 500)
      : undefined;

    const instance: ContractInstance = {
      id,
      templateKey: tpl.key,
      templateVersion: tpl.version,
      family: tpl.family,
      codeHash,
      integrity: { sig: hmacSign(codeHash), signedBy: 'server', signedAt: now },
      upgradePolicy: 'immutable',
      initiatorId: userId,
      gameId: params.gameId ? String(params.gameId) : undefined,
      whitelist: whitelist && whitelist.length > 0 ? whitelist : undefined,
      params,
      clauses,
      parties: [
        { userId, role: 'initiator', stake: [], joinedAt: now, signedAt: now },
      ],
      escrow: { voucherIds: [], walletHold: [] },
      state: tpl.requiresAudit ? 'draft' : 'signing',
      // UGC 模板：按 clauses.updates 预置自定义 state 字段（引擎 evaluate 读未初始化字段得 null，算术即抛错）
      // 🆕 2026-10-18：发起人自动入团（memberCount 起始 1，contributions 预挂发起人 0 贡献）
      stateData: String(tpl.key).startsWith('ugc_')
        ? deriveInitialStateData(tpl)
        : tpl.key === 'team-quest'
          ? { memberCount: 1, totalRaised: 0, score: 0, poolFunded: 0, contributions: [{ userId, amount: 0 }] }
          : { memberCount: 0, totalRaised: 0, score: 0, poolFunded: 0, contributions: [] },
      history: [],
      seed: sha256hex(`${id}|${codeHash}`).slice(0, 32),
      autoExecute: CONTRACT_AUTO_EXECUTE[tpl.key] === true,
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
    const genesis = appendEvent(instance.history, {
      at: now,
      type: 'deployed',
      actorId: userId,
      payload: { templateKey: tpl.key, templateVersion: tpl.version, codeHash, title: title || tpl.title },
    });
    instance.history.push(genesis);
    await memoryDB.putContractInstance(instance);

    // 🆕 私域邀请私信（2026-10-11）：服务端生成通知（剔除发起人，幂等 id），失败不阻塞部署。
    // 仅非审核模板（state=signing）立即发送；requiresAudit 模板在 admin/review 通过后再发
    // （draft 阶段成员无法 join，提前发邀请会产生「点进去加入被拒」的死信）
    try {
      const invites = instance.state === 'signing' ? buildContractInviteNotifications(instance, title || tpl.title) : [];
      for (const n of invites) {
        await memoryDB.putNotification(n);
      }
      if (invites.length > 0) {
        console.log(`[contract] 私域邀请通知已发出：${invites.length} 条（${id}）`);
      }
    } catch (e) {
      console.warn('[contract] 私域邀请通知生成失败（不影响部署）:', e instanceof Error ? e.message : String(e));
    }

    return res.json({
      success: true,
      data: {
        contractId: id,
        codeHash,
        state: instance.state,
        autoExecute: instance.autoExecute,
        requiresAudit: tpl.requiresAudit,
      },
    });
  });

  /** POST /sign — 参与方签署 */
  router.post('/sign', async (req: Request, res: Response) => {
    const userId = resolveUserId(req);
    if (!userId || userId === 'anonymous') return res.status(401).json({ success: false, error: '未登录' });
    const { contractId } = req.body || {};
    const inst: ContractInstance | null = await memoryDB.getContractInstance(String(contractId || ''));
    if (!inst) return res.status(404).json({ success: false, error: '合约不存在' });
    const party = inst.parties.find((p: any) => p.userId === userId);
    if (!party) return res.status(403).json({ success: false, error: '你不是该合约参与方' });
    if (party.signedAt) return res.json({ success: true, data: { alreadySigned: true } });
    party.signedAt = Date.now();
    const ev = appendEvent(inst.history, {
      at: Date.now(),
      type: 'signed',
      actorId: userId,
      payload: { partyCount: inst.parties.length, signedCount: inst.parties.filter((p: any) => p.signedAt).length },
    });
    inst.history.push(ev);
    inst.updatedAt = Date.now();
    await memoryDB.putContractInstance(inst);
    return res.json({ success: true, data: { contractId: inst.id, signedCount: inst.parties.filter((p: any) => p.signedAt).length } });
  });

  /** POST /invoke — manual 触发 */
  router.post('/invoke', async (req: Request, res: Response) => {
    const userId = resolveUserId(req);
    if (!userId || userId === 'anonymous') return res.status(401).json({ success: false, error: '未登录' });
    const { contractId, action, payload: actionPayload } = req.body || {};
    if (!contractId || !action) return res.status(400).json({ success: false, error: 'missing contractId or action' });
    const inst: ContractInstance | null = await memoryDB.getContractInstance(String(contractId));
    if (!inst) return res.status(404).json({ success: false, error: '合约不存在' });
    if (inst.state === 'draft') return res.status(409).json({ success: false, error: '合约待审核中' });

    // 🆕 私域合约门禁（2026-10-10）：进入类动作（join/subscribe）仅限名单内成员，发起人豁免
    // （TeamQuest 团长必须能 join 开团；GSO 发起人是 issuer 不参与认购）。
    // 其余 manual 动作（leave/fund-pool/dispute/settle…）与 cron 不受限——监督权不下放给名单。
    if ((action === 'join' || action === 'subscribe') && isEntryBlockedByWhitelist(inst.whitelist, userId, inst.initiatorId)) {
      const wlCount = Array.isArray(inst.whitelist) ? inst.whitelist.length : 0;
      return res.status(403).json({
        success: false,
        error: `私域合约：仅名单内 ${wlCount} 名成员可参与（发起人 ${inst.initiatorId}），当前登录 ${userId}`,
      });
    }

    // 幂等：客户端可传 triggerId 保证重试安全；否则服务端生成
    const triggerId = String((req.body || {}).triggerId || '') || newId('tq');

    // __protocol：贡献进度上报（TeamQuest 事实源通道）
    // 双通道（P3，2026-10-15）：
    // ① 团长（initiator）代报——MVP 过渡方案，身份由 JWT 担保；
    // ② 成员本人自报（targetUserId === 登录身份）——身份即事实源，可信度高于代报。
    // B4 完整版：GamePlay 桥接真实游戏事件 + 服务端 channelToken 验签（游戏 SDK 已透传
    // channelToken，服务端验签基建接入后可直接替换本通道）。
    let triggerKind: TriggerEvent['kind'] = 'manual';
    let triggerType = String(action);
    let protocolPayload: Record<string, unknown> = { ...(actionPayload || {}), userId, reason: (actionPayload || {}).reason ?? '（未填写）' };
    if (action === '__protocol') {
      const targetUserId = String((actionPayload || {}).targetUserId || userId);
      const isSelfReport = targetUserId === userId;
      if (inst.initiatorId !== userId && !isSelfReport) {
        return res.status(403).json({ success: false, error: '仅发起人（团长）或成员本人（自报通道）可上报进度' });
      }
      const points = Number((actionPayload || {}).points);
      if (!targetUserId || !Number.isFinite(points)) {
        return res.status(400).json({ success: false, error: '缺少 targetUserId 或 points' });
      }
      if (points < 0 || points > 100000) {
        return res.status(400).json({ success: false, error: 'points 须在 0..100000' });
      }
      // 防骗分：目标必须是已加入团队的成员（contributions 中存在其 userId）
      const members = Array.isArray(inst.stateData.contributions) ? inst.stateData.contributions as Array<Record<string, unknown>> : [];
      const isMember = members.some((m) => m && m.userId === targetUserId);
      if (!isMember) {
        return res.status(403).json({ success: false, error: `目标 ${targetUserId} 不是该团队成员，拒绝上报` });
      }
      const protoOn = inst.clauses.map((c) => c.on).find((on) => on.kind === 'protocol' && on.match && on.match.endsWith(':*'));
      const prefix = protoOn ? String(protoOn.match).slice(0, -1) : 'GAME_EVENT:';
      triggerKind = 'protocol';
      triggerType = `${prefix}${String((actionPayload || {}).event || 'SCORE')}`;
      protocolPayload = { userId: targetUserId, points };
    }

    const ev: TriggerEvent = makeTriggerEvent({
      triggerId,
      kind: triggerKind,
      type: triggerType,
      at: Date.now(),
      actorId: userId,
      payload: protocolPayload,
      ...(triggerKind === 'protocol' ? { channelTokenValid: true } : {}),
    });

    const result = executeTrigger(inst, ev, { now: Date.now() });
    if (!result.plan) {
      return res.status(409).json({
        success: false,
        error: result.reasonDetail || ({ 'duplicate-trigger': '重复触发（幂等跳过）', 'no-matching-clause': '无匹配条款', 'condition-not-met': '条件未满足' } as Record<string, string>)[result.reason || ''] || result.reason,
        code: result.reason,
      });
    }
    const applied = await applyPlan(inst, result.plan);
    if (!applied.applied) {
      if (applied.conflict) {
        return res.status(409).json({ success: false, error: applied.error, code: 'conflict' });
      }
      return res.status(applied.error ? 422 : 200).json({
        success: !applied.error,
        error: applied.error,
        data: { shadow: result.plan.shadow, plan: result.plan },
      });
    }
    return res.json({
      success: true,
      data: {
        contractId: inst.id,
        state: inst.state,
        stateData: inst.stateData,
        clauseIds: result.plan.clauseIds,
        idempotencyKey: result.plan.idempotencyKey,
      },
    });
  });

  /** POST /tick — cron 驱动（deadline-check / settlement-weekly / settlement-monthly） */
  router.post('/tick', async (_req: Request, res: Response) => {
    if (!CONTRACTS_ENABLED) return res.status(403).json({ success: false, error: '合约模块未启用' });
    const now = Date.now();
    const live = await memoryDB.listContractInstances({});
    const activeStates = ['signing', 'active', 'settling'];
    const targets = live.filter((c: ContractInstance) => activeStates.includes(c.state));
    const summary: Array<{ contractId: string; action: string; applied?: boolean; error?: string }> = [];

    for (const inst of targets) {
      if (inst.history.length > 400) continue; // 软限制：事件链过长待归档（B6）
      // 判定该合约有哪些到期的 cron 调度
      const schedules = new Set<string>();
      for (const clause of inst.clauses) {
        if (clause.on.kind === 'cron' && (clause.on.enabledStates || ['funded', 'active']).includes(inst.state)) {
          schedules.add(clause.on.schedule || 'deadline-check');
        }
      }
      for (const schedule of schedules) {
        const payload: Record<string, unknown> = {};
        if (schedule.startsWith('settlement-')) {
          // GSO 收益分成：服务端查 revenue_ledger 注入周期收益（事实源）
          const gameId = inst.gameId || (inst.params.gameId as string) || '';
          const periodMs = schedule === 'settlement-weekly' ? 7 * 24 * 3600 * 1000 : 30 * 24 * 3600 * 1000;
          const sources = (inst.params.revenueSources as string[]) || [];
          let total = 0;
          for (const src of sources) {
            total += await memoryDB.sumRevenue(gameId, src, now - periodMs, now);
          }
          payload.periodRevenue = total;
          payload.periodStart = now - periodMs;
          payload.periodEnd = now;
        }
        const ev = makeTriggerEvent({
          // B-1 修复（致命）：triggerId 必须确定性——随机 ID 会让"部分成功后死信重试"
          // 用新 txId 再次执行已成功的资金效果 = 双花。确定性 ID + saga txId 幂等 → 重放安全。
          // 桶：deadline-check=1h；settlement-weekly=7d；settlement-monthly=30d
          triggerId: `tick:${inst.id}:${schedule}:${tickBucket(schedule, now)}`,
          kind: 'cron',
          type: schedule,
          at: now,
          actorId: 'system',
          payload,
        });
        const result = executeTrigger(inst, ev, { now });
        if (!result.plan) continue;
        const applied = await applyPlan(inst, result.plan);
        summary.push({ contractId: inst.id, action: schedule, applied: applied.applied, error: applied.error });
        if (applied.applied) {
          // 重新载入（state 可能已迁移）
          const fresh = await memoryDB.getContractInstance(inst.id);
          if (fresh) Object.assign(inst, fresh);
        }
      }
      // 🆕 拼团履约补发（2026-10-16）：成团时池无货的合约，每次 tick 自愈重试发货
      if (inst.templateKey === 'group-buy' && inst.state === 'settling') {
        const historyLenBefore = inst.history.length;
        await fulfillGroupBuyItems(inst);
        // 履约过程追加了事件（发货/缺货告警）→ 持久化，否则事件账本丢失
        if (inst.history.length > historyLenBefore) {
          inst.updatedAt = Date.now();
          await memoryDB.putContractInstance(inst);
        }
      }
    }
    return res.json({ success: true, data: { scanned: targets.length, executed: summary.length, summary } });
  });

  /** GET /query — 实例列表 */
  router.get('/query', async (req: Request, res: Response) => {
    const filter: Record<string, string> = {};
    for (const k of ['state', 'family', 'initiatorId', 'gameId']) {
      if (req.query[k]) filter[k] = String(req.query[k]);
    }
    const rows = await memoryDB.listContractInstances(filter);
    // 🆕 私域合约可见性（2026-10-10）：仅发起人 / 名单内成员 / 平台角色可见；名单外与匿名在大厅隐藏
    const viewerId = resolveUserId(req);
    const viewerRole = resolveRole(req);
    const visibleRows = rows.filter(
      (r: any) => !isHiddenFromViewer(r.whitelist, viewerId, r.initiatorId, viewerRole),
    );
    // 列表瘦身：不含 clauses/history
    const slim = visibleRows.map((r: any) => ({
      id: r.id,
      templateKey: r.templateKey,
      templateVersion: r.templateVersion,
      family: r.family,
      codeHash: r.codeHash,
      initiatorId: r.initiatorId,
      gameId: r.gameId,
      whitelist: Array.isArray(r.whitelist) && r.whitelist.length > 0 ? r.whitelist : undefined,
      params: r.params,
      state: r.state,
      stateData: r.stateData,
      partyCount: (r.parties || []).length,
      historyCount: (r.history || []).length,
      autoExecute: r.autoExecute,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
    slim.sort((a: any, b: any) => b.updatedAt - a.updatedAt);
    return res.json({ success: true, data: { contracts: slim } });
  });

  /** GET /detail?id= — 实例详情（含事件链） */
  router.get('/detail', async (req: Request, res: Response) => {
    const id = String(req.query.id || '');
    const inst = await memoryDB.getContractInstance(id);
    if (!inst) return res.status(404).json({ success: false, error: '合约不存在' });
    return res.json({ success: true, data: { contract: inst } });
  });

  /** GET /verify?id= — 公开复算（规则指纹 + 事件链完整性） */
  router.get('/verify', async (req: Request, res: Response) => {
    const id = String(req.query.id || '');
    const inst: ContractInstance | null = await memoryDB.getContractInstance(id);
    if (!inst) return res.status(404).json({ success: false, error: '合约不存在' });
    const rule = verifyCodeHash(inst.templateKey, inst.templateVersion, inst.clauses, inst.params, inst.codeHash);
    const chain = verifyChain(inst.history);
    const integrityOk = inst.integrity
      ? hmacSign(inst.codeHash) === inst.integrity.sig
      : null;
    return res.json({
      success: true,
      data: {
        intact: rule.intact && chain.intact && integrityOk !== false,
        codeHash: inst.codeHash,
        recomputed: rule.recomputed,
        ruleIntact: rule.intact,
        chainIntact: chain.intact,
        chainLength: chain.length,
        chainBrokenAt: chain.brokenAt ?? null,
        signatureValid: integrityOk,
        state: inst.state,
        historyCount: inst.history.length,
      },
    });
  });

  /** GET /escrow?id= — 托管台账（合约维度） */
  router.get('/escrow', async (req: Request, res: Response) => {
    const contractId = String(req.query.id || '');
    const entries = (await memoryDB.listEscrowByContract(contractId)) || [];
    return res.json({ success: true, data: { entries } });
  });

  /** GET /admin/overview — 平台监控台（B6） */
  router.get('/admin/overview', async (req: Request, res: Response) => {
    const denied = requireAdmin(req);
    if (denied) return res.status(403).json({ success: false, error: denied });
    const all = await memoryDB.listContractInstances({});
    const byState: Record<string, number> = {};
    const deadLetters: any[] = [];
    const shadowPlans: any[] = [];
    for (const c of all) {
      byState[c.state] = (byState[c.state] || 0) + 1;
      for (const h of c.history || []) {
        if (h.type === 'effect-failed') {
          deadLetters.push({ contractId: c.id, templateKey: c.templateKey, seq: h.seq, at: h.at, planId: (h.payload as any).planId, error: (h.payload as any).error });
        } else if (h.type === 'shadow-plan') {
          shadowPlans.push({ contractId: c.id, templateKey: c.templateKey, seq: h.seq, at: h.at, clauseIds: ((h.payload as any).plan || {}).clauseIds });
        }
      }
    }
    const escrows = Array.from((await memoryDB.listAllEscrows?.() || [])) as any[];
    const escrowSummary: Record<string, number> = {};
    for (const e of escrows) {
      if (e.status !== 'locked') continue;
      const k = `${e.currency}`;
      escrowSummary[k] = (escrowSummary[k] || 0) + e.amount;
    }
    return res.json({
      success: true,
      data: {
        totalContracts: all.length,
        byState,
        escrowSummary,
        deadLetters: deadLetters.slice(-50),
        shadowPlans: shadowPlans.slice(-100),
        deadLetterCount: deadLetters.length,
      },
    });
  });

  /** POST /admin/review — 合约审核（requiresAudit：draft → signing） */
  router.post('/admin/review', async (req: Request, res: Response) => {
    const denied = requireAdmin(req);
    if (denied) return res.status(403).json({ success: false, error: denied });
    const { contractId, approve, note } = req.body || {};
    const inst: ContractInstance | null = await memoryDB.getContractInstance(String(contractId || ''));
    if (!inst) return res.status(404).json({ success: false, error: '合约不存在' });
    if (inst.state !== 'draft') return res.status(409).json({ success: false, error: `合约状态为 ${inst.state}，非待审` });
    inst.state = approve ? 'signing' : 'terminated';
    const ev = appendEvent(inst.history, {
      at: Date.now(),
      type: approve ? 'review-approved' : 'review-rejected',
      actorId: resolveUserId(req),
      payload: { note: String(note || '') },
    });
    inst.history.push(ev);
    inst.updatedAt = Date.now();
    await memoryDB.putContractInstance(inst);
    // 🆕 审核通过（draft → signing）补发私域邀请私信（deploy 时不发审核模板）
    if (approve) {
      try {
        const invites = buildContractInviteNotifications(inst);
        for (const n of invites) await memoryDB.putNotification(n);
        if (invites.length > 0) console.log(`[contract] 审核通过，私域邀请通知已发出：${invites.length} 条（${inst.id}）`);
      } catch (e) {
        console.warn('[contract] 审核通过后通知生成失败:', e instanceof Error ? e.message : String(e));
      }
    }
    return res.json({ success: true, data: { contractId: inst.id, state: inst.state } });
  });

  /**
   * 🆕 P0b（2026-10-15）：POST /admin/arbitrate — 争议仲裁（disputed 终局）
   *
   * 此前 disputed 状态不进 tick 扫描、无任何出口 → 托管资金永久冻结。本端点补齐出口：
   * - ruling=refund  ：全部 locked 托管原路退回出资人（payment/pool/bond），state → refunded
   * - ruling=release ：货款/奖池（payment/pool，GSO 含无 purpose 认购款）交割给发起人；
   *                    A币凭证类托管转给发起人；保证金（bond）退回成员，state → terminated
   * 事件链追加 'arbitrated' 事件（含裁决与备注），全程可审计。
   */
  router.post('/admin/arbitrate', async (req: Request, res: Response) => {
    const denied = requireAdmin(req);
    if (denied) return res.status(403).json({ success: false, error: denied });
    const { contractId, ruling, note } = req.body || {};
    const inst: ContractInstance | null = await memoryDB.getContractInstance(String(contractId || ''));
    if (!inst) return res.status(404).json({ success: false, error: '合约不存在' });
    if (inst.state !== 'disputed') return res.status(409).json({ success: false, error: `合约状态为 ${inst.state}，非争议中` });
    const r = String(ruling || '');
    if (r !== 'refund' && r !== 'release') {
      return res.status(400).json({ success: false, error: 'ruling 须为 refund（全员退款）或 release（放行给收款方）' });
    }
    const arbId = `arb_${inst.id}_${r}`;
    try {
      if (r === 'refund') {
        await escrowRefundAll(inst.id, arbId); // 全部 locked 原路退回（payment/pool/bond）
        inst.state = 'refunded';
      } else {
        const entries = (await memoryDB.listEscrowByContract(inst.id)) || [];
        // 钱包类：货款/奖池放行给发起人（GSO 认购款无 purpose 一并放行）
        const walletTargets = entries.filter(
          (e: any) => e.status === 'locked' && e.kind === 'wallet' &&
            (e.purpose === 'payment' || e.purpose === 'pool' || (inst.templateKey === 'gso' && !e.purpose)),
        );
        for (const e of walletTargets) {
          await escrowRelease(inst.id, inst.initiatorId, e.currency, e.amount, `${arbId}:${e.entryId}`, '仲裁放行（交割给收款方）', e.purpose);
        }
        // 凭证类（A币托管）：凭证持有权转给发起人
        const voucherEntries = entries.filter((e: any) => e.status === 'locked' && e.kind === 'voucher');
        for (const e of voucherEntries) {
          for (const vid of e.voucherIds || []) {
            const v = await memoryDB.getVoucherDoc(vid);
            if (v && v.currentHolderId === `contract-escrow:${inst.id}`) {
              v.currentHolderId = inst.initiatorId;
              v.lastTransferAt = Date.now();
              await memoryDB.putVoucherDoc(vid, v);
            }
          }
          e.status = 'released';
          e.releasedAt = Date.now();
          e.releasedTo = inst.initiatorId;
          await memoryDB.putEscrowEntry(e);
        }
        // 保证金退回成员
        await escrowRefundAll(inst.id, arbId, 'bond');
        inst.state = 'terminated';
      }
    } catch (e) {
      return res.status(500).json({ success: false, error: `仲裁执行失败：${e instanceof Error ? e.message : String(e)}` });
    }
    const ev = appendEvent(inst.history, {
      at: Date.now(),
      type: 'arbitrated',
      actorId: resolveUserId(req),
      payload: { ruling: r, note: String(note || '') },
    });
    inst.history.push(ev);
    inst.updatedAt = Date.now();
    await memoryDB.putContractInstance(inst);
    return res.json({ success: true, data: { contractId: inst.id, state: inst.state, ruling: r } });
  });

  // 兜底
  router.use((_req: Request, res: Response) => {
    res.status(404).json({ success: false, error: 'unknown __contract endpoint' });
  });

  return router;
}
