// Rehearsal of a Latheon test chain: Arbitrum L3 on Arbitrum Sepolia, gas paid in a test LTH token.
//
//   node rehearsal.mjs deploy   test LTH + fee token pricer on Arbitrum Sepolia, createRollup, node config
//   node rehearsal.mjs fund     deposit test LTH into the L3 through the chain's own inbox (node must run)
//   node rehearsal.mjs bridge   token bridge for other ERC-20s (node must run)
//   node rehearsal.mjs batches  wait until the batch poster has posted to Arbitrum Sepolia
//   node rehearsal.mjs sweep    return the batch poster's leftover ETH to the deployer
//
// Env: DEPLOYER_KEY (funded on Arbitrum Sepolia, never printed), PARENT_RPC (optional).
// Private material goes to secret/ (never committed or uploaded); public facts go to out/chain.json.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient, createWalletClient, http, parseEther, formatEther, parseAbi, defineChain,
} from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { arbitrumSepolia } from 'viem/chains';
import {
  prepareChainConfig, createRollupPrepareDeploymentParamsConfig, createRollup,
  prepareNodeConfig, createTokenBridge, createTokenBridgeFetchTokenBridgeContracts,
} from '@arbitrum/chain-sdk';
import { generateChainId, sanitizePrivateKey } from '@arbitrum/chain-sdk/utils';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SECRET = path.join(HERE, 'secret');
const OUT = path.join(HERE, 'out');
fs.mkdirSync(SECRET, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

const PARENT_RPC = process.env.PARENT_RPC || 'https://sepolia-rollup.arbitrum.io/rpc';
const L3_RPC = process.env.L3_RPC || 'http://127.0.0.1:8449';
const CHAIN_NAME = 'latheon-rehearsal';
// Test exchange rate for the fee token pricer: LTH per 1 ETH, 18 decimals. Arbitrary for a testnet.
const LTH_PER_ETH = parseEther('10000');
const BATCH_POSTER_FUNDING = parseEther('0.01');
const L3_DEPOSIT = parseEther('10000'); // test LTH moved into the L3 for the scenario

// ConstantFeeTokenPricer from OffchainLabs/nitro-testnode scripts/ethcommands.ts (constructor(uint256 rate)).
const PRICER_BYTECODE = '0x60a0604052348015600e575f80fd5b506040516101c63803806101c68339818101604052810190602e9190606d565b8060808181525050506093565b5f80fd5b5f819050919050565b604f81603f565b81146058575f80fd5b50565b5f815190506067816048565b92915050565b5f60208284031215607f57607e603b565b5b5f608a84828501605b565b91505092915050565b6080516101166100b05f395f8181606a0152608f01526101165ff3fe6080604052348015600e575f80fd5b50600436106030575f3560e01c8063b8910a29146034578063e6aa216c14604e575b5f80fd5b603a6068565b6040516045919060c9565b60405180910390f35b6054608c565b604051605f919060c9565b60405180910390f35b7f000000000000000000000000000000000000000000000000000000000000000081565b5f7f0000000000000000000000000000000000000000000000000000000000000000905090565b5f819050919050565b60c38160b3565b82525050565b5f60208201905060da5f83018460bc565b9291505056fea2646970667358221220ee17f22614d853ccf8b3f854137f68f06ff92f9f71ba8b811d78b1313eead0c564736f6c634300081a0033';

const erc20Abi = parseAbi([
  'function approve(address,uint256) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
]);
const inboxAbi = parseAbi(['function depositERC20(uint256 amount) returns (uint256)']);
const seqInboxAbi = parseAbi(['function batchCount() view returns (uint256)']);

const statePath = path.join(SECRET, 'state.json');
const pubPath = path.join(OUT, 'chain.json');
const load = (p, d) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : d);
const save = (p, o) => fs.writeFileSync(p, JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!process.env.DEPLOYER_KEY) throw new Error('DEPLOYER_KEY is not set');
const deployer = privateKeyToAccount(sanitizePrivateKey(process.env.DEPLOYER_KEY));
const parent = createPublicClient({ chain: arbitrumSepolia, transport: http(PARENT_RPC, { retryCount: 5, retryDelay: 2000 }) });
const parentWallet = createWalletClient({ account: deployer, chain: arbitrumSepolia, transport: http(PARENT_RPC, { retryCount: 5, retryDelay: 2000 }) });

