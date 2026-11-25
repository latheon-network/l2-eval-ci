'use strict';
/*
 * Local test of the relayer with the V8 contracts and REAL withdraw_v6 proofs (development keys from the Latheon repo,
 * LATHEON_REPO, default ../../../Latheon) on ganache, through createRelayer with its own wallet:
 *   withdraw with no fee and with a fee to this relayer, payment reference and destination chain bound into the proof;
 *   refusals (fee to another relayer, changed payment reference, other destination chain, spent note, foreign pool);
 *   contract recipients: an ordinary contract wallet is paid, a gas burner and a refuser are refused before sending;
 *   withdrawMany through the V8 router, with a note already spent being skipped; a delayed V8 request.
 *   LATHEON_REPO=/path/to/Latheon node test-v8.js
 */
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const solc = require('solc-0839'), ganache = require('ganache'), { ethers } = require('ethers'), snarkjs = require('snarkjs');
const { poseidon2, poseidon3 } = require('poseidon-lite');
const { createRelayer } = require('./relayer.js');

const REPO = path.resolve(process.env.LATHEON_REPO || path.join(__dirname, '..', '..', '..', 'Latheon'));
const rd = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');
const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n, E18 = 10n ** 18n, LEVELS = 20, CHAIN = 60531373273;
const rnd = () => BigInt('0x' + crypto.randomBytes(31).toString('hex')) % P;
const tag = (s) => BigInt(ethers.keccak256(ethers.toUtf8Bytes(s))) % P;
const TAG = { C: tag('latheon.v8.commit'), N: tag('latheon.v8.null') };
const abi = ethers.AbiCoder.defaultAbiCoder();
const extHash = (e) => BigInt(ethers.keccak256(abi.encode(['address', 'address', 'uint256', 'bytes32', 'uint256'], [e.recipient, e.relayer, e.fee, e.paymentRef, e.destChainId]))) % P;
const ref = () => ethers.hexlify(crypto.randomBytes(32));
const CI = !!process.env.GITHUB_ACTIONS;
const results = []; const rec = (n, ok, note) => { results.push(ok); console.log((ok ? 'ok   ' : 'FAIL ') + n + (note ? '   [' + note + ']' : '')); if (!ok && CI) console.log(`::error::${n} [${note || ''}]`); };

