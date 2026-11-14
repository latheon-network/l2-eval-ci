'use strict';
/**
 * Quest checks for the Latheon test chain (Zealy and Galxe), testnet only.
 *
 *   GET  /quests                          page: get your code, upload a disclosure report
 *   GET  /quests/api/status               public settings
 *   GET  /quests/api/code?address=0x…     the one-time auditor code for this address (deterministic, HMAC of a secret)
 *   POST /quests/api/report               {address, report}: checks a disclosure report made for that code
 *   GET  /quests/api/check/TASK?address=  Galxe REST credential: always 200, {"ok": 1|0, "reason": "…"}
 *   POST /quests/api/zealy/TASK           Zealy API task: X-Api-Key, body.accounts.wallet; 200 or 400 {"message"}
 *
 * TASK is one of:
 *   faucet   the address received LTH from our faucet
 *   deposit  the address sent a successful transaction to a current (V7) pool or router
 *   report   the address uploaded a valid disclosure report: proof accepted by the chain's disclose verifier, made for
 *            this address's code, for a deposit in a current pool whose transaction was sent from this address
 *
 * What it never asks for or checks: withdrawals. Checking a withdrawal would require linking the deposit wallet with
 * the withdrawal address, which is exactly what the pools hide. The report task shows one deposit to us as the
 * "auditor", which is the feature it is meant to demonstrate.
 *
 * Reads only public data: Blockscout's API (inside the compose network) and the chain's RPC. Its only secret is the
 * HMAC key for the codes (QUESTS_SECRET_FILE, created on first start); its only state is the list of addresses with an
 * accepted report (STATE_FILE). Env: L3_RPC, LATHEON_JSON, BLOCKSCOUT_API, FAUCET_STATUS_URL, QUESTS_SECRET_FILE,
 * STATE_DIR, ZEALY_API_KEY (empty: Zealy endpoint off), PORT (8095), MAX_ITEMS (20).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const TASKS = ['faucet', 'deposit', 'report'];
const VERIFIER_ABI = ['function verifyProof(uint[2] _pA, uint[2][2] _pB, uint[2] _pC, uint[3] _pubSignals) view returns (bool)'];

class Refusal extends Error { constructor(message) { super(message); this.refusal = true; } }

/**
 * Core logic with injected I/O so it can be tested without a chain.
 * @param {object} o
 * @param {Buffer} o.secret                 HMAC key for the codes
 * @param {string[]} o.currentPools         V7 pool addresses
 * @param {string[]} o.currentTargets       V7 pools and routers (deposit targets)
 * @param {string} o.discloseVerifier
 * @param {(addr:string, filter:'to'|'from') => Promise<object[]>} o.addressTxs   Blockscout transactions of an address
 * @param {() => Promise<string>} o.faucetAddress
 * @param {(pool:string, commitment:bigint) => Promise<{txHash:string}|null>} o.findDeposit
 * @param {(txHash:string) => Promise<string>} o.txFrom
 * @param {(pA, pB, pC, pub) => Promise<boolean>} o.verifyOnChain
 * @param {{reports: object}} o.state
 * @param {() => void} o.save
 */
