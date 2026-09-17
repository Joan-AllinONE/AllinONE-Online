import { useState } from 'react';
import { PublishingCenter as PublishingCenterUI } from '@/publishing-center/ui/PublishingCenter';
import { PublishingPipeline } from '@/publishing-center/core/PublishingPipeline';
import { StandardGameValidator } from '@/publishing-center/validator/StandardGameValidator';
import { GameCodeAnalyzer } from '@/publishing-center/ai/GameCodeAnalyzer';
import { SkillRecommender } from '@/publishing-center/ai/SkillRecommender';
import { savePublishedGame, getPublishedGame, refreshGameDetail, patchGameOnBackend } from '@/services/publishedGameService';
import { useAuth } from '@/contexts/authContext';
import { toast } from 'sonner';
import type { GameItemSop } from '@/services/publishedGameService';
import type { GameContentSop } from '@/types/quest';

export default function PublishingCenter() {
  const { currentUser } = useAuth();
  const [pipeline] = useState(() => new PublishingPipeline());
  const [validator] = useState(() => new StandardGameValidator());
  const [analyzer] = useState(() => new GameCodeAnalyzer());
  const [recommender] = useState(() => new SkillRecommender());

  const handlePublishComplete = async (result: { gameId: string; url: string; gameName?: string; framework?: string; skills?: string[]; entryPoint?: string; fileCount?: number; size?: number; itemSop?: GameItemSop; sopDocument?: string; contentSop?: GameContentSop; contentSopDocument?: string }) => {
    // 获取管线已保存的游戏记录（含 hostingType、baseUrl 等字段）
    // ⚠️ savePublishedGame() 末尾会 invalidateGamesCache()，而 dev 下 getPublishedGames() 只读
    // 内存缓存 → 同步读取大概率拿到 null。必须先异步从后端拉一次最新记录，
    // 否则 contentSop / itemSop 等配置字段会因为「跳过二次保存」而永远写不进去
    // （症状：发布时启用了内容创作，内容工坊里却看不到该游戏）。
    let existing = getPublishedGame(result.gameId);
    if (!existing) {
      existing = await refreshGameDetail(result.gameId).catch(() => null);
    }

    // 仍然读不到（后端不可用）时，绝不能用下面这个残缺对象去 upsert：
    // 该对象只列举了部分字段，缺少 coverImage / summary 等，
    // 一旦 upsert 就会把管线刚写入的封面、简介整个覆盖成空（刷新后封面消失）。
    // 改为「局部 PATCH」只补写配置字段，其余字段原样保留。
    if (!existing) {
      const patch: Record<string, any> = {};
      if (result.contentSop !== undefined) patch.contentSop = result.contentSop;
      if (result.contentSopDocument) patch.contentSopDocument = result.contentSopDocument;
      if (result.itemSop) patch.itemSop = result.itemSop;
      if (result.sopDocument) patch.sopDocument = result.sopDocument;
      if (Object.keys(patch).length) {
        const ok = await patchGameOnBackend(result.gameId, patch);
        console.warn(
          '[PublishingCenter] 未找到管线保存的游戏记录，已用局部 PATCH 补写配置字段:',
          result.gameId,
          ok ? '成功' : '失败'
        );
      }
      toast.success('游戏已提交审核！', {
        description: `游戏ID: ${result.gameId}\n访问地址: ${result.url}\n\n游戏已进入待审核状态，管理员审核通过后才会在游戏中心公开上架。`,
      });
      return;
    }

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
      contentSop: result.contentSop !== undefined ? result.contentSop : existing?.contentSop,
      contentSopDocument: result.contentSopDocument || existing?.contentSopDocument,
      // ⚠️ 封面与简介必须显式保留：这两个字段只由发布表单填写、管线写入，
      // 本对象不列举它们就会在 upsert 时被清空（历史 bug：刷新后游戏中心看不到封面）。
      coverImage: existing.coverImage,
      summary: existing.summary,
      // 保留管线设置的托管模式字段
      hostingType: existing?.hostingType,
      baseUrl: existing?.baseUrl,
      publisherId: existing?.publisherId,
      publisherName: existing?.publisherName,
      revenueSharePercent: existing?.revenueSharePercent,
      createdAt: existing?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // 审核机制：二次保存写回的缓存对象不带审核标记（reviewStatus 在后端由 __review 端点维护），
    // 与发布管线内的缓存刷新存在竞态——这里再补刷一次后端列表（已过滤未过审游戏），
    // 确保 pending 游戏不会残留在游戏中心。
    import('@/services/gameReviewService').then(({ refreshGamesCache }) => refreshGamesCache()).catch(() => {});

    toast.success('游戏已提交审核！', {
      description: `游戏ID: ${result.gameId}\n访问地址: ${result.url}\n\n游戏已进入待审核状态，管理员审核通过后才会在游戏中心公开上架。`,
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
