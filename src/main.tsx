import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { Toaster } from 'sonner';
import App from "./App.tsx";
import "./index.css";
import { initCloudBase } from "./services/cloudbase.ts";
import { writeQueue } from "./services/writeQueue.ts";
import { initializeSkills } from "./skills/index.ts";
import { getToken } from "./services/authTokenService.ts";
// 测试数据种子工具（自动填充 + 挂载到 window.__seedAll/__seedDiag）
import "./utils/seedTestData";
// 🆕 游戏商账户系统 + 每日结算
import { gameDeveloperService } from "./services/gameDeveloperService";
import { getPublishedGames } from "./services/publishedGameService";

// CloudBase 部署用 / ，GitHub Pages 用 /AllinONE-Gaming-Platform
const basename = import.meta.env.VITE_BASE_URL || '/';

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
