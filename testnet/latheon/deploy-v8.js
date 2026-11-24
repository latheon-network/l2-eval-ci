'use strict';
/*
 * Deploys the V8 contracts (latheon-network/Latheon docs/v8-design.md) on the Latheon test chain next to the older sets,
 * checks every link with read-only calls and real proofs, and writes them to OUT_DIR/latheon-deployments-v8.json.
 *   WithdrawVerifierV6, DiscloseVerifierV2, DiscloseLinkVerifier (development keys, docs/dev-ceremony-v8.md),
 *   the guardian (see below), four LatheonShieldedPoolV8Native pools (100 / 50 / 10 / 1 LTH), LatheonDistributionPoolV8Native.
 *   The PoseidonT3 library of the V5 deployment is reused (unchanged contract).
 *
 * Guardian (can pause deposits, never withdrawals, and raise the payout gas limit, never lower it):
 *   V8_GUARDIAN=timelock (default)  an OpenZeppelin TimelockController with delay V8_TIMELOCK_DELAY seconds (default
 *                                   86400 = 24 h); proposer and executor: the deployer address. One key plus a delay, not
 *                                   yet a multisig.
 *   V8_GUARDIAN=none                guardian = address(0): deposits can never be paused, the payout limit never raised.
 *
 * The V8 set is NOT added to latheon-deployments.json (which goes into the demo) until the demo, SDK and relayer support
 * V8; the public V8 entry is OUT_DIR/latheon-deployments-v8.json.
 *
 *   L3_RPC=http://127.0.0.1:8449 node deploy-v8.js      (asks for the deployer key without echo, or DEPLOYER_KEY)
 * Re-runnable: finished deployments are kept in STATE_DIR/latheon-deploy-v8.json and reused; option --fresh.
 */
const path = require('path');
const { ethers, ART, E18, DENOMS, STATE_DIR, OUT_DIR, env, rnd, log, die, retry, connect, loadJson, saveJson } = require('./lib');
const { commitmentV8, extDataHashV8, extTupleV8, withdrawProofV8, discloseV2Proof, discloseLinkProof } = require('./zk');

const FRESH = process.argv.includes('--fresh');
const LEVELS8 = 20;
const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const GUARDIAN_MODE = env('V8_GUARDIAN', 'timelock');
const DELAY = Number(env('V8_TIMELOCK_DELAY', '86400'));

function linkV8(poseidon) {
  const c = ART.contracts.PoolV8Native;
  let code = c.bytecode;
  for (const f in c.linkReferences) for (const l in c.linkReferences[f]) for (const { start, length } of c.linkReferences[f][l])
    code = code.slice(0, 2 + start * 2) + poseidon.slice(2).toLowerCase() + code.slice(2 + start * 2 + length * 2);
  if (/__\$/.test(code)) die('pool bytecode still has an unlinked library placeholder');
  return code;
}

