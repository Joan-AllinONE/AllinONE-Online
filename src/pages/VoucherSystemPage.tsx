import React, { useContext, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import {
  Shield, ArrowLeft, Package, Gamepad2, Warehouse, History, Settings
} from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';
import {
  VoucherManager, PlatformIntegrationTab,
  UserPoolManager, initializeVoucherEngine,
  platformBindingService,
} from '@/voucher-system';
import { VoucherManagementDashboard } from '@/voucher-system/components/VoucherManagementDashboard';
import { initializeDualVoucherSystem } from '@/voucher-system/init';
import { voucherPaymentService } from '@/services/voucherPaymentService';
import { AuthContext } from '@/contexts/authContext';
import ItemVoucherManager from '@/voucher-system/components/ItemVoucherManager';

/**
 * A币凭证系统主页面
 * 
 * 标签页设计对应完整的凭证生命周期：
 * 1. 发放来源 — 创建凭证/模板（即"铸造"）
 * 2. 奖池绑定 — 将来源绑定到游戏（即"接入"）
 * 3. 奖池管理 — 管理奖池余额/存入凭证（即"充值"）
 * 4. 发放记录 — 查看所有发放历史（即"审计"）
 * 5. 凭证管理 — 事后管理工具（批量操作/数据分析/快查）
 */
const VoucherSystemPage: React.FC = () => {
  const { currentUser } = useContext(AuthContext);
  const location = useLocation();
  const [activeTab, setActiveTab] = useState<'sources' | 'bindings' | 'pools' | 'records' | 'management' | 'item-vouchers'>('sources');

  // 从 URL 参数中读取初始 Tab 和 gameId
  const [initialGameId, setInitialGameId] = useState<string | undefined>(undefined);
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const tabParam = params.get('tab');
    const gameIdParam = params.get('gameId');
    if (tabParam === 'item-vouchers') {
      setActiveTab('item-vouchers');
    }
    if (gameIdParam) {
      setInitialGameId(gameIdParam);
    }
  }, [location.search]);

  // 获取当前用户信息 - 从 auth context 或 allinone_user 获取
  const getStableUserId = () => {
    try {
      const userStr = localStorage.getItem('allinone_user');
      if (userStr) {
        const user = JSON.parse(userStr);
        return user.uid || user.id || 'guest-' + Date.now();
      }
    } catch { /* ignore */ }
    return 'guest-' + Date.now();
  };

  const currentUserId = currentUser?.id || getStableUserId();
  const currentUsername = currentUser?.username || '访客用户';

  // 初始化凭证规则引擎和双轨凭证系统
  useEffect(() => {
    const cleanup = initializeVoucherEngine();
    console.log('[VoucherSystemPage] 凭证规则引擎已初始化');
    
    // 初始化双轨凭证系统，启用模拟数据模式
    initializeDualVoucherSystem({
      enableAlgorithmVouchers: true,
      enableAutoSettlement: true,
      dataCollectorConfig: {
        useMockData: true,
        mockUserCount: 50,
        cacheDuration: 60000,
        cashToACoinRate: 0.001,
      },
    }).then(result => {
      console.log('[VoucherSystemPage] 双轨凭证系统初始化结果:', result);
      // 初始化平台凭证库存（标准化面额）
      try {
        voucherPaymentService.initializePlatformPool();
      } catch (error) {
        console.warn('[VoucherSystemPage] 初始化平台库存失败:', error);
      }
    });
    
    return cleanup;
  }, []);

  const tabs = [
    { key: 'sources' as const, label: '发放来源', icon: Package, desc: '创建凭证/模板' },
    { key: 'pools' as const, label: '奖池管理', icon: Warehouse, desc: '管理奖池余额' },
    { key: 'bindings' as const, label: '游戏绑定', icon: Gamepad2, desc: '绑定到游戏' },
    { key: 'records' as const, label: '发放记录', icon: History, desc: '发放历史' },
    { key: 'management' as const, label: '凭证管理', icon: Settings, desc: '事后管理工具' },
    { key: 'item-vouchers' as const, label: '道具凭证', icon: Package, desc: '游戏道具凭证管理' },
  ];

  return (
    <div className="min-h-screen bg-slate-950">
      {/* 页面头部 */}
      <motion.header
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        className="bg-slate-900/80 backdrop-blur-xl border-b border-white/10 sticky top-0 z-40"
      >
        <div className="max-w-7xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link
              to="/"
              className="flex items-center gap-2 text-slate-400 hover:text-white transition-colors"
            >
              <ArrowLeft className="w-5 h-5" />
              <span>返回首页</span>
            </Link>
            <div className="h-6 w-px bg-white/10" />
            <div className="flex items-center gap-2">
              <Shield className="w-6 h-6 text-blue-400" />
              <h1 className="text-xl font-bold text-white">A币凭证系统</h1>
            </div>
          </div>

          {/* 标签切换 */}
          <div className="flex bg-slate-800/50 rounded-xl p-1 border border-white/10">
            {tabs.map((tab, index) => {
              const Icon = tab.icon;
              const colorMap: Record<string, string> = {
                sources: 'bg-blue-600',
                bindings: 'bg-green-600',
                pools: 'bg-purple-600',
                records: 'bg-amber-600',
                'item-vouchers': 'bg-pink-600',
              };
              return (
                <button
                  key={tab.key}
                  onClick={() => setActiveTab(tab.key)}
                  className={`flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-all ${
                    activeTab === tab.key
                      ? `${colorMap[tab.key]} text-white`
                      : 'text-slate-400 hover:text-white hover:bg-white/5'
                  }`}
                  title={tab.desc}
                >
                  <Icon className="w-4 h-4" />
                  <span className="hidden sm:inline">{tab.label}</span>
                </button>
              );
            })}
          </div>

          {/* 用户信息 */}
          <div className="flex items-center gap-3">
            <div className="text-right hidden sm:block">
              <p className="text-sm text-white font-medium">{currentUsername}</p>
              <p className="text-xs text-slate-400 font-mono">{currentUserId}</p>
            </div>
            <div className="w-10 h-10 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center">
              <span className="text-white font-bold">
                {currentUsername.charAt(0).toUpperCase()}
              </span>
            </div>
          </div>
        </div>
      </motion.header>

      {/* 流程引导条 */}
      <div className="max-w-7xl mx-auto px-6 pt-4">
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <span className={activeTab === 'sources' ? 'text-blue-400 font-medium' : ''}>创建凭证</span>
          <span>→</span>
          <span className={activeTab === 'pools' ? 'text-purple-400 font-medium' : ''}>充入奖池</span>
          <span>→</span>
          <span className={activeTab === 'bindings' ? 'text-green-400 font-medium' : ''}>绑定游戏</span>
          <span>→</span>
          <span className={activeTab === 'records' ? 'text-amber-400 font-medium' : ''}>发放生效</span>
          <span>→</span>
          <span className={activeTab === 'management' ? 'text-rose-400 font-medium' : ''}>事后管理</span>
        </div>
      </div>

      {/* 主内容区 */}
      <div className="max-w-7xl mx-auto p-6">
        {activeTab === 'sources' ? (
          <VoucherManager
            currentUserId={currentUserId}
            currentUsername={currentUsername}
            onNavigateToPools={() => setActiveTab('pools')}
          />
        ) : activeTab === 'bindings' ? (
          <PlatformIntegrationTab
            currentUserId={currentUserId}
            currentUsername={currentUsername}
          />
        ) : activeTab === 'pools' ? (
          <UserPoolManager
            currentUserId={currentUserId}
            currentUsername={currentUsername}
          />
        ) : activeTab === 'records' ? (
          <RewardRecordsView currentUserId={currentUserId} currentUsername={currentUsername} />
        ) : activeTab === 'item-vouchers' ? (
          <ItemVoucherManager
            currentUserId={currentUserId}
            currentUsername={currentUsername}
            initialGameId={initialGameId}
          />
        ) : (
          <VoucherManagementDashboard
            currentUserId={currentUserId}
            currentUsername={currentUsername}
          />
        )}
      </div>
    </div>
  );
};

