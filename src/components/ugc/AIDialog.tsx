/**
 * AI 对话组件 — UGC 道具工坊的创作入口
 *
 * 高级创作模式：AI 对话、粘贴 JSON、effectScript
 * 还提供 SOP 文档展示（可复制给外部 AI）
 */

import React, { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Sparkles, Loader2, RefreshCw, Wand2,
  Clipboard, Check, FileText, Code, ChevronDown, ChevronUp, Upload,
} from 'lucide-react';
import { toast } from 'sonner';
import { ugcBridgeService, type UGCBridgeResult } from '@/services/ugcBridgeService';
import { getPublishedGame, savePublishedGame } from '@/services/publishedGameService';

// ==================== 类型定义 ====================

/** 根据 gameId 解析对应的 schemaName */
function resolveSchemaName(gameId: string): string | undefined {
  // 优先从已注册的 capabilities 中读取（包括发布时动态注册的 SOP）
  const caps = ugcBridgeService.getAvailableSchemas(gameId);
  if (caps.length > 0) return caps[0].name;
  // 回退到硬编码匹配（仅保留已知游戏）
  const gid = gameId.toLowerCase();
  if (gid.includes('zuma') || gid.includes('祖玛')) return 'zuma-powerup';
  if (gid.includes('match3') || gid.includes('消消乐')) return 'match3-powerup';
  return undefined; // 游戏未定义 SOP
}

export interface AIDialogProps {
  /** 目标游戏 ID */
  gameId: string;
  /** 游戏名称 */
  gameName: string;
  /** 用户 ID */
  userId: string;
  /** 用户名称 */
  userName: string;
  /** AI 生成完成回调 */
  onResult: (result: UGCBridgeResult) => void;
  /** 是否禁用 */
  disabled?: boolean;
}

type CreateMode = 'ai' | 'paste';

// ==================== 主组件 ====================

