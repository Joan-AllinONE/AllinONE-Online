/**
 * TaskRewardsDrawer - 「我的任务报酬」抽屉
 *
 * 展示平台钱包的任务报酬汇总：
 * - 平台游戏币（users.gameCoins）
 * - A币凭证（vouchers，sourceType=instant，category=currency）
 *
 * 任务合并通过后，报酬由后端直接发放到平台钱包（users.gameCoins + vouchers），
 * 不再使用游戏内钱包 game_wallets。
 *
 * 入口在导航栏（GameBase HUD），明细在抽屉里。
 */
import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Eye, EyeOff, Gift, Coins, Cpu } from 'lucide-react';
import { loadFromBackend } from '@/services/backendSync';

function formatTs(ts: number | string | undefined): string {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return '';
  }
}

interface RewardRow {
  type: 'gameCoins' | 'aCoins';
  amount: number;
  reason?: string;
  timestamp?: number;
}

export function TaskRewardsDrawer({
  open,
  onClose,
  userId,
}: {
  open: boolean;
  onClose: () => void;
  userId: string;
}) {
  const [gameCoins, setGameCoins] = useState(0);
  const [aCoins, setACoins] = useState(0);
  const [history, setHistory] = useState<RewardRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [reveal, setReveal] = useState(false); // 隐私：默认隐藏数额

  useEffect(() => {
    if (!open || !userId) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      let gc = 0;
      let ac = 0;
      const rows: RewardRow[] = [];
      try {
        const users = await loadFromBackend<any>('users');
        const doc = users.find((u: any) => u && (u._openid === userId || u.id === userId));
        if (doc) {
          gc = Number(doc.gameCoins) || 0;
          for (const h of Array.isArray(doc._walletHistory) ? doc._walletHistory : []) {
            if (h && h.type === 'quest_reward') {
              rows.push({ type: 'gameCoins', amount: Number(h.amount) || 0, reason: h.reason, timestamp: h.timestamp });
            }
          }
        }
      } catch {
        /* 忽略读取失败 */
      }
      try {
        const vouchers = await loadFromBackend<any>('vouchers');
        for (const v of vouchers) {
          if (v && v.currentHolderId === userId && String(v.status).toLowerCase() === 'active') {
            const d = Number(v.denomination) || 0;
            ac += d;
            rows.push({ type: 'aCoins', amount: d, reason: v.metadata?.reason || v.metadata?.name, timestamp: v.createdAt });
          }
        }
      } catch {
        /* 忽略读取失败 */
      }
      rows.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
      if (!cancelled) {
        setGameCoins(gc);
        setACoins(ac);
        setHistory(rows);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, userId]);

  const totalRows = history.length;
  const hideValue = (v: number) => (reveal ? v.toLocaleString() : '••••');

  return (
    <AnimatePresence>
      {open && (
        <>
          {/* 背景遮罩 */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 0.5 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 bg-black z-[60]"
          />
          {/* 抽屉 */}
          <motion.div
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', damping: 25, stiffness: 300 }}
            className="fixed top-0 right-0 bottom-0 w-[85vw] max-w-[420px] bg-slate-900 border-l border-slate-700/50 z-[61] overflow-y-auto"
          >
            {/* 顶部 */}
            <div className="sticky top-0 bg-slate-900/95 backdrop-blur border-b border-slate-700/50 px-4 py-3 flex items-center justify-between">
              <h2 className="font-bold text-white text-lg flex items-center gap-2">
                <Gift className="w-5 h-5 text-purple-400" /> 我的任务报酬
              </h2>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setReveal((r) => !r)}
                  title={reveal ? '隐藏金额' : '显示金额'}
                  className="p-1.5 hover:bg-slate-700/50 rounded-lg text-slate-400 hover:text-white transition-colors"
                >
                  {reveal ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                </button>
                <button onClick={onClose} className="text-slate-400 hover:text-white text-xl transition-colors">
                  ✕
                </button>
              </div>
            </div>

            {loading ? (
              <div className="px-4 py-16 text-center text-slate-500 text-sm">加载中…</div>
            ) : gameCoins === 0 && aCoins === 0 && totalRows === 0 ? (
              <div className="px-4 py-16 text-center text-slate-500">
                <div className="text-4xl mb-3">🎁</div>
                <p className="font-medium text-slate-400">暂无任务报酬</p>
                <p className="text-xs mt-1">完成任务并审核合并后，报酬将自动到账到平台钱包</p>
              </div>
            ) : (
              <>
                {/* 余额汇总（默认隐藏，隐私） */}
                <div className="px-4 py-4">
                  <div className="p-4 bg-slate-800/60 rounded-2xl border border-slate-700/40">
                    <div className="flex items-center justify-between mb-3">
                      <span className="text-xs text-slate-400">平台钱包合计</span>
                      {!reveal && <span className="text-[10px] text-slate-500">点右上角眼睛查看金额</span>}
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="p-3 bg-slate-700/40 rounded-xl">
                        <div className="flex items-center gap-1 text-xs text-slate-400">
                          <Coins className="w-3.5 h-3.5 text-yellow-400" /> 游戏币
                        </div>
                        <div className={`text-lg font-bold text-yellow-300 mt-1`}>{hideValue(gameCoins)}</div>
                      </div>
                      <div className="p-3 bg-slate-700/40 rounded-xl">
                        <div className="flex items-center gap-1 text-xs text-slate-400">
                          <Cpu className="w-3.5 h-3.5 text-violet-400" /> A币
                        </div>
                        <div className={`text-lg font-bold text-violet-300 mt-1`}>{hideValue(aCoins)}</div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* 最近任务到账 */}
                {totalRows > 0 && (
                  <div className="px-4 pb-6">
                    <div className="text-sm font-medium text-slate-300 mb-2">最近任务到账</div>
                    <div className="space-y-2">
                      {history.slice(0, 10).map((t, i) => (
                        <div
                          key={i}
                          className="p-3 bg-slate-800/50 rounded-xl border border-slate-700/30 flex items-center justify-between"
                        >
                          <div className="flex-1 min-w-0">
                            <div className="text-white text-sm font-medium truncate">
                              {t.reason || (t.type === 'aCoins' ? 'A币奖励' : '游戏币奖励')}
                            </div>
                            <div className="text-[10px] text-slate-500 mt-0.5">
                              {t.type === 'aCoins' ? 'A币' : '游戏币'} · {formatTs(t.timestamp)}
                            </div>
                          </div>
                          <div
                            className={`${t.type === 'aCoins' ? 'text-violet-300' : 'text-yellow-300'} text-sm font-bold ml-3 shrink-0`}
                          >
                            {reveal ? `+${t.amount}` : '••'}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
