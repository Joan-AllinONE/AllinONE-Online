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
import PersonalCenter from "@/pages/PersonalCenter";
import Marketplace from "@/components/Marketplace";
import PlatformAdmin from "@/pages/PlatformAdmin";
import GameStoreManagement from "@/pages/GameStoreManagement";

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
        <Route path="/platform-store-manage" element={<Navigate to="/platform-admin?tab=store" replace />} />
        <Route path="/voucher-system" element={<VoucherSystemPage />} />
        <Route path="/workshop" element={<ItemWorkshop />} />
        <Route path="/publishing-center" element={<PublishingCenter />} />
        <Route path="/personal-center" element={<PersonalCenter />} />
      </Routes>
    </AuthProvider>
  );
}