/** 发放记录视图 — 独立组件，展示所有类型的发放历史 */
const RewardRecordsView: React.FC<{ currentUserId: string; currentUsername: string }> = () => {
  const [records, setRecords] = useState<any[]>([]);

  useEffect(() => {
    const allRecords = platformBindingService.getAllRewardRecords();
    setRecords(allRecords);
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-white flex items-center gap-2">
          <History className="w-6 h-6 text-amber-400" />
          发放记录
        </h2>
        <p className="text-slate-400 text-sm mt-1">所有游戏的凭证发放历史</p>
      </div>

      {records.length === 0 ? (
        <div className="text-center py-16 bg-slate-800/30 rounded-xl border border-white/10 border-dashed">
          <History className="w-16 h-16 text-slate-600 mx-auto mb-4" />
          <h3 className="text-lg font-medium text-slate-400">暂无发放记录</h3>
          <p className="text-slate-500 text-sm mt-1">
            当玩家通过游戏获得凭证奖励时，记录将在这里显示
          </p>
        </div>
      ) : (
        <div className="bg-slate-800/30 rounded-2xl border border-white/10 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-white/10 text-left">
                  <th className="px-4 py-3 text-xs font-medium text-slate-400">时间</th>
                  <th className="px-4 py-3 text-xs font-medium text-slate-400">游戏</th>
                  <th className="px-4 py-3 text-xs font-medium text-slate-400">用户</th>
                  <th className="px-4 py-3 text-xs font-medium text-slate-400">金额</th>
                  <th className="px-4 py-3 text-xs font-medium text-slate-400">来源</th>
                </tr>
              </thead>
              <tbody>
                {records.slice(0, 50).map((record: any) => (
                  <tr key={record.id} className="border-b border-white/5 hover:bg-white/5">
                    <td className="px-4 py-3 text-sm text-slate-300">
                      {new Date(record.timestamp).toLocaleString('zh-CN')}
                    </td>
                    <td className="px-4 py-3 text-sm text-white">{record.gameId}</td>
                    <td className="px-4 py-3 text-sm text-slate-300">{record.userName}</td>
                    <td className="px-4 py-3 text-sm text-amber-400 font-medium">{record.amount} A币</td>
                    <td className="px-4 py-3 text-xs">
                      <span className={`px-2 py-0.5 rounded ${
                        record.source === 'pool_transfer' ? 'bg-blue-500/20 text-blue-400' :
                        record.source === 'user_pool_transfer' ? 'bg-purple-500/20 text-purple-400' :
                        'bg-green-500/20 text-green-400'
                      }`}>
                        {record.source === 'pool_transfer' ? '平台池' :
                         record.source === 'user_pool_transfer' ? '用户池' : '新建'}
                      </span>
                      {record.poolName && (
                        <span className="text-slate-500 ml-1">{record.poolName}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {records.length > 50 && (
            <div className="p-3 text-center text-xs text-slate-500">
              显示前 50 条，共 {records.length} 条记录
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default VoucherSystemPage;
