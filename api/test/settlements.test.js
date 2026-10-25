import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { Keypair } from '@stellar/stellar-sdk';
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from '@x402/core/http';
import { createApp } from '../src/app.js';

const agent = Keypair.random().publicKey();
const creditor = Keypair.random().publicKey();
const stranger = Keypair.random().publicKey();
const KEY = 'lgk_test';
const usdc = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';
const TX = 'ab'.repeat(32);

async function harness({ settleOk = true, verifyOk = true, balances = { [agent]: -200000000n, [creditor]: 200000000n } } = {}) {
  const calls = { record: [], settle: 0, logs: [] };
  const handler = createApp({
    config: { network: 'stellar:testnet', usdc, publicUrl: 'http://api.test' },
    ledger: {
      members: async () => [agent, creditor],
      balance: async (_g, m) => balances[m] ?? 0n,
      recordX402Settlement: async (r) => { calls.record.push(r); return 'cd'.repeat(32); },
    },
    facilitator: {
      verify: async () => ({ isValid: true }),
      settle: async () => { calls.settle++; return settleOk ? { success: true, transaction: TX, network: 'stellar:testnet' } : { success: false, errorReason: 'boom', transaction: '', network: 'stellar:testnet' }; },
    },
    verifier: { verify: async () => (verifyOk ? { ok: true } : { ok: false, reason: 'amount mismatch' }) },
    agents: new Map([[createHash('sha256').update(KEY).digest('hex'), { address: agent, owner: 'vesti', groups: [1], policy: {} }]]),
    spendLog: { history: () => [], append: () => {} },
    log: (e) => calls.logs.push(e),
  });
  const srv = createServer(handler).listen(0);
  await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const post = (body, headers = {}) => fetch(`${base}/v1/groups/1/settlements`, {
    method: 'POST', body: JSON.stringify(body), headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json', ...headers },
  });
  return { calls, post, base, close: () => srv.close() };
}

function paymentFor(res) {
  const required = decodePaymentRequiredHeader(res.headers.get('payment-required'));
  return { required, header: encodePaymentSignatureHeader({ x402Version: 2, resource: required.resource, accepted: required.accepts[0], payload: { transaction: 'AAAA' } }) };
}

test('402 carries x402 v2 requirements for the intent', async (t) => {
  const h = await harness(); t.after(h.close);
  const res = await h.post({ to: creditor, amount: '12.5' });
  assert.equal(res.status, 402);
  const { required } = paymentFor(res);
  assert.equal(required.x402Version, 2);
  assert.deepEqual(required.accepts, [{
    scheme: 'exact', network: 'stellar:testnet', asset: usdc, amount: '125000000', payTo: creditor,
    maxTimeoutSeconds: 60, extra: { areFeesSponsored: true },
  }]);
  const body = await res.json();
  assert.match(required.resource.description, new RegExp(`intent ${body.intentId}`));
});

test('policy denial returns 403 and is logged, no 402 issued', async (t) => {
  const h = await harness(); t.after(h.close);
  const res = await h.post({ to: creditor, amount: '30' });
  assert.equal(res.status, 403);
  assert.match((await res.json()).reason, /per-transaction cap/);
  assert.equal(res.headers.get('payment-required'), null);
  assert.equal(h.calls.logs.at(-1).event, 'policy_denied');
  assert.equal((await h.post({ to: stranger, amount: '1' })).status, 403);
});

test('paid request settles, verifies, records and returns PAYMENT-RESPONSE', async (t) => {
  const h = await harness(); t.after(h.close);
  const { header } = paymentFor(await h.post({ to: creditor, amount: '12.5' }));
  const res = await h.post({ to: creditor, amount: '12.5' }, { 'payment-signature': header });
  assert.equal(res.status, 200);
  assert.equal(decodePaymentResponseHeader(res.headers.get('payment-response')).transaction, TX);
  const body = await res.json();
  assert.equal(body.status, 'settled');
  assert.equal(body.explorer, `https://stellar.expert/explorer/testnet/tx/${TX}`);
  assert.deepEqual(h.calls.record, [{ group: 1, from: agent, to: creditor, amount: 125000000n, txHash: TX }]);
  // intent is single use
  assert.equal((await h.post({ to: creditor, amount: '12.5' }, { 'payment-signature': header })).status, 400);
});

test('failed settle returns a fresh 402 and records nothing', async (t) => {
  const h = await harness({ settleOk: false }); t.after(h.close);
  const first = paymentFor(await h.post({ to: creditor, amount: '1' }));
  const res = await h.post({ to: creditor, amount: '1' }, { 'payment-signature': first.header });
  assert.equal(res.status, 402);
  const again = decodePaymentRequiredHeader(res.headers.get('payment-required'));
  assert.match(again.error, /settle: boom/);
  assert.notEqual(again.resource.url, first.required.resource.url);
  assert.equal(h.calls.record.length, 0);
});

test('chain verification failure does not record', async (t) => {
  const h = await harness({ verifyOk: false }); t.after(h.close);
  const { header } = paymentFor(await h.post({ to: creditor, amount: '1' }));
  const res = await h.post({ to: creditor, amount: '1' }, { 'payment-signature': header });
  assert.equal(res.status, 502);
  assert.equal(h.calls.record.length, 0);
});

test('tampered accepted terms are refused before the facilitator', async (t) => {
  const h = await harness(); t.after(h.close);
  const { required } = paymentFor(await h.post({ to: creditor, amount: '1' }));
  const header = encodePaymentSignatureHeader({ x402Version: 2, resource: required.resource, accepted: { ...required.accepts[0], payTo: stranger }, payload: { transaction: 'AAAA' } });
  const res = await h.post({ to: creditor, amount: '1' }, { 'payment-signature': header });
  assert.equal(res.status, 402);
  assert.equal(h.calls.settle, 0);
});

test('cannot pay more than is owed, and auth is required', async (t) => {
  const h = await harness(); t.after(h.close);
  assert.equal((await h.post({ to: creditor, amount: '20.0000001' })).status, 409);
  assert.equal((await fetch(`${h.base}/v1/groups/1/balances`)).status, 401);
  assert.equal((await fetch(`${h.base}/v1/groups/2/balances`, { headers: { authorization: `Bearer ${KEY}` } })).status, 403);
});
