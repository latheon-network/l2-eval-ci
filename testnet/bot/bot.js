'use strict';
/*
 * Telegram bot for the operator of the test chain, and the data source of the dashboard at https://EXPLORER_HOST/ops/.
 * Runs on the server as the docker compose service "bot"; reads Telegram with long polling (no open port).
 *
 * - /status: summary in Russian. /menu (or /start): buttons for the summary, restarts, logs, the faucet and the dashboard.
 * - Actions (restart, faucet pause/resume/refill) need a second tap to confirm, expire after 5 minutes, and run one at a
 *   time. The bot itself has no docker access and no chain key: it drops a request file into OPS_QUEUE, and
 *   ops-runner.sh (systemd on the host, see ops-install.sh) runs it from a fixed list and writes the answer back.
 * - Answers only the chat TG_CHAT_ID; messages and button presses from any other chat are ignored.
 * - Every 2 minutes it writes a public snapshot for the dashboard (OPS_DATA/now.json) and, every 15 minutes, a point
 *   of OPS_DATA/history.json (7 days). Only public data: balances, counts, statuses.
 *
 * Env: TG_BOT_TOKEN, TG_CHAT_ID, L3_RPC, PARENT_RPC, RPC_HOST, EXPLORER_HOST, OPS_QUEUE (/ops-queue), OPS_DATA (/ops-data).
 * No dependencies: Node 22 (fetch built in).
 */
const fs = require('fs');
const path = require('path');

const TOKEN = (process.env.TG_BOT_TOKEN || '').trim();
const CHAT = String(process.env.TG_CHAT_ID || '').trim();
const L3_RPC = process.env.L3_RPC || 'http://nitro:8449';
const PARENT_RPC = process.env.PARENT_RPC || 'https://sepolia-rollup.arbitrum.io/rpc';
const RPC_HOST = process.env.RPC_HOST, EXPLORER_HOST = process.env.EXPLORER_HOST;
const CHAIN_JSON = process.env.CHAIN_JSON || '/chain-out/chain.json';
const LATHEON_JSON = process.env.LATHEON_JSON || '/latheon-out/latheon-deployments.json';
const FAUCET_URL = process.env.FAUCET_STATUS_URL || 'http://faucet:8080/faucet/api/status';
const OPS_QUEUE = process.env.OPS_QUEUE || '/ops-queue';
const OPS_DATA = process.env.OPS_DATA || '/ops-data';
const TG_API = process.env.TG_API || 'https://api.telegram.org';   // overridable for the local test
const SNAPSHOT_MS = Number(process.env.SNAPSHOT_MS || 120000), HISTORY_EVERY_MS = 15 * 60000, HISTORY_DAYS = 7;
const MIN = { batchPoster: 0.005, validator: 0.003, deployer: 0.02, faucet: 1000, relayer: 100 };
const RELAYER_URL = process.env.RELAYER_STATUS_URL || 'http://relayer:8090/relay/api/status';
const SERVICES = ['nitro', 'blockscout', 'frontend', 'faucet', 'relayer', 'caddy', 'db', 'bot'];
const FUND_STEPS = [10000, 50000];
const log = (...a) => console.log(new Date().toISOString(), ...a);

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
async function httpCode(url) { try { return (await fetch(url, { signal: AbortSignal.timeout(15000) })).status; } catch (e) { return 0; } }
async function safe(fn) { try { return await fn(); } catch (e) { return null; } }
const moscow = (d) => d.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) + ' МСК';