(async () => {
  const src = (f) => ({ content: rd('contracts/' + f) });
  const out = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources: {
    'ILatheonV8.sol': src('ILatheonV8.sol'), 'PoseidonT3.sol': src('PoseidonT3.sol'), 'P8.sol': src('LatheonShieldedPoolV8Native.sol'), 'R8.sol': src('LatheonDistributionPoolV8Native.sol'), 'V8.sol': src('WithdrawVerifierV6.sol'),
    'X.sol': { content: `// SPDX-License-Identifier: MIT
pragma solidity 0.8.39;
contract Refuser { receive() external payable { revert("no"); } }
contract Burner { uint256 public x; receive() external payable { while (true) { x++; } } }
contract Wallet { uint256 public got; receive() external payable { got += msg.value; } }
contract Sneaky { receive() external payable { require(tx.gasprice == 0, "only in simulation"); } }` } },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'paris', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.bytecode.linkReferences'] } } } })));
  if ((out.errors || []).some((e) => e.severity === 'error')) throw new Error(out.errors.map((e) => e.formattedMessage).join('\n'));
  const C = { Pool: out.contracts['P8.sol'].LatheonShieldedPoolV8Native, Router: out.contracts['R8.sol'].LatheonDistributionPoolV8Native, T3: out.contracts['PoseidonT3.sol'].PoseidonT3, Ver: out.contracts['V8.sol'].WithdrawVerifierV6,
    Ref: out.contracts['X.sol'].Refuser, Burn: out.contracts['X.sol'].Burner, Wal: out.contracts['X.sol'].Wallet, Sneaky: out.contracts['X.sol'].Sneaky };
  const link = (c, libs) => { let code = c.evm.bytecode.object; const refs = c.evm.bytecode.linkReferences; for (const f in refs) for (const l in refs[f]) for (const { start, length } of refs[f][l]) code = code.slice(0, start * 2) + libs[l].slice(2).toLowerCase() + code.slice(start * 2 + length * 2); return code; };
  const gp = ganache.provider({ logging: { quiet: true }, chain: { hardfork: 'shanghai', chainId: CHAIN }, wallet: { deterministic: true, totalAccounts: 4, defaultBalance: 100000 }, miner: { blockGasLimit: 60000000 } });
  const provider = new ethers.BrowserProvider(gp);
  const [deployer, relayerSigner, user] = await Promise.all([0, 1, 2].map((i) => provider.getSigner(i)));
  const deploy = async (c, args = [], libs = {}) => { const x = await new ethers.ContractFactory(c.abi, '0x' + link(c, libs), deployer).deploy(...args); await x.waitForDeployment(); return x; };
  const t3 = await deploy(C.T3), ver = await deploy(C.Ver);
  const libs = { PoseidonT3: await t3.getAddress() };
  const pools = []; for (const d of [100n, 50n, 10n, 1n]) pools.push(await deploy(C.Pool, [await ver.getAddress(), d * E18, ethers.ZeroAddress], libs));
  const router = await deploy(C.Router, [await Promise.all(pools.map((p) => p.getAddress()))]);
  const strayPool = await deploy(C.Pool, [await ver.getAddress(), 10n * E18, ethers.ZeroAddress], libs);
  const refuser = await deploy(C.Ref), burner = await deploy(C.Burn), cwallet = await deploy(C.Wal), sneaky = await deploy(C.Sneaky);

  const leaves = new Map();
  const note = () => { const sk = rnd(), vk = rnd(); return { sk, vk, commitment: poseidon3([TAG.C, sk, vk]) }; };
  const depositTo = async (pool, n) => { const rc = await (await pool.connect(user).deposit(n.commitment, { value: await pool.DENOMINATION() })).wait();
    const k = pool.target.toLowerCase(); if (!leaves.has(k)) leaves.set(k, []); for (const lg of rc.logs) { const ev = pool.interface.parseLog(lg); if (ev && ev.name === 'Deposit') leaves.get(k)[Number(ev.args.leafIndex)] = ev.args.commitment; } };
  const W = path.join(REPO, 'circuits/build/withdraw_v6/withdraw_v6.wasm'), Z = path.join(REPO, 'circuits/build/withdraw_v6/withdraw_v6_final.zkey');
  const zerosJs = [0n]; for (let i = 0; i < LEVELS; i++) zerosJs.push(poseidon2([zerosJs[i], zerosJs[i]]));
  // ext = { recipient, relayer, fee, paymentRef, destChainId }
  async function prove(pool, n, ext) {
    const L = leaves.get(pool.target.toLowerCase()), leaf = L.indexOf(n.commitment);
    const levels = [L.slice()];
    for (let l = 0; l < LEVELS; l++) { const cur = levels[l], up = []; for (let j = 0; j < Math.max(1, Math.ceil(cur.length / 2)); j++) up.push(poseidon2([cur[2 * j] ?? zerosJs[l], cur[2 * j + 1] ?? zerosJs[l]])); levels.push(up); }
    const el = [], idx = []; let k = leaf; for (let l = 0; l < LEVELS; l++) { el.push((levels[l][k ^ 1] ?? zerosJs[l]).toString()); idx.push(k & 1); k >>= 1; }
    const ctx = BigInt(await pool.ctx());
    const input = { root: levels[LEVELS][0].toString(), nullifierHash: poseidon3([TAG.N, n.sk, ctx]).toString(), ctx: ctx.toString(), extDataHash: extHash(ext).toString(),
      spendKey: n.sk.toString(), viewKey: n.vk.toString(), pathElements: el, pathIndices: idx };
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, W, Z);
    const [pA, pB, pC, pub] = JSON.parse('[' + (await snarkjs.groth16.exportSolidityCallData(proof, publicSignals)) + ']');
    return { pA, pB, pC, root: pub[0], nullifierHash: pub[1] };
  }
  const relayerAddr = await relayerSigner.getAddress();
  const fresh = () => ethers.Wallet.createRandom().address;
  const bal = (a) => provider.getBalance(a);
  let clockMs = Date.now();
  const jobsStore = { list: [], load() { return this.list; }, save(l) { this.list = l; } };
  const R = createRelayer({ ethers, wallet: relayerSigner, pools: [], routers: [], v8Pools: await Promise.all(pools.map((p) => p.getAddress())), v8Routers: [await router.getAddress()],
    perIpHour: 50, dailyCap: 100, minFee: E18 / 100n, store: jobsStore, now: () => clockMs, maxDelaySeconds: 3600, chainFailsPerDay: 2 });
  const body = (pool, p, ext) => ({ pool: pool.target, ...p, recipient: ext.recipient, relayer: ext.relayer, fee: ext.fee.toString(), paymentRef: ext.paymentRef, destChainId: ext.destChainId.toString() });
  const extOf = (o = {}) => ({ recipient: fresh(), relayer: ethers.ZeroAddress, fee: 0n, paymentRef: ref(), destChainId: BigInt(CHAIN), ...o });

  // 1. no fee, to an empty address
  const n1 = note(); await depositTo(pools[2], n1); const e1 = extOf(); const p1 = await prove(pools[2], n1, e1);
  let res = await R.handle('POST', '/relay/api/withdraw', body(pools[2], p1, e1), 'ip-a');
  rec('V8: a no-fee withdrawal is relayed; the empty address gets exactly 10; the payment reference is bound', res.status === 200 && (await bal(e1.recipient)) === 10n * E18, res.body.gasUsed ? 'gas ' + res.body.gasUsed : res.body.error);
  res = await R.handle('POST', '/relay/api/withdraw', body(pools[2], p1, e1), 'ip-a');
  rec('V8: the same note again is refused before sending', res.status === 400 && /already spent/i.test(res.body.error), res.body.error);
  // 2. fee to this relayer
  const n2 = note(); await depositTo(pools[2], n2); const e2 = extOf({ relayer: relayerAddr, fee: E18 / 10n }); const p2 = await prove(pools[2], n2, e2);
  res = await R.handle('POST', '/relay/api/withdraw', body(pools[2], p2, e2), 'ip-a');
  rec('V8: a withdrawal naming this relayer with a fee: recipient gets 9.9', res.status === 200 && (await bal(e2.recipient)) === 10n * E18 - E18 / 10n, res.body.error || 'ok');
  // 3. refusals before sending
  const n3 = note(); await depositTo(pools[3], n3);
  const e3o = extOf({ relayer: fresh(), fee: E18 / 10n }); const p3o = await prove(pools[3], n3, e3o);
  res = await R.handle('POST', '/relay/api/withdraw', body(pools[3], p3o, e3o), 'ip-b');
  rec('V8: a fee to another relayer is refused', res.status === 400 && /only sends withdrawals that name it/.test(res.body.error), res.body.error);
  const e3 = extOf(); const p3 = await prove(pools[3], n3, e3);
  const b0 = await bal(relayerAddr);
  res = await R.handle('POST', '/relay/api/withdraw', { ...body(pools[3], p3, e3), paymentRef: ref() }, 'ip-b');
  rec('V8: a changed payment reference is refused before sending, no gas', res.status === 400 && /Invalid proof/i.test(res.body.error) && (await bal(relayerAddr)) === b0, res.body.error);
  res = await R.handle('POST', '/relay/api/withdraw', { ...body(pools[3], p3, e3), destChainId: '421614' }, 'ip-b');
  rec('V8: another destination chain is refused before sending', res.status === 400 && /Wrong destination chain/.test(res.body.error), res.body.error);
  res = await R.handle('POST', '/relay/api/withdraw', { ...body(pools[3], p3, e3), paymentRef: '0x12' }, 'ip-b');
  rec('V8: a malformed payment reference is refused', res.status === 400 && /paymentRef/.test(res.body.error), res.body.error);
  res = await R.handle('POST', '/relay/api/withdraw', body(strayPool, p3, e3), 'ip-b');
  rec('V8: a pool that is not ours is refused', res.status === 400 && /Not a Latheon pool/.test(res.body.error), res.body.error);
  // 4. contract recipients
  const n4 = note(); await depositTo(pools[3], n4); const e4 = extOf({ recipient: cwallet.target }); const p4 = await prove(pools[3], n4, e4);
  res = await R.handle('POST', '/relay/api/withdraw', body(pools[3], p4, e4), 'ip-c');
  rec('V8: a contract wallet recipient is paid (the payout gas limit protects the relayer)', res.status === 200 && (await cwallet.got()) === E18, res.body.error || 'ok');
  for (const [label, c] of [['burns all gas', burner], ['refuses the coin', refuser]]) {
    const n = note(); await depositTo(pools[3], n); const e = extOf({ recipient: c.target }); const p = await prove(pools[3], n, e);
    const bb = await bal(relayerAddr);
    res = await R.handle('POST', '/relay/api/withdraw', body(pools[3], p, e), 'ip-c');
    rec(`V8: a contract recipient that ${label} is refused before sending; no gas; the note stays unspent`, res.status === 400 && /Native transfer failed/.test(res.body.error) && (await bal(relayerAddr)) === bb && !(await pools[3].nullifierHashes(p.nullifierHash)), res.body.error);
  }
  // 4b. R-1: a contract that pays in the simulation (gas price 0) and reverts in the real transaction
  const sn = []; for (let i = 0; i < 2; i++) { const n = note(); await depositTo(pools[3], n); const e = extOf({ recipient: sneaky.target }); sn.push({ e, p: await prove(pools[3], n, e) }); }
  const capBefore = (await R.handle('GET', '/relay/api/status', null, 'ip-x')).body.relayedLast24h;
  res = await R.handle('POST', '/relay/api/withdraw', body(pools[3], sn[0].p, sn[0].e), 'ip-r');
  rec('R-1: a recipient that reverts only in the real transaction: the relayer sends once and reports the on-chain failure', res.status === 502 && /failed on-chain/.test(res.body.error), res.body.error);
  const bR = await bal(relayerAddr);
  res = await R.handle('POST', '/relay/api/withdraw', body(pools[3], sn[0].p, sn[0].e), 'ip-r2');
  rec('R-1: the same note again (even from another IP) is refused before sending; no gas', res.status === 400 && /already failed on chain/.test(res.body.error) && (await bal(relayerAddr)) === bR && !(await pools[3].nullifierHashes(sn[0].p.nullifierHash)), res.body.error);
  rec('R-1: the failed transaction does not use a slot of the daily cap', (await R.handle('GET', '/relay/api/status', null, 'ip-x')).body.relayedLast24h === capBefore);
  res = await R.handle('POST', '/relay/api/withdraw', body(pools[3], sn[1].p, sn[1].e), 'ip-r3');
  const nw = note(); await depositTo(pools[3], nw); const ew = extOf({ recipient: cwallet.target }); const pw = await prove(pools[3], nw, ew);
  res = await R.handle('POST', '/relay/api/withdraw', body(pools[3], pw, ew), 'ip-r4');
  const st2 = (await R.handle('GET', '/relay/api/status', null, 'ip-x')).body;
  rec('R-1: after RELAY_CHAIN_FAILS_PER_DAY on-chain failures (2 here) contract recipients are refused, status says paused', res.status === 400 && /paused/.test(res.body.error) && st2.contractRecipients === 'paused' && st2.chainFailsLast24h === 2, res.body.error);
  const eo = extOf(); const po = await prove(pools[3], nw, eo);
  res = await R.handle('POST', '/relay/api/withdraw', body(pools[3], po, eo), 'ip-r4');
  rec('R-1: ordinary addresses are still relayed', res.status === 200 && (await bal(eo.recipient)) === E18, res.body.error || 'ok');

  // 5. withdrawMany: three notes, one already withdrawn directly → skipped
  const ns = [note(), note(), note()]; await depositTo(pools[0], ns[0]); await depositTo(pools[1], ns[1]); await depositTo(pools[3], ns[2]);
  const rm = fresh(); const items = [];
  for (const [i, pi] of [[0, 0], [1, 1], [2, 3]]) {
    const e = extOf({ recipient: rm, relayer: relayerAddr, fee: E18 / 10n }); const p = await prove(pools[pi], ns[i], e);
    items.push([pi, [p.pA, p.pB, p.pC], p.root, p.nullifierHash, (E18 / 10n).toString(), e.paymentRef]);
  }
  const eD = extOf(); const pD = await prove(pools[3], ns[2], eD);
  await (await pools[3].connect(user).withdraw([pD.pA, pD.pB, pD.pC], pD.root, pD.nullifierHash, [eD.recipient, eD.relayer, eD.fee, eD.paymentRef, eD.destChainId])).wait();
  res = await R.handle('POST', '/relay/api/withdrawMany', { router: router.target, items, recipient: rm, relayer: relayerAddr }, 'ip-d');
  rec('V8 withdrawMany: 3 notes, one already withdrawn is skipped by the router, the other two pay 150 − 0.2', res.status === 200 && (await bal(rm)) === 150n * E18 - 2n * E18 / 10n, res.body.gasUsed ? 'gas ' + res.body.gasUsed : res.body.error);
  res = await R.handle('POST', '/relay/api/withdrawMany', { router: router.target, items, recipient: rm, relayer: relayerAddr }, 'ip-d');
  rec('V8 withdrawMany: a batch in which everything is spent is refused before sending', res.status === 400 && /Nothing to withdraw/.test(res.body.error), res.body.error);
  res = await R.handle('POST', '/relay/api/withdrawMany', { router: router.target, items: [[0, items[0][1][0], items[0][1][1], items[0][1][2], items[0][2], items[0][3]]], recipient: rm }, 'ip-d');
  rec('V8 withdrawMany: an item in the V7 shape is refused', res.status === 400 && /Bad item/.test(res.body.error), res.body.error);
  // 6. delayed V8 request
  const n6 = note(); await depositTo(pools[3], n6); const e6 = extOf(); const p6 = await prove(pools[3], n6, e6);
  res = await R.handle('POST', '/relay/api/withdraw', { ...body(pools[3], p6, e6), delay: { withinSeconds: 600 } }, 'ip-e');
  const id = res.body.id;
  rec('V8: a delayed request is accepted (202) and stored with its payment reference and destination chain', res.status === 202 && jobsStore.list.some((j) => j.id === id && j.body.paymentRef === e6.paymentRef && String(j.body.destChainId) === String(CHAIN)), JSON.stringify(res.body).slice(0, 80));
  clockMs += 601e3; await R.runDue();
  res = await R.handle('GET', '/relay/api/scheduled/' + id, null, 'ip-e');
  rec('V8: … and sent when due; the empty address gets 1', res.body.state === 'sent' && (await bal(e6.recipient)) === E18, JSON.stringify(res.body));
  res = await R.handle('GET', '/relay/api/status', null, 'ip-x');
  rec('status says V8 is relayed (contract recipients paused after the R-1 failures above)', res.status === 200 && res.body.v8 === true && res.body.contractRecipients === 'paused', JSON.stringify(res.body).slice(0, 120));

  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
