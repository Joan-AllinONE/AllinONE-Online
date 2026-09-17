/**
 * 内容工坊（Content Workshop）— 道具工坊的并列升级
 *
 * 玩家按游戏方「内容创作 SOP」创作完整内容数据包（地图/角色/剧情/道具），
 * 铸造为「内容凭证」（按次使用、可交易），由游戏内 AllinONE_ContentLoader 按次应用。
 *
 * 与道具工坊的区别：
 * - 交付物从「道具 JSON」升级为「内容数据包」（data + assets[js/css/图片/音频]）
 * - 凭证强制：内容凭证可交易/转赠，1 张 = 1 次游戏会话
 * - 可选上架 remix 版（?ext= 版本切换，走审核）
 */

import React, { useState, useEffect, useContext, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Link } from 'react-router-dom';
import {
  ArrowLeft, Gamepad2, Sparkles, Rocket, CheckCircle, Loader2,
  UploadCloud, FileCode2, Boxes, AlertTriangle, Info, Coins, Layers, Store,
} from 'lucide-react';
import { getPublishedGames, type PublishedGame } from '@/services/publishedGameService';
import { voucherItemService } from '@/services/voucherItemService';
import { AuthContext } from '@/contexts/authContext';
import {
  mintContentVoucher, generateContentWithAI, requestRemix,
  type MintContentResult,
} from '@/services/contentService';
import { validateQuestContent } from '@/types/quest';
import type { GameContentPack, ContentPackAsset, GameContentSop } from '@/types/quest';

// ==================== 工具函数 ====================

const TEXT_EXTS = ['js', 'mjs', 'css', 'json', 'html', 'htm', 'txt', 'md', 'xml', 'svg', 'map', 'ts'];

async function fileToAsset(file: File): Promise<ContentPackAsset> {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (TEXT_EXTS.includes(ext)) {
    const text = await file.text();
    return { path: file.name, content: text };
  }
  // 二进制 → base64 前缀存储
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return { path: file.name, content: '__BINARY_BASE64__' + btoa(binary) };
}

function extractJson(text: string): GameContentPack | null {
  const trimmed = text.trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(trimmed.slice(start, end + 1)) as GameContentPack;
  } catch {
    return null;
  }
}

// 按内容类型生成骨架（AI 不可用时的本地回退）
function buildSkeleton(type: string, name: string, assets: ContentPackAsset[]): GameContentPack {
  const assetNames = assets.map(a => a.path);
  const base: GameContentPack = { type: type as any, name, slot: 'inject', data: {}, assets };
  switch (type) {
    case 'map':
      return {
        ...base,
        slot: 'levels',
        data: {
          title: name,
          layout: [
            '################',
            '#..................',
            '#..................',
            '#..................',
            '#..................',
            '#..................',
            '#..................',
            '#..................',
            '#..................',
            '#..................',
            '#..................',
            '#..................',
            '################',
          ],
          script: assetNames.find(n => n.endsWith('.js')) || '',
        },
      };
    case 'character':
      return { ...base, data: { id: name, name, hp: 100, attack: 10, speed: 5, skin: assetNames[0] || '' } };
    case 'story':
      return { ...base, slot: 'scripts', data: { id: name, name, chapters: [{ title: '第一章', text: '' }] } };
    case 'item':
      return { ...base, slot: 'items', data: { id: name, name, effect: 'custom', params: {} } };
    default:
      return { ...base, data: { name, note: '自定义内容，请在 data 中补充细节' } };
  }
}

// ==================== 主组件 ====================

