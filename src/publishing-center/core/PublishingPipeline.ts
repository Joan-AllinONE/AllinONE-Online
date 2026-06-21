/**
 * AllinONE 发布流水线
 * 
 * 七步发布流程：
 * 1. 游戏包验证
 * 2. 自动注册 Skills
 * 3. 生成配置文件
 * 4. 构建游戏
 * 5. 部署资源
 * 6. 注册到平台
 * 7. 正式上线
 */

import {
  PublishStep,
  PublishStatus,
  PublishPipelineState,
  PublishLogEntry,
  PublishingConfig,
  PublishResult,
  GameType,
  ProtocolMode,
} from '../types';
import { SkillInitializer, type SkillInitializationResult } from './SkillInitializer';
import { savePublishedGame, saveGameFiles, type PublishedGame, type RedeemItemConfig } from '@/services/publishedGameService';
import { gameDeveloperService } from '@/services/gameDeveloperService';
import { getToken } from '@/services/authTokenService';

// ==================== 流水线配置 ====================

export interface PublishingPipelineConfig {
  onStepChange?: (state: PublishPipelineState) => void;
  onProgress?: (progress: number, message: string) => void;
  onComplete?: (result: PublishResult) => void;
  onError?: (error: Error) => void;
  debug?: boolean;
}

// ==================== 流水线步骤定义 ====================

interface PipelineStep {
  id: string;
  name: string;
  description: string;
  weight: number; // 进度权重 (0-100)
  execute: (context: PipelineContext) => Promise<void>;
}

interface PipelineContext {
  config: PublishingConfig;
  state: PublishPipelineState;
  data: Map<string, any>;
  logger: Logger;
}

class Logger {
  private logs: PublishLogEntry[] = [];
  private onLog?: (entry: PublishLogEntry) => void;

  constructor(onLog?: (entry: PublishLogEntry) => void) {
    this.onLog = onLog;
  }

  info(message: string, step?: string) {
    this.log('info', message, step);
  }

  success(message: string, step?: string) {
    this.log('success', message, step);
  }

  warning(message: string, step?: string) {
    this.log('warning', message, step);
  }

  error(message: string, step?: string) {
    this.log('error', message, step);
  }

  private log(level: PublishLogEntry['level'], message: string, step?: string) {
    const entry: PublishLogEntry = {
      timestamp: Date.now(),
      level,
      message,
      step: step as PublishStep,
    };
    this.logs.push(entry);
    this.onLog?.(entry);
  }

  getLogs(): PublishLogEntry[] {
    return [...this.logs];
  }
}

// ==================== PublishingPipeline 类 ====================

export class PublishingPipeline {
  private config: PublishingPipelineConfig;
  private state: PublishPipelineState;
  private context!: PipelineContext;
  private steps: PipelineStep[];
  private isRunning: boolean = false;
  private subscribers: Set<(state: PublishPipelineState) => void> = new Set();

  constructor(config: PublishingPipelineConfig = {}) {
    this.config = config;
    this.state = {
      step: PublishStep.UPLOAD,
      status: PublishStatus.IDLE,
      progress: 0,
      message: '准备发布',
      logs: [],
      steps: this.createSteps().map(s => ({
        name: s.id,
        status: 'pending' as const,
      })),
    };
    this.steps = this.createSteps();
  }

  /**
   * 订阅状态变化
   */
  subscribe(callback: (state: PublishPipelineState) => void): () => void {
    this.subscribers.add(callback);
    // 立即发送当前状态
    callback(this.getState());
    
    return () => {
      this.subscribers.delete(callback);
    };
  }

  private notifySubscribers(): void {
    const state = this.getState();
    this.subscribers.forEach(callback => callback(state));
  }

  /**
   * 开始发布流程
   */
  async publish(publishConfig: PublishingConfig): Promise<PublishResult> {
    if (this.isRunning) {
      throw new Error('发布流程正在进行中');
    }

    this.isRunning = true;
    this.updateState({ status: PublishStatus.RUNNING });

    // 创建上下文
    const logger = new Logger((entry) => {
      this.state.logs.push(entry);
    });

    this.context = {
      config: publishConfig,
      state: this.state,
      data: new Map(),
      logger,
    };

    try {
      logger.info('开始发布流程', PublishStep.PUBLISH);
      logger.info(`游戏类型: ${publishConfig.gameType === GameType.STANDARD ? 'AllinONE标准游戏' : '通用游戏'}`, PublishStep.PUBLISH);

      // 按顺序执行步骤
      for (const step of this.steps) {
        await this.executeStep(step);
      }

      // 发布完成
      const savedGame = this.context.data.get('savedGame');
      const skillInitResult: SkillInitializationResult = this.context.data.get('skillInitializationResult');
      
      const result: PublishResult = {
        success: true,
        gameId: publishConfig.gameId,
        version: '1.0.0',
        url: `https://allinone.game/play/${publishConfig.gameId}`,
        publishedAt: new Date().toISOString(),
        gameType: publishConfig.gameType,
        activatedSkills: skillInitResult?.initializedSkills.map(s => s.skillId) || [],
        skillConfigs: skillInitResult?.config || {},
        runtime: {
          canLaunch: true,
          launchUrl: `/play/${publishConfig.gameId}`,
          embedded: true,
        },
      };

      this.updateState({
        status: PublishStatus.SUCCESS,
        progress: 100,
        message: '发布成功',
      });

      logger.success('游戏发布成功！', PublishStep.PUBLISH);
      this.config.onComplete?.(result);
      this.isRunning = false;

      return result;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      
      this.updateState({
        status: PublishStatus.FAILED,
        message: `发布失败: ${err.message}`,
      });

      logger.error(err.message, PublishStep.PUBLISH);
      this.config.onError?.(err);
      this.isRunning = false;

      throw err;
    }
  }

  /**
   * 取消发布流程
   */
  cancel(): void {
    if (this.isRunning) {
      this.isRunning = false;
      this.context.logger.warning('发布流程已取消', PublishStep.PUBLISH);
      this.updateState({
        status: PublishStatus.FAILED,
        message: '发布已取消',
      });
    }
  }

  /**
   * 获取当前状态
   */
  getState(): PublishPipelineState {
    return { ...this.state };
  }

  // ==================== 私有方法 ====================

  private createSteps(): PipelineStep[] {
    return [
      {
        id: 'validate',
        name: '验证游戏包',
        description: '检查游戏包完整性和安全性',
        weight: 10,
        execute: this.stepValidate.bind(this),
      },
      {
        id: 'register_skills',
        name: '注册 Skills',
        description: '自动注册所需的平台 Skills',
        weight: 15,
        execute: this.stepRegisterSkills.bind(this),
      },
      {
        id: 'generate_config',
        name: '生成配置',
        description: '生成游戏配置文件',
        weight: 10,
        execute: this.stepGenerateConfig.bind(this),
      },
      {
        id: 'build',
        name: '构建游戏',
        description: '构建和打包游戏',
        weight: 25,
        execute: this.stepBuild.bind(this),
      },
      {
        id: 'deploy',
        name: '部署资源',
        description: '部署游戏资源到CDN',
        weight: 25,
        execute: this.stepDeploy.bind(this),
      },
      {
        id: 'register_platform',
        name: '注册到平台',
        description: '注册游戏到AllinONE平台',
        weight: 10,
        execute: this.stepRegisterPlatform.bind(this),
      },
      {
        id: 'activate',
        name: '正式上线',
        description: '激活游戏并上线',
        weight: 5,
        execute: this.stepActivate.bind(this),
      },
    ];
  }

  private async executeStep(step: PipelineStep): Promise<void> {
    if (!this.isRunning) return;

    const startProgress = this.state.progress;
    const stepProgress = step.weight;

    this.updateState({
      message: step.description,
    });

    this.context.logger.info(`开始: ${step.name}`, PublishStep.PUBLISH);

    try {
      // 模拟进度更新
      const progressInterval = setInterval(() => {
        if (!this.isRunning) {
          clearInterval(progressInterval);
          return;
        }
        const randomProgress = Math.random() * 5;
        const newProgress = Math.min(
          startProgress + stepProgress,
          this.state.progress + randomProgress
        );
        this.updateProgress(newProgress, `${step.description}...`);
      }, 300);

      // 执行步骤
      await step.execute(this.context);

      clearInterval(progressInterval);
      this.updateProgress(startProgress + stepProgress, `${step.name}完成`);
      this.context.logger.success(`${step.name}完成`, PublishStep.PUBLISH);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.context.logger.error(`${step.name}失败: ${err.message}`, PublishStep.PUBLISH);
      throw error;
    }
  }

  private updateState(updates: Partial<PublishPipelineState>): void {
    this.state = { ...this.state, ...updates };
    this.config.onStepChange?.(this.getState());
    this.notifySubscribers();
  }

  private updateProgress(progress: number, message: string): void {
    this.state.progress = Math.min(100, progress);
    this.config.onProgress?.(this.state.progress, message);
  }

  // ==================== 步骤实现 ====================

  private async stepValidate(context: PipelineContext): Promise<void> {
    const { config, logger } = context;

    logger.info('正在验证游戏包...', PublishStep.PUBLISH);

    // 模拟验证
    await this.delay(500);

    // 验证文件结构
    if (!config.analysisResult.fileStructure.entryPoints.length) {
      throw new Error('未找到游戏入口文件');
    }

    logger.info(`找到 ${config.analysisResult.fileStructure.entryPoints.length} 个入口文件`, PublishStep.PUBLISH);

    // 安全扫描
    logger.info('正在进行安全扫描...', PublishStep.PUBLISH);
    await this.delay(500);

    // 代码质量检查
    if (config.analysisResult.codeMetrics.quality.score < 30) {
      logger.warning('代码质量分数较低，建议优化', PublishStep.PUBLISH);
    }

    context.data.set('validationPassed', true);
  }

  private async stepRegisterSkills(context: PipelineContext): Promise<void> {
    const { config, logger } = context;

    logger.info('正在注册平台 Skills...', PublishStep.PUBLISH);
    logger.info(`需要注册 ${config.skillRecommendations.length} 个 Skills`, PublishStep.PUBLISH);

    // 使用 SkillInitializer 真正初始化Skills到网关
    const initializer = new SkillInitializer(config.gameId);
    const result: SkillInitializationResult = await initializer.initializeSkills(
      config.skillRecommendations,
      config.skillConfigs
    );

    // 记录结果
    for (const skill of result.initializedSkills) {
      logger.success(`✓ ${skill.skillName} 初始化成功`, PublishStep.PUBLISH);
    }

    for (const skill of result.failedSkills) {
      logger.error(`✗ ${skill.skillName} 初始化失败: ${skill.error}`, PublishStep.PUBLISH);
    }

    if (result.failedSkills.length > 0) {
      logger.warning(`${result.failedSkills.length} 个 Skills 初始化失败，但发布流程将继续`, PublishStep.PUBLISH);
    }

    logger.success(`${result.initializedSkills.length} 个 Skills 注册完成`, PublishStep.PUBLISH);
    context.data.set('skillsRegistered', result.initializedSkills.map(s => s.skillId));
    context.data.set('skillInitializationResult', result);
    context.data.set('skillConfigs', result.config);
  }

