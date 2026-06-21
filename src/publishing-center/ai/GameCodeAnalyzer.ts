/**
 * AllinONE AI 游戏代码分析器
 * 
 * 使用真实 AI (CloudBase Hunyuan) 进行游戏代码分析
 * 功能：
 * 1. 检测游戏框架类型
 * 2. 识别游戏功能特征
 * 3. 评估代码质量
 * 4. 分析文件结构
 */

import {
  GameFramework,
  GameGenre,
  UploadedFile,
  GameAnalysisResult,
  FrameworkDetectionResult,
  FeatureDetectionResult,
  FileStructureInfo,
  CodeMetrics,
  FrameworkIndicator,
} from '../types';
import { initCloudBase, createAIModel, isCloudBaseReady } from '../../services/cloudbase';

// ==================== AI 分析提示词 ====================

const FRAMEWORK_DETECTION_PROMPT = `你是一个专业的游戏开发框架检测专家。请分析以下游戏代码文件，判断使用了什么游戏框架/引擎。

可能的框架包括：Phaser, PixiJS, Three.js, Babylon.js, Cocos Creator, Unity WebGL, Godot, Construct, RPG Maker, React, Vue, 原生 HTML5 Canvas 等。

请分析以下内容并返回 JSON 格式结果：
{
  "framework": "检测到的框架名称",
  "confidence": 置信度(0-100),
  "version": "检测到的版本号(如果有)",
  "reason": "检测理由",
  "indicators": ["检测到的特征1", "检测到的特征2"]
}

如果无法确定框架，返回 "UNKNOWN"。只返回 JSON，不要其他文字。`;

const FEATURE_DETECTION_PROMPT = `你是一个游戏功能分析专家。请分析以下游戏代码，识别游戏中包含的功能特性。

请检测以下功能：
- multiplayer: 多人游戏/联机功能
- save_system: 存档/进度保存功能
- shop_system: 商店/内购系统
- leaderboard: 排行榜系统
- achievements: 成就系统
- social: 社交功能(好友、分享等)
- ads: 广告系统
- analytics: 数据分析/统计

返回 JSON 格式结果：
{
  "features": [
    {
      "feature": "功能名称",
      "detected": true/false,
      "confidence": 置信度(0-100),
      "evidence": "检测依据"
    }
  ]
}

只返回 JSON，不要其他文字。`;

const CODE_QUALITY_PROMPT = `你是一个代码质量评估专家。请分析以下游戏代码的质量。

评估维度：
1. 代码结构组织
2. 注释完整性
3. 代码复杂度
4. 潜在问题
5. 最佳实践遵循情况

返回 JSON 格式结果：
{
  "totalLines": 总代码行数,
  "codeLines": 实际代码行数,
  "commentLines": 注释行数,
  "emptyLines": 空行数,
  "complexity": 复杂度评分(1-10),
  "qualityScore": 质量分数(0-100),
  "issues": [
    {
      "severity": "error/warning/info",
      "type": "问题类型",
      "message": "问题描述"
    }
  ],
  "suggestions": ["改进建议1", "改进建议2"]
}

只返回 JSON，不要其他文字。`;

// ==================== GameCodeAnalyzer 类 ====================

export class GameCodeAnalyzer {
  private analysisId: string;
  private files: Map<string, UploadedFile> = new Map();
  private fileContents: Map<string, string> = new Map();

