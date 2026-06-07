/**
 * A币电子凭证系统 - 凭证卡片组件
 */

import { useState, forwardRef } from 'react';
import { motion } from 'framer-motion';
import {
  BadgeCheck,
  Clock,
  User,
  ArrowRightLeft,
  History,
  Snowflake,
  Trash2,
  Copy,
  CheckCircle2,
  AlertCircle,
  CircleDollarSign,
  Zap,
  Calculator,
} from 'lucide-react';
import { Voucher, VoucherStatus, Transaction, VoucherSourceType } from '../types';

interface VoucherCardProps {
  voucher: Voucher;
  showActions?: boolean;
  onTransfer?: (voucher: Voucher) => void;
  onFreeze?: (voucher: Voucher) => void;
  onUnfreeze?: (voucher: Voucher) => void;
  onDestroy?: (voucher: Voucher) => void;
  onViewHistory?: (voucher: Voucher) => void;
  onViewDetails?: (voucher: Voucher) => void;  // 兼容 VoucherManager 的命名
  compact?: boolean;
  index?: number;  // 兼容 VoucherManager 的动画索引
  isOwner?: boolean;  // 兼容 VoucherManager 的所有者标记
}

const statusConfig = {
  [VoucherStatus.ACTIVE]: {
    color: 'bg-green-500/20 text-green-600 border-green-500/30',
    icon: BadgeCheck,
    label: '正常',
  },
  [VoucherStatus.FROZEN]: {
    color: 'bg-blue-500/20 text-blue-600 border-blue-500/30',
    icon: Snowflake,
    label: '已冻结',
  },
  [VoucherStatus.EXPIRED]: {
    color: 'bg-amber-500/20 text-amber-600 border-amber-500/30',
    icon: Clock,
    label: '已过期',
  },
  [VoucherStatus.DESTROYED]: {
    color: 'bg-red-500/20 text-red-600 border-red-500/30',
    icon: Trash2,
    label: '已销毁',
  },
  [VoucherStatus.REDEEMED]: {
    color: 'bg-purple-500/20 text-purple-600 border-purple-500/30',
    icon: CheckCircle2,
    label: '已兑换',
  },
};

/** 未知状态的兜底配置（防止未来新增状态值导致崩溃） */
const DEFAULT_STATUS = {
  color: 'bg-gray-500/20 text-gray-600 border-gray-500/30',
  icon: AlertCircle,
  label: '未知',
};

