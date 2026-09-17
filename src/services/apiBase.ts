/**
 * 统一的 API base 解析工具（prod 感知）。
 *
 * 背景：CloudBase 静态托管（tcloudbaseapp.com）会把同源相对路径 /api/** 当 COS 对象读取
 * （SW 未激活时手机端报 NoSuchKey / 404）。且静态托管 rewrite 不支持路由到云函数。
 * 因此在 prod 域名下，所有后端调用必须走「绝对云函数 URL」，不要发同源相对 /api。
 *
 * 约定：
 * - 游戏/活动/文件等「已在云函数实现」的端点 → getApiBase() 返回 /api/v1/games 前缀。
 * - 游戏内 SDK 等「顶层 /api/<feature>」端点 → getFeatureApiBase(feature) 在 prod 下
 *   隧道化到 /api/v1/games/__<feature>（云函数已支持 __activities 隧道模式），
 *   本地 dev 仍用 /api/<feature>（走 vite 代理到 server.js）。
 */

const PROD_BACKEND =
  'https://allinonegaming-d4gmsmrzz573264f6.service.tcloudbase.com';

export function isCloudHosting(): boolean {
  return (
    typeof window !== 'undefined' &&
    /tcloudbaseapp\.com$/.test(window.location.hostname)
  );
}

/** 游戏后端 base：prod 绝对 URL，dev 相对 /api/v1/games */
export function getApiBase(): string {
  return isCloudHosting() ? `${PROD_BACKEND}/api/v1/games` : '/api/v1/games';
}

/**
 * 游戏内 SDK 等顶层 /api/<feature> 端点的 base。
 * prod 下隧道化到 /api/v1/games/__<feature>（云函数按 __<feature> 分发）。
 */
/**
 * dev 下以「隧道」形式挂载的 feature。
 * 本地 server.js 把这几个挂在 /api/v1/games/__<feature>（gamesPublicRouter 之前），
 * 用顶层 /api/v1/<feature> 访问会 404。
 */
const DEV_TUNNEL_FEATURES = new Set(['wallet', 'quests', 'content']);

export function getFeatureApiBase(feature: string): string {
  if (isCloudHosting()) {
    return `${PROD_BACKEND}/api/v1/games/__${feature}`;
  }

  // dev（localhost）：本地后端路由统一挂在 /api/v1/ 下。
  // ⚠️ 历史 bug：这里曾返回 `/api/${feature}`（少了 /v1），而本地后端根本没有
  // /api/<feature> 这一层，导致 /api/game-developers 404、/api/analytics/events 401
  // （落到全局 authMiddleware）。现将 feature 分两类解析：
  //   1) 本地已实现隧道的（wallet/quests/content）→ /api/v1/games/__<feature>
  //   2) 其余（analytics/game-developers 等顶层路由）→ /api/v1/<feature>
  if (DEV_TUNNEL_FEATURES.has(feature)) {
    return `${getApiBase()}/__${feature}`;
  }
  return `/api/v1/${feature}`;
}
