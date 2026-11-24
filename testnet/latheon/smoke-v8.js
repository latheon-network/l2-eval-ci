'use strict';
/*
 * Smoke test of the deployed V8 native-coin contracts (withdraw_v6) with real proofs:
 *   router deposit of 12 LTH = one note of 10 and two of 1
 *   → one 1-LTH note withdrawn on its own, directly from the pool, to an empty address
 *   → withdrawMany of all three notes to a NEW, EMPTY address with a relayer fee of 0.1 LTH per note and a payment
 *     reference per note bound into the proofs: the note already withdrawn is skipped (NoteSkipped), the other two are
 *     paid; the address receives exactly 10.8 LTH and the relayer exactly 0.2
 *   → a router deposit of 999 LTH (23 notes) for gas on the real chain
 *   → the router holds nothing, every pool holds at least denomination × (deposits − withdrawals);
 *     a disclose_v2 proof and a disclose_link proof (its nullifier equals the withdrawal's) verify on chain.
 *
 *   L3_RPC=http://127.0.0.1:8449 node smoke-v8.js      (needs OUT_DIR/latheon-deployments-v8.json from deploy-v8)
 *
 * The test notes and the recipient's key stay in STATE_DIR (private); OUT_DIR/latheon-smoke-v8.json holds only public data.
 */
const path = require('path');
const crypto = require('crypto');
const { ethers, ART, E18, STATE_DIR, OUT_DIR, rnd, log, die, retry, connect, loadJson, saveJson } = require('./lib');
const { commitmentV8, extTupleV8, withdrawProofV8, discloseV2Proof, discloseLinkProof } = require('./zk');

