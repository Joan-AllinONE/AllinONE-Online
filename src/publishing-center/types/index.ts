/**
 * AllinONE AI驱动发布中心 - 类型定义
 * 
 * 包含发布系统所有核心类型、接口和枚举
 */

// ==================== 游戏框架类型 ====================

export enum GameFramework {
  VANILLA_JS = 'vanilla-js',
  TYPESCRIPT = 'typescript',
  PHASER = 'phaser',
  PIXI = 'pixi',
  THREE_JS = 'three-js',
  BABYLON = 'babylon',
  COCOS_CREATOR = 'cocos-creator',
  UNITY_WEBGL = 'unity-webgl',
  GODOT = 'godot',
  CONSTRUCT = 'construct',
  RPG_MAKER = 'rpg-maker',
  REACT = 'react',
  VUE = 'vue',
  UNKNOWN = 'unknown',
}

export enum GameGenre {
  RPG = 'rpg',
  ACTION = 'action',
  ADVENTURE = 'adventure',
  PUZZLE = 'puzzle',
  STRATEGY = 'strategy',
  SIMULATION = 'simulation',
  SPORTS = 'sports',
  RACING = 'racing',
  SHOOTER = 'shooter',
  PLATFORMER = 'platformer',
  CASUAL = 'casual',
  UNKNOWN = 'unknown',
}

// ==================== AI分析结果 ====================

export interface FrameworkDetectionResult {
  framework: GameFramework;
  confidence: number; // 0-100
  version?: string;
  detectedFiles: string[];
  indicators: FrameworkIndicator[];
}

export interface FrameworkIndicator {
  type: 'file' | 'import' | 'dependency' | 'code_pattern' | 'config';
  pattern: string;
  matchedFile: string;
  weight: number;
}

export interface FeatureDetectionResult {
  feature: string;
  detected: boolean;
  confidence: number;
  evidence: string[];
}

export interface GameAnalysisResult {
  id: string;
  framework: FrameworkDetectionResult;
  features: FeatureDetectionResult[];
  fileStructure: FileStructureInfo;
  codeMetrics: CodeMetrics;
  timestamp: number;
}

export interface FileStructureInfo {
  totalFiles: number;
  entryPoints: string[];
  htmlFiles: string[];
  jsFiles: string[];
  tsFiles: string[];
  assetDirectories: string[];
  hasPackageJson: boolean;
  hasBuildScript: boolean;
  estimatedSize: number; // bytes
  /** 是否为模块化多文件游戏（RequireJS/AMD/动态 import/已知加载器），此类游戏必须用真实 URL 托管，srcDoc 内联会白屏 */
  isModular: boolean;
}

export interface CodeMetrics {
  totalLines: number;
  codeLines: number;
  commentLines: number;
  emptyLines: number;
  complexity: number;
  quality: CodeQualityMetrics;
}

export interface CodeQualityMetrics {
  score: number; // 0-100
  issues: CodeIssue[];
}

export interface CodeIssue {
  severity: 'error' | 'warning' | 'info';
  type: string;
  message: string;
  file: string;
  line?: number;
}

// ==================== Skill推荐 ====================

export interface SkillRecommendation {
  skillId: string;
  skillName: string;
  confidence: number; // 0-100
  reason: string;
  required: boolean;
  autoConfig?: Record<string, unknown>;
}

export interface RecommendationResult {
  recommendations: SkillRecommendation[];
  requiredSkills: string[];
  optionalSkills: string[];
  totalConfidence: number;
}

// ==================== 发布流程 ====================

export enum PublishStep {
  UPLOAD = 'upload',
  ANALYZE = 'analyze',
  CONFIGURE = 'configure',
  REVIEW = 'review',
  PUBLISH = 'publish',
}

export enum PublishStatus {
  IDLE = 'idle',
  RUNNING = 'running',
  SUCCESS = 'success',
  FAILED = 'failed',
  WARNING = 'warning',
}

export interface PublishPipelineState {
  step: PublishStep;
  status: PublishStatus;
  progress: number; // 0-100
  message: string;
  logs: PublishLogEntry[];
  error?: string;
  url?: string;
  steps: Array<{
    name: string;
    status: 'pending' | 'running' | 'completed' | 'failed';
  }>;
}