// ---------- one snapshot of the chain, shared by /status and the dashboard ----------
async function collect() {
  const pub = readJson(CHAIN_JSON), lat = readJson(LATHEON_JSON);
  const s = { time: new Date().toISOString(), problems: [], chainId: pub && pub.chainId, explorer: EXPLORER_HOST ? 'https://' + EXPLORER_HOST : null };
  if (!pub) { s.problems.push('нет chain/out/chain.json на сервере'); return s; }
  const blk = await safe(() => rpc(L3_RPC, 'eth_getBlockByNumber', ['latest', false]));
  if (blk) s.block = { number: Number(blk.number), ageSec: Math.round(Date.now() / 1000 - Number(blk.timestamp)) };
  else s.problems.push('узел не отвечает на внутреннем адресе');
  s.publicRpc = !!(await safe(() => rpc('https://' + RPC_HOST, 'eth_chainId')));
  const api = await httpCode(`https://${EXPLORER_HOST}/api/v2/stats`), page = await httpCode(`https://${EXPLORER_HOST}/`);
  s.explorerOk = api === 200 && page === 200;
  if (!s.publicRpc) s.problems.push('публичный RPC не отвечает');
  if (!s.explorerOk) s.problems.push(`обозреватель: страница ${page}, API ${api}`);
  const bc = await safe(() => call(PARENT_RPC, pub.coreContracts.sequencerInbox, '0x06f13056'));   // batchCount()
  const conf = await safe(() => call(PARENT_RPC, pub.coreContracts.rollup, '0x65f7f80d'));        // latestConfirmed()
  s.batches = bc ? Number(BigInt(bc)) : null;
  s.latestConfirmed = conf || null;
  s.eth = {};
  for (const [key, label, addr, min] of [['batchPoster', 'Batch poster', pub.batchPoster, MIN.batchPoster], ['validator', 'Валидатор', pub.validator, MIN.validator], ['deployer', 'Деплоер', pub.deployer, MIN.deployer]]) {
    const b = await safe(() => rpc(PARENT_RPC, 'eth_getBalance', [addr, 'latest']));
    s.eth[key] = { address: addr, eth: b === null ? null : num(b) };
    if (b !== null && num(b) < min) s.problems.push(`${label}: ${fmt(num(b), 4)} ETH в Arbitrum Sepolia, меньше ${fmt(min, 3)} — пополнить`);
  }
  const f = await safe(async () => (await fetch(FAUCET_URL, { signal: AbortSignal.timeout(10000) })).json());
  if (f && f.balance !== undefined) {
    s.faucet = { address: f.address, balance: Number(f.balance), sent24h: Number(f.sentLast24h || 0), paused: !!f.paused };
    if (s.faucet.balance < MIN.faucet) s.problems.push(`в кране меньше ${fmt(MIN.faucet, 0)} LTH`);
  } else s.faucet = null;
  const rl = await safe(async () => (await fetch(RELAYER_URL, { signal: AbortSignal.timeout(10000) })).json());
  if (rl && rl.address) {
    s.relayer = { address: rl.address, balance: Number(rl.balance), relayed24h: rl.relayedLast24h, enabled: rl.enabled };
    if (s.relayer.balance < MIN.relayer) s.problems.push(`у релейера ${fmt(s.relayer.balance, 0)} LTH, меньше ${MIN.relayer} — ./relayer-cmd.sh fund`);
  } else { s.relayer = null; s.problems.push('релейер не отвечает'); }
  if (lat) {
    s.pools = [];
    for (const p of lat.pools || []) {
      const [b, n] = await Promise.all([safe(() => rpc(L3_RPC, 'eth_getBalance', [p.address, 'latest'])), safe(() => call(L3_RPC, p.address, '0xfc7e9c6f'))]);   // nextIndex()
      s.pools.push({ amount: p.amount, address: p.address, lth: b ? num(b) : null, deposits: n ? Number(BigInt(n)) : null });
    }
  }
  const dep = await safe(() => rpc(L3_RPC, 'eth_getBalance', [pub.deployer, 'latest']));
  s.deployerLth = dep ? num(dep) : null;
  return s;
}

function summaryText(s) {
  const L = [];
  if (s.block) L.push(`Сеть: блок ${s.block.number}, ${s.block.ageSec} с назад`);
  L.push(`Публичный RPC: ${s.publicRpc ? 'работает' : 'не отвечает'} · обозреватель: ${s.explorerOk ? 'работает' : 'ошибка'}`);
  L.push(`Пакеты в Arbitrum Sepolia: ${s.batches ?? 'н/д'} · подтверждённое утверждение: ${s.latestConfirmed ? s.latestConfirmed.slice(0, 10) + '…' : 'н/д'}`);
  if (s.eth) L.push(['batchPoster:Batch poster', 'validator:Валидатор', 'deployer:Деплоер'].map((x) => { const [k, n] = x.split(':'); const e = s.eth[k] && s.eth[k].eth; return `${n}: ${e === null || e === undefined ? 'н/д' : fmt(e, 4) + ' ETH'}`; }).join(' · '));
  if (s.faucet) L.push(`Кран: ${fmt(s.faucet.balance, 0)} LTH, выдано за сутки ${fmt(s.faucet.sent24h, 0)}${s.faucet.paused ? ' · НА ПАУЗЕ' : ''}`);
  else L.push('Кран: не настроен или не отвечает');
  L.push(s.relayer ? `Релейер: ${fmt(s.relayer.balance, 0)} LTH на газ, выводов за сутки ${s.relayer.relayed24h}` : 'Релейер: не отвечает');
  if (s.pools) L.push(`В пулах: ${fmt(s.pools.reduce((a, p) => a + (p.lth || 0), 0), 0)} LTH, депозитов ${s.pools.reduce((a, p) => a + (p.deposits || 0), 0)}`);
  if (s.deployerLth !== null && s.deployerLth !== undefined) L.push(`Деплоер в сети: ${fmt(s.deployerLth, 0)} LTH`);
  const head = s.problems.length ? '🔴 Latheon testnet: есть проблемы' : '✅ Latheon testnet: всё работает';
  return [head, '', ...(s.problems.length ? s.problems.map((w) => '• ' + w).concat('') : []), ...L, '', moscow(new Date(s.time))].join('\n');
}

