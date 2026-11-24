'use strict';
/*
 * Compiles the Latheon contracts for the test chain into artifacts/latheon-testnet.json (committed, so the server
 * does not compile anything). Protocol contracts come unchanged from latheon-network/Latheon at the commit in
 * LATHEON_COMMIT. The test chain uses the native-coin pools and routers (V5: PoolNative, RouterNative; V6: PoolV6Native,
 * RouterV6Native with WithdrawVerifierV4); the ERC-20 V5
 * pool, router and the local WrappedLTH are built too, for the gas comparison in bench/ only.
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

if (!fs.existsSync(path.join(REPO, 'contracts', 'LatheonShieldedPoolV5Native.sol'))) {
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
  'contracts/LatheonShieldedPoolV5Native.sol': path.join(REPO, 'contracts', 'LatheonShieldedPoolV5Native.sol'),
  'contracts/LatheonDistributionPoolNative.sol': path.join(REPO, 'contracts', 'LatheonDistributionPoolNative.sol'),
  'contracts/WithdrawVerifierV3.sol': path.join(REPO, 'contracts', 'WithdrawVerifierV3.sol'),
  // V6: 20-level trees, recipient + relayer + fee bound into the proof (withdraw_v4)
  'contracts/WithdrawVerifierV4.sol': path.join(REPO, 'contracts', 'WithdrawVerifierV4.sol'),
  'contracts/LatheonShieldedPoolV6Native.sol': path.join(REPO, 'contracts', 'LatheonShieldedPoolV6Native.sol'),
  'contracts/LatheonDistributionPoolV6Native.sol': path.join(REPO, 'contracts', 'LatheonDistributionPoolV6Native.sol'),
  // V7: V6 plus the withdraw_v5 fix (pathIndices constrained to a bit) — supersedes V6
  'contracts/WithdrawVerifierV5.sol': path.join(REPO, 'contracts', 'WithdrawVerifierV5.sol'),
  'contracts/LatheonShieldedPoolV7Native.sol': path.join(REPO, 'contracts', 'LatheonShieldedPoolV7Native.sol'),
  'contracts/LatheonDistributionPoolV7Native.sol': path.join(REPO, 'contracts', 'LatheonDistributionPoolV7Native.sol'),
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
for (const f of ['withdraw_v3/withdraw_v3.wasm', 'withdraw_v3/withdraw_v3_final.zkey', 'withdraw_v4/withdraw_v4.wasm', 'withdraw_v4/withdraw_v4_final.zkey', 'withdraw_v5/withdraw_v5.wasm', 'withdraw_v5/withdraw_v5_final.zkey', 'disclose/disclose.wasm', 'disclose/disclose_final.zkey'])
  circuits[f] = crypto.createHash('sha256').update(fs.readFileSync(path.join(REPO, 'circuits', 'build', f))).digest('hex');
// ---- V8 (withdraw_v6, disclose_v2, disclose_link): pinned to solc 0.8.39 in their pragma, so compiled separately.
const solc839 = require('solc-0839');
const filesV8 = {
  'contracts/PoseidonT3.sol': path.join(REPO, 'contracts', 'PoseidonT3.sol'),
  'contracts/ILatheonV8.sol': path.join(REPO, 'contracts', 'ILatheonV8.sol'),
  'contracts/LatheonShieldedPoolV8Native.sol': path.join(REPO, 'contracts', 'LatheonShieldedPoolV8Native.sol'),
  'contracts/LatheonDistributionPoolV8Native.sol': path.join(REPO, 'contracts', 'LatheonDistributionPoolV8Native.sol'),
  'contracts/WithdrawVerifierV6.sol': path.join(REPO, 'contracts', 'WithdrawVerifierV6.sol'),
  'contracts/DiscloseVerifierV2.sol': path.join(REPO, 'contracts', 'DiscloseVerifierV2.sol'),
  'contracts/DiscloseLinkVerifier.sol': path.join(REPO, 'contracts', 'DiscloseLinkVerifier.sol'),
  'contracts/Timelock.sol': null,
};
const sourcesV8 = {};
for (const [k, p] of Object.entries(filesV8)) {
  sourcesV8[k] = { content: p ? rd(p) : '// SPDX-License-Identifier: MIT\npragma solidity 0.8.39;\nimport "@openzeppelin/contracts/governance/TimelockController.sol";\n' };
  hashes[k + ' (V8)'] = sha(sourcesV8[k].content);
}
console.log('Compiling V8 with solc ' + solc839.version() + ' …');
const out8 = JSON.parse(solc839.compile(JSON.stringify({ language: 'Solidity', sources: sourcesV8, settings }), { import: imp }));
const err8 = (out8.errors || []).filter((e) => e.severity === 'error');
if (err8.length) { console.error(err8.map((e) => e.formattedMessage).join('\n')); process.exit(1); }
const pick8 = (file, name) => {
  const c = out8.contracts[file][name];
  return { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object, linkReferences: c.evm.bytecode.linkReferences };
};
for (const f of ['withdraw_v6/withdraw_v6.wasm', 'withdraw_v6/withdraw_v6_final.zkey', 'disclose_v2/disclose_v2.wasm', 'disclose_v2/disclose_v2_final.zkey', 'disclose_link/disclose_link.wasm', 'disclose_link/disclose_link_final.zkey'])
  circuits[f] = crypto.createHash('sha256').update(fs.readFileSync(path.join(REPO, 'circuits', 'build', f))).digest('hex');

const art = {
  compiler: 'solc ' + solc.version(),
  compilerV8: 'solc ' + solc839.version(),
  settings: { optimizer: settings.optimizer, evmVersion: settings.evmVersion },
  source: { repo: 'https://github.com/latheon-network/Latheon', commit, sha256: hashes, circuits },
  contracts: {
    WrappedLTH: pick('contracts/WrappedLTH.sol', 'WrappedLTH'),
    PoseidonT3: pick('contracts/PoseidonT3.sol', 'PoseidonT3'),
    WithdrawVerifier: pick('contracts/WithdrawVerifierV3.sol', 'Groth16Verifier'),
    DiscloseVerifier: pick('contracts/DiscloseVerifier.sol', 'Groth16Verifier'),
    Pool5: pick('contracts/LatheonShieldedPoolV5.sol', 'LatheonShieldedPoolV5'),
    Router: pick('contracts/LatheonDistributionPool.sol', 'LatheonDistributionPool'),
    PoolNative: pick('contracts/LatheonShieldedPoolV5Native.sol', 'LatheonShieldedPoolV5Native'),
    RouterNative: pick('contracts/LatheonDistributionPoolNative.sol', 'LatheonDistributionPoolNative'),
    WithdrawVerifierV4: pick('contracts/WithdrawVerifierV4.sol', 'WithdrawVerifierV4'),
    PoolV6Native: pick('contracts/LatheonShieldedPoolV6Native.sol', 'LatheonShieldedPoolV6Native'),
    RouterV6Native: pick('contracts/LatheonDistributionPoolV6Native.sol', 'LatheonDistributionPoolV6Native'),
    WithdrawVerifierV5: pick('contracts/WithdrawVerifierV5.sol', 'WithdrawVerifierV5'),
    PoolV7Native: pick('contracts/LatheonShieldedPoolV7Native.sol', 'LatheonShieldedPoolV7Native'),
    RouterV7Native: pick('contracts/LatheonDistributionPoolV7Native.sol', 'LatheonDistributionPoolV7Native'),
    // V8, compiled with compilerV8
    PoolV8Native: pick8('contracts/LatheonShieldedPoolV8Native.sol', 'LatheonShieldedPoolV8Native'),
    RouterV8Native: pick8('contracts/LatheonDistributionPoolV8Native.sol', 'LatheonDistributionPoolV8Native'),
    WithdrawVerifierV6: pick8('contracts/WithdrawVerifierV6.sol', 'WithdrawVerifierV6'),
    DiscloseVerifierV2: pick8('contracts/DiscloseVerifierV2.sol', 'DiscloseVerifierV2'),
    DiscloseLinkVerifier: pick8('contracts/DiscloseLinkVerifier.sol', 'DiscloseLinkVerifier'),
    TimelockV8: pick8('@openzeppelin/contracts/governance/TimelockController.sol', 'TimelockController'),
  },
};
fs.mkdirSync(path.join(HERE, 'artifacts'), { recursive: true });
const dest = path.join(HERE, 'artifacts', 'latheon-testnet.json');
fs.writeFileSync(dest, JSON.stringify(art, null, 1) + '\n');
console.log('Written ' + path.relative(process.cwd(), dest) + ' (Latheon ' + commit.slice(0, 7) + ')');
