'use strict';
/*
 * Faucet tests against a local chain (ganache, in-process) with the real server.js as a child process.
 * The client IP is passed in X-Forwarded-For, the way Caddy passes it on the server.
 *   node test.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const ganache = require('ganache');
const { ethers } = require('ethers');

const CHAIN_PORT = 8551, PORT = 18080, CHAIN_ID = 412346;
const RICH = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';   // public ganache/Hardhat test key #0
const E18 = 10n ** 18n;
let failed = 0, total = 0;
const check = (name, cond, note) => { total++; console.log((cond ? 'PASS ' : 'FAIL ') + name + (note ? '   [' + note + ']' : '')); if (!cond) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const chain = ganache.server({ logging: { quiet: true }, chain: { chainId: CHAIN_ID, networkId: CHAIN_ID, hardfork: 'shanghai' },
    wallet: { accounts: [{ secretKey: RICH, balance: '0x' + (10n ** 9n * E18).toString(16) }] }, miner: { blockGasLimit: 30000000 } });
  await chain.listen(CHAIN_PORT);
  const rpc = 'http://127.0.0.1:' + CHAIN_PORT;
  const provider = new ethers.JsonRpcProvider(rpc, undefined, { cacheTimeout: -1 });
  const rich = new ethers.NonceManager(new ethers.Wallet(RICH, provider));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'faucet-'));
  const secret = path.join(tmp, 'secret');
  const env = { ...process.env, L3_RPC: rpc, FAUCET_KEY_FILE: path.join(secret, 'faucet.key'), STATE_DIR: secret, PORT: String(PORT),
    FAUCET_AMOUNT: '100', FAUCET_COOLDOWN_HOURS: '24', FAUCET_DAILY_CAP: '700', EXPLORER_URL: 'https://explorer.example', PUBLIC_RPC: 'https://rpc.example' };

  let srv, out = '';
  const start = async () => {
    srv = spawn(process.execPath, [path.join(__dirname, 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    srv.stdout.on('data', (d) => { out += d; }); srv.stderr.on('data', (d) => { out += d; });
    for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${PORT}/faucet/api/status`); return; } catch (e) { await sleep(100); } }
    throw new Error('server did not start');
  };
  const stop = () => new Promise((r) => { srv.on('exit', r); srv.kill('SIGTERM'); });
  const api = async (p, opts = {}) => { const r = await fetch(`http://127.0.0.1:${PORT}${p}`, opts); let j = null; try { j = await r.json(); } catch (e) { /* html */ } return { code: r.status, j }; };
  const claim = (address, ip, raw) => api('/faucet/api/claim', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: raw !== undefined ? raw : JSON.stringify({ address }) });
  const bal = (a) => provider.getBalance(a);
  const fresh = () => ethers.Wallet.createRandom().address;

  // ---- before the key exists
  await start();
  let s = await api('/faucet/api/status');
  check('without a key: status says not configured, the service runs', s.code === 200 && s.j.configured === false && s.j.amount === '100.0');
  let c = await claim(fresh(), '10.0.0.1');
  check('without a key: a claim is refused with 503', c.code === 503 && /not configured/.test(c.j.error), c.j && c.j.error);

  // ---- init and fund (admin.js, as faucet-cmd.sh runs it), picked up without a restart
  // asynchronous on purpose: the local chain runs in this process and must keep answering
  const adm = (args, extra = {}) => new Promise((resolve, reject) => execFile(process.execPath, [path.join(__dirname, 'admin.js'), ...args], { env: { ...env, ...extra }, encoding: 'utf8' }, (e, so, se) => (e ? reject(new Error(se || e.message)) : resolve(so))));
  const initOut = await adm(['init']);
  const faucetAddr = initOut.match(/0x[0-9a-fA-F]{40}/)[0];
  const keyText = fs.readFileSync(env.FAUCET_KEY_FILE, 'utf8').trim();
  check('init: key file created with mode 600, address shown, key not printed', (fs.statSync(env.FAUCET_KEY_FILE).mode & 0o777) === 0o600 && !initOut.includes(keyText.slice(2)));
  check('init again: the key is kept', (await adm(['init'])).includes(faucetAddr) && fs.readFileSync(env.FAUCET_KEY_FILE, 'utf8').trim() === keyText);
  const fundOut = await adm(['fund', '1000'], { DEPLOYER_KEY: RICH });
  check('fund: 1000 LTH sent from the deployer, deployer key not printed', (await bal(faucetAddr)) === 1000n * E18 && !fundOut.includes(RICH.slice(2)), fundOut.trim().slice(0, 60));
  s = await api('/faucet/api/status');
  check('status after init: configured, address, balance 1000, chain id, RPC and explorer for the page', s.j.configured && s.j.address === faucetAddr && s.j.balance === '1000.0' && s.j.chainId === CHAIN_ID && s.j.rpc === 'https://rpc.example' && s.j.explorer === 'https://explorer.example');
  const page = await fetch(`http://127.0.0.1:${PORT}/faucet`);
  check('the page loads', page.status === 200 && /Latheon Testnet Faucet/.test(await page.text()));

  // ---- claims
  const a1 = fresh();
  c = await claim(a1, '10.0.0.1');
  check('claim: an empty address receives exactly 100 LTH, confirmed, with an explorer link', c.code === 200 && c.j.status === 'confirmed' && (await bal(a1)) === 100n * E18 && c.j.explorer === 'https://explorer.example/tx/' + c.j.txHash, c.j && c.j.txHash);
  c = await claim(a1, '10.0.0.2');
  check('the same address again (other connection): refused 429 with the time left', c.code === 429 && c.j.retryAfterSeconds > 23 * 3600, c.j.error);
  c = await claim(a1.toLowerCase(), '10.0.0.3');
  check('… also when written in lower case', c.code === 429);
  c = await claim(fresh(), '10.0.0.1');
  check('the same connection, another address: refused 429', c.code === 429, c.j.error);
  c = await claim(fresh(), '203.0.113.9, 10.0.0.1');
  check('the IP is the last X-Forwarded-For entry (the one Caddy adds): a forged first entry does not help', c.code === 429);
  for (const [bad, what] of [['0x123', 'short'], ['hello', 'text'], [ethers.ZeroAddress, 'zero address'], [faucetAddr, 'the faucet itself']]) {
    c = await claim(bad, '10.1.0.' + what.length);
    check('invalid recipient refused with 400: ' + what, c.code === 400, c.j.error);
  }
  c = await claim(undefined, '10.1.1.1', '{not json');
  check('malformed JSON refused with 400', c.code === 400);
  c = await claim(undefined, '10.1.1.2', JSON.stringify({ address: fresh(), pad: 'x'.repeat(5000) }));
  check('a request over 1 KB refused with 413', c.code === 413);
  c = await claim(await rich.getAddress(), '10.1.1.3');
  check('an address that already holds enough LTH is refused', c.code === 400 && /already holds/.test(c.j.error));
  check('refusals did not use up the limits of those connections', (await claim(fresh(), '10.1.1.3')).code === 200);

  // ---- concurrency: five different addresses at once, and one address five times at once
  const many = Array.from({ length: 4 }, fresh);
  const rs = await Promise.all(many.map((a, i) => claim(a, '10.2.0.' + i)));
  const bals = await Promise.all(many.map(bal));
  check('4 claims at the same moment: all sent, distinct transactions, each got exactly 100', rs.every((r) => r.code === 200) && new Set(rs.map((r) => r.j.txHash)).size === 4 && bals.every((b) => b === 100n * E18));
  // daily cap 700: so far 1 + 1 + 4 = 6 claims = 600 LTH
  const one = fresh();
  const same = await Promise.all([1, 2, 3].map((i) => claim(one, '10.3.0.' + i)));
  check('one address 3 times at the same moment: exactly one is paid', same.filter((r) => r.code === 200).length === 1 && (await bal(one)) === 100n * E18);
  c = await claim(fresh(), '10.4.0.1');
  check('daily cap reached (700 LTH): refused with 503', c.code === 503 && /daily limit/.test(c.j.error), c.j.error);

  // ---- restart: the limits survive
  await stop();
  await start();
  c = await claim(a1, '10.9.9.9');
  check('after a restart the address limit still applies', c.code === 429);
  s = await api('/faucet/api/status');
  check('after a restart the daily total is remembered (700 sent)', s.j.sentLast24h === '700.0', s.j.sentLast24h);

  // ---- empty faucet
  await stop();
  env.FAUCET_DAILY_CAP = '100000';
  env.STATE_DIR = path.join(tmp, 'state2');
  await start();
  const left = await bal(faucetAddr);
  const fw = new ethers.Wallet(keyText, provider);
  await (await fw.sendTransaction({ to: await rich.getAddress(), value: left - 50n * E18 })).wait();   // leave 50 LTH, less than one claim
  c = await claim(fresh(), '10.5.0.1');
  check('an almost empty faucet (50 LTH < 100 per claim) refuses with 503 and records no claim', c.code === 503 && /empty/.test(c.j.error) && !fs.existsSync(path.join(env.STATE_DIR, 'claims.json')));

  // ---- nothing secret in any output
  await stop();
  const files = [secret, env.STATE_DIR].filter((d) => fs.existsSync(d)).flatMap((d) => fs.readdirSync(d).filter((f) => f !== 'faucet.key').map((f) => fs.readFileSync(path.join(d, f), 'utf8'))).join('');
  check('no private key in the server log, responses or claims file', !out.includes(keyText.slice(2)) && !out.includes(RICH.slice(2)) && !files.includes(keyText.slice(2)));

  await chain.close();
  console.log('\n' + (failed ? `FAILED: ${failed} of ${total}` : `ALL ${total} CHECKS PASSED`));
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
