'use strict';
/*
 * Faucet of test LTH (the native gas coin) for the Latheon test chain. Testnet only: test LTH has no value.
 *
 *   GET  /faucet               page: enter an address, get LTH
 *   GET  /faucet/api/status    faucet address, balance, amount per claim, limits (public data only)
 *   POST /faucet/api/claim     {"address":"0x…"} → sends FAUCET_AMOUNT LTH, answers with the transaction hash
 *
 * Limits: one claim per address and one per IP per FAUCET_COOLDOWN_HOURS; FAUCET_DAILY_CAP LTH per 24 hours in total;
 * only addresses holding less than FAUCET_AMOUNT; claims are sent one at a time (no nonce races).
 * The client IP is the last X-Forwarded-For entry written by Caddy (the service is not reachable from outside directly).
 * Claims are kept in STATE_DIR/claims.json, so a restart does not reset the limits.
 * The key is read from FAUCET_KEY_FILE (created by `faucet-cmd.sh init`), never printed or sent anywhere.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { ethers } = require('ethers');

const env = (k, d) => (process.env[k] && process.env[k].trim()) || d;
const PORT = Number(env('PORT', '8080'));
const L3_RPC = env('L3_RPC', 'http://nitro:8449');
const KEY_FILE = env('FAUCET_KEY_FILE', path.join(__dirname, 'secret', 'faucet.key'));
const STATE_DIR = env('STATE_DIR', path.join(__dirname, 'secret'));
const EXPLORER_URL = env('EXPLORER_URL', '');
const PUBLIC_RPC = env('PUBLIC_RPC', '');
const AMOUNT = ethers.parseEther(env('FAUCET_AMOUNT', '100'));
const COOLDOWN_MS = Number(env('FAUCET_COOLDOWN_HOURS', '24')) * 3600_000;
const DAILY_CAP = ethers.parseEther(env('FAUCET_DAILY_CAP', '5000'));
const DAY_MS = 24 * 3600_000;
const STATE_FILE = path.join(STATE_DIR, 'claims.json');

const log = (...a) => console.log(new Date().toISOString(), ...a);
const provider = new ethers.JsonRpcProvider(L3_RPC, undefined, { cacheTimeout: -1, staticNetwork: false });

// ---- key: loaded lazily, so the service can start before `faucet-cmd.sh init` and pick the key up afterwards
let wallet = null;
function loadWallet() {
  if (wallet) return wallet;
  if (!fs.existsSync(KEY_FILE)) return null;
  const k = fs.readFileSync(KEY_FILE, 'utf8').trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(k)) { log('faucet key file is malformed'); return null; }
  wallet = new ethers.Wallet(k, provider);
  log('faucet address ' + wallet.address);
  return wallet;
}

// ---- claim records: { addr: {lowercase address: ms}, ip: {ip: ms}, sent: [[ms, wei string]] }
let state = { addr: {}, ip: {}, sent: [] };
try { state = { ...state, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) }; } catch (e) { /* first start */ }
function prune(now) {
  for (const m of [state.addr, state.ip]) for (const k of Object.keys(m)) if (now - m[k] >= COOLDOWN_MS) delete m[k];
  state.sent = state.sent.filter(([t]) => now - t < DAY_MS);
}
function save() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, STATE_FILE);
}
const sentToday = () => state.sent.reduce((s, [, w]) => s + BigInt(w), 0n);

// ---- one claim at a time
let queue = Promise.resolve();
const serial = (fn) => { const p = queue.then(fn, fn); queue = p.catch(() => {}); return p; };

class Refusal extends Error { constructor(status, msg, extra) { super(msg); this.status = status; this.extra = extra; } }

