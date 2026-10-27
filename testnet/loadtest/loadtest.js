'use strict';
/*
 * Load and anonymity test of the Latheon test chain (V7 pools and router by default; LOADTEST_GEN=v6 for the V6 set). Testnet only.
 *
 * Many wallets use the chain over a day the way people would: faucet claims, deposits into fixed pools and through the
 * router (exact amounts and rounded ones), withdrawals to fresh addresses (all at once, in parts, note by note), through
 * the relayer or from a wallet, some careless (soon after the deposit, the same amount, from the depositor's own wallet),
 * and a few trips through the bridge to Arbitrum Sepolia and back. Every action is written to a PRIVATE journal (which
 * deposit became which withdrawal). Then `analyze` plays an observer who sees only public chain data, tries to link
 * withdrawals to depositors with simple heuristics, and scores itself against the journal.
 *
 *   node loadtest.js plan [--wallets 200] [--bridge 25] [--hours 24] [--seed text]   writes secret/plan.json (keys inside)
 *   node loadtest.js fund                     funds the master wallet from the deployer (key asked without echo):
 *                                             LTH on the chain, and ETH + LTH tokens on Arbitrum Sepolia for the bridge wallets
 *   node loadtest.js run                      executes the plan in time order (resumable: done steps are skipped)
 *   node loadtest.js status                   progress
 *   node loadtest.js sweep                    after analyze: test LTH from recipients and wallets back to the master
 *   node loadtest.js hashes                   bridge-out transactions to claim on Arbitrum Sepolia (public hashes, no keys)
 *   node loadtest.js analyze                  observer heuristics vs the journal → out/loadtest-report.json and .md (no keys)
 *
 * Env: L3_RPC, PARENT_RPC, LATHEON_JSON, CHAIN_JSON, RELAYER_URL, FAUCET_URL, STATE_DIR (secret/), OUT_DIR (out/).
 * Needs the V7 (or V6) set in LATHEON_JSON (deploy-v7 / deploy-v6). LOADTEST_CONCURRENCY (default 4) steps of different
 * wallets run at once; the steps of one wallet always run one after another, in plan order. The relayer and faucet should list this server's IP in RELAY_EXEMPT_IPS and
 * FAUCET_EXEMPT_IPS, or most requests will hit the per-IP limits (which is itself a finding the run records).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ethers, ART, E18, env, rnd, log, die, retry, loadJson, saveJson, sleep, getKey } = require('../latheon/lib');
const { commitmentOf, nullifierOf, withdrawProof } = require('../latheon/zk');

const HERE = __dirname;
const STATE = env('STATE_DIR', path.join(HERE, 'secret'));
const OUT = env('OUT_DIR', path.join(HERE, 'out'));
const L3_RPC = env('L3_RPC', 'http://127.0.0.1:8449');
const PARENT_RPC = env('PARENT_RPC', 'https://sepolia-rollup.arbitrum.io/rpc');
const LATHEON_JSON = env('LATHEON_JSON', path.join(HERE, '..', 'latheon', 'out', 'latheon-deployments.json'));
const CHAIN_JSON = env('CHAIN_JSON', path.join(HERE, '..', 'chain', 'out', 'chain.json'));
const RELAYER_URL = env('RELAYER_URL', 'https://explorer.testnet.latheon.xyz/relay/api');
const FAUCET_URL = env('FAUCET_URL', 'https://explorer.testnet.latheon.xyz/faucet/api');
const PLAN = path.join(STATE, 'plan.json'), JOURNAL = path.join(STATE, 'journal.jsonl'), MASTER = path.join(STATE, 'master.key');
const LEVELS6 = 20, CONCURRENCY = Math.max(1, Number(env('LOADTEST_CONCURRENCY', '4'))), DENOMS = [100n, 50n, 10n, 1n];
const ZERO = ethers.ZeroAddress;

// ------------------------------------------------------------------ deterministic randomness for the plan
function rng(seed) { let s = crypto.createHash('sha256').update(String(seed)).digest(); let i = 0; return () => { if (i + 4 > s.length) { s = crypto.createHash('sha256').update(s).digest(); i = 0; } const v = s.readUInt32BE(i); i += 4; return v / 2 ** 32; }; }
const arg = (name, d) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : d; };
const split = (amount) => { let r = amount; return DENOMS.map((d) => { const c = r / d; r -= c * d; return Number(c); }); };

function journal(entry) { fs.mkdirSync(STATE, { recursive: true }); fs.appendFileSync(JOURNAL, JSON.stringify({ t: Date.now(), ...entry }, (k, v) => (typeof v === 'bigint' ? v.toString() : v)) + '\n', { mode: 0o600 }); }
function readJournal() { return fs.existsSync(JOURNAL) ? fs.readFileSync(JOURNAL, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []; }
// The last record of each step (a step retried after a failure has two records; the later one counts).
function latest(J) { const m = new Map(); for (const e of J) if (e.step) m.set(e.step, e); return [...m.values()]; }
// A stop (docker stop sends SIGTERM) lets the step in progress finish and be journaled, so nothing is sent twice or lost.
let stopping = false;
process.on('SIGTERM', () => { stopping = true; log('stop requested: finishing the current step'); });
process.on('SIGINT', () => { stopping = true; log('stop requested: finishing the current step'); });
async function nap(ms) { const end = Date.now() + ms; while (!stopping && Date.now() < end) await sleep(Math.min(5000, end - Date.now())); }

// ------------------------------------------------------------------ plan
// Behaviours (share of wallets): careful users wait hours and split; careless ones withdraw soon, the same amount, or
// from the wallet they deposited with. The observer is scored per behaviour, so the report says which habits leak.
const BEHAVIOURS = [
  ['careful', 0.45],          // waits 2-20 h, withdraws in parts or note by note to several fresh addresses, via the relayer
  ['typical', 0.30],          // waits 20 min - 6 h, withdraws everything at once to one fresh address, via the relayer
  ['hasty', 0.15],            // withdraws within 10 min, everything at once, via the relayer
  ['self-paying', 0.10],      // withdraws from the SAME wallet that deposited (pays gas publicly), after 1-8 h
];
function plan() {
  const n = Number(arg('wallets', 200)), nb = Number(arg('bridge', 25)), hours = Number(arg('hours', 24)), seed = arg('seed', crypto.randomBytes(8).toString('hex'));
  if (fs.existsSync(PLAN)) die(PLAN + ' exists; delete it (and journal.jsonl) to plan a new run');
  const r = rng(seed), H = 3600e3, start = Date.now() + Number(env('LOADTEST_START_MIN', '10')) * 60e3, span = hours * H, k = span / (24 * H);   // delays are written for a 24 h run and scale with --hours
  const pick = (list) => { let x = r(); for (const [v, w] of list) { if ((x -= w) <= 0) return v; } return list[list.length - 1][0]; };
  const steps = [], wallets = [];
  for (let i = 0; i < n; i++) {
    const w = ethers.Wallet.createRandom(), beh = pick(BEHAVIOURS), bridge = i < nb;
    wallets.push({ i, address: w.address, key: w.privateKey, behaviour: beh, bridge });
    let t = start + r() * span * 0.6;                      // deposits happen in the first 60% of the window
    steps.push({ id: `w${i}:fund`, w: i, kind: bridge ? 'bridge-in' : (r() < 0.5 ? 'faucet' : 'fund'), at: t - 15 * 60e3 * k });
    const deposits = 1 + Math.floor(r() * 3);
    for (let d = 0; d < deposits; d++) {
      const router = r() < 0.6, round = r() < 0.5;
      let amount = router ? BigInt(1 + Math.floor(r() * 300)) : DENOMS[Math.floor(r() * 4)];
      if (router && round) amount = amount < 10n ? 10n : amount - (amount % 10n);
      const id = `w${i}:d${d}`;
      steps.push({ id, w: i, kind: router ? 'router-deposit' : 'pool-deposit', amount: amount.toString(), rounded: router && round, at: t });
      const delay = k * (beh === 'hasty' ? r() * 10 * 60e3 : beh === 'typical' ? 20 * 60e3 + r() * 5.7 * H : beh === 'careful' ? 2 * H + r() * 18 * H : H + r() * 7 * H);
      const notes = router ? split(amount).reduce((a, c) => a + c, 0) : 1;
      if (beh === 'careful' && notes > 1 && r() < 0.5) {
        const parts = Math.min(notes, 2 + Math.floor(r() * 3));
        let tp = t + delay;   // parts in order, 1-5 h apart (scaled)
        for (let p = 0; p < parts; p++) { if (p) tp += (1 + r() * 4) * H * k; steps.push({ id: `${id}:wd${p}`, w: i, kind: 'withdraw-part', dep: id, part: p, parts, via: 'relayer', at: tp }); }
      } else if (beh === 'careful') {
        steps.push({ id: `${id}:wd`, w: i, kind: 'withdraw-notes', dep: id, via: 'relayer', at: t + delay });
      } else {
        steps.push({ id: `${id}:wd`, w: i, kind: 'withdraw-all', dep: id, via: beh === 'self-paying' ? 'self' : 'relayer', at: t + delay });
      }
      t += k * (10 * 60e3 + r() * 3 * H);
    }
    if (bridge && r() < 0.4) steps.push({ id: `w${i}:bridge-out`, w: i, kind: 'bridge-out', at: start + span * (0.7 + r() * 0.2) });
  }
  steps.sort((a, b) => a.at - b.at);
  fs.mkdirSync(STATE, { recursive: true, mode: 0o700 });
  const master = fs.existsSync(MASTER) ? fs.readFileSync(MASTER, 'utf8').trim() : ethers.Wallet.createRandom().privateKey;
  fs.writeFileSync(MASTER, master + '\n', { mode: 0o600 });
  saveJson(PLAN, { seed, created: new Date().toISOString(), gen: env('LOADTEST_GEN', 'v7'), derivedRecipients: true, hours, wallets, steps });
  fs.chmodSync(PLAN, 0o600);
  const lth = steps.filter((s) => /deposit/.test(s.kind)).reduce((a, s) => a + BigInt(s.amount), 0n);
  log(`Planned ${n} wallets (${nb} via the bridge), ${steps.length} steps over ${hours} h, ${lth} LTH in deposits. Master wallet ${new ethers.Wallet(master).address}.`);
  log('Next: node loadtest.js fund   (then: run)');
}

// ------------------------------------------------------------------ chain access
// The generation comes from the plan (old plans without it were V6 runs); a new plan takes LOADTEST_GEN, default v7.
function genOf() { const P = loadJson(PLAN, null); return (P && (P.gen || 'v6')) || env('LOADTEST_GEN', 'v7'); }
function ctx() {
  const dep = loadJson(LATHEON_JSON, null); if (!dep) die('no ' + LATHEON_JSON);
  const gen = genOf(); if (gen !== 'v6' && gen !== 'v7') die('LOADTEST_GEN must be v6 or v7');
  const pools = dep.pools.filter((p) => p.version === gen + '-native'), router = (dep.routers || []).find((x) => x.version === gen);
  if (pools.length !== 4 || !router) die('no ' + gen.toUpperCase() + ' set in ' + LATHEON_JSON + ' (run latheon-cmd.sh deploy-' + gen + ')');
  const G = gen.toUpperCase();
  const provider = new ethers.JsonRpcProvider(L3_RPC, undefined, { staticNetwork: true, cacheTimeout: -1 });
  const C = ART.contracts;
  return { dep, gen, pools, router, provider, C,
    pool: (i, s) => new ethers.Contract(pools[i].address, C['Pool' + G + 'Native'].abi, s || provider),
    routerC: (s) => new ethers.Contract(router.address, C['Router' + G + 'Native'].abi, s || provider) };
}
// Withdrawal recipients are fresh addresses whose keys can be re-derived from the master key (which never leaves the
// server), so the test LTH can be swept back after the analysis instead of being stranded. An observer cannot tell.
const recipientWallet = (stepId, k, p) => new ethers.Wallet(ethers.keccak256(ethers.toUtf8Bytes(fs.readFileSync(MASTER, 'utf8').trim() + ':recipient:' + stepId + ':' + k)), p);
const masterWallet = (p) => new ethers.NonceManager(new ethers.Wallet(fs.readFileSync(MASTER, 'utf8').trim(), p));

async function fund() {
  const P = loadJson(PLAN, null); if (!P) die('plan first');
  const { provider } = ctx();
  const deployer = new ethers.Wallet(await getKey(), provider);
  const m = new ethers.Wallet(fs.readFileSync(MASTER, 'utf8').trim()).address;
  const need = P.steps.filter((s) => /deposit/.test(s.kind)).reduce((a, s) => a + BigInt(s.amount), 0n) * E18 + BigInt(P.wallets.length) * 5n * E18;
  const have = await provider.getBalance(m);
  const dbal = await provider.getBalance(deployer.address);
  log(`Needs ${ethers.formatEther(need)} LTH on the chain (deposits + 5 per wallet); master holds ${ethers.formatEther(have)}, deployer ${ethers.formatEther(dbal)}.`);
  if (have < need && dbal < need - have + E18) die(`the deployer holds too little LTH on the chain: needs ${ethers.formatEther(need - have)} more for the master (bridge more LTH in first)`);
  if (have < need) { const rc = await (await deployer.sendTransaction({ to: m, value: need - have })).wait(); log(`Master funded on the chain with ${ethers.formatEther(need - have)} LTH (${rc.hash}).`); }
  else log('Master already holds enough LTH on the chain.');
  const nb = P.wallets.filter((w) => w.bridge).length;
  if (nb) {
    const cj = loadJson(CHAIN_JSON, null); if (!cj || !cj.feeToken) die('no ' + CHAIN_JSON + ' (token address of the bridge)');
    const parent = new ethers.JsonRpcProvider(PARENT_RPC, 421614, { staticNetwork: true });
    const dp = new ethers.Wallet(deployer.privateKey, parent);
    const tok = new ethers.Contract(cj.feeToken, ['function transfer(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)'], dp);
    const bridgeIdx = new Set(P.wallets.filter((w) => w.bridge).map((w) => w.i));   // exactly what bridgeIn() will send each of them
    const lthNeed = P.steps.filter((x) => bridgeIdx.has(x.w) && /deposit/.test(x.kind)).reduce((a, x) => a + BigInt(x.amount), 0n) * E18 + BigInt(nb) * 3n * E18;
    const ethNeed = BigInt(nb) * ethers.parseEther('0.0004');
    const eh = await parent.getBalance(m), th = await tok.balanceOf(m);
    if (eh < ethNeed) log('ETH on Arbitrum Sepolia: ' + (await (await dp.sendTransaction({ to: m, value: ethNeed - eh })).wait()).hash);
    if (th < lthNeed) log('LTH tokens on Arbitrum Sepolia: ' + (await (await tok.transfer(m, lthNeed - th)).wait()).hash);
  }
  log('Funding done. Next: node loadtest.js run');
}

// ------------------------------------------------------------------ the tree of a V6 pool, from its events (cached)
const trees = new Map();
async function leavesOf(c, i) {
  const k = c.pools[i].address, t = trees.get(k) || { leaves: [], from: c.pools[i].deployBlock };
  const head = await retry(() => c.provider.getBlockNumber(), 'head');
  if (head >= t.from) {
    const logs = await retry(() => c.pool(i).queryFilter('Deposit', t.from, head), 'deposit logs');
    for (const l of logs) t.leaves[Number(l.args.leafIndex)] = l.args.commitment;
    t.from = head + 1;
  }
  trees.set(k, t);
  if (t.leaves.some((x) => x === undefined)) { trees.delete(k); die('incomplete deposit scan for pool ' + i); }
  return t.leaves;
}
let zeros6 = null;
async function proofFor(c, note, recipient, relayer = ZERO, fee = 0n) {
  if (!zeros6) { zeros6 = []; for (let l = 0; l < LEVELS6; l++) zeros6.push(await c.pool(0).zeros(l)); }
  const leaves = await leavesOf(c, note.pool);
  const leaf = leaves.findIndex((x) => x === BigInt(note.commitment));
  if (leaf < 0) throw new Error('note not found in pool ' + note.pool);
  return withdrawProof({ sk: BigInt(note.sk), vk: BigInt(note.vk), leaf, leaves, zeros: zeros6, recipient, v6: c.gen === 'v6', v7: c.gen === 'v7', relayer, fee });
}

async function post(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body, (k, v) => (typeof v === 'bigint' ? v.toString() : v)) });
  let j = {}; try { j = await r.json(); } catch (e) { /* empty */ }
  if (!r.ok) { const e = new Error('HTTP ' + r.status + ': ' + (j.error || '')); e.status = r.status; throw e; }
  return j;
}

