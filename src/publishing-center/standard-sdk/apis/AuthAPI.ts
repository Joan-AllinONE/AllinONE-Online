/**
 * Auth API - 用户认证
 */

import type { AllinONEGame } from '../index';
import { getFeatureApiBase } from '../../../../services/apiBase';

export interface User {
  id: string;
  username: string;
  avatar?: string;
  email?: string;
  createdAt: string;
}

export interface LoginResult {
  success: boolean;
  user?: User;
  token?: string;
  error?: string;
}

export class AuthAPI {
  private game: AllinONEGame;
  private currentUser: User | null = null;
  private initialized: boolean = false;

  constructor(game: AllinONEGame) {
    this.game = game;
  }

  async initialize(): Promise<void> {
    // 检查本地存储的登录状态
    const savedUser = localStorage.getItem('allinone_user');
    if (savedUser) {
      try {
        this.currentUser = JSON.parse(savedUser);
      } catch {
        localStorage.removeItem('allinone_user');
      }
    }
    this.initialized = true;
  }

  /**
   * 登录
   */
  async login(username: string, password: string): Promise<LoginResult> {
    try {
      // 调用平台登录API
      const response = await fetch(`${getFeatureApiBase('auth')}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });

      const result = await response.json();

      if (result.success) {
        this.currentUser = result.user;
        localStorage.setItem('allinone_user', JSON.stringify(result.user));
        localStorage.setItem('allinone_token', result.token);
        
        // 触发事件
        (this.game as any).emit('user:login', { user: result.user });
      }

      return result;
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : '登录失败',
      };
    }
  }

  /**
   * 注册
   */
  async register(username: string, password: string, email?: string): Promise<LoginResult> {
    try {
      const response = await fetch(`${getFeatureApiBase('auth')}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, email }),
      });

      return await response.json();
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : '注册失败',
      };
    }
  }

  /**
   * 登出
   */
  async logout(): Promise<void> {
    this.currentUser = null;
    localStorage.removeItem('allinone_user');
    localStorage.removeItem('allinone_token');
    
    (this.game as any).emit('user:logout', {});
  }

  /**
   * 获取当前用户
   */
  getCurrentUser(): User | null {
    return this.currentUser;
  }

  /**
   * 检查是否已登录
   */
  isLoggedIn(): boolean {
    return this.currentUser !== null;
  }

  /**
   * 获取访问令牌
   */
  getToken(): string | null {
    return localStorage.getItem('allinone_token');
  }
}
