'use strict';
/*
 * The whole load test on a local ganache chain, quickly: deploy V5 + V6, start the real relayer and faucet against it,
 * plan a small run (8 wallets over ~3 minutes, no bridge), fund, run, analyze. No network needed with LATHEON_REPO set.
 *   LATHEON_REPO=/path/to/Latheon node loadtest/local-test.js      (after npm ci in latheon/ and relayer/)
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const T = path.join(__dirname, '..');
const ganache = require(path.join(T, 'latheon', 'node_modules', 'ganache'));
const { ethers } = require(path.join(T, 'latheon', 'node_modules', 'ethers'));

const PORT = 8548, CHAIN_ID = 412346, RPORT = 18090, FPORT = 18080;
const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'; // public ganache/Hardhat test key, holds nothing

(async () => {
  const server = ganache.server({ logging: { quiet: true }, chain: { chainId: CHAIN_ID, networkId: CHAIN_ID, hardfork: 'shanghai' },
    wallet: { accounts: [{ secretKey: KEY, balance: '0x' + (1000000n * 10n ** 18n).toString(16) }] }, miner: { blockGasLimit: 60000000 } });
  await server.listen(PORT);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'latheon-loadtest-'));
  const rpc = 'http://127.0.0.1:' + PORT;
  const envs = { ...process.env, L3_RPC: rpc, DEPLOYER_KEY: KEY, STATE_DIR: path.join(tmp, 'secret'), OUT_DIR: path.join(tmp, 'out') };
  const procs = [];
  const run = (script, args = [], extra = {}) => new Promise((resolve) => {
    console.log('\n=== node ' + path.basename(script) + ' ' + args.join(' '));
    const c = spawn(process.execPath, [script, ...args], { env: { ...envs, ...extra }, stdio: ['ignore', 'pipe', 'inherit'] });
    let out = ''; c.stdout.on('data', (d) => { out += d; process.stdout.write(d); });
    c.on('close', (status) => resolve({ status, out }));
  });
  let failed = 0;
  const check = (name, cond) => { console.log((cond ? 'PASS ' : 'FAIL ') + name); if (!cond) failed++; };
  const done = (code) => { for (const p of procs) p.kill(); server.close().finally(() => process.exit(code)); };
  try {
    check('deploy V5', (await run(path.join(T, 'latheon', 'deploy.js'))).status === 0);
    check('deploy V6', (await run(path.join(T, 'latheon', 'deploy-v6.js'))).status === 0);
    const depFile = path.join(envs.OUT_DIR, 'latheon-deployments.json');
    // relayer and faucet with their own fresh keys, funded from the test key
    const prov = new ethers.JsonRpcProvider(rpc, undefined, { cacheTimeout: -1 });
    const boss = new ethers.NonceManager(new ethers.Wallet(KEY, prov));
    const rk = ethers.Wallet.createRandom(), fk = ethers.Wallet.createRandom();
    fs.mkdirSync(path.join(tmp, 'rel'), { recursive: true }); fs.writeFileSync(path.join(tmp, 'rel', 'relayer.key'), rk.privateKey);
    fs.mkdirSync(path.join(tmp, 'fau'), { recursive: true }); fs.writeFileSync(path.join(tmp, 'fau', 'faucet.key'), fk.privateKey);
    await (await boss.sendTransaction({ to: rk.address, value: ethers.parseEther('100') })).wait();
    await (await boss.sendTransaction({ to: fk.address, value: ethers.parseEther('5000') })).wait();
    const start = (file, extra) => { const p = spawn(process.execPath, [file, ...(extra.args || [])], { env: { ...envs, ...extra.env }, stdio: ['ignore', 'ignore', 'inherit'] }); procs.push(p); };
    start(path.join(T, 'relayer', 'relayer.js'), { args: ['serve'], env: { PORT: String(RPORT), RELAYER_KEY_FILE: path.join(tmp, 'rel', 'relayer.key'), LATHEON_JSON: depFile, RELAY_EXEMPT_IPS: '127.0.0.1,::1,::ffff:127.0.0.1' } });
    start(path.join(T, 'faucet', 'server.js'), { env: { PORT: String(FPORT), FAUCET_KEY_FILE: path.join(tmp, 'fau', 'faucet.key'), STATE_DIR: path.join(tmp, 'fau'), FAUCET_EXEMPT_IPS: '127.0.0.1,::1,::ffff:127.0.0.1', NODE_PATH: path.join(T, 'latheon', 'node_modules') } });
    await new Promise((r) => setTimeout(r, 2500));
    const L = path.join(__dirname, 'loadtest.js');
    const lt = { STATE_DIR: path.join(tmp, 'lt-secret'), OUT_DIR: path.join(tmp, 'lt-out'), LATHEON_JSON: depFile, CHAIN_JSON: path.join(tmp, 'none.json'),
      RELAYER_URL: `http://127.0.0.1:${RPORT}/relay/api`, FAUCET_URL: `http://127.0.0.1:${FPORT}/faucet/api`, LOADTEST_START_MIN: '0.2' };
    check('plan: 8 wallets, no bridge, 0.05 h', (await run(L, ['plan', '--wallets', '8', '--bridge', '0', '--hours', '0.05', '--seed', 'local'], lt)).status === 0);
    const plan = JSON.parse(fs.readFileSync(path.join(lt.STATE_DIR, 'plan.json'), 'utf8'));
    check('plan file and master key are private (mode 600)', (fs.statSync(path.join(lt.STATE_DIR, 'plan.json')).mode & 0o077) === 0 && (fs.statSync(path.join(lt.STATE_DIR, 'master.key')).mode & 0o077) === 0);
    check('fund', (await run(L, ['fund'], lt)).status === 0);
    // squeeze the schedule: a run of a few minutes still has to keep order and survive a restart
    const r1 = await run(L, ['run'], lt);
    check('run finished', r1.status === 0);
    const J = fs.readFileSync(path.join(lt.STATE_DIR, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const bad = J.filter((e) => !e.ok);
    check(`every step succeeded (${J.length} of ${plan.steps.length})`, J.length === plan.steps.length && bad.length === 0);
    if (bad.length) console.log(bad.slice(0, 5));
    check('faucet, relayer (withdraw and withdrawMany) and self-paid withdrawals all happened',
      J.some((e) => e.kind === 'faucet') && J.some((e) => e.via === 'relayer') && J.some((e) => /deposit/.test(e.kind)));
    const r2 = await run(L, ['run'], lt);
    check('run again: nothing repeated', r2.status === 0 && /already done/.test(r2.out) && fs.readFileSync(path.join(lt.STATE_DIR, 'journal.jsonl'), 'utf8').trim().split('\n').length === J.length);
    const a = await run(L, ['analyze'], lt);
    const rep = JSON.parse(fs.readFileSync(path.join(lt.OUT_DIR, 'loadtest-report.json'), 'utf8'));
    check('analyze: report written, every withdrawal counted', a.status === 0 && rep.withdrawalTxs > 0 && Object.keys(rep.heuristics).length === 3);
    const pubText = fs.readFileSync(path.join(lt.OUT_DIR, 'loadtest-report.json'), 'utf8') + fs.readFileSync(path.join(lt.OUT_DIR, 'loadtest-report.md'), 'utf8');
    check('the report holds no wallet key and no wallet address of the plan', !plan.wallets.some((w) => pubText.includes(w.key.slice(2)) || pubText.toLowerCase().includes(w.address.toLowerCase().slice(2))));
    if (plan.wallets.some((w) => w.behaviour === 'self-paying')) check('the same-sender heuristic catches self-paid withdrawals', rep.heuristics['same sender'].right > 0);
  } catch (e) { console.error(e); failed++; }
  console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nALL LOAD-TEST LOCAL CHECKS PASSED');
  done(failed ? 1 : 0);
})();
