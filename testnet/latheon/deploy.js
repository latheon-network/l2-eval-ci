'use strict';
/*
 * Deploys the Latheon contracts on the Latheon test chain and checks every link before anything is published:
 *   PoseidonT3, withdraw verifier (withdraw_v3), disclosure verifier, four native-coin V5 pools (100 / 50 / 10 / 1 LTH)
 *   and the native-coin distribution router. LTH is the chain's gas coin: no wrapper, no approve.
 * Checks: each pool's native marker / verifier / denomination / zeros(8) (wrong Poseidon link), router native marker /
 * pools / denominations / limits, and one real proof against each verifier (read-only calls).
 *
 *   L3_RPC=http://127.0.0.1:8449 node deploy.js        (asks for the deployer key without echo, or DEPLOYER_KEY)
 *   options: --fresh (start again), env PUBLIC_RPC, EXPLORER_URL, NETWORK_ID, NETWORK_NAME
 *
 * Re-runnable: finished deployments are kept in STATE_DIR/latheon-deploy.json and reused.
 * Public result: OUT_DIR/latheon-deployments.json, an entry in the format of demo/deployments.json.
 */
const path = require('path');
const { ethers, ART, E18, DENOMS, ZERO_TOP, STATE_DIR, OUT_DIR, env, rnd, log, die, retry, connect, loadJson, saveJson, linkPool } = require('./lib');
const { commitmentOf, withdrawProof, discloseProof } = require('./zk');

const FRESH = process.argv.includes('--fresh');
const NETWORK_ID = env('NETWORK_ID', 'latheon-testnet');

async function main() {
  const { provider, wallet, me, chainId } = await connect();
  const bal = await retry(() => provider.getBalance(me), 'balance');
  log(`Chain ${chainId}, deployer ${me}, balance ${ethers.formatEther(bal)} LTH`);
  if (bal === 0n) die('the deployer has no LTH on this chain for gas');

  const statePath = path.join(STATE_DIR, 'latheon-deploy.json');
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

  log('1. Deploy');
  const C = ART.contracts;
  const poseidon = await deploy('PoseidonT3', C.PoseidonT3, []);
  const verifier = await deploy('WithdrawVerifier', C.WithdrawVerifier, []);
  const disclose = await deploy('DiscloseVerifier', C.DiscloseVerifier, []);
  const poolCode = linkPool(poseidon);
  const pools = [];
  for (const d of DENOMS) pools.push(await deploy('Pool' + d / E18, C.PoolNative, [verifier, d], poolCode));
  const router = await deploy('Router', C.RouterNative, [pools]);

  log('2. Checks');
  const ok = (cond, what) => { if (!cond) die('check failed: ' + what); log('   ✔ ' + what); };
  for (let i = 0; i < 4; i++) {
    const P = new ethers.Contract(pools[i], C.PoolNative.abi, provider);
    const [tok, ver, den, z8] = await Promise.all([P.token(), P.verifier(), P.DENOMINATION(), P.zeros(8)]);
    ok(tok === ethers.ZeroAddress && ver === verifier && den === DENOMS[i] && z8 === ZERO_TOP, `pool ${DENOMS[i] / E18}: native coin, verifier, denomination, zeros(8) (Poseidon linked correctly)`);
  }
  const R = new ethers.Contract(router, C.RouterNative.abi, provider);
  ok((await R.token()) === ethers.ZeroAddress, 'router: native coin');
  for (let i = 0; i < 4; i++) ok((await R.pools(i)) === pools[i] && (await R.denominations(i)) === DENOMS[i], `router: pool ${i} and denomination ${DENOMS[i] / E18}`);
  ok((await R.MAX_NOTES()) === 32n && (await R.MAX_WITHDRAWALS()) === 16n, 'router: limits 32 notes per deposit, 16 per withdrawMany');

  // Real proofs against the deployed verifiers (read-only): a note alone in an empty tree, and a disclosure.
  const sk = rnd(), vk = rnd();
  const zeros = []; const P0 = new ethers.Contract(pools[0], C.PoolNative.abi, provider);
  for (let l = 0; l < 8; l++) zeros.push(await P0.zeros(l));
  const wp = await withdrawProof({ sk, vk, leaf: 0, leaves: [commitmentOf(sk, vk)], zeros, recipient: me });
  const V = new ethers.Contract(verifier, C.WithdrawVerifier.abi, provider);
  ok(await V.verifyProof(wp.pA, wp.pB, wp.pC, wp.pub), 'withdraw verifier accepts a real withdraw_v3 proof');
  const bad = [...wp.pub]; bad[2] = BigInt(ethers.Wallet.createRandom().address).toString();
  ok(!(await V.verifyProof(wp.pA, wp.pB, wp.pC, bad)), 'withdraw verifier rejects the same proof for another recipient');
  const dp = await discloseProof({ sk, vk, nonce: rnd() });
  const D = new ethers.Contract(disclose, C.DiscloseVerifier.abi, provider);
  ok(await D.verifyProof(dp.pA, dp.pB, dp.pC, dp.pub), 'disclosure verifier accepts a real disclose proof');

  log('3. Public deployment entry');
  const blocks = Object.fromEntries(Object.entries(st.tx).map(([k, v]) => [k, v.block]));
  const entry = {
    network: {
      id: NETWORK_ID,
      name: env('NETWORK_NAME', 'Latheon Testnet'),
      chainId, chainIdHex: '0x' + chainId.toString(16),
      rpcUrl: env('PUBLIC_RPC', 'https://rpc.testnet.latheon.xyz'),
      explorerUrl: env('EXPLORER_URL', 'https://explorer.testnet.latheon.xyz'),
      blockscoutApi: env('EXPLORER_URL', 'https://explorer.testnet.latheon.xyz') + '/api/v2',
      nativeCurrency: { name: 'LTH (test)', symbol: 'LTH', decimals: 18 },
      v5Verifier: verifier, discloseVerifier: disclose, poseidonDeployedThisRelease: [poseidon],
      tokens: { LTH: { address: ethers.ZeroAddress, decimals: 18, native: true, note: 'The chain\'s gas coin. Pools and router take it as msg.value and pay it out directly: no wrapping, no approve.' } },
    },
    pools: DENOMS.map((d, i) => ({ id: `${NETWORK_ID}:LTH-${d / E18}`, network: NETWORK_ID, version: 'v5-native', token: 'LTH', amount: Number(d / E18), address: pools[i], deployBlock: blocks['Pool' + d / E18] })),
    routers: [{ id: `${NETWORK_ID}:LTH`, network: NETWORK_ID, token: 'LTH', native: true, address: router, deployBlock: blocks.Router }],
    build: { compiler: ART.compiler, settings: ART.settings, latheonCommit: ART.source.commit },
    deployTx: st.tx,
  };
  const out = path.join(OUT_DIR, 'latheon-deployments.json');
  saveJson(out, entry);
  log('Written ' + out);
}

main().then(() => process.exit(0)).catch((e) => die((e && (e.shortMessage || e.message)) || String(e)));
