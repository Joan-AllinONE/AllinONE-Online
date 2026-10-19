#!/usr/bin/env node
/**
 * 合约引擎单一编译产物构建（B1）
 *
 * esbuild 把 src/contracts/index.ts（含 engine + templates）bundle 成
 * cloudfunctions/gamesApi/contract-engine.js（CJS）。
 *
 * 防 TS/JS 双实现漂移的铁律：
 * - 云函数**只允许** require 本编译产物，禁止手写任何引擎逻辑；
 * - 本地 server 直接 import TS 源码（同一份逻辑，125 个单测背书）；
 * - 两端永远出自同一 TS 源，不存在手工同步。
 *
 * 用法：pnpm build:engine 或 node scripts/build-engine.cjs
 */
'use strict';

const path = require('path');
const fs = require('fs');

async function main() {
  const esbuild = require(path.join(__dirname, '..', 'node_modules', 'esbuild', 'lib', 'main.js'));
  const root = path.resolve(__dirname, '..');
  const entry = path.join(root, 'src', 'contracts', 'index.ts');
  const outFile = path.join(root, 'cloudfunctions', 'gamesApi', 'contract-engine.js');

  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    outfile: outFile,
    minify: false,
    sourcemap: false,
    logLevel: 'info',
    banner: {
      js:
        '/* eslint-disable */\n' +
        '// ★ 自动生成文件（scripts/build-engine.cjs）—— 禁止手工编辑\n' +
        '// 源：src/contracts/index.ts（engine + templates）\n' +
        '// 重新生成：node scripts/build-engine.cjs\n',
    },
  });

  const size = fs.statSync(outFile).size;
  console.log(`[build-engine] OK: ${path.relative(root, outFile)} (${(size / 1024).toFixed(1)} KB)`);
}

main().catch((e) => {
  console.error('[build-engine] FAILED:', e && e.message);
  process.exit(1);
});
