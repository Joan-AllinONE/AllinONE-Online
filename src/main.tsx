import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { Toaster } from 'sonner';
import App from "./App.tsx";
import "./index.css";
import { initCloudBase } from "./services/cloudbase.ts";
import { initializeSkills } from "./skills/index.ts";
// 测试数据种子工具（自动填充 + 挂载到 window.__seedAll/__seedDiag）
import "./utils/seedTestData";
// 🆕 游戏商账户系统 + 每日结算
import { gameDeveloperService } from "./services/gameDeveloperService";
import { getPublishedGames } from "./services/publishedGameService";

// CloudBase 部署用 / ，GitHub Pages 用 /AllinONE-Gaming-Platform
const basename = import.meta.env.VITE_BASE_URL || '/';

// 初始化 CloudBase（不阻塞应用启动）
initCloudBase().catch((err) => {
  console.warn('CloudBase 初始化失败:', err.message);
});

// 初始化 Skill 引擎（异步不阻塞应用）
initializeSkills().catch((err) => {
  console.warn('Skills init failed:', err);
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

function initGameAccounts(): void {
  try {
    const publishedGames = getPublishedGames();
    for (const game of publishedGames) {
      gameDeveloperService.ensureAccount({
        gameId: game.id,
        gameName: game.name,
        publisherId: game.publisherId || 'admin',
        publisherName: game.publisherName || '平台管理员',
        revenueSharePercent: game.revenueSharePercent ?? 10,
      });
    }
    gameDeveloperService.checkAndSettle();
    console.log(`[Main] 游戏商账户系统已初始化，${publishedGames.length} 个游戏已兼容`);
  } catch (e) {
    console.warn('[Main] 游戏商账户初始化失败:', e);
  }
}