export const VoucherCard = forwardRef<HTMLDivElement, VoucherCardProps>(function VoucherCardInner({
  voucher,
  showActions = true,
  onTransfer,
  onFreeze,
  onUnfreeze,
  onDestroy,
  onViewHistory,
  onViewDetails,
  compact = false,
  index,
  isOwner,
}, ref) {
  const [copied, setCopied] = useState(false);
  const status = statusConfig[voucher.status] || DEFAULT_STATUS;
  const StatusIcon = status.icon;
  
  // 判断凭证来源类型
  const isAlgorithmVoucher = voucher.sourceType === VoucherSourceType.ALGORITHM;
  const isInstantVoucher = voucher.sourceType === VoucherSourceType.INSTANT || !voucher.sourceType;
  
  // 抑制未使用变量警告（这些 props 用于父组件的动画和控制）
  void index;
  void isOwner;

  const handleCopyId = () => {
    navigator.clipboard.writeText(voucher.id);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const formatDate = (timestamp: number) => {
    return new Date(timestamp).toLocaleDateString('zh-CN', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

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

  const formatDuration = (ms: number) => {
    const days = Math.floor(ms / (1000 * 60 * 60 * 24));
    if (days > 365) return `${Math.floor(days / 365)}年前`;
    if (days > 30) return `${Math.floor(days / 30)}个月前`;
    if (days > 0) return `${days}天前`;
    return '今天';
  };

  if (compact) {
    return (
      <motion.div
        ref={ref}
        whileHover={{ scale: 1.02 }}
        className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 p-4 shadow-sm hover:shadow-md transition-all"
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className={`w-10 h-10 rounded-lg ${status.color} flex items-center justify-center`}>
              <StatusIcon className="w-5 h-5" />
            </div>
            <div>
              <h4 className="font-semibold text-slate-900 dark:text-white text-sm">
                {voucher.serialNumber}
              </h4>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                {voucher.metadata?.name || 'A币凭证'}
              </p>
            </div>
          </div>
          <div className="text-right">
            <p className="font-bold text-slate-900 dark:text-white">
              {formatDenomination(voucher.denomination)} A币
            </p>
            <span className={`text-xs px-2 py-0.5 rounded-full border ${status.color}`}>
              {status.label}
            </span>
          </div>
        </div>
      </motion.div>
    );
  }

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      whileHover={{ y: -4 }}
      className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 overflow-hidden shadow-lg hover:shadow-xl transition-all duration-300"
    >
      {/* Header with gradient - 双轨系统根据来源类型使用不同渐变 */}
      <div className={`relative h-24 bg-gradient-to-br ${
        isAlgorithmVoucher 
          ? 'from-rose-600 via-pink-600 to-purple-600' 
          : 'from-purple-600 via-indigo-600 to-blue-600'
      }`}>
        <div className="absolute inset-0 bg-black/10" />
        <div className="absolute top-4 left-4 right-4 flex items-start justify-between">
          <div className="flex items-center gap-2">
            {/* 状态标签 */}
            <div className={`px-3 py-1 rounded-full border ${status.color} backdrop-blur-sm bg-white/80 dark:bg-slate-900/80`}>
              <div className="flex items-center gap-1.5">
                <StatusIcon className="w-3.5 h-3.5" />
                <span className="text-xs font-medium">{status.label}</span>
              </div>
            </div>
            {/* 双轨来源类型标签 */}
            <div className={`px-2 py-1 rounded-full text-xs font-medium backdrop-blur-sm ${
              isAlgorithmVoucher 
                ? 'bg-rose-500/80 text-white' 
                : 'bg-pink-500/80 text-white'
            }`}>
              <div className="flex items-center gap-1">
                {isAlgorithmVoucher ? <Calculator className="w-3 h-3" /> : <Zap className="w-3 h-3" />}
                {isAlgorithmVoucher ? '计算型' : '即时型'}
              </div>
            </div>
          </div>
          <button
            onClick={handleCopyId}
            className="p-2 rounded-lg bg-white/20 hover:bg-white/30 backdrop-blur-sm transition-colors"
            title="复制凭证ID"
          >
            {copied ? (
              <CheckCircle2 className="w-4 h-4 text-green-300" />
            ) : (
              <Copy className="w-4 h-4 text-white" />
            )}
          </button>
        </div>
        <div className="absolute bottom-4 left-4">
          <p className="text-white/70 text-xs font-medium">凭证编号</p>
          <p className="text-white font-bold text-lg tracking-wider">{voucher.serialNumber}</p>
        </div>
      </div>

      {/* Content */}
      <div className="p-5 space-y-4">
        {/* Value */}
        <div className="flex items-center justify-between p-3 bg-gradient-to-r from-amber-50 to-orange-50 dark:from-amber-900/20 dark:to-orange-900/20 rounded-xl border border-amber-200 dark:border-amber-800">
          <div className="flex items-center gap-2">
            <CircleDollarSign className="w-5 h-5 text-amber-600" />
            <span className="text-sm text-slate-600 dark:text-slate-400">面额</span>
          </div>
          <span className="text-xl font-bold text-amber-700 dark:text-amber-400">
            {formatDenomination(voucher.denomination)} A币
          </span>
        </div>

        {/* Info Grid */}
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div className="space-y-1">
            <p className="text-slate-500 dark:text-slate-400 flex items-center gap-1.5">
              <User className="w-3.5 h-3.5" />
              持有者
            </p>
            <p className="font-medium text-slate-900 dark:text-white truncate">
              {voucher.currentHolderName}
            </p>
          </div>
          <div className="space-y-1">
            <p className="text-slate-500 dark:text-slate-400 flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5" />
              创建时间
            </p>
            <p className="font-medium text-slate-900 dark:text-white">
              {formatDate(voucher.createdAt)}
            </p>
          </div>
        </div>

        {/* Transfer Count */}
        {voucher.transferCount > 0 && (
          <div className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400 p-2 bg-slate-50 dark:bg-slate-700/50 rounded-lg">
            <ArrowRightLeft className="w-4 h-4" />
            <span>已流转 <strong className="text-slate-900 dark:text-white">{voucher.transferCount}</strong> 次</span>
            {voucher.lastTransferAt && (
              <span className="text-xs text-slate-400">
                (上次: {formatDuration(Date.now() - voucher.lastTransferAt)})
              </span>
            )}
          </div>
        )}
        
        {/* 算法凭证额外信息 */}
        {isAlgorithmVoucher && voucher.algorithmInfo && (
          <div className="space-y-2 p-3 bg-rose-50 dark:bg-rose-900/20 rounded-lg border border-rose-200 dark:border-rose-800">
            <div className="flex items-center gap-2 text-sm">
              <Calculator className="w-4 h-4 text-rose-500" />
              <span className="text-rose-700 dark:text-rose-400 font-medium">计算分配信息</span>
            </div>
            {/* 凭证数量和总价值 */}
            <div className="grid grid-cols-2 gap-2 text-xs p-2 bg-white/50 dark:bg-slate-800/50 rounded-lg">
              <div>
                <span className="text-slate-500 dark:text-slate-400">本周期获得</span>
                <p className="text-rose-600 dark:text-rose-400 font-semibold">
                  {Math.round(voucher.algorithmInfo.actualAmount / voucher.denomination)} 张
                </p>
              </div>
              <div>
                <span className="text-slate-500 dark:text-slate-400">总价值</span>
                <p className="text-rose-600 dark:text-rose-400 font-semibold">
                  {formatDenomination(voucher.algorithmInfo.actualAmount)} A币
                </p>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div>
                <span className="text-slate-500 dark:text-slate-400">贡献比例</span>
                <p className="text-rose-600 dark:text-rose-400 font-medium">
                  {(voucher.algorithmInfo.contributionRatio * 100).toFixed(2)}%
                </p>
              </div>
              <div>
                <span className="text-slate-500 dark:text-slate-400">贡献分数</span>
                <p className="text-rose-600 dark:text-rose-400 font-medium">
                  {voucher.algorithmInfo.contributionScore.toFixed(4)}
                </p>
              </div>
            </div>
            {voucher.algorithmInfo.settlementCycleId && (
              <div className="text-xs text-slate-500 dark:text-slate-400 pt-2 border-t border-rose-200 dark:border-rose-800">
                结算周期: #{voucher.algorithmInfo.settlementCycleId.slice(-6)}
              </div>
            )}
          </div>
        )}

        {/* Metadata */}
        {voucher.metadata?.name && (
          <div className="text-sm">
            <p className="text-slate-500 dark:text-slate-400">名称</p>
            <p className="font-medium text-slate-900 dark:text-white">{voucher.metadata.name}</p>
          </div>
        )}
        {voucher.metadata?.description && (
          <div className="text-sm">
            <p className="text-slate-500 dark:text-slate-400">描述</p>
            <p className="text-slate-700 dark:text-slate-300 line-clamp-2">{voucher.metadata.description}</p>
          </div>
        )}

        {/* Expiration Warning */}
        {voucher.expiresAt && voucher.status === VoucherStatus.ACTIVE && (
          <div className={`flex items-center gap-2 text-sm p-2 rounded-lg ${
            Date.now() > voucher.expiresAt - 7 * 24 * 60 * 60 * 1000
              ? 'bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400'
              : 'bg-amber-50 dark:bg-amber-900/20 text-amber-600 dark:text-amber-400'
          }`}>
            <AlertCircle className="w-4 h-4" />
            <span>
              {Date.now() > voucher.expiresAt
                ? '已过期'
                : `将于 ${formatDate(voucher.expiresAt)} 过期`}
            </span>
          </div>
        )}

        {/* Actions */}
        {showActions && voucher.status === VoucherStatus.ACTIVE && (
          <div className="pt-3 border-t border-slate-200 dark:border-slate-700 grid grid-cols-2 gap-2">
            <button
              onClick={() => onTransfer?.(voucher)}
              className="flex items-center justify-center gap-1.5 py-2 px-3 bg-purple-600 hover:bg-purple-700 text-white rounded-lg text-sm font-medium transition-colors"
            >
              <ArrowRightLeft className="w-4 h-4" />
              转账
            </button>
            <button
              onClick={() => {
                // 优先调用 onViewDetails（VoucherManager 使用），否则调用 onViewHistory
                if (onViewDetails) {
                  onViewDetails(voucher);
                } else {
                  onViewHistory?.(voucher);
                }
              }}
              className="flex items-center justify-center gap-1.5 py-2 px-3 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-300 rounded-lg text-sm font-medium transition-colors"
            >
              <History className="w-4 h-4" />
              历史
            </button>
          </div>
        )}

        {showActions && voucher.status === VoucherStatus.FROZEN && (
          <div className="pt-3 border-t border-slate-200 dark:border-slate-700">
            <button
              onClick={() => onUnfreeze?.(voucher)}
              className="w-full flex items-center justify-center gap-1.5 py-2 px-3 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium transition-colors"
            >
              <Snowflake className="w-4 h-4" />
              解冻凭证
            </button>
          </div>
        )}
      </div>
    </motion.div>
  );
});
