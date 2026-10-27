'use strict';
/*
 * Deploys the V7 contracts next to the older sets already on the Latheon test chain, checks every link, and adds them to
 * the public deployment entry. V7 = 20-level trees (1,048,576 deposits per pool instead of 256), 100 kept roots
 * instead of 30, and the relayer fee bound into the proof (circuit withdraw_v5).
 *   WithdrawVerifierV5, four LatheonShieldedPoolV7Native pools (100 / 50 / 10 / 1 LTH), LatheonDistributionPoolV7Native.
 *   The PoseidonT3 library and the disclosure verifier of the V5 deployment are reused (unchanged contracts).
 * Checks: each pool's native marker / verifier / denomination / LEVELS 20 / ROOT_HISTORY_SIZE 100 / zeros(20) (Poseidon
 * linked correctly); router pools / denominations / limits; a real withdraw_v5 proof accepted by the verifier and the
 * same proof refused for another recipient, another relayer and another fee (read-only calls).
 *
 *   L3_RPC=http://127.0.0.1:8449 node deploy-v7.js      (asks for the deployer key without echo, or DEPLOYER_KEY)
 *   needs OUT_DIR/latheon-deployments.json from deploy.js (the V5 set); option --fresh
 *
 * Re-runnable: finished deployments are kept in STATE_DIR/latheon-deploy-v7.json and reused.
 * Public result: OUT_DIR/latheon-deployments.json with the V7 pools and router listed first (the V5 ones stay, so notes
 * made in them can still be withdrawn).
 */
const path = require('path');
const { ethers, ART, E18, DENOMS, STATE_DIR, OUT_DIR, rnd, log, die, retry, connect, loadJson, saveJson } = require('./lib');
const { commitmentOf, withdrawProof } = require('./zk');

const FRESH = process.argv.includes('--fresh');
const LEVELS6 = 20;

function linkV7(poseidon) {
  const c = ART.contracts.PoolV7Native;
  let code = c.bytecode;
  for (const f in c.linkReferences) for (const l in c.linkReferences[f]) for (const { start, length } of c.linkReferences[f][l])
    code = code.slice(0, 2 + start * 2) + poseidon.slice(2).toLowerCase() + code.slice(2 + start * 2 + length * 2);
  if (/__\$/.test(code)) die('pool bytecode still has an unlinked library placeholder');
  return code;
}