// ------------------------------------------------------------------ run
async function run() {
  const P = loadJson(PLAN, null); if (!P) die('plan first');
  const c = ctx();
  const master = masterWallet(c.provider);
  // LOADTEST_RETRY_KINDS (e.g. bridge-out): failed steps of these kinds run again; everything else that was tried is skipped
  const retryKinds = new Set(env('LOADTEST_RETRY_KINDS', '').split(',').map((x) => x.trim()).filter(Boolean));
  const done = new Set(latest(readJournal()).filter((e) => e.ok !== undefined && !(e.ok === false && retryKinds.has(e.kind))).map((e) => e.step));
  const notesOf = new Map();   // deposit step id -> notes [{pool, sk, vk, commitment, spent}]
  for (const e of readJournal()) if (e.kind && /deposit/.test(e.kind) && e.ok && e.notes) notesOf.set(e.step, e.notes);
  const spent = new Set(readJournal().filter((e) => e.ok && /^withdraw/.test(e.kind)).flatMap((e) => e.notes || []));
  for (const ns of notesOf.values()) for (const n of ns) if (spent.has(n.commitment)) n.spent = true;   // resume after a stop
  const wal = (i) => new ethers.Wallet(P.wallets[i].key, c.provider);
  log(`Run (${c.gen.toUpperCase()} pools, up to ${CONCURRENCY} at once): ${P.steps.length} steps, ${done.size} already done.`);
  const queue = P.steps.filter((s) => !done.has(s.id)).sort((a, b) => a.at - b.at);
  const running = new Set(), busy = new Set();
  let lastWaitLog = 0;
  async function one(s) {
    const rec = { step: s.id, kind: s.kind, w: s.w, behaviour: P.wallets[s.w].behaviour };
    try {
      Object.assign(rec, await act(s, P, c, master, wal, notesOf));
      rec.ok = true;
    } catch (e) {
      rec.ok = false; rec.error = String((e && (e.shortMessage || e.message)) || e).slice(0, 200); rec.status = e && e.status;
      if (/nonce/i.test(rec.error) && master.reset) master.reset();   // a nonce mix-up on the shared master wallet: resync
    }
    journal(rec);
    log(`${rec.ok ? 'ok  ' : 'FAIL'} ${s.id} ${s.kind}${rec.tx ? ' ' + rec.tx : ''}${rec.error ? ' — ' + rec.error : ''}`);
  }
  while (!stopping && (queue.length || running.size)) {
    const now = Date.now(); const seen = new Set();
    for (let i = 0; i < queue.length && running.size < CONCURRENCY; i++) {
      const s = queue[i];
      if (s.at > now) break;                                  // sorted by time: nothing later is due yet
      if (seen.has(s.w) || busy.has(s.w)) { seen.add(s.w); continue; }   // one step per wallet at a time, in plan order
      seen.add(s.w); queue.splice(i, 1); i--; busy.add(s.w);
      const pr = one(s).finally(() => { running.delete(pr); busy.delete(s.w); });
      running.add(pr);
    }
    const nextAt = queue.length ? queue[0].at : Infinity;
    if (!running.size && nextAt - now > 60e3 && now - lastWaitLog > 30 * 60e3) { lastWaitLog = now; log(`next ${queue[0].id} (${queue[0].kind}) in ${Math.round((nextAt - now) / 60e3)} min`); }
    await Promise.race([...running, sleep(Math.max(200, Math.min(5000, nextAt - now)))]);
  }
  if (running.size) { log(`finishing ${running.size} step(s) in progress`); await Promise.all([...running]); }
  if (stopping) { log('Stopped. Start again to continue where it stopped.'); return; }
  log('Run finished. Next: node loadtest.js analyze');
}

