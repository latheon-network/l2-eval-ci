'use strict';
/*
 * Throughput test of the Latheon test chain without proofs (testnet only): many wallets send deposits into the V7 1 LTH
 * pool as fast as the chain accepts them, in stages of rising concurrency. Deposits need no zero-knowledge proof, so the
 * load generator stays light and what we measure is the chain itself: the sequencer and node, the RPC, and the explorer.
 *
 *   node flood.js fund  [--wallets 64] [--per 700]     deployer -> the flood's master wallet (deployer key asked without echo)
 *   node flood.js run   [--stages 8,16,32,64] [--minutes 5] [--wallets 64] [--per 700] [--kind deposit|transfer]
 *                       --kind transfer sends plain 1-wei transfers instead of deposits: the usual "transactions per second"
 *                       yardstick, to set beside the deposits
 *                       funds the wallets from the master (once), then runs each stage for --minutes; a stage with more
 *                       than 20% failed sends or a median confirmation over 30 s ends the run (that is the limit found)
 *   node flood.js report                               per-stage table -> out-flood/flood-report.md (no keys)
 *   node flood.js sweep                                LTH left on the flood wallets and burst recipients back to the master
 *
 * Relayer burst (after a flood run, while nobody else deposits into the pool, so its root stays put):
 *   node flood.js prove [--count 400]                  withdraw_v5 proofs for flood notes, made in advance against today's
 *                                                      root, to fresh recipients derived from the master key (no relayer fee)
 *   node flood.js burst [--stages 8,16,32] [--per-stage 120] [--relayer URL]
 *                       sends the ready proofs to the relayer, that many requests at once per stage; per stage: answers by
 *                       HTTP status, withdrawals per minute, answer time, and how many of the returned transactions are on chain
 *
 * Every note's keys are derived from the master key, and every deposit is journaled privately (secret-flood/), so the
 * notes can be withdrawn later (the relayer burst test uses them) instead of staying in the pool for good.
 * Env: L3_RPC (default http://127.0.0.1:8449), LATHEON_JSON, EXPLORER_API (default the public explorer), STATE_DIR, OUT_DIR.
 */
const fs = require('fs');
const path = require('path');
const { ethers, E18, ART, env, log, die, retry, loadJson, saveJson, sleep, getKey } = require('../latheon/lib');
const { commitmentOf, tree, withdrawProof } = require('../latheon/zk');

const HERE = __dirname;
const STATE = env('STATE_DIR', path.join(HERE, 'secret-flood'));
const OUT = env('OUT_DIR', path.join(HERE, 'out-flood'));
const L3_RPC = env('L3_RPC', 'http://127.0.0.1:8449');
const LATHEON_JSON = env('LATHEON_JSON', path.join(HERE, '..', 'latheon', 'out', 'latheon-deployments.json'));
const EXPLORER_API = env('EXPLORER_API', 'https://explorer.testnet.latheon.xyz/api/v2/main-page/blocks');
const MASTER = path.join(STATE, 'master.key'), JOURNAL = path.join(STATE, 'journal.jsonl'), FUNDED = path.join(STATE, 'funded.json'), PROOFS = path.join(STATE, 'proofs.jsonl');
const RELAYER_URL = env('RELAYER_URL', 'https://explorer.testnet.latheon.xyz/relay/api');
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
// the node's own message when ethers only says "could not coalesce error"
const errMsg = (e) => String((e && ((e.error && e.error.message) || (e.info && e.info.error && e.info.error.message) || e.shortMessage || e.message)) || e).slice(0, 120);
const arg = (name, d) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : d; };
let stopping = false;
process.on('SIGTERM', () => { stopping = true; log('stop requested: finishing the sends in flight'); });
process.on('SIGINT', () => { stopping = true; log('stop requested: finishing the sends in flight'); });

