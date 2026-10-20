'use strict';
/*
 * Telegram bot for the operator of the test chain: answers /status (and /start, /help) with a summary in Russian.
 * Runs on the server as the docker compose service "bot"; reads Telegram with long polling (no open port).
 * Answers only the chat TG_CHAT_ID; any other chat is ignored. Needs no key of the chain and prints none: it reads the
 * public chain/out/chain.json and latheon/out/latheon-deployments.json and asks the services over the internal network.
 *
 * Env: TG_BOT_TOKEN, TG_CHAT_ID, L3_RPC (http://nitro:8449), PARENT_RPC, RPC_HOST, EXPLORER_HOST.
 * No dependencies: Node 22 (fetch built in).
 */
const fs = require('fs');

const TOKEN = (process.env.TG_BOT_TOKEN || '').trim();
const CHAT = String(process.env.TG_CHAT_ID || '').trim();
const L3_RPC = process.env.L3_RPC || 'http://nitro:8449';
const PARENT_RPC = process.env.PARENT_RPC || 'https://sepolia-rollup.arbitrum.io/rpc';
const RPC_HOST = process.env.RPC_HOST, EXPLORER_HOST = process.env.EXPLORER_HOST;
const CHAIN_JSON = process.env.CHAIN_JSON || '/chain-out/chain.json';
const LATHEON_JSON = process.env.LATHEON_JSON || '/latheon-out/latheon-deployments.json';
const MIN = { batchPoster: 0.005, validator: 0.003, deployer: 0.02, faucet: 1000 };
const log = (...a) => console.log(new Date().toISOString(), ...a);

if (!TOKEN || !CHAT) { log('TG_BOT_TOKEN or TG_CHAT_ID not set in .env: the bot is idle'); setInterval(() => {}, 1 << 30); return; }

const TG_API = process.env.TG_API || 'https://api.telegram.org';   // overridable for the local test
const TG = (m) => `${TG_API}/bot${TOKEN}/${m}`;
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } };
async function rpc(url, method, params = []) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(15000) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}
const call = (url, to, data) => rpc(url, 'eth_call', [{ to, data }, 'latest']);
const num = (hex) => Number(BigInt(hex)) / 1e18;
const fmt = (x, d) => x.toLocaleString('ru-RU', { minimumFractionDigits: d, maximumFractionDigits: d });
const FAUCET_URL = process.env.FAUCET_STATUS_URL || 'http://faucet:8080/faucet/api/status';
async function httpCode(url) { try { return (await fetch(url, { signal: AbortSignal.timeout(15000) })).status; } catch (e) { return 0; } }
async function safe(fn) { try { return await fn(); } catch (e) { return null; } }

