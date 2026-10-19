'use strict';
const BASE = 'http://localhost:3000';
async function main() {
  const q = await (await fetch(BASE + '/api/v1/games/__contract/query?state=active')).json();
  const c = (q.data.contracts || []).find((x) => x.templateKey === 'gso');
  if (!c) { console.log('no active gso'); return; }
  const d = (await (await fetch(BASE + '/api/v1/games/__contract/detail?id=' + c.id)).json()).data.contract;
  console.log('contract:', c.id, 'state:', c.state);
  for (const h of d.history) {
    if (h.type === 'effects-applied') {
      const desc = (h.payload.effects || []).map((e) => {
        const t = e.table ? '[' + (e.table || []).map((r) => r.userId + ':' + r.amount).join(', ') + ']' : (e.amount != null ? e.amount : '');
        return e.type + t;
      }).join(' | ');
      console.log('APPLIED  seq=' + h.seq + ' plan=' + h.payload.planId + ' :: ' + desc);
    } else if (h.type === 'effect-failed') {
      console.log('FAILED   seq=' + h.seq + ' plan=' + h.payload.planId + ' idx=' + h.payload.idx + ' :: ' + h.payload.error);
    }
  }
}
main().catch((e) => console.error(e.message));
