import React, { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Shield,
  History,
  ArrowRightLeft,
  Plus,
  Search,
  Filter,
  ChevronDown,
  ChevronUp,
  User,
  Clock,
  Hash,
  AlertCircle,
  CheckCircle2,
  X,
  TrendingUp,
  Wallet,
  Archive,
  Zap,
  Calculator,
  Cpu,
  Flame,
  Warehouse,
} from 'lucide-react';
import { voucherService } from '../services/VoucherService';
import { algorithmVoucherService } from '../services/AlgorithmVoucherService';
import { userPoolService } from '../services/UserPoolService';
import { Voucher, Transaction, VoucherStatus, TransactionType, EnhancedCreateVoucherRequest, VoucherSourceType } from '../types';
import { AlgorithmVoucherManager } from './AlgorithmVoucherManager';
import { VoucherCard } from './VoucherCard';
import { EnhancedVoucherCreator } from './EnhancedVoucherCreator';

interface VoucherManagerProps {
  currentUserId: string;
  currentUsername?: string;
  /** 创建成功后，点击"前往奖池管理"时的回调 */
  onNavigateToPools?: () => void;
}

/**
 * 格式化面额显示 - 处理小数精度问题
 * 对于小于1的小数值，保留足够多的小数位
 */
const formatDenomination = (value: number): string => {
  if (value === 0) return '0';
  if (value >= 1) {
    return value.toLocaleString('zh-CN');
  }
  // 对于小于1的值，保留足够的小数位数
  return value.toFixed(value < 0.001 ? 6 : 4);
};

