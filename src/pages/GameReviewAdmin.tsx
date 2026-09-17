/**
 * GameReviewAdmin - 游戏审核后台（管理员专属）
 *
 * 独立于游戏发布流程的审核机制：
 * - 仅管理员账号可登录（后端 REVIEW_ADMIN_USER/REVIEW_ADMIN_PASS，默认 admin/admin123）
 * - 审核结果：通过（上架）/ 驳回 / 需修改，驳回与需修改必须填写原因
 * - 审核四项硬性条件：内容合规性 / 运行稳定性 / 基础信息完整性 / 交互与安全性
 * - 审核记录完整保留（审核时间、审核管理员、审核结果、原因、备注），可追溯
 * - 支持对已上架游戏复审（重新驳回/要求修改）与下架
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Link } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import {
  ShieldCheck, ShieldAlert, ShieldX, RefreshCw, LogOut, LogIn, Eye,
  CheckCircle2, XCircle, AlertTriangle, Clock, Package, User,
  FileText, History, Ban, EyeOff, Gamepad2, ArrowLeft, Wrench, Boxes,
  ExternalLink, Maximize2, ChevronUp, ChevronDown,
} from 'lucide-react';
import {
  adminLogin, logoutReviewAdmin, getReviewSession,
  fetchReviewQueue, fetchReviewRecords, submitReviewDecision, takedownGame,
  fetchGamePreview, openPreviewInNewTab,
  REVIEW_CHECKLIST_TEMPLATE, REVIEW_STATUS_META, REVIEW_ACTION_META,
  isGamePubliclyVisible,
  type ReviewQueueItem, type GameReviewRecord, type ReviewChecklistItem, type AutoCheckItem, type GameReviewStatus, type GamePreview,
} from '@/services/gameReviewService';
import { itemHarvestService } from '@/services/itemHarvestService';
import { voucherDB } from '@/voucher-system';
import type { Voucher } from '@/voucher-system/types';

// ==================== 工具 ====================

function formatTime(ts?: number | string): string {
  if (!ts) return '-';
  const d = typeof ts === 'number' ? new Date(ts) : new Date(ts);
  if (isNaN(d.getTime())) return '-';
  return d.toLocaleString('zh-CN', { hour12: false });
}

function formatSize(bytes?: number): string {
  if (!bytes) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

// ==================== 登录卡片 ====================

function LoginCard({ onLogin }: { onLogin: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password) {
      toast.error('请输入管理员账号和密码');
      return;
    }
    setLoading(true);
    const r = await adminLogin(username.trim(), password);
    setLoading(false);
    if (r.success) {
      toast.success(`欢迎回来，审核管理员 ${r.session.adminName}`);
      onLogin();
    } else {
      toast.error('登录失败', { description: r.error });
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-purple-950 to-slate-900 flex items-center justify-center px-4">
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-md"
      >
        <div className="text-center mb-8">
          <div className="w-16 h-16 mx-auto rounded-2xl bg-purple-600/20 border border-purple-500/30 flex items-center justify-center mb-4">
            <ShieldCheck className="w-8 h-8 text-purple-400" />
          </div>
          <h1 className="text-2xl font-bold text-white">游戏审核后台</h1>
          <p className="text-sm text-slate-400 mt-2">
            仅管理员账号可登录。审核流程独立于游戏发布流程，
            游戏提交后进入待审核状态，未通过审核前不会公开上架。
          </p>
        </div>

        <form onSubmit={handleSubmit} className="bg-slate-800/60 backdrop-blur border border-slate-700/50 rounded-2xl p-6 space-y-4">
          <div>
            <label className="block text-xs text-slate-400 mb-1.5">管理员账号</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="默认 admin"
              autoComplete="username"
              className="w-full px-3 py-2.5 bg-slate-900/70 border border-slate-700 rounded-lg text-sm text-white placeholder-slate-500 focus:outline-none focus:border-purple-500"
            />
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1.5">密码</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="默认 admin123（可用 REVIEW_ADMIN_PASS 环境变量覆盖）"
              autoComplete="current-password"
              className="w-full px-3 py-2.5 bg-slate-900/70 border border-slate-700 rounded-lg text-sm text-white placeholder-slate-500 focus:outline-none focus:border-purple-500"
            />
          </div>
          <button
            type="submit"
            disabled={loading}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-purple-600 hover:bg-purple-700 disabled:opacity-50 rounded-lg text-sm font-medium text-white transition-colors"
          >
            {loading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <LogIn className="w-4 h-4" />}
            {loading ? '登录中...' : '登录审核后台'}
          </button>
          <p className="text-[11px] text-slate-500 text-center">
            普通玩家账号无任何审核权限；管理员账号由后端环境变量
            <code className="mx-1 px-1 py-0.5 bg-slate-900/70 rounded text-purple-300">REVIEW_ADMIN_USER / REVIEW_ADMIN_PASS</code>
            配置
          </p>
        </form>

        <div className="text-center mt-6">
          <Link to="/" className="text-xs text-slate-500 hover:text-slate-300 inline-flex items-center gap-1">
            <ArrowLeft className="w-3 h-3" /> 返回平台首页
          </Link>
        </div>
      </motion.div>
    </div>
  );
}

// ==================== 统计卡片 ====================

function StatusStatCard({ status, count, active, onClick }: {
  status: GameReviewStatus; count: number; active: boolean; onClick: () => void;
}) {
  const meta = REVIEW_STATUS_META[status];
  const icons: Record<GameReviewStatus, React.ReactNode> = {
    pending: <Clock className="w-4 h-4 text-amber-400" />,
    approved: <CheckCircle2 className="w-4 h-4 text-green-400" />,
    rejected: <ShieldX className="w-4 h-4 text-red-400" />,
    changes_required: <Wrench className="w-4 h-4 text-blue-400" />,
    removed: <EyeOff className="w-4 h-4 text-slate-400" />,
  };
  return (
    <button
      onClick={onClick}
      className={`p-4 rounded-xl border text-left transition-all ${active
        ? 'border-purple-500/50 bg-purple-500/10'
        : `${meta.badge.split(' ')[1]} border-current opacity-60 hover:opacity-100`}`}
    >
      <div className="flex items-center gap-2 mb-1.5">
        {icons[status]}
        <span className="text-xs text-slate-400">{meta.label}</span>
      </div>
      <div className="text-2xl font-bold text-white">{count}</div>
    </button>
  );
}

// ==================== 审核面板（Modal） ====================

function ReviewPanel({ game, onClose, onDone }: {
  game: ReviewQueueItem;
  onClose: () => void;
  onDone: () => void;
}) {
  const [records, setRecords] = useState<GameReviewRecord[]>([]);
  const [recordsLoading, setRecordsLoading] = useState(true);
  const [checklist, setChecklist] = useState<ReviewChecklistItem[]>(
    REVIEW_CHECKLIST_TEMPLATE.map(t => ({ ...t, passed: false, note: '' }))
  );
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState<'' | 'approve' | 'reject' | 'changes_required' | 'takedown'>('');

  // ===== 待审游戏预览（试玩验证运行稳定性） =====
  const [previewOpen, setPreviewOpen] = useState(true);
  const [preview, setPreview] = useState<GamePreview>({ mode: 'none', note: '解析预览方式...' });
  const [previewKey, setPreviewKey] = useState(0); // 刷新计数，重建 iframe
  const previewFrameRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    let cancelled = false;
    setPreview({ mode: 'none', note: '解析预览方式...' });
    fetchGamePreview(game)
      .then(p => { if (!cancelled) setPreview(p); })
      .catch(() => { if (!cancelled) setPreview({ mode: 'none', note: '预览解析失败，请通过文件清单人工检查' }); });
    return () => { cancelled = true; };
  }, [game.id]);

  const loadRecords = useCallback(async () => {
    setRecordsLoading(true);
    try {
      setRecords(await fetchReviewRecords(game.id));
    } catch (e) {
      toast.error('拉取审核记录失败', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setRecordsLoading(false);
    }
  }, [game.id]);

  useEffect(() => { loadRecords(); }, [loadRecords]);

  // 自动预检结果（取最新一条 submit 记录；records 已按时间倒序，最新在前）
  const autoChecks: AutoCheckItem[] = useMemo(() => {
    const latestSubmit = records.find(r => r.action === 'submit');
    return latestSubmit?.autoChecks || [];
  }, [records]);

  const allPassed = checklist.every(c => c.passed);

  const toggleItem = (key: string, passed: boolean) => {
    setChecklist(prev => prev.map(c => (c.key === key ? { ...c, passed } : c)));
  };

  const setItemNote = (key: string, noteVal: string) => {
    setChecklist(prev => prev.map(c => (c.key === key ? { ...c, note: noteVal } : c)));
  };

  const doDecide = async (result: 'approve' | 'reject' | 'changes_required') => {
    if (result === 'approve' && !allPassed) {
      toast.error('无法通过：四项审核条件必须全部勾选通过', {
        description: '内容合规性 / 运行稳定性 / 基础信息完整性 / 交互与安全性 需逐项确认',
      });
      return;
    }
    if (result !== 'approve' && !reason.trim()) {
      toast.error(result === 'reject' ? '驳回必须填写原因（将反馈给发布者）' : '要求修改必须填写原因（将反馈给发布者）');
      return;
    }
    setSubmitting(result);
    const r = await submitReviewDecision({
      gameId: game.id, result,
      reason: reason.trim(),
      note: note.trim(),
      checklist,
    });
    setSubmitting('');
    if (r.ok) {
      toast.success(result === 'approve' ? '已通过审核，游戏上架' : result === 'reject' ? '已驳回' : '已标记为需修改');
      onDone();
    } else {
      toast.error('审核操作失败', { description: r.error });
    }
  };

  const doTakedown = async () => {
    if (!reason.trim()) {
      toast.error('下架必须填写原因（便于追溯）');
      return;
    }
    setSubmitting('takedown');
    const r = await takedownGame({ gameId: game.id, reason: reason.trim(), note: note.trim() });
    setSubmitting('');
    if (r.ok) {
      toast.success('游戏已下架');
      onDone();
    } else {
      toast.error('下架失败', { description: r.error });
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-start justify-center overflow-y-auto py-8 px-4"
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, y: 24, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 24, scale: 0.98 }}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-4xl bg-slate-900 border border-slate-700/60 rounded-2xl shadow-2xl"
      >
        {/* Header */}
        <div className="flex items-start gap-4 p-6 border-b border-slate-800">
          {game.coverImage ? (
            <img src={game.coverImage} alt="" className="w-20 h-20 rounded-xl object-cover border border-slate-700 flex-shrink-0" />
          ) : (
            <div className="w-20 h-20 rounded-xl bg-slate-800 border border-slate-700 flex items-center justify-center flex-shrink-0">
              <Gamepad2 className="w-8 h-8 text-slate-600" />
            </div>
          )}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-lg font-bold text-white truncate">{game.name}</h2>
              <span className={`px-2 py-0.5 rounded-full text-xs border ${REVIEW_STATUS_META[game.reviewStatus].badge}`}>
                {REVIEW_STATUS_META[game.reviewStatus].label}
              </span>
            </div>
            <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-400">
              <span className="inline-flex items-center gap-1"><User className="w-3 h-3" />{game.publisherName || game.publisherId || '未知发布者'}</span>
              <span className="inline-flex items-center gap-1"><Package className="w-3 h-3" />{game.fileCount ?? 0} 文件 · {formatSize(game.size)}</span>
              <span className="inline-flex items-center gap-1"><FileText className="w-3 h-3" />{game.framework || '未分类'}</span>
              <span className="inline-flex items-center gap-1"><Clock className="w-3 h-3" />提交: {formatTime(game.submittedAt)}</span>
              {game.reviewedAt ? <span className="inline-flex items-center gap-1"><History className="w-3 h-3" />最近审核: {formatTime(game.reviewedAt)}（{game.reviewedBy}）</span> : null}
            </div>
            {game.summary ? <p className="mt-2 text-xs text-slate-400 line-clamp-2">{game.summary}</p> : null}
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-white transition-colors">
            <XCircle className="w-5 h-5" />
          </button>
        </div>

        <div className="grid md:grid-cols-2 gap-6 p-6">
          {/* 左列：预览 + 自动预检 + 审核记录 */}
          <div className="space-y-5">
            {/* 游戏预览（试玩验证运行稳定性） */}
            <div>
              <div className="flex items-center justify-between mb-2.5">
                <h3 className="text-sm font-semibold text-slate-300 flex items-center gap-1.5">
                  <Eye className="w-4 h-4 text-cyan-400" />游戏预览（试玩验证运行稳定性）
                </h3>
                <div className="flex items-center gap-0.5">
                  <button
                    onClick={() => setPreviewKey(k => k + 1)}
                    title="重新加载预览"
                    className="p-1.5 hover:bg-slate-700 rounded text-slate-400 hover:text-white transition-colors"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                  </button>
                  {preview.mode !== 'none' ? (
                    <>
                      <button
                        onClick={() => openPreviewInNewTab(preview, game.name)}
                        title="在新窗口打开"
                        className="p-1.5 hover:bg-slate-700 rounded text-slate-400 hover:text-white transition-colors"
                      >
                        <ExternalLink className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => previewFrameRef.current?.requestFullscreen?.()}
                        title="全屏试玩"
                        className="p-1.5 hover:bg-slate-700 rounded text-slate-400 hover:text-white transition-colors"
                      >
                        <Maximize2 className="w-3.5 h-3.5" />
                      </button>
                    </>
                  ) : null}
                  <button
                    onClick={() => setPreviewOpen(o => !o)}
                    title={previewOpen ? '收起预览' : '展开预览'}
                    className="p-1.5 hover:bg-slate-700 rounded text-slate-400 hover:text-white transition-colors"
                  >
                    {previewOpen ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                  </button>
                </div>
              </div>
              {previewOpen ? (
                preview.mode === 'none' ? (
                  <p className="text-xs text-slate-500 bg-slate-800/50 rounded-lg p-3">{preview.note || '无法预览'}</p>
                ) : (
                  <div className="rounded-lg border border-slate-700 overflow-hidden bg-slate-950">
                    {preview.mode === 'html' ? (
                      <iframe
                        key={`html-${previewKey}`}
                        ref={previewFrameRef}
                        srcDoc={preview.html}
                        title={`预览 - ${game.name}`}
                        className="w-full h-[360px] border-0"
                        allow="fullscreen"
                        sandbox="allow-scripts allow-same-origin allow-popups allow-forms allow-downloads"
                      />
                    ) : (
                      <iframe
                        key={`url-${previewKey}`}
                        ref={previewFrameRef}
                        src={preview.url}
                        title={`预览 - ${game.name}`}
                        className="w-full h-[360px] border-0"
                        allow="fullscreen"
                        sandbox="allow-scripts allow-same-origin allow-popups allow-downloads"
                      />
                    )}
                    <div className="px-3 py-1.5 bg-slate-900/80 border-t border-slate-800 text-[11px] text-slate-500 flex items-center justify-between gap-2">
                      <span>
                        {game.hostingType === 'external'
                          ? '外部链接游戏'
                          : game.hostingType === 'server'
                            ? `文件托管 · 入口 ${game.entryPoint || 'index.html'}`
                            : '内联 HTML'}
                      </span>
                      <span>沙箱隔离运行，仅供审核</span>
                    </div>
                  </div>
                )
              ) : null}
            </div>

            {/* 自动预检 */}
            <div>
              <h3 className="text-sm font-semibold text-slate-300 mb-2.5 flex items-center gap-1.5">
                <ShieldAlert className="w-4 h-4 text-purple-400" />自动预检结果（提交时执行）
              </h3>
              {autoChecks.length === 0 ? (
                <p className="text-xs text-slate-500 bg-slate-800/50 rounded-lg p-3">无自动预检数据</p>
              ) : (
                <div className="space-y-2">
                  {autoChecks.map(c => (
                    <div key={c.key} className={`rounded-lg p-3 border text-xs ${c.passed
                      ? 'bg-green-500/5 border-green-500/20'
                      : c.severity === 'error' ? 'bg-red-500/10 border-red-500/30' : 'bg-amber-500/10 border-amber-500/30'}`}>
                      <div className="flex items-center gap-1.5 font-medium">
                        {c.passed
                          ? <CheckCircle2 className="w-3.5 h-3.5 text-green-400 flex-shrink-0" />
                          : <AlertTriangle className={`w-3.5 h-3.5 flex-shrink-0 ${c.severity === 'error' ? 'text-red-400' : 'text-amber-400'}`} />}
                        <span className="text-slate-200">{c.label}</span>
                        <span className={c.passed ? 'text-green-400 ml-auto' : (c.severity === 'error' ? 'text-red-400 ml-auto' : 'text-amber-400 ml-auto')}>
                          {c.passed ? '通过' : c.severity === 'error' ? '异常' : '待复核'}
                        </span>
                      </div>
                      {c.note ? <p className="mt-1.5 text-slate-400 whitespace-pre-wrap">{c.note}</p> : null}
                    </div>
                  ))}
                </div>
              )}
              <p className="text-[11px] text-slate-500 mt-2">
                自动预检仅供人工复核参考（特征扫描存在误报可能），最终结论以下方人工审核为准。
              </p>
            </div>

            {/* 审核记录 */}
            <div>
              <h3 className="text-sm font-semibold text-slate-300 mb-2.5 flex items-center gap-1.5">
                <History className="w-4 h-4 text-cyan-400" />审核记录（完整追溯）
              </h3>
              {recordsLoading ? (
                <div className="flex items-center gap-2 text-xs text-slate-500 py-4">
                  <RefreshCw className="w-3 h-3 animate-spin" />加载审核记录...
                </div>
              ) : records.length === 0 ? (
                <p className="text-xs text-slate-500 bg-slate-800/50 rounded-lg p-3">暂无审核记录</p>
              ) : (
                <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
                  {records.map(r => {
                    const meta = REVIEW_ACTION_META[r.action];
                    return (
                      <div key={r.id} className="bg-slate-800/50 rounded-lg p-3 border border-slate-700/40 text-xs">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className={`font-medium ${meta.color}`}>{meta.label}</span>
                          <span className="text-slate-500">{formatTime(r.createdAt)}</span>
                          <span className="text-slate-500 ml-auto">
                            {r.action === 'submit'
                              ? `提交人: ${r.submitterName || r.submitterId || '-'}`
                              : `管理员: ${r.adminName || r.adminId || '-'}`}
                          </span>
                        </div>
                        {r.reason ? <p className="mt-1.5 text-red-300/90">原因：{r.reason}</p> : null}
                        {r.note ? <p className="mt-1 text-slate-400">备注：{r.note}</p> : null}
                        {r.checklist?.length ? (
                          <div className="mt-1.5 flex flex-wrap gap-1.5">
                            {r.checklist.map(c => (
                              <span key={c.key} className={`px-1.5 py-0.5 rounded ${c.passed ? 'bg-green-500/10 text-green-400' : 'bg-red-500/10 text-red-400'}`}>
                                {c.label}{c.passed ? '✓' : '✗'}
                              </span>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* 右列：人工审核表单 */}
          <div className="space-y-4">
            <div>
              <h3 className="text-sm font-semibold text-slate-300 mb-1 flex items-center gap-1.5">
                <ShieldCheck className="w-4 h-4 text-purple-400" />人工审核条件（通过须四项全过）
              </h3>
              <div className="space-y-2 mt-2.5">
                {checklist.map(item => (
                  <div key={item.key} className={`rounded-lg border p-3 transition-colors ${item.passed ? 'bg-green-500/5 border-green-500/25' : 'bg-slate-800/50 border-slate-700/50'}`}>
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="text-xs font-medium text-slate-200">{item.label}</div>
                        <div className="text-[11px] text-slate-500 mt-0.5">{item.description}</div>
                      </div>
                      <div className="flex gap-1 flex-shrink-0">
                        <button
                          onClick={() => toggleItem(item.key, true)}
                          className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${item.passed ? 'bg-green-600 text-white' : 'bg-slate-700/60 text-slate-300 hover:bg-green-600/60'}`}
                        >通过</button>
                        <button
                          onClick={() => toggleItem(item.key, false)}
                          className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${!item.passed ? 'bg-red-600 text-white' : 'bg-slate-700/60 text-slate-300 hover:bg-red-600/60'}`}
                        >不通过</button>
                      </div>
                    </div>
                    <input
                      value={item.note || ''}
                      onChange={(e) => setItemNote(item.key, e.target.value)}
                      placeholder="该项备注（可选，如具体问题位置）"
                      className="mt-2 w-full px-2.5 py-1.5 bg-slate-900/70 border border-slate-700/60 rounded text-[11px] text-white placeholder-slate-600 focus:outline-none focus:border-purple-500/60"
                    />
                  </div>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <div>
                <label className="block text-xs text-slate-400 mb-1">
                  审核原因 <span className="text-red-400">*驳回 / 需修改 / 下架时必填</span>（将反馈给发布者）
                </label>
                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={2}
                  placeholder="例如：游戏第 3 关卡死无法继续；封面使用了侵权素材，请更换后重新提交"
                  className="w-full px-3 py-2 bg-slate-900/70 border border-slate-700 rounded-lg text-xs text-white placeholder-slate-600 focus:outline-none focus:border-purple-500"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1">备注（可选，仅内部留存）</label>
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  rows={2}
                  placeholder="内部备注信息"
                  className="w-full px-3 py-2 bg-slate-900/70 border border-slate-700 rounded-lg text-xs text-white placeholder-slate-600 focus:outline-none focus:border-purple-500"
                />
              </div>
            </div>

            {/* 操作按钮 */}
            <div className="flex flex-wrap gap-2 pt-1">
              <button
                onClick={() => doDecide('approve')}
                disabled={!!submitting}
                className="flex-1 min-w-[100px] flex items-center justify-center gap-1.5 px-4 py-2.5 bg-green-600 hover:bg-green-700 disabled:opacity-50 rounded-lg text-sm font-medium text-white transition-colors"
              >
                {submitting === 'approve' ? <RefreshCw className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                通过并上架
              </button>
              <button
                onClick={() => doDecide('changes_required')}
                disabled={!!submitting}
                className="flex-1 min-w-[100px] flex items-center justify-center gap-1.5 px-4 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded-lg text-sm font-medium text-white transition-colors"
              >
                {submitting === 'changes_required' ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Wrench className="w-4 h-4" />}
                需修改
              </button>
              <button
                onClick={() => doDecide('reject')}
                disabled={!!submitting}
                className="flex-1 min-w-[100px] flex items-center justify-center gap-1.5 px-4 py-2.5 bg-red-600 hover:bg-red-700 disabled:opacity-50 rounded-lg text-sm font-medium text-white transition-colors"
              >
                {submitting === 'reject' ? <RefreshCw className="w-4 h-4 animate-spin" /> : <ShieldX className="w-4 h-4" />}
                驳回
              </button>
              {/* 已上架游戏：下架（复审处置） */}
              {isGamePubliclyVisible(game.reviewStatus) ? (
                <button
                  onClick={doTakedown}
                  disabled={!!submitting}
                  className="w-full flex items-center justify-center gap-1.5 px-4 py-2.5 bg-slate-700 hover:bg-slate-600 disabled:opacity-50 rounded-lg text-sm font-medium text-slate-200 transition-colors"
                >
                  {submitting === 'takedown' ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Ban className="w-4 h-4" />}
                  下架该游戏（需填写原因）
                </button>
              ) : null}
            </div>
            <p className="text-[11px] text-slate-500">
              复审说明：已上架游戏可随时重新审核（驳回 / 要求修改 / 下架），每次操作均完整记录。
            </p>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}

// ==================== 主页面 ====================

type FilterStatus = '' | GameReviewStatus;

// ==================== P2a 高价值道具凭证审核 ====================

type ItemReviewStatus = 'pending' | 'approved' | 'rejected';

const ITEM_REVIEW_META: Record<ItemReviewStatus, { label: string; color: string }> = {
  pending: { label: '待审核', color: 'bg-amber-500/20 text-amber-300 border-amber-500/30' },
  approved: { label: '已通过', color: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30' },
  rejected: { label: '已驳回', color: 'bg-red-500/20 text-red-300 border-red-500/30' },
};

function PropReviewList() {
  const [vouchers, setVouchers] = useState<Voucher[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<ItemReviewStatus | ''>('pending');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejectTarget, setRejectTarget] = useState<Voucher | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  const loadItems = useCallback(async (silent = false) => {
    setLoading(true);
    try {
      // 先同步云端全部凭证：审核员浏览器本地未必有玩家提取的凭证数据
      await voucherDB.syncFromCloudBase();
      const list = itemHarvestService.getHighValueVouchers();
      setVouchers(list);
      if (!silent) toast.success(`已加载 ${list.length} 个高价值道具凭证`);
    } catch (e) {
      toast.error('拉取道具凭证失败', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadItems(); }, [loadItems]);

  const decide = (voucher: Voucher, approved: boolean, note: string) => {
    setBusyId(voucher.id);
    const r = itemHarvestService.decideItemReview(voucher.id, approved, note, getReviewSession()?.adminName || 'admin');
    setBusyId(null);
    if (r.success) {
      toast.success(r.message);
      setRejectTarget(null);
      setRejectReason('');
      const fresh = voucherDB.getVoucherById(voucher.id);
      setVouchers(prev => prev.map(v => (v.id === voucher.id && fresh ? fresh : v)));
    } else {
      toast.error(r.message);
    }
  };

  const statusOf = (v: Voucher): ItemReviewStatus => {
    const s = (v.metadata?.customData as any)?.reviewStatus;
    return s === 'approved' || s === 'rejected' ? s : 'pending';
  };

  const filtered = useMemo(
    () => (filter ? vouchers.filter(v => statusOf(v) === filter) : vouchers),
    [vouchers, filter],
  );

  const statusCounts = useMemo(() => {
    const counts: Record<ItemReviewStatus, number> = { pending: 0, approved: 0, rejected: 0 };
    for (const v of vouchers) counts[statusOf(v)]++;
    return counts;
  }, [vouchers]);

  return (
    <div className="space-y-4">
      {/* 说明 */}
      <div className="p-4 bg-amber-500/10 border border-amber-500/20 rounded-xl">
        <div className="flex items-start gap-3">
          <Boxes className="w-5 h-5 text-amber-400 mt-0.5 shrink-0" />
          <div className="text-sm">
            <p className="text-amber-200 font-medium">高价值道具凭证审核</p>
            <p className="text-slate-400 text-xs mt-1">
              游戏内提取的携带自定义代码（effectCode/effectScript）或高稀有度的道具，提取后处于「待审核」状态：
              审核通过前禁止上架市场与兑换进游戏；驳回则永久禁止。低风险道具不受影响。
            </p>
          </div>
        </div>
      </div>

      {/* 状态过滤 */}
      <div className="flex items-center gap-2 flex-wrap">
        {(['', 'pending', 'approved', 'rejected'] as const).map(s => (
          <button
            key={s || 'all'}
            onClick={() => setFilter(s as ItemReviewStatus | '')}
            className={`px-3 py-1.5 rounded-lg text-xs transition-colors border ${
              filter === (s as ItemReviewStatus | '')
                ? 'bg-purple-600 text-white border-purple-500'
                : 'bg-slate-800 text-slate-300 border-slate-700 hover:bg-slate-700'
            }`}
          >
            {s ? `${ITEM_REVIEW_META[s as ItemReviewStatus].label}（${statusCounts[s as ItemReviewStatus]}）` : `全部（${vouchers.length}）`}
          </button>
        ))}
        <button
          onClick={() => loadItems()}
          disabled={loading}
          className="ml-auto flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 rounded-lg text-xs text-slate-200 transition-colors"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />刷新
        </button>
      </div>

      {/* 列表 */}
      {loading && vouchers.length === 0 ? (
        <div className="flex items-center justify-center gap-2 py-16 text-sm text-slate-500">
          <RefreshCw className="w-4 h-4 animate-spin" />加载道具凭证...
        </div>
      ) : filtered.length === 0 ? (
        <div className="py-16 text-center">
          <Package className="w-10 h-10 text-slate-700 mx-auto mb-3" />
          <p className="text-sm text-slate-500">暂无{filter ? ITEM_REVIEW_META[filter as ItemReviewStatus].label : ''}的高价值道具凭证</p>
          <p className="text-xs text-slate-600 mt-1">玩家在游戏中提取高价值道具后会出现在这里</p>
        </div>
      ) : (
        <AnimatePresence>
          {filtered.map(v => {
            const cd = (v.metadata?.customData || {}) as Record<string, any>;
            const st = statusOf(v);
            const gameEffect = cd.gameEffect || {};
            const itemData = gameEffect.itemData || {};
            return (
              <motion.div
                key={v.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                className="p-4 bg-slate-800/50 border border-slate-700/50 rounded-xl"
              >
                <div className="flex items-start justify-between gap-4 flex-wrap">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-white">{v.metadata?.name || '未知道具'}</span>
                      <span className={`text-xs px-2 py-0.5 rounded border ${ITEM_REVIEW_META[st].color}`}>
                        {ITEM_REVIEW_META[st].label}
                      </span>
                      {typeof itemData.effectCode === 'string' && itemData.effectCode.trim() ? (
                        <span className="text-xs px-2 py-0.5 rounded bg-orange-500/20 text-orange-300">含自定义代码</span>
                      ) : null}
                    </div>
                    <div className="text-xs text-slate-400 mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
                      <span>Schema: {gameEffect.schemaName || cd.schemaName || '-'}</span>
                      <span>来源游戏: {cd.gameId || '-'}</span>
                      <span>持有者: {v.currentHolderId || '-'}</span>
                      <span>提取时间: {formatTime(cd.harvestedAt)}</span>
                      {itemData.effect ? <span>效果: {String(itemData.effect)}</span> : null}
                    </div>
                    {st !== 'pending' && cd.reviewNote ? (
                      <p className="text-xs text-slate-500 mt-1">审核备注: {cd.reviewNote}（{cd.reviewedBy} · {formatTime(cd.reviewedAt)}）</p>
                    ) : null}
                  </div>
                  {st === 'pending' && (
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        onClick={() => decide(v, true, '')}
                        disabled={busyId === v.id}
                        className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 rounded-lg text-xs text-white transition-colors"
                      >
                        <CheckCircle2 className="w-3.5 h-3.5" />通过
                      </button>
                      <button
                        onClick={() => { setRejectTarget(v); setRejectReason(''); }}
                        disabled={busyId === v.id}
                        className="flex items-center gap-1.5 px-3 py-1.5 bg-red-600/80 hover:bg-red-600 disabled:opacity-50 rounded-lg text-xs text-white transition-colors"
                      >
                        <XCircle className="w-3.5 h-3.5" />驳回
                      </button>
                    </div>
                  )}
                </div>

                {/* effectCode 预览（前 300 字符，供安全审查） */}
                {typeof itemData.effectCode === 'string' && itemData.effectCode.trim() ? (
                  <details className="mt-3">
                    <summary className="text-xs text-slate-400 cursor-pointer hover:text-slate-300">查看自定义代码</summary>
                    <pre className="mt-2 p-3 bg-slate-900 border border-slate-700 rounded-lg text-xs text-slate-300 overflow-x-auto max-h-48 whitespace-pre-wrap break-all">
                      {String(itemData.effectCode).slice(0, 3000)}
                    </pre>
                  </details>
                ) : null}
              </motion.div>
            );
          })}
        </AnimatePresence>
      )}

      {/* 驳回理由弹窗 */}
      <AnimatePresence>
        {rejectTarget && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center px-4"
            onClick={() => setRejectTarget(null)}
          >
            <motion.div
              initial={{ scale: 0.95, y: 12 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.95, y: 12 }}
              className="w-full max-w-md bg-slate-800 border border-slate-700 rounded-2xl p-6"
              onClick={e => e.stopPropagation()}
            >
              <h3 className="text-lg font-bold text-white mb-2">驳回道具凭证</h3>
              <p className="text-sm text-slate-400 mb-4">
                「{rejectTarget.metadata?.name}」将被永久禁止上架市场与兑换进游戏（必须填写原因）
              </p>
              <textarea
                value={rejectReason}
                onChange={e => setRejectReason(e.target.value)}
                placeholder="填写驳回原因（如：自定义代码存在越权风险）"
                rows={3}
                className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-purple-500 resize-none"
              />
              <div className="flex justify-end gap-2 mt-4">
                <button
                  onClick={() => setRejectTarget(null)}
                  className="px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded-lg text-sm text-slate-200"
                >
                  取消
                </button>
                <button
                  onClick={() => {
                    if (!rejectReason.trim()) {
                      toast.error('请填写驳回原因');
                      return;
                    }
                    decide(rejectTarget, false, rejectReason.trim());
                  }}
                  disabled={busyId === rejectTarget.id}
                  className="px-4 py-2 bg-red-600 hover:bg-red-700 disabled:opacity-50 rounded-lg text-sm text-white"
                >
                  确认驳回
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default function GameReviewAdmin() {
  const [session, setSession] = useState(() => getReviewSession());
  const [games, setGames] = useState<ReviewQueueItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<FilterStatus>('');
  const [selected, setSelected] = useState<ReviewQueueItem | null>(null);
  // P2a 顶层 tab：游戏审核 / 高价值道具审核
  const [mainTab, setMainTab] = useState<'games' | 'items'>('games');

  const loadQueue = useCallback(async (silent = false) => {
    setLoading(true);
    try {
      const list = await fetchReviewQueue();
      setGames(list);
      if (!silent) toast.success(`已加载 ${list.length} 个游戏`);
    } catch (e) {
      toast.error('拉取审核队列失败', { description: e instanceof Error ? e.message : String(e) });
      // 会话可能已过期（reviewFetch 内部 401 时会清 sessionStorage），同步 React 状态回到登录页
      setSession(getReviewSession());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (session) loadQueue(true);
  }, [session, loadQueue]);

  const statusCounts = useMemo(() => {
    const counts: Record<GameReviewStatus, number> = {
      pending: 0, approved: 0, rejected: 0, changes_required: 0, removed: 0,
    };
    for (const g of games) counts[g.reviewStatus] = (counts[g.reviewStatus] || 0) + 1;
    return counts;
  }, [games]);

  const filtered = useMemo(
    () => (filter ? games.filter(g => g.reviewStatus === filter) : games),
    [games, filter]
  );

  if (!session) {
    return <LoginCard onLogin={() => setSession(getReviewSession())} />;
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-purple-950 to-slate-900 pb-16">
      {/* Header */}
      <div className="border-b border-slate-800/80 bg-slate-900/60 backdrop-blur sticky top-0 z-40">
        <div className="max-w-6xl mx-auto px-4 py-4 flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-purple-600/20 border border-purple-500/30 flex items-center justify-center">
            <ShieldCheck className="w-5 h-5 text-purple-400" />
          </div>
          <div className="flex-1 min-w-0">
            <h1 className="text-lg font-bold text-white">游戏审核后台</h1>
            <p className="text-xs text-slate-400">管理员 {session.adminName} · 审核流程独立于发布流程，未过审游戏不公开上架</p>
          </div>
          {/* P2a 顶层 tab 切换 */}
          <div className="flex items-center bg-slate-800 rounded-lg p-0.5 text-xs">
            <button
              onClick={() => setMainTab('games')}
              className={`px-3 py-1.5 rounded-md font-medium transition-colors flex items-center gap-1.5 ${
                mainTab === 'games' ? 'bg-purple-600 text-white' : 'text-slate-300 hover:text-white'
              }`}
            >
              <Gamepad2 className="w-3.5 h-3.5" />游戏审核
            </button>
            <button
              onClick={() => setMainTab('items')}
              className={`px-3 py-1.5 rounded-md font-medium transition-colors flex items-center gap-1.5 ${
                mainTab === 'items' ? 'bg-amber-600 text-white' : 'text-slate-300 hover:text-white'
              }`}
            >
              <Boxes className="w-3.5 h-3.5" />道具审核
            </button>
          </div>
          <button
            onClick={() => loadQueue()}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-2 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 rounded-lg text-xs text-slate-200 transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />刷新
          </button>
          <button
            onClick={() => { logoutReviewAdmin(); setSession(null); setGames([]); }}
            className="flex items-center gap-1.5 px-3 py-2 bg-slate-800 hover:bg-red-600/80 rounded-lg text-xs text-slate-200 transition-colors"
          >
            <LogOut className="w-3.5 h-3.5" />退出
          </button>
          <Link to="/" className="hidden sm:flex items-center gap-1.5 px-3 py-2 bg-slate-800 hover:bg-slate-700 rounded-lg text-xs text-slate-200 transition-colors">
            <ArrowLeft className="w-3.5 h-3.5" />返回首页
          </Link>
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-4 py-6 space-y-6">
        {mainTab === 'games' ? (
          <>
        {/* 状态统计卡片（点击过滤） */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          {(Object.keys(REVIEW_STATUS_META) as GameReviewStatus[]).map(s => (
            <StatusStatCard
              key={s}
              status={s}
              count={statusCounts[s]}
              active={filter === s}
              onClick={() => setFilter(filter === s ? '' : s)}
            />
          ))}
        </div>

        {/* 游戏列表 */}
        <div className="space-y-2.5">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-300">
              审核队列 {filter ? `· ${REVIEW_STATUS_META[filter].label}` : '· 全部'}（{filtered.length}）
            </h2>
            {filter ? (
              <button onClick={() => setFilter('')} className="text-xs text-purple-400 hover:text-purple-300">
                清除过滤
              </button>
            ) : null}
          </div>

          {loading && games.length === 0 ? (
            <div className="flex items-center justify-center gap-2 py-16 text-sm text-slate-500">
              <RefreshCw className="w-4 h-4 animate-spin" />加载审核队列...
            </div>
          ) : filtered.length === 0 ? (
            <div className="py-16 text-center">
              <Package className="w-10 h-10 text-slate-700 mx-auto mb-3" />
              <p className="text-sm text-slate-500">暂无{filter ? REVIEW_STATUS_META[filter].label : ''}游戏</p>
              <p className="text-xs text-slate-600 mt-1">游戏在发布中心提交后会自动进入待审核队列</p>
            </div>
          ) : (
            <AnimatePresence>
              {filtered.map(game => (
                <motion.div
                  key={game.id}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  className="flex items-center gap-4 p-4 bg-slate-800/50 border border-slate-700/50 rounded-xl hover:border-purple-500/40 transition-colors"
                >
                  {game.coverImage ? (
                    <img src={game.coverImage} alt="" className="w-14 h-14 rounded-lg object-cover border border-slate-700 flex-shrink-0" />
                  ) : (
                    <div className="w-14 h-14 rounded-lg bg-slate-800 border border-slate-700 flex items-center justify-center flex-shrink-0">
                      <Gamepad2 className="w-6 h-6 text-slate-600" />
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-white truncate">{game.name}</span>
                      <span className={`px-2 py-0.5 rounded-full text-[11px] border ${REVIEW_STATUS_META[game.reviewStatus].badge}`}>
                        {REVIEW_STATUS_META[game.reviewStatus].label}
                      </span>
                      {game.autoCheckWarningCount > 0 ? (
                        <span className="px-2 py-0.5 rounded-full text-[11px] bg-amber-500/15 text-amber-400 border border-amber-500/30 inline-flex items-center gap-1">
                          <AlertTriangle className="w-3 h-3" />预检警告 {game.autoCheckWarningCount}
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-slate-500">
                      <span>{game.publisherName || game.publisherId || '未知发布者'}</span>
                      <span>{game.framework || '未分类'}</span>
                      <span>提交: {formatTime(game.submittedAt)}</span>
                      {game.reviewedAt ? <span>最近审核: {formatTime(game.reviewedAt)}</span> : null}
                      <span>{game.recordCount} 条记录</span>
                    </div>
                  </div>
                  <button
                    onClick={() => setSelected(game)}
                    className="flex items-center gap-1.5 px-3.5 py-2 bg-purple-600 hover:bg-purple-700 rounded-lg text-xs font-medium text-white transition-colors flex-shrink-0"
                  >
                    <Eye className="w-3.5 h-3.5" />{game.reviewStatus === 'pending' ? '审核' : '查看 / 复审'}
                  </button>
                </motion.div>
              ))}
            </AnimatePresence>
          )}
        </div>

        {/* 审核标准说明 */}
        <div className="p-4 bg-slate-800/40 border border-slate-700/40 rounded-xl">
          <h3 className="text-xs font-semibold text-slate-300 mb-2 flex items-center gap-1.5">
            <ShieldAlert className="w-3.5 h-3.5 text-purple-400" />游戏上架审核标准
          </h3>
          <div className="grid sm:grid-cols-2 gap-2 text-[11px] text-slate-400">
            {REVIEW_CHECKLIST_TEMPLATE.map((t, i) => (
              <div key={t.key} className="flex gap-2">
                <span className="text-purple-400 font-medium flex-shrink-0">{i + 1}. {t.label}</span>
                <span className="text-slate-500">{t.description}</span>
              </div>
            ))}
          </div>
          <p className="text-[11px] text-slate-500 mt-2.5">
            审核结果分为「通过（自动上架）/ 驳回 / 需修改」；驳回与需修改必须填写原因。提交时系统自动执行预检
            （信息完整性、文件健康度、恶意代码特征扫描），结果仅供人工复核参考。所有审核记录（时间、管理员、结果、原因、备注）完整保留、可追溯。
          </p>
        </div>
          </>
        ) : (
          <PropReviewList />
        )}
      </div>

      {/* 审核面板 */}
      <AnimatePresence>
        {selected ? (
          <ReviewPanel
            game={selected}
            onClose={() => setSelected(null)}
            onDone={async () => {
              setSelected(null);
              await loadQueue(true);
            }}
          />
        ) : null}
      </AnimatePresence>
    </div>
  );
}
