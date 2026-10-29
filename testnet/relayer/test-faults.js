'use strict';
/*
 * Fault tests of the withdrawal relayer: how createRelayer behaves when the chain's RPC misbehaves, and how its queue and
 * limits hold under parallel requests. Local only: an in-process ganache behind a small JSON-RPC proxy over HTTP that
 * injects faults; the relayer talks to it through ethers.JsonRpcProvider with staticNetwork, as in the service.
 *
 * No proofs here: the pool is a test double with the V6/V7 withdraw interface (root != 0, nullifier spent once, pays the
 * recipient). Proof handling is covered by test.js with real proofs; this file is about RPC failures, nonces and limits.
 *
 *   node test-faults.js            (about a minute)      npm run test:faults
 *   DEBUG=1 node test-faults.js    every RPC call through the proxy and the relayer's log
 *   BLOCK_TIME=0.3 (default)       ganache mines every 0.3 s, like a sequencer; BLOCK_TIME=0 (instant mining) makes the
 *                                  burst checks fail: see the note on the cached 'pending' nonce in the review
 *
 * Proxy note: ganache leaves pool transactions out of eth_getTransactionCount(…, 'pending'); geth and Nitro count them.
 * Check 4 answers that call as they would.
 *
 * Checks marked KNOWN-DEFECT describe current behaviour that is a reliability problem (see the comments next to them):
 * they pass when the defect is still there, so the suite stays green and shows when a fix changes the behaviour.
 */
const http = require('http');
const solc = require('solc'), ganache = require('ganache'), { ethers } = require('ethers');
const { createRelayer } = require('./relayer.js');

