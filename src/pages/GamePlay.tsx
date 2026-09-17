/**
 * 游戏游玩页面
 * 显示游戏详情并嵌入游戏
 */

import { useState, useEffect, useCallback, useContext, useRef, useMemo } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { getPublishedGame, getSelfContainedGameHtml, getCloudHostedGameHtml, refreshGameDetail, patchGameOnBackend, type PublishedGame } from '@/services/publishedGameService';
import { skillGateway } from '@/skills';
import { globalEventBus } from '@/skills/EventBus';
import { platformBindingService, GameType, TriggerMode, voucherService } from '@/voucher-system';
import { isCurrencyVoucher } from '@/voucher-system/types';
import { AuthContext } from '@/contexts/authContext';
import { redeemCodeService } from '@/services/redeemCodeService';
import { track } from '@/services/analytics';
import { Coins, X, AlertCircle, Gift, ShieldCheck, Layers, Boxes, Package } from 'lucide-react';
import { ProtocolEngine, schemaRegistry, getDefaultEngine } from '@/publishing-center/protocol';
import { itemHarvestService } from '@/services/itemHarvestService';

interface GameSkill {
  id: string;
  name: string;
  icon: string;
  description: string;
  enabled: boolean;
}

/** 游戏中心「点击游玩」触发的奖励发放结果传递键（与 GameCenter.tsx 保持一致） */
const PENDING_GAME_REWARD_KEY = 'allinone_pending_game_reward';

