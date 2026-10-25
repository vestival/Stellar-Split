import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPolicy } from '../src/policy.js';
import { toBaseUnits } from '../src/amounts.js';

const A = 'GA_AGENT', B = 'GB_MEMBER', X = 'GX_STRANGER';
const now = 1_800_000_000_000;
const intent = (amount, to = B) => ({ from: A, to, amount: toBaseUnits(amount), at: now });
const run = (i, history = [], policy = {}) => checkPolicy({ policy, history, intent: i, groupMembers: [A, B] });

test('allows a payment within defaults', () => assert.deepEqual(run(intent('10')), { allow: true, reason: 'ok' }));

test('per-transaction cap, default 25 USDC', () => {
  assert.equal(run(intent('25')).allow, true);
  const r = run(intent('25.0000001'));
  assert.equal(r.allow, false);
  assert.match(r.reason, /per-transaction cap of 25 USDC/);
});

test('rolling 24h cap, default 50 USDC', () => {
  const history = [{ amount: toBaseUnits('20'), at: now - 1000 }, { amount: toBaseUnits('20'), at: now - 2000 }];
  assert.equal(run(intent('10'), history).allow, true);
  const r = run(intent('10.0000001'), history);
  assert.equal(r.allow, false);
  assert.match(r.reason, /rolling 24h cap of 50 USDC \(already spent 40\)/);
});

test('spend older than 24h does not count', () => {
  const history = [{ amount: toBaseUnits('49'), at: now - 24 * 3600 * 1000 }];
  assert.equal(run(intent('25'), history).allow, true);
});

test('counterparty must be a group member', () => {
  assert.deepEqual(run(intent('1', X)), { allow: false, reason: 'counterparty is not a member of this group' });
});

test('owner allowlist narrows counterparties', () => {
  assert.equal(run(intent('1'), [], { counterparties: ['GC_OTHER'] }).allow, false);
});

test('custom caps from the owner policy', () => {
  assert.equal(run(intent('11'), [], { perTxCap: '10' }).allow, false);
  assert.equal(run(intent('6'), [{ amount: toBaseUnits('5'), at: now }], { dailyCap: '10' }).allow, false);
});

test('rejects self payment and non-positive amounts', () => {
  assert.equal(run(intent('1', A)).allow, false);
  assert.equal(run({ ...intent('1'), amount: 0n }).allow, false);
});
