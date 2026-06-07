/**
 * JWT 认证模块
 * 功能：token 签发、验证、认证中间件
 * 替换原有的 Mock 认证 (extractUserIdFromToken)
 */
import jwt from 'jsonwebtoken';
import { Request, Response, NextFunction } from 'express';

// 生产环境必须设置 JWT_SECRET，开发环境使用默认值
const JWT_SECRET: string = process.env.JWT_SECRET || (() => {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('[JWT] FATAL: JWT_SECRET must be set in production environment');
  }
  console.warn('[JWT] WARNING: Using default dev secret — NOT for production use');
  return 'dev-secret-do-not-use-in-prod-change-me';
})();

const TOKEN_EXPIRY = '24h';

export interface JwtPayload {
  userId: string;
  role?: string;
}

/**
 * 签发 JWT token
 */
export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: TOKEN_EXPIRY });
}

/**
 * 验证并解码 JWT token
 */
export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, JWT_SECRET) as JwtPayload;
}

/**
 * Express 认证中间件
 * - 无 token → 401
 * - 无效/过期 token → 401
 * - 有效 token → 注入 req.userId / req.userRole 并放行
 */
export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ success: false, error: 'Missing or invalid authorization header' });
    return;
  }

  try {
    const payload = verifyToken(authHeader.slice(7));
    (req as any).userId = payload.userId;
    (req as any).userRole = payload.role;
    next();
  } catch (err: any) {
    const message = err.name === 'TokenExpiredError'
      ? 'Token has expired'
      : 'Invalid token';
    res.status(401).json({ success: false, error: message });
  }
}

/**
 * 可选认证中间件 — 失败不阻断，但注入 userId（如果 token 有效）
 */
export function optionalAuthMiddleware(req: Request, _res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    try {
      const payload = verifyToken(authHeader.slice(7));
      (req as any).userId = payload.userId;
      (req as any).userRole = payload.role;
    } catch {
      // 静默忽略 — token 无效如同未登录
    }
  }
  next();
}