async function main() {
  if (!['timelock', 'none'].includes(GUARDIAN_MODE)) die('V8_GUARDIAN must be timelock or none');
  if (GUARDIAN_MODE === 'timelock' && !(DELAY >= 60)) die('V8_TIMELOCK_DELAY must be at least 60 seconds');
  const dep = loadJson(path.join(OUT_DIR, 'latheon-deployments.json'), null);
  if (!dep) die('run deploy.js first (the network entry and the PoseidonT3 library are needed)');
  const C = ART.contracts;
  if (!C.PoolV8Native || !C.RouterV8Native || !C.WithdrawVerifierV6) die('these artifacts have no V8 contracts: rebuild with build.js from a Latheon commit that has them');
  const { provider, wallet, me, chainId } = await connect();
  if (chainId !== dep.network.chainId) die(`RPC chain ${chainId} is not the deployed chain ${dep.network.chainId}`);
  log(`Chain ${chainId}, deployer ${me}, balance ${ethers.formatEther(await retry(() => provider.getBalance(me), 'balance'))} LTH`);
  log(`Guardian: ${GUARDIAN_MODE === 'none' ? 'none (address 0)' : `TimelockController, delay ${DELAY} s, proposer and executor ${me}`}`);
  const poseidon = (dep.network.poseidonDeployedThisRelease || [])[0];
  if (!poseidon || (await provider.getCode(poseidon)) === '0x') die('PoseidonT3 of the V5 deployment not found');

  const statePath = path.join(STATE_DIR, 'latheon-deploy-v8.json');
  let st = FRESH ? null : loadJson(statePath, null);
  if (st && (st.chainId !== chainId || st.deployer !== me || st.commit !== ART.source.commit || st.guardianMode !== GUARDIAN_MODE || (GUARDIAN_MODE === 'timelock' && st.delay !== DELAY)))
    die(statePath + ' belongs to another chain, deployer, build or guardian setting; run with --fresh');
  if (!st) st = { chainId, deployer: me, commit: ART.source.commit, guardianMode: GUARDIAN_MODE, delay: DELAY, addr: {}, tx: {} };
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

  log('1. Deploy V8');
  const verifier = await deploy('WithdrawVerifierV6', C.WithdrawVerifierV6, []);
  const discloseV2 = await deploy('DiscloseVerifierV2', C.DiscloseVerifierV2, []);
  const discloseLink = await deploy('DiscloseLinkVerifier', C.DiscloseLinkVerifier, []);
  const guardian = GUARDIAN_MODE === 'none' ? ethers.ZeroAddress : await deploy('TimelockV8', C.TimelockV8, [DELAY, [me], [me], ethers.ZeroAddress]);
  const code = linkV8(poseidon);
  const pools = [];
  for (const d of DENOMS) pools.push(await deploy('PoolV8_' + d / E18, C.PoolV8Native, [verifier, d, guardian], code));
  const router = await deploy('RouterV8', C.RouterV8Native, [pools]);

  log('2. Checks');
  const ok = (cond, what) => { if (!cond) die('check failed: ' + what); log('   ✔ ' + what); };
  const { poseidon2 } = require('poseidon-lite');
  let zc = 0n; for (let i = 0; i < LEVELS8; i++) zc = poseidon2([zc, zc]);
  const abi = ethers.AbiCoder.defaultAbiCoder();
  for (let i = 0; i < 4; i++) {
    const Pl = new ethers.Contract(pools[i], C.PoolV8Native.abi, provider);
    const [tok, ver, den, lv, z20, g, pg, ctx, paused] = await Promise.all([Pl.token(), Pl.verifier(), Pl.DENOMINATION(), Pl.LEVELS(), Pl.zeros(LEVELS8), Pl.guardian(), Pl.payoutGas(), Pl.ctx(), Pl.depositsPaused()]);
    const wantCtx = BigInt(ethers.keccak256(abi.encode(['string', 'uint256', 'address'], ['latheon.v8.ctx', chainId, pools[i]]))) % P;
    ok(tok === ethers.ZeroAddress && ver === verifier && den === DENOMS[i] && lv === 20n && z20 === zc && g === guardian && pg === 100000n && ctx === wantCtx && paused === false,
      `pool ${DENOMS[i] / E18}: native coin, verifier, denomination, 20 levels, zeros(20) (Poseidon linked), guardian, payout gas 100,000, ctx, deposits open`);
    ok(await Pl.isKnownRoot(zc), `pool ${DENOMS[i] / E18}: the empty tree's root is known`);
  }
  if (GUARDIAN_MODE === 'timelock') {
    const T = new ethers.Contract(guardian, C.TimelockV8.abi, provider);
    const [delay, PROP, EXEC, ADMIN] = [await T.getMinDelay(), await T.PROPOSER_ROLE(), await T.EXECUTOR_ROLE(), await T.DEFAULT_ADMIN_ROLE()];
    ok(delay === BigInt(DELAY) && (await T.hasRole(PROP, me)) && (await T.hasRole(EXEC, me)) && !(await T.hasRole(ADMIN, me)),
      `timelock: delay ${DELAY} s, deployer is proposer and executor, nobody holds the admin role but the timelock itself`);
  }
  const R = new ethers.Contract(router, C.RouterV8Native.abi, provider);
  ok((await R.token()) === ethers.ZeroAddress, 'router: native coin');
  for (let i = 0; i < 4; i++) ok((await R.pools(i)) === pools[i] && (await R.denominations(i)) === DENOMS[i], `router: pool ${i} and denomination ${DENOMS[i] / E18}`);
  ok((await R.MAX_NOTES()) === 32n && (await R.MAX_WITHDRAWALS()) === 16n, 'router: limits 32 notes per deposit, 16 per withdrawMany');

  // A real proof for a one-leaf tree against pool 0's context, checked against the verifier with read-only calls
  const sk = rnd(), vk = rnd();
  const P0 = new ethers.Contract(pools[0], C.PoolV8Native.abi, provider);
  const zeros = []; for (let l = 0; l < LEVELS8; l++) zeros.push(await P0.zeros(l));
  const ctx0 = await P0.ctx();
  const ext = { recipient: me, relayer: ethers.Wallet.createRandom().address, fee: E18 / 10n, paymentRef: ethers.hexlify(require('crypto').randomBytes(32)), destChainId: BigInt(chainId) };
  ok((await P0.extDataHash(extTupleV8(ext))) === extDataHashV8(ext), 'pool computes extDataHash as the SDK does');
  const wp = await withdrawProofV8({ sk, vk, leaf: 0, leaves: [commitmentV8(sk, vk)], zeros, ctx: ctx0, ext });
  const V = new ethers.Contract(verifier, C.WithdrawVerifierV6.abi, provider);
  ok(await V.verifyProof(wp.pA, wp.pB, wp.pC, wp.pub), 'withdraw verifier V6 accepts a real withdraw_v6 proof');
  const ctx1 = await new ethers.Contract(pools[1], C.PoolV8Native.abi, provider).ctx();
  for (const [i, what, v] of [[2, 'pool (ctx of the 50 pool)', ctx1], [3, 'recipient', extDataHashV8({ ...ext, recipient: ethers.Wallet.createRandom().address })], [3, 'fee', extDataHashV8({ ...ext, fee: ext.fee * 2n })]]) {
    const bad = [...wp.pub]; bad[i] = v.toString();
    ok(!(await V.verifyProof(wp.pA, wp.pB, wp.pC, bad)), `… and rejects it for another ${what}`);
  }
  const nonce = rnd();
  const d2 = await discloseV2Proof({ sk, vk, nonce });
  const DV = new ethers.Contract(discloseV2, C.DiscloseVerifierV2.abi, provider);
  ok(await DV.verifyProof(d2.pA, d2.pB, d2.pC, d2.pub), 'disclosure verifier V2 accepts a real disclose_v2 proof');
  const bad2 = [...d2.pub]; bad2[2] = (nonce + 1n).toString();
  ok(!(await DV.verifyProof(d2.pA, d2.pB, d2.pC, bad2)), '… and rejects it for another auditor code');
  const dl = await discloseLinkProof({ sk, vk, ctx: ctx0, nonce });
  const DL = new ethers.Contract(discloseLink, C.DiscloseLinkVerifier.abi, provider);
  ok(await DL.verifyProof(dl.pA, dl.pB, dl.pC, dl.pub) && BigInt(dl.pub[1]) === BigInt(wp.nullifierHash), 'disclose_link verifier accepts a real proof; its nullifier equals the withdrawal\'s');
  const badL = [...dl.pub]; badL[2] = ctx1.toString();
  ok(!(await DL.verifyProof(dl.pA, dl.pB, dl.pC, badL)), '… and rejects it for another pool');

  log('3. Public V8 entry (separate file; the demo entry is unchanged)');
  const id = dep.network.id || 'latheon-testnet';
  const v8 = {
    network: { id, chainId, rpcUrl: dep.network.rpcUrl, explorerUrl: dep.network.explorerUrl, poseidon },
    version: 'v8-native',
    verifiers: { withdraw: verifier, disclose: discloseV2, discloseLink },
    guardian: GUARDIAN_MODE === 'none' ? null : { address: guardian, kind: 'TimelockController', delaySeconds: DELAY, proposer: me, executor: me, note: 'one key plus a delay, not a multisig' },
    pools: DENOMS.map((d, i) => ({ id: `${id}:LTH-${d / E18}:v8`, network: id, version: 'v8-native', token: 'LTH', amount: Number(d / E18), address: pools[i], deployBlock: st.tx['PoolV8_' + d / E18].block })),
    routers: [{ id: `${id}:LTH:v8`, network: id, token: 'LTH', native: true, version: 'v8', address: router, deployBlock: st.tx.RouterV8.block }],
    build: { compiler: ART.compilerV8, settings: ART.settings, latheonCommit: ART.source.commit, circuits: Object.fromEntries(Object.entries(ART.source.circuits).filter(([k]) => /v6|disclose_v2|disclose_link/.test(k))) },
    deployTx: st.tx,
  };
  const out = path.join(OUT_DIR, 'latheon-deployments-v8.json');
  saveJson(out, v8);
  log('Written ' + out);
}

main().then(() => process.exit(0)).catch((e) => die((e && (e.shortMessage || e.message)) || String(e)));
