// Send ETH on Arbitrum Sepolia from the deployer to the batch poster or the validator:
//   DEPLOYER_KEY=... node topup.mjs batch-poster|validator AMOUNT      (AMOUNT in ETH, at most 1)
// The node's own keys are not used to send (their nonces belong to the node). The deployer key comes from the
// environment only (topup-cmd.sh asks for it without echo) and is not written anywhere. Prints balances before and after.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, http, parseEther, formatEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arbitrumSepolia } from 'viem/chains';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SECRET = process.env.STATE_DIR || path.join(HERE, 'secret');
const PARENT_RPC = process.env.PARENT_RPC || 'https://sepolia-rollup.arbitrum.io/rpc';

const [who, arg] = process.argv.slice(2);
if (!['batch-poster', 'validator'].includes(who) || !/^\d+(\.\d+)?$/.test(arg || '') || Number(arg) <= 0 || Number(arg) > 1) {
  console.error('usage: node topup.mjs batch-poster|validator AMOUNT_ETH (at most 1)'); process.exit(2);
}
if (!process.env.DEPLOYER_KEY) { console.error('DEPLOYER_KEY is not set'); process.exit(1); }
const amount = parseEther(arg);
const st = JSON.parse(fs.readFileSync(path.join(SECRET, 'state.json'), 'utf8'));
if (!st.validatorKey || !st.batchPosterKey) { console.error('no validator or batch poster key in secret/state.json'); process.exit(1); }
const key = process.env.DEPLOYER_KEY.trim();
const deployer = privateKeyToAccount(key.startsWith('0x') ? key : '0x' + key);
const validator = privateKeyToAccount(st.validatorKey).address;
const batchPoster = privateKeyToAccount(st.batchPosterKey).address;
const to = who === 'validator' ? validator : batchPoster;

const parent = createPublicClient({ chain: arbitrumSepolia, transport: http(PARENT_RPC) });
const wallet = createWalletClient({ account: deployer, chain: arbitrumSepolia, transport: http(PARENT_RPC) });
const show = async (when) => {
  const [d, v, b] = await Promise.all([deployer.address, validator, batchPoster].map((address) => parent.getBalance({ address })));
  console.log(`${when}: deployer ${deployer.address} ${formatEther(d)} ETH, validator ${validator} ${formatEther(v)} ETH, batch poster ${batchPoster} ${formatEther(b)} ETH`);
  return d;
};

const before = await show('before');
if (before < amount) { console.error(`refused: the deployer holds only ${formatEther(before)} ETH`); process.exit(1); }
const hash = await wallet.sendTransaction({ to, value: amount });
console.log(`sent ${arg} ETH to the ${who}: ${hash} (https://sepolia.arbiscan.io/tx/${hash})`);
const rc = await parent.waitForTransactionReceipt({ hash });
console.log(`status ${rc.status} in block ${rc.blockNumber}`);
await show('after');
process.exit(rc.status === 'success' ? 0 : 1);
