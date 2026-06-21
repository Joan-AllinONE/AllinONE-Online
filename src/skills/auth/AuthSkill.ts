/**
 * AuthSkill - 认证 Skill（MVP v1.0 CloudBase Auth 版）
 * 
 * 使用 CloudBase Auth SDK 实现注册/登录/登出。
 * 保留 localStorage fallback 用于开发环境。
 * 
 * @since MVP v1.0
 */

import { BaseSkill } from '../BaseSkill';
import type { SkillContext } from '../types';
import { getCloudBaseApp } from '../../services/cloudbase';
import { validateUser, saveRegisteredUser, getLocalRegisteredUsers } from '../../data/testAccounts';
import { clearToken } from '../../services/authTokenService';

// ==================== 类型定义 ====================

export interface UserProfile {
  uid: string;
  email?: string;
  nickname: string;
  avatar?: string;
  role: 'player' | 'developer' | 'admin';
  gameCoins: number;
  createdAt: number;
  updatedAt: number;
}

export interface AuthResult {
  success: boolean;
  user?: UserProfile;
  error?: string;
}

// ==================== Skill 实现 ====================

export class AuthSkill extends BaseSkill {
  private currentUser: UserProfile | null = null;
  private authStateListeners: Array<(user: UserProfile | null) => void> = [];

  constructor() {
    super({
      name: 'auth',
      version: '2.0.0',
      displayName: '认证服务',
      description: '基于 CloudBase Auth 的用户认证与授权',
    });
  }

  /**
   * 延迟获取 CloudBase Auth 实例
   * 不在 onInitialize 时缓存，而是每次操作时动态获取，
   * 确保即使 CloudBase 在 Skill 初始化后才就绪也能正常工作。
   */
  private getAuth(): any {
    try {
      const app = getCloudBaseApp();
      return app.auth({ persistence: 'local' });
    } catch {
      return null;
    }
  }

  protected async onInitialize(): Promise<void> {
    // 尝试获取 Auth（CloudBase 可能已就绪也可能未就绪）
    const auth = this.getAuth();
    if (auth) {
      console.log('[auth] CloudBase Auth OK');
    } else {
      console.log('[auth] CloudBase not ready yet, will retry on action calls');
    }

    this.registerAction('login', this.login.bind(this), {
      description: '用户邮箱登录',
      params: {
        type: 'object',
        required: ['email', 'password'],
        properties: {
          email: { type: 'string' },
          password: { type: 'string' },
        },
      },
    });

    this.registerAction('register', this.register.bind(this), {
      description: '用户注册',
      params: {
        type: 'object',
        required: ['email', 'password', 'nickname'],
        properties: {
          email: { type: 'string' },
          password: { type: 'string' },
          nickname: { type: 'string' },
        },
      },
    });

    this.registerAction('logout', this.logout.bind(this), {
      description: '用户登出',
    });

    this.registerAction('getCurrentUser', this.getCurrentUser.bind(this), {
      description: '获取当前登录用户',
    });
  }

  // ==================== Actions ====================

  async login(params: { email: string; password: string }, _context: SkillContext): Promise<AuthResult> {
    try {
      const auth = this.getAuth();
      if (auth) {
        const result = await auth.signInWithEmailAndPassword(params.email, params.password);
        const uid = result.user?.uid || result.user?._id || result.uid;
        const profile = await this.loadUserProfile(uid);
        this.currentUser = profile;
        this.persistAndNotify(profile);
        return { success: true, user: profile };
      }
      return this.loginLocal(params);
    } catch (error: any) {
      return { success: false, error: error.message || 'Login failed' };
    }
  }

  async register(params: { email: string; password: string; nickname: string }, _context: SkillContext): Promise<AuthResult> {
    try {
      const auth = this.getAuth();
      if (auth) {
        const result = await auth.signUpWithEmailAndPassword(params.email, params.password);
        const uid = result.user?.uid || result.user?._id || result.uid;
        const profile: UserProfile = {
          uid, email: params.email, nickname: params.nickname,
          role: 'player', gameCoins: 0,
          createdAt: Date.now(), updatedAt: Date.now(),
        };
        try {
          const app = getCloudBaseApp();
          const db = app.database();
          await db.collection('users').add({ ...profile, _openid: uid });
        } catch {
          /* user doc creation is best-effort */
        }
        this.currentUser = profile;
        this.persistAndNotify(profile);
        return { success: true, user: profile };
      }
      return this.registerLocal(params);
    } catch (error: any) {
      return { success: false, error: error.message || 'Register failed' };
    }
  }

