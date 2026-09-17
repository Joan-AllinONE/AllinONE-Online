/**
 * QuestPlaza - 任务广场
 *
 * 跨游戏浏览任务、领取、提交；开发者可发布任务、评审合并。
 * P1：社区投票审核、社区模组（落选产物转可订阅模组）、任务/模组双 Tab。
 */

import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { Plus, Target, Search, Boxes, PackagePlus } from 'lucide-react';
import type { GameQuest, QuestStatus, QuestType, QuestMod } from '@/types/quest';
import { questService } from '@/services/questService';
import { getCurrentUserId } from '@/services/authTokenService';
import QuestCard from '@/components/quest/QuestCard';
import QuestDetailModal from '@/components/quest/QuestDetailModal';
import QuestPublishGuide from '@/components/quest/QuestPublishGuide';

const STATUS_TABS: Array<{ key: '' | QuestStatus; label: string }> = [
  { key: '', label: '全部' },
  { key: 'open', label: '进行中' },
  { key: 'merged', label: '已完成' },
  { key: 'closed', label: '已关闭' },
];

const QUEST_TYPES: Array<{ key: QuestType; label: string }> = [
  { key: 'level', label: '关卡' },
  { key: 'item', label: '道具' },
  { key: 'skin', label: '皮肤' },
  { key: 'script', label: '脚本' },
  { key: 'audio', label: '音效' },
  { key: 'art', label: '美术' },
  { key: 'fix', label: '修复' },
];

