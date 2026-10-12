// Lower the minimum L2 base fee of the testnode L3 through the ArbOwner precompile.
// Usage: OWNER_KEY=0x... node set-min-base-fee.js <rpc> <minBaseFeeWei>
// Prints the gas price before and after; exits non-zero if the new minimum is not in effect.
const { ethers } = require('ethers');

const ARB_OWNER = '0x0000000000000000000000000000000000000070';
const ARB_GAS_INFO = '0x000000000000000000000000000000000000006C';

async function main() {
  const [rpc, target] = process.argv.slice(2);
  const want = BigInt(target);
  const provider = new ethers.JsonRpcProvider(rpc);
  const owner = new ethers.Wallet(process.env.OWNER_KEY, provider);
  const arbOwner = new ethers.Contract(ARB_OWNER, [
    'function setMinimumL2BaseFee(uint256)',
    'function getAllChainOwners() view returns (address[])',
  ], owner);
  const gasInfo = new ethers.Contract(ARB_GAS_INFO, [
    'function getMinimumGasPrice() view returns (uint256)',
  ], provider);

  const snap = async (label) => {
    const block = await provider.getBlock('latest');
    const min = await gasInfo.getMinimumGasPrice();
    const gp = BigInt(await provider.send('eth_gasPrice', []));
    console.log(`${label}: block ${block.number}, baseFeePerGas ${block.baseFeePerGas} wei, minimum ${min} wei, eth_gasPrice ${gp} wei`);
    return { base: block.baseFeePerGas, min, gp };
  };

  console.log('chain owners:', (await arbOwner.getAllChainOwners()).join(', '));
  console.log('caller:', owner.address);
  await snap('before');

  const tx = await arbOwner.setMinimumL2BaseFee(want);
  const rc = await tx.wait();
  console.log(`setMinimumL2BaseFee(${want}) tx ${tx.hash}, status ${rc.status}`);

  let s;
  for (let i = 0; i < 30; i++) {
    s = await snap(`after +${i * 2}s`);
    if (s.min === want && s.base <= want) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (s.min !== want || s.base > want) {
    console.error('new minimum base fee not in effect');
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