export const VoucherManager: React.FC<VoucherManagerProps> = ({
  currentUserId,
  currentUsername = '当前用户',
  onNavigateToPools,
}) => {
  // 状态管理
  const [myVouchers, setMyVouchers] = useState<Voucher[]>([]);
  const [allVouchers, setAllVouchers] = useState<Voucher[]>([]);
  const [selectedVoucher, setSelectedVoucher] = useState<Voucher | null>(null);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [stats, setStats] = useState({
    totalIssued: 0,
    totalCirculating: 0,
    myVoucherCount: 0,
    totalTransactionCount: 0,
    // 双轨统计
    instantVouchers: 0,
    algorithmVouchers: 0,
    myInstantCount: 0,
    myAlgorithmCount: 0,
    // 凭证销毁&奖池
    destroyedCount: 0,
    poolCount: 0,
    poolTotalBalance: 0,
  });
  
  // UI 状态
  const [activeTab, setActiveTab] = useState<'my' | 'all' | 'history' | 'algorithm'>('my');
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<VoucherStatus | 'all'>('all');
  const [showDestroyed, setShowDestroyed] = useState(false);
  const [sourceTypeFilter, setSourceTypeFilter] = useState<VoucherSourceType | 'all'>('all');
  const [viewMode, setViewMode] = useState<'list' | 'grouped' | 'by-user'>('list'); // 新增：视图模式（按列表、按周期分组、按用户聚合）
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [isTransferModalOpen, setIsTransferModalOpen] = useState(false);
  const [isDetailModalOpen, setIsDetailModalOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<{ text: string; isCreation?: boolean } | null>(null);
  
  // 表单状态
  const [transferForm, setTransferForm] = useState({
    voucherId: '',
    toUserId: '',
    toUsername: '',
    remark: ''
  });

  // 加载数据
  const loadData = useCallback(() => {
    try {
      setIsLoading(true);
      
      // 加载我的凭证
      const myList = voucherService.getUserVouchers(currentUserId);
      console.log('[VoucherManager] 我的凭证:', myList.length);
      setMyVouchers(myList);
      
      // 加载所有凭证
      const allList = voucherService.filterVouchers({});
      setAllVouchers(allList);
      
      // 加载统计
      const systemStats = voucherService.getSystemStats();
      
      // 双轨统计 - 按来源类型分类
      const instantVouchers = allList.filter(v => v.sourceType === VoucherSourceType.INSTANT || !v.sourceType).length;
      const algorithmVouchers = allList.filter(v => v.sourceType === VoucherSourceType.ALGORITHM).length;
      const myInstantCount = myList.filter(v => v.sourceType === VoucherSourceType.INSTANT || !v.sourceType).length;
      const myAlgorithmCount = myList.filter(v => v.sourceType === VoucherSourceType.ALGORITHM).length;
      
      // 已销毁凭证统计
      const destroyedCount = allList.filter(v => v.status === VoucherStatus.DESTROYED).length;

      // 奖池统计
      const allPools = userPoolService.getAllPools();
      const poolCount = allPools.length;
      const poolTotalBalance = allPools.reduce((sum, p) => sum + userPoolService.getPoolBalance(p.id), 0);

      setStats({
        totalIssued: systemStats.totalVouchers,
        totalCirculating: systemStats.activeVouchers,
        myVoucherCount: myList.length,
        totalTransactionCount: systemStats.totalTransactions,
        instantVouchers,
        algorithmVouchers,
        myInstantCount,
        myAlgorithmCount,
        destroyedCount,
        poolCount,
        poolTotalBalance,
      });
      
      // 加载选中凭证的交易历史
      if (selectedVoucher) {
        const history = voucherService.getVoucherHistory(selectedVoucher.id);
        setTransactions(history.transactions);
      }
      
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载数据失败');
    } finally {
      setIsLoading(false);
    }
  }, [currentUserId, selectedVoucher]);

  useEffect(() => {
    loadData();
    
    // 跨标签页同步：localStorage 变化时重新加载
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === 'allinone_vouchers') {
        loadData();
      }
    };
    
    window.addEventListener('storage', handleStorageChange);
    return () => window.removeEventListener('storage', handleStorageChange);
  }, [loadData]);

  // 创建凭证（增强版）- 支持双轨系统
  const handleCreateVoucher = (request: EnhancedCreateVoucherRequest) => {
    try {
      setIsLoading(true);
      setError(null);

      // 检查是否为算法凭证
      const isAlgorithmVoucher = request.metadata?.sourceType === VoucherSourceType.ALGORITHM;

      // 如果是批量创建
      const quantity = request.quantity || 1;
      const denomination = request.denomination || 0;

      if (quantity > 1) {
        // 批量创建 - 每个凭证都包含规则（作为规则定义凭证）
        for (let i = 0; i < quantity; i++) {
          voucherService.createVoucher({
            denomination,
            recipientId: currentUserId,
            recipientName: currentUsername,
            expiresAt: request.expiresAt,
            metadata: {
              ...request.metadata,
              isRuleTemplate: true, // 标记为规则模板凭证
              templateIndex: i,
            },
            note: request.note || `批量创建 #${i + 1}/${quantity}`,
            rules: request.rules,
            issueDate: request.issueDate,
            quantity: request.quantity,
          } as EnhancedCreateVoucherRequest, currentUserId, currentUsername);
        }
      } else {
        // 单个创建 - 包含完整规则配置
        voucherService.createVoucher({
          denomination,
          recipientId: currentUserId,
          recipientName: currentUsername,
          expiresAt: request.expiresAt,
          metadata: {
            ...request.metadata,
            isRuleTemplate: true, // 标记为规则模板凭证
          },
          note: request.note,
          rules: request.rules,
          issueDate: request.issueDate,
          quantity: request.quantity,
        } as EnhancedCreateVoucherRequest, currentUserId, currentUsername);
      }

      // 根据凭证类型显示不同的成功消息
      if (isAlgorithmVoucher) {
        setSuccessMessage({ text: `成功创建计算分配型模板「${request.metadata?.name || ''}」！`, isCreation: true });
      } else {
        setSuccessMessage({ text: `成功创建 ${quantity} 个即时发放型凭证「${request.metadata?.name || ''}」！`, isCreation: true });
      }
      
      setIsCreateModalOpen(false);
      loadData();

      setTimeout(() => setSuccessMessage(null), 15000);
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建凭证失败');
    } finally {
      setIsLoading(false);
    }
  };

  // 转让凭证
  const handleTransferVoucher = () => {
    try {
      setIsLoading(true);
      setError(null);
      
      if (!transferForm.voucherId || !transferForm.toUserId) {
        throw new Error('请填写完整的转让信息');
      }
      
      voucherService.transferVoucher({
        voucherId: transferForm.voucherId,
        toUserId: transferForm.toUserId,
        toUserName: transferForm.toUsername || '未知用户',
        note: transferForm.remark
      }, currentUserId, currentUsername);
      
      setSuccessMessage({ text: '凭证转让成功！' });
      setIsTransferModalOpen(false);
      setTransferForm({
        voucherId: '',
        toUserId: '',
        toUsername: '',
        remark: ''
      });
      loadData();
      
      setTimeout(() => setSuccessMessage(null), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : '转让凭证失败');
    } finally {
      setIsLoading(false);
    }
  };

  // 打开转让弹窗
  const openTransferModal = (voucher: Voucher) => {
    setTransferForm({
      voucherId: voucher.id,
      toUserId: '',
      toUsername: '',
      remark: ''
    });
    setIsTransferModalOpen(true);
  };

  // 打开详情弹窗
  const openDetailModal = (voucher: Voucher) => {
    setSelectedVoucher(voucher);
    const history = voucherService.getVoucherHistory(voucher.id);
    setTransactions(history.transactions);
    setIsDetailModalOpen(true);
  };

  // 筛选凭证
  const getFilteredVouchers = () => {
    let vouchers = activeTab === 'my' ? myVouchers : allVouchers;
    
    // 默认不显示已销毁凭证（全部凭证页面）
    // 除非用户勾选了「显示已销毁」或主动在状态下拉选了「已销毁」
    if (!showDestroyed && activeTab === 'all' && statusFilter !== VoucherStatus.DESTROYED) {
      vouchers = vouchers.filter(v => v.status !== VoucherStatus.DESTROYED);
    }
    
    // 按状态筛选
    if (statusFilter !== 'all') {
      vouchers = vouchers.filter(v => v.status === statusFilter);
    }
    
    // 按来源类型筛选（双轨系统）
    if (sourceTypeFilter !== 'all') {
      vouchers = vouchers.filter(v => 
        v.sourceType === sourceTypeFilter || 
        (sourceTypeFilter === VoucherSourceType.INSTANT && !v.sourceType) // 向后兼容：无sourceType的默认为即时型
      );
    }
    
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      vouchers = vouchers.filter(v =>
        v.id.toLowerCase().includes(query) ||
        v.currentHolderName.toLowerCase().includes(query) ||
        v.serialNumber.toLowerCase().includes(query)
      );
    }
    
    return vouchers;
  };

  // 按结算周期分组凭证（用于合并视图）
  const getGroupedVouchers = () => {
    const vouchers = getFilteredVouchers();
    const groups = new Map<string, {
      cycleId: string;
      cycleNumber: number;
      templateName: string;
      settlementDate: string;
      vouchers: Voucher[];
      totalCount: number;
      totalValue: number;
    }>();

    vouchers.forEach(voucher => {
      if (voucher.sourceType === VoucherSourceType.ALGORITHM && voucher.algorithmInfo) {
        const cycleId = voucher.algorithmInfo.settlementCycleId;
        if (!groups.has(cycleId)) {
          groups.set(cycleId, {
            cycleId,
            cycleNumber: voucher.algorithmInfo.cycleNumber,
            templateName: voucher.algorithmInfo.templateName || '算法凭证',
            settlementDate: voucher.algorithmInfo.settlementDate,
            vouchers: [],
            totalCount: 0,
            totalValue: 0,
          });
        }
        const group = groups.get(cycleId)!;
        group.vouchers.push(voucher);
        group.totalCount += 1;
        group.totalValue += voucher.denomination;
      }
    });

    return Array.from(groups.values()).sort((a, b) => b.cycleNumber - a.cycleNumber);
  };

  // 按用户聚合凭证（同一用户的凭证显示为一个卡片）
  const getAggregatedByUser = () => {
    const vouchers = getFilteredVouchers();
    const userGroups = new Map<string, {
      userId: string;
      userName: string;
      vouchers: Voucher[];
      totalCount: number;
      totalValue: number;
      algorithmCount: number;
      instantCount: number;
      cycleNumbers: number[];
    }>();

    vouchers.forEach(voucher => {
      const userId = voucher.currentHolderId;
      if (!userGroups.has(userId)) {
        userGroups.set(userId, {
          userId,
          userName: voucher.currentHolderName,
          vouchers: [],
          totalCount: 0,
          totalValue: 0,
          algorithmCount: 0,
          instantCount: 0,
          cycleNumbers: [],
        });
      }
      const group = userGroups.get(userId)!;
      group.vouchers.push(voucher);
      group.totalCount += 1;
      group.totalValue += voucher.denomination;
      
      if (voucher.sourceType === VoucherSourceType.ALGORITHM) {
        group.algorithmCount += 1;
        if (voucher.algorithmInfo?.cycleNumber && !group.cycleNumbers.includes(voucher.algorithmInfo.cycleNumber)) {
          group.cycleNumbers.push(voucher.algorithmInfo.cycleNumber);
        }
      } else {
        group.instantCount += 1;
      }
    });

    return Array.from(userGroups.values()).sort((a, b) => b.totalValue - a.totalValue);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 p-4 md:p-8">
      {/* 成功/错误提示 */}
      <AnimatePresence>
        {successMessage && (
          <motion.div
            initial={{ opacity: 0, y: -50 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -50 }}
            className="fixed top-4 right-4 z-50 max-w-sm"
          >
            <div className="bg-green-500/90 text-white rounded-xl shadow-lg backdrop-blur-sm overflow-hidden">
              <div className="px-6 py-3 flex items-center gap-2">
                <CheckCircle2 className="w-5 h-5 shrink-0" />
                <span className="text-sm">{successMessage.text}</span>
              </div>
              {successMessage.isCreation && onNavigateToPools && (
                <div className="px-6 pb-3 pt-1 flex gap-2 border-t border-white/20 pt-3">
                  <button
                    onClick={() => {
                      setSuccessMessage(null);
                      onNavigateToPools();
                    }}
                    className="flex-1 text-xs font-medium px-3 py-2 rounded-lg bg-white/20 hover:bg-white/30 transition-colors"
                  >
                    🎮 前往奖池管理
                  </button>
                  <button
                    onClick={() => setSuccessMessage(null)}
                    className="text-xs px-3 py-2 rounded-lg bg-white/10 hover:bg-white/20 transition-colors"
                  >
                    关闭
                  </button>
                </div>
              )}
            </div>
          </motion.div>
        )}
        
        {error && (
          <motion.div
            initial={{ opacity: 0, y: -50 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -50 }}
            className="fixed top-4 right-4 z-50 bg-red-500/90 text-white px-6 py-3 rounded-xl shadow-lg backdrop-blur-sm flex items-center gap-2"
          >
            <AlertCircle className="w-5 h-5" />
            {error}
          </motion.div>
        )}
      </AnimatePresence>

      {/* 头部统计 */}
      <div className="max-w-7xl mx-auto mb-8">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-gradient-to-r from-blue-600/20 via-purple-600/20 to-pink-600/20 rounded-2xl p-6 md:p-8 border border-white/10 backdrop-blur-xl"
        >
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-6">
            <div>
              <h1 className="text-3xl md:text-4xl font-bold text-white mb-2 flex items-center gap-3">
                <Shield className="w-10 h-10 text-blue-400" />
                A币电子凭证系统
              </h1>
              <p className="text-slate-400">可追溯、可流转的安全数字资产凭证</p>
            </div>
            
            <div className="flex flex-wrap gap-4">
              <StatCard
                icon={<Archive className="w-5 h-5" />}
                label="总发行量"
                value={stats.totalIssued}
                color="blue"
              />
              <StatCard
                icon={<TrendingUp className="w-5 h-5" />}
                label="流通中"
                value={stats.totalCirculating}
                color="green"
              />
              <StatCard
                icon={<Wallet className="w-5 h-5" />}
                label="我的凭证"
                value={stats.myVoucherCount}
                color="purple"
              />
              <StatCard
                icon={<History className="w-5 h-5" />}
                label="交易次数"
                value={stats.totalTransactionCount}
                color="orange"
              />
              <StatCard
                icon={<Flame className="w-5 h-5" />}
                label="已销毁"
                value={stats.destroyedCount}
                color="red"
              />
            </div>

            {/* 奖池概况 */}
            <div className="mt-4 pt-4 border-t border-white/10">
              <h3 className="text-sm font-medium text-slate-400 mb-3 flex items-center gap-2">
                <Warehouse className="w-4 h-4" />
                奖池概况
              </h3>
              <div className="flex flex-wrap gap-4">
                <StatCard
                  icon={<Warehouse className="w-5 h-5" />}
                  label="奖池数量"
                  value={stats.poolCount}
                  color="purple"
                />
                <StatCard
                  icon={<TrendingUp className="w-5 h-5" />}
                  label="奖池总余额"
                  value={stats.poolTotalBalance}
                  suffix="A币"
                  color="green"
                />
              </div>
            </div>
            
            {/* 双轨系统统计 */}
            <div className="mt-6 pt-6 border-t border-white/10">
              <h3 className="text-sm font-medium text-slate-400 mb-3">双轨凭证分布</h3>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <DualStatCard
                  icon={<Zap className="w-4 h-4" />}
                  label="即时发放型"
                  value={activeTab === 'my' ? stats.myInstantCount : stats.instantVouchers}
                  subLabel="活动/奖励"
                  color="pink"
                />
                <DualStatCard
                  icon={<Calculator className="w-4 h-4" />}
                  label="计算分配型"
                  value={activeTab === 'my' ? stats.myAlgorithmCount : stats.algorithmVouchers}
                  subLabel="日结/分红"
                  color="rose"
                />
              </div>
            </div>
          </div>
        </motion.div>
      </div>

      {/* 主内容区 */}
      <div className="max-w-7xl mx-auto">
        {/* 操作栏 */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
          {/* 标签切换 */}
          <div className="flex bg-slate-800/50 rounded-xl p-1 border border-white/10">
            {[
              { key: 'my', label: '我的凭证', icon: Wallet },
              { key: 'all', label: '全部凭证', icon: Archive },
              { key: 'history', label: '交易历史', icon: History },
              { key: 'algorithm', label: '算法管理', icon: Cpu },
            ].map((tab) => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key as any)}
                className={`flex items-center gap-2 px-4 py-2.5 rounded-lg font-medium transition-all ${
                  activeTab === tab.key
                    ? 'bg-blue-600 text-white shadow-lg'
                    : 'text-slate-400 hover:text-white hover:bg-white/5'
                }`}
              >
                <tab.icon className="w-4 h-4" />
                {tab.label}
              </button>
            ))}
          </div>

          {/* 搜索和筛选 */}
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <input
                type="text"
                placeholder="搜索凭证ID、用户..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-64 bg-slate-800/50 border border-white/10 rounded-xl pl-10 pr-4 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50"
              />
            </div>
            
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as VoucherStatus | 'all')}
              className="bg-slate-800/50 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500/50"
            >
              <option value="all">全部状态</option>
              <option value={VoucherStatus.ACTIVE}>正常</option>
              <option value={VoucherStatus.FROZEN}>已冻结</option>
              <option value={VoucherStatus.EXPIRED}>已过期</option>
              <option value={VoucherStatus.DESTROYED}>已销毁</option>
            </select>

            {activeTab === 'all' && (
              <label className="flex items-center gap-2 text-sm text-slate-400 hover:text-slate-300 cursor-pointer select-none whitespace-nowrap">
                <input
                  type="checkbox"
                  checked={showDestroyed}
                  onChange={e => setShowDestroyed(e.target.checked)}
                  className="w-4 h-4 rounded border-white/20 bg-slate-800 accent-blue-500"
                />
                显示已销毁
              </label>
            )}
            
            {/* 双轨类型筛选 */}
            <select
              value={sourceTypeFilter}
              onChange={(e) => setSourceTypeFilter(e.target.value as VoucherSourceType | 'all')}
              className="bg-slate-800/50 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500/50"
            >
              <option value="all">全部类型</option>
              <option value={VoucherSourceType.INSTANT}>即时发放型</option>
              <option value={VoucherSourceType.ALGORITHM}>计算分配型</option>
            </select>

            {/* 视图模式切换 */}
            <div className="flex bg-slate-800/50 rounded-lg p-0.5 border border-white/10">
              <button
                onClick={() => setViewMode('list')}
                className={`px-3 py-2 rounded-md text-sm transition-all ${
                  viewMode === 'list'
                    ? 'bg-blue-600 text-white'
                    : 'text-slate-400 hover:text-white'
                }`}
                title="列表视图"
              >
                列表
              </button>
              {sourceTypeFilter === VoucherSourceType.ALGORITHM && (
                <button
                  onClick={() => setViewMode('grouped')}
                  className={`px-3 py-2 rounded-md text-sm transition-all ${
                    viewMode === 'grouped'
                      ? 'bg-blue-600 text-white'
                      : 'text-slate-400 hover:text-white'
                  }`}
                  title="按周期分组"
                >
                  按周期
                </button>
              )}
              <button
                onClick={() => setViewMode('by-user')}
                className={`px-3 py-2 rounded-md text-sm transition-all ${
                  viewMode === 'by-user'
                    ? 'bg-blue-600 text-white'
                    : 'text-slate-400 hover:text-white'
                }`}
                title="按用户聚合"
              >
                按用户
              </button>
            </div>

            <button
              onClick={() => setIsCreateModalOpen(true)}
              className="flex items-center gap-2 bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-500 hover:to-purple-500 text-white px-5 py-2.5 rounded-xl font-medium transition-all shadow-lg shadow-blue-500/25"
            >
              <Plus className="w-4 h-4" />
              创建凭证
            </button>
          </div>
        </div>

        {/* 凭证列表 */}
        {activeTab === 'algorithm' ? (
          /* 算法凭证管理视图 */
          <AlgorithmVoucherManager
            userId={currentUserId}
            userName={currentUsername}
            isAdmin={true}
          />
        ) : activeTab !== 'history' ? (
          <>
            {/* 按用户聚合视图 */}
            {viewMode === 'by-user' ? (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                <AnimatePresence mode="popLayout">
                  {getAggregatedByUser().map((userGroup, index) => (
                    <motion.div
                      key={userGroup.userId}
                      initial={{ opacity: 0, y: 20 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, scale: 0.95 }}
                      transition={{ delay: index * 0.05 }}
                      className="bg-gradient-to-br from-slate-800/80 to-slate-900/80 rounded-2xl p-6 border border-white/10 backdrop-blur-sm hover:border-blue-500/30 transition-all group"
                    >
                      {/* 用户头部 */}
                      <div className="flex items-center gap-4 mb-5">
                        <div className="w-14 h-14 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-white text-xl font-bold shadow-lg">
                          {userGroup.userName.charAt(0)}
                        </div>
                        <div className="flex-1 min-w-0">
                          <h3 className="text-white font-semibold text-lg truncate">
                            {userGroup.userName}
                          </h3>
                          <p className="text-slate-400 text-xs truncate">
                            ID: {userGroup.userId.slice(0, 8)}...
                          </p>
                        </div>
                      </div>

                      {/* 统计信息 */}
                      <div className="grid grid-cols-2 gap-3 mb-5">
                        <div className="bg-slate-700/30 rounded-xl p-3 text-center">
                          <p className="text-2xl font-bold text-white">{userGroup.totalCount}</p>
                          <p className="text-slate-400 text-xs">凭证总数</p>
                        </div>
                        <div className="bg-slate-700/30 rounded-xl p-3 text-center">
                          <p className="text-2xl font-bold text-rose-400">{formatDenomination(userGroup.totalValue)}</p>
                          <p className="text-slate-400 text-xs">总价值</p>
                        </div>
                      </div>

                      {/* 类型分布 */}
                      <div className="space-y-2 mb-5">
                        {userGroup.algorithmCount > 0 && (
                          <div className="flex items-center justify-between text-sm">
                            <span className="text-slate-400 flex items-center gap-1.5">
                              <Calculator className="w-4 h-4 text-rose-400" />
                              计算型
                            </span>
                            <span className="text-white font-medium">{userGroup.algorithmCount} 张</span>
                          </div>
                        )}
                        {userGroup.instantCount > 0 && (
                          <div className="flex items-center justify-between text-sm">
                            <span className="text-slate-400 flex items-center gap-1.5">
                              <Zap className="w-4 h-4 text-amber-400" />
                              即时型
                            </span>
                            <span className="text-white font-medium">{userGroup.instantCount} 张</span>
                          </div>
                        )}
                      </div>

                      {/* 周期信息（仅计算型） */}
                      {userGroup.cycleNumbers.length > 0 && (
                        <div className="mb-5 pt-3 border-t border-white/5">
                          <p className="text-slate-400 text-xs mb-2">参与周期</p>
                          <div className="flex flex-wrap gap-1.5">
                            {userGroup.cycleNumbers.sort((a, b) => b - a).slice(0, 5).map(cycle => (
                              <span key={cycle} className="px-2 py-0.5 bg-rose-500/20 text-rose-300 text-xs rounded-full">
                                #{cycle}
                              </span>
                            ))}
                            {userGroup.cycleNumbers.length > 5 && (
                              <span className="px-2 py-0.5 bg-slate-700/50 text-slate-400 text-xs rounded-full">
                                +{userGroup.cycleNumbers.length - 5}
                              </span>
                            )}
                          </div>
                        </div>
                      )}

                      {/* 查看详情按钮 */}
                      <button
                        onClick={() => {
                          // 切换到列表视图并筛选该用户的凭证
                          setViewMode('list');
                          setSearchQuery(userGroup.userName);
                        }}
                        className="w-full py-2.5 bg-slate-700/50 hover:bg-blue-600/30 text-slate-300 hover:text-blue-300 rounded-xl text-sm font-medium transition-all border border-white/5 hover:border-blue-500/30"
                      >
                        查看详情
                      </button>
                    </motion.div>
                  ))}
                </AnimatePresence>

                {getAggregatedByUser().length === 0 && (
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="col-span-full py-16 text-center text-slate-500"
                  >
                    <Archive className="w-16 h-16 mx-auto mb-4 opacity-30" />
                    <p className="text-lg">暂无凭证</p>
                    <p className="text-sm mt-1">
                      {activeTab === 'my' 
                        ? '您还没有持有任何凭证' 
                        : '系统中还没有凭证'
                      }
                    </p>
                  </motion.div>
                )}
              </div>
            ) : viewMode === 'grouped' && sourceTypeFilter === VoucherSourceType.ALGORITHM ? (
              /* 按周期分组视图 */
              <div className="space-y-4">
                {getGroupedVouchers().map((group) => (
                  <motion.div
                    key={group.cycleId}
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="bg-slate-800/50 rounded-2xl border border-white/10 overflow-hidden"
                  >
                    {/* 分组头部 */}
                    <div className="p-4 bg-gradient-to-r from-rose-600/20 to-purple-600/20 border-b border-white/10">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 rounded-lg bg-rose-500/20 flex items-center justify-center">
                            <Calculator className="w-5 h-5 text-rose-400" />
                          </div>
                          <div>
                            <h3 className="text-white font-semibold">
                              {group.templateName} - 周期 #{group.cycleNumber}
                            </h3>
                            <p className="text-slate-400 text-sm">
                              结算日期: {group.settlementDate}
                            </p>
                          </div>
                        </div>
                        <div className="text-right">
                          <p className="text-2xl font-bold text-white">
                            {group.totalCount} <span className="text-sm font-normal text-slate-400">张</span>
                          </p>
                          <p className="text-rose-400 text-sm">
                            总价值: {formatDenomination(group.totalValue)} A币
                          </p>
                        </div>
                      </div>
                    </div>
                    {/* 凭证列表 */}
                    <div className="p-4 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                      {group.vouchers.map((voucher, index) => (
                        <VoucherCard
                          key={voucher.id}
                          voucher={voucher}
                          compact
                          isOwner={voucher.currentHolderId === currentUserId}
                          onTransfer={() => openTransferModal(voucher)}
                          onViewDetails={() => openDetailModal(voucher)}
                        />
                      ))}
                    </div>
                  </motion.div>
                ))}
                
                {getGroupedVouchers().length === 0 && (
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="py-16 text-center text-slate-500"
                  >
                    <Archive className="w-16 h-16 mx-auto mb-4 opacity-30" />
                    <p className="text-lg">暂无算法凭证</p>
                    <p className="text-sm mt-1">您还没有计算分配型凭证</p>
                  </motion.div>
                )}
              </div>
            ) : (
              /* 列表视图 */
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                <AnimatePresence mode="popLayout">
                  {getFilteredVouchers().map((voucher, index) => (
                    <VoucherCard
                      key={voucher.id}
                      voucher={voucher}
                      index={index}
                      isOwner={voucher.currentHolderId === currentUserId}
                      onTransfer={() => openTransferModal(voucher)}
                      onViewDetails={() => openDetailModal(voucher)}
                    />
                  ))}
                </AnimatePresence>
                
                {getFilteredVouchers().length === 0 && (
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="col-span-full py-16 text-center text-slate-500"
                  >
                    <Archive className="w-16 h-16 mx-auto mb-4 opacity-30" />
                    <p className="text-lg">暂无凭证</p>
                    <p className="text-sm mt-1">
                      {activeTab === 'my' 
                        ? (sourceTypeFilter === 'all' 
                            ? '您还没有持有任何凭证' 
                            : sourceTypeFilter === VoucherSourceType.INSTANT 
                              ? '您还没有即时发放型凭证' 
                              : '您还没有计算分配型凭证')
                        : '系统中还没有凭证'
                      }
                    </p>
                  </motion.div>
                )}
              </div>
            )}
          </>
        ) : (
          /* 交易历史视图 */
          <div className="bg-slate-800/30 rounded-2xl border border-white/10 overflow-hidden">
            <div className="p-6 border-b border-white/10">
              <h3 className="text-xl font-semibold text-white flex items-center gap-2">
                <History className="w-5 h-5 text-blue-400" />
                全局交易历史
              </h3>
            </div>
            <TransactionHistoryList transactions={transactions} />
          </div>
        )}
      </div>

      {/* 创建凭证弹窗 - 使用增强版组件 */}
      <AnimatePresence>
        {isCreateModalOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
            onClick={() => setIsCreateModalOpen(false)}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              transition={{ type: 'spring', damping: 25, stiffness: 300 }}
              className="w-full max-w-4xl max-h-[90vh] overflow-hidden"
              onClick={(e) => e.stopPropagation()}
            >
              <EnhancedVoucherCreator
                currentUserId={currentUserId}
                currentUsername={currentUsername}
                onCreate={handleCreateVoucher}
                onCancel={() => setIsCreateModalOpen(false)}
                isLoading={isLoading}
              />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 转让凭证弹窗 */}
      <AnimatePresence>
        {isTransferModalOpen && (
          <Modal onClose={() => setIsTransferModalOpen(false)} title="转让凭证">
            <div className="space-y-6">
              <div className="bg-blue-500/10 border border-blue-500/20 rounded-xl p-4">
                <p className="text-sm text-blue-300">
                  正在转让凭证: <span className="font-mono font-medium">{transferForm.voucherId}</span>
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-300 mb-2">
                  接收方用户ID <span className="text-red-400">*</span>
                </label>
                <input
                  type="text"
                  placeholder="请输入接收方用户ID"
                  value={transferForm.toUserId}
                  onChange={(e) => setTransferForm({ ...transferForm, toUserId: e.target.value })}
                  className="w-full bg-slate-800/50 border border-white/10 rounded-xl px-4 py-3 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-300 mb-2">
                  接收方用户名
                </label>
                <input
                  type="text"
                  placeholder="请输入接收方用户名（可选）"
                  value={transferForm.toUsername}
                  onChange={(e) => setTransferForm({ ...transferForm, toUsername: e.target.value })}
                  className="w-full bg-slate-800/50 border border-white/10 rounded-xl px-4 py-3 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-300 mb-2">
                  备注信息
                </label>
                <textarea
                  placeholder="请输入转让备注（可选）"
                  value={transferForm.remark}
                  onChange={(e) => setTransferForm({ ...transferForm, remark: e.target.value })}
                  rows={3}
                  className="w-full bg-slate-800/50 border border-white/10 rounded-xl px-4 py-3 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50"
                />
              </div>

              <div className="flex gap-3 pt-4">
                <button
                  onClick={() => setIsTransferModalOpen(false)}
                  className="flex-1 px-4 py-3 rounded-xl bg-slate-700/50 text-slate-300 font-medium hover:bg-slate-700 transition-colors"
                >
                  取消
                </button>
                <button
                  onClick={handleTransferVoucher}
                  disabled={isLoading || !transferForm.toUserId}
                  className="flex-1 px-4 py-3 rounded-xl bg-gradient-to-r from-green-600 to-emerald-600 text-white font-medium hover:from-green-500 hover:to-emerald-500 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isLoading ? '转让中...' : '确认转让'}
                </button>
              </div>
            </div>
          </Modal>
        )}
      </AnimatePresence>

      {/* 凭证详情弹窗 */}
      <AnimatePresence>
        {isDetailModalOpen && selectedVoucher && (
          <Modal onClose={() => setIsDetailModalOpen(false)} title="凭证详情">
            <div className="space-y-6">
              {/* 凭证基本信息 */}
              <div className="bg-gradient-to-r from-slate-800/50 to-slate-700/30 rounded-xl p-6 border border-white/10">
                <div className="flex items-center justify-between mb-4">
                  <span className="text-sm text-slate-400">凭证ID</span>
                  <span className="font-mono text-sm text-blue-400">{selectedVoucher.id}</span>
                </div>
                <div className="flex items-center justify-between mb-4">
                  <span className="text-sm text-slate-400">当前状态</span>
                  <StatusBadge status={selectedVoucher.status} />
                </div>
                <div className="flex items-center justify-between mb-4">
                  <span className="text-sm text-slate-400">凭证价值</span>
                  <span className="text-xl font-bold text-white">{formatDenomination(selectedVoucher.denomination)} A币</span>
                </div>
                <div className="flex items-center justify-between mb-4">
                  <span className="text-sm text-slate-400">流转次数</span>
                  <span className="text-white">{selectedVoucher.transferCount} 次</span>
                </div>
                {/* 双轨类型标识 */}
                <div className="flex items-center justify-between pt-4 border-t border-white/10">
                  <span className="text-sm text-slate-400">凭证来源</span>
                  <SourceTypeBadge sourceType={selectedVoucher.sourceType} />
                </div>
                {/* 算法凭证额外信息 */}
                {selectedVoucher.sourceType === VoucherSourceType.ALGORITHM && selectedVoucher.algorithmInfo && (
                  <div className="mt-4 pt-4 border-t border-white/10 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-slate-400">贡献比例</span>
                      <span className="text-rose-400">{(selectedVoucher.algorithmInfo.contributionRatio * 100).toFixed(2)}%</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-slate-400">贡献分数</span>
                      <span className="text-rose-400">{selectedVoucher.algorithmInfo.contributionScore.toFixed(4)}</span>
                    </div>
                  </div>
                )}
              </div>

              {/* 持有人信息 */}
              <div>
                <h4 className="text-sm font-medium text-slate-400 mb-3">持有人信息</h4>
                <div className="space-y-3">
                  <div className="flex items-center gap-3 p-3 bg-slate-800/30 rounded-lg">
                    <User className="w-5 h-5 text-slate-500" />
                    <div>
                      <p className="text-sm text-slate-400">当前持有人</p>
                      <p className="text-white font-medium">{selectedVoucher.currentHolderName}</p>
                      <p className="text-xs text-slate-500 font-mono">{selectedVoucher.currentHolderId}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 p-3 bg-slate-800/30 rounded-lg">
                    <User className="w-5 h-5 text-slate-500" />
                    <div>
                      <p className="text-sm text-slate-400">发行方</p>
                      <p className="text-white font-medium">{selectedVoucher.createdByName}</p>
                      <p className="text-xs text-slate-500 font-mono">{selectedVoucher.createdBy}</p>
                    </div>
                  </div>
                </div>
              </div>

              {/* 时间信息 */}
              <div>
                <h4 className="text-sm font-medium text-slate-400 mb-3">时间信息</h4>
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-slate-500">创建时间</span>
                    <span className="text-slate-300">{new Date(selectedVoucher.createdAt).toLocaleString('zh-CN')}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">最后流转</span>
                    <span className="text-slate-300">{selectedVoucher.lastTransferAt ? new Date(selectedVoucher.lastTransferAt).toLocaleString('zh-CN') : '无'}</span>
                  </div>
                </div>
              </div>

              {/* 交易历史 */}
              <div>
                <h4 className="text-sm font-medium text-slate-400 mb-3 flex items-center gap-2">
                  <History className="w-4 h-4" />
                  流转历史
                </h4>
                <TransactionHistoryList transactions={transactions} compact />
              </div>
            </div>
          </Modal>
        )}
      </AnimatePresence>
    </div>
  );
};

