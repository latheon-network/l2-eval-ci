'use strict';
/*
 * Latheon L2 evaluation run.
 *
 * Deploys the repository contracts (unchanged) to one network and measures, with real Groth16 proofs:
 *   deploys, a direct V5 deposit and withdrawal, router deposits of 1 / 3 / 14 / 32 notes,
 *   withdrawMany of 3 and 16 notes. Records gas, gas price and fee of every transaction.
 *
 *   node eval.js <network>            run (continues where a previous run stopped)
 *   node eval.js <network> --fresh    start again from scratch
 *   node eval.js <network> --check    only check the connection, chain id and balance
 *
 * Private key: environment variable LATHEON_EVAL_KEY (use a separate test wallet). It is never written to disk.
 * Circuit files: <repo>/circuits/build/withdraw_v3/, repo = LATHEON_REPO or ../latheon next to this folder.
 * state/<network>.json holds addresses and the test notes (secrets of test deposits): keep it out of git.
 * results/<network>-<time>.json holds only public data (addresses, tx hashes, gas, fees).
 * Testnets only.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ethers } = require('ethers');
const zk = require('zksync-ethers');
const snarkjs = require('snarkjs');
const { poseidon2 } = require('poseidon-lite');

const HERE = __dirname;
const NETWORKS = JSON.parse(fs.readFileSync(path.join(HERE, 'networks.json'), 'utf8'));
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const E18 = 10n ** 18n;
const DENOMS = [100n * E18, 50n * E18, 10n * E18, 1n * E18];
const LEVELS = 8;

const args = process.argv.slice(2);
const netName = args.find((a) => !a.startsWith('--'));
const FRESH = args.includes('--fresh');
const CHECK = args.includes('--check');

function die(msg) { console.error('\nОШИБКА: ' + msg); process.exit(1); }
const rnd = () => BigInt('0x' + crypto.randomBytes(31).toString('hex')) % FIELD;
const short = (h) => (h ? h.slice(0, 10) + '…' : '');
const fmtGas = (g) => (g == null ? '—' : BigInt(g).toLocaleString('ru-RU'));
const fmtEth = (wei) => (wei == null ? '—' : ethers.formatEther(BigInt(wei)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Reads a line without echoing it (the key never appears on screen or in shell history).
function askHidden(question) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(question);
    if (!stdin.isTTY) {
      let buf = '';
      stdin.setEncoding('utf8');
      const onData = (c) => { buf += c; if (/\r?\n/.test(buf)) { stdin.removeListener('data', onData); stdin.pause(); process.stdout.write('\n'); resolve(buf.split(/\r?\n/)[0].trim()); } };
      stdin.on('data', onData);
      stdin.once('end', () => resolve(buf.trim()));
      return;
    }
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    let s = '';
    const onKey = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false); stdin.pause(); stdin.removeListener('data', onKey);
          process.stdout.write('\n(получено символов: ' + s.trim().length + ')\n');
          return resolve(s.trim());
        }
        if (ch === '\u0003') { process.stdout.write('\n'); process.exit(1); }
        if (ch === '\u007f' || ch === '\b') { s = s.slice(0, -1); continue; }
        s += ch;
      }
    };
    stdin.on('data', onKey);
  });
}

async function retry(fn, label, tries = 4) {
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (e) {
      const m = String(e && (e.shortMessage || e.message) || e);
      const transient = /coalesce|timeout|ETIMEDOUT|ECONNRESET|socket|hang up|503|502|504|429|rate limit|network|Service Unavailable/i.test(m);
      if (!transient || i >= tries) throw e;
      console.log(`   (повтор ${i}: ${label}: ${m.slice(0, 80)})`);
      await sleep(1500 * i);
    }
  }
}

async function main() {
  if (!netName || !NETWORKS[netName]) die('укажите сеть: ' + Object.keys(NETWORKS).join(', '));
  const net = NETWORKS[netName];
  let key = (process.env.LATHEON_EVAL_KEY || '').trim();
  if (!key) key = await askHidden('Вставьте приватный ключ тестового кошелька и нажмите Enter (символы не отображаются): ');
  if (/^[0-9a-fA-F]{64}$/.test(key)) key = '0x' + key;
  if (/^(0x)?[0-9a-fA-F]{40}$/.test(key)) die('это адрес кошелька, а нужен приватный ключ (64 шестнадцатеричных символа)');
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) die('ключ пустой или в неверном формате: нужно 64 шестнадцатеричных символа (можно с 0x в начале), получено символов: ' + key.length);
  const REPO = process.env.LATHEON_REPO || path.join(HERE, '..', 'latheon');
  const W3 = path.join(REPO, 'circuits', 'build', 'withdraw_v3');
  const wasm = path.join(W3, 'withdraw_v3.wasm'), zkey = path.join(W3, 'withdraw_v3_final.zkey');
  if (!CHECK && (!fs.existsSync(wasm) || !fs.existsSync(zkey))) die('не найдены файлы схемы в ' + W3 + ' (задайте LATHEON_REPO)');

  const art = JSON.parse(fs.readFileSync(path.join(HERE, 'artifacts', net.vm === 'eravm' ? 'eravm.json' : 'evm.json'), 'utf8'));
  const provider = net.vm === 'eravm' ? new zk.Provider(net.rpc) : new ethers.JsonRpcProvider(net.rpc, undefined, { cacheTimeout: -1 });
  const wallet = net.vm === 'eravm' ? new zk.Wallet(key, provider) : new ethers.Wallet(key, provider);
  const me = wallet.address;

  const chainId = Number((await retry(() => provider.getNetwork(), 'chainId')).chainId);
  if (net.chainId && chainId !== net.chainId) die(`RPC отдаёт chainId ${chainId}, ожидался ${net.chainId}`);
  const bal = await retry(() => provider.getBalance(me), 'balance');
  console.log(`Сеть: ${netName} (chainId ${chainId}, ${net.vm === 'eravm' ? 'EraVM, байткод zksolc' : 'EVM'})`);
  console.log(`Кошелёк: ${me}`);
  console.log(`Баланс: ${ethers.formatEther(bal)} ${net.symbol || 'ETH'}${net.minBalance ? ' (рекомендуется не меньше ' + net.minBalance + ')' : ''}`);
  if (CHECK) { console.log('\nПроверка пройдена.'); return; }
  if (bal === 0n) die('на кошельке нет средств на газ');

  // ---------------------------------------------------------------- state
  const stateDir = path.join(HERE, 'state'); fs.mkdirSync(stateDir, { recursive: true });
  const statePath = path.join(stateDir, netName + '.json');
  let st = (!FRESH && fs.existsSync(statePath)) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : null;
  if (st && (st.chainId !== chainId || st.wallet !== me)) die('state/' + netName + '.json от другой сети или кошелька; запустите с --fresh');
  if (!st) st = { network: netName, chainId, wallet: me, vm: net.vm, compiler: art.compiler, started: new Date().toISOString(), addr: {}, steps: {}, notes: [] };
  const save = () => fs.writeFileSync(statePath, JSON.stringify(st, null, 1));
  save();

  async function record(name, txOrPromise, extra = {}) {
    const tx = await (typeof txOrPromise === 'function' ? retry(txOrPromise, name) : txOrPromise);
    const rc = await retry(() => tx.wait(), 'receipt');
    const raw = await retry(() => provider.send('eth_getTransactionReceipt', [rc.hash]), 'raw receipt').catch(() => null);
    const gasPrice = rc.gasPrice ?? (raw && raw.effectiveGasPrice ? BigInt(raw.effectiveGasPrice) : null);
    const r = { ok: rc.status === 1, tx: rc.hash, block: rc.blockNumber, gasUsed: rc.gasUsed.toString(),
      gasPrice: gasPrice == null ? null : gasPrice.toString(), fee: gasPrice == null ? null : (rc.gasUsed * gasPrice).toString(), ...extra };
    if (raw && raw.gasUsedForL1 != null) r.gasUsedForL1 = BigInt(raw.gasUsedForL1).toString();
    st.steps[name] = r; save();
    console.log(`   ✔ ${name}: газ ${fmtGas(r.gasUsed)}${r.gasUsedForL1 ? ' (из них за L1 ' + fmtGas(r.gasUsedForL1) + ')' : ''}, комиссия ${fmtEth(r.fee)} ${net.symbol || 'ETH'}  ${net.explorer ? net.explorer + rc.hash : rc.hash}`);
    if (rc.status !== 1) throw new Error(name + ': транзакция откатилась');
    return rc;
  }
  function fail(name, e) {
    const m = String(e && (e.shortMessage || e.reason || e.message) || e).slice(0, 300);
    st.steps[name] = { ok: false, error: m }; save();
    console.log(`   ✘ ${name}: ${m}`);
  }
  const done = (name) => st.steps[name] && st.steps[name].ok;

  // ---------------------------------------------------------------- deploy
  async function deploy(name, c, ctorArgs, bytecode) {
    if (st.addr[name]) return st.addr[name];
    const code = bytecode || c.bytecode;
    const f = net.vm === 'eravm' ? new zk.ContractFactory(c.abi, code, wallet) : new ethers.ContractFactory(c.abi, code, wallet);
    const x = await f.deploy(...ctorArgs);
    const rc = await record('deploy ' + name, x.deploymentTransaction());
    st.addr[name] = rc.contractAddress || (await x.getAddress()); save();
    return st.addr[name];
  }
  const C = art.contracts;
  console.log('\n1. Деплой контрактов (исходники репозитория без изменений)');
  const poseidon = await deploy('PoseidonT3', C.PoseidonT3, []);
  const verifier = await deploy('Verifier', C.Verifier, []);
  const token = await deploy('Token', C.Token, [me]);
  let poolCode;
  if (net.vm === 'eravm') {
    poolCode = C.Pool5.bytecode.replace(art.libraryPlaceholder.slice(2), poseidon.slice(2).toLowerCase());
  } else {
    poolCode = C.Pool5.bytecode;
    for (const f in C.Pool5.linkReferences) for (const l in C.Pool5.linkReferences[f]) for (const { start, length } of C.Pool5.linkReferences[f][l])
      poolCode = poolCode.slice(0, 2 + start * 2) + poseidon.slice(2).toLowerCase() + poolCode.slice(2 + start * 2 + length * 2);
  }
  const poolAddrs = [];
  for (let i = 0; i < 4; i++) poolAddrs.push(await deploy('Pool' + (DENOMS[i] / E18), C.Pool5, [token, verifier, DENOMS[i]], poolCode));
  const routerAddr = await deploy('Router', C.Router, [token, poolAddrs]);

  const T = new ethers.Contract(token, C.Token.abi, wallet);
  const P = poolAddrs.map((a) => new ethers.Contract(a, C.Pool5.abi, wallet));
  const R = new ethers.Contract(routerAddr, C.Router.abi, wallet);
  const V = new ethers.Contract(verifier, C.Verifier.abi, wallet);
  for (let i = 0; i < 4; i++) {
    const d = await retry(() => P[i].DENOMINATION(), 'denom');
    if (d !== DENOMS[i]) die('пул ' + i + ' имеет номинал ' + d);
  }

  // ---------------------------------------------------------------- notes, tree, proofs
  const newNote = () => { const sk = rnd(), vk = rnd(); return { sk: sk.toString(), vk: vk.toString(), commitment: poseidon2([poseidon2([sk, vk]), 0n]).toString() }; };
  function placeNotes(rc, notes) {
    const byC = new Map(notes.map((n) => [n.commitment, n]));
    for (const log of rc.logs) {
      const i = poolAddrs.findIndex((a) => a.toLowerCase() === log.address.toLowerCase());
      if (i < 0) continue;
      let ev; try { ev = P[i].interface.parseLog(log); } catch (e) { continue; }
      if (!ev || ev.name !== 'Deposit') continue;
      const n = byC.get(ev.args.commitment.toString());
      if (n) { n.pool = i; n.leaf = Number(ev.args.leafIndex); n.spent = false; }
    }
    if (notes.some((n) => n.pool == null)) throw new Error('не все ноты найдены в событиях Deposit');
    st.notes.push(...notes); save();
  }
  const zerosCache = {};
  async function treeOf(i) {
    if (!zerosCache[i]) { zerosCache[i] = []; for (let l = 0; l < LEVELS; l++) zerosCache[i].push(await retry(() => P[i].zeros(l), 'zeros')); }
    const zeros = zerosCache[i];
    const mine = st.notes.filter((n) => n.pool === i).sort((a, b) => a.leaf - b.leaf);
    const next = Number(await retry(() => P[i].nextIndex(), 'nextIndex'));
    let leaves = new Array(next).fill(null);
    for (const n of mine) leaves[n.leaf] = BigInt(n.commitment);
    if (leaves.some((x) => x === null)) {   // someone else deposited into this pool: read all Deposit events
      const from = st.steps['deploy Pool' + (DENOMS[i] / E18)].block;
      const logs = await retry(() => P[i].queryFilter(P[i].filters.Deposit(), from), 'logs');
      leaves = new Array(next).fill(null);
      for (const l of logs) leaves[Number(l.args.leafIndex)] = BigInt(l.args.commitment);
      if (leaves.some((x) => x === null)) throw new Error('не удалось восстановить дерево пула ' + i);
    }
    const levels = [leaves];
    for (let l = 0; l < LEVELS; l++) {
      const cur = levels[l], up = [];
      for (let j = 0; j < Math.max(1, Math.ceil(cur.length / 2)); j++) up.push(poseidon2([cur[2 * j] ?? zeros[l], cur[2 * j + 1] ?? zeros[l]]));
      levels.push(up);
    }
    const root = levels[LEVELS][0];
    const onChain = await retry(async () => P[i].roots(await P[i].currentRootIndex()), 'root');
    if (root !== onChain) throw new Error('корень дерева пула ' + i + ' не совпал с контрактом');
    return { root, path: (leaf) => { const el = [], idx = []; let k = leaf;
      for (let l = 0; l < LEVELS; l++) { el.push((levels[l][k ^ 1] ?? zeros[l]).toString()); idx.push(k & 1); k >>= 1; } return { el, idx }; } };
  }
  let vkey;
  async function proveNote(n, recipient) {
    const t = await treeOf(n.pool);
    const { el, idx } = t.path(n.leaf);
    const input = { root: t.root.toString(), nullifierHash: poseidon2([BigInt(n.sk), 1n]).toString(), recipient: BigInt(recipient).toString(),
      spendKey: n.sk, viewKey: n.vk, pathElements: el, pathIndices: idx };
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, wasm, zkey);
    vkey = vkey || await snarkjs.zKey.exportVerificationKey(zkey);
    if (!(await snarkjs.groth16.verify(vkey, publicSignals, proof))) throw new Error('доказательство не прошло локальную проверку');
    const [pA, pB, pC, pub] = JSON.parse('[' + (await snarkjs.groth16.exportSolidityCallData(proof, publicSignals)) + ']');
    if (!(await retry(() => V.verifyProof(pA, pB, pC, pub), 'verifyProof'))) throw new Error('верификатор в сети отклонил доказательство (ключи схемы не совпадают с контрактом?)');
    return { pool: n.pool, pA, pB, pC, root: pub[0], nullifierHash: pub[1] };
  }
  const markSpent = (ns) => { for (const n of ns) n.spent = true; save(); };

  // ---------------------------------------------------------------- run
  console.log('\n2. Прямой депозит в пул 100 и вывод');
  if (!done('deposit V5 direct (1 note)')) {
    try {
      await record('approve pool 100', () => T.approve(poolAddrs[0], DENOMS[0]));
      const n = newNote();
      const rc = await record('deposit V5 direct (1 note)', () => P[0].deposit(n.commitment));
      placeNotes(rc, [n]);
    } catch (e) { fail('deposit V5 direct (1 note)', e); }
  }
  if (done('deposit V5 direct (1 note)') && !done('withdraw V5 direct (1 note)')) {
    try {
      const n = st.notes.find((x) => x.pool === 0 && !x.spent);
      const p = await proveNote(n, me);
      await record('withdraw V5 direct (1 note)', () => P[0].withdraw(p.pA, p.pB, p.pC, p.root, p.nullifierHash, me));
      markSpent([n]);
    } catch (e) { fail('withdraw V5 direct (1 note)', e); }
  }

  console.log('\n3. Депозиты через роутер');
  const plan = [['router deposit 1 note', 1n, 1], ['router deposit 3 notes', 160n, 3], ['router deposit 14 notes', 99n, 14], ['router deposit 32 notes', 3200n, 32]];
  if (!done('approve router')) {
    try { await record('approve router', () => T.approve(routerAddr, plan.reduce((s, p) => s + p[1], 0n) * E18)); } catch (e) { fail('approve router', e); }
  }
  for (const [name, tokens, count] of plan) {
    if (done(name)) continue;
    try {
      const allowance = await retry(() => T.allowance(me, routerAddr), 'allowance');
      if (allowance < tokens * E18) await record('approve router (' + name + ')', () => T.approve(routerAddr, tokens * E18));
      const notes = Array.from({ length: count }, newNote);
      const rc = await record(name, () => R.deposit(tokens * E18, notes.map((n) => n.commitment)), { notes: count, amount: tokens.toString() });
      notes.forEach((n) => (n.group = name));
      placeNotes(rc, notes);
    } catch (e) { fail(name, e); }
  }

  console.log('\n4. withdrawMany (доказательства считаются на этом компьютере)');
  async function many(name, pick) {
    if (done(name)) return;
    const ns = pick();
    if (!ns) { st.steps[name] = { ok: false, error: 'пропущено: нет нужных депозитов' }; save(); console.log('   – ' + name + ': пропущено, нет нужных депозитов'); return; }
    try {
      const items = [];
      for (const n of ns) { items.push(await proveNote(n, me)); process.stdout.write('.'); }
      process.stdout.write('\n');
      await record(name, () => R.withdrawMany(items, me), { notes: ns.length });
      markSpent(ns);
    } catch (e) { fail(name, e); }
  }
  await many('withdrawMany 3 notes', () => { const g = st.notes.filter((n) => n.group === 'router deposit 3 notes' && !n.spent); return g.length === 3 ? g : null; });
  await many('withdrawMany 16 notes', () => { const g = st.notes.filter((n) => n.group === 'router deposit 32 notes' && !n.spent).slice(0, 16); return g.length === 16 ? g : null; });

  // ---------------------------------------------------------------- report
  const order = ['deploy PoseidonT3', 'deploy Verifier', 'deploy Token', 'deploy Pool100', 'deploy Pool50', 'deploy Pool10', 'deploy Pool1', 'deploy Router',
    'deposit V5 direct (1 note)', 'withdraw V5 direct (1 note)', 'router deposit 1 note', 'router deposit 3 notes', 'router deposit 14 notes', 'router deposit 32 notes',
    'withdrawMany 3 notes', 'withdrawMany 16 notes'];
  console.log('\nИтог: ' + netName);
  console.log('операция'.padEnd(30) + 'газ'.padStart(14) + 'комиссия'.padStart(24));
  let total = 0n;
  for (const k of order) {
    const r = st.steps[k]; if (!r) continue;
    if (r.ok) total += BigInt(r.fee || 0);
    console.log(k.padEnd(30) + (r.ok ? fmtGas(r.gasUsed) : 'ОШИБКА').padStart(14) + (r.ok ? fmtEth(r.fee) : '').padStart(24));
  }
  console.log('Всего комиссий: ' + ethers.formatEther(total) + ' ' + (net.symbol || 'ETH'));
  const resDir = path.join(HERE, 'results'); fs.mkdirSync(resDir, { recursive: true });
  const pub = { network: netName, chainId, vm: net.vm, compiler: art.compiler, wallet: me, finished: new Date().toISOString(), addresses: st.addr,
    steps: Object.fromEntries(Object.entries(st.steps).map(([k, v]) => [k, v])), totalFee: total.toString(), symbol: net.symbol || 'ETH' };
  const out = path.join(resDir, netName + '-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json');
  fs.writeFileSync(out, JSON.stringify(pub, null, 1));
  console.log('Результаты: ' + out);
  const failed = order.filter((k) => st.steps[k] && !st.steps[k].ok);
  if (failed.length) console.log('Не прошли: ' + failed.join('; ') + '. Это тоже результат: пришлите файл результатов.');
}

main().then(() => process.exit(0)).catch((e) => { console.error('\nОШИБКА: ' + (e && (e.shortMessage || e.message) || e)); process.exit(1); });
