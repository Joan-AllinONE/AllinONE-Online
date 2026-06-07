/**
 * 库存 API 路由 (S4-1)
 * GET    /api/v1/inventory
 * GET    /api/v1/inventory/summary
 * POST   /api/v1/inventory
 * POST   /api/v1/inventory/sync
 * GET    /api/v1/inventory/:itemId/sync-status
 * PATCH  /api/v1/inventory/:itemId/sync-status
 */
import { Router } from 'express';

export function createInventoryRouter(
  useMemoryDB: boolean,
  memoryDB: any,
  pool: any,
  isProduction: boolean
): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    try {
      const userId = (req as any).userId;
      const { gameSource, page = 1, limit = 50 } = req.query;
      let items, total;

      if (useMemoryDB) {
        const result = await memoryDB.queryInventory(userId, {
          gameSource,
          page: parseInt(page as string),
          limit: parseInt(limit as string),
        });
        items = result.items;
        total = result.total;
      } else {
        let query = `SELECT * FROM cross_game_inventory WHERE user_id = $1`;
        const params: any[] = [userId];
        if (gameSource) { query += ` AND game_source = $2`; params.push(gameSource); }
        query += ` ORDER BY obtained_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
        params.push(parseInt(limit as string), (parseInt(page as string) - 1) * parseInt(limit as string));
        const result = await pool.query(query, params);
        items = result.rows;
        const countResult = await pool.query(`SELECT COUNT(*) FROM cross_game_inventory WHERE user_id = $1`, [userId]);
        total = parseInt(countResult.rows[0].count);
      }

      res.json({ success: true, data: { items, pagination: { page: parseInt(page as string), limit: parseInt(limit as string), total } }, message: '获取库存成功' });
    } catch (error: any) {
      res.status(500).json({ success: false, error: isProduction ? 'Internal server error' : '获取库存失败' });
    }
  });

  router.get('/summary', async (req, res) => {
    try {
      const userId = (req as any).userId;
      let rows;
      if (useMemoryDB) {
        rows = await memoryDB.getInventorySummary(userId);
      } else {
        const result = await pool.query(`SELECT * FROM user_inventory_summary WHERE user_id = $1`, [userId]);
        rows = result.rows;
      }
      res.json({ success: true, data: { byGame: rows }, message: '获取汇总成功' });
    } catch (error: any) {
      res.status(500).json({ success: false, error: isProduction ? 'Internal server error' : '获取汇总失败' });
    }
  });

  router.post('/', async (req, res) => {
    try {
      const userId = (req as any).userId;
      const { itemId, name, description, gameSource, gameName, category, rarity, stats, quantity = 1 } = req.body;
      const syncStatus = req.body.syncStatus || 'not_synced';

      if (useMemoryDB) {
        const existing = await memoryDB.findInventoryItem(userId, itemId, gameSource);
        if (existing) {
          const newQty = existing.quantity + quantity;
          await memoryDB.updateInventoryQuantity(existing.id, newQty);
          res.json({ success: true, data: { id: existing.id, quantity: newQty, syncStatus: existing.sync_status }, message: '道具数量已更新' });
        } else {
          const newItem = await memoryDB.addInventoryItem({ item_id: itemId, user_id: userId, name, description, game_source: gameSource, game_name: gameName || gameSource, category, rarity, stats: stats || null, quantity, obtained_from: 'sync', sync_status: syncStatus, obtained_at: new Date() });
          res.json({ success: true, data: newItem, message: '道具添加成功' });
        }
      } else {
        const existing = await pool.query(`SELECT id, quantity, sync_status FROM cross_game_inventory WHERE user_id = $1 AND item_id = $2 AND game_source = $3`, [userId, itemId, gameSource]);
        if (existing.rows.length > 0) {
          const newQty = existing.rows[0].quantity + quantity;
          await pool.query(`UPDATE cross_game_inventory SET quantity = $1, updated_at = NOW() WHERE id = $2`, [newQty, existing.rows[0].id]);
          res.json({ success: true, data: { id: existing.rows[0].id, quantity: newQty, syncStatus: existing.rows[0].sync_status }, message: '道具数量已更新' });
        } else {
          const result = await pool.query(`INSERT INTO cross_game_inventory (item_id, user_id, name, description, game_source, game_name, category, rarity, stats, quantity, obtained_from, sync_status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'sync',$11) RETURNING *`, [itemId, userId, name, description, gameSource, gameName || gameSource, category, rarity, stats ? JSON.stringify(stats) : null, quantity, syncStatus]);
          res.json({ success: true, data: result.rows[0], message: '道具添加成功' });
        }
      }
    } catch (error: any) {
      res.status(500).json({ success: false, error: isProduction ? 'Internal server error' : '添加道具失败' });
    }
  });

  router.post('/sync', async (req, res) => {
    const startTime = Date.now();
    try {
      const userId = (req as any).userId;
      const { gameSource, items } = req.body;
      let added = 0, updated = 0;

      if (useMemoryDB) {
        for (const item of items) {
          const existing = await memoryDB.findInventoryItem(userId, item.id, gameSource);
          if (existing) { existing.name = item.name; existing.description = item.description; existing.category = item.type || item.category; existing.rarity = item.rarity; existing.stats = item.stats || null; existing.quantity = item.quantity || 1; existing.sync_status = 'synced'; existing.updated_at = new Date(); updated++; }
          else { await memoryDB.addInventoryItem({ item_id: item.id, user_id: userId, name: item.name, description: item.description, game_source: gameSource, game_name: gameSource === 'newday' ? 'New Day' : 'AllinONE', category: item.type || item.category, rarity: item.rarity, stats: item.stats || null, quantity: item.quantity || 1, obtained_from: 'sync', sync_status: 'synced', obtained_at: new Date() }); added++; }
        }
      } else {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          for (const item of items) {
            const existing = await client.query(`SELECT id FROM cross_game_inventory WHERE user_id = $1 AND item_id = $2 AND game_source = $3`, [userId, item.id, gameSource]);
            if (existing.rows.length > 0) { await client.query(`UPDATE cross_game_inventory SET name=$1,description=$2,category=$3,rarity=$4,stats=$5,quantity=$6,updated_at=NOW(),sync_status='synced',last_sync_at=NOW() WHERE id=$7`, [item.name, item.description, item.type || item.category, item.rarity, item.stats ? JSON.stringify(item.stats) : null, item.quantity || 1, existing.rows[0].id]); updated++; }
            else { await client.query(`INSERT INTO cross_game_inventory (item_id,user_id,name,description,game_source,game_name,category,rarity,stats,quantity,obtained_from,sync_status,last_sync_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'sync','synced',NOW())`, [item.id, userId, item.name, item.description, gameSource, gameSource === 'newday' ? 'New Day' : 'AllinONE', item.type || item.category, item.rarity, item.stats ? JSON.stringify(item.stats) : null, item.quantity || 1]); added++; }
          }
          await client.query('COMMIT');
        } catch (err) { await client.query('ROLLBACK'); throw err; }
        finally { client.release(); }
      }

      const duration = Date.now() - startTime;
      res.json({ success: true, data: { synced: items.length, added, updated, duration: `${duration}ms` }, message: `成功同步 ${added} 个新道具` });
    } catch (error: any) {
      res.status(500).json({ success: false, error: isProduction ? 'Internal server error' : '同步失败' });
    }
  });

  router.get('/:itemId/sync-status', async (req, res) => {
    try {
      const userId = (req as any).userId;
      const { itemId } = req.params;
      let syncStatus, syncedAt;
      if (useMemoryDB) {
        const { items } = await memoryDB.queryInventory(userId, { limit: 1000 });
        const item = items.find((i: any) => i.item_id === itemId);
        if (!item) return res.status(404).json({ success: false, error: '道具不存在' });
        syncStatus = item.sync_status; syncedAt = item.last_sync_at;
      } else {
        const result = await pool.query(`SELECT sync_status, synced_at FROM cross_game_inventory WHERE user_id=$1 AND item_id=$2`, [userId, itemId]);
        if (result.rows.length === 0) return res.status(404).json({ success: false, error: '道具不存在' });
        syncStatus = result.rows[0].sync_status; syncedAt = result.rows[0].synced_at;
      }
      res.json({ success: true, data: { syncStatus, syncedAt }, message: '获取同步状态成功' });
    } catch (error: any) {
      res.status(500).json({ success: false, error: isProduction ? 'Internal server error' : '获取同步状态失败' });
    }
  });

  router.patch('/:itemId/sync-status', async (req, res) => {
    try {
      const userId = (req as any).userId;
      const { itemId } = req.params;
      const { syncStatus, syncedAt } = req.body;
      if (!syncStatus || !['not_synced', 'syncing', 'synced', 'failed'].includes(syncStatus)) {
        return res.status(400).json({ success: false, error: '无效的同步状态' });
      }
      if (useMemoryDB) {
        await memoryDB.updateSyncStatus(itemId, userId, syncStatus);
      } else {
        let updateQuery = `UPDATE cross_game_inventory SET sync_status=$1, updated_at=NOW()`;
        const params: any[] = [syncStatus, userId, itemId];
        if (syncedAt) { updateQuery += `, last_sync_at=$2`; params.splice(1, 0, syncedAt); }
        updateQuery += ` WHERE user_id=$${params.length - 1} AND item_id=$${params.length}`;
        const result = await pool.query(updateQuery, params);
        if (result.rowCount === 0) return res.status(404).json({ success: false, error: '道具不存在' });
      }
      res.json({ success: true, data: { syncStatus, syncedAt }, message: '同步状态更新成功' });
    } catch (error: any) {
      res.status(500).json({ success: false, error: isProduction ? 'Internal server error' : '更新同步状态失败' });
    }
  });

  return router;
}
