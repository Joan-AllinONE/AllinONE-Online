/**
 * CloudBase 数据库初始化脚本
 * 
 * 创建所有 8 个集合 + 安全规则 + 索引
 * 
 * 环境变量:
 *   TCB_ENV_ID   = allinonegaming-d4gmsmrzz573264f6
 *   TCB_SECRET_ID  = 腾讯云 SecretId
 *   TCB_SECRET_KEY = 腾讯云 SecretKey
 * 
 * 运行: node cloudfunctions/db_init/init.cjs
 */

const cloudbase = require('@cloudbase/node-sdk');

const ENV_ID = process.env.TCB_ENV_ID || 'allinonegaming-d4gmsmrzz573264f6';
const SECRET_ID = process.env.TCB_SECRET_ID;
const SECRET_KEY = process.env.TCB_SECRET_KEY;

if (!SECRET_ID || !SECRET_KEY) {
  console.error('请设置环境变量: TCB_SECRET_ID 和 TCB_SECRET_KEY');
  console.error('   可从 https://console.cloud.tencent.com/cam/capi 获取');
  process.exit(1);
}

// 初始化 CloudBase Admin SDK
const app = cloudbase.init({
  env: ENV_ID,
  secretId: SECRET_ID,
  secretKey: SECRET_KEY,
});

const db = app.database();

// ==================== 集合定义 ====================

const collections = [
  {
    name: 'users',
    description: '用户资料（余额 + 角色）',
    indexes: [
      { keys: { _openid: 1 }, unique: true },
      { keys: { email: 1 }, unique: true },
    ],
  },
  {
    name: 'transactions',
    description: '交易流水',
    indexes: [
      { keys: { userId: 1, timestamp: -1 } },
      { keys: { currency: 1 } },
    ],
  },
  {
    name: 'voucher_templates',
    description: '凭证模板',
    indexes: [
      { keys: { gameId: 1 } },
      { keys: { isActive: 1 } },
    ],
  },
  {
    name: 'vouchers',
    description: '凭证实例',
    indexes: [
      { keys: { templateId: 1 } },
      { keys: { holderId: 1 } },
      { keys: { status: 1 } },
    ],
  },
  {
    name: 'purchases',
    description: '购买记录',
    indexes: [
      { keys: { userId: 1, paidAt: -1 } },
      { keys: { redeemCode: 1 }, unique: true },
    ],
  },
  {
    name: 'proposals',
    description: '治理提案',
    indexes: [
      { keys: { gameId: 1, status: 1 } },
      { keys: { status: 1, votingEndAt: 1 } },
    ],
  },
  {
    name: 'inventories',
    description: '道具库存',
    indexes: [
      { keys: { userId: 1, gameId: 1 } },
      { keys: { syncStatus: 1 } },
    ],
  },
  {
    name: 'game_connectors',
    description: '游戏连接器配置',
    indexes: [
      { keys: { gameId: 1 }, unique: true },
      { keys: { isActive: 1 } },
    ],
  },
  {
    name: 'redeem_codes',
    description: '兑换码数据',
    indexes: [
      { keys: { code: 1 }, unique: true },
      { keys: { gameId: 1, status: 1 } },
      { keys: { itemId: 1 } },
    ],
  },
  {
    name: 'game_stores',
    description: '外部游戏商店注册',
    indexes: [
      { keys: { gameId: 1 }, unique: true },
      { keys: { isActive: 1 } },
    ],
  },
  {
    name: 'market_listings',
    description: '玩家交易市场挂牌',
    indexes: [
      { keys: { voucherId: 1 } },
      { keys: { sellerId: 1, status: 1 } },
      { keys: { status: 1, listedAt: -1 } },
    ],
  },
  {
    name: 'voucher_transactions',
    description: '凭证交易记录',
    indexes: [
      { keys: { voucherId: 1, timestamp: -1 } },
      { keys: { fromUserId: 1 } },
      { keys: { toUserId: 1 } },
    ],
  },
  {
    name: 'game_developers',
    description: '游戏开发者账户',
    indexes: [
      { keys: { accountId: 1 }, unique: true },
      { keys: { gameId: 1 } },
      { keys: { publisherId: 1 } },
    ],
  },
  {
    name: 'platform_treasury',
    description: '平台金库流水',
    indexes: [
      { keys: { currency: 1, timestamp: -1 } },
      { keys: { source: 1, timestamp: -1 } },
    ],
  },
  {
    name: 'published_games',
    description: '已发布游戏记录',
    indexes: [
      { keys: { id: 1 } },
      { keys: { publisherId: 1 } },
    ],
  },
];