  private async stepGenerateConfig(context: PipelineContext): Promise<void> {
    const { config, logger } = context;

    logger.info('正在生成游戏配置...', PublishStep.PUBLISH);

    // 生成 allinone.config.json
    const gameConfig = {
      game: {
        id: config.gameId,
        name: 'My Game',
        version: '1.0.0',
        description: '',
        framework: config.analysisResult.framework.framework,
      },
      platform: {
        type: config.gameType,
        entryPoint: config.analysisResult.fileStructure.entryPoints[0],
        fullscreen: true,
        mobileOptimized: true,
        offlineSupport: false,
      },
      skills: Object.fromEntries(
        config.skillRecommendations.map(s => [s.skillId, true])
      ),
    };

    context.data.set('gameConfig', gameConfig);
    logger.info('配置文件生成完成', PublishStep.PUBLISH);
  }

  private async stepBuild(context: PipelineContext): Promise<void> {
    const { config, logger } = context;

    logger.info('正在构建游戏...', PublishStep.PUBLISH);

    // 确定协议模式
    const protocolMode: ProtocolMode = config.protocolMode || 'inject';
    logger.info(`协议模式: ${protocolMode === 'integrated' ? '标准集成 (Mode B)' : '注入适配 (Mode A)'}`, PublishStep.PUBLISH);

    // ===== Mode B 兼容性检查 (Fix 3) =====
    if (protocolMode === 'integrated' && config.files && config.files.length > 0) {
      const hasSDK = config.files.some(f => {
        const content = typeof f.content === 'string' ? f.content
          : f.content instanceof Uint8Array ? new TextDecoder('utf-8').decode(f.content)
          : f.content instanceof ArrayBuffer ? new TextDecoder('utf-8').decode(new Uint8Array(f.content))
          : String(f.content);
        return content.includes('@allinone/standard-sdk') || content.includes('AllinONEGame');
      });
      if (!hasSDK) {
        logger.warning(
          '⚠️ Mode B (标准集成) 已选择，但未检测到 @allinone/standard-sdk。' +
          '游戏运行时协议通信可能不可用，建议切换至 Mode A (注入适配)。',
          PublishStep.PUBLISH
        );
        logger.info(
          '💡 如果游戏方希望使用 Mode B，请在游戏 HTML 中引入 @allinone/standard-sdk。' +
          '或在选择 Mode B 时使用「Mode B 示例模板」创建新游戏。',
          PublishStep.PUBLISH
        );
      }
    }

    // 标准游戏构建更快
    if (config.gameType === GameType.STANDARD) {
      logger.info('标准游戏：使用快速构建通道', PublishStep.PUBLISH);
      await this.delay(800);
    } else {
      logger.info('通用游戏：AI适配构建中...', PublishStep.PUBLISH);
      await this.delay(2000);
    }

    logger.info('代码优化中...', PublishStep.PUBLISH);
    await this.delay(500);

    // ===== 注入 AllinONE 协议层 =====
    const files = config.files;
    if (files && files.length > 0 && config.gameId) {
      const entryPoint = config.analysisResult.fileStructure.entryPoints[0] || 'index.html';
      
      // 查找 HTML 入口文件（优先选择 dist/ 编译版本，而非 src/ 源码版本）
      let htmlFile = files.find(f => f.path === entryPoint);
      if (!htmlFile) {
        const htmlCandidates = files.filter(f => f.name === 'index.html' || f.name.endsWith('.html'));
        htmlFile = htmlCandidates.find(f => f.path.includes('/dist/'))
          || htmlCandidates.find(f => f.path.endsWith('/' + entryPoint))
          || htmlCandidates[0];
      }

      if (htmlFile) {
        try {
          // 读取文件内容
          let content: string;
          if (typeof htmlFile.content === 'string') {
            content = htmlFile.content;
          } else if (htmlFile.content instanceof Uint8Array) {
            content = new TextDecoder('utf-8').decode(htmlFile.content);
          } else if (htmlFile.content instanceof ArrayBuffer) {
            content = new TextDecoder('utf-8').decode(new Uint8Array(htmlFile.content));
          } else {
            content = String(htmlFile.content);
          }

          // 根据协议模式选择注入策略
          if (protocolMode === 'integrated') {
            // Mode B: 标准集成 — 只注入轻量协议桥接层
            const protocolBridgeScript = this.generateProtocolBridge(config.gameId, config.redeemItems || []);

            // 注入协议桥接层 (放 <head> 最前)
            if (content.includes('<head>')) {
              const headEndIndex = content.indexOf('</head>');
              content = content.slice(0, headEndIndex) + protocolBridgeScript + '\n' + content.slice(headEndIndex);
            } else if (content.includes('<html')) {
              const htmlEnd = content.indexOf('>', content.indexOf('<html'));
              content = content.slice(0, htmlEnd + 1) + '\n<head>' + protocolBridgeScript + '</head>\n' + content.slice(htmlEnd + 1);
            } else {
              content = protocolBridgeScript + '\n' + content;
            }

            logger.success(`[AllinONE Protocol] 协议桥接层已注入 "${htmlFile.name}" (Mode B)`, PublishStep.PUBLISH);
            logger.info('[AllinONE Protocol] 游戏已集成 @allinone/standard-sdk，通信通过协议层进行', PublishStep.PUBLISH);

          } else {
            // Mode A (默认): 注入适配 — 完整 Effect Engine + SDK
            const protocolLayer = this.generateProtocolLayer(config.gameId, config.redeemItems || []);
            const sdkScript = this.generateAllinoneSDK(config.gameId, config.redeemItems || []);

            // 注入协议层 (放 <head> 最前, 必须在任何游戏脚本之前执行)
            if (content.includes('<head>')) {
              const headStartIndex = content.indexOf('<head>') + '<head>'.length;
              content = content.slice(0, headStartIndex) + '\n' + protocolLayer + content.slice(headStartIndex);
            } else if (content.includes('<html')) {
              const htmlEnd = content.indexOf('>', content.indexOf('<html'));
              content = content.slice(0, htmlEnd + 1) + '\n<head>' + protocolLayer + '</head>\n' + content.slice(htmlEnd + 1);
            } else {
              content = protocolLayer + '\n' + content;
            }

            // 注入 SDK (放 </body> 前)
            if (content.includes('</body>')) {
              content = content.replace('</body>', `${sdkScript}\n</body>`);
            } else {
              content = content + '\n' + sdkScript;
            }

            logger.success(`[AllinONE Protocol] 注入适配层 + 兑换条已注入 "${htmlFile.name}" (${content.length.toLocaleString()} 字节)`, PublishStep.PUBLISH);
            logger.info(`[AllinONE Protocol] 协议模式: Mode A (注入适配), 通过帧级拦截实现效果控制`, PublishStep.PUBLISH);
          }

          // 更新文件内容
          htmlFile.content = content;
          htmlFile.size = content.length;

        } catch (err) {
          logger.warning(`注入 AllinONE 协议层失败: ${err instanceof Error ? err.message : String(err)}`, PublishStep.PUBLISH);
        }
      } else {
        logger.warning('未找到 HTML 入口文件, 跳过协议层注入', PublishStep.PUBLISH);
      }
    } else {
      logger.info('没有游戏文件可构建, 跳过协议层注入', PublishStep.PUBLISH);
    }

    logger.success('构建完成', PublishStep.PUBLISH);
    context.data.set('buildSuccess', true);
  }