function journal(e) { fs.mkdirSync(STATE, { recursive: true, mode: 0o700 }); fs.appendFileSync(JOURNAL, JSON.stringify({ t: Date.now(), ...e }) + '\n', { mode: 0o600 }); }
function readJournal() { return fs.existsSync(JOURNAL) ? fs.readFileSync(JOURNAL, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []; }
function masterKey() {
  fs.mkdirSync(STATE, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(MASTER)) fs.writeFileSync(MASTER, ethers.Wallet.createRandom().privateKey + '\n', { mode: 0o600 });
  return fs.readFileSync(MASTER, 'utf8').trim();
}
const derive = (tag) => BigInt(ethers.keccak256(ethers.toUtf8Bytes(masterKey() + ':flood:' + tag)));
const walletKey = (i) => ethers.toBeHex(derive('wallet:' + i) % (FIELD - 1n) + 1n, 32);
const noteOf = (w, k) => { const sk = derive(`sk:${w}:${k}`) % FIELD, vk = derive(`vk:${w}:${k}`) % FIELD; return { sk: sk.toString(), vk: vk.toString(), commitment: commitmentOf(sk, vk).toString() }; };

function ctx() {
  const dep = loadJson(LATHEON_JSON, null); if (!dep) die('no ' + LATHEON_JSON);
  const pools = dep.pools.filter((p) => p.version === 'v7-native');
  if (pools.length !== 4) die('no V7 set in ' + LATHEON_JSON);
  const pool = pools.find((p) => Number(p.amount) === 1); if (!pool) die('no V7 1 LTH pool in ' + LATHEON_JSON);
  // One HTTP request per call, as separate users would send them. ethers batches calls by default, and a Nitro node answers
  // eth_sendRawTransaction only once the transaction is sequenced, so a batch of sends goes in one by one: with batching the
  // test measured its own client (one transfer or deposit per block, 31.10.2026), not the chain. --batch restores it.
  const batch = process.argv.includes('--batch');
  const provider = new ethers.JsonRpcProvider(L3_RPC, undefined, { staticNetwork: true, cacheTimeout: -1, ...(batch ? {} : { batchMaxCount: 1 }) });
  return { provider, pool, poolIndex: pools.indexOf(pool), abi: ART.contracts.PoolV7Native.abi };
}

async function fund() {
  const n = Number(arg('wallets', 64)), per = BigInt(arg('per', 700));
  const { provider } = ctx();
  const m = new ethers.Wallet(masterKey()).address;
  const need = BigInt(n) * per * E18 + 10n * E18, have = await provider.getBalance(m);
  log(`The flood needs ${ethers.formatEther(need)} LTH on its master ${m}; it holds ${ethers.formatEther(have)}.`);
  if (have >= need) return log('Master already holds enough. Next: node flood.js run');
  const deployer = new ethers.Wallet(await getKey(), provider);
  const rc = await (await deployer.sendTransaction({ to: m, value: need - have })).wait();
  log(`Master funded with ${ethers.formatEther(need - have)} LTH (${rc.hash}). Next: node flood.js run`);
}

async function fundWallets(c, n, per) {
  const done = new Set(loadJson(FUNDED, []));
  const master = new ethers.Wallet(masterKey(), c.provider);
  for (let i = 0; i < n; i++) {   // one at a time: a few dozen transfers, and no nonce games on the master
    const to = new ethers.Wallet(walletKey(i)).address;   // balance checked every time: a sweep empties the wallets
    const have = await retry(() => c.provider.getBalance(to), 'balance');
    if (have < per * E18 / 2n) await (await master.sendTransaction({ to, value: per * E18 - have })).wait();
    done.add(i); saveJson(FUNDED, [...done]);
  }
  log(`${done.size} flood wallets hold ${per} LTH each.`);
}

const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

async function headOfExplorer() {
  try { const r = await fetch(EXPLORER_API, { signal: AbortSignal.timeout(8000) }); const j = await r.json(); const b = Array.isArray(j) ? j[0] : (j.items || [])[0]; return b ? Number(b.height) : null; } catch (e) { return null; }
}

async function run() {
  const stages = String(arg('stages', '8,16,32,64')).split(',').map(Number).filter((x) => x > 0);
  const minutes = Number(arg('minutes', 5)), n = Math.max(Number(arg('wallets', 64)), ...stages), per = BigInt(arg('per', 700)), kind = arg('kind', 'deposit');
  if (kind !== 'deposit' && kind !== 'transfer') die('--kind must be deposit or transfer');
  const c = ctx();
  await fundWallets(c, n, per);
  const counters = new Map();
  for (const e of readJournal()) if (e.kind === 'deposit') counters.set(e.w, Math.max(counters.get(e.w) || 0, e.k + 1));
  const batchMode = process.argv.includes('--batch'), value = BigInt(c.pool.amount) * E18, sink = new ethers.Wallet(masterKey()).address;
  for (const conc of stages) {
    if (stopping) break;
    const st = { stage: conc, start: Date.now(), ok: 0, fail: 0, lat: [], errors: {}, lagMax: 0, lagSamples: [], blocks: new Set(), gas: null };
    const end = st.start + minutes * 60e3;
    log(`Stage: ${conc} wallets sending ${kind === 'transfer' ? 'transfers' : 'deposits'} at once, ${minutes} min.`);
    const sampler = (async () => {
      while (!stopping && Date.now() < end) {
        const [h, x] = await Promise.all([c.provider.getBlockNumber().catch(() => null), headOfExplorer()]);
        if (h != null && x != null) { const lag = Math.max(0, h - x); st.lagSamples.push(lag); st.lagMax = Math.max(st.lagMax, lag); }
        await sleep(10e3);
      }
    })();
    const worker = async (w) => {
      const me = new ethers.Wallet(walletKey(w), c.provider);
      const pool = new ethers.Contract(c.pool.address, c.abi, me);
      let nonce = await retry(() => c.provider.getTransactionCount(me.address, 'pending'), 'nonce');
      let k = counters.get(w) || 0;
      while (!stopping && Date.now() < end) {
        if ((await c.provider.getBalance(me.address).catch(() => value * 3n)) < value * 2n) { log(`w${w}: out of LTH`); return; }
        if (kind === 'transfer') {
          const t0 = Date.now();
          try {
            const tx = await me.sendTransaction({ to: sink, value: 1n, nonce });
            nonce++;
            const rc = await tx.wait();
            st.ok++; st.lat.push(Date.now() - t0); st.blocks.add(rc.blockNumber);
            if (!st.gas) { const raw = await c.provider.send('eth_getTransactionReceipt', [rc.hash]).catch(() => ({})); st.gas = { used: rc.gasUsed.toString(), forL1: raw.gasUsedForL1 ? BigInt(raw.gasUsedForL1).toString() : 'unknown' }; }   // ethers drops Arbitrum's gasUsedForL1
          } catch (e) {
            const m = errMsg(e);
            st.fail++; if (!st.errors[m]) log(`w${w}: ${m}`); st.errors[m] = (st.errors[m] || 0) + 1;
            nonce = await c.provider.getTransactionCount(me.address, 'pending').catch(() => nonce);
            await sleep(1000);
          }
          continue;
        }
        const note = noteOf(w, k), t0 = Date.now();
        try {
          // gas from an estimate plus a margin: a deposit's cost depends on which tree slots it writes, and other wallets'
          // deposits landing first change that (seen as reverts on a local chain at 6 wallets at once)
          const est = await pool.deposit.estimateGas(note.commitment, { value });
          const tx = await pool.deposit(note.commitment, { value, nonce, gasLimit: est * 13n / 10n });
          nonce++;
          const rc = await tx.wait();
          st.ok++; st.lat.push(Date.now() - t0);
          journal({ kind: 'deposit', w, k, pool: c.poolIndex, ...note, tx: rc.hash, block: rc.blockNumber, ms: Date.now() - t0, stage: conc });
          k++; counters.set(w, k);
        } catch (e) {
          const m = errMsg(e);
          st.fail++; if (!st.errors[m]) log(`w${w}: ${m}`); st.errors[m] = (st.errors[m] || 0) + 1;
          if (/nonce|replacement|already known|coalesce/i.test(m)) nonce = await c.provider.getTransactionCount(me.address, 'pending').catch(() => nonce);
          if (/already/i.test(m)) k++;   // the commitment went in on an earlier try
          await sleep(1000);
        }
      }
    };
    await Promise.all(Array.from({ length: conc }, (_, w) => worker(w)));
    await sampler;
    st.end = Date.now();
    const mins = (st.end - st.start) / 60e3, med = pct(st.lat, 0.5), p95 = pct(st.lat, 0.95);
    const summary = { kind: 'stage', tx: kind, batched: batchMode || undefined, blocks: st.blocks.size || undefined, gas: st.gas || undefined, stage: conc, minutes: +mins.toFixed(2), ok: st.ok, failed: st.fail, perMinute: +(st.ok / mins).toFixed(1), medianMs: med, p95Ms: p95, explorerLagMaxBlocks: st.lagMax, explorerLagMedianBlocks: pct(st.lagSamples, 0.5), errors: st.errors };
    journal(summary);
    log(`Stage ${conc} (${kind}): ${st.ok} ok, ${st.fail} failed, ${summary.perMinute} per minute, confirmation median ${med} ms, p95 ${p95} ms, explorer behind by up to ${st.lagMax} blocks.`);
    if (st.fail > 0.2 * (st.ok + st.fail) || (med != null && med > 30e3)) { log('Limit reached: more than 20% failed or the median confirmation is over 30 s. Stopping here.'); break; }
  }
  log('Flood finished. Next: node flood.js report');
}

function report() {
  const S = readJournal().filter((e) => e.kind === 'stage'), B = readJournal().filter((e) => e.kind === 'burst-stage');
  if (!S.length && !B.length) die('no stage finished yet');
  const deposits = readJournal().filter((e) => e.kind === 'deposit').length;
  const rows = S.map((s) => `| ${s.tx || 'deposit'}${s.batched || !s.tx || (s.tx === 'transfer' && !s.gas?.forL1) ? ' (batched)' : ''} | ${s.stage} | ${s.minutes} | ${s.ok} | ${s.failed} | ${s.perMinute} | ${s.medianMs} | ${s.p95Ms} | ${s.explorerLagMedianBlocks} / ${s.explorerLagMaxBlocks} | ${Object.entries(s.errors).map(([k, v]) => v + '× ' + k.replace(/\|/g, '/')).join('; ') || '—'} |`);
  const md = ['# Latheon throughput test without proofs', '', `Generated ${new Date().toISOString()}. Deposits into the V7 1 LTH pool from many wallets at once (${deposits} in total), and plain transfers where the first column says so. Testnet only; the load came from the same server.`, '',
    '| Transaction | Wallets at once | Minutes | Confirmed | Failed | Per minute | Confirmation median, ms | p95, ms | Explorer behind (median / max blocks) | Errors |',
    '|---|---|---|---|---|---|---|---|---|---|', ...rows, ...S.filter((s) => s.gas && s.gas.forL1 !== '0').slice(-1).map((s) => `\nOne ${s.tx}: ${s.gas.used} gas in total, of which ${s.gas.forL1} for parent-chain data; ${s.blocks} blocks in its stage.`), '',
    ...(B.length ? ['## Relayer burst (proofs made in advance)', '', '| Requests at once | Minutes | Requests | Answers by HTTP status | Relayed/min | Answer median, ms | p95, ms | Confirmed on chain |', '|---|---|---|---|---|---|---|---|',
      ...B.map((b) => `| ${b.stage} | ${b.minutes} | ${b.requests} | ${Object.entries(b.byStatus).map(([k, v]) => k + ': ' + v).join(', ')} | ${b.perMinute} | ${b.medianMs} | ${b.p95Ms} | ${b.onChain} |`), ''] : [])].join('\n');
  fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(path.join(OUT, 'flood-report.md'), md); console.log(md);
}

async function sweep() {
  const c = ctx(); const m = new ethers.Wallet(masterKey()).address; const done = loadJson(FUNDED, []);
  let total = 0n, n = 0, skipped = 0;
  const keys = [...done.map((i) => walletKey(i)), ...readJournal().filter((e) => e.kind === 'burst' && e.status === 200).map((e) => recipientOf(e.commitment).privateKey)];
  for (const key of keys) {
    const w = new ethers.Wallet(key, c.provider);
    for (let a = 0; a < 3; a++) {
      try {
        const bal = await retry(() => c.provider.getBalance(w.address), 'balance'); if (bal === 0n) break;
        // fresh estimate each try, three times over: on Arbitrum the gas of a transfer includes the data charge, which
        // moves with the parent chain's price and the chain's base fee (a fixed double of an older estimate fell short)
        const fd = await c.provider.getFeeData(), price = (fd.maxFeePerGas || fd.gasPrice) * 2n;
        const gas = (await c.provider.estimateGas({ from: w.address, to: m, value: 1n })) * 3n, value = bal - gas * price;
        if (value <= 0n) break;
        await (await w.sendTransaction({ to: m, value, gasLimit: gas, maxFeePerGas: price, maxPriorityFeePerGas: 0n })).wait(); total += value; n++; break;
      } catch (e) { if (a === 2) { skipped++; log(`${w.address}: ${errMsg(e)}`); } else await sleep(1000); }
    }
  }
  log(`Swept ${ethers.formatEther(total)} LTH from ${n} addresses back to the master ${m}${skipped ? `; ${skipped} skipped` : ''}.`);
}

// Send LTH from the flood's master to another address (e.g. the master of a flood run from a second machine).
async function give() {
  const to = arg('to'), amount = arg('amount');
  if (!to || !ethers.isAddress(to) || !amount) die('usage: node flood.js give --to ADDRESS --amount LTH');
  const c = ctx(); const master = new ethers.Wallet(masterKey(), c.provider);
  const rc = await (await master.sendTransaction({ to, value: ethers.parseEther(String(amount)) })).wait();
  log(`Sent ${amount} LTH from ${master.address} to ${to} (${rc.hash}).`);
}

// ------------------------------------------------------------------ relayer burst
const readProofs = () => (fs.existsSync(PROOFS) ? fs.readFileSync(PROOFS, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const recipientOf = (commitment) => new ethers.Wallet(ethers.toBeHex(derive('recipient:' + commitment) % (FIELD - 1n) + 1n, 32));

async function prove() {
  const count = Number(arg('count', 400));
  const c = ctx(); const pool = new ethers.Contract(c.pool.address, c.abi, c.provider);
  const have = new Set(readProofs().map((x) => x.commitment));
  const used = new Set(readJournal().filter((e) => e.kind === 'burst' && e.status === 200).map((e) => e.commitment));
  const notes = readJournal().filter((e) => e.kind === 'deposit' && !have.has(e.commitment) && !used.has(e.commitment)).slice(0, Math.max(0, count - have.size));
  if (!notes.length) return log(`${have.size} proofs already made. Next: node flood.js burst`);
  const head = await c.provider.getBlockNumber(); const leaves = [];
  for (let from = c.pool.deployBlock || 0; from <= head; from += 50000) {
    const logs = await retry(() => pool.queryFilter('Deposit', from, Math.min(head, from + 49999)), 'deposit logs');
    for (const l of logs) leaves[Number(l.args.leafIndex)] = l.args.commitment;
  }
  if (leaves.some((x) => x === undefined) || BigInt(leaves.length) !== (await pool.nextIndex())) die('incomplete deposit scan of the 1 LTH pool');
  const zeros = []; for (let l = 0; l < 20; l++) zeros.push(await pool.zeros(l));
  const t = tree(leaves, zeros), idx = new Map(leaves.map((x, i) => [x.toString(), i]));
  if (!(await pool.isKnownRoot(t.root))) die('the computed root is not known to the pool');
  log(`Tree of ${leaves.length} deposits, root known to the pool. Making ${notes.length} proofs...`);
  let n = 0; const t0 = Date.now();
  for (const e of notes) {
    if (stopping) break;
    const leaf = idx.get(e.commitment); if (leaf === undefined) continue;
    const to = recipientOf(e.commitment).address;
    const p = await withdrawProof({ sk: BigInt(e.sk), vk: BigInt(e.vk), leaf, leaves, zeros, recipient: to, v7: true, prebuilt: t });
    fs.appendFileSync(PROOFS, JSON.stringify({ commitment: e.commitment, recipient: to, pA: p.pA, pB: p.pB, pC: p.pC, root: p.root, nullifierHash: p.nullifierHash }) + '\n', { mode: 0o600 });
    if (++n % 50 === 0) log(`${n} proofs (${((Date.now() - t0) / n / 1000).toFixed(1)} s each)`);
  }
  log(`${n} proofs made, ${have.size + n} ready. Next: node flood.js burst`);
}

async function burst() {
  const stages = String(arg('stages', '8,16,32')).split(',').map(Number).filter((x) => x > 0), per = Number(arg('per-stage', 120));
  const url = arg('relayer', RELAYER_URL);
  const c = ctx();
  const sent = new Set(readJournal().filter((e) => e.kind === 'burst').map((e) => e.commitment));
  const queue = readProofs().filter((x) => !sent.has(x.commitment));
  log(`${queue.length} proofs ready; relayer ${url}.`);
  for (const conc of stages) {
    if (stopping || !queue.length) break;
    const batch = queue.splice(0, per), st = { byStatus: {}, ms: [], txs: [] }, t0 = Date.now();
    log(`Stage: ${conc} requests at once, ${batch.length} withdrawals.`);
    const worker = async () => {
      while (!stopping && batch.length) {
        const x = batch.shift(); const s0 = Date.now(); let status = 0, j = {};
        try {
          const r = await fetch(url + '/withdraw', { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(180e3),
            body: JSON.stringify({ pool: c.pool.address, pA: x.pA, pB: x.pB, pC: x.pC, root: x.root, nullifierHash: x.nullifierHash, recipient: x.recipient, relayer: ethers.ZeroAddress, fee: '0' }) });
          status = r.status; try { j = await r.json(); } catch (e) { /* empty */ }
        } catch (e) { status = 'net:' + String(e.name || e.message).slice(0, 30); }
        const ms = Date.now() - s0; st.byStatus[status] = (st.byStatus[status] || 0) + 1;
        if (status === 200) { st.ms.push(ms); if (j.tx) st.txs.push(j.tx); }
        journal({ kind: 'burst', stage: conc, commitment: x.commitment, status, ms, tx: j.tx, pending: !!j.pending, error: j.error ? String(j.error).slice(0, 100) : undefined });
      }
    };
    await Promise.all(Array.from({ length: conc }, worker));
    const mins = (Date.now() - t0) / 60e3;
    let onChain = 0; for (const h of st.txs) { const rc = await retry(() => c.provider.waitForTransaction(h, 1, 120e3), 'receipt').catch(() => null); if (rc && rc.status === 1) onChain++; }
    const summary = { kind: 'burst-stage', stage: conc, minutes: +mins.toFixed(2), requests: Object.values(st.byStatus).reduce((a, b) => a + b, 0), byStatus: st.byStatus,
      perMinute: +((st.byStatus[200] || 0) / mins).toFixed(1), medianMs: pct(st.ms, 0.5), p95Ms: pct(st.ms, 0.95), onChain };
    journal(summary);
    log(`Stage ${conc}: ${JSON.stringify(st.byStatus)}, ${summary.perMinute} relayed withdrawals/min, answer median ${summary.medianMs} ms, p95 ${summary.p95Ms} ms, ${onChain} of ${st.txs.length} transactions confirmed on chain.`);
  }
  log('Burst finished. Next: node flood.js report');
}

const cmd = process.argv[2];
Promise.resolve().then(() => ({ fund, run, report, sweep, prove, burst, give }[cmd] || (() => die('usage: node flood.js fund|run|report|sweep|prove|burst|give')))()).then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });   // exit explicitly: snarkjs keeps worker threads alive
