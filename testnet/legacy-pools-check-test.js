#!/usr/bin/env node
'use strict';
// Offline test of legacy-pools-check.js against a fake JSON-RPC endpoint (no network, no packages): balances, nextIndex,
// Withdrawal counts with range splitting, the anomaly flags and the exit codes.  node legacy-pools-check-test.js
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path');

const E18 = 10n ** 18n;
const POOLS = { // address -> state
  '0x00000000000000000000000000000000000000a1': { bal: 300n * E18, next: 5, withdrawals: [10, 900] },     // ok: (5-2)*100
  '0x00000000000000000000000000000000000000a2': { bal: 0n, next: 1, withdrawals: [20, 30, 40] },         // more out than in
  '0x00000000000000000000000000000000000000a3': { bal: 10n * E18, next: 0, withdrawals: [] },            // V7: listed only with --all
};
const ROUTER = '0x00000000000000000000000000000000000000b1';
let maxRange = 0;
const srv = http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
    const { id, method, params } = JSON.parse(body);
    const ok = (result) => res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
    const err = (message) => res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message } }));
    if (method === 'eth_blockNumber') return ok('0x3e8');
    if (method === 'eth_getBalance') { const a = params[0].toLowerCase(); return ok('0x' + (POOLS[a] ? POOLS[a].bal : a === ROUTER ? 7n : 0n).toString(16)); }
    if (method === 'eth_call') { const p = POOLS[params[0].to.toLowerCase()]; return ok('0x' + BigInt(p ? p.next : 0).toString(16).padStart(64, '0')); }
    if (method === 'eth_getLogs') {
      const f = params[0], a = Number(BigInt(f.fromBlock)), b = Number(BigInt(f.toBlock));
      if (b - a > 250) return err('block range too large');
      maxRange = Math.max(maxRange, b - a);
      const p = POOLS[f.address.toLowerCase()];
      return ok((p ? p.withdrawals : []).filter((x) => x >= a && x <= b).map(() => ({})));
    }
    err('unsupported ' + method);
  });
});
srv.listen(0, '127.0.0.1', () => {
  const port = srv.address().port, dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lpc-'));
  const dep = { networks: { 'fake-net': { rpcUrl: 'http://127.0.0.1:1', tokens: { LTH: { address: '0x0000000000000000000000000000000000000000', decimals: 18, native: true } } } },
    pools: [
      { id: 'fake:LTH-100', network: 'fake-net', version: 'v5-native', token: 'LTH', amount: 100, address: '0x00000000000000000000000000000000000000a1', deployBlock: 1, frozen: true, forgeable: true },
      { id: 'fake:LTH-50', network: 'fake-net', version: 'v6-native', token: 'LTH', amount: 50, address: '0x00000000000000000000000000000000000000a2', deployBlock: 1, frozen: true, forgeable: true },
      { id: 'fake:LTH-10:v7', network: 'fake-net', version: 'v7-native', token: 'LTH', amount: 10, address: '0x00000000000000000000000000000000000000a3', deployBlock: 1 }],
    routers: [{ id: 'fake:LTH', network: 'fake-net', token: 'LTH', native: true, address: ROUTER, frozen: true }] };
  const file = path.join(dir, 'deployments.json'); fs.writeFileSync(file, JSON.stringify(dep));
  const results = [];
  const check = (name, cond) => { results.push(!!cond); console.log((cond ? 'PASS ' : 'FAIL ') + name); };
  const { spawn } = require('child_process');
  const runAsync = (...a) => new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(__dirname, 'legacy-pools-check.js'), ...a, '--json', path.join(dir, 'out.json')],
      { env: { ...process.env, DEPLOYMENTS_FILE: file, RPC_FAKE_NET: 'http://127.0.0.1:' + port } });
    let out = ''; c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; });
    c.on('close', (code) => resolve({ code, out, json: JSON.parse(fs.readFileSync(path.join(dir, 'out.json'), 'utf8')) }));
  });
  (async () => {
    const r1 = await runAsync();
    const byId = Object.fromEntries(r1.json.results.map((x) => [x.id, x]));
    check('V5 pool: balance 300, 5 deposits, 2 withdrawals over a split log range, no flag',
      byId['fake:LTH-100'].balance === (300n * E18).toString() && byId['fake:LTH-100'].nextIndex === 5 && byId['fake:LTH-100'].withdrawals === 2 && byId['fake:LTH-100'].flags.length === 0);
    check('log ranges the endpoint refuses are split (largest accepted range <= 250)', maxRange > 0 && maxRange <= 250);
    check('V6 pool with 3 withdrawals and 1 deposit is flagged WITHDRAWALS>DEPOSITS', byId['fake:LTH-50'].flags.includes('WITHDRAWALS>DEPOSITS'));
    check('V7 pool is not listed without --all', !byId['fake:LTH-10:v7']);
    check('frozen router is listed with its balance and an informational flag', byId['fake:LTH'] && byId['fake:LTH'].balance === '7' && byId['fake:LTH'].flags.includes('router-holds-funds'));
    check('exit code 1 when an anomaly is flagged', r1.code === 1);
    check('table printed', /Still inside pre-V7 pools:/.test(r1.out) && /fake-net LTH\s+300/.test(r1.out));
    const r2 = await runAsync('--all');
    const v7 = r2.json.results.find((x) => x.id === 'fake:LTH-10:v7');
    check('--all lists V7 too; coin sent in directly is only "balance>expected"', v7 && v7.flags.includes('balance>expected'));
    srv.close();
    const pass = results.filter(Boolean).length;
    console.log(`${pass}/${results.length} passed`);
    process.exit(pass === results.length ? 0 : 1);
  })();
});
