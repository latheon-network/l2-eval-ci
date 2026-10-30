#!/usr/bin/env node
'use strict';
/*
 * Read-only check of the pre-V7 Latheon pools (testnets only): for every network in deployments.json, and for each
 * pool marked frozen / forgeable (or older than V7), print its balance (native coin or ERC-20), nextIndex() (deposits
 * made) and the number of Withdrawal events, plus the routers' balances. No keys, no transactions: eth_getBalance,
 * eth_call and eth_getLogs only, against the public RPCs listed in deployments.json.
 *
 * Why: every pool before V7 carries the circuit flaw in THREAT-MODEL 8.0 and its contract still accepts deposits.
 * This shows what is still inside them and whether anything unusual happened (more withdrawals than deposits, or a
 * balance below what deposits minus withdrawals leave).
 *
 * Usage (Node 22, no packages):
 *   node legacy-pools-check.js [--all] [--json out.json] [--network latheon-testnet,...]
 * Env:
 *   DEPLOYMENTS_FILE   path to a deployments.json (default: download DEPLOYMENTS_URL)
 *   DEPLOYMENTS_URL    default https://raw.githubusercontent.com/latheon-network/Latheon/main/demo/deployments.json
 *   RPC_<NETWORK>      override a network's RPC, e.g. RPC_LATHEON_TESTNET=http://127.0.0.1:8449 (also used for logs)
 *   LOGS_MAX_REQUESTS  cap on eth_getLogs requests per pool (default 1500; above it the count is shown as "?")
 * --all also lists the current (V7) pools, for comparison.
 * Exit code: 0 ok, 1 an anomaly flag was raised, 2 the check itself could not run.
 */

const fs = require('fs');

const TOPIC_WITHDRAWAL_V3 = '0xdf273cb619d95419a9cd0ec88123a0538c85064229baa6363788f743fff90deb'; // Withdrawal(address,uint256,uint256): V3/V4/V5
const TOPIC_WITHDRAWAL_V6 = '0xd1dec43cb733ef30734a816d655b84537e755d9fab510f7dd9eb6a6bd0b6eb73'; // Withdrawal(address,uint256,address,uint256,uint256): V6/V7
const SEL_NEXT_INDEX = '0xfc7e9c6f'; // nextIndex()
const SEL_BALANCE_OF = '0x70a08231'; // balanceOf(address)
const ZERO = '0x0000000000000000000000000000000000000000';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const ALL = args.includes('--all');
const JSON_OUT = opt('--json');
const ONLY = opt('--network') ? opt('--network').split(',') : null;
const LOGS_MAX = Number(process.env.LOGS_MAX_REQUESTS || 1500);

async function loadDeployments() {
  if (process.env.DEPLOYMENTS_FILE) return JSON.parse(fs.readFileSync(process.env.DEPLOYMENTS_FILE, 'utf8'));
  const url = process.env.DEPLOYMENTS_URL || 'https://raw.githubusercontent.com/latheon-network/Latheon/main/demo/deployments.json';
  const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error('cannot download ' + url + ': HTTP ' + r.status);
  return r.json();
}

let rpcId = 0;
async function rpc(url, method, params, tries = 4) {
  for (let t = 0; ; t++) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }), signal: AbortSignal.timeout(30000) });
      if (r.status === 429 || r.status >= 500) throw Object.assign(new Error('HTTP ' + r.status), { transient: true });
      const j = await r.json();
      if (j.error) throw Object.assign(new Error(j.error.message || JSON.stringify(j.error)), { rpcError: true });
      return j.result;
    } catch (e) {
      const transient = e.transient || e.name === 'TimeoutError' || e.name === 'AbortError' || /fetch failed|ECONN|socket/i.test(e.message);
      if (!transient || t + 1 >= tries) throw e;
      await new Promise((res) => setTimeout(res, 1000 * (t + 1)));
    }
  }
}