// ---------- dashboard data ----------
let lastHistory = 0;
async function snapshot() {
  try {
    const s = await collect();
    fs.mkdirSync(OPS_DATA, { recursive: true });
    const tmp = path.join(OPS_DATA, 'now.json.tmp');
    fs.writeFileSync(tmp, JSON.stringify(s)); fs.renameSync(tmp, path.join(OPS_DATA, 'now.json'));
    if (Date.now() - lastHistory >= HISTORY_EVERY_MS) {
      lastHistory = Date.now();
      const hp = path.join(OPS_DATA, 'history.json'), h = readJson(hp) || [];
      h.push({ t: s.time, block: s.block ? s.block.number : null, batches: s.batches, faucet: s.faucet ? s.faucet.balance : null,
        deposits: s.pools ? s.pools.reduce((a, p) => a + (p.deposits || 0), 0) : null, shielded: s.pools ? s.pools.reduce((a, p) => a + (p.lth || 0), 0) : null,
        relayed: s.relayer ? s.relayer.relayed24h : null, bp: s.eth && s.eth.batchPoster ? s.eth.batchPoster.eth : null, val: s.eth && s.eth.validator ? s.eth.validator.eth : null, ok: s.problems.length === 0 });
      const cut = Date.now() - HISTORY_DAYS * 86400000;
      const kept = h.filter((x) => Date.parse(x.t) >= cut);
      fs.writeFileSync(hp + '.tmp', JSON.stringify(kept)); fs.renameSync(hp + '.tmp', hp);
    }
  } catch (e) { log('snapshot error:', e.message); }
}

// ---------- Telegram ----------
const TG = (m) => `${TG_API}/bot${TOKEN}/${m}`;
async function tg(method, body) {
  const r = await fetch(TG(method), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  return r.json();
}
const send = (text, buttons) => tg('sendMessage', { chat_id: CHAT, text, disable_web_page_preview: true, ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}) });
const btn = (text, data) => ({ text, callback_data: data });

function menu() {
  const rows = [[btn('📊 Сводка', 'status')], [btn('🔁 Перезапуск', 'm:restart'), btn('📜 Логи', 'm:logs')], [btn('🚰 Кран', 'm:faucet')]];
  if (EXPLORER_HOST) rows.push([{ text: '🖥 Панель', url: `https://${EXPLORER_HOST}/ops/` }]);
  return rows;
}
const serviceButtons = (kind) => { const r = []; for (let i = 0; i < SERVICES.length; i += 3) r.push(SERVICES.slice(i, i + 3).map((s) => btn(s, `${kind}:${s}`))); r.push([btn('← Меню', 'menu')]); return r; };
const faucetButtons = () => [[btn('⏸ Пауза', 'ask:faucet-pause'), btn('▶️ Возобновить', 'ask:faucet-resume')],
  FUND_STEPS.map((n) => btn(`➕ ${fmt(n, 0)} LTH`, `ask:faucet-fund:${n}`)), [btn('Кошелёк пополнений', 'run:ops-address'), btn('← Меню', 'menu')]];
const describe = (action, arg) => ({ restart: `перезапустить ${arg}`, 'faucet-pause': 'поставить кран на паузу', 'faucet-resume': 'снять кран с паузы', 'faucet-fund': `пополнить кран на ${fmt(Number(arg), 0)} LTH из кошелька пополнений` })[action] || action;