  constructor() {
    this.analysisId = `analysis-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * 分析游戏代码包 - 使用真实 AI
   */
  async analyze(files: UploadedFile[]): Promise<GameAnalysisResult> {
    console.log('[GameCodeAnalyzer] 开始分析，文件数量:', files.length);
    
    // 存储文件
    this.files.clear();
    this.fileContents.clear();

    for (const file of files) {
      if (!file || !file.path) {
        console.log('[GameCodeAnalyzer] 跳过无效文件:', file);
        continue;
      }
      console.log('[GameCodeAnalyzer] 添加文件:', file.path, '类型:', file.name.split('.').pop());
      this.files.set(file.path, file);
      // 转换文本文件内容为字符串
      if (this.isTextFile(file)) {
        const content = await this.readFileContent(file);
        if (content) {
          console.log('[GameCodeAnalyzer] 读取文件内容:', file.path, '长度:', content.length);
          this.fileContents.set(file.path, content);
        }
      }
    }

    console.log('[GameCodeAnalyzer] 存储的文件数量:', this.files.size);
    console.log('[GameCodeAnalyzer] 文本文件内容数量:', this.fileContents.size);

    // 获取所有代码内容用于 AI 分析
    const allCodeContent = this.getAllCodeContent();
    console.log('[GameCodeAnalyzer] 代码内容总长度:', allCodeContent.length);

    // 检查 CloudBase 是否可用，并确保匿名登录完成后再使用 AI
    let useAI = false;
    try {
      await initCloudBase();
      if (isCloudBaseReady()) {
        // 额外验证 AI 模型可用性：尝试创建模型并做简单调用
        // CloudBase AI 需要 OAuth2 凭据，匿名登录必须完成
        const { getCloudBaseApp } = await import('../../services/cloudbase');
        const auth = getCloudBaseApp().auth({ persistence: 'local' });
        const loginState = await auth.getLoginState().catch(() => null);
        if (loginState) {
          useAI = true;
        } else {
          console.warn('AI 功能不可用：CloudBase 登录态未就绪，将使用本地分析');
        }
      }
    } catch (err) {
      console.warn('AI 功能不可用，将使用本地分析:', err);
    }

    // 根据 CloudBase 可用性选择分析方式
    let framework: FrameworkDetectionResult;
    let features: FeatureDetectionResult[];
    let codeMetrics: CodeMetrics;

    if (useAI) {
      console.log('🤖 使用 CloudBase AI 进行分析...');
      // 逐个调用而非 Promise.all，避免一个失败影响其他
      // 每个都有独立的 try-catch 降级到本地分析
      framework = await this.detectFrameworkWithAI(allCodeContent);
      features = await this.detectFeaturesWithAI(allCodeContent);
      codeMetrics = await this.analyzeCodeQualityWithAI(allCodeContent);
    } else {
      console.log('📊 CloudBase AI 不可用，使用本地规则分析...');
      [framework, features, codeMetrics] = await Promise.all([
        this.detectFrameworkLocal(),
        this.detectFeaturesLocal(),
        this.analyzeCodeMetricsLocal(),
      ]);
    }

    const fileStructure = this.analyzeFileStructure();

    return {
      id: this.analysisId,
      framework,
      features,
      fileStructure,
      codeMetrics,
      timestamp: Date.now(),
    };
  }

  /**
   * 获取所有代码内容的摘要
   */
  private getAllCodeContent(): string {
    const contents: string[] = [];
    const maxFileSize = 50000; // 每个文件最多取 50KB
    const maxTotalSize = 200000; // 总共最多 200KB
    let totalSize = 0;

    for (const [path, content] of this.fileContents) {
      if (totalSize >= maxTotalSize) break;

      const truncated = content.length > maxFileSize
        ? content.substring(0, maxFileSize) + '\n// ... (truncated)'
        : content;

      contents.push(`\n=== File: ${path} ===\n${truncated}`);
      totalSize += truncated.length;
    }

    return contents.join('\n');
  }

  /**
   * 使用 AI 检测游戏框架
   */
  private async detectFrameworkWithAI(codeContent: string): Promise<FrameworkDetectionResult> {
    try {
      const model = createAIModel('hunyuan-exp');

      const result = await model.generateText({
        model: 'hunyuan-2.0-instruct-20251111',
        messages: [
          { role: 'system', content: FRAMEWORK_DETECTION_PROMPT },
          { role: 'user', content: `请分析以下游戏代码，判断使用的框架：\n\n${codeContent.substring(0, 100000)}` },
        ],
        temperature: 0.3,
      });

      console.log('📝 AI 框架检测响应:', result.text);

      // 解析 AI 返回的 JSON
      const aiResult = this.parseAIResponse(result.text);

      const indicators: FrameworkIndicator[] = [];
      if (aiResult.indicators && Array.isArray(aiResult.indicators)) {
        aiResult.indicators.forEach((ind: string) => {
          indicators.push({
            type: 'code_pattern',
            pattern: ind,
            matchedFile: 'AI分析',
            weight: 20,
          });
        });
      }

      // 如果 AI 返回了有效的框架检测结果
      if (aiResult.framework && aiResult.framework !== 'UNKNOWN') {
        return {
          framework: this.parseFramework(aiResult.framework),
          confidence: aiResult.confidence || 80,
          version: aiResult.version,
          detectedFiles: [],
          indicators,
        };
      }

      // AI 无法确定，降级到本地检测
      console.log('⚠️ AI 无法确定框架，降级到本地检测');
      return this.detectFrameworkLocal();
    } catch (error) {
      console.error('AI 框架检测失败:', error);
      // 降级到本地检测
      return this.detectFrameworkLocal();
    }
  }

  /**
   * 使用 AI 检测游戏功能
   */
  private async detectFeaturesWithAI(codeContent: string): Promise<FeatureDetectionResult[]> {
    try {
      const model = createAIModel('hunyuan-exp');

      const result = await model.generateText({
        model: 'hunyuan-2.0-instruct-20251111',
        messages: [
          { role: 'system', content: FEATURE_DETECTION_PROMPT },
          { role: 'user', content: `请分析以下游戏代码的功能特性：\n\n${codeContent.substring(0, 100000)}` },
        ],
        temperature: 0.3,
      });

      console.log('📝 AI 功能检测响应:', result.text);

      const aiResult = this.parseAIResponse(result.text);

      if (aiResult.features && Array.isArray(aiResult.features)) {
        return aiResult.features.map((f: any) => ({
          feature: f.feature,
          detected: f.detected,
          confidence: f.confidence,
          evidence: [f.evidence || 'AI检测'],
        }));
      }

      // 如果解析失败，降级到本地检测
      console.log('⚠️ AI 功能解析失败，降级到本地检测');
      return this.detectFeaturesLocal();
    } catch (error) {
      console.error('AI 功能检测失败:', error);
      // 降级到本地检测
      return this.detectFeaturesLocal();
    }
  }

  /**
   * 使用 AI 分析代码质量
   */
  private async analyzeCodeQualityWithAI(codeContent: string): Promise<CodeMetrics> {
    try {
      const model = createAIModel('hunyuan-exp');

      const result = await model.generateText({
        model: 'hunyuan-2.0-instruct-20251111',
        messages: [
          { role: 'system', content: CODE_QUALITY_PROMPT },
          { role: 'user', content: `请分析以下代码质量：\n\n${codeContent.substring(0, 100000)}` },
        ],
        temperature: 0.3,
      });

      console.log('📝 AI 代码质量分析响应:', result.text);

      const aiResult = this.parseAIResponse(result.text);

      // 本地计算行数作为基准
      const localTotalLines = this.countLines(codeContent);

      return {
        totalLines: aiResult.totalLines || localTotalLines,
        codeLines: aiResult.codeLines || localTotalLines,
        commentLines: aiResult.commentLines || 0,
        emptyLines: aiResult.emptyLines || 0,
        complexity: aiResult.complexity || 5,
        quality: {
          score: aiResult.qualityScore || 70,
          issues: (aiResult.issues || []).map((issue: any) => ({
            severity: issue.severity || 'info',
            type: issue.type || 'general',
            message: issue.message || '',
            file: 'AI分析',
          })),
        },
      };
    } catch (error) {
      console.error('AI 代码质量分析失败:', error);
      // 降级到本地分析
      return this.analyzeCodeMetricsLocal();
    }
  }

  /**
   * 解析 AI 返回的 JSON 响应
   */
  private parseAIResponse(text: string): any {
    try {
      // 尝试直接解析
      return JSON.parse(text);
    } catch {
      // 尝试从 markdown 代码块中提取
      const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (jsonMatch) {
        try {
          return JSON.parse(jsonMatch[1]);
        } catch {
          // 忽略解析错误
        }
      }

      // 尝试从文本中提取 JSON（寻找最外层的花括号）
      const possibleJson = text.match(/\{[\s\S]*\}/);
      if (possibleJson) {
        try {
          return JSON.parse(possibleJson[0]);
        } catch {
          // 忽略解析错误
        }
      }
    }

    // 返回空对象
    return {};
  }

  /**
   * 解析框架字符串为枚举
   */
  private parseFramework(framework: string): GameFramework {
    if (!framework) return GameFramework.UNKNOWN;

    const frameworkMap: Record<string, GameFramework> = {
      'phaser': GameFramework.PHASER,
      'pixi': GameFramework.PIXI,
      'pixijs': GameFramework.PIXI,
      'three': GameFramework.THREE_JS,
      'three.js': GameFramework.THREE_JS,
      'babylon': GameFramework.BABYLON,
      'cocos': GameFramework.COCOS_CREATOR,
      'unity': GameFramework.UNITY_WEBGL,
      'godot': GameFramework.GODOT,
      'construct': GameFramework.CONSTRUCT,
      'rpg maker': GameFramework.RPG_MAKER,
      'rpgmaker': GameFramework.RPG_MAKER,
      'react': GameFramework.REACT,
      'vue': GameFramework.VUE,
      'html5': GameFramework.VANILLA_JS,
      'vanilla': GameFramework.VANILLA_JS,
      'native': GameFramework.VANILLA_JS,
    };

    const lowerFramework = framework.toLowerCase();
    for (const [key, value] of Object.entries(frameworkMap)) {
      if (lowerFramework.includes(key)) {
        return value;
      }
    }

    return GameFramework.UNKNOWN;
  }

  // ==================== 本地降级检测方法 ====================

  private detectFrameworkLocal(): FrameworkDetectionResult {
    // 简单的本地检测逻辑
    for (const [path, content] of this.fileContents) {
      const lowerContent = content.toLowerCase();
      const lowerPath = path.toLowerCase();

      if (lowerContent.includes('phaser') || lowerPath.includes('phaser')) {
        return {
          framework: GameFramework.PHASER,
          confidence: 80,
          detectedFiles: [path],
          indicators: [{ type: 'code_pattern', pattern: 'Phaser', matchedFile: path, weight: 80 }],
        };
      }

      if (lowerContent.includes('three.js') || lowerContent.includes('new THREE')) {
        return {
          framework: GameFramework.THREE_JS,
          confidence: 80,
          detectedFiles: [path],
          indicators: [{ type: 'code_pattern', pattern: 'Three.js', matchedFile: path, weight: 80 }],
        };
      }
    }

    return {
      framework: GameFramework.UNKNOWN,
      confidence: 0,
      detectedFiles: [],
      indicators: [],
    };
  }

  private detectFeaturesLocal(): FeatureDetectionResult[] {
    const results: FeatureDetectionResult[] = [];
    
    const featureRules = [
      {
        feature: 'multiplayer',
        patterns: ['socket.io', 'websocket', 'multiplayer', 'pvp', 'room', 'lobby', 'matchmaking'],
      },
      {
        feature: 'save_system',
        patterns: ['localStorage', 'indexedDB', 'save', 'load', 'storage', 'checkpoint'],
      },
      {
        feature: 'shop_system',
        patterns: ['shop', 'store', 'purchase', 'buy', 'item', 'currency', 'price'],
      },
      {
        feature: 'leaderboard',
        patterns: ['leaderboard', 'rank', 'score', 'highscore', 'top', 'ranking'],
      },
      {
        feature: 'achievements',
        patterns: ['achievement', 'badge', 'unlock', 'reward', 'milestone', 'trophy'],
      },
      {
        feature: 'social',
        patterns: ['friend', 'share', 'invite', 'social', 'guild', 'clan', 'team'],
      },
      {
        feature: 'ads',
        patterns: ['ad', 'advertisement', 'rewarded', 'interstitial', 'banner', 'admob'],
      },
      {
        feature: 'analytics',
        patterns: ['analytics', 'track', 'event', 'ga(', 'gtag', 'firebase.analytics'],
      },
    ];

    for (const rule of featureRules) {
      const evidence: string[] = [];
      let detected = false;
      let confidence = 0;

      for (const [path, content] of this.fileContents) {
        for (const pattern of rule.patterns) {
          if (content.toLowerCase().includes(pattern.toLowerCase())) {
            evidence.push(`代码中发现: ${pattern}`);
            confidence += 15;
          }
        }
      }

      detected = confidence > 0;
      confidence = Math.min(100, confidence);

      results.push({
        feature: rule.feature,
        detected,
        confidence,
        evidence: evidence.slice(0, 5),
      });
    }

    return results;
  }

  private analyzeCodeMetricsLocal(): CodeMetrics {
    let totalLines = 0;
    let commentLines = 0;
    let emptyLines = 0;

    for (const [path, content] of this.fileContents) {
      const lines = content.split('\n');
      totalLines += lines.length;

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === '') {
          emptyLines++;
        } else if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) {
          commentLines++;
        }
      }
    }

    const codeLines = totalLines - commentLines - emptyLines;

    return {
      totalLines,
      codeLines,
      commentLines,
      emptyLines,
      complexity: 5,
      quality: {
        score: 70,
        issues: [],
      },
    };
  }

  // ==================== 辅助方法 ====================

  private analyzeFileStructure(): FileStructureInfo {
    const entryPoints: string[] = [];
    const htmlFiles: string[] = [];
    const jsFiles: string[] = [];
    const tsFiles: string[] = [];
    const assetDirectories: string[] = [];
    let totalFiles = 0;
    let estimatedSize = 0;

    console.log('[GameCodeAnalyzer] 开始分析文件结构，文件数量:', this.files.size);

    const assetDirNames = ['assets', 'images', 'audio', 'sounds', 'music', 'sprites', 'textures', 'fonts', 'data'];

    for (const [path, file] of this.files) {
      if (!file || !file.name) {
        console.log('[GameCodeAnalyzer] 跳过无效文件:', path);
        continue;
      }

      totalFiles++;
      estimatedSize += file.size || 0;

      const ext = file.name.split('.').pop()?.toLowerCase() || '';
      const dirName = path?.split('/').slice(-2)[0]?.toLowerCase() || '';

      console.log('[GameCodeAnalyzer] 分析文件:', path, '扩展名:', ext);

      if (ext === 'html') {
        htmlFiles.push(path);
        const content = this.fileContents.get(path) || '';
        // 更宽松的入口文件检测
        if (content.includes('<script') || content.includes('<canvas') || content.includes('<body') || content.includes('<html')) {
          entryPoints.push(path);
          console.log('[GameCodeAnalyzer] 发现HTML入口:', path);
        }
      } else if (ext === 'js' || ext === 'mjs') {
        jsFiles.push(path);
        // 检测常见的入口文件名
        const lowerName = file.name.toLowerCase();
        if (lowerName.includes('main') || lowerName.includes('index') || lowerName.includes('start') || lowerName.includes('app') || lowerName.includes('game')) {
          entryPoints.push(path);
          console.log('[GameCodeAnalyzer] 发现JS入口:', path);
        }
      } else if (ext === 'ts' || ext === 'tsx') {
        tsFiles.push(path);
        // TypeScript 文件也可能是入口
        const lowerName = file.name.toLowerCase();
        if (lowerName.includes('main') || lowerName.includes('index') || lowerName.includes('start') || lowerName.includes('app') || lowerName.includes('game')) {
          entryPoints.push(path);
          console.log('[GameCodeAnalyzer] 发现TS入口:', path);
        }
      }

      if (assetDirNames.some(name => dirName.includes(name))) {
        if (!assetDirectories.includes(dirName)) {
          assetDirectories.push(dirName);
        }
      }
    }

    // 如果没有找到入口文件，但有 HTML 文件，将第一个 HTML 作为入口
    if (entryPoints.length === 0 && htmlFiles.length > 0) {
      entryPoints.push(htmlFiles[0]);
      console.log('[GameCodeAnalyzer] 使用第一个HTML作为入口:', htmlFiles[0]);
    }

    // 如果还是没有，将第一个 JS 文件作为入口
    if (entryPoints.length === 0 && jsFiles.length > 0) {
      entryPoints.push(jsFiles[0]);
      console.log('[GameCodeAnalyzer] 使用第一个JS作为入口:', jsFiles[0]);
    }

    // 如果还是没有，只要有任何文件，使用第一个文件作为入口
    if (entryPoints.length === 0 && this.files.size > 0) {
      const firstFile = Array.from(this.files.keys())[0];
      entryPoints.push(firstFile);
      console.log('[GameCodeAnalyzer] 使用第一个文件作为入口:', firstFile);
    }

    const result = {
      totalFiles,
      entryPoints: [...new Set(entryPoints)],
      htmlFiles,
      jsFiles,
      tsFiles,
      assetDirectories,
      hasPackageJson: this.files.has('package.json') || Array.from(this.files.keys()).some(k => k.endsWith('package.json')),
      hasBuildScript: false,
      estimatedSize,
    };

    console.log('[GameCodeAnalyzer] 文件结构分析结果:', {
      totalFiles: result.totalFiles,
      entryPoints: result.entryPoints,
      htmlFiles: result.htmlFiles.length,
      jsFiles: result.jsFiles.length,
    });

    return result;
  }

  private isTextFile(file: UploadedFile): boolean {
    if (!file || !file.name) return false;
    const textExtensions = ['js', 'ts', 'tsx', 'jsx', 'json', 'html', 'css', 'scss', 'less', 'md', 'txt', 'xml', 'svg'];
    const ext = file.name.split('.').pop()?.toLowerCase() || '';
    return textExtensions.includes(ext);
  }

  private async readFileContent(file: UploadedFile): Promise<string> {
    if (!file || !file.content) return '';
    if (typeof file.content === 'string') {
      return file.content;
    }
    const decoder = new TextDecoder('utf-8');
    return decoder.decode(file.content);
  }

  private countLines(content: string): number {
    return content.split('\n').length;
  }
}

export default GameCodeAnalyzer;