// 统计卡片组件
const StatCard: React.FC<{
  icon: React.ReactNode;
  label: string;
  value: number;
  color: string;
  suffix?: string;
}> = ({ icon, label, value, color, suffix }) => {
  const colorClasses: Record<string, string> = {
    blue: 'from-blue-500/20 to-blue-600/10 text-blue-400',
    green: 'from-green-500/20 to-green-600/10 text-green-400',
    purple: 'from-purple-500/20 to-purple-600/10 text-purple-400',
    orange: 'from-orange-500/20 to-orange-600/10 text-orange-400',
    red: 'from-red-500/20 to-red-600/10 text-red-400',
  };

  return (
    <div className={`bg-gradient-to-br ${colorClasses[color]} rounded-xl px-4 py-3 border border-white/5`}>
      <div className="flex items-center gap-2 mb-1">
        {icon}
        <span className="text-xs text-slate-400">{label}</span>
      </div>
      <p className="text-2xl font-bold">
        {formatDenomination(value)}
        {suffix && <span className="text-sm font-normal text-slate-400 ml-1">{suffix}</span>}
      </p>
    </div>
  );
};

// 双轨统计卡片组件
const DualStatCard: React.FC<{
  icon: React.ReactNode;
  label: string;
  value: number;
  subLabel: string;
  color: string;
}> = ({ icon, label, value, subLabel, color }) => {
  const colorClasses: Record<string, string> = {
    pink: 'from-pink-500/20 to-pink-600/10 text-pink-400 border-pink-500/20',
    rose: 'from-rose-500/20 to-rose-600/10 text-rose-400 border-rose-500/20',
  };

  return (
    <div className={`bg-gradient-to-br ${colorClasses[color]} rounded-xl px-4 py-3 border`}>
      <div className="flex items-center gap-2 mb-1">
        {icon}
        <span className="text-xs text-slate-400">{label}</span>
      </div>
      <p className="text-xl font-bold">{formatDenomination(value)}</p>
      <p className="text-xs text-slate-500">{subLabel}</p>
    </div>
  );
};

