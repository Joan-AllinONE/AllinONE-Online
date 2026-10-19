#!/usr/bin/env node
/**
 * 合约模块独立性守卫（替代 ESLint no-restricted-imports 的零依赖方案）
 *
 * 铁律（设计文档第 9 章 + B0 验收项）：
 *   src/contracts 内除 client/ 与 ui/ 两个子目录外，所有源文件：
 *     1. 只允许相对路径 import（./ 或 ../），且解析后必须仍在 src/contracts 内
 *     2. 禁止一切包名 import（react、lodash、@/services/** ...）
 *     3. 禁止逃逸出 src/contracts（防依赖倒置被架空）
 *   client/ 与 ui/ 允许 import 平台模块（隧道客户端、React UI 是预期耦合点）；
 *   平台对合约核心的全部反向依赖只应出现在 src/contracts-adapters/。
 *
 * 用法：
 *   CLI：  node scripts/check-contracts-isolation.cjs          （违规时 exit 1）
 *   API：  const { checkContractsIsolation } = require('./check-contracts-isolation.cjs')
 *   构建： 已挂入 pnpm build 前置（package.json）
 *   测试： src/contracts/__tests__/isolation.test.ts 用临时目录做「反例拦截」验收
 */
'use strict';

const fs = require('fs');
const path = require('path');

/** 豁免目录（相对 src/contracts）：允许 import 平台模块 */
const RELAXED_DIRS = ['client', 'ui'];
/** 扫描的扩展名 */
const EXTS = ['.ts', '.tsx'];

const IMPORT_PATTERNS = [
  // import ... from 'x' / export ... from 'x'
  /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?[^'";]*?from\s*['"]([^'"]+)['"]/g,
  // 裸副作用 import 'x'
  /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g,
  // require('x')
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  // 动态 import('x')
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

function walk(dir, out) {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      walk(full, out);
    } else if (EXTS.includes(path.extname(name))) {
      out.push(full);
    }
  }
}

function extractImports(source) {
  const found = [];
  for (const re of IMPORT_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(source)) !== null) {
      found.push(m[1]);
    }
  }
  return found;
}

function isRelaxed(file, contractsDir) {
  const rel = path.relative(contractsDir, file);
  const top = rel.split(path.sep)[0];
  return RELAXED_DIRS.includes(top);
}

/**
 * @param {{rootDir?: string, contractsDir?: string}} opts
 *   rootDir     项目根（默认本脚本上两级）
 *   contractsDir 合约目录（默认 <rootDir>/src/contracts）
 * @returns {{ok: boolean, violations: Array<{file: string, spec: string, reason: string}>, scanned: number}}
 */