async function act(s, P, c, master, wal, notesOf) {
  const w = P.wallets[s.w], me = wal(s.w);
  if (s.kind === 'faucet') {
    const r = await post(FAUCET_URL + '/claim', { address: w.address });
    await retry(() => c.provider.waitForTransaction(r.txHash), 'faucet tx');
    const top = await c.provider.getBalance(w.address);   // the faucet gives 100; top up the rest of what the deposits need
    const need = P.steps.filter((x) => x.w === s.w && /deposit/.test(x.kind)).reduce((a, x) => a + BigInt(x.amount), 0n) * E18 + 3n * E18;
    if (top < need) await (await master.sendTransaction({ to: w.address, value: need - top })).wait();
    return { tx: r.txHash, source: 'faucet' };
  }
  if (s.kind === 'fund') {
    const need = P.steps.filter((x) => x.w === s.w && /deposit/.test(x.kind)).reduce((a, x) => a + BigInt(x.amount), 0n) * E18 + 3n * E18;
    const rc = await (await master.sendTransaction({ to: w.address, value: need })).wait();
    return { tx: rc.hash, source: 'master' };
  }
  if (s.kind === 'bridge-in') return bridgeIn(s, P, c, master, w);
  if (s.kind === 'bridge-out') return bridgeOut(s, P, c, me);
  if (s.kind === 'pool-deposit' || s.kind === 'router-deposit') {
    const amount = BigInt(s.amount);
    const counts = s.kind === 'router-deposit' ? split(amount) : DENOMS.map((d) => (d === amount ? 1 : 0));
    const notes = [];
    counts.forEach((n, pi) => { for (let k = 0; k < n; k++) { const sk = rnd(), vk = rnd(); notes.push({ pool: pi, sk: sk.toString(), vk: vk.toString(), commitment: commitmentOf(sk, vk).toString() }); } });
    let rc;
    if (s.kind === 'router-deposit') rc = await (await c.routerC(me).deposit(amount * E18, notes.map((n) => n.commitment), { value: amount * E18 })).wait();
    else rc = await (await c.pool(notes[0].pool, me).deposit(notes[0].commitment, { value: amount * E18 })).wait();
    notesOf.set(s.id, notes);
    return { tx: rc.hash, block: rc.blockNumber, amount: s.amount, notes, gasUsed: rc.gasUsed.toString() };
  }
  // withdrawals
  const notes = (notesOf.get(s.dep) || []).filter((n) => !n.spent);
  if (!notes.length) throw new Error('no unspent notes for ' + s.dep + ' (its deposit failed?)');
  let take = notes;
  if (s.kind === 'withdraw-part') { const per = Math.ceil(notes.length / (s.parts - s.part)); take = notes.slice(0, per); }
  const groups = s.kind === 'withdraw-notes' ? take.map((n) => [n]) : [take];
  const txs = [], recipients = [];
  let staleRetries = 0;
  // One chunk (at most 16 notes, one recipient) proven and sent; if a pool forgot the proof's root meanwhile ("Unknown
  // root": many deposits between proving and sending), prove again against the current root, as the demo does.
  async function sendChunk(chunk, to) {
    for (let attempt = 1; ; attempt++) {
      const proofs = []; for (const n of chunk) proofs.push({ n, p: await proofFor(c, n, to) });
      try {
        if (s.via === 'self') {
          const me2 = wal(s.w);
          if (chunk.length === 1) return (await (await c.pool(chunk[0].pool, me2).withdraw(proofs[0].p.pA, proofs[0].p.pB, proofs[0].p.pC, proofs[0].p.root, proofs[0].p.nullifierHash, to, ZERO, 0n)).wait()).hash;
          return (await (await c.routerC(me2).withdrawMany(proofs.map(({ n, p }) => [n.pool, p.pA, p.pB, p.pC, p.root, p.nullifierHash, 0n]), to, ZERO)).wait()).hash;
        }
        if (chunk.length === 1) {
          const { p } = proofs[0];
          return (await post(RELAYER_URL + '/withdraw', { pool: c.pools[chunk[0].pool].address, pA: p.pA, pB: p.pB, pC: p.pC, root: p.root, nullifierHash: p.nullifierHash, recipient: to, relayer: ZERO, fee: '0' })).tx;
        }
        const items = proofs.map(({ n, p }) => [n.pool, p.pA, p.pB, p.pC, p.root, p.nullifierHash, '0']);
        return (await post(RELAYER_URL + '/withdrawMany', { router: c.router.address, items, recipient: to, relayer: ZERO })).tx;
      } catch (e) {
        const m = String((e && (e.shortMessage || e.message)) || e);
        if (attempt >= 3 || !/Unknown root/i.test(m)) throw e;
        staleRetries++; log(`   ${s.id}: the pool forgot the proof's root (many deposits meanwhile); proving again`);
      }
    }
  }
  for (const [gi, g] of groups.entries()) {
    const to = recipientWallet(s.id, gi).address; recipients.push(to);
    for (let k = 0; k < g.length; k += 16) {
      const chunk = g.slice(k, k + 16);
      txs.push(await sendChunk(chunk, to));
      for (const n of chunk) n.spent = true;
    }
  }
  return { txs, recipients, nullifiers: take.map((n) => nullifierOf(BigInt(n.sk)).toString()), notes: take.map((n) => n.commitment), via: s.via, staleRetries };
}

