/**
 * 任务系统（GameQuest）本地路由 —— dev 环境走本地 server.js，不依赖云函数。
 *
 * 挂载在 /api/v1/games/__quests（必须在 games 路由之前，否则 __quests 被当 gameId）。
 * 与云函数 gamesApi 的 __quests 隧道逻辑对齐（列表/详情/创建/领取/提交/审核/投票/关闭/合并/转模组）。
 * 数据存储用内存库 memoryDatabase（USE_MEMORY_DB=true 的 dev 环境）。
 */

import { Router, Request, Response } from 'express';
import { verifyToken } from '../auth/jwt.js';
import { validateQuestContent, questContentSize, QUEST_BINARY_PREFIX, wrapHtmlFragment } from '../../types/quest.js';

const DEFAULT_FORBIDDEN = [
  'eval(', 'Function(', 'document.write', 'javascript:',
  '<script', 'new Function', 'constructor(',
];

// assets 落库时按扩展名推断 MIME（与 games.ts getMimeType 对齐）
const QUEST_MIME_MAP: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  // 音频
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  // 视频
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  // 字体
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  // 其他
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.pdf': 'application/pdf',
  '.wasm': 'application/wasm',
  '.bin': 'application/octet-stream',
  '.dat': 'application/octet-stream',
};
function guessQuestMime(filePath: string): string {
  const dot = filePath.lastIndexOf('.');
  if (dot < 0) return 'application/octet-stream';
  return QUEST_MIME_MAP[filePath.slice(dot).toLowerCase()] || 'application/octet-stream';
}

/**
 * 方案 E：从注入型 contentPack 提取注入负载。
 * - code：优先 data.code 内联；否则取第一个 .js 资产的内容（二进制跳过）。
 * - styles：全部 .css 资产的内联样式（非二进制）。注入器以 <style> 挂载并重写 url() 到 assetBase。
 *   ⚠️ .css 文件资产本身也随 assets 落库分发，注入器优先以 <link> 引用（CSS 内 url() 相对自身解析），
 *      这里的 styles 仅兜底 data.css / 无独立分发路径的情况。
 */
function extractInjectPayload(pack: any, _nsEntry: string): { code: string; styles: string[] } {
  if (!pack) return { code: '', styles: [] };
  const assets = Array.isArray(pack.assets) ? pack.assets : [];
  const js = assets.find((a: any) => String((a && a.path) || '').toLowerCase().endsWith('.js'));
  const code =
    (pack.data && typeof pack.data.code === 'string' && pack.data.code.trim()) ||
    (js && typeof js.content === 'string' && !js.content.startsWith(QUEST_BINARY_PREFIX) ? js.content : '');
  const styles = assets
    .filter((a: any) => String((a && a.path) || '').toLowerCase().endsWith('.css'))
    .map((a: any) => (typeof a.content === 'string' && !a.content.startsWith(QUEST_BINARY_PREFIX) ? a.content : ''))
    .filter(Boolean);
  return { code: code || '', styles };
}

