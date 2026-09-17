#!/usr/bin/env node
/**
 * dev 测试数据一键清理工具
 *
 * 作用：彻底清空本地 dev 后端（内存库）的测试数据，包括
 *   - 已发布游戏（publishedGames）
 *   - 游戏文件（gameFiles）
 *   - 任务/提交、钱包、凭证、用户、活动等所有内存库集合
 *
 * 原理：dev 后端（USE_MEMORY_DB=true）的数据全部落在 .data/memory-db.json。
 *       停掉 server → 删除该文件 → 重启，即从空库启动。
 *
 * ⚠️ 安全保证（绝不污染生产）：
 *   1. 本脚本只操作【本地 .data/memory-db.json 文件】，不连接、不请求、不修改任何远程/云/生产资源。
 *   2. 强制门控：必须 USE_MEMORY_DB=true 或 CLOUDSTUDIO=true（dev 标志）才执行，
 *      否则拒绝运行并提示——避免误在生产/连库模式下执行导致不可预期行为。
 *   3. 若检测到是 PostgreSQL 模式（未设 USE_MEMORY_DB），脚本拒绝删除并提示去清数据库。
 *
 * 用法：
 *   pnpm dev:clean              # 停 dev → 清数据 → 重启 dev（完整）
 *   pnpm dev:clean --no-restart # 只清数据，不自动重启
 *   node scripts/dev-clean.cjs --no-restart
 */

const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DB_FILE = path.join(ROOT, '.data', 'memory-db.json');
const DATA_DIR = path.join(ROOT, '.data');

const args = process.argv.slice(2);
const noRestart = args.includes('--no-restart');

// dev 相关端口：3000=后端 server.js，3001=vite（dev:client）
const DEV_PORTS = [3000, 3001];

function log(msg) { console.log(msg); }

/** 同步阻塞等待（毫秒），不依赖外部 shell 命令 */
function sleep(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // 降级：忙等
    const end = Date.now() + ms;
    while (Date.now() < end) { /* noop */ }
  }
}

// ============ 安全门控 ============
function assertDevMode() {
  const useMemoryDB = process.env.USE_MEMORY_DB === 'true';
  const cloudStudio = process.env.CLOUDSTUDIO === 'true';
  if (!useMemoryDB && !cloudStudio) {
    console.error('\n[dev-clean] ❌ 拒绝执行：未检测到 dev 标志（USE_MEMORY_DB=true）。');
    console.error('  当前若是 PostgreSQL 模式，清理应操作数据库而非本地文件。');
    console.error('  请确认你在本地 dev 环境，并用以下方式运行：');
    console.error('    cross-env USE_MEMORY_DB=true node scripts/dev-clean.cjs');
    console.error('  或直接运行：pnpm dev:clean（已内置 USE_MEMORY_DB=true）\n');
    process.exit(1);
  }
}

// ============ 停止 dev 进程（按端口） ============
function findPidsOnPort(port) {
  const pids = new Set();
  try {
    if (process.platform === 'win32') {
      const out = execSync(`netstat -ano -p tcp`, { encoding: 'utf8', shell: 'cmd.exe' });
      out.split('\n').forEach((line) => {
        // 匹配 :3000 且 LISTENING
        if (!new RegExp(`:${port}\\s`).test(line)) return;
        if (!/LISTENING/i.test(line)) return;
        const m = line.trim().split(/\s+/);
        const pid = m[m.length - 1];
        if (pid && /^\d+$/.test(pid) && pid !== '0') pids.add(pid);
      });
    } else {
      const out = execSync(`lsof -ti tcp:${port} || true`, { encoding: 'utf8', shell: '/bin/sh' });
      out.split('\n').forEach((p) => { const t = p.trim(); if (/^\d+$/.test(t)) pids.add(t); });
    }
  } catch { /* 无进程或命令失败，忽略 */ }
  return [...pids];
}

function stopDevProcesses() {
  let stopped = 0;
  for (const port of DEV_PORTS) {
    const pids = findPidsOnPort(port);
    for (const pid of pids) {
      try {
        if (process.platform === 'win32') {
          // /T 连同子进程一起结束（concurrently 起的 server+client）
          execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore', shell: 'cmd.exe' });
        } else {
          execSync(`kill -9 ${pid}`, { stdio: 'ignore', shell: '/bin/sh' });
        }
        log(`[dev-clean] 已停止端口 ${port} 上的进程 PID=${pid}`);
        stopped++;
      } catch { /* 进程可能已退出 */ }
    }
  }
  if (stopped === 0) log('[dev-clean] 未发现运行中的 dev 进程（或已停止）');
  return stopped;
}

// ============ 删除持久化数据 ============
function deleteDbFile() {
  if (fs.existsSync(DB_FILE)) {
    const stat = fs.statSync(DB_FILE);
    const sizeMB = (stat.size / 1024 / 1024).toFixed(2);
    fs.unlinkSync(DB_FILE);
    log(`[dev-clean] ✅ 已删除测试数据文件 .data/memory-db.json (${sizeMB} MB)`);
  } else {
    log('[dev-clean] 未找到 .data/memory-db.json（可能已清理或尚未生成）');
  }

  // 连带清理可能的临时文件
  if (fs.existsSync(DATA_DIR)) {
    const others = fs.readdirSync(DATA_DIR).filter((f) => f !== 'memory-db.json');
    others.forEach((f) => {
      try { fs.unlinkSync(path.join(DATA_DIR, f)); log(`[dev-clean] 已删除 .data/${f}`); } catch { /* 忽略 */ }
    });
  }
}

// ============ 重启 dev ============
function restartDev() {
  log('[dev-clean] 正在重启 pnpm dev ...');
  const isWin = process.platform === 'win32';
  const child = spawn(isWin ? 'cmd' : 'pnpm', isWin ? ['/c', 'pnpm dev'] : ['dev'], {
    cwd: ROOT,
    detached: true,
    stdio: 'ignore',
    shell: false,
  });
  child.unref();
  log('[dev-clean] 重启命令已发出（dev 将在数秒后可用，含 tsc 编译）');
}

// ============ 主流程 ============
function main() {
  log('\n===== dev 测试数据一键清理 =====');
  log(`项目根目录: ${ROOT}`);
  log(`目标文件:   ${DB_FILE}\n`);

  assertDevMode();

  // 1. 先停 server（关键：gracefulShutdown 会 flush 落盘，必须先停再删，否则旧数据被写回）
  stopDevProcesses();

  // 2. 等待进程完全退出（用 Node 原生阻塞等待，避免依赖 shell 的 timeout/sleep 命令）
  sleep(2000);

  // 3. 删除数据文件
  deleteDbFile();

  // 4. 重启
  if (noRestart) {
    log('\n[dev-clean] 已跳过自动重启（--no-restart）。手动启动： pnpm dev\n');
  } else {
    restartDev();
  }

  // 5. 浏览器侧清理指引
  log('\n----- 浏览器侧缓存清理（在浏览器控制台执行一次）-----');
  log('打开 dev 页面 → F12 → Console → 粘贴 scripts/dev-clean-browser.js 的内容并回车');
  log('该脚本会清空 localStorage / IndexedDB / Cache Storage，并注销 Service Worker 后自动刷新。');
  log('（dev 下 publishedGameService 已跳过本地缓存，通常刷新即可；清浏览器缓存用于清除游戏文件缓存、凭证、钱包等其余测试数据）\n');
  log('===== 清理完成 =====\n');
}

main();
