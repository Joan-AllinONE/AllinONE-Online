/**
 * QuestDetailModal - 任务详情弹窗
 *
 * P1 扩展：审核方式展示、依赖链展示、内容包沙盒预览。
 */

import { useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  X,
  Cpu,
  Coins,
  ShieldCheck,
  Send,
  ClipboardList,
  GitBranch,
  Vote,
  Eye,
  EyeOff,
  Upload,
  FolderOpen,
  Trash2,
  FileCode,
  FileImage,
  Archive,
  Loader2,
  BookOpen,
  Download,
  Power,
} from 'lucide-react';
import JSZip from 'jszip';
import type { GameQuest } from '@/types/quest';
import { getQuestSlotSchema, validateQuestContent, QUEST_BINARY_PREFIX, questContentSize } from '@/types/quest';
import { questService } from '@/services/questService';
import { getCurrentUserId } from '@/services/authTokenService';
import QuestReviewPanel from './QuestReviewPanel';

interface Props {
  quest: GameQuest;
  onClose: () => void;
  onChanged: () => void;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 上传中的资源文件草稿 */
interface FileDraft {
  path: string;
  content: string; // 文本原文 或 __BINARY_BASE64__ + base64
  size: number;
  binary: boolean;
}

/** 判定为二进制的扩展名（图片/音频/视频/字体/压缩包/二进制数据） */
const BINARY_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|ico|avif|mp3|wav|ogg|oga|m4a|flac|mp4|webm|mov|mkv|avi|woff2?|ttf|otf|eot|zip|gz|tar|7z|rar|pdf|wasm|bin|dat|exe|dll)$/i;

/** Uint8Array → base64（分块，避免超大数组调用栈溢出） */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
  }
  return btoa(binary);
}

/** ArrayBuffer → FileDraft（二进制 base64 / 文本 utf-8 解码） */
function bufferToDraft(path: string, buffer: ArrayBuffer): FileDraft {
  if (BINARY_EXT_RE.test(path)) {
    return { path, content: QUEST_BINARY_PREFIX + bytesToBase64(new Uint8Array(buffer)), size: buffer.byteLength, binary: true };
  }
  const text = new TextDecoder('utf-8').decode(new Uint8Array(buffer));
  return { path, content: text, size: questContentSize(text), binary: false };
}

/** 自动识别入口页：优先 index.html，其次任一 .html（顶层） */
function detectEntryPoint(files: FileDraft[]): string {
  const htmls = files.filter((f) => /\.html?$/i.test(f.path));
  if (!htmls.length) return '';
  return htmls.find((f) => /index\.html$/i.test(f.path))?.path || htmls.find((f) => !f.path.includes('/'))?.path || htmls[0].path;
}

/** 格式化字节大小 */
function formatSize(n: number): string {
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  if (n >= 1024) return Math.round(n / 1024) + ' KB';
  return n + ' B';
}

