'use strict';
/*
 * Compiles the Latheon contracts for the test chain into artifacts/latheon-testnet.json (committed, so the server
 * does not compile anything). Protocol contracts come unchanged from latheon-network/Latheon at the commit in
 * LATHEON_COMMIT; WrappedLTH is local (contracts/WrappedLTH.sol).
 *
 *   LATHEON_REPO=/path/to/Latheon node build.js
 *
 * The output records the compiler, settings, source commit and the sha256 of every source, so anyone can rebuild it.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const solc = require('solc');

const HERE = __dirname;
const REPO = process.env.LATHEON_REPO || path.join(HERE, '..', '..', '..', 'Latheon');
const NM = path.join(HERE, 'node_modules');
const rd = (p) => fs.readFileSync(p, 'utf8');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

if (!fs.existsSync(path.join(REPO, 'contracts', 'LatheonShieldedPoolV5.sol'))) {
  console.error('Latheon repo not found at ' + REPO + ' (set LATHEON_REPO)'); process.exit(1);
}
let commit = 'unknown';
try { commit = execSync('git -C "' + REPO + '" rev-parse HEAD').toString().trim(); } catch (e) { /* not a git checkout */ }
if (process.env.LATHEON_COMMIT && process.env.LATHEON_COMMIT !== commit) {
  console.error('Latheon repo is at ' + commit + ', expected ' + process.env.LATHEON_COMMIT); process.exit(1);
}

const files = {
  'contracts/PoseidonT3.sol': path.join(REPO, 'contracts', 'PoseidonT3.sol'),
  'contracts/LatheonShieldedPoolV5.sol': path.join(REPO, 'contracts', 'LatheonShieldedPoolV5.sol'),
  'contracts/LatheonDistributionPool.sol': path.join(REPO, 'contracts', 'LatheonDistributionPool.sol'),
  'contracts/WithdrawVerifierV3.sol': path.join(REPO, 'contracts', 'WithdrawVerifierV3.sol'),
  'contracts/DiscloseVerifier.sol': path.join(REPO, 'contracts', 'DiscloseVerifier.sol'),
  'contracts/WrappedLTH.sol': path.join(HERE, 'contracts', 'WrappedLTH.sol'),
};
const sources = {}, hashes = {};
for (const [k, p] of Object.entries(files)) { sources[k] = { content: rd(p) }; hashes[k] = sha(sources[k].content); }

const settings = { optimizer: { enabled: true, runs: 200 }, evmVersion: 'paris',
  outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.bytecode.linkReferences', 'evm.deployedBytecode.object'] } } };
const imp = (p) => { const f = path.join(NM, p); return fs.existsSync(f) ? { contents: rd(f) } : { error: 'not found: ' + p }; };
console.log('Compiling with solc ' + solc.version() + ' …');
const out = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources, settings }), { import: imp }));
const errors = (out.errors || []).filter((e) => e.severity === 'error');
if (errors.length) { console.error(errors.map((e) => e.formattedMessage).join('\n')); process.exit(1); }

const pick = (file, name) => {
  const c = out.contracts[file][name];
  return { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object, linkReferences: c.evm.bytecode.linkReferences };
};
// Circuit files the deploy check and the smoke test prove with; fetched by commit and checked against these hashes.
const circuits = {};
for (const f of ['withdraw_v3/withdraw_v3.wasm', 'withdraw_v3/withdraw_v3_final.zkey', 'disclose/disclose.wasm', 'disclose/disclose_final.zkey'])
  circuits[f] = crypto.createHash('sha256').update(fs.readFileSync(path.join(REPO, 'circuits', 'build', f))).digest('hex');
const art = {
  compiler: 'solc ' + solc.version(),
  settings: { optimizer: settings.optimizer, evmVersion: settings.evmVersion },
  source: { repo: 'https://github.com/latheon-network/Latheon', commit, sha256: hashes, circuits },
  contracts: {
    WrappedLTH: pick('contracts/WrappedLTH.sol', 'WrappedLTH'),
    PoseidonT3: pick('contracts/PoseidonT3.sol', 'PoseidonT3'),
    WithdrawVerifier: pick('contracts/WithdrawVerifierV3.sol', 'Groth16Verifier'),
    DiscloseVerifier: pick('contracts/DiscloseVerifier.sol', 'Groth16Verifier'),
    Pool5: pick('contracts/LatheonShieldedPoolV5.sol', 'LatheonShieldedPoolV5'),
    Router: pick('contracts/LatheonDistributionPool.sol', 'LatheonDistributionPool'),
  },
};
fs.mkdirSync(path.join(HERE, 'artifacts'), { recursive: true });
const dest = path.join(HERE, 'artifacts', 'latheon-testnet.json');
fs.writeFileSync(dest, JSON.stringify(art, null, 1) + '\n');
console.log('Written ' + path.relative(process.cwd(), dest) + ' (Latheon ' + commit.slice(0, 7) + ')');
