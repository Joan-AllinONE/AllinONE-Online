/**
 * 集中式 Token 管理服务
 *
 * 替代散落在各文件中的 localStorage.getItem('allinone_token') 调用。
 * Token 仅缓存在内存中，不写入 localStorage。
 *
 * 优先级：
 * 1. CloudBase Auth 的 accessToken（如果用户已登录）
 * 2. dev-token 端点签发的 JWT（开发环境）
 */

let cachedToken: string | null = null;
let tokenExpiry: number = 0;
const TOKEN_TTL_MS = 50 * 60 * 1000; // 50 分钟

/**
 * 获取当前用户的 userId（从 AuthSkill / authContext / CloudBase 会话）
 */
export function getCurrentUserId(): string {
  try {
    // 尝试从 allinone_user 获取（AuthSkill 持久化的用户信息）
    const userStr = localStorage.getItem('allinone_user');
    if (userStr) {
      const user = JSON.parse(userStr);
      return user.uid || user.id || 'anonymous';
    }
  } catch { /* ignore */ }
  return 'anonymous';
}

/**
 * 获取 JWT Token
 *
 * 策略：
 * 1. 如果内存缓存中有未过期 token，直接返回
 * 2. 尝试通过 dev-token 端点获取新 token
 * 3. 返回 null 表示无可用 token（调用方应降级处理）
 */
export async function getToken(): Promise<string | null> {
  // 检查缓存
  if (cachedToken && Date.now() < tokenExpiry) {
    return cachedToken;
  }

  // 尝试获取新 token
  try {
    const userId = getCurrentUserId();
    const resp = await fetch('/api/v1/games/dev-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId }),
    });
    if (resp.ok) {
      const data = await resp.json();
      const token = data?.data?.token || null;
      if (token) {
        cachedToken = token;
        tokenExpiry = Date.now() + TOKEN_TTL_MS;
        return token;
      }
    }
  } catch {
    // 后端不可用，返回 null
  }

  return null;
}

/**
 * 同步获取缓存的 Token（不发起网络请求）
 * 如果缓存中没有或已过期，返回 null
 */
export function getCachedToken(): string | null {
  if (cachedToken && Date.now() < tokenExpiry) {
    return cachedToken;
  }
  return null;
}

/**
 * 清除缓存的 Token（登出时调用）
 */
export function clearToken(): void {
  cachedToken = null;
  tokenExpiry = 0;
}

/**
 * 检查是否有可用的 Token（同步，不发起请求）
 */
export function hasToken(): boolean {
  return cachedToken !== null && Date.now() < tokenExpiry;
}
