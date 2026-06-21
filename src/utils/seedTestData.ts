/**
 * 测试数据种子脚本 — MVP v1.0
 *
 * 策略：应用启动时自动检测数据是否为空，空则自动填充。
 * 写入后立即触发 UI 更新事件，无需手动操作也不需刷新页面。
 *
 * 手动强制重填: window.__seedAll(true)
 *
 * 诊断:   window.__seedDiag()  查看当前 localStorage 数据
 */

// 模块级日志 — 必须在控制台可见，用于确认脚本已加载
console.log('🔧 [Seed] 模块已加载 (seedTestData.ts v2)');

// ============================================================
// 公开 API
// ============================================================

export function seedAll(): void {
  let changed = false;

  changed = seedWallet() || changed;
  changed = seedPlatformGameStores() || changed;

  if (changed) {
    // 立即触发 UI 更新事件，不需要刷新页面
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('wallet-updated'));
      window.dispatchEvent(new CustomEvent('allinoneAuthChange'));
    }
    console.log('✅ [Seed] 测试数据已就绪！无需刷新，立即可用。');
    console.log('   player1 / Abc123 — 普通玩家');
    console.log('   player2 / Abc123 — 新玩家，基础余额');
    console.log('   dev1    / Dev123 — 开发者，高余额');
    console.log('   admin   / Admin1  — 管理员，满仓');
    console.log('   平台游戏商店: /game-store');
  } else {
    console.log('ℹ️ [Seed] 测试数据已存在，跳过。强制重填: window.__seedAll(true)');
  }
}

/** 强制模式：即使已有数据也重新填充 */
export function seedAllForce(): void {
  sessionStorage.removeItem(WALLET_SEED_KEY);
  seedWalletToCloudBase();
  seedPlatformGameStoresForce();

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('wallet-updated'));
    window.dispatchEvent(new CustomEvent('allinoneAuthChange'));
  }
  console.log('✅ [Seed] 测试数据已强制重填！');
}

// ============================================================
// 钱包余额 — 写入 CloudBase 数据库（users collection）
// ============================================================

const WALLET_SEED_KEY = '__wallet_seeded_v4';

function needsWalletSeed(): boolean {
  try {
    return sessionStorage.getItem(WALLET_SEED_KEY) !== 'true';
  } catch {
    return true;
  }
}

async function seedWalletToCloudBase(): Promise<void> {
  const walletConfig: Record<string, any> = {
    'test-001': { gameCoins: 5000, instantVouchers: 5, algorithmVouchers: 2 },
    'test-002': { gameCoins: 2000, instantVouchers: 2, algorithmVouchers: 0 },
    'test-003': { gameCoins: 50000, instantVouchers: 20, algorithmVouchers: 10 },
    'test-004': { gameCoins: 999999, instantVouchers: 100, algorithmVouchers: 50 },
  };

  // 始终写入 localStorage 作为本地回退（CloudBase 不可用时 WalletSkill 从这里读取）
  try {
    const localWallets: Record<string, any> = {};
    for (const [uid, wallet] of Object.entries(walletConfig)) {
      localWallets[uid] = { ...wallet, lastUpdated: Date.now() };
    }
    localStorage.setItem('allinone_wallets', JSON.stringify(localWallets));
    console.log('[Seed] 钱包: 4 个账号已写入 localStorage 回退');
  } catch { /* localStorage 不可用 */ }

  try {
    const { getCloudBaseApp } = await import('../services/cloudbase');
    const app = getCloudBaseApp();
    const db = app.database();

    for (const [uid, wallet] of Object.entries(walletConfig)) {
      try {
        // 检查是否已存在
        const existing = await db.collection('users').where({ _openid: uid }).limit(1).get();
        if (existing.data.length > 0) {
          // 更新
          await db.collection('users').doc(existing.data[0]._id).update({
            gameCoins: wallet.gameCoins,
            instantVouchers: wallet.instantVouchers,
            algorithmVouchers: wallet.algorithmVouchers,
            updatedAt: Date.now(),
          });
        } else {
          // 创建
          await db.collection('users').add({
            _openid: uid,
            gameCoins: wallet.gameCoins,
            instantVouchers: wallet.instantVouchers,
            algorithmVouchers: wallet.algorithmVouchers,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          });
        }
      } catch { /* best effort per user */ }
    }
    sessionStorage.setItem(WALLET_SEED_KEY, 'true');
    console.log('[Seed] 钱包: 4 个账号已写入 CloudBase');
  } catch {
    // CloudBase 不可用，但 localStorage 已写入，仍标记为已填充
    sessionStorage.setItem(WALLET_SEED_KEY, 'true');
    console.log('[Seed] 钱包: CloudBase 不可用，已使用 localStorage 回退');
  }
}

