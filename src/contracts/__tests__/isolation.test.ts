/**
 * 独立性守卫测试（B0 验收项）
 *
 * 1. 真实 src/contracts 必须零违规
 * 2. 反例必须被拦截（用临时目录验证守卫脚本本身的检测能力）
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

// 脚本在 src 之外，vite 静态解析不了 src 外的 .cjs —— 用 createRequire + 绝对路径运行时加载
const requireCjs = createRequire(import.meta.url);
const guardScriptPath = path.resolve(process.cwd(), 'scripts', 'check-contracts-isolation.cjs');

interface IsolationViolation {
  file: string;
  spec: string;
  reason: string;
}
interface IsolationResult {
  ok: boolean;
  violations: IsolationViolation[];
  scanned: number;
}
interface IsolationChecker {
  checkContractsIsolation: (opts?: { rootDir?: string; contractsDir?: string }) => IsolationResult;
}

const { checkContractsIsolation } = requireCjs(guardScriptPath) as IsolationChecker;

describe('合约模块独立性守卫', () => {
  it('真实 src/contracts 零业务依赖', () => {
    const r = checkContractsIsolation();
    if (!r.ok) {
      console.error('违规明细:', r.violations);
    }
    expect(r.ok).toBe(true);
    expect(r.scanned).toBeGreaterThan(0);
  });
});

describe('守卫脚本检测能力（临时目录反例）', () => {
  const tmpRoots: string[] = [];

  function makeFixture(files: Record<string, string>): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'contracts-guard-'));
    tmpRoots.push(root);
    const contractsDir = path.join(root, 'src', 'contracts');
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(contractsDir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content, 'utf8');
    }
    return root;
  }

  afterAll(() => {
    for (const root of tmpRoots) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('拦截 @/services 业务导入', () => {
    const root = makeFixture({
      'engine/bad.ts': `import { x } from '@/services/foo';\nexport const y = x;\n`,
    });
    const r = checkContractsIsolation({ rootDir: root });
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.spec === '@/services/foo')).toBe(true);
  });

  it('拦截第三方包导入', () => {
    const root = makeFixture({
      'engine/pkg.ts': `import dayjs from 'dayjs';\nexport const d = dayjs;\n`,
    });
    const r = checkContractsIsolation({ rootDir: root });
    expect(r.violations.some((v) => v.spec === 'dayjs')).toBe(true);
  });

  it('拦截相对路径逃逸', () => {
    const root = makeFixture({
      'engine/escape.ts': `import { helper } from '../../services/helper.js';\nexport const h = helper;\n`,
    });
    const r = checkContractsIsolation({ rootDir: root });
    expect(r.violations.some((v) => v.reason.includes('逃逸'))).toBe(true);
  });

  it('拦截 require 与动态 import', () => {
    const root = makeFixture({
      'engine/req.ts': `const z = require('lodash');\nexport const w = z;\n`,
      'engine/dyn.ts': `export const lazy = () => import('react');\n`,
    });
    const r = checkContractsIsolation({ rootDir: root });
    expect(r.violations.some((v) => v.spec === 'lodash')).toBe(true);
    expect(r.violations.some((v) => v.spec === 'react')).toBe(true);
  });

  it('拦截 @/contracts 别名导入（统一相对路径）', () => {
    const root = makeFixture({
      'engine/alias.ts': `import { sha } from '@/contracts/engine/hash';\nexport const s = sha;\n`,
    });
    const r = checkContractsIsolation({ rootDir: root });
    expect(r.violations.some((v) => v.reason.includes('别名'))).toBe(true);
  });

  it('合法内部相对导入放行', () => {
    const root = makeFixture({
      'engine/hash.ts': `export const sha = (s: string) => s;\n`,
      'engine/ok.ts': `import { sha } from './hash.js';\nexport const v = sha;\n`,
      'engine/deep/nest.ts': `import { sha } from '../hash.js';\nexport const v2 = sha;\n`,
    });
    const r = checkContractsIsolation({ rootDir: root });
    expect(r.ok).toBe(true);
  });

  it('client/ 目录豁免（预期耦合点）', () => {
    const root = makeFixture({
      'client/tunnel.ts': `import { getApiBase } from '@/services/apiBase';\nexport const api = getApiBase;\n`,
      'engine/hash.ts': `export const sha = (s: string) => s;\n`,
    });
    const r = checkContractsIsolation({ rootDir: root });
    expect(r.ok).toBe(true);
  });

  it('测试文件不扫描', () => {
    const root = makeFixture({
      'engine/__tests__/x.test.ts': `import { describe } from 'vitest';\ndescribe('x', () => {});\n`,
    });
    const r = checkContractsIsolation({ rootDir: root });
    expect(r.ok).toBe(true);
  });
});
