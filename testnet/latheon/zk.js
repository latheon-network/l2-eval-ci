'use strict';
// Circuit files and proofs. Files come from LATHEON_REPO if set, otherwise from jsDelivr at the exact commit recorded
// in the artifacts; every file is checked against the sha256 recorded at build time before it is used.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const snarkjs = require('snarkjs');
const { poseidon2 } = require('poseidon-lite');
const { ART, HERE, LEVELS, env, log, die } = require('./lib');

const CACHE = env('CIRCUIT_CACHE', path.join(HERE, '.circuits'));

async function circuitFile(rel) {
  const want = ART.source.circuits[rel];
  if (!want) die('no hash recorded for ' + rel);
  const local = process.env.LATHEON_REPO ? path.join(process.env.LATHEON_REPO, 'circuits', 'build', rel) : path.join(CACHE, rel);
  if (!fs.existsSync(local)) {
    const url = `https://cdn.jsdelivr.net/gh/latheon-network/latheon@${ART.source.commit}/circuits/build/${rel}`;
    log('   downloading ' + rel);
    const r = await fetch(url);
    if (!r.ok) die('download failed (' + r.status + '): ' + url);
    fs.mkdirSync(path.dirname(local), { recursive: true });
    fs.writeFileSync(local, Buffer.from(await r.arrayBuffer()));
  }
  const got = crypto.createHash('sha256').update(fs.readFileSync(local)).digest('hex');
  if (got !== want) die(rel + ': sha256 ' + got + ' does not match the build (' + want + ')');
  return local;
}

const commitmentOf = (sk, vk) => poseidon2([poseidon2([sk, vk]), 0n]);
const nullifierOf = (sk) => poseidon2([sk, 1n]);

// Merkle tree of a pool from its leaves (index order) and the pool's zeros(0..LEVELS-1).
function tree(leaves, zeros) {
  const levels = [leaves.slice()];
  for (let l = 0; l < LEVELS; l++) {
    const cur = levels[l], up = [];
    for (let j = 0; j < Math.max(1, Math.ceil(cur.length / 2)); j++) up.push(poseidon2([cur[2 * j] ?? zeros[l], cur[2 * j + 1] ?? zeros[l]]));
    levels.push(up);
  }
  return {
    root: levels[LEVELS][0],
    path(leaf) { const el = [], idx = []; let k = leaf; for (let l = 0; l < LEVELS; l++) { el.push((levels[l][k ^ 1] ?? zeros[l]).toString()); idx.push(k & 1); k >>= 1; } return { el, idx }; },
  };
}

async function withdrawProof({ sk, vk, leaf, leaves, zeros, recipient }) {
  const t = tree(leaves, zeros);
  const { el, idx } = t.path(leaf);
  const input = { root: t.root.toString(), nullifierHash: nullifierOf(sk).toString(), recipient: BigInt(recipient).toString(),
    spendKey: sk.toString(), viewKey: vk.toString(), pathElements: el, pathIndices: idx };
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, await circuitFile('withdraw_v3/withdraw_v3.wasm'), await circuitFile('withdraw_v3/withdraw_v3_final.zkey'));
  const [pA, pB, pC, pub] = JSON.parse('[' + (await snarkjs.groth16.exportSolidityCallData(proof, publicSignals)) + ']');
  return { pA, pB, pC, pub, root: pub[0], nullifierHash: pub[1] };
}

async function discloseProof({ sk, vk, nonce }) {
  const input = { commitment: commitmentOf(sk, vk).toString(), disclosureTag: poseidon2([vk, nonce]).toString(), auditorNonce: nonce.toString(),
    spendKey: sk.toString(), viewKey: vk.toString() };
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, await circuitFile('disclose/disclose.wasm'), await circuitFile('disclose/disclose_final.zkey'));
  const [pA, pB, pC, pub] = JSON.parse('[' + (await snarkjs.groth16.exportSolidityCallData(proof, publicSignals)) + ']');
  return { pA, pB, pC, pub };
}

module.exports = { commitmentOf, nullifierOf, tree, withdrawProof, discloseProof };
