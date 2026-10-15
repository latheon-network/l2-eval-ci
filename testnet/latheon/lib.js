'use strict';
// Shared helpers for deploy.js and smoke.js. Testnet only.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ethers } = require('ethers');

const HERE = __dirname;
const ART = JSON.parse(fs.readFileSync(path.join(HERE, 'artifacts', 'latheon-testnet.json'), 'utf8'));
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const E18 = 10n ** 18n;
const DENOMS = [100n * E18, 50n * E18, 10n * E18, 1n * E18];
const LEVELS = 8;
// zeros(8) of a correctly linked V5 pool (PoseidonT3 cascade from 0); a wrong library address fails here.
const ZERO_TOP = 21551820661461729022865262380882070649935529853313286572328683688269863701601n;

const env = (k, d) => (process.env[k] && process.env[k].trim()) || d;
const L3_RPC = env('L3_RPC', 'http://127.0.0.1:8449');
const STATE_DIR = env('STATE_DIR', path.join(HERE, 'secret'));
const OUT_DIR = env('OUT_DIR', path.join(HERE, 'out'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = () => BigInt('0x' + crypto.randomBytes(31).toString('hex')) % FIELD;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

function die(msg) { console.error('\nERROR: ' + msg); process.exit(1); }

// Reads the key from DEPLOYER_KEY, or asks for it without echo. The key is never printed or written.
function askHidden(question) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(question);
    if (!stdin.isTTY) {
      let buf = '';
      stdin.setEncoding('utf8');
      stdin.on('data', (c) => { buf += c; if (/\r?\n/.test(buf)) { stdin.pause(); process.stdout.write('\n'); resolve(buf.split(/\r?\n/)[0].trim()); } });
      stdin.once('end', () => resolve(buf.trim()));
      return;
    }
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    let s = '';
    stdin.on('data', (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') { stdin.setRawMode(false); stdin.pause(); process.stdout.write('\n'); return resolve(s.trim()); }
        if (ch === '\u0003') process.exit(1);
        if (ch === '\u007f' || ch === '\b') { s = s.slice(0, -1); continue; }
        s += ch;
      }
    });
  });
}
async function getKey() {
  let key = env('DEPLOYER_KEY', '');
  if (!key) key = await askHidden('Deployer private key for the Latheon test chain (input hidden): ');
  if (/^[0-9a-fA-F]{64}$/.test(key)) key = '0x' + key;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) die('the key must be 64 hex characters (optionally with 0x)');
  return key;
}

async function retry(fn, label, tries = 5) {
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (e) {
      const m = String((e && (e.shortMessage || e.message)) || e);
      const transient = /coalesce|timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket|hang up|50[234]|429|rate limit|network|nonce too low|replacement/i.test(m);
      if (!transient || i >= tries) throw e;
      log(`   retry ${i} (${label}): ${m.slice(0, 90)}`);
      await sleep(1500 * i);
    }
  }
}

async function connect() {
  const provider = new ethers.JsonRpcProvider(L3_RPC, undefined, { cacheTimeout: -1 });
  const chainId = Number((await retry(() => provider.getNetwork(), 'chainId')).chainId);
  const wallet = new ethers.NonceManager(new ethers.Wallet(await getKey(), provider));
  const me = await wallet.getAddress();
  return { provider, wallet, me, chainId };
}

function loadJson(p, d) { return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : d; }
function saveJson(p, o) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(o, null, 1) + '\n'); }

// Links the PoseidonT3 library address into a pool's bytecode (PoolNative by default, Pool5 for the bench).
function linkPool(poseidon, name = 'PoolNative') {
  const c = ART.contracts[name];
  let code = c.bytecode;
  for (const f in c.linkReferences) for (const l in c.linkReferences[f]) for (const { start, length } of c.linkReferences[f][l])
    code = code.slice(0, 2 + start * 2) + poseidon.slice(2).toLowerCase() + code.slice(2 + start * 2 + length * 2);
  if (/__\$/.test(code)) die('pool bytecode still has an unlinked library placeholder');
  return code;
}

module.exports = { ethers, ART, E18, DENOMS, LEVELS, ZERO_TOP, L3_RPC, STATE_DIR, OUT_DIR, HERE, env, rnd, log, die, retry, connect, loadJson, saveJson, linkPool, sleep };
