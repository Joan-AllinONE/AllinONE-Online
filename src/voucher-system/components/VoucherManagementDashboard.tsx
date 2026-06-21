/**
 * 凭证管理仪表盘
 * 事后管理工具 — 批量操作、生命周期分析、数据工具、凭证快查
 */
import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Settings, Shield, AlertTriangle, Snowflake, Flame, Search,
  User, Download, Upload, BarChart3, TrendingUp,
  Archive, History, Clock, CheckCircle2, X, AlertCircle,
  Coins, ArrowRightLeft, FileText, RefreshCw,
  Zap, Calculator, Trash2, Info, BadgeCheck,
  ChevronDown, ChevronUp, Copy, Maximize2,
} from 'lucide-react';
import { voucherService } from '../services/VoucherService';
import { voucherDB } from '../storage/VoucherDatabase';
import {
  Voucher, VoucherStatus, Transaction, VoucherSourceType,
} from '../types';
import { VoucherCard } from './VoucherCard';

interface VoucherManagementDashboardProps {
  currentUserId: string;
  currentUsername?: string;
}

// ==================== 工具函数 ====================

const formatDenomination = (value: number): string => {
  if (value === 0) return '0';
  if (value >= 1) return value.toLocaleString('zh-CN');
  return value.toFixed(value < 0.001 ? 6 : 4);
};

const formatDate = (ts: number) =>
  new Date(ts).toLocaleString('zh-CN');

const statusConfig: Record<VoucherStatus, { label: string; color: string; bg: string }> = {
  [VoucherStatus.ACTIVE]: { label: '正常', color: 'text-green-400', bg: 'bg-green-500/20' },
  [VoucherStatus.FROZEN]: { label: '已冻结', color: 'text-blue-400', bg: 'bg-blue-500/20' },
  [VoucherStatus.EXPIRED]: { label: '已过期', color: 'text-amber-400', bg: 'bg-amber-500/20' },
  [VoucherStatus.DESTROYED]: { label: '已销毁', color: 'text-red-400', bg: 'bg-red-500/20' },
};

