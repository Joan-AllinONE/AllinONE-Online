/**
 * GameQuest 任务发布系统类型定义
 *
 * 给每个已发布游戏挂一个「任务市场」，让玩家「接单 → 提交产物 → 审核 → 合并 → 获得报酬」。
 * 核心铁律：
 * 1. 不做源码 diff 合并，合并永远是「内容包 ContentPack 追加到挂载点 ContentSlot」；
 * 2. 分层扩展，不破坏原游戏（原游戏是 base，任务产物是 extension）；
 * 3. 源码快照只存引用（ref + allowedPaths 白名单），不内嵌源码全文；
 * 4. 并发控制靠 `${taskId}::${userId}` 唯一键独立文档，不靠数组 push；
 * 5. P0 只做静态校验（白名单 + Schema + 危险代码扫描 + 文件大小），不跑沙箱/构建。
 */

/** 任务类型 */
export type QuestType =
  | 'level'   // 关卡（「制作第二关」）
  | 'item'    // 道具（复用道具工坊 SOP）
  | 'skin'    // 皮肤
  | 'script'  // 脚本/能力片段
  | 'audio'   // 音效
  | 'art'     // 美术
  | 'fix';    // Bug 修复 / 平衡调整

/** 任务状态 */
export type QuestStatus = 'open' | 'review' | 'merged' | 'closed';

/** 报酬（平台钱包：游戏币 + A币凭证） */
export interface QuestReward {
  gameCoins?: number; // 平台游戏币（users.gameCoins）
  aCoins?: number; // A币凭证面额（创建 currency 凭证发放）
  voucherTemplateId?: string; // 可选：额外奖励一个凭证模板
}

/** 托管（发布时冻结，merged 发放 / closed 退回） */
export interface QuestEscrow {
  source: 'platform' | 'developer';
  frozen: Record<string, number>;
  status: 'frozen' | 'released' | 'refunded';
}

/** 开源授权快照（引用 + 白名单，不内嵌源码全文） */
export interface QuestSourceSnapshot {
  ref: string;                 // 指向 game_files / 云存储
  license: 'open' | 'mod-only' | 'restricted';
  allowedPaths: string[];      // 允许修改/新增的路径白名单（安全第一关）
}

/** 验收标准（P0 只做静态部分） */
export interface QuestAcceptance {
  contentSchema?: object;       // 内容包 JSON Schema
  maxFileSize?: number;         // 默认 512KB
  forbiddenPatterns?: string[]; // 危险代码扫描规则（可覆盖默认）
  description: string;          // 人类可读验收说明
}

/** 任务 */
export interface GameQuest {
  id: string;
  gameId: string;
  gameName?: string;
  title: string;
  description: string;
  type: QuestType;
  reward: QuestReward;
  escrow: QuestEscrow;
  sourceSnapshot: QuestSourceSnapshot;
  acceptance: QuestAcceptance;
  contentSlot: string;          // 挂载点：levels / items / skins / scripts ...
  maxClaimers: number;          // 0=无限 / 1=独占 / N=竞争
  status: QuestStatus;
  reviewMode: 'developer' | 'community';  // 审核方式（P1：开发者直审 / 社区投票）
  voteThreshold?: number;                  // 社区投票通过所需赞成票（默认 3）
  dependencies?: string[];                 // 依赖的任务 id（P2 任务链）
  /** 游戏方提供的「任务开发说明」markdown（玩家领取前阅读；可选）。只存说明文本，不存游戏源码 */
  devGuide?: string;
  /** 开发说明文件名（用于展示/下载，默认「任务开发说明.md」） */
  devGuideName?: string;
  createdBy: string;
  createdAt: number;
  deadline?: number;
}

/** 领取记录（防竞态：唯一键 `${taskId}::${userId}`） */
export interface QuestClaim {
  id: string;
  taskId: string;
  userId: string;
  status: 'active' | 'submitted' | 'abandoned';
  claimedAt: number;
}

/** 提交状态 */
export type SubmissionStatus =
  | 'pending'
  | 'auto-failed'   // 静态校验失败
  | 'reviewing'
  | 'approved'      // 审核通过待合并
  | 'merged'        // 已合并 + 已发报酬
  | 'rejected';

/** 内容包资源 */
export interface ContentPackAsset {
  path: string;
  content: string;
}

/**
 * 二进制文件存储标记前缀。
 * 前端把二进制文件（图片/音频等）转成 base64 后加此前缀存入 content，
 * 服务端/云函数分发时检测到前缀再解码为原始字节，避免 JSON 丢失二进制数据。
 */
