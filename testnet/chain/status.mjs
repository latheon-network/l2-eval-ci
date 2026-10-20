// Read-only overview of the Latheon test chain for the server (run through ../status.sh). Needs no key and prints none:
// it reads the public chain/out/chain.json, the public latheon/out/latheon-deployments.json and only derives the
// faucet's address from its key file. Every read is independent: one failing read prints "n/a" and the rest go on.
//
// Env: PARENT_RPC, L3_RPC (default http://127.0.0.1:8449), CHAIN_JSON, LATHEON_JSON, FAUCET_KEY_FILE.

import fs from 'node:fs';
import { createPublicClient, http, formatEther, parseAbi, defineChain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arbitrumSepolia } from 'viem/chains';

const PARENT_RPC = process.env.PARENT_RPC || 'https://sepolia-rollup.arbitrum.io/rpc';
const L3_RPC = process.env.L3_RPC || 'http://127.0.0.1:8449';
const CHAIN_JSON = process.env.CHAIN_JSON || 'out/chain.json';
const LATHEON_JSON = process.env.LATHEON_JSON || '/latheon-out/latheon-deployments.json';
const FAUCET_KEY_FILE = process.env.FAUCET_KEY_FILE || '/faucet-secret/faucet.key';

// Thresholds for warnings (ETH on Arbitrum Sepolia, LTH on the chain)
const MIN_BATCH_POSTER_ETH = 0.005, MIN_VALIDATOR_ETH = 0.003, MIN_DEPLOYER_ETH = 0.02, MIN_FAUCET_LTH = 1000;

const pub = JSON.parse(fs.readFileSync(CHAIN_JSON, 'utf8'));
const core = pub.coreContracts;
const lat = fs.existsSync(LATHEON_JSON) ? JSON.parse(fs.readFileSync(LATHEON_JSON, 'utf8')) : null;
let faucet = null;
try { faucet = privateKeyToAccount(fs.readFileSync(FAUCET_KEY_FILE, 'utf8').trim()).address; } catch { /* not initialised */ }

const parent = createPublicClient({ chain: arbitrumSepolia, transport: http(PARENT_RPC, { retryCount: 3, retryDelay: 1500 }) });
const l3chain = defineChain({
  id: Number(pub.chainId), name: 'latheon-testnet', network: 'latheon-testnet',
  nativeCurrency: { name: 'Latheon test', symbol: 'LTH', decimals: 18 },
  rpcUrls: { default: { http: [L3_RPC] }, public: { http: [L3_RPC] } },
});
const l3 = createPublicClient({ chain: l3chain, transport: http(L3_RPC, { retryCount: 2, retryDelay: 1000 }) });

const erc20 = parseAbi(['function balanceOf(address) view returns (uint256)', 'function totalSupply() view returns (uint256)']);
const seqInbox = parseAbi(['function batchCount() view returns (uint256)']);
const rollup = parseAbi(['function latestConfirmed() view returns (bytes32)', 'function isValidator(address) view returns (bool)']);
const arbOwnerPublic = parseAbi([
  'function getAllChainOwners() view returns (address[])',
  'function getNetworkFeeAccount() view returns (address)',
  'function getInfraFeeAccount() view returns (address)',
]);
const arbGasInfo = parseAbi(['function getL1RewardRecipient() view returns (address)', 'function getMinimumGasPrice() view returns (uint256)']);
const ARB_OWNER_PUBLIC = '0x000000000000000000000000000000000000006b';
const ARB_GAS_INFO = '0x000000000000000000000000000000000000006C';

const warnings = [];
const fmt = (wei, d = 6) => Number(formatEther(wei)).toLocaleString('en-US', { maximumFractionDigits: d });
async function get(label, fn) { try { return await fn(); } catch (e) { console.log(`  ${label}: n/a (${(e.shortMessage || e.message || '').split('\n')[0].slice(0, 120)})`); return undefined; } }
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : 'n/a');

console.log(`Latheon test chain ${pub.chainId} — status at ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC`);

console.log('\n[chain]');
const block = await get('latest block', () => l3.getBlock());
if (block) {
  const age = Math.round(Date.now() / 1000 - Number(block.timestamp));
  console.log(`  latest block ${block.number}, ${age} s ago (blocks are made only when there are transactions)`);
}
const gasPrice = await get('gas price', () => l3.getGasPrice());
if (gasPrice !== undefined) console.log(`  gas price ${Number(gasPrice) / 1e9} gwei`);
const owners = await get('chain owners', () => l3.readContract({ address: ARB_OWNER_PUBLIC, abi: arbOwnerPublic, functionName: 'getAllChainOwners' }));
if (owners) console.log(`  chain owners: ${owners.join(', ')}`);

