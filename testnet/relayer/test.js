'use strict';
/*
 * Local test of the withdrawal relayer with REAL withdraw_v3 and withdraw_v4 proofs: the native-coin V5 and V6 pools and routers from the Latheon
 * repository (LATHEON_REPO, default ../../../Latheon) on ganache; the relayer logic (createRelayer) with its own wallet.
 *   LATHEON_REPO=/path/to/Latheon node test.js
 */
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const solc = require('solc'), ganache = require('ganache'), { ethers } = require('ethers'), snarkjs = require('snarkjs');
const { poseidon2 } = require('poseidon-lite');
const { createRelayer } = require('./relayer.js');

const REPO = path.resolve(process.env.LATHEON_REPO || path.join(__dirname, '..', '..', '..', 'Latheon'));
const rd = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n, E18 = 10n ** 18n, LEVELS = 8;
const rnd = () => BigInt('0x' + crypto.randomBytes(31).toString('hex')) % FIELD;
const CI = !!process.env.GITHUB_ACTIONS;
const results = []; const rec = (n, ok, note) => { results.push(ok); console.log((ok ? 'ok   ' : 'FAIL ') + n + (note ? '   [' + note + ']' : '')); if (!ok && CI) console.log(`::error::${n} [${note || ''}]`); };

(async () => {
  const out = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources: {
    'P.sol': { content: rd('contracts/LatheonShieldedPoolV5Native.sol') }, 'D.sol': { content: rd('contracts/LatheonDistributionPoolNative.sol') },
    'PoseidonT3.sol': { content: rd('contracts/PoseidonT3.sol') }, 'V.sol': { content: rd('contracts/WithdrawVerifierV3.sol') },
    'P6.sol': { content: rd('contracts/LatheonShieldedPoolV6Native.sol') }, 'D6.sol': { content: rd('contracts/LatheonDistributionPoolV6Native.sol') }, 'V4.sol': { content: rd('contracts/WithdrawVerifierV4.sol') },
    'R.sol': { content: '// SPDX-License-Identifier: MIT\npragma solidity ^0.8.24;\ncontract Refuser { receive() external payable { revert("no"); } }' } },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'paris', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.bytecode.linkReferences'] } } } })));
  if ((out.errors || []).some((e) => e.severity === 'error')) throw new Error(out.errors.map((e) => e.formattedMessage).join('\n'));
  const C = { Pool: out.contracts['P.sol'].LatheonShieldedPoolV5Native, Dist: out.contracts['D.sol'].LatheonDistributionPoolNative, T3: out.contracts['PoseidonT3.sol'].PoseidonT3, Ver: out.contracts['V.sol'].Groth16Verifier, Ref: out.contracts['R.sol'].Refuser,
    Pool6: out.contracts['P6.sol'].LatheonShieldedPoolV6Native, Dist6: out.contracts['D6.sol'].LatheonDistributionPoolV6Native, Ver4: out.contracts['V4.sol'].WithdrawVerifierV4 };
  const link = (c, libs) => { let code = c.evm.bytecode.object; const refs = c.evm.bytecode.linkReferences; for (const f in refs) for (const l in refs[f]) for (const { start, length } of refs[f][l]) code = code.slice(0, start * 2) + libs[l].slice(2).toLowerCase() + code.slice(start * 2 + length * 2); return code; };
  const gp = ganache.provider({ logging: { quiet: true }, chain: { hardfork: 'shanghai' }, wallet: { deterministic: true, totalAccounts: 4, defaultBalance: 100000 }, miner: { blockGasLimit: 60000000 } });
  const provider = new ethers.BrowserProvider(gp);
  const [deployer, relayerSigner, user] = await Promise.all([0, 1, 2].map((i) => provider.getSigner(i)));
  const deploy = async (c, args = [], libs = {}) => { const x = await new ethers.ContractFactory(c.abi, '0x' + link(c, libs), deployer).deploy(...args); await x.waitForDeployment(); return x; };
  const t3 = await deploy(C.T3), ver = await deploy(C.Ver);
  const pools = []; for (const d of [100n, 50n, 10n, 1n]) pools.push(await deploy(C.Pool, [await ver.getAddress(), d * E18], { PoseidonT3: await t3.getAddress() }));
  const router = await deploy(C.Dist, [await Promise.all(pools.map((p) => p.getAddress()))]);
  const strayPool = await deploy(C.Pool, [await ver.getAddress(), 10n * E18], { PoseidonT3: await t3.getAddress() });
  const refuser = await deploy(C.Ref);

  const leaves = new Map();
  const note = () => { const sk = rnd(), vk = rnd(); return { sk, vk, commitment: poseidon2([poseidon2([sk, vk]), 0n]) }; };
  const depositTo = async (pool, n) => { const rc = await (await pool.connect(user).deposit(n.commitment, { value: await pool.DENOMINATION() })).wait();
    const k = pool.target.toLowerCase(); if (!leaves.has(k)) leaves.set(k, []); for (const lg of rc.logs) { const ev = pool.interface.parseLog(lg); if (ev && ev.name === 'Deposit') leaves.get(k)[Number(ev.args.leafIndex)] = ev.args.commitment; } };
  const W3 = path.join(REPO, 'circuits/build/withdraw_v3/withdraw_v3.wasm'), Z3 = path.join(REPO, 'circuits/build/withdraw_v3/withdraw_v3_final.zkey');
  const W4 = path.join(REPO, 'circuits/build/withdraw_v4/withdraw_v4.wasm'), Z4 = path.join(REPO, 'circuits/build/withdraw_v4/withdraw_v4_final.zkey');
  // v6: { relayer, fee } proves with withdraw_v4 (20 levels) and binds them; otherwise withdraw_v3 (8 levels)
  async function prove(pool, n, recipient, v6) {
    const D = v6 ? 20 : LEVELS;
    const L = leaves.get(pool.target.toLowerCase()), leaf = L.indexOf(n.commitment);
    const zeros = []; for (let i = 0; i < D; i++) zeros.push(await pool.zeros(i));
    const levels = [L.slice()];
    for (let l = 0; l < D; l++) { const cur = levels[l], up = []; for (let j = 0; j < Math.max(1, Math.ceil(cur.length / 2)); j++) up.push(poseidon2([cur[2 * j] ?? zeros[l], cur[2 * j + 1] ?? zeros[l]])); levels.push(up); }
    const el = [], idx = []; let k = leaf; for (let l = 0; l < D; l++) { el.push((levels[l][k ^ 1] ?? zeros[l]).toString()); idx.push(k & 1); k >>= 1; }
    const input = { root: levels[D][0].toString(), nullifierHash: poseidon2([n.sk, 1n]).toString(), recipient: BigInt(recipient).toString(), spendKey: n.sk.toString(), viewKey: n.vk.toString(), pathElements: el, pathIndices: idx };
    if (v6) { input.relayer = BigInt(v6.relayer).toString(); input.fee = BigInt(v6.fee).toString(); }
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, v6 ? W4 : W3, v6 ? Z4 : Z3);
    const [pA, pB, pC, pub] = JSON.parse('[' + (await snarkjs.groth16.exportSolidityCallData(proof, publicSignals)) + ']');
    return { pA, pB, pC, root: pub[0], nullifierHash: pub[1] };
  }

  const relayerAddr = await relayerSigner.getAddress();
  const R = createRelayer({ ethers, wallet: relayerSigner, pools: await Promise.all(pools.map((p) => p.getAddress())), routers: [await router.getAddress()], perIpHour: 3, dailyCap: 100 });
  const fresh = () => ethers.Wallet.createRandom().address;
  const bal = (a) => provider.getBalance(a);

  // 1. one note through the relayer to an empty address
  const n1 = note(); await depositTo(pools[2], n1);
  const r1 = fresh(), p1 = await prove(pools[2], n1, r1);
  const userBefore = await bal(await user.getAddress()), relBefore = await bal(relayerAddr);
  let res = await R.handle('POST', '/relay/api/withdraw', { pool: pools[2].target, ...p1, recipient: r1 }, 'ip-a');
  rec('a valid withdrawal is relayed: the empty address gets exactly 10, the user pays nothing, the relayer pays the gas',
    res.status === 200 && (await bal(r1)) === 10n * E18 && (await bal(await user.getAddress())) === userBefore && (await bal(relayerAddr)) < relBefore, res.body.tx ? 'gas ' + res.body.gasUsed : JSON.stringify(res.body));
  // 2. same proof again: refused before sending, relayer spends nothing
  let b0 = await bal(relayerAddr);
  res = await R.handle('POST', '/relay/api/withdraw', { pool: pools[2].target, ...p1, recipient: r1 }, 'ip-b');
  rec('a spent note is refused before sending, no gas spent', res.status === 400 && /already spent/i.test(res.body.error) && (await bal(relayerAddr)) === b0, res.body.error);
  // 3. proof for one recipient, sent with another: refused, no gas
  const n3 = note(); await depositTo(pools[3], n3); const p3 = await prove(pools[3], n3, fresh());
  res = await R.handle('POST', '/relay/api/withdraw', { pool: pools[3].target, ...p3, recipient: fresh() }, 'ip-b');
  rec('a proof cannot be redirected to another recipient (refused, no gas)', res.status === 400 && /invalid proof/i.test(res.body.error) && (await bal(relayerAddr)) === b0, res.body.error);
  // 4. a pool that is not ours
  res = await R.handle('POST', '/relay/api/withdraw', { pool: strayPool.target, ...p3, recipient: fresh() }, 'ip-b');
  rec('a contract that is not one of our pools is refused', res.status === 400 && /Not a Latheon pool/.test(res.body.error), res.body.error);
  // 5. a recipient that refuses the coin
  const n5 = note(); await depositTo(pools[3], n5); const p5 = await prove(pools[3], n5, refuser.target);
  res = await R.handle('POST', '/relay/api/withdraw', { pool: pools[3].target, ...p5, recipient: refuser.target }, 'ip-b');
  rec('a recipient that refuses the coin: refused before sending, note stays spendable', res.status === 400 && (await bal(relayerAddr)) === b0 && !(await pools[3].nullifierHashes(p5.nullifierHash)), res.body.error);
  // 6. malformed input
  res = await R.handle('POST', '/relay/api/withdraw', { pool: pools[3].target, pA: [1], pB: 'x', recipient: fresh() }, 'ip-b');
  rec('malformed proof fields are refused', res.status === 400, res.body.error);
  res = await R.handle('POST', '/relay/api/withdraw', { pool: pools[3].target, ...p3, recipient: relayerAddr }, 'ip-b');
  rec('the relayer itself cannot be the recipient', res.status === 400 && /cannot be used/.test(res.body.error), res.body.error);
  // 7. withdrawMany through the router: 3 notes in one transaction
  const ns = [note(), note(), note()]; await depositTo(pools[0], ns[0]); await depositTo(pools[1], ns[1]); await depositTo(pools[3], ns[2]);
  const r7 = fresh(); const items = [];
  for (const [i, pi] of [[0, 0], [1, 1], [2, 3]]) { const p = await prove(pools[pi], ns[i], r7); items.push([pi, p.pA, p.pB, p.pC, p.root, p.nullifierHash]); }
  res = await R.handle('POST', '/relay/api/withdrawMany', { router: router.target, items, recipient: r7 }, 'ip-c');
  rec('withdrawMany through the router: 3 notes, the empty address gets exactly 151', res.status === 200 && (await bal(r7)) === 151n * E18, res.body.gasUsed ? 'gas ' + res.body.gasUsed : res.body.error);
  res = await R.handle('POST', '/relay/api/withdrawMany', { router: strayPool.target, items, recipient: r7 }, 'ip-c');
  rec('a router that is not ours is refused', res.status === 400 && /Not a Latheon router/.test(res.body.error), res.body.error);
  res = await R.handle('POST', '/relay/api/withdrawMany', { router: router.target, items: Array(17).fill(items[0]), recipient: r7 }, 'ip-c');
  rec('more than 16 notes per request is refused', res.status === 400 && /Between 1 and 16/.test(res.body.error), res.body.error);
  // 8. per-IP limit (3 per hour in this test): ip-a used 1; two more succeed, the fourth is refused
  for (let i = 0; i < 2; i++) { const n = note(); await depositTo(pools[3], n); const r = fresh(); const p = await prove(pools[3], n, r); await R.handle('POST', '/relay/api/withdraw', { pool: pools[3].target, ...p, recipient: r }, 'ip-a'); }
  const n8 = note(); await depositTo(pools[3], n8); const r8 = fresh(); const p8 = await prove(pools[3], n8, r8);
  res = await R.handle('POST', '/relay/api/withdraw', { pool: pools[3].target, ...p8, recipient: r8 }, 'ip-a');
  rec('the per-IP hourly limit applies after successful relays only', res.status === 429 && (await bal(r8)) === 0n, res.body.error);
  res = await R.handle('POST', '/relay/api/withdraw', { pool: pools[3].target, ...p8, recipient: r8 }, 'ip-d');
  rec('another address can still relay the same proof', res.status === 200 && (await bal(r8)) === 1n * E18, res.body.tx ? 'ok' : res.body.error);
  // 9. status and unknown paths
  res = await R.handle('GET', '/relay/api/status', null, 'ip-x');
  rec('status shows address, balance, limits and no fee', res.status === 200 && res.body.address === relayerAddr && res.body.fee === '0' && res.body.relayedLast24h === 5, JSON.stringify(res.body).slice(0, 120));
  res = await R.handle('POST', '/relay/api/other', {}, 'ip-x');
  rec('unknown paths answer 404', res.status === 404);
  // 10. a relayer without gas money refuses politely
  const poorRel = createRelayer({ ethers, wallet: ethers.Wallet.createRandom().connect(provider), pools: [pools[3].target], routers: [] });
  const n10 = note(); await depositTo(pools[3], n10); const r10 = fresh(); const p10 = await prove(pools[3], n10, r10);
  res = await poorRel.handle('POST', '/relay/api/withdraw', { pool: pools[3].target, ...p10, recipient: r10 }, 'ip-e');
  rec('a relayer below its minimum balance refuses (503) and suggests the user\'s own wallet', res.status === 503 && /own wallet/.test(res.body.error), res.body.error);

  // 11. V6 pools and router (withdraw_v4): relayer and fee bound into the proof
  const ver4 = await deploy(C.Ver4);
  const pools6 = []; for (const d of [100n, 50n, 10n, 1n]) pools6.push(await deploy(C.Pool6, [await ver4.getAddress(), d * E18], { PoseidonT3: await t3.getAddress() }));
  const router6 = await deploy(C.Dist6, [await Promise.all(pools6.map((p) => p.getAddress()))]);
  const R6 = createRelayer({ ethers, wallet: relayerSigner, pools: [], routers: [], v6Pools: await Promise.all(pools6.map((p) => p.getAddress())), v6Routers: [await router6.getAddress()],
    perIpHour: 50, dailyCap: 100, minFee: E18 / 100n, exemptIps: ['ip-load'] });
  const n11 = note(); await depositTo(pools6[2], n11);
  const r11 = fresh(), p11 = await prove(pools6[2], n11, r11, { relayer: ethers.ZeroAddress, fee: 0n });
  res = await R6.handle('POST', '/relay/api/withdraw', { pool: pools6[2].target, ...p11, recipient: r11 }, 'ip-f');
  rec('V6: a no-fee withdrawal (relayer 0, fee 0) is relayed; the empty address gets exactly 10', res.status === 200 && (await bal(r11)) === 10n * E18, res.body.gasUsed ? 'gas ' + res.body.gasUsed : res.body.error);
  const n12 = note(); await depositTo(pools6[2], n12);
  const r12 = fresh(), FEE = E18 / 10n, p12 = await prove(pools6[2], n12, r12, { relayer: relayerAddr, fee: FEE });
  const relB = await bal(relayerAddr);
  res = await R6.handle('POST', '/relay/api/withdraw', { pool: pools6[2].target, ...p12, recipient: r12, relayer: relayerAddr, fee: FEE.toString() }, 'ip-f');
  const gasPaid = res.body.gasUsed ? BigInt(res.body.gasUsed) : 0n;
  rec('V6: a withdrawal naming this relayer with a fee: recipient gets 9.9, the relayer earns 0.1 (minus its gas)', res.status === 200 && (await bal(r12)) === 10n * E18 - FEE && (await bal(relayerAddr)) > relB, res.body.error || 'ok');
  const n13 = note(); await depositTo(pools6[3], n13); const r13 = fresh();
  const other = ethers.Wallet.createRandom().address;
  const p13 = await prove(pools6[3], n13, r13, { relayer: other, fee: E18 / 10n });
  res = await R6.handle('POST', '/relay/api/withdraw', { pool: pools6[3].target, ...p13, recipient: r13, relayer: other, fee: (E18 / 10n).toString() }, 'ip-f');
  rec('V6: a proof that pays its fee to someone else is refused', res.status === 400 && /name it/.test(res.body.error), res.body.error);
  const p13b = await prove(pools6[3], n13, r13, { relayer: relayerAddr, fee: 1n });
  res = await R6.handle('POST', '/relay/api/withdraw', { pool: pools6[3].target, ...p13b, recipient: r13, relayer: relayerAddr, fee: '1' }, 'ip-f');
  rec('V6: a fee below the relayer\'s minimum is refused', res.status === 400 && /minimum/.test(res.body.error), res.body.error);
  res = await R6.handle('POST', '/relay/api/withdraw', { pool: pools6[3].target, ...p13b, recipient: r13, relayer: relayerAddr, fee: (E18 / 10n).toString() }, 'ip-f');
  rec('V6: a fee different from the one in the proof is refused before sending', res.status === 400 && /invalid proof/i.test(res.body.error), res.body.error);
  const ns6 = [note(), note()]; await depositTo(pools6[0], ns6[0]); await depositTo(pools6[3], ns6[1]);
  const r14 = fresh(); const items6 = [];
  for (const [i, pi] of [[0, 0], [1, 3]]) { const p = await prove(pools6[pi], ns6[i], r14, { relayer: relayerAddr, fee: E18 / 50n }); items6.push([pi, p.pA, p.pB, p.pC, p.root, p.nullifierHash, (E18 / 50n).toString()]); }
  res = await R6.handle('POST', '/relay/api/withdrawMany', { router: router6.target, items: items6, recipient: r14, relayer: relayerAddr }, 'ip-f');
  rec('V6: withdrawMany with per-note fees through the V6 router: the empty address gets 101 - 0.04', res.status === 200 && (await bal(r14)) === 101n * E18 - 2n * (E18 / 50n), res.body.gasUsed ? 'gas ' + res.body.gasUsed : res.body.error);
  res = await R6.handle('POST', '/relay/api/withdrawMany', { router: router6.target, items: items6.map((x) => x.slice(0, 6)), recipient: r14, relayer: relayerAddr }, 'ip-f');
  rec('V6: router items without the fee field are refused', res.status === 400 && /Bad item/.test(res.body.error), res.body.error);
  res = await R6.handle('POST', '/relay/api/withdraw', { pool: pools[2].target, ...p3, recipient: fresh() }, 'ip-f');
  rec('V6-only relayer: a V5 pool it was not given is refused', res.status === 400 && /Not a Latheon pool/.test(res.body.error), res.body.error);
  const RL = createRelayer({ ethers, wallet: relayerSigner, pools: [], routers: [], v6Pools: [pools6[3].target], perIpHour: 1, dailyCap: 1, exemptIps: ['ip-load'] });
  let okAll = true;
  for (let i = 0; i < 3; i++) { const n = note(); await depositTo(pools6[3], n); const r = fresh(); const p = await prove(pools6[3], n, r, { relayer: ethers.ZeroAddress, fee: 0n }); const x = await RL.handle('POST', '/relay/api/withdraw', { pool: pools6[3].target, ...p, recipient: r }, 'ip-load'); if (x.status !== 200) okAll = false; }
  rec('an exempt client IP (RELAY_EXEMPT_IPS, for our load tests) is not held to the hourly and daily limits', okAll);
  // a proof whose root the pool has forgotten (100 deposits since): refused before sending, with "Unknown root" in the
  // message, which the demo and the load test recognise and answer with a new proof
  const n15 = note(); await depositTo(pools6[3], n15); const r15 = fresh(); const p15 = await prove(pools6[3], n15, r15, { relayer: ethers.ZeroAddress, fee: 0n });
  for (let i = 0; i < 100; i++) await depositTo(pools6[3], note());
  res = await R6.handle('POST', '/relay/api/withdraw', { pool: pools6[3].target, ...p15, recipient: r15 }, 'ip-g');
  const stale = res.status === 400 && /Unknown root/.test(res.body.error);
  const p15b = await prove(pools6[3], n15, r15, { relayer: ethers.ZeroAddress, fee: 0n });
  res = await R6.handle('POST', '/relay/api/withdraw', { pool: pools6[3].target, ...p15b, recipient: r15 }, 'ip-g');
  rec('V6: a proof against a root the pool forgot (100 deposits since) is refused with "Unknown root"; a new proof for the same note is relayed', stale && res.status === 200 && (await bal(r15)) === E18, res.body.error || 'ok');
  res = await R6.handle('GET', '/relay/api/status', null, 'ip-x');
  rec('V6 status reports the minimum fee and V6 support', res.status === 200 && res.body.v6 === true && res.body.minFeeV6 === '0.01', JSON.stringify(res.body).slice(0, 140));
  rec('status tells the caller its own IP as seen by the relayer, and whether it is exempt', res.body.yourIp === 'ip-x' && res.body.exempt === false && (await RL.handle('GET', '/relay/api/status', null, 'ip-load')).body.exempt === true);

  const pass = results.filter(Boolean).length;
  console.log(`\n${pass}/${results.length} checks passed`); process.exit(pass === results.length ? 0 : 1);
})().catch((e) => { console.error(e); if (CI) console.log('::error::' + String(e && e.message || e).split('\n')[0].slice(0, 300)); process.exit(1); });