export const QUEST_BINARY_PREFIX = '__BINARY_BASE64__';

/**
 * 计算 asset content 的实际字节大小。
 * - 二进制（带 QUEST_BINARY_PREFIX）：按 base64 长度反推原始字节数；
 * - 文本：按 UTF-8 计算字节数（纯 JS 实现，兼容前端 / server 双编译，零依赖）。
 */
export function questContentSize(content: string): number {
  if (content.startsWith(QUEST_BINARY_PREFIX)) {
    const b64 = content.slice(QUEST_BINARY_PREFIX.length);
    const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
    return Math.max(0, Math.floor(b64.length / 4) * 3 - pad);
  }
  let bytes = 0;
  for (let i = 0; i < content.length; i++) {
    const code = content.codePointAt(i)!;
    bytes += code > 0x7ff ? 3 : code > 0x7f ? 2 : 1;
    if (code > 0xffff) i++; // 跳过代理对
  }
  return bytes;
}

/** 内容包（合并的最小单元） */
export interface ContentPack {
  schemaVersion?: string;
  slot: string;                 // 目标挂载点（须匹配任务 contentSlot）
  data: unknown;                // 结构化内容（关卡/道具定义）
  assets?: ContentPackAsset[];  // 可选资源
  entryPoint?: string;          // 可选：独立入口（第二关入口）
  /** 方案 C：独立入口是「HTML 片段」而非完整页面。merge 时平台用统一壳包裹成完整 HTML 再落库 */
  fragment?: boolean;
  /**
   * 方案 E：注入模式。脚本（data.code 或第一个 .js 资产）直接写入
   * published_games[gameId].injections，玩家打开游戏入口 HTML 时由平台自动拼接执行。
   * 无需游戏内置扩展加载器（区别于模式 A/B 的「主动拉取」）。代码即交付物，
   * 危险代码扫描仅作提示（安全由审核流程 + 权限管控保障）。
   */
  inject?: boolean;
}

/**
 * 方案 E：注入型扩展记录（published_games[gameId].injections）。
 * 加载入口 HTML 时把 code 以 <script> 内联拼接进页面，任何游戏零改动即可生效。
 */
export interface QuestInjectionRecord {
  submissionId: string;
  /** 注入名称（任务标题），仅用于展示 */
  name?: string;
  slot: string;                 // 任务 contentSlot
  code: string;                 // 注入的脚本源码
  /** 可选：data.css 内联样式（.css 文件资产走 <link> 注入，不在此列） */
  styles?: string[];
  /** 全部资产清单（js/css/图片/音频/字体），供 AllinONE_asset() 引用与 UI 展示 */
  assets?: Array<{ path: string; size: number; mimeType: string }>;
  /** 资产命名空间（相对游戏文件根）：extensions/{questId}/{submissionId}/ */
  assetBase?: string;
  mergedAt: number;
}

/** 提交 */
export interface QuestSubmission {
  id: string;
  taskId: string;
  claimId?: string;
  submitterId: string;
  submitterName: string;
  contentPack: ContentPack;
  description: string;
  status: SubmissionStatus;
  autoCheck?: { passed: boolean; issues: string[] };
  review?: { verdict: 'approve' | 'reject'; comment: string; reviewedBy: string };
  votes?: QuestVoteRecord[];     // 社区投票记录（P1）
  convertedToMod?: boolean;      // 是否转为社区模组（P1）
  modId?: string;                // 关联模组 id（P1）
  mergedAt?: number;
  createdAt: number;
}

/** 社区投票记录（P1） */
export interface QuestVoteRecord {
  voterId: string;
  voterName: string;
  decision: 'approve' | 'reject';
  votedAt: number;
}

/** 社区模组（P1：落选/未中选 submission 转为可订阅模组） */
export interface QuestMod {
  id: string;
  gameId: string;
  gameName?: string;
  questId: string;
  questTitle: string;
  title: string;
  description: string;
  authorId: string;
  authorName: string;
  contentPack: ContentPack;
  subscribers?: number;
  createdAt: number;
}

/** 已落库资源元信息（assets 清单项，文件本体在游戏文件库 extensions/{questId}/{submissionId}/ 下） */
export interface QuestExtensionAsset {
  path: string;       // 完整扩展路径（含命名空间）
  size: number;
  mimeType: string;
}