// 状态标签组件
const StatusBadge: React.FC<{ status: VoucherStatus }> = ({ status }) => {
  const configs: Record<VoucherStatus, { bg: string; text: string; label: string }> = {
    [VoucherStatus.ACTIVE]: { bg: 'bg-green-500/20', text: 'text-green-400', label: '正常' },
    [VoucherStatus.FROZEN]: { bg: 'bg-blue-500/20', text: 'text-blue-400', label: '已冻结' },
    [VoucherStatus.EXPIRED]: { bg: 'bg-amber-500/20', text: 'text-amber-400', label: '已过期' },
    [VoucherStatus.DESTROYED]: { bg: 'bg-red-500/20', text: 'text-red-400', label: '已销毁' }
  };
  
  const config = configs[status];
  return (
    <span className={`px-2 py-1 rounded-full text-xs font-medium ${config.bg} ${config.text}`}>
      {config.label}
    </span>
  );
};

// 来源类型标签组件
const SourceTypeBadge: React.FC<{ sourceType?: VoucherSourceType }> = ({ sourceType }) => {
  const isAlgorithm = sourceType === VoucherSourceType.ALGORITHM;
  const isInstant = sourceType === VoucherSourceType.INSTANT || !sourceType;
  
  if (isAlgorithm) {
    return (
      <span className="px-2 py-1 rounded-full text-xs font-medium bg-rose-500/20 text-rose-400 flex items-center gap-1">
        <Calculator className="w-3 h-3" />
        计算分配型
      </span>
    );
  }
  
  return (
    <span className="px-2 py-1 rounded-full text-xs font-medium bg-pink-500/20 text-pink-400 flex items-center gap-1">
      <Zap className="w-3 h-3" />
      即时发放型
    </span>
  );
};