// ------------------------------------------------------------------ bridge (Arbitrum Sepolia <-> the chain)
function parentCtx() {
  const cj = loadJson(CHAIN_JSON, null); if (!cj || !cj.feeToken || !cj.coreContracts) die('no bridge addresses in ' + CHAIN_JSON);
  cj.core = cj.coreContracts;
  return { cj, parent: new ethers.JsonRpcProvider(PARENT_RPC, 421614, { staticNetwork: true }) };
}
async function bridgeIn(s, P, c, master, w) {
  const { cj, parent } = parentCtx();
  const mp = new ethers.NonceManager(new ethers.Wallet(fs.readFileSync(MASTER, 'utf8').trim(), parent));
  const tokAbi = ['function transfer(address,uint256) returns (bool)', 'function approve(address,uint256) returns (bool)'];
  const need = P.steps.filter((x) => x.w === s.w && /deposit/.test(x.kind)).reduce((a, x) => a + BigInt(x.amount), 0n) * E18 + 3n * E18;
  await (await mp.sendTransaction({ to: w.address, value: ethers.parseEther('0.0003') })).wait();
  await (await new ethers.Contract(cj.feeToken, tokAbi, mp).transfer(w.address, need)).wait();
  const ww = new ethers.Wallet(w.key, parent);
  await (await new ethers.Contract(cj.feeToken, tokAbi, ww).approve(cj.core.inbox, need)).wait();
  const rc = await (await new ethers.Contract(cj.core.inbox, ['function depositERC20(uint256) returns (uint256)'], ww).depositERC20(need)).wait();
  const t0 = Date.now();
  while ((await c.provider.getBalance(w.address)) < need) { if (Date.now() - t0 > 60 * 60e3) throw new Error('bridge deposit did not arrive within 60 min'); await sleep(15e3); }
  return { tx: rc.hash, parent: true, arrivedAfterSec: Math.round((Date.now() - t0) / 1000), source: 'bridge' };
}
async function bridgeOut(s, P, c, me) {
  const bal = await c.provider.getBalance(me.address);
  const amount = bal > E18 ? bal - E18 / 2n : 0n;   // what is left after the deposits (about 3 LTH), keeping 0.5 for gas
  if (amount <= 0n) throw new Error('nothing left to bridge out');
  const rc = await (await new ethers.Contract('0x0000000000000000000000000000000000000064', ['function withdrawEth(address) payable returns (uint256)'], me).withdrawEth(me.address, { value: amount })).wait();
  return { tx: rc.hash, amount: ethers.formatEther(amount), note: 'claim on Arbitrum Sepolia later from the bridge page (Find by hash)' };
}