function createQuests(o) {
  const pools = new Set(o.currentPools.map((a) => a.toLowerCase()));
  const targets = new Set(o.currentTargets.map((a) => a.toLowerCase()));
  const maxItems = o.maxItems || 20;
  const lower = (a) => {
    if (typeof a !== 'string' || !ADDR.test(a.trim())) throw new Refusal('Not a valid 0x address.');
    return a.trim().toLowerCase();
  };
  const codeFor = (addr) => BigInt('0x' + crypto.createHmac('sha256', o.secret).update('latheon-quest-code:' + lower(addr)).digest('hex').slice(0, 16)).toString();
  const ok = (tx) => tx && (tx.status === 'ok' || tx.result === 'success');

  async function faucet(addr) {
    const a = lower(addr), f = (await o.faucetAddress()).toLowerCase();
    const txs = await o.addressTxs(a, 'to');
    return txs.some((t) => ok(t) && t.from && String(t.from.hash).toLowerCase() === f)
      ? { ok: 1, reason: 'Received LTH from the Latheon faucet.' }
      : { ok: 0, reason: 'No faucet transfer to this address found yet. Claim at explorer.testnet.latheon.xyz/faucet (it can take a few seconds to show).' };
  }

  async function deposit(addr) {
    const a = lower(addr);
    const txs = await o.addressTxs(a, 'from');
    return txs.some((t) => ok(t) && t.to && targets.has(String(t.to.hash).toLowerCase()) && BigInt(t.value || '0') > 0n)
      ? { ok: 1, reason: 'Deposit into a Latheon V7 pool found.' }
      : { ok: 0, reason: 'No deposit into a current (V7) Latheon pool from this address yet. Use latheon.xyz/demo.' };
  }

  async function report(addr) {
    const a = lower(addr);
    return o.state.reports[a]
      ? { ok: 1, reason: 'Disclosure report accepted.' }
      : { ok: 0, reason: 'No accepted disclosure report for this address yet. Upload it at explorer.testnet.latheon.xyz/quests.' };
  }

  async function check(task, addr) {
    if (task === 'faucet') return faucet(addr);
    if (task === 'deposit') return deposit(addr);
    if (task === 'report') return report(addr);
    throw new Refusal('Unknown task.');
  }

  /** Checks an uploaded report (spec docs/disclosure-report-format.md, section 5, steps 1-4 and 7, plus the sender). */
  async function submitReport(addr, rep) {
    const a = lower(addr), code = codeFor(a);
    if (!rep || rep.type !== 'latheon-disclosure-report' || rep.version !== 1) throw new Refusal('This is not a Latheon disclosure report file (version 1).');
    if (!Array.isArray(rep.items) || !rep.items.length) throw new Refusal('The report has no rows.');
    if (String(rep.auditorNonce) !== code) throw new Refusal('The report was made for a different code. Get your code on this page for this address, make the report again with it.');
    if (rep.items.length > maxItems) throw new Refusal(`Too many rows: one is enough, at most ${maxItems}.`);
    const accepted = [], problems = [];
    for (let i = 0; i < rep.items.length; i++) {
      const x = rep.items[i] || {}, p = x.proof || {};
      const row = `Row ${i + 1}: `;
      try {
        if (x.keys !== undefined) { problems.push(row + 'contains keys; never send keys of a note to anyone. Make the report without them.'); continue; }
        if (!(Array.isArray(p.pA) && p.pA.length === 2 && Array.isArray(p.pB) && p.pB.length === 2 && Array.isArray(p.pC) && p.pC.length === 2 && Array.isArray(p.pubSignals) && p.pubSignals.length === 3)) { problems.push(row + 'malformed proof.'); continue; }
        const pub = p.pubSignals.map((v) => BigInt(v));
        if (pub[2].toString() !== code) { problems.push(row + 'proof made for a different code.'); continue; }
        if (pub[0].toString() !== String(BigInt(x.commitment))) { problems.push(row + 'commitment does not match the proof.'); continue; }
        if (typeof x.pool !== 'string' || !pools.has(x.pool.toLowerCase())) { problems.push(row + 'not a current (V7) Latheon pool.'); continue; }
        if (!(await o.verifyOnChain(p.pA, p.pB, p.pC, p.pubSignals))) { problems.push(row + 'the disclose verifier rejected the proof.'); continue; }
        const dep = await o.findDeposit(x.pool, pub[0]);
        if (!dep) { problems.push(row + 'no such deposit in that pool.'); continue; }
        if ((await o.txFrom(dep.txHash)).toLowerCase() !== a) { problems.push(row + 'that deposit was not sent from this address.'); continue; }
        accepted.push(pub[0].toString());
      } catch (e) { problems.push(row + 'could not be checked (' + (e.shortMessage || e.message) + ').'); }
    }
    if (!accepted.length) throw new Refusal('Report not accepted. ' + problems.join(' '));
    o.state.reports[a] = { at: new Date().toISOString(), rows: accepted.length };
    o.save();
    return { ok: 1, accepted: accepted.length, problems, reason: 'Disclosure report accepted.' };
  }

  return { codeFor, check, submitReport, TASKS };
}

