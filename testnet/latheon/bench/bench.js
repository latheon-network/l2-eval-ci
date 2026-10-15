'use strict';
/*
 * Gas comparison on a local chain (ganache, in-process) of three ways to use the pools on a chain whose gas
 * token is the coin users hold. Testnet only, not audited. All proofs are real (withdraw_v3).
 *
 *   A  current:  WLTH wrapper + unchanged V5 pools + unchanged router   (wrap, approve, deposit / withdrawMany, unwrap)
 *   B  wrapping: unchanged V5 pools + a router that takes the coin and wraps it itself (deposit / withdrawMany, unwrap)
 *   C  native:   V5 pools and router for the native coin                 (deposit / withdrawMany)
 *
 * Each scenario uses a new depositor and a new recipient address, so storage costs are those of a first use.
 * Then security checks of C: exact amounts, router holds nothing, refusing recipient, re-entry, double spend.
 *
 *   LATHEON_REPO=/path/to/Latheon node bench/bench.js       (LATHEON_REPO supplies PoseidonT3.sol and the circuit files)
 * The native pool and router are the ones from the Latheon repo (artifacts); the wrapping router is a bench-only prototype.
 */
const fs = require('fs');
const path = require('path');
const solc = require('solc');
const ganache = require('ganache');
const { ethers, ART, E18, DENOMS, ZERO_TOP, rnd } = require('../lib');
const { commitmentOf, withdrawProof } = require('../zk');

const HERE = __dirname;
const REPO = process.env.LATHEON_REPO;
if (!REPO) { console.error('set LATHEON_REPO'); process.exit(1); }
const PORT = 8548, CHAIN_ID = 412346;
const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';   // public ganache/Hardhat test key #0

// ---- compile the prototypes with the same compiler and settings as artifacts/latheon-testnet.json
function compile() {
  const rd = (p) => fs.readFileSync(p, 'utf8');
  const sources = { 'bench/contracts/PoseidonT3.sol': { content: rd(path.join(REPO, 'contracts', 'PoseidonT3.sol')) } };
  for (const f of fs.readdirSync(path.join(HERE, 'contracts'))) sources['bench/contracts/' + f] = { content: rd(path.join(HERE, 'contracts', f)) };
  const settings = { optimizer: ART.settings.optimizer, evmVersion: ART.settings.evmVersion,
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.bytecode.linkReferences'] } } };
  const imp = (p) => { const f = path.join(HERE, '..', 'node_modules', p); return fs.existsSync(f) ? { contents: rd(f) } : { error: 'not found: ' + p }; };
  const out = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources, settings }), { import: imp }));
  const errs = (out.errors || []).filter((e) => e.severity === 'error');
  if (errs.length) { console.error(errs.map((e) => e.formattedMessage).join('\n')); process.exit(1); }
  const pick = (f, n) => { const c = out.contracts['bench/contracts/' + f][n]; return { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object, linkReferences: c.evm.bytecode.linkReferences }; };
  return {
    PoolNative: ART.contracts.PoolNative,     // from the Latheon repo, via artifacts/latheon-testnet.json
    RouterNative: ART.contracts.RouterNative,
    RouterWrapping: pick('LatheonDistributionPoolWrapping.sol', 'LatheonDistributionPoolWrapping'),
    Refusing: pick('TestRecipients.sol', 'RefusingRecipient'),
    Reentering: pick('TestRecipients.sol', 'ReenteringRecipient'),
  };
}
function link(c, poseidon) {
  let code = c.bytecode;
  for (const file of Object.keys(c.linkReferences || {})) for (const lib of Object.keys(c.linkReferences[file]))
    for (const { start, length } of c.linkReferences[file][lib]) {
      const s = 2 + start * 2; code = code.slice(0, s) + poseidon.slice(2).toLowerCase() + code.slice(s + length * 2);
    }
  return code;
}

let failed = 0;
const check = (name, cond) => { console.log((cond ? 'PASS ' : 'FAIL ') + name); if (!cond) failed++; };

