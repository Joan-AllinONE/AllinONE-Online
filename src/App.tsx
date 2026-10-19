import { Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider } from '@/contexts/authContext';
import VoteNotifications from '@/components/voucher-system/VoteNotifications';
import ErrorBoundary from '@/components/ErrorBoundary';

import GameBase from "@/pages/GameBase";
import Login from "@/pages/Login";
import Register from "@/pages/Register";
import GameCenter from "@/pages/GameCenter";
import GamePlay from "@/pages/GamePlay";
import GameStore from "@/pages/GameStore";
import PublishingCenter from "@/pages/PublishingCenter";
import VoucherSystemPage from "@/pages/VoucherSystemPage";
import ItemWorkshop from "@/pages/ItemWorkshop";
import ContentWorkshop from "@/pages/ContentWorkshop";
import PersonalCenter from "@/pages/PersonalCenter";
import Marketplace from "@/components/Marketplace";
import PlatformAdmin from "@/pages/PlatformAdmin";
import GameReviewAdmin from "@/pages/GameReviewAdmin";
import ContractCenter from "@/pages/ContractCenter";
import ContractWorkshop from "@/pages/ContractWorkshop";
import ContractAdmin from "@/pages/ContractAdmin";
import PlatformDataCenter from "@/pages/PlatformDataCenter";
import GameStoreManagement from "@/pages/GameStoreManagement";
import QuestPlaza from "@/pages/QuestPlaza";
import EventAdmin from "@/pages/EventAdmin";
import EventPage from "@/activity/events/EventPage";
import { ActivityCenter } from "@/activity";

export default function App() {
  return (
    <AuthProvider>
      <VoteNotifications />
      <ErrorBoundary>
      <Routes>
        <Route path="/" element={<GameBase />} />
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route path="/game-center" element={<GameCenter />} />
        <Route path="/game/:gameId" element={<GamePlay />} />
        <Route path="/game-store" element={<GameStore />} />
        <Route path="/game-store/:gameId" element={<GameStore />} />
        <Route path="/game-store-manage" element={<GameStoreManagement />} />
        <Route path="/marketplace" element={<Marketplace />} />
        <Route path="/platform-admin" element={<PlatformAdmin />} />
        <Route path="/game-review" element={<GameReviewAdmin />} />
        <Route path="/contracts" element={<ContractCenter />} />
        <Route path="/contract-workshop" element={<ContractWorkshop />} />
        <Route path="/contract-admin" element={<ContractAdmin />} />
        <Route path="/platform-data-center" element={<PlatformDataCenter />} />
        <Route path="/platform-store-manage" element={<Navigate to="/platform-admin?tab=store" replace />} />
        <Route path="/voucher-system" element={<VoucherSystemPage />} />
        <Route path="/workshop" element={<ItemWorkshop />} />
        <Route path="/content-workshop" element={<ContentWorkshop />} />
        <Route path="/publishing-center" element={<PublishingCenter />} />
        <Route path="/quests" element={<QuestPlaza />} />
        <Route path="/activity" element={<ActivityCenter />} />
        {/* 限时活动：EventPage 内部按后端信号动态 import 活动模块（独立 chunk） */}
        <Route path="/activity/event/:slug" element={<EventPage />} />
        <Route path="/event-admin" element={<EventAdmin />} />
        <Route path="/personal-center" element={<PersonalCenter />} />
        {/* 兜底路由：未匹配路径重定向首页，防白屏 */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      </ErrorBoundary>
    </AuthProvider>
  );
}