async function main() {
  const outPath = path.join(OUT_DIR, 'latheon-deployments.json');
  const dep = loadJson(outPath, null);
  if (!dep) die('run deploy.js first (the V5 set and its public entry are needed)');
  const C = ART.contracts;
  if (!C.PoolV7Native || !C.RouterV7Native || !C.WithdrawVerifierV5) die('these artifacts have no V7 contracts: rebuild with build.js from a Latheon commit that has them');
  const { provider, wallet, me, chainId } = await connect();
  if (chainId !== dep.network.chainId) die(`RPC chain ${chainId} is not the deployed chain ${dep.network.chainId}`);
  log(`Chain ${chainId}, deployer ${me}, balance ${ethers.formatEther(await retry(() => provider.getBalance(me), 'balance'))} LTH`);
  const poseidon = (dep.network.poseidonDeployedThisRelease || [])[0];
  if (!poseidon || (await provider.getCode(poseidon)) === '0x') die('PoseidonT3 of the V5 deployment not found');

  const statePath = path.join(STATE_DIR, 'latheon-deploy-v7.json');
  let st = FRESH ? null : loadJson(statePath, null);
  if (st && (st.chainId !== chainId || st.deployer !== me || st.commit !== ART.source.commit)) die(statePath + ' belongs to another chain, deployer or build; run with --fresh');
  if (!st) st = { chainId, deployer: me, commit: ART.source.commit, addr: {}, tx: {} };
  const save = () => saveJson(statePath, st);
  save();

  async function deploy(name, c, args, code) {
    if (st.addr[name] && (await retry(() => provider.getCode(st.addr[name]), 'code')) !== '0x') { log(`   ${name}: ${st.addr[name]} (already deployed)`); return st.addr[name]; }
    const f = new ethers.ContractFactory(c.abi, code || c.bytecode, wallet);
    const x = await retry(() => f.deploy(...args), 'deploy ' + name);
    const rc = await retry(() => x.deploymentTransaction().wait(), 'receipt ' + name);
    if (rc.status !== 1) die(name + ': deployment reverted');
    st.addr[name] = rc.contractAddress; st.tx[name] = { hash: rc.hash, block: rc.blockNumber, gasUsed: rc.gasUsed.toString() }; save();
    log(`   ${name}: ${rc.contractAddress}  (block ${rc.blockNumber}, gas ${rc.gasUsed})`);
    return rc.contractAddress;
  }

  log('1. Deploy V7');
  const verifier = await deploy('WithdrawVerifierV5', C.WithdrawVerifierV5, []);
  const code = linkV7(poseidon);
  const pools = [];
  for (const d of DENOMS) pools.push(await deploy('PoolV7_' + d / E18, C.PoolV7Native, [verifier, d], code));
  const router = await deploy('RouterV7', C.RouterV7Native, [pools]);

  log('2. Checks');
  const ok = (cond, what) => { if (!cond) die('check failed: ' + what); log('   ✔ ' + what); };
  let zc = 0n; const { poseidon2 } = require('poseidon-lite'); for (let i = 0; i < LEVELS6; i++) zc = poseidon2([zc, zc]);
  for (let i = 0; i < 4; i++) {
    const P = new ethers.Contract(pools[i], C.PoolV7Native.abi, provider);
    const [tok, ver, den, lv, rh, z20] = await Promise.all([P.token(), P.verifier(), P.DENOMINATION(), P.LEVELS(), P.ROOT_HISTORY_SIZE(), P.zeros(LEVELS6)]);
    ok(tok === ethers.ZeroAddress && ver === verifier && den === DENOMS[i] && lv === 20n && rh === 100n && z20 === zc,
      `pool ${DENOMS[i] / E18}: native coin, verifier, denomination, 20 levels, 100 roots, zeros(20) (Poseidon linked correctly)`);
  }
  const R = new ethers.Contract(router, C.RouterV7Native.abi, provider);
  ok((await R.token()) === ethers.ZeroAddress, 'router: native coin');
  for (let i = 0; i < 4; i++) ok((await R.pools(i)) === pools[i] && (await R.denominations(i)) === DENOMS[i], `router: pool ${i} and denomination ${DENOMS[i] / E18}`);
  ok((await R.MAX_NOTES()) === 32n && (await R.MAX_WITHDRAWALS()) === 16n, 'router: limits 32 notes per deposit, 16 per withdrawMany');

  const sk = rnd(), vk = rnd(), relayer = ethers.Wallet.createRandom().address, fee = E18 / 10n;
  const P0 = new ethers.Contract(pools[0], C.PoolV7Native.abi, provider);
  const zeros = []; for (let l = 0; l < LEVELS6; l++) zeros.push(await P0.zeros(l));
  const wp = await withdrawProof({ sk, vk, leaf: 0, leaves: [commitmentOf(sk, vk)], zeros, recipient: me, v7: true, relayer, fee });
  const V = new ethers.Contract(verifier, C.WithdrawVerifierV5.abi, provider);
  ok(await V.verifyProof(wp.pA, wp.pB, wp.pC, wp.pub), 'withdraw verifier V5 accepts a real withdraw_v5 proof (with a relayer and a fee)');
  for (const [i, what, v] of [[2, 'recipient', BigInt(ethers.Wallet.createRandom().address)], [3, 'relayer', BigInt(ethers.Wallet.createRandom().address)], [4, 'fee', fee * 2n]]) {
    const bad = [...wp.pub]; bad[i] = v.toString();
    ok(!(await V.verifyProof(wp.pA, wp.pB, wp.pC, bad)), `… and rejects it for another ${what}`);
  }

  log('3. Public deployment entry (V7 listed first, V5 kept)');
  const id = dep.network.id || 'latheon-testnet';
  dep.network.v7Verifier = verifier;
  const v7pools = DENOMS.map((d, i) => ({ id: `${id}:LTH-${d / E18}:v7`, network: id, version: 'v7-native', token: 'LTH', amount: Number(d / E18), address: pools[i], deployBlock: st.tx['PoolV7_' + d / E18].block }));
  const v7router = { id: `${id}:LTH:v7`, network: id, token: 'LTH', native: true, version: 'v7', address: router, deployBlock: st.tx.RouterV7.block };
  dep.pools = v7pools.concat(dep.pools.filter((p) => p.version !== 'v7-native'));
  dep.routers = [v7router].concat((dep.routers || []).filter((r) => r.version !== 'v7'));
  dep.buildV7 = { compiler: ART.compiler, settings: ART.settings, latheonCommit: ART.source.commit };
  dep.deployTxV7 = st.tx;
  saveJson(outPath, dep);
  log('Written ' + outPath);
}

main().then(() => process.exit(0)).catch((e) => die((e && (e.shortMessage || e.message)) || String(e)));
