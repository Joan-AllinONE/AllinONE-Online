import { useState } from 'react';
import { PublishingCenter as PublishingCenterUI } from '@/publishing-center/ui/PublishingCenter';
import { PublishingPipeline } from '@/publishing-center/core/PublishingPipeline';
import { StandardGameValidator } from '@/publishing-center/validator/StandardGameValidator';
import { GameCodeAnalyzer } from '@/publishing-center/ai/GameCodeAnalyzer';
import { SkillRecommender } from '@/publishing-center/ai/SkillRecommender';
import { savePublishedGame, getPublishedGame } from '@/services/publishedGameService';
import { useAuth } from '@/contexts/authContext';
import { toast } from 'sonner';
import type { GameItemSop } from '@/services/publishedGameService';

export default function PublishingCenter() {
  const { currentUser } = useAuth();
  const [pipeline] = useState(() => new PublishingPipeline());
  const [validator] = useState(() => new StandardGameValidator());
  const [analyzer] = useState(() => new GameCodeAnalyzer());
  const [recommender] = useState(() => new SkillRecommender());

  const handlePublishComplete = async (result: { gameId: string; url: string; gameName?: string; framework?: string; skills?: string[]; entryPoint?: string; fileCount?: number; size?: number; itemSop?: GameItemSop; sopDocument?: string }) => {
    // 获取管线已保存的游戏记录（含 hostingType、baseUrl 等字段）
    const existing = getPublishedGame(result.gameId);

    // 合并发布结果与管线已有数据，避免覆盖 hostingType/baseUrl
    await savePublishedGame({
      ...(existing || {}),
      id: result.gameId,
      name: result.gameName || existing?.name || '未命名游戏',
      description: existing?.description || `使用 ${result.framework || 'Unknown'} 框架开发的游戏`,
      framework: result.framework || existing?.framework || 'unknown',
      version: existing?.version || '1.0.0',
      icon: existing?.icon || 'fa-solid fa-gamepad',
      difficulty: existing?.difficulty || 'medium',
      rewards: existing?.rewards || {
        computingPower: 50,
        gameCoins: 50,
      },
      externalUrl: result.url,
      cdnUrl: existing?.cdnUrl,
      publishedAt: new Date().toISOString(),
      skills: result.skills || existing?.skills || [],
      skillConfigs: existing?.skillConfigs,
      entryPoint: existing?.entryPoint || result.entryPoint || 'index.html',
      fileCount: result.fileCount || existing?.fileCount || 0,
      size: result.size || existing?.size || 0,
      redeemItems: existing?.redeemItems,
      protocolMode: existing?.protocolMode,
      itemSop: result.itemSop || existing?.itemSop,
      sopDocument: result.sopDocument || existing?.sopDocument,
      // 保留管线设置的托管模式字段
      hostingType: existing?.hostingType,
      baseUrl: existing?.baseUrl,
      publisherId: existing?.publisherId,
      publisherName: existing?.publisherName,
      revenueSharePercent: existing?.revenueSharePercent,
      createdAt: existing?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    
    toast.success('游戏发布成功！', {
      description: `游戏ID: ${result.gameId}\n访问地址: ${result.url}\n\n您可以在游戏中心查看已发布的游戏。`,
    });
  };

  const handlePublishError = (error: string) => {
    toast.error('发布失败', {
      description: error,
    });
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900">
      <div className="container mx-auto px-4 py-8">
        <div className="mb-8 text-center">
          <h1 className="text-4xl font-bold text-white mb-4">
            <span className="bg-gradient-to-r from-cyan-400 via-purple-400 to-pink-400 bg-clip-text text-transparent">
              AI 驱动游戏发布中心
            </span>
          </h1>
          <p className="text-gray-400 text-lg">
            一键上传、智能分析、自动配置、快速发布
          </p>
        </div>

        <PublishingCenterUI
          pipeline={pipeline}
          validator={validator}
          analyzer={analyzer}
          recommender={recommender}
          currentUser={currentUser ? { id: currentUser.id, username: currentUser.username } : null}
          onPublishComplete={handlePublishComplete}
          onPublishError={handlePublishError}
        />
      </div>
    </div>
  );
}
