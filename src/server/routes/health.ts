/**
 * 健康检查路由 (S4-1)
 * GET /api/v1/health — 增强版健康检查（含 PG ping + 延迟）
 */
import { Router } from 'express';

export function createHealthRouter(
  useMemoryDB: boolean,
  pool: any
): Router {
  const router = Router();

  router.get('/', async (_req, res) => {
    let dbStatus = 'unknown';
    let dbLatency: number | undefined;

    if (useMemoryDB) {
      dbStatus = 'memory';
    } else if (pool) {
      try {
        const start = Date.now();
        await pool.query('SELECT 1');
        dbLatency = Date.now() - start;
        dbStatus = 'connected';
      } catch {
        dbStatus = 'error';
      }
    } else {
      dbStatus = 'disconnected';
    }

    res.json({
      status: dbStatus === 'connected' || dbStatus === 'memory' ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      database: dbStatus,
      mode: useMemoryDB ? 'memory' : 'postgresql',
      ...(dbLatency !== undefined ? { dbLatencyMs: dbLatency } : {}),
    });
  });

  return router;
}
