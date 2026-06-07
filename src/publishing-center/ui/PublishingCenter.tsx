/**
 * AllinONE AI驱动发布中心
 * 
 * 四步可视化发布界面：
 * 1. 上传游戏包
 * 2. AI智能分析
 * 3. Skills配置
 * 4. 一键发布
 */

import React, { useState, useCallback, useRef, useEffect } from 'react';
import { 
  Upload, FileCode, Cpu, Rocket, CheckCircle, 
  AlertCircle, Loader2, ChevronRight, ChevronLeft,
  Package, Settings, BarChart3, Zap, Shield, 
  Gamepad2, Coins, ShoppingCart, Trophy, Users,
  Cloud, Globe, Bell, Languages, Sparkles, X, Wand2,
  Ticket, Plus, Trash2, ExternalLink,
  BookOpen, HelpCircle, ChevronDown, Info
} from 'lucide-react';
import { Link } from 'react-router-dom';
import JSZip from 'jszip';
import { 
  GameAnalysisResult, 
  RecommendationResult, 
  SkillRecommendation,
  PublishStep,
  PublishStatus,
  PublishPipelineState,
  GameType,
  StandardGameConfig,
  GameFramework,
  GameGenre,
  PublishingConfig,
  UploadedFile,
} from '../types';
import { GameCodeAnalyzer } from '../ai/GameCodeAnalyzer';
import { SkillRecommender } from '../ai/SkillRecommender';
import { PublishingPipeline } from '../core/PublishingPipeline';
import { StandardGameValidator } from '../validator/StandardGameValidator';
// 使用 Vite ?raw 导入 Mode B 示例模板的原始 HTML 内容
import modeBTemplateHtml from '../templates/mode-b-example/index.html?raw';
import { HostedItem, ItemType, CreateHostedItemRequest } from '@/types/redeemCode';
import { ItemSupplyPolicy } from '@/voucher-system';
import { redeemCodeService } from '@/services/redeemCodeService';
import { voucherItemService } from '@/services/voucherItemService';
import { effectTypeRegistry, type EffectTypeDefinition, type EffectParameter } from '../effects/EffectTypeRegistry';

// ==================== 步骤定义 ====================

interface StepInfo {
  id: PublishStep;
  title: string;
  description: string;
  icon: React.ReactNode;
}

const STEPS: StepInfo[] = [
  {
    id: PublishStep.UPLOAD,
    title: '上传游戏',
    description: '上传游戏代码包',
    icon: <Upload className="w-5 h-5" />,
  },
  {
    id: PublishStep.ANALYZE,
    title: 'AI分析',
    description: '智能分析游戏',
    icon: <Cpu className="w-5 h-5" />,
  },
  {
    id: PublishStep.CONFIGURE,
    title: '配置Skills',
    description: '选择所需能力',
    icon: <Settings className="w-5 h-5" />,
  },
  {
    id: PublishStep.PUBLISH,
    title: '发布上线',
    description: '一键发布游戏',
    icon: <Rocket className="w-5 h-5" />,
  },
];

// ==================== 组件 Props ====================

interface PublishingCenterProps {
  pipeline: PublishingPipeline;
  validator: StandardGameValidator;
  analyzer: GameCodeAnalyzer;
  recommender: SkillRecommender;
  /** 当前用户信息（用于记录发布者） */
  currentUser?: { id: string; username: string } | null;
  onPublishComplete?: (result: { 
    gameId: string; 
    url: string; 
    gameName?: string;
    framework?: string;
    skills?: string[];
    entryPoint?: string;
    fileCount?: number;
    size?: number;
  }) => void;
  onPublishError?: (error: string) => void;
  preloadedFiles?: File[] | null;
}

// ==================== UI 组件 ====================

const Button: React.FC<React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'outline' | 'ghost' }> = ({ 
  children, variant = 'primary', className = '', ...props 
}) => {
  const baseStyles = 'px-4 py-2 rounded-lg font-medium transition-all duration-200 flex items-center gap-2';
  const variants = {
    primary: 'bg-gradient-to-r from-cyan-500 to-blue-500 text-white hover:from-cyan-600 hover:to-blue-600 shadow-lg shadow-cyan-500/25',
    secondary: 'bg-gradient-to-r from-purple-500 to-pink-500 text-white hover:from-purple-600 hover:to-pink-600 shadow-lg shadow-purple-500/25',
    outline: 'border-2 border-cyan-500/50 text-cyan-400 hover:bg-cyan-500/10',
    ghost: 'text-gray-400 hover:text-white hover:bg-white/5',
  };
  return (
    <button className={`${baseStyles} ${variants[variant]} ${className}`} {...props}>
      {children}
    </button>
  );
};

const Card: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className = '' }) => (
  <div className={`bg-slate-800/50 backdrop-blur-xl border border-slate-700/50 rounded-xl ${className}`}>
    {children}
  </div>
);

const CardHeader: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className = '' }) => (
  <div className={`p-6 border-b border-slate-700/50 ${className}`}>
    {children}
  </div>
);

const CardTitle: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className = '' }) => (
  <h3 className={`text-xl font-bold text-white ${className}`}>
    {children}
  </h3>
);

const CardDescription: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className = '' }) => (
  <p className={`text-gray-400 mt-1 ${className}`}>
    {children}
  </p>
);

const CardContent: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className = '' }) => (
  <div className={`p-6 ${className}`}>
    {children}
  </div>
);

const Badge: React.FC<{ children: React.ReactNode; variant?: 'default' | 'success' | 'warning' | 'error' }> = ({ 
  children, variant = 'default' 
}) => {
  const variants = {
    default: 'bg-slate-700 text-gray-300',
    success: 'bg-green-500/20 text-green-400 border border-green-500/30',
    warning: 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/30',
    error: 'bg-red-500/20 text-red-400 border border-red-500/30',
  };
  return (
    <span className={`px-2 py-1 rounded-md text-xs font-medium ${variants[variant]}`}>
      {children}
    </span>
  );
};

const Progress: React.FC<{ value: number; className?: string }> = ({ value, className = '' }) => (
  <div className={`w-full h-2 bg-slate-700 rounded-full overflow-hidden ${className}`}>
    <div 
      className="h-full bg-gradient-to-r from-cyan-500 to-purple-500 transition-all duration-300"
      style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
    />
  </div>
);

const Alert: React.FC<{ children: React.ReactNode; variant?: 'info' | 'success' | 'warning' | 'error' }> = ({ 
  children, variant = 'info' 
}) => {
  const variants = {
    info: 'bg-blue-500/10 border-blue-500/30 text-blue-400',
    success: 'bg-green-500/10 border-green-500/30 text-green-400',
    warning: 'bg-yellow-500/10 border-yellow-500/30 text-yellow-400',
    error: 'bg-red-500/10 border-red-500/30 text-red-400',
  };
  return (
    <div className={`p-4 rounded-lg border ${variants[variant]}`}>
      {children}
    </div>
  );
};

// ==================== 主组件 ====================