/** 合并后记录在 published_games[gameId].questExtensions 的扩展入口（P1） */
export interface QuestExtensionRecord {
  submissionId: string;
  slot: string;              // contentSlot（levels / items / ...）
  entryPoint: string;        // 扩展入口完整路径（可能为空字符串 = 仅资源无入口）
  assets: QuestExtensionAsset[];
  mergedAt: number;
  /** 方案 E：注入型扩展标记。true = 脚本已写入 injections，加载入口 HTML 时自动生效 */
  inject?: boolean;
  /** 注入/扩展名称（任务标题），仅用于展示 */
  name?: string;
}

// ==================== 内容工坊（Content Workshop）类型 ====================
// 道具工坊的并列升级：玩家按游戏方「内容创作 SOP」创作完整内容数据包（地图/角色/剧情/道具），
// 铸造为「内容凭证」（按次使用、可交易），由游戏内 AllinONE_ContentLoader 按需应用。
// 与任务广场 merge 的关键区别：任务广场 = 永久发行给所有人；内容凭证 = 个人级按次消费。

/** 内容类型 */
export type ContentType = 'map' | 'character' | 'story' | 'item' | 'custom';

/** 内容交付形态 */
export type ContentMode = 'data' | 'inject' | 'extension' | 'fragment';

/** 游戏方声明的单个内容创作类型（contentTypes[] 元素） */
export interface GameContentTypeDecl {
  type: ContentType;
  slot: string;                 // 复用 QUEST_SLOT_SCHEMAS 或自定义挂载点
  label: string;                // 「地图」「角色」「剧情」...
  description: string;
  modes: ContentMode[];         // 允许的交付形态
  apiGuide?: string;            // 游戏暴露的创作 API 说明（如 window.MarioLevel.build(api)）
  examples?: any[];
  constraints?: Record<string, any>;
}

/** 游戏方内容创作 SOP（与 itemSop 并列、独立启用） */
export interface GameContentSop {
  enabled: boolean;             // 显式启用内容工坊（未启用则不分发 loader、不开放创作）
  contentTypes: GameContentTypeDecl[];
  /** 内容创作指南 md（玩家创作引导文档，含 API 文档/数据结构/资产打包说明/安全约束） */
  sopDocument?: string;
  /** 允许的全局交付形态（缺省 = ['data','inject','extension','fragment']） */
  allowedModes?: ContentMode[];
  updatedAt?: number;
}

/** 内容凭证携带的内容数据包（ContentPack + 类型/命名元信息） */
export interface GameContentPack extends ContentPack {
  type: ContentType;
  name: string;
  description?: string;
}

/** 内容资产库记录（后端 content_assets 集合） */
export interface ContentAssetRecord {
  contentId: string;
  gameId: string;
  authorId: string;
  authorName?: string;
  type: ContentType;
  slot: string;
  name: string;
  description?: string;
  /** 内容包 manifest（不含大资产本体，assets 仅含 path/size/mimeType 清单） */
  manifest: GameContentPack;
  /** 资产命名空间（相对游戏文件根）：content/{contentId}/ */
  assetBase: string;
  /** remix 上架记录（可选，走审核） */
  remix?: {
    status: 'pending' | 'approved' | 'rejected';
    entryPoint?: string;
    slot?: string;
    requestedAt?: number;
    reviewedAt?: number;
    reviewerId?: string;
  };
  createdAt: number;
}

/**
 * slot 内容协商 Schema（P2）
 *
 * 每个挂载点 slot 声明 data 的顶层形状、必填字段与允许的文件类型，
 * 提交校验（本地 server + 云函数）、前端表单提示、游戏读取统一以此为准，避免乱挂载。
 * 注意：此文件被 server（tsconfig.server.json）与前端共同编译，必须保持零外部依赖。
 */
export interface QuestSlotSchema {
  key: string;                 // slot 名（levels / items / skins / ...）
  label: string;               // 中文标签
  dataShape: 'object' | 'array' | 'any';  // data 顶层形状
  requiredKeys?: string[];     // data（或数组元素）必填字段
  allowedAssetExts?: string[]; // 允许的资源文件扩展名（不含点），缺省=不限制
  hint: string;                // 给玩家的填写提示
}

