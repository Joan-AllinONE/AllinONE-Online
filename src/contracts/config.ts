/**
 * 合约模块开关（B0-B6）
 *
 * - CONTRACTS_ENABLED：模块总开关（关 = 全部端点 403，模板不暴露）
 * - CONTRACT_AUTO_EXECUTE：分档自动执行开关（false = 影子模式：plan 只入账不动钱）
 *   环境变量覆盖：CONTRACT_AUTO_EXECUTE=group-buy,team-quest（CSV，出现即开）
 *   开闸顺序（风险从低到高）：group-buy → team-quest → gso
 * - CONTRACT_SHADOW_COMPARE：影子对照日志开关
 */
export const CONTRACTS_ENABLED = true;

// ⚠️ 环境变量安全访问：config.ts 会被打进浏览器 bundle（ContractWorkshop/contractAIBridge
// 引擎纯函数复用链路），vite 不注入 process —— 必须用 typeof 守卫；Node/云函数行为不变。
const ENV: Record<string, string | undefined> =
  typeof process !== 'undefined' && process.env ? process.env : {};

const RAW = ENV.CONTRACT_AUTO_EXECUTE || '';

// 🆕 本地开发环境（内存库）缺省全开三档：避免开发者启动 server.js 忘带 env 时，
// 拼团/组团/GSO 静默跑在影子模式（认购不动钱、期满不执行），误以为功能损坏（2026-10-10 用户实测踩坑）。
// 生产（云函数，无 USE_MEMORY_DB）仍必须显式设置 env——灰度开闸顺序不变。
const DEV_DEFAULT = ENV.USE_MEMORY_DB === 'true' ? 'group-buy,team-quest,gso' : '';
const LIST = (RAW || DEV_DEFAULT).split(',').map((s) => s.trim()).filter(Boolean);

export const CONTRACT_AUTO_EXECUTE: Record<string, boolean> = {
  'group-buy': LIST.includes('group-buy'),
  'team-quest': LIST.includes('team-quest'),
  gso: LIST.includes('gso'),
};

export const CONTRACT_SHADOW_COMPARE = true;
