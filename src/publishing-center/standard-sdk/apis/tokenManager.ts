/**
 * Standard SDK 内部 Token 管理工具
 *
 * 替代各 API 文件中的 localStorage.getItem('allinone_token')。
 * Token 仅缓存在内存中。
 */

let cachedToken: string | null = null;
let tokenExpiry: number = 0;
const TOKEN_TTL_MS = 50 * 60 * 1000; // 50 分钟

/**
 * 同步获取缓存的 Token（不发起网络请求）
 */
export function getCachedToken(): string | null {
  if (cachedToken && Date.now() < tokenExpiry) {
    return cachedToken;
  }
  return null;
}

/**
 * 异步获取 Token
 * 优先返回缓存，否则通过 dev-token 端点获取
 */
export async function getToken(): Promise<string | null> {
  if (cachedToken && Date.now() < tokenExpiry) {
    return cachedToken;
  }

  try {
    // 从 allinone_user 获取 userId（AuthSkill 持久化的用户信息）
    let userId = 'anonymous';
    const userStr = localStorage.getItem('allinone_user');
    if (userStr) {
      const user = JSON.parse(userStr);
      userId = user.uid || user.id || 'anonymous';
    }

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
    // 后端不可用
  }

  return null;
}

/**
 * 设置 Token（AuthAPI 登录成功后调用）
 */
export function setToken(token: string): void {
  cachedToken = token;
  tokenExpiry = Date.now() + TOKEN_TTL_MS;
}

/**
 * 清除 Token
 */
export function clearToken(): void {
  cachedToken = null;
  tokenExpiry = 0;
}
