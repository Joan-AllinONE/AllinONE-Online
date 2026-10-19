/**
 * 合约模板注册表（纯数据）
 *
 * deploy 时：模板静态校验（validateTemplate）→ 参数校验 → codeHash 固化。
 * 模板升级 = version+1 新条目；存量实例按冻结的 clauses 继续运行（upgradePolicy 控制）。
 */
import type { ContractTemplate, TemplateKey } from '../types.js';
import { GROUP_BUY_TEMPLATE } from './groupBuy.js';
import { TEAM_QUEST_TEMPLATE } from './teamQuest.js';
import { GSO_TEMPLATE } from './gso.js';

export const GROUP_BUY = GROUP_BUY_TEMPLATE;
export const TEAM_QUEST = TEAM_QUEST_TEMPLATE;
export const GSO = GSO_TEMPLATE;

const REGISTRY = new Map<string, ContractTemplate>();

export function registerTemplate(tpl: ContractTemplate): void {
  REGISTRY.set(`${tpl.key}@${tpl.version}`, tpl);
  // 同 key 最高版本别名（query 未带 version 时取最高）
  const cur = REGISTRY.get(tpl.key);
  if (!cur || cur.version < tpl.version) REGISTRY.set(tpl.key, tpl);
}

[GROUP_BUY_TEMPLATE, TEAM_QUEST_TEMPLATE, GSO_TEMPLATE].forEach(registerTemplate);

export function getTemplate(key: TemplateKey, version?: number): ContractTemplate | undefined {
  if (version !== undefined) return REGISTRY.get(`${key}@${version}`);
  return REGISTRY.get(String(key));
}

export function listTemplates(): ContractTemplate[] {
  // 去重：只返回每 key 最高版本（REGISTRY 里 key 不含版本号的条目）
  const seen = new Map<string, ContractTemplate>();
  for (const [k, tpl] of REGISTRY) {
    if (!k.includes('@')) seen.set(k, tpl);
  }
  return [...seen.values()];
}