const CI = !!process.env.GITHUB_ACTIONS;
const results = [];
const rec = (n, ok, note) => { results.push(ok); console.log((ok ? 'ok   ' : 'FAIL ') + n + (note ? '   [' + note + ']' : '')); if (!ok && CI) console.log(`::error::${n} [${note || ''}]`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms) => Promise.race([p.then((v) => ({ done: true, v }), (e) => ({ done: true, e })), sleep(ms).then(() => ({ done: false }))]);

const POOL_SRC = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
// Test double with the V6/V7 withdraw interface. No proof check: only the parts the relayer depends on.
contract MockPoolV7 {
    mapping(uint256 => bool) public nullifierHashes;
    uint256 public constant DENOMINATION = 1 ether;
    receive() external payable {}
    function withdraw(uint256[2] calldata, uint256[2][2] calldata, uint256[2] calldata, uint256 root, uint256 nullifierHash,
                      address recipient, address relayer, uint256 fee) external {
        require(root != 0, "Unknown root");
        require(!nullifierHashes[nullifierHash], "Note already spent");
        require(fee <= DENOMINATION, "Fee exceeds denomination");
        nullifierHashes[nullifierHash] = true;
        payable(recipient).transfer(DENOMINATION - fee);
        if (fee > 0) payable(relayer).transfer(fee);
    }
}`;

// ---------------- fault-injecting JSON-RPC proxy ----------------
// rule(call, ctx) -> undefined (pass) | {http: code, retryAfter?} | {hang: true} | {error: {code, message}} |
//                    {result: x} | {forwardThenDrop: true} | {swallow: hash} (answer the hash, do not forward)
function startProxy(gp) {
  const stats = { byMethod: {}, sendRaw: 0, hashes: [] };
  let rule = () => undefined;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', async () => {
      const payload = JSON.parse(raw); const calls = Array.isArray(payload) ? payload : [payload];
      const out = [];
      for (const c of calls) {
        stats.byMethod[c.method] = (stats.byMethod[c.method] || 0) + 1;
        if (process.env.DEBUG) console.log('   rpc ' + c.method + ' ' + JSON.stringify(c.params || []).slice(0, 90));
        if (c.method === 'eth_sendRawTransaction') { stats.sendRaw++; stats.hashes.push(ethers.keccak256(c.params[0])); }
        const a = rule(c) || {};
        if (a.http) { res.writeHead(a.http, a.retryAfter ? { 'retry-after': String(a.retryAfter) } : {}); return res.end('{"error":"too many requests"}'); }
        if (a.hang) return;                                            // never answer: the client's own timeout decides
        if (a.error) { out.push({ jsonrpc: '2.0', id: c.id, error: a.error }); continue; }
        if ('result' in a) { out.push({ jsonrpc: '2.0', id: c.id, result: a.result }); continue; }
        if (a.swallow) { out.push({ jsonrpc: '2.0', id: c.id, result: a.swallow }); continue; }
        let r;
        try { r = { jsonrpc: '2.0', id: c.id, result: await gp.request({ method: c.method, params: c.params || [] }) }; }
        catch (e) { r = { jsonrpc: '2.0', id: c.id, error: { code: e.code || -32000, message: e.message, ...(e.data ? { data: e.data.result || e.data } : {}) } }; }
        if (a.forwardThenDrop) { if (process.env.DEBUG) console.log('   forwarded, then dropped: ' + JSON.stringify(r).slice(0, 160)); req.socket.destroy(); return; }       // the node got it; the answer is lost on the way back
        if (process.env.DEBUG && /Count|sendRaw/.test(c.method)) console.log('   <- ' + JSON.stringify(r.result || r.error).slice(0, 120));
        out.push(r);
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(Array.isArray(payload) ? out : out[0]));
    });
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ server, url: 'http://127.0.0.1:' + server.address().port, stats, set: (f) => { rule = f || (() => undefined); } })));
}

(async () => {
  const out = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources: { 'M.sol': { content: POOL_SRC } },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'paris', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } })));
  if ((out.errors || []).some((e) => e.severity === 'error')) throw new Error(out.errors.map((e) => e.formattedMessage).join('\n'));
  const M = out.contracts['M.sol'].MockPoolV7;

  const gp = ganache.provider({ logging: { quiet: true }, chain: { hardfork: 'shanghai' }, wallet: { deterministic: true, totalAccounts: 4, defaultBalance: 100000 }, miner: { blockGasLimit: 60000000, blockTime: Number(process.env.BLOCK_TIME || 0.3) } });   // interval mining, like a sequencer (Nitro ~0.25 s)
  const keys = Object.values(gp.getInitialAccounts()).map((a) => a.secretKey);
  const direct = new ethers.BrowserProvider(gp);
  const deployer = new ethers.Wallet(keys[0], direct);
  const pool = await (await new ethers.ContractFactory(M.abi, '0x' + M.evm.bytecode.object, deployer).deploy()).waitForDeployment();
  await (await deployer.sendTransaction({ to: pool.target, value: ethers.parseEther('5000') })).wait();
  const proxy = await startProxy(gp);

  const relayerAddr = new ethers.Wallet(keys[1]).address;
  const mkProvider = () => { const p = new ethers.JsonRpcProvider(proxy.url, undefined, { staticNetwork: true }); p.pollingInterval = 200; return p; };
  let provider = mkProvider();
  const mk = (opts = {}) => createRelayer({ ethers, wallet: new ethers.Wallet(opts.key || keys[1], provider), pools: [], routers: [], v6Pools: [pool.target], v6Routers: [],
    perIpHour: 1000, dailyCap: 10000, failPerIpHour: 1000, maxQueue: 30, log: process.env.DEBUG ? (m) => console.log('   log: ' + m) : undefined, ...opts });
  let nh = 1000n;
  const body = (o = {}) => ({ pool: pool.target, pA: [1, 2], pB: [[1, 2], [3, 4]], pC: [1, 2], root: 7, nullifierHash: (nh++).toString(), recipient: ethers.Wallet.createRandom().address, ...o });
  const W = (R, b, ip = 'ip-a') => R.handle('POST', '/relay/api/withdraw', b, ip);
  const nonceOf = () => direct.getTransactionCount(relayerAddr, 'latest');
  const balOf = () => direct.getBalance(relayerAddr);
  const spent = (n) => pool.nullifierHashes(BigInt(n));

  // ---- 0. baseline through the proxy
  let R = mk();
  let r = await W(R, body());
  rec('baseline: a withdrawal through the HTTP proxy is relayed', r.status === 200 && !!r.body.tx, JSON.stringify(r.body).slice(0, 80));

  // ---- 1. HTTP 429 from the RPC: ethers' FetchRequest retries (up to 12 attempts, backoff), then gives up
  let n429 = 0;
  proxy.set((c) => (c.method === 'eth_getBalance' && n429++ < 3 ? { http: 429 } : undefined));
  let t0 = Date.now(); r = await W(R, body());
  rec('429 x3 on eth_getBalance: retried by ethers, request relayed', r.status === 200, `${Date.now() - t0} ms, 429 sent ${Math.min(n429, 3)}`);
  proxy.set((c) => (c.method === 'eth_getBalance' ? { http: 429, retryAfter: 1 } : undefined));
  t0 = Date.now(); r = await W(R, body(), 'ip-429');
  const t429 = Date.now() - t0;
  rec('429 on every call: request fails with 502 after ethers gives up, nothing sent', r.status === 502, `${t429} ms`);
  proxy.set(); await sleep(500);   // ethers keeps a failed call in its 250 ms request cache
  r = await W(R, body());
  rec('after 429 storm: the queue is not stuck, next request relayed', r.status === 200);

  // ---- 2. RPC errors are counted against the CLIENT's failure limit (failPerIpHour)
  R = mk({ failPerIpHour: 3 });
  proxy.set((c) => (c.method === 'eth_getBalance' ? { error: { code: -32603, message: 'internal error' } } : undefined));
  for (let i = 0; i < 3; i++) await W(R, body(), 'ip-victim');
  proxy.set(); await sleep(400);
  r = await W(R, body(), 'ip-victim');
  // KNOWN-DEFECT (low): three failures of OUR node lock an honest client out for an hour.
  rec('KNOWN-DEFECT: node-side RPC errors count as the client\'s failures and lock the IP out', r.status === 429, r.body.error && r.body.error.slice(0, 50));

  // ---- 3. Lost answer after broadcast: the node accepted and mined the transaction, the response never came back
  R = mk();
  let b = body(); const n0 = await nonceOf(), bal0 = await balOf();
  proxy.set((c) => (c.method === 'eth_sendRawTransaction' ? { forwardThenDrop: true } : undefined));
  r = await W(R, b, 'ip-lost');
  proxy.set(); await sleep(400);
  const n1 = await nonceOf(), isSpent = await spent(b.nullifierHash);
  // The user is told the relayer could NOT send it, but the withdrawal happened.
  rec('lost answer after broadcast: tx mined (nonce +1, note spent)', n1 === n0 + 1 && isSpent, `nonce ${n0}->${n1}`);
  rec('KNOWN-DEFECT: ...but the user gets 502 "could not send" and no tx hash', r.status === 502 && !r.body.tx, `status ${r.status}`);
  // The user retries the same proof: the simulation sees the spent note, nothing is sent again.
  r = await W(R, b, 'ip-lost');
  rec('retry of the same proof after a lost answer: refused before sending (no 2nd tx)', r.status === 400 && (await nonceOf()) === n1, r.body.error.slice(0, 70));
  r = await W(R, body());
  rec('after a lost answer: the queue moves on', r.status === 200);

  // ---- 4. Lost answer while the tx is still pending (blocks not mined yet), user retries at once
  R = mk();
  b = body();
  await gp.request({ method: 'miner_stop', params: [] });
  const n2 = await nonceOf(), bal2 = await balOf(), h0 = proxy.stats.hashes.length;
  proxy.set((c) => (c.method === 'eth_sendRawTransaction' ? { forwardThenDrop: true } : undefined));
  r = await W(R, b, 'ip-pend');
  // ganache leaves pool transactions out of the 'pending' count; geth and Nitro count them. Answer as they would.
  proxy.set((c) => (c.method === 'eth_getTransactionCount' && c.params[1] === 'pending' ? { result: ethers.toQuantity(n2 + 1) } : undefined));
  await sleep(400);
  const r2p = W(R, b, 'ip-pend');                     // retry; simulation runs on 'latest' where the note is still unspent
  await sleep(1500);
  await gp.request({ method: 'miner_start', params: [] });
  const r2 = await withTimeout(r2p, 20000);
  proxy.set();
  await sleep(500);
  const n3 = await nonceOf(), bal3 = await balOf();
  const txCount = n3 - n2;
  if (process.env.DEBUG) { const bn = await direct.getBlockNumber(); for (let i = bn - 4; i <= bn; i++) { const blk = await direct.getBlock(i, true); for (const t of blk.prefetchedTransactions) { const x = await direct.getTransactionReceipt(t.hash); console.log('   blk', i, t.from.slice(0, 8), 'nonce', t.nonce, t.hash.slice(0, 10), 'status', x.status, 'nh', t.data.slice(10 + 64 * 9, 10 + 64 * 10).replace(/^0+/, ''), 'logs', x.logs.length); } } console.log('   hashes', proxy.stats.hashes.slice(h0).map((h) => h.slice(0, 10)).join()); }
  const rcs = await Promise.all(proxy.stats.hashes.slice(h0).map((h) => direct.getTransactionReceipt(h)));
  const mined = rcs.filter(Boolean), reverted = mined.filter((x) => x.status === 0);
  // KNOWN-DEFECT (low): both transactions are mined; the one that comes second reverts ("Note already spent") and the
  // relayer pays its gas. The answer the user gets depends on which of the two the retry was: here it is recorded below.
  rec('KNOWN-DEFECT: pending tx + lost answer + immediate retry = 2 txs on-chain, one reverts (relayer pays gas twice)', txCount === 2 && mined.length === 2 && reverted.length === 1,
    `txs ${txCount}, mined ${mined.length}, reverted ${reverted.length} (gas ${reverted.map((x) => x.gasUsed).join()}), 1st answer ${r.status}, retry answer ${r2.v && r2.v.status}, relayer spent ${ethers.formatEther(bal2 - bal3)} ETH`);

  // ---- 5. Transaction never mined (dropped by the node / sequencer restart): tx.wait() has no timeout
  R = mk();
  proxy.set((c) => (c.method === 'eth_sendRawTransaction' ? { swallow: ethers.keccak256(c.params[0]) } : undefined));
  // swallow: answer a hash, never forward — as if the node accepted it and then lost it
  const stuck = W(R, body(), 'ip-drop');
  await sleep(300); proxy.set();
  const next = W(R, body(), 'ip-next');
  const s1 = await withTimeout(stuck, 8000), s2 = await withTimeout(next, 2000);
  const st = await R.status('x');
  // KNOWN-DEFECT (medium): one dropped transaction blocks the serial queue forever; every later request waits, then 503.
  rec('KNOWN-DEFECT: a never-mined tx blocks the queue (no wait timeout), later requests hang', !s1.done && !s2.done, `after 8 s: first done=${s1.done}, next done=${s2.done}`);
  const busy = []; for (let i = 0; i < 30; i++) busy.push(W(R, body(), 'ip-q' + i));
  r = await W(R, body(), 'ip-late');
  rec('KNOWN-DEFECT: ...the queue fills up and every new request gets 503 until restart', r.status === 503, r.body.error.slice(0, 40));
  // the relayer object is now unusable; continue with a fresh one and a fresh provider (as a container restart would)
  provider.destroy(); provider = mkProvider();

  // ---- 6. RPC that never answers (hang): ethers default timeout is 300 s per request, no relayer-side timeout
  R = mk();
  proxy.set((c) => (c.method === 'eth_getCode' ? { hang: true } : undefined));
  const h1 = W(R, body(), 'ip-h1'); await sleep(200); proxy.set();
  const h2 = W(R, body(), 'ip-h2');
  const hr1 = await withTimeout(h1, 6000), hr2 = await withTimeout(h2, 1000);
  rec('KNOWN-DEFECT: a hanging RPC call blocks the queue (ethers default 300 s timeout, none in the relayer)', !hr1.done && !hr2.done, `after 6 s: hung=${!hr1.done}, next waiting=${!hr2.done}`);
  provider.destroy(); provider = mkProvider();

  // ---- 7. Nonce: node lags (pending count too low) -> "nonce too low" -> relayer retries with a fresh nonce
  R = mk();
  let lag = 1;
  proxy.set((c) => (c.method === 'eth_getTransactionCount' && lag-- > 0 ? { result: '0x0' } : undefined));
  const n4 = await nonceOf();
  r = await W(R, body(), 'ip-nonce');
  proxy.set(); await sleep(400);
  rec('nonce too low (node lagging): retried, relayed, exactly one tx', r.status === 200 && (await nonceOf()) === n4 + 1, `nonce ${n4}->${await nonceOf()}`);

  // ---- 8. Nonce gap (pending count too HIGH, e.g. a tx lost after the count was taken): future nonce, never mined
  R = mk({ key: keys[3] });   // its own key: the queued future tx must not collide with later nonces of keys[1]
  let gap = 1;
  proxy.set((c) => (c.method === 'eth_getTransactionCount' && c.params && c.params[1] === 'pending' && gap-- > 0 ? { result: ethers.toQuantity(n4 + 5) } : undefined));
  const g1 = W(R, body(), 'ip-gap');
  await sleep(300); proxy.set();
  const gr = await withTimeout(g1, 5000);
  rec('KNOWN-DEFECT: nonce gap -> tx sits in the node as a future tx, wait() never returns, queue stuck', !gr.done, `after 5 s done=${gr.done}`);
  provider.destroy(); provider = mkProvider();
  // clear ganache's queued future tx by mining; it cannot be mined (gap) — fine for the rest of the test (later sends fill nonces below it)

  // ---- 9. "replacement transaction underpriced" (not matched by /nonce/): not retried, 502, queue moves on
  R = mk();
  proxy.set((c) => (c.method === 'eth_sendRawTransaction' ? { error: { code: -32000, message: 'replacement transaction underpriced' } } : undefined));
  r = await W(R, body(), 'ip-repl');
  const cnt = proxy.stats.sendRaw;
  proxy.set(); await sleep(400);
  rec('replacement underpriced: 502 to the user, no retry loop', r.status === 502);
  r = await W(R, body(), 'ip-repl2');
  rec('after underpriced: the queue moves on', r.status === 200, r.body.error);
  // "nonce has already been used" four times in a row: bounded retries, then 502
  let nn = 0;
  proxy.set((c) => (c.method === 'eth_sendRawTransaction' ? (nn++, { error: { code: -32000, message: 'nonce too low' } }) : undefined));
  r = await W(R, body(), 'ip-n4');
  proxy.set(); await sleep(400);
  rec('nonce error forever: 4 attempts, then 502 (bounded)', r.status === 502 && nn === 4, `attempts ${nn}`);

  // ---- 10. Queue and limits under bursts
  R = mk({ perIpHour: 10, dailyCap: 10000 });
  let rs = await Promise.all(Array.from({ length: 15 }, () => W(R, body(), 'ip-burst')));
  let ok = rs.filter((x) => x.status === 200).length, lim = rs.filter((x) => x.status === 429).length;
  rec('burst of 15 from one IP, perIpHour 10: exactly 10 relayed, 5 refused 429', ok === 10 && lim === 5, `200=${ok} 429=${lim}`);
  R = mk({ perIpHour: 1000, dailyCap: 7 });
  rs = await Promise.all(Array.from({ length: 12 }, (_, i) => W(R, body(), 'ip-d' + i)));
  ok = rs.filter((x) => x.status === 200).length; lim = rs.filter((x) => x.status === 429).length;
  rec('burst of 12 from 12 IPs, dailyCap 7: exactly 7 relayed', ok === 7 && lim === 5, `200=${ok} 429=${lim}`);
  R = mk({ maxQueue: 5 });
  rs = await Promise.all(Array.from({ length: 9 }, (_, i) => W(R, body(), 'ip-m' + i)));
  ok = rs.filter((x) => x.status === 200).length; const busyN = rs.filter((x) => x.status === 503).length;
  rec('burst of 9, maxQueue 5: 5 relayed, 4 busy 503', ok === 5 && busyN === 4, `200=${ok} 503=${busyN}`);
  // refused requests give the slot back: bad requests do not eat the hourly limit, but count as failures
  R = mk({ perIpHour: 2, failPerIpHour: 3 });
  for (let i = 0; i < 3; i++) await W(R, body({ root: 0 }), 'ip-bad');
  r = await W(R, body(), 'ip-bad');
  rec('3 refused (unknown root) with failPerIpHour 3: the 4th from that IP is 429', r.status === 429);
  r = await W(R, body({ root: 0 }), 'ip-ok'); r = await W(R, body(), 'ip-ok'); const r2b = await W(R, body(), 'ip-ok');
  rec('a refused request returns its slot (perIpHour 2: refused + 2 relayed)', r.status === 200 && r2b.status === 200);
  // parallel requests with the SAME nullifier: one tx, the others refused by simulation (serial queue)
  R = mk();
  b = body(); const n5 = await nonceOf();
  rs = await Promise.all(Array.from({ length: 5 }, (_, i) => W(R, { ...b, recipient: ethers.Wallet.createRandom().address }, 'ip-same' + i)));
  rec('5 parallel requests with one nullifier: 1 relayed, 4 refused, 1 tx', rs.filter((x) => x.status === 200).length === 1 && (await nonceOf()) === n5 + 1, `200=${rs.filter((x) => x.status === 200).length}`);

  console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
  provider.destroy(); proxy.server.close();
  process.exit(results.every(Boolean) ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
