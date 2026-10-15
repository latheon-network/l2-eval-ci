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
  check('deploy again: every contract reused, nothing redeployed', d2.status === 0 && (d2.stdout.match(/already deployed/g) || []).length === 9 && !/gas \d/.test(d2.stdout));
  const entry = JSON.parse(fs.readFileSync(path.join(envs.OUT_DIR, 'latheon-deployments.json'), 'utf8'));
  check('deployment entry: chain id, 4 pools 100/50/10/1, 1 router, token WLTH wraps native LTH',
    entry.network.chainId === CHAIN_ID && entry.pools.map((p) => p.amount).join() === '100,50,10,1' && entry.routers.length === 1 && entry.network.tokens.LTH.wrapsNative === true);
  const s = await run('smoke.js');
  check('smoke: wrap, router deposit 11, withdrawMany 2 notes with real proofs, unwrap, invariants, disclosure', s.status === 0 && /All checks passed/.test(s.stdout));
  check('no private key in any output file', !fs.readdirSync(envs.OUT_DIR).some((f) => fs.readFileSync(path.join(envs.OUT_DIR, f), 'utf8').toLowerCase().includes(KEY.slice(2))));

  await server.close();
  console.log('\n' + (failed ? failed + ' check(s) failed' : 'All local checks passed'));
  process.exit(failed ? 1 : 0);
})();