// ------------------------------------------------------------------ sweep: test LTH back to the master after the analysis
// Only for runs whose recipients are derived (the plan says derivedRecipients); run it AFTER analyze, because sweeping
// links the recipients publicly. Wallets of the plan are swept too.
async function sweep() {
  const P = loadJson(PLAN, null); if (!P) die('no plan');
  if (!P.derivedRecipients) die('this run used random recipients (no keys kept); nothing to sweep from them');
  const c = ctx(); const m = new ethers.Wallet(fs.readFileSync(MASTER, 'utf8').trim()).address;
  const J = latest(readJournal()).filter((e) => e.ok && /^withdraw/.test(e.kind));
  const keys = [];
  for (const e of J) (e.recipients || []).forEach((a, k) => { const w = recipientWallet(e.step, k, c.provider); if (w.address === a) keys.push(w); });
  for (const w of P.wallets) keys.push(new ethers.Wallet(w.key, c.provider));
  const fd = await c.provider.getFeeData(); const price = (fd.maxFeePerGas || fd.gasPrice) * 2n;
  let total = 0n, n = 0;
  for (const w of keys) {
    const bal = await retry(() => c.provider.getBalance(w.address), 'balance'); if (bal === 0n) continue;
    const gas = await retry(() => c.provider.estimateGas({ from: w.address, to: m, value: 1n }), 'estimate');
    const value = bal - gas * 2n * price; if (value <= 0n) continue;
    try { await (await w.sendTransaction({ to: m, value, gasLimit: gas * 2n, maxFeePerGas: price, maxPriorityFeePerGas: 0n })).wait(); total += value; n++; }
    catch (e) { log('sweep ' + w.address + ' failed: ' + String(e.shortMessage || e.message).slice(0, 120)); }
  }
  log(`Swept ${ethers.formatEther(total)} LTH from ${n} addresses back to the master ${m}.`);
}