async function send(label, p) {
  const hash = await p;
  const rc = await parent.waitForTransactionReceipt({ hash, timeout: 300_000 });
  if (rc.status !== 'success') throw new Error(`${label} reverted: ${hash}`);
  log(`${label}: ${hash} (gas ${rc.gasUsed})`);
  return rc;
}

function l3Client(chainId) {
  const chain = defineChain({
    id: chainId, name: CHAIN_NAME, network: CHAIN_NAME,
    nativeCurrency: { name: 'Latheon test', symbol: 'LTH', decimals: 18 },
    rpcUrls: { default: { http: [L3_RPC] }, public: { http: [L3_RPC] } },
  });
  return createPublicClient({ chain, transport: http(L3_RPC) });
}

async function deploy() {
  const st = load(statePath, {});
  const pub = load(pubPath, { parentChain: 'Arbitrum Sepolia (421614)', txs: {} });
  const bal = await parent.getBalance({ address: deployer.address });
  log(`deployer ${deployer.address}, ${formatEther(bal)} ETH on Arbitrum Sepolia`);
  pub.deployer = deployer.address;
  pub.deployerBalanceStart = formatEther(bal);
  if (bal < parseEther('0.03')) throw new Error('need at least 0.03 ETH on Arbitrum Sepolia');

  // 1. test LTH (contracts/LatheonToken.sol from the repo, unchanged; mints 100M to the deployer)
  if (!st.token) {
    const art = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'l2-eval', 'artifacts', 'evm.json'), 'utf8')).contracts.Token;
    const rc = await send('deploy test LTH', parentWallet.deployContract({ abi: art.abi, bytecode: art.bytecode, args: [deployer.address] }));
    st.token = rc.contractAddress; pub.txs.token = rc.transactionHash; save(statePath, st);
  }
  pub.feeToken = st.token;

  // 2. constant fee token pricer (required for a custom-gas-token Rollup chain)
  if (!st.pricer) {
    const rc = await send('deploy fee token pricer', parentWallet.deployContract({
      abi: parseAbi(['constructor(uint256 rate)']), bytecode: PRICER_BYTECODE, args: [LTH_PER_ETH],
    }));
    st.pricer = rc.contractAddress; pub.txs.pricer = rc.transactionHash; save(statePath, st);
  }
  pub.feeTokenPricer = st.pricer;
  pub.feeTokenPricerRate = `${formatEther(LTH_PER_ETH)} LTH per ETH (test value)`;

  // 3. keys for the batch poster and validator (generated here, kept in secret/ only)
  if (!st.batchPosterKey) { st.batchPosterKey = generatePrivateKey(); st.validatorKey = generatePrivateKey(); save(statePath, st); }
  const batchPoster = privateKeyToAccount(st.batchPosterKey).address;
  const validator = privateKeyToAccount(st.validatorKey).address;
  pub.batchPoster = batchPoster; pub.validator = validator;

  // 4. the rollup (Rollup mode: data posted to Arbitrum Sepolia, no DA committee)
  if (!st.core) {
    const chainId = generateChainId();
    const chainConfig = prepareChainConfig({ chainId, arbitrum: { InitialChainOwner: deployer.address, DataAvailabilityCommittee: false } });
    const config = createRollupPrepareDeploymentParamsConfig(parent, {
      chainId: BigInt(chainId), owner: deployer.address, chainConfig, baseStake: parseEther('0.0001'),
    });
    log(`createRollup: chainId ${chainId}, stake token ${config.stakeToken}`);
    const res = await createRollup({
      params: { config, batchPosters: [batchPoster], validators: [validator], nativeToken: st.token, feeTokenPricer: st.pricer },
      account: deployer, parentChainPublicClient: parent,
    });
    st.chainId = chainId; st.chainConfig = chainConfig; st.stakeToken = config.stakeToken;
    st.core = res.coreContracts; save(statePath, st);
    pub.txs.createRollup = res.transactionReceipt.transactionHash;
  }
  pub.chainId = st.chainId; pub.coreContracts = st.core;

  // 5. fund the batch poster (the validator stays unfunded: staking is off in this rehearsal)
  const bpBal = await parent.getBalance({ address: batchPoster });
  if (bpBal < BATCH_POSTER_FUNDING / 2n) {
    const rc = await send('fund batch poster', parentWallet.sendTransaction({ to: batchPoster, value: BATCH_POSTER_FUNDING }));
    pub.txs.fundBatchPoster = rc.transactionHash;
  }

  // 6. node config (contains the batch poster key: secret/ only)
  const nodeConfig = prepareNodeConfig({
    chainName: CHAIN_NAME, chainConfig: st.chainConfig, coreContracts: st.core,
    batchPosterPrivateKey: st.batchPosterKey, validatorPrivateKey: undefined, stakeToken: st.stakeToken,
    parentChainId: arbitrumSepolia.id, parentChainRpcUrl: PARENT_RPC,
  });
  nodeConfig.node['batch-poster']['max-delay'] = '30s'; // post quickly so the rehearsal sees a batch land
  save(path.join(SECRET, 'node-config.json'), nodeConfig);
  fs.writeFileSync(path.join(SECRET, 'mask.txt'), st.batchPosterKey + '\n' + st.validatorKey + '\n');
  save(pubPath, pub);
  log(`deployed: chainId ${st.chainId}, rollup ${st.core.rollup}`);
}