let busy = false;
async function runOps(action, arg) {
  if (busy) return send('Уже выполняется другое действие, подожди.');
  busy = true;
  try {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    fs.writeFileSync(path.join(OPS_QUEUE, id + '.req'), `${action}${arg ? ' ' + arg : ''}\n`);
    await send(`⏳ Выполняю: ${describe(action, arg)}…`);
    const outFile = path.join(OPS_QUEUE, id + '.out'), t0 = Date.now();
    while (!fs.existsSync(outFile)) {
      if (Date.now() - t0 > 240000) return send('⚠️ Нет ответа от исполнителя за 4 минуты. Установлен ли он на сервере (./ops-install.sh)?');
      await new Promise((r) => setTimeout(r, 1500));
    }
    const out = fs.readFileSync(outFile, 'utf8').trim().slice(-3500) || '(пусто)';
    await send((/^refused/m.test(out) ? '⛔ ' : '✅ ') + describe(action, arg) + '\n\n' + out, [[btn('← Меню', 'menu')]]);
  } catch (e) { await send('⚠️ Не удалось: ' + e.message); } finally { busy = false; }
}

async function onCallback(cb) {
  const data = cb.data || '';
  await tg('answerCallbackQuery', { callback_query_id: cb.id });
  if (data === 'menu') return send('Что сделать?', menu());
  if (data === 'status') { await send('Проверяю…'); return send(summaryText(await collect()), [[btn('← Меню', 'menu')]]); }
  if (data === 'm:restart') return send('Какой сервис перезапустить?', serviceButtons('ask:restart'));
  if (data === 'm:logs') return send('Чьи логи показать (последние 25 строк)?', serviceButtons('run:logs'));
  if (data === 'm:faucet') { const s = await collect(); return send(s.faucet ? `Кран: ${fmt(s.faucet.balance, 0)} LTH${s.faucet.paused ? ', на паузе' : ''}.` : 'Кран не отвечает.', faucetButtons()); }
  let m = data.match(/^ask:([a-z-]+)(?::([a-z0-9]+))?$/);
  if (m) return send(`Точно ${describe(m[1], m[2])}?`, [[btn('Да', `do:${m[1]}${m[2] ? ':' + m[2] : ''}:${Date.now()}`), btn('Нет', 'menu')]]);
  m = data.match(/^do:([a-z-]+)(?::([a-z0-9]+))?:(\d+)$/);
  if (m) { if (Date.now() - Number(m[3]) > 300000) return send('Подтверждение устарело, начни заново.', menu()); return runOps(m[1], m[2]); }
  m = data.match(/^run:(logs|ops-address)(?::([a-z0-9]+))?$/);
  if (m) return runOps(m[1], m[2]);
}

async function onMessage(m) {
  const cmd = m.text.trim().split(/[\s@]/)[0].toLowerCase();
  if (cmd === '/status' || cmd === 'статус') { await send('Проверяю…'); return send(summaryText(await collect()), [[btn('← Меню', 'menu')]]); }
  if (cmd === '/start' || cmd === '/menu' || cmd === 'меню' || cmd === '/help') return send('Latheon testnet. Что сделать?', menu());
  return send('Не понял. Команды: /status — сводка, /menu — кнопки.', menu());
}

async function poll() {
  let offset = 0;
  log('bot started, answering chat', CHAT);
  for (;;) {
    try {
      const r = await (await fetch(TG(`getUpdates?timeout=50&offset=${offset}&allowed_updates=${encodeURIComponent('["message","callback_query"]')}`), { signal: AbortSignal.timeout(65000) })).json();
      for (const u of r.result || []) {
        offset = u.update_id + 1;
        const chat = u.message ? u.message.chat.id : u.callback_query && u.callback_query.message ? u.callback_query.message.chat.id : null;
        if (String(chat) !== CHAT) { log('ignored an update from chat', chat); continue; }
        // not awaited: a long action (a restart waits for the runner) must not block other buttons and messages
        if (u.callback_query) onCallback(u.callback_query).catch((e) => log('callback error:', e.message));
        else if (u.message && u.message.text) onMessage(u.message).catch((e) => log('message error:', e.message));
      }
    } catch (e) { log('poll error:', e.message); await new Promise((res) => setTimeout(res, 5000)); }
  }
}

snapshot(); setInterval(snapshot, SNAPSHOT_MS);
if (TOKEN && CHAT) poll(); else log('TG_BOT_TOKEN or TG_CHAT_ID not set: only the dashboard data is written');