// ------------------------------------------------------------------ hashes: bridge-out transactions to claim (public)
function hashes() {
  const J = latest(readJournal()).filter((e) => e.kind === 'bridge-out' && e.ok);
  log(`${J.length} bridge-out transaction(s) on the chain; claim each on Arbitrum Sepolia from latheon.xyz/bridge (Find by hash) once its assertion is confirmed (about two hours):`);
  for (const e of J) console.log(`${e.tx}  ${e.amount} LTH  ${new Date(e.t).toISOString()}`);
}

// ------------------------------------------------------------------ status
function status() {
  const P = loadJson(PLAN, null); if (!P) die('no plan');
  const J = latest(readJournal()); const ok = J.filter((e) => e.ok).length, bad = J.filter((e) => e.ok === false);
  const byKind = {}; for (const e of J) { const k = e.kind + (e.ok ? '' : ' (failed)'); byKind[k] = (byKind[k] || 0) + 1; }
  const next = P.steps.find((s) => !J.some((e) => e.step === s.id));
  log(`${ok} ok, ${bad.length} failed, ${P.steps.length - J.length} to go${next ? `; next ${next.id} ${next.kind} at ${new Date(next.at).toISOString()}` : ''}`);
  console.log(byKind);
  for (const e of bad.slice(-10)) console.log('  failed', e.step, e.kind, e.error);
}