  async logout(_params: any, _context: SkillContext): Promise<{ success: boolean }> {
    try { const auth = this.getAuth(); if (auth) await auth.signOut(); } catch { /* ok */ }
    this.currentUser = null;
    localStorage.removeItem('allinone_user');
    clearToken();
    this.notifyListeners(null);
    return { success: true };
  }

  async getCurrentUser(_params: any, _context: SkillContext): Promise<{ success: boolean; user: UserProfile | null }> {
    if (this.currentUser) return { success: true, user: this.currentUser };

    // 先检查 localStorage 中是否有已保存的用户（测试账号 / 本地登录）
    const saved = localStorage.getItem('allinone_user');
    let savedUser: UserProfile | null = null;
    if (saved) {
      try { savedUser = JSON.parse(saved); } catch { /* bad data */ }
    }

    // 优先检查 CloudBase 会话恢复（真实登录持久化在 SDK 层）
    const auth = this.getAuth();
    if (auth) {
      try {
        const loginState = await auth.getLoginState();
        if (loginState && !loginState.user?.is_anonymous) {
          const uid = loginState.user?.uid || loginState.user?._id;
          const profile = await this.loadUserProfile(uid);
          // 如果 CloudBase 返回的是默认 Player（数据库中无真实用户记录），
          // 且 localStorage 有已保存的用户，优先使用 localStorage 中的用户
          if (profile.nickname === 'Player' && !profile.email && savedUser) {
            this.currentUser = savedUser;
            this.persistAndNotify(savedUser);
            return { success: true, user: savedUser };
          }
          this.currentUser = profile;
          this.persistAndNotify(profile);
          return { success: true, user: profile };
        }
      } catch { /* not logged in */ }
    }

    // 降级到 allinone_user 缓存（AuthSkill 持久化的用户信息，用于会话恢复）
    if (savedUser) {
      this.currentUser = savedUser;
      return { success: true, user: savedUser };
    }

    return { success: true, user: null };
  }

  // ==================== 公共方法 ====================

  addStateListener(fn: (user: UserProfile | null) => void): void {
    this.authStateListeners.push(fn);
  }

  removeStateListener(fn: (user: UserProfile | null) => void): void {
    this.authStateListeners = this.authStateListeners.filter(l => l !== fn);
  }

  getCurrentUserSync(): UserProfile | null {
    return this.currentUser;
  }

  // ==================== 私有方法 ====================

  private async loadUserProfile(uid: string): Promise<UserProfile> {
    try {
      const app = getCloudBaseApp();
      const db = app.database();
      const res = await db.collection('users').where({ _openid: uid }).limit(1).get();
      if (res.data.length > 0) {
        const doc = res.data[0];
        return {
          uid: doc._openid || uid,
          email: doc.email,
          nickname: doc.nickname || 'Player',
          avatar: doc.avatar,
          role: doc.role || 'player',
          gameCoins: doc.gameCoins || 0,
          createdAt: doc.createdAt || Date.now(),
          updatedAt: doc.updatedAt || Date.now(),
        };
      }
    } catch { /* fallback */ }
    return {
      uid,
      nickname: 'Player',
      role: 'player',
      gameCoins: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  private loginLocal(params: { email: string; password: string }): AuthResult {
    // 优先检查内置测试账号
    const testAccount = validateUser(params.email.split('@')[0], params.password);
    if (testAccount) {
      const profile = this.makeProfile({ uid: testAccount.id, ...params, nickname: testAccount.nickname, role: testAccount.role });
      this.currentUser = profile;
      this.persistAndNotify(profile);
      return { success: true, user: profile };
    }
    // 检查内存中的注册用户
    const users = getLocalRegisteredUsers();
    const found = users.find((u: any) => u.email === params.email && u.password === params.password);
    if (!found) return { success: false, error: 'Invalid credentials' };
    const profile = this.makeProfile(found);
    this.currentUser = profile;
    this.persistAndNotify(profile);
    return { success: true, user: profile };
  }

  private registerLocal(params: { email: string; password: string; nickname: string }): AuthResult {
    saveRegisteredUser(params);
    const uid = 'local_' + Date.now();
    const profile = this.makeProfile({ uid, ...params });
    this.currentUser = profile;
    this.persistAndNotify(profile);
    return { success: true, user: profile };
  }

  private makeProfile(data: any): UserProfile {
    return {
      uid: data.uid || data.id,
      email: data.email,
      nickname: data.nickname || 'Player',
      role: data.role || 'player',
      gameCoins: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  private persistAndNotify(profile: UserProfile): void {
    localStorage.setItem('allinone_user', JSON.stringify(profile));
    this.notifyListeners(profile);
  }

  private notifyListeners(user: UserProfile | null): void {
    for (const fn of this.authStateListeners) {
      try { fn(user); } catch { /* ignore */ }
    }
  }
}

export const authSkill = new AuthSkill();