// 构造模块化游戏文件 URL。CloudBase 静态托管（tcloudbaseapp.com）下必须返回绝对云函数 URL，
// 因为 /api/** 会被 hosting rewrite 当 COS 对象读取（SW 未激活时手机端必现 NoSuchKey）。
// 本地 dev 走 vite 代理的相对路径。
// 方案 E 注入辅助：转义 </script> 并拼接注入块（与 SW gameFileServiceWorker-v13.js / games.ts 保持一致）
function escapeHtml(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function escapeScriptClose(code: string): string {
  return code.replace(/<\/script/gi, '<\\/script');
}
/** 内联 CSS 的 url() 重写到 assetBase */
function rewriteCssUrls(css: string, base: string): string {
  return String(css).replace(
    /url\(\s*(['"]?)(?!data:|https?:|\/\/|#)\/?([^'")]+)\1\s*\)/gi,
    (_m: string, q: string, p: string) => `url(${q}${base}${String(p).replace(/^\/+/, '')}${q})`,
  );
}
/** 构造注入块：CSS <link> + 内联 <style> + 资源帮助器 + 用户脚本 */
function buildInjectionBlock(inj: any, resolveBase: (inj: any) => string): string {
  const base = resolveBase(inj);
  const parts: string[] = [];
  const assets = Array.isArray(inj.assets) ? inj.assets : [];
  // ① CSS 文件资产 → <link>（href = base + 相对路径，保留子目录；CSS 内 url() 相对自身解析）
  assets
    .filter((a: any) => String((a && a.path) || '').toLowerCase().endsWith('.css'))
    .forEach((a: any) => {
      const full = String((a && a.path) || '');
      let rel = full;
      if (inj.assetBase && full.startsWith(inj.assetBase)) rel = full.slice(inj.assetBase.length);
      if (rel) parts.push(`<link rel="stylesheet" href="${escapeHtml(base + rel)}">`);
    });
  // ② data.css 内联 → <style> + url() 重写到 assetBase
  (Array.isArray(inj.styles) ? inj.styles : [])
    .filter((s: string) => s && s.trim())
    .forEach((css: string) => parts.push(`<style data-allinone-css>\n${rewriteCssUrls(css, base)}\n</style>`));
  // ③ 资源基础帮助器（inline/srcDoc 的 baseURI 是 about:srcdoc，必须传绝对 base）
  const sid = inj.submissionId || '';
  parts.push(
    `<script>window.AllinONE_INJECT=window.AllinONE_INJECT||{};` +
      `window.AllinONE_INJECT[${JSON.stringify(sid)}]={base:${JSON.stringify(base)},` +
      `url:function(p){return this.base+p}};` +
      `window.AllinONE_asset=function(p){return window.AllinONE_INJECT[${JSON.stringify(sid)}].url(p)};</script>`,
  );
  // ④ 用户脚本
  if (inj.code && inj.code.trim()) parts.push(`<script>\n${escapeScriptClose(inj.code)}\n</script>`);
  const label = String(inj.name || sid).replace(/--/g, '-');
  return parts.length ? `\n<!-- AllinONE 注入扩展: ${label} -->\n` + parts.join('\n') : '';
}
function applyInjectionsToHtml(html: string, injections: any[], resolveBase?: (inj: any) => string): string {
  if (!html || !Array.isArray(injections) || !injections.length) return html;
  if (html.indexOf('<!-- AllinONE 注入扩展') >= 0) return html; // 幂等
  const r = resolveBase || ((inj: any) => (inj && inj.assetBase) || '');
  const blocks = injections.map((inj) => buildInjectionBlock(inj, r)).filter(Boolean).join('\n');
  if (!blocks) return html;
  const bodyIdx = html.lastIndexOf('</body>');
  return bodyIdx >= 0 ? html.slice(0, bodyIdx) + blocks + html.slice(bodyIdx) : html + blocks;
}

// ==================== 内容工坊：ContentLoader 骨架注入（inline/srcDoc 模式） ====================
// server 模式由 SW/后端注入；inline 模式 baseURI 是 about:srcdoc，须在此注入。
// 幂等标记与 server games.ts / 云函数 / SW v14 保持一致。
const CONTENT_LOADER_MARKER = '<!-- AllinONE 内容加载器 -->';
const CONTENT_LOADER_SNIPPET = `<script>
(function(){if(window.AllinONE_ContentLoader)return;var L={
__v:1,_applied:{},_handlers:{},
on:function(s,f){this._handlers[s]=f;return this;},
base:function(p){return p&&p.assetBase?p.assetBase:'';},
url:function(p,path){return this.base(p)+String(path||'').replace(/^\\/+/g,'');},
apply:function(p){if(!p||!p.contentId)return{ok:false,error:'invalid pack'};var cid=p.contentId;
if(this._applied[cid])return{ok:false,error:'already applied this session'};
window.AllinONE_ContentAssets=window.AllinONE_ContentAssets||{};
window.AllinONE_ContentAssets[cid]={base:this.base(p),pack:p,url:function(pp){return this.base+String(pp||'').replace(/^\\/+/g,'');}};
var self=this;var assets=Array.isArray(p.assets)?p.assets:[];
var scripts=assets.filter(function(a){return /\\.js$/i.test(String(a.path||''));});
if(p.data&&typeof p.data.code==='string'&&p.data.code.trim()){try{(new Function(p.data.code))();}catch(e){console.error('[ContentLoader] data.code error',e);}}
function run(i){if(i>=scripts.length){window.dispatchEvent(new CustomEvent('allinone:content-pack-applied',{detail:p}));
var h=self._handlers[p.slot]||(window.AllinONE_ContentHandlers&&window.AllinONE_ContentHandlers[p.slot]);
if(h){try{h(p);}catch(e){console.error('[ContentLoader] handler error',e);}}
return{ok:true};}var s=document.createElement('script');s.src=self.url(p,scripts[i].path);
s.onload=function(){run(i+1);};s.onerror=function(){run(i+1);};document.head.appendChild(s);}
run(0);this._applied[cid]=true;return{ok:true,queued:scripts.length};},
list:function(){return Object.keys(this._applied);}};
window.AllinONE_ContentLoader=L;
window.addEventListener('message',function(ev){var d=ev&&ev.data;if(!d||d.type!=='CONTENT_PACK_APPLY')return;
if(window.AllinONE_ContentLoader&&d.content){window.AllinONE_ContentLoader.apply(d.content);}});})();
<\/script>`;
function applyContentLoaderToHtml(html: string, enabled: boolean): string {
  if (!enabled || !html || html.indexOf(CONTENT_LOADER_MARKER) >= 0) return html;
  const block = '\n' + CONTENT_LOADER_MARKER + '\n' + CONTENT_LOADER_SNIPPET + '\n';
  const bodyIdx = html.lastIndexOf('</body>');
  return bodyIdx >= 0 ? html.slice(0, bodyIdx) + block + html.slice(bodyIdx) : html + block;
}

function buildGameFileUrl(gameId: string, entryPoint: string): string {
  const isCloudHosting =
    typeof window !== 'undefined' && /tcloudbaseapp\.com$/.test(window.location.hostname);
  const base = isCloudHosting
    ? 'https://allinonegaming-d4gmsmrzz573264f6.service.tcloudbase.com/api/v1/games'
    : '/api/v1/games';
  return `${base}/${gameId}/files/${entryPoint}`;
}

/**
 * 计算生效的游戏加载配置：
 * - URL 带 ?ext=<submissionId> 且匹配已合并的 questExtensions：
 *   · 独立入口扩展（entryPoint 非空）→ 加载扩展 HTML（强制 server 托管）
 *   · 数据型扩展（entryPoint 空，如 levels 关卡/script 关卡）→ 加载原版入口，并把 ?ext= 透传给 iframe，
 *     由游戏内扩展加载器（A1G_EXT）按 submissionId/资产名自动选中对应扩展关卡
 *   · 注入型扩展（方案 E，inject=true）→ 同样加载原版入口 + 透传 ?ext=，由文件分发层按 ext 条件注入
 * - 无 ?ext=（或 ext 不匹配）→ 纯净原版：不注入任何扩展、不带任何扩展数据（方案 A）
 * - 模块化多文件游戏 → 强制 server 托管真实 URL
 * - 否则原样返回
 */
function computeEffectiveGame(publishedGame: PublishedGame, extParam: string | null): PublishedGame {
  const questExt =
    extParam && Array.isArray(publishedGame.questExtensions)
      ? publishedGame.questExtensions.find((e) => e.submissionId === extParam)
      : undefined;
  // 数据型 / 注入型扩展：原版入口 + 透传 ?ext=（方案 A）
  // · 数据型：游戏侧加载器（A1G_EXT）按 submissionId 过滤扩展数据
  // · 注入型：文件分发层（云函数 / dev games.ts / SW / 本页 inline 注入）按 ?ext= 只注入该扩展
  // ⚠️ 无 ?ext= 时一律返回纯净原版，绝不自动注入任何扩展。
  if (questExt && !questExt.entryPoint) {
    const ext = encodeURIComponent(extParam as string);
    const appendExt = (url: string) => url + (url.includes('?') ? '&' : '?') + 'ext=' + ext;
    // 注入型（方案 E）与数据型统一走同一分支：server + 原版入口 + ?ext= 透传。
    // · 数据型：游戏侧加载器（A1G_EXT）按 ?ext= 过滤扩展数据（方案 B）
    // · 注入型：文件分发层（云函数 / dev games.ts / SW）按 ?ext= 只注入该扩展（方案 A）
    // ⚠️ 不再保留 inject 的 inline 特例：注入型扩展也「必须从菜单手动选择」，原版永不被注入。
    const baseUrl =
      publishedGame.hostingType === 'server' && publishedGame.cdnUrl
        ? publishedGame.cdnUrl
        : buildGameFileUrl(publishedGame.id, publishedGame.entryPoint || 'index.html');
    return { ...publishedGame, hostingType: 'server' as const, cdnUrl: appendExt(baseUrl) };
  }
  return publishedGame.isModular || questExt
    ? {
        ...publishedGame,
        hostingType: 'server' as const,
        cdnUrl: buildGameFileUrl(publishedGame.id, questExt?.entryPoint || publishedGame.entryPoint || 'index.html'),
      }
    : publishedGame;
}

/**
 * 方案 C 兜底：无 baseSnapshot 时（合并在快照功能上线之前发生）派生纯净 base ——
 * 剔除各挂载点数组里带 `_submissionId` 的扩展条目，并清空注入脚本。
 * 所有 merge 写入的条目都带 `_submissionId`，因此该派生是确定性的。
 */
function buildDerivedBase(g: PublishedGame | null): Record<string, any> {
  const patch: Record<string, any> = { injections: [] };
  if (!g) return patch;
  const slots = new Set<string>(['levels', 'items', 'skins', 'scripts', 'audio', 'art', 'fix']);
  (g.questExtensions || []).forEach((e) => e.slot && slots.add(e.slot));
  slots.forEach((s) => {
    const arr = (g as any)[s];
    if (Array.isArray(arr)) {
      patch[s] = arr.filter((it: any) => !(it && typeof it === 'object' && (it as any)._submissionId));
    }
  });
  return patch;
}

export default function GamePlay() {
  const { gameId } = useParams<{ gameId: string }>();
  const [searchParams] = useSearchParams();
  // 方案 A：?ext=<submissionId> —— 决定加载哪个扩展；无 ext = 纯净原版
  // （提升至此：下方 gameHtmlInjected 的 inline 注入也要按它过滤）
  const extParam = searchParams.get('ext');
  const { currentUser } = useContext(AuthContext);
  const [game, setGame] = useState<PublishedGame | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [skills, setSkills] = useState<GameSkill[]>([]);
  const [balance, setBalance] = useState<Record<string, number>>({});
  const [voucherBalance, setVoucherBalance] = useState<{ count: number; totalValue: number }>({ count: 0, totalValue: 0 });
  const [gameHtmlContent, setGameHtmlContent] = useState<string | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [showExtMenu, setShowExtMenu] = useState(false);
  // 方案 C：用 base 快照回滚被 merge 污染的原版数据
  const [restoringBase, setRestoringBase] = useState(false);

  // 内容工坊：用户持有的内容凭证（按次使用）
  const [showContentMenu, setShowContentMenu] = useState(false);
  const [contentVouchers, setContentVouchers] = useState<any[]>([]);
  const [applyingContentId, setApplyingContentId] = useState<string | null>(null);

  // 🆕 P1 游戏内道具反向提取：平台侧「我的游戏道具」面板
  const [showGameItemsMenu, setShowGameItemsMenu] = useState(false);
  const [gameItems, setGameItems] = useState<Array<{
    itemId: string;
    schemaName: string;
    itemData: Record<string, any>;
  }>>([]);
  const [gameItemsLoading, setGameItemsLoading] = useState(false);
  const [extractingItemId, setExtractingItemId] = useState<string | null>(null);
  const [harvestRemaining, setHarvestRemaining] = useState<number | null>(null);

  // 奖励提示状态
  const [rewardToast, setRewardToast] = useState<{
    show: boolean;
    success: boolean;
    message: string;
    amount?: number;
  }>({ show: false, success: false, message: '' });

  // 🎁 游戏奖励弹窗（两个来源：① 游戏事件上报触发 ② 游戏中心「点击游玩」触发，
  //   后者发放发生在跳转前的 GameCenter，结果经 sessionStorage 传递到本页展示）
  const [rewardModal, setRewardModal] = useState<{
    success: boolean;
    message: string;
    amount?: number;
    gameName?: string;
  } | null>(null);

  // 🎁 读取游戏中心点击触发的待展示奖励（sessionStorage 传递，30 秒内有效，读后即清）
  // ⚠️ 必须放在条件早退（if isLoading / if !game return）之前，否则违反 Hooks 规则 → 白屏
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(PENDING_GAME_REWARD_KEY);
      if (!raw) return;
      sessionStorage.removeItem(PENDING_GAME_REWARD_KEY);
      const pending = JSON.parse(raw) as { success: boolean; message: string; amount?: number; gameName?: string; ts: number };
      if (pending?.ts && Date.now() - pending.ts < 30_000 && pending.message) {
        setRewardModal({
          success: !!pending.success,
          message: pending.message,
          amount: pending.amount,
          gameName: pending.gameName,
        });
        window.setTimeout(() => setRewardModal(null), 6000);
      }
    } catch (e) {
      /* 非法数据忽略 */
    }
  }, []);

  // 会话开始时间戳（用于计算在线时长）
  const sessionStartRef = useRef<number>(0);

  // 方案 E + A：inline/srcDoc 模式由前端按 ?ext= 注入（server 模式由 SW 注入，见 gameFileServiceWorker-v16.js）。
  // 游戏详情刷新后 game.injections 更新 → memo 重算 → srcDoc 变化触发游戏重载（注入生效）。
  // ⚠️ srcDoc 的 baseURI 是 about:srcdoc，相对寻址必挂 → 必须传 resolveBase 为绝对文件分发 URL。
  const gameHtmlInjected = useMemo(() => {
    if (!gameHtmlContent) return null;
    let out = gameHtmlContent;
    // 方案 A：条件化注入 —— 只注入 ?ext= 指定的那一个；无 ext = 纯净原版，不注入
    const allInjections = Array.isArray(game?.injections) ? game.injections : [];
    const injections = extParam
      ? allInjections.filter((i: any) => i && i.submissionId === extParam)
      : [];
    if (injections.length) {
      out = applyInjectionsToHtml(out, injections, (inj: any) =>
        buildGameFileUrl(game.id, inj.assetBase || ''),
      );
    }
    // 内容工坊：仅 contentSop.enabled 的游戏注入 loader SDK（inline 模式；server 模式由 SW/后端注入）
    if (game?.contentSop?.enabled) {
      out = applyContentLoaderToHtml(out, true);
    }
    return out;
  }, [gameHtmlContent, game, extParam]);

  useEffect(() => {
    if (!gameId) return;

    // 加载游戏信息（先从本地缓存同步渲染，避免白屏）
    const publishedGame = getPublishedGame(gameId);
    if (publishedGame) {
      // 扩展入口识别（P1）：URL 带 ?ext=<submissionId> 时，从 questExtensions 中匹配已合并的
      // 扩展入口（entryPoint 为完整扩展路径，如 extensions/{questId}/{submissionId}/level2.html）。
      // 指定了扩展入口时同样强制走 server 托管模式，否则扩展资源相对路径无法解析。
      const extParam = searchParams.get('ext');
      // 模块化多文件游戏（RequireJS/AMD/动态 import）必须用真实 URL 渲染，
      // 否则 srcDoc 内联时运行时子资源（XHR 拉模块）解析到父页 → 404 白屏。
      // 这里强制构造服务端托管 URL，由 Service Worker 从 IndexedDB 本地缓存 / 后端 提供文件，
      // 因此即使发布记录为 inline（当时后端不可用）也能正常加载，无需重新发布。
      const effectiveGame = computeEffectiveGame(publishedGame, extParam);

      setGame(effectiveGame);
      setRenderError(null);

      // 📊 数据中心埋点：游戏启动 + 会话开始
      sessionStartRef.current = Date.now();
      const uid = currentUser?.uid || currentUser?.id || 'anonymous';
      track({ type: 'game_launch', userId: uid, gameId });
      track({ type: 'session_start', userId: uid, gameId });

      // 根据托管方式加载游戏内容
      (async () => {
        // 外部 URL 模式：直接通过 CDN/外部 URL 加载
        if (effectiveGame.hostingType === 'external' && effectiveGame.cdnUrl) {
          console.log('[GamePlay] 外部 URL 模式，将通过 src 加载:', effectiveGame.cdnUrl);
          return;
        }

        // 服务端托管模式：直接通过真实 URL iframe 加载（多文件模块化游戏的正确渲染方式）
        // Service Worker 会拦截该 URL：后端优先，失败回放 IndexedDB 本地文件
        if (effectiveGame.hostingType === 'server' && effectiveGame.cdnUrl) {
          // 兜底：原本 inline 的单文件游戏被提升为 server（扩展需透传 ?ext=）时，历史发布可能
          // 只在文档里存了 entryHtmlContent 而文件库没有 → 探测失败回退内联，避免白屏。
          if (publishedGame.hostingType === 'inline' && !publishedGame.isModular) {
            fetch(effectiveGame.cdnUrl, { method: 'GET' })
              .then(async (r) => {
                if (r.ok) return;
                const html = (await getCloudHostedGameHtml(gameId)) || (await getSelfContainedGameHtml(gameId));
                if (html) {
                  setGameHtmlContent(html);
                  setGame((g) => (g ? { ...g, hostingType: 'inline' as const } : g));
                }
              })
              .catch(() => {});
          }
          console.log('[GamePlay] 服务端托管模式（SW 提供文件），将通过真实 URL 加载:', effectiveGame.cdnUrl);
          return;
        }

        // ① 云托管模式（优先）：从 CloudBase 云存储加载，URL 重写为永久公开链接
        // 子资源由浏览器直接从云存储 CDN 按需加载，零鉴权
        const cloudHtml = await getCloudHostedGameHtml(gameId);
        if (cloudHtml) {
          setGameHtmlContent(cloudHtml);
          console.log('[GamePlay] 云托管模式（URL 重写），HTML 大小:', cloudHtml.length, '字节');
          return;
        }

        // ② 回退：自包含内联模式（本地缓存 / 文档 entryHtmlContent）
        const entryContent = await getSelfContainedGameHtml(gameId);
        if (entryContent) {
          setGameHtmlContent(entryContent);
          console.log('[GamePlay] 自包含内联模式（回退），大小:', entryContent.length, '字节');
        } else {
          console.log('[GamePlay] 云托管与本地均无内容');
        }
      })();

      // 加载游戏启用的Skills
      const enabledSkills: GameSkill[] = [
        { id: 'wallet', name: '钱包系统', icon: 'fa-wallet', description: '游戏币管理', enabled: publishedGame.skills?.includes('wallet') },
        { id: 'inventory', name: '道具系统', icon: 'fa-box', description: '道具管理', enabled: publishedGame.skills?.includes('inventory') },
        { id: 'store', name: '商店系统', icon: 'fa-store', description: '游戏内购买', enabled: publishedGame.skills?.includes('store') },
        { id: 'achievements', name: '成就系统', icon: 'fa-trophy', description: '成就追踪', enabled: publishedGame.skills?.includes('achievements') },
      ];
      setSkills(enabledSkills);

      // 加载余额
      loadBalance();
      loadVoucherBalance();
    }
    setIsLoading(false);

    // ⚠️ 异步刷新最新详情（跨浏览器权威数据，含合并后的 questExtensions）：
    // 任务合并（merge）只写后端，前端缓存可能滞后，若不刷新会导致「扩展已合并但
    // 游戏里扩展入口不显示 / ?ext= 匹配不到」→ 白屏或回退原版入口。
    // 拿到最新数据后用 computeEffectiveGame 重算（含扩展入口的 server 托管 URL）。
    refreshGameDetail(gameId).then((fresh) => {
      if (!fresh || !gameId) return;
      const extParam = searchParams.get('ext');
      const freshEffective = computeEffectiveGame(fresh, extParam);
      setGame((prev) => {
        // 仅当最新数据与当前不同（例如 questExtensions 出现）时更新，避免无谓重渲染
        const prevKey = prev ? JSON.stringify(prev.questExtensions || null) : '';
        const freshKey = JSON.stringify(fresh.questExtensions || null);
        return prevKey === freshKey ? prev : freshEffective;
      });
      setRenderError(null);
    });
  }, [gameId, searchParams]);

  // 📊 数据中心埋点：会话结束（离开页面/切换游戏时上报在线时长）
  useEffect(() => {
    return () => {
      if (sessionStartRef.current && gameId) {
        const uid = currentUser?.uid || currentUser?.id || 'anonymous';
        track({
          type: 'session_end',
          userId: uid,
          gameId,
          payload: { durationMs: Date.now() - sessionStartRef.current },
        });
      }
    };
  }, [gameId, currentUser]);

  const loadBalance = async () => {
    try {
      const result = await skillGateway.execute('wallet', 'getBalance', {}, {
        userId: currentUser?.uid || currentUser?.id || 'anonymous',
        sessionId: 'web',
      });
      if (result.success && result.data) {
        const raw = result.data as any;
        const walletData = raw?.data ?? raw;
        setBalance({
          gameCoins: walletData.gameCoins || 0,
        });
      }
    } catch (error) {
      console.error('加载余额失败:', error);
    }
  };

  // 加载凭证余额
  const loadVoucherBalance = () => {
    if (!currentUser?.id) return;
    
    try {
      const vouchers = voucherService.getUserVouchers(currentUser.id);
      const activeVouchers = vouchers.filter(
        v => v.status === 'active' && isCurrencyVoucher((v as any).sourceType)
      );
      const totalValue = activeVouchers.reduce((sum, v) => sum + v.denomination, 0);
      setVoucherBalance({
        count: activeVouchers.length,
        totalValue,
      });
    } catch (error) {
      console.error('加载凭证余额失败:', error);
    }
  };

  const handleFullscreen = useCallback(() => {
    const iframe = document.getElementById('game-iframe') as HTMLIFrameElement;
    if (iframe) {
      if (iframe.requestFullscreen) {
        iframe.requestFullscreen();
      }
    }
  }, []);

  // 显示奖励提示
  const showRewardToast = (success: boolean, message: string, amount?: number) => {
    setRewardToast({ show: true, success, message, amount });
    setTimeout(() => {
      setRewardToast(prev => ({ ...prev, show: false }));
    }, 4000);
  };

  // 显示游戏奖励弹窗（6 秒自动关闭，或手动关闭）
  const showRewardModal = (payload: { success: boolean; message: string; amount?: number; gameName?: string }) => {
    setRewardModal(payload);
    window.setTimeout(() => setRewardModal(prev => (prev && prev.message === payload.message ? null : prev)), 6000);
  };

  // 触发游戏奖励
  const triggerGameReward = useCallback(async (eventType: string, eventData?: Record<string, any>) => {
    if (!currentUser?.id || !gameId) {
      console.log('[GamePlay] 用户未登录或游戏ID不存在，跳过奖励发放');
      return;
    }

    try {
      // 查找该游戏的活跃绑定配置（按事件匹配绑定触发方式，与绑定页选项语义一致）：
      // 成就解锁 → 「成就解锁时」；通关/胜利/过关/分数里程碑 → 「游戏完成时」
      const expectedMode = eventType === 'ACHIEVEMENT_UNLOCK'
        ? TriggerMode.ON_ACHIEVEMENT
        : TriggerMode.ON_GAME_COMPLETE;
      const bindings = platformBindingService.getActiveBindingsForGame(gameId, expectedMode);
      
      if (bindings.length === 0) {
        console.log(`[GamePlay] 游戏 ${gameId} 没有配置奖励规则`);
        return;
      }

      console.log(`[GamePlay] 为游戏 ${gameId} 触发奖励，找到 ${bindings.length} 个绑定配置`);

      // 依次处理每个绑定配置
      for (const binding of bindings) {
        const result = await platformBindingService.distributeSimpleReward(
          binding.id,
          currentUser.id,
          currentUser.username || '玩家',
          {
            event: eventType,
            gameId,
            gameType: GameType.PUBLISHED,
            timestamp: Date.now(),
            ...eventData,
          }
        );

        if (result.success && result.record) {
          // 🎁 奖励已发放：弹出游戏奖励弹窗（醒目告知，替代原顶部 toast）
          showRewardModal({
            success: true,
            message: '通过游戏事件触发',
            amount: result.record.amount,
          });
          loadVoucherBalance(); // 刷新凭证余额
          // 通知外部钱包组件刷新
          window.dispatchEvent(new CustomEvent('wallet-updated', { detail: { userId: currentUser.id } }));
          console.log(`[GamePlay] 奖励发放成功:`, result.record);
        } else if (result.error) {
          // 只在特定情况下显示错误（如冷却中）
          if (result.error.includes('冷却') || result.error.includes('上限')) {
            console.log(`[GamePlay] 奖励未发放: ${result.error}`);
          }
        }
      }
    } catch (error) {
      console.error('[GamePlay] 触发奖励失败:', error);
    }
  }, [currentUser, gameId]);

  // ===== AllinONE Protocol Engine =====
  const protocolRef = useRef<ProtocolEngine | null>(null);

  useEffect(() => {
    if (!gameId) return;

    // 🆕 使用全局单例：voucherItemService 的道具兑换/跨游戏适配下发走
    // getDefaultEngine().sendToGame()，若这里 new 独立实例会导致两个引擎的
    // channels 互不可见 →「游戏通道不存在」→ 购买的道具永远无法进游戏。
    // 回调配置通过 ensureConfig 补挂（单例可能在 import 时已被无参创建）。
    const engine = getDefaultEngine();
    engine.ensureConfig({
      debug: false,
      skillGateway: skillGateway as any,
      authContextProvider: async () => ({
        userId: currentUser?.id || 'anonymous',
        sessionId: crypto.randomUUID(),
        source: 'gameplay',
      }),
      onRedeem: async (code: string, redeemGameId: string) => {
        if (!currentUser?.id) {
          return { success: false, message: '用户未登录' };
        }

        const targetGameId = redeemGameId || gameId;
        if (!targetGameId) {
          return { success: false, message: '游戏ID无效' };
        }

        try {
          const verifyResult = await redeemCodeService.verifyCode({
            code,
            gameId: targetGameId,
            userId: currentUser.id,
          });

          if (!verifyResult.valid) {
            // 增强错误提示
            let errorMessage = verifyResult.message || '兑换码无效';
            if (errorMessage === '兑换码不存在') {
              errorMessage = '兑换码无效，请检查是否输入正确';
            } else if (errorMessage === '兑换码已被使用') {
              errorMessage = '该兑换码已被使用';
            } else if (errorMessage === '兑换码已过期') {
              errorMessage = '该兑换码已过期';
            } else if (errorMessage === '兑换码已禁用') {
              errorMessage = '该兑换码已被禁用';
            }
            return {
              success: false,
              message: errorMessage,
            };
          }

          const useResult = await redeemCodeService.useCode({
            code,
            gameId: targetGameId,
            userId: currentUser.id,
          });

          if (!useResult.success) {
            return {
              success: false,
              message: useResult.message || '兑换码使用失败',
            };
          }

          const item = useResult.item;
          const gameEffect = item?.gameEffect as Record<string, any> | undefined;

          // effectType: 优先读一等字段，回退到 metadata.effectType
          const effectType = gameEffect?.effectType || (gameEffect?.metadata?.effectType as string) || 'custom';

          // effects: 提取效果参数（排除元数据字段），传给 Effect Engine
          const rawMetadata = (gameEffect?.metadata || {}) as Record<string, any>;
          const { rarity, supplyPolicy, effectType: _et, ...effectParams } = rawMetadata;

          showRewardToast(true, `兑换成功! 获得 ${item?.name || '道具'}`);

          // ⚠️ 不再单独发送 EXTENSION_VOUCHER（避免与 REDEEM_RESULT 重复导致用户收到2个道具）
          // Schema 道具数据通过 REDEEM_RESULT.voucherData 单一通道传递
          // voucherItemService.redeemItemVoucherBySchema 的 URL 参数路径仍使用 EXTENSION_VOUCHER（独立通道，不经过 onRedeem）

          // realEffectName: 真实效果名（如 heal/invincible），优先 itemData.effect → itemId
          // → 非 custom 的 effectType；最终回落 'custom'。
          // ⚠️ 不能用 effectType 直接填 effect：effectType 默认 'custom'，
          // 会导致游戏侧 EFFECT_HANDLERS['custom'] 不存在 → 「未找到效果: custom」。
          const realEffectName =
            (gameEffect?.itemData as Record<string, any> | undefined)?.effect ||
            gameEffect?.itemId ||
            (effectType !== 'custom' ? effectType : '') ||
            'custom';

          return {
            success: true,
            code,
            itemId: gameEffect?.itemId || '',
            itemName: item?.name || '道具',
            quantity: gameEffect?.quantity || 1,
            effectType,
            effects: effectParams,
            // 🆕 voucherData: 携带完整的 itemData（effect/effectCode/effectScript/params/icon）
            // 游戏端 SDK/桥接通过 REDEEM_RESULT → CustomEvent → handleRedeemedItem 接收
            // voucherData: 优先用 itemData；缺失时合成 effect 填真实效果名（realEffectName），
            // 保证游戏侧 EFFECT_HANDLERS[realEffectName] 可命中（而非 'custom'）。
            voucherData: gameEffect?.itemData
              ? { ...(gameEffect.itemData as Record<string, any>), effect: realEffectName }
              : {
                  effect: realEffectName,
                  params: effectParams,
                  itemId: gameEffect?.itemId,
                  effectType,
                },
            schemaName: gameEffect?.schemaName || null,
            message: `兑换成功! 获得 ${item?.name || '道具'}`,
          };
        } catch (error) {
          return {
            success: false,
            message: error instanceof Error ? error.message : '兑换失败',
          };
        }
      },
    });

    // 启动协议监听
    engine.startListening();

    // 监听协议游戏事件 → 触发奖励 / 处理游戏内道具提取（ITEM_HARVEST）
    // （单例模式：handler 必须具名，cleanup 时 engine.off 注销，防止反复进出
    // 游戏页在共享单例上累积重复监听器 → 同一事件被处理多次）
    const gameEventHandler = ({ event, data }: { event: string; data: any }) => {
      // 🆕 游戏内道具收获 → 校验+风控+铸造道具凭证（可交易），结果回发游戏
      if (event === 'ITEM_HARVEST') {
        const harvestData = data || {};
        const allowedSchemas = engine.getChannelState(gameId)?.supportedSchemas || [];
        const result = itemHarvestService.processItemHarvest({
          gameId,
          userId: currentUser?.id || '',
          userName: currentUser?.username,
          schemaName: String(harvestData.schemaName || ''),
          itemData: harvestData.itemData,
          quantity: 1,
          harvestId: harvestData.harvestId ? String(harvestData.harvestId) : undefined,
          allowedSchemas,
        });
        // 回发结果：游戏收到 success 后删除游戏内道具（防双花）
        engine.sendToGame(gameId, {
          type: 'PLATFORM_EVENT',
          event: 'ITEM_HARVEST_RESULT',
          data: { ...result, harvestId: harvestData.harvestId },
          timestamp: Date.now(),
        });
        showRewardToast(result.success, result.message);
        return;
      }

      // 🆕 P1 游戏回报道具列表（响应 REQUEST_GAME_ITEMS）：更新「我的游戏道具」面板
      if (event === 'GAME_ITEMS') {
        const items = Array.isArray((data || {}).items) ? data.items : [];
        setGameItems(
          items
            .filter((it: any) => it && typeof it.itemId === 'string' && it.itemData && typeof it.itemData === 'object')
            .map((it: any) => ({
              itemId: String(it.itemId),
              schemaName: String(it.schemaName || ''),
              itemData: it.itemData as Record<string, any>,
            })),
        );
        setGameItemsLoading(false);
        return;
      }

      if (['GAME_COMPLETE', 'GAME_WIN', 'LEVEL_COMPLETE', 'ACHIEVEMENT_UNLOCK', 'SCORE_MILESTONE'].includes(event)) {
        triggerGameReward(event.replace('GAME_', ''), data);
        try { globalEventBus.emit('game.played', { gameId, event }, { userId: 'anonymous', sessionId: 'web' }); } catch { /* ignore */ }
      }
    };
    engine.on('game:event', gameEventHandler);

    protocolRef.current = engine;

    return () => {
      // 🆕 单例模式：注销本页监听器 + 只释放本游戏通道，绝不 destroy()
      // （会清空全局 channels/listeners，且 defaultEngine 仍指向该实例 → 空壳引擎）
      engine.off('game:event', gameEventHandler);
      engine.releaseChannel(gameId);
      protocolRef.current = null;
    };
  }, [gameId, currentUser, triggerGameReward]);

  // iframe 加载完成后建立协议通道
  useEffect(() => {
    // 判断是否有任何可加载的游戏内容
    const hasExternalHosting = game?.hostingType === 'external' && !!game?.cdnUrl;
    if (!gameId || !gameHtmlContent && !game?.cdnUrl && !hasExternalHosting) return;

    // 等待 DOM 渲染完成找到 iframe
    const timer = setTimeout(() => {
      const iframe = document.getElementById('game-iframe') as HTMLIFrameElement;
      if (iframe && protocolRef.current && gameId) {
        // 使用游戏发布时保存的协议模式，默认 inject
        const channelMode = (game as any)?.protocolMode === 'integrated' ? 'integrated' : 'inject';
        protocolRef.current.establishChannel(gameId, iframe, {
          mode: channelMode,
          skills: skills.filter(s => s.enabled).map(s => s.id),
        });
        console.log('[GamePlay] 协议通道已建立:', gameId, 'mode:', channelMode);
      }
    }, 1000);

    return () => clearTimeout(timer);
  }, [gameId, gameHtmlContent, game?.cdnUrl, game?.hostingType, skills]);

  // 🆕 URL 参数自动下发：检测 itemVoucher / redeemVoucher 参数，轮询等待通道就绪后自动下发
  useEffect(() => {
    const pendingVoucherId = searchParams.get('itemVoucher') || searchParams.get('redeemVoucher');
    if (!pendingVoucherId || !gameId || !currentUser?.id) return;

    let cancelled = false;
    let attempts = 0;
    const MAX_ATTEMPTS = 30; // 500ms × 30 = 15s

    const tryDispatch = () => {
      if (cancelled) return;
      attempts++;

      if (!protocolRef.current) {
        if (attempts < MAX_ATTEMPTS) {
          setTimeout(tryDispatch, 500);
        } else {
          console.warn('[GamePlay] 协议引擎未就绪，放弃自动下发');
        }
        return;
      }

      const channelState = protocolRef.current.getChannelState(gameId);
      if (!channelState || channelState.status !== 'connected') {
        if (attempts < MAX_ATTEMPTS) {
          setTimeout(tryDispatch, 500);
        } else {
          console.warn('[GamePlay] 游戏通道未就绪，放弃自动下发');
          showRewardToast(false, '游戏通道未就绪，请稍后再试');
        }
        return;
      }

      // 通道就绪，执行兑换
      import('@/services/voucherItemService').then(({ voucherItemService: vis }) => {
        if (cancelled) return;

        // 🆕 内容凭证（内容工坊）走专用通道：核销后直接 postMessage CONTENT_PACK_APPLY，
        // 不走 redeemItemVoucher（schemaName 'content' 未注册，走道具通道必报「Schema 未注册」）
        const isContent = vis.getUserContentVouchers(currentUser.id!, gameId)
          .some(v => v.id === pendingVoucherId);
        if (isContent) {
          const r = vis.redeemContentVoucher({
            userId: currentUser.id!,
            userName: currentUser.username || '玩家',
            voucherId: pendingVoucherId,
            gameId,
          });
          if (r.success && r.content) {
            const iframe = document.getElementById('game-iframe') as HTMLIFrameElement;
            if (iframe?.contentWindow) {
              // assetBase 用文件分发根（manifest.assets.path 已含 content/{contentId}/ 前缀）
              iframe.contentWindow.postMessage(
                {
                  type: 'CONTENT_PACK_APPLY',
                  content: {
                    contentId: r.content.contentId,
                    gameId: r.content.gameId,
                    type: r.content.type,
                    slot: r.content.slot,
                    name: r.content.name,
                    description: r.content.description,
                    data: r.content.manifest?.data,
                    assets: Array.isArray(r.content.manifest?.assets) ? r.content.manifest.assets : [],
                    assetBase: buildGameFileUrl(gameId, ''),
                  },
                },
                '*',
              );
              showRewardToast(true, `内容「${r.content.name}」已激活，本次会话生效！`);
            } else {
              showRewardToast(false, '游戏窗口不可用，请稍后再试');
            }
          } else {
            showRewardToast(false, r.message || '内容凭证使用失败');
          }
          return;
        }

        const result = vis.redeemItemVoucher({
          userId: currentUser.id!,
          userName: currentUser.username || '玩家',
          voucherId: pendingVoucherId,
          gameId,
        });

        // 跨游戏道具：不能在游戏页直接下发，引导到游戏商店选择兑换方式
        if (result.needsConversion) {
          showRewardToast(false, `该道具来自其他游戏，请先到「游戏商店 → 我的道具」完成跨游戏兑换`);
          console.warn('[GamePlay] 跨游戏道具未选择兑换方式:', result.sourceGameId, pendingVoucherId);
          return;
        }
        if (result.success && result.dispatchedToGame) {
          showRewardToast(true, `道具「${result.gameInfo?.itemData?.name || '未知'}」已发送到游戏！`);
          console.log('[GamePlay] URL 参数自动下发成功:', pendingVoucherId);
        } else if (result.success) {
          showRewardToast(true, result.message);
          console.log('[GamePlay] URL 参数兑换成功（未下发到游戏）:', pendingVoucherId);
        } else {
          showRewardToast(false, result.message);
          console.warn('[GamePlay] URL 参数自动下发失败:', result.message);
        }
      }).catch(err => {
        console.error('[GamePlay] 加载 voucherItemService 失败:', err);
      });
    };

    // 首次延迟1s后开始轮询（等待 iframe 建立）
    const startTimer = setTimeout(tryDispatch, 1000);
    return () => {
      cancelled = true;
      clearTimeout(startTimer);
    };
  }, [gameId, searchParams, currentUser?.id, gameHtmlContent, game?.cdnUrl, game?.hostingType]);

  // 内容工坊：加载用户持有的内容凭证（仅 contentSop 启用的游戏显示入口）
  // ⚠️ 必须放在条件早退（if isLoading / if !game return）之前，否则违反 Hooks 规则 → 白屏
  useEffect(() => {
    if (!game?.contentSop?.enabled || !currentUser?.id || !gameId) {
      setContentVouchers([]);
      return;
    }
    import('@/services/voucherItemService').then(({ voucherItemService: vis }) => {
      try {
        setContentVouchers(vis.getUserContentVouchers(currentUser.id!, gameId));
      } catch (e) {
        console.warn('[GamePlay] 加载内容凭证失败:', e);
      }
    });
  }, [game, currentUser?.id, gameId]);

  // 方案 C：用 base 快照回滚 —— 历史 merge 把扩展数据直接 push 进 base（levels/items），
  // 方案 A 的条件注入只止血、不清理已污染字段；快照覆盖可让原版回到纯净态。
  // ⚠️ 必须放在条件早退（if isLoading / if !game return）之前，否则违反 Hooks 规则 → 白屏
  // ⚠️ 这是全局治理动作（影响所有玩家），会清空已合并的注入脚本。
  const handleRestoreOriginal = useCallback(async () => {
    const snap = (game as any)?.baseSnapshot as (Record<string, any> & { snapshotAt?: number }) | undefined;
    if (!gameId) return;
    const ok = window.confirm(
      snap
        ? '将用「首次合并前」的 base 快照覆盖当前数据（关卡/道具等挂载点字段 + 清空注入脚本）。\n' +
          '已合并的注入型扩展会失效（需重新提交合并）。此操作影响所有玩家，确定继续？'
        : '该游戏没有 base 快照（合并发生在快照功能上线之前）。\n' +
          '将按「剔除所有带 _submissionId 的扩展条目 + 清空注入脚本」还原原版。\n' +
          '已合并的注入型扩展会失效（需重新提交合并）。此操作影响所有玩家，确定继续？',
    );
    if (!ok) return;
    setRestoringBase(true);
    try {
      const patch: Record<string, any> = snap ? { injections: [] } : buildDerivedBase(game);
      if (snap) {
        for (const k of Object.keys(snap)) {
          if (k === 'snapshotAt') continue;
          patch[k] = (snap as any)[k];
        }
      }
      const saved = await patchGameOnBackend(gameId, patch);
      if (!saved) {
        window.alert('恢复失败：后端不可用，未做任何改动。');
        return;
      }
      // 清掉 SW/Cache Storage 里可能残留的「已注入版」入口 HTML，避免回滚后仍加载旧副本
      if (typeof caches !== 'undefined') {
        const keys = await caches.keys();
        await Promise.all(keys.filter((k) => /allinone|game/i.test(k)).map((k) => caches.delete(k)));
      }
      const fresh = await refreshGameDetail(gameId);
      if (fresh) setGame(computeEffectiveGame(fresh, extParam));
      setShowExtMenu(false);
      window.location.reload();
    } catch (e) {
      window.alert('恢复失败：' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setRestoringBase(false);
    }
  }, [game, gameId, extParam]);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center">
        <div className="text-center">
          <div className="w-16 h-16 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
          <p className="text-white">加载游戏中...</p>
        </div>
      </div>
    );
  }

  if (!game) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center">
        <div className="text-center">
          <i className="fa-solid fa-gamepad text-6xl text-slate-600 mb-4"></i>
          <h2 className="text-2xl font-bold text-white mb-2">游戏未找到</h2>
          <p className="text-slate-400 mb-4">该游戏可能已被删除或不存在</p>
          <Link
            to="/game-center"
            className="px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium transition-colors"
          >
            返回游戏中心
          </Link>
        </div>
      </div>
    );
  }

  // 审核机制守卫：未通过审核（待审核/已驳回/需修改/已下架）的游戏不可游玩。
  // 后端列表/详情接口已过滤，此分支拦截「前端本地缓存残留未过审游戏」的边缘情况。
  if (game.reviewStatus && game.reviewStatus !== 'approved') {
    const statusText: Record<string, string> = {
      pending: '该游戏正在等待管理员审核，审核通过后将公开上架',
      rejected: '该游戏未通过平台审核，暂不可游玩',
      changes_required: '该游戏需要修改后重新提交审核，暂不可游玩',
      removed: '该游戏已被平台下架',
    };
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center">
        <div className="text-center max-w-md px-4">
          <i className="fa-solid fa-shield-halved text-6xl text-slate-600 mb-4"></i>
          <h2 className="text-2xl font-bold text-white mb-2">游戏暂不可用</h2>
          <p className="text-slate-400 mb-6">{statusText[game.reviewStatus] || '该游戏暂不可用'}</p>
          <Link
            to="/game-center"
            className="px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium transition-colors"
          >
            返回游戏中心
          </Link>
        </div>
      </div>
    );
  }

  // 使用内容凭证：兑换（消耗 1 张）→ postMessage CONTENT_PACK_APPLY → 游戏内 loader 按次应用
  // 🆕 P1 平台侧反向提取：请求游戏回报道具列表（游戏监听 REQUEST_GAME_ITEMS 回 GAME_ITEMS）
  // ⚠️ 必须是普通函数而非 useCallback——本位置在早退 return 之后（GamePlay Hooks 铁律），
  // hook 会导致 loading→ready 切换时 hooks 数量变化而整树白屏。
  const fetchGameItems = () => {
    if (!gameId || !protocolRef.current) return;
    setGameItemsLoading(true);
    protocolRef.current.sendToGame(gameId, {
      type: 'PLATFORM_EVENT',
      event: 'REQUEST_GAME_ITEMS',
      data: {},
      timestamp: Date.now(),
    });
    // 3s 未响应视为游戏未实现道具列表接口（兼容未接入的游戏）：
    // 若期间 GAME_ITEMS 已到达（loading 已被置 false），此处不再动作
    setTimeout(() => {
      setGameItemsLoading(prev => (prev ? false : prev));
    }, 3000);
  };

  // 🆕 P1 平台侧反向提取：把游戏内道具提取为平台凭证（走与游戏内掉落提取完全相同的
  // 校验/白名单/每日限额/幂等链路；harvestId = 游戏 itemId 天然幂等去重）
  const handleExtractGameItem = (item: { itemId: string; schemaName: string; itemData: Record<string, any> }) => {
    if (!gameId || extractingItemId) return;
    if (!currentUser?.id) {
      showRewardToast(false, '请先登录后再提取道具');
      return;
    }
    setExtractingItemId(item.itemId);
    try {
      const allowedSchemas = protocolRef.current?.getChannelState(gameId)?.supportedSchemas || [];
      const result = itemHarvestService.processItemHarvest({
        gameId,
        userId: currentUser.id,
        userName: currentUser.username,
        schemaName: item.schemaName,
        itemData: item.itemData,
        quantity: 1,
        harvestId: item.itemId,
        allowedSchemas,
      });
      // 成功（或幂等命中 duplicate：之前已提取成功但游戏侧残留）→ 通知游戏删除该道具（防双花）
      if (result.success || result.reason === 'duplicate') {
        protocolRef.current?.sendToGame(gameId, {
          type: 'PLATFORM_EVENT',
          event: 'ITEM_CONSUMED',
          data: { itemId: item.itemId },
          timestamp: Date.now(),
        });
        setGameItems(prev => prev.filter(it => it.itemId !== item.itemId));
        setHarvestRemaining(
          currentUser.id ? itemHarvestService.getRemainingToday(currentUser.id, gameId) : null,
        );
      }
      showRewardToast(result.success, result.message);
    } catch (err) {
      showRewardToast(false, err instanceof Error ? `提取失败: ${err.message}` : '提取失败，请稍后再试');
    } finally {
      setExtractingItemId(null);
    }
  };

  const handleUseContentVoucher = async (voucherId: string) => {
    if (!gameId || !currentUser?.id) return;
    setApplyingContentId(voucherId);
    try {
      const { voucherItemService: vis } = await import('@/services/voucherItemService');
      const result = vis.redeemContentVoucher({
        userId: currentUser.id,
        userName: currentUser.username || '玩家',
        voucherId,
        gameId,
      });
      if (!result.success || !result.content) {
        showRewardToast(false, result.message || '使用失败');
        setApplyingContentId(null);
        return;
      }
      const content = result.content;
      const iframe = document.getElementById('game-iframe') as HTMLIFrameElement;
      if (iframe && iframe.contentWindow) {
        // assetBase 用文件分发根（manifest.assets.path 已含 content/{contentId}/ 前缀）
        iframe.contentWindow.postMessage(
          {
            type: 'CONTENT_PACK_APPLY',
            content: {
              contentId: content.contentId,
              gameId: content.gameId,
              type: content.type,
              slot: content.slot,
              name: content.name,
              description: content.description,
              data: content.manifest?.data,
              assets: Array.isArray(content.manifest?.assets) ? content.manifest.assets : [],
              assetBase: buildGameFileUrl(gameId, ''),
            },
          },
          '*',
        );
        showRewardToast(true, `内容「${content.name}」已激活，本次会话生效！`);
      } else {
        showRewardToast(false, '游戏窗口不可用，请稍后再试');
      }
      // 刷新列表（已消耗 1 张）
      setContentVouchers(vis.getUserContentVouchers(currentUser.id!, gameId));
    } catch (e) {
      showRewardToast(false, e instanceof Error ? e.message : '使用失败');
    } finally {
      setApplyingContentId(null);
    }
  };

  // 扩展入口（render 侧计算，与 useEffect 内逻辑一致；供 header 扩展菜单高亮当前入口）
  // 数据型扩展（entryPoint 空）也计入：高亮表示「已进入该扩展（原版入口 + 游戏内自动选关）」
  const questExt =
    extParam && Array.isArray(game?.questExtensions)
      ? game.questExtensions.find((e) => e.submissionId === extParam)
      : undefined;

  return (
    <div className="min-h-screen bg-slate-900 relative overflow-x-hidden">
      {/* 奖励提示 Toast */}
      <AnimatePresence>
        {rewardToast.show && (
          <motion.div
            initial={{ opacity: 0, y: -50, x: '-50%' }}
            animate={{ opacity: 1, y: 0, x: '-50%' }}
            exit={{ opacity: 0, y: -50, x: '-50%' }}
            className={`fixed top-20 sm:top-24 left-1/2 z-50 px-4 sm:px-6 py-3 sm:py-4 rounded-xl shadow-2xl flex items-center gap-3 max-w-[92vw] ${
              rewardToast.success
                ? 'bg-gradient-to-r from-green-600 to-emerald-600 text-white'
                : 'bg-gradient-to-r from-red-600 to-orange-600 text-white'
            }`}
          >
            {rewardToast.success ? (
              <>
                <div className="w-10 h-10 rounded-full bg-white/20 flex items-center justify-center">
                  <Coins className="w-5 h-5" />
                </div>
                <div>
                  <p className="font-bold text-sm sm:text-lg">🎉 {rewardToast.message}</p>
                  {rewardToast.amount && (
                    <p className="text-white/80 text-sm">已存入您的凭证资产</p>
                  )}
                </div>
              </>
            ) : (
              <>
                <AlertCircle className="w-6 h-6" />
                <p>{rewardToast.message}</p>
              </>
            )}
            <button
              onClick={() => setRewardToast(prev => ({ ...prev, show: false }))}
              className="ml-4 p-1 hover:bg-white/20 rounded-full transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 🎁 游戏奖励弹窗（来源：游戏事件上报 / 游戏中心点击触发；6 秒自动关闭或手动关闭） */}
      <AnimatePresence>
        {rewardModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 backdrop-blur-sm px-4"
          >
            <motion.div
              initial={{ scale: 0.85, y: 24, opacity: 0 }}
              animate={{ scale: 1, y: 0, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              transition={{ type: 'spring', stiffness: 320, damping: 26 }}
              className={`relative w-full max-w-sm rounded-2xl border shadow-2xl p-6 text-center bg-gradient-to-b from-slate-800 to-slate-900 ${
                rewardModal.success ? 'border-green-500/40' : 'border-red-500/40'
              }`}
            >
              <div
                className={`mx-auto w-16 h-16 rounded-full flex items-center justify-center mb-4 ${
                  rewardModal.success ? 'bg-green-500/20' : 'bg-red-500/20'
                }`}
              >
                {rewardModal.success ? (
                  <Gift className="w-8 h-8 text-green-400" />
                ) : (
                  <AlertCircle className="w-8 h-8 text-red-400" />
                )}
              </div>

              <h3 className={`text-lg font-bold mb-1 ${rewardModal.success ? 'text-green-400' : 'text-red-400'}`}>
                {rewardModal.success ? '游戏奖励已发放' : '奖励发放失败'}
              </h3>

              {rewardModal.success && rewardModal.amount != null && (
                <p className="text-3xl font-extrabold text-amber-400 mb-1">
                  +{rewardModal.amount}
                  <span className="text-base font-semibold ml-1">凭证</span>
                </p>
              )}

              <p className="text-slate-300 text-sm break-words">{rewardModal.message}</p>

              {rewardModal.success && (
                <p className="text-slate-500 text-xs mt-1.5">已存入你的凭证钱包，可在「我的凭证」中查看</p>
              )}

              <button
                onClick={() => setRewardModal(null)}
                className="mt-5 w-full py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-medium transition-colors"
              >
                知道了
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Header */}
      <header className="bg-slate-800 border-b border-slate-700">
        <div className="container mx-auto px-3 sm:px-4 py-3 sm:py-4">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 sm:gap-4 min-w-0">
              <Link
                to="/game-center"
                className="w-9 h-9 sm:w-10 sm:h-10 shrink-0 rounded-lg bg-slate-700 hover:bg-slate-600 flex items-center justify-center text-white transition-colors"
              >
                <i className="fa-solid fa-arrow-left"></i>
              </Link>
              <div className="min-w-0">
                <h1 className="text-base sm:text-xl font-bold text-white truncate">{game.name}</h1>
                <p className="text-xs sm:text-sm text-slate-400 truncate">{game.framework} · v{game.version}</p>
              </div>
            </div>

            <div className="flex items-center gap-2 sm:gap-4 shrink-0">
              {/* 余额显示 */}
              {skills.find(s => s.id === 'wallet')?.enabled && (
                <div className="flex items-center gap-1.5 sm:gap-3 bg-slate-700 rounded-lg px-2 sm:px-4 py-1.5 sm:py-2">
                  <div className="flex items-center gap-1 sm:gap-2" title="游戏币">
                    <i className="fa-solid fa-coins text-yellow-500"></i>
                    <span className="text-white font-medium text-sm sm:text-base">{balance.gameCoins || 0}</span>
                  </div>
                  <div className="w-px h-4 bg-slate-600"></div>
                  <div className="flex items-center gap-1 sm:gap-2" title="凭证余额">
                    <ShieldCheck className="w-4 h-4 text-blue-400" />
                    <span className="text-white font-medium text-sm sm:text-base">{voucherBalance.totalValue}</span>
                  </div>
                </div>
              )}

              {/* 扩展入口切换（P2 游戏读取侧消费：展示已合并的 questExtensions） */}
              {game.questExtensions && game.questExtensions.length > 0 && (
                <div className="relative">
                  <button
                    onClick={() => setShowExtMenu(v => !v)}
                    className={`px-2 sm:px-4 py-1.5 sm:py-2 rounded-lg font-medium transition-colors flex items-center gap-1 sm:gap-2 ${
                      questExt
                        ? 'bg-emerald-600 hover:bg-emerald-700 text-white'
                        : 'bg-slate-700 hover:bg-slate-600 text-white'
                    }`}
                  >
                    <Layers className="w-4 h-4" />
                    <span className="hidden sm:inline">
                      {questExt ? '扩展版' : `扩展 (${game.questExtensions.length})`}
                    </span>
                  </button>
                  {showExtMenu && (
                    <>
                      <div className="fixed inset-0 z-10" onClick={() => setShowExtMenu(false)} />
                      <div className="absolute right-0 top-full mt-2 z-20 w-72 bg-slate-800 border border-slate-700 rounded-xl shadow-2xl p-2 space-y-1">
                        <Link
                          to={`/game/${gameId}`}
                          onClick={() => setShowExtMenu(false)}
                          className={`block w-full text-left px-3 py-2 rounded-lg text-sm transition-colors ${
                            !questExt ? 'bg-emerald-600 text-white' : 'hover:bg-slate-700 text-slate-200'
                          }`}
                        >
                          <span className="font-medium">原版</span>
                          <span className="block text-xs opacity-70">纯净 base，不含任何扩展</span>
                        </Link>
                        {game.questExtensions.map((ext) => (
                          <Link
                            key={ext.submissionId}
                            to={`/game/${gameId}?ext=${encodeURIComponent(ext.submissionId)}`}
                            onClick={() => setShowExtMenu(false)}
                            className={`block w-full text-left px-3 py-2 rounded-lg text-sm transition-colors ${
                              questExt?.submissionId === ext.submissionId
                                ? 'bg-emerald-600 text-white'
                                : 'hover:bg-slate-700 text-slate-200'
                            }`}
                          >
                            <span className="font-medium">
                              {ext.inject ? '注入扩展' : ext.entryPoint ? '扩展版' : '资源扩展'}
                              {ext.slot ? ` · ${ext.slot}` : ''}
                            </span>
                            <span className="block text-xs opacity-70">
                              {ext.inject
                                ? '选中后注入原版入口生效（原版不受影响）'
                                : ext.assets.length > 0
                                  ? `${ext.assets.length} 个资源文件`
                                  : '无资源文件'}
                            </span>
                          </Link>
                        ))}
                        {/* 方案 C：回滚被历史 merge 污染的原版数据（有快照用快照，无快照按 _submissionId 派生） */}
                        {((game as any).baseSnapshot || (game.questExtensions?.length ?? 0) > 0) && (
                          <button
                            type="button"
                            onClick={handleRestoreOriginal}
                            disabled={restoringBase}
                            className="block w-full text-left px-3 py-2 rounded-lg text-sm transition-colors border-t border-slate-700 mt-1 pt-2 text-amber-300 hover:bg-amber-500/20 disabled:opacity-50"
                          >
                            <span className="font-medium">
                              {restoringBase ? '恢复中…' : '恢复原版（清脏数据）'}
                            </span>
                            <span className="block text-xs opacity-70">
                              {(game as any).baseSnapshot
                                ? '用合并前快照覆盖被扩展污染的数据'
                                : '剔除扩展条目并清空注入脚本'}
                            </span>
                          </button>
                        )}
                      </div>
                    </>
                  )}
                </div>
              )}

              {/* 内容工坊：使用内容凭证（仅 contentSop 启用的游戏） */}
              {game.contentSop?.enabled && (
                <div className="relative">
                  <button
                    onClick={() => setShowContentMenu(v => !v)}
                    className={`px-2 sm:px-4 py-1.5 sm:py-2 rounded-lg font-medium transition-colors flex items-center gap-1 sm:gap-2 ${
                      showContentMenu
                        ? 'bg-cyan-600 hover:bg-cyan-700 text-white'
                        : 'bg-slate-700 hover:bg-slate-600 text-white'
                    }`}
                    title="使用内容凭证（按次使用）"
                  >
                    <Boxes className="w-4 h-4" />
                    <span className="hidden sm:inline">内容凭证 ({contentVouchers.length})</span>
                  </button>
                  {showContentMenu && (
                    <>
                      <div className="fixed inset-0 z-10" onClick={() => setShowContentMenu(false)} />
                      <div className="absolute right-0 top-full mt-2 z-20 w-80 bg-slate-800 border border-slate-700 rounded-xl shadow-2xl p-2 space-y-1 max-h-96 overflow-y-auto">
                        {contentVouchers.length === 0 ? (
                          <div className="px-3 py-6 text-center">
                            <Boxes className="w-8 h-8 text-slate-600 mx-auto mb-2" />
                            <p className="text-sm text-slate-400">暂无可用内容凭证</p>
                            <p className="text-xs text-slate-500 mt-1">去「内容工坊」创作并铸造内容凭证</p>
                          </div>
                        ) : (
                          contentVouchers.map(v => {
                            const cd = v.metadata?.customData || {};
                            return (
                              <button
                                key={v.id}
                                onClick={() => handleUseContentVoucher(v.id)}
                                disabled={applyingContentId === v.id}
                                className="block w-full text-left px-3 py-2 rounded-lg text-sm transition-colors hover:bg-slate-700 disabled:opacity-50"
                              >
                                <span className="flex items-center justify-between gap-2">
                                  <span className="font-medium flex items-center gap-2">
                                    <Boxes className="w-3.5 h-3.5 text-cyan-400" />
                                    {v.metadata?.name || '内容'}
                                  </span>
                                  <span className="text-xs text-slate-500">x1</span>
                                </span>
                                <span className="block text-xs opacity-70 mt-0.5">
                                  {cd.contentType || '内容'} · {cd.contentSlot || ''}
                                  {v.metadata?.description ? ` · ${String(v.metadata.description).slice(0, 40)}` : ''}
                                </span>
                                <span className="block text-xs text-cyan-400 mt-0.5">
                                  {applyingContentId === v.id ? '激活中...' : '点击使用（本次会话生效，凭证消耗）'}
                                </span>
                              </button>
                            );
                          })
                        )}
                        <Link
                          to="/content-workshop"
                          className="block w-full text-center px-3 py-2 rounded-lg text-xs bg-slate-700/50 hover:bg-slate-700 text-slate-300 mt-1"
                        >
                          前往内容工坊 →
                        </Link>
                      </div>
                    </>
                  )}
                </div>
              )}

              {/* 🆕 P1 游戏内道具反向提取：我的游戏道具 → 提取为凭证 */}
              <div className="relative">
                <button
                  onClick={() => {
                    const next = !showGameItemsMenu;
                    setShowGameItemsMenu(next);
                    if (next) {
                      fetchGameItems();
                      if (currentUser?.id && gameId) {
                        setHarvestRemaining(itemHarvestService.getRemainingToday(currentUser.id, gameId));
                      }
                    }
                  }}
                  className={`px-2 sm:px-4 py-1.5 sm:py-2 rounded-lg font-medium transition-colors flex items-center gap-1 sm:gap-2 ${
                    showGameItemsMenu
                      ? 'bg-amber-600 hover:bg-amber-700 text-white'
                      : 'bg-slate-700 hover:bg-slate-600 text-white'
                  }`}
                  title="查看游戏内道具并提取为平台凭证"
                >
                  <Package className="w-4 h-4" />
                  <span className="hidden sm:inline">游戏道具{gameItems.length > 0 ? ` (${gameItems.length})` : ''}</span>
                </button>
                {showGameItemsMenu && (
                  <>
                    <div className="fixed inset-0 z-10" onClick={() => setShowGameItemsMenu(false)} />
                    <div className="absolute right-0 top-full mt-2 z-20 w-80 bg-slate-800 border border-slate-700 rounded-xl shadow-2xl p-2 space-y-1 max-h-96 overflow-y-auto">
                      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700">
                        <span className="text-sm font-medium text-white">游戏内道具</span>
                        <span className="text-xs text-slate-400">
                          {harvestRemaining !== null ? `今日剩余 ${harvestRemaining}/10 次` : ''}
                        </span>
                      </div>
                      {gameItemsLoading && gameItems.length === 0 ? (
                        <div className="px-3 py-6 text-center">
                          <Package className="w-8 h-8 text-slate-600 mx-auto mb-2 animate-pulse" />
                          <p className="text-sm text-slate-400">正在从游戏读取道具…</p>
                        </div>
                      ) : gameItems.length === 0 ? (
                        <div className="px-3 py-6 text-center">
                          <Package className="w-8 h-8 text-slate-600 mx-auto mb-2" />
                          <p className="text-sm text-slate-400">游戏中暂无可提取道具</p>
                          <p className="text-xs text-slate-500 mt-1">游戏内获得的掉落道具会出现在这里（无需等游戏内手动提取）</p>
                        </div>
                      ) : (
                        gameItems.map(item => (
                          <div key={item.itemId} className="px-3 py-2 rounded-lg hover:bg-slate-700/60">
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-medium text-sm text-white truncate">
                                {item.itemData?.name || '未知道具'}
                              </span>
                              <button
                                onClick={() => handleExtractGameItem(item)}
                                disabled={extractingItemId === item.itemId}
                                className="shrink-0 px-2.5 py-1 text-xs bg-amber-600 hover:bg-amber-700 disabled:opacity-50 text-white rounded-lg transition-colors"
                              >
                                {extractingItemId === item.itemId ? '提取中…' : '提取为凭证'}
                              </button>
                            </div>
                            <div className="text-xs text-slate-400 mt-0.5 truncate">
                              {item.schemaName ? `Schema: ${item.schemaName}` : ''}
                              {item.itemData?.description ? ` · ${String(item.itemData.description).slice(0, 40)}` : ''}
                            </div>
                          </div>
                        ))
                      )}
                      <button
                        onClick={fetchGameItems}
                        disabled={gameItemsLoading}
                        className="block w-full text-center px-3 py-2 rounded-lg text-xs bg-slate-700/50 hover:bg-slate-700 text-slate-300 mt-1 disabled:opacity-50"
                      >
                        {gameItemsLoading ? '读取中…' : '刷新道具列表'}
                      </button>
                    </div>
                  </>
                )}
              </div>

              {/* 商店按钮 */}
              {skills.find(s => s.id === 'store')?.enabled && (
                <Link
                  to={`/game-store/${gameId}`}
                  className="px-2 sm:px-4 py-1.5 sm:py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-lg font-medium transition-colors flex items-center gap-1 sm:gap-2"
                >
                  <i className="fa-solid fa-store"></i>
                  <span className="hidden sm:inline">商店</span>
                </Link>
              )}

              {/* 全屏按钮 */}
              <button
                onClick={handleFullscreen}
                className="w-9 h-9 sm:w-10 sm:h-10 shrink-0 rounded-lg bg-slate-700 hover:bg-slate-600 flex items-center justify-center text-white transition-colors"
              >
                <i className="fa-solid fa-expand"></i>
              </button>
            </div>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-6">
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
          {/* 游戏区域 */}
          <div className="lg:col-span-3">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="bg-slate-800 rounded-xl overflow-hidden border border-slate-700"
            >
                {/* 游戏嵌入区域 */}
                <div className="relative w-full bg-slate-950 h-[68dvh] lg:h-auto lg:aspect-video">
                  {/* 显式报错：模块化游戏误用内联模式 */}
                  {renderError ? (
                    <div className="absolute inset-0 flex items-center justify-center p-6">
                      <div className="text-center max-w-md">
                        <AlertCircle className="w-12 h-12 text-red-500 mx-auto mb-4" />
                        <h3 className="text-lg font-bold text-white mb-2">游戏无法以内联模式加载</h3>
                        <p className="text-slate-400 text-sm leading-relaxed">{renderError}</p>
                      </div>
                    </div>
                  ) : (game.hostingType === 'external' || game.hostingType === 'server') && game.cdnUrl ? (
                    <iframe
                      id="game-iframe"
                      src={game.cdnUrl}
                      className="w-full h-full border-0"
                      allow="fullscreen"
                      sandbox="allow-scripts allow-same-origin allow-popups allow-downloads allow-modals"
                    ></iframe>
                  ) : gameHtmlContent ? (
                  <iframe
                    id="game-iframe"
                    srcDoc={gameHtmlContent}
                    className="w-full h-full border-0"
                    allow="fullscreen"
                    sandbox="allow-scripts allow-same-origin allow-popups allow-forms allow-downloads allow-modals"
                  ></iframe>
                ) : game.cdnUrl ? (
                  <iframe
                    id="game-iframe"
                    src={game.cdnUrl}
                    className="w-full h-full border-0"
                    allow="fullscreen"
                    sandbox="allow-scripts allow-same-origin allow-popups allow-downloads allow-modals"
                  ></iframe>
                ) : (
                  <div className="absolute inset-0 flex items-center justify-center">
                    <div className="text-center">
                      <i className="fa-solid fa-gamepad text-6xl text-slate-700 mb-4"></i>
                      <p className="text-slate-500">游戏加载中...</p>
                      <p className="text-slate-600 text-sm mt-2">入口文件: {game.entryPoint || '未配置'}, 请通过 Publishing Center 重新发布</p>
                    </div>
                  </div>
                )}
              </div>

              {/* 游戏信息 */}
              <div className="p-6">
                {game.coverImage && (
                  <img
                    src={game.coverImage}
                    alt={`${game.name} 封面`}
                    className="w-full h-56 object-cover rounded-lg mb-4 border border-slate-700"
                  />
                )}
                <h2 className="text-lg font-bold text-white mb-2">游戏介绍</h2>
                <p className="text-slate-400 whitespace-pre-line leading-relaxed">{game.summary || game.description}</p>
                
                <div className="mt-4 flex flex-wrap gap-2">
                  <span className="px-3 py-1 bg-slate-700 text-slate-300 rounded-full text-sm">
                    <i className="fa-solid fa-file-code mr-1"></i>
                    {game.fileCount} 个文件
                  </span>
                  <span className="px-3 py-1 bg-slate-700 text-slate-300 rounded-full text-sm">
                    <i className="fa-solid fa-weight-hanging mr-1"></i>
                    {(game.size / 1024 / 1024).toFixed(2)} MB
                  </span>
                  <span className="px-3 py-1 bg-slate-700 text-slate-300 rounded-full text-sm">
                    <i className="fa-solid fa-users mr-1"></i>
                    {game.players} 人在玩
                  </span>
                </div>
              </div>
            </motion.div>
          </div>

          {/* 侧边栏 - Skills & 操作 */}
          <div className="space-y-6">
            {/* Skills 状态 */}
            <motion.div
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              className="bg-slate-800 rounded-xl p-6 border border-slate-700"
            >
              <h3 className="text-lg font-bold text-white mb-4">
                <i className="fa-solid fa-plug mr-2 text-blue-500"></i>
                游戏功能
              </h3>
              <div className="space-y-3">
                {skills.map(skill => (
                  <div
                    key={skill.id}
                    className={`flex items-center gap-3 p-3 rounded-lg ${
                      skill.enabled ? 'bg-green-500/10 border border-green-500/30' : 'bg-slate-700/50'
                    }`}
                  >
                    <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${
                      skill.enabled ? 'bg-green-500/20 text-green-400' : 'bg-slate-600 text-slate-400'
                    }`}>
                      <i className={`fa-solid ${skill.icon}`}></i>
                    </div>
                    <div className="flex-1">
                      <p className={`font-medium ${skill.enabled ? 'text-white' : 'text-slate-400'}`}>
                        {skill.name}
                      </p>
                      <p className="text-xs text-slate-500">{skill.description}</p>
                    </div>
                    {skill.enabled && (
                      <i className="fa-solid fa-check-circle text-green-500"></i>
                    )}
                  </div>
                ))}
              </div>
            </motion.div>

            {/* 快速操作 */}
            <motion.div
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.1 }}
              className="bg-slate-800 rounded-xl p-6 border border-slate-700"
            >
              <h3 className="text-lg font-bold text-white mb-4">
                <i className="fa-solid fa-bolt mr-2 text-yellow-500"></i>
                快速操作
              </h3>
              <div className="space-y-3">
                <button
                  onClick={() => loadBalance()}
                  className="w-full px-4 py-3 bg-slate-700 hover:bg-slate-600 text-white rounded-lg transition-colors flex items-center gap-3"
                >
                  <i className="fa-solid fa-rotate"></i>
                  刷新余额
                </button>
                
                <Link
                  to={`/game-store/${gameId}`}
                  className="w-full px-4 py-3 bg-purple-600 hover:bg-purple-700 text-white rounded-lg transition-colors flex items-center gap-3 justify-center"
                >
                  <i className="fa-solid fa-shopping-bag"></i>
                  进入商店
                </Link>

                <button
                  onClick={handleFullscreen}
                  className="w-full px-4 py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors flex items-center gap-3"
                >
                  <i className="fa-solid fa-expand"></i>
                  全屏游戏
                </button>
              </div>
            </motion.div>

            {/* 游戏数据 */}
            <motion.div
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.2 }}
              className="bg-slate-800 rounded-xl p-6 border border-slate-700"
            >
              <h3 className="text-lg font-bold text-white mb-4">
                <i className="fa-solid fa-chart-bar mr-2 text-green-500"></i>
                游戏数据
              </h3>
              <div className="space-y-4">
                <div className="flex justify-between">
                  <span className="text-slate-400">在线玩家</span>
                  <span className="text-white font-medium">{game.players || 0}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">框架</span>
                  <span className="text-white font-medium capitalize">{game.framework}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">版本</span>
                  <span className="text-white font-medium">{game.version}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">发布日期</span>
                  <span className="text-white font-medium">
                    {game.publishedAt ? new Date(game.publishedAt).toLocaleDateString() : '-'}
                  </span>
                </div>
              </div>
            </motion.div>
          </div>
        </div>
      </main>
    </div>
  );
}