async function summary() {
  const pub = readJson(CHAIN_JSON), lat = readJson(LATHEON_JSON);
  const lines = [], warn = [];
  if (!pub) return '⚠️ Нет chain/out/chain.json на сервере.';
  // chain and public endpoints
  const blk = await safe(() => rpc(L3_RPC, 'eth_getBlockByNumber', ['latest', false]));
  if (blk) lines.push(`Сеть: блок ${Number(blk.number)}, ${Math.round(Date.now() / 1000 - Number(blk.timestamp))} с назад`);
  else warn.push('узел не отвечает на внутреннем адресе');
  const pubRpc = await safe(() => rpc('https://' + RPC_HOST, 'eth_chainId'));
  const api = await httpCode(`https://${EXPLORER_HOST}/api/v2/stats`), page = await httpCode(`https://${EXPLORER_HOST}/`);
  lines.push(`Публичный RPC: ${pubRpc ? 'работает' : 'не отвечает'} · обозреватель: ${page === 200 && api === 200 ? 'работает' : `страница ${page}, API ${api}`}`);
  if (!pubRpc) warn.push('публичный RPC не отвечает');
  if (page !== 200 || api !== 200) warn.push('обозреватель отвечает с ошибкой');
  // Arbitrum Sepolia: batches and validator
  const bc = await safe(() => call(PARENT_RPC, pub.coreContracts.sequencerInbox, '0x06f13056'));   // batchCount()
  const conf = await safe(() => call(PARENT_RPC, pub.coreContracts.rollup, '0x65f7f80d'));        // latestConfirmed()
  lines.push(`Пакеты в Arbitrum Sepolia: ${bc ? Number(BigInt(bc)) : 'н/д'} · подтверждённое утверждение: ${conf ? conf.slice(0, 10) + '…' : 'н/д'}`);
  const eth = [];
  for (const [label, addr, min] of [['Batch poster', pub.batchPoster, MIN.batchPoster], ['Валидатор', pub.validator, MIN.validator], ['Деплоер', pub.deployer, MIN.deployer]]) {
    const b = await safe(() => rpc(PARENT_RPC, 'eth_getBalance', [addr, 'latest']));
    if (b === null) { eth.push(`${label}: н/д`); continue; }
    eth.push(`${label}: ${fmt(num(b), 4)} ETH`);
    if (num(b) < min) warn.push(`${label}: ${fmt(num(b), 4)} ETH, меньше ${fmt(min, 3)} — пополнить`);
  }
  lines.push(eth.join(' · '));
  // LTH on the chain
  const fs_ = await safe(async () => (await fetch(FAUCET_URL, { signal: AbortSignal.timeout(10000) })).json());
  if (fs_ && fs_.balance !== undefined) {
    lines.push(`Кран: ${fmt(Number(fs_.balance), 0)} LTH, выдано за сутки ${fmt(Number(fs_.sentLast24h || 0), 0)}`);
    if (Number(fs_.balance) < MIN.faucet) warn.push(`в кране меньше ${MIN.faucet} LTH — ./faucet-cmd.sh fund`);
  } else lines.push('Кран: не настроен или не отвечает');
  if (lat) {
    let shielded = 0;
    for (const p of lat.pools || []) { const b = await safe(() => rpc(L3_RPC, 'eth_getBalance', [p.address, 'latest'])); if (b) shielded += num(b); }
    lines.push(`В пулах: ${fmt(shielded, 0)} LTH`);
  }
  const dep = await safe(() => rpc(L3_RPC, 'eth_getBalance', [pub.deployer, 'latest']));
  if (dep) lines.push(`Деплоер в сети: ${fmt(num(dep), 0)} LTH`);
  const when = new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) + ' МСК';
  const head = warn.length ? '🔴 Latheon testnet: есть проблемы' : '✅ Latheon testnet: всё работает';
  return [head, '', ...(warn.length ? warn.map((w) => '• ' + w).concat('') : []), ...lines, '', when].join('\n');
}

async function send(text) {
  await fetch(TG('sendMessage'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: CHAT, text, disable_web_page_preview: true }) });
}
const HELP = 'Команды:\n/status — сводка по тестовой сети\n/help — эта подсказка';

(async function poll() {
  let offset = 0;
  log('bot started, answering chat', CHAT);
  for (;;) {
    try {
      const r = await (await fetch(TG(`getUpdates?timeout=50&offset=${offset}&allowed_updates=["message"]`), { signal: AbortSignal.timeout(65000) })).json();
      for (const u of r.result || []) {
        offset = u.update_id + 1;
        const m = u.message; if (!m || !m.text) continue;
        if (String(m.chat.id) !== CHAT) { log('ignored a message from chat', m.chat.id); continue; }
        const cmd = m.text.trim().split(/[\s@]/)[0].toLowerCase();
        if (cmd === '/status' || cmd === 'статус') { await send('Проверяю…'); await send(await summary()); }
        else if (cmd === '/start' || cmd === '/help') await send(HELP);
        else await send('Не понял. ' + HELP);
      }
    } catch (e) { log('poll error:', e.message); await new Promise((res) => setTimeout(res, 5000)); }
  }
})();
