/**
 * AuthContext - MVP v1.0 认证上下文
 * 桥接 AuthSkill（CloudBase Auth）与 React 组件层。
 */

import { createContext, useState, useEffect, ReactNode, useCallback } from 'react';
import { useContext } from 'react';
import { authSkill, UserProfile } from '@/skills/auth/AuthSkill';
import { initCloudBase, isCloudBaseReady } from '@/services/cloudbase';
import { track } from '@/services/analytics';
import { globalEventBus } from '@/skills/EventBus';

export interface AuthUser {
  id: string;
  uid: string;
  username: string;
  email?: string;
  nickname: string;
  avatar?: string;
  role: string;
  gameCoins: number;
}

interface AuthContextType {
  isAuthenticated: boolean;
  currentUser: AuthUser | null;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<{ success: boolean; error?: string }>;
  register: (email: string, password: string, nickname: string) => Promise<{ success: boolean; error?: string }>;
  logout: () => Promise<void>;
  // 向后兼容旧 Login 页面
  setIsAuthenticated: (value: boolean) => void;
  setCurrentUser: (user: AuthUser | null) => void;
}

export const AuthContext = createContext<AuthContextType>({
  isAuthenticated: false,
  currentUser: null,
  isLoading: true,
  login: async () => ({ success: false, error: 'Not init' }),
  register: async () => ({ success: false, error: 'Not init' }),
  logout: async () => {},
  setIsAuthenticated: () => {},
  setCurrentUser: () => {},
});

const toAuthUser = (profile: UserProfile | null): AuthUser | null => {
  if (!profile) return null;
  return {
    id: profile.uid,
    uid: profile.uid,
    username: profile.nickname,
    email: profile.email,
    nickname: profile.nickname,
    avatar: profile.avatar,
    role: profile.role,
    gameCoins: profile.gameCoins,
  };
};

export function AuthProvider({ children }: { children: ReactNode }) {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const init = async () => {
      // 等待 CloudBase 初始化完成（确保 auth SDK 可用）
      try {
        await initCloudBase();
      } catch {
        // CloudBase 不可用，继续走 localStorage 降级
      }

      try {
        const result = await authSkill.getCurrentUser(undefined as never, {} as any);
        const user = toAuthUser(result.user);
        setCurrentUser(user);
        setIsAuthenticated(!!user);
      } catch {
        const saved = localStorage.getItem('allinone_user');
        if (saved) {
          try {
            const user = toAuthUser(JSON.parse(saved));
            setCurrentUser(user);
            setIsAuthenticated(true);
          } catch { /* ignore */ }
        }
      }
      setIsLoading(false);
    };

    init();

    authSkill.addStateListener((profile) => {
      const user = toAuthUser(profile);
      setCurrentUser(user);
      setIsAuthenticated(!!user);
    });

    const onStorage = () => {
      const saved = localStorage.getItem('allinone_user');
      if (saved) {
        try {
          const user = toAuthUser(JSON.parse(saved));
          setCurrentUser(user);
          setIsAuthenticated(true);
        } catch { /* ignore */ }
      }
    };
    window.addEventListener('allinoneAuthChange', onStorage);
    return () => window.removeEventListener('allinoneAuthChange', onStorage);
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const r = await authSkill.login({ email, password }, {} as any);
    if (r.success) {
      try {
        const saved = localStorage.getItem('allinone_user');
        const u = saved ? JSON.parse(saved) : null;
        track({ type: 'login', userId: u?.uid, payload: { role: u?.role || 'player' } });
        globalEventBus.emit('daily.login', { userId: u?.uid, at: Date.now() }, { userId: u?.uid || 'anonymous', sessionId: 'web' });
      } catch { /* ignore */ }
    }
    return { success: r.success, error: r.error };
  }, []);

  const register = useCallback(async (email: string, password: string, nickname: string) => {
    const r = await authSkill.register({ email, password, nickname }, {} as any);
    if (r.success) {
      try {
        const saved = localStorage.getItem('allinone_user');
        const u = saved ? JSON.parse(saved) : null;
        track({ type: 'register', userId: u?.uid, payload: { role: u?.role || 'player' } });
        globalEventBus.emit('user.registered', { userId: u?.uid, nickname, at: Date.now() }, { userId: u?.uid || 'anonymous', sessionId: 'web' });
      } catch { /* ignore */ }
    }
    return { success: r.success, error: r.error };
  }, []);

  const logout = useCallback(async () => {
    try {
      track({ type: 'logout', userId: currentUser?.uid || currentUser?.id });
    } catch { /* ignore */ }
    await authSkill.logout({} as never, {} as any);
    setCurrentUser(null);
    setIsAuthenticated(false);
  }, [currentUser]);

  return (
    <AuthContext.Provider value={{ isAuthenticated, currentUser, isLoading, login, register, logout, setIsAuthenticated, setCurrentUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