export default function QuestDetailModal({ quest, onClose, onChanged }: Props) {
  const [tab, setTab] = useState<'detail' | 'review'>('detail');
  const [claimMsg, setClaimMsg] = useState<string>('');
  const [claiming, setClaiming] = useState(false);
  const [dataText, setDataText] = useState('{\n  \n}');
  const [entryPoint, setEntryPoint] = useState('');
  const [fragmentMode, setFragmentMode] = useState(false); // 方案 C：entryPoint 是 HTML 片段（平台自动包壳）
  const [injectMode, setInjectMode] = useState(false); // 方案 E：脚本注入宿主游戏页面（无需游戏内置加载器）
  const [assetsText, setAssetsText] = useState('');
  const [desc, setDesc] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitMsg, setSubmitMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [showGuide, setShowGuide] = useState(false); // 任务开发说明预览
  const [fileDrafts, setFileDrafts] = useState<FileDraft[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const [importing, setImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const zipInputRef = useRef<HTMLInputElement>(null);

  // 关闭/删除任务（仅创建者可用）
  const [adminBusy, setAdminBusy] = useState(false);
  const [adminMsg, setAdminMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const isOwner = !!quest.createdBy && quest.createdBy === getCurrentUserId();

  const maxFileSize = quest.acceptance?.maxFileSize || 512 * 1024;

  /** 关闭任务（创建者专属；成功后刷新并保留弹窗） */
  const handleCloseQuest = async () => {
    setAdminBusy(true);
    setAdminMsg(null);
    const r = await questService.closeQuest(quest.id);
    setAdminBusy(false);
    setAdminMsg(r.success ? { ok: true, text: r.message } : { ok: false, text: r.message });
    if (r.success) onChanged();
  };

  /** 删除任务（创建者专属；确认后删除并关闭弹窗） */
  const handleDeleteQuest = async () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setAdminBusy(true);
    setAdminMsg(null);
    const r = await questService.deleteQuest(quest.id);
    setAdminBusy(false);
    if (r.success) {
      onChanged();
      onClose();
    } else {
      setAdminMsg({ ok: false, text: r.message });
    }
  };

  /** 从 File 列表导入（含 ZIP 解压），返回新增草稿 */
  const importFiles = async (fileList: FileList | File[]): Promise<FileDraft[]> => {
    const drafts: FileDraft[] = [];
    for (const file of Array.from(fileList)) {
      if (/\.zip$/i.test(file.name)) {
        // ZIP 包：解压后按目录结构导入（复用 jszip）
        const zip = await JSZip.loadAsync(file);
        const entries = Object.values(zip.files);
        for (const entry of entries) {
          if (entry.dir) continue;
          const rawPath = entry.name.replace(/^\/+/, '');
          if (!rawPath || rawPath.startsWith('__MACOSX') || rawPath.startsWith('.')) continue;
          const buf = await entry.async('arraybuffer');
          drafts.push(bufferToDraft(rawPath, buf));
        }
      } else {
        // 普通文件：优先用 webkitRelativePath（文件夹拖入时保留目录结构）
        const rel = (file as any).webkitRelativePath || file.name;
        drafts.push(bufferToDraft(rel.replace(/^\/+/, ''), await file.arrayBuffer()));
      }
    }
    return drafts;
  };

  const handleFilesSelected = async (fileList: FileList | File[]) => {
    setImporting(true);
    try {
      const drafts = await importFiles(fileList);
      setFileDrafts((prev) => {
        const map = new Map(prev.map((d) => [d.path, d]));
        for (const d of drafts) map.set(d.path, d);
        return Array.from(map.values());
      });
      // 自动识别 entryPoint
      setEntryPoint((prev) => prev || detectEntryPoint(drafts));
    } catch (e) {
      setSubmitMsg({ ok: false, text: '文件导入失败: ' + (e instanceof Error ? e.message : String(e)) });
    } finally {
      setImporting(false);
      // 清空 input 以便重复选择同一文件
      if (fileInputRef.current) fileInputRef.current.value = '';
      if (folderInputRef.current) folderInputRef.current.value = '';
      if (zipInputRef.current) zipInputRef.current.value = '';
    }
  };

  const reward = quest.reward || {};
  const reviewMode: 'developer' | 'community' = quest.reviewMode || 'developer';
  const dependencies = quest.dependencies || [];

  const previewSrcDoc = `<!DOCTYPE html><html><head><style>body{font-family:monospace;padding:16px;background:#0f172a;color:#e2e8f0;white-space:pre-wrap;word-break:break-all;}</style></head><body>${escapeHtml(
    dataText
  )}</body></html>`;

  const handleClaim = async () => {
    setClaiming(true);
    setClaimMsg('');
    const r = await questService.claimQuest(quest.id);
    setClaimMsg(r.message);
    setClaiming(false);
    onChanged();
  };

  /** 下载任务开发说明为 .md 文件 */
  const downloadGuide = () => {
    const name = quest.devGuideName || '任务开发说明.md';
    const blob = new Blob([quest.devGuide || ''], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleSubmit = async () => {
    setSubmitting(true);
    setSubmitMsg(null);
    let data: unknown;
    try {
      data = JSON.parse(dataText || '{}');
    } catch {
      setSubmitMsg({ ok: false, text: 'data 不是合法的 JSON，请检查后重试' });
      setSubmitting(false);
      return;
    }
    // 合并 assets：上传文件 + 手写 JSON（同 path 时手写覆盖，便于用户覆盖某个文件）
    const assetMap = new Map<string, { path: string; content: string }>();
    for (const d of fileDrafts) assetMap.set(d.path, { path: d.path, content: d.content });
    if (assetsText.trim()) {
      try {
        const parsed = JSON.parse(assetsText);
        if (!Array.isArray(parsed)) throw new Error('assets 必须是数组');
        for (const a of parsed) {
          const path = String((a && a.path) || '').replace(/^\/+/, '');
          const content = typeof (a && a.content) === 'string' ? a.content : '';
          if (path && content) assetMap.set(path, { path, content });
        }
      } catch {
        setSubmitMsg({ ok: false, text: 'assets 不是合法的 JSON 数组，请检查后重试' });
        setSubmitting(false);
        return;
      }
    }
    const assets = Array.from(assetMap.values());
    // 前端预检：单文件大小（二进制按解码后实际大小计算）
    const oversize = assets.filter((a) => questContentSize(a.content) > maxFileSize);
    if (oversize.length) {
      setSubmitMsg({
        ok: false,
        text: `文件超过大小上限(${formatSize(maxFileSize)})：${oversize.map((a) => `${a.path}(${formatSize(questContentSize(a.content))})`).join('、')}`,
      });
      setSubmitting(false);
      return;
    }
    // P2 前端预校验：按 slot 注册表检查 data 形状 / 必填字段 / 允许文件类型。
    // 传入 entryPoint：有独立入口时走独立入口模式（data 可空、资产放宽到 web 资源）。
    // 方案 E：injectMode 时校验脚本来源（.js 资产或 data.code）。
    const slotIssues = validateQuestContent(quest.contentSlot, {
      data,
      assets,
      entryPoint: entryPoint || undefined,
      inject: injectMode ? true : undefined,
    });
    if (slotIssues.length) {
      setSubmitMsg({ ok: false, text: '内容未通过 slot 校验：' + slotIssues.join('；') });
      setSubmitting(false);
      return;
    }
    const r = await questService.submitQuest(
      quest.id,
      {
        schemaVersion: '1.0',
        slot: quest.contentSlot,
        data,
        assets,
        entryPoint: entryPoint || undefined,
        fragment: fragmentMode ? true : undefined,
        inject: injectMode ? true : undefined,
      },
      desc,
    );
    // 服务端即使 auto-failed 也返回 success:true（记录会保留供人工审核），
    // 这里根据 status 精确提示，避免用户误以为「提交成功」。
    if (r.data?.status === 'auto-failed') {
      const issues = Array.isArray(r.data.autoCheck?.issues) ? r.data.autoCheck.issues : [];
      setSubmitMsg({
        ok: false,
        text: '提交已接收，但未通过自动校验（可重新提交修正）：' + (issues.join('；') || '未知原因'),
      });
    } else {
      setSubmitMsg({ ok: r.success, text: r.message });
    }
    setSubmitting(false);
    if (r.success) onChanged();
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
          className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col"
          initial={{ scale: 0.95, y: 20 }}
          animate={{ scale: 1, y: 0 }}
          exit={{ scale: 0.95, y: 20 }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-start justify-between p-6 border-b border-slate-200 dark:border-slate-700">
            <div>
              <h2 className="text-xl font-bold text-slate-900 dark:text-white">{quest.title}</h2>
              <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">{quest.description}</p>
              <div className="flex items-center gap-3 mt-2 text-xs text-slate-500">
                <span className="flex items-center gap-1">
                  <Vote className="w-3.5 h-3.5" />
                  {reviewMode === 'community' ? '社区投票审核' : '开发者直审'}
                </span>
                {dependencies.length > 0 && (
                  <span className="flex items-center gap-1 text-amber-600">
                    <GitBranch className="w-3.5 h-3.5" />
                    依赖 {dependencies.length} 个前置任务
                  </span>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {/* 创建者专属：关闭/删除任务 */}
              {isOwner && (
                <>
                  <button
                    onClick={handleCloseQuest}
                    disabled={adminBusy || quest.status === 'closed' || quest.status === 'merged'}
                    title={quest.status === 'closed' || quest.status === 'merged' ? '该任务已结束，无需关闭' : '关闭任务（退回托管，任务将停止接单）'}
                    className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium border border-amber-300 text-amber-700 hover:bg-amber-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors dark:border-amber-700/50 dark:text-amber-400 dark:hover:bg-amber-950/40"
                  >
                    <Power className="w-3.5 h-3.5" />
                    关闭
                  </button>
                  <button
                    onClick={handleDeleteQuest}
                    disabled={adminBusy || quest.status !== 'closed'}
                    title={quest.status === 'closed' ? (confirmDelete ? '再次点击确认删除（不可恢复）' : '删除任务（不可恢复）') : '仅已关闭的任务可删除（先关闭再删除）'}
                    className={`flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium border transition-colors ${
                      confirmDelete
                        ? 'border-red-500 bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-400'
                        : 'border-red-300 text-red-600 hover:bg-red-50 disabled:opacity-40 disabled:cursor-not-allowed dark:border-red-700/50 dark:text-red-400 dark:hover:bg-red-950/40'
                    }`}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    {confirmDelete ? '确认删除?' : '删除'}
                  </button>
                </>
              )}
              <button onClick={onClose} className="p-1.5 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors">
                <X className="w-5 h-5 text-slate-400" />
              </button>
            </div>
            {adminMsg && (
              <p className={`px-6 pb-3 -mt-1 text-xs ${adminMsg.ok ? 'text-green-600' : 'text-red-500'}`}>{adminMsg.text}</p>
            )}
          </div>

          {/* Tabs */}
          <div className="flex border-b border-slate-200 dark:border-slate-700">
            <button
              onClick={() => setTab('detail')}
              className={`flex-1 py-3 text-sm font-medium flex items-center justify-center gap-2 ${
                tab === 'detail'
                  ? 'text-indigo-600 border-b-2 border-indigo-600'
                  : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              <ClipboardList className="w-4 h-4" />
              领取与提交
            </button>
            <button
              onClick={() => setTab('review')}
              className={`flex-1 py-3 text-sm font-medium flex items-center justify-center gap-2 ${
                tab === 'review'
                  ? 'text-indigo-600 border-b-2 border-indigo-600'
                  : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              <ShieldCheck className="w-4 h-4" />
              评审与合并
            </button>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto p-6">
            {tab === 'detail' ? (
              <div className="space-y-5">
                {/* 报酬 */}
                <div className="p-4 rounded-xl bg-gradient-to-r from-indigo-50 to-violet-50 dark:from-indigo-950/40 dark:to-violet-950/40">
                  <div className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-3">任务报酬</div>
                  <div className="flex items-center gap-5 text-sm">
                    {reward.gameCoins ? (
                      <span className="flex items-center gap-1.5 text-slate-700 dark:text-slate-200">
                        <Coins className="w-5 h-5 text-yellow-500" /> 游戏币 ×{reward.gameCoins}
                      </span>
                    ) : null}
                    {reward.aCoins ? (
                      <span className="flex items-center gap-1.5 text-slate-700 dark:text-slate-200">
                        <Cpu className="w-5 h-5 text-violet-500" /> A币 ×{reward.aCoins}
                      </span>
                    ) : null}
                  </div>
                </div>

                {/* 依赖链 */}
                {dependencies.length > 0 && (
                  <div>
                    <div className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-2 flex items-center gap-1.5">
                      <GitBranch className="w-4 h-4" /> 依赖的前置任务
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {dependencies.map((d) => (
                        <span
                          key={d}
                          className="px-2 py-1 rounded-lg text-xs bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 font-mono"
                        >
                          {d}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {/* 验收标准 */}
                <div>
                  <div className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-2">验收标准</div>
                  <p className="text-sm text-slate-600 dark:text-slate-300 whitespace-pre-wrap">
                    {quest.acceptance?.description || '无额外说明'}
                  </p>
                </div>

                {/* 任务开发说明（游戏方上传，玩家查看/下载） */}
                {quest.devGuide && (
                  <div>
                    <div className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-2 flex items-center gap-1.5">
                      <BookOpen className="w-4 h-4" /> 任务开发说明
                    </div>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mb-2">
                      游戏方提供的开发说明（只公开接口、不暴露源码）。可先查看再决定是否领取，完成任务时按此说明操作。
                    </p>
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setShowGuide(true)}
                        className="px-4 py-2 rounded-lg bg-indigo-50 dark:bg-indigo-950/50 text-indigo-600 dark:text-indigo-400 text-xs font-medium hover:bg-indigo-100 dark:hover:bg-indigo-900/50 transition-colors flex items-center gap-1.5"
                      >
                        <Eye className="w-3.5 h-3.5" /> 查看说明
                      </button>
                      <button
                        type="button"
                        onClick={downloadGuide}
                        className="px-4 py-2 rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 text-xs font-medium hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors flex items-center gap-1.5"
                      >
                        <Download className="w-3.5 h-3.5" /> 下载
                      </button>
                      <span className="text-xs text-slate-400 truncate max-w-[240px] font-mono">
                        {quest.devGuideName || '任务开发说明.md'}
                      </span>
                    </div>
                  </div>
                )}

                {/* 领取 */}
                <div className="flex items-center gap-3">
                  <button
                    onClick={handleClaim}
                    disabled={claiming || quest.status !== 'open'}
                    className="px-5 py-2.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg font-medium transition-colors"
                  >
                    {claiming ? '领取中...' : '领取任务'}
                  </button>
                  {claimMsg && <span className="text-sm text-slate-500">{claimMsg}</span>}
                </div>

                {/* 提交 */}
                <div className="border-t border-slate-200 dark:border-slate-700 pt-5 space-y-3">
                  <div className="text-sm font-semibold text-slate-700 dark:text-slate-200">提交产物（内容包）</div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">挂载点 slot（固定为任务声明的 contentSlot）</label>
                    <input
                      value={quest.contentSlot}
                      readOnly
                      className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-slate-50 dark:bg-slate-800 text-sm text-slate-600 dark:text-slate-300"
                    />
                    {getQuestSlotSchema(quest.contentSlot) && (
                      <p className="mt-1 text-xs text-indigo-600 dark:text-indigo-400">
                        Schema 提示：{getQuestSlotSchema(quest.contentSlot)!.hint}
                      </p>
                    )}
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">内容数据 data（JSON，如关卡/道具定义）</label>
                    <textarea
                      value={dataText}
                      onChange={(e) => setDataText(e.target.value)}
                      rows={6}
                      className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">独立入口 entryPoint（可选，上传文件后自动识别）</label>
                    <input
                      value={entryPoint}
                      onChange={(e) => setEntryPoint(e.target.value)}
                      placeholder="如 level2.html"
                      className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-sm"
                    />
                    <label className="mt-2 flex items-center gap-2 text-xs text-slate-500 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={fragmentMode}
                        onChange={(e) => setFragmentMode(e.target.checked)}
                        className="w-3.5 h-3.5 rounded border-slate-300 dark:border-slate-600 accent-indigo-500"
                      />
                      entryPoint 是 HTML 片段（非完整页面），平台自动用统一壳包裹成完整页面
                    </label>
                    <label className="mt-1.5 flex items-center gap-2 text-xs text-amber-600 dark:text-amber-400 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={injectMode}
                        onChange={(e) => setInjectMode(e.target.checked)}
                        className="w-3.5 h-3.5 rounded border-slate-300 dark:border-slate-600 accent-amber-500"
                      />
                      注入模式：脚本直接拼进游戏页面（无需游戏内置加载器，加载即生效）。需上传 .js 文件（或 data.code）；可附 css/图片/音频，脚本里用 AllinONE_asset('文件名') 引用，CSS 自动以 &lt;link&gt; 注入
                    </label>
                  </div>
                  {/* 文件上传区 */}
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">资源文件 assets（可选）</label>
                    <input
                      ref={fileInputRef}
                      type="file"
                      multiple
                      className="hidden"
                      onChange={(e) => e.target.files?.length && handleFilesSelected(e.target.files)}
                    />
                    <input
                      ref={folderInputRef}
                      type="file"
                      multiple
                      className="hidden"
                      {...({ webkitdirectory: '', directory: '' } as any)}
                      onChange={(e) => e.target.files?.length && handleFilesSelected(e.target.files)}
                    />
                    <input
                      ref={zipInputRef}
                      type="file"
                      accept=".zip"
                      className="hidden"
                      onChange={(e) => e.target.files?.length && handleFilesSelected(e.target.files)}
                    />
                    <div
                      onDragOver={(e) => {
                        e.preventDefault();
                        setDragActive(true);
                      }}
                      onDragLeave={() => setDragActive(false)}
                      onDrop={(e) => {
                        e.preventDefault();
                        setDragActive(false);
                        if (e.dataTransfer.files?.length) handleFilesSelected(e.dataTransfer.files);
                      }}
                      className={`flex flex-col items-center justify-center gap-2 border-2 border-dashed rounded-xl px-4 py-5 transition-colors cursor-pointer ${
                        dragActive
                          ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-950/40'
                          : 'border-slate-300 dark:border-slate-600 hover:border-indigo-400'
                      }`}
                    >
                      <div className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
                        <Upload className="w-4 h-4 text-indigo-500" />
                        拖拽文件/文件夹到此处，或：
                      </div>
                      <div className="flex flex-wrap items-center justify-center gap-2">
                        <button
                          type="button"
                          onClick={() => fileInputRef.current?.click()}
                          className="px-3 py-1.5 rounded-lg bg-indigo-50 dark:bg-indigo-950/50 text-indigo-600 dark:text-indigo-400 text-xs font-medium hover:bg-indigo-100 dark:hover:bg-indigo-900/50 transition-colors flex items-center gap-1"
                        >
                          <FileCode className="w-3.5 h-3.5" /> 选择文件
                        </button>
                        <button
                          type="button"
                          onClick={() => folderInputRef.current?.click()}
                          className="px-3 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 text-xs font-medium hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors flex items-center gap-1"
                        >
                          <FolderOpen className="w-3.5 h-3.5" /> 选择文件夹
                        </button>
                        <button
                          type="button"
                          onClick={() => zipInputRef.current?.click()}
                          className="px-3 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 text-xs font-medium hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors flex items-center gap-1"
                        >
                          <Archive className="w-3.5 h-3.5" /> 上传 ZIP
                        </button>
                      </div>
                      <p className="text-xs text-slate-400">
                        支持多选、文件夹目录结构、ZIP 自动解压；单文件上限 {formatSize(maxFileSize)}，二进制（图片/音频等）自动编码
                      </p>
                      <p className="text-xs text-amber-600/80 dark:text-amber-400/80">
                        提示：若文件在游戏中位于子目录（如枪系统在 <code className="font-mono">js/</code>），请点击下方文件路径补全目录，例如把 <code className="font-mono">gun.js</code> 改成 <code className="font-mono">js/gun.js</code>，否则游戏找不到该文件。
                      </p>
                      {importing && (
                        <p className="text-xs text-indigo-500 flex items-center gap-1">
                          <Loader2 className="w-3.5 h-3.5 animate-spin" /> 正在导入文件...
                        </p>
                      )}
                    </div>
                    {fileDrafts.length > 0 && (
                      <div className="mt-2 rounded-xl border border-slate-200 dark:border-slate-700 divide-y divide-slate-100 dark:divide-slate-800">
                        {fileDrafts.map((d, i) => (
                          <div key={i} className="flex items-center gap-2 px-3 py-2 text-xs">
                            <span
                              className={`shrink-0 ${d.binary ? 'text-purple-500' : 'text-blue-500'}`}
                              title={d.binary ? '二进制文件（图片/音频等，自动 base64 编码）' : '文本文件'}
                            >
                              {d.binary ? <FileImage className="w-4 h-4" /> : <FileCode className="w-4 h-4" />}
                            </span>
                            <input
                              value={d.path}
                              onChange={(e) => {
                                const np = e.target.value;
                                setFileDrafts((prev) => prev.map((x) => (x.path === d.path ? { ...x, path: np } : x)));
                              }}
                              className="font-mono text-slate-700 dark:text-slate-200 bg-transparent border border-transparent hover:border-slate-300 dark:hover:border-slate-600 focus:border-indigo-400 focus:outline-none rounded px-1 py-0.5 truncate flex-1 min-w-0"
                              title="点击可修改文件在游戏中的路径（如 js/gun.js）"
                            />
                            <span className="shrink-0 text-slate-400">{formatSize(d.size)}</span>
                            <button
                              type="button"
                              onClick={() => setFileDrafts((prev) => prev.filter((x) => x.path !== d.path))}
                              className="shrink-0 p-1 rounded hover:bg-red-50 dark:hover:bg-red-950/40 text-slate-400 hover:text-red-500 transition-colors"
                              title="移除"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        ))}
                        <div className="px-3 py-1.5 text-[11px] text-slate-400 bg-slate-50 dark:bg-slate-800/50 flex items-center justify-between">
                          <span>共 {fileDrafts.length} 个文件</span>
                          <button
                            type="button"
                            onClick={() => setFileDrafts([])}
                            className="text-slate-400 hover:text-red-500 transition-colors"
                          >
                            全部清空
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">
                      assets 手写 JSON（可选，与上传文件合并，同 path 覆盖上传内容）
                    </label>
                    <textarea
                      value={assetsText}
                      onChange={(e) => setAssetsText(e.target.value)}
                      rows={3}
                      placeholder={'[\n  { "path": "level2.css", "content": "body { ... }" }\n]'}
                      className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">提交说明</label>
                    <input
                      value={desc}
                      onChange={(e) => setDesc(e.target.value)}
                      placeholder="简述你的创作"
                      className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-sm"
                    />
                  </div>

                  {/* 沙盒预览 */}
                  <div>
                    <button
                      onClick={() => setShowPreview((v) => !v)}
                      className="text-sm text-indigo-600 hover:text-indigo-700 flex items-center gap-1"
                    >
                      {showPreview ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      {showPreview ? '收起沙盒预览' : '沙盒预览（隔离 iframe）'}
                    </button>
                    {showPreview && (
                      <iframe
                        sandbox=""
                        srcDoc={previewSrcDoc}
                        title="内容包沙盒预览"
                        className="mt-2 w-full h-48 rounded-lg border border-slate-300 dark:border-slate-600 bg-slate-950"
                      />
                    )}
                  </div>

                  <button
                    onClick={handleSubmit}
                    disabled={submitting || quest.status !== 'open'}
                    className="w-full py-2.5 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg font-medium transition-colors flex items-center justify-center gap-2"
                  >
                    <Send className="w-4 h-4" />
                    {submitting ? '提交中...' : '提交任务'}
                  </button>
                  {submitMsg && (
                    <p className={`text-sm ${submitMsg.ok ? 'text-green-600' : 'text-red-500'}`}>{submitMsg.text}</p>
                  )}
                </div>
              </div>
            ) : (
              <QuestReviewPanel quest={quest} onChanged={onChanged} />
            )}
          </div>
        </motion.div>
      </motion.div>

      {/* 任务开发说明预览弹窗 */}
      {showGuide && quest.devGuide && (
        <motion.div
          key="dev-guide"
          className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={() => setShowGuide(false)}
        >
          <motion.div
            className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-full max-w-3xl max-h-[85vh] flex flex-col border border-slate-200 dark:border-slate-700"
            initial={{ scale: 0.95, y: 20 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.95, y: 20 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 dark:border-slate-700">
              <h3 className="text-base font-bold text-slate-900 dark:text-white flex items-center gap-2">
                <BookOpen className="w-4 h-4 text-indigo-500" />
                {quest.devGuideName || '任务开发说明.md'}
              </h3>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={downloadGuide}
                  className="px-3 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 text-xs font-medium hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors flex items-center gap-1"
                >
                  <Download className="w-3.5 h-3.5" /> 下载
                </button>
                <button
                  onClick={() => setShowGuide(false)}
                  className="p-1.5 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors"
                >
                  <X className="w-5 h-5 text-slate-400" />
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-6">
              <pre className="whitespace-pre-wrap break-words font-mono text-[13px] leading-relaxed text-slate-700 dark:text-slate-300">
                {quest.devGuide}
              </pre>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