export function createQuestsRouter(
  _useMemoryDB: boolean,
  memoryDB: any,
  _pool: any,
  _isProduction: boolean,
): Router {
  const router = Router();

  function resolveUserId(req: Request): string {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      try {
        const payload = verifyToken(authHeader.slice(7));
        if (payload && payload.userId) return payload.userId;
      } catch {
        // token 无效 → 回退
      }
    }
    const body: any = req.body || {};
    return (body.userId || body.submitterId || 'anonymous') as string;
  }

  function validateContentPack(contentPack: any, quest: any): string[] {
    const issues: string[] = [];
    const maxFileSize = (quest?.acceptance?.maxFileSize) || 512 * 1024;
    const forbidden =
      quest?.acceptance && Array.isArray(quest.acceptance.forbiddenPatterns) && quest.acceptance.forbiddenPatterns.length
        ? quest.acceptance.forbiddenPatterns
        : DEFAULT_FORBIDDEN;
    const scan = (text: string) => {
      if (typeof text !== 'string') return [];
      const found: string[] = [];
      for (const pat of forbidden) {
        if (typeof pat === 'string' && text.indexOf(pat) >= 0) found.push(pat);
      }
      return found;
    };
    const pack = contentPack || {};
    // 独立入口模式：entryPoint 非空 → 资产是完整 HTML 页面（必然含 <script>/JS），
    // 危险代码扫描无意义（页面即代码，安全由 iframe sandbox + 审核流程保障），仅校验大小。
    const isEntryMode = typeof pack.entryPoint === 'string' && !!pack.entryPoint;
    // 方案 E：注入模式。脚本即交付物（data.code / .js 资产），代码会在玩家浏览器运行，
    // 危险代码扫描仅作提示（安全由审核 + 权限管控保障，P0 允许注入型任务只走审核）。
    const isInjectMode = pack.inject === true;
    const dataStr = typeof pack.data === 'string' ? pack.data : JSON.stringify(pack.data || {});
    // 注入模式 data 即代码（data.code / 裸脚本），不扫描（扫描仅对结构化数据有意义，代码安全靠审核）
    const dataHits = isInjectMode ? [] : scan(dataStr);
    if (dataHits.length) issues.push('data 含危险代码: ' + dataHits.join(','));
    const assets = Array.isArray(pack.assets) ? pack.assets : [];
    for (const a of assets) {
      const content = typeof a.content === 'string' ? a.content : '';
      const size = questContentSize(content);
      if (size > maxFileSize) issues.push(`文件过大: ${a.path} (${size} 字节)`);
      // 独立入口模式的页面资产 / 注入模式脚本 / 二进制内容跳过危险代码扫描
      if (!isEntryMode && !isInjectMode && !content.startsWith(QUEST_BINARY_PREFIX)) {
        const hits = scan(content);
        if (hits.length) issues.push('文件 ' + a.path + ' 含危险代码: ' + hits.join(','));
      }
    }

    // P2 内容协商：按 slot 注册表校验 data 形状 / 必填字段 / 允许文件类型（未注册 slot 不强制）
    const slot = String(quest?.contentSlot || pack.slot || 'levels');
    issues.push(...validateQuestContent(slot, pack));
    return issues;
  }

  // ---------- 列表 ----------
  router.get('/', async (req, res) => {
    try {
      const gameId = req.query.gameId as string | undefined;
      const status = req.query.status as string | undefined;
      const data = await memoryDB.listQuests(gameId || undefined, status || undefined);
      res.json({ success: true, data });
    } catch (e) {
      console.warn('[Quests] 列表失败:', e);
      res.json({ success: true, data: [] });
    }
  });

  // ---------- 社区模组列表（须在 /:id 之前） ----------
  router.get('/mods', async (req, res) => {
    try {
      const gameId = req.query.gameId as string | undefined;
      const data = await memoryDB.listQuestMods(gameId || undefined);
      res.json({ success: true, data });
    } catch (e) {
      console.warn('[Quests] 模组列表失败:', e);
      res.json({ success: true, data: [] });
    }
  });

  // ---------- 详情 ----------
  router.get('/:id', async (req, res) => {
    const quest = await memoryDB.getQuest(req.params.id);
    if (!quest) return res.status(404).json({ success: false, error: 'quest not found' });
    res.json({ success: true, data: quest });
  });

  // ---------- 提交列表 ----------
  router.get('/:id/submissions', async (req, res) => {
    const data = await memoryDB.listQuestSubmissions(req.params.id);
    res.json({ success: true, data });
  });

  // ---------- 创建 ----------
  router.post('/', async (req, res) => {
    const body: any = req.body || {};
    if (!body.id) return res.status(400).json({ success: false, error: 'missing quest.id' });
    if (!body.gameId) return res.status(400).json({ success: false, error: 'missing gameId' });
    const quest = Object.assign(
      {
        type: 'level',
        reward: {},
        escrow: { source: 'platform', frozen: {}, status: 'frozen' },
        sourceSnapshot: { ref: '', license: 'open', allowedPaths: [] },
        acceptance: { maxFileSize: 512 * 1024, description: '' },
        contentSlot: 'levels',
        maxClaimers: 3,
        status: 'open',
        reviewMode: 'developer',
        voteThreshold: 3,
        createdAt: Date.now(),
      },
      body,
    );
    await memoryDB.upsertQuest(quest.id, quest);
    res.json({ success: true, data: quest });
  });

  // ---------- 领取 ----------
  router.post('/:id/claim', async (req, res) => {
    const userId = resolveUserId(req);
    const quest = await memoryDB.getQuest(req.params.id);
    if (!quest) return res.status(404).json({ success: false, error: 'quest not found' });
    if (quest.status !== 'open') return res.status(400).json({ success: false, error: 'quest not open' });
    const maxClaimers = Number(quest.maxClaimers) || 0;
    if (maxClaimers > 0) {
      const active = await memoryDB.countActiveQuestClaims(quest.id);
      if (active >= maxClaimers) {
        return res.status(400).json({ success: false, error: 'task already fully claimed' });
      }
    }
    const claimId = `${quest.id}::${userId}`;
    const existing = await memoryDB.getQuestClaim(claimId);
    if (existing) return res.json({ success: true, data: { claimId, alreadyClaimed: true } });
    await memoryDB.upsertQuestClaim(claimId, { taskId: quest.id, userId, status: 'active', claimedAt: Date.now() });
    res.json({ success: true, data: { claimId, claimed: true } });
  });

  // ---------- 提交 ----------
  router.post('/:id/submit', async (req, res) => {
    const userId = resolveUserId(req);
    const quest = await memoryDB.getQuest(req.params.id);
    if (!quest) return res.status(404).json({ success: false, error: 'quest not found' });
    if (quest.status !== 'open') return res.status(400).json({ success: false, error: 'quest not open' });
    const body: any = req.body || {};
    const contentPack = body.contentPack || body;
    const issues = validateContentPack(contentPack, quest);
    const submission = {
      taskId: quest.id,
      claimId: `${quest.id}::${userId}`,
      submitterId: userId,
      submitterName: body.submitterName || userId,
      contentPack,
      description: body.description || '',
      status: issues.length ? 'auto-failed' : 'reviewing',
      autoCheck: { passed: issues.length === 0, issues },
      createdAt: Date.now(),
    };
    const subId = `sub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await memoryDB.upsertQuestSubmission(subId, submission);
    await memoryDB.upsertQuestClaim(`${quest.id}::${userId}`, {
      taskId: quest.id, userId, status: 'submitted', claimedAt: Date.now(),
    });
    res.json({ success: true, data: { id: subId, status: submission.status, autoCheck: submission.autoCheck } });
  });

  // ---------- 审核 ----------
  router.post('/:id/review', async (req, res) => {
    const body: any = req.body || {};
    const subId = body.submissionId as string;
    if (!subId) return res.status(400).json({ success: false, error: 'missing submissionId' });
    const verdict = body.verdict === 'approve' ? 'approve' : 'reject';
    const doc = await memoryDB.getQuestSubmission(subId);
    if (!doc) return res.status(404).json({ success: false, error: 'submission not found' });
    const updated = {
      ...doc,
      review: { verdict, comment: body.comment || '', reviewedBy: resolveUserId(req) },
      status: verdict === 'approve' ? 'approved' : 'rejected',
    };
    await memoryDB.upsertQuestSubmission(subId, updated);
    res.json({ success: true, data: updated });
  });

  // ---------- 社区投票 ----------
  router.post('/:id/vote', async (req, res) => {
    const userId = resolveUserId(req);
    const body: any = req.body || {};
    const subId = body.submissionId as string;
    if (!subId) return res.status(400).json({ success: false, error: 'missing submissionId' });
    const quest = await memoryDB.getQuest(req.params.id);
    if (!quest) return res.status(404).json({ success: false, error: 'quest not found' });
    const doc = await memoryDB.getQuestSubmission(subId);
    if (!doc) return res.status(404).json({ success: false, error: 'submission not found' });
    if (doc.status !== 'reviewing') {
      return res.status(400).json({ success: false, error: 'submission not open for voting' });
    }
    const decision = body.decision === 'reject' ? 'reject' : 'approve';
    const votes = Array.isArray(doc.votes) ? doc.votes.filter((v: any) => v.voterId !== userId) : [];
    votes.push({ voterId: userId, voterName: body.voterName || userId, decision, votedAt: Date.now() });
    const approve = votes.filter((v: any) => v.decision === 'approve').length;
    const reject = votes.filter((v: any) => v.decision === 'reject').length;
    const threshold = Number(quest.voteThreshold) || 3;
    const passed = approve >= threshold && approve > reject;
    const updated = { ...doc, votes, status: passed ? 'approved' : doc.status };
    await memoryDB.upsertQuestSubmission(subId, updated);
    res.json({ success: true, data: { id: subId, status: updated.status, approve, reject, passed, votes } });
  });

  // ---------- 关闭（仅创建者） ----------
  router.post('/:id/close', async (req, res) => {
    const userId = resolveUserId(req);
    const quest = await memoryDB.getQuest(req.params.id);
    if (!quest) return res.status(404).json({ success: false, error: 'quest not found' });
    if (quest.createdBy && quest.createdBy !== userId) {
      return res.status(403).json({ success: false, error: '只有任务创建者可以关闭任务' });
    }
    if (quest.status === 'closed' || quest.status === 'merged') {
      return res.status(400).json({ success: false, error: 'quest already ' + quest.status });
    }
    const escrow = { ...(quest.escrow || {}), status: 'refunded' };
    const updated = { ...quest, status: 'closed', escrow };
    await memoryDB.upsertQuest(updated.id, updated);
    res.json({ success: true, data: { id: updated.id, status: 'closed', escrow } });
  });

  // ---------- 删除（仅创建者；仅允许删除已 closed 的任务，防止误删进行中/有提交的任务） ----------
  router.delete('/:id', async (req, res) => {
    const userId = resolveUserId(req);
    const quest = await memoryDB.getQuest(req.params.id);
    if (!quest) return res.status(404).json({ success: false, error: 'quest not found' });
    if (quest.createdBy && quest.createdBy !== userId) {
      return res.status(403).json({ success: false, error: '只有任务创建者可以删除任务' });
    }
    if (quest.status !== 'closed') {
      return res.status(400).json({ success: false, error: '仅已关闭的任务可以删除（先关闭再删除）' });
    }
    await memoryDB.deleteQuest(quest.id);
    await memoryDB.deleteQuestClaimsByTask(quest.id);
    await memoryDB.deleteQuestSubmissionsByTask(quest.id);
    res.json({ success: true, data: { id: quest.id, deleted: true } });
  });

  // ---------- 合并 ----------
  router.post('/:id/merge', async (req, res) => {
    const quest = await memoryDB.getQuest(req.params.id);
    if (!quest) return res.status(404).json({ success: false, error: 'quest not found' });
    const body: any = req.body || {};
    let submission: any = null;
    let subId = body.submissionId as string | undefined;
    if (subId) {
      submission = await memoryDB.getQuestSubmission(subId);
    } else {
      const list = await memoryDB.listQuestSubmissions(quest.id);
      submission = list.find((s: any) => s.status === 'approved' || s.status === 'reviewing') || null;
      if (submission) subId = submission.id;
    }
    if (!submission) return res.status(404).json({ success: false, error: 'submission not found' });

    const contentSlot = quest.contentSlot || 'levels';
    const contentPack = submission.contentPack || {};

    // 方案 C：base 快照（只写一次）——首次 merge 前存一份原版关键字段，供「恢复原版」回滚。
    // ⚠️ 与云函数 gamesApi 双维护。失败不影响合并主流程。
    try {
      const gdocS = await memoryDB.getPublishedGame(quest.gameId);
      if (gdocS && !(gdocS as any).baseSnapshot) {
        const snap: any = {
          [contentSlot]: Array.isArray((gdocS as any)[contentSlot]) ? (gdocS as any)[contentSlot] : [],
          injections: [],
          snapshotAt: Date.now(),
        };
        if (typeof (gdocS as any).entryHtmlContent === 'string') snap.entryHtmlContent = (gdocS as any).entryHtmlContent;
        if (typeof (gdocS as any).entryPoint === 'string') snap.entryPoint = (gdocS as any).entryPoint;
        await memoryDB.savePublishedGame({ ...(gdocS as any), id: quest.gameId, baseSnapshot: snap });
        console.log(`[quests merge] base 快照已写入: ${quest.gameId}, slot=${contentSlot}`);
      }
    } catch (e) {
      console.warn('[quests merge] base 快照写入失败', e);
    }

    // ① 合并：内容包 data 追加到 published_games[gameId][contentSlot]（与云函数对齐，相同内容去重）。
    // 独立入口模式（HTML 页面扩展）data 常为空对象/空数组，跳过不追加，避免污染关卡列表。
    // 方案 E 注入模式：data 只承载注入代码（data.code），代码由 ①d 消费，绝不追加到 slot。
    let deduplicated = false;
    const rawData = contentPack.data;
    const dataIsEmpty =
      contentPack.inject === true ||
      rawData === undefined || rawData === null ||
      (Array.isArray(rawData) && rawData.length === 0) ||
      (typeof rawData === 'object' && !Array.isArray(rawData) && Object.keys(rawData).length === 0);
    if (!dataIsEmpty) {
      const gdoc = await memoryDB.getPublishedGame(quest.gameId);
      const slotArr = (gdoc && Array.isArray(gdoc[contentSlot])) ? gdoc[contentSlot] : [];
      const dataKey = JSON.stringify(rawData);
      deduplicated = slotArr.some((item: any) => JSON.stringify(item) === dataKey);
      if (!deduplicated) {
        // ⚠️ 数组型 data（levels/items/skins 多元素）必须展开逐条追加，否则 slotArr 出现 [[{...}]] 嵌套，
        // 游戏侧按数组元素消费会拿不到。逐元素去重（内容相同不重复追加）。
        if (Array.isArray(rawData)) {
          // 逐元素追加 + 记 submissionId（游戏侧 ?ext=<submissionId> 自动选关）
          const subKey = (subId as string) || (submission as any)?.id || 'sub';
          for (const item of rawData) {
            if (item && typeof item === 'object' && !slotArr.some((x: any) => JSON.stringify(x) === JSON.stringify(item))) {
              slotArr.push({ ...item, _submissionId: subKey });
            }
          }
        } else {
          slotArr.push(rawData);
        }
        await memoryDB.savePublishedGame({ ...(gdoc || {}), id: quest.gameId, [contentSlot]: slotArr });
      }
    }

    // ①b 资源文件落库（P1）：assets 写入游戏文件库，路径加命名空间避免撞名。
    // 命名空间：extensions/{questId}/{submissionId}/{path}。文件经 GET /files/* 公开分发，
    // 游戏侧可用相对路径 extensions/... 引用（entryPoint 亦为完整扩展路径）。
    const submissionKey = (subId as string) || submission.id || 'sub';
    const assets = Array.isArray(contentPack.assets) ? contentPack.assets : [];
    // 方案 E：注入模式判定——勾选 inject 或任务 contentSlot 为 inject 都视为注入
    // （slot 名即意图，兼容玩家只选 inject slot 而漏勾「注入模式」复选框的情况）
    const isInject = contentPack.inject === true || String(contentSlot || '').trim() === 'inject';
    const assetManifest: Array<{ path: string; size: number; mimeType: string }> = [];
    if (assets.length) {
      const ns = `extensions/${quest.id}/${submissionKey}`;
      const files: Array<{ filePath: string; content: string; mimeType: string; size: number }> = assets
        .map((a: any) => {
          const rawPath = String((a && a.path) || '').replace(/^\/+/, '');
          const content = typeof (a && a.content) === 'string' ? a.content : '';
          return { filePath: rawPath ? `${ns}/${rawPath}` : '', content, mimeType: guessQuestMime(rawPath), size: questContentSize(content) };
        })
        .filter((f: { filePath: string; content: string }) => f.filePath && f.content);
      // ①b-1 方案 C：fragment 独立入口 → 用统一 HTML 壳把片段包裹成完整页面（覆盖写入同 path）。
      // 需在落库前改写文件 content；entryPoint 逻辑在 ①c 不变（仍指向同一扩展路径）。
      if ((contentPack as any).fragment === true) {
        const fragRaw = typeof contentPack.entryPoint === 'string' ? contentPack.entryPoint.replace(/^\/+/, '') : '';
        if (fragRaw) {
          const fragPath = `${ns}/${fragRaw}`;
          const fragFile = files.find((f) => f.filePath === fragPath);
          if (fragFile) {
            const wrapped = wrapHtmlFragment(fragFile.content);
            if (wrapped) {
              fragFile.content = wrapped;
              fragFile.size = questContentSize(wrapped);
              console.log(`[Quests] fragment 包裹: ${fragPath}`);
            }
          }
        }
      }
      if (files.length) {
        await memoryDB.saveGameFiles(quest.gameId, files);
        for (const f of files) assetManifest.push({ path: f.filePath, size: f.size, mimeType: f.mimeType });
        console.log(`[Quests] merge assets 落库: ${quest.gameId}, ${files.length} 个文件 (${ns})`);
      }
    }

    // ①c 记录扩展入口（P1）：entryPoint 与 assets 元信息写入 published_games[gameId].questExtensions。
    // 若 entryPoint 命中了 assets 中的文件，则记录完整扩展路径；否则记录原值（引用游戏已有文件）。
    const rawEntryPoint = typeof contentPack.entryPoint === 'string' ? contentPack.entryPoint.replace(/^\/+/, '') : '';
    const nsEntry = `extensions/${quest.id}/${submissionKey}/`;
    const entryPoint = rawEntryPoint
      ? (assetManifest.some((a) => a.path === nsEntry + rawEntryPoint) ? nsEntry + rawEntryPoint : rawEntryPoint)
      : '';
    if (assetManifest.length || entryPoint || contentPack.inject === true) {
      const gdocE = await memoryDB.getPublishedGame(quest.gameId);
      const exts = Array.isArray((gdocE as any)?.questExtensions) ? (gdocE as any).questExtensions : [];
      exts.push({
        submissionId: submissionKey,
        slot: contentSlot,
        entryPoint,
        assets: assetManifest,
        inject: contentPack.inject === true ? true : undefined,
        name: quest.title || undefined,
        mergedAt: Date.now(),
      });
      await memoryDB.savePublishedGame({ ...(gdocE || {}), id: quest.gameId, questExtensions: exts });
    }

    // ①d 注入模式（方案 E）：脚本代码 + 资产清单写入 published_games[gameId].injections，
    // 玩家打开游戏入口 HTML 时由文件分发层/SW/GamePlay 自动拼接执行。游戏零改动即可生效。
    // assets/assetBase 供注入器以 <link> 挂载 CSS 并让脚本用 AllinONE_asset() 引用图片/音频/字体。
    if (isInject) {
      const payload = extractInjectPayload(contentPack, nsEntry);
      if (payload.code || payload.styles.length) {
        const gdocI = await memoryDB.getPublishedGame(quest.gameId);
        const injs = Array.isArray((gdocI as any)?.injections) ? (gdocI as any).injections : [];
        if (!injs.some((x: any) => x.submissionId === submissionKey)) {
          injs.push({
            submissionId: submissionKey,
            name: quest.title || submissionKey,
            slot: contentSlot,
            code: payload.code,
            styles: payload.styles.length ? payload.styles : undefined,
            assets: assetManifest.length ? assetManifest : undefined,
            assetBase: nsEntry,
            mergedAt: Date.now(),
          });
          await memoryDB.savePublishedGame({ ...(gdocI || {}), id: quest.gameId, injections: injs });
          console.log(
            `[Quests] 注入模式合并: ${quest.gameId}, submission=${submissionKey}, code=${payload.code.length} 字节, styles=${payload.styles.length}, assets=${assetManifest.length}`,
          );
        }
      }
    }

    // ② 报酬发放到平台钱包（游戏币 users.gameCoins + A币凭证 vouchers，与云函数对齐）
    const reward = quest.reward || {};
    const deltas: Record<string, number> = {};
    const submitterId = submission.submitterId || 'anonymous';
    // 平台游戏币 → users.gameCoins
    if (Number(reward.gameCoins) > 0) {
      deltas.gameCoins = Number(reward.gameCoins);
      await memoryDB.addGameCoins(submitterId, deltas.gameCoins, `任务奖励: ${quest.title}`);
    }
    // A币 → 创建 A币凭证发给提交者
    if (Number(reward.aCoins) > 0) {
      deltas.aCoins = Number(reward.aCoins);
      await memoryDB.createACoinVoucher({
        id: `voucher_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        denomination: deltas.aCoins,
        holderId: submitterId,
        holderName: submission.submitterName,
        reason: `任务奖励: ${quest.title}`,
      });
    }

    // ③ 提交状态 → merged
    const finalSub = { ...submission, status: 'merged', mergedAt: Date.now() };
    await memoryDB.upsertQuestSubmission(subId as string, finalSub);

    // ④ escrow 释放 + developer 资金源发放流水（与云函数对齐）
    const escrow = { ...(quest.escrow || {}), status: 'released' };
    if (escrow.source === 'developer') {
      await memoryDB.addDeveloperTransaction({
        id: `devtx_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        accountId: `game-${quest.gameId}`,
        gameId: quest.gameId,
        type: 'quest_payout',
        amount: Number(reward.gameCoins) || 0,
        currency: 'gameCoins',
        description: `任务报酬发放: ${quest.title}`,
        timestamp: Date.now(),
      });
    }

    // ⑤ 任务 → merged
    await memoryDB.upsertQuest(quest.id, { ...quest, status: 'merged', escrow });

    res.json({
      success: true,
      data: { merged: true, slot: contentSlot, reward: deltas, submissionId: subId, deduplicated },
    });
  });

  // ---------- 转社区模组 ----------
  router.post('/:id/submissions/:subId/convert', async (req, res) => {
    const quest = await memoryDB.getQuest(req.params.id);
    if (!quest) return res.status(404).json({ success: false, error: 'quest not found' });
    const doc = await memoryDB.getQuestSubmission(req.params.subId);
    if (!doc) return res.status(404).json({ success: false, error: 'submission not found' });
    const body: any = req.body || {};
    const modId = `mod_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const mod = {
      gameId: quest.gameId,
      gameName: quest.gameName || '',
      questId: quest.id,
      questTitle: quest.title,
      title: body.title || `${quest.title} · 社区模组`,
      description: body.description || doc.description || '',
      authorId: doc.submitterId,
      authorName: doc.submitterName,
      contentPack: doc.contentPack,
      subscribers: 0,
      createdAt: Date.now(),
    };
    await memoryDB.upsertQuestMod(modId, mod);
    await memoryDB.upsertQuestSubmission(doc.id, { ...doc, convertedToMod: true, modId });
    res.json({ success: true, data: { id: modId, mod } });
  });

  return router;
}
