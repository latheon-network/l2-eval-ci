'use strict';
/*
 * flood.js on a local ganache chain: deploy V5 (Poseidon) + V7, fund, run two short stages, then the relayer burst
 * (proofs in advance, a real relayer), report, sweep.
 *   LATHEON_REPO=/path/to/Latheon node loadtest/flood-local-test.js      (after npm ci in latheon/)
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const T = path.join(__dirname, '..');
const ganache = require(path.join(T, 'latheon', 'node_modules', 'ganache'));
const { ethers } = require(path.join(T, 'latheon', 'node_modules', 'ethers'));
const RPORT = 18091;

const PORT = 8549, CHAIN_ID = 412346;
const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'; // public ganache/Hardhat test key, holds nothing

(async () => {
  const server = ganache.server({ logging: { quiet: true }, chain: { chainId: CHAIN_ID, networkId: CHAIN_ID, hardfork: 'shanghai' },
    wallet: { accounts: [{ secretKey: KEY, balance: '0x' + (1000000n * 10n ** 18n).toString(16) }] }, miner: { blockGasLimit: 60000000 } });
  await server.listen(PORT);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'latheon-flood-'));
  const rpc = 'http://127.0.0.1:' + PORT;
  const envs = { ...process.env, L3_RPC: rpc, DEPLOYER_KEY: KEY, STATE_DIR: path.join(tmp, 'secret'), OUT_DIR: path.join(tmp, 'out') };
  const run = (script, args = [], extra = {}) => new Promise((resolve) => {
    console.log('\n=== node ' + path.basename(script) + ' ' + args.join(' '));
    const c = spawn(process.execPath, [script, ...args], { env: { ...envs, ...extra }, stdio: ['ignore', 'pipe', 'inherit'] });
    let out = ''; c.stdout.on('data', (d) => { out += d; process.stdout.write(d); });
    c.on('close', (status) => resolve({ status, out }));
  });
  let failed = 0;
  const check = (name, cond) => { console.log((cond ? 'PASS ' : 'FAIL ') + name); if (!cond) failed++; };
  try {
    check('deploy V5', (await run(path.join(T, 'latheon', 'deploy.js'))).status === 0);
    check('deploy V7', (await run(path.join(T, 'latheon', 'deploy-v7.js'))).status === 0);
    const F = path.join(__dirname, 'flood.js');
    const fl = { STATE_DIR: path.join(tmp, 'fl-secret'), OUT_DIR: path.join(tmp, 'fl-out'), LATHEON_JSON: path.join(envs.OUT_DIR, 'latheon-deployments.json'), EXPLORER_API: 'http://127.0.0.1:1/none' };
    check('fund', (await run(F, ['fund', '--wallets', '6', '--per', '30'], fl)).status === 0);
    check('master key private', (fs.statSync(path.join(fl.STATE_DIR, 'master.key')).mode & 0o077) === 0);
    check('run: two stages', (await run(F, ['run', '--stages', '2,6', '--minutes', '0.3', '--wallets', '6', '--per', '30'], fl)).status === 0);
    const J = fs.readFileSync(path.join(fl.STATE_DIR, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const dep = J.filter((e) => e.kind === 'deposit'), st = J.filter((e) => e.kind === 'stage');
    check(`deposits journaled with their keys (${dep.length})`, dep.length > 4 && dep.every((e) => e.sk && e.vk && e.commitment && e.tx));
    check('two stage summaries, no failed sends', st.length === 2 && st.every((s) => s.failed === 0 && s.ok > 0));
    check('commitments unique', new Set(dep.map((e) => e.commitment)).size === dep.length);
    check('run: plain transfers, one stage', (await run(F, ['run', '--stages', '3', '--minutes', '0.2', '--wallets', '6', '--per', '30', '--kind', 'transfer'], fl)).status === 0);
    const ts = fs.readFileSync(path.join(fl.STATE_DIR, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.kind === 'stage' && e.tx === 'transfer');
    check('transfer stage: confirmed, none failed, gas recorded', ts.length === 1 && ts[0].ok > 0 && ts[0].failed === 0 && ts[0].gas && Number(ts[0].gas.used) >= 21000);
    // a real relayer (V7 only, as on the server), funded from the test key
    const prov = new ethers.JsonRpcProvider(rpc, undefined, { cacheTimeout: -1 });
    const rk = ethers.Wallet.createRandom(); fs.mkdirSync(path.join(tmp, 'rel'), { recursive: true }); fs.writeFileSync(path.join(tmp, 'rel', 'relayer.key'), rk.privateKey);
    await (await new ethers.Wallet(KEY, prov).sendTransaction({ to: rk.address, value: ethers.parseEther('100') })).wait();
    const rel = spawn(process.execPath, [path.join(T, 'relayer', 'relayer.js'), 'serve'], { env: { ...envs, PORT: String(RPORT), RELAYER_KEY_FILE: path.join(tmp, 'rel', 'relayer.key'), LATHEON_JSON: fl.LATHEON_JSON, RELAY_EXEMPT_IPS: '127.0.0.1,::1,::ffff:127.0.0.1' }, stdio: ['ignore', 'ignore', 'inherit'] });
    await new Promise((r) => setTimeout(r, 2500));
    check('prove: 6 proofs in advance', (await run(F, ['prove', '--count', '6'], fl)).status === 0 && fs.readFileSync(path.join(fl.STATE_DIR, 'proofs.jsonl'), 'utf8').trim().split('\n').length === 6);
    const b = await run(F, ['burst', '--stages', '2,4', '--per-stage', '3', '--relayer', `http://127.0.0.1:${RPORT}/relay/api`], fl);
    rel.kill();
    const BJ = fs.readFileSync(path.join(fl.STATE_DIR, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const bs = BJ.filter((e) => e.kind === 'burst-stage');
    check('burst: two stages, every withdrawal relayed and confirmed', b.status === 0 && bs.length === 2 && bs.every((x) => (x.byStatus['200'] || 0) === 3 && x.onChain === 3));
    const rep = await run(F, ['report'], fl);
    check('report has no key', rep.status === 0 && !dep.some((e) => rep.out.includes(e.sk)));
    check('sweep', (await run(F, ['sweep'], fl)).status === 0);
  } catch (e) { console.error(e); failed++; }
  console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nALL FLOOD LOCAL CHECKS PASSED');
  server.close().finally(() => process.exit(failed ? 1 : 0));
})();