async function main() {
  const v8 = loadJson(path.join(OUT_DIR, 'latheon-deployments-v8.json'), null);
  if (!v8) die('run deploy-v8 first');
  const { provider, wallet, chainId } = await connect();
  if (chainId !== v8.network.chainId) die(`RPC chain ${chainId} is not the deployed chain ${v8.network.chainId}`);
  const C = ART.contracts;
  const dpools = v8.pools, router = v8.routers[0].address, pools = dpools.map((p) => p.address);
  const R = new ethers.Contract(router, C.RouterV8Native.abi, wallet);
  const P = pools.map((a) => new ethers.Contract(a, C.PoolV8Native.abi, wallet));
  const result = { chainId, started: new Date().toISOString(), steps: {} };
  const step = async (name, send) => {
    const tx = await retry(send, name);
    const rc = await retry(() => tx.wait(), 'receipt');
    if (rc.status !== 1) die(name + ': reverted');
    const raw = await retry(() => provider.send('eth_getTransactionReceipt', [rc.hash]), 'raw receipt').catch(() => null);
    const l1 = raw && raw.gasUsedForL1 !== undefined ? BigInt(raw.gasUsedForL1) : null;
    const price = raw && raw.effectiveGasPrice ? BigInt(raw.effectiveGasPrice) : rc.gasPrice;
    result.steps[name] = { tx: rc.hash, block: rc.blockNumber, gasUsed: rc.gasUsed.toString(),
      ...(l1 !== null && { gasUsedForL1: l1.toString(), gasUsedExecution: (rc.gasUsed - l1).toString() }),
      ...(price && { effectiveGasPrice: price.toString(), feeLTH: ethers.formatEther(rc.gasUsed * price) }) };
    log(`   ✔ ${name}: gas ${rc.gasUsed}${l1 !== null ? ` (execution ${rc.gasUsed - l1}, parent-chain data ${l1})` : ''}${price ? `, fee ${ethers.formatEther(rc.gasUsed * price)} LTH` : ''}  ${v8.network.explorerUrl}/tx/${rc.hash}`);
    return rc;
  };
  const ok = (cond, what) => { if (!cond) die('check failed: ' + what); log('   ✔ ' + what); result.steps[what] = true; };
  const ref = () => ethers.hexlify(crypto.randomBytes(32));

  log('1. Deposit 12 LTH through the router (one note of 10, two of 1)');
  const notes = [{ sk: rnd(), vk: rnd() }, { sk: rnd(), vk: rnd() }, { sk: rnd(), vk: rnd() }];
  const recipient = ethers.Wallet.createRandom(), early = ethers.Wallet.createRandom();
  saveJson(path.join(STATE_DIR, 'latheon-smoke-v8-notes.json'), { notes: notes.map((n) => ({ sk: n.sk.toString(), vk: n.vk.toString() })), recipientKey: recipient.privateKey, earlyKey: early.privateKey });
  const amount = 12n * E18;
  const rc = await step('router deposit 12 LTH (3 notes)', () => R.deposit(amount, notes.map((n) => commitmentV8(n.sk, n.vk)), { value: amount }));
  for (const n of notes) {
    const c = commitmentV8(n.sk, n.vk);
    for (const lg of rc.logs) {
      const i = pools.findIndex((a) => a.toLowerCase() === lg.address.toLowerCase());
      if (i < 0) continue;
      const ev = P[i].interface.parseLog(lg);
      if (ev && ev.name === 'Deposit' && ev.args.commitment === c) { n.pool = i; n.leaf = Number(ev.args.leafIndex); }
    }
  }
  ok(notes[0].pool === 2 && notes[1].pool === 3 && notes[2].pool === 3, 'notes landed in the 10 pool and twice in the 1 pool');
  ok((await provider.getBalance(router)) === 0n, 'router holds no LTH after the deposit');

  const proofFor = async (n, ext) => {
    const pool = P[n.pool];
    const next = Number(await pool.nextIndex());
    const logs = await retry(() => pool.queryFilter(pool.filters.Deposit(), dpools[n.pool].deployBlock), 'logs');
    const leaves = new Array(next).fill(null);
    for (const l of logs) leaves[Number(l.args.leafIndex)] = l.args.commitment;
    if (leaves.some((x) => x === null)) die('could not rebuild the tree of pool ' + n.pool);
    const zeros = []; for (let l = 0; l < 20; l++) zeros.push(await pool.zeros(l));
    const p = await withdrawProofV8({ sk: n.sk, vk: n.vk, leaf: n.leaf, leaves, zeros, ctx: await pool.ctx(), ext });
    if (!(await pool.isKnownRoot(p.root))) die('the proof root is not known to pool ' + n.pool);
    return p;
  };

  log('2. One 1-LTH note withdrawn on its own, directly from the pool, to an empty address');
  const extEarly = { recipient: early.address, relayer: ethers.ZeroAddress, fee: 0n, paymentRef: ref(), destChainId: BigInt(chainId) };
  const pe = await proofFor(notes[2], extEarly);
  await step('pool withdraw 1 note', () => P[3].withdraw(pe.proof, pe.root, pe.nullifierHash, extTupleV8(extEarly)));
  ok((await provider.getBalance(early.address)) === E18, 'the empty address received exactly 1 LTH');

  log('3. withdrawMany of all three notes, fee 0.1 LTH and a payment reference per note bound into the proofs');
  const feeTo = ethers.Wallet.createRandom().address, FEE = E18 / 10n;
  ok((await provider.getBalance(recipient.address)) === 0n, 'recipient ' + recipient.address + ' starts with 0 LTH');
  const items = [];
  for (const n of notes) {
    const ext = { recipient: recipient.address, relayer: feeTo, fee: FEE, paymentRef: ref(), destChainId: BigInt(chainId) };
    const p = await proofFor(n, ext);
    items.push([n.pool, p.proof, p.root, p.nullifierHash, FEE, ext.paymentRef]);
  }
  let refused = false; try { await R.withdrawMany.staticCall(items, recipient.address, ethers.Wallet.createRandom().address); } catch (e) { refused = true; }
  ok(refused, 'the same batch naming another relayer is refused (the fee recipient is in the proofs)');
  const badRef = items.map((x) => x.slice()); badRef[0][5] = ref();
  refused = false; try { await R.withdrawMany.staticCall(badRef, recipient.address, feeTo); } catch (e) { refused = true; }
  ok(refused, 'the same batch with one payment reference changed is refused');
  const paid = await R.withdrawMany.staticCall(items, recipient.address, feeTo);
  ok(paid === 2n, 'withdrawMany would pay 2 notes and skip the one already withdrawn');
  const rcM = await step('withdrawMany 3 notes (1 skipped) with fees', () => R.withdrawMany(items, recipient.address, feeTo));
  const skipped = rcM.logs.map((l) => { try { return R.interface.parseLog(l); } catch { return null; } }).filter((e) => e && e.name === 'NoteSkipped');
  ok(skipped.length === 1 && skipped[0].args.nullifierHash === BigInt(pe.nullifierHash), 'one NoteSkipped event, for the note withdrawn in step 2');
  ok((await provider.getBalance(recipient.address)) === 11n * E18 - 2n * FEE, 'the empty address received exactly 10.8 LTH, usable as gas');
  ok((await provider.getBalance(feeTo)) === 2n * FEE, 'the relayer named in the proofs received exactly 0.2 LTH');

  log('3b. A large router deposit: 999 LTH = 23 notes (gas on the real chain)');
  const big = Array.from({ length: 23 }, () => commitmentV8(rnd(), rnd()));
  await step('router deposit 999 LTH (23 notes)', () => R.deposit(999n * E18, big, { value: 999n * E18 }));

  log('4. Invariants and disclosure');
  ok((await provider.getBalance(router)) === 0n, 'router holds no LTH');
  for (let i = 0; i < 4; i++) {
    const d = await P[i].DENOMINATION(), n = BigInt(await P[i].nextIndex());
    const w = BigInt((await retry(() => P[i].queryFilter(P[i].filters.Withdrawal(), dpools[i].deployBlock), 'logs')).length);
    ok((await provider.getBalance(pools[i])) >= d * (n - w), `pool ${dpools[i].amount}: holds at least denomination × (deposits − withdrawals)`);
  }
  const nonce = rnd();
  const d2 = await discloseV2Proof({ sk: notes[0].sk, vk: notes[0].vk, nonce });
  const DV = new ethers.Contract(v8.verifiers.disclose, C.DiscloseVerifierV2.abi, provider);
  ok(await DV.verifyProof(d2.pA, d2.pB, d2.pC, d2.pub) && BigInt(d2.pub[0]) === commitmentV8(notes[0].sk, notes[0].vk), 'disclose_v2: proof for the deposited 10-LTH note verifies on chain');
  const dl = await discloseLinkProof({ sk: notes[0].sk, vk: notes[0].vk, ctx: await P[2].ctx(), nonce });
  const DL = new ethers.Contract(v8.verifiers.discloseLink, C.DiscloseLinkVerifier.abi, provider);
  const wEv = (await P[2].queryFilter(P[2].filters.Withdrawal(), rcM.blockNumber, rcM.blockNumber)).map((e) => e.args.nullifierHash);
  ok(await DL.verifyProof(dl.pA, dl.pB, dl.pC, dl.pub) && wEv.includes(BigInt(dl.pub[1])), 'disclose_link: proof verifies on chain and its nullifier is the one in the 10 pool\'s Withdrawal event (a receipt)');

  result.finished = new Date().toISOString();
  const out = path.join(OUT_DIR, 'latheon-smoke-v8.json');
  saveJson(out, result);
  log('All checks passed. Written ' + out);
}

main().then(() => process.exit(0)).catch((e) => die((e && (e.shortMessage || e.message)) || String(e)));
