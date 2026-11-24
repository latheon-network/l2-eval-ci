'use strict';
// Unit tests of the quest checks with stubbed chain and explorer (no network). node test.js
const assert = require('assert');
const { createQuests } = require('./server');

const USER = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const FAUCET = '0x3333333333333333333333333333333333333333';
const POOL = '0x4444444444444444444444444444444444444444';
const ROUTER = '0x5555555555555555555555555555555555555555';
const OLDPOOL = '0x6666666666666666666666666666666666666666';
const COMMIT = 123456789n;
const POOL8 = '0x8888888888888888888888888888888888888888', CTX8 = 4242n, COMMIT8 = 987654321n;

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); pass++; console.log('ok   ' + name); } catch (e) { fail++; console.log('FAIL ' + name + ': ' + e.message); } }

const calls = [];
function make(over = {}) {
  const state = { reports: {} };
  let saved = 0;
  const txs = { to: { [USER]: [{ status: 'ok', from: { hash: FAUCET } }] }, from: { [USER]: [{ status: 'ok', to: { hash: ROUTER }, value: '2000000000000000000' }] } };
  const q = createQuests({
    secret: Buffer.from('00'.repeat(32), 'hex'), state, save: () => { saved++; },
    currentPools: [POOL], currentTargets: [POOL, ROUTER, POOL8], discloseVerifier: '0x7777777777777777777777777777777777777777',
    v8Pools: [POOL8], ctxOf: (p) => (p.toLowerCase() === POOL8 ? CTX8 : 1n),
    faucetAddress: async () => FAUCET,
    addressTxs: async (a, f) => (over.txs || txs)[f][a] || [],
    findDeposit: async (pool, c) => ((pool.toLowerCase() === POOL && c === COMMIT) || (pool.toLowerCase() === POOL8 && c === COMMIT8) ? { txHash: '0xabc' } : null),
    txFrom: async () => over.sender || USER,
    verifyOnChain: async (a, b, c, pub, kind) => { calls.push(kind); return over.verifier !== undefined ? over.verifier : true; },
  });
  return { q, state, saved: () => saved };
}
function report(q, addr, o = {}) {
  const code = o.code || q.codeFor(addr);
  const item = { pool: o.pool || POOL, commitment: String(o.commitment || COMMIT), proof: { pA: ['1', '2'], pB: [['3', '4'], ['5', '6']], pC: ['7', '8'], pubSignals: [String(o.pubCommit || COMMIT), '99', o.pubCode || code] } };
  if (o.keys) item.keys = { spendKey: '1', viewKey: '2' };
  return { type: 'latheon-disclosure-report', version: 1, auditorNonce: code, items: [item] };
}
// V8 rows: disclose_v2 [commitment, tag, code] or disclose_link [commitment, nullifier, ctx, code, tag]
function report8(q, addr, o = {}) {
  const code = q.codeFor(addr), kind = o.kind || 'disclose_v2';
  const pub = kind === 'disclose_link' ? [String(COMMIT8), '77', String(o.ctx || CTX8), code, '99'] : [String(COMMIT8), '99', code];
  return { type: 'latheon-disclosure-report', version: 2, auditorNonce: code, items: [{ pool: o.pool || POOL8, circuit: kind, commitment: String(COMMIT8), proof: { pA: ['1', '2'], pB: [['3', '4'], ['5', '6']], pC: ['7', '8'], pubSignals: pub } }] };
}

