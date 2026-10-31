'use strict';
/*
 * Throughput test of the Latheon test chain without proofs (testnet only): many wallets send deposits into the V7 1 LTH
 * pool as fast as the chain accepts them, in stages of rising concurrency. Deposits need no zero-knowledge proof, so the
 * load generator stays light and what we measure is the chain itself: the sequencer and node, the RPC, and the explorer.
 *
 *   node flood.js fund  [--wallets 64] [--per 700]     deployer -> the flood's master wallet (deployer key asked without echo)
 *   node flood.js run   [--stages 8,16,32,64] [--minutes 5] [--wallets 64] [--per 700]
 *                       funds the wallets from the master (once), then runs each stage for --minutes; a stage with more
 *                       than 20% failed sends or a median confirmation over 30 s ends the run (that is the limit found)
 *   node flood.js report                               per-stage table -> out-flood/flood-report.md (no keys)
 *   node flood.js sweep                                LTH left on the flood wallets back to the master
 *
 * Every note's keys are derived from the master key, and every deposit is journaled privately (secret-flood/), so the
 * notes can be withdrawn later (the relayer burst test uses them) instead of staying in the pool for good.
 * Env: L3_RPC (default http://127.0.0.1:8449), LATHEON_JSON, EXPLORER_API (default the public explorer), STATE_DIR, OUT_DIR.
 */
const fs = require('fs');
const path = require('path');
const { ethers, E18, ART, env, log, die, retry, loadJson, saveJson, sleep, getKey } = require('../latheon/lib');
const { commitmentOf } = require('../latheon/zk');

const HERE = __dirname;
const STATE = env('STATE_DIR', path.join(HERE, 'secret-flood'));
const OUT = env('OUT_DIR', path.join(HERE, 'out-flood'));
const L3_RPC = env('L3_RPC', 'http://127.0.0.1:8449');
const LATHEON_JSON = env('LATHEON_JSON', path.join(HERE, '..', 'latheon', 'out', 'latheon-deployments.json'));
const EXPLORER_API = env('EXPLORER_API', 'https://explorer.testnet.latheon.xyz/api/v2/main-page/blocks');
const MASTER = path.join(STATE, 'master.key'), JOURNAL = path.join(STATE, 'journal.jsonl'), FUNDED = path.join(STATE, 'funded.json');
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
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
  const provider = new ethers.JsonRpcProvider(L3_RPC, undefined, { staticNetwork: true, cacheTimeout: -1 });
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
    if (done.has(i)) continue;
    const to = new ethers.Wallet(walletKey(i)).address;
    const have = await retry(() => c.provider.getBalance(to), 'balance');
    if (have < per * E18) await (await master.sendTransaction({ to, value: per * E18 - have })).wait();
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
  const minutes = Number(arg('minutes', 5)), n = Math.max(Number(arg('wallets', 64)), ...stages), per = BigInt(arg('per', 700));
  const c = ctx();
  await fundWallets(c, n, per);
  const counters = new Map();
  for (const e of readJournal()) if (e.kind === 'deposit') counters.set(e.w, Math.max(counters.get(e.w) || 0, e.k + 1));
  const value = BigInt(c.pool.amount) * E18;
  for (const conc of stages) {
    if (stopping) break;
    const st = { stage: conc, start: Date.now(), ok: 0, fail: 0, lat: [], errors: {}, lagMax: 0, lagSamples: [] };
    const end = st.start + minutes * 60e3;
    log(`Stage: ${conc} wallets sending at once, ${minutes} min.`);
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
          const m = String((e && (e.shortMessage || e.message)) || e).slice(0, 80);
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
    const summary = { kind: 'stage', stage: conc, minutes: +mins.toFixed(2), ok: st.ok, failed: st.fail, perMinute: +(st.ok / mins).toFixed(1), medianMs: med, p95Ms: p95, explorerLagMaxBlocks: st.lagMax, explorerLagMedianBlocks: pct(st.lagSamples, 0.5), errors: st.errors };
    journal(summary);
    log(`Stage ${conc}: ${st.ok} ok, ${st.fail} failed, ${summary.perMinute} deposits/min, confirmation median ${med} ms, p95 ${p95} ms, explorer behind by up to ${st.lagMax} blocks.`);
    if (st.fail > 0.2 * (st.ok + st.fail) || (med != null && med > 30e3)) { log('Limit reached: more than 20% failed or the median confirmation is over 30 s. Stopping here.'); break; }
  }
  log('Flood finished. Next: node flood.js report');
}

function report() {
  const S = readJournal().filter((e) => e.kind === 'stage');
  if (!S.length) die('no stage finished yet');
  const deposits = readJournal().filter((e) => e.kind === 'deposit').length;
  const rows = S.map((s) => `| ${s.stage} | ${s.minutes} | ${s.ok} | ${s.failed} | ${s.perMinute} | ${s.medianMs} | ${s.p95Ms} | ${s.explorerLagMedianBlocks} / ${s.explorerLagMaxBlocks} | ${Object.entries(s.errors).map(([k, v]) => v + '× ' + k.replace(/\|/g, '/')).join('; ') || '—'} |`);
  const md = ['# Latheon throughput test without proofs', '', `Generated ${new Date().toISOString()}. Deposits into the V7 1 LTH pool from many wallets at once; ${deposits} deposits in total. Testnet only; the load came from the same server.`, '',
    '| Wallets at once | Minutes | Confirmed | Failed | Deposits/min | Confirmation median, ms | p95, ms | Explorer behind (median / max blocks) | Errors |',
    '|---|---|---|---|---|---|---|---|---|', ...rows, ''].join('\n');
  fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(path.join(OUT, 'flood-report.md'), md); console.log(md);
}

async function sweep() {
  const c = ctx(); const m = new ethers.Wallet(masterKey()).address; const done = loadJson(FUNDED, []);
  const fd = await c.provider.getFeeData(); const price = (fd.maxFeePerGas || fd.gasPrice) * 2n; let total = 0n;
  for (const i of done) {
    const w = new ethers.Wallet(walletKey(i), c.provider); const bal = await retry(() => c.provider.getBalance(w.address), 'balance'); if (bal === 0n) continue;
    const gas = await retry(() => c.provider.estimateGas({ from: w.address, to: m, value: 1n }), 'estimate'); const value = bal - gas * 2n * price; if (value <= 0n) continue;
    await (await w.sendTransaction({ to: m, value, gasLimit: gas * 2n, maxFeePerGas: price, maxPriorityFeePerGas: 0n })).wait(); total += value;
  }
  log(`Swept ${ethers.formatEther(total)} LTH from the flood wallets back to the master ${m}.`);
}

const cmd = process.argv[2];
Promise.resolve().then(() => ({ fund, run, report, sweep }[cmd] || (() => die('usage: node flood.js fund|run|report|sweep')))()).catch((e) => { console.error(e); process.exit(1); });
