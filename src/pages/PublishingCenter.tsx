import { useState, useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { PublishingCenter as PublishingCenterUI } from '@/publishing-center/ui/PublishingCenter';
import { PublishingPipeline } from '@/publishing-center/core/PublishingPipeline';
import { StandardGameValidator } from '@/publishing-center/validator/StandardGameValidator';
import { GameCodeAnalyzer } from '@/publishing-center/ai/GameCodeAnalyzer';
import { SkillRecommender } from '@/publishing-center/ai/SkillRecommender';
import { savePublishedGame, getPublishedGame } from '@/services/publishedGameService';
import { useAuth } from '@/contexts/authContext';
import { toast } from 'sonner';
import type { GameItemSop } from '@/services/publishedGameService';
import { Wand2, Sparkles, ArrowRight, CheckCircle } from 'lucide-react';

export default function PublishingCenter() {
  const location = useLocation();
  const { currentUser } = useAuth();
  const [pipeline] = useState(() => new PublishingPipeline());
  const [validator] = useState(() => new StandardGameValidator());
  const [analyzer] = useState(() => new GameCodeAnalyzer());
  const [recommender] = useState(() => new SkillRecommender());
  
  // 接收从 Skill Wizard 传来的文件
  const [preloadedFiles, setPreloadedFiles] = useState<File[] | null>(null);
  const [fromSkillWizard, setFromSkillWizard] = useState(false);
  
  useEffect(() => {
    const state = location.state as { 
      fromSkillWizard?: boolean; 
      files?: File[];
      skillConfig?: any;
    } | null;
    
    if (state?.fromSkillWizard && state?.files) {
      setPreloadedFiles(state.files);
      setFromSkillWizard(true);
      toast.success('已从 Skill Wizard 导入项目和代码', {
        description: '生成代码已注入到项目中，点击开始AI分析继续发布',
      });
    }
  }, [location.state]);

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

        {/* Skill Wizard 入口提示 或 已导入状态 */}
        <div className="max-w-4xl mx-auto mb-8">
          {fromSkillWizard ? (
            <div className="bg-gradient-to-r from-green-500/20 via-cyan-500/20 to-blue-500/20 rounded-2xl p-6 border border-green-500/30">
              <div className="flex flex-col md:flex-row items-center justify-between gap-4">
                <div className="flex items-center gap-4">
                  <div className="w-14 h-14 rounded-xl bg-gradient-to-br from-green-500 to-cyan-500 flex items-center justify-center shadow-lg shadow-green-500/25">
                    <CheckCircle className="w-7 h-7 text-white" />
                  </div>
                  <div>
                    <h3 className="text-lg font-semibold text-white flex items-center gap-2">
                      <Sparkles className="w-4 h-4 text-yellow-400" />
                      已从 Skill Wizard 导入
                    </h3>
                    <p className="text-gray-400 text-sm mt-1">
                      项目和自定义 Skills 代码已就绪，点击下方开始 AI 分析
                    </p>
                  </div>
                </div>
                {preloadedFiles && (
                  <div className="text-sm text-cyan-400">
                    {preloadedFiles.length} 个文件已准备
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="bg-gradient-to-r from-indigo-500/20 via-purple-500/20 to-pink-500/20 rounded-2xl p-6 border border-indigo-500/30">
              <div className="flex flex-col md:flex-row items-center justify-between gap-4">
                <div className="flex items-center gap-4">
                  <div className="w-14 h-14 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-500 flex items-center justify-center shadow-lg shadow-indigo-500/25">
                    <Wand2 className="w-7 h-7 text-white" />
                  </div>
                  <div>
                    <h3 className="text-lg font-semibold text-white flex items-center gap-2">
                      <Sparkles className="w-4 h-4 text-yellow-400" />
                      想要自定义 Skill 配置？
                    </h3>
                    <p className="text-gray-400 text-sm mt-1">
                      使用 Skill 配置向导可视化配置游戏功能，一键生成 TypeScript 代码
                    </p>
                  </div>
                </div>
                <Link
                  to="/skill-wizard"
                  className="group flex items-center gap-2 px-6 py-3 bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white rounded-xl font-medium transition-all shadow-lg shadow-indigo-500/25 hover:shadow-indigo-500/40 whitespace-nowrap"
                >
                  打开 Skill 向导
                  <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
                </Link>
              </div>
            </div>
          )}
        </div>

        <PublishingCenterUI
          pipeline={pipeline}
          validator={validator}
          analyzer={analyzer}
          recommender={recommender}
          currentUser={currentUser ? { id: currentUser.id, username: currentUser.username } : null}
          onPublishComplete={handlePublishComplete}
          onPublishError={handlePublishError}
          preloadedFiles={preloadedFiles}
        />
      </div>
    </div>
  );
}