const ContentWorkshop: React.FC = () => {
  const { currentUser } = useContext(AuthContext);
  const [games, setGames] = useState<PublishedGame[]>([]);
  const [selectedGame, setSelectedGame] = useState<PublishedGame | null>(null);
  const [loadingGames, setLoadingGames] = useState(true);

  // 创作状态
  const [tab, setTab] = useState<'ai' | 'files' | 'json'>('ai');
  const [description, setDescription] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState('');
  const [contentType, setContentType] = useState('map');
  const [packName, setPackName] = useState('');
  const [assets, setAssets] = useState<ContentPackAsset[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [jsonText, setJsonText] = useState('');
  const [jsonError, setJsonError] = useState('');

  // 结果
  const [draft, setDraft] = useState<GameContentPack | null>(null);
  const [issues, setIssues] = useState<string[]>([]);

  // 铸造状态
  const [price, setPrice] = useState<number | ''>(10);
  const [count, setCount] = useState(3);
  const [publishing, setPublishing] = useState(false);
  const [publishResult, setPublishResult] = useState<{ success: boolean; message: string } | null>(null);
  const [mintResult, setMintResult] = useState<MintContentResult | null>(null);
  const [doRemix, setDoRemix] = useState(false);
  // 上架到商店「道具凭证」tab（凭证进平台池作库存，另赠创作者 1 张自用）
  const [listOnStore, setListOnStore] = useState(true);

  const userId = currentUser?.id || `guest-${Date.now()}`;
  const userName = currentUser?.username || '访客玩家';

  useEffect(() => {
    // 仅展示显式启用内容工坊的游戏（contentSop.enabled）
    const load = () => {
      try {
        setGames(getPublishedGames().filter(g => g.contentSop?.enabled));
      } catch (e) {
        console.warn('加载游戏列表失败:', e);
      }
      setLoadingGames(false);
    };
    load();
    // ⚠️ dev 下 getPublishedGames() 依赖后台刷新填充的内存缓存，挂载那一刻可能还是空的，
    // 因此必须监听刷新完成事件重读；再加一次延迟重读兜底（刷新较慢 / 事件早于挂载）。
    window.addEventListener('games-list-updated', load);
    const timer = window.setTimeout(load, 1200);
    return () => {
      window.removeEventListener('games-list-updated', load);
      window.clearTimeout(timer);
    };
  }, []);

  const contentSop: GameContentSop | undefined = selectedGame?.contentSop;

  // ============ 创作 ============

  const buildPrompt = useCallback(() => {
    const types = contentSop?.contentTypes || [{ type: 'map', slot: 'levels', label: '地图', description: '', modes: ['data', 'inject'] }];
    const typeDecl = types.find(t => t.type === contentType) || types[0];
    const guide = contentSop?.sopDocument || '';
    return `你是 AllinONE 游戏平台的内容创作者。请为游戏《${selectedGame?.name}》创作一个「${typeDecl.label}」内容数据包。

【内容类型】${typeDecl.type}（slot=${typeDecl.slot}，允许形态: ${typeDecl.modes.join('/')}）
${typeDecl.description ? '【说明】' + typeDecl.description : ''}
${typeDecl.apiGuide ? '【游戏创作 API】' + typeDecl.apiGuide : ''}
${guide ? '【创作指南】\n' + guide.slice(0, 3000) : ''}

【我的需求】${description}

请直接输出一个 JSON 对象（不要包含任何解释文字），结构如下：
{
  "type": "${typeDecl.type}",
  "slot": "${typeDecl.slot}",
  "name": "内容名称",
  "description": "内容简介",
  "data": { ... },
  "assets": []
}
注：assets 中每个元素形如 {"path": "js/xxx.js", "content": "代码或文本内容"}；纯数据内容可留空 assets。`;
  }, [contentSop, contentType, description, selectedGame]);

  const handleAIGenerate = async () => {
    if (!description.trim()) {
      setAiError('请先描述你想创作的内容');
      return;
    }
    setAiLoading(true);
    setAiError('');
    try {
      const raw = await generateContentWithAI(buildPrompt());
      if (raw) {
        const pack = extractJson(raw);
        if (pack) {
          setDraft(pack);
          setIssues(validateQuestContent(pack.slot || 'inject', pack));
          return;
        }
        setAiError('AI 返回内容无法解析为 JSON，请检查或改用粘贴 JSON 模式');
        return;
      }
      // AI 不可用 → 本地骨架回退
      const skeleton = buildSkeleton(contentType, packName || `${description.slice(0, 12)}...`, assets);
      setDraft(skeleton);
      setIssues(validateQuestContent(skeleton.slot, skeleton));
      setAiError('');
    } catch (e) {
      setAiError(e instanceof Error ? e.message : '生成失败');
    } finally {
      setAiLoading(false);
    }
  };

  const handleFiles = async (files: FileList | File[]) => {
    const list = Array.from(files);
    const newAssets: ContentPackAsset[] = [];
    for (const f of list) {
      try {
        newAssets.push(await fileToAsset(f));
      } catch (e) {
        console.warn('文件读取失败:', f.name, e);
      }
    }
    setAssets(prev => [...prev, ...newAssets]);
    // 有文件时自动构建草稿（data 骨架 + assets）
    const skeleton = buildSkeleton(contentType, packName || selectedGame?.name || '内容包', [...assets, ...newAssets]);
    setDraft(skeleton);
    setIssues(validateQuestContent(skeleton.slot, skeleton));
  };

  const handleJsonPaste = () => {
    const pack = extractJson(jsonText);
    if (!pack) {
      setJsonError('JSON 解析失败：请确保是合法 JSON 对象');
      return;
    }
    setJsonError('');
    setDraft(pack);
    setIssues(validateQuestContent(pack.slot || 'inject', pack));
  };

  const removeAsset = (path: string) => {
    const next = assets.filter(a => a.path !== path);
    setAssets(next);
    if (draft) {
      const nextDraft = { ...draft, assets: next };
      setDraft(nextDraft);
      setIssues(validateQuestContent(nextDraft.slot || 'inject', nextDraft));
    }
  };

  // ============ 铸造 ============

  const handleMint = async () => {
    if (!draft || !selectedGame) return;
    setPublishing(true);
    setPublishResult(null);
    try {
      // ① 内容资产落库
      const mint = await mintContentVoucher({
        gameId: selectedGame.id,
        contentPack: { ...draft, name: draft.name || packName || selectedGame.name, type: (draft.type || contentType) as any },
        authorId: userId,
        authorName: userName,
      });
      if (!mint.success || !mint.contentId || !mint.manifest) {
        setPublishResult({ success: false, message: mint.message || '内容资产落库失败' });
        return;
      }
      setMintResult(mint);

      // ② 铸造内容凭证（强制，1 张 = 1 次）
      const mintVouchers = voucherItemService.mintContentVouchers({
        gameId: selectedGame.id,
        gameName: selectedGame.name,
        contentId: mint.contentId,
        manifest: mint.manifest,
        assetBase: mint.assetBase || `content/${mint.contentId}/`,
        name: mint.name || draft.name,
        description: draft.description,
        type: mint.type || 'custom',
        slot: mint.slot || 'inject',
        price: Number(price) || 0,
        count: Number(count) || 1,
        recipientId: userId,
        recipientName: userName,
        authorId: userId,
        authorName: userName,
        listOnStore,
      });
      if (!mintVouchers.success) {
        setPublishResult({ success: false, message: mintVouchers.message });
        return;
      }

      // ③ 可选：上架 remix 版（走审核）
      if (doRemix && mint.contentId) {
        const remixRes = await requestRemix(mint.contentId, { slot: mint.slot });
        if (!remixRes.success) {
          console.warn('[ContentWorkshop] remix 上架失败:', remixRes.message);
        }
      }

      setPublishResult({
        success: true,
        message: `内容「${mint.name}」已铸造 ${mintVouchers.vouchers.length} 张内容凭证${doRemix ? '，并已提交 remix 版审核' : ''}！`,
      });
    } catch (e) {
      setPublishResult({ success: false, message: e instanceof Error ? e.message : '铸造失败' });
    } finally {
      setPublishing(false);
    }
  };

  const reset = () => {
    setSelectedGame(null);
    setDraft(null);
    setIssues([]);
    setPublishResult(null);
    setMintResult(null);
    setAssets([]);
    setPackName('');
    setJsonText('');
    setDescription('');
    setAiError('');
  };

  // ==================== 渲染 ====================

  if (loadingGames) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-violet-400 animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 pb-16">
      {/* Header */}
      <header className="bg-slate-900 border-b border-slate-800 sticky top-0 z-30">
        <div className="container mx-auto px-4 py-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <Link to="/game-center" className="w-9 h-9 rounded-lg bg-slate-800 hover:bg-slate-700 flex items-center justify-center shrink-0">
              <ArrowLeft className="w-4 h-4" />
            </Link>
            <div className="min-w-0">
              <h1 className="text-lg font-bold flex items-center gap-2">
                <Boxes className="w-5 h-5 text-violet-400" />
                内容工坊
              </h1>
              <p className="text-xs text-slate-400 truncate">创作完整内容数据包（地图/角色/剧情/道具）→ 铸造内容凭证（按次使用、可交易）</p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Link to="/workshop" className="px-3 py-1.5 text-xs bg-slate-800 hover:bg-slate-700 rounded-lg text-slate-300 transition-colors">
              道具工坊
            </Link>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-6 max-w-5xl">
        {/* Step 1: 选择游戏 */}
        {!selectedGame && (
          <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}>
            <div className="flex items-center gap-2 mb-6">
              <Gamepad2 className="w-5 h-5 text-violet-400" />
              <h2 className="text-lg font-semibold">选择支持内容创作的游戏</h2>
            </div>
            {games.length === 0 ? (
              <div className="bg-slate-900 rounded-2xl border border-slate-800 p-10 text-center">
                <Info className="w-10 h-10 text-slate-600 mx-auto mb-3" />
                <p className="text-slate-400">暂无启用「内容创作 SOP」的游戏。</p>
                <p className="text-xs text-slate-600 mt-2">游戏方需在发布中心配置内容创作 SOP 后，内容工坊才会开放该游戏的创作。</p>
                <Link to="/publishing-center" className="inline-block mt-4 px-4 py-2 bg-violet-600 hover:bg-violet-500 rounded-lg text-sm">
                  前往发布中心
                </Link>
              </div>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {games.map(game => (
                  <button
                    key={game.id}
                    onClick={() => { setSelectedGame(game); setContentType(game.contentSop?.contentTypes?.[0]?.type || 'map'); }}
                    className="text-left bg-slate-900 rounded-2xl border border-slate-800 hover:border-violet-500/60 hover:shadow-lg hover:shadow-violet-500/10 transition-all p-5"
                  >
                    <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-violet-600 to-purple-600 flex items-center justify-center mb-3 text-lg font-bold">
                      {game.name.slice(0, 1)}
                    </div>
                    <h3 className="font-bold mb-1">{game.name}</h3>
                    <p className="text-xs text-slate-400 line-clamp-2 mb-3">{game.description}</p>
                    <div className="flex flex-wrap gap-1.5">
                      {(game.contentSop?.contentTypes || []).map(t => (
                        <span key={t.type} className="px-2 py-0.5 bg-violet-500/10 text-violet-300 border border-violet-500/30 rounded-full text-xs">
                          {t.label}
                        </span>
                      ))}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </motion.div>
        )}

        {/* Step 2: 创作 + 铸造 */}
        {selectedGame && !draft && (
          <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}>
            <div className="flex items-center gap-2 mb-4">
              <button onClick={reset} className="text-sm text-slate-400 hover:text-white flex items-center gap-1">
                <ArrowLeft className="w-3.5 h-3.5" /> 返回
              </button>
              <span className="text-slate-600">/</span>
              <h2 className="font-semibold">{selectedGame.name}</h2>
              {contentSop?.contentTypes?.length ? (
                <div className="ml-auto flex flex-wrap gap-1.5">
                  {contentSop.contentTypes.map(t => (
                    <button
                      key={t.type}
                      onClick={() => setContentType(t.type)}
                      className={`px-3 py-1 rounded-full text-xs border transition-colors ${
                        contentType === t.type
                          ? 'bg-violet-600 border-violet-500 text-white'
                          : 'bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700'
                      }`}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>

            {/* 内容类型说明 + 创作指南 */}
            <div className="bg-slate-900 rounded-2xl border border-slate-800 p-4 mb-4">
              <div className="flex items-start gap-3">
                <Sparkles className="w-4 h-4 text-violet-400 mt-0.5 shrink-0" />
                <div>
                  {contentSop?.contentTypes?.find(t => t.type === contentType) ? (
                    <>
                      <p className="text-sm font-medium">
                        {contentSop.contentTypes.find(t => t.type === contentType)!.label}
                        <span className="text-slate-500 ml-2">
                          slot={contentSop.contentTypes.find(t => t.type === contentType)!.slot}
                          {' · '}{contentSop.contentTypes.find(t => t.type === contentType)!.modes.join('/')}
                        </span>
                      </p>
                      <p className="text-xs text-slate-400 mt-1">
                        {contentSop.contentTypes.find(t => t.type === contentType)!.description}
                      </p>
                      {contentSop.contentTypes.find(t => t.type === contentType)!.apiGuide && (
                        <p className="text-xs text-emerald-400 mt-1">
                          创作 API: {contentSop.contentTypes.find(t => t.type === contentType)!.apiGuide}
                        </p>
                      )}
                    </>
                  ) : null}
                </div>
              </div>
            </div>

            {/* 创作标签 */}
            <div className="flex gap-2 mb-4">
              {([
                { key: 'ai', label: 'AI 生成', icon: Sparkles },
                { key: 'files', label: '多文件上传', icon: UploadCloud },
                { key: 'json', label: '粘贴 JSON', icon: FileCode2 },
              ] as const).map(t => (
                <button
                  key={t.key}
                  onClick={() => setTab(t.key)}
                  className={`px-4 py-2 rounded-lg text-sm flex items-center gap-2 transition-colors ${
                    tab === t.key ? 'bg-violet-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                  }`}
                >
                  <t.icon className="w-4 h-4" />
                  {t.label}
                </button>
              ))}
            </div>

            {/* AI 生成 */}
            {tab === 'ai' && (
              <div className="bg-slate-900 rounded-2xl border border-slate-800 p-5 space-y-4">
                <div>
                  <label className="block text-xs text-slate-400 mb-1.5">描述你想创作的内容</label>
                  <textarea
                    value={description}
                    onChange={e => setDescription(e.target.value)}
                    placeholder={`例如：为超级玛丽创作一张「幽暗森林」地图，包含管道路径和 3 个金币……`}
                    className="w-full h-28 bg-slate-800 border border-slate-700 rounded-xl p-3 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500"
                  />
                </div>
                <div>
                  <label className="block text-xs text-slate-400 mb-1.5">内容名称</label>
                  <input
                    value={packName}
                    onChange={e => setPackName(e.target.value)}
                    placeholder="如：幽暗森林"
                    className="w-full bg-slate-800 border border-slate-700 rounded-xl p-3 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500"
                  />
                </div>
                <div className="flex items-center gap-3">
                  <button
                    onClick={handleAIGenerate}
                    disabled={aiLoading || !description.trim()}
                    className="px-5 py-2.5 bg-violet-600 hover:bg-violet-500 disabled:opacity-50 rounded-lg text-sm font-medium flex items-center gap-2"
                  >
                    {aiLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                    {aiLoading ? '生成中...' : '生成内容包'}
                  </button>
                  {aiError && <p className="text-xs text-amber-400 flex items-center gap-1"><AlertTriangle className="w-3.5 h-3.5" />{aiError}</p>}
                </div>
                <p className="text-xs text-slate-500">
                  💡 AI 不可用时会自动生成本地骨架；也可在「粘贴 JSON」模式中使用外部 AI 生成。
                </p>
              </div>
            )}

            {/* 多文件上传 */}
            {tab === 'files' && (
              <div className="bg-slate-900 rounded-2xl border border-slate-800 p-5 space-y-4">
                <div
                  onDragOver={e => { e.preventDefault(); setDragOver(true); }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={e => { e.preventDefault(); setDragOver(false); if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files); }}
                  className={`border-2 border-dashed rounded-xl p-8 text-center transition-colors ${
                    dragOver ? 'border-violet-500 bg-violet-500/10' : 'border-slate-700 hover:border-slate-500'
                  }`}
                >
                  <UploadCloud className="w-8 h-8 text-slate-500 mx-auto mb-2" />
                  <p className="text-sm text-slate-300">拖拽 js / css / 图片 / 音频 到此处</p>
                  <p className="text-xs text-slate-500 mt-1">或</p>
                  <label className="inline-block mt-2 px-4 py-2 bg-slate-800 hover:bg-slate-700 rounded-lg text-sm cursor-pointer">
                    选择文件
                    <input type="file" multiple className="hidden" onChange={e => { if (e.target.files) handleFiles(e.target.files); }} />
                  </label>
                </div>
                {assets.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-xs text-slate-400">已添加 {assets.length} 个资产：</p>
                    {assets.map(a => (
                      <div key={a.path} className="flex items-center justify-between bg-slate-800 rounded-lg px-3 py-2 text-sm">
                        <span className="flex items-center gap-2">
                          <FileCode2 className="w-4 h-4 text-slate-500" />
                          {a.path}
                        </span>
                        <button onClick={() => removeAsset(a.path)} className="text-slate-500 hover:text-red-400 text-xs">移除</button>
                      </div>
                    ))}
                  </div>
                )}
                <div>
                  <label className="block text-xs text-slate-400 mb-1.5">内容名称</label>
                  <input
                    value={packName}
                    onChange={e => setPackName(e.target.value)}
                    placeholder="如：幽暗森林"
                    className="w-full bg-slate-800 border border-slate-700 rounded-xl p-3 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500"
                  />
                </div>
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => {
                      if (!assets.length && !packName) return;
                      const skeleton = buildSkeleton(contentType, packName || selectedGame.name, assets);
                      setDraft(skeleton);
                      setIssues(validateQuestContent(skeleton.slot, skeleton));
                    }}
                    disabled={!assets.length && !packName}
                    className="px-5 py-2.5 bg-violet-600 hover:bg-violet-500 disabled:opacity-50 rounded-lg text-sm font-medium"
                  >
                    打包为内容数据包
                  </button>
                </div>
              </div>
            )}

            {/* 粘贴 JSON */}
            {tab === 'json' && (
              <div className="bg-slate-900 rounded-2xl border border-slate-800 p-5 space-y-4">
                <div>
                  <label className="block text-xs text-slate-400 mb-1.5">粘贴 ContentPack JSON（可包含 assets 内嵌内容）</label>
                  <textarea
                    value={jsonText}
                    onChange={e => { setJsonText(e.target.value); setJsonError(''); }}
                    placeholder={`{\n  "type": "map",\n  "slot": "levels",\n  "name": "幽暗森林",\n  "data": { "title": "幽暗森林", "layout": [...] },\n  "assets": [ { "path": "js/map.js", "content": "..." } ]\n}`}
                    className="w-full h-56 bg-slate-800 border border-slate-700 rounded-xl p-3 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-violet-500"
                  />
                  {jsonError && <p className="text-xs text-amber-400 mt-1">{jsonError}</p>}
                </div>
                <div className="flex items-center gap-3">
                  <button onClick={handleJsonPaste} disabled={!jsonText.trim()} className="px-5 py-2.5 bg-violet-600 hover:bg-violet-500 disabled:opacity-50 rounded-lg text-sm font-medium">
                    解析并预览
                  </button>
                </div>
              </div>
            )}
          </motion.div>
        )}

        {/* Step 3: 预览 + 铸造 */}
        {selectedGame && draft && (
          <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
            <div className="flex items-center gap-2 mb-2">
              <button onClick={() => { setDraft(null); setPublishResult(null); }} className="text-sm text-slate-400 hover:text-white flex items-center gap-1">
                <ArrowLeft className="w-3.5 h-3.5" /> 返回修改
              </button>
              <span className="text-slate-600">/</span>
              <h2 className="font-semibold">预览与铸造</h2>
            </div>

            {/* 预览卡 */}
            <div className="bg-slate-900 rounded-2xl border border-slate-800 p-5">
              <div className="flex items-start justify-between gap-3 mb-4">
                <div>
                  <h3 className="text-lg font-bold">{draft.name || packName || '未命名内容'}</h3>
                  <p className="text-xs text-slate-400 mt-1">
                    type={draft.type || contentType} · slot={draft.slot} · {draft.description || '无描述'}
                  </p>
                </div>
                <span className="px-2.5 py-1 bg-violet-500/15 text-violet-300 border border-violet-500/30 rounded-full text-xs shrink-0">
                  {Array.isArray(draft.assets) ? draft.assets.length : 0} 个资产
                </span>
              </div>

              {/* data 预览 */}
              <div className="bg-slate-800 rounded-xl p-3 mb-3">
                <p className="text-xs text-slate-400 mb-1.5">data</p>
                <pre className="text-xs text-emerald-300 whitespace-pre-wrap break-all max-h-40 overflow-y-auto">
                  {JSON.stringify(draft.data, null, 2)}
                </pre>
              </div>

              {/* assets 预览 */}
              {Array.isArray(draft.assets) && draft.assets.length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-xs text-slate-400">assets</p>
                  {draft.assets.map(a => (
                    <div key={a.path} className="flex items-center justify-between bg-slate-800 rounded-lg px-3 py-1.5 text-xs">
                      <span className="flex items-center gap-2 text-slate-300">
                        <FileCode2 className="w-3.5 h-3.5 text-slate-500" />
                        {a.path}
                      </span>
                      <span className="text-slate-500">{(a.content || '').length} 字符</span>
                    </div>
                  ))}
                </div>
              )}

              {/* 校验结果 */}
              {issues.length > 0 && (
                <div className="mt-4 bg-amber-500/10 border border-amber-500/30 rounded-xl p-3">
                  <p className="text-xs text-amber-300 font-medium mb-1">校验提示（不阻断铸造）：</p>
                  {issues.map((iss, i) => (
                    <p key={i} className="text-xs text-amber-400/80">· {iss}</p>
                  ))}
                </div>
              )}
            </div>

            {/* 铸造参数 */}
            <div className="bg-slate-900 rounded-2xl border border-slate-800 p-5 space-y-4">
              <h3 className="font-semibold flex items-center gap-2">
                <Rocket className="w-4 h-4 text-violet-400" />
                铸造内容凭证（强制，1 张 = 1 次游戏会话）
              </h3>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs text-slate-400 mb-1.5">单价（A币）</label>
                  <input
                    type="number"
                    value={price}
                    onChange={e => setPrice(e.target.value === '' ? '' : Number(e.target.value))}
                    min={0}
                    className="w-full bg-slate-800 border border-slate-700 rounded-xl p-3 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs text-slate-400 mb-1.5">张数</label>
                  <input
                    type="number"
                    value={count}
                    onChange={e => setCount(Number(e.target.value) || 1)}
                    min={1}
                    className="w-full bg-slate-800 border border-slate-700 rounded-xl p-3 text-sm"
                  />
                </div>
              </div>
              <label className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer">
                <input type="checkbox" checked={listOnStore} onChange={e => setListOnStore(e.target.checked)} className="accent-violet-500" />
                <Store className="w-4 h-4 text-violet-400" />
                上架到商店（其他玩家可在该游戏商店「道具凭证」tab 购买，凭此内容包在游戏内使用）
              </label>
              <p className="text-xs text-slate-500 -mt-2">
                开启后：铸造的 {count} 张作为商店库存出售，同时免费赠送您 1 张自用（进入游戏即可体验）。
              </p>
              <label className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer">
                <input type="checkbox" checked={doRemix} onChange={e => setDoRemix(e.target.checked)} className="accent-violet-500" />
                <Layers className="w-4 h-4 text-violet-400" />
                同时上架 remix 版（提交审核，通过后出现在游戏「扩展」入口，?ext= 切换）
              </label>
              {publishResult && (
                <div className={`rounded-xl p-3 flex items-center gap-2 text-sm ${publishResult.success ? 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/30' : 'bg-red-500/10 text-red-300 border border-red-500/30'}`}>
                  {publishResult.success ? <CheckCircle className="w-4 h-4" /> : <AlertTriangle className="w-4 h-4" />}
                  {publishResult.message}
                </div>
              )}
              <div className="flex items-center gap-3">
                <button
                  onClick={handleMint}
                  disabled={publishing}
                  className="px-6 py-3 bg-violet-600 hover:bg-violet-500 disabled:opacity-50 rounded-xl font-medium flex items-center gap-2"
                >
                  {publishing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Coins className="w-4 h-4" />}
                  {publishing ? '铸造中...' : `铸造 ${count} 张内容凭证`}
                </button>
                {publishResult?.success && (
                  <button onClick={reset} className="px-4 py-2 bg-slate-800 hover:bg-slate-700 rounded-lg text-sm">
                    继续创作
                  </button>
                )}
              </div>
              <p className="text-xs text-slate-500">
                内容凭证铸造默认不做审核（持有者自担风险，可下架）；凭证可交易/转赠，在游戏内「使用内容凭证」后本次会话生效。
              </p>
            </div>
          </motion.div>
        )}
      </main>
    </div>
  );
};

export default ContentWorkshop;