const hex = (n) => '0x' + BigInt(n).toString(16);
const pad32 = (addr) => addr.toLowerCase().replace(/^0x/, '').padStart(64, '0');

/** Count Withdrawal logs of one pool in [from, to], splitting any range the endpoint refuses. */
async function countWithdrawals(url, address, from, to) {
  let requests = 0, total = 0;
  const stack = [[from, to]];
  while (stack.length) {
    const [a, b] = stack.pop();
    if (++requests > LOGS_MAX) return null;
    try {
      const logs = await rpc(url, 'eth_getLogs', [{ address, fromBlock: hex(a), toBlock: hex(b), topics: [[TOPIC_WITHDRAWAL_V3, TOPIC_WITHDRAWAL_V6]] }]);
      total += logs.length;
    } catch (e) {
      if (!e.rpcError || a === b) throw e;
      const mid = a + Math.floor((b - a) / 2);
      stack.push([mid + 1, b], [a, mid]);
    }
  }
  return total;
}

const isCurrent = (x) => /^v7/.test(String(x.version || ''));
const fmtUnits = (v, dec) => {
  if (v === null || v === undefined) return '?';
  const s = BigInt(v).toString().padStart(dec + 1, '0');
  const int = s.slice(0, s.length - dec), frac = s.slice(s.length - dec).replace(/0+$/, '').slice(0, 4);
  return int + (frac ? '.' + frac : '');
};

async function checkNetwork(dep, netId) {
  const net = dep.networks[netId];
  const envKey = 'RPC_' + netId.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  const url = process.env[envKey] || net.rpcUrl;
  const logsUrl = process.env[envKey] || net.logsRpcUrl || net.rpcUrl;
  const rows = [];
  let latest;
  try { latest = Number(BigInt(await rpc(url, 'eth_blockNumber', []))); }
  catch (e) { return [{ network: netId, id: '(network)', error: 'RPC ' + url + ': ' + e.message }]; }

  const pools = (dep.pools || []).filter((p) => p.network === netId && (ALL || !isCurrent(p) || p.frozen || p.forgeable));
  for (const p of pools) {
    const tok = (net.tokens || {})[p.token] || {};
    const native = !!tok.native || tok.address === ZERO;
    const dec = Number(tok.decimals ?? 18);
    const row = { network: netId, kind: 'pool', id: p.id, version: p.version || '?', token: p.token, amount: p.amount,
      address: p.address, frozen: !!p.frozen, forgeable: !!p.forgeable, decimals: dec };
    try {
      row.balance = native
        ? BigInt(await rpc(url, 'eth_getBalance', [p.address, 'latest'])).toString()
        : BigInt(await rpc(url, 'eth_call', [{ to: tok.address, data: SEL_BALANCE_OF + pad32(p.address) }, 'latest'])).toString();
      row.nextIndex = Number(BigInt(await rpc(url, 'eth_call', [{ to: p.address, data: SEL_NEXT_INDEX }, 'latest'])));
      const from = Number(p.deployBlock ?? p.startBlock ?? 0);
      row.withdrawals = await countWithdrawals(logsUrl, p.address, from, latest);
      const denom = BigInt(Math.round(Number(p.amount) * 1e6)) * 10n ** BigInt(dec) / 1000000n;
      row.flags = [];
      if (row.withdrawals !== null) {
        if (row.withdrawals > row.nextIndex) row.flags.push('WITHDRAWALS>DEPOSITS');
        const expected = BigInt(row.nextIndex - row.withdrawals) * denom;
        row.expected = expected.toString();
        if (BigInt(row.balance) < expected) row.flags.push('BALANCE<EXPECTED');
        else if (BigInt(row.balance) > expected) row.flags.push('balance>expected');   // coin or tokens sent in directly: not an attack sign
      } else row.flags.push('logs-incomplete');
    } catch (e) { row.error = e.message; }
    rows.push(row);
  }
  const routers = (dep.routers || []).filter((r) => r.network === netId && (ALL || !isCurrent(r) || r.frozen));
  for (const r of routers) {
    const tok = (net.tokens || {})[r.token] || {};
    const native = !!r.native || !!tok.native || tok.address === ZERO;
    const row = { network: netId, kind: 'router', id: r.id, version: r.version || 'v5', token: r.token, address: r.address,
      frozen: !!r.frozen, forgeable: !!r.forgeable, decimals: Number(tok.decimals ?? 18), flags: [] };
    try {
      row.balance = native
        ? BigInt(await rpc(url, 'eth_getBalance', [r.address, 'latest'])).toString()
        : BigInt(await rpc(url, 'eth_call', [{ to: tok.address, data: SEL_BALANCE_OF + pad32(r.address) }, 'latest'])).toString();
      if (BigInt(row.balance) !== 0n) row.flags.push('router-holds-funds');
    } catch (e) { row.error = e.message; }
    rows.push(row);
  }
  rows.forEach((x) => { x.block = latest; });
  return rows;
}

