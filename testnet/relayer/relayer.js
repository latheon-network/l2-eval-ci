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
 *
 * Every request is simulated first (eth_call from the relayer); a request that would revert — bad proof, spent note,
 * unknown root, a recipient that refuses the coin — is refused without spending gas. Only the pools and routers listed in
 * the deployment file are accepted. Limits: RELAY_PER_IP_HOUR successful relays per IP per hour, RELAY_DAILY_CAP per day in
 * total, one transaction at a time, RELAY_MIN_BALANCE LTH kept for gas. Nothing is stored about users: IPs live in memory
 * for the hourly limit only; the log has transaction hashes.
 *
 * Service: node relayer.js serve     Admin: node relayer.js init | address | fund AMOUNT (deployer key, asked without echo)
 * Env: L3_RPC, RELAYER_KEY_FILE, LATHEON_JSON, PORT, RELAY_PER_IP_HOUR (10), RELAY_DAILY_CAP (500), RELAY_MIN_BALANCE (1).
 */
const fs = require('fs');
const path = require('path');
const http = require('http');

const POOL_ABI = ['function withdraw(uint256[2] _pA, uint256[2][2] _pB, uint256[2] _pC, uint256 root, uint256 nullifierHash, address recipient)'];
const ROUTER_ABI = ['function withdrawMany((uint256 pool, uint256[2] pA, uint256[2][2] pB, uint256[2] pC, uint256 root, uint256 nullifierHash)[] items, address recipient)',
  'function MAX_WITHDRAWALS() view returns (uint256)'];

class Refusal extends Error { constructor(status, msg) { super(msg); this.status = status; } }

/**
 * The relayer logic, independent of HTTP and of where the chain runs (tests inject a local chain).
 * @param {{ethers: any, wallet: any, pools: string[], routers: string[], perIpHour?: number, dailyCap?: number, minBalance?: bigint, log?: Function}} o
 */
