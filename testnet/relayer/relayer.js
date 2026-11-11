'use strict';
/*
 * Withdrawal relayer of the Latheon test chain: submits withdrawals for users so that a fresh, empty address can receive
 * from a pool without holding gas first, and the user's own wallet never appears in the withdrawal transaction.
 *
 * Why it cannot steal: the V5 proof binds the recipient (public signal 3). The relayer can only send the transaction the
 * proof allows, paying exactly that recipient; changing the recipient makes the proof invalid. Worst case it refuses or
 * delays a request, and the user can still send the same proof from any wallet.
 *
 *   GET  /relay/api/status        relayer address, balance, limits
 *   POST /relay/api/withdraw      {pool, pA, pB, pC, root, nullifierHash, recipient}        one note, to one of our pools
 *   POST /relay/api/withdrawMany  {router, items: [[pool, pA, pB, pC, root, nullifierHash], ...], recipient}   through our router
 *   V6 pools and router (withdraw_v4): the same, plus `relayer` and `fee` (withdraw) or `relayer` and a 7th item field `fee`
 *   (withdrawMany). Both are bound into the proof. The relayer accepts relayer = 0 with fee = 0 (no fee, as today) or
 *   relayer = its own address with fee >= RELAY_MIN_FEE; nothing else.
 *
 * Delayed sending (optional, both POST routes): add "delay": {"withinSeconds": N} and the relayer checks the request at
 * once (same simulation, same limits), answers 202 {scheduled, id, notAfter} and sends the transaction at a random moment
 * within the next N seconds (60 .. RELAY_MAX_DELAY_HOURS). The point: the moment the user was online and the moment of the
 * withdrawal on chain are no longer the same, which is the cheapest defence against matching a withdrawal to a deposit by
 * time while few people use the pools. What it does not do: the relayer itself still sees when the request arrived and
 * from which IP address (it does not write either to its log or to disk); a proof is valid only while its Merkle root is
 * among the pool's last 100 (the next 99 deposits into that pool), so in a busy pool a long delay can expire it, and the
 * request then ends as failed with the reason; nothing is retried with new data, because the relayer has no keys.
 *   GET    /relay/api/scheduled/ID   {state: waiting | sent | failed | cancelled, tx?, error?, notAfter}
 *   DELETE /relay/api/scheduled/ID   cancels a waiting request (the ID is the only credential: keep it private)
 * Waiting requests are kept in RELAY_QUEUE_FILE (proofs and recipients, no IP addresses, no arrival time) so that a
 * restart does not lose them; a finished request keeps only its state and transaction hash for a day.
 *
 * Every request is simulated first (eth_call from the relayer); a request that would revert — bad proof, spent note,
 * unknown root, a recipient that refuses the coin — is refused without spending gas. Recipients must be ordinary
 * addresses without code (a contract recipient could burn the relayer's gas in its receive function). Only the pools and
 * routers listed in the deployment file are accepted. Limits: RELAY_PER_IP_HOUR relays per IP per hour and RELAY_DAILY_CAP
 * per day in total (a slot is reserved when the request arrives, so a burst of parallel requests cannot pass the check
 * together; it is given back if the request is refused before sending), RELAY_FAIL_PER_IP_HOUR refused or failed requests
 * per IP per hour, at most RELAY_MAX_QUEUE requests waiting, one transaction at a time, RELAY_MIN_BALANCE LTH kept for gas.
 * Only the current generation (V7) is relayed (RELAY_VERSIONS); pools before V7 are refused with the reason, because
 * their circuit lets anyone withdraw without a deposit and the relayer would pay the gas. Every call to the node has a
 * timeout (rpcTimeoutMs) and so has the wait for a block (waitTimeoutMs, then the hash is returned marked pending), so the
 * queue never hangs; node trouble is answered 503 and not counted against the client. Transactions are signed before
 * they are sent, so a lost answer still returns the hash, and a note already in flight is not sent twice (409).
 * Nothing is stored about users: IPs live in memory for the hourly limits only; the log has transaction hashes; the only
 * file is the queue of delayed requests described above.
 *
 * Service: node relayer.js serve     Admin: node relayer.js init | address | fund AMOUNT (deployer key, asked without echo)
 * Env: L3_RPC, RELAYER_KEY_FILE, LATHEON_JSON, PORT, RELAY_PER_IP_HOUR (10), RELAY_DAILY_CAP (500), RELAY_MIN_BALANCE (1),
 * RELAY_FAIL_PER_IP_HOUR (20), RELAY_MAX_QUEUE (30), RELAY_MAX_DELAY_HOURS (24; 0 turns delayed sending off),
 * RELAY_MAX_SCHEDULED (200 waiting requests), RELAY_QUEUE_FILE (next to the key),
 * RELAY_MIN_FEE (0, in LTH: the smallest fee accepted when a request names this relayer), RELAY_EXEMPT_IPS (none; comma-separated
 * client IPs the hourly and daily limits do not apply to, for our own load tests).
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const POOL_ABI = ['function withdraw(uint256[2] _pA, uint256[2][2] _pB, uint256[2] _pC, uint256 root, uint256 nullifierHash, address recipient)'];
const ROUTER_ABI = ['function withdrawMany((uint256 pool, uint256[2] pA, uint256[2][2] pB, uint256[2] pC, uint256 root, uint256 nullifierHash)[] items, address recipient)',
  'function MAX_WITHDRAWALS() view returns (uint256)'];
const POOL_ABI_V6 = ['function withdraw(uint256[2] _pA, uint256[2][2] _pB, uint256[2] _pC, uint256 root, uint256 nullifierHash, address recipient, address relayer, uint256 fee)'];
const ROUTER_ABI_V6 = ['function withdrawMany((uint256 pool, uint256[2] pA, uint256[2][2] pB, uint256[2] pC, uint256 root, uint256 nullifierHash, uint256 fee)[] items, address recipient, address relayer)',
  'function MAX_WITHDRAWALS() view returns (uint256)'];

class Refusal extends Error { constructor(status, msg) { super(msg); this.status = status; } }
// A problem on our side (node slow, unreachable, rate-limited): never counted against the client.
class NodeTrouble extends Refusal { constructor(msg) { super(503, msg); } }
const RETIRED = 'This pool is from a generation before V7, which is retired: the relayer no longer sends its withdrawals. Withdraw your note from your own wallet in the demo.';

/**
 * The relayer logic, independent of HTTP and of where the chain runs (tests inject a local chain).
 * @param {{ethers: any, wallet: any, pools: string[], routers: string[], v6Pools?: string[], v6Routers?: string[], perIpHour?: number, dailyCap?: number, minBalance?: bigint, minFee?: bigint, exemptIps?: string[], log?: Function}} o
 */
