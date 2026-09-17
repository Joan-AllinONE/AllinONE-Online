/**
 * QuestReviewPanel - 评审与合并面板
 *
 * P1 扩展：
 * - reviewMode='developer'：开发者直审（通过/驳回/合并）
 * - reviewMode='community'：社区投票（赞成/反对，达标自动通过）+ 合并
 * - 落选 submission 可「转社区模组」
 * - 可「关闭任务」（退回 escrow）
 */

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  CheckCircle,
  XCircle,
  GitMerge,
  RefreshCw,
  Inbox,
  ThumbsUp,
  ThumbsDown,
  PackagePlus,
  Power,
  ExternalLink,
} from 'lucide-react';
import type { GameQuest, QuestSubmission } from '@/types/quest';
import { questService } from '@/services/questService';

const STATUS_TEXT: Record<string, string> = {
  pending: '待处理',
  'auto-failed': '校验失败',
  reviewing: '待评审',
  approved: '已通过',
  merged: '已合并',
  rejected: '已驳回',
};

const STATUS_STYLE: Record<string, string> = {
  pending: 'text-slate-500 bg-slate-100 dark:bg-slate-700/40',
  'auto-failed': 'text-red-600 bg-red-100 dark:bg-red-900/30',
  reviewing: 'text-amber-600 bg-amber-100 dark:bg-amber-900/30',
  approved: 'text-green-600 bg-green-100 dark:bg-green-900/30',
  merged: 'text-blue-600 bg-blue-100 dark:bg-blue-900/30',
  rejected: 'text-slate-500 bg-slate-100 dark:bg-slate-700/40',
};