(async () => {
  let dep;
  try { dep = await loadDeployments(); } catch (e) { console.error('deployments.json: ' + e.message); process.exit(2); }
  const nets = Object.keys(dep.networks || {}).filter((n) => !ONLY || ONLY.includes(n));
  const results = (await Promise.all(nets.map((n) => checkNetwork(dep, n)))).flat();

  const head = ['network', 'id', 'ver', 'frozen', 'forge', 'balance', 'deposits', 'withdr.', 'flags'];
  const lines = results.map((r) => r.error && !r.address
    ? [r.network, r.id, '', '', '', '', '', '', 'ERROR ' + r.error]
    : [r.network, r.id, r.version, r.frozen ? 'yes' : 'NO', r.forgeable ? 'yes' : (r.kind === 'router' ? '-' : 'NO'),
      r.error ? '?' : fmtUnits(r.balance, r.decimals) + ' ' + r.token,
      r.kind === 'pool' ? String(r.nextIndex ?? '?') : '-', r.kind === 'pool' ? String(r.withdrawals ?? '?') : '-',
      r.error ? 'ERROR ' + r.error : (r.flags || []).join(' ')]);
  const w = head.map((h, i) => Math.max(h.length, ...lines.map((l) => String(l[i]).length)));
  const out = (l) => console.log(l.map((c, i) => String(c).padEnd(w[i])).join('  ').trimEnd());
  console.log('Latheon pre-V7 pools, read-only, ' + new Date().toISOString() + (ALL ? ' (with V7 for comparison)' : ''));
  out(head); out(w.map((n) => '-'.repeat(n)));
  lines.forEach(out);

  const sums = {};
  for (const r of results) if (r.kind === 'pool' && !isCurrent(r) && r.balance) {
    const k = r.network + ' ' + r.token; sums[k] = (sums[k] || { v: 0n, d: r.decimals }); sums[k].v += BigInt(r.balance);
  }
  console.log('\nStill inside pre-V7 pools:');
  for (const [k, s] of Object.entries(sums)) console.log('  ' + k.padEnd(28) + fmtUnits(s.v, s.d));
  console.log('Latest blocks: ' + nets.map((n) => n + ' ' + ((results.find((r) => r.network === n) || {}).block ?? '?')).join(', '));

  if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify({ generated: new Date().toISOString(), results }, null, 1) + '\n');
  const alarm = results.some((r) => (r.flags || []).some((f) => f === f.toUpperCase() && f !== '') );
  const broken = results.some((r) => r.error);
  if (alarm) console.log('\nANOMALY: see the flags in capitals above (WITHDRAWALS>DEPOSITS, BALANCE<EXPECTED, router-holds-funds is informational).');
  if (broken) console.log('Some reads failed (ERROR rows); rerun later or set RPC_<NETWORK>.');
  process.exit(alarm ? 1 : broken ? 2 : 0);
})();