console.log('\n[fees go to]');
const feeAccounts = {};
for (const [label, call] of [
  ['network fee account', () => l3.readContract({ address: ARB_OWNER_PUBLIC, abi: arbOwnerPublic, functionName: 'getNetworkFeeAccount' })],
  ['infra fee account', () => l3.readContract({ address: ARB_OWNER_PUBLIC, abi: arbOwnerPublic, functionName: 'getInfraFeeAccount' })],
  ['parent-chain data reward recipient', () => l3.readContract({ address: ARB_GAS_INFO, abi: arbGasInfo, functionName: 'getL1RewardRecipient' })],
]) {
  const a = await get(label, call);
  if (a) { feeAccounts[label] = a; const b = await get(`${label} balance`, () => l3.getBalance({ address: a })); console.log(`  ${label}: ${a}${b !== undefined ? `, ${fmt(b)} LTH` : ''}`); }
}

console.log('\n[Arbitrum Sepolia: batches and validator]');
const bc = await get('batchCount', () => parent.readContract({ address: core.sequencerInbox, abi: seqInbox, functionName: 'batchCount' }));
if (bc !== undefined) console.log(`  sequencer inbox batchCount ${bc}${bc > 1n ? '' : ' (no batch posted since creation)'}`);
const allowed = await get('validator allowed', () => parent.readContract({ address: core.rollup, abi: rollup, functionName: 'isValidator', args: [pub.validator] }));
const confirmed = await get('latest confirmed', () => parent.readContract({ address: core.rollup, abi: rollup, functionName: 'latestConfirmed' }));
if (allowed !== undefined) console.log(`  validator ${short(pub.validator)} allowed by the rollup: ${allowed}`);
if (confirmed) console.log(`  latest confirmed assertion ${confirmed}`);
if (allowed === false) warnings.push('the validator is not allowed by the rollup');

console.log('\n[ETH on Arbitrum Sepolia]');
for (const [label, addr, min] of [
  ['batch poster', pub.batchPoster, MIN_BATCH_POSTER_ETH],
  ['validator', pub.validator, MIN_VALIDATOR_ETH],
  ['deployer', pub.deployer, MIN_DEPLOYER_ETH],
]) {
  const b = await get(`${label} ETH`, () => parent.getBalance({ address: addr }));
  if (b === undefined) continue;
  const low = Number(formatEther(b)) < min;
  console.log(`  ${label.padEnd(13)} ${addr}  ${fmt(b)} ETH${low ? `  ← below ${min}, top up` : ''}`);
  if (low) warnings.push(`${label} has ${fmt(b)} ETH on Arbitrum Sepolia (below ${min})`);
}

console.log('\n[test LTH]');
const supply = await get('LTH token supply', () => parent.readContract({ address: pub.feeToken, abi: erc20, functionName: 'totalSupply' }));
const inBridge = await get('LTH in the bridge', () => parent.readContract({ address: pub.feeToken, abi: erc20, functionName: 'balanceOf', args: [core.bridge] }));
const deployerErc20 = await get('deployer LTH token', () => parent.readContract({ address: pub.feeToken, abi: erc20, functionName: 'balanceOf', args: [pub.deployer] }));
if (supply !== undefined) console.log(`  token on Arbitrum Sepolia (${short(pub.feeToken)}): total supply ${fmt(supply, 2)}`);
if (deployerErc20 !== undefined) console.log(`    deployer holds ${fmt(deployerErc20, 2)}`);
if (inBridge !== undefined) console.log(`    locked in the chain's bridge ${fmt(inBridge, 2)} (this backs the LTH that exists on the chain)`);

const rows = [['deployer', pub.deployer]];
if (faucet) rows.push(['faucet', faucet]); else console.log('  faucet: no key yet (./faucet-cmd.sh init)');
if (lat) {
  for (const p of lat.pools || []) rows.push([`pool ${p.amount}`, p.address]);
  for (const r of lat.routers || []) rows.push(['router', r.address]);
}
console.log('  on the chain (native coin):');
for (const [label, addr] of rows) {
  const b = await get(`${label} LTH`, () => l3.getBalance({ address: addr }));
  if (b === undefined) continue;
  console.log(`    ${label.padEnd(10)} ${addr}  ${fmt(b, 4)} LTH`);
  if (label === 'faucet' && Number(formatEther(b)) < MIN_FAUCET_LTH) warnings.push(`the faucet has ${fmt(b, 2)} LTH (below ${MIN_FAUCET_LTH})`);
}
if (lat) {
  const poolsLth = await Promise.all((lat.pools || []).map((p) => get(`pool ${p.amount}`, () => l3.getBalance({ address: p.address }))));
  const total = poolsLth.reduce((s, b) => s + (b || 0n), 0n);
  console.log(`    (shielded in the four pools together: ${fmt(total, 4)} LTH)`);
}

console.log(warnings.length ? `\nWARNINGS:\n${warnings.map((w) => `  - ${w}`).join('\n')}` : '\nNo warnings from the chain checks.');