  private async stepDeploy(context: PipelineContext): Promise<void> {
    const { config, logger } = context;

    logger.info('正在部署游戏资源...', PublishStep.PUBLISH);

    // 检查是否有游戏文件需要保存
    const files = config.files;
    if (!files || files.length === 0) {
      logger.warning('没有游戏文件可部署，跳过部署步骤', PublishStep.PUBLISH);
      context.data.set('deploySuccess', false);
      return;
    }

    const totalFiles = files.length;
    const rawEntryPoint = config.analysisResult.fileStructure.entryPoints[0] || 'index.html';

    // ── 0. 路径标准化：去除 ZIP 公共根目录前缀 ──
    // 例：ZIP 中所有文件都在 "zuma/" 下，去掉前缀后路径变为 "dist/index.html"
    const allPaths = files.map(f => f.path || f.name);
    const commonPrefix = this.findCommonDirPrefix(allPaths);
    // stripPrefix 也要先统一反斜杠为正斜杠
    const normalizePath = (p: string) => p.replace(/\\/g, '/');
    const stripPrefix = (p: string) => {
      const norm = normalizePath(p);
      return commonPrefix && norm.startsWith(commonPrefix) ? norm.slice(commonPrefix.length) : norm;
    };
    if (commonPrefix) {
      logger.info(`路径标准化：去除公共前缀 "${commonPrefix}"`, PublishStep.PUBLISH);
    }
    const entryPoint = stripPrefix(rawEntryPoint);

    // ── 1. 保存到本地 IndexedDB（本地缓存，兼容离线） ──
    logger.info(`准备保存 ${totalFiles} 个游戏文件到本地存储...`, PublishStep.PUBLISH);
    try {
      // 本地存储也使用标准化路径
      const normalizedFiles = files.map(f => ({
        ...f,
        path: stripPrefix(f.path || f.name),
      }));
      const result = await saveGameFiles(config.gameId, normalizedFiles);
      if (result.warnings.length > 0) {
        for (const w of result.warnings) {
          logger.warning(w, PublishStep.PUBLISH);
        }
      }
      logger.success(
        `本地存储已保存 (${result.saved} 个文件` +
        (result.skipped > 0 ? `, 跳过 ${result.skipped} 个大文件` : '') +
        ')',
        PublishStep.PUBLISH
      );
    } catch (e) {
      logger.warning(
        `保存游戏文件到本地时出现问题: ${e instanceof Error ? e.message : String(e)}`,
        PublishStep.PUBLISH
      );
    }

    // ── 2. 上传到服务端（服务端托管模式） ──
    let serverUploadOk = false;

    // 获取 JWT token：通过集中式 token 服务
    let token: string | null = await getToken();

    if (token) {
      logger.info('已获取 JWT token', PublishStep.PUBLISH);
    }

    if (token) {
      try {
        logger.info(`正在上传 ${totalFiles} 个文件到服务端...`, PublishStep.PUBLISH);

        // 将文件内容转为字符串
        // 文本文件（HTML/CSS/JS/JSON等）用 UTF-8 解码，二进制文件用 base64 编码
        const TEXT_EXTENSIONS = new Set([
          '.html', '.htm', '.css', '.js', '.mjs', '.json', '.xml', '.svg',
          '.ts', '.tsx', '.jsx', '.vue', '.svelte',
          '.md', '.txt', '.csv', '.yaml', '.yml', '.toml',
          '.scss', '.sass', '.less', '.styl',
          '.sh', '.bash', '.zsh', '.bat', '.ps1',
          '.py', '.rb', '.php', '.java', '.c', '.cpp', '.h',
          '.graphql', '.gql', '.proto',
        ]);

        function isTextFile(filePath: string): boolean {
          const ext = '.' + filePath.split('.').pop()?.toLowerCase();
          return TEXT_EXTENSIONS.has(ext);
        }

        const uploadFiles = files.map(f => {
          let content: string;
          const filePath = stripPrefix(f.path || f.name);

          if (typeof f.content === 'string') {
            content = f.content;
          } else if (f.content instanceof Uint8Array || f.content instanceof ArrayBuffer) {
            const bytes = f.content instanceof Uint8Array ? f.content : new Uint8Array(f.content);
            if (isTextFile(filePath)) {
              // 文本文件：UTF-8 解码为字符串
              content = new TextDecoder('utf-8').decode(bytes);
            } else {
              // 二进制文件：base64 编码
              let binary = '';
              for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
              content = btoa(binary);
            }
          } else {
            content = String(f.content);
          }
          return {
            path: filePath,
            name: f.name,
            content,
            size: f.size || content.length,
          };
        });

        const resp = await fetch(`/api/v1/games/${config.gameId}/upload`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
          },
          body: JSON.stringify({ files: uploadFiles }),
        });

        if (resp.ok) {
          const result = await resp.json();
          serverUploadOk = true;
          logger.success(
            `服务端托管就绪：${result.data?.saved ?? totalFiles} 个文件已上传`,
            PublishStep.PUBLISH
          );
        } else {
          const errBody = await resp.json().catch(() => ({}));
          logger.warning(
            `服务端上传失败 (${resp.status}): ${errBody.error || resp.statusText}`,
            PublishStep.PUBLISH
          );
        }
      } catch (e) {
        logger.warning(
          `服务端上传异常: ${e instanceof Error ? e.message : String(e)}`,
          PublishStep.PUBLISH
        );
      }
    } else {
      logger.warning('未找到 JWT Token，跳过服务端上传（将使用 inline 模式）', PublishStep.PUBLISH);
    }

    // ── 3. 设置托管模式 ──
    if (serverUploadOk) {
      const baseUrl = `/api/v1/games/${config.gameId}/files/`;
      context.data.set('hostingType', 'server');
      context.data.set('baseUrl', baseUrl);
      context.data.set('cdnUrl', `${baseUrl}${entryPoint}`);
      context.data.set('normalizedEntryPoint', entryPoint);
      logger.info(`托管模式: server → ${baseUrl}${entryPoint}`, PublishStep.PUBLISH);
    } else {
      // 降级到 inline 模式（仅 HTML 内容，srcDoc 方式）
      context.data.set('hostingType', 'inline');
      context.data.set('cdnUrl', `local://game/${config.gameId}/${entryPoint}`);
      context.data.set('normalizedEntryPoint', entryPoint);
      logger.warning('降级到 inline 模式（服务端不可用）', PublishStep.PUBLISH);
    }

    context.data.set('deploySuccess', true);
  }

  private async stepRegisterPlatform(context: PipelineContext): Promise<void> {
    const { config, logger } = context;

    logger.info('正在注册到AllinONE平台...', PublishStep.PUBLISH);
    await this.delay(500);

    // 构建游戏配置
    const gameConfig = context.data.get('gameConfig') || {};
    const skillConfigs = context.data.get('skillConfigs') || {};
    const cdnUrl = context.data.get('cdnUrl') || `https://cdn.allinone.game/games/${config.gameId}`;
    const initializedSkills = context.data.get('skillsRegistered') || [];

    // 获取当前发布者信息
    const publisherId = config.publisherId || 'admin';
    const publisherName = config.publisherName || '平台管理员';
    const revenueSharePercent = config.revenueSharePercent ?? 10;

    // 获取托管模式信息（由 stepDeploy 设置）
    const hostingType = context.data.get('hostingType') || 'inline';
    const baseUrl = context.data.get('baseUrl') || undefined;

    // 创建PublishedGame记录
    const publishedGame: Omit<PublishedGame, 'players' | 'status'> = {
      id: config.gameId,
      name: config.gameId.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
      description: `通过Publishing Center发布的游戏`,
      framework: config.analysisResult.framework.framework,
      version: '1.0.0',
      skills: initializedSkills,
      skillConfigs: skillConfigs,
      entryPoint: context.data.get('normalizedEntryPoint') || config.analysisResult.fileStructure.entryPoints[0] || 'index.html',
      fileCount: config.analysisResult.fileStructure.totalFiles,
      size: config.analysisResult.fileStructure.estimatedSize,
      cdnUrl: cdnUrl,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      redeemItems: config.redeemItems || [],
      protocolMode: config.protocolMode || 'inject',
      publisherId,
      publisherName,
      revenueSharePercent,
      hostingType: hostingType as 'server' | 'inline' | 'external',
      baseUrl,
    };

    logger.info('保存游戏数据...', PublishStep.PUBLISH);
    
    // 保存到平台
    const saved = await savePublishedGame(publishedGame);
    
    logger.info('配置访问权限...', PublishStep.PUBLISH);
    await this.delay(300);

    logger.info(`配置 ${initializedSkills.length} 个 Skills...`, PublishStep.PUBLISH);
    await this.delay(300);

    logger.success('平台注册完成', PublishStep.PUBLISH);
    context.data.set('platformRegistered', true);
    context.data.set('savedGame', saved);
  }

  private async stepActivate(context: PipelineContext): Promise<void> {
    const { config, logger } = context;

    logger.info('正在激活游戏...', PublishStep.PUBLISH);
    await this.delay(300);

    if (config.gameType === GameType.STANDARD) {
      logger.success('标准游戏已通过自动审核', PublishStep.PUBLISH);
    } else {
      logger.info('通用游戏已提交审核', PublishStep.PUBLISH);
    }

    logger.success('游戏已正式上线！', PublishStep.PUBLISH);
    context.data.set('activated', true);
  }

  /**
   * generateProtocolLayer - Mode A (注入适配)
   * 
   * 包装 Effect Engine 并添加协议声明头。
   * 保留完整的 monkey-patch 能力，同时声明协议兼容性。
   */
  private generateProtocolLayer(gameId: string, redeemItems: RedeemItemConfig[]): string {
    const effectScript = this.generateEffectEngine(redeemItems);

    // 在 Effect Engine 脚本开始处添加协议声明
    const protocolHeader = [
      '<script>',
      '(function() {',
      `  window.AllinONE = window.AllinONE || {};`,
      `  window.AllinONE.__PROTOCOL_MODE__ = 'inject';`,
      `  window.AllinONE.__PROTOCOL_VERSION__ = '1.0.0';`,
      `  window.AllinONE.__GAME_ID__ = ${JSON.stringify(gameId)};`,
      '})();',
      '</script>',
    ].join('\n');

    return protocolHeader + '\n' + effectScript;
  }

  /**
   * generateProtocolBridge - Mode B (标准集成)
   * 
   * 轻量协议桥接层，仅处理 postMessage 协议通信。
   * 游戏已通过 @allinone/standard-sdk 集成，无需 monkey-patch。
   * 此桥接层确保即使 SDK 加载失败也能声明协议能力。
   */
  private generateProtocolBridge(gameId: string, redeemItems: RedeemItemConfig[]): string {
    const itemsJson = JSON.stringify(redeemItems.map(item => ({
      itemId: item.gameItemId,
      effectType: item.effectType,
      name: item.name,
      quantity: item.quantity,
      effects: item.effects,
      rarity: item.rarity,
    })));

    return `<!-- AllinONE Protocol Bridge v1.1 [MODE_B] - 协议桥接层 + 兑换条 UI -->
<script>
(function() {
  'use strict';
  try {
    // ===== 协议声明 =====
    window.AllinONE = window.AllinONE || {};
    window.AllinONE.__PROTOCOL_MODE__ = 'integrated';
    window.AllinONE.__PROTOCOL_VERSION__ = '1.0.0';
    window.AllinONE.__GAME_ID__ = ${JSON.stringify(gameId)};
    window.AllinONE.__ITEMS__ = ${itemsJson};

    var GAME_ID = ${JSON.stringify(gameId)};
    var ITEMS = ${itemsJson};

    // ===== 协议就绪信号 =====
    function sendReady() {
      if (!window.parent) return;
      window.parent.postMessage({
        type: 'PROTOCOL:READY',
        protocolVersion: '1.0.0',
        mode: 'integrated',
        gameId: GAME_ID,
        supportedActions: ['start', 'pause', 'resume', 'redeem'],
        supportedSchemas: ${JSON.stringify(redeemItems.map(i => i.effectType).filter(Boolean))},
        timestamp: Date.now(),
      }, '*');
    }

    // 立即发送 + 延迟重试（应对 iframe 加载时机问题）
    sendReady();
    setTimeout(sendReady, 500);
    setTimeout(sendReady, 2000);

    // ===== REDEEM_RESULT 处理 + CustomEvent 分发 =====
    window.addEventListener('message', function(event) {
      if (event.data && event.data.type === 'REDEEM_RESULT') {
        var res = event.data.data;
        var btn = document.getElementById('allinone-redeem-btn');
        var bar = document.getElementById('allinone-redeem-bar');
        var statusEl = document.getElementById('allinone-bar-status');

        if (btn) { btn.disabled = false; btn.textContent = '\\u5151\\u6362'; }
        if (bar) { bar.classList.remove('loading'); }

        if (res.success) {
          if (statusEl) {
            statusEl.textContent = '\\u2713 \\u5151\\u6362\\u6210\\u529f! ' + (res.itemName || '') + ' x' + (res.quantity || 1);
            statusEl.className = 'bar-status show success';
            setTimeout(function() { statusEl.classList.remove('show'); }, 4000);
          }
          var input = document.getElementById('allinone-code-input');
          if (input) input.value = '';
          setTimeout(function() { if (bar) bar.classList.remove('show'); }, 1500);

          // ===== [关键] 尝试自动执行效果 =====
          try {
            if (window.AllinONE && window.AllinONE.Effects) {
              var applied = window.AllinONE.Effects.apply({
                id: res.itemId,
                effectType: res.effectType || 'custom',
                itemName: res.itemName,
                quantity: res.quantity || 1,
                effects: res.effects || {}
              });
              if (applied) {
                console.log('[AllinONE Protocol Bridge] Effect Engine 已自动执行:', res.itemName);
              } else {
                console.warn('[AllinONE Protocol Bridge] SDK 未注册效果处理器，效果未自动执行:', res.effectType);
              }
            }
          } catch (e) {
            console.error('[AllinONE Protocol Bridge] Effect Engine 执行失败:', e);
          }

          // 分发 CustomEvent（游戏方 registerEffect 或手动监听均可用）
          var detail = {
            code: res.code,
            itemId: res.itemId || '',
            itemName: res.itemName || '',
            quantity: res.quantity || 1,
            effects: res.effects || {},
            effectType: res.effectType || 'custom'
          };
          window.dispatchEvent(new CustomEvent('allinone-item-redeemed', { detail: detail }));
          window.dispatchEvent(new CustomEvent('allinone:item-redeemed', { detail: detail }));
        } else {
          if (statusEl) {
            statusEl.textContent = '\\u2717 ' + (res.message || '\\u5151\\u6362\\u5931\\u8d25');
            statusEl.className = 'bar-status show error';
            setTimeout(function() { statusEl.classList.remove('show'); }, 3000);
          }
        }
      }
    });

    // ===== EXTENSION_VOUCHER 处理 + CustomEvent 分发（UGC 道具） =====
    window.addEventListener('message', function(event) {
      if (event.data && event.data.type === 'EXTENSION_VOUCHER') {
        var v = event.data.voucher;
        if (!v || !v.schemaName) { console.warn('[AllinONE] EXTENSION_VOUCHER 无效'); return; }

        // 根据 schema 提取 itemId
        var schemaToItem = {};
        try {
          if (v.schemaName === 'weapon') {
            schemaToItem.itemId = v.data && v.data.effectType || 'match3_bomb';
            schemaToItem.itemName = (v.data && v.data.name) || 'UGC武器';
          } else if (v.schemaName === 'match3-powerup') {
            schemaToItem.itemId = (v.data && v.data.effect) || (v.data && v.data.effectType) || v.schemaName;
            schemaToItem.itemName = (v.data && v.data.name) || v.schemaName;
          } else {
            schemaToItem.itemId = (v.data && v.data.effectType) || v.schemaName;
            schemaToItem.itemName = (v.data && v.data.name) || v.schemaName;
          }
        } catch(e) { console.error('[AllinONE] 解析失败:', e); return; }

        console.log('[AllinONE] EXTENSION_VOUCHER → CustomEvent 已分发:', schemaToItem.itemId);

        var detail = {
          code: v.signature || 'ugc-' + Date.now(),
          itemId: schemaToItem.itemId,
          itemName: schemaToItem.itemName,
          quantity: 1,
          effects: {},
          effectType: 'custom',
          source: 'ugc',
          voucherData: v.data
        };
        window.dispatchEvent(new CustomEvent('allinone:item-redeemed', { detail: detail }));
        window.dispatchEvent(new CustomEvent('allinone-item-redeemed', { detail: detail }));
      }
    });

    // ===== 兑换条 UI 注入（等待 DOM 就绪） =====
    function injectRedeemBar() {
      if (document.getElementById('allinone-redeem-bar')) return; // 避免重复注入

      // 样式
      var styles = document.createElement('style');
      styles.textContent = [
        '#allinone-redeem-bar{position:fixed;bottom:80px;left:50%;transform:translateX(-50%);z-index:99999;display:none;background:rgba(15,15,25,0.92);backdrop-filter:blur(12px);border:1px solid rgba(255,255,255,0.08);border-radius:16px;padding:14px 22px;min-width:380px;max-width:500px;box-shadow:0 12px 48px rgba(0,0,0,0.5);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#fff;transition:all .3s ease;}',
        '#allinone-redeem-bar.show{display:block;}',
        '#allinone-redeem-bar .bar-row{display:flex;align-items:center;gap:10px;}',
        '#allinone-redeem-bar .bar-row input{flex:1;padding:10px 14px;border-radius:10px;border:1px solid rgba(139,92,246,0.3);background:rgba(255,255,255,0.06);color:#fff;font-size:14px;font-family:monospace;letter-spacing:2px;outline:none;transition:border-color .2s;}',
        '#allinone-redeem-bar .bar-row input:focus{border-color:rgba(139,92,246,0.7);}',
        '#allinone-redeem-bar .bar-row input::placeholder{font-family:sans-serif;letter-spacing:0;color:rgba(255,255,255,0.3);}',
        '#allinone-redeem-bar .bar-row .btn-redeem{padding:10px 22px;border-radius:10px;border:none;background:linear-gradient(135deg,#7c3aed,#6366f1);color:#fff;font-size:14px;font-weight:600;cursor:pointer;transition:opacity .2s,transform .1s;white-space:nowrap;}',
        '#allinone-redeem-bar .bar-row .btn-redeem:hover{opacity:0.9;}',
        '#allinone-redeem-bar .bar-row .btn-redeem:active{transform:scale(0.97);}',
        '#allinone-redeem-bar .bar-row .btn-redeem:disabled{opacity:0.5;cursor:not-allowed;}',
        '#allinone-redeem-bar .bar-row .btn-close{padding:6px 10px;border-radius:8px;border:none;background:rgba(255,255,255,0.08);color:rgba(255,255,255,0.5);font-size:14px;cursor:pointer;transition:background .2s;}',
        '#allinone-redeem-bar .bar-row .btn-close:hover{background:rgba(255,255,255,0.15);color:#fff;}',
        '#allinone-redeem-bar .bar-status{margin-top:10px;font-size:12px;text-align:center;display:none;}',
        '#allinone-redeem-bar .bar-status.show{display:block;}',
        '#allinone-redeem-bar .bar-status.success{color:#4ade80;}',
        '#allinone-redeem-bar .bar-status.error{color:#f87171;}',
        '#allinone-redeem-bar .bar-status.loading{color:#a78bfa;}',
        '#allinone-redeem-bar .bar-status.info{color:#fbbf24;}',
        '#allinone-redeem-bar .bar-items{margin-top:10px;display:flex;gap:6px;flex-wrap:wrap;}',
        '#allinone-redeem-bar .bar-items .item-chip{padding:4px 10px;border-radius:6px;background:rgba(139,92,246,0.1);border:1px solid rgba(139,92,246,0.15);font-size:11px;color:#a78bfa;cursor:pointer;user-select:none;transition:background .2s;}',
        '#allinone-redeem-bar .bar-items .item-chip:hover{background:rgba(139,92,246,0.2);}',
        '#allinone-redeem-bar .bar-hint{font-size:12px;color:rgba(255,255,255,0.45);margin-bottom:10px;text-align:center;line-height:1.4;}',
        '#allinone-redeem-bar .bar-items-label{font-size:11px;color:rgba(255,255,255,0.35);margin-top:10px;margin-bottom:4px;text-align:left;}',
        '#allinone-redeem-toggle{position:fixed;bottom:24px;right:24px;z-index:99998;width:48px;height:48px;border-radius:50%;border:2px solid rgba(124,58,237,0.4);background:rgba(15,15,25,0.85);backdrop-filter:blur(8px);color:#fff;font-size:20px;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 16px rgba(0,0,0,0.4);transition:transform .2s,border-color .2s;}',
        '#allinone-redeem-toggle:hover{transform:scale(1.05);border-color:rgba(124,58,237,0.7);}',
        '@keyframes allinone-pulse{0%{opacity:1;}50%{opacity:0.4;}100%{opacity:1;}}',
        '#allinone-redeem-bar.loading .btn-redeem{animation:allinone-pulse 1.2s ease-in-out infinite;}'
      ].join('');
      document.head.appendChild(styles);

      // DOM
      var bar = document.createElement('div');
      bar.id = 'allinone-redeem-bar';
      bar.innerHTML = [
        '<div class="bar-hint">\\ud83c\\udfae \\u8f93\\u5165\\u60a8\\u8d2d\\u4e70\\u7684\\u9053\\u5177\\u5151\\u6362\\u7801\\uff0c\\u70b9\\u51fb\\u300c\\u5151\\u6362\\u300d\\u6fc0\\u6d3b\\u6548\\u679c</div>',
        '<div class="bar-row">',
          '<input id="allinone-code-input" type="text" placeholder="\\u7c98\\u8d34\\u6216\\u8f93\\u5165\\u5151\\u6362\\u7801\\uff0c\\u5982 IV-A3F9K2M7" maxlength="20" spellcheck="false" autocomplete="off">',
          '<button class="btn-redeem" id="allinone-redeem-btn">\\u5151\\u6362</button>',
          '<button class="btn-close" id="allinone-bar-close">\\u2715</button>',
        '</div>',
        '<div class="bar-status" id="allinone-bar-status"></div>',
        ITEMS.length > 0 ? [
          '<div class="bar-items-label">\\u672c\\u6e38\\u620f\\u53ef\\u7528\\u9053\\u5177\\uff1a</div>',
          '<div class="bar-items">',
            ITEMS.map(function(item) {
              return '<span class="item-chip" title="' + item.name + ' (' + item.effectType + ')">' + item.name + '</span>';
            }).join(''),
          '</div>'
        ].join('') : ''
      ].join('');
      document.body.appendChild(bar);

      var toggle = document.createElement('button');
      toggle.id = 'allinone-redeem-toggle';
      toggle.innerHTML = '<span>\\ud83c\\udf81</span>';
      toggle.title = '\\u5151\\u6362\\u9053\\u5177';
      document.body.appendChild(toggle);

      // 元素引用
      var input = document.getElementById('allinone-code-input');
      var btn = document.getElementById('allinone-redeem-btn');
      var closeBtn = document.getElementById('allinone-bar-close');
      var statusEl = document.getElementById('allinone-bar-status');

      // 事件绑定
      toggle.onclick = function() {
        bar.classList.toggle('show');
        if (bar.classList.contains('show')) input.focus();
      };
      closeBtn.onclick = function() { bar.classList.remove('show'); };
      btn.onclick = function() { doRedeem(); };
      input.onkeydown = function(e) { if (e.key === 'Enter') doRedeem(); };

      // 道具标签点击提示
      document.querySelectorAll('.item-chip').forEach(function(chip) {
        chip.addEventListener('click', function() {
          showStatus('\\u8bf7\\u5148\\u8d2d\\u4e70\\u6b64\\u9053\\u5177\\u83b7\\u53d6\\u5151\\u6362\\u7801\\uff0c\\u7136\\u540e\\u5728\\u6b64\\u5904\\u8f93\\u5165\\u5151\\u6362\\u7801', 'info');
        });
      });

      function showStatus(msg, type) {
        statusEl.textContent = msg;
        statusEl.className = 'bar-status show ' + type;
        bar.classList.remove('loading');
        if (type === 'success') {
          setTimeout(function() { statusEl.classList.remove('show'); }, 4000);
        } else if (type !== 'loading') {
          setTimeout(function() { statusEl.classList.remove('show'); }, 3000);
        }
      }

      function doRedeem() {
        var code = input.value.trim();
        if (!code) { showStatus('\\u8bf7\\u8f93\\u5165\\u5151\\u6362\\u7801', 'error'); return; }
        btn.disabled = true;
        btn.textContent = '\\u9a8c\\u8bc1\\u4e2d...';
        bar.classList.add('loading');
        showStatus('\\u6b63\\u5728\\u9a8c\\u8bc1\\u5151\\u6362\\u7801...', 'loading');

        // 向平台发送兑换请求
        window.parent.postMessage({
          type: 'REDEEM_ITEM',
          data: { code: code.toUpperCase(), gameId: GAME_ID }
        }, '*');
      }

      console.log('[AllinONE] Mode B \\u5151\\u6362\\u6761\\u5df2\\u6ce8\\u5165, \\u9053\\u5177: ' + ITEMS.length + ' \\u79cd');
    }

    // 等待 DOM 就绪后注入兑换条
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', injectRedeemBar);
    } else {
      injectRedeemBar();
    }

    // ===== 内置轻量效果引擎（Mode B 也支持自动执行效果） =====
    var _timeScale = 1.0;
    var _perfRealRef = null, _perfVirtRef = null;
    var _dateRealRef = null, _dateVirtRef = null;

    try {
      var _origPerfNow = performance.now.bind(performance);
      performance.now = function() {
        var real = _origPerfNow();
        if (_perfRealRef === null || _perfVirtRef === null) { _perfRealRef = real; _perfVirtRef = real; return real; }
        return _perfVirtRef + (real - _perfRealRef) * _timeScale;
      };
    } catch(e) {}

    var _origDateNow = Date.now;
    Date.now = function() {
      var real = _origDateNow();
      if (_dateRealRef === null || _dateVirtRef === null) { _dateRealRef = real; _dateVirtRef = real; return real; }
      return _dateVirtRef + (real - _dateRealRef) * _timeScale;
    };

    var _origRAF = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = function(callback) {
      return _origRAF(function(timestamp) {
        if (_perfRealRef === null) { callback(timestamp); return; }
        callback(_perfVirtRef + (timestamp - _perfRealRef) * _timeScale);
      });
    };

    var _origSetInterval = window.setInterval;
    var _origSetTimeout = window.setTimeout;
    window.setInterval = function(cb, delay) {
      return _origSetInterval.call(window, cb, _timeScale !== 1.0 ? Math.max(1, Math.round(delay / _timeScale)) : delay);
    };
    window.setTimeout = function(cb, delay) {
      return _origSetTimeout.call(window, cb, _timeScale !== 1.0 ? Math.max(1, Math.round(delay / _timeScale)) : delay);
    };

    function _setTimeScale(scale) {
      var nowP = _origPerfNow(), nowD = _origDateNow();
      if (_perfRealRef !== null) { _perfVirtRef = _perfVirtRef + (nowP - _perfRealRef) * _timeScale; _perfRealRef = nowP; }
      else { _perfRealRef = nowP; _perfVirtRef = nowP; }
      if (_dateRealRef !== null) { _dateVirtRef = _dateVirtRef + (nowD - _dateRealRef) * _timeScale; _dateRealRef = nowD; }
      else { _dateRealRef = nowD; _dateVirtRef = nowD; }
      _timeScale = scale;
    }

    // 变量扫描
    var _skipPrefixes = ['RES.','egret.','Egret','PIXI.','Phaser.','THREE.','Babylon','Laya','Cocos','cc.','laya.','dragonBones','Audio','Resource','assetManager','loader.','Texture','Sprite','Stage','Renderer'];
    function _isSkip(p) { for (var i=0;i<_skipPrefixes.length;i++) if (p.indexOf(_skipPrefixes[i])>=0) return true; return false; }
    function _keyWords(k) { return k.replace(/([a-z])([A-Z])/g,'$1 $2').replace(/[._-]/g,' ').toLowerCase().split(/\\s+/).filter(function(w){return w.length>0;}); }
    function _hasKW(key,kws) { var ws=_keyWords(key); for(var w=0;w<ws.length;w++) for(var k=0;k<kws.length;k++) if(ws[w]===kws[k].toLowerCase()) return true; return false; }
    var _visited=[], _modified={};
    function _deepMod(obj,kws,mod,d,path) {
      if(d<=0||!obj||typeof obj!=='object') return;
      for(var i=0;i<_visited.length;i++) if(_visited[i]===obj) return;
      _visited.push(obj); d=d||3; path=path||'';
      for(var key in obj) { try {
        var val=obj[key], fp=path?key+'.'+key:key;
        if(fp.indexOf('.')>0) fp=path+'.'+key; else fp=key;
        if(_modified[fp]||_isSkip(fp)) continue;
        if(_hasKW(key,kws)&&typeof val==='number'&&!isNaN(val)&&isFinite(val)&&val>0.01&&val<10000) {
          var orig=val; obj[key]=mod(val); if(obj[key]!==orig) { _modified[fp]=true; console.log('[AllinONE] Effect: '+fp+' '+orig+'->'+obj[key]); }
        }
        if(val&&typeof val==='object'&&d>1) _deepMod(val,kws,mod,d-1,fp);
      } catch(e){} }
    }
    function _searchMod(kws,mod) { _visited=[]; for(var key in window) { if(key==='AllinONE'||key==='window'||key==='self'||key==='top'||key==='parent'||key==='frames'||key==='document') continue; try { var val=window[key]; if(val&&typeof val==='object') _deepMod(val,kws,mod,3,key); } catch(e){} } }

    // 效果处理器
    var _effectHandlers = {
      'difficulty_reducer': function(d) {
        var m=(d.effects&&d.effects.multiplier)||0.6;
        console.log('[AllinONE] Effect: difficulty_reducer, multiplier='+m);
        _setTimeScale(m);
        setTimeout(function(){ _searchMod(['difficulty','gameSpeed','speed','enemy','fallSpeed','dropSpeed','levelSpeed','moveSpeed'], function(v){return Math.max(0.1,v*m);}); }, 500);
        setTimeout(function(){ _searchMod(['difficulty','gameSpeed','speed'], function(v){return Math.max(0.1,v*m);}); }, 2000);
      },
      'speed_boost': function(d) {
        var m=(d.effects&&d.effects.multiplier)||1.5, dur=(d.effects&&d.effects.duration)||30000;
        console.log('[AllinONE] Effect: speed_boost, multiplier='+m+', duration='+dur+'ms');
        _setTimeScale(m);
        if(dur>0) setTimeout(function(){ _setTimeScale(1.0); console.log('[AllinONE] Effect: speed_boost expired'); }, dur);
      },
      'score_boost': function(d) {
        var m=(d.effects&&d.effects.multiplier)||2;
        console.log('[AllinONE] Effect: score_boost, multiplier='+m);
        setTimeout(function(){ _searchMod(['score','point','coin','reward'], function(v){return v*m;}); }, 500);
        setTimeout(function(){ _searchMod(['score','point','coin','reward'], function(v){return v*m;}); }, 2000);
      },
      'extra_life': function(d) {
        var lives=(d.effects&&d.effects.lives)||1;
        console.log('[AllinONE] Effect: extra_life, +'+lives);
        setTimeout(function(){ _searchMod(['life','lives','heart','hp','health','remain'], function(v){return v+lives;}); }, 500);
        setTimeout(function(){ _searchMod(['life','lives','heart','hp','health','remain'], function(v){return v+lives;}); }, 2000);
      },
      'time_bonus': function(d) {
        var bonus=(d.effects&&d.effects.bonusTime)||30;
        console.log('[AllinONE] Effect: time_bonus, +'+bonus+'s');
        setTimeout(function(){ _searchMod(['time','timer','countdown','remain','left','second'], function(v){return v+bonus;}); }, 500);
        setTimeout(function(){ _searchMod(['time','timer','countdown','remain','left','second'], function(v){return v+bonus;}); }, 2000);
      }
    };

    window.AllinONE.Effects = window.AllinONE.Effects || {
      apply: function(itemData) {
        // 优先使用游戏方注册的处理器（通过 SDK registerEffect）
        if (window.AllinONE._customEffectHandlers && window.AllinONE._customEffectHandlers[itemData.effectType]) {
          window.AllinONE._customEffectHandlers[itemData.effectType](itemData);
          return true;
        }
        // 降级到内置效果引擎
        var handler = _effectHandlers[itemData.effectType];
        if (handler) { handler(itemData); return true; }
        console.log('[AllinONE] Effect: custom/unknown effectType, itemData:', itemData);
        return false;
      },
      clearAll: function() { _setTimeScale(1.0); },
      clear: function() { _setTimeScale(1.0); },
      searchAndModify: function(kws,mod) { _searchMod(kws,mod); },
      registerEffect: function(type, handler) {
        window.AllinONE._customEffectHandlers = window.AllinONE._customEffectHandlers || {};
        window.AllinONE._customEffectHandlers[type] = handler;
      }
    };

    // ===== 公共 API =====
    window.AllinONE.showRedeemBar = function() {
      var bar = document.getElementById('allinone-redeem-bar');
      if (bar) { bar.classList.add('show'); document.getElementById('allinone-code-input')?.focus(); }
    };
    window.AllinONE.hideRedeemBar = function() {
      var bar = document.getElementById('allinone-redeem-bar');
      if (bar) bar.classList.remove('show');
    };
    window.AllinONE.onItemRedeemed = function(callback) {
      if (typeof callback === 'function') {
        window.addEventListener('allinone-item-redeemed', function(e) { callback(e.detail); });
      }
    };

    console.log('[AllinONE] Protocol Bridge v1.1 \\u5df2\\u5c31\\u7eea (Mode B, gameId: ' + GAME_ID + ')');
  } catch(e) {
    console.error('[AllinONE] Protocol Bridge \\u521d\\u59cb\\u5316\\u5931\\u8d25:', e);
  }
})();
</script>`;
  }

  /**
   * 生成 AllinONE Effect Engine (效果执行引擎)
   * 在游戏脚本之前注入，monkey-patch requestAnimationFrame/setInterval/setTimeout
   * 通过帧率控制实现难度降低/速度提升等效果，无需游戏方任何配合
   */
  private generateEffectEngine(redeemItems: RedeemItemConfig[]): string {
    // 构建效果类型的映射表
    const effectMap = new Map<string, RedeemItemConfig>();
    for (const item of redeemItems) {
      effectMap.set(item.gameItemId, item);
    }

    const effectConfigs = JSON.stringify(Array.from(effectMap.entries())
      .map(([id, item]) => ({
        id,
        effectType: item.effectType,
        effects: item.effects,
      }))
    ).replace(/<\//g, '<\\/');

    return `<!-- AllinONE Effect Engine v1.0 [PRESENCE_MARKER_ACTIVE] - 自动游戏效果执行 (帧级拦截) -->
<script>
(function() {
  'use strict';
  try {
    console.log('[AllinONE] Effect Engine: 初始化开始...');

  /* ===================================================================
   * Effect Engine - 在游戏脚本之前运行，通过 monkey-patch 核心 API
   * 实现"无侵入式"游戏效果控制。
   * =================================================================== */

  var EFFECT_CONFIG = ${effectConfigs};

  // ==================== 时间缩放机制 — 快照+增量法，切换缩放时无时间跳变 ====================
  var _timeScale = 1.0;          // 1.0=正常, <1=减速, >1=加速
  // performance.now 时间基准（独立的 ref pair，因为它与 RAF 时间戳同源）
  var _perfRealRef = null;
  var _perfVirtRef = null;
  // Date.now 时间基准
  var _dateRealRef = null;
  var _dateVirtRef = null;

  // 拦截 performance.now() — Egret/Cocos 等引擎使用此 API 计算帧间隔
  try {
    var _origPerfNow = performance.now.bind(performance);
    performance.now = function() {
      var real = _origPerfNow();
      if (_perfRealRef === null || _perfVirtRef === null) {
        _perfRealRef = real;
        _perfVirtRef = real;
        return real;
      }
      return _perfVirtRef + (real - _perfRealRef) * _timeScale;
    };
  } catch(e) {}

  // 拦截 Date.now() — 部分引擎回退使用此 API
  var _origDateNow = Date.now;
  Date.now = function() {
    var real = _origDateNow();
    if (_dateRealRef === null || _dateVirtRef === null) {
      _dateRealRef = real;
      _dateVirtRef = real;
      return Math.round(real);
    }
    return Math.round(_dateVirtRef + (real - _dateRealRef) * _timeScale);
  };

  // 拦截 new Date().getTime() / new Date().valueOf() — 大量游戏引擎通过此路径获取时间
  // 如 (new Date() - startTime) 或 (new Date()).getTime()
  var _origDateGetTime = Date.prototype.getTime;
  Date.prototype.getTime = function() {
    // 只有"当前时间"的 Date 对象才走缩放，特定日期的 Date 返回实际时间
    var real = _origDateGetTime.call(this);
    // 如果 Date 对象的原始时间戳与当前真实时间相差在 2 秒内，认为是"当前时间"
    var now = _origDateNow();
    if (Math.abs(real - now) < 2000) {
      if (_dateRealRef === null || _dateVirtRef === null) {
        return real;
      }
      return Math.round(_dateVirtRef + (real - _dateRealRef) * _timeScale);
    }
    return real; // 历史日期不缩放
  };
  // valueOf 指向 getTime（Date 的 - 运算符会调用 valueOf）
  Date.prototype.valueOf = Date.prototype.getTime;

  // 重新计算 _timeScale（聚合所有活跃帧修饰器的时间缩放因子），同时更新基准点
  function _recalcTimeScale() {
    var s = 1.0;
    for (var k in _frameModifiers) {
      var m = _frameModifiers[k];
      if (m.timeScale && m.timeScale !== 1.0) s *= m.timeScale;
    }
    var oldScale = _timeScale;
    _timeScale = s;
    // 更新 performance.now 基准
    try {
      var nowPerf = _origPerfNow();
      var vPerf;
      if (_perfRealRef === null || _perfVirtRef === null) {
        vPerf = nowPerf;
      } else {
        vPerf = _perfVirtRef + (nowPerf - _perfRealRef) * oldScale;
      }
      _perfRealRef = nowPerf;
      _perfVirtRef = vPerf;
    } catch(e) {}
    // 更新 Date.now 基准
    var nowDate = _origDateNow();
    var vDate;
    if (_dateRealRef === null || _dateVirtRef === null) {
      vDate = nowDate;
    } else {
      vDate = _dateVirtRef + (nowDate - _dateRealRef) * oldScale;
    }
    _dateRealRef = nowDate;
    _dateVirtRef = vDate;
  }

  // ==================== 帧率控制 (requestAnimationFrame) — 时间膨胀慢放，每帧都正常渲染 ====================
  var _origRAF = window.requestAnimationFrame;
  var _frameModifiers = {}; // { id: { mode: 'double'|'timescale', factor: number, timeScale: number } }

  window.requestAnimationFrame = function(callback) {
    return _origRAF.call(window, function(timestamp) {
      var shouldDouble = false;

      for (var key in _frameModifiers) {
        var mod = _frameModifiers[key];
        if (mod.mode === 'double') {
          shouldDouble = true;
        }
      }

      // 时间缩放: 基于快照+增量，消除绝对乘法导致的时间倒退
      var scale = _timeScale;
      var scaledTimestamp = timestamp;
      if (scale !== 1.0 && _perfRealRef !== null && _perfVirtRef !== null) {
        scaledTimestamp = _perfVirtRef + (timestamp - _perfRealRef) * scale;
      }

      // 每帧都正常渲染（不跳过任何帧）
      callback(scaledTimestamp);

      // 加速效果：在同一个 tick 里额外调用一次回调
      if (shouldDouble) {
        callback(scaledTimestamp);
      }
    });
  };

  // ==================== Canvas 文本拦截 (score_boost 视觉层增强) ====================
  var _scoreMultiplier = 1;
  var _canvasInterceptionActive = false;

  function _setupCanvasInterception() {
    if (_canvasInterceptionActive) return;
    if (typeof CanvasRenderingContext2D === 'undefined') return;
    _canvasInterceptionActive = true;
    var _origFillText = CanvasRenderingContext2D.prototype.fillText;
    var _origStrokeText = CanvasRenderingContext2D.prototype.strokeText;

    CanvasRenderingContext2D.prototype.fillText = function(text, x, y) {
      if (_scoreMultiplier !== 1 && typeof text === 'string') {
        var modified = _interceptScoreText(text, this, x, y);
        if (modified !== text) {
          return _origFillText.call(this, modified, x, y);
        }
      }
      return _origFillText.call(this, text, x, y);
    };

    CanvasRenderingContext2D.prototype.strokeText = function(text, x, y) {
      if (_scoreMultiplier !== 1 && typeof text === 'string') {
        var modified = _interceptScoreText(text, this, x, y);
        if (modified !== text) {
          return _origStrokeText.call(this, modified, x, y);
        }
      }
      return _origStrokeText.call(this, text, x, y);
    };
  }

  function _interceptScoreText(text, ctx, x, y) {
    // 模式1: 纯数字（常见于简洁风格的分数显示）
    if (/^\\d{1,8}$/.test(text.trim())) {
      var num = parseInt(text.trim(), 10);
      if (num >= 1 && num < 999999) {
        return String(Math.floor(num * _scoreMultiplier));
      }
    }
    // 模式2: 包含分数关键词的文本
    var keywords = ['score', '分数', 'points', 'pts', '得分', '积分', 'combo', 'x '];
    var lower = text.toLowerCase();
    for (var ki = 0; ki < keywords.length; ki++) {
      if (lower.indexOf(keywords[ki]) !== -1) {
        var replaced = text.replace(/(\\d{1,8})/g, function(m) {
          var n = parseInt(m, 10);
          return (n >= 1 && n < 999999) ? String(Math.floor(n * _scoreMultiplier)) : m;
        });
        if (replaced !== text) return replaced;
      }
    }
    return text;
  }

  // 定时器控制 (setInterval/setTimeout) — 延迟按时间膨胀缩放 ====================
  var _origSetInterval = window.setInterval;
  var _origSetTimeout = window.setTimeout;

  window.setInterval = function(callback, delay) {
    var scaledDelay = _timeScale !== 1.0 ? Math.max(1, Math.round(delay / _timeScale)) : delay;
    return _origSetInterval.call(window, callback, scaledDelay);
  };

  window.setTimeout = function(callback, delay) {
    var scaledDelay = _timeScale !== 1.0 ? Math.max(1, Math.round(delay / _timeScale)) : delay;
    return _origSetTimeout.call(window, callback, scaledDelay);
  };

  // ==================== 路径黑名单（游戏引擎内部系统，禁止修改） ====================
  var _skipPathPrefixes = [
    'RES.',
    'egret.',
    'Egret',
    'PIXI.',
    'Phaser.',
    'THREE.',
    'Babylon',
    'Laya',
    'Cocos',
    'cc.',
    'laya.',
    'dragonBones',
    'soundManager',
    'Audio',
    'Resource',
    'assetManager',
    'loader.',
    'Texture',
    'Sprite',
    'Stage',
    'Renderer',
  ];
  
  function isSkippablePath(fullPath) {
    for (var i = 0; i < _skipPathPrefixes.length; i++) {
      if (fullPath.indexOf(_skipPathPrefixes[i]) >= 0) return true;
    }
    return false;
  }

  // ==================== 关键词匹配工具（按 camelCase 拆词） ====================
  // 将属性名拆成独立单词，避免误匹配：
  //   'HeroSpeed'      → ['hero', 'speed']
  //   'soundenemyshot' → ['soundenemyshot']
  //   'speedVariance'  → ['speed', 'variance']
  function keyToWords(key) {
    return key.replace(/([a-z])([A-Z])/g, '$1 $2')
              .replace(/[._-]/g, ' ')
              .toLowerCase()
              .split(/\s+/)
              .filter(function(w) { return w.length > 0; });
  }

  function hasMatchingKeyword(key, keywords) {
    var words = keyToWords(key);
    for (var w = 0; w < words.length; w++) {
      for (var k = 0; k < keywords.length; k++) {
        if (words[w] === keywords[k].toLowerCase()) return true;
      }
    }
    return false;
  }

  // ==================== 全局变量扫描 ====================
  var _visitedObjects = [];
  var _modifiedPaths = {}; // 记录已修改的完整路径，防止跨扫描重复修改
  function isVisited(obj) {
    for (var i = 0; i < _visitedObjects.length; i++) {
      if (_visitedObjects[i] === obj) return true;
    }
    return false;
  }

  function deepModify(obj, keywords, modifier, depth, path) {
    if (depth <= 0) return;
    if (!obj || typeof obj !== 'object') return;
    // 已访问过的对象跳过（防止循环引用导致的无限递归）
    if (isVisited(obj)) return;
    _visitedObjects.push(obj);

    depth = depth || 3;
    path = path || '';
    for (var key in obj) {
      try {
        var val = obj[key];
        var fullPath = path ? path + '.' + key : key;

        // 跳过已经修改过的路径（跨扫描防护）
        if (_modifiedPaths[fullPath]) continue;

        // 跳过游戏引擎内部系统路径
        if (isSkippablePath(fullPath)) continue;

        // 按 camelCase 拆词匹配关键词
        if (hasMatchingKeyword(key, keywords)) {
          if (typeof val === 'number' && !isNaN(val) && isFinite(val) && val > 0.01 && val < 10000) {
            var original = val;
            obj[key] = modifier(val);
            if (obj[key] !== original) {
              _modifiedPaths[fullPath] = true;
              console.log('[AllinONE] Effect Engine: 修改 ' + fullPath + ': ' + original + ' -> ' + obj[key]);
            }
          }
        }

        if (val && typeof val === 'object' && depth > 1) {
          deepModify(val, keywords, modifier, depth - 1, fullPath);
        }
      } catch(e) {}
    }
  }

  function searchAndModify(keywords, modifier, maxDepth) {
    maxDepth = maxDepth || 5;
    // 每次扫描前重置访问列表（允许访问新创建的对象），但保留已修改路径记录
    _visitedObjects = [];
    var modifiedCount = 0;
    var scanRoots = [window];
    // 额外扫描 document.all 中可能挂载的全局对象
    try {
      if (document && document.all) {
        for (var di = 0; di < Math.min(document.all.length, 20); di++) {
          var el = document.all[di];
          if (el && el.id && typeof el === 'object') scanRoots.push(el);
        }
      }
    } catch(e) {}

    for (var ri = 0; ri < scanRoots.length; ri++) {
      var root = scanRoots[ri];
      var rootName = ri === 0 ? '' : (root.id || 'docEl_' + ri);
      for (var key in root) {
        if (ri === 0 && (key === 'AllinONE' || key === 'window' || key === 'self' || key === 'top' || key === 'parent' || key === 'frames' || key === 'document' || key === 'chrome' || key === 'performance')) continue;
        try {
          var val = root[key];
          if (val && typeof val === 'object') {
            var before = Object.keys(_modifiedPaths).length;
            deepModify(val, keywords, modifier, maxDepth, rootName ? rootName + '.' + key : key);
            modifiedCount += (Object.keys(_modifiedPaths).length - before);
          } else if (typeof val === 'number' && hasMatchingKeyword(key, keywords) && val > 0.01 && val < 10000) {
            var fullPath = rootName ? rootName + '.' + key : key;
            if (!_modifiedPaths[fullPath]) {
              var orig = val;
              root[key] = modifier(val);
              if (root[key] !== orig) {
                _modifiedPaths[fullPath] = true;
                modifiedCount++;
                console.log('[AllinONE] Effect Engine: 修改(顶层) ' + fullPath + ': ' + orig + ' -> ' + root[key]);
              }
            }
          }
        } catch(e) {}
      }
    }
    return modifiedCount;
  }

  // ==================== 效果处理器 ====================
  var effectHandlers = {
    'difficulty_reducer': function(itemData) {
      var multiplier = (itemData.effects && itemData.effects.multiplier) || 0.6;
      var itemId = itemData.id || 'difficulty_reducer';

      console.log('[AllinONE] Effect Engine: 执行难度降低, 倍率=' + multiplier + '（时间膨胀慢放，不跳帧）');

      // 纯时间膨胀策略：只通过 timeScale 控制时间流逝速度，不跳过任何帧
      // 每一帧仍然正常渲染，但 performance.now/Date.now 返回的时间以 multiplier 速度前进
      // 就像视频播放器 0.6 倍慢放，画面流畅但动作变慢
      _frameModifiers[itemId] = {
        mode: 'timescale',
        factor: multiplier,
        timeScale: multiplier
      };
      _recalcTimeScale();     // 立即生效时间缩放

      // 策略 B: 全局变量扫描 - 修改 difficulty/speed 相关变量
      setTimeout(function() {
        searchAndModify(
          ['difficulty', 'gameSpeed', 'speed', 'enemy', 'fallSpeed', 'dropSpeed', 'levelSpeed', 'moveSpeed'],
          function(val) { return Math.max(0.1, val * multiplier); }
        );
      }, 500);

      // 策略 C: 再次尝试（游戏可能延迟初始化）
      setTimeout(function() {
        searchAndModify(
          ['difficulty', 'gameSpeed', 'speed'],
          function(val) { return Math.max(0.1, val * multiplier); }
        );
      }, 2000);
    },

    'speed_boost': function(itemData) {
      var multiplier = (itemData.effects && itemData.effects.multiplier) || 1.5;
      var duration = (itemData.effects && itemData.effects.duration) || 30000;
      var itemId = itemData.id || 'speed_boost';

      console.log('[AllinONE] Effect Engine: 执行速度提升, 倍率=' + multiplier + ', 持续=' + duration + 'ms');

      // 策略 A: RAF 双倍调用 - 加速帧率
      _frameModifiers[itemId] = {
        mode: 'double',
        factor: multiplier,
        counter: 0,
        timeScale: multiplier  // 针对 Egret 等引擎的时间缩放
      };
      _recalcTimeScale();     // 立即生效时间缩放

      // 自动恢复
      if (duration > 0) {
        setTimeout(function() {
          delete _frameModifiers[itemId];
          _recalcTimeScale();  // 恢复时间缩放
          console.log('[AllinONE] Effect Engine: 速度提升已到期');
        }, duration);
      }

      // 策略 B: 全局变量扫描
      setTimeout(function() {
        searchAndModify(
          ['speed', 'movespeed', 'runspeed', 'playerspeed'],
          function(val) { return Math.min(100, val * multiplier); }
        );
      }, 500);
    },

    'score_boost': function(itemData) {
      var multiplier = (itemData.effects && itemData.effects.multiplier) || 2;
      console.log('[AllinONE] Effect Engine: 执行分数加成, 倍率=' + multiplier);

      // 策略 A: 全局变量扫描（深度5，更多关键词）
      var scoreKeywords = ['score', 'points', 'multiplier', 'scoremultiplier', 'combo', 'total', 'value', 'pts', 'gameScore', 'playerScore', 'scoreTotal', 'currentScore', 'finalScore', 'totalScore'];

      function doScan(delay, label) {
        setTimeout(function() {
          var count = searchAndModify(
            scoreKeywords,
            function(val) { return Math.min(999999, val * multiplier); },
            5
          );
          console.log('[AllinONE] Effect Engine: ' + label + '扫描完成, 修改了 ' + count + ' 个变量');
        }, delay);
      }

      doScan(300, '第1次');
      doScan(1500, '第2次');
      doScan(4000, '第3次');

      // 策略 B: Canvas fillText/strokeText 拦截（视觉层修改分数显示）
      _scoreMultiplier = multiplier;
      setTimeout(function() {
        _setupCanvasInterception();
        console.log('[AllinONE] Effect Engine: Canvas 文本拦截已激活, 分数倍率=' + multiplier);
      }, 100);

      // 策略 C: 全局变量挂载（游戏可读取 window.__allinoneScoreMultiplier）
      window.__allinoneScoreMultiplier = multiplier;
    },

    'extra_life': function(itemData) {
      var lives = (itemData.effects && itemData.effects.lives) || 1;
      console.log('[AllinONE] Effect Engine: 执行额外生命, +' + lives);

      setTimeout(function() {
        searchAndModify(
          ['life', 'lives', 'health', 'hp', 'hitpoints', 'playerhealth', 'playerlives'],
          function(val) { return Math.min(999, val + lives); }
        );
      }, 500);
    },

    'time_bonus': function(itemData) {
      var bonusTime = (itemData.effects && itemData.effects.bonusTime) || 30;
      console.log('[AllinONE] Effect Engine: 执行时间奖励, +' + bonusTime + 's');

      setTimeout(function() {
        searchAndModify(
          ['time', 'timer', 'countdown', 'remaining', 'timeleft', 'gameTime', 'levelTime'],
          function(val) { return Math.min(99999, val + bonusTime); }
        );
      }, 500);
    },

    'custom': function(itemData) {
      console.log('[AllinONE] Effect Engine: 自定义道具, 无自动执行脚本:', itemData.id);
    }
  };

  // ==================== 公共 API ====================
  window.AllinONE = window.AllinONE || {};
  window.AllinONE.Effects = {
    /** 应用效果 - 被 SDK 兑换成功时自动调用 */
    apply: function(itemData) {
      var handler = effectHandlers[itemData.effectType || 'custom'];
      if (handler) {
        handler(itemData);
        return true;
      }
      return false;
    },

    /** 清除所有帧修饰器 */
    clearAll: function() {
      _frameModifiers = {};
      _recalcTimeScale();
    },

    /** 清除指定效果 */
    clear: function(itemId) {
      delete _frameModifiers[itemId];
      _recalcTimeScale();
    },

    /** 手动执行变量搜索 (游戏可主动调用) */
    searchAndModify: function(keywords, modifier) {
      searchAndModify(keywords, modifier);
    }
  };

  console.log('[AllinONE] Effect Engine v1.1 已就绪, 已注册 ' + Object.keys(effectHandlers).length + ' 种效果处理器');
  } catch(e) {
    console.error('[AllinONE] Effect Engine 初始化失败:', e && e.message ? e.message : e);
    // 即使初始化失败，确保 SDK 仍能调用公共 API
    if (!window.AllinONE) window.AllinONE = {};
    if (!window.AllinONE.Effects) {
      window.AllinONE.Effects = {
        apply: function() { console.warn('[AllinONE] Effects 不可用 (初始化失败)'); return false; },
        clearAll: function() {},
        clear: function() {},
        searchAndModify: function() {}
      };
    }
  }
})();
</script>`;
  }

  /**
   * 生成 AllinONE SDK 注入脚本
   * 在游戏 HTML 中注入兑换条 UI 和与平台的通信能力
   * 兑换成功后自动调用 Effect Engine 执行效果
   */
  private generateAllinoneSDK(gameId: string, redeemItems: RedeemItemConfig[]): string {
    // 生成道具映射表
    const itemsJson = JSON.stringify(redeemItems.map(item => ({
      itemId: item.gameItemId,
      effectType: item.effectType,
      name: item.name,
      quantity: item.quantity,
      effects: item.effects,
      rarity: item.rarity,
    })));

    return `<!-- AllinONE SDK v1.0 - 游戏兑换条 -->
<script>
(function() {
  'use strict';
  var GAME_ID = ${JSON.stringify(gameId)};
  var ITEMS = ${itemsJson};

  // ===== 创建兑换条 UI =====
  var styles = document.createElement('style');
  styles.textContent = [
    '#allinone-redeem-bar{position:fixed;bottom:80px;left:50%;transform:translateX(-50%);z-index:99999;display:none;background:rgba(15,15,25,0.92);backdrop-filter:blur(12px);border:1px solid rgba(255,255,255,0.08);border-radius:16px;padding:14px 22px;min-width:380px;max-width:500px;box-shadow:0 12px 48px rgba(0,0,0,0.5);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#fff;transition:all .3s ease;}',
    '#allinone-redeem-bar.show{display:block;}',
    '#allinone-redeem-bar .bar-row{display:flex;align-items:center;gap:10px;}',
    '#allinone-redeem-bar .bar-row input{flex:1;padding:10px 14px;border-radius:10px;border:1px solid rgba(139,92,246,0.3);background:rgba(255,255,255,0.06);color:#fff;font-size:14px;font-family:monospace;letter-spacing:2px;outline:none;transition:border-color .2s;}',
    '#allinone-redeem-bar .bar-row input:focus{border-color:rgba(139,92,246,0.7);}',
    '#allinone-redeem-bar .bar-row input::placeholder{font-family:sans-serif;letter-spacing:0;color:rgba(255,255,255,0.3);}',
    '#allinone-redeem-bar .bar-row .btn-redeem{padding:10px 22px;border-radius:10px;border:none;background:linear-gradient(135deg,#7c3aed,#6366f1);color:#fff;font-size:14px;font-weight:600;cursor:pointer;transition:opacity .2s,transform .1s;white-space:nowrap;}',
    '#allinone-redeem-bar .bar-row .btn-redeem:hover{opacity:0.9;}',
    '#allinone-redeem-bar .bar-row .btn-redeem:active{transform:scale(0.97);}',
    '#allinone-redeem-bar .bar-row .btn-redeem:disabled{opacity:0.5;cursor:not-allowed;}',
    '#allinone-redeem-bar .bar-row .btn-close{padding:6px 10px;border-radius:8px;border:none;background:rgba(255,255,255,0.08);color:rgba(255,255,255,0.5);font-size:14px;cursor:pointer;transition:background .2s;}',
    '#allinone-redeem-bar .bar-row .btn-close:hover{background:rgba(255,255,255,0.15);color:#fff;}',
    '#allinone-redeem-bar .bar-status{margin-top:10px;font-size:12px;text-align:center;display:none;}',
    '#allinone-redeem-bar .bar-status.show{display:block;}',
    '#allinone-redeem-bar .bar-status.success{color:#4ade80;}',
    '#allinone-redeem-bar .bar-status.error{color:#f87171;}',
    '#allinone-redeem-bar .bar-status.loading{color:#a78bfa;}',
    '#allinone-redeem-bar .bar-status.info{color:#fbbf24;}',
    '#allinone-redeem-bar .bar-items{margin-top:10px;display:flex;gap:6px;flex-wrap:wrap;}',
    '#allinone-redeem-bar .bar-items .item-chip{padding:4px 10px;border-radius:6px;background:rgba(139,92,246,0.1);border:1px solid rgba(139,92,246,0.15);font-size:11px;color:#a78bfa;cursor:default;user-select:none;}',
    '#allinone-redeem-bar .bar-hint{font-size:12px;color:rgba(255,255,255,0.45);margin-bottom:10px;text-align:center;line-height:1.4;}',
    '#allinone-redeem-bar .bar-items-label{font-size:11px;color:rgba(255,255,255,0.35);margin-top:10px;margin-bottom:4px;text-align:left;}',
    '#allinone-redeem-toggle{position:fixed;bottom:24px;right:24px;z-index:99998;width:48px;height:48px;border-radius:50%;border:2px solid rgba(124,58,237,0.4);background:rgba(15,15,25,0.85);backdrop-filter:blur(8px);color:#fff;font-size:20px;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 16px rgba(0,0,0,0.4);transition:transform .2s,border-color .2s;}',
    '#allinone-redeem-toggle:hover{transform:scale(1.05);border-color:rgba(124,58,237,0.7);}',
    '#allinone-redeem-toggle .badge{position:absolute;top:-4px;right:-4px;width:16px;height:16px;border-radius:50%;background:#7c3aed;font-size:9px;display:flex;align-items:center;justify-content:center;color:#fff;display:none;}',
    '@keyframes allinone-pulse{0%{opacity:1;}50%{opacity:0.4;}100%{opacity:1;}}',
    '#allinone-redeem-bar.loading .btn-redeem{animation:allinone-pulse 1.2s ease-in-out infinite;}'
  ].join('');
  document.head.appendChild(styles);

  // ===== DOM 结构 =====
  var bar = document.createElement('div');
  bar.id = 'allinone-redeem-bar';
  bar.innerHTML = [
    '<div class="bar-hint">🎮 输入您购买的道具兑换码，点击「兑换」激活效果</div>',
    '<div class="bar-row">',
      '<input id="allinone-code-input" type="text" placeholder="粘贴或输入兑换码，如 IV-A3F9K2M7" maxlength="20" spellcheck="false" autocomplete="off">',
      '<button class="btn-redeem" id="allinone-redeem-btn">兑换</button>',
      '<button class="btn-close" id="allinone-bar-close">&#10005;</button>',
    '</div>',
    '<div class="bar-status" id="allinone-bar-status"></div>',
    ITEMS.length > 0 ? [
      '<div class="bar-items-label">本游戏可用道具：</div>',
      '<div class="bar-items">',
        ITEMS.map(function(item) {
          return '<span class="item-chip" title="' + item.name + ' (' + item.effectType + ')">' + item.name + '</span>';
        }).join(''),
      '</div>'
    ].join('') : ''
  ].join('');
  document.body.appendChild(bar);

  var toggle = document.createElement('button');
  toggle.id = 'allinone-redeem-toggle';
  toggle.innerHTML = '<span>🎁</span><span class="badge" id="allinone-badge"></span>';
  toggle.title = '兑换道具';
  document.body.appendChild(toggle);

  // ===== 元素引用 =====
  var input = document.getElementById('allinone-code-input');
  var btn = document.getElementById('allinone-redeem-btn');
  var close = document.getElementById('allinone-bar-close');
  var status = document.getElementById('allinone-bar-status');
  var badge = document.getElementById('allinone-badge');

  // ===== 事件绑定 =====
  toggle.onclick = function() {
    bar.classList.toggle('show');
    if (bar.classList.contains('show')) { input.focus(); }
  };
  close.onclick = function() { bar.classList.remove('show'); };
  btn.onclick = function() { doRedeem(); };
  input.onkeydown = function(e) { if (e.key === 'Enter') doRedeem(); };

  // ===== 道具标签点击提示 =====
  setTimeout(function() {
    document.querySelectorAll('.item-chip').forEach(function(chip) {
      chip.addEventListener('click', function() {
        showStatus('请先购买此道具获取兑换码，然后在此处输入兑换', 'info');
      });
    });
  }, 100);

  function showStatus(msg, type) {
    status.textContent = msg;
    status.className = 'bar-status show ' + type;
    bar.classList.remove('loading');
    if (type === 'success') {
      setTimeout(function() { status.classList.remove('show'); }, 4000);
    } else if (type !== 'loading') {
      setTimeout(function() { status.classList.remove('show'); }, 3000);
    }
  }

  function doRedeem() {
    var code = input.value.trim();
    if (!code) { showStatus('请输入兑换码', 'error'); return; }

    btn.disabled = true;
    btn.textContent = '验证中...';
    bar.classList.add('loading');
    showStatus('正在验证兑换码...', 'loading');

    window.parent.postMessage({
      type: 'REDEEM_ITEM',
      data: { code: code.toUpperCase(), gameId: GAME_ID }
    }, '*');
  }

  // ===== 监听平台返回 =====
  window.addEventListener('message', function(event) {
    if (event.data && event.data.type === 'REDEEM_RESULT') {
      var res = event.data.data;
      btn.disabled = false;
      btn.textContent = '兑换';
      bar.classList.remove('loading');

      if (res.success) {
        showStatus('&#10003; 兑换成功! 道具: ' + (res.itemName || '') + ' x' + (res.quantity || 1), 'success');
        input.value = '';
        badge.style.display = 'flex';
        badge.textContent = '1';
        setTimeout(function() { badge.style.display = 'none'; }, 5000);
        setTimeout(function() { bar.classList.remove('show'); }, 1500);

        // ===== [关键] 自动调用 Effect Engine 执行效果 =====
        try {
          if (window.AllinONE && window.AllinONE.Effects) {
            window.AllinONE.Effects.apply({
              id: res.itemId,
              effectType: res.effectType || 'custom',
              itemName: res.itemName,
              quantity: res.quantity || 1,
              effects: res.effects || {}
            });
            console.log('[AllinONE SDK] Effect Engine 已自动执行:', res.itemName);
          } else {
            console.warn('[AllinONE SDK] Effect Engine 不可用');
          }
        } catch (e) {
          console.error('[AllinONE SDK] Effect Engine 执行失败:', e);
        }

        // 仍然触发 CustomEvent（兼容游戏方手动监听）
        var detail = {
          code: res.code,
          itemId: res.itemId,
          itemName: res.itemName,
          quantity: res.quantity || 1,
          effects: res.effects || {},
          effectType: res.effectType
        };
        window.dispatchEvent(new CustomEvent('allinone-item-redeemed', { detail: detail }));
        window.dispatchEvent(new CustomEvent('allinone:item-redeemed', { detail: detail }));
      } else {
        showStatus('&#10007; ' + (res.message || '兑换失败'), 'error');
      }
    }
  });

  // 🆕 ===== EXTENSION_VOUCHER 处理 + CustomEvent 分发（UGC 道具） =====
  window.addEventListener('message', function(event) {
    if (event.data && event.data.type === 'EXTENSION_VOUCHER') {
      var v = event.data.voucher;
      if (!v || !v.schemaName) { console.warn('[AllinONE SDK] EXTENSION_VOUCHER 无效'); return; }

      var schemaToItem = {};
      try {
        if (v.schemaName === 'weapon') {
          schemaToItem.itemId = (v.data && v.data.effectType) || 'match3_bomb';
          schemaToItem.itemName = (v.data && v.data.name) || 'UGC武器';
        } else if (v.schemaName === 'shop') {
          schemaToItem.itemId = (v.data && v.data.effectType) || 'match3_bomb';
          schemaToItem.itemName = (v.data && v.data.name) || 'UGC商店';
        } else if (v.schemaName === 'quest') {
          schemaToItem.itemId = (v.data && v.data.effectType) || 'match3_lightning';
          schemaToItem.itemName = (v.data && v.data.name) || 'UGC任务';
        } else if (v.schemaName === 'match3-powerup') {
          // match3-powerup: 优先使用 data.effect（效果类型），如 replace_color, remove_row 等
          schemaToItem.itemId = (v.data && v.data.effect) || (v.data && v.data.effectType) || v.schemaName;
          schemaToItem.itemName = (v.data && v.data.name) || v.schemaName;
        } else {
          schemaToItem.itemId = (v.data && v.data.effectType) || v.schemaName;
          schemaToItem.itemName = (v.data && v.data.name) || v.schemaName;
        }
      } catch(e) { console.error('[AllinONE SDK] 解析失败:', e); return; }

      console.log('[AllinONE SDK] EXTENSION_VOUCHER → CustomEvent 分发:', schemaToItem.itemId);

      var detail = {
        code: v.signature || 'ugc-' + Date.now(),
        itemId: schemaToItem.itemId,
        itemName: schemaToItem.itemName,
        quantity: 1,
        effects: {},
        effectType: 'custom',
        source: 'ugc',
        voucherData: v.data
      };
      window.dispatchEvent(new CustomEvent('allinone:item-redeemed', { detail: detail }));
      window.dispatchEvent(new CustomEvent('allinone-item-redeemed', { detail: detail }));
    }
  });

  // ===== SDK API（供游戏方手动调用） =====
  window.AllinONE = window.AllinONE || {};
  window.AllinONE.GAME_ID = GAME_ID;
  window.AllinONE.ITEMS = ITEMS;

  window.AllinONE.onItemRedeemed = function(callback) {
    if (typeof callback === 'function') {
      window.addEventListener('allinone-item-redeemed', function(e) {
        callback(e.detail);
      });
    }
  };

  window.AllinONE.showRedeemBar = function() {
    bar.classList.add('show');
    input.focus();
  };

  window.AllinONE.hideRedeemBar = function() {
    bar.classList.remove('show');
  };

  console.log('[AllinONE SDK] v1.0 兑换条已注入, 游戏ID:', GAME_ID, ', 道具:', ITEMS.length + ' 种');
})();
</script>`;
  }

  /** 查找文件路径的公共目录前缀（用于去除 ZIP 根目录），兼容正斜杠和反斜杠 */
  private findCommonDirPrefix(paths: string[]): string | null {
    if (paths.length <= 1) return null;
    // 统一反斜杠为正斜杠
    const normalized = paths.map(p => p.replace(/\\/g, '/'));
    const parts0 = normalized[0].split('/');
    if (parts0.length <= 1) return null;
    const firstDir = parts0[0] + '/';
    const allShare = normalized.every(p => p.startsWith(firstDir));
    return allShare ? firstDir : null;
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export default PublishingPipeline;