const AIDialog: React.FC<AIDialogProps> = ({
  gameId,
  gameName,
  userId,
  userName,
  onResult,
  disabled = false,
}) => {
  // AI 对话模式
  const [mode, setMode] = useState<CreateMode>('ai');
  const [input, setInput] = useState('');
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showTips, setShowTips] = useState(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // 粘贴模式
  const [jsonInput, setJsonInput] = useState('');
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [jsonValidating, setJsonValidating] = useState(false);
  const jsonRef = useRef<HTMLTextAreaElement>(null);

  // SOP 文档
  const [sopMarkdown, setSopMarkdown] = useState<string>('');
  const [sopCopied, setSopCopied] = useState(false);
  const [sopExpanded, setSopExpanded] = useState(false);
  const [sopSaving, setSopSaving] = useState(false);
  const sopFileInputRef = useRef<HTMLInputElement>(null);

  // 加载 SOP 文档（优先读 sopDocument，回退到 schema rawMarkdown，无则为空）
  useEffect(() => {
    const game = getPublishedGame(gameId);
    if (game?.sopDocument) {
      setSopMarkdown(game.sopDocument);
      return;
    }
    // 回退：从 schema rawMarkdown 读取（向后兼容）
    const schemas = ugcBridgeService.getAvailableSchemas(gameId);
    const withRawMd = schemas.find(s => s.aiGuide?.rawMarkdown);
    if (withRawMd?.aiGuide?.rawMarkdown) {
      setSopMarkdown(withRawMd.aiGuide.rawMarkdown);
    } else {
      setSopMarkdown('');
    }
  }, [gameId]);

  // 自动调整输入框高度
  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.style.height = 'auto';
      inputRef.current.style.height = Math.min(inputRef.current.scrollHeight, 120) + 'px';
    }
  }, [input]);

  // ===== AI 对话 =====
  const handleGenerate = async () => {
    const trimmed = input.trim();
    if (!trimmed || generating) return;

    setGenerating(true);
    setError(null);

    try {
      const result = await ugcBridgeService.createFromIntent({
        rawInput: trimmed,
        targetGameId: gameId,
        gameName,
        userId,
        userName,
        tier: 'advanced',
      });

      if (result.success) {
        setShowTips(false);
        onResult(result);
      } else {
        setError(result.error || 'AI 生成失败，请重试');
        if (result.questions && result.questions.length > 0) {
          setError(`需要更多信息:\n${result.questions.join('\n')}`);
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '生成失败');
    } finally {
      setGenerating(false);
    }
  };

  // ===== 高级模式：粘贴 JSON =====
  const handlePasteSubmit = async () => {
    const trimmed = jsonInput.trim();
    if (!trimmed || jsonValidating) return;

    setJsonValidating(true);
    setJsonError(null);

    try {
      const result = await ugcBridgeService.createFromJSON({
        gameId,
        gameName,
        userId,
        userName,
        jsonData: trimmed,
        schemaName: resolveSchemaName(gameId),
        tier: 'advanced',
      });

      if (result.success) {
        onResult(result);
      } else {
        setJsonError(result.error || 'JSON 校验失败');
      }
    } catch (e) {
      setJsonError(e instanceof Error ? e.message : '创建失败');
    } finally {
      setJsonValidating(false);
    }
  };

  // 复制 SOP 文档
  const handleCopySOP = async () => {
    if (!sopMarkdown) return;
    try {
      await navigator.clipboard.writeText(sopMarkdown);
      setSopCopied(true);
      setTimeout(() => setSopCopied(false), 2000);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = sopMarkdown;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      setSopCopied(true);
      setTimeout(() => setSopCopied(false), 2000);
    }
  };

  // 上传 SOP 文档
  const handleUploadSop = () => {
    // 如果已有文档，提示是否覆盖
    if (sopMarkdown) {
      const confirmed = window.confirm('当前已有 SOP 文档，是否覆盖更新？');
      if (!confirmed) return;
    }
    sopFileInputRef.current?.click();
  };

  const handleSopFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.name.endsWith('.md')) {
      toast.error('请上传 .md 格式的 SOP 文档');
      e.target.value = '';
      return;
    }

    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        const md = ev.target?.result as string;
        if (!md.trim()) {
          toast.error('文件内容为空');
          return;
        }

        // ① 更新内存中的 schema rawMarkdown（即时生效）
        const schemas = ugcBridgeService.getAvailableSchemas(gameId);
        const targetSchema = schemas[0];
        if (targetSchema) {
          if (!targetSchema.aiGuide) {
            (targetSchema as any).aiGuide = {};
          }
          targetSchema.aiGuide!.rawMarkdown = md;
        }

        // ② 持久化到 sopDocument（独立顶级字段，完全不触碰 itemSop）
        setSopSaving(true);
        try {
          const game = getPublishedGame(gameId);
          if (game) {
            await savePublishedGame({ ...game, sopDocument: md });
          }
        } catch (saveErr) {
          console.warn('[AIDialog] SOP 持久化失败:', saveErr);
        } finally {
          setSopSaving(false);
        }

        // ③ 更新本地状态
        setSopMarkdown(md);
        setSopExpanded(true);
        toast.success(sopMarkdown ? 'SOP 文档已更新并保存' : 'SOP 文档已上传并保存');
      } catch (err) {
        toast.error('读取 SOP 文档失败: ' + (err instanceof Error ? err.message : '未知错误'));
      }
    };
    reader.readAsText(file);
    // 重置 input 值，以便同一文件可以重复上传
    e.target.value = '';
  };

  // 键盘事件
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleGenerate();
    }
  };

  const handleJsonKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handlePasteSubmit();
    }
  };

  // 填充示例 JSON
  const handleFillExample = () => {
    const example = {
      name: '时空炸弹',
      effect: 'remove_area',
      params: { radius: 1 },
      description: '先炸后延时：3×3 范围消除 + 10秒',
      effectScript: {
        op: 'sequence',
        effects: [
          { effect: 'remove_area', params: { radius: 1 } },
          { effect: 'add_time', params: { seconds: 10 } },
        ],
      },
    };
    setJsonInput(JSON.stringify(example, null, 2));
    setJsonError(null);
  };

  // 🆕 填充自定义效果示例
  const handleFillCustomExample = () => {
    const customExample = {
      name: '随机宝石',
      effect: 'randomize_cell',
      params: { target: 'selected' },
      description: '将选中的宝石随机变为红/蓝/绿/黄/紫/橙中的一种颜色，创造意外连击',
      effectCode: "function(params, row, col) {\n  var colors = ['red','blue','green','yellow','purple','orange'];\n  var cur = board[row][col].color;\n  var nc = cur;\n  while (nc === cur && colors.length > 1) nc = colors[Math.floor(Math.random()*colors.length)];\n  board[row][col].color = nc;\n  return { matches:[], boardEffect:function(){renderBoard(false);}, instantMessage:'宝石变成了'+nc+'色！' };\n}",
    };
    setJsonInput(JSON.stringify(customExample, null, 2));
    setJsonError(null);
  };

  // 快捷提示
  const ADVANCED_QUICK_PROMPTS = [
    { label: '时空炸弹', prompt: '创建时空炸弹道具：先3×3范围消除，再增加10秒' },
    { label: '彩虹+步数', prompt: '创建彩虹步数道具：消除所有同色宝石并增加3步' },
    { label: '链式闪电', prompt: '创建链式闪电：先消除一行，再从终点消除一列' },
    { label: '随机宝石', prompt: '创建一个随机宝石道具：点击一个宝石，将它随机变成另一种颜色，可能创造意外连击。使用 effectCode 自定义效果函数' },
  ];

  return (
    <div className="space-y-4">
      {/* 游戏上下文指示器 */}
      <div className="flex items-center gap-2 px-1">
        <span className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#7C3AED]/15 rounded-full text-sm text-violet-300 border border-[#7C3AED]/30">
          <Wand2 className="w-3.5 h-3.5" />
          正在为 <strong className="text-violet-200">{gameName}</strong> 创造道具
        </span>
      </div>

      {/* 隐藏的 SOP 文件输入 */}
      <input
        ref={sopFileInputRef}
        type="file"
        accept=".md"
        className="hidden"
        onChange={handleSopFileChange}
      />

      {/* SOP 文档折叠区域 */}
        <div className="border border-slate-700/30 rounded-xl overflow-hidden">
          <button
            onClick={() => setSopExpanded(!sopExpanded)}
            className="w-full flex items-center justify-between px-4 py-3 bg-slate-800/30 hover:bg-slate-800/50 transition-colors cursor-pointer"
          >
            <div className="flex items-center gap-2 text-sm text-slate-300">
              <FileText className="w-4 h-4 text-[#7C3AED]" />
              <span>游戏 SOP 文档</span>
              <span className="text-xs text-slate-500">— 可复制给外部 AI 使用</span>
              {sopMarkdown && (
                <span className="text-xs bg-green-500/20 text-green-400 px-1.5 py-0.5 rounded-full">
                  {sopSaving ? '保存中...' : '已保存'}
                </span>
              )}
            </div>
            {sopExpanded
              ? <ChevronUp className="w-4 h-4 text-slate-500" />
              : <ChevronDown className="w-4 h-4 text-slate-500" />
            }
          </button>
          <AnimatePresence>
            {sopExpanded && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="overflow-hidden"
              >
                <div className="px-4 py-3 border-t border-slate-700/30">
                  {sopMarkdown ? (
                    <>
                      <div className="flex items-center justify-between mb-3">
                        <span className="text-xs text-slate-500">将此文档复制到 ChatGPT / Claude 等外部 AI，让它帮你生成合规的道具 JSON</span>
                        <div className="flex items-center gap-2">
                          <button
                            onClick={handleUploadSop}
                            className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-500/15 hover:bg-amber-500/25
                                       text-amber-300 border border-amber-500/25 rounded-lg text-xs
                                       transition-colors cursor-pointer"
                          >
                            <Upload className="w-3 h-3" /> 更新文档
                          </button>
                          <button
                            onClick={handleCopySOP}
                            className="flex items-center gap-1.5 px-3 py-1.5 bg-[#7C3AED]/15 hover:bg-[#7C3AED]/25
                                       text-violet-300 border border-[#7C3AED]/25 rounded-lg text-xs
                                       transition-colors cursor-pointer"
                          >
                            {sopCopied ? (
                              <><Check className="w-3 h-3" /> 已复制</>
                            ) : (
                              <><Clipboard className="w-3 h-3" /> 复制 SOP</>
                            )}
                          </button>
                        </div>
                      </div>
                      <div className="max-h-64 overflow-y-auto p-3 bg-[#0F0F23]/60 rounded-lg border border-slate-700/20">
                        <pre className="text-xs text-slate-400 whitespace-pre-wrap font-mono leading-relaxed">
                          {sopMarkdown}
                        </pre>
                      </div>
                    </>
                  ) : (
                    <div className="flex flex-col items-center gap-3 py-6">
                      <p className="text-slate-500 text-sm">该游戏暂未上传 SOP 文档</p>
                      <button
                        onClick={handleUploadSop}
                        className="flex items-center gap-1.5 px-4 py-2 bg-[#7C3AED]/20 hover:bg-[#7C3AED]/35
                                   text-violet-300 border border-[#7C3AED]/30 rounded-lg text-sm
                                   transition-colors cursor-pointer"
                      >
                        <Upload className="w-4 h-4" /> 上传 SOP 文档 (.md)
                      </button>
                    </div>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

      {/* 创作模式 */}
      <div className="space-y-2">
        <div className="text-xs text-slate-500 px-1">创作模式：AI 对话 / 粘贴 JSON / effectScript 自由创作</div>
      </div>

      {/* 错误信息 */}
      <AnimatePresence>
        {error && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            className="px-4 py-3 bg-rose-500/10 border border-rose-500/20 rounded-lg text-rose-300 text-sm whitespace-pre-line"
          >
            {error}
            <button
              onClick={() => setError(null)}
              className="ml-2 text-rose-400 hover:text-rose-300 underline text-xs"
            >
              关闭
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ===== AI + 粘贴 JSON ===== */}
      <div className="space-y-4">
            {/* 子模式切换 */}
            <div className="flex gap-1 p-1 bg-slate-800/30 rounded-lg border border-slate-700/30">
              <button
                onClick={() => { setMode('ai'); setError(null); }}
                className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-md text-sm font-medium transition-all cursor-pointer
                  ${mode === 'ai'
                    ? 'bg-[#7C3AED]/20 text-violet-300 border border-[#7C3AED]/30'
                    : 'text-slate-500 hover:text-slate-400 border border-transparent'}`}
              >
                <Sparkles className="w-3.5 h-3.5" />
                AI 对话
              </button>
              <button
                onClick={() => { setMode('paste'); setJsonError(null); }}
                className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-md text-sm font-medium transition-all cursor-pointer
                  ${mode === 'paste'
                    ? 'bg-[#7C3AED]/20 text-violet-300 border border-[#7C3AED]/30'
                    : 'text-slate-500 hover:text-slate-400 border border-transparent'}`}
              >
                <Code className="w-3.5 h-3.5" />
                粘贴 JSON
              </button>
            </div>

            {/* AI 对话模式 */}
            <AnimatePresence mode="wait">
              {mode === 'ai' && (
                <motion.div key="ai-sub" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="space-y-4">
                  {/* 快捷提示 */}
                  <AnimatePresence>
                    {showTips && !generating && (
                      <motion.div
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -8 }}
                        className="flex flex-wrap gap-2"
                      >
                        <span className="text-xs text-slate-500 w-full mb-1">快速开始：</span>
                        {ADVANCED_QUICK_PROMPTS.map((tip) => (
                          <button
                            key={tip.label}
                            onClick={() => { setInput(tip.prompt); setShowTips(false); }}
                            disabled={disabled}
                            className="px-3 py-1.5 text-xs bg-[#7C3AED]/10 hover:bg-[#7C3AED]/20
                                       text-violet-300 border border-[#7C3AED]/20 rounded-full
                                       transition-colors duration-200 cursor-pointer"
                          >
                            {tip.label}
                          </button>
                        ))}
                      </motion.div>
                    )}
                  </AnimatePresence>

                  <div className="relative">
                    <textarea
                      ref={inputRef}
                      value={input}
                      onChange={(e) => setInput(e.target.value)}
                      onKeyDown={handleKeyDown}
                      placeholder={`描述你想要的道具效果...\n\n支持 effectScript 组合效果，例如："创建时空炸弹：先炸3×3，再延时10秒"`}
                      disabled={disabled || generating}
                      className="w-full min-h-[80px] max-h-[120px] px-4 py-3 bg-[#0F0F23]/80
                                 border border-[#7C3AED]/20 rounded-xl text-slate-200
                                 placeholder:text-slate-600 text-sm resize-none
                                 focus:border-[#7C3AED]/50 focus:ring-1 focus:ring-[#7C3AED]/30
                                 focus:outline-none transition-all duration-200
                                 disabled:opacity-50 disabled:cursor-not-allowed"
                      rows={2}
                    />
                  </div>

                  <div className="flex items-center gap-3">
                    <button
                      onClick={handleGenerate}
                      disabled={disabled || generating || !input.trim()}
                      className="flex items-center gap-2 px-5 py-2.5 bg-[#7C3AED] hover:bg-[#6D28D9]
                                 text-white font-medium rounded-lg text-sm
                                 disabled:opacity-40 disabled:cursor-not-allowed
                                 shadow-lg shadow-[#7C3AED]/25 transition-all duration-200 cursor-pointer"
                    >
                      {generating ? (
                        <><Loader2 className="w-4 h-4 animate-spin" /> AI 分析中...</>
                      ) : (
                        <><Sparkles className="w-4 h-4" /> 生成道具</>
                      )}
                    </button>
                    {generating && (
                      <span className="text-xs text-slate-500 flex items-center gap-1">
                        <Loader2 className="w-3 h-3 animate-spin" />
                        正在分析意图并匹配 Schema...
                      </span>
                    )}
                    {!generating && input && (
                      <button
                        onClick={() => { setInput(''); setShowTips(true); }}
                        className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-400 transition-colors cursor-pointer"
                      >
                        <RefreshCw className="w-3 h-3" />
                        重置
                      </button>
                    )}
                  </div>
                </motion.div>
              )}

              {/* 粘贴 JSON 模式 */}
              {mode === 'paste' && (
                <motion.div key="paste-sub" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="space-y-4">
                  <div className="p-3 bg-blue-500/10 border border-blue-500/20 rounded-lg">
                    <p className="text-xs text-blue-300">
                      粘贴外部 AI 生成的 JSON（支持 effectScript 组合效果 和 effectCode 自定义效果函数）。Ctrl+Enter 快捷提交。
                    </p>
                  </div>

                  <div className="relative">
                    <textarea
                      ref={jsonRef}
                      value={jsonInput}
                      onChange={(e) => { setJsonInput(e.target.value); setJsonError(null); }}
                      onKeyDown={handleJsonKeyDown}
                      placeholder={`粘贴 AI 生成的 JSON...\n\n支持 effectScript，例如：\n{\n  "name": "时空炸弹",\n  "effect": "remove_area",\n  "params": { "radius": 1 },\n  "effectScript": {\n    "op": "sequence",\n    "effects": [\n      { "effect": "remove_area", "params": { "radius": 1 } },\n      { "effect": "add_time", "params": { "seconds": 10 } }\n    ]\n  }\n}`}
                      disabled={disabled || jsonValidating}
                      className="w-full min-h-[160px] px-4 py-3 bg-[#0F0F23]/80
                                 border border-emerald-500/20 rounded-xl text-slate-200
                                 placeholder:text-slate-600 text-sm resize-y font-mono
                                 focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/30
                                 focus:outline-none transition-all duration-200
                                 disabled:opacity-50 disabled:cursor-not-allowed"
                      rows={6}
                    />
                  </div>

                  {/* JSON 错误 */}
                  <AnimatePresence>
                    {jsonError && (
                      <motion.div
                        initial={{ opacity: 0, y: -4 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -4 }}
                        className="px-4 py-3 bg-rose-500/10 border border-rose-500/20 rounded-lg text-rose-300 text-sm whitespace-pre-line"
                      >
                        {jsonError}
                        <button
                          onClick={() => setJsonError(null)}
                          className="ml-2 text-rose-400 hover:text-rose-300 underline text-xs"
                        >
                          关闭
                        </button>
                      </motion.div>
                    )}
                  </AnimatePresence>

                  <div className="flex items-center gap-3">
                    <button
                      onClick={handlePasteSubmit}
                      disabled={disabled || jsonValidating || !jsonInput.trim()}
                      className="flex items-center gap-2 px-5 py-2.5 bg-emerald-600 hover:bg-emerald-700
                                 text-white font-medium rounded-lg text-sm
                                 disabled:opacity-40 disabled:cursor-not-allowed
                                 shadow-lg shadow-emerald-600/25 transition-all duration-200 cursor-pointer"
                    >
                      {jsonValidating ? (
                        <><Loader2 className="w-4 h-4 animate-spin" /> 校验中...</>
                      ) : (
                        <><Check className="w-4 h-4" /> 校验 & 创建</>
                      )}
                    </button>
                    <button
                      onClick={handleFillExample}
                      className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-400 transition-colors cursor-pointer"
                    >
                      <FileText className="w-3 h-3" />
                      组合示例
                    </button>
                    <button
                      onClick={handleFillCustomExample}
                      className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-400 transition-colors cursor-pointer"
                    >
                      <Code className="w-3 h-3" />
                      自定义示例
                    </button>
                    {!jsonValidating && jsonInput && (
                      <button
                        onClick={() => { setJsonInput(''); setJsonError(null); }}
                        className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-400 transition-colors cursor-pointer"
                      >
                        <RefreshCw className="w-3 h-3" />
                        清空
                      </button>
                    )}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
      </div>
    </div>
  );
};

export default AIDialog;
