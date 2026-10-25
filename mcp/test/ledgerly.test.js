import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Account, Address, Keypair, Networks, Operation, TransactionBuilder, nativeToScVal } from '@stellar/stellar-sdk';
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from '@x402/core/http';
import { checkExpenseTx, createLedgerly, matchRequirements } from '../src/ledgerly.js';

const usdc = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';
const contractId = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const agentKp = Keypair.random();
const creditor = Keypair.random().publicKey();
const attacker = Keypair.random().publicKey();
const intent = { network: 'stellar:testnet', asset: usdc, amount: '125000000', payTo: creditor };
const accept = { scheme: 'exact', ...intent, maxTimeoutSeconds: 60, extra: { areFeesSponsored: true } };
const required = (over = {}) => ({ x402Version: 2, resource: { url: 'http://api/x?intent=1' }, accepts: [{ ...accept, ...over }] });

test('matching 402 is accepted', () => assert.deepEqual(matchRequirements(required(), intent), accept));

test('refuses when payTo differs', () => {
  assert.throws(() => matchRequirements(required({ payTo: attacker }), intent), /payTo differ/);
});

test('refuses when amount differs', () => {
  assert.throws(() => matchRequirements(required({ amount: '125000001' }), intent), /amount differ/);
});

test('refuses asset, network, scheme mismatches and smuggled extra accepts', () => {
  assert.throws(() => matchRequirements(required({ asset: contractId }), intent), /asset/);
  assert.throws(() => matchRequirements(required({ network: 'stellar:pubnet' }), intent), /network/);
  assert.throws(() => matchRequirements(required({ scheme: 'upto' }), intent), /scheme/);
  const two = required();
  two.accepts.push({ ...accept, payTo: attacker });
  assert.throws(() => matchRequirements(two, intent), /payTo/);
  assert.throws(() => matchRequirements({ x402Version: 1, accepts: [accept] }, intent), /malformed/);
});

const config = {
  network: 'stellar:testnet', passphrase: Networks.TESTNET, apiUrl: 'http://api', apiKey: 'k',
  agentSecret: agentKp.secret(), contractId, usdc, rpcUrl: 'http://rpc',
};

function fakeApi(firstAccept) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push(init);
    if (!init.headers['PAYMENT-SIGNATURE']) {
      return new Response('{}', { status: 402, headers: { 'payment-required': encodePaymentRequiredHeader(required(firstAccept)) } });
    }
    return new Response(JSON.stringify({ status: 'settled' }), {
      status: 200, headers: { 'payment-response': encodePaymentResponseHeader({ success: true, transaction: 'ab'.repeat(32), network: 'stellar:testnet' }) },
    });
  };
  return { calls, fetch };
}

test('settle signs only after the check and retries with PAYMENT-SIGNATURE', async () => {
  const api = fakeApi();
  let signedFor;
  const payer = { createPaymentPayload: async (pr) => { signedFor = pr; return { x402Version: 2, resource: pr.resource, accepted: pr.accepts[0], payload: { transaction: 'AAAA' } }; } };
  const out = await createLedgerly(config, { fetch: api.fetch, payer, rpc: {} }).settle(1, { to: creditor, amount: '12.5' });
  assert.equal(out.txHash, 'ab'.repeat(32));
  assert.equal(out.explorer, `https://stellar.expert/explorer/testnet/tx/${'ab'.repeat(32)}`);
  assert.deepEqual(signedFor.accepts, [accept]);
  assert.equal(decodePaymentSignatureHeader(api.calls[1].headers['PAYMENT-SIGNATURE']).accepted.payTo, creditor);
  assert.ok(!JSON.stringify(out).includes(agentKp.secret()));
});

test('settle never signs a tampered 402', async () => {
  for (const tamper of [{ payTo: attacker }, { amount: '999999999' }]) {
    const api = fakeApi(tamper);
    let signed = false;
    const payer = { createPaymentPayload: async () => { signed = true; } };
    await assert.rejects(createLedgerly(config, { fetch: api.fetch, payer, rpc: {} }).settle(1, { to: creditor, amount: '12.5' }), /refusing to pay/);
    assert.equal(signed, false);
    assert.equal(api.calls.length, 1);
  }
});

function txWith({ contract = contractId, fn = 'add_expense', source = agentKp.publicKey() } = {}) {
  return new TransactionBuilder(new Account(source, '1'), { fee: '100', networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.invokeContractFunction({ contract, function: fn, args: [nativeToScVal(1, { type: 'u32' }), new Address(source).toScVal()] }))
    .setTimeout(60).build().toXDR();
}

test('expense signing only accepts add_expense on the Ledgerly contract', () => {
  const opts = { passphrase: Networks.TESTNET, contractId, agent: agentKp.publicKey() };
  assert.ok(checkExpenseTx(txWith(), opts));
  assert.throws(() => checkExpenseTx(txWith({ contract: usdc, fn: 'transfer' }), opts), /refusing to sign/);
  assert.throws(() => checkExpenseTx(txWith({ fn: 'settle' }), opts), /refusing to sign/);
  assert.throws(() => checkExpenseTx(txWith({ source: creditor }), opts), /refusing to sign/);
});
