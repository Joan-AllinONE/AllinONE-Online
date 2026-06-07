/**
 * Prometheus Metrics 模块 (S3-3)
 * 暴露 /metrics endpoint 供 Prometheus 抓取
 */
import { collectDefaultMetrics, Registry, Counter, Histogram } from 'prom-client';
import type { Request, Response, NextFunction } from 'express';

const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: 'allinone_' });

// HTTP 请求计数
export const httpRequestsTotal = new Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'path', 'status'],
  registers: [registry],
});

// HTTP 请求延迟直方图
export const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'path'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10],
  registers: [registry],
});

/**
 * Metrics 记录中间件 — 自动记录请求计数和延迟
 */
export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();
  const originalEnd = res.end.bind(res);

  res.end = function (...args: any[]) {
    const duration = (Date.now() - start) / 1000;
    const path = req.route?.path || req.path;
    const status = res.statusCode.toString();

    httpRequestsTotal.inc({ method: req.method, path, status });
    httpRequestDuration.observe({ method: req.method, path }, duration);

    return originalEnd(...args);
  } as any;

  next();
}

/**
 * GET /metrics 端点处理函数
 */
export async function metricsHandler(_req: Request, res: Response): Promise<void> {
  res.set('Content-Type', registry.contentType);
  res.end(await registry.metrics());
}
