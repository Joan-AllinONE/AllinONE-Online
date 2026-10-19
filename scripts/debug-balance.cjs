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
  const token = signToken({ userId: 'u_init', role: 'player', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 });
  const r = await (await fetch(BASE + '/api/v1/games/__wallet/platform/balance', { headers: { Authorization: 'Bearer ' + token } })).json();
  console.log('u_init balance:', JSON.stringify(r.data && r.data.balance));
  const t = await (await fetch(BASE + '/api/v1/games/__wallet/platform/transactions?limit=12', { headers: { Authorization: 'Bearer ' + token } })).json();
  for (const tx of ((t.data || {}).transactions || [])) {
    console.log(`${tx.timestamp} ${String(tx.type).padEnd(7)} ${String(tx.amount).padStart(6)}  after=${String(tx.balanceAfter).padStart(6)}  txId=${tx.txId || '(none)'}  ${tx.description || ''}`);
  }
}
main().catch((e) => console.error(e.message));