function createRelayer(o) {
  const { ethers, wallet } = o;
  const log = o.log || (() => {});
  const pools = new Set(o.pools.map((a) => a.toLowerCase())), routers = new Set(o.routers.map((a) => a.toLowerCase()));
  const perIpHour = o.perIpHour ?? 10, dailyCap = o.dailyCap ?? 500, minBalance = o.minBalance ?? ethers.parseEther('1');
  const byIp = new Map(); let sent = [];   // timestamps of successful relays
  let queue = Promise.resolve();
  const serial = (fn) => { const p = queue.then(fn, fn); queue = p.catch(() => {}); return p; };

  const uint = (v, name) => { try { const x = BigInt(v); if (x < 0n || x >= 2n ** 256n) throw 0; return x; } catch (e) { throw new Refusal(400, `Bad ${name}.`); } };
  const pair = (v, name) => { if (!Array.isArray(v) || v.length !== 2) throw new Refusal(400, `Bad ${name}.`); return v.map((x) => uint(x, name)); };
  const proof = (x) => {
    if (!Array.isArray(x.pB) || x.pB.length !== 2) throw new Refusal(400, 'Bad pB.');
    return { pA: pair(x.pA, 'pA'), pB: x.pB.map((r) => pair(r, 'pB')), pC: pair(x.pC, 'pC'), root: uint(x.root, 'root'), nullifierHash: uint(x.nullifierHash, 'nullifierHash') };
  };
  const address = (a, name) => { try { return ethers.getAddress(String(a)); } catch (e) { throw new Refusal(400, `Bad ${name}.`); } };
  const reason = (e) => (e && (e.reason || e.shortMessage || e.message) || 'reverted').split('\n')[0].slice(0, 160);

  function checkLimits(ip, now) {
    const h = (byIp.get(ip) || []).filter((t) => now - t < 3600e3); byIp.set(ip, h);
    sent = sent.filter((t) => now - t < 86400e3);
    if (h.length >= perIpHour) throw new Refusal(429, `Limit: ${perIpHour} relayed withdrawals per hour from one address. Try later, or send the withdrawal from your own wallet.`);
    if (sent.length >= dailyCap) throw new Refusal(429, 'The relayer reached its daily limit. Try tomorrow, or send the withdrawal from your own wallet.');
  }

  async function relay(kind, body, ip) {
    const now = Date.now();
    checkLimits(ip, now);
    const recipient = address(body.recipient, 'recipient');
    if (recipient === ethers.ZeroAddress || recipient === wallet.address) throw new Refusal(400, 'This recipient cannot be used.');
    let contract, args;
    if (kind === 'withdraw') {
      const pool = address(body.pool, 'pool');
      if (!pools.has(pool.toLowerCase())) throw new Refusal(400, 'Not a Latheon pool on this chain.');
      const p = proof(body);
      contract = new ethers.Contract(pool, POOL_ABI, wallet); args = [p.pA, p.pB, p.pC, p.root, p.nullifierHash, recipient];
    } else {
      const router = address(body.router, 'router');
      if (!routers.has(router.toLowerCase())) throw new Refusal(400, 'Not a Latheon router on this chain.');
      if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 16) throw new Refusal(400, 'Between 1 and 16 notes per request.');
      const items = body.items.map((it) => { if (!Array.isArray(it) || it.length !== 6) throw new Refusal(400, 'Bad item.'); const p = proof({ pA: it[1], pB: it[2], pC: it[3], root: it[4], nullifierHash: it[5] }); return [uint(it[0], 'pool index'), p.pA, p.pB, p.pC, p.root, p.nullifierHash]; });
      contract = new ethers.Contract(router, ROUTER_ABI, wallet); args = [items, recipient];
    }
    const fn = kind === 'withdraw' ? 'withdraw' : 'withdrawMany';
    return serial(async () => {
      const bal = await wallet.provider.getBalance(wallet.address);
      if (bal < minBalance) throw new Refusal(503, 'The relayer is out of gas money. Try later, or send the withdrawal from your own wallet.');
      let gas;
      try { await contract[fn].staticCall(...args); gas = await contract[fn].estimateGas(...args); }
      catch (e) { throw new Refusal(400, 'Refused before sending (the chain would reject it): ' + reason(e)); }
      const tx = await contract[fn](...args, { gasLimit: gas + gas / 5n });
      const rc = await tx.wait();
      if (!rc || rc.status !== 1) throw new Refusal(502, 'The transaction failed on-chain: ' + tx.hash);
      const h = byIp.get(ip) || []; h.push(Date.now()); byIp.set(ip, h); sent.push(Date.now());
      log(`relayed ${fn} ${tx.hash} gas ${rc.gasUsed}`);
      return { tx: tx.hash, block: rc.blockNumber, gasUsed: rc.gasUsed.toString() };
    });
  }

  async function status() {
    const bal = await wallet.provider.getBalance(wallet.address);
    sent = sent.filter((t) => Date.now() - t < 86400e3);
    return { address: wallet.address, balance: ethers.formatEther(bal), enabled: bal >= minBalance, perIpHour, dailyCap, relayedLast24h: sent.length, maxNotesPerRequest: 16, fee: '0' };
  }

  /** HTTP-independent entry: returns {status, body}. */
  async function handle(method, url, body, ip) {
    try {
      if (method === 'GET' && url === '/relay/api/status') return { status: 200, body: await status() };
      if (method === 'POST' && url === '/relay/api/withdraw') return { status: 200, body: await relay('withdraw', body || {}, ip) };
      if (method === 'POST' && url === '/relay/api/withdrawMany') return { status: 200, body: await relay('withdrawMany', body || {}, ip) };
      return { status: 404, body: { error: 'Not found.' } };
    } catch (e) {
      if (e instanceof Refusal) return { status: e.status, body: { error: e.message } };
      log('error: ' + reason(e));
      return { status: 502, body: { error: 'The relayer could not send the transaction. Try again, or send it from your own wallet.' } };
    }
  }
  return { handle, status, relay };
}

module.exports = { createRelayer, Refusal };

// ---------------- service and admin ----------------
if (require.main === module) {
  const { ethers } = require('ethers');
  const env = (k, d) => (process.env[k] && process.env[k].trim()) || d;
  const L3_RPC = env('L3_RPC', 'http://127.0.0.1:8449');
  const KEY_FILE = env('RELAYER_KEY_FILE', path.join(__dirname, 'secret', 'relayer.key'));
  const LATHEON_JSON = env('LATHEON_JSON', '/latheon-out/latheon-deployments.json');
  const log = (...a) => console.log(new Date().toISOString(), ...a);
  const die = (m) => { console.error('ERROR: ' + m); process.exit(1); };
  const provider = new ethers.JsonRpcProvider(L3_RPC, undefined, { staticNetwork: true });
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
    const relayer = createRelayer({ ethers, wallet, log, pools: dep.pools.map((p) => p.address), routers: (dep.routers || []).map((r) => r.address),
      perIpHour: Number(env('RELAY_PER_IP_HOUR', '10')), dailyCap: Number(env('RELAY_DAILY_CAP', '500')), minBalance: ethers.parseEther(env('RELAY_MIN_BALANCE', '1')) });
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '600' };
    const ipOf = (req) => { const x = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean); return x.length ? x[x.length - 1] : (req.socket.remoteAddress || 'unknown'); };
    http.createServer((req, res) => {
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
    }).listen(Number(env('PORT', '8090')), () => log('relayer ' + wallet.address + ' listening; pools ' + dep.pools.length + ', routers ' + (dep.routers || []).length));
  })().catch((e) => die(e.message || String(e)));
}
