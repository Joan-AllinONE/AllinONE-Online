/**
 * QuestCreateModal - 发布任务弹窗（可复用）
 *
 * 供任务广场「发布任务」和游戏商店「任务发布」入口复用。
 * 可传入 defaultGameId / defaultGameName，用于从游戏商店进入时预填当前游戏。
 */

import { useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { X, Target, Send, Upload, FileText, Trash2, FileCode } from 'lucide-react';
import type { GameQuest, QuestType } from '@/types/quest';
import { QUEST_SLOT_SCHEMAS, getQuestSlotSchema } from '@/types/quest';
import { questService } from '@/services/questService';
import { getCurrentUserId } from '@/services/authTokenService';

const QUEST_TYPES: Array<{ key: QuestType; label: string }> = [
  { key: 'level', label: '关卡' },
  { key: 'item', label: '道具' },
  { key: 'skin', label: '皮肤' },
  { key: 'script', label: '脚本' },
  { key: 'audio', label: '音效' },
  { key: 'art', label: '美术' },
  { key: 'fix', label: '修复' },
];

interface Props {
  defaultGameId?: string;
  defaultGameName?: string;
  onClose: () => void;
  onCreated?: (quest: GameQuest) => void;
}

export default function QuestCreateModal({
  defaultGameId = '',
  defaultGameName = '',
  onClose,
  onCreated,
}: Props) {
  const [gameId, setGameId] = useState(defaultGameId);
  const [gameName, setGameName] = useState(defaultGameName);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [type, setType] = useState<QuestType>('level');
  const [slot, setSlot] = useState('levels');
  const [slotCustom, setSlotCustom] = useState('');
  const [reviewMode, setReviewMode] = useState<'developer' | 'community'>('developer');
  const [reward, setReward] = useState({ gameCoins: 100, aCoins: 0 });
  const [maxClaimers, setMaxClaimers] = useState(3);
  const [devGuide, setDevGuide] = useState('');
  const [devGuideName, setDevGuideName] = useState('');
  const [msg, setMsg] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const devGuideInputRef = useRef<HTMLInputElement>(null);

  /** 读取选中的 .md 开发说明文件（纯文本，≤1MB，避免大文档） */
  const handleDevGuideFile = async (file: File) => {
    if (!file) return;
    if (!/\.(md|markdown|txt)$/i.test(file.name)) {
      setMsg('开发说明仅支持 .md / .markdown / .txt 文本文件');
      return;
    }
    if (file.size > 1024 * 1024) {
      setMsg('开发说明文件过大（上限 1MB）');
      return;
    }
    try {
      const text = await file.text();
      setDevGuide(text);
      setDevGuideName(file.name);
      setMsg('');
    } catch (e) {
      setMsg('读取文件失败: ' + (e instanceof Error ? e.message : String(e)));
    }
  };

  const handleCreate = async () => {
    if (!gameId.trim() || !title.trim()) {
      setMsg('请至少填写游戏 ID 和任务标题');
      return;
    }
    setSubmitting(true);
    setMsg('');
    const quest: GameQuest = {
      id: `quest_${Date.now()}`,
      gameId: gameId.trim(),
      gameName: gameName.trim() || undefined,
      title: title.trim(),
      description: description.trim(),
      type,
      reward,
      escrow: { source: 'platform', frozen: {}, status: 'frozen' },
      sourceSnapshot: { ref: '', license: 'open', allowedPaths: [] },
      acceptance: { maxFileSize: 512 * 1024, description: description.trim() },
      contentSlot: slot.trim() || 'levels',
      maxClaimers,
      status: 'open',
      reviewMode,
      voteThreshold: 3,
      devGuide: devGuide || undefined,
      devGuideName: devGuideName || undefined,
      createdBy: getCurrentUserId(),
      createdAt: Date.now(),
    };
    const r = await questService.createQuest(quest);
    setSubmitting(false);
    if (r) {
      onCreated?.(r);
    } else {
      setMsg('发布失败，请检查是否已登录');
    }
  };

  return (
    <AnimatePresence>
      <motion.div
        className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
      >
        <motion.div
          className="bg-slate-900 rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto p-6 border border-slate-700"
          initial={{ scale: 0.95, y: 20 }}
          animate={{ scale: 1, y: 0 }}
          exit={{ scale: 0.95, y: 20 }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-bold text-white flex items-center gap-2">
              <Target className="w-5 h-5 text-indigo-400" />
              发布新任务
            </h2>
            <button
              onClick={onClose}
              className="p-1.5 hover:bg-slate-800 rounded-lg transition-colors"
            >
              <X className="w-5 h-5 text-slate-400" />
            </button>
          </div>

          <div className="space-y-3">
            <div>
              <label className="block text-xs text-slate-400 mb-1">游戏 ID *</label>
              <input
                value={gameId}
                onChange={(e) => setGameId(e.target.value)}
                placeholder="如 mario-game"
                className="w-full px-3 py-2 rounded-lg border border-slate-600 bg-slate-800 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">游戏名称</label>
              <input
                value={gameName}
                onChange={(e) => setGameName(e.target.value)}
                placeholder="如 超级马里奥"
                className="w-full px-3 py-2 rounded-lg border border-slate-600 bg-slate-800 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">任务标题 *</label>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="如 制作第二关"
                className="w-full px-3 py-2 rounded-lg border border-slate-600 bg-slate-800 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">任务描述</label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
                placeholder="描述任务要求和验收标准"
                className="w-full px-3 py-2 rounded-lg border border-slate-600 bg-slate-800 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">任务开发说明（可选）</label>
              <input
                ref={devGuideInputRef}
                type="file"
                accept=".md,.markdown,.txt,text/markdown"
                className="hidden"
                onChange={(e) => e.target.files?.[0] && handleDevGuideFile(e.target.files[0])}
              />
              {!devGuide ? (
                <button
                  type="button"
                  onClick={() => devGuideInputRef.current?.click()}
                  className="w-full px-3 py-2.5 rounded-lg border border-dashed border-slate-600 text-slate-400 text-xs hover:border-indigo-400 hover:text-indigo-400 transition-colors flex items-center justify-center gap-2"
                >
                  <Upload className="w-4 h-4" />
                  上传游戏任务开发说明（.md，玩家领取时可查看/下载）
                </button>
              ) : (
                <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-slate-600 bg-slate-800">
                  <FileText className="w-4 h-4 text-indigo-400 shrink-0" />
                  <span className="flex-1 text-xs text-slate-200 truncate">{devGuideName || '任务开发说明.md'}</span>
                  <span className="text-[11px] text-slate-500 shrink-0">{devGuide.length} 字符</span>
                  <button
                    type="button"
                    onClick={() => devGuideInputRef.current?.click()}
                    className="p-1 rounded hover:bg-slate-700 text-slate-400 hover:text-indigo-400 transition-colors"
                    title="更换文件"
                  >
                    <FileCode className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setDevGuide('');
                      setDevGuideName('');
                      if (devGuideInputRef.current) devGuideInputRef.current.value = '';
                    }}
                    className="p-1 rounded hover:bg-red-950/40 text-slate-400 hover:text-red-500 transition-colors"
                    title="移除"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}
              <p className="mt-1.5 text-[11px] text-slate-500">
                建议上传《任务开发说明》模板填写的文档（只公开接口、不暴露源码），领取任务的玩家可在任务详情查看与下载。
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-slate-400 mb-1">任务类型</label>
                <select
                  value={type}
                  onChange={(e) => setType(e.target.value as QuestType)}
                  className="w-full px-3 py-2 rounded-lg border border-slate-600 bg-slate-800 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                >
                  {QUEST_TYPES.map((t) => (
                    <option key={t.key} value={t.key}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1">挂载点 slot</label>
                <select
                  value={getQuestSlotSchema(slot) ? slot : '__custom'}
                  onChange={(e) => setSlot(e.target.value === '__custom' ? slotCustom : e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-slate-600 bg-slate-800 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                >
                  {QUEST_SLOT_SCHEMAS.map((s) => (
                    <option key={s.key} value={s.key}>
                      {s.key}（{s.label}）
                    </option>
                  ))}
                  <option value="__custom">自定义（自由扩展）</option>
                </select>
                {!getQuestSlotSchema(slot) && (
                  <input
                    value={slotCustom}
                    onChange={(e) => {
                      setSlotCustom(e.target.value);
                      setSlot(e.target.value);
                    }}
                    placeholder="自定义 slot 名，如 scripts/my-patch"
                    className="mt-2 w-full px-3 py-2 rounded-lg border border-slate-600 bg-slate-800 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                )}
                {getQuestSlotSchema(slot) && (
                  <p className="mt-1.5 text-xs text-slate-500 leading-relaxed">{getQuestSlotSchema(slot)!.hint}</p>
                )}
              </div>
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">审核方式</label>
              <select
                value={reviewMode}
                onChange={(e) => setReviewMode(e.target.value as 'developer' | 'community')}
                className="w-full px-3 py-2 rounded-lg border border-slate-600 bg-slate-800 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
                <option value="developer">开发者直审</option>
                <option value="community">社区投票（赞成票达标自动通过）</option>
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-slate-400 mb-1">游戏币报酬</label>
                <input
                  type="number"
                  value={reward.gameCoins}
                  onChange={(e) => setReward({ ...reward, gameCoins: Number(e.target.value) || 0 })}
                  className="w-full px-3 py-2 rounded-lg border border-slate-600 bg-slate-800 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
                <p className="mt-1 text-[11px] text-slate-500">平台游戏币（合并通过后发放）</p>
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1">A币报酬</label>
                <input
                  type="number"
                  value={reward.aCoins}
                  onChange={(e) => setReward({ ...reward, aCoins: Number(e.target.value) || 0 })}
                  className="w-full px-3 py-2 rounded-lg border border-slate-600 bg-slate-800 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
                <p className="mt-1 text-[11px] text-slate-500">A币凭证（合并通过后发放）</p>
              </div>
            </div>
            <p className="text-[11px] text-slate-500 -mt-1">游戏币与 A币可二选一填写，合并通过后自动发放到提交者平台钱包。</p>
            <div>
              <label className="block text-xs text-slate-400 mb-1">领取人数上限（0=不限）</label>
              <input
                type="number"
                value={maxClaimers}
                onChange={(e) => setMaxClaimers(Number(e.target.value) || 0)}
                className="w-full px-3 py-2 rounded-lg border border-slate-600 bg-slate-800 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
            {msg && <p className="text-sm text-amber-400">{msg}</p>}
            <div className="flex gap-2 pt-2">
              <button
                onClick={handleCreate}
                disabled={submitting}
                className="flex-1 py-2.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white rounded-lg font-medium transition-colors flex items-center justify-center gap-2"
              >
                <Send className="w-4 h-4" />
                {submitting ? '发布中...' : '发布任务'}
              </button>
              <button
                onClick={onClose}
                className="px-4 py-2.5 border border-slate-600 text-slate-300 rounded-lg hover:bg-slate-800 transition-colors"
              >
                取消
              </button>
            </div>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
