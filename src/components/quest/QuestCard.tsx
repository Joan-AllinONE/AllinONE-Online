/**
 * QuestCard - 任务卡片
 */

import { useState } from 'react';
import { motion } from 'framer-motion';
import { Flag, Package, Palette, Code2, Music, Image, Wrench, Cpu, Coins, Users, Clock, Power, Trash2, Loader2 } from 'lucide-react';
import type { GameQuest, QuestType, QuestStatus } from '@/types/quest';
import { questService } from '@/services/questService';
import { getCurrentUserId } from '@/services/authTokenService';

const TYPE_ICONS: Record<QuestType, any> = {
  level: Flag,
  item: Package,
  skin: Palette,
  script: Code2,
  audio: Music,
  art: Image,
  fix: Wrench,
};

const TYPE_TEXT: Record<QuestType, string> = {
  level: '关卡',
  item: '道具',
  skin: '皮肤',
  script: '脚本',
  audio: '音效',
  art: '美术',
  fix: '修复',
};

const STATUS_TEXT: Record<QuestStatus, string> = {
  open: '进行中',
  review: '评审中',
  merged: '已完成',
  closed: '已关闭',
};

const STATUS_STYLE: Record<QuestStatus, string> = {
  open: 'text-green-600 bg-green-100 dark:bg-green-900/30 dark:text-green-400',
  review: 'text-amber-600 bg-amber-100 dark:bg-amber-900/30 dark:text-amber-400',
  merged: 'text-blue-600 bg-blue-100 dark:bg-blue-900/30 dark:text-blue-400',
  closed: 'text-slate-500 bg-slate-100 dark:bg-slate-700/40 dark:text-slate-400',
};

function formatDeadline(deadline?: number): string {
  if (!deadline) return '长期有效';
  const diff = deadline - Date.now();
  if (diff <= 0) return '已截止';
  const days = Math.floor(diff / 86400000);
  if (days > 0) return `${days} 天后截止`;
  const hours = Math.floor(diff / 3600000);
  return `${hours} 小时后截止`;
}

export default function QuestCard({
  quest,
  onOpen,
  onChanged,
}: {
  quest: GameQuest;
  onOpen: (q: GameQuest) => void;
  onChanged?: () => void;
}) {
  const TypeIcon = TYPE_ICONS[quest.type] || Package;
  const reward = quest.reward || {};

  // 创建者操作：关闭/删除（仅创建者可见）
  const isOwner = !!quest.createdBy && quest.createdBy === getCurrentUserId();
  const [adminBusy, setAdminBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  /** 关闭任务（创建者专属） */
  const handleClose = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (adminBusy) return;
    setAdminBusy(true);
    const r = await questService.closeQuest(quest.id);
    setAdminBusy(false);
    if (r.success && onChanged) onChanged();
  };

  /** 删除任务（创建者专属；二次确认） */
  const handleDelete = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (adminBusy) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      setTimeout(() => setConfirmDelete(false), 3000);
      return;
    }
    setAdminBusy(true);
    const r = await questService.deleteQuest(quest.id);
    setAdminBusy(false);
    setConfirmDelete(false);
    if (r.success && onChanged) onChanged();
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      whileHover={{ y: -4 }}
      onClick={() => onOpen(quest)}
      className="bg-white dark:bg-slate-800 rounded-xl shadow-md hover:shadow-xl transition-all duration-300 overflow-hidden group cursor-pointer border border-transparent hover:border-indigo-200 dark:hover:border-indigo-800"
    >
      <div className="p-6">
        <div className="flex items-start justify-between mb-4">
          <div className="w-14 h-14 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center text-white group-hover:scale-110 transition-transform">
            <TypeIcon className="w-7 h-7" />
          </div>
          <div className="flex flex-col items-end gap-2">
            <span className={`px-2 py-1 rounded-full text-xs font-medium ${STATUS_STYLE[quest.status]}`}>
              {STATUS_TEXT[quest.status]}
            </span>
            <span className="text-xs text-slate-400 flex items-center gap-1">
              <Clock className="w-3 h-3" />
              {formatDeadline(quest.deadline)}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2 mb-2">
          <span className="px-2 py-0.5 rounded text-xs font-medium bg-indigo-50 text-indigo-600 dark:bg-indigo-900/30 dark:text-indigo-400">
            {TYPE_TEXT[quest.type]}
          </span>
          {quest.gameName && (
            <span className="text-xs text-slate-400 truncate">{quest.gameName}</span>
          )}
        </div>

        <h3 className="text-lg font-bold text-slate-900 dark:text-white mb-2 line-clamp-1">{quest.title}</h3>
        <p className="text-slate-600 dark:text-slate-300 text-sm mb-4 line-clamp-2">{quest.description}</p>

        <div className="flex items-center gap-4 mb-4 text-sm text-slate-500 dark:text-slate-400 flex-wrap">
          {reward.gameCoins ? (
            <span className="flex items-center gap-1">
              <Coins className="w-4 h-4 text-yellow-500" />
              {reward.gameCoins} 游戏币
            </span>
          ) : null}
          {reward.aCoins ? (
            <span className="flex items-center gap-1">
              <Cpu className="w-4 h-4 text-violet-500" />
              {reward.aCoins} A币
            </span>
          ) : null}
          <span className="flex items-center gap-1">
            <Users className="w-4 h-4" />
            {quest.maxClaimers === 0 ? '不限人数' : `限 ${quest.maxClaimers} 人`}
          </span>
        </div>

        {/* 创建者专属操作：关闭 / 删除 */}
        {isOwner && (
          <div className="flex items-center gap-2 mb-3" onClick={(e) => e.stopPropagation()}>
            <button
              onClick={handleClose}
              disabled={adminBusy || quest.status === 'closed' || quest.status === 'merged'}
              title={quest.status === 'closed' || quest.status === 'merged' ? '该任务已结束' : '关闭任务（停止接单）'}
              className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium border border-amber-300 text-amber-700 hover:bg-amber-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors dark:border-amber-700/50 dark:text-amber-400 dark:hover:bg-amber-950/40"
            >
              {adminBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Power className="w-3.5 h-3.5" />}
              关闭
            </button>
            <button
              onClick={handleDelete}
              disabled={adminBusy || quest.status !== 'closed'}
              title={quest.status === 'closed' ? (confirmDelete ? '再次点击确认删除（不可恢复）' : '删除任务（不可恢复）') : '仅已关闭的任务可删除（先关闭再删除）'}
              className={`flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                confirmDelete
                  ? 'border-red-500 bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-400'
                  : 'border-red-300 text-red-600 hover:bg-red-50 disabled:opacity-40 disabled:cursor-not-allowed dark:border-red-700/50 dark:text-red-400 dark:hover:bg-red-950/40'
              }`}
            >
              {adminBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
              {confirmDelete ? '确认删除?' : '删除'}
            </button>
          </div>
        )}

        <button className="w-full py-2 px-4 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg font-medium transition-colors text-sm">
          查看详情
        </button>
      </div>
    </motion.div>
  );
}