export const VoucherManagementDashboard: React.FC<VoucherManagementDashboardProps> = ({
  currentUserId,
  currentUsername = '管理员',
}) => {
  const [activeSection, setActiveSection] = useState<'overview' | 'bulk' | 'tools' | 'search'>('overview');
  const [allVouchers, setAllVouchers] = useState<Voucher[]>([]);
  const [allTransactions, setAllTransactions] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // 快捷消息
  const showMsg = (type: 'success' | 'error', text: string) => {
    setMessage({ type, text });
    setTimeout(() => setMessage(null), 4000);
  };

  const loadData = useCallback(() => {
    setLoading(true);
    try {
      const vouchers = voucherService.filterVouchers({});
      setAllVouchers(vouchers);
      // 通过 VoucherDatabase 获取交易记录
      const txs = voucherDB.getRecentTransactions(500);
      setAllTransactions(txs);
    } catch (e: any) {
      showMsg('error', '加载数据失败: ' + e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  // ==================== 统计仪表盘 ====================

  const stats = useMemo(() => {
    const total = allVouchers.length;
    const active = allVouchers.filter(v => v.status === VoucherStatus.ACTIVE).length;
    const frozen = allVouchers.filter(v => v.status === VoucherStatus.FROZEN).length;
    const expired = allVouchers.filter(v => v.status === VoucherStatus.EXPIRED).length;
    const destroyed = allVouchers.filter(v => v.status === VoucherStatus.DESTROYED).length;
    const totalValue = allVouchers.reduce((s, v) => s + v.denomination, 0);
    return { total, active, frozen, expired, destroyed, totalValue };
  }, [allVouchers]);

  // 即将过期（7天内）
  const expiringSoon = useMemo(() =>
    allVouchers.filter(v =>
      v.status === VoucherStatus.ACTIVE &&
      v.expiresAt &&
      v.expiresAt > Date.now() &&
      v.expiresAt < Date.now() + 7 * 24 * 60 * 60 * 1000
    ).sort((a, b) => (a.expiresAt || 0) - (b.expiresAt || 0)),
    [allVouchers],
  );

  // 已过期但未被标记的
  const pastDue = useMemo(() =>
    allVouchers.filter(v =>
      v.status === VoucherStatus.ACTIVE &&
      v.expiresAt &&
      v.expiresAt <= Date.now()
    ),
    [allVouchers],
  );

  // 高价值凭证 TOP10
  const topVouchers = useMemo(() =>
    [...allVouchers]
      .filter(v => v.status === VoucherStatus.ACTIVE)
      .sort((a, b) => b.denomination - a.denomination)
      .slice(0, 10),
    [allVouchers],
  );

  // 用户持值排行
  const userRankings = useMemo(() => {
    const map = new Map<string, { userId: string; userName: string; count: number; totalValue: number; algorithmCount: number; instantCount: number }>();
    allVouchers.forEach(v => {
      const key = v.currentHolderId;
      if (!map.has(key)) {
        map.set(key, { userId: key, userName: v.currentHolderName, count: 0, totalValue: 0, algorithmCount: 0, instantCount: 0 });
      }
      const entry = map.get(key)!;
      entry.count++;
      entry.totalValue += v.denomination;
      if (v.sourceType === VoucherSourceType.ALGORITHM) entry.algorithmCount++;
      else entry.instantCount++;
    });
    return Array.from(map.values()).sort((a, b) => b.totalValue - a.totalValue).slice(0, 20);
  }, [allVouchers]);

  // ==================== 批量操作 ====================

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkAction, setBulkAction] = useState<'freeze' | 'unfreeze' | 'destroy' | null>(null);
  const [bulkReason, setBulkReason] = useState('');
  const [bulkResults, setBulkResults] = useState<{ success: number; fail: number; details: string[] } | null>(null);
  const [selectAllFilter, setSelectAllFilter] = useState<VoucherStatus | 'all'>('all');
  const [showDestroyedStats, setShowDestroyedStats] = useState(false);
  const [showDestroyedInBulk, setShowDestroyedInBulk] = useState(false);

  const filteredForBulk = useMemo(() => {
    let list = allVouchers;
    if (!showDestroyedInBulk) {
      list = list.filter(v => v.status !== VoucherStatus.DESTROYED);
    }
    if (selectAllFilter !== 'all') {
      list = list.filter(v => v.status === selectAllFilter);
    }
    return list;
  }, [allVouchers, selectAllFilter, showDestroyedInBulk]);

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const handleSelectAll = () => {
    if (selectedIds.size === filteredForBulk.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredForBulk.map(v => v.id)));
    }
  };

  const executeBulkAction = () => {
    if (!bulkAction || selectedIds.size === 0) return;
    const ids = Array.from(selectedIds);
    let success = 0;
    let fail = 0;
    const details: string[] = [];

    ids.forEach(id => {
      try {
        if (bulkAction === 'freeze') {
          voucherService.freezeVoucher(id, currentUserId, currentUsername, bulkReason || '批量冻结');
        } else if (bulkAction === 'unfreeze') {
          voucherService.unfreezeVoucher(id, currentUserId, currentUsername, bulkReason || '批量解冻');
        } else if (bulkAction === 'destroy') {
          voucherService.destroyVoucher(id, currentUserId, currentUsername, bulkReason || '批量销毁');
        }
        success++;
      } catch (e: any) {
        fail++;
        details.push(`${id.slice(0, 8)}...: ${e.message}`);
      }
    });

    setBulkResults({ success, fail, details });
    setSelectedIds(new Set());
    setBulkReason('');
    setBulkAction(null);
    loadData();
  };

  // ==================== 数据工具 ====================

  const [importData, setImportData] = useState<string>('');
  const [showImport, setShowImport] = useState(false);

  const handleExport = () => {
    try {
      const data = voucherService.exportData();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `voucher-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      showMsg('success', `导出成功！共 ${data.vouchers.length} 个凭证，${data.transactions.length} 条交易`);
    } catch (e: any) {
      showMsg('error', '导出失败: ' + e.message);
    }
  };

  const handleImport = () => {
    try {
      const data = JSON.parse(importData);
      if (!data.vouchers || !data.transactions) {
        throw new Error('数据格式不正确，缺少 vouchers 或 transactions 字段');
      }
      voucherService.importData(data);
      showMsg('success', `导入成功！共 ${data.vouchers.length} 个凭证，${data.transactions.length} 条交易`);
      setImportData('');
      setShowImport(false);
      loadData();
    } catch (e: any) {
      showMsg('error', '导入失败: ' + e.message);
    }
  };

  const handleCleanExpired = () => {
    try {
      const count = voucherService.cleanExpiredVouchers();
      showMsg('success', `已清理 ${count} 个过期凭证`);
      loadData();
    } catch (e: any) {
      showMsg('error', '清理失败: ' + e.message);
    }
  };

  // ==================== 凭证快查 ====================

  const [searchQuery, setSearchQuery] = useState('');
  const [searchResult, setSearchResult] = useState<Voucher | null>(null);
  const [userSearchQuery, setUserSearchQuery] = useState('');
  const [userSearchResult, setUserSearchResult] = useState<Voucher[]>([]);

  const handleLookupBySerial = () => {
    if (!searchQuery.trim()) return;
    const byId = voucherService.getVoucherById(searchQuery.trim());
    const bySerial = byId || voucherService.getVoucherBySerialNumber(searchQuery.trim());
    setSearchResult(bySerial);
  };

  const handleLookupByUser = () => {
    if (!userSearchQuery.trim()) return;
    const result = voucherService.filterVouchers({
      holderId: userSearchQuery.trim(),
    });
    setUserSearchResult(result);
  };

  // ==================== 交易概览 ====================

  const recentTxs = useMemo(() =>
    allTransactions.sort((a, b) => b.timestamp - a.timestamp).slice(0, 20),
    [allTransactions],
  );

  const sections = [
    { key: 'overview' as const, label: '凭证总览', icon: BarChart3 },
    { key: 'bulk' as const, label: '批量操作', icon: Settings },
    { key: 'tools' as const, label: '数据工具', icon: FileText },
    { key: 'search' as const, label: '凭证快查', icon: Search },
  ];

  return (
    <div className="space-y-6">
      {/* 消息提示 */}
      <AnimatePresence>
        {message && (
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className={`fixed top-4 right-4 z-50 px-6 py-3 rounded-xl shadow-lg backdrop-blur-sm flex items-center gap-2 ${
              message.type === 'success' ? 'bg-green-500/90 text-white' : 'bg-red-500/90 text-white'
            }`}
          >
            {message.type === 'success' ? <CheckCircle2 className="w-5 h-5" /> : <AlertCircle className="w-5 h-5" />}
            {message.text}
          </motion.div>
        )}
      </AnimatePresence>

      {/* 标题区 */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-white flex items-center gap-2">
            <Shield className="w-6 h-6 text-rose-400" />
            凭证管理中心
          </h2>
          <p className="text-slate-400 text-sm mt-1">事后管理 — 操作、审计、分析</p>
        </div>
        <button
          onClick={loadData}
          className="flex items-center gap-2 px-4 py-2 bg-slate-800/50 border border-white/10 rounded-xl text-sm text-slate-300 hover:text-white hover:bg-slate-700/50 transition-all"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          刷新
        </button>
      </div>

      {/* 区块切换 */}
      <div className="flex bg-slate-800/50 rounded-xl p-1 border border-white/10 overflow-x-auto">
        {sections.map(sec => {
          const Icon = sec.icon;
          const colorMap: Record<string, string> = {
            overview: 'bg-rose-600',
            bulk: 'bg-blue-600',
            tools: 'bg-emerald-600',
            search: 'bg-amber-600',
          };
          return (
            <button
              key={sec.key}
              onClick={() => setActiveSection(sec.key)}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg font-medium text-sm whitespace-nowrap transition-all ${
                activeSection === sec.key
                  ? `${colorMap[sec.key]} text-white`
                  : 'text-slate-400 hover:text-white hover:bg-white/5'
              }`}
            >
              <Icon className="w-4 h-4" />
              {sec.label}
            </button>
          );
        })}
      </div>

      {/* ========================= 凭证总览 ========================= */}
      {activeSection === 'overview' && (
        <div className="space-y-6">
          {/* 状态分布统计 */}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            {[
              { label: '总凭证', value: stats.total, color: 'from-slate-500/20 to-slate-600/10 text-slate-400', icon: Archive },
              { label: '正常流通', value: stats.active, color: 'from-green-500/20 to-green-600/10 text-green-400', icon: BadgeCheck },
              { label: '已冻结', value: stats.frozen, color: 'from-blue-500/20 to-blue-600/10 text-blue-400', icon: Snowflake },
              { label: '已过期', value: stats.expired, color: 'from-amber-500/20 to-amber-600/10 text-amber-400', icon: Clock },
            ].map(item => {
              const Icon = item.icon;
              return (
                <div key={item.label} className={`bg-gradient-to-br ${item.color} rounded-xl p-4 border border-white/5`}>
                  <div className="flex items-center gap-2 mb-1">
                    <Icon className="w-4 h-4" />
                    <span className="text-xs text-slate-400">{item.label}</span>
                  </div>
                  <p className="text-2xl font-bold">{item.value}</p>
                </div>
              );
            })}
            {/* 已销毁 — 默认折叠，点击展开 */}
            <motion.div
              layout
              onClick={() => setShowDestroyedStats(!showDestroyedStats)}
              className={`bg-gradient-to-br from-red-500/20 to-red-600/10 rounded-xl p-4 border border-white/5 cursor-pointer transition-all hover:from-red-500/30 hover:to-red-600/20 select-none ${showDestroyedStats ? 'ring-1 ring-red-400/30' : 'opacity-70'}`}
            >
              <div className="flex items-center gap-2 mb-1">
                <Flame className="w-4 h-4 text-red-400" />
                <span className="text-xs text-slate-400">已销毁</span>
                <span className="ml-auto text-xs text-red-400/60">
                  {showDestroyedStats ? '收起 ▲' : '展开 ▼'}
                </span>
              </div>
              <motion.p
                key={showDestroyedStats ? 'shown' : 'hidden'}
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                className={`text-2xl font-bold transition-colors ${showDestroyedStats ? 'text-red-400' : 'text-red-400/40'}`}
              >
                {showDestroyedStats ? stats.destroyed : '?'}
              </motion.p>
            </motion.div>
          </div>

          {/* 总价值 + 双轨分布 */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="bg-gradient-to-br from-amber-500/20 to-orange-600/10 rounded-xl p-4 border border-white/5">
              <div className="flex items-center gap-2 mb-1">
                <Coins className="w-4 h-4 text-amber-400" />
                <span className="text-xs text-slate-400">流通总价值</span>
              </div>
              <p className="text-2xl font-bold text-amber-400">{formatDenomination(stats.totalValue)} A币</p>
            </div>
            <div className="bg-gradient-to-br from-pink-500/20 to-pink-600/10 rounded-xl p-4 border border-white/5">
              <div className="flex items-center gap-2 mb-1">
                <Zap className="w-4 h-4 text-pink-400" />
                <span className="text-xs text-slate-400">即时发放型</span>
              </div>
              <p className="text-2xl font-bold text-pink-400">
                {allVouchers.filter(v => v.sourceType === VoucherSourceType.INSTANT || !v.sourceType).length}
              </p>
            </div>
            <div className="bg-gradient-to-br from-rose-500/20 to-rose-600/10 rounded-xl p-4 border border-white/5">
              <div className="flex items-center gap-2 mb-1">
                <Calculator className="w-4 h-4 text-rose-400" />
                <span className="text-xs text-slate-400">计算分配型</span>
              </div>
              <p className="text-2xl font-bold text-rose-400">
                {allVouchers.filter(v => v.sourceType === VoucherSourceType.ALGORITHM).length}
              </p>
            </div>
          </div>

          {/* 预警区 */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* 即将过期 */}
            <div className="bg-slate-800/30 rounded-2xl border border-white/10 overflow-hidden">
              <div className="p-4 bg-gradient-to-r from-amber-500/20 to-orange-500/20 border-b border-white/10">
                <h3 className="text-white font-semibold flex items-center gap-2">
                  <Clock className="w-4 h-4 text-amber-400" />
                  即将过期（7天内）
                  {expiringSoon.length > 0 && (
                    <span className="ml-auto text-amber-400 text-sm font-normal">{expiringSoon.length} 个</span>
                  )}
                </h3>
              </div>
              <div className="p-4 space-y-2 max-h-60 overflow-y-auto">
                {expiringSoon.length === 0 ? (
                  <p className="text-sm text-slate-500 text-center py-4">暂无即将过期的凭证</p>
                ) : (
                  expiringSoon.map(v => (
                    <div key={v.id} className="flex items-center justify-between p-2 bg-slate-700/30 rounded-lg">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-xs text-slate-400 font-mono truncate">{v.serialNumber}</span>
                        <span className="text-xs text-slate-500">→ {v.currentHolderName}</span>
                      </div>
                      <span className="text-xs text-amber-400 shrink-0">
                        {Math.ceil(((v.expiresAt || 0) - Date.now()) / (1000 * 60 * 60 * 24))}天后
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* 已过期未标记 */}
            <div className="bg-slate-800/30 rounded-2xl border border-white/10 overflow-hidden">
              <div className="p-4 bg-gradient-to-r from-red-500/20 to-orange-500/20 border-b border-white/10">
                <h3 className="text-white font-semibold flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 text-red-400" />
                  过期未标记
                  {pastDue.length > 0 && (
                    <span className="ml-auto text-red-400 text-sm font-normal">{pastDue.length} 个</span>
                  )}
                </h3>
              </div>
              <div className="p-4 space-y-2 max-h-60 overflow-y-auto">
                {pastDue.length === 0 ? (
                  <p className="text-sm text-slate-500 text-center py-4">无异常</p>
                ) : (
                  pastDue.map(v => (
                    <div key={v.id} className="flex items-center justify-between p-2 bg-slate-700/30 rounded-lg">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-xs text-slate-400 font-mono truncate">{v.serialNumber}</span>
                        <span className="text-xs text-slate-500">→ {v.currentHolderName}</span>
                      </div>
                      <span className="text-xs text-red-400 shrink-0">
                        {Math.ceil((Date.now() - (v.expiresAt || 0)) / (1000 * 60 * 60 * 24))}天前过期
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>

          {/* 高价值凭证 + 用户排行 */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* 高价值凭证 TOP10 */}
            <div className="bg-slate-800/30 rounded-2xl border border-white/10 overflow-hidden">
              <div className="p-4 border-b border-white/10">
                <h3 className="text-white font-semibold flex items-center gap-2">
                  <TrendingUp className="w-4 h-4 text-emerald-400" />
                  高价值凭证 TOP10
                </h3>
              </div>
              <div className="p-4 space-y-2 max-h-80 overflow-y-auto">
                {topVouchers.map((v, i) => (
                  <div key={v.id} className="flex items-center justify-between p-2 bg-slate-700/30 rounded-lg">
                    <div className="flex items-center gap-3 min-w-0">
                      <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${
                        i < 3 ? 'bg-amber-500/30 text-amber-400' : 'bg-slate-600/30 text-slate-400'
                      }`}>
                        {i + 1}
                      </span>
                      <div className="min-w-0">
                        <p className="text-sm text-white truncate">{v.serialNumber}</p>
                        <p className="text-xs text-slate-500 truncate">{v.currentHolderName}</p>
                      </div>
                    </div>
                    <span className="text-emerald-400 font-bold shrink-0">{formatDenomination(v.denomination)} A币</span>
                  </div>
                ))}
                {topVouchers.length === 0 && (
                  <p className="text-sm text-slate-500 text-center py-4">暂无正常流通的凭证</p>
                )}
              </div>
            </div>

            {/* 用户持币排行 */}
            <div className="bg-slate-800/30 rounded-2xl border border-white/10 overflow-hidden">
              <div className="p-4 border-b border-white/10">
                <h3 className="text-white font-semibold flex items-center gap-2">
                  <User className="w-4 h-4 text-blue-400" />
                  用户持值排行 TOP20
                </h3>
              </div>
              <div className="p-4 space-y-2 max-h-80 overflow-y-auto">
                {userRankings.map((u, i) => (
                  <div key={u.userId} className="flex items-center justify-between p-2 bg-slate-700/30 rounded-lg">
                    <div className="flex items-center gap-3 min-w-0">
                      <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${
                        i < 3 ? 'bg-blue-500/30 text-blue-400' : 'bg-slate-600/30 text-slate-400'
                      }`}>
                        {i + 1}
                      </span>
                      <div className="min-w-0">
                        <p className="text-sm text-white truncate">{u.userName}</p>
                        <p className="text-xs text-slate-500">{u.count} 张 ({u.instantCount}即时/{u.algorithmCount}计算)</p>
                      </div>
                    </div>
                    <span className="text-blue-400 font-bold shrink-0">{formatDenomination(u.totalValue)} A币</span>
                  </div>
                ))}
                {userRankings.length === 0 && (
                  <p className="text-sm text-slate-500 text-center py-4">暂无持有者</p>
                )}
              </div>
            </div>
          </div>

          {/* 最近交易 */}
          <div className="bg-slate-800/30 rounded-2xl border border-white/10 overflow-hidden">
            <div className="p-4 border-b border-white/10">
              <h3 className="text-white font-semibold flex items-center gap-2">
                <History className="w-4 h-4 text-indigo-400" />
                最近交易（20条）
              </h3>
            </div>
            <div className="p-4 space-y-2 max-h-80 overflow-y-auto">
              {recentTxs.map(tx => (
                <div key={tx.id} className="flex items-center justify-between p-2 bg-slate-700/30 rounded-lg text-xs">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className={`px-1.5 py-0.5 rounded font-medium ${
                      tx.type === 'create' ? 'bg-green-500/20 text-green-400' :
                      tx.type === 'transfer' ? 'bg-blue-500/20 text-blue-400' :
                      tx.type === 'freeze' ? 'bg-blue-500/20 text-blue-400' :
                      tx.type === 'unfreeze' ? 'bg-purple-500/20 text-purple-400' :
                      tx.type === 'destroy' ? 'bg-red-500/20 text-red-400' : 'bg-slate-500/20 text-slate-400'
                    }`}>
                      {tx.type === 'create' ? '创建' : tx.type === 'transfer' ? '转账' :
                       tx.type === 'freeze' ? '冻结' : tx.type === 'unfreeze' ? '解冻' :
                       tx.type === 'destroy' ? '销毁' : tx.type}
                    </span>
                    <span className="text-slate-400 font-mono truncate">{tx.voucherId.slice(0, 8)}</span>
                    {tx.fromUserName && <span className="text-slate-500">{tx.fromUserName}→</span>}
                    <span className="text-white">{tx.toUserName}</span>
                  </div>
                  <span className="text-slate-500 shrink-0">{formatDate(tx.timestamp)}</span>
                </div>
              ))}
              {recentTxs.length === 0 && (
                <p className="text-sm text-slate-500 text-center py-4">暂无交易记录</p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ========================= 批量操作 ========================= */}
      {activeSection === 'bulk' && (
        <div className="space-y-4">
          <div className="bg-slate-800/30 rounded-2xl border border-white/10 overflow-hidden">
            <div className="p-4 border-b border-white/10">
              <div className="flex items-center justify-between">
                <h3 className="text-white font-semibold flex items-center gap-2">
                  <Settings className="w-4 h-4 text-blue-400" />
                  批量凭证操作
                </h3>
                <span className="text-sm text-slate-400">
                  已选 {selectedIds.size} 个凭证
                </span>
              </div>
            </div>

            {/* 筛选过滤 */}
            <div className="p-4 border-b border-white/10 flex flex-wrap items-center gap-3">
              <select
                value={selectAllFilter}
                onChange={e => { setSelectAllFilter(e.target.value as VoucherStatus | 'all'); setSelectedIds(new Set()); }}
                className="bg-slate-800 border border-white/10 rounded-lg px-3 py-1.5 text-sm text-white"
              >
                <option value="all">全部状态</option>
                <option value={VoucherStatus.ACTIVE}>正常</option>
                <option value={VoucherStatus.FROZEN}>已冻结</option>
                <option value={VoucherStatus.EXPIRED}>已过期</option>
                <option value={VoucherStatus.DESTROYED}>已销毁</option>
              </select>
              <label className="flex items-center gap-2 text-sm text-slate-400 hover:text-slate-300 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={showDestroyedInBulk}
                  onChange={e => { setShowDestroyedInBulk(e.target.checked); setSelectedIds(new Set()); }}
                  className="w-4 h-4 rounded border-white/20 bg-slate-800 accent-blue-500"
                />
                显示已销毁凭证
              </label>
              <button
                onClick={handleSelectAll}
                className="px-3 py-1.5 bg-slate-700/50 hover:bg-slate-700 rounded-lg text-sm text-slate-300 transition-all"
              >
                {selectedIds.size === filteredForBulk.length ? '取消全选' : '全选当前'}
              </button>
            </div>

            {/* 凭证列表（可多选） */}
            <div className="max-h-72 overflow-y-auto divide-y divide-white/5">
              {filteredForBulk.length === 0 ? (
                <div className="p-8 text-center text-slate-500 text-sm">暂无凭证</div>
              ) : (
                filteredForBulk.map(v => {
                  const cfg = statusConfig[v.status];
                  const isSelected = selectedIds.has(v.id);
                  return (
                    <div
                      key={v.id}
                      onClick={() => toggleSelect(v.id)}
                      className={`flex items-center gap-3 px-4 py-3 cursor-pointer transition-all ${
                        isSelected ? 'bg-blue-500/10' : 'hover:bg-white/5'
                      }`}
                    >
                      <div className={`w-5 h-5 rounded border-2 flex items-center justify-center transition-all ${
                        isSelected ? 'bg-blue-500 border-blue-500' : 'border-white/20'
                      }`}>
                        {isSelected && <CheckCircle2 className="w-4 h-4 text-white" />}
                      </div>
                      <span className="text-sm text-slate-300 font-mono w-36 truncate">{v.serialNumber}</span>
                      <span className={`px-2 py-0.5 rounded text-xs ${cfg.bg} ${cfg.color}`}>{cfg.label}</span>
                      <span className="text-sm text-white font-medium ml-auto">{formatDenomination(v.denomination)} A币</span>
                      <span className="text-xs text-slate-500 w-24 text-right truncate">{v.currentHolderName}</span>
                    </div>
                  );
                })
              )}
            </div>

            {/* 操作按钮 */}
            {selectedIds.size > 0 && !bulkResults && (
              <div className="p-4 border-t border-white/10 flex flex-wrap gap-3">
                {(['freeze', 'unfreeze', 'destroy'] as const).map(action => {
                  const labels = { freeze: '冻结', unfreeze: '解冻', destroy: '销毁' };
                  const colors = {
                    freeze: 'from-blue-600 to-blue-500 hover:from-blue-500 hover:to-blue-400',
                    unfreeze: 'from-purple-600 to-purple-500 hover:from-purple-500 hover:to-purple-400',
                    destroy: 'from-red-600 to-red-500 hover:from-red-500 hover:to-red-400',
                  };
                  return (
                    <button
                      key={action}
                      onClick={() => { setBulkAction(action); setBulkResults(null); }}
                      className={`px-4 py-2 bg-gradient-to-r ${colors[action]} text-white rounded-xl text-sm font-medium transition-all`}
                    >
                      {labels[action]} 选中 ({selectedIds.size})
                    </button>
                  );
                })}
                <button
                  onClick={() => setSelectedIds(new Set())}
                  className="px-4 py-2 bg-slate-700/50 text-slate-300 rounded-xl text-sm hover:bg-slate-700 transition-all"
                >
                  取消选择
                </button>
              </div>
            )}

            {/* 操作确认面板 */}
            {bulkAction && !bulkResults && (
              <div className="p-4 border-t border-white/10 bg-slate-800/50">
                <h4 className="text-sm font-medium text-white mb-3">
                  确认批量{bulkAction === 'freeze' ? '冻结' : bulkAction === 'unfreeze' ? '解冻' : '销毁'} {selectedIds.size} 个凭证
                </h4>
                <textarea
                  placeholder="请输入操作原因（必填）"
                  value={bulkReason}
                  onChange={e => setBulkReason(e.target.value)}
                  rows={2}
                  className="w-full bg-slate-900 border border-white/10 rounded-lg px-3 py-2 text-sm text-white mb-3"
                />
                <div className="flex gap-3">
                  <button
                    onClick={executeBulkAction}
                    disabled={!bulkReason.trim()}
                    className="px-4 py-2 bg-red-600 text-white rounded-xl text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed hover:bg-red-500 transition-all"
                  >
                    确认执行
                  </button>
                  <button
                    onClick={() => { setBulkAction(null); setBulkReason(''); }}
                    className="px-4 py-2 bg-slate-700/50 text-slate-300 rounded-xl text-sm hover:bg-slate-700 transition-all"
                  >
                    取消
                  </button>
                </div>
              </div>
            )}

            {/* 操作结果 */}
            {bulkResults && (
              <div className="p-4 border-t border-white/10">
                <div className="flex items-center gap-4 mb-3">
                  <span className="text-green-400 flex items-center gap-1"><CheckCircle2 className="w-4 h-4" />成功 {bulkResults.success}</span>
                  {bulkResults.fail > 0 && (
                    <span className="text-red-400 flex items-center gap-1"><AlertCircle className="w-4 h-4" />失败 {bulkResults.fail}</span>
                  )}
                </div>
                {bulkResults.details.length > 0 && (
                  <div className="max-h-32 overflow-y-auto space-y-1">
                    {bulkResults.details.map((d, i) => (
                      <p key={i} className="text-xs text-red-400">{d}</p>
                    ))}
                  </div>
                )}
                <button
                  onClick={() => setBulkResults(null)}
                  className="mt-3 px-4 py-2 bg-slate-700/50 text-slate-300 rounded-xl text-sm hover:bg-slate-700 transition-all"
                >
                  完成
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ========================= 数据工具 ========================= */}
      {activeSection === 'tools' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* 数据导出 */}
          <div className="bg-slate-800/30 rounded-2xl border border-white/10 p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-lg bg-emerald-500/20 flex items-center justify-center">
                <Download className="w-5 h-5 text-emerald-400" />
              </div>
              <div>
                <h3 className="text-white font-semibold">数据导出</h3>
                <p className="text-xs text-slate-400">导出所有凭证和交易数据，用于备份</p>
              </div>
            </div>
            <button
              onClick={handleExport}
              className="w-full py-3 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white rounded-xl font-medium transition-all"
            >
              导出 JSON 备份
            </button>
          </div>

          {/* 数据导入 */}
          <div className="bg-slate-800/30 rounded-2xl border border-white/10 p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-lg bg-blue-500/20 flex items-center justify-center">
                <Upload className="w-5 h-5 text-blue-400" />
              </div>
              <div>
                <h3 className="text-white font-semibold">数据导入</h3>
                <p className="text-xs text-slate-400">从 JSON 备份恢复数据（会覆盖现有数据）</p>
              </div>
            </div>
            <button
              onClick={() => setShowImport(!showImport)}
              className="w-full py-3 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white rounded-xl font-medium transition-all"
            >
              {showImport ? '取消导入' : '导入 JSON 数据'}
            </button>
            {showImport && (
              <div className="mt-3 space-y-3">
                <textarea
                  placeholder="粘贴 JSON 数据..."
                  value={importData}
                  onChange={e => setImportData(e.target.value)}
                  rows={6}
                  className="w-full bg-slate-900 border border-white/10 rounded-lg px-3 py-2 text-sm text-white font-mono"
                />
                <div className="flex gap-2">
                  <button
                    onClick={handleImport}
                    disabled={!importData.trim()}
                    className="flex-1 py-2 bg-blue-600 text-white rounded-xl text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed hover:bg-blue-500 transition-all"
                  >
                    确认导入
                  </button>
                  <button
                    onClick={() => { setShowImport(false); setImportData(''); }}
                    className="px-4 py-2 bg-slate-700/50 text-slate-300 rounded-xl text-sm hover:bg-slate-700 transition-all"
                  >
                    取消
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* 系统统计 */}
          <div className="bg-slate-800/30 rounded-2xl border border-white/10 p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-lg bg-amber-500/20 flex items-center justify-center">
                <BarChart3 className="w-5 h-5 text-amber-400" />
              </div>
              <div>
                <h3 className="text-white font-semibold">系统统计快照</h3>
                <p className="text-xs text-slate-400">当前系统运行数据</p>
              </div>
            </div>
            <div className="space-y-3">
              {[
                { label: '总发行量', value: `${stats.total} 张` },
                { label: '流通中', value: `${stats.active} 张` },
                { label: '冻结中', value: `${stats.frozen} 张` },
                { label: '已过期', value: `${stats.expired} 张` },
                { label: '已销毁', value: `${stats.destroyed} 张` },
                { label: '总价值', value: `${formatDenomination(stats.totalValue)} A币` },
                { label: '交易总数', value: `${allTransactions.length} 条` },
              ].map(item => (
                <div key={item.label} className="flex justify-between text-sm">
                  <span className="text-slate-400">{item.label}</span>
                  <span className="text-white font-medium">{item.value}</span>
                </div>
              ))}
            </div>
          </div>

          {/* 过期清理 */}
          <div className="bg-slate-800/30 rounded-2xl border border-white/10 p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-lg bg-red-500/20 flex items-center justify-center">
                <Trash2 className="w-5 h-5 text-red-400" />
              </div>
              <div>
                <h3 className="text-white font-semibold">过期凭证清理</h3>
                <p className="text-xs text-slate-400">将已过期的凭证标记为「已过期」状态</p>
              </div>
            </div>
            <div className="mb-3 text-sm text-slate-400">
              {pastDue.length > 0 ? (
                <span className="text-red-400">发现 {pastDue.length} 个已过期但未标记的凭证</span>
              ) : (
                <span className="text-green-400">暂无待清理的过期凭证</span>
              )}
            </div>
            <button
              onClick={handleCleanExpired}
              disabled={pastDue.length === 0}
              className="w-full py-3 bg-gradient-to-r from-red-600 to-orange-600 hover:from-red-500 hover:to-orange-500 text-white rounded-xl font-medium transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              立即清理过期凭证
            </button>
          </div>
        </div>
      )}

      {/* ========================= 凭证快查 ========================= */}
      {activeSection === 'search' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* 按编号/ID查询 */}
          <div className="bg-slate-800/30 rounded-2xl border border-white/10 p-6">
            <h3 className="text-white font-semibold flex items-center gap-2 mb-4">
              <Search className="w-4 h-4 text-amber-400" />
              凭证编号 / ID 查询
            </h3>
            <div className="flex gap-2 mb-4">
              <input
                type="text"
                placeholder="输入凭证ID或编号..."
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleLookupBySerial()}
                className="flex-1 bg-slate-900 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white"
              />
              <button
                onClick={handleLookupBySerial}
                className="px-4 py-2.5 bg-amber-600 hover:bg-amber-500 text-white rounded-xl text-sm font-medium transition-all"
              >
                查询
              </button>
            </div>

            {searchResult && (
              <div className="space-y-3">
                {/* 已销毁凭证灰底覆盖 */}
                <div className={`relative ${searchResult.status === VoucherStatus.DESTROYED ? 'after:absolute after:inset-0 after:bg-slate-900/60 after:rounded-2xl after:z-10' : ''}`}>
                  <VoucherCard
                    voucher={searchResult}
                    showActions={false}
                  />
                  {searchResult.status === VoucherStatus.DESTROYED && (
                    <div className="absolute inset-0 z-20 flex items-center justify-center pointer-events-none">
                      <div className="flex flex-col items-center gap-2">
                        <Flame className="w-10 h-10 text-red-500/70" />
                        <span className="text-red-400 font-bold text-lg bg-slate-900/80 px-5 py-2 rounded-xl backdrop-blur-sm border border-red-500/30">
                          已销毁 · 不可操作
                        </span>
                      </div>
                    </div>
                  )}
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      try {
                        voucherService.freezeVoucher(searchResult.id, currentUserId, currentUsername);
                        showMsg('success', `已冻结凭证 ${searchResult.serialNumber}`);
                        setSearchResult(null);
                      } catch (e: any) { showMsg('error', e.message); }
                    }}
                    disabled={searchResult.status !== VoucherStatus.ACTIVE}
                    className="flex-1 py-2 bg-blue-600 text-white rounded-xl text-sm disabled:opacity-50 disabled:cursor-not-allowed hover:bg-blue-500 transition-all"
                  >
                    冻结
                  </button>
                  <button
                    onClick={() => {
                      try {
                        voucherService.unfreezeVoucher(searchResult.id, currentUserId, currentUsername);
                        showMsg('success', `已解冻凭证 ${searchResult.serialNumber}`);
                        setSearchResult(null);
                      } catch (e: any) { showMsg('error', e.message); }
                    }}
                    disabled={searchResult.status !== VoucherStatus.FROZEN}
                    className="flex-1 py-2 bg-purple-600 text-white rounded-xl text-sm disabled:opacity-50 disabled:cursor-not-allowed hover:bg-purple-500 transition-all"
                  >
                    解冻
                  </button>
                  <button
                    onClick={() => {
                      try {
                        voucherService.destroyVoucher(searchResult.id, currentUserId, currentUsername);
                        showMsg('success', `已销毁凭证 ${searchResult.serialNumber}`);
                        setSearchResult(null);
                      } catch (e: any) { showMsg('error', e.message); }
                    }}
                    disabled={searchResult.status === VoucherStatus.DESTROYED}
                    className="flex-1 py-2 bg-red-600 text-white rounded-xl text-sm disabled:opacity-50 disabled:cursor-not-allowed hover:bg-red-500 transition-all"
                  >
                    销毁
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* 按用户查询 */}
          <div className="bg-slate-800/30 rounded-2xl border border-white/10 p-6">
            <h3 className="text-white font-semibold flex items-center gap-2 mb-4">
              <User className="w-4 h-4 text-blue-400" />
              用户持证查询
            </h3>
            <div className="flex gap-2 mb-4">
              <input
                type="text"
                placeholder="输入用户ID..."
                value={userSearchQuery}
                onChange={e => setUserSearchQuery(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleLookupByUser()}
                className="flex-1 bg-slate-900 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white"
              />
              <button
                onClick={handleLookupByUser}
                className="px-4 py-2.5 bg-blue-600 hover:bg-blue-500 text-white rounded-xl text-sm font-medium transition-all"
              >
                查询
              </button>
            </div>

            {userSearchResult.length > 0 && (
              <div className="max-h-80 overflow-y-auto space-y-2">
                <p className="text-sm text-slate-400 mb-2">
                  找到 {userSearchResult.length} 个凭证，总价值 {formatDenomination(userSearchResult.reduce((s, v) => s + v.denomination, 0))} A币
                </p>
                {userSearchResult.map(v => {
                  const isDestroyed = v.status === VoucherStatus.DESTROYED;
                  return (
                    <div
                      key={v.id}
                      className={`flex items-center justify-between p-2 rounded-lg text-sm ${isDestroyed ? 'bg-slate-800/20 opacity-50' : 'bg-slate-700/30'}`}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span className={`font-mono text-xs truncate ${isDestroyed ? 'text-slate-500 line-through' : 'text-slate-400'}`}>{v.serialNumber}</span>
                        <span className={`px-1.5 py-0.5 rounded text-xs ${statusConfig[v.status].bg} ${statusConfig[v.status].color}`}>
                          {statusConfig[v.status].label}
                        </span>
                      </div>
                      <span className={`font-medium shrink-0 ${isDestroyed ? 'text-slate-500 line-through' : 'text-white'}`}>{formatDenomination(v.denomination)} A币</span>
                    </div>
                  );
                })}
              </div>
            )}
            {userSearchResult.length === 0 && userSearchQuery && (
              <p className="text-sm text-slate-500 text-center py-4">未找到该用户的凭证</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default VoucherManagementDashboard;
