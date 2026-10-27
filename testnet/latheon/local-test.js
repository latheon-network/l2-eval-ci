'use strict';
/*
 * Runs deploy.js twice (the second run must reuse every contract) and smoke.js against a local ganache chain.
 * No network needed when LATHEON_REPO points at a Latheon checkout (circuit files are read from it and hash-checked).
 *   LATHEON_REPO=/path/to/Latheon node local-test.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const ganache = require('ganache');

const PORT = 8547, CHAIN_ID = 412346;
// Public ganache/Hardhat test key (account #0 of the "test test … junk" mnemonic); holds nothing anywhere.
const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

(async () => {
  const server = ganache.server({ logging: { quiet: true }, chain: { chainId: CHAIN_ID, networkId: CHAIN_ID, hardfork: 'shanghai' },
    wallet: { accounts: [{ secretKey: KEY, balance: '0x' + (1000000n * 10n ** 18n).toString(16) }] }, miner: { blockGasLimit: 60000000 } });
  await server.listen(PORT);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'latheon-local-'));
  const envs = { ...process.env, L3_RPC: 'http://127.0.0.1:' + PORT, DEPLOYER_KEY: KEY, STATE_DIR: path.join(tmp, 'secret'), OUT_DIR: path.join(tmp, 'out') };
  // Asynchronous on purpose: the ganache server runs in this process and must keep answering while a script runs.
  const run = (script, args = []) => new Promise((resolve) => {
    console.log('\n=== node ' + script + ' ' + args.join(' '));
    const c = spawn(process.execPath, [path.join(__dirname, script), ...args], { env: envs, stdio: ['ignore', 'pipe', 'inherit'] });
    let stdout = '';
    c.stdout.on('data', (d) => { stdout += d; process.stdout.write(d); });
    c.on('close', (status) => resolve({ status, stdout }));
  });
  let failed = 0;
  const check = (name, cond) => { console.log((cond ? 'PASS ' : 'FAIL ') + name); if (!cond) failed++; };

  const d1 = await run('deploy.js');
  check('deploy: all contracts deployed and every check passed', d1.status === 0);
  const d2 = await run('deploy.js');
  check('deploy again: every contract reused, nothing redeployed', d2.status === 0 && (d2.stdout.match(/already deployed/g) || []).length === 8 && !/gas \d/.test(d2.stdout));
  const entry = JSON.parse(fs.readFileSync(path.join(envs.OUT_DIR, 'latheon-deployments.json'), 'utf8'));
  check('deployment entry: chain id, 4 native pools 100/50/10/1, 1 native router, LTH is the native coin',
    entry.network.chainId === CHAIN_ID && entry.pools.map((p) => p.amount).join() === '100,50,10,1' && entry.pools.every((p) => p.version === 'v5-native') &&
    entry.routers.length === 1 && entry.routers[0].native === true && entry.network.tokens.LTH.native === true && entry.network.tokens.LTH.address === '0x0000000000000000000000000000000000000000');
  const s = await run('smoke.js');
  check('smoke: router deposit 11 LTH, withdrawMany 2 notes with real proofs to an empty address, invariants, disclosure', s.status === 0 && /All checks passed/.test(s.stdout));
  // V6 next to V5
  const v1 = await run('deploy-v6.js');
  check('deploy-v6: verifier V4, four 20-level native pools, V6 router; every check passed', v1.status === 0);
  const v2 = await run('deploy-v6.js');
  check('deploy-v6 again: every V6 contract reused', v2.status === 0 && (v2.stdout.match(/already deployed/g) || []).length === 6 && !/gas \d/.test(v2.stdout));
  const e6 = JSON.parse(fs.readFileSync(path.join(envs.OUT_DIR, 'latheon-deployments.json'), 'utf8'));
  check('entry: V6 pools and router listed first, V5 kept, v6Verifier set',
    e6.pools.length === 8 && e6.pools.slice(0, 4).every((p) => p.version === 'v6-native') && e6.pools.slice(4).every((p) => p.version === 'v5-native') &&
    e6.routers.length === 2 && e6.routers[0].version === 'v6' && !!e6.network.v6Verifier);
  const s5 = await run('smoke.js');
  check('smoke (V5) still passes with V6 listed first', s5.status === 0 && /All checks passed/.test(s5.stdout));
  const s6 = await run('smoke-v6.js');
  check('smoke-v6: router deposit 11, withdrawMany with relayer fees bound into the proofs, 23-note deposit, invariants, disclosure', s6.status === 0 && /All checks passed/.test(s6.stdout));

  // V7 next to V5/V6: the withdraw_v5 fix (pathIndices constrained to a bit)
  const v7a = await run('deploy-v7.js');
  check('deploy-v7: verifier V5, four 20-level native pools, V7 router; every check passed', v7a.status === 0);
  const v7b = await run('deploy-v7.js');
  check('deploy-v7 again: every V7 contract reused', v7b.status === 0 && (v7b.stdout.match(/already deployed/g) || []).length === 6 && !/gas \d/.test(v7b.stdout));
  const e7 = JSON.parse(fs.readFileSync(path.join(envs.OUT_DIR, 'latheon-deployments.json'), 'utf8'));
  check('entry: V7 pools and router listed first, V6 and V5 kept, v7Verifier set',
    e7.pools.length === 12 && e7.pools.slice(0, 4).every((p) => p.version === 'v7-native') && e7.routers[0].version === 'v7' && !!e7.network.v7Verifier);
  const s7 = await run('smoke-v7.js');
  check('smoke-v7: router deposit 11, withdrawMany with relayer fees bound into the proofs, 23-note deposit, invariants, disclosure', s7.status === 0 && /All checks passed/.test(s7.stdout));
  const recKey = JSON.parse(fs.readFileSync(path.join(envs.STATE_DIR, 'latheon-smoke-notes.json'), 'utf8')).recipientKey.slice(2).toLowerCase();
  check('no private key (deployer or test recipient) in any output file', !fs.readdirSync(envs.OUT_DIR).some((f) => { const t = fs.readFileSync(path.join(envs.OUT_DIR, f), 'utf8').toLowerCase(); return t.includes(KEY.slice(2)) || t.includes(recKey); }));

  await server.close();
  console.log('\n' + (failed ? failed + ' check(s) failed' : 'All local checks passed'));
  process.exit(failed ? 1 : 0);
})();
