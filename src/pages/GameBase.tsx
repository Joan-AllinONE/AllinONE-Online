/**
 * GameBase - 游戏化首页（MVP v1.0）
 * 展示玩家的个人基地，包含建筑卡片、HUD状态栏、事件横幅和底部导航
 */
import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useAuth } from '@/contexts/authContext';
import { useWallet } from '@/hooks/useWallet';

// ==================== 内联组件 ====================

function HUD() {
  const { currentUser, isAuthenticated, logout } = useAuth();
  const { wallet } = useWallet();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // 点击外部关闭菜单
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    if (menuOpen) document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  return (
    <div className="relative flex items-center justify-between px-4 py-3 bg-slate-800/80 backdrop-blur border-b border-slate-700/50">
      <div className="flex items-center gap-5">
        <div className="flex items-center gap-1.5">
          <span className="text-lg">💰</span>
          <span className="font-bold text-yellow-300">{wallet?.gameCoins?.toLocaleString() || '0'}</span>
          <span className="text-xs text-slate-400">游戏币</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-lg">🎫</span>
          <span className="font-bold text-purple-400">{wallet?.voucherBalance?.toLocaleString() || '0'}</span>
          <span className="text-xs text-slate-400">A币</span>
        </div>
      </div>
      <div className="flex items-center gap-3 ml-auto" ref={menuRef}>
        {isAuthenticated ? (
          <>
            <span className="text-sm text-slate-300">{currentUser?.nickname || '冒险者'}</span>
            <button
              onClick={() => setMenuOpen(!menuOpen)}
              className="w-8 h-8 rounded-full bg-gradient-to-br from-purple-500 to-cyan-500 flex items-center justify-center text-white text-sm font-bold hover:ring-2 hover:ring-purple-400 transition-all"
            >
              {(currentUser?.nickname || 'A')[0].toUpperCase()}
            </button>
            {menuOpen && (
              <div className="absolute top-12 right-4 w-36 bg-slate-800 border border-slate-700 rounded-xl shadow-xl overflow-hidden z-50">
                <button
                  onClick={() => { setMenuOpen(false); navigate('/login'); }}
                  className="w-full px-4 py-2.5 text-sm text-slate-300 hover:bg-slate-700 text-left transition-colors"
                >
                  🔄 切换账号
                </button>
                <button
                  onClick={() => { setMenuOpen(false); logout(); }}
                  className="w-full px-4 py-2.5 text-sm text-red-400 hover:bg-slate-700 text-left transition-colors border-t border-slate-700"
                >
                  🚪 退出登录
                </button>
              </div>
            )}
          </>
        ) : (
          <button
            onClick={() => navigate('/login')}
            className="px-4 py-1.5 bg-purple-600 hover:bg-purple-500 rounded-full text-sm font-medium text-white transition-colors"
          >
            🔑 登录
          </button>
        )}
      </div>
    </div>
  );
}

function BuildingCard({ icon, label, description, badge, route }: {
  icon: string; label: string; description: string; badge?: number; route: string;
}) {
  const navigate = useNavigate();
  return (
    <motion.button
      whileHover={{ scale: 1.05, y: -6 }}
      whileTap={{ scale: 0.95 }}
      onClick={() => navigate(route)}
      className="relative flex flex-col items-center justify-center p-5 bg-slate-800/60 hover:bg-slate-700/60 rounded-2xl border border-slate-700/40 hover:border-purple-500/30 transition-all duration-200 min-h-[130px]"
    >
      <div className="text-4xl mb-2.5">{icon}</div>
      <div className="font-bold text-white text-sm">{label}</div>
      <div className="text-xs text-slate-400 mt-1">{description}</div>
      {badge && badge > 0 ? (
        <span className="absolute top-2.5 right-2.5 min-w-[22px] h-[22px] bg-red-500 rounded-full text-xs flex items-center justify-center text-white font-bold px-1.5">
          {badge > 99 ? '99+' : badge}
        </span>
      ) : null}
    </motion.button>
  );
}