// ---------------------------------------------------------------------------------------------------------------------

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Refusal('Request too large.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(new Refusal('Body is not JSON.')); } });
    req.on('error', reject);
  });
}

function main() {
  const { ethers } = require('ethers');
  const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);
  const log = (m) => console.log(new Date().toISOString() + ' ' + m);
  const L3_RPC = env('L3_RPC', 'http://nitro:8449');
  const BLOCKSCOUT_API = env('BLOCKSCOUT_API', 'http://blockscout:4000/api/v2').replace(/\/$/, '');
  const FAUCET_STATUS_URL = env('FAUCET_STATUS_URL', 'http://faucet:8080/faucet/api/status');
  const STATE_DIR = env('STATE_DIR', '/quests/secret');
  const SECRET_FILE = env('QUESTS_SECRET_FILE', path.join(STATE_DIR, 'quests.key'));
  const STATE_FILE = path.join(STATE_DIR, 'reports.json');
  const ZEALY_API_KEY = env('ZEALY_API_KEY', '');
  const PAGE = fs.readFileSync(path.join(__dirname, 'page.html'), 'utf8');

  let secret;
  try { secret = Buffer.from(fs.readFileSync(SECRET_FILE, 'utf8').trim(), 'hex'); } catch (e) {
    secret = crypto.randomBytes(32); fs.writeFileSync(SECRET_FILE, secret.toString('hex') + '\n', { mode: 0o600 }); log('created a new code secret');
  }
  let state = { reports: {} };
  try { state = { ...state, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) }; } catch (e) { /* first start */ }
  const save = () => { const tmp = STATE_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(state)); fs.renameSync(tmp, STATE_FILE); };

  const dep = JSON.parse(fs.readFileSync(env('LATHEON_JSON', '/latheon-out/latheon-deployments.json'), 'utf8'));
  const cur = (x) => (x.version === 'v7-native' || x.version === 'v7') && !x.frozen && !x.forgeable;
  const curPools = dep.pools.filter(cur);
  const curRouters = (dep.routers || []).filter(cur);
  const provider = new ethers.JsonRpcProvider(L3_RPC, undefined, { staticNetwork: true });
  const verifier = new ethers.Contract(dep.network.discloseVerifier, VERIFIER_ABI, provider);
  const depositTopic = ethers.id('Deposit(uint256,uint32,uint256)');
  const startOf = new Map(curPools.map((p) => [p.address.toLowerCase(), Number(p.deployBlock || 0)]));

  let faucetAddr = null;
  async function getJson(url) {
    const r = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) throw new Error('HTTP ' + r.status + ' from ' + url.split('?')[0]);
    return r.json();
  }
  const q = createQuests({
    secret, state, save,
    currentPools: curPools.map((p) => p.address),
    currentTargets: curPools.map((p) => p.address).concat(curRouters.map((r) => r.address)),
    discloseVerifier: dep.network.discloseVerifier,
    faucetAddress: async () => faucetAddr || (faucetAddr = (await getJson(FAUCET_STATUS_URL)).address),
    addressTxs: async (a, filter) => {
      let url = `${BLOCKSCOUT_API}/addresses/${a}/transactions?filter=${filter}`, all = [];
      for (let page = 0; page < 4 && url; page++) {
        const j = await getJson(url); all = all.concat(j.items || []);
        url = j.next_page_params ? `${BLOCKSCOUT_API}/addresses/${a}/transactions?filter=${filter}&` + new URLSearchParams(j.next_page_params).toString() : null;
      }
      return all;
    },
    findDeposit: async (pool, commitment) => {
      const logs = await provider.getLogs({ address: pool, topics: [depositTopic, ethers.toBeHex(commitment, 32)], fromBlock: startOf.get(pool.toLowerCase()) || 0, toBlock: 'latest' });
      return logs.length ? { txHash: logs[0].transactionHash } : null;
    },
    txFrom: async (h) => (await provider.getTransaction(h)).from,
    verifyOnChain: (pA, pB, pC, pub) => verifier.verifyProof(pA, pB, pC, pub),
  });

  const send = (res, code, body, type = 'application/json') => {
    res.writeHead(code, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(type === 'application/json' ? JSON.stringify(body) : body);
  };

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const p = u.pathname.replace(/\/+$/, '') || '/';
    try {
      if (req.method === 'GET' && (p === '/quests' || p === '/')) return send(res, 200, PAGE, 'text/html');
      if (req.method === 'GET' && p === '/quests/api/status') return send(res, 200, { tasks: TASKS, pools: curPools.map((x) => ({ address: x.address, amount: x.amount })), routers: curRouters.map((x) => x.address), zealy: !!ZEALY_API_KEY, acceptedReports: Object.keys(state.reports).length });
      if (req.method === 'GET' && p === '/quests/api/code') return send(res, 200, { address: (u.searchParams.get('address') || '').toLowerCase(), code: q.codeFor(u.searchParams.get('address')) });
      if (req.method === 'POST' && p === '/quests/api/report') {
        const b = await readBody(req, 256 * 1024);
        const r = await q.submitReport(b.address, b.report);
        log('report accepted for ' + String(b.address).toLowerCase() + ' rows ' + r.accepted);
        return send(res, 200, r);
      }
      let m = p.match(/^\/quests\/api\/check\/([a-z]+)$/);
      if (req.method === 'GET' && m) {
        try { return send(res, 200, await q.check(m[1], u.searchParams.get('address'))); } catch (e) { return send(res, 200, { ok: 0, reason: e.refusal ? e.message : 'Check failed, try again in a minute.' }); }
      }
      m = p.match(/^\/quests\/api\/zealy\/([a-z]+)$/);
      if (req.method === 'POST' && m) {
        if (!ZEALY_API_KEY) return send(res, 400, { message: 'Zealy checks are not configured.' });
        const given = String(req.headers['x-api-key'] || '');
        if (given.length !== ZEALY_API_KEY.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(ZEALY_API_KEY))) return send(res, 400, { message: 'Invalid API key.' });
        const b = await readBody(req, 16 * 1024);
        const wallet = b && b.accounts && b.accounts.wallet;
        if (!wallet) return send(res, 400, { message: 'Connect an EVM wallet in Zealy first.' });
        let r; try { r = await q.check(m[1], wallet); } catch (e) { return send(res, 400, { message: e.refusal ? e.message : 'Check failed, try again in a minute.' }); }
        return r.ok ? send(res, 200, { message: r.reason }) : send(res, 400, { message: r.reason });
      }
      return send(res, 404, { error: 'Not found' });
    } catch (e) {
      if (e.refusal) return send(res, 400, { error: e.message });
      log('error ' + req.method + ' ' + p + ': ' + (e.stack || e.message));
      return send(res, 500, { error: 'Internal error, try again later.' });
    }
  });
  const port = Number(env('PORT', '8095'));
  server.listen(port, () => log(`quests listening on ${port}; pools ${curPools.length}, routers ${curRouters.length}, zealy ${ZEALY_API_KEY ? 'on' : 'off'}, accepted reports ${Object.keys(state.reports).length}`));
}

module.exports = { createQuests, Refusal, TASKS };
if (require.main === module) main();
