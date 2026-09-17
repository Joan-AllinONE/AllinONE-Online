import { Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider } from '@/contexts/authContext';
import VoteNotifications from '@/components/voucher-system/VoteNotifications';

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
import PlatformDataCenter from "@/pages/PlatformDataCenter";
import GameStoreManagement from "@/pages/GameStoreManagement";
import QuestPlaza from "@/pages/QuestPlaza";
import { ActivityCenter } from "@/activity";

export default function App() {
  return (
    <AuthProvider>
      <VoteNotifications />
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
        <Route path="/platform-data-center" element={<PlatformDataCenter />} />
        <Route path="/platform-store-manage" element={<Navigate to="/platform-admin?tab=store" replace />} />
        <Route path="/voucher-system" element={<VoucherSystemPage />} />
        <Route path="/workshop" element={<ItemWorkshop />} />
        <Route path="/content-workshop" element={<ContentWorkshop />} />
        <Route path="/publishing-center" element={<PublishingCenter />} />
        <Route path="/quests" element={<QuestPlaza />} />
        <Route path="/activity" element={<ActivityCenter />} />
        <Route path="/personal-center" element={<PersonalCenter />} />
      </Routes>
    </AuthProvider>
  );
}
