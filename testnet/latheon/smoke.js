'use strict';
/*
 * Smoke test of the deployed contracts with real proofs, the same manual check run on the other testnets:
 *   wrap 11 LTH → approve router → deposit(11, 2 commitments) = one note of 10 and one of 1
 *   → withdrawMany of both notes to the deployer → unwrap → router holds nothing, WLTH stays fully backed.
 * Then a disclosure proof for one of the notes, checked against the disclosure verifier.
 *
 *   L3_RPC=http://127.0.0.1:8449 node smoke.js      (needs OUT_DIR/latheon-deployments.json from deploy.js)
 *
 * The test notes stay in STATE_DIR (private); OUT_DIR/latheon-smoke.json holds only public data.
 */
const path = require('path');
const { ethers, ART, E18, STATE_DIR, OUT_DIR, rnd, log, die, retry, connect, loadJson, saveJson } = require('./lib');
const { commitmentOf, withdrawProof, discloseProof } = require('./zk');

async function main() {
  const dep = loadJson(path.join(OUT_DIR, 'latheon-deployments.json'), null);
  if (!dep) die('run deploy.js first');
  const { provider, wallet, me, chainId } = await connect();
  if (chainId !== dep.network.chainId) die(`RPC chain ${chainId} is not the deployed chain ${dep.network.chainId}`);
  const C = ART.contracts;
  const wlth = dep.network.tokens.LTH.address, router = dep.routers[0].address, pools = dep.pools.map((p) => p.address);
  const W = new ethers.Contract(wlth, C.WrappedLTH.abi, wallet);
  const R = new ethers.Contract(router, C.Router.abi, wallet);
  const P = pools.map((a) => new ethers.Contract(a, C.Pool5.abi, provider));
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
  log('1. Wrap and deposit 11 LTH through the router');
  await step('wrap 11 LTH', () => W.deposit({ value: amount }));
  await step('approve router', () => W.approve(router, amount));
  const notes = [{ sk: rnd(), vk: rnd() }, { sk: rnd(), vk: rnd() }];   // 10 then 1: commitments grouped by pool, largest first
  const rc = await step('router deposit 11 (2 notes)', () => R.deposit(amount, notes.map((n) => commitmentOf(n.sk, n.vk))));
  saveJson(path.join(STATE_DIR, 'latheon-smoke-notes.json'), notes.map((n) => ({ sk: n.sk.toString(), vk: n.vk.toString() })));
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

  log('2. withdrawMany with real proofs');
  const items = [];
  for (const n of notes) {
    const pool = P[n.pool];
    const next = Number(await pool.nextIndex());
    const logs = await retry(() => pool.queryFilter(pool.filters.Deposit(), dep.pools[n.pool].deployBlock), 'logs');
    const leaves = new Array(next).fill(null);
    for (const l of logs) leaves[Number(l.args.leafIndex)] = l.args.commitment;
    if (leaves.some((x) => x === null)) die('could not rebuild the tree of pool ' + n.pool);
    const zeros = []; for (let l = 0; l < 8; l++) zeros.push(await pool.zeros(l));
    const p = await withdrawProof({ sk: n.sk, vk: n.vk, leaf: n.leaf, leaves, zeros, recipient: me });
    if (!(await pool.isKnownRoot(p.root))) die('the proof root is not known to pool ' + n.pool);
    items.push([n.pool, p.pA, p.pB, p.pC, p.root, p.nullifierHash]);
  }
  const before = await W.balanceOf(me);
  await step('withdrawMany 2 notes', () => R.withdrawMany(items, me));
  ok((await W.balanceOf(me)) - before === amount, 'recipient received exactly 11 WLTH');
  await step('unwrap 11 WLTH', () => W.withdraw(amount));

  log('3. Invariants and disclosure');
  ok((await W.balanceOf(router)) === 0n, 'router holds no WLTH');
  for (let i = 0; i < 4; i++) ok((await W.allowance(router, pools[i])) === 0n, `router has no allowance left to pool ${i}`);
  ok((await provider.getBalance(wlth)) === (await W.totalSupply()), 'WLTH is fully backed: native LTH in the contract = total supply');
  const dp = await discloseProof({ sk: notes[0].sk, vk: notes[0].vk, nonce: rnd() });
  const D = new ethers.Contract(dep.network.discloseVerifier, C.DiscloseVerifier.abi, provider);
  ok(await D.verifyProof(dp.pA, dp.pB, dp.pC, dp.pub), 'disclosure proof for a deposited note verifies on chain');

  result.finished = new Date().toISOString();
  const out = path.join(OUT_DIR, 'latheon-smoke.json');
  saveJson(out, result);
  log('All checks passed. Written ' + out);
}

main().then(() => process.exit(0)).catch((e) => die((e && (e.shortMessage || e.message)) || String(e)));