async function waitL3(l3) {
  for (let i = 0; i < 90; i++) {
    try { return await l3.getBlockNumber(); } catch { await sleep(5000); }
  }
  throw new Error('L3 node RPC did not come up');
}

async function fund() {
  const st = load(statePath, {}); const pub = load(pubPath, {});
  const l3 = l3Client(st.chainId);
  log(`L3 block ${await waitL3(l3)}`);
  const allowance = await parent.readContract({ address: st.token, abi: erc20Abi, functionName: 'allowance', args: [deployer.address, st.core.inbox] });
  if (allowance < L3_DEPOSIT) {
    await send('approve inbox for test LTH', parentWallet.writeContract({ address: st.token, abi: erc20Abi, functionName: 'approve', args: [st.core.inbox, L3_DEPOSIT] })); // ERC20Inbox pulls the fee token
  }
  const before = await l3.getBalance({ address: deployer.address });
  const rc = await send('depositERC20 into L3', parentWallet.writeContract({ address: st.core.inbox, abi: inboxAbi, functionName: 'depositERC20', args: [L3_DEPOSIT] }));
  pub.txs = pub.txs || {}; pub.txs.depositERC20 = rc.transactionHash;
  const t0 = Date.now();
  for (;;) {
    const b = await l3.getBalance({ address: deployer.address });
    if (b >= before + L3_DEPOSIT) {
      pub.depositArrivalSeconds = Math.round((Date.now() - t0) / 1000);
      log(`deposit arrived on L3 after ${pub.depositArrivalSeconds}s: balance ${formatEther(b)} LTH`);
      break;
    }
    if (Date.now() - t0 > 20 * 60_000) throw new Error('deposit did not arrive on the L3 within 20 minutes');
    await sleep(10_000);
  }
  save(pubPath, pub);
}

