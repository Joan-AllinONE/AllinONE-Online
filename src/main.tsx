import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { Toaster } from 'sonner';
import App from "./App.tsx";
import "./index.css";
import { initCloudBase } from "./services/cloudbase.ts";
import { writeQueue } from "./services/writeQueue.ts";
import { initializeSkills } from "./skills/index.ts";
import { skillGateway } from "./skills/index.ts";
import { getToken } from "./services/authTokenService.ts";
import { installActivityModule } from "./activity/index.ts";
// 测试数据种子工具（自动填充 + 挂载到 window.__seedAll/__seedDiag）
import "./utils/seedTestData";
// 🆕 游戏商账户系统 + 每日结算
import { gameDeveloperService } from "./services/gameDeveloperService";
import { getPublishedGames } from "./services/publishedGameService";

// CloudBase 部署用 / ，GitHub Pages 用 /AllinONE-Gaming-Platform
const basename = import.meta.env.VITE_BASE_URL || '/';

// 🎯 同步安装活动中心模块：必须在 createRoot().render() 之前完成，
// 否则 ActivityCenter 挂载时 skill 未注册 → execute 返回 skillNotFound → 空白。
// 之前放在 initCloudBase 异步链末尾，createRoot().render() 同步先跑 → 竞态。
// installActivityModule 仅依赖 skillGateway（同步单例）+ getUserId/getUserName（读 localStorage），
// 无需等 CloudBase 就绪。
const getUserId = (): string | null => {
  try {
    const saved = localStorage.getItem('allinone_user');
    return saved ? (JSON.parse(saved).uid ?? null) : null;
  } catch {
    return null;
  }
};
const getUserName = (): string | undefined => {
  try {
    const saved = localStorage.getItem('allinone_user');
    return saved ? JSON.parse(saved).nickname : undefined;
  } catch {
    return undefined;
  }
};
installActivityModule({ gateway: skillGateway, getUserId, getUserName });
console.log('[Main] 活动中心模块已安装（同步）');

// 初始化 CloudBase → 启动写入队列 → 初始化 Skills
// 注意：writeQueue.startProcessor() 必须在 CloudBase 就绪后调用
initCloudBase()
  .then(() => {
    writeQueue.startProcessor();
    return initializeSkills();
  })
  .catch((err) => {
    console.warn('CloudBase 初始化失败，Skills 将以降级模式初始化:', err.message);
    // 即使 CloudBase 失败也启动队列（它会等待 CloudBase 恢复后重试）
    writeQueue.startProcessor();
    return initializeSkills();
  });

// 🧩 注册游戏文件 Service Worker：拦截 /api/* 实现后端代理 + 游戏文件离线回放
// 仅拦截本站同域 /api 请求，其他请求一律放行，不影响导航 / HMR
// 后端基地址来自 public/config.js 的 window.__API_BASE_URL（运行时可改，无需重构建）
async function syncApiConfigToSW() {
  const base =
    (window as any).__API_BASE_URL || (import.meta.env.VITE_API_BASE_URL as string | undefined) || '';
  if (!base) return;
  try {
    const cache = await caches.open('allinone-config');
    await cache.put(
      '/api-config',
      new Response(JSON.stringify({ apiBaseUrl: String(base).replace(/\/$/, '') })),
    );
    console.log('[SW] 已同步后端基地址配置:', String(base).replace(/\/$/, ''));
  } catch (e) {
    console.warn('[SW] 同步后端配置失败:', e);
  }
}

if ('serviceWorker' in navigator) {
  // 启动即同步配置（SW 激活前写入缓存，避免首屏 /api 请求错过代理）
  void syncApiConfigToSW();
  // 立即注册（不等待 load），配合 skipWaiting + clients.claim，
  // 让 SW 激活后尽快接管当前页面，缩小首屏 /api 请求命中静态托管 rewrite 的竞态窗口。
  navigator.serviceWorker
    .register('/gameFileServiceWorker-v9.js')
    .then((reg) => {
      console.log('[SW] 游戏文件 Service Worker 已注册:', reg.scope);
      void syncApiConfigToSW();
    })
    .catch((e) => console.warn('[SW] 注册失败（游戏文件离线回放不可用）:', e));
}

// S3-5 修复：先渲染 UI，后执行后台初始化（避免阻塞首屏）
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter basename={basename}>
      <App />
      <Toaster />
    </BrowserRouter>
  </StrictMode>
);

// 🔄 后台异步初始化（S3-5：不阻塞首屏渲染）
if (typeof requestIdleCallback !== 'undefined') {
  requestIdleCallback(() => initGameAccounts());
} else {
  setTimeout(() => initGameAccounts(), 0);
}

async function initGameAccounts(): Promise<void> {
  try {
    // 先获取 token，确保 API 调用能通过认证
    await getToken();

    const publishedGames = getPublishedGames();
    for (const game of publishedGames) {
      await gameDeveloperService.ensureAccount({
        gameId: game.id,
        gameName: game.name,
        publisherId: game.publisherId || 'admin',
        publisherName: game.publisherName || '平台管理员',
        revenueSharePercent: game.revenueSharePercent ?? 10,
      });
    }
    await gameDeveloperService.checkAndSettle();
    console.log(`[Main] 游戏商账户系统已初始化，${publishedGames.length} 个游戏已兼容`);
  } catch (e) {
    console.warn('[Main] 游戏商账户初始化失败:', e);
  }
}
