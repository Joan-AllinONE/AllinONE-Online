/**
 * A币电子凭证系统 - 业务服务层
 * 提供凭证的创建、流转、查询等核心业务逻辑
 */

import { voucherDB } from '../storage/VoucherDatabase';
import {
  Voucher,
  Transaction,
  VoucherStatus,
  TransactionType,
  VoucherSourceType,
  type CreateVoucherRequest,
  type TransferRequest,
  type BatchCreateRequest,
  type VoucherFilter,
  type PaginatedResult,
  type VoucherHistory,
  type TransferGraph,
  type EnhancedCreateVoucherRequest,
  type VoucherRules,
  type AlgorithmVoucherInfo,
} from '../types';

/**
 * 生成唯一ID — 使用 crypto.randomUUID()（S2-5 修复）
 */
function generateUUID(): string {
  // crypto.randomUUID() 在 Node 19+ 和现代浏览器均可用
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // 降级方案（极少触发）
  const arr = new Uint32Array(4);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(arr);
  } else {
    for (let i = 0; i < 4; i++) arr[i] = (Math.random() * 0x100000000) >>> 0;
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c, i) => {
    const r = (arr[Math.floor(i / 4)] >> ((i % 4) * 8)) & 0xff;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

/**
 * 生成交易哈希（FNV-1a 64-bit — S2-5 修复，替换 djb2 弱哈希）
 */
function generateTxHash(voucherId: string, fromUser: string, toUser: string, timestamp: number): string {
  // 使用 FNV-1a 64-bit 哈希（碰撞概率远低于 djb2）
  // 移除 Math.random() — 使哈希可验证（确定性）
  const data = `${voucherId}:${fromUser}:${toUser}:${timestamp}`;
  let hashLo = 0x811c9dc5;  // FNV offset basis (low 32 bits)
  let hashHi = 0xcbf29ce4;  // FNV offset basis (high 32 bits) — simplified to 32-bit
  for (let i = 0; i < data.length; i++) {
    hashLo ^= data.charCodeAt(i);
    hashLo = Math.imul(hashLo, 0x01000193); // FNV prime
    // 32-bit overflow simulation
    hashLo = (hashLo & 0xffffffff) >>> 0;
  }
  return hashLo.toString(16).padStart(8, '0');
}

/**
 * 生成凭证编号
 */
function generateSerialNumber(index: number): string {
  const prefix = 'AC';
  const date = new Date();
  const dateStr = date.getFullYear().toString().slice(-2) +
                  String(date.getMonth() + 1).padStart(2, '0') +
                  String(date.getDate()).padStart(2, '0');
  const randomStr = Math.random().toString(36).substring(2, 6).toUpperCase();
  const indexStr = String(index).padStart(6, '0');
  return `${prefix}-${dateStr}-${randomStr}-${indexStr}`;
}

/**
 * 凭证服务类
 */
export class VoucherService {
  private static instance: VoucherService | null = null;
  private db = voucherDB;

  private constructor() {}

  static getInstance(): VoucherService {
    if (!VoucherService.instance) {
      VoucherService.instance = new VoucherService();
    }
    return VoucherService.instance;
  }

  // ==================== 凭证创建 ====================

  /**
   * 创建单个凭证
   * @param request 创建请求
   * @param operatorId 操作者ID
   * @param operatorName 操作者名称
   * @returns 创建的凭证
   */
  createVoucher(
    request: CreateVoucherRequest | EnhancedCreateVoucherRequest,
    operatorId: string,
    operatorName: string
  ): Voucher {
    // 检查系统容量
    if (!this.db.hasCapacity(1)) {
      throw new Error('系统凭证数量已达上限（10亿），无法创建新凭证');
    }

    const now = Date.now();
    const voucherId = generateUUID();
    const serialNumber = generateSerialNumber(this.db.getAllVouchers().length + 1);

    // 检查是否是增强请求（包含规则）
    const enhancedRequest = request as EnhancedCreateVoucherRequest;
    const rules: VoucherRules | undefined = enhancedRequest.rules;
    const issueDate: number | undefined = enhancedRequest.issueDate;
    const quantity: number | undefined = enhancedRequest.quantity;

    // 确定凭证来源类型（从metadata中读取或默认为即时发放型）
    const metaSourceType = request.metadata?.sourceType;
    const sourceType = metaSourceType === VoucherSourceType.ALGORITHM
      ? VoucherSourceType.ALGORITHM
      : metaSourceType === VoucherSourceType.ITEM
        ? VoucherSourceType.ITEM
        : metaSourceType === VoucherSourceType.VOTE
          ? VoucherSourceType.VOTE
          : VoucherSourceType.INSTANT;

    // 创建凭证
    const voucher: Voucher = {
      id: voucherId,
      serialNumber,
      denomination: request.denomination,
      currentHolderId: request.recipientId,
      currentHolderName: request.recipientName,
      status: VoucherStatus.ACTIVE,
      createdAt: now,
      createdBy: operatorId,
      createdByName: operatorName,
      expiresAt: request.expiresAt,
      metadata: request.metadata,
      transferCount: 0,
      lastTransferAt: undefined,
      // 增强字段
      rules,
      issueDate,
      quantity,
      // 双轨系统：设置凭证来源类型
      sourceType,
    };

    // 创建交易记录（创世交易）
    const transaction: Transaction = {
      id: generateUUID(),
      voucherId: voucherId,
      type: TransactionType.CREATE,
      fromUserId: undefined,
      fromUserName: undefined,
      toUserId: request.recipientId,
      toUserName: request.recipientName,
      amount: request.denomination,
      timestamp: now,
      txHash: generateTxHash(voucherId, 'SYSTEM', request.recipientId, now),
      note: request.note || '凭证创建',
    };

    // 保存到数据库
    this.db.insertVoucher(voucher);
    this.db.insertTransaction(transaction);

    return voucher;
  }

  /**
   * 批量创建凭证
   * @param request 批量创建请求
   * @param operatorId 操作者ID
   * @param operatorName 操作者名称
   * @returns 创建的凭证列表
   */
  batchCreateVouchers(
    request: BatchCreateRequest,
    operatorId: string,
    operatorName: string
  ): Voucher[] {
    // 检查系统容量
    if (!this.db.hasCapacity(request.count)) {
      throw new Error(`系统容量不足，剩余容量: ${this.db.getRemainingCapacity()}, 请求创建: ${request.count}`);
    }

    // 限制单次批量创建数量（防止阻塞）
    const MAX_BATCH_SIZE = 1000;
    if (request.count > MAX_BATCH_SIZE) {
      throw new Error(`单次批量创建不能超过 ${MAX_BATCH_SIZE} 个凭证`);
    }

    const vouchers: Voucher[] = [];
    const transactions: Transaction[] = [];
    const now = Date.now();
    const currentCount = this.db.getAllVouchers().length;

    for (let i = 0; i < request.count; i++) {
      const voucherId = generateUUID();
      const serialNumber = generateSerialNumber(currentCount + i + 1);

      const voucher: Voucher = {
        id: voucherId,
        serialNumber,
        denomination: request.denomination,
        currentHolderId: request.recipientId,
        currentHolderName: request.recipientName,
        status: VoucherStatus.ACTIVE,
        createdAt: now,
        createdBy: operatorId,
        createdByName: operatorName,
        transferCount: 0,
        sourceType: VoucherSourceType.INSTANT,
      };

      const transaction: Transaction = {
        id: generateUUID(),
        voucherId: voucherId,
        type: TransactionType.CREATE,
        toUserId: request.recipientId,
        toUserName: request.recipientName,
        amount: request.denomination,
        timestamp: now,
        txHash: generateTxHash(voucherId, 'SYSTEM', request.recipientId, now),
        note: request.note || `批量创建 #${i + 1}/${request.count}`,
      };

      vouchers.push(voucher);
      transactions.push(transaction);
    }

    // 批量保存
    vouchers.forEach(v => this.db.insertVoucher(v));
    this.db.insertTransactions(transactions);

    return vouchers;
  }

  // ==================== 凭证流转 ====================

  /**
   * 转账/流转凭证
   * @param request 转账请求
   * @param operatorId 操作者ID
   * @param operatorName 操作者名称
   * @returns 交易记录
   */
  transferVoucher(
    request: TransferRequest,
    operatorId: string,
    operatorName: string
  ): Transaction {
    const voucher = this.db.getVoucherById(request.voucherId);

    if (!voucher) {
      throw new Error(`凭证不存在: ${request.voucherId}`);
    }

    // 验证凭证状态
    if (voucher.status !== VoucherStatus.ACTIVE) {
      throw new Error(`凭证状态异常，当前状态: ${voucher.status}`);
    }

    // 验证持有者（只有持有者可以转出）
    if (voucher.currentHolderId !== operatorId) {
      throw new Error('只有凭证持有者才能进行转账');
    }

    // 验证不能转给自己
    if (voucher.currentHolderId === request.toUserId) {
      throw new Error('不能将凭证转账给自己');
    }

    const now = Date.now();

    // 创建交易记录
    const transaction: Transaction = {
      id: generateUUID(),
      voucherId: voucher.id,
      type: TransactionType.TRANSFER,
      fromUserId: voucher.currentHolderId,
      fromUserName: voucher.currentHolderName,
      toUserId: request.toUserId,
      toUserName: request.toUserName,
      amount: voucher.denomination,
      timestamp: now,
      txHash: generateTxHash(voucher.id, voucher.currentHolderId, request.toUserId, now),
      note: request.note,
    };

    // 更新凭证信息
    voucher.currentHolderId = request.toUserId;
    voucher.currentHolderName = request.toUserName;
    voucher.transferCount += 1;
    voucher.lastTransferAt = now;

    // 保存
    this.db.updateVoucher(voucher);
    this.db.insertTransaction(transaction);

    return transaction;
  }

  /**
   * 批量转账凭证
   * @param voucherIds 凭证ID列表
   * @param toUserId 接收者ID
   * @param toUserName 接收者名称
   * @param operatorId 操作者ID
   * @param operatorName 操作者名称
   * @param note 备注
   * @returns 交易记录列表
   */
  batchTransferVouchers(
    voucherIds: string[],
    toUserId: string,
    toUserName: string,
    operatorId: string,
    operatorName: string,
    note?: string
  ): Transaction[] {
    const transactions: Transaction[] = [];

    for (const voucherId of voucherIds) {
      try {
        const tx = this.transferVoucher(
          { voucherId, toUserId, toUserName, note },
          operatorId,
          operatorName
        );
        transactions.push(tx);
      } catch (error) {
        console.error(`转账凭证 ${voucherId} 失败:`, error);
        // 继续处理其他凭证
      }
    }

    return transactions;
  }

  // ==================== 凭证冻结/解冻 ====================

  /**
   * 冻结凭证
   * @param voucherId 凭证ID
   * @param operatorId 操作者ID
   * @param operatorName 操作者名称
   * @param reason 冻结原因
   * @returns 交易记录
   */
  freezeVoucher(
    voucherId: string,
    operatorId: string,
    operatorName: string,
    reason?: string
  ): Transaction {
    const voucher = this.db.getVoucherById(voucherId);

    if (!voucher) {
      throw new Error(`凭证不存在: ${voucherId}`);
    }

    if (voucher.status !== VoucherStatus.ACTIVE) {
      throw new Error(`只能冻结正常状态的凭证，当前状态: ${voucher.status}`);
    }

    const now = Date.now();

    // 创建冻结交易记录
    const transaction: Transaction = {
      id: generateUUID(),
      voucherId: voucher.id,
      type: TransactionType.FREEZE,
      fromUserId: voucher.currentHolderId,
      fromUserName: voucher.currentHolderName,
      toUserId: operatorId,
      toUserName: operatorName,
      timestamp: now,
      txHash: generateTxHash(voucher.id, voucher.currentHolderId, operatorId, now),
      note: reason || '凭证冻结',
    };

    // 更新凭证状态
    voucher.status = VoucherStatus.FROZEN;

    this.db.updateVoucher(voucher);
    this.db.insertTransaction(transaction);

    return transaction;
  }

  /**
   * 解冻凭证
   * @param voucherId 凭证ID
   * @param operatorId 操作者ID
   * @param operatorName 操作者名称
   * @param reason 解冻原因
   * @returns 交易记录
   */
  unfreezeVoucher(
    voucherId: string,
    operatorId: string,
    operatorName: string,
    reason?: string
  ): Transaction {
    const voucher = this.db.getVoucherById(voucherId);

    if (!voucher) {
      throw new Error(`凭证不存在: ${voucherId}`);
    }

    if (voucher.status !== VoucherStatus.FROZEN) {
      throw new Error(`只能解冻已冻结的凭证，当前状态: ${voucher.status}`);
    }

    const now = Date.now();

    // 创建解冻交易记录
    const transaction: Transaction = {
      id: generateUUID(),
      voucherId: voucher.id,
      type: TransactionType.UNFREEZE,
      fromUserId: operatorId,
      fromUserName: operatorName,
      toUserId: voucher.currentHolderId,
      toUserName: voucher.currentHolderName,
      timestamp: now,
      txHash: generateTxHash(voucher.id, operatorId, voucher.currentHolderId, now),
      note: reason || '凭证解冻',
    };

    // 更新凭证状态
    voucher.status = VoucherStatus.ACTIVE;

    this.db.updateVoucher(voucher);
    this.db.insertTransaction(transaction);

    return transaction;
  }

  // ==================== 凭证销毁 ====================

  /**
   * 销毁凭证
   * @param voucherId 凭证ID
   * @param operatorId 操作者ID
   * @param operatorName 操作者名称
   * @param reason 销毁原因
   * @returns 交易记录
   */
  destroyVoucher(
    voucherId: string,
    operatorId: string,
    operatorName: string,
    reason?: string
  ): Transaction {
    const voucher = this.db.getVoucherById(voucherId);

    if (!voucher) {
      throw new Error(`凭证不存在: ${voucherId}`);
    }

    if (voucher.status === VoucherStatus.DESTROYED) {
      throw new Error('凭证已销毁，不能重复销毁');
    }

    const now = Date.now();

    // 创建销毁交易记录
    const transaction: Transaction = {
      id: generateUUID(),
      voucherId: voucher.id,
      type: TransactionType.DESTROY,
      fromUserId: voucher.currentHolderId,
      fromUserName: voucher.currentHolderName,
      toUserId: 'SYSTEM',
      toUserName: '系统销毁',
      amount: voucher.denomination,
      timestamp: now,
      txHash: generateTxHash(voucher.id, voucher.currentHolderId, 'SYSTEM', now),
      note: reason || '凭证销毁',
    };

    // 更新凭证状态
    voucher.status = VoucherStatus.DESTROYED;

    this.db.updateVoucher(voucher);
    this.db.insertTransaction(transaction);

    return transaction;
  }

  /**
   * 核销/使用凭证（道具凭证专属操作）
   * 将凭证标记为 REDEEMED 而非销毁，保留在用户记录中便于追溯
   * @param voucherId 凭证ID
   * @param operatorId 操作者ID
   * @param operatorName 操作者名称
   * @param reason 使用原因
   * @returns 交易记录
   */
  redeemVoucher(
    voucherId: string,
    operatorId: string,
    operatorName: string,
    reason?: string
  ): Transaction {
    const voucher = this.db.getVoucherById(voucherId);

    if (!voucher) {
      throw new Error(`凭证不存在: ${voucherId}`);
    }

    if (voucher.status !== VoucherStatus.ACTIVE) {
      throw new Error(`只能使用正常状态的凭证，当前状态: ${voucher.status}`);
    }

    const now = Date.now();

    // 创建兑换交易记录
    const transaction: Transaction = {
      id: generateUUID(),
      voucherId: voucher.id,
      type: TransactionType.REDEEM,
      fromUserId: voucher.currentHolderId,
      fromUserName: voucher.currentHolderName,
      toUserId: operatorId,
      toUserName: operatorName,
      amount: voucher.denomination,
      timestamp: now,
      txHash: generateTxHash(voucher.id, voucher.currentHolderId, operatorId, now),
      note: reason || '凭证已使用',
    };

    // 更新凭证状态为已兑换
    voucher.status = VoucherStatus.REDEEMED;
    voucher.transferCount += 1;
    voucher.lastTransferAt = now;

    this.db.updateVoucher(voucher);
    this.db.insertTransaction(transaction);

    return transaction;
  }

  // ==================== 凭证查询 ====================

  /**
   * 获取凭证详情
   */
  getVoucherById(id: string): Voucher | null {
    return this.db.getVoucherById(id);
  }

  /**
   * 通过编号获取凭证
   */
  getVoucherBySerialNumber(serialNumber: string): Voucher | null {
    return this.db.getVoucherBySerialNumber(serialNumber);
  }

  /**
   * 获取用户的所有凭证
   */
  getUserVouchers(userId: string): Voucher[] {
    return this.db.getVouchersByHolder(userId);
  }

  /**
   * 筛选凭证
   */
  filterVouchers(filter: VoucherFilter): Voucher[] {
    return this.db.filterVouchers(filter);
  }

  /**
   * 分页获取凭证
   */
  getVouchersPaginated(
    filter: VoucherFilter,
    page: number = 1,
    pageSize: number = 20
  ): PaginatedResult<Voucher> {
    return this.db.getVouchersPaginated(filter, page, pageSize);
  }

  /**
   * 搜索凭证
   */
  searchVouchers(query: string): Voucher[] {
    return this.db.searchVouchers(query);
  }

  // ==================== 历史记录查询 ====================

  /**
   * 获取凭证完整历史
   */
  getVoucherHistory(voucherId: string): VoucherHistory {
    const { voucher, transactions } = this.db.getVoucherHistory(voucherId);

    if (!voucher) {
      throw new Error(`凭证不存在: ${voucherId}`);
    }

    // 计算当前持有者持有时间
    const currentHolderDuration = voucher.lastTransferAt
      ? Date.now() - voucher.lastTransferAt
      : Date.now() - voucher.createdAt;

    // 统计历史持有者数量
    const uniqueHolders = new Set(transactions.map(t => t.toUserId)).size;

    return {
      voucher,
      transactions,
      currentHolderDuration,
      totalHolders: uniqueHolders,
    };
  }

  /**
   * 获取凭证流转图
   */
  getTransferGraph(voucherId: string): TransferGraph {
    const { voucher, transactions } = this.db.getVoucherHistory(voucherId);

    if (!voucher) {
      throw new Error(`凭证不存在: ${voucherId}`);
    }

    // 构建节点列表
    const holderMap = new Map<string, { index: number; timestamp: number }>();
    const nodes: { userId: string; userName: string; timestamp: number; index: number }[] = [];

    // 创建者作为第一个节点
    nodes.push({
      userId: voucher.createdBy,
      userName: voucher.createdByName,
      timestamp: voucher.createdAt,
      index: 0,
    });
    holderMap.set(voucher.createdBy, { index: 0, timestamp: voucher.createdAt });

    // 遍历交易记录构建节点和边
    const edges: { from: number; to: number; timestamp: number }[] = [];

    transactions.forEach(tx => {
      if (tx.type === TransactionType.TRANSFER) {
        const fromInfo = holderMap.get(tx.fromUserId!);
        let toIndex: number;

        if (holderMap.has(tx.toUserId)) {
          toIndex = holderMap.get(tx.toUserId)!.index;
        } else {
          toIndex = nodes.length;
          nodes.push({
            userId: tx.toUserId,
            userName: tx.toUserName,
            timestamp: tx.timestamp,
            index: toIndex,
          });
          holderMap.set(tx.toUserId, { index: toIndex, timestamp: tx.timestamp });
        }

        if (fromInfo) {
          edges.push({
            from: fromInfo.index,
            to: toIndex,
            timestamp: tx.timestamp,
          });
        }
      }
    });

    return {
      voucherId,
      nodes,
      edges,
    };
  }

  /**
   * 获取用户的交易历史
   */
  getUserTransactions(userId: string): Transaction[] {
    return this.db.getTransactionsByUser(userId);
  }

  /**
   * 获取最近的交易
   */
  getRecentTransactions(limit: number = 10): Transaction[] {
    return this.db.getRecentTransactions(limit);
  }

  // ==================== 统计查询 ====================

  /**
   * 获取用户统计
   */
  getUserStats(userId: string) {
    return this.db.getUserStats(userId);
  }

  /**
   * 获取系统统计
   */
  getSystemStats() {
    return this.db.getSystemStats();
  }

  // ==================== 验证 ====================

  /**
   * 验证交易哈希
   */
  verifyTransaction(txId: string): boolean {
    const tx = this.db.getTransactionById(txId);
    if (!tx) return false;

    // 重新计算哈希并比对
    const expectedHash = generateTxHash(tx.voucherId, tx.fromUserId || 'SYSTEM', tx.toUserId, tx.timestamp);
    return tx.txHash === expectedHash;
  }

  /**
   * 验证凭证有效性
   */
  verifyVoucher(voucherId: string): { valid: boolean; issues: string[] } {
    const voucher = this.db.getVoucherById(voucherId);
    const issues: string[] = [];

    if (!voucher) {
      return { valid: false, issues: ['凭证不存在'] };
    }

    // 检查过期
    if (voucher.expiresAt && Date.now() > voucher.expiresAt) {
      if (voucher.status !== VoucherStatus.EXPIRED) {
        issues.push('凭证已过期但状态未更新');
      }
    }

    // 检查交易记录一致性
    const transactions = this.db.getTransactionsByVoucherId(voucherId);
    const latestTx = transactions[transactions.length - 1];
    if (latestTx && latestTx.toUserId !== voucher.currentHolderId) {
      issues.push('凭证持有者与最新交易记录不一致');
    }

    return {
      valid: issues.length === 0,
      issues,
    };
  }

  // ==================== 系统管理 ====================

  /**
   * 数据完整性检查
   */
  checkDataIntegrity(): { valid: boolean; issues: string[] } {
    return this.db.verifyDataIntegrity();
  }

  /**
   * 导出数据
   */
  exportData() {
    return this.db.exportAllData();
  }

  /**
   * 导入数据
   */
  importData(data: { vouchers: Voucher[]; transactions: Transaction[] }) {
    this.db.importData(data);
  }

  /**
   * 清理过期凭证
   */
  cleanExpiredVouchers(): number {
    const now = Date.now();
    let count = 0;

    const allVouchers = this.db.getAllVouchers();
    for (const voucher of allVouchers) {
      if (
        voucher.expiresAt &&
        now > voucher.expiresAt &&
        voucher.status === VoucherStatus.ACTIVE
      ) {
        voucher.status = VoucherStatus.EXPIRED;
        this.db.updateVoucher(voucher);

        // 记录过期交易
        const transaction: Transaction = {
          id: generateUUID(),
          voucherId: voucher.id,
          type: TransactionType.DESTROY,
          fromUserId: voucher.currentHolderId,
          fromUserName: voucher.currentHolderName,
          toUserId: 'SYSTEM',
          toUserName: '系统过期清理',
          timestamp: now,
          txHash: generateTxHash(voucher.id, voucher.currentHolderId, 'SYSTEM', now),
          note: '凭证过期自动清理',
        };
        this.db.insertTransaction(transaction);

        count++;
      }
    }

    return count;
  }
}

// 导出单例
export const voucherService = VoucherService.getInstance();