// ==================== 主流程 ====================

async function main() {
  console.log('\nAllinONE CloudBase 数据库初始化');
  console.log('   环境 ID: ' + ENV_ID);
  console.log('   集合数量: ' + collections.length + '\n');

  var results = [];
  var created = 0, skipped = 0, errors = 0;

  for (var i = 0; i < collections.length; i++) {
    var col = collections[i];
    try {
      // 检查集合是否已存在
      try {
        await db.collection(col.name).limit(1).get();
        results.push({ name: col.name, status: 'skip' });
        skipped++;
        console.log(col.name + ': 已存在，跳过');
        continue;
      } catch (e) {
        // 不存在 = 继续创建
      }

      // 创建集合
      const createResult = await db.createCollection(col.name);
      created++;
      console.log(col.name + ': 创建成功 - ' + col.description + ' (requestId: ' + (createResult.requestId || 'N/A') + ')');

      // 创建索引
      for (var j = 0; j < col.indexes.length; j++) {
        var idx = col.indexes[j];
        try {
          await db.collection(col.name).createIndex(idx.keys, { unique: idx.unique || false });
          var keyStr = JSON.stringify(idx.keys);
          console.log('   索引: ' + keyStr + ' ' + (idx.unique ? '(unique)' : ''));
        } catch (idxErr) {
          if (idxErr.message && idxErr.message.indexOf('already exists') >= 0) {
            console.log('   索引已存在: ' + JSON.stringify(idx.keys));
          } else {
            console.warn('   索引失败: ' + (idxErr.message || idxErr));
          }
        }
      }

    } catch (err) {
      errors++;
      results.push({ name: col.name, status: 'error' });
      console.error(col.name + ': 失败 - ' + (err.message || err));
    }
  }

  // ==================== 安全规则 ====================
  console.log('\n安全规则（请在 CloudBase 控制台手动设置）:');
  console.log('───────────────────────────────────');
  console.log('');
  console.log('users: { "read": "auth.uid == doc._openid", "write": "auth.uid == doc._openid" }');
  console.log('transactions: { "read": "auth.uid == doc.userId", "write": false }');
  console.log('voucher_templates: { "read": true, "write": "auth.uid != null" }');
  console.log('vouchers: { "read": "auth.uid == doc.holderId", "write": false }');
  console.log('purchases: { "read": "auth.uid == doc.userId", "write": false }');
  console.log('proposals: { "read": true, "write": "auth.uid != null" }');
  console.log('inventories: { "read": "auth.uid == doc.userId", "write": false }');
  console.log('game_connectors: { "read": true, "write": "auth.uid != null" }');
  console.log('redeem_codes: { "read": true, "write": "auth.uid != null" }');
  console.log('game_stores: { "read": true, "write": "auth.uid != null" }');
  console.log('market_listings: { "read": true, "write": "auth.uid != null" }');
  console.log('voucher_transactions: { "read": "auth.uid == doc.fromUserId || auth.uid == doc.toUserId", "write": false }');
  console.log('game_developers: { "read": "auth.uid == doc.publisherId", "write": false }');
  console.log('platform_treasury: { "read": false, "write": false }');
  console.log('published_games: { "read": true, "write": "auth.uid != null" }');

  // ==================== 结果汇总 ====================
  console.log('\n结果汇总:');
  console.log('   创建: ' + created + ' | 跳过: ' + skipped + ' | 失败: ' + errors);

  if (errors > 0) {
    console.log('\n部分集合创建失败');
    process.exit(1);
  }

  console.log('\n数据库初始化完成!\n');
}

main().catch(function(err) {
  console.error('初始化失败:', err.message);
  process.exit(1);
});
