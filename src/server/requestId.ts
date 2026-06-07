/**
 * Request ID 中间件 (S3-2)
 * 为每个请求注入唯一 requestId，支持 X-Request-Id header 透传
 */
import { randomUUID } from 'crypto';
import type { Request, Response, NextFunction } from 'express';

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const requestId = (req.headers['x-request-id'] as string) || randomUUID();
  res.setHeader('x-request-id', requestId);
  (req as any).requestId = requestId;
  next();
}