function checkContractsIsolation(opts = {}) {
  const rootDir = opts.rootDir || path.resolve(__dirname, '..');
  const contractsDir = opts.contractsDir || path.join(rootDir, 'src', 'contracts');

  const files = [];
  walk(contractsDir, files);

  const violations = [];
  for (const file of files) {
    if (file.includes(`${path.sep}__tests__${path.sep}`) || /\.(test|spec)\.[jt]sx?$/.test(file)) {
      continue; // 测试文件允许 import vitest
    }
    const source = fs.readFileSync(file, 'utf8');
    const relaxed = isRelaxed(file, contractsDir);
    for (const spec of extractImports(source)) {
      if (relaxed) continue; // client/ui 豁免
      if (spec.startsWith('.')) {
        // 相对路径：解析后必须仍在 contracts 内，且不能是 .ts 后缀导入（规范：省略扩展名或 .js）
        const resolved = path.resolve(path.dirname(file), spec);
        const inside = resolved === contractsDir || resolved.startsWith(contractsDir + path.sep);
        if (!inside) {
          violations.push({ file: path.relative(rootDir, file), spec, reason: '相对路径逃逸出 src/contracts' });
        }
        if (/\.ts['"]?$/.test(spec)) {
          violations.push({ file: path.relative(rootDir, file), spec, reason: '禁止 .ts 扩展名导入（云函数编译产物兼容）' });
        }
      } else {
        // 包名 / 别名（@/...）一律违规：零依赖铁律
        violations.push({
          file: path.relative(rootDir, file),
          spec,
          reason: spec.startsWith('@/contracts') ? '禁止别名导入（统一相对路径）' : '零依赖铁律：禁止业务/第三方 import',
        });
      }
    }
  }
  return { ok: violations.length === 0, violations, scanned: files.length };
}

// ============================================================
// 防回潮守卫（R6）：硬编码规则标识符禁止回归 + 兜底副本一致性校验
// ============================================================

/** 已收敛到 contract_rules 的旧硬编码标识符（任何源码出现即违规） */
const LEGACY_RULE_IDENTIFIERS = [
  { re: /\bMARKET_COMMISSION_RATE\b/g, why: '市场佣金率 → 规则键 market.commission_rate（platformRulesService）' },
  { re: /\bDAILY_HARVEST_LIMIT\b/g, why: '道具提取限额 → 规则键 item_harvest.daily_limit（getRuleValue）' },
  { re: /\bDEFAULT_REVENUE_SHARE\b/g, why: '开发者分成默认值 → 规则键 settlement.revenue_share_percent' },
  { re: /\bMAX_DAILY_CONVERSIONS\b/g, why: '跨游戏兑换限额 → 规则键 cross_exchange.daily_limit' },
  { re: /\bEXCHANGE_FEE_RATE\b/g, why: '跨游戏兑换费率 → 规则键 cross_exchange.fee_rate' },
  { re: /\bITEM_DAILY_LIMIT\s*=\s*10\b/g, why: '频控硬编码 → getPlatformRule/getLocalRule(item_harvest.daily_limit)' },
  // 只拦截 import 引用：types.ts / 云函数内的本地定义是合法的
  { re: /import\s+[^;\n]*\bPLATFORM_RULE_DEFAULTS\b/g, why: '前端兜底必须用独立副本（platformRulesService.PLATFORM_RULE_FALLBACKS），禁止 import contracts' },
];

/** 防回潮豁免：本地服务端合约隧道的 seed 定义处（服务端复用 contracts 是设计内行为） */
const REGRESSION_EXEMPT_FILES = new Set([
  'src' + path.sep + 'server' + path.sep + 'routes' + path.sep + 'contractTunnel.ts',
  'src' + path.sep + 'contracts' + path.sep + 'types.ts',
]);

/** 兜底副本一致性：三处数值必须与 types.ts PLATFORM_RULE_DEFAULTS 对齐 */
function extractContractDefaults(typesSource) {
  const out = {};
  const re = /ruleKey:\s*'([^']+)'\s*,\s*value:\s*([0-9.eE+]+)/g;
  let m;
  while ((m = re.exec(typesSource)) !== null) out[m[1]] = Number(m[2]);
  return out;
}
function extractFallbackMap(source, exportName) {
  const anchor = source.indexOf(exportName);
  if (anchor < 0) return null;
  const start = source.indexOf('{', anchor);
  if (start < 0) return null;
  // 粗提取到对象的配对右括号
  let depth = 0, end = start;
  for (let i = start; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  const body = source.slice(start, end + 1);
  const out = {};
  const re = /'([^']+)'\s*:\s*([0-9.eE+]+)/g;
  let m;
  while ((m = re.exec(body)) !== null) out[m[1]] = Number(m[2]);
  return out;
}
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * @returns {{ok: boolean, violations: string[]}}
 */