function seedWallet(): boolean {
  if (!needsWalletSeed()) { console.log('[Seed] 钱包: 已填充，跳过'); return false; }
  // 异步写入 CloudBase，不阻塞
  seedWalletToCloudBase();
  return true;
}


// ============================================================
// 平台游戏商店 (platform_game_stores)
// ============================================================

const EXT_GAME_PREFIX = 'ext-seed';

function seedPlatformGameStores(): boolean {
  const existing = getStored<any[]>('platform_game_stores');
  if (existing && existing.length > 0) { console.log('[Seed] 平台商店: 已有数据，跳过'); return false; }
  seedPlatformGameStoresForce();
  return true;
}

function seedPlatformGameStoresForce(): void {
  const now = Date.now();

  // 注册2个外部游戏
  const stores = [
    {
      id: 'pg-store-ext-seed-genshin',
      gameId: `${EXT_GAME_PREFIX}-genshin`,
      gameName: '原神',
      gameIcon: '🌊',
      developer: 'miHoYo',
      description: '开放世界冒险游戏，探索七国，收集角色',
      theme: { primaryColor: '#3b82f6', secondaryColor: '#8b5cf6' },
      isActive: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'pg-store-ext-seed-starrail',
      gameId: `${EXT_GAME_PREFIX}-starrail`,
      gameName: '崩坏：星穹铁道',
      gameIcon: '🚂',
      developer: 'miHoYo',
      description: '银河冒险RPG，搭乘星穹列车探索宇宙',
      theme: { primaryColor: '#f59e0b', secondaryColor: '#ef4444' },
      isActive: true,
      createdAt: now,
      updatedAt: now,
    },
  ];
  localStorage.setItem('platform_game_stores', JSON.stringify(stores));

  // 为外部游戏创建道具模板（复用 voucher_item_templates 存储）
  const existingTemplates = getStored<any[]>('voucher_item_templates') || [];

  const platformTemplates = [
    // 原神道具
    {
      id: 'plt-genshin-moon-card',
      gameId: `${EXT_GAME_PREFIX}-genshin`,
      gameName: '原神',
      name: '空月祝福（月卡）',
      description: '购买后立即获得300创世结晶，之后30天内每日获得90原石',
      itemType: 'consumable',
      icon: 'fa-gem',
      supplyPolicy: 'open' as const,
      mintedCount: 0,
      pricing: { price: 30, currency: 'ACOIN', acceptVoucher: true, voucherPrice: 30 },
      gameEffect: { itemId: 'moon_blessing', quantity: 1, effectType: 'currency', metadata: { daily_primogems: 90, duration_days: 30 } },
      attributes: { duration: '30天', daily: 90 },
      rarity: 'rare' as const,
      consumable: true,
      stackable: false,
      isActive: true,
      createdAt: now,
      updatedAt: now,
      createdBy: 'SYSTEM',
    },
    {
      id: 'plt-genshin-genesis-300',
      gameId: `${EXT_GAME_PREFIX}-genshin`,
      gameName: '原神',
      name: '创世结晶 ×300',
      description: '300创世结晶，可用于购买角色皮肤、祈愿等',
      itemType: 'currency',
      icon: 'fa-diamond',
      supplyPolicy: 'open' as const,
      mintedCount: 0,
      pricing: { price: 50, currency: 'ACOIN', acceptVoucher: true, voucherPrice: 50 },
      gameEffect: { itemId: 'genesis_crystal_300', quantity: 300, effectType: 'currency', metadata: {} },
      attributes: { amount: 300 },
      rarity: 'rare' as const,
      consumable: true,
      stackable: true,
      isActive: true,
      createdAt: now,
      updatedAt: now,
      createdBy: 'SYSTEM',
    },
    {
      id: 'plt-genshin-bp',
      gameId: `${EXT_GAME_PREFIX}-genshin`,
      gameName: '原神',
      name: '珍珠纪行（大月卡）',
      description: '解锁珍珠纪行高级奖励，含独家武器和大量资源',
      itemType: 'package',
      icon: 'fa-scroll',
      supplyPolicy: 'limited' as const,
      totalSupply: 30,
      mintedCount: 0,
      pricing: { price: 68, currency: 'ACOIN', acceptVoucher: true, voucherPrice: 68 },
      gameEffect: { itemId: 'battle_pass_premium', quantity: 1, effectType: 'custom', metadata: { bp_level: 50, exclusive_weapon: true } },
      attributes: { bp_level: 50, exclusive_weapon: true },
      rarity: 'legendary' as const,
      consumable: true,
      stackable: false,
      isActive: true,
      createdAt: now,
      updatedAt: now,
      createdBy: 'SYSTEM',
    },
    // 崩坏星穹铁道道具
    {
      id: 'plt-starrail-monthly',
      gameId: `${EXT_GAME_PREFIX}-starrail`,
      gameName: '崩坏：星穹铁道',
      name: '星琼月卡',
      description: '购买后立即获得300古老梦华，之后30天内每日获得90星琼',
      itemType: 'consumable',
      icon: 'fa-gem',
      supplyPolicy: 'open' as const,
      mintedCount: 0,
      pricing: { price: 30, currency: 'ACOIN', acceptVoucher: true, voucherPrice: 30 },
      gameEffect: { itemId: 'monthly_pass', quantity: 1, effectType: 'currency', metadata: { daily_jades: 90, duration_days: 30 } },
      attributes: { duration: '30天', daily: 90 },
      rarity: 'rare' as const,
      consumable: true,
      stackable: false,
      isActive: true,
      createdAt: now,
      updatedAt: now,
      createdBy: 'SYSTEM',
    },
    {
      id: 'plt-starrail-nameless-glory',
      gameId: `${EXT_GAME_PREFIX}-starrail`,
      gameName: '崩坏：星穹铁道',
      name: '无名客的荣勋（大月卡）',
      description: '解锁大月卡高级奖励，含专属光锥和大量养成材料',
      itemType: 'package',
      icon: 'fa-scroll',
      supplyPolicy: 'limited' as const,
      totalSupply: 20,
      mintedCount: 0,
      pricing: { price: 68, currency: 'ACOIN', acceptVoucher: true, voucherPrice: 68 },
      gameEffect: { itemId: 'nameless_glory_premium', quantity: 1, effectType: 'custom', metadata: { bp_level: 50, exclusive_lightcone: true } },
      attributes: { bp_level: 50, exclusive_lightcone: true },
      rarity: 'legendary' as const,
      consumable: true,
      stackable: false,
      isActive: true,
      createdAt: now,
      updatedAt: now,
      createdBy: 'SYSTEM',
    },
    {
      id: 'plt-starrail-jade-300',
      gameId: `${EXT_GAME_PREFIX}-starrail`,
      gameName: '崩坏：星穹铁道',
      name: '古老梦华 ×300',
      description: '300古老梦华，可用于跃迁（抽卡）',
      itemType: 'currency',
      icon: 'fa-diamond',
      supplyPolicy: 'open' as const,
      mintedCount: 0,
      pricing: { price: 50, currency: 'ACOIN', acceptVoucher: true, voucherPrice: 50 },
      gameEffect: { itemId: 'stellar_jade_300', quantity: 300, effectType: 'currency', metadata: {} },
      attributes: { amount: 300 },
      rarity: 'uncommon' as const,
      consumable: true,
      stackable: true,
      isActive: true,
      createdAt: now,
      updatedAt: now,
      createdBy: 'SYSTEM',
    },
  ];

  const merged = [...existingTemplates, ...platformTemplates];
  localStorage.setItem('voucher_item_templates', JSON.stringify(merged));

  // 铸造初始凭证库存 (平台池)
  // 先清除旧的平台商店凭证，再写入新的（避免累积）
  const existingVouchers = getStored<any[]>('allinone_vouchers') || [];
  const filteredVouchers = existingVouchers.filter(
    v => !(v.id && v.id.startsWith('v-plt-'))
  );
  const mintedVouchers: any[] = [];

  const mintConfigs = [
    { templateId: 'plt-genshin-moon-card', count: 20 },
    { templateId: 'plt-genshin-genesis-300', count: 20 },
    { templateId: 'plt-genshin-bp', count: 15 },
    { templateId: 'plt-starrail-monthly', count: 20 },
    { templateId: 'plt-starrail-nameless-glory', count: 10 },
    { templateId: 'plt-starrail-jade-300', count: 15 },
  ];

  let serialNum = 1000;
  for (const mc of mintConfigs) {
    const tpl = platformTemplates.find(t => t.id === mc.templateId);
    if (!tpl) continue;
    for (let i = 0; i < mc.count; i++) {
      serialNum++;
      mintedVouchers.push({
        id: `v-plt-${tpl.id}-${i}`,
        serialNumber: `IV-${String(serialNum).padStart(6, '0')}`,
        denomination: tpl.pricing.price,
        currentHolderId: 'platform_pool',
        currentHolderName: '平台总账户',
        status: 'active',
        createdAt: now,
        createdBy: 'SYSTEM',
        createdByName: '道具凭证系统',
        transferCount: 0,
        sourceType: 'item',
        metadata: {
          sourceType: 'item',
          name: tpl.name,
          description: tpl.description,
          category: 'item',
          tags: ['item_voucher', tpl.gameId, tpl.itemType],
          issuer: tpl.gameId,
          customData: {
            itemTemplateId: tpl.id,
            gameId: tpl.gameId,
            gameEffect: tpl.gameEffect,
            itemType: tpl.itemType,
            rarity: tpl.rarity,
            attributes: tpl.attributes,
            consumable: tpl.consumable,
            stackable: tpl.stackable,
            supplyPolicy: tpl.supplyPolicy,
            totalSupply: tpl.totalSupply,
          },
          symbol: 'ITEM',
        },
      });
    }
  }

  const allVouchers = [...filteredVouchers, ...mintedVouchers];
  localStorage.setItem('allinone_vouchers', JSON.stringify(allVouchers));

  console.log(`[Seed] 平台商店: ${stores.length} 个游戏 | ${platformTemplates.length} 个道具模板 | ${mintedVouchers.length} 张凭证`);
}