(async () => {
  await t('code is deterministic, per address, decimal, below 2^64', async () => {
    const { q } = make();
    assert.strictEqual(q.codeFor(USER), q.codeFor(USER.toUpperCase().replace('0X', '0x')));
    assert.notStrictEqual(q.codeFor(USER), q.codeFor(OTHER));
    assert.ok(/^\d+$/.test(q.codeFor(USER)) && BigInt(q.codeFor(USER)) < 2n ** 64n);
  });
  await t('bad address refused', async () => { const { q } = make(); await assert.rejects(() => q.check('faucet', '0x12'), /valid 0x address/); });
  await t('unknown task refused', async () => { const { q } = make(); await assert.rejects(() => q.check('withdraw', USER), /Unknown task/); });
  await t('faucet: yes for an address that received from the faucet', async () => { const { q } = make(); assert.strictEqual((await q.check('faucet', USER)).ok, 1); });
  await t('faucet: no for another address', async () => { const { q } = make(); assert.strictEqual((await q.check('faucet', OTHER)).ok, 0); });
  await t('faucet: failed transfer does not count', async () => {
    const { q } = make({ txs: { to: { [USER]: [{ status: 'error', from: { hash: FAUCET } }] }, from: {} } });
    assert.strictEqual((await q.check('faucet', USER)).ok, 0);
  });
  await t('deposit: yes through the router', async () => { const { q } = make(); assert.strictEqual((await q.check('deposit', USER)).ok, 1); });
  await t('deposit: no for an old pool or zero value', async () => {
    const { q } = make({ txs: { to: {}, from: { [USER]: [{ status: 'ok', to: { hash: OLDPOOL }, value: '1' }, { status: 'ok', to: { hash: POOL }, value: '0' }] } } });
    assert.strictEqual((await q.check('deposit', USER)).ok, 0);
  });
  await t('report: valid report accepted and saved', async () => {
    const { q, state, saved } = make();
    const r = await q.submitReport(USER, report(q, USER));
    assert.strictEqual(r.ok, 1); assert.ok(state.reports[USER.toLowerCase()]); assert.strictEqual(saved(), 1);
    assert.strictEqual((await q.check('report', USER)).ok, 1);
  });
  await t('report: made for another address code is refused', async () => {
    const { q } = make(); await assert.rejects(() => q.submitReport(USER, report(q, USER, { code: q.codeFor(OTHER) })), /different code/);
  });
  await t('report: proof signal for another code is refused', async () => {
    const { q } = make(); await assert.rejects(() => q.submitReport(USER, report(q, USER, { pubCode: q.codeFor(OTHER) })), /different code/);
  });
  await t('report: deposit sent by someone else is refused', async () => {
    const { q } = make({ sender: OTHER }); await assert.rejects(() => q.submitReport(USER, report(q, USER)), /not sent from this address/);
  });
  await t('report: verifier rejection is refused', async () => {
    const { q } = make({ verifier: false }); await assert.rejects(() => q.submitReport(USER, report(q, USER)), /rejected the proof/);
  });
  await t('report: old pool is refused', async () => {
    const { q } = make(); await assert.rejects(() => q.submitReport(USER, report(q, USER, { pool: OLDPOOL })), /current \(V8 or V7\)/);
  });
  await t('report: commitment mismatch is refused', async () => {
    const { q } = make(); await assert.rejects(() => q.submitReport(USER, report(q, USER, { pubCommit: 5n })), /does not match/);
  });
  await t('report: unknown deposit is refused', async () => {
    const { q } = make(); await assert.rejects(() => q.submitReport(USER, report(q, USER, { commitment: 9n, pubCommit: 9n })), /no such deposit/);
  });
  await t('report: rows with keys are refused (never collect keys)', async () => {
    const { q, state } = make(); await assert.rejects(() => q.submitReport(USER, report(q, USER, { keys: true })), /keys/);
    assert.strictEqual(Object.keys(state.reports).length, 0);
  });
  await t('report: wrong file type refused', async () => {
    const { q } = make(); await assert.rejects(() => q.submitReport(USER, { type: 'x', version: 1, items: [] }), /not a Latheon disclosure report/);
  });
  await t('V8 report (version 2, disclose_v2): accepted, checked with the disclose_v2 verifier', async () => {
    const { q } = make(); calls.length = 0;
    assert.strictEqual((await q.submitReport(USER, report8(q, USER))).ok, 1); assert.deepStrictEqual(calls, ['disclose_v2']);
  });
  await t('V8 receipt (disclose_link): accepted with the code at signal 3 and the pool context checked', async () => {
    const { q } = make(); calls.length = 0;
    assert.strictEqual((await q.submitReport(USER, report8(q, USER, { kind: 'disclose_link' }))).ok, 1); assert.deepStrictEqual(calls, ['disclose_link']);
  });
  await t('V8 receipt naming another pool (ctx) is refused before the verifier', async () => {
    const { q } = make(); calls.length = 0;
    await assert.rejects(() => q.submitReport(USER, report8(q, USER, { kind: 'disclose_link', ctx: 5n })), /another pool/); assert.strictEqual(calls.length, 0);
  });
  await t('a V8 proof type for a V7 pool, or a V7 row for a V8 pool, is refused', async () => {
    const { q } = make();
    await assert.rejects(() => q.submitReport(USER, report8(q, USER, { pool: POOL })), /does not match the pool generation/);
    await assert.rejects(() => q.submitReport(USER, report(q, USER, { pool: POOL8 })), /does not match the pool generation/);
  });
  await t('unknown proof type and wrong signal count are refused', async () => {
    const { q } = make(); const r = report8(q, USER); r.items[0].circuit = 'x';
    await assert.rejects(() => q.submitReport(USER, r), /unknown proof type/);
    const r2 = report8(q, USER, { kind: 'disclose_link' }); r2.items[0].proof.pubSignals.pop();
    await assert.rejects(() => q.submitReport(USER, r2), /malformed proof/);
  });
  await t('deposit: yes into a V8 pool', async () => {
    const { q } = make({ txs: { to: {}, from: { [USER]: [{ status: 'ok', to: { hash: POOL8 }, value: '1' }] } } });
    assert.strictEqual((await q.check('deposit', USER)).ok, 1);
  });
  await t('report: before upload the check says no', async () => { const { q } = make(); assert.strictEqual((await q.check('report', USER)).ok, 0); });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