(async () => {
  const B = compile();
  const server = ganache.server({ logging: { quiet: true }, chain: { chainId: CHAIN_ID, networkId: CHAIN_ID, hardfork: 'shanghai' },
    wallet: { accounts: [{ secretKey: KEY, balance: '0x' + (10n ** 9n * E18).toString(16) }] }, miner: { blockGasLimit: 60000000 } });
  await server.listen(PORT);
  const provider = new ethers.JsonRpcProvider('http://127.0.0.1:' + PORT, undefined, { cacheTimeout: -1 });
  const admin = new ethers.NonceManager(new ethers.Wallet(KEY, provider));
  const C = ART.contracts;

  const deploy = async (c, args, code, from = admin) => {
    const x = await new ethers.ContractFactory(c.abi, code || c.bytecode, from).deploy(...args);
    await x.waitForDeployment(); return new ethers.Contract(await x.getAddress(), c.abi, from);
  };
  const send = async (p) => { const rc = await (await p).wait(); return rc; };
  const fresh = async (lth) => {
    const w = ethers.Wallet.createRandom().connect(provider);
    if (lth) await send(admin.sendTransaction({ to: w.address, value: lth }));
    return w;
  };

  // shared: Poseidon, verifier
  const poseidon = await deploy(C.PoseidonT3, []);
  const verifier = await deploy(C.WithdrawVerifier, []);
  const pAddr = await poseidon.getAddress(), vAddr = await verifier.getAddress();

  // A and B: WLTH + four unchanged V5 pools (each set separate, so A and B start from empty trees too)
  async function erc20Set(RouterArt, routerArgs) {
    const wlth = await deploy(C.WrappedLTH, []);
    const pools = [];
    for (const d of DENOMS) pools.push(await deploy(C.Pool5, [await wlth.getAddress(), vAddr, d], link(C.Pool5, pAddr)));
    const pa = await Promise.all(pools.map((p) => p.getAddress()));
    const router = await deploy(RouterArt, routerArgs(await wlth.getAddress(), pa));
    return { wlth, pools, router };
  }
  const setA = await erc20Set(C.Router, (w, pa) => [w, pa]);
  const setB = await erc20Set(B.RouterWrapping, (w, pa) => [w, pa]);
  // C: native pools + native router
  const nPools = [];
  for (const d of DENOMS) nPools.push(await deploy(B.PoolNative, [vAddr, d], link(B.PoolNative, pAddr)));
  const nRouter = await deploy(B.RouterNative, [await Promise.all(nPools.map((p) => p.getAddress()))]);
  for (const p of nPools) check('native pool: zeros(8) correct (Poseidon linked)', (await p.zeros(8)) === ZERO_TOP);

  // leaves per pool address, from Deposit events of receipts we produced
  const leaves = {};
  const record = (rc, pools) => {
    for (const lg of rc.logs) {
      const i = pools.findIndex((p) => p.target.toLowerCase() === lg.address.toLowerCase());
      if (i < 0) continue;
      const ev = pools[i].interface.parseLog(lg);
      if (ev && ev.name === 'Deposit') { const a = pools[i].target.toLowerCase(); (leaves[a] = leaves[a] || [])[Number(ev.args.leafIndex)] = ev.args.commitment; }
    }
  };
  const findNote = (note, pools) => {
    const c = commitmentOf(note.sk, note.vk);
    for (let i = 0; i < pools.length; i++) { const L = leaves[pools[i].target.toLowerCase()] || []; const j = L.indexOf(c); if (j >= 0) return { pool: i, leaf: j, leaves: L }; }
    throw new Error('note not found');
  };
  const zerosOf = async (pool) => { const z = []; for (let l = 0; l < 8; l++) z.push(await pool.zeros(l)); return z; };
  const prove = async (note, pools, recipient) => {
    const f = findNote(note, pools);
    const p = await withdrawProof({ sk: note.sk, vk: note.vk, leaf: f.leaf, leaves: f.leaves, zeros: await zerosOf(pools[f.pool]), recipient });
    return { pool: f.pool, p, item: [f.pool, p.pA, p.pB, p.pC, p.root, p.nullifierHash] };
  };
  const notesFor = (n) => Array.from({ length: n }, () => ({ sk: rnd(), vk: rnd() }));
  const commits = (notes) => notes.map((n) => commitmentOf(n.sk, n.vk));

  const results = {};
  for (const [amountLth, nNotes] of [[1n, 1], [11n, 2]]) {
    const amount = amountLth * E18;
    const row = (results[amountLth + ' LTH, ' + nNotes + (nNotes === 1 ? ' note' : ' notes')] = {});

    // A: current
    {
      const u = await fresh(amount + E18), r = await fresh(E18 / 10n);   // r gets a little LTH for the unwrap (the faucet problem)
      const notes = notesFor(nNotes);
      const W = setA.wlth.connect(u), R = setA.router.connect(u);
      const g1 = (await send(W.deposit({ value: amount }))).gasUsed;
      const g2 = (await send(W.approve(setA.router.target, amount))).gasUsed;
      const rc = await send(R.deposit(amount, commits(notes))); record(rc, setA.pools);
      const items = []; for (const n of notes) items.push((await prove(n, setA.pools, r.address)).item);
      const g4 = (await send(R.withdrawMany(items, r.address))).gasUsed;
      const g5 = (await send(setA.wlth.connect(r).withdraw(amount))).gasUsed;
      row.A = { wrap: g1, approve: g2, deposit: rc.gasUsed, withdrawMany: g4, unwrap: g5 };
      check(`A ${amountLth}: recipient ends with ${amountLth} LTH more, WLTH 0`, (await setA.wlth.balanceOf(r.address)) === 0n);
    }
    // B: router wraps
    {
      const u = await fresh(amount + E18), r = await fresh(E18 / 10n);
      const notes = notesFor(nNotes);
      const R = setB.router.connect(u);
      const rc = await send(R.deposit(amount, commits(notes), { value: amount })); record(rc, setB.pools);
      check(`B ${amountLth}: router holds no WLTH and no allowance after deposit`, (await setB.wlth.balanceOf(setB.router.target)) === 0n &&
        (await Promise.all(setB.pools.map((p) => setB.wlth.allowance(setB.router.target, p.target)))).every((x) => x === 0n));
      const items = []; for (const n of notes) items.push((await prove(n, setB.pools, r.address)).item);
      const g4 = (await send(R.withdrawMany(items, r.address))).gasUsed;
      const g5 = (await send(setB.wlth.connect(r).withdraw(amount))).gasUsed;
      row.B = { deposit: rc.gasUsed, withdrawMany: g4, unwrap: g5 };
    }
    // C: native
    {
      const u = await fresh(amount + E18), r = ethers.Wallet.createRandom().address;   // r needs nothing: it receives LTH
      const notes = notesFor(nNotes);
      const R = nRouter.connect(u);
      const rc = await send(R.deposit(amount, commits(notes), { value: amount })); record(rc, nPools);
      check(`C ${amountLth}: router holds no LTH after deposit`, (await provider.getBalance(nRouter.target)) === 0n);
      const items = []; for (const n of notes) items.push((await prove(n, nPools, r)).item);
      const g4 = (await send(R.withdrawMany(items, r))).gasUsed;
      check(`C ${amountLth}: a recipient with no balance received exactly ${amountLth} LTH`, (await provider.getBalance(r)) === amount);
      row.C = { deposit: rc.gasUsed, withdrawMany: g4 };
    }
  }

  // ---- security checks of C
  console.log('\nSecurity checks of the native variant');
  const u = await fresh(1000n * E18);
  const P1 = nPools[3].connect(u), R = nRouter.connect(u);
  const reverts = async (p, why) => { try { await (await p).wait(); return false; } catch (e) { return !why || String(e.shortMessage || e.message).includes(why) || JSON.stringify(e).includes(why); } };
  check('pool deposit with less than the denomination reverts', await reverts(P1.deposit(commitmentOf(rnd(), rnd()), { value: E18 - 1n }), 'Wrong amount'));
  check('pool deposit with more than the denomination reverts', await reverts(P1.deposit(commitmentOf(rnd(), rnd()), { value: E18 + 1n }), 'Wrong amount'));
  check('router deposit with msg.value != amount reverts', await reverts(R.deposit(11n * E18, commits(notesFor(2)), { value: 10n * E18 }), 'msg.value must equal amount'));
  check('router deposit of 0 reverts', await reverts(R.deposit(0, [], { value: 0 }), 'Zero amount'));
  check('plain transfer to the router reverts (no receive)', await reverts(u.sendTransaction({ to: nRouter.target, value: 1n })));
  check('plain transfer to a pool reverts (no receive)', await reverts(u.sendTransaction({ to: nPools[3].target, value: 1n })));

  // refusing recipient: the withdrawal reverts, the note stays spendable
  const refuser = await deploy(B.Refusing, []);
  const note1 = notesFor(1)[0];
  record(await send(P1.deposit(commitmentOf(note1.sk, note1.vk), { value: E18 })), nPools);
  const pr = await prove(note1, nPools, refuser.target);
  check('withdraw to a recipient that refuses the coin reverts', await reverts(P1.withdraw(pr.p.pA, pr.p.pB, pr.p.pC, pr.p.root, pr.p.nullifierHash, refuser.target), 'Native transfer failed'));
  check('… and the note is not marked spent', (await nPools[3].nullifierHashes(pr.p.nullifierHash)) === false);
  const okAddr = ethers.Wallet.createRandom().address;
  const pr2 = await prove(note1, nPools, okAddr);
  await send(P1.withdraw(pr2.p.pA, pr2.p.pB, pr2.p.pC, pr2.p.root, pr2.p.nullifierHash, okAddr));
  check('… then a new proof for another recipient withdraws it', (await provider.getBalance(okAddr)) === E18);
  check('the refused proof cannot be redirected to another address', await reverts(P1.withdraw(pr.p.pA, pr.p.pB, pr.p.pC, pr.p.root, pr.p.nullifierHash, okAddr)));

  // re-entry: the recipient re-enters withdraw with the same proof while being paid
  const re = await deploy(B.Reentering, []);
  const note2 = notesFor(1)[0];
  record(await send(P1.deposit(commitmentOf(note2.sk, note2.vk), { value: E18 })), nPools);
  const prR = await prove(note2, nPools, re.target);
  await send(re.arm(nPools[3].target, prR.p.pA, prR.p.pB, prR.p.pC, prR.p.root, prR.p.nullifierHash));
  const before = await provider.getBalance(nPools[3].target);
  await send(P1.withdraw(prR.p.pA, prR.p.pB, prR.p.pC, prR.p.root, prR.p.nullifierHash, re.target));
  check('re-entering recipient: paid once', (await re.payments()) === 1n && (await provider.getBalance(re.target)) === E18);
  check('… its re-entry was refused with "Note already spent"', (await re.reentrySucceeded()) === false && (await re.reentryError()) === 'Note already spent');
  check('… the pool lost exactly one denomination', before - (await provider.getBalance(nPools[3].target)) === E18);
  check('double spend of the same proof reverts', await reverts(P1.withdraw(prR.p.pA, prR.p.pB, prR.p.pC, prR.p.root, prR.p.nullifierHash, re.target), 'Note already spent'));

  // pool accounting: balance = denomination × (deposits − withdrawals) for every native pool
  let acc = true;
  for (const p of nPools) {
    const d = await p.DENOMINATION(), n = BigInt(await p.nextIndex());
    const w = BigInt((await p.queryFilter(p.filters.Withdrawal(), 0)).length);
    if ((await provider.getBalance(p.target)) !== d * (n - w)) acc = false;
  }
  check('every native pool holds exactly denomination × (deposits − withdrawals)', acc);
  check('router withdrawMany with an unknown pool index reverts', await reverts(R.withdrawMany([[4, pr.p.pA, pr.p.pB, pr.p.pC, pr.p.root, pr.p.nullifierHash]], okAddr), 'Unknown pool'));

  // ---- report
  console.log('\nGas (local ganache, shanghai rules; execution gas only, no L1 data fee):');
  const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0n);
  for (const [k, row] of Object.entries(results)) {
    console.log('\n' + k);
    for (const v of ['A', 'B', 'C']) console.log(`  ${v}  ${Object.entries(row[v]).map(([s, g]) => s + ' ' + g).join(', ')}  | total ${sum(row[v])}  (${Object.keys(row[v]).length} tx)`);
  }
  fs.writeFileSync(path.join(HERE, 'bench-result.json'), JSON.stringify(results, (k, v) => (typeof v === 'bigint' ? Number(v) : v), 1) + '\n');
  await server.close();
  console.log('\n' + (failed ? failed + ' check(s) failed' : 'All bench checks passed'));
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