// ------------------------------------------------------------------ analyze: an observer with public data only
async function analyze() {
  const P = loadJson(PLAN, null); if (!P) die('no plan');
  const J = latest(readJournal()); const c = ctx();
  // public data: deposits (who sent each, when, which pool), withdrawals (who sent, recipient, when, which pool)
  const from = Math.min(...c.pools.map((p) => p.deployBlock));
  const pub = { deposits: [], withdrawals: [] };
  const txFrom = new Map(); const fromOf = async (h) => { if (!txFrom.has(h)) txFrom.set(h, (await retry(() => c.provider.getTransaction(h), 'tx')).from); return txFrom.get(h); };
  for (let i = 0; i < 4; i++) {
    const p = c.pool(i);
    for (const l of await retry(() => p.queryFilter('Deposit', from), 'deposits')) pub.deposits.push({ pool: i, commitment: l.args.commitment.toString(), time: Number(l.args.timestamp), sender: await fromOf(l.transactionHash), tx: l.transactionHash });
    for (const l of await retry(() => p.queryFilter('Withdrawal', from), 'withdrawals')) pub.withdrawals.push({ pool: i, to: l.args.to, nullifier: l.args.nullifierHash.toString(), time: Number(l.args.timestamp), sender: await fromOf(l.transactionHash), tx: l.transactionHash });
  }
  // group withdrawals by transaction (a withdrawMany pays one recipient several notes at once)
  const byTx = new Map(); for (const w of pub.withdrawals) { if (!byTx.has(w.tx)) byTx.set(w.tx, { tx: w.tx, to: w.to, sender: w.sender, time: w.time, notes: [] }); byTx.get(w.tx).notes.push(w); }
  const depByTx = new Map(); for (const d of pub.deposits) { if (!depByTx.has(d.tx)) depByTx.set(d.tx, { tx: d.tx, sender: d.sender, time: d.time, notes: [] }); depByTx.get(d.tx).notes.push(d); }
  const amountOf = (notes) => notes.reduce((a, n) => a + Number(DENOMS[n.pool]), 0);
  const depositors = new Set(pub.deposits.map((d) => d.sender.toLowerCase()));
  // ground truth from the journal: nullifier -> owner wallet, withdrawal tx -> behaviour
  const owner = new Map(), behaviourOfTx = new Map(), walletAddr = P.wallets.map((w) => w.address.toLowerCase());
  for (const e of J) if (e.ok && e.nullifiers) { for (const n of e.nullifiers) owner.set(n, e.w); for (const t of e.txs || []) behaviourOfTx.set(t, e.behaviour); }
  // heuristics: each returns a guessed depositor address for a withdrawal transaction, or null
  const H = {
    'same sender': (w) => (depositors.has(w.sender.toLowerCase()) ? w.sender.toLowerCase() : null),
    'unique amount and time': (w) => {
      const amt = amountOf(w.notes);
      const cand = [...depByTx.values()].filter((d) => d.time < w.time && amountOf(d.notes) === amt);
      return cand.length === 1 ? cand[0].sender.toLowerCase() : null;
    },
    'latest deposit in the pool': (w) => {
      if (w.notes.length !== 1) return null;
      const before = pub.deposits.filter((d) => d.pool === w.notes[0].pool && d.time <= w.time);
      const last = before[before.length - 1];
      return last && w.time - last.time < 15 * 60 ? last.sender.toLowerCase() : null;
    },
  };
  const ours = [...byTx.values()].filter((w) => w.notes.some((n) => owner.has(n.nullifier)));
  const report = { generated: new Date().toISOString(), planSeed: P.seed, wallets: P.wallets.length, withdrawalTxs: ours.length, deposits: pub.deposits.length, heuristics: {}, byBehaviour: {}, anonymitySet: {} };
  const truthOf = (w) => { const o = owner.get(w.notes[0].nullifier); return o === undefined ? null : walletAddr[o]; };
  for (const [name, fn] of Object.entries(H)) {
    let guessed = 0, right = 0;
    for (const w of ours) { const g = fn(w); if (g) { guessed++; if (g === truthOf(w)) right++; } }
    report.heuristics[name] = { guessed, right, precision: guessed ? +(right / guessed).toFixed(3) : null, linkedShare: +(right / Math.max(1, ours.length)).toFixed(3) };
  }
  for (const w of ours) {
    const b = behaviourOfTx.get(w.tx) || 'unknown'; const r = report.byBehaviour[b] || (report.byBehaviour[b] = { withdrawals: 0, linkedByAny: 0 });
    r.withdrawals++; if (Object.values(H).some((fn) => fn(w) === truthOf(w) && truthOf(w))) r.linkedByAny++;
  }
  for (const b of Object.values(report.byBehaviour)) b.linkedShare = +(b.linkedByAny / b.withdrawals).toFixed(3);
  for (let i = 0; i < 4; i++) {   // anonymity set at withdrawal time: deposits in the pool before it, minus withdrawals before it
    const ws = pub.withdrawals.filter((w) => w.pool === i);
    const sizes = ws.map((w) => pub.deposits.filter((d) => d.pool === i && d.time <= w.time).length - pub.withdrawals.filter((x) => x.pool === i && x.time < w.time).length);
    sizes.sort((a, b) => a - b);
    report.anonymitySet[DENOMS[i] + ' LTH'] = sizes.length ? { withdrawals: sizes.length, min: sizes[0], median: sizes[Math.floor(sizes.length / 2)], max: sizes[sizes.length - 1] } : null;
  }
  report.staleRootRetries = J.reduce((a, e) => a + (e.staleRetries || 0), 0);   // proofs made again because a pool forgot their root
  report.failures = J.filter((e) => e.ok === false).map((e) => ({ kind: e.kind, error: e.error })).slice(0, 50);
  fs.mkdirSync(OUT, { recursive: true });
  saveJson(path.join(OUT, 'loadtest-report.json'), report);
  const md = ['# Latheon load and anonymity test', '', `Generated ${report.generated}. ${report.wallets} wallets, ${report.deposits} deposits, ${report.withdrawalTxs} withdrawal transactions (${c.gen.toUpperCase()} pools).`, '',
    'This is a simulation: the wallets\' behaviour was chosen by us. It shows how far simple, public-data heuristics get against typical habits, not how real users behave.', '',
    '## Heuristics (public data only)', '', '| Heuristic | Guesses | Right | Precision | Share of withdrawals linked |', '|---|---|---|---|---|',
    ...Object.entries(report.heuristics).map(([k, v]) => `| ${k} | ${v.guessed} | ${v.right} | ${v.precision ?? '—'} | ${v.linkedShare} |`), '',
    '## By behaviour', '', '| Behaviour | Withdrawals | Linked by any heuristic | Share |', '|---|---|---|---|',
    ...Object.entries(report.byBehaviour).map(([k, v]) => `| ${k} | ${v.withdrawals} | ${v.linkedByAny} | ${v.linkedShare} |`), '',
    '## Anonymity set at withdrawal time (unspent deposits in the pool)', '', '| Pool | Withdrawals | Min | Median | Max |', '|---|---|---|---|---|',
    ...Object.entries(report.anonymitySet).map(([k, v]) => (v ? `| ${k} | ${v.withdrawals} | ${v.min} | ${v.median} | ${v.max} |` : `| ${k} | 0 | | | |`)), '',
    `Failed steps: ${report.failures.length}. Proofs made again because a pool no longer knew their root: ${report.staleRootRetries}.`, ''].join('\n');
  fs.writeFileSync(path.join(OUT, 'loadtest-report.md'), md);
  console.log(md);
}

const cmd = process.argv[2];
const fn = { plan, fund, run, status, hashes, analyze, sweep }[cmd];
if (!fn) { console.log('usage: node loadtest.js plan|fund|run|status|hashes|analyze|sweep'); process.exit(2); }
Promise.resolve(fn()).then(() => process.exit(0)).catch((e) => die((e && (e.shortMessage || e.message)) || String(e)));