// ============================================================
// 工具函数
// ============================================================

function getStored<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) as T : null;
  } catch {
    return null;
  }
}

// ============================================================
// 挂载到 window + 启动时自动填充
// ============================================================

if (typeof window !== 'undefined') {
  // 公开 API
  (window as any).__seedAll = (force?: boolean) => force ? seedAllForce() : seedAll();
  (window as any).__seedAllForce = seedAllForce;

  /** 诊断：查看当前 localStorage 种子数据 */
  (window as any).__seedDiag = () => {
    const keys = [
      'wallet_v2',
      'allinone_published_games',
      'voucher_item_templates',
      'voucher_item_purchases',
      'allinone_redeem_items',
      'allinone_redeem_codes',
      'allinone_vouchers',
      'platform_game_stores',
    ];
    console.group('🔍 [Seed Diag] localStorage 种子数据');
    for (const key of keys) {
      try {
        const raw = localStorage.getItem(key);
        if (!raw) {
          console.log(`❌ ${key}: 不存在`);
        } else {
          const data = JSON.parse(raw);
          if (Array.isArray(data)) {
            console.log(`✅ ${key}: 数组[${data.length}]`, key === 'wallet_v2' ? Object.keys(data) : data.slice(0, 3));
          } else if (typeof data === 'object') {
            console.log(`✅ ${key}: 对象`, Object.keys(data));
          } else {
            console.log(`✅ ${key}: ${typeof data}`);
          }
        }
      } catch (e) {
        console.log(`⚠️ ${key}: 解析失败`, e);
      }
    }
    console.groupEnd();
  };

  // 自动检测并填充（使用 setImmediate/setTimeout 确保在 React 挂载前执行）
  const autoSeed = () => {
    try {
      const walletSeeded = sessionStorage.getItem(WALLET_SEED_KEY) === 'true';
      const games = localStorage.getItem('allinone_published_games');
      const platformStores = localStorage.getItem('platform_game_stores');
      const hasGameData = games && games !== '[]' && games !== 'null';
      const hasPlatformStoreData = platformStores && platformStores !== '[]' && platformStores !== 'null';

      console.log(`[Seed] 启动检测: wallet=${walletSeeded ? '已填充' : '未填充'}, games=${hasGameData ? '有数据' : '无数据'}, platformStores=${hasPlatformStoreData ? '有数据' : '无数据'}`);

      if (!walletSeeded || !hasGameData) {
        console.log('🔄 [Seed] 检测到数据缺失，正在自动填充测试数据...');
        seedAll();
      } else {
        // 检查平台游戏商店数据是否存在（新功能增量填充）
        if (!hasPlatformStoreData) {
          console.log('🔄 [Seed] 检测到平台商店数据缺失，正在补填...');
          seedPlatformGameStores();
        }
      }
    } catch (e) {
      console.warn('[Seed] 自动检测异常:', e);
    }
  };

  // 立即执行 + 延迟兜底（确保 localStorage 可读写）
  autoSeed();
  setTimeout(autoSeed, 100);
  setTimeout(autoSeed, 1000);
}