async function bridge() {
  const st = load(statePath, {}); const pub = load(pubPath, {});
  const l3 = l3Client(st.chainId);
  await waitL3(l3);
  let contracts;
  try {
    const res = await createTokenBridge({
      rollupOwner: deployer.address, rollupAddress: st.core.rollup,
      rollupDeploymentBlockNumber: BigInt(st.core.deployedAtBlockNumber),
      account: deployer, nativeTokenAddress: st.token,
      parentChainPublicClient: parent, orbitChainPublicClient: l3,
    });
    pub.txs.createTokenBridge = res.transactionReceipt.transactionHash;
    contracts = res.tokenBridgeContracts;
  } catch (e) {
    // public RPCs sometimes do not see a just-sent tx yet; the deployment may still have gone through
    log(`createTokenBridge reported: ${e?.shortMessage || e?.message}; looking up the deployment instead`);
    for (let i = 0; i < 30 && !contracts; i++) {
      await sleep(10_000);
      try {
        const c = await createTokenBridgeFetchTokenBridgeContracts({ inbox: st.core.inbox, parentChainPublicClient: parent });
        if (c?.orbitChainContracts?.router && !/^0x0+$/.test(c.orbitChainContracts.router)) contracts = c;
      } catch { /* not deployed yet */ }
    }
    if (!contracts) throw new Error('token bridge deployment not found on the parent chain');
  }
  pub.tokenBridge = contracts;
  const router = contracts.orbitChainContracts.router;
  let code;
  for (let i = 0; i < 60; i++) { // retryables create the child-side contracts
    code = await l3.getBytecode({ address: router });
    if (code && code !== '0x') break;
    await sleep(10_000);
  }
  pub.tokenBridgeChildRouterHasCode = !!code && code !== '0x';
  log(`token bridge: L3 router ${router}, code present: ${pub.tokenBridgeChildRouterHasCode}`);
  save(pubPath, pub);
  if (!pub.tokenBridgeChildRouterHasCode) process.exitCode = 1;
}

async function batches() {
  const st = load(statePath, {}); const pub = load(pubPath, {});
  const read = () => parent.readContract({ address: st.core.sequencerInbox, abi: seqInboxAbi, functionName: 'batchCount' });
  const start = await read();
  log(`sequencer inbox batchCount ${start}`);
  const t0 = Date.now();
  let n = start;
  while (n <= 1n && Date.now() - t0 < 10 * 60_000) { await sleep(15_000); n = await read(); }
  pub.batchCount = n.toString();
  pub.batchesPosted = n > 1n; // batch 0 is created with the rollup
  log(`batchCount ${n}${pub.batchesPosted ? ' (batch poster is posting to Arbitrum Sepolia)' : ' (no batch posted yet)'}`);
  save(pubPath, pub);
  if (!pub.batchesPosted) process.exitCode = 1;
}

async function sweep() {
  const st = load(statePath, {}); const pub = load(pubPath, {});
  if (!st.batchPosterKey) return;
  const bp = privateKeyToAccount(st.batchPosterKey);
  const w = createWalletClient({ account: bp, chain: arbitrumSepolia, transport: http(PARENT_RPC) });
  const bal = await parent.getBalance({ address: bp.address });
  const gasPrice = await parent.getGasPrice();
  const fee = gasPrice * 2n * 300_000n; // generous: Arbitrum gas limits include the L1 component
  if (bal > fee) {
    const hash = await w.sendTransaction({ to: deployer.address, value: bal - fee, gas: 300_000n, maxFeePerGas: gasPrice * 2n, maxPriorityFeePerGas: 0n });
    await parent.waitForTransactionReceipt({ hash });
    log(`swept ${formatEther(bal - fee)} ETH back to the deployer: ${hash}`);
    pub.txs.sweep = hash;
  }
  pub.deployerBalanceEnd = formatEther(await parent.getBalance({ address: deployer.address }));
  save(pubPath, pub);
}

const cmd = process.argv[2];
const fn = { deploy, fund, bridge, batches, sweep }[cmd];
if (!fn) { console.error('usage: node rehearsal.mjs deploy|fund|bridge|batches|sweep'); process.exit(2); }
fn().then(() => process.exit(process.exitCode || 0)).catch((e) => { console.error(e?.shortMessage || e?.message || e); process.exit(1); });