function createRelayer(o) {
  const { ethers, wallet } = o;
  const log = o.log || (() => {});
  const pools = new Set(o.pools.map((a) => a.toLowerCase())), routers = new Set(o.routers.map((a) => a.toLowerCase()));
  const v6Pools = new Set((o.v6Pools || []).map((a) => a.toLowerCase())), v6Routers = new Set((o.v6Routers || []).map((a) => a.toLowerCase()));
  const minFee = o.minFee ?? 0n, exempt = new Set(o.exemptIps || []);
  const perIpHour = o.perIpHour ?? 10, dailyCap = o.dailyCap ?? 500, minBalance = o.minBalance ?? ethers.parseEther('1');
  const failPerIpHour = o.failPerIpHour ?? 20, maxQueue = o.maxQueue ?? 30;
  const rpcTimeoutMs = o.rpcTimeoutMs ?? 20000, waitTimeoutMs = o.waitTimeoutMs ?? 120000;
  // Delayed sending: off unless a store is given. store = { load(): job[], save(job[]) }; clock = () => ms (tests).
  const store = o.store || null, clock = o.now || Date.now;
  const maxDelaySeconds = store ? (o.maxDelaySeconds ?? 86400) : 0, minWindowSeconds = o.minWindowSeconds ?? 60, maxScheduled = o.maxScheduled ?? 200;
  const jobs = new Map();   // id -> { id, kind, body, nullifiers, dueAt, notAfter, state, tx?, error?, doneAt?, tries? }
  if (store) for (const j of store.load() || []) if (j && j.id) jobs.set(j.id, j);
  const saveJobs = () => { if (store) store.save([...jobs.values()]); };
  let running = false;
  // Pools and routers of retired generations (before V7): named so the refusal can say why.
  const retired = new Set([...(o.retiredPools || []), ...(o.retiredRouters || [])].map((a) => a.toLowerCase()));
  const inFlight = new Map();   // nullifierHash -> {tx, until}: a note already being sent is not sent twice
  let nextNonce = null;         // our own nonce counter (the node's 'pending' count can lag or be cached)
  const T = (p, what, ms = rpcTimeoutMs) => { let t; return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new NodeTrouble('The chain node did not answer in time (' + what + '). Try again in a minute.')), ms); })]).finally(() => clearTimeout(t)); };
  const isNonceErr = (e) => /nonce/i.test([reason(e), e && e.message, e && e.info && JSON.stringify(e.info), e && e.error && e.error.message].filter(Boolean).join(' '));
  const nodeErr = (e, what) => (e instanceof Refusal ? e : new NodeTrouble('The chain node is not available right now (' + what + '). Try again in a minute, or send the withdrawal from your own wallet.'));
  // Slots: {t} objects. A slot is reserved in byIp/sent when a request arrives and removed again if the request is refused
  // before anything is sent; a sent transaction keeps its slot whether it succeeded or reverted. Refusals and failures
  // also count in failsByIp, which has its own, separate hourly limit.
  const byIp = new Map(), failsByIp = new Map(); let sent = [];
  let queue = Promise.resolve(), waiting = 0;
  const serial = (fn) => { const p = queue.then(fn, fn); queue = p.catch(() => {}); return p; };
  const recent = (m, ip, now, span) => { const h = (m.get(ip) || []).filter((x) => now - x.t < span); m.set(ip, h); return h; };

  const uint = (v, name) => { try { const x = BigInt(v); if (x < 0n || x >= 2n ** 256n) throw 0; return x; } catch (e) { throw new Refusal(400, `Bad ${name}.`); } };
  const pair = (v, name) => { if (!Array.isArray(v) || v.length !== 2) throw new Refusal(400, `Bad ${name}.`); return v.map((x) => uint(x, name)); };
  const proof = (x) => {
    if (!Array.isArray(x.pB) || x.pB.length !== 2) throw new Refusal(400, 'Bad pB.');
    return { pA: pair(x.pA, 'pA'), pB: x.pB.map((r) => pair(r, 'pB')), pC: pair(x.pC, 'pC'), root: uint(x.root, 'root'), nullifierHash: uint(x.nullifierHash, 'nullifierHash') };
  };
  const address = (a, name) => { try { return ethers.getAddress(String(a)); } catch (e) { throw new Refusal(400, `Bad ${name}.`); } };
  const reason = (e) => (e && (e.reason || e.shortMessage || e.message) || 'reverted').split('\n')[0].slice(0, 160);

  // Checks the limits and, in the same synchronous step, reserves a slot (so parallel requests see each other).
  function reserve(ip, now) {
    if (exempt.has(ip)) return null;
    if (recent(failsByIp, ip, now, 3600e3).length >= failPerIpHour) throw new Refusal(429, `Limit: ${failPerIpHour} refused requests per hour from one address. Check the proof (or make a new one) and try later.`);
    const h = recent(byIp, ip, now, 3600e3);
    sent = sent.filter((x) => now - x.t < 86400e3);
    if (h.length >= perIpHour) throw new Refusal(429, `Limit: ${perIpHour} relayed withdrawals per hour from one address. Try later, or send the withdrawal from your own wallet.`);
    if (sent.length >= dailyCap) throw new Refusal(429, 'The relayer reached its daily limit. Try tomorrow, or send the withdrawal from your own wallet.');
    const slot = { t: now }; h.push(slot); sent.push(slot); return slot;
  }
  function release(ip, slot) { if (!slot) return; const h = byIp.get(ip) || []; const i = h.indexOf(slot); if (i >= 0) h.splice(i, 1); const j = sent.indexOf(slot); if (j >= 0) sent.splice(j, 1); }
  function failed(ip) { if (exempt.has(ip)) return; const h = failsByIp.get(ip) || []; h.push({ t: Date.now() }); failsByIp.set(ip, h); }

  // V6: who is paid the fee, and how much, are in the proof. Accept no fee at all, or a fee to this relayer only.
  function feeTerms(relayerField, fees) {
    const rel = relayerField === undefined || relayerField === null || relayerField === '' ? ethers.ZeroAddress : address(relayerField, 'relayer');
    if (rel === ethers.ZeroAddress) { if (fees.some((f) => f !== 0n)) throw new Refusal(400, 'A fee needs a relayer address.'); return rel; }
    if (rel !== wallet.address) throw new Refusal(400, 'This relayer only sends withdrawals that name it (or no relayer) as the fee recipient.');
    if (fees.some((f) => f < minFee)) throw new Refusal(400, 'Fee below this relayer\'s minimum (' + ethers.formatEther(minFee) + ' LTH per note).');
    return rel;
  }

  async function relay(kind, body, ip) {
    const now = Date.now();
    if (waiting >= maxQueue) throw new Refusal(503, 'The relayer is busy. Try again in a minute, or send the withdrawal from your own wallet.');
    const delay = body && body.delay !== undefined && body.delay !== null ? delayOf(body.delay) : null;
    if (delay !== null && [...jobs.values()].filter((j) => j.state === 'waiting').length >= maxScheduled) throw new Refusal(503, 'The relayer holds as many delayed withdrawals as it accepts. Try later, or send without a delay.');
    const slot = reserve(ip, now);
    let wasSent = false;
    try {
      if (delay !== null) { const r = await schedule(kind, body, delay); wasSent = true; return r; }   // accepted: the slot stays used
      return await prepareAndSend(kind, body, () => { wasSent = true; });
    } catch (e) {
      // Only the client's own mistakes count against its failure limit; trouble on our side (node, timeouts) does not.
      if (e instanceof Refusal && !(e instanceof NodeTrouble) && e.status < 500) failed(ip);
      if (!wasSent) release(ip, slot);   // refused before sending: the slot is given back
      throw e;
    }
  }

  // Validates the request and builds the call. Throws Refusal on anything malformed or not ours.
  function build(kind, body) {
    const recipient = address(body.recipient, 'recipient');
    if (recipient === ethers.ZeroAddress || recipient === wallet.address) throw new Refusal(400, 'This recipient cannot be used.');
    let contract, args;
    if (kind === 'withdraw') {
      const pool = address(body.pool, 'pool'), v6 = v6Pools.has(pool.toLowerCase());
      if (retired.has(pool.toLowerCase())) throw new Refusal(400, RETIRED);
      if (!v6 && !pools.has(pool.toLowerCase())) throw new Refusal(400, 'Not a Latheon pool on this chain.');
      const p = proof(body);
      if (v6) {
        const fee = body.fee === undefined ? 0n : uint(body.fee, 'fee'); const rel = feeTerms(body.relayer, [fee]);
        contract = new ethers.Contract(pool, POOL_ABI_V6, wallet); args = [p.pA, p.pB, p.pC, p.root, p.nullifierHash, recipient, rel, fee];
      } else { contract = new ethers.Contract(pool, POOL_ABI, wallet); args = [p.pA, p.pB, p.pC, p.root, p.nullifierHash, recipient]; }
    } else {
      const router = address(body.router, 'router'), v6 = v6Routers.has(router.toLowerCase());
      if (retired.has(router.toLowerCase())) throw new Refusal(400, RETIRED);
      if (!v6 && !routers.has(router.toLowerCase())) throw new Refusal(400, 'Not a Latheon router on this chain.');
      if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 16) throw new Refusal(400, 'Between 1 and 16 notes per request.');
      const items = body.items.map((it) => {
        if (!Array.isArray(it) || it.length !== (v6 ? 7 : 6)) throw new Refusal(400, 'Bad item.');
        const p = proof({ pA: it[1], pB: it[2], pC: it[3], root: it[4], nullifierHash: it[5] });
        const item = [uint(it[0], 'pool index'), p.pA, p.pB, p.pC, p.root, p.nullifierHash];
        if (v6) item.push(uint(it[6], 'fee'));
        return item;
      });
      if (v6) {
        const rel = feeTerms(body.relayer, items.map((x) => x[6]));
        contract = new ethers.Contract(router, ROUTER_ABI_V6, wallet); args = [items, recipient, rel];
      } else { contract = new ethers.Contract(router, ROUTER_ABI, wallet); args = [items, recipient]; }
    }
    const fn = kind === 'withdraw' ? 'withdraw' : 'withdrawMany';
    const nullifiers = (kind === 'withdraw' ? [args[4]] : args[0].map((x) => x[5])).map(String);
    return { contract, fn, args, nullifiers, recipient };
  }

  // The checks made right before sending (and when a delayed request is accepted): gas money, recipient, simulation.
  async function precheck(b) {
    const { contract, fn, args, nullifiers, recipient } = b;
    let bal, code;
    try { bal = await T(wallet.provider.getBalance(wallet.address), 'balance'); code = await T(wallet.provider.getCode(recipient), 'recipient code'); }
    catch (e) { throw nodeErr(e, 'reading the chain'); }
    if (bal < minBalance) throw new Refusal(503, 'The relayer is out of gas money. Try later, or send the withdrawal from your own wallet.');
    if (code !== '0x') throw new Refusal(400, 'The relayer only pays to ordinary addresses, not to contracts. Use a fresh address, or send the withdrawal from your own wallet.');
    if (nullifiers.some((n) => inFlight.has(n))) throw new Refusal(409, 'This note is already being sent. Wait for it on the explorer instead of sending it again.');
    try { await T(contract[fn].staticCall(...args), 'simulation'); return await T(contract[fn].estimateGas(...args), 'gas estimate'); }
    catch (e) {
      if (e && e.code === 'CALL_EXCEPTION') throw new Refusal(400, 'Refused before sending (the chain would reject it): ' + reason(e));
      throw nodeErr(e, 'simulation');   // node error, timeout, 429: not the client's fault, nothing sent
    }
  }

  function notBusy(nullifiers) {
    const now = Date.now(); for (const [k, v] of inFlight) if (v.until < now) inFlight.delete(k);
    const busyNote = nullifiers.find((n) => inFlight.has(n));
    if (busyNote) throw new Refusal(409, 'This note is already being sent in ' + inFlight.get(busyNote).tx + '. Wait for it on the explorer instead of sending it again.');
  }

  // ---- delayed sending
  function delayOf(d) {
    if (!maxDelaySeconds) throw new Refusal(400, 'Delayed sending is not available on this relayer. Send without "delay".');
    const n = d && typeof d === 'object' ? Number(d.withinSeconds) : NaN;
    if (!Number.isInteger(n) || n < minWindowSeconds || n > maxDelaySeconds) throw new Refusal(400, `Bad delay: withinSeconds must be a whole number from ${minWindowSeconds} to ${maxDelaySeconds}.`);
    return n;
  }
  // The request as stored: only the fields the relayer reads (no delay, nothing else the client sent).
  function strip(kind, body) {
    const x = kind === 'withdraw' ? { pool: body.pool, pA: body.pA, pB: body.pB, pC: body.pC, root: body.root, nullifierHash: body.nullifierHash, recipient: body.recipient }
      : { router: body.router, items: body.items, recipient: body.recipient };
    if (body.relayer !== undefined) x.relayer = body.relayer;
    if (body.fee !== undefined) x.fee = body.fee;
    return JSON.parse(JSON.stringify(x, (k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  }
  async function schedule(kind, body, within) {
    const b = build(kind, body);
    notBusy(b.nullifiers);
    const held = [...jobs.values()].find((j) => j.state === 'waiting' && j.nullifiers.some((n) => b.nullifiers.includes(n)));
    if (held) throw new Refusal(409, 'This note is already waiting in a delayed withdrawal. Cancel that one first, or wait for it.');
    waiting++;
    try { await serial(() => precheck(b)); } finally { waiting--; }
    const now = clock(), lo = Math.min(minWindowSeconds, within);
    const job = { id: crypto.randomBytes(16).toString('hex'), kind, body: strip(kind, body), nullifiers: b.nullifiers,
      dueAt: now + (lo + crypto.randomInt(0, within - lo + 1)) * 1000, notAfter: now + within * 1000, state: 'waiting' };
    jobs.set(job.id, job); saveJobs();
    return { scheduled: true, id: job.id, notAfter: new Date(job.notAfter).toISOString(),
      message: 'Accepted. It will be sent at a random moment before notAfter. Keep the id private: it shows the state and can cancel the request.' };
  }
  const finish = (j, state, extra) => { Object.assign(j, { state, doneAt: clock() }, extra); delete j.body; saveJobs(); };
  /** Sends every delayed request that is due. Called by a timer in the service and directly in tests. */
  async function runDue() {
    if (running) return 0; running = true; let n = 0;
    try {
      const now = clock();
      for (const j of [...jobs.values()]) if (j.state !== 'waiting' && now - (j.doneAt || 0) > 86400e3) jobs.delete(j.id);
      for (const j of [...jobs.values()].filter((x) => x.state === 'waiting' && x.dueAt <= now).sort((a, c) => a.dueAt - c.dueAt)) {
        if (j.state !== 'waiting') continue;   // cancelled while an earlier one was being sent
        try { const r = await prepareAndSend(j.kind, j.body, () => {}); finish(j, 'sent', { tx: r.tx }); n++; }
        catch (e) {
          // Trouble on our side: try again in a minute, for up to an hour past the promised time. Anything else is final.
          const ours = e instanceof NodeTrouble || !(e instanceof Refusal) || e.status >= 500;
          const txInError = (String(e && e.message).match(/0x[0-9a-f]{64}/) || [])[0];
          if (txInError) finish(j, 'failed', { tx: txInError, error: reason(e) });
          else if (ours && clock() < j.notAfter + 3600e3) { j.dueAt = clock() + 60e3; j.tries = (j.tries || 0) + 1; saveJobs(); }
          else finish(j, 'failed', { error: reason(e) });
        }
      }
      saveJobs();
    } finally { running = false; }
    return n;
  }
  function scheduledState(id) {
    const j = jobs.get(String(id)); if (!j) throw new Refusal(404, 'No such delayed withdrawal (finished ones are forgotten after a day).');
    const out = { state: j.state, notAfter: new Date(j.notAfter).toISOString() };
    if (j.tx) out.tx = j.tx; if (j.error) out.error = j.error;
    return out;
  }
  function cancel(id) {
    const j = jobs.get(String(id)); if (!j) throw new Refusal(404, 'No such delayed withdrawal.');
    if (j.state !== 'waiting') throw new Refusal(409, 'This delayed withdrawal is already ' + j.state + '.');
    finish(j, 'cancelled'); return scheduledState(id);
  }

  async function prepareAndSend(kind, body, markSent) {
    const b = build(kind, body);
    const { contract, fn, args, nullifiers } = b;
    notBusy(nullifiers);
    waiting++;
    return serial(async () => {
      const gas = await precheck(b);
      markSent();
      const txReq = { ...(await contract[fn].populateTransaction(...args)), gasLimit: gas + gas / 5n };
      const canSign = !!wallet.signingKey;   // an ethers.Wallet: sign first, so the hash is known before broadcasting
      let hash = null, sentTx = null;
      // "nonce has already been used" / "nonce too low": the node's count lagged behind our last transaction; the
      // transaction was rejected, nothing was sent, so sending again with a fresh nonce is safe (up to three retries).
      for (let attempt = 1; ; attempt++) {
        try {
          // never below the node's count (a transaction sent from this key elsewhere) nor below our own last one (the
          // node's 'pending' count can lag right after a send)
          const nodeCount = await T(wallet.provider.getTransactionCount(wallet.address, 'pending'), 'nonce');
          const req = { ...txReq, nonce: Math.max(nodeCount, nextNonce ?? 0) };
          if (canSign) {
            const signed = await wallet.signTransaction(await T(wallet.populateTransaction(req), 'fees'));
            hash = ethers.keccak256(signed);
            try { await T(wallet.provider.broadcastTransaction(signed), 'sending'); }
            catch (e) {
              if (isNonceErr(e)) throw e;
              // the answer may have been lost after the node accepted it: look the hash up before giving up
              await new Promise((r) => setTimeout(r, 1000));
              const known = await T(wallet.provider.getTransaction(hash), 'lookup').catch(() => null);
              if (!known) throw e;
              log('send answer lost, but the node has ' + hash);
            }
          } else { sentTx = await T(wallet.sendTransaction(req), 'sending'); hash = sentTx.hash; }
          nextNonce = req.nonce + 1;
          break;
        } catch (e) {
          nextNonce = null;
          if (attempt < 4 && isNonceErr(e)) { log('nonce taken, retrying: ' + reason(e)); await new Promise((r) => setTimeout(r, 400 * attempt)); continue; }
          log('error: ' + reason(e));
          throw new Refusal(502, 'The relayer could not send the transaction. Try again, or send it from your own wallet.');
        }
      }
      for (const n of nullifiers) inFlight.set(n, { tx: hash, until: Date.now() + 15 * 60e3 });
      let rc;
      try { rc = await wallet.provider.waitForTransaction(hash, 1, waitTimeoutMs); }
      catch (e) {
        // not mined in time: answer with the hash and free the queue; the next send takes its nonce from the node again
        nextNonce = null;
        log('not mined within ' + waitTimeoutMs / 1000 + ' s: ' + hash);
        return { tx: hash, pending: true, message: 'Sent, but not yet in a block. Check this transaction on the explorer; do not send the same note again.' };
      }
      for (const n of nullifiers) inFlight.delete(n);
      if (!rc || rc.status !== 1) throw new Refusal(502, 'The transaction failed on-chain: ' + hash);
      log(`relayed ${fn} ${hash} gas ${rc.gasUsed}`);
      return { tx: hash, block: rc.blockNumber, gasUsed: rc.gasUsed.toString() };
    }).finally(() => { waiting--; });
  }

  async function status(ip) {
    const bal = await wallet.provider.getBalance(wallet.address);
    sent = sent.filter((x) => Date.now() - x.t < 86400e3);
    return { address: wallet.address, balance: ethers.formatEther(bal), enabled: bal >= minBalance, perIpHour, dailyCap, relayedLast24h: sent.length, maxNotesPerRequest: 16, failPerIpHour, maxQueue,
      fee: '0', minFeeV6: ethers.formatEther(minFee), v6: v6Pools.size > 0,
      delay: { enabled: maxDelaySeconds > 0, minSeconds: minWindowSeconds, maxSeconds: maxDelaySeconds, waiting: [...jobs.values()].filter((j) => j.state === 'waiting').length, maxWaiting: maxScheduled },
      yourIp: ip, exempt: exempt.has(ip) };   // the caller's own address as the relayer sees it (to set RELAY_EXEMPT_IPS / FAUCET_EXEMPT_IPS)
  }

  /** HTTP-independent entry: returns {status, body}. */
  async function handle(method, url, body, ip) {
    try {
      if (method === 'GET' && url === '/relay/api/status') return { status: 200, body: await status(ip) };
      if (method === 'POST' && (url === '/relay/api/withdraw' || url === '/relay/api/withdrawMany')) {
        const r = await relay(url.endsWith('Many') ? 'withdrawMany' : 'withdraw', body || {}, ip);
        return { status: r.scheduled ? 202 : 200, body: r };
      }
      const m = /^\/relay\/api\/scheduled\/([0-9a-f]{32})$/.exec(url);
      if (m && method === 'GET') return { status: 200, body: scheduledState(m[1]) };
      if (m && method === 'DELETE') return { status: 200, body: cancel(m[1]) };
      return { status: 404, body: { error: 'Not found.' } };
    } catch (e) {
      if (e instanceof Refusal) return { status: e.status, body: { error: e.message } };
      log('error: ' + reason(e));
      return { status: 502, body: { error: 'The relayer could not send the transaction. Try again, or send it from your own wallet.' } };
    }
  }
  return { handle, status, relay, runDue };
}

module.exports = { createRelayer, Refusal, NodeTrouble };

// ---------------- service and admin ----------------
if (require.main === module) {
  const { ethers } = require('ethers');
  const env = (k, d) => (process.env[k] && process.env[k].trim()) || d;
  const L3_RPC = env('L3_RPC', 'http://127.0.0.1:8449');
  const KEY_FILE = env('RELAYER_KEY_FILE', path.join(__dirname, 'secret', 'relayer.key'));
  const LATHEON_JSON = env('LATHEON_JSON', '/latheon-out/latheon-deployments.json');
  const log = (...a) => console.log(new Date().toISOString(), ...a);
  const die = (m) => { console.error('ERROR: ' + m); process.exit(1); };
  const provider = new ethers.JsonRpcProvider(L3_RPC, undefined, { staticNetwork: true, cacheTimeout: -1 });
  const [cmd, arg] = process.argv.slice(2);

  (async () => {
    if (cmd === 'init') {
      if (fs.existsSync(KEY_FILE)) return console.log('Relayer key already exists. Address: ' + new ethers.Wallet(fs.readFileSync(KEY_FILE, 'utf8').trim()).address);
      fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true, mode: 0o700 });
      const w = ethers.Wallet.createRandom(); fs.writeFileSync(KEY_FILE, w.privateKey + '\n', { mode: 0o600 });
      return console.log('Relayer key created in ' + KEY_FILE + ' (keep it private). Address: ' + w.address);
    }
    if (!fs.existsSync(KEY_FILE)) {
      if (cmd === 'serve') { log('no relayer key yet (./relayer-cmd.sh init, then restart the service): idle'); return setInterval(() => {}, 1 << 30); }
      die('no relayer key yet: ./relayer-cmd.sh init');
    }
    const wallet = new ethers.Wallet(fs.readFileSync(KEY_FILE, 'utf8').trim(), provider);
    if (cmd === 'address') return console.log('Relayer: ' + wallet.address + '\nBalance: ' + ethers.formatEther(await provider.getBalance(wallet.address)) + ' LTH');
    if (cmd === 'fund') {
      if (!arg || !/^\d+(\.\d+)?$/.test(arg)) die('usage: fund AMOUNT');
      let key = env('DEPLOYER_KEY', '');
      if (!key) { process.stdout.write('Deployer private key (input hidden): '); key = await new Promise((res) => { const s = process.stdin; let b = ''; if (s.isTTY) s.setRawMode(true); s.resume(); s.setEncoding('utf8'); s.on('data', (c) => { for (const ch of c) { if (ch === '\r' || ch === '\n') { if (s.isTTY) s.setRawMode(false); s.pause(); process.stdout.write('\n'); return res(b.trim()); } if (ch === '\u0003') process.exit(1); if (ch === '\u007f' || ch === '\b') { b = b.slice(0, -1); continue; } b += ch; } }); }); }
      if (/^[0-9a-fA-F]{64}$/.test(key)) key = '0x' + key;
      if (!/^0x[0-9a-fA-F]{64}$/.test(key)) die('the key must be 64 hex characters');
      const d = new ethers.Wallet(key, provider);
      const rc = await (await d.sendTransaction({ to: wallet.address, value: ethers.parseEther(arg) })).wait();
      return console.log(`Sent ${arg} LTH to the relayer, tx ${rc.hash}. Relayer balance: ${ethers.formatEther(await provider.getBalance(wallet.address))} LTH`);
    }
    if (cmd !== 'serve') die('usage: node relayer.js serve | init | address | fund AMOUNT');

    const dep = JSON.parse(fs.readFileSync(LATHEON_JSON, 'utf8'));
    // V6 and V7 share the fee-bearing interface (withdraw + relayer + fee; 7-field withdrawMany items), so the relayer
    // treats them the same; the v6Pools/v6Routers buckets below mean "fee-bearing pools", V6 and V7 alike.
    // Only the current generation (V7) is relayed. Older pools carry the pre-V7 circuit flaw (withdrawal without a
    // deposit, THREAT-MODEL 8.0); relaying them would pay gas for anyone draining them. Their notes are withdrawn from
    // the user's own wallet. RELAY_VERSIONS can widen this (e.g. "v6-native,v6,v7-native,v7") only on purpose.
    const ok = new Set(env('RELAY_VERSIONS', 'v7-native,v7').split(',').map((x) => x.trim()));
    const cur = (x) => ok.has(x.version) && !x.frozen && !x.forgeable;
    // Delayed requests survive a restart in one small file next to the key (atomic replace, owner-only).
    const QUEUE_FILE = env('RELAY_QUEUE_FILE', path.join(path.dirname(KEY_FILE), 'scheduled.json'));
    const maxDelayHours = Number(env('RELAY_MAX_DELAY_HOURS', '24'));
    const store = maxDelayHours > 0 ? {
      load: () => { try { return JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') log('queue file unreadable, starting empty: ' + e.message); return []; } },
      save: (list) => { const tmp = QUEUE_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(list), { mode: 0o600 }); fs.renameSync(tmp, QUEUE_FILE); },
    } : null;
    const relayer = createRelayer({ ethers, wallet, log, store, maxDelaySeconds: Math.round(maxDelayHours * 3600), maxScheduled: Number(env('RELAY_MAX_SCHEDULED', '200')),
      pools: [], routers: [],
      v6Pools: dep.pools.filter(cur).map((p) => p.address), v6Routers: (dep.routers || []).filter(cur).map((r) => r.address),
      retiredPools: dep.pools.filter((p) => !cur(p)).map((p) => p.address), retiredRouters: (dep.routers || []).filter((r) => !cur(r)).map((r) => r.address),
      perIpHour: Number(env('RELAY_PER_IP_HOUR', '10')), failPerIpHour: Number(env('RELAY_FAIL_PER_IP_HOUR', '20')), maxQueue: Number(env('RELAY_MAX_QUEUE', '30')), dailyCap: Number(env('RELAY_DAILY_CAP', '500')), minBalance: ethers.parseEther(env('RELAY_MIN_BALANCE', '1')),
      minFee: ethers.parseEther(env('RELAY_MIN_FEE', '0')), exemptIps: env('RELAY_EXEMPT_IPS', '').split(',').map((x) => x.trim()).filter(Boolean) });
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '600' };
    const ipOf = (req) => { const x = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean); return x.length ? x[x.length - 1] : (req.socket.remoteAddress || 'unknown'); };
    const server = http.createServer((req, res) => {
      const url = (req.url || '').split('?')[0].replace(/\/+$/, '');
      const reply = (code, body) => { res.writeHead(code, { ...cors, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
      if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
      let raw = '', big = false;
      req.on('data', (c) => { if (big) return; raw += c; if (raw.length > 65536) { big = true; reply(413, { error: 'Request too large.' }); req.destroy(); } });
      req.on('end', async () => {
        if (big) return;
        let body = null; if (req.method === 'POST') { try { body = JSON.parse(raw || '{}'); } catch (e) { return reply(400, { error: 'Send JSON.' }); } }
        const r = await relayer.handle(req.method, url, body, ipOf(req)); reply(r.status, r.body);
      });
    });
    if (store) setInterval(() => { relayer.runDue().catch((e) => log('delayed queue error: ' + (e && e.message))); }, 5000);
    server.headersTimeout = 10000; server.requestTimeout = 15000;   // slow clients cannot hold connections open
    server.listen(Number(env('PORT', '8090')), () => log('relayer ' + wallet.address + ' listening; pools ' + dep.pools.length + ', routers ' + (dep.routers || []).length));
  })().catch((e) => die(e.message || String(e)));
}
