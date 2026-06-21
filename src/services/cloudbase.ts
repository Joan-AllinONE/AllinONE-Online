/**
 * CloudBase 初始化模块
 * 统一初始化 CloudBase SDK，供全应用使用
 *
 * 登录持久化策略：
 * - auth persistence 设为 'local'，CloudBase SDK 自动将登录态存入 localStorage
 * - 初始化时先检查是否有已持久化的真实登录（邮箱/密码），有则恢复
 * - 仅在无任何登录态时才匿名登录（保证数据库等基础功能可用）
 *
 * localStorage 容量保护：
 * - 匿名登录前调用 ensureLocalStorageSpaceForAuth() 清理可重建数据
 * - 防止 credentials 写入因 QuotaExceededError 而导致 auth scope 为 null
 */
import cloudbase from '@cloudbase/js-sdk';

// CloudBase 配置
const CLOUDBASE_ENV = import.meta.env.VITE_CLOUDBASE_ENV || '';
const CLOUDBASE_ACCESS_KEY = import.meta.env.VITE_CLOUDBASE_ACCESS_KEY || '';

// 全局 app 实例
let app: cloudbase.app.App | null = null;
let initPromise: Promise<cloudbase.app.App> | null = null;

/**
 * 确保 localStorage 有足够空间存储 CloudBase 认证凭据
 *
 * CloudBase 匿名登录需要将 credentials 写入 localStorage，
 * 如果 localStorage 已满（QuotaExceededError），auth scope 会变为 null，
 * 导致所有数据库操作失败（Cannot read properties of null (reading 'scope')）。
 *
 * 此函数在登录前清除可重建的缓存数据，腾出空间：
 * - allinone_game_files_* : 游戏文件缓存（可从 IndexedDB 重建）
 * - allinone_published_games : 已发布游戏列表（可从 CloudBase 重新加载）
 * - allinone_write_queue : 写入队列（已在 IndexedDB 持久化）
 */
function ensureLocalStorageSpaceForAuth(): number {
  if (typeof window === 'undefined') return 0;

  const EVICT_PREFIXES = [
    'allinone_game_files_',
    'allinone_published_games',
    'allinone_write_queue',
  ];

  let freedBytes = 0;
  let freedKeys = 0;

  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key) continue;

    const shouldEvict = EVICT_PREFIXES.some(prefix => key.startsWith(prefix));
    if (!shouldEvict) continue;

    try {
      const value = localStorage.getItem(key);
      if (value) freedBytes += key.length + value.length;
      localStorage.removeItem(key);
      freedKeys++;
    } catch {
      // getItem/removeItem 可能因 quota 问题失败，忽略
    }
  }

  if (freedKeys > 0) {
    console.log(
      `[CloudBase Auth] Freed ${freedKeys} localStorage keys (~${(freedBytes / 1024).toFixed(1)}KB) ` +
      `to ensure space for auth credentials`
    );
  }

  return freedKeys;
}

/**
 * 初始化 CloudBase
 * 应在应用启动时调用一次
 */
export async function initCloudBase(): Promise<cloudbase.app.App> {
  if (app) {
    return app;
  }

  if (initPromise) {
    return initPromise;
  }

  initPromise = (async () => {
    if (!CLOUDBASE_ENV) {
      console.warn('⚠️ VITE_CLOUDBASE_ENV 未配置，AI 功能将不可用');
      throw new Error('CloudBase env not configured');
    }

    const instance = cloudbase.init({
      env: CLOUDBASE_ENV,
      ...(CLOUDBASE_ACCESS_KEY && { accessKey: CLOUDBASE_ACCESS_KEY }),
    });

    // 使用 'local' 持久化，CloudBase SDK 会将登录态存入 localStorage
    const auth = instance.auth({ persistence: 'local' });

    // 先检查是否有已持久化的真实登录（邮箱/密码登录会自动恢复）
    let hasRealLogin = false;
    try {
      const loginState = await auth.getLoginState();
      if (loginState && !loginState.user?.is_anonymous) {
        hasRealLogin = true;
        console.log('✅ CloudBase 恢复已有登录:', loginState.user?.uid);
      }
    } catch {
      // getLoginState 未登录时可能抛异常，忽略
    }

    // 仅在无任何登录态时才匿名登录（保证数据库等基础功能可用）
    if (!hasRealLogin) {
      // 登录前确保 localStorage 有空间存储 credentials
      // 防止 QuotaExceededError 导致 auth scope 为 null → 所有 DB 操作失败
      ensureLocalStorageSpaceForAuth();

      try {
        await auth.signInAnonymously();
        console.log('✅ CloudBase 匿名登录成功');
      } catch (signInErr) {
        // 如果仍然因 quota 失败，做二次清理（移除所有非必要数据）
        if (signInErr instanceof Error && signInErr.message.includes('quota')) {
          console.warn('[CloudBase Auth] signInAnonymously 因 localStorage quota 失败，执行二次清理');
          ensureLocalStorageSpaceForAuth();
          try {
            await auth.signInAnonymously();
            console.log('✅ CloudBase 匿名登录成功（二次尝试）');
          } catch {
            console.error('[CloudBase Auth] 匿名登录失败，auth scope 可能为 null');
          }
        } else {
          // 匿名登录未开启或其他错误 — 静默处理
        }
      }
    }

    console.log('✅ CloudBase 初始化成功');
    app = instance;
    return instance;
  })();

  return initPromise;
}

/**
 * 获取 CloudBase app 实例
 * 必须先调用 initCloudBase()
 */
export function getCloudBaseApp(): cloudbase.app.App {
  if (!app) {
    throw new Error('CloudBase not initialized. Call initCloudBase() first.');
  }
  return app;
}

/**
 * 检查 CloudBase 是否已初始化
 */
export function isCloudBaseReady(): boolean {
  return app !== null;
}

/**
 * 等待 CloudBase 初始化完成
 * - 如果已初始化，立即返回 app
 * - 如果正在初始化，等待 initPromise resolve
 * - 如果未启动初始化，自动启动
 * 
 * 用于写入路径：确保数据不会因 CloudBase 未就绪而丢失
 */
export async function waitForCloudBase(): Promise<cloudbase.app.App> {
  if (app) return app;
  if (initPromise) return initPromise;
  return initCloudBase();
}

/**
 * 获取 AI 实例
 */
export function getAI() {
  const cloudbaseApp = getCloudBaseApp();
  return cloudbaseApp.ai();
}

/**
 * 创建 AI 模型
 * @param provider 模型组名，默认 'cloudbase'（TokenHub 托管多模型池）
 */
export function createAIModel(provider: string = 'cloudbase') {
  const ai = getAI();
  return ai.createModel(provider);
}

export default {
  init: initCloudBase,
  getApp: getCloudBaseApp,
  isReady: isCloudBaseReady,
  waitForReady: waitForCloudBase,
  getAI,
  createModel: createAIModel,
};
