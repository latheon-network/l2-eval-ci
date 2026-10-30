'use strict';
/*
 * Marks every pool and router of a generation before V7 in latheon/out/latheon-deployments.json as frozen and forgeable,
 * the same flags as demo/deployments.json in the Latheon repository. Those pools carry the pre-V7 circuit flaw
 * (withdrawal without a deposit, THREAT-MODEL 8.0): services that read this file (relayer, bot, status, load test) treat
 * them as retired. No keys, no network: ./latheon-cmd.sh mark-legacy   (deploy-v7 does it too).
 */
const fs = require('fs'), path = require('path');
const CURRENT = new Set(['v7-native', 'v7']);
function markLegacy(dep) {
  let n = 0;
  for (const p of dep.pools || []) if (!CURRENT.has(p.version)) { if (!p.frozen || !p.forgeable) n++; p.frozen = true; p.forgeable = true; }
  for (const r of dep.routers || []) if (!CURRENT.has(r.version)) { if (!r.frozen || !r.forgeable) n++; r.frozen = true; r.forgeable = true; }
  return n;
}
module.exports = { markLegacy };
if (require.main === module) {
  const file = process.env.LATHEON_JSON || path.join(__dirname, 'out', 'latheon-deployments.json');
  const dep = JSON.parse(fs.readFileSync(file, 'utf8'));
  const n = markLegacy(dep);
  fs.writeFileSync(file, JSON.stringify(dep, null, 1) + '\n');
  const left = (dep.pools || []).filter((p) => !p.frozen).map((p) => p.version + ' ' + p.address);
  console.log(`${file}: ${n} entr${n === 1 ? 'y' : 'ies'} newly marked frozen and forgeable; pools still open: ${left.length ? left.join(', ') : 'none'}`);
}