function EventBanner() {
  const navigate = useNavigate();
  const events = [
    { id: '1', message: '🆕 欢迎来到 AllinONE 游戏平台！探索你的基地吧', action: null, timestamp: Date.now() },
    { id: '2', message: '💡 前往「凭证工坊」铸造你的第一张游戏凭证', action: { label: '去看看', route: '/voucher-system' }, timestamp: Date.now() },
    { id: '3', message: '🎮 进入「游戏世界」发现新游戏并获得奖励', action: { label: '探索', route: '/game-center' }, timestamp: Date.now() },
  ] as const;
  const [idx, setIdx] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setIdx(i => (i + 1) % events.length), 4000);
    return () => clearInterval(t);
  }, []);
  const ev = events[idx];
  return (
    <motion.div key={ev.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
      className="mx-5 mt-3 p-3.5 bg-gradient-to-r from-purple-900/30 to-cyan-900/20 rounded-xl border border-purple-500/20 flex items-center justify-between">
      <span className="text-sm text-slate-200">{ev.message}</span>
      {ev.action && <button onClick={() => navigate(ev.action!.route)} className="text-xs text-purple-400 hover:text-purple-300 whitespace-nowrap ml-3">{ev.action.label} →</button>}
    </motion.div>
  );
}

function BottomNav() {
  const navigate = useNavigate();
  const navs = [
    { icon: '🏰', label: '基地', route: '/' },
    { icon: '🏪', label: '市场', route: '/marketplace' },
    { icon: '🎒', label: '背包', route: '/personal-center' },
    { icon: '🗳️', label: '议事厅', route: '/voucher-system' },
    { icon: '🛒', label: '商店', route: '/game-store' },
  ];
  return (
    <div className="fixed bottom-0 left-0 right-0 flex justify-around items-center py-3 bg-slate-800/90 backdrop-blur border-t border-slate-700/50 z-50">
      {navs.map(n => (
        <button key={n.route} onClick={() => navigate(n.route)}
          className="flex flex-col items-center gap-0.5 text-slate-400 hover:text-purple-400 transition-colors">
          <span className="text-xl">{n.icon}</span>
          <span className="text-[10px]">{n.label}</span>
        </button>
      ))}
    </div>
  );
}

// ==================== 主组件 ====================

export default function GameBase() {
  const { currentUser } = useAuth();
  const isAdmin = currentUser?.role === 'admin' || currentUser?.role === 'platform';

  const buildings = [
    { icon: '🔨', label: '凭证工坊', description: '铸造与管理凭证', route: '/voucher-system' },
    { icon: '🏛️', label: '议事厅', description: '社区投票与治理', route: '/voucher-system' },
    { icon: '🛒', label: '游戏商店', description: '外部游戏道具与兑换码', route: '/game-store' },
    { icon: '🏪', label: '交易市场', description: '玩家P2P道具交易', route: '/marketplace' },
    { icon: '🎒', label: '背包', description: '查看我的凭证', route: '/personal-center' },
    { icon: '🎮', label: '游戏世界', description: '探索游戏', route: '/game-center' },
    ...(isAdmin ? [{ icon: '⚙️', label: '平台管理', description: '金库·商店·运营', route: '/platform-admin' }] : []),
  ];

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-900 via-slate-800 to-slate-900 text-white pb-20">
      <HUD />
      <div className="text-center py-6">
        <h1 className="text-2xl font-bold bg-gradient-to-r from-purple-400 to-cyan-400 bg-clip-text text-transparent">
          🏰 我的基地
        </h1>
        <p className="text-sm text-slate-400 mt-1">欢迎回来，冒险者</p>
      </div>
      <div className="grid grid-cols-3 gap-3 px-5">
        {buildings.map(b => (
          <BuildingCard key={b.label} {...b} />
        ))}
      </div>
      <EventBanner />
      <BottomNav />
    </div>
  );
}