export default function QuestPlaza() {
  const [mainTab, setMainTab] = useState<'quests' | 'mods'>('quests');
  const [quests, setQuests] = useState<GameQuest[]>([]);
  const [mods, setMods] = useState<QuestMod[]>([]);
  const [status, setStatus] = useState<'' | QuestStatus>('');
  const [mineOnly, setMineOnly] = useState(false);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<GameQuest | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  // 创建表单
  const [cGameId, setCGameId] = useState('');
  const [cGameName, setCGameName] = useState('');
  const [cTitle, setCTitle] = useState('');
  const [cDesc, setCDesc] = useState('');
  const [cType, setCType] = useState<QuestType>('level');
  const [cSlot, setCSlot] = useState('levels');
  const [cReviewMode, setCReviewMode] = useState<'developer' | 'community'>('developer');
  const [cReward, setCReward] = useState({ gameCoins: 100, aCoins: 0 });
  const [cMaxClaimers, setCMaxClaimers] = useState(3);
  const [createMsg, setCreateMsg] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    const list = await questService.listQuests(undefined, status || undefined);
    setQuests(list);
    setLoading(false);
  }, [status]);

  const loadMods = useCallback(async () => {
    const list = await questService.listMods();
    setMods(list);
  }, []);

  // 数据变更后刷新列表 + 同步刷新当前打开的任务（关闭/合并等操作后弹窗状态即时更新）
  const handleChanged = async () => {
    await load();
    if (selected) {
      const fresh = await questService.getQuest(selected.id);
      if (fresh) setSelected(fresh);
    }
  };

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (mainTab === 'mods') loadMods();
  }, [mainTab, loadMods]);

  const filtered = quests.filter((q) => {
    // 「我发布的」筛选
    if (mineOnly && q.createdBy !== getCurrentUserId()) return false;
    if (!search.trim()) return true;
    const s = search.toLowerCase();
    return (
      q.title.toLowerCase().includes(s) ||
      q.description.toLowerCase().includes(s) ||
      (q.gameName || '').toLowerCase().includes(s)
    );
  });

  const handleCreate = async () => {
    if (!cGameId || !cTitle) {
      setCreateMsg('请至少填写游戏 ID 和任务标题');
      return;
    }
    const quest: GameQuest = {
      id: `quest_${Date.now()}`,
      gameId: cGameId,
      gameName: cGameName,
      title: cTitle,
      description: cDesc,
      type: cType,
      reward: cReward,
      escrow: { source: 'platform', frozen: {}, status: 'frozen' },
      sourceSnapshot: { ref: '', license: 'open', allowedPaths: [] },
      acceptance: { maxFileSize: 512 * 1024, description: cDesc },
      contentSlot: cSlot,
      maxClaimers: cMaxClaimers,
      status: 'open',
      reviewMode: cReviewMode,
      voteThreshold: 3,
      createdBy: getCurrentUserId(),
      createdAt: Date.now(),
    };
    const r = await questService.createQuest(quest);
    if (r) {
      setCreateMsg('任务发布成功');
      setShowCreate(false);
      setCTitle('');
      setCDesc('');
      setCGameId('');
      await load();
    } else {
      setCreateMsg('发布失败，请检查是否已登录');
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-slate-100 dark:from-slate-900 dark:to-slate-800">
      {/* Header */}
      <header className="bg-white/90 dark:bg-slate-900/90 backdrop-blur-md shadow-sm">
        <div className="container mx-auto px-4 md:px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <Link to="/" className="flex items-center gap-2">
                <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-indigo-600 to-violet-600 flex items-center justify-center">
                  <Target className="w-5 h-5 text-white" />
                </div>
                <span className="text-xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-indigo-600 to-violet-600">
                  AllinONE
                </span>
              </Link>
              <div className="hidden md:block w-px h-6 bg-slate-300 dark:bg-slate-600"></div>
              <h1 className="hidden md:block text-lg font-semibold text-slate-700 dark:text-slate-200">任务广场</h1>
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={() => setShowCreate(true)}
                className="px-4 py-2 text-sm font-medium text-white bg-gradient-to-r from-indigo-600 to-violet-600 rounded-lg shadow-md hover:shadow-lg transition-all flex items-center gap-2"
              >
                <Plus className="w-4 h-4" />
                发布任务
              </button>
              <Link
                to="/game-center"
                className="px-4 py-2 text-sm font-medium text-slate-600 dark:text-slate-300 border border-slate-300 dark:border-slate-600 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
              >
                返回游戏中心
              </Link>
            </div>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 md:px-6 py-8">
        {/* 主 Tab 切换 */}
        <div className="flex gap-2 mb-6">
          <button
            onClick={() => setMainTab('quests')}
            className={`px-5 py-2.5 rounded-lg text-sm font-semibold flex items-center gap-2 transition-colors ${
              mainTab === 'quests'
                ? 'bg-indigo-600 text-white shadow-md'
                : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700'
            }`}
          >
            <Target className="w-4 h-4" /> 任务悬赏
          </button>
          <button
            onClick={() => setMainTab('mods')}
            className={`px-5 py-2.5 rounded-lg text-sm font-semibold flex items-center gap-2 transition-colors ${
              mainTab === 'mods'
                ? 'bg-fuchsia-600 text-white shadow-md'
                : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700'
            }`}
          >
            <Boxes className="w-4 h-4" /> 社区模组
          </button>
        </div>

        {mainTab === 'quests' ? (
          <>
            {/* 任务发布指南（三种扩展模式 + 常见问题） */}
            <QuestPublishGuide />
            {/* 筛选栏 */}
            <div className="flex flex-col md:flex-row md:items-center gap-4 mb-8">
              <div className="flex gap-2 flex-wrap">
                {STATUS_TABS.map((t) => (
                  <button
                    key={t.key}
                    onClick={() => setStatus(t.key)}
                    className={`px-4 py-2 rounded-full text-sm font-medium transition-colors ${
                      status === t.key
                        ? 'bg-indigo-600 text-white'
                        : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700'
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
                <button
                  onClick={() => setMineOnly((v) => !v)}
                  className={`px-4 py-2 rounded-full text-sm font-medium transition-colors ${
                    mineOnly
                      ? 'bg-violet-600 text-white'
                      : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700'
                  }`}
                >
                  {mineOnly ? '✓ 我发布的' : '我发布的'}
                </button>
              </div>
              <div className="relative md:ml-auto">
                <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="搜索任务..."
                  className="pl-9 pr-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 w-full md:w-64"
                />
              </div>
            </div>

            {/* 任务网格 */}
            {loading ? (
              <div className="text-center py-20 text-slate-400">加载中...</div>
            ) : filtered.length === 0 ? (
              <div className="text-center py-20 text-slate-400">
                <Target className="w-12 h-12 mx-auto mb-3 opacity-40" />
                <p>暂无任务，点击右上角「发布任务」发起第一个悬赏吧</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {filtered.map((q) => (
                  <QuestCard key={q.id} quest={q} onOpen={setSelected} onChanged={handleChanged} />
                ))}
              </div>
            )}
          </>
        ) : (
          /* 社区模组列表 */
          <div>
            {mods.length === 0 ? (
              <div className="text-center py-20 text-slate-400">
                <Boxes className="w-12 h-12 mx-auto mb-3 opacity-40" />
                <p>暂无社区模组，落选的任务提交可转为社区模组供大家订阅</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {mods.map((m, i) => (
                  <motion.div
                    key={m.id}
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: i * 0.05 }}
                    className="bg-white dark:bg-slate-800 rounded-xl shadow-md p-6"
                  >
                    <div className="flex items-start justify-between mb-3">
                      <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-fuchsia-500 to-pink-600 flex items-center justify-center text-white">
                        <PackagePlus className="w-6 h-6" />
                      </div>
                      <span className="text-xs text-slate-400">{m.subscribers ?? 0} 订阅</span>
                    </div>
                    <h3 className="text-lg font-bold text-slate-900 dark:text-white mb-1">{m.title}</h3>
                    <p className="text-xs text-slate-400 mb-2">
                      来自任务「{m.questTitle}」 · {m.authorName}
                    </p>
                    <p className="text-sm text-slate-600 dark:text-slate-300 mb-3 line-clamp-2">{m.description}</p>
                    <details className="text-sm">
                      <summary className="cursor-pointer text-xs text-slate-500 hover:text-slate-700">查看内容包</summary>
                      <pre className="mt-2 p-2 rounded-lg bg-slate-50 dark:bg-slate-800 text-xs overflow-auto max-h-32">
                        {JSON.stringify(m.contentPack, null, 2)}
                      </pre>
                    </details>
                  </motion.div>
                ))}
              </div>
            )}
          </div>
        )}
      </main>

      {/* 详情弹窗 */}
      <AnimatePresence>
        {selected && <QuestDetailModal quest={selected} onClose={() => setSelected(null)} onChanged={handleChanged} />}
      </AnimatePresence>

      {/* 创建任务弹窗 */}
      <AnimatePresence>
        {showCreate && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
            onClick={() => setShowCreate(false)}
          >
            <div
              className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto p-6"
              onClick={(e) => e.stopPropagation()}
            >
              <h2 className="text-lg font-bold text-slate-900 dark:text-white mb-4">发布新任务</h2>
              <div className="space-y-3">
                <div>
                  <label className="block text-xs text-slate-500 mb-1">游戏 ID *</label>
                  <input
                    value={cGameId}
                    onChange={(e) => setCGameId(e.target.value)}
                    placeholder="如 mario-game"
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs text-slate-500 mb-1">游戏名称</label>
                  <input
                    value={cGameName}
                    onChange={(e) => setCGameName(e.target.value)}
                    placeholder="如 超级马里奥"
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs text-slate-500 mb-1">任务标题 *</label>
                  <input
                    value={cTitle}
                    onChange={(e) => setCTitle(e.target.value)}
                    placeholder="如 制作第二关"
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs text-slate-500 mb-1">任务描述</label>
                  <textarea
                    value={cDesc}
                    onChange={(e) => setCDesc(e.target.value)}
                    rows={3}
                    placeholder="描述任务要求和验收标准"
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-sm"
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">任务类型</label>
                    <select
                      value={cType}
                      onChange={(e) => setCType(e.target.value as QuestType)}
                      className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-sm"
                    >
                      {QUEST_TYPES.map((t) => (
                        <option key={t.key} value={t.key}>
                          {t.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">挂载点 slot</label>
                    <input
                      value={cSlot}
                      onChange={(e) => setCSlot(e.target.value)}
                      placeholder="levels"
                      className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-sm"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-xs text-slate-500 mb-1">审核方式</label>
                  <select
                    value={cReviewMode}
                    onChange={(e) => setCReviewMode(e.target.value as 'developer' | 'community')}
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-sm"
                  >
                    <option value="developer">开发者直审</option>
                    <option value="community">社区投票（赞成票达标自动通过）</option>
                  </select>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">游戏币报酬</label>
                    <input
                      type="number"
                      value={cReward.gameCoins}
                      onChange={(e) => setCReward({ ...cReward, gameCoins: Number(e.target.value) || 0 })}
                      className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">A币报酬</label>
                    <input
                      type="number"
                      value={cReward.aCoins}
                      onChange={(e) => setCReward({ ...cReward, aCoins: Number(e.target.value) || 0 })}
                      className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-sm"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-xs text-slate-500 mb-1">领取人数上限（0=不限）</label>
                  <input
                    type="number"
                    value={cMaxClaimers}
                    onChange={(e) => setCMaxClaimers(Number(e.target.value) || 0)}
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-sm"
                  />
                </div>
                {createMsg && <p className="text-sm text-indigo-600">{createMsg}</p>}
                <div className="flex gap-2 pt-2">
                  <button
                    onClick={handleCreate}
                    className="flex-1 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg font-medium transition-colors"
                  >
                    发布
                  </button>
                  <button
                    onClick={() => setShowCreate(false)}
                    className="px-4 py-2.5 border border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-300 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
                  >
                    取消
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
