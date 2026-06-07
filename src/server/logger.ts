/**
 * 结构化日志模块 (S3-1)
 * 使用 pino 替代 console.log，支持 JSON 格式输出、日志级别、requestId 注入
 */
import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  ...(process.env.NODE_ENV !== 'production'
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss' },
        },
      }
    : {}),
  serializers: {
    err: pino.stdSerializers.err,
  },
  base: { pid: process.pid },
  timestamp: pino.stdTimeFunctions.isoTime,
});

/**
 * Express 请求日志中间件
 * 自动记录 method、url、statusCode、duration、userId
 */
export function requestLogger(req: any, res: any, next: () => void): void {
  const start = Date.now();
  res.on('finish', () => {
    logger.info({
      method: req.method,
      url: req.originalUrl,
      statusCode: res.statusCode,
      durationMs: Date.now() - start,
      userId: req.userId,
    }, 'request completed');
  });
  next();
}