/** 内置 slot 注册表（P2）。自定义 slot 不受限（P0 自由扩展），仅不强制校验 */
export const QUEST_SLOT_SCHEMAS: QuestSlotSchema[] = [
  { key: 'levels', label: '关卡', dataShape: 'array', requiredKeys: ['id', 'title'], allowedAssetExts: ['json', 'js', 'png', 'jpg', 'mp3'], hint: 'data 为关卡数组，每关 { id, title, layout?, script?, cols?, enemyCols?, ... }；layout 为 15 行字符网格（#地面 B砖 ?金币 M蘑菇 X硬块 (|管道 C金币 F旗杆）或二维数字数组；script 指向 assets 的 .js（暴露 window.MarioLevel.build(api)，api 提供 setT/pipe/stairUp/stairDown/setFlag/setEnemies）；贴图/音效可放 png/jpg/mp3' },
  { key: 'items', label: '道具', dataShape: 'array', requiredKeys: ['id', 'name'], allowedAssetExts: ['json', 'png'], hint: 'data 为道具数组，每个 { id, name, effect?, ... }；图标可用 png' },
  { key: 'skins', label: '皮肤', dataShape: 'array', requiredKeys: ['id', 'name'], allowedAssetExts: ['json', 'png', 'svg', 'css', 'jpg'], hint: 'data 为皮肤数组，每个 { id, name, ... }；皮肤图可用 png/svg/jpg' },
  { key: 'scripts', label: '脚本/能力', dataShape: 'object', requiredKeys: ['name'], allowedAssetExts: ['js', 'mjs', 'json'], hint: 'data 为单个脚本对象 { name, code?, ... }；源码放 assets 的 js 文件' },
  { key: 'audio', label: '音效', dataShape: 'object', requiredKeys: ['name'], allowedAssetExts: ['mp3', 'wav', 'ogg', 'json'], hint: 'data 为音效对象 { name, src?, ... }；音频本体放 assets' },
  { key: 'art', label: '美术', dataShape: 'object', requiredKeys: [], allowedAssetExts: ['png', 'jpg', 'jpeg', 'svg', 'webp'], hint: 'data 为美术对象 { name?, ... }；图片本体放 assets' },
  { key: 'fix', label: '修复/平衡', dataShape: 'any', requiredKeys: [], allowedAssetExts: ['js', 'json', 'css'], hint: 'data 任意形状；涉及代码放 assets 的 js 文件' },
  { key: 'inject', label: '注入脚本/MOD', dataShape: 'any', requiredKeys: [], allowedAssetExts: ['js', 'mjs', 'css', 'json', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'mp3', 'wav', 'ogg', 'mp4', 'webm', 'woff', 'woff2', 'ttf', 'otf'], hint: '模式 E：把 JS 直接注入宿主游戏页面（加载入口 HTML 时自动拼接执行，无需游戏内置加载器）。data 可留空；脚本放 assets 的 .js 文件（或 data.code 内联）；css/图片/音频可一并上传——CSS 自动以 <link> 注入，脚本里用 AllinONE_asset(\'文件名\') 引用资源。游戏零改动即可生效。⚠️ 高风险：代码会在玩家浏览器里运行，请确保脚本只做关卡/平衡/功能增强' },
];

/** 按 slot 名取注册表项（未注册返回 undefined = 自由扩展） */
export function getQuestSlotSchema(slot: string): QuestSlotSchema | undefined {
  return QUEST_SLOT_SCHEMAS.find((s) => s.key === slot);
}

/**
 * 方案 C：用统一 HTML 壳把「片段入口」包裹成完整页面。
 * 玩家只写一小段内容（如 <div>...</div> + <script>...</script>）时，merge 层调用此函数补全为
 * 可独立加载的 HTML，之后 entryPoint 可直接当完整页面使用（GamePlay ?ext= 无需改动）。
 * 二进制（带 QUEST_BINARY_PREFIX）无法包裹，返回 null 表示不适用（调用方应跳过包裹）。
 * 零依赖纯函数，兼容前端 / server / 云函数（TS/JS 需同步实现）。
 */
export function wrapHtmlFragment(content: string): string | null {
  if (!content || content.startsWith(QUEST_BINARY_PREFIX)) return null;
  return [
    '<!DOCTYPE html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="UTF-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
    '<style>html,body{margin:0;padding:0;height:100%;background:#0d0d1a;color:#eee;font-family:system-ui,sans-serif}</style>',
    '</head>',
    '<body>',
    content,
    '</body>',
    '</html>',
  ].join('\n');
}

/**
 * 独立入口模式（contentPack.entryPoint 非空）允许的 web 资源扩展名。
 * 独立 HTML 扩展的资产以入口页 + 配套资源（css/js/图片/音频/字体）为主，
 * 与「纯数据扩展」的 slot 白名单（allowedAssetExts）不同。
 */