async function claim(rawAddress, ip) {
  if (typeof rawAddress !== 'string' || !ethers.isAddress(rawAddress.trim())) throw new Refusal(400, 'Not a valid address.');
  const to = ethers.getAddress(rawAddress.trim());
  const w = loadWallet();
  if (!w) throw new Refusal(503, 'The faucet is not configured yet.');
  if (to === ethers.ZeroAddress || to === w.address) throw new Refusal(400, 'This address cannot receive from the faucet.');
  return serial(async () => {
    const now = Date.now();
    prune(now);
    const a = to.toLowerCase();
    if (state.addr[a]) throw new Refusal(429, 'This address already received LTH recently.', { retryAfterSeconds: Math.ceil((state.addr[a] + COOLDOWN_MS - now) / 1000) });
    if (state.ip[ip]) throw new Refusal(429, 'A claim was already made from your connection recently.', { retryAfterSeconds: Math.ceil((state.ip[ip] + COOLDOWN_MS - now) / 1000) });
    if (sentToday() + AMOUNT > DAILY_CAP) throw new Refusal(503, 'The faucet reached its daily limit. Try again later.');
    if ((await provider.getBalance(to)) >= AMOUNT) throw new Refusal(400, 'This address already holds enough LTH.');
    const bal = await provider.getBalance(w.address);
    if (bal < AMOUNT + ethers.parseEther('0.01')) throw new Refusal(503, 'The faucet is empty. Try again later.');
    // reserve the limits before sending, release them if the transaction is not sent
    state.addr[a] = now; state.ip[ip] = now; state.sent.push([now, AMOUNT.toString()]); save();
    let tx;
    try {
      tx = await w.sendTransaction({ to, value: AMOUNT });
    } catch (e) {
      delete state.addr[a]; delete state.ip[ip]; state.sent = state.sent.filter((x) => x[0] !== now); save();
      wallet = null;   // re-read the nonce from the node next time
      log('send failed: ' + String((e && (e.shortMessage || e.message)) || e).slice(0, 160));
      throw new Refusal(502, 'The transaction could not be sent. Try again later.');
    }
    log(`sent ${ethers.formatEther(AMOUNT)} LTH to ${to} tx ${tx.hash}`);
    let status = 'pending';
    try { const rc = await tx.wait(1, 30_000); status = rc && rc.status === 1 ? 'confirmed' : 'failed'; } catch (e) { /* still pending */ }
    return { to, amount: ethers.formatEther(AMOUNT), txHash: tx.hash, status, explorer: EXPLORER_URL ? EXPLORER_URL + '/tx/' + tx.hash : null };
  });
}

async function status() {
  const w = loadWallet();
  const out = { configured: !!w, amount: ethers.formatEther(AMOUNT), cooldownHours: COOLDOWN_MS / 3600_000, dailyCap: ethers.formatEther(DAILY_CAP), explorer: EXPLORER_URL || null, rpc: PUBLIC_RPC || null };
  if (!w) return out;
  prune(Date.now());
  const [net, bal] = await Promise.all([provider.getNetwork(), provider.getBalance(w.address)]);
  return { ...out, chainId: Number(net.chainId), address: w.address, balance: ethers.formatEther(bal), sentLast24h: ethers.formatEther(sentToday()) };
}

const PAGE = fs.readFileSync(path.join(__dirname, 'page.html'), 'utf8');

function clientIp(req) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  return xff.length ? xff[xff.length - 1] : (req.socket.remoteAddress || 'unknown');
}
function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'content-type': type + '; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

const server = http.createServer((req, res) => {
  const url = (req.url || '').split('?')[0].replace(/\/+$/, '') || '/';
  if (req.method === 'GET' && (url === '/faucet' || url === '/')) return send(res, 200, PAGE, 'text/html');
  if (req.method === 'GET' && url === '/faucet/api/status') {
    return status().then((s) => send(res, 200, s)).catch(() => send(res, 502, { error: 'The chain is not reachable.' }));
  }
  if (req.method === 'POST' && url === '/faucet/api/claim') {
    let body = '', tooBig = false;
    req.on('data', (c) => {
      if (tooBig) return;
      body += c;
      if (body.length > 1024) { tooBig = true; res.on('finish', () => req.destroy()); send(res, 413, { error: 'Request too large.' }); }
    });
    req.on('end', async () => {
      if (tooBig) return;
      let address;
      try { address = JSON.parse(body || '{}').address; } catch (e) { return send(res, 400, { error: 'Send JSON: {"address":"0x…"}.' }); }
      try { send(res, 200, await claim(address, clientIp(req))); }
      catch (e) {
        if (e instanceof Refusal) return send(res, e.status, { error: e.message, ...(e.extra || {}) });
        log('error: ' + String((e && (e.shortMessage || e.message)) || e).slice(0, 160));
        send(res, 502, { error: 'The chain is not reachable. Try again later.' });
      }
    });
    return;
  }
  send(res, 404, { error: 'Not found.' });
});
server.headersTimeout = 10_000;
server.requestTimeout = 60_000;
server.listen(PORT, () => { log(`faucet listening on ${PORT}, RPC ${L3_RPC}, ${ethers.formatEther(AMOUNT)} LTH per claim`); loadWallet(); });
process.on('SIGTERM', () => server.close(() => process.exit(0)));