// 交易历史列表组件
const TransactionHistoryList: React.FC<{
  transactions: Transaction[];
  compact?: boolean;
}> = ({ transactions, compact }) => {
  if (transactions.length === 0) {
    return (
      <div className="text-center py-8 text-slate-500">
        <History className="w-12 h-12 mx-auto mb-3 opacity-30" />
        <p className="text-sm">暂无交易记录</p>
      </div>
    );
  }

  return (
    <div className={`space-y-2 ${compact ? 'max-h-60 overflow-y-auto' : ''}`}>
      {transactions.map((tx, index) => (
        <motion.div
          key={tx.id}
          initial={{ opacity: 0, x: -20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: index * 0.05 }}
          className="flex items-start gap-3 p-3 bg-slate-800/30 rounded-lg hover:bg-slate-800/50 transition-colors"
        >
          <div className="w-8 h-8 rounded-full bg-blue-500/20 flex items-center justify-center flex-shrink-0">
            <ArrowRightLeft className="w-4 h-4 text-blue-400" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-sm text-slate-300 truncate">
                {tx.fromUserName || '系统'} → {tx.toUserName}
              </span>
            </div>
            <div className="flex items-center gap-3 text-xs text-slate-500">
              <span className="flex items-center gap-1">
                <Clock className="w-3 h-3" />
                {new Date(tx.timestamp).toLocaleString('zh-CN')}
              </span>
              {tx.note && (
                <span className="truncate max-w-xs">备注: {tx.note}</span>
              )}
            </div>
          </div>
          {!compact && (
            <span className="text-xs font-mono text-slate-500 flex-shrink-0">
              #{tx.id.slice(-6)}
            </span>
          )}
        </motion.div>
      ))}
    </div>
  );
};

// 弹窗组件
const Modal: React.FC<{
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}> = ({ onClose, title, children }) => {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.9, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.9, y: 20 }}
        transition={{ type: 'spring', damping: 25, stiffness: 300 }}
        className="bg-slate-900 rounded-2xl border border-white/10 shadow-2xl w-full max-w-lg max-h-[90vh] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 弹窗头部 */}
        <div className="flex items-center justify-between p-6 border-b border-white/10">
          <h3 className="text-xl font-semibold text-white">{title}</h3>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-lg bg-slate-800/50 hover:bg-slate-700 flex items-center justify-center text-slate-400 hover:text-white transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* 弹窗内容 */}
        <div className="p-6 overflow-y-auto max-h-[60vh]">
          {children}
        </div>
      </motion.div>
    </motion.div>
  );
};

export default VoucherManager;