export const QUEST_WEB_ASSET_EXTS = [
  'html', 'htm', 'css', 'js', 'mjs', 'json',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp', 'avif',
  'mp3', 'wav', 'ogg', 'oga', 'm4a', 'flac',
  'mp4', 'webm',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'txt', 'md', 'map', 'xml',
];

/**
 * 按 slot 注册表校验内容包（P2）。返回 issues 数组（空数组 = 通过）。
 * 未注册的 slot 不做结构校验（P0 自由扩展），但仍应经过危险代码扫描（调用方负责）。
 *
 * 双模式：
 * - 纯数据模式（无 entryPoint）：严格按 slot 白名单校验 data 形状/必填字段/资产类型；
 * - 独立入口模式（有 entryPoint）：内容是完整 HTML 页面，data 可空，资产放宽到 web 资源。
 */
export function validateQuestContent(slot: string, contentPack: any): string[] {
  const issues: string[] = [];

  // 方案 E：注入模式。脚本即交付物（data.code 或 .js 资产），跳过 slot 结构校验与资产类型白名单。
  // ⚠️ 必须放在 getQuestSlotSchema 之前：未注册 slot（自定义/自由）的注入提交也要校验脚本来源，
  // 否则空提交会绕过校验，merge 后无代码可注入（只产生一个空壳 questExtensions 记录）。
  if (contentPack && contentPack.inject === true) {
    const assets = Array.isArray(contentPack.assets) ? contentPack.assets : [];
    const data = contentPack.data;
    const hasJsAsset = assets.some((a: any) => String((a && a.path) || '').toLowerCase().endsWith('.js'));
    const hasInlineCode = typeof data === 'object' && data !== null && typeof data.code === 'string' && data.code.trim().length > 0;
    if (!hasJsAsset && !hasInlineCode) {
      issues.push('注入模式需要提供 .js 资产（或 data.code 内联脚本）');
    }
    return issues;
  }

  const schema = getQuestSlotSchema(slot);
  if (!schema) return [];
  const hasEntry = !!(contentPack && typeof contentPack.entryPoint === 'string' && contentPack.entryPoint);
  const data = contentPack && contentPack.data;

  // 独立入口模式：data 不强制结构（内容以 HTML 页面为准）
  if (!hasEntry) {
    if (schema.dataShape === 'array' && !Array.isArray(data)) {
      issues.push(`slot "${slot}" 的 data 应为数组`);
    }
    if (schema.dataShape === 'object' && (typeof data !== 'object' || data === null || Array.isArray(data))) {
      issues.push(`slot "${slot}" 的 data 应为对象`);
    }

    // 纯文件补丁（fix 补回被删文件等）：data 为空对象且提供了 assets 时，内容主体在文件里，
    // 跳过必填字段检查（否则 data={} 会被 scripts 等 slot 的 requiredKeys 拦下）。
    // dataShape 检查保留（防止 levels 之类需要数组的 slot 用空 data 蒙混）。
    const hasAssets = Array.isArray(contentPack && contentPack.assets) && contentPack.assets.length > 0;
    const dataIsEmptyObj =
      typeof data === 'object' && data !== null && !Array.isArray(data) && Object.keys(data).length === 0;
    if (schema.requiredKeys && schema.requiredKeys.length && !(dataIsEmptyObj && hasAssets)) {
      if (Array.isArray(data)) {
        for (const item of data) {
          if (item && typeof item === 'object') {
            for (const k of schema.requiredKeys) if (!(k in item)) issues.push(`数组元素缺少必需字段: ${k}`);
          }
        }
      } else if (data && typeof data === 'object') {
        for (const k of schema.requiredKeys) if (!(k in data)) issues.push(`data 缺少必需字段: ${k}`);
      }
    }
  }

  const assets = Array.isArray(contentPack && contentPack.assets) ? contentPack.assets : [];
  const allowedExts = hasEntry ? QUEST_WEB_ASSET_EXTS : schema.allowedAssetExts || [];
  if (allowedExts.length) {
    for (const a of assets) {
      const path = String((a && a.path) || '');
      const dot = path.lastIndexOf('.');
      const ext = dot >= 0 ? path.slice(dot + 1).toLowerCase() : '';
      if (ext && !allowedExts.includes(ext)) {
        issues.push(`文件 ${path} 类型不允许（slot "${slot}" 允许: ${allowedExts.join('/')}）`);
      }
    }
  }

  return issues;
}