export default function QuestReviewPanel({ quest, onChanged }: { quest: GameQuest; onChanged: () => void }) {
  const [subs, setSubs] = useState<QuestSubmission[]>([]);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState('');

  const reviewMode: 'developer' | 'community' = quest.reviewMode || 'developer';

  const load = async () => {
    setLoading(true);
    const list = await questService.listSubmissions(quest.id);
    setSubs(list);
    setLoading(false);
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quest.id]);

  const handleReview = async (sub: QuestSubmission, verdict: 'approve' | 'reject') => {
    const r = await questService.reviewSubmission(quest.id, sub.id, verdict, '');
    setMsg(r.message);
    await load();
    onChanged();
  };

  const handleVote = async (sub: QuestSubmission, decision: 'approve' | 'reject') => {
    const r = await questService.vote(quest.id, sub.id, decision);
    setMsg(r.message);
    await load();
    onChanged();
  };

  const handleMerge = async (sub: QuestSubmission) => {
    const r = await questService.mergeQuest(quest.id, sub.id);
    setMsg(r.message);
    await load();
    onChanged();
  };

  const handleConvert = async (sub: QuestSubmission) => {
    const r = await questService.convertToMod(quest.id, sub.id);
    setMsg(r.message);
    await load();
    onChanged();
  };

  const handleClose = async () => {
    const r = await questService.closeQuest(quest.id);
    setMsg(r.message);
    await load();
    onChanged();
  };

  const voteCount = (sub: QuestSubmission, decision: 'approve' | 'reject') =>
    (sub.votes || []).filter((v) => v.decision === decision).length;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="text-sm font-semibold text-slate-700 dark:text-slate-200">提交列表（{subs.length}）</div>
          <span
            className={`px-2 py-0.5 rounded text-xs font-medium ${
              reviewMode === 'community'
                ? 'text-violet-600 bg-violet-100 dark:bg-violet-900/30'
                : 'text-indigo-600 bg-indigo-100 dark:bg-indigo-900/30'
            }`}
          >
            {reviewMode === 'community' ? '社区投票' : '开发者直审'}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {quest.status === 'open' && (
            <button
              onClick={handleClose}
              className="px-3 py-1.5 text-xs bg-slate-500 hover:bg-slate-600 text-white rounded-lg flex items-center gap-1"
            >
              <Power className="w-3.5 h-3.5" /> 关闭任务
            </button>
          )}
          <button
            onClick={load}
            className="p-2 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors"
            title="刷新"
          >
            <RefreshCw className={`w-4 h-4 text-slate-400 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {msg && <p className="text-sm text-indigo-600">{msg}</p>}

      {!loading && subs.length === 0 && (
        <div className="flex flex-col items-center justify-center py-10 text-slate-400">
          <Inbox className="w-10 h-10 mb-2" />
          <span className="text-sm">暂无提交</span>
        </div>
      )}

      {subs.map((sub) => {
        const sid = sub.id || '';
        const approves = voteCount(sub, 'approve');
        const rejects = voteCount(sub, 'reject');
        return (
          <div key={sid} className="p-4 rounded-xl border border-slate-200 dark:border-slate-700 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-slate-800 dark:text-slate-200">{sub.submitterName}</span>
                <span className={`px-2 py-0.5 rounded text-xs font-medium ${STATUS_STYLE[sub.status] || ''}`}>
                  {STATUS_TEXT[sub.status] || sub.status}
                </span>
                {sub.convertedToMod && (
                  <span className="px-2 py-0.5 rounded text-xs font-medium text-fuchsia-600 bg-fuchsia-100 dark:bg-fuchsia-900/30">
                    已转模组
                  </span>
                )}
              </div>
              <span className="text-xs text-slate-400">{new Date(sub.createdAt).toLocaleString()}</span>
            </div>

            {sub.description && <p className="text-sm text-slate-600 dark:text-slate-300">{sub.description}</p>}

            {sub.autoCheck && !sub.autoCheck.passed && (
              <div className="p-2 rounded-lg bg-red-50 dark:bg-red-900/20 text-xs text-red-600 space-y-1">
                {sub.autoCheck.issues.map((issue, i) => (
                  <div key={i}>· {issue}</div>
                ))}
              </div>
            )}

            {/* 社区投票票数 */}
            {reviewMode === 'community' && (sub.status === 'reviewing' || sub.status === 'approved') && (
              <div className="flex items-center gap-4 text-xs text-slate-500">
                <span className="flex items-center gap-1 text-green-600">
                  <ThumbsUp className="w-3.5 h-3.5" /> {approves}
                </span>
                <span className="flex items-center gap-1 text-red-500">
                  <ThumbsDown className="w-3.5 h-3.5" /> {rejects}
                </span>
                <span>通过需 {quest.voteThreshold || 3} 票赞成</span>
              </div>
            )}

            <details className="text-sm">
              <summary className="cursor-pointer text-xs text-slate-500 hover:text-slate-700">查看内容包 JSON</summary>
              <pre className="mt-2 p-2 rounded-lg bg-slate-50 dark:bg-slate-800 text-xs overflow-auto max-h-40">
                {JSON.stringify(sub.contentPack, null, 2)}
              </pre>
            </details>

            <div className="flex gap-2 flex-wrap">
              {reviewMode === 'developer' && (sub.status === 'reviewing' || sub.status === 'auto-failed') && (
                <>
                  <button
                    onClick={() => handleReview(sub, 'approve')}
                    className="flex-1 py-1.5 bg-green-600 hover:bg-green-700 text-white rounded-lg text-sm flex items-center justify-center gap-1"
                  >
                    <CheckCircle className="w-4 h-4" /> 通过
                  </button>
                  <button
                    onClick={() => handleReview(sub, 'reject')}
                    className="flex-1 py-1.5 bg-slate-500 hover:bg-slate-600 text-white rounded-lg text-sm flex items-center justify-center gap-1"
                  >
                    <XCircle className="w-4 h-4" /> 驳回
                  </button>
                </>
              )}

              {reviewMode === 'community' && sub.status === 'reviewing' && (
                <>
                  <button
                    onClick={() => handleVote(sub, 'approve')}
                    className="flex-1 py-1.5 bg-green-600 hover:bg-green-700 text-white rounded-lg text-sm flex items-center justify-center gap-1"
                  >
                    <ThumbsUp className="w-4 h-4" /> 赞成
                  </button>
                  <button
                    onClick={() => handleVote(sub, 'reject')}
                    className="flex-1 py-1.5 bg-slate-500 hover:bg-slate-600 text-white rounded-lg text-sm flex items-center justify-center gap-1"
                  >
                    <ThumbsDown className="w-4 h-4" /> 反对
                  </button>
                </>
              )}

              {sub.status === 'approved' && (
                <button
                  onClick={() => handleMerge(sub)}
                  className="flex-1 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-sm flex items-center justify-center gap-1"
                >
                  <GitMerge className="w-4 h-4" /> 合并并发放报酬
                </button>
              )}

              {sub.status === 'rejected' && !sub.convertedToMod && (
                <button
                  onClick={() => handleConvert(sub)}
                  className="flex-1 py-1.5 bg-fuchsia-600 hover:bg-fuchsia-700 text-white rounded-lg text-sm flex items-center justify-center gap-1"
                >
                  <PackagePlus className="w-4 h-4" /> 转社区模组
                </button>
              )}

              {sub.status === 'merged' && (
                <Link
                  to={`/game/${quest.gameId}?ext=${encodeURIComponent(sub.id)}`}
                  className="flex-1 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-sm flex items-center justify-center gap-1"
                >
                  <ExternalLink className="w-4 h-4" /> 在游戏中查看扩展
                </Link>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
