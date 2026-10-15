'use strict';
/*
 * Smoke test of the deployed native-coin contracts with real proofs:
 *   router deposit of 11 LTH (msg.value) with 2 commitments = one note of 10 and one of 1
 *   → withdrawMany of both notes to a NEW, EMPTY address → it holds exactly 11 LTH (it can pay gas with them)
 *   → the router holds nothing, every pool holds exactly denomination × (deposits − withdrawals).
 * Then a disclosure proof for one of the notes, checked against the disclosure verifier.
 *
 *   L3_RPC=http://127.0.0.1:8449 node smoke.js      (needs OUT_DIR/latheon-deployments.json from deploy.js)
 *
 * The test notes and the recipient's key stay in STATE_DIR (private); OUT_DIR/latheon-smoke.json holds only public data.
 */
const path = require('path');
const { ethers, ART, E18, STATE_DIR, OUT_DIR, rnd, log, die, retry, connect, loadJson, saveJson } = require('./lib');
const { commitmentOf, withdrawProof, discloseProof } = require('./zk');

async function main() {
  const dep = loadJson(path.join(OUT_DIR, 'latheon-deployments.json'), null);
  if (!dep) die('run deploy.js first');
  const { provider, wallet, chainId } = await connect();
  if (chainId !== dep.network.chainId) die(`RPC chain ${chainId} is not the deployed chain ${dep.network.chainId}`);
  if (!dep.network.tokens.LTH.native) die('the deployment entry is not the native-coin set');
  const C = ART.contracts;
  const router = dep.routers[0].address, pools = dep.pools.map((p) => p.address);
  const R = new ethers.Contract(router, C.RouterNative.abi, wallet);
  const P = pools.map((a) => new ethers.Contract(a, C.PoolNative.abi, provider));
  const result = { chainId, started: new Date().toISOString(), steps: {} };
  const step = async (name, send) => {
    const tx = await retry(send, name);
    const rc = await retry(() => tx.wait(), 'receipt');
    if (rc.status !== 1) die(name + ': reverted');
    result.steps[name] = { tx: rc.hash, block: rc.blockNumber, gasUsed: rc.gasUsed.toString() };
    log(`   ✔ ${name}: gas ${rc.gasUsed}  ${dep.network.explorerUrl}/tx/${rc.hash}`);
    return rc;
  };
  const ok = (cond, what) => { if (!cond) die('check failed: ' + what); log('   ✔ ' + what); result.steps[what] = true; };

  const amount = 11n * E18;
  log('1. Deposit 11 LTH through the router (one transaction, no wrapping, no approve)');
  const notes = [{ sk: rnd(), vk: rnd() }, { sk: rnd(), vk: rnd() }];   // 10 then 1: commitments grouped by pool, largest first
  const recipient = ethers.Wallet.createRandom();
  saveJson(path.join(STATE_DIR, 'latheon-smoke-notes.json'), { notes: notes.map((n) => ({ sk: n.sk.toString(), vk: n.vk.toString() })), recipientKey: recipient.privateKey });
  const rc = await step('router deposit 11 LTH (2 notes)', () => R.deposit(amount, notes.map((n) => commitmentOf(n.sk, n.vk)), { value: amount }));
  for (const n of notes) {
    const c = commitmentOf(n.sk, n.vk);
    for (const lg of rc.logs) {
      const i = pools.findIndex((a) => a.toLowerCase() === lg.address.toLowerCase());
      if (i < 0) continue;
      const ev = P[i].interface.parseLog(lg);
      if (ev && ev.name === 'Deposit' && ev.args.commitment === c) { n.pool = i; n.leaf = Number(ev.args.leafIndex); }
    }
  }
  ok(notes[0].pool === 2 && notes[1].pool === 3, 'notes landed in the 10 and 1 pools');
  ok((await provider.getBalance(router)) === 0n, 'router holds no LTH after the deposit');

  log('2. withdrawMany with real proofs to a new, empty address');
  ok((await provider.getBalance(recipient.address)) === 0n, 'recipient ' + recipient.address + ' starts with 0 LTH');
  const items = [];
  for (const n of notes) {
    const pool = P[n.pool];
    const next = Number(await pool.nextIndex());
    const logs = await retry(() => pool.queryFilter(pool.filters.Deposit(), dep.pools[n.pool].deployBlock), 'logs');
    const leaves = new Array(next).fill(null);
    for (const l of logs) leaves[Number(l.args.leafIndex)] = l.args.commitment;
    if (leaves.some((x) => x === null)) die('could not rebuild the tree of pool ' + n.pool);
    const zeros = []; for (let l = 0; l < 8; l++) zeros.push(await pool.zeros(l));
    const p = await withdrawProof({ sk: n.sk, vk: n.vk, leaf: n.leaf, leaves, zeros, recipient: recipient.address });
    if (!(await pool.isKnownRoot(p.root))) die('the proof root is not known to pool ' + n.pool);
    items.push([n.pool, p.pA, p.pB, p.pC, p.root, p.nullifierHash]);
  }
  await step('withdrawMany 2 notes', () => R.withdrawMany(items, recipient.address));
  ok((await provider.getBalance(recipient.address)) === amount, 'the empty address received exactly 11 LTH, usable as gas');

  log('3. Invariants and disclosure');
  ok((await provider.getBalance(router)) === 0n, 'router holds no LTH');
  for (let i = 0; i < 4; i++) {
    const d = await P[i].DENOMINATION(), n = BigInt(await P[i].nextIndex());
    const w = BigInt((await retry(() => P[i].queryFilter(P[i].filters.Withdrawal(), dep.pools[i].deployBlock), 'logs')).length);
    ok((await provider.getBalance(pools[i])) >= d * (n - w), `pool ${dep.pools[i].amount}: holds at least denomination × (deposits − withdrawals)`);
  }
  const dp = await discloseProof({ sk: notes[0].sk, vk: notes[0].vk, nonce: rnd() });
  const D = new ethers.Contract(dep.network.discloseVerifier, C.DiscloseVerifier.abi, provider);
  ok(await D.verifyProof(dp.pA, dp.pB, dp.pC, dp.pub), 'disclosure proof for a deposited note verifies on chain');

  result.finished = new Date().toISOString();
  const out = path.join(OUT_DIR, 'latheon-smoke.json');
  saveJson(out, result);
  log('All checks passed. Written ' + out);
}

main().then(() => process.exit(0)).catch((e) => die((e && (e.shortMessage || e.message)) || String(e)));