function checkRuleHardcodeRegression(opts = {}) {
  const rootDir = opts.rootDir || path.resolve(__dirname, '..');
  const scanTargets = [
    path.join(rootDir, 'src'),
    path.join(rootDir, 'cloudfunctions', 'gamesApi', 'index.js'),
  ];
  const violations = [];

  // ---- 1) 旧标识符回潮检测（去注释后匹配，注释里的历史说明不算违规） ----
  const files = [];
  for (const t of scanTargets) {
    if (!fs.existsSync(t)) continue;
    const stat = fs.statSync(t);
    if (stat.isFile()) files.push(t);
    else walk(t, files);
  }
  for (const file of files) {
    const raw = fs.readFileSync(file, 'utf8');
    const relFile = path.relative(rootDir, file);
    if (REGRESSION_EXEMPT_FILES.has(relFile)) continue;
    const code = stripComments(raw);
    for (const { re, why } of LEGACY_RULE_IDENTIFIERS) {
      re.lastIndex = 0;
      if (re.test(code)) {
        violations.push(`${path.relative(rootDir, file)}: 硬编码规则回潮 — ${why}`);
      }
    }
  }

  // ---- 2) 兜底副本一致性（types.ts ↔ platformRulesService ↔ games.ts） ----
  const typesPath = path.join(rootDir, 'src', 'contracts', 'types.ts');
  const prsPath = path.join(rootDir, 'src', 'services', 'platformRulesService.ts');
  const gamesPath = path.join(rootDir, 'src', 'server', 'routes', 'games.ts');
  if (fs.existsSync(typesPath) && fs.existsSync(prsPath)) {
    const seeds = extractContractDefaults(fs.readFileSync(typesPath, 'utf8'));
    const fb = extractFallbackMap(fs.readFileSync(prsPath, 'utf8'), 'PLATFORM_RULE_FALLBACKS');
    if (!fb) violations.push('platformRulesService.ts: 未找到 PLATFORM_RULE_FALLBACKS 兜底副本');
    else {
      const seedKeys = Object.keys(seeds).sort();
      const fbKeys = Object.keys(fb).sort();
      if (JSON.stringify(seedKeys) !== JSON.stringify(fbKeys)) {
        const onlySeed = seedKeys.filter(k => !fbKeys.includes(k));
        const onlyFb = fbKeys.filter(k => !seedKeys.includes(k));
        violations.push(`platformRulesService.PLATFORM_RULE_FALLBACKS 与 types.ts 键不一致（仅 seed 有: ${onlySeed}；仅兜底有: ${onlyFb}）`);
      }
      for (const k of seedKeys) {
        if (k in fb && seeds[k] !== fb[k]) {
          violations.push(`platformRulesService 兜底值漂移: ${k} seed=${seeds[k]} fallback=${fb[k]}`);
        }
      }
    }
  }
  if (fs.existsSync(typesPath) && fs.existsSync(gamesPath)) {
    const seeds = extractContractDefaults(fs.readFileSync(typesPath, 'utf8'));
    const fb = extractFallbackMap(fs.readFileSync(gamesPath, 'utf8'), 'LOCAL_RULE_FALLBACKS');
    if (!fb) violations.push('server/routes/games.ts: 未找到 LOCAL_RULE_FALLBACKS 兜底副本');
    else {
      for (const k of Object.keys(seeds)) {
        if (!(k in fb)) violations.push(`games.ts LOCAL_RULE_FALLBACKS 缺键: ${k}`);
        else if (seeds[k] !== fb[k]) violations.push(`games.ts 兜底值漂移: ${k} seed=${seeds[k]} fallback=${fb[k]}`);
      }
    }
  }
  return { ok: violations.length === 0, violations };
}

module.exports = { checkContractsIsolation, checkRuleHardcodeRegression };

if (require.main === module) {
  const result = checkContractsIsolation();
  if (result.ok) {
    console.log(`[contracts-isolation] OK：${result.scanned} 个文件，零业务依赖。`);
  } else {
    console.error(`[contracts-isolation] 发现 ${result.violations.length} 处违规：`);
    for (const v of result.violations) {
      console.error(`  - ${v.file}`);
      console.error(`      import "${v.spec}"  ← ${v.reason}`);
    }
  }
  const regression = checkRuleHardcodeRegression();
  if (regression.ok) {
    console.log('[rule-regression] OK：无硬编码规则回潮，兜底副本一致。');
  } else {
    console.error(`[rule-regression] 发现 ${regression.violations.length} 处违规：`);
    for (const v of regression.violations) console.error(`  - ${v}`);
  }
  process.exit(result.ok && regression.ok ? 0 : 1);
}