export const PublishingCenter: React.FC<PublishingCenterProps> = ({
  pipeline,
  validator,
  analyzer,
  recommender,
  currentUser,
  onPublishComplete,
  onPublishError,
  preloadedFiles,
}) => {
  // 状态管理
  const [currentStep, setCurrentStep] = useState<PublishStep>(PublishStep.UPLOAD);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isPublishing, setIsPublishing] = useState(false);
  const [uploadedFiles, setUploadedFiles] = useState<File[]>([]);
  const [extractedFiles, setExtractedFiles] = useState<UploadedFile[]>([]);
  const [analysisResult, setAnalysisResult] = useState<GameAnalysisResult | null>(null);
  const [recommendations, setRecommendations] = useState<RecommendationResult | null>(null);
  const [selectedSkills, setSelectedSkills] = useState<Set<string>>(new Set());
  const [pipelineState, setPipelineState] = useState<PublishPipelineState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  
  // 兑换码配置状态
  const [redeemItems, setRedeemItems] = useState<CreateHostedItemRequest[]>([]);
  const [showRedeemForm, setShowRedeemForm] = useState(false);
  const [activeConfigTab, setActiveConfigTab] = useState<'skills' | 'redeem'>('skills');
  const [protocolMode, setProtocolMode] = useState<'inject' | 'integrated'>('inject');
  const [selectedEffectType, setSelectedEffectType] = useState<string>('difficulty_reducer');
  // Fix 1 & 2: Mode B 警告对话框状态
  const [showModeBWarning, setShowModeBWarning] = useState(false);
  const [detectedUsesSDK, setDetectedUsesSDK] = useState(false);
  const [isLoadingTemplate, setIsLoadingTemplate] = useState(false);
  // 发布指南
  const [showGuide, setShowGuide] = useState(false);
  const [guideTab, setGuideTab] = useState<'overview' | 'modes' | 'items' | 'case' | 'faq'>('overview');
  
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 使用预加载的文件
  useEffect(() => {
    if (preloadedFiles && preloadedFiles.length > 0) {
      setUploadedFiles(preloadedFiles);
    }
  }, [preloadedFiles]);

  // 监听流水线状态
  useEffect(() => {
    const unsubscribe = pipeline.subscribe(setPipelineState);
    return () => unsubscribe();
  }, [pipeline]);

  // 文件上传处理
  const handleDrag = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true);
    } else if (e.type === 'dragleave') {
      setDragActive(false);
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      const files = Array.from(e.dataTransfer.files);
      setUploadedFiles(files);
    }
  }, []);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const files = Array.from(e.target.files);
      setUploadedFiles(files);
    }
  }, []);

  // 解压ZIP文件
  const extractZipFiles = async (file: File): Promise<UploadedFile[]> => {
    console.log('[ZIP] 开始解压文件:', file.name);
    const zip = await JSZip.loadAsync(file);
    const extractedFiles: UploadedFile[] = [];
    
    for (const [path, zipEntry] of Object.entries(zip.files)) {
      // 跳过目录和隐藏文件
      if (zipEntry.dir || path.startsWith('__MACOSX') || path.startsWith('.')) continue;
      
      const content = await zipEntry.async('uint8array');
      console.log('[ZIP] 提取文件:', path, '大小:', zipEntry.size);
      extractedFiles.push({
        name: path.split('/').pop() || path,
        path: path,
        size: zipEntry.size,
        type: '',
        content: content,
      });
    }
    
    console.log('[ZIP] 解压完成，共', extractedFiles.length, '个文件');
    return extractedFiles;
  };

  // AI分析
  const handleAnalyze = useCallback(async () => {
    if (uploadedFiles.length === 0) return;
    
    setIsAnalyzing(true);
    setError(null);
    
    try {
      // 处理文件：如果是ZIP则解压，否则直接读取
      let uploadedFileObjects: UploadedFile[] = [];
      
      for (const file of uploadedFiles) {
        if (file.name.toLowerCase().endsWith('.zip')) {
          // 解压ZIP文件
          const extractedFiles = await extractZipFiles(file);
          uploadedFileObjects.push(...extractedFiles);
        } else {
          // 普通文件直接读取
          uploadedFileObjects.push({
            name: file.name,
            path: file.name,
            size: file.size,
            type: file.type,
            content: await file.text(),
          });
        }
      }
      
      if (uploadedFileObjects.length === 0) {
        throw new Error('ZIP 文件为空或没有可识别的文件');
      }
      
      // 保存解压后的文件供发布使用
      setExtractedFiles(uploadedFileObjects);
      
      // 执行AI分析
      const analysis = await analyzer.analyze(uploadedFileObjects);
      setAnalysisResult(analysis);
      
      // 获取推荐
      const recs = await recommender.recommend(analysis);
      setRecommendations(recs);
      
      // 自动选择推荐的skills
      const autoSelected = new Set<string>();
      recs.recommendations
        .filter(r => r.autoEnable)
        .forEach(r => autoSelected.add(r.skillId));
      setSelectedSkills(autoSelected);

      // 自动检测协议模式
      try {
        const quickCheck = await validator.quickCheck(uploadedFileObjects);
        const usesSDK = quickCheck.usesStandardSDK;
        setDetectedUsesSDK(usesSDK);
        if (usesSDK) {
          setProtocolMode('integrated');
          console.log('[PublishingCenter] 检测到 @allinone/standard-sdk, 自动选择 Mode B (集成模式)');
        } else {
          setProtocolMode('inject');
        }
      } catch {
        setDetectedUsesSDK(false);
        setProtocolMode('inject');
      }
      
      setCurrentStep(PublishStep.CONFIGURE);
    } catch (err) {
      setError(err instanceof Error ? err.message : '分析失败');
      onPublishError?.(err instanceof Error ? err.message : '分析失败');
    } finally {
      setIsAnalyzing(false);
    }
  }, [uploadedFiles, analyzer, recommender, onPublishError]);

  // 添加道具凭证
  const handleAddRedeemItem = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    
    // 同时支持旧兑换码和新道具凭证
    const rarity = formData.get('rarity') as string || 'common';
    const supplyPolicy = formData.get('supplyPolicy') as string || 'open';
    const newRedeemItem: CreateHostedItemRequest = {
      gameId: 'temp-game-id',
      name: formData.get('name') as string,
      description: formData.get('description') as string,
      type: formData.get('type') as ItemType,
      codeConfig: {
        prefix: formData.get('prefix') as string,
        length: parseInt(formData.get('length') as string) || 8,
        charset: formData.get('charset') as any,
        caseSensitive: formData.get('caseSensitive') === 'on',
        expireDays: parseInt(formData.get('expireDays') as string) || 0,
        singleUse: true,
      },
      initialInventory: parseInt(formData.get('initialInventory') as string) || 100,
      pricing: {
        price: parseFloat(formData.get('price') as string) || 10,
        currency: 'ACOIN',
      },
      gameEffect: {
        itemId: formData.get('gameItemId') as string,
        quantity: parseInt(formData.get('gameQuantity') as string) || 1,
        effectType: formData.get('effectType') as string || 'difficulty_reducer',
        metadata: { 
          rarity, 
          supplyPolicy,
          effectType: formData.get('effectType') as string || 'difficulty_reducer',
          // 合并效果参数
          ...Object.fromEntries(
            effectTypeRegistry.get(formData.get('effectType') as string || 'difficulty_reducer')?.parameters.map(p => {
              const val = formData.get(`effect_param_${p.key}`);
              if (val === null || val === undefined) return [p.key, p.defaultValue];
              return [p.key, p.type === 'number' ? parseFloat(val as string) || p.defaultValue : val];
            }) || []
          ),
        },
      },
    };
    
    setRedeemItems([...redeemItems, newRedeemItem]);
    setShowRedeemForm(false);
  };

  // 删除兑换码道具
  const handleRemoveRedeemItem = (index: number) => {
    setRedeemItems(redeemItems.filter((_, i) => i !== index));
  };

  // Fix 2: 使用 Mode B 模板创建新游戏
  const handleUseModeBTemplate = useCallback(async () => {
    setShowModeBWarning(false);
    setIsLoadingTemplate(true);
    setError(null);

    try {
      // 使用 JSZip 将模板打包为 ZIP
      const zip = new JSZip();
      zip.file('index.html', modeBTemplateHtml);
      const blob = await zip.generateAsync({ type: 'blob' });
      const file = new File([blob], 'mode-b-template.zip', { type: 'application/zip' });

      // 解压模板文件
      const extractedFiles = await extractZipFiles(file);
      setUploadedFiles([file]);
      setExtractedFiles(extractedFiles);

      // 执行 AI 分析
      setIsAnalyzing(true);
      const analysis = await analyzer.analyze(extractedFiles);
      setAnalysisResult(analysis);

      const recs = await recommender.recommend(analysis);
      setRecommendations(recs);

      // 自动选择推荐的 skills
      const autoSelected = new Set<string>();
      recs.recommendations
        .filter(r => r.autoEnable)
        .forEach(r => autoSelected.add(r.skillId));
      setSelectedSkills(autoSelected);

      // 强制设为 Mode B（模板自带 SDK）
      setProtocolMode('integrated');
      setDetectedUsesSDK(true);

      setCurrentStep(PublishStep.CONFIGURE);
      setIsAnalyzing(false);
      setIsLoadingTemplate(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : '模板加载失败');
      setIsAnalyzing(false);
      setIsLoadingTemplate(false);
    }
  }, [analyzer, recommender, onPublishError]);

  // 在 handlePublish 里通过外部表单提取 rarity
  // 临时存储为 gameEffect.metadata
  // 发布时从第一个道具的 gameEffect.metadata 中获取

  // 发布
  const handlePublish = useCallback(async () => {
    if (!analysisResult) return;
    
    setIsPublishing(true);
    setError(null);
    
    try {
      // 从分析结果中提取信息（兼容不同结构）
      const gameName = (analysisResult as any).detectedInfo?.projectName 
        || (analysisResult as any).gameName 
        || (uploadedFiles[0]?.name?.replace(/\.zip$/i, '') || '未命名游戏');
      const framework = (analysisResult as any).detectedInfo?.framework 
        || analysisResult.framework?.framework 
        || 'unknown';
      const version = (analysisResult as any).detectedInfo?.version 
        || analysisResult.framework?.version 
        || '1.0.0';
      
      const gameId = `game-${Date.now()}`;
      
      const config: StandardGameConfig = {
        gameId,
        gameName,
        framework,
        version,
        skills: Array.from(selectedSkills),
        autoGenerated: true,
      };
      
      // 构建 PublishingConfig
      const publishConfig: any = {
        gameId: config.gameId,
        gameType: GameType.STANDARD,
        publisherId: currentUser?.id,
        publisherName: currentUser?.username || currentUser?.nickname,
        protocolMode: protocolMode,
        analysisResult: analysisResult,
        skillRecommendations: recommendations?.recommendations.map(id => ({
          skillId: id,
          skillName: id,
          confidence: 80,
          reason: 'AI推荐',
        })) || [],
        standardConfig: config,
        files: extractedFiles.length > 0 ? extractedFiles : undefined,
        redeemItems: redeemItems.map(item => ({
          name: item.name,
          description: item.description,
          gameItemId: item.gameEffect.itemId,
          effectType: item.gameEffect.effectType || (item.gameEffect.metadata?.effectType as string) || 'custom',
          effects: item.gameEffect.metadata || {},
          quantity: item.gameEffect.quantity,
          price: item.pricing.price,
          currency: item.pricing.currency || 'ACOIN',
          rarity: (item.gameEffect.metadata?.rarity as string) || 'common',
        })),
      };
      
      const result = await pipeline.publish(publishConfig);
      
      if (result.success) {
        // 创建兑换码道具（旧系统，向后兼容）
        if (redeemItems.length > 0) {
          for (const item of redeemItems) {
            await redeemCodeService.createHostedItem({
              ...item,
              gameId,
            });

            // 同步创建道具凭证模板（新系统），让"道具凭证"页面也能看到
            try {
              voucherItemService.createItemTemplate({
                gameId,
                name: item.name,
                description: item.description || '',
                itemType: item.type === ItemType.PERMANENT ? 'permanent' : 'consumable',
                rarity: (item.gameEffect.metadata?.rarity as string) || 'common',
                pricing: {
                  price: item.pricing.price,
                  currency: item.pricing.currency || 'ACOIN',
                },
                effect: {
                  type: item.gameEffect.effectType || (item.gameEffect.metadata?.effectType as string) || 'custom',
                  itemId: item.gameEffect.itemId || '',
                  quantity: item.gameEffect.quantity || 1,
                  metadata: item.gameEffect.metadata || {},
                },
                supplyPolicy: (item.gameEffect.metadata?.supplyPolicy as ItemSupplyPolicy) || ItemSupplyPolicy.OPEN,
                imageUrl: '',
                isActive: true,
              });
            } catch (e) {
              console.warn('[PublishingCenter] 同步道具凭证模板失败（不影响发布）:', e);
            }
          }
        }

        // 提示用户：道具已同步至两套系统
        console.log('[PublishingCenter] 发布成功! 道具数据已同步至「兑换码管理」和「道具凭证」系统');
        
        setCurrentStep(PublishStep.PUBLISH);
        onPublishComplete?.({ 
          gameId: config.gameId, 
          url: result.url!,
          gameName: config.gameName,
          framework: config.framework,
          skills: Array.from(selectedSkills),
          entryPoint: analysisResult?.fileStructure?.entryPoints?.[0],
          fileCount: extractedFiles.length,
          size: extractedFiles.reduce((sum, f) => sum + (f.size || 0), 0),
        });
      } else {
        throw new Error(result.error);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '发布失败');
      onPublishError?.(err instanceof Error ? err.message : '发布失败');
    } finally {
      setIsPublishing(false);
    }
  }, [analysisResult, selectedSkills, uploadedFiles, pipeline, onPublishComplete, onPublishError, redeemItems]);

  // 渲染步骤指示器
  const renderStepIndicator = () => (
    <div className="flex items-center justify-center mb-8">
      <div className="flex items-center gap-4">
        {STEPS.map((step, index) => {
          const isActive = step.id === currentStep;
          const isCompleted = STEPS.findIndex(s => s.id === currentStep) > index;
          
          return (
            <React.Fragment key={step.id}>
              <div className={`flex items-center gap-3 px-4 py-3 rounded-xl transition-all duration-300 ${
                isActive 
                  ? 'bg-gradient-to-r from-cyan-500/20 to-purple-500/20 border border-cyan-500/50 shadow-lg shadow-cyan-500/10' 
                  : isCompleted
                    ? 'bg-green-500/10 border border-green-500/30'
                    : 'bg-slate-800/50 border border-slate-700/50'
              }`}>
                <div className={`p-2 rounded-lg ${
                  isActive 
                    ? 'bg-gradient-to-r from-cyan-500 to-purple-500' 
                    : isCompleted
                      ? 'bg-green-500'
                      : 'bg-slate-700'
                }`}>
                  {React.cloneElement(step.icon as React.ReactElement, { 
                    className: 'w-4 h-4 text-white' 
                  })}
                </div>
                <div>
                  <p className={`text-sm font-semibold ${
                    isActive ? 'text-white' : isCompleted ? 'text-green-400' : 'text-gray-500'
                  }`}>
                    {step.title}
                  </p>
                  <p className="text-xs text-gray-500">{step.description}</p>
                </div>
              </div>
              {index < STEPS.length - 1 && (
                <ChevronRight className="w-5 h-5 text-gray-600" />
              )}
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );

  // 渲染上传步骤
  const renderUploadStep = () => (
    <Card className="max-w-2xl mx-auto">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Package className="w-6 h-6 text-cyan-400" />
          上传游戏代码包
        </CardTitle>
        <CardDescription>
          支持 ZIP 格式的游戏代码包，AI 将自动分析并推荐合适的 Skills
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div
          className={`border-2 border-dashed rounded-xl p-12 text-center transition-all duration-300 ${
            dragActive 
              ? 'border-cyan-500 bg-cyan-500/10' 
              : 'border-slate-600 hover:border-slate-500'
          }`}
          onDragEnter={handleDrag}
          onDragLeave={handleDrag}
          onDragOver={handleDrag}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept=".zip"
            multiple
            onChange={handleFileSelect}
            className="hidden"
          />
          <Upload className="w-16 h-16 mx-auto mb-4 text-gray-500" />
          <p className="text-lg text-white mb-2">
            拖拽文件到此处或点击上传
          </p>
          <p className="text-sm text-gray-500">
            支持 ZIP 格式，最大 100MB
          </p>
        </div>
        
        {uploadedFiles.length > 0 && (
          <div className="mt-6 space-y-2">
            <p className="text-sm text-gray-400 mb-2">已选择文件：</p>
            {uploadedFiles.map((file, index) => (
              <div key={index} className="flex items-center justify-between p-3 bg-slate-700/50 rounded-lg">
                <div className="flex items-center gap-3">
                  <FileCode className="w-5 h-5 text-cyan-400" />
                  <span className="text-white">{file.name}</span>
                  <span className="text-xs text-gray-500">
                    ({(file.size / 1024 / 1024).toFixed(2)} MB)
                  </span>
                </div>
                <button
                  onClick={() => setUploadedFiles(prev => prev.filter((_, i) => i !== index))}
                  className="p-1 hover:bg-red-500/20 rounded text-gray-400 hover:text-red-400 transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        )}
        
        {uploadedFiles.length > 0 && (
          <div className="mt-6 flex justify-end">
            <Button onClick={handleAnalyze} disabled={isAnalyzing}>
              {isAnalyzing ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  AI分析中...
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4" />
                  开始AI分析
                </>
              )}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );

  // 渲染分析结果
  const renderAnalysisResult = () => {
    if (!analysisResult) return null;
    
    // 获取检测到的功能特征
    const detectedFeatures = analysisResult.features
      .filter(f => f.detected)
      .map(f => f.feature);
    
    return (
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <BarChart3 className="w-6 h-6 text-purple-400" />
            AI 分析结果
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4 mb-6">
            <div className="p-4 bg-slate-700/30 rounded-lg">
              <p className="text-sm text-gray-400 mb-1">检测框架</p>
              <p className="text-lg font-semibold text-white">
                {analysisResult.framework.framework}
              </p>
              <p className="text-xs text-gray-500">
                置信度: {analysisResult.framework.confidence}%
              </p>
            </div>
            <div className="p-4 bg-slate-700/30 rounded-lg">
              <p className="text-sm text-gray-400 mb-1">检测到的功能</p>
              <p className="text-lg font-semibold text-white">
                {detectedFeatures.length} 个
              </p>
            </div>
            <div className="p-4 bg-slate-700/30 rounded-lg">
              <p className="text-sm text-gray-400 mb-1">项目版本</p>
              <p className="text-lg font-semibold text-white">
                {analysisResult.framework.version || '未检测到'}
              </p>
            </div>
            <div className="p-4 bg-slate-700/30 rounded-lg">
              <p className="text-sm text-gray-400 mb-1">代码质量</p>
              <p className="text-lg font-semibold text-white">
                {analysisResult.codeMetrics.quality.score}/100
              </p>
            </div>
          </div>
          
          <div className="space-y-3">
            <p className="text-sm text-gray-400">检测到的功能特征：</p>
            <div className="flex flex-wrap gap-2">
              {detectedFeatures.length > 0 ? (
                detectedFeatures.map((feature, index) => (
                  <Badge key={index} variant="default">
                    {feature}
                  </Badge>
                ))
              ) : (
                <span className="text-gray-500">未检测到特定功能</span>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    );
  };

  // 渲染Skills推荐
  const renderSkillRecommendations = () => {
    if (!recommendations) return null;
    
    const skillIcons: Record<string, React.ReactNode> = {
      auth: <Users className="w-5 h-5" />,
      wallet: <Coins className="w-5 h-5" />,
      inventory: <Package className="w-5 h-5" />,
      store: <ShoppingCart className="w-5 h-5" />,
      leaderboard: <Trophy className="w-5 h-5" />,
      achievements: <Zap className="w-5 h-5" />,
      cloudsave: <Cloud className="w-5 h-5" />,
      analytics: <BarChart3 className="w-5 h-5" />,
    };
    
    return (
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Settings className="w-6 h-6 text-cyan-400" />
                配置游戏能力
              </CardTitle>
              <CardDescription>
                选择 Skills 并配置兑换码道具，完成后一键发布
              </CardDescription>
            </div>
            <Link
              to="/skill-wizard"
              className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-indigo-500 to-purple-500 hover:from-indigo-600 hover:to-purple-600 text-white rounded-lg font-medium transition-all shadow-lg shadow-indigo-500/25"
            >
              <Wand2 className="w-4 h-4" />
              高级配置
            </Link>
          </div>
        </CardHeader>
        <CardContent>
          {/* 协议模式选择 */}
          <div className="mb-6 p-4 bg-slate-700/20 rounded-lg border border-slate-600/50">
            <div className="flex items-start justify-between">
              <div>
                <h4 className="font-medium text-white flex items-center gap-2">
                  <Wand2 className="w-4 h-4 text-purple-400" />
                  集成方式
                </h4>
                <p className="text-xs text-gray-400 mt-1">
                  Mode A: 无需游戏修改，自动注入效果引擎（默认）
                  <br />
                  Mode B: 游戏已集成 @allinone/standard-sdk，使用轻量协议通信
                </p>
              </div>
              <div className="flex items-center gap-2 bg-slate-800 rounded-lg p-1">
                <button
                  onClick={() => setProtocolMode('inject')}
                  className={`px-3 py-1.5 rounded-md text-sm font-medium transition-all ${
                    protocolMode === 'inject'
                      ? 'bg-purple-500 text-white shadow-sm'
                      : 'text-gray-400 hover:text-white'
                  }`}
                >
                  Mode A (注入)
                </button>
                <button
                  onClick={() => {
                    if (!detectedUsesSDK) {
                      setShowModeBWarning(true);
                    } else {
                      setProtocolMode('integrated');
                    }
                  }}
                  className={`px-3 py-1.5 rounded-md text-sm font-medium transition-all ${
                    protocolMode === 'integrated'
                      ? 'bg-cyan-500 text-white shadow-sm'
                      : 'text-gray-400 hover:text-white'
                  }`}
                >
                  Mode B (集成)
                </button>
              </div>
            </div>
            {protocolMode === 'integrated' && (
              <div className="mt-3 p-2 bg-cyan-500/10 border border-cyan-500/20 rounded text-xs text-cyan-300">
                ⚡ Mode B: 游戏需已集成 @allinone/standard-sdk，协议通信更可靠，支持 Schema 扩展
              </div>
            )}
            {protocolMode === 'inject' && (
              <div className="mt-3 p-2 bg-purple-500/10 border border-purple-500/20 rounded text-xs text-purple-300">
                🔧 Mode A: 自动注入 Effect Engine，游戏无需任何修改即享道具效果
              </div>
            )}
          </div>

          {/* 标签页切换 */}
          <div className="flex items-center gap-2 mb-6 p-1 bg-slate-700/30 rounded-lg">
            <button
              onClick={() => setActiveConfigTab('skills')}
              className={`flex items-center gap-2 px-4 py-2 rounded-md font-medium transition-all ${
                activeConfigTab === 'skills'
                  ? 'bg-cyan-500 text-white'
                  : 'text-gray-400 hover:text-white'
              }`}
            >
              <Zap className="w-4 h-4" />
              Skills 配置
              {selectedSkills.size > 0 && (
                <span className="px-1.5 py-0.5 bg-white/20 rounded-full text-xs">
                  {selectedSkills.size}
                </span>
              )}
            </button>
            <button
              onClick={() => setActiveConfigTab('redeem')}
              className={`flex items-center gap-2 px-4 py-2 rounded-md font-medium transition-all ${
                activeConfigTab === 'redeem'
                  ? 'bg-purple-500 text-white'
                  : 'text-gray-400 hover:text-white'
              }`}
            >
              <Ticket className="w-4 h-4" />
              兑换道具
              {redeemItems.length > 0 && (
                <span className="px-1.5 py-0.5 bg-white/20 rounded-full text-xs">
                  {redeemItems.length}
                </span>
              )}
            </button>
          </div>
          
          {/* Skills 配置标签页 */}
          {activeConfigTab === 'skills' && (
            <div className="space-y-3">
              {recommendations.recommendations.map((rec) => (
                <div
                  key={rec.skillId}
                  className={`p-4 rounded-lg border transition-all cursor-pointer ${
                    selectedSkills.has(rec.skillId)
                      ? 'bg-cyan-500/10 border-cyan-500/50'
                      : 'bg-slate-700/30 border-slate-700 hover:border-slate-600'
                  }`}
                  onClick={() => {
                    setSelectedSkills(prev => {
                      const next = new Set(prev);
                      if (next.has(rec.skillId)) {
                        next.delete(rec.skillId);
                      } else {
                        next.add(rec.skillId);
                      }
                      return next;
                    });
                  }}
                >
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-3">
                      <div className={`p-2 rounded-lg ${
                        selectedSkills.has(rec.skillId) 
                          ? 'bg-cyan-500 text-white' 
                          : 'bg-slate-600 text-gray-400'
                      }`}>
                        {skillIcons[rec.skillId] || <Zap className="w-5 h-5" />}
                      </div>
                      <div>
                        <p className="font-semibold text-white">{rec.skillName}</p>
                        <p className="text-sm text-gray-400">{rec.reason}</p>
                      </div>
                    </div>
                    <div className="text-right">
                      <Badge variant={rec.matchScore > 0.8 ? 'success' : rec.matchScore > 0.5 ? 'warning' : 'default'}>
                        {(rec.matchScore * 100).toFixed(0)}% 匹配
                      </Badge>
                      {rec.autoEnable && (
                        <Badge variant="success" className="ml-2">自动启用</Badge>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
          
          {/* 兑换道具标签页 */}
          {activeConfigTab === 'redeem' && (
            <div className="space-y-4">
              {/* 功能介绍 */}
              <div className="p-4 bg-gradient-to-r from-purple-500/10 to-cyan-500/10 border border-purple-500/20 rounded-lg">
                <div className="flex items-start gap-3">
                  <div className="p-2 bg-purple-500/20 rounded-lg">
                    <Wand2 className="w-5 h-5 text-purple-400" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-white">游戏内兑换条自动注入</p>
                    <p className="text-xs text-gray-400 mt-1">
                      发布后系统将自动在游戏 HTML 中注入 <strong>AllinONE SDK</strong>，游戏中将出现一个兑换按钮
                      <span className="inline-block px-1 py-0.5 bg-slate-700 rounded text-xs mx-1">🎁</span>。
                      玩家购买道具后获得兑换码，在游戏中输入即可激活道具，实现道具系统与游戏的深度融合。
                    </p>
                  </div>
                </div>
              </div>

              {/* 道具列表 */}
              {redeemItems.length === 0 ? (
                <div className="text-center py-12 bg-slate-700/20 rounded-xl border border-dashed border-slate-600">
                  <Ticket className="w-12 h-12 mx-auto mb-3 text-slate-500" />
                  <p className="text-gray-400 mb-2">还没有配置道具</p>
                  <p className="text-sm text-gray-500 mb-4">
                    配置道具后，系统将在游戏内自动注入兑换条。玩家购买道具获得兑换码，在游戏中输入即可激活道具效果。
                  </p>
                  <Button onClick={() => setShowRedeemForm(true)}>
                    <Plus className="w-4 h-4" />
                    添加第一个道具
                  </Button>
                </div>
              ) : (
                <>
                  <div className="flex items-center justify-between">
                    <p className="text-sm text-gray-400">
                      已配置 {redeemItems.length} 个道具，发布后将自动注入兑换条，并在商店展示
                    </p>
                    <Button onClick={() => setShowRedeemForm(true)} size="sm">
                      <Plus className="w-4 h-4" />
                      添加道具
                    </Button>
                  </div>
                  
                  <div className="space-y-2">
                    {redeemItems.map((item, index) => {
                      const r = item.gameEffect.metadata?.rarity as string || 'common';
                      return (
                        <div
                          key={index}
                          className="p-4 bg-slate-700/30 rounded-lg border border-slate-700"
                        >
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-3">
                              <div className={`w-10 h-10 rounded-lg flex items-center justify-center text-white font-bold ${
                                r === 'legendary' ? 'bg-gradient-to-br from-orange-500 to-red-500' :
                                r === 'rare' ? 'bg-gradient-to-br from-purple-500 to-pink-500' :
                                r === 'uncommon' ? 'bg-gradient-to-br from-blue-500 to-cyan-500' :
                                'bg-gradient-to-br from-purple-500 to-pink-500'
                              }`}>
                                {item.name.charAt(0)}
                              </div>
                              <div>
                                <p className="font-medium text-white">{item.name}</p>
                                <p className="text-sm text-gray-400">{item.description}</p>
                                <div className="flex items-center gap-3 mt-1 text-xs text-gray-500">
                                  <span>{item.pricing.price} ACOIN</span>
                                  <span>·</span>
                                  <span>总量: {item.initialInventory}</span>
                                  <span>·</span>
                                  <span>{r}</span>
                                  <span>·</span>
                                  <span>游戏ID: {item.gameEffect.itemId}</span>
                                </div>
                              </div>
                            </div>
                            <button
                              onClick={() => handleRemoveRedeemItem(index)}
                              className="p-2 hover:bg-red-500/20 rounded-lg text-gray-400 hover:text-red-400 transition-colors"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
              
              {/* 游戏方接入说明 */}
              <div className="p-4 bg-cyan-500/10 border border-cyan-500/20 rounded-lg">
                <div className="flex items-start gap-3">
                  <ExternalLink className="w-5 h-5 text-cyan-400 mt-0.5" />
                  <div>
                    <p className="text-sm font-medium text-cyan-400">🎮 游戏方接入指南</p>
                    <p className="text-xs text-gray-400 mt-1">
                      你的游戏无需任何修改即可支持道具兑换！系统已自动注入兑换条 UI。
                      <br />
                      如果想在游戏代码中自定义响应，可监听 <code className="px-1 py-0.5 bg-slate-700 rounded">AllinONE.onItemRedeemed()</code> 事件：
                    </p>
                    <pre className="mt-2 p-2 bg-slate-900 rounded-lg text-xs text-gray-400 overflow-x-auto">
{`// 示例: 监听道具兑换事件
AllinONE.onItemRedeemed(function(data) {
  if (data.itemId === 'difficulty_reducer') {
    game.difficulty -= 0.3; // 降低难度
  } else if (data.itemId === 'speed_boost') {
    game.speed *= 1.5;      // 加速
  }
  console.log('道具已激活:', data.itemName);
});`}
                    </pre>
                    <p className="text-xs text-gray-500 mt-2">
                      <strong>道具兑换码</strong> 和 <strong>凭证系统</strong> 已自动同步，可在「兑换码管理」中查看已生成的兑换码，在「道具凭证」中管理道具模板。
                    </p>
                  </div>
                </div>
              </div>
            </div>
          )}
          
          <div className="mt-6 flex justify-between">
            <Button variant="outline" onClick={() => setCurrentStep(PublishStep.UPLOAD)}>
              <ChevronLeft className="w-4 h-4" />
              返回上传
            </Button>
            <Button onClick={handlePublish} disabled={isPublishing || selectedSkills.size === 0}>
              {isPublishing ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  发布中...
                </>
              ) : (
                <>
                  <Rocket className="w-4 h-4" />
                  一键发布
                  <span>道具数据将同步至「兑换码管理」和「道具凭证」系统</span>
                </>
              )}
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  };

  // 渲染发布状态
  const renderPublishStatus = () => {
    if (!pipelineState) return null;
    
    const stepNames: Record<string, string> = {
      validate: '验证游戏包',
      register: '注册 Skills',
      config: '生成配置',
      build: '构建游戏',
      deploy: '部署资源',
      registerPlatform: '平台注册',
      activate: '激活上线',
    };
    
    return (
      <Card className="max-w-2xl mx-auto">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {pipelineState.status === 'completed' ? (
              <CheckCircle className="w-6 h-6 text-green-400" />
            ) : pipelineState.status === 'failed' ? (
              <AlertCircle className="w-6 h-6 text-red-400" />
            ) : (
              <Rocket className="w-6 h-6 text-cyan-400" />
            )}
            发布状态
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="mb-6">
            <div className="flex justify-between text-sm mb-2">
              <span className="text-gray-400">总进度</span>
              <span className="text-white">{Math.round(pipelineState.progress)}%</span>
            </div>
            <Progress value={pipelineState.progress} />
          </div>
          
          <div className="space-y-2">
            {pipelineState.steps.map((step, index) => (
              <div
                key={step.name}
                className={`flex items-center justify-between p-3 rounded-lg ${
                  step.status === 'running' 
                    ? 'bg-cyan-500/10 border border-cyan-500/30' 
                    : step.status === 'completed'
                      ? 'bg-green-500/10'
                      : step.status === 'failed'
                        ? 'bg-red-500/10'
                        : 'bg-slate-700/30'
                }`}
              >
                <div className="flex items-center gap-3">
                  <span className="text-gray-500">{index + 1}</span>
                  <span className={
                    step.status === 'running' ? 'text-cyan-400' :
                    step.status === 'completed' ? 'text-green-400' :
                    step.status === 'failed' ? 'text-red-400' :
                    'text-gray-400'
                  }>
                    {stepNames[step.name] || step.name}
                  </span>
                </div>
                <div>
                  {step.status === 'running' && <Loader2 className="w-4 h-4 animate-spin text-cyan-400" />}
                  {step.status === 'completed' && <CheckCircle className="w-4 h-4 text-green-400" />}
                  {step.status === 'failed' && <AlertCircle className="w-4 h-4 text-red-400" />}
                </div>
              </div>
            ))}
          </div>
          
          {pipelineState.status === 'completed' && (
            <Alert variant="success" className="mt-6">
              <div className="flex items-center gap-2">
                <CheckCircle className="w-5 h-5" />
                <span className="font-semibold">发布成功！</span>
              </div>
              <p className="mt-2 text-sm">
                游戏已成功上线，可以通过以下链接访问：<br />
                <a href={pipelineState.url} target="_blank" rel="noopener noreferrer" className="underline">
                  {pipelineState.url}
                </a>
              </p>
            </Alert>
          )}
          
          {pipelineState.status === 'failed' && (
            <Alert variant="error" className="mt-6">
              <div className="flex items-center gap-2">
                <AlertCircle className="w-5 h-5" />
                <span className="font-semibold">发布失败</span>
              </div>
              <p className="mt-2 text-sm">{pipelineState.error}</p>
            </Alert>
          )}
        </CardContent>
      </Card>
    );
  };

  // ==================== 发布指南面板 ====================

  const guideContent: Record<string, { title: string; icon: React.ReactNode; content: React.ReactNode }> = {
    overview: {
      title: '发布流程概览',
      icon: <BookOpen className="w-5 h-5" />,
      content: (
        <div className="space-y-5 text-sm text-gray-300 leading-relaxed">
          <section>
            <h5 className="text-white font-semibold mb-2 flex items-center gap-2">
              <span className="w-6 h-6 rounded-full bg-purple-500/20 text-purple-400 flex items-center justify-center text-xs font-bold">1</span>
              上传游戏包
            </h5>
            <p className="pl-8">将您的游戏打包为 <code className="px-1 py-0.5 bg-slate-700 rounded text-cyan-400">.zip</code> 文件上传。系统支持任意 HTML5 游戏（原生 JS、Phaser、PixiJS、Cocos 等）。</p>
            <p className="pl-8 mt-1 text-gray-500">提示：如使用 Mode B，请在游戏 HTML 中引入 <code className="px-1 py-0.5 bg-slate-700 rounded">@allinone/standard-sdk</code>。</p>
          </section>
          <section>
            <h5 className="text-white font-semibold mb-2 flex items-center gap-2">
              <span className="w-6 h-6 rounded-full bg-purple-500/20 text-purple-400 flex items-center justify-center text-xs font-bold">2</span>
              AI 智能分析
            </h5>
            <p className="pl-8">系统自动分析游戏框架类型、检测代码特征。如果配置了 CloudBase AI，将使用大模型深度分析；否则使用本地规则分析。</p>
            <p className="pl-8 mt-1 text-gray-500">分析结果包括：框架检测、功能特征识别、代码质量评分。</p>
          </section>
          <section>
            <h5 className="text-white font-semibold mb-2 flex items-center gap-2">
              <span className="w-6 h-6 rounded-full bg-purple-500/20 text-purple-400 flex items-center justify-center text-xs font-bold">3</span>
              配置 Skills &amp; 道具
            </h5>
            <p className="pl-8">选择游戏需要的能力（钱包、库存、商店等），配置兑换道具（名称、价格、效果类型）。系统自动检测协议模式并推荐 Mode A 或 B。</p>
            <p className="pl-8 mt-1 text-gray-500">道具效果类型（难度降低、速度提升等）由 Effect Engine 自动执行，无需游戏修改。</p>
          </section>
          <section>
            <h5 className="text-white font-semibold mb-2 flex items-center gap-2">
              <span className="w-6 h-6 rounded-full bg-purple-500/20 text-purple-400 flex items-center justify-center text-xs font-bold">4</span>
              一键发布
            </h5>
            <p className="pl-8">点击「一键发布」后，系统将执行 7 步流水线：验证 → 注册 Skills → 生成配置 → 构建游戏（注入协议层）→ 部署资源 → 注册到平台 → 激活上线。</p>
            <p className="pl-8 mt-1 text-gray-500">发布完成后，可以在「游戏管理」中找到已发布的游戏，点击「试玩」进行验证。</p>
          </section>
        </div>
      ),
    },
    modes: {
      title: 'Mode A vs Mode B',
      icon: <Wand2 className="w-5 h-5" />,
      content: (
        <div className="space-y-5 text-sm text-gray-300 leading-relaxed">
          {/* Mode A */}
          <div className="p-4 bg-purple-500/5 border border-purple-500/20 rounded-xl">
            <h5 className="text-purple-400 font-bold mb-3 flex items-center gap-2">
              <Zap className="w-4 h-4" />
              Mode A（注入适配）— 默认模式，零修改即生效
            </h5>
            <ul className="space-y-2 pl-4">
              <li className="flex items-start gap-2">
                <span className="text-purple-400 mt-0.5">•</span>
                <span><strong className="text-white">适用场景：</strong>任何 HTML5 游戏，无需集成 SDK，上传即用。</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-purple-400 mt-0.5">•</span>
                <span><strong className="text-white">工作原理：</strong>发布时自动在 HTML 头部注入 <strong>Effect Engine</strong>（约 400 行脚本），通过 monkey-patch <code className="px-1 py-0.5 bg-slate-700 rounded text-purple-300">requestAnimationFrame</code>、<code className="px-1 py-0.5 bg-slate-700 rounded text-purple-300">performance.now()</code> 等 API 实现帧级拦截。</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-purple-400 mt-0.5">•</span>
                <span><strong className="text-white">效果执行：</strong>Effect Engine 有 6 种内置效果处理器：难度降低（跳帧减速）、速度提升（双帧加速）、分数加成（变量扫描加倍）、额外生命、时间奖励、自定义透传。</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-purple-400 mt-0.5">•</span>
                <span><strong className="text-white">变量扫描：</strong>自动扫描全局对象中的 <code className="px-1 py-0.5 bg-slate-700 rounded text-purple-300">speed</code>、<code className="px-1 py-0.5 bg-slate-700 rounded text-purple-300">score</code>、<code className="px-1 py-0.5 bg-slate-700 rounded text-purple-300">life</code> 等关键词，修改数值实现效果。</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-purple-400 mt-0.5">•</span>
                <span><strong className="text-white">限制：</strong>支持常见游戏框架，但对极简 Canvas 或 WebGL 游戏效果有限；不支持 Schema 扩展。</span>
              </li>
            </ul>
          </div>

          {/* Mode B */}
          <div className="p-4 bg-cyan-500/5 border border-cyan-500/20 rounded-xl">
            <h5 className="text-cyan-400 font-bold mb-3 flex items-center gap-2">
              <Wand2 className="w-4 h-4" />
              Mode B（标准集成）— SDK 模式，灵活可控
            </h5>
            <ul className="space-y-2 pl-4">
              <li className="flex items-start gap-2">
                <span className="text-cyan-400 mt-0.5">•</span>
                <span><strong className="text-white">适用场景：</strong>游戏已集成 <code className="px-1 py-0.5 bg-slate-700 rounded text-cyan-300">@allinone/standard-sdk</code>，希望精确控制道具效果和协议通信。</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-cyan-400 mt-0.5">•</span>
                <span><strong className="text-white">集成方式：</strong>在 HTML 中添加 <code className="px-1 py-0.5 bg-slate-700 rounded text-cyan-300">&lt;script src="https://cdn.allinone.game/sdk/v1/standard-sdk.js"&gt;&lt;/script&gt;</code>，然后使用 <code className="px-1 py-0.5 bg-slate-700 rounded text-cyan-300">AllinONEGame</code> 类初始化。</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-cyan-400 mt-0.5">•</span>
                <span><strong className="text-white">协议通信：</strong>通过 <code className="px-1 py-0.5 bg-slate-700 rounded text-cyan-300">postMessage</code> 与平台双向通信。游戏发送 <code className="px-1 py-0.5 bg-slate-700 rounded text-cyan-300">PROTOCOL:READY</code>、<code className="px-1 py-0.5 bg-slate-700 rounded text-cyan-300">GAME_EVENT</code>；平台发送 <code className="px-1 py-0.5 bg-slate-700 rounded text-cyan-300">REDEEM_RESULT</code>。</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-cyan-400 mt-0.5">•</span>
                <span><strong className="text-white">效果执行：</strong>由游戏方在 <code className="px-1 py-0.5 bg-slate-700 rounded text-cyan-300">allinone-item-redeemed</code> 事件中自行处理，完全可控。</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-cyan-400 mt-0.5">•</span>
                <span><strong className="text-white">优势：</strong>支持 Schema 扩展（可自定义协议数据格式），支持 Extension Voucher（跨游戏凭证），适合复杂道具系统。</span>
              </li>
            </ul>
          </div>

          {/* 选择指南表格 */}
          <div className="p-4 bg-slate-700/20 rounded-xl">
            <h5 className="text-white font-bold mb-3">快速选择指南</h5>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-slate-600">
                    <th className="text-left py-2 px-3 text-gray-400">对比项</th>
                    <th className="text-left py-2 px-3 text-purple-400">Mode A</th>
                    <th className="text-left py-2 px-3 text-cyan-400">Mode B</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-700/50">
                  <tr><td className="py-2 px-3 text-gray-400">游戏修改量</td><td className="py-2 px-3 text-white">零修改</td><td className="py-2 px-3 text-white">需引入 SDK + 监听事件</td></tr>
                  <tr><td className="py-2 px-3 text-gray-400">效果控制</td><td className="py-2 px-3 text-white">自动（帧级拦截）</td><td className="py-2 px-3 text-white">手动（游戏方控制）</td></tr>
                  <tr><td className="py-2 px-3 text-gray-400">Schema 扩展</td><td className="py-2 px-3 text-white">不支持</td><td className="py-2 px-3 text-white">完整支持</td></tr>
                  <tr><td className="py-2 px-3 text-gray-400">跨游戏凭证</td><td className="py-2 px-3 text-white">不支持</td><td className="py-2 px-3 text-white">支持</td></tr>
                  <tr><td className="py-2 px-3 text-gray-400">适用复杂度</td><td className="py-2 px-3 text-white">简单道具效果</td><td className="py-2 px-3 text-white">复杂系统（装备、技能树等）</td></tr>
                  <tr><td className="py-2 px-3 text-gray-400">推荐场景</td><td className="py-2 px-3 text-white">快速发布、原型验证</td><td className="py-2 px-3 text-white">正式上线的深度游戏</td></tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ),
    },
    items: {
      title: '道具凭证系统',
      icon: <Ticket className="w-5 h-5" />,
      content: (
        <div className="space-y-5 text-sm text-gray-300 leading-relaxed">
          <section>
            <h5 className="text-white font-semibold mb-2">什么是道具凭证？</h5>
            <p>道具凭证（Voucher Item）是 AllinONE 平台的 <strong className="text-white">一级数字资产</strong>，每个道具凭证包含：名称、描述、类型（消耗品/永久道具/货币/增益效果/礼包）、稀有度、价格、效果定义。发布时系统自动在游戏 HTML 中注入兑换条 UI（右下角 🎁 按钮），玩家购买后输入兑换码即可激活效果。</p>
          </section>

          <section>
            <h5 className="text-white font-semibold mb-2">道具的生命周期</h5>
            <div className="pl-4 border-l-2 border-cyan-500/30 space-y-3">
              <div className="flex items-start gap-2">
                <span className="w-5 h-5 rounded-full bg-cyan-500/20 text-cyan-400 flex items-center justify-center text-xs font-bold flex-shrink-0 mt-0.5">1</span>
                <div><strong className="text-white">创建道具模板</strong> — 在发布中心配置道具名称、价格、效果类型，保存到「道具凭证」系统。</div>
              </div>
              <div className="flex items-start gap-2">
                <span className="w-5 h-5 rounded-full bg-cyan-500/20 text-cyan-400 flex items-center justify-center text-xs font-bold flex-shrink-0 mt-0.5">2</span>
                <div><strong className="text-white">生成兑换码</strong> — 玩家在商店购买后，系统自动生成唯一兑换码（支持自定义前缀、长度、字符集）。</div>
              </div>
              <div className="flex items-start gap-2">
                <span className="w-5 h-5 rounded-full bg-cyan-500/20 text-cyan-400 flex items-center justify-center text-xs font-bold flex-shrink-0 mt-0.5">3</span>
                <div><strong className="text-white">游戏内兑换</strong> — 玩家在游戏中点击 🎁 按钮打开兑换条，输入兑换码，系统验证后执行效果。</div>
              </div>
              <div className="flex items-start gap-2">
                <span className="w-5 h-5 rounded-full bg-cyan-500/20 text-cyan-400 flex items-center justify-center text-xs font-bold flex-shrink-0 mt-0.5">4</span>
                <div><strong className="text-white">同步双系统</strong> — 发布时道具自动同步到「兑换码管理」（兼容旧系统）和「道具凭证」（新系统）。</div>
              </div>
            </div>
          </section>

          <section className="p-4 bg-yellow-500/5 border border-yellow-500/20 rounded-xl">
            <h5 className="text-yellow-400 font-semibold mb-2 flex items-center gap-2">
              <Info className="w-4 h-4" />
              效果类型说明
            </h5>
            <div className="space-y-2">
              <p><span className="text-white font-medium">🎯 难度降低</span> — 自动拦截 <code className="px-1 py-0.5 bg-slate-700 rounded">requestAnimationFrame</code>，按比例跳过帧，降低游戏速度。</p>
              <p><span className="text-white font-medium">⚡ 速度提升</span> — 在同一帧内双倍调用回调，加速游戏运行；支持持续时间（默认 30 秒后自动恢复）。</p>
              <p><span className="text-white font-medium">🌟 分数加成</span> — 扫描全局变量中的 <code className="px-1 py-0.5 bg-slate-700 rounded">score</code>、<code className="px-1 py-0.5 bg-slate-700 rounded">points</code>、<code className="px-1 py-0.5 bg-slate-700 rounded">multiplier</code> 等，按倍率修改。</p>
              <p><span className="text-white font-medium">❤️ 额外生命</span> — 扫描 <code className="px-1 py-0.5 bg-slate-700 rounded">life</code>、<code className="px-1 py-0.5 bg-slate-700 rounded">health</code>、<code className="px-1 py-0.5 bg-slate-700 rounded">hp</code> 等变量，自动增加值。</p>
              <p><span className="text-white font-medium">⏱️ 时间奖励</span> — 扫描 <code className="px-1 py-0.5 bg-slate-700 rounded">time</code>、<code className="px-1 py-0.5 bg-slate-700 rounded">timer</code>、<code className="px-1 py-0.5 bg-slate-700 rounded">countdown</code> 等，增加倒计时。</p>
              <p><span className="text-white font-medium">📦 自定义</span> — 仅透传数据到 <code className="px-1 py-0.5 bg-slate-700 rounded">allinone-item-redeemed</code> 事件，需游戏方自行监听处理。</p>
            </div>
          </section>
        </div>
      ),
    },
    case: {
      title: '实战案例',
      icon: <Sparkles className="w-5 h-5" />,
      content: (
        <div className="space-y-5 text-sm text-gray-300 leading-relaxed">
          <section className="p-4 bg-gradient-to-r from-cyan-500/10 to-purple-500/10 border border-cyan-500/30 rounded-xl">
            <h5 className="text-white font-bold mb-3 flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-cyan-400" />
              案例：消消乐 (Match3Game) 道具接入全流程
            </h5>
            <p className="text-gray-400">下面以消消乐游戏为例，展示如何让您的游戏道具接入平台。该游戏有 3 种道具（炸弹/闪电/彩虹），使用 <strong className="text-cyan-400">Mode A（注入模式）</strong>，零 SDK 依赖，纯 HTML/CSS/JS。</p>
          </section>

          <section>
            <h5 className="text-white font-semibold mb-3 flex items-center gap-2">
              <span className="w-6 h-6 rounded-full bg-green-500/20 text-green-400 flex items-center justify-center text-xs font-bold">1</span>
              在游戏中定义道具元数据
            </h5>
            <p className="mb-2">在游戏脚本顶部添加 <code className="px-1 py-0.5 bg-slate-700 rounded text-green-300">POWERUP_META</code> 常量——平台发布时会自动读取并创建商店商品：</p>
            <pre className="p-3 bg-slate-900 rounded-lg text-xs text-green-300 overflow-x-auto">{`const POWERUP_META = {
  bomb: {
    itemId: 'match3_bomb',       // ← 与平台兑换码系统一致
    effectType: 'bomb',
    name: '💣 炸弹道具',
    price: 50,
    currency: 'gameCoins',
    description: '消除 3×3 范围宝石',
  },
  lightning: { itemId: 'match3_lightning', name: '⚡ 闪电道具', ... },
  rainbow:   { itemId: 'match3_rainbow',   name: '🌈 彩虹道具', ... },
};`}</pre>
          </section>

          <section>
            <h5 className="text-white font-semibold mb-3 flex items-center gap-2">
              <span className="w-6 h-6 rounded-full bg-green-500/20 text-green-400 flex items-center justify-center text-xs font-bold">2</span>
              添加通信桥接层 (PlatformBridge)
            </h5>
            <p className="mb-2">添加极简桥接代码（~50 行），监听平台兑换成功后分发的 <code className="px-1 py-0.5 bg-slate-700 rounded text-cyan-300">allinone:item-redeemed</code> 事件：</p>
            <pre className="p-3 bg-slate-900 rounded-lg text-xs text-cyan-300 overflow-x-auto">{`const PlatformBridge = (() => {
  const ITEM_MAP = {
    'match3_bomb': 'bomb',        // itemId → 游戏内道具类型
    'match3_lightning': 'lightning',
    'match3_rainbow': 'rainbow',
  };

  function onItemRedeemed(e) {
    const puType = ITEM_MAP[e.detail?.itemId];
    if (!puType) return;
    gameStats.powerUps[puType]++;  // 本地计数 +1
    updateUI();                     // 刷新界面
  }

  function init() {
    // ⚠️ 关键：始终注册监听器
    window.addEventListener('allinone:item-redeemed', onItemRedeemed);
    // 独立模式赠送默认道具数量
    if (!window.__ALLINONE_CONFIG__) {
      gameStats.powerUps = { bomb: 2, lightning: 1, rainbow: 1 };
    }
    updateUI();
  }
  return { init };
})();
PlatformBridge.init();`}</pre>
          </section>

          <section>
            <h5 className="text-white font-semibold mb-3 flex items-center gap-2">
              <span className="w-6 h-6 rounded-full bg-green-500/20 text-green-400 flex items-center justify-center text-xs font-bold">3</span>
              避免 __ALLINONE_CONFIG__ 字面量
            </h5>
            <p className="mb-2">平台发布时检查 HTML 中是否已含 <code className="px-1 py-0.5 bg-slate-700 rounded">__ALLINONE_CONFIG__</code> 来决定是否注入配置。如果游戏代码中出现此字面量，注入会被跳过。</p>
            <pre className="p-3 bg-slate-900 rounded-lg text-xs text-yellow-300 overflow-x-auto">{`// ✅ 正确：拆分字符串
const CONFIG_KEY = '__ALL' + 'INONE_CONFIG__';

// ❌ 错误：直接写完整字面量
const CONFIG_KEY = '__ALLINONE_CONFIG__';`}</pre>
          </section>

          <section>
            <h5 className="text-white font-semibold mb-3 flex items-center gap-2">
              <span className="w-6 h-6 rounded-full bg-green-500/20 text-green-400 flex items-center justify-center text-xs font-bold">4</span>
              道具使用（纯本地操作）
            </h5>
            <p className="mb-2">道具使用只需本地扣除数量，不需要调用任何 API：</p>
            <pre className="p-3 bg-slate-900 rounded-lg text-xs text-purple-300 overflow-x-auto">{`function usePowerUp(type) {
  if (!gameStats.powerUps[type]) return;
  gameStats.powerUps[type]--;  // 纯本地扣除
  // ...执行道具效果...
}`}</pre>
          </section>

          <section className="p-4 bg-amber-500/5 border border-amber-500/20 rounded-xl">
            <h5 className="text-amber-400 font-semibold mb-2 flex items-center gap-2">
              <AlertCircle className="w-4 h-4" />
              常见陷阱（已踩过坑）
            </h5>
            <ul className="space-y-2 pl-2">
              <li className="flex items-start gap-2">
                <span className="text-red-400 mt-0.5">❌</span>
                <span><strong className="text-white">不要用 fetch 调平台 API。</strong> 平台 Skill 系统运行在内存中，没有 HTTP 端点。唯一通信渠道是 <code className="px-1 py-0.5 bg-slate-700 rounded text-amber-300">allinone:item-redeemed</code> CustomEvent。</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-red-400 mt-0.5">❌</span>
                <span><strong className="text-white">不要用 if(isPlatform) 守卫监听器。</strong> 在 IIFE 中检测 <code className="px-1 py-0.5 bg-slate-700 rounded text-amber-300">__ALLINONE_CONFIG__</code> 可能因时序问题得到 <code className="px-1 py-0.5 bg-slate-700 rounded text-amber-300">false</code>，导致监听器永不注册。始终注册即可。</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-red-400 mt-0.5">❌</span>
                <span><strong className="text-white">不要同时监听两个事件名。</strong> SDK 同时分发 <code className="px-1 py-0.5 bg-slate-700 rounded text-amber-300">allinone:item-redeemed</code> 和 <code className="px-1 py-0.5 bg-slate-700 rounded text-amber-300">allinone-item-redeemed</code>，只监听一个即可，否则会重复计数。</span>
              </li>
            </ul>
          </section>

          {/* ===== 分隔线 + Mode B 案例 ===== */}
          <div className="border-t border-slate-700/50 pt-5 mt-2">
            <section className="p-4 bg-gradient-to-r from-cyan-500/10 to-blue-500/10 border border-cyan-500/30 rounded-xl">
              <h5 className="text-white font-bold mb-3 flex items-center gap-2">
                <Wand2 className="w-4 h-4 text-cyan-400" />
                案例：ZUMA × Mode B（SDK 集成模式）
              </h5>
              <div className="grid grid-cols-3 gap-3 mb-3">
                <div className="p-3 bg-slate-700/30 rounded-lg text-center">
                  <div className="text-lg mb-1">🎮</div>
                  <p className="text-white text-xs font-semibold">ZUMA 弹珠消除</p>
                  <p className="text-gray-500 text-xs">22KB 单文件</p>
                </div>
                <div className="p-3 bg-slate-700/30 rounded-lg text-center">
                  <div className="text-lg mb-1">🔧</div>
                  <p className="text-cyan-400 text-xs font-semibold">Mode B</p>
                  <p className="text-gray-500 text-xs">SDK 集成模式</p>
                </div>
                <div className="p-3 bg-slate-700/30 rounded-lg text-center">
                  <div className="text-lg mb-1">🎁</div>
                  <p className="text-white text-xs font-semibold">4 种道具</p>
                  <p className="text-gray-500 text-xs">难度降低/分数翻倍/清除弹珠</p>
                </div>
              </div>
              <p className="text-gray-400 text-xs leading-relaxed">与 Mode A 的区别：<strong className="text-cyan-400">游戏方通过 postMessage 自主控制效果</strong>，适合需要精确操控的深度游戏。</p>
            </section>

            <section className="mt-4">
              <h5 className="text-white font-semibold mb-3">Mode B 集成步骤（5 步）</h5>
              <div className="space-y-3">
                {[
                  ['1', '在 &lt;head&gt; 引入 SDK', '<code class="px-1 py-0.5 bg-slate-700 rounded text-blue-300">&lt;script src="https://cdn.allinone.game/sdk/v1/standard-sdk.js"&gt;&lt;/script&gt;</code>'],
                  ['2', '定义道具 + 发送 PROTOCOL:READY', '声明 REDEEM_ITEMS，通过 postMessage 发送协议就绪信号'],
                  ['3', '实现效果处理函数', '为每个 itemId 编写效果逻辑（如 g.moveSpeed *= 0.6 降低难度）'],
                  ['4', '监听兑换事件', '监听 allinone-item-redeemed 和 REDEEM_RESULT 消息'],
                  ['5', '打包单文件 ZIP 上传', '所有代码内联到一个 index.html，平台自动检测 SDK 选择 Mode B'],
                ].map(([num, title, desc]) => (
                  <div key={num} className="flex items-start gap-3">
                    <span className="w-5 h-5 rounded-full bg-blue-500/20 text-blue-400 flex items-center justify-center text-xs font-bold flex-shrink-0 mt-0.5">{num}</span>
                    <div><strong className="text-white text-xs">{title}</strong><p className="text-gray-400 text-xs mt-0.5" dangerouslySetInnerHTML={{__html: desc}} /></div>
                  </div>
                ))}
              </div>
            </section>

            <section className="mt-4 p-4 bg-red-500/5 border border-red-500/20 rounded-xl">
              <h5 className="text-red-400 font-semibold mb-2 flex items-center gap-2">
                <AlertCircle className="w-4 h-4" />
                ZUMA 案例踩过的坑（Mode B 专属）
              </h5>
              <div className="space-y-2 text-xs">
                {[
                  ['SDK 检测失败：上传后未被识别为 Mode B', 'StandardGameValidator 优先检查结构文件，不检测 SDK。修复：SDK 检测移到所有检查之前，扫描范围扩展为 .html。'],
                  ['试玩时 JS/CSS 文件 404', '平台通过 iframe srcdoc 加载，外部文件引用必然 404。必须将所有 JS/CSS 内联到单个 index.html。'],
                  ['SDK CDN 不可用 (ERR_NAME_NOT_RESOLVED)', 'cdn.allinone.game 是内部域名，本地不可用。SDK 加载失败不影响核心流程，Pipeline 自动注入协议桥接层。'],
                ].map(([q, a]) => (
                  <details key={q} className="group">
                    <summary className="flex items-center gap-2 cursor-pointer text-gray-300 font-medium group-open:text-red-400">
                      <ChevronDown className="w-3 h-3 transition-transform group-open:rotate-180" />
                      {q}
                    </summary>
                    <p className="mt-2 pl-5 text-gray-400">{a}</p>
                  </details>
                ))}
              </div>
            </section>

            <section className="mt-4 p-4 bg-blue-500/5 border border-blue-500/20 rounded-xl">
              <h5 className="text-blue-400 font-semibold mb-2 flex items-center gap-2">
                <CheckCircle className="w-4 h-4" />
                Mode A vs Mode B 选择指南
              </h5>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead><tr className="border-b border-slate-600">
                    <th className="text-left py-2 px-2 text-gray-400">对比</th>
                    <th className="text-left py-2 px-2 text-purple-400">Mode A（消消乐）</th>
                    <th className="text-left py-2 px-2 text-cyan-400">Mode B（ZUMA）</th>
                  </tr></thead>
                  <tbody className="divide-y divide-slate-700/50">
                    <tr><td className="py-1.5 px-2 text-gray-400">修改量</td><td className="py-1.5 px-2 text-white">~50 行 PlatformBridge</td><td className="py-1.5 px-2 text-white">~200 行集成脚本</td></tr>
                    <tr><td className="py-1.5 px-2 text-gray-400">效果控制</td><td className="py-1.5 px-2 text-white">CustomEvent 计数</td><td className="py-1.5 px-2 text-white">游戏方自主控制</td></tr>
                    <tr><td className="py-1.5 px-2 text-gray-400">适用场景</td><td className="py-1.5 px-2 text-white">快速发布、简单道具</td><td className="py-1.5 px-2 text-white">复杂效果、深度集成</td></tr>
                    <tr><td className="py-1.5 px-2 text-gray-400">SDK 依赖</td><td className="py-1.5 px-2 text-white">无需引入</td><td className="py-1.5 px-2 text-white">需引入标准 SDK</td></tr>
                    <tr><td className="py-1.5 px-2 text-gray-400">Schema 扩展</td><td className="py-1.5 px-2 text-white">不支持</td><td className="py-1.5 px-2 text-white">完整支持</td></tr>
                  </tbody>
                </table>
              </div>
            </section>
          </div>

          <section className="p-4 bg-green-500/5 border border-green-500/20 rounded-xl">
            <h5 className="text-green-400 font-semibold mb-2 flex items-center gap-2">
              <CheckCircle className="w-4 h-4" />
              让 AI 帮您自动适配
            </h5>
            <p className="mb-3">项目中已提供两份 AI 适配文档，选择对应模式复制给 AI 助手，附上游戏文件即可自动完成接入：</p>
            <div className="flex flex-wrap items-center gap-3">
              <a
                href="/docs/ai-game-integration-prompt.md"
                download="ai-game-integration-prompt-mode-a.md"
                className="inline-flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-purple-500 to-pink-500 text-white rounded-lg font-medium text-sm hover:from-purple-400 hover:to-pink-400 transition-all"
              >
                <Zap className="w-4 h-4" />
                Mode A 适配文档
              </a>
              <a
                href="/docs/ai-game-integration-prompt-mode-b.md"
                download="ai-game-integration-prompt-mode-b.md"
                className="inline-flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-cyan-500 to-blue-500 text-white rounded-lg font-medium text-sm hover:from-cyan-400 hover:to-blue-400 transition-all"
              >
                <Wand2 className="w-4 h-4" />
                Mode B 适配文档
              </a>
            </div>
            <p className="text-xs text-gray-500 mt-2">
              文件位置：<code className="px-1.5 py-0.5 bg-slate-700 rounded text-gray-300">docs/ai-game-integration-prompt.md</code> (Mode A) ｜ 
              <code className="px-1.5 py-0.5 bg-slate-700 rounded text-gray-300">docs/ai-game-integration-prompt-mode-b.md</code> (Mode B)
            </p>
          </section>
        </div>
      ),
    },
    faq: {
      title: '常见问题',
      icon: <HelpCircle className="w-5 h-5" />,
      content: (
        <div className="space-y-3 text-sm">
          {[
            {
              q: '什么情况下用 Mode A？什么情况下用 Mode B？',
              a: 'Mode A 适合任何 HTML5 游戏上传即用，零修改，Effect Engine 自动处理道具效果，适合快速验证和简单道具。Mode B 适合已集成 @allinone/standard-sdk 的游戏，效果由游戏方自行控制，适合需要精确操控的深度游戏。如果不确定选哪个，AI 会自动检测并推荐。'
            },
            {
              q: '我的游戏需要自己集成 SDK 吗？',
              a: '不需要！如果你选择 Mode A，完全不需要集成 SDK。系统发布时自动在游戏 HTML 中注入 Effect Engine + 兑换条 UI。只有当你希望使用 Mode B 精确控制道具效果时，才需要手动集成 @allinone/standard-sdk。'
            },
            {
              q: '为什么我的游戏在「试玩」时 JS/CSS 文件加载 404？',
              a: '这是正常的。平台通过 iframe srcdoc 加载游戏，只能加载入口 HTML 文件。JS/CSS 需要内联到 HTML 中。你可以将所有代码合并为单个 HTML 文件后上传，或者联系我们配置 CDN 部署方案。'
            },
            {
              q: 'Mode B 的 CDN SDK 地址打不开（ERR_NAME_NOT_RESOLVED）？',
              a: '这是内部 CDN 域名，在平台正式部署后才可用。Mode B 测试时 SDK 不可用不影响核心流程——发布时 Pipeline 会自动注入轻量协议桥接层，处理 postMessage 通信。你可以在 SDK 加载失败的回退路径中手动发送 PROTOCOL:READY 信号。'
            },
            {
              q: 'Effect Engine 一定能生效吗？会不会影响游戏性能？',
              a: 'Effect Engine 采用帧级拦截 + 变量扫描策略，对使用 requestAnimationFrame 的标准游戏帧率非常可靠。但它对极简 Canvas API 游戏或 WebGL 1.0 的帧率控制效果有限。性能影响极小（约 0.1ms/帧），仅在兑换道具后激活。'
            },
            {
              q: '道具兑换后游戏完全没有效果，怎么办？',
              a: '请检查：1) 协议模式是否正确——未集成 SDK 的游戏请使用 Mode A；2) 道具的「效果类型」是否选择了合适的类型（如「难度降低」对应跳帧）；3) Mode B 模式下是否监听了 allinone-item-redeemed 事件。如在兑换条输入兑换码后无反应，请检查控制台 REDEEM_RESULT 消息。'
            },
            {
              q: '兑换码和道具凭证有什么关系？',
              a: '道具凭证是模板，兑换码是实体的载体。一个道具凭证（如「难度降低药水」）可以对应无限张兑换码。玩家购买后获得一个唯一兑换码，在游戏内输入后验证并激活该道具。发布时道具数据自动同步到两套系统。'
            },
            {
              q: 'AI 分析显示 "CloudBase env not configured" 怎么办？',
              a: '这说明 CloudBase 环境尚未配置，AI 大模型分析不可用。系统会自动降级到本地规则分析，仍可正确检测框架、文件结构、SDK 使用情况。要启用 AI 分析，请配置 .env 文件中的 VITE_CLOUDBASE_ENV 和 VITE_CLOUDBASE_KEY 变量。'
            },
            {
              q: '发布成功后在哪里找到我的游戏？',
              a: '发布完成后，进入「游戏管理」页面可以查看所有已发布的游戏。点击「试玩」可以直接在浏览器中运行游戏。游戏数据存储在 localStorage / IndexedDB 中，刷新页面不会丢失。'
            },
          ].map((faq, i) => (
            <details key={i} className="group p-3 rounded-lg bg-slate-700/20 border border-slate-700/50 open:border-cyan-500/30 open:bg-cyan-500/5 transition-all">
              <summary className="flex items-center gap-2 cursor-pointer text-gray-200 font-medium group-open:text-cyan-400">
                <ChevronDown className="w-3.5 h-3.5 flex-shrink-0 transition-transform group-open:rotate-180" />
                <span>{faq.q}</span>
              </summary>
              <p className="mt-3 pl-5 text-gray-400 leading-relaxed border-l-2 border-cyan-500/20">{faq.a}</p>
            </details>
          ))}
        </div>
      ),
    },
  };

  // 主渲染
  return (
    <div className="w-full">
      {renderStepIndicator()}
      
      {error && (
        <Alert variant="error" className="mb-6 max-w-2xl mx-auto">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-5 h-5" />
            <span>{error}</span>
          </div>
        </Alert>
      )}
      
      {currentStep === PublishStep.UPLOAD && renderUploadStep()}
      
      {currentStep === PublishStep.ANALYZE && (
        <div className="max-w-2xl mx-auto text-center py-12">
          <Loader2 className="w-16 h-16 mx-auto mb-4 text-cyan-400 animate-spin" />
          <p className="text-xl text-white mb-2">AI 正在分析游戏...</p>
          <p className="text-gray-400">请稍候，这可能需要几秒钟</p>
        </div>
      )}
      
      {currentStep === PublishStep.CONFIGURE && (
        <div className="max-w-3xl mx-auto">
          {renderAnalysisResult()}
          {renderSkillRecommendations()}
        </div>
      )}
      
      {currentStep === PublishStep.PUBLISH && renderPublishStatus()}
      
      {/* Mode B 警告对话框 (Fix 1 & 2) */}
      {showModeBWarning && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-slate-800 rounded-2xl shadow-xl max-w-lg w-full border border-slate-700">
            <div className="p-6 border-b border-slate-700">
              <div className="flex items-center gap-3 mb-2">
                <div className="p-2 bg-yellow-500/20 rounded-lg">
                  <AlertCircle className="w-6 h-6 text-yellow-400" />
                </div>
                <div>
                  <h3 className="text-xl font-bold text-white">Mode B 兼容性警告</h3>
                  <p className="text-sm text-gray-400 mt-1">
                    未检测到 @allinone/standard-sdk
                  </p>
                </div>
              </div>
            </div>
            <div className="p-6 space-y-4">
              <p className="text-gray-300 text-sm leading-relaxed">
                当前游戏未集成 <code className="px-1.5 py-0.5 bg-slate-700 rounded text-cyan-400">@allinone/standard-sdk</code>，
                选择 Mode B 后轻量协议桥接层将无法执行游戏内效果。
              </p>

              <div className="space-y-3">
                <button
                  onClick={() => {
                    setProtocolMode('inject');
                    setShowModeBWarning(false);
                  }}
                  className="w-full p-4 bg-purple-500/10 border border-purple-500/30 rounded-xl text-left hover:bg-purple-500/20 transition-all group"
                >
                  <div className="flex items-center gap-3">
                    <div className="p-2 bg-purple-500/20 rounded-lg">
                      <Wand2 className="w-5 h-5 text-purple-400" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold text-white group-hover:text-purple-300 transition-colors">
                        自动切换为 Mode A（推荐）
                      </p>
                      <p className="text-xs text-gray-400 mt-0.5">
                        游戏无需任何修改，自动注入 Effect Engine，道具效果即刻生效
                      </p>
                    </div>
                    <Badge variant="success">推荐</Badge>
                  </div>
                </button>

                <button
                  onClick={handleUseModeBTemplate}
                  disabled={isLoadingTemplate}
                  className="w-full p-4 bg-cyan-500/10 border border-cyan-500/30 rounded-xl text-left hover:bg-cyan-500/20 transition-all group disabled:opacity-50"
                >
                  <div className="flex items-center gap-3">
                    <div className="p-2 bg-cyan-500/20 rounded-lg">
                      {isLoadingTemplate ? (
                        <Loader2 className="w-5 h-5 text-cyan-400 animate-spin" />
                      ) : (
                        <FileCode className="w-5 h-5 text-cyan-400" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold text-white group-hover:text-cyan-300 transition-colors">
                        使用 Mode B 模板创建新游戏
                      </p>
                      <p className="text-xs text-gray-400 mt-0.5">
                        自动加载已集成 @allinone/standard-sdk 的示例游戏模板
                      </p>
                    </div>
                  </div>
                </button>

                <button
                  onClick={() => {
                    setProtocolMode('integrated');
                    setShowModeBWarning(false);
                  }}
                  className="w-full p-4 bg-slate-700/30 border border-slate-600/50 rounded-xl text-left hover:bg-slate-700/50 transition-all group"
                >
                  <div className="flex items-center gap-3">
                    <div className="p-2 bg-slate-600 rounded-lg">
                      <Zap className="w-5 h-5 text-gray-400" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold text-gray-300 group-hover:text-white transition-colors">
                        仍然使用 Mode B（仅桥接层）
                      </p>
                      <p className="text-xs text-gray-500 mt-0.5">
                        注入轻量协议桥接层，但游戏内效果需要自行实现
                      </p>
                    </div>
                  </div>
                </button>
              </div>
            </div>
            <div className="p-4 border-t border-slate-700 flex justify-end">
              <button
                onClick={() => setShowModeBWarning(false)}
                className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors"
              >
                取消
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 创建兑换码道具弹窗 */}
      {showRedeemForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-slate-800 rounded-2xl shadow-xl max-w-2xl w-full max-h-[90vh] overflow-auto border border-slate-700">
            <div className="p-6 border-b border-slate-700 flex items-center justify-between">
              <div>
                <h3 className="text-xl font-bold text-white flex items-center gap-2">
                  <Ticket className="w-5 h-5 text-purple-400" />
                  新建兑换码道具
                </h3>
                <p className="text-sm text-gray-400 mt-1">
                  配置后将自动生成兑换码，玩家购买后可在游戏中兑换
                </p>
              </div>
              <button 
                onClick={() => setShowRedeemForm(false)} 
                className="text-gray-400 hover:text-white transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleAddRedeemItem} className="p-6 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="text-sm font-medium text-gray-300">道具名称</label>
                  <input
                    name="name"
                    type="text"
                    placeholder="如：生命药水"
                    required
                    className="w-full px-3 py-2 rounded-lg border border-slate-600 bg-slate-700 text-white focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-sm font-medium text-gray-300">道具类型</label>
                  <select
                    name="type"
                    className="w-full px-3 py-2 rounded-lg border border-slate-600 bg-slate-700 text-white focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                  >
                    <option value={ItemType.CONSUMABLE}>消耗品</option>
                    <option value={ItemType.PERMANENT}>永久道具</option>
                    <option value={ItemType.CURRENCY}>货币</option>
                    <option value={ItemType.BUFF}>增益效果</option>
                    <option value={ItemType.PACKAGE}>礼包</option>
                  </select>
                </div>
              </div>
              
              <div className="space-y-1">
                <label className="text-sm font-medium text-gray-300">道具描述</label>
                <input
                  name="description"
                  type="text"
                  placeholder="简要描述道具效果，玩家购买时可见"
                  className="w-full px-3 py-2 rounded-lg border border-slate-600 bg-slate-700 text-white focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                />
              </div>
              
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="text-sm font-medium text-gray-300">价格 (ACOIN)</label>
                  <input
                    name="price"
                    type="number"
                    min="0"
                    defaultValue="10"
                    className="w-full px-3 py-2 rounded-lg border border-slate-600 bg-slate-700 text-white focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-sm font-medium text-gray-300">发行策略</label>
                  <select
                    name="supplyPolicy"
                    className="w-full px-3 py-2 rounded-lg border border-slate-600 bg-slate-700 text-white focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                  >
                    <option value={ItemSupplyPolicy.OPEN}>OPEN - 开放发行（可无限增发）</option>
                    <option value={ItemSupplyPolicy.LIMITED}>LIMITED - 限量发行（总量锁定）</option>
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="text-sm font-medium text-gray-300">初始库存 / 总量</label>
                  <input
                    name="initialInventory"
                    type="number"
                    min="1"
                    defaultValue="100"
                    className="w-full px-3 py-2 rounded-lg border border-slate-600 bg-slate-700 text-white focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-sm font-medium text-gray-300">道具稀有度</label>
                  <select
                    name="rarity"
                    className="w-full px-3 py-2 rounded-lg border border-slate-600 bg-slate-700 text-white focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                  >
                    <option value="common">普通</option>
                    <option value="uncommon">精良</option>
                    <option value="rare">稀有</option>
                    <option value="legendary">传说</option>
                  </select>
                </div>
              </div>

              {/* ===== 效果类型选择（注册表驱动） ===== */}
              <div className="border-t border-slate-700 pt-4">
                <h4 className="font-medium text-white mb-3 flex items-center gap-2">
                  <Zap className="w-4 h-4 text-yellow-400" />
                  效果类型（自动执行）
                </h4>
                <div className="space-y-1">
                  <select
                    name="effectType"
                    value={selectedEffectType}
                    onChange={(e) => setSelectedEffectType(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-slate-600 bg-slate-700 text-white focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                  >
                    {effectTypeRegistry.getCategories().map(cat => (
                      <optgroup key={cat.id} label={cat.name}>
                        {effectTypeRegistry.getByCategory(cat.id).map(et => (
                          <option key={et.id} value={et.id}>
                            {et.icon} {et.name} - {et.description}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                  <p className="text-xs text-gray-500 mt-1">
                    效果引擎（Effect Engine）已预注入游戏 HTML，支持 <strong>帧级拦截</strong> 和 <strong>变量扫描</strong>，
                    无需游戏方任何配合即可自动执行效果。
                  </p>
                </div>
              </div>

              {/* ===== 效果参数编辑器（动态渲染） ===== */}
              {(() => {
                const effectDef = effectTypeRegistry.get(selectedEffectType);
                if (!effectDef || effectDef.parameters.length === 0) return null;
                return (
                  <div className="border-t border-slate-700 pt-4">
                    <h4 className="font-medium text-white mb-3 flex items-center gap-2">
                      <Settings className="w-4 h-4 text-cyan-400" />
                      效果参数配置
                    </h4>
                    <div className="space-y-3">
                      {effectDef.parameters.map(param => (
                        <div key={param.key} className="space-y-1">
                          <label className="text-sm font-medium text-gray-300 flex items-center gap-2">
                            {param.label}
                            {param.description && (
                              <span className="text-xs text-gray-500 font-normal">({param.description})</span>
                            )}
                          </label>
                          {param.type === 'number' && (
                            <input
                              name={`effect_param_${param.key}`}
                              type="number"
                              defaultValue={param.defaultValue}
                              min={param.min}
                              max={param.max}
                              step={param.step}
                              className="w-full px-3 py-2 rounded-lg border border-slate-600 bg-slate-700 text-white focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                            />
                          )}
                          {param.type === 'select' && (
                            <select
                              name={`effect_param_${param.key}`}
                              defaultValue={param.defaultValue}
                              className="w-full px-3 py-2 rounded-lg border border-slate-600 bg-slate-700 text-white focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                            >
                              {param.options?.map(opt => (
                                <option key={opt.value} value={opt.value}>{opt.label}</option>
                              ))}
                            </select>
                          )}
                          {param.type === 'boolean' && (
                            <label className="flex items-center gap-2 cursor-pointer">
                              <input
                                name={`effect_param_${param.key}`}
                                type="checkbox"
                                defaultChecked={param.defaultValue}
                                className="w-4 h-4 rounded border-slate-600 bg-slate-700 text-purple-500 focus:ring-purple-500"
                              />
                              <span className="text-sm text-gray-400">启用</span>
                            </label>
                          )}
                          {param.type === 'string' && (
                            <input
                              name={`effect_param_${param.key}`}
                              type="text"
                              defaultValue={param.defaultValue}
                              className="w-full px-3 py-2 rounded-lg border border-slate-600 bg-slate-700 text-white focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                            />
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })()}

              <div className="border-t border-slate-700 pt-4">
                <h4 className="font-medium text-white mb-3 flex items-center gap-2">
                  <Ticket className="w-4 h-4 text-purple-400" />
                  兑换码配置
                </h4>
                <div className="grid grid-cols-3 gap-4">
                  <div className="space-y-1">
                    <label className="text-sm font-medium text-gray-300">前缀</label>
                    <input
                      name="prefix"
                      type="text"
                      placeholder="如：HP-"
                      className="w-full px-3 py-2 rounded-lg border border-slate-600 bg-slate-700 text-white focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-sm font-medium text-gray-300">码长度</label>
                    <input
                      name="length"
                      type="number"
                      min="6"
                      max="20"
                      defaultValue="8"
                      className="w-full px-3 py-2 rounded-lg border border-slate-600 bg-slate-700 text-white focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-sm font-medium text-gray-300">字符集</label>
                    <select
                      name="charset"
                      className="w-full px-3 py-2 rounded-lg border border-slate-600 bg-slate-700 text-white focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                    >
                      <option value="alphanumeric">字母数字</option>
                      <option value="numeric">纯数字</option>
                      <option value="alphabetic">纯字母</option>
                    </select>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4 mt-4">
                  <div className="space-y-1">
                    <label className="text-sm font-medium text-gray-300">过期天数 (0=永不过期)</label>
                    <input
                      name="expireDays"
                      type="number"
                      min="0"
                      defaultValue="0"
                      className="w-full px-3 py-2 rounded-lg border border-slate-600 bg-slate-700 text-white focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                    />
                  </div>
                  <div className="flex items-center gap-2 pt-6">
                    <input 
                      type="checkbox" 
                      name="caseSensitive" 
                      id="caseSensitive" 
                      className="w-4 h-4 rounded border-slate-600 bg-slate-700 text-purple-500 focus:ring-purple-500" 
                    />
                    <label htmlFor="caseSensitive" className="text-sm text-gray-300">
                      区分大小写
                    </label>
                  </div>
                </div>
              </div>

              <div className="border-t border-slate-700 pt-4">
                <h4 className="font-medium text-white mb-3 flex items-center gap-2">
                  <Gamepad2 className="w-4 h-4 text-cyan-400" />
                  游戏内效果配置
                </h4>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1">
                    <label className="text-sm font-medium text-gray-300">游戏内道具ID</label>
                    <input
                      name="gameItemId"
                      type="text"
                      placeholder="如：health_potion"
                      required
                      className="w-full px-3 py-2 rounded-lg border border-slate-600 bg-slate-700 text-white focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-sm font-medium text-gray-300">兑换数量</label>
                    <input
                      name="gameQuantity"
                      type="number"
                      min="1"
                      defaultValue="1"
                      className="w-full px-3 py-2 rounded-lg border border-slate-600 bg-slate-700 text-white focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                    />
                  </div>
                </div>
              </div>

              <div className="flex justify-end gap-3 pt-4 border-t border-slate-700">
                <Button type="button" variant="outline" onClick={() => setShowRedeemForm(false)}>
                  取消
                </Button>
                <Button type="submit">
                  <Plus className="w-4 h-4" />
                  添加道具
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* 发布指南 - 悬浮帮助按钮 */}
      <button
        onClick={() => setShowGuide(true)}
        className="fixed bottom-6 right-6 z-40 w-12 h-12 rounded-full bg-gradient-to-r from-cyan-500 to-blue-500 text-white shadow-lg shadow-cyan-500/30 hover:shadow-cyan-500/50 hover:scale-105 transition-all flex items-center justify-center"
        title="发布指南"
      >
        <BookOpen className="w-5 h-5" />
      </button>

      {/* 发布指南 - 详细面板 */}
      {showGuide && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="bg-slate-800 rounded-2xl shadow-2xl max-w-2xl w-full max-h-[85vh] flex flex-col border border-slate-700">
            {/* 标题栏 */}
            <div className="flex items-center justify-between p-5 border-b border-slate-700 flex-shrink-0">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-gradient-to-br from-cyan-500 to-purple-500 rounded-lg">
                  <BookOpen className="w-5 h-5 text-white" />
                </div>
                <div>
                  <h3 className="text-lg font-bold text-white">发布指南</h3>
                  <p className="text-xs text-gray-400 mt-0.5">了解发布流程、协议模式和道具系统</p>
                </div>
              </div>
              <button onClick={() => setShowGuide(false)} className="p-1.5 hover:bg-slate-700 rounded-lg text-gray-400 hover:text-white transition-colors">
                <X className="w-5 h-5" />
              </button>
            </div>
            {/* 标签页切换 */}
            <div className="flex items-center gap-1 p-3 border-b border-slate-700/50 flex-shrink-0 overflow-x-auto bg-slate-800/50">
              {(['overview', 'modes', 'items', 'case', 'faq'] as const).map((tab) => (
                <button
                  key={tab}
                  onClick={() => setGuideTab(tab)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-all ${
                    guideTab === tab
                      ? 'bg-gradient-to-r from-cyan-500/20 to-purple-500/20 text-white border border-cyan-500/30'
                      : 'text-gray-400 hover:text-gray-200 hover:bg-slate-700/50'
                  }`}
                >
                  {guideContent[tab].icon}
                  {guideContent[tab].title}
                </button>
              ))}
            </div>
            {/* 内容区域 */}
            <div className="flex-1 overflow-y-auto p-5">
              {guideContent[guideTab].content}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
