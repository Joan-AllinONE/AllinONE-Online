/**
 * dev 测试数据清理 — 浏览器侧脚本
 *
 * 用法：打开 dev 页面 → F12 → Console → 粘贴本文件全部内容 → 回车
 * （也可把内容存为浏览器 Snippet 反复使用）
 *
 * 会清理：
 *   1. localStorage 中所有测试数据（保留 KEEP_KEYS 里列出的键，如主题偏好）
 *   2. 所有 IndexedDB 数据库（AllinONE_GameFiles 游戏文件/列表缓存、writeQueue 队列等）
 *   3. Cache Storage（Service Worker 缓存）
 *   4. 注销所有 Service Worker
 * 完成后自动刷新页面。
 *
 * ⚠️ 只在 dev 环境（localhost）使用。本脚本只清理当前浏览器 origin 下的存储，
 *    不会向任何服务器发送数据。
 */

(async () => {
  // 保留的键（不是测试数据：主题偏好等）。如需连登录态一起清，把 'allinone_user' 从数组移除。
  const KEEP_KEYS = ['theme'];

  const isLocalhost = ['localhost', '127.0.0.1'].includes(location.hostname);
  if (!isLocalhost) {
    console.warn('[dev-clean] ⚠️ 当前不是 localhost，已取消执行。此脚本仅用于 dev 环境。');
    return;
  }

  const removed = [];

  // ① 清空 localStorage
  try {
    const keys = Object.keys(localStorage);
    keys.forEach((k) => {
      if (KEEP_KEYS.includes(k)) return;
      localStorage.removeItem(k);
      removed.push('localStorage: ' + k);
    });
    console.log(`[dev-clean] localStorage 已清理 ${keys.length - KEEP_KEYS.length} 项（保留: ${KEEP_KEYS.join(', ') || '无'}）`);
  } catch (e) {
    console.warn('[dev-clean] localStorage 清理失败:', e);
  }

  // ② 清空 IndexedDB（先枚举全部库，失败则兜底删除已知库名）
  const deleteDb = (name) =>
    new Promise((resolve) => {
      try {
        const req = indexedDB.deleteDatabase(name);
        req.onsuccess = () => resolve(true);
        req.onerror = () => resolve(false);
        req.onblocked = () => resolve(false);
      } catch {
        resolve(false);
      }
    });

  try {
    let dbNames = [];
    if (typeof indexedDB.databases === 'function') {
      const list = await indexedDB.databases();
      dbNames = list.map((d) => d.name).filter(Boolean);
    }
    // 兜底已知库名（旧浏览器不支持 databases()）
    ['AllinONE_GameFiles', 'allinone_write_queue', 'AllinONE_WriteQueue'].forEach((n) => {
      if (!dbNames.includes(n)) dbNames.push(n);
    });

    for (const name of dbNames) {
      const ok = await deleteDb(name);
      if (ok) removed.push('IndexedDB: ' + name);
    }
    console.log(`[dev-clean] IndexedDB 已清理: ${dbNames.join(', ') || '无'}`);
  } catch (e) {
    console.warn('[dev-clean] IndexedDB 清理失败:', e);
  }

  // ③ 清空 Cache Storage
  try {
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
      console.log(`[dev-clean] Cache Storage 已清理 ${keys.length} 项: ${keys.join(', ') || '无'}`);
      keys.forEach((k) => removed.push('Cache: ' + k));
    }
  } catch (e) {
    console.warn('[dev-clean] Cache Storage 清理失败:', e);
  }

  // ④ 注销 Service Worker
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
      console.log(`[dev-clean] 已注销 ${regs.length} 个 Service Worker`);
      regs.forEach(() => removed.push('ServiceWorker'));
    }
  } catch (e) {
    console.warn('[dev-clean] Service Worker 注销失败:', e);
  }

  console.log(`[dev-clean] ✅ 浏览器侧清理完成，共 ${removed.length} 项。即将刷新页面...`);

  setTimeout(() => location.reload(), 500);
})();