export interface PublishLogEntry {
  timestamp: number;
  level: 'info' | 'success' | 'warning' | 'error';
  message: string;
  step?: PublishStep;
}

export interface PublishError {
  code: string;
  message: string;
  step: PublishStep;
  details?: Record<string, unknown>;
}

// ==================== 标准游戏体系 ====================

export enum GameType {
  STANDARD = 'standard',   // AllinONE标准游戏 - 极速发布
  UNIVERSAL = 'universal', // 通用游戏 - AI分析
}

export interface StandardGameConfig {
  // 游戏基本信息
  game: {
    id: string;
    name: string;
    version: string;
    description: string;
    genre: GameGenre;
    framework: GameFramework;
  };
  
  // 平台配置
  platform: {
    type: GameType;
    entryPoint: string;
    fullscreen: boolean;
    mobileOptimized: boolean;
    offlineSupport: boolean;
  };
  
  // Skills配置
  skills: {
    auth: boolean;
    wallet: boolean;
    inventory: boolean;
    store: boolean;
    leaderboard?: boolean;
    achievements?: boolean;
    multiplayer?: boolean;
    analytics?: boolean;
  };
  
  // 功能特性
  features: {
    cloudSave: boolean;
    autoSync: boolean;
    socialShare: boolean;
    inGamePurchase: boolean;
  };
  
  // 展示信息
  display: {
    icon: string;
    cover: string;
    screenshots: string[];
    primaryColor: string;
    description: string;
    instructions?: string;
  };
  
  // 商业化
  monetization?: {
    type: 'free' | 'paid' | 'freemium';
    price?: number;
    currency?: string;
    /** 🆕 平台分成比例 (0-100)，默认 10 */
    revenueSharePercent?: number;
  };
}

// ==================== 验证结果 ====================

export enum ValidationStatus {
  PASS = 'pass',
  FAIL = 'fail',
  WARNING = 'warning',
  SKIP = 'skip',
}

export interface ValidationResult {
  check: string;
  status: ValidationStatus;
  message: string;
  details?: Record<string, unknown>;
}

export interface StandardValidationReport {
  isValid: boolean;
  score: number; // 0-100
  gameType: GameType;
  checks: ValidationResult[];
  estimatedPublishTime: number; // seconds
  estimatedCost: number;
  recommendations: string[];
}

// ==================== 发布配置 ====================

import type { RedeemItemConfig } from '@/services/publishedGameService';

/** 协议模式 */
export type ProtocolMode = 'inject' | 'integrated' | 'hybrid';

export interface PublishingConfig {
  gameId: string;
  gameType: GameType;
  analysisResult: GameAnalysisResult;
  skillRecommendations: SkillRecommendation[];
  standardConfig?: StandardGameConfig;
  customConfig?: Record<string, unknown>;
  files?: UploadedFile[];
  skillConfigs?: Record<string, Record<string, any>>;
  /** 可兑换道具配置 (用于兑换条注入) */
  redeemItems?: RedeemItemConfig[];
  /** 协议模式: inject=注入适配(默认), integrated=标准集成, hybrid=混合 */
  protocolMode?: ProtocolMode;
  /** 🆕 发布者用户ID */
  publisherId?: string;
  /** 🆕 发布者名称 */
  publisherName?: string;
  /** 🆕 平台分成比例 (0-100)，默认 10 */
  revenueSharePercent?: number;
}

export interface PublishResult {
  success: boolean;
  gameId: string;
  version: string;
  url: string;
  publishedAt: string;
  gameType: GameType;
  activatedSkills: string[];
  skillConfigs?: Record<string, any>;
  runtime?: {
    canLaunch: boolean;
    launchUrl: string;
    embedded: boolean;
  };
  errors?: string[];
  warnings?: string[];
}

// ==================== 文件上传 ====================

export interface UploadedFile {
  name: string;
  path: string;
  size: number;
  type: string;
  content: ArrayBuffer | string;
}

export interface GamePackage {
  id: string;
  name: string;
  files: UploadedFile[];
  rootDirectory: string;
  uploadTime: number;
}
