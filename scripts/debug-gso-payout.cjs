'use strict';
const BASE = 'http://localhost:3000';
function signToken(payload) {
  const crypto = require('crypto');
  const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const header = b64u({ alg: 'HS256', typ: 'JWT' });
  const body = b64u(payload);
  const sig = crypto.createHmac('sha256', 'dev-secret-do-not-use-in-prod-change-me').update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}
async function main() {
  for (const u of ['u_a', 'u_b', 'system-platform']) {
    const token = signToken({ userId: u, role: 'player', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 });
    const r = await (await fetch(BASE + '/api/v1/games/__wallet/platform/balance', { headers: { Authorization: 'Bearer ' + token } })).json();
    const t = await (await fetch(BASE + '/api/v1/games/__wallet/platform/transactions?limit=6', { headers: { Authorization: 'Bearer ' + token } })).json();
    console.log(`== ${u} balance=${r.data?.balance?.gameCoins}`);
    for (const tx of ((t.data || {}).transactions || []).slice(0, 4)) {
      console.log(`   ${tx.timestamp} ${tx.type} ${tx.amount} after=${tx.balanceAfter} ${String(tx.txId || '').slice(-40)}`);
    }
  }
}
main().catch((e) => console.error(e.message));
