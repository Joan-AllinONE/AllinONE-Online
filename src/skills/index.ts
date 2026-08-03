/**
 * AllinONE Skill 系统 - MVP v1.0 统一导出
 * 7 Skills 注册入口 + 通用导出
 */

// ==================== 核心 ====================
export * from './types';
export * from './errors';
export { EventBus, globalEventBus } from './EventBus';
export { SkillGateway, getDefaultGateway, resetDefaultGateway } from './SkillGateway';
export { BaseSkill, createSimpleSkill } from './BaseSkill';
export { SkillSDK, createSDK, skillSDK } from './sdk/SkillSDK';

// ==================== 生成器 ====================
export {
  generateSkill, generateSkillFromFile, batchGenerateSkills,
  validateConfig, getDefaultTemplate, getYAMLTemplate,
  SkillConfigParser, SkillCodeGenerator, ConfigValidator,
} from './generator';

// ==================== 7 Skills ====================
export * from './auth/AuthSkill';
export * from './wallet/WalletSkill';
export * from './inventory/InventorySkill';
export * from './store/StoreSkill';
export * from './game-connector/GameConnectorSkill';

// ==================== 初始化 ====================

import { SkillGateway, getDefaultGateway } from './SkillGateway';
import { authSkill } from './auth/AuthSkill';
import { walletSkill } from './wallet/WalletSkill';
import { inventorySkill } from './inventory/InventorySkill';
import { storeSkill } from './store/StoreSkill';
import { gameConnectorSkill } from './game-connector/GameConnectorSkill';

export const skillGateway = getDefaultGateway({
  debug: process.env.NODE_ENV === 'development',
});

export async function initializeSkills(): Promise<void> {
  try {
    await skillGateway.registerSkill(authSkill);
    await skillGateway.registerSkill(walletSkill);
    await skillGateway.registerSkill(inventorySkill);
    await skillGateway.registerSkill(storeSkill);
    await skillGateway.registerSkill(gameConnectorSkill);
    // voucher + proposal skills are loaded lazily or via separate init
    try {
      const { voucherSkill } = await import('./voucher/VoucherSkill');
      await skillGateway.registerSkill(voucherSkill);
    } catch { console.warn('[Skills] voucher Skill not available yet'); }
    try {
      const { proposalSkill } = await import('./proposal/ProposalSkill');
      await skillGateway.registerSkill(proposalSkill);
    } catch { console.warn('[Skills] proposal Skill not available yet'); }
    console.log('[Skills] Skills initialized');
  } catch (err) {
    console.warn('[Skills] Init partial:', err);
  }
}

export async function destroySkills(): Promise<void> {
  await skillGateway.destroy();
}
