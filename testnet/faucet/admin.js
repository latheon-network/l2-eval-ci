'use strict';
/*
 * Faucet administration on the server (run through ../faucet-cmd.sh):
 *   node admin.js init           create the faucet key in secret/faucet.key (once; never printed) and show its address
 *   node admin.js address        show the faucet address and its balance
 *   node admin.js ops-init | ops-address | fund-ops AMOUNT | fund-from-ops AMOUNT   operator wallet for refills from the bot
 *   node admin.js fund AMOUNT    send AMOUNT LTH from the deployer to the faucet (asks for the deployer key without echo,
 *                                or DEPLOYER_KEY)
 * The faucet key is a separate wallet: if it leaks, only the faucet balance is at risk.
 */
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const env = (k, d) => (process.env[k] && process.env[k].trim()) || d;
const L3_RPC = env('L3_RPC', 'http://127.0.0.1:8449');
const KEY_FILE = env('FAUCET_KEY_FILE', path.join(__dirname, 'secret', 'faucet.key'));
const die = (m) => { console.error('ERROR: ' + m); process.exit(1); };

function askHidden(q) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(q);
    if (!stdin.isTTY) { let b = ''; stdin.setEncoding('utf8'); stdin.on('data', (c) => { b += c; if (/\r?\n/.test(b)) { stdin.pause(); process.stdout.write('\n'); resolve(b.split(/\r?\n/)[0].trim()); } }); stdin.once('end', () => resolve(b.trim())); return; }
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
const OPS_KEY_FILE = env('OPS_KEY_FILE', path.join(path.dirname(KEY_FILE), 'ops.key'));
const opsAddress = () => {
  if (!fs.existsSync(OPS_KEY_FILE)) die('no ops wallet yet: run ops-init first');
  return new ethers.Wallet(fs.readFileSync(OPS_KEY_FILE, 'utf8').trim()).address;
};
const faucetAddress = () => {
  if (!fs.existsSync(KEY_FILE)) die('no faucet key yet: run init first');
  return new ethers.Wallet(fs.readFileSync(KEY_FILE, 'utf8').trim()).address;
};

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  const provider = new ethers.JsonRpcProvider(L3_RPC);
  if (cmd === 'init') {
    if (fs.existsSync(KEY_FILE)) { console.log('Faucet key already exists. Address: ' + faucetAddress()); return; }
    fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true, mode: 0o700 });
    const w = ethers.Wallet.createRandom();
    fs.writeFileSync(KEY_FILE, w.privateKey + '\n', { mode: 0o600 });
    console.log('Faucet key created in ' + KEY_FILE + ' (keep it private). Address: ' + w.address);
    return;
  }
  if (cmd === 'address') {
    const a = faucetAddress();
    console.log('Faucet address: ' + a + '\nBalance: ' + ethers.formatEther(await provider.getBalance(a)) + ' LTH');
    return;
  }
  // Operator wallet ("ops"): a separate key with a limited LTH balance, used only to refill the faucet from the
  // Telegram bot (through ops-runner.sh), so the deployer key never sits on the server.
  if (cmd === 'ops-init') {
    if (fs.existsSync(OPS_KEY_FILE)) { console.log('Ops key already exists. Address: ' + opsAddress()); return; }
    const w = ethers.Wallet.createRandom();
    fs.writeFileSync(OPS_KEY_FILE, w.privateKey + '\n', { mode: 0o600 });
    console.log('Ops key created in ' + OPS_KEY_FILE + ' (keep it private). Address: ' + w.address);
    return;
  }
  if (cmd === 'ops-address') {
    const a = opsAddress();
    console.log('Ops wallet: ' + a + '\nBalance: ' + ethers.formatEther(await provider.getBalance(a)) + ' LTH');
    return;
  }
  if (cmd === 'fund-from-ops') {
    if (!arg || !/^\d+$/.test(arg)) die('usage: fund-from-ops AMOUNT (whole LTH)');
    const max = Number(env('OPS_FUND_MAX', '50000'));
    if (Number(arg) < 1 || Number(arg) > max) die(`the amount must be between 1 and ${max} LTH`);
    if (!fs.existsSync(OPS_KEY_FILE)) die('no ops wallet yet: ./faucet-cmd.sh ops-init');
    const w = new ethers.Wallet(fs.readFileSync(OPS_KEY_FILE, 'utf8').trim(), provider);
    const value = ethers.parseEther(arg), to = faucetAddress();
    const bal = await provider.getBalance(w.address);
    if (bal < value) die(`the ops wallet ${w.address} holds ${ethers.formatEther(bal)} LTH, less than ${arg}`);
    const rc = await (await w.sendTransaction({ to, value })).wait();
    if (rc.status !== 1) die('the transfer reverted');
    console.log(`Sent ${arg} LTH from the ops wallet to the faucet, tx ${rc.hash}. Faucet: ${ethers.formatEther(await provider.getBalance(to))} LTH, ops wallet: ${ethers.formatEther(await provider.getBalance(w.address))} LTH`);
    return;
  }
  if (cmd === 'fund' || cmd === 'fund-ops') {
    if (!arg || !/^\d+(\.\d+)?$/.test(arg)) die('usage: ' + cmd + ' AMOUNT (LTH, for example 5000)');
    const to = cmd === 'fund' ? faucetAddress() : opsAddress();
    let key = env('DEPLOYER_KEY', '') || await askHidden('Deployer private key (input hidden): ');
    if (/^[0-9a-fA-F]{64}$/.test(key)) key = '0x' + key;
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) die('the key must be 64 hex characters');
    const w = new ethers.Wallet(key, provider);
    const value = ethers.parseEther(arg);
    const bal = await provider.getBalance(w.address);
    if (bal < value) die(`the deployer ${w.address} holds ${ethers.formatEther(bal)} LTH on this chain, less than ${arg}`);
    const tx = await w.sendTransaction({ to, value });
    const rc = await tx.wait();
    if (rc.status !== 1) die('the transfer reverted');
    console.log(`Sent ${arg} LTH to the ${cmd === 'fund' ? 'faucet' : 'ops wallet'} ${to}, tx ${rc.hash}. Its balance: ${ethers.formatEther(await provider.getBalance(to))} LTH`);
    return;
  }
  die('usage: node admin.js init | address | fund AMOUNT | ops-init | ops-address | fund-ops AMOUNT | fund-from-ops AMOUNT');
}
main().catch((e) => die((e && (e.shortMessage || e.message)) || String(e)));